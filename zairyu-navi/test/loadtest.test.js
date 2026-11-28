// 压力测试脚本的汇总（tools/loadtest.js）：被限流的 429 单独一列，不算非 2xx，耗时不算进 p50 等
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, table } = require('../tools/loadtest');

test('压力测试汇总：429 记在“限流 429”一列，不算非 2xx，也不进耗时', () => {
  const stats = {
    'POST event': { n: 5, bad: 1, codes: { 500: 1 }, limited: 2, ms: [10, 20, 30] },
    'DELETE event': { n: 3, bad: 0, codes: {}, ms: [5, 6, 7] }
  };
  const { rows, total } = summarize(stats, 1);
  const post = rows.find((r) => r.name === 'POST event');
  assert.equal(post.n, 5); assert.equal(post.bad, 1); assert.equal(post.limited, 2);
  assert.equal(post.p50, 20); assert.equal(post.max, 30, '只算没被限流的三次');
  assert.equal(rows.find((r) => r.name === 'DELETE event').limited, 0);
  assert.equal(total.n, 8); assert.equal(total.bad, 1); assert.equal(total.limited, 2); assert.equal(total.max, 30);
  const md = table(rows, total).split('\n');
  assert.match(md[0], /\| 非 2xx \| 限流 429 \|/);
  assert.equal(md[2], '| POST event | 5 | 1 {"500":1} | 2 | 5 | 20 | 30 | 30 | 30 |');
  assert.match(md[4], /^\| 合计 \| 8 \| 1 \| 2 \|/);
});
