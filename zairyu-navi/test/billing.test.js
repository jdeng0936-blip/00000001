// 展示费：价目表、金额不随咨询数变、参考编号、30 天免费期（领取令牌后展示，之后第一期按天折算）、付款提醒、过了宽限期自动不展示、提前开下一期、日本时间的月界、作废、收款方式可替换、启动检查。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { start } = require('./provider-helpers');
const { billingConfig, createBilling, prorate, billStartOf, FREE_DAYS } = require('../src/billing');
const { createStore, addDays } = require('../src/store');

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

test('按天折算和开始收费的那天：月额 × 收费天数 ÷ 当月天数，舍去；整月原样；整期在免费期里返回 null；旧数据（免费到批准当月月底）下个月整月', () => {
  assert.equal(FREE_DAYS, 30);
  assert.equal(prorate(11000, '2026-12-01', '2026-12'), 11000, '从 1 日起是整月');
  assert.equal(prorate(11000, '2026-12-28', '2026-12'), 1419, '11000 × 4 ÷ 31 = 1419.35');
  assert.equal(prorate(5500, '2026-12-31', '2026-12'), 177);
  assert.equal(prorate(11000, '2027-02-05', '2027-02'), 9428, '平年 2 月 28 天');
  assert.equal(prorate(11000, '2028-02-05', '2028-02'), 9482, '闰年 2 月 29 天');
  assert.equal(prorate(0, '2026-12-28', '2026-12'), 0, '金额 0 的档');
  for (let d = 1; d <= 31; d++) assert.ok(prorate(11000, '2026-12-' + String(d).padStart(2, '0'), '2026-12') <= 11000, '不会超过月额');
  assert.equal(billStartOf('2026-12', '2026-12-27'), '2026-12-28');
  assert.equal(billStartOf('2027-01', '2026-12-27'), '2027-01-01', '免费期在上个月结束');
  assert.equal(billStartOf('2026-12', '2026-12-31'), null, '整个 12 月在免费期里');
  assert.equal(billStartOf('2027-02', '2027-03-02'), null, '免费期盖住整个 2 月');
  assert.equal(billStartOf('2026-12', null), '2026-12-01', '没有免费期（老服务商）');
  assert.equal(billStartOf('2026-12', '2026-11-30'), '2026-12-01', '旧数据：免费到批准当月月底，下个月整月');
  // 免费期过后才领取令牌：从领取那天起
  assert.equal(billStartOf('2026-12', '2026-12-27', '2026-12-29'), '2026-12-29', '领取在 D+31 之后、同一个月');
  assert.equal(billStartOf('2027-01', '2026-12-27', '2027-01-10'), '2027-01-10', '领取在下一个月');
  assert.equal(billStartOf('2026-12', '2026-12-27', '2027-01-10'), null, '整个 12 月都在领取之前');
  assert.equal(billStartOf('2027-02', '2026-12-27', '2027-01-10'), '2027-02-01', '领取之后的月份是整月');
  assert.equal(billStartOf('2026-12', '2026-12-27', '2026-12-05'), '2026-12-28', '免费期里领取：仍从 D+31 起');
});

test('金额只按类别从价目表取：0 条咨询和 50 条咨询的账单金额一样；参考编号的格式对、不重复；带 amount 字段 422', async () => {
  const s = await start({ notify: { delayMin: 0, intervalMin: 60 } });
  try {
    const a = await s.onboard('a@example.jp'), b = await s.onboard('b@example.jp'), m = await s.onboard('m@example.jp', MOBILE);
    const u = await s.newUser();
    for (let i = 0; i < 50; i++) s.app.store.addInquiry(u.id, { providerId: a.providerId, category: 'gyosei', summary: '第' + i + '条咨询的内容。' });
    // 11 月 27 日批准：免费期到 12 月 27 日；12 月 18 日时 12 月（按天折算）和 1 月（整月）的账单都已开出
    s.runAt('2026-12-18');
    const inv = (pid, period) => s.app.store.invoiceFor(pid, period);
    assert.ok(inv(a.providerId, '2027-01') && inv(b.providerId, '2027-01'), '下一期的账单已经开出（离 1 月 1 日不到 14 天）');
    assert.equal(inv(a.providerId, '2027-01').amountYen, inv(b.providerId, '2027-01').amountYen, '咨询数不影响金额');
    assert.equal(inv(a.providerId, '2026-12').amountYen, inv(b.providerId, '2026-12').amountYen, '按天折算的第一期也一样');
    assert.equal(inv(a.providerId, '2027-01').amountYen, 11000); assert.equal(inv(m.providerId, '2027-01').amountYen, 5500, '非士业一档');
    assert.equal(inv(a.providerId, '2027-01').taxYen, 1000); assert.equal(inv(a.providerId, '2027-01').plan, 'regulated');
    const refs = s.app.store.listInvoices().map((i) => i.refCode);
    for (const r of refs) assert.match(r, /^ZN(2611|2612|2701)-[2-9A-HJ-KMNP-Z]{6}$/);
    assert.equal(new Set(refs).size, refs.length, '参考编号不重复');
    const I = '/api/admin/invoices/' + inv(a.providerId, '2027-01').id + '/paid';
    assert.equal((await s.adm('POST', I, { paidOn: '2026-12-18', amount: 1 })).status, 422);
    assert.equal((await s.adm('POST', I, { paidOn: '2026-12-19' })).status, 422, '入账日不能晚于今天');
    assert.equal((await s.adm('POST', I, { paidOn: '2026-12-18', note: '口座 1234567 入账' })).status, 422, '备注过敏感号码过滤');
  } finally { await s.stop(); }
});

test('30 天免费期：批准后领取令牌前不展示；领取后马上展示，到批准日 + 30 天不开账单；第一期从第二天起按天折算，提前 14 天开出、期限是免费期最后一天；付了延续；服务商只看到自己的账单和振込先', async () => {
  const s = await start({ billing: billingConfig({ BILLING_BANK_TEXT: '某银行 梅田支店' }) });
  try {
    const a = await s.apply('p@example.jp'); assert.equal(a.status, 201);
    const ap = await s.approve(a.body.ref);
    assert.equal(ap.status, 200); assert.deepEqual(ap.body, { providerId: ap.body.providerId, freeUntil: '2026-12-27' }, '返回里没有令牌，也没有账单；免费到批准日 + 30 天');
    const pid = ap.body.providerId;
    // 批准时：一条金额 0 的免费期记录（批准日到批准日 + 30 天），没有要付钱的账单，也没有账单邮件
    const free = s.app.store.listInvoices({ providerId: pid });
    assert.equal(free.length, 1);
    assert.deepEqual([free[0].period, free[0].periodStart, free[0].periodEnd, free[0].amountYen, free[0].method, free[0].status], ['2026-11', '2026-11-27', '2026-12-27', 0, 'first_month_free', 'paid']);
    const okMail = s.lastMail('p@example.jp');
    assert.match(okMail.subject, /已批准/); assert.match(okMail.body, /批准后 30 天免费/); assert.match(okMail.body, /到 2026年12月27日 为止不收展示费/);
    assert.match(okMail.body, /第一张账单是 2026年12月28日 至 2026年12月31日 的展示费，不是整月，按天折算/);
    assert.match(okMail.body, /按现在的价目表是 1,419 日元，月额 11,000 日元/); assert.match(okMail.body, /2026年12月14日 前后开出/); assert.match(okMail.body, /付款期限是 2026年12月27日（免费期的最后一天）/);
    assert.doesNotMatch(okMail.body, /参考编号|振込|梅田支店|批准当月/, '批准邮件里没有账单，也不再说批准当月免费');
    assert.equal(s.mails('p@example.jp').filter((m) => m.kind === 'billing').length, 0);
    // 领取令牌之前看不到咨询：不展示、不能发咨询
    assert.ok(!(await s.listed()).some((x) => x.id === pid), '领取令牌之前不展示');
    const u = await s.newUser();
    assert.equal((await s.inquire(u, [pid])).status, 422);
    const c = await s.claim('p@example.jp'); assert.equal(c.status, 200);
    const token = c.body.token;
    // 领取后马上展示，免费期本身展示到批准日 + 30 天（不加宽限）
    assert.ok((await s.listed()).some((x) => x.id === pid), '领取后马上展示');
    assert.equal((await s.inquire(u, [pid])).status, 201);
    let me = (await s.call('GET', '/api/provider/me', null, token)).body;
    assert.equal(me.listed, true); assert.equal(me.listedUntil, '2026-12-27'); assert.equal(me.freeUntil, '2026-12-27');
    assert.deepEqual((await s.call('GET', '/api/provider/invoices', null, token)).body, [], '免费期的记录不是账单，工作台不列出');
    // 免费期里不开账单：12 月这一期从 12 月 28 日起收费，12 月 14 日（提前 14 天）才开
    s.app.billing.runOnce();
    s.runAt('2026-12-13');
    assert.equal(s.app.store.invoiceFor(pid, '2026-12'), null, '离开始收费还有 15 天，不开');
    s.runAt('2026-12-14');
    const dec = s.app.store.invoiceFor(pid, '2026-12');
    assert.ok(dec); assert.deepEqual([dec.periodStart, dec.periodEnd, dec.amountYen, dec.taxYen, dec.dueDate, dec.status], ['2026-12-28', '2026-12-31', 1419, 129, '2026-12-27', 'issued'], '11000 × 4 ÷ 31 = 1419.35，舍去');
    assert.equal(s.mails('p@example.jp').filter((m) => m.kind === 'billing').length, 1, '第一期的账单邮件');
    assert.match(s.mails('p@example.jp').find((m) => m.kind === 'billing').body, /期间：2026年12月28日 至 2026年12月31日/);
    const mine = (await s.call('GET', '/api/provider/invoices', null, token)).body;
    assert.equal(mine.length, 1); assert.equal(mine[0].period, '2026-12'); assert.equal(mine[0].prorated, true); assert.match(mine[0].payText, /梅田支店/); assert.match(mine[0].payText, new RegExp(mine[0].refCode));
    assert.ok(!('paidNote' in mine[0]) && !('paidBy' in mine[0]));
    me = (await s.call('GET', '/api/provider/me', null, token)).body;
    assert.equal(me.listedUntil, '2027-01-03', '没付的第一期：期限 + 宽限天数之前照常展示');
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + free[0].id + '/paid', { paidOn: '2026-12-14' })).status, 409, '免费期的记录不用付款');
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + dec.id + '/paid', { paidOn: '2026-12-14', note: '已入账' })).status, 200);
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + dec.id + '/paid', { paidOn: '2026-12-14' })).status, 409, '不能标记两次');
    me = (await s.call('GET', '/api/provider/me', null, token)).body;
    assert.equal(me.listedUntil, '2027-01-07', '付了第一期：12 月结束 + 宽限 7 天');
    // 之后按自然月的整月：1 月的账单 12 月 18 日开，期限 12 月 31 日
    s.runAt('2026-12-18');
    const jan = s.app.store.invoiceFor(pid, '2027-01');
    assert.deepEqual([jan.periodStart, jan.periodEnd, jan.amountYen, jan.dueDate], ['2027-01-01', '2027-01-31', 11000, '2026-12-31']);
    assert.equal((await s.call('GET', '/api/provider/invoices', null, token)).body.find((i) => i.period === '2027-01').prorated, false);
    const q = await s.onboard('q@example.jp');
    const list = await s.listed();
    assert.ok(list.some((x) => x.id === pid)); assert.ok(list.some((x) => x.id === q.providerId), '另一家同样有免费期');
    assert.equal(q.freeUntil, '2027-01-17');
    const pub = list.find((x) => x.id === pid);
    assert.equal(pub.licenseBody, '大阪府行政書士会'); assert.equal(pub.address, '大阪府大阪市北区梅田1-2-3'); assert.ok(!JSON.stringify(pub).includes('@'), '联系邮箱不公开');
    assert.deepEqual((await s.call('GET', '/api/provider/invoices', null, q.token)).body, [], '只看到自己的');
    const adm = (await s.adm('GET', '/api/admin/providers')).body.find((x) => x.id === pid);
    assert.equal(adm.listed, true); assert.equal(adm.freeUntil, '2026-12-27'); assert.equal(adm.contact, 'p***@example.jp');
  } finally { await s.stop(); }
});

// 批准日 → [免费期最后一天, 第一张要付钱的账单的期间（月）, 开始收费的那天, 士业的金额, 开出的那天]。金额 = floor(11000 × 收费天数 ÷ 当月天数)。
const FIRST = [
  ['2026-12-01', '2026-12-31', '2027-01', '2027-01-01', 11000, '2026-12-18', '1 日批准：免费期正好到月底，第一期是整月'],
  ['2026-12-15', '2027-01-14', '2027-01', '2027-01-15', 6032, '2027-01-01', '15 日批准：11000 × 17 ÷ 31'],
  ['2026-11-30', '2026-12-30', '2026-12', '2026-12-31', 354, '2026-12-17', '月末最后一天批准：第一期只有 1 天'],
  ['2027-01-05', '2027-02-04', '2027-02', '2027-02-05', 9428, '2027-01-22', '平年 2 月按 28 天折算：11000 × 24 ÷ 28'],
  ['2028-01-05', '2028-02-04', '2028-02', '2028-02-05', 9482, '2028-01-22', '闰年 2 月按 29 天折算：11000 × 25 ÷ 29'],
  ['2027-01-31', '2027-03-02', '2027-03', '2027-03-03', 10290, '2027-02-17', '平年 1 月 31 日批准：2 月整个在免费期里，不开 2 月的账单'],
  ['2028-01-31', '2028-03-01', '2028-03', '2028-03-02', 10645, '2028-02-17', '闰年 1 月 31 日批准：免费期到 3 月 1 日'],
  ['2027-02-15', '2027-03-17', '2027-03', '2027-03-18', 4967, '2027-03-04', '平年 2 月 15 日批准'],
  ['2028-02-15', '2028-03-16', '2028-03', '2028-03-17', 5322, '2028-03-03', '闰年 2 月 15 日批准'],
  ['2027-02-28', '2027-03-30', '2027-03', '2027-03-31', 354, '2027-03-17', '平年 2 月最后一天批准'],
  ['2028-02-29', '2028-03-30', '2028-03', '2028-03-31', 354, '2028-03-17', '闰年 2 月最后一天批准']
];
const addD = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
for (const [day, freeUntil, period, startDay, amount, issueOn, why] of FIRST) {
  test('免费期和第一期（' + why + '）：' + day + ' 批准，免费到 ' + freeUntil + '，第一期从 ' + startDay + ' 起，' + amount + ' 日元；免费期里的日子不收费，收费的日子都在名单上', async () => {
    const s = await start({}, noon(day));
    try {
      const p = await s.onboard('f@example.jp');
      assert.equal(p.freeUntil, freeUntil);
      const ok = s.mails('f@example.jp').find((m) => /已批准/.test(m.subject));
      const cn = (ymd) => +ymd.slice(0, 4) + '年' + (+ymd.slice(5, 7)) + '月' + (+ymd.slice(8, 10)) + '日';
      assert.ok(ok.body.includes('到 ' + cn(freeUntil) + ' 为止不收展示费'), ok.body);
      assert.ok(ok.body.includes('第一张账单是 ' + cn(startDay) + ' 至 '), '邮件里写第一期的期间');
      assert.ok(ok.body.includes(cn(issueOn) + ' 前后开出'));
      assert.ok(ok.body.includes(startDay.endsWith('-01') ? '的整月展示费' : '按天折算'));
      // 开出之前每一轮都不开要付钱的账单（包括整个在免费期里的月份）
      s.runAt(addD(issueOn, -1));
      assert.deepEqual(s.app.store.listInvoices({ providerId: p.providerId }).map((i) => i.method), ['first_month_free'], '开出之前没有要付钱的账单');
      s.runAt(issueOn);
      const inv = s.app.store.invoiceFor(p.providerId, period);
      assert.ok(inv, '提前 14 天开出');
      assert.deepEqual([inv.periodStart, inv.amountYen, inv.taxYen, inv.dueDate], [startDay, amount, Math.floor(amount * 10 / 110), freeUntil], '从免费期结束的第二天起收费，期限是免费期最后一天');
      assert.equal(addD(freeUntil, 1), inv.periodStart, '收费和免费期不重叠、不留空');
      // 免费期整个盖住的月份不开账单
      for (const i of s.app.store.listInvoices({ providerId: p.providerId })) if (i.method !== 'first_month_free') assert.ok(i.periodStart > freeUntil, '免费期里的日子不收费');
      // 付了第一期：批准日到第一期结束，每一天都在名单上
      assert.equal((await s.pay(inv)).status, 200);
      for (let d = day; d <= inv.periodEnd; d = addD(d, 1)) assert.equal(s.app.store.providerListing(p.providerId, d).listed, true, d + ' 应在名单上');
    } finally { await s.stop(); }
  });
}

test('月末最后一天批准：免费期到下个月 30 日，第一期只收 31 日一天；不付就在期限 + 宽限天数之后下架，告知一次', async () => {
  const s = await start({}, noon('2026-11-30'));
  try {
    const p = await s.onboard('e@example.jp', MOBILE);
    assert.equal(p.freeUntil, '2026-12-30');
    s.runAt('2026-12-17');
    const dec = s.app.store.invoiceFor(p.providerId, '2026-12');
    assert.deepEqual([dec.periodStart, dec.amountYen, dec.dueDate], ['2026-12-31', 177, '2026-12-30'], '5500 × 1 ÷ 31 = 177.4，舍去');
    s.runAt('2026-12-18');
    assert.equal(s.app.store.invoiceFor(p.providerId, '2027-01').dueDate, '2026-12-31', '1 月照常提前 14 天开');
    s.set(noon('2027-01-07')); assert.ok((await s.listed('mobile')).some((x) => x.id === p.providerId), '1 月的期限 12 月 31 日 + 7 天仍展示');
    s.set(noon('2027-01-08')); s.app.billing.runOnce(); await s.app.deliver();
    assert.ok(!(await s.listed('mobile')).some((x) => x.id === p.providerId), '过了宽限期不展示');
    assert.equal(s.mails('e@example.jp').filter((m) => /暂时不在名单上展示/.test(m.subject)).length, 1, '展示过（免费期）的告知一次');
  } finally { await s.stop(); }
});

test('没领取令牌的服务商不开账单、不发付款提醒、不发“不再展示”；免费期过后才领取的从领取那天起收费，当天上名单', async () => {
  const s = await start({}, noon('2026-11-27'));
  try {
    const a = await s.apply('nc@example.jp', MOBILE); assert.equal(a.status, 201);
    const ap = await s.approve(a.body.ref, null); assert.equal(ap.status, 200);
    const pid = ap.body.providerId, billingMails = () => s.mails('nc@example.jp').filter((m) => m.kind === 'billing');
    for (const ymd of ['2026-11-27', '2026-11-30', '2026-12-05', '2026-12-20', '2027-01-10']) { s.set(noon(ymd)); s.app.billing.runOnce(); await s.app.deliver(); }
    assert.deepEqual(s.app.store.listInvoices({ providerId: pid }).map((i) => i.method), ['first_month_free'], '只有免费期的记录，没有要付钱的账单');
    assert.equal(billingMails().length, 0, '没有账单、提醒，也没有“暂时不在名单上展示”（从来没展示过）');
    // 1 月 10 日才领取：免费期（到 12 月 27 日）早已结束，1 月的账单从领取那天收到月底（5500 × 22 ÷ 31 = 3903），期限从开出起 14 天；12 月不补
    const c = await s.claim('nc@example.jp'); assert.equal(c.status, 200);
    assert.equal(s.app.billing.claimDayOf(pid), '2027-01-10');
    s.app.billing.runOnce();
    const jan = s.app.store.invoiceFor(pid, '2027-01');
    assert.deepEqual([jan.periodStart, jan.periodEnd, jan.amountYen, jan.dueDate], ['2027-01-10', '2027-01-31', 3903, '2027-01-24'], '领取之前的 1 月 1 日至 9 日不收');
    assert.equal(s.app.store.invoiceFor(pid, '2026-12'), null, '没领取的月份不补开');
    assert.ok((await s.listed('mobile')).some((x) => x.id === pid), '收了费的每一天都在名单上：领取当天就展示，期限 + 宽限之前照常展示');
    assert.equal(s.app.store.providerListing(pid, '2027-01-09').listed, false, '领取之前那天不展示');
    // 再领取一次（换令牌）不改开始收费的那天
    s.set(noon('2027-01-12')); assert.equal((await s.claim('nc@example.jp')).status, 200); assert.equal(s.app.billing.claimDayOf(pid), '2027-01-10');
    // 不付：照常有账单和提醒；2 月的账单（1 月 25 日开出，离 1 月 31 日不到 7 天，期限是开出后 14 天的 2 月 8 日）+ 宽限 7 天过了就下架，展示过所以告知一次
    for (const ymd of ['2027-01-17', '2027-01-25', '2027-02-01', '2027-02-08', '2027-02-15', '2027-02-16']) { s.set(noon(ymd)); s.app.billing.runOnce(); await s.app.deliver(); }
    const subj = billingMails().map((m) => m.subject);
    assert.ok(subj.some((x) => /展示费账单/.test(x)) && subj.some((x) => /付款提醒/.test(x)));
    assert.ok(!(await s.listed('mobile')).some((x) => x.id === pid));
    assert.equal(subj.filter((x) => /暂时不在名单上展示/.test(x)).length, 1, '领取后展示过，下架时告知一次');
  } finally { await s.stop(); }
});

test('免费期过后才领取：领取在 D+31 的同一个月和下一个月，都是从领取那天起收费、当天上名单，展示的规则一样', async () => {
  for (const [approve, claim, period, want] of [
    // 11 月 27 日批准，免费到 12 月 27 日；12 月 29 日（D+32，和 D+31 同一个月）领取：12 月 29 日至 31 日，5500 × 3 ÷ 31 = 532
    ['2026-11-27', '2026-12-29', '2026-12', ['2026-12-29', 532, '2027-01-12']],
    // 12 月 15 日批准，免费到 1 月 14 日；1 月 24 日（D+40）领取：1 月 24 日至 31 日，5500 × 8 ÷ 31 = 1419
    ['2026-12-15', '2027-01-24', '2027-01', ['2027-01-24', 1419, '2027-02-07']]
  ]) {
    const s = await start({}, noon(approve));
    try {
      const a = await s.apply('lc@example.jp', MOBILE); const ap = await s.approve(a.body.ref, null); assert.equal(ap.status, 200);
      const pid = ap.body.providerId;
      s.set(noon(claim)); s.app.billing.runOnce();
      assert.equal(s.app.store.listInvoices({ providerId: pid }).filter((i) => i.method !== 'first_month_free').length, 0, '领取之前不开账单');
      assert.equal((await s.claim('lc@example.jp')).status, 200);
      s.app.billing.runOnce();
      const inv = s.app.store.invoiceFor(pid, period);
      assert.deepEqual([inv.periodStart, inv.amountYen, inv.dueDate], want, claim);
      assert.equal(s.app.store.providerListing(pid, addDays(claim, -1)).listed, false, claim + ' 前一天不展示');
      assert.ok((await s.listed('mobile')).some((x) => x.id === pid), claim + ' 领取当天展示');
      assert.equal(s.app.store.providerListing(pid, addDays(want[2], 7)).listed, true, '期限 + 宽限的最后一天仍展示');
    } finally { await s.stop(); }
  }
});
test('付款提醒、提前开下一期、过了宽限期自动不展示：前 7 天、前 1 天、过期第二天各一次，跑两遍不重复', async () => {
  const s = await start({ billing: billingConfig({ BILLING_INVOICE_REG_NO: 'T1234567890123' }) }, noon('2026-11-02'));
  try {
    // 11 月 2 日批准：免费期到 12 月 2 日，第一期 12 月 3 日至 31 日（5500 × 29 ÷ 31 = 5145）
    const p = await s.onboard('r@example.jp', MOBILE);
    const run = async (ymd) => { s.set(noon(ymd)); s.app.billing.runOnce(); s.app.billing.runOnce(); await s.app.deliver(); };
    const kinds = () => s.mails('r@example.jp').filter((m) => m.kind === 'billing').map((m) => m.subject + '|' + m.status);
    await run('2026-11-18');
    assert.equal(s.app.store.invoiceFor(p.providerId, '2026-12'), null, '提前 15 天还不开');
    await run('2026-11-19');
    const dec = s.app.store.invoiceFor(p.providerId, '2026-12');
    assert.ok(dec, '提前 14 天开第一期'); assert.equal(dec.dueDate, '2026-12-02', '期限是开始收费的前一天（免费期最后一天）'); assert.equal(dec.amountYen, 5145);
    assert.match(s.lastMail('r@example.jp').body, /登记号：T1234567890123/); assert.match(s.lastMail('r@example.jp').body, /消费税（10%）：467 日元/);
    await run('2026-11-24'); assert.equal(kinds().length, 1, '还剩 8 天不提醒');
    await run('2026-11-25'); assert.equal(kinds().length, 2); assert.match(kinds()[1], /付款提醒/);
    assert.match(s.lastMail('r@example.jp').body, /还有 7 天/);
    await run('2026-11-30'); assert.equal(kinds().length, 2);
    await run('2026-12-01'); assert.equal(kinds().length, 3); assert.match(s.lastMail('r@example.jp').body, /明天是付款期限/);
    await run('2026-12-02'); assert.equal(kinds().length, 3, '当天不再发');
    await run('2026-12-03'); assert.equal(kinds().length, 4); assert.match(s.lastMail('r@example.jp').body, /已经过了付款期限/);
    // 宽限期内仍然展示，过了就不展示，并告知一次
    await run('2026-12-09');
    assert.ok((await s.listed('mobile')).some((x) => x.id === p.providerId), '12 月 9 日（期限 + 7 天）仍展示');
    await run('2026-12-10');
    assert.ok(!(await s.listed('mobile')).some((x) => x.id === p.providerId), '过了宽限期自动不展示');
    assert.match(s.lastMail('r@example.jp').subject, /暂时不在名单上展示/);
    await run('2026-12-11'); await run('2026-12-20');
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
    const p = await s.onboard('x@example.jp', MOBILE);
    s.set(noon('2026-11-25')); s.app.billing.runOnce();
    const dec = s.app.store.invoiceFor(p.providerId, '2026-12');
    const q = s.mails('x@example.jp').filter((m) => m.kind === 'billing' && m.status === 'queued');
    assert.equal(q.length, 2, '开票邮件和前 7 天的提醒');
    await s.adm('POST', '/api/admin/invoices/' + dec.id + '/paid', { paidOn: '2026-11-25' });
    await s.app.deliver();
    const ids = q.map((m) => m.id);
    assert.deepEqual(s.app.store.listOutbox().filter((m) => ids.includes(m.id)).map((m) => m.status), ['dropped', 'dropped'], '付了之后排队中的账单邮件不发');
    s.set(noon('2026-12-01')); s.app.billing.runOnce();
    assert.equal(s.mails('x@example.jp').filter((m) => m.kind === 'billing' && m.status === 'queued').length, 0);
  } finally { await s.stop(); }
});

test('日本时间的日界：UTC 15:00 前后批准的批准日不同（免费期到哪天、第一期从哪天起）；账单按日本时间的日子开；展示到期日的最后一刻', async () => {
  const s = await start({}, '2026-11-30T14:59:00Z');
  try {
    const a = await s.onboard('a@example.jp', MOBILE);
    assert.equal(s.app.store.getInvoice(a.freeId).periodStart, '2026-11-30', '日本时间 11 月 30 日 23:59'); assert.equal(a.freeUntil, '2026-12-30');
    s.set('2026-11-30T15:00:00Z');
    const b = await s.onboard('b@example.jp', MOBILE);
    assert.equal(s.app.store.getInvoice(b.freeId).period, '2026-12'); assert.equal(s.app.store.getInvoice(b.freeId).periodStart, '2026-12-01', '日本时间 12 月 1 日 0:00');
    assert.equal(b.freeUntil, '2026-12-31', '12 月 1 日批准：免费期正好到 12 月 31 日');
    // a 的第一期（12 月 31 日一天）日本时间 12 月 17 日开；b 的第一期是 1 月整月，日本时间 12 月 18 日开
    s.set('2026-12-17T14:59:00Z'); s.app.billing.runOnce();
    assert.equal(s.app.store.invoiceFor(a.providerId, '2026-12').periodStart, '2026-12-31');
    assert.equal(s.app.store.invoiceFor(b.providerId, '2027-01'), null, '日本时间还是 12 月 17 日');
    s.set('2026-12-17T15:00:00Z'); s.app.billing.runOnce();
    const bj = s.app.store.invoiceFor(b.providerId, '2027-01');
    assert.deepEqual([bj.periodStart, bj.amountYen, bj.dueDate], ['2027-01-01', 5500, '2026-12-31'], '日本时间 12 月 18 日 0:00 开出，整月');
    assert.deepEqual(s.app.store.listInvoices({ providerId: b.providerId }).map((i) => i.method).sort(), ['first_month_free', 'manual_bank'], 'b 的 12 月整个在免费期里，只有免费期的记录和 1 月的账单');
    // 都不付：a 展示到 1 月 7 日（1 月账单的期限 12 月 31 日 + 7 天）的最后一刻
    s.set('2027-01-07T14:59:00Z'); assert.ok((await s.listed('mobile')).some((x) => x.id === a.providerId));
    s.set('2027-01-07T15:00:00Z'); assert.ok(!(await s.listed('mobile')).some((x) => x.id === a.providerId));
  } finally { await s.stop(); }
});

test('作废：作废的账单不能再标记已付款；作废后重新开这一期', async () => {
  const s = await start();
  try {
    const p = await s.onboard('v@example.jp', MOBILE);
    s.runAt('2026-12-14');
    const first = s.app.store.invoiceFor(p.providerId, '2026-12');
    const I = '/api/admin/invoices/' + first.id;
    assert.equal((await s.adm('POST', I + '/void', { reason: 'x' })).status, 422);
    const v = await s.adm('POST', I + '/void', { reason: '服务商要求撤回' });
    assert.equal(v.status, 200); assert.equal(v.body.status, 'void');
    assert.equal((await s.adm('POST', I + '/paid', { paidOn: '2026-11-27' })).status, 409);
    assert.equal((await s.adm('POST', I + '/void', { reason: '再作废一次' })).status, 409);
    s.runAt('2026-12-14');
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
    assert.doesNotMatch(s.mails('f@example.jp').find((m) => /已批准/.test(m.subject)).body, /付款方式/, '免费期里没有账单，批准邮件里没有付款方式');
    s.runAt('2026-12-14'); await s.app.deliver();
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

test('BILLING_ISSUE_DAYS 不超过 7 天时，批准邮件和 firstPaid 写的付款期限就是实际账单上的期限', async () => {
  const cn = (ymd) => +ymd.slice(0, 4) + '年' + (+ymd.slice(5, 7)) + '月' + (+ymd.slice(8)) + '日';
  // 11 月 27 日批准，免费到 12 月 27 日，第一期从 12 月 28 日起
  for (const [days, due] of [['14', '2026-12-27'], ['8', '2026-12-27'], ['7', '2027-01-04'], ['5', '2027-01-06'], ['1', '2027-01-10']]) {
    const s = await start({ billing: billingConfig({ BILLING_ISSUE_DAYS: days }) }, noon('2026-11-27'));
    try {
      const p = await s.onboard('d' + days + '@example.jp', MOBILE);
      const f = s.app.billing.firstPaid('mobile', p.freeUntil);
      assert.equal(f.dueDate, due, 'BILLING_ISSUE_DAYS=' + days);
      const approved = s.mails('d' + days + '@example.jp').find((m) => /入驻申请已批准/.test(m.subject));
      assert.ok(approved.body.includes('付款期限是 ' + cn(due) + (due === p.freeUntil ? '（免费期的最后一天）' : '，')), approved.body);
      s.runAt(f.issueOn);
      const inv = s.app.store.invoiceFor(p.providerId, '2026-12');
      assert.ok(inv, '在 issueOn 开出'); assert.equal(inv.dueDate, due, '账单上的期限和邮件一致');
    } finally { await s.stop(); }
  }
});

test('工作台的免费期说明：第一期从 1 日起时写整月，否则写按天折算；旧数据（批准当月）不写“批准日 + 30 天”；开出天数按配置', async () => {
  // 用假的 store 只测 freeInfo 的判断
  const fake = (free, meta) => ({ configureListing() {}, listInvoices: () => (free ? [Object.assign({ method: 'first_month_free', status: 'paid' }, free)] : []), providerMeta: () => meta || null });
  const info = (free, meta) => createBilling({ store: fake(free, meta) }).freeInfo('p');
  assert.deepEqual(info({ periodStart: '2026-11-27', periodEnd: '2026-12-27' }), { from: '2026-11-27', until: '2026-12-27', days30: true, firstBillStart: '2026-12-28', firstProrated: true });
  assert.deepEqual(info({ periodStart: '2026-12-01', periodEnd: '2026-12-31' }), { from: '2026-12-01', until: '2026-12-31', days30: true, firstBillStart: '2027-01-01', firstProrated: false }, '12 月 1 日批准：第一期是 1 月整月');
  assert.equal(info({ periodStart: '2027-03-31', periodEnd: '2027-04-30' }).firstProrated, false, '3 月 31 日批准：5 月整月');
  assert.equal(info({ periodStart: '2027-01-29', periodEnd: '2027-02-28' }).firstBillStart, '2027-03-01');
  const old = info({ periodStart: '2026-11-15', periodEnd: '2026-11-30' });
  assert.deepEqual([old.days30, old.firstBillStart, old.firstProrated], [false, '2026-12-01', false], '旧数据：免费到批准当月月底');
  assert.deepEqual(info({ periodStart: '2026-11-27', periodEnd: '2026-12-27' }, { source: 'apply', claimedAt: '2027-01-10T03:00:00Z' }).firstBillStart, '2027-01-10', '免费期过后才领取：从领取那天起');
  assert.equal(info(null), null, '老服务商没有免费期');
  // 接口带上 free 和 issueDays；页面不写死 14 天，也不写死“按天折算”
  const s = await start({ billing: billingConfig({ BILLING_ISSUE_DAYS: '10' }) }, noon('2026-12-01'));
  try {
    const p = await s.onboard('w@example.jp', MOBILE);
    const me = (await s.call('GET', '/api/provider/me', null, p.token)).body;
    assert.equal(me.issueDays, 10);
    assert.deepEqual(me.free, { from: '2026-12-01', until: '2026-12-31', days30: true, firstBillStart: '2027-01-01', firstProrated: false });
  } finally { await s.stop(); }
  const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'provider.html'), 'utf8');
  assert.doesNotMatch(page, /14 天开出/); assert.match(page, /firstProrated/); assert.match(page, /days30/);
});
