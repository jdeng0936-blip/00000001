const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

let base, app;
const tokens = {};
const V = '2026-11-27';
const adminCall = (method, path, body) => call(method, path, body, 'adm-secret');
// 登录番号和所属会按类别取一份格式正确的（直接入驻和入驻申请用同一套格式检查）
const LIC = { gyosei: { licenseNo: '第00000000号', licenseBody: '大阪府行政書士会' }, zeirishi: { licenseNo: '第123456号', licenseBody: '近畿税理士会' } };
const newProvider = async (over) => (await adminCall('POST', '/api/admin/providers', Object.assign({ name: '示例行政书士事务所', category: 'gyosei', area: '大阪', langs: '中文、日语', feeNote: '首次咨询30分钟5,500日元' }, LIC[(over && over.category) || 'gyosei'], over))).body;
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
  app = createApp({ now: '2026-11-26', adminToken: 'adm-secret', allowDirectProvider: true, signupLimit: { max: 1000, windowMs: 3600000 } });
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
  // 上线规则：资料整理中的节点不给要点、费用、用时，只给官方链接；待核实的罚则不带数字
  const p = (await call('GET', '/api/nodes/3-2')).body;
  assert.equal(p.pending, 1); assert.deepEqual(p.rows, []); assert.equal(p.cost, '资料整理中'); assert.ok(p.src.length > 0);
  const pen = (await call('GET', '/api/nodes/4-2')).body.rows.find((r) => r.key === '逾期的处罚');
  assert.equal(pen.verified, false); assert.doesNotMatch(pen.value, /[0-9]/);
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
  const r = await fetch(base + '/api/users/x/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.ok([400, 404].includes(r.status));
  // 没写 Content-Type: application/json 的请求体（别的网站能不经预检发出的写法）是 415
  assert.equal((await fetch(base + '/api/users/x/profile', { method: 'PATCH', body: '{bad' })).status, 415);
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
  const G = { name: '某事务所', category: 'gyosei', licenseNo: '第12345678号', licenseBody: '大阪府行政書士会' };
  assert.equal((await adminCall('POST', '/api/admin/providers', Object.assign({}, G, { feeModel: 'affiliate_disclosed' }))).status, 422);
  assert.equal((await adminCall('POST', '/api/admin/providers', { name: '某事务所', category: 'gyosei' })).status, 422);
  assert.equal((await adminCall('POST', '/api/admin/providers', Object.assign({}, G, { feeNote: '永驻包过' }))).status, 422);
  // 和入驻申请同一套检查：登录番号的格式、所属会，区域、语言、地址也不能有保证类用语
  assert.equal((await adminCall('POST', '/api/admin/providers', Object.assign({}, G, { licenseNo: '第1号' }))).status, 422, '行政书士的登录番号是 8 位');
  assert.equal((await adminCall('POST', '/api/admin/providers', Object.assign({}, G, { licenseBody: '' }))).status, 422, '士业要有所属会');
  for (const k of ['area', 'langs', 'address']) assert.equal((await adminCall('POST', '/api/admin/providers', Object.assign({}, G, { [k]: '保證合格' }))).status, 422, k);
  // 非士业不能指定 fixed_listing 来躲开“含推广”的标识
  assert.equal((await adminCall('POST', '/api/admin/providers', { name: '某学校', category: 'edu', feeModel: 'fixed_listing' })).status, 422);
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

test('日期：日历上不存在的日期一律拒绝（概况、出国记录、事件）', async () => {
  const u = (await call('POST', '/api/users')).body;
  for (const d of ['2025-02-31', '2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
    assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { entry: d })).status, 422, d);
    assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: d })).status, 422, '事件 ' + d);
  }
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { trips: [['2026-01-31', '2026-02-30']] })).status, 422);
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { entry: ['2026-01-10'] })).status, 422, '日期必须是字符串');
  assert.equal((await call('PUT', `/api/users/${u.id}/state`, { profile: { exp: '2027-06-31' }, done: {} })).status, 422);
  assert.equal((await call('PATCH', `/api/users/${u.id}/profile`, { entry: '2028-02-29' })).status, 200, '闰年的2月29日是真实的日期');
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2028-02-29' })).status, 201);
  assert.equal((await call('GET', `/api/users/${u.id}/events`)).body.length, 1);
});

test('事件类型：继承来的键和非字符串都拒绝，不会存进去也不会返回 500', async () => {
  const u = (await call('POST', '/api/users')).body;
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', ['move'], { a: 1 }, 5, null]) {
    assert.equal((await call('POST', `/api/users/${u.id}/events`, { type, date: '2026-01-01' })).status, 422, JSON.stringify(type));
  }
  const list = await call('GET', `/api/users/${u.id}/events`);
  assert.equal(list.status, 200); assert.equal(list.body.length, 0);
});

test('删除账号：留痕里不再有这个用户的 id、咨询 id 和服务商 id', async () => {
  const u = (await call('POST', '/api/users')).body, other = (await call('POST', '/api/users')).body;
  const p = await newProvider({ name: '删除测试行政书士事务所' });
  await call('PATCH', `/api/users/${u.id}/profile`, { status: 'work' });
  await call('PATCH', `/api/users/${other.id}/profile`, { status: 'student' });
  await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-12-01' });
  const sent = await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerId: p.id, summary: '想咨询在留更新的手续。' });
  const qid = sent.body.ids[0];
  assert.equal((await call('POST', `/api/provider/inquiries/${qid}/reply`, { text: '可以办理，请来面谈。' }, p.token)).status, 201);
  const before = app.store.auditRows();
  assert.ok(before.some((a) => a.userId === u.id), '删除前留痕里有这个用户');
  assert.equal((await call('DELETE', `/api/users/${u.id}`)).status, 204);
  const after = app.store.auditRows();
  assert.ok(!JSON.stringify(after).includes(u.id), '用户 id 不能留在留痕里');
  assert.ok(!JSON.stringify(after).includes(qid), '咨询 id 不能留在留痕里');
  assert.ok(!after.some((a) => a.action === 'inquiry.create' && a.detail && a.detail.includes(p.id)), '发给了哪家服务商不能留在留痕里');
  assert.equal(after.length, before.length + 1, '留痕的条数不变，只多一条删除记录');
  assert.equal(after[after.length - 1].action, 'user.delete');
  assert.ok(after.some((a) => a.userId === other.id && a.action === 'profile.update'), '别的用户的留痕不受影响');
  assert.equal((await call('GET', '/api/provider/inquiries', null, p.token)).body.length, 0, '服务商那边的咨询也删掉');
});

test('合规：事件备注和服务商回复里的敏感号码也拒绝', async () => {
  const u = (await call('POST', '/api/users')).body, p = await newProvider({ name: '过滤测试行政书士事务所' });
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-01-01', note: '123456789012' })).status, 422);
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-01-01', note: 'my number 1234 5678 9012 passport EA1234567' })).status, 422);
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-01-01', note: '搬到大阪市北区，电话 090-1234-5678' })).status, 201);
  const bad = await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerIds: [p.id], summary: '我的个人编号是１２３４５６７８９０１２ 以及 1234.5678.9012 护照号EA1234567' });
  assert.equal(bad.status, 422); assert.match(bad.body.error, /个人编号/);
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerIds: [p.id], summary: '护照号 E12345678, 账号 1234567' })).status, 422);
  assert.equal((await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerIds: [p.id], nodeId: 'constructor', summary: '想咨询在留更新的手续。' })).status, 422);
  const sent = await call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerIds: [p.id], summary: '  在留期间 2026-11-30 到期，2027-01-15 前想办完更新。电话 090-1234-5678，预算 120,000 日元。  ' });
  assert.equal(sent.status, 201, '日期、电话、金额不拦');
  assert.equal((await call('GET', `/api/users/${u.id}/inquiries`)).body[0].summary.startsWith('在留期间'), true, '摘要去掉首尾空白');
  const qid = sent.body.ids[0];
  const r = await call('POST', `/api/provider/inquiries/${qid}/reply`, { text: '请把报酬汇到银行账号 1234567，或告诉我护照号。' }, p.token);
  assert.equal(r.status, 422); assert.match(r.body.error, /回复里疑似含有/);
  assert.equal((await call('POST', `/api/provider/inquiries/${qid}/reply`, { text: '请把您的マイナンバー 1234-5678-9012 发给我确认。' }, p.token)).status, 422);
  assert.equal((await call('POST', `/api/provider/inquiries/${qid}/reply`, { text: '可以办理，报酬 120,000 日元起，来所前请致电 06-1234-5678。' }, p.token)).status, 201);
});

test('提醒接口：日期是 YYYY-MM-DD 的文字，事件期限带法条和官方页面；短期滞在记录孩子出生也有期限', async () => {
  const u = (await call('POST', '/api/users')).body;
  await call('PATCH', `/api/users/${u.id}/profile`, { status: 'hsp', entry: '2026-01-10', addr: '2026-01-12', exp: '2027-11-20', ins: true });
  await call('POST', `/api/users/${u.id}/events`, { type: 'job_change', date: '2026-11-20' });
  const all = (await call('GET', `/api/users/${u.id}/reminders`)).body;
  assert.ok(all.length > 3);
  for (const r of all) { assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, JSON.stringify(r)); assert.ok('src' in r); }
  const ev = all.find((r) => r.tag === '事件');
  assert.equal(ev.date, '2026-12-04');
  assert.match(ev.src.law, /入管法第19条の16/); assert.match(ev.src.url, /nyuukokukanri10_00015/); assert.match(ev.src.more[0].url, /nyuukokukanri10_00014/);
  assert.equal(all.find((r) => r.tag !== '事件').src, null);
  // 短期滞在
  const s = (await call('POST', '/api/users')).body;
  await call('PATCH', `/api/users/${s.id}/profile`, { status: 'short' });
  assert.equal((await call('POST', `/api/users/${s.id}/events`, { type: 'birth', date: '2026-11-01' })).status, 201);
  const sr = (await call('GET', `/api/users/${s.id}/reminders`)).body.filter((r) => r.tag === '事件');
  assert.deepEqual(sr.map((r) => r.date), ['2026-11-14', '2026-12-01']); assert.match(sr[0].src.law, /戸籍法第49条/);
});

test('敏感号码：发咨询、事件备注、服务商回复里，12位数字的各种分组都拒绝，几个年份照常通过', async () => {
  const u = (await call('POST', '/api/users')).body, p = await newProvider({ name: '过滤测试行政书士事务所' });
  await call('PATCH', `/api/users/${u.id}/profile`, { status: 'work', entry: '2026-01-10', addr: '2026-01-12' });
  const inq = (summary) => call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: 'gyosei', providerIds: [p.id], summary });
  for (const s of ['想咨询 123456 789012 的事', '想咨询 123456-789012 的事', '想咨询 123 456 789 012 的事', '想咨询 1234/5678/9012', '想咨询 1234,5678,9012']) assert.equal((await inq(s)).status, 422, s);
  assert.equal((await adminlessProviderInquiries(p)).length, 0, '被拒的内容服务商收不到');
  assert.equal((await inq('永驻申请，需要 2023 2024 2025 三年的纳税证明吗')).status, 201);
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-11-20', note: '2023 2024 2025 年都住这里' })).status, 201);
  assert.equal((await call('POST', `/api/users/${u.id}/events`, { type: 'move', date: '2026-11-20', note: '123456 789012' })).status, 422);
  const q = (await adminlessProviderInquiries(p))[0];
  assert.equal((await call('POST', `/api/provider/inquiries/${q.id}/reply`, { text: '请准备 2023 2024 2025 三个年度的课税证明书和纳税证明书' }, p.token)).status, 201);
});
async function adminlessProviderInquiries(p) { return (await call('GET', '/api/provider/inquiries', null, p.token)).body; }
