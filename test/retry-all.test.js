'use strict';

/**
 * 验证「错题跨会话汇总」：
 *   造两天两个会话，各留错题；断言「继续重做」的题数 = 跨天去重后的总数，
 *   且重做轮真的把两天的错题都放进来了。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createRepo, localDay } = require('../src/core/db.js');

const DAY = 86400000;

function freshRepo() {
  const repo = createRepo(':memory:');
  repo.setSetting('shuffleOptions', false);
  repo.setSetting('shuffleOrder', false);
  repo.setSetting('newLimit', 50);
  repo.setSetting('maxTotal', 200);
  return repo;
}

function mkQuestion(i) {
  return {
    stem: `Cross-day wrong ${i} ____ here.`,
    options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
    answer: 'B',
    explanation: `解析 ${i}`,
    knowledgePoints: ['跨天'],
    difficulty: 'medium',
  };
}

/** 造一场练习并让指定题做错（picked 故意选 A，正确答案是 B）。 */
function makeWrongSession(repo, questionIds, now) {
  const started = repo.startDailySession({ now, force: true });
  assert.ok(started.session, '应能开始练习');
  const sid = started.session.id;
  for (const qid of questionIds) {
    repo.recordAnswer(sid, qid, 'A', { now });
  }
  return sid;
}

test('错题跨会话汇总：昨天+今天的未订正错题都会被算进「继续重做」', () => {
  const repo = freshRepo();
  const ids = [];
  for (let i = 1; i <= 6; i += 1) ids.push(repo.saveQuestion(mkQuestion(i)).id);

  // 昨天（第 1 天）：做 4 道题，错的 3 道
  const day1 = Date.now() - DAY;
  const s1 = makeWrongSession(repo, ids.slice(0, 4), day1);
  // 清掉昨天会话里的正确题，让它们不干扰判断（保留即可，MAX(correct)=1 不计入）
  const day2 = Date.now();
  const s2 = makeWrongSession(repo, ids.slice(3, 6), day2);

  assert.notStrictEqual(s1, s2, '应该是两个不同会话');

  const pending = repo.pendingRetrySession();
  assert.ok(pending, '应能找到一个待重做入口');

  // 统计所有会话里 MAX(correct)=0 的题（去重）
  const raw = repo.raw;
  const expected = raw
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT question_id FROM practice_questions
         GROUP BY question_id HAVING MAX(correct) = 0
       )`,
    )
    .get().c;
  assert.ok(expected > 0, '前置条件：应该有未订正错题');
  assert.strictEqual(pending.wrongCount, expected, '入口显示的题数必须等于跨会话汇总数');

  // 关键：昨天会话里没订正的题，也要被算进去
  const day1Wrong = raw
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT question_id FROM practice_questions WHERE session_id = ?
         GROUP BY question_id HAVING MAX(correct) = 0
       )`,
    )
    .get(s1).c;
  assert.ok(day1Wrong > 0, '前置条件：昨天会话应有未订正错题');
  assert.ok(
    pending.wrongCount > day1Wrong,
    `汇总数(${pending.wrongCount}) 应大于单场昨天会话的错题数(${day1Wrong})`,
  );
});

test('错题跨会话汇总：重做轮会把所有天的未订正错题都放进来', () => {
  const repo = freshRepo();
  const ids = [];
  for (let i = 1; i <= 6; i += 1) ids.push(repo.saveQuestion(mkQuestion(i)).id);

  const s1 = makeWrongSession(repo, ids.slice(0, 3), Date.now() - DAY);
  const s2 = makeWrongSession(repo, ids.slice(3, 6), Date.now());

  const pending = repo.pendingRetrySession();
  const rr = repo.startRetryRound(pending.sessionId);
  assert.ok(rr, '应能开启重做轮');
  assert.ok(rr.items.length >= 6, `重做轮应包含两天的全部 6 道错题，实际 ${rr.items.length}`);

  // 昨天会话里的题也必须出现在重做轮里
  const day1Ids = repo.raw
    .prepare(
      `SELECT question_id FROM practice_questions WHERE session_id = ?
       GROUP BY question_id HAVING MAX(correct) = 0`,
    )
    .all(s1)
    .map((r) => r.question_id);
  const set = new Set(rr.items.map((it) => (typeof it === 'object' ? it.questionId : it)));
  for (const qid of day1Ids) {
    assert.ok(set.has(qid), `昨天会话的错题 ${qid} 必须出现在重做轮里`);
  }
});

test('错题跨会话汇总：任何一轮做对后就不再出现在待重做列表', () => {
  const repo = freshRepo();
  const ids = [];
  for (let i = 1; i <= 3; i += 1) ids.push(repo.saveQuestion(mkQuestion(i)).id);

  const s1 = makeWrongSession(repo, ids, Date.now() - DAY);
  const before = repo.pendingRetrySession();
  const beforeCount = before ? before.wrongCount : 0;
  assert.strictEqual(beforeCount, 3, '前置条件：3 道都错');

  // 在重做轮里全部答对
  const rr = repo.startRetryRound(s1);
  for (const it of rr.items) {
    const qid = typeof it === 'object' ? it.questionId : it;
    repo.recordAnswer(s1, qid, 'B', {}); // 正确答案
  }

  const after = repo.pendingRetrySession();
  assert.strictEqual(after, null, '全部订正后不应再有待重做入口');
});
