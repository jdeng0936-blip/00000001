// 把 data/nodes.json 写回 web/index.html 里内嵌的 NODES 和 EXTRA 两段（网页改成完全调用接口之前用）。
// 用法：node tools/sync-nodes.js        写回网页
//       node tools/sync-nodes.js --check 只检查，不一致时退出码为 1
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const file = path.join(root, 'web', 'index.html');
const nodes = JSON.parse(fs.readFileSync(path.join(root, 'data', 'nodes.json'), 'utf8'));
const J = JSON.stringify;
const nodeBlock = 'var NODES=[\n' + nodes.map((n) =>
  '{id:' + J(n.id) + ',s:' + n.s + ',t:' + J(n.t) + ',sum:' + J(n.sum) + ',reg:' + J(n.reg) + ',\n rows:' + J(n.rows) + ',\n src:' + J(n.src) + '}').join(',\n') + '\n];';
const extraBlock = 'var EXTRA={\n' + nodes.map((n) =>
  J(n.id) + ':{cost:' + J(n.cost) + ',time:' + J(n.time) + ',steps:' + J(n.steps) + ',checked:' + J(n.checked) + '}').join(',\n') + '\n};';
const html = fs.readFileSync(file, 'utf8');
const out = html.replace(/^var NODES=\[\n[\s\S]*?\n\];$/m, () => nodeBlock).replace(/^var EXTRA=\{\n[\s\S]*?\n\};$/m, () => extraBlock);
if (process.argv.includes('--check')) { if (out !== html) { console.error('web/index.html 的节点数据和 data/nodes.json 不一致：运行 node tools/sync-nodes.js'); process.exit(1); } console.log('一致'); }
else { fs.writeFileSync(file, out); console.log(out === html ? '没有变化' : '已写回 web/index.html'); }
