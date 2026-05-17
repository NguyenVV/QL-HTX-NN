const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'HTX_CHUYEN_GIA_15_NAM_BAO_MAT';

// Chuỗi kết nối Database Pooler an toàn với Supabase
const connectionString = process.env.DATABASE_URL || "postgresql://postgres.juvaurqgmtxyzylkehlw:[YOUR-PASSWORD]@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres";

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- TỰ ĐỘNG KHỞI TẠO CẤU TRÚC BẢNG HỆ THỐNG ---
const initDatabase = async () => {
    try {
        // 1. Bảng quản lý tài khoản & phân quyền
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'Thủ kho' -- 'Admin', 'Kế toán', 'Thủ kho'
            );
        `);
        // 2. Bảng quản lý kho hàng
        await pool.query(`CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, quantity REAL DEFAULT 0, unit VARCHAR(50) DEFAULT 'kg');`);
        // 3. Bảng quản lý giao dịch Xuất/Nhập
        await pool.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, product_id INTEGER, amount REAL NOT NULL, price REAL NOT NULL, type VARCHAR(10) NOT NULL, date DATE DEFAULT CURRENT_DATE);`);
        // 4. Bảng quản lý nhân công hàng tháng
        await pool.query(`CREATE TABLE IF NOT EXISTS labor (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, salary_per_day REAL NOT NULL, days_worked INTEGER NOT NULL, month VARCHAR(7) NOT NULL);`);
        
        // Tạo mặc định tài khoản Admin tối cao nếu database chưa có người dùng nào
        const userRes = await pool.query('SELECT COUNT(*) FROM users');
        if (parseInt(userRes.rows[0].count) === 0) {
            const hashedPwd = await bcrypt.hash('admin123', 10);
            await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', ['admin', hashedPwd, 'Admin']);
            console.log("ℹ️ Đã tạo tài khoản mặc định: admin / admin123");
        }

        console.log("👉 Đồng bộ cấu trúc Database HTX thành công!");
    } catch (err) {
        console.error("❌ Lỗi khởi tạo Database:", err.message);
    }
};
initDatabase();

// --- MIDDWARE KIỂM TRA QUYỀN TRUY CẬP (BẢO MẬT) ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, error: "Chưa đăng nhập!" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, error: "Phiên đăng nhập hết hạn!" });
        req.user = user;
        next();
    });
};

// --- MODULE 4: XÁC THỰC & QUẢN LÝ TÀI KHOẢN ---

// API Đăng nhập
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, error: "Tài khoản không tồn tại!" });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ success: false, error: "Sai mật khẩu!" });

        // Tạo mã Token bảo mật chứa thông tin quyền hạn
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({ success: true, token, role: user.role, username: user.username });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API Thêm tài khoản mới (Chỉ Admin được quyền thực hiện)
app.post('/api/users/register', authenticateToken, async (req, res) => {
    if (req.user.role !== 'Admin') return res.status(403).json({ success: false, error: "Chỉ Admin tối cao mới có quyền cấp tài khoản!" });
    
    const { username, password, role } = req.body;
    try {
        const hashedPwd = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, hashedPwd, role]);
        res.status(200).json({ success: true, message: "Tạo tài khoản quản trị mới thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, error: "Tài khoản đã tồn tại hoặc lỗi hệ thống!" });
    }
});

// API Lấy danh sách tài khoản quản trị hiện tại (Dành cho màn hình Admin kiểm tra)
app.get('/api/users/list', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, role FROM users ORDER BY id ASC');
        res.status(200).json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// --- MODULE 1: QUẢN LÝ XUẤT NHẬP KHO (An toàn Pooler) ---
app.post('/inventory/transaction', authenticateToken, async (req, res) => {
    if (req.user.role === 'Kế toán') return res.status(403).json({ success: false, error: "Kế toán không được quyền can thiệp sửa kho!" });
    
    const { product_id, amount, price, type } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('INSERT INTO transactions (product_id, amount, price, type) VALUES ($1, $2, $3, $4)', [product_id, amount, price, type]);
        const adjustValue = type === 'IN' ? amount : -amount;
        await client.query('UPDATE inventory SET quantity = quantity + $1 WHERE id = $2', [adjustValue, product_id]);
        await client.query('COMMIT');
        res.status(200).json({ success: true, message: "Cập nhật kho thành công!" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// --- MODULE 2: QUẢN LÝ NHÂN CÔNG HÀNG THÁNG ---
app.post('/labor/update', authenticateToken, async (req, res) => {
    if (req.user.role === 'Thủ kho') return res.status(403).json({ success: false, error: "Thủ kho không được quyền chấm công nhân sự!" });
    
    const { name, salary_per_day, days_worked, month } = req.body;
    try {
        await pool.query('INSERT INTO labor (name, salary_per_day, days_worked, month) VALUES ($1, $2, $3, $4)', [name, salary_per_day, days_worked, month]);
        res.status(200).json({ success: true, message: "Đã chấm công và ghi nhận lương!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- MODULE 3: TÍNH TOÁN LỖ LÃI & XUẤT EXCEL BÁO CÁO ---
app.get('/report/excel', async (req, res) => {
    // Để tiện thao tác tải file trực tiếp qua URL của trình duyệt, phần xuất Excel nhận token qua query string (?token=...)
    const token = req.query.token;
    if (!token) return res.status(401).send("Từ chối truy cập: Chưa xác thực tài khoản!");
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role === 'Thủ kho') return res.status(403).send("Từ chối: Quyền Thủ kho không được xem báo cáo doanh thu tài chính lỗ lãi!");

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Báo Cáo Tài Chính HTX');

        sheet.columns = [
            { header: 'Hạng Mục Chi Phí / Doanh Thu', key: 'desc', width: 35 },
            { header: 'Số Tiền (VNĐ)', key: 'amount', width: 25 }
        ];

        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2E7D32' } };

        const transData = await pool.query('SELECT type, SUM(amount * price) as total FROM transactions GROUP BY type');
        let revenue = 0;
        let cogs = 0;

        transData.rows.forEach(row => {
            if (row.type === 'OUT') revenue = parseFloat(row.total) || 0;
            if (row.type === 'IN') cogs = parseFloat(row.total) || 0;
        });

        const laborData = await pool.query('SELECT SUM(salary_per_day * days_worked) as total FROM labor');
        const totalLaborCost = parseFloat(laborData.rows[0].total) || 0;

        const grossProfit = revenue - cogs;
        const netProfit = grossProfit - totalLaborCost;

        sheet.addRow({ desc: '1. Tổng doanh thu bán nông sản (Xuất kho)', amount: revenue });
        sheet.addRow({ desc: '2. Tổng chi phí mua nông sản (Nhập kho)', amount: cogs });
        sheet.addRow({ desc: '3. Tổng chi phí thuê nhân công chấm công', amount: totalLaborCost });
        
        const summaryRow = sheet.addRow({ desc: 'LỢI NHUẬN RÒNG THỰC TẾ (Lỗ / Lãi)', amount: netProfit });
        summaryRow.font = { bold: true, color: { argb: netProfit >= 0 ? '007BF5' : 'FF0000' } };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=BaoCao_HieuQua_HTX.xlsx');
        
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        res.status(500).send("Lỗi xác thực hoặc lỗi xuất file Excel: " + err.message);
    }
});

app.listen(PORT, () => console.log(`🚀 Hệ thống HTX hoạt động tại cổng: ${PORT}`));
