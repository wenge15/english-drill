'use strict';

/**
 * 三个练习模式（new / review / wrong）的测试。
 * 重点：
 *  - new 只练 reps=0，不超 newLimit；
 *  - review 只练 reps>0，到期优先；
 *  - wrong 只练曾答错的题，错次数多优先，且 round=2（订正轮）；
 *  - 各模式续练互不干扰；
 *  - modeCounts 与实际一致。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createRepo } = require('../src/core/db.js');

const DAY = 86400000;

function freshRepo() {
  const repo = createRepo(':memory:');
  repo.setSetting('shuffleOptions', false);
  repo.setSetting('shuffleOrder', false);
  return repo;
}

function mkQuestion(i) {
  return {
    stem: `Question number ${i} ____ here.`,
    options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
    answer: 'B',
    explanation: `解析 ${i}`,
    knowledgePoints: ['时态'],
    difficulty: 'medium',
  };
}

/** 把一道题标成"已学过"（reps>0），可指定 lapses 与 dueAt。 */
function markReviewed(repo, id, { reps = 1, lapses = 0, dueAt = Date.now() - DAY } = {}) {
  repo.raw
    .prepare('UPDATE questions SET reps=?, lapses=?, last_review_at=?, due_at=?, interval_days=? WHERE id=?')
    .run(reps, lapses, Date.now() - DAY, dueAt, 1, id);
}

test('new 模式：只含 reps=0 的题，且不超 newLimit', () => {
  const repo = freshRepo();
  for (let i = 1; i <= 5; i += 1) repo.saveQuestion(mkQuestion(i)); // 5 道新题
  const reviewed = repo.saveQuestion(mkQuestion(6));
  markReviewed(repo, reviewed.id, {});
  repo.setSetting('newLimit', 3);

  const { session } = repo.startDailySession({ mode: 'new', now: Date.now(), force: true });
  assert.ok(session);
  assert.strictEqual(session.mode, 'new');
  assert.strictEqual(session.round, 1);
  const items = repo.sessionDetail(session.id).items;
  assert.strictEqual(items.length, 3, '只出 newLimit 道');
  const ids = items.map((it) => it.questionId);
  assert.ok(!ids.includes(reviewed.id), 'reps>0 的题不应出现在 new 模式');
  for (const qid of ids) assert.strictEqual(repo.getQuestion(qid).state.reps, 0, 'new 模式全是新题');
  repo.close();
});

test('review 模式：只含 reps>0 的题，到期的排在没到期前面', () => {
  const repo = freshRepo();
  const now = Date.now();
  const overdue = repo.saveQuestion(mkQuestion(1));
  const dueNow = repo.saveQuestion(mkQuestion(2));
  const future = repo.saveQuestion(mkQuestion(3));
  repo.saveQuestion(mkQuestion(4)); // 新题，不应出现
  markReviewed(repo, overdue.id, { dueAt: now - 2 * DAY });
  markReviewed(repo, dueNow.id, { dueAt: now - 1000 });
  markReviewed(repo, future.id, { dueAt: now + 5 * DAY });

  const { session } = repo.startDailySession({ mode: 'review', now, force: true });
  const items = repo.sessionDetail(session.id).items;
  const ids = items.map((it) => it.questionId);
  assert.strictEqual(ids.length, 3, '只含 reps>0 的题');
  assert.deepStrictEqual(ids, [overdue.id, dueNow.id, future.id], '到期（含逾期）的排在没到期前面');
  repo.close();
});

test('wrong 模式：只含曾答错的题，错次数多的排前面，且 round=2', () => {
  const repo = freshRepo();
  const now = Date.now();
  const w1 = repo.saveQuestion(mkQuestion(1)); // 错 3 次
  const w2 = repo.saveQuestion(mkQuestion(2)); // 错 1 次
  repo.saveQuestion(mkQuestion(3)); // 从没错过（reps=0）
  const ins = repo.raw.prepare('INSERT INTO attempts(question_id, session_id, round, picked, correct, created_at) VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 3; i += 1) ins.run(w1.id, null, 1, 'A', 0, now - i * 1000);
  ins.run(w2.id, null, 1, 'A', 0, now - 1000);
  repo.raw.prepare('UPDATE questions SET lapses=3 WHERE id=?').run(w1.id);
  repo.raw.prepare('UPDATE questions SET lapses=1 WHERE id=?').run(w2.id);

  const { session } = repo.startDailySession({ mode: 'wrong', now, force: true });
  assert.strictEqual(session.round, 2, 'wrong 模式是订正轮，round=2');
  assert.strictEqual(session.phase, 'reviewing');
  const items = repo.sessionDetail(session.id).items;
  const ids = items.map((it) => it.questionId);
  assert.strictEqual(ids.length, 2, '只含曾答错的题');
  assert.deepStrictEqual(ids, [w1.id, w2.id], '错次数多的排前面');
  repo.close();
});

test('各模式续练互不干扰（不同 mode 不互相 resume）', () => {
  const repo = freshRepo();
  for (let i = 1; i <= 5; i += 1) repo.saveQuestion(mkQuestion(i));
  const reviewed = repo.saveQuestion(mkQuestion(6));
  markReviewed(repo, reviewed.id, {});
  const now = Date.now();

  const r1 = repo.startDailySession({ mode: 'new', now, force: true });
  assert.strictEqual(r1.resumed, false);

  const r2 = repo.startDailySession({ mode: 'review', now });
  assert.strictEqual(r2.resumed, false, 'review 不应续 new 会话');
  assert.notStrictEqual(r2.session.id, r1.session.id);

  const r3 = repo.startDailySession({ mode: 'new', now });
  assert.strictEqual(r3.resumed, true, '同 mode 才续练');
  assert.strictEqual(r3.session.id, r1.session.id);
  repo.close();
});

test('modeCounts：数字与各模式候选一致', () => {
  const repo = freshRepo();
  for (let i = 1; i <= 4; i += 1) repo.saveQuestion(mkQuestion(i)); // 4 新题
  const r1 = repo.saveQuestion(mkQuestion(5));
  const r2 = repo.saveQuestion(mkQuestion(6));
  const w = repo.saveQuestion(mkQuestion(7));
  markReviewed(repo, r1.id, { dueAt: Date.now() - 1000 });
  markReviewed(repo, r2.id, { dueAt: Date.now() + 5 * DAY });
  markReviewed(repo, w.id, { lapses: 2, dueAt: Date.now() - 1000 });

  repo.setSetting('newLimit', 2);
  repo.setSetting('maxTotal', 3);

  const c = repo.modeCounts(Date.now());
  assert.strictEqual(c.new.total, 4);
  assert.strictEqual(c.new.available, 2, 'min(4, newLimit=2)');
  assert.strictEqual(c.review.total, 3);
  assert.strictEqual(c.review.due, 2, 'r1 与 w 到期，r2 未到期');
  assert.strictEqual(c.review.available, 3, 'min(3, maxTotal=3)');
  assert.strictEqual(c.wrong.total, 1, '只有 w 有 lapses>0');
  assert.strictEqual(c.wrong.available, 1);
  repo.close();
});
