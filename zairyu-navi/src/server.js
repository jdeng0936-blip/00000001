// 在留导航 第一期后端：路线、提醒、选方案、对接咨询。零依赖（Node 22 自带模块）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const createEngine = require('./engine');
const { createStore } = require('./store');

const { validateProfilePatch, HttpError } = require('./validate');
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
        return [201, store.createUser(TERMS_VERSION)];
      }
      const u = user(seg[2], req);
      const sub = seg[3];
      if (!sub && m === 'GET') return u;
      if (!sub && m === 'DELETE') { store.deleteUser(u.id); return [204, null]; }
      if (sub === 'events') {
        if (m === 'GET') return store.listEvents(u.id).map((ev) => Object.assign(ev, { label: ref.EVRULES[ev.type][0] }));
        if (m === 'POST') {
          const b = body || {};
          if (!ref.EVRULES[b.type]) throw new HttpError(422, '事件类型无效');
          if (!ref.isDate(b.date)) throw new HttpError(422, 'date 须为 YYYY-MM-DD');
          if (b.note != null && (typeof b.note !== 'string' || b.note.length > 200)) throw new HttpError(422, 'note 须为200字以内');
          return [201, { id: store.addEvent(u.id, b) }];
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
      if (sub === 'reminders' && m === 'GET') return engineFor(u).reminders().map((r) => ({ date: r.d, text: r.txt, tag: r.tag }));
      if (sub === 'advice' && m === 'GET') return engineFor(u).advice().map((a) => ({ title: a[0], text: a[1] }));
      if (sub === 'pr-check' && m === 'GET') return engineFor(u).prCheck();
      if (sub === 'chat' && m === 'POST') {
        const llm = opts.llm || (process.env.ANTHROPIC_API_KEY ? assistant.anthropicLLM(process.env.ANTHROPIC_API_KEY) : null);
        if (!llm) throw new HttpError(503, '助手还没有配置（缺少 ANTHROPIC_API_KEY）');
        const b = body || {};
        if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 2000) throw new HttpError(422, 'message 须为1至2000字');
        const r = await assistant.chat({ user: u, store, now: nowOf() }, Array.isArray(b.history) ? b.history.slice(-20) : [], b.message, { llm });
        return { text: r.text, category: r.category, toolCalls: r.toolCalls.map((t) => ({ name: t.name, ok: t.ok })), history: r.messages };
      }
      if (sub === 'inquiries' && m === 'GET') return store.listInquiries(u.id);
      if (sub === 'inquiries' && m === 'POST') {
        const b = body || {};
        if (b.consent !== true) throw new HttpError(422, '发给服务商之前必须先让用户看过摘要并明确同意');
        if (!catKeys.has(b.category)) throw new HttpError(422, '服务类别无效');
        if (b.nodeId && !nodeIds.has(b.nodeId)) throw new HttpError(422, '节点无效');
        if (typeof b.summary !== 'string' || b.summary.trim().length < 5 || b.summary.length > 2000) throw new HttpError(422, '摘要须为5至2000字');
        if (/\d{12}/.test(b.summary.replace(/[\s-]/g, ''))) throw new HttpError(422, '摘要里疑似含有个人编号，请删掉后再发');
        const ids = Array.isArray(b.providerIds) ? b.providerIds : (b.providerId ? [b.providerId] : []);
        if (!ids.length) throw new HttpError(422, '要先选服务商');
        if (ids.length > 3 || new Set(ids).size !== ids.length) throw new HttpError(422, '一次最多发给三家，且不能重复');
        for (const pid of ids) { const p = store.getProvider(pid); if (!p || !p.active || p.category !== b.category) throw new HttpError(422, '服务商无效或类别不符'); }
        return [201, { ids: ids.map((pid) => store.addInquiry(u.id, { providerId: pid, nodeId: b.nodeId, category: b.category, summary: b.summary.trim() })) }];
      }
    }
    throw new HttpError(404, '没有这个接口');
  }

  const webDir = path.join(__dirname, '..', 'web');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
    try {
      if (!url.pathname.startsWith('/api/')) {
        const f = path.join(webDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\]|\.\.)+/, ''));
        if (!f.startsWith(webDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, { error: '没有这个页面' });
        res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        return fs.createReadStream(f).pipe(res);
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
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e); send(500, { error: '服务器内部错误' });
    }
  });
  return { server, store };
}

module.exports = { createApp, validateProfilePatch };

if (require.main === module) {
  const port = +process.env.PORT || 8787;
  const { server } = createApp({ dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'zairyu.db') });
  server.listen(port, () => console.log('在留导航 后端已启动： http://localhost:' + port));
}
