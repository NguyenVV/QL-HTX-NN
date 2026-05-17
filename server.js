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

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:[PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?pgbouncer=true";

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- TỰ ĐỘNG KHỞI TẠO CẤU TRÚC BẢNG HỆ THỐNG ---
const initDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'Thủ kho'
            );
        `);
        await pool.query(`CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, quantity REAL DEFAULT 0, unit VARCHAR(50) DEFAULT 'kg');`);
        await pool.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, product_id INTEGER, amount REAL NOT NULL, price REAL NOT NULL, type VARCHAR(10) NOT NULL, date DATE DEFAULT CURRENT_DATE);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS labor (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, salary_per_day REAL NOT NULL, days_worked INTEGER NOT NULL, month VARCHAR(7) NOT NULL);`);
        
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

// --- MIDDWARE XÁC THỰC QUYỀN TRUY CẬP TOKEN ---
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

// --- MODULE 4: XÁC THỰC & QUẢN LÝ TÀI KHOẢN MÀN HÌNH ADMIN ---
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, error: "Tài khoản không tồn tại!" });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ success: false, error: "Sai mật khẩu!" });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({ success: true, token, role: user.role, username: user.username });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/users/register', authenticateToken, async (req, res) => {
    if (req.user.role !== 'Admin') return res.status(403).json({ success: false, error: "Chỉ đặc quyền Admin mới có thể cấp tài khoản!" });
    const { username, password, role } = req.body;
    try {
        const hashedPwd = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, hashedPwd, role]);
        res.status(200).json({ success: true, message: "Tạo tài khoản thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, error: "Tài khoản quản trị này đã tồn tại!" });
    }
});

app.get('/api/users/list', authenticateToken, async (req, res) => {
    if (req.user.role !== 'Admin') return res.status(403).json({ success: false, error: "Từ chối truy cập danh sách bảo mật!" });
    try {
        const result = await pool.query('SELECT id, username, role FROM users ORDER BY id ASC');
        res.status(200).json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- MODULE 1: QUẢN LÝ XUẤT NHẬP KHO CHUẨN TRANSACTION Pooler ---
app.post('/inventory/transaction', authenticateToken, async (req, res) => {
    if (req.user.role === 'Kế toán') return res.status(403).json({ success: false, error: "Kế toán không được quyền can thiệp sửa kho!" });
    const { product_id, amount, price, type } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('INSERT INTO transactions (product_id, amount, price, type) VALUES ($1, $2, $3, $4)', [product_id, amount, price, type]);
        const adjustValue = type === 'IN' ? amount : -amount;
        await client.query('INSERT INTO inventory (id, name, quantity) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET quantity = inventory.quantity + $4', [product_id, 'Nông sản mã số ' + product_id, adjustValue, adjustValue]);
        await client.query('COMMIT');
        res.status(200).json({ success: true, message: "Cập nhật kho thành công!" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// --- MODULE 2: QUẢN LÝ NHÂN CÔNG ---
app.post('/labor/update', authenticateToken, async (req, res) => {
    if (req.user.role === 'Thủ kho') return res.status(403).json({ success: false, error: "Thủ kho không được quyền chấm công!" });
    const { name, salary_per_day, days_worked, month } = req.body;
    try {
        await pool.query('INSERT INTO labor (name, salary_per_day, days_worked, month) VALUES ($1, $2, $3, $4)', [name, salary_per_day, days_worked, month]);
        res.status(200).json({ success: true, message: "Ghi nhận lương thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- MODULE 3: TRANG XEM THÔNG TIN BÁO CÁO & XUẤT EXCEL KẾT QUẢ ĐỊNH KỲ ---
app.get('/report/excel', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).send("Từ chối: Chưa xác thực danh tính!");
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role === 'Thủ kho') return res.status(403).send("Quyền thủ kho không thể truy xuất báo cáo tài chính!");

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Báo Cáo Quyết Toán');

        sheet.columns = [
            { header: 'Hạng Mục Kinh Doanh HTX', key: 'desc', width: 35 },
            { header: 'Dòng Tiền (VNĐ)', key: 'amount', width: 25 }
        ];

        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1B5E20' } };

        const transData = await pool.query('SELECT type, SUM(amount * price) as total FROM transactions GROUP BY type');
        let revenue = 0; let cogs = 0;
        transData.rows.forEach(row => {
            if (row.type === 'OUT') revenue = parseFloat(row.total) || 0;
            if (row.type === 'IN') cogs = parseFloat(row.total) || 0;
        });

        const laborData = await pool.query('SELECT SUM(salary_per_day * days_worked) as total FROM labor');
        const totalLaborCost = parseFloat(laborData.rows[0].total) || 0;

        const netProfit = revenue - cogs - totalLaborCost;

        sheet.addRow({ desc: '1. Doanh thu bán hàng nông sản xuất kho (+)', amount: revenue });
        sheet.addRow({ desc: '2. Chi phí giá vốn mua vào nhập kho (-)', amount: cogs });
        sheet.addRow({ desc: '3. Chi phí thuê công lao động vận hành (-)', amount: totalLaborCost });
        
        const summaryRow = sheet.addRow({ desc: 'LỢI NHUẬN RÒNG QUYẾT TOÁN THỰC TẾ (Lỗ/Lãi)', amount: netProfit });
        summaryRow.font = { bold: true, color: { argb: netProfit >= 0 ? '00C853' : 'D50000' } };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=BaoCao_QuyetToan_HTX.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        res.status(500).send("Lỗi xử lý hệ thống: " + err.message);
    }
});

app.listen(PORT, () => console.log(`🚀 Hệ thống HTX hoạt động tại cổng: ${PORT}`));
