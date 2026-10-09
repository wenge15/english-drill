'use strict';

/**
 * 复习算法测试。这是整个软件最不能出错的部分：
 * 调度一错，用户要么永远在复习同一批题，要么该复习的题再也不出现。
 * 运行： node --test test/   或   node test/srs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const srs = require('../src/core/srs.js');

const DAY = srs.DAY_MS;

test('核心不变式：计划间隔到期时的可回忆概率应恰好等于目标保持率', () => {
  for (const stability of [0.5, 1, 3, 10, 30, 100, 365]) {
    const interval = srs.intervalFromStability(stability, 0.9);
    const r = srs.retrievability(stability, interval);
    assert.ok(
      Math.abs(r - 0.9) < 1e-6,
      `S=${stability} 时计划间隔 ${interval} 天的 R=${r}，应精确等于 0.9`,
    );
  }
});

test('超过间隔上限时宁可提前复习，绝不延后（安全方向）', () => {
  // 稳定度极大时会被 maxIntervalDays 截断，此时 R 高于目标保持率，
  // 即"复习得比最优更早一点" —— 这是安全的方向，但必须是有意的行为而不是意外。
  const interval = srs.intervalFromStability(10000, 0.9);
  assert.strictEqual(interval, srs.DEFAULTS.maxIntervalDays);
  const r = srs.retrievability(10000, interval);
  assert.ok(r > 0.9, `截断后 R 必须高于目标保持率（提前复习），实际 ${r}`);
});

test('可回忆概率随时间单调下降', () => {
  let prev = 1.1;
  for (const t of [0, 0.5, 1, 2, 5, 10, 30, 90]) {
    const r = srs.retrievability(5, t);
    assert.ok(r < prev, `t=${t} 时 R 应小于上一时刻`);
    assert.ok(r > 0 && r <= 1);
    prev = r;
  }
});

test('连续答对时间隔单调拉长，且始终落在上限内', () => {
  let st = srs.newState(0);
  let now = 0;
  const intervals = [];
  for (let i = 0; i < 8; i += 1) {
    const planned = st.intervalDays || 1; // 新题无计划间隔，首次按 1 天推进
    now += planned * DAY;
    // 从第二次起才谈得上"在保持率附近到期"；新题的首次复习没有此约束
    if (i > 0) {
      const r = srs.retrievability(st.stability, planned);
      assert.ok(Math.abs(r - 0.9) < 1e-6, `第 ${i + 1} 次复习时应在保持率处到期，实际 R=${r}`);
    }
    st = srs.review(st, true, { now });
    intervals.push(st.intervalDays);
    assert.ok(st.intervalDays >= 1 && st.intervalDays <= srs.DEFAULTS.maxIntervalDays);
  }
  for (let i = 1; i < intervals.length; i += 1) {
    assert.ok(intervals[i] >= intervals[i - 1], `间隔应不减：${intervals.map((x) => x.toFixed(1)).join(' -> ')}`);
  }
  assert.ok(intervals[intervals.length - 1] > intervals[0], `间隔应显著拉长：${intervals.map((x) => x.toFixed(1)).join(' -> ')}`);
  // 首次答对后排到基准间隔（initialStability 天），不该更远，也不该立刻又见面
  assert.ok(
    intervals[0] >= 1 && intervals[0] <= srs.DEFAULTS.initialStability,
    `第一次答对后应排在 1~${srs.DEFAULTS.initialStability} 天之间，实际 ${intervals[0].toFixed(2)} 天`,
  );
  // 而且第二次间隔必须显著长于第一次，否则说明成长因子没生效
  assert.ok(intervals[1] > intervals[0] * 1.2, `第二次间隔应明显变长：${intervals.slice(0, 3).map((x) => x.toFixed(1)).join(' -> ')}`);
});

test('答错：间隔回退到 1 天，稳定度大幅下降但保留残值', () => {
  let st = srs.newState(0);
  let now = 0;
  for (let i = 0; i < 4; i += 1) {
    now += (st.intervalDays || 1) * DAY;
    st = srs.review(st, true, { now });
  }
  const strongStability = st.stability;
  assert.ok(strongStability > 4, `4 次答对后稳定度应明显增长，实际 ${strongStability.toFixed(2)}`);

  const after = srs.review(st, false, { now: now + st.intervalDays * DAY });
  assert.strictEqual(after.intervalDays, 1, '答错必须明天再见');
  assert.ok(after.stability < strongStability, '答错后稳定度必须下降');
  assert.ok(after.stability >= srs.DEFAULTS.minStability, '不应把记忆打到零（残留部分记忆）');
  assert.strictEqual(after.lapses, 1);
  assert.strictEqual(after.streak, 0, '答错清零连对');
  assert.ok(after.difficulty > st.difficulty, '答错应提升难度评估');
});

test('同一题答错后稳定度涨得比答对慢（难度反馈生效）', () => {
  const base = srs.newState(0);
  let a = srs.review(base, true, { now: 1 * DAY });
  let b = srs.review(base, false, { now: 1 * DAY });
  b = srs.review(b, true, { now: 5 * DAY }); // 错一次后再答对
  assert.ok(a.stability > b.stability, `一路答对(${a.stability.toFixed(2)}) 应比错过一次(${b.stability.toFixed(2)}) 更牢`);
});

test('逾期复习：稳定度涨得更多是合理的，但额外间隔必须截断', () => {
  const st = srs.review(srs.newState(0), true, { now: DAY });
  const onTime = srs.review(st, true, { now: DAY + st.intervalDays * DAY });
  const late = srs.review(st, true, { now: DAY + (st.intervalDays + 30) * DAY });

  // 方向正确：隔了 30 天还记得，稳定度应该涨得更多
  assert.ok(late.stability > onTime.stability, '迟到复习的稳定度增长应更多');
  assert.ok(late.intervalDays >= onTime.intervalDays, '迟到复习不该缩短下次间隔');

  // 但额外多排的天数必须被截断，否则这道题会长期见不到
  const naturalOnTime = srs.intervalFromStability(onTime.stability, 0.9);
  assert.ok(
    late.intervalDays - naturalOnTime <= srs.DEFAULTS.maxLazyBonusDays + 1e-9,
    `额外间隔应截断在 ${srs.DEFAULTS.maxLazyBonusDays} 天内，实际多排 ${(late.intervalDays - naturalOnTime).toFixed(2)} 天`,
  );
  const veryLate = srs.review(st, true, { now: DAY + 400 * DAY });
  assert.ok(veryLate.intervalDays <= srs.DEFAULTS.maxIntervalDays);
});

test('掌握度：新题为 0，长期记得接近 1，答错会掉', () => {
  assert.strictEqual(srs.mastery(srs.newState(0), 0), 0);
  let st = srs.newState(0);
  let now = 0;
  for (let i = 0; i < 6; i += 1) {
    now += (st.intervalDays || 1) * DAY;
    st = srs.review(st, true, { now });
  }
  const m = srs.mastery(st, now + st.intervalDays * DAY);
  assert.ok(m > 0.6, `6 次答对后掌握度应较高，实际 ${m.toFixed(3)}`);
  const dropped = srs.review(st, false, { now: now + st.intervalDays * DAY });
  assert.ok(srs.mastery(dropped, dropped.lastReviewAt) < m, '答错后掌握度应下降');
});

test('到期判定', () => {
  const st = srs.review(srs.newState(0), true, { now: DAY });
  assert.strictEqual(srs.isDue(st, DAY), false, '刚复习完不应立即到期');
  assert.strictEqual(srs.isDue(st, DAY + st.intervalDays * DAY), true, '到点应到期');
  assert.strictEqual(srs.isDue(null, 0), true, '新题永远可练');
});

test('今日队列：先清逾期欠账，再上到期的，最后才是新题', () => {
  const now = 10 * DAY;
  const items = [
    { id: 'new1' },
    { id: 'new2' },
    { id: 'due1', state: { ...srs.newState(0), lastReviewAt: now - DAY, dueAt: now - 1000, intervalDays: 1 } },
    { id: 'overdue1', state: { ...srs.newState(0), lastReviewAt: now - 20 * DAY, dueAt: now - 10 * DAY, intervalDays: 10 } },
    { id: 'future1', state: { ...srs.newState(0), lastReviewAt: now, dueAt: now + 5 * DAY, intervalDays: 5 } },
  ];
  const q = srs.buildDailyQueue(items, { now, newLimit: 20 });
  const ids = q.map((x) => x.id);
  assert.deepStrictEqual(ids, ['overdue1', 'due1', 'new1', 'new2'], `队列顺序错误: ${ids.join(',')}`);
  assert.ok(!ids.includes('future1'), '未到期的旧题不应出现在今日队列');
});

test('今日队列：新题上限生效，避免一天塞几百道', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}` }));
  const q = srs.buildDailyQueue(items, { now: 0, newLimit: 20 });
  assert.strictEqual(q.length, 20);
  assert.strictEqual(q[0].id, 'n0', '新题应按录入顺序给');
});

test('练习会话：答题过程中绝不泄露答案，练完才给正确率', () => {
  const questions = [
    { id: 1, stem: 'q1', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'B', knowledgePoints: ['时态'] },
    { id: 2, stem: 'q2', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'C', knowledgePoints: ['时态', '介词'] },
    { id: 3, stem: 'q3', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, answer: 'A', knowledgePoints: ['冠词'] },
  ];
  const s = srs.startSession(questions, { now: 0 });
  assert.strictEqual(s.phase, 'answering');

  srs.answer(s, 1, 'B');
  srs.answer(s, 2, 'A');
  const partial = srs.finishRound(s, 100);
  assert.strictEqual(partial.total, 2, '只统计已作答的题');
  assert.strictEqual(partial.correct, 1);
  assert.ok(Math.abs(partial.accuracy - 0.5) < 1e-9);
  assert.strictEqual(partial.wrong.length, 1);
  assert.strictEqual(partial.wrong[0].questionId, 2);
  assert.deepStrictEqual(partial.knowledgePoints[0], { name: '时态', count: 1 });
  assert.ok(
    partial.knowledgePoints.some((k) => k.name === '介词'),
    '错题涉及的知识点都该被统计出来',
  );
});

test('错题重做：只把错题重新排入，答对过的题不再出现', () => {
  const questions = [
    { id: 1, stem: 'q1', options: {}, answer: 'B' },
    { id: 2, stem: 'q2', options: {}, answer: 'C' },
  ];
  const s = srs.startSession(questions, { now: 0 });
  srs.answer(s, 1, 'B');
  srs.answer(s, 2, 'A');
  const r1 = srs.finishRound(s, 1);
  srs.startReviewRound(s, r1.wrong.map((w) => w.questionId));

  assert.strictEqual(s.round, 2);
  assert.strictEqual(s.phase, 'reviewing_wrong');
  const q1 = s.questions.find((q) => q.questionId === 1);
  const q2 = s.questions.find((q) => q.questionId === 2);
  assert.strictEqual(q1.picked, 'B', '答对的题应保留原作答，不重复练');
  assert.strictEqual(q2.picked, null, '错题应被清空以便重做');
});

test('选项打乱：内容不丢、答案跟着走', () => {
  const options = { A: 'apple', B: 'banana', C: 'cat', D: 'dog' };
  for (let seed = 0; seed < 50; seed += 1) {
    const rng = () => ((seed * 9301 + 49297) % 233280) / 233280;
    const out = srs.shuffleOptions(options, 'C', rng);
    assert.deepStrictEqual(Object.values(out.options).sort(), Object.values(options).sort(), '选项内容不能丢');
    assert.strictEqual(out.options[out.answer], 'cat', '答案字母必须指向原正确选项');
  }
});

test('排期说明对人类可读', () => {
  const st = srs.review(srs.newState(0), true, { now: 0 });
  const text = srs.describeSchedule(st, 0);
  assert.match(text, /掌握度 \d+%/);
  assert.match(text, /下次复习/);
  assert.strictEqual(srs.describeSchedule(null, 0), '新题，尚未练习');
});
