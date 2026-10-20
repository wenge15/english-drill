'use strict';

/**
 * 录入草稿纯函数层测试（src/core/draft.js）。
 * 覆盖两件事：
 *   1. 残缺题分离（功能一）：incomplete===true 的题被自动排除到 excluded。
 *   2. 草稿序列化/恢复（功能二）：pending/excluded/pendingSource 的存与取。
 * 都是确定性行为断言，不靠字符串匹配。
 */

const test = require('node:test');
const assert = require('node:assert');
const { splitIncomplete, serializeDraft, deserializeDraft } = require('../src/core/draft.js');

test('splitIncomplete：incomplete===true 的题进 excluded，其余进 complete', () => {
  const list = [
    { stem: '完整题', incomplete: false },
    { stem: '被裁断的题', incomplete: true, incompleteReason: '选项 D 被裁掉' },
    { stem: '没标 incomplete 字段', options: { A: 'a', B: 'b' } },
  ];
  const { complete, excluded } = splitIncomplete(list);
  assert.strictEqual(complete.length, 2);
  assert.strictEqual(excluded.length, 1);
  assert.strictEqual(excluded[0].stem, '被裁断的题');
  assert.strictEqual(complete[0].stem, '完整题');
  assert.strictEqual(complete[1].stem, '没标 incomplete 字段');
});

test('splitIncomplete：空输入与空数组都安全', () => {
  assert.deepStrictEqual(splitIncomplete(null), { complete: [], excluded: [] });
  assert.deepStrictEqual(splitIncomplete([]), { complete: [], excluded: [] });
});

test('serializeDraft：保留 pending/excluded/pendingSource，并打上 savedAt', () => {
  const pending = [{ stem: 'q1' }];
  const excluded = [{ stem: 'q2', incomplete: true }];
  const s = serializeDraft({ pending, excluded, pendingSource: 'image' });
  assert.deepStrictEqual(s.pending, pending);
  assert.deepStrictEqual(s.excluded, excluded);
  assert.strictEqual(s.pendingSource, 'image');
  assert.ok(s.savedAt, '应有保存时间');
  assert.ok(!Number.isNaN(Date.parse(s.savedAt)), 'savedAt 应是合法时间戳');
});

test('serializeDraft：缺字段时用安全默认值', () => {
  const s = serializeDraft({});
  assert.deepStrictEqual(s.pending, []);
  assert.deepStrictEqual(s.excluded, []);
  assert.strictEqual(s.pendingSource, 'text');
});

test('deserializeDraft：从 JSON 字符串恢复草稿', () => {
  const raw = JSON.stringify({
    pending: [{ stem: 'q1' }],
    excluded: [{ stem: 'q2', incomplete: true }],
    pendingSource: 'image',
    savedAt: '2026-01-01T00:00:00.000Z',
  });
  const d = deserializeDraft(raw);
  assert.strictEqual(d.pending.length, 1);
  assert.strictEqual(d.excluded.length, 1);
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
  assert.deepStrictEqual(d.excluded, []);
  assert.strictEqual(d.pendingSource, 'text');
});
