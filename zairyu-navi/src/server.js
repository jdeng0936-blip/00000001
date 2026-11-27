// 在留导航 第一期后端：路线、提醒、选方案、对接咨询。零依赖（Node 22 自带模块）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const createEngine = require('./engine');
const { createStore } = require('./store');

const { validateProfilePatch, validateInquiry, isDate, assertNoSensitive, sensitiveLabel, HttpError } = require('./validate');
const assistant = require('./assistant');

function createApp(opts) {
  opts = opts || {};
  const store = opts.store || createStore(opts.dbFile);
  const nowOf = () => opts.now || undefined;
  const engineFor = (u) => createEngine({ profile: u.profile, done: u.done, plan: u.plan, auth: u.auth, events: store.listEvents(u.id), now: nowOf() });
  // 使用条款和隐私政策的版本。文本改了就改这个版本号，老用户要重新同意（重新同意的流程待做）。
  const TERMS_VERSION = '2026-11-26';
  const adminToken = opts.adminToken || process.env.ADMIN_TOKEN || null;
  const bearer = (req) => (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const admin = (req) => { if (!adminToken) throw new HttpError(503, '管理接口还没有配置（缺少 ADMIN_TOKEN）'); const t = Buffer.from(bearer(req) || ''), k = Buffer.from(adminToken); if (t.length !== k.length || !require('node:crypto').timingSafeEqual(t, k)) throw new HttpError(401, '需要管理员令牌'); };
  const provider = (req) => { const p = store.providerByToken(bearer(req)); if (!p) throw new HttpError(401, '需要服务商令牌'); return p; };
  const ref = createEngine({ now: nowOf() }); // 只用来取静态数据
  const nodeIds = new Set(ref.NODES.map((n) => n.id));
  const catKeys = new Set(ref.CATS.map((c) => c[0]));
  const evTypes = new Set(Object.keys(ref.EVRULES)); // 用集合判断，'constructor' 这类继承来的键不算事件类型
  const inquiryDeps = { hasCategory: (k) => catKeys.has(k), hasNode: (id) => nodeIds.has(id), getProvider: (id) => store.getProvider(id) };

  // 限流（内存里的滑动窗口，单进程够用；多进程部署时要换成共享存储）。
  // 助手：每个账号 10 分钟 20 次、24 小时 200 次。注册：每个来源地址 1 小时 30 个账号。
  // 放在反向代理后面时，所有请求的来源地址都是代理，要在代理上按真实地址限流，并把 signupLimit 调大。
  const limiter = (cfg) => {
    const hits = new Map();
    return (key) => {
      const t = Date.now();
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= t - cfg.windowMs) hits.delete(k);
      const list = (hits.get(key) || []).filter((x) => x > t - cfg.windowMs);
      if (list.length >= cfg.max) { hits.set(key, list); return Math.max(1, Math.ceil((list[0] + cfg.windowMs - t) / 1000)); } // 返回还要等多少秒
      list.push(t); hits.set(key, list); return 0;
    };
  };
  const chatShort = limiter(opts.chatLimit || { max: 20, windowMs: 10 * 60 * 1000 });
  const chatDaily = limiter(opts.chatDailyLimit || { max: 200, windowMs: 24 * 60 * 60 * 1000 });
  const signup = limiter(opts.signupLimit || { max: 30, windowMs: 60 * 60 * 1000 });
  const tooMany = (wait, msg) => new HttpError(429, msg + '，请在' + (wait >= 120 ? Math.ceil(wait / 60) + '分钟' : wait + '秒') + '后再试', { 'retry-after': String(wait) });

  const user = (id, req) => {
    const tok = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    // 没有令牌和令牌不对都返回同样的 401，不透露这个 id 是否存在。
    if (!tok || !store.checkToken(id, tok[1])) throw new HttpError(401, '需要登录');
    return store.getUser(id);
  };

  async function route(req, url, body) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const m = req.method;
    if (seg[0] !== 'api') return null;
    if (seg[1] === 'health' && m === 'GET') return { ok: true, nodes: ref.NODES.length };
    if (seg[1] === 'nodes' && m === 'GET') {
      if (!seg[2]) return ref.NODES.map((n) => ({ id: n.id, stage: n.s, title: n.t, summary: n.sum }));
      const n = ref.NODES.find((x) => x.id === seg[2]); if (!n) throw new HttpError(404, '没有这个节点');
      return Object.assign({}, n, { rows: n.rows.map((r) => ({ key: r[0], value: r[1], verified: !!r[2] })), links: ref.linksOf(n.id).map((l) => ({ category: l[1], what: l[2], bring: l[3] })) });
    }
    if (seg[1] === 'options' && m === 'GET' && seg[2]) {
      const params = Object.fromEntries(url.searchParams);
      try { return ref.options(seg[2], params); } catch (e) { throw new HttpError(404, e.message); }
    }
    if (seg[1] === 'terms' && m === 'GET') return { version: TERMS_VERSION, terms: '/terms.html', privacy: '/privacy.html' };
    if (seg[1] === 'providers' && !seg[2] && m === 'GET') {
      const pub = (p) => ({ id: p.id, name: p.name, category: p.category, area: p.area, langs: p.langs, feeNote: p.feeNote, licenseNo: p.licenseNo, promoted: p.feeModel === 'affiliate_disclosed' });
      return store.listProviders(url.searchParams.get('category') || undefined).map(pub);
    }
    if (seg[1] === 'admin' && seg[2] === 'providers') {
      admin(req);
      if (m === 'GET') return store.listProviders();
      if (m === 'POST') {
        const b = body || {};
        if (typeof b.name !== 'string' || b.name.trim().length < 2 || b.name.length > 80) throw new HttpError(422, '名称须为2至80字');
        if (!catKeys.has(b.category)) throw new HttpError(422, '服务类别无效');
        const regulated = !!ref.REGULATED[b.category];
        const feeModel = b.feeModel || (regulated ? 'fixed_listing' : 'affiliate_disclosed');
        // 士业不能按成交收费，这条写死在这里，后台改不了。
        if (regulated && feeModel !== 'fixed_listing') throw new HttpError(422, '士业只能按固定展示费入驻，不能按成交抽成');
        if (!['fixed_listing', 'affiliate_disclosed'].includes(feeModel)) throw new HttpError(422, '收费方式无效');
        if (regulated && !(typeof b.licenseNo === 'string' && b.licenseNo.trim())) throw new HttpError(422, '士业入驻必须填写登录番号');
        for (const k of ['area', 'langs', 'feeNote', 'licenseNo']) if (b[k] != null && (typeof b[k] !== 'string' || b[k].length > 200)) throw new HttpError(422, k + ' 须为200字以内的文字');
        if (b.feeNote && /包过|必过|保证|100%/.test(b.feeNote)) throw new HttpError(422, '收费说明里不能有保证类用语');
        return [201, store.createProvider({ name: b.name.trim(), category: b.category, area: b.area, langs: b.langs, feeNote: b.feeNote, licenseNo: b.licenseNo, feeModel })];
      }
      if (m === 'PUT' && seg[3] && seg[4] === 'active') { if (!store.getProvider(seg[3])) throw new HttpError(404, '没有这个服务商'); store.setProviderActive(seg[3], !body || body.active !== false); return { ok: true }; }
    }
    if (seg[1] === 'provider') {
      const p = provider(req);
      if (seg[2] === 'me' && m === 'GET') return p;
      if (seg[2] === 'inquiries' && !seg[3] && m === 'GET') return store.listInquiriesFor(p.id);
      if (seg[2] === 'inquiries' && seg[3]) {
        const q = store.inquiryOf(p.id, seg[3]); if (!q) throw new HttpError(404, '没有这条咨询');
        if (seg[4] === 'reply' && m === 'POST') {
          const t = body && body.text;
          if (typeof t !== 'string' || t.trim().length < 2 || t.length > 3000) throw new HttpError(422, '回复须为2至3000字');
          assertNoSensitive(t, '回复');
          if (q.status === 'closed') throw new HttpError(409, '这条咨询已经结束');
          store.addReply(q.id, t.trim()); return [201, { ok: true }];
        }
        if (seg[4] === 'status' && m === 'PUT') {
          if (!['viewed', 'closed'].includes(body && body.status)) throw new HttpError(422, 'status 须为 viewed 或 closed');
          if (!(body.status === 'viewed' && q.status !== 'sent')) store.setInquiryStatus(q.id, body.status);
          return { ok: true };
        }
      }
      throw new HttpError(404, '没有这个接口');
    }
    if (seg[1] === 'providers' && seg[2] === 'categories' && m === 'GET') {
      // 士业只收固定的展示费，不按成交抽成；非士业可以有推广佣金，并标明“含推广”。
      return ref.CATS.map((c) => ({ key: c[0], name: c[1], what: c[2], regulated: !!ref.REGULATED[c[0]], feeModel: ref.REGULATED[c[0]] ? 'fixed_listing' : 'affiliate_disclosed' }));
    }
    if (seg[1] === 'users') {
      if (!seg[2] && m === 'POST') {
        if (!body || body.accept !== TERMS_VERSION) throw new HttpError(422, '要先同意使用条款和隐私政策（版本 ' + TERMS_VERSION + '）');
        const wait = signup(req.socket.remoteAddress || '');
        if (wait) throw tooMany(wait, '新建账号太频繁');
        return [201, store.createUser(TERMS_VERSION)];
      }
      const u = user(seg[2], req);
      const sub = seg[3];
      if (!sub && m === 'GET') return u;
      if (!sub && m === 'DELETE') { store.deleteUser(u.id); return [204, null]; }
      if (sub === 'events') {
        if (m === 'GET') return store.listEvents(u.id).map((ev) => Object.assign(ev, { label: evTypes.has(ev.type) ? ref.EVRULES[ev.type][0] : '' }));
        if (m === 'POST') {
          const b = body || {};
          if (typeof b.type !== 'string' || !evTypes.has(b.type)) throw new HttpError(422, '事件类型无效');
          if (!isDate(b.date)) throw new HttpError(422, 'date 须为 YYYY-MM-DD，且是真实存在的日期');
          if (b.note != null && (typeof b.note !== 'string' || b.note.length > 200)) throw new HttpError(422, 'note 须为200字以内');
          assertNoSensitive(b.note, '备注');
          return [201, { id: store.addEvent(u.id, { type: b.type, date: b.date, note: b.note }) }];
        }
        if (m === 'DELETE' && seg[4]) { if (!store.deleteEvent(u.id, seg[4])) throw new HttpError(404, '没有这个事件'); return [204, null]; }
      }
      if (sub === 'state' && m === 'PUT') {
        // 网页端整体同步：概况和已完成的任务一起存。
        const b = body || {};
        const profile = validateProfilePatch(b.profile || {});
        const done = {};
        for (const k of Object.keys(b.done || {})) { if (!nodeIds.has(k)) throw new HttpError(422, '节点无效：' + k); if (b.done[k]) done[k] = true; }
        Object.assign(u.profile, profile); u.done = done;
        store.saveUser(u, 'state.sync');
        return { ok: true };
      }
      if (sub === 'profile' && m === 'PATCH') {
        Object.assign(u.profile, validateProfilePatch(body || {}));
        store.saveUser(u, 'profile.update', { keys: Object.keys(body || {}) });
        return u.profile;
      }
      if (sub === 'tasks' && seg[4] && seg[5] === 'done' && m === 'PUT') {
        if (!nodeIds.has(seg[4])) throw new HttpError(404, '没有这个节点');
        const on = !body || body.done !== false;
        if (on) {
          const st = engineFor(u).compute()[seg[4]];
          if (st.state === 'locked') throw new HttpError(409, '这个任务还没解锁：' + (st.note || ''));
          u.done[seg[4]] = true;
        } else delete u.done[seg[4]];
        store.saveUser(u, 'task.done', { id: seg[4], on });
        return engineFor(u).plan();
      }
      if (sub === 'plan' && m === 'GET') return engineFor(u).plan();
      // date 是日本时间的日历日（YYYY-MM-DD 的文字，不是时刻）；src 是事件期限的依据（法条、官方页面），没有则为 null
      if (sub === 'reminders' && m === 'GET') return engineFor(u).reminders().map((r) => ({ date: r.date, text: r.txt, tag: r.tag, src: r.src || null }));
      if (sub === 'advice' && m === 'GET') return engineFor(u).advice().map((a) => ({ title: a[0], text: a[1] }));
      if (sub === 'pr-check' && m === 'GET') return engineFor(u).prCheck();
      if (sub === 'chat' && m === 'POST') {
        const llm = opts.llm || (process.env.ANTHROPIC_API_KEY ? assistant.anthropicLLM(process.env.ANTHROPIC_API_KEY) : null);
        if (!llm) throw new HttpError(503, '助手还没有配置（缺少 ANTHROPIC_API_KEY）');
        const b = body || {};
        if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 2000) throw new HttpError(422, 'message 须为1至2000字');
        // 对话内容会转给模型服务商，敏感号码在这里拦下
        assertNoSensitive(b.message, '消息');
        // 历史是网页端带回来的，逐条校验形状和大小；不合规则返回 422，网页端清空历史后重试
        const history = assistant.validateHistory(b.history);
        // 历史里的每一段文字都会转给模型：用户说的话、助手的话、工具调用的参数、工具结果，全部过一遍。
        // 说明以 history 开头，网页端据此清空历史后重试（不然每一轮都会被同一条历史挡住）。
        for (const t of assistant.historyTexts(history)) {
          const label = sensitiveLabel(t);
          if (label) throw new HttpError(422, 'history 无效（对话历史里疑似含有' + label + '）。请清空对话历史后重试');
        }
        const wait = chatShort(u.id) || chatDaily(u.id);
        if (wait) throw tooMany(wait, '提问太频繁');
        const r = await assistant.chat({ user: u, store, now: nowOf() }, history, b.message, { llm });
        // draft：助手准备的咨询草稿（没有则为 null）。草稿没有发送，网页端显示给用户核对，用户同意后调 POST /inquiries。
        return { text: r.text, category: r.category, toolCalls: r.toolCalls.map((t) => ({ name: t.name, ok: t.ok })), draft: r.draft, history: r.messages };
      }
      if (sub === 'inquiries' && m === 'GET') return store.listInquiries(u.id);
      if (sub === 'inquiries' && m === 'POST') {
        const b = body || {};
        if (b.consent !== true) throw new HttpError(422, '发给服务商之前必须先让用户看过摘要并明确同意');
        const q = validateInquiry(b, inquiryDeps); // 和助手准备草稿用同一套校验
        return [201, { ids: q.providerIds.map((pid) => store.addInquiry(u.id, { providerId: pid, nodeId: q.nodeId, category: q.category, summary: q.summary })) }];
      }
    }
    throw new HttpError(404, '没有这个接口');
  }

  const webDir = opts.webDir || path.join(__dirname, '..', 'web');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  async function handle(req, res, send) {
    try {
      // 解析地址也放在 try 里：像 "//" 这样解析不了的请求返回 400，而不是让进程退出
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch (e) { throw new HttpError(400, '请求地址无效'); }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持这个方法');
        const f = path.join(webDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\]|\.\.)+/, ''));
        if (f.includes('\0') || !(f === webDir || f.startsWith(webDir + path.sep)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, { error: '没有这个页面' });
        const stream = fs.createReadStream(f);
        // 文件读到一半出错（被删、磁盘错误）不能变成未处理的 error 事件
        stream.on('error', (e) => { console.error(e); if (!res.headersSent) send(500, { error: '服务器内部错误' }); else res.destroy(); });
        stream.once('open', () => { res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); if (req.method === 'HEAD') { stream.destroy(); res.end(); } else stream.pipe(res); });
        res.on('close', () => stream.destroy());
        return;
      }
      let body = null;
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new HttpError(413, '请求太大'); chunks.push(c); }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) { try { body = JSON.parse(raw); } catch (e) { throw new HttpError(400, '请求体须为 JSON'); } }
        if (body !== null && (typeof body !== 'object' || Array.isArray(body))) throw new HttpError(400, '请求体须为 JSON 对象');
      }
      const r = await route(req, url, body);
      if (Array.isArray(r) && typeof r[0] === 'number') return send(r[0], r[1]);
      send(200, r);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message }, e.headers);
      console.error(e); send(500, { error: '服务器内部错误' });
    }
  }
  const server = http.createServer((req, res) => {
    // send 自己不会抛错：响应已经发出或连接已断时什么都不做
    const send = (status, obj, headers) => {
      try {
        if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.destroy(); return; }
        res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {}));
        res.end(obj == null ? '' : JSON.stringify(obj));
      } catch (e) { console.error(e); try { res.destroy(); } catch (e2) { /* 连接已经没了 */ } }
    };
    req.on('error', () => {}); res.on('error', () => {});
    // 最后一道兜底：handle 里任何没接住的错误都在这里结束，不会变成未处理的 rejection 让进程退出
    handle(req, res, send).catch((e) => { console.error(e); send(500, { error: '服务器内部错误' }); });
  });
  return { server, store };
}

module.exports = { createApp, validateProfilePatch };

if (require.main === module) {
  const port = +process.env.PORT || 8787;
  const { server } = createApp({ dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'zairyu.db') });
  server.listen(port, () => console.log('在留导航 后端已启动： http://localhost:' + port));
}
