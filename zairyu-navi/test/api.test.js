const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

let base, app;
const tokens = {};
const V = '2026-11-26';
const adminCall = (method, path, body) => call(method, path, body, 'adm-secret');
const newProvider = async (over) => (await adminCall('POST', '/api/admin/providers', Object.assign({ name: '示例行政书士事务所', category: 'gyosei', area: '大阪', langs: '中文、日语', feeNote: '首次咨询30分钟5,500日元', licenseNo: '第00000000号' }, over))).body;
const call = async (method, path, body, token) => {
  if (method === 'POST' && path === '/api/users' && !body) body = { accept: V };
  const id = (/\/api\/users\/([^/]+)/.exec(path) || [])[1];
  const tk = token !== undefined ? token : tokens[id];
  const headers = Object.assign(body ? { 'content-type': 'application/json' } : {}, tk ? { authorization: 'Bearer ' + tk } : {});
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const out = { status: r.status, body: text ? JSON.parse(text) : null };
  if (method === 'POST' && path === '/api/users' && out.body) tokens[out.body.id] = out.body.token;
  return out;
};

test.before(async () => {
  app = createApp({ now: '2026-11-26', adminToken: 'adm-secret' });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + app.server.address().port;
});
test.after(() => { app.server.close(); app.store.close(); });

test('健康检查和节点列表', async () => {
  assert.equal((await call('GET', '/api/health')).body.nodes, 26);
  const list = (await call('GET', '/api/nodes')).body;
  assert.equal(list.length, 26);
  const n = (await call('GET', '/api/nodes/1-1')).body;
  assert.equal(n.t, '住民登记');
  assert.ok(n.rows.every((r) => typeof r.verified === 'boolean'));
  assert.equal((await call('GET', '/api/nodes/9-9')).status, 404);
});

test('完整流程：建用户、填情况、看路线、完成任务、解锁下一步', async () => {
  const u = (await call('POST', '/api/users')).body;
  assert.ok(u.id); assert.equal(u.profile.status, 'none');
  let r = await call('PATCH', `/api/users/${u.id}/profile`, { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-11-20', ins: true });
  assert.equal(r.status, 200);
  let plan = (await call('GET', `/api/users/${u.id}/plan`)).body;
  assert.equal(plan.next.id, '1-1');
  r = await call('PUT', `/api/users/${u.id}/tasks/2-2/done`, { done: true });
  assert.equal(r.status, 409, '没解锁的任务不能标记完成');
  plan = (await call('PUT', `/api/users/${u.id}/tasks/1-1/done`, { done: true })).body;
  assert.equal(plan.tasks.find((t) => t.id === '1-1').state, 'done');
  assert.equal(plan.tasks.find((t) => t.id === '2-2').state, 'todo');
  plan = (await call('PUT', `/api/users/${u.id}/tasks/1-1/done`, { done: false })).body;
  assert.equal(plan.tasks.find((t) => t.id === '1-1').state, 'todo');
  assert.ok((await call('GET', `/api/users/${u.id}/reminders`)).body.length > 0);
  assert.ok((await call('GET', `/api/users/${u.id}/advice`)).body.length > 0);
  assert.equal((await call('GET', `/api/users/${u.id}/pr-check`)).status, 200);
});

test('填写校验：日期格式、身份取值、未知字段', async () => {
  const u = (await call('POST', '/api/users')).body;
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { entry: '2026/11/18' })).status, 422);
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { status: 'king' })).status, 422);
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { foo: 1 })).status, 422);
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { trips: [['2026-02-01', '2026-01-01']] })).status, 422);
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { trips: [['2026-01-01', '2026-02-01']] })).status, 200);
});

test('合规：不接收个人编号、护照号、银行账号', async () => {
  const u = (await call('POST', '/api/users')).body;
  for (const k of ['myNumber', 'my_number', '个人编号', 'passportNo', 'bankAccount']) {
    const r = await call('PATCH', `/api/users/${u.id}/profile`, { [k]: '123456789012' });
    assert.equal(r.status, 422, k);
  }
  const stored = (await call('GET', `/api/users/${u.id}`)).body;
  assert.ok(!JSON.stringify(stored).includes('123456789012'));
});

test('合规：咨询必须有用户同意、选了服务商，摘要里不能带个人编号', async () => {
  const u = (await call('POST', '/api/users')).body, p = await newProvider();
  const ok = { nodeId: '4-1', category: 'gyosei', providerId: p.id, summary: '在留期间更新，想请行政书士制作申请书，明年11月到期。' };
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, ok)).status, 422, '没有同意不能发');
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, Object.assign({ consent: true }, ok, { providerId: undefined }))).status, 422, '没选服务商不能发');
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, Object.assign({ consent: true }, ok, { category: 'zeirishi' }))).status, 422, '类别和服务商不符');
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, Object.assign({ consent: true }, ok, { summary: '我的个人编号是 1234 5678 9012，请帮我办理' }))).status, 422);
  const r = await call('POST', `/api/users/${u.id}/inquiries`, Object.assign({ consent: true }, ok));
  assert.equal(r.status, 201);
  const mine = (await call('GET', `/api/users/${u.id}/inquiries`)).body;
  assert.equal(mine.length, 1); assert.equal(mine[0].providerName, '示例行政书士事务所'); assert.equal(mine[0].status, 'sent');
});

test('合规：士业只按固定展示费，非士业的推广要标明', async () => {
  const cats = (await call('GET', '/api/providers/categories')).body;
  assert.equal(cats.find((c) => c.key === 'gyosei').feeModel, 'fixed_listing');
  assert.equal(cats.find((c) => c.key === 'zeirishi').feeModel, 'fixed_listing');
  assert.equal(cats.find((c) => c.key === 'edu').feeModel, 'affiliate_disclosed');
});

test('选方案接口：带参数、未知主题', async () => {
  const r = (await call('GET', '/api/options/route?jsp=yes')).body;
  assert.equal(r.options[0].name, '日本人或永住者的配偶');
  assert.equal((await call('GET', '/api/options/nope')).status, 404);
  const b = (await call('GET', '/api/options/budget?bLife=6')).body;
  assert.equal(b.options.length, 3);
});

test('用户可以删除自己的全部数据', async () => {
  const u = (await call('POST', '/api/users')).body;
  const p = await newProvider();
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerId: p.id, summary: '想咨询在留更新的手续。' })).status, 201);
  await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-12-01' });
  assert.equal((await call('DELETE', `/api/users/${u.id}`)).status, 204);
  assert.equal((await call('GET', `/api/users/${u.id}`)).status, 401);
});

test('请求体不是 JSON 时返回 400，不存在的接口返回 404', async () => {
  const r = await fetch(base + '/api/users/x/profile', { method: 'PATCH', body: '{bad' });
  assert.ok([400, 404].includes(r.status));
  assert.equal((await call('GET', '/api/whatever')).status, 404);
});

test('助手接口：没配置模型时返回 503', async () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const u = (await call('POST', '/api/users')).body;
  assert.equal((await call('POST', `/api/users/${u.id}/chat`, { message: '你好' })).status, 503);
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
});

test('登录：没有令牌、令牌不对、拿别人的令牌，都读不到数据', async () => {
  const a = (await call('POST', '/api/users')).body, b = (await call('POST', '/api/users')).body;
  assert.ok(a.token && a.token.length >= 40);
  assert.equal((await call('GET', `/api/users/${a.id}`, null, '')).status, 401);
  assert.equal((await call('GET', `/api/users/${a.id}`, null, 'wrong')).status, 401);
  assert.equal((await call('GET', `/api/users/${a.id}`, null, b.token)).status, 401);
  assert.equal((await call('GET', `/api/users/no-such-id`, null, b.token)).status, 401);
  const mine = await call('GET', `/api/users/${a.id}`);
  assert.equal(mine.status, 200);
  assert.ok(!('token' in mine.body) && !JSON.stringify(mine.body).includes(a.token), '读取时不再返回令牌');
});

test('整体同步：概况和完成记录一起保存，非法内容整体拒绝', async () => {
  const u = (await call('POST', '/api/users')).body;
  const st = { profile: { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '', ins: true, age: true, lic: false, pr: true, arrive: '', work: '', hsp: '0', jp: '', pay: true, trips: [] }, done: { '1-1': true, '1-2': false } };
  assert.equal((await call('PUT', `/api/users/${u.id}/state`, st)).status, 200);
  const got = (await call('GET', `/api/users/${u.id}`)).body;
  assert.equal(got.profile.status, 'work'); assert.deepEqual(got.done, { '1-1': true });
  assert.equal((await call('PUT', `/api/users/${u.id}/state`, { profile: {}, done: { '9-9': true } })).status, 422);
  assert.equal((await call('PUT', `/api/users/${u.id}/state`, { profile: { myNumber: '1' }, done: {} })).status, 422);
  assert.deepEqual((await call('GET', `/api/users/${u.id}`)).body.done, { '1-1': true }, '被拒绝的同步不应改动数据');
});

test('注册：不同意使用条款和隐私政策就不能建账号', async () => {
  assert.equal((await call('POST', '/api/users', {})).status, 422);
  assert.equal((await call('POST', '/api/users', { accept: '2020-01-01' })).status, 422);
  assert.equal((await call('GET', '/api/terms')).body.version, V);
  const u = (await call('POST', '/api/users', { accept: V })).body;
  assert.equal(u.consentVersion, V);
});

test('事件：记录换工作后，提醒里出现14天期限；孩子出生有14天和30天两个期限', async () => {
  const u = (await call('POST', '/api/users')).body;
  await call('PATCH', `/api/users/${u.id}/profile`, { status: 'work', entry: '2026-01-10', addr: '2026-01-12', exp: '2027-11-20', ins: true });
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'job_change', date: '下周一' })).status, 422);
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'party', date: '2026-12-01' })).status, 422);
  const ev = await call('POST', `/api/users/${u.id}/events`, { type: 'job_change', date: '2026-11-30' });
  assert.equal(ev.status, 201);
  await call('POST', `/api/users/${u.id}/events`, { type: 'birth', date: '2026-12-01' });
  const rem = (await call('GET', `/api/users/${u.id}/reminders`)).body.filter((r) => r.tag === '事件');
  assert.equal(rem.length, 3);
  assert.equal(rem.find((r) => /所属机关/.test(r.text)).date.slice(0, 10) >= '2026-12-13', true);
  assert.equal((await call('GET', `/api/users/${u.id}/events`)).body[0].label, '换工作或离职');
  assert.equal((await call('DELETE', `/api/users/${u.id}/events/${ev.body.id}`)).status, 204);
  assert.equal((await call('GET', `/api/users/${u.id}/reminders`)).body.filter((r) => r.tag === '事件').length, 2);
});

test('服务商入驻：士业不能按成交抽成、必须有登录番号；收费说明不能有保证类用语', async () => {
  assert.equal((await call('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei', licenseNo: '1' }, 'wrong')).status, 401);
  assert.equal((await adminCall('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei', licenseNo: '第1号', feeModel: 'affiliate_disclosed' })).status, 422);
  assert.equal((await adminCall('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei' })).status, 422);
  assert.equal((await adminCall('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei', licenseNo: '第1号', feeNote: '永驻包过' })).status, 422);
  const school = (await adminCall('POST', '/api/admin/providers', { name: '某日语学校', category: 'edu' })).body;
  assert.equal(school.feeModel, 'affiliate_disclosed');
  const pub = (await call('GET', '/api/providers?category=edu')).body.find((x) => x.id === school.id);
  assert.equal(pub.promoted, true, '非士业的推广要对用户标明'); assert.ok(!('token' in pub) && !('feeModel' in pub));
});

test('对接全流程：用户发给两家，服务商只看到自己的、看不到用户身份，回复后用户能看到', async () => {
  const u = (await call('POST', '/api/users')).body;
  const p1 = await newProvider({ name: '甲行政书士事务所' }), p2 = await newProvider({ name: '乙行政书士事务所' }), p3 = await newProvider({ name: '丙税理士事务所', category: 'zeirishi' });
  const sent = await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerIds: [p1.id, p2.id], summary: '想咨询永驻申请，目前在留8年、就劳6年。' });
  assert.equal(sent.status, 201); assert.equal(sent.body.ids.length, 2);
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerIds: [p1.id, p1.id], summary: '重复发送的测试内容。' })).status, 422);
  const inbox1 = (await call('GET', '/api/provider/inquiries', null, p1.token)).body;
  assert.equal(inbox1.length, 1); assert.ok(!JSON.stringify(inbox1).includes(u.id), '服务商看不到用户 id');
  assert.equal((await call('GET', '/api/provider/inquiries', null, p3.token)).body.length, 0);
  assert.equal((await call('GET', '/api/provider/inquiries', null, 'nope')).status, 401);
  assert.equal((await call('POST', `/api/provider/inquiries/${inbox1[0].id}/reply`, { text: '可以办理，报酬12万日元起，请带在留卡来面谈。' }, p2.token)).status, 404, '不能回复别人的咨询');
  await call('PUT', `/api/provider/inquiries/${inbox1[0].id}/status`, { status: 'viewed' }, p1.token);
  assert.equal((await call('POST', `/api/provider/inquiries/${inbox1[0].id}/reply`, { text: '可以办理，报酬12万日元起，请带在留卡来面谈。' }, p1.token)).status, 201);
  const mine = (await call('GET', `/api/users/${u.id}/inquiries`)).body;
  const a = mine.find((q) => q.providerName === '甲行政书士事务所'), b2 = mine.find((q) => q.providerName === '乙行政书士事务所');
  assert.equal(a.status, 'replied'); assert.equal(a.replies.length, 1); assert.equal(b2.status, 'sent');
  await adminCall('PUT', `/api/admin/providers/${p2.id}/active`, { active: false });
  assert.ok(!(await call('GET', '/api/providers?category=gyosei')).body.some((x) => x.id === p2.id), '下架后不再展示');
  assert.equal((await call('GET', '/api/provider/inquiries', null, p2.token)).status, 401, '下架后令牌失效');
});
