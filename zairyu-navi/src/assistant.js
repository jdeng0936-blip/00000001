// 助手：系统提示词 + 工具 + 调用 Claude 的循环。
// 助手的所有方案、期限、价格都来自规则引擎的工具结果，不由模型自己编。
const createEngine = require('./engine');
const { validateProfilePatch } = require('./validate');

const TOOL_DEFS = [
  { name: 'update_profile', description: '记录或修改用户概况。只传用户明确说过的字段。日期用 YYYY-MM-DD。',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['none', 'short', 'student', 'work', 'hsp', 'family', 'spouse', 'ssw', 'biz', 'pr'] }, married: { type: 'string' }, entry: { type: 'string' }, addr: { type: 'string' }, exp: { type: 'string' }, ins: { type: 'boolean' }, age: { type: 'boolean' }, lic: { type: 'boolean' }, pr: { type: 'boolean' } } } },
  { name: 'get_plan', description: '按固定规则生成用户当前的路线：每个任务的状态、期限和费用，以及下一步任务。', input_schema: { type: 'object', properties: {} } },
  { name: 'mark_done', description: '把某个任务标记为已完成。id 是任务编号，例如 1-1。', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'add_trip', description: '记录一次出国和回国日期，用于永驻的出国天数计算。', input_schema: { type: 'object', properties: { out: { type: 'string' }, back: { type: 'string' } }, required: ['out', 'back'] } },
  { name: 'add_event', description: '记录一件会产生期限的事。type：job_change 换工作或离职、move 搬家、divorce 离婚或配偶去世、birth 孩子出生。date 用 YYYY-MM-DD，必须是用户明确说过的日期。', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['job_change', 'move', 'divorce', 'birth'] }, date: { type: 'string' } }, required: ['type', 'date'] } },
  { name: 'get_options', description: '按规则引擎取出某个选择题的几套方案和费用，已按用户情况排序。topic：route 来日本走哪条路、degree 怎么取得学历、points 高度人才积分规划、phone 电话卡套餐、drive 驾照怎么拿、company 开公司费用、budget 第一年要准备多少钱。params 是可选的条件。',
    input_schema: { type: 'object', properties: { topic: { type: 'string', enum: ['route', 'degree', 'points', 'phone', 'drive', 'company', 'budget'] }, params: { type: 'object' } }, required: ['topic'] } },
  { name: 'suggest_providers', description: '列出某一类专业服务的说明。category：gyosei 行政书士、zeirishi 税理士、sharoshi 社会保险劳务士、shiho 司法书士、edu 学校和升学服务。', input_schema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] } },
  { name: 'create_inquiry', description: '把咨询摘要发给用户选定的服务商。只有在用户已经看过摘要、选了服务商并明确同意之后才能调用，confirmed 必须为 true。providerId 来自 suggest_providers 的结果。', input_schema: { type: 'object', properties: { category: { type: 'string' }, providerId: { type: 'string' }, nodeId: { type: 'string' }, summary: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['category', 'providerId', 'summary', 'confirmed'] } }
];

function systemPrompt(eng, now) { return eng.SYS + eng.kb() + '\n\n【用户概况】' + eng.profileText() + '\n今天是' + eng.fmt(now ? new Date(now) : new Date()) + '。'; }

// ctx: { user, store, now }
function execTool(name, input, ctx) {
  input = input || {};
  const u = ctx.user;
  const eng = () => createEngine({ profile: u.profile, done: u.done, plan: u.plan, auth: u.auth, events: ctx.store ? ctx.store.listEvents(u.id) : [], now: ctx.now });
  const persist = (action, detail) => { if (ctx.store) ctx.store.saveUser(u, action, detail); };
  if (name === 'update_profile') { Object.assign(u.profile, validateProfilePatch(input)); persist('profile.update', { via: 'assistant', keys: Object.keys(input) }); return { profile: eng().profileText() }; }
  if (name === 'get_plan') return eng().plan();
  if (name === 'mark_done') {
    const st = eng().compute()[input.id];
    if (!st) throw new Error('没有这个任务');
    if (st.state === 'locked') throw new Error('这个任务还没解锁：' + (st.note || ''));
    u.done[input.id] = true; persist('task.done', { via: 'assistant', id: input.id });
    const p = eng().plan(); return { done: input.id, next: p.next };
  }
  if (name === 'add_trip') { const trips = (u.profile.trips || []).concat([[input.out, input.back]]); Object.assign(u.profile, validateProfilePatch({ trips })); persist('profile.update', { via: 'assistant', keys: ['trips'] }); return { trips: u.profile.trips.length }; }
  if (name === 'add_event') {
    const e = eng();
    if (!e.EVRULES[input.type]) throw new Error('事件类型无效');
    if (!e.isDate(input.date)) throw new Error('日期须为 YYYY-MM-DD；用户没说具体日期时先问清楚');
    if (!ctx.store) throw new Error('当前环境不能记录事件');
    ctx.store.addEvent(u.id, { type: input.type, date: input.date });
    return { recorded: e.EVRULES[input.type][0], deadlines: eng().reminders().filter((r) => r.tag === '事件').map((r) => ({ date: e.fmt(r.d), text: r.txt })) };
  }
  if (name === 'get_options') return eng().options(input.topic, input.params);
  if (name === 'suggest_providers') {
    const e = eng(); const c = e.CATS.find((x) => x[0] === input.category);
    if (!c) throw new Error('服务类别无效');
    const list = ctx.store ? ctx.store.listProviders(c[0]).map((p) => ({ providerId: p.id, name: p.name, area: p.area, langs: p.langs, feeNote: p.feeNote, promoted: p.feeModel === 'affiliate_disclosed' })) : [];
    return { category: c[1], what: c[2], regulated: !!e.REGULATED[c[0]], providers: list, note: '按入驻顺序列出，由用户自己选择，助手不推荐某一家。' + (list.length ? '' : '这一类还没有入驻的服务商。') };
  }
  if (name === 'create_inquiry') {
    if (input.confirmed !== true) throw new Error('用户还没有确认摘要，不能发送');
    if (!ctx.store) throw new Error('当前环境不能发送咨询');
    if (/\d{12}/.test(String(input.summary).replace(/[\s-]/g, ''))) throw new Error('摘要里疑似含有个人编号，请删掉后再发');
    const p = ctx.store.getProvider(input.providerId);
    if (!p || !p.active || p.category !== input.category) throw new Error('服务商无效或类别不符');
    return { id: ctx.store.addInquiry(u.id, { providerId: p.id, category: input.category, nodeId: input.nodeId, summary: input.summary }), sentTo: p.name };
  }
  throw new Error('未知工具：' + name);
}

// llm(body) -> Anthropic Messages API 的响应对象。测试时可以注入假的。
function anthropicLLM(apiKey, fetchImpl) {
  const f = fetchImpl || fetch;
  return async (body) => {
    const r = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('模型接口返回 ' + r.status);
    return r.json();
  };
}

// 返回 { text, category, toolCalls, messages }
async function chat(ctx, history, userText, opts) {
  const eng = createEngine({ profile: ctx.user.profile, done: ctx.user.done, plan: ctx.user.plan, auth: ctx.user.auth, events: ctx.store ? ctx.store.listEvents(ctx.user.id) : [], now: ctx.now });
  const messages = (history || []).concat([{ role: 'user', content: userText }]);
  const toolCalls = [];
  for (let i = 0; i < (opts.maxTurns || 6); i++) {
    const res = await opts.llm({ model: opts.model || process.env.MODEL || 'claude-sonnet-5-5', max_tokens: 1200, system: systemPrompt(eng, ctx.now), tools: TOOL_DEFS, messages });
    messages.push({ role: 'assistant', content: res.content });
    const uses = (res.content || []).filter((b) => b.type === 'tool_use');
    if (!uses.length || res.stop_reason !== 'tool_use') {
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const m = /^\s*【([A-G])】\s*/.exec(text);
      return { text: m ? text.slice(m[0].length) : text, category: m ? m[1] : null, toolCalls, messages };
    }
    messages.push({ role: 'user', content: uses.map((b) => {
      try { const out = execTool(b.name, b.input, ctx); toolCalls.push({ name: b.name, input: b.input, ok: true }); return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) }; }
      catch (e) { toolCalls.push({ name: b.name, input: b.input, ok: false, error: e.message }); return { type: 'tool_result', tool_use_id: b.id, content: e.message, is_error: true }; }
    }) });
  }
  return { text: '这次没有成功，请再试一次。', category: null, toolCalls, messages };
}

module.exports = { TOOL_DEFS, systemPrompt, execTool, chat, anthropicLLM };
