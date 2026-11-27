// 服务商展示费：开账单、付款提醒、过了宽限期自动不展示。零依赖。
// 规则（docs/TODO.md 第 7 条，负责人的决定都按建议的默认做法）：
// - 按自然月（日本时间）收固定的展示费，分士业和其他两档，金额只按价目表（BILLING_PLANS）取，不看任何请求里的 amount；
//   不按咨询数、成交数收费；除了所有服务商都一样的首月免费，没有给个别服务商调价、打折、免费期的口子。账单行里存下开票时的金额和价目表版本。
// - 首月免费（负责人 2026-11-27 决定）：批准当月（日本时间的自然月）不收费、不开账单。批准时只记一条“首月免费”的覆盖
//   （invoices 里 method 为 first_month_free、金额 0、状态 paid，只用来算展示，不发账单邮件，工作台的账单列表里不出现）；
//   服务商领取令牌后马上上名单（没领取的看不到咨询，所以不展示），展示到批准当月结束 + BILLING_GRACE_DAYS 天。
//   第一张要付钱的账单是下个月的，按下面的普通规则开：提前 BILLING_ISSUE_DAYS 天开出，期限是下个月开始的前一天；
//   月底批准、离下个月不到 7 天才开的，期限是开出后 BILLING_FIRST_DUE_DAYS 天（期限 + 宽限天数之前照常展示）。
// - 下一期的账单提前 BILLING_ISSUE_DAYS 天开，付款期限是下一期开始的前一天。
// - 付款期限前 7 天、前 1 天、过期第二天各提醒一次；已付款的账单覆盖到 本期结束 + BILLING_GRACE_DAYS 天，过了还没付下一期的就不展示，并告知一次。
// - 收款方式可以替换（methods）：现在只有手工确认的银行转账（manual_bank）。以后接刷卡、在线支付时实现
//   { name, createCheckout(inv) -> { payUrl }, verifyWebhook(req, rawBody) -> { invoiceId, paid } | null }，由 POST /api/billing/webhook/:method 接收（现在返回 404）。
// 运行：npm start 里每小时跑一次；也可以由 cron 跑 npm run billing（跑一轮“开账单、发提醒、发新咨询通知、发件箱”就退出），两种一起用也不会重复发。
const crypto = require('node:crypto');
const path = require('node:path');
const createEngine = require('./engine');
const { TEXTS, deliverOutbox } = require('./mailer');
const { addDays, jstToday } = require('./store');
const { checkLicense, assertListingText, feeModelOf } = require('./validate');

const REF = createEngine({});
const CAT_KEYS = new Set(REF.CATS.map((c) => c[0]));
// 代码里的占位金额（日元/期，含税）。正式的金额由负责人填进 BILLING_PLANS。
const DEFAULT_PLANS = { regulated: 11000, other: 5500 };
const CHECK_METHODS = ['association_search', 'certificate', 'phone_association'];
// 首月免费的覆盖记录用的 plan、method、paidBy
const FREE = 'first_month_free';
// 老服务商迁移时按入驻申请的规则查资料，返回问题的代号：category 类别不对、license 登录番号的格式或所属会不对（老服务商没有登记过所属会，
// 士业都会落在这里）、claims 名单上的文字有保证类用语。有问题的不自动展示（store.migrateLegacyProviders 记为 legacy-hold）。
function legacyIssues(p) {
  const out = [];
  if (!CAT_KEYS.has(p.category)) return ['category'];
  try { checkLicense(p.category, p.licenseNo, ''); } catch (e) { out.push('license'); }
  try { assertListingText(p); } catch (e) { out.push('claims'); }
  return out;
}

// env 是环境变量那样的对象；设置不对就抛错，不启动。sender 是真实发信（http、smtp）时，价目表和振込先必须填。
function billingConfig(env, sender) {
  env = env || {};
  const real = !!sender && !sender.dev;
  const num = (name, def, min, max) => { if (env[name] == null || env[name] === '') return def; const n = Number(env[name]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(name + ' 须是 ' + min + ' 到 ' + max + ' 的整数'); return n; };
  let plans = DEFAULT_PLANS;
  if (env.BILLING_PLANS != null && env.BILLING_PLANS !== '') {
    let p;
    try { p = JSON.parse(env.BILLING_PLANS); } catch (e) { throw new Error('BILLING_PLANS 须是 JSON，例如 {"regulated":11000,"other":5500}'); }
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('BILLING_PLANS 须是 JSON 对象');
    for (const k of Object.keys(p)) {
      if (k !== 'regulated' && k !== 'other' && !CAT_KEYS.has(k)) throw new Error('BILLING_PLANS 里的 ' + k + ' 不是 regulated、other 或服务类别');
      if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 1000000) throw new Error('BILLING_PLANS 的金额须是 0 到 1000000 的整数（日元，含税）');
    }
    if (!('regulated' in p) || !('other' in p)) throw new Error('BILLING_PLANS 要有 regulated（士业）和 other（其他）两档');
    plans = p;
  } else if (real) throw new Error('MAIL_SENDER=' + sender.name + ' 时需要配置 BILLING_PLANS（展示费的价目表）');
  if (env.BILLING_PERIOD != null && env.BILLING_PERIOD !== '' && env.BILLING_PERIOD !== 'month') throw new Error('BILLING_PERIOD 现在只支持 month');
  const bankText = env.BILLING_BANK_TEXT || '';
  if (!bankText && real) throw new Error('MAIL_SENDER=' + sender.name + ' 时需要配置 BILLING_BANK_TEXT（振込先说明）');
  const regNo = env.BILLING_INVOICE_REG_NO || '';
  if (regNo && !/^T\d{13}$/.test(regNo)) throw new Error('BILLING_INVOICE_REG_NO 须是 T 加 13 位数字');
  return {
    plans, planVersion: 'p-' + crypto.createHash('sha256').update(JSON.stringify(Object.keys(plans).sort().map((k) => [k, plans[k]]))).digest('hex').slice(0, 8),
    period: 'month', issueDays: num('BILLING_ISSUE_DAYS', 14, 1, 28), firstDueDays: num('BILLING_FIRST_DUE_DAYS', 14, 1, 60), graceDays: num('BILLING_GRACE_DAYS', 7, 0, 60),
    bankText, regNo, method: 'manual_bank'
  };
}

// 期间：'YYYY-MM'（日本时间的自然月）
const periodOf = (ymd) => ymd.slice(0, 7);
const nextPeriod = (period) => { const [y, m] = period.split('-').map(Number); return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0'); };
const boundsOf = (period) => ({ start: period + '-01', end: addDays(nextPeriod(period) + '-01', -1) });
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// opts：{ store, clock, config（billingConfig 的结果）, methods（替换或追加收款方式）, appUrl（字符串或函数） }
function createBilling(opts) {
  const store = opts.store, cfg = opts.config || billingConfig({});
  const clock = opts.clock || (() => Date.now());
  const appUrl = () => String(typeof opts.appUrl === 'function' ? opts.appUrl() : opts.appUrl || 'http://localhost:8787').replace(/\/+$/, '');
  const methods = Object.assign({
    manual_bank: {
      name: '银行转账（人工确认入账）',
      instructions: (inv) => '付款方式：银行转账\n' + (cfg.bankText || '（振込先还没有配置：BILLING_BANK_TEXT）') + '\n转账时请在汇款人名称的前面写上参考编号 ' + inv.refCode + '，我们按它确认入账。手续费由付款方负担。'
    },
    migration: { name: '迁移（免费）', instructions: () => '这一期免费，不用付款。' },
    first_month_free: { name: '首月免费', instructions: () => '批准当月免费，不用付款。' }
  }, opts.methods || {});
  const method = opts.method || cfg.method;
  if (!methods[method]) throw new Error('没有这种收款方式：' + method);
  store.configureListing({ graceDays: cfg.graceDays });
  const msOf = (at) => (at != null ? new Date(at).getTime() : clock());
  const todayOf = (at) => jstToday(msOf(at));

  // 金额只能按类别从价目表取
  function planFor(category) {
    const regulated = !!REF.REGULATED[category];
    if (Object.prototype.hasOwnProperty.call(cfg.plans, category)) return { plan: category, amountYen: cfg.plans[category] };
    return regulated ? { plan: 'regulated', amountYen: cfg.plans.regulated } : { plan: 'other', amountYen: cfg.plans.other };
  }
  // 付款说明：手工转账写振込先和参考编号；在线支付的方式给付款链接
  function payText(inv) {
    const m = methods[inv.method] || methods[method];
    if (typeof m.instructions === 'function') return m.instructions(inv);
    return '付款方式：' + m.name + '\n付款链接：' + m.createCheckout(inv).payUrl;
  }
  function draft(category, period, dueDate) {
    const b = boundsOf(period), p = planFor(category);
    return { period, periodStart: b.start, periodEnd: b.end, plan: p.plan, amountYen: p.amountYen, taxYen: Math.floor(p.amountYen * 10 / 110), planVersion: cfg.planVersion, method, dueDate };
  }
  // 批准时记的“首月免费”覆盖：批准当月，金额 0、已付款，不是要付钱的账单（不发账单邮件，工作台不列出）。
  // 下个月的账单由 runOnce 按普通规则开。
  function firstInvoice(category, at) {
    const t = todayOf(at), b = boundsOf(periodOf(t));
    return { period: periodOf(t), periodStart: b.start, periodEnd: b.end, plan: FREE, amountYen: 0, taxYen: 0, planVersion: FREE, method: FREE, dueDate: t, status: 'paid', paidOn: t, paidBy: FREE };
  }
  // 给这家开某一期的账单（已经有了就不开），并排一封账单邮件（有联系邮箱时）。返回新账单的 id 或 null。
  function issueFor(providerId, period, at) {
    const p = store.getProvider(providerId);
    if (!p) return null;
    const t = todayOf(at), start = period + '-01';
    // 期限：下一期开始的前一天；开得晚了（不到 7 天）就从今天起 firstDueDays 天
    let due = addDays(start, -1);
    if (daysBetween(t, due) < 7) due = addDays(t, cfg.firstDueDays);
    return store.tx(() => {
      const id = store.createInvoice(Object.assign(draft(p.category, period, due), { providerId }));
      if (!id) return null;
      const c = store.providerContact(providerId), inv = store.getInvoice(id);
      if (c && !c.bounced && store.claimInvoiceReminder(id, 'issued')) {
        const m = TEXTS.invoiceIssued(inv, payText(inv), cfg.regNo);
        store.attachInvoiceReminder(id, 'issued', store.enqueueMail({ kind: 'billing', to: c.email, subject: m.subject, body: m.text }));
      }
      return id;
    });
  }
  const listed = (providerId, at) => store.providerListing(providerId, todayOf(at));
  // 付款提醒的档：还剩 2 到 7 天是 -7，1 天或当天是 -1，过了期限是 +1（过了宽限期就不再发 +1，只发不再展示的告知）
  const stageOf = (left) => (left < 0 ? '+1' : left <= 1 ? '-1' : left <= 7 ? '-7' : null);
  const ORDER = ['-7', '-1', '+1'];

  // 老服务商迁移（没有 provider_meta 的）：createApp 建好时跑一次，每一轮 runOnce 也先跑。返回迁移了几家。
  function migrate(at) {
    const b = boundsOf(periodOf(todayOf(at)));
    return store.migrateLegacyProviders(b.start.slice(0, 7), b.start, b.end, legacyIssues, (c) => feeModelOf(!!REF.REGULATED[c])).length;
  }
  // 跑一轮：老服务商补迁移账单、开下一期的账单、发提醒、过了宽限期的告知。跑多少次都不重复（账单按期唯一，邮件按 invoice_reminders 去重）。
  function runOnce(at) {
    const t = todayOf(at), cur = periodOf(t), next = nextPeriod(cur), res = { providers: 0, issued: 0, reminders: 0, hidden: 0, migrated: 0 };
    res.migrated = migrate(at);
    for (const p of store.billableProviders()) {
      res.providers++;
      const invs = store.listInvoices({ providerId: p.id });
      const overdue = invs.filter((i) => i.status === 'issued' && addDays(i.dueDate, cfg.graceDays) < t);
      // 有过了宽限期还没付的账单：先不开新的（付了或作废之后再开），免得一直开下去
      if (!overdue.length) {
        if (!store.invoiceFor(p.id, cur) && issueFor(p.id, cur, at)) res.issued++;
        if (daysBetween(t, next + '-01') <= cfg.issueDays && !store.invoiceFor(p.id, next) && issueFor(p.id, next, at)) res.issued++;
      }
      const c = store.providerContact(p.id);
      if (!c || c.bounced) continue;
      // 付款提醒
      for (const inv of store.listInvoices({ providerId: p.id, status: 'issued' })) {
        const left = daysBetween(t, inv.dueDate), stage = stageOf(left);
        if (!stage) continue;
        const sent = store.tx(() => {
          // 更早的档没发过的记成“错过”，不补发；过了宽限期的 +1 也不发
          for (const s of ORDER.slice(0, ORDER.indexOf(stage))) store.claimInvoiceReminder(inv.id, s);
          if (stage === '+1' && -left > cfg.graceDays) { store.claimInvoiceReminder(inv.id, '+1'); return false; }
          if (!store.claimInvoiceReminder(inv.id, stage)) return false;
          const m = TEXTS.invoiceReminder(inv, stage, payText(inv), cfg.regNo, cfg.graceDays);
          store.attachInvoiceReminder(inv.id, stage, store.enqueueMail({ kind: 'billing', to: c.email, subject: m.subject, body: m.text }));
          return true;
        });
        if (sent) res.reminders++;
      }
      // 过了宽限期、不再展示：宽限期最后一天还在名单上的才告知（“不再展示”要是真的），每张账单一次。
      // 不看有没有已付款的记录：首月免费的记录也是 paid，但首月里没领取令牌、之后才领取的服务商从来没展示过。
      const late = store.listInvoices({ providerId: p.id, status: 'issued' }).filter((i) => addDays(i.dueDate, cfg.graceDays) < t);
      if (late.length && !listed(p.id, at).listed && store.providerListing(p.id, addDays(late[0].dueDate, cfg.graceDays)).listed) {
        const inv = late[0];
        const sent = store.tx(() => {
          if (!store.claimInvoiceReminder(inv.id, 'hidden')) return false;
          const m = TEXTS.listingHidden(inv);
          store.attachInvoiceReminder(inv.id, 'hidden', store.enqueueMail({ kind: 'billing', to: c.email, subject: m.subject, body: m.text }));
          store.audit('provider.hidden', { id: p.id });
          return true;
        });
        if (sent) res.hidden++;
      }
    }
    return res;
  }

  // 发之前再看一眼（deliverOutbox 的 prepare，kind 是 billing 的）：服务商下架了、联系邮箱换了、账单已付款或作废、又展示了，就不发。
  function prepare(row) {
    if (row.kind !== 'billing') return undefined;
    const r = store.invoiceReminderOfMail(row.id), inv = r && store.getInvoice(r.invoiceId);
    const p = inv && store.getProvider(inv.providerId), c = p && store.providerContact(p.id);
    if (!inv || !p || !p.active || !c || c.email !== row.to) return null;
    if (r.stage === 'hidden') return listed(p.id).listed ? null : undefined;
    return inv.status === 'issued' ? undefined : null;
  }

  return { runOnce, migrate, prepare, issueFor, firstInvoice, planFor, payText, listed, todayOf, config: cfg, methods, CHECK_METHODS };
}

// 发件箱里每种邮件发之前由谁再看一眼：pnotice 新咨询通知、billing 账单，其余（期限提醒等）交给 scheduler
function prepareFor(parts) {
  return (row) => {
    if (row.kind === 'pnotice') return parts.notifier.prepare(row);
    if (row.kind === 'billing') return parts.billing.prepare(row);
    return parts.scheduler ? parts.scheduler.prepare(row) : undefined;
  };
}

module.exports = { createBilling, billingConfig, legacyIssues, prepareFor, periodOf, nextPeriod, boundsOf, DEFAULT_PLANS, CHECK_METHODS, FREE };

// npm run billing：跑一轮“老服务商迁移、开账单、发提醒、发新咨询通知、发件箱”，然后退出。给 cron 用；和正在运行的服务器用同一个库也不会重复发。
if (require.main === module) {
  const { createStore } = require('./store');
  const { createSender } = require('./mailer');
  const { reminderConfig } = require('./server');
  const { createScheduler } = require('./scheduler');
  const { createNotifier, notifyConfig } = require('./notifier');
  let sender, rem, bc, nc;
  try { sender = createSender(process.env); rem = reminderConfig(process.env, sender); bc = billingConfig(process.env, sender); nc = notifyConfig(process.env); } catch (e) { console.error('展示费没有配置好：' + e.message); process.exit(1); }
  let store;
  try { store = createStore(process.env.DB_FILE || path.join(__dirname, '..', 'zairyu.db')); } catch (e) { console.error('展示费：数据库打不开：' + String(e && e.message ? e.message : e).slice(0, 200)); process.exit(1); }
  const billing = createBilling({ store, config: bc, appUrl: rem.appUrl });
  const notifier = createNotifier({ store, config: nc, appUrl: rem.appUrl });
  const scheduler = createScheduler({ store, appUrl: rem.appUrl });
  let r, n;
  try { r = billing.runOnce(); n = notifier.runOnce(); } catch (e) { console.error('展示费：这一轮出错：' + String(e && e.message ? e.message : e).slice(0, 200)); process.exit(1); }
  deliverOutbox(store, sender, { prepare: prepareFor({ billing, notifier, scheduler }) }).then((d) => {
    console.log('展示费：看了 ' + r.providers + ' 家，开出 ' + r.issued + ' 张账单，排了 ' + r.reminders + ' 封付款提醒、' + r.hidden + ' 封不再展示的告知；新咨询通知 ' + n.mails + ' 封；发件箱这一轮发出 ' + d.sent + ' 封，失败 ' + d.failed + ' 封，不用发的 ' + d.dropped + ' 封');
    store.close(); process.exit(0);
  }, (e) => { console.error('展示费：发送时出错：' + String(e && e.message ? e.message : e).slice(0, 200)); process.exit(1); });
}
