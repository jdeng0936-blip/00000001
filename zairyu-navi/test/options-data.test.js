// 选方案的数据在 data/options.json：内容和搬家之前一模一样（快照）；每一项都有核对日期、下次复核日期和来源；
// 下次复核日期过了就失败，提醒要去重新核对（日期用 OPTIONS_REVIEW_ON=YYYY-MM-DD 指定，默认是日本时间的今天）。
const test = require('node:test');
const assert = require('node:assert/strict');
const snap = require('./fixtures/options-snapshot.json');
const S = require('../tools/options-snapshot');
const createEngine = require('../src/engine');
const DATA = require('../data/options.json');
const { isDate } = require('../src/validate');

test('get_options 的内容和搬进 data/options.json 之前一样（499 组条件逐条比较，checkedOn 除外）', () => {
  const cs = S.cases();
  assert.equal(cs.length, snap.hashes.length);
  for (const [i, c] of cs.slice(0, 7).entries()) assert.deepEqual(S.run(c), snap.full[c.topic], c.topic + ' 的默认结果');
  const bad = cs.map((c, i) => (S.hashOf(S.run(c)) === snap.hashes[i] ? null : c.topic + ' ' + JSON.stringify(c.params))).filter(Boolean);
  assert.deepEqual(bad, [], '这些条件下结果变了');
  assert.deepEqual(S.adviceCases().map(S.runAdvice), snap.advice, '“给你的判断”里电话卡那一条也不变');
});

test('每个主题的每张方案卡片都带核对日期 checkedOn，来自数据文件', () => {
  const ids = new Set();
  for (const c of S.cases()) {
    const r = createEngine({ profile: c.profile || undefined }).options(c.topic, c.params);
    for (const o of r.options) { assert.ok(isDate(o.checkedOn), c.topic + '：' + o.name + ' 没有核对日期'); ids.add(c.topic + ':' + o.checkedOn); }
  }
  // 改了数据文件里的核对日期，输出跟着变
  const e = createEngine({});
  e.OPTION_DATA.topics.drive.items.find((x) => x.id === 'gaimen').checkedOn = '2026-12-01';
  assert.equal(e.options('drive', { time: 'no' }).options.find((o) => o.name === '外免切替').checkedOn, '2026-12-01');
  assert.equal(createEngine({}).options('drive', {}).options.find((o) => o.name === '外免切替').checkedOn, DATA.topics.drive.items[0].checkedOn, '每个引擎各用一份副本，改了不串');
});

test('数据文件：每一项都有 id、核对日期、下次复核日期（不早于核对日期）和来源 [标题, https 地址]', () => {
  const all = [['rate', DATA.rate]];
  for (const [t, topic] of Object.entries(DATA.topics)) {
    assert.ok(topic.note, t + ' 的说明');
    const seen = new Set();
    for (const it of topic.items) { assert.ok(it.id && !seen.has(it.id), t + ' 的 id 重复或缺少：' + it.id); seen.add(it.id); all.push([t + '.' + it.id, it]); }
  }
  for (const [k, it] of all) {
    assert.ok(isDate(it.checkedOn), k + ' 的 checkedOn'); assert.ok(isDate(it.nextReviewOn), k + ' 的 nextReviewOn');
    assert.ok(it.nextReviewOn >= it.checkedOn, k + '：下次复核日期早于核对日期');
    assert.ok(Array.isArray(it.src) && it.src.length === 2 && it.src[0] && /^https:\/\//.test(it.src[1]), k + ' 的来源');
  }
  assert.deepEqual(Object.keys(DATA.topics), createEngine({}).PLT.map((x) => x[0]), '七个主题都在');
});

// 默认按今天：数据过了复核日期，npm test 就不过，要有人去重新核对（核对后改 checkedOn 和 nextReviewOn）。
// 想提前看哪些快到期了：OPTIONS_REVIEW_ON=2027-01-01 npm test
function reviewDay() {
  const v = process.env.OPTIONS_REVIEW_ON;
  if (v != null && v !== '') { assert.ok(isDate(v), 'OPTIONS_REVIEW_ON 须为 YYYY-MM-DD'); return v; }
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function overdue(data, day) {
  const out = [];
  if (data.rate.nextReviewOn < day) out.push('rate（' + data.rate.nextReviewOn + '）');
  for (const [t, topic] of Object.entries(data.topics)) for (const it of topic.items) if (it.nextReviewOn < day) out.push(t + '.' + it.id + '（' + it.nextReviewOn + '）');
  return out;
}

test('选方案的数据没有过下次复核日期（OPTIONS_REVIEW_ON 指定的日期，默认今天）', () => {
  const day = reviewDay();
  assert.deepEqual(overdue(DATA, day), [], '这些数据到了复核日期，要重新核对来源，改 checkedOn 和 nextReviewOn');
});

test('复核日期的检查本身：日期一过就报出来', () => {
  const copy = JSON.parse(JSON.stringify(DATA));
  copy.topics.phone.items[0].nextReviewOn = '2026-11-01';
  assert.deepEqual(overdue(copy, '2026-11-02'), ['phone.rakuten（2026-11-01）']);
  assert.deepEqual(overdue(copy, '2026-11-01'), [], '当天还不算过期');
  assert.ok(overdue(DATA, '2099-01-01').length > 40, '远的日期全部报出来');
});
