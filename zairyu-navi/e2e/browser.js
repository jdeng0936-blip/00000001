// 端到端：真实浏览器打开网页，数据应当存到服务器，换一个“设备”带同一账号能读回来。
// 运行：npm run e2e（e2e/run.js 起好服务器再跑这里）。服务器要开 allowDirectProvider（前面几步直接入驻服务商）、ADMIN_TOKEN 和 ADMIN_TOKENS 里的 e2e 要和这里的一致，
// 新咨询通知不延迟；这几项只能用 createApp 的参数设，所以对着 npm start 起的服务器跑不了服务商的那几步。
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
  // 有名字的管理员令牌（ADMIN_TOKENS 里的 e2e），审核入驻申请用：核对记录里记下的核对人是 e2e
  const REVIEWER = process.env.E2E_REVIEWER_TOKEN || 'e2e-reviewer-token-0123456789';
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

  await step('上线规则：资料整理中的节点只给官方链接；待核实的罚则不显示数字', async () => {
    await go('#route');
    const d = await p.evaluate(() => { SEL = '3-2'; renderRoute(); const el = document.getElementById('detail'); return { text: el.textContent, links: el.querySelectorAll('.src a').length, open: el.querySelector('details').open }; });
    assert.match(d.text, /资料整理中/); assert.ok(d.links > 0, '要给官方链接'); assert.ok(d.open, '依据默认展开');
    assert.ok(!/驾校费用待调研|1,900日元/.test(d.text), '不显示待核实的费用和要点');
    assert.ok(!/完全预约|光明池参加学科考试/.test(d.text), '步骤也不显示（步骤里曾经带着待核实行的考场和预约规则）');
    assert.match(d.text, /核对日期：2026年11月24日/, '核对日期按节点显示');
    const d53 = await p.evaluate(() => { SEL = '5-3'; renderRoute(); return document.getElementById('detail').textContent; });
    assert.ok(!/2027年4月1日/.test(d53), '5-3 施行日没核实：概要、要点、依据标题里都不显示日期');
    const d46 = await p.evaluate(() => { SEL = '4-6'; renderRoute(); return document.getElementById('detail').textContent; });
    assert.match(d46, /核对日期：2026年11月27日/);
    const t = await p.evaluate(() => { SEL = '4-2'; renderRoute(); return [...document.querySelectorAll('#detail tr')].map((r) => r.textContent).find((x) => x.startsWith('逾期的处罚')); });
    assert.ok(t && !/[0-9]/.test(t), t);
    await p.evaluate(() => { SEL = null; renderAll(); });
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
    const mk = (name) => json('/api/admin/providers', { method: 'POST', headers: adm, body: JSON.stringify({ name, category: 'gyosei', area: '大阪', langs: '中文', feeNote: '首次咨询免费30分钟', licenseNo: '第12345678号', licenseBody: '大阪府行政書士会' }) });
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
    assert.ok(txt.includes('固定的展示费'), '草稿卡片上也要写明服务商付展示费');
    assert.equal(await card.locator('.draft-promo').count(), 0, '士业不标含推广');
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

  await step('助手的咨询草稿：非士业的服务商在卡片上标“含推广”', async () => {
    chat = (body) => ({ body: { text: '草稿准备好了。', category: null, toolCalls: [{ name: 'create_inquiry', ok: true }], history: turn(body, '草稿准备好了'),
      draft: { category: 'edu', nodeId: null, summary: '想了解在职读硕士的课程。', providerIds: ['00000000-0000-4000-8000-000000000001'], providers: [{ id: '00000000-0000-4000-8000-000000000001', name: '某学校<i>x</i>' }] } } });
    await p.evaluate(() => openDrawer()); await ask('帮我问问学校');
    const card = p.locator('#chat .draft:not(.sent)');
    assert.equal(await card.count(), 1);
    assert.equal(await card.locator('.draft-promo').innerText(), '含推广');
    assert.ok((await card.innerText()).includes('某学校<i>x</i>'), '名字原样显示');
    assert.equal(await card.locator('i').count(), 0);
    await card.locator('.draft-drop').click();
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

  // 发到某个邮箱的最后一封验证码邮件里的验证码（本地发件方式下，邮件留在发件箱里，从管理接口读）
  const mailCode = async (to, after) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const rows = (await json('/api/admin/outbox?to=' + encodeURIComponent(to), { headers: adm })).filter((r) => r.kind === 'code' && !(after || []).includes(r.id));
      if (rows.length) { const r = rows[rows.length - 1]; return { id: r.id, code: /验证码：(\d{6})/.exec(r.body)[1] }; }
      await p.waitForTimeout(100);
    }
    throw new Error('发件箱里没有发给 ' + to + ' 的验证码邮件');
  };
  const MAIL = 'e2e.user@example.com';
  let bindMail;

  await step('绑定邮箱：不勾同意不发；填验证码后绑定，页面只显示打码的地址；能看到登录着的设备', async () => {
    await go('#route'); await p.evaluate(() => { document.getElementById('prof').open = true; });
    await p.waitForSelector('#em-addr', { timeout: 5000 });
    assert.match(await p.innerText('#em-state'), /还没有绑定邮箱/);
    assert.equal(await p.locator('#ses-list li').count(), 1); assert.match(await p.innerText('#ses-list'), /注册时的设备（这台设备）/);
    assert.equal(await p.isVisible('#ses-revoke'), false, '只有一台设备时没有“让其他设备退出登录”');
    await p.fill('#em-addr', ' E2E.User@Example.com ');
    await p.click('#em-send');
    assert.match(await p.innerText('#em-msg'), /请先勾选同意/);
    assert.equal((await json('/api/admin/outbox', { headers: adm })).length, 0, '没勾同意时不应当发邮件');
    await p.check('#em-ok'); await p.click('#em-send');
    await p.waitForSelector('#em-code', { timeout: 5000 });
    bindMail = await mailCode(MAIL);
    // 填错：说明原因，输入框还在
    await p.fill('#em-code', bindMail.code === '000000' ? '111111' : '000000'); await p.click('#em-verify');
    await p.waitForFunction(() => /验证码不对或已过期/.test(document.getElementById('em-msg').textContent), null, { timeout: 5000 });
    assert.equal((await json(`/api/users/${acct.id}/email`, { headers: h })).email, null, '验证码不对时不应当绑定');
    await p.fill('#em-code', bindMail.code); await p.click('#em-verify');
    await p.waitForFunction(() => /已绑定邮箱：e\*\*\*@example\.com/.test(document.getElementById('em-state').textContent), null, { timeout: 5000 });
    assert.deepEqual(await json(`/api/users/${acct.id}/email`, { headers: h }), { email: 'e***@example.com', verified: true, remindOptIn: false });
    assert.ok(!(await p.innerText('#acct-box')).includes('e2e.user'), '页面上不显示完整的邮箱');
    assert.equal(await p.isVisible('#em-remove'), true);
    await p.screenshot({ path: '/tmp/e2e-email.png', fullPage: true });
  });

  await step('清空浏览器后用邮箱找回：验证码从发件箱读；回到同一个账号，内容读回来；原来的令牌还能用；收到新设备登录的通知', async () => {
    const want = await get();
    const old = { id: acct.id, token: acct.token };
    await p.evaluate(() => localStorage.clear());
    await p.reload();
    await p.waitForSelector('#consent-ok', { timeout: 5000 });
    assert.equal(await p.evaluate(() => localStorage.getItem('zairyu-account')), null);
    assert.equal(await p.isVisible('#rc-addr'), false, '找回的表单点了才展开');
    await p.click('#recover-open');
    // 没绑定过的邮箱：页面的提示和绑定过的一样，不说“没有这个账号”
    await p.fill('#rc-addr', 'nobody.e2e@example.com'); await p.click('#rc-send');
    await p.waitForSelector('#rc-code', { state: 'visible', timeout: 5000 });
    const unknownMsg = await p.innerText('#rc-msg');
    assert.match(unknownMsg, /如果这个邮箱绑定过账号/);
    await p.fill('#rc-code', '123456'); await p.click('#rc-verify');
    await p.waitForFunction(() => /没有找回：验证码不对或已过期/.test(document.getElementById('rc-msg').textContent), null, { timeout: 5000 });
    assert.equal(await p.evaluate(() => localStorage.getItem('zairyu-account')), null, '验证码不对时不应当登录');
    // 绑定过的邮箱
    await p.fill('#rc-addr', MAIL); await p.click('#rc-send');
    await p.waitForFunction((m) => document.getElementById('rc-msg').textContent === m, unknownMsg, { timeout: 5000 });
    const m = await mailCode(MAIL, [bindMail.id]);
    await p.screenshot({ path: '/tmp/e2e-recover.png' });
    await p.fill('#rc-code', m.code); await p.click('#rc-verify');
    await apiReady(p);
    acct = await p.evaluate(() => JSON.parse(localStorage.getItem('zairyu-account')));
    assert.equal(acct.id, old.id, '应当回到原来的账号'); assert.notEqual(acct.token, old.token, '这台设备拿到的是新令牌');
    h = { authorization: 'Bearer ' + acct.token, 'content-type': 'application/json' };
    assert.equal(await p.isVisible('#consent'), false);
    assert.equal(await p.evaluate(() => P.status), want.profile.status, '概况应当从服务器读回来');
    assert.deepEqual(await p.evaluate(() => DONE), want.done);
    assert.equal((await fetch(`${base}/api/users/${old.id}`, { headers: { authorization: 'Bearer ' + old.token } })).status, 200, '原来的设备不掉线');
    const notice = (await json('/api/admin/outbox?to=' + encodeURIComponent(MAIL), { headers: adm })).filter((r) => r.kind === 'notice');
    assert.equal(notice.length, 1); assert.match(notice[0].subject, /新设备/);
    // 找回之后改的内容照常存到服务器
    await go('#route'); await p.evaluate(() => { document.getElementById('prof').open = true; });
    await p.check('#f-lic'); await p.waitForTimeout(800);
    assert.equal((await get()).profile.lic, true);
    await p.uncheck('#f-lic'); await p.waitForTimeout(800);
    // 刚用邮箱找回登录的设备不能马上解除邮箱：页面显示服务器的说明，邮箱还绑着
    await p.waitForSelector('#em-remove', { timeout: 5000 });
    await p.click('#em-remove');
    await p.waitForFunction(() => /没有解除成功：这台设备是刚用邮箱找回登录的，24 小时内不能更换或解除绑定的邮箱/.test(document.getElementById('em-msg').textContent), null, { timeout: 5000 });
    assert.equal((await json(`/api/users/${acct.id}/email`, { headers: h })).email, 'e***@example.com');

    // 让其他设备退出登录：原来的令牌失效，这台设备还在
    await p.waitForSelector('#ses-revoke', { timeout: 5000 });
    assert.equal(await p.locator('#ses-list li').count(), 2);
    assert.match(await p.innerText('#ses-list'), /用邮箱找回登录的设备（这台设备）/);
    dialogs = [];
    await p.click('#ses-revoke');
    await p.waitForFunction(() => document.querySelectorAll('#ses-list li').length === 1, null, { timeout: 5000 });
    assert.equal(dialogs.length, 1, '退出其他设备之前先确认');
    assert.equal((await fetch(`${base}/api/users/${old.id}`, { headers: { authorization: 'Bearer ' + old.token } })).status, 401, '原来的令牌应当失效');
    assert.equal((await get()).profile.status, want.profile.status, '这台设备还登录着');
    // 被退出的设备再打开：提示登录失效，并能用邮箱找回
    const ctx4 = await b.newContext(); const p4 = await ctx4.newPage(); p4.on('pageerror', (e) => errs.push(e.message));
    await p4.addInitScript((a) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('zairyu-account', JSON.stringify(a)); } }, old);
    await p4.goto(base + '/'); await p4.waitForSelector('#consent-ok', { timeout: 5000 });
    assert.match(await p4.innerText('#consent'), /已经失效/); assert.match(await p4.innerText('#consent'), /用邮箱找回/);
    await ctx4.close();
  });

  await step('邮件提醒：默认关；在“提醒”页打开后，跑一轮定时任务，发件箱里有提醒邮件（全文、依据、应用和退订链接），再跑不重发；打开退订链接点“退订”，服务器和页面上都变成关的', async () => {
    const E = `/api/users/${acct.id}/email`;
    // 记一件 10 天前的“换工作”：14 天的期限还剩 4 天（按日本时间的今天算）
    const jstDay = (offset) => new Date(Math.floor((Date.now() + 9 * 3600000) / 86400000) * 86400000 + offset * 86400000).toISOString().slice(0, 10);
    const made = await (await fetch(`${base}/api/users/${acct.id}/events`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'job_change', date: jstDay(-10) }) })).json();
    const due = (await json(`/api/users/${acct.id}/reminders`, { headers: h })).filter((r) => r.tag === '事件' && r.date === jstDay(4));
    assert.equal(due.length, 1, '应当有一条 4 天后到期的事件期限');
    await p.reload(); await apiReady(p); await go('#reminders');
    await p.waitForSelector('#rm-mail-on', { timeout: 5000 });
    assert.equal(await p.isChecked('#rm-mail-on'), false, '默认是关的');
    assert.match(await p.innerText('#rm-mail'), /期限前 7 天、前 1 天和当天各发一封/);
    assert.match(await p.innerText('#rm-mail-state'), /还没有打开。绑定的邮箱是 e\*\*\*@example\.com/);
    assert.equal(await p.isVisible('#au-push-row'), false, '连着服务器时不显示演示用的“邮件提醒”');
    assert.equal((await json(E, { headers: h })).remindOptIn, false);
    // 没打开时跑定时任务：不发
    const run = async () => (await fetch(base + '/api/admin/reminders/run', { method: 'POST', headers: adm })).json();
    const reminderMails = async () => (await json('/api/admin/outbox?to=' + encodeURIComponent(MAIL), { headers: adm })).filter((r) => r.kind === 'reminder');
    assert.deepEqual([(await run()).mails, (await reminderMails()).length], [0, 0]);
    // 打开
    await p.check('#rm-mail-on');
    await p.waitForFunction(() => /邮件提醒已打开/.test((document.getElementById('rm-mail-msg') || {}).textContent || ''), null, { timeout: 5000 });
    assert.equal((await json(E, { headers: h })).remindOptIn, true);
    assert.equal(await p.isChecked('#rm-mail-on'), true);
    await go('#route'); await p.evaluate(() => { document.getElementById('prof').open = true; });
    assert.equal(await p.isChecked('#em-remind'), true, '“账号和邮箱”里的开关是同一个设置');
    await go('#reminders');
    await p.screenshot({ path: '/tmp/e2e-remind.png', fullPage: true });
    // 跑一轮：发出一封；再跑一轮：不重发
    const first = await run();
    assert.deepEqual([first.users, first.mails, first.sent, first.failed], [1, 1, 1, 0]);
    assert.ok(first.items >= 1);
    const again = await run();
    assert.deepEqual([again.mails, again.sent], [0, 0], '同一档只发一次');
    const mails = await reminderMails();
    assert.equal(mails.length, 1); assert.equal(mails[0].status, 'sent');
    const body = mails[0].body;
    assert.match(mails[0].subject, /^【在留导航】有 \d+ 件事/);
    // 事件期限在邮件里用不分在留资格的写法（页面上的那句按身份写，邮件要经过邮件服务商）
    assert.match(body, /所属机关有变动（离开或加入）：自变动之日起14天内，向入管提交所属机关的届出/, '邮件里写明是哪件事');
    assert.doesNotMatch(body, /高度专门职|技术·人文知识|留学|家族滞在|特定技能|经营·管理/, '邮件里不出现在留资格的名称');
    assert.match(body, /（还有 4 天）/);
    assert.ok(body.includes(due[0].src.url), '带官方页面的链接');
    assert.match(body, /https?:\/\/[^\s]+\/#reminders/, '带打开应用的链接');
    assert.ok(!body.includes(MAIL) && !body.includes(acct.id) && !body.includes(acct.token), '邮件里没有邮箱、账号编号和令牌');
    const link = /(https?:\/\/[^\s/]+)(\/api\/unsubscribe\?t=[\w-]+)/.exec(body);
    assert.ok(link, '带退订链接');
    // 退订：另开一个没有登录的浏览器打开邮件里的链接
    const ctx5 = await b.newContext(); const p5 = await ctx5.newPage(); p5.on('pageerror', (e) => errs.push(e.message));
    await p5.goto(base + link[2]);
    await p5.waitForSelector('#unsub-go', { timeout: 5000 });
    assert.equal(await p5.evaluate(() => localStorage.getItem('zairyu-account')), null, '退订不用登录');
    assert.equal((await json(E, { headers: h })).remindOptIn, true, '只是打开链接不会退订');
    await p5.screenshot({ path: '/tmp/e2e-unsub.png' });
    await p5.click('#unsub-go');
    await p5.waitForSelector('#unsub-done', { timeout: 5000 });
    assert.match(await p5.innerText('body'), /已退订/);
    await ctx5.close();
    assert.equal((await json(E, { headers: h })).remindOptIn, false, '服务器上已经关掉');
    await p.reload(); await apiReady(p); await go('#reminders');
    await p.waitForSelector('#rm-mail-on', { timeout: 5000 });
    assert.equal(await p.isChecked('#rm-mail-on'), false, '页面上也是关的');
    assert.match(await p.innerText('#rm-mail-state'), /还没有打开/);
    assert.deepEqual([(await run()).users, (await reminderMails()).length], [0, 1], '退订后不再发');
    // 收尾：删掉这件事，后面的步骤不受影响
    assert.equal((await fetch(`${base}/api/users/${acct.id}/events/${made.id}`, { method: 'DELETE', headers: h })).status, 204);
  });

  await step('条款改版：同意的是旧版本的账号再打开时先弹出重新同意，同意后才进入；服务器记下新版本', async () => {
    // 服务器上的版本改不了，这里把读取账号的返回改成“同意的是旧版本”，对话框和之后的请求都是真的
    const me = '**/api/users/' + acct.id; let faked = 0;
    await p.route(me, async (r) => {
      if (r.request().method() !== 'GET') return r.continue();
      const res = await r.fetch(); const j = await res.json(); j.consentVersion = '2020-01-01'; faked++;
      return r.fulfill({ response: res, json: j });
    });
    await p.reload();
    await p.waitForSelector('#reconsent-ok', { timeout: 5000 });
    assert.ok(faked >= 1);
    assert.match(await p.innerText('#reconsent'), /条款有更新/); assert.match(await p.innerText('#reconsent'), /主要变化/);
    assert.equal(await p.evaluate(() => window.ZAIRYU_API === true), false, '重新同意之前不进入');
    assert.equal(await p.isVisible('#reconsent-del'), true, '不同意的人可以直接删除账号');
    await p.screenshot({ path: '/tmp/e2e-reconsent.png' });
    await p.unroute(me);
    let posted = null;
    p.on('request', (q) => { if (q.method() === 'POST' && /\/consent$/.test(q.url())) posted = q.postDataJSON(); });
    await p.click('#reconsent-ok');
    await apiReady(p);
    assert.equal(await p.isVisible('#reconsent'), false);
    const terms = await json('/api/terms');
    assert.deepEqual(posted, { accept: terms.version }, '同意时带的是当前版本');
    assert.equal((await get()).consentVersion, terms.version);
    assert.ok(await p.evaluate(() => localStorage.getItem('zairyu-account')), '账号还在');
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

  await step('更换邮箱：先输入发到原来邮箱的验证码，再输入发到新邮箱的验证码（两个都从发件箱读）；原来的邮箱收到告知；解除也要原来邮箱的验证码', async () => {
    // 新开一个“设备”建一个新账号（注册时的设备没有 24 小时的冷静期）
    const ctx6 = await b.newContext({ viewport: { width: 390, height: 844 } }); const p6 = await ctx6.newPage(); p6.on('pageerror', (e) => errs.push(e.message));
    const d6 = []; p6.on('dialog', (d) => { d6.push(d.message()); return d.accept(); });
    await p6.goto(base + '/'); await p6.waitForSelector('#consent-ok', { timeout: 5000 }); await p6.click('#consent-ok'); await apiReady(p6);
    const a6 = await p6.evaluate(() => JSON.parse(localStorage.getItem('zairyu-account')));
    const h6 = { authorization: 'Bearer ' + a6.token };
    const OLD = 'e2e.change.old@example.com', NEW = 'e2e.change.new@example.com';
    await p6.evaluate(() => { location.hash = '#route'; }); await p6.evaluate(() => { document.getElementById('prof').open = true; });
    await p6.waitForSelector('#em-addr', { timeout: 5000 });
    await p6.fill('#em-addr', OLD); await p6.check('#em-ok'); await p6.click('#em-send');
    await p6.waitForSelector('#em-code', { timeout: 5000 });
    const first = await mailCode(OLD);
    await p6.fill('#em-code', first.code); await p6.click('#em-verify');
    await p6.waitForFunction(() => /已绑定邮箱：e\*\*\*@example\.com/.test(document.getElementById('em-state').textContent), null, { timeout: 5000 });
    // 绑着邮箱时没有直接填新邮箱的输入框；有“更换邮箱”“解除绑定”和原邮箱收不到信时的说明
    assert.equal(await p6.isVisible('#em-addr'), false, '没验证原来的邮箱之前不能填新邮箱');
    assert.match(await p6.innerText('#em-lost'), /没有别的办法绕过/);
    await p6.click('#em-change');
    await p6.waitForSelector('#em-old-code', { timeout: 5000 });
    assert.match(await p6.innerText('#em-msg'), /验证码已经发到现在绑定的邮箱（e\*\*\*@example\.com）/);
    const oldMail = await mailCode(OLD, [first.id]);
    // 填错：说明原因，还停在这一步
    await p6.fill('#em-old-code', oldMail.code === '000000' ? '111111' : '000000'); await p6.click('#em-old-verify');
    await p6.waitForFunction(() => /验证码没有通过：验证码不对或已过期/.test(document.getElementById('em-msg').textContent), null, { timeout: 5000 });
    assert.equal(await p6.isVisible('#em-addr'), false);
    await p6.fill('#em-old-code', oldMail.code); await p6.click('#em-old-verify');
    await p6.waitForSelector('#em-addr', { timeout: 5000 });
    assert.match(await p6.innerText('#em-msg'), /原来的邮箱已确认/);
    await p6.fill('#em-addr', NEW); await p6.check('#em-ok'); await p6.click('#em-send');
    await p6.waitForSelector('#em-code', { timeout: 5000 });
    const newMail = await mailCode(NEW);
    await p6.fill('#em-code', newMail.code); await p6.click('#em-verify');
    await p6.waitForFunction(() => /邮箱已更换/.test(document.getElementById('em-msg').textContent), null, { timeout: 5000 });
    assert.deepEqual(await json(`/api/users/${a6.id}/email`, { headers: h6 }), { email: 'e***@example.com', verified: true, remindOptIn: false });
    // 原来的邮箱收到“已经更换”的告知（发出后记录里不留地址）
    const t0 = Date.now(); let bye = [];
    while (Date.now() - t0 < 5000 && !bye.length) { bye = (await json('/api/admin/outbox', { headers: adm })).filter((r) => r.kind === 'last' && /已经更换/.test(r.subject) && r.status === 'sent'); if (!bye.length) await p6.waitForTimeout(100); }
    assert.equal(bye.length, 1, '原来的邮箱应当收到告知'); assert.equal(bye[0].to, '', '告知发出后不留地址');
    await p6.screenshot({ path: '/tmp/e2e-change-email.png', fullPage: true });
    // 解除：先确认，再输入发到现在这个邮箱（NEW）的验证码
    await p6.click('#em-remove');
    await p6.waitForSelector('#em-old-code', { timeout: 5000 });
    assert.equal(d6.length, 1); assert.match(d6[0], /解除之前要先输入发到这个邮箱的验证码/);
    const rmMail = await mailCode(NEW, [newMail.id]);
    await p6.fill('#em-old-code', rmMail.code); await p6.click('#em-old-verify');
    await p6.waitForFunction(() => /还没有绑定邮箱/.test(document.getElementById('em-state').textContent), null, { timeout: 5000 });
    assert.match(await p6.innerText('#em-msg'), /已解除绑定/);
    assert.deepEqual(await json(`/api/users/${a6.id}/email`, { headers: h6 }), { email: null, verified: false, remindOptIn: false });
    assert.ok(!(await p6.innerText('#acct-box')).includes('e2e.change'), '页面上不显示完整的邮箱');
    await ctx6.close();
  });

  await step('服务商入驻：申请页填写（验证码从发件箱读）→ 管理后台批准（要填核对方式）→ 工作台用联系邮箱领取令牌 → 30 天免费期，领取后就展示 → 免费期之后的第一期账单开出了就标记已付款 → 用户发咨询 → 通知邮件里没有咨询内容 → 工作台回复 → 关掉通知 → 下架后 401', async () => {
    const PE = 'e2e.office@example.jp', PNAME = '端到端中文行政书士事务所<b>不是标签</b>', SUM = '想咨询经营管理签证的更新，公司第二年。';
    const reviewer = { authorization: 'Bearer ' + REVIEWER, 'content-type': 'application/json' };
    const code = async (to, after) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        const rows = (await json('/api/admin/outbox?to=' + encodeURIComponent(to), { headers: reviewer })).filter((r) => r.kind === 'code' && !(after || []).includes(r.id));
        if (rows.length) { const r = rows[rows.length - 1]; return { id: r.id, code: /验证码：(\d{6})/.exec(r.body)[1] }; }
        await p.waitForTimeout(100);
      }
      throw new Error('发件箱里没有发给 ' + to + ' 的验证码邮件');
    };
    const page = async (path) => { const x = await ctx.newPage(); x.on('pageerror', (e) => errs.push(e.message)); x.on('dialog', (d) => d.accept()); await x.goto(base + path); return x; };
    // 1. 申请页：验证码从发件箱读；没勾条款、收费说明里有保证类用语都被拦下并显示服务器的说明
    const pa = await page('/provider-apply.html');
    await pa.waitForFunction(() => document.querySelectorAll('#ap-cat option').length > 3, null, { timeout: 5000 });
    await pa.fill('#ap-email', PE); await pa.click('#ap-send');
    await pa.waitForFunction(() => /已发出/.test(document.getElementById('ap-send-msg').textContent), null, { timeout: 5000 });
    const c1 = await code(PE);
    await pa.fill('#ap-code', c1.code); await pa.selectOption('#ap-cat', 'gyosei');
    assert.equal(await pa.isVisible('#ap-body'), true, '士业要填所属会');
    await pa.fill('#ap-name', PNAME); await pa.fill('#ap-address', '大阪府大阪市中央区本町1-1-1'); await pa.fill('#ap-lic', '第１２３４５６７８号'); await pa.fill('#ap-body', '大阪府行政書士会');
    await pa.fill('#ap-fee', '首次咨询30分钟5,500日元，包过'); await pa.fill('#ap-area', '大阪'); await pa.fill('#ap-langs', '中文、日语');
    await pa.click('#ap-submit'); assert.match(await pa.innerText('#ap-msg'), /同意服务商条款/);
    await pa.check('#ap-agree'); await pa.click('#ap-submit');
    await pa.waitForFunction(() => /保证类/.test(document.getElementById('ap-msg').textContent), null, { timeout: 5000 });
    await pa.fill('#ap-fee', '首次咨询30分钟5,500日元'); await pa.click('#ap-submit');
    await pa.waitForSelector('#ap-done:not([hidden])', { timeout: 5000 });
    const ref = await pa.evaluate(() => document.getElementById('ap-done').dataset.ref);
    assert.match(ref, /^A[0-9A-Z]{7}$/); assert.match(await pa.innerText('#ap-done'), new RegExp(ref));
    await pa.screenshot({ path: '/tmp/e2e-provider-apply.png', fullPage: true }); await pa.close();
    // 2. 管理后台：不选核对方式批准不了；选了才批准，记下核对人
    const pad = await page('/admin.html');
    await pad.fill('#adm-token', REVIEWER); await pad.click('#adm-go');
    const card = pad.locator('#apps .card', { hasText: ref });
    await card.waitFor({ timeout: 5000 });
    assert.equal(await pad.locator('#apps b').evaluateAll((l) => l.filter((x) => x.textContent === '不是标签').length), 0, '名称里的标签不应当被当成 HTML');
    assert.match(await card.innerText(), /e\*\*\*@example\.jp/, '管理员看到的邮箱是打码的');
    await card.locator('button.approve').click();
    await pad.waitForFunction((r) => /核对/.test(document.querySelector('#apps .card[data-ref="' + r + '"] [role=status]').textContent), ref, { timeout: 5000 });
    await card.locator('select.chk-method').selectOption('association_search'); await card.locator('input.chk-note').fill('会员检索一致');
    await card.locator('button.approve').click();
    await pad.waitForFunction((r) => !document.querySelector('#apps .card[data-ref="' + r + '"]'), ref, { timeout: 5000 });
    const app = (await json('/api/admin/applications?status=approved', { headers: reviewer })).find((x) => x.ref === ref);
    assert.equal(app.licenseCheck.checkedBy, 'e2e', '核对人是用哪个管理员令牌批准的');
    // 3. 工作台：用联系邮箱领取令牌（验证码从发件箱读），令牌只显示一次；批准邮件里没有令牌
    const pw = await page('/provider.html');
    await pw.click('#claim-box summary'); await pw.fill('#cl-email', PE); await pw.click('#cl-send');
    await pw.waitForFunction(() => /验证码已经发出/.test(document.getElementById('cl-send-msg').textContent), null, { timeout: 5000 });
    const c2 = await code(PE, [c1.id]);
    await pw.fill('#cl-code', c2.code); await pw.click('#cl-go');
    await pw.waitForSelector('#cl-out:not([hidden])', { timeout: 5000 });
    const ptok = await pw.innerText('#cl-token');
    assert.ok(ptok.length >= 40, '应当显示新令牌');
    const pmails = await json('/api/admin/outbox?to=' + encodeURIComponent(PE), { headers: reviewer });
    assert.ok(pmails.some((m) => /已批准/.test(m.subject)), '应当有批准邮件'); assert.ok(pmails.every((m) => !m.body.includes(ptok)), '任何邮件里都没有令牌');
    await pw.click('#cl-use');
    await pw.waitForSelector('#listing', { timeout: 5000 });
    assert.match(await pw.innerText('#listing'), /名单上展示中/, '免费期：领取令牌后就展示');
    assert.match(await pw.innerText('#free-until'), /免费期到 \d{4}-\d{2}-\d{2}（批准日 \+ 30 天，日本时间）。之后的第一张账单从 \d{4}-\d{2}-\d{2} 起收费，(收到那个月底，按天折算|是整月)，在那天之前 14 天开出/, '工作台写着免费期到哪天、第一期从哪天起');
    {
      // 整月还是按天折算，要和第一期开始的那天是不是 1 日一致
      const ft = await pw.innerText('#free-until'), fs = /从 (\d{4}-\d{2}-(\d{2})) 起收费/.exec(ft);
      assert.equal(/按天折算/.test(ft), fs[2] !== '01', ft);
    }
    await pw.waitForFunction(() => /展示费账单/.test(document.getElementById('billing').innerText), null, { timeout: 5000 });
    assert.match(await pw.innerText('#billing'), /还没有账单。之后的第一张账单从 \d{4}-\d{2}-\d{2} 起收费/, '免费期的记录不是账单，不列出');
    assert.ok(pmails.some((m) => /已批准/.test(m.subject) && /批准后 30 天免费/.test(m.body) && /第一张账单是/.test(m.body) && !/参考编号/.test(m.body)), '批准邮件里写 30 天免费期和第一期，没有账单');
    // 4. 首页名单上已经有这家（不用先付款）
    const pid = app.providerId;
    assert.ok((await json('/api/providers?category=gyosei')).some((x) => x.id === pid), '领取令牌后就在名单上');
    // 5. 跑一轮展示费：刚批准时还在免费期里，第一期的账单要在免费期结束前 14 天才开（端到端用真实时钟，所以这里一般没有账单；开出了就在管理后台标记已付款）
    await json('/api/admin/billing/run', { method: 'POST', headers: reviewer });
    const next = (await json('/api/admin/invoices?status=issued', { headers: reviewer })).filter((i) => i.providerId === pid);
    if (next.length) {
      await pw.evaluate(() => loadInvoices()); await pw.waitForFunction(() => /待付款/.test(document.getElementById('billing').innerText), null, { timeout: 5000 });
      assert.match(await pw.innerText('#billing'), /ZN\d{4}-/);
      await pad.click('#tab-invoices');
      const icard = pad.locator('#invoices .card', { hasText: PNAME });
      await icard.waitFor({ timeout: 5000 }); await icard.locator('button.mark-paid').click();
      await pad.waitForFunction((n) => ![...document.querySelectorAll('#invoices .card')].some((c) => c.textContent.includes(n)), PNAME, { timeout: 5000 });
    }
    // 6. 用户（新设备）在首页看到这家：名单上方写着展示费；所属会和事务所地址
    const cu = await b.newContext({ viewport: { width: 390, height: 844 } }); const pu = await cu.newPage(); pu.on('pageerror', (e) => errs.push(e.message));
    await pu.goto(base + '/'); await pu.waitForSelector('#consent-ok', { timeout: 5000 }); await pu.click('#consent-ok'); await apiReady(pu);
    await pu.evaluate(() => { location.hash = '#providers'; }); await pu.selectOption('#pv-cat', 'zeirishi'); await pu.selectOption('#pv-cat', 'gyosei');
    const pcard = pu.locator('#pv-list .card', { hasText: '端到端中文行政书士事务所' });
    await pcard.waitFor({ timeout: 5000 });
    assert.equal(await pu.isVisible('#pv-fee'), true); assert.match(await pu.innerText('#pv-fee'), /支付固定的展示费；士业不按成交或咨询数付费；排列按入驻先后/);
    const ptext = await pcard.innerText();
    assert.match(ptext, /所属会：大阪府行政書士会/); assert.match(ptext, /事务所地址：大阪府大阪市中央区本町1-1-1/); assert.match(ptext, /登录番号 12345678/);
    assert.equal(await pcard.locator('b b').count(), 0, '名称里的标签不应当被当成 HTML');
    assert.ok(!ptext.includes('@'), '联系邮箱不公开');
    // 7. 用户发咨询
    await pcard.locator('input[type=checkbox]').check(); await pu.fill('#pv-msg', SUM); await pu.check('#pv-ok'); await pu.click('#pv-send');
    await pu.waitForFunction(() => document.getElementById('inq-list').innerText.includes('端到端中文行政书士事务所'), null, { timeout: 5000 });
    // 8. 跑一轮：联系邮箱收到新咨询通知，里面没有咨询内容
    const run = await json('/api/admin/billing/run', { method: 'POST', headers: reviewer });
    assert.equal(run.notices, 1, '跑一轮应当排一封新咨询通知：' + JSON.stringify(run));
    const note = (await json('/api/admin/outbox?to=' + encodeURIComponent(PE), { headers: reviewer })).filter((m) => m.kind === 'pnotice');
    assert.equal(note.length, 1); assert.match(note[0].subject, /有 1 条新咨询/); assert.match(note[0].body, /类别：行政书士/);
    const uacct = await pu.evaluate(() => JSON.parse(localStorage.getItem('zairyu-account')));
    for (const bad of [SUM, '经营管理', uacct.id]) assert.ok(!note[0].body.includes(bad), '通知邮件里不应当有：' + bad);
    // 9. 工作台回复
    await pw.evaluate(() => load()); await pw.waitForSelector('#list textarea', { timeout: 5000 });
    assert.match(await pw.innerText('#list'), /经营管理签证的更新/);
    await pw.locator('#list textarea').first().fill('可以办理。请准备决算书和纳税证明，报酬8万日元起。');
    await pw.locator('#list .card').first().locator('button', { hasText: '发送回复' }).click();
    await pw.waitForFunction(() => document.getElementById('list').innerText.includes('你的回复'), null, { timeout: 5000 });
    await pu.reload(); await apiReady(pu); await pu.evaluate(() => { location.hash = '#providers'; });
    await pu.waitForFunction(() => document.getElementById('inq-list').innerText.includes('报酬8万日元起'), null, { timeout: 5000 });
    // 10. 关掉新咨询通知
    await pw.reload(); await pw.fill('#tok', ptok); await pw.click('#go'); await pw.waitForSelector('#notify', { timeout: 5000 });
    assert.equal(await pw.isChecked('#notify'), true);
    await pw.uncheck('#notify'); await pw.waitForTimeout(400);
    assert.equal((await json('/api/provider/me', { headers: { authorization: 'Bearer ' + ptok } })).notify, false);
    await pw.screenshot({ path: '/tmp/e2e-provider-onboard.png', fullPage: true });
    // 11. 管理后台下架：工作台马上 401
    await pad.click('#tab-providers');
    const prow = pad.locator('#providers .card', { hasText: '端到端中文行政书士事务所' });
    await prow.waitFor({ timeout: 5000 }); await prow.locator('button.deactivate').click();
    await pad.waitForFunction(() => /已下架/.test(document.getElementById('providers').innerText), null, { timeout: 5000 });
    await pw.evaluate(() => load());
    await pw.waitForFunction(() => /令牌不对/.test(document.getElementById('list-msg').textContent), null, { timeout: 5000 });
    assert.ok(!(await json('/api/providers?category=gyosei')).some((x) => x.id === pid), '下架后不在名单上');
    await pad.screenshot({ path: '/tmp/e2e-admin.png', fullPage: true });
    await pad.close(); await pw.close(); await cu.close();
  });

  await step('页面没有脚本错误', async () => { assert.deepEqual(errs, [], '页面不应有脚本错误'); });
  await b.close();
  if (failed.length) { console.error('端到端失败 ' + failed.length + ' 步：\n- ' + failed.join('\n- ')); process.exit(1); }
  console.log('端到端通过' + (plan ? '，下一步任务：' + plan.next.id + ' ' + plan.next.title : ''));
})().catch((e) => { console.error('端到端失败：', e.message); process.exit(1); });
