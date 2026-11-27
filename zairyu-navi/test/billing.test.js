// 展示费：价目表、金额不随咨询数变、参考编号、首月免费（领取令牌后展示，下个月起收费）、付款提醒、过了宽限期自动不展示、提前开下一期、日本时间的月界、作废、收款方式可替换、启动检查。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { start } = require('./provider-helpers');
const { billingConfig, createBilling } = require('../src/billing');
const { createStore } = require('../src/store');

const MOBILE = { category: 'mobile', licenseNo: '', licenseBody: '', name: '大阪中文电话卡', feeNote: '月费 2,980 日元起' };
// 日本时间某一天的中午
const noon = (ymd) => ymd + 'T03:00:00Z';

test('BILLING_PLANS 等设置：写错时报错；真实发信时价目表和振込先必须填', () => {
  const real = { name: 'http', dev: false };
  for (const bad of ['{', '[]', '{"regulated":11000}', '{"regulated":-1,"other":1}', '{"regulated":1.5,"other":1}', '{"regulated":1,"other":1,"foo":1}', '{"regulated":1,"other":2000000}']) assert.throws(() => billingConfig({ BILLING_PLANS: bad }), /BILLING_PLANS/, bad);
  assert.deepEqual(billingConfig({ BILLING_PLANS: '{"regulated":22000,"other":0,"estate":8800}' }).plans, { regulated: 22000, other: 0, estate: 8800 });
  assert.throws(() => billingConfig({}, real), /BILLING_PLANS/);
  assert.throws(() => billingConfig({ BILLING_PLANS: '{"regulated":1,"other":1}' }, real), /BILLING_BANK_TEXT/);
  assert.ok(billingConfig({ BILLING_PLANS: '{"regulated":1,"other":1}', BILLING_BANK_TEXT: '某银行 某支店' }, real));
  assert.throws(() => billingConfig({ BILLING_INVOICE_REG_NO: 'T123' }), /BILLING_INVOICE_REG_NO/);
  assert.throws(() => billingConfig({ BILLING_PERIOD: 'year' }), /BILLING_PERIOD/);
  assert.throws(() => billingConfig({ BILLING_GRACE_DAYS: '-1' }), /BILLING_GRACE_DAYS/);
  const c = billingConfig({});
  assert.deepEqual([c.issueDays, c.firstDueDays, c.graceDays, c.period], [14, 14, 7, 'month']);
  assert.notEqual(billingConfig({ BILLING_PLANS: '{"regulated":1,"other":1}' }).planVersion, c.planVersion, '价目表变了版本也变');
});

test('金额只按类别从价目表取：0 条咨询和 50 条咨询的账单金额一样；参考编号的格式对、不重复；带 amount 字段 422', async () => {
  const s = await start({ notify: { delayMin: 0, intervalMin: 60 } });
  try {
    const a = await s.onboard('a@example.jp'), b = await s.onboard('b@example.jp'), m = await s.onboard('m@example.jp', MOBILE);
    const u = await s.newUser();
    for (let i = 0; i < 50; i++) s.app.store.addInquiry(u.id, { providerId: a.providerId, category: 'gyosei', summary: '第' + i + '条咨询的内容。' });
    s.app.billing.runOnce();
    const next = (pid) => s.app.store.invoiceFor(pid, '2026-12');
    assert.ok(next(a.providerId) && next(b.providerId), '下一期的账单已经开出（离 12 月 1 日不到 14 天）');
    assert.equal(next(a.providerId).amountYen, next(b.providerId).amountYen, '咨询数不影响金额');
    assert.equal(next(a.providerId).amountYen, 11000); assert.equal(next(m.providerId).amountYen, 5500, '非士业一档');
    assert.equal(next(a.providerId).taxYen, 1000); assert.equal(next(a.providerId).plan, 'regulated');
    const refs = s.app.store.listInvoices().map((i) => i.refCode);
    for (const r of refs) assert.match(r, /^ZN26(11|12)-[2-9A-HJ-KMNP-Z]{6}$/);
    assert.equal(new Set(refs).size, refs.length, '参考编号不重复');
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + next(a.providerId).id + '/paid', { paidOn: '2026-11-27', amount: 1 })).status, 422);
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + next(a.providerId).id + '/paid', { paidOn: '2026-11-28' })).status, 422, '入账日不能晚于今天');
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + next(a.providerId).id + '/paid', { paidOn: '2026-11-27', note: '口座 1234567 入账' })).status, 422, '备注过敏感号码过滤');
  } finally { await s.stop(); }
});

test('首月免费：批准后领取令牌前不展示；领取后马上展示，不开账单；下个月的账单按普通规则开，付了延续；服务商只看到自己的账单和振込先', async () => {
  const s = await start({ billing: billingConfig({ BILLING_BANK_TEXT: '某银行 梅田支店' }) });
  try {
    const a = await s.apply('p@example.jp'); assert.equal(a.status, 201);
    const ap = await s.approve(a.body.ref);
    assert.equal(ap.status, 200); assert.deepEqual(ap.body, { providerId: ap.body.providerId, freeUntil: '2026-11-30' }, '返回里没有令牌，也没有账单');
    const pid = ap.body.providerId;
    // 批准当月：一条金额 0 的免费记录，没有要付钱的账单，也没有账单邮件
    const nov = s.app.store.listInvoices({ providerId: pid });
    assert.equal(nov.length, 1); assert.deepEqual([nov[0].period, nov[0].amountYen, nov[0].method, nov[0].status], ['2026-11', 0, 'first_month_free', 'paid']);
    const okMail = s.lastMail('p@example.jp');
    assert.match(okMail.subject, /已批准/); assert.match(okMail.body, /批准当月免费/); assert.match(okMail.body, /2026年11月30日/);
    assert.doesNotMatch(okMail.body, /参考编号|付款期限|振込|梅田支店/, '批准邮件里没有账单');
    assert.equal(s.mails('p@example.jp').filter((m) => m.kind === 'billing').length, 0);
    // 领取令牌之前看不到咨询：不展示、不能发咨询
    assert.ok(!(await s.listed()).some((x) => x.id === pid), '领取令牌之前不展示');
    const u = await s.newUser();
    assert.equal((await s.inquire(u, [pid])).status, 422);
    const c = await s.claim('p@example.jp'); assert.equal(c.status, 200);
    const token = c.body.token;
    // 领取后马上展示，展示到批准当月结束 + 宽限 7 天
    assert.ok((await s.listed()).some((x) => x.id === pid), '领取后马上展示');
    assert.equal((await s.inquire(u, [pid])).status, 201);
    let me = (await s.call('GET', '/api/provider/me', null, token)).body;
    assert.equal(me.listed, true); assert.equal(me.listedUntil, '2026-12-07');
    assert.deepEqual((await s.call('GET', '/api/provider/invoices', null, token)).body, [], '免费记录不是账单，工作台不列出');
    // 下个月（12 月）的账单：离 12 月 1 日不到 14 天，跑一轮就开；离 11 月 30 日不到 7 天，期限是开出后 14 天
    s.app.billing.runOnce();
    const dec = s.app.store.invoiceFor(pid, '2026-12');
    assert.ok(dec); assert.equal(dec.amountYen, 11000); assert.equal(dec.dueDate, '2026-12-11'); assert.equal(dec.status, 'issued');
    assert.equal(s.mails('p@example.jp').filter((m) => m.kind === 'billing').length, 1, '下个月的账单邮件');
    const mine = (await s.call('GET', '/api/provider/invoices', null, token)).body;
    assert.equal(mine.length, 1); assert.equal(mine[0].period, '2026-12'); assert.match(mine[0].payText, /梅田支店/); assert.match(mine[0].payText, new RegExp(mine[0].refCode));
    assert.ok(!('paidNote' in mine[0]) && !('paidBy' in mine[0]));
    me = (await s.call('GET', '/api/provider/me', null, token)).body;
    assert.equal(me.listedUntil, '2026-12-18', '没付的下一期：期限 + 宽限天数之前照常展示');
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + nov[0].id + '/paid', { paidOn: '2026-11-27' })).status, 409, '免费记录不用付款');
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + dec.id + '/paid', { paidOn: '2026-11-27', note: '已入账' })).status, 200);
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + dec.id + '/paid', { paidOn: '2026-11-27' })).status, 409, '不能标记两次');
    me = (await s.call('GET', '/api/provider/me', null, token)).body;
    assert.equal(me.listedUntil, '2027-01-07', '付了 12 月：12 月结束 + 宽限 7 天');
    const q = await s.onboard('q@example.jp');
    const list = await s.listed();
    assert.ok(list.some((x) => x.id === pid)); assert.ok(list.some((x) => x.id === q.providerId), '另一家同样首月免费');
    const pub = list.find((x) => x.id === pid);
    assert.equal(pub.licenseBody, '大阪府行政書士会'); assert.equal(pub.address, '大阪府大阪市北区梅田1-2-3'); assert.ok(!JSON.stringify(pub).includes('@'), '联系邮箱不公开');
    assert.deepEqual((await s.call('GET', '/api/provider/invoices', null, q.token)).body, [], '只看到自己的');
    const adm = (await s.adm('GET', '/api/admin/providers')).body.find((x) => x.id === pid);
    assert.equal(adm.listed, true); assert.equal(adm.latestInvoice.status, 'paid'); assert.equal(adm.contact, 'p***@example.jp');
  } finally { await s.stop(); }
});

test('首月免费到月底：月末最后一天批准，免费只到当天；下个月的账单期限是开出后 14 天；不付就在期限 + 宽限天数之后下架', async () => {
  const s = await start({}, noon('2026-11-30'));
  try {
    const p = await s.onboard('e@example.jp', MOBILE);
    assert.equal(p.freeUntil, '2026-11-30');
    s.app.billing.runOnce();
    const dec = s.app.store.invoiceFor(p.providerId, '2026-12');
    assert.equal(dec.dueDate, '2026-12-14'); assert.equal(dec.amountYen, 5500);
    s.set(noon('2026-12-21')); assert.ok((await s.listed('mobile')).some((x) => x.id === p.providerId), '期限 12 月 14 日 + 7 天仍展示');
    s.set(noon('2026-12-22')); s.app.billing.runOnce(); await s.app.deliver();
    assert.ok(!(await s.listed('mobile')).some((x) => x.id === p.providerId), '过了宽限期不展示');
    assert.match(s.lastMail('e@example.jp').subject, /暂时不在名单上展示/, '展示过（首月免费）的告知一次');
  } finally { await s.stop(); }
});

test('月底批准：批准邮件写明下个月的账单可能在本月内开出（不说“也不开账单”）；当天跑一轮就开出 12 月的账单', async () => {
  const s = await start({}, noon('2026-11-27'));
  try {
    const p = await s.onboard('late@example.jp', MOBILE);
    const ok = s.mails('late@example.jp').find((m) => /已批准/.test(m.subject));
    assert.doesNotMatch(ok.body, /也不开账单/, '下个月的账单会在本月内开出，不能说“不开账单”');
    assert.match(ok.body, /批准当月（到 2026年11月30日 为止）不收展示费/);
    assert.match(ok.body, /下个月开始前 14 天开出/); assert.match(ok.body, /最早会在本月内/);
    s.app.billing.runOnce();
    assert.equal(s.app.store.invoiceFor(p.providerId, '2026-12').dueDate, '2026-12-11', '和邮件说的一致：当天就开出下个月的账单');
  } finally { await s.stop(); }
});

test('没领取令牌的服务商不开账单、不发付款提醒、不发“不再展示”；领取后才按普通规则开账单（首月免费仍按批准当月算）', async () => {
  const s = await start({}, noon('2026-11-27'));
  try {
    const a = await s.apply('nc@example.jp', MOBILE); assert.equal(a.status, 201);
    const ap = await s.approve(a.body.ref, null); assert.equal(ap.status, 200);
    const pid = ap.body.providerId, billingMails = () => s.mails('nc@example.jp').filter((m) => m.kind === 'billing');
    for (const ymd of ['2026-11-27', '2026-11-30', '2026-12-05', '2026-12-20', '2027-01-10']) { s.set(noon(ymd)); s.app.billing.runOnce(); await s.app.deliver(); }
    assert.deepEqual(s.app.store.listInvoices({ providerId: pid }).map((i) => i.method), ['first_month_free'], '只有首月免费的记录，没有要付钱的账单');
    assert.equal(billingMails().length, 0, '没有账单、提醒，也没有“暂时不在名单上展示”（从来没展示过）');
    // 1 月才领取：首月免费早已结束，领取后的一轮开 1 月的账单（期限从开出起 14 天）和 2 月以前的不补
    const c = await s.claim('nc@example.jp'); assert.equal(c.status, 200);
    s.app.billing.runOnce();
    const jan = s.app.store.invoiceFor(pid, '2027-01');
    assert.ok(jan); assert.equal(jan.dueDate, '2027-01-24'); assert.equal(s.app.store.invoiceFor(pid, '2026-12'), null, '没领取的月份不补开');
    assert.ok(!(await s.listed('mobile')).some((x) => x.id === pid), '首月免费已经过了：没付过的那一段不展示，付了才展示');
    // 不付：照常有账单和提醒，但过了宽限期不发“暂时不在名单上展示”（从来没展示过）
    for (const ymd of ['2027-01-17', '2027-01-25', '2027-02-01']) { s.set(noon(ymd)); s.app.billing.runOnce(); await s.app.deliver(); }
    const subj = billingMails().map((m) => m.subject);
    assert.ok(subj.some((x) => /展示费账单/.test(x)) && subj.some((x) => /付款提醒/.test(x)));
    assert.ok(!subj.some((x) => /暂时不在名单上展示/.test(x)), '没展示过的不告知“不再展示”');
  } finally { await s.stop(); }
});

test('付款提醒、提前开下一期、过了宽限期自动不展示：前 7 天、前 1 天、过期第二天各一次，跑两遍不重复', async () => {
  const s = await start({ billing: billingConfig({ BILLING_INVOICE_REG_NO: 'T1234567890123' }) }, noon('2026-11-02'));
  try {
    const p = await s.onboard('r@example.jp', MOBILE, true);
    const run = async (ymd) => { s.set(noon(ymd)); s.app.billing.runOnce(); s.app.billing.runOnce(); await s.app.deliver(); };
    const kinds = () => s.mails('r@example.jp').filter((m) => m.kind === 'billing').map((m) => m.subject + '|' + m.status);
    await run('2026-11-16');
    assert.equal(s.app.store.invoiceFor(p.providerId, '2026-12'), null, '提前 15 天还不开');
    await run('2026-11-17');
    const dec = s.app.store.invoiceFor(p.providerId, '2026-12');
    assert.ok(dec, '提前 14 天开下一期'); assert.equal(dec.dueDate, '2026-11-30', '期限是下一期开始的前一天');
    assert.match(s.lastMail('r@example.jp').body, /登记号：T1234567890123/); assert.match(s.lastMail('r@example.jp').body, /消费税（10%）：500 日元/);
    await run('2026-11-22'); assert.equal(kinds().length, 1, '还剩 8 天不提醒');
    await run('2026-11-23'); assert.equal(kinds().length, 2); assert.match(kinds()[1], /付款提醒/);
    assert.match(s.lastMail('r@example.jp').body, /还有 7 天/);
    await run('2026-11-28'); assert.equal(kinds().length, 2);
    await run('2026-11-29'); assert.equal(kinds().length, 3); assert.match(s.lastMail('r@example.jp').body, /明天是付款期限/);
    await run('2026-11-30'); assert.equal(kinds().length, 3, '当天不再发');
    await run('2026-12-01'); assert.equal(kinds().length, 4); assert.match(s.lastMail('r@example.jp').body, /已经过了付款期限/);
    // 宽限期内仍然展示，过了就不展示，并告知一次
    await run('2026-12-07');
    assert.ok((await s.listed('mobile')).some((x) => x.id === p.providerId), '12 月 7 日（本期结束 + 7 天）仍展示');
    await run('2026-12-08');
    assert.ok(!(await s.listed('mobile')).some((x) => x.id === p.providerId), '过了宽限期自动不展示');
    assert.match(s.lastMail('r@example.jp').subject, /暂时不在名单上展示/);
    await run('2026-12-09'); await run('2026-12-20');
    assert.equal(s.mails('r@example.jp').filter((m) => /暂时不在名单上/.test(m.subject)).length, 1, '只告知一次');
    assert.equal(s.app.store.invoiceFor(p.providerId, '2027-01'), null, '过了宽限期还没付的，先不开下一期');
    assert.ok(s.app.store.auditRows().some((r) => r.action === 'provider.hidden'));
    // 工作台照常能用
    assert.equal((await s.call('GET', '/api/provider/inquiries', null, p.token)).status, 200);
    // 补付后重新展示（12 月这一期）
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + dec.id + '/paid', { paidOn: '2026-12-20' })).status, 200);
    assert.ok((await s.listed('mobile')).some((x) => x.id === p.providerId));
    // 付了之后再跑：开下一期
    await run('2026-12-21');
    assert.ok(s.app.store.invoiceFor(p.providerId, '2027-01'));
  } finally { await s.stop(); }
});

test('已付款的账单不再提醒；提醒邮件在发出前账单付了就不发', async () => {
  const s = await start({}, noon('2026-11-02'));
  try {
    const p = await s.onboard('x@example.jp', MOBILE, true);
    s.set(noon('2026-11-23')); s.app.billing.runOnce();
    const dec = s.app.store.invoiceFor(p.providerId, '2026-12');
    const q = s.mails('x@example.jp').filter((m) => m.kind === 'billing' && m.status === 'queued');
    assert.equal(q.length, 2, '开票邮件和前 7 天的提醒');
    await s.adm('POST', '/api/admin/invoices/' + dec.id + '/paid', { paidOn: '2026-11-23' });
    await s.app.deliver();
    const ids = q.map((m) => m.id);
    assert.deepEqual(s.app.store.listOutbox().filter((m) => ids.includes(m.id)).map((m) => m.status), ['dropped', 'dropped'], '付了之后排队中的账单邮件不发');
    s.set(noon('2026-11-29')); s.app.billing.runOnce();
    assert.equal(s.mails('x@example.jp').filter((m) => m.kind === 'billing' && m.status === 'queued').length, 0);
  } finally { await s.stop(); }
});

test('日本时间的月界：UTC 15:00 前后批准的属于不同的月（免费到哪个月底）；展示到期日的最后一刻', async () => {
  const s = await start({}, '2026-11-30T14:59:00Z');
  try {
    const a = await s.onboard('a@example.jp', MOBILE);
    assert.equal(s.app.store.getInvoice(a.freeId).period, '2026-11', '日本时间 11 月 30 日 23:59'); assert.equal(a.freeUntil, '2026-11-30');
    s.set('2026-11-30T15:00:00Z');
    const b = await s.onboard('b@example.jp', MOBILE);
    assert.equal(s.app.store.getInvoice(b.freeId).period, '2026-12', '日本时间 12 月 1 日 0:00');
    assert.equal(b.freeUntil, '2026-12-31', '12 月 1 日批准：整个 12 月免费');
    // a 的首月（11 月）免费：没开下一期时展示到 12 月 7 日（日本时间）的最后一刻
    s.set('2026-12-07T14:59:00Z'); assert.ok((await s.listed('mobile')).some((x) => x.id === a.providerId));
    s.set('2026-12-07T15:00:00Z'); assert.ok(!(await s.listed('mobile')).some((x) => x.id === a.providerId));
    assert.ok((await s.listed('mobile')).some((x) => x.id === b.providerId));
  } finally { await s.stop(); }
});

test('作废：作废的账单不能再标记已付款；作废后重新开这一期', async () => {
  const s = await start();
  try {
    const p = await s.onboard('v@example.jp', MOBILE);
    s.app.billing.runOnce();
    const first = s.app.store.invoiceFor(p.providerId, '2026-12');
    const I = '/api/admin/invoices/' + first.id;
    assert.equal((await s.adm('POST', I + '/void', { reason: 'x' })).status, 422);
    const v = await s.adm('POST', I + '/void', { reason: '服务商要求撤回' });
    assert.equal(v.status, 200); assert.equal(v.body.status, 'void');
    assert.equal((await s.adm('POST', I + '/paid', { paidOn: '2026-11-27' })).status, 409);
    assert.equal((await s.adm('POST', I + '/void', { reason: '再作废一次' })).status, 409);
    s.app.billing.runOnce();
    const again = s.app.store.invoiceFor(p.providerId, '2026-12');
    assert.ok(again && again.id !== first.id && again.status === 'issued', '作废后重新开这一期');
    assert.deepEqual((await s.adm('GET', '/api/admin/invoices?status=void')).body.map((i) => i.id), [first.id]);
    assert.ok(JSON.parse(s.app.store.auditRows().find((r) => r.action === 'invoice.void').detail).by === 'alice');
    assert.ok(!JSON.stringify(s.app.store.auditRows()).includes('服务商要求撤回'), '理由不进留痕');
  } finally { await s.stop(); }
});

test('收款方式可以替换：假的在线支付方式给付款链接；回调接口现在是 404', async () => {
  const fake = { name: '测试支付', createCheckout: (inv) => ({ payUrl: 'https://pay.example.test/c/' + inv.refCode }), verifyWebhook: () => null };
  const s = await start({ billingMethods: { fake }, billingMethod: 'fake' });
  try {
    const p = await s.onboard('f@example.jp', MOBILE);
    assert.doesNotMatch(s.mails('f@example.jp').find((m) => /已批准/.test(m.subject)).body, /付款方式/, '批准当月免费，批准邮件里没有付款方式');
    s.app.billing.runOnce(); await s.app.deliver();
    const inv = s.app.store.invoiceFor(p.providerId, '2026-12');
    assert.equal(inv.method, 'fake');
    assert.match(s.app.billing.payText(inv), /https:\/\/pay\.example\.test\/c\/ZN/);
    assert.match(s.mails('f@example.jp').find((m) => m.kind === 'billing').body, /付款方式：测试支付/);
    assert.equal((await s.call('POST', '/api/billing/webhook/fake', { invoiceId: inv.id, paid: true })).status, 404);
    assert.equal(s.app.store.getInvoice(inv.id).status, 'issued');
  } finally { await s.stop(); }
  assert.throws(() => createBilling({ store: createStore(), method: 'nope' }), /没有这种收款方式/);
});

test('老服务商（这套机制之前就有的）：资料过了检查的补一张免费的当期账单、下一期照常收费；没过的不展示、不收费；收费方式按类别改正', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-bill-'));
  try {
    const f = path.join(dir, 'old.db');
    const old = new DatabaseSync(f);
    old.exec('CREATE TABLE providers (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, area TEXT, langs TEXT, fee_note TEXT, license_no TEXT, fee_model TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL)');
    const ins = old.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('legacy-ok', 'h1', '老电话卡店', 'mobile', '大阪', '中文', '月费 2,980 日元起', null, 'fixed_listing', 1, '2026-01-01T00:00:00Z'); // 非士业却存着 fixed_listing
    ins.run('legacy-g', 'h2', '老事务所', 'gyosei', null, null, null, ' x ', 'fixed_listing', 1, '2026-01-02T00:00:00Z'); // 登录番号不对、没有所属会
    ins.run('legacy-c', 'h3', '老学校', 'edu', '大阪', null, '合格保证', null, 'affiliate_disclosed', 1, '2026-01-03T00:00:00Z'); // 保证类用语
    old.close();
    let t = Date.parse(noon('2026-11-27'));
    const store = createStore(f, { clock: () => t });
    assert.equal(store.providerListing('legacy-ok').listed, false, '迁移之前');
    const b = createBilling({ store, clock: () => t, config: billingConfig({}) });
    const r = b.runOnce();
    assert.equal(r.migrated, 3);
    const inv = store.invoiceFor('legacy-ok', '2026-11');
    assert.equal(inv.method, 'migration'); assert.equal(inv.amountYen, 0); assert.equal(inv.status, 'paid');
    assert.equal(store.providerListing('legacy-ok').listed, true);
    assert.equal(store.getProvider('legacy-ok').feeModel, 'affiliate_disclosed', '非士业的收费方式按类别改正（名单上标含推广）');
    assert.equal(store.invoiceFor('legacy-ok', '2026-12').amountYen, 5500, '下一期照常收费');
    for (const id of ['legacy-g', 'legacy-c']) {
      assert.equal(store.providerMeta(id).source, 'legacy-hold', id);
      assert.equal(store.providerListing(id).listed, false, id + ' 不展示');
      assert.equal(store.listInvoices({ providerId: id }).length, 0, id + ' 不开账单');
    }
    assert.deepEqual(store.listProviders().map((p) => p.id), ['legacy-ok']);
    const rows = store.auditRows().filter((x) => x.action === 'provider.migrate').map((x) => JSON.parse(x.detail));
    assert.deepEqual(rows.find((x) => x.id === 'legacy-g').held, ['license']);
    assert.deepEqual(rows.find((x) => x.id === 'legacy-c').held, ['claims']);
    assert.ok(!JSON.stringify(rows).includes('合格保证'), '留痕里只有问题的代号');
    assert.equal(b.runOnce().migrated, 0, '只迁移一次');
    assert.equal(store.listInvoices({ providerId: 'legacy-g' }).length, 0, '下一轮也不给没过检查的开账单');
    store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('启动检查：真实发信而没有 BILLING_BANK_TEXT 时 npm start 不启动；npm run billing 跑一轮就退出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-bill-'));
  try {
    const env = Object.assign({}, process.env, { MAIL_SENDER: 'http', MAIL_FROM: 'a@example.jp', MAIL_HTTP_URL: 'http://127.0.0.1:9/x', MAIL_HTTP_KEY: 'k', APP_URL: 'https://navi.example.jp', BILLING_PLANS: '{"regulated":11000,"other":5500}', BILLING_BANK_TEXT: '', PORT: '0', DB_FILE: path.join(dir, 'a.db') });
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /BILLING_BANK_TEXT/);
    const ok = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'billing.js')], { env: Object.assign({}, process.env, { MAIL_SENDER: '', DB_FILE: path.join(dir, 'b.db') }), encoding: 'utf8', timeout: 20000 });
    assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /展示费：看了 0 家/);
    const bad = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'billing.js')], { env: Object.assign({}, process.env, { MAIL_SENDER: '', BILLING_PLANS: '{', DB_FILE: path.join(dir, 'c.db') }), encoding: 'utf8', timeout: 20000 });
    assert.equal(bad.status, 1); assert.match(bad.stderr, /BILLING_PLANS/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
