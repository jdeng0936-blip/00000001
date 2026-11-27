// 持久化层。用 Node 自带的 SQLite（node:sqlite），不需要安装任何依赖。
// 正式环境换成 PostgreSQL 时，只需要重写本文件，接口不变。
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const EMPTY_PROFILE = { status: 'none', entry: '', addr: '', exp: '', ins: false, age: true, lic: false, pr: false,
  arrive: '', work: '', married: '', hsp: '0', jp: '', pay: true, trips: [] };

function createStore(file) {
  const db = new DatabaseSync(file || ':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL, consent_at TEXT NOT NULL, profile TEXT NOT NULL, done TEXT NOT NULL, plan TEXT NOT NULL, auth TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, area TEXT, langs TEXT, fee_note TEXT, license_no TEXT, fee_model TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT NOT NULL, node_id TEXT, category TEXT NOT NULL, summary TEXT NOT NULL, consent_at TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT);
  `);
  const now = () => new Date().toISOString();
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const row = (u) => u && { id: u.id, createdAt: u.created_at, consentVersion: u.consent_version, profile: JSON.parse(u.profile), done: JSON.parse(u.done), plan: JSON.parse(u.plan), auth: JSON.parse(u.auth) };
  const prow = (p) => p && { id: p.id, name: p.name, category: p.category, area: p.area || '', langs: p.langs || '', feeNote: p.fee_note || '', licenseNo: p.license_no || '', feeModel: p.fee_model, active: !!p.active };
  const log = (userId, action, detail) => db.prepare('INSERT INTO audit (at,user_id,action,detail) VALUES (?,?,?,?)').run(now(), userId || null, action, detail ? JSON.stringify(detail) : null);
  const repliesOf = (id) => db.prepare('SELECT text, created_at AS createdAt FROM replies WHERE inquiry_id=? ORDER BY created_at').all(id);

  return {
    EMPTY_PROFILE,
    // ---- 用户 ----
    createUser(consentVersion) {
      const id = crypto.randomUUID(), token = newToken(); // 令牌只在创建时返回一次，库里只存它的哈希
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(id, hash(token), now(), consentVersion || 'test', now(), JSON.stringify(EMPTY_PROFILE), '{}', '{}', JSON.stringify({ mail: false, cal: false, push: false }));
      log(id, 'user.create', { consentVersion: consentVersion || 'test' });
      return Object.assign(this.getUser(id), { token });
    },
    getUser(id) { return row(db.prepare('SELECT * FROM users WHERE id=?').get(id)); },
    checkToken(id, token) {
      const u = db.prepare('SELECT token_hash FROM users WHERE id=?').get(id);
      return !!u && typeof token === 'string' && same(u.token_hash, hash(token));
    },
    saveUser(u, action, detail) {
      db.prepare('UPDATE users SET profile=?, done=?, plan=?, auth=? WHERE id=?').run(JSON.stringify(u.profile), JSON.stringify(u.done), JSON.stringify(u.plan), JSON.stringify(u.auth), u.id);
      log(u.id, action, detail);
    },
    deleteUser(id) {
      for (const q of db.prepare('SELECT id FROM inquiries WHERE user_id=?').all(id)) db.prepare('DELETE FROM replies WHERE inquiry_id=?').run(q.id);
      db.prepare('DELETE FROM inquiries WHERE user_id=?').run(id);
      db.prepare('DELETE FROM events WHERE user_id=?').run(id);
      db.prepare('DELETE FROM users WHERE id=?').run(id);
      log(null, 'user.delete');
    },
    // ---- 事件 ----
    addEvent(userId, ev) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?)').run(id, userId, ev.type, ev.date, ev.note || null, now());
      log(userId, 'event.create', { type: ev.type });
      return id;
    },
    listEvents(userId) { return db.prepare('SELECT id, type, date, note FROM events WHERE user_id=? ORDER BY date').all(userId); },
    deleteEvent(userId, id) { return db.prepare('DELETE FROM events WHERE user_id=? AND id=?').run(userId, id).changes > 0; },
    // ---- 服务商 ----
    createProvider(p) {
      const id = crypto.randomUUID(), token = newToken();
      db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, hash(token), p.name, p.category, p.area || null, p.langs || null, p.feeNote || null, p.licenseNo || null, p.feeModel, 1, now());
      log(null, 'provider.create', { id, category: p.category });
      return Object.assign(this.getProvider(id), { token });
    },
    getProvider(id) { return prow(db.prepare('SELECT * FROM providers WHERE id=?').get(id)); },
    providerByToken(token) { return typeof token === 'string' ? prow(db.prepare('SELECT * FROM providers WHERE token_hash=? AND active=1').get(hash(token))) : null; },
    listProviders(category) {
      const rows = category ? db.prepare('SELECT * FROM providers WHERE active=1 AND category=? ORDER BY created_at').all(category) : db.prepare('SELECT * FROM providers WHERE active=1 ORDER BY created_at').all();
      return rows.map(prow);
    },
    setProviderActive(id, on) { db.prepare('UPDATE providers SET active=? WHERE id=?').run(on ? 1 : 0, id); log(null, 'provider.active', { id, on }); },
    // ---- 咨询 ----
    addInquiry(userId, q) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO inquiries VALUES (?,?,?,?,?,?,?,?,?)').run(id, userId, q.providerId, q.nodeId || null, q.category, q.summary, now(), 'sent', now());
      log(userId, 'inquiry.create', { id, category: q.category, providerId: q.providerId });
      return id;
    },
    listInquiries(userId) {
      return db.prepare('SELECT i.id, i.node_id AS nodeId, i.category, i.summary, i.status, i.created_at AS createdAt, p.name AS providerName FROM inquiries i JOIN providers p ON p.id=i.provider_id WHERE i.user_id=? ORDER BY i.created_at').all(userId)
        .map((q) => Object.assign(q, { replies: repliesOf(q.id) }));
    },
    // 服务商看到的咨询不带用户的 id，只有咨询本身。
    listInquiriesFor(providerId) {
      return db.prepare('SELECT id, node_id AS nodeId, category, summary, status, created_at AS createdAt FROM inquiries WHERE provider_id=? ORDER BY created_at DESC').all(providerId)
        .map((q) => Object.assign(q, { replies: repliesOf(q.id) }));
    },
    inquiryOf(providerId, id) { return db.prepare('SELECT id, status FROM inquiries WHERE provider_id=? AND id=?').get(providerId, id); },
    setInquiryStatus(id, status) { db.prepare('UPDATE inquiries SET status=? WHERE id=?').run(status, id); },
    addReply(inquiryId, text) {
      db.prepare('INSERT INTO replies VALUES (?,?,?,?)').run(crypto.randomUUID(), inquiryId, text, now());
      db.prepare("UPDATE inquiries SET status='replied' WHERE id=?").run(inquiryId);
      log(null, 'inquiry.reply', { id: inquiryId });
    },
    auditCount() { return db.prepare('SELECT COUNT(*) AS n FROM audit').get().n; },
    close() { db.close(); }
  };
}
module.exports = { createStore, EMPTY_PROFILE };
