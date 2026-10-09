'use strict';

/**
 * 分组与考前集训的测试。
 *
 * 集训的核心要求："把我所有错过的题目在一个星期内给我复习一遍" ——
 * 所以最关键的两条是：
 *   1. 一道错题都不能漏（覆盖数必须等于错题总数）
 *   2. 必须落在指定天数内（默认 7 天）
 */

const test = require('node:test');
const assert = require('node:assert');
const { createRepo } = require('../src/core/db.js');
const srs = require('../src/core/srs.js');

function freshRepo() {
  const repo = createRepo(':memory:');
  repo.setSetting('shuffleOptions', false);
  repo.setSetting('shuffleOrder', false);
  return repo;
}

/** 造题。prefix 必须区分开，否则会被查重逻辑判为重复题（详见下面那条测试）。 */
function addQuestions(repo, n, groupName, prefix = 'Group test') {
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const r = repo.saveQuestion({
      stem: `${prefix} question ${i} ____ here.`,
      options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
      answer: 'B',
      knowledgePoints: [i % 2 === 0 ? '时态' : '介词'],
      groupName,
    });
    // 断言真的新建了：否则重复题会返回旧 id，把测试悄悄带偏（实测踩过）
    assert.strictEqual(r.action, 'created', `第 ${i} 道题应被新建，实际 ${r.action}`);
    ids.push(r.id);
  }
  return ids;
}

/* ---------------- 分组 ---------------- */

test('分组：按名字创建，同名复用', () => {
  const repo = freshRepo();
  const a = repo.saveQuestion({ stem: 'Q1 ____ here.', options: { A: 'a', B: 'b' }, answer: 'B', groupName: '第一单元' });
  const b = repo.saveQuestion({ stem: 'Q2 ____ here.', options: { A: 'a', B: 'b' }, answer: 'B', groupName: '第一单元' });
  assert.strictEqual(a.groupId, b.groupId, '同名分组应复用同一个 id');
  const { groups } = repo.listGroups();
  assert.strictEqual(groups.length, 1, '只应创建一个分组');
  assert.strictEqual(groups[0].name, '第一单元');
  assert.strictEqual(groups[0].total, 2);
  repo.close();
});

test('分组：新增、重命名、改名冲突要拦住', () => {
  const repo = freshRepo();
  assert.strictEqual(repo.createGroup({ name: '单元A' }).ok, true);
  assert.strictEqual(repo.createGroup({ name: '单元B' }).ok, true);
  // 同名再建应失败并告知
  const dup = repo.createGroup({ name: '单元A' });
  assert.strictEqual(dup.ok, false);
  assert.ok(dup.error.includes('已存在'));

  const g = repo.listGroups().groups.find((x) => x.name === '单元A');
  assert.strictEqual(repo.renameGroup(g.id, '第一单元').ok, true);
  // 改成已存在的名字要拦住
  const other = repo.listGroups().groups.find((x) => x.name === '单元B');
  assert.strictEqual(repo.renameGroup(g.id, '单元B').ok, false);
  assert.strictEqual(repo.listGroups().groups.find((x) => x.id === g.id).name, '第一单元');
  void other;
  repo.close();
});

test('分组：删除分组不会删题，题目变为未分组', () => {
  const repo = freshRepo();
  addQuestions(repo, 3, '待删单元');
  const g = repo.listGroups().groups[0];
  const r = repo.deleteGroup(g.id);
  assert.strictEqual(r.ungrouped, 3, '应报告被移出分组的题数');
  assert.strictEqual(repo.countQuestions().total, 3, '题目数量不变');
  assert.strictEqual(repo.listGroups().groups.length, 0);
  assert.strictEqual(repo.listGroups().ungrouped, 3, '应统计未分组题数');
  repo.close();
});

test('分组：批量把题目归入/移出分组', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 4);
  const created = repo.createGroup({ name: '第二单元' });
  const r = repo.assignQuestionsToGroup(ids, created.id);
  assert.strictEqual(r.updated, 4);
  assert.strictEqual(repo.listGroups().groups[0].total, 4);

  // 移出分组
  repo.assignQuestionsToGroup(ids, null);
  assert.strictEqual(repo.listGroups().groups[0].total, 0);
  assert.strictEqual(repo.listGroups().ungrouped, 4);
  repo.close();
});

test('分组：归入不存在的分组要报错而不是静默失败', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 2);
  const r = repo.assignQuestionsToGroup(ids, 99999);
  assert.ok(r.error, '应返回错误');
  assert.strictEqual(r.updated, 0);
  repo.close();
});

test('分组统计：给出题量、已学、待复习、掌握度与高频考点', () => {
  const repo = freshRepo();
  addQuestions(repo, 6, '第三单元');
  const g = repo.listGroups().groups[0];
  assert.strictEqual(g.total, 6);
  assert.strictEqual(g.learned, 0, '还没练过');
  assert.strictEqual(g.unlearned, 6);
  assert.strictEqual(g.due, 6, '新题都待复习');
  assert.strictEqual(g.avgMastery, 0, '新题掌握度为 0');
  assert.ok(g.topKnowledge.length >= 2, '应给出该单元的高频考点');
  assert.ok(g.topKnowledge.some((k) => k.name === '时态'));
  repo.close();
});

test('分组统计：练过之后已学与掌握度会变化', () => {
  const repo = freshRepo();
  addQuestions(repo, 4, '第四单元');
  const g0 = repo.listGroups().groups[0];
  // 手动把该组题目设成"学过且稳定"
  repo.raw.prepare('UPDATE questions SET reps=3, streak=3, stability=20, last_review_at=?, due_at=? WHERE group_id=?')
    .run(Date.now() - 1000, Date.now() + 10 * 86400000, g0.id);
  const g1 = repo.listGroups().groups[0];
  assert.strictEqual(g1.learned, 4);
  assert.ok(g1.avgMastery > 0.5, `掌握度应上升，实际 ${g1.avgMastery}`);
  assert.strictEqual(g1.due, 0, '已排到未来，不该算待复习');
  repo.close();
});

/* ---------------- 考前集训 ---------------- */

/** 造一批"错过的题"：每道题都答错一次，然后结算。 */
function makeWrongQuestions(repo, n, prefix = 'Wrong') {
  const ids = addQuestions(repo, n, undefined, prefix);
  for (const id of ids) {
    const q = repo.getQuestion(id);
    // 选一个错的字母
    const wrong = ['A', 'B', 'C', 'D'].find((L) => L !== q.answer);
    repo.raw.prepare('INSERT INTO attempts(question_id, session_id, round, picked, correct, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, null, 1, wrong, 0, Date.now() - 1000);
  }
  return ids;
}

test('查重防护：同题干的题会被判为重复，不会重复入库', () => {
  // 这条是给我自己的保险：测试 helper 若用同样的题干造两批题，
  // 第二批会全部变成 duplicate 并返回旧 id，"新题"其实并不存在（真实踩过一次）。
  const repo = freshRepo();
  const first = repo.saveQuestion({ stem: 'Same ____ stem.', options: { A: 'a', B: 'b' }, answer: 'A' });
  assert.strictEqual(first.action, 'created');
  const again = repo.saveQuestion({ stem: 'Same ____ stem.', options: { A: 'a', B: 'b' }, answer: 'A' });
  assert.strictEqual(again.action, 'duplicate', '同题干应判为重复');
  assert.strictEqual(again.id, first.id, '重复题返回的是已存在的 id');
  assert.strictEqual(repo.countQuestions().total, 1, '题库里仍只有一道');
  repo.close();
});

test('集训计划：只针对错过的题，不含没做过的新题', () => {
  const repo = freshRepo();
  makeWrongQuestions(repo, 5);
  addQuestions(repo, 3); // 这 3 道没做过，不属于错题
  const plan = repo.planSprint({ days: 7 });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.totalWrong, 5, `只该统计错过的 5 道，实际 ${plan.totalWrong}`);
  assert.strictEqual(plan.covered, 5, '错题必须全部被排进去');
  repo.close();
});

test('集训计划：一周内排完，且一道错题都不漏', () => {
  const repo = freshRepo();
  const ids = makeWrongQuestions(repo, 30);
  const plan = repo.planSprint({ days: 7 });
  assert.ok(plan.plan.length <= 7, `不该超过 7 天，实际 ${plan.plan.length} 天`);
  assert.strictEqual(plan.covered, 30, `30 道错题必须全部覆盖，实际 ${plan.covered}`);

  // 收集所有被排进去的题 id，核对与错题集合完全一致
  const planned = new Set(plan.plan.flatMap((d) => d.questionIds));
  assert.strictEqual(planned.size, ids.length, '不该有重复排期');
  for (const id of ids) assert.ok(planned.has(id), `错题 #${id} 漏了`);
  repo.close();
});

test('集训计划：题少时集中在头几天，不硬凑满 7 天', () => {
  const repo = freshRepo();
  makeWrongQuestions(repo, 3);
  const plan = repo.planSprint({ days: 7 });
  assert.strictEqual(plan.totalWrong, 3);
  assert.strictEqual(plan.perDay, 1, '3 道题分 7 天 → 每天 1 道');
  assert.strictEqual(plan.plan.length, 3, '只有 3 天有题');
  repo.close();
});

test('集训计划：错得多的题排在前面（优先复习）', () => {
  const repo = freshRepo();
  const ids = addQuestions(repo, 3);
  // 第 1 道错 3 次，第 2 道错 1 次，第 3 道错 2 次
  const wrongCounts = [3, 1, 2];
  ids.forEach((id, i) => {
    for (let k = 0; k < wrongCounts[i]; k += 1) {
      repo.raw.prepare('INSERT INTO attempts(question_id, session_id, round, picked, correct, created_at) VALUES(?,?,?,?,?,?)')
        .run(id, null, 1, 'A', 0, Date.now() - (10 - k) * 1000);
    }
  });
  const plan = repo.planSprint({ days: 3, perDayCap: 1 });
  const order = plan.plan.flatMap((d) => d.questionIds);
  assert.strictEqual(order[0], ids[0], '错 3 次的应排第一');
  assert.strictEqual(order[1], ids[2], '错 2 次的排第二');
  assert.strictEqual(order[2], ids[1], '错 1 次的排最后');
  repo.close();
});

test('集训计划：错题超过「天数 × 每天上限」时均摊，不挤爆最后一天', () => {
  const repo = freshRepo();
  makeWrongQuestions(repo, 25);
  const plan = repo.planSprint({ days: 7, perDayCap: 3 });
  assert.strictEqual(plan.covered, 25, '仍然一道都不能漏');
  assert.strictEqual(plan.perDayCounts.length, 7, '7 天都该有题');
  // 25 题装不进 7 × 3 = 21，只能超上限；但必须摊平：每天 3~4 道，最多相差 1
  const max = Math.max(...plan.perDayCounts);
  const min = Math.min(...plan.perDayCounts);
  assert.strictEqual(max, 4, `应均摊为每天 4 道（ceil(25/7)），实际最大 ${max}`);
  assert.ok(max - min <= 1, `每天题量应尽量均匀，实际 ${plan.perDayCounts.join('/')}`);
  const last = plan.plan[plan.plan.length - 1];
  assert.ok(last.count <= max, `最后一天不该被挤爆，实际 ${last.count} 道`);
  repo.close();
});

test('没有错题时给出人话提示，而不是空计划', () => {
  const repo = freshRepo();
  addQuestions(repo, 3);
  const plan = repo.planSprint({ days: 7 });
  assert.strictEqual(plan.empty, true);
  assert.ok(plan.message.includes('还没有错过的题目'));
  repo.close();
});

test('应用集训：错题的到期时间被改到计划的那一天', () => {
  const repo = freshRepo();
  makeWrongQuestions(repo, 6);
  const plan = repo.planSprint({ days: 3, perDayCap: 2 });
  const applied = repo.applySprint(plan.plan);
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(applied.moved, 6);

  // 第 1 天的题应该"今天到期"，能在今日队列里排出来
  const day1 = plan.plan[0];
  const counts = repo.countQuestions(Date.now());
  assert.ok(counts.due >= day1.count, `今日队列应包含第 1 天的 ${day1.count} 道，实际待复习 ${counts.due}`);

  // 第 3 天的题应该还没到期
  const day3 = plan.plan[plan.plan.length - 1];
  const q3 = repo.getQuestion(day3.questionIds[0]);
  assert.ok(q3.state.dueAt > Date.now(), '最后一天的题不该今天就到期');
  repo.close();
});

test('集训进度：区分 待复习 / 已排期 / 已攻克', () => {
  const repo = freshRepo();
  const ids = makeWrongQuestions(repo, 4);
  // 前两道排到未来
  repo.raw.prepare('UPDATE questions SET due_at = ? WHERE id IN (?,?)')
    .run(Date.now() + 3 * 86400000, ids[0], ids[1]);
  // 第 3 道连续答对两次 → 已攻克
  repo.raw.prepare('UPDATE questions SET reps=3, streak=2, stability=15, last_review_at=?, due_at=? WHERE id=?')
    .run(Date.now() - 1000, Date.now() + 8 * 86400000, ids[2]);

  const s = repo.sprintStatus();
  assert.strictEqual(s.totalWrong, 4);
  assert.strictEqual(s.scheduled, 3, '三道排到了未来');
  assert.strictEqual(s.dueNow, 1, '一道该复习了');
  assert.strictEqual(s.conquered, 1, '连续答对的那道算已攻克');
  repo.close();
});

test('集训：应用计划后会记录"上次集训"，便于界面提示', () => {
  const repo = freshRepo();
  makeWrongQuestions(repo, 4);
  assert.strictEqual(repo.lastSprint(), null, '初始没有记录');
  const plan = repo.planSprint({ days: 2, perDayCap: 2 });
  repo.applySprint(plan.plan);
  const last = repo.lastSprint();
  assert.ok(last, '应记录上次集训');
  assert.strictEqual(last.moved, 4);
  assert.ok(!Number.isNaN(Number(last.appliedAt)));
  repo.close();
});

test('老库迁移：没有 group_id 列的旧数据库也能正常打开', () => {
  // 这条是补上的一次真实事故：我曾把 group_id 的索引写进建表 SQL，
  // 而 "CREATE TABLE IF NOT EXISTS" 不会给**已存在**的表补列，
  // 于是老库启动时直接报 "no such column: group_id"，服务起不来。
  // 所有测试当时都用全新的内存库，所以完全没拦住。
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { DatabaseSync } = require('node:sqlite');

  // 用工作区内目录（系统临时目录下 sqlite 会报 disk I/O error）
  const root = path.join(__dirname, '..', 'data', 'test');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'migrate-'));
  const dbPath = path.join(dir, 'old.db');

  // 手工造一个"老版本"的表结构：questions 没有 group_id，也没有 groups 表
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, stem TEXT NOT NULL, stem_hash TEXT NOT NULL,
    options TEXT NOT NULL, answer TEXT NOT NULL, explanation TEXT DEFAULT '',
    knowledge_points TEXT DEFAULT '[]', difficulty TEXT DEFAULT 'medium', source_note TEXT DEFAULT '',
    image_path TEXT DEFAULT '', answer_in_source INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER DEFAULT 0,
    stability REAL DEFAULT 3, difficulty_score REAL DEFAULT 0.3, reps INTEGER DEFAULT 0,
    lapses INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, last_review_at INTEGER,
    due_at INTEGER, interval_days INTEGER DEFAULT 0)`);
  old.prepare(`INSERT INTO questions(stem, stem_hash, options, answer, created_at, updated_at)
    VALUES(?,?,?,?,?,?)`).run('旧题目 ____ here.', 'old-hash', '{"A":"a","B":"b"}', 'A', Date.now(), Date.now());
  old.close();

  // 现在用新版打开它：不该崩，且应自动补上 group_id
  const repo = createRepo(dbPath);
  const q = repo.listQuestions({})[0];
  assert.ok(q, '老库里的题目应该还在');
  assert.strictEqual(q.groupId, null, '新列默认应为 null（未分组）');

  // 新列可用：能创建分组并归类
  const g = repo.createGroup({ name: '迁移后的分组' });
  assert.strictEqual(g.ok, true, '迁移后应能正常创建分组');
  repo.assignQuestionsToGroup([q.id], g.id);
  assert.strictEqual(repo.listGroups().groups[0].total, 1, '迁移后应能正常归类题目');

  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('集训不会把非错题也拉进来', () => {
  const repo = freshRepo();
  // 注意：清掉可能由其它 helper 留下的作答记录，否则集训会把它们一并捡进来，
  // 让"非错题不该被改动"这条断言失去意义（实测踩过这种测试内串扰）。
  repo.raw.prepare('DELETE FROM attempts').run();

  const wrongIds = makeWrongQuestions(repo, 3, 'Sprint wrong');
  const cleanIds = addQuestions(repo, 4, undefined, 'Sprint clean'); // 没做过
  assert.strictEqual(repo.planSprint({ days: 7 }).totalWrong, 3, '本次只应有 3 道错题');
  // 把干净题排到很久以后，确认集训不改它们
  repo.raw.prepare(`UPDATE questions SET due_at = ? WHERE id IN (${cleanIds.map(() => '?').join(',')})`)
    .run(Date.now() + 100 * 86400000, ...cleanIds);

  const plan = repo.planSprint({ days: 7 });
  repo.applySprint(plan.plan);

  for (const id of cleanIds) {
    const q = repo.getQuestion(id);
    assert.ok(q.state.dueAt > Date.now() + 90 * 86400000, `非错题 #${id} 的到期时间不该被集训改动`);
  }
  for (const id of wrongIds) {
    const q = repo.getQuestion(id);
    assert.ok(q.state.dueAt <= Date.now() + 7 * 86400000, `错题 #${id} 应被排进一周内`);
  }
  repo.close();
});
