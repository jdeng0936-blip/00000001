// 邮箱绑定、找回账号、别的设备的登录、条款改版后的重新同意。邮件不联网，从发件箱（outbox）里读。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, TERMS_VERSION: V } = require('../src/server');
const { createStore } = require('../src/store');
const { findSensitive } = require('../src/validate');

const WIDE = { max: 100000, windowMs: 3600000 };
// 不测限流的用例把限流放宽；验证码错 5 次作废这一条不受影响
const LOOSE = { reqEmail: [WIDE], reqIp: [WIDE], reqUser: [WIDE], verIp: [WIDE], verEmail: [WIDE], verUser: [WIDE] };
async function start(opts) {
  let t = Date.parse('2026-11-27T03:00:00Z');
  const clock = () => t;
  const app = createApp(Object.assign({ now: '2026-11-27', adminToken: 'adm', clock, emailLimits: LOOSE, signupLimit: WIDE }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, path, body, token, headers) => {
    const r = await fetch(base + path, { method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  const newUser = async () => (await call('POST', '/api/users', { accept: app.termsVersion })).body;
  // 发到某个邮箱的最后一封邮件，和里面的验证码
  const lastMail = (to) => app.store.listOutbox({ to }).pop();
  const codeIn = (mail) => (/验证码：(\d{6})/.exec(mail.body) || [])[1];
  const bind = async (u, email) => {
    const r = await call('POST', `/api/users/${u.id}/email`, { email, consent: true }, u.token);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const v = await call('POST', `/api/users/${u.id}/email/verify`, { challengeId: r.body.challengeId, code: codeIn(lastMail(email)) }, u.token);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.body;
  };
  const recover = async (email) => {
    const r = await call('POST', '/api/auth/recover', { email });
    assert.equal(r.status, 202);
    return call('POST', '/api/auth/recover/verify', { challengeId: r.body.challengeId, code: codeIn(lastMail(email)) });
  };
  return { app, base, call, newUser, lastMail, codeIn, bind, recover, advance: (ms) => { t += ms; }, stop: async () => { await app.deliver(); app.server.close(); app.server.closeAllConnections(); app.store.close(); } };
}
const MIN = 60 * 1000;

test('绑定邮箱：要先同意；验证码发到邮箱，输对了才绑定；之后只显示打码的地址', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    assert.deepEqual((await s.call('GET', E, null, u.token)).body, { email: null, verified: false, remindOptIn: false });
    assert.equal((await s.call('GET', E)).status, 401, '不带令牌不能看');
    const noConsent = await s.call('POST', E, { email: 'li@example.com' }, u.token);
    assert.equal(noConsent.status, 422); assert.match(noConsent.body.error, /同意/);
    assert.equal(s.app.store.listOutbox().length, 0, '没同意就不发邮件');
    // 写法：大小写和首尾空白不影响；写法不对的拒绝
    for (const bad of ['', 'abc', 'a@b', 'a b@example.com', 'a@@example.com', 'a..b@example.com', 'a@example..com', '<a>@example.com', 'a@example.com\nbcc: x@y.z', 'x'.repeat(250) + '@example.com', 123, null]) {
      assert.equal((await s.call('POST', E, { email: bad, consent: true }, u.token)).status, 422, JSON.stringify(bad));
    }
    const r = await s.call('POST', E, { email: '  Li.Hua+jp@Example.COM ', consent: true }, u.token);
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.body).sort(), ['challengeId', 'expiresInSec']); assert.equal(r.body.expiresInSec, 600);
    assert.ok(!JSON.stringify(r.body).match(/\d{6}/) || !JSON.stringify(r.body).includes(s.codeIn(s.lastMail('li.hua+jp@example.com'))), '验证码不在响应里');
    const mail = s.lastMail('li.hua+jp@example.com');
    assert.equal(mail.kind, 'code'); assert.match(mail.subject, /验证码/); assert.doesNotMatch(mail.subject, /\d{6}/, '验证码不放在标题里');
    assert.equal(mail.status, 'sent', '默认的发件方式不联网，直接记为已发');
    assert.equal((await s.call('GET', E, null, u.token)).body.email, null, '没输验证码之前不算绑定');
    const v = await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code: s.codeIn(mail) }, u.token);
    assert.equal(v.status, 200); assert.deepEqual(v.body, { email: 'l***@example.com', verified: true, remindOptIn: false });
    assert.deepEqual((await s.call('GET', E, null, u.token)).body, { email: 'l***@example.com', verified: true, remindOptIn: false });
    assert.equal(s.app.store.getEmail(u.id).email, 'li.hua+jp@example.com', '库里存的是转成小写、去掉空白的地址');
    assert.ok(!JSON.stringify((await s.call('GET', `/api/users/${u.id}`, null, u.token)).body).includes('example.com'), '读取账号时不带出邮箱');
  } finally { await s.stop(); }
});

test('验证码：库里只有哈希；错 5 次作废，之后输对也不行；所有失败都是同一个 422', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    const r = await s.call('POST', E, { email: 'a@example.com', consent: true }, u.token);
    const code = s.codeIn(s.lastMail('a@example.com'));
    assert.match(code, /^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push(await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code: wrong }, u.token));
    outs.push(await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code }, u.token)); // 第 6 次输对
    outs.push(await s.call('POST', E + '/verify', { challengeId: 'no-such-challenge', code }, u.token));
    outs.push(await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code: '12345' }, u.token)); // 不是 6 位
    outs.push(await s.call('POST', E + '/verify', { challengeId: r.body.challengeId }, u.token));
    outs.push(await s.call('POST', E + '/verify', { challengeId: 12, code: 123456 }, u.token));
    for (const o of outs) { assert.equal(o.status, 422); assert.equal(o.body.error, outs[0].body.error, '说明都一样，不透露是哪种失败'); }
    assert.match(outs[0].body.error, /验证码不对或已过期/);
    assert.equal(s.app.store.getEmail(u.id), null);
  } finally { await s.stop(); }
});

test('验证码：10 分钟后过期；只能用一次；重新发送后旧的作废；别的账号用不了', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), other = await s.newUser(), E = `/api/users/${u.id}/email`;
    // 过期
    let r = await s.call('POST', E, { email: 'a@example.com', consent: true }, u.token);
    let code = s.codeIn(s.lastMail('a@example.com'));
    s.advance(10 * MIN + 1000);
    assert.equal((await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code }, u.token)).status, 422, '过了 10 分钟');
    // 差一点到 10 分钟还能用
    r = await s.call('POST', E, { email: 'a@example.com', consent: true }, u.token); code = s.codeIn(s.lastMail('a@example.com'));
    s.advance(10 * MIN - 1000);
    // 别的账号拿到 challengeId 和验证码也绑不了
    assert.equal((await s.call('POST', `/api/users/${other.id}/email/verify`, { challengeId: r.body.challengeId, code }, other.token)).status, 422);
    assert.equal(s.app.store.getEmail(other.id), null);
    assert.equal((await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code }, u.token)).status, 200);
    // 用过一次就不能再用
    assert.equal((await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code }, u.token)).status, 422);
    // 重新发送后旧的作废
    const r1 = await s.call('POST', E, { email: 'b@example.com', consent: true }, u.token); const c1 = s.codeIn(s.lastMail('b@example.com'));
    const r2 = await s.call('POST', E, { email: 'b@example.com', consent: true }, u.token); const c2 = s.codeIn(s.lastMail('b@example.com'));
    assert.notEqual(r1.body.challengeId, r2.body.challengeId);
    assert.equal((await s.call('POST', E + '/verify', { challengeId: r1.body.challengeId, code: c1 }, u.token)).status, 422, '旧验证码已作废');
    assert.equal((await s.call('POST', E + '/verify', { challengeId: r2.body.challengeId, code: c2 }, u.token)).status, 200);
    assert.equal(s.app.store.getEmail(u.id).email, 'b@example.com', '换绑：新邮箱替换旧邮箱');
    assert.equal(s.app.store.userByEmail('a@example.com'), null);
    // 找回用的验证码不能拿来绑定，反过来也不行
    const rr = await s.call('POST', '/api/auth/recover', { email: 'b@example.com' }); const rc = s.codeIn(s.lastMail('b@example.com'));
    assert.equal((await s.call('POST', E + '/verify', { challengeId: rr.body.challengeId, code: rc }, u.token)).status, 422);
  } finally { await s.stop(); }
});

test('找回账号：新设备拿到新令牌，旧设备不掉线；发一封新设备登录的通知', async () => {
  const s = await start();
  try {
    const u = await s.newUser();
    await s.call('PATCH', `/api/users/${u.id}/profile`, { status: 'work', exp: '2027-11-20' }, u.token);
    await s.bind(u, 'li@example.com');
    const before = s.app.store.listOutbox({ to: 'li@example.com' }).length;
    const r = await s.recover('li@example.com');
    assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.body).sort(), ['id', 'token']);
    assert.equal(r.body.id, u.id); assert.notEqual(r.body.token, u.token); assert.ok(r.body.token.length >= 40);
    // 新令牌能读到原来的内容，旧令牌仍然有效
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, r.body.token)).body.profile.status, 'work');
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, u.token)).status, 200, '原来的设备不掉线');
    // 通知邮件：验证码邮件之后多了一封 notice，里面没有令牌和验证码
    await s.app.deliver();
    const mails = s.app.store.listOutbox({ to: 'li@example.com' });
    assert.equal(mails.length, before + 2);
    const notice = mails.pop();
    assert.equal(notice.kind, 'notice'); assert.match(notice.subject, /新设备/); assert.match(notice.body, /让其他设备退出登录/);
    assert.match(notice.body, /2026-11-27 12:00（日本时间）/, '时间按日本时间写');
    assert.ok(!notice.body.includes(r.body.token)); assert.doesNotMatch(notice.body, /验证码：/);
    // 令牌在库里只有哈希
    const dump = JSON.stringify(s.app.store.listSessions(u.id, r.body.token));
    assert.ok(!dump.includes(r.body.token));
    // 同一个验证码不能再换一个令牌
    const again = await s.call('POST', '/api/auth/recover', { email: 'li@example.com' });
    const code = s.codeIn(s.lastMail('li@example.com'));
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: again.body.challengeId, code })).status, 200);
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: again.body.challengeId, code })).status, 422);
  } finally { await s.stop(); }
});

test('找回账号：邮箱有没有绑定过，响应的状态、内容的形状、头都一样；没绑定过的不发邮件，验证码怎么输都不对', async () => {
  const s = await start();
  try {
    const u = await s.newUser(); await s.bind(u, 'known@example.com');
    const n0 = s.app.store.listOutbox().length;
    const a = await s.call('POST', '/api/auth/recover', { email: 'known@example.com' });
    const b = await s.call('POST', '/api/auth/recover', { email: 'nobody@example.com' });
    assert.equal(a.status, 202); assert.equal(b.status, 202);
    assert.deepEqual(Object.keys(a.body), Object.keys(b.body)); assert.equal(a.body.expiresInSec, b.body.expiresInSec);
    assert.match(a.body.challengeId, /^[0-9a-f-]{36}$/); assert.match(b.body.challengeId, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(a.body).length, JSON.stringify(b.body).length, '响应一样长');
    const hk = (h) => [...h.keys()].filter((k) => k !== 'date').sort();
    assert.deepEqual(hk(a.headers), hk(b.headers));
    assert.equal(a.headers.get('content-length'), b.headers.get('content-length'));
    await s.app.deliver();
    assert.equal(s.app.store.listOutbox().length, n0 + 1, '只给绑定过的邮箱发了一封');
    assert.equal(s.app.store.listOutbox({ to: 'nobody@example.com' }).length, 0, '没绑定过的邮箱不发邮件');
    // 没绑定过的：任何验证码都是同一个 422（和绑定过但输错一样）
    const wrongKnown = await s.call('POST', '/api/auth/recover/verify', { challengeId: a.body.challengeId, code: s.codeIn(s.lastMail('known@example.com')) === '000000' ? '111111' : '000000' });
    for (let i = 0; i < 3; i++) {
      const r = await s.call('POST', '/api/auth/recover/verify', { challengeId: b.body.challengeId, code: String(100000 + i) });
      assert.equal(r.status, 422); assert.deepEqual(r.body, wrongKnown.body);
    }
    // 写法不对是 422（只看写法，和有没有绑定无关）
    assert.equal((await s.call('POST', '/api/auth/recover', { email: 'not-an-email' })).status, 422);
    assert.equal((await s.call('POST', '/api/auth/recover', null)).status, 422);
    // 找回不接受账号 id：带了也没用，只按邮箱找
    const c = await s.call('POST', '/api/auth/recover', { email: 'nobody2@example.com', id: u.id });
    assert.equal(c.status, 202); assert.equal(s.app.store.listOutbox({ to: 'nobody2@example.com' }).length, 0);
  } finally { await s.stop(); }
});

test('绑定别人已经绑定的邮箱：响应一样，发过去的是说明而不是验证码，原来的账号不受影响', async () => {
  const s = await start();
  try {
    const owner = await s.newUser(), thief = await s.newUser();
    await s.bind(owner, 'li@example.com');
    const free = await s.call('POST', `/api/users/${thief.id}/email`, { email: 'free@example.com', consent: true }, thief.token);
    const r = await s.call('POST', `/api/users/${thief.id}/email`, { email: 'li@example.com', consent: true }, thief.token);
    assert.equal(r.status, 202); assert.deepEqual(Object.keys(r.body), Object.keys(free.body)); assert.equal(JSON.stringify(r.body).length, JSON.stringify(free.body).length);
    const mail = s.lastMail('li@example.com');
    assert.equal(mail.kind, 'notice'); assert.match(mail.subject, /已经绑定过/); assert.equal(s.codeIn(mail), undefined, '这封邮件里没有验证码');
    // 这个 challenge 没有能用的验证码：试满 5 次都不行
    for (let i = 0; i < 6; i++) assert.equal((await s.call('POST', `/api/users/${thief.id}/email/verify`, { challengeId: r.body.challengeId, code: String(200000 + i) }, thief.token)).status, 422);
    assert.equal(s.app.store.getEmail(thief.id), null);
    assert.equal(s.app.store.userByEmail('li@example.com'), owner.id, '原来的账号不变');
    assert.equal((await s.recover('li@example.com')).body.id, owner.id);
    // 自己重新验证自己的邮箱是可以的
    assert.equal((await s.bind(owner, 'li@example.com')).email, 'l***@example.com');
    // 两个账号同时拿到同一个空邮箱的验证码：先验证的绑上，后验证的得到同样的 422
    const u1 = await s.newUser(), u2 = await s.newUser();
    const q1 = await s.call('POST', `/api/users/${u1.id}/email`, { email: 'race@example.com', consent: true }, u1.token); const c1 = s.codeIn(s.lastMail('race@example.com'));
    const q2 = await s.call('POST', `/api/users/${u2.id}/email`, { email: 'race@example.com', consent: true }, u2.token); const c2 = s.codeIn(s.lastMail('race@example.com'));
    assert.match(c2, /^\d{6}$/, '邮箱还没人绑定时，两个账号都能拿到验证码');
    assert.equal((await s.call('POST', `/api/users/${u2.id}/email/verify`, { challengeId: q2.body.challengeId, code: c2 }, u2.token)).status, 200);
    const late = await s.call('POST', `/api/users/${u1.id}/email/verify`, { challengeId: q1.body.challengeId, code: c1 }, u1.token);
    assert.equal(late.status, 422); assert.match(late.body.error, /验证码不对或已过期/);
    assert.equal(s.app.store.getEmail(u1.id), null); assert.equal(s.app.store.userByEmail('race@example.com'), u2.id);
  } finally { await s.stop(); }
});

test('限流：发验证码按邮箱（1 分钟 1 次、1 小时 5 次）、按账号、按来源地址；没绑定过的邮箱一样受限；被限的请求不发邮件', async () => {
  const s = await start({ emailLimits: {}, trustProxy: true });
  const from = (ip) => ({ 'x-forwarded-for': '203.0.113.9, ' + ip });
  try {
    // 按邮箱：60 秒内第二次是 429，带 retry-after
    const first = await s.call('POST', '/api/auth/recover', { email: 'nobody@example.com' }, null, from('10.0.0.1'));
    assert.equal(first.status, 202);
    const second = await s.call('POST', '/api/auth/recover', { email: 'nobody@example.com' }, null, from('10.0.0.2'));
    assert.equal(second.status, 429); assert.equal(second.headers.get('retry-after'), '60'); assert.match(second.body.error, /太频繁/);
    // 绑定过的邮箱也是同样的限制、同样的响应
    const u = await s.newUser(); await s.bind(u, 'known@example.com');
    assert.equal((await s.call('POST', '/api/auth/recover', { email: 'known@example.com' }, null, from('10.0.0.3'))).status, 202);
    const n = s.app.store.listOutbox().length;
    const k2 = await s.call('POST', '/api/auth/recover', { email: 'known@example.com' }, null, from('10.0.0.4'));
    assert.equal(k2.status, 429); assert.deepEqual(k2.body, second.body);
    assert.equal(s.app.store.listOutbox().length, n, '被限流的请求不发邮件');
    // 1 小时 5 次：每次隔 61 秒，第 6 次被拒
    for (let i = 0; i < 4; i++) { s.advance(61 * 1000); assert.equal((await s.call('POST', '/api/auth/recover', { email: 'nobody@example.com' }, null, from('10.0.1.' + i))).status, 202, '第 ' + (i + 2) + ' 次'); }
    s.advance(61 * 1000);
    const sixth = await s.call('POST', '/api/auth/recover', { email: 'nobody@example.com' }, null, from('10.0.2.1'));
    assert.equal(sixth.status, 429); assert.ok(+sixth.headers.get('retry-after') > 3000, '要等到一小时窗口过去');
    s.advance(60 * MIN);
    assert.equal((await s.call('POST', '/api/auth/recover', { email: 'nobody@example.com' }, null, from('10.0.2.2'))).status, 202, '窗口过去后恢复');
    // 按来源地址：同一个地址 1 小时 10 次，换邮箱也没用；别的地址不受影响
    for (let i = 0; i < 10; i++) assert.equal((await s.call('POST', '/api/auth/recover', { email: `p${i}@example.com` }, null, from('10.9.9.9'))).status, 202);
    assert.equal((await s.call('POST', '/api/auth/recover', { email: 'p10@example.com' }, null, from('10.9.9.9'))).status, 429);
    assert.equal((await s.call('POST', '/api/auth/recover', { email: 'p10@example.com' }, null, from('10.9.9.8'))).status, 202);
    // X-Forwarded-For 取最后一段：前面的段是客户端自己能写的，改它绕不过限流
    assert.equal((await s.call('POST', '/api/auth/recover', { email: 'p11@example.com' }, null, { 'x-forwarded-for': '1.2.3.4, 10.9.9.9' })).status, 429);
    // 按账号：一个账号 1 小时 5 次，换邮箱、换来源地址也没用；别的账号不受影响
    const a = await s.newUser(), b = await s.newUser();
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', `/api/users/${a.id}/email`, { email: `q${i}@example.com`, consent: true }, a.token, from('10.5.0.' + i))).status, 202);
    assert.equal((await s.call('POST', `/api/users/${a.id}/email`, { email: 'q5@example.com', consent: true }, a.token, from('10.5.0.9'))).status, 429);
    assert.equal((await s.call('POST', `/api/users/${b.id}/email`, { email: 'q5@example.com', consent: true }, b.token, from('10.5.0.9'))).status, 202);
  } finally { await s.stop(); }
});

test('限流：核对验证码按来源地址、按邮箱、按账号；不开 TRUST_PROXY 时不看 X-Forwarded-For', async () => {
  const tight = { max: 3, windowMs: 3600000 };
  // 按来源地址
  let s = await start({ emailLimits: Object.assign({}, LOOSE, { verIp: [tight] }), trustProxy: true });
  try {
    const hdr = { 'x-forwarded-for': '10.1.1.1' };
    for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: 'c' + i, code: '123456' }, null, hdr)).status, 422);
    const r = await s.call('POST', '/api/auth/recover/verify', { challengeId: 'c9', code: '123456' }, null, hdr);
    assert.equal(r.status, 429); assert.ok(+r.headers.get('retry-after') > 0);
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: 'c9', code: '123456' }, null, { 'x-forwarded-for': '10.1.1.2' })).status, 422, '别的地址不受影响');
    const u = await s.newUser();
    assert.equal((await s.call('POST', `/api/users/${u.id}/email/verify`, { challengeId: 'c9', code: '123456' }, u.token, hdr)).status, 429, '绑定的核对也按来源地址限');
  } finally { await s.stop(); }
  // 按邮箱：同一个邮箱的验证码（哪怕重新发了新的）合计只能试 3 次
  s = await start({ emailLimits: Object.assign({}, LOOSE, { verEmail: [tight] }) });
  try {
    const u = await s.newUser(); await s.bind(u, 'li@example.com'); // 绑定时核对过 1 次
    const a = await s.call('POST', '/api/auth/recover', { email: 'li@example.com' });
    for (let i = 0; i < 2; i++) assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: a.body.challengeId, code: '000001' })).status, 422);
    const b = await s.call('POST', '/api/auth/recover', { email: 'li@example.com' });
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: b.body.challengeId, code: s.codeIn(s.lastMail('li@example.com')) })).status, 429, '换一个新验证码也不能接着试');
    // 没绑定过的邮箱同样受限
    const c = await s.call('POST', '/api/auth/recover', { email: 'nobody@example.com' });
    for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: c.body.challengeId, code: '000001' })).status, 422);
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: c.body.challengeId, code: '000001' })).status, 429);
  } finally { await s.stop(); }
  // 按账号；并且没开 TRUST_PROXY 时伪造 X-Forwarded-For 不起作用
  s = await start({ emailLimits: Object.assign({}, LOOSE, { verUser: [tight], verIp: [{ max: 5, windowMs: 3600000 }] }) });
  try {
    const u = await s.newUser(), other = await s.newUser();
    for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', `/api/users/${u.id}/email/verify`, { challengeId: 'x' + i, code: '123456' }, u.token, { 'x-forwarded-for': '10.2.2.' + i })).status, 422);
    assert.equal((await s.call('POST', `/api/users/${u.id}/email/verify`, { challengeId: 'x9', code: '123456' }, u.token)).status, 429);
    assert.equal((await s.call('POST', `/api/users/${other.id}/email/verify`, { challengeId: 'x9', code: '123456' }, other.token, { 'x-forwarded-for': '10.2.2.50' })).status, 422, '别的账号不受影响');
    assert.equal((await s.call('POST', `/api/users/${other.id}/email/verify`, { challengeId: 'x9', code: '123456' }, other.token, { 'x-forwarded-for': '10.2.2.51' })).status, 422);
    assert.equal((await s.call('POST', `/api/users/${other.id}/email/verify`, { challengeId: 'x9', code: '123456' }, other.token, { 'x-forwarded-for': '10.2.2.52' })).status, 429, '来源地址按连接算，伪造的头不算');
  } finally { await s.stop(); }
});

test('限流的次数存在数据库里：换一个进程（重新建应用）接着算', async () => {
  const store = createStore();
  let t = Date.parse('2026-11-27T03:00:00Z');
  const mk = async () => { const app = createApp({ store, clock: () => t, signupLimit: WIDE }); await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok)); return app; };
  const post = (app) => fetch('http://127.0.0.1:' + app.server.address().port + '/api/auth/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) });
  const a = await mk();
  assert.equal((await post(a)).status, 202);
  a.server.close(); a.server.closeAllConnections();
  const b = await mk();
  try { assert.equal((await post(b)).status, 429); } finally { b.server.close(); b.server.closeAllConnections(); store.close(); }
});

test('登录的设备：能看到几台、哪台是自己；让其他设备退出后只剩自己，从哪台设备发起都行', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), S = `/api/users/${u.id}/sessions`;
    assert.deepEqual((await s.call('GET', S, null, u.token)).body.map((x) => [x.via, x.current]), [['signup', true]]);
    await s.bind(u, 'li@example.com');
    const d2 = (await s.recover('li@example.com')).body.token, d3 = (await s.recover('li@example.com')).body.token;
    const list = (await s.call('GET', S, null, d2)).body;
    assert.deepEqual(list.map((x) => [x.via, x.current]), [['signup', false], ['recover', true], ['recover', false]]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'current', 'lastUsedAt', 'via'], '不带令牌和哈希');
    assert.ok(list[1].lastUsedAt, '用过的登录有最后使用时间');
    assert.equal((await s.call('GET', S)).status, 401);
    // 从找回的设备发起：注册时的设备和另一台找回的设备都退出
    assert.equal((await s.call('DELETE', S, null, d2)).status, 204);
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, u.token)).status, 401, '注册时的设备已退出');
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, d3)).status, 401);
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, d2)).status, 200, '自己还在');
    assert.deepEqual((await s.call('GET', S, null, d2)).body.map((x) => [x.via, x.current]), [['recover', true]]);
    assert.equal((await s.call('DELETE', S, null, u.token)).status, 401, '已退出的设备不能再操作');
    // 从注册时的设备发起：找回的设备退出，自己还在
    const v = await s.newUser(); await s.bind(v, 'wang@example.com');
    const e2 = (await s.recover('wang@example.com')).body.token;
    assert.equal((await s.call('DELETE', `/api/users/${v.id}/sessions`, null, v.token)).status, 204);
    assert.equal((await s.call('GET', `/api/users/${v.id}`, null, e2)).status, 401);
    assert.equal((await s.call('GET', `/api/users/${v.id}`, null, v.token)).status, 200);
    // 一个账号的令牌不能用在别的账号上
    assert.equal((await s.call('GET', `/api/users/${v.id}`, null, d2)).status, 401);
    // 退出之后还能再找回
    assert.equal((await s.recover('wang@example.com')).status, 200);
  } finally { await s.stop(); }
});

test('解除绑定：邮箱、没用完的验证码、发给它的邮件都删掉；之后找回不了；账号和已有的登录还在', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bind(u, 'li@example.com');
    const d2 = (await s.recover('li@example.com')).body.token;
    const pending = await s.call('POST', '/api/auth/recover', { email: 'li@example.com' });
    const code = s.codeIn(s.lastMail('li@example.com'));
    assert.equal((await s.call('DELETE', E, null, u.token)).status, 204);
    assert.deepEqual((await s.call('GET', E, null, u.token)).body, { email: null, verified: false, remindOptIn: false });
    const fp = s.app.store.emailFootprint(u.id, 'li@example.com');
    assert.equal(fp.emails, 0); assert.equal(fp.challenges, 0); assert.equal(fp.outbox, 0);
    assert.equal((await s.call('POST', '/api/auth/recover/verify', { challengeId: pending.body.challengeId, code })).status, 422, '解除之前发的验证码作废');
    const r = await s.call('POST', '/api/auth/recover', { email: 'li@example.com' });
    assert.equal(r.status, 202); assert.equal(s.app.store.listOutbox({ to: 'li@example.com' }).length, 0, '解除后不再给它发邮件');
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, u.token)).status, 200);
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, d2)).status, 200, '已经登录的设备不受影响');
    assert.equal((await s.call('DELETE', E, null, u.token)).status, 204, '没有邮箱时再解除也不报错');
    // 解除后别的账号可以绑这个邮箱
    const v = await s.newUser(); assert.equal((await s.bind(v, 'li@example.com')).email, 'l***@example.com');
  } finally { await s.stop(); }
});

test('删除账号：邮箱、验证码、别的设备的登录、发件箱、限流记录全部删掉；同一个邮箱可以绑到新账号上', async () => {
  const s = await start({ emailLimits: {} });
  try {
    const u = await s.newUser(), keep = await s.newUser();
    await s.bind(u, 'li@example.com');
    s.advance(61 * 1000);
    const d2 = (await s.recover('li@example.com')).body.token;
    s.advance(61 * 1000);
    await s.call('POST', '/api/auth/recover', { email: 'li@example.com' }); // 留一个没用的验证码
    await s.call('POST', `/api/users/${keep.id}/email`, { email: 'li@example.com', consent: true }, keep.token); // 别人试着绑这个邮箱，产生一封发给它的说明
    await s.bind(keep, 'keep@example.com');
    const before = s.app.store.emailFootprint(u.id, 'li@example.com');
    for (const k of ['sessions', 'emails', 'challenges', 'outbox', 'rate']) assert.ok(before[k] > 0, '删除之前 ' + k + ' 里有记录');
    assert.equal((await s.call('DELETE', `/api/users/${u.id}`, null, d2)).status, 204, '用找回的设备也能删除账号');
    assert.deepEqual(s.app.store.emailFootprint(u.id, 'li@example.com'), { sessions: 0, emails: 0, challenges: 0, outbox: 0, rate: 0 });
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, u.token)).status, 401);
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, d2)).status, 401);
    // 整个库里不再出现这个邮箱（发件箱、留痕）
    assert.ok(!JSON.stringify(s.app.store.listOutbox()).includes('li@example.com'));
    assert.ok(!JSON.stringify(s.app.store.auditRows()).includes('li@example.com'));
    // 别人的数据不受影响
    assert.equal(s.app.store.getEmail(keep.id).email, 'keep@example.com');
    assert.ok(s.app.store.listOutbox({ to: 'keep@example.com' }).length > 0);
    // 找回不了；同一个邮箱可以绑到新账号上（限流记录也清了，不用等）
    const r = await s.call('POST', '/api/auth/recover', { email: 'li@example.com' });
    assert.equal(r.status, 202); assert.equal(s.app.store.listOutbox({ to: 'li@example.com' }).length, 0);
    const fresh = await s.newUser();
    assert.equal((await s.bind(fresh, 'li@example.com')).email, 'l***@example.com');
    s.advance(61 * 1000);
    assert.equal((await s.recover('li@example.com')).body.id, fresh.id);
  } finally { await s.stop(); }
});

test('留痕：绑定、找回、退出、解除、删除都有记录，但不出现邮箱、验证码和令牌', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), codes = [];
    const r = await s.call('POST', `/api/users/${u.id}/email`, { email: 'li.hua@example.com', consent: true }, u.token);
    codes.push(s.codeIn(s.lastMail('li.hua@example.com')));
    await s.call('POST', `/api/users/${u.id}/email/verify`, { challengeId: r.body.challengeId, code: codes[0] === '000000' ? '111111' : '000000' }, u.token);
    await s.call('POST', `/api/users/${u.id}/email/verify`, { challengeId: r.body.challengeId, code: codes[0] }, u.token);
    const q = await s.call('POST', '/api/auth/recover', { email: 'li.hua@example.com' });
    codes.push(s.codeIn(s.lastMail('li.hua@example.com')));
    const d2 = (await s.call('POST', '/api/auth/recover/verify', { challengeId: q.body.challengeId, code: codes[1] })).body.token;
    await s.call('POST', '/api/auth/recover', { email: 'stranger@example.com' });
    await s.call('DELETE', `/api/users/${u.id}/sessions`, null, d2);
    const check = () => {
      const rows = s.app.store.auditRows(), dump = JSON.stringify(rows);
      for (const bad of ['li.hua', 'example.com', 'stranger', d2, u.token, q.body.challengeId, r.body.challengeId].concat(codes)) assert.ok(!dump.includes(bad), '留痕里不应当有 ' + bad);
      return rows.map((x) => x.action);
    };
    const acts = check();
    for (const a of ['email.bind', 'session.recover', 'session.revoke']) assert.ok(acts.includes(a), a);
    await s.call('DELETE', `/api/users/${u.id}/email`, null, d2);
    assert.ok(check().includes('email.remove'));
    await s.call('DELETE', `/api/users/${u.id}`, null, d2);
    const rows = s.app.store.auditRows(); check();
    assert.ok(!JSON.stringify(rows).includes(u.id), '删除账号后留痕里没有账号 id');
    assert.ok(rows.filter((x) => /^(email|session)\./.test(x.action)).every((x) => x.userId === null && x.detail === null));
  } finally { await s.stop(); }
});

test('验证码表里只有哈希；限流表里没有来源地址和邮箱的原文', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-auth-')), file = path.join(dir, 't.db');
  const s = await start({ dbFile: file, trustProxy: true });
  try {
    const u = await s.newUser();
    await s.call('POST', `/api/users/${u.id}/email`, { email: 'li@example.com', consent: true }, u.token, { 'x-forwarded-for': '198.51.100.77' });
    const code = s.codeIn(s.lastMail('li@example.com'));
    const db = new DatabaseSync(file);
    const ch = db.prepare('SELECT * FROM email_challenges').all();
    assert.equal(ch.length, 1); assert.match(ch[0].code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(ch).includes(code), '验证码表里没有验证码原文');
    const rate = JSON.stringify(db.prepare('SELECT * FROM rate_events').all());
    assert.ok(rate.length > 10);
    for (const bad of ['198.51.100.77', 'li@example.com', u.id]) assert.ok(!rate.includes(bad), '限流表里不应当有 ' + bad);
    const ses = JSON.stringify(db.prepare('SELECT * FROM sessions').all().concat(db.prepare('SELECT token_hash FROM users').all()));
    assert.ok(!ses.includes(u.token));
    db.close();
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('发件箱接口：没配 ADMIN_TOKEN 是 503，令牌不对是 401；本地发件方式下能读到验证码邮件，真实发信时不给正文、地址打码', async () => {
  let s = await start();
  try {
    const u = await s.newUser(); await s.bind(u, 'li@example.com');
    assert.equal((await s.call('GET', '/api/admin/outbox')).status, 401);
    assert.equal((await s.call('GET', '/api/admin/outbox', null, u.token)).status, 401, '用户的令牌不行');
    const rows = (await s.call('GET', '/api/admin/outbox?to=LI@example.com', null, 'adm')).body;
    assert.equal(rows.length, 1); assert.equal(rows[0].to, 'li@example.com'); assert.equal(rows[0].kind, 'code'); assert.match(rows[0].body, /验证码：\d{6}/);
    assert.equal((await s.call('GET', '/api/admin/outbox?status=failed', null, 'adm')).body.length, 0);
    assert.equal((await s.call('GET', '/api/admin/outbox?status=sent', null, 'adm')).body.length, 1);
  } finally { await s.stop(); }
  // 没配管理员令牌
  const saved = process.env.ADMIN_TOKEN; delete process.env.ADMIN_TOKEN;
  s = await start({ adminToken: null });
  try { assert.equal((await s.call('GET', '/api/admin/outbox', null, 'adm')).status, 503); } finally { await s.stop(); if (saved !== undefined) process.env.ADMIN_TOKEN = saved; }
  // 真实发信（这里用一个记录用的假发件方式）：接口不返回正文，地址打码；验证码邮件发完后库里的正文和地址也清掉
  const got = [];
  s = await start({ sender: { name: 'fake', dev: false, send: async (m) => { got.push(m); return {}; } } });
  try {
    const u = await s.newUser();
    const r = await s.call('POST', `/api/users/${u.id}/email`, { email: 'li@example.com', consent: true }, u.token);
    await s.app.deliver();
    assert.equal(got.length, 1); assert.equal(got[0].to, 'li@example.com');
    const code = (/验证码：(\d{6})/.exec(got[0].text) || [])[1];
    const rows = (await s.call('GET', '/api/admin/outbox', null, 'adm')).body;
    assert.equal(rows.length, 1); assert.ok(!('body' in rows[0])); assert.equal(rows[0].status, 'sent');
    assert.ok(!JSON.stringify(rows).includes('li@example.com')); assert.ok(!JSON.stringify(rows).includes(code));
    assert.ok(!JSON.stringify(s.app.store.listOutbox()).includes(code), '发完后库里不留验证码');
    assert.equal((await s.call('POST', `/api/users/${u.id}/email/verify`, { challengeId: r.body.challengeId, code }, u.token)).status, 200);
    // 通知邮件（不是验证码）在真实发信时：地址打码显示
    const rc = await s.call('POST', '/api/auth/recover', { email: 'li@example.com' }); await s.app.deliver();
    const code2 = (/验证码：(\d{6})/.exec(got[1].text) || [])[1];
    await s.call('POST', '/api/auth/recover/verify', { challengeId: rc.body.challengeId, code: code2 }); await s.app.deliver();
    const notice = (await s.call('GET', '/api/admin/outbox', null, 'adm')).body.find((x) => x.kind === 'notice');
    assert.equal(notice.to, 'l***@example.com');
  } finally { await s.stop(); }
});

test('发送失败：接口照常返回；按 1 分钟、5 分钟…重试；一直失败最后记为 failed；恢复后能发出去', async () => {
  let fail = true; const got = [];
  const s = await start({ sender: { name: 'flaky', dev: true, send: async (m) => { if (fail) throw new Error('对方服务器 500'); got.push(m); return {}; } } });
  try {
    const u = await s.newUser();
    const r = await s.call('POST', `/api/users/${u.id}/email`, { email: 'li@example.com', consent: true }, u.token);
    assert.equal(r.status, 202, '发不出去不影响接口的响应');
    await s.app.deliver();
    let row = s.lastMail('li@example.com');
    assert.equal(row.status, 'queued'); assert.equal(row.tries, 1); assert.match(row.lastError, /500/);
    await s.app.deliver(); assert.equal(s.lastMail('li@example.com').tries, 1, '没到重试时间不重发');
    s.advance(61 * 1000); fail = false; await s.app.deliver();
    row = s.lastMail('li@example.com'); assert.equal(row.status, 'sent'); assert.equal(got.length, 1);
    await s.app.deliver(); assert.equal(got.length, 1, '发过的不再发');
    // 一直失败：第 1 次加 5 次重试之后是 failed
    fail = true; s.advance(61 * 1000);
    await s.call('POST', `/api/users/${u.id}/email`, { email: 'li@example.com', consent: true }, u.token);
    for (const waitMin of [0, 1, 5, 30, 120, 720, 720]) { s.advance(waitMin * MIN + 1000); await s.app.deliver(); }
    row = s.lastMail('li@example.com'); assert.equal(row.status, 'failed'); assert.equal(row.tries, 6);
  } finally { await s.stop(); }
});

test('清理：验证码过期 24 小时后删除；验证码邮件的正文 1 小时后清空；限流记录留 24 小时', async () => {
  const s = await start();
  try {
    const u = await s.newUser();
    await s.call('POST', `/api/users/${u.id}/email`, { email: 'li@example.com', consent: true }, u.token);
    assert.equal(s.app.store.emailFootprint(u.id, 'li@example.com').challenges, 1);
    s.advance(61 * MIN); s.app.purge();
    assert.equal(s.lastMail('li@example.com').body, '', '验证码邮件的正文已清空');
    assert.equal(s.app.store.emailFootprint(u.id, 'li@example.com').challenges, 1, '还没到 24 小时');
    s.advance(24 * 60 * MIN); s.app.purge();
    const fp = s.app.store.emailFootprint(u.id, 'li@example.com');
    assert.equal(fp.challenges, 0); assert.equal(fp.rate, 0);
    assert.equal(s.lastMail('li@example.com').to, 'li@example.com', '发件记录 30 天内还留着地址');
    s.advance(30 * 24 * 60 * MIN); s.app.purge();
    assert.equal(s.app.store.listOutbox().pop().to, '', '30 天后清掉地址');
  } finally { await s.stop(); }
});

test('邮件的文字：不含会被敏感号码过滤拦下的写法，验证码是 6 位数字', async () => {
  const { TEXTS } = require('../src/mailer');
  for (const code of ['000000', '123456', '999999', '201127']) {
    for (const m of [TEXTS.bindCode(code), TEXTS.recoverCode(code), TEXTS.taken(), TEXTS.newDevice(Date.parse('2026-11-27T03:04:00Z'))]) {
      assert.equal(findSensitive(m.subject), null, m.subject); assert.equal(findSensitive(m.text), null, m.subject);
      assert.doesNotMatch(m.text, /https?:\/\//, '邮件里不放链接');
    }
  }
});

test('条款改版：老用户重新同意之前只能读取和删除自己的数据；同意后恢复；留痕有记录', async () => {
  const store = createStore();
  const old = await start({ store, termsVersion: '2026-11-26' });
  let u;
  try {
    assert.equal((await old.call('GET', '/api/terms')).body.version, '2026-11-26');
    u = await old.newUser();
    assert.equal((await old.call('PATCH', `/api/users/${u.id}/profile`, { status: 'work' }, u.token)).status, 200);
  } finally { await old.app.deliver(); old.app.server.close(); old.app.server.closeAllConnections(); }
  const s = await start({ store, llm: async () => { throw new Error('不应当调到模型'); } });
  try {
    const terms = (await s.call('GET', '/api/terms')).body;
    assert.equal(terms.version, V); assert.ok(terms.changes.length > 10, '有一段“这次改了什么”');
    const me = await s.call('GET', `/api/users/${u.id}`, null, u.token);
    assert.equal(me.status, 200); assert.equal(me.body.consentVersion, '2026-11-26'); assert.equal(me.body.profile.status, 'work');
    // 重新同意之前：写入、助手、咨询、绑定邮箱都拦下
    for (const [m, p, b] of [['PATCH', '/profile', { status: 'hsp' }], ['PUT', '/state', { profile: {}, done: {} }], ['POST', '/chat', { message: '你好', history: [] }], ['GET', '/plan'], ['GET', '/reminders'],
      ['POST', '/events', { type: 'move', date: '2026-11-20' }], ['GET', '/inquiries'], ['POST', '/email', { email: 'a@example.com', consent: true }], ['GET', '/email'], ['GET', '/sessions']]) {
      const r = await s.call(m, `/api/users/${u.id}${p}`, b, u.token);
      assert.equal(r.status, 409, m + ' ' + p); assert.match(r.body.error, /已更新/);
    }
    assert.equal(s.app.store.getUser(u.id).profile.status, 'work', '被拦下的修改没有写进去');
    // 版本不对不算同意；别人不能替他同意
    assert.equal((await s.call('POST', `/api/users/${u.id}/consent`, { accept: '2026-11-26' }, u.token)).status, 422);
    assert.equal((await s.call('POST', `/api/users/${u.id}/consent`, {}, u.token)).status, 422);
    assert.equal((await s.call('POST', `/api/users/${u.id}/consent`, { accept: V })).status, 401);
    const ok = await s.call('POST', `/api/users/${u.id}/consent`, { accept: V }, u.token);
    assert.equal(ok.status, 200); assert.equal(ok.body.consentVersion, V); assert.ok(!('token' in ok.body));
    assert.equal((await s.call('PATCH', `/api/users/${u.id}/profile`, { status: 'hsp' }, u.token)).status, 200);
    assert.equal((await s.call('GET', `/api/users/${u.id}/plan`, null, u.token)).status, 200);
    const log = store.auditRows().filter((a) => a.action === 'consent.renew');
    assert.equal(log.length, 1); assert.equal(log[0].userId, u.id); assert.deepEqual(JSON.parse(log[0].detail), { consentVersion: V });
    assert.equal((await s.call('POST', `/api/users/${u.id}/consent`, { accept: V }, u.token)).status, 200, '已经是当前版本时再同意一次不报错');
    assert.equal(store.auditRows().filter((a) => a.action === 'consent.renew').length, 1, '也不重复记录');
    // 不同意的人可以直接删除账号
    const old2 = store.createUser('2026-11-26');
    assert.equal((await s.call('PATCH', `/api/users/${old2.id}/profile`, { status: 'work' }, old2.token)).status, 409);
    assert.equal((await s.call('DELETE', `/api/users/${old2.id}`, null, old2.token)).status, 204);
    assert.equal(store.getUser(old2.id), undefined);
    // 用邮箱找回的老用户也一样要先重新同意
    const old3 = store.createUser('2026-11-26'); store.bindEmail(old3.id, 'old3@example.com', '2026-11-26');
    const rec = await s.recover('old3@example.com');
    assert.equal(rec.status, 200);
    assert.equal((await s.call('GET', `/api/users/${old3.id}/plan`, null, rec.body.token)).status, 409);
    assert.equal((await s.call('POST', `/api/users/${old3.id}/consent`, { accept: V }, rec.body.token)).status, 200);
    assert.equal((await s.call('GET', `/api/users/${old3.id}/plan`, null, rec.body.token)).status, 200);
  } finally { await s.stop(); }
});

test('旧的数据库文件（没有新表）打开后可以直接用，原来的账号和令牌不变', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-old-')), file = path.join(dir, 'old.db');
  const st = createStore(file); const u = st.createUser(V); st.close();
  const db = new DatabaseSync(file);
  for (const t of ['sessions', 'user_emails', 'email_challenges', 'rate_events', 'outbox']) db.exec('DROP TABLE ' + t);
  db.close();
  const s = await start({ dbFile: file });
  try {
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, u.token)).status, 200);
    assert.equal((await s.bind(u, 'li@example.com')).email, 'l***@example.com');
    assert.equal((await s.recover('li@example.com')).body.id, u.id);
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
