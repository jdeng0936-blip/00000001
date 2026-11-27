// 发邮件：发件方式（sender）、邮件的文字、把发件箱里排队的邮件发出去。零依赖。
// 所有邮件都先写进 outbox 表，再由 deliverOutbox 交给 sender。MAIL_SENDER 选发件方式：
//   outbox（默认）不联网，邮件留在 outbox 表里，测试和本地开发从那里读；
//   console        同上，另外把邮件打印出来；
//   http           向 MAIL_HTTP_URL 发一个 POST（Authorization: Bearer MAIL_HTTP_KEY），正式环境先用这个；
//   smtp           465 端口的 TLS 直连（不支持 STARTTLS），AUTH PLAIN。
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
    name: 'http', dev: false,
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
    name: 'smtp', dev: false,
    send(m) {
      const message = buildMessage(m, cfg.from); // 写法不对的地址、标题在连接之前就报错
      const rcpt = mailbox(m.to);
      return new Promise((ok, fail) => {
        const sock = tls.connect(Object.assign({ host: cfg.host, port: cfg.port, servername: cfg.host }, cfg.tls || {}));
        let buf = '', step = 0, done = false;
        const finish = (err) => { if (done) return; done = true; sock.destroy(); if (err) fail(err); else ok({}); };
        // 每一步：期待的应答码，和收到之后要发的下一条命令
        const steps = [
          [220, () => 'EHLO ' + (cfg.helo || os.hostname() || 'localhost') + '\r\n'],
          [250, () => 'AUTH PLAIN ' + Buffer.from('\0' + cfg.user + '\0' + cfg.pass, 'utf8').toString('base64') + '\r\n'],
          [235, () => 'MAIL FROM:<' + addrOf(cfg.from) + '>\r\n'],
          [250, () => 'RCPT TO:<' + rcpt + '>\r\n'],
          [250, () => 'DATA\r\n'],
          [354, () => smtpData(message)],
          [250, () => 'QUIT\r\n']
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
            if (/^\d{3}-/.test(line)) continue; // 多行应答，等最后一行
            const code = +line.slice(0, 3);
            if (code !== steps[step][0]) return finish(new Error('SMTP 第 ' + (step + 1) + ' 步被拒绝：' + line.slice(0, 120)));
            sock.write(steps[step][1]()); step++;
            if (step === steps.length) return finish(); // QUIT 已发出，邮件在上一步已被接受
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

// ---- 邮件的文字。验证码只出现在正文里，不放进标题；邮件里不放链接（防仿冒邮件骗人点链接）。 ----
const SIGN = '\n\n—— 在留导航\n这是系统自动发出的邮件，请不要直接回复。';
const jst = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') + '（日本时间）';
const TEXTS = {
  bindCode: (code) => ({ subject: '【在留导航】绑定邮箱的验证码', text: '你正在把这个邮箱绑定到在留导航的账号上。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。\n\n不是你本人操作的话，不用理会这封邮件，什么都不会发生。请不要把验证码告诉任何人，我们不会向你要验证码。' + SIGN }),
  recoverCode: (code) => ({ subject: '【在留导航】找回账号的验证码', text: '你正在用这个邮箱在另一台设备上找回在留导航的账号。\n\n验证码：' + code + '\n\n10 分钟内有效，只能用一次，请在刚才的页面里输入。\n\n不是你本人操作的话，不用理会这封邮件，没有验证码对方进不了你的账号。请不要把验证码告诉任何人，我们不会向你要验证码。' + SIGN }),
  taken: () => ({ subject: '【在留导航】这个邮箱已经绑定过账号', text: '刚才有人想把这个邮箱绑定到一个在留导航账号上，但这个邮箱已经绑定了另一个账号，所以没有绑定成功，也没有发验证码。\n\n是你本人的话：想回到原来的账号，在新设备上打开在留导航，在“开始之前”的窗口里点“已有账号？用邮箱找回”；想把邮箱换到新账号上，先在原来的账号里解除绑定。\n\n不是你本人的话，不用理会这封邮件。' + SIGN }),
  newDevice: (ms) => ({ subject: '【在留导航】有一台新设备登录了你的账号', text: '有人用发到这个邮箱的验证码，在一台新设备上登录了你的在留导航账号。原来的设备仍然保持登录。\n\n登录时间：' + jst(ms) + '\n\n是你本人的话，不用做任何事。\n\n不是你本人的话：在自己的设备上打开在留导航，到“闯关”页的“我的情况”里找到“账号和邮箱”，点“让其他设备退出登录”，并留意这个邮箱本身的安全（改邮箱密码）。' + SIGN })
};

// 把发件箱里到时间的邮件交给 sender。发不出去的按退避重试（次数和间隔在 store.markFailed）。
// 用 outbox、console 这两种本地方式时邮件原样留着；真实发信时验证码邮件发完就清掉正文和收件地址。
async function deliverOutbox(store, sender) {
  let sent = 0, failed = 0;
  for (const row of store.claimOutbox()) {
    try {
      await sender.send({ to: row.to, subject: row.subject, text: row.body, headers: row.headers || undefined });
      store.markSent(row.id, !sender.dev && row.kind === 'code'); sent++;
    } catch (e) { store.markFailed(row.id, e && e.message ? e.message : e); failed++; }
  }
  return { sent, failed };
}

module.exports = { createSender, deliverOutbox, TEXTS, buildMessage, smtpData, encodeHeader };
