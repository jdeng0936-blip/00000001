// 网页只调接口、不内嵌规则：网页用到的接口（路线的 view、提醒的日期文字、判断的链接、永驻体检的日期、带情况的选方案、
// 同城、环节对照、事件种类、全部节点）返回网页要的东西；网页文件里没有规则逻辑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/server');

const V = '2026-11-27';
async function start(opts) {
  const app = createApp(Object.assign({ now: '2026-11-28T03:00:00Z' }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text && /json/.test(r.headers.get('content-type') || '') ? JSON.parse(text) : text };
  };
  return { app, call, base, stop: () => { app.server.close(); app.store.close(); } };
}

test('网页用的接口：全部节点、环节对照、事件种类、带汇率的选方案', async () => {
  const s = await start();
  try {
    const nodes = (await s.call('GET', '/api/nodes?full=1')).body;
    assert.equal(nodes.length, require('../data/nodes.json').length);
    const n32 = nodes.find((n) => n.id === '3-2');
    assert.equal(n32.pending, 1, '上线规则照样处理过'); assert.ok(Array.isArray(n32.steps) && typeof n32.cost === 'string' && n32.checked);
    const n11 = nodes.find((n) => n.id === '1-1');
    assert.deepEqual(Object.keys(n11.rows[0]), ['key', 'value', 'verified']); assert.ok(n11.links.length >= 1);
    assert.deepEqual((await s.call('GET', '/api/nodes/1-1')).body, n11, '和单个节点的接口一样');
    assert.equal((await s.call('GET', '/api/nodes')).body[0].summary !== undefined, true, '不带 full 时还是简表');
    const links = (await s.call('GET', '/api/links')).body;
    assert.ok(links.length > 20);
    assert.deepEqual(links.find((l) => l.nodeId === 'co' && l.category === 'shiho'), { nodeId: 'co', title: '开公司', category: 'shiho', categoryName: '司法书士', what: '公司设立登记', bring: '公司名、目的、资本金、出资人和董事的资料' });
    assert.equal(links.find((l) => l.nodeId === '1-1').title, '住民登记');
    assert.deepEqual((await s.call('GET', '/api/event-types')).body.map((t) => t.type), ['job_change', 'move', 'divorce', 'birth']);
    const o = (await s.call('GET', '/api/options/phone?usage=3')).body;
    assert.equal(o.rate.value, 4.2142); assert.equal(o.rate.on, '2026年11月24日');
    assert.ok(o.options.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.checkedOn)), '每套方案带核对日期');
  } finally { s.stop(); }
});

test('网页用的接口：路线的 view、提醒的日期文字、判断的链接、永驻体检的日期、带情况的选方案、同城、记事件的期限数', async () => {
  const s = await start();
  try {
    const u = (await s.call('POST', '/api/users', { accept: V })).body;
    const G = async (p) => (await s.call('GET', `/api/users/${u.id}${p}`, null, u.token)).body;
    await s.call('PUT', `/api/users/${u.id}/state`, { profile: { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-11-20', ins: true, pr: true, arrive: '2019-04-01', work: '2021-04-01', lic: false }, done: { '1-1': true } }, u.token);
    const plan = await G('/plan');
    assert.ok(plan.tasks && plan.profile, 'get_plan 那几项还在');
    const v = plan.view;
    assert.equal(v.today, '2026-11-28'); assert.equal(v.next, plan.next.id);
    assert.equal(v.dayInJapan, 11, '11月18日入境，11月28日是第11天'); assert.equal(v.legalDone, 1);
    assert.deepEqual(v.stages, ['来日前', '落地', '生活基建', '驾照', '在留维持', '永驻']); assert.equal(v.clear.length, 6);
    const n41 = v.nodes.find((n) => n.id === '4-1');
    assert.deepEqual([n41.due, n41.dueFmt, n41.dueText, n41.dueDays, n41.xp, n41.legal], ['2027-11-20', '2027年11月20日', '还有357天（2027年11月20日）', 357, 30, true]);
    assert.equal(v.nodes.find((n) => n.id === '1-1').state, 'done');
    // 完成任务的接口也返回 view
    assert.ok((await s.call('PUT', `/api/users/${u.id}/tasks/2-1/done`, { done: true }, u.token)).body.tasks);
    const rem = await G('/reminders');
    for (const r of rem) { assert.match(r.dateText, /^\d{4}年\d{1,2}月\d{1,2}日$/); assert.equal(typeof r.days, 'number'); }
    const upd = rem.find((r) => /在留更新：开始准备材料/.test(r.text));
    assert.deepEqual([upd.date, upd.dateText, upd.days], ['2027-07-20', '2027年7月20日', 234]);
    const adv = await G('/advice');
    assert.ok(adv.every((a) => a.title && a.text && /^#/.test(a.href) && a.action));
    const pr = await G('/pr-check');
    assert.equal(pr.whenDate, '2029-04-01'); assert.equal(pr.whenText, '2029年4月1日'); assert.equal(pr.reached, false);
    // 驾照那一题看这个人的情况：没有中国驾照，外免切替排后面并说明原因
    const drive = await G('/options/drive?time=yes');
    assert.equal(drive.options[0].name, '合宿驾校'); assert.match(drive.options.find((o) => o.name === '外免切替').off, /没有符合条件的中国驾照/);
    assert.equal((await s.call('GET', '/api/options/drive?time=yes')).body.options[0].name, '外免切替', '不带账号的接口按示例的情况');
    assert.equal((await s.call('GET', `/api/users/${u.id}/options/nope`, null, u.token)).status, 404);
    const city = await G('/city');
    assert.ok(city.jobs.length && city.house.length && city.used.length && city.life.length);
    assert.ok(city.jobs.some((j) => j.fit === 'ok') && city.jobs.some((j) => j.fit === 'bad'), '技人国：专业类的能做、现场类的一般不行');
    assert.deepEqual(Object.keys(city.house[0]), ['title', 'sub', 'place']);
    // 记事件：返回按现在的身份有几条期限
    assert.equal((await s.call('POST', `/api/users/${u.id}/events`, { type: 'job_change', date: '2026-11-25' }, u.token)).body.deadlines, 1);
    assert.equal((await s.call('POST', `/api/users/${u.id}/events`, { type: 'divorce', date: '2026-11-25' }, u.token)).body.deadlines, 0, '技人国离婚没有登记到期限');
    // 别人的令牌读不到
    const other = (await s.call('POST', '/api/users', { accept: V })).body;
    for (const p of ['/plan', '/city', '/options/phone']) assert.equal((await s.call('GET', `/api/users/${u.id}${p}`, null, other.token)).status, 401, p);
  } finally { s.stop(); }
});

test('网页文件里没有规则逻辑和节点数据：只调接口；合并用的 /merge.js 能取到', async () => {
  const html = require('./web-source').pageSource('index.html'); // HTML 和它引用的 /index.js 一起看
  for (const re of [/function (compute|progress|nextQuest|reminders|advice|prCheck|hspPoints|launchView|evDue|jobFit|cny|addMonths|yearsBetween)\(/, /var (NODES|EXTRA|CARRIERS|RENT|EVRULES|STATUS_NAME|SYS|DEF|JOBS|CITY|LINKS|CATS)=\[\s*[[{\x22]|var (EVRULES|STATUS_NAME|DEF|CITY|RATE|EXTRA)=[{\x22\d]/, /住民登记：定下住所后14天内到区役所办理/, /乐天移动/]) assert.doesNotMatch(html, re);
  for (const p of ['/plan', '/reminders', '/advice', '/pr-check', '/options/', '/nodes?full=1', '/links', '/event-types', '/city', '/chat']) assert.ok(html.includes('"' + p) || html.includes(p + '"'), '应当调用 ' + p);
  assert.match(html, /<script src="\/merge\.js"><\/script>/);
  assert.doesNotMatch(html, /history:/, '助手只发新的一句，不带历史');
  const s = await start();
  try {
    const r = await fetch(s.base + '/merge.js');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(await r.text(), /ZMerge/);
  } finally { s.stop(); }
});
