// 跑边界测试题集。需要环境变量 ANTHROPIC_API_KEY；可用 MODEL 指定模型，ONLY=C1,D2 只跑部分题。
// 程序只比对回答第一行的分类标记；“判定要点”要由人逐条复核，结果文件里留了空栏。
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../src/store');
const { chat, anthropicLLM } = require('../src/assistant');

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) { console.error('缺少 ANTHROPIC_API_KEY，不能跑题。'); process.exit(2); }
  const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
  const llm = anthropicLLM(process.env.ANTHROPIC_API_KEY);
  const model = process.env.MODEL || 'claude-sonnet-5-5';
  const rows = [];
  for (const q of set.questions) {
    if (only && !only.has(q.id)) continue;
    const store = createStore(); const user = store.createUser();
    // 固定的测试用户：刚到大阪的就职者
    Object.assign(user.profile, { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-11-20', ins: true });
    let r; try { r = await chat({ user, store, now: set.version }, [], q.question, { llm, model }); } catch (e) { r = { text: '', category: null, toolCalls: [], error: e.message }; }
    const classOk = r.category === q.expect;
    rows.push({ id: q.id, question: q.question, expect: q.expect, got: r.category, classOk, mustPass: q.mustPass, criteria: q.criteria, criteriaOk: null, tools: r.toolCalls.map((t) => t.name + (t.ok ? '' : '(失败)')), answer: r.text, error: r.error || null });
    console.log((classOk ? '对 ' : '错 ') + q.id + ' 期望' + q.expect + ' 得到' + r.category);
    store.close();
  }
  const must = rows.filter((x) => x.mustPass), wrong = rows.filter((x) => !x.classOk);
  const out = { model, promptVersion: set.version, ranAt: new Date().toISOString(), total: rows.length, classCorrect: rows.length - wrong.length, mustPassTotal: must.length, mustPassClassCorrect: must.filter((x) => x.classOk).length, rows };
  const file = path.join(__dirname, 'results', `${set.version}_${model}_${out.ranAt.slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`\n分类正确 ${out.classCorrect}/${out.total}；必须通过的题 ${out.mustPassClassCorrect}/${out.mustPassTotal}。结果已存到 ${file}`);
  console.log('下一步：打开结果文件，逐条按 criteria 复核 answer，把 criteriaOk 填成 true 或 false。');
  process.exit(must.every((x) => x.classOk) ? 0 : 1);
})();
