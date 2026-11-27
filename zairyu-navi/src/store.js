// 持久化层。用 Node 自带的 SQLite（node:sqlite），不需要安装任何依赖。
// 正式环境换成 PostgreSQL 时，只需要重写本文件，接口不变。
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const EMPTY_PROFILE = { status: 'none', entry: '', addr: '', exp: '', ins: false, age: true, lic: false, pr: false,
  arrive: '', work: '', married: '', hsp: '0', jp: '', pay: true, trips: [] };

// 验证码错几次作废、每个账号最多留几个找回登录、邮件发送失败后隔多久重试（分钟）
const MAX_ATTEMPTS = 5, MAX_SESSIONS = 10, BACKOFF_MIN = [1, 5, 30, 120, 720];
const DAY = 24 * 60 * 60 * 1000;
// 验证码 10 分钟失效。验证码邮件过了这个时间还没发出去就不再发（发出去也用不了）。
const CODE_TTL_MS = 10 * 60 * 1000;
// 原来的邮箱验证过之后拿到的确认（更换、解除邮箱要用）15 分钟内有效：换绑时还要再收一次新邮箱的验证码，留出时间。
const PROOF_TTL_MS = 15 * 60 * 1000;
// 不用登录就能索取的验证码：找回账号、入驻申请（papply）、服务商领取令牌（pclaim）。
// 谁都能对着一个邮箱点“发送”，所以重新发送不作废旧的，核对时也不看发起的账号。
const UNAUTH_PURPOSES = new Set(['recover', 'papply', 'pclaim']);
// 日历日（YYYY-MM-DD）加减天数，按 UTC 算，和服务器的时区无关
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
// 日本时间的今天
const jstToday = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
// 参考编号、申请编号用的字符：去掉容易看错的 0 O 1 I L
const SAFE = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const safeCode = (n) => Array.from(crypto.randomBytes(n), (b) => SAFE[b % SAFE.length]).join('');

// opts.clock：返回毫秒时间的函数，测试里用它拨时间（验证码过期、限流窗口）。
function createStore(file, opts) {
  const clock = (opts && opts.clock) || (() => Date.now());
  const db = new DatabaseSync(file || ':memory:');
  // 这两项要在建表之前设好。
  // busy_timeout：定时提醒可以由另一个进程跑（npm run remind），对方正在写的时候等一等，不直接报“数据库忙”（建表那一步也要读库，同样会撞上）。
  // secure_delete：删掉的行（邮箱、备注、邮件正文）在文件里用零盖掉，不留在空闲页里。备份文件不归这里管，要按同样的期限清理。
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA secure_delete = ON');
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
    -- remind_opt_in_at：同意收提醒邮件的时间，空着就不发；unsub_token：退订链接里的令牌（每个邮箱一个，猜不到）；bounced_at：退信后停发（现在只能人工填）。
    CREATE TABLE IF NOT EXISTS user_emails (user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, verified_at TEXT NOT NULL, consent_version TEXT NOT NULL, remind_opt_in_at TEXT, unsub_token TEXT NOT NULL UNIQUE, bounced_at TEXT);
    -- email_challenges：验证码。只存 sha256(id:验证码)；purpose 是 bind 或 recover；找回时邮箱没绑定过也存一行（user_id 为空），两种情况走同样的路。
    CREATE TABLE IF NOT EXISTS email_challenges (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, user_id TEXT, email TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
    -- rate_events：限流的滑动窗口。bucket 里是来源地址、邮箱、账号的哈希，不放原文。
    CREATE TABLE IF NOT EXISTS rate_events (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_bucket ON rate_events (bucket, at);
    -- outbox：所有要发出去的邮件先进这里。kind：code 验证码、notice 通知、reminder 期限提醒、
    -- last 发给已经换掉或解除的邮箱的最后一封通知（发出或放弃后立即清掉地址和正文）、pad 不是邮件（见 enqueuePad）；
    -- status：queued、sent、failed、dropped（发之前发现不该发了）。
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, headers TEXT, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT);
    -- reminder_sends：提醒邮件的去重账本。一行是“这个账号的这条提醒（rkey = sha256(标签|文字)）、这个到期日、这一档（7、1、0 天前）已经处理过”。
    -- 主键保证同一档只会有一行：重启、两轮同时跑、两个进程一起跑，都只有先写进去的那一个发邮件。
    -- status：queued 已排进发件箱、sent 已发出、failed 重试到上限仍没发出、dropped 发之前已办完或已退订、skipped 错过了这一档（只记账不发）。
    CREATE TABLE IF NOT EXISTS reminder_sends (user_id TEXT NOT NULL, rkey TEXT NOT NULL, due TEXT NOT NULL, stage INTEGER NOT NULL, status TEXT NOT NULL, outbox_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (user_id, rkey, due, stage));
    CREATE INDEX IF NOT EXISTS reminder_outbox ON reminder_sends (outbox_id);
    CREATE INDEX IF NOT EXISTS outbox_due ON outbox (status, next_try_at);
    -- 下面几张表是服务商入驻用的（docs/TODO.md 第 7 条）。providers 表不加列，旧库打开后自动多出这几张表。
    -- provider_applications：入驻申请。status：pending 审核中、approved、rejected、changes_requested 要求修改、withdrawn 撤回。
    -- email 是验证过的联系邮箱（明文，发信要用），接口和管理员页面里都打码。登录番号的核对记录（方式、日期、核对人）存在这里，不进留痕。
    CREATE TABLE IF NOT EXISTS provider_applications (id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, status TEXT NOT NULL, category TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, license_no TEXT, license_body TEXT, fee_note TEXT, area TEXT, langs TEXT, fee_model TEXT NOT NULL, email TEXT NOT NULL, email_verified_at TEXT NOT NULL, terms_version TEXT NOT NULL, agreed_at TEXT NOT NULL, review_msg TEXT, license_check_method TEXT, license_check_note TEXT, license_checked_on TEXT, license_checked_by TEXT, decided_by TEXT, decided_at TEXT, provider_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS papp_email ON provider_applications (email);
    -- provider_meta：服务商的补充资料。source：apply 经申请批准、direct 管理员直接入驻（只有测试里开着）、legacy 这套机制之前就有的、legacy-hold 之前就有但资料没过检查（不展示、不收费）。
    CREATE TABLE IF NOT EXISTS provider_meta (provider_id TEXT PRIMARY KEY, source TEXT NOT NULL, application_id TEXT, address TEXT, license_body TEXT, terms_version TEXT, claimed_at TEXT);
    -- provider_contacts：服务商的联系邮箱（验证过），领取令牌、账单和新咨询通知用；不公开。unsub_token：通知邮件里的退订令牌。
    CREATE TABLE IF NOT EXISTS provider_contacts (provider_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, verified_at TEXT NOT NULL, notify_on INTEGER NOT NULL DEFAULT 1, unsub_token TEXT NOT NULL UNIQUE, bounced_at TEXT);
    -- invoices：展示费账单。金额只按价目表（src/billing.js 的 planFor），开票时的金额和价目表版本存在这一行里。status：issued、paid、void。
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, period TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, plan TEXT NOT NULL, amount_yen INTEGER NOT NULL, tax_yen INTEGER NOT NULL, plan_version TEXT NOT NULL, method TEXT NOT NULL, ref_code TEXT NOT NULL UNIQUE, status TEXT NOT NULL, issued_at TEXT NOT NULL, due_date TEXT NOT NULL, paid_on TEXT, paid_by TEXT, paid_note TEXT, void_reason TEXT);
    -- 同一家同一期只有一张有效的账单；作废的不算，作废后可以重新开
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_period ON invoices (provider_id, period) WHERE status<>'void';
    -- invoice_reminders：账单邮件的去重账本。stage：issued 开票、-7、-1、+1（过期第二天）、hidden（不再展示的告知）。
    CREATE TABLE IF NOT EXISTS invoice_reminders (invoice_id TEXT NOT NULL, stage TEXT NOT NULL, outbox_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (invoice_id, stage));
    -- provider_notices：新咨询通知。pending_since：还没通知的第一条新咨询的时间；win_start、win_end：排进发件箱的那一封统计的时间段。
    CREATE TABLE IF NOT EXISTS provider_notices (provider_id TEXT PRIMARY KEY, pending_since TEXT, last_sent_at TEXT, outbox_id TEXT, win_start TEXT, win_end TEXT);
  `);
  const now = () => new Date(clock()).toISOString();
  const isoOf = (ms) => new Date(ms).toISOString();
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const row = (u) => u && { id: u.id, createdAt: u.created_at, consentVersion: u.consent_version, profile: JSON.parse(u.profile), done: JSON.parse(u.done), plan: JSON.parse(u.plan), auth: JSON.parse(u.auth) };
  // 宽限天数（展示规则用），由 configureListing 设
  const listing = { graceDays: 7 };
  // 审核看到的版本：申请里会公开或会核对的内容加上状态和修改时间的哈希。批准、拒绝、要求修改都要带上它，
  // 管理员看完之后申请人又改过（哪怕时钟没走），就对不上，不会把核对记录记到没人看过的登录番号上。
  const reviewKeyOf = (a) => hash(JSON.stringify([a.status, a.category, a.name, a.address, a.license_no, a.license_body, a.fee_note, a.area, a.langs, a.email, a.terms_version, a.updated_at])).slice(0, 16);
  const arow = (a) => !a ? null : { id: a.id, ref: a.ref, status: a.status, category: a.category, name: a.name, address: a.address, licenseNo: a.license_no || '', licenseBody: a.license_body || '', feeNote: a.fee_note || '', area: a.area || '', langs: a.langs || '', feeModel: a.fee_model, email: a.email, termsVersion: a.terms_version, agreedAt: a.agreed_at, reviewMsg: a.review_msg || '', licenseCheck: a.license_check_method ? { method: a.license_check_method, note: a.license_check_note || '', checkedOn: a.license_checked_on, checkedBy: a.license_checked_by } : null, decidedBy: a.decided_by, decidedAt: a.decided_at, providerId: a.provider_id, createdAt: a.created_at, updatedAt: a.updated_at, reviewKey: reviewKeyOf(a) };
  const irow = (i) => !i ? null : { id: i.id, providerId: i.provider_id, period: i.period, periodStart: i.period_start, periodEnd: i.period_end, plan: i.plan, amountYen: i.amount_yen, taxYen: i.tax_yen, planVersion: i.plan_version, method: i.method, refCode: i.ref_code, status: i.status, issuedAt: i.issued_at, dueDate: i.due_date, paidOn: i.paid_on, paidBy: i.paid_by, paidNote: i.paid_note || '', voidReason: i.void_reason || '' };
  const prow = (p) => p && { id: p.id, name: p.name, category: p.category, area: p.area || '', langs: p.langs || '', feeNote: p.fee_note || '', licenseNo: p.license_no || '', feeModel: p.fee_model, active: !!p.active };
  const log = (userId, action, detail) => db.prepare('INSERT INTO audit (at,user_id,action,detail) VALUES (?,?,?,?)').run(now(), userId || null, action, detail ? JSON.stringify(detail) : null);
  // 限流记录里按这个值（账号、邮箱）记的全部删掉。bucket 是“前缀:哈希”或“前缀:哈希:哈希”
  // 原邮箱的确认（见 createProof）。findProof 只查，useProof 查到就用掉（要在事务里调）。
  const findProof = (userId, action, token, email) => {
    if (typeof token !== 'string' || !token || token.length > 100 || !['change', 'remove'].includes(action)) return null;
    return db.prepare('SELECT id FROM email_challenges WHERE code_hash=? AND purpose=? AND user_id=? AND email=? AND used_at IS NULL AND expires_at>?')
      .get(hash('proof:' + token), 'ok-' + action, userId, email, isoOf(clock())) || null;
  };
  const useProof = (userId, action, token, email) => {
    const r = findProof(userId, action, token, email);
    return !!r && db.prepare('UPDATE email_challenges SET used_at=? WHERE id=? AND used_at IS NULL').run(now(), r.id).changes === 1;
  };
  const dropRate = (v) => db.prepare("DELETE FROM rate_events WHERE bucket LIKE '%:' || ? || '%'").run(hash(v));
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
        db.prepare('DELETE FROM email_challenges WHERE user_id=?').run(id);
        db.prepare('DELETE FROM outbox WHERE user_id=?').run(id);
        // 按地址删的只在有地址时做：发完或不用发的邮件记录地址是空的，不能因为这个账号没绑邮箱就把别人的记录一起删掉
        if (addr) {
          db.prepare('DELETE FROM email_challenges WHERE email=?').run(addr);
          db.prepare('DELETE FROM outbox WHERE to_addr=?').run(addr);
        }
        db.prepare('DELETE FROM user_emails WHERE user_id=?').run(id);
        db.prepare('DELETE FROM reminder_sends WHERE user_id=?').run(id);
        for (const v of [id].concat(addr ? [addr] : [])) dropRate(v);
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
    // 发请求的这个令牌是怎么来的：{ via: 'signup' 或 'recover', createdAt }。对不上返回 null。
    sessionOf(userId, token) {
      const u = db.prepare('SELECT token_hash, created_at FROM users WHERE id=?').get(userId);
      if (!u || typeof token !== 'string') return null;
      const h = hash(token);
      if (same(u.token_hash, h)) return { via: 'signup', createdAt: u.created_at };
      const s = db.prepare('SELECT via, created_at FROM sessions WHERE token_hash=? AND user_id=?').get(h, userId);
      return s ? { via: s.via, createdAt: s.created_at } : null;
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
    // notice：{ subject, body }，换了邮箱时发给原来那个邮箱的告知（不传就不发）。
    // proof：账号上已经绑着邮箱时必须有，是原来的邮箱验证过“更换”之后拿到的确认（createProof），在同一个事务里用掉；
    //   没有、不对、过期、用过、不是这个账号或不是现在这个邮箱的，返回 false，什么都不改。
    bindEmail(userId, email, consentVersion, notice, proof) {
      const owner = this.userByEmail(email);
      if (owner && owner !== userId) return false;
      return this.tx(() => {
        const old = db.prepare('SELECT email FROM user_emails WHERE user_id=?').get(userId);
        if (old && !useProof(userId, 'change', proof, old.email)) return false;
        if (old && old.email !== email) this.forgetAddress(userId, old.email, notice);
        if (old && old.email === email) db.prepare('UPDATE user_emails SET verified_at=?, consent_version=? WHERE user_id=?').run(now(), consentVersion, userId); // 同一个邮箱再验证一次：其他设置不动
        else {
          db.prepare('DELETE FROM user_emails WHERE user_id=?').run(userId);
          db.prepare('INSERT INTO user_emails VALUES (?,?,?,?,?,?,?)').run(userId, email, now(), consentVersion, null, newToken(), null);
        }
        log(userId, 'email.bind');
        return true;
      });
    },
    // 一个邮箱不再属于这个账号（换绑、解除）时清理：验证码、发完的邮件记录、按它记的限流次数都删掉，排着队的提醒邮件不发。
    // 还没发出去的通知（例如“有新设备登录”）照发，再加一封 notice 告知“邮箱已更换或解除”：
    // 这几封记为 last，发出或放弃后立即清掉地址和正文。原来的邮箱因此一定会收到消息，不会被人悄悄换掉。
    forgetAddress(userId, addr, notice) {
      db.prepare('DELETE FROM email_challenges WHERE email=?').run(addr);
      this.dropReminderMails(userId, '邮箱已更换或解除');
      db.prepare("DELETE FROM outbox WHERE to_addr=? AND (status<>'queued' OR kind='code')").run(addr);
      db.prepare("UPDATE outbox SET kind='last' WHERE to_addr=? AND status='queued'").run(addr);
      if (notice) {
        db.prepare('INSERT INTO outbox (id,user_id,kind,to_addr,subject,body,headers,status,tries,next_try_at,last_error,created_at,sent_at) VALUES (?,?,?,?,?,?,NULL,?,0,?,NULL,?,NULL)')
          .run(crypto.randomUUID(), userId, 'last', addr, notice.subject, notice.body, 'queued', now(), now());
      }
      dropRate(addr);
    },
    // 解除绑定：邮箱、没用完的验证码、发给这个邮箱的邮件记录一并删掉（最后一封告知发出后也清掉）。账号还在。
    // proof：原来的邮箱验证过“解除”之后拿到的确认，在同一个事务里用掉。绑着邮箱而确认不对时返回 false，什么都不改。
    removeEmail(userId, notice, proof) {
      return this.tx(() => {
        const old = db.prepare('SELECT email FROM user_emails WHERE user_id=?').get(userId);
        if (old && !useProof(userId, 'remove', proof, old.email)) return false;
        db.prepare('DELETE FROM email_challenges WHERE user_id=?').run(userId); // 这个账号正在绑定别的邮箱的验证码也作废
        if (!old) return false;
        this.forgetAddress(userId, old.email, notice);
        db.prepare("DELETE FROM outbox WHERE user_id=? AND kind='code'").run(userId);
        db.prepare('DELETE FROM user_emails WHERE user_id=?').run(userId);
        log(userId, 'email.remove');
        return true;
      });
    },
    // ---- 提醒邮件：开关、退订、去重账本 ----
    // 打开或关掉提醒邮件。没有绑定邮箱时返回 false。
    setRemindOptIn(userId, on) {
      const r = db.prepare('UPDATE user_emails SET remind_opt_in_at=? WHERE user_id=?').run(on ? now() : null, userId);
      if (r.changes !== 1) return false;
      // 关掉时，还在排队的提醒邮件不再发
      if (!on) this.dropReminderMails(userId, '已关闭提醒');
      log(userId, 'email.remind', { on: !!on });
      return true;
    },
    // 凭邮件里的退订令牌关掉提醒，不用登录。令牌不存在、已经关掉的，什么都不改；返回有没有改动（接口不把它告诉对方）。
    unsubscribeByToken(token) {
      const r = typeof token === 'string' && token ? db.prepare('SELECT user_id FROM user_emails WHERE unsub_token=? AND remind_opt_in_at IS NOT NULL').get(token) : null;
      if (!r) return false;
      return this.tx(() => {
        db.prepare('UPDATE user_emails SET remind_opt_in_at=NULL WHERE user_id=?').run(r.user_id);
        this.dropReminderMails(r.user_id, '已退订');
        log(r.user_id, 'email.unsubscribe');
        return true;
      });
    },
    // 定时任务用：同意收提醒、邮箱没有退信的账号
    remindableUsers() { return db.prepare('SELECT user_id FROM user_emails WHERE remind_opt_in_at IS NOT NULL AND bounced_at IS NULL').all().map((r) => r.user_id); },
    // 发提醒邮件要用的收件信息。没开提醒、退信了的返回 null。
    remindTarget(userId) {
      const r = db.prepare('SELECT email, unsub_token FROM user_emails WHERE user_id=? AND remind_opt_in_at IS NOT NULL AND bounced_at IS NULL').get(userId);
      return r ? { email: r.email, unsubToken: r.unsub_token } : null;
    },
    // 占下“这条提醒、这个到期日、这一档”。占到了返回 true（只有这一次会是 true），已经有人占过返回 false。
    claimReminder(userId, rkey, due, stage, status) {
      return db.prepare('INSERT OR IGNORE INTO reminder_sends (user_id,rkey,due,stage,status,outbox_id,created_at) VALUES (?,?,?,?,?,NULL,?)').run(userId, rkey, due, stage, status, now()).changes === 1;
    },
    // 把刚占下的几条记到同一封邮件名下
    attachReminders(userId, items, outboxId) {
      for (const it of items) db.prepare("UPDATE reminder_sends SET outbox_id=? WHERE user_id=? AND rkey=? AND due=? AND stage=?").run(outboxId, userId, it.rkey, it.due, it.stage);
    },
    // 一封提醒邮件里有哪几条
    remindersOfMail(outboxId) { return db.prepare('SELECT rkey, due, stage FROM reminder_sends WHERE outbox_id=?').all(outboxId); },
    // 账本（测试和排查用）
    listReminderSends(userId) { return db.prepare('SELECT rkey, due, stage, status, outbox_id AS outboxId FROM reminder_sends WHERE user_id=? ORDER BY due, stage DESC, rkey').all(userId); },
    // 用户关掉提醒、退订、换掉或解除邮箱：还在排队的提醒邮件不发了，清掉正文和地址，记为 dropped。
    // 账本里这几条（从没发出去过）直接删掉，不记成 dropped：用户马上又打开提醒的话，这一档还能重新排上，不会白白少一封。
    dropReminderMails(userId, why) {
      for (const r of db.prepare("SELECT id FROM outbox WHERE user_id=? AND kind='reminder' AND status='queued'").all(userId)) {
        db.prepare("DELETE FROM reminder_sends WHERE outbox_id=? AND status='queued'").run(r.id);
        this.dropMail(r.id, why);
      }
    },
    // ---- 验证码 ----
    // code 为空时存一个谁也猜不到的哈希：这行验证码永远验不过（邮箱没绑定过、或已绑在别的账号上时用）。
    // purpose：bind（绑定新邮箱）、recover（找回）、old-change / old-remove（更换、解除之前验证原来的邮箱）。
    // 重新发送时作废旧验证码，只限“同一个账号发起的同一种”（绑定、验证原邮箱）。找回是不登录的，谁都能对着一个邮箱点“发送”：
    // 要是新的一发就作废旧的，知道邮箱的人就能让本人手里的验证码一直失效。所以找回的验证码各自有效到过期或用掉（一个邮箱能同时有几个，由发送的限流管住）。
    createChallenge(c, ttlMs) {
      const id = crypto.randomUUID(), t = clock();
      if (!UNAUTH_PURPOSES.has(c.purpose) && c.userId) db.prepare('UPDATE email_challenges SET used_at=? WHERE used_at IS NULL AND purpose=? AND user_id=?').run(isoOf(t), c.purpose, c.userId);
      db.prepare('INSERT INTO email_challenges (id,purpose,user_id,email,code_hash,attempts,expires_at,used_at,created_at) VALUES (?,?,?,?,?,0,?,NULL,?)')
        .run(id, c.purpose, c.userId || null, c.email, hash(id + ':' + (c.code || newToken())), isoOf(t + ttlMs), isoOf(t));
      return id;
    },
    // 核对验证码。对了返回 { userId, email } 并作废这一行；其余情况（没有这一行、用途不对、不是这个账号的、过期、用过、错满次数、验证码不对）一律返回 null。
    // 每次核对先记一次尝试，再比较，所以同时发来的多个请求也超不过次数。次数记在这一行验证码上：别人不知道这一行的 id，耗不掉它的次数。
    verifyChallenge(id, purpose, code, userId) {
      const t = isoOf(clock());
      const hit = db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=? AND purpose=? AND used_at IS NULL AND expires_at>? AND attempts<?').run(String(id), purpose, t, MAX_ATTEMPTS).changes === 1;
      const c = db.prepare('SELECT user_id, email, code_hash FROM email_challenges WHERE id=?').get(String(id));
      // 没有这一行时也做一次同样的比较
      const ok = same(c ? c.code_hash : hash('none'), hash(String(id) + ':' + String(code)));
      if (!hit || !c || !ok) return null;
      if (!UNAUTH_PURPOSES.has(purpose) && c.user_id !== userId) return null; // 绑定、验证原邮箱：只能是发起的那个账号
      if (db.prepare('UPDATE email_challenges SET used_at=? WHERE id=? AND used_at IS NULL').run(t, String(id)).changes !== 1) return null;
      // 用掉一个之后，同一用途、同一邮箱（绑定时还要同一账号）其余没用的一并作废
      db.prepare("UPDATE email_challenges SET used_at=? WHERE used_at IS NULL AND purpose=? AND email=? AND (purpose IN ('recover','papply','pclaim') OR user_id=?)").run(t, purpose, c.email, c.user_id || '');
      return { userId: c.user_id, email: c.email };
    },
    // ---- 原邮箱的确认 ----
    // 原来的邮箱验证过之后发一个确认（32 字节随机，只返回这一次，库里存哈希），存在验证码表里，purpose 是 ok-change 或 ok-remove。
    // 凭它才能更换（action 'change'）或解除（'remove'）现在这个邮箱；只能用一次，ttlMs 后失效。邮箱换掉、解除、账号删掉时随验证码一起删。
    createProof(userId, email, action, ttlMs) {
      const token = newToken(), t = clock();
      return this.tx(() => {
        db.prepare('UPDATE email_challenges SET used_at=? WHERE used_at IS NULL AND purpose=? AND user_id=?').run(isoOf(t), 'ok-' + action, userId);
        db.prepare('INSERT INTO email_challenges (id,purpose,user_id,email,code_hash,attempts,expires_at,used_at,created_at) VALUES (?,?,?,?,?,0,?,NULL,?)')
          .run(crypto.randomUUID(), 'ok-' + action, userId, email, hash('proof:' + token), isoOf(t + ttlMs), isoOf(t));
        log(userId, 'email.confirm', { action });
        return token;
      });
    },
    // 确认还能不能用（不用掉）：是这个账号的、这种操作的、没过期、没用过，而且验证的就是账号现在绑着的邮箱。
    proofOk(userId, action, token) {
      const cur = db.prepare('SELECT email FROM user_emails WHERE user_id=?').get(userId);
      return !!cur && !!findProof(userId, action, token, cur.email);
    },
    // ---- 入驻申请的确认 ----
    // 用 papply 验证码验证过申请人的邮箱之后发一个确认（32 字节随机，只返回这一次，库里存哈希），凭它查看、修改（要求修改时）、撤回这一份申请。
    // ttlMs 内可以用多次（改完再撤回不用再收一次验证码）；存在验证码表里，purpose 是 ok-papply。
    createApplyProof(appId, email, ttlMs) {
      const token = newToken(), t = clock();
      db.prepare('INSERT INTO email_challenges (id,purpose,user_id,email,code_hash,attempts,expires_at,used_at,created_at) VALUES (?,?,?,?,?,0,?,NULL,?)')
        .run(crypto.randomUUID(), 'ok-papply', appId, email, hash('proof:' + token), isoOf(t + ttlMs), isoOf(t));
      return token;
    },
    applyProofOk(appId, token) {
      if (typeof token !== 'string' || !token || token.length > 100) return false;
      const a = db.prepare('SELECT email FROM provider_applications WHERE id=?').get(String(appId));
      return !!a && !!db.prepare("SELECT 1 FROM email_challenges WHERE code_hash=? AND purpose='ok-papply' AND user_id=? AND email=? AND expires_at>?").get(hash('proof:' + token), String(appId), a.email, isoOf(clock()));
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
    // 几个值各自哈希后用冒号连起来（例如 来源地址 + 邮箱）；删除账号、解除邮箱时按其中一段找出来删掉
    rateKey(prefix, ...values) { return prefix + ':' + values.map((v) => hash(String(v))).join(':'); },
    // ---- 发件箱 ----
    enqueueMail(m) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO outbox (id,user_id,kind,to_addr,subject,body,headers,status,tries,next_try_at,last_error,created_at,sent_at) VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?,NULL)')
        .run(id, m.userId || null, m.kind, m.to, m.subject, m.body, m.headers ? JSON.stringify(m.headers) : null, 'queued', now(), now());
      return id;
    },
    // 不是邮件的占位行。找回账号时邮箱没绑定过就不发邮件，但发邮件那一步要写几次库、会占住进程几毫秒，
    // 外面的人紧跟着再发一个请求就能量出来“这个邮箱绑定过”。所以没绑定过时也排一行占位，发送那一步对它做同样多的读写，然后删掉。
    enqueuePad() {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO outbox (id,user_id,kind,to_addr,subject,body,headers,status,tries,next_try_at,last_error,created_at,sent_at) VALUES (?,?,?,?,?,?,?,?,0,?,NULL,?,NULL)')
        .run(id, null, 'pad', '', '', '', null, 'queued', now(), now());
      return id;
    },
    finishPad(id) {
      this.tx(() => {
        db.prepare('SELECT kind FROM outbox WHERE id=?').get(id);
        db.prepare("DELETE FROM outbox WHERE id=? AND kind='pad'").run(id);
        db.prepare("UPDATE reminder_sends SET status='sent' WHERE outbox_id=?").run(id);
      });
    },
    // 验证码过期以后，还没发出去的验证码邮件不再发：记为 dropped，清掉正文和地址
    dropStaleCodes() {
      db.prepare("UPDATE outbox SET status='dropped', next_try_at=NULL, body='', to_addr='', headers=NULL, last_error='验证码已过期' WHERE kind='code' AND status='queued' AND created_at<=?").run(isoOf(clock() - CODE_TTL_MS));
    },
    // 取出一封到时间该发的邮件（没有就返回 null），并把它的下次重试时间先推后 leaseMs（默认 10 分钟，要比发一封最慢的情况长）。
    // 一封一封地占：占下之后马上就发，所以这一轮发得再久，排在后面的邮件也不会因为“占得太久”被另一个进程再发一遍；
    // 发到一半进程退出的，过了这段时间会再试。
    claimNext(leaseMs) {
      this.dropStaleCodes();
      const t = now(), later = isoOf(clock() + (leaseMs || 10 * 60 * 1000));
      for (;;) {
        const r = db.prepare("SELECT id, user_id AS userId, kind, to_addr AS \"to\", subject, body, headers FROM outbox WHERE status='queued' AND next_try_at<=? ORDER BY next_try_at, created_at, rowid LIMIT 1").get(t);
        if (!r) return null;
        // 别的进程刚好先占了这一封：再取下一封
        if (db.prepare("UPDATE outbox SET next_try_at=? WHERE id=? AND status='queued' AND next_try_at<=?").run(later, r.id, t).changes === 1) return Object.assign(r, { headers: r.headers ? JSON.parse(r.headers) : null });
      }
    },
    // blankCode：真实发信时，验证码邮件发完就把正文和收件地址清掉。发给已换掉的邮箱的最后一封（last）不管哪种发件方式都清。
    markSent(id, blankCode) {
      this.tx(() => {
        const r = db.prepare('SELECT kind FROM outbox WHERE id=?').get(id);
        const blank = r && (r.kind === 'last' || (blankCode && r.kind === 'code'));
        db.prepare("UPDATE outbox SET status='sent', sent_at=?, tries=tries+1, next_try_at=NULL, last_error=NULL" + (blank ? ", body='', to_addr=''" : '') + ' WHERE id=?').run(now(), id);
        db.prepare("UPDATE reminder_sends SET status='sent' WHERE outbox_id=?").run(id);
      });
    },
    // 发之前发现不该发了（已办完、已退订、邮箱换了）：不发，清掉正文和地址，只留一条记录
    dropMail(id, why) {
      db.prepare("UPDATE outbox SET status='dropped', next_try_at=NULL, body='', to_addr='', headers=NULL, last_error=? WHERE id=? AND status='queued'").run(String(why || '').slice(0, 300), id);
      db.prepare("UPDATE reminder_sends SET status='dropped' WHERE outbox_id=? AND status='queued'").run(id);
    },
    // 发之前按最新情况重写了标题和正文
    updateMail(id, m) { db.prepare('UPDATE outbox SET subject=?, body=?, headers=? WHERE id=?').run(m.subject, m.body, m.headers ? JSON.stringify(m.headers) : null, id); },
    // 发送失败：1 分钟、5 分钟、30 分钟、2 小时、12 小时后各重试一次，第 5 次重试还失败就记为 failed，不再发
    markFailed(id, err) {
      const r = db.prepare('SELECT tries, kind FROM outbox WHERE id=?').get(id); if (!r) return;
      const tries = r.tries + 1, giveUp = tries > BACKOFF_MIN.length;
      db.prepare('UPDATE outbox SET status=?, tries=?, next_try_at=?, last_error=? WHERE id=?').run(giveUp ? 'failed' : 'queued', tries, giveUp ? null : isoOf(clock() + BACKOFF_MIN[tries - 1] * 60 * 1000), String(err).slice(0, 300), id);
      if (giveUp) db.prepare("UPDATE reminder_sends SET status='failed' WHERE outbox_id=?").run(id);
      // 放弃的验证码邮件、发给已换掉的邮箱的最后一封：地址和正文不留
      if (giveUp && (r.kind === 'code' || r.kind === 'last')) db.prepare("UPDATE outbox SET body='', to_addr='', headers=NULL WHERE id=?").run(id);
    },
    // 测试、本地开发和运维排查用。f：{ status, to }
    listOutbox(f) {
      f = f || {};
      return db.prepare('SELECT id, user_id AS userId, kind, to_addr AS "to", subject, body, headers, status, tries, next_try_at AS nextTryAt, last_error AS lastError, created_at AS createdAt, sent_at AS sentAt FROM outbox WHERE kind<>\'pad\' ORDER BY created_at, rowid').all()
        .filter((r) => (!f.status || r.status === f.status) && (!f.to || r.to === f.to)).map((r) => Object.assign(r, { headers: r.headers ? JSON.parse(r.headers) : null }));
    },
    // 定期清理：验证码过期 24 小时后删掉；限流记录留 24 小时；验证码邮件的正文 1 小时后清空（还在排队的不清空，过期就整封不发了）；
    // 发完或失败的邮件 30 天后清掉正文和收件地址，只留“发过一封什么类型的邮件”。
    purgeExpired() {
      const t = clock();
      db.prepare('DELETE FROM email_challenges WHERE expires_at<?').run(isoOf(t - DAY));
      db.prepare('DELETE FROM rate_events WHERE at<?').run(t - DAY);
      this.dropStaleCodes();
      db.prepare("UPDATE outbox SET body='' WHERE kind='code' AND status<>'queued' AND body<>'' AND created_at<?").run(isoOf(t - 60 * 60 * 1000));
      db.prepare("UPDATE outbox SET body='', to_addr='', headers=NULL WHERE status<>'queued' AND to_addr<>'' AND created_at<?").run(isoOf(t - 30 * DAY));
      // 被拒绝、撤回的入驻申请 90 天后整行删掉（邮箱、地址、理由都不留）
      db.prepare("DELETE FROM provider_applications WHERE status IN ('rejected','withdrawn') AND updated_at<?").run(isoOf(t - 90 * DAY));
    },
    // 测试用：每张新表里和这个账号、这个邮箱有关的行数
    emailFootprint(userId, email) {
      const n = (sql, ...a) => db.prepare(sql).get(...a).n;
      return {
        sessions: n('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', userId),
        emails: n('SELECT COUNT(*) AS n FROM user_emails WHERE user_id=? OR email=?', userId, email || ''),
        challenges: n('SELECT COUNT(*) AS n FROM email_challenges WHERE user_id=? OR email=?', userId, email || ''),
        outbox: n('SELECT COUNT(*) AS n FROM outbox WHERE user_id=? OR to_addr=?', userId, email || ''),
        reminders: n('SELECT COUNT(*) AS n FROM reminder_sends WHERE user_id=?', userId),
        rate: n("SELECT COUNT(*) AS n FROM rate_events WHERE bucket LIKE '%:' || ? || '%' OR bucket LIKE '%:' || ? || '%'", hash(userId), hash(email || '\0'))
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
    // 管理员直接入驻（只有 createApp({ allowDirectProvider: true }) 时接口才开，测试和端到端用）。会返回令牌，所以正式环境不开。
    // source 记为 direct：不收展示费、在架就展示。
    createProvider(p) {
      const id = crypto.randomUUID(), token = newToken();
      this.tx(() => {
        db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, hash(token), p.name, p.category, p.area || null, p.langs || null, p.feeNote || null, p.licenseNo || null, p.feeModel, 1, now());
        db.prepare('INSERT INTO provider_meta (provider_id,source,application_id,address,license_body,terms_version,claimed_at) VALUES (?,?,?,?,?,?,?)').run(id, 'direct', null, p.address || null, p.licenseBody || null, null, now());
        log(null, 'provider.create', { id, category: p.category });
      });
      return Object.assign(this.getProvider(id), { token });
    },
    getProvider(id) { return prow(db.prepare('SELECT * FROM providers WHERE id=?').get(id)); },
    providerByToken(token) { return typeof token === 'string' && token ? prow(db.prepare('SELECT * FROM providers WHERE token_hash=? AND active=1').get(hash(token))) : null; },
    providerMeta(id) {
      const m = db.prepare('SELECT * FROM provider_meta WHERE provider_id=?').get(id);
      return m ? { source: m.source, applicationId: m.application_id, address: m.address || '', licenseBody: m.license_body || '', termsVersion: m.terms_version, claimedAt: m.claimed_at } : null;
    },
    // 展示规则：在架（active=1），并且 direct（不收费），或者今天落在一段“已付款的覆盖”里。
    // 覆盖按账单的期间先后接起来（作废的不算）：
    // - 已付款的一张：接得上前一段（开始日不晚于前一段结束的第二天）就把这段延到它的 本期结束 + 宽限天数，接不上就另起一段。
    //   所以下架再上架、作废了中间一期、拖欠了几期之后，只要付了当期，当期就展示，不会被以前的旧覆盖挡住。
    // - 已开出还没付的一张：只能接在已付款的一段后面，把这段延到它的 付款期限 + 宽限天数（期限没过就不因为它下架；
    //   和 src/billing.js 发“不再展示”告知的条件 付款期限 + 宽限天数 < 今天 一致）。没有付过款的那一段不展示。
    // legacy-hold（老服务商迁移时资料没过检查）不展示；经申请批准、还没领取令牌的不展示。
    // 首月免费（src/billing.js 的 firstInvoice）记成一张金额 0 的已付款记录，所以按同一套规则算：批准当月结束 + 宽限天数。
    // 宽限天数由 configureListing 设（src/billing.js 按 BILLING_GRACE_DAYS 设好），默认 7。返回 { listed, listedUntil }，listedUntil 是展示到哪一天（direct 为 null）。
    configureListing(cfg) { if (cfg && Number.isInteger(cfg.graceDays)) listing.graceDays = cfg.graceDays; },
    providerListing(id, today) {
      today = today || jstToday(clock());
      const p = db.prepare('SELECT p.active, m.source, m.claimed_at FROM providers p LEFT JOIN provider_meta m ON m.provider_id=p.id WHERE p.id=?').get(id);
      if (!p) return { listed: false, listedUntil: null };
      if (p.source === 'direct') return { listed: !!p.active, listedUntil: null };
      if (p.source === 'legacy-hold') return { listed: false, listedUntil: null };
      // 经申请批准的：领取令牌之前看不到咨询，不展示（首月免费的覆盖也要等领取之后）
      if (p.source === 'apply' && !p.claimed_at) return { listed: false, listedUntil: null };
      const g = listing.graceDays, runs = [];
      let cur = null; // { from, until }
      for (const inv of db.prepare("SELECT period_start, period_end, due_date, status FROM invoices WHERE provider_id=? AND status IN ('paid','issued') ORDER BY period_start").all(id)) {
        const joins = cur && inv.period_start <= addDays(cur.until, 1);
        if (inv.status === 'paid') {
          const e = addDays(inv.period_end, g);
          if (joins) { if (e > cur.until) cur.until = e; } else { cur = { from: inv.period_start, until: e }; runs.push(cur); }
        } else if (joins) {
          const e = addDays(inv.due_date, g);
          if (e > cur.until) cur.until = e;
        }
      }
      const hit = runs.find((r) => r.from <= today && today <= r.until);
      return { listed: !!p.active && !!hit, listedUntil: hit ? hit.until : null };
    },
    // 公开名单：按展示规则过滤，排列按入驻先后
    listProviders(category, today) {
      const rows = category ? db.prepare('SELECT * FROM providers WHERE active=1 AND category=? ORDER BY created_at, rowid').all(category) : db.prepare('SELECT * FROM providers WHERE active=1 ORDER BY created_at, rowid').all();
      return rows.filter((r) => this.providerListing(r.id, today).listed).map((r) => Object.assign(prow(r), (({ address, licenseBody }) => ({ address, licenseBody }))(this.providerMeta(r.id) || { address: '', licenseBody: '' })));
    },
    // 管理员看的全部服务商（含下架的）
    listAllProviders() { return db.prepare('SELECT * FROM providers ORDER BY created_at, rowid').all().map(prow); },
    // 上架或下架。下架时换掉令牌（谁也用不了的值），重新上架后要重新领取；还在排队的新咨询通知和账单邮件不再发。
    setProviderActive(id, on) {
      this.tx(() => {
        db.prepare('UPDATE providers SET active=? WHERE id=?').run(on ? 1 : 0, id);
        if (!on) {
          db.prepare('UPDATE providers SET token_hash=? WHERE id=?').run('revoked:' + newToken(), id);
          this.dropProviderMails(id, '服务商已下架');
          db.prepare('UPDATE provider_notices SET pending_since=NULL WHERE provider_id=?').run(id);
          log(null, 'provider.revoke', { id });
        }
        log(null, 'provider.active', { id, on: !!on });
      });
    },
    // 发给这家服务商、还在排队的新咨询通知（pnotice）和账单邮件（billing）不再发
    dropProviderMails(id, why) {
      const c = db.prepare('SELECT email FROM provider_contacts WHERE provider_id=?').get(id);
      if (!c) return;
      for (const r of db.prepare("SELECT id FROM outbox WHERE to_addr=? AND kind IN ('pnotice','billing') AND status='queued'").all(c.email)) this.dropMail(r.id, why);
    },
    // ---- 入驻申请 ----
    // a：validateApplication 整理好的字段，加上 email、termsVersion。返回 { id, ref }。
    createApplication(a) {
      const id = crypto.randomUUID(), ref = 'A' + safeCode(7), t = now();
      db.prepare('INSERT INTO provider_applications (id,ref,status,category,name,address,license_no,license_body,fee_note,area,langs,fee_model,email,email_verified_at,terms_version,agreed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, ref, 'pending', a.category, a.name, a.address, a.licenseNo || null, a.licenseBody || null, a.feeNote || null, a.area || null, a.langs || null, a.feeModel, a.email, t, a.termsVersion, t, t, t);
      log(null, 'papply.submit', { id, category: a.category });
      return { id, ref };
    },
    getApplication(id) { return arow(db.prepare('SELECT * FROM provider_applications WHERE id=?').get(String(id))); },
    applicationByRef(ref) { return arow(db.prepare('SELECT * FROM provider_applications WHERE ref=?').get(String(ref))); },
    // 这个邮箱最近的一份申请（查看或修改申请用）
    latestApplicationByEmail(email) { return arow(db.prepare('SELECT * FROM provider_applications WHERE email=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(email)); },
    // 这个邮箱有没有还在审核中（pending）或等着修改（changes_requested）的申请
    openApplicationByEmail(email) { return arow(db.prepare("SELECT * FROM provider_applications WHERE email=? AND status IN ('pending','changes_requested') LIMIT 1").get(email)); },
    // 这个邮箱是不是已经是某家服务商的联系邮箱
    providerByContact(email) { const r = db.prepare('SELECT provider_id FROM provider_contacts WHERE email=?').get(email); return r ? r.provider_id : null; },
    listApplications(status) {
      const rows = status ? db.prepare('SELECT * FROM provider_applications WHERE status=? ORDER BY created_at, rowid').all(status) : db.prepare('SELECT * FROM provider_applications ORDER BY created_at, rowid').all();
      return rows.map(arow);
    },
    // 要求修改后重新提交：只在 changes_requested 时能改，状态回到 pending。返回是否改成了。
    resubmitApplication(id, a, termsVersion) {
      const r = db.prepare("UPDATE provider_applications SET status='pending', category=?, name=?, address=?, license_no=?, license_body=?, fee_note=?, area=?, langs=?, fee_model=?, terms_version=?, agreed_at=?, updated_at=? WHERE id=? AND status='changes_requested'")
        .run(a.category, a.name, a.address, a.licenseNo || null, a.licenseBody || null, a.feeNote || null, a.area || null, a.langs || null, a.feeModel, termsVersion, now(), now(), id);
      if (r.changes === 1) log(null, 'papply.resubmit', { id });
      return r.changes === 1;
    },
    withdrawApplication(id) {
      const r = db.prepare("UPDATE provider_applications SET status='withdrawn', updated_at=?, decided_at=? WHERE id=? AND status IN ('pending','changes_requested')").run(now(), now(), id);
      if (r.changes === 1) log(null, 'papply.withdraw', { id });
      return r.changes === 1;
    },
    // 拒绝（rejected）或要求修改（changes_requested）。只能从 pending 改。理由存在申请里（发邮件要用），不进留痕。
    // notice：{ to, subject, body }，同一个事务里排进发件箱。
    // key：管理员看到的 reviewKey，和库里的对不上时不改，返回 false。
    decideApplication(id, status, by, msg, notice, key) {
      return this.tx(() => {
        const a = db.prepare("SELECT * FROM provider_applications WHERE id=? AND status='pending'").get(id);
        if (!a || reviewKeyOf(a) !== key) return false;
        const r = db.prepare("UPDATE provider_applications SET status=?, review_msg=?, decided_by=?, decided_at=?, updated_at=? WHERE id=? AND status='pending'").run(status, msg, by, now(), now(), id);
        if (r.changes !== 1) return false;
        if (notice) this.enqueueMail({ kind: 'notice', to: notice.to, subject: notice.subject, body: notice.body });
        log(null, status === 'rejected' ? 'papply.reject' : 'papply.changes', { id, by });
        return true;
      });
    },
    // 批准：一个事务里建服务商（不发令牌：token_hash 是谁也用不了的 unclaimed:随机值，用联系邮箱领取）、补充资料、联系邮箱和首月免费的覆盖记录，
    // 再排一封批准邮件。check：{ method, checkedOn, note } 登录番号的核对记录。invoice：billing.firstInvoice 算好的首月免费记录。mail(inv)：返回 { subject, body }。
    // 只能从 pending 批准；key（管理员看到的 reviewKey）对不上、联系邮箱已经是别家服务商的时返回 null。返回 { providerId, freeUntil }（免费到哪一天，批准当月的最后一天）。
    approveApplication(id, by, check, invoice, mail, key) {
      return this.tx(() => {
        const a = db.prepare("SELECT * FROM provider_applications WHERE id=? AND status='pending'").get(id);
        if (!a || reviewKeyOf(a) !== key || db.prepare('SELECT 1 FROM provider_contacts WHERE email=?').get(a.email)) return null;
        const pid = crypto.randomUUID(), t = now();
        db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(pid, 'unclaimed:' + newToken(), a.name, a.category, a.area, a.langs, a.fee_note, a.license_no, a.fee_model, 1, t);
        db.prepare('INSERT INTO provider_meta (provider_id,source,application_id,address,license_body,terms_version,claimed_at) VALUES (?,?,?,?,?,?,NULL)').run(pid, 'apply', id, a.address, a.license_body, a.terms_version);
        db.prepare('INSERT INTO provider_contacts (provider_id,email,verified_at,notify_on,unsub_token,bounced_at) VALUES (?,?,?,1,?,NULL)').run(pid, a.email, a.email_verified_at, newToken());
        db.prepare("UPDATE provider_applications SET status='approved', provider_id=?, license_check_method=?, license_check_note=?, license_checked_on=?, license_checked_by=?, decided_by=?, decided_at=?, updated_at=? WHERE id=?")
          .run(pid, check ? check.method : null, check ? check.note || null : null, check ? check.checkedOn : null, check ? by : null, by, t, t, id);
        const inv = this.createInvoice(Object.assign({}, invoice, { providerId: pid }));
        const m = mail(this.getInvoice(inv));
        this.enqueueMail({ kind: 'notice', to: a.email, subject: m.subject, body: m.body });
        log(null, 'papply.approve', { id, providerId: pid, by, method: check ? check.method : null });
        return { providerId: pid, freeUntil: invoice.periodEnd };
      });
    },
    // ---- 服务商的联系邮箱和令牌 ----
    providerContact(id) {
      const c = db.prepare('SELECT email, notify_on, unsub_token, bounced_at FROM provider_contacts WHERE provider_id=?').get(id);
      return c ? { email: c.email, notify: !!c.notify_on, unsubToken: c.unsub_token, bounced: !!c.bounced_at } : null;
    },
    // 能用联系邮箱领取令牌的服务商：经申请批准、在架、联系邮箱是这个。没有返回 null。
    claimableProviderByEmail(email) {
      const r = db.prepare("SELECT p.id FROM provider_contacts c JOIN providers p ON p.id=c.provider_id JOIN provider_meta m ON m.provider_id=p.id WHERE c.email=? AND p.active=1 AND m.source='apply'").get(email);
      return r ? r.id : null;
    },
    // 发新令牌（只返回这一次，库里存哈希），旧令牌立即失效。notice：{ to, subject, body } 同一事务里排进发件箱。
    claimProviderToken(id, notice) {
      const token = newToken();
      this.tx(() => {
        db.prepare('UPDATE providers SET token_hash=? WHERE id=?').run(hash(token), id);
        db.prepare('UPDATE provider_meta SET claimed_at=? WHERE provider_id=?').run(now(), id);
        if (notice) this.enqueueMail({ kind: 'notice', to: notice.to, subject: notice.subject, body: notice.body });
        log(null, 'provider.claim', { id });
      });
      return token;
    },
    // 新咨询通知的开关。关掉时还在排队的通知不发。没有联系邮箱返回 false。
    setProviderNotify(id, on) {
      return this.tx(() => {
        const r = db.prepare('UPDATE provider_contacts SET notify_on=? WHERE provider_id=?').run(on ? 1 : 0, id);
        if (r.changes !== 1) return false;
        if (!on) {
          const c = db.prepare('SELECT email FROM provider_contacts WHERE provider_id=?').get(id);
          for (const m of db.prepare("SELECT id FROM outbox WHERE to_addr=? AND kind='pnotice' AND status='queued'").all(c.email)) this.dropMail(m.id, '已关闭新咨询通知');
          db.prepare('UPDATE provider_notices SET pending_since=NULL WHERE provider_id=?').run(id);
        }
        log(null, 'provider.notify', { id, on: !!on });
        return true;
      });
    },
    // 凭通知邮件里的退订令牌关掉新咨询通知。令牌不存在、已经关掉的什么都不改。
    providerUnsubscribe(token) {
      const r = typeof token === 'string' && token ? db.prepare('SELECT provider_id FROM provider_contacts WHERE unsub_token=? AND notify_on=1').get(token) : null;
      return r ? this.setProviderNotify(r.provider_id, false) : false;
    },
    // ---- 账单 ----
    // inv：{ providerId, period, periodStart, periodEnd, plan, amountYen, taxYen, planVersion, method, dueDate, status?, paidOn?, paidBy? }。
    // 同一家同一期只有一张有效的（作废的不算），已经有了返回 null。参考编号形如 ZN2612-7KQ4MX。
    createInvoice(inv) {
      const id = crypto.randomUUID();
      for (let i = 0; ; i++) {
        const ref = 'ZN' + inv.period.slice(2, 4) + inv.period.slice(5, 7) + '-' + safeCode(6);
        {
          const r = db.prepare('INSERT OR IGNORE INTO invoices (id,provider_id,period,period_start,period_end,plan,amount_yen,tax_yen,plan_version,method,ref_code,status,issued_at,due_date,paid_on,paid_by,paid_note,void_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)')
            .run(id, inv.providerId, inv.period, inv.periodStart, inv.periodEnd, inv.plan, inv.amountYen, inv.taxYen, inv.planVersion, inv.method, ref, inv.status || 'issued', now(), inv.dueDate, inv.paidOn || null, inv.paidBy || null);
          if (r.changes !== 1) {
            if (db.prepare("SELECT 1 FROM invoices WHERE provider_id=? AND period=? AND status<>'void'").get(inv.providerId, inv.period)) return null;
            if (i < 5) continue; // 参考编号撞上了：换一个再试
            throw new Error('参考编号生成失败');
          }
          log(null, 'invoice.issue', { id, providerId: inv.providerId, period: inv.period });
          return id;
        }
      }
    },
    getInvoice(id) { return irow(db.prepare('SELECT * FROM invoices WHERE id=?').get(String(id))); },
    invoiceFor(providerId, period) { return irow(db.prepare("SELECT * FROM invoices WHERE provider_id=? AND period=? AND status<>'void'").get(providerId, period)); },
    listInvoices(f) {
      f = f || {};
      const where = [], args = [];
      if (f.status) { where.push('status=?'); args.push(f.status); }
      if (f.providerId) { where.push('provider_id=?'); args.push(f.providerId); }
      return db.prepare('SELECT * FROM invoices' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY period DESC, issued_at DESC').all(...args).map(irow);
    },
    // 标记已付款：只能从 issued 改。返回是否改成了。备注不进留痕。
    markInvoicePaid(id, paidOn, by, note) {
      const r = db.prepare("UPDATE invoices SET status='paid', paid_on=?, paid_by=?, paid_note=? WHERE id=? AND status='issued'").run(paidOn, by, note || null, String(id));
      if (r.changes === 1) { this.dropInvoiceMails(id, '账单已付款'); log(null, 'invoice.paid', { id, by }); }
      return r.changes === 1;
    },
    voidInvoice(id, reason, by) {
      const r = db.prepare("UPDATE invoices SET status='void', void_reason=? WHERE id=? AND status='issued'").run(reason, String(id));
      if (r.changes === 1) { this.dropInvoiceMails(id, '账单已作废'); log(null, 'invoice.void', { id, by }); }
      return r.changes === 1;
    },
    // 这张账单还在排队的提醒邮件不再发
    dropInvoiceMails(id, why) {
      for (const r of db.prepare("SELECT outbox_id FROM invoice_reminders WHERE invoice_id=? AND outbox_id IS NOT NULL AND stage<>'hidden'").all(String(id))) this.dropMail(r.outbox_id, why);
    },
    // 收展示费的服务商（经申请批准的和老服务商），在架的。经申请批准、还没领取令牌的不算：不展示、看不到咨询，
    // 所以不开账单、不发付款提醒，也不会收到“不再展示”的告知（领取之后下一轮 runOnce 再按普通规则开当期和下一期的账单）。
    billableProviders() { return db.prepare("SELECT p.id, p.category FROM providers p JOIN provider_meta m ON m.provider_id=p.id WHERE p.active=1 AND (m.source='legacy' OR (m.source='apply' AND m.claimed_at IS NOT NULL)) ORDER BY p.created_at, p.rowid").all(); },
    // 占下“这张账单的这一档邮件”。占到了返回 true（只有一次）。
    claimInvoiceReminder(invoiceId, stage) { return db.prepare('INSERT OR IGNORE INTO invoice_reminders (invoice_id,stage,outbox_id,created_at) VALUES (?,?,NULL,?)').run(invoiceId, String(stage), now()).changes === 1; },
    attachInvoiceReminder(invoiceId, stage, outboxId) { db.prepare('UPDATE invoice_reminders SET outbox_id=? WHERE invoice_id=? AND stage=?').run(outboxId, invoiceId, String(stage)); },
    invoiceReminderOfMail(outboxId) { const r = db.prepare('SELECT invoice_id AS invoiceId, stage FROM invoice_reminders WHERE outbox_id=?').get(outboxId); return r || null; },
    listInvoiceReminders(invoiceId) { return db.prepare('SELECT stage, outbox_id AS outboxId FROM invoice_reminders WHERE invoice_id=? ORDER BY created_at, rowid').all(invoiceId); },
    // 这套机制之前就有的服务商（没有 provider_meta 的）。check(row) 返回资料的问题（数组，空表示没问题；src/billing.js 按入驻申请的规则查：
    // 类别、登录番号的格式、所属会、保证类用语），feeModel(category) 返回按类别定的收费方式（不信库里存的值）。
    // - 没问题的：记为 legacy，补一张免费的当期账单（method migration），从下一期起照常收费。
    // - 有问题的：记为 legacy-hold，不展示、不开账单，令牌照常能用（还能回复以前的咨询）；要重新展示须走入驻申请（README“老服务商”）。
    // createApp 建好时和每一轮 runOnce 都会跑。返回 [{ id, held }]。留痕只写编号和问题的代号。
    migrateLegacyProviders(period, periodStart, periodEnd, check, feeModel) {
      const out = [];
      for (const p of db.prepare('SELECT * FROM providers WHERE id NOT IN (SELECT provider_id FROM provider_meta)').all()) {
        this.tx(() => {
          const issues = check ? check(prow(p)) : [];
          if (feeModel) db.prepare('UPDATE providers SET fee_model=? WHERE id=?').run(feeModel(p.category), p.id);
          if (db.prepare('INSERT OR IGNORE INTO provider_meta (provider_id,source,application_id,address,license_body,terms_version,claimed_at) VALUES (?,?,NULL,NULL,NULL,NULL,NULL)').run(p.id, issues.length ? 'legacy-hold' : 'legacy').changes !== 1) return;
          if (issues.length) {
            log(null, 'provider.migrate', { id: p.id, held: issues });
            out.push({ id: p.id, held: issues });
            return;
          }
          const inv = this.createInvoice({ providerId: p.id, period, periodStart, periodEnd, plan: 'migration', amountYen: 0, taxYen: 0, planVersion: 'migration', method: 'migration', dueDate: periodStart, status: 'paid', paidOn: jstToday(clock()), paidBy: 'migration' });
          log(null, 'provider.migrate', { id: p.id, invoiceId: inv });
          out.push({ id: p.id, held: null });
        });
      }
      return out;
    },
    // ---- 新咨询通知 ----
    // 到时间该排一封通知的服务商：第一条新咨询之后过了 delayMs，离上一封过了 intervalMs，没有还在排队的一封
    dueNotices(delayMs, intervalMs) {
      const t = clock();
      return db.prepare("SELECT n.provider_id AS providerId, n.pending_since AS pendingSince FROM provider_notices n WHERE n.pending_since IS NOT NULL AND n.pending_since<=? AND (n.last_sent_at IS NULL OR n.last_sent_at<=?) AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id=n.outbox_id AND o.status='queued')")
        .all(isoOf(t - delayMs), isoOf(t - intervalMs));
    },
    // 这段时间里发给这家的新咨询有几条（用户删了账号的已经不在了）
    countInquiries(providerId, from, to) { return db.prepare('SELECT COUNT(*) AS n FROM inquiries WHERE provider_id=? AND created_at>=? AND created_at<=?').get(providerId, from, to).n; },
    // 记下“这一封通知统计的是 from 到 to”，清掉 pending_since。outboxId 为空表示数量是 0、不发。
    noticeQueued(providerId, from, to, outboxId) {
      db.prepare('UPDATE provider_notices SET pending_since=NULL, last_sent_at=CASE WHEN ? IS NULL THEN last_sent_at ELSE ? END, outbox_id=COALESCE(?, outbox_id), win_start=?, win_end=? WHERE provider_id=?').run(outboxId, now(), outboxId, from, to, providerId);
    },
    noticeOfMail(outboxId) { const r = db.prepare('SELECT provider_id AS providerId, win_start AS winStart, win_end AS winEnd FROM provider_notices WHERE outbox_id=?').get(outboxId); return r || null; },
    // ---- 咨询 ----
    // 和“记下有新咨询要通知”在同一个事务里：服务商开着通知、有联系邮箱、没退信时才记；已经记着的不动（合成一封）。
    addInquiry(userId, q) {
      const id = crypto.randomUUID(), t = now(); // 咨询的时间和“要通知”的起点用同一个时刻，通知统计的时间段才一定包含这一条
      this.tx(() => {
        db.prepare('INSERT INTO inquiries VALUES (?,?,?,?,?,?,?,?,?)').run(id, userId, q.providerId, q.nodeId || null, q.category, q.summary, t, 'sent', t);
        if (db.prepare('SELECT 1 FROM provider_contacts WHERE provider_id=? AND notify_on=1 AND bounced_at IS NULL').get(q.providerId)) {
          db.prepare('INSERT INTO provider_notices (provider_id,pending_since) VALUES (?,?) ON CONFLICT(provider_id) DO UPDATE SET pending_since=COALESCE(pending_since, excluded.pending_since)').run(q.providerId, t);
        }
        log(userId, 'inquiry.create', { id, category: q.category, providerId: q.providerId });
      });
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
    // 写一条不属于任何用户的留痕（只写编号和动作，不写邮箱、令牌、验证码）
    audit(action, detail) { log(null, action, detail); },
    // 留痕记录（测试和运维排查用，不经接口对外）
    auditRows() { return db.prepare('SELECT at, user_id AS userId, action, detail FROM audit ORDER BY id').all(); },
    auditCount() { return db.prepare('SELECT COUNT(*) AS n FROM audit').get().n; },
    close() { db.close(); }
  };
}
module.exports = { createStore, EMPTY_PROFILE, MAX_ATTEMPTS, CODE_TTL_MS, PROOF_TTL_MS, addDays, jstToday, safeCode, UNAUTH_PURPOSES };
