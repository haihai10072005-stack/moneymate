/**
 * MoneyMate backend — Express (đa người dùng, production-ready)
 * - Lưu trữ: db.js (Postgres per-row hoặc db.json) — chống đè dữ liệu khi nhiều người dùng
 * - Auth: đăng ký/đăng nhập, đổi mật khẩu, quên mật khẩu, giới hạn đăng nhập sai
 * - AI: Claude (trả phí) hoặc Gemini (free)
 * - Casso webhook, VNPAY sandbox, Social (quỹ nhóm + leaderboard)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const crypto = require('crypto');
const store = require('./db');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 8123;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const CASSO_TOKEN = process.env.CASSO_WEBHOOK_TOKEN || '';
const CATS = ['Ăn uống', 'Đi lại', 'Mua sắm', 'Giải trí', 'Hoá đơn', 'Sức khoẻ', 'Giáo dục', 'Khác'];
const VNP = {
  tmn: process.env.VNP_TMN_CODE || '', secret: process.env.VNP_HASH_SECRET || '',
  url: process.env.VNP_URL || 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: process.env.VNP_RETURN_URL || ''
};

/* ---------- Auth helpers ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const rid = p => p + crypto.randomBytes(7).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const pubUser = u => ({ id: u.id, name: u.name, email: u.email });
function auth(handler) {
  return async (req, res) => {
    try {
      const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const uid = await store.tokenUser(t);
      const user = uid ? await store.userById(uid) : null;
      if (!user) return res.status(401).json({ error: 'Chưa đăng nhập' });
      req.uid = uid; req.user = user;
      await handler(req, res);
    } catch (e) { console.error(e); res.status(500).json({ error: String(e.message || e) }); }
  };
}
// chống dò mật khẩu: khoá tạm theo email sau nhiều lần sai
const loginFails = new Map();
const loginBlocked = email => { const f = loginFails.get(email); return (f && f.n >= 5 && f.until > Date.now()) ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
const loginFail = email => { const f = loginFails.get(email) || { n: 0, until: 0 }; f.n++; f.until = Date.now() + (f.n >= 5 ? 300000 : 60000); loginFails.set(email, f); };
const loginOk = email => loginFails.delete(email);

/* ---------- AI: Claude hoặc Gemini (free) ---------- */
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
async function geminiCall(system, messages, maxTokens) {
  const contents = (messages || []).map(m => {
    let parts;
    if (typeof m.content === 'string') parts = [{ text: m.content }];
    else parts = (m.content || []).map(c => c.type === 'image' ? { inlineData: { mimeType: c.source.media_type, data: c.source.data } } : { text: c.text || '' });
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

/* ---------- Email (tuỳ chọn, qua Resend) ---------- */
async function sendResetEmail(to, link) {
  const k = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
  if (!k || !from) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: 'Bearer ' + k, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject: 'Đặt lại mật khẩu MoneyMate', html: '<p>Bấm để đặt lại mật khẩu: <a href="' + link + '">' + link + '</a></p><p>Link hết hạn sau 1 giờ. Nếu không phải bạn, bỏ qua email này.</p>' })
    });
    return r.ok;
  } catch (e) { return false; }
}

/* ---------- Auth routes ---------- */
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
    if (String(password).length < 4) return res.status(400).json({ error: 'Mật khẩu tối thiểu 4 ký tự' });
    if (await store.userByEmail(email)) return res.status(409).json({ error: 'Email đã được dùng' });
    const id = rid('u_'), salt = crypto.randomBytes(8).toString('hex');
    const u = { id, email, name, salt, passHash: hashPw(password, salt), createdAt: Date.now(), data: store.emptyFinance() };
    await store.createUser(u);
    const token = newToken(); await store.addToken(token, id);
    res.json({ token, user: pubUser(u) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const em = String(email || '').toLowerCase();
    const wait = loginBlocked(em);
    if (wait) return res.status(429).json({ error: 'Sai quá nhiều lần. Thử lại sau ' + wait + ' giây.' });
    const u = await store.userByEmail(em);
    if (!u || u.passHash !== hashPw(password || '', u.salt)) { loginFail(em); return res.status(401).json({ error: 'Sai email hoặc mật khẩu' }); }
    loginOk(em);
    const token = newToken(); await store.addToken(token, u.id);
    res.json({ token, user: pubUser(u) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/me', auth(async (req, res) => res.json({ user: pubUser(req.user) })));
app.post('/api/logout', auth(async (req, res) => { const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); await store.delToken(t); res.json({ ok: true }); }));
app.post('/api/change-password', auth(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 4 ký tự' });
  if (req.user.passHash !== hashPw(oldPassword || '', req.user.salt)) return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' });
  const salt = crypto.randomBytes(8).toString('hex');
  await store.setPassword(req.uid, salt, hashPw(newPassword, salt));
  res.json({ ok: true });
}));
app.post('/api/forgot', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim();
    const u = await store.userByEmail(email);
    if (u) {
      const token = crypto.randomBytes(20).toString('hex');
      await store.setReset(u.id, token, Date.now() + 3600000);
      const link = req.protocol + '://' + req.get('host') + '/?reset=' + token;
      const sent = await sendResetEmail(u.email, link);
      return res.json(sent ? { ok: true, sent: true } : { ok: true, sent: false, devLink: link });
    }
    res.json({ ok: true, sent: false }); // không tiết lộ email có tồn tại hay không
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 4 ký tự' });
    const u = await store.userByReset(token || '');
    if (!u) return res.status(400).json({ error: 'Link đặt lại không hợp lệ hoặc đã hết hạn' });
    const salt = crypto.randomBytes(8).toString('hex');
    await store.setPassword(u.id, salt, hashPw(newPassword, salt));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ---------- Data ---------- */
app.get('/api/status', (req, res) => res.json({ ai: HAS_AI(), provider: KEY ? 'claude' : (GEMINI_KEY ? 'gemini' : 'none'), model: KEY ? MODEL : (GEMINI_KEY ? GEMINI_MODEL : null), casso: !!CASSO_TOKEN, vnpay: !!(VNP.tmn && VNP.secret), pg: store.usingPg() }));
app.get('/api/data', auth(async (req, res) => res.json(req.user.data || store.emptyFinance())));
app.post('/api/data', auth(async (req, res) => { await store.saveUserData(req.uid, req.body || store.emptyFinance()); res.json({ ok: true }); }));
app.post('/api/reset', auth(async (req, res) => { const d = store.emptyFinance(); await store.saveUserData(req.uid, d); res.json(d); }));

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
  applyBankTx(req.user.data, tx); await store.saveUserData(req.uid, req.user.data);
  res.json({ tx, aiCategorized: HAS_AI() });
}));
app.post('/api/webhooks/casso', async (req, res) => {
  try {
    const token = req.headers['secure-token'] || (req.headers['authorization'] || '').replace(/^Apikey\s+/i, '');
    if (CASSO_TOKEN && token !== CASSO_TOKEN) return res.status(401).json({ error: 1, message: 'invalid token' });
    const email = (req.query.email || '').toLowerCase();
    const user = email ? await store.userByEmail(email) : await store.firstUser();
    if (!user) return res.json({ success: true, note: 'no user' });
    for (const t of (req.body && req.body.data) || []) {
      const tx = { description: t.description, amount: Number(t.amount), when: t.when };
      if (tx.amount < 0) tx.category = (await categorize(tx.description)) || 'Khác';
      applyBankTx(user.data, tx);
    }
    await store.saveUserData(user.id, user.data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ---------- VNPAY sandbox ---------- */
function vnpSortObject(obj) {
  const sorted = {}, str = [];
  for (const key in obj) if (Object.prototype.hasOwnProperty.call(obj, key)) str.push(encodeURIComponent(key));
  str.sort();
  for (let i = 0; i < str.length; i++) sorted[str[i]] = encodeURIComponent(obj[str[i]]).replace(/%20/g, '+');
  return sorted;
}
const vnpDate = d => { const p = n => ('' + n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
const vnpQS = p => Object.keys(p).map(k => k + '=' + p[k]).join('&');
app.post('/api/vnpay/create', auth(async (req, res) => {
  if (!VNP.tmn || !VNP.secret) return res.status(503).json({ error: 'Chưa cấu hình VNPAY. Đăng ký sandbox tại sandbox.vnpayment.vn/devreg rồi thêm VNP_TMN_CODE & VNP_HASH_SECRET vào .env.' });
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
  p.vnp_SecureHash = crypto.createHmac('sha512', VNP.secret).update(Buffer.from(vnpQS(p), 'utf-8')).digest('hex');
  res.json({ url: VNP.url + '?' + vnpQS(p) });
}));
app.get('/api/vnpay/return', async (req, res) => {
  try {
    let p = Object.assign({}, req.query);
    const secureHash = p.vnp_SecureHash; delete p.vnp_SecureHash; delete p.vnp_SecureHashType;
    p = vnpSortObject(p);
    const check = crypto.createHmac('sha512', VNP.secret).update(Buffer.from(vnpQS(p), 'utf-8')).digest('hex');
    const ok = secureHash === check && req.query.vnp_ResponseCode === '00';
    if (ok) {
      const uid = String(req.query.vnp_TxnRef || '').split('_').slice(1).join('_');
      const amount = Math.round((+req.query.vnp_Amount || 0) / 100);
      const u = await store.userById(uid);
      if (u && amount > 0) {
        u.data.balance = (u.data.balance || 0) + amount;
        u.data.tx.unshift({ name: 'Nạp ví qua VNPAY', cat: 'Thu nhập', val: amount, inc: true, d: new Date().getDate() + '/' + (new Date().getMonth() + 1), m: new Date().toISOString().slice(0, 7), src: 'vnpay' });
        await store.saveUserData(u.id, u.data);
      }
    }
    res.redirect('/?vnp=' + (ok ? 'success' : 'fail') + '&amt=' + Math.round((+req.query.vnp_Amount || 0) / 100));
  } catch (e) { res.redirect('/?vnp=fail'); }
});

/* ---------- Social ---------- */
app.get('/api/funds', auth(async (req, res) => res.json(await store.fundsByOwner(req.uid))));
app.post('/api/funds', auth(async (req, res) => {
  const { name, emoji, target } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Thiếu tên quỹ' });
  const f = { id: rid('f_'), ownerId: req.uid, name, emoji: emoji || '🎯', target: +target || 0, members: [{ name: req.user.name, amount: 0, mine: true }], createdAt: Date.now() };
  await store.createFund(f); res.json(f);
}));
app.post('/api/funds/:id/member', auth(async (req, res) => {
  const f = await store.fundById(req.params.id);
  if (!f || f.ownerId !== req.uid) return res.status(404).json({ error: 'Không tìm thấy quỹ' });
  f.members.push({ name: (req.body.name || 'Thành viên').slice(0, 30), amount: 0 }); await store.saveFund(f); res.json(f);
}));
app.post('/api/funds/:id/contribute', auth(async (req, res) => {
  const f = await store.fundById(req.params.id);
  if (!f || f.ownerId !== req.uid) return res.status(404).json({ error: 'Không tìm thấy quỹ' });
  const i = Math.max(0, Math.min(f.members.length - 1, +req.body.idx || 0));
  f.members[i].amount += Math.abs(+req.body.amount || 0); await store.saveFund(f); res.json(f);
}));
app.delete('/api/funds/:id', auth(async (req, res) => { await store.deleteFund(req.params.id, req.uid); res.json({ ok: true }); }));
app.get('/api/leaderboard', auth(async (req, res) => {
  const users = await store.allUsers();
  const list = users.map(u => {
    const tx = (u.data && u.data.tx) || [];
    const inc = tx.filter(t => t.val > 0).reduce((s, t) => s + t.val, 0);
    const exp = tx.filter(t => t.val < 0).reduce((s, t) => s + Math.abs(t.val), 0);
    return { name: u.name, streak: (u.data && u.data.streak && u.data.streak.count) || 0, rate: inc ? Math.round((inc - exp) / inc * 100) : 0, badges: (u.data && u.data.badges || []).length, you: u.id === req.uid };
  }).sort((a, b) => b.streak - a.streak || b.rate - a.rate || b.badges - a.badges);
  res.json(list.slice(0, 20));
}));

/* ---------- Static + start ---------- */
app.use(express.static(path.join(__dirname, 'public')));
store.init().then(() => {
  app.listen(PORT, () => {
    console.log('  MoneyMate  ->  http://localhost:' + PORT);
    console.log('  Lưu trữ: ' + (store.usingPg() ? 'PostgreSQL (bảng users/tokens/funds)' : 'db.json (local)'));
    console.log('  AI: ' + (KEY ? 'Claude (' + MODEL + ')' : (GEMINI_KEY ? 'Gemini FREE (' + GEMINI_MODEL + ')' : 'TẮT')) + ' | VNPAY: ' + (VNP.tmn ? 'BẬT' : 'chưa cấu hình'));
  });
}).catch(e => { console.error('Khởi tạo lưu trữ thất bại:', e.message); process.exit(1); });
