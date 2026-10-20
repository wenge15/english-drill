'use strict';

/**
 * 录入草稿纯函数层测试（src/core/draft.js）。
 * 覆盖两件事：
 *   1. 不完整题统计（countIncomplete）：incomplete===true 的题被数出来，用于提醒而非排除。
 *   2. 草稿序列化/恢复：pending/pendingSource 的存与取（不再有 excluded）。
 * 都是确定性行为断言，不靠字符串匹配。
 */

const test = require('node:test');
const assert = require('node:assert');
const { countIncomplete, serializeDraft, deserializeDraft } = require('../src/core/draft.js');

test('countIncomplete：只数 incomplete===true 的题', () => {
  const list = [
    { stem: '完整题', incomplete: false },
    { stem: '选项被裁掉', incomplete: true, incompleteReason: '选项 D 被裁掉' },
    { stem: '没标 incomplete 字段', options: { A: 'a', B: 'b' } },
    { stem: '另一道不完整', incomplete: true },
  ];
  assert.strictEqual(countIncomplete(list), 2);
});

test('countIncomplete：空输入与空数组都返回 0', () => {
  assert.strictEqual(countIncomplete(null), 0);
  assert.strictEqual(countIncomplete([]), 0);
});

test('serializeDraft：保留 pending/pendingSource，并打上 savedAt，不含 excluded', () => {
  const pending = [{ stem: 'q1' }];
  const s = serializeDraft({ pending, pendingSource: 'image' });
  assert.deepStrictEqual(s.pending, pending);
  assert.strictEqual(s.pendingSource, 'image');
  assert.ok(s.savedAt, '应有保存时间');
  assert.ok(!Number.isNaN(Date.parse(s.savedAt)), 'savedAt 应是合法时间戳');
  assert.ok(!('excluded' in s), '草稿不应再存 excluded 字段');
});

test('serializeDraft：缺字段时用安全默认值', () => {
  const s = serializeDraft({});
  assert.deepStrictEqual(s.pending, []);
  assert.strictEqual(s.pendingSource, 'text');
});

test('deserializeDraft：从 JSON 字符串恢复草稿', () => {
  const raw = JSON.stringify({
    pending: [{ stem: 'q1' }],
    pendingSource: 'image',
    savedAt: '2026-01-01T00:00:00.000Z',
  });
  const d = deserializeDraft(raw);
  assert.strictEqual(d.pending.length, 1);
  assert.strictEqual(d.pendingSource, 'image');
  assert.strictEqual(d.savedAt, '2026-01-01T00:00:00.000Z');
});

test('deserializeDraft：非法输入返回 null', () => {
  assert.strictEqual(deserializeDraft(null), null);
  assert.strictEqual(deserializeDraft(''), null);
  assert.strictEqual(deserializeDraft('{broken json'), null);
  assert.strictEqual(deserializeDraft('{"noPending":true}'), null);
});

test('deserializeDraft：直接传对象也能恢复，并补全缺省字段', () => {
  const d = deserializeDraft({ pending: [{ stem: 'q1' }] });
  assert.strictEqual(d.pending.length, 1);
  assert.strictEqual(d.pendingSource, 'text');
});
