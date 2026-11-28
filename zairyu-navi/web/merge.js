// 多台设备同时修改时的合并（网页端用；test/state-version.test.js 在 Node 里直接测这个文件）。
// 保存时服务器返回 409，说明另一台设备已经改过。手上有三份：
//   base   这台设备上一次和服务器对上的内容（上次读到或存上的）
//   mine   这台设备现在的内容（base 之后本机改过的）
//   theirs 服务器上现在的内容（409 里带回来的 current）
// 逐项合并：本机改过的项用本机的，本机没改的项用服务器的。两边都改了同一项、改得不一样时用本机的（这台设备的人刚改的），
// 并在 conflicts 里列出这一项，页面提示一句。
// - 概况：按字段（身份、各个日期、勾选项……）。
// - 已完成的任务：按任务编号，每个任务单独看。
// - 出国记录：每一条按“出国日~回国日”当作编号，本机加的加上、本机删的删掉，其余跟服务器。
// 事件（换工作、搬家……）每条单独存在服务器上，各有编号，不经过这里，不会互相覆盖。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZMerge = factory();
})(this, function () {
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function tripKey(t) { return t[0] + '~' + t[1]; }
  // 三份出国记录合并成一份，按日期排好；返回 { trips, conflict }（conflict：两边的改动没法都留，目前不会发生，留着备用）
  function mergeTrips(base, mine, theirs) {
    var b = {}, m = {}, out = {}, list = [];
    (base || []).forEach(function (t) { b[tripKey(t)] = t; });
    (mine || []).forEach(function (t) { m[tripKey(t)] = t; });
    (theirs || []).forEach(function (t) { var k = tripKey(t); if (has(b, k) && !has(m, k)) return; out[k] = t; }); // 本机删掉的不要
    Object.keys(m).forEach(function (k) { if (!has(b, k)) out[k] = m[k]; }); // 本机加的
    Object.keys(out).forEach(function (k) { list.push([out[k][0], out[k][1]]); });
    list.sort();
    return list;
  }
  function merge(base, mine, theirs) {
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    var bp = base.profile || {}, mp = mine.profile || {}, tp = theirs.profile || {}, profile = {}, conflicts = [];
    var keys = {};
    [bp, mp, tp].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      if (k === 'trips') {
        var mt = mp.trips || [], bt = bp.trips || [], tt = tp.trips || [];
        profile.trips = same(mt, bt) ? tt.slice() : mergeTrips(bt, mt, tt);
        return;
      }
      var mineChanged = !same(mp[k], bp[k]);
      if (mineChanged) {
        profile[k] = mp[k];
        if (!same(tp[k], bp[k]) && !same(tp[k], mp[k])) conflicts.push(k);
      } else profile[k] = has(tp, k) ? tp[k] : mp[k];
      if (profile[k] === undefined) delete profile[k];
    });
    var bd = base.done || {}, md = mine.done || {}, td = theirs.done || {}, done = {}, ids = {};
    [bd, md, td].forEach(function (o) { Object.keys(o).forEach(function (k) { ids[k] = 1; }); });
    Object.keys(ids).forEach(function (k) {
      var m = !!md[k], b = !!bd[k], t = !!td[k];
      if (m !== b ? m : t) done[k] = true;
    });
    return { profile: profile, done: done, conflicts: conflicts };
  }
  return { merge: merge, mergeTrips: mergeTrips };
});
