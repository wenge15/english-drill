'use strict';

/**
 * 录入草稿的纯函数辅助层。
 *
 * 前端 desktop/renderer/index.html 是内联 JS、无构建，无法 require 本模块，
 * 所以这里把「残缺题分离」和「草稿序列化/恢复」抽成纯函数，
 * 前端内联实现与之保持同等语义；单测则直接 require 这里做确定性行为断言。
 *
 * 纯函数：不碰 localStorage / DOM，可在 node:test 里确定性验证。
 */

/**
 * 把识别出的题按「是否残缺」分成两组。
 * incomplete === true 的题（被页面顶部/底部/侧边裁断）进 excluded，
 * 其余进 complete（即待入库的 pending）。
 *
 * @param {Array} list 已规范化的题目数组
 * @returns {{ complete: Array, excluded: Array }}
 */
function splitIncomplete(list) {
  const complete = [];
  const excluded = [];
  for (const q of list || []) {
    if (q && q.incomplete === true) excluded.push(q);
    else complete.push(q);
  }
  return { complete, excluded };
}

/**
 * 把草稿状态序列化成可 JSON 存储的对象。
 * 题目对象都是文本/数组，直接 JSON 序列化即可；不额外复制，避免丢字段。
 */
function serializeDraft(state) {
  const s = state || {};
  return {
    pending: Array.isArray(s.pending) ? s.pending : [],
    excluded: Array.isArray(s.excluded) ? s.excluded : [],
    pendingSource: typeof s.pendingSource === 'string' ? s.pendingSource : 'text',
    savedAt: s.savedAt || new Date().toISOString(),
  };
}

/**
 * 从字符串（或对象）恢复草稿。非法、缺失 pending 字段时返回 null。
 */
function deserializeDraft(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.pending)) return null;
  return {
    pending: obj.pending,
    excluded: Array.isArray(obj.excluded) ? obj.excluded : [],
    pendingSource: typeof obj.pendingSource === 'string' ? obj.pendingSource : 'text',
    savedAt: obj.savedAt || null,
  };
}

module.exports = { splitIncomplete, serializeDraft, deserializeDraft };
