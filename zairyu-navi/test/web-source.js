// 测试用：读网页的全部源码。网页的脚本按 CSP 的要求放在单独的文件里（<script src="/index.js">），
// 检查“页面里写了什么、调了哪些接口”时要把 HTML 和它引用的本站脚本连起来看。
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
function pageSource(name) {
  const html = fs.readFileSync(path.join(WEB, name), 'utf8');
  const scripts = [...html.matchAll(/<script src="\/([\w.-]+\.js)"><\/script>/g)].map((m) => fs.readFileSync(path.join(WEB, m[1]), 'utf8'));
  return [html].concat(scripts).join('\n');
}
module.exports = { pageSource, WEB };
