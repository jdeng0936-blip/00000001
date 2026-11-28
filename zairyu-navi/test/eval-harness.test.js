// 真实模型跑题前的准备：请求的形状（不发采样参数、不强制调用工具、不预填）、思考块、拒答、被截断、429 和 529 的重试，
// 以及 eval/run.js 的试跑（--dry）、并发上限、每题时限、接着上次的结果跑、用量和费用估算。全部用假的模型，不联网。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createStore } = require('../src/store');
const A = require('../src/assistant');
const { runEval, dryLLM, costOf, PRICES } = require('../eval/run');

const { chat, anthropicLLM, checkRequest, llmConfig, validateHistory } = A;
const QS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'questions.json'), 'utf8'));
const ctxOf = () => { const store = createStore(); const user = store.createUser(); return { user, store, now: '2026-11-26' }; };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zn-eval-'));
const say = (text, extra) => Object.assign({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }, extra || {});
const THINK = { type: 'thinking', thinking: '', signature: 'sig-abc' };

// 假的 fetch：按顺序返回 replies 里的响应（{ status, body, headers }，或者函数），记下每次请求
function fakeFetch(replies) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    let r = replies.length > 1 ? replies.shift() : replies[0];
    if (typeof r === 'function') r = await r(JSON.parse(init.body), init);
    const h = new Map(Object.entries(r.headers || {}));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => (h.has(k) ? h.get(k) : null) }, json: async () => r.body };
  };
  return { f, calls };
}
// 检查一份请求体符合现在的模型的要求
function assertGoodBody(body) {
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in body), '不能有 ' + k);
  assert.ok(!body.tool_choice || !['any', 'tool'].includes(body.tool_choice.type), '不能强制调用工具');
  assert.ok(!body.thinking || body.thinking.type !== 'disabled', '不能关掉思考');
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[body.messages.length - 1].role, 'user', '最后一条必须是 user（不能预填）');
  assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(body.output_config.effort));
  assert.ok(body.max_tokens >= 8000, 'max_tokens 要给思考留余地');
}

test('设置：默认 claude-sonnet-5-5、effort medium、max_tokens 8000；EFFORT、MODEL、MAX_TOKENS 可以改，写错抛错', () => {
  assert.deepEqual(llmConfig({}), { model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 8000 });
  assert.deepEqual(llmConfig({ MODEL: 'claude-opus-5-5', EFFORT: 'low', MAX_TOKENS: '12000' }), { model: 'claude-opus-5-5', effort: 'low', maxTokens: 12000 });
  assert.equal(llmConfig({ EFFORT: 'low' }, { effort: 'high' }).effort, 'high', 'opts 优先');
  assert.throws(() => llmConfig({ EFFORT: 'none' }), /EFFORT/);
  assert.throws(() => llmConfig({ MAX_TOKENS: '500' }), /MAX_TOKENS/);
  assert.throws(() => llmConfig({ MAX_TOKENS: '64000' }), /MAX_TOKENS/);
});

test('请求的形状：多轮、带工具循环、历史停在助手的话上，每一次请求都没有 temperature/top_p/top_k、没有强制工具、最后一条是 user；带 effort', async () => {
  const ctx = ctxOf();
  let n = 0;
  const { f, calls } = fakeFetch([() => {
    n++;
    if (n % 2 === 1) return { status: 200, body: { stop_reason: 'tool_use', content: [THINK, { type: 'text', text: '我查一下。' }, { type: 'tool_use', id: 'tu' + n, name: 'get_plan', input: {} }], usage: { input_tokens: 100, output_tokens: 20 } } };
    return { status: 200, body: say('【A】好的。') };
  }]);
  const llm = anthropicLLM('test-key', f, { sleep: async () => {} });
  let hist = [];
  for (let i = 0; i < 3; i++) {
    const r = await chat(ctx, validateHistory(hist), '第' + i + '个问题', { llm, effort: 'low' });
    hist = r.messages;
    assert.equal(hist[hist.length - 1].role, 'assistant', '历史停在助手的话上，下一轮由服务器补上用户的话');
  }
  assert.equal(calls.length, 6);
  for (const c of calls) {
    assertGoodBody(c.body);
    assert.equal(c.body.output_config.effort, 'low'); assert.equal(c.body.model, 'claude-sonnet-5-5'); assert.ok(!('thinking' in c.body), '不发 thinking，思考按默认（自适应）');
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(c.init.headers['anthropic-version'], '2023-06-01'); assert.equal(c.init.headers['x-api-key'], 'test-key');
  }
});

test('请求的形状：checkRequest 拦下违反规定的请求，anthropicLLM 不会把它发出去', async () => {
  const ok = { model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(checkRequest(ok), ok);
  const bad = [
    Object.assign({}, ok, { temperature: 0 }), Object.assign({}, ok, { top_p: 0.9 }), Object.assign({}, ok, { top_k: 5 }),
    Object.assign({}, ok, { tool_choice: { type: 'any' } }), Object.assign({}, ok, { tool_choice: { type: 'tool', name: 'get_plan' } }),
    Object.assign({}, ok, { thinking: { type: 'disabled' } }),
    Object.assign({}, ok, { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '【A】' }] }),
    Object.assign({}, ok, { messages: [] })
  ];
  const { f, calls } = fakeFetch([{ status: 200, body: say('x') }]);
  const llm = anthropicLLM('k', f);
  for (const b of bad) { assert.throws(() => checkRequest(b)); await assert.rejects(llm(b)); }
  assert.equal(calls.length, 0, '一个都没有发出去');
  assert.ok(checkRequest(Object.assign({}, ok, { tool_choice: { type: 'auto' } })));
});

test('思考块：取回答时忽略；同一轮的工具循环里原样发回（含签名）；系统提示整轮不变；返回的历史里没有思考块，下一轮能通过校验', async () => {
  const ctx = ctxOf();
  const bodies = [];
  const first = [THINK, { type: 'tool_use', id: 't1', name: 'update_profile', input: { status: 'student' } }];
  const llm = async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    if (bodies.length === 1) return { stop_reason: 'tool_use', content: first };
    return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig-2' }, { type: 'redacted_thinking', data: 'xyz' }, { type: 'text', text: '【B】记好了，你是留学生。' }] };
  };
  const r = await chat(ctx, [], '我是留学生', { llm });
  assert.equal(r.text, '记好了，你是留学生。'); assert.equal(r.category, 'B'); assert.equal(r.stopReason, 'end_turn');
  assert.deepEqual(bodies[1].messages[1], { role: 'assistant', content: first }, '助手的回复原样发回，思考块和签名都在');
  assert.equal(bodies[1].messages[2].content[0].tool_use_id, 't1');
  assert.equal(bodies[0].system, bodies[1].system, '工具改了概况，系统提示这一轮里也不变（改了的话发回的思考块会被拒）');
  assert.equal(ctx.store.getUser(ctx.user.id).profile.status, 'student', '工具照常执行');
  const s = JSON.stringify(r.messages);
  assert.ok(!s.includes('thinking') && !s.includes('sig-abc'), '返回给网页端的历史里没有思考块');
  assert.deepEqual(validateHistory(r.messages), r.messages);
  // 只有思考块、没有文字的回答：不把空的思考当回答
  const r2 = await chat(ctxOf(), [], '你好', { llm: async () => ({ stop_reason: 'end_turn', content: [THINK] }) });
  assert.equal(r2.text, ''); assert.deepEqual(validateHistory(r2.messages), r2.messages);
  // 认识的和不认识的工具混在一起：发给模型的每个 tool_use 都有结果，历史里只留认识的
  const seen = [];
  const mix = async (body) => { seen.push(JSON.parse(JSON.stringify(body))); return seen.length === 1 ? { stop_reason: 'tool_use', content: [THINK, { type: 'tool_use', id: 'a', name: 'get_plan', input: {} }, { type: 'tool_use', id: 'b', name: 'drop_table', input: {} }] } : say('【A】好。'); };
  const r3 = await chat(ctxOf(), [], '我该办什么', { llm: mix });
  assert.deepEqual(seen[1].messages[2].content.map((x) => [x.tool_use_id, !!x.is_error]), [['a', false], ['b', true]]);
  assert.deepEqual(validateHistory(r3.messages), r3.messages); assert.ok(!JSON.stringify(r3.messages).includes('drop_table'));
});

test('拒答（stop_reason refusal，HTTP 200）：给用户固定的说法，记下类别；这一轮不进历史，下一轮照常', async () => {
  const ctx = ctxOf();
  const prior = (await chat(ctx, [], '你好', { llm: async () => say('【A】你好。') })).messages;
  const bodies = [];
  const llm = async (body) => { bodies.push(body); return { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: '说明' }, content: [{ type: 'text', text: '半截' }], usage: { input_tokens: 50, output_tokens: 3 } }; };
  const r = await chat(ctx, prior, '一个会被拒的问题', { llm });
  assert.equal(r.text, A.REFUSAL_TEXT); assert.equal(r.category, null); assert.equal(r.stopReason, 'refusal');
  assert.deepEqual(r.refusal, { category: 'cyber', explanation: '说明' });
  assert.deepEqual(r.messages, prior, '拒答的这一轮不进历史');
  assert.ok(!JSON.stringify(r.messages).includes('半截'));
  assert.equal(r.usage.output_tokens, 3);
  assert.equal(bodies.length, 1, '拒答不重试');
  // 没有 stop_details 也不出错
  const r2 = await chat(ctxOf(), [], 'x', { llm: async () => ({ stop_reason: 'refusal', content: [] }) });
  assert.deepEqual(r2.refusal, { category: null, explanation: null });
  // 服务器接口：拒答照常返回 200 和固定的说法
  const { createApp } = require('../src/server');
  const app = createApp({ now: '2026-11-26', llm });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const u = await (await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: app.termsVersion }) })).json();
    const res = await fetch(base + '/api/users/' + u.id + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ message: '一个会被拒的问题' }) });
    const b = await res.json();
    assert.equal(res.status, 200); assert.equal(b.text, A.REFUSAL_TEXT); assert.equal(b.history, undefined, '历史不再返回给网页');
    assert.deepEqual(app.store.getChat(u.id), [], '拒答的这一轮也不存进服务器上的历史');
  } finally { app.server.close(); app.store.close(); }
});

test('被截断（max_tokens）：先用更大的 max_tokens 重试一次；仍被截断就不给半截回答，被截断的工具调用不执行', async () => {
  // 重试后成功
  const sizes = [];
  const r = await chat(ctxOf(), [], '问题', { llm: async (b) => { sizes.push(b.max_tokens); return sizes.length === 1 ? { stop_reason: 'max_tokens', content: [THINK, { type: 'text', text: '半截的回' }] } : say('【A】完整的回答。'); } });
  assert.deepEqual(sizes, [8000, 16000]); assert.equal(r.text, '完整的回答。'); assert.equal(r.usage.requests, 2);
  // 两次都被截断，最后一块是没写完的工具调用
  const ctx = ctxOf(), sizes2 = [];
  const r2 = await chat(ctx, [], '我是留学生', { llm: async (b) => { sizes2.push(b.max_tokens); return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '好的，我记' }, { type: 'tool_use', id: 't1', name: 'update_profile', input: { status: 'student' } }] }; } });
  assert.deepEqual(sizes2, [8000, 16000]);
  assert.equal(r2.text, A.TRUNCATED_TEXT); assert.equal(r2.stopReason, 'max_tokens'); assert.deepEqual(r2.toolCalls, []);
  assert.equal(ctx.store.getUser(ctx.user.id).profile.status, 'none', '被截断的工具调用不执行');
  assert.ok(!JSON.stringify(r2.messages).includes('好的，我记'), '历史里没有半截的话');
  assert.deepEqual(validateHistory(r2.messages), r2.messages);
  // 工具循环的第二步被截断：前面的工具结果照常留在历史里，历史仍然合规
  let n = 0;
  const r3 = await chat(ctxOf(), [], '路线', { llm: async () => (++n === 1 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'g', name: 'get_plan', input: {} }] } : { stop_reason: 'max_tokens', content: [{ type: 'text', text: '半' }] }) });
  assert.equal(r3.text, A.TRUNCATED_TEXT); assert.deepEqual(validateHistory(r3.messages), r3.messages);
  // pause_turn（没有服务器端工具时不应出现）：让用户再试
  const r4 = await chat(ctxOf(), [], 'x', { llm: async () => ({ stop_reason: 'pause_turn', content: [{ type: 'text', text: '先停一下' }] }) });
  assert.equal(r4.text, A.RETRY_TEXT); assert.equal(r4.stopReason, 'pause_turn'); assert.deepEqual(validateHistory(r4.messages), r4.messages);
});

test('重试：429 按 retry-after 等、529 overloaded 退避后重试，成功返回；400 和 x-should-retry: false 不重试；次数用完抛出带状态码的错误；超时也重试', async () => {
  const waits = [], sleep = async (ms) => { waits.push(ms); };
  const ok = { status: 200, body: say('【A】好。') };
  const { f, calls } = fakeFetch([
    { status: 429, headers: { 'retry-after': '3' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'x' } } },
    { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'x' } } },
    { status: 503, headers: { 'retry-after': '50' }, body: {} },
    ok
  ]);
  const llm = anthropicLLM('k', f, { sleep, baseDelayMs: 1000, maxWaitMs: 60000 });
  const res = await llm({ model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.stop_reason, 'end_turn'); assert.equal(calls.length, 4);
  assert.equal(waits[0], 3000, '按 retry-after 等 3 秒');
  assert.ok(waits[1] >= 1500 && waits[1] <= 2500, '529 没有 retry-after：按退避等（第 2 次约 2 秒）' + waits[1]);
  assert.equal(waits[2], 50000, 'retry-after 不超过 maxWaitMs 时等满');
  // 400 不重试，错误里有状态码和类型，没有接口返回的原文
  const b400 = fakeFetch([{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: '机密的原文' } } }]);
  const e400 = await anthropicLLM('k', b400.f, { sleep }).call(null, { model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
  assert.equal(e400.status, 400); assert.equal(e400.type, 'invalid_request_error'); assert.equal(b400.calls.length, 1); assert.ok(!e400.message.includes('机密'));
  // x-should-retry: false 时 529 也不重试；true 时 400 也重试
  const nf = fakeFetch([{ status: 529, headers: { 'x-should-retry': 'false' }, body: {} }]);
  assert.equal((await anthropicLLM('k', nf.f, { sleep })({ model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e)).status, 529); assert.equal(nf.calls.length, 1);
  const yt = fakeFetch([{ status: 400, headers: { 'x-should-retry': 'true' }, body: {} }, ok]);
  assert.equal((await anthropicLLM('k', yt.f, { sleep })({ model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] })).stop_reason, 'end_turn');
  // 一直 529：重试 maxRetries 次后抛错
  const al = fakeFetch([{ status: 529, body: {} }]);
  const eAll = await anthropicLLM('k', al.f, { sleep, maxRetries: 2 })({ model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
  assert.equal(eAll.status, 529); assert.equal(al.calls.length, 3);
  // 超时：中断请求后重试，仍超时就抛出 status 0、type timeout
  let tries = 0;
  const hang = (url, init) => { tries++; return new Promise((_, no) => init.signal.addEventListener('abort', () => no(new Error('aborted')))); };
  const eT = await anthropicLLM('k', hang, { sleep, timeoutMs: 20, maxRetries: 1 })({ model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
  assert.equal(eT.status, 0); assert.equal(eT.type, 'timeout'); assert.equal(tries, 2);
});

test('助手接口：模型接口重试后仍然忙（529）返回 503 和 retry-after，不是 500', async () => {
  const { createApp } = require('../src/server');
  const app = createApp({ now: '2026-11-26', llm: async () => { throw Object.assign(new Error('模型接口返回 529'), { status: 529, type: 'overloaded_error' }); } });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const saved = console.error; console.error = () => {};
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const u = await (await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: app.termsVersion }) })).json();
    const res = await fetch(base + '/api/users/' + u.id + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ message: '你好' }) });
    assert.equal(res.status, 503); assert.equal(res.headers.get('retry-after'), '30'); assert.match((await res.json()).error, /忙不过来/);
  } finally { console.error = saved; app.server.close(); app.store.close(); }
});

test('eval 试跑（--dry 用的假模型）：全部题走一遍工具循环和思考块，分类全对；用量和费用按价目表算；结果文件写好', async () => {
  const dir = tmpDir();
  try {
    const out = await runEval({ questions: QS.questions, version: QS.version, llm: dryLLM(QS.questions), dry: true, concurrency: 8, outFile: path.join(dir, 'r.json') });
    assert.equal(out.total, QS.questions.length); assert.equal(out.classCorrect, out.total); assert.deepEqual(out.failingMustPass, []);
    assert.equal(out.mustPassTotal, QS.questions.filter((q) => q.mustPass).length);
    assert.equal(out.usage.requests, 2 * out.total);
    assert.equal(out.estimatedCostUsd, costOf('claude-sonnet-5-5', out.usage));
    assert.equal(out.estimatedCostUsd, Math.round((out.total * 2 * 1000 * 2 + out.total * 2 * 100 * 10) / 1e6 * 1e6) / 1e6);
    assert.deepEqual(out.rows.map((r) => r.id), QS.questions.map((q) => q.id), '按题集的顺序');
    assert.ok(out.rows.every((r) => r.criteriaOk === null && r.tools[0] === 'get_plan' && r.stopReason === 'end_turn'));
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
    assert.equal(file.total, out.total); assert.equal(file.dry, true); assert.equal(file.effort, 'medium');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('eval 命令行：npm run eval -- --dry 不需要 API key、不联网，退出码 0；不带 --dry 又没有 key 时退出码 2', () => {
  const dir = tmpDir();
  try {
    const env = Object.assign({}, process.env, { ONLY: 'A1,B1', OUT: path.join(dir, 'dry.json'), CONCURRENCY: '2' });
    delete env.ANTHROPIC_API_KEY;
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'eval', 'run.js'), '--dry'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /估算费用/); assert.match(r.stdout, /criteriaOk/);
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'dry.json'), 'utf8'));
    assert.deepEqual(out.rows.map((x) => x.id), ['A1', 'B1']);
    const n = spawnSync(process.execPath, [path.join(__dirname, '..', 'eval', 'run.js')], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(n.status, 2); assert.match(n.stderr, /ANTHROPIC_API_KEY/);
    const bad = spawnSync(process.execPath, [path.join(__dirname, '..', 'eval', 'run.js'), '--dry'], { env: Object.assign({}, env, { EFFORT: 'turbo' }), encoding: 'utf8', timeout: 60000 });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /EFFORT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('eval 结果：拒答和被截断记下来；摘要列出每一道没通过的必须通过的题；出错的题记下错误', async () => {
  const qs = [
    { id: 'M1', question: '会被拒的题', expect: 'A', criteria: 'x', mustPass: true },
    { id: 'M2', question: '答对的题', expect: 'B', criteria: 'x', mustPass: true },
    { id: 'M3', question: '分类错的题', expect: 'C', criteria: 'x', mustPass: true },
    { id: 'M4', question: '被截断的题', expect: 'D', criteria: 'x', mustPass: false },
    { id: 'M5', question: '出错的题', expect: 'E', criteria: 'x', mustPass: true }
  ];
  const llm = async (body) => {
    const q = body.messages[0].content;
    if (q === '会被拒的题') return { stop_reason: 'refusal', stop_details: { category: 'general_harms' }, content: [], usage: { input_tokens: 10, output_tokens: 1 } };
    if (q === '答对的题') return say('【B】对。');
    if (q === '分类错的题') return say('【A】错。');
    if (q === '被截断的题') return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '半' }], usage: { input_tokens: 10, output_tokens: 8000 } };
    throw Object.assign(new Error('模型接口返回 400'), { status: 400 });
  };
  const out = await runEval({ questions: qs, version: 'v', llm, concurrency: 2 });
  assert.deepEqual(out.failingMustPass, ['M1', 'M3', 'M5'], '列出每一道没通过的必须通过的题');
  assert.deepEqual(out.refusals, ['M1']); assert.deepEqual(out.truncated, ['M4']); assert.deepEqual(out.errors, ['M5']);
  const row = (id) => out.rows.find((r) => r.id === id);
  assert.deepEqual(row('M1').refusal, { category: 'general_harms', explanation: null }); assert.equal(row('M1').answer, A.REFUSAL_TEXT);
  assert.equal(row('M4').usage.requests, 2, '截断后用更大的 max_tokens 重试过一次'); assert.equal(row('M4').answer, A.TRUNCATED_TEXT);
  assert.match(row('M5').error, /400/); assert.equal(row('M5').classOk, false);
  assert.equal(out.mustPassClassCorrect, 1); assert.equal(out.mustPassTotal, 4);
});

test('eval：同时跑的题不超过 CONCURRENCY；某一题超时只记这一题，其他照常', async () => {
  const qs = Array.from({ length: 9 }, (_, i) => ({ id: 'Q' + i, question: '题' + i, expect: 'A', criteria: 'x', mustPass: i === 4 }));
  let inFlight = 0, peak = 0;
  const llm = async (body) => {
    if (body.messages[0].content === '题4') return new Promise(() => {}); // 永远不回
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((ok) => setTimeout(ok, 15));
    inFlight--;
    return say('【A】好。');
  };
  const t0 = Date.now();
  const out = await runEval({ questions: qs, version: 'v', llm, concurrency: 3, timeoutMs: 200 });
  assert.ok(peak <= 3 && peak >= 2, '最多同时 3 题：' + peak);
  assert.match(out.rows.find((r) => r.id === 'Q4').error, /超时/); assert.deepEqual(out.failingMustPass, ['Q4']);
  assert.equal(out.classCorrect, 8);
  assert.ok(Date.now() - t0 < 5000);
});

test('eval：RESUME 跳过结果文件里已经跑过的题（保留人填的 criteriaOk），出错的题重跑，结果写回同一个文件', async () => {
  const dir = tmpDir();
  try {
    const qs = ['R1', 'R2', 'R3'].map((id) => ({ id, question: '题' + id, expect: 'A', criteria: 'x', mustPass: true }));
    const file = path.join(dir, 'resume.json');
    let fail = true;
    const first = await runEval({ questions: qs, version: 'v', outFile: file, llm: async (b) => { if (b.messages[0].content === '题R3' && fail) throw new Error('网络断了'); return say('【A】好。'); } });
    assert.deepEqual(first.errors, ['R3']);
    // 人复核了 R1
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.rows.find((r) => r.id === 'R1').criteriaOk = true;
    fs.writeFileSync(file, JSON.stringify(saved));
    fail = false;
    const asked = [];
    const out = await runEval({ questions: qs, version: 'v', resumeFile: file, llm: async (b) => { asked.push(b.messages[0].content); return say('【A】好。'); } });
    assert.deepEqual(asked, ['题R3'], '只重跑出错的那题');
    assert.deepEqual(out.rows.map((r) => r.id), ['R1', 'R2', 'R3']); assert.deepEqual(out.errors, []); assert.deepEqual(out.failingMustPass, []);
    assert.equal(out.rows[0].criteriaOk, true, '人填的 criteriaOk 留着'); assert.deepEqual(out.criteriaPending, ['R2', 'R3']);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rows.length, 3, '写回同一个文件');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('费用估算：按模型查价目表（Sonnet 5.5 $2/$10、Opus 5.5 $4/$20 每百万 token）；不认识的模型不估算', () => {
  const u = { input_tokens: 1000000, output_tokens: 100000 };
  assert.equal(costOf('claude-sonnet-5-5', u), 3); assert.equal(costOf('claude-opus-5-5', u), 6);
  assert.equal(costOf('claude-unknown-9', u), null); assert.equal(costOf('claude-sonnet-5-5', null), null);
  assert.deepEqual(Object.keys(PRICES).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(costOf('claude-sonnet-5-5', { cache_read_input_tokens: 1000000 }), 0.1);
});

const HI = { model: 'm', max_tokens: 8000, messages: [{ role: 'user', content: 'hi' }] };

test('重试：retry-after 比 maxWaitMs 还长时不提前重试，直接抛出带 wait 的 429；聊天接口照它回 503 和 retry-after', async () => {
  const waits = [], sleep = async (ms) => { waits.push(ms); };
  const { f, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '120' }, body: { type: 'error', error: { type: 'rate_limit_error' } } }]);
  const e = await anthropicLLM('k', f, { sleep, maxWaitMs: 60000 })(HI).catch((x) => x);
  assert.equal(e.status, 429); assert.equal(e.wait, 120000); assert.equal(calls.length, 1, '没有在限流窗口里重试'); assert.deepEqual(waits, []);
  const { createApp } = require('../src/server');
  const app = createApp({ now: '2026-11-26', llm: anthropicLLM('k', f, { sleep, maxWaitMs: 15000 }) });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const saved = console.error; console.error = () => {};
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const u = await (await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: app.termsVersion }) })).json();
    const res = await fetch(base + '/api/users/' + u.id + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ message: '你好' }) });
    assert.equal(res.status, 503); assert.equal(res.headers.get('retry-after'), '120');
  } finally { console.error = saved; app.server.close(); app.store.close(); }
});

test('响应体：200 但读到一半断了或不是 JSON 算连接出错、会重试；读响应体也算在每次请求的时限里', async () => {
  const sleep = async () => {};
  let n = 0;
  const flaky = async () => { n++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => { if (n === 1) throw new Error('socket hang up'); return say('【A】好。'); } }; };
  assert.equal((await anthropicLLM('k', flaky, { sleep })(HI)).stop_reason, 'end_turn'); assert.equal(n, 2, '重试了一次');
  const broken = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
  const e = await anthropicLLM('k', broken, { sleep, maxRetries: 1 })(HI).catch((x) => x);
  assert.equal(e.status, 0); assert.equal(e.type, 'connection'); assert.equal(e.retryable, true);
  // 响应头来了，响应体一直不来：照样按 timeoutMs 中断
  let m = 0;
  const stall = async (url, init) => { m++; return { ok: true, status: 200, headers: { get: () => null }, json: () => new Promise((_, no) => init.signal.addEventListener('abort', () => no(new Error('aborted')))) }; };
  const t0 = Date.now();
  const eS = await anthropicLLM('k', stall, { sleep, timeoutMs: 30, maxRetries: 1 })(HI).catch((x) => x);
  assert.equal(eS.type, 'timeout'); assert.equal(m, 2); assert.ok(Date.now() - t0 < 2000);
});

test('中止（AbortSignal）：正在发的请求立即中断、不重试；等待重试时中止也马上停；chat 中止后不执行工具，已经花掉的用量记在调用方给的 usage 里', async () => {
  // 正在发的请求
  let calls = 0;
  const hang = (url, init) => { calls++; return new Promise((_, no) => init.signal.addEventListener('abort', () => no(new Error('aborted')))); };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const e = await anthropicLLM('k', hang, { timeoutMs: 60000 })(HI, { signal: ac.signal }).catch((x) => x);
  assert.equal(e.type, 'aborted'); assert.equal(e.status, 0); assert.equal(calls, 1, '中止的不重试');
  // 等待重试（真的 sleep，retry-after 10 秒）时中止
  const busy = fakeFetch([{ status: 529, headers: { 'retry-after': '10' }, body: {} }]);
  const ac2 = new AbortController(), t0 = Date.now();
  setTimeout(() => ac2.abort(A.abortError('deadline')), 30);
  const e2 = await anthropicLLM('k', busy.f, { maxWaitMs: 60000 })(HI, { signal: ac2.signal }).catch((x) => x);
  assert.equal(e2.type, 'deadline'); assert.equal(busy.calls.length, 1); assert.ok(Date.now() - t0 < 2000, '没有等满 10 秒');
  // chat：第一次请求要调 update_profile，回来时已经中止了：工具不执行，用量记下
  const ctx = ctxOf(), ac3 = new AbortController(), usage = A.newUsage();
  const llm = async () => { ac3.abort(); return { stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'tool_use', id: 't1', name: 'update_profile', input: { status: 'student' } }] }; };
  const e3 = await chat(ctx, [], '我是留学生', { llm, signal: ac3.signal, usage }).catch((x) => x);
  assert.equal(e3.type, 'aborted'); assert.equal(e3.status, 0);
  assert.notEqual(ctx.store.getUser(ctx.user.id).profile.status, 'student', '中止后不改数据');
  assert.deepEqual([usage.requests, usage.input_tokens, usage.output_tokens], [1, 7, 3]); assert.equal(e3.usage, usage, '错误上也带用量');
  // 注入的 llm 不理 signal 时，chat 也不会一直等
  const ac4 = new AbortController(); setTimeout(() => ac4.abort(), 20);
  const e4 = await chat(ctxOf(), [], '你好', { llm: () => new Promise(() => {}), signal: ac4.signal }).catch((x) => x);
  assert.equal(e4.type, 'aborted');
  // 出错（不是中止）时错误也带到出错为止的用量
  let k = 0;
  const e5 = await chat(ctxOf(), [], '你好', { llm: async () => { if (k++) throw Object.assign(new Error('模型接口返回 529'), { status: 529 }); return { stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'g', name: 'get_plan', input: {} }] }; } }).catch((x) => x);
  assert.equal(e5.status, 529); assert.equal(e5.usage.requests, 1); assert.equal(e5.usage.input_tokens, 5);
});

test('聊天接口：用短的重试设置；整轮超过总时限就停下、返回 503，之后才回来的工具调用不执行', async () => {
  assert.ok(A.CHAT_LLM_OPTS.timeoutMs <= 60000 && A.CHAT_LLM_OPTS.maxRetries <= 2 && A.CHAT_LLM_OPTS.maxWaitMs <= 15000, '比 eval 的默认值短');
  assert.ok(A.CHAT_DEADLINE_MS <= 180000);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /anthropicLLM\(process\.env\.ANTHROPIC_API_KEY, null, assistant\.CHAT_LLM_OPTS\)/);
  const { createApp } = require('../src/server');
  let seen = null;
  const llm = (body, o) => { seen = o && o.signal; return new Promise((ok) => setTimeout(() => ok({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'update_profile', input: { status: 'student' } }] }), 150)); };
  const app = createApp({ now: '2026-11-26', llm, chatDeadlineMs: 40 });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const saved = console.error; console.error = () => {};
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const u = await (await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: app.termsVersion }) })).json();
    const t0 = Date.now();
    const res = await fetch(base + '/api/users/' + u.id + '/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + u.token }, body: JSON.stringify({ message: '我是留学生' }) });
    assert.equal(res.status, 503); assert.ok(Date.now() - t0 < 140, '没等模型回来');
    assert.ok(seen && seen.aborted, '请求带着 signal，已经中止');
    await new Promise((ok) => setTimeout(ok, 200));
    assert.notEqual(app.store.getUser(u.id).profile.status, 'student', '模型晚回来的工具调用不执行');
  } finally { console.error = saved; app.server.close(); app.store.close(); }
});

test('eval：RESUME 的结果文件和这次的模型、effort、max_tokens、提示词版本、是否试跑不一样时不接着跑；命令行退出码 2', async () => {
  const dir = tmpDir();
  try {
    const qs = ['S1', 'S2'].map((id) => ({ id, question: '题' + id, expect: 'A', criteria: 'x', mustPass: true }));
    const file = path.join(dir, 'r.json');
    await runEval({ questions: qs, version: 'v1', outFile: file, dry: true, llm: dryLLM(qs) });
    const before = fs.readFileSync(file, 'utf8');
    for (const [over, key] of [[{ model: 'claude-opus-5-5' }, 'model'], [{ effort: 'high' }, 'effort'], [{ maxTokens: 12000 }, 'maxTokens'], [{ version: 'v2' }, 'promptVersion'], [{ dry: false }, 'dry']]) {
      const asked = [];
      const e = await runEval(Object.assign({ questions: qs, version: 'v1', resumeFile: file, dry: true, llm: async () => { asked.push(1); return say('【A】好。'); } }, over)).catch((x) => x);
      assert.ok(e instanceof Error, key); assert.match(e.message, new RegExp('RESUME[\\s\\S]*' + key)); assert.equal(asked.length, 0, '一题都没跑');
      assert.equal(fs.readFileSync(file, 'utf8'), before, '结果文件没被改');
    }
    // 设置一样就照常接着跑
    const ok = await runEval({ questions: qs, version: 'v1', resumeFile: file, dry: true, llm: dryLLM(qs) });
    assert.equal(ok.total, 2);
    const env = Object.assign({}, process.env, { RESUME: file, EFFORT: 'high' });
    delete env.ANTHROPIC_API_KEY;
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'eval', 'run.js'), '--dry'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /RESUME.*effort/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('eval：超时、出错的题记下已经花掉的用量；超时中止正在发的请求，等它停下才跑下一题；RESUME 丢掉出错的题时用量累计进 discardedUsage，费用算在里面', async () => {
  const qs = ['T1', 'T2', 'T3'].map((id) => ({ id, question: '题' + id, expect: 'A', criteria: 'x', mustPass: true }));
  const signals = [];
  let inFlight = 0, peak = 0;
  // T1：第一次请求 30 毫秒后要调工具，第二次请求挂住（只有中止才结束）
  const llm = async (body, o) => {
    signals.push(o && o.signal);
    inFlight++; peak = Math.max(peak, inFlight);
    try {
      if (body.messages[0].content === '题T1') {
        if (body.messages.length === 1) { await new Promise((ok) => setTimeout(ok, 30)); return { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'tool_use', id: 'g', name: 'get_plan', input: {} }] }; }
        return await new Promise((_, no) => o.signal.addEventListener('abort', () => no(A.abortError())));
      }
      if (body.messages[0].content === '题T2') {
        if (body.messages.length === 1) return { stop_reason: 'tool_use', usage: { input_tokens: 50, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'g', name: 'get_plan', input: {} }] };
        throw Object.assign(new Error('模型接口返回 529'), { status: 529 });
      }
      return say('【A】好。');
    } finally { inFlight--; }
  };
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'u.json');
    const out = await runEval({ questions: qs, version: 'v', llm, concurrency: 1, timeoutMs: 60, outFile: file });
    const row = (id) => out.rows.find((r) => r.id === id);
    assert.match(row('T1').error, /超时/); assert.deepEqual([row('T1').usage.requests, row('T1').usage.input_tokens], [1, 100], '超时的题记下已经花掉的');
    assert.ok(row('T1').estimatedCostUsd > 0);
    assert.match(row('T2').error, /529/); assert.equal(row('T2').usage.input_tokens, 50, '出错的题也记下');
    assert.equal(out.usage.requests, 1 + 1 + 1); assert.equal(out.usage.input_tokens, 160);
    assert.ok(signals.every((x) => x instanceof AbortSignal)); assert.ok(signals[1].aborted, 'T1 挂住的请求被中止了');
    assert.equal(peak, 1, '超时的题停下之后才跑下一题');
    // RESUME：T1、T2 重跑；以前花掉的 150 + 15 token 记进 discardedUsage，费用算在里面
    const again = await runEval({ questions: qs, version: 'v', resumeFile: file, llm: async () => say('【A】好。') });
    assert.deepEqual(again.errors, []);
    assert.deepEqual([again.discardedUsage.requests, again.discardedUsage.input_tokens, again.discardedUsage.output_tokens], [2, 150, 15]);
    assert.equal(again.estimatedCostUsd, costOf('claude-sonnet-5-5', { input_tokens: again.usage.input_tokens + 150, output_tokens: again.usage.output_tokens + 15 }));
    // 再接着跑一次（没有出错的题了），丢掉的用量不会丢
    const third = await runEval({ questions: qs, version: 'v', resumeFile: file, llm: async () => say('【A】好。') });
    assert.equal(third.discardedUsage.input_tokens, 150);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
