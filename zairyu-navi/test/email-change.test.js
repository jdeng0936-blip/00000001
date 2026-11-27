// 更换、解除绑定的邮箱之前，先验证原来的邮箱（负责人 2026-11-27 定的规则）：
// 更换 = 原来的邮箱收验证码 → 新邮箱收验证码；解除 = 原来的邮箱收验证码。从哪台设备操作都一样。
// 刚用邮箱找回登录的设备 24 小时内不能更换或解除，这一条照旧（test/hardening.test.js 里有完整的用例，这里再确认它和新规则叠在一起）。
// 邮件不联网，从发件箱（outbox）里读。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { TEXTS } = require('../src/mailer');
const { findSensitive } = require('../src/validate');

const WIDE = { max: 100000, windowMs: 3600000 };
const LOOSE = { reqEmail: [WIDE], reqEmailAll: [WIDE], reqIp: [WIDE], reqUser: [WIDE], verIp: [WIDE], verUser: [WIDE] };
const MIN = 60 * 1000;

async function start(opts) {
  let t = Date.parse('2026-11-27T03:00:00Z');
  const clock = () => t;
  const app = createApp(Object.assign({ now: '2026-11-27', adminToken: 'adm', clock, emailLimits: LOOSE, signupLimit: WIDE }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  const mailsTo = (to) => app.store.listOutbox({ to });
  const codeTo = (to) => (/验证码：(\d{6})/.exec(mailsTo(to).filter((m) => m.kind === 'code').pop().body) || [])[1];
  const s = {
    app, call, mailsTo, codeTo, advance: (ms) => { t += ms; },
    newUser: async () => (await call('POST', '/api/users', { accept: app.termsVersion })).body,
    // 第一次绑定（账号上还没有邮箱，不用验证原来的邮箱）
    bindFirst: async (u, email) => {
      const r = await call('POST', `/api/users/${u.id}/email`, { email, consent: true }, u.token);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const v = await call('POST', `/api/users/${u.id}/email/verify`, { challengeId: r.body.challengeId, code: codeTo(email) }, u.token);
      assert.equal(v.status, 200, JSON.stringify(v.body));
    },
    // 验证原来的邮箱，返回整个响应
    proveOld: async (u, action, token) => {
      const old = app.store.getEmail(u.id).email;
      const r = await call('POST', `/api/users/${u.id}/email/old`, { action }, token || u.token);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      return call('POST', `/api/users/${u.id}/email/old/verify`, { action, challengeId: r.body.challengeId, code: codeTo(old) }, token || u.token);
    },
    stop: async () => { await app.deliver(); app.server.close(); app.server.closeAllConnections(); app.store.close(); }
  };
  return s;
}

test('更换邮箱：没验证原来的邮箱是 403，不给新邮箱发信；原来的邮箱收验证码 → 拿到确认 → 新邮箱收验证码 → 换好，原来的邮箱收到告知', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bindFirst(u, 'old@example.com');
    // 不带确认、确认乱写：发验证码和核对验证码都是 403，新邮箱什么都没收到
    for (const proof of [undefined, '', 'x'.repeat(43), 123, 'y'.repeat(500)]) {
      const r = await s.call('POST', E, { email: 'new@example.com', consent: true, proof }, u.token);
      assert.equal(r.status, 403, JSON.stringify(proof)); assert.match(r.body.error, /原来邮箱的验证码/);
    }
    assert.equal((await s.call('POST', E + '/verify', { challengeId: 'x', code: '123456' }, u.token)).status, 403);
    assert.equal(s.mailsTo('new@example.com').length, 0, '没验证原来的邮箱，不给新邮箱发信');
    // 第一步：验证码发到原来的邮箱，标题写明是“更换”
    const r1 = await s.call('POST', E + '/old', { action: 'change' }, u.token);
    assert.equal(r1.status, 202); assert.deepEqual(Object.keys(r1.body).sort(), ['challengeId', 'expiresInSec']); assert.equal(r1.body.expiresInSec, 600);
    const m1 = s.mailsTo('old@example.com').pop();
    assert.equal(m1.kind, 'code'); assert.match(m1.subject, /更换邮箱的验证码/); assert.doesNotMatch(m1.subject, /\d{6}/); assert.match(m1.body, /还要再收一次新邮箱的验证码/);
    // 第二步：输对了拿到确认（只这一次返回），15 分钟有效
    const v1 = await s.call('POST', E + '/old/verify', { action: 'change', challengeId: r1.body.challengeId, code: s.codeTo('old@example.com') }, u.token);
    assert.equal(v1.status, 200); assert.deepEqual(Object.keys(v1.body).sort(), ['expiresInSec', 'proof']); assert.equal(v1.body.expiresInSec, 900);
    assert.match(v1.body.proof, /^[A-Za-z0-9_-]{43}$/);
    const proof = v1.body.proof;
    assert.equal(s.app.store.getEmail(u.id).email, 'old@example.com', '只验证了原来的邮箱，还没换');
    // 第三步、第四步：新邮箱的验证码（可以重发，确认不会因为重发用掉）
    await s.call('POST', E, { email: 'new@example.com', consent: true, proof }, u.token);
    const r2 = await s.call('POST', E, { email: 'new@example.com', consent: true, proof }, u.token);
    assert.equal(r2.status, 202);
    // 新邮箱的验证码对、确认不对（另一个账号的、乱写的）：403，而且新邮箱的验证码没被用掉
    assert.equal((await s.call('POST', E + '/verify', { challengeId: r2.body.challengeId, code: s.codeTo('new@example.com'), proof: 'z'.repeat(43) }, u.token)).status, 403);
    const v2 = await s.call('POST', E + '/verify', { challengeId: r2.body.challengeId, code: s.codeTo('new@example.com'), proof }, u.token);
    assert.equal(v2.status, 200); assert.equal(v2.body.email, 'n***@example.com');
    assert.equal(s.app.store.getEmail(u.id).email, 'new@example.com');
    await s.app.deliver();
    const bye = s.app.store.listOutbox().filter((m) => m.kind === 'last');
    assert.equal(bye.length, 1); assert.match(bye[0].subject, /已经更换/); assert.equal(bye[0].status, 'sent');
    // 确认只能用一次：再换一次要重新验证（现在的“原来的邮箱”是 new@）
    assert.equal((await s.call('POST', E, { email: 'third@example.com', consent: true, proof }, u.token)).status, 403, '确认用过了');
    const p2 = (await s.proveOld(u, 'change')).body.proof;
    assert.equal(s.mailsTo('new@example.com').filter((m) => /更换邮箱的验证码/.test(m.subject)).length, 1, '这次的验证码发到现在绑着的邮箱');
    assert.equal((await s.call('POST', E, { email: 'third@example.com', consent: true, proof: p2 }, u.token)).status, 202);
  } finally { await s.stop(); }
});

test('解除邮箱：要原来的邮箱的验证码；“解除”的确认不能拿来更换，“更换”的确认也不能拿来解除；解除后原来的邮箱收到告知', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bindFirst(u, 'old@example.com');
    const del = await s.call('DELETE', E, null, u.token);
    assert.equal(del.status, 403); assert.match(del.body.error, /解除/);
    assert.equal(s.app.store.getEmail(u.id).email, 'old@example.com');
    const change = (await s.proveOld(u, 'change')).body.proof;
    assert.equal((await s.call('DELETE', E, { proof: change }, u.token)).status, 403, '“更换”的确认不能解除');
    const r = await s.call('POST', E + '/old', { action: 'remove' }, u.token);
    const m = s.mailsTo('old@example.com').pop();
    assert.match(m.subject, /解除邮箱的验证码/); assert.doesNotMatch(m.body, /新邮箱/);
    const remove = (await s.call('POST', E + '/old/verify', { action: 'remove', challengeId: r.body.challengeId, code: s.codeTo('old@example.com') }, u.token)).body.proof;
    assert.equal((await s.call('POST', E, { email: 'new@example.com', consent: true, proof: remove }, u.token)).status, 403, '“解除”的确认不能更换');
    assert.equal((await s.call('DELETE', E, { proof: remove }, u.token)).status, 204);
    assert.equal(s.app.store.getEmail(u.id), null);
    await s.app.deliver();
    assert.deepEqual(s.app.store.listOutbox().filter((x) => x.kind === 'last').map((x) => [x.subject.includes('已经解除'), x.to]), [[true, '']], '告知发出后不留地址');
    assert.equal(s.app.store.emailFootprint(u.id, 'old@example.com').challenges, 0, '没用的确认（“更换”那个）随验证码一起删掉');
    // 没有邮箱了：验证原邮箱是 409，再解除不报错，重新绑定不用确认
    assert.equal((await s.call('POST', E + '/old', { action: 'remove' }, u.token)).status, 409);
    assert.equal((await s.call('DELETE', E, null, u.token)).status, 204);
    await s.bindFirst(u, 'again@example.com');
  } finally { await s.stop(); }
});

test('验证原来的邮箱：验证码的规则和别的验证码一样（10 分钟、只能用一次、错 5 次作废、只认发起的账号）；确认 15 分钟后失效；参数不对是 422', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), other = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bindFirst(u, 'old@example.com'); await s.bindFirst(other, 'other@example.com');
    for (const b of [{}, { action: 'drop' }, { action: 'constructor' }, null]) assert.equal((await s.call('POST', E + '/old', b, u.token)).status, 422, JSON.stringify(b));
    assert.equal((await s.call('POST', E + '/old/verify', { challengeId: 'x', code: '123456' }, u.token)).status, 422, '没有 action');
    assert.equal((await s.call('POST', E + '/old', { action: 'change' })).status, 401, '要登录');
    // 过期
    let r = await s.call('POST', E + '/old', { action: 'change' }, u.token), code = s.codeTo('old@example.com');
    s.advance(10 * MIN + 1000);
    assert.equal((await s.call('POST', E + '/old/verify', { action: 'change', challengeId: r.body.challengeId, code }, u.token)).status, 422);
    // 错 5 次作废
    r = await s.call('POST', E + '/old', { action: 'change' }, u.token); code = s.codeTo('old@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', E + '/old/verify', { action: 'change', challengeId: r.body.challengeId, code: wrong }, u.token)).status, 422);
    assert.equal((await s.call('POST', E + '/old/verify', { action: 'change', challengeId: r.body.challengeId, code }, u.token)).status, 422, '错满 5 次后输对也不行');
    // 重新发送后旧的作废；别的账号拿到 challengeId 和验证码也用不了
    const a = await s.call('POST', E + '/old', { action: 'change' }, u.token), ca = s.codeTo('old@example.com');
    const b = await s.call('POST', E + '/old', { action: 'change' }, u.token), cb = s.codeTo('old@example.com');
    assert.equal((await s.call('POST', E + '/old/verify', { action: 'change', challengeId: a.body.challengeId, code: ca }, u.token)).status, 422, '旧的作废');
    assert.equal((await s.call('POST', `/api/users/${other.id}/email/old/verify`, { action: 'change', challengeId: b.body.challengeId, code: cb }, other.token)).status, 422, '别的账号用不了');
    const ok = await s.call('POST', E + '/old/verify', { action: 'change', challengeId: b.body.challengeId, code: cb }, u.token);
    assert.equal(ok.status, 200);
    assert.equal((await s.call('POST', E + '/old/verify', { action: 'change', challengeId: b.body.challengeId, code: cb }, u.token)).status, 422, '只能用一次');
    // 别的账号拿到确认也用不了
    assert.equal((await s.call('POST', `/api/users/${other.id}/email`, { email: 'x@example.com', consent: true, proof: ok.body.proof }, other.token)).status, 403);
    // 确认 15 分钟后失效
    s.advance(15 * MIN + 1000);
    assert.equal((await s.call('POST', E, { email: 'new@example.com', consent: true, proof: ok.body.proof }, u.token)).status, 403, '确认过期');
    // 差一点到 15 分钟还能用
    const p = (await s.proveOld(u, 'change')).body.proof;
    s.advance(15 * MIN - 1000);
    assert.equal((await s.call('POST', E, { email: 'new@example.com', consent: true, proof: p }, u.token)).status, 202);
  } finally { await s.stop(); }
});

test('确认只对验证时绑着的那个邮箱有效：拿到确认后邮箱已经换掉，这个确认就作废；验证码发出后邮箱换掉了，验证码也作废', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bindFirst(u, 'old@example.com');
    const stale = (await s.proveOld(u, 'remove')).body.proof;
    const pending = await s.call('POST', E + '/old', { action: 'remove' }, u.token), pc = s.codeTo('old@example.com');
    // 另一台设备上换成了 new@
    const p = (await s.proveOld(u, 'change')).body.proof;
    const r = await s.call('POST', E, { email: 'new@example.com', consent: true, proof: p }, u.token);
    assert.equal((await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code: s.codeTo('new@example.com'), proof: p }, u.token)).status, 200);
    assert.equal((await s.call('DELETE', E, { proof: stale }, u.token)).status, 403, '为 old@ 拿到的确认不能解除 new@');
    assert.equal((await s.call('POST', E + '/old/verify', { action: 'remove', challengeId: pending.body.challengeId, code: pc }, u.token)).status, 422, '发给 old@ 的验证码作废了');
    assert.equal(s.app.store.getEmail(u.id).email, 'new@example.com');
  } finally { await s.stop(); }
});

test('原来的邮箱收不到信了：没有绕过的办法（换不了、解除不了），可以删除账号，邮箱随之释放', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bindFirst(u, 'dead@example.com');
    // 试遍不带确认的写法：都不行
    assert.equal((await s.call('POST', E, { email: 'new@example.com', consent: true }, u.token)).status, 403);
    assert.equal((await s.call('POST', E, { email: 'dead@example.com', consent: true }, u.token)).status, 403, '“重新绑定同一个邮箱”也要确认');
    assert.equal((await s.call('DELETE', E, null, u.token)).status, 403);
    assert.equal((await s.call('DELETE', E, { proof: null }, u.token)).status, 403);
    // 提醒照样可以关（关掉不需要验证）
    assert.equal((await s.call('PUT', E + '/reminders', { on: false }, u.token)).status, 200);
    // 出路：删除账号。邮箱、验证码、确认一并删掉，这个邮箱可以绑到新账号上
    assert.equal((await s.call('DELETE', `/api/users/${u.id}`, null, u.token)).status, 204);
    assert.deepEqual(s.app.store.emailFootprint(u.id, 'dead@example.com'), { sessions: 0, emails: 0, challenges: 0, outbox: 0, reminders: 0, rate: 0 });
    const v = await s.newUser(); await s.bindFirst(v, 'dead@example.com');
  } finally { await s.stop(); }
});

test('刚用邮箱找回登录的设备：24 小时内连验证原来的邮箱都不行（规则不变）；过了 24 小时也要和别的设备一样验证原来的邮箱', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bindFirst(u, 'owner@example.com');
    const rr = await s.call('POST', '/api/auth/recover', { email: 'owner@example.com' });
    const d2 = (await s.call('POST', '/api/auth/recover/verify', { challengeId: rr.body.challengeId, code: s.codeTo('owner@example.com') })).body.token;
    const n = s.mailsTo('owner@example.com').length;
    for (const action of ['change', 'remove']) {
      const r = await s.call('POST', E + '/old', { action }, d2);
      assert.equal(r.status, 403); assert.match(r.body.error, /24 小时内不能更换或解除/);
    }
    assert.equal(s.mailsTo('owner@example.com').length, n, '被拦下时不发验证码');
    // 注册时的设备拿到的确认，找回的设备也用不了（冷静期先拦）
    const p = (await s.proveOld(u, 'remove')).body.proof;
    assert.equal((await s.call('DELETE', E, { proof: p }, d2)).status, 403);
    assert.equal(s.app.store.getEmail(u.id).email, 'owner@example.com');
    s.advance(24 * 60 * MIN + MIN);
    const p2 = (await s.proveOld(u, 'remove', d2)).body.proof;
    assert.equal((await s.call('DELETE', E, { proof: p2 }, d2)).status, 204);
  } finally { await s.stop(); }
});

test('限流：验证原来的邮箱按（账号，邮箱）1 分钟 1 次、按邮箱合计；被限的不发邮件；核对按账号、来源地址计', async () => {
  const s = await start({ emailLimits: {} }); // 用默认的限流
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    await s.bindFirst(u, 'old@example.com');
    s.advance(2 * MIN);
    assert.equal((await s.call('POST', E + '/old', { action: 'change' }, u.token)).status, 202);
    const n = s.mailsTo('old@example.com').length;
    const r = await s.call('POST', E + '/old', { action: 'remove' }, u.token);
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal(s.mailsTo('old@example.com').length, n, '被限的请求不发邮件');
    s.advance(MIN + 1000);
    assert.equal((await s.call('POST', E + '/old', { action: 'remove' }, u.token)).status, 202);
  } finally { await s.stop(); }
});

test('确认和验证码在库里只有哈希；留痕只记 email.confirm 和动作，不写邮箱、验证码、确认', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-chg-')), file = path.join(dir, 'a.db');
  const s = await start({ dbFile: file });
  try {
    const u = await s.newUser();
    await s.bindFirst(u, 'li.hua@example.com');
    const r = await s.call('POST', `/api/users/${u.id}/email/old`, { action: 'change' }, u.token);
    const code = s.codeTo('li.hua@example.com');
    const proof = (await s.call('POST', `/api/users/${u.id}/email/old/verify`, { action: 'change', challengeId: r.body.challengeId, code }, u.token)).body.proof;
    const raw = fs.readFileSync(file).toString('latin1') + (fs.existsSync(file + '-wal') ? fs.readFileSync(file + '-wal').toString('latin1') : '');
    assert.ok(!raw.includes(proof), '库文件里没有确认的原文');
    const rows = s.app.store.auditRows(), dump = JSON.stringify(rows);
    for (const bad of ['li.hua', 'example.com', proof, code, r.body.challengeId, u.token]) assert.ok(!dump.includes(bad), bad);
    const c = rows.filter((x) => x.action === 'email.confirm');
    assert.equal(c.length, 1); assert.deepEqual(JSON.parse(c[0].detail), { action: 'change' });
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('邮件的文字：验证原邮箱的验证码邮件、更换和解除的告知不含会被敏感号码过滤拦下的写法、不放链接；告知不再叫人“把邮箱换回来”', () => {
  for (const code of ['000000', '123456', '201127']) {
    for (const m of [TEXTS.oldCode('change', code), TEXTS.oldCode('remove', code)]) {
      assert.equal(findSensitive(m.subject), null); assert.equal(findSensitive(m.text), null);
      assert.doesNotMatch(m.text, /https?:\/\//); assert.doesNotMatch(m.subject, /\d{6}/); assert.match(m.text, new RegExp('验证码：' + code));
    }
  }
  const ms = Date.parse('2026-11-27T03:04:00Z');
  for (const m of [TEXTS.emailChanged(ms), TEXTS.emailRemoved(ms)]) {
    assert.equal(findSensitive(m.text), null); assert.doesNotMatch(m.text, /https?:\/\//);
    assert.match(m.text, /改这个邮箱的密码/); assert.doesNotMatch(m.text, /换回来/, '换回来要那个（对方的）邮箱的验证码，做不到，不这么写');
  }
  assert.match(TEXTS.emailChanged(ms).text, /删除账号/, '说明彻底断开的办法');
});

test('README 写明这两条是确定的规则；待办里不再把冷静期和“换绑前验证原邮箱”列为没定的事', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const todo = fs.readFileSync(path.join(__dirname, '..', 'docs', 'TODO.md'), 'utf8');
  assert.match(readme, /POST \/api\/users\/:id\/email\/old`/);
  assert.match(readme, /24 小时内不能更换或解除/);
  assert.match(readme, /原来的邮箱收不到信/);
  assert.doesNotMatch(todo, /要负责人确认|仍然没定/);
});
