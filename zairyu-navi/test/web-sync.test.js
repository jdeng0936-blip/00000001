// 网页端目前内嵌了一份规则逻辑。在网页改成完全调用接口之前，这个测试保证两份逻辑一字不差。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function blocks(src) {
  const lines = src.split('\n'), out = {}; let name = null, buf = [];
  const flush = () => { if (name) out[name] = buf.join('\n').trim(); };
  for (const l of lines) {
    const m = /^(?:async )?(?:function|var) ([\w$]+)/.exec(l);
    if (m) { flush(); name = m[1]; buf = [l]; } else if (name) buf.push(l);
  }
  flush(); return out;
}

test('网页内嵌的规则逻辑和 src/engine.js 一致', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const web = blocks(/<script>([\s\S]*)<\/script>/.exec(html)[1]);
  const eng = blocks(fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8'));
  const names = ['compute', 'progress', 'nextQuest', 'reminders', 'advice', 'prCheck', 'hspPoints', 'pointsOptions', 'degreeOptions', 'routeOptions', 'budgetOptions', 'phoneOptions', 'driveOptions', 'companyOptions', 'CARRIERS', 'cny', 'RATE', 'LINKS', 'CATS', 'REGULATED', 'SYS', 'STATUS_NAME', 'jobFit', 'DEF', 'EVRULES', 'JOB_MAIL', 'JOB_MSRC', 'evDue', 'launchView',
    // 日期和文字的小函数：时区、月末的修正都在这里，页面那份不一样时算出的期限就不一样（today、save、NODES 两边本来就不同，不比）
    'jstDay', 'D', 'ymd', 'iso', 'addDays', 'addMonths', 'addYears', 'fmt', 'days', 'yearsBetween', 'y1', 'dueText', 'isDate', 'packText', 'profileText'];
  for (const n of names) {
    assert.ok(web[n] && eng[n], '两边都应当有 ' + n);
    assert.equal(web[n], eng[n], n + ' 在网页和引擎里不一致：改了一边要同步另一边');
  }
});

test('网页内嵌的节点数据和 data/nodes.json 一致', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const nodes = require('../data/nodes.json');
  for (const n of nodes) { assert.ok(html.includes('id:"' + n.id + '"'), n.id); assert.ok(html.includes(n.t), n.t); for (const r of n.rows) assert.ok(html.includes(r[1]), n.id + ' ' + r[0]);
    // 说明、费用和步骤也要一致（4-2 改标题和步骤时两边一起改）
    assert.ok(html.includes('sum:' + JSON.stringify(n.sum)), n.id + ' 的说明'); assert.ok(html.includes('cost:' + JSON.stringify(n.cost)), n.id + ' 的费用'); assert.ok(html.includes('steps:' + JSON.stringify(n.steps)), n.id + ' 的步骤');
    // 官方依据的链接也要一致（4-2 曾经在网页里少两条）
    for (const s of n.src) assert.ok(html.includes(JSON.stringify(s)), n.id + ' 的依据：' + s[0]); }
});

test('网页内嵌的节点数据块就是 tools/sync-nodes.js 的输出（改 data/nodes.json 后运行它）', () => {
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'sync-nodes.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('端到端检查有 npm 脚本：npm run e2e 自己起服务器再跑浏览器检查', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.e2e, 'node e2e/run.js');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'e2e', 'run.js')));
});
