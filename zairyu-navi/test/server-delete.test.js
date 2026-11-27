// 删除账号要么全部完成，要么什么都不动。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../src/store');

test('删除账号：中途失败时整体回滚，不留下删了一半的账号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zairyu-del-')), file = path.join(dir, 't.db');
  const store = createStore(file);
  try {
    const u = store.createUser('v'), p = store.createProvider({ name: '甲', category: 'gyosei', licenseNo: '1', feeModel: 'fixed_listing' });
    store.addEvent(u.id, { type: 'move', date: '2026-12-01' });
    const qid = store.addInquiry(u.id, { providerId: p.id, category: 'gyosei', summary: '想咨询在留更新的手续。' });
    store.addReply(qid, '可以办理。');
    // 用另一个连接加一个触发器，让“删 users 这一步”失败（前面的几步已经执行过）
    const other = new DatabaseSync(file);
    other.exec("CREATE TRIGGER block_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, '模拟失败'); END;"); other.close();
    assert.throws(() => store.deleteUser(u.id), /模拟失败/);
    assert.ok(store.getUser(u.id), '账号还在');
    assert.equal(store.listEvents(u.id).length, 1, '事件没有被删掉一半');
    const mine = store.listInquiries(u.id);
    assert.equal(mine.length, 1); assert.equal(mine[0].replies.length, 1, '咨询和回复都还在');
    assert.ok(store.auditRows().some((a) => a.userId === u.id), '留痕也没有被改');
    assert.ok(!store.auditRows().some((a) => a.action === 'user.delete'), '没删成就不记删除');
    // 去掉触发器后可以正常删，库还能继续用（事务没有卡住）
    const again = new DatabaseSync(file); again.exec('DROP TRIGGER block_delete'); again.close();
    store.deleteUser(u.id);
    assert.equal(store.getUser(u.id), undefined);
    assert.equal(store.listEvents(u.id).length, 0); assert.equal(store.listInquiriesFor(p.id).length, 0);
    assert.ok(!JSON.stringify(store.auditRows()).includes(u.id)); assert.ok(!JSON.stringify(store.auditRows()).includes(qid));
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
