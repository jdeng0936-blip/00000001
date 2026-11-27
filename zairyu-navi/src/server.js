// 在留导航 第一期后端：路线、提醒、选方案、对接咨询。零依赖（Node 22 自带模块）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const createEngine = require('./engine');
const { createStore, CODE_TTL_MS, PROOF_TTL_MS } = require('./store');

const { validateProfilePatch, validateInquiry, validateApplication, assertNoClaims, checkLicense, assertListingText, feeModelOf, LICENSE_RULES, isDate, assertNoSensitive, sensitiveLabel, normalizeEmail, maskEmail, HttpError } = require('./validate');
const assistant = require('./assistant');
const crypto = require('node:crypto');
const { createSender, deliverOutbox, TEXTS, scrub } = require('./mailer');
const { createScheduler, startReminderTimer } = require('./scheduler');
const { createBilling, billingConfig, prepareFor, CHECK_METHODS, FREE } = require('./billing');
const { createNotifier, notifyConfig } = require('./notifier');

// 使用条款和隐私政策的版本。文本改了就改这个版本号：老用户下次打开时要重新同意，同意之前只能读取或删除自己的数据。
// TERMS_CHANGES 是给老用户看的“这次改了什么”，和版本号一起改。
const TERMS_VERSION = '2026-11-27';
const TERMS_CHANGES = '可以绑定邮箱，用来在换设备或清空浏览器后找回账号（自愿，不绑定也能用）；绑定后我们会保存你的邮箱地址，并通过邮件服务商发送验证码和新设备登录通知。绑定后还可以另外打开“邮件提醒”（默认关闭）：期限前 7 天、前 1 天和当天各发一封邮件，邮件里写明是哪件事、哪一天，随时可以在应用里关掉或点邮件里的链接退订。';
const HOUR = 60 * 60 * 1000;
// 服务商条款（web/provider-terms.html）的版本。条款改了就改这个版本号；入驻申请要同意当前版本。
const PROVIDER_TERMS_VERSION = '2026-11-27';
// 入驻申请：查看或修改申请用的确认 30 分钟有效；每个来源地址每天最多提交 5 次
const APPLY_PROOF_TTL_MS = 30 * 60 * 1000;
const APPLY_LIMIT = [{ max: 5, windowMs: 24 * HOUR }];
// 验证码的限流（次数存在数据库里，重启不清零）。
// “发验证码”：reqEmail 是比较紧的一档，找回按（来源地址，邮箱）计，绑定按（账号，邮箱）计——各人算各人的，
//   别人对着你的邮箱点“发送”，耗不掉你自己的次数；reqEmailAll 是每个邮箱合计的上限（绑定和找回分开计），管住发到同一个邮箱的邮件总量；
//   另外按来源地址、按账号各算一次。
// “核对验证码”按来源地址、账号算；每个验证码另外最多错 5 次（store.verifyChallenge），次数记在验证码自己那一行上，不按邮箱合计
//   （按邮箱合计的话，谁都能用自己要来的验证码把这个邮箱的次数耗光，让本人验不了）。
const EMAIL_LIMITS = {
  reqEmail: [{ max: 1, windowMs: 60 * 1000 }, { max: 5, windowMs: HOUR }, { max: 10, windowMs: 24 * HOUR }],
  reqEmailAll: [{ max: 12, windowMs: HOUR }, { max: 30, windowMs: 24 * HOUR }],
  reqIp: [{ max: 10, windowMs: HOUR }],
  reqUser: [{ max: 5, windowMs: HOUR }],
  verIp: [{ max: 30, windowMs: HOUR }],
  verUser: [{ max: 30, windowMs: HOUR }]
};
// 刚用邮箱找回登录的设备，这么久之内不能更换或解除绑定的邮箱。
// 拿到一次验证码（或一时能看到邮箱）的人因此不能马上把邮箱换成自己的；本人收到“有新设备登录”的通知后，有时间在自己的设备上让它退出。
const EMAIL_COOLDOWN_MS = 24 * HOUR;

// 退订页面：不用登录、不带脚本的一小页。文字都是固定的，令牌只出现在表单的地址里（已限定为字母、数字、横线、下划线）。
const UNSUB_TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const page = (title, inner) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + title + ' - 在留导航</title>' +
  '<style>body{font:16px/1.7 system-ui,sans-serif;max-width:32em;margin:12vh auto;padding:0 20px;color:#1c2733}button{font:inherit;padding:10px 22px;border:0;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer}p.s{color:#5b6775;font-size:14px}</style></head><body><h1 style="font-size:20px">' + title + '</h1>' + inner + '</body></html>';
const UNSUB_ASK = (t) => page('退订提醒邮件', '<p>点下面的按钮后，在留导航不再向这个邮箱发期限提醒邮件。账号、已填的内容和用邮箱找回账号的功能都不受影响。</p>' +
  (t ? '<form method="post" action="/api/unsubscribe?t=' + t + '"><button type="submit" id="unsub-go">退订</button></form>' : '<p>这个退订链接不完整，请从邮件里重新打开。</p>') +
  '<p class="s">以后想再收到提醒，在应用的“账号和邮箱”里重新打开“邮件提醒”。</p>');
const UNSUB_DONE = page('已退订', '<p id="unsub-done">已退订。在留导航不会再向这个邮箱发期限提醒邮件。</p><p class="s">提醒仍然可以在应用的“提醒”页里看。以后想再收到邮件，在应用的“账号和邮箱”里重新打开“邮件提醒”。</p>');

// 提醒邮件的设置（npm start 和 npm run remind 共用）。env 是环境变量那样的对象；设置不对就抛错，不启动。
// APP_URL：邮件里“打开在留导航”和退订链接用的地址。接了真实发信（http、smtp）时必须填，不然发出去的链接指向 localhost。
function reminderConfig(env, sender) {
  env = env || {};
  const raw = env.APP_URL || '';
  if (raw && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(raw)) throw new Error('APP_URL 须是 http:// 或 https:// 开头的地址，不带参数');
  if (!raw && sender && !sender.dev) throw new Error('MAIL_SENDER=' + sender.name + ' 时需要配置 APP_URL（邮件里的链接要用）');
  const num = (name, def, min, max) => { if (env[name] == null || env[name] === '') return def; const n = Number(env[name]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(name + ' 须是 ' + min + ' 到 ' + max + ' 的整数'); return n; };
  if (env.REMINDERS_ENABLED != null && !['', '0', '1'].includes(env.REMINDERS_ENABLED)) throw new Error('REMINDERS_ENABLED 须是 1 或 0');
  return { appUrl: (raw || 'http://localhost:' + (+env.PORT || 8787)).replace(/\/+$/, ''), enabled: env.REMINDERS_ENABLED === '1', intervalMin: num('REMINDER_INTERVAL_MIN', 60, 1, 1440), hour: num('REMINDER_HOUR', 9, 0, 23) };
}

// 服务商新咨询通知的退订页（同上，不带脚本）
const PUNSUB_ASK = (t) => page('关闭新咨询通知', '<p>点下面的按钮后，在留导航不再向这个邮箱发新咨询通知。工作台、账单邮件都不受影响。</p>' +
  (t ? '<form method="post" action="/api/provider-unsubscribe?t=' + t + '"><button type="submit" id="punsub-go">关闭通知</button></form>' : '<p>这个链接不完整，请从邮件里重新打开。</p>') +
  '<p class="s">以后想再收到通知，在服务商工作台里重新打开“新咨询通知”。</p>');
const PUNSUB_DONE = page('已关闭通知', '<p id="punsub-done">已关闭。在留导航不会再向这个邮箱发新咨询通知。</p><p class="s">新咨询仍然可以在服务商工作台里看。</p>');

// 管理员令牌。ADMIN_TOKENS 写成“名字:令牌,名字:令牌”（也可以传 { 名字: 令牌 } 对象），名字记进留痕和审核记录（谁批准、谁核对、谁确认入账）。
// 名字是 1 至 32 个小写字母、数字、横线、下划线，令牌至少 24 个字符。写错了就抛错，不启动。ADMIN_TOKEN 继续可用，名字记为 admin。
function adminTokens(v) {
  if (v == null || v === '') return [];
  const pairs = typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(':'); return i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]; }) : Object.entries(v);
  const out = [], seen = new Set();
  for (const [name, token] of pairs) {
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error('ADMIN_TOKENS 的名字须是 1 至 32 个小写字母、数字、横线或下划线（写法：名字:令牌,名字:令牌）');
    if (typeof token !== 'string' || token.length < 24 || /[\s,]/.test(token)) throw new Error('ADMIN_TOKENS 里 ' + name + ' 的令牌至少 24 个字符，不能有空白和逗号');
    if (seen.has(name)) throw new Error('ADMIN_TOKENS 里的名字 ' + name + ' 重复了');
    seen.add(name); out.push({ name, token });
  }
  return out;
}

class Html { constructor(text) { this.text = text; } }

function createApp(opts) {
  opts = opts || {};
  // clock：毫秒时间，验证码过期和限流用；测试里可以拨。now 是引擎用的“今天”，两者互不影响。
  const clock = opts.clock || (() => Date.now());
  const store = opts.store || createStore(opts.dbFile, { clock });
  // 发件方式：不传就是 outbox（不联网，邮件留在库里）。正式启动时由文件末尾按环境变量建好传进来，测试不会误发真邮件。
  const sender = opts.sender || createSender({});
  const termsVersion = opts.termsVersion || TERMS_VERSION;
  const limits = Object.assign({}, EMAIL_LIMITS, opts.emailLimits || {});
  const cooldownMs = opts.emailCooldownMs != null ? opts.emailCooldownMs : EMAIL_COOLDOWN_MS;
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  // 来源地址。TRUST_PROXY=1 时取 X-Forwarded-For 的最后一段（紧挨着的那层反向代理写的），否则取连接的对端地址。
  const clientIp = (req) => {
    if (trustProxy) { const last = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (last) return last; }
    return req.socket.remoteAddress || '';
  };
  // 引擎用的“今天”：传了 now 就固定用它；只传了 clock（测试里拨时间）就跟着 clock 走；都没传用真实时间。
  const nowOf = () => opts.now || (opts.clock ? clock() : undefined);
  const engineFor = (u) => createEngine({ profile: u.profile, done: u.done, plan: u.plan, auth: u.auth, events: store.listEvents(u.id), now: nowOf() });
  const adminToken = opts.adminToken || process.env.ADMIN_TOKEN || null;
  const admins = adminTokens(opts.adminTokens !== undefined ? opts.adminTokens : process.env.ADMIN_TOKENS).concat(adminToken ? [{ name: 'admin', token: adminToken }] : []);
  const bearer = (req) => (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
  // 返回管理员的名字。逐个比较（比较哈希，长度一样），不提前结束。
  const admin = (req) => {
    if (!admins.length) throw new HttpError(503, '管理接口还没有配置（缺少 ADMIN_TOKEN 或 ADMIN_TOKENS）');
    const t = sha(bearer(req) || ''); let who = null;
    for (const a of admins) if (crypto.timingSafeEqual(t, sha(a.token)) && !who) who = a.name;
    if (!who) throw new HttpError(401, '需要管理员令牌');
    return who;
  };
  const provider = (req) => { const p = store.providerByToken(bearer(req)); if (!p) throw new HttpError(401, '需要服务商令牌'); return p; };
  const ref = createEngine({ now: nowOf() }); // 只用来取静态数据
  const nodeIds = new Set(ref.NODES.map((n) => n.id));
  const catKeys = new Set(ref.CATS.map((c) => c[0]));
  const evTypes = new Set(Object.keys(ref.EVRULES)); // 用集合判断，'constructor' 这类继承来的键不算事件类型
  // 咨询只能发给此刻在名单上展示的服务商（在架，并且展示费已付或不收费）
  const inquiryDeps = { hasCategory: (k) => catKeys.has(k), hasNode: (id) => nodeIds.has(id), getProvider: (id) => { const p = store.getProvider(id); return p && Object.assign(p, { active: p.active && store.providerListing(id, billing.todayOf()).listed }); } };

  // 限流（内存里的滑动窗口，单进程够用；多进程部署时要换成共享存储）。
  // 助手：每个账号 10 分钟 20 次、24 小时 200 次。注册：每个来源地址 1 小时 30 个账号。
  // 放在反向代理后面时，所有请求的来源地址都是代理，要在代理上按真实地址限流，并把 signupLimit 调大。
  const limiter = (cfg) => {
    const hits = new Map();
    return (key) => {
      const t = Date.now();
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= t - cfg.windowMs) hits.delete(k);
      const list = (hits.get(key) || []).filter((x) => x > t - cfg.windowMs);
      if (list.length >= cfg.max) { hits.set(key, list); return Math.max(1, Math.ceil((list[0] + cfg.windowMs - t) / 1000)); } // 返回还要等多少秒
      list.push(t); hits.set(key, list); return 0;
    };
  };
  const chatShort = limiter(opts.chatLimit || { max: 20, windowMs: 10 * 60 * 1000 });
  const chatDaily = limiter(opts.chatDailyLimit || { max: 200, windowMs: 24 * 60 * 60 * 1000 });
  const signup = limiter(opts.signupLimit || { max: 30, windowMs: 60 * 60 * 1000 });
  const tooMany = (wait, msg) => new HttpError(429, msg + '，请在' + (wait >= 120 ? Math.ceil(wait / 60) + '分钟' : wait + '秒') + '后再试', { 'retry-after': String(wait) });

  // ---- 邮箱验证码 ----
  const rules = (list, prefix, ...values) => list.map((r) => ({ key: store.rateKey(prefix, ...values), max: r.max, windowMs: r.windowMs }));
  const limit = (rs, msg) => { const wait = store.hit(rs); if (wait) throw tooMany(wait, msg); };
  const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const BAD_CODE = '验证码不对或已过期。请重新发送验证码再试';
  const codeOf = (b) => { if (!b || typeof b.challengeId !== 'string' || b.challengeId.length > 64 || typeof b.code !== 'string' || !/^\d{6}$/.test(b.code.trim())) throw new HttpError(422, BAD_CODE); return b.code.trim(); };
  // 邮件在响应发出之后再交给发件方式，发得快慢不影响接口的响应时间。
  // 发送那一步自己也要写库，会占住进程几毫秒；找回时邮箱没绑定过就排一行占位（store.enqueuePad），让这一步做的事一样多，
  // 外面的人量紧跟着的下一个请求的快慢，也分不出邮箱绑没绑定过。
  let delivering = Promise.resolve();
  // 期限提醒邮件的定时任务。这里只建好，不自己定时跑：npm start 按环境变量开定时器，测试直接调 remind()。
  // appUrl：邮件里的链接用的地址（字符串，或返回字符串的函数）；不传就是这个服务器自己监听的端口。
  const appUrlOf = () => String((typeof opts.appUrl === 'function' ? opts.appUrl() : opts.appUrl) || 'http://localhost:' + ((server.address() || {}).port || 8787)).replace(/\/+$/, '');
  const scheduler = createScheduler({ store, clock, now: opts.now, appUrl: appUrlOf });
  // 展示费和新咨询通知。opts.billing、opts.notify 是 billingConfig、notifyConfig 的结果；不传就是默认值（不读环境变量）。
  const billing = createBilling({ store, clock, config: opts.billing || billingConfig({}), methods: opts.billingMethods, method: opts.billingMethod, appUrl: appUrlOf });
  const notifier = createNotifier({ store, clock, config: opts.notify || notifyConfig({}), appUrl: appUrlOf });
  // 老服务商（这套机制之前就有的）在建好时就迁移，不等第一轮定时任务：没迁移之前它们没有已付款的账单，会被当成没付展示费而不展示
  billing.migrate();
  const providerTerms = opts.providerTermsVersion || PROVIDER_TERMS_VERSION;
  const applyLimit = opts.applyLimit || APPLY_LIMIT;
  let lastDeliver = { sent: 0, failed: 0, dropped: 0 };
  // 日志里只写错误说明，并把像邮箱的东西换掉
  const deliver = () => { delivering = delivering.then(() => deliverOutbox(store, sender, { prepare: prepareFor({ scheduler, billing, notifier }) })).then((r) => { lastDeliver = r; return r; }).catch((e) => { if (!closed) console.error('发邮件时出错：' + scrub(e).slice(0, 200)); }); return delivering; };
  // 服务商的定时任务：新咨询通知每次都看，展示费最多每小时跑一轮（两者都可以重复跑，不会重复发）
  let lastBilling = -Infinity;
  const providerTick = () => { const r = {}; if (clock() - lastBilling >= HOUR) { lastBilling = clock(); r.billing = billing.runOnce(); } r.notify = notifier.runOnce(); return r; };
  let closed = false, lastPurge = 0;
  const kick = () => setImmediate(() => { if (!closed) deliver(); });
  const purge = () => { if (clock() - lastPurge >= 60 * 1000) { lastPurge = clock(); store.purgeExpired(); } };

  const user = (id, req) => {
    const tok = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    // 没有令牌和令牌不对都返回同样的 401，不透露这个 id 是否存在。
    if (!tok || !store.checkToken(id, tok[1])) throw new HttpError(401, '需要登录');
    return store.getUser(id);
  };

  // 申请人看到的申请（邮箱打码）；管理员看到的再加上核对记录和去哪里核对
  const applicantView = (a) => ({ ref: a.ref, status: a.status, category: a.category, name: a.name, address: a.address, licenseNo: a.licenseNo, licenseBody: a.licenseBody, feeNote: a.feeNote, area: a.area, langs: a.langs, feeModel: a.feeModel, email: maskEmail(a.email), reviewMsg: ['changes_requested', 'rejected'].includes(a.status) ? a.reviewMsg : '', termsVersion: a.termsVersion, createdAt: a.createdAt, updatedAt: a.updatedAt });
  const adminView = (a) => Object.assign(applicantView(a), { id: a.id, reviewKey: a.reviewKey, reviewMsg: a.reviewMsg, licenseCheck: a.licenseCheck, decidedBy: a.decidedBy, decidedAt: a.decidedAt, providerId: a.providerId, regulated: !!ref.REGULATED[a.category], checkWhere: LICENSE_RULES[a.category] ? LICENSE_RULES[a.category].where : null });
  // 登录番号的核对记录：士业和不动产必须有。核对日期不能晚于今天（日本时间）；核对人是发请求的管理员、核对时间是服务器时间，都不由请求指定。
  const licenseCheckOf = (lc, category) => {
    const need = !!LICENSE_RULES[category];
    if (lc == null) { if (need) throw new HttpError(422, '士业和不动产要先对照所属会的检索核对登录番号，再填写核对方式和核对日期'); return null; }
    if (typeof lc !== 'object' || Array.isArray(lc)) throw new HttpError(422, 'licenseCheck 须为对象');
    for (const k of Object.keys(lc)) if (!['method', 'checkedOn', 'note'].includes(k)) throw new HttpError(422, '未知字段：licenseCheck.' + k);
    if (!CHECK_METHODS.includes(lc.method)) throw new HttpError(422, '核对方式须为 ' + CHECK_METHODS.join('、') + ' 之一');
    if (!isDate(lc.checkedOn) || lc.checkedOn > billing.todayOf()) throw new HttpError(422, '核对日期须为 YYYY-MM-DD，不能晚于今天');
    if (lc.note != null && (typeof lc.note !== 'string' || lc.note.length > 200)) throw new HttpError(422, '核对备注须为200字以内');
    assertNoSensitive(lc.note, '核对备注');
    return { method: lc.method, checkedOn: lc.checkedOn, note: lc.note ? lc.note.trim() : '' };
  };

  async function route(req, url, body) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const m = req.method;
    if (seg[0] !== 'api') return null;
    if (seg[1] === 'health' && m === 'GET') return { ok: true, nodes: ref.NODES.length };
    if (seg[1] === 'nodes' && m === 'GET') {
      if (!seg[2]) return ref.NODES.map((n) => ({ id: n.id, stage: n.s, title: n.t, summary: n.sum }));
      const n = ref.NODES.find((x) => x.id === seg[2]); if (!n) throw new HttpError(404, '没有这个节点');
      return Object.assign({}, n, { rows: n.rows.map((r) => ({ key: r[0], value: r[1], verified: !!r[2] })), links: ref.linksOf(n.id).map((l) => ({ category: l[1], what: l[2], bring: l[3] })) });
    }
    if (seg[1] === 'options' && m === 'GET' && seg[2]) {
      const params = Object.fromEntries(url.searchParams);
      try { return ref.options(seg[2], params); } catch (e) { throw new HttpError(404, e.message); }
    }
    if (seg[1] === 'terms' && m === 'GET') return { version: termsVersion, changes: TERMS_CHANGES, terms: '/terms.html', privacy: '/privacy.html' };
    // 发件箱：本地开发和测试从这里读验证码邮件，运维用它看有没有发不出去的邮件。没配 ADMIN_TOKEN 时是 503。
    // 正文和完整的收件地址只在本地发件方式（outbox、console）下返回；接了真实发信之后只返回状态，地址打码。
    if (seg[1] === 'admin' && seg[2] === 'outbox' && m === 'GET') {
      admin(req);
      const to = url.searchParams.get('to');
      return store.listOutbox({ status: url.searchParams.get('status') || undefined, to: to ? to.trim().toLowerCase() : undefined })
        .map((r) => Object.assign({ id: r.id, kind: r.kind, to: sender.dev || !r.to ? r.to : maskEmail(r.to), subject: r.subject, status: r.status, tries: r.tries, lastError: r.lastError, createdAt: r.createdAt, sentAt: r.sentAt }, sender.dev ? { body: r.body } : {}));
    }
    // 定时提醒的手动入口（管理员令牌）：现在就跑一轮并把到时间的邮件发掉。运维补跑和端到端检查用；跑多少次都不会重复发。
    if (seg[1] === 'admin' && seg[2] === 'reminders' && seg[3] === 'run' && !seg[4] && m === 'POST') {
      admin(req);
      const r = scheduler.runOnce();
      const d = (await deliver()) || lastDeliver;
      return Object.assign(r, { sent: d.sent, failed: d.failed, dropped: d.dropped });
    }
    // 退订提醒邮件：凭邮件里的链接，不用登录。GET 只显示确认页，什么都不改（邮件服务会预先打开链接，不能因此退订）；POST 才退订。
    // 令牌对不对、原来开没开，返回的页面都一样。
    if (seg[1] === 'unsubscribe' && !seg[2] && (m === 'GET' || m === 'POST')) {
      const t = url.searchParams.get('t') || '', ok = UNSUB_TOKEN.test(t);
      if (m === 'GET') return new Html(UNSUB_ASK(ok ? t : ''));
      if (ok) store.unsubscribeByToken(t);
      return new Html(UNSUB_DONE);
    }
    // 找回账号：只凭邮箱，不用登录。不管这个邮箱有没有绑定过账号，返回的内容都一样。
    if (seg[1] === 'auth' && seg[2] === 'recover' && m === 'POST') {
      purge();
      if (!seg[3]) {
        const email = normalizeEmail(body && body.email); // 只看写法，和有没有绑定无关
        limit(rules(limits.reqEmail, 'req-recover-ie', clientIp(req), email).concat(rules(limits.reqEmailAll, 'req-recover-em', email), rules(limits.reqIp, 'req-ip', clientIp(req))), '验证码发得太频繁');
        const owner = store.userByEmail(email), code = newCode(), mail = TEXTS.recoverCode(code);
        // 绑定过：存验证码并发邮件。没绑定过：存一个永远验不过的验证码，不发邮件，排一行占位。两种情况都是一次提交、写的行数一样。
        const challengeId = store.tx(() => {
          const id = store.createChallenge({ purpose: 'recover', userId: owner, email, code: owner ? code : null }, CODE_TTL_MS);
          if (owner) store.enqueueMail({ userId: owner, kind: 'code', to: email, subject: mail.subject, body: mail.text });
          else store.enqueuePad();
          return id;
        });
        kick();
        return [202, { challengeId, expiresInSec: CODE_TTL_MS / 1000 }];
      }
      if (seg[3] === 'verify' && !seg[4]) {
        const code = codeOf(body);
        limit(rules(limits.verIp, 'ver-ip', clientIp(req)), '验证码试得太频繁');
        const c = store.verifyChallenge(body.challengeId, 'recover', code);
        // 验证码对了，还要这个邮箱此刻仍然绑在那个账号上（发码之后解除了绑定、删了账号的不算）
        if (!c || !c.userId || store.userByEmail(c.email) !== c.userId) throw new HttpError(422, BAD_CODE);
        const mail = TEXTS.newDevice(clock());
        const token = store.tx(() => {
          const t = store.createSession(c.userId, 'recover'); // 新令牌只返回这一次；原来设备的令牌不动
          store.enqueueMail({ userId: c.userId, kind: 'notice', to: c.email, subject: mail.subject, body: mail.text });
          return t;
        });
        kick();
        return { id: c.userId, token };
      }
    }
    // ---- 服务商入驻：条款、申请、领取令牌、退订新咨询通知（都不用登录） ----
    if (seg[1] === 'provider-terms' && !seg[2] && m === 'GET') return { version: providerTerms, url: '/provider-terms.html' };
    // 在线支付的回调：以后接刷卡、在线支付时在这里按 :method 交给 billing 的 verifyWebhook。现在没有接入。
    if (seg[1] === 'billing' && seg[2] === 'webhook') throw new HttpError(404, '在线支付还没有接入');
    if (seg[1] === 'provider-apply') {
      purge();
      const appDeps = { hasCategory: (k) => catKeys.has(k), regulated: (k) => !!ref.REGULATED[k], termsVersion: providerTerms };
      // 第一步：向这个邮箱发验证码。谁都能申请，所以对任何邮箱都一样发（返回内容、花的时间都不看邮箱的情况）。
      if (seg[2] === 'code' && !seg[3] && m === 'POST') {
        const email = normalizeEmail(body && body.email);
        limit(rules(limits.reqEmail, 'req-papply-ie', clientIp(req), email).concat(rules(limits.reqEmailAll, 'req-papply-em', email), rules(limits.reqIp, 'req-ip', clientIp(req))), '验证码发得太频繁');
        const code = newCode(), mail = TEXTS.applyCode(code);
        const challengeId = store.tx(() => {
          const id = store.createChallenge({ purpose: 'papply', userId: null, email, code }, CODE_TTL_MS);
          store.enqueueMail({ kind: 'code', to: email, subject: mail.subject, body: mail.text });
          return id;
        });
        kick();
        return [202, { challengeId, expiresInSec: CODE_TTL_MS / 1000 }];
      }
      // 核对 papply 的验证码，对了返回验证过的邮箱
      const verified = (b) => {
        const code = codeOf(b);
        limit(rules(limits.verIp, 'ver-ip', clientIp(req)), '验证码试得太频繁');
        const c = store.verifyChallenge(b.challengeId, 'papply', code);
        if (!c) throw new HttpError(422, BAD_CODE);
        return c.email;
      };
      // 提交申请：先校验内容（不对的话验证码不会白白用掉），再核对验证码
      if (!seg[2] && m === 'POST') {
        const b = body || {};
        codeOf(b);
        const a = validateApplication(b, appDeps);
        limit(rules(applyLimit, 'papply-submit', clientIp(req)), '提交得太频繁');
        const email = verified(b);
        // 这时邮箱已经验证过，告诉本人“已经有一份在审核”不算泄露
        if (store.openApplicationByEmail(email)) throw new HttpError(409, '这个邮箱已经有一份在审核中或等待修改的申请。请在“查看或修改申请”里查看');
        if (store.providerByContact(email)) throw new HttpError(409, '这个邮箱已经是一家服务商的联系邮箱');
        const mail = (r) => TEXTS.applyReceived(r);
        const r = store.tx(() => {
          const x = store.createApplication(Object.assign({}, a, { email, termsVersion: providerTerms }));
          const mm = mail(x.ref);
          store.enqueueMail({ kind: 'notice', to: email, subject: mm.subject, body: mm.text });
          return x;
        });
        kick();
        return [201, { ref: r.ref }];
      }
      // 查看或修改：凭验证码拿到这个邮箱最近的一份申请和确认（30 分钟内用来修改、撤回）
      if (seg[2] === 'open' && !seg[3] && m === 'POST') {
        const email = verified(body || {});
        const a = store.latestApplicationByEmail(email);
        if (!a) throw new HttpError(404, '这个邮箱还没有提交过入驻申请');
        return { application: applicantView(a), proof: store.createApplyProof(a.id, email, APPLY_PROOF_TTL_MS), expiresInSec: APPLY_PROOF_TTL_MS / 1000 };
      }
      if (seg[2] && seg[2] !== 'code' && seg[2] !== 'open' && !seg[3] && (m === 'PUT' || m === 'DELETE')) {
        const a = store.applicationByRef(seg[2]);
        if (!a || !store.applyProofOk(a.id, body && body.proof)) throw new HttpError(403, '确认已过期或不对。请重新用邮箱收验证码，打开“查看或修改申请”');
        if (m === 'DELETE') {
          if (!store.withdrawApplication(a.id)) throw new HttpError(409, '这份申请已经审核完，不能撤回');
          return [204, null];
        }
        if (a.status !== 'changes_requested') throw new HttpError(409, '只有被要求修改的申请才能重新提交');
        const x = validateApplication(body || {}, appDeps);
        if (!store.resubmitApplication(a.id, x, providerTerms)) throw new HttpError(409, '只有被要求修改的申请才能重新提交');
        const mm = TEXTS.applyReceived(a.ref);
        store.enqueueMail({ kind: 'notice', to: a.email, subject: mm.subject, body: mm.text });
        kick();
        return { application: applicantView(store.getApplication(a.id)) };
      }
      throw new HttpError(404, '没有这个接口');
    }
    // 领取服务商令牌：凭联系邮箱的验证码。不管邮箱是不是在架服务商的联系邮箱，返回的都一样（不是的话存一个永远验不过的验证码，排一行占位）。
    if (seg[1] === 'provider-claim' && m === 'POST') {
      purge();
      if (seg[2] === 'code' && !seg[3]) {
        const email = normalizeEmail(body && body.email);
        limit(rules(limits.reqEmail, 'req-pclaim-ie', clientIp(req), email).concat(rules(limits.reqEmailAll, 'req-pclaim-em', email), rules(limits.reqIp, 'req-ip', clientIp(req))), '验证码发得太频繁');
        const owner = store.claimableProviderByEmail(email), code = newCode(), mail = TEXTS.claimCode(code);
        const challengeId = store.tx(() => {
          const id = store.createChallenge({ purpose: 'pclaim', userId: owner, email, code: owner ? code : null }, CODE_TTL_MS);
          if (owner) store.enqueueMail({ kind: 'code', to: email, subject: mail.subject, body: mail.text });
          else store.enqueuePad();
          return id;
        });
        kick();
        return [202, { challengeId, expiresInSec: CODE_TTL_MS / 1000 }];
      }
      if (!seg[2]) {
        const code = codeOf(body);
        limit(rules(limits.verIp, 'ver-ip', clientIp(req)), '验证码试得太频繁');
        const c = store.verifyChallenge(body.challengeId, 'pclaim', code);
        // 验证码对了，还要这个邮箱此刻仍是那家在架服务商的联系邮箱（发码之后下架了的不算）
        if (!c || !c.userId || store.claimableProviderByEmail(c.email) !== c.userId) throw new HttpError(422, BAD_CODE);
        const mm = TEXTS.tokenIssued(clock());
        const token = store.claimProviderToken(c.userId, { to: c.email, subject: mm.subject, body: mm.text });
        kick();
        return { token };
      }
    }
    // 关闭新咨询通知：凭邮件里的链接，不用登录。GET 只显示确认页，POST 才关。令牌对不对、原来开没开，返回的页面都一样。
    if (seg[1] === 'provider-unsubscribe' && !seg[2] && (m === 'GET' || m === 'POST')) {
      const t = url.searchParams.get('t') || '', ok = UNSUB_TOKEN.test(t);
      if (m === 'GET') return new Html(PUNSUB_ASK(ok ? t : ''));
      if (ok) store.providerUnsubscribe(t);
      return new Html(PUNSUB_DONE);
    }
    if (seg[1] === 'providers' && !seg[2] && m === 'GET') {
      // 名单上公开：名称、类别、区域、语言、收费说明、登录番号、所属会、事务所地址；联系邮箱不公开
      const pub = (p) => ({ id: p.id, name: p.name, category: p.category, area: p.area, langs: p.langs, feeNote: p.feeNote, licenseNo: p.licenseNo, licenseBody: p.licenseBody, address: p.address, promoted: !ref.REGULATED[p.category] }); // 含推广：非士业一律标，按类别定，不看库里存的收费方式
      return store.listProviders(url.searchParams.get('category') || undefined, billing.todayOf()).map(pub);
    }
    // ---- 管理员：入驻申请的审核 ----
    if (seg[1] === 'admin' && seg[2] === 'applications') {
      const who = admin(req);
      if (!seg[3] && m === 'GET') return store.listApplications(url.searchParams.get('status') || undefined).map(adminView);
      const a = seg[3] ? store.getApplication(seg[3]) : null;
      if (!a) throw new HttpError(404, '没有这份申请');
      if (!seg[4] && m === 'GET') return adminView(a);
      // 批准、拒绝、要求修改都要带上管理员看到的 reviewKey（GET 返回的）：看完之后申请人又改过就返回 409，要重新打开再审
      const CHANGED = '申请在你打开之后有过修改（例如申请人重新提交了），请重新打开这份申请、核对新的内容后再操作';
      const sameVersion = (x, b) => { if (typeof b.reviewKey !== 'string' || !b.reviewKey) throw new HttpError(422, '要带上 reviewKey（打开申请时看到的版本）'); if (x.reviewKey !== b.reviewKey) throw new HttpError(409, CHANGED); };
      const onlyKeys = (b, keys) => { for (const k of Object.keys(b || {})) if (!keys.includes(k)) throw new HttpError(422, k === 'amount' ? '金额只按价目表，不能指定' : '未知字段：' + k); };
      if (seg[4] === 'approve' && !seg[5] && m === 'POST') {
        const b = body || {};
        onlyKeys(b, ['licenseCheck', 'reviewKey']);
        const check = licenseCheckOf(b.licenseCheck, a.category);
        if (a.status !== 'pending') throw new HttpError(409, '这份申请不在审核中（' + a.status + '）');
        sameVersion(a, b);
        const inv = billing.firstInvoice(a.category);
        const r = store.approveApplication(a.id, who, check, inv, (x) => { const mm = TEXTS.applyApproved(a.ref, appUrlOf() + '/provider.html', x, billing.config.issueDays); return { subject: mm.subject, body: mm.text }; }, b.reviewKey);
        if (!r) { const now2 = store.getApplication(a.id); throw new HttpError(409, now2.status !== 'pending' ? '这份申请不在审核中' : now2.reviewKey !== b.reviewKey ? CHANGED : '申请的联系邮箱已经是别家服务商的联系邮箱'); }
        kick();
        return r; // 没有令牌：令牌由服务商自己用联系邮箱领取
      }
      if ((seg[4] === 'reject' || seg[4] === 'request-changes') && !seg[5] && m === 'POST') {
        const b = body || {}, key = seg[4] === 'reject' ? 'reason' : 'message';
        onlyKeys(b, [key, 'reviewKey']);
        const msg = b[key];
        if (typeof msg !== 'string' || msg.trim().length < 5 || msg.length > 500) throw new HttpError(422, (key === 'reason' ? '理由' : '说明') + '须为5至500字（会写进发给申请人的邮件）');
        assertNoSensitive(msg, key === 'reason' ? '理由' : '说明');
        if (a.status !== 'pending') throw new HttpError(409, '这份申请不在审核中（' + a.status + '）');
        sameVersion(a, b);
        const mm = seg[4] === 'reject' ? TEXTS.applyRejected(a.ref, msg.trim()) : TEXTS.applyChanges(a.ref, msg.trim());
        if (!store.decideApplication(a.id, seg[4] === 'reject' ? 'rejected' : 'changes_requested', who, msg.trim(), { to: a.email, subject: mm.subject, body: mm.text }, b.reviewKey)) throw new HttpError(409, store.getApplication(a.id).status !== 'pending' ? '这份申请不在审核中' : CHANGED);
        kick();
        return adminView(store.getApplication(a.id));
      }
      throw new HttpError(404, '没有这个接口');
    }
    // ---- 管理员：账单 ----
    if (seg[1] === 'admin' && seg[2] === 'invoices') {
      const who = admin(req);
      if (!seg[3] && m === 'GET') return store.listInvoices({ status: url.searchParams.get('status') || undefined }).map((i) => Object.assign(i, { providerName: (store.getProvider(i.providerId) || {}).name || '' }));
      const inv = seg[3] ? store.getInvoice(seg[3]) : null;
      if (!inv) throw new HttpError(404, '没有这张账单');
      const b = body || {};
      if (seg[4] === 'paid' && !seg[5] && m === 'POST') {
        for (const k of Object.keys(b)) if (!['paidOn', 'note'].includes(k)) throw new HttpError(422, k === 'amount' || k === 'amountYen' ? '金额只按价目表，不能指定' : '未知字段：' + k);
        if (!isDate(b.paidOn) || b.paidOn > billing.todayOf()) throw new HttpError(422, 'paidOn 须为 YYYY-MM-DD 的入账日，不能晚于今天');
        if (b.note != null && (typeof b.note !== 'string' || b.note.length > 200)) throw new HttpError(422, '备注须为200字以内');
        assertNoSensitive(b.note, '备注');
        if (!store.markInvoicePaid(inv.id, b.paidOn, who, b.note ? b.note.trim() : '')) throw new HttpError(409, '这张账单不是待付款状态（' + inv.status + '）');
        return store.getInvoice(inv.id);
      }
      if (seg[4] === 'void' && !seg[5] && m === 'POST') {
        for (const k of Object.keys(b)) if (k !== 'reason') throw new HttpError(422, '未知字段：' + k);
        if (typeof b.reason !== 'string' || b.reason.trim().length < 2 || b.reason.length > 200) throw new HttpError(422, '作废理由须为2至200字');
        assertNoSensitive(b.reason, '理由');
        if (!store.voidInvoice(inv.id, b.reason.trim(), who)) throw new HttpError(409, '这张账单不是待付款状态（' + inv.status + '）');
        return store.getInvoice(inv.id);
      }
      throw new HttpError(404, '没有这个接口');
    }
    // 现在跑一轮：老服务商迁移、开账单、付款提醒、新咨询通知，再把到时间的邮件发掉。跑多少次都不会重复发。
    if (seg[1] === 'admin' && seg[2] === 'billing' && seg[3] === 'run' && !seg[4] && m === 'POST') {
      admin(req);
      const r = billing.runOnce(), n = notifier.runOnce();
      const d = (await deliver()) || lastDeliver;
      return Object.assign(r, { notices: n.mails, sent: d.sent, failed: d.failed, dropped: d.dropped });
    }
    if (seg[1] === 'admin' && seg[2] === 'providers') {
      admin(req);
      if (!seg[3] && m === 'GET') {
        return store.listAllProviders().map((p) => {
          const meta = store.providerMeta(p.id) || {}, c = store.providerContact(p.id), inv = store.listInvoices({ providerId: p.id })[0] || null;
          return Object.assign(p, store.providerListing(p.id, billing.todayOf()), { source: meta.source || 'legacy', address: meta.address || '', licenseBody: meta.licenseBody || '', claimed: !!meta.claimedAt, contact: c ? maskEmail(c.email) : null, notify: !!c && c.notify, latestInvoice: inv && { id: inv.id, refCode: inv.refCode, period: inv.period, status: inv.status, dueDate: inv.dueDate, amountYen: inv.amountYen } });
        });
      }
      // 管理员直接入驻：会把令牌返回给管理员，所以只在 createApp({ allowDirectProvider: true }) 时开（测试和端到端用），正式环境 404
      if (!seg[3] && m === 'POST' && opts.allowDirectProvider) {
        const b = body || {};
        if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.length > 80) throw new HttpError(422, '名称须为2至80字');
        if (!catKeys.has(b.category)) throw new HttpError(422, '服务类别无效');
        const regulated = !!ref.REGULATED[b.category];
        // 收费方式只按类别定（士业 fixed_listing，其余 affiliate_disclosed，都只付固定的展示费），请求里的 feeModel 只能和它一致。
        const feeModel = feeModelOf(regulated);
        if (b.feeModel != null && b.feeModel !== feeModel) throw new HttpError(422, regulated ? '士业只能按固定展示费入驻，不能按成交抽成' : '非士业的收费方式固定为 affiliate_disclosed（同样只付固定的展示费，名单上标明含推广），不能指定');
        for (const k of ['area', 'langs', 'feeNote', 'licenseNo', 'licenseBody', 'address']) if (b[k] != null && (typeof b[k] !== 'string' || b[k].length > 200)) throw new HttpError(422, k + ' 须为200字以内的文字');
        for (const k of ['name', 'area', 'langs', 'feeNote', 'address']) assertNoSensitive(b[k], k);
        // 和入驻申请同一套检查：名单上的文字没有保证类用语，登录番号的格式和所属会
        assertListingText(b);
        const lic = checkLicense(b.category, b.licenseNo, b.licenseBody);
        return [201, store.createProvider({ name: b.name.trim(), category: b.category, area: b.area, langs: b.langs, feeNote: b.feeNote, address: b.address, licenseNo: lic.licenseNo || null, licenseBody: lic.licenseBody || null, feeModel })];
      }
      if (m === 'PUT' && seg[3] && seg[4] === 'active' && !seg[5]) { if (!store.getProvider(seg[3])) throw new HttpError(404, '没有这个服务商'); store.setProviderActive(seg[3], !body || body.active !== false); return { ok: true }; }
      throw new HttpError(404, '没有这个接口');
    }
    if (seg[1] === 'provider') {
      const p = provider(req);
      if (seg[2] === 'me' && !seg[3] && m === 'GET') {
        const meta = store.providerMeta(p.id) || {}, c = store.providerContact(p.id);
        return Object.assign(p, store.providerListing(p.id, billing.todayOf()), { address: meta.address || '', licenseBody: meta.licenseBody || '', termsVersion: meta.termsVersion || null, notify: !!c && c.notify, contact: c ? maskEmail(c.email) : null });
      }
      if (seg[2] === 'me' && seg[3] === 'notify' && !seg[4] && m === 'PUT') {
        if (!body || typeof body.on !== 'boolean') throw new HttpError(422, 'on 须为 true 或 false');
        if (!store.setProviderNotify(p.id, body.on)) throw new HttpError(409, '没有登记联系邮箱，收不到通知');
        return { notify: body.on };
      }
      // 自己的账单，带付款说明（振込先和参考编号）；管理员的入账备注不给
      if (seg[2] === 'invoices' && !seg[3] && m === 'GET') {
        // 首月免费的覆盖记录不是账单，不列出
        return store.listInvoices({ providerId: p.id }).filter((i) => i.method !== FREE).map((i) => ({ id: i.id, refCode: i.refCode, period: i.period, periodStart: i.periodStart, periodEnd: i.periodEnd, amountYen: i.amountYen, taxYen: billing.config.regNo ? i.taxYen : null, regNo: billing.config.regNo || null, status: i.status, dueDate: i.dueDate, paidOn: i.paidOn, payText: i.status === 'issued' ? billing.payText(i) : '' }));
      }
      if (seg[2] === 'inquiries' && !seg[3] && m === 'GET') return store.listInquiriesFor(p.id);
      if (seg[2] === 'inquiries' && seg[3]) {
        const q = store.inquiryOf(p.id, seg[3]); if (!q) throw new HttpError(404, '没有这条咨询');
        if (seg[4] === 'reply' && m === 'POST') {
          const t = body && body.text;
          if (typeof t !== 'string' || t.trim().length < 2 || t.length > 3000) throw new HttpError(422, '回复须为2至3000字');
          assertNoSensitive(t, '回复');
          assertNoClaims(t, '回复'); // 服务商条款第 5 条：回复里也不能写“包过”“保证获批”这类话（“不能保证”这种提醒可以写）
          if (q.status === 'closed') throw new HttpError(409, '这条咨询已经结束');
          store.addReply(q.id, t.trim()); return [201, { ok: true }];
        }
        if (seg[4] === 'status' && m === 'PUT') {
          if (!['viewed', 'closed'].includes(body && body.status)) throw new HttpError(422, 'status 须为 viewed 或 closed');
          if (!(body.status === 'viewed' && q.status !== 'sent')) store.setInquiryStatus(q.id, body.status);
          return { ok: true };
        }
      }
      throw new HttpError(404, '没有这个接口');
    }
    if (seg[1] === 'providers' && seg[2] === 'categories' && m === 'GET') {
      // 所有服务商都只付固定的展示费，不按咨询数、成交或结果付费。feeModel 只区分标不标“含推广”：
      // 士业 fixed_listing（不标），其余 affiliate_disclosed（名单上标明含推广；名字是早先定的，为了兼容没有改，不表示有佣金）。
      return ref.CATS.map((c) => ({ key: c[0], name: c[1], what: c[2], regulated: !!ref.REGULATED[c[0]], feeModel: feeModelOf(!!ref.REGULATED[c[0]]), promoted: !ref.REGULATED[c[0]] }));
    }
    if (seg[1] === 'users') {
      if (!seg[2] && m === 'POST') {
        if (!body || body.accept !== termsVersion) throw new HttpError(422, '要先同意使用条款和隐私政策（版本 ' + termsVersion + '）');
        const wait = signup(clientIp(req));
        if (wait) throw tooMany(wait, '新建账号太频繁');
        return [201, store.createUser(termsVersion)];
      }
      const u = user(seg[2], req);
      const sub = seg[3];
      if (!sub && m === 'GET') return u;
      if (!sub && m === 'DELETE') { store.deleteUser(u.id); return [204, null]; }
      // 条款改版后重新同意。accept 必须是当前版本。
      if (sub === 'consent' && m === 'POST' && !seg[4]) {
        if (!body || body.accept !== termsVersion) throw new HttpError(422, '要先同意使用条款和隐私政策（版本 ' + termsVersion + '）');
        if (u.consentVersion !== termsVersion) store.renewConsent(u.id, termsVersion);
        return store.getUser(u.id);
      }
      // 同意的还是旧版本：只能读取自己的数据、删除账号、重新同意（上面三个），其余一律先拦下。
      // 例外是“收回”类的操作：查看绑定的邮箱、关掉邮件提醒、解除邮箱（连同解除之前验证原来的邮箱）。不同意新条款的人也要能让我们不再给他发邮件、不再留着他的邮箱。
      // 解除邮箱要先验证原来的邮箱，所以“验证原邮箱以便解除”（action: 'remove'）的两步也算在收回里。
      const withdraw = sub === 'email' && ((!seg[4] && (m === 'GET' || m === 'DELETE')) || (seg[4] === 'reminders' && !seg[5] && m === 'PUT' && !!body && body.on === false) ||
        (seg[4] === 'old' && (!seg[5] || (seg[5] === 'verify' && !seg[6])) && m === 'POST' && !!body && body.action === 'remove'));
      if (u.consentVersion !== termsVersion && !withdraw) throw new HttpError(409, '使用条款和隐私政策已更新（版本 ' + termsVersion + '）。请刷新页面，重新确认后继续使用');
      // ---- 邮箱：绑定、查看、解除 ----
      if (sub === 'email') {
        purge();
        // 这台设备是刚用邮箱找回登录的、账号上已经绑着邮箱：暂时不能换绑或解除
        const cooldown = () => {
          const ses = store.sessionOf(u.id, bearer(req));
          const left = ses && ses.via === 'recover' && store.getEmail(u.id) ? Date.parse(ses.createdAt) + cooldownMs - clock() : 0;
          if (left > 0) throw new HttpError(403, '这台设备是刚用邮箱找回登录的，' + Math.round(cooldownMs / HOUR) + ' 小时内不能更换或解除绑定的邮箱（防止别人拿到一次验证码就把你的邮箱换掉）。请在' + (left >= HOUR ? Math.ceil(left / HOUR) + '小时' : Math.ceil(left / 60000) + '分钟') + '后再试，或者在注册时用的那台设备上操作');
        };
        // 账号上已经绑着邮箱时，更换（action 'change'）和解除（'remove'）都要带上原来的邮箱验证过之后拿到的确认 proof（见下面的 /email/old）。
        // 从哪台设备操作都一样。原来的邮箱收不到信了的人：不能换绑也不能解除（没有绕过的办法，客服也不替人改），可以删除账号重新开始。
        const needProof = (action, proof) => {
          if (store.getEmail(u.id) && !store.proofOk(u.id, action, proof)) throw new HttpError(403, '要先输入发到原来邮箱的验证码，确认是你本人在' + (action === 'remove' ? '解除' : '更换') + '邮箱（确认后 ' + PROOF_TTL_MS / 60000 + ' 分钟内有效，过期了请重新验证原来的邮箱）');
        };
        const actionOf = (b) => { if (!b || !['change', 'remove'].includes(b.action)) throw new HttpError(422, "action 须为 'change' 或 'remove'"); return b.action; };
        if (!seg[4] && m === 'GET') { const e = store.getEmail(u.id); return { email: e ? maskEmail(e.email) : null, verified: !!e, remindOptIn: !!e && e.remindOptIn }; }
        // 验证原来的邮箱，第一步：向账号现在绑着的邮箱发验证码。body { action }。
        if (seg[4] === 'old' && !seg[5] && m === 'POST') {
          const action = actionOf(body);
          const cur = store.getEmail(u.id);
          if (!cur) throw new HttpError(409, '这个账号没有绑定邮箱');
          cooldown();
          limit(rules(limits.reqEmail, 'req-old-ue', u.id, cur.email).concat(rules(limits.reqEmailAll, 'req-old-em', cur.email), rules(limits.reqIp, 'req-ip', clientIp(req)), rules(limits.reqUser, 'req-u', u.id)), '验证码发得太频繁');
          const code = newCode(), mail = TEXTS.oldCode(action, code);
          const challengeId = store.tx(() => {
            const id = store.createChallenge({ purpose: 'old-' + action, userId: u.id, email: cur.email, code }, CODE_TTL_MS);
            store.enqueueMail({ userId: u.id, kind: 'code', to: cur.email, subject: mail.subject, body: mail.text });
            return id;
          });
          kick();
          return [202, { challengeId, expiresInSec: CODE_TTL_MS / 1000 }];
        }
        // 第二步：body { action, challengeId, code }，对了返回 { proof, expiresInSec }（proof 只返回这一次）。
        if (seg[4] === 'old' && seg[5] === 'verify' && !seg[6] && m === 'POST') {
          const action = actionOf(body), code = codeOf(body);
          limit(rules(limits.verIp, 'ver-ip', clientIp(req)).concat(rules(limits.verUser, 'ver-u', u.id)), '验证码试得太频繁');
          cooldown();
          const c = store.verifyChallenge(body.challengeId, 'old-' + action, code, u.id);
          const cur = store.getEmail(u.id);
          // 验证的必须是账号此刻绑着的邮箱（发码之后已经换掉、解除的不算）
          if (!c || !cur || cur.email !== c.email) throw new HttpError(422, BAD_CODE);
          return { proof: store.createProof(u.id, c.email, action, PROOF_TTL_MS), expiresInSec: PROOF_TTL_MS / 1000 };
        }
        if (!seg[4] && m === 'POST') {
          const b = body || {};
          const email = normalizeEmail(b.email);
          if (b.consent !== true) throw new HttpError(422, '绑定之前要先同意我们保存这个邮箱地址，用于找回账号、发送验证码和新设备登录通知');
          cooldown();
          needProof('change', b.proof); // 只查不用掉：新邮箱的验证码可以重发；真正用掉在 /verify 换绑的那一刻
          limit(rules(limits.reqEmail, 'req-bind-ue', u.id, email).concat(rules(limits.reqEmailAll, 'req-bind-em', email), rules(limits.reqIp, 'req-ip', clientIp(req)), rules(limits.reqUser, 'req-u', u.id)), '验证码发得太频繁');
          // 这个邮箱已经绑在别的账号上：返回的内容一样，但发过去的是“已经绑定过”的说明，存下的验证码永远验不过。
          const owner = store.userByEmail(email), taken = !!owner && owner !== u.id;
          const code = newCode(), mail = taken ? TEXTS.taken() : TEXTS.bindCode(code);
          const challengeId = store.tx(() => {
            const id = store.createChallenge({ purpose: 'bind', userId: u.id, email, code: taken ? null : code }, CODE_TTL_MS);
            store.enqueueMail({ userId: taken ? owner : u.id, kind: taken ? 'notice' : 'code', to: email, subject: mail.subject, body: mail.text });
            return id;
          });
          kick();
          return [202, { challengeId, expiresInSec: CODE_TTL_MS / 1000 }];
        }
        if (seg[4] === 'verify' && !seg[5] && m === 'POST') {
          const code = codeOf(body);
          limit(rules(limits.verIp, 'ver-ip', clientIp(req)).concat(rules(limits.verUser, 'ver-u', u.id)), '验证码试得太频繁');
          cooldown();
          needProof('change', body.proof); // 先查，确认不对时不白白用掉新邮箱的验证码
          const c = store.verifyChallenge(body.challengeId, 'bind', code, u.id);
          // 换了邮箱：给原来的邮箱发一封告知（不写新邮箱是什么），原来的邮箱因此不会被人悄悄换掉。确认在换绑的同一个事务里用掉。
          const bye = TEXTS.emailChanged(clock());
          if (!c || !store.bindEmail(u.id, c.email, termsVersion, { subject: bye.subject, body: bye.text }, body.proof)) throw new HttpError(422, BAD_CODE);
          kick();
          if (body.remindOptIn === true) store.setRemindOptIn(u.id, true); // 绑定时顺便打开提醒邮件（要明确传 true）
          return { email: maskEmail(c.email), verified: true, remindOptIn: store.getEmail(u.id).remindOptIn };
        }
        if (!seg[4] && m === 'DELETE') {
          cooldown();
          const proof = body && body.proof;
          needProof('remove', proof);
          const bye = TEXTS.emailRemoved(clock()); // 给解除掉的邮箱发最后一封告知，发出后地址就不留了
          // 确认在解除的同一个事务里用掉；刚好同时被别的请求用掉了的，邮箱还在，按没确认处理
          if (!store.removeEmail(u.id, { subject: bye.subject, body: bye.text }, proof) && store.getEmail(u.id)) needProof('remove', null);
          kick();
          return [204, null];
        }
        // 提醒邮件的开关。默认关；只有绑定并验证过邮箱才能开。换绑邮箱后要重新开。
        if (seg[4] === 'reminders' && !seg[5] && m === 'PUT') {
          if (!body || typeof body.on !== 'boolean') throw new HttpError(422, 'on 须为 true 或 false');
          if (!store.getEmail(u.id)) throw new HttpError(409, '要先绑定邮箱，才能打开邮件提醒');
          store.setRemindOptIn(u.id, body.on);
          return { remindOptIn: store.getEmail(u.id).remindOptIn };
        }
        throw new HttpError(404, '没有这个接口');
      }
      // ---- 登录的设备：查看、让其他设备退出 ----
      if (sub === 'sessions' && !seg[4]) {
        if (m === 'GET') return store.listSessions(u.id, bearer(req));
        if (m === 'DELETE') { store.revokeOtherSessions(u.id, bearer(req)); return [204, null]; }
      }
      if (sub === 'events') {
        if (m === 'GET') return store.listEvents(u.id).map((ev) => Object.assign(ev, { label: evTypes.has(ev.type) ? ref.EVRULES[ev.type][0] : '' }));
        if (m === 'POST') {
          const b = body || {};
          if (typeof b.type !== 'string' || !evTypes.has(b.type)) throw new HttpError(422, '事件类型无效');
          if (!isDate(b.date)) throw new HttpError(422, 'date 须为 YYYY-MM-DD，且是真实存在的日期');
          if (b.note != null && (typeof b.note !== 'string' || b.note.length > 200)) throw new HttpError(422, 'note 须为200字以内');
          assertNoSensitive(b.note, '备注');
          return [201, { id: store.addEvent(u.id, { type: b.type, date: b.date, note: b.note }) }];
        }
        if (m === 'DELETE' && seg[4]) { if (!store.deleteEvent(u.id, seg[4])) throw new HttpError(404, '没有这个事件'); return [204, null]; }
      }
      if (sub === 'state' && m === 'PUT') {
        // 网页端整体同步：概况和已完成的任务一起存。
        const b = body || {};
        const profile = validateProfilePatch(b.profile || {});
        const done = {};
        for (const k of Object.keys(b.done || {})) { if (!nodeIds.has(k)) throw new HttpError(422, '节点无效：' + k); if (b.done[k]) done[k] = true; }
        Object.assign(u.profile, profile); u.done = done;
        store.saveUser(u, 'state.sync');
        return { ok: true };
      }
      if (sub === 'profile' && m === 'PATCH') {
        Object.assign(u.profile, validateProfilePatch(body || {}));
        store.saveUser(u, 'profile.update', { keys: Object.keys(body || {}) });
        return u.profile;
      }
      if (sub === 'tasks' && seg[4] && seg[5] === 'done' && m === 'PUT') {
        if (!nodeIds.has(seg[4])) throw new HttpError(404, '没有这个节点');
        const on = !body || body.done !== false;
        if (on) {
          const st = engineFor(u).compute()[seg[4]];
          if (st.state === 'locked') throw new HttpError(409, '这个任务还没解锁：' + (st.note || ''));
          u.done[seg[4]] = true;
        } else delete u.done[seg[4]];
        store.saveUser(u, 'task.done', { id: seg[4], on });
        return engineFor(u).plan();
      }
      if (sub === 'plan' && m === 'GET') return engineFor(u).plan();
      // date 是日本时间的日历日（YYYY-MM-DD 的文字，不是时刻）；src 是事件期限的依据（法条、官方页面），没有则为 null
      if (sub === 'reminders' && m === 'GET') return engineFor(u).reminders().map((r) => ({ date: r.date, text: r.txt, tag: r.tag, src: r.src || null }));
      if (sub === 'advice' && m === 'GET') return engineFor(u).advice().map((a) => ({ title: a[0], text: a[1] }));
      if (sub === 'pr-check' && m === 'GET') return engineFor(u).prCheck();
      if (sub === 'chat' && m === 'POST') {
        const llm = opts.llm || (process.env.ANTHROPIC_API_KEY ? assistant.anthropicLLM(process.env.ANTHROPIC_API_KEY) : null);
        if (!llm) throw new HttpError(503, '助手还没有配置（缺少 ANTHROPIC_API_KEY）');
        const b = body || {};
        if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 2000) throw new HttpError(422, 'message 须为1至2000字');
        // 对话内容会转给模型服务商，敏感号码在这里拦下
        assertNoSensitive(b.message, '消息');
        // 历史是网页端带回来的，逐条校验形状和大小；不合规则返回 422，网页端清空历史后重试
        const history = assistant.validateHistory(b.history);
        // 历史里的每一段文字都会转给模型：用户说的话、助手的话、工具调用的参数、工具结果，全部过一遍。
        // 说明以 history 开头，网页端据此清空历史后重试（不然每一轮都会被同一条历史挡住）。
        for (const t of assistant.historyTexts(history)) {
          const label = sensitiveLabel(t);
          if (label) throw new HttpError(422, 'history 无效（对话历史里疑似含有' + label + '）。请清空对话历史后重试');
        }
        const wait = chatShort(u.id) || chatDaily(u.id);
        if (wait) throw tooMany(wait, '提问太频繁');
        const r = await assistant.chat({ user: u, store, now: nowOf() }, history, b.message, { llm });
        // draft：助手准备的咨询草稿（没有则为 null）。草稿没有发送，网页端显示给用户核对，用户同意后调 POST /inquiries。
        return { text: r.text, category: r.category, toolCalls: r.toolCalls.map((t) => ({ name: t.name, ok: t.ok })), draft: r.draft, history: r.messages };
      }
      if (sub === 'inquiries' && m === 'GET') return store.listInquiries(u.id);
      if (sub === 'inquiries' && m === 'POST') {
        const b = body || {};
        if (b.consent !== true) throw new HttpError(422, '发给服务商之前必须先让用户看过摘要并明确同意');
        const q = validateInquiry(b, inquiryDeps); // 和助手准备草稿用同一套校验
        return [201, { ids: q.providerIds.map((pid) => store.addInquiry(u.id, { providerId: pid, nodeId: q.nodeId, category: q.category, summary: q.summary })) }];
      }
    }
    throw new HttpError(404, '没有这个接口');
  }

  const webDir = opts.webDir || path.join(__dirname, '..', 'web');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  async function handle(req, res, send) {
    try {
      // 解析地址也放在 try 里：像 "//" 这样解析不了的请求返回 400，而不是让进程退出
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch (e) { throw new HttpError(400, '请求地址无效'); }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持这个方法');
        const f = path.join(webDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\]|\.\.)+/, ''));
        if (f.includes('\0') || !(f === webDir || f.startsWith(webDir + path.sep)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, { error: '没有这个页面' });
        const stream = fs.createReadStream(f);
        // 文件读到一半出错（被删、磁盘错误）不能变成未处理的 error 事件
        stream.on('error', (e) => { console.error(e); if (!res.headersSent) send(500, { error: '服务器内部错误' }); else res.destroy(); });
        stream.once('open', () => { res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); if (req.method === 'HEAD') { stream.destroy(); res.end(); } else stream.pipe(res); });
        res.on('close', () => stream.destroy());
        return;
      }
      let body = null;
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) { // DELETE 的请求体只有解除邮箱用（带原邮箱的确认），其余 DELETE 不看
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new HttpError(413, '请求太大'); chunks.push(c); }
        const raw = Buffer.concat(chunks).toString('utf8');
        // 退订的请求体不是 JSON（邮件客户端的一键退订发的是表单），读完就丢，不解析
        if (raw && url.pathname !== '/api/unsubscribe' && url.pathname !== '/api/provider-unsubscribe') { try { body = JSON.parse(raw); } catch (e) { throw new HttpError(400, '请求体须为 JSON'); } }
        if (body !== null && (typeof body !== 'object' || Array.isArray(body))) throw new HttpError(400, '请求体须为 JSON 对象');
      }
      const r = await route(req, url, body);
      if (r instanceof Html) return send(200, r, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
      if (Array.isArray(r) && typeof r[0] === 'number') return send(r[0], r[1]);
      send(200, r);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message }, e.headers);
      console.error(e); send(500, { error: '服务器内部错误' });
    }
  }
  const server = http.createServer((req, res) => {
    // send 自己不会抛错：响应已经发出或连接已断时什么都不做
    const send = (status, obj, headers) => {
      try {
        if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.destroy(); return; }
        res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {}));
        res.end(obj == null ? '' : obj instanceof Html ? obj.text : JSON.stringify(obj));
      } catch (e) { console.error(e); try { res.destroy(); } catch (e2) { /* 连接已经没了 */ } }
    };
    req.on('error', () => {}); res.on('error', () => {});
    // 最后一道兜底：handle 里任何没接住的错误都在这里结束，不会变成未处理的 rejection 让进程退出
    handle(req, res, send).catch((e) => { console.error(e); send(500, { error: '服务器内部错误' }); });
  });
  server.on('close', () => { closed = true; });
  // deliver：现在就把发件箱里到时间的邮件发一轮（定时重试和测试用）；purge：清理过期的验证码等
  // remind(at)：跑一轮提醒（at 可以把“现在”定在某个时刻，测试用），只排进发件箱；发出去还要调 deliver()
  // billing、notifier：展示费和新咨询通知；providerTick：每分钟由 npm start 调（通知每次都看，展示费最多每小时一轮）
  return { server, store, sender, deliver, purge: () => store.purgeExpired(), termsVersion, scheduler, remind: (at) => scheduler.runOnce(at), billing, notifier, providerTick };
}

module.exports = { createApp, validateProfilePatch, TERMS_VERSION, PROVIDER_TERMS_VERSION, reminderConfig, adminTokens, EMAIL_LIMITS };

if (require.main === module) {
  const port = +process.env.PORT || 8787;
  let sender, rem, bc, nc, app;
  // 发信、提醒、展示费、新咨询通知的设置不全就不启动，并说清楚缺什么
  try { sender = createSender(process.env); rem = reminderConfig(process.env, sender); } catch (e) { console.error('邮件发送没有配置好：' + e.message); process.exit(1); }
  try { bc = billingConfig(process.env, sender); nc = notifyConfig(process.env); adminTokens(process.env.ADMIN_TOKENS); } catch (e) { console.error('服务商相关的设置不对，没有启动：' + e.message); process.exit(1); }
  app = createApp({ dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'zairyu.db'), sender, appUrl: rem.appUrl, billing: bc, notify: nc });
  app.server.listen(port, () => console.log('在留导航 后端已启动： http://localhost:' + port + ' （邮件：' + sender.name + '；提醒邮件：' + (rem.enabled ? '每 ' + rem.intervalMin + ' 分钟检查一次，日本时间 ' + rem.hour + ' 点以后发' : '定时任务没开') + '）'));
  // 每分钟：重试没发出去的邮件，清理过期的验证码和限流记录
  // 服务商：新咨询通知每分钟看一次，展示费（开账单、付款提醒、过了宽限期不再展示）每小时一轮；日志只有数量和错误说明
  const providers = () => { try { const r = app.providerTick(); if (r.billing && (r.billing.issued || r.billing.reminders || r.billing.hidden)) console.log('展示费：开出 ' + r.billing.issued + ' 张账单，' + r.billing.reminders + ' 封付款提醒，' + r.billing.hidden + ' 封不再展示的告知'); } catch (e) { console.error('服务商定时任务出错：' + scrub(e).slice(0, 200)); } };
  setTimeout(providers, 5000).unref();
  setInterval(() => { providers(); app.deliver(); try { app.purge(); } catch (e) { console.error(e); } }, 60 * 1000).unref();
  // 提醒邮件（REMINDERS_ENABLED=1 才开）：启动后先看一次，之后每隔 REMINDER_INTERVAL_MIN 分钟看一次；日本时间 REMINDER_HOUR 点之前不发，到点补跑一次。
  // 一天里看多少次都只发一次（去重在 reminder_sends 表）。日志只有数量。
  if (rem.enabled) {
    // 轮到的时候还没到 REMINDER_HOUR 点，定时器会另外等到那个点再跑一次（src/scheduler.js 的 startReminderTimer）
    startReminderTimer(rem, () => {
      try { const r = app.remind(); if (r.mails || r.errors) console.log('提醒邮件：新排了 ' + r.mails + ' 封（' + r.items + ' 条）' + (r.errors ? '，' + r.errors + ' 个账号处理出错' : '')); app.deliver(); } catch (e) { console.error('提醒邮件：这一轮出错：' + scrub(e).slice(0, 200)); }
    });
  }
}
