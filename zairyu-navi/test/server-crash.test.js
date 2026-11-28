// 任何请求都不能让进程退出。服务放在子进程里跑，这样“退出”本身可以被观察到。
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const serverJs = path.join(__dirname, '..', 'src', 'server.js');
// pre：在建服务之前执行的一段代码（用来模拟文件读取出错）
function startChild(pre) {
  const code = `${pre || ''}
    const { createApp } = require(${JSON.stringify(serverJs)});
    const { server } = createApp({ now: '2026-11-26' });
    server.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port));`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = null; child.on('exit', (c, sig) => { exited = { code: c, sig }; });
  child.stderr.on('data', () => {});
  return new Promise((ok, fail) => {
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const m = /PORT=(\d+)/.exec(buf); if (m) ok({ port: +m[1], child, exited: () => exited }); });
    child.on('exit', () => fail(new Error('子进程没有启动')));
  });
}
const raw = (port, text) => new Promise((ok) => {
  const sock = net.connect(port, '127.0.0.1', () => sock.write(text)); let out = '';
  sock.on('data', (d) => { out += d; }); sock.on('error', () => ok(out)); sock.on('close', () => ok(out));
  setTimeout(() => sock.destroy(), 1500);
});
const alive = async (s) => {
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(s.exited(), null, '进程不应退出');
  const r = await fetch('http://127.0.0.1:' + s.port + '/api/health');
  assert.equal(r.status, 200);
};

test('解析不了的请求地址返回 400，进程不退出', async () => {
  const s = await startChild();
  try {
    for (const target of ['//', '///', '//a:b:c/', 'http://[::1', '/\\\\']) {
      const out = await raw(s.port, 'GET ' + target + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      assert.match(out, /^HTTP\/1\.1 (400|404)/, target);
      await alive(s);
    }
    const out = await raw(s.port, 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(out, /^HTTP\/1\.1 400/); assert.match(out, /请求地址无效/);
  } finally { s.child.kill(); }
});

test('静态文件读到一半出错时不退出', async () => {
  // 网页文件先整个读进内存（readFileSync）再发；读的时候出错（文件在检查之后被删掉、或磁盘读错误）返回 500，不带错误细节。
  // 大于 2MB 的文件按流发（createReadStream），流出错时连接直接断开。两种都模拟。
  const s = await startChild(`
    const fs = require('node:fs'); const { Readable } = require('node:stream');
    const rf = fs.readFileSync;
    fs.readFileSync = function (p) { if (/privacy\\.html$/.test(String(p))) throw new Error('EIO: 模拟读取失败'); return rf.apply(fs, arguments); };
    fs.createReadStream = () => { const r = new Readable({ read() { this.destroy(new Error('EIO: 模拟读取失败')); } }); process.nextTick(() => r.emit('open')); return r; };`);
  try {
    const out = await raw(s.port, 'GET /privacy.html HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(out, /^HTTP\/1\.1 500/);
    assert.ok(!/模拟读取失败/.test(out), '错误细节不能发给客户端');
    await alive(s);
    await raw(s.port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    await alive(s);
  } finally { s.child.kill(); }
});

test('静态文件：正常返回网页；目录穿越和不存在的文件返回 404；请求体中途断开不退出', async () => {
  const s = await startChild();
  try {
    const base = 'http://127.0.0.1:' + s.port;
    const home = await fetch(base + '/');
    assert.equal(home.status, 200); assert.match(home.headers.get('content-type'), /text\/html/); assert.match(await home.text(), /<html/i);
    assert.equal((await fetch(base + '/privacy.html')).status, 200);
    assert.equal((await fetch(base + '/nope.html')).status, 404);
    for (const t of ['/../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/..\\\\..\\\\package.json', '/%00']) {
      const out = await raw(s.port, 'GET ' + t + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      assert.match(out, /^HTTP\/1\.1 404/, t); assert.ok(!/zairyu-navi/.test(out), t);
    }
    // 声明了很长的请求体，只发一点就断开
    await raw(s.port, 'POST /api/users HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"acc');
    await alive(s);
    // 超过大小上限
    const big = await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: 'x'.repeat(70000) }) }).then((r) => r.status, () => 'reset');
    assert.ok(big === 413 || big === 'reset');
    await alive(s);
  } finally { s.child.kill(); }
});
