// 不用 API、由订阅里的 Claude 代替模型跑题集时用的辅助脚本（近似结果，不能代替 npm run eval）。
// 用法：
//   node eval/sub.js setup <目录>                 写出 system.txt（和 npm run eval 同样的测试用户、同样的“今天”）和 tools.json
//   node eval/sub.js tool <目录> <题号> <工具名> '<JSON 参数>'
//                                                 用这道题自己的库执行一次工具，打印工具结果（和真实跑题时模型看到的一样）
// 每道题一个库文件（<目录>/<题号>.db），题与题之间互不影响。
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../src/store');
const createEngine = require('../src/engine');
const { TOOL_DEFS, systemPrompt, execTool } = require('../src/assistant');

const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const NOW = set.version;
const PROFILE = { status: 'work', entry: '2026-11-18', addr: '2026-11-20', exp: '2027-11-20', ins: true };

function open(dir, qid) {
  if (!/^[A-Za-z0-9_-]+$/.test(qid)) throw new Error('题号不对：' + qid);
  const store = createStore(path.join(dir, qid + '.db'));
  const idFile = path.join(dir, qid + '.id');
  let user = fs.existsSync(idFile) ? store.getUser(fs.readFileSync(idFile, 'utf8').trim()) : null;
  if (!user) {
    user = store.createUser();
    Object.assign(user.profile, PROFILE);
    store.saveUser(user, 'eval.setup');
    fs.writeFileSync(idFile, user.id);
  }
  return { store, user };
}

const [cmd, dir, ...rest] = process.argv.slice(2);
if (!cmd || !dir) { console.error('用法见文件开头的说明'); process.exit(2); }
fs.mkdirSync(dir, { recursive: true });
if (cmd === 'setup') {
  const store = createStore(); const user = store.createUser(); Object.assign(user.profile, PROFILE);
  const eng = createEngine({ profile: user.profile, done: user.done, plan: user.plan, auth: user.auth, events: [], now: NOW });
  fs.writeFileSync(path.join(dir, 'system.txt'), systemPrompt(eng, NOW));
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(TOOL_DEFS, null, 1));
  console.log('已写出 ' + path.join(dir, 'system.txt') + ' 和 tools.json；今天按 ' + NOW + ' 算');
} else if (cmd === 'tool') {
  const [qid, name, json] = rest;
  let input; try { input = JSON.parse(json || '{}'); } catch { console.log(JSON.stringify({ error: '参数不是合法的 JSON' })); process.exit(0); }
  const ctx = open(dir, qid);
  try { console.log(JSON.stringify(execTool(name, input, { user: ctx.user, store: ctx.store, now: NOW }), null, 1)); }
  catch (e) { console.log(JSON.stringify({ error: e.message })); }
  ctx.store.close();
} else { console.error('不认识的命令：' + cmd); process.exit(2); }
