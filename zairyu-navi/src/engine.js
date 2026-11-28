// 在留导航 规则引擎。纯逻辑，不依赖页面和数据库。
// 用法：const eng = createEngine({ profile, done, plan, auth, now })
// 由 tools/port_engine.py 从产品演示移植而来（2026-11-26），此后以本文件为准。
module.exports = function createEngine(state) {
state = state || {};
// 节点数据按上线规则处理后再用（见 launchView）；原始数据在 data/nodes.json。
var NODES = JSON.parse(JSON.stringify(require('../data/nodes.json'))).map(launchView);
var P, DONE, DOCS = [], SEL = null, DSEL = null, SNOOZE = {}, PVSEL = null;
// 日期一律按日本时间（Asia/Tokyo）的日历日计算，内部用 UTC 零点的 Date 表示，和服务器、浏览器所在时区无关。
function jstDay(t){return new Date(Math.floor((t.getTime()+324e5)/864e5)*864e5)}
function today(){var t=state.now?new Date(state.now):new Date();return jstDay(isNaN(t.getTime())?new Date():t)}
function save(){}
var STAGES=["来日前","落地","生活基建","驾照","在留维持","永驻"];
var TITLES=["准备出发","新到大阪","落地生根","生活上手","可以上路","稳定在留","永驻达成"];
var LEGAL={"1-1":1,"1-3":1,"4-1":1,"4-2":1};
function xpOf(id){return LEGAL[id]?30:20}

var DEF={status:"work",entry:"2026-11-18",addr:"2026-11-20",exp:"2027-11-20",ins:true,age:true,lic:true,pr:true,
  arrive:"2019-04-01",work:"2021-04-01",hsp:"0",jp:"n2",pay:true,married:"",trips:[["2024-01-10","2024-02-20"],["2025-08-01","2025-08-21"]]};
function D(s){return isDate(s)?new Date(s+"T00:00:00Z"):null}
function ymd(y,m,d){return new Date(Date.UTC(y,m,d))}
function iso(d){return d.toISOString().slice(0,10)}
function addDays(d,n){return d?new Date(d.getTime()+n*864e5):null}
function addMonths(d,n){if(!d)return null;var m=d.getUTCMonth()+n,x=ymd(d.getUTCFullYear(),m,d.getUTCDate());if(x.getUTCMonth()!==((m%12)+12)%12)x=ymd(d.getUTCFullYear(),m+1,0);return x}
function addYears(d,n){return addMonths(d,n*12)}
function fmt(d){var x=new Date(d.getTime()+324e5);return x.getUTCFullYear()+"年"+(x.getUTCMonth()+1)+"月"+x.getUTCDate()+"日"}
function days(a,b){return Math.round((b-a)/864e5)}
function yearsBetween(a,b){if(!a||!b||b<a)return 0;var n=b.getUTCFullYear()-a.getUTCFullYear();if(addYears(a,n)>b)n--;var s=addYears(a,n);return n+days(s,b)/days(s,addYears(a,n+1))}
function y1(y){return (Math.floor(y*10+1e-9)/10).toFixed(1)}
function dueText(d){if(!d)return"";var n=days(today(),d);return n<0?"已过期限 "+fmt(d):"还有"+n+"天（"+fmt(d)+"）"}
function launchView(n){
  // 上线规则（docs/compliance-review.md 第二节）。r[2]=0 是待核实；r[3]=1 表示这一行涉及法定期限、罚则或在留资格条件。
  // 1. 待核实又涉及法定期限、罚则、在留资格条件的行，不显示具体数字，只提示看官方链接；
  // 2. 待核实超过一半的节点标 pending，显示“资料整理中”，要点、费用、用时、步骤都不显示，只给官方链接（src）；概要（sum）照常显示，所以概要里不写待核实行的内容（test/engine.test.js 查）。
  var v=JSON.parse(JSON.stringify(n)),un=v.rows.filter(function(r){return !r[2]}).length;
  v.rows=v.rows.map(function(r){return !r[2]&&r[3]&&/[0-9０-９]/.test(r[1])?[r[0],"待核实：涉及法定期限、罚则或在留资格条件，核实前不显示具体数字，请看官方链接",0,1]:r});
  if(un*2>v.rows.length){v.pending=1;v.rows=[];v.cost="资料整理中";v.time="资料整理中";v.steps=["资料整理中：步骤还没对照官方页面核实，请看官方链接"]}
  return v;
}
function nodeOf(id){return NODES.filter(function(x){return x.id===id})[0]}
function compute(){
  var s=P.status, card=s!=="none"&&s!=="short", reg=!!DONE["1-1"], R={};
  function set(id,state,note,due){R[id]={state:state,note:note||"",due:due||null}}
  NODES.forEach(function(n){
    var id=n.id;
    if(n.s===0){card?set(id,"na","已过此阶段"):set(id,"todo");return}
    if(!card){set(id,"locked","拿到在留卡后解锁");return}
    var need=function(ok,why){ok?set(id,"todo"):set(id,"locked",why)};
    if(id==="1-1")set(id,"todo","",addDays(D(P.addr),14));
    else if(id==="1-2")need(reg,"先完成住民登记");
    else if(id==="1-3")P.ins?set(id,"na","已在公司加入社保"):(reg?set(id,"todo","",addDays(D(P.addr),14)):set(id,"locked","先完成住民登记"));
    else if(id==="1-4")(!P.age||P.ins)?set(id,"na",P.ins?"已加入厚生年金":"不在20至59岁"):need(reg,"先完成住民登记");
    else if(id==="2-1")set(id,"todo");
    else if(id==="2-2")need(reg,"先完成住民登记");
    else if(id==="2-3")need(!!DONE["2-2"],"先办电话卡");
    else if(id==="2-4")need(!!DONE["2-3"],"先办银行卡");
    else if(id==="3-1")P.lic?need(reg,"先完成住民登记"):set(id,"na","没有符合条件的驾照");
    else if(id==="3-2")P.lic?set(id,"na","可走外免切替"):need(reg,"先完成住民登记");
    else if(id==="4-1")s==="pr"?set(id,"na","永住者无需更新在留期间"):set(id,"todo","",D(P.exp));
    else if(id==="4-2")(s==="work"||s==="hsp"||s==="student"||s==="ssw"||s==="biz")?set(id,"todo","换工作、离职、毕业时办"):s==="spouse"?set(id,"todo","离婚或配偶去世时，14天内向入管申报"):s==="family"?set(id,"todo","如果你是以配偶身份持有家族滞在：离婚或配偶去世时，14天内向入管申报"):set(id,"na","当前身份无此申报");
    else if(id==="4-3"||id==="5-1"||id==="5-2")(P.pr&&s!=="pr")?set(id,"todo"):set(id,"na",s==="pr"?"已是永住者":"未设永驻目标");
    else if(id==="4-4")set(id,"todo","每年6月前后确认");
    else if(id==="4-5")set(id,"todo","每年11月至次年3月");
    else if(id==="4-6")set(id,"todo","需要汇款时办");
    else if(id==="4-7")set(id,"todo","生病时用");
    else if(id==="4-9")set(id,"todo","回国或长期离开时办");
    else if(id==="4-8")set(id,"todo","有孩子时办");
    else if(id==="4-10")set(id,"todo","孩子没上小学、父母都工作时办");
    else if(id==="5-3")s==="pr"?set(id,"todo"):set(id,"locked","取得永驻后适用");
  });
  Object.keys(R).forEach(function(id){if(DONE[id]&&R[id].state==="todo")R[id]={state:"done",note:"已完成",due:null}});
  return R;
}
function progress(R){
  var app=NODES.filter(function(n){return R[n.id].state!=="na"}),xp=0,max=0,done=0,clear=[];
  app.forEach(function(n){max+=xpOf(n.id);if(R[n.id].state==="done"){xp+=xpOf(n.id);done++}});
  STAGES.forEach(function(_,i){var ns=app.filter(function(n){return n.s===i});clear.push(ns.length>0&&ns.every(function(n){return R[n.id].state==="done"}))});
  return {xp:xp,max:max,done:done,total:app.length,clear:clear,level:clear.filter(Boolean).length+1};
}
function nextQuest(R){
  var t=NODES.filter(function(n){return R[n.id].state==="todo"&&n.id!=="4-2"&&n.id!=="4-4"&&n.id!=="4-5"&&n.id!=="4-6"&&n.id!=="4-7"&&n.id!=="4-8"&&n.id!=="4-9"&&n.id!=="4-10"});
  t.sort(function(a,b){var x=R[a.id].due,y=R[b.id].due;if(x&&y)return x-y;if(x&&days(today(),x)<60)return -1;if(y&&days(today(),y)<60)return 1;return a.s-b.s||NODES.indexOf(a)-NODES.indexOf(b)});
  return t[0]||null;
}
var EVENTS=[];
// mail、msrc：提醒邮件里用的说明和依据。邮件要经过邮件服务商，写法不分在留资格（从文字和链接看不出收件人是哪一种）；没有 mail 的规则，txt 本身就不分在留资格。
var JOB_MAIL="工作、学校等所属机关有变动（离开或加入）：自变动之日起14天内，向入管提交所属机关的届出（契约机关或活动机关，按自己的情况交其中一种）；离开和加入各申报一次，各有14天";
var JOB_MSRC={law:"入管法第19条の16",title:"入管厅：所属（契约）机关届出",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00015.html",more:[{title:"入管厅：所属（活动）机关届出",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00014.html"}]};
var EVRULES={job_change:["换工作或离职",[
  {n:14,st:{work:1,ssw:1},mail:JOB_MAIL,msrc:JOB_MSRC,txt:"换工作或离职：自离职（合同结束）或入职（签新合同）之日起14天内，向入管提交所属机关（契约机关）的届出；离职和入职各申报一次，各有14天（见任务“工作、学校、婚姻变动后向入管申报”）",src:{law:"入管法第19条の16第2号",title:"入管厅：所属（契约）机关届出",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00015.html"}},
  {n:14,st:{student:1,biz:1},mail:JOB_MAIL,msrc:JOB_MSRC,txt:"离开或转到别的学校、机构：自离开（退学、毕业、离任）或转入之日起14天内，向入管提交所属机关（活动机关）的届出；离开和转入各申报一次，各有14天（见任务“工作、学校、婚姻变动后向入管申报”）",src:{law:"入管法第19条の16第1号",title:"入管厅：所属（活动）机关届出",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00014.html"}},
  {n:14,st:{hsp:1},mail:JOB_MAIL,msrc:JOB_MSRC,txt:"换工作或离职：自离职或入职之日起14天内，向入管提交所属机关的届出；高度专门职1号イ、ロ交契约机关的届出，1号ハ交活动机关的届出，离职和入职各申报一次（见任务“工作、学校、婚姻变动后向入管申报”）",src:{law:"入管法第19条の16第1号・第2号",title:"入管厅：所属（契约）机关届出",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00015.html",more:[{title:"入管厅：所属（活动）机关届出（1号ハ）",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00014.html"}]}}]],
 move:["搬家",[
  {n:14,txt:"搬家：搬进新住址后14天内，带在留卡到新住址的区役所办转入或转居，在留卡上的住址当场一并变更（搬到别的市区町村的，先在原住址办转出）",src:{law:"入管法第19条の9第1項",title:"入管厅：住居地的变更届出",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00023.html"}}]],
 divorce:["离婚或配偶去世",[
  {n:14,st:{spouse:1,family:1},txt:"离婚或配偶去世：14天内向入管提交配偶者的届出",alt:{family:"如果你是以配偶身份持有家族滞在：离婚或配偶去世后14天内向入管提交配偶者的届出（以子女身份持有的没有这项届出）"},mail:"离婚或配偶去世：14天内向入管提交配偶者的届出（以配偶身份在留的人要办）",src:{law:"入管法第19条の16第3号",title:"入管厅：配偶者的届出",url:"https://www.moj.go.jp/isa/applications/procedures/nyuukokukanri10_00016.html"}}]],
 birth:["孩子出生",[
  {n:13,any:1,txt:"孩子出生：14天内到区役所办出生届，出生当天算第1天",src:{law:"戸籍法第49条",title:"法务省：出生届",url:"https://www.moj.go.jp/ONLINE/FAMILYREGISTER/5-1.html"}},
  {n:30,any:1,txt:"孩子出生：30天内向入管申请在留资格取得（孩子有日本国籍的、出生后60天内离开日本的不用办）",src:{law:"入管法第22条の2・第22条の3",title:"入管厅：在留资格取得许可申请",url:"https://www.moj.go.jp/isa/applications/procedures/16-10.html"}}]]};
// 一件事按当前身份产生的期限。尚无签证（人在中国）的没有；短期滞在的只有标了 any 的规则（孩子在日本出生：出生届不看在留资格）。
function evDue(ev){
  var r=Object.prototype.hasOwnProperty.call(EVRULES,ev.type)?EVRULES[ev.type]:null,d=D(ev.date),s=P.status,out=[];
  if(!r||!d||s==="none")return out;
  r[1].forEach(function(x){if(s==="short"?!x.any:(x.st&&!x.st[s]))return;out.push({d:addDays(d,x.n),txt:(x.alt&&x.alt[s])||x.txt,src:x.src,mail:x.mail||null,msrc:x.msrc||null})});
  return out;
}
function reminders(){
  var R=compute(),L=[],t=today(),Y=t.getUTCFullYear(),M=t.getUTCMonth(),card=P.status!=="none"&&P.status!=="short";
  // x：{dl:1 是真正的期限（其余是该留意、该开始准备的日子）, mail, msrc 提醒邮件里用的不分在留资格的说明和依据}
  function add(d,txt,tag,src,x){if(d&&!isNaN(d.getTime()))L.push({d:d,date:iso(d),txt:txt,tag:tag||"",src:src||null,dl:!!(x&&x.dl),mail:(x&&x.mail)||null,msrc:(x&&x.msrc)||null})}
  function evs(){EVENTS.forEach(function(ev){evDue(ev).forEach(function(x){add(x.d,x.txt,"事件",x.src,{dl:1,mail:x.mail,msrc:x.msrc})})})}
  if(!card){add(t,"先完成第0关：选定路线并申请在留资格认定证明书","路线");evs();L.sort(function(a,b){return a.d-b.d});return L}
  if(R["1-1"].state==="todo")add(R["1-1"].due,"住民登记：定下住所后14天内到区役所办理","法定期限",null,{dl:1});
  if(R["1-3"].state==="todo")add(R["1-3"].due,"国民健康保险：成为对象后14天内加入","法定期限",null,{dl:1});
  if(R["4-1"].state==="todo"&&D(P.exp)){var e=D(P.exp);[[4,"在留更新：开始准备材料"],[3,"在留更新：确认可以开始申请的时期"],[1,"在留更新：尽快递交"]].forEach(function(x){add(addMonths(e,-x[0]),x[1],"在留")});add(e,"在留期满日","在留",null,{dl:1})}
  if(P.entry)add(addMonths(D(P.entry),6),"入境满6个月：去银行办理账户的居住者变更","银行");
  if(R["1-4"].state==="todo"||R["1-4"].state==="done")add(ymd(Y,M+1,1),"国民年金：本月保险料缴纳","每月");
  var june=ymd(Y,5,1);if(june<t)june=ymd(Y+1,5,1);
  if(!P.ins)add(june,"住民税：6月前后收到缴款单，按期缴纳并保存收据","每年");
  var nov=ymd(Y,10,1);if(nov<t)nov=ymd(Y+1,10,1);
  add(nov,"年末调整：按公司通知提交扶养控除等申告书；有海外扶养亲属的备齐亲属关系文件和汇款凭证","每年");
  if(M>=10)add(t,"现在是年末调整的时期：公司发来的申告书请按期交回，12月的工资里会结算全年所得税","每年");
  var kk=ymd(Y,2,15);if(kk<t)kk=ymd(Y+1,2,15);
  add(kk,"确定申告截止（需要申告的人）：2月16日起受理，纳税期限同日","每年",null,{dl:1});
  if(P.pr&&P.status!=="pr")add(t,"永驻目标：每次缴纳住民税和年金后拍照存档收据","习惯");
  if(AUTH.mail){add(addDays(t,9),"示例：邮箱里识别到国民健康保险料纳付通知，纳期限已提取"+(AUTH.cal?"，已写入日历":""),"邮箱示例");add(addDays(t,3),"示例：运营商账单邮件，本月金额已记入，待你确认是否换套餐","邮箱示例")}
  PLT.forEach(function(x){if(PL.subs[x[0]])add(t,"已订阅“"+x[1]+"”的方案变动提醒：正式版每天联网复核，价格或条件变化时推送","方案")});
  evs();
  L.sort(function(a,b){return a.d-b.d});return L;
}
/* ---------- 咨询价值：给你的判断 ---------- */
function advice(){
  var out=[],t=today(),R=compute();
  var rs=reminders().filter(function(x){return !/示例|订阅/.test(x.txt)});
  var nq0=nextQuest(R),r0=nq0?R[nq0.id]:null;
  if(nq0&&r0.due){var n0=days(t,r0.due);out.push(["最要紧的一件",nq0.t+"，法定期限 "+fmt(r0.due)+"（"+(n0<0?"已过 "+(-n0)+" 天":n0===0?"今天":"还有 "+n0+" 天")+"）。费用："+cny(nq0.cost)+"。","#reminders","看全部提醒"])}
  else if(nq0)out.push(["现在该办的一件",nq0.t+"，没有法定期限。费用："+cny(nq0.cost)+"。","#reminders","看全部提醒"]);
  else if(rs.length){var x=rs[0];out.push(["接下来要留意",x.txt,"#reminders","看全部提醒"])}
  if(P.pr&&P.status!=="pr"){var pc=prCheck(),e=pc.when;
    if(!D(P.arrive))out.push(["永驻最早什么时候","填上来日日期，就能算出最早哪天满足在留年数。","#pr-check","去填写"]);
    else if(e)out.push(["永驻最早什么时候",e<=t?"年数条件已满（在留 "+pc.needY+" 年等），可以做一次完整体检，逐项确认其他条件。":"按年数条件算，最早 "+fmt(e)+" 满足（在留 "+pc.needY+" 年等），还有 "+days(t,e)+" 天。纳税、年金和出国天数从现在起就在算。","#pr-check","做永驻体检"]);
    else out.push(["永驻最早什么时候",pc.why,"#pr-check","做永驻体检"])}
  var po=phoneOptions(),ph=po[0];if(PL.card==="no"){var ok=po.filter(function(o){return o.pts.indexOf("没有信用卡也能办")>=0})[0];if(ok)ph=ok}
  if(R["2-1"]&&R["2-1"].state!=="done"&&R["2-1"].state!=="na")out.push(["电话卡怎么选最省",(PL.card==="no"?"没有日本信用卡、":"")+"每月约 "+{"3":"3GB","10":"10GB","30":"30GB","max":"不限量"}[PL.usage]+" 的话，"+(PL.card==="no"?"确认能办的里面最便宜的是 ":"月费最低的是 ")+ph.name+"，"+cny(ph.price)+"。","#plans","比较全部方案"]);
  else out.push(["花钱的事怎么选","电话卡、驾照、开公司都已按你的情况排好方案和费用。","#plans","比较全部方案"]);
  return out;
}
function packText(){
  var R=compute(),dn=NODES.filter(function(n){return R[n.id].state==="done"}).map(function(n){return n.t}),nq=nextQuest(R);
  return "身份："+(STATUS_NAME[P.status]||"未填")+"\n入境日："+(P.entry||"未填")+"　在留期满日："+(P.exp||"未填")+"\n已办完："+(dn.length?dn.join("、"):"无")+"\n正在办："+(nq?nq.t:"无")+"\n可提供的资料："+(DOCS.length?DOCS.slice(0,5).map(function(d){return d.title}).join("、"):"暂无")+(PVNODE?"\n咨询事项："+linkTitle(PVNODE[0])+"（"+PVNODE[2]+"）\n对方一般会要的资料："+PVNODE[3]+"（以对方给的清单为准）":"")+"\n（不含个人编号和银行账号）";
}
function prCheck(){
  // 高度专门职本身就以70分为前提：积分没填或填了70分以下时按70分算。年数是否达标按周年日判断，和 when 用同一套算法。
  var t=today(),arr=D(P.arrive),wk=D(P.work),sp=P.status==="spouse",hsp=Math.max(+P.hsp||0,P.status==="hsp"?70:0),needY=sp?1:hsp>=80?1:hsp>=70?3:10,out=[],why="";
  var yrs=yearsBetween(arr,t), wy=yearsBetween(wk,t), md=D(P.married), my=yearsBetween(md,t), ssw=P.status==="ssw";
  out.push(["在留年数","需连续"+needY+"年，现"+y1(yrs)+"年"+(arr?"":"（还没填来日日期）")+(P.status==="hsp"&&!(+P.hsp>=70)?"；按高度专门职70分算，80分以上的请把积分选为80分以上":""),arr&&addYears(arr,needY)<=t?"ok":"bad",Math.min(1,yrs/needY)]);
  if(sp)out.push(["婚姻持续年数","需实际持续3年以上，现"+y1(my)+"年"+(md?"":"（还没填结婚日期）")+"；2027年4月1日以后申请的年数可能调整（待核实，资料整理中，以入管厅新指南原文为准）",md&&addYears(md,3)<=t?"ok":"bad",Math.min(1,my/3),1]);
  else if(hsp<70)out.push(["就労或居住资格年数","需连续5年，现"+y1(wy)+"年"+(wk?"":"（还没填开始日期）")+(ssw?"；特定技能1号的年数不算在内":""),ssw?"warn":wk&&addYears(wk,5)<=t?"ok":"bad",Math.min(1,wy/5)]);
  var tenAgo=addYears(t,-10),longest=0,total=0;
  P.trips.forEach(function(x){var a=D(x[0]),b=D(x[1]);if(!a||!b||b<a)return;longest=Math.max(longest,days(a,b));var s=a<tenAgo?tenAgo:a;if(b>s)total+=days(s,b)});
  // 出国天数和日语的标准没有在官方文字里核实（上线规则 1：在留资格条件核实前不显示具体数字）：只写自己的天数，不写标准，出国较长时提示咨询。
  // 下面 183 天、913 天只用来决定要不要提示咨询，不作为标准显示，也不判“不达标”。
  out.push(["单次出国","长期出国可能影响“继续在留”的判断，官方没有公布天数标准；最长一次"+longest+"天",longest<183?"ok":"warn",null,1]);
  out.push(["近10年累计出国","频繁出国可能影响“继续在留”的判断，官方没有公布天数标准；累计"+total+"天",total<913?"ok":"warn",null,1]);
  var jp={n1:["已填 N1","ok"],n2:["已填 N2","ok"],n3:["已填 N3，是否相当要确认","warn"],low:["可能不足","warn"]}[P.jp]||["还没填写","warn"];
  out.push(["日语能力","新指南把日语能力列为考虑要素之一，2027年4月1日以后的申请适用（资料整理中）；"+jp[0],jp[1],null,1]);
  out.push(["税和社保按期缴纳","近5年住民税、近2年年金和医保",P.pay?"ok":"bad",null]);
  // when 只在算得出来的时候给日期：缺日期、特定技能、长期出国时为 null；年数已满但还有不达标的项目时也为 null。原因写在 why 里。
  var when=null;
  if(!arr)why="还没填来日日期，算不出最早时点。";
  else if(sp&&!md)why="还没填结婚日期，算不出最早时点。";
  else if(!sp&&hsp<70&&ssw)why="特定技能1号的年数不算进就劳资格的5年，要先换成其他就劳资格再起算，最早时点属于个别判断，请咨询行政书士。";
  else if(!sp&&hsp<70&&!wk)why="还没填开始持就劳或居住资格的日期，算不出最早时点。";
  else if(longest>=183||total>=913)why="出国时间较长，连续在留的年数可能要重新起算，最早时点属于个别判断，请咨询行政书士。";
  else{when=addYears(arr,needY);if(sp){var m3=addYears(md,3);if(m3>when)when=m3}else if(hsp<70){var w5=addYears(wk,5);if(w5>when)when=w5}
    if(when<=t&&out.some(function(r){return r[2]==="bad"})){when=null;why="年数条件已满，但上面还有不达标的项目，现在还不能按已达到申请条件来看。"}}
  return {rows:out,when:when,whenDate:when?iso(when):"",why:why,needY:needY};
}
var CATS=[["edu","学校和升学服务","学位课程的咨询和报名（含推广）","取得学历、高度人才加分"],["gyosei","行政书士","签证、在留更新和变更、永驻申请的文书制作和取次","COE、在留更新、高度人才、永驻"],["zeirishi","税理士","确定申告、扶养扣除等个别税务咨询","住民税和扶养扣除"],["sharoshi","社会保险劳务士","年金和社保手续","国民年金"],["shiho","司法书士","公司设立登记和变更登记","开公司"],
  ["estate","不动产","面向外国人的租房","租房"],["mobile","电话卡","外国人容易办理的运营商","电话卡"],["school","驾校","外免切替练车和驾校课程","外免切替、上驾校"],["escort","陪同翻译","窗口办事陪同，只做口头翻译，不代填官方文书","住民登记、国保"]];
var REGULATED={gyosei:1,zeirishi:1,sharoshi:1,shiho:1};
var LINKS=[
 ["0-2","gyosei","制作在留资格认定证明书的申请文书并代为递交","护照、学历或雇佣合同、接收方的公司或学校资料"],
 ["1-1","escort","陪你去区役所窗口，口头翻译","在留卡、护照、住址"],
 ["1-3","escort","陪你去国保窗口，口头翻译","在留卡、护照"],
 ["1-4","sharoshi","年金的加入、免除和缓缴申请的咨询","在留卡、年金手册或基础年金号码通知、收入情况"],
 ["2-1","estate","找接受外国人的房源，说明初期费用和保证公司","在留卡、在职或在学证明、预算和希望区域"],
 ["2-2","mobile","按你的在留期限和缴费方式推荐能办的套餐","在留卡、缴费方式"],
 ["2-3","escort","陪你去银行窗口，口头翻译","在留卡、住民票、印章或签名"],
 ["3-1","school","外免切替前的场内练车","中国驾照、译文、预约的考试日期"],
 ["3-1","escort","考场办手续时的口头翻译","预约日期和考场"],
 ["3-2","school","报名和课程安排，说明是否有中文教学","在留卡、住民票、可上课的时间"],
 ["4-1","gyosei","制作在留期间更新的申请文书并代为递交","在留卡、护照、课税和纳税证明、在职证明"],
 ["4-2","gyosei","换工作后的申报和就劳资格证明的咨询","在留卡、新旧公司的资料、离职和入职日期"],
 ["4-2","sharoshi","离职后的社保、年金切换和失业给付的咨询","离职票、在留卡、雇佣保险被保险者证"],
 ["4-3","gyosei","高度人才积分的确认和申请文书","学历、年收证明、职历、日语证书"],
 ["4-4","zeirishi","住民税、扶养扣除的个别判断和申报","源泉征收票、汇款记录、亲属关系证明"],
 ["4-5","zeirishi","确定申告的代理和个别税务判断","源泉征收票、各种控除证明书、汇款凭证、亲属关系文件"],
 ["4-6","zeirishi","汇款涉及的赠与税和扶养扣除的个别判断","汇款记录、亲属关系证明、汇款用途说明"],
 ["4-7","escort","陪你去医院，口头翻译","预约时间、医院、症状的简单说明"],
 ["4-8","escort","陪你去区役所和学校，口头翻译","孩子的年龄、住址、希望入学的时间"],
 ["4-9","gyosei","长期离开时再入国许可和在留资格的个别判断","在留卡、预计离开和回来的日期、离开的原因"],
 ["4-9","sharoshi","脱退一时金的请求，以及退还还是保留年金资格的咨询","基础年金号码、加入记录、回国日期"],
 ["5-1","gyosei","永驻条件的个别判断","在留经历、纳税和年金记录、出国记录"],
 ["5-2","gyosei","制作永驻申请文书并代为递交","课税纳税证明、年金记录、理由书素材、担保人资料"],
 ["5-2","zeirishi","补申报、纳税证明上的问题处理","历年申报和纳税记录"],
 ["deg","edu","学位课程的咨询和报名","最高学历证书、成绩单、工作经历、想读的专业"],
 ["deg","gyosei","学历是否满足要件、学位能否加分的个别判断","毕业证、学位证、成绩单、积分自测结果"],
 ["co","shiho","公司设立登记","公司名、目的、资本金、出资人和董事的资料"],
 ["co","gyosei","经营·管理签证是否可行的判断和申请文书","事业计划、资金来源、经历和学历"],
 ["co","zeirishi","设立后的税务申报、记账和决算","公司登记资料、开业日期、预计营业额"]
];
function linkTitle(id){return id==="co"?"开公司":id==="deg"?"取得学历和加分":nodeOf(id).t}
function catName(k){var c=CATS.filter(function(x){return x[0]===k})[0];return c?c[1]:k}
function linksOf(id){return LINKS.filter(function(x){return x[0]===id})}
var CLS={A:"流程说明",B:"已帮你处理",C:"需要税理士判断",D:"需要行政书士制作",E:"需要行政书士判断",F:"不能帮这个忙",G:"不在服务范围"};
// 要点一项一行：行内文字本身带分号，挤在一行里分不清“待核实”属于哪一项（eval 第3轮 D5、N17 把同一节点已核实的罚则、适用时期说成待核实）。
// 待核实的行以“【待核实】”开头，其余行一律是已核实的；隐去数字的行原文以“待核实：”开头，前缀已经说明，不再重复。
function kb(){return NODES.map(function(n){return n.id+" "+n.t+"："+n.sum+"\n  费用="+n.cost+"\n  用时="+n.time+"\n  步骤="+n.steps.join("→")+n.rows.map(function(r){return "\n  - "+(r[2]?"":"【待核实】")+r[0]+"="+(r[2]?r[1]:String(r[1]).replace(/^待核实：/,""))}).join("")}).join("\n")}
var SYS="你是「在留导航」里随时可以呼出的助手，帮助在日本生活的中国人自己办理生活手续。用户主要通过闯关路线图办事，你是辅助：解释任务怎么办、多少钱、要多久，帮忙记录进度。\n"+
"规则：\n1. 只依据下面的【节点资料】和工具返回的结果回答；两处都没有的内容，回答“资料库暂无”，不凭自己的知识补充。不添加资料里没有的提醒或忠告句；结论只按资料原话说；条件类的说法（如“可作为……要件之一”）照原话引用，不改写成“满……就可申请”“满……就能拿”。资料写明是某区、某校、某公司的例子时，说明这是例子，不当作通则。\n"+
"2. 回答的第一行只输出问题类别，格式为【A】到【G】之一。一个问题涉及多类时，按 F、D、E、C、B、A 的顺序取第一个符合的。用户主要是在说明自己的情况、进度或日期（需要考虑 update_profile、mark_done、add_trip、add_event，包括因日期不明确而先不记录的），或想联系服务商、准备咨询草稿时，属于 B，即使回答里顺带讲了流程；用户只是把自己的身份当作提问前提（如“我是留学签，能打几小时工”）时，按问题本身分类，可以同时调用 update_profile。只有用户的问题本身是要某个税额、扣除或是否需要申报、缴纳的结论（如“我要不要做确定申告”“我的副业收入要不要交税”）时才是 C；这时即使用户同时说明了自己的情况，也按 C。\n"+
"A 一般流程信息：回答，说明是哪个任务。\nB 事务整理（记录进度、读信、窗口日语话术、列清单）：直接执行。\n"+
"C 个别税务判断（某人能否算扶养、某笔能否抵扣、要交或能退多少税、我要不要做确定申告或年末调整、我的收入要不要交某种税）：不给结论，不对用户说“你要”“你不用”；建议咨询税理士，并按第8条列出税理士。可以转述资料里的一般条件，用“资料写的一般条件是……”开头，不把它套到用户身上，并说明这些条件在哪个任务（写编号和名称，如“4-4 住民税和扶养扣除”）。\n"+
"D 官方文书制作（代填申请书、代写理由书等）：不制作；建议委托行政书士。拒绝后只给资料里有的替代办法（期限、窗口、材料、行政书士、清单或话术），不描述表格在哪里领、怎么填。\n"+
"E 个别在留判断（我的情况能不能批、某条路线我能不能过、我的分数或学历入管会不会认、我现在的在留资格能不能在日本境内直接变更或转换、我自己的在留手续能不能这样办）：不给结论，也不用讲另一条流程的方式暗示结论；可以说资料库对这件事写了什么、没写什么；建议咨询行政书士，并按第8条用 suggest_providers（category 为 gyosei）列出行政书士、照原文说 disclosure。资料库有一般流程也仍是 E。各路线公开条件的比较不属于这一类，按第10条办。\n"+
"F 违法或规避请求（旅游签打工、虚假材料、挂靠公司、买卖账户等）：拒绝，并说明后果；后果只说节点资料、工具结果和第13条写明的（如虚假申请会不许可、取消在留资格；转让或买卖银行账户是犯罪，见节点资料 4-9 的“转让账户”一行），资料没写的后果只说“具体处罚资料库暂无，请以入管厅或区役所说明为准”，不自己推断“可能被罚款”“以后会更难”“要承担刑事责任”这类后果。\nG 与在日生活手续无关：一句话说明不在服务范围。\n"+
"3. 引用到标有“待核实”的内容时，明说这一项尚未核实。只对确实标了“待核实”的那一项这样说：节点资料里每个任务的要点一项一行（以“- ”开头），只有以“【待核实】”开头的那一行待核实，同一任务里没有这个开头的行（如罚则、适用时期）都是已核实的；概要、费用、用时里括号写着待核实的，只指它所在的那一句。不要概括成“这部分大多待核实”，也不要给没标的项加上待核实。\n4. 用简体中文，简短直接，先说结论，分点，每点一句。不用 Markdown 标题。\n"+
"5. 回答涉及税或在留时，最后一行写：AI 回答不构成税务或法律意见。\n"+
"6. 用户说明自己的情况时，用 update_profile 记录，只记录明确说过的内容。用户说某件事办完了，用 mark_done 记录。用户提到出国和回国日期，用 add_trip 记录。用户提到换工作或离职、搬家、离婚或配偶去世、孩子出生并说了具体日期时，用 add_event 记录，并告诉他工具返回的期限和依据（法条、官方页面）；工具没有返回这件事的期限时，只说本工具没有登记到对应的期限，这不代表没有其他手续，请他以入管厅或区役所的说明为准，不要下“没有法定届出”“不用办”的结论。\n"+
"7. 用户问该办什么、进度如何、什么时候开始准备时，用 get_plan 取结果再回答，不自己编排，不自己计算期限或准备日期。日期只用 get_plan 的 tasks、reminders 和其他工具结果里给出的；资料里“期满前约4个月”这类相对时间，工具没有给出日期的就照原话说，不换算成年月。\n"+
"8. C、D、E 类问题或用户想找人帮忙时，用 suggest_providers 列出对应类别的服务商，由用户自己选，不推荐某一家；工具的结果里说明是示例或还没有服务商入驻时，照实告诉用户。列出服务商或准备咨询草稿时，每次都要照工具结果里的 disclosure 说明这些服务商向平台支付固定的展示费；名单为空时也照原文说一次 disclosure，不增减字句。promoted 为 true 的服务商在名字后面标明“含推广”。\n"+
"10. 用户问来日本走哪条路、怎么取得学历、高度人才还差几分和怎么加分、电话卡套餐、驾照怎么拿、驾校、开公司费用、第一年要准备多少钱这类需要做选择的问题时（只问能不能、要不要的事实问题，如“中国驾照能直接开车吗”，按节点资料回答，不调用 get_options；问的是用户本人的在留资格能不能变更、能不能批的，属于 E），先用 get_options 取方案再回答（用户问题里提到的条件，如没有信用卡、要拿签证，要作为条件参数传进去；结果 defaults 里的条件是用户没说明的默认值，不要说成“按你的情况”，需要时说明“这是按默认条件排的，你可以告诉我实际情况”）：按返回的顺序介绍前两三套，不加“一般不是首选”“更推荐”这类工具结果里没有的评价，说明价格、适合谁、注意什么，并说明价格的核对日期和哪些是待实测。不自己补充价格。提到日元金额时同时给出工具返回的人民币折算。路线的排序和积分的计算是按用户所填条件得出的参考，要说明这不是能否获批的判断，积分以入管审查为准；不说“一定能批”“保证加分”。预算是估算，要说明没有算进去的项目；税和社保的金额仍按C类不计算。\n"+
"11. 用户表达着急、害怕、沮丧或孤单时，先用一两句话回应他的感受，再给出下一步具体怎么做。不说空泛的安慰话，不对审查结果做任何保证，不夸大风险吓人。用户完成任务时给一句具体的肯定。\n"+
"14. 不记录、不复述用户的个人编号（My Number）、护照号、银行账号；用户主动发来时提醒他不要发送。\n"+
"12. 用户问找工作时：说明他的在留资格能做哪类工作、留学和家族滞在打工的时间限制，可以指给他“同城”的招聘板块；不替用户挑选或推荐具体企业，不保证能被录用，换工作是否符合在留资格的个别判断转给行政书士。\n"+
"13. 用户问学历时只讲正规途径。学位必须来自所在国政府或其认可的认证机构承认的大学；自称大学但官网写明不是大学的机构（例如 Academy Europe 欧洲开放大学）发的证书不是学位，不算高度人才学历分，不要建议用户把它写成学位。问到买学历、代办假毕业证、挂名学校的，明确拒绝，并说明这是虚假申请、会导致不许可和取消在留资格。\n"+
"9. 用户请你整理清单、窗口话术、给专业人士的咨询摘要等辅助资料时，直接写在回答里。递交给官方的申请书、届出书、理由书等文书不制作。\n\n【节点资料】\n";
var STATUS_NAME={none:"尚无签证（人在中国）",short:"短期滞在（旅游签）",student:"留学",work:"技术·人文知识·国际业务",hsp:"高度专门职",family:"家族滞在",spouse:"日本人或永住者的配偶",ssw:"特定技能",biz:"经营·管理",pr:"永住者"};
function profileText(){return "身份="+(STATUS_NAME[P.status]||"未知")+"；入境日="+(P.entry||"未填")+"；定下住所日="+(P.addr||"未填")+"；在留期满日="+(P.exp||"未填")+"；公司社保="+(P.ins?"是":"否")+"；20至59岁="+(P.age?"是":"否")+"；有符合条件的中国驾照="+(P.lic?"是":"否")+"；永驻目标="+(P.pr?"是":"否")}
function planData(){var R=compute();return NODES.map(function(n){var r=R[n.id];return {id:n.id,title:n.t,state:r.state,note:r.note,due:r.due?fmt(r.due):"",cost:n.cost}}).filter(function(x){return x.state!=="na"})}
function isDate(s){var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s==="string"?s:"");if(!m)return false;var d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3]}
var JOBS=[["中文客服","正社员","pro","大阪市中央区"],["贸易公司翻译和事务","正社员","pro","大阪市北区"],["软件工程师","正社员","pro","大阪市淀川区"],["便利店店员","兼职","site","大阪市浪速区"],["餐厅后厨","兼职","site","大阪市中央区"],["仓库分拣","兼职","site","堺市"]];
var CITY={house:[["一居室，近地铁","接受外国人，可中文沟通","大阪市浪速区"],["合租单间","含水电网","东大阪市"],["家庭两居室","近小学","吹田市"]],
 used:[["电饭煲和微波炉","回国转让","大阪市西成区"],["自行车","已做防盗登记，随车转让手续","大阪市天王寺区"],["书桌和椅子","自取","大阪市生野区"]],
 life:[["搬家","单身搬家，中文可","大阪府内"],["中文家教","日语和升学辅导","线上或上门"],["机场接送","关西机场","大阪府内"]]};
function jobFit(type,kind){
  var s=P.status;
  if(s==="none"||s==="short")return ["bad","你现在的身份不能在日本工作"];
  if(s==="pr"||s==="spouse")return ["ok","你的在留资格没有工作限制"];
  if(s==="ssw")return ["warn","特定技能只能做所属行业的工作，换行业要先变更在留资格"];
  if(s==="biz")return ["warn","经营·管理是经营自己公司的资格，受雇工作要先变更在留资格"];
  if(s==="student"||s==="family")return type==="兼职"?["ok","可以做：须有资格外活动许可，每周28小时以内"]:["warn","全职入职前要先变更在留资格"];
  return kind==="pro"?["ok","工作内容与你的在留资格类型相符（一般情况）"]:["bad","这类现场工作一般不在你的在留资格范围内"];
}
var AUTH={mail:false,cal:false,push:false};
var INQ=[], SNOOZE=null, PVSEL=null;
var ISTEP=["已发送","对方已回复","已约定时间","办完并评价"];
var PL={pCert:"0",pTop:"no",pLang:"zh",pEdu:"10",pAge:"34",pInc:"500",pExp:"5",pJp:"none",pJd:"no",edu:"hs",goal:"work",deg:"yes",offer:"no",spouse:"no",jsp:"no",bLife:"9",topic:"phone",usage:"10",card:"no",shop:"no",time:"no",visa:"no",subs:{}};
var PLT=[["route","来日本走哪条路"],["degree","怎么取得学历"],["points","高度人才积分规划"],["phone","电话卡套餐"],["drive","驾照怎么拿"],["company","开公司费用"],["budget","第一年要准备多少钱"]];
function yen(n){return n.toLocaleString("ja-JP")+"日元"}
// 选方案的数据（价格、条件、来源、核对日期和下次复核日期）在 data/options.json；这里只留排序和取舍的规则。
var OPT=JSON.parse(JSON.stringify(require('../data/options.json'))), RATE=OPT.rate.value, RATE_ON=OPT.rate.on;
function optItems(topic){return OPT.topics[topic].items}
function optItem(topic,id){var x=optItems(topic).filter(function(i){return i.id===id})[0];if(!x)throw new Error("data/options.json 里缺少 "+topic+"."+id);return x}
// 字段的值是 {条件: 文字, default: 文字} 时，按条件取一条
function pick(v,key){return v&&typeof v==="object"&&!Array.isArray(v)?(key&&Object.prototype.hasOwnProperty.call(v,key)?v[key]:v.default):v}
// 一张方案卡片：数据里的名称、价格、说明、要点、来源，加上排序用的字段和核对日期
function card(it,key,extra){return Object.assign({name:it.name,price:pick(it.price,key),sub:pick(it.sub,key),pts:it.pts.slice(),src:it.src,st:it.st},extra||{},{checkedOn:it.checkedOn})}
function rmb(y){var c=y*RATE/100;return c>=10000?(Math.round(c/100)/100)+"万元":Math.round(c).toLocaleString("zh-CN")+"元"}
function num(s,wan){return parseFloat(s.replace(/,/g,""))*(wan?10000:1)}
function cny(s){
  return String(s).replace(/([\d,.]+)(万)?(至|、)?([\d,.]+)?(万)?日元(起)?/g,function(m,a,w1,sep,b,w2,qi,off,all){
    var pre=all.slice(Math.max(0,off-12),off);
    if(/[、+]\s*[^、+，。；]*$/.test(pre)&&!(sep==="至"))return m;
    if(sep==="至"&&b)return m+"（约"+rmb(num(a,w1||w2))+"至"+rmb(num(b,w2))+"）";
    if(sep)return m;
    return m+"（约"+rmb(num(a,w1))+"）"});
}
function phoneOptions(){
  var need={"3":3,"10":10,"30":30,"max":999}[PL.usage],o=[];
  optItems("phone").forEach(function(c){
    if(c.kind==="fixed"){o.push(card(c,null,{score:99999}));return}
    var best=null;c.plans.forEach(function(p){if(p[0]>=need&&(!best||p[1]<best[1]))best=p});
    if(!best)return;
    var s=best[1],why=[];
    if(PL.card==="no"){if(c.pay==="no"){s+=5000;why.push("你还没有日本信用卡，这家办不了")}else if(c.pay==="yes")why.push("没有信用卡也能办");else why.push("没有信用卡时能否办理待实测")}
    if(PL.shop==="yes"&&c.type==="online"){s+=5000;why.push("你需要门店办理，这家只能网上办")}
    o.push({name:c.name,price:yen(best[1])+" / 月",sub:best[2],pts:c.pts.concat(why),src:c.src,st:c.st,score:s,checkedOn:c.checkedOn});
  });
  o.sort(function(a,b){return a.score-b.score});return o;
}
function driveOptions(){
  var has=!!P.lic,tm=PL.time==="yes",it=function(id){return optItem("drive",id)},o=[
   card(it("gaimen"),null,{score:has?0:9,off:!has?it("gaimen").offText:""}),
   card(it("shitei"),null,{score:tm?2:1}),
   card(it("gasshuku"),null,{score:tm?1:3}),
   card(it("todokede"),null,{score:4})
  ];
  o.sort(function(a,b){return a.score-b.score});return o;
}
function companyOptions(){
  var v=PL.visa==="yes"?"visa":null;
  return [card(optItem("company","llc"),v,{score:0}),card(optItem("company","kk"),v,{score:1})];
}
function planNote(){return pick(OPT.topics[PL.topic].note,PL.topic==="company"&&PL.visa==="yes"?"visa":null)}
function routeOptions(){
  var deg=PL.deg==="yes",offer=PL.offer==="yes",sp=PL.spouse==="yes",jsp=PL.jsp==="yes",fee=OPT.topics.route.fee;
  // ok：传了就带 off（满足条件时为空字符串）；prNote 是“到永驻要多少年”，放在要点的第一条
  function r(id,score,ok){var it=optItem("route",id),x=card(it,null,{score:score});x.price=x.price.replace("{fee}",fee);if(it.prNote)x.pts=[it.prNote].concat(x.pts);if(ok!==undefined)x.off=ok?"":it.offText;return x}
  var o=[
   r("work",deg&&offer?0:6,deg&&offer),
   r("hsp",deg&&offer?1:7,deg&&offer),
   r("study",deg&&offer?3:sp?2:0),
   r("family",sp?(deg&&offer?2:0):8,sp),
   r("ssw",deg&&offer?5:1),
   r("biz",9),
   r("spouse",jsp?-1:8.5,jsp)
  ];
  o.sort(function(a,b){return a.score-b.score});return o;
}
function budgetOptions(){
  var life=+PL.bLife,ph=phoneOptions().filter(function(x){return !x.off})[0],pm=ph?+(String(ph.price).replace(/,/g,"").match(/\d+/)||[0])[0]:0;
  return optItems("budget").map(function(it,i){var r=[it.name,it.people,it.rent,it.setup],sign=r[2]*5,rent=r[2]*12,lf=life*r[1]*12,phone=Math.round(pm*Math.floor(r[1])*12/1000)/10,tot=Math.round((sign+r[3]+rent+lf+phone)*10)/10;
    return {name:r[0],price:"第一年约"+tot+"万日元",sub:"其中来日本头一个月要拿出约"+Math.round((sign+r[3]+r[2]+life*r[1])*10)/10+"万日元",pts:["房租：每月约"+r[2]+"万日元，12个月约"+Math.round(rent*10)/10+"万日元（大阪市近3个月挂牌房源的平均）","签约费用：按5个月房租估算，约"+Math.round(sign*10)/10+"万日元（押金、礼金、中介费、保证公司等，各房源差别大）","家具家电和搬家：按"+r[3]+"万日元估算","生活费：你选的每人每月"+life+"万日元，12个月约"+Math.round(lf*10)/10+"万日元","电话："+(ph?ph.name+"，":"")+"12个月约"+phone+"万日元","没有算：学费、机票、驾照、税和社会保险（上班的人从工资里扣）"],src:it.src,st:it.st,score:i,checkedOn:it.checkedOn}});
}
function degreeOptions(){
  var e=PL.edu,pts=PL.goal==="points",it=function(id){return optItem("degree",id)},o=[
   card(it("check"),null,{score:e==="hs"?9:(pts&&e==="ba"?1:0),off:e==="hs"?it("check").offText:""}),
   card(it("grad"),null,{score:e==="hs"?8:e==="jc"?3:(pts?0:2),off:e==="hs"?it("grad").offText:""}),
   card(it("senmon"),null,{score:e==="hs"?0:e==="jc"?4:6}),
   card(it("univ"),null,{score:e==="hs"?1:e==="jc"?5:7}),
   card(it("experience"),null,{score:pts?9:4,off:pts?it("experience").offText:""})
  ];
  if(e!=="ba")o.push(card(it("housou"),e==="hs"?"hs":null,{score:e==="hs"?-0.5:1.5}));
  if(e==="jc")o.push(card(it("ouchn"),null,{score:2}));
  if(e==="jc")o.push(card(it("niad"),null,{score:6}));
  if(e==="ba")o.push(card(it("evening"),null,{score:pts?-0.5:3}));
  if(pts){
   o.push(card(it("nodegree"),null,{score:-1}));
   o.push(card(it("online"),null,{score:e==="hs"?8:1,off:e==="hs"?it("online").offText:""}));
  }
  o.sort(function(a,b){return a.score-b.score});return o;
}
function hspPoints(s){
  var age=parseFloat(s.pAge),inc=+s.pInc||0,ex=+s.pExp||0,b={},noAge=isNaN(age);
  b["学历"]=+s.pEdu||0;
  b["职历"]=ex>=10?20:ex>=7?15:ex>=5?10:ex>=3?5:0;
  b["年龄"]=noAge?0:age<=29?15:age<=34?10:age<=39?5:0;
  var lim=noAge?800:age<=29?400:age<=34?500:age<=39?600:800;
  b["年收"]=inc>=1000?40:inc>=900?35:inc>=800?30:inc>=lim?(inc>=700?25:inc>=600?20:inc>=500?15:10):0;
  b["日语"]=s.pJp==="n1"?15:s.pJp==="n2"?10:0;
  b["在日本取得学位"]=s.pJd==="yes"?10:0;
  b["指定大学"]=s.pTop==="yes"?10:0;
  b["资格"]=s.pCert==="2"?10:s.pCert==="1"?5:0;
  if(s.pJp==="n2"&&s.pJd==="yes")b["日语"]=0;
  var tot=0;Object.keys(b).forEach(function(k){tot+=b[k]});return {b:b,total:tot};
}
function pointsOptions(){
  var cur=hspPoints(PL),o=[],cand=[],T=OPT.topics.points,it=function(id){return optItem("points",id)},now=it("current");
  function lvl(n){return n>=80?"达到80分：做高度人才满1年可申请永驻":n>=70?"达到70分：可申请高度专门职，满3年可申请永驻":"还差 "+(70-n)+" 分到70分"}
  o.push({name:"你现在的分数",price:cur.total+" 分",sub:lvl(cur.total),pts:Object.keys(cur.b).map(function(k){return k+"："+cur.b[k]+" 分"}).concat(+PL.pInc<300?["专门技术类要求年收300万日元以上，你现在不满足"]:[]),src:now.src,st:now.st,score:-9,checkedOn:now.checkedOn});
  // x：data/options.json 里的一种做法（名称、要改的条件 chg、花费、时间、说明、排序 rank）；over 换掉名称和条件（年收那一条按差多少填）
  function tryIt(x,over,link,off){var name=over?over.name:x.name,chg=over?over.chg:x.chg,notes=x.notes==="{certNote}"?T.certNote:x.notes,rank=x.rank;
    if(x.kind==="route"&&x.lang==="ja"&&chg.pEdu==="25")notes=notes.concat([T.subsidyNote]);
    var s={};Object.keys(PL).forEach(function(k){s[k]=PL[k]});Object.keys(chg).forEach(function(k){s[k]=k==="pEdu"?String(Math.max(+PL.pEdu,+chg[k])):chg[k]});var n=hspPoints(s).total;if(n<=cur.total)return;
    if(off){o.push({name:name,price:"加 "+(n-cur.total)+" 分，合计 "+n+" 分",sub:lvl(n),pts:["花费："+x.cost,"时间："+x.time].concat(notes),src:x.src,st:"入管厅积分表推算＋学校和媒体公开信息",score:rank+20,off:off,checkedOn:x.checkedOn});return}
    cand.push({name:name,chg:chg,rank:rank,n:n});
    o.push({name:name,price:"加 "+(n-cur.total)+" 分，合计 "+n+" 分",sub:lvl(n),pts:["花费："+x.cost,"时间："+x.time].concat(notes),src:x.src,st:"入管厅积分表推算",score:rank,link:link,checkedOn:x.checkedOn})}
  if(PL.pJp==="none")tryIt(it("jlpt-n2"));
  if(PL.pCert==="0")tryIt(it("cert-1"),null,0,"");
  if(PL.pCert!=="2")tryIt(it("cert-2"),null,0,"");
  if(PL.pJp!=="n1")tryIt(it("jlpt-n1"));
  var inc=+PL.pInc,nxt=[400,500,600,700,800,900,1000].filter(function(x){var s={};Object.keys(PL).forEach(function(k){s[k]=PL[k]});s.pInc=String(x);return x>inc&&hspPoints(s).total>cur.total})[0];
  if(nxt){var ic=it("income");tryIt(ic,{name:ic.name.replace("{n}",nxt),chg:{pInc:String(nxt)}})}
  var lg=PL.pLang,canJa=lg==="ja"||lg==="both",canEn=lg==="en"||lg==="both";
  if(+PL.pEdu>=10)optItems("points").filter(function(x){return x.kind==="route"}).forEach(function(r){var off=r.lang==="ja"&&!canJa?"要用日语上课":r.lang==="en"&&!canEn?"要用英语上课":"";tryIt(r,null,1,off)});
  if(cur.total<70&&!cand.some(function(c){return c.n>=70})){var best=null,cb=it("combo");
    cand.forEach(function(a,i){cand.slice(i+1).forEach(function(b){var s={};Object.keys(PL).forEach(function(k){s[k]=PL[k]});Object.keys(a.chg).forEach(function(k){s[k]=a.chg[k]});Object.keys(b.chg).forEach(function(k){if(k==="pEdu")s[k]=String(Math.max(+s[k],+b.chg[k]));else if(k==="pJp")s[k]=(s[k]==="n1"||b.chg[k]==="n1")?"n1":b.chg[k];else s[k]=b.chg[k]});
      var n=hspPoints(s).total,r=a.rank+b.rank;if(n>=70&&n>Math.max(a.n,b.n)&&(!best||r<best.r))best={a:a,b:b,n:n,r:r}})});
    if(best)o.push({name:"两样一起做："+best.a.name+"，加上"+best.b.name,price:"合计 "+best.n+" 分",sub:lvl(best.n),pts:["单做哪一样都到不了70分，这是花费最少、能到70分的组合","各自的花费和时间见下面对应的卡片"],src:cb.src,st:cb.st,score:-5,checkedOn:cb.checkedOn});
    else if(cand.length)o.push({name:"两样一起做也到不了70分",price:"要三样以上或换条路",sub:"请和行政书士商量整体安排",pts:["年龄和工作年数会随时间变化，可以隔一年再算"],src:cb.src,st:cb.st,score:-5,checkedOn:cb.checkedOn})}
  if(+PL.pEdu===0)o.push(card(it("edu-first"),null,{score:6}));
  o.sort(function(a,b){return a.score-b.score});return o;
}
function planOptions(){return PL.topic==="budget"?budgetOptions():PL.topic==="points"?pointsOptions():PL.topic==="degree"?degreeOptions():PL.topic==="route"?routeOptions():PL.topic==="phone"?phoneOptions():PL.topic==="drive"?driveOptions():companyOptions()}
P = Object.assign({}, JSON.parse(JSON.stringify(DEF)), state.profile || {});
DONE = Object.assign({}, state.done || {});
if (state.plan) Object.keys(state.plan).forEach(function(k){ if (k in PL || k === 'subs') PL[k] = state.plan[k]; });
if (state.auth) Object.assign(AUTH, state.auth);
if (Array.isArray(state.events)) EVENTS = state.events;
function conv(x){ return typeof x === 'string' ? cny(x) : x }
// get_options 每个主题认的条件（键就是上面各个 xxxOptions 读的 PL 字段）。值为数组时只认这些值；"num" 是数字。
// 助手的工具说明由这张表生成，所以加了新条件要在这里登记，否则会被当成无效条件忽略。
var YN=["yes","no"],PHONE_P={usage:["3","10","30","max"],card:YN,shop:YN};
var OPTION_PARAMS={
  route:{deg:YN,offer:YN,spouse:YN,jsp:YN},
  degree:{edu:["hs","jc","ba"],goal:["work","points"]},
  points:{pEdu:["0","10","20","25","30"],pAge:"num",pInc:"num",pExp:["0","3","5","7","10"],pJp:["none","n2","n1"],pJd:YN,pTop:YN,pLang:["zh","en","ja","both"],pCert:["0","1","2"]},
  phone:PHONE_P,
  drive:{time:YN},
  company:{visa:YN},
  budget:Object.assign({bLife:["6","9","12"]},PHONE_P)
};
function optionValue(spec, v){
  if (v === true) v = "yes"; else if (v === false) v = "no";
  if (typeof v === 'number' && isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null; v = v.trim();
  if (spec === "num") return /^\d+(\.\d+)?$/.test(v) ? v : null;
  v = v.toLowerCase(); return spec.indexOf(v) >= 0 ? v : null;
}
function options(topic, params){
  if (!PLT.some(function(x){return x[0]===topic})) throw new Error('未知的方案主题：'+topic);
  var spec = OPTION_PARAMS[topic], ignored = [], given = {}, defaults = {};
  PL.topic = topic;
  if (params && typeof params === 'object' && !Array.isArray(params)) Object.keys(params).forEach(function(k){
    var v = Object.hasOwn(spec, k) ? optionValue(spec[k], params[k]) : null;
    if (v === null) ignored.push(k); else { PL[k] = v; given[k] = v; }
  });
  // 回显实际用到的条件，分成本次调用传入的（given）和没传、按默认或页面上的选择的（defaults）。
  // A9 曾把默认的“不能连续空出两周”说成“按你的情况”，所以默认值单独列出并写明用户没说明。
  Object.keys(spec).forEach(function(k){ if (!Object.hasOwn(given, k)) defaults[k] = PL[k]; });
  var out = { topic: topic, given: given, defaults: defaults };
  if (Object.keys(defaults).length) out.defaultsNote = 'defaults 里的条件用户未说明，是按默认或页面上的选择排的，不是用户的情况；需要时请用户告诉实际情况';
  if (ignored.length) out.ignoredParams = ignored.join('、') + '：这个主题不认这些条件或取值无效，已忽略';
  return Object.assign(out, { note: planNote(), options: planOptions().map(function(o){ return Object.assign({}, o, { price: conv(o.price), sub: conv(o.sub), pts: (o.pts||[]).map(conv) }) }) });
}
// 网页“闯关”页要的数据：进度、每个任务的状态和期限。日期和“还有几天”都按日本时间在这里算好，网页不自己算。
function routeView(){
  var R=compute(),pg=progress(R),nq=nextQuest(R),t=today(),ent=D(P.entry);
  return {today:iso(t),stages:STAGES,titles:TITLES,level:pg.level,xp:pg.xp,max:pg.max,done:pg.done,total:pg.total,clear:pg.clear,next:nq?nq.id:null,
    dayInJapan:ent?days(ent,t)+1:0,legalDone:NODES.filter(function(n){return LEGAL[n.id]&&R[n.id].state==="done"}).length,
    nodes:NODES.map(function(n){var r=R[n.id];return {id:n.id,stage:n.s,title:n.t,state:r.state,note:r.note,due:r.due?iso(r.due):"",dueFmt:r.due?fmt(r.due):"",dueText:dueText(r.due),dueDays:r.due?days(t,r.due):null,xp:xpOf(n.id),legal:!!LEGAL[n.id]}})};
}
function plan(){ var R = compute(), nq = nextQuest(R), pg = progress(R); return { profile: profileText(), next: nq ? { id: nq.id, title: nq.t } : null, level: pg.level, done: pg.done, total: pg.total, tasks: planData(),
  // 期限和该开始准备的日子（在留更新前4、3、1个月等）由引擎算好给助手，助手不自己换算（eval 第3轮 B3、N16）
  reminders: reminders().filter(function(x){return !/示例|订阅/.test(x.txt)}).map(function(x){return {date:fmt(x.d),text:x.txt,deadline:x.dl}}) } }
return { EVRULES: EVRULES, NODES: NODES, DEF: DEF, STAGES: STAGES, CATS: CATS, REGULATED: REGULATED, LINKS: LINKS, JOBS: JOBS, CITY: CITY, PLT: PLT, OPTION_PARAMS: OPTION_PARAMS, STATUS_NAME: STATUS_NAME, SYS: SYS, RATE: RATE, RATE_ON: RATE_ON, OPTION_DATA: OPT,
  profile: P, compute: compute, progress: progress, nextQuest: nextQuest, plan: plan, routeView: routeView, linkTitle: linkTitle, days: days, D: D, reminders: reminders, eventDeadlines: function(ev){ return evDue(ev).map(function(x){ return { date: iso(x.d), txt: x.txt, src: x.src } }) }, advice: advice, prCheck: prCheck,
  options: options, hspPoints: function(s){ return hspPoints(Object.assign({}, PL, s||{})) }, kb: kb, profileText: profileText, linksOf: linksOf, jobFit: jobFit, cny: cny, fmt: fmt, isDate: isDate, today: today, iso: iso };
};
