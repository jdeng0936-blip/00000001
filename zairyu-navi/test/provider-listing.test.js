// 展示规则和审核的复查（2026-11-27 第三轮）：付款覆盖中间断过之后付了当期就展示、下一期的期限没过不下架、老服务商建好时就迁移、
// 审核要对上看过的版本、助手的草稿只认在名单上的服务商并说明展示费、保证类用语的写法变体、回复里的保证类用语。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, gyosei, CHECK, BOB } = require('./provider-helpers');
const { execTool } = require('../src/assistant');
const { hasClaims } = require('../src/validate');
const { jstToday } = require('../src/store');

const MOBILE = { category: 'mobile', licenseNo: '', licenseBody: '', name: '大阪中文电话卡', feeNote: '月费 2,980 日元起' };
const noon = (ymd) => ymd + 'T03:00:00Z';

// 一些共用的小操作
const helpers = (s) => ({
  run: async () => { const r = await s.adm('POST', '/api/admin/billing/run'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; },
  inv: (pid, period) => s.app.store.invoiceFor(pid, period),
  pay: async (inv) => { const r = await s.adm('POST', '/api/admin/invoices/' + inv.id + '/paid', { paidOn: jstToday(s.now()) }); assert.equal(r.status, 200, JSON.stringify(r.body)); },
  listing: (pid) => s.app.store.providerListing(pid, jstToday(s.now()))
});

test('下架再上架：以前付过的一期挡不住新付的当期，付了就展示、能收咨询', async () => {
  const s = await start();
  const h = helpers(s);
  try {
    const p = await s.onboard('re@example.jp', null, true);
    assert.equal(h.listing(p.providerId).listed, true);
    assert.equal((await s.adm('PUT', '/api/admin/providers/' + p.providerId + '/active', { active: false })).status, 200);
    s.set(noon('2027-03-02'));
    assert.equal((await s.adm('PUT', '/api/admin/providers/' + p.providerId + '/active', { active: true })).status, 200);
    await h.run();
    const mar = h.inv(p.providerId, '2027-03');
    assert.ok(mar && mar.status === 'issued');
    assert.equal(h.listing(p.providerId).listed, false, '付款之前不展示');
    await h.pay(mar);
    assert.deepEqual(h.listing(p.providerId), { listed: true, listedUntil: '2027-04-07' });
    assert.deepEqual((await s.listed()).map((x) => x.id), [p.providerId]);
    const u = await s.newUser();
    assert.equal((await s.inquire(u, [p.providerId])).status, 201);
  } finally { await s.stop(); }
});

test('作废了中间的一期：付了下一期就展示', async () => {
  const s = await start();
  const h = helpers(s);
  try {
    const p = await s.onboard('void@example.jp', null, true);
    await h.run(); // 开出 12 月
    const dec = h.inv(p.providerId, '2026-12');
    s.set(noon('2026-12-20'));
    await h.run();
    assert.equal(h.listing(p.providerId).listed, false, '12 月过了宽限期');
    assert.equal((await s.adm('POST', '/api/admin/invoices/' + dec.id + '/void', { reason: '这一期不收' })).status, 200);
    s.set(noon('2027-01-05'));
    await h.run();
    const jan = h.inv(p.providerId, '2027-01');
    assert.ok(jan);
    await h.pay(jan);
    assert.equal(h.listing(p.providerId).listed, true);
    const me = await s.call('GET', '/api/provider/me', null, p.token);
    assert.equal(me.body.listed, true);
    const u = await s.newUser();
    assert.equal((await s.inquire(u, [p.providerId])).status, 201);
  } finally { await s.stop(); }
});

test('拖欠了不止一期：补上旧的、再付了当期，当期就展示', async () => {
  const s = await start(null, noon('2026-11-02'));
  const h = helpers(s);
  try {
    const p = await s.onboard('lapse@example.jp', MOBILE, true);
    s.set(noon('2026-11-20')); await h.run();
    const dec = h.inv(p.providerId, '2026-12');
    assert.equal(dec.dueDate, '2026-11-30');
    s.set(noon('2026-12-08')); await h.run();
    assert.equal(h.listing(p.providerId).listed, false, '12 月拖欠，下架');
    s.set(noon('2027-01-10')); await h.run();
    s.set(noon('2027-02-02')); await h.run();
    await h.pay(dec);
    await h.run();
    const feb = h.inv(p.providerId, '2027-02');
    assert.ok(feb && feb.status === 'issued');
    await h.pay(feb);
    assert.deepEqual(h.listing(p.providerId), { listed: true, listedUntil: '2027-03-07' });
    assert.equal((await s.listed('mobile')).length, 1);
    // 只作废旧的、不补也一样：以前的 11 月覆盖不会挡住新付的一期
    const s2 = await start(null, noon('2026-11-02'));
    const h2 = helpers(s2);
    try {
      const q = await s2.onboard('lapse2@example.jp', MOBILE, true);
      s2.set(noon('2026-11-20')); await h2.run();
      s2.set(noon('2027-02-02'));
      assert.equal((await s2.adm('POST', '/api/admin/invoices/' + h2.inv(q.providerId, '2026-12').id + '/void', { reason: '不收了' })).status, 200);
      await h2.run();
      await h2.pay(h2.inv(q.providerId, '2027-02'));
      assert.equal(h2.listing(q.providerId).listed, true);
    } finally { await s2.stop(); }
  } finally { await s.stop(); }
});

test('月底批准：下一期的账单期限在覆盖结束之后时，期限加宽限天数之前照常展示；过了才下架，同一轮发告知', async () => {
  const s = await start(null, noon('2026-11-28'));
  const h = helpers(s);
  try {
    const p = await s.onboard('late@example.jp', null, true);
    await h.run();
    const dec = h.inv(p.providerId, '2026-12');
    assert.equal(dec.dueDate, '2026-12-12', '开得晚了，期限从开出起 14 天');
    for (const [d, on] of [['2026-12-07', true], ['2026-12-08', true], ['2026-12-12', true], ['2026-12-19', true], ['2026-12-20', false]]) {
      s.set(noon(d));
      assert.equal(h.listing(p.providerId).listed, on, d);
    }
    s.set(noon('2026-12-10'));
    assert.equal(h.listing(p.providerId).listedUntil, '2026-12-19');
    s.set(noon('2026-12-20'));
    const r = await h.run();
    assert.equal(r.hidden, 1, '下架的那天就告知');
    assert.ok(s.mails('late@example.jp').some((m) => /不在名单上展示|暂停展示|不再展示/.test(m.subject + m.body)));
    // 付了 12 月就恢复
    await h.pay(dec);
    assert.equal(h.listing(p.providerId).listed, true);
  } finally { await s.stop(); }
});

test('没付过款的服务商：开着的账单不让它展示（批准了没付款不上名单）', async () => {
  const s = await start();
  const h = helpers(s);
  try {
    const p = await s.onboard('unpaid@example.jp', null, false);
    await h.run();
    assert.equal(h.listing(p.providerId).listed, false);
    assert.equal((await s.listed()).length, 0);
  } finally { await s.stop(); }
});

test('老服务商：createApp 建好时就迁移，不等定时任务；下一期的期限没过前照常展示', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-mig-'));
  try {
    const f = path.join(dir, 'old.db');
    const old = new DatabaseSync(f);
    old.exec('CREATE TABLE providers (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, area TEXT, langs TEXT, fee_note TEXT, license_no TEXT, fee_model TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL)');
    old.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-m', 'h', '老电话卡店', 'mobile', '大阪', '中文', '月费 2,980 日元起', null, 'fixed_listing', 1, '2026-01-01T00:00:00Z');
    old.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-g', 'h2', '老事务所', 'gyosei', null, null, '合格保证', ' x ', 'fixed_listing', 1, '2026-01-02T00:00:00Z');
    old.close();
    const s = await start({ dbFile: f }, noon('2026-11-27'));
    const h = helpers(s);
    try {
      const pub = await s.listed('mobile');
      assert.deepEqual(pub.map((x) => x.id), ['legacy-m'], '还没跑过定时任务就在名单上');
      assert.equal(pub[0].promoted, true, '非士业标含推广（不看库里存的 fixed_listing）');
      assert.deepEqual(await s.listed('gyosei'), [], '资料没过检查的不展示');
      const adm = (await s.adm('GET', '/api/admin/providers')).body;
      assert.equal(adm.find((x) => x.id === 'legacy-g').source, 'legacy-hold');
      await h.run();
      const dec = h.inv('legacy-m', '2026-12');
      assert.equal(dec.dueDate, '2026-12-11');
      s.set(noon('2026-12-08'));
      assert.equal(h.listing('legacy-m').listed, true, '12 月的期限还没到');
      s.set(noon('2026-12-19'));
      assert.equal(h.listing('legacy-m').listed, false, '期限加宽限天数过了才下架');
      assert.equal(s.app.store.listInvoices({ providerId: 'legacy-g' }).length, 0);
    } finally { await s.stop(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('审核要对上看过的版本：申请人重新提交后，拿旧版本批准、拒绝、要求修改都是 409；不带版本 422', async () => {
  const s = await start();
  try {
    const E = 'ver@example.jp';
    const a = await s.apply(E), id = s.appByRef(a.body.ref).id, P = '/api/admin/applications/' + id;
    const seen = (await s.adm('GET', P)).body; // alice 打开
    assert.equal(seen.licenseNo, '12345678');
    assert.ok(seen.reviewKey);
    assert.equal((await s.adm('POST', P + '/request-changes', { reviewKey: seen.reviewKey, message: '请写全所属会的名称。' }, BOB)).status, 200);
    const c = await s.applyCode(E);
    const o = (await s.call('POST', '/api/provider-apply/open', c)).body;
    const re = await s.call('PUT', '/api/provider-apply/' + a.body.ref, Object.assign({ proof: o.proof }, gyosei({ name: '完全不同的事务所', licenseNo: '87654321', licenseBody: '東京都行政書士会' })));
    assert.equal(re.status, 200);
    const lc = Object.assign({}, CHECK, { checkedOn: jstToday(s.now()) });
    assert.equal((await s.adm('POST', P + '/approve', { licenseCheck: lc })).status, 422, '不带版本');
    const stale = await s.adm('POST', P + '/approve', { licenseCheck: lc, reviewKey: seen.reviewKey });
    assert.equal(stale.status, 409); assert.match(stale.body.error, /重新打开/);
    assert.equal((await s.adm('POST', P + '/reject', { reviewKey: seen.reviewKey, reason: '旧版本上的拒绝理由。' })).status, 409);
    assert.equal((await s.adm('POST', P + '/request-changes', { reviewKey: seen.reviewKey, message: '旧版本上的修改要求。' })).status, 409);
    assert.equal(s.appByRef(a.body.ref).status, 'pending', '什么都没改');
    assert.equal(s.app.store.listAllProviders().length, 0);
    // 重新打开、看到新的登录番号后再批准
    const now = (await s.adm('GET', P)).body;
    assert.equal(now.licenseNo, '87654321');
    const ok = await s.adm('POST', P + '/approve', { licenseCheck: lc, reviewKey: now.reviewKey });
    assert.equal(ok.status, 200);
    assert.equal(s.app.store.getProvider(ok.body.providerId).licenseNo, '87654321');
    // 管理页带上版本
    const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'admin.html'), 'utf8');
    assert.equal((html.match(/reviewKey:a\.reviewKey/g) || []).length, 4);
  } finally { await s.stop(); }
});

test('助手：草稿只认在名单上的服务商（批准了没付款的不行）；名单和草稿都带展示费的说明，非士业标含推广', async () => {
  const s = await start();
  try {
    const unpaid = await s.onboard('np@example.jp', null, false);
    const paid = await s.onboard('pd@example.jp', { name: '已付款行政书士事务所' }, true);
    const store = s.app.store, user = store.createUser();
    const ctx = { user, store, now: s.now() };
    const base = { category: 'gyosei', summary: '想咨询在留期间更新的手续。' };
    assert.throws(() => execTool('create_inquiry', Object.assign({}, base, { providerIds: [unpaid.providerId] }), ctx), /服务商无效/);
    const d = execTool('create_inquiry', Object.assign({}, base, { providerIds: [paid.providerId] }), ctx);
    assert.deepEqual(d.draft.providers, [{ id: paid.providerId, name: '已付款行政书士事务所', promoted: false }]);
    assert.match(d.draft.disclosure, /固定的展示费/);
    const sp = execTool('suggest_providers', { category: 'gyosei' }, ctx);
    assert.deepEqual(sp.providers.map((x) => x.providerId), [paid.providerId], '没付款的不在助手的名单里');
    assert.match(sp.disclosure, /固定的展示费/); assert.doesNotMatch(sp.disclosure, /含推广/);
    assert.match(sp.note, /disclosure/);
    const m = await s.onboard('mb@example.jp', MOBILE, true);
    const sm = execTool('suggest_providers', { category: 'mobile' }, ctx);
    assert.equal(sm.providers[0].providerId, m.providerId); assert.equal(sm.providers[0].promoted, true);
    assert.match(sm.disclosure, /含推广/); assert.match(sm.note, /含推广/);
    const dm = execTool('create_inquiry', { category: 'mobile', summary: '想办一张电话卡。', providerIds: [m.providerId] }, ctx);
    assert.equal(dm.draft.providers[0].promoted, true);
    // 系统提示里有说明展示费、标含推广的规则（网页内嵌的那份由 web-sync 测试保证一致）
    const { SYS } = require('../src/engine')({});
    assert.match(SYS, /disclosure/); assert.match(SYS, /含推广/);
    // 名单页和草稿卡片的“含推广”都按类别定
    const cats = (await s.call('GET', '/api/providers/categories')).body;
    assert.equal(cats.find((c) => c.key === 'mobile').promoted, true);
    assert.equal(cats.find((c) => c.key === 'gyosei').promoted, false);
  } finally { await s.stop(); }
});

test('保证类用语：繁体、零宽字符、空格隔开的写法也拦；“不能保证”这种提醒不拦；地址也查', async () => {
  for (const t of ['合格保證', '絕對', '包​过', '包 过', '包過', '必 過', '保 证 合 格', 'ｎｏ． １', '1 0 0 %', '絶対']) assert.equal(hasClaims(t), true, t);
  for (const t of ['不保证结果', '我们无法保证结果', '不能確保一定获批', '大阪府大阪市北区梅田1-2-3', '首次咨询30分钟5,500日元', 'Room No. 12']) assert.equal(hasClaims(t), false, t);
  const s = await start();
  try {
    for (const [k, v] of [['address', '大阪府大阪市北区1-2 合格保证'], ['name', '合格保證事務所'], ['feeNote', '首次咨询 包​过'], ['area', '絕對大阪'], ['langs', '中文 保 证']]) {
      const r = await s.apply(k.toLowerCase() + '@example.jp', { [k]: v });
      assert.equal(r.status, 422, k + '：' + JSON.stringify(r.body));
    }
  } finally { await s.stop(); }
});

test('服务商的回复也不能有保证类用语；“不能保证结果”可以写', async () => {
  const s = await start();
  try {
    const p = await s.onboard('rp@example.jp', null, true);
    const u = await s.newUser();
    assert.equal((await s.inquire(u, [p.providerId])).status, 201);
    const q = (await s.call('GET', '/api/provider/inquiries', null, p.token)).body[0];
    const bad = await s.call('POST', '/api/provider/inquiries/' + q.id + '/reply', { text: '包过，保证获批' }, p.token);
    assert.equal(bad.status, 422); assert.match(bad.body.error, /保证类/);
    assert.equal((await s.call('POST', '/api/provider/inquiries/' + q.id + '/reply', { text: '包 過，放心' }, p.token)).status, 422);
    assert.equal((await s.call('POST', '/api/provider/inquiries/' + q.id + '/reply', { text: '不能保证结果，但可以帮你准备材料。' }, p.token)).status, 201);
    assert.equal(s.app.store.listInquiries(u.id)[0].replies.length, 1);
    assert.ok(!s.app.store.auditRows().some((r) => /包过|保证获批/.test(r.detail || '')), '留痕里没有回复原文');
  } finally { await s.stop(); }
});

test('文字和代码一致：条款写明资料变更找运营者、全部邮件种类和 90 天删除；代码里不再把非士业说成按佣金', () => {
  const terms = fs.readFileSync(path.join(__dirname, '..', 'web', 'provider-terms.html'), 'utf8');
  assert.doesNotMatch(terms, /在申请页面或工作台里及时更新/);
  assert.match(terms, /联系运营者/);
  for (const k of ['申请已收到', '审核结果', '令牌已重新发放', '付款提醒', '新咨询通知', '90 天']) assert.ok(terms.includes(k), k);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'privacy.html'), 'utf8'), /90 天/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /推广佣金/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'provider.html'), 'utf8');
  assert.match(page, /reply-tip/);
});
