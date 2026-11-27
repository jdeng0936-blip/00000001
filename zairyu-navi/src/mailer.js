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
// ---- 服务商入驻、账单、新咨询通知的邮件。所有邮件里都不出现服务商令牌（令牌只在工作台上用联系邮箱的验证码领取，只显示一次）。 ----
const yen = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 日元';
// 账单的几行：参考编号、期间、金额；填了适格请求书的登记号（regNo）时加上登记号、税率和税额
function invoiceLines(inv, regNo) {
  const l = ['参考编号：' + inv.refCode, '期间：' + cnDate(inv.periodStart) + ' 至 ' + cnDate(inv.periodEnd), '金额：' + yen(inv.amountYen) + '（含税）'];
  if (regNo) l.push('其中消费税（10%）：' + yen(inv.taxYen), '适格请求书发行事业者登记号：' + regNo);
  l.push('付款期限：' + cnDate(inv.dueDate));
  return l.join('\n');
}
const PSIGN = '\n\n—— 在留导航（服务商事务）\n这是系统自动发出的邮件，请不要直接回复。';
const STAGE_TEXT = { '-7': '还有 7 天到付款期限', '-1': '明天是付款期限', '+1': '已经过了付款期限' };
const TEXTS = {
  reminder: reminderMail,
  applyCode: (code) => ({ subject: '【在留导航】服务商入驻申请的验证码', text: '你正在用这个邮箱申请成为在留导航的服务商，或查看、修改已经提交的申请。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。\n\n不是你本人操作的话，不用理会这封邮件。请不要把验证码告诉任何人，我们不会向你要验证码。' + PSIGN }),
  applyReceived: (ref) => ({ subject: '【在留导航】已收到服务商入驻申请', text: '我们已经收到你的入驻申请。\n\n申请编号：' + ref + '\n\n审核时我们会对照所属会的公开检索核对登录番号等资料，结果会发到这个邮箱。审核期间可以在申请页面的“查看或修改申请”里用这个邮箱查看进度，或者撤回申请。' + PSIGN }),
  applyChanges: (ref, msg) => ({ subject: '【在留导航】入驻申请需要修改', text: '你的入驻申请（编号 ' + ref + '）需要修改后重新提交。审核人员的说明：\n\n' + msg + '\n\n请在申请页面的“查看或修改申请”里，用这个邮箱收验证码后修改并重新提交。' + PSIGN }),
  applyRejected: (ref, reason) => ({ subject: '【在留导航】入驻申请的审核结果', text: '很抱歉，你的入驻申请（编号 ' + ref + '）没有通过审核。说明：\n\n' + reason + '\n\n申请资料会在 90 天后删除。' + PSIGN }),
  // 批准：写明怎么领取令牌（不写令牌本身）和首月免费
  // inv 是首月免费的记录（批准当月不收费，没有账单）；payText、regNo 不再用，参数为兼容保留
  // 批准当月免费：只是这个月不收费、不开这个月的账单。下个月的账单照常提前 issueDays 天开出，月底批准的可能当天就收到（src/billing.js 的 runOnce）。
  applyApproved: (ref, workbenchUrl, inv, issueDays) => ({ subject: '【在留导航】入驻申请已批准', text: '你的入驻申请（编号 ' + ref + '）已经批准。\n\n第一步：领取工作台的令牌\n打开服务商工作台 ' + workbenchUrl + ' ，点“第一次使用或令牌丢了：用联系邮箱领取”，填这个邮箱，再填收到的验证码。令牌只显示一次，请保存好；我们不会用邮件发送令牌，也不会向你要令牌。领取令牌后，你的事务所就会出现在名单上。\n\n展示费：批准当月免费\n批准当月（到 ' + cnDate(inv.periodEnd) + ' 为止）不收展示费，这个月没有账单。免费期从批准当天算到当月最后一天，和什么时候领取令牌无关；领取令牌之前不开账单，也不在名单上展示。\n从下个月起按月收固定的展示费（不按咨询数或成交数收费）。下个月的账单在下个月开始前 ' + (issueDays || 14) + ' 天开出、发到这个邮箱，所以批准时离月底不到 ' + (issueDays || 14) + ' 天的，下个月的账单最早会在本月内（可能就在这几天）开出；按账单上写的期限付款即可继续展示。' + PSIGN }),
  claimCode: (code) => ({ subject: '【在留导航】领取服务商令牌的验证码', text: '你正在用服务商的联系邮箱领取在留导航服务商工作台的令牌。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。领取后原来的令牌立即失效。\n\n不是你本人操作的话，不用理会这封邮件；没有验证码对方领不到令牌。请不要把验证码告诉任何人。' + PSIGN }),
  tokenIssued: (ms) => ({ subject: '【在留导航】服务商令牌已重新发放', text: '刚才有人用发到这个邮箱的验证码领取了服务商工作台的新令牌，原来的令牌已经失效。\n\n领取时间：' + jst(ms) + '\n\n是你本人的话，不用做任何事。不是你本人的话：说明别人能收到这个邮箱的邮件，请先改邮箱密码，再用这个邮箱重新领取一次（对方拿到的令牌随之失效）。' + PSIGN }),
  invoiceIssued: (inv, payText, regNo) => ({ subject: '【在留导航】展示费账单（' + inv.refCode + '）', text: '下一期的展示费账单已经开出。展示费是固定的，不按咨询数或成交数收费。\n\n' + invoiceLines(inv, regNo) + '\n\n' + payText + PSIGN }),
  // stage：'-7'、'-1'、'+1'
  invoiceReminder: (inv, stage, payText, regNo, graceDays) => ({ subject: '【在留导航】展示费付款提醒（' + inv.refCode + '）', text: STAGE_TEXT[stage] + '。' + (stage === '+1' ? '过了付款期限 ' + graceDays + ' 天仍没有确认到付款的话，你的事务所会暂时不在名单上展示（工作台照常能用）。已经付过的话请忽略这封邮件，入账确认需要一点时间。' : '') + '\n\n' + invoiceLines(inv, regNo) + '\n\n' + payText + PSIGN }),
  listingHidden: (inv) => ({ subject: '【在留导航】你的事务所暂时不在名单上展示', text: '账单（参考编号 ' + inv.refCode + '）过了付款期限和宽限期，还没有确认到付款，所以你的事务所暂时不在名单上展示。\n\n工作台照常能用：已经收到的咨询可以继续回复。付款确认后会重新展示（付款的方式见之前的账单邮件，或工作台里的账单列表）。' + PSIGN }),
  // 新咨询通知：只有数量、类别、工作台链接和关闭通知的链接；不写咨询内容、节点、用户的任何信息
  newInquiry: (n, catName, workbenchUrl, unsubUrl) => ({ subject: '【在留导航】有 ' + n + ' 条新咨询', text: '你在在留导航有 ' + n + ' 条新咨询（类别：' + catName + '）。\n\n咨询内容只在工作台里看：\n' + workbenchUrl + '\n\n不想再收到新咨询通知：打开下面的链接点“关闭通知”，不用登录；也可以在工作台里关掉。\n' + unsubUrl + PSIGN, headers: { 'List-Unsubscribe': '<' + unsubUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
  bindCode: (code) => ({ subject: '【在留导航】绑定邮箱的验证码', text: '你正在把这个邮箱绑定到在留导航的账号上。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。\n\n不是你本人操作的话，不用理会这封邮件，什么都不会发生。请不要把验证码告诉任何人，我们不会向你要验证码。' + SIGN }),
  recoverCode: (code) => ({ subject: '【在留导航】找回账号的验证码', text: '你正在用这个邮箱在另一台设备上找回在留导航的账号。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。\n\n不是你本人操作的话，不用理会这封邮件，没有验证码对方进不了你的账号。请不要把验证码告诉任何人，我们不会向你要验证码。' + SIGN }),
  taken: () => ({ subject: '【在留导航】这个邮箱已经绑定过账号', text: '刚才有人想把这个邮箱绑定到一个在留导航账号上，但这个邮箱已经绑定了另一个账号，所以没有绑定成功，也没有发验证码。\n\n是你本人的话：想回到原来的账号，在新设备上打开在留导航，在“开始之前”的窗口里点“已有账号？用邮箱找回”；想把邮箱换到新账号上，先在原来的账号里解除绑定。\n\n不是你本人的话，不用理会这封邮件。' + SIGN }),
  // 更换、解除邮箱之前，发到现在绑定的（原来的）邮箱的验证码。action：'change' 或 'remove'。
  oldCode: (action, code) => {
    const what = action === 'remove' ? '解除' : '更换';
    return { subject: '【在留导航】' + what + '邮箱的验证码', text: '你正在' + what + '在留导航账号绑定的邮箱。为了确认是本人，验证码发到了现在绑定的这个邮箱。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。' + (action === 'remove' ? '' : '输入后还要再收一次新邮箱的验证码，才算换好。') + '\n\n不是你本人操作的话：说明有人正登录着你的账号。请不要把验证码告诉任何人，我们不会向你要验证码；在自己的设备上打开在留导航，到“闯关”页的“我的情况”里找到“账号和邮箱”，点“让其他设备退出登录”。' + SIGN };
  },
  // 换绑、解除时发给原来那个邮箱的告知。不写新邮箱是什么。
  // 换绑、解除都要先输入发到这个邮箱的验证码，所以“不是本人”就说明别人能收到这个邮箱的邮件：先改邮箱密码。
  emailChanged: (ms) => ({ subject: '【在留导航】账号绑定的邮箱已经更换', text: '你的在留导航账号原来绑定的是这个邮箱，刚才已经换成了另一个邮箱（更换时输入了发到这个邮箱的验证码）。从现在起，这个邮箱不能再用来找回账号，也不会再收到在留导航的邮件。\n\n更换时间：' + jst(ms) + '\n\n是你本人的话，不用做任何事。\n\n不是你本人的话：说明别人能收到这个邮箱的邮件，请先改这个邮箱的密码。再在还登录着的设备上打开在留导航，到“闯关”页的“我的情况”里找到“账号和邮箱”，点“让其他设备退出登录”。账号现在绑着的是对方的邮箱，要换掉它需要那个邮箱收到的验证码，对方也还能用它重新登录；想彻底断开，请在“我的情况”里删除账号后重新开始。' + SIGN }),
  emailRemoved: (ms) => ({ subject: '【在留导航】账号绑定的邮箱已经解除', text: '你的在留导航账号原来绑定的是这个邮箱，刚才已经解除了绑定（解除时输入了发到这个邮箱的验证码），我们保存的这个邮箱地址已删除。从现在起，这个邮箱不能再用来找回账号，也不会再收到在留导航的邮件。\n\n解除时间：' + jst(ms) + '\n\n是你本人的话，不用做任何事。\n\n不是你本人的话：说明别人能收到这个邮箱的邮件，请先改这个邮箱的密码。再在还登录着的设备上打开在留导航，到“闯关”页的“我的情况”里找到“账号和邮箱”，点“让其他设备退出登录”，然后重新绑定邮箱。' + SIGN }),
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
