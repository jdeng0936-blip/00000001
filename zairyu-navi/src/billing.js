// 服务商展示费：开账单、付款提醒、过了宽限期自动不展示。零依赖。
// 规则（docs/TODO.md 第 7 条，负责人的决定都按建议的默认做法）：
// - 按自然月（日本时间）收固定的展示费，分士业和其他两档，金额只按价目表（BILLING_PLANS）取，不看任何请求里的 amount；
//   不按咨询数、成交数收费；除了所有服务商都一样的 30 天免费期，没有给个别服务商调价、打折、免费期的口子。账单行里存下开票时的金额和价目表版本。
// - 免费期 30 天（负责人 2026-11-27 决定，同日改为按天数算，不再是“批准当月”）：批准日 D（日本时间）当天到 D + 30 天（含）不收费。
//   按民法的期间计算（初日不算入），30 天是 D+1 到 D+30，批准当天的半天另外白送，所以免费期一共是 31 个日历日，最后一天是 D+30。
//   批准时只记一条“免费期”的覆盖（invoices 里 method 为 first_month_free（名字是旧的，为兼容旧数据保留）、period 是批准当月、
//   period_start 是 D、period_end 是 D+30、金额 0、状态 paid，只用来算展示和第一期从哪天起收费，不发账单邮件，工作台的账单列表里不出现）。
//   服务商领取令牌后马上上名单（没领取的看不到咨询，所以不展示）；免费期本身只展示到 D+30（不加宽限，store.providerListing）；
//   免费期过后才领取令牌的，从第一次领取的那天（claimDayOf，日本时间）起收费，那个月按天折算，领取之前没展示的日子不收（billStartOf）；
//   这一期还没付时也从领取那天起展示到 期限 + 宽限，和领取在哪个月无关（store.providerListing）；
//   宽限从第一张账单的期限（就是 D+30）起算，和其他每一期一样是 BILLING_GRACE_DAYS 天。
// - 账单仍按自然月。免费期结束的第二天（D+31）落在月中时，第一张账单只收 D+31 到那个月最后一天，按天折算：
//   月额 × 收费天数 ÷ 当月天数，不足 1 日元的部分舍去（向下取整，只会少收不会多收）；D+31 是 1 日时就是整月。
//   这样免费期里的任何一天都不收费，收了费的每一天都在名单上（收费期间从 D+31 起，紧接着免费期，展示覆盖接得上）。
//   没有选“把免费期延到那个月底”：那样免费期最长会到将近 60 天，和“30 天”的决定不符；按天折算只是一行算式。
//   免费期整个盖住的月份（例如 1 月 30 日、31 日批准时的 2 月）不开账单。
// - 每一期（包括按天折算的第一期）都按同一条规则开：在“这一期开始收费的那天”之前 BILLING_ISSUE_DAYS 天开出，期限是开始收费的前一天
//   （第一期就是免费期的最后一天 D+30）；开得晚了、离期限不到 7 天的，期限是开出后 BILLING_FIRST_DUE_DAYS 天（期限 + 宽限天数之前照常展示）。
//   BILLING_ISSUE_DAYS 不超过 7 时每一期都走后一条；批准邮件里的期限由 firstPaid 用同一条规则（dueOf）算，和账单一致。
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
// 免费期的覆盖记录用的 plan、method、paidBy（名字是“首月免费”时定的，库里已有这个值，不改）
const FREE = 'first_month_free';
// 免费期的天数：批准日 + FREE_DAYS 天（含）为止免费
const FREE_DAYS = 30;
// 老服务商迁移时按入驻申请的规则查资料，返回问题的代号：category 类别不对、license 登录番号的格式或所属会不对（老服务商没有登记过所属会，
// 士业都会落在这里）、claims 名单上的文字有保证类用语或像是给助手下指令的内容。有问题的不自动展示（store.migrateLegacyProviders 记为 legacy-hold）。
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
// 按天折算：月额 × 收费天数 ÷ 当月天数，不足 1 日元舍去。整月（从 1 日起）原样返回。
const prorate = (fullYen, start, period) => {
  const b = boundsOf(period);
  if (start <= b.start) return fullYen;
  return Math.floor(fullYen * (daysBetween(start, b.end) + 1) / (daysBetween(b.start, b.end) + 1));
};
// 某一期从哪天开始收费：免费期最后一天（freeEnd，没有免费期为 null）之后的第一天、领取令牌的那天（claimDay，日本时间；老服务商为 null）
// 和这一期的 1 日，三者取最晚的；整个这一期都在免费期里或领取之前返回 null。没领取的日子不在名单上，所以不收费。
const billStartOf = (period, freeEnd, claimDay) => {
  const b = boundsOf(period);
  let s = freeEnd && freeEnd >= b.start ? addDays(freeEnd, 1) : b.start;
  if (claimDay && claimDay > s) s = claimDay;
  return s <= b.end ? s : null;
};

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
    first_month_free: { name: '免费期', instructions: () => '免费期，不用付款。' }
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
  // start：这一期开始收费的那天（默认 1 日）；晚于 1 日时金额按天折算
  function draft(category, period, dueDate, start) {
    const b = boundsOf(period), p = planFor(category), s = start && start > b.start ? start : b.start, amountYen = prorate(p.amountYen, s, period);
    return { period, periodStart: s, periodEnd: b.end, plan: p.plan, amountYen, taxYen: Math.floor(amountYen * 10 / 110), planVersion: cfg.planVersion, method, dueDate };
  }
  // 批准时记的“免费期”覆盖：批准当天到批准日 + FREE_DAYS 天，金额 0、已付款，不是要付钱的账单（不发账单邮件，工作台不列出）。
  // period 记批准当月（第一张要付钱的账单最早在 D+31，一定落在之后的月份，不会和它撞上“每家每期一张”）。之后的账单由 runOnce 开。
  function firstInvoice(category, at) {
    const t = todayOf(at);
    return { period: periodOf(t), periodStart: t, periodEnd: addDays(t, FREE_DAYS), plan: FREE, amountYen: 0, taxYen: 0, planVersion: FREE, method: FREE, dueDate: t, status: 'paid', paidOn: t, paidBy: FREE };
  }
  // 免费期之后的第一张账单会是什么样（批准邮件用；金额按现在的价目表）：{ period, periodStart, periodEnd, amountYen, fullYen, prorated, dueDate, issueOn }
  // 假定免费期里领取了令牌、定时任务按时跑：在 issueOn 开出，期限和 issueFor 用同一条规则算（BILLING_ISSUE_DAYS 不到 7 时期限不是免费期最后一天）。
  function firstPaid(category, freeEnd) {
    const s = addDays(freeEnd, 1), issueOn = addDays(s, -cfg.issueDays), due = dueOf(s, issueOn), d = draft(category, periodOf(s), due, s);
    return { period: d.period, periodStart: d.periodStart, periodEnd: d.periodEnd, amountYen: d.amountYen, fullYen: planFor(category).amountYen, prorated: d.periodStart !== boundsOf(d.period).start, dueDate: due, issueOn, firstDueDays: cfg.firstDueDays };
  }
  // 这家的免费期最后一天（没有免费期的记录，例如老服务商，返回 null）。旧数据里的记录 period_end 是批准当月的最后一天，同样按它算。
  function freeEndOf(providerId) {
    const f = store.listInvoices({ providerId }).find((i) => i.method === FREE && i.status !== 'void');
    return f ? f.periodEnd : null;
  }
  // 工作台用：免费期从哪天到哪天、是不是按“批准日 + 30 天”记的（旧数据是批准当月到月底）、免费期之后第一期从哪天起收费、是不是按天折算。
  // 没有免费期的记录（老服务商）返回 null
  function freeInfo(providerId) {
    const f = store.listInvoices({ providerId }).find((i) => i.method === FREE && i.status !== 'void');
    if (!f) return null;
    const cd = claimDayOf(providerId);
    let s = addDays(f.periodEnd, 1);
    if (cd && cd > s) s = cd;
    return { from: f.periodStart, until: f.periodEnd, days30: f.periodEnd === addDays(f.periodStart, FREE_DAYS), firstBillStart: s, firstProrated: s.slice(8) !== '01' };
  }
  // 经申请批准的服务商第一次领取令牌的那天（日本时间）；老服务商、还没领取的返回 null
  function claimDayOf(providerId) {
    const m = store.providerMeta(providerId);
    return m && m.source === 'apply' && m.claimedAt ? jstToday(Date.parse(m.claimedAt)) : null;
  }
  // 期限：开始收费的前一天；离开出那天不到 7 天时改为开出后 firstDueDays 天（firstPaid 和 issueFor 用同一条）
  const dueOf = (start, issuedOn) => { const d = addDays(start, -1); return daysBetween(issuedOn, d) < 7 ? addDays(issuedOn, cfg.firstDueDays) : d; };
  // 给这家开某一期的账单（已经有了就不开），并排一封账单邮件（有联系邮箱时）。返回新账单的 id 或 null。
  function issueFor(providerId, period, at) {
    const p = store.getProvider(providerId);
    if (!p) return null;
    const t = todayOf(at), start = billStartOf(period, freeEndOf(providerId), claimDayOf(providerId));
    if (!start) return null; // 这一期整个在免费期里（或者在领取令牌之前）
    // 期限：开始收费的前一天；开得晚了（不到 7 天）就从今天起 firstDueDays 天
    const due = dueOf(start, t);
    return store.tx(() => {
      const id = store.createInvoice(Object.assign(draft(p.category, period, due, start), { providerId }));
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
      // 当期和下一期：开始收费的那天（月初，或免费期结束的第二天）不到 issueDays 天、还没开过的就开。整期在免费期里的不开。
      if (!overdue.length) {
        const fe = freeEndOf(p.id), cd = claimDayOf(p.id);
        for (const period of [cur, next]) {
          const start = billStartOf(period, fe, cd);
          if (start && daysBetween(t, start) <= cfg.issueDays && !store.invoiceFor(p.id, period) && issueFor(p.id, period, at)) res.issued++;
        }
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
      // 不看有没有已付款的记录：免费期的记录也是 paid，但免费期里没领取令牌、之后才领取的服务商从来没展示过。
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

  return { runOnce, migrate, prepare, issueFor, firstInvoice, firstPaid, freeEndOf, claimDayOf, freeInfo, planFor, payText, listed, todayOf, config: cfg, methods, CHECK_METHODS };
}

// 发件箱里每种邮件发之前由谁再看一眼：pnotice 新咨询通知、billing 账单，其余（期限提醒等）交给 scheduler
function prepareFor(parts) {
  return (row) => {
    if (row.kind === 'pnotice') return parts.notifier.prepare(row);
    if (row.kind === 'billing') return parts.billing.prepare(row);
    return parts.scheduler ? parts.scheduler.prepare(row) : undefined;
  };
}

module.exports = { createBilling, billingConfig, legacyIssues, prepareFor, periodOf, nextPeriod, boundsOf, prorate, billStartOf, DEFAULT_PLANS, CHECK_METHODS, FREE, FREE_DAYS };

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
