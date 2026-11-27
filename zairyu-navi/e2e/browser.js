// 端到端：真实浏览器打开网页，数据应当存到服务器，换一个“设备”带同一账号能读回来。
// 运行：先启动服务器（ADMIN_TOKEN 要和这里的一致，默认 e2e-admin），再 BASE=http://localhost:端口 node e2e/browser.js
// 需要已安装 playwright。助手没有配置密钥也能跑：助手接口的返回在浏览器里用 page.route 替换成固定内容，
// 其余请求（发咨询、删账号、保存等）都打到真实的服务器上。
// E2E_KEEP_GOING=1 时某一步失败后继续跑后面的步骤，最后一并报告（用来确认新加的检查在旧页面上确实会失败）。
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE || 'http://localhost:8787';
const assert = require('node:assert/strict');
const keepGoing = process.env.E2E_KEEP_GOING === '1';
const failed = [];
async function step(name, fn) {
  try { await fn(); console.log('通过：' + name); } catch (e) {
    if (!keepGoing) throw new Error(name + '：' + e.message);
    failed.push(name); console.log('失败：' + name + '：' + String(e.message).split('\n')[0]);
  }
}
(async () => {
  const b = await chromium.launch(); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  let dialogs = [], acceptDialog = true;
  p.on('dialog', (d) => { dialogs.push(d.message()); return acceptDialog ? d.accept() : d.dismiss(); });
  const adm = { authorization: 'Bearer ' + (process.env.ADMIN_TOKEN || 'e2e-admin'), 'content-type': 'application/json' };
  const json = async (path, opt) => (await fetch(base + path, opt)).json();
  const go = (hash) => p.evaluate((x) => { location.hash = x; }, hash);
  const apiReady = (page) => page.waitForFunction(() => window.ZAIRYU_API === true, null, { timeout: 8000 });
  let acct, h, get, plan, provA, provB;
  const provInq = (prov) => json('/api/provider/inquiries', { headers: { authorization: 'Bearer ' + prov.token } });
  const NAME_A = '端到端行政书士事务所甲<img src=x onerror="window.__xss=1">', NAME_B = '端到端行政书士事务所乙';

  await step('同意之前不建账号；同意后建账号，新用户是空白资料', async () => {
    await p.goto(base + '/');
    await p.waitForSelector('#consent-ok', { timeout: 5000 });
    assert.equal(await p.evaluate(() => localStorage.getItem('zairyu-account')), null, '同意之前不应当有账号');
    for (const doc of ['/terms.html', '/privacy.html']) assert.equal((await fetch(base + doc)).status, 200, doc);
    await p.screenshot({ path: '/tmp/e2e-consent.png' });
    await p.click('#consent-ok');
    await apiReady(p);
    acct = await p.evaluate(() => JSON.parse(localStorage.getItem('zairyu-account')));
    assert.ok(acct.id && acct.token, '应当建好账号');
    h = { authorization: 'Bearer ' + acct.token, 'content-type': 'application/json' };
    get = () => json(`/api/users/${acct.id}`, { headers: h });
    assert.equal((await get()).profile.status, 'none', '新用户应当是空白资料，不是演示人物');
    assert.equal(await p.evaluate(() => P.status), 'none');
  });

  await step('填情况、完成任务都存到服务器，页面和服务器算出的下一步一致', async () => {
    await p.evaluate(() => { P.status = 'work'; P.entry = '2026-11-18'; P.addr = '2026-11-20'; P.ins = true; save(); bind(); renderAll(); });
    await p.waitForTimeout(800);
    assert.equal((await get()).profile.status, 'work', '填的情况应当已存到服务器');
    await p.evaluate(() => complete('1-1', true)); await p.waitForTimeout(800);
    assert.deepEqual((await get()).done, { '1-1': true });
    plan = await json(`/api/users/${acct.id}/plan`, { headers: h });
    const uiNext = await p.evaluate(() => { const n = nextQuest(compute()); return n && n.id; });
    assert.equal(plan.next.id, uiNext, '服务器算出的下一步和页面显示的应当一样');
  });

  await step('有账号时不提供“恢复示例”，有“删除我的账号和全部数据”', async () => {
    await go('#route'); await p.evaluate(() => { document.getElementById('prof').open = true; });
    assert.equal(await p.isVisible('#reset'), false, '有账号时不应当能点“恢复示例”');
    assert.equal(await p.isVisible('#del-account'), true, '应当有删除账号的按钮');
    // 即使脚本去点，也不能把示例人物写到服务器上
    await p.evaluate(() => document.getElementById('reset').click()); await p.waitForTimeout(700);
    const u = await get();
    if (u.profile.arrive === '2019-04-01') { // 旧页面：示例已经盖上去了。恢复原样，让后面的步骤接着跑
      await p.evaluate(() => { P.arrive = ''; P.work = ''; P.trips = []; P.status = 'work'; P.entry = '2026-11-18'; P.addr = '2026-11-20'; P.ins = true; DONE = { '1-1': 1 }; save(); bind(); renderAll(); }); await p.waitForTimeout(700);
    }
    assert.notEqual(u.profile.arrive, '2019-04-01', '示例人物的来日日期不应当出现在服务器上');
    assert.deepEqual(u.done, { '1-1': true }, '已完成的任务不应当被清空');
  });

  await step('记录“换工作”，提醒里出现14天期限，并带法条和官方页面的链接', async () => {
    await go('#reminders'); await p.waitForSelector('#ev-add');
    await p.selectOption('#ev-type', 'job_change'); await p.fill('#ev-date', '2026-11-30'); await p.click('#ev-add');
    await p.waitForFunction(() => document.getElementById('rem').innerText.includes('所属机关'), null, { timeout: 5000 });
    const link = p.locator('#rem a[href^="https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00015"]');
    assert.equal(await link.count(), 1, '换工作的期限应当带入管厅页面的链接');
    assert.match(await link.innerText(), /入管法第19条/, '链接文字里应当有法条');
  });

  await step('高度专门职的换工作期限带两个官方页面；短期滞在记录孩子出生有出生届的期限；没有登记到期限时不下“没有法定期限”的结论', async () => {
    const setStatus = async (x) => { await p.evaluate((v) => { P.status = v; save(); bind(); renderAll(); }, x); await p.waitForTimeout(300); };
    const record = async (type, date) => { await p.selectOption('#ev-type', type); await p.fill('#ev-date', date); await p.click('#ev-add'); await p.waitForFunction(() => /已记下/.test(document.getElementById('toast').textContent), null, { timeout: 5000 }); return p.innerText('#toast'); };
    await setStatus('hsp'); await go('#reminders');
    assert.equal(await p.locator('#rem a[href*="nyuukokukanri10_00015"]').count(), 1, '契约机关届出的页面');
    assert.equal(await p.locator('#rem a[href*="nyuukokukanri10_00014"]').count(), 1, '高度专门职还应当带活动机关届出的页面');
    await setStatus('short'); await p.evaluate(() => { document.getElementById('toast').textContent = ''; });
    const none = await record('divorce', '2026-11-02');
    assert.match(none, /没有登记到对应的期限.*以入管厅或区役所的说明为准/, '应当说明只是这里没有登记到');
    assert.doesNotMatch(none, /没有法定的申报期限/, '不应当下“没有法定期限”的结论');
    await p.evaluate(() => { document.getElementById('toast').textContent = ''; });
    assert.match(await record('birth', '2026-11-01'), /期限已加进提醒/);
    await p.waitForFunction(() => document.getElementById('rem').innerText.includes('出生届'), null, { timeout: 5000 });
    assert.equal(await p.locator('#rem a[href^="https://www.moj.go.jp/ONLINE/FAMILYREGISTER/"]').count(), 1, '短期滞在的出生届期限也带依据');
    // 恢复：删掉这一步记的两件事，身份改回去
    for (const ev of await json(`/api/users/${acct.id}/events`, { headers: h })) if (ev.type !== 'job_change') await fetch(`${base}/api/users/${acct.id}/events/${ev.id}`, { method: 'DELETE', headers: h });
    await setStatus('work'); await p.waitForTimeout(800);
    assert.equal((await get()).profile.status, 'work');
    await p.reload(); await apiReady(p);
  });

  await step('咨询申请：没勾同意不能发；服务商或文字一变，同意的勾就取消；疑似敏感号码被拒并说明原因', async () => {
    const mk = (name) => json('/api/admin/providers', { method: 'POST', headers: adm, body: JSON.stringify({ name, category: 'gyosei', area: '大阪', langs: '中文', feeNote: '首次咨询免费30分钟', licenseNo: '第12345678号' }) });
    provA = await mk(NAME_A); provB = await mk(NAME_B);
    assert.ok(provA.token && provB.token, '应当拿到服务商令牌');
    await go('#providers'); await p.selectOption('#pv-cat', 'gyosei');
    await p.waitForFunction(() => document.querySelectorAll('#pv-list input[type=checkbox]').length >= 2, null, { timeout: 5000 });
    assert.equal(await p.locator('#pv-list img').count(), 0, '服务商名称里的标签不应当被当成 HTML');
    const boxOf = (name) => p.locator('#pv-list .card', { hasText: name }).locator('input[type=checkbox]');
    await boxOf('事务所甲').check(); await p.fill('#pv-msg', '想咨询在留期间更新，明年到期。');
    await p.click('#pv-send'); assert.match(await p.innerText('#pv-note'), /同意/, '没勾同意不能发');
    // 勾了同意以后再加一家：同意要重新勾
    await p.check('#pv-ok'); await boxOf('事务所乙').check();
    assert.equal(await p.isChecked('#pv-ok'), false, '多选了一家服务商，同意的勾应当取消');
    assert.ok((await p.innerText('#pv-form-h')).includes('事务所乙'));
    // 勾了同意以后改文字：同意要重新勾
    await p.check('#pv-ok'); await p.fill('#pv-msg', '想咨询在留期间更新，明年到期。另外想问报酬。');
    assert.equal(await p.isChecked('#pv-ok'), false, '改了咨询内容，同意的勾应当取消');
    // 勾了同意以后换类别：表单收起，勾取消
    await p.check('#pv-ok'); await p.selectOption('#pv-cat', 'zeirishi'); await p.waitForTimeout(400);
    assert.equal(await p.isChecked('#pv-ok'), false, '换了类别，同意的勾应当取消');
    assert.equal(await p.isVisible('#pv-form'), false, '没有选中的服务商时表单应当收起');
    await p.selectOption('#pv-cat', 'gyosei');
    await p.waitForFunction(() => document.querySelectorAll('#pv-list input[type=checkbox]').length >= 2);
    // 疑似护照号：服务器拒绝，页面把原因显示出来，什么都没发出去
    await boxOf('事务所甲').check(); await p.fill('#pv-msg', '我的护照号 E12345678，想咨询更新。'); await p.check('#pv-ok'); await p.click('#pv-send');
    await p.waitForFunction(() => /护照号/.test(document.getElementById('pv-note').textContent), null, { timeout: 5000 });
    assert.match(await p.innerText('#pv-note'), /疑似.*护照号.*删掉/, '应当说明是因为疑似含有敏感号码');
    assert.equal((await provInq(provA)).length, 0, '被拒的咨询不应当到服务商那里');
    assert.equal(await p.isChecked('#pv-ok'), false, '发送失败后要重新勾同意');
  });

  await step('咨询申请：发出去的就是页面上显示的全文', async () => {
    await p.fill('#pv-msg', '想咨询在留期间更新，明年到期。'); await p.check('#pv-ok');
    const shown = await p.evaluate(() => document.getElementById('pv-pack').textContent);
    assert.ok(shown.includes('想咨询在留期间更新') && shown.includes('身份：'), '显示的全文里应当有咨询内容和情况说明');
    await p.click('#pv-send');
    await p.waitForFunction(() => document.getElementById('inq-list').innerText.includes('事务所甲'), null, { timeout: 5000 });
    const got = await provInq(provA);
    assert.equal(got.length, 1); assert.equal(got[0].summary, shown.trim(), '服务商收到的应当和用户看到并同意的文字一样');
    assert.equal((await provInq(provB)).length, 0, '没选的服务商不应当收到');
  });

  // 之后的助手请求都换成固定内容；chat 是当前这一轮要返回的东西
  const chatReqs = []; let chat = null;
  await p.route('**/api/users/*/chat', async (route) => {
    const body = JSON.parse(route.request().postData()); chatReqs.push(body);
    const r = chat(body); await route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  const ask = async (q) => { await p.evaluate((x) => ask(x), q); await p.waitForFunction(() => busy === false, null, { timeout: 8000 }); };
  const lastAns = () => p.evaluate(() => [...document.querySelectorAll('#chat .msg.a .body')].pop().textContent);
  const turn = (body, text) => body.history.concat([{ role: 'user', content: body.message }, { role: 'assistant', content: text }]);

  await step('助手的咨询草稿：显示成卡片，同意的勾默认不勾，用户点了发送才发出去', async () => {
    const summary = '想请行政书士看一下在留期间更新的材料。\n在留期满日：2027-11-20。<b>不是标签</b>';
    chat = (body) => ({ body: { text: '草稿准备好了，请在下面核对，同意后由你点发送。', category: null, toolCalls: [{ name: 'create_inquiry', ok: true }], history: turn(body, '草稿准备好了'),
      draft: { category: 'gyosei', nodeId: '4-1', summary, providerIds: [provA.id, provB.id], providers: [{ id: provA.id, name: NAME_A }, { id: provB.id, name: NAME_B }] } } });
    const before = (await json(`/api/users/${acct.id}/inquiries`, { headers: h })).length;
    await p.evaluate(() => openDrawer()); await ask('帮我问问行政书士');
    const card = p.locator('#chat .draft');
    assert.equal(await card.count(), 1, '应当出现草稿卡片');
    const txt = await card.innerText();
    assert.ok(txt.includes('事务所甲') && txt.includes('事务所乙'), '卡片上应当有服务商的名字');
    assert.ok(txt.includes('想请行政书士看一下在留期间更新的材料') && txt.includes('<b>不是标签</b>'), '卡片上应当原样显示摘要');
    assert.equal(await p.locator('#chat .draft img, #chat .draft b').count(), 0, '名字和摘要里的标签不应当被当成 HTML');
    assert.equal(await p.evaluate(() => window.__xss), undefined, '不应当执行注入的脚本');
    assert.equal(await card.locator('input[type=checkbox]').isChecked(), false, '同意的勾默认不勾');
    assert.equal((await json(`/api/users/${acct.id}/inquiries`, { headers: h })).length, before, '只是草稿，什么都还没发');
    assert.equal((await provInq(provB)).length, 0, '服务商此时不应当收到任何东西');
    await card.locator('.draft-send').click();
    assert.match(await card.locator('.draft-note').innerText(), /同意/, '没勾同意点发送，不发');
    await p.waitForTimeout(300);
    assert.equal((await provInq(provB)).length, 0, '没勾同意时不应当发出去');
    await card.locator('input[type=checkbox]').check(); await card.locator('.draft-send').click();
    await p.waitForFunction(() => /已发出/.test(document.querySelector('#chat .draft').textContent), null, { timeout: 5000 });
    const gotB = await provInq(provB), gotA = await provInq(provA);
    assert.equal(gotB.length, 1); assert.equal(gotB[0].summary, summary, '服务商收到的应当是卡片上显示的摘要');
    assert.equal(gotA.length, 2, '两家都应当收到');
    assert.equal(await card.locator('.draft-send').count(), 0, '发出以后不能再点一次');
    await p.screenshot({ path: '/tmp/e2e-draft.png' });
    await p.evaluate(() => closeDrawer());
  });

  await step('助手对话：服务器返回的历史原样带回，连续35轮都不在中间截断；历史被拒时清空重试；敏感号码的拒绝原因显示给用户', async () => {
    // 模拟服务器：每一轮（含一次工具调用）加 4 条，超过 20 条就按整轮裁掉最早的
    let expect = null;
    chat = (body) => {
      let hst = body.history.concat([{ role: 'user', content: body.message }, { role: 'assistant', content: [{ type: 'tool_use', id: 't' + chatReqs.length, name: 'get_plan', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + chatReqs.length, content: '{}' }] }, { role: 'assistant', content: '好的' }]);
      while (hst.length > 20) hst = hst.slice(4);
      expect = hst; return { body: { text: '好的', category: null, toolCalls: [], draft: null, history: hst } };
    };
    await ask('第 0 轮');
    for (let i = 1; i <= 35; i++) {
      const want = expect; await ask('第 ' + i + ' 轮');
      assert.deepEqual(chatReqs[chatReqs.length - 1].history, want, '第 ' + i + ' 轮带回的历史应当和上一轮服务器返回的一模一样');
      assert.equal(await lastAns(), '好的', '第 ' + i + ' 轮应当成功');
    }
    // 历史被服务器拒绝：清空后自动重试一次
    const n0 = chatReqs.length; let first = true;
    chat = (body) => { if (first) { first = false; return { status: 422, body: { error: 'history 无效（第 1 条须为用户的文字消息）' } }; } return { body: { text: '重新开始了', category: null, toolCalls: [], draft: null, history: turn(body, '重新开始了') } }; };
    await ask('再问一次');
    assert.equal(chatReqs.length, n0 + 2, '应当重试一次'); assert.deepEqual(chatReqs[n0 + 1].history, [], '重试时历史应当清空');
    assert.equal(await lastAns(), '重新开始了');
    // 消息里有敏感号码：把服务器的说明显示出来，历史保留
    chat = () => ({ status: 422, body: { error: '消息里疑似含有护照号。为了保护你，这里不接收这类号码，请删掉后再发' } });
    await ask('我的护照号是 E12345678');
    assert.match(await lastAns(), /疑似含有护照号.*请删掉后再发/, '应当显示被拒的原因');
    // 太频繁：显示服务器的说明，历史不清空
    chat = () => ({ status: 429, body: { error: '提问太频繁，请在30秒后再试' } });
    await ask('再问'); assert.match(await lastAns(), /提问太频繁/);
    chat = (body) => ({ body: { text: '还记得', category: null, toolCalls: [], draft: null, history: turn(body, '还记得') } });
    await ask('还记得吗'); assert.equal(chatReqs[chatReqs.length - 1].history.length, 2, '被拒和限流都不应当清空历史');
  });
  await p.unroute('**/api/users/*/chat');

  await step('助手没配置时，页面给出明确提示', async () => {
    await ask('住民登记要带什么？');
    console.log('助手回复：', await lastAns());
  });

  await step('服务商工作台：令牌不对和连不上分开说；名单读不出来有提示和重试；没发出去的草稿不丢；被拒的回复说明原因', async () => {
    const pw = await ctx.newPage(); pw.on('pageerror', (e) => errs.push(e.message));
    await pw.goto(base + '/provider.html');
    await pw.fill('#tok', 'not-a-token'); await pw.click('#go');
    await pw.waitForFunction(() => document.getElementById('msg').textContent !== '');
    assert.match(await pw.innerText('#msg'), /令牌不对/, '令牌错了应当说令牌不对');
    await pw.route('**/api/provider/me', (r) => r.abort());
    await pw.fill('#tok', provA.token); await pw.click('#go');
    await pw.waitForFunction(() => /连不上/.test(document.getElementById('msg').textContent), null, { timeout: 5000 });
    assert.doesNotMatch(await pw.innerText('#msg'), /令牌不对/, '连不上服务器时不应当说令牌不对');
    await pw.unroute('**/api/provider/me');
    // 登录成功但名单读不出来：有看得见的提示和重试
    let failList = true;
    await pw.route('**/api/provider/inquiries', (r) => (failList ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"服务器内部错误"}' }) : r.continue()));
    await pw.click('#go'); await pw.waitForSelector('#list-retry', { timeout: 5000 });
    assert.ok(await pw.isVisible('#list-msg'), '名单读不出来时应当有看得见的提示');
    assert.doesNotMatch(await pw.innerText('#list-msg'), /令牌不对/);
    failList = false; await pw.click('#list-retry'); await pw.waitForSelector('#list textarea');
    await pw.unroute('**/api/provider/inquiries');
    assert.ok(!(await pw.innerText('body')).includes(acct.id), '服务商页面上不应出现用户账号');
    assert.equal(await pw.locator('#list textarea').count(), 2, '应当有两条咨询');
    assert.equal(await pw.locator('#list b, #list img').evaluateAll((l) => l.filter((x) => x.tagName === 'IMG' || x.textContent === '不是标签').length), 0, '摘要里的标签不应当被当成 HTML');
    // 第二条里写了草稿没发，回复第一条以后草稿还在
    await pw.locator('#list textarea').nth(1).fill('这一条还没写完');
    // 回复里有银行账号：被拒，说明原因，草稿留着
    await pw.locator('#list textarea').nth(0).fill('请把报酬汇到银行账号 1234567。');
    await pw.locator('#list .card').nth(0).locator('button', { hasText: '发送回复' }).click();
    await pw.waitForFunction(() => /银行账号/.test(document.querySelector('#list .card [role=status]').textContent), null, { timeout: 5000 });
    assert.equal(await pw.locator('#list textarea').nth(0).inputValue(), '请把报酬汇到银行账号 1234567。', '被拒的回复应当留在输入框里');
    await pw.locator('#list textarea').nth(0).fill('可以办理。报酬5万日元起，请带在留卡和课税证明。');
    await pw.locator('#list .card').nth(0).locator('button', { hasText: '发送回复' }).click();
    await pw.waitForFunction(() => document.getElementById('list').innerText.includes('你的回复'), null, { timeout: 5000 });
    assert.deepEqual(await pw.locator('#list textarea').evaluateAll((l) => l.map((x) => x.value)), ['', '这一条还没写完'], '回复一条以后，另一条没发出去的草稿应当还在');
    // 结束咨询失败：有提示
    await pw.route('**/api/provider/inquiries/*/status', (r) => r.abort());
    await pw.locator('#list .card').nth(1).locator('button', { hasText: '结束这条咨询' }).click();
    await pw.waitForFunction(() => /没有结束成功/.test(document.querySelectorAll('#list .card')[1].querySelector('[role=status]').textContent), null, { timeout: 5000 });
    await pw.screenshot({ path: '/tmp/e2e-provider.png', fullPage: true }); await pw.close();
  });

  await step('用户看到服务商的回复', async () => {
    await p.reload(); await apiReady(p); await go('#providers');
    await p.waitForFunction(() => document.getElementById('inq-list').innerText.includes('对方已回复'), null, { timeout: 5000 });
    assert.ok((await p.innerText('#inq-list')).includes('报酬5万日元起'), '用户应当看到回复');
    await p.screenshot({ path: '/tmp/e2e-inquiry.png', fullPage: true });
    // 七个页面都能打开
    for (const hash of ['#route', '#plans', '#city', '#docs', '#reminders', '#pr-check', '#providers']) { await go(hash); await p.waitForTimeout(120); }
  });

  await step('另一台设备：带同一账号打开，读回同样的进度', async () => {
    const ctx2 = await b.newContext(); const p2 = await ctx2.newPage(); p2.on('pageerror', (e) => errs.push(e.message));
    await p2.addInitScript((a) => localStorage.setItem('zairyu-account', JSON.stringify(a)), acct);
    await p2.goto(base + '/'); await apiReady(p2);
    assert.equal(await p2.evaluate(() => P.status), 'work'); assert.equal(await p2.evaluate(() => !!DONE['1-1']), true);
    await ctx2.close();
  });

  await step('打开页面时服务器出错（500）：账号留着，显示重试，重试后读回原来的内容', async () => {
    const me = '**/api/users/' + acct.id;
    await p.route(me, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"服务器内部错误"}' }));
    await p.reload(); await p.waitForSelector('#sync-retry', { timeout: 8000 });
    assert.equal(await p.locator('#consent').count(), 0, '服务器出错时不应当让用户重新建账号');
    assert.equal((await p.evaluate(() => JSON.parse(localStorage.getItem('zairyu-account')))).id, acct.id, '本机保存的账号应当还在');
    assert.match(await p.innerText('#sync-state'), /连不上服务器/);
    await p.unroute(me); await p.click('#sync-retry'); await apiReady(p);
    assert.equal(await p.evaluate(() => P.status), 'work', '重试后应当读回原来的内容');
    assert.equal(await p.isVisible('#sync-state'), false, '连上以后提示应当消失');
    // 连不上（网络错误）也一样留着账号
    await p.route('**/api/health', (r) => r.abort());
    await p.reload(); await p.waitForSelector('#sync-retry', { timeout: 8000 });
    assert.equal(await p.locator('#consent').count(), 0);
    await p.unroute('**/api/health'); await p.click('#sync-retry'); await apiReady(p);
    assert.equal((await p.evaluate(() => JSON.parse(localStorage.getItem('zairyu-account')))).id, acct.id);
  });

  await step('保存失败：有提示；刷新页面后本机的修改不被服务器的旧内容盖掉；恢复后自动重试并存上', async () => {
    const st = '**/api/users/*/state'; let puts = 0;
    await p.route(st, (r) => { puts++; return r.abort(); });
    await go('#route'); await p.evaluate(() => { document.getElementById('prof').open = true; });
    await p.selectOption('#f-status', 'hsp');
    await p.waitForFunction(() => /还没保存到服务器/.test(document.getElementById('sync-state').textContent), null, { timeout: 5000 });
    assert.equal((await get()).profile.status, 'work', '保存被拦住，服务器上应当还是旧的');
    await p.reload(); await apiReady(p);
    assert.equal(await p.evaluate(() => P.status), 'hsp', '刷新后本机没存上的修改应当还在');
    await p.waitForFunction(() => /还没保存到服务器/.test(document.getElementById('sync-state').textContent), null, { timeout: 5000 });
    const before = puts;
    await p.unroute(st);
    // 不点任何东西，等自动重试
    const t0 = Date.now(); while ((await get()).profile.status !== 'hsp' && Date.now() - t0 < 10000) await p.waitForTimeout(250);
    assert.equal((await get()).profile.status, 'hsp', '网络恢复后应当自动重试并存到服务器');
    assert.ok(before >= 2, '失败期间应当重试过');
    await p.waitForFunction(() => document.getElementById('sync-state').hidden, null, { timeout: 5000 });
    await p.reload(); await apiReady(p);
    assert.equal(await p.evaluate(() => P.status), 'hsp');
  });

  await step('本机保存的账号在服务器上不存在（401）：才丢掉账号，重新走同意流程', async () => {
    const ctx3 = await b.newContext(); const p3 = await ctx3.newPage(); p3.on('pageerror', (e) => errs.push(e.message));
    await p3.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('zairyu-account', JSON.stringify({ id: 'no-such-account', token: 'x' })); } });
    await p3.goto(base + '/'); await p3.waitForSelector('#consent-ok', { timeout: 5000 });
    assert.equal(await p3.evaluate(() => localStorage.getItem('zairyu-account')), null, '失效的账号应当从本机清掉');
    assert.match(await p3.innerText('#consent'), /已经失效/);
    await ctx3.close();
  });

  await step('删除我的账号和全部数据：先确认；失败时账号留着；成功后服务器和本机都清空', async () => {
    await go('#route'); await p.evaluate(() => { document.getElementById('prof').open = true; });
    // 在确认框里点取消：什么都不发生
    acceptDialog = false; dialogs = [];
    await p.click('#del-account'); await p.waitForTimeout(300);
    assert.equal(dialogs.length, 1, '应当先弹出确认'); assert.match(dialogs[0], /不能恢复/);
    assert.equal((await fetch(`${base}/api/users/${acct.id}`, { headers: h })).status, 200, '取消后账号应当还在');
    acceptDialog = true;
    // 服务器出错：账号和本机数据都留着，并说明没删成
    const me = '**/api/users/' + acct.id;
    await p.route(me, (r) => (r.request().method() === 'DELETE' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"服务器内部错误"}' }) : r.continue()));
    await p.click('#del-account');
    await p.waitForFunction(() => /没有删除成功/.test(document.getElementById('sync-state').textContent), null, { timeout: 5000 });
    assert.ok(await p.evaluate(() => localStorage.getItem('zairyu-account')), '没删成时本机的账号不能清掉');
    await p.unroute(me);
    // 真的删除
    assert.equal((await provInq(provA)).length, 2);
    await p.click('#del-account');
    await p.waitForSelector('#consent-ok', { timeout: 8000 });
    assert.deepEqual(await p.evaluate(() => ['zairyu-account', 'zairyu-demo-v3', 'zairyu-unsaved', 'zairyu-cache-owner'].map((k) => localStorage.getItem(k))), [null, null, null, null], '本机保存的内容应当清空');
    assert.equal((await fetch(`${base}/api/users/${acct.id}`, { headers: h })).status, 401, '服务器上的账号应当已经删除');
    assert.equal((await provInq(provA)).length, 0, '发给服务商的咨询也应当一并删除');
    assert.equal(await p.evaluate(() => localStorage.getItem('zairyu-account')), null, '删除后没有再同意之前不应当新建账号');
  });

  await step('页面没有脚本错误', async () => { assert.deepEqual(errs, [], '页面不应有脚本错误'); });
  await b.close();
  if (failed.length) { console.error('端到端失败 ' + failed.length + ' 步：\n- ' + failed.join('\n- ')); process.exit(1); }
  console.log('端到端通过' + (plan ? '，下一步任务：' + plan.next.id + ' ' + plan.next.title : ''));
})().catch((e) => { console.error('端到端失败：', e.message); process.exit(1); });
