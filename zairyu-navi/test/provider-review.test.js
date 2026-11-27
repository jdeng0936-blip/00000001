// 入驻申请的审核：核对记录、拒绝、要求修改、令牌不让管理员看到、后台改不了类别和金额、留痕、管理员令牌。
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, CHECK, ALICE, BOB } = require('./provider-helpers');
const { createApp, adminTokens } = require('../src/server');

test('批准：士业不填核对方式不能批准；核对日期晚于今天 422；记下的核对人和时间对得上；不能批准两次', async () => {
  const s = await start();
  try {
    const a = await s.apply('a@example.jp'), id = s.appByRef(a.body.ref).id, P = '/api/admin/applications/' + id;
    assert.equal((await s.adm('POST', P + '/approve', { reviewKey: s.rk(id) })).status, 422, '士业必须有核对记录');
    assert.equal((await s.adm('POST', P + '/approve', { reviewKey: s.rk(id), licenseCheck: { method: 'guess', checkedOn: '2026-11-27' } })).status, 422, '核对方式不在清单里');
    assert.equal((await s.adm('POST', P + '/approve', { reviewKey: s.rk(id), licenseCheck: { method: 'certificate', checkedOn: '2026-11-28' } })).status, 422, '核对日期晚于今天（日本时间）');
    assert.equal((await s.adm('POST', P + '/approve', { reviewKey: s.rk(id), licenseCheck: { method: 'certificate', checkedOn: '2026-11-27', note: '账号 1234567' } })).status, 422, '备注也过敏感号码过滤');
    assert.equal((await s.adm('POST', P + '/approve', { reviewKey: s.rk(id), licenseCheck: CHECK, amount: 1 })).status, 422, '金额不能指定');
    assert.equal((await s.adm('POST', P + '/approve', { reviewKey: s.rk(id), licenseCheck: CHECK }, 'nope-nope-nope-nope-nope-nope')).status, 401);
    const r = await s.adm('POST', P + '/approve', { reviewKey: s.rk(id), licenseCheck: CHECK }, BOB);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['freeUntil', 'providerId'], '返回里没有令牌'); assert.equal(r.body.freeUntil, '2026-11-30', '批准当月免费');
    const d = (await s.adm('GET', P)).body;
    assert.equal(d.status, 'approved'); assert.equal(d.decidedBy, 'bob');
    assert.deepEqual(d.licenseCheck, { method: 'association_search', note: '会员检索一致', checkedOn: '2026-11-27', checkedBy: 'bob' });
    assert.equal(d.decidedAt, new Date(s.now()).toISOString(), '核对时间是服务器时间');
    assert.equal(d.email, 'a***@example.jp', '管理员看到的邮箱也打码');
    assert.match(d.checkWhere, /日本行政書士会連合会/);
    assert.equal((await s.adm('POST', P + '/approve', { reviewKey: s.rk(id), licenseCheck: CHECK })).status, 409, '不能批准两次');
    assert.equal((await s.adm('POST', P + '/reject', { reviewKey: s.rk(id), reason: '已经批准过的不能再拒绝。' })).status, 409);
    // 批准邮件：领取令牌的步骤和首月免费的说明，没有令牌，也没有账单
    const m = s.lastMail('a@example.jp');
    assert.match(m.subject, /已批准/); assert.match(m.body, /用联系邮箱领取/); assert.match(m.body, /批准当月免费/); assert.doesNotMatch(m.body, /参考编号|付款期限/);
    // 非士业不用核对记录
    const b = await s.apply('b@example.jp', { category: 'mobile', licenseNo: '', licenseBody: '' });
    assert.equal((await s.adm('POST', '/api/admin/applications/' + s.appByRef(b.body.ref).id + '/approve', { reviewKey: s.appByRef(b.body.ref).reviewKey })).status, 200);
    // 不动产也要
    const e = await s.apply('e@example.jp', { category: 'estate', licenseNo: '大阪府知事(3)第12345号', licenseBody: '' });
    assert.equal((await s.adm('POST', '/api/admin/applications/' + s.appByRef(e.body.ref).id + '/approve', { reviewKey: s.appByRef(e.body.ref).reviewKey })).status, 422);
  } finally { await s.stop(); }
});

test('拒绝和要求修改：都发邮件；理由要 5 至 500 字，有敏感号码 422；列表能按状态筛', async () => {
  const s = await start();
  try {
    const a = await s.apply('r@example.jp'), id = s.appByRef(a.body.ref).id, P = '/api/admin/applications/' + id;
    assert.equal((await s.adm('POST', P + '/reject', { reviewKey: s.rk(id), reason: '短' })).status, 422);
    assert.equal((await s.adm('POST', P + '/reject', { reviewKey: s.rk(id), reason: '登录番号对不上，个人编号 123456789012' })).status, 422);
    assert.equal((await s.adm('POST', P + '/request-changes', { reviewKey: s.rk(id), message: '请把护照号 E12345678 删掉' })).status, 422);
    const c = await s.adm('POST', P + '/request-changes', { reviewKey: s.rk(id), message: '所属会的名称请写全称。' });
    assert.equal(c.status, 200); assert.equal(c.body.status, 'changes_requested');
    assert.match(s.lastMail('r@example.jp').body, /所属会的名称请写全称/);
    assert.equal((await s.adm('POST', P + '/reject', { reviewKey: s.rk(id), reason: '要求修改中不能直接拒绝。' })).status, 409, '只能从审核中拒绝');
    const b = await s.apply('q@example.jp'), idb = s.appByRef(b.body.ref).id;
    const r = await s.adm('POST', '/api/admin/applications/' + idb + '/reject', { reviewKey: s.rk(idb), reason: '会员检索里查不到这个登录番号。' });
    assert.equal(r.status, 200);
    const m = s.lastMail('q@example.jp'); assert.match(m.subject, /审核结果/); assert.match(m.body, /查不到这个登录番号/);
    assert.deepEqual((await s.adm('GET', '/api/admin/applications?status=rejected')).body.map((x) => x.ref), [b.body.ref]);
    assert.equal((await s.adm('GET', '/api/admin/applications')).body.length, 2);
    assert.equal((await s.adm('GET', '/api/admin/applications/nope')).status, 404);
  } finally { await s.stop(); }
});

test('令牌不让管理员看到：批准、发件箱、管理员接口的返回里都没有任何服务商令牌', async () => {
  const s = await start();
  try {
    const p = await s.onboard('t@example.jp', null, true);
    const tokens = [p.token];
    // 重新领取一次，新旧令牌都扫
    tokens.push((await s.claim('t@example.jp')).body.token);
    const blobs = [JSON.stringify(s.app.store.listOutbox()), JSON.stringify((await s.adm('GET', '/api/admin/outbox')).body), JSON.stringify((await s.adm('GET', '/api/admin/providers')).body),
      JSON.stringify((await s.adm('GET', '/api/admin/applications')).body), JSON.stringify((await s.adm('GET', '/api/admin/invoices')).body), JSON.stringify(s.app.store.auditRows())];
    for (const t of tokens) for (const b of blobs) assert.ok(!b.includes(t), '不应当出现服务商令牌');
  } finally { await s.stop(); }
});

test('后台改不了：没有修改类别、收费方式、登录番号、金额的接口（都是 404）', async () => {
  const s = await start();
  try {
    const p = await s.onboard('n@example.jp');
    s.app.billing.runOnce();
    const A = '/api/admin/providers/' + p.providerId, I = '/api/admin/invoices/' + s.app.store.invoiceFor(p.providerId, '2026-12').id, AP = '/api/admin/applications/' + s.appByRef(p.ref).id;
    for (const [m, path, b] of [['PATCH', A, { category: 'mobile' }], ['PUT', A, { feeModel: 'affiliate_disclosed' }], ['PUT', A + '/category', { category: 'mobile' }], ['PUT', A + '/fee-model', { feeModel: 'success' }],
      ['PUT', A + '/license', { licenseNo: '1' }], ['PATCH', I, { amountYen: 1 }], ['PUT', I, { amountYen: 1 }], ['PUT', I + '/amount', { amount: 1 }], ['PATCH', AP, { category: 'mobile' }], ['PUT', AP, { licenseNo: '1' }]]) {
      assert.equal((await s.adm(m, path, b)).status, 404, m + ' ' + path);
    }
    assert.equal((await s.adm('POST', I + '/paid', { paidOn: '2026-11-27', amount: 0 })).status, 422);
    const pv = s.app.store.getProvider(p.providerId);
    assert.equal(pv.category, 'gyosei'); assert.equal(pv.feeModel, 'fixed_listing'); assert.equal(pv.licenseNo, '12345678');
  } finally { await s.stop(); }
});

test('留痕：只有编号、动作和管理员名，没有 @、6 位验证码、令牌、理由原文', async () => {
  const s = await start();
  try {
    const p = await s.onboard('audit@example.jp');
    s.app.billing.runOnce();
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + s.app.store.invoiceFor(p.providerId, '2026-12').id + '/paid', { paidOn: '2026-11-27' })).status, 200);
    const b = await s.apply('audit2@example.jp');
    await s.adm('POST', '/api/admin/applications/' + s.appByRef(b.body.ref).id + '/reject', { reviewKey: s.appByRef(b.body.ref).reviewKey, reason: '这是不应当进留痕的理由原文。' });
    await s.call('PUT', '/api/provider/me/notify', { on: false }, p.token);
    const rows = s.app.store.auditRows(), text = JSON.stringify(rows);
    assert.ok(!text.includes('@'), '没有邮箱'); const codes = s.app.store.listOutbox().filter((m) => m.kind === 'code').map((m) => s.codeIn(m));
    assert.ok(codes.length >= 3); for (const c of codes) assert.ok(!text.includes('"' + c + '"') && !text.includes(':' + c), '没有验证码');
    assert.ok(!text.includes(p.token)); assert.ok(!text.includes('理由原文')); assert.ok(!text.includes('会员检索一致'), '核对备注不进留痕');
    const actions = rows.map((r) => r.action);
    for (const a of ['papply.submit', 'papply.approve', 'papply.reject', 'provider.claim', 'invoice.issue', 'invoice.paid', 'provider.notify']) assert.ok(actions.includes(a), a);
    const ap = rows.find((r) => r.action === 'papply.approve');
    assert.equal(JSON.parse(ap.detail).by, 'alice'); assert.equal(JSON.parse(ap.detail).method, 'association_search');
    assert.equal(JSON.parse(rows.find((r) => r.action === 'invoice.paid').detail).by, 'alice');
  } finally { await s.stop(); }
});

test('管理员直接入驻：不开 allowDirectProvider 时 POST /api/admin/providers 是 404', async () => {
  const s = await start();
  try {
    assert.equal((await s.adm('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei', licenseNo: '第12345678号', licenseBody: '大阪府行政書士会' })).status, 404);
  } finally { await s.stop(); }
  const s2 = await start({ allowDirectProvider: true });
  try {
    const r = await s2.adm('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei', licenseNo: '第12345678号', licenseBody: '大阪府行政書士会' });
    assert.equal(r.status, 201); assert.ok(r.body.token, '只有测试开关打开时才会');
    assert.equal((await s2.adm('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei', licenseNo: '第12345678号', licenseBody: '大阪府行政書士会', feeNote: '日本一' })).status, 422, '和申请共用保证类用语的检查');
  } finally { await s2.stop(); }
});

test('ADMIN_TOKENS：写错时抛错；名字或令牌错都是 401；ADMIN_TOKEN 继续可用，名字记为 admin', async () => {
  assert.deepEqual(adminTokens('alice:' + ALICE + ', bob:' + BOB).map((a) => a.name), ['alice', 'bob']);
  assert.deepEqual(adminTokens(''), []);
  for (const bad of ['alice', 'Alice:' + ALICE, 'alice:short', 'a b:' + ALICE, 'alice:' + ALICE + ',alice:' + BOB, ':' + ALICE]) assert.throws(() => adminTokens(bad), /ADMIN_TOKENS/, bad);
  assert.throws(() => createApp({ adminTokens: 'alice:short' }), /ADMIN_TOKENS/);
  const s = await start({ adminToken: 'legacy-admin' });
  try {
    assert.equal((await s.adm('GET', '/api/admin/applications', null, 'alice:' + ALICE)).status, 401, '名字不是令牌的一部分');
    assert.equal((await s.adm('GET', '/api/admin/applications', null, ALICE + 'x')).status, 401);
    assert.equal((await s.adm('GET', '/api/admin/applications', null, ALICE)).status, 200);
    const a = await s.apply('l@example.jp');
    await s.adm('POST', '/api/admin/applications/' + s.appByRef(a.body.ref).id + '/request-changes', { reviewKey: s.appByRef(a.body.ref).reviewKey, message: '请补充营业时间。' }, 'legacy-admin');
    assert.equal(s.appByRef(a.body.ref).decidedBy, 'admin');
  } finally { await s.stop(); }
  const none = await start({ adminTokens: null, adminToken: null });
  try { assert.equal((await none.adm('GET', '/api/admin/applications')).status, 503); } finally { await none.stop(); }
});
