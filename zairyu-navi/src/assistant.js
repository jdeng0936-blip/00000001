// 助手：系统提示词 + 工具 + 调用 Claude 的循环。
// 助手的所有方案、期限、价格都来自规则引擎的工具结果，不由模型自己编。
const createEngine = require('./engine');
const { validateProfilePatch, validateInquiry, isDate, HttpError } = require('./validate');

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
  { name: 'create_inquiry', description: '准备一份给服务商的咨询草稿。这个工具不会发送任何内容：草稿会显示在用户的页面上，由用户本人核对摘要、勾选同意后自己点发送。providerIds 是用户自己选的服务商（最多三家，同一类别），来自 suggest_providers 的结果。summary 是5至2000字的摘要，不能写个人编号、护照号、银行账号、卡号。',
    input_schema: { type: 'object', properties: { category: { type: 'string' }, providerIds: { type: 'array', items: { type: 'string' }, maxItems: 3 }, nodeId: { type: 'string' }, summary: { type: 'string' } }, required: ['category', 'providerIds', 'summary'] } }
];

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

// 引擎里的提示词之后追加的规则（发咨询的流程）。和引擎里的规则冲突时以这里为准。
const EXTRA_RULES = '\n\n【补充规则】\n' +
  '15. 你不能替用户把任何内容发给服务商，也没有发送的工具。用户想联系服务商时：先用 suggest_providers 列出这一类的服务商，让用户自己选（最多三家）；用户选好后用 create_inquiry 准备草稿。草稿会显示在用户的页面上，由用户本人核对摘要、勾选同意后点发送。调用之后告诉用户“草稿已经准备好，请在页面上核对后确认发送”，不要说“已经发送”“已经提交”。\n' +
  '16. 咨询摘要只写办这件事需要的情况，不写个人编号（My Number）、护照号、银行账号、卡号。工具提示内容含有这类号码时，告诉用户删掉后再试，不要换一种写法绕过。';

function systemPrompt(eng, now) { return eng.SYS + eng.kb() + EXTRA_RULES + '\n\n【用户概况】' + eng.profileText() + '\n今天是' + eng.fmt(now ? new Date(now) : new Date()) + '。'; }

// ctx: { user, store, now }
// 名单上的服务商都向平台付固定的展示费：助手列名单、准备草稿时都要说明（和名单页上方的说明一致）
const PAID_LISTING = '以下服务商向在留导航支付固定的展示费（不按咨询数或成交付费），排列按入驻先后，平台不推荐某一家。';
const PROMO_NOTE = '这一类不是士业，名单上标明“含推广”。';
function execTool(name, input, ctx) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const u = ctx.user;
  // 模型调用要等很久，这期间用户可能在页面上改了概况或进度。动手之前先重新读一次，避免用旧的快照覆盖新的数据。
  if (ctx.store) {
    const fresh = ctx.store.getUser(u.id);
    if (!fresh) throw new Error('账号已经删除');
    Object.assign(u, fresh);
  }
  const eng = () => createEngine({ profile: u.profile, done: u.done, plan: u.plan, auth: u.auth, events: ctx.store ? ctx.store.listEvents(u.id) : [], now: ctx.now });
  const persist = (action, detail) => { if (ctx.store) ctx.store.saveUser(u, action, detail); };
  if (name === 'update_profile') { Object.assign(u.profile, validateProfilePatch(input)); persist('profile.update', { via: 'assistant', keys: Object.keys(input) }); return { profile: eng().profileText() }; }
  if (name === 'get_plan') return eng().plan();
  if (name === 'mark_done') {
    const e = eng();
    // 用节点表判断，不用对象取值：'constructor'、'__proto__' 这类键不能当成任务
    if (typeof input.id !== 'string' || !e.NODES.some((n) => n.id === input.id)) throw new Error('没有这个任务');
    const st = e.compute()[input.id];
    if (!st) throw new Error('没有这个任务');
    if (st.state === 'locked') throw new Error('这个任务还没解锁：' + (st.note || ''));
    u.done[input.id] = true; persist('task.done', { via: 'assistant', id: input.id });
    const p = eng().plan(); return { done: input.id, next: p.next };
  }
  if (name === 'add_trip') { const trips = (u.profile.trips || []).concat([[input.out, input.back]]); Object.assign(u.profile, validateProfilePatch({ trips })); persist('profile.update', { via: 'assistant', keys: ['trips'] }); return { trips: u.profile.trips.length }; }
  if (name === 'add_event') {
    const e = eng();
    if (typeof input.type !== 'string' || !Object.hasOwn(e.EVRULES, input.type)) throw new Error('事件类型无效');
    if (!isDate(input.date)) throw new Error('日期须为 YYYY-MM-DD，且是真实存在的日期；用户没说具体日期时先问清楚');
    if (!ctx.store) throw new Error('当前环境不能记录事件');
    ctx.store.addEvent(u.id, { type: input.type, date: input.date });
    // 每条期限带上依据（法条、官方页面的标题和地址），助手回答时可以写出来
    const deadlines = eng().reminders().filter((r) => r.tag === '事件').map((r) => Object.assign({ date: e.fmt(r.d), text: r.txt }, r.src ? { law: r.src.law, source: r.src.title, url: r.src.url } : {}, r.src && r.src.more ? { more: r.src.more } : {}));
    const mine = e.eventDeadlines({ type: input.type, date: input.date }).length;
    return Object.assign({ recorded: e.EVRULES[input.type][0], deadlines }, mine ? {} : { note: '这件事在本工具里没有登记到对应的期限。这不代表没有其他手续，请告诉用户以入管厅或区役所的说明为准，不要说“没有法定的届出”。' });
  }
  if (name === 'get_options') return eng().options(input.topic, input.params);
  if (name === 'suggest_providers') {
    const e = eng(); const c = e.CATS.find((x) => x[0] === input.category);
    if (!c) throw new Error('服务类别无效');
    // 含推广按类别定（非士业一律标），和名单页一样；展示费的说明每次都带上，助手要照着告诉用户（ステマ規制）
    const promoted = !e.REGULATED[c[0]];
    const list = ctx.store ? ctx.store.listProviders(c[0]).map((p) => ({ providerId: p.id, name: p.name, area: p.area, langs: p.langs, feeNote: p.feeNote, promoted })) : [];
    return { category: c[1], what: c[2], regulated: !!e.REGULATED[c[0]], providers: list, disclosure: PAID_LISTING + (promoted ? PROMO_NOTE : ''), note: '按入驻顺序列出，由用户自己选择，助手不推荐某一家。' + (list.length ? '介绍名单时要把 disclosure 的内容告诉用户' + (promoted ? '，并在每家后面标明“含推广”' : '') + '。' : '这一类还没有入驻的服务商。') };
  }
  if (name === 'create_inquiry') {
    // 只准备草稿，不写库、不发送。校验和 POST /inquiries 用同一个函数；真正发送只能由用户在页面上带 consent:true 调接口。
    if (!ctx.store) throw new Error('当前环境不能准备咨询');
    const e = eng();
    // 和 POST /inquiries 一样只认此刻在名单上展示的服务商（在架，并且展示费已付或不收费）：批准了但没付款的不能出现在草稿里
    const getProvider = (id) => { const p = ctx.store.getProvider(id); return p && Object.assign(p, { active: p.active && ctx.store.providerListing(id).listed }); };
    const d = validateInquiry(input, { hasCategory: (k) => e.CATS.some((c) => c[0] === k), hasNode: (id) => e.NODES.some((n) => n.id === id), getProvider });
    const promoted = !e.REGULATED[d.category];
    return { draft: { category: d.category, nodeId: d.nodeId, summary: d.summary, providerIds: d.providerIds, providers: d.providers.map((p) => Object.assign({}, p, { promoted })), disclosure: PAID_LISTING + (promoted ? PROMO_NOTE : '') }, sent: false,
      note: '草稿已经显示在用户的页面上，还没有发送。请告诉用户：在页面上核对摘要、勾选同意后自己点发送。不要说已经发送。' };
  }
  throw new Error('未知工具：' + name);
}

// ---- 对话历史 ----
// 历史由网页端保存并在下一轮带回来，所以服务器不能照单全收：只接受本助手自己会产生的形状。
// 规则：
// - 最多 HISTORY_MAX_IN 条；每条 role 只能是 user 或 assistant。
// - user 的内容是文字（1至 TEXT_MAX 字），或者一组 tool_result（必须正好对应上一条 assistant 里的 tool_use）。
// - assistant 的内容是文字，或者一组 text / tool_use 块（工具名必须是本助手的工具）。
// - 第一条必须是 user 的文字；tool_use 后面必须紧跟它的 tool_result，历史不能停在没有结果的 tool_use 上。
// 通过后返回只含已知字段的干净副本。不合规则时抛 HttpError(422)，网页端应清空历史后重试。
const HISTORY_MAX_IN = 60, HISTORY_KEEP = 20, HISTORY_BYTES = 40000, TEXT_MAX = 8000, RESULT_MAX = 40000;
function validateHistory(history) {
  const bad = (why) => new HttpError(422, 'history 无效（' + why + '）。请清空对话历史后重试');
  if (history == null) return [];
  if (!Array.isArray(history)) throw bad('须为数组');
  if (history.length > HISTORY_MAX_IN) throw bad('最多' + HISTORY_MAX_IN + '条');
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const str = (x, max) => typeof x === 'string' && x.length <= max;
  const out = []; let pending = null; // 上一条 assistant 里还没有结果的 tool_use id
  history.forEach((msg, i) => {
    if (!isObj(msg) || (msg.role !== 'user' && msg.role !== 'assistant')) throw bad('第' + (i + 1) + '条的 role 须为 user 或 assistant');
    const c = msg.content;
    if (msg.role === 'user') {
      if (typeof c === 'string') {
        if (pending) throw bad('第' + (i + 1) + '条之前的工具调用没有结果');
        if (!c.trim() || c.length > TEXT_MAX) throw bad('第' + (i + 1) + '条的文字须为1至' + TEXT_MAX + '字');
        out.push({ role: 'user', content: c });
      } else {
        if (!Array.isArray(c) || !c.length || !pending) throw bad('第' + (i + 1) + '条不是文字，也不是对上一条工具调用的结果');
        const ids = new Set();
        const blocks = c.map((b) => {
          if (!isObj(b) || b.type !== 'tool_result' || !str(b.tool_use_id, 200) || !str(b.content, RESULT_MAX) || !pending.has(b.tool_use_id) || ids.has(b.tool_use_id)) throw bad('第' + (i + 1) + '条的工具结果对不上');
          ids.add(b.tool_use_id);
          const r = { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content };
          if (b.is_error === true) r.is_error = true;
          return r;
        });
        if (ids.size !== pending.size) throw bad('第' + (i + 1) + '条缺少工具结果');
        pending = null; out.push({ role: 'user', content: blocks });
      }
    } else {
      if (!out.length) throw bad('第一条须为用户的文字');
      if (pending || out[out.length - 1].role !== 'user') throw bad('第' + (i + 1) + '条 assistant 的位置不对');
      if (typeof c === 'string') { if (c.length > TEXT_MAX) throw bad('第' + (i + 1) + '条太长'); out.push({ role: 'assistant', content: c }); return; }
      if (!Array.isArray(c) || c.length > 20) throw bad('第' + (i + 1) + '条的内容须为文字或内容块');
      const ids = new Set();
      const blocks = c.map((b) => {
        if (isObj(b) && b.type === 'text' && str(b.text, TEXT_MAX)) return { type: 'text', text: b.text };
        if (isObj(b) && b.type === 'tool_use' && str(b.id, 200) && b.id && !ids.has(b.id) && typeof b.name === 'string' && TOOL_NAMES.has(b.name) && isObj(b.input)) { ids.add(b.id); return { type: 'tool_use', id: b.id, name: b.name, input: b.input }; }
        throw bad('第' + (i + 1) + '条里有不认识的内容块');
      });
      if (ids.size) pending = ids;
      out.push({ role: 'assistant', content: blocks });
    }
  });
  if (out.length && typeof out[0].content !== 'string') throw bad('第一条须为用户的文字');
  if (pending) throw bad('最后的工具调用没有结果');
  return out;
}

// 历史里会转给模型的每一段文字：用户和助手的话、工具调用的参数（序列化后）、工具结果。给敏感号码过滤用。
function historyTexts(history) {
  const out = [];
  for (const msg of history || []) {
    if (typeof msg.content === 'string') { out.push(msg.content); continue; }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type === 'text') out.push(b.text);
      else if (b.type === 'tool_use') out.push(JSON.stringify(b.input));
      else if (b.type === 'tool_result') out.push(b.content);
    }
  }
  return out;
}

// 裁剪历史：只在“一轮的开头”（user 的文字消息）下刀，绝不把 tool_use 和它的 tool_result 拆开。
// 保留尽量多的最近几轮，但不超过 maxMessages 条、序列化后不超过 maxBytes 字节；一轮都放不下就返回空。
function trimHistory(messages, maxMessages, maxBytes) {
  maxMessages = maxMessages || HISTORY_KEEP; maxBytes = maxBytes || HISTORY_BYTES;
  const list = messages || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].role !== 'user' || typeof list[i].content !== 'string') continue;
    const rest = list.slice(i);
    if (rest.length <= maxMessages && Buffer.byteLength(JSON.stringify(rest)) <= maxBytes) return rest;
  }
  return [];
}

// 模型返回的内容只留 text 和 tool_use 两种块、只留已知字段，保证存进历史的东西下一轮能通过 validateHistory。
// tool_use 的工具名不是本助手的工具、没有 id 或 id 重复时整块丢掉（不执行、不进历史）：validateHistory 不接受这样的块。
function cleanContent(content) {
  const ids = new Set();
  return (Array.isArray(content) ? content : []).map((b) => {
    if (b && b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: b.text.slice(0, TEXT_MAX) };
    if (b && b.type === 'tool_use' && typeof b.id === 'string' && b.id && b.id.length <= 200 && !ids.has(b.id) && typeof b.name === 'string' && TOOL_NAMES.has(b.name)) {
      ids.add(b.id);
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {} };
    }
    return null;
  }).filter(Boolean);
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

// 返回 { text, category, toolCalls, draft, messages }
// draft：这一轮里助手准备好的咨询草稿（没有则为 null）。草稿没有发送，要由用户在页面上确认后调 POST /inquiries。
// messages：已按轮裁剪过的完整历史，网页端原样保存、下一轮带回。
async function chat(ctx, history, userText, opts) {
  const engOf = () => createEngine({ profile: ctx.user.profile, done: ctx.user.done, plan: ctx.user.plan, auth: ctx.user.auth, events: ctx.store ? ctx.store.listEvents(ctx.user.id) : [], now: ctx.now });
  const messages = trimHistory(history || []).concat([{ role: 'user', content: userText }]);
  const toolCalls = []; let draft = null;
  const done = (text, category) => ({ text, category, toolCalls, draft, messages: trimHistory(messages) });
  for (let i = 0; i < (opts.maxTurns || 6); i++) {
    // 每一轮都按最新的概况生成提示词（工具可能刚改过概况）
    const res = await opts.llm({ model: opts.model || process.env.MODEL || 'claude-sonnet-5-5', max_tokens: 1200, system: systemPrompt(engOf(), ctx.now), tools: TOOL_DEFS, messages });
    const content = cleanContent(res && res.content);
    const uses = content.filter((b) => b.type === 'tool_use');
    if (!uses.length || res.stop_reason !== 'tool_use') {
      // 模型只调用了不认识的工具（已被 cleanContent 丢掉）又没说话：给一句收尾的话，这一轮照常结束
      const dropped = Array.isArray(res && res.content) && res.content.some((b) => b && b.type === 'tool_use') && !uses.length;
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('') || (dropped ? '这次没有成功，请再试一次。' : '');
      // 历史里不留没有结果的 tool_use（例如模型被截断时），否则下一轮会被模型接口拒绝
      messages.push({ role: 'assistant', content: content.filter((b) => b.type === 'text').length ? content.filter((b) => b.type === 'text') : [{ type: 'text', text: text || '（没有回答）' }] });
      const m = /^\s*【([A-G])】\s*/.exec(text);
      return done(m ? text.slice(m[0].length) : text, m ? m[1] : null);
    }
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: uses.map((b) => {
      try {
        const out = execTool(b.name, b.input, ctx); toolCalls.push({ name: b.name, input: b.input, ok: true });
        if (b.name === 'create_inquiry') draft = out.draft;
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) };
      } catch (e) { toolCalls.push({ name: b.name, input: b.input, ok: false, error: e.message }); return { type: 'tool_result', tool_use_id: b.id, content: String(e.message), is_error: true }; }
    }) });
  }
  // 工具轮数用完：补一条助手的话收尾，让历史停在完整的一轮上
  const text = '这次没有成功，请再试一次。';
  messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
  return done(text, null);
}

module.exports = { TOOL_DEFS, systemPrompt, execTool, chat, anthropicLLM, validateHistory, historyTexts, trimHistory };
