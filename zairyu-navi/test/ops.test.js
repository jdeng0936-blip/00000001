// 上线准备：安全相关的响应头、静态文件的缓存、存活和就绪检查、停机收尾、请求日志和请求编号、备份、部署文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createApp, routeOf, truncateIp, opsConfig } = require('../src/server');
const { createStore } = require('../src/store');
const { startReminderTimer } = require('../src/scheduler');
const { backupConfig, backup, verify, listBackups } = require('../tools/backup');
const { WEB } = require('./web-source');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-ops-'));
async function start(opts) {
  const app = createApp(Object.assign({ now: '2026-11-28T03:00:00Z' }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return { app, base, port: app.server.address().port, stop: () => { app.server.close(); app.server.closeAllConnections(); try { app.store.close(); } catch (e) { /* 已经关了 */ } } };
}
// 原始的 TCP 连接：可以只发一半的请求
const connect = (port) => new Promise((ok, fail) => { const s = net.connect(port, '127.0.0.1', () => ok(s)); s.on('error', fail); });
const readAll = (sock) => new Promise((ok) => { let out = ''; sock.on('data', (d) => { out += d; }); sock.on('close', () => ok(out)); sock.on('error', () => ok(out)); });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---- 安全相关的响应头 ----
test('每个响应都带安全相关的头：接口、网页、静态文件、404、退订页', async () => {
  const s = await start();
  try {
    for (const p of ['/api/health', '/', '/index.js', '/index.css', '/privacy.html', '/api/no-such', '/no-such.html', '/api/unsubscribe?t=x']) {
      const r = await fetch(s.base + p);
      assert.match(r.headers.get('content-security-policy'), /default-src 'none'/, p);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/, p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.match(r.headers.get('permissions-policy'), /camera=\(\)/, p);
      assert.equal(r.headers.get('strict-transport-security'), null, '没开 TRUST_PROXY 时不带 HSTS：' + p);
      assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, p);
      await r.arrayBuffer();
    }
    // 网页的 CSP：脚本和样式只从本站加载，不放行内联
    const csp = (await fetch(s.base + '/')).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /style-src 'self'(;|$)/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
    // 退订页没有脚本，样式按哈希放行：哈希和页面里那段样式对得上
    const u = await fetch(s.base + '/api/unsubscribe?t=abcdefghijklmnopqrstuvwxyz');
    const html = await u.text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
    const want = "'sha256-" + crypto.createHash('sha256').update(style).digest('base64') + "'";
    assert.ok(u.headers.get('content-security-policy').includes("style-src " + want), '退订页的样式哈希');
    assert.doesNotMatch(u.headers.get('content-security-policy'), /unsafe-inline|script-src/);
    assert.doesNotMatch(html, / style="/, '退订页的标签上没有 style 属性');
  } finally { s.stop(); }
});

test('HSTS：只在 TRUST_PROXY 且反向代理说是 HTTPS 时带', async () => {
  const s = await start({ trustProxy: true });
  try {
    const get = (h) => fetch(s.base + '/api/health', { headers: h }).then((r) => r.headers.get('strict-transport-security'));
    assert.match(await get({ 'x-forwarded-proto': 'https' }), /^max-age=\d{7,}/);
    assert.equal(await get({ 'x-forwarded-proto': 'http' }), null);
    assert.equal(await get({}), null);
    assert.equal(await get({ 'x-forwarded-proto': 'https, http' }), null, '看最后一段（紧挨着的那层代理写的）');
  } finally { s.stop(); }
  const t = await start({ trustProxy: false });
  try { assert.equal((await fetch(t.base + '/api/health', { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security'), null, '直接对外时不信这个头'); } finally { t.stop(); }
});

test('网页文件满足 CSP：没有内联脚本、内联样式、style 属性、on…= 属性和外站资源；脚本里不用 eval、不设 style 属性', () => {
  const htmls = fs.readdirSync(WEB).filter((f) => f.endsWith('.html'));
  assert.ok(htmls.length >= 7);
  for (const f of htmls) {
    const h = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(h, /<style[\s>]/i, f + '：内联样式');
    assert.doesNotMatch(h, /<script(?![^>]*\ssrc=)[^>]*>/i, f + '：内联脚本');
    assert.doesNotMatch(h, /\sstyle\s*=/i, f + '：style 属性');
    assert.doesNotMatch(h, /\son[a-z]+\s*=/i, f + '：on…= 属性');
    assert.doesNotMatch(h, /javascript:/i, f);
    for (const m of h.matchAll(/<(?:script|link|img|iframe)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.match(m[1], /^\/[\w.-]+$/, f + ' 引用了外站或不认识的资源：' + m[1]);
      assert.ok(fs.existsSync(path.join(WEB, m[1].slice(1))), f + ' 引用的文件不存在：' + m[1]);
    }
  }
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith('.js'))) {
    const js = fs.readFileSync(path.join(WEB, f), 'utf8');
    assert.doesNotMatch(js, /\beval\(|new Function\(|setAttribute\(\s*["']style|setAttribute\(\s*["']on|setTimeout\(\s*["']/, f);
    assert.doesNotMatch(js, /fetch\(\s*["']https?:/, f + '：不连外站');
  }
});

// ---- 静态文件的缓存 ----
test('静态文件：带 ETag 和 no-cache；带着 If-None-Match 来问、文件没变时 304；接口是 no-store', async () => {
  const s = await start();
  try {
    for (const p of ['/', '/index.js', '/index.css', '/merge.js', '/terms.html']) {
      const r = await fetch(s.base + p); await r.arrayBuffer();
      assert.equal(r.status, 200, p); assert.equal(r.headers.get('cache-control'), 'no-cache', p);
      const etag = r.headers.get('etag'); assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/, p); assert.ok(r.headers.get('last-modified'), p);
      const again = await fetch(s.base + p, { headers: { 'if-none-match': etag } });
      assert.equal(again.status, 304, p); assert.equal((await again.text()), ''); assert.equal(again.headers.get('content-security-policy') !== null, true);
      assert.equal((await fetch(s.base + p, { headers: { 'if-none-match': 'W/"0-0"' } })).status, 200, p);
    }
    const css = await fetch(s.base + '/index.css'); assert.match(css.headers.get('content-type'), /^text\/css/);
    assert.equal((await fetch(s.base + '/api/health')).headers.get('cache-control'), 'no-store');
  } finally { s.stop(); }
});

test('静态文件：文字类的文件按 Accept-Encoding 发 gzip（带 Vary）；不要压缩、q=0 时发原文；304 和 HEAD 照旧；改了文件马上发新的', async () => {
  const zlib = require('node:zlib');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>' + '在留导航'.repeat(400));
  fs.writeFileSync(path.join(dir, 'small.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.alloc(4096, 7));
  const s = await start({ webDir: dir });
  const http = require('node:http');
  // fetch 会自己解压，这里用 http.get 看原始的响应
  const get = (p, headers, method) => new Promise((ok, fail) => { const q = http.request(s.base + p, { method: method || 'GET', headers }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => ok({ status: r.statusCode, h: r.headers, body: Buffer.concat(c) })); }); q.on('error', fail); q.end(); });
  try {
    const raw = fs.readFileSync(path.join(dir, 'index.html'));
    let r = await get('/', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(r.status, 200); assert.equal(r.h['content-encoding'], 'gzip'); assert.equal(r.h.vary, 'accept-encoding');
    assert.equal(+r.h['content-length'], r.body.length); assert.ok(r.body.length < raw.length / 4, '应当压缩');
    assert.deepEqual(zlib.gunzipSync(r.body), raw);
    assert.ok(r.h['content-security-policy'], '压缩的响应也带安全相关的头');
    for (const ae of [undefined, 'identity', 'gzip;q=0', 'br']) {
      r = await get('/', ae ? { 'accept-encoding': ae } : {});
      assert.equal(r.h['content-encoding'], undefined, String(ae)); assert.deepEqual(r.body, raw, String(ae));
    }
    assert.equal((await get('/', { 'accept-encoding': 'gzip;q=0.5' })).h['content-encoding'], 'gzip');
    // 太小的文件和图片不压缩
    r = await get('/small.css', { 'accept-encoding': 'gzip' }); assert.equal(r.h['content-encoding'], undefined); assert.equal(r.body.toString(), 'body{margin:0}');
    r = await get('/pic.png', { 'accept-encoding': 'gzip' }); assert.equal(r.h['content-encoding'], undefined); assert.equal(r.h.vary, undefined); assert.equal(r.body.length, 4096);
    // 304、HEAD
    const etag = r.h.etag; assert.equal((await get('/pic.png', { 'if-none-match': etag })).status, 304);
    r = await get('/', { 'accept-encoding': 'gzip' }, 'HEAD'); assert.equal(r.status, 200); assert.equal(r.body.length, 0); assert.equal(r.h['content-encoding'], 'gzip');
    // 改了文件：ETag 变了，发新内容（内存里的旧版本不再用）
    const before = (await get('/', {})).h.etag;
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>新</title>' + '新版本'.repeat(500));
    fs.utimesSync(path.join(dir, 'index.html'), new Date(), new Date(Date.now() + 5000));
    r = await get('/', { 'accept-encoding': 'gzip' });
    assert.notEqual(r.h.etag, before); assert.match(zlib.gunzipSync(r.body).toString(), /新版本/);
    // 真正的网页：首页的脚本压缩后不到原来的一半（中文多，压缩率比英文低）
    const s2 = await start();
    try {
      const js = await new Promise((ok) => http.get(s2.base + '/index.js', { headers: { 'accept-encoding': 'gzip' } }, (x) => { const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => ok({ h: x.headers, n: Buffer.concat(c).length })); }));
      assert.equal(js.h['content-encoding'], 'gzip'); assert.ok(js.n < fs.statSync(path.join(ROOT, 'web', 'index.js')).size / 2, String(js.n));
    } finally { s2.stop(); }
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('读接口：1KB 以上的 GET 返回按 Accept-Encoding 压缩；POST 的返回（带令牌）和小的返回不压缩', async () => {
  const zlib = require('node:zlib'), http = require('node:http');
  const s = await start();
  const call = (method, p, headers, body) => new Promise((ok, fail) => { const q = http.request(s.base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers) }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => ok({ status: r.statusCode, h: r.headers, body: Buffer.concat(c) })); }); q.on('error', fail); q.end(body); });
  try {
    let r = await call('GET', '/api/nodes?full=1', { 'accept-encoding': 'gzip' });
    assert.equal(r.status, 200); assert.equal(r.h['content-encoding'], 'gzip'); assert.equal(r.h.vary, 'accept-encoding');
    const plain = await call('GET', '/api/nodes?full=1', {});
    assert.equal(plain.h['content-encoding'], undefined); assert.deepEqual(zlib.gunzipSync(r.body), plain.body);
    assert.ok(r.body.length < plain.body.length / 2, r.body.length + ' / ' + plain.body.length);
    assert.equal((await call('GET', '/api/health', { 'accept-encoding': 'gzip' })).h['content-encoding'], undefined, '小的返回不压缩');
    r = await call('POST', '/api/users', { 'accept-encoding': 'gzip' }, JSON.stringify({ accept: (await (await fetch(s.base + '/api/terms')).json()).version }));
    assert.equal(r.status, 201); assert.equal(r.h['content-encoding'], undefined, '带令牌的返回不压缩'); assert.ok(JSON.parse(r.body).token);
    // 出错的返回不压缩
    assert.equal((await call('GET', '/api/users/nope/plan', { 'accept-encoding': 'gzip' })).h['content-encoding'], undefined);
  } finally { s.stop(); }
});

// ---- 存活和就绪 ----
test('存活检查和就绪检查分开：/api/health 不碰数据库；/api/ready 看表齐不齐、库能不能写', async () => {
  const dir = tmp(), file = path.join(dir, 'r.db');
  const store = createStore(file, { busyTimeoutMs: 50 });
  const s = await start({ store });
  try {
    let r = await fetch(s.base + '/api/ready');
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, failed: [] });
    assert.equal(store.auditCount(), 0, '就绪检查什么都不留下');
    // 另一个连接一直占着写锁：库写不进去 → 503 writable；存活检查照样 200
    const other = new DatabaseSync(file);
    other.exec('BEGIN EXCLUSIVE');
    r = await fetch(s.base + '/api/ready');
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { ok: false, failed: ['readable', 'writable'] }, '读也读不了（排他锁），不算没迁移');
    assert.equal((await fetch(s.base + '/api/health')).status, 200, '存活检查不看数据库');
    other.exec('ROLLBACK');
    assert.equal((await fetch(s.base + '/api/ready')).status, 200, '锁放开后又就绪');
    // 少了一张表（相当于没迁移完） → 503 migrations
    other.exec('DROP TABLE chat_history'); other.close();
    r = await fetch(s.base + '/api/ready');
    assert.equal(r.status, 503); assert.deepEqual((await r.json()).failed, ['migrations']);
    // 重新打开（createStore 会补上）后又就绪
    const again = createStore(file); assert.deepEqual(again.readiness(), { ok: true, failed: [] }); again.close();
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('就绪检查：没有 users.version 列（旧库没补列）算没迁移完', () => {
  const st = createStore(':memory:');
  assert.deepEqual(st.readiness(), { ok: true, failed: [] });
  assert.ok(st.schemaNames().includes('users') && st.schemaNames().includes('invoice_period'));
  st.close();
  const dir = tmp(), file = path.join(dir, 'old.db');
  try {
    createStore(file).close();
    const raw = new DatabaseSync(file); raw.exec('ALTER TABLE users DROP COLUMN version'); raw.close();
    // 直接用只读连接看：没有 version 列
    const ro = new DatabaseSync(file, { readOnly: true }); assert.ok(!ro.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'version')); ro.close();
    const st2 = createStore(file); assert.deepEqual(st2.readiness().failed, [], '打开时补上了列'); st2.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 停机收尾 ----
test('停机收尾：不再接新连接，就绪检查变 503；手上的请求照常回答（并关掉连接）；然后关库', async () => {
  const dir = tmp();
  const s = await start({ dbFile: path.join(dir, 's.db') });
  try {
    // 连接 A：请求头发完、请求体只发一半，服务器正在等
    const a = await connect(s.port); const aOut = readAll(a);
    a.write('PUT /api/users/abc/state HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 14\r\n\r\n{"profile"');
    // 连接 B：已经发了一半的请求头（就绪检查）
    const b = await connect(s.port); const bOut = readAll(b);
    b.write('GET /api/ready HTTP/1.1\r\nHost: x\r\n');
    await sleep(100);
    const done = s.app.shutdown({ timeoutMs: 5000 });
    assert.equal(s.app.isDraining(), true);
    await sleep(100);
    // 新连接被拒
    await assert.rejects(fetch(s.base + '/api/health'), '停机收尾时不接新连接');
    b.write('\r\n');
    a.write(':{}}');
    const ra = await aOut, rb = await bOut;
    assert.match(ra, /^HTTP\/1\.1 401/, '手上的请求照常回答'); assert.match(ra, /connection: close/i);
    assert.match(rb, /^HTTP\/1\.1 503/); assert.match(rb, /shutting-down/);
    const r = await done;
    assert.equal(r.forced, 0, '没有被强制断开的请求');
    assert.throws(() => s.app.store.getUser('x'), '库已经关了');
    assert.equal(s.app.shutdown(), done, '再调一次返回同一个 Promise');
  } finally { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('停机收尾：手上的请求超过时限就强制断开，不无限等', async () => {
  const s = await start();
  try {
    const a = await connect(s.port); const aOut = readAll(a);
    a.write('PUT /api/users/abc/state HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{');
    await sleep(50);
    const t0 = Date.now();
    const r = await s.app.shutdown({ timeoutMs: 300 });
    assert.equal(r.forced, 1); assert.ok(Date.now() - t0 < 3000);
    assert.equal(await aOut, '', '被断开的连接没有收到半截响应');
  } finally { s.stop(); }
});

test('npm start 收到 SIGTERM：停定时器、做完手上的请求、关库后以 0 退出；请求日志是一行一个 JSON，没有地址里的编号和令牌', async () => {
  const dir = tmp();
  const port = await new Promise((ok) => { const x = net.createServer(); x.listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => ok(p)); }); });
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'src', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), DB_FILE: path.join(dir, 'sig.db'), REMINDERS_ENABLED: '1', SHUTDOWN_TIMEOUT_MS: '5000', MAIL_SENDER: 'outbox', TRUST_PROXY: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((ok) => child.on('exit', (code, sig) => ok({ code, sig })));
  try {
    for (let i = 0; i < 100 && !/已启动/.test(out); i++) await sleep(50);
    assert.match(out, /已启动/, err);
    const base = 'http://127.0.0.1:' + port;
    assert.equal((await fetch(base + '/api/users/secret-user-id/plan', { headers: { authorization: 'Bearer secret-token-value' } })).status, 401);
    assert.equal((await fetch(base + '/api/unsubscribe?t=secret-unsub-token-123456')).status, 200);
    const a = await connect(port); const aOut = readAll(a);
    a.write('PUT /api/users/abc/state HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{');
    await sleep(100);
    const t0 = Date.now();
    child.kill('SIGTERM');
    await sleep(200);
    await assert.rejects(fetch(base + '/api/health'));
    a.write('}');
    assert.match(await aOut, /^HTTP\/1\.1 401/);
    const e = await exited;
    assert.deepEqual(e, { code: 0, sig: null }, err);
    assert.ok(Date.now() - t0 < 4000, '定时器停掉了，没有拖着进程');
    const lines = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const reqs = lines.filter((l) => l.msg === 'request');
    const plan = reqs.find((l) => l.route === '/api/users/:id/plan');
    assert.ok(plan, out); assert.equal(plan.status, 401); assert.equal(plan.method, 'GET'); assert.ok(typeof plan.ms === 'number' && plan.rid);
    assert.deepEqual(Object.keys(plan).sort(), ['method', 'ms', 'msg', 'rid', 'route', 'status', 't']);
    assert.ok(reqs.some((l) => l.route === '/api/unsubscribe'));
    assert.ok(reqs.some((l) => l.route === '/api/users/:id/state' && l.status === 401), '收尾时做完的那个请求也记了');
    assert.ok(lines.some((l) => l.msg === 'shutdown' && l.signal === 'SIGTERM') && lines.some((l) => l.msg === 'stopped' && l.forced === 0));
    for (const secret of ['secret-user-id', 'secret-token-value', 'secret-unsub-token', '127.0.0.1']) assert.ok(!out.includes(secret), '日志里不应当有 ' + secret);
  } finally { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 请求日志和请求编号 ----
test('请求日志：字段固定，路由是模板；不写请求体、查询参数、令牌、邮箱；来源地址只在 TRUST_PROXY 时写并截短', async () => {
  const logs = [];
  const s = await start({ log: (o) => logs.push(o) });
  try {
    const u = await (await fetch(s.base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: s.app.termsVersion }) })).json();
    await (await fetch(s.base + '/api/users/' + u.id + '/email', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ email: 'logme@example.com', consent: true }) })).arrayBuffer();
    await (await fetch(s.base + '/api/users/' + u.id + '/options/phone?budget=3000')).arrayBuffer();
    await (await fetch(s.base + '/privacy.html')).arrayBuffer();
    await (await fetch(s.base + '/../../etc/passwd')).arrayBuffer();
    await (await fetch(s.base + '/api/health')).arrayBuffer(); // 成功的存活、就绪检查不记
    await (await fetch(s.base + '/api/ready')).arrayBuffer();
    await sleep(50);
    const routes = logs.map((l) => l.method + ' ' + l.route + ' ' + l.status);
    assert.deepEqual(routes, ['POST /api/users 201', 'POST /api/users/:id/email 202', 'GET /api/users/:id/options/:topic 401', 'GET /privacy.html 200', 'GET /* 404']);
    const all = JSON.stringify(logs);
    for (const secret of [u.id, u.token, 'logme', 'budget', '127.0.0.1', 'passwd']) assert.ok(!all.includes(secret), '日志里不应当有 ' + secret);
    for (const l of logs) { assert.ok(!('ip' in l)); assert.match(l.t, /^\d{4}-\d\d-\d\dT/); assert.match(l.rid, /^[0-9a-f-]{36}$/); }
  } finally { s.stop(); }
  const logs2 = [];
  const t = await start({ log: (o) => logs2.push(o), trustProxy: true });
  try {
    const r = await fetch(t.base + '/api/nodes', { headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.45', 'x-request-id': 'caddy-req-0123456789' } }); await r.arrayBuffer();
    assert.equal(r.headers.get('x-request-id'), 'caddy-req-0123456789', 'TRUST_PROXY 时沿用代理给的编号');
    const bad = await fetch(t.base + '/api/health', { headers: { 'x-request-id': 'bad id\twith spaces' } });
    assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, '格式不对的编号不用');
    await sleep(50);
    assert.equal(logs2[0].ip, '203.0.113.0', '取最后一段并截短'); assert.equal(logs2[0].rid, 'caddy-req-0123456789');
  } finally { t.stop(); }
  const u = await start();
  try { assert.match((await fetch(u.base + '/api/health', { headers: { 'x-request-id': 'client-chosen-id-123' } })).headers.get('x-request-id'), /^[0-9a-f-]{36}$/, '没开 TRUST_PROXY 时不用客户端给的编号'); } finally { u.stop(); }
});

test('路由模板和截短的来源地址', () => {
  const files = new Set(['index.html', 'index.js']);
  const cases = {
    '/': '/', '/index.js': '/index.js', '/nope.js': '/*', '/a/b': '/*',
    '/api/health': '/api/health', '/api/ready': '/api/ready',
    '/api/users/u-123/plan': '/api/users/:id/plan', '/api/users/u-1/tasks/1-1/done': '/api/users/:id/tasks/:nodeId/done',
    '/api/users/u-1/events/e-9': '/api/users/:id/events/:eid', '/api/users/u-1/options/phone': '/api/users/:id/options/:topic',
    '/api/users/u-1/email/old/verify': '/api/users/:id/email/old/verify', '/api/provider-apply/ABC123': '/api/provider-apply/:ref',
    '/api/admin/applications/x/approve': '/api/admin/applications/:id/approve', '/api/billing/webhook/stripe': '/api/billing/webhook/:method',
    '/api/someone@example.com': '/api/:param', '/api/a/b/c/d/e/f/g/h': '/api/*'
  };
  for (const [p, want] of Object.entries(cases)) assert.equal(routeOf(p, files), want, p);
  assert.equal(truncateIp('203.0.113.45'), '203.0.113.0');
  assert.equal(truncateIp('::ffff:203.0.113.45'), '203.0.113.0');
  assert.equal(truncateIp('2001:db8:1:2:3:4:5:6'), '2001:db8:1::');
  assert.equal(truncateIp('2001:db8::5'), '2001:db8::');
  assert.equal(truncateIp('::1'), '::');
  assert.equal(truncateIp('garbage'), '');
});

test('运维设置：LOG_REQUESTS 默认开，SHUTDOWN_TIMEOUT_MS 有范围；写错了不启动', () => {
  assert.deepEqual(opsConfig({}), { logRequests: true, shutdownTimeoutMs: 25000 });
  assert.deepEqual(opsConfig({ LOG_REQUESTS: '0', SHUTDOWN_TIMEOUT_MS: '5000' }), { logRequests: false, shutdownTimeoutMs: 5000 });
  assert.throws(() => opsConfig({ LOG_REQUESTS: 'yes' }), /LOG_REQUESTS/);
  for (const v of ['999', '120001', 'abc', '1.5']) assert.throws(() => opsConfig({ SHUTDOWN_TIMEOUT_MS: v }), /SHUTDOWN_TIMEOUT_MS/);
});

test('提醒的定时器可以停：stop() 之后不再跑，定时器都清掉', () => {
  let now = Date.parse('2026-11-28T03:00:00Z'); const q = []; const cleared = []; const runs = [];
  const deps = { now: () => now, setTimeout: (fn, ms) => { const h = { at: now + ms, fn }; q.push(h); return h; }, setInterval: (fn, ms) => { const h = { at: now + ms, fn, every: ms }; q.push(h); return h; }, clearTimeout: (h) => cleared.push(h) };
  const t = startReminderTimer({ hour: 9, intervalMin: 60 }, () => runs.push(now), deps);
  t.stop();
  assert.equal(cleared.length, 2, '启动时的两个定时器都清掉');
  for (const h of q) h.fn();
  assert.equal(runs.length, 0, '停了之后即使定时器到点也不跑');
});

// ---- 备份 ----
test('备份：在线备份成带时间的文件（600 权限），核对通过，只留最新的 N 份；删掉的数据不在备份里', async () => {
  const dir = tmp(), dbFile = path.join(dir, 'live.db'), bdir = path.join(dir, 'backups');
  try {
    const s = await start({ dbFile });
    const call = async (method, p, body, token) => (await fetch(s.base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined })).json().catch(() => null);
    const keep = await call('POST', '/api/users', { accept: s.app.termsVersion });
    const gone = await call('POST', '/api/users', { accept: s.app.termsVersion });
    await call('POST', '/api/users/' + gone.id + '/events', { type: 'move', date: '2026-12-01', note: '要删掉的备注QWXZ' }, gone.token);
    await fetch(s.base + '/api/users/' + gone.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + gone.token } });
    // 服务器开着、库正在用时备份
    const cfg = backupConfig({ DB_FILE: dbFile, BACKUP_DIR: bdir, BACKUP_KEEP: '2' });
    const t0 = Date.parse('2026-11-28T03:00:00Z');
    const r1 = backup(cfg, t0);
    assert.equal(path.basename(r1.file), 'zairyu-20261128-030000Z.db');
    assert.equal(r1.counts.users, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(r1.file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(r1.file).toString('latin1');
    assert.ok(!raw.includes('QWXZ') && !raw.includes(gone.id), '删掉的账号和备注不在备份里（没有空闲页）');
    backup(cfg, t0); // 同一秒再来一次：不覆盖
    const r3 = backup(cfg, t0 + 86400000);
    assert.deepEqual(listBackups(bdir), ['zairyu-20261128-030000Z-1.db', 'zairyu-20261129-030000Z.db'], '只留最新的 2 份');
    assert.deepEqual(r3.removed, ['zairyu-20261128-030000Z.db']);
    assert.ok(!fs.readdirSync(bdir).some((f) => f.endsWith('.partial')), '不留临时文件');
    // 核对和恢复演练
    const v = verify(cfg);
    assert.equal(v.ok, true, v.problems.join()); assert.equal(v.restore, true); assert.equal(path.basename(v.file), 'zairyu-20261129-030000Z.db');
    assert.deepEqual(fs.readdirSync(bdir).length, 2, '恢复演练的副本不留在备份目录');
    // 坏掉的备份核对不过
    const bad = path.join(bdir, 'zairyu-20261130-030000Z.db');
    const buf = fs.readFileSync(r3.file); buf.fill(0x41, 4096, 8192); fs.writeFileSync(bad, buf);
    const vb = verify(cfg); assert.equal(vb.ok, false); assert.ok(vb.problems.length);
    // 恢复出来的库能被现在的代码打开、数据还在
    const restored = createStore(r3.file); assert.ok(restored.getUser(keep.id)); assert.ok(!restored.getUser(gone.id)); restored.close();
    s.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('备份的设置：BACKUP_KEEP 有范围；备份目录不能就是库所在的目录；库不存在时报错', () => {
  assert.equal(backupConfig({ DB_FILE: '/x/y/z.db' }).dir, path.resolve('/x/y/backups'));
  assert.equal(backupConfig({ DB_FILE: '/x/y/z.db' }).keep, 7);
  for (const v of ['0', '366', 'a']) assert.throws(() => backupConfig({ DB_FILE: '/x/z.db', BACKUP_KEEP: v }), /BACKUP_KEEP/);
  assert.throws(() => backupConfig({ DB_FILE: '/x/z.db', BACKUP_DIR: '/x' }), /BACKUP_DIR/);
  assert.throws(() => backup(backupConfig({ DB_FILE: '/nonexistent-dir-zz/z.db', BACKUP_DIR: '/tmp/zz-none' })), /不存在/);
});

// ---- 部署文件 ----
test('部署文件：Dockerfile 用非 root 用户、带 HEALTHCHECK、不装运行时依赖；compose 只读根目录、库在卷上、停机时限比收尾时限长', () => {
  const df = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(df, /^FROM node:22\.\d+\.\d+-bookworm-slim$/m, '固定到具体版本的 tag');
  assert.match(df, /^USER node$/m); assert.match(df, /^HEALTHCHECK /m); assert.match(df, /\/api\/health/);
  assert.match(df, /DB_FILE=\/data\/zairyu\.db/); assert.match(df, /^VOLUME \["\/data"/m);
  assert.doesNotMatch(df, /^RUN .*npm (install|ci)/m, '没有运行时依赖');
  assert.match(df, /^CMD \["node", "src\/server\.js"\]$/m, '直接跑 node，SIGTERM 到得了');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies, undefined);
  const di = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  for (const x of ['*.db', '.env', '.git', 'node_modules']) assert.ok(di.split('\n').includes(x), '.dockerignore 里要有 ' + x);
  const cy = fs.readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
  assert.match(cy, /read_only: true/); assert.match(cy, /TRUST_PROXY: "1"/); assert.match(cy, /- appdata:\/data/); assert.match(cy, /image: caddy:2\.\d+\.\d+-alpine/);
  assert.match(cy, /no-new-privileges:true/); assert.match(cy, /cap_drop:/);
  const grace = +/stop_grace_period: (\d+)s/.exec(cy)[1], shut = +/SHUTDOWN_TIMEOUT_MS: "(\d+)"/.exec(cy)[1];
  assert.ok(grace * 1000 > shut + 2000, 'stop_grace_period 要比 SHUTDOWN_TIMEOUT_MS 长');
  assert.doesNotMatch(cy, /ports:[\s\S]*?8787:8787/, '应用不直接对外');
  const caddy = fs.readFileSync(path.join(ROOT, 'deploy', 'Caddyfile'), 'utf8');
  assert.match(caddy, /reverse_proxy app:8787/); assert.match(caddy, /header_up X-Request-Id \{http\.request\.uuid\}/);
  const ex = fs.readFileSync(path.join(ROOT, 'deploy', 'env.example'), 'utf8');
  assert.doesNotMatch(ex, /sk-ant-[A-Za-z0-9]/, '示例里没有真的密钥');
  for (const k of ['ADMIN_TOKENS', 'ANTHROPIC_API_KEY', 'MAIL_SENDER', 'APP_URL', 'SITE_DOMAIN']) assert.match(ex, new RegExp('^#? ?' + k + '=', 'm'), 'env.example 里要有 ' + k);
});
