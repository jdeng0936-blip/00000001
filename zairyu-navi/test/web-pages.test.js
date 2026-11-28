// 服务商入驻的三个新页面：存在、不用 innerHTML、条款带版本号和【 】、除了“禁止事项”那一条没有保证类用语。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hasClaims } = require('../src/validate');
const { PROVIDER_TERMS_VERSION } = require('../src/server');

// HTML 连同它引用的本站脚本（CSP 要求脚本放在单独的文件里）
const web = (f) => require('./web-source').pageSource(f);
// 样式表里的 width:100% 不是文字，检查用语之前去掉
const noStyle = (h) => h.replace(/<style>[\s\S]*?<\/style>/g, '');
const PAGES = ['provider-apply.html', 'admin.html', 'provider-terms.html'];

test('新的三个页面都存在；所有页面里都没有 innerHTML', () => {
  for (const f of PAGES) assert.ok(fs.existsSync(path.join(__dirname, '..', 'web', f)), f);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'web')).filter((x) => x.endsWith('.html'))) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(web(f)), f + ' 里不应当拼 HTML');
});

test('条款页带当前版本号和【 】；条款页和申请页里，除了“禁止事项”那一条，没有保证类用语', () => {
  const terms = web('provider-terms.html');
  assert.ok(terms.includes(PROVIDER_TERMS_VERSION), '版本号和 PROVIDER_TERMS_VERSION 一致');
  assert.ok(terms.includes('【'), '空着的地方用【 】');
  assert.match(terms, /不按咨询数、成交数或报酬的比例收取/); assert.match(terms, /士业不向运营者支付任何介绍费或成交报酬/);
  const ban = /<section id="t5">[\s\S]*?<\/section>/.exec(terms);
  assert.ok(ban && /禁止事项/.test(ban[0]), '禁止事项单独一节');
  assert.ok(hasClaims(ban[0]), '禁止事项里列出了这些用语');
  const rest = noStyle(terms).replace(ban[0], '');
  for (const line of rest.split('\n')) assert.ok(!hasClaims(line), '条款里禁止事项以外不应当有：' + line.trim().slice(0, 60));
  for (const line of noStyle(web('provider-apply.html')).split('\n')) assert.ok(!hasClaims(line), '申请页里不应当有：' + line.trim().slice(0, 60));
});

test('首页的服务商名单：上方写明展示费；显示所属会和事务所地址；有申请入驻的链接；工作台有领取令牌', () => {
  const idx = web('index.html');
  assert.match(idx, /以下服务商向在留导航支付固定的展示费；士业不按成交或咨询数付费；排列按入驻先后/);
  assert.match(idx, /所属会："\+p\.licenseBody/); assert.match(idx, /事务所地址："\+p\.address/);
  assert.match(idx, /href="\/provider-apply\.html"/);
  const pv = web('provider.html');
  assert.match(pv, /用联系邮箱领取/); assert.match(pv, /只显示这一次/);
  assert.ok(!/localStorage|sessionStorage/.test(pv), '工作台不把令牌存进浏览器');
  const adm = web('admin.html');
  assert.ok(!/localStorage|sessionStorage/.test(adm), '管理员令牌只放在内存里');
  assert.match(adm, /noindex/);
  assert.ok(!idx.includes('/admin.html'), '首页不链接管理后台');
});
