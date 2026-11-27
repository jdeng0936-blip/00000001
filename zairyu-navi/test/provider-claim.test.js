// 服务商用联系邮箱领取令牌；重新领取作废旧令牌；下架后令牌立即失效，排队中的通知和账单邮件不发；重新上架后旧令牌仍然无效。
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, MIN } = require('./provider-helpers');

test('领取令牌：没批准、已下架、不存在的邮箱，返回一样，也不发邮件（排一行占位）', async () => {
  const s = await start();
  try {
    const p = await s.onboard('ok@example.jp');
    const pend = 'pending@example.jp'; await s.apply(pend);
    const off = await s.onboard('off@example.jp'); await s.adm('PUT', '/api/admin/providers/' + off.providerId + '/active', { active: false });
    const shape = (r) => r.status + ':' + Object.keys(r.body).sort().join(',') + ':' + r.body.challengeId.length + ':' + r.body.expiresInSec;
    const before = s.mails().length;
    const rs = [];
    for (const e of ['ok@example.jp', pend, 'off@example.jp', 'nobody@example.jp']) rs.push(await s.call('POST', '/api/provider-claim/code', { email: e }));
    assert.equal(new Set(rs.map(shape)).size, 1, '返回的形状一样');
    const added = s.mails().slice(before);
    assert.equal(added.length, 1, '只有在架服务商的联系邮箱收到验证码'); assert.equal(added[0].to, 'ok@example.jp'); assert.match(added[0].subject, /领取服务商令牌/);
    // 不是的话验证码永远验不过
    for (const r of rs.slice(1)) for (const c of ['000000', '123456']) assert.equal((await s.call('POST', '/api/provider-claim', { challengeId: r.body.challengeId, code: c })).status, 422);
    assert.ok(p.token);
  } finally { await s.stop(); }
});

test('领取：领到的令牌能用；重新领取后旧令牌 401；领取后联系邮箱收到“已重新发放”的告知（里面没有令牌）', async () => {
  const s = await start();
  try {
    const p = await s.onboard('c@example.jp');
    const me = await s.call('GET', '/api/provider/me', null, p.token);
    assert.equal(me.status, 200); assert.equal(me.body.name, '大阪中文行政书士事务所'); assert.equal(me.body.contact, 'c***@example.jp'); assert.equal(me.body.listed, false, '还没付款');
    assert.equal(me.body.notify, true); assert.equal(me.body.licenseBody, '大阪府行政書士会');
    const again = await s.claim('c@example.jp');
    assert.equal(again.status, 200); assert.notEqual(again.body.token, p.token);
    assert.equal((await s.call('GET', '/api/provider/me', null, p.token)).status, 401, '旧令牌失效');
    assert.equal((await s.call('GET', '/api/provider/me', null, again.body.token)).status, 200);
    const m = s.lastMail('c@example.jp');
    assert.match(m.subject, /已重新发放/); assert.ok(!m.body.includes(again.body.token));
    for (const x of s.mails('c@example.jp')) assert.ok(!x.body.includes(again.body.token) && !x.body.includes(p.token), '任何邮件里都没有令牌');
    // 验证码错 5 次作废
    const r = await s.call('POST', '/api/provider-claim/code', { email: 'c@example.jp' });
    const code = s.codeIn(s.lastMail('c@example.jp')), wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/provider-claim', { challengeId: r.body.challengeId, code: wrong })).status, 422);
    assert.equal((await s.call('POST', '/api/provider-claim', { challengeId: r.body.challengeId, code })).status, 422, '错满 5 次后对的也不行');
    // 重新索取不作废之前的（谁都能对着这个邮箱点发送）
    const r1 = await s.call('POST', '/api/provider-claim/code', { email: 'c@example.jp' }); const c1 = s.codeIn(s.lastMail('c@example.jp'));
    s.advance(2 * MIN);
    await s.call('POST', '/api/provider-claim/code', { email: 'c@example.jp' });
    assert.equal((await s.call('POST', '/api/provider-claim', { challengeId: r1.body.challengeId, code: c1 })).status, 200);
  } finally { await s.stop(); }
});

test('下架：令牌马上 401，排队中的新咨询通知和账单邮件被丢弃；重新上架后旧令牌仍然 401，要重新领取', async () => {
  const s = await start({ notify: { delayMin: 0, intervalMin: 60 } });
  try {
    const p = await s.onboard('d@example.jp', null, true);
    const u = await s.newUser();
    assert.equal((await s.inquire(u, [p.providerId])).status, 201);
    s.app.notifier.runOnce();
    const inv = s.app.billing.issueFor(p.providerId, '2026-12');
    assert.ok(inv);
    const queued = () => s.mails('d@example.jp').filter((m) => ['pnotice', 'billing'].includes(m.kind) && m.status === 'queued');
    assert.equal(queued().length, 2, '一封通知、一封账单');
    assert.equal((await s.adm('PUT', '/api/admin/providers/' + p.providerId + '/active', { active: false })).status, 200);
    assert.equal((await s.call('GET', '/api/provider/me', null, p.token)).status, 401);
    assert.equal(queued().length, 0);
    assert.ok(s.mails().filter((m) => m.status === 'dropped').length >= 2);
    assert.ok(!(await s.listed()).some((x) => x.id === p.providerId));
    await s.adm('PUT', '/api/admin/providers/' + p.providerId + '/active', { active: true });
    assert.equal((await s.call('GET', '/api/provider/me', null, p.token)).status, 401, '重新上架后旧令牌仍然无效');
    const c = await s.claim('d@example.jp');
    assert.equal(c.status, 200);
    assert.equal((await s.call('GET', '/api/provider/me', null, c.body.token)).status, 200);
    assert.ok(s.app.store.auditRows().some((r) => r.action === 'provider.revoke'));
  } finally { await s.stop(); }
});
