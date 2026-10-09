'use strict';

/**
 * 乱序行为测试（用户的明确要求）：
 *   1. 每次练习的**题目顺序**随机
 *   2. 每次练习的**选项顺序**随机 —— 同一题这次答案是 A，下次可能是 C
 *   3. 但同一轮内选项位置必须稳定（不能同一题问两遍答案不一样）
 *   4. 关掉开关后要真的不乱序（按教材单元刷题时需要）
 *
 * 这类行为只在"多次练习同一题"时才显现，是最容易写了却没生效的地方。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createRepo } = require('../src/core/db.js');
const srs = require('../src/core/srs.js');

function repoWith(count, settings = {}) {
  const repo = createRepo(':memory:');
  for (const [k, v] of Object.entries({ shuffleOptions: true, shuffleOrder: true, ...settings })) {
    repo.setSetting(k, v);
  }
  for (let i = 1; i <= count; i += 1) {
    repo.saveQuestion({
      stem: `Question number ${i} ____ here.`,
      options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
      answer: 'B',
      knowledgePoints: ['测试'],
    });
  }
  return repo;
}

/** 跑一次会话，返回按呈现顺序排列的 [{id, answerLetter, correctText}]。 */
function oneSession(repo, now) {
  const { session } = repo.startDailySession({ now, force: true });
  const detail = repo.sessionDetail(session.id, now);
  return {
    sessionId: session.id,
    items: detail.items.map((it) => ({
      id: it.questionId,
      // 未作答时 answer 被刻意隐藏，这里用选项内容反推正确项的位置：
      // 正确答案文本是固定的 x{i}，所以能算出它在本次呈现里的字母
      letters: Object.keys(it.options),
      answerText: onlyCorrectText(it.options),
    })),
    shuffling: detail.shuffling,
  };
}

/**
 * 从选项里找出"看起来像正确答案文本"的那个字母。
 * 题干答案固定在选项 B 的文本 b{i}，而选项文本本身不参与打乱，
 * 所以只要知道哪个字母带着 b{i}，就知道这次正确答案是哪个字母。
 */
function onlyCorrectText(options) {
  for (const [letter, text] of Object.entries(options)) {
    if (/^b\d+$/.test(text)) return { letter, text };
  }
  return null;
}

test('题目顺序每次练习都不同（组内随机）', () => {
  const repo = repoWith(8);
  const orders = [];
  for (let i = 0; i < 12; i += 1) {
    orders.push(oneSession(repo, Date.now() + i * 1000).items.map((x) => x.id));
  }
  const unique = new Set(orders.map((o) => o.join(',')));
  assert.ok(unique.size > 1, `12 次练习应产生多种顺序，实际只有 ${unique.size} 种：${[...unique].join(' | ')}`);

  // 至少有一次不等于录入顺序（8 道题全排列，顺序相同的概率极低）
  const sorted = [...orders[0]].sort((a, b) => a - b).join(',');
  assert.ok([...unique].some((o) => o !== sorted), '应该出现过与录入顺序不同的排列');
  repo.close();
});

test('选项顺序每次练习都不同：同一题正确答案的字母会变', () => {
  const repo = repoWith(1);
  const seenLetters = new Set();
  for (let i = 0; i < 40; i += 1) {
    const s = oneSession(repo, Date.now() + i * 1000);
    const hit = onlyCorrectText(s.items[0].options || {});
    // oneSession 里没暴露 options，这里直接用会话详情再取一次
    const detail = repo.sessionDetail(s.sessionId, Date.now());
    const found = Object.entries(detail.items[0].options).find(([, t]) => /^b1$/.test(t));
    assert.ok(found, '正确答案文本必须存在于选项中');
    seenLetters.add(found[0]);
  }
  assert.ok(
    seenLetters.size >= 3,
    `同一个正确答案应该在 4 个位置间变化，实际只出现在：${[...seenLetters].join('、')}`,
  );
  repo.close();
});

test('同一轮内选项位置稳定（不会同一题前后矛盾）', () => {
  const repo = repoWith(3);
  for (let i = 0; i < 10; i += 1) {
    const { session } = repo.startDailySession({ now: Date.now() + i * 1000, force: true });
    const first = repo.sessionDetail(session.id).items[0];
    const second = repo.sessionDetail(session.id).items[0];
    assert.deepStrictEqual(first.options, second.options, '同一轮内两次读取的选项顺序必须一致');
    assert.deepStrictEqual(
      Object.entries(first.options).find(([, t]) => /^b\d+$/.test(t)),
      Object.entries(second.options).find(([, t]) => /^b\d+$/.test(t)),
    );
  }
  repo.close();
});

test('错题重做时选项会重新洗牌（同一题重做可能换字母）', () => {
  const repo = repoWith(1);
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  const qid = repo.sessionDetail(session.id).items[0].questionId;

  // 第 1 轮故意答错（选一个不是正确的字母）
  const round1 = repo.sessionDetail(session.id).items[0];
  const right1 = Object.entries(round1.options).find(([, t]) => /^b1$/.test(t))[0];
  const wrong1 = ['A', 'B', 'C', 'D'].find((L) => L !== right1);
  repo.recordAnswer(session.id, qid, wrong1);
  repo.finishSession(session.id);
  repo.startRetryRound(session.id);

  // 重做轮应该能看到这道题，且选项是重新洗过的
  const round2 = repo.sessionDetail(session.id, Date.now(), 2);
  assert.strictEqual(round2.items.length, 1, '错题应进入重做轮');
  const right2 = Object.entries(round2.items[0].options).find(([, t]) => /^b1$/.test(t))[0];

  // 重做轮判对错必须按重做轮自己的答案字母
  repo.recordAnswer(session.id, qid, right2, { round: 2 });
  const after = repo.sessionDetail(session.id, Date.now(), 2).items[0];
  assert.strictEqual(after.correct, true, `按重做轮的正确答案 ${right2} 作答应判对`);
  repo.close();
});

test('选项内容本身不会丢、也不会变', () => {
  const repo = repoWith(4);
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  for (const it of repo.sessionDetail(session.id).items) {
    const texts = Object.values(it.options).sort();
    const nums = texts.map((t) => t.replace(/^[a-d]/, ''));
    assert.ok(nums.every((n) => n === nums[0]), `同一题的四个选项应属于同一题号，实际 ${texts.join(',')}`);
    assert.strictEqual(texts.length, 4, '选项数量不能变');
  }
  repo.close();
});

test('关掉题目乱序后按录入顺序出题', () => {
  const repo = repoWith(6, { shuffleOrder: false, shuffleOptions: false });
  const { session } = repo.startDailySession({ now: Date.now(), force: true });
  const ids = repo.sessionDetail(session.id).items.map((i) => i.questionId);
  // 录入顺序 = id 递增（repoWith 是按 1..6 依次录入的）
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), `应保持录入顺序（最早的在前），实际 ${ids.join(',')}`);

  // 再做一次，确保"关掉乱序"是真的稳定，而不是碰巧
  const again = repo.startDailySession({ now: Date.now() + 1000, force: true });
  const ids2 = repo.sessionDetail(again.session.id).items.map((i) => i.questionId);
  assert.deepStrictEqual(ids2, ids, '关掉乱序后每次都应给出同样的顺序');

  // 选项也应保持原样（正确答案固定在 B）
  const first = repo.sessionDetail(session.id).items[0];
  assert.deepStrictEqual(Object.keys(first.options), ['A', 'B', 'C', 'D']);
  assert.strictEqual(Object.values(first.options)[1], `b${ids[0]}`, '关掉乱序后正确答案应回到 B');
  repo.close();
});

test('关掉题目乱序时顺序稳定（批量导入的题 created_at 常在同一毫秒）', () => {
  // 同一毫秒内连续录入，正是批量导入的真实情况
  const repo = repoWith(8, { shuffleOrder: false, shuffleOptions: false });
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) {
    const { session } = repo.startDailySession({ now: Date.now() + i, force: true });
    seen.add(repo.sessionDetail(session.id).items.map((x) => x.questionId).join(','));
  }
  assert.strictEqual(seen.size, 1, `同一批题在关掉乱序后顺序必须唯一，实际出现 ${seen.size} 种：${[...seen].join(' | ')}`);
  repo.close();
});

test('会话详情会告知界面当前的乱序状态', () => {
  const on = repoWith(2);
  const s1 = on.startDailySession({ now: Date.now(), force: true });
  assert.deepStrictEqual(on.sessionDetail(s1.session.id).shuffling, { options: true, order: true });
  on.close();

  const off = repoWith(2, { shuffleOptions: false, shuffleOrder: false });
  const s2 = off.startDailySession({ now: Date.now(), force: true });
  assert.deepStrictEqual(off.sessionDetail(s2.session.id).shuffling, { options: false, order: false });
  off.close();
});

/* ------------------------------------------------------------------ *
 * 以下两条针对一个真实出现过的自相矛盾：
 * 「你选的是 A，正确答案是 A」却判错。
 * 根因是"判分"和"展示"各自重新推算了一次呈现顺序，两次结果可能不一致。
 * 现在呈现顺序在出题时固化进数据库，这两条测试锁死该行为。
 * ------------------------------------------------------------------ */

test('判分与展示必须一致：不存在"选了 A、答案也是 A，却判错"', () => {
  const repo = repoWith(6);
  let checked = 0;
  for (let round = 0; round < 25; round += 1) {
    const started = repo.startDailySession({ now: Date.now() + round * 1000, force: true });
    if (started.empty || !started.session) {
      repo.raw.prepare('UPDATE questions SET due_at = ? WHERE archived = 0').run(Date.now() - 1000);
      continue;
    }
    const session = started.session;
    for (const it of repo.sessionDetail(session.id).items) {
      // 故意选一个错的（答案文本之外的选项）
      const q = repo.getQuestion(it.questionId);
      const rightText = q.options[q.answer];
      const rightLetter = Object.entries(it.options).find(([, t]) => t === rightText)[0];
      const wrongLetter = ['A', 'B', 'C', 'D'].find((L) => L !== rightLetter);
      repo.recordAnswer(session.id, it.questionId, wrongLetter);

      const after = repo.sessionDetail(session.id).items.find((x) => x.questionId === it.questionId);
      assert.notStrictEqual(after.picked, after.answer, `第${round}轮 题#${it.questionId}：选的和答案相同却被判错`);
      assert.strictEqual(after.correct, false, '选错必须判错');
      assert.strictEqual(after.options[after.answer], rightText, '展示的答案字母必须指向正确选项文本');
      checked += 1;
    }
    repo.finishSession(session.id);
  }
  assert.ok(checked > 50, `应检查足够多的作答，实际 ${checked}`);
  repo.close();
});

test('呈现顺序会固化：进程重启后回看，展示的答案仍与判分一致', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  // 用工作区内的目录（系统临时目录下 sqlite 会报 disk I/O error）
  const dir = path.join(__dirname, '..', 'data', 'test');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(fs.mkdtempSync(path.join(dir, 'persist-')), 'questions.db');

  // 第一次打开：出题 + 答错 + 记录当时的呈现顺序
  const repo1 = createRepo(dbPath);
  repo1.setSetting('shuffleOptions', true);
  repo1.setSetting('shuffleOrder', true);
  for (let i = 1; i <= 4; i += 1) {
    repo1.saveQuestion({
      stem: `Persist check ${i} ____ here.`,
      options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
      answer: 'B',
      knowledgePoints: ['测试'],
    });
  }
  const { session } = repo1.startDailySession({ now: Date.now(), force: true });
  const before = repo1.sessionDetail(session.id).items;
  const snapshot = before.map((it) => ({
    questionId: it.questionId,
    options: it.options,
    rightLetter: Object.entries(it.options).find(([, t]) => /^b\d+$/.test(t))[0],
  }));
  for (const it of before) {
    const right = snapshot.find((s) => s.questionId === it.questionId).rightLetter;
    repo1.recordAnswer(session.id, it.questionId, ['A', 'B', 'C', 'D'].find((L) => L !== right));
  }
  repo1.finishSession(session.id);
  const sessionId = session.id;
  repo1.close();

  // 第二次打开：模拟软件重启后回看这次练习
  const repo2 = createRepo(dbPath);
  const after = repo2.sessionDetail(sessionId).items;
  for (const snap of snapshot) {
    const it = after.find((x) => x.questionId === snap.questionId);
    assert.deepStrictEqual(it.options, snap.options, '重启后选项顺序必须与当时一致');
    assert.strictEqual(it.answer, snap.rightLetter, '重启后展示的答案必须与判分时一致');
    assert.notStrictEqual(it.picked, it.answer, '不能出现"选的和答案相同却判错"');
    assert.strictEqual(it.correct, false);
  }
  repo2.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test('题库里的原始答案不受乱序影响（练习多次后依然是 B）', () => {
  const repo = repoWith(2);
  for (let i = 0; i < 10; i += 1) {
    const { session } = repo.startDailySession({ now: Date.now() + i * 1000, force: true });
    repo.sessionDetail(session.id);
  }
  for (const q of repo.listQuestions({})) {
    assert.strictEqual(q.answer, 'B', `题库里的答案被乱序改动了：${q.stem} -> ${q.answer}`);
    assert.strictEqual(q.options.B, `b${q.id}`, '题库里的选项顺序被改动了');
  }
  repo.close();
});

test('算法层：洗牌保留优先级分组，只在组内随机', () => {
  const now = 10 * srs.DAY_MS;
  const mk = (id, dueOffsetDays) => ({
    id,
    state: dueOffsetDays === null
      ? srs.newState(now)
      : { ...srs.newState(0), lastReviewAt: now - srs.DAY_MS, dueAt: now + dueOffsetDays * srs.DAY_MS, intervalDays: 1 },
  });
  const items = [
    mk('overdueA', -5),
    mk('overdueB', -3),
    mk('dueA', 0),
    mk('dueB', 0),
    mk('newA', null),
    mk('newB', null),
  ];
  const q = srs.buildDailyQueue(items, { now, shuffleOrder: true, newLimit: 10 });
  const ids = q.map((x) => x.id);
  assert.deepStrictEqual(ids.slice(0, 0), []);
  // 前两个必须是逾期组（组内顺序可变），接着是到期组，最后是新题组
  assert.deepStrictEqual([...ids.slice(0, 2)].sort(), ['overdueA', 'overdueB'], `逾期组应排最前：${ids.join(',')}`);
  assert.deepStrictEqual([...ids.slice(2, 4)].sort(), ['dueA', 'dueB'], `到期组应排第二：${ids.join(',')}`);
  assert.deepStrictEqual([...ids.slice(4)].sort(), ['newA', 'newB'], `新题组应排最后：${ids.join(',')}`);
});
