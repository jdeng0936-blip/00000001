// 期限提醒邮件的定时任务。零依赖。
// 做的事：找出同意收提醒的账号，用规则引擎（src/engine.js，日期一律是日本时间的日历日）算出各自的提醒，
// 到期前 7 天、前 1 天、当天各发一封；同一位用户同一轮里到期的几件事合成一封。
// 不会重复发：每条提醒的每一档先在 reminder_sends 表里占一行（主键是 账号、提醒、到期日、档），占到了才发；
// 占位和排进发件箱在同一个事务里，所以重启、两轮同时跑、两个进程一起跑都只发一次。
// 运行方式：npm start 时设 REMINDERS_ENABLED=1（进程里的定时器）；或者由 cron 跑 npm run remind（跑一轮就退出）。
const crypto = require('node:crypto');
const path = require('node:path');
const createEngine = require('./engine');
const { TEXTS, deliverOutbox } = require('./mailer');

const STAGES = [7, 1, 0]; // 到期前几天各发一封
const DAY = 24 * 60 * 60 * 1000;
// 只提醒有确定日期的事：法定期限、在留、事件、银行、每年的税务日期。其中真正的期限由引擎标出（dl），
// 其余（在留更新的几个准备节点、入境满 6 个月去银行、住民税缴款单、年末调整）是该留意的日子，邮件里不写“到期”。
// “路线”“习惯”“方案”“每月”“邮箱示例”这些标签，和“现在是……的时期”这类提醒，日期总是“今天”或每月滚动，不是期限，不发邮件。
const TAGS = new Set(['法定期限', '在留', '事件', '银行', '每年']);
const NOT_A_DEADLINE = /^现在是|示例|订阅/;
const rkeyOf = (tag, txt) => crypto.createHash('sha256').update(tag + '|' + txt).digest('hex');
// 日本时间的日历日，用 UTC 零点的毫秒数表示（和引擎里的算法一样，和服务器所在时区无关）
const jstDayMs = (ms) => Math.floor((ms + 9 * 60 * 60 * 1000) / DAY) * DAY;
const jstHour = (ms) => new Date(ms + 9 * 60 * 60 * 1000).getUTCHours();
// 这几天该发哪一档：当天 0，前一天 1，还剩 2 到 7 天都算“7 天前”那一档（中途才打开提醒、或停机几天后恢复，补发一封而不是三封）
const stageOf = (daysLeft) => (daysLeft === 0 ? 0 : daysLeft === 1 ? 1 : 7);

// opts：{ store, appUrl（字符串或返回字符串的函数）, clock（毫秒时间）, now（固定的“今天”，测试用） }
function createScheduler(opts) {
  const store = opts.store;
  const clock = opts.clock || (() => Date.now());
  const appUrl = () => String(typeof opts.appUrl === 'function' ? opts.appUrl() : opts.appUrl || 'http://localhost:8787').replace(/\/+$/, '');
  const nowMs = (at) => (at != null ? new Date(at).getTime() : opts.now != null ? new Date(opts.now).getTime() : clock());

  // 这个账号眼下 0 到 7 天内到期的提醒。办完的任务、删掉的事件、改过的日期，引擎算出来就已经没有了。
  function dueItems(u, ms) {
    const today = jstDayMs(ms), out = [], seen = new Set();
    const eng = createEngine({ profile: u.profile, done: u.done, plan: u.plan, auth: u.auth, events: store.listEvents(u.id), now: ms });
    for (const r of eng.reminders()) {
      if (!TAGS.has(r.tag) || NOT_A_DEADLINE.test(r.txt)) continue;
      const daysLeft = Math.round((Date.parse(r.date + 'T00:00:00Z') - today) / DAY);
      if (!(daysLeft >= 0 && daysLeft <= STAGES[0])) continue;
      const rkey = rkeyOf(r.tag, r.txt);
      if (seen.has(rkey + r.date)) continue; // 同一件事记了两次（例如同一天的两条相同事件）只算一条
      seen.add(rkey + r.date);
      // 邮件里用不分在留资格的说明和依据（规则里有 mail 的用 mail）；去重用的 rkey 仍按页面上的那句话算
      out.push({ rkey, due: r.date, daysLeft, stage: stageOf(daysLeft), txt: r.mail || r.txt, src: (r.mail ? r.msrc || r.src : r.src) || null, dl: !!r.dl });
    }
    return out; // 引擎已按日期排好
  }
  const render = (items, target) => TEXTS.reminder(items, appUrl(), appUrl() + '/api/unsubscribe?t=' + encodeURIComponent(target.unsubToken));

  // 另一个进程正占着库、等了也没等到（SQLite 报 locked 或 busy）：这个账号再试两次，还不行才算出错
  const busyRetry = (fn) => { for (let i = 0; ; i++) { try { return fn(); } catch (e) { if (i >= 2 || !/locked|busy/i.test(String(e && e.message))) throw e; } } };

  // 跑一轮。at：把“现在”定在某个时刻（测试、补跑用），不传就用时钟。
  // 返回 { users 看了几个账号, mails 排了几封, items 这几封里一共几条, errors 几个账号处理出错 }
  function runOnce(at) {
    const ms = nowMs(at), res = { users: 0, mails: 0, items: 0, errors: 0 };
    for (const userId of store.remindableUsers()) {
      res.users++;
      try {
        const u = store.getUser(userId);
        if (!u) continue;
        const items = dueItems(u, ms);
        if (!items.length) continue;
        const n = busyRetry(() => store.tx(() => {
          const target = store.remindTarget(userId); // 在事务里再确认一次：刚刚退订的不发
          if (!target) return 0;
          const fresh = [];
          for (const it of items) {
            if (store.claimReminder(userId, it.rkey, it.due, it.stage, 'queued')) fresh.push(it);
            // 更早的档没发过的记成“错过”，以后也不补发
            for (const s of STAGES) if (s > it.stage) store.claimReminder(userId, it.rkey, it.due, s, 'skipped');
          }
          if (!fresh.length) return 0;
          const mail = render(fresh, target);
          const id = store.enqueueMail({ userId, kind: 'reminder', to: target.email, subject: mail.subject, body: mail.text, headers: mail.headers });
          store.attachReminders(userId, fresh, id);
          return fresh.length;
        }));
        if (n) { res.mails++; res.items += n; }
      } catch (e) {
        // 一个账号出错不影响别的账号；日志里不写账号编号、邮箱和提醒内容
        res.errors++; console.error('提醒邮件：有一个账号没有处理成：' + String(e && e.message ? e.message : e).slice(0, 200));
      }
    }
    return res;
  }

  // 发之前再看一眼（deliverOutbox 的 prepare）。排队期间（包括失败后等重试的那段时间）用户可能已经办完、改了日期、删了事件、退订、换了邮箱：
  // 还没过期、还在提醒里的那几条按当下的天数重写正文；一条都不剩，或者不该再发，就返回 null（不发）。
  function prepare(row, at) {
    if (row.kind !== 'reminder') return undefined;
    const target = row.userId ? store.remindTarget(row.userId) : null;
    const u = target && target.email === row.to ? store.getUser(row.userId) : null;
    if (!u) return null;
    // 只留“还是当初那一档”的：拖到下一档的日子才轮到重试的，由下一档自己的那封邮件来说
    const want = new Map(store.remindersOfMail(row.id).map((r) => [r.rkey + r.due, r.stage]));
    const items = dueItems(u, nowMs(at)).filter((it) => want.get(it.rkey + it.due) === it.stage);
    return items.length ? render(items, target) : null;
  }

  return { runOnce, prepare, dueItems };
}

// 进程里的定时器（npm start 且 REMINDERS_ENABLED=1）：启动 5 秒后看一次，之后每隔 intervalMin 分钟看一次；日本时间 hour 点之前不跑。
// 轮到的时候还没到点，就另外定一个到点的闹钟：不然间隔很长（例如 1440 分钟）而每次都落在几点之前的话，会一封都发不出去。
// deps：{ now, setTimeout, setInterval }，测试用假的；返回 { tick }。
function startReminderTimer(cfg, run, deps) {
  deps = deps || {};
  const now = deps.now || (() => Date.now()), st = deps.setTimeout || setTimeout, si = deps.setInterval || setInterval;
  // 建过的定时器都记下来，stop() 一起清掉（停机时用）；停了之后 tick 不再跑
  const handles = [], ct = deps.clearTimeout || clearTimeout;
  const unref = (h) => { handles.push(h); if (h && typeof h.unref === 'function') h.unref(); return h; };
  let waiting = false, stopped = false;
  const tick = () => {
    if (stopped) return;
    const t = now();
    if (jstHour(t) < cfg.hour) {
      if (!waiting) { waiting = true; unref(st(() => { waiting = false; tick(); }, jstDayMs(t) + cfg.hour * 60 * 60 * 1000 - (t + 9 * 60 * 60 * 1000) + 1000)); }
      return;
    }
    run();
  };
  unref(st(tick, 5000));
  unref(si(tick, cfg.intervalMin * 60 * 1000));
  return { tick, stop() { stopped = true; handles.forEach((h) => ct(h)); } };
}

module.exports = { createScheduler, startReminderTimer, STAGES, jstHour };

// npm run remind：跑一轮，把到时间的邮件发掉，然后退出。给 cron 用；和正在运行的服务器用同一个数据库文件也不会重复发。
if (require.main === module) {
  const { createStore } = require('./store');
  const { createSender } = require('./mailer');
  const { reminderConfig } = require('./server');
  let sender, cfg;
  try { sender = createSender(process.env); cfg = reminderConfig(process.env, sender); } catch (e) { console.error('提醒邮件没有配置好：' + e.message); process.exit(1); }
  // 库打不开（路径不对、另一个进程占着太久）：说清楚原因后退出，不打印一大段调用栈；cron 下一轮再跑
  let store;
  try { store = createStore(process.env.DB_FILE || path.join(__dirname, '..', 'zairyu.db')); } catch (e) { console.error('提醒邮件：数据库打不开：' + String(e && e.message ? e.message : e).slice(0, 200)); process.exit(1); }
  const sch = createScheduler({ store, appUrl: cfg.appUrl });
  const r = sch.runOnce();
  deliverOutbox(store, sender, { prepare: (row) => sch.prepare(row) }).then((d) => {
    console.log('提醒邮件：看了 ' + r.users + ' 个账号，新排了 ' + r.mails + ' 封（' + r.items + ' 条提醒）；发件箱这一轮发出 ' + d.sent + ' 封，失败 ' + d.failed + ' 封，不用发的 ' + d.dropped + ' 封' + (r.errors ? '；有 ' + r.errors + ' 个账号处理出错' : ''));
    store.close(); process.exit(r.errors ? 1 : 0);
  }, (e) => { console.error('提醒邮件：发送时出错：' + String(e && e.message ? e.message : e).slice(0, 200)); process.exit(1); });
}
