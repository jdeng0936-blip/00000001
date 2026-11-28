// 2026-11-27 复查后补的规则，每条对应复查里的一个问题：
// 别人不能拖住本人找回账号、换绑和解除有告知和冷静期、发件箱的记录不被别人删掉、过期的验证码不再发、
// 邮箱写法、多进程不重复发、库被占着时能等、定时器到点补跑、关了再开不丢这一档、旧条款的账号能收回、
// 提醒邮件不透露在留资格、不是期限的日子不写“到期”、删掉的数据不留在库文件里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createApp, EMAIL_LIMITS } = require('../src/server');
const { createStore } = require('../src/store');
const { createScheduler, startReminderTimer } = require('../src/scheduler');
const { deliverOutbox, TEXTS } = require('../src/mailer');
const { normalizeEmail, findSensitive } = require('../src/validate');
const createEngine = require('../src/engine');

const WIDE = { max: 100000, windowMs: 3600000 };
const LOOSE = { reqEmail: [WIDE], reqEmailAll: [WIDE], reqIp: [WIDE], reqUser: [WIDE], verIp: [WIDE], verUser: [WIDE] };
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-27T03:00:00Z'); // 日本时间 2026-11-27 12:00
const APP = 'https://navi.example.jp';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-hard-'));

// sent：每一封交给发件方式的邮件。opts.real 为真时装成真实发信（dev: false）。
async function start(opts) {
  opts = opts || {};
  let t = opts.t0 || T0;
  const clock = () => t, sent = opts.sent || []; // 自带发件方式的用例把同一个数组传进来
  const sender = opts.sender || { name: 'cap', dev: !opts.real, send: async (m) => { sent.push(m); return {}; } };
  const app = createApp(Object.assign({ adminToken: 'adm', clock, emailLimits: LOOSE, signupLimit: WIDE, appUrl: APP, sender }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, p, body, token, headers) => {
    const r = await fetch(base + p, { method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* 不是 JSON */ }
    return { status: r.status, body: json, headers: r.headers };
  };
  const codeTo = (to) => /验证码：(\d{6})/.exec(sent.filter((m) => m.to === to && /验证码：/.test(m.text)).pop().text)[1];
  const s = {
    app, call, sent, codeTo, clock,
    advance: (ms) => { t += ms; },
    newUser: async (profile) => {
      const u = (await call('POST', '/api/users', { accept: app.termsVersion })).body;
      if (profile) assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, profile, u.token)).status, 200);
      return u;
    },
    // 更换、解除之前验证原来的邮箱，返回确认 proof
    proveOld: async (u, action) => {
      const old = app.store.getEmail(u.id).email;
      const r = await call('POST', `/api/users/${u.id}/email/old`, { action }, u.token);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await app.deliver();
      const v = await call('POST', `/api/users/${u.id}/email/old/verify`, { action, challengeId: r.body.challengeId, code: codeTo(old) }, u.token);
      assert.equal(v.status, 200, JSON.stringify(v.body));
      return v.body.proof;
    },
    unbind: async (u) => call('DELETE', `/api/users/${u.id}/email`, app.store.getEmail(u.id) ? { proof: await s.proveOld(u, 'remove') } : null, u.token),
    // 绑定；账号上已经绑着邮箱时先验证原来的邮箱（换绑）
    bind: async (u, email, extra) => {
      const proof = app.store.getEmail(u.id) ? await s.proveOld(u, 'change') : undefined;
      const r = await call('POST', `/api/users/${u.id}/email`, { email, consent: true, proof }, u.token);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await app.deliver();
      return call('POST', `/api/users/${u.id}/email/verify`, Object.assign({ challengeId: r.body.challengeId, code: codeTo(email), proof }, extra || {}), u.token);
    },
    recover: async (email, headers) => {
      const r = await call('POST', '/api/auth/recover', { email }, null, headers);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await app.deliver();
      return call('POST', '/api/auth/recover/verify', { challengeId: r.body.challengeId, code: codeTo(email) }, null, headers);
    },
    stop: async () => { await app.deliver(); app.server.close(); app.server.closeAllConnections(); app.store.close(); }
  };
  return s;
}
const from = (ip) => ({ 'x-forwarded-for': ip });

// ---- 找回账号时不透露邮箱绑没绑定过：发送那一步做的事也一样多 ----
test('找回：邮箱没绑定过时也排一行占位，发送那一步对它做同样多的读写再删掉；占位行不出现在发件箱里', async () => {
  const s = await start();
  try {
    const u = await s.newUser(); assert.equal((await s.bind(u, 'known@example.com')).status, 200);
    await s.app.deliver();
    // 记下发送那一步调了存储层的哪些操作
    const log = []; const st = s.app.store;
    for (const k of ['claimNext', 'markSent', 'finishPad', 'markFailed', 'dropMail']) { const f = st[k]; st[k] = function (...a) { const r = f.apply(st, a); log.push(k === 'claimNext' ? (r ? 'claim' : 'claim:none') : k === 'finishPad' ? 'finish' : k === 'markSent' ? 'finish' : k); return r; }; }
    const steps = async (email) => { log.length = 0; const r = await s.call('POST', '/api/auth/recover', { email }); assert.equal(r.status, 202); await s.app.deliver(); return log.filter((x) => x !== 'claim:none').join(','); };
    const known = await steps('known@example.com'), unknown = await steps('nobody@example.com');
    assert.equal(known, 'claim,finish'); assert.equal(unknown, known, '两种情况发送那一步的读写次数一样');
    // 占位行不是邮件：没有交给发件方式，发件箱和管理接口里都看不到，处理完就删掉
    assert.equal(s.sent.filter((m) => m.to !== 'known@example.com').length, 0);
    assert.equal(st.listOutbox().filter((m) => m.kind === 'pad' || m.to === '').length, 0);
    const rows = (await s.call('GET', '/api/admin/outbox', null, 'adm')).body;
    assert.ok(rows.every((r) => r.to === 'known@example.com'));
    // 处理之前也看不到（还在排队的占位行不算邮件）
    st.enqueuePad(); assert.equal(st.listOutbox().length, rows.length);
    assert.deepEqual(await s.app.deliver(), { sent: 0, failed: 0, dropped: 0 });
  } finally { await s.stop(); }
});

// ---- 别人知道你的邮箱，也拖不住你找回账号 ----
test('找回：别人对着同一个邮箱索取验证码、乱试验证码，本人手里的验证码照样能用，本人也照样能再发', async () => {
  const s = await start({ emailLimits: {}, trustProxy: true });
  try {
    const u = await s.newUser(); assert.equal((await s.bind(u, 'victim@example.com')).status, 200);
    s.advance(2 * MIN);
    const mine = await s.call('POST', '/api/auth/recover', { email: 'victim@example.com' }, null, from('1.1.1.1'));
    await s.app.deliver();
    const myCode = s.codeTo('victim@example.com');
    // 别人从另一个来源地址对同一个邮箱索取 3 次：都受理，但各算各的
    const theirs = [];
    for (let i = 0; i < 3; i++) { s.advance(61 * 1000); const r = await s.call('POST', '/api/auth/recover', { email: 'victim@example.com' }, null, from('6.6.6.6')); assert.equal(r.status, 202); theirs.push(r.body.challengeId); }
    // 他拿自己要来的验证码编号乱试：每个编号错 5 次作废，之后怎么试都是 422；这些次数不记在邮箱上
    for (const id of theirs) for (let i = 0; i < 6; i++) assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: id, code: String(100000 + i) }, null, from('6.6.6.6'))).status, 422);
    // 他不知道本人那个验证码的编号，耗不掉它的次数；本人的验证码没有因为别人重新索取而作废
    const ok = await s.call('POST', '/api/auth/recover/verify', { challengeId: mine.body.challengeId, code: myCode }, null, from('1.1.1.1'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.id, u.id);
    // 别人把自己那个来源地址的次数用完（1 小时 5 次）之后，本人照样能再发、再找回
    for (let i = 0; i < 2; i++) { s.advance(61 * 1000); assert.equal((await s.call('POST', '/api/auth/recover', { email: 'victim@example.com' }, null, from('6.6.6.6'))).status, 202); }
    s.advance(61 * 1000);
    assert.equal((await s.call('POST', '/api/auth/recover', { email: 'victim@example.com' }, null, from('6.6.6.6'))).status, 429);
    assert.equal((await s.recover('victim@example.com', from('1.1.1.1'))).status, 200, '本人不受别人的次数影响');
    // 用掉一个之后，同一个邮箱其余没用的找回验证码一并作废
    const a = await s.call('POST', '/api/auth/recover', { email: 'victim@example.com' }, null, from('2.2.2.2')); await s.app.deliver(); const ca = s.codeTo('victim@example.com');
    const b = await s.call('POST', '/api/auth/recover', { email: 'victim@example.com' }, null, from('3.3.3.3')); await s.app.deliver(); const cb = s.codeTo('victim@example.com');
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: b.body.challengeId, code: cb }, null, from('3.3.3.3'))).status, 200);
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: a.body.challengeId, code: ca }, null, from('2.2.2.2'))).status, 422);
  } finally { await s.stop(); }
});

test('绑定：别的账号对着同一个邮箱索取验证码，不会让你的验证码作废，也耗不掉你的次数；自己重新发送时旧的作废', async () => {
  const s = await start({ emailLimits: {}, trustProxy: true });
  try {
    const me = await s.newUser(), other = await s.newUser(), E = (u) => `/api/users/${u.id}/email`;
    const mine = await s.call('POST', E(me), { email: 'new@example.com', consent: true }, me.token, from('1.1.1.1'));
    await s.app.deliver(); const myCode = s.codeTo('new@example.com');
    const r = await s.call('POST', E(other), { email: 'new@example.com', consent: true }, other.token, from('6.6.6.6'));
    assert.equal(r.status, 202, '别的账号对同一个邮箱各算各的');
    assert.equal((await s.call('POST', E(other), { email: 'new@example.com', consent: true }, other.token, from('6.6.6.6'))).status, 429, '同一个账号 1 分钟 1 次');
    assert.equal((await s.call('POST', E(me) + '/verify', { challengeId: mine.body.challengeId, code: myCode }, me.token, from('1.1.1.1'))).status, 200, '我的验证码没有被别人的请求作废');
    // 自己重新发送：自己的旧验证码作废
    const x = await s.newUser();
    const r1 = await s.call('POST', E(x), { email: 'x1@example.com', consent: true }, x.token, from('4.4.4.4')); await s.app.deliver(); const c1 = s.codeTo('x1@example.com');
    const r2 = await s.call('POST', E(x), { email: 'x2@example.com', consent: true }, x.token, from('4.4.4.4')); await s.app.deliver(); const c2 = s.codeTo('x2@example.com');
    assert.equal((await s.call('POST', E(x) + '/verify', { challengeId: r1.body.challengeId, code: c1 }, x.token, from('4.4.4.4'))).status, 422);
    assert.equal((await s.call('POST', E(x) + '/verify', { challengeId: r2.body.challengeId, code: c2 }, x.token, from('4.4.4.4'))).status, 200);
  } finally { await s.stop(); }
});

test('限流的默认值：没有“每个邮箱合计的核对次数”这一项（它能被别人耗光）；每个邮箱合计的发送上限比各人自己的上限宽', () => {
  assert.equal(EMAIL_LIMITS.verEmail, undefined);
  assert.deepEqual(EMAIL_LIMITS.reqEmail.map((r) => r.max), [1, 5, 10]);
  assert.deepEqual(EMAIL_LIMITS.reqEmailAll.map((r) => [r.max, r.windowMs / HOUR]), [[12, 1], [30, 24]]);
});

// ---- 换绑、解除：原来的邮箱收到告知；刚找回的设备有 24 小时冷静期 ----
test('换绑：原来的邮箱收到一封告知（不写新邮箱），发出后记录里不留旧地址；还没发出去的“新设备登录”通知照发', async () => {
  let hold = false; const got = [];
  const sender = { name: 'cap', dev: true, send: async (m) => { if (hold && /新设备/.test(m.subject)) throw new Error('稍后'); got.push(m); return {}; } };
  const s = await start({ sender, sent: got });
  try {
    const u = await s.newUser(); assert.equal((await s.bind(u, 'old@example.com')).status, 200);
    // 有人用邮箱找回了一次：通知邮件暂时发不出去，还在排队
    hold = true;
    assert.equal((await s.recover('old@example.com')).status, 200);
    await s.app.deliver();
    assert.equal(s.app.store.listOutbox({ to: 'old@example.com' }).filter((m) => m.kind === 'notice' && m.status === 'queued').length, 1);
    // 注册时的设备换绑到新邮箱
    const v = await s.bind(u, 'new@example.com');
    assert.equal(v.status, 200); assert.equal(v.body.email, 'n***@example.com');
    hold = false; s.advance(2 * MIN); await s.app.deliver();
    const toOld = got.filter((m) => m.to === 'old@example.com').map((m) => m.subject);
    assert.ok(toOld.includes('【在留导航】有一台新设备登录了你的账号'), '排着队的登录通知没有被删掉');
    const bye = got.find((m) => m.to === 'old@example.com' && /已经更换/.test(m.subject));
    assert.ok(bye, '原来的邮箱收到“已经更换”的告知');
    assert.ok(!bye.text.includes('new@example.com') && !bye.text.includes('n***'), '告知里不写新邮箱');
    assert.match(bye.text, /2026-11-27 12:0\d（日本时间）/); assert.doesNotMatch(bye.text, /https?:\/\//); assert.equal(findSensitive(bye.text), null);
    assert.ok(!JSON.stringify(s.app.store.listOutbox()).includes('old@example.com'), '发完之后发件箱里不留旧地址');
    assert.equal(s.app.store.emailFootprint('no-such-user', 'old@example.com').rate, 0);
    // 同一个邮箱再验证一次不算换绑，不发告知
    const n = got.length; assert.equal((await s.bind(u, 'new@example.com')).status, 200); await s.app.deliver();
    assert.equal(got.slice(n).filter((m) => /已经更换|已经解除/.test(m.subject)).length, 0);
    // 留痕里没有邮箱
    assert.ok(!JSON.stringify(s.app.store.auditRows()).includes('example.com'));
    for (const m of [TEXTS.emailChanged(T0), TEXTS.emailRemoved(T0)]) { assert.equal(findSensitive(m.subject), null); assert.equal(findSensitive(m.text), null); assert.doesNotMatch(m.text, /https?:\/\//); }
  } finally { await s.stop(); }
});

test('告知邮件一直发不出去：放弃时也清掉旧地址和正文', async () => {
  const s = await start({ sender: { name: 'down', dev: true, send: async (m) => { if (/已经解除/.test(m.subject)) throw new Error('550 <' + m.to + '> 不收'); return {}; } } });
  try {
    const st = s.app.store, u = st.createUser(s.app.termsVersion);
    st.bindEmail(u.id, 'gone@example.com', s.app.termsVersion);
    const proof = st.createProof(u.id, 'gone@example.com', 'remove', 60 * 1000); // 这个发件方式不留邮件，确认直接在库里发
    assert.equal((await s.call('DELETE', `/api/users/${u.id}/email`, { proof }, u.token)).status, 204);
    for (const waitMin of [0, 1, 5, 30, 120, 720, 720]) { s.advance(waitMin * MIN + 1000); await s.app.deliver(); }
    const rows = st.listOutbox().filter((m) => m.kind === 'last');
    assert.deepEqual(rows.map((m) => [m.status, m.to, m.body]), [['failed', '', '']]);
    assert.ok(!JSON.stringify(st.listOutbox()).includes('gone@example.com'));
  } finally { await s.stop(); }
});

test('刚用邮箱找回登录的设备 24 小时内不能换绑或解除邮箱；注册时的设备可以；过了 24 小时可以；让其他设备退出不受限', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    assert.equal((await s.bind(u, 'owner@example.com')).status, 200);
    const d2 = (await s.recover('owner@example.com')).body.token;
    await s.app.deliver(); const n = s.sent.length;
    // 找回来的设备：换绑的两步、解除都是 403，说明原因；什么都没改，也没发邮件
    const req = await s.call('POST', E, { email: 'attacker@evil.example', consent: true }, d2);
    assert.equal(req.status, 403); assert.match(req.body.error, /刚用邮箱找回登录的，24 小时内不能更换或解除绑定的邮箱/); assert.match(req.body.error, /请在24小时后再试/);
    assert.equal((await s.call('POST', E + '/verify', { challengeId: 'x', code: '123456' }, d2)).status, 403);
    assert.equal((await s.call('DELETE', E, null, d2)).status, 403);
    // 验证原来的邮箱这一步也拦下（不给原来的邮箱发验证码）
    assert.equal((await s.call('POST', E + '/old', { action: 'change' }, d2)).status, 403);
    assert.equal((await s.call('POST', E + '/old', { action: 'remove' }, d2)).status, 403);
    assert.equal((await s.call('POST', E + '/old/verify', { action: 'remove', challengeId: 'x', code: '123456' }, d2)).status, 403);
    await s.app.deliver();
    assert.equal(s.app.store.getEmail(u.id).email, 'owner@example.com'); assert.equal(s.sent.length, n);
    // 看邮箱、开关提醒、看设备不受限
    assert.equal((await s.call('GET', E, null, d2)).status, 200);
    assert.equal((await s.call('PUT', E + '/reminders', { on: true }, d2)).status, 200);
    // 本人收到登录通知后，在注册时的设备上让它退出：邮箱还在自己手里
    assert.equal((await s.call('DELETE', `/api/users/${u.id}/sessions`, null, u.token)).status, 204);
    assert.equal((await s.call('GET', E, null, d2)).status, 401);
    // 反过来：对方先把注册时的设备退出了，本人还能用邮箱再找回，再把对方退出
    const d3 = (await s.recover('owner@example.com')).body.token;
    assert.equal((await s.call('DELETE', `/api/users/${u.id}/sessions`, null, d3)).status, 204, '让其他设备退出不受冷静期限制（丢了手机的人马上要用）');
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, u.token)).status, 401);
    const d4 = (await s.recover('owner@example.com')).body.token;
    assert.equal((await s.call('DELETE', `/api/users/${u.id}/sessions`, null, d4)).status, 204);
    assert.equal((await s.call('GET', E, null, d3)).status, 401);
    assert.equal(s.app.store.getEmail(u.id).email, 'owner@example.com', '24 小时内邮箱始终换不掉');
    // 差一分钟到 24 小时还不行；过了就可以
    s.advance(DAY - MIN);
    const soon = await s.call('POST', E + '/old', { action: 'remove' }, d4);
    assert.equal(soon.status, 403); assert.match(soon.body.error, /请在1分钟后再试/);
    s.advance(2 * MIN);
    // 过了 24 小时：和别的设备一样，先验证原来的邮箱再换绑、解除
    const d4u = { id: u.id, token: d4 };
    assert.equal((await s.call('DELETE', E, null, d4)).status, 403, '冷静期过了也要先验证原来的邮箱');
    assert.equal((await s.bind(d4u, 'owner2@example.com')).status, 200);
    assert.equal((await s.unbind(d4u)).status, 204);
    // 账号上没有绑着邮箱时，刚找回的设备可以绑（没有可以被换掉的东西）；注册时的设备没有冷静期（换绑、解除照样要验证原来的邮箱）
    const v = await s.newUser(); assert.equal((await s.bind(v, 'v@example.com')).status, 200);
    assert.equal((await s.bind(v, 'v2@example.com')).status, 200);
    assert.equal((await s.unbind(v)).status, 204);
  } finally { await s.stop(); }
});

// ---- 发件箱的记录不被别的账号删掉 ----
test('没绑定邮箱的账号解除邮箱、删除账号，不会删掉别人的发件记录（真实发信下地址已清空的那些行）', async () => {
  const s = await start({ real: true });
  try {
    const a = await s.newUser({ status: 'work', addr: '2026-11-20', entry: '2026-11-18', exp: '2028-11-20', ins: true });
    assert.equal((await s.bind(a, 'a@example.com', { remindOptIn: true })).status, 200);
    s.app.remind(); await s.app.deliver();
    // a 的记录：发完的验证码邮件（地址已清空）、发完的提醒邮件
    const before = s.app.store.listOutbox().map((m) => [m.kind, m.status, m.to]);
    assert.deepEqual(before, [['code', 'sent', ''], ['reminder', 'sent', 'a@example.com']]);
    const sends = s.app.store.listReminderSends(a.id);
    for (const how of ['email', 'user']) {
      const y = await s.newUser(); // 没绑定邮箱
      assert.equal((await s.call('DELETE', `/api/users/${y.id}` + (how === 'email' ? '/email' : ''), null, y.token)).status, 204);
      assert.deepEqual(s.app.store.listOutbox().map((m) => [m.kind, m.status, m.to]), before, how);
    }
    assert.deepEqual(s.app.store.listReminderSends(a.id), sends);
    assert.ok(s.app.store.listOutbox().some((m) => m.id === sends[0].outboxId), '账本指向的那封邮件的记录还在');
  } finally { await s.stop(); }
});

// ---- 邮箱的写法 ----
test('邮箱的写法：日本手机运营商发过的连点、点在 @ 前的地址和带单引号的地址收；数字顶级域名、一个字母的顶级域名、% 转发、横线开头的不收', () => {
  const ok = { 'a..b@docomo.ne.jp': 'a..b@docomo.ne.jp', 'abc.@ezweb.ne.jp': 'abc.@ezweb.ne.jp', "O'Brien@Example.com": "o'brien@example.com", ' Li.Hua+jp@Example.COM ': 'li.hua+jp@example.com', 'a_b-c@sub.example.co.jp': 'a_b-c@sub.example.co.jp', 'x@a-b.example.jp': 'x@a-b.example.jp' };
  for (const k of Object.keys(ok)) assert.equal(normalizeEmail(k), ok[k], k);
  for (const bad of ['a@1.2', 'a@b.c', 'a@example.123', 'user%x.com@relay.com', '-oQ@x.com', '.a@x.com', 'a@-x.com', 'a@x-.com', 'a@x..com', 'a@.com', 'a@com', 'a b@x.com', '"a b"@x.com', '<a>@x.com', 'a@x.com\r\nRCPT TO:<b@y.com>', 'a@x.com>', 'a@@x.com', '@x.com', 'x'.repeat(65) + '@x.com', '邮箱@example.com', 'a@例え.jp']) {
    assert.throws(() => normalizeEmail(bad), (e) => e.status === 422 && /写法不对/.test(e.message), JSON.stringify(bad));
  }
});

test('带单引号、连点的地址能走完绑定和找回；错误说明里这种地址也整个换掉', async () => {
  const { scrub, buildMessage } = require('../src/mailer');
  const s = await start();
  try {
    for (const addr of ["o'brien@example.com", 'a..b@docomo.ne.jp', 'abc.@ezweb.ne.jp']) {
      const u = await s.newUser();
      const v = await s.bind(u, addr); assert.equal(v.status, 200, addr); assert.equal(v.body.email, addr[0] + '***@' + addr.split('@')[1]);
      assert.equal((await s.recover(addr)).body.id, u.id, addr);
      assert.match(buildMessage({ to: addr, subject: 's', text: 't' }, 'no-reply@example.jp'), new RegExp('\\r\\nTo: ' + addr.replace(/[.']/g, '\\$&') + '\\r\\n'));
    }
    assert.equal(scrub(new Error("550 <o'brien@example.com> rejected, a..b@docomo.ne.jp too")), '550 <［邮箱］> rejected, ［邮箱］ too');
  } finally { await s.stop(); }
});

// ---- 两个进程一起发：一轮发得再久也不重复 ----
test('发件箱一封一封地占：一轮发了十几分钟，另一个进程中途来发，也没有哪一封发两次', async () => {
  const dir = tmp(), file = path.join(dir, 'a.db');
  let t = T0; const clock = () => t;
  const A = createStore(file, { clock }), B = createStore(file, { clock });
  try {
    for (let i = 0; i < 4; i++) A.enqueueMail({ kind: 'notice', to: `m${i}@example.com`, subject: 's', body: 'b' });
    const sentA = [], sentB = [];
    const senderB = { name: 'b', dev: true, send: async (m) => { sentB.push(m.to); return {}; } };
    // 进程 A 每发一封要 4 分钟；发到第 3、第 4 封时（已经过了 10 分钟）进程 B 来发一轮
    const senderA = { name: 'a', dev: true, send: async (m) => { t += 4 * MIN; sentA.push(m.to); if (sentA.length >= 3) await deliverOutbox(B, senderB); return {}; } };
    const r = await deliverOutbox(A, senderA);
    // 以前：A 一次把 4 封都占下（只占 10 分钟），发到第 3 封时已经过期，B 把第 3、4 封又发了一遍
    assert.deepEqual(sentA, ['m0@example.com', 'm1@example.com', 'm2@example.com'], 'A 正在发的那一封 B 抢不走');
    assert.deepEqual(sentB, ['m3@example.com'], '还没人占的那一封 B 可以发');
    assert.equal(r.sent, 3);
    assert.deepEqual(sentA.concat(sentB).sort(), ['m0@example.com', 'm1@example.com', 'm2@example.com', 'm3@example.com'], '每一封正好发一次');
    assert.ok(A.listOutbox().every((m) => m.status === 'sent' && m.tries === 1));
    sentB.length = 0;
    // 发到一半进程没了：占着的那一封过了占用时间由别的进程接着发
    A.enqueueMail({ kind: 'notice', to: 'crash@example.com', subject: 's', body: 'b' });
    assert.equal(A.claimNext().to, 'crash@example.com');
    assert.deepEqual(await deliverOutbox(B, senderB), { sent: 0, failed: 0, dropped: 0 });
    t += 10 * MIN + 1000;
    assert.equal((await deliverOutbox(B, senderB)).sent, 1); assert.deepEqual(sentB, ['crash@example.com']);
    // 发一封最慢要多久，占用时间就跟着放长（MAIL_TIMEOUT_MS 很大时）
    A.enqueueMail({ kind: 'notice', to: 'slow@example.com', subject: 's', body: 'b' });
    let seen = 0;
    await deliverOutbox(A, { name: 'slow', dev: true, timeoutMs: 20 * MIN, send: async () => { t += 20 * MIN; seen = (await deliverOutbox(B, senderB)).sent; return {}; } });
    assert.equal(seen, 0);
  } finally { A.close(); B.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 另一个进程正占着库 ----
test('另一个进程正在写库时打开数据库：等它写完，不报“database is locked”', async () => {
  const dir = tmp(), file = path.join(dir, 'a.db');
  createStore(file).close();
  // 子进程占住整个库 1.5 秒
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN EXCLUSIVE'); db.exec("INSERT INTO audit (at, action) VALUES ('x', 'held')");
    console.log('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 1500);
  `, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((ok, fail) => { child.stdout.once('data', ok); child.once('error', fail); });
    const t0 = Date.now();
    const st = createStore(file); // 以前在建表那一步直接报错
    assert.ok(Date.now() - t0 >= 500, '是等到对方写完才打开的');
    assert.ok(st.createUser('v').id);
    assert.equal(st.auditRows().filter((r) => r.action === 'held').length, 1);
    st.close();
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('npm run remind：数据库打不开时说清楚原因后退出，不打印调用栈；一个账号撞上“库正忙”时再试，不算出错', () => {
  const dir = tmp();
  try {
    const env = Object.assign({}, process.env, { DB_FILE: path.join(dir, 'no-such-dir', 'a.db'), MAIL_SENDER: 'outbox' }); delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'scheduler.js')], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /^提醒邮件：数据库打不开：/); assert.doesNotMatch(r.stderr, /\n\s+at /, '没有调用栈');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // 处理某个账号时库正忙（另一个进程占着，等了也没等到）：再试，最多三次
  const st = createStore(), u = st.createUser('v');
  const p = Object.assign({}, st.EMPTY_PROFILE, { status: 'work', addr: '2026-11-20', entry: '2026-11-18', exp: '2028-11-20', ins: true });
  st.saveUser(Object.assign(st.getUser(u.id), { profile: p }), 'test'); st.bindEmail(u.id, 'busy@example.com', 'v'); st.setRemindOptIn(u.id, true);
  const tx = st.tx; let fails = 2;
  st.tx = function (fn) { if (fails > 0) { fails--; throw new Error('database is locked'); } return tx.call(st, fn); };
  const errs = []; const orig = console.error; console.error = (m) => errs.push(m);
  try {
    assert.deepEqual(createScheduler({ store: st, appUrl: APP, clock: () => T0 }).runOnce(), { users: 1, mails: 1, items: 1, errors: 0 });
    // 一直忙：这个账号这一轮算出错（下一轮再来），别的错误不重试
    fails = 99;
    assert.equal(createScheduler({ store: st, appUrl: APP, clock: () => T0 + 6 * DAY }).runOnce().errors, 1);
    assert.equal(fails, 96, '一共试三次');
  } finally { console.error = orig; st.close(); }
});

// ---- 定时器 ----
test('进程里的定时器：间隔 1440 分钟、启动在 REMINDER_HOUR 点之前，也会在到点时跑；到点之后启动的按间隔跑', () => {
  // 假的时钟和定时器
  const mk = (startMs) => {
    let now = startMs; const q = []; const runs = [];
    const deps = { now: () => now, setTimeout: (fn, ms) => { q.push({ at: now + ms, fn }); return {}; }, setInterval: (fn, ms) => { q.push({ at: now + ms, fn, every: ms }); return {}; } };
    const until = (end) => { for (;;) { q.sort((a, b) => a.at - b.at); const e = q[0]; if (!e || e.at > end) break; now = e.at; if (e.every) e.at += e.every; else q.shift(); e.fn(); } now = end; };
    const jst = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(5, 16).replace('T', ' ');
    return { deps, until, runs, run: () => runs.push(jst(now)), start: startMs };
  };
  // 08:30 启动，每 1440 分钟看一次，9 点以后才发：以前每次都落在 08:30，一封都发不出去
  let c = mk(Date.parse('2026-11-27T23:30:00Z')); // 日本时间 11-28 08:30
  startReminderTimer({ hour: 9, intervalMin: 1440 }, c.run, c.deps);
  c.until(c.start + 3 * DAY + 2 * HOUR);
  assert.deepEqual(c.runs, ['11-28 09:00', '11-29 09:00', '11-30 09:00', '12-01 09:00']);
  // 09:30 启动：启动后 5 秒跑一次，之后每天这个时候
  c = mk(Date.parse('2026-11-28T00:30:00Z'));
  startReminderTimer({ hour: 9, intervalMin: 1440 }, c.run, c.deps);
  c.until(c.start + 2 * DAY + HOUR);
  assert.deepEqual(c.runs, ['11-28 09:30', '11-29 09:30', '11-30 09:30']);
  // 每 3 小时看一次、23 点以后才发：0、3、…、21 点都不到点，另外等到 23 点跑
  c = mk(Date.parse('2026-11-27T15:00:00Z')); // 日本时间 11-28 00:00
  startReminderTimer({ hour: 23, intervalMin: 180 }, c.run, c.deps);
  c.until(c.start + 2 * DAY);
  assert.deepEqual(c.runs, ['11-28 23:00', '11-29 23:00']);
  // 默认（每 60 分钟、9 点）：9 点以后每小时一次，9 点之前不跑、也不会定出一堆重复的闹钟
  c = mk(Date.parse('2026-11-27T15:00:00Z'));
  startReminderTimer({ hour: 9, intervalMin: 60 }, c.run, c.deps);
  c.until(c.start + DAY - 1);
  assert.equal(c.runs[0], '11-28 09:00'); assert.equal(c.runs.length, 16, c.runs.join(','));
});

// ---- 关了再开 ----
test('关掉提醒又打开、退订后又打开：还没发出去的那一档重新排上；已经发出去的不重发', async () => {
  let hold = true; const got = [];
  const sender = { name: 'fake', dev: true, send: async (m) => { if (/件事/.test(m.subject)) { if (hold) throw new Error('稍后'); got.push(m.to); } return {}; } };
  const s = await start({ sender });
  try {
    const P = { status: 'work', addr: '2026-11-20', entry: '2026-11-18', exp: '2028-11-20', ins: true };
    const st = s.app.store, mk = (email) => { const u = st.createUser(s.app.termsVersion); st.saveUser(Object.assign(st.getUser(u.id), { profile: Object.assign({}, st.EMPTY_PROFILE, P) }), 'test'); st.bindEmail(u.id, email, s.app.termsVersion); st.setRemindOptIn(u.id, true); return u; };
    const a = mk('a@example.com'), b = mk('b@example.com'), c = mk('c@example.com');
    const R = (u) => `/api/users/${u.id}/email/reminders`;
    assert.equal(s.app.remind().mails, 3); await s.app.deliver(); // 三封都发不出去，在排队
    // a 关掉又打开；b 点了退订又打开；c 不动
    assert.equal((await s.call('PUT', R(a), { on: false }, a.token)).status, 200);
    assert.deepEqual(st.listReminderSends(a.id), [], '没发出去的这一档不记账');
    assert.equal((await s.call('PUT', R(a), { on: true }, a.token)).status, 200);
    const tok = /unsubscribe\?t=([\w-]+)/.exec(st.listOutbox({ to: 'b@example.com' })[0].body)[1];
    assert.equal((await s.call('POST', '/api/unsubscribe?t=' + tok)).status, 200);
    assert.equal((await s.call('PUT', R(b), { on: true }, b.token)).status, 200);
    s.advance(2 * MIN); hold = false;
    assert.deepEqual([s.app.remind().mails], [2], 'a 和 b 的这一档重新排上（以前这一档就丢了，要等到前 1 天才有下一封）');
    await s.app.deliver();
    assert.deepEqual(got.slice().sort(), ['a@example.com', 'b@example.com', 'c@example.com'], '每人正好一封');
    // 已经发出去之后再关了又开：不重发
    assert.equal((await s.call('PUT', R(a), { on: false }, a.token)).status, 200);
    assert.equal((await s.call('PUT', R(a), { on: true }, a.token)).status, 200);
    assert.equal(s.app.remind().mails, 0); await s.app.deliver(); assert.equal(got.length, 3);
    assert.deepEqual(st.listReminderSends(a.id).map((r) => [r.stage, r.status]), [[7, 'sent']]);
  } finally { await s.stop(); }
});

// ---- 提醒邮件不透露在留资格；不是期限的日子不写“到期” ----
test('提醒邮件里不出现在留资格的名称：每种身份、每种事件算出来的邮件都查一遍；同一件事不同身份的邮件一字不差', () => {
  const eng = createEngine({ now: T0 });
  const names = Object.values(eng.STATUS_NAME).concat(['高度专门职', '家族滞在', '留学', '特定技能', '经营', '技术', '人文', '永住', '短期滞在', '1号', '就劳']);
  const st = createStore(), sch = createScheduler({ store: st, appUrl: APP, clock: () => T0 });
  const mailFor = (status, type) => {
    const u = st.createUser('v');
    // 11 月 27 日（日本时间）：住民登记 12-04、在留期满 12-01、入境满 6 个月 12-03 都在 7 天内
    st.saveUser(Object.assign(st.getUser(u.id), { profile: Object.assign({}, st.EMPTY_PROFILE, { status, addr: '2026-11-20', entry: '2026-06-03', exp: '2026-12-01', pr: true }) }), 'test');
    if (type) st.addEvent(u.id, { type, date: '2026-11-20' });
    const items = sch.dueItems(st.getUser(u.id), T0);
    return items.length ? TEXTS.reminder(items, APP, APP + '/api/unsubscribe?t=tok') : null;
  };
  try {
    let checked = 0;
    const by = {};
    for (const status of Object.keys(eng.STATUS_NAME)) for (const type of [null].concat(Object.keys(eng.EVRULES))) {
      const m = mailFor(status, type); if (!m) continue;
      checked++;
      for (const n of names) assert.ok(!(m.subject + m.text).includes(n), status + ' ' + type + ' 的邮件里出现了“' + n + '”');
      assert.equal(findSensitive(m.text.replace(/https:\/\/\S+/g, '')), null, status + ' ' + type);
      (by[type] = by[type] || {})[status] = m.text;
    }
    assert.ok(checked >= 30, '查了 ' + checked + ' 封');
    // 换工作：就劳、特定技能、留学、经营管理、高度专门职在页面上是三种不同的说明，邮件里完全一样
    const job = by.job_change;
    for (const s2 of ['ssw', 'student', 'biz', 'hsp']) assert.equal(job[s2], job.work, s2);
    assert.match(job.work, /所属机关有变动（离开或加入）/); assert.match(job.work, /nyuukokukanri10_00015\.html/); assert.match(job.work, /nyuukokukanri10_00014\.html/);
    assert.equal(by.divorce.family, by.divorce.spouse);
    assert.match(by.divorce.spouse, /离婚或配偶去世：14天内向入管提交配偶者的届出（以配偶身份在留的人要办）/);
    // 页面和接口上的说明没有变（仍然按身份写）
    const page = (status) => createEngine({ now: T0, profile: { status }, events: [{ type: 'job_change', date: '2026-11-20' }] }).reminders().find((r) => r.tag === '事件');
    assert.match(page('hsp').txt, /高度专门职1号イ、ロ/); assert.match(page('student').txt, /学校、机构/); assert.equal(page('hsp').mail, page('work').mail);
  } finally { st.close(); }
});

test('不是期限的日子（在留更新的准备、入境满 6 个月去银行）邮件里不写“到期”，标题是“要留意”；真正的期限照旧写“到期”', async () => {
  const s = await start();
  try {
    const st = s.app.store;
    const mk = (email, profile) => { const u = st.createUser(s.app.termsVersion); st.saveUser(Object.assign(st.getUser(u.id), { profile: Object.assign({}, st.EMPTY_PROFILE, profile) }), 'test'); st.bindEmail(u.id, email, s.app.termsVersion); st.setRemindOptIn(u.id, true); return u; };
    // 在留期满 2027-03-04：3 个月前是 12-04（“确认可以开始申请的时期”）；入境 06-03：满 6 个月是 12-03
    mk('m@example.com', { status: 'work', entry: '2026-06-03', addr: '2026-06-05', exp: '2027-03-04', ins: true });
    const mails = () => st.listOutbox({ to: 'm@example.com' }).filter((m) => m.kind === 'reminder');
    s.app.remind(); await s.app.deliver();
    assert.equal(mails()[0].subject, '【在留导航】有 2 件事要留意');
    assert.match(mails()[0].body, /下面的事到了该留意的日子（写着“到期”的是期限，其余是该开始办或该留意的日子）：/);
    assert.match(mails()[0].body, /1\. 2026年12月3日（还有 6 天）\n {3}入境满6个月：去银行办理账户的居住者变更/);
    s.advance(6 * DAY); s.app.remind(); await s.app.deliver(); // 12 月 3 日
    assert.equal(mails()[1].subject, '【在留导航】有 2 件事要留意');
    assert.match(mails()[1].body, /2026年12月3日（今天）\n {3}入境满6个月/); assert.match(mails()[1].body, /2026年12月4日（明天）\n {3}在留更新：确认可以开始申请的时期/);
    s.advance(DAY); s.app.remind(); await s.app.deliver(); // 12 月 4 日
    assert.match(mails()[2].body, /2026年12月4日（今天）\n {3}在留更新：确认可以开始申请的时期/);
    for (const m of mails()) assert.doesNotMatch(m.subject + m.body.replace(/写着“到期”的是期限/, ''), /到期|快到期限/, '这几封里没有一件是期限');
    // 期限和别的日子在同一封里：期限那一条写“到期”，标题是“要留意”
    const mixed = TEXTS.reminder([{ due: '2026-12-04', daysLeft: 0, txt: '在留期满日', dl: true, src: null }, { due: '2026-12-04', daysLeft: 0, txt: '在留更新：开始准备材料', dl: false, src: null }, { due: '2026-12-05', daysLeft: 1, txt: '搬家', dl: true, src: null }], APP, APP + '/u');
    assert.equal(mixed.subject, '【在留导航】有 3 件事要留意');
    assert.match(mixed.text, /（今天到期）\n {3}在留期满日/); assert.match(mixed.text, /（今天）\n {3}在留更新：开始准备材料/); assert.match(mixed.text, /（明天到期）\n {3}搬家/);
    // 全是期限：照旧
    const all = TEXTS.reminder([{ due: '2026-12-04', daysLeft: 1, txt: '搬家', dl: true, src: null }], APP, APP + '/u');
    assert.equal(all.subject, '【在留导航】有 1 件事明天到期'); assert.match(all.text, /下面的事快到期限了：/);
    // 引擎标出的期限：法定期限、事件、在留期满日、确定申告截止；其余不是
    const e = createEngine({ now: T0, profile: { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-03-04' }, events: [{ type: 'move', date: '2026-11-25' }] });
    const dl = e.reminders().filter((r) => r.dl).map((r) => r.txt.split('：')[0].slice(0, 6)).sort();
    assert.deepEqual(dl, ['住民登记', '在留期满日', '搬家', '确定申告截止'].map((x) => x.slice(0, 6)).sort());
  } finally { await s.stop(); }
});

// ---- 删掉的数据不留在库文件里 ----
test('解除邮箱、删除账号之后，库文件的字节里找不到邮箱、账号编号、事件备注和邮件正文', async () => {
  const dir = tmp(), file = path.join(dir, 'a.db');
  const s = await start({ dbFile: file });
  try {
    const raw = () => fs.readFileSync(file).toString('latin1');
    const has = (text) => raw().includes(Buffer.from(text, 'utf8').toString('latin1'));
    const u = await s.newUser({ status: 'work', addr: '2026-11-20', entry: '2026-11-18', exp: '2028-11-20', ins: true });
    const keep = await s.newUser(); assert.equal((await s.bind(keep, 'keep-me@example.com')).status, 200);
    assert.equal((await s.bind(u, 'first-addr@example.com', { remindOptIn: true })).status, 200);
    assert.equal((await s.call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-11-25', note: '搬到练马区的备注XYZZY' }, u.token)).status, 201);
    s.app.remind(); await s.app.deliver();
    // 存在服务器上的助手对话记录
    s.app.store.saveChat(u.id, [{ role: 'user', content: '助手对话里的话QWXZ' }, { role: 'assistant', content: '助手的回答QWXZ' }]);
    assert.ok(has('first-addr@example.com') && has(u.id) && has('搬到练马区的备注XYZZY') && has('住民登记：定下住所后14天内到区役所办理') && has('助手对话里的话QWXZ'), '删除之前都在文件里');
    // 解除邮箱：地址立即从文件里消失（最后一封告知发出之后）
    assert.equal((await s.unbind(u)).status, 204);
    await s.app.deliver();
    assert.equal(has('first-addr@example.com'), false, '解除后库文件里没有这个地址');
    // 删除账号
    assert.equal((await s.bind(u, 'second-addr@example.com')).status, 200);
    assert.equal((await s.call('DELETE', `/api/users/${u.id}`, null, u.token)).status, 204);
    assert.equal(has('second-addr@example.com'), false); assert.equal(has(u.id), false, '账号编号'); assert.equal(has('搬到练马区的备注XYZZY'), false, '事件备注');
    assert.equal(has('助手对话里的话QWXZ') || has('助手的回答QWXZ'), false, '助手的对话记录');
    assert.ok(has('keep-me@example.com'), '别人的数据还在');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 说明文字和实际一致 ----
test('隐私政策和页面上的说明：官方页面的链接是“有的才带”；列出了全部几种邮件；写明提醒邮件不写在留资格的类型', () => {
  const read = (f) => require('./web-source').pageSource(f);
  const privacy = read('privacy.html'), index = read('index.html');
  assert.match(index, /REMIND_TEXT="[^"]*有官方页面的会带上链接/); assert.doesNotMatch(index, /REMIND_TEXT="[^"]*并带官方页面和退订的链接/);
  assert.doesNotMatch(privacy, /并带官方页面的链接、打开应用的链接和退订链接/);
  for (const kind of ['验证码', '有新设备登录', '这个邮箱已经绑定过账号', '邮箱已经更换', '邮箱已经解除']) assert.ok(privacy.includes(kind), '隐私政策里应当提到“' + kind + '”这种邮件');
  assert.match(privacy, /不写你的姓名、在留资格的类型/);
  assert.match(privacy, /24 小时内不能更换或解除/);
});
