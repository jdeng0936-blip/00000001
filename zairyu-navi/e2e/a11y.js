// 无障碍和手机布局的自动检查（不加依赖：在浏览器里跑一段脚本，自己算）。e2e/browser.js 用它检查每个页面。
// 查的项目：
// - 横向滚动：页面比窗口宽（手机上要左右拖）
// - 点按目标：按钮、输入框、链接（正文里夹着的链接除外）手机上至少 44×44，电脑上至少 24×24；勾选框按包着它的 label 算
// - 字号：可见的文字至少 12px；手机上输入框至少 16px（小于 16px 时 iPhone 点进去会自动放大页面）
// - 标签：每个输入框、下拉框、文本框都有名字（label、aria-label 或 aria-labelledby），按钮有文字
// - 对比度：可见文字和背后实际的底色按 WCAG 2 算，普通文字至少 4.5，大字（24px 以上，或 18.66px 以上加粗）至少 3；禁用的控件不算
// - 结构：html 有 lang、有且只有一个 main 和一个 h1，标题不跳级（h2 后面直接 h4），id 不重复
// - 对话框：看得见的 role="dialog" 有 aria-modal、有名字，焦点在对话框里面
// 只看此刻看得见的内容（隐藏的视图、收起的 details 不算），所以要在各个状态下分别调用。
function inPage(opt) {
  const mobile = !!opt.mobile, out = [];
  const tag = (e) => {
    let s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id; else if (e.className && typeof e.className === 'string') s += '.' + e.className.trim().split(/\s+/).join('.');
    const t = (e.textContent || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    return t ? s + '「' + t + '」' : s;
  };
  const visible = (e) => {
    if (e.closest('[hidden],[inert]')) return false;
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    // 收起的 details 里面（summary 除外）
    const d = e.closest('details'); if (d && !d.open && !e.closest('summary')) return false;
    return true;
  };
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); if (!a) return [0, 0, 0, 0]; return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat([a]); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const canvas = parse(getComputedStyle(document.documentElement).backgroundColor)[3] ? parse(getComputedStyle(document.documentElement).backgroundColor) : (dark ? [18, 18, 18, 1] : [255, 255, 255, 1]);
  // 元素背后的底色：从自己往上把半透明的底色叠起来，直到不透明为止
  const bgOf = (e) => {
    const layers = [];
    for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
    let bg = canvas; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const opacityOf = (e) => { let o = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) o *= Number(getComputedStyle(x).opacity); return o; };

  // 横向滚动
  const sw = document.documentElement.scrollWidth, vw = window.innerWidth;
  if (sw > vw + 1) {
    const wide = [...document.querySelectorAll('body *')].filter((e) => visible(e) && e.getBoundingClientRect().right > vw + 1 && !e.closest('.tw,.route,.chips,pre'))
      .filter((e) => ![...e.children].some((c) => c.getBoundingClientRect().right > vw + 1)).slice(0, 3).map(tag);
    out.push('有横向滚动：页面宽 ' + sw + 'px，窗口 ' + vw + 'px（' + wide.join('，') + '）');
  }
  // 名字
  const nameOf = (e) => {
    if (e.getAttribute('aria-label')) return e.getAttribute('aria-label').trim();
    const lb = e.getAttribute('aria-labelledby'); if (lb) return lb.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || '').join(' ').trim();
    if (e.labels && e.labels.length) return [...e.labels].map((l) => l.textContent).join(' ').trim();
    if (/^(BUTTON|A|SUMMARY)$/.test(e.tagName)) return (e.textContent || '').trim();
    return (e.getAttribute('title') || '').trim();
  };
  const fields = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(visible);
  for (const e of fields) if (!nameOf(e)) out.push('输入框没有标签：' + tag(e));
  const clickables = [...document.querySelectorAll('a[href],button,summary,[tabindex]:not([tabindex="-1"])')].filter(visible);
  for (const e of clickables) if (!nameOf(e)) out.push('按钮或链接没有文字：' + tag(e));
  // 点按目标
  const min = mobile ? 44 : 24;
  for (const e of clickables.concat(fields)) {
    if (e.disabled) continue;
    let box = e;
    if (e.tagName === 'INPUT' && /^(checkbox|radio)$/.test(e.type)) { const l = e.closest('label') || (e.labels && e.labels[0]); if (l) box = l; }
    // 正文里夹着的链接：按 WCAG 2.5.8 的例外不算
    if (e.tagName === 'A') { const p = e.parentElement; if ([...p.childNodes].some((n) => n !== e && n.nodeType === 3 && n.textContent.trim())) continue; }
    const r = box.getBoundingClientRect();
    if (r.height < min - 0.5 || r.width < min - 0.5) out.push('点按目标太小（' + Math.round(r.width) + '×' + Math.round(r.height) + '，至少 ' + min + '）：' + tag(e));
  }
  // 手机上输入框的字号
  if (mobile) for (const e of fields) { if (/^(checkbox|radio)$/.test(e.type)) continue; const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < 16) out.push('输入框字号 ' + fs + 'px，手机上点进去会放大页面（至少 16px）：' + tag(e)); }
  // 文字：字号和对比度
  const texts = [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && visible(e));
  for (const e of texts.concat(fields.filter((f) => !/^(checkbox|radio)$/.test(f.type)))) {
    const cs = getComputedStyle(e), fs = parseFloat(cs.fontSize);
    if (fs < 12) out.push('字太小（' + fs + 'px）：' + tag(e));
    if (e.disabled || e.closest('button:disabled')) continue;
    const bg = bgOf(e), fg0 = parse(cs.color), o = opacityOf(e);
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * o], bg);
    const big = fs >= 24 || (fs >= 18.66 && Number(cs.fontWeight) >= 700), need = big ? 3 : 4.5, r = ratio(fg, bg);
    if (r < need - 0.005) out.push('对比度 ' + r.toFixed(2) + '（至少 ' + need + '）：' + tag(e) + ' 字 ' + cs.color + ' 底 rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')');
  }
  // 结构
  if (!document.documentElement.lang) out.push('html 没有 lang');
  if (document.querySelectorAll('main').length !== 1) out.push('main 不是一个');
  if (document.querySelectorAll('h1').length !== 1) out.push('h1 不是一个');
  let last = 0;
  for (const h of [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible)) {
    if (h.closest('[role=dialog]')) continue;
    const lv = +h.tagName[1]; if (last && lv > last + 1) out.push('标题跳级：h' + last + ' 后面是 ' + tag(h)); last = lv;
  }
  const ids = {}; for (const e of document.querySelectorAll('[id]')) { if (ids[e.id]) out.push('id 重复：' + e.id); ids[e.id] = 1; }
  // 对话框
  for (const d of [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog')].filter(visible)) {
    if (d.getAttribute('aria-modal') !== 'true' && d.tagName !== 'DIALOG') out.push('对话框没有 aria-modal：' + tag(d));
    if (!nameOf(d)) out.push('对话框没有名字：' + tag(d));
    if (!d.contains(document.activeElement)) out.push('对话框打开时焦点不在里面：' + tag(d) + '，焦点在 ' + tag(document.activeElement));
  }
  return [...new Set(out)];
}

async function audit(page, opt) { return page.evaluate(inPage, opt || {}); }

// 用 Tab 键走一遍：返回依次拿到焦点的元素，并查每一个有没有看得见的焦点样式（outline 或 box-shadow 和没拿到焦点时不一样）
async function tabWalk(page, n, opt) {
  const seen = [], bad = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(opt && opt.shift ? 'Shift+Tab' : 'Tab');
    const x = await page.evaluate(() => {
      const e = document.activeElement; if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow && cs.boxShadow !== 'none');
      const d = e.closest('[role=dialog]');
      return { id: e.id || e.tagName.toLowerCase() + '「' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 12) + '」', ring, dialog: d ? d.id : null };
    });
    seen.push(x);
    if (x && !x.ring) bad.push(x.id);
  }
  return { seen, noRing: [...new Set(bad)] };
}

module.exports = { audit, tabWalk, inPage };
