/* 在留导航 网页端。路线、期限、提醒、判断、永驻体检、选方案都由服务器的接口算好（GET /plan、/reminders、/advice、/pr-check、/options），
   页面只负责显示和收集修改，不内嵌规则。页面要连着在留导航的服务器才能用（没有离线的演示模式）。
   页面上所有来自服务器、用户、服务商和助手的文字都用 textContent 或 el() 放进去，不拼 HTML。
   网页的内容安全策略（CSP）不允许内联的脚本、样式和 on…= 属性：脚本和样式都在单独的文件里；只做页面内操作、不提交的表单带 data-nosubmit（下面统一拦住提交）。 */
Array.prototype.forEach.call(document.querySelectorAll("form[data-nosubmit]"),function(f){f.addEventListener("submit",function(e){e.preventDefault()})});
// 新账号、“从零开始”用的空白概况（和服务器的空白概况一样，没有示例人物）
var EMPTY={status:"none",entry:"",addr:"",exp:"",ins:false,age:true,lic:false,pr:false,arrive:"",work:"",married:"",hsp:"0",jp:"",pay:true,trips:[]};
// 本机缓存：概况、进度、“我的资料”，以及上次和服务器对上的内容 base（多台设备同时修改时合并用，见 /merge.js）
var KEY="zairyu-demo-v3";
var P=clone(EMPTY), DONE={}, DOCS=[], BASE=null, SEL=null, DSEL=null, SNOOZE=null;
// 服务器给的数据：节点资料、路线（PLAN.view）、提醒、判断、永驻体检、同城示例、环节和服务商类别的对照、事件种类、选方案
var NODES=[], PLAN=null, VIEW=null, REM=[], ADV=[], PRC=null, CITYD=null, LINKS=[], CATS=[], EVTYPES=[], OPTS=null;
// 选方案：当前主题和用户选过的条件（各主题共用，例如电话卡的用量也用在第一年的预算里）
var PL={topic:"phone"}, PLV={};
var PLT=[["route","来日本走哪条路"],["degree","怎么取得学历"],["points","高度人才积分规划"],["phone","电话卡套餐"],["drive","驾照怎么拿"],["company","开公司费用"],["budget","第一年要准备多少钱"]];
var CT={tab:"job",fit:false};
var CTT=[["job","招聘"],["house","租房"],["used","二手转让"],["life","生活服务"]];
var CLS={A:"流程说明",B:"已帮你处理",C:"需要税理士判断",D:"需要行政书士制作",E:"需要行政书士判断",F:"不能帮这个忙",G:"不在服务范围"};
var HELLO="我在这儿。问我某个任务怎么办、要花多少钱，或者直接说“这个我办完了”。也可以让我整理一份去窗口用的清单。";
var busy=false, SRV=null; // SRV：连上服务器后由下面接后端的部分设好（get、why）
function clone(x){return JSON.parse(JSON.stringify(x))}
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function $(id){return document.getElementById(id)}
// "2026-11-24" 写成 "2026年11月24日"（只是换个写法，不算日期）
function ymdText(s){var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s||"");return m?(+m[1])+"年"+(+m[2])+"月"+(+m[3])+"日":""}
function nodeOf(id){return NODES.filter(function(x){return x.id===id})[0]}
function viewOf(id){return VIEW?VIEW.nodes.filter(function(x){return x.id===id})[0]:null}
function catName(k){var c=CATS.filter(function(x){return x.key===k})[0];return c?c.name:k}
function isRegulated(k){var c=CATS.filter(function(x){return x.key===k})[0];return !!(c&&c.regulated)}
var toastT=null;
// 提示停留的时间按字数加长（每字约 0.1 秒，2.6 至 8 秒），长的提示来得及读完
function toast(s){var t=$("toast");t.textContent=s;t.classList.add("on");clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove("on")},Math.min(8000,Math.max(2600,String(s).length*100)))}
// 给读屏软件念的提示（页面上看不见）：重新画的区块里新放进去的说明文字读屏不一定会念，所以另外放进这个一直在的 role="status"
var saidT=null;
function announce(s){var r=$("sr-status");if(!r||!s)return;r.textContent="";clearTimeout(saidT);saidT=setTimeout(function(){r.textContent=s},60)}
// 重新画一块内容之后，把焦点放回原来那个按钮（按 data-k 找），键盘用户不会被甩回页面开头
function keepFocus(fn){var a=document.activeElement,k=a&&a.getAttribute?a.getAttribute("data-k"):null;fn();if(k){var b=document.querySelector('[data-k="'+k+'"]');if(b&&b!==document.activeElement)b.focus({preventScroll:true})}}
// 对话框（同意、条款更新）：背后的页面设为 inert（读屏软件和 Tab 键都进不去），Tab 和 Shift+Tab 在对话框里循环，
// 打开时焦点放到 first 上；返回的函数关掉对话框、恢复背后的页面，焦点回到打开之前的地方
function openModal(w,first){
  var back=Array.prototype.filter.call(document.body.children,function(x){return x!==w&&x.tagName!=="SCRIPT"&&x.id!=="sr-status"&&x.id!=="toast"&&!x.hasAttribute("inert")});
  back.forEach(function(x){x.setAttribute("inert","")});
  var prev=document.activeElement;
  w.addEventListener("keydown",function(e){
    if(e.key!=="Tab")return;
    var f=Array.prototype.filter.call(w.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])"),function(x){return !x.disabled&&x.getClientRects().length>0});
    if(!f.length)return;var a=f[0],z=f[f.length-1];
    if(e.shiftKey&&(document.activeElement===a||!w.contains(document.activeElement))){e.preventDefault();z.focus()}
    else if(!e.shiftKey&&(document.activeElement===z||!w.contains(document.activeElement))){e.preventDefault();a.focus()}
  });
  document.body.appendChild(w);(first||w).focus();
  return function(){w.remove();back.forEach(function(x){x.removeAttribute("inert")});if(prev&&prev!==document.body&&document.contains(prev))prev.focus()};
}
function narrow(){return !!(window.matchMedia&&window.matchMedia("(max-width:640px)").matches)}
function smooth(){return window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"}
// 把焦点移到任务详情的标题并滚过去（手机上详情在关卡列表下面很远的地方）
function focusDetail(){var h=$("detail").querySelector("h2");if(!h)return;h.focus({preventScroll:true});$("detail").scrollIntoView({behavior:smooth(),block:"start"})}
function localSave(){try{localStorage.setItem(KEY,JSON.stringify({p:P,d:DONE,docs:DOCS,base:BASE}))}catch(e){}}
function load(){try{var o=JSON.parse(localStorage.getItem(KEY));if(o&&o.p){P=Object.assign(clone(EMPTY),o.p);DONE=o.d||{};DOCS=o.docs||[];BASE=o.base||null}}catch(e){}}
// 保存：先写本机，连着服务器时再发给服务器（下面接后端的部分把 push 换成真的发送）
var pushHook=function(){};
function save(){localSave();pushHook()}

/* ---------- 闯关 ---------- */
var afterSave=[]; // 存上之后（路线重新算好）要做的事，例如完成任务后的提示
function complete(id,on){
  var before=VIEW;
  if(on)DONE[id]=1;else delete DONE[id];save();renderRoute();
  afterSave.push(function(){
    if(!before||!VIEW)return;
    var n=nodeOf(id),vb=function(i){return before.nodes.filter(function(x){return x.id===i})[0]};
    if(on){
      var msg="完成“"+(n?n.t:id)+"” +"+((viewOf(id)||{}).xp||0)+" 经验";
      var un=VIEW.nodes.filter(function(x){var b=vb(x.id);return b&&b.state==="locked"&&x.state==="todo"}).map(function(x){return x.title});
      if(VIEW.level>before.level){
        msg+="，通关升到等级 "+VIEW.level+"。纪念卡已放进“我的资料”";
        var ci=VIEW.clear.map(function(c,i){return c&&!before.clear[i]?i:-1}).filter(function(i){return i>=0})[0];
        if(ci!=null)addDoc("纪念卡","第"+ci+"关“"+VIEW.stages[ci]+"”通关纪念","在留导航 通关纪念\n\n第"+ci+"关 "+VIEW.stages[ci]+"\n通关日期："+ymdText(VIEW.today)+"\n\n这一关办完的事：\n"+VIEW.nodes.filter(function(x){return x.stage===ci&&x.state==="done"}).map(function(x){return "・"+x.title}).join("\n")+"\n\n这些都是你自己一件一件办下来的。");
      }else if(un.length)msg+="，解锁："+un.join("、");
      toast(msg);
    }
    SEL=VIEW.next||id;renderRoute();
  });
}
// 重画时焦点留在原来的按钮上（见 keepFocus）
function renderRoute(){keepFocus(drawRoute)}
function drawRoute(){
  var nx=$("next"),route=$("route"),hb=$("h-badges");
  if(!VIEW||!NODES.length){$("h-title").textContent="正在读取你的路线…";nx.textContent="";route.textContent="";hb.textContent="";$("detail").textContent="";return}
  var V=VIEW;
  if(!SEL||!viewOf(SEL)||!nodeOf(SEL))SEL=V.next||V.nodes[0].id;
  $("h-lv").textContent=V.level;$("h-title").textContent=V.titles[Math.min(V.level-1,V.titles.length-1)];
  var pct=V.max?Math.round(V.xp/V.max*100):0;$("h-bar").style.width=pct+"%";$("h-xp").setAttribute("aria-valuenow",String(pct));$("h-xp").setAttribute("aria-valuetext","经验 "+V.xp+" / "+V.max);
  $("h-nums").textContent="经验 "+V.xp+" / "+V.max+"　已完成 "+V.done+" / "+V.total+" 个任务";
  var hard=V.legalDone,left=V.total-V.done,dj=V.dayInJapan;
  $("h-cheer").textContent=(dj>0?"来日本第 "+dj+" 天。":"")+(V.done?"你已经办完 "+V.done+" 件事"+(hard?"，其中 "+hard+" 件是有法定期限的":"")+"。":"第一步最难，从上面这一件开始就行。")+(left>0?"剩下 "+left+" 件不用一次办完，按顺序来。":"这条路线上的任务全部完成了。");
  hb.textContent="";V.stages.forEach(function(name,i){hb.appendChild(el("span","badge"+(V.clear[i]?" got":""),name+(V.clear[i]?" 通关":"")))});
  nx.textContent="";
  var nq=V.next?nodeOf(V.next):null,r=V.next?viewOf(V.next):null;
  if(nq&&r){var L=el("div");L.appendChild(el("div","k","下一步"));L.appendChild(el("h2",null,nq.t));
    var f=el("div","facts");[["期限",r.due?r.dueText:"无法定期限"],["费用",nq.cost],["用时",nq.time]].forEach(function(x){var s=el("span");s.appendChild(el("b",null,x[0]+"　"));s.appendChild(document.createTextNode(x[1]));f.appendChild(s)});L.appendChild(f);
    var calm="";if(r.due){var dn2=r.dueDays;calm=dn2<0?"已经过了期限 "+(-dn2)+" 天。先别慌，尽快去补办，越早越好；会不会有不利影响可以问助手。":dn2<=3?"还有 "+dn2+" 天，时间紧但来得及，按下面的步骤带齐东西去一次就能办完。":"还有 "+dn2+" 天，来得及。"}else calm="这件事没有法定期限，挑一个方便的日子办。";
    L.appendChild(el("small",null,calm));nx.appendChild(L);
    if(SNOOZE&&SNOOZE===V.today){var z=el("button","ghost","今天休息中，点这里继续");z.type="button";z.onclick=function(){SNOOZE=null;renderRoute()};nx.appendChild(z)}
    else{var z2=el("button","ghost","今天先不办");z2.type="button";z2.onclick=function(){SNOOZE=V.today;toast("好，今天先休息，明天再提醒你。");renderRoute()};nx.appendChild(z2)}
    var b=el("button","act gold","看怎么办");b.type="button";b.onclick=function(){SEL=nq.id;renderRoute();focusDetail()};nx.appendChild(b);
  }else{nx.appendChild(el("h2",null,"当前没有待办任务"))}
  route.textContent="";
  V.stages.forEach(function(name,i){
    var ns=V.nodes.filter(function(n){return n.stage===i}),app=ns.filter(function(n){return n.state!=="na"}),dn=app.filter(function(n){return n.state==="done"}).length;
    var col=el("div","stage"+(V.clear[i]?" clear":"")),h=el("h3");h.appendChild(el("b",null,"第"+i+"关 "+name));h.appendChild(el("span",null,app.length?dn+"/"+app.length:"不适用"));col.appendChild(h);
    var sb=el("div","sbar"),si=el("i");si.style.width=(app.length?Math.round(dn/app.length*100):0)+"%";sb.appendChild(si);col.appendChild(sb);
    ns.forEach(function(r){
      var b=el("button","node "+r.state+(r.due&&r.state==="todo"?" due":""));b.type="button";b.setAttribute("aria-pressed",r.id===SEL?"true":"false");b.setAttribute("data-k","node-"+r.id);b.setAttribute("aria-controls","detail");
      b.appendChild(el("span",null,(r.state==="done"?"✓ ":"")+r.title));
      var sub=r.due&&r.state==="todo"?r.dueText:(r.note||(r.state==="todo"?"待办":""));if(sub)b.appendChild(el("small",null,sub));
      if(r.state==="todo")b.appendChild(el("span","xpv","+"+r.xp+" 经验"));
      b.onclick=function(){SEL=r.id;renderRoute();if(narrow())focusDetail()};col.appendChild(b);
    });
    route.appendChild(col);
  });
  renderDetail();
}
function renderDetail(){
  var n=nodeOf(SEL),r=viewOf(SEL),d=$("detail");d.textContent="";if(!n||!r)return;
  var dh=el("h2",null,n.t);dh.tabIndex=-1;d.appendChild(dh);d.appendChild(el("p","sum",n.sum));
  var two=el("div","two"),a=el("div","box"),b=el("div","box");
  a.appendChild(el("h3",null,"怎么办"));var ol=el("ol","steps");n.steps.forEach(function(s){ol.appendChild(el("li",null,s))});a.appendChild(ol);
  b.appendChild(el("h3",null,"费用和时间"));var tb0=el("table");[["费用",n.cost],["用时",n.time],["期限",r.due?r.dueText:(r.note||"无法定期限")]].forEach(function(x){var tr=el("tr");tr.appendChild(el("th",null,x[0]));tr.appendChild(el("td",null,x[1]));tb0.appendChild(tr)});b.appendChild(tb0);
  two.appendChild(a);two.appendChild(b);d.appendChild(two);
  var row=el("div","row");
  if(r.state==="todo"){var c=el("button","act gold","办完了，领 "+r.xp+" 经验");c.type="button";c.setAttribute("data-k","done-toggle");c.onclick=function(){complete(n.id,true)};row.appendChild(c)}
  else if(r.state==="done"){var u=el("button","ghost","取消完成");u.type="button";u.setAttribute("data-k","done-toggle");u.onclick=function(){complete(n.id,false)};row.appendChild(u)}
  else row.appendChild(el("span",null,"当前状态："+(r.note||"未解锁")));
  var mk=el("button","ghost","生成办事准备单");mk.type="button";mk.onclick=function(){prepSheet(n.id)};row.appendChild(mk);
  var ask=el("button","ghost","问助手");ask.type="button";ask.onclick=function(){openDrawer()};row.appendChild(ask);
  LINKS.filter(function(x){return x.nodeId===n.id}).forEach(function(x){var g=el("button","ghost","找"+x.categoryName+"帮忙");g.type="button";g.title=x.what;g.onclick=function(){quickInquiry(x.nodeId,x.category)};row.appendChild(g)});
  d.appendChild(row);
  var dt=el("details");dt.style.marginTop="14px";dt.appendChild(el("summary",null,"要点和官方依据"));
  if(n.pending){dt.open=true;dt.appendChild(el("p","notice pending","资料整理中：这一项的大部分数据还没对照官方页面核实，先只给官方链接。"))}
  var tw=el("div","tw"),tb=el("table");
  n.rows.forEach(function(x){var tr=el("tr");tr.appendChild(el("th",null,x.key));var td=el("td",null,x.value);td.appendChild(el("span","tag"+(x.verified?" ok":""),x.verified?"已对照官方页面":"待核实"));tr.appendChild(td);tb.appendChild(tr)});
  tw.appendChild(tb);if(n.rows.length)dt.appendChild(tw);
  if(n.reg)dt.appendChild(el("div","reg",n.reg));
  var s=el("div","src","依据：");
  n.src.forEach(function(x,i){if(i)s.appendChild(document.createTextNode("、"));var l=el("a",null,x[0]);l.href=x[1];l.target="_blank";l.rel="noopener";s.appendChild(l)});
  s.appendChild(document.createTextNode("。核对日期："+(n.checked?ymdText(n.checked):"未记录")+"。"));dt.appendChild(s);d.appendChild(dt);
  $("d-ctx").textContent="正在看："+n.t;
}

/* ---------- 给你的判断、提醒、永驻体检 ---------- */
function renderAdvice(){
  var ul=$("advice");ul.textContent="";
  ADV.forEach(function(x){var li=el("li"),sp=el("span");sp.appendChild(el("b",null,x.title+"　"));sp.appendChild(document.createTextNode(x.text));li.appendChild(sp);if(x.href){var a=el("a",null,x.action||"去看看");a.href=x.href;li.appendChild(a)}ul.appendChild(li)});
}
function renderRem(){
  var ul=$("rem");ul.textContent="";
  REM.forEach(function(x){var li=el("li"),sp=el("span",null,x.text);if(x.tag)sp.appendChild(el("span","tag info",x.tag));
    // 事件期限带法条和官方页面的链接；只接受 https 的地址
    if(x.src)[{title:"依据："+x.src.law+"（"+x.src.title+"）",url:x.src.url}].concat(x.src.more||[]).forEach(function(u){if(!/^https:\/\//.test(u.url))return;var a=el("a","rem-src",u.title);a.href=u.url;a.target="_blank";a.rel="noopener";sp.appendChild(a)});
    li.appendChild(sp);
    var n=x.days;li.appendChild(el("time",null,x.dateText+(n===0?"（今天）":n>0?"（"+n+"天后）":"（已过"+(-n)+"天）")));ul.appendChild(li)});
}
function tripDays(a,b){return Math.round((Date.parse(b+"T00:00:00Z")-Date.parse(a+"T00:00:00Z"))/864e5)}
function renderPR(){
  var tb=$("trips");tb.textContent="";var h=el("tr");["出国","回国","天数",""].forEach(function(x){h.appendChild(el("th",null,x))});tb.appendChild(h);
  P.trips.forEach(function(x,i){var tr=el("tr");tr.appendChild(el("td",null,x[0]));tr.appendChild(el("td",null,x[1]));tr.appendChild(el("td",null,String(tripDays(x[0],x[1]))));
    var td=el("td"),b=el("button","ghost","删除");b.type="button";b.setAttribute("aria-label","删除 "+x[0]+" 至 "+x[1]+" 的出国记录");b.onclick=function(){P.trips.splice(i,1);save();renderPR();$("t-from").focus()};td.appendChild(b);tr.appendChild(td);tb.appendChild(tr)});
  var o=$("pr-out");o.textContent="";if(!PRC){$("pr-when").textContent="";return}
  PRC.rows.forEach(function(x){var tr=el("tr");tr.appendChild(el("th",null,x[0]));var td=el("td",null,x[1]);
    td.appendChild(el("span","tag "+(x[2]==="ok"?"ok":x[2]==="bad"?"bad":""),x[2]==="ok"?"达到":x[2]==="bad"?"未达到":"待确认"));
    if(x[4])td.appendChild(el("span","tag","标准待核实"));
    if(x[3]!=null){var bar=el("div","bar"+(x[2]==="bad"&&x[4]?" bad":"")),i=el("i");i.style.width=Math.round(x[3]*100)+"%";bar.appendChild(i);td.appendChild(bar)}
    tr.appendChild(td);o.appendChild(tr)});
  $("pr-when").textContent=PRC.when?(PRC.reached?"按在留年数，现在已达到可申请的年限。":"按在留年数，最早可申请的时点约为 "+PRC.whenText+"。")+" 新指南原则上适用于2027年4月1日以后的申请。":(PRC.why||"");
}

/* ---------- 找人帮忙：每个环节找谁 ---------- */
var PVNODE=null; // 一键对接时的环节（GET /api/links 的一行）
function renderLinks(){
  var tb=$("lk-body");tb.textContent="";
  LINKS.forEach(function(x){var tr=el("tr");tr.appendChild(el("th",null,x.title));tr.appendChild(el("td",null,x.categoryName));tr.appendChild(el("td",null,x.what));
    var td=el("td"),b=el("button","ghost","一键对接");b.type="button";b.onclick=function(){quickInquiry(x.nodeId,x.category)};td.appendChild(b);tr.appendChild(td);tb.appendChild(tr)});
}
// 下面接后端的部分换成真的（读名单、发咨询）
var quickInquiry=function(){},renderPV=function(){},renderInq=function(){};
// 发给服务商的情况说明：身份、日期、已办完和正在办的事、“我的资料”里的几份资料、咨询的环节
function packText(){
  var o=$("f-status").querySelector('option[value="'+P.status+'"]'),dn=VIEW?VIEW.nodes.filter(function(n){return n.state==="done"}).map(function(n){return n.title}):[],nq=VIEW&&VIEW.next?viewOf(VIEW.next):null;
  return "身份："+(o?o.textContent:"未填")+"\n入境日："+(P.entry||"未填")+"　在留期满日："+(P.exp||"未填")+"\n已办完："+(dn.length?dn.join("、"):"无")+"\n正在办："+(nq?nq.title:"无")+"\n可提供的资料："+(DOCS.length?DOCS.slice(0,5).map(function(d){return d.title}).join("、"):"暂无")+(PVNODE?"\n咨询事项："+PVNODE.title+"（"+PVNODE.what+"）\n对方一般会要的资料："+PVNODE.bring+"（以对方给的清单为准）":"")+"\n（不含个人编号和银行账号）";
}

/* ---------- 助手（随时呼出） ---------- */
function pushMsg(role,text){var m=el("div","msg "+role);if(role==="a"){m.appendChild(el("span","cls",""));m.appendChild(el("span","body",text))}else m.textContent=text;$("chat").appendChild(m);$("chat").scrollTop=$("chat").scrollHeight;return m}
function setAns(m,text){var mm=/^\s*【([A-G])】\s*/.exec(text);m.querySelector(".cls").textContent=mm?CLS[mm[1]]:"";m.querySelector(".body").textContent=mm?text.slice(mm[0].length):text;$("chat").scrollTop=$("chat").scrollHeight}
var ask=function(){$("ask-state").textContent="连不上服务器，助手暂时不能用。页面顶部连上之后再问。"};
function chips(){var n=nodeOf(SEL),box=$("chips");box.textContent="";
  [(n?"“"+n.t+"”怎么办？要多少钱？":"住民登记怎么办？"),"这个我办完了","我现在最该办什么？","帮我准备去窗口用的日语"].forEach(function(q){var b=el("button",null,q);b.type="button";b.onclick=function(){ask(q)};box.appendChild(b)})}
function openDrawer(){$("drawer").classList.add("on");$("fab").hidden=true;$("fab").setAttribute("aria-expanded","true");chips();$("ask-t").focus()}
// 收起后焦点回到“问助手”按钮
function closeDrawer(){$("drawer").classList.remove("on");$("fab").hidden=false;$("fab").setAttribute("aria-expanded","false");$("fab").focus()}

/* ---------- 同城：分类信息（示例占位，数据和“能不能做”由服务器给） ---------- */
// 重画时焦点留在原来的按钮上（见 keepFocus）
function renderCity(){keepFocus(drawCity)}
function drawCity(){
  var tabs=$("ct-tabs");tabs.textContent="";CTT.forEach(function(x){var b=el("button",x[0]===CT.tab?"act":"ghost",x[1]);b.type="button";b.setAttribute("aria-pressed",x[0]===CT.tab?"true":"false");b.setAttribute("data-k","ct-"+x[0]);b.onclick=function(){CT.tab=x[0];renderCity()};tabs.appendChild(b)});
  var f=$("ct-filter");f.textContent="";var list=$("ct-list");list.textContent="";
  if(!CITYD)return;
  function card(title,sub,place,tagc,tagt){var c=el("div","card");c.appendChild(el("b",null,title+"（示例）"));c.appendChild(el("small",null,sub));c.appendChild(el("small",null,place));
    var p=el("div");p.appendChild(el("span","tag ok","发布方已核验"));if(tagt)p.appendChild(el("span","tag "+tagc,tagt));c.appendChild(p);list.appendChild(c)}
  if(CT.tab==="job"){
    var l=el("label","check");l.htmlFor="ct-fit";var cb=el("input");cb.type="checkbox";cb.id="ct-fit";cb.setAttribute("data-k","ct-fit");cb.checked=CT.fit;cb.onchange=function(){CT.fit=cb.checked;renderCity()};l.appendChild(cb);l.appendChild(document.createTextNode("只看我现在的身份可以做的"));f.appendChild(l);
    f.appendChild(el("p","lead","每条招聘都按你的在留资格标出能不能做。这是一般情况的提示，换工作前的个别判断请找行政书士。"));
    CITYD.jobs.forEach(function(j){if(CT.fit&&j.fit!=="ok")return;card(j.title,j.type+"　薪资和工作时间由企业填写",j.place,j.fit==="ok"?"ok":j.fit==="warn"?"info":"bad",j.fitText)});
    if(!list.firstChild)list.appendChild(el("small",null,"按你现在的身份没有可以做的示例职位。"));
  }else{
    f.appendChild(el("p","lead",CT.tab==="house"?"租房信息和“租房”任务相通：看中后可以直接对接不动产，或请陪同翻译。":CT.tab==="used"?"回国转让的二手物品，当面交易。":"生活服务的商家，签约前请确认营业主体。"));
    CITYD[CT.tab].forEach(function(x){card(x.title,x.sub,x.place,"","")});
  }
}

/* ---------- 选方案：服务器按情况排好，页面只显示 ---------- */
var optN=0;
function loadOptions(){
  if(!SRV)return Promise.resolve();
  var n=++optN,t=PL.topic,qs=Object.keys(PLV).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(PLV[k])}).join("&");
  return SRV.get("/options/"+t+(qs?"?"+qs:"")).then(function(r){if(n!==optN)return;OPTS=r;renderPlans()},function(e){if(n===optN){OPTS=null;renderPlans();$("pl-note").textContent="方案没有读出来："+SRV.why(e)}});
}
// 重画时焦点留在原来的按钮上（见 keepFocus）
function renderPlans(){keepFocus(drawPlans)}
function drawPlans(){
  var tabs=$("pl-tabs");tabs.textContent="";PLT.forEach(function(x){var b=el("button",x[0]===PL.topic?"act":"ghost",x[1]);b.type="button";b.setAttribute("aria-pressed",x[0]===PL.topic?"true":"false");b.setAttribute("data-k","pl-"+x[0]);b.onclick=function(){PL.topic=x[0];OPTS=null;renderPlans();loadOptions()};tabs.appendChild(b)});
  var q=$("pl-q");q.textContent="";var list=$("pl-list");list.textContent="";
  var ready=OPTS&&OPTS.topic===PL.topic,cur=ready?Object.assign({},OPTS.defaults,OPTS.given):PLV;
  function sel(id,label,key,opts){var l=el("label",null,label);l.htmlFor=id;var s=el("select");s.id=id;s.setAttribute("data-k","sel-"+id);opts.forEach(function(o){var e=el("option",null,o[1]);e.value=o[0];s.appendChild(e)});if(cur[key]!=null)s.value=cur[key];s.onchange=function(){PLV[key]=s.value;loadOptions()};l.appendChild(s);q.appendChild(l)}
  if(PL.topic==="phone"){sel("pq-u","每月流量","usage",[["3","3GB 左右"],["10","10GB 左右"],["30","30GB 左右"],["max","基本不限量"]]);sel("pq-c","有日本的信用卡吗","card",[["no","还没有"],["yes","有"]]);sel("pq-s","需要门店当面办理吗","shop",[["no","不需要，网上办就行"],["yes","需要"]])}
  else if(PL.topic==="drive"){q.appendChild(el("span",null,"中国驾照："+(P.lic?"有，且取得后在中国住满3个月":"没有符合条件的")+"（在“我的情况”里修改）"));sel("pq-t","能连续空出两周吗","time",[["no","不能"],["yes","能"]])}
  else if(PL.topic==="budget"){sel("pb-l","每人每月生活费（不含房租，自己估）","bLife",[["6","6万日元，很省"],["9","9万日元，一般"],["12","12万日元，宽裕"]])}
  else if(PL.topic==="points"){sel("pp-e","最高学历","pEdu",[["0","高中或专门士"],["10","大专、本科"],["20","硕士或专门职博士"],["25","MBA等经营管理专门职学位"],["30","博士"]]);sel("pp-a","年龄","pAge",[["29","29岁以下"],["34","30至34岁"],["39","35至39岁"],["45","40岁以上"]]);sel("pp-i","年收","pInc",[["250","不到300万日元"],["300","300万至399万"],["400","400万至499万"],["500","500万至599万"],["600","600万至699万"],["700","700万至799万"],["800","800万至899万"],["900","900万至999万"],["1000","1,000万以上"]]);sel("pp-x","相关工作年数","pExp",[["0","不到3年"],["3","3至4年"],["5","5至6年"],["7","7至9年"],["10","10年以上"]]);sel("pp-j","日语","pJp",[["none","没有N2以上"],["n2","N2"],["n1","N1"]]);sel("pp-d","在日本取得过学位吗","pJd",[["no","没有"],["yes","有"]]);sel("pp-t","毕业的大学在加分大学名单里吗","pTop",[["no","不在或不清楚"],["yes","在"]]);sel("pp-c","和工作相关的国家资格或信息处理考试","pCert",[["0","没有"],["1","有1项"],["2","有2项以上"]]);sel("pp-l","能用哪种语言上课","pLang",[["zh","只能用中文"],["en","能用英语"],["ja","能用日语"],["both","英语日语都行"]])}
  else if(PL.topic==="degree"){sel("pq-e","现在的最高学历","edu",[["hs","高中"],["jc","大专"],["ba","本科及以上"]]);sel("pq-g","目标","goal",[["work","满足就职类在留资格的学历要件"],["points","给高度人才积分加分"]])}
  else if(PL.topic==="route"){sel("pq-d","有大学或日本专门学校的学历吗","deg",[["yes","有"],["no","没有"]]);sel("pq-o","有日本公司的录用或雇佣合同吗","offer",[["no","还没有"],["yes","有"]]);sel("pq-p","配偶或父母已在日本长期居留吗","spouse",[["no","没有"],["yes","有"]]);sel("pq-j","配偶是日本人或永住者吗","jsp",[["no","不是"],["yes","是"]])}
  else sel("pq-v","要靠这家公司申请经营·管理签证吗","visa",[["no","不需要，我已有其他在留资格"],["yes","需要"]]);
  if(!ready){$("pl-note").textContent="正在按你的情况排方案…";return}
  var first=true;
  OPTS.options.forEach(function(o){var c=el("div","card"+(first&&!o.off?" best":""));
    if(first&&!o.off){c.appendChild(el("span","tag info","最适合你现在的情况"));first=false}
    c.appendChild(el("h3",null,o.name));c.appendChild(el("div","price",o.price));c.appendChild(el("small",null,o.sub));
    var ul=el("ul");o.pts.forEach(function(p){ul.appendChild(el("li",null,p))});c.appendChild(ul);
    if(o.off)c.appendChild(el("span","tag bad",o.off));
    if((PL.topic==="points"&&o.link)||(PL.topic==="degree"&&!o.off&&o.name!=="不靠学历，靠实务经验"&&o.name!=="先拿不用读学位的加分")){var rw2=el("div","row");rw2.style.marginTop="6px";(o.name==="先确认现有学历够不够"?["gyosei"]:["edu","gyosei"]).forEach(function(k){var g=el("button","ghost","找"+catName(k));g.type="button";g.onclick=function(){quickInquiry("deg",k)};rw2.appendChild(g)});c.appendChild(rw2)}
    if(PL.topic==="company"){var rw=el("div","row");rw.style.marginTop="6px";(cur.visa==="yes"?["gyosei","shiho","zeirishi"]:["shiho","zeirishi"]).forEach(function(k){var g=el("button","ghost","找"+catName(k));g.type="button";g.onclick=function(){quickInquiry("co",k)};rw.appendChild(g)});c.appendChild(rw)}
    if(o.st)c.appendChild(el("small",null,"依据："+o.st));
    var a=el("a",null,"来源："+o.src[0]);a.href=o.src[1];a.target="_blank";a.rel="noopener";a.className="src-link";c.appendChild(a);
    // 每套方案的核对日期（data/options.json 的 checkedOn）
    if(o.checkedOn)c.appendChild(el("small","checked-on","核对日期："+ymdText(o.checkedOn)));
    list.appendChild(c)});
  $("pl-note").textContent=OPTS.note+(OPTS.rate?" 人民币按"+OPTS.rate.on+"的人民币汇率中间价折算（100日元 = "+OPTS.rate.value+"元），实际以换汇当天为准。":"");
}

/* ---------- 我的资料：查看和下载（只存在这台设备的浏览器里） ---------- */
var FOOT="\n\n——\n本资料为一般信息整理，不是递交给官方的文书，也不构成法律或税务意见。节点内容的核对日期见各节点“要点和官方依据”的最后一行，尚未经专业审核。";
function addDoc(kind,title,body,node){var d={id:"d"+Date.now()+Math.floor(Math.random()*1000),kind:kind,title:title,body:body,node:node||"",at:ymdText(VIEW?VIEW.today:"")};DOCS.unshift(d);if(DOCS.length>30)DOCS.length=30;DSEL=d.id;localSave();renderDocs();return d}
// 重画时焦点留在原来的按钮上（见 keepFocus）
function renderDocs(){keepFocus(drawDocs)}
function drawDocs(){
  var ul=$("doc-list");ul.textContent="";
  if(!DOCS.length)ul.appendChild(el("li",null,"还没有资料。在任务里点“生成办事准备单”，或生成路线清单。"));
  DOCS.forEach(function(d){var li=el("li"),b=el("button","ghost doc-pick",d.title);b.type="button";b.setAttribute("aria-pressed",d.id===DSEL?"true":"false");b.setAttribute("data-k","doc-"+d.id);b.onclick=function(){DSEL=d.id;renderDocs()};var sp=el("span");sp.appendChild(b);sp.appendChild(el("span","tag info",d.kind));li.appendChild(sp);li.appendChild(el("time",null,d.at));ul.appendChild(li)});
  var d=DOCS.filter(function(x){return x.id===DSEL})[0];
  $("dv-title").textContent=d?d.title:"选择一份资料查看";$("dv-body").hidden=!d;$("dv-acts").hidden=!d;$("dv-body").textContent=d?d.body:"";$("dv-note").textContent="";
}
function downloadDoc(){
  var d=DOCS.filter(function(x){return x.id===DSEL})[0];if(!d)return;
  try{var url=URL.createObjectURL(new Blob([d.title+"\n"+d.at+"\n\n"+d.body],{type:"text/plain;charset=utf-8"})),a=el("a");a.href=url;a.download=d.title.replace(/[\\/:*?"<>|]/g,"")+".txt";document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url)},1000);$("dv-note").textContent="已开始下载。"}
  catch(e){$("dv-note").textContent="这个浏览器里不能下载，请复制上面的文字。"}
}
function sheetText(n,r){
  var s="【办事准备单】"+n.t+"\n\n"+n.sum+"\n\n期限："+(r.due?r.dueText:(r.note||"无法定期限"))+"\n费用："+n.cost+"\n用时："+n.time+"\n\n怎么办：\n";
  n.steps.forEach(function(x,i){s+=(i+1)+". "+x+"\n"});
  s+="\n要点：\n";n.rows.forEach(function(x){s+="- "+x.key+"："+x.value+((x.verified||/待/.test(x.value))?"":"（待核实）")+"\n"});
  if(n.reg)s+="\n提示："+n.reg+"\n";
  s+="\n官方依据：\n";n.src.forEach(function(x){s+="- "+x[0]+" "+x[1]+"\n"});
  return s;
}
function prepSheet(id){
  var n=nodeOf(id),r=viewOf(id);if(!n||!r)return;
  addDoc("办事准备单","办事准备单 "+n.t,sheetText(n,r)+"\n窗口用日语：可以在助手里说“帮我准备去窗口用的日语”。"+FOOT,id);
  toast("已生成，在“我的资料”里查看和下载");location.hash="#docs";
}
function routeSheet(){
  if(!VIEW||!PLAN){toast("路线还没有读出来，请稍后再试");return}
  var s="【我的路线清单】\n\n"+PLAN.profile+"\n等级 "+VIEW.level+"，已完成 "+VIEW.done+" / "+VIEW.total+" 个任务\n";
  VIEW.stages.forEach(function(name,i){var ns=VIEW.nodes.filter(function(n){return n.stage===i&&n.state!=="na"});if(!ns.length)return;s+="\n第"+i+"关 "+name+"\n";ns.forEach(function(r){var n=nodeOf(r.id)||{};
    s+="  ["+(r.state==="done"?"已完成":r.state==="todo"?"待办":"未解锁")+"] "+r.title+(r.due&&r.state==="todo"?"　期限 "+r.dueFmt:"")+"　费用："+(n.cost||"")+"\n"})});
  addDoc("路线清单","我的路线清单 "+ymdText(VIEW.today),s+FOOT,"");
}

/* ---------- 绑定和路由 ---------- */
function bind(){
  var m={"f-status":"status","f-entry":"entry","f-addr":"addr","f-exp":"exp","f-ins":"ins","f-age":"age","f-lic":"lic","f-pr":"pr","p-arrive":"arrive","p-married":"married","p-work":"work","p-hsp":"hsp","p-jp":"jp","p-pay":"pay"};
  Object.keys(m).forEach(function(id){var e=$(id),k=m[id],chk=e.type==="checkbox";if(chk)e.checked=!!P[k];else e.value=P[k]||"";
    e.onchange=function(){P[k]=chk?e.checked:e.value;save();SEL=null;renderPR();if(PL.topic==="drive")renderPlans()}});
}
function renderAll(){renderLinks();renderCity();renderRoute();renderAdvice();renderInq();renderRem();renderPR();renderPV();renderDocs();renderPlans();if($("drawer").classList.contains("on"))chips()}
function show(){
  var v=(location.hash||"#route").slice(1);if(!$("v-"+v))v="route";
  Array.prototype.forEach.call(document.querySelectorAll(".view"),function(x){x.classList.toggle("on",x.id==="v-"+v)});
  Array.prototype.forEach.call(document.querySelectorAll("#nav a"),function(a){if(a.getAttribute("href")==="#"+v)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current")});
}
// “从零开始”：清空概况和进度（接后端的部分会先确认）
var fresh0=function(){P=clone(EMPTY);P.status="short";P.pr=true;DONE={};SEL=null;save();bind();renderPR();toast("已从第0关重新开始")};
$("fresh").onclick=function(){fresh0()};
$("t-add").onclick=function(){var a=$("t-from").value,b=$("t-to").value;if(a&&b&&b>=a){P.trips.push([a,b]);P.trips.sort();save();renderPR();$("t-from").value="";$("t-to").value=""}else toast("请填出国和回国日期，回国不能早于出国")};
$("ask-b").onclick=function(){var t=$("ask-t"),q=t.value.trim();t.value="";ask(q)};
$("ask-t").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();$("ask-b").click()}});
$("drawer").addEventListener("keydown",function(e){if(e.key==="Escape"){e.preventDefault();closeDrawer()}});
$("mk-route").onclick=routeSheet;$("dv-dl").onclick=downloadDoc;
$("dv-del").onclick=function(){DOCS=DOCS.filter(function(x){return x.id!==DSEL});DSEL=DOCS[0]?DOCS[0].id:null;localSave();renderDocs()};
$("fab").onclick=openDrawer;$("d-close").onclick=closeDrawer;
window.addEventListener("hashchange",show);
load();bind();renderAll();show();pushMsg("a",HELLO);
// ---- 接后端：数据存到服务器，路线、提醒、助手和对接都走服务器的接口 ----
(function(){
  if(!/^https?:$/.test(location.protocol)){var s0=$("sync-state");s0.hidden=false;s0.textContent="这个页面要通过在留导航的服务器打开才能用。";return}
  // AK：账号；DK：本机有修改还没存到服务器（值是账号 id）；OK：本机缓存的概况属于哪个账号
  var AK="zairyu-account",DK="zairyu-unsaved",OK="zairyu-cache-owner";
  var acct=null,started=false,installed=false,booting=false,bootT=null,bootN=0,gone=false;
  var timer=null,retryT=null,retryN=0,sending=null,again=false,unsaved=false;
  var PROV=[],PICK={},SINQ=[],SHOWN="";
  function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
  function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
  function lsDel(k){try{localStorage.removeItem(k)}catch(e){}}
  try{acct=JSON.parse(lsGet(AK))}catch(e){}
  if(!acct||typeof acct.id!=="string"||typeof acct.token!=="string")acct=null;
  // 请求失败时 e.status：0 是连不上，其余是服务器返回的状态码；e.said 表示服务器给了说明文字
  function api(m,path,b,keep){
    return fetch("/api"+path,{method:m,keepalive:!!keep,headers:Object.assign({"content-type":"application/json"},acct?{authorization:"Bearer "+acct.token}:{}),body:b?JSON.stringify(b):undefined})
    .then(function(r){
      if(!r.ok){return r.json().catch(function(){return {}}).then(function(j){var e=new Error(j&&typeof j.error==="string"?j.error:String(r.status));e.body=j;e.status=r.status;e.said=!!(j&&typeof j.error==="string");throw e})}
      return r.status===204?null:r.json()},function(){var e=new Error("连不上服务器");e.status=0;throw e});
  }
  // 给用户看的失败原因。422（内容没通过检查，例如疑似含有护照号、银行账号）、429（太频繁）、403（刚找回的设备暂时不能换绑邮箱）等直接用服务器的说明
  function why(e){
    if(e.status===0)return "连不上服务器，请检查网络后再试。";
    if(e.said&&(e.status===422||e.status===429||e.status===409||e.status===403||e.status===413||e.status===400))return e.message;
    if(e.status===401)return "登录已失效，请刷新页面。";
    return "服务器出了点问题，请稍后再试。";
  }
  // 顶部的同步状态条
  function note(text,btn,fn){
    var s=$("sync-state");s.textContent="";if(!text){s.hidden=true;return}
    s.hidden=false;s.appendChild(document.createTextNode(text+" "));
    if(btn){var b=el("button","ghost",btn);b.type="button";b.id="sync-retry";b.onclick=fn;s.appendChild(b)}
  }
  function owned(){return !!acct&&lsGet(OK)===acct.id}
  function dirty(){return !!acct&&(unsaved||lsGet(DK)===acct.id)}
  function setDirty(on){unsaved=on;if(on)lsSet(DK,acct.id);else lsDel(DK)}
  // 用服务器上的内容：base（上次和服务器对上的内容）也换成它
  function adopt(u){P=Object.assign(clone(EMPTY),u.profile);DONE=u.done||{};BASE={profile:clone(u.profile),done:clone(DONE),version:u.version};localSave();lsSet(OK,acct.id);bind();renderPR();return refresh()}
  // 把本机的概况和进度发给服务器，带上 base 的版本号。同一时间只发一个请求；失败会自动重试。返回的 Promise 不会失败，值为是否存上。
  // 服务器回 409（另一台设备先存过）：按 /merge.js 逐项合并（本机改过的项用本机的，没改的用服务器的），再用服务器的版本号重发。
  var mergeN=0;
  function send(){
    clearTimeout(timer);timer=null;clearTimeout(retryT);retryT=null;
    if(!acct||!started)return Promise.resolve(false);
    if(sending){again=true;return sending}
    again=false;
    var sp=clone(P),sd=clone(DONE),body={profile:sp,done:sd};if(BASE&&typeof BASE.version==="number")body.version=BASE.version;
    sending=api("PUT","/users/"+acct.id+"/state",body).then(function(r){return {r:r}},function(e){return {e:e}}).then(function(x){
      sending=null;
      if(!acct||!started)return false;
      if(x.r){
        BASE={profile:sp,done:sd,version:x.r.version};localSave();mergeN=0;
        if(again)return send(); // 发送途中又有新的修改，再发一次最新的
        retryN=0;setDirty(false);note("");
        var cbs=afterSave;afterSave=[];refresh().then(function(){cbs.forEach(function(f){f()})});
        return true;
      }
      var e=x.e;
      if(e.status===409&&e.body&&e.body.current&&mergeN<5){
        mergeN++;var cur=e.body.current,m=ZMerge.merge(BASE,{profile:P,done:DONE},cur);
        P=Object.assign(clone(EMPTY),m.profile);DONE=m.done;BASE={profile:clone(cur.profile),done:clone(cur.done),version:cur.version};localSave();bind();renderPR();
        if(m.conflicts.length)toast("另一台设备也改了同样的项（"+m.conflicts.map(fieldName).join("、")+"），以这台设备刚改的为准");
        return send();
      }
      if(e.status===401||e.status===404){note("这个账号在服务器上已经不存在（可能已在别处删除），修改没有保存。刷新页面可以重新开始。");return false}
      if(e.status===422||e.status===400||e.status===413){note("有修改没能保存到服务器："+why(e)+" 改正后会再保存。");return false}
      retryN++;
      note("有修改还没保存到服务器（"+(e.status===0?"连不上服务器":"服务器暂时出错")+"）。内容留在这台设备上，会自动重试。","现在重试",function(){send()});
      retryT=setTimeout(send,Math.min(60000,1000*Math.pow(2,retryN)));
      return false;
    });
    return sending;
  }
  // 合并冲突时提示用的项目名：取“我的情况”和“永驻体检”表单上的文字
  function fieldName(k){var ids={status:"f-status",entry:"f-entry",addr:"f-addr",exp:"f-exp",ins:"f-ins",age:"f-age",lic:"f-lic",pr:"f-pr",arrive:"p-arrive",married:"p-married",work:"p-work",hsp:"p-hsp",jp:"p-jp",pay:"p-pay"},e=ids[k]&&$(ids[k]),l=e&&e.closest("label");
    return l?String(l.childNodes[0]&&l.childNodes[0].nodeType===3?l.childNodes[0].textContent:l.textContent).trim().slice(0,16):k}
  function push(){
    if(!acct)return;
    if(!started){if(owned())setDirty(true);return} // 还没连上服务器：先记下“有修改没存”，连上后再发
    setDirty(true);clearTimeout(timer);timer=setTimeout(send,300);
  }
  function flush(){return timer||retryT?send():(sending||Promise.resolve(true))}
  pushHook=push; // save() 写完本机后发给服务器
  window.addEventListener("online",function(){if(!started)boot();else if(dirty())send()});
  // 关页面时还有没发出去的修改：用 keepalive 发一次（版本过时被拒的话，“未保存”的标记还在，下次打开时合并后再存）
  window.addEventListener("pagehide",function(){if(started&&acct&&timer){clearTimeout(timer);timer=null;var b={profile:P,done:DONE};if(BASE&&typeof BASE.version==="number")b.version=BASE.version;api("PUT","/users/"+acct.id+"/state",b,true).catch(function(){})}});

  function loadEvents(){return api("GET","/users/"+acct.id+"/events").then(function(l){renderEv(l)})}
  // 服务器按现在存着的内容算好的路线、提醒、判断、永驻体检、同城示例；之后再读当前主题的选方案
  var refreshN=0;
  function refresh(){
    if(!acct||!started)return Promise.resolve();
    var n=++refreshN,id=acct.id,g=function(p){return api("GET","/users/"+id+p)};
    return Promise.all([g("/plan"),g("/reminders"),g("/advice"),g("/pr-check"),g("/city")]).then(function(r){
      if(n!==refreshN)return;
      PLAN=r[0];VIEW=r[0].view;REM=r[1];ADV=r[2];PRC=r[3];CITYD=r[4];
      renderRoute();renderAdvice();renderRem();renderPR();renderCity();if($("drawer").classList.contains("on"))chips();
      return loadOptions();
    }).catch(function(e){if(n===refreshN)toast("有些内容没有读出来："+why(e))});
  }
  // 不随账号变的资料：节点、环节和服务商类别的对照、事件种类
  function loadStatic(){
    return Promise.all([api("GET","/nodes?full=1"),api("GET","/links"),api("GET","/providers/categories"),api("GET","/event-types")]).then(function(r){
      NODES=r[0];LINKS=r[1];CATS=r[2];EVTYPES=r[3];
      var sel=$("pv-cat"),was=sel.value;sel.textContent="";CATS.forEach(function(c){var o=el("option",null,c.name);o.value=c.key;sel.appendChild(o)});if(was)sel.value=was;
      renderLinks();
    });
  }
  // 服务器上存着的对话记录（换设备也能看到）
  // 读回时先标 aria-busy：对话区是 role="log"，不标的话读屏会把旧记录一条条念出来
  function loadChat(){var c=$("chat");c.setAttribute("aria-busy","true");return api("GET","/users/"+acct.id+"/chat").then(function(r){c.textContent="";pushMsg("a",HELLO);(r.messages||[]).forEach(function(m){if(m.role==="user")pushMsg("u",m.text);else setAns(pushMsg("a",""),(m.category?"【"+m.category+"】":"")+m.text)})}).then(function(){c.removeAttribute("aria-busy")},function(e){c.removeAttribute("aria-busy");throw e})}
  function loadInq(){return api("GET","/users/"+acct.id+"/inquiries").then(function(l){SINQ=l;renderInq()})}
  function loadProv(){var cat=$("pv-cat").value;PICK={};syncForm(true);return api("GET","/providers?category="+encodeURIComponent(cat)).then(function(l){if($("pv-cat").value!==cat)return;PROV=l;PICK={};renderPV();syncForm(true)})}
  // 同意使用条款和隐私政策后才建账号。建账号失败时对话框留着，把原因显示出来，可以再点一次。
  function consent(version){
    return new Promise(function(ok){
      var w=el("div","modal");w.id="consent";w.setAttribute("role","dialog");w.setAttribute("aria-modal","true");w.setAttribute("aria-labelledby","consent-h");w.setAttribute("aria-describedby","consent-d");
      var c=el("div","panel");
      var h=el("h2",null,"开始之前");h.id="consent-h";c.appendChild(h);
      if(gone)c.appendChild(el("p","notice","这台设备上保存的登录已经失效（账号可能已被删除，或在别的设备上被退出了登录）。绑定过邮箱的话，可以用下面的“用邮箱找回”回到原来的账号；否则需要重新开始。"));
      var d0=el("p","lead","在留导航提供手续信息、提醒和找专业人士的渠道，不代办官方文书，也不替你判断个别的在留或税务问题。");d0.id="consent-d";c.appendChild(d0);
      var ul=el("ul");["你填的情况和办事进度会存在我们的服务器上，用来生成你的路线和提醒。","和助手的对话会发给提供 AI 模型的公司（Anthropic，在美国）处理。最近几轮对话保存在我们的服务器上，可以随时清空。","助手不能替你发咨询。只有你自己核对内容、勾选同意并点了发送，咨询内容才会发给你选的服务商。","我们不收集个人编号、护照号、银行账号和卡号，请不要发给助手或写进咨询；看起来像这类号码的内容会被拦下。","账号只记在这台设备的浏览器里。你可以自愿绑定一个邮箱，换设备或清空浏览器后用它找回账号；绑定后我们会保存这个邮箱地址，并通过邮件服务商给它发验证码和新设备登录通知。绑定后可以另外打开“邮件提醒”（默认关闭），打开后期限前 7 天、前 1 天和当天各发一封邮件，随时可以关掉或退订。","你可以随时在“我的情况”里删除自己的账号和全部数据。"].forEach(function(t){ul.appendChild(el("li",null,t))});c.appendChild(ul);
      var pp=el("p");var a1=el("a",null,"使用条款");a1.href="/terms.html";a1.target="_blank";var a2=el("a",null,"隐私政策");a2.href="/privacy.html";a2.target="_blank";pp.appendChild(a1);pp.appendChild(document.createTextNode(" 和 "));pp.appendChild(a2);c.appendChild(pp);
      var bt=el("button","act","同意并开始");bt.type="button";bt.id="consent-ok";
      var msg=el("p","lead");msg.id="consent-msg";msg.setAttribute("role","status");
      bt.onclick=function(){
        bt.disabled=true;msg.textContent="";
        api("POST","/users",{accept:version}).then(function(u){acct={id:u.id,token:u.token};lsSet(AK,JSON.stringify(acct));lsDel(DK);unsaved=false;gone=false;close();ok(u)})
        .catch(function(e){bt.disabled=false;msg.textContent="账号没有建成："+why(e);bt.focus()});
      };
      c.appendChild(bt);c.appendChild(msg);
      c.appendChild(recoverUi(function(u){unsaved=false;gone=false;close();ok(u)}));
      w.appendChild(c);var close=openModal(w,bt);
    });
  }
  // 六位验证码的输入框
  function codeInput(id){var i=el("input");i.id=id;i.type="text";i.setAttribute("inputmode","numeric");i.setAttribute("autocomplete","one-time-code");i.maxLength=6;i.setAttribute("aria-label","邮件里的 6 位验证码");i.placeholder="6 位验证码";i.className="code-in";i.setAttribute("enterkeyhint","done");return i}
  // 用邮箱找回账号（在同意对话框里）。不管邮箱有没有绑定过，服务器的回答都一样，这里的提示也一样。
  // 找回成功后拿到的是这台设备自己的新令牌，原来的设备不受影响。
  function recoverUi(done){
    var box=el("div","recover");box.id="recover";
    var open=el("button","ghost","已有账号？用邮箱找回");open.type="button";open.id="recover-open";box.appendChild(open);
    var form=el("div");form.hidden=true;
    form.appendChild(el("p","lead","填绑定过的邮箱，我们发一个验证码过去。只有绑定过邮箱的账号才能这样找回。"));
    var addr=el("input");addr.type="email";addr.id="rc-addr";addr.setAttribute("autocomplete","email");addr.setAttribute("aria-label","绑定过的邮箱");addr.placeholder="绑定过的邮箱";addr.className="addr-in";addr.setAttribute("enterkeyhint","send");
    var sendB=el("button","act","发送验证码");sendB.type="button";sendB.id="rc-send";
    var r1=el("div","row");r1.appendChild(addr);r1.appendChild(sendB);form.appendChild(r1);
    var code=codeInput("rc-code"),ver=el("button","act","找回账号");ver.type="button";ver.id="rc-verify";
    var r2=el("div","row");r2.hidden=true;r2.appendChild(code);r2.appendChild(ver);form.appendChild(r2);
    var msg=el("p","lead");msg.id="rc-msg";msg.setAttribute("role","status");form.appendChild(msg);
    box.appendChild(form);
    var cid=null;
    open.setAttribute("aria-expanded","false");
    open.onclick=function(){form.hidden=!form.hidden;open.setAttribute("aria-expanded",String(!form.hidden));if(!form.hidden)addr.focus()};
    sendB.onclick=function(){
      var v=addr.value.trim();if(!v){msg.textContent="请先填邮箱。";return}
      sendB.disabled=true;msg.textContent="";
      api("POST","/auth/recover",{email:v}).then(function(r){
        cid=r.challengeId;r2.hidden=false;code.value="";code.focus();
        msg.textContent="如果这个邮箱绑定过账号，验证码已经发过去了，10 分钟内有效。没收到的话，看看垃圾邮件，或者确认是不是绑定时用的那个邮箱。";
      },function(e){msg.textContent="验证码没有发出去："+why(e)}).then(function(){sendB.disabled=false});
    };
    ver.onclick=function(){
      var v=code.value.trim();if(!cid||!/^\d{6}$/.test(v)){msg.textContent="请填邮件里的 6 位验证码。";return}
      ver.disabled=true;msg.textContent="";
      api("POST","/auth/recover/verify",{challengeId:cid,code:v}).then(function(r){
        // 换成找回的账号：本机缓存的概况和“未保存”标记是别的账号的，不能带过来
        acct={id:r.id,token:r.token};lsSet(AK,JSON.stringify(acct));lsDel(DK);lsDel(OK);
        return api("GET","/users/"+acct.id).then(done);
      }).catch(function(e){ver.disabled=false;msg.textContent="没有找回："+why(e)});
    };
    return box;
  }
  // 条款改版后的重新同意：老用户同意的版本和当前版本不一样时，先弹出这个对话框。
  // 同意之前服务器只让读取和删除，所以这里只有两个选择：同意并继续，或者删除账号。
  function reconsent(u,terms){
    if(!u||u.consentVersion===terms.version)return Promise.resolve(u);
    return new Promise(function(ok){
      var w=el("div","modal");w.id="reconsent";w.setAttribute("role","dialog");w.setAttribute("aria-modal","true");w.setAttribute("aria-labelledby","reconsent-h");w.setAttribute("aria-describedby","reconsent-d");
      var c=el("div","panel");
      var h=el("h2",null,"条款有更新");h.id="reconsent-h";c.appendChild(h);
      var d0=el("p","lead","使用条款和隐私政策更新了（版本 "+terms.version+"）。继续使用之前，请看一下并重新确认。");d0.id="reconsent-d";c.appendChild(d0);
      if(typeof terms.changes==="string"&&terms.changes)c.appendChild(el("p",null,"这次的主要变化："+terms.changes));
      var pp=el("p");var a1=el("a",null,"使用条款");a1.href="/terms.html";a1.target="_blank";var a2=el("a",null,"隐私政策");a2.href="/privacy.html";a2.target="_blank";pp.appendChild(a1);pp.appendChild(document.createTextNode(" 和 "));pp.appendChild(a2);c.appendChild(pp);
      var bt=el("button","act","同意并继续");bt.type="button";bt.id="reconsent-ok";
      var del=el("button","ghost","不同意，删除我的账号和全部数据");del.type="button";del.id="reconsent-del";
      var msg=el("p","lead");msg.id="reconsent-msg";msg.setAttribute("role","status");
      bt.onclick=function(){
        bt.disabled=true;msg.textContent="";
        api("POST","/users/"+acct.id+"/consent",{accept:terms.version}).then(function(nu){close();ok(nu)})
        .catch(function(e){bt.disabled=false;msg.textContent="没有记录成功："+why(e);bt.focus()});
      };
      del.onclick=function(){
        if(!window.confirm(DEL_ASK))return;
        del.disabled=true;removeAccount().catch(function(e){del.disabled=false;msg.textContent="账号没有删除成功，数据还在服务器上。"+why(e);del.focus()});
      };
      var br=el("div","row");br.appendChild(bt);br.appendChild(del);c.appendChild(br);c.appendChild(msg);
      w.appendChild(c);var close=openModal(w,bt);
    });
  }
  // “我的情况”里的“账号和邮箱”：绑定邮箱、更换或解除（先验证原来的邮箱）、看有几台设备登录着、让其他设备退出。
  // 邮箱只显示服务器返回的打码地址；所有文字都用 textContent 放进去。
  var EM={state:null,sessions:[],cid:null,old:null,proof:null,addr:"",msg:"",rmsg:"",err:""};
  function loadAcct(){
    return Promise.all([api("GET","/users/"+acct.id+"/email"),api("GET","/users/"+acct.id+"/sessions")]).then(function(r){EM.state=r[0];EM.sessions=Array.isArray(r[1])?r[1]:[];EM.err="";renderAcct()},
      function(e){EM.err="邮箱和登录设备的情况没有读出来："+why(e);renderAcct()});
  }
  // 邮件提醒的开关（真的会发信）：默认关，绑定了邮箱才能开。“账号和邮箱”和“提醒”页各放一个，是同一个设置。
  var REMIND_TEXT="邮件提醒：期限前 7 天、前 1 天和当天各发一封到绑定的邮箱，邮件里写明是哪件事、哪一天，有官方页面的会带上链接，每封都带退订的链接。默认关闭；随时可以在这里关掉，也可以点邮件里的退订链接（不用登录）";
  function remindToggle(id){
    var lb=el("label","check"),cb=el("input");cb.type="checkbox";cb.id=id;lb.setAttribute("for",id);cb.checked=!!(EM.state&&EM.state.remindOptIn);
    lb.appendChild(cb);lb.appendChild(document.createTextNode(REMIND_TEXT));
    cb.onchange=function(){
      var on=cb.checked;cb.disabled=true;
      api("PUT","/users/"+acct.id+"/email/reminders",{on:on}).then(function(r){EM.state.remindOptIn=!!r.remindOptIn;EM.rmsg=r.remindOptIn?"邮件提醒已打开。":"邮件提醒已关闭，不会再发。";renderAcct()},
        function(e){EM.rmsg="邮件提醒的设置没有改成："+why(e);renderAcct()});
    };
    return lb;
  }
  // “提醒”页里的邮件提醒：没绑定邮箱时说明去哪里绑定，绑定了就是开关
  function renderRemMail(){
    var box=$("rm-mail");box.textContent="";box.hidden=!acct||!started||!EM.state;
    if(box.hidden)return;
    box.style.cssText="margin-top:14px;border-top:1px solid var(--line);padding-top:12px";
    var h=el("h3",null,"邮件提醒");h.style.cssText="margin:0 0 6px;font-size:15px";box.appendChild(h);
    if(!EM.state.email){var p0=el("p","lead","现在只能打开这一页看提醒。想让期限前 7 天、前 1 天和当天各收到一封邮件，先在“闯关”页“我的情况”里的“账号和邮箱”绑定邮箱，再回到这里打开。");p0.id="rm-mail-state";box.appendChild(p0);return}
    var p1=el("p","lead",EM.state.remindOptIn?"已打开，发到 "+EM.state.email+"。":"还没有打开。绑定的邮箱是 "+EM.state.email+"。");p1.id="rm-mail-state";box.appendChild(p1);
    box.appendChild(remindToggle("rm-mail-on"));
    var m=el("p","lead",EM.rmsg||"");m.id="rm-mail-msg";m.setAttribute("role","status");box.appendChild(m);
    if(EM.rmsg&&EM.rmsg!==EM.rsaid){EM.rsaid=EM.rmsg;announce(EM.rmsg)}
  }
  function renderAcct(){
    renderRemMail();
    var box=$("acct-box");box.textContent="";box.hidden=!acct||!started;if(box.hidden)return;
    box.style.cssText="margin-top:14px;border-top:1px solid var(--line);padding:12px 0 56px";
    var h=el("h3",null,"账号和邮箱");h.style.cssText="margin:0 0 6px;font-size:15px";box.appendChild(h);
    if(EM.err){var er=el("p","lead",EM.err+" ");var rb=el("button","ghost","重试");rb.type="button";rb.id="em-reload";rb.onclick=function(){loadAcct()};er.appendChild(rb);box.appendChild(er)}
    if(!EM.state)return;
    var bound=!!EM.state.email;
    var st=el("p","lead",bound?"已绑定邮箱："+EM.state.email+"。换设备或清空浏览器后，在“开始之前”的窗口里点“已有账号？用邮箱找回”，就能回到这个账号。":"还没有绑定邮箱。账号只记在这台设备的浏览器里：换设备或清空浏览器后就找不回来了。绑定邮箱后可以用邮箱找回。");st.id="em-state";box.appendChild(st);
    var msg=el("p","lead",EM.msg);msg.id="em-msg";msg.setAttribute("role","status");
    if(EM.msg&&EM.msg!==EM.said){EM.said=EM.msg;announce(EM.msg)} // 整块重画后新放进去的说明，另外念一遍
    function say(t){EM.msg=t;msg.textContent=t}
    function reset(){EM.cid=null;EM.old=null;EM.proof=null;EM.addr=""}
    // 已经绑着邮箱时，更换和解除都要先输入发到原来邮箱的验证码（服务器给一个 15 分钟内有效的确认 proof）。
    // 更换：原来的邮箱收验证码 → 填新邮箱 → 新邮箱收验证码；解除：原来的邮箱收验证码 → 解除。
    function askOld(action){
      api("POST","/users/"+acct.id+"/email/old",{action:action}).then(function(r){
        EM.old={action:action,cid:r.challengeId};EM.proof=null;EM.cid=null;
        EM.msg="为了确认是你本人，验证码已经发到现在绑定的邮箱（"+EM.state.email+"），10 分钟内有效。没收到的话看看垃圾邮件。";renderAcct();var c=$("em-old-code");if(c)c.focus();
      },function(e){EM.old=null;say((action==="remove"?"没有解除成功：":"没有更换成功：")+why(e));renderAcct()});
    }
    function removeNow(){
      api("DELETE","/users/"+acct.id+"/email",{proof:EM.proof.token}).then(function(){reset();EM.state={email:null,verified:false,remindOptIn:false};EM.rmsg="";EM.msg="已解除绑定，邮箱地址已删除。";renderAcct()},
        function(e){EM.proof=null;say("没有解除成功："+why(e));renderAcct()});
    }
    if(bound&&!EM.old&&!EM.proof){
      var chg=el("button","ghost","更换邮箱");chg.type="button";chg.id="em-change";
      chg.onclick=function(){chg.disabled=true;say("");askOld("change")};
      var rm=el("button","ghost","解除绑定");rm.type="button";rm.id="em-remove";
      rm.onclick=function(){
        if(!window.confirm("解除后，我们会删掉保存的邮箱地址，之后不能再用它找回这个账号。解除之前要先输入发到这个邮箱的验证码。确定解除吗？"))return;
        rm.disabled=true;say("");askOld("remove");
      };
      var r0=el("div","row");r0.appendChild(chg);r0.appendChild(rm);box.appendChild(r0);
      var lost=el("p","lead","原来的邮箱收不到信了？更换和解除都要它收到的验证码，没有别的办法绕过（客服也不能替你改），这样别人拿到你的设备也换不掉你的邮箱。可以照常用这个账号（邮件提醒可以随时关掉），或者用上面的“删除我的账号和全部数据”删掉后重新开始。");lost.id="em-lost";lost.style.fontSize="13px";box.appendChild(lost);
    }
    if(EM.old){
      var oc=codeInput("em-old-code"),ov=el("button","act","确认是我");ov.type="button";ov.id="em-old-verify";
      var oCancel=el("button","ghost","取消");oCancel.type="button";oCancel.id="em-old-cancel";oCancel.onclick=function(){reset();say("");renderAcct()};
      ov.onclick=function(){
        var v=oc.value.trim();if(!/^\d{6}$/.test(v)){say("请填发到原来邮箱的 6 位验证码。");return}
        ov.disabled=true;say("");var action=EM.old.action;
        api("POST","/users/"+acct.id+"/email/old/verify",{action:action,challengeId:EM.old.cid,code:v}).then(function(r){
          EM.old=null;EM.proof={action:action,token:r.proof};
          if(action==="remove"){removeNow();return}
          EM.msg="原来的邮箱已确认。请在 15 分钟内填新的邮箱，再输入发到新邮箱的验证码。";renderAcct();var a=$("em-addr");if(a)a.focus();
        },function(e){ov.disabled=false;say("验证码没有通过："+why(e))});
      };
      var ro=el("div","row");ro.appendChild(oc);ro.appendChild(ov);ro.appendChild(oCancel);box.appendChild(ro);
    }
    // 填邮箱、发验证码：没绑定时直接填；已经绑着时，验证过原来的邮箱（拿到“更换”的确认）才出现
    var changing=bound&&EM.proof&&EM.proof.action==="change";
    if(!bound||changing){
      var addr=el("input");addr.type="email";addr.id="em-addr";addr.setAttribute("autocomplete","email");addr.setAttribute("aria-label",bound?"新的邮箱":"邮箱地址");addr.placeholder=bound?"新的邮箱":"邮箱地址";addr.style.cssText="flex:1 1 180px;min-width:0";addr.value=EM.addr;addr.oninput=function(){EM.addr=addr.value};
      var lb=el("label","check"),cb=el("input");cb.type="checkbox";cb.id="em-ok";lb.setAttribute("for","em-ok");lb.appendChild(cb);lb.appendChild(document.createTextNode("同意保存这个邮箱地址，用于找回账号、发送验证码和新设备登录通知"));
      var sendB=el("button","act","发送验证码");sendB.type="button";sendB.id="em-send";
      sendB.onclick=function(){
        var v=addr.value.trim();if(!v){say("请先填邮箱。");return}
        if(!cb.checked){say("请先勾选同意。");return}
        sendB.disabled=true;say("");
        api("POST","/users/"+acct.id+"/email",changing?{email:v,consent:true,proof:EM.proof.token}:{email:v,consent:true}).then(function(r){
          EM.cid=r.challengeId;EM.msg="验证码已经发到"+(changing?"新的":"这个")+"邮箱，10 分钟内有效。没收到的话看看垃圾邮件；这个邮箱如果已经绑定在别的账号上，收到的会是一封说明而不是验证码。";renderAcct();var c=$("em-code");if(c)c.focus();
        },function(e){sendB.disabled=false;say("验证码没有发出去："+why(e));if(e.status===403&&changing){EM.proof=null;EM.cid=null;renderAcct()}});
      };
      var r1=el("div","row");r1.appendChild(addr);r1.appendChild(sendB);
      if(changing){var cc=el("button","ghost","取消");cc.type="button";cc.id="em-change-cancel";cc.onclick=function(){reset();say("");renderAcct()};r1.appendChild(cc)}
      box.appendChild(r1);box.appendChild(lb);
      if(EM.cid){
        var code=codeInput("em-code"),ver=el("button","act",changing?"确认更换":"确认绑定");ver.type="button";ver.id="em-verify";
        ver.onclick=function(){
          var v=code.value.trim();if(!/^\d{6}$/.test(v)){say("请填邮件里的 6 位验证码。");return}
          ver.disabled=true;say("");
          api("POST","/users/"+acct.id+"/email/verify",changing?{challengeId:EM.cid,code:v,proof:EM.proof.token}:{challengeId:EM.cid,code:v}).then(function(r){
            reset();EM.state=r;EM.rmsg="";EM.msg=changing?"邮箱已更换，原来的邮箱会收到一封告知。邮件提醒已随之关闭，需要的话请在下面重新打开。":"邮箱已绑定。想在期限前收到邮件，可以在下面打开“邮件提醒”。";renderAcct();
          },function(e){ver.disabled=false;say((changing?"没有更换成功：":"没有绑定成功：")+why(e));if(e.status===403&&changing){EM.proof=null;EM.cid=null;renderAcct()}});
        };
        var r2=el("div","row");r2.appendChild(code);r2.appendChild(ver);box.appendChild(r2);
      }
    }
    if(bound){
      box.appendChild(remindToggle("em-remind"));
      var rmsg=el("p","lead",EM.rmsg||"");rmsg.id="em-remind-msg";rmsg.setAttribute("role","status");box.appendChild(rmsg);
    }
    box.appendChild(msg);
    // 登录着的设备
    var h2=el("h3",null,"登录着的设备");h2.style.cssText="margin:14px 0 6px;font-size:15px";box.appendChild(h2);
    var ul=el("ul","rem");ul.id="ses-list";
    EM.sessions.forEach(function(x){var li=el("li");li.appendChild(el("span",null,(x.via==="recover"?"用邮箱找回登录的设备":"注册时的设备")+(x.current?"（这台设备）":"")));li.appendChild(el("time",null,String(x.createdAt||"").slice(0,10)));ul.appendChild(li)});
    box.appendChild(ul);
    if(EM.sessions.length>1){
      var out=el("button","ghost","让其他设备退出登录");out.type="button";out.id="ses-revoke";
      out.onclick=function(){
        if(!window.confirm("其他设备会立刻退出登录，要再用得重新用邮箱找回。这台设备不受影响。确定吗？"))return;
        out.disabled=true;
        api("DELETE","/users/"+acct.id+"/sessions").then(function(){toast("其他设备已退出登录");return loadAcct()},function(e){out.disabled=false;say("没有操作成功："+why(e))});
      };
      var r4=el("div","row");r4.appendChild(out);box.appendChild(r4);
    }
  }
  // 提醒页：记录会产生期限的事
  function renderEv(list){
    var box=$("ev-box");if(!box){box=el("section","panel");box.id="ev-box";$("v-reminders").appendChild(box)}box.textContent="";
    box.appendChild(el("h2",null,"发生了这些事，告诉我们"));box.appendChild(el("p","lead","换工作、搬家这类事有法定期限。记下日期，期限会出现在上面的提醒里。"));
    var row=el("div","row"),sel=el("select"),dt=el("input"),bt=el("button","act","记下来");sel.id="ev-type";sel.setAttribute("aria-label","发生了什么");dt.type="date";dt.id="ev-date";dt.setAttribute("aria-label","哪一天");bt.type="button";bt.id="ev-add";
    EVTYPES.forEach(function(t){var o=el("option",null,t.label);o.value=t.type;sel.appendChild(o)});
    bt.onclick=function(){if(!dt.value){toast("请先选日期");return}var type=sel.value;
      api("POST","/users/"+acct.id+"/events",{type:type,date:dt.value}).then(function(r){return loadEvents().then(refresh).then(function(){return r})}).then(function(r){
        // 有些身份没有这项申报义务（例如配偶身份的人换工作），这时提醒里不会多出期限，要说清楚
        var hit=r&&r.deadlines;
        toast(hit?"已记下，期限已加进提醒":"已记下。按你现在填的身份，这里没有登记到对应的期限；这不代表没有别的手续，请以入管厅或区役所的说明为准")}).catch(function(e){toast(why(e))})};
    row.appendChild(sel);row.appendChild(dt);row.appendChild(bt);box.appendChild(row);
    var ul=el("ul","rem");list.forEach(function(ev){var li=el("li");li.appendChild(el("span",null,ev.label));li.appendChild(el("time",null,ev.date));var x=el("button","ghost","删除");x.type="button";x.setAttribute("aria-label","删除这条记录："+ev.label+" "+ev.date);x.onclick=function(){api("DELETE","/users/"+acct.id+"/events/"+ev.id).then(loadEvents).then(refresh).catch(function(e){toast(why(e))})};li.appendChild(x);ul.appendChild(li)});box.appendChild(ul);
  }
  // 助手准备的咨询草稿：只显示，不发送。用户勾选同意并点“发送给服务商”后，才由页面调 POST /inquiries。
  function draftCard(d){
    if(!d||typeof d.summary!=="string"||typeof d.category!=="string"||!Array.isArray(d.providers))return null;
    var ps=d.providers.filter(function(p){return p&&typeof p.id==="string"&&typeof p.name==="string"}).slice(0,3);if(!ps.length)return null;
    Array.prototype.forEach.call(document.querySelectorAll("#chat .draft:not(.sent)"),function(x){x.remove()}); // 没发出去的旧草稿由新草稿代替
    var m=el("div","msg a draft"),cls=el("span","cls","咨询草稿（还没有发送）");m.appendChild(cls);
    var tip=el("div",null,"助手不能替你发送。请核对下面的内容，同意后由你自己点发送。");m.appendChild(tip);
    var who=el("div","draft-to","发给（"+catName(d.category)+"）：");who.style.cssText="font-weight:700;margin-top:8px";
    // 非士业的服务商标“含推广”（按类别定，和名单一样）；展示费的说明固定写在下面
    var promo=!isRegulated(d.category);ps.forEach(function(p,i){if(i)who.appendChild(document.createTextNode("、"));who.appendChild(el("span","draft-pv",p.name));if(promo||p.promoted)who.appendChild(el("span","tag bad draft-promo","含推广"))});m.appendChild(who);
    var fee=el("div","draft-fee muted","这些服务商向在留导航支付固定的展示费（不按咨询数或成交付费），排列按入驻先后，平台不推荐某一家。");fee.style.cssText="font-size:12px;margin-top:4px";m.appendChild(fee);
    var pre=el("pre","draft-sum",d.summary);pre.style.cssText="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;margin:6px 0;padding:8px 10px;border:1px solid var(--line);border-radius:8px";m.appendChild(pre);
    var lb=el("label","check"),cb=el("input");cb.type="checkbox";cb.className="draft-ok";lb.appendChild(cb);lb.appendChild(document.createTextNode("同意把上面的内容提供给这"+ps.length+"家服务商"));m.appendChild(lb);
    var row=el("div","row"),go=el("button","act","发送给服务商"),no=el("button","ghost","不发了"),nt=el("span","draft-note");go.type=no.type="button";go.className="act draft-send";no.className="ghost draft-drop";nt.setAttribute("role","status");
    go.onclick=function(){
      if(!cb.checked){nt.textContent="请先勾选同意。";return}
      go.disabled=no.disabled=true;nt.textContent="正在发送…";
      api("POST","/users/"+acct.id+"/inquiries",{consent:true,category:d.category,nodeId:typeof d.nodeId==="string"&&d.nodeId?d.nodeId:undefined,summary:pre.textContent,providerIds:ps.map(function(p){return p.id})})
      .then(function(){m.classList.add("sent");cls.textContent="咨询已发出";tip.remove();lb.remove();go.remove();no.remove();nt.textContent="已发出。对方回复后在“找人帮忙”里查看。";return loadInq().catch(function(){})})
      .catch(function(e){go.disabled=no.disabled=false;cb.checked=false;nt.textContent="没有发出去："+why(e)});
    };
    no.onclick=function(){m.remove()};
    row.appendChild(go);row.appendChild(no);row.appendChild(nt);m.appendChild(row);
    $("chat").appendChild(m);$("chat").scrollTop=$("chat").scrollHeight;return m;
  }
  // 助手准备的改动（对话里出现过服务商自己写的文字之后，助手改“我的情况”、进度、事件不直接生效）：
  // 显示成卡片，用户点“确认”才调 POST /chat/confirm，点“不用了”就什么都不改。text 是服务器写好的一句话（只当文字显示）。
  function pendingCards(list){
    if(!Array.isArray(list))return;
    list.forEach(function(x){
      if(!x||typeof x.tool!=="string"||typeof x.text!=="string")return;
      var m=el("div","msg a pending"),cls=el("span","cls","助手想做的修改（还没有生效）");m.appendChild(cls);
      m.appendChild(el("div","pending-text",x.text));
      var row=el("div","row"),go=el("button","act","确认修改"),no=el("button","ghost","不用了"),nt=el("span","pending-note");go.type=no.type="button";go.className="act pending-ok";no.className="ghost pending-drop";nt.setAttribute("role","status");
      go.onclick=function(){
        go.disabled=no.disabled=true;nt.textContent="正在保存…";
        flush().then(function(){return api("POST","/users/"+acct.id+"/chat/confirm",{tool:x.tool,input:x.input})})
        .then(function(){m.classList.add("done");cls.textContent="已确认的修改";go.remove();no.remove();nt.textContent="已保存。";
          return api("GET","/users/"+acct.id).then(function(u){if(!dirty())adopt(u);return loadEvents()}).catch(function(){})})
        .catch(function(e){go.disabled=no.disabled=false;nt.textContent="没有保存："+why(e)});
      };
      no.onclick=function(){m.remove()};
      row.appendChild(go);row.appendChild(no);row.appendChild(nt);m.appendChild(row);
      $("chat").appendChild(m);
    });
    $("chat").scrollTop=$("chat").scrollHeight;
  }
  // 助手走服务器。对话记录存在服务器上，页面只发新的一句（不保存、不带回历史）。
  function serverAsk(q){
    if(busy||!q)return;
    if(!started){$("ask-state").textContent="连不上服务器，助手暂时不能用。";return}
    busy=true;$("ask-b").disabled=true;$("ask-state").textContent="";pushMsg("u",q);var m=pushMsg("a","…"),n=nodeOf(SEL);
    var body=(n?"（用户正在看的任务："+SEL+" "+n.t+"）":"")+q;
    // 助手可能改了概况和进度：本机没有未保存的修改就直接用服务器的；有的话下次保存时服务器回 409，合并后再存
    function after(){return api("GET","/users/"+acct.id).then(function(u){if(!dirty())adopt(u);return loadEvents()}).catch(function(){})}
    flush().then(function(){return api("POST","/users/"+acct.id+"/chat",{message:body})}).then(function(r){
      setAns(m,(r.category?"【"+r.category+"】":"")+r.text);draftCard(r.draft);pendingCards(r.pending);
      return after();
    },function(e){
      var t;
      // 503 有两种：助手没有配置（服务器的说明里有内部的配置名，不给用户看），和助手忙不过来（显示服务器的说明，原话放回输入框）
      if(e.status===503&&(!e.said||/没有配置|API_KEY/.test(e.message)))t="助手还没有开通，暂时不能回答。可以先看各任务的“怎么办”，或在“找人帮忙”里咨询服务商。";
      else if(e.status===503||e.status===422||e.status===429||e.status===409||e.status===0){t=e.status===503?e.message+"。你的问题已放回输入框。":why(e);if(!$("ask-t").value)$("ask-t").value=q} // 例如消息里疑似含有护照号；上一条还在回答
      else t="这次没有成功，请再问一次。";
      setAns(m,t);
    }).then(function(){busy=false;$("ask-b").disabled=false},function(){busy=false;$("ask-b").disabled=false});
  }
  // 清空服务器上的对话记录
  $("d-clear").onclick=function(){
    if(!acct||!started||busy)return;
    if(!window.confirm("清空后，服务器上保存的和助手的对话记录会删掉，助手也不再记得前面说过的话。确定吗？"))return;
    api("DELETE","/users/"+acct.id+"/chat").then(function(){var c=$("chat");c.textContent="";pushMsg("a",HELLO);toast("对话记录已清空")},function(e){toast("没有清空："+why(e))});
  };
  // 咨询申请：页面上显示的就是要发出去的全文。选的服务商或文字一变，同意的勾就取消。
  function inqText(){return (PVNODE?"【"+PVNODE.title+"】":"")+$("pv-msg").value.trim()+"\n希望的方式："+$("pv-mode").value+"，"+$("pv-time").value+"\n"+packText()}
  function syncForm(reset){
    var ids=Object.keys(PICK).sort(),t=inqText(),key=ids.join(",")+"\n"+t;
    $("pv-form").hidden=!ids.length;
    $("pv-form-h").textContent="咨询申请："+ids.map(function(k){return PICK[k]}).join("、");
    if(reset||key!==SHOWN)$("pv-ok").checked=false;
    SHOWN=key;$("pv-pack").textContent=t;
  }
  function install(){
    if(installed)return;installed=true;
    // 找人帮忙：真实的服务商名单
    renderPV=function(){
      var sel=$("pv-cat"),c=CATS.filter(function(x){return x.key===sel.value})[0]||CATS[0]||{},list=$("pv-list");list.textContent="";
      if(!PROV.length)list.appendChild(el("small",null,"这一类还没有入驻的服务商。"));
      PROV.forEach(function(p){
        var card=el("div","card");card.appendChild(el("b",null,p.name));card.appendChild(el("small",null,c.what||""));
        if(p.licenseBody)card.appendChild(el("small",null,"所属会："+p.licenseBody));if(p.address)card.appendChild(el("small",null,"事务所地址："+p.address));
        var t=el("div");if(p.licenseNo)t.appendChild(el("span","tag ok","登录番号 "+p.licenseNo));if(p.promoted)t.appendChild(el("span","tag bad","含推广"));if(p.langs)t.appendChild(el("span","tag info",p.langs));if(p.area)t.appendChild(el("span","tag info",p.area));card.appendChild(t);
        card.appendChild(el("small",null,"收费说明："+(p.feeNote||"请在咨询时确认")));
        var lb=el("label","check"),cb=el("input");cb.type="checkbox";cb.checked=!!PICK[p.id];cb.onchange=function(){if(cb.checked&&Object.keys(PICK).length>=3){cb.checked=false;toast("一次最多发给三家");return}if(cb.checked)PICK[p.id]=p.name;else delete PICK[p.id];syncForm(true);$("pv-note").textContent=""};lb.appendChild(cb);lb.appendChild(document.createTextNode("发给这家"));card.appendChild(lb);
        list.appendChild(card)});
      syncForm(); // 概况或资料变了，要发送的全文也跟着变，同意的勾随之取消
    };
    $("pv-cat").onchange=function(){$("pv-note").textContent="";loadProv().catch(function(e){toast(why(e))})};
    $("pv-msg").oninput=function(){syncForm();$("pv-note").textContent=""};
    $("pv-mode").onchange=$("pv-time").onchange=function(){syncForm();$("pv-note").textContent=""};
    quickInquiry=function(id,cat){var lk=LINKS.filter(function(x){return x.nodeId===id&&x.category===cat})[0];PVNODE=lk||null;$("pv-cat").value=cat;location.hash="#providers";$("pv-msg").value="想咨询“"+(lk?lk.title:id)+"”：请告诉我能不能办、费用多少、要多久。";$("pv-note").textContent="";loadProv().catch(function(e){toast(why(e))})};
    $("pv-send").onclick=function(){
      var ids=Object.keys(PICK),nt=$("pv-note"),bt=$("pv-send");if(!ids.length){nt.textContent="请先选服务商。";return}
      if(!$("pv-msg").value.trim()){nt.textContent="请先写下想咨询的事情。";return}
      var was=SHOWN;syncForm();if(SHOWN!==was){nt.textContent="要发送的内容有变化，请重新核对后再勾选同意。";return}
      if(!$("pv-ok").checked){nt.textContent="请先勾选同意。";return}
      bt.disabled=true;nt.textContent="";
      // 发出去的就是 pv-pack 里显示给用户看的那段文字
      api("POST","/users/"+acct.id+"/inquiries",{consent:true,category:$("pv-cat").value,providerIds:ids,nodeId:PVNODE&&nodeOf(PVNODE.nodeId)?PVNODE.nodeId:undefined,summary:$("pv-pack").textContent})
      .then(function(){bt.disabled=false;PICK={};renderPV();syncForm(true);toast("已发出，对方回复后在这里查看");return loadInq().catch(function(){})})
      .catch(function(e){bt.disabled=false;$("pv-ok").checked=false;nt.textContent="没有发出去："+why(e)});
    };
    renderInq=function(){
      var box=$("inq-list");box.textContent="";
      if(!SINQ.length){box.appendChild(el("small",null,"还没有对接记录。选服务商后提交咨询。"));return}
      var NAME={sent:"已发出，等对方查看",viewed:"对方已查看",replied:"对方已回复",closed:"已结束"};
      SINQ.slice().reverse().forEach(function(q){var c=el("div","card");c.style.marginBottom="10px";c.appendChild(el("b",null,q.providerName));c.appendChild(el("small",null,String(q.createdAt).slice(0,10)+"　"+(NAME[q.status]||"")));
        var pre=el("small",null,String(q.summary).split("\n")[0]);c.appendChild(pre);
        (q.replies||[]).forEach(function(r){var d=el("div");d.style.cssText="margin-top:8px;padding:8px 10px;border-left:3px solid var(--accent)";d.appendChild(el("small",null,"回复 "+String(r.createdAt).slice(0,10)));d.appendChild(el("div",null,r.text));c.appendChild(d)});
        box.appendChild(c)});
    };
    // “从零开始”会清空服务器上的概况和进度，先问一句
    var fresh0=$("fresh").onclick;
    $("fresh").onclick=function(){if(window.confirm("会把“我的情况”和已完成的任务清空，从第0关重新开始。确定吗？"))fresh0.call(this)};
  }
  function accountUi(){$("del-account").hidden=!acct;ask=serverAsk}
  // 删除账号和全部数据：服务器上删掉（绑定的邮箱、别的设备的登录也一并删掉），本机保存的账号、缓存和未保存标记一并清空
  var DEL_ASK="删除后，服务器上你的情况、进度、事件、咨询和收到的回复、绑定的邮箱会全部删掉，其他设备也会退出登录，这台设备上保存的内容也会清空，不能恢复。确定删除吗？";
  function removeAccount(){
    clearTimeout(timer);timer=null;clearTimeout(retryT);retryT=null;
    return api("DELETE","/users/"+acct.id).catch(function(e){if(e.status===401||e.status===404)return null;throw e}) // 服务器上已经没有这个账号，也算删完
    .then(function(){started=false;acct=null;[AK,DK,OK,KEY].forEach(lsDel);location.hash="";location.reload()});
  }
  $("del-account").onclick=function(){
    if(!acct)return;
    if(!window.confirm(DEL_ASK))return;
    var bt=$("del-account");bt.disabled=true;
    removeAccount().catch(function(e){bt.disabled=false;note("账号没有删除成功，数据还在服务器上。"+why(e))});
  };
  function start(u){
    started=true;bootN=0;install();accountUi();$("ask-state").textContent="";
    SRV={get:function(p){return api("GET","/users/"+acct.id+p)},why:why};
    // 上次的修改没存上：以本机的内容为准发给服务器（服务器上的内容比 base 新时回 409，逐项合并后再存），不拿服务器的旧内容覆盖
    var resend=dirty()&&owned();
    if(resend){bind();renderPR()}else{setDirty(false);note("")}
    // 先读节点资料和对照表，再读路线等（都由服务器算）；全部读完才算接好
    return loadStatic().then(function(){
      var first=resend?refresh():adopt(u);if(resend)send();
      return Promise.all([first,loadEvents(),loadInq(),loadProv(),loadAcct(),loadChat()]);
    }).catch(function(e){toast("有些内容没有读出来："+why(e))}).then(function(){renderAll();window.ZAIRYU_API=true});
  }
  function boot(){
    if(booting||started)return;booting=true;clearTimeout(bootT);
    fetch("/api/health").then(function(r){if(!r.ok){var e=new Error(String(r.status));e.status=r.status;throw e}return r.json()},function(){var e=new Error("连不上服务器");e.status=0;throw e})
    .then(function(h){
      if(!h||h.ok!==true){var e=new Error("no api");e.status=404;throw e}
      if(!acct)return null;
      // 只有服务器明确回答 401 或 404（没有这个账号或令牌不对）才丢掉本机保存的账号；连不上、5xx、429 都留着账号等重试
      return api("GET","/users/"+acct.id).catch(function(e){if(e.status!==401&&e.status!==404)throw e;acct=null;gone=true;unsaved=false;[AK,DK,OK].forEach(lsDel);accountUi();return null})})
    // 没有账号：同意后新建，或用邮箱找回。有账号（含刚找回的）：同意的条款版本旧了就先重新同意。
    .then(function(u){return api("GET","/terms").then(function(t){if(u)return reconsent(u,t);note("");return consent(t.version).then(function(nu){return reconsent(nu,t)})})})
    .then(function(u){booting=false;return start(u)})
    .catch(function(e){
      booting=false;if(started)return;
      // 页面要连着在留导航的服务器才能用：没有离线的演示模式
      bootN++;
      note(acct?(owned()?"连不上服务器。你的账号和已填的内容都还在这台设备上，现在的修改会先留在本机，连上之后自动保存。":"连不上服务器。你的账号还在这台设备上，连上之后会读回你的内容。"):"连不上服务器。连上之后才能开始使用。","重试",boot);
      bootT=setTimeout(boot,Math.min(60000,2000*Math.pow(2,bootN-1)));
    });
  }
  accountUi();boot();
})();
