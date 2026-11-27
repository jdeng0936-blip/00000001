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
function kb(){return NODES.map(function(n){return n.id+" "+n.t+"："+n.sum+" 费用="+n.cost+"；用时="+n.time+"；步骤="+n.steps.join("→")+"；"+n.rows.map(function(r){return r[0]+"="+r[1]+(r[2]?"":"（待核实）")}).join("；")}).join("\n")}
var SYS="你是「在留导航」里随时可以呼出的助手，帮助在日本生活的中国人自己办理生活手续。用户主要通过闯关路线图办事，你是辅助：解释任务怎么办、多少钱、要多久，帮忙记录进度。\n"+
"规则：\n1. 只依据下面的【节点资料】和工具返回的结果回答；两处都没有的内容，回答“资料库暂无”，不凭自己的知识补充。\n"+
"2. 回答的第一行只输出问题类别，格式为【A】到【G】之一：\n"+
"A 一般流程信息：回答，说明是哪个任务。\nB 事务整理（记录进度、读信、窗口日语话术、列清单）：直接执行。\n"+
"C 个别税务判断（某人能否算扶养、某笔能否抵扣、要交或能退多少税）：不给结论；建议咨询税理士。\n"+
"D 官方文书制作（代填申请书、代写理由书等）：不制作；建议委托行政书士。\n"+
"E 个别在留判断（我的情况能不能批、某条路线我能不能过、我的分数或学历入管会不会认）：不给结论；建议咨询行政书士。各路线公开条件的比较不属于这一类，按第10条办。\n"+
"F 违法或规避请求（旅游签打工、虚假材料、挂靠公司、买卖账户等）：拒绝，并说明后果。\nG 与在日生活手续无关：一句话说明不在服务范围。\n"+
"3. 引用到标有“待核实”的内容时，明说这一项尚未核实。\n4. 用简体中文，简短直接，先说结论，分点，每点一句。不用 Markdown 标题。\n"+
"5. 回答涉及税或在留时，最后一行写：AI 回答不构成税务或法律意见。\n"+
"6. 用户说明自己的情况时，用 update_profile 记录，只记录明确说过的内容。用户说某件事办完了，用 mark_done 记录。用户提到出国和回国日期，用 add_trip 记录。用户提到换工作或离职、搬家、离婚或配偶去世、孩子出生并说了具体日期时，用 add_event 记录，并告诉他工具返回的期限和依据（法条、官方页面）；工具没有返回这件事的期限时，只说本工具没有登记到对应的期限，这不代表没有其他手续，请他以入管厅或区役所的说明为准，不要下“没有法定届出”“不用办”的结论。\n"+
"7. 用户问该办什么、进度如何时，用 get_plan 取结果再回答，不自己编排，不自己计算期限。\n"+
"8. C、D、E 类问题或用户想找人帮忙时，用 suggest_providers 列出对应类别的服务商，由用户自己选，不推荐某一家；工具的结果里说明是示例或还没有服务商入驻时，照实告诉用户。列出服务商或准备咨询草稿时，每次都要照工具结果里的 disclosure 说明这些服务商向平台支付固定的展示费；promoted 为 true 的服务商在名字后面标明“含推广”。\n"+
"10. 用户问来日本走哪条路、怎么取得学历、高度人才还差几分和怎么加分、电话卡套餐、驾照怎么拿、驾校、开公司费用、第一年要准备多少钱这类需要做选择的问题时，先用 get_options 取方案再回答：按返回的顺序介绍前两三套，说明价格、适合谁、注意什么，并说明价格的核对日期和哪些是待实测。不自己补充价格。提到日元金额时同时给出工具返回的人民币折算。路线的排序和积分的计算是按用户所填条件得出的参考，要说明这不是能否获批的判断，积分以入管审查为准；不说“一定能批”“保证加分”。预算是估算，要说明没有算进去的项目；税和社保的金额仍按C类不计算。\n"+
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
var RATE=4.2142, RATE_ON="2026年11月24日";
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
var CARRIERS=[
 {n:"乐天移动",type:"both",pay:"yes",plans:[[3,1078,"3GB以内"],[20,2178,"20GB以内"],[999,3278,"不限量"]],
  pts:["缴费可用银行账户扣款、日本的借记卡或信用卡","用 Rakuten Link 应用打日本国内电话免费","外国籍网上办理时，部分人不能用在留卡做线上本人确认，需要去门店办"],st:"官网",src:["乐天移动：外国籍用户缴费指南","https://network.mobile.rakuten.co.jp/guide/payment/foreign-residents/"]},
 {n:"ahamo（docomo 线路）",type:"online",pay:"yes",plans:[[40,3135,"40GB以内"],[60,4125,"60GB以内"],[120,5115,"120GB以内"]],
  pts:["12月1日起改为三档：40GB 3,135、60GB 4,125、120GB 5,115日元；11月30日前签约为30GB 2,970日元，之后自动转新价","含单次5分钟内国内通话，签约手续费0","缴费用本人名义的信用卡或银行账户扣款","只能网上办理"],st:"官网",src:["ahamo 资费（含12月1日改定公告）","https://ahamo.com/plan/index.html"]},
 {n:"LINEMO（软银线路）",type:"online",pay:"unknown",plans:[[3,990,"3GB以内"],[10,2090,"10GB以内"],[30,2970,"30GB，含5分钟内通话"]],
  pts:["前两档按当月用量自动切换","签约手续费3,850日元（比价网站，待核实）","只能网上办理"],st:"软银新闻稿＋比价网站",src:["LINEMO 资费（软银）","https://www.softbank.jp/sbnews/entry/20240611_02"]},
 {n:"povo2.0（au 线路）",type:"online",pay:"unknown",plans:[[3,990,"3GB流量包，30天有效"]],
  pts:["基本费0，用时再买流量包；1GB包390日元","连续180天不买付费流量包可能被停用","只能网上办理"],st:"官网",src:["povo2.0 流量包","https://povo.jp/spec/topping/3G_30d/"]},
 {n:"IIJmio",type:"online",pay:"no",plans:[[2,850,"2GB"],[5,950,"5GB"],[10,1400,"10GB"],[15,1600,"15GB"],[25,2000,"25GB"],[35,2400,"35GB"],[45,3300,"45GB"],[55,3900,"55GB"]],
  pts:["各档月费在主要运营商里最低","必须用信用卡缴费（比价网站）","初期费用12月1日起由3,300日元涨到3,850日元","11月5日起新签约5至35GB档前3个月半价"],st:"IIJ 新闻稿＋媒体资费表",src:["主要 MVNO 资费（ケータイ Watch 2026年11月号）","https://k-tai.watch.impress.co.jp/docs/review/2155215.html"]},
 {n:"mineo",type:"online",pay:"unknown",plans:[[3,1298,"3GB"],[7,1518,"7GB"],[15,1958,"15GB"],[30,2178,"30GB"],[50,2948,"50GB"]],
  pts:["流量用完后仍可限速使用","11月30日前新签约，前6个月月费有折扣（3GB档880日元）"],st:"比价网站（称取自官网）",src:["mineo 资费一览","https://all-connect.co.jp/magazine/mineo-pricing-plan/"]},
 {n:"日本通信SIM",type:"online",pay:"unknown",plans:[[1,290,"1GB"],[3,730,"1GB档加购2GB"],[20,1390,"20GB，含5分钟内通话"],[50,2178,"50GB，含5分钟内通话"]],
  pts:["小流量最便宜，每加1GB 220日元","20GB和50GB两档价格出自2024年12月报道，待复核"],st:"媒体报道",src:["日本通信SIM 资费（ITmedia）","https://www.itmedia.co.jp/mobile/spv/2412/12/news162.html"]},
 {n:"Y!mobile（软银子品牌）",type:"shop",pay:"unknown",plans:[[5,3278,"5GB"],[30,4378,"30GB"],[35,5478,"35GB，含10分钟内通话"]],
  pts:["有门店可当面办理","6月2日起各档涨了220日元","家庭、光纤、PayPay卡折扣叠加后才便宜"],st:"比价网站＋官网涨价公告",src:["Y!mobile 资费改定公告","https://www.ymobile.jp/sp/price_info_2026/"]},
 {n:"UQ mobile（au 子品牌）",type:"shop",pay:"unknown",plans:[[5,2948,"5GB以内"],[30,4048,"30GB以内"],[35,3828,"35GB，含10分钟内通话；首13个月3,168日元"]],
  pts:["有门店可当面办理","单人无折扣时偏贵"],st:"比价网站",src:["UQ mobile 资费（2026年11月）","https://kupomiru.jp/uqmobile-price/"]},
 {n:"docomo",type:"shop",pay:"unknown",plans:[[6,3278,"mini2，6GB以内"],[12,4598,"mini2，12GB以内"],[999,8448,"MAX，不限量"]],
  pts:["小流量套餐12月1日起换成 mini2，旧的 mini 11月30日停止受理","门店最多，无折扣时最贵"],st:"比价网站",src:["docomo 资费一览（12月改定后）","https://rokemoba.co.jp/kakuyasusim/docomo-plan/"]},
 {n:"au",type:"shop",pay:"yes",plans:[[999,7788,"使い放題MAX+，不限量"]],
  pts:["新签约带在留卡加护照或健康保险证","缴费可用信用卡或银行账户；在留期限不足90天时缴费方式有限制（细则待核实）"],st:"官网材料清单＋比价网站",src:["au 新签约所需物品","https://www.au.com/content/dam/au-com/catalog/pdf/au_catalog_new_contract.pdf"]},
 {n:"软银",type:"shop",pay:"unknown",plans:[[2,5258,"ミニフィット2，2GB以内"],[5,6358,"ミニフィット2，5GB以内"],[999,8008,"テイガク無制限，不限量"]],
  pts:["有门店可当面办理","单人无折扣时最贵的一档"],st:"比价网站",src:["软银资费一览（2026年11月）","https://all-connect.co.jp/magazine/softbank-plan/"]}
];
function phoneOptions(){
  var need={"3":3,"10":10,"30":30,"max":999}[PL.usage],o=[];
  CARRIERS.forEach(function(c){
    var best=null;c.plans.forEach(function(p){if(p[0]>=need&&(!best||p[1]<best[1]))best=p});
    if(!best)return;
    var s=best[1],why=[];
    if(PL.card==="no"){if(c.pay==="no"){s+=5000;why.push("你还没有日本信用卡，这家办不了")}else if(c.pay==="yes")why.push("没有信用卡也能办");else why.push("没有信用卡时能否办理待实测")}
    if(PL.shop==="yes"&&c.type==="online"){s+=5000;why.push("你需要门店办理，这家只能网上办")}
    o.push({name:c.n,price:yen(best[1])+" / 月",sub:best[2],pts:c.pts.concat(why),src:c.src,st:c.st,score:s});
  });
  o.push({name:"GTN Mobile（面向外国人）",price:"月费待查",sub:"支持简体中文，缴费方式灵活",pts:["专做在日外国人的通信服务，应用支持简体中文","没查到现行月费，需向官方确认"],src:["GTN Mobile 服务介绍","https://www.gtn-mobile.com/s/features"],st:"官网",score:99999});
  o.sort(function(a,b){return a.score-b.score});return o;
}
function driveOptions(){
  var has=!!P.lic,tm=PL.time==="yes",o=[
   {name:"外免切替",price:"一次通过约11,450日元",sub:"译文6,600 + 申请2,500 + 发证2,350日元",pts:["申请和发证手续费是东京等多地警方公布的金额；大阪府警页面没有列金额，办理前请电话确认","知识确认50题、45题以上通过；技能确认100分中70分以上通过","有报道称新规后技能确认通过率约13%，建议先付费练车（练车费待实测）","大阪在门真或光明池考场办，受理时间为工作日8:45至12:00、12:45至13:30","日语交流困难要自带翻译；每次重考要再交申请手续费"],src:["大阪府警：外国驾照换日本驾照","https://www.police.pref.osaka.lg.jp/tetsuduki/untenmenkyo/3694.html"],st:"警方官网",score:has?0:9,off:!has?"你没有符合条件的中国驾照，这条路走不了":""},
   {name:"大阪指定教习所（走读）",price:"自动挡约21万至33万日元",sub:"毕业后免技能考试",pts:["各校官网报价：近畿自动车教习所297,000、富田林297,432、大阪香里315,300、茨木321,800、丰中326,650日元","比价网站2024年调查的低价校：尾崎212,850、泉南236,059、岸和田247,500日元","可以边工作边学；是否有中文教学要逐家问"],src:["大阪府警：指定自动车教习所名单","https://www.police.pref.osaka.lg.jp/kotsu/untenmenkyo/kyoshujo/shitei/5958.html"],st:"各校官网＋比价网站",score:tm?2:1},
   {name:"合宿驾校",price:"自动挡全国平均约25.5万日元",sub:"最短约两周，住在驾校",pts:["淡季自炊合住约20万日元起，旺季（7至9月、1至3月）更贵","要能连续空出两周","各校对外国人的日语和年龄要求不同，报名前要确认"],src:["教习所费用排行（はじめての運転免許）","https://hajimen.com/26-osaka/rank_detail"],st:"比价网站",score:tm?1:3},
   {name:"届出教习所（非指定）",price:"268,000日元起",sub:"大阪自动车学校的基本方案，学科在线上",pts:["去学校的次数少","不是指定教习所：技能考试不免除，要去运转免许考场考","适合只想少跑几趟、对考试有把握的人"],src:["大阪府警：届出自动车教习所","https://www.police.pref.osaka.lg.jp/kotsu/untenmenkyo/kyoshujo/5960.html"],st:"学校官网＋警方官网",score:4}
  ];
  o.sort(function(a,b){return a.score-b.score});return o;
}
function companyOptions(){
  var v=PL.visa==="yes",o=[
   {name:"合同会社",price:v?"法定费用约21万日元":"法定费用约6万日元起",sub:v?"资本金3,000万日元时登记税为0.7%，即21万日元（推算）":"登记税最低6万日元，不需要定款认证",pts:["设立最便宜，出资人直接经营","对外信用感不如株式会社","用电子定款可省4万日元印花"],src:["会社设立费用（マネーフォワード）","https://biz.moneyforward.com/establish/basic/79118/"],st:"会计软件公司说明",score:0},
   {name:"株式会社",price:v?"法定费用约26万日元":"法定费用约17万至20万日元",sub:v?"登记税21万（推算）+ 定款认证5万日元":"登记税最低15万 + 定款认证1.5万至5万日元",pts:["定款认证费按资本金：不足100万日元为1.5万（满足条件时）或3万，100万至300万为4万，300万以上为5万日元","信用度高，便于融资","用电子定款可省4万日元印花"],src:["日本公证人联合会：手续费一览","https://www.koshonin.gr.jp/"],st:"公证人联合会",score:1}
  ];
  return o;
}
function planNote(){return planNote0()+((PL.topic==="points"||PL.topic==="degree")?" 途径库持续更新：本批核对日期2026年11月25日，学费每年按招生简章复核，加分大学名单每年复核。你知道别的途径，可以告诉助手，核实后收录；没核实的不会显示加分数字。":"")}
function planNote0(){
  if(PL.topic==="budget")return "这是按规则估算的预算，不是报价。房租用的是大阪市全市平均，市中心更贵；签约费用和家具费用是估算规则，实际以房源和个人情况为准。电话费取“电话卡套餐”里按你的条件排第一的那家。核对日期：2026年11月25日。";
  if(PL.topic==="points")return "按入管厅积分表里专门技术类的主要项目推算：学历、职历、年龄、年收、日语、在日本取得学位、指定大学、资格。研究实绩、就职单位等其他加分项没有算进去，实际分数可能更高。排序规则：先列不花钱的做法，再把读学位的做法按花费从低到高排；你选的语言上不了的课程排在最后。读硕士要先有本科学位，大专的人请先看“怎么取得学历”。学费取自学校和媒体的公开信息，报名前以学校当年的招生简章为准。这是自测，不是审查结果；是否申请、分数如何认定请找行政书士。核对日期：2026年11月25日。";
  if(PL.topic==="degree")return "这里只列正规途径。买来的假学历、只挂名不上课的学校，在申请里用了就是虚假申请，会被拒绝、取消在留资格，还可能被追究刑事责任；本平台不提供也不介绍这类渠道。排序规则：已有大专或本科的，先确认现有学历够不够；目标是高度人才加分的，先看不用读学位的加分项，再比较在线学位和日本的大学院（在日本取得学位另加10分）；只有高中学历的，优先日本的专门学校和大学。各校学费和入学条件待调研，个别判断请找行政书士。核对日期：2026年11月25日。";
  if(PL.topic==="route")return "排序规则：有相关学历和日本公司的雇佣合同时优先就职；配偶或父母在日本时优先家族滞在；都没有时优先留学，其次特定技能。旅游签（短期滞在）不能工作，也不能当作长期居留的起点，在日本国内原则上不能直接换成长期在留资格。审查日数是全国平均，每月变动。哪条路线适合你的个别判断请找行政书士。核对日期：2026年11月25日。";
  if(PL.topic==="phone")return "已收录12家运营商和1家面向外国人的服务，价格为含税的无折扣单人价。排序规则：按你选的用量取各家最便宜的一档比价；没有日本信用卡时把必须用信用卡的排后；需要门店时把只能网上办的排后。12月1日起 ahamo、docomo 小流量套餐和 IIJmio 初期费用有变动，页面已按新价显示。核对日期：2026年11月25日。";
  if(PL.topic==="drive")return "排序规则：有符合条件的中国驾照时优先外免切替；没有时，能连续空出两周优先合宿，否则优先走读。驾校报价会随季节和方案变化，报名前以学校当天报价为准。核对日期：2026年11月25日。";
  return PL.visa==="yes"?"入管厅公布的经营·管理新基准（2025年10月16日起）：资本金等3,000万日元以上；雇用1名以上常勤职员（限日本人、特别永住者、永住者等身份类在留资格）；申请人或常勤职员有相当于B2的日语能力；3年以上经营管理经验或相关硕士以上学位；事业计划经专家确认。门槛很高，是否可行请咨询行政书士，登记可委托司法书士。费用不含资本金本身、办公室、每年的法人住民税和社保。":"以上是设立时的法定费用，不含资本金、办公室、印章、每年的法人住民税、社保和决算申报费用。登记手续可委托司法书士。核对日期：2026年11月25日。";
}
function routeOptions(){
  var deg=PL.deg==="yes",offer=PL.offer==="yes",sp=PL.spouse==="yes",jsp=PL.jsp==="yes",fee="签证费715元，另付代办机构手续费；在留资格认定申请本身免费";
  var o=[
   {name:"就职（技术·人文知识·国际业务）",price:fee,sub:"在留资格认定审查平均约51天（2026年6月许可分）",pts:["要有日本公司的雇佣合同，工作内容要用到专业知识","要有相关专业的大学（含短期大学）学历或日本专门学校的专门士；学历不够时可凭实务经验，技术和人文知识类10年、国际业务类3年（行政书士事务所的说明）","学历不够的人请看“怎么取得学历”","报酬不低于做同样工作的日本人","可带配偶子女，是通往永驻的主干道"],src:["入管厅：技术·人文知识·国际业务的明确化","https://www.moj.go.jp/isa/content/001413639.pdf"],st:"入管厅＋行政书士事务所整理的审查日数",score:deg&&offer?0:6,off:deg&&offer?"":"需要相关学历和日本公司的雇佣合同，你现在还不满足"},
   {name:"高度专门职",price:fee,sub:"积分70分以上",pts:["按学历、职历、年收等计分，满70分可申请","永驻最短3年，80分以上最短1年","先在“高度人才自测”任务里算分"],src:["入管厅：高度人才积分制","https://www.moj.go.jp/isa/applications/resources/nyuukokukanri01_00009.html"],st:"入管厅",score:deg&&offer?1:7,off:deg&&offer?"":"同样需要学历和雇佣合同"},
   {name:"留学（日语学校起步）",price:"日语学校第一年学费约60万至100万日元，生活费另算",sub:"在留资格认定审查平均约43天（6月许可分；5月约71天）",pts:["例：某日语学校大阪校2026年度一年合计942,000日元，2027年度涨到1,015,000日元","要交经费支付人的存款余额证明和收入证明，金额以各校招生简章为准","可申请资格外活动许可，每周28小时以内打工","毕业找到工作后可转就职类在留资格","留学期间的年数在永驻审查里怎么算，请看“永驻条件自查”"],src:["ISI日语学校 2026年度招生手册","https://www.isi-education.com/wp-content/uploads/2025/09/2026SchoolManual_long_jp_20250919.pdf"],st:"学校官网＋行政书士事务所整理的审查日数",score:deg&&offer?3:sp?2:0},
   {name:"家族滞在",price:fee,sub:"在留资格认定审查平均约69天（5月许可分）",pts:["配偶或父母持就职、留学等在留资格在日本，由对方抚养","要证明抚养人有抚养能力","可申请资格外活动许可，每周28小时以内打工"],src:["在留审查处理期间（行政书士事务所整理）","https://yell-office.jp/news/2026/07/3412/"],st:"行政书士事务所整理",score:sp?(deg&&offer?2:0):8,off:sp?"":"需要配偶或父母已在日本持相应在留资格"},
   {name:"特定技能1号",price:fee+"；考试费待查",sub:"现场类工作的就劳资格",pts:["满18岁，通过所在行业的技能考试和日语考试","通算在留最长5年","能否带家属待核实","适合没有大学学历、想直接工作的人"],src:["外务省：特定技能制度介绍","https://www.mofa.go.jp/mofaj/ca/fna/ssw/jp/introduction/index.html"],st:"外务省",score:deg&&offer?5:1},
   {name:"经营·管理（开公司）",price:"资本金等3,000万日元以上，另加设立费用",sub:"在留资格认定审查平均约212天（6月许可分），约7个月",pts:["还要雇1名以上常勤职员、有相当于B2的日语能力（本人或职员）、3年经营管理经验或相关硕士以上学位、专家确认过的事业计划","门槛和周期都是各路线里最高的","设立费用见“开公司费用”"],src:["入管厅：经营·管理基准改正","https://www.moj.go.jp/isa/applications/resources/10_00237.html"],st:"入管厅＋行政书士事务所整理的审查日数",score:9}
  ];
  var PRY={"就职（技术·人文知识·国际业务）":"到永驻：原则连续在留10年，其中就劳资格5年以上","留学（日语学校起步）":"到永驻：原则连续在留10年，其中换成就劳资格后要满5年","家族滞在":"到永驻：家族滞在不是就劳资格，本人要换成就劳资格满5年，或随配偶一起申请，属于个别判断","特定技能1号":"到永驻：特定技能1号的年数不算进就劳资格的5年","经营·管理（开公司）":"到永驻：原则连续在留10年，其中就劳资格5年以上"};
  o.forEach(function(x){if(PRY[x.name])x.pts=[PRY[x.name]].concat(x.pts)});
  o.push({name:"日本人或永住者的配偶",price:fee,sub:"工作种类不受限制",pts:["到永驻：现在是婚姻实际持续3年以上、在日本连续住满1年；2027年4月1日以后的申请改为婚姻5年以上、在留3年以上（行政书士对2026年10月新指南的解说）","婚姻要真实并且共同生活，审查会看交往经过和生活情况","离婚或配偶去世后要在14天内向入管届出，之后的在留资格属于个别判断，请咨询行政书士"],src:["入管厅：永住许可指南（2026年10月改定）","https://www.moj.go.jp/isa/10_00279"],st:"入管厅指南＋行政书士解说",score:jsp?-1:8.5,off:jsp?"":"需要配偶是日本人或永住者"});
  o.sort(function(a,b){return a.score-b.score});return o;
}
var RENT={a:["单身，一居室",1,6.6,15],b:["两个人，一室一厅",2,9.68,25],c:["一家三口，两室一厅",2.5,13.26,35]};
function budgetOptions(){
  var life=+PL.bLife,ph=phoneOptions().filter(function(x){return !x.off})[0],pm=ph?+(String(ph.price).replace(/,/g,"").match(/\d+/)||[0])[0]:0;
  return Object.keys(RENT).map(function(k,i){var r=RENT[k],sign=r[2]*5,rent=r[2]*12,lf=life*r[1]*12,phone=Math.round(pm*Math.floor(r[1])*12/1000)/10,tot=Math.round((sign+r[3]+rent+lf+phone)*10)/10;
    return {name:r[0],price:"第一年约"+tot+"万日元",sub:"其中来日本头一个月要拿出约"+Math.round((sign+r[3]+r[2]+life*r[1])*10)/10+"万日元",pts:["房租：每月约"+r[2]+"万日元，12个月约"+Math.round(rent*10)/10+"万日元（大阪市近3个月挂牌房源的平均）","签约费用：按5个月房租估算，约"+Math.round(sign*10)/10+"万日元（押金、礼金、中介费、保证公司等，各房源差别大）","家具家电和搬家：按"+r[3]+"万日元估算","生活费：你选的每人每月"+life+"万日元，12个月约"+Math.round(lf*10)/10+"万日元","电话："+(ph?ph.name+"，":"")+"12个月约"+phone+"万日元","没有算：学费、机票、驾照、税和社会保险（上班的人从工资里扣）"],src:["at home：大阪市房租行情","https://www.athome.co.jp/chintai/souba/osaka/osaka-city/"],st:"房租为房源网站数据，其余为估算",score:i}});
}
function degreeOptions(){
  var e=PL.edu,pts=PL.goal==="points",o=[
   {name:"先确认现有学历够不够",price:"不用花钱",sub:"中国的大专、本科多数情况下已满足就职类在留资格的学历要件",pts:["行政书士事务所引用的入管运用要纲：大学院、大学（本科和专科）、专科学校、短期职业大学的毕业生，以及在能授学位的成人教育机构毕业并取得学位的人，按大学毕业同等以上对待","职业技术学院等学校是否认可要逐案审查，申请前请行政书士看毕业证和学位证","专业要和将来的工作内容相关"],src:["中国学历在技人国中的认定（行政书士事务所）","https://continental-immigration.com/employ/china_education/"],st:"行政书士事务所（二手）",score:e==="hs"?9:(pts&&e==="ba"?1:0),off:e==="hs"?"高中学历不满足学历要件，请看下面几条路":""},
   {name:"日本的大学院（硕士、博士）",price:"学费待调研",sub:"高度人才学历分：博士30分，硕士20分，本科10分",pts:["硕士一般2年；在日本取得学位另有加分（细则见高度人才积分表）","入学资格原则上要本科毕业或16年教育","大专毕业的要先通过学校的个别入学资格审查，例如有的研究科写明中国3年制专科没有直接报考资格","读书期间是留学在留资格，可申请资格外活动许可打工"],src:["文部科学省：硕士课程的入学资格","https://www.mext.go.jp/a_menu/koutou/shikaku/07111316.htm"],st:"文部科学省＋入管厅积分表",score:e==="hs"?8:e==="jc"?3:(pts?0:2),off:e==="hs"?"要先有本科或大专学历":""},
   {name:"日本的专门学校（专门士）",price:"学费待调研",sub:"一般2年，毕业取得专门士称号",pts:["必须是日本国内、能授予专门士或高度专门士称号的课程，海外的专门学校不算","专业和工作内容的关联性审查比大学毕业更严","入学要有12年教育，日语不够的通常先读日语学校","专门学校毕业算不算高度人才的学历分，待核实"],src:["技人国的学历要件（行政书士法人）","https://www.legal-wings.com/news-20260424-01/"],st:"行政书士事务所（二手）",score:e==="hs"?0:e==="jc"?4:6},
   {name:"日本的大学或短期大学",price:"学费待调研",sub:"大学4年（学士），短期大学2年（短期大学士）",pts:["短期大学士以上的学位就满足就职类在留资格的学历要件","入学要有12年教育，多数要参加留学生考试或学校自己的考试","大专毕业插班入学的条件待调研"],src:["文部科学省：大学入学资格指南","https://www.mext.go.jp/a_menu/koutou/shikaku/20260525-mxt_daigakuc01-0000_1.pdf"],st:"文部科学省＋行政书士事务所",score:e==="hs"?1:e==="jc"?5:7},
   {name:"不靠学历，靠实务经验",price:"不用花钱",sub:"技术和人文知识类10年，国际业务类3年",pts:["10年里可以算上在大学、高中、专门学校学相关专业的时间","要有过去雇主开的在职证明，证明难度大","不能用于高度人才的学历加分"],src:["技人国的学历和实务经验（行政书士事务所）","https://royal-ptns.com/visa/gijinkoku-gakureki/"],st:"行政书士事务所（二手）",score:pts?9:4,off:pts?"实务经验不算学历分":""}
  ];
  if(e!=="ba")o.push({name:"放送大学（日本的广播电视大学，在家学）",price:e==="hs"?"读完约77万日元":"插班到三年级约40.6万日元",sub:e==="hs"?"没有入学考试，4年取得日本的学士学位":"没有入学考试，最短2年取得日本的学士学位",pts:["正规的日本大学，毕业授予学士学位，可以不辞职、不换在留资格边工作边读","按学分交学费，每学分6,000日元","用日语学习和考试","高中毕业要有12年教育；中国的大专能不能插班到三年级，要问学校","拿到日本的学士后，就职类在留资格的学历要件、高度人才的学历分和在日本取得学位的加分都能用上"],src:["放送大学：取得学士学位","https://www.ouj.ac.jp/reasons-to-choose-us/qualification/bachelor/"],st:"学校官网",score:e==="hs"?-0.5:1.5});
  if(e==="jc")o.push({name:"国家开放大学专升本（中国）",price:"总共约5,000至10,000元人民币",sub:"免试入学，最短2.5年",pts:["教育部直属，毕业证学信网可查","期末考试要在国内线下参加，人在日本的要安排回国","学士学位要另外满足学位英语和平均分的条件，只拿毕业证不等于有学位","拿到本科学位后可以申请硕士课程"],src:["国家开放大学专升本说明（教育在线）","https://www.eol.cn/kaifang/xgkwyw/20260325134013.html"],st:"教育媒体（二手）",score:2});
  if(e==="jc")o.push({name:"学位授与机构（在日本攒学分换学士）",price:"费用待调研",sub:"日本唯一不是大学却能授予学位的机构",pts:["短期大学、高专、指定专门学校的毕业生，再修一定的大学学分后可申请学士","常和放送大学的学分搭配使用","外国学校的毕业生有没有申请资格待核实"],src:["大学改革支援·学位授与机构","https://www.niad.ac.jp/n_gakui/application/shinseishiryou.html"],st:"机构官网",score:6});
  if(e==="ba")o.push({name:"不辞职读日本的夜间和周末大学院",price:"神户大学MBA最短1年半约108.6万日元",sub:"关西学院大学MBA在大阪梅田，2年约219万日元",pts:["在日本取得学位另加10分，学校在加分大学名单里再加10分","要用日语上课，神户大学要考入学考试","具体能加几分，请用“高度人才积分规划”算"],src:["关西的MBA比较（アガルート）","https://agaroot-lawacc.com/domestic_mba3/kansai-mba-comparison/"],st:"升学媒体（二手）",score:pts?-0.5:3});
  if(pts){
   o.push({name:"先拿不用读学位的加分",price:"只需考试报名费",sub:"日语能力考试N1加15分，N2加10分",pts:["年收、职历、年龄也都有分，先用“高度人才自测”算清楚还差几分","差10到15分的人，考日语往往比读学位快得多、便宜得多","和学历分可以叠加"],src:["入管厅：高度人才积分表","https://www.moj.go.jp/isa/content/001447348.pdf"],st:"入管厅",score:-1});
   o.push({name:"在职在线读海外大学的学位",price:"例：美国金门大学在线DBA，中介报价约15.8万元人民币",sub:"MBA约1至1.5年、中介报价约6.2万元人民币；DBA约2至3年",pts:["金门大学是有美国地区性认证的正规大学，认证在2025年6月续到2031年；但认证机构同时对它发了关注通知，其中一项就是远程教育的合规","积分表里专门职博士不按博士的30分算，按硕士的20分算；DBA在认证机构的名录里登记为专门职博士","MBA这类经营管理的专门职学位，在专门技术类和经营管理类里是25分，海外的MBA也算","只有学位算分，结业证书、研修证书不算","在线取得的学位算不算分，入管厅的问答里没有写；交学费之前，先请行政书士向入管确认","金门大学官方的入学条件：硕士要有受认可大学的本科学位；DBA要有硕士学位，或本科学位加5年以上工作经验","有本科的人不需要任何前置证书，直接申请即可","“欧洲开放大学”（Academy Europe）的免费MBA不能当前置硕士用：它自己的官网写明它不是大学、发的不是德国政府承认的大学学位。这张证书在日本的积分里不算分，也不要当作学位写进任何申请","大专学历能否申请，中介的说法和学校官方的要求不一致，以学校的学历评估结果为准"],src:["入管厅：高度人才积分制问答","https://www.moj.go.jp/isa/applications/resources/newimmiact_3_qa.html"],st:"入管厅＋认证机构官网＋中介报价",score:e==="hs"?8:1,off:e==="hs"?"要先有本科或同等学历":""});
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
  var cur=hspPoints(PL),o=[],cand=[];
  function lvl(n){return n>=80?"达到80分：做高度人才满1年可申请永驻":n>=70?"达到70分：可申请高度专门职，满3年可申请永驻":"还差 "+(70-n)+" 分到70分"}
  o.push({name:"你现在的分数",price:cur.total+" 分",sub:lvl(cur.total),pts:Object.keys(cur.b).map(function(k){return k+"："+cur.b[k]+" 分"}).concat(+PL.pInc<300?["专门技术类要求年收300万日元以上，你现在不满足"]:[]),src:["入管厅：高度人才积分表","https://www.moj.go.jp/isa/content/930001655.pdf"],st:"入管厅",score:-9});
  function tryIt(name,chg,cost,time,notes,rank,link,off){var s={};Object.keys(PL).forEach(function(k){s[k]=PL[k]});Object.keys(chg).forEach(function(k){s[k]=k==="pEdu"?String(Math.max(+PL.pEdu,+chg[k])):chg[k]});var n=hspPoints(s).total;if(n<=cur.total)return;
    if(off){o.push({name:name,price:"加 "+(n-cur.total)+" 分，合计 "+n+" 分",sub:lvl(n),pts:["花费："+cost,"时间："+time].concat(notes),src:["入管厅：高度人才积分制问答","https://www.moj.go.jp/isa/applications/resources/newimmiact_3_qa.html"],st:"入管厅积分表推算＋学校和媒体公开信息",score:rank+20,off:off});return}
    cand.push({name:name,chg:chg,rank:rank,n:n});
    o.push({name:name,price:"加 "+(n-cur.total)+" 分，合计 "+n+" 分",sub:lvl(n),pts:["花费："+cost,"时间："+time].concat(notes),src:["入管厅：高度人才积分制问答","https://www.moj.go.jp/isa/applications/resources/newimmiact_3_qa.html"],st:"入管厅积分表推算",score:rank,link:link})}
  if(PL.pJp==="none")tryIt("考过日语N2",{pJp:"n2"},"只需报名费","按现有日语水平，几个月到一两年",["已在日本取得学位的，N2不再另外加分"],0);
  var certNote=["入管厅积分表：和工作相关的日本国家资格，或信息处理类告示里的考试，1项5分，2项以上10分","日本的考试：基本情报技术者、应用情报技术者等（具体区分以告示为准）","中国的软考也在告示里：系统分析师、信息系统项目管理师、系统架构设计师、软件设计师、网络工程师、数据库系统工程师、程序员","资格要和从事的工作有关，做信息技术以外工作的人请先问行政书士"];
  if(PL.pCert==="0")tryIt("考过1项信息处理类考试（日本的或中国的软考）",{pCert:"1"},"只需报名费","几个月",certNote,1.5,0,"");
  if(PL.pCert!=="2")tryIt("凑满2项信息处理类考试或国家资格",{pCert:"2"},"只需报名费","半年到一年",certNote,2,0,"");
  if(PL.pJp!=="n1")tryIt("考过日语N1",{pJp:"n1"},"只需报名费","按现有日语水平，半年到两年",[],1);
  var inc=+PL.pInc,nxt=[400,500,600,700,800,900,1000].filter(function(x){var s={};Object.keys(PL).forEach(function(k){s[k]=PL[k]});s.pInc=String(x);return x>inc&&hspPoints(s).total>cur.total})[0];
  if(nxt)tryIt("年收提高到"+nxt+"万日元",{pInc:String(nxt)},"不用花钱","看换工作或加薪的机会",["年收按申请时雇佣合同上的预定年收计算","换工作前先看“换工作申报”任务"],2);
  var lg=PL.pLang,canJa=lg==="ja"||lg==="both",canEn=lg==="en"||lg==="both";
  var RT=[
   ["神户大学MBA（周五晚上和周六上课）","ja",{pEdu:"25",pJd:"yes",pTop:"yes"},"1年半约108.6万日元，2年约135.4万日元","最短1年半，不用辞职",["国立大学的专门职学位课程，离大阪近","要通过入学考试","算分：经营管理专门职学位25分，在日本取得学位10分，指定大学10分（神户大学在入管厅的加分大学名单里，名单每年更新）"],3],
   ["美国金门大学在线MBA（可以用中文读）","zh",{pEdu:"25"},"中介报价约6.2万元人民币","约1至1.5年，不用辞职",["学校有美国地区性认证，但认证机构对它的远程教育发过关注通知","入学要有受认可大学的本科学位","算分：经营管理专门职学位25分；在线学位的实际审查口径请行政书士确认"],4],
   ["美国佐治亚理工学院在线计算机硕士","en",{pEdu:"20",pTop:"yes"},"总共约7,000至9,700美元","约2至3年，不用辞职",["全英文，要有计算机基础","算分：硕士20分，指定大学10分（该校在入管厅的加分大学名单里）","在线学位的实际审查口径请行政书士确认"],5],
   ["关西学院大学MBA（大阪梅田，平日晚上和周末）","ja",{pEdu:"25",pJd:"yes",pTop:"yes"},"2年约219万日元","2年，不用辞职",["在大阪梅田上课","算分：经营管理专门职学位25分，在日本取得学位10分，指定大学10分（关西学院大学在加分大学名单里）"],6],
   ["美国伊利诺伊大学香槟分校在线MBA","en",{pEdu:"25",pTop:"yes"},"约2.2万美元","约2至3年，不用辞职",["全英文","算分：经营管理专门职学位25分，指定大学10分（该校在入管厅的加分大学名单里）","在线学位的实际审查口径请行政书士确认"],7],
   ["GLOBIS经营大学院MBA（大阪校或在线）","ja",{pEdu:"25",pJd:"yes"},"2年约333万至353万日元","2年，晚上和周末上课",["没有入学笔试，看书面材料和面试","另有英语的在线课程","是否在指定大学名单里待核实，这里没有算那10分"],8],
   ["大阪公立大学 社会人大学院（都市经营专攻，大阪梅田）","ja",{pEdu:"20",pJd:"yes",pTop:"yes"},"2年约135.4万日元（大阪府民），府外的人约145.4万日元","2年，面向在职的人",["公立大学，在大阪梅田上课，报名要有3年以上社会经验","2026年4月起并入经营学研究科","算分：硕士20分，在日本取得学位10分，指定大学10分（是否在当年名单里请查入管厅名单）"],3.6],
   ["中国高校的同等学力申硕（多数可在线上课）","zh",{pEdu:"20"},"学费约3.2万至6.6万元人民币","课程1至2.5年，另要通过全国统考和论文答辩",["免试入学，但拿学位要过外语和学科综合的全国统考，再写论文答辩","要求拿到学士学位满3年","只发硕士学位证，没有研究生毕业证；入管是否按硕士算分请行政书士确认","费用出自招生媒体，以学校招生简章为准"],3.8],
   ["立命馆大学MBA（大阪梅田，平日晚上和周末）","ja",{pEdu:"25",pJd:"yes",pTop:"yes"},"2年约304万日元","2年，不用辞职",["在大阪梅田上课，周日也有课","成绩靠前的人每学期有10万日元奖学金","算分：经营管理专门职学位25分，在日本取得学位10分，指定大学10分（是否在当年名单里请查入管厅名单）"],7.5],
   ["英国爱丁堡大学在线数据科学硕士","en",{pEdu:"20",pTop:"yes"},"总共约19,100英镑","在职读约3年",["全英文","算分：硕士20分，指定大学10分（是否在当年名单里请查入管厅名单）","在线学位的实际审查口径请行政书士确认"],8.5],
   ["美国金门大学在线DBA","zh",{pEdu:"20"},"中介报价约15万至16万元人民币","约2至3年",["专门职博士按硕士的20分算，不是博士的30分","入学要有硕士学位，或本科学位加5年以上工作经验"],9]
  ];
  RT.forEach(function(r){if(r[1]==="ja"&&r[2].pEdu==="25")r[5]=r[5].concat(["学费补贴：课程如果是厚生劳动大臣指定的专门实践教育训练，雇用保险加入满2年（第一次领）的在职者可领回学费的50%，每年上限40万日元；毕业后条件满足最高到80%。这门课是否被指定，要在厚生劳动省的讲座检索系统里查"])});
  if(+PL.pEdu>=10)RT.forEach(function(r){var off=r[1]==="ja"&&!canJa?"要用日语上课":r[1]==="en"&&!canEn?"要用英语上课":"";tryIt(r[0],r[2],r[3],r[4],r[5],r[6],1,off)});
  if(cur.total<70&&!cand.some(function(c){return c.n>=70})){var best=null;
    cand.forEach(function(a,i){cand.slice(i+1).forEach(function(b){var s={};Object.keys(PL).forEach(function(k){s[k]=PL[k]});Object.keys(a.chg).forEach(function(k){s[k]=a.chg[k]});Object.keys(b.chg).forEach(function(k){if(k==="pEdu")s[k]=String(Math.max(+s[k],+b.chg[k]));else if(k==="pJp")s[k]=(s[k]==="n1"||b.chg[k]==="n1")?"n1":b.chg[k];else s[k]=b.chg[k]});
      var n=hspPoints(s).total,r=a.rank+b.rank;if(n>=70&&n>Math.max(a.n,b.n)&&(!best||r<best.r))best={a:a,b:b,n:n,r:r}})});
    if(best)o.push({name:"两样一起做："+best.a.name+"，加上"+best.b.name,price:"合计 "+best.n+" 分",sub:lvl(best.n),pts:["单做哪一样都到不了70分，这是花费最少、能到70分的组合","各自的花费和时间见下面对应的卡片"],src:["入管厅：高度人才积分表","https://www.moj.go.jp/isa/content/930001655.pdf"],st:"入管厅积分表推算",score:-5});
    else if(cand.length)o.push({name:"两样一起做也到不了70分",price:"要三样以上或换条路",sub:"请和行政书士商量整体安排",pts:["年龄和工作年数会随时间变化，可以隔一年再算"],src:["入管厅：高度人才积分表","https://www.moj.go.jp/isa/content/930001655.pdf"],st:"入管厅积分表推算",score:-5})}
  if(+PL.pEdu===0)o.push({name:"先取得学历",price:"现在学历分是0",sub:"请看“怎么取得学历”",pts:["大专或本科起算10分","高中学历的人先走专门学校或大学"],src:["入管厅：高度人才积分表","https://www.moj.go.jp/isa/content/930001655.pdf"],st:"入管厅",score:6});
  o.sort(function(a,b){return a.score-b.score});return o;
}
function planOptions(){return PL.topic==="budget"?budgetOptions():PL.topic==="points"?pointsOptions():PL.topic==="degree"?degreeOptions():PL.topic==="route"?routeOptions():PL.topic==="phone"?phoneOptions():PL.topic==="drive"?driveOptions():companyOptions()}
P = Object.assign({}, JSON.parse(JSON.stringify(DEF)), state.profile || {});
DONE = Object.assign({}, state.done || {});
if (state.plan) Object.keys(state.plan).forEach(function(k){ if (k in PL || k === 'subs') PL[k] = state.plan[k]; });
if (state.auth) Object.assign(AUTH, state.auth);
if (Array.isArray(state.events)) EVENTS = state.events;
function conv(x){ return typeof x === 'string' ? cny(x) : x }
function options(topic, params){
  if (!PLT.some(function(x){return x[0]===topic})) throw new Error('未知的方案主题：'+topic);
  PL.topic = topic; if (params) Object.keys(params).forEach(function(k){ if (k in PL && k !== 'topic' && k !== 'subs') PL[k] = String(params[k]); });
  return { topic: topic, note: planNote(), options: planOptions().map(function(o){ return Object.assign({}, o, { price: conv(o.price), sub: conv(o.sub), pts: (o.pts||[]).map(conv) }) }) };
}
function plan(){ var R = compute(), nq = nextQuest(R), pg = progress(R); return { profile: profileText(), next: nq ? { id: nq.id, title: nq.t } : null, level: pg.level, done: pg.done, total: pg.total, tasks: planData() } }
return { EVRULES: EVRULES, NODES: NODES, DEF: DEF, STAGES: STAGES, CATS: CATS, REGULATED: REGULATED, LINKS: LINKS, JOBS: JOBS, CITY: CITY, PLT: PLT, STATUS_NAME: STATUS_NAME, SYS: SYS, RATE: RATE,
  profile: P, compute: compute, progress: progress, nextQuest: nextQuest, plan: plan, reminders: reminders, eventDeadlines: function(ev){ return evDue(ev).map(function(x){ return { date: iso(x.d), txt: x.txt, src: x.src } }) }, advice: advice, prCheck: prCheck,
  options: options, hspPoints: function(s){ return hspPoints(Object.assign({}, PL, s||{})) }, kb: kb, profileText: profileText, linksOf: linksOf, jobFit: jobFit, cny: cny, fmt: fmt, isDate: isDate, today: today, iso: iso };
};
