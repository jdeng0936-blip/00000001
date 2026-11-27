// 服务商入驻几个测试文件共用的启动和操作（文件名不以 .test.js 结尾，npm test 不单独跑它）。
const assert = require('node:assert/strict');
const { createApp, PROVIDER_TERMS_VERSION: PV } = require('../src/server');
const { jstToday } = require('../src/store');

const WIDE = { max: 100000, windowMs: 3600000 };
const LOOSE = { reqEmail: [WIDE], reqEmailAll: [WIDE], reqIp: [WIDE], reqUser: [WIDE], verIp: [WIDE], verUser: [WIDE] };
const ALICE = 'alice-token-0123456789abcdef', BOB = 'bob-token-0123456789abcdefgh';
const APP = 'https://navi.example.jp';
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// 一份格式正确的行政书士申请
const gyosei = (over) => Object.assign({ category: 'gyosei', name: '大阪中文行政书士事务所', address: '大阪府大阪市北区梅田1-2-3', licenseNo: '第１２３４５６７８号', licenseBody: '大阪府行政書士会', feeNote: '首次咨询30分钟5,500日元', area: '大阪、京都', langs: '中文、日语', agree: PV }, over);
const CHECK = { method: 'association_search', checkedOn: '2026-11-27', note: '会员检索一致' };

// at：起始时刻（默认 2026-11-27 12:00 日本时间）
async function start(opts, at) {
  let t = Date.parse(at || '2026-11-27T03:00:00Z');
  const clock = () => t;
  const app = createApp(Object.assign({ adminTokens: { alice: ALICE, bob: BOB }, clock, emailLimits: LOOSE, applyLimit: [WIDE], signupLimit: WIDE, appUrl: APP }, opts));
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (method, path, body, token, headers) => {
    const r = await fetch(base + path, { method, headers: Object.assign(body ? { 'content-type': 'application/json' } : {}, token ? { authorization: 'Bearer ' + token } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let b = null; try { b = text ? JSON.parse(text) : null; } catch (e) { b = text; }
    return { status: r.status, body: b, headers: r.headers };
  };
  const adm = (method, path, body, who) => call(method, path, body, who || ALICE);
  const mails = (to) => app.store.listOutbox({ to });
  const lastMail = (to) => mails(to).pop();
  const codeIn = (mail) => (/验证码：(\d{6})/.exec(mail.body) || [])[1];
  // 收验证码（申请用）
  const applyCode = async (email) => {
    const r = await call('POST', '/api/provider-apply/code', { email });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    return { challengeId: r.body.challengeId, code: codeIn(lastMail(email)) };
  };
  const apply = async (email, over) => call('POST', '/api/provider-apply', Object.assign(await applyCode(email), gyosei(over)));
  const appByRef = (ref) => app.store.applicationByRef(ref);
  // 核对日期默认用“今天”（日本时间）
  // 管理员看到的版本（批准、拒绝、要求修改都要带上）
  const rk = (id) => app.store.getApplication(id).reviewKey;
  const approve = async (ref, check) => adm('POST', '/api/admin/applications/' + appByRef(ref).id + '/approve', { licenseCheck: check === undefined || check === CHECK ? Object.assign({}, CHECK, { checkedOn: jstToday(t) }) : check, reviewKey: appByRef(ref).reviewKey });
  const claim = async (email) => {
    const r = await call('POST', '/api/provider-claim/code', { email });
    assert.equal(r.status, 202);
    const m = lastMail(email);
    return call('POST', '/api/provider-claim', { challengeId: r.body.challengeId, code: m && m.kind === 'code' ? codeIn(m) : '000000' });
  };
  // 申请、批准、领取令牌；pay 为真时把第一张账单标记为已付款。返回 { ref, providerId, invoiceId, token }
  const onboard = async (email, over, pay) => {
    const a = await apply(email, over); assert.equal(a.status, 201, JSON.stringify(a.body));
    const ap = await approve(a.body.ref, (over && over.category && !['gyosei', 'zeirishi', 'sharoshi', 'shiho', 'estate'].includes(over.category)) ? null : CHECK);
    assert.equal(ap.status, 200, JSON.stringify(ap.body));
    const c = await claim(email); assert.equal(c.status, 200, JSON.stringify(c.body));
    if (pay) assert.equal((await adm('POST', '/api/admin/invoices/' + ap.body.invoiceId + '/paid', { paidOn: jstToday(t) })).status, 200);
    return { ref: a.body.ref, providerId: ap.body.providerId, invoiceId: ap.body.invoiceId, token: c.body.token };
  };
  const newUser = async () => (await call('POST', '/api/users', { accept: app.termsVersion })).body;
  const inquire = async (u, providerIds, summary, category) => call('POST', `/api/users/${u.id}/inquiries`, { consent: true, category: category || 'gyosei', providerIds, summary: summary || '想咨询在留期间更新，明年三月到期，现在是技人国。' }, u.token);
  const listed = async (category) => (await call('GET', '/api/providers?category=' + (category || 'gyosei'))).body;
  return {
    app, base, call, adm, mails, lastMail, codeIn, applyCode, apply, appByRef, rk, approve, claim, onboard, newUser, inquire, listed,
    now: () => t, advance: (ms) => { t += ms; }, set: (iso) => { t = Date.parse(iso); },
    stop: async () => { await app.deliver(); app.server.close(); app.server.closeAllConnections(); app.store.close(); }
  };
}

module.exports = { start, gyosei, CHECK, PV, ALICE, BOB, APP, WIDE, LOOSE, MIN, HOUR, DAY };
