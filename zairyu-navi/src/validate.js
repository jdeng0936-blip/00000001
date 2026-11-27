// 校验：用户概况、日期、咨询内容、敏感号码。接口和助手共用同一套规则。
const STATUSES = ['none', 'short', 'student', 'work', 'hsp', 'family', 'spouse', 'ssw', 'biz', 'pr'];
const DATE_KEYS = ['entry', 'addr', 'exp', 'arrive', 'work', 'married'];
const BOOL_KEYS = ['ins', 'age', 'lic', 'pr', 'pay'];
// 合规：这些信息平台不收集。请求里出现这些字段名时直接拒绝，而不是悄悄丢弃。
const FORBIDDEN = /my.?number|mynumber|个人编号|個人番号|passport|护照号|bank.?account|银行账号/i;

// 日期必须是 YYYY-MM-DD，而且是日历上真实存在的一天（2026-02-30、2026-13-01 都不行）。
// 概况和事件共用这一个函数。
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

class HttpError extends Error { constructor(status, message, headers) { super(message); this.status = status; this.headers = headers || null; } }

function validateProfilePatch(body) {
  const out = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(422, '概况须为对象');
  for (const k of Object.keys(body)) {
    if (FORBIDDEN.test(k)) throw new HttpError(422, '平台不收集个人编号、护照号和银行账号');
    const v = body[k];
    if (k === 'status') { if (!STATUSES.includes(v)) throw new HttpError(422, 'status 无效'); out.status = v; }
    else if (DATE_KEYS.includes(k)) { if (v !== '' && !isDate(v)) throw new HttpError(422, k + ' 须为 YYYY-MM-DD，且是真实存在的日期'); out[k] = v; }
    else if (BOOL_KEYS.includes(k)) { if (typeof v !== 'boolean') throw new HttpError(422, k + ' 须为 true 或 false'); out[k] = v; }
    else if (k === 'hsp') { if (!['0', '70', '80'].includes(String(v))) throw new HttpError(422, 'hsp 须为 0、70、80'); out.hsp = String(v); }
    else if (k === 'jp') { if (!['', 'low', 'n3', 'n2', 'n1'].includes(v)) throw new HttpError(422, 'jp 须为 low、n3、n2、n1'); out.jp = v; }
    else if (k === 'trips') {
      if (!Array.isArray(v) || v.length > 500 || !v.every((t) => Array.isArray(t) && t.length === 2 && isDate(t[0]) && isDate(t[1]) && t[0] <= t[1])) throw new HttpError(422, 'trips 须为 [出国日, 回国日] 的列表');
      out.trips = v;
    } else throw new HttpError(422, '未知字段：' + k);
  }
  return out;
}

// ---- 敏感号码过滤 ----
// 一个函数，用在所有会转给第三方（服务商、模型）或落库的自由文本上：
// 咨询摘要、助手对话（含带回来的历史里的每一段文字）、服务商回复、事件备注。README 的“敏感号码过滤”一节逐条写明了拦什么、不拦什么，
// 改这里的规则时要同步改 README 和 test/server-sensitive.test.js。
const SEP = '[ \\t\\-._·・‐-―−ー]'; // 窄的分隔符：空格、点、各种横线
const SEPW = '[ \\t\\r\\n\\-._·・‐-―−ー,/:|~〜、]'; // 宽的分隔符：再加上换行、逗号、顿号、斜线、冒号、竖线、波浪线
const YEAR = /^(?:19|20)\d{2}$/;
const RE = {
  zw: /[­᠎​-‏⁠-⁤﻿]/g, // 零宽字符、软连字符：夹在数字中间看不见，先去掉
  // ---- 先遮掉的写法（明确不是号码的数字）----
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // 本系统的编号（服务商 id 等）
  amount: /(?<![\d,.])\d{1,3}(?:,\d{3})+(?![\d,])/g, // 带千位逗号的金额 1,200,000
  date: /(?<!\d)(?:19|20)\d{2}([-/.])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])(?!\d)/g, // 2026-11-30、2026/11/30、2026.11.30
  date8: /(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/g, // 20261130
  yearMark: /(?<!\d)(?:19|20)\d{2}(?=\s*年)/g, // 2025年、2025年度
  time: /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![\d:])/g, // 10:30
  intlPhone: /\+\d[\d \-().]{5,22}\d/g, // + 开头的国际电话
  jpPhone: /(?<![\d\-])0\d{1,4}[- ]\d{1,4}[- ]\d{3,4}(?!\d)/g, // 090-1234-5678、06-1234-5678（合计10或11位才算）
  // ---- 个人编号 ----
  run: new RegExp('\\d+(?:' + SEPW + '{1,3}\\d+)*', 'g'), // 一串只隔着分隔符的数字组
  my12: /(?<!\d)\d{12}(?!\d)/g,
  // 夹在更长的一串里的 4-4-4：前后不隔着窄分隔符连着数字，也不是 4-4-4-4（卡号）的一部分
  my444: new RegExp('(?<!\\d)(?<!\\d' + SEP + ')(?<!\\d{4}' + SEPW + '{1,3})\\d{4}' + SEPW + '{1,3}\\d{4}' + SEPW + '{1,3}\\d{4}(?!' + SEP + '?\\d)(?!' + SEPW + '{1,3}\\d{4}(?!\\d))', 'g'),
  myKey: /个人编号|个人番号|個人番号|個人編號|マイナンバー|my\s*number/gi,
  // ---- 护照号 ----
  // 1个字母+8位数字，或2个字母+7位数字，前后不连着别的字母数字（在留卡号是 2字母+8数字+2字母，不会命中）
  passport: /(?<![A-Za-z0-9])(?:[A-Za-z]\d{8}|[A-Za-z]{2}\d{7})(?![A-Za-z0-9])/,
  // “护照”“passport”后面不远处，字母和数字之间隔了一个空格的写法：passport E 12345678
  passportNear: /(?:passport|护照|護照|パスポート|旅券)[^\n]{0,8}?(?<![A-Za-z0-9])[A-Za-z]{1,2} \d{7,8}(?!\d)/i,
  passportKey: /护照号码?|护照编号|護照號碼?|旅券番号|パスポート番号|passport\s*(?:no\.?|number|num\.?|#)/gi,
  // ---- 银行卡、信用卡、账号 ----
  card: /(?<!\d)\d{16,19}(?!\d)/,
  card4: new RegExp('(?<!\\d)\\d{4}(?:' + SEPW + '{1,3}\\d{4}){3}(?!\\d)', 'g'),
  bankKey: /银行卡号?|信用卡号?|储蓄卡号?|借记卡号?|(?<!在留)卡号|账号|帐号|賬號|账户|帳戶|口座番号|口座|カード番号|bank\s*account(?:\s*(?:no\.?|number|num\.?|#))?|account\s*(?:no\.?|number|num\.?|#)|iban/gi,
  iban: /iban[^A-Za-z0-9\n]{0,8}[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]){10,30}(?![A-Za-z0-9])/i, // IBAN GB29NWBK60161331926819
  jpBank: /(?:支店|店番)[^\n]{0,12}?(?:普通|当座|貯蓄|储蓄)[^\d\n]{0,6}\d{7}(?!\d)/, // 支店 123 普通 7654321
  seq: new RegExp('^\\d(?:' + SEP + '?\\d)*'),
  seqW: new RegExp('^\\d(?:' + SEPW + '{0,3}\\d)*'),
  money: /^\s*(?:日元|日圆|円|元|万|萬|千|块|人民币|yen|jpy|rmb|cny)/i,
  dateLike: /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/
};
const SENSITIVE_LABEL = { mynumber: '个人编号（My Number）', passport: '护照号', bank: '银行账号或卡号' };

// 关键词后面（隔着最多 gap 个非数字字符）紧跟的那串数字。返回 { digits, raw, rest }，没有则 null。
// wide：数字之间允许宽的分隔符（顿号、逗号、斜线、换行等）。
function numberAfter(s, from, gap, noLetters, wide) {
  let i = from, n = 0;
  while (i < s.length && n <= gap && !/\d/.test(s[i])) { if (noLetters && /[A-Za-z]/.test(s[i])) return null; i++; n++; }
  if (i >= s.length || n > gap) return null;
  const m = (wide ? RE.seqW : RE.seq).exec(s.slice(i));
  return { raw: m[0], digits: m[0].replace(/\D/g, ''), rest: s.slice(i + m[0].length) };
}

// 把明确不是号码的数字遮掉（换成一个既不是数字也不是分隔符的字符），剩下的再按形状判断。
function maskBenign(s) {
  const X = '¤', digitsOf = (x) => x.replace(/\D/g, '').length;
  return s.replace(RE.uuid, X).replace(RE.intlPhone, (x) => (digitsOf(x) >= 8 && digitsOf(x) <= 15 ? X : x))
    .replace(RE.amount, X).replace(RE.date, X).replace(RE.date8, X).replace(RE.yearMark, X).replace(RE.time, X)
    .replace(RE.jpPhone, (x) => (digitsOf(x) === 10 || digitsOf(x) === 11 ? X : x));
}

// 分组后的数字是不是“几个年份”或“年月日时分”：2023 2024 2025、2026 1127 1530
function yearsOrTimestamp(groups) {
  if (groups.length >= 2 && groups.every((g) => YEAR.test(g))) return true;
  const d = groups.join('');
  if (d.length !== 12 || !YEAR.test(d.slice(0, 4))) return false;
  const mo = +d.slice(4, 6), day = +d.slice(6, 8), h = +d.slice(8, 10), mi = +d.slice(10, 12);
  return mo >= 1 && mo <= 12 && day >= 1 && day <= 31 && h <= 23 && mi <= 59;
}

// 返回 'mynumber' | 'passport' | 'bank' | null
function findSensitive(text) {
  if (typeof text !== 'string' || !text) return null;
  // 全角数字、全角字母、全角空格和符号先转成半角；零宽字符去掉
  const s = text.normalize('NFKC').replace(RE.zw, '');
  const t = maskBenign(s);
  let m;
  // 个人编号 1：连续12位
  for (const x of t.matchAll(RE.my12)) if (!yearsOrTimestamp([x[0]])) return 'mynumber';
  // 个人编号 2：一串只隔着分隔符的数字组，不论怎么分组，合计正好12位；后面紧跟金额单位的不算
  const my = (re) => {
    for (const x of t.matchAll(re)) {
      const groups = x[0].match(/\d+/g);
      if (groups.join('').length === 12 && !yearsOrTimestamp(groups) && !(groups.length > 1 && RE.money.test(t.slice(x.index + x[0].length)))) return true;
    }
    return false;
  };
  if (my(RE.run)) return 'mynumber';
  // 卡号：连续16至19位，或 4-4-4-4 分组（先于下面的 4-4-4 判断，免得卡号的前三组被当成个人编号）；几个年份、后面紧跟金额单位的不算
  if (RE.card.test(t)) return 'bank';
  for (const x of t.matchAll(RE.card4)) if (!yearsOrTimestamp(x[0].match(/\d+/g)) && !RE.money.test(t.slice(x.index + x[0].length))) return 'bank';
  // 个人编号 3：夹在更长的一串里的 4-4-4 分组
  if (my(RE.my444)) return 'mynumber';
  // 个人编号 4：关键词后面的一串数字，合计正好12位（不做上面那些排除）
  RE.myKey.lastIndex = 0;
  while ((m = RE.myKey.exec(s))) { const n = numberAfter(s, m.index + m[0].length, 12, false, true); if (n && n.digits.length === 12) return 'mynumber'; }
  if (RE.passport.test(s) || RE.passportNear.test(s)) return 'passport';
  RE.passportKey.lastIndex = 0;
  while ((m = RE.passportKey.exec(s))) { const n = numberAfter(s, m.index + m[0].length, 8); if (n && n.digits.length >= 6 && n.digits.length <= 9 && !RE.dateLike.test(n.raw)) return 'passport'; }
  if (RE.iban.test(s) || RE.jpBank.test(s)) return 'bank';
  RE.bankKey.lastIndex = 0;
  while ((m = RE.bankKey.exec(s))) {
    const n = numberAfter(s, m.index + m[0].length, 8, true);
    // 关键词后面（中间不夹英文字母）跟着7位以上的数字才算；日期和带单位的金额不算
    if (n && n.digits.length >= 7 && !RE.dateLike.test(n.raw) && !RE.money.test(n.rest)) return 'bank';
  }
  return null;
}

// what：出错时告诉用户是哪段文字，例如“摘要”“消息”“回复”。
// 命中时返回给用户看的类别名（例如“护照号”），没有命中返回 null。
function sensitiveLabel(text) { const kind = findSensitive(text); return kind ? SENSITIVE_LABEL[kind] : null; }

function assertNoSensitive(text, what) {
  const kind = findSensitive(text);
  if (kind) throw new HttpError(422, (what || '内容') + '里疑似含有' + SENSITIVE_LABEL[kind] + '。平台不收集个人编号、护照号、银行账号和卡号，请删掉后再发');
}

// ---- 咨询 ----
// POST /inquiries 和助手的 create_inquiry（只准备草稿）共用。不检查 consent：同意只能由用户在接口上给出。
// deps: { hasCategory(key), hasNode(id), getProvider(id) }
// 返回整理好的 { category, nodeId, summary, providerIds }
function validateInquiry(b, deps) {
  b = b || {};
  if (typeof b.category !== 'string' || !deps.hasCategory(b.category)) throw new HttpError(422, '服务类别无效');
  if (b.nodeId != null && b.nodeId !== '' && (typeof b.nodeId !== 'string' || !deps.hasNode(b.nodeId))) throw new HttpError(422, '节点无效');
  if (typeof b.summary !== 'string') throw new HttpError(422, '摘要须为5至2000字');
  const summary = b.summary.trim();
  if (summary.length < 5 || summary.length > 2000) throw new HttpError(422, '摘要须为5至2000字');
  assertNoSensitive(summary, '摘要');
  const ids = Array.isArray(b.providerIds) ? b.providerIds : (b.providerId ? [b.providerId] : []);
  if (!ids.length) throw new HttpError(422, '要先选服务商');
  if (ids.length > 3 || new Set(ids).size !== ids.length) throw new HttpError(422, '一次最多发给三家，且不能重复');
  const providers = [];
  for (const pid of ids) {
    const p = typeof pid === 'string' ? deps.getProvider(pid) : null;
    if (!p || !p.active || p.category !== b.category) throw new HttpError(422, '服务商无效或类别不符');
    providers.push({ id: p.id, name: p.name });
  }
  return { category: b.category, nodeId: b.nodeId || null, summary, providerIds: ids.slice(), providers };
}

// 邮箱：去掉首尾空白、转小写后保存和比较。最长 254 个字符。
// @ 前面：英文字母、数字，和 . _ + - ' ! # $ & * / = ? ^ ` { | } ~ 这些符号，最长 64 个字符；不能以点或横线开头。
//   点可以连着写、可以放在 @ 前（日本的手机运营商发过 a..b@、abc.@ 这样的地址，现在还有人在用）。
//   不接受 %（旧式的转发写法 user%别的域名@中转站）、引号、空格、尖括号、换行。
// @ 后面：至少两段，每段是字母、数字和中间的横线，最后一段是两个以上的字母（a@1.2、a@b.c 这种不存在的不收）。
// 中文域名之类的地址现在不支持。不合格时返回 422。
function normalizeEmail(s) {
  const e = typeof s === 'string' ? s.trim().toLowerCase() : '';
  if (!e || e.length > 254 || !/^[a-z0-9_+'!#$&*\/=?^`{|}~][a-z0-9._+'!#$&*\/=?^`{|}~-]{0,63}@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(e)) throw new HttpError(422, '邮箱地址的写法不对（只支持英文字母、数字和常见符号的地址，@ 后面要是完整的域名）');
  return e;
}
// 给用户看的邮箱只露第一个字符和域名：a***@example.com
function maskEmail(e) { const i = e.indexOf('@'); return e.slice(0, 1) + '***' + e.slice(i); }

// ---- 服务商入驻申请 ----
// 保证类用语：入驻申请（名称、地址、收费说明、区域、语言）、管理员直接入驻、老服务商迁移和服务商的回复共用这一个函数。
// 先做 NFKC（全角的“１００％”“Ｎｏ．１”也算），再去掉零宽字符和所有空白（“包 过”“包​过”也算），简体、繁体、日文写法都拦。
// “不保证”“无法保证”“不能确保”“不一定能”这种否定的说法是正当的提醒（回复里常用），先去掉再判断。
const CLAIMS = /合格保[证証證]|包[过過]|必[过過]|保[证証證]|[确確]保|一定能|[绝絶絕][对対對]|最安|日本一|no\.?1(?!\d)|100%/i;
const CLAIM_NEG = /(?:不|无法|無法|不能|没法|沒法|不可能)(?:保[证証證]|[确確]保|一定能|包[过過]|必[过過])/g;
const claimText = (text) => text.normalize('NFKC').replace(RE.zw, '').replace(/\s+/g, '').replace(CLAIM_NEG, '');
function hasClaims(text) { return typeof text === 'string' && CLAIMS.test(claimText(text)); }
function assertNoClaims(text, what) {
  if (hasClaims(text)) throw new HttpError(422, (what || '内容') + '里不能有保证类或夸大的用语（例如合格保证、包过、必过、绝对、100%、No.1、日本一、最安）');
}
// 登录番号：NFKC（全角转半角）后去掉空白和「第」「号」。只用来防打错，不算核实；核实由管理员对照各连合会的检索做。
function normalizeLicense(s) { return typeof s === 'string' ? s.normalize('NFKC').replace(/[\s第号號]/g, '') : ''; }
// 各类别登录番号的格式（normalizeLicense 之后）和要一起填的所属会。where：管理员去哪里核对。
// 格式由人对照各连合会再核一次（docs/TODO.md 第 7 条）。
const LICENSE_RULES = {
  gyosei: { re: /^\d{8}$/, body: /^.{2,4}行政書士会$/, label: '行政書士の登録番号（8 位数字）', bodyLabel: '所属行政書士会（例：大阪府行政書士会）', where: '日本行政書士会連合会的会员检索' },
  zeirishi: { re: /^\d{1,6}$/, body: /^.{2,5}税理士会$/, label: '税理士登録番号（1 至 6 位数字）', bodyLabel: '所属税理士会（例：近畿税理士会）', where: '日本税理士会連合会的税理士情報検索サイト' },
  sharoshi: { re: /^\d{8}$/, body: /^.{2,4}社会保険労務士会$/, label: '社会保険労務士の登録番号（8 位数字）', bodyLabel: '所属社会保険労務士会（例：大阪府社会保険労務士会）', where: '全国社会保険労務士会連合会的社労士检索' },
  shiho: { re: /^\d{1,5}$/, body: /^.{2,4}司法書士会$/, label: '司法書士の登録番号（1 至 5 位数字）', bodyLabel: '所属司法書士会（例：大阪司法書士会）', where: '各司法書士会或日本司法書士会連合会的检索' },
  estate: { re: /^(?:国土交通大臣|.{2,3}知事)\(\d{1,2}\)\d{1,6}$/, body: null, label: '宅地建物取引業の免許番号（例：大阪府知事（3）第12345号）', where: '国土交通省的宅地建物取引業者检索' }
};
// 法人番号：13 位，第一位是校验位（国税厅公布的算法）
function corpNumberOk(s) {
  if (!/^\d{13}$/.test(s)) return false;
  const base = s.slice(1);
  let sum = 0;
  for (let n = 1; n <= 12; n++) sum += +base[12 - n] * (n % 2 ? 1 : 2);
  return +s[0] === 9 - (sum % 9);
}
// 登录番号和所属会的检查（入驻申请、管理员直接入驻、老服务商迁移共用）。士业和不动产按 LICENSE_RULES 的格式，所属会必填（不动产没有）；
// 其他非士业的法人番号选填（13 位，带校验位）。不合格时抛 422，合格时返回 { licenseNo, licenseBody }（整理过的）。
function checkLicense(category, licenseNo, licenseBody) {
  if (licenseNo != null && typeof licenseNo !== 'string') throw new HttpError(422, '登录番号须为文字');
  const rule = LICENSE_RULES[category], lic = normalizeLicense(licenseNo);
  if (rule) {
    if (!rule.re.test(lic)) throw new HttpError(422, '登录番号的格式不对：' + rule.label);
    if (!rule.body) return { licenseNo: lic, licenseBody: '' };
    const body = typeof licenseBody === 'string' ? licenseBody.normalize('NFKC').replace(/\s/g, '') : '';
    if (!rule.body.test(body)) throw new HttpError(422, '要填写' + rule.bodyLabel);
    return { licenseNo: lic, licenseBody: body };
  }
  if (lic && !corpNumberOk(lic)) throw new HttpError(422, '法人番号须为 13 位数字（校验位要对得上），不是法人可以不填');
  return { licenseNo: lic, licenseBody: '' };
}
// 名单上公开的文字（名称、地址、收费说明、区域、语言）都不能有保证类用语。f：{ name, address, feeNote, area, langs }
function assertListingText(f) {
  for (const [k, label] of [['name', '名称'], ['address', '事务所地址'], ['feeNote', '收费说明'], ['area', '服务区域'], ['langs', '语言']]) assertNoClaims(f[k], label);
}
// 收费方式只按类别定：士业是 fixed_listing，其余是 affiliate_disclosed。两种都只付固定的展示费，
// affiliate_disclosed 只表示“名单上标明含推广”（名字是早先定的，为了兼容旧数据没有改），不表示按咨询或成交给佣金。
const feeModelOf = (regulated) => (regulated ? 'fixed_listing' : 'affiliate_disclosed');
const APP_FIELDS = new Set(['challengeId', 'code', 'proof', 'category', 'name', 'address', 'licenseNo', 'licenseBody', 'feeNote', 'area', 'langs', 'agree', 'feeModel']);
// 入驻申请的校验（新申请和“要求修改”后的重新提交共用）。deps：{ hasCategory(key), regulated(key), termsVersion }。
// 收费方式不看请求：士业固定为 fixed_listing，其余为 affiliate_disclosed（请求里带 feeModel 一律忽略）。
function validateApplication(b, deps) {
  b = b || {};
  for (const k of Object.keys(b)) {
    if (FORBIDDEN.test(k)) throw new HttpError(422, '平台不收集个人编号、护照号和银行账号');
    if (!APP_FIELDS.has(k)) throw new HttpError(422, '未知字段：' + k);
  }
  if (typeof b.category !== 'string' || !deps.hasCategory(b.category)) throw new HttpError(422, '服务类别无效');
  if (b.agree !== deps.termsVersion) throw new HttpError(422, '要先阅读并同意服务商条款（版本 ' + deps.termsVersion + '）');
  const text = (k, label, min, max) => {
    const v = b[k] == null ? '' : b[k];
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new HttpError(422, label + (min ? '须为' + min + '至' + max + '字' : '须为' + max + '字以内'));
    assertNoSensitive(v, label);
    return v.trim();
  };
  const out = { category: b.category, name: text('name', '名称', 2, 80), address: text('address', '事务所地址', 5, 200), feeNote: text('feeNote', '收费说明', 2, 200), area: text('area', '服务区域', 0, 100), langs: text('langs', '语言', 0, 100) };
  assertListingText(out);
  Object.assign(out, checkLicense(b.category, b.licenseNo, b.licenseBody));
  out.feeModel = feeModelOf(!!deps.regulated(b.category));
  return out;
}

module.exports = { validateApplication, checkLicense, assertListingText, feeModelOf, normalizeLicense, LICENSE_RULES, assertNoClaims, hasClaims, corpNumberOk, validateProfilePatch, validateInquiry, isDate, findSensitive, sensitiveLabel, assertNoSensitive, normalizeEmail, maskEmail, HttpError, STATUSES };
