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

// ---------- 2026-11-27 审查的回归测试（docs/review-2026-11-27.md，engine-logic 和法条核对两节） ----------
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ENGINE = path.join(__dirname, '..', 'src', 'engine.js');
const at = (now, profile, events) => createEngine({ profile: Object.assign({}, EMPTY_PROFILE, profile), events, now });
const evDates = (e) => e.reminders().filter((r) => r.tag === '事件').map((r) => r.date + ' ' + r.txt);
const state = (r, name) => (r.rows.find((x) => x[0] === name) || [])[2];

test('时区：服务器在 UTC 或洛杉矶时，“今天”和期限仍按日本时间的日历日算', () => {
  // 2026-12-03T15:30Z 是日本时间12月4日0点30分，正好是住民登记的期限日
  const script = `const E=require(${JSON.stringify(ENGINE)});
    const e=E({profile:{status:'work',entry:'2026-08-31',addr:'2026-11-20',exp:'2027-03-31',ins:true,trips:[]},now:'2026-12-03T15:30:00Z',events:[{type:'birth',date:'2026-12-01'}]});
    const late=E({profile:{status:'work',addr:'2026-11-20',ins:true,trips:[]},now:'2026-12-04T14:59:00Z'});
    console.log(JSON.stringify({advice:e.advice()[0][1],today:e.fmt(e.today()),late:late.advice()[0][1],rem:e.reminders().map(r=>[r.date,e.fmt(r.d),JSON.parse(JSON.stringify(r.d)).slice(0,10)])}))`;
  const outs = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati'].map((TZ) => JSON.parse(execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ }), encoding: 'utf8' })));
  for (const o of outs) {
    assert.match(o.advice, /2026年12月4日（今天）/);
    assert.equal(o.today, '2026年12月4日');
    assert.match(o.late, /2026年12月4日（今天）/, '日本时间12月4日23点59分仍是期限当天');
    assert.deepEqual(o, outs[0], '不同时区下结果应当完全一样');
    for (const r of o.rem) { assert.equal(r[2], r[0], '序列化后的日期部分要和日历日一致'); const m = /^(\d+)-(\d+)-(\d+)$/.exec(r[0]); assert.equal(r[1], +m[1] + '年' + +m[2] + '月' + +m[3] + '日'); }
  }
  assert.ok(outs[0].rem.some((r) => r[0] === '2026-12-04'));
});

test('月份加减：目标月没有这一天时取月末，不滚到下个月', () => {
  const dates = (p) => { const m = {}; at('2026-11-27T03:00:00Z', Object.assign({ status: 'work', ins: true }, p)).reminders().forEach((r) => { m[r.txt] = r.date; }); return m; };
  let m = dates({ entry: '2026-08-31', exp: '2027-03-31' });
  assert.equal(m['在留更新：开始准备材料'], '2026-11-30');
  assert.equal(m['在留更新：确认可以开始申请的时期'], '2026-12-31');
  assert.equal(m['在留更新：尽快递交'], '2027-02-28');
  assert.equal(m['入境满6个月：去银行办理账户的居住者变更'], '2027-02-28');
  m = dates({ entry: '2026-08-30', exp: '2027-05-31' });
  assert.equal(m['在留更新：确认可以开始申请的时期'], '2027-02-28');
  assert.equal(m['在留更新：尽快递交'], '2027-04-30');
  assert.equal(m['入境满6个月：去银行办理账户的居住者变更'], '2027-02-28');
  assert.equal(dates({ exp: '2028-03-31' })['在留更新：尽快递交'], '2028-02-29', '闰年取2月29日');
  assert.equal(dates({ entry: '2026-10-15', exp: '2028-01-15' })['入境满6个月：去银行办理账户的居住者变更'], '2027-04-15', '普通日期不受影响');
  // 2月29日来日的人，1年的周年日是2月28日
  assert.equal(at('2026-11-27', { status: 'spouse', pr: true, arrive: '2024-02-29', married: '2020-01-01', jp: 'n2' }).prCheck().whenDate, '2025-02-28');
});

test('永驻体检：年数在周年当天就算达标，和 when、建议里的说法一致', () => {
  const p = { status: 'work', pr: true, arrive: '2016-11-27', work: '2021-11-27', jp: 'n2' };
  const on = at('2026-11-27T03:00:00Z', p), r = on.prCheck();
  assert.equal(state(r, '在留年数'), 'ok'); assert.equal(state(r, '就労或居住资格年数'), 'ok');
  assert.match(r.rows[0][1], /现10\.0年/); assert.equal(r.rows[0][3], 1);
  assert.equal(r.whenDate, '2026-11-27');
  assert.match(on.advice().find((x) => x[0] === '永驻最早什么时候')[1], /年数条件已满/);
  const before = at('2026-11-26T03:00:00Z', p), rb = before.prCheck();
  assert.equal(state(rb, '在留年数'), 'bad'); assert.equal(state(rb, '就労或居住资格年数'), 'bad');
  assert.match(rb.rows[0][1], /现9\.9年/, '差一天时不能显示成10.0年');
  assert.equal(rb.whenDate, '2026-11-27');
  assert.match(before.advice().find((x) => x[0] === '永驻最早什么时候')[1], /2026年11月27日.*还有 1 天/);
  const sp = at('2026-11-27T03:00:00Z', { status: 'spouse', pr: true, arrive: '2025-11-27', married: '2023-11-27', jp: 'n2' }).prCheck();
  assert.equal(state(sp, '在留年数'), 'ok'); assert.equal(state(sp, '婚姻持续年数'), 'ok'); assert.equal(sp.whenDate, '2026-11-27');
});

test('永驻体检：身份是高度专门职、积分没填时按70分（3年）算，不按10年和就劳5年', () => {
  const e = at('2026-11-27T03:00:00Z', { status: 'hsp', pr: true, arrive: '2023-01-01', work: '2023-01-01', hsp: '0', jp: 'n2' }), r = e.prCheck();
  assert.match(r.rows[0][1], /需连续3年/); assert.equal(r.rows[0][2], 'ok');
  assert.ok(!r.rows.some((x) => x[0] === '就労或居住资格年数'));
  assert.equal(r.whenDate, '2026-01-01'); assert.equal(r.needY, 3);
  assert.match(e.advice().find((x) => x[0] === '永驻最早什么时候')[1], /在留 3 年/);
  for (const hsp of ['', undefined]) assert.equal(at('2026-11-27', { status: 'hsp', pr: true, arrive: '2025-01-01', hsp, jp: 'n2' }).prCheck().whenDate, '2028-01-01');
  assert.equal(at('2026-11-27', { status: 'hsp', pr: true, arrive: '2025-01-01', hsp: '80', jp: 'n2' }).prCheck().whenDate, '2026-01-01');
  assert.equal(at('2026-11-27', { status: 'work', pr: true, arrive: '2025-01-01', work: '2025-01-01', hsp: '0', jp: 'n2' }).prCheck().needY, 10, '其他身份不受影响');
});

test('永驻体检：缺日期、特定技能、长期出国或有不达标的项目时，不给出已经过去的“最早时点”', () => {
  const cases = [
    [{ status: 'work', arrive: '2010-01-01', work: '' }, /就劳或居住资格的日期/],
    [{ status: 'spouse', arrive: '2020-01-01', married: '' }, /结婚日期/],
    [{ status: 'ssw', arrive: '2015-01-01', work: '2020-01-01' }, /特定技能1号/],
    [{ status: 'work', arrive: '2010-01-01', work: '2012-01-01', trips: [['2020-01-01', '2022-06-01']] }, /出国时间较长/],
    [{ status: 'work', arrive: '2010-01-01', work: '2012-01-01', pay: false }, /不达标/],
    [{ status: 'work', arrive: '2010-01-01', work: '2012-01-01', jp: 'low' }, /不达标/],
    [{ status: 'work', arrive: '', work: '2012-01-01' }, /来日日期/],
    [{ status: 'work', arrive: '2010-02-30', work: '2012-01-01' }, /来日日期/],
  ];
  for (const [p, why] of cases) {
    const e = at('2026-11-27T03:00:00Z', Object.assign({ pr: true, jp: 'n2' }, p)), r = e.prCheck();
    assert.equal(r.when, null, JSON.stringify(p)); assert.equal(r.whenDate, ''); assert.match(r.why, why);
    const a = e.advice().find((x) => x[0] === '永驻最早什么时候');
    assert.ok(!/年数条件已满（|在留年数已满/.test(a[1]), a[1]);
  }
  // 条件都达标时照常给出日期；年数还没满时给出将来的日期
  const ok = at('2026-11-27T03:00:00Z', { status: 'work', pr: true, jp: 'n2', arrive: '2010-01-01', work: '2012-01-01' }).prCheck();
  assert.equal(ok.whenDate, '2020-01-01'); assert.equal(ok.why, '');
  assert.ok(ok.when instanceof Date);
  const fut = at('2026-11-27T03:00:00Z', { status: 'work', pr: true, jp: 'n2', arrive: '2019-04-01', work: '2023-04-01' }).prCheck();
  assert.equal(fut.whenDate, '2029-04-01');
  // 只要 when 有值且已过，就不能有不达标的项目
  for (const [p] of cases) { const r = at('2026-11-27', Object.assign({ pr: true, jp: 'n2' }, p)).prCheck(); assert.ok(!(r.when && r.rows.some((x) => x[2] === 'bad'))); }
});

test('积分规划：已有指定大学或资格加分时，“提高年收”仍给出最近的一档', () => {
  for (const x of [{}, { pTop: 'yes' }, { pCert: '2' }, { pTop: 'yes', pCert: '2' }]) {
    const o = eng({}).options('points', Object.assign({ pAge: '34', pInc: '500', pEdu: '10', pExp: '5', pJp: 'n1', pJd: 'no', pTop: 'no', pCert: '0' }, x)).options.filter((c) => /年收提高/.test(c.name));
    assert.equal(o.length, 1, JSON.stringify(x)); assert.match(o[0].name, /600万日元/); assert.match(o[0].price, /^加 5 分/);
  }
});

test('积分：年龄没填或不是数字时不给年龄分', () => {
  const e = eng({});
  for (const pAge of ['', 'abc']) { const s = e.hspPoints({ pAge, pInc: '500' }); assert.equal(s.b['年龄'], 0); assert.equal(s.b['年收'], 0); assert.ok(Number.isFinite(s.total)); }
  assert.equal(e.hspPoints({ pAge: '29' }).b['年龄'], 15);
  assert.doesNotThrow(() => eng({}).options('points', { pAge: '' }));
});

test('日期校验：不存在的日期不通过，也不会产生 NaN 的期限', () => {
  const e = at('2026-11-27T03:00:00Z', { status: 'spouse', exp: '2027-02-30', entry: '2026-13-01', addr: '2026-00-10', trips: [['2026-02-30', '2026-03-05']] },
    [{ type: 'divorce', date: '2026-13-01' }, { type: 'move', date: '2026-02-30' }, { type: 'move', date: '2026-00-10' }, { type: 'birth', date: 'abc' }, { type: 'birth' }, { type: 'constructor', date: '2026-11-01' }, { type: 'move', date: '2026-11-01' }]);
  for (const s of ['2026-13-01', '2026-02-30', '2026-00-10', '2027-02-29', '2026-04-31', '2026-1-1', '', null, undefined, 20261101]) assert.equal(e.isDate(s), false, String(s));
  for (const s of ['2026-11-27', '2028-02-29', '2026-12-31']) assert.equal(e.isDate(s), true, s);
  const rem = e.reminders();
  assert.deepEqual(rem.filter((r) => r.tag === '事件').map((r) => r.date), ['2026-11-15']);
  for (const r of rem) { assert.ok(!Number.isNaN(r.d.getTime())); assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(!/NaN/.test(e.fmt(r.d))); }
  assert.ok(!/NaN/.test(JSON.stringify(e.plan()) + JSON.stringify(e.advice()) + JSON.stringify(e.prCheck())));
  assert.ok(!e.reminders().some((r) => r.tag === '在留'), '不存在的期满日不产生更新提醒');
});

test('事件：出生届把出生当天算第1天，期限是出生日加13天；在留资格取得是30天', () => {
  const r = evDates(at('2026-11-27T03:00:00Z', { status: 'work' }, [{ type: 'birth', date: '2026-11-27' }]));
  assert.equal(r.length, 2);
  assert.match(r[0], /^2026-12-10 孩子出生：14天内到区役所办出生届/);
  assert.match(r[1], /^2026-12-27 孩子出生：30天内向入管申请在留资格取得/);
});

test('事件：所属机关的届出只对有这项义务的身份提醒，配偶、家族滞在、永住者没有', () => {
  const ev = [{ type: 'job_change', date: '2026-11-01' }];
  for (const s of ['work', 'hsp', 'student', 'ssw', 'biz']) {
    const r = at('2026-11-27', { status: s }, ev).reminders().filter((x) => x.tag === '事件');
    assert.equal(r.length, 1, s); assert.equal(r[0].date, '2026-11-15'); assert.match(r[0].txt, /所属机关/); assert.match(r[0].src.law, /第19条の16/);
  }
  for (const s of ['spouse', 'family', 'pr', 'none', 'short']) assert.equal(evDates(at('2026-11-27', { status: s }, ev)).length, 0, s);
  const src = (s) => at('2026-11-27', { status: s }, ev).reminders().find((x) => x.tag === '事件').src;
  assert.match(src('work').url, /nyuukokukanri10_00015/); assert.match(src('ssw').law, /第2号/);
  assert.match(src('student').url, /nyuukokukanri10_00014/); assert.match(src('biz').law, /第1号/);
});

test('事件：配偶者的届出只对配偶身份和家族滞在提醒；家族滞在的说法限定为以配偶身份持有的人', () => {
  const ev = [{ type: 'divorce', date: '2026-11-01' }];
  const sp = at('2026-11-27', { status: 'spouse' }, ev).reminders().filter((x) => x.tag === '事件');
  assert.equal(sp.length, 1); assert.equal(sp[0].date, '2026-11-15'); assert.match(sp[0].txt, /^离婚或配偶去世：14天内/);
  const fa = at('2026-11-27', { status: 'family' }, ev).reminders().filter((x) => x.tag === '事件');
  assert.equal(fa.length, 1); assert.match(fa[0].txt, /^如果你是以配偶身份持有家族滞在/); assert.equal(fa[0].date, '2026-11-15');
  for (const r of [sp[0], fa[0]]) { assert.match(r.src.law, /第19条の16第3号/); assert.match(r.src.url, /nyuukokukanri10_00016/); }
  for (const s of ['work', 'hsp', 'student', 'ssw', 'biz', 'pr']) assert.equal(evDates(at('2026-11-27', { status: s }, ev)).length, 0, s);
});

test('路线：4-2 申报任务对家族滞在显示配偶者的届出，对永住者不适用', () => {
  const st = (s) => at('2026-11-27', { status: s, entry: '2026-11-18', addr: '2026-11-20' }).compute()['4-2'];
  for (const s of ['work', 'hsp', 'student', 'ssw', 'biz']) { assert.equal(st(s).state, 'todo', s); assert.match(st(s).note, /换工作/); }
  assert.equal(st('spouse').state, 'todo'); assert.match(st('spouse').note, /^离婚或配偶去世/);
  assert.equal(st('family').state, 'todo'); assert.match(st('family').note, /^如果你是以配偶身份持有家族滞在/); assert.match(st('family').note, /14天内/);
  assert.equal(st('pr').state, 'na');
  const src = eng({}).NODES.find((n) => n.id === '4-2').src.map((x) => x[1]).join(' ');
  for (const k of ['nyuukokukanri10_00014', 'nyuukokukanri10_00015', 'nyuukokukanri10_00016']) assert.ok(src.includes(k), k);
});

test('事件：每条期限规则都带法条和官方链接，并带到提醒里', () => {
  const e = eng({}), urls = [];
  for (const k of Object.keys(e.EVRULES)) {
    const r = e.EVRULES[k];
    assert.equal(typeof r[0], 'string'); assert.ok(r[1].length > 0, k);
    for (const x of r[1]) { assert.ok(Number.isInteger(x.n) && x.txt, k); assert.ok(x.src && x.src.law && x.src.title, k); assert.match(x.src.url, /^https:\/\/www\.moj\.go\.jp\//); urls.push(x.src.url); }
  }
  for (const k of ['nyuukokukanri10_00014', 'nyuukokukanri10_00015', 'nyuukokukanri10_00016', 'nyuukokukanri10_00023', '16-10', 'FAMILYREGISTER/5-1']) assert.ok(urls.some((u) => u.includes(k)), k);
  const rem = at('2026-11-27', { status: 'work', entry: '2026-01-10', addr: '2026-01-12', exp: '2027-11-20', ins: true }, [{ type: 'move', date: '2026-11-20' }, { type: 'birth', date: '2026-11-20' }]).reminders();
  const evs = rem.filter((r) => r.tag === '事件');
  assert.equal(evs.length, 3);
  assert.deepEqual(evs.map((r) => r.src.law), ['戸籍法第49条', '入管法第19条の9第1項', '入管法第22条の2・第22条の3']);
  for (const r of rem) { assert.ok('src' in r && 'date' in r && r.d instanceof Date); if (r.tag !== '事件') assert.equal(r.src, null); }
});

test('网页内嵌的日期工具函数和 src/engine.js 一致', () => {
  const blocks = (src) => { const out = {}; for (const l of src.split('\n')) { const m = /^function ([\w$]+)/.exec(l); if (m) out[m[1]] = l.trim(); } return out; };
  const web = blocks(fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8')), en = blocks(fs.readFileSync(ENGINE, 'utf8'));
  for (const n of ['jstDay', 'D', 'ymd', 'iso', 'addDays', 'addMonths', 'addYears', 'fmt', 'days', 'yearsBetween', 'y1', 'isDate']) { assert.ok(web[n] && en[n], n); assert.equal(web[n], en[n], n + ' 在网页和引擎里不一致'); }
  assert.equal(web.today, 'function today(){return jstDay(new Date())}');
});

test('事件：短期滞在记录孩子出生也有出生届和在留资格取得的期限；别的事件没有；人在中国的都没有', () => {
  const birth = [{ type: 'birth', date: '2026-11-01' }];
  const sh = at('2026-11-27', { status: 'short' }, birth).reminders();
  const ev = sh.filter((r) => r.tag === '事件');
  assert.deepEqual(ev.map((r) => r.date), ['2026-11-14', '2026-12-01']);
  assert.match(ev[0].src.law, /戸籍法第49条/); assert.match(ev[1].src.law, /第22条の2/);
  assert.ok(sh.some((r) => /第0关/.test(r.txt)), '原来的提示还在');
  assert.deepEqual(sh.map((r) => r.date), sh.map((r) => r.date).slice().sort(), '按日期排好');
  for (const type of ['job_change', 'move', 'divorce']) assert.equal(evDates(at('2026-11-27', { status: 'short' }, [{ type, date: '2026-11-01' }])).length, 0, type);
  assert.equal(evDates(at('2026-11-27', { status: 'none' }, birth)).length, 0);
  // eventDeadlines：单独问一件事按当前身份有没有期限（助手和页面用）
  assert.equal(at('2026-11-27', { status: 'short' }).eventDeadlines(birth[0]).length, 2);
  assert.equal(at('2026-11-27', { status: 'spouse' }).eventDeadlines({ type: 'job_change', date: '2026-11-01' }).length, 0);
  assert.equal(at('2026-11-27', { status: 'work' }).eventDeadlines({ type: 'constructor', date: '2026-11-01' }).length, 0);
});

test('事件：高度专门职换工作的期限带两个官方页面（契约机关和活动机关）', () => {
  const src = at('2026-11-27', { status: 'hsp' }, [{ type: 'job_change', date: '2026-11-01' }]).reminders().find((x) => x.tag === '事件').src;
  assert.match(src.url, /nyuukokukanri10_00015/);
  assert.equal(src.more.length, 1); assert.match(src.more[0].url, /^https:\/\/www\.moj\.go\.jp\/.*nyuukokukanri10_00014/); assert.match(src.more[0].title, /活动/);
});

test('路线：4-2 的标题、说明和步骤不只写换工作，配偶身份的人看到的也说得通', () => {
  const e = at('2026-11-27', { status: 'spouse', entry: '2026-11-18', addr: '2026-11-20' });
  const n = e.NODES.find((x) => x.id === '4-2'), t = e.plan().tasks.find((x) => x.id === '4-2');
  assert.doesNotMatch(n.t, /^换工作/); assert.match(n.t, /婚姻/); assert.equal(t.title, n.t);
  assert.match(n.sum, /离婚或配偶去世/); assert.match(n.sum, /换工作/);
  assert.ok(n.steps.some((s) => /配偶/.test(s) && /离婚或配偶去世后14天内/.test(s)), '步骤里要有配偶者届出');
  assert.ok(n.steps.some((s) => /就劳/.test(s) && /离开原公司或学校后14天内/.test(s)), '所属机关届出的步骤写明适用的身份');
  // 期限提醒里提到这个任务时用的是现在的标题
  const txt = at('2026-11-27', { status: 'work' }, [{ type: 'job_change', date: '2026-11-01' }]).reminders().find((x) => x.tag === '事件').txt;
  assert.ok(txt.includes('见任务“' + n.t + '”'));
});

test('提示词：工具没有返回期限时不让助手下“没有法定届出”的结论', () => {
  const sys = eng({}).SYS;
  assert.doesNotMatch(sys, /说明按他现在的在留资格没有对应的法定届出/);
  assert.match(sys, /本工具没有登记到对应的期限，这不代表没有其他手续/); assert.match(sys, /以入管厅或区役所的说明为准/);
});
