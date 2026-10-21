'use strict';

/**
 * 收藏 + 今日手选 的行为测试。
 *
 * 用户需求：做题页面能收藏题目，收藏的题在题库里可以勾选作为"今天的练习"；
 * 同一题重复勾选不能在收藏夹里重复出现。
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

function mkQuestion(i) {
  return {
    stem: `Favorite question ${i} ____ here.`,
    options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
    answer: 'B',
    explanation: `解析 ${i}`,
    knowledgePoints: ['测试'],
    difficulty: 'medium',
  };
}

function seed(repo, n) {
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const r = repo.saveQuestion(mkQuestion(i));
    assert.strictEqual(r.action, 'created', '前置条件：题目应是新建的');
    ids.push(r.id);
  }
  return ids;
}

test('收藏：重复收藏同一题不会产生重复记录', () => {
  const repo = freshRepo();
  const [id] = seed(repo, 1);

  assert.deepStrictEqual(repo.setFavorite(id, true), { ok: true, favorite: true });
  // 再收藏一次（模拟用户重复点收藏）
  assert.deepStrictEqual(repo.setFavorite(id, true), { ok: true, favorite: true });

  // listQuestions 直接返回题目数组
  const favs = repo.listQuestions({ favoriteOnly: true });
  assert.strictEqual(Array.isArray(favs), true, 'listQuestions 应返回数组');
  assert.strictEqual(favs.length, 1, '重复收藏不应出现两条');
  assert.strictEqual(favs[0].id, id);
  assert.strictEqual(favs[0].favorite, true);

  // 取消收藏后从收藏列表消失，但题本身还在题库
  repo.setFavorite(id, false);
  assert.strictEqual(repo.listQuestions({ favoriteOnly: true }).length, 0);
  assert.strictEqual(repo.listQuestions({}).length, 1, '取消收藏不应删除题目');
});

test('收藏：收藏不存在的题要明确报错而不是静默成功', () => {
  const repo = freshRepo();
  const r = repo.setFavorite(99999, true);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('今日手选：同一题勾选两次只留一条', () => {
  const repo = freshRepo();
  const [id] = seed(repo, 1);

  repo.pickForToday([id]);
  repo.pickForToday([id]); // 重复勾选

  const t = repo.todayPicks();
  assert.strictEqual(t.total, 1, '同一题反复勾选只能留一条');
  assert.strictEqual(t.items[0].id, id);
});

test('今日手选：开始练习时排在最前面，用完后清空', () => {
  const repo = freshRepo();
  const ids = seed(repo, 4);
  repo.setSetting('newLimit', 10);
  repo.setSetting('maxTotal', 10);

  // 手选第 3、4 题（注意：它们本来也会被正常队列纳入）
  repo.pickForToday([ids[2], ids[3]]);

  const started = repo.startDailySession({});
  assert.ok(started.session, '应该能开始练习');
  const detail = repo.sessionDetail(started.session.id);
  const order = detail.items.map((it) => it.questionId);

  assert.deepStrictEqual(order.slice(0, 2), [ids[2], ids[3]], '手选题必须排在最前面');
  assert.strictEqual(order.length, 4, '不应重复加入已在队列里的手选题');
  assert.strictEqual(new Set(order).size, order.length, '队列里不能有重复题');

  assert.strictEqual(repo.todayPicks().total, 0, '手选题纳入后应被消费清除');
});

test('今日手选：超过 maxTotal 时也优先全部纳入', () => {
  const repo = freshRepo();
  const ids = seed(repo, 5);
  repo.setSetting('newLimit', 10);
  repo.setSetting('maxTotal', 2); // 上限比手选题还少

  repo.pickForToday([ids[2], ids[3], ids[4]]); // 手选 3 道 > maxTotal 2

  const started = repo.startDailySession({});
  assert.ok(started.session);
  const detail = repo.sessionDetail(started.session.id);
  const order = detail.items.map((it) => it.questionId);

  for (const id of [ids[2], ids[3], ids[4]]) {
    assert.ok(order.includes(id), `手选题 ${id} 必须被纳入（即使超过 maxTotal）`);
  }
  assert.ok(order.length >= 3, `手选题全部纳入，实际 ${order.length}`);
});

test('今日手选：取消勾选后不再进入练习', () => {
  const repo = freshRepo();
  const ids = seed(repo, 3);
  repo.setSetting('newLimit', 10);
  repo.setSetting('maxTotal', 10);

  repo.pickForToday([ids[0], ids[1]]);
  assert.strictEqual(repo.todayPicks().total, 2);

  const r = repo.unpickForToday([ids[1]]);
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(repo.todayPicks().total, 1);
  assert.strictEqual(repo.todayPicks().items[0].id, ids[0]);
});

test('今日手选：归档的题不会进入练习，并会被跳过', () => {
  const repo = freshRepo();
  const ids = seed(repo, 3);
  repo.setSetting('newLimit', 10);
  repo.setSetting('maxTotal', 10);

  repo.pickForToday([ids[0], ids[1]]);
  repo.archiveQuestion(ids[0], true); // 归档

  const started = repo.startDailySession({});
  assert.ok(started.session);
  const detail = repo.sessionDetail(started.session.id);
  const order = detail.items.map((it) => it.questionId);
  assert.ok(!order.includes(ids[0]), '归档题不应进入练习');
  assert.ok(order.includes(ids[1]), '未归档的手选题应进入练习');
});
