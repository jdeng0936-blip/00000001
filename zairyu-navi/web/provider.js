// 页面上所有来自服务器和用户的文字都用 textContent 放进去，不拼 HTML。
var T=null,NAME={sent:"新咨询",viewed:"已查看",replied:"已回复",closed:"已结束"},DRAFT={}; // DRAFT：还没发出去的回复草稿，按咨询 id 记
function $(i){return document.getElementById(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
// 失败时 e.status：0 是连不上，其余是服务器返回的状态码；e.said 表示服务器给了说明文字
function api(m,p,b){return fetch("/api"+p,{method:m,headers:{"content-type":"application/json",authorization:"Bearer "+T},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok){var e=new Error(j&&typeof j.error==="string"?j.error:String(r.status));e.status=r.status;e.said=!!(j&&typeof j.error==="string");throw e}return j})},function(){var e=new Error("连不上服务器");e.status=0;throw e})}
// 只有 401 才说令牌不对；连不上和服务器出错分开说
function why(e){
  if(e.status===401)return "令牌不对，或账号已停用。令牌丢了可以用下面的“用联系邮箱领取”重新领取。";
  if(e.status===0)return "连不上服务器，请检查网络后再试。";
  if(e.said&&e.status>=400&&e.status<500)return e.message; // 例如回复里疑似含有银行账号、护照号：显示服务器的说明
  return "服务器出了点问题（"+e.status+"），请稍后再试。";
}
function render(l){
  var box=$("list");box.textContent="";
  if(!l.length)box.appendChild(el("p","muted","还没有咨询。"));
  l.forEach(function(q){var c=el("div","card");c.appendChild(el("b",null,(NAME[q.status]||"")+"　"+String(q.createdAt).slice(0,10)));
    var pre=el("p",null,q.summary);pre.style.whiteSpace="pre-wrap";c.appendChild(pre);
    (q.replies||[]).forEach(function(r){var d=el("p","muted","你的回复（"+String(r.createdAt).slice(0,10)+"）："+r.text);d.style.whiteSpace="pre-wrap";c.appendChild(d)});
    if(q.status!=="closed"){var ta=el("textarea");ta.rows=3;ta.setAttribute("aria-label","回复内容");ta.value=DRAFT[q.id]||"";ta.oninput=function(){DRAFT[q.id]=ta.value};c.appendChild(ta);c.appendChild(el("p","muted reply-tip","回复里不能写个人编号、护照号、银行账号，也不能写“包过”“保证获批”这类保证结果的话（写“不能保证结果”这样的提醒可以）。"));
      var row=el("p"),s=el("button",null,"发送回复"),x=el("button","ghost","结束这条咨询"),note=el("span");note.setAttribute("role","status");s.type=x.type="button";
      s.onclick=function(){s.disabled=true;note.textContent="";api("POST","/provider/inquiries/"+q.id+"/reply",{text:ta.value}).then(function(){delete DRAFT[q.id];return load()}).catch(function(e){s.disabled=false;note.textContent=" 没有发出去："+why(e)})};
      x.onclick=function(){x.disabled=true;note.textContent="";api("PUT","/provider/inquiries/"+q.id+"/status",{status:"closed"}).then(function(){return load()}).catch(function(e){x.disabled=false;note.textContent=" 没有结束成功："+why(e)})};
      row.appendChild(s);row.appendChild(document.createTextNode(" "));row.appendChild(x);row.appendChild(note);c.appendChild(row);
      if(q.status==="sent")api("PUT","/provider/inquiries/"+q.id+"/status",{status:"viewed"}).catch(function(){})}
    box.appendChild(c)});
}
// 重新读名单。别的咨询里没发出去的草稿留在 DRAFT 里，重画之后还在。读不出来时把原因显示在名单上方，不清空已经显示的内容。
function load(){
  return api("GET","/provider/inquiries").then(function(l){$("list-msg").hidden=true;render(l)},function(e){
    var m=$("list-msg");m.hidden=false;m.textContent="";m.appendChild(document.createTextNode("咨询名单没有读出来："+why(e)+" "));
    var b=el("button","ghost","重试");b.type="button";b.id="list-retry";b.onclick=function(){load()};m.appendChild(b)});
}
// 展示状态、账单、新咨询通知的开关
function showMe(p){
  var m=$("me");m.hidden=false;m.textContent="";m.appendChild(el("p",null,p.name+(p.licenseNo?"（登录番号 "+p.licenseNo+"）":"")));
  var st=el("p",null,p.listed?"名单上展示中"+(p.listedUntil?"，展示到 "+p.listedUntil+"（按时付下一期的展示费会延续）":""):"现在不在名单上展示：批准后 30 天免费展示，之后要按时付展示费；过了付款期限和宽限期、或付款确认前不展示。工作台照常能用。");st.id="listing";m.appendChild(st);
  ME=p;
  if(p.free){var fu=el("p","muted","免费期到 "+p.free.until+(p.free.days30?"（批准日 + 30 天，日本时间）":"（日本时间）")+"。"+firstText(p.free,p.issueDays));fu.id="free-until";m.appendChild(fu)}
  if(p.contact){var lb=el("label"),cb=el("input"),ns=el("span");cb.type="checkbox";cb.id="notify";cb.checked=!!p.notify;cb.style.width="auto";ns.setAttribute("role","status");
    cb.onchange=function(){cb.disabled=true;ns.textContent="";api("PUT","/provider/me/notify",{on:cb.checked}).then(function(r){cb.disabled=false;cb.checked=r.notify},function(e){cb.disabled=false;cb.checked=!cb.checked;ns.textContent=" 没有改成："+why(e)})};
    lb.appendChild(cb);lb.appendChild(document.createTextNode(" 有新咨询时发邮件通知到 "+p.contact+"（邮件里只有数量，不写咨询内容）"));lb.appendChild(ns);m.appendChild(lb)}
  m.appendChild(el("p","muted","回复时请不要作“保证获批”一类的承诺；报酬和范围请写清楚。请不要在回复里写银行账号、护照号这类号码，系统会拦下。"));
}
var INV={issued:"待付款",paid:"已付款",void:"已作废"},ME=null;
// 免费期之后的第一期：从 1 日起是整月，否则按天折算到那个月底
function firstText(f,days){return "之后的第一张账单从 "+f.firstBillStart+" 起收费"+(f.firstProrated?"，收到那个月底，按天折算":"，是整月")+"，在那天之前 "+days+" 天开出。"}
function loadInvoices(){return api("GET","/provider/invoices").then(function(l){var b=$("billing");b.hidden=false;b.textContent="";b.appendChild(el("h2",null,"展示费账单"));
  if(!l.length)b.appendChild(el("p","muted","还没有账单。"+(ME&&ME.free?firstText(ME.free,ME.issueDays):ME?"账单在每一期开始收费之前 "+ME.issueDays+" 天开出。":"")));
  l.forEach(function(i){var c=el("div","card");c.appendChild(el("b",null,i.refCode+"　"+(INV[i.status]||i.status)));
    c.appendChild(el("p",null,"期间 "+i.periodStart+" 至 "+i.periodEnd+(i.prorated?"（不是整月，按天折算）":"")+"　金额 "+i.amountYen+" 日元（含税）"+(i.taxYen!=null?"，其中消费税 "+i.taxYen+" 日元（登记号 "+i.regNo+"）":"")+"　付款期限 "+i.dueDate+(i.paidOn?"　入账日 "+i.paidOn:"")));
    if(i.payText){var t=el("p","muted",i.payText);t.style.whiteSpace="pre-wrap";c.appendChild(t)}
    b.appendChild(c)})},function(e){var b=$("billing");b.hidden=false;b.textContent="账单没有读出来："+why(e)})}
function enter(){
  $("go").disabled=true;$("msg").textContent="";
  api("GET","/provider/me").then(function(p){$("go").disabled=false;$("login").hidden=true;$("list-h").hidden=false;showMe(p);loadInvoices();return load()},
  function(e){$("go").disabled=false;$("msg").textContent=why(e)});
}
$("go").onclick=function(){T=$("tok").value.trim();if(!T){$("msg").textContent="请先填令牌。";return}enter()};
// 用联系邮箱领取令牌。令牌只显示一次，不存进浏览器。
var CLAIM=null;
function plain(m,p,b){return fetch("/api"+p,{method:m,headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){if(!r.ok){var e=new Error(j&&typeof j.error==="string"?j.error:"服务器出了点问题（"+r.status+"）");e.status=r.status;throw e}return j})},function(){var e=new Error("连不上服务器，请检查网络后再试。");e.status=0;throw e})}
$("cl-send").onclick=function(){var em=$("cl-email").value.trim(),m=$("cl-send-msg");if(!em){m.textContent="请先填邮箱。";return}m.textContent="";
  plain("POST","/provider-claim/code",{email:em}).then(function(r){CLAIM=r.challengeId;m.textContent="如果这是在架服务商的联系邮箱，验证码已经发出（10 分钟内有效）。"},function(e){m.textContent=e.message})};
$("cl-go").onclick=function(){var m=$("cl-msg");m.textContent="";if(!CLAIM){m.textContent="请先发送验证码。";return}
  plain("POST","/provider-claim",{challengeId:CLAIM,code:$("cl-code").value.trim()}).then(function(r){CLAIM=null;$("cl-out").hidden=false;$("cl-token").textContent=r.token;$("cl-code").value=""},function(e){m.textContent=e.message})};
$("cl-use").onclick=function(){T=$("cl-token").textContent;$("cl-token").textContent="";$("cl-out").hidden=true;enter()};
