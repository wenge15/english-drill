'use strict';

/**
 * 复习调度算法（墨墨背单词式遗忘曲线）。
 *
 * 设计取舍：墨墨把"记忆强度"藏在云端的黑盒里，我们做不到也不该做。
 * 这里用一条公开可验证的幂函数遗忘曲线，核心量是 stability（记忆稳定度，单位：天）：
 *
 *     可回忆概率 R(t) = (1 + F * t / S) ^ DECAY
 *
 * 其中 t 为距上次复习的天数，S 为记忆稳定度。当 t 恰好等于"计划间隔"时 R 正好等于目标保持率
 * （默认 0.9），这正是间隔的定义，也是本模块最重要的不变式（见 test/srs.test.js）。
 *
 * 每次复习后按"当时记得多牢"来调整 S：
 *   - 答对：记忆越新鲜（R 越高）→ 涨得越多，因为这次成功本身就是强证据；
 *   - 答错：按遗忘处理，S 大幅回退，但没退到零（有部分记忆残留）。
 *
 * 纯函数、无副作用、不依赖数据库与浏览器，因此可以被完整单测。
 */

const DAY_MS = 86400000;

const DEFAULTS = {
  targetRetention: 0.9, // 目标保持率：到期时还剩 90% 的回忆概率
  initialStability: 3, // 新题首次稳定度（天）：首次答对后排到约 3 天后
  initialDifficulty: 0.3, // 初始难度 0..1
  minStability: 0.5,
  minIntervalDays: 1, // 答错后"明天再见"的间隔，也是稳定度下限的推导依据
  maxStability: 3650, // 上限 10 年，防止溢出
  maxIntervalDays: 365,
  maxLazyBonusDays: 3, // 迟到复习最多额外多排几天
};

// FSRS 的曲线形状：DECAY = -0.5，FACTOR = 19/81
const DECAY = -0.5;
const FACTOR = 19 / 81;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 可回忆概率 R：elapsedDays 天后还记着的概率。 */
function retrievability(stability, elapsedDays) {
  const s = Math.max(stability, DEFAULTS.minStability);
  const t = Math.max(elapsedDays, 0);
  return Math.pow(1 + FACTOR * (t / s), DECAY);
}

/**
 * 由稳定度换算下次复习的**精确**间隔天数。
 *
 * 刻意不做整数取整、不设 1 天下限：这个函数的返回值必须精确满足
 * "在此时刻复习时 R 恰好等于目标保持率"。一旦取整，短稳定度的题就会
 * 系统性提前复习（R 只有 0.68 而不是 0.9），节奏整体偏快。
 * 展示用天数在界面上另外取整（见 describeSchedule）。
 */
function intervalFromStability(stability, targetRetention = DEFAULTS.targetRetention) {
  const r = clamp(targetRetention, 0.5, 0.99);
  const s = Math.max(stability, DEFAULTS.minStability);
  const raw = (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
  return clamp(raw, 0.01, DEFAULTS.maxIntervalDays);
}

/** 新建一条复习状态（新题）。 */
function newState(now = Date.now()) {
  return {
    stability: DEFAULTS.initialStability,
    difficulty: DEFAULTS.initialDifficulty,
    reps: 0,
    lapses: 0, // 累计答错次数
    lastReviewAt: null,
    dueAt: now, // 新题立即可练
    intervalDays: 0,
    streak: 0, // 连续答对
  };
}

/**
 * 复习一次，返回新的复习状态。
 * @param {object} state  当前状态（newState() 或上次返回的对象）
 * @param {boolean} correct 本次是否答对
 * @param {object} opts   { now, targetRetention, elapsedDays }
 */
function review(state, correct, opts = {}) {
  const now = opts.now ?? Date.now();
  const target = opts.targetRetention ?? DEFAULTS.targetRetention;
  const base = state && state.stability ? state : newState(now);

  // 实际间隔：优先用调用方给的 elapsedDays（从 practice 记录算），否则由 lastReviewAt 推
  const elapsedDays = opts.elapsedDays !== undefined
    ? Math.max(opts.elapsedDays, 0)
    : hasReviewed(base)
      ? Math.max((now - base.lastReviewAt) / DAY_MS, 0)
      : 0;

  const r = hasReviewed(base) ? retrievability(base.stability, elapsedDays) : target;

  let stability = base.stability;
  let difficulty = base.difficulty;
  let reps = base.reps + 1;
  let lapses = base.lapses;
  let streak = base.streak;
  const firstEver = !hasReviewed(base) && base.reps === 0;

  if (correct) {
    if (firstEver) {
      // 首次答对：不施增长因子。成长公式是乘法复合的，
      // 若首次就用完整增长因子，1 天后正确的题会直接排到 3.7 天后，对新题过于激进。
      stability = DEFAULTS.initialStability;
    } else {
      // 间隔越久没复习还答对（R 越低），说明记忆越牢，涨得越多。
      // 目标保持率越高（要求记得越牢），同样表现下涨得越保守。
      // 注意这里用的是"复习前"的难度：否则答对会先降低难度，等于变相奖励错题。
      const targetFactor = Math.pow(target, -1.2) * 0.62 + 0.38; // 0.9 -> ~1.02，0.8 -> ~1.11
      const difficultyFactor = 1.35 - 0.5 * clamp(difficulty, 0, 1); // 越难涨得越慢
      const growth = 1 + 1.9 * (1 - r) * difficultyFactor * targetFactor;
      stability = base.stability * growth;
    }
    streak += 1;
  } else {
    // 答错：部分遗忘。稳定性回退但保留残值。
    lapses += 1;
    streak = 0;
    const harsher = clamp((lapses + 1) / (reps + 1.5), 0, 1);
    const keep = 0.3 + 0.25 * (1 - harsher);
    stability = base.stability * keep;
  }

  // 难度按"错题率"重估，而不是按次数累加。
  // 若按次数累加，答对降低难度、答错提高难度会互相抵消，
  // 反而出现"错过一次的题比一路答对的题更容易涨"的反直觉结果。
  // 这里更新的难度供下一次复习使用。
  difficulty = clamp((lapses + 1) / (base.reps + 2.5), 0, 1);

  // 稳定度下限：刻意设为"刚够排满 1 天"的水平，而不是随手定一个常数。
  // 若下限取得过低（如 0.5 天），答错后的题即使重做答对也只能排回 1 天，
  // 与"又错一次"几乎没有区别 —— 复习节奏永远起不来，这是最要紧的用户体感问题。
  const minStabilityForOneDay = DEFAULTS.minIntervalDays / (Math.pow(target, 1 / DECAY) - 1) * FACTOR;
  stability = clamp(stability, Math.max(DEFAULTS.minStability, minStabilityForOneDay), DEFAULTS.maxStability);

  stability = clamp(stability, DEFAULTS.minStability, DEFAULTS.maxStability);

  // 精确排期：到期时刻恰好是 R = 目标保持率 的那一点
  let intervalDays = intervalFromStability(stability, target);
  if (!correct) {
    intervalDays = 1; // 答错明天必须再见面
  } else if (elapsedDays > 0) {
    // 迟到复习的补偿：拖得越久说明记得越牢，下次可以多排一点。
    // 这里只约束"额外多排的天数"（而不是去压制稳定度的增长）：
    // 隔很久还记得本身就是强证据，稳定度理应涨得更多；
    // 但把这份证据直接翻译成几十天的额外间隔会让用户永远见不到这道题，所以要截断。
    const natural = intervalFromStability(stability, target);
    const extra = intervalDays - natural;
    if (extra > DEFAULTS.maxLazyBonusDays) intervalDays = natural + DEFAULTS.maxLazyBonusDays;
  }

  return {
    stability,
    difficulty,
    reps,
    lapses,
    lastReviewAt: now,
    dueAt: now + intervalDays * DAY_MS,
    intervalDays,
    streak,
  };
}

/** 现在的掌握程度：0..1，用于"掌握度看板"。新题 0，长期记得接近 1。 */
function mastery(state, now = Date.now()) {
  if (!hasReviewed(state)) return 0;
  const elapsedDays = Math.max((now - state.lastReviewAt) / DAY_MS, 0);
  const r = retrievability(state.stability, elapsedDays);
  // 稳定度 10 天的题已达到"能稳定记住"的水平，故以 10 天为满分标尺
  const stabilityScore = clamp(state.stability / 10, 0, 1);
  const lapsePenalty = 1 - clamp(state.lapses * 0.15, 0, 0.45);
  return clamp(r * (0.25 + 0.75 * stabilityScore) * lapsePenalty, 0, 1);
}

/** 是否为"已复习过"的状态（时间戳 0 是合法值，不能用真值判断）。 */
function hasReviewed(state) {
  return Boolean(state) && state.lastReviewAt !== null && state.lastReviewAt !== undefined;
}

/** 该状态现在是否到期。 */
function isDue(state, now = Date.now()) {
  if (!hasReviewed(state)) return true; // 新题永远可练
  return state.dueAt <= now;
}

/** 原地 Fisher-Yates 洗牌，返回同一个数组。可注入 rng 以便测试。 */
function shuffleInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 生成今日队列。
 * 顺序设计：先清到期欠账，再上经受住考验的题，最后才是新题。
 *
 * shuffleOrder=true 时在每个优先级组**内部**打乱：
 * 组间优先级必须保留（否则"先清欠账"的语义就废了），但组内顺序每次不同，
 * 这样重复刷同一批题时不会形成"第 3 题选 B"的位置记忆。
 */
function buildDailyQueue(items, opts = {}) {
  const now = opts.now ?? Date.now();
  const newLimit = opts.newLimit ?? 20;
  const maxTotal = opts.maxTotal ?? 200;
  const rng = opts.rng || Math.random;

  const overdue = [];
  const dueToday = [];
  const fresh = [];
  const notDue = [];

  for (const it of items) {
    const st = it.state;
    if (!st || !hasReviewed(st)) {
      fresh.push(it);
      continue;
    }
    if (!isDue(st, now)) {
      notDue.push(it);
      continue;
    }
    // 逾期超过 1 天算欠账，优先清
    if (now - st.dueAt > DAY_MS) overdue.push(it);
    else dueToday.push(it);
  }

  const byUrgency = (a, b) => (a.state?.dueAt ?? 0) - (b.state?.dueAt ?? 0);
  overdue.sort(byUrgency);
  dueToday.sort(byUrgency);

  if (opts.shuffleOrder) {
    shuffleInPlace(overdue, rng);
    shuffleInPlace(dueToday, rng);
    shuffleInPlace(fresh, rng);
  }

  const queue = [...overdue, ...dueToday, ...fresh.slice(0, newLimit)];
  return queue.slice(0, maxTotal);
}

/**
 * 练习会话：把一批题组织成"全练完才报正确率"的模式。
 * 这是用户明确要求的行为——练的过程中绝不揭晓对错。
 */
function startSession(questions, opts = {}) {
  return {
    id: opts.id || `s_${Date.now()}`,
    startedAt: opts.now ?? Date.now(),
    questions: questions.map((q) => ({
      questionId: q.id,
      stem: q.stem,
      options: q.options,
      // 答案只留在客户端内存里，界面上练完之前不渲染
      answer: q.answer,
      explanation: q.explanation || '',
      knowledgePoints: q.knowledgePoints || [],
      picked: null,
      correct: null,
    })),
    phase: 'answering', // answering | reviewing_wrong | done
    round: 1,
    history: [],
  };
}

/** 记录一次作答；返回是否答对（不影响界面展示）。 */
function answer(session, questionId, picked) {
  const item = session.questions.find((q) => q.questionId === questionId && q.picked === null);
  if (!item) return null;
  item.picked = picked;
  item.correct = picked === item.answer;
  return item.correct;
}

/** 结束本轮：算出正确率，并把错题整理成复习轮。 */
function finishRound(session, now = Date.now()) {
  const answered = session.questions.filter((q) => q.picked !== null);
  const correct = answered.filter((q) => q.correct).length;
  const accuracy = answered.length ? correct / answered.length : 0;
  const wrong = session.questions.filter((q) => q.correct === false);

  session.history.push({
    round: session.round,
    at: now,
    total: answered.length,
    correct,
    accuracy,
    wrongQuestionIds: wrong.map((q) => q.questionId),
  });

  return {
    round: session.round,
    total: answered.length,
    correct,
    accuracy,
    wrong,
    knowledgePoints: summarizeKnowledge(wrong),
  };
}

/** 错题重做：每题都要连续答对一次才算过关（墨墨的"复习到会"）。 */
function startReviewRound(session, wrongIds) {
  session.round += 1;
  session.phase = 'reviewing_wrong';
  // 清空作答痕迹进入新一轮
  session.questions.forEach((q) => {
    if (wrongIds.includes(q.questionId) || q.correct === false) {
      q.picked = null;
      q.correct = null;
      q.reviewRound = session.round;
    }
  });
  return session;
}

/** 统计错题涉及的知识点，用于"带我复习"时先讲薄弱点。 */
function summarizeKnowledge(wrongItems) {
  const map = new Map();
  for (const q of wrongItems) {
    for (const kp of q.knowledgePoints || []) {
      map.set(kp, (map.get(kp) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/** 打乱选项顺序（避免总是记"选B"），返回新选项与新的答案字母。 */
function shuffleOptions(options, answer, rng = Math.random) {
  const letters = Object.keys(options);
  const arr = letters.map((l) => ({ letter: l, text: options[l] }));
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const newOptions = {};
  let newAnswer = answer;
  arr.forEach((item, idx) => {
    const letter = letters[idx];
    newOptions[letter] = item.text;
    if (item.letter === answer) newAnswer = letter;
  });
  return { options: newOptions, answer: newAnswer };
}

/** 把复习状态转成人类可读的排期说明，界面上给用户看。 */
function describeSchedule(state, now = Date.now()) {
  // 注意：时间戳 0 是合法值，必须用 null 判断而不是真值判断
  if (!state || state.lastReviewAt === null || state.lastReviewAt === undefined) return '新题，尚未练习';
  const days = Math.max(0, Math.round((state.dueAt - now) / DAY_MS));
  const masteryPct = Math.round(mastery(state, now) * 100);
  const when = days <= 0 ? '现在' : days === 1 ? '明天' : `${days} 天后`;
  return `掌握度 ${masteryPct}%｜下次复习：${when}`;
}

module.exports = {
  DAY_MS,
  DEFAULTS,
  retrievability,
  intervalFromStability,
  newState,
  review,
  mastery,
  isDue,
  hasReviewed,
  shuffleInPlace,
  buildDailyQueue,
  startSession,
  answer,
  finishRound,
  startReviewRound,
  summarizeKnowledge,
  shuffleOptions,
  describeSchedule,
};
