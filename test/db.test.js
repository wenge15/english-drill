'use strict';

/**
 * 数据层测试（node:sqlite 内存库）。
 * 最关键的场景：错题重做后，复习调度只能更新一次 —— 否则同一道题会被算两遍间隔，
 * 用户的复习节奏会整体崩掉。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createRepo, localDay } = require('../src/core/db.js');
const srs = require('../src/core/srs.js');

const DAY = srs.DAY_MS;

function freshRepo() {
  const repo = createRepo(':memory:');
  // 测试需要确定性：关掉两个乱序。
  // （乱序行为本身由 test/shuffle.test.js 专门验证；
  //   这里若开着乱序，"第 N 题"与"题库第 N 道"就不再对应，断言会随机失败。）
  repo.setSetting('shuffleOptions', false);
  repo.setSetting('shuffleOrder', false);
  return repo;
}

function mkQuestion(i, kp = ['时态']) {
  return {
    stem: `Question number ${i} ____ here.`,
    options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
    answer: 'B',
    explanation: `解析 ${i}`,
    knowledgePoints: kp,
    difficulty: 'medium',
  };
}

test('录入与查询：选项 JSON 往返不丢结构', () => {
  const repo = freshRepo();
  const { id, action } = repo.saveQuestion(mkQuestion(1));
  assert.strictEqual(action, 'created');
  const q = repo.getQuestion(id);
  assert.deepStrictEqual(q.options, { A: 'a1', B: 'b1', C: 'c1', D: 'd1' });
  assert.deepStrictEqual(q.knowledgePoints, ['时态']);
  assert.strictEqual(q.answer, 'B');
  assert.strictEqual(q.state.reps, 0, '新题未复习');
  repo.close();
});

test('查重：同题干再录一次会报 duplicate，交给界面问用户', () => {
  const repo = freshRepo();
  const a = repo.saveQuestion(mkQuestion(1));
  const b = repo.saveQuestion({ ...mkQuestion(1), options: { A: 'x', B: 'y' } });
  assert.strictEqual(b.action, 'duplicate');
  assert.strictEqual(b.id, a.id, '不应重复插入');
  assert.strictEqual(repo.countQuestions().total, 1);

  // 用户选择覆盖
  const c = repo.saveQuestion({ ...mkQuestion(1), options: { A: 'x', B: 'y' }, answer: 'A' }, { onDuplicate: 'overwrite' });
  assert.strictEqual(c.action, 'overwritten');
  assert.strictEqual(repo.getQuestion(a.id).answer, 'A');
  assert.strictEqual(repo.countQuestions().total, 1);
  repo.close();
});

test('今日会话：新题按上限进入，重复调用会续练而不是重开', () => {
  const repo = freshRepo();
  for (let i = 1; i <= 30; i += 1) repo.saveQuestion(mkQuestion(i));
  repo.setSetting('newLimit', 10);

  const first = repo.startDailySession({ now: Date.now() });
  assert.strictEqual(first.resumed, false);
  assert.strictEqual(first.session.total, 10, '新题上限应生效');

  const second = repo.startDailySession({ now: Date.now() });
  assert.strictEqual(second.resumed, true, '同一天再点应续练');
  assert.strictEqual(second.session.id, first.session.id);
  repo.close();
});

test('答案在作答前绝不返回给界面', () => {
  const repo = freshRepo();
  repo.saveQuestion(mkQuestion(1));
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  const detail = repo.sessionDetail(session.id);
  const item = detail.items[0];
  assert.strictEqual(item.picked, null);
  assert.strictEqual(item.correct, null, '未作答时 correct 必须为 null');
  assert.strictEqual(item.answer, null, '未作答时不能下发答案');
  assert.strictEqual(item.explanation, '', '未作答时不能下发解析');
  repo.close();
});

test('作答后立刻能看到对错（供练完统一展示）', () => {
  const repo = freshRepo();
  repo.saveQuestion(mkQuestion(1));
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  const qid = repo.sessionDetail(session.id).items[0].questionId;

  const r = repo.recordAnswer(session.id, qid, 'B');
  assert.strictEqual(r.correct, true);
  const item = repo.sessionDetail(session.id).items[0];
  assert.strictEqual(item.picked, 'B');
  assert.strictEqual(item.correct, true);
  assert.strictEqual(item.answer, 'B');
  repo.close();
});

test('错题重做：答对的题不再出现，错题进入新一轮', () => {
  const repo = freshRepo();
  for (let i = 1; i <= 3; i += 1) repo.saveQuestion(mkQuestion(i));
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  const items = repo.sessionDetail(session.id).items;
  // 第一题答对，第二、三题答错
  repo.recordAnswer(session.id, items[0].questionId, items[0].options ? 'B' : 'B');
  repo.recordAnswer(session.id, items[1].questionId, 'A');
  repo.recordAnswer(session.id, items[2].questionId, 'A');

  const fin = repo.finishSession(session.id);
  assert.strictEqual(fin.total, 3);
  assert.strictEqual(fin.correct, 1);
  assert.ok(Math.abs(fin.accuracy - 1 / 3) < 1e-9);
  assert.strictEqual(fin.wrong.length, 2);
  assert.strictEqual(fin.needsRetry, true);

  const retry = repo.startRetryRound(session.id);
  assert.strictEqual(retry.round, 2);
  assert.strictEqual(retry.items.length, 2, '只有错题进入重做');

  const round2 = repo.sessionDetail(session.id, Date.now(), 2);
  assert.strictEqual(round2.items.length, 2);
  repo.close();
});

test('关键：错题重做后调度只更新一次，绝不重复累计', () => {
  const repo = freshRepo();
  repo.saveQuestion(mkQuestion(1));
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  const qid = repo.sessionDetail(session.id).items[0].questionId;

  // 第一轮答错
  repo.recordAnswer(session.id, qid, 'A');
  repo.finishSession(session.id);
  const afterWrong = repo.getQuestion(qid);
  assert.strictEqual(afterWrong.state.reps, 1, '答错也消耗一次复习机会');
  assert.strictEqual(afterWrong.state.lapses, 1);
  // 答错应排到 1 天后
  assert.ok(Math.abs(afterWrong.state.intervalDays - 1) < 1e-9, `答错后应排 1 天，实际 ${afterWrong.state.intervalDays}`);

  // 重做轮答对
  repo.startRetryRound(session.id);
  repo.recordAnswer(session.id, qid, 'B', { round: 2 });
  repo.finishSession(session.id);
  const afterRetry = repo.getQuestion(qid);

  assert.strictEqual(afterRetry.state.reps, 2, '重做算第二次复习，但只增加一次');
  assert.strictEqual(afterRetry.state.lapses, 1, '错题次数不应因重做而增加');
  assert.ok(afterRetry.state.intervalDays > 1, '最终做对应该排得更远，而不是停在 1 天');
  assert.ok(afterRetry.state.stability > 1, '稳定度应回升');
  repo.close();
});

test('会话正确率与错题知识点汇总', () => {
  const repo = freshRepo();
  repo.saveQuestion(mkQuestion(1, ['时态']));
  repo.saveQuestion(mkQuestion(2, ['时态', '介词']));
  repo.saveQuestion(mkQuestion(3, ['冠词']));
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  const items = repo.sessionDetail(session.id).items;

  repo.recordAnswer(session.id, items[0].questionId, 'B'); // 对
  repo.recordAnswer(session.id, items[1].questionId, 'A'); // 错（时态/介词）
  repo.recordAnswer(session.id, items[2].questionId, 'C'); // 错（冠词）

  const fin = repo.finishSession(session.id);
  const names = fin.knowledgePoints.map((k) => k.name);
  assert.ok(names.includes('时态') && names.includes('介词') && names.includes('冠词'));
  assert.strictEqual(fin.knowledgePoints.length, 3);
  repo.close();
});

test('到期的题优先进入今日队列，未到期的不再打扰', () => {
  const repo = freshRepo();
  const a = repo.saveQuestion(mkQuestion(1));
  const b = repo.saveQuestion(mkQuestion(2));
  const now = Date.now();

  // 手动把 a 设成"未来才到期"，b 设成"已到期"
  repo.raw.prepare('UPDATE questions SET last_review_at=?, due_at=?, interval_days=?, reps=1 WHERE id=?')
    .run(now, now + 10 * DAY, 10, a.id);
  repo.raw.prepare('UPDATE questions SET last_review_at=?, due_at=?, interval_days=?, reps=1 WHERE id=?')
    .run(now - 20 * DAY, now - DAY, 5, b.id);

  const { session } = repo.startDailySession({ now, force: true });
  const ids = repo.sessionDetail(session.id).items.map((i) => i.questionId);
  assert.ok(ids.includes(b.id), '到期的题应进入队列');
  assert.ok(!ids.includes(a.id), '未到期的题不应出现');
  repo.close();
});

test('知识点看板：最弱的排最前', () => {
  const repo = freshRepo();
  const now = Date.now();
  const strong = repo.saveQuestion(mkQuestion(1, ['简单时态']));
  const weak = repo.saveQuestion(mkQuestion(2, ['虚拟语气']));
  // strong：多次答对，稳定度高
  repo.raw.prepare('UPDATE questions SET stability=?, reps=8, lapses=0, streak=8, last_review_at=?, due_at=?, interval_days=? WHERE id=?')
    .run(60, now - DAY, now + 60 * DAY, 60, strong.id);
  // weak：反复答错
  repo.raw.prepare('UPDATE questions SET stability=?, reps=6, lapses=5, streak=0, last_review_at=?, due_at=?, interval_days=? WHERE id=?')
    .run(0.5, now - DAY, now - DAY, 1, weak.id);

  const stats = repo.knowledgeStats(now);
  assert.strictEqual(stats[0].name, '虚拟语气', '最弱的知识点应排最前');
  assert.ok(stats[0].avgMastery < stats[1].avgMastery);
  repo.close();
});

test('错题本按最近答错时间排序', () => {
  const repo = freshRepo();
  const a = repo.saveQuestion(mkQuestion(1));
  const b = repo.saveQuestion(mkQuestion(2));
  const now = Date.now();
  repo.raw.prepare('INSERT INTO attempts(question_id, session_id, round, picked, correct, created_at) VALUES(?,?,?,?,?,?)')
    .run(a.id, null, 1, 'A', 0, now - 5 * DAY);
  repo.raw.prepare('INSERT INTO attempts(question_id, session_id, round, picked, correct, created_at) VALUES(?,?,?,?,?,?)')
    .run(b.id, null, 1, 'A', 0, now - DAY);

  const book = repo.wrongBook();
  assert.strictEqual(book.length, 2);
  assert.strictEqual(book[0].id, b.id, '最近错的排最前');
  assert.strictEqual(book[0].wrongCount, 1);
  repo.close();
});

test('未来复习量预测包含新题', () => {
  const repo = freshRepo();
  for (let i = 1; i <= 5; i += 1) repo.saveQuestion(mkQuestion(i));
  const f = repo.forecast(Date.now(), 7);
  assert.strictEqual(f.length, 7);
  assert.strictEqual(f[0].count, 5, '今天应包含 5 道新题');
  assert.strictEqual(localDay(new Date(f[0].day).getTime()).length, 10, '日期格式 YYYY-MM-DD');
  repo.close();
});

test('归档的题不再进入练习', () => {
  const repo = freshRepo();
  const a = repo.saveQuestion(mkQuestion(1));
  repo.archiveQuestion(a.id, true);
  assert.strictEqual(repo.countQuestions().total, 0);
  const r = repo.startDailySession({ now: Date.now(), force: true });
  assert.strictEqual(r.empty, true, '没有可用题目时应返回 empty 而不是报错');
  repo.close();
});

test('设置读写带类型（数字不会被存成字符串）', () => {
  const repo = freshRepo();
  assert.strictEqual(repo.getSetting('newLimit'), 20, '默认值应生效');
  repo.setSetting('newLimit', 5);
  assert.strictEqual(repo.getSetting('newLimit'), 5);
  repo.setSetting('shuffleOptions', false);
  assert.strictEqual(repo.getSetting('shuffleOptions'), false);
  repo.close();
});
