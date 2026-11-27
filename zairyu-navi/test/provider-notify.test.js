// 新咨询通知：延迟到了才发、合成一封、间隔、内容里没有咨询本身、关掉通知、下架、用户删账号、退订页。
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, MIN, APP } = require('./provider-helpers');

const SUMMARY = '想咨询永驻申请，目前在留8年、就劳6年，配偶是日本人。';

test('延迟到了才发一封；正文只有数量、类别、工作台链接和退订链接，没有摘要、节点、用户编号', async () => {
  const s = await start({ notify: { delayMin: 5, intervalMin: 60 } });
  try {
    const p = await s.onboard('n@example.jp', null, true);
    const u = await s.newUser();
    const r = await s.call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', nodeId: '5-1', providerIds: [p.providerId], summary: SUMMARY }, u.token);
    assert.equal(r.status, 201);
    const pn = () => s.mails('n@example.jp').filter((m) => m.kind === 'pnotice');
    s.app.notifier.runOnce(); assert.equal(pn().length, 0, '5 分钟没到');
    s.advance(4 * MIN); s.app.notifier.runOnce(); assert.equal(pn().length, 0);
    s.advance(1 * MIN); s.app.notifier.runOnce(); assert.equal(pn().length, 1);
    s.app.notifier.runOnce(); assert.equal(pn().length, 1, '跑两遍不重复');
    await s.app.deliver();
    const m = pn()[0];
    assert.equal(m.status, 'sent'); assert.equal(m.userId, null, 'user_id 留空');
    assert.match(m.subject, /有 1 条新咨询/); assert.match(m.body, /类别：行政书士/);
    assert.ok(m.body.includes(APP + '/provider.html'));
    assert.ok(m.body.includes(APP + '/api/provider-unsubscribe?t='));
    assert.ok(m.headers['List-Unsubscribe'].includes('/api/provider-unsubscribe?t='));
    for (const bad of [SUMMARY, SUMMARY.slice(0, 8), '永驻', '5-1', u.id, r.body.ids[0]]) assert.ok(!m.body.includes(bad) && !m.subject.includes(bad), '不应当出现：' + bad);
  } finally { await s.stop(); }
});

test('同一段时间里两条合成一封（数量是 2）；间隔不到不发；间隔到了再发下一封', async () => {
  const s = await start({ notify: { delayMin: 5, intervalMin: 60 } });
  try {
    const p = await s.onboard('m@example.jp', null, true);
    const u = await s.newUser(), v = await s.newUser();
    await s.inquire(u, [p.providerId]); s.advance(2 * MIN); await s.inquire(v, [p.providerId]);
    s.advance(5 * MIN); s.app.notifier.runOnce(); await s.app.deliver();
    const pn = () => s.mails('m@example.jp').filter((m) => m.kind === 'pnotice');
    assert.equal(pn().length, 1); assert.match(pn()[0].subject, /有 2 条新咨询/);
    await s.inquire(u, [p.providerId]);
    s.advance(10 * MIN); s.app.notifier.runOnce(); assert.equal(pn().length, 1, '离上一封不到 60 分钟');
    s.advance(50 * MIN); s.app.notifier.runOnce(); assert.equal(pn().length, 2);
    await s.app.deliver(); assert.match(pn()[1].subject, /有 1 条新咨询/);
  } finally { await s.stop(); }
});

test('关掉通知、下架、用户删了账号（数量变成 0），这三种都不发', async () => {
  const s = await start({ notify: { delayMin: 0, intervalMin: 1 } });
  try {
    // 发之前地址和正文会清掉，所以按编号看状态
    const queuedIds = (to) => s.mails(to).filter((m) => m.kind === 'pnotice' && m.status === 'queued').map((m) => m.id);
    const statusOf = (ids) => s.app.store.listOutbox().filter((m) => ids.includes(m.id)).map((m) => m.status);
    // 关掉通知：已经排了队的也不发；关着的时候来的咨询不记
    const a = await s.onboard('a@example.jp', null, true), u = await s.newUser();
    await s.inquire(u, [a.providerId]); s.app.notifier.runOnce();
    const qa = queuedIds('a@example.jp'); assert.equal(qa.length, 1);
    assert.equal((await s.call('PUT', '/api/provider/me/notify', { on: false }, a.token)).body.notify, false);
    await s.app.deliver();
    assert.deepEqual(statusOf(qa), ['dropped']);
    await s.inquire(u, [a.providerId]); s.advance(2 * MIN); s.app.notifier.runOnce();
    assert.equal(queuedIds('a@example.jp').length, 0);
    assert.equal((await s.call('GET', '/api/provider/me', null, a.token)).body.notify, false);
    assert.equal((await s.call('PUT', '/api/provider/me/notify', { on: 'yes' }, a.token)).status, 422);
    // 下架：排着的不发
    const b = await s.onboard('b@example.jp', null, true);
    await s.inquire(u, [b.providerId]); s.advance(2 * MIN); s.app.notifier.runOnce();
    const qb = queuedIds('b@example.jp'); assert.equal(qb.length, 1);
    await s.adm('PUT', '/api/admin/providers/' + b.providerId + '/active', { active: false });
    await s.app.deliver();
    assert.deepEqual(statusOf(qb), ['dropped']);
    // 用户删了账号：排着的那封发之前数量变成 0，不发；还没排的也不排
    const c = await s.onboard('c@example.jp', null, true), w = await s.newUser();
    await s.inquire(w, [c.providerId]); s.advance(2 * MIN); s.app.notifier.runOnce();
    const qc = queuedIds('c@example.jp'); assert.equal(qc.length, 1);
    assert.equal((await s.call('DELETE', '/api/users/' + w.id, null, w.token)).status, 204);
    assert.deepEqual(statusOf(qc), ['queued'], '删账号不碰服务商的通知记录（user_id 留空）');
    await s.app.deliver();
    assert.deepEqual(statusOf(qc), ['dropped']);
    const before = s.app.store.listOutbox().filter((m) => m.kind === 'pnotice').length;
    const x = await s.newUser();
    await s.inquire(x, [c.providerId]);
    await s.call('DELETE', '/api/users/' + x.id, null, x.token);
    s.advance(2 * MIN); s.app.notifier.runOnce();
    assert.equal(s.app.store.listOutbox().filter((m) => m.kind === 'pnotice').length, before, '数量是 0 就不排');
  } finally { await s.stop(); }
});

test('退订页：GET 只显示确认页、不改设置；POST 才关掉；令牌不对返回一样；留痕里没有邮箱', async () => {
  const s = await start({ notify: { delayMin: 0, intervalMin: 1 } });
  try {
    const p = await s.onboard('u@example.jp', null, true);
    const tok = s.app.store.providerContact(p.providerId).unsubToken;
    const g = await s.call('GET', '/api/provider-unsubscribe?t=' + tok);
    assert.equal(g.status, 200); assert.match(g.body, /关闭新咨询通知/); assert.match(g.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(s.app.store.providerContact(p.providerId).notify, true, 'GET 不改');
    const bad = await s.call('POST', '/api/provider-unsubscribe?t=' + 'x'.repeat(43));
    const ok = await fetch(s.base + '/api/provider-unsubscribe?t=' + tok, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(ok.status, 200); assert.equal(await ok.text(), bad.body, '返回的页面一样');
    assert.equal(s.app.store.providerContact(p.providerId).notify, false);
    assert.equal((await s.call('GET', '/api/provider/me', null, p.token)).body.notify, false);
    assert.equal((await s.call('PUT', '/api/provider/me/notify', { on: true }, p.token)).status, 200, '工作台里可以重新打开');
    assert.ok(!JSON.stringify(s.app.store.auditRows()).includes('@'));
    assert.ok(!JSON.stringify(s.app.store.auditRows()).includes(tok));
  } finally { await s.stop(); }
});

test('咨询的时间和通知的起点是同一个时刻：时钟每读一次都走一毫秒，也不会把这一条漏掉', async () => {
  // 以前咨询时间和起点分两次取，跨过一毫秒时起点比咨询晚，统计出来是 0 条，通知就不发了
  let t = Date.parse('2026-11-27T03:00:00Z');
  const s = await start({ clock: () => (t += 1), notify: { delayMin: 0, intervalMin: 1 } });
  try {
    const p = await s.onboard('tick@example.jp', null, true), u = await s.newUser();
    for (let i = 0; i < 5; i++) {
      assert.equal((await s.inquire(u, [p.providerId])).status, 201);
      t += 2 * 60 * 1000;
      assert.equal(s.app.notifier.runOnce().mails, 1, '第 ' + (i + 1) + ' 条');
      await s.app.deliver();
    }
  } finally { await s.stop(); }
});
