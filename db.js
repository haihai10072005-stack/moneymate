/**
 * Tầng lưu trữ MoneyMate (DAO)
 * - Postgres (DATABASE_URL): mỗi user/token/fund là 1 dòng riêng → nhiều người ghi cùng lúc KHÔNG đè nhau
 * - JSON (db.json): fallback cho local dev
 * - Tự migrate dữ liệu cũ (kv blob) sang bảng chuẩn lần đầu
 */
const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, 'db.json');
const USE_PG = !!process.env.DATABASE_URL;
let pool, mem;

function emptyFinance() {
  return {
    balance: 0, tx: [],
    budgets: [
      { name: 'Ăn uống', limit: 3000000 }, { name: 'Đi lại', limit: 1500000 },
      { name: 'Mua sắm', limit: 2000000 }, { name: 'Giải trí', limit: 1500000 }, { name: 'Hoá đơn', limit: 1500000 }
    ],
    goals: [], streak: { count: 0, last: '' }, challenges: [], badges: [], subs: []
  };
}

/* ---- JSON local ---- */
function loadMem() { try { mem = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { mem = {}; } mem.users = mem.users || {}; mem.tokens = mem.tokens || {}; mem.funds = mem.funds || []; }
function saveMem() { fs.writeFileSync(DB_FILE, JSON.stringify(mem, null, 2)); }

/* ---- PG row map ---- */
const rowUser = r => r ? { id: r.id, email: r.email, name: r.name, salt: r.salt, passHash: r.pass_hash, data: r.data || emptyFinance(), createdAt: Number(r.created_at) || 0, resetToken: r.reset_token, resetExpires: r.reset_expires ? Number(r.reset_expires) : 0 } : null;
const rowFund = r => r ? { id: r.id, ownerId: r.owner_id, name: r.name, emoji: r.emoji, target: Number(r.target) || 0, members: r.members || [], createdAt: Number(r.created_at) || 0 } : null;

async function init() {
  if (!USE_PG) { loadMem(); return; }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
  await pool.query(`CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, salt text NOT NULL, pass_hash text NOT NULL, data jsonb NOT NULL DEFAULT '{}', reset_token text, reset_expires bigint, created_at bigint)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tokens(token text PRIMARY KEY, user_id text NOT NULL, created_at bigint)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS funds(id text PRIMARY KEY, owner_id text NOT NULL, name text, emoji text, target bigint, members jsonb NOT NULL DEFAULT '[]', created_at bigint)`);
  await migrate();
}
async function migrate() {
  try {
    if ((await pool.query('SELECT COUNT(*)::int n FROM users')).rows[0].n > 0) return;
    if (!(await pool.query("SELECT to_regclass('public.kv') t")).rows[0].t) return;
    const r = await pool.query("SELECT v FROM kv WHERE k='db'");
    if (!r.rows.length) return;
    const b = r.rows[0].v || {};
    for (const id in (b.users || {})) { const x = b.users[id]; await pool.query('INSERT INTO users(id,email,name,salt,pass_hash,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING', [x.id, x.email, x.name, x.salt, x.passHash, JSON.stringify(x.data || {}), x.createdAt || Date.now()]); }
    for (const t in (b.tokens || {})) { await pool.query('INSERT INTO tokens(token,user_id,created_at) VALUES($1,$2,$3) ON CONFLICT (token) DO NOTHING', [t, b.tokens[t], Date.now()]); }
    for (const f of (b.funds || [])) { await pool.query('INSERT INTO funds(id,owner_id,name,emoji,target,members,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING', [f.id, f.ownerId, f.name, f.emoji, f.target || 0, JSON.stringify(f.members || []), f.createdAt || Date.now()]); }
    console.log('  Đã migrate dữ liệu cũ (kv blob) -> bảng users/tokens/funds');
  } catch (e) { console.error('  migrate bỏ qua:', e.message); }
}

module.exports = {
  emptyFinance, init, usingPg: () => USE_PG,
  /* users */
  async userByEmail(email) {
    if (USE_PG) return rowUser((await pool.query('SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1', [email])).rows[0]);
    return Object.values(mem.users).find(u => u.email.toLowerCase() === String(email).toLowerCase()) || null;
  },
  async userById(id) {
    if (USE_PG) return rowUser((await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]);
    return mem.users[id] || null;
  },
  async createUser(u) {
    if (USE_PG) await pool.query('INSERT INTO users(id,email,name,salt,pass_hash,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [u.id, u.email, u.name, u.salt, u.passHash, JSON.stringify(u.data || emptyFinance()), u.createdAt]);
    else { mem.users[u.id] = u; saveMem(); }
  },
  async saveUserData(id, data) {
    if (USE_PG) await pool.query('UPDATE users SET data=$2 WHERE id=$1', [id, JSON.stringify(data)]);
    else if (mem.users[id]) { mem.users[id].data = data; saveMem(); }
  },
  async setPassword(id, salt, passHash) {
    if (USE_PG) await pool.query('UPDATE users SET salt=$2, pass_hash=$3, reset_token=NULL, reset_expires=NULL WHERE id=$1', [id, salt, passHash]);
    else { const u = mem.users[id]; if (u) { u.salt = salt; u.passHash = passHash; delete u.resetToken; delete u.resetExpires; saveMem(); } }
  },
  async setReset(id, token, expires) {
    if (USE_PG) await pool.query('UPDATE users SET reset_token=$2, reset_expires=$3 WHERE id=$1', [id, token, expires]);
    else { const u = mem.users[id]; if (u) { u.resetToken = token; u.resetExpires = expires; saveMem(); } }
  },
  async userByReset(token) {
    if (USE_PG) return rowUser((await pool.query('SELECT * FROM users WHERE reset_token=$1 AND reset_expires>$2 LIMIT 1', [token, Date.now()])).rows[0]);
    return Object.values(mem.users).find(u => u.resetToken === token && (u.resetExpires || 0) > Date.now()) || null;
  },
  async allUsers() {
    if (USE_PG) return (await pool.query('SELECT id,name,data FROM users')).rows.map(r => ({ id: r.id, name: r.name, data: r.data || {} }));
    return Object.values(mem.users).map(u => ({ id: u.id, name: u.name, data: u.data || {} }));
  },
  async firstUser() {
    if (USE_PG) return rowUser((await pool.query('SELECT * FROM users ORDER BY created_at LIMIT 1')).rows[0]);
    return Object.values(mem.users)[0] || null;
  },
  /* tokens */
  async tokenUser(token) {
    if (!token) return null;
    if (USE_PG) { const r = await pool.query('SELECT user_id FROM tokens WHERE token=$1', [token]); return r.rows[0] ? r.rows[0].user_id : null; }
    return mem.tokens[token] || null;
  },
  async addToken(token, uid) {
    if (USE_PG) await pool.query('INSERT INTO tokens(token,user_id,created_at) VALUES($1,$2,$3) ON CONFLICT (token) DO NOTHING', [token, uid, Date.now()]);
    else { mem.tokens[token] = uid; saveMem(); }
  },
  async delToken(token) {
    if (USE_PG) await pool.query('DELETE FROM tokens WHERE token=$1', [token]);
    else { delete mem.tokens[token]; saveMem(); }
  },
  /* funds */
  async fundsByOwner(ownerId) {
    if (USE_PG) return (await pool.query('SELECT * FROM funds WHERE owner_id=$1 ORDER BY created_at', [ownerId])).rows.map(rowFund);
    return mem.funds.filter(f => f.ownerId === ownerId);
  },
  async fundById(id) {
    if (USE_PG) return rowFund((await pool.query('SELECT * FROM funds WHERE id=$1', [id])).rows[0]);
    return mem.funds.find(f => f.id === id) || null;
  },
  async createFund(f) {
    if (USE_PG) await pool.query('INSERT INTO funds(id,owner_id,name,emoji,target,members,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [f.id, f.ownerId, f.name, f.emoji, f.target, JSON.stringify(f.members), f.createdAt]);
    else { mem.funds.push(f); saveMem(); }
  },
  async saveFund(f) {
    if (USE_PG) await pool.query('UPDATE funds SET name=$2,emoji=$3,target=$4,members=$5 WHERE id=$1', [f.id, f.name, f.emoji, f.target, JSON.stringify(f.members)]);
    else { const i = mem.funds.findIndex(x => x.id === f.id); if (i >= 0) { mem.funds[i] = f; saveMem(); } }
  },
  async deleteFund(id, ownerId) {
    if (USE_PG) await pool.query('DELETE FROM funds WHERE id=$1 AND owner_id=$2', [id, ownerId]);
    else { mem.funds = mem.funds.filter(f => !(f.id === id && f.ownerId === ownerId)); saveMem(); }
  }
};
