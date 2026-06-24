# MoneyMate 💰 — App quản lý tài chính AI cho Gen Z

App tài chính cá nhân tích hợp **AI (Claude)** theo hướng *"Financial Fitness"* (Duolingo + Strava + Money Lover):
thu chi thông minh, AI tự phân loại, mô hình theo tháng + hũ tiết kiệm, daily tracking + dự đoán dòng tiền,
ngân sách, mục tiêu/Vision Board, Financial Score + streak, thử thách + huy hiệu, AI Coach, subscription tracker,
quét hoá đơn AI, đồng bộ ngân hàng (Casso), nạp tiền (VNPAY), **đa người dùng** + **cộng đồng/quỹ nhóm + leaderboard**.

## 🚀 Chạy local

```bash
npm install
npm start          # http://localhost:8123
```

Không cần Postgres — mặc định lưu `db.json`. Mở web → **đăng ký** một tài khoản → dùng.

## ⚙️ Bật AI thật (Claude)
Mở `.env`, điền `ANTHROPIC_API_KEY=sk-ant-...` (lấy ở https://console.anthropic.com) rồi `npm start` lại.
Key nằm **ở server**, không lộ ra trình duyệt.

## 🗄️ Database (production)
Mặc định `db.json` (1 file, hợp cho local/demo). Production nên dùng **Postgres**: chỉ cần đặt biến môi trường
`DATABASE_URL` (Neon / Supabase / Railway / Render đều có free tier) — server tự tạo bảng & chuyển sang Postgres,
không cần sửa code.

```
DATABASE_URL=postgres://user:pass@host:5432/dbname
# PGSSL=disable   # nếu Postgres local không SSL
```

## ☁️ Deploy lên mạng

### Cách 1 — Render (1 chạm, kèm Postgres free)
1. Push code lên GitHub.
2. Vào https://dashboard.render.com → **New** → **Blueprint** → chọn repo → Render đọc `render.yaml` (tự tạo web service + Postgres + nối `DATABASE_URL`).
3. Thêm các biến bí mật (`ANTHROPIC_API_KEY`, `VNP_*`...) trong tab Environment.
4. Deploy. Xong có domain `https://moneymate-xxxx.onrender.com`.

### Cách 2 — Railway / Docker
Repo đã có `Dockerfile` + `Procfile`. Railway/Fly.io/any PaaS: tạo project từ repo, thêm Postgres plugin
(tự set `DATABASE_URL`), khai báo env, deploy.

```bash
docker build -t moneymate .
docker run -p 8123:8123 --env-file .env moneymate
```

> Nhớ đổi `VNP_RETURN_URL` thành domain thật, vd `https://<domain>/api/vnpay/return`.

## 🏦 Casso (Open Banking — đọc giao dịch)
Đăng ký https://casso.vn → liên kết ngân hàng → tạo webhook trỏ về `https://<domain>/api/webhooks/casso`,
đặt secure token trùng với `CASSO_WEBHOOK_TOKEN` trong env. Mỗi biến động số dư → server gọi Claude phân loại → lưu.
Thử nhanh: nút **"Đồng bộ giao dịch mới (demo Casso)"** trong tab *Chuyển tiền*.

## 💳 VNPAY (nạp tiền — sandbox)
Đăng ký miễn phí https://sandbox.vnpayment.vn để lấy `VNP_TMN_CODE` + `VNP_HASH_SECRET`, điền vào `.env`.
Nút **"Nạp tiền vào ví qua VNPAY"** (tab *Chuyển tiền*) tạo URL thanh toán đã ký HMAC-SHA512, redirect sang cổng,
xác thực chữ ký khi trả về rồi cộng số dư.
> Production: cộng ví nên xử lý ở **IPN** (server-to-server) và cần **hợp đồng merchant** với VNPAY.

## 🔌 API chính
| Method | Endpoint | Mô tả |
|---|---|---|
| POST | `/api/register` · `/api/login` · `/api/logout` | Xác thực (token Bearer) |
| GET/POST | `/api/data` · `/api/reset` | Dữ liệu tài chính (per-user) |
| POST | `/api/chat` · `/api/categorize` | AI (Claude) |
| POST | `/api/webhooks/casso` · `/api/casso/simulate` | Open Banking |
| POST/GET | `/api/vnpay/create` · `/api/vnpay/return` | Thanh toán VNPAY |
| — | `/api/funds*` · `/api/leaderboard` | Cộng đồng / quỹ nhóm |

## 📁 Cấu trúc
```
server.js          # Express: auth + AI + Casso + VNPAY + social; lưu Postgres/JSON
public/index.html  # Frontend (Chart.js)
Dockerfile · render.yaml · Procfile  # deploy
.env(.example)     # khoá bí mật
```

## 🔐 Lưu ý production
- Lưu trữ JSONB trong Postgres (1 document) — đủ cho MVP; quy mô lớn nên tách bảng chuẩn hoá.
- Đổi tất cả khoá/secret ở env, không commit `.env` (đã .gitignore).
- VNPAY/Casso production cần đăng ký merchant + KYC doanh nghiệp.
