const test = require('node:test');
const assert = require('node:assert/strict');
const createEngine = require('../src/engine');
const { EMPTY_PROFILE } = require('../src/store');

const NOW = '2026-11-26';
const eng = (profile, done, plan) => createEngine({ profile: Object.assign({}, EMPTY_PROFILE, profile), done, plan, now: NOW });

test('节点数据：26个节点，每条数据都有核实标记', () => {
  const e = eng({});
  assert.equal(e.NODES.length, 26);
  for (const n of e.NODES) {
    assert.ok(n.t && n.sum && Array.isArray(n.rows) && n.rows.length, n.id);
    for (const r of n.rows) assert.ok(r.length === 3 && (r[2] === 0 || r[2] === 1), n.id + ' ' + r[0]);
    assert.ok(n.cost && n.time && Array.isArray(n.steps) && n.steps.length, n.id + ' 缺少费用、用时或步骤');
  }
});

test('路线：刚入境的就职者，下一步是住民登记，期限是定下住所后14天', () => {
  const e = eng({ status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-11-20', ins: true });
  const p = e.plan();
  assert.equal(p.next.id, '1-1');
  const t = p.tasks.find((x) => x.id === '1-1');
  assert.equal(t.state, 'todo');
  assert.equal(t.due, '2026年12月4日');
});

test('路线：没办住民登记时，电话卡是锁定的；办完后解锁', () => {
  const base = { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-11-20', ins: true };
  assert.equal(eng(base).compute()['2-2'].state, 'locked');
  assert.equal(eng(base, { '1-1': true }).compute()['2-2'].state, 'todo');
  assert.equal(eng(base, { '1-1': true }).compute()['1-1'].state, 'done');
});

test('路线：公司有社保的人不用办国保和国民年金', () => {
  const R = eng({ status: 'work', entry: '2026-11-18', addr: '2026-11-20', ins: true }).compute();
  assert.notEqual(R['1-3'].state, 'todo');
  assert.notEqual(R['1-4'].state, 'todo');
});

test('路线：人还在中国、资料全空时不报错，下一步在来日前阶段', () => {
  const p = eng({}).plan();
  assert.ok(p.next && p.next.id.startsWith('0-'), JSON.stringify(p.next));
  assert.doesNotThrow(() => { const e = eng({}); e.reminders(); e.advice(); e.prCheck(); });
});

test('积分：34岁、本科、年收500万、5年经验、无日语，共45分', () => {
  const e = eng({});
  const s = e.hspPoints({ pEdu: '10', pAge: '34', pInc: '500', pExp: '5', pJp: 'none', pJd: 'no', pTop: 'no', pCert: '0' });
  assert.equal(s.total, 45);
});

test('积分：资格1项5分、2项10分；N1是15分', () => {
  const e = eng({});
  const base = { pEdu: '10', pAge: '34', pInc: '500', pExp: '5', pJp: 'none', pJd: 'no', pTop: 'no', pCert: '0' };
  assert.equal(e.hspPoints(Object.assign({}, base, { pCert: '1' })).total, 50);
  assert.equal(e.hspPoints(Object.assign({}, base, { pCert: '2' })).total, 55);
  assert.equal(e.hspPoints(Object.assign({}, base, { pJp: 'n1' })).total, 60);
});

test('积分规划：只会中文的人，最省的达标组合是 N1 加 2项考试', () => {
  const o = eng({}).options('points', { pEdu: '10', pAge: '34', pInc: '500', pExp: '5', pJp: 'none', pJd: 'no', pTop: 'no', pCert: '0', pLang: 'zh' }).options;
  const combo = o.find((x) => /两样一起做/.test(x.name));
  assert.ok(combo, '应当给出组合方案');
  assert.match(combo.name, /N1/); assert.match(combo.name, /2项/); assert.match(combo.price, /70/);
});

test('选方案：七个主题都能出结果，日元金额后带人民币折算', () => {
  const e = eng({});
  for (const t of e.PLT) {
    const r = e.options(t[0]);
    assert.ok(r.options.length >= 2, t[0]); assert.ok(r.note.length > 10, t[0] + ' 缺说明');
  }
  assert.match(e.options('phone').options[0].price, /日元（约[\d,.]+元）/);
  assert.throws(() => e.options('nope'));
});

test('选方案：配偶是日本人或永住者时，配偶路线排第一', () => {
  const e = eng({});
  assert.equal(e.options('route', { jsp: 'yes' }).options[0].name, '日本人或永住者的配偶');
  assert.notEqual(e.options('route', { jsp: 'no' }).options[0].name, '日本人或永住者的配偶');
});

test('选方案：没有信用卡时，排第一的电话卡不能是只收信用卡的', () => {
  const o = eng({}).options('phone', { card: 'no', usage: '10' }).options;
  assert.ok(!o[0].off, '第一名不应带“不适用”说明：' + o[0].off);
});

test('预算：单身、每月生活费9万日元时，第一年约236.9万日元', () => {
  const o = eng({}).options('budget', { bLife: '9', usage: '10', card: 'no', shop: 'no' }).options;
  assert.match(o[0].price, /236\.9万日元/);
  assert.equal(o.length, 3);
});

test('人民币折算：加号相连的分项不逐个折算，区间两端都折算', () => {
  const e = eng({});
  assert.match(e.cny('约108.6万日元'), /万日元（约[\d.]+万元）/);
  const s = e.cny('译文6,600 + 申请2,500 + 发证2,350日元');
  assert.equal((s.match(/约/g) || []).length <= 1, true);
});

test('合规：士业类别都标为受监管，学校和升学服务不是', () => {
  const e = eng({});
  for (const k of ['gyosei', 'zeirishi', 'sharoshi', 'shiho']) assert.ok(e.REGULATED[k], k);
  assert.ok(!e.REGULATED.edu);
});

test('合规：助手提示词里有不作保证、不记个人编号、只讲正规学历的规则', () => {
  const s = eng({}).SYS;
  for (const w of ['不说“一定能批”', '个人编号', '买学历', '不制作', '资料库暂无']) assert.ok(s.includes(w), w);
});

test('合规：面向用户的数据里没有保证类用语', () => {
  const e = eng({});
  const texts = [];
  for (const t of e.PLT) for (const o of e.options(t[0]).options) texts.push(o.name, o.price, o.sub || '', ...(o.pts || []));
  for (const n of e.NODES) texts.push(n.sum, ...n.rows.map((r) => r[1]), ...n.steps);
  for (const s of texts) assert.ok(!/包过|必过|一定能批|保证获批|保证加分|100%通过/.test(s), s);
});

test('配偶身份：永驻体检按婚姻3年加在留1年算，并提示2027年4月的变更', () => {
  const r = eng({ status: 'spouse', pr: true, arrive: '2025-06-01', married: '2023-01-10', jp: 'n2' }).prCheck();
  const names = r.rows.map((x) => x[0]);
  assert.ok(names.includes('婚姻持续年数')); assert.ok(!names.includes('就労或居住资格年数'));
  const m = r.rows.find((x) => x[0] === '婚姻持续年数');
  assert.equal(m[2], 'ok'); assert.match(m[1], /2027年4月1日/); assert.match(m[1], /待核实/);
  assert.equal(r.rows.find((x) => x[0] === '在留年数')[2], 'ok');
  assert.equal(r.when.getFullYear(), 2026);
});

test('配偶身份：路线里的申报任务提示离婚或配偶去世时14天内申报；工作不受限制', () => {
  const e = eng({ status: 'spouse', entry: '2026-11-18', addr: '2026-11-20' });
  assert.match(e.compute()['4-2'].note, /14天内/);
  assert.equal(e.jobFit('全职', 'site')[0], 'ok');
});

test('特定技能：就劳5年那一项提示不算在内；找工作提示只能做所属行业', () => {
  const e = eng({ status: 'ssw', pr: true, arrive: '2019-01-01', work: '2019-01-01', jp: 'n2' });
  const row = e.prCheck().rows.find((x) => x[0] === '就労或居住资格年数');
  assert.equal(row[2], 'warn'); assert.match(row[1], /不算在内/);
  assert.equal(e.jobFit('全职', 'pro')[0], 'warn');
});
