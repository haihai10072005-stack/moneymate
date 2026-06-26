/**
 * MoneyMate backend — Express (đa người dùng, production-ready)
 * - Lưu trữ: Postgres (nếu có DATABASE_URL) hoặc db.json (local fallback)
 * - Auth: đăng ký/đăng nhập (scrypt + token)
 * - AI: proxy Claude (chat / quét hoá đơn / phân loại)
 * - Casso (Open Banking) webhook → AI phân loại
 * - VNPAY sandbox: tạo URL thanh toán + verify return (nạp ví)
 * - Social: quỹ nhóm + bảng xếp hạng
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const querystring = require('querystring');

const app = express();
app.set('trust proxy', true); // sau proxy của Render -> lấy đúng https + domain thật
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 8123;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';            // miễn phí tại https://aistudio.google.com/apikey
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const CASSO_TOKEN = process.env.CASSO_WEBHOOK_TOKEN || '';
const DB_FILE = path.join(__dirname, 'db.json');
const CATS = ['Ăn uống', 'Đi lại', 'Mua sắm', 'Giải trí', 'Hoá đơn', 'Sức khoẻ', 'Giáo dục', 'Khác'];
const VNP = {
  tmn: process.env.VNP_TMN_CODE || '', secret: process.env.VNP_HASH_SECRET || '',
  url: process.env.VNP_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: process.env.VNP_RETURN_URL || ''  // để trống = tự lấy theo domain request
};

/* ---------- Khởi tạo dữ liệu ---------- */
function emptyFinance() {
  return {
    balance: 0, tx: [],
    budgets: [
      { name: 'Ăn uống', limit: 3000000 }, { name: 'Đi lại', limit: 1500000 },
      { name: 'Mua sắm', limit: 2000000 }, { name: 'Giải trí', limit: 1500000 },
      { name: 'Hoá đơn', limit: 1500000 }
    ],
    goals: [], streak: { count: 0, last: '' }, challenges: [], badges: [], subs: []
  };
}
function emptyDB() { return { users: {}, tokens: {}, funds: [] }; }
function coerce(d) { if (!d || typeof d !== 'object') d = emptyDB(); if (!d.users) d.users = {}; if (!d.tokens) d.tokens = {}; if (!Array.isArray(d.funds)) d.funds = []; return d; }

/* ---------- Storage: Postgres hoặc JSON ---------- */
const USE_PG = !!process.env.DATABASE_URL;
let pool;
async function initStore() {
  if (!USE_PG) return;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb)');
  const r = await pool.query("SELECT v FROM kv WHERE k='db'");
  if (!r.rows.length) await pool.query("INSERT INTO kv(k,v) VALUES('db',$1)", [JSON.stringify(emptyDB())]);
}
async function readDB() {
  if (USE_PG) { const r = await pool.query("SELECT v FROM kv WHERE k='db'"); return coerce(r.rows[0] ? r.rows[0].v : emptyDB()); }
  try { return coerce(JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { return emptyDB(); }
}
async function writeDB(d) {
  if (USE_PG) { await pool.query("INSERT INTO kv(k,v) VALUES('db',$1) ON CONFLICT (k) DO UPDATE SET v=$1", [JSON.stringify(d)]); }
  else fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
}

/* ---------- Auth helpers ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const rid = p => p + crypto.randomBytes(7).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const pubUser = u => ({ id: u.id, name: u.name, email: u.email });
function auth(handler) { // wrapper: nạp db + user
  return async (req, res) => {
    try {
      const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const db = await readDB(); const uid = db.tokens[t];
      if (!uid || !db.users[uid]) return res.status(401).json({ error: 'Chưa đăng nhập' });
      req.db = db; req.uid = uid; req.user = db.users[uid];
      await handler(req, res);
    } catch (e) { console.error(e); res.status(500).json({ error: String(e.message || e) }); }
  };
}

/* ---------- AI: Claude (trả phí) hoặc Gemini (free) ---------- */
const HAS_AI = () => !!(KEY || GEMINI_KEY);
async function claudeCall(system, messages, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 1024, system, messages })
  });
  if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).error?.message || m; } catch (e) {} const err = new Error(m); err.code = r.status; throw err; }
  const j = await r.json();
  return j.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
// chuyển message kiểu Claude (role/content[, image base64]) sang định dạng Gemini
async function geminiCall(system, messages, maxTokens) {
  const contents = (messages || []).map(m => {
    let parts;
    if (typeof m.content === 'string') parts = [{ text: m.content }];
    else parts = (m.content || []).map(c => c.type === 'image'
      ? { inlineData: { mimeType: c.source.media_type, data: c.source.data } }
      : { text: c.text || '' });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const body = { contents, generationConfig: { maxOutputTokens: Math.max(maxTokens || 1024, 256) } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).error?.message || m; } catch (e) {} const err = new Error(m); err.code = r.status; throw err; }
  const j = await r.json();
  const cand = j.candidates && j.candidates[0];
  return ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('').trim();
}
async function aiComplete(system, messages, maxTokens) {
  if (KEY) return claudeCall(system, messages, maxTokens);
  if (GEMINI_KEY) return geminiCall(system, messages, maxTokens);
  const e = new Error('Server chưa cấu hình AI (đặt GEMINI_API_KEY — free, hoặc ANTHROPIC_API_KEY trong .env)'); e.code = 503; throw e;
}
async function categorize(text) {
  if (!HAS_AI() || !text) return null;
  try { const r = await aiComplete('Phân loại giao dịch vào ĐÚNG MỘT nhóm, chỉ trả tên nhóm: ' + CATS.join(', ') + '.', [{ role: 'user', content: String(text) }], 30); return CATS.find(c => r.includes(c)) || null; }
  catch (e) { return null; }
}

/* ---------- Auth routes ---------- */
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
    if (String(password).length < 4) return res.status(400).json({ error: 'Mật khẩu tối thiểu 4 ký tự' });
    const db = await readDB();
    if (Object.values(db.users).some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(409).json({ error: 'Email đã được dùng' });
    const id = rid('u_'), salt = crypto.randomBytes(8).toString('hex');
    db.users[id] = { id, name, email, salt, passHash: hashPw(password, salt), createdAt: Date.now(), data: emptyFinance() };
    const token = newToken(); db.tokens[token] = id; await writeDB(db);
    res.json({ token, user: pubUser(db.users[id]) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const db = await readDB();
    const u = Object.values(db.users).find(x => x.email.toLowerCase() === String(email || '').toLowerCase());
    if (!u || u.passHash !== hashPw(password || '', u.salt)) return res.status(401).json({ error: 'Sai email hoặc mật khẩu' });
    const token = newToken(); db.tokens[token] = u.id; await writeDB(db);
    res.json({ token, user: pubUser(u) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/me', auth(async (req, res) => res.json({ user: pubUser(req.user) })));
app.post('/api/logout', auth(async (req, res) => { const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); delete req.db.tokens[t]; await writeDB(req.db); res.json({ ok: true }); }));

/* ---------- Data ---------- */
app.get('/api/status', (req, res) => res.json({ ai: HAS_AI(), provider: KEY ? 'claude' : (GEMINI_KEY ? 'gemini' : 'none'), model: KEY ? MODEL : (GEMINI_KEY ? GEMINI_MODEL : null), casso: !!CASSO_TOKEN, vnpay: !!(VNP.tmn && VNP.secret), pg: USE_PG }));
app.get('/api/data', auth(async (req, res) => res.json(req.user.data || emptyFinance())));
app.post('/api/data', auth(async (req, res) => { req.user.data = req.body || emptyFinance(); await writeDB(req.db); res.json({ ok: true }); }));
app.post('/api/reset', auth(async (req, res) => { req.user.data = emptyFinance(); await writeDB(req.db); res.json(req.user.data); }));

/* ---------- AI ---------- */
app.post('/api/chat', async (req, res) => {
  try { const { system, messages, max_tokens } = req.body || {}; res.json({ text: await aiComplete(system, messages, max_tokens) }); }
  catch (e) { res.status(e.code || 500).json({ error: e.message || String(e) }); }
});
app.post('/api/categorize', async (req, res) => { res.json({ category: await categorize((req.body || {}).text || '') }); });

/* ---------- Casso ---------- */
function applyBankTx(data, t) {
  const inc = t.amount > 0;
  data.tx.unshift({ name: t.description || (inc ? 'Tiền vào' : 'Giao dịch ngân hàng'), cat: inc ? 'Thu nhập' : (t.category || 'Khác'),
    val: t.amount, inc: inc || undefined, d: (t.when || '').slice(5, 10).replace('-', '/'), m: (t.when || '').slice(0, 7) || undefined, src: 'bank' });
}
app.post('/api/casso/simulate', auth(async (req, res) => {
  const samples = [
    { description: 'TT TIEN DIEN EVN HCMC', amount: -385000 }, { description: 'GRABFOOD THANH TOAN', amount: -142000 },
    { description: 'SHOPEEPAY MUA HANG', amount: -329000 }, { description: 'CHUYEN KHOAN LUONG CONG TY', amount: 12000000 },
    { description: 'HIGHLANDS COFFEE', amount: -68000 }, { description: 'NETFLIX SUBSCRIPTION', amount: -260000 }
  ];
  const s = samples[Math.floor(Math.random() * samples.length)];
  const tx = { description: s.description, amount: s.amount, when: new Date().toISOString() };
  if (tx.amount < 0) tx.category = (await categorize(tx.description)) || 'Khác';
  applyBankTx(req.user.data, tx); await writeDB(req.db);
  res.json({ tx, aiCategorized: HAS_AI() });
}));
app.post('/api/webhooks/casso', async (req, res) => {
  try {
    const token = req.headers['secure-token'] || (req.headers['authorization'] || '').replace(/^Apikey\s+/i, '');
    if (CASSO_TOKEN && token !== CASSO_TOKEN) return res.status(401).json({ error: 1, message: 'invalid token' });
    const db = await readDB();
    const email = (req.query.email || '').toLowerCase();
    const user = email ? Object.values(db.users).find(u => u.email.toLowerCase() === email) : Object.values(db.users)[0];
    if (!user) return res.json({ success: true, note: 'no user' });
    for (const t of (req.body && req.body.data) || []) {
      const tx = { description: t.description, amount: Number(t.amount), when: t.when };
      if (tx.amount < 0) tx.category = (await categorize(tx.description)) || 'Khác';
      applyBankTx(user.data, tx);
    }
    await writeDB(db); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ---------- VNPAY sandbox ---------- */
function vnpSortObject(obj) {
  const sorted = {}; const str = [];
  for (const key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) str.push(encodeURIComponent(key));
  str.sort();
  for (let i = 0; i < str.length; i++) sorted[str[i]] = encodeURIComponent(obj[str[i]]).replace(/%20/g, '+');
  return sorted;
}
function vnpDate(d) { const p = n => ('' + n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
// build "k=v&k=v" — giá trị đã được vnpSortObject encode sẵn (KHÔNG encode lại)
const vnpQS = p => Object.keys(p).map(k => k + '=' + p[k]).join('&');
// Tạo URL thanh toán (nạp ví). Cần đăng nhập + đã cấu hình VNP_TMN_CODE/VNP_HASH_SECRET.
app.post('/api/vnpay/create', auth(async (req, res) => {
  if (!VNP.tmn || !VNP.secret) return res.status(503).json({ error: 'Chưa cấu hình VNPAY. Đăng ký sandbox tại sandbox.vnpayment.vn rồi thêm VNP_TMN_CODE & VNP_HASH_SECRET vào .env.' });
  const amount = Math.round(Math.abs(+req.body.amount || 0));
  if (amount < 1000) return res.status(400).json({ error: 'Số tiền tối thiểu 1.000₫' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0];
  const returnUrl = VNP.returnUrl || (req.protocol + '://' + req.get('host') + '/api/vnpay/return');
  let p = {
    vnp_Version: '2.1.0', vnp_Command: 'pay', vnp_TmnCode: VNP.tmn, vnp_Locale: 'vn', vnp_CurrCode: 'VND',
    vnp_TxnRef: Date.now() + '_' + req.uid, vnp_OrderInfo: 'NapViMoneyMate', vnp_OrderType: 'other',
    vnp_Amount: amount * 100, vnp_ReturnUrl: returnUrl, vnp_IpAddr: ip, vnp_CreateDate: vnpDate(new Date())
  };
  p = vnpSortObject(p);
  const signData = vnpQS(p);
  p.vnp_SecureHash = crypto.createHmac('sha512', VNP.secret).update(Buffer.from(signData, 'utf-8')).digest('hex');
  res.json({ url: VNP.url + '?' + vnpQS(p) });
}));
// VNPAY redirect về đây sau khi thanh toán
app.get('/api/vnpay/return', async (req, res) => {
  try {
    let p = Object.assign({}, req.query);
    const secureHash = p.vnp_SecureHash; delete p.vnp_SecureHash; delete p.vnp_SecureHashType;
    p = vnpSortObject(p);
    const signData = vnpQS(p);
    const check = crypto.createHmac('sha512', VNP.secret).update(Buffer.from(signData, 'utf-8')).digest('hex');
    const ok = secureHash === check && req.query.vnp_ResponseCode === '00';
    if (ok) {
      // Lưu ý: production nên cộng ví ở IPN (server-to-server), không ở return. Demo cộng ở đây sau khi verify chữ ký.
      const uid = String(req.query.vnp_TxnRef || '').split('_')[1];
      const amount = Math.round((+req.query.vnp_Amount || 0) / 100);
      const db = await readDB();
      if (db.users[uid] && amount > 0) {
        const d = db.users[uid].data;
        d.balance = (d.balance || 0) + amount;
        d.tx.unshift({ name: 'Nạp ví qua VNPAY', cat: 'Thu nhập', val: amount, inc: true, d: new Date().getDate() + '/' + (new Date().getMonth() + 1), m: new Date().toISOString().slice(0, 7), src: 'vnpay' });
        await writeDB(db);
      }
    }
    res.redirect('/?vnp=' + (ok ? 'success' : 'fail') + '&amt=' + Math.round((+req.query.vnp_Amount || 0) / 100));
  } catch (e) { res.redirect('/?vnp=fail'); }
});

/* ---------- Social ---------- */
app.get('/api/funds', auth(async (req, res) => res.json(req.db.funds.filter(f => f.ownerId === req.uid))));
app.post('/api/funds', auth(async (req, res) => {
  const { name, emoji, target } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Thiếu tên quỹ' });
  const f = { id: rid('f_'), name, emoji: emoji || '🎯', target: +target || 0, ownerId: req.uid, members: [{ name: req.user.name, amount: 0, mine: true }], createdAt: Date.now() };
  req.db.funds.push(f); await writeDB(req.db); res.json(f);
}));
app.post('/api/funds/:id/member', auth(async (req, res) => {
  const f = req.db.funds.find(x => x.id === req.params.id && x.ownerId === req.uid);
  if (!f) return res.status(404).json({ error: 'Không tìm thấy quỹ' });
  f.members.push({ name: (req.body.name || 'Thành viên').slice(0, 30), amount: 0 }); await writeDB(req.db); res.json(f);
}));
app.post('/api/funds/:id/contribute', auth(async (req, res) => {
  const f = req.db.funds.find(x => x.id === req.params.id && x.ownerId === req.uid);
  if (!f) return res.status(404).json({ error: 'Không tìm thấy quỹ' });
  const i = Math.max(0, Math.min(f.members.length - 1, +req.body.idx || 0));
  f.members[i].amount += Math.abs(+req.body.amount || 0); await writeDB(req.db); res.json(f);
}));
app.delete('/api/funds/:id', auth(async (req, res) => { req.db.funds = req.db.funds.filter(x => !(x.id === req.params.id && x.ownerId === req.uid)); await writeDB(req.db); res.json({ ok: true }); }));
app.get('/api/leaderboard', auth(async (req, res) => {
  const list = Object.values(req.db.users).map(u => {
    const tx = (u.data && u.data.tx) || [];
    const inc = tx.filter(t => t.val > 0).reduce((s, t) => s + t.val, 0);
    const exp = tx.filter(t => t.val < 0).reduce((s, t) => s + Math.abs(t.val), 0);
    return { name: u.name, streak: (u.data && u.data.streak && u.data.streak.count) || 0, rate: inc ? Math.round((inc - exp) / inc * 100) : 0, badges: (u.data && u.data.badges || []).length, you: u.id === req.uid };
  }).sort((a, b) => b.streak - a.streak || b.rate - a.rate || b.badges - a.badges);
  res.json(list.slice(0, 20));
}));

/* ---------- Static + start ---------- */
app.use(express.static(path.join(__dirname, 'public')));
initStore().then(() => {
  app.listen(PORT, () => {
    console.log('  MoneyMate  ->  http://localhost:' + PORT);
    console.log('  Lưu trữ: ' + (USE_PG ? 'PostgreSQL (DATABASE_URL)' : 'db.json (local)'));
    console.log('  AI: ' + (KEY ? 'Claude (' + MODEL + ')' : (GEMINI_KEY ? 'Gemini FREE (' + GEMINI_MODEL + ')' : 'TẮT')) + ' | VNPAY: ' + (VNP.tmn ? 'BẬT' : 'chưa cấu hình'));
  });
}).catch(e => { console.error('Khởi tạo lưu trữ thất bại:', e.message); process.exit(1); });
