// 新咨询通知：服务商收到新咨询后，给联系邮箱发一封摘要邮件。零依赖。
// - store.addInquiry 在同一个事务里记下 provider_notices.pending_since（服务商开着通知、有联系邮箱、没退信时）；已经记着的不动。
// - runOnce：第一条新咨询之后过了 PROVIDER_NOTIFY_DELAY_MIN 分钟、离上一封过了 PROVIDER_NOTIFY_INTERVAL_MIN 分钟的，各排一封，这段时间的合成一封。
// - 邮件里只有“有 N 条新咨询（类别）”、工作台链接和关闭通知的链接；没有咨询内容、节点、用户的任何信息。outbox 的 user_id 留空，和用户删账号互不影响。
// - 发送前 prepare 再看一次：服务商下架、关了通知、换了邮箱、这段时间的新咨询数变成 0（用户删了账号），任何一种都不发；数量按当时的重写。
const createEngine = require('./engine');
const { TEXTS } = require('./mailer');

const REF = createEngine({});
const catName = (k) => { const c = REF.CATS.find((x) => x[0] === k); return c ? c[1] : k; };

function notifyConfig(env) {
  env = env || {};
  const num = (name, def, min, max) => { if (env[name] == null || env[name] === '') return def; const n = Number(env[name]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(name + ' 须是 ' + min + ' 到 ' + max + ' 的整数'); return n; };
  return { delayMin: num('PROVIDER_NOTIFY_DELAY_MIN', 5, 0, 1440), intervalMin: num('PROVIDER_NOTIFY_INTERVAL_MIN', 60, 1, 1440) };
}

// opts：{ store, clock, config（notifyConfig 的结果）, appUrl（字符串或函数） }
function createNotifier(opts) {
  const store = opts.store, cfg = opts.config || notifyConfig({});
  const clock = opts.clock || (() => Date.now());
  const appUrl = () => String(typeof opts.appUrl === 'function' ? opts.appUrl() : opts.appUrl || 'http://localhost:8787').replace(/\/+$/, '');
  const render = (n, category, unsubToken) => TEXTS.newInquiry(n, catName(category), appUrl() + '/provider.html', appUrl() + '/api/provider-unsubscribe?t=' + encodeURIComponent(unsubToken));
  // 现在能不能给这家发：在架、有联系邮箱、开着通知、没退信
  const target = (providerId) => {
    const p = store.getProvider(providerId), c = p && p.active ? store.providerContact(providerId) : null;
    return c && c.notify && !c.bounced ? { p, c } : null;
  };

  // 跑一轮，返回 { mails 排了几封, skipped 数量是 0 或不该发的 }
  function runOnce() {
    const res = { mails: 0, skipped: 0 };
    for (const d of store.dueNotices(cfg.delayMin * 60000, cfg.intervalMin * 60000)) {
      store.tx(() => {
        const to = new Date(clock()).toISOString(), n = store.countInquiries(d.providerId, d.pendingSince, to), tg = target(d.providerId);
        if (!n || !tg) { store.noticeQueued(d.providerId, d.pendingSince, to, null); res.skipped++; return; }
        const m = render(n, tg.p.category, tg.c.unsubToken);
        store.noticeQueued(d.providerId, d.pendingSince, to, store.enqueueMail({ kind: 'pnotice', to: tg.c.email, subject: m.subject, body: m.text, headers: m.headers }));
        res.mails++;
      });
    }
    return res;
  }

  function prepare(row) {
    if (row.kind !== 'pnotice') return undefined;
    const w = store.noticeOfMail(row.id), tg = w && target(w.providerId);
    if (!tg || tg.c.email !== row.to) return null;
    const n = store.countInquiries(w.providerId, w.winStart, w.winEnd);
    return n ? render(n, tg.p.category, tg.c.unsubToken) : null;
  }

  return { runOnce, prepare, config: cfg };
}

module.exports = { createNotifier, notifyConfig, catName };
