// 简单的压力测试（npm run loadtest）。零依赖：Node 自带的 fetch、child_process。
// 不给 BASE 时自己起一个 npm start 一样的服务器（子进程，/tmp 下的新库，空闲端口，不写请求日志），跑完关掉并删掉库；
// 给了 BASE（例如 BASE=http://127.0.0.1:8787）就打那台已经起好的服务器（只打自己建的测试账号，不碰别的数据）。
// 不调助手接口（不调用真实的模型），不发邮件。
//
// 做法：先建 USERS 个账号（默认 20；新建账号每个来源地址每小时最多 30 个，所以不要超过 30），每个账号填好在留资格和日期；
// 然后 CONCURRENCY 个并发的“用户”（默认 20）在 DURATION 秒（默认 20）里不停地发请求，每次按权重挑一种：
//   读：打开页面（/、/index.js）、全部节点（/api/nodes?full=1）、路线（/plan）、提醒（/reminders）、判断（/advice）、永驻体检（/pr-check）、选方案（/options/phone）
//   写：保存概况和进度（PUT /state）、修改概况（PATCH /profile）、完成任务（PUT /tasks/:id/done）、记录事件再删掉（POST、DELETE /events）
// 输出每种请求的次数、非 2xx 的次数、每秒多少次、耗时的 p50、p95、p99、最大值（毫秒），以及合计。JSON=1 时输出 JSON。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const env = process.env;
const num = (name, def, min, max) => { const v = env[name] == null || env[name] === '' ? def : Number(env[name]); if (!Number.isInteger(v) || v < min || v > max) { console.error(name + ' 须是 ' + min + ' 到 ' + max + ' 的整数'); process.exit(1); } return v; };
const CONC = num('CONCURRENCY', 20, 1, 1000), DURATION = num('DURATION', 20, 1, 3600), USERS = num('USERS', 20, 1, 30);

const freePort = () => new Promise((ok, fail) => { const s = net.createServer(); s.on('error', fail); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-load-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], { env: Object.assign({}, env, { PORT: String(port), DB_FILE: path.join(dir, 'load.db'), LOG_REQUESTS: '0', MAIL_SENDER: 'outbox', REMINDERS_ENABLED: '0', ANTHROPIC_API_KEY: '' }), stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => { let buf = ''; child.stdout.on('data', (d) => { buf += d; if (/已启动/.test(buf)) ok(); }); child.on('exit', (c) => fail(new Error('服务器没有启动（退出码 ' + c + '）'))); });
  return { base: 'http://127.0.0.1:' + port, stop: () => new Promise((ok) => { child.on('exit', ok); child.kill('SIGTERM'); }).then(() => fs.rmSync(dir, { recursive: true, force: true })) };
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] : 0;
const PROFILE = { status: 'work', entry: '2026-04-01', addr: '2026-04-05', exp: '2027-04-01', ins: true, pr: true, trips: [['2026-08-10', '2026-08-20']] };

async function main() {
  const own = env.BASE ? null : await startServer();
  const base = env.BASE || own.base;
  const stats = {};
  const call = async (name, method, p, body, token) => {
    const t0 = performance.now();
    let status = 0;
    try {
      const r = await fetch(base + p, { method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
      status = r.status; await r.arrayBuffer();
      return r.status;
    } catch (e) { status = 0; return 0; } finally {
      const s = stats[name] || (stats[name] = { n: 0, bad: 0, ms: [], codes: {} });
      s.n++; s.ms.push(performance.now() - t0); if (status < 200 || status >= 300) { s.bad++; s.codes[status] = (s.codes[status] || 0) + 1; }
    }
  };
  try {
    const version = (await (await fetch(base + '/api/terms')).json()).version;
    const users = [];
    for (let i = 0; i < USERS; i++) {
      const r = await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: version }) });
      if (r.status !== 201 && r.status !== 200) throw new Error('建账号失败：' + r.status + '（新建账号每个来源地址每小时最多 30 个；对着已经起好的服务器反复跑时会撞上）');
      const u = await r.json(); users.push(u);
      const s = await fetch(base + '/api/users/' + u.id + '/state', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ profile: PROFILE, done: { '1-1': true } }) });
      if (s.status !== 200) throw new Error('填概况失败：' + s.status);
    }
    // 完成任务只挑这个概况下（只完成了 1-1）已经解锁的、1-1 以外的任务（没解锁的会是 409，那是规则，不是故障）；保存进度时总是只带 1-1
    const view = (await (await fetch(base + '/api/users/' + users[0].id + '/plan', { headers: { authorization: 'Bearer ' + users[0].token } })).json()).view;
    const open = view.nodes.filter((n) => n.state !== 'locked' && n.id !== '1-1').map((n) => n.id).slice(0, 6);
    if (!open.length) throw new Error('没有已解锁的任务');
    // [名称, 权重, 做法]
    const MIX = [
      ['GET /', 3, () => call('GET /', 'GET', '/')],
      ['GET /index.js', 3, () => call('GET /index.js', 'GET', '/index.js')],
      ['GET /api/nodes?full=1', 4, () => call('GET /api/nodes?full=1', 'GET', '/api/nodes?full=1')],
      ['GET plan', 10, (u) => call('GET plan', 'GET', '/api/users/' + u.id + '/plan', null, u.token)],
      ['GET reminders', 10, (u) => call('GET reminders', 'GET', '/api/users/' + u.id + '/reminders', null, u.token)],
      ['GET advice', 5, (u) => call('GET advice', 'GET', '/api/users/' + u.id + '/advice', null, u.token)],
      ['GET pr-check', 5, (u) => call('GET pr-check', 'GET', '/api/users/' + u.id + '/pr-check', null, u.token)],
      ['GET options/phone', 5, (u) => call('GET options/phone', 'GET', '/api/users/' + u.id + '/options/phone', null, u.token)],
      ['PUT state', 6, (u) => call('PUT state', 'PUT', '/api/users/' + u.id + '/state', { profile: PROFILE, done: { '1-1': true } }, u.token)],
      ['PATCH profile', 4, (u) => call('PATCH profile', 'PATCH', '/api/users/' + u.id + '/profile', { exp: Math.random() < 0.5 ? '2027-04-01' : '2027-05-01' }, u.token)],
      ['PUT task done', 4, (u) => call('PUT task done', 'PUT', '/api/users/' + u.id + '/tasks/' + open[Math.floor(Math.random() * open.length)] + '/done', { done: Math.random() < 0.5 }, u.token)],
      ['POST+DELETE event', 2, async (u) => {
        const t0 = performance.now();
        const r = await fetch(base + '/api/users/' + u.id + '/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ type: 'move', date: '2026-12-01' }) }).catch(() => null);
        const s = stats['POST event'] || (stats['POST event'] = { n: 0, bad: 0, ms: [], codes: {} });
        s.n++; s.ms.push(performance.now() - t0);
        if (!r || r.status !== 201) { s.bad++; s.codes[r ? r.status : 0] = (s.codes[r ? r.status : 0] || 0) + 1; if (r) await r.arrayBuffer(); return; }
        const id = (await r.json()).id;
        await call('DELETE event', 'DELETE', '/api/users/' + u.id + '/events/' + id, null, u.token);
      }]
    ];
    const total = MIX.reduce((a, m) => a + m[1], 0);
    const pick = () => { let x = Math.random() * total; for (const m of MIX) { x -= m[1]; if (x < 0) return m; } return MIX[0]; };
    const end = Date.now() + DURATION * 1000, t0 = performance.now();
    await Promise.all(Array.from({ length: CONC }, async (_, i) => { while (Date.now() < end) await pick()[2](users[i % users.length]); }));
    const secs = (performance.now() - t0) / 1000;
    const rows = Object.entries(stats).map(([name, s]) => { const ms = s.ms.slice().sort((a, b) => a - b); return { name, n: s.n, bad: s.bad, codes: s.codes, rps: +(s.n / secs).toFixed(1), p50: +pct(ms, 50).toFixed(1), p95: +pct(ms, 95).toFixed(1), p99: +pct(ms, 99).toFixed(1), max: +(ms[ms.length - 1] || 0).toFixed(1) }; });
    const all = Object.values(stats).flatMap((s) => s.ms).sort((a, b) => a - b);
    const sum = { name: '合计', n: all.length, bad: rows.reduce((a, r) => a + r.bad, 0), rps: +(all.length / secs).toFixed(1), p50: +pct(all, 50).toFixed(1), p95: +pct(all, 95).toFixed(1), p99: +pct(all, 99).toFixed(1), max: +(all[all.length - 1] || 0).toFixed(1) };
    const out = { at: new Date().toISOString(), node: process.version, cpus: os.cpus().length, cpu: (os.cpus()[0] || {}).model, concurrency: CONC, durationSec: DURATION, users: USERS, target: env.BASE ? 'BASE' : 'npm start（子进程）', rows, total: sum };
    if (env.JSON === '1') console.log(JSON.stringify(out, null, 2));
    else {
      console.log('并发 ' + CONC + '，' + DURATION + ' 秒，' + USERS + ' 个账号；Node ' + process.version + '，' + out.cpus + ' 核 ' + out.cpu);
      console.log('| 请求 | 次数 | 非 2xx | 每秒 | p50 ms | p95 ms | p99 ms | 最大 ms |');
      console.log('|---|---|---|---|---|---|---|---|');
      for (const r of rows.concat([sum])) console.log('| ' + [r.name, r.n, r.bad + (r.codes && r.bad ? ' ' + JSON.stringify(r.codes) : ''), r.rps, r.p50, r.p95, r.p99, r.max].join(' | ') + ' |');
    }
    if (sum.bad) process.exitCode = 1;
  } finally { if (own) await own.stop(); }
}
main().catch((e) => { console.error('压力测试：' + e.message); process.exit(1); });
