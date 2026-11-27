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
  const names = ['compute', 'progress', 'nextQuest', 'reminders', 'advice', 'prCheck', 'hspPoints', 'pointsOptions', 'degreeOptions', 'routeOptions', 'budgetOptions', 'phoneOptions', 'driveOptions', 'companyOptions', 'CARRIERS', 'cny', 'RATE', 'LINKS', 'CATS', 'REGULATED', 'SYS', 'STATUS_NAME', 'jobFit', 'DEF', 'EVRULES'];
  for (const n of names) {
    assert.ok(web[n] && eng[n], '两边都应当有 ' + n);
    assert.equal(web[n], eng[n], n + ' 在网页和引擎里不一致：改了一边要同步另一边');
  }
});

test('网页内嵌的节点数据和 data/nodes.json 一致', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const nodes = require('../data/nodes.json');
  for (const n of nodes) { assert.ok(html.includes('id:"' + n.id + '"'), n.id); assert.ok(html.includes(n.t), n.t); for (const r of n.rows) assert.ok(html.includes(r[1]), n.id + ' ' + r[0]); }
});
