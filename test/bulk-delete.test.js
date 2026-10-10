'use strict';

/**
 * 批量删除的测试。
 *
 * 关键点：
 *  - 归档是**可恢复**的（默认的"删除"方式），题目从列表消失但数据还在
 *  - 彻底删除会**连同作答历史一起删掉**，否则错题本/集训会继续统计到已删的题
 *  - 删除前能预知影响范围（会被牵连多少记录），避免误删
 */

const test = require('node:test');
const assert = require('node:assert');
const { createRepo } = require('../src/core/db.js');

function freshRepo() {
  const repo = createRepo(':memory:');
  repo.setSetting('shuffleOptions', false);
  repo.setSetting('shuffleOrder', false);
  return repo;
}

function addQuestions(repo, n, prefix = 'Del') {
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const r = repo.saveQuestion({
      stem: `${prefix} question ${i} ____ here.`,
      options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
      answer: 'B',
      knowledgePoints: ['测试'],
    });
    assert.strictEqual(r.action, 'created');
    ids.push(r.id);
  }
  return ids;
}

/** 给某道题造作答记录。 */
function addAttempt(repo, questionId, correct = 0, sessionId = null) {
  repo.raw
    .prepare('INSERT INTO attempts(question_id, session_id, round, picked, correct, created_at) VALUES(?,?,?,?,?,?)')
    .run(questionId, sessionId, 1, 'A', correct, Date.now());
}

test('批量归档：选中的题从列表消失，但数据仍在（可恢复）', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 5);
  const r = repo.archiveQuestions([ids[0], ids[1], ids[2]]);
  assert.strictEqual(r.updated, 3);
  assert.strictEqual(repo.countQuestions().total, 2, '列表里只剩 2 道');

  // 恢复其中一道
  repo.archiveQuestions([ids[0]], false);
  assert.strictEqual(repo.countQuestions().total, 3, '恢复后应回到 3 道');

  // 归档列表里能看到被归档的题，说明数据没丢
  const archived = repo.listArchived();
  assert.strictEqual(archived.length, 2, '归档区应有 2 道');
  assert.deepStrictEqual(archived.map((q) => q.id).sort(), [ids[1], ids[2]].sort());
  repo.close();
});

test('批量归档：空数组/非法输入不报错也不误伤', () => {
  const repo = freshRepo();
  addQuestions(repo, 3);
  assert.strictEqual(repo.archiveQuestions([]).updated, 0);
  assert.strictEqual(repo.archiveQuestions(null).updated, 0);
  assert.strictEqual(repo.archiveQuestions(['abc', undefined]).updated, 0);
  assert.strictEqual(repo.countQuestions().total, 3, '不该误删任何题');
  repo.close();
});

test('彻底删除：题目与它的作答历史一起删掉', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 3);
  addAttempt(repo, ids[0], 0, 1);
  addAttempt(repo, ids[0], 0, 1);
  addAttempt(repo, ids[1], 1, 1);

  const impact = repo.deleteImpact([ids[0]]);
  assert.strictEqual(impact.questions, 1);
  assert.strictEqual(impact.attempts, 2, '应预知会删掉 2 条作答记录');
  assert.strictEqual(impact.sessions, 1);

  const r = repo.deleteQuestions([ids[0]]);
  assert.strictEqual(r.deleted, 1);
  assert.strictEqual(r.attemptsDeleted, 2, '作答历史必须一起删除');
  assert.strictEqual(repo.getQuestion(ids[0]), null, '题已删除');
  assert.strictEqual(repo.countQuestions().total, 2);
  // 剩下的题不受影响
  assert.ok(repo.getQuestion(ids[1]), '未选中的题应保留');
  assert.strictEqual(repo.getQuestion(ids[1]).state.reps, 0, '其它题的复习状态不受影响');
  repo.close();
});

test('彻底删除：不会留下"孤儿作答记录"污染错题本', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 2, 'Ghost');
  addAttempt(repo, ids[0], 0, 1);
  addAttempt(repo, ids[1], 0, 1);
  assert.strictEqual(repo.wrongBook().length, 2, '两道都在错题本里');

  repo.deleteQuestions([ids[0]]);
  const book = repo.wrongBook();
  assert.strictEqual(book.length, 1, '删掉的题不该再出现在错题本里');
  assert.strictEqual(book[0].id, ids[1]);
  repo.close();
});

test('彻底删除：集训计划里也不该再出现已删除的错题', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 3, 'SprintDel');
  for (const id of ids) addAttempt(repo, id, 0, 1);
  assert.strictEqual(repo.planSprint({ days: 7 }).totalWrong, 3);

  repo.deleteQuestions([ids[1]]);
  const plan = repo.planSprint({ days: 7 });
  assert.strictEqual(plan.totalWrong, 2, '集训不该再排已删除的题');
  const planned = new Set(plan.plan.flatMap((d) => d.questionIds));
  assert.ok(!planned.has(ids[1]), '已删除的题不该出现在集训计划里');
  assert.ok(planned.has(ids[0]) && planned.has(ids[2]));
  repo.close();
});

test('彻底删除：一起删掉围绕这道题的问答记录（线程消息都要清）', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 2, 'ChatDel');
  const t1 = repo.ensureThread({ questionId: ids[0] });
  repo.addChatMessage(t1.id, 'user', '这道题怎么理解？');
  repo.addChatMessage(t1.id, 'assistant', '这道题考的是……');
  const t2 = repo.ensureThread({ questionId: ids[1] });
  repo.addChatMessage(t2.id, 'user', '另一道题');

  const msgCount = () => repo.raw.prepare('SELECT COUNT(*) c FROM chat_messages').get().c;
  // 通用对话（不绑定题目）不该被误删，先建一条作为对照
  const general = repo.ensureThread({});
  repo.addChatMessage(general.id, 'user', '泛问语法');
  const before = msgCount();
  assert.strictEqual(before, 4, `删除前应有 4 条消息，实际 ${before}`);

  const r = repo.deleteQuestions([ids[0]]);

  // 关键断言：消息必须一起删掉。
  // 踩过的坑：以前只删了 chat_threads，没删 chat_messages，
  // 于是"已删除题目的聊天内容"永久留在库里（没有外键级联），数据库无限增长。
  const after = msgCount();
  assert.strictEqual(after, 2, `删题应连带删掉它的 2 条消息，实际还剩 ${after} 条`);
  assert.strictEqual(r.messagesDeleted, 2, '返回结果里要报告删了几条消息');

  const threads = repo.listThreads();
  // 删掉 ids[0] 后应剩两个线程：ids[1] 的 + 通用对话
  assert.strictEqual(threads.length, 2, `应剩 2 个线程，实际 ${threads.length}`);
  assert.ok(threads.some((t) => t.questionId === ids[1]), '另一道题的对话要保留');
  assert.ok(!threads.some((t) => t.questionId === ids[0]), '被删题的对话要清掉');

  // 通用对话的消息必须完好
  const generalMsgs = repo.listMessages
    ? repo.listMessages(general.id).length
    : repo.raw.prepare('SELECT COUNT(*) c FROM chat_messages WHERE thread_id = ?').get(general.id).c;
  assert.strictEqual(generalMsgs, 1, '不绑定题目的对话消息必须保留');

  repo.deleteQuestions([ids[1]]);
  const after2 = msgCount();
  assert.strictEqual(after2, 1, '删第二道题后只剩通用对话那 1 条');
  const finalThreads = repo.listThreads();
  assert.ok(finalThreads.some((t) => t.id === general.id), '不绑定题目的对话必须保留');
  repo.close();
});

test('彻底删除：库里不该残留任何孤儿聊天消息', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 3, 'Orphan');
  for (const id of ids) {
    const th = repo.ensureThread({ questionId: id });
    repo.addChatMessage(th.id, 'user', `问题 ${id}`);
  }
  repo.deleteQuestions(ids);

  // 孤儿 = 消息所属的线程已经不存在
  const orphans = repo.raw
    .prepare(
      `SELECT COUNT(*) c FROM chat_messages m
       WHERE NOT EXISTS (SELECT 1 FROM chat_threads t WHERE t.id = m.thread_id)`,
    )
    .get().c;
  assert.strictEqual(orphans, 0, `不该有孤儿消息，实际 ${orphans} 条`);
  assert.strictEqual(repo.raw.prepare('SELECT COUNT(*) c FROM chat_messages').get().c, 0);
  repo.close();
});

test('彻底删除：选中多道题一次性删除', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 6);
  const r = repo.deleteQuestions([ids[0], ids[2], ids[4]]);
  assert.strictEqual(r.deleted, 3);
  assert.strictEqual(repo.countQuestions().total, 3);
  assert.deepStrictEqual(repo.listQuestions({}).map((q) => q.id).sort(), [ids[1], ids[3], ids[5]].sort());
  repo.close();
});

test('删除影响预估：没练过的题影响范围为零，避免用户被吓到', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 3, 'Fresh');
  const impact = repo.deleteImpact(ids);
  assert.strictEqual(impact.questions, 3);
  assert.strictEqual(impact.attempts, 0);
  assert.strictEqual(impact.answered, 0, '没练过的题不该报"有作答记录"');
  repo.close();
});

test('删除影响预估：练过的题会报告牵连的作答与场次', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 2, 'Used');
  addAttempt(repo, ids[0], 0, 10);
  addAttempt(repo, ids[0], 1, 11);
  addAttempt(repo, ids[1], 0, 11);
  repo.raw.prepare('UPDATE questions SET reps = 2 WHERE id = ?').run(ids[0]);

  const impact = repo.deleteImpact(ids);
  assert.strictEqual(impact.attempts, 3);
  assert.strictEqual(impact.sessions, 2, '涉及 2 个练习场次');
  assert.strictEqual(impact.answered, 1, '1 道已经练过');
  repo.close();
});

test('空删除请求不报错', () => {
  const repo = freshRepo();
  addQuestions(repo, 2);
  assert.strictEqual(repo.deleteQuestions([]).deleted, 0);
  assert.strictEqual(repo.deleteQuestions(null).deleted, 0);
  assert.strictEqual(repo.countQuestions().total, 2, '不该误删');
  repo.close();
});
