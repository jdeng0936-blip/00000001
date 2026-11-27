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

module.exports = { validateProfilePatch, validateInquiry, isDate, findSensitive, sensitiveLabel, assertNoSensitive, HttpError, STATUSES };
