// 数据库备份（npm run backup）和备份的核对（npm run backup:verify）。零依赖，用 Node 自带的 node:sqlite。
//
// npm run backup：用 SQLite 的 VACUUM INTO 在线备份（服务器照常运行，备份的是某一刻完整一致的库），
//   写到 BACKUP_DIR 下的 zairyu-YYYYMMDD-HHMMSSZ.db（UTC 时间，文件权限 600），先写临时名、核对 integrity_check 通过后再改名，
//   不会留下半截的备份；然后只留最新的 BACKUP_KEEP 份，更早的删掉。
//   VACUUM INTO 写出来的是压实的新文件，没有空闲页：库里已经删掉的行（secure_delete 已经用零盖掉）不会出现在备份里。
//   但备份是那一刻的样子：之后用户删掉的账号，在这份备份被轮换删掉之前仍然在备份里（期限见 docs/ops.md“备份”）。
// npm run backup:verify [文件]：核对一份备份（不给文件就是最新的一份）：只读打开做 integrity_check、表和索引一个不少，
//   再把它复制到临时目录，用现在的代码打开（会补上新版本的表和列）并做就绪检查（能写），即“恢复演练”；临时副本随后删掉。
//   只输出表的行数，不输出任何内容。
//
// 环境变量：DB_FILE（和 npm start 一样，默认项目根目录的 zairyu.db）、BACKUP_DIR（默认 DB_FILE 所在目录下的 backups）、
//   BACKUP_KEEP（留几份，1 至 365，默认 7）。写错了报一行原因、以退出码 1 结束（给 cron 用）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/store');

function backupConfig(env) {
  env = env || {};
  const dbFile = path.resolve(env.DB_FILE || path.join(__dirname, '..', 'zairyu.db'));
  const dir = path.resolve(env.BACKUP_DIR || path.join(path.dirname(dbFile), 'backups'));
  let keep = 7;
  if (env.BACKUP_KEEP != null && env.BACKUP_KEEP !== '') { keep = Number(env.BACKUP_KEEP); if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error('BACKUP_KEEP 须是 1 到 365 的整数'); }
  if (dir === path.dirname(dbFile) || dbFile.startsWith(dir + path.sep)) throw new Error('BACKUP_DIR 不能是库文件所在的目录（备份和库要分开放，轮换时才不会碰到库）');
  return { dbFile, dir, keep };
}

// 备份文件名：UTC 时间到秒。同一秒里再跑一次时加 -1、-2（不覆盖已有的备份）
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + 'Z';
// 从旧到新排：先按时间，同一秒里的按后面的序号（没有序号的是第一份）
const sortKey = (f) => { const m = /^zairyu-(\d{8}-\d{6})Z(?:-(\d+))?\.db$/.exec(f); return m[1] + '.' + String(m[2] || 0).padStart(6, '0'); };
const listBackups = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^zairyu-\d{8}-\d{6}Z(-\d+)?\.db$/.test(f)).sort((a, b) => sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);

// 只读打开一份库文件做核对：integrity_check 是 ok，建表语句里的表和索引一个不少。返回 { ok, problems, counts }
function checkFile(file) {
  const problems = [], counts = {};
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch (e) { return { ok: false, problems: ['打不开：' + String(e.message).slice(0, 120)], counts }; }
  try {
    const ic = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    if (!(ic.length === 1 && ic[0] === 'ok')) problems.push('integrity_check 没过：' + ic.slice(0, 3).join('；').slice(0, 200));
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => r.name));
    const ref = createStore(':memory:'); const want = ref.schemaNames(); ref.close();
    const missing = want.filter((n) => !have.has(n));
    if (missing.length) problems.push('缺少表或索引：' + missing.join('、'));
    for (const t of ['users', 'user_emails', 'events', 'inquiries', 'providers', 'outbox']) if (have.has(t)) counts[t] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
  } catch (e) { problems.push('核对时出错：' + String(e.message).slice(0, 120)); } finally { db.close(); }
  return { ok: !problems.length, problems, counts };
}

// 做一份备份。返回 { file, removed: [被轮换删掉的文件名], counts }
function backup(cfg, now) {
  if (!fs.existsSync(cfg.dbFile)) throw new Error('库文件不存在：' + cfg.dbFile);
  fs.mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  let name = 'zairyu-' + stamp(now || Date.now()) + '.db';
  for (let i = 1; fs.existsSync(path.join(cfg.dir, name)); i++) name = name.replace(/Z(-\d+)?\.db$/, 'Z-' + i + '.db');
  const file = path.join(cfg.dir, name), tmp = file + '.partial';
  fs.rmSync(tmp, { force: true });
  const src = new DatabaseSync(cfg.dbFile, { readOnly: true });
  try {
    src.exec('PRAGMA busy_timeout = 10000'); // 服务器正在写时等一等
    src.prepare('VACUUM INTO ?').run(tmp);
  } finally { src.close(); }
  fs.chmodSync(tmp, 0o600);
  const chk = checkFile(tmp);
  if (!chk.ok) { fs.rmSync(tmp, { force: true }); throw new Error('备份写出来了但核对没过，已删掉：' + chk.problems.join('；')); }
  // 先落盘再改名：改名之后这份备份就是完整的
  const fd = fs.openSync(tmp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const all = listBackups(cfg.dir);
  const removed = all.slice(0, Math.max(0, all.length - cfg.keep));
  for (const f of removed) fs.rmSync(path.join(cfg.dir, f), { force: true });
  return { file, removed, counts: chk.counts };
}

// 核对一份备份并做恢复演练。file 不给就是最新的一份
function verify(cfg, file) {
  if (!file) { const all = listBackups(cfg.dir); if (!all.length) throw new Error('在 ' + cfg.dir + ' 里没有找到备份'); file = path.join(cfg.dir, all[all.length - 1]); }
  const chk = checkFile(file);
  if (!chk.ok) return Object.assign({ file, restore: false }, chk);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-restore-'));
  let restore = false;
  try {
    const copy = path.join(tmpDir, 'restore.db');
    fs.copyFileSync(file, copy);
    const st = createStore(copy);
    try { const r = st.readiness(); restore = r.ok; if (!r.ok) chk.problems.push('恢复演练：就绪检查没过（' + r.failed.join('、') + '）'); } finally { st.close(); }
  } catch (e) { chk.problems.push('恢复演练：打不开（' + String(e.message).slice(0, 120) + '）'); } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  return { file, ok: chk.problems.length === 0, restore, problems: chk.problems, counts: chk.counts };
}

module.exports = { backupConfig, backup, verify, checkFile, listBackups };

if (require.main === module) {
  process.umask(0o077); // 备份里有邮箱等个人信息：目录和文件只给运行它的用户
  const args = process.argv.slice(2);
  try {
    const cfg = backupConfig(process.env);
    if (args[0] === '--verify') {
      const r = verify(cfg, args[1]);
      console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'backup.verify', file: path.basename(r.file), ok: r.ok, restore: r.restore, counts: r.counts, problems: r.problems }));
      process.exit(r.ok ? 0 : 1);
    }
    if (args.length) throw new Error('用法：node tools/backup.js [--verify [备份文件]]');
    const r = backup(cfg);
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'backup', file: path.basename(r.file), keep: cfg.keep, removed: r.removed, counts: r.counts }));
  } catch (e) { console.error('备份：' + String(e && e.message ? e.message : e).slice(0, 300)); process.exit(1); }
}
