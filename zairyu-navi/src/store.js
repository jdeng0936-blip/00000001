// 持久化层。用 Node 自带的 SQLite（node:sqlite），不需要安装任何依赖。
// 正式环境换成 PostgreSQL 时，只需要重写本文件，接口不变。
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const EMPTY_PROFILE = { status: 'none', entry: '', addr: '', exp: '', ins: false, age: true, lic: false, pr: false,
  arrive: '', work: '', married: '', hsp: '0', jp: '', pay: true, trips: [] };

// 验证码错几次作废、每个账号最多留几个找回登录、邮件发送失败后隔多久重试（分钟）
const MAX_ATTEMPTS = 5, MAX_SESSIONS = 10, BACKOFF_MIN = [1, 5, 30, 120, 720];
const DAY = 24 * 60 * 60 * 1000;

// opts.clock：返回毫秒时间的函数，测试里用它拨时间（验证码过期、限流窗口）。
function createStore(file, opts) {
  const clock = (opts && opts.clock) || (() => Date.now());
  const db = new DatabaseSync(file || ':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL, consent_at TEXT NOT NULL, profile TEXT NOT NULL, done TEXT NOT NULL, plan TEXT NOT NULL, auth TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, date TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, area TEXT, langs TEXT, fee_note TEXT, license_no TEXT, fee_model TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT NOT NULL, node_id TEXT, category TEXT NOT NULL, summary TEXT NOT NULL, consent_at TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replies (id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT);
    -- 下面几张表是邮箱绑定和找回账号用的。users 表不加列（没有迁移机制），旧的数据库文件打开后自动多出这几张表。
    -- sessions：用邮箱在别的设备上找回账号时发的令牌（只存哈希）。注册时的令牌仍在 users.token_hash。
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, via TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
    -- user_emails：只放验证过的邮箱，明文（发信要用），一个账号一个邮箱、一个邮箱一个账号。
    -- remind_opt_in_at、unsub_token、bounced_at 是邮件提醒用的，现在只建列，还没有用到。
    CREATE TABLE IF NOT EXISTS user_emails (user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, verified_at TEXT NOT NULL, consent_version TEXT NOT NULL, remind_opt_in_at TEXT, unsub_token TEXT NOT NULL UNIQUE, bounced_at TEXT);
    -- email_challenges：验证码。只存 sha256(id:验证码)；purpose 是 bind 或 recover；找回时邮箱没绑定过也存一行（user_id 为空），两种情况走同样的路。
    CREATE TABLE IF NOT EXISTS email_challenges (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, email TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
    -- rate_events：限流的滑动窗口。bucket 里是来源地址、邮箱、账号的哈希，不放原文。
    CREATE TABLE IF NOT EXISTS rate_events (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_bucket ON rate_events (bucket, at);
    -- outbox：所有要发出去的邮件先进这里。kind：code 验证码、notice 通知；status：queued、sent、failed。
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, headers TEXT, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT);
  `);
  const now = () => new Date(clock()).toISOString();
  const isoOf = (ms) => new Date(ms).toISOString();
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
    // 令牌对得上注册时的令牌，或者对得上这个账号的某个找回登录，都算登录。
    checkToken(id, token) {
      const u = db.prepare('SELECT token_hash FROM users WHERE id=?').get(id);
      if (!u || typeof token !== 'string') return false;
      const h = hash(token);
      if (same(u.token_hash, h)) return true;
      const s = db.prepare('SELECT last_used_at FROM sessions WHERE token_hash=? AND user_id=?').get(h, id);
      if (!s) return false;
      // 最后使用时间只用来给用户看“哪台设备还在用”，一分钟最多写一次
      if (!s.last_used_at || Date.parse(s.last_used_at) < clock() - 60 * 1000) db.prepare('UPDATE sessions SET last_used_at=? WHERE token_hash=?').run(now(), h);
      return true;
    },
    // 条款改版后重新同意：只更新版本和时间
    renewConsent(id, version) {
      db.prepare('UPDATE users SET consent_version=?, consent_at=? WHERE id=?').run(version, now(), id);
      log(id, 'consent.renew', { consentVersion: version });
    },
    saveUser(u, action, detail) {
      db.prepare('UPDATE users SET profile=?, done=?, plan=?, auth=? WHERE id=?').run(JSON.stringify(u.profile), JSON.stringify(u.done), JSON.stringify(u.plan), JSON.stringify(u.auth), u.id);
      log(u.id, action, detail);
    },
    // 删除账号：一个事务里删掉全部数据，并把留痕表里这个用户的痕迹抹掉。
    // 留痕只保留“什么时候发生过什么动作”，用户 id 和细节（改了哪些字段、发给了哪家服务商、咨询 id）都清空。
    deleteUser(id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const q of db.prepare('SELECT id FROM inquiries WHERE user_id=?').all(id)) {
          db.prepare('DELETE FROM replies WHERE inquiry_id=?').run(q.id);
          // 服务商回复时留下的痕迹不带用户 id，但带咨询 id，一并清掉
          db.prepare("UPDATE audit SET detail=NULL WHERE action='inquiry.reply' AND detail=?").run(JSON.stringify({ id: q.id }));
        }
        db.prepare('DELETE FROM inquiries WHERE user_id=?').run(id);
        db.prepare('DELETE FROM events WHERE user_id=?').run(id);
        // 邮箱、验证码、别的设备的登录、发给这个邮箱的邮件、按这个邮箱和账号记的限流次数，全部删掉
        const em = db.prepare('SELECT email FROM user_emails WHERE user_id=?').get(id);
        const addr = em ? em.email : '';
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        db.prepare('DELETE FROM email_challenges WHERE user_id=? OR email=?').run(id, addr);
        db.prepare('DELETE FROM outbox WHERE user_id=? OR to_addr=?').run(id, addr);
        db.prepare('DELETE FROM user_emails WHERE user_id=?').run(id);
        for (const v of [id].concat(addr ? [addr] : [])) db.prepare("DELETE FROM rate_events WHERE bucket LIKE '%:' || ?").run(hash(v));
        db.prepare('DELETE FROM users WHERE id=?').run(id);
        db.prepare('UPDATE audit SET user_id=NULL, detail=NULL WHERE user_id=?').run(id);
        log(null, 'user.delete');
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (e2) { /* 事务已经不在了 */ }
        throw e;
      }
    },
    // ---- 事务：fn 里的几次写入要么都成，要么都不成 ----
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) {
        try { db.exec('ROLLBACK'); } catch (e2) { /* 事务已经不在了 */ }
        throw e;
      }
    },
    // ---- 别的设备的登录 ----
    // 找回账号时发一个新令牌（只返回这一次，库里存哈希）。注册时的令牌不动，原来的设备不掉线。
    createSession(userId, via) {
      const token = newToken();
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(hash(token), userId, now(), null, via);
      // 一个账号最多留 MAX_SESSIONS 个找回登录，多出来的把最早的去掉
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)').run(userId, userId, MAX_SESSIONS);
      log(userId, 'session.recover');
      return token;
    },
    // 列出这个账号的登录。current 标出发请求的这一个。不返回令牌和哈希。
    listSessions(userId, token) {
      const u = db.prepare('SELECT token_hash, created_at FROM users WHERE id=?').get(userId);
      if (!u) return [];
      const h = typeof token === 'string' ? hash(token) : '';
      const out = u.token_hash.startsWith('revoked:') ? [] : [{ createdAt: u.created_at, lastUsedAt: null, via: 'signup', current: same(u.token_hash, h) }];
      for (const s of db.prepare('SELECT token_hash, created_at, last_used_at, via FROM sessions WHERE user_id=? ORDER BY created_at, rowid').all(userId)) out.push({ createdAt: s.created_at, lastUsedAt: s.last_used_at, via: s.via, current: same(s.token_hash, h) });
      return out;
    },
    // 让其他设备退出登录：只留下发请求的这个令牌。返回退出了几个。
    revokeOtherSessions(userId, token) {
      const u = db.prepare('SELECT token_hash FROM users WHERE id=?').get(userId);
      if (!u || typeof token !== 'string') return 0;
      const h = hash(token);
      return this.tx(() => {
        let n = db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, h).changes;
        // 发请求的不是注册时的令牌：把注册时的令牌换成一个谁也用不了的值
        if (!same(u.token_hash, h) && !u.token_hash.startsWith('revoked:')) { db.prepare('UPDATE users SET token_hash=? WHERE id=?').run('revoked:' + newToken(), userId); n++; }
        log(userId, 'session.revoke', { count: n });
        return n;
      });
    },
    // ---- 邮箱 ----
    getEmail(userId) {
      const r = db.prepare('SELECT email, verified_at, remind_opt_in_at FROM user_emails WHERE user_id=?').get(userId);
      return r ? { email: r.email, verifiedAt: r.verified_at, remindOptIn: !!r.remind_opt_in_at } : null;
    },
    userByEmail(email) { const r = db.prepare('SELECT user_id FROM user_emails WHERE email=?').get(email); return r ? r.user_id : null; },
    // 绑定（换绑时替换原来的）。邮箱已经绑在别的账号上时返回 false，什么都不改。留痕里不写邮箱。
    bindEmail(userId, email, consentVersion) {
      const owner = this.userByEmail(email);
      if (owner && owner !== userId) return false;
      this.tx(() => {
        const old = db.prepare('SELECT email FROM user_emails WHERE user_id=?').get(userId);
        if (old && old.email !== email) { // 换了邮箱：旧邮箱的验证码和还没处理完的邮件不留
          db.prepare('DELETE FROM email_challenges WHERE email=?').run(old.email);
          db.prepare('DELETE FROM outbox WHERE to_addr=?').run(old.email);
        }
        if (old && old.email === email) db.prepare('UPDATE user_emails SET verified_at=?, consent_version=? WHERE user_id=?').run(now(), consentVersion, userId); // 同一个邮箱再验证一次：其他设置不动
        else {
          db.prepare('DELETE FROM user_emails WHERE user_id=?').run(userId);
          db.prepare('INSERT INTO user_emails VALUES (?,?,?,?,?,?,?)').run(userId, email, now(), consentVersion, null, newToken(), null);
        }
        log(userId, 'email.bind');
      });
      return true;
    },
    // 解除绑定：邮箱、没用完的验证码、发给这个邮箱的邮件一并删掉。账号还在。
    removeEmail(userId) {
      return this.tx(() => {
        const old = db.prepare('SELECT email FROM user_emails WHERE user_id=?').get(userId);
        db.prepare('DELETE FROM email_challenges WHERE user_id=? OR email=?').run(userId, old ? old.email : '');
        db.prepare('DELETE FROM outbox WHERE user_id=? OR to_addr=?').run(userId, old ? old.email : '');
        if (!old) return false;
        db.prepare('DELETE FROM user_emails WHERE user_id=?').run(userId);
        log(userId, 'email.remove');
        return true;
      });
    },
    // ---- 验证码 ----
    // code 为空时存一个谁也猜不到的哈希：这行验证码永远验不过（邮箱没绑定过、或已绑在别的账号上时用）。
    // 同一用途、同一邮箱（绑定时还有同一账号）之前没用掉的验证码同时作废。
    createChallenge(c, ttlMs) {
      const id = crypto.randomUUID(), t = clock();
      db.prepare('UPDATE email_challenges SET used_at=? WHERE used_at IS NULL AND purpose=? AND (email=? OR (purpose=\'bind\' AND user_id=?))').run(isoOf(t), c.purpose, c.email, c.userId || '');
      db.prepare('INSERT INTO email_challenges (id,purpose,user_id,email,code_hash,attempts,expires_at,used_at,created_at) VALUES (?,?,?,?,?,0,?,NULL,?)')
        .run(id, c.purpose, c.userId || null, c.email, hash(id + ':' + (c.code || newToken())), isoOf(t + ttlMs), isoOf(t));
      return id;
    },
    // 限流要按邮箱计数，先查这行验证码是发给哪个邮箱的（没有这一行返回 null）
    challengeEmail(id) { const r = db.prepare('SELECT email FROM email_challenges WHERE id=?').get(String(id)); return r ? r.email : null; },
    // 核对验证码。对了返回 { userId, email } 并作废这一行；其余情况（没有这一行、用途不对、不是这个账号的、过期、用过、错满次数、验证码不对）一律返回 null。
    // 每次核对先记一次尝试，再比较，所以同时发来的多个请求也超不过次数。
    verifyChallenge(id, purpose, code, userId) {
      const t = isoOf(clock());
      const hit = db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=? AND purpose=? AND used_at IS NULL AND expires_at>? AND attempts<?').run(String(id), purpose, t, MAX_ATTEMPTS).changes === 1;
      const c = db.prepare('SELECT user_id, email, code_hash FROM email_challenges WHERE id=?').get(String(id));
      // 没有这一行时也做一次同样的比较
      const ok = same(c ? c.code_hash : hash('none'), hash(String(id) + ':' + String(code)));
      if (!hit || !c || !ok) return null;
      if (purpose === 'bind' && c.user_id !== userId) return null;
      if (db.prepare('UPDATE email_challenges SET used_at=? WHERE id=? AND used_at IS NULL').run(t, String(id)).changes !== 1) return null;
      return { userId: c.user_id, email: c.email };
    },
    // ---- 限流 ----
    // rules：[{ key, max, windowMs }]，key 的冒号后面是哈希（不放来源地址和邮箱的原文）。
    // 任何一条满了就返回还要等多少秒，这次不计数；都没满才给每个 key 记一次，返回 0。
    hit(rules) {
      const t = clock(); let wait = 0;
      for (const r of rules) {
        const q = db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM rate_events WHERE bucket=? AND at>?').get(r.key, t - r.windowMs);
        if (q.n >= r.max) wait = Math.max(wait, Math.max(1, Math.ceil((q.first + r.windowMs - t) / 1000)));
      }
      if (wait) return wait;
      for (const k of new Set(rules.map((r) => r.key))) db.prepare('INSERT INTO rate_events (bucket, at) VALUES (?,?)').run(k, t);
      return 0;
    },
    rateKey(prefix, value) { return prefix + ':' + hash(String(value)); },
    // ---- 发件箱 ----
    enqueueMail(m) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO outbox (id,user_id,kind,to_addr,subject,body,headers,status,tries,next_try_at,last_error,created_at,sent_at) VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?,NULL)')
        .run(id, m.userId || null, m.kind, m.to, m.subject, m.body, m.headers ? JSON.stringify(m.headers) : null, 'queued', now(), now());
      return id;
    },
    // 取出到时间该发的邮件，并把下次重试时间先推后 10 分钟：同时跑的两轮发送不会把同一封发两次，发到一半进程退出的也会再试。
    claimOutbox() {
      const t = now(), later = isoOf(clock() + 10 * 60 * 1000), out = [];
      for (const r of db.prepare("SELECT id, user_id AS userId, kind, to_addr AS \"to\", subject, body, headers FROM outbox WHERE status='queued' AND next_try_at<=? ORDER BY created_at, rowid").all(t)) {
        if (db.prepare("UPDATE outbox SET next_try_at=? WHERE id=? AND status='queued' AND next_try_at<=?").run(later, r.id, t).changes === 1) out.push(Object.assign(r, { headers: r.headers ? JSON.parse(r.headers) : null }));
      }
      return out;
    },
    // blank：发完就把正文和收件地址清掉（真实发信时验证码邮件用）
    markSent(id, blank) {
      db.prepare("UPDATE outbox SET status='sent', sent_at=?, tries=tries+1, next_try_at=NULL, last_error=NULL" + (blank ? ", body='', to_addr=''" : '') + ' WHERE id=?').run(now(), id);
    },
    // 发送失败：1 分钟、5 分钟、30 分钟、2 小时、12 小时后各重试一次，第 5 次重试还失败就记为 failed，不再发
    markFailed(id, err) {
      const r = db.prepare('SELECT tries FROM outbox WHERE id=?').get(id); if (!r) return;
      const tries = r.tries + 1, giveUp = tries > BACKOFF_MIN.length;
      db.prepare('UPDATE outbox SET status=?, tries=?, next_try_at=?, last_error=? WHERE id=?').run(giveUp ? 'failed' : 'queued', tries, giveUp ? null : isoOf(clock() + BACKOFF_MIN[tries - 1] * 60 * 1000), String(err).slice(0, 300), id);
    },
    // 测试、本地开发和运维排查用。f：{ status, to }
    listOutbox(f) {
      f = f || {};
      return db.prepare('SELECT id, user_id AS userId, kind, to_addr AS "to", subject, body, headers, status, tries, next_try_at AS nextTryAt, last_error AS lastError, created_at AS createdAt, sent_at AS sentAt FROM outbox ORDER BY created_at, rowid').all()
        .filter((r) => (!f.status || r.status === f.status) && (!f.to || r.to === f.to)).map((r) => Object.assign(r, { headers: r.headers ? JSON.parse(r.headers) : null }));
    },
    // 定期清理：验证码过期 24 小时后删掉；限流记录留 24 小时；验证码邮件的正文 1 小时后清空；
    // 发完或失败的邮件 30 天后清掉正文和收件地址，只留“发过一封什么类型的邮件”。
    purgeExpired() {
      const t = clock();
      db.prepare('DELETE FROM email_challenges WHERE expires_at<?').run(isoOf(t - DAY));
      db.prepare('DELETE FROM rate_events WHERE at<?').run(t - DAY);
      db.prepare("UPDATE outbox SET body='' WHERE kind='code' AND body<>'' AND created_at<?").run(isoOf(t - 60 * 60 * 1000));
      db.prepare("UPDATE outbox SET body='', to_addr='', headers=NULL WHERE status<>'queued' AND to_addr<>'' AND created_at<?").run(isoOf(t - 30 * DAY));
    },
    // 测试用：每张新表里和这个账号、这个邮箱有关的行数
    emailFootprint(userId, email) {
      const n = (sql, ...a) => db.prepare(sql).get(...a).n;
      return {
        sessions: n('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', userId),
        emails: n('SELECT COUNT(*) AS n FROM user_emails WHERE user_id=? OR email=?', userId, email || ''),
        challenges: n('SELECT COUNT(*) AS n FROM email_challenges WHERE user_id=? OR email=?', userId, email || ''),
        outbox: n('SELECT COUNT(*) AS n FROM outbox WHERE user_id=? OR to_addr=?', userId, email || ''),
        rate: n("SELECT COUNT(*) AS n FROM rate_events WHERE bucket LIKE '%:' || ? OR bucket LIKE '%:' || ?", hash(userId), hash(email || '\0'))
      };
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
    // 留痕记录（测试和运维排查用，不经接口对外）
    auditRows() { return db.prepare('SELECT at, user_id AS userId, action, detail FROM audit ORDER BY id').all(); },
    auditCount() { return db.prepare('SELECT COUNT(*) AS n FROM audit').get().n; },
    close() { db.close(); }
  };
}
module.exports = { createStore, EMPTY_PROFILE, MAX_ATTEMPTS };
