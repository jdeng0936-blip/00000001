# 一次性移植脚本：把演示页里不碰页面的逻辑抽成 src/engine.js，把节点数据导出为 data/nodes.json。
# 移植完成后以 src/engine.js 为准，不再回到演示页改逻辑。
import re,sys,json,subprocess
s=open(sys.argv[1],encoding='utf-8').read()
lines=s.split('\n'); starts=[i for i,l in enumerate(lines) if re.match(r'(function |var |async function )',l)]+[len(lines)]
keep=[];skip_names={'NODES','EXTRA','KEY','today','toastT','PVNODE','HELLO','errText','dlErr','downloads','FOOT','PHOTO','CT','CTT','sheetText','routeSheet'}
data_chunks=[]
for a,b in zip(starts,starts[1:]):
    c='\n'.join(lines[a:b]); name=re.match(r'(?:async )?(?:function|var) ([\w$]+)',lines[a]).group(1)
    if name in('NODES','EXTRA'): data_chunks.append(c); continue
    if name in skip_names: continue
    if re.search(r'\$\(|\bel\(|document\.|toast\(|render\w*\(|window\.|localStorage|sample\b',c): continue
    keep.append(c)
open('/tmp/_nodes.js','w',encoding='utf-8').write('\n'.join(data_chunks)+'\nprocess.stdout.write(JSON.stringify(NODES,null,1));')
open('data/nodes.json','w',encoding='utf-8').write(subprocess.run(['node','/tmp/_nodes.js'],capture_output=True,text=True,check=True).stdout)
head='''// 在留导航 规则引擎。纯逻辑，不依赖页面和数据库。
// 用法：const eng = createEngine({ profile, done, plan, auth, now })
// 由 tools/port_engine.py 从产品演示移植而来（2026-11-26），此后以本文件为准。
module.exports = function createEngine(state) {
state = state || {};
var NODES = JSON.parse(JSON.stringify(require('../data/nodes.json')));
var P, DONE, DOCS = [], SEL = null, DSEL = null, SNOOZE = {}, PVSEL = null;
function today(){var t=state.now?new Date(state.now):new Date();t.setHours(0,0,0,0);return t}
function save(){}
'''
tail='''
P = Object.assign({}, JSON.parse(JSON.stringify(DEF)), state.profile || {});
DONE = Object.assign({}, state.done || {});
if (state.plan) Object.keys(state.plan).forEach(function(k){ if (k in PL || k === 'subs') PL[k] = state.plan[k]; });
if (state.auth) Object.assign(AUTH, state.auth);
function conv(x){ return typeof x === 'string' ? cny(x) : x }
function options(topic, params){
  if (!PLT.some(function(x){return x[0]===topic})) throw new Error('未知的方案主题：'+topic);
  PL.topic = topic; if (params) Object.keys(params).forEach(function(k){ if (k in PL && k !== 'topic' && k !== 'subs') PL[k] = String(params[k]); });
  return { topic: topic, note: planNote(), options: planOptions().map(function(o){ return Object.assign({}, o, { price: conv(o.price), sub: conv(o.sub), pts: (o.pts||[]).map(conv) }) }) };
}
function plan(){ var R = compute(), nq = nextQuest(R), pg = progress(R); return { profile: profileText(), next: nq ? { id: nq.id, title: nq.t } : null, level: pg.level, done: pg.done, total: pg.total, tasks: planData() } }
return { NODES: NODES, DEF: DEF, STAGES: STAGES, CATS: CATS, REGULATED: REGULATED, LINKS: LINKS, JOBS: JOBS, CITY: CITY, PLT: PLT, STATUS_NAME: STATUS_NAME, SYS: SYS, RATE: RATE,
  profile: P, compute: compute, progress: progress, nextQuest: nextQuest, plan: plan, reminders: reminders, advice: advice, prCheck: prCheck,
  options: options, hspPoints: function(s){ return hspPoints(Object.assign({}, PL, s||{})) }, kb: kb, profileText: profileText, linksOf: linksOf, jobFit: jobFit, cny: cny, fmt: fmt, isDate: isDate };
};
'''
open('src/engine.js','w',encoding='utf-8').write(head+'\n'.join(keep)+tail)
print(len(keep),'blocks')
