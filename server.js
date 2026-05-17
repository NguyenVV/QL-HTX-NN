const express = require('express');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Sử dụng biến môi trường DATABASE_URL để bảo mật thông tin kết nối
// Nếu chạy local, anh có thể dán trực tiếp chuỗi kết nối Supabase vào đây để test
// Hệ thống sẽ ưu tiên lấy từ biến môi trường DATABASE_URL trên Render để bảo mật
const connectionString = process.env.DATABASE_URL || "postgresql://postgres:MAT_KHAU_MAU_VI_DU@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?pgbouncer=true";

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false } // Bắt buộc phải có để kết nối an toàn với Supabase/Render
});

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- TỰ ĐỘNG KHỞI TẠO CẤU TRÚC BẢNG (Dành cho bản Deploy Online) ---
const initDatabase = async () => {
    try {
        // Bảng quản lý kho hàng
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inventory (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                quantity REAL DEFAULT 0,
                unit VARCHAR(50) DEFAULT 'kg'
            );
        `);
        // Bảng quản lý giao dịch Xuất/Nhập
        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                product_id INTEGER,
                amount REAL NOT NULL,
                price REAL NOT NULL,
                type VARCHAR(10) NOT NULL, -- 'IN' hoặc 'OUT'
                date DATE DEFAULT CURRENT_DATE
            );
        `);
        // Bảng quản lý nhân công hàng tháng
        await pool.query(`
            CREATE TABLE IF NOT EXISTS labor (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                salary_per_day REAL NOT NULL,
                days_worked INTEGER NOT NULL,
                month VARCHAR(7) NOT NULL -- Định dạng YYYY-MM
            );
        `);
        console.log("👉 Khởi tạo hoặc đồng bộ Database thành công!");
    } catch (err) {
        console.error("❌ Lỗi khởi tạo Database:", err.message);
    }
};
initDatabase();

// --- MODULE 1: QUẢN LÝ XUẤT NHẬP KHO ---
app.post('/inventory/transaction', async (req, res) => {
    const { product_id, amount, price, type } = req.body;
    try {
        // 1. Ghi nhận lịch sử giao dịch
        await pool.query(
            'INSERT INTO transactions (product_id, amount, price, type) VALUES ($1, $2, $3, $4)',
            [product_id, amount, price, type]
        );
        
        // 2. Cập nhật số lượng tồn kho theo thời gian thực
        const adjustValue = type === 'IN' ? amount : -amount;
        await pool.query(
            'UPDATE inventory SET quantity = quantity + $1 WHERE id = $2',
            [adjustValue, product_id]
        );

        res.status(200).json({ success: true, message: "Cập nhật kho thành công!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- MODULE 2: QUẢN LÝ NHÂN CÔNG HÀNG THÁNG ---
app.post('/labor/update', async (req, res) => {
    const { name, salary_per_day, days_worked, month } = req.body;
    try {
        await pool.query(
            'INSERT INTO labor (name, salary_per_day, days_worked, month) VALUES ($1, $2, $3, $4)',
            [name, salary_per_day, days_worked, month]
        );
        res.status(200).json({ success: true, message: "Đã chấm công và ghi nhận lương!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- MODULE 3: TÍNH TOÁN LỖ LÃI & XUẤT EXCEL ---
app.get('/report/excel', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Báo Cáo Tài Chính HTX');

        // Định dạng cột cho file Excel
        sheet.columns = [
            { header: 'Hạng Mục Chi Phí / Doanh Thu', key: 'desc', width: 35 },
            { header: 'Số Tiền (VNĐ)', key: 'amount', width: 25 }
        ];

        // Khóa font và style tiêu đề cho đẹp mắt
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2E7D32' } }; // Màu xanh lá cây

        // 1. Tính toán Doanh thu bán hàng và Giá vốn nhập hàng từ bảng transactions
        const transData = await pool.query('SELECT type, SUM(amount * price) as total FROM transactions GROUP BY type');
        let revenue = 0; // Tổng thu (Xuất hàng)
        let cogs = 0;    // Tổng chi nhập hàng (Giá vốn)

        transData.rows.forEach(row => {
            if (row.type === 'OUT') revenue = parseFloat(row.total) || 0;
            if (row.type === 'IN') cogs = parseFloat(row.total) || 0;
        });

        // 2. Tính toán tổng chi phí nhân công từ bảng labor
        const laborData = await pool.query('SELECT SUM(salary_per_day * days_worked) as total FROM labor');
        const totalLaborCost = parseFloat(laborData.rows[0].total) || 0;

        // 3. Đổ dữ liệu và tính toán công thức lỗ lãi
        const grossProfit = revenue - cogs;
        const netProfit = grossProfit - totalLaborCost;

        sheet.addRow({ desc: '1. Tổng doanh thu bán nông sản (Xuất kho)', amount: revenue });
        sheet.addRow({ desc: '2. Tổng chi phí mua nông sản (Nhập kho)', amount: cogs });
        sheet.addRow({ desc: '3. Tổng chi phí thuê nhân công chấm công', amount: totalLaborCost });
        
        // Thêm đường kẻ phân cách
        const summaryRow = sheet.addRow({ desc: 'LỢI NHUẬN RÒNG THỰC TẾ (Lỗ / Lãi)', amount: netProfit });
        summaryRow.font = { bold: true, color: { argb: netProfit >= 0 ? '007BF5' : 'FF0000' } }; // Xanh nếu lãi, Đỏ nếu lỗ

        // Thiết lập Header tải file về trình duyệt
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=BaoCao_HieuQua_HTX.xlsx');
        
        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        res.status(500).send("Lỗi xuất file Excel: " + err.message);
    }
});

// Chạy ứng dụng lắng nghe cổng được cấu hình
app.listen(PORT, () => console.log(`🚀 Hệ thống HTX hoạt động tại cổng: ${PORT}`));
