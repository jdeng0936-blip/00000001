// 发件方式：outbox、console 不联网；http 和 smtp 对着本机的假服务器测。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSender, deliverOutbox, buildMessage, smtpData, encodeHeader, scrub } = require('../src/mailer');
const { createStore } = require('../src/store');

const MAIL = { to: 'li@example.com', subject: '【在留导航】绑定邮箱的验证码', text: '验证码：123456\n.这一行以点开头\n第三行', headers: { 'X-Test': 'yes' } };

test('outbox 和 console：不联网；默认是 outbox；console 把邮件打印出来', async () => {
  const realFetch = global.fetch; let calls = 0; global.fetch = async () => { calls++; throw new Error('不应当联网'); };
  try {
    const a = createSender({});
    assert.equal(a.name, 'outbox'); assert.equal(a.dev, true); assert.deepEqual(await a.send(MAIL), {});
    assert.equal(createSender().name, 'outbox'); assert.equal(createSender({ MAIL_SENDER: 'outbox' }).name, 'outbox');
    const lines = [];
    const c = createSender({ MAIL_SENDER: 'console' }, { log: (x) => lines.push(x) });
    assert.equal(c.name, 'console'); await c.send(MAIL);
    assert.match(lines.join('\n'), /To: li@example\.com/); assert.match(lines.join('\n'), /验证码：123456/);
    assert.equal(calls, 0);
  } finally { global.fetch = realFetch; }
});

test('设置不全时直接报错，说清楚缺什么（服务器因此不会启动）', () => {
  assert.throws(() => createSender({ MAIL_SENDER: 'http' }), /MAIL_FROM、MAIL_HTTP_URL、MAIL_HTTP_KEY/);
  assert.throws(() => createSender({ MAIL_SENDER: 'http', MAIL_FROM: 'a@b.co', MAIL_HTTP_URL: 'https://x.example/send' }), /MAIL_HTTP_KEY/);
  assert.throws(() => createSender({ MAIL_SENDER: 'http', MAIL_FROM: 'a@b.co', MAIL_HTTP_URL: 'ftp://x', MAIL_HTTP_KEY: 'k' }), /MAIL_HTTP_URL/);
  assert.throws(() => createSender({ MAIL_SENDER: 'http', MAIL_FROM: 'a@b.co', MAIL_HTTP_URL: 'https://x.example', MAIL_HTTP_KEY: 'k', MAIL_HTTP_PRESET: 'other' }), /MAIL_HTTP_PRESET/);
  assert.throws(() => createSender({ MAIL_SENDER: 'smtp', MAIL_FROM: 'a@b.co', SMTP_HOST: 'smtp.example.com' }), /SMTP_USER、SMTP_PASS/);
  assert.throws(() => createSender({ MAIL_SENDER: 'smtp' }), /MAIL_FROM、SMTP_HOST/);
  assert.throws(() => createSender({ MAIL_SENDER: 'pigeon' }), /outbox、console、http、smtp/);
  assert.equal(createSender({ MAIL_SENDER: 'http', MAIL_FROM: 'a@b.co', MAIL_HTTP_URL: 'https://x.example/send', MAIL_HTTP_KEY: 'k' }).name, 'http');
  assert.equal(createSender({ MAIL_SENDER: 'smtp', MAIL_FROM: 'a@b.co', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }).dev, false);
});

test('启动：MAIL_SENDER=http 而设置不全时，服务器进程报错退出', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: Object.assign({}, process.env, { MAIL_SENDER: 'http', MAIL_FROM: '', MAIL_HTTP_URL: '', MAIL_HTTP_KEY: '', PORT: '0', DB_FILE: ':memory:' }), encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /邮件发送没有配置好：MAIL_SENDER=http 需要配置 MAIL_FROM、MAIL_HTTP_URL、MAIL_HTTP_KEY/);
});

test('http：向配置的地址发一个 POST，带 Bearer 密钥和 JSON；对方返回 5xx 或连不上时算失败', async () => {
  const seen = []; let status = 200;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: b }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 200 ? '{"id":"msg-1"}' : '{"error":"boom"}'); }); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const url = 'http://127.0.0.1:' + srv.address().port + '/v1/send';
  try {
    const s = createSender({ MAIL_SENDER: 'http', MAIL_FROM: '在留导航 <no-reply@example.jp>', MAIL_HTTP_URL: url, MAIL_HTTP_KEY: 'key-123' });
    assert.deepEqual(await s.send(MAIL), { id: 'msg-1' });
    assert.equal(seen.length, 1); assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].url, '/v1/send'); assert.equal(seen[0].auth, 'Bearer key-123'); assert.match(seen[0].type, /application\/json/);
    assert.deepEqual(JSON.parse(seen[0].body), { from: '在留导航 <no-reply@example.jp>', to: MAIL.to, subject: MAIL.subject, text: MAIL.text, headers: MAIL.headers });
    status = 503;
    await assert.rejects(s.send(MAIL), /邮件接口返回 503/);
    // 发件箱里的邮件经它发：成功记 sent，失败留着重试；错误说明里没有密钥
    const store = createStore(); status = 200;
    store.enqueueMail({ kind: 'notice', to: 'li@example.com', subject: 's', body: 'b' });
    assert.deepEqual(await deliverOutbox(store, s), { sent: 1, failed: 0, dropped: 0 });
    status = 500; store.enqueueMail({ kind: 'notice', to: 'li@example.com', subject: 's2', body: 'b2' });
    assert.deepEqual(await deliverOutbox(store, s), { sent: 0, failed: 1, dropped: 0 });
    const rows = store.listOutbox(); assert.deepEqual(rows.map((r) => r.status), ['sent', 'queued']); assert.ok(!JSON.stringify(rows).includes('key-123'));
    store.close();
  } finally { srv.close(); srv.closeAllConnections(); }
  const dead = createSender({ MAIL_SENDER: 'http', MAIL_FROM: 'a@b.co', MAIL_HTTP_URL: url, MAIL_HTTP_KEY: 'k' });
  await assert.rejects(dead.send(MAIL), '服务器关掉之后连不上，算失败');
});

test('邮件的格式：标题按 RFC 2047 编码，正文 base64，头里不能夹换行；DATA 段以点开头的行多加一个点', () => {
  const msg = buildMessage(MAIL, '在留导航 <no-reply@example.jp>', Date.parse('2026-11-27T03:00:00Z'));
  const [head, body] = msg.split('\r\n\r\n');
  assert.match(head, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <no-reply@example\.jp>\r\n/);
  assert.match(head, /\r\nTo: li@example\.com\r\n/); assert.match(head, /\r\nDate: Fri, 27 Nov 2026 03:00:00 \+0000\r\n/);
  assert.match(head, /\r\nContent-Transfer-Encoding: base64/); assert.match(head, /\r\nX-Test: yes/); assert.match(head, /\r\nMessage-ID: <[0-9a-f-]+@example\.jp>/);
  assert.ok(/^[\x20-\x7e\r\n]*$/.test(msg), '整封邮件只有 ASCII');
  const subj = /\r\nSubject: ((?:.*\r\n )*.*)\r\n/.exec(head)[1];
  const decoded = subj.split('\r\n ').map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)[1], 'base64').toString('utf8')).join('');
  assert.equal(decoded, MAIL.subject);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), MAIL.text);
  // 很长的中文标题分成多段，每段不超过 75 个字符，不把一个字切成两半
  const long = '提醒'.repeat(60), enc = encodeHeader(long);
  assert.ok(enc.split('\r\n ').every((w) => w.length <= 75));
  assert.equal(enc.split('\r\n ').map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)[1], 'base64').toString('utf8')).join(''), long);
  assert.equal(encodeHeader('plain ascii'), 'plain ascii');
  // 夹换行的标题、收件人、头，都拒绝
  assert.throws(() => buildMessage(Object.assign({}, MAIL, { subject: 'a\r\nBcc: x@y.z' }), 'a@b.co'), /换行/);
  assert.throws(() => buildMessage(Object.assign({}, MAIL, { to: 'a@b.co\nBcc: x@y.z' }), 'a@b.co'), /换行/);
  assert.throws(() => buildMessage(Object.assign({}, MAIL, { to: 'a@b.co> x' }), 'a@b.co'), /收件地址/);
  assert.throws(() => buildMessage(Object.assign({}, MAIL, { headers: { 'X-A': 'v\r\nBcc: x@y.z' } }), 'a@b.co'), /换行/);
  assert.throws(() => buildMessage(Object.assign({}, MAIL, { headers: { 'X A:': 'v' } }), 'a@b.co'), /名称/);
  // 点的处理
  assert.equal(smtpData('第一行\n.第二行\r\n..第三行\n'), '第一行\r\n..第二行\r\n...第三行\r\n.\r\n');
  assert.equal(smtpData('a'), 'a\r\n.\r\n');
});

// 自签名证书在测试里现做（需要 openssl 命令；没有的话跳过这一条）
function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-smtp-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch (e) { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('smtp：TLS 直连，命令顺序正确，账号密码用 AUTH PLAIN（对方只支持 LOGIN 时用 AUTH LOGIN），正文能还原；被拒绝或证书不对时算失败', async (t) => {
  const pem = selfSigned();
  if (!pem) return t.skip('没有 openssl 命令，做不出测试用的证书');
  // 假的 SMTP 服务器：记下收到的每一行；rejectAt 指定在哪条命令上拒绝
  let rejectAt = null, authLine = 'AUTH PLAIN LOGIN', rejectText = 'no'; const sessions = [];
  const srv = tls.createServer({ key: pem.key, cert: pem.cert }, (sock) => {
    const log = { cmds: [], data: null }; sessions.push(log);
    let buf = '', inData = false, data = '', login = 0;
    sock.setEncoding('utf8'); sock.on('error', () => {});
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; log.data = data; sock.write('250 queued\r\n'); } else data += line + '\r\n'; continue; }
        log.cmds.push(line);
        // AUTH LOGIN 之后的两行是账号和密码（base64），不是命令
        if (login) { login--; sock.write(login ? '334 UGFzc3dvcmQ6\r\n' : rejectAt === 'PASS' ? '535 bad\r\n' : '235 ok\r\n'); continue; }
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (rejectAt === verb) { sock.write('550 ' + rejectText + '\r\n'); continue; }
        if (verb === 'EHLO') sock.write('250-test\r\n250-' + authLine + '\r\n250 SIZE 1000000\r\n'); // 多行应答
        else if (/^AUTH LOGIN$/i.test(line)) { login = 2; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (verb === 'AUTH') sock.write('235 ok\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 ok\r\n');
        else if (verb === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const env = { MAIL_SENDER: 'smtp', MAIL_FROM: '在留导航 <no-reply@example.jp>', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(srv.address().port), SMTP_USER: 'user@example.jp', SMTP_PASS: 'p@ss 密码', MAIL_TIMEOUT_MS: '5000' };
  try {
    const s = createSender(env, { tls: { ca: pem.cert }, helo: 'test.local' });
    assert.equal(s.name, 'smtp');
    await s.send(MAIL);
    const g = sessions[0];
    assert.deepEqual(g.cmds.map((c) => c.replace(/^AUTH PLAIN .*/, 'AUTH PLAIN *')), ['EHLO test.local', 'AUTH PLAIN *', 'MAIL FROM:<no-reply@example.jp>', 'RCPT TO:<li@example.com>', 'DATA', 'QUIT']);
    assert.equal(Buffer.from(g.cmds[1].slice('AUTH PLAIN '.length), 'base64').toString('utf8'), '\0user@example.jp\0p@ss 密码');
    const [head, body] = g.data.split('\r\n\r\n');
    assert.match(head, /Subject: =\?UTF-8\?B\?/); assert.match(head, /To: li@example\.com/);
    assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), MAIL.text, '正文原样到达（含以点开头的那一行）');
    // 每一步被拒绝都算失败，并且说出是哪一步
    for (const verb of ['AUTH', 'RCPT', 'DATA']) { rejectAt = verb; await assert.rejects(s.send(MAIL), /SMTP 第 \d 步被拒绝：550/, verb); }
    rejectAt = null;
    // 对方只支持 AUTH LOGIN：账号、密码各发一行 base64，其余步骤一样，邮件照样送到
    authLine = 'AUTH LOGIN'; let k = sessions.length;
    await s.send(MAIL);
    const l = sessions[k];
    assert.deepEqual(l.cmds, ['EHLO test.local', 'AUTH LOGIN', Buffer.from('user@example.jp').toString('base64'), Buffer.from('p@ss 密码').toString('base64'), 'MAIL FROM:<no-reply@example.jp>', 'RCPT TO:<li@example.com>', 'DATA', 'QUIT']);
    assert.equal(Buffer.from(l.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), MAIL.text);
    rejectAt = 'PASS'; await assert.rejects(s.send(MAIL), /SMTP 第 5 步被拒绝：535/, '密码不对算失败'); rejectAt = null;
    // 写成 250-AUTH=LOGIN PLAIN 的老写法也认得，两种都支持时用 PLAIN
    authLine = 'AUTH=LOGIN PLAIN'; k = sessions.length; await s.send(MAIL); assert.match(sessions[k].cmds[1], /^AUTH PLAIN /);
    authLine = 'AUTH PLAIN LOGIN';
    // 对方的拒绝说明里带着收件地址：存进发件箱的错误说明里没有地址
    rejectAt = 'RCPT'; rejectText = '<li@example.com> user unknown (li@example.com)';
    const st = createStore(); st.enqueueMail({ kind: 'notice', to: 'li@example.com', subject: 's', body: 'b' });
    assert.deepEqual(await deliverOutbox(st, s), { sent: 0, failed: 1, dropped: 0 });
    const errText = st.listOutbox()[0].lastError;
    assert.match(errText, /SMTP 第 \d 步被拒绝：550/); assert.ok(!errText.includes('li@example.com') && !errText.includes('@'), errText);
    st.close(); rejectAt = null; rejectText = 'no';
    // 不信任这张证书（没有给 ca）：连接失败，不发任何命令
    const n = sessions.length;
    const strict = createSender(env, { helo: 'test.local' });
    await assert.rejects(strict.send(MAIL), /SMTP 连接失败/);
    assert.ok(sessions.slice(n).every((x) => x.cmds.length === 0), '证书验证不过时不应当发出账号密码');
    // 收件地址里夹东西：连接之前就拒绝
    await assert.rejects(async () => s.send(Object.assign({}, MAIL, { to: 'a@b.co>\r\nRCPT TO:<x@y.z' })), /换行|收件地址/);
  } finally { srv.close(); }
  // 服务器不应答：超时算失败
  const mute = tls.createServer({ key: pem.key, cert: pem.cert }, (sock) => { sock.on('error', () => {}); });
  await new Promise((ok) => mute.listen(0, '127.0.0.1', ok));
  try {
    const slow = createSender(Object.assign({}, env, { SMTP_PORT: String(mute.address().port), MAIL_TIMEOUT_MS: '300' }), { tls: { ca: pem.cert } });
    await assert.rejects(slow.send(MAIL), /SMTP 超时/);
  } finally { mute.close(); }
});

test('错误说明里的邮箱地址会被换掉（错误说明要存进库，也可能进日志）', () => {
  assert.equal(scrub(new Error('550 <li@example.com> unknown')), '550 <［邮箱］> unknown');
  assert.equal(scrub('rcpt li.wei+a@mail.example.co.jp rejected; other x@y.z'), 'rcpt ［邮箱］ rejected; other ［邮箱］');
  assert.equal(scrub(new Error('SMTP 超时')), 'SMTP 超时');
});
