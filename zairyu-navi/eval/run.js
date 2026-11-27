// 跑边界测试题集（npm run eval）。用法和要人复核的地方见 README “用真实模型跑题集”。
// 环境变量：ANTHROPIC_API_KEY（--dry 时不用）、MODEL（默认 claude-sonnet-5-5）、EFFORT（默认 medium）、MAX_TOKENS、
// ONLY=C1,D2 只跑部分题、CONCURRENCY 同时跑几题（默认 4）、QUESTION_TIMEOUT_MS 每题的时限（默认 300000）、
// RESUME=结果文件 跳过文件里已经跑过（没出错）的题、结果写回这个文件（文件里的模型、effort、max_tokens、提示词版本、是否试跑和这次不一样时不跑，退出码 2）、OUT=结果文件 指定写到哪里。
// --dry：不联网，用假的模型把整套流程跑一遍（给 CI 用），结果默认写到系统临时目录。
// 程序只比对回答第一行的分类标记；“判定要点”（criteria）要由人逐条复核，结果里的 criteriaOk 留空（null）等人填。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');
const { chat, anthropicLLM, llmConfig, abortError, newUsage } = require('../src/assistant');

// 每百万 token 的价格（美元）。不在表里的模型不估算费用。缓存的价格只在请求用了提示缓存时才有用（现在没用）。
const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }
};
function costOf(model, u) {
  const p = PRICES[model];
  if (!p || !u) return null;
  const usd = ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output + (u.cache_creation_input_tokens || 0) * p.cacheWrite + (u.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
const ZERO = newUsage;
const addTo = (s, u) => { for (const k of Object.keys(s)) s[k] += (u && u[k]) || 0; return s; };
const sumUsage = (rows) => rows.reduce((s, r) => addTo(s, r.usage), ZERO());

// 假的模型（--dry 和测试用）：按题目找到期望的分类，先调一次 get_plan 走一遍工具循环，再带思考块回答“【期望】……”。
function dryLLM(questions) {
  const byText = new Map(questions.map((q) => [q.question, q]));
  return async (body) => {
    const ms = body.messages, firstUser = ms.filter((m) => m.role === 'user' && typeof m.content === 'string').pop();
    const q = firstUser && byText.get(firstUser.content);
    const usage = { input_tokens: 1000, output_tokens: 100 };
    if (ms[ms.length - 1].content === (firstUser && firstUser.content)) return { stop_reason: 'tool_use', usage, content: [{ type: 'thinking', thinking: '', signature: 'dry' }, { type: 'tool_use', id: 'dry1', name: 'get_plan', input: {} }] };
    return { stop_reason: 'end_turn', usage, content: [{ type: 'thinking', thinking: '', signature: 'dry' }, { type: 'text', text: '【' + (q ? q.expect : 'A') + '】（试跑，不是模型的回答）' }] };
  };
}

// 原子地写 JSON（先写临时文件再改名），中途被打断也不会留下半个文件
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

// usage 是 rows 里每题用量的合计；discardedUsage 是 RESUME 时丢掉的出错的题以前花掉的（每次 RESUME 累加，不会丢）。
// estimatedCostUsd 按两者之和算，是这个结果文件一共花了多少。
function summarize(meta, rows) {
  const must = rows.filter((x) => x.mustPass), usage = sumUsage(rows), discarded = meta.discardedUsage || ZERO();
  const cost = costOf(meta.model, addTo(addTo(ZERO(), usage), discarded));
  const ids = (f) => rows.filter(f).map((x) => x.id);
  return Object.assign({}, meta, {
    total: rows.length, classCorrect: rows.filter((x) => x.classOk).length, mustPassTotal: must.length, mustPassClassCorrect: must.filter((x) => x.classOk).length,
    failingMustPass: ids((x) => x.mustPass && !x.classOk), failing: ids((x) => !x.classOk), refusals: ids((x) => x.stopReason === 'refusal'), truncated: ids((x) => x.stopReason === 'max_tokens'),
    errors: ids((x) => x.error), criteriaPending: ids((x) => x.criteriaOk == null), criteriaFailed: ids((x) => x.criteriaOk === false),
    usage, discardedUsage: discarded, estimatedCostUsd: cost, rows
  });
}

// 跑题。opts：{ questions, version, llm, model, effort, maxTokens, only（Set）, concurrency, timeoutMs, outFile, resumeFile, log, now（固定的“今天”） }
// 返回写进结果文件的对象。
async function runEval(opts) {
  const log = opts.log || (() => {});
  const cfg = llmConfig({}, { model: opts.model, effort: opts.effort, maxTokens: opts.maxTokens });
  const outFile = opts.resumeFile || opts.outFile;
  let rows = [];
  const discardedUsage = ZERO();
  if (opts.resumeFile && fs.existsSync(opts.resumeFile)) {
    const old = JSON.parse(fs.readFileSync(opts.resumeFile, 'utf8'));
    // 设置不一样的结果不能接着跑：混在一起的行会被当成同一个模型、同一版提示词的结果，费用也会按现在的模型重新算
    const now = { model: cfg.model, effort: cfg.effort, maxTokens: cfg.maxTokens, promptVersion: opts.version, dry: !!opts.dry };
    const diff = Object.keys(now).filter((k) => old[k] !== now[k]);
    if (diff.length) throw Object.assign(new Error('RESUME 的结果文件和这次的设置不一样（' + diff.map((k) => k + '：文件里是 ' + JSON.stringify(old[k]) + '，这次是 ' + JSON.stringify(now[k])).join('；') + '），不能接着跑。换一个 OUT 重新跑，或者用和文件一样的设置'), { code: 'RESUME_MISMATCH' });
    // 出错的题重跑；跑过的保留（包括人已经填好的 criteriaOk）。丢掉的出错的题花掉的用量记进 discardedUsage
    rows = (old.rows || []).filter((r) => !r.error);
    addTo(discardedUsage, old.discardedUsage);
    for (const r of old.rows || []) if (r.error) addTo(discardedUsage, r.usage);
  }
  const done = new Set(rows.map((r) => r.id));
  const todo = opts.questions.filter((q) => (!opts.only || opts.only.has(q.id)) && !done.has(q.id));
  if (done.size) log('接着上次的结果：跳过已经跑过的 ' + done.size + ' 题，还要跑 ' + todo.length + ' 题');
  const meta = { model: cfg.model, effort: cfg.effort, maxTokens: cfg.maxTokens, promptVersion: opts.version, dry: !!opts.dry, ranAt: new Date().toISOString(), discardedUsage };
  const order = new Map(opts.questions.map((q, i) => [q.id, i]));
  const save = () => { if (outFile) writeJson(outFile, summarize(meta, rows.slice().sort((a, b) => order.get(a.id) - order.get(b.id)))); };

  async function one(q) {
    const store = createStore(); const user = store.createUser();
    // 固定的测试用户：刚到大阪的就职者
    Object.assign(user.profile, { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-11-20', ins: true });
    const t0 = Date.now();
    // 超时就中止：正在发的请求和它的重试都停下（anthropicLLM 收到 signal），不再发新的请求、不执行工具。
    // chat 收到中止会马上抛出，所以等它结束才关库、才跑下一题，同时在跑的题不会超过 concurrency。
    // 用量记在 usage 里：出错、超时的题也记下已经花掉的（超时时被中断的那一次请求没有响应，接口有没有计费不知道，不算在里面）。
    const ac = new AbortController(), usage = ZERO(), ms = opts.timeoutMs || 300000;
    const timer = setTimeout(() => ac.abort(Object.assign(abortError('timeout'), { message: '超时（' + ms + ' 毫秒）' })), ms);
    let r;
    try {
      r = await chat({ user, store, now: opts.now || opts.version }, [], q.question, { llm: opts.llm, model: cfg.model, effort: cfg.effort, maxTokens: cfg.maxTokens, signal: ac.signal, usage });
    } catch (e) {
      const why = ac.signal.aborted ? '超时（' + ms + ' 毫秒）' : String(e && e.message || e);
      r = { text: '', category: null, toolCalls: [], stopReason: null, refusal: null, usage: usage.requests ? usage : null, error: why.slice(0, 300) };
    }
    clearTimeout(timer);
    try { store.close(); } catch (e) { /* 已经关了 */ }
    const classOk = !r.error && r.category === q.expect;
    const row = { id: q.id, question: q.question, expect: q.expect, got: r.category, classOk, mustPass: !!q.mustPass, criteria: q.criteria, criteriaOk: null,
      tools: r.toolCalls.map((t) => t.name + (t.ok ? '' : '(失败)')), answer: r.text, stopReason: r.stopReason || null, refusal: r.refusal || null,
      usage: r.usage || null, estimatedCostUsd: costOf(cfg.model, r.usage), durationMs: Date.now() - t0, error: r.error || null };
    rows.push(row); save();
    log((classOk ? '对 ' : '错 ') + q.id + ' 期望' + q.expect + ' 得到' + row.got + (row.stopReason === 'refusal' ? '（拒答）' : row.stopReason === 'max_tokens' ? '（被截断）' : '') + (row.error ? '（出错：' + row.error + '）' : ''));
  }
  // 同时最多跑 concurrency 题
  const queue = todo.slice(), n = Math.max(1, Math.min(opts.concurrency || 4, queue.length || 1));
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await one(queue.shift()); }));
  save();
  return summarize(meta, rows.slice().sort((a, b) => order.get(a.id) - order.get(b.id)));
}

function report(out, file, log) {
  log('\n分类正确 ' + out.classCorrect + '/' + out.total + '；必须通过的题 ' + out.mustPassClassCorrect + '/' + out.mustPassTotal + '。');
  log(out.failingMustPass.length ? '没通过的必须通过的题：' + out.failingMustPass.join('、') : '必须通过的题分类全部正确。');
  if (out.refusals.length) log('拒答（stop_reason refusal）：' + out.refusals.join('、'));
  if (out.truncated.length) log('被截断（max_tokens）：' + out.truncated.join('、'));
  if (out.errors.length) log('出错的题：' + out.errors.join('、') + '（用 RESUME 指向结果文件可以只重跑这些）');
  const u = out.usage;
  const d = out.discardedUsage;
  log('用量：' + u.requests + ' 次请求，输入 ' + u.input_tokens + ' token，输出 ' + u.output_tokens + ' token（含思考）' + (d && d.requests ? '；另有以前出错后重跑、丢掉的 ' + d.requests + ' 次请求（输入 ' + d.input_tokens + '、输出 ' + d.output_tokens + ' token），费用算在里面' : '') + '；' + (out.estimatedCostUsd == null ? '模型 ' + out.model + ' 不在价目表里，不估算费用' : '估算费用 ' + out.estimatedCostUsd.toFixed(4) + ' 美元'));
  if (file) log('结果已存到 ' + file);
  log('下一步：打开结果文件，逐条按 criteria 复核 answer，把 criteriaOk 填成 true 或 false（还没复核的 ' + out.criteriaPending.length + ' 题）。');
}

module.exports = { runEval, dryLLM, costOf, summarize, PRICES };

if (require.main === module) {
  (async () => {
    const dry = process.argv.includes('--dry');
    if (!dry && !process.env.ANTHROPIC_API_KEY) { console.error('缺少 ANTHROPIC_API_KEY，不能跑题（不联网试跑用 npm run eval -- --dry）。'); process.exit(2); }
    const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
    let cfg;
    try { cfg = llmConfig(process.env); } catch (e) { console.error(e.message); process.exit(2); }
    const num = (k, d) => { const v = process.env[k]; if (v == null || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < 1) { console.error(k + ' 须为正整数'); process.exit(2); } return n; };
    const date = new Date().toISOString().slice(0, 10);
    const outFile = process.env.RESUME ? null : process.env.OUT || (dry ? path.join(os.tmpdir(), `zairyu-eval-dry_${set.version}_${date}_${process.pid}.json`) : path.join(__dirname, 'results', `${set.version}_${cfg.model}_${cfg.effort}_${date}.json`));
    const out = await runEval({
      questions: set.questions, version: set.version, dry, model: cfg.model, effort: cfg.effort, maxTokens: cfg.maxTokens,
      llm: dry ? dryLLM(set.questions) : anthropicLLM(process.env.ANTHROPIC_API_KEY),
      only: process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null,
      concurrency: num('CONCURRENCY', 4), timeoutMs: num('QUESTION_TIMEOUT_MS', 300000),
      outFile, resumeFile: process.env.RESUME || null, log: (m) => console.log(m)
    });
    report(out, process.env.RESUME || outFile, (m) => console.log(m));
    process.exit(out.failingMustPass.length ? 1 : 0);
  })().catch((e) => { console.error('跑题出错：' + (e && e.message || e)); process.exit(2); });
}
