// 页面上所有来自服务器和用户的文字都用 textContent 放进去，不拼 HTML。
var TERMS="",CATS=[],CH={ap:null,vw:null},EDIT=null;
// 登录番号的写法提示（格式由服务器检查，这里只是提示）
var LIC={gyosei:["行政書士の登録番号（8 位数字）","所属行政書士会（例：大阪府行政書士会）"],zeirishi:["税理士登録番号（1 至 6 位数字）","所属税理士会（例：近畿税理士会）"],sharoshi:["社会保険労務士の登録番号（8 位数字）","所属社会保険労務士会（例：大阪府社会保険労務士会）"],shiho:["司法書士の登録番号（1 至 5 位数字）","所属司法書士会（例：大阪司法書士会）"],estate:["宅地建物取引業の免許番号（例：大阪府知事（3）第12345号）",""]};
var STATUS={pending:"审核中",approved:"已批准",rejected:"未通过",changes_requested:"需要修改",withdrawn:"已撤回"};
function $(i){return document.getElementById(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function api(m,p,b){return fetch("/api"+p,{method:m,headers:{"content-type":"application/json"},body:b?JSON.stringify(b):undefined}).then(function(r){if(r.status===204)return null;return r.json().catch(function(){return {}}).then(function(j){if(!r.ok){var e=new Error(j&&typeof j.error==="string"?j.error:"服务器出了点问题（"+r.status+"），请稍后再试。");e.status=r.status;throw e}return j})},function(){var e=new Error("连不上服务器，请检查网络后再试。");e.status=0;throw e})}
function licUI(){var c=$("ap-cat").value,l=LIC[c];
  $("ap-lic-label").textContent=l?l[0]:"法人番号（13 位，选填；不是法人可以不填）";$("ap-lic-hint").textContent=l?"全角、半角都可以；「第」「号」可写可不写。":"";
  $("body-box").hidden=!(l&&l[1]);if(l&&l[1])$("ap-body-label").textContent=l[1]}
function sendCode(which){var em=$(which+"-email").value.trim(),msg=$(which+"-send-msg"),b=$(which+"-send");if(!em){msg.textContent="请先填邮箱。";return}
  b.disabled=true;msg.textContent="";api("POST","/provider-apply/code",{email:em}).then(function(r){CH[which]=r.challengeId;msg.textContent="验证码已发出，10 分钟内有效。";b.disabled=false},function(e){msg.textContent=e.message;b.disabled=false})}
function fields(){return {category:$("ap-cat").value,name:$("ap-name").value,address:$("ap-address").value,licenseNo:$("ap-lic").value,licenseBody:$("body-box").hidden?"":$("ap-body").value,feeNote:$("ap-fee").value,area:$("ap-area").value,langs:$("ap-langs").value,agree:$("ap-agree").checked?TERMS:""}}
function fill(a){$("ap-cat").value=a.category;licUI();$("ap-name").value=a.name;$("ap-address").value=a.address;$("ap-lic").value=a.licenseNo;$("ap-body").value=a.licenseBody;$("ap-fee").value=a.feeNote;$("ap-area").value=a.area;$("ap-langs").value=a.langs;$("ap-agree").checked=false}
function setEdit(x){EDIT=x;$("step1").hidden=!!x;$("ap-cancel-edit").hidden=!x;$("form-h").textContent=x?"修改申请（编号 "+x.ref+"）":"第二步：填写申请";$("ap-submit").textContent=x?"重新提交":"提交申请";$("ap-msg").textContent=""}
$("ap-cat").onchange=licUI;
$("ap-send").onclick=function(){sendCode("ap")};
$("vw-send").onclick=function(){sendCode("vw")};
$("ap-cancel-edit").onclick=function(){setEdit(null)};
$("ap-submit").onclick=function(){
  var msg=$("ap-msg"),b=$("ap-submit"),f=fields();msg.textContent="";
  if(!$("ap-agree").checked){msg.textContent="要先阅读并同意服务商条款。";return}
  var req;
  if(EDIT){f.proof=EDIT.proof;req=api("PUT","/provider-apply/"+encodeURIComponent(EDIT.ref),f)}
  else{if(!CH.ap){msg.textContent="请先发送验证码。";return}f.challengeId=CH.ap;f.code=$("ap-code").value.trim();req=api("POST","/provider-apply",f)}
  b.disabled=true;
  req.then(function(r){b.disabled=false;var d=$("ap-done");d.hidden=false;
    d.textContent=EDIT?"已重新提交（编号 "+EDIT.ref+"），审核结果会发到联系邮箱。":"申请已提交。申请编号："+r.ref+"。审核结果会发到联系邮箱。";
    if(!EDIT){$("ap-done").dataset.ref=r.ref}setEdit(null);$("form").hidden=true;$("step1").hidden=true},
  function(e){b.disabled=false;msg.textContent=e.message})};
function showApp(a,proof){
  var out=$("vw-out");out.textContent="";var c=el("div");
  c.appendChild(el("p",null,"申请编号："+a.ref+"　状态："+(STATUS[a.status]||a.status)));
  c.appendChild(el("p","muted",a.name+"　"+a.address));
  if(a.reviewMsg){var r=el("p","draft","审核人员的说明："+a.reviewMsg);r.style.whiteSpace="pre-wrap";c.appendChild(r)}
  if(a.status==="approved")c.appendChild(el("p",null,"已批准。请按批准邮件里的步骤，在服务商工作台用联系邮箱领取令牌，并付展示费。"));
  var row=el("p");
  if(a.status==="changes_requested"){var e=el("button",null,"修改并重新提交");e.type="button";e.id="vw-edit";e.onclick=function(){fill(a);setEdit({ref:a.ref,proof:proof});$("form").hidden=false;$("ap-done").hidden=true;$("form").scrollIntoView({block:"start"})};row.appendChild(e);row.appendChild(document.createTextNode(" "))}
  if(a.status==="pending"||a.status==="changes_requested"){var w=el("button","ghost","撤回申请");w.type="button";w.id="vw-withdraw";var note=el("span");note.setAttribute("role","status");
    w.onclick=function(){if(!confirm("确定撤回这份申请吗？撤回后要重新申请。"))return;w.disabled=true;api("DELETE","/provider-apply/"+encodeURIComponent(a.ref),{proof:proof}).then(function(){a.status="withdrawn";a.reviewMsg="";showApp(a,proof)},function(er){w.disabled=false;note.textContent=" "+er.message})};row.appendChild(w);row.appendChild(note)}
  c.appendChild(row);out.appendChild(c);
}
$("vw-open").onclick=function(){var msg=$("vw-msg");msg.textContent="";if(!CH.vw){msg.textContent="请先发送验证码。";return}
  api("POST","/provider-apply/open",{challengeId:CH.vw,code:$("vw-code").value.trim()}).then(function(r){showApp(r.application,r.proof)},function(e){msg.textContent=e.message})};
Promise.all([api("GET","/provider-terms"),api("GET","/providers/categories")]).then(function(x){TERMS=x[0].version;$("ap-terms-v").textContent=TERMS;CATS=x[1];
  var s=$("ap-cat");CATS.forEach(function(c){var o=el("option",null,c.name);o.value=c.key;s.appendChild(o)});s.value="gyosei";licUI()},function(e){$("ap-msg").textContent="页面没有准备好："+e.message});
