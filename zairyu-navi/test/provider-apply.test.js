// 服务商入驻申请：验证码、限流、登录番号的格式、收费方式、保证类用语、敏感号码、条款、重复申请、要求修改后重新提交、撤回。
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, gyosei, PV, WIDE, MIN } = require('./provider-helpers');
const { normalizeLicense, validateApplication, corpNumberOk } = require('../src/validate');

test('申请：验证码发到发件箱；验证码不对、过期都不行；对了建一份 pending 的申请并发“已收到”', async () => {
  const s = await start();
  try {
    const E = 'office@example.jp';
    const r = await s.call('POST', '/api/provider-apply/code', { email: E });
    assert.equal(r.status, 202); assert.equal(r.body.expiresInSec, 600);
    const m = s.lastMail(E);
    assert.equal(m.kind, 'code'); assert.match(m.body, /验证码：\d{6}/); assert.doesNotMatch(m.subject, /\d{6}/, '验证码不放在标题里');
    const code = s.codeIn(m), wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await s.call('POST', '/api/provider-apply', Object.assign({ challengeId: r.body.challengeId, code: wrong }, gyosei()))).status, 422, '验证码不对');
    s.advance(11 * MIN);
    assert.equal((await s.call('POST', '/api/provider-apply', Object.assign({ challengeId: r.body.challengeId, code }, gyosei()))).status, 422, '过期');
    const ok = await s.apply(E);
    assert.equal(ok.status, 201); assert.match(ok.body.ref, /^A[2-9A-HJ-KM-NP-Z]{7}$/);
    const a = s.appByRef(ok.body.ref);
    assert.equal(a.status, 'pending'); assert.equal(a.licenseNo, '12345678', '全角数字和「第」「号」都整理掉'); assert.equal(a.email, E);
    assert.match(s.lastMail(E).subject, /已收到/);
    assert.ok(!s.lastMail(E).body.includes(a.id), '邮件里只有申请编号');
    // 用过的验证码不能再用
    assert.equal((await s.call('POST', '/api/provider-apply', Object.assign({ challengeId: r.body.challengeId, code }, gyosei()))).status, 422);
  } finally { await s.stop(); }
});

test('申请的验证码：限流按“来源地址 + 邮箱”和“每个邮箱合计”分别计；返回的内容不看邮箱的情况', async () => {
  const s = await start({ emailLimits: { reqEmail: [{ max: 2, windowMs: 3600000 }], reqEmailAll: [{ max: 3, windowMs: 3600000 }], reqIp: [WIDE], verIp: [WIDE] } });
  try {
    const A = 'a@example.jp', B = 'b@example.jp';
    assert.equal((await s.call('POST', '/api/provider-apply/code', { email: A })).status, 202);
    assert.equal((await s.call('POST', '/api/provider-apply/code', { email: A })).status, 202);
    const r = await s.call('POST', '/api/provider-apply/code', { email: A });
    assert.equal(r.status, 429, '同一来源对同一邮箱 1 小时 2 次'); assert.ok(r.headers.get('retry-after'));
    assert.equal((await s.call('POST', '/api/provider-apply/code', { email: B })).status, 202, '别的邮箱不受影响');
    // 换一个来源地址（TRUST_PROXY 下的 X-Forwarded-For），按邮箱合计的上限仍然管着
    const s2 = await start({ trustProxy: true, emailLimits: { reqEmail: [{ max: 2, windowMs: 3600000 }], reqEmailAll: [{ max: 3, windowMs: 3600000 }], reqIp: [WIDE], verIp: [WIDE] } });
    try {
      const from = (ip) => ({ 'x-forwarded-for': ip });
      for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) assert.equal((await s2.call('POST', '/api/provider-apply/code', { email: A }, null, from(ip))).status, 202, ip);
      assert.equal((await s2.call('POST', '/api/provider-apply/code', { email: A }, null, from('10.0.0.4'))).status, 429, '每个邮箱合计 3 次');
      // 邮箱有没有申请过、是不是服务商，返回的形状一样
      const shape = (b) => Object.keys(b).sort().join(',') + ':' + b.challengeId.length + ':' + b.expiresInSec;
      const x = await s2.call('POST', '/api/provider-apply/code', { email: 'new@example.jp' }, null, from('10.0.0.5'));
      await s2.apply('old@example.jp');
      const y = await s2.call('POST', '/api/provider-apply/code', { email: 'old@example.jp' }, null, from('10.0.0.6'));
      assert.equal(x.status, y.status); assert.equal(shape(x.body), shape(y.body));
    } finally { await s2.stop(); }
  } finally { await s.stop(); }
});

test('登录番号：四种士业和不动产各有格式对和不对的例子；全角能识别；士业缺所属会 422', async () => {
  const deps = { hasCategory: () => true, regulated: (k) => ['gyosei', 'zeirishi', 'sharoshi', 'shiho'].includes(k), termsVersion: PV };
  const ok = (over) => validateApplication(gyosei(over), deps);
  const bad = (over, re) => assert.throws(() => ok(over), (e) => e.status === 422 && (!re || re.test(e.message)), JSON.stringify(over));
  assert.equal(ok({ licenseNo: '12345678' }).licenseNo, '12345678');
  assert.equal(ok({ licenseNo: '第 1234 5678 号' }).licenseNo, '12345678');
  bad({ licenseNo: '1234567' }, /登录番号/); bad({ licenseNo: '12345678a' }); bad({ licenseNo: '' });
  bad({ licenseBody: '' }, /所属行政書士会/); bad({ licenseBody: '大阪府税理士会' });
  assert.equal(ok({ category: 'zeirishi', licenseNo: '第１２３４５６号', licenseBody: '近畿税理士会' }).licenseNo, '123456');
  bad({ category: 'zeirishi', licenseNo: '1234567', licenseBody: '近畿税理士会' }); bad({ category: 'zeirishi', licenseNo: '123', licenseBody: '' });
  assert.equal(ok({ category: 'sharoshi', licenseNo: '27123456', licenseBody: '大阪府社会保険労務士会' }).licenseNo, '27123456');
  bad({ category: 'sharoshi', licenseNo: '2712345', licenseBody: '大阪府社会保険労務士会' }); bad({ category: 'sharoshi', licenseNo: '27123456', licenseBody: '大阪府行政書士会' });
  assert.equal(ok({ category: 'shiho', licenseNo: '1234', licenseBody: '大阪司法書士会' }).licenseNo, '1234');
  bad({ category: 'shiho', licenseNo: '123456', licenseBody: '大阪司法書士会' }); bad({ category: 'shiho', licenseNo: '1234', licenseBody: '' });
  assert.equal(ok({ category: 'estate', licenseNo: '大阪府知事（３）第１２３４５号', licenseBody: '' }).licenseNo, '大阪府知事(3)12345');
  assert.equal(ok({ category: 'estate', licenseNo: '国土交通大臣(1)第9876号' }).licenseNo, '国土交通大臣(1)9876');
  bad({ category: 'estate', licenseNo: '' }, /免许番号|免許番号/); bad({ category: 'estate', licenseNo: '12345' });
  // 其他非士业：法人番号选填，填了要校验位对
  assert.equal(ok({ category: 'mobile', licenseNo: '', licenseBody: '' }).licenseNo, '');
  assert.equal(ok({ category: 'mobile', licenseNo: '7000012050002' }).licenseNo, '7000012050002');
  bad({ category: 'mobile', licenseNo: '1000012050002' }, /法人番号/);
  assert.ok(corpNumberOk('7000012050002')); assert.equal(normalizeLicense('第１２号'), '12');
  // 接口上也是 422
  const s = await start();
  try {
    assert.equal((await s.apply('x@example.jp', { licenseBody: '' })).status, 422);
    assert.equal((await s.apply('x@example.jp', { licenseNo: '１２３４' })).status, 422);
  } finally { await s.stop(); }
});

test('收费方式由类别决定：士业带 feeModel:success 也存成 fixed_listing，非士业是 affiliate_disclosed', async () => {
  const s = await start();
  try {
    const a = await s.apply('a@example.jp', { feeModel: 'success' });
    assert.equal(a.status, 201); assert.equal(s.appByRef(a.body.ref).feeModel, 'fixed_listing');
    const b = await s.apply('b@example.jp', { category: 'mobile', licenseNo: '', licenseBody: '', feeModel: 'fixed_listing' });
    assert.equal(b.status, 201); assert.equal(s.appByRef(b.body.ref).feeModel, 'affiliate_disclosed');
  } finally { await s.stop(); }
});

test('保证类用语、敏感号码、条款：收费说明里有保证类用语 422；名称、地址里有敏感号码 422；不同意或版本不对 422', async () => {
  const s = await start();
  try {
    for (const w of ['合格保证', '永驻包过', '保证获批', '必过', '100%成功', '１００％', 'No.1事务所', '日本一', '确保通过', '最安']) {
      const r = await s.apply('c@example.jp', { feeNote: '咨询免费，' + w });
      assert.equal(r.status, 422, w); assert.match(r.body.error, /保证类/);
    }
    assert.equal((await s.apply('c@example.jp', { name: '日本一行政书士事务所' })).status, 422, '名称里也不行');
    assert.equal((await s.apply('c@example.jp', { name: '事务所 123456789012' })).status, 422, '名称里像个人编号');
    const r = await s.apply('c@example.jp', { address: '大阪市北区 口座 1234567' });
    assert.equal(r.status, 422); assert.match(r.body.error, /事务所地址里疑似含有银行账号/);
    assert.equal((await s.apply('c@example.jp', { agree: undefined })).status, 422);
    assert.equal((await s.apply('c@example.jp', { agree: '2020-01-01' })).status, 422);
    assert.equal((await s.apply('c@example.jp', { passportNo: 'x' })).status, 422, '平台不收集的字段');
    assert.equal((await s.call('GET', '/api/provider-terms')).body.version, PV);
    // 内容不对时验证码不会白白用掉
    const c = await s.applyCode('d@example.jp');
    assert.equal((await s.call('POST', '/api/provider-apply', Object.assign({}, c, gyosei({ feeNote: '包过' })))).status, 422);
    assert.equal((await s.call('POST', '/api/provider-apply', Object.assign({}, c, gyosei()))).status, 201);
  } finally { await s.stop(); }
});

test('重复申请：同一邮箱已有审核中的申请 409；每个来源地址每天最多提交 5 次', async () => {
  const s = await start({ applyLimit: [{ max: 5, windowMs: 24 * 3600000 }] });
  try {
    assert.equal((await s.apply('dup@example.jp')).status, 201);
    const r = await s.apply('dup@example.jp');
    assert.equal(r.status, 409); assert.match(r.body.error, /已经有一份/);
    for (let i = 0; i < 3; i++) assert.equal((await s.apply('n' + i + '@example.jp')).status, 201);
    assert.equal((await s.apply('n9@example.jp')).status, 429, '第 6 次');
  } finally { await s.stop(); }
});

test('查看或修改申请：凭验证码拿到申请和确认；只有要求修改时能重新提交；可以撤回；确认不对 403', async () => {
  const s = await start();
  try {
    const E = 'edit@example.jp';
    const a = await s.apply(E);
    const open = async () => { const c = await s.applyCode(E); const r = await s.call('POST', '/api/provider-apply/open', c); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    let o = await open();
    assert.equal(o.application.ref, a.body.ref); assert.equal(o.application.status, 'pending'); assert.equal(o.application.email, 'e***@example.jp', '邮箱打码');
    assert.ok(!('id' in o.application));
    assert.equal((await s.call('PUT', '/api/provider-apply/' + a.body.ref, Object.assign({ proof: o.proof }, gyosei({ feeNote: '首次咨询免费' })))).status, 409, '审核中不能改');
    // 管理员要求修改
    const id = s.appByRef(a.body.ref).id;
    assert.equal((await s.adm('POST', '/api/admin/applications/' + id + '/request-changes', { reviewKey: s.rk(id), message: '请补充事务所的楼层和房间号。' })).status, 200);
    o = await open();
    assert.equal(o.application.status, 'changes_requested'); assert.match(o.application.reviewMsg, /楼层/);
    assert.equal((await s.call('PUT', '/api/provider-apply/' + a.body.ref, Object.assign({ proof: 'wrong' }, gyosei()))).status, 403);
    assert.equal((await s.call('PUT', '/api/provider-apply/' + a.body.ref, Object.assign({ proof: o.proof }, gyosei({ feeNote: '包过' })))).status, 422, '重新提交也要校验');
    const re = await s.call('PUT', '/api/provider-apply/' + a.body.ref, Object.assign({ proof: o.proof }, gyosei({ address: '大阪府大阪市北区梅田1-2-3 5楼501' })));
    assert.equal(re.status, 200); assert.equal(re.body.application.status, 'pending'); assert.match(re.body.application.address, /501/);
    // 撤回
    assert.equal((await s.call('DELETE', '/api/provider-apply/' + a.body.ref, { proof: 'nope' })).status, 403);
    assert.equal((await s.call('DELETE', '/api/provider-apply/' + a.body.ref, { proof: o.proof })).status, 204);
    assert.equal(s.appByRef(a.body.ref).status, 'withdrawn');
    assert.equal((await s.call('DELETE', '/api/provider-apply/' + a.body.ref, { proof: o.proof })).status, 409);
    // 撤回后同一邮箱可以重新申请；没有申请的邮箱查看是 404
    assert.equal((await s.apply(E)).status, 201);
    const c = await s.applyCode('none@example.jp');
    assert.equal((await s.call('POST', '/api/provider-apply/open', c)).status, 404);
    // 确认 30 分钟后失效
    s.advance(31 * MIN);
    assert.equal((await s.call('DELETE', '/api/provider-apply/' + a.body.ref, { proof: o.proof })).status, 403);
    // 被拒绝、撤回的申请 90 天后整行删掉
    s.advance(91 * 24 * 60 * MIN); s.app.purge();
    assert.equal(s.appByRef(a.body.ref), null);
  } finally { await s.stop(); }
});
