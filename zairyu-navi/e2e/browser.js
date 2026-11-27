// 端到端：真实浏览器打开网页，数据应当存到服务器，换一个“设备”带同一账号能读回来。
// 运行：先 npm start，再 node e2e/browser.js （需要已安装 playwright）
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE || 'http://localhost:8787';
const assert = require('node:assert/strict');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(base + '/');
  // 没同意之前不应该建账号
  await p.waitForSelector('#consent-ok', { timeout: 5000 });
  assert.equal(await p.evaluate(() => localStorage.getItem('zairyu-account')), null, '同意之前不应当有账号');
  for (const doc of ['/terms.html', '/privacy.html']) assert.equal((await fetch(base + doc)).status, 200, doc);
  await p.screenshot({ path: '/tmp/e2e-consent.png' });
  await p.click('#consent-ok');
  await p.waitForFunction(() => window.ZAIRYU_API === true, null, { timeout: 5000 });
  const acct = await p.evaluate(() => JSON.parse(localStorage.getItem('zairyu-account')));
  assert.ok(acct.id && acct.token, '应当建好账号');
  const h = { authorization: 'Bearer ' + acct.token, 'content-type': 'application/json' };
  const get = async () => (await fetch(`${base}/api/users/${acct.id}`, { headers: h })).json();
  assert.equal((await get()).profile.status, 'none', '新用户应当是空白资料，不是演示人物');
  assert.equal(await p.evaluate(() => P.status), 'none');
  // 在页面里填情况（走页面自己的保存流程）
  await p.evaluate(() => { P.status = 'work'; P.entry = '2026-11-18'; P.addr = '2026-11-20'; P.ins = true; save(); bind(); renderAll(); });
  await p.waitForTimeout(800);
  assert.equal((await get()).profile.status, 'work', '填的情况应当已存到服务器');
  // 在页面里完成住民登记
  await p.evaluate(() => complete('1-1', true)); await p.waitForTimeout(800);
  assert.deepEqual((await get()).done, { '1-1': true });
  const plan = await (await fetch(`${base}/api/users/${acct.id}/plan`, { headers: h })).json();
  const uiNext = await p.evaluate(() => { const n = nextQuest(compute()); return n && n.id; });
  assert.equal(plan.next.id, uiNext, '服务器算出的下一步和页面显示的应当一样');
  // 记录“换工作”，提醒里出现14天期限
  await p.evaluate(() => { location.hash = '#reminders'; }); await p.waitForSelector('#ev-add');
  await p.selectOption('#ev-type', 'job_change'); await p.fill('#ev-date', '2026-11-30'); await p.click('#ev-add'); await p.waitForTimeout(600);
  assert.ok((await p.innerText('#rem')).includes('所属机关'), '提醒里应当出现换工作的期限');
  // 对接：管理员入驻一家行政书士，用户选它并发咨询，服务商在工作台回复，用户看到回复
  const adm = { authorization: 'Bearer ' + (process.env.ADMIN_TOKEN || 'e2e-admin'), 'content-type': 'application/json' };
  const prov = await (await fetch(base + '/api/admin/providers', { method: 'POST', headers: adm, body: JSON.stringify({ name: '端到端行政书士事务所', category: 'gyosei', area: '大阪', langs: '中文', feeNote: '首次咨询免费30分钟', licenseNo: '第12345678号' }) })).json();
  assert.ok(prov.token, '应当拿到服务商令牌');
  await p.evaluate(() => { location.hash = '#providers'; }); await p.selectOption('#pv-cat', 'gyosei'); await p.waitForTimeout(500);
  await p.click('#pv-list input[type=checkbox]'); await p.fill('#pv-msg', '想咨询在留期间更新，明年到期。');
  await p.click('#pv-send'); assert.match(await p.innerText('#pv-note'), /同意/, '没勾同意不能发');
  await p.check('#pv-ok'); await p.click('#pv-send'); await p.waitForTimeout(700);
  assert.ok((await p.innerText('#inq-list')).includes('端到端行政书士事务所'));
  const pw = await ctx.newPage(); pw.on('pageerror', (e) => errs.push(e.message));
  await pw.goto(base + '/provider.html'); await pw.fill('#tok', prov.token); await pw.click('#go'); await pw.waitForSelector('#list textarea');
  assert.ok(!(await pw.innerText('body')).includes(acct.id), '服务商页面上不应出现用户账号');
  await pw.fill('#list textarea', '可以办理。报酬5万日元起，请带在留卡和课税证明。'); await pw.click('#list button'); await pw.waitForTimeout(600);
  await pw.screenshot({ path: '/tmp/e2e-provider.png', fullPage: true }); await pw.close();
  await p.reload(); await p.waitForFunction(() => window.ZAIRYU_API === true); await p.evaluate(() => { location.hash = '#providers'; }); await p.waitForTimeout(400);
  const inq = await p.innerText('#inq-list');
  assert.ok(inq.includes('对方已回复') && inq.includes('报酬5万日元起'), '用户应当看到回复');
  await p.screenshot({ path: '/tmp/e2e-inquiry.png', fullPage: true });
  // 七个页面都能打开
  for (const hash of ['#route', '#plans', '#city', '#docs', '#reminders', '#pr-check', '#providers']) { await p.evaluate((x) => { location.hash = x; }, hash); await p.waitForTimeout(120); }
  // 另一台设备：带同一账号打开，应当读回同样的进度
  const ctx2 = await b.newContext(); const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errs.push(e.message));
  await p2.addInitScript((a) => localStorage.setItem('zairyu-account', JSON.stringify(a)), acct);
  await p2.goto(base + '/'); await p2.waitForFunction(() => window.ZAIRYU_API === true, null, { timeout: 5000 });
  assert.equal(await p2.evaluate(() => P.status), 'work'); assert.equal(await p2.evaluate(() => !!DONE['1-1']), true);
  // 助手没配置时，页面给出明确提示
  await p.evaluate(() => ask('住民登记要带什么？')); await p.waitForTimeout(600);
  const last = await p.evaluate(() => [...document.querySelectorAll('#chat .msg.a .body')].pop().textContent);
  console.log('助手回复：', last);
  assert.deepEqual(errs, [], '页面不应有脚本错误');
  console.log('端到端通过，下一步任务：', plan.next.id, plan.next.title);
  await b.close();
})().catch((e) => { console.error('端到端失败：', e.message); process.exit(1); });
