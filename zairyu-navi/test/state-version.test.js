// 多台设备同时修改：概况和进度带版本号，带着过时的版本保存返回 409 和服务器上现在的内容；网页端逐项合并后重试（web/merge.js）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server');
const { createStore } = require('../src/store');
const { execTool } = require('../src/assistant');
const { merge, mergeTrips } = require('../web/merge');

const V = '2026-11-27';
async function start(opts) {
  const app = createApp(Object.assign({ now: '2026-11-26' }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
  };
  return { app, call, stop: () => { app.server.close(); app.store.close(); } };
}
// 一台“设备”：读一次账号，记下 base（上次和服务器对上的内容），本机改 mine，保存时带 base 的版本；409 就合并后重试（和网页端同一套做法）
function device(s, u) {
  const d = { base: null, mine: null, conflicts: [] };
  d.load = async () => { const r = await s.call('GET', `/api/users/${u.id}`, null, u.token); d.base = { profile: r.body.profile, done: r.body.done, version: r.body.version }; d.mine = JSON.parse(JSON.stringify({ profile: r.body.profile, done: r.body.done })); };
  d.save = async () => {
    for (let i = 0; i < 3; i++) {
      const r = await s.call('PUT', `/api/users/${u.id}/state`, { profile: d.mine.profile, done: d.mine.done, version: d.base.version }, u.token);
      if (r.status === 200) { d.base = JSON.parse(JSON.stringify({ profile: d.mine.profile, done: d.mine.done, version: r.body.version })); return r; }
      assert.equal(r.status, 409, JSON.stringify(r.body));
      const cur = r.body.current, m = merge(d.base, d.mine, cur);
      d.conflicts = d.conflicts.concat(m.conflicts);
      d.mine = { profile: m.profile, done: m.done }; d.base = { profile: cur.profile, done: cur.done, version: cur.version };
    }
    throw new Error('合并后仍然保存不上');
  };
  return d;
}

test('概况有版本号：每存一次加一；带过时的版本保存返回 409 和现在的内容，什么都不改', async () => {
  const s = await start();
  try {
    const u = (await s.call('POST', '/api/users', { accept: V })).body;
    assert.equal(u.version, 0);
    let r = await s.call('PUT', `/api/users/${u.id}/state`, { profile: { status: 'work' }, done: {}, version: 0 }, u.token);
    assert.deepEqual(r.body, { ok: true, version: 1 });
    r = await s.call('PUT', `/api/users/${u.id}/state`, { profile: { status: 'student' }, done: { '1-1': true }, version: 0 }, u.token);
    assert.equal(r.status, 409); assert.match(r.body.error, /另一台设备/);
    assert.equal(r.body.current.version, 1); assert.equal(r.body.current.profile.status, 'work'); assert.deepEqual(r.body.current.done, {});
    assert.equal((await s.call('GET', `/api/users/${u.id}`, null, u.token)).body.profile.status, 'work', '过时的保存没有生效');
    // 不带版本的旧客户端照常整体保存（后存的覆盖先存的）
    r = await s.call('PUT', `/api/users/${u.id}/state`, { profile: { status: 'hsp' }, done: {} }, u.token);
    assert.deepEqual(r.body, { ok: true, version: 2 });
    // PATCH 也认版本；新版本在响应头里
    r = await s.call('PATCH', `/api/users/${u.id}/profile`, { status: 'pr', version: 1 }, u.token);
    assert.equal(r.status, 409); assert.equal(r.body.current.profile.status, 'hsp');
    r = await s.call('PATCH', `/api/users/${u.id}/profile`, { status: 'pr', version: 2 }, u.token);
    assert.equal(r.status, 200); assert.equal(r.body.status, 'pr'); assert.equal(r.body.version, undefined, '返回的仍然只是概况'); assert.equal(r.headers.get('x-state-version'), '3');
    for (const bad of [-1, 1.5, '3', true]) assert.equal((await s.call('PUT', `/api/users/${u.id}/state`, { profile: {}, done: {}, version: bad }, u.token)).status, 422, String(bad));
    // 内容不合格时先报 422，不报 409
    assert.equal((await s.call('PUT', `/api/users/${u.id}/state`, { profile: { status: 'king' }, done: {}, version: 0 }, u.token)).status, 422);
    // 完成任务的接口、助手的工具改了概况，版本同样加一：网页端再用旧版本保存会收到 409，不会把助手记下的内容盖掉
    assert.equal((await s.call('PUT', `/api/users/${u.id}/tasks/2-1/done`, { done: true }, u.token)).status, 200);
    const v4 = (await s.call('GET', `/api/users/${u.id}`, null, u.token)).body.version;
    assert.equal(v4, 4);
    execTool('update_profile', { entry: '2026-11-18' }, { user: s.app.store.getUser(u.id), store: s.app.store, now: '2026-11-26' });
    const after = (await s.call('GET', `/api/users/${u.id}`, null, u.token)).body;
    assert.equal(after.version, 5); assert.equal(after.profile.entry, '2026-11-18');
    assert.equal((await s.call('PUT', `/api/users/${u.id}/state`, { profile: { entry: '' }, done: {}, version: 4 }, u.token)).status, 409);
  } finally { s.stop(); }
});

test('两台设备改不同的项：后存的那台收到 409，合并后两边的修改都留下', async () => {
  const s = await start();
  try {
    const u = (await s.call('POST', '/api/users', { accept: V })).body;
    assert.equal((await s.call('PUT', `/api/users/${u.id}/state`, { profile: { status: 'work', addr: '2026-11-20', trips: [['2025-01-01', '2025-01-10'], ['2025-03-01', '2025-03-05']] }, done: { '1-1': true } }, u.token)).status, 200);
    const a = device(s, u), b = device(s, u);
    await a.load(); await b.load();
    // A：改入境日、加一条出国记录、完成 2-1
    a.mine.profile.entry = '2026-11-18'; a.mine.profile.trips.push(['2025-08-01', '2025-08-20']); a.mine.done['2-1'] = true;
    // B：改在留期满日、勾“以永驻为目标”、删掉一条出国记录、撤销 1-1、完成 2-2
    b.mine.profile.exp = '2027-11-20'; b.mine.profile.pr = true; b.mine.profile.trips = b.mine.profile.trips.filter((t) => t[0] !== '2025-03-01'); delete b.mine.done['1-1']; b.mine.done['2-2'] = true;
    await a.save();
    const r = await b.save();
    assert.equal(r.status, 200);
    assert.deepEqual(b.conflicts, [], '改的不是同一项，没有冲突');
    const got = (await s.call('GET', `/api/users/${u.id}`, null, u.token)).body;
    assert.equal(got.profile.entry, '2026-11-18', 'A 改的入境日还在'); assert.equal(got.profile.exp, '2027-11-20', 'B 改的期满日存上了'); assert.equal(got.profile.pr, true);
    assert.equal(got.profile.status, 'work'); assert.equal(got.profile.addr, '2026-11-20');
    assert.deepEqual(got.profile.trips, [['2025-01-01', '2025-01-10'], ['2025-08-01', '2025-08-20']], 'A 加的留下，B 删的删掉');
    assert.deepEqual(got.done, { '2-1': true, '2-2': true }, 'A 完成的、B 完成的都在，B 撤销的撤销了');
    assert.equal(got.version, 3);
    // A 再存一次（它的 base 已经过时）：合并后不会把 B 的修改盖掉
    a.mine.profile.lic = true; await a.save();
    const fin = (await s.call('GET', `/api/users/${u.id}`, null, u.token)).body;
    assert.equal(fin.profile.lic, true); assert.equal(fin.profile.exp, '2027-11-20'); assert.deepEqual(fin.done, { '2-1': true, '2-2': true });
  } finally { s.stop(); }
});

test('两台设备改同一项：后存的那台以本机为准，并报告这一项有冲突；改成一样的不算冲突', async () => {
  const s = await start();
  try {
    const u = (await s.call('POST', '/api/users', { accept: V })).body;
    const a = device(s, u), b = device(s, u);
    await a.load(); await b.load();
    a.mine.profile.status = 'work'; a.mine.profile.entry = '2026-11-18'; a.mine.done['0-1'] = true;
    b.mine.profile.status = 'student'; b.mine.profile.entry = '2026-11-18'; delete b.mine.done['0-1'];
    await a.save(); await b.save();
    assert.deepEqual(b.conflicts, ['status'], '入境日两边改成一样的，不算冲突');
    const got = (await s.call('GET', `/api/users/${u.id}`, null, u.token)).body;
    assert.equal(got.profile.status, 'student', '后存的那台设备刚改的为准'); assert.equal(got.profile.entry, '2026-11-18');
    assert.deepEqual(got.done, { '0-1': true }, 'B 没动 0-1，用 A 的');
    // 同一个任务：A 撤销、B 也动了（B 完成 1-1，A 撤销 0-1）
    await a.load(); await b.load();
    delete a.mine.done['0-1']; b.mine.done['1-1'] = true;
    await a.save(); await b.save();
    assert.deepEqual((await s.call('GET', `/api/users/${u.id}`, null, u.token)).body.done, { '1-1': true });
  } finally { s.stop(); }
});

test('合并函数：出国记录按“出国日~回国日”逐条合并；本机没动的项跟服务器；空的 base 也能用', () => {
  const t1 = ['2025-01-01', '2025-01-10'], t2 = ['2025-03-01', '2025-03-05'], t3 = ['2025-08-01', '2025-08-20'], t4 = ['2024-12-01', '2024-12-02'];
  assert.deepEqual(mergeTrips([t1, t2], [t1, t2, t3], [t1, t2, t4]), [t4, t1, t2, t3], '两边各加一条，都留下，按日期排');
  assert.deepEqual(mergeTrips([t1, t2], [t1], [t1, t2, t3]), [t1, t3], '本机删的删掉，服务器加的留下');
  assert.deepEqual(mergeTrips([t1, t2], [t1, t2], [t2]), [t2], '服务器删的也删掉');
  assert.deepEqual(mergeTrips([], [t1], [t1]), [t1], '两边加了同一条只留一条');
  const m = merge({ profile: { status: 'none', trips: [t1] }, done: {} }, { profile: { status: 'none', trips: [t1] }, done: {} }, { profile: { status: 'work', entry: '2026-11-18', trips: [t1, t2] }, done: { '0-1': true } });
  assert.deepEqual(m, { profile: { status: 'work', trips: [t1, t2], entry: '2026-11-18' }, done: { '0-1': true }, conflicts: [] }, '本机什么都没改：完全用服务器的');
  const e = merge(null, { profile: { status: 'work' }, done: { '1-1': true } }, { profile: { status: 'student' }, done: {} });
  assert.deepEqual(e.conflicts, ['status']); assert.equal(e.profile.status, 'work'); assert.deepEqual(e.done, { '1-1': true });
});

test('旧的库文件（users 表没有 version 列）：打开时补上，旧账号从 0 起，照常保存', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-ver-')), file = path.join(dir, 'old.db');
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, consent_version TEXT NOT NULL, consent_at TEXT NOT NULL, profile TEXT NOT NULL, done TEXT NOT NULL, plan TEXT NOT NULL, auth TEXT NOT NULL)');
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run('old-user', 'x', '2026-11-01T00:00:00Z', V, '2026-11-01T00:00:00Z', JSON.stringify({ status: 'work' }), '{}', '{}', '{}');
    db.close();
    const st = createStore(file);
    const u = st.getUser('old-user');
    assert.equal(u.version, 0); assert.equal(u.profile.status, 'work');
    assert.equal(st.saveUser(u, 'test', null, 0), 1);
    assert.equal(st.saveUser(u, 'test', null, 0), null, '过时的版本不保存');
    const n = st.createUser(V); assert.equal(n.version, 0, '新账号也能建');
    st.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
