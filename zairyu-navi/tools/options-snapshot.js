// get_options 输出的快照（选方案的数据搬进 data/options.json 时用来保证内容不变）。
// 用法：node tools/options-snapshot.js --write   按现在的引擎重写 test/fixtures/options-snapshot.json
// test/options-data.test.js 用同一套条件组合重算，逐条和快照比较（比较前去掉新加的 checkedOn）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const createEngine = require('../src/engine');
const FILE = path.join(__dirname, '..', 'test', 'fixtures', 'options-snapshot.json');

// 固定种子的伪随机数：积分规划的条件组合太多，抽 400 组，每次抽到的都一样
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function cases() {
  const out = [], YN = ['yes', 'no'];
  const add = (topic, params, profile) => out.push({ topic, params, profile: profile || null });
  for (const t of ['route', 'degree', 'points', 'phone', 'drive', 'company', 'budget']) add(t, {});
  for (const deg of YN) for (const offer of YN) for (const spouse of YN) for (const jsp of YN) add('route', { deg, offer, spouse, jsp });
  for (const edu of ['hs', 'jc', 'ba']) for (const goal of ['work', 'points']) add('degree', { edu, goal });
  for (const usage of ['3', '10', '30', 'max']) for (const card of YN) for (const shop of YN) { add('phone', { usage, card, shop }); for (const bLife of ['6', '9', '12']) add('budget', { bLife, usage, card, shop }); }
  for (const lic of [true, false]) for (const time of YN) add('drive', { time }, { lic });
  for (const visa of YN) add('company', { visa });
  const r = rng(20261128), pick = (a) => a[Math.floor(r() * a.length)];
  for (let i = 0; i < 400; i++) add('points', { pEdu: pick(['0', '10', '20', '25', '30']), pAge: pick(['22', '29', '30', '34', '35', '39', '40', '45']), pInc: pick(['0', '250', '300', '400', '450', '500', '600', '700', '800', '900', '1000', '1200']), pExp: pick(['0', '3', '5', '7', '10']), pJp: pick(['none', 'n2', 'n1']), pJd: pick(YN), pTop: pick(YN), pLang: pick(['zh', 'en', 'ja', 'both']), pCert: pick(['0', '1', '2']) });
  return out;
}
// 去掉 checkedOn（数据文件新加的字段，不算内容变化）
function strip(o) { return JSON.parse(JSON.stringify(o, (k, v) => (k === 'checkedOn' ? undefined : v))); }
function run(c) { return strip(createEngine({ profile: c.profile || undefined, now: '2026-11-28T03:00:00Z' }).options(c.topic, c.params)); }
const hashOf = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
// 判断里有电话卡的最便宜方案，也一并锁住
function adviceCases() { return [{ plan: {} }, { plan: { card: 'no' } }, { plan: { usage: 'max', shop: 'yes' } }, { plan: { usage: '3', card: 'no' } }]; }
function runAdvice(c) { return createEngine({ profile: { status: 'work', addr: '2026-11-20', exp: '2027-11-20', ins: true }, plan: c.plan, now: '2026-11-28T03:00:00Z' }).advice(); }
function build() {
  const cs = cases();
  return { note: '由 tools/options-snapshot.js 生成；改了选方案的内容（不是搬家）时重新生成并在提交说明里写明', full: Object.fromEntries(cs.slice(0, 7).map((c) => [c.topic, run(c)])), hashes: cs.map((c) => hashOf(run(c))), advice: adviceCases().map(runAdvice) };
}
module.exports = { cases, run, hashOf, adviceCases, runAdvice, FILE, build };
if (require.main === module && process.argv.includes('--write')) { fs.writeFileSync(FILE, JSON.stringify(build(), null, 1) + '\n'); console.log('已写入 ' + FILE); }
