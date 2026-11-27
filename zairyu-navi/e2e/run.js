// npm run e2e：自己起一个服务器（空闲端口、临时目录里的新数据库），跑 e2e/browser.js，跑完关掉。
// 网页端的行为（账号、保存、同意、草稿卡片、服务商工作台）只有这里在检查，`npm test` 不跑它；发布前两个都要跑。
// 需要 playwright：全局装了的话用 PLAYWRIGHT_PATH 指过去，例如 PLAYWRIGHT_PATH=/opt/node-tools/node_modules/playwright npm run e2e
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../src/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-e2e-'));
const adminToken = process.env.ADMIN_TOKEN || 'e2e-admin';
// 有名字的管理员令牌：审核入驻申请那一步用它，核对记录里的核对人是 e2e
const reviewerToken = 'e2e-reviewer-token-0123456789';
// appUrl：提醒邮件里的链接指向这个临时服务器（端口在 listen 之后才知道，所以传函数）
// allowDirectProvider：前面几步用管理员直接入驻的服务商（只有测试里开）；notify：新咨询通知不延迟，跑一轮就排
const app = createApp({ dbFile: path.join(dir, 'e2e.db'), adminToken, adminTokens: { e2e: reviewerToken }, allowDirectProvider: true, notify: { delayMin: 0, intervalMin: 1 }, appUrl: () => 'http://127.0.0.1:' + app.server.address().port });
const finish = (code) => {
  app.server.close(); app.server.closeAllConnections();
  try { app.store.close(); } catch (e) { /* 已经关了 */ }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
};
app.server.listen(0, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + app.server.address().port;
  console.log('端到端：服务器在 ' + base + '，数据库在 ' + dir);
  const child = spawn(process.execPath, [path.join(__dirname, 'browser.js')], { stdio: 'inherit', env: Object.assign({}, process.env, { BASE: base, ADMIN_TOKEN: adminToken, E2E_REVIEWER_TOKEN: reviewerToken }) });
  child.on('error', (e) => { console.error('端到端没有跑起来：', e.message); finish(1); });
  child.on('exit', (code) => finish(code == null ? 1 : code));
});
