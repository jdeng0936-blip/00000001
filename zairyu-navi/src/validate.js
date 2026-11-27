// 用户概况的校验。接口和助手共用同一套规则。
const STATUSES = ['none', 'short', 'student', 'work', 'hsp', 'family', 'spouse', 'ssw', 'biz', 'pr'];
const DATE_KEYS = ['entry', 'addr', 'exp', 'arrive', 'work', 'married'];
const BOOL_KEYS = ['ins', 'age', 'lic', 'pr', 'pay'];
// 合规：这些信息平台不收集。请求里出现这些字段名时直接拒绝，而不是悄悄丢弃。
const FORBIDDEN = /my.?number|mynumber|个人编号|個人番号|passport|护照号|bank.?account|银行账号/i;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime());

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function validateProfilePatch(body) {
  const out = {};
  for (const k of Object.keys(body)) {
    if (FORBIDDEN.test(k)) throw new HttpError(422, '平台不收集个人编号、护照号和银行账号');
    const v = body[k];
    if (k === 'status') { if (!STATUSES.includes(v)) throw new HttpError(422, 'status 无效'); out.status = v; }
    else if (DATE_KEYS.includes(k)) { if (v !== '' && !isDate(v)) throw new HttpError(422, k + ' 须为 YYYY-MM-DD'); out[k] = v; }
    else if (BOOL_KEYS.includes(k)) { if (typeof v !== 'boolean') throw new HttpError(422, k + ' 须为 true 或 false'); out[k] = v; }
    else if (k === 'hsp') { if (!['0', '70', '80'].includes(String(v))) throw new HttpError(422, 'hsp 须为 0、70、80'); out.hsp = String(v); }
    else if (k === 'jp') { if (!['', 'low', 'n3', 'n2', 'n1'].includes(v)) throw new HttpError(422, 'jp 须为 low、n3、n2、n1'); out.jp = v; }
    else if (k === 'trips') {
      if (!Array.isArray(v) || !v.every((t) => Array.isArray(t) && t.length === 2 && isDate(t[0]) && isDate(t[1]) && t[0] <= t[1])) throw new HttpError(422, 'trips 须为 [出国日, 回国日] 的列表');
      out.trips = v;
    } else throw new HttpError(422, '未知字段：' + k);
  }
  return out;
}


module.exports = { validateProfilePatch, HttpError, STATUSES };
