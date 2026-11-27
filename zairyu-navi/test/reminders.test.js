// 期限提醒邮件：自愿打开、退订、7 天前、1 天前、当天各一封、不重复发、办完或改掉的不发、失败重试。
// 邮件不联网，从发件箱（outbox）里读；时间用假的时钟拨。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp, reminderConfig } = require('../src/server');
const { createStore } = require('../src/store');
const { createScheduler } = require('../src/scheduler');
const { createSender, deliverOutbox, TEXTS, buildMessage } = require('../src/mailer');
const { findSensitive } = require('../src/validate');

const WIDE = { max: 100000, windowMs: 3600000 };
const LOOSE = { reqEmail: [WIDE], reqEmailAll: [WIDE], reqIp: [WIDE], reqUser: [WIDE], verIp: [WIDE], verUser: [WIDE] };
const DAY = 24 * 60 * 60 * 1000, MIN = 60 * 1000;
const APP = 'https://navi.example.jp';
// 开始时是日本时间 2026-11-27 12:00
const T0 = Date.parse('2026-11-27T03:00:00Z');
async function start(opts) {
  let t = (opts && opts.t0) || T0;
  const clock = () => t;
  const app = createApp(Object.assign({ adminToken: 'adm', clock, emailLimits: LOOSE, signupLimit: WIDE, appUrl: APP }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, p, body, token, headers) => {
    const r = await fetch(base + p, { method, headers: Object.assign(body && typeof body === 'object' ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}, headers || {}), body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* 不是 JSON（退订页） */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const s = {
    app, base, call, clock,
    advance: (ms) => { t += ms; },
    // 新账号：就劳身份，11 月 20 日定下住所（住民登记的期限是 12 月 4 日）
    newUser: async (profile) => {
      const u = (await call('POST', '/api/users', { accept: app.termsVersion })).body;
      const r = await call('PATCH', `/api/users/${u.id}/profile`, Object.assign({ status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2028-11-20', ins: true }, profile || {}), u.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return u;
    },
    // 更换、解除之前验证原来的邮箱，返回确认 proof
    proveOld: async (u, action) => {
      const old = app.store.getEmail(u.id).email;
      const r = await call('POST', `/api/users/${u.id}/email/old`, { action }, u.token);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await app.deliver();
      const v = await call('POST', `/api/users/${u.id}/email/old/verify`, { action, challengeId: r.body.challengeId, code: s.codeTo(old) }, u.token);
      assert.equal(v.status, 200, JSON.stringify(v.body));
      return v.body.proof;
    },
    codeTo: (email) => /验证码：(\d{6})/.exec(app.store.listOutbox({ to: email }).filter((m) => m.kind === 'code').pop().body)[1],
    unbind: async (u) => call('DELETE', `/api/users/${u.id}/email`, app.store.getEmail(u.id) ? { proof: await s.proveOld(u, 'remove') } : null, u.token),
    bind: async (u, email) => {
      const proof = app.store.getEmail(u.id) ? await s.proveOld(u, 'change') : undefined;
      const r = await call('POST', `/api/users/${u.id}/email`, { email, consent: true, proof }, u.token);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      await app.deliver();
      const code = s.codeTo(email);
      const v = await call('POST', `/api/users/${u.id}/email/verify`, { challengeId: r.body.challengeId, code, proof }, u.token);
      assert.equal(v.status, 200, JSON.stringify(v.body));
      return v.body;
    },
    optIn: async (u, on) => call('PUT', `/api/users/${u.id}/email/reminders`, { on: on !== false }, u.token),
    // 绑定邮箱并打开提醒的账号
    ready: async (email, profile) => { const u = await s.newUser(profile); await s.bind(u, email); assert.equal((await s.optIn(u)).status, 200); return u; },
    mails: (to) => app.store.listOutbox(to ? { to } : {}).filter((m) => m.kind === 'reminder'),
    // 跑一轮并发掉
    run: async () => { const r = app.remind(); await app.deliver(); return r; },
    stop: async () => { await app.deliver(); app.server.close(); app.server.closeAllConnections(); app.store.close(); }
  };
  return s;
}
const RESIDENT = '住民登记：定下住所后14天内到区役所办理';

test('默认不发：没绑定邮箱、绑定了但没打开提醒，都不发；没绑定邮箱时打不开提醒', async () => {
  const s = await start({ t0: T0 });
  try {
    const a = await s.newUser(), b = await s.newUser();
    assert.equal((await s.optIn(a)).status, 409, '没有邮箱不能开');
    const bound = await s.bind(b, 'b@example.com');
    assert.equal(bound.remindOptIn, false, '绑定之后默认是关的');
    assert.deepEqual((await s.call('GET', `/api/users/${b.id}/email`, null, b.token)).body, { email: 'b***@example.com', verified: true, remindOptIn: false });
    assert.deepEqual(await s.run(), { users: 0, mails: 0, items: 0, errors: 0 });
    for (let i = 0; i < 9; i++) { s.advance(DAY); await s.run(); }
    assert.equal(s.mails().length, 0);
    // 开关要明确的 true 或 false，要登录
    assert.equal((await s.call('PUT', `/api/users/${b.id}/email/reminders`, { on: 'yes' }, b.token)).status, 422);
    assert.equal((await s.call('PUT', `/api/users/${b.id}/email/reminders`, { on: true })).status, 401);
    assert.equal((await s.call('PUT', `/api/users/${b.id}/email/reminders`, { on: true }, a.token)).status, 401, '别人的令牌不行');
    assert.deepEqual((await s.optIn(b)).body, { remindOptIn: true });
    assert.deepEqual((await s.optIn(b, false)).body, { remindOptIn: false });
    // 留痕只记开关，不记邮箱
    const audit = s.app.store.auditRows().filter((r) => r.action === 'email.remind');
    assert.deepEqual(audit.map((r) => r.detail), ['{"on":true}', '{"on":false}']);
    assert.ok(!JSON.stringify(s.app.store.auditRows()).includes('example.com'));
  } finally { await s.stop(); }
});

test('绑定时可以顺便打开提醒（remindOptIn: true）；换绑邮箱后要重新开', async () => {
  const s = await start();
  try {
    const u = await s.newUser(), E = `/api/users/${u.id}/email`;
    const r = await s.call('POST', E, { email: 'a@example.com', consent: true }, u.token); await s.app.deliver();
    const code = /验证码：(\d{6})/.exec(s.app.store.listOutbox({ to: 'a@example.com' }).pop().body)[1];
    assert.deepEqual((await s.call('POST', E + '/verify', { challengeId: r.body.challengeId, code, remindOptIn: true }, u.token)).body, { email: 'a***@example.com', verified: true, remindOptIn: true });
    s.advance(2 * MIN);
    assert.equal((await s.bind(u, 'new@example.com')).remindOptIn, false, '新邮箱没有同意过收提醒');
  } finally { await s.stop(); }
});

test('法定期限在 7 天前、1 天前、当天各发一封，每封只发一次；邮件里有全文、到期日、应用链接和退订链接', async () => {
  const s = await start({ t0: T0 - DAY }); // 日本时间 11 月 26 日：离 12 月 4 日还有 8 天
  try {
    const u = await s.ready('li@example.com');
    assert.deepEqual(await s.run(), { users: 1, mails: 0, items: 0, errors: 0 }, '还有 8 天，不发');
    const sent = [];
    for (let day = 27; day <= 35; day++) { // 11 月 27 日到 12 月 5 日，每天跑三轮
      s.advance(DAY);
      for (let k = 0; k < 3; k++) { const r = await s.run(); if (r.mails) sent.push([day, r.items]); }
    }
    assert.deepEqual(sent, [[27, 1], [33, 1], [34, 1]], '只在 11 月 27 日（前 7 天）、12 月 3 日（前 1 天）、12 月 4 日（当天）各发一封');
    const m = s.mails('li@example.com');
    assert.deepEqual(m.map((x) => x.status), ['sent', 'sent', 'sent']);
    assert.deepEqual(m.map((x) => x.subject), ['【在留导航】有 1 件事快到期限', '【在留导航】有 1 件事明天到期', '【在留导航】有 1 件事今天到期']);
    assert.match(m[0].body, /1\. 2026年12月4日（还有 7 天）\n {3}住民登记：定下住所后14天内到区役所办理/);
    assert.match(m[1].body, /2026年12月4日（明天到期）/); assert.match(m[2].body, /2026年12月4日（今天到期）/);
    const token = /\/api\/unsubscribe\?t=([A-Za-z0-9_-]+)/.exec(m[0].body)[1];
    assert.ok(token.length >= 43, '退订令牌是 32 个随机字节');
    for (const x of m) {
      assert.ok(x.body.includes(APP + '/#reminders'), '有打开应用的链接');
      assert.ok(x.body.includes(APP + '/api/unsubscribe?t=' + token), '有退订链接');
      assert.deepEqual(x.headers, { 'List-Unsubscribe': '<' + APP + '/api/unsubscribe?t=' + token + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
      assert.match(x.body, /只供参考/);
      // 邮件里没有提醒以外的东西：账号编号、令牌、邮箱、在留资格、别的日期
      assert.ok(!x.body.includes(u.id) && !x.body.includes(u.token) && !x.body.includes('li@example.com'));
      assert.doesNotMatch(x.body, /2028|就劳|技术|年末调整|确定申告/, '不到期的提醒和概况不写进邮件');
    }
    // 账本：三档各一行，都发出去了
    assert.deepEqual(s.app.store.listReminderSends(u.id).map((r) => [r.due, r.stage, r.status]), [['2026-12-04', 7, 'sent'], ['2026-12-04', 1, 'sent'], ['2026-12-04', 0, 'sent']]);
    // 这些头能拼成一封合规的邮件
    assert.match(buildMessage({ to: 'li@example.com', subject: m[0].subject, text: m[0].body, headers: m[0].headers }, 'no-reply@example.jp'), /\r\nList-Unsubscribe: <https:\/\/navi\.example\.jp\/api\/unsubscribe\?t=[\w-]+>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n/);
  } finally { await s.stop(); }
});

test('事件期限的邮件带法条和官方页面的链接；同一轮到期的几件事合成一封', async () => {
  const s = await start();
  try {
    const u = await s.ready('li@example.com');
    // 11 月 20 日换工作：14 天期限也是 12 月 4 日
    assert.equal((await s.call('POST', `/api/users/${u.id}/events`, { type: 'job_change', date: '2026-11-20' }, u.token)).status, 201);
    assert.deepEqual(await s.run(), { users: 1, mails: 1, items: 2, errors: 0 });
    const m = s.mails('li@example.com');
    assert.equal(m.length, 1, '两件事一封邮件');
    assert.equal(m[0].subject, '【在留导航】有 2 件事快到期限');
    assert.match(m[0].body, /1\. 2026年12月4日（还有 7 天）\n {3}住民登记/);
    // 事件期限在邮件里用不分在留资格的写法，两种届出的官方页面都带上
    assert.match(m[0].body, /2\. 2026年12月4日（还有 7 天）\n {3}工作、学校等所属机关有变动（离开或加入）：自变动之日起14天内，向入管提交所属机关的届出[^\n]+\n {3}依据：入管法第19条の16（入管厅：所属（契约）机关届出）\n {3}https:\/\/www\.moj\.go\.jp\/isa\/applications\/procedures\/nyuukokukanri10_00015\.html\n {3}入管厅：所属（活动）机关届出\n {3}https:\/\/www\.moj\.go\.jp\/isa\/applications\/procedures\/nyuukokukanri10_00014\.html/);
    // 住民登记这类本来就不分在留资格的，邮件里和接口返回的是同一段文字
    const api = (await s.call('GET', `/api/users/${u.id}/reminders`, null, u.token)).body.filter((r) => r.date === '2026-12-04');
    assert.equal(api.length, 2); assert.ok(m[0].body.includes(api.find((r) => r.tag === '法定期限').text), '邮件里是提醒的全文');
    // 高度专门职、留学换工作：页面上的说明各不相同，邮件里的这一条和就劳的一字不差
    const block = (body) => /2\. 2026年12月4日[\s\S]*?nyuukokukanri10_00014\.html/.exec(body)[0];
    for (const st of ['hsp', 'student']) {
      const h = await s.ready(st + '@example.com', { status: st });
      await s.call('POST', `/api/users/${h.id}/events`, { type: 'job_change', date: '2026-11-20' }, h.token);
      const shown = (await s.call('GET', `/api/users/${h.id}/reminders`, null, h.token)).body.find((r) => r.tag === '事件').text;
      assert.notEqual(shown, (await s.call('GET', `/api/users/${u.id}/reminders`, null, u.token)).body.find((r) => r.tag === '事件').text);
      await s.run();
      assert.equal(block(s.mails(st + '@example.com')[0].body), block(m[0].body), st);
      assert.doesNotMatch(s.mails(st + '@example.com')[0].body, /高度专门职|1号ハ|学校、机构：/);
    }
  } finally { await s.stop(); }
});

test('每天变日期的“提醒”（现在是年末调整的时期、路线、习惯、每月）不发邮件，连着跑几天也不发', async () => {
  const s = await start();
  try {
    // 期限都很远的账号：住所 2025 年就定了并已办完登记
    const u = await s.ready('far@example.com', { addr: '2025-01-10', entry: '2025-01-05', pr: true });
    await s.call('PUT', `/api/users/${u.id}/tasks/1-1/done`, { done: true }, u.token);
    const texts = (await s.call('GET', `/api/users/${u.id}/reminders`, null, u.token)).body;
    assert.ok(texts.some((r) => /^现在是年末调整的时期/.test(r.text) && r.date === '2026-11-27'), '接口里有这条“今天”的提醒');
    assert.ok(texts.some((r) => r.tag === '习惯'));
    for (let i = 0; i < 6; i++) { assert.equal((await s.run()).mails, 0); s.advance(DAY); }
    assert.equal(s.mails().length, 0);
    assert.deepEqual(s.app.store.listReminderSends(u.id), []);
  } finally { await s.stop(); }
});

test('同时跑、重复跑、重启、两个进程用同一个数据库：同一档只发一封', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-remind-')), 'r.db');
  try {
    let s = await start({ dbFile: file });
    const u = await s.ready('li@example.com');
    // 另一个“进程”：对着同一个文件另开一个连接和定时任务
    const store2 = createStore(file, { clock: s.clock });
    const other = createScheduler({ store: store2, clock: s.clock, appUrl: APP });
    const got = [s.app.remind(), other.runOnce(), s.app.remind(), other.runOnce()];
    assert.deepEqual(got.map((r) => r.mails), [1, 0, 0, 0]);
    // 两边同时发件：谁先认领谁发
    const seen = [];
    const rec = { name: 'rec', dev: true, send: async (m) => { seen.push(m.subject); } };
    await Promise.all([deliverOutbox(store2, rec), deliverOutbox(store2, rec), s.app.deliver()]);
    assert.equal(s.mails('li@example.com').length, 1);
    assert.equal(s.mails('li@example.com')[0].status, 'sent');
    assert.ok(seen.length <= 1, '同一封不会被两边各发一次');
    store2.close();
    // 重启：账本在库里，再跑不重发
    await s.stop();
    s = await start({ dbFile: file });
    assert.deepEqual(await s.run(), { users: 1, mails: 0, items: 0, errors: 0 });
    assert.equal(s.mails('li@example.com').length, 1);
    // 主键拦住重复：直接再占同一档，占不到
    const row = s.app.store.listReminderSends(u.id)[0];
    assert.equal(s.app.store.claimReminder(u.id, row.rkey, row.due, row.stage, 'queued'), false);
    assert.equal(s.app.store.listReminderSends(u.id).filter((r) => r.stage === 7).length, 1);
    await s.stop();
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('停机几天后恢复、或快到期才打开提醒：只补一封，错过的那一档记账不补发', async () => {
  const s = await start({ t0: T0 + 4 * DAY }); // 12 月 1 日，还有 3 天
  try {
    const u = await s.ready('li@example.com');
    assert.equal((await s.run()).mails, 1);
    assert.match(s.mails()[0].body, /（还有 3 天）/);
    assert.equal((await s.run()).mails, 0);
    s.advance(3 * DAY); // 直接到 12 月 4 日当天（12 月 3 日那一轮没跑）
    assert.equal((await s.run()).mails, 1);
    assert.match(s.mails()[1].body, /（今天到期）/);
    assert.equal(s.mails().length, 2, '不补发“前 1 天”那封');
    assert.deepEqual(s.app.store.listReminderSends(u.id).map((r) => [r.stage, r.status]), [[7, 'sent'], [1, 'skipped'], [0, 'sent']]);
    s.advance(DAY); assert.equal((await s.run()).mails, 0, '过期之后不发');
  } finally { await s.stop(); }
});

test('办完的任务、删掉的事件、改了日期的期限不再发；改了日期按新日期重新提醒', async () => {
  const s = await start();
  try {
    const u = await s.ready('li@example.com');
    const ev = (await s.call('POST', `/api/users/${u.id}/events`, { type: 'job_change', date: '2026-11-20' }, u.token)).body;
    assert.equal((await s.run()).items, 2);
    // 办完住民登记、删掉换工作的事件
    assert.equal((await s.call('PUT', `/api/users/${u.id}/tasks/1-1/done`, { done: true }, u.token)).status, 200);
    assert.equal((await s.call('DELETE', `/api/users/${u.id}/events/${ev.id}`, null, u.token)).status, 204);
    s.advance(6 * DAY); assert.equal((await s.run()).mails, 0, '前 1 天不发');
    s.advance(DAY); assert.equal((await s.run()).mails, 0, '当天不发');
    assert.equal(s.mails().length, 1);
    // 改了日期：撤销完成，把定下住所的日期改成 11 月 27 日（期限变成 12 月 11 日，这时还有 7 天）
    await s.call('PUT', `/api/users/${u.id}/tasks/1-1/done`, { done: false }, u.token);
    await s.call('PATCH', `/api/users/${u.id}/profile`, { addr: '2026-11-27' }, u.token);
    const r = await s.run();
    assert.deepEqual([r.mails, r.items], [1, 1]);
    assert.match(s.mails()[1].body, /2026年12月11日（还有 7 天）/);
    assert.equal(s.app.store.listReminderSends(u.id).filter((x) => x.due === '2026-12-04' && x.stage < 7).length, 0, '旧日期剩下的档没有发');
  } finally { await s.stop(); }
});

test('排队等重试期间办完了、退订了、换了邮箱：到时候不发，记为 dropped；只办完其中一件的，邮件里只剩没办完的', async () => {
  // 一个可以开关的发件方式：验证码照常发，提醒邮件先失败
  const got = [];
  const mode = { failReminders: true };
  const sender = { name: 'fake', dev: true, send: async (m) => { if (mode.failReminders && /件事/.test(m.subject)) throw new Error('550 <' + m.to + '> 暂时不收'); got.push(m); } };
  const t = await start({ sender });
  try {
    got.length = 0;
    const a = await t.ready('a@example.com'), b = await t.ready('b@example.com'), c = await t.ready('c@example.com'), d = await t.ready('d@example.com');
    for (const x of [a, b, c, d]) await t.call('POST', `/api/users/${x.id}/events`, { type: 'job_change', date: '2026-11-20' }, x.token);
    got.length = 0;
    assert.deepEqual(await t.run(), { users: 4, mails: 4, items: 8, errors: 0 });
    assert.deepEqual(t.mails().map((m) => [m.status, m.tries]), [['queued', 1], ['queued', 1], ['queued', 1], ['queued', 1]]);
    assert.ok(t.mails().every((m) => /550 <［邮箱］> 暂时不收/.test(m.lastError)), '失败有记录，记录里没有邮箱');
    // 等重试的一分钟里：a 两件都办完，b 退订，c 换了邮箱，d 只办完住民登记
    await t.call('PUT', `/api/users/${a.id}/tasks/1-1/done`, { done: true }, a.token);
    for (const ev of (await t.call('GET', `/api/users/${a.id}/events`, null, a.token)).body) await t.call('DELETE', `/api/users/${a.id}/events/${ev.id}`, null, a.token);
    const tokenB = /unsubscribe\?t=([\w-]+)/.exec(t.mails('b@example.com')[0].body)[1];
    assert.equal((await t.call('POST', '/api/unsubscribe?t=' + tokenB)).status, 200);
    t.advance(61 * 1000);
    await t.bind(c, 'c2@example.com');
    await t.call('PUT', `/api/users/${d.id}/tasks/1-1/done`, { done: true }, d.token);
    // 换绑时顺带又试发了一轮（还是失败），下一次重试在 5 分钟后
    t.advance(6 * MIN); mode.failReminders = false; got.length = 0;
    await t.app.deliver();
    const rem = got.filter((m) => /件事/.test(m.subject));
    assert.deepEqual(rem.map((m) => m.to), ['d@example.com'], '只有 d 收到');
    assert.equal(rem[0].subject, '【在留导航】有 1 件事快到期限');
    assert.ok(!rem[0].text.includes('住民登记') && rem[0].text.includes('所属机关有变动'), '办完的那件不在邮件里');
    const st = (x) => t.app.store.listReminderSends(x.id).map((r) => r.status).sort();
    assert.deepEqual(st(a), ['dropped', 'dropped'], '办完了的：记为 dropped');
    assert.deepEqual(st(b), [], '退订的：没发出去的这一档不记账（再打开提醒时还能排上）'); assert.deepEqual(st(c), [], '换了邮箱的也一样');
    assert.deepEqual(st(d), ['sent', 'sent']);
    const rows = t.app.store.listOutbox().filter((m) => m.kind === 'reminder');
    assert.deepEqual(rows.map((m) => m.status).sort(), ['dropped', 'dropped', 'dropped', 'sent']);
    assert.ok(rows.filter((m) => m.status === 'dropped').every((m) => m.body === '' && m.to === ''), '不发的邮件不留正文和地址');
    assert.equal(rows.find((m) => m.status === 'sent').body, rem[0].text, '发件箱里留的是实际发出去的那一版');
    // 之后再跑：这一档不重发
    assert.equal((await t.run()).mails, 0);
  } finally { await t.stop(); }
});

test('发送失败：按 1 分钟、5 分钟、30 分钟、2 小时、12 小时重试，到上限记为 failed；重试不会多记账、不会多发', async () => {
  let fail = true; const got = [];
  const sender = { name: 'fake', dev: true, send: async (m) => { if (/件事/.test(m.subject)) { if (fail) throw new Error('连不上'); got.push(m); } } };
  // 期限放远一点，重试期间一直在同一档里：12 月 4 日到期，从 11 月 28 日（还有 6 天）开始
  const s = await start({ sender, t0: T0 + DAY });
  try {
    const u = await s.ready('li@example.com');
    assert.equal((await s.run()).mails, 1);
    const one = () => s.mails('li@example.com')[0];
    assert.deepEqual([one().status, one().tries], ['queued', 1]);
    await s.run(); assert.equal(one().tries, 1, '没到重试时间不重发');
    s.advance(MIN + 1000); fail = false; await s.run();
    assert.deepEqual([one().status, one().tries, got.length], ['sent', 2, 1], '一分钟后重试成功，只发了一封');
    assert.equal(s.app.store.listReminderSends(u.id).length, 1, '账本还是一行');
    assert.equal(s.app.store.listReminderSends(u.id)[0].status, 'sent');
    await s.run(); assert.equal(got.length, 1);

    // 另一个账号：一直失败
    fail = true;
    const v = await s.ready('wang@example.com');
    await s.run();
    const two = () => s.mails('wang@example.com')[0];
    for (const waitMin of [1, 5, 30, 120, 720]) { assert.equal(two().status, 'queued'); s.advance(waitMin * MIN + 1000); await s.app.deliver(); }
    assert.deepEqual([two().status, two().tries, two().lastError], ['failed', 6, '连不上']);
    assert.equal(s.app.store.listReminderSends(v.id)[0].status, 'failed', '账本里记下没发成');
    fail = false; s.advance(DAY); await s.app.deliver();
    assert.equal(got.length, 1, '到上限之后不再重试');
    assert.equal((await s.run()).mails, 0, '这一档不重新排');
  } finally { await s.stop(); }
});

test('拖到下一档的日子才轮到重试：旧的那封不发，由当天那一档自己的邮件来说', async () => {
  let fail = true; const got = [];
  const sender = { name: 'fake', dev: true, send: async (m) => { if (/件事/.test(m.subject)) { if (fail) throw new Error('连不上'); got.push(m); } } };
  const s = await start({ sender, t0: T0 + 5 * DAY }); // 12 月 2 日，还有 2 天
  try {
    await s.ready('li@example.com');
    await s.run();
    s.advance(DAY); fail = false; // 12 月 3 日：前 1 天
    const r = await s.run();
    assert.equal(r.mails, 1);
    assert.deepEqual(got.map((m) => m.subject), ['【在留导航】有 1 件事明天到期'], '只收到前 1 天这一封');
    assert.deepEqual(s.mails().map((m) => m.status), ['dropped', 'sent']);
  } finally { await s.stop(); }
});

test('退订：邮件里的链接不用登录；GET 只显示确认页不改任何东西，POST 才退订；重复点、乱写的令牌都是同一个页面；之后不再发', async () => {
  const s = await start();
  try {
    const u = await s.ready('li@example.com');
    await s.run();
    const link = /https:\/\/navi\.example\.jp(\/api\/unsubscribe\?t=[\w-]+)/.exec(s.mails()[0].body)[1];
    const E = `/api/users/${u.id}/email`;
    // GET：确认页，带一个 POST 的表单，不改开关（邮件服务预先打开链接不会让人退订）
    const page = await s.call('GET', link);
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.text, /<form method="post" action="\/api\/unsubscribe\?t=[\w-]+">/); assert.match(page.text, /退订/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/); assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.ok(!page.text.includes('li@example.com') && !page.text.includes(u.id), '确认页上没有邮箱和账号');
    assert.equal((await s.call('GET', E, null, u.token)).body.remindOptIn, true, 'GET 不退订');
    // POST：不带令牌头，表单格式的请求体（邮件客户端的一键退订）也行
    const done = await s.call('POST', link, 'List-Unsubscribe=One-Click', null, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(done.status, 200); assert.match(done.text, /已退订/);
    assert.equal((await s.call('GET', E, null, u.token)).body.remindOptIn, false);
    // 再点一次、令牌不存在、令牌写法不对：页面一模一样，什么都不改
    const again = await s.call('POST', link);
    const unknown = await s.call('POST', '/api/unsubscribe?t=' + 'A'.repeat(43));
    const junk = await s.call('POST', '/api/unsubscribe?t=' + encodeURIComponent('"><script>alert(1)</script>'));
    const none = await s.call('POST', '/api/unsubscribe');
    for (const r of [again, unknown, junk, none]) { assert.equal(r.status, 200); assert.equal(r.text, done.text); }
    const junkGet = await s.call('GET', '/api/unsubscribe?t=' + encodeURIComponent('"><script>alert(1)</script>'));
    assert.equal(junkGet.status, 200); assert.ok(!junkGet.text.includes('<script') && !junkGet.text.includes('<form'), '写法不对的令牌不放进页面');
    const unknownGet = await s.call('GET', '/api/unsubscribe?t=' + 'A'.repeat(43));
    assert.equal(unknownGet.text.length, page.text.length, '令牌存不存在，确认页都一样');
    // 之后不再发
    for (let i = 0; i < 8; i++) { s.advance(DAY); assert.equal((await s.run()).mails, 0); }
    assert.equal(s.mails().length, 1);
    // 留痕：记了退订，没有令牌和邮箱
    const audit = JSON.stringify(s.app.store.auditRows());
    assert.match(audit, /email\.unsubscribe/); assert.ok(!audit.includes(link.split('t=')[1]) && !audit.includes('example.com'));
    // 在设置里重新打开之后恢复；旧邮件里的链接仍然能退订
    assert.equal((await s.optIn(u)).status, 200);
    await s.call('PATCH', `/api/users/${u.id}/profile`, { addr: '2026-12-01' }, u.token); // 新期限 12 月 15 日
    assert.equal((await s.run()).mails, 0); s.advance(3 * DAY); assert.equal((await s.run()).mails, 1);
    assert.match((await s.call('POST', link)).text, /已退订/);
    assert.equal((await s.call('GET', E, null, u.token)).body.remindOptIn, false);
  } finally { await s.stop(); }
});

test('在设置里关掉提醒、解除绑定、删除账号：排着队的提醒邮件不发，以后也不发；删除账号后账本清空', async () => {
  let hold = true; const got = [];
  const sender = { name: 'fake', dev: true, send: async (m) => { if (/件事/.test(m.subject)) { if (hold) throw new Error('稍后'); got.push(m.to); } } };
  const s = await start({ sender });
  try {
    const a = await s.ready('a@example.com'), b = await s.ready('b@example.com'), c = await s.ready('c@example.com');
    assert.equal((await s.run()).mails, 3);
    assert.equal((await s.optIn(a, false)).status, 200);
    assert.equal((await s.unbind(b)).status, 204);
    assert.equal(s.app.store.emailFootprint(c.id, 'c@example.com').reminders, 1);
    assert.equal((await s.call('DELETE', `/api/users/${c.id}`, null, c.token)).status, 204);
    assert.deepEqual(s.app.store.emailFootprint(c.id, 'c@example.com'), { sessions: 0, emails: 0, challenges: 0, outbox: 0, reminders: 0, rate: 0 });
    hold = false; s.advance(2 * MIN); await s.app.deliver();
    for (let i = 0; i < 8; i++) { s.advance(DAY); await s.run(); }
    assert.deepEqual(got, [], '三个人都没有收到');
    assert.deepEqual(s.app.store.listReminderSends(a.id).filter((r) => r.status === 'queued' || r.status === 'sent'), []);
    assert.ok(!JSON.stringify(s.app.store.listOutbox()).includes('b@example.com'), '解除绑定后发件箱里没有这个地址');
  } finally { await s.stop(); }
});

test('到期日按日本时间的日历日算，和服务器所在时区无关（TZ=UTC 和 TZ=Asia/Tokyo 结果一样）', async () => {
  // 日本时间 11 月 27 日 00:30（UTC 还是 26 日 15:30）：12 月 4 日的期限正好还有 7 天，应当发
  const s = await start({ t0: Date.parse('2026-11-26T15:30:00Z') });
  try {
    await s.ready('li@example.com');
    assert.equal((await s.run()).mails, 1, '日本已经是 27 日');
    assert.match(s.mails()[0].body, /2026年12月4日（还有 7 天）/);
  } finally { await s.stop(); }
  // 日本时间 11 月 26 日 23:30（UTC 26 日 14:30）：还有 8 天，不发；过了日本时间零点才发
  const e = await start({ t0: Date.parse('2026-11-26T14:30:00Z') });
  try {
    await e.ready('li@example.com');
    assert.equal((await e.run()).mails, 0);
    e.advance(31 * MIN); assert.equal((await e.run()).mails, 1);
    // 当天那一封：日本时间 12 月 4 日 00:10 就算当天
    e.advance(Date.parse('2026-12-03T15:10:00Z') - e.clock()); await e.run();
    assert.match(e.mails().pop().body, /2026年12月4日（今天到期）/);
  } finally { await e.stop(); }
});

test('管理入口 POST /api/admin/reminders/run：要管理员令牌；跑一轮并发掉，返回数量；发件箱接口能看到这封邮件', async () => {
  const s = await start();
  try {
    await s.ready('li@example.com');
    assert.equal((await s.call('POST', '/api/admin/reminders/run')).status, 401);
    assert.equal((await s.call('POST', '/api/admin/reminders/run', null, 'wrong')).status, 401);
    const r = await s.call('POST', '/api/admin/reminders/run', null, 'adm');
    assert.equal(r.status, 200); assert.deepEqual(r.body, { users: 1, mails: 1, items: 1, errors: 0, sent: 1, failed: 0, dropped: 0 });
    assert.deepEqual((await s.call('POST', '/api/admin/reminders/run', null, 'adm')).body, { users: 1, mails: 0, items: 0, errors: 0, sent: 0, failed: 0, dropped: 0 });
    const box = (await s.call('GET', '/api/admin/outbox?to=li@example.com', null, 'adm')).body.filter((m) => m.kind === 'reminder');
    assert.equal(box.length, 1); assert.equal(box[0].status, 'sent'); assert.match(box[0].body, /住民登记/);
    // 没配 ADMIN_TOKEN 的服务器：503
    const bare = createApp({ store: createStore() });
    const prev = process.env.ADMIN_TOKEN; delete process.env.ADMIN_TOKEN;
    await new Promise((ok) => bare.server.listen(0, '127.0.0.1', ok));
    try { assert.equal((await fetch('http://127.0.0.1:' + bare.server.address().port + '/api/admin/reminders/run', { method: 'POST' })).status, 503); } finally { if (prev != null) process.env.ADMIN_TOKEN = prev; bare.server.close(); bare.server.closeAllConnections(); }
  } finally { await s.stop(); }
});

test('接了真实发信时：管理接口不返回提醒邮件的正文，地址打码；日志里没有邮箱和正文', async () => {
  const sent = [], logs = [];
  const realErr = console.error, realLog = console.log;
  console.error = (...a) => logs.push(a.map(String).join(' ')); console.log = (...a) => logs.push(a.map(String).join(' '));
  let boom = false;
  const s = await start({ sender: { name: 'http', dev: false, send: async (m) => { if (boom && /件事/.test(m.subject)) throw new Error('rejected li@example.com: ' + m.text.slice(0, 30)); sent.push(m); } } });
  try {
    await s.call('POST', '/api/users', { accept: s.app.termsVersion });
    const u = (await s.call('POST', '/api/users', { accept: s.app.termsVersion })).body;
    await s.call('PATCH', `/api/users/${u.id}/profile`, { status: 'work', addr: '2026-11-20', entry: '2026-11-18', ins: true }, u.token);
    const r = await s.call('POST', `/api/users/${u.id}/email`, { email: 'li@example.com', consent: true }, u.token); await s.app.deliver();
    const code = /验证码：(\d{6})/.exec(sent.pop().text)[1];
    await s.call('POST', `/api/users/${u.id}/email/verify`, { challengeId: r.body.challengeId, code, remindOptIn: true }, u.token);
    boom = true;
    await s.call('POST', '/api/admin/reminders/run', null, 'adm');
    const box = (await s.call('GET', '/api/admin/outbox', null, 'adm')).body.filter((m) => m.kind === 'reminder');
    assert.equal(box.length, 1); assert.equal(box[0].to, 'l***@example.com'); assert.equal('body' in box[0], false);
    assert.ok(!box[0].lastError.includes('li@example.com'), box[0].lastError);
    assert.ok(!logs.join('\n').includes('li@example.com') && !logs.join('\n').includes('住民登记'), '日志里没有邮箱和提醒内容');
  } finally { console.error = realErr; console.log = realLog; await s.stop(); }
});

test('提醒邮件的文字：不含会被敏感号码过滤拦下的写法；依据的链接只接受 https', () => {
  const items = [
    { due: '2026-12-04', daysLeft: 7, txt: RESIDENT, src: null, dl: true },
    { due: '2026-12-09', daysLeft: 0, txt: '换工作或离职：14天内向入管申报', dl: true, src: { law: '入管法第19条の16第2号', title: '入管厅：所属（契约）机关届出', url: 'https://www.moj.go.jp/a.html', more: [{ title: '另一页', url: 'javascript:alert(1)' }, { title: '第三页', url: 'https://www.moj.go.jp/b.html' }] } },
    { due: '2026-12-10', daysLeft: 1, txt: '别的事', dl: true, src: { law: 'x', title: 'y', url: 'http://insecure.example/' } }
  ];
  const m = TEXTS.reminder(items, APP, APP + '/api/unsubscribe?t=abcDEF_-123');
  assert.equal(m.subject, '【在留导航】有 3 件事今天到期');
  assert.ok(m.text.includes('https://www.moj.go.jp/a.html') && m.text.includes('https://www.moj.go.jp/b.html'));
  assert.ok(!m.text.includes('javascript:') && !m.text.includes('insecure.example') && !m.text.includes('另一页'));
  // 链接以外的文字过一遍敏感号码过滤（日期、天数、条文号都不应当被当成号码）
  assert.equal(findSensitive(m.subject), null);
  assert.equal(findSensitive(m.text.replace(/https:\/\/\S+/g, '')), null);
  // 真实规则算出来的每一条事件期限也一样
  const eng = require('../src/engine')({ now: T0 });
  for (const type of Object.keys(eng.EVRULES)) for (const st of ['work', 'student', 'hsp', 'spouse', 'ssw', 'biz', 'family', 'pr', 'short']) {
    const e = require('../src/engine')({ now: T0, profile: { status: st, addr: '2026-11-20', entry: '2026-11-18' }, events: [{ type, date: '2026-11-25' }] });
    const list = e.reminders().map((r) => ({ due: r.date, daysLeft: 3, txt: r.txt, src: r.src }));
    if (!list.length) continue;
    const mail = TEXTS.reminder(list, APP, APP + '/api/unsubscribe?t=abcDEF_-123');
    assert.equal(findSensitive(mail.text.replace(/https:\/\/\S+/g, '')), null, type + ' ' + st);
  }
});

test('设置：APP_URL 的写法、真实发信时必须有 APP_URL、定时的参数不对都在启动时报错', () => {
  const dev = createSender({});
  assert.deepEqual(reminderConfig({}, dev), { appUrl: 'http://localhost:8787', enabled: false, intervalMin: 60, hour: 9 });
  assert.deepEqual(reminderConfig({ PORT: '9000', REMINDERS_ENABLED: '1', REMINDER_INTERVAL_MIN: '15', REMINDER_HOUR: '8', APP_URL: 'https://navi.example.jp/' }, dev), { appUrl: 'https://navi.example.jp', enabled: true, intervalMin: 15, hour: 8 });
  assert.equal(reminderConfig({ PORT: '9000' }, dev).appUrl, 'http://localhost:9000');
  assert.throws(() => reminderConfig({}, { name: 'http', dev: false }), /MAIL_SENDER=http 时需要配置 APP_URL/);
  assert.throws(() => reminderConfig({}, { name: 'smtp', dev: false }), /APP_URL/);
  assert.equal(reminderConfig({ APP_URL: 'https://navi.example.jp' }, { name: 'smtp', dev: false }).appUrl, 'https://navi.example.jp');
  for (const bad of ['navi.example.jp', 'ftp://x.y', 'https://a.b/?x=1', 'https://a b']) assert.throws(() => reminderConfig({ APP_URL: bad }, dev), /APP_URL/, bad);
  assert.throws(() => reminderConfig({ REMINDER_HOUR: '24' }, dev), /REMINDER_HOUR/);
  assert.throws(() => reminderConfig({ REMINDER_INTERVAL_MIN: '0' }, dev), /REMINDER_INTERVAL_MIN/);
  assert.throws(() => reminderConfig({ REMINDERS_ENABLED: 'yes' }, dev), /REMINDERS_ENABLED/);
});

test('npm run remind：跑一轮就退出，只打印数量；设置不全时不跑；和服务器用同一个库不重复发', async () => {
  assert.equal(require('../package.json').scripts.remind, 'node src/scheduler.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-remind-cli-')), file = path.join(dir, 'c.db');
  try {
    // 用真实的时间建一个 3 天后到期的账号（命令行用的是真实时钟）
    const s = await start({ dbFile: file, t0: Date.now() });
    const jstToday = new Date(Math.floor((Date.now() + 9 * 3600000) / DAY) * DAY);
    const addr = new Date(jstToday.getTime() - 11 * DAY).toISOString().slice(0, 10);
    const u = await s.ready('cli@example.com', { addr, entry: addr });
    await s.stop();
    const env = Object.assign({}, process.env, { DB_FILE: file, MAIL_SENDER: 'outbox', APP_URL: 'https://navi.example.jp' });
    delete env.NODE_OPTIONS;
    const run = (extra) => spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'scheduler.js')], { env: Object.assign({}, env, extra || {}), encoding: 'utf8', timeout: 20000 });
    const a = run();
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /看了 1 个账号，新排了 1 封（1 条提醒）；发件箱这一轮发出 1 封/);
    assert.ok(!(a.stdout + a.stderr).includes('cli@example.com') && !(a.stdout + a.stderr).includes('住民登记'), '输出里没有邮箱和提醒内容');
    const b = run();
    assert.equal(b.status, 0); assert.match(b.stdout, /新排了 0 封/);
    const store = createStore(file);
    const mails = store.listOutbox({ to: 'cli@example.com' }).filter((m) => m.kind === 'reminder');
    assert.equal(mails.length, 1); assert.equal(mails[0].status, 'sent'); assert.match(mails[0].body, /（还有 3 天）/); assert.ok(mails[0].body.includes('https://navi.example.jp/api/unsubscribe?t='));
    assert.equal(store.listReminderSends(u.id).length, 1);
    store.close();
    // 设置不全：不跑，退出码非 0，说清楚缺什么
    const bad = run({ MAIL_SENDER: 'smtp' });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /SMTP_HOST/);
    const noUrl = run({ MAIL_SENDER: 'http', MAIL_FROM: 'a@b.co', MAIL_HTTP_URL: 'http://127.0.0.1:9/x', MAIL_HTTP_KEY: 'k', APP_URL: '' });
    assert.notEqual(noUrl.status, 0); assert.match(noUrl.stderr, /APP_URL/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('npm start：真实发信而没有 APP_URL 时不启动', () => {
  const env = Object.assign({}, process.env, { PORT: '0', DB_FILE: path.join(os.tmpdir(), 'zairyu-never-created.db'), MAIL_SENDER: 'http', MAIL_FROM: 'a@b.co', MAIL_HTTP_URL: 'http://127.0.0.1:9/x', MAIL_HTTP_KEY: 'k' });
  delete env.APP_URL;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /邮件发送没有配置好：MAIL_SENDER=http 时需要配置 APP_URL/);
  assert.equal(fs.existsSync(env.DB_FILE), false, '没有启动，也没有建库');
});
