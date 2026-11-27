const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');
const { execTool, chat, TOOL_DEFS, systemPrompt } = require('../src/assistant');
const createEngine = require('../src/engine');

const ctxOf = () => { const store = createStore(); const user = store.createUser(); return { user, store, now: '2026-11-26' }; };

test('工具：记录概况后，路线里的下一步跟着变', () => {
  const ctx = ctxOf();
  execTool('update_profile', { status: 'work', entry: '2026-11-18', addr: '2026-11-20', ins: true }, ctx);
  assert.equal(execTool('get_plan', {}, ctx).next.id, '1-1');
  assert.equal(ctx.store.getUser(ctx.user.id).profile.status, 'work', '应当已保存');
});

test('工具：没解锁的任务不能标记完成；日期不合法时不写入', () => {
  const ctx = ctxOf();
  execTool('update_profile', { status: 'work', entry: '2026-11-18', addr: '2026-11-20', ins: true }, ctx);
  assert.throws(() => execTool('mark_done', { id: '2-2' }, ctx), /还没解锁/);
  assert.equal(execTool('mark_done', { id: '1-1' }, ctx).done, '1-1');
  assert.throws(() => execTool('update_profile', { exp: '明年春天' }, ctx));
  assert.throws(() => execTool('add_trip', { out: '2026-05-01', back: '2026-04-01' }, ctx));
});

test('工具：没有用户确认时不能发咨询；摘要带个人编号时拒绝', () => {
  const ctx = ctxOf();
  const p = ctx.store.createProvider({ name: '示例税理士事务所', category: 'zeirishi', licenseNo: '第1号', feeModel: 'fixed_listing' });
  const list = execTool('suggest_providers', { category: 'zeirishi' }, ctx).providers;
  assert.equal(list[0].providerId, p.id);
  assert.throws(() => execTool('create_inquiry', { category: 'zeirishi', providerId: p.id, summary: '想咨询扶养扣除。', confirmed: false }, ctx), /没有确认/);
  assert.throws(() => execTool('create_inquiry', { category: 'zeirishi', providerId: p.id, summary: '编号123456789012', confirmed: true }, ctx), /个人编号/);
  assert.throws(() => execTool('create_inquiry', { category: 'gyosei', providerId: p.id, summary: '想咨询在留更新。', confirmed: true }, ctx), /类别不符/);
  assert.equal(execTool('create_inquiry', { category: 'zeirishi', providerId: p.id, summary: '想咨询扶养扣除。', confirmed: true }, ctx).sentTo, '示例税理士事务所');
});

test('工具：推荐服务类别时不点名某一家', () => {
  const r = execTool('suggest_providers', { category: 'gyosei' }, ctxOf());
  assert.equal(r.regulated, true); assert.match(r.note, /不推荐某一家/); assert.match(r.note, /还没有入驻/);
});

test('提示词：带上节点资料和用户概况；工具定义齐全', () => {
  const s = systemPrompt(createEngine({ now: '2026-11-26' }));
  assert.ok(s.includes('【节点资料】') && s.includes('【用户概况】') && s.includes('4-10 保育所申请'));
  assert.deepEqual(TOOL_DEFS.map((t) => t.name).sort(), ['add_event', 'add_trip', 'create_inquiry', 'get_options', 'get_plan', 'mark_done', 'suggest_providers', 'update_profile']);
});

test('对话循环：模型调用工具，拿到结果后给出带分类的回答', async () => {
  const ctx = ctxOf(); let n = 0; const seen = [];
  const llm = async (body) => { seen.push(body); n++;
    if (n === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_options', input: { topic: 'phone', params: { card: 'no' } } }] };
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '【A】最便宜的是日本通信SIM。' }] }; };
  const r = await chat(ctx, [], '我没有信用卡，电话卡哪个最便宜？', { llm });
  assert.equal(r.category, 'A'); assert.equal(r.text, '最便宜的是日本通信SIM。');
  assert.deepEqual(r.toolCalls.map((t) => [t.name, t.ok]), [['get_options', true]]);
  const toolResult = JSON.parse(seen[1].messages[2].content[0].content);
  assert.match(toolResult.options[0].price, /日元（约/);
});

test('对话循环：工具报错时把错误交回模型，而不是中断', async () => {
  const ctx = ctxOf(); let n = 0;
  const llm = async (body) => { n++;
    if (n === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'mark_done', input: { id: '9-9' } }] };
    assert.equal(body.messages[2].content[0].is_error, true);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: '【B】没有找到这个任务。' }] }; };
  const r = await chat(ctx, [], '9-9办完了', { llm });
  assert.equal(r.toolCalls[0].ok, false); assert.equal(r.category, 'B');
});

test('工具：记录事件后返回由此产生的期限；日期不明确时拒绝', () => {
  const ctx = ctxOf();
  execTool('update_profile', { status: 'work', entry: '2026-01-10', addr: '2026-01-12', ins: true }, ctx);
  assert.throws(() => execTool('add_event', { type: 'job_change', date: '下周一' }, ctx), /先问清楚/);
  const r = execTool('add_event', { type: 'job_change', date: '2026-11-30' }, ctx);
  assert.equal(r.recorded, '换工作或离职'); assert.equal(r.deadlines.length, 1); assert.equal(r.deadlines[0].date, '2026年12月14日');
});
