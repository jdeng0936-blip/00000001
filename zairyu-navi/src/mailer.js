// 发邮件：发件方式（sender）、邮件的文字、把发件箱里排队的邮件发出去。零依赖。
// 所有邮件都先写进 outbox 表，再由 deliverOutbox 交给 sender。除了 console 这种本地方式，任何地方都不把邮件正文和收件地址写进日志。
// MAIL_SENDER 选发件方式：
//   outbox（默认）不联网，邮件留在 outbox 表里，测试和本地开发从那里读；
//   console        同上，另外把邮件打印出来；
//   http           向 MAIL_HTTP_URL 发一个 POST（Authorization: Bearer MAIL_HTTP_KEY），正式环境先用这个；
//   smtp           465 端口的 TLS 直连（不支持 STARTTLS），AUTH PLAIN；对方只支持 LOGIN 时用 AUTH LOGIN。
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const oneLine = (s, what) => { s = String(s); if (/[\r\n\0]/.test(s)) throw new Error(what + '里不能有换行'); return s; };
const addrOf = (from) => (/<([^<>]+)>\s*$/.exec(from) || [null, from])[1].trim(); // “名称 <a@b>” 取出 a@b

// 邮件标题里的非 ASCII 文字按 RFC 2047 编码，每段不超过 75 个字符（按字切，不把一个字切成两半）
function encodeHeader(s) {
  s = oneLine(s, '邮件标题');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const out = []; let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 45) { out.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((p) => '=?UTF-8?B?' + Buffer.from(p, 'utf8').toString('base64') + '?=').join('\r\n ');
}
// 收件地址里不能有空白和尖括号（不然能往 SMTP 命令里夹东西）
const mailbox = (to) => { to = oneLine(to, '收件人'); if (!to || /[\s<>]/.test(to)) throw new Error('收件地址无效'); return to; };
// 发件人写成“名称 <a@b>”时，名称里的中文要编码
function fromHeader(from) {
  const m = /^(.*)<([^<>\s]+)>\s*$/.exec(oneLine(from, '发件人'));
  if (!m) return mailbox(from.trim());
  const name = m[1].trim().replace(/^"|"$/g, '');
  return (name ? (/^[\x20-\x7e]*$/.test(name) ? '"' + name.replace(/["\\]/g, '') + '"' : encodeHeader(name)) + ' ' : '') + '<' + m[2] + '>';
}
// 一封完整的邮件（头和正文，行尾 CRLF）。正文按 base64 传，中文不会乱码。
function buildMessage(m, from, nowMs) {
  const head = [
    'From: ' + fromHeader(from), 'To: ' + mailbox(m.to), 'Subject: ' + encodeHeader(m.subject),
    'Date: ' + new Date(nowMs == null ? Date.now() : nowMs).toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomUUID() + '@' + (addrOf(from).split('@')[1] || 'localhost') + '>',
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'
  ];
  for (const k of Object.keys(m.headers || {})) { if (!/^[A-Za-z0-9-]+$/.test(k)) throw new Error('邮件头的名称无效'); head.push(k + ': ' + oneLine(m.headers[k], '邮件头')); }
  const body = Buffer.from(String(m.text), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return head.join('\r\n') + '\r\n\r\n' + body;
}
// SMTP 的 DATA 段：行尾统一成 CRLF，以点开头的行前面再加一个点，最后以单独一行的点结束
function smtpData(message) {
  const lines = String(message).replace(/\r\n|\r|\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n') + '\r\n.\r\n';
}

function httpSender(cfg) {
  return {
    name: 'http', dev: false, timeoutMs: cfg.timeoutMs,
    async send(m) {
      const r = await fetch(cfg.url, {
        method: 'POST', signal: AbortSignal.timeout(cfg.timeoutMs),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify({ from: cfg.from, to: m.to, subject: m.subject, text: m.text, headers: m.headers || {} })
      });
      const text = await r.text().catch(() => '');
      if (!r.ok) throw new Error('邮件接口返回 ' + r.status);
      let id; try { id = JSON.parse(text).id; } catch (e) { /* 对方没有返回 JSON，不要紧 */ }
      return typeof id === 'string' ? { id } : {};
    }
  };
}

function smtpSender(cfg) {
  return {
    name: 'smtp', dev: false, timeoutMs: cfg.timeoutMs,
    send(m) {
      const message = buildMessage(m, cfg.from); // 写法不对的地址、标题在连接之前就报错
      const rcpt = mailbox(m.to);
      return new Promise((ok, fail) => {
        const sock = tls.connect(Object.assign({ host: cfg.host, port: cfg.port, servername: cfg.host }, cfg.tls || {}));
        let buf = '', step = 0, done = false, accepted = false, reply = [];
        // 邮件被对方接受（DATA 之后的 250）以后，连接怎么结束都算发成了
        const finish = (err) => { if (done) return; done = true; sock.destroy(); if (err && !accepted) fail(err); else ok({}); };
        const b64 = (x) => Buffer.from(x, 'utf8').toString('base64');
        const rest = [
          [235, () => 'MAIL FROM:<' + addrOf(cfg.from) + '>\r\n'],
          [250, () => 'RCPT TO:<' + rcpt + '>\r\n'],
          [250, () => 'DATA\r\n'],
          [354, () => smtpData(message)],
          [250, () => 'QUIT\r\n']
        ];
        // 每一步：期待的应答码，和收到之后要发的下一条命令。登录的几步要看对方在 EHLO 里说支持哪种方式，收到之后再排进来。
        const steps = [
          [220, () => 'EHLO ' + (cfg.helo || os.hostname() || 'localhost') + '\r\n'],
          [250, (lines) => {
            const auth = (lines.find((l) => /^250[ -]AUTH[ =]/i.test(l)) || '').toUpperCase().split(/[ =]+/).slice(1);
            // 优先 PLAIN；对方只说了 LOGIN 就用 LOGIN（账号、密码各发一次，每次等一个 334）；什么都没说也按 PLAIN 试
            if (auth.includes('LOGIN') && !auth.includes('PLAIN')) {
              steps.push([334, () => b64(cfg.user) + '\r\n'], [334, () => b64(cfg.pass) + '\r\n'], ...rest);
              return 'AUTH LOGIN\r\n';
            }
            steps.push(...rest);
            return 'AUTH PLAIN ' + b64('\0' + cfg.user + '\0' + cfg.pass) + '\r\n';
          }]
        ];
        sock.setEncoding('utf8');
        sock.setTimeout(cfg.timeoutMs, () => finish(new Error('SMTP 超时')));
        sock.on('error', (e) => finish(new Error('SMTP 连接失败：' + e.message)));
        sock.on('close', () => finish(new Error('SMTP 连接中断')));
        sock.on('data', (d) => {
          buf += d;
          let i;
          while (!done && (i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
            reply.push(line);
            if (/^\d{3}-/.test(line)) continue; // 多行应答，等最后一行
            const lines = reply; reply = [];
            if (accepted) return finish(); // 对方对 QUIT 的应答（221）
            const code = +line.slice(0, 3);
            if (code !== steps[step][0]) return finish(new Error('SMTP 第 ' + (step + 1) + ' 步被拒绝：' + line.slice(0, 120)));
            sock.write(steps[step][1](lines)); step++;
            if (step === steps.length) { accepted = true; sock.setTimeout(2000); } // QUIT 已发出：等对方说再见，等不到也不算失败
          }
        });
      });
    }
  };
}

// env 是环境变量那样的对象。设置不全时直接抛错，服务器不启动（比上线后才发现发不出邮件要好）。
function createSender(env, deps) {
  env = env || {}; deps = deps || {};
  const kind = env.MAIL_SENDER || 'outbox';
  const need = (names) => { const miss = names.filter((n) => !env[n]); if (miss.length) throw new Error('MAIL_SENDER=' + kind + ' 需要配置 ' + miss.join('、')); };
  const timeoutMs = +env.MAIL_TIMEOUT_MS || 15000;
  if (kind === 'outbox') return { name: 'outbox', dev: true, send: async () => ({}) };
  if (kind === 'console') {
    const print = deps.log || console.log;
    return { name: 'console', dev: true, send: async (m) => { print('—— 邮件 ——\nTo: ' + m.to + '\nSubject: ' + m.subject + '\n\n' + m.text + '\n————'); return {}; } };
  }
  if (kind === 'http') {
    need(['MAIL_FROM', 'MAIL_HTTP_URL', 'MAIL_HTTP_KEY']);
    if (!/^https?:\/\//.test(env.MAIL_HTTP_URL)) throw new Error('MAIL_HTTP_URL 须以 http:// 或 https:// 开头');
    // 各家邮件服务的请求格式不一样，选定服务商后在这里加；现在只有通用格式
    if (env.MAIL_HTTP_PRESET && env.MAIL_HTTP_PRESET !== 'generic') throw new Error('MAIL_HTTP_PRESET 现在只支持 generic');
    return httpSender({ url: env.MAIL_HTTP_URL, key: env.MAIL_HTTP_KEY, from: oneLine(env.MAIL_FROM, 'MAIL_FROM'), timeoutMs });
  }
  if (kind === 'smtp') {
    need(['MAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
    return smtpSender({ host: env.SMTP_HOST, port: +env.SMTP_PORT || 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: oneLine(env.MAIL_FROM, 'MAIL_FROM'), timeoutMs, tls: deps.tls, helo: deps.helo });
  }
  throw new Error('MAIL_SENDER 须为 outbox、console、http、smtp 之一');
}

// ---- 邮件的文字。验证码只出现在正文里，不放进标题；验证码和通知邮件里不放链接（防仿冒邮件骗人点链接）。 ----
// 提醒邮件有三种链接：这条期限的依据（官方页面，规则里有的才带）、打开在留导航、退订。
const SIGN = '\n\n—— 在留导航\n这是系统自动发出的邮件，请不要直接回复。';
const jst = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') + '（日本时间）';
// YYYY-MM-DD 写成“2026年12月4日”。提醒的到期日是日本时间的日历日，直接按文字拆，不经过时区换算。
const cnDate = (ymd) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd); return m ? m[1] + '年' + (+m[2]) + '月' + (+m[3]) + '日' : String(ymd); };
// 真正的期限写“到期”；只是该留意、该开始准备的日子（在留更新的准备、入境满 6 个月去银行、住民税缴款单这类）不写“到期”
const leftText = (n, dl) => (n === 0 ? '今天' : n === 1 ? '明天' : '还有 ' + n + ' 天') + (dl && n <= 1 ? '到期' : '');
// 依据里的链接只接受 https 开头、没有空白的地址（和网页上的规则一样）
const okUrl = (u) => typeof u === 'string' && /^https:\/\/\S+$/.test(u);
// 提醒邮件。items：[{ due: 'YYYY-MM-DD', daysLeft, txt, src, dl }]（按日期排好；dl 为真的是期限，其余是该留意的日子）；appUrl：应用的地址；unsubUrl：这位用户的退订链接。
// 邮件里只有：日期、还有几天、这件事的说明、依据的链接（规则里有的才带）、应用的链接、退订链接。不写姓名、在留资格的类型、账号编号，也不写别的提醒。
// 事件期限的说明用的是不分在留资格的写法（引擎规则里的 mail），所以从邮件的文字看不出收件人是哪种在留资格。
function reminderMail(items, appUrl, unsubUrl) {
  const n = items.length, soon = Math.min.apply(null, items.map((x) => x.daysLeft)), allDl = items.every((x) => x.dl);
  // 这一封里全是期限才说“到期”；混着别的日子就说“要留意”
  const subject = '【在留导航】' + (!allDl ? '有 ' + n + ' 件事要留意' : soon === 0 ? '有 ' + n + ' 件事今天到期' : soon === 1 ? '有 ' + n + ' 件事明天到期' : '有 ' + n + ' 件事快到期限');
  const blocks = items.map((x, i) => {
    const lines = [(i + 1) + '. ' + cnDate(x.due) + '（' + leftText(x.daysLeft, x.dl) + '）', '   ' + x.txt];
    const s = x.src;
    if (s && okUrl(s.url)) { lines.push('   依据：' + s.law + '（' + s.title + '）', '   ' + s.url); }
    for (const m of (s && Array.isArray(s.more) ? s.more : [])) if (okUrl(m.url)) lines.push('   ' + m.title, '   ' + m.url);
    return lines.join('\n');
  });
  const text = '你在在留导航里打开了邮件提醒。' + (allDl ? '下面的事快到期限了：' : '下面的事到了该留意的日子（写着“到期”的是期限，其余是该开始办或该留意的日子）：') + '\n\n' + blocks.join('\n\n') +
    '\n\n查看全部提醒、把办完的事标成已完成（标了以后不再提醒）：\n' + appUrl + '/#reminders' +
    '\n\n日期是按你填的情况推算的，只供参考，不是针对你个人情况的意见；期限以官署的通知和说明为准。邮件可能晚到或收不到，请不要只靠邮件记期限。' +
    '\n\n不想再收到提醒邮件：打开下面的链接点“退订”，不用登录；也可以在应用的“账号和邮箱”里关掉。\n' + unsubUrl + SIGN;
  // 邮件客户端的“退订”按钮用这两个头（RFC 8058 的一键退订）
  return { subject, text, headers: { 'List-Unsubscribe': '<' + unsubUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}
const TEXTS = {
  reminder: reminderMail,
  bindCode: (code) => ({ subject: '【在留导航】绑定邮箱的验证码', text: '你正在把这个邮箱绑定到在留导航的账号上。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。\n\n不是你本人操作的话，不用理会这封邮件，什么都不会发生。请不要把验证码告诉任何人，我们不会向你要验证码。' + SIGN }),
  recoverCode: (code) => ({ subject: '【在留导航】找回账号的验证码', text: '你正在用这个邮箱在另一台设备上找回在留导航的账号。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。\n\n不是你本人操作的话，不用理会这封邮件，没有验证码对方进不了你的账号。请不要把验证码告诉任何人，我们不会向你要验证码。' + SIGN }),
  taken: () => ({ subject: '【在留导航】这个邮箱已经绑定过账号', text: '刚才有人想把这个邮箱绑定到一个在留导航账号上，但这个邮箱已经绑定了另一个账号，所以没有绑定成功，也没有发验证码。\n\n是你本人的话：想回到原来的账号，在新设备上打开在留导航，在“开始之前”的窗口里点“已有账号？用邮箱找回”；想把邮箱换到新账号上，先在原来的账号里解除绑定。\n\n不是你本人的话，不用理会这封邮件。' + SIGN }),
  // 换绑、解除时发给原来那个邮箱的告知。不写新邮箱是什么。
  emailChanged: (ms) => ({ subject: '【在留导航】账号绑定的邮箱已经更换', text: '你的在留导航账号原来绑定的是这个邮箱，刚才已经换成了另一个邮箱。从现在起，这个邮箱不能再用来找回账号，也不会再收到在留导航的邮件。\n\n更换时间：' + jst(ms) + '\n\n是你本人的话，不用做任何事。\n\n不是你本人的话：在还登录着的设备上打开在留导航，到“闯关”页的“我的情况”里找到“账号和邮箱”，点“让其他设备退出登录”，再把邮箱换回来；并留意这个邮箱本身的安全（改邮箱密码）。' + SIGN }),
  emailRemoved: (ms) => ({ subject: '【在留导航】账号绑定的邮箱已经解除', text: '你的在留导航账号原来绑定的是这个邮箱，刚才已经解除了绑定，我们保存的这个邮箱地址已删除。从现在起，这个邮箱不能再用来找回账号，也不会再收到在留导航的邮件。\n\n解除时间：' + jst(ms) + '\n\n是你本人的话，不用做任何事。\n\n不是你本人的话：在还登录着的设备上打开在留导航，到“闯关”页的“我的情况”里找到“账号和邮箱”，点“让其他设备退出登录”，再重新绑定邮箱；并留意这个邮箱本身的安全（改邮箱密码）。' + SIGN }),
  newDevice: (ms) => ({ subject: '【在留导航】有一台新设备登录了你的账号', text: '有人用发到这个邮箱的验证码，在一台新设备上登录了你的在留导航账号。原来的设备仍然保持登录。\n\n登录时间：' + jst(ms) + '\n\n是你本人的话，不用做任何事。\n\n不是你本人的话：在自己的设备上打开在留导航，到“闯关”页的“我的情况”里找到“账号和邮箱”，点“让其他设备退出登录”，并留意这个邮箱本身的安全（改邮箱密码）。' + SIGN })
};

// 错误说明要存进库、可能进日志：里面像邮箱的东西一律换掉（SMTP 服务器的拒绝说明里常带着收件地址）
const scrub = (e) => String(e && e.message ? e.message : e).replace(/[^\s<>"(),;:]+@[^\s<>"'(),;:]+/g, '［邮箱］'); // @ 前面可以有单引号（o'brien@…）

// 把发件箱里到时间的邮件交给 sender。发不出去的按退避重试（次数和间隔在 store.markFailed）。
// 一封一封地占下再发（store.claimNext）：占的时间只要比发一封最慢的情况长就够，一轮发多久都不会让另一个进程把同一封再发一遍。
// 用 outbox、console 这两种本地方式时邮件原样留着；真实发信时验证码邮件发完就清掉正文和收件地址。
// opts.prepare(row)：发之前再看一眼（提醒邮件用）。返回 null 表示不该发了，这封记为 dropped；返回 { subject, text, headers } 则按它发。
async function deliverOutbox(store, sender, opts) {
  const prepare = opts && opts.prepare;
  const lease = Math.max(10 * 60 * 1000, 4 * (sender.timeoutMs || 0));
  const seen = new Set();
  let sent = 0, failed = 0, dropped = 0;
  for (;;) {
    const row = store.claimNext(lease);
    if (!row || seen.has(row.id)) break; // 同一封在一轮里不发第二次
    seen.add(row.id);
    try {
      // 占位行不是邮件（见 store.enqueuePad）：不发，做完同样的读写就删掉
      if (row.kind === 'pad') { await null; store.finishPad(row.id); continue; }
      let m = { to: row.to, subject: row.subject, text: row.body, headers: row.headers || undefined };
      if (prepare) {
        const p = prepare(row);
        if (p === null) { store.dropMail(row.id, '发之前已不需要'); dropped++; continue; }
        if (p) {
          m = { to: row.to, subject: p.subject, text: p.text, headers: p.headers || undefined };
          if (p.subject !== row.subject || p.text !== row.body) store.updateMail(row.id, { subject: p.subject, body: p.text, headers: p.headers });
        }
      }
      await sender.send(m);
      store.markSent(row.id, !sender.dev); sent++;
    } catch (e) { store.markFailed(row.id, scrub(e)); failed++; }
  }
  return { sent, failed, dropped };
}

module.exports = { createSender, deliverOutbox, TEXTS, buildMessage, smtpData, encodeHeader, scrub };
