'use strict';

/**
 * 数据层：node:sqlite（Node 22+ 内置，无需编译原生模块、无需下载二进制）。
 *
 * 设计要点：
 * 1. 复习状态（stability/dueAt）直接内嵌在 questions 行上 —— 与题目一对一，不必多一张表。
 * 2. 会话落库：中途关软件、第二天继续，进度不丢。
 * 3. 时间统一存毫秒时间戳（整数），避免时区解释分歧。
 * 4. "今天"用本地日历日，不是 24 小时窗口 —— 用户理解的"今天"是日历上的今天。
 * 5. 一道题在一轮会话里可能被做多次（错题重做）。调度只在会话结束时按
 *    "最终是否做对" 更新一次，绝不能按每次作答更新，否则间隔会被重复计算。
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const srs = require('./srs.js');
const { stemFingerprint } = require('./extract.js');

const DEFAULT_SETTINGS = {
  newLimit: 20,
  maxTotal: 200,
  targetRetention: 0.9,
  shuffleOptions: true,
  shuffleOrder: true, // 题目顺序也每次打乱（组内随机，组间优先级不变）
};

const SCHEMA = `
-- 分组：按单元/章节归拢题目，便于了解各单元掌握情况
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  note TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stem TEXT NOT NULL,
  stem_hash TEXT NOT NULL,
  options TEXT NOT NULL,
  answer TEXT NOT NULL,
  explanation TEXT DEFAULT '',
  knowledge_points TEXT DEFAULT '[]',
  difficulty TEXT DEFAULT 'medium',
  source_note TEXT DEFAULT '',
  image_path TEXT DEFAULT '',
  answer_in_source INTEGER DEFAULT 0,
  group_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER DEFAULT 0,
  stability REAL DEFAULT 0.4,
  difficulty_score REAL DEFAULT 0.3,
  reps INTEGER DEFAULT 0,
  lapses INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_review_at INTEGER,
  due_at INTEGER,
  interval_days INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_q_due ON questions(due_at);
CREATE INDEX IF NOT EXISTS idx_q_hash ON questions(stem_hash);
CREATE INDEX IF NOT EXISTS idx_q_archived ON questions(archived);
-- 注意：group_id 的索引不在这里建。
-- 老库的 questions 表没有 group_id 列（CREATE TABLE IF NOT EXISTS 不会改动已存在的表），
-- 在这里建索引会直接报 "no such column: group_id" 让服务起不来。
-- 正确做法是先由迁移补列，再建索引（见 createRepo 里的迁移代码）。

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  phase TEXT NOT NULL,
  round INTEGER DEFAULT 1,
  total INTEGER DEFAULT 0,
  correct INTEGER DEFAULT 0,
  accuracy REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_s_day ON sessions(day);

CREATE TABLE IF NOT EXISTS practice_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  round INTEGER DEFAULT 1,
  picked TEXT,
  correct INTEGER,
  status TEXT DEFAULT 'pending',
  -- 出题那一刻固化的呈现顺序（打乱后的选项 JSON）与正确答案字母。
  -- 判对错与结果展示都以这两列为准，绝不在事后重新推算 ——
  -- 否则一旦呈现顺序被重算/重洗，就会出现"选了 A、答案也是 A，却判错"的自相矛盾。
  presented_answer TEXT,
  presented_options TEXT,
  -- 这"一轮"是否已经更新过复习调度。
  -- finishSession 会被调用不止一次（提前结束后续练、看完结果页又重新打开同一个会话），
  -- 没有这个标记的话，同一轮的题会被重复复习、间隔被重复累计。
  scheduled INTEGER DEFAULT 0,
  UNIQUE(session_id, question_id, round)
);
CREATE INDEX IF NOT EXISTS idx_pq_session ON practice_questions(session_id);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  session_id INTEGER,
  round INTEGER DEFAULT 1,
  picked TEXT,
  correct INTEGER NOT NULL,
  elapsed_ms INTEGER DEFAULT 0,
  preceded_by_error INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a_q ON attempts(question_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 问答会话：用户可以就某道题提问，也可以泛问语法问题
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT DEFAULT '',
  question_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_updated ON chat_threads(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- 发送给模型的上下文摘要，便于事后回溯"当时喂了什么"
  context TEXT DEFAULT '',
  error INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON chat_messages(thread_id);
`;

/** 本地日历日 YYYY-MM-DD（不用 UTC，否则晚上练的题会被算到第二天）。 */
function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function createRepo(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  // 轻量迁移：老库补上固化的呈现顺序列（并在可能时回填）。
  // 用 PRAGMA 查列而不是 try/catch，免得把其它错误吞掉。
  try {
    const cols = db.prepare('PRAGMA table_info(practice_questions)').all().map((c) => c.name);
    if (!cols.includes('presented_answer')) {
      db.exec('ALTER TABLE practice_questions ADD COLUMN presented_answer TEXT');
    }
    if (!cols.includes('presented_options')) {
      db.exec('ALTER TABLE practice_questions ADD COLUMN presented_options TEXT');
    }
    // 补"本轮是否已更新调度"标记。老库里升级前已完成的会话会被当成没结算过，
    // 下次再结算时多复习一次；只影响遗留数据，新会话不受影响。
    if (!cols.includes('scheduled')) {
      db.exec('ALTER TABLE practice_questions ADD COLUMN scheduled INTEGER DEFAULT 0');
    }
    const qCols = db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name);
    if (!qCols.includes('group_id')) {
      db.exec('ALTER TABLE questions ADD COLUMN group_id INTEGER');
    }
    // 索引在补列之后建：老库原本没有 group_id 列，先建索引会报错
    db.exec('CREATE INDEX IF NOT EXISTS idx_q_group ON questions(group_id)');
    // 老数据没有记录呈现顺序，用题库原始顺序回填：对已完成的会话只是回看用途，
    // 回填后至少保证"展示的答案"与"判错记录"不再各说一套。
    db.exec(`UPDATE practice_questions SET
      presented_answer = COALESCE(presented_answer, (SELECT answer FROM questions WHERE questions.id = practice_questions.question_id)),
      presented_options = COALESCE(presented_options, (SELECT options FROM questions WHERE questions.id = practice_questions.question_id))
      WHERE presented_answer IS NULL OR presented_options IS NULL`);
  } catch {
    /* 迁移失败不该阻止应用启动 */
  }

  // 本次练习的选项打乱结果：只影响呈现顺序，不写回题库。
  // 按「会话:题:轮次」缓存，同一轮内选项位置固定（避免同一题前后不一致）；
  // 错题重做的下一轮会重新洗，所以同一题再遇到时答案字母通常不同。
  const shuffleCache = new Map();
  const shuffleKey = (sessionId, questionId, round) => `${sessionId}:${questionId}:${round}`;

  /**
   * 取某题在某轮的呈现顺序；没有就生成一次并**固化到数据库**。
   *
   * 固化是关键：判对错与结果展示都必须读固化的这一份，
   * 而不是各自重新推算。两次推算只要有任何不一致（内存缓存被清、轮次切换、
   * 进程重启、设置被改），用户就会看到"选了 A、答案也是 A，却判错"的自相矛盾。
   */
  function presentationOf(sessionId, questionId, round, question) {
    const key = shuffleKey(sessionId, questionId, round);
    const row = db
      .prepare('SELECT presented_answer, presented_options FROM practice_questions WHERE session_id = ? AND question_id = ? AND round = ?')
      .get(sessionId, questionId, round);

    // 已固化：直接还原，绝不重算
    if (row && row.presented_answer && row.presented_options) {
      try {
        const options = JSON.parse(row.presented_options);
        const view = { options, answer: row.presented_answer };
        shuffleCache.set(key, view);
        return view;
      } catch {
        /* 数据损坏时退回到重算，下面会覆盖它 */
      }
    }

    const generated = getSetting('shuffleOptions')
      ? srs.shuffleOptions(question.options, question.answer)
      : { options: question.options, answer: question.answer };

    if (row) {
      db.prepare('UPDATE practice_questions SET presented_answer = ?, presented_options = ? WHERE session_id = ? AND question_id = ? AND round = ?')
        .run(generated.answer, JSON.stringify(generated.options), sessionId, questionId, round);
    }
    shuffleCache.set(key, generated);
    return generated;
  }

  const getSetting = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return DEFAULT_SETTINGS[key];
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  };
  const setSetting = (key, value) => {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  };
  const allSettings = () => {
    const out = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key,value FROM settings').all()) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    return out;
  };

  const rowToQuestion = (r) => ({
    id: r.id,
    stem: r.stem,
    options: JSON.parse(r.options),
    answer: r.answer,
    explanation: r.explanation || '',
    knowledgePoints: JSON.parse(r.knowledge_points || '[]'),
    difficulty: r.difficulty,
    sourceNote: r.source_note || '',
    imagePath: r.image_path || '',
    answerInSource: Boolean(r.answer_in_source),
    groupId: r.group_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archived: Boolean(r.archived),
    state: {
      stability: r.stability ?? srs.DEFAULTS.initialStability,
      difficulty: r.difficulty_score ?? srs.DEFAULTS.initialDifficulty,
      reps: r.reps ?? 0,
      lapses: r.lapses ?? 0,
      streak: r.streak ?? 0,
      lastReviewAt: r.last_review_at ?? null,
      dueAt: r.due_at ?? null,
      intervalDays: r.interval_days ?? 0,
    },
  });

  /** 入库。已存在同题干时默认返回 duplicate 让界面问用户，不擅自覆盖。 */
  function saveQuestion(q, opts = {}) {
    const now = opts.now ?? Date.now();
    const hash = stemFingerprint(q.stem);
    const existing = db.prepare('SELECT id FROM questions WHERE stem_hash = ? AND archived = 0').get(hash);

    if (existing && !opts.force) {
      if (opts.onDuplicate === 'skip') return { id: existing.id, action: 'skipped' };
      if (opts.onDuplicate === 'overwrite') {
        db.prepare(`UPDATE questions SET options=?, answer=?, explanation=?, knowledge_points=?,
          difficulty=?, source_note=?, image_path=?, answer_in_source=?, updated_at=? WHERE id=?`)
          .run(JSON.stringify(q.options), q.answer, q.explanation || '', JSON.stringify(q.knowledgePoints || []),
            q.difficulty || 'medium', q.sourceNote || '', q.imagePath || '', q.answerInSource ? 1 : 0, now, existing.id);
        return { id: existing.id, action: 'overwritten' };
      }
      return { id: existing.id, action: 'duplicate', existingId: existing.id };
    }

    const st = srs.newState(now);
    // 分组：可以传 groupId，也可以直接传 groupName（不存在就顺手建一个）
    const gid = q.groupId ?? (q.groupName ? ensureGroup(q.groupName, now) : null);
    const info = db
      .prepare(`INSERT INTO questions
        (stem, stem_hash, options, answer, explanation, knowledge_points, difficulty, source_note, image_path,
         answer_in_source, group_id, created_at, updated_at, stability, difficulty_score, reps, lapses, streak, due_at, interval_days)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(q.stem, hash, JSON.stringify(q.options), q.answer, q.explanation || '',
        JSON.stringify(q.knowledgePoints || []), q.difficulty || 'medium', q.sourceNote || '', q.imagePath || '',
        q.answerInSource ? 1 : 0, gid, now, now, st.stability, st.difficulty, 0, 0, 0, st.dueAt, 0);
    return { id: Number(info.lastInsertRowid), action: 'created', groupId: gid };
  }

  function updateQuestion(id, patch) {
    const current = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    if (!current) return null;
    const now = Date.now();
    const hash = stemFingerprint(patch.stem ?? current.stem);
    // 分组同样支持按名字指定
    let gid = current.group_id;
    if (patch.groupId !== undefined) gid = patch.groupId === null ? null : Number(patch.groupId);
    else if (patch.groupName) gid = ensureGroup(patch.groupName, now);
    db.prepare(`UPDATE questions SET stem=?, stem_hash=?, options=?, answer=?, explanation=?,
      knowledge_points=?, difficulty=?, source_note=?, answer_in_source=?, group_id=?, updated_at=? WHERE id=?`)
      .run(
        patch.stem ?? current.stem, hash,
        JSON.stringify(patch.options ?? JSON.parse(current.options)),
        patch.answer ?? current.answer,
        patch.explanation ?? current.explanation,
        JSON.stringify(patch.knowledgePoints ?? JSON.parse(current.knowledge_points || '[]')),
        patch.difficulty ?? current.difficulty,
        patch.sourceNote ?? current.source_note,
        (patch.answerInSource ?? Boolean(current.answer_in_source)) ? 1 : 0,
        gid,
        now, id,
      );
    return getQuestion(id);
  }

  function getQuestion(id) {
    const r = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    return r ? rowToQuestion(r) : null;
  }

  function listQuestions(filter = {}) {
    const clauses = ['archived = 0'];
    const args = [];
    if (filter.knowledgePoint) {
      clauses.push('knowledge_points LIKE ?');
      args.push(`%${filter.knowledgePoint}%`);
    }
    if (filter.search) {
      clauses.push('(stem LIKE ? OR options LIKE ?)');
      args.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    if (filter.groupId !== undefined) {
      if (filter.groupId === null) clauses.push('group_id IS NULL');
      else {
        clauses.push('group_id = ?');
        args.push(Number(filter.groupId));
      }
    }
    if (filter.dueOnly) {
      clauses.push('due_at <= ?');
      args.push(filter.now ?? Date.now());
    }
    args.push(filter.limit ?? 500);
    // 排序键必须带 id：批量导入的题目 created_at 常常在同一毫秒，
    // 只按 created_at 排序时 SQLite 的顺序不确定（同值排序不稳定），
    // 会导致"关掉乱序"后顺序仍然每次都不同。
    // order='asc' 用于"按录入顺序"（最早录入的在前），默认 'desc'（最近录入的在题库列表最前）。
    const direction = filter.order === 'asc' ? 'ASC' : 'DESC';
    return db
      .prepare(`SELECT * FROM questions WHERE ${clauses.join(' AND ')} ORDER BY created_at ${direction}, id ${direction} LIMIT ?`)
      .all(...args)
      .map(rowToQuestion);
  }

  function archiveQuestion(id, archived = true) {
    db.prepare('UPDATE questions SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, Date.now(), id);
  }

  /** 批量归档 / 恢复。归档是可恢复的，所以这是默认的"删除"方式。 */
  function archiveQuestions(ids, archived = true) {
    const clean = (ids || []).map(Number).filter((n) => Number.isFinite(n));
    if (clean.length === 0) return { updated: 0 };
    const stmt = db.prepare('UPDATE questions SET archived = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    for (const id of clean) stmt.run(archived ? 1 : 0, now, id);
    return { updated: clean.length, archived };
  }

  /**
   * 彻底删除（不可恢复）。
   * 会连同该题的**全部作答历史**一起删掉 —— 因为 attempts 是"这道题的记录"，
   * 留着会污染错题本与集训统计（错题本按 attempts 统计，孤儿记录会让已删的题继续出现）。
   * 删除前会统计影响范围，供界面明确告知用户。
   */
  function deleteQuestions(ids) {
    const clean = (ids || []).map(Number).filter((n) => Number.isFinite(n));
    if (clean.length === 0) return { deleted: 0, attemptsDeleted: 0, sessionsAffected: 0 };

    const marks = clean.map(() => '?').join(',');
    const attemptsDeleted = db
      .prepare(`SELECT COUNT(*) c FROM attempts WHERE question_id IN (${marks})`)
      .get(...clean).c;
    const sessionsAffected = db
      .prepare(`SELECT COUNT(DISTINCT session_id) c FROM attempts WHERE question_id IN (${marks}) AND session_id IS NOT NULL`)
      .get(...clean).c;
    const practiceRows = db
      .prepare(`SELECT COUNT(*) c FROM practice_questions WHERE question_id IN (${marks})`)
      .get(...clean).c;

    // 顺序很重要：先删引用，再删题（外键未开启时也要保证不留孤儿）
    db.prepare(`DELETE FROM attempts WHERE question_id IN (${marks})`).run(...clean);
    db.prepare(`DELETE FROM practice_questions WHERE question_id IN (${marks})`).run(...clean);
    db.prepare(`DELETE FROM chat_threads WHERE question_id IN (${marks})`).run(...clean);
    const info = db.prepare(`DELETE FROM questions WHERE id IN (${marks})`).run(...clean);

    return {
      deleted: Number(info.changes),
      attemptsDeleted,
      practiceRowsDeleted: practiceRows,
      sessionsAffected,
    };
  }

  /** 归档的题目列表（"回收站"）。 */
  function listArchived(limit = 500) {
    return db
      .prepare('SELECT * FROM questions WHERE archived = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(limit)
      .map(rowToQuestion);
  }

  /** 看某批题被删除会牵连多少记录 —— 删除前告知用户，避免误删。 */
  function deleteImpact(ids) {
    const clean = (ids || []).map(Number).filter((n) => Number.isFinite(n));
    if (clean.length === 0) return { questions: 0, attempts: 0, sessions: 0, practiceRows: 0, answered: 0 };
    const marks = clean.map(() => '?').join(',');
    const attempts = db.prepare(`SELECT COUNT(*) c FROM attempts WHERE question_id IN (${marks})`).get(...clean).c;
    const sessions = db
      .prepare(`SELECT COUNT(DISTINCT session_id) c FROM attempts WHERE question_id IN (${marks}) AND session_id IS NOT NULL`)
      .get(...clean).c;
    const practiceRows = db.prepare(`SELECT COUNT(*) c FROM practice_questions WHERE question_id IN (${marks})`).get(...clean).c;
    const answered = db
      .prepare(`SELECT COUNT(*) c FROM questions WHERE id IN (${marks}) AND reps > 0`)
      .get(...clean).c;
    return { questions: clean.length, attempts, sessions, practiceRows, answered };
  }

  function countQuestions(now = Date.now()) {
    const total = db.prepare('SELECT COUNT(*) c FROM questions WHERE archived = 0').get().c;
    const learned = db.prepare('SELECT COUNT(*) c FROM questions WHERE archived = 0 AND reps > 0').get().c;
    const due = db.prepare('SELECT COUNT(*) c FROM questions WHERE archived = 0 AND due_at <= ?').get(now).c;
    const fresh = db.prepare('SELECT COUNT(*) c FROM questions WHERE archived = 0 AND reps = 0').get().c;
    return { total, learned, due, new: fresh };
  }

  /** 建今日会话；已有未完成的今日会话则返回它（续练）。 */
  function startDailySession(opts = {}) {
    const now = opts.now ?? Date.now();
    const day = localDay(now);
    if (!opts.force) {
      const existing = db
        .prepare("SELECT * FROM sessions WHERE day = ? AND phase != 'done' ORDER BY id DESC LIMIT 1")
        .get(day);
      if (existing) return { session: existing, resumed: true };
    }

    const shuffleOptions = getSetting('shuffleOptions');
    const shuffleOrder = getSetting('shuffleOrder');
    // 关掉乱序时用"录入顺序"（最早录入的在前），这样按单元刷题是从第 1 题开始
    const all = listQuestions({ limit: 5000, order: shuffleOrder ? 'desc' : 'asc' });
    const queue = srs.buildDailyQueue(all, {
      now,
      newLimit: getSetting('newLimit'),
      maxTotal: getSetting('maxTotal'),
      shuffleOrder,
      rng: opts.rng,
    });
    if (queue.length === 0) return { session: null, resumed: false, empty: true };

    const info = db.prepare('INSERT INTO sessions(day, started_at, phase, round, total) VALUES(?,?,?,?,?)')
      .run(day, now, 'answering', 1, queue.length);
    const sessionId = Number(info.lastInsertRowid);

    const insert = db.prepare('INSERT INTO practice_questions(session_id, question_id, position, round) VALUES(?,?,?,?)');
    queue.forEach((q, i) => {
      insert.run(sessionId, q.id, i, 1);
      if (shuffleOptions) presentationOf(sessionId, q.id, 1, q);
    });

    return { session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId), resumed: false };
  }

  /** 取会话详情。作答前不返回答案，从根上避免界面误渲染。 */
  function sessionDetail(sessionId, now = Date.now(), onlyRound = null) {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return null;

    const rows = db
      .prepare(`SELECT pq.question_id, pq.position, pq.round, pq.picked, pq.correct, pq.status, pq.scheduled,
                q.stem, q.options, q.answer, q.explanation, q.knowledge_points, q.difficulty,
                q.stability, q.difficulty_score, q.reps, q.lapses, q.streak, q.last_review_at, q.due_at,
                q.interval_days, q.archived, q.source_note, q.image_path, q.answer_in_source, q.created_at, q.updated_at
        FROM practice_questions pq JOIN questions q ON q.id = pq.question_id
        WHERE pq.session_id = ?${onlyRound ? ' AND pq.round = ?' : ''}
        ORDER BY pq.round, pq.position`)
      .all(...(onlyRound ? [sessionId, onlyRound] : [sessionId]));

    const items = rows.map((r) => {
      const q = rowToQuestion(r);
      // 呈现顺序按"这一题这一轮"取，题库里的原始答案不受影响
      const view = presentationOf(sessionId, r.question_id, r.round, q);
      const revealed = r.picked !== null && r.picked !== undefined;
      return {
        questionId: r.question_id,
        position: r.position,
        round: r.round,
        stem: q.stem,
        options: view.options,
        knowledgePoints: q.knowledgePoints,
        difficulty: q.difficulty,
        status: r.status,
        scheduled: r.scheduled === 1,
        picked: r.picked,
        correct: revealed ? Boolean(r.correct) : null,
        answer: revealed ? view.answer : null,
        explanation: revealed ? q.explanation : '',
        mastery: srs.mastery(q.state, now),
        schedule: srs.describeSchedule(q.state, now),
      };
    });

    return {
      id: s.id,
      day: s.day,
      phase: s.phase,
      round: s.round,
      startedAt: s.started_at,
      finishedAt: s.finished_at,
      total: s.total,
      correct: s.correct,
      accuracy: s.accuracy,
      items,
      answered: items.filter((i) => i.picked !== null).length,
      // 把乱序状态告知界面：避免用户改了设置却以为没生效
      shuffling: {
        options: getSetting('shuffleOptions'),
        order: getSetting('shuffleOrder'),
      },
    };
  }

  /** 记录一次作答。答错标记重做，答对终态。 */
  function recordAnswer(sessionId, questionId, picked, meta = {}) {
    const now = meta.now ?? Date.now();
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return null;
    const round = meta.round ?? s.round;
    const pq = db
      .prepare('SELECT * FROM practice_questions WHERE session_id = ? AND question_id = ? AND round = ?')
      .get(sessionId, questionId, round);
    if (!pq) return null;
    const q = getQuestion(questionId);
    if (!q) return null;

    // 判对错必须用"这一题这一轮实际呈现的选项顺序"，不能用题库里的原始字母
    const view = presentationOf(sessionId, questionId, round, q);
    const correct = picked === view.answer;

    db.prepare('UPDATE practice_questions SET picked = ?, correct = ?, status = ? WHERE id = ?')
      .run(picked, correct ? 1 : 0, correct ? 'done' : 'needs_retry', pq.id);

    const priorWrong = db
      .prepare('SELECT COUNT(*) c FROM attempts WHERE question_id = ? AND session_id = ? AND correct = 0')
      .get(questionId, sessionId).c;

    db.prepare(`INSERT INTO attempts(question_id, session_id, round, picked, correct, elapsed_ms, preceded_by_error, created_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(questionId, sessionId, round, picked, correct ? 1 : 0, meta.elapsedMs ?? 0, priorWrong > 0 ? 1 : 0, now);

    return { correct, needsRetry: !correct, round };
  }

  /**
   * 结束会话：算正确率 + 更新复习调度。
   * 调度按"该题在本次会话中最终是否做对"更新一次：
   *   最终做对 = 即使第一次错了，重做对了也算掌握（这一次的记忆是有效的）
   */
  function finishSession(sessionId, opts = {}) {
    const now = opts.now ?? Date.now();
    const detail = sessionDetail(sessionId, now);
    if (!detail) return null;

    // 汇总每道题在整个会话（含所有重做轮）的最终表现
    const perQuestion = new Map();
    for (const item of detail.items) {
      if (item.picked === null) continue;
      const cur = perQuestion.get(item.questionId) || { firstCorrect: null, finalCorrect: false, attempts: 0, item };
      cur.attempts += 1;
      if (cur.firstCorrect === null) cur.firstCorrect = item.correct;
      if (item.correct) cur.finalCorrect = true;
      cur.lastItem = item;
      perQuestion.set(item.questionId, cur);
    }

    // 只有"本轮真正作答过、且这一轮还没结算过"的题才更新调度：
    //   ① 第一轮就做对、没进重做轮的题，不该被重做轮的结算再复习一次；
    //   ② 同一轮被重复结算（提前结束后续练、重新打开结果页）也不该重复累计。
    const pending = new Set();
    for (const item of detail.items) {
      if (item.picked !== null && !item.scheduled) pending.add(item.questionId);
    }

    const applied = [];
    for (const [questionId, agg] of perQuestion) {
      const q = getQuestion(questionId);
      if (!q) continue;
      let state = q.state;
      if (pending.has(questionId)) {
        state = srs.review(q.state, agg.finalCorrect, {
          now,
          targetRetention: getSetting('targetRetention'),
        });
        db.prepare(`UPDATE questions SET stability=?, difficulty_score=?, reps=?, lapses=?, streak=?,
          last_review_at=?, due_at=?, interval_days=? WHERE id=?`)
          .run(state.stability, state.difficulty, state.reps, state.lapses, state.streak,
            state.lastReviewAt, state.dueAt, state.intervalDays, questionId);
        db.prepare('UPDATE practice_questions SET scheduled = 1 WHERE session_id = ? AND question_id = ? AND picked IS NOT NULL')
          .run(sessionId, questionId);
      }
      applied.push({
        questionId,
        finalCorrect: agg.finalCorrect,
        firstTryCorrect: agg.firstCorrect,
        attempts: agg.attempts,
        intervalDays: state.intervalDays,
        dueAt: state.dueAt,
      });
    }

    const answered = detail.items.filter((i) => i.picked !== null);
    const correct = answered.filter((i) => i.correct).length;
    const accuracy = answered.length ? correct / answered.length : 0;
    const wrongIds = [...perQuestion.entries()].filter(([, a]) => !a.finalCorrect).map(([id]) => id);

    db.prepare('UPDATE sessions SET phase=?, finished_at=?, total=?, correct=?, accuracy=? WHERE id=?')
      .run(wrongIds.length ? 'reviewing' : 'done', now, answered.length, correct, accuracy, sessionId);

    const wrongItems = [...perQuestion.entries()]
      .filter(([, a]) => !a.finalCorrect)
      .map(([, a]) => a.lastItem);

    return {
      sessionId,
      round: detail.round,
      total: answered.length,
      correct,
      accuracy,
      wrong: wrongItems.map((i) => {
        // 累计错题次数：用于"第二次做错"时展开讲评
        const cum = db
          .prepare('SELECT COUNT(*) c FROM attempts WHERE question_id = ? AND correct = 0')
          .get(i.questionId).c;
        return {
          questionId: i.questionId,
          stem: i.stem,
          picked: i.picked,
          answer: i.answer,
          explanation: i.explanation,
          knowledgePoints: i.knowledgePoints,
          wrongCount: cum,
          needsTeaching: cum >= 2,
        };
      }),
      knowledgePoints: srs.summarizeKnowledge(wrongItems),
      applied,
      needsRetry: wrongIds.length > 0,
    };
  }

  /** 开启错题重做轮：错题在新一轮重新排入，选项重新打乱。 */
  function startRetryRound(sessionId, opts = {}) {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return null;

    // 找出"在任一已完成的轮次里最终仍未做对"的题
    const rows = db
      .prepare(`SELECT question_id FROM practice_questions
        WHERE session_id = ? GROUP BY question_id
        HAVING MAX(correct) = 0 ORDER BY MIN(position)`)
      .all(sessionId);

    if (rows.length === 0) {
      db.prepare('UPDATE sessions SET phase = ? WHERE id = ?').run('done', sessionId);
      return { round: s.round, items: [] };
    }

    const round = s.round + 1;
    db.prepare('UPDATE sessions SET round = ?, phase = ?, finished_at = NULL WHERE id = ?')
      .run(round, 'reviewing', sessionId);

    // 重做轮的题目顺序同样打乱（错题本来就少，顺序固定容易形成位置记忆）
    const order = getSetting('shuffleOrder') ? srs.shuffleInPlace([...rows]) : rows;
    const insert = db.prepare('INSERT OR IGNORE INTO practice_questions(session_id, question_id, position, round) VALUES(?,?,?,?)');
    order.forEach((w, i) => insert.run(sessionId, w.question_id, i, round));

    // 重做轮的选项**重新洗一次**：同一道题第 1 轮选 B、重做时答案可能变成 D
    for (const w of order) {
      const q = getQuestion(w.question_id);
      if (q) presentationOf(sessionId, w.question_id, round, q);
    }
    return { round, items: rows.map((w) => w.question_id) };
  }

  /** 一次会话里所有轮次的完整回放（练习结束后给用户看全部作答）。 */
  function sessionReplay(sessionId) {
    return db
      .prepare(`SELECT pq.round, pq.position, pq.picked, pq.correct, pq.status,
                q.id question_id, q.stem, q.answer, q.explanation, q.knowledge_points
        FROM practice_questions pq JOIN questions q ON q.id = pq.question_id
        WHERE pq.session_id = ? ORDER BY pq.round, pq.position`)
      .all(sessionId)
      .map((r) => ({
        round: r.round,
        questionId: r.question_id,
        stem: r.stem,
        picked: r.picked,
        correct: r.correct === null ? null : Boolean(r.correct),
        answer: r.answer,
        explanation: r.explanation,
        knowledgePoints: JSON.parse(r.knowledge_points || '[]'),
      }));
  }

  /** 看板：按知识点统计掌握情况，最弱的排最前。 */
  function knowledgeStats(now = Date.now()) {
    const questions = listQuestions({ limit: 10000 });
    const map = new Map();
    for (const q of questions) {
      const m = srs.mastery(q.state, now);
      for (const kp of q.knowledgePoints.length ? q.knowledgePoints : ['未标注']) {
        if (!map.has(kp)) map.set(kp, { name: kp, total: 0, mastered: 0, masterySum: 0, lapses: 0, due: 0 });
        const it = map.get(kp);
        it.total += 1;
        it.masterySum += m;
        it.lapses += q.state.lapses;
        if (m >= 0.8) it.mastered += 1;
        if (srs.isDue(q.state, now)) it.due += 1;
      }
    }
    return [...map.values()]
      .map((it) => ({ ...it, avgMastery: it.total ? it.masterySum / it.total : 0 }))
      .sort((a, b) => a.avgMastery - b.avgMastery);
  }

  function recentSessions(limit = 30) {
    return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  /**
   * 某道题的作答历史（倒序，最近的在最前）。
   * 用于"第二次做错时把前几次的答案摆给用户看"——这是最有说服力的讲评材料。
   */
  function attemptHistory(questionId, limit = 20) {
    return db
      .prepare(`SELECT a.round, a.picked, a.correct, a.created_at, a.session_id, s.day
        FROM attempts a LEFT JOIN sessions s ON s.id = a.session_id
        WHERE a.question_id = ? ORDER BY a.created_at DESC LIMIT ?`)
      .all(questionId, limit)
      .map((r) => ({
        round: r.round,
        picked: r.picked,
        correct: Boolean(r.correct),
        at: r.created_at,
        sessionId: r.session_id,
        day: r.day,
      }));
  }

  /** 本次会话里某题错了几次（含重做轮）。 */
  function sessionWrongCount(sessionId, questionId) {
    return db
      .prepare('SELECT COUNT(*) c FROM attempts WHERE session_id = ? AND question_id = ? AND correct = 0')
      .get(sessionId, questionId).c;
  }

  /**
   * 本次会话里所有错过的题，按"本次会话错了几次"降序。
   * 供结算页做"重点讲评"用。
   */
  function sessionMistakes(sessionId) {
    return db
      .prepare(`SELECT question_id, COUNT(*) wrong_count
        FROM attempts WHERE session_id = ? AND correct = 0
        GROUP BY question_id ORDER BY wrong_count DESC`)
      .all(sessionId)
      .map((r) => ({ questionId: r.question_id, wrongCount: r.wrong_count }));
  }

  /* ---------------- 分组 ---------------- */
  /** 按名字取分组；不存在就新建（录入时直接写组名很方便）。 */
  function ensureGroup(name, now = Date.now()) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const found = db.prepare('SELECT * FROM groups WHERE name = ?').get(clean);
    if (found) return found.id;
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM groups').get().m;
    const info = db
      .prepare('INSERT INTO groups(name, note, sort_order, created_at) VALUES(?,?,?,?)')
      .run(clean, '', maxOrder + 1, now);
    return Number(info.lastInsertRowid);
  }

  function createGroup({ name, note = '' }, now = Date.now()) {
    const clean = String(name || '').trim();
    if (!clean) return { ok: false, error: '分组名不能为空' };
    const exists = db.prepare('SELECT id FROM groups WHERE name = ?').get(clean);
    if (exists) return { ok: false, error: `分组「${clean}」已存在`, id: exists.id };
    const id = ensureGroup(clean, now);
    if (note) db.prepare('UPDATE groups SET note = ? WHERE id = ?').run(String(note), id);
    return { ok: true, id };
  }

  function renameGroup(id, name, note) {
    const clean = String(name || '').trim();
    if (!clean) return { ok: false, error: '分组名不能为空' };
    const dup = db.prepare('SELECT id FROM groups WHERE name = ? AND id != ?').get(clean, id);
    if (dup) return { ok: false, error: `已有同名分组「${clean}」` };
    const cur = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
    if (!cur) return { ok: false, error: '分组不存在' };
    db.prepare('UPDATE groups SET name = ?, note = ? WHERE id = ?')
      .run(clean, note === undefined ? cur.note : String(note), id);
    return { ok: true };
  }

  /** 删除分组。题目不会被删，只是变为"未分组"。 */
  function deleteGroup(id) {
    const n = db.prepare('SELECT COUNT(*) c FROM questions WHERE group_id = ?').get(id).c;
    db.prepare('UPDATE questions SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    return { ok: true, ungrouped: n };
  }

  /** 把一批题目归入某个分组（groupId 传 null 表示移出分组）。 */
  function assignQuestionsToGroup(questionIds, groupId) {
    const ids = (questionIds || []).map(Number).filter((n) => Number.isFinite(n));
    if (ids.length === 0) return { updated: 0 };
    const gid = groupId === null || groupId === undefined ? null : Number(groupId);
    if (gid !== null && !db.prepare('SELECT id FROM groups WHERE id = ?').get(gid)) {
      return { updated: 0, error: '目标分组不存在' };
    }
    const stmt = db.prepare('UPDATE questions SET group_id = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    for (const id of ids) stmt.run(gid, now, id);
    return { updated: ids.length, groupId: gid };
  }

  /** 分组列表 + 每个分组的题量与掌握情况（按单元看进度的核心数据）。 */
  function listGroups(now = Date.now()) {
    const rows = db.prepare('SELECT * FROM groups ORDER BY sort_order, id').all();
    const out = rows.map((g) => {
      const qs = db.prepare('SELECT * FROM questions WHERE group_id = ? AND archived = 0').all(g.id).map(rowToQuestion);
      const masterySum = qs.reduce((a, q) => a + srs.mastery(q.state, now), 0);
      const learned = qs.filter((q) => q.state.reps > 0).length;
      const wrongTotal = qs.reduce((a, q) => a + q.state.lapses, 0);
      const dueCount = qs.filter((q) => srs.isDue(q.state, now)).length;
      const kpMap = new Map();
      for (const q of qs) {
        for (const kp of q.knowledgePoints) kpMap.set(kp, (kpMap.get(kp) || 0) + 1);
      }
      return {
        id: g.id,
        name: g.name,
        note: g.note || '',
        sortOrder: g.sort_order,
        createdAt: g.created_at,
        total: qs.length,
        learned,
        unlearned: qs.length - learned,
        due: dueCount,
        wrongTotal,
        avgMastery: qs.length ? masterySum / qs.length : 0,
        topKnowledge: [...kpMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
      };
    });
    // 未分组的题目单独统计，避免"看不见的题"
    const ungrouped = db.prepare('SELECT COUNT(*) c FROM questions WHERE group_id IS NULL AND archived = 0').get().c;
    return { groups: out, ungrouped };
  }

  /**
   * 考前集训：把用户**所有错过的题**排进指定天数（默认 7 天）内复习一遍。
   *
   * 设计要点：
   *  - 只针对"错过至少一次"的题（attempts 里 correct=0），不是整本题库；
   *  - **不打乱原有的到期时间排序**，而是把错题按"错的次数多的在前"均匀铺到每一天；
   *  - 同一天内的题按到期时间排序，保证原本就该复习的题优先；
   *  - 这是**计划**（改 due_at），用户点"开始"才会建立会话。
   *  - 天数与每天题量上限都可调：题多时自动多分几天，题少时集中在头几天。
   */
  function planSprint(opts = {}) {
    const days = Math.max(1, Math.min(30, Number(opts.days) || 7));
    const perDayCap = Math.max(1, Number(opts.perDayCap) || 60);
    const now = opts.now ?? Date.now();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    // 所有错过的题：按错误次数降序（错得多的先复习），再按最近一次错的时间升序
    const rows = db
      .prepare(`SELECT q.id, q.stem, q.knowledge_points, q.group_id,
          COUNT(a.id) AS wrong_count,
          MAX(a.created_at) AS last_wrong_at,
          q.due_at, q.reps
        FROM questions q
        JOIN attempts a ON a.question_id = q.id AND a.correct = 0
        WHERE q.archived = 0
        GROUP BY q.id
        ORDER BY wrong_count DESC, last_wrong_at ASC`)
      .all();

    if (rows.length === 0) {
      return { ok: true, empty: true, message: '还没有错过的题目 —— 多练几轮再来集训。', days, planned: 0 };
    }

    // 每天分几道题，分两种情形：
    //  - 装得下（错题 ≤ 天数 × 每天上限）：每天不超过上限；题少时集中在头几天，不硬凑满天数。
    //  - 装不下：把超出的部分**均摊到每一天**。
    //    旧实现顺序切分后把溢出全部并入最后一天，于是 25 题 / 7 天 / 上限 3 会排成
    //    3,3,3,3,3,3,7 —— 最后一天被"挤爆"；错题一多（500 题 / 7 天 / 上限 60）
    //    最后一天会堆到 140 道，用户根本做不完。溢出不可避免（天数与覆盖都是硬约束），
    //    但可以摊平，而不是压在一天。
    let sizes;
    if (rows.length <= days * perDayCap) {
      const perDay = Math.min(perDayCap, Math.ceil(rows.length / days));
      sizes = Array.from({ length: days }, (_, d) => Math.max(0, Math.min(perDay, rows.length - d * perDay)));
    } else {
      const base = Math.floor(rows.length / days);
      const extra = rows.length % days;
      sizes = Array.from({ length: days }, (_, d) => base + (d < extra ? 1 : 0));
    }
    const perDay = Math.max(0, ...sizes);

    const buckets = [];
    let cursor = 0;
    for (let d = 0; d < days; d += 1) {
      const slice = rows.slice(cursor, cursor + sizes[d]);
      cursor += sizes[d];
      const date = new Date(startOfToday.getTime() + d * srs.DAY_MS);
      buckets.push({ dayIndex: d + 1, date, questions: slice });
    }

    // 记录计划（含每天的时间戳），供界面展示
    const plan = buckets
      .filter((b) => b.questions.length > 0)
      .map((b) => ({
        dayIndex: b.dayIndex,
        date: localDay(b.date.getTime()),
        at: b.date.getTime() + 8 * 3600 * 1000, // 当天早上 8 点，避免凌晨提醒
        count: b.questions.length,
        questionIds: b.questions.map((q) => q.id),
        knowledgePoints: [...new Set(b.questions.flatMap((q) => JSON.parse(q.knowledge_points || '[]')))].slice(0, 8),
      }));

    return {
      ok: true,
      empty: false,
      days,
      perDay,
      totalWrong: rows.length,
      covered: plan.reduce((a, b) => a + b.count, 0),
      plan,
      // 把每天的题量也列出来，方便用户判断负担是否合理
      perDayCounts: plan.map((d) => d.count),
      summary: `${rows.length} 道错题，分 ${plan.length} 天复习完（每天 ${plan.map((d) => d.count).join('/')} 道）`,
    };
  }

  /** 应用集训计划：把错题的到期时间改到计划的那一天。 */
  function applySprint(plan) {
    if (!Array.isArray(plan) || plan.length === 0) return { ok: false, error: '没有可应用的集训计划' };
    const stmt = db.prepare('UPDATE questions SET due_at = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    let moved = 0;
    for (const day of plan) {
      for (const id of day.questionIds || []) {
        stmt.run(day.at ?? now, now, id);
        moved += 1;
      }
    }
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('lastSprint', JSON.stringify({ appliedAt: now, moved, days: plan.length }));
    return { ok: true, moved, days: plan.length };
  }

  function lastSprint() {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('lastSprint');
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  /**
   * 集训进度：把"错过的题"分成 已排期/已完成/待排期，
   * 让用户知道集训进行到哪了。
   */
  function sprintStatus(now = Date.now()) {
    const wrong = db
      .prepare(`SELECT q.id, q.due_at, q.reps, q.streak,
          COUNT(a.id) AS wrong_count
        FROM questions q JOIN attempts a ON a.question_id = q.id AND a.correct = 0
        WHERE q.archived = 0 GROUP BY q.id`)
      .all();
    const total = wrong.length;
    const scheduled = wrong.filter((q) => q.due_at && q.due_at > now).length;
    const dueNow = wrong.filter((q) => !q.due_at || q.due_at <= now).length;
    // "已攻克"：最后一次作答之后连续答对，且稳定度足够
    const conquered = wrong.filter((q) => q.reps > 0 && q.streak >= 2).length;
    return {
      totalWrong: total,
      scheduled,
      dueNow,
      conquered,
      lastSprint: lastSprint(),
    };
  }

  /** 错题本。 */
  function wrongBook(limit = 200) {
    return db
      .prepare(`SELECT q.*, COUNT(a.id) wrong_count, MAX(a.created_at) last_wrong_at
        FROM questions q JOIN attempts a ON a.question_id = q.id AND a.correct = 0
        WHERE q.archived = 0 GROUP BY q.id ORDER BY last_wrong_at DESC LIMIT ?`)
      .all(limit)
      .map((r) => ({ ...rowToQuestion(r), wrongCount: r.wrong_count, lastWrongAt: r.last_wrong_at }));
  }

  /** 未来 7 天的复习量预测，让用户知道接下来几天的负担。 */
  function forecast(now = Date.now(), days = 7) {
    const out = [];
    for (let d = 0; d < days; d += 1) {
      const from = now + d * srs.DAY_MS;
      const to = from + srs.DAY_MS;
      const c = db
        .prepare('SELECT COUNT(*) c FROM questions WHERE archived = 0 AND reps > 0 AND due_at >= ? AND due_at < ?')
        .get(from, to).c;
      out.push({ day: localDay(from), count: c + (d === 0 ? countQuestions(now).new : 0) });
    }
    return out;
  }

  function close() {
    db.close();
  }

  // ---------- 问答记录 ----------
  /** 新建或取回某道题的问答线程（每题一条，便于反复追问）。 */
  function ensureThread(opts = {}) {
    const now = opts.now ?? Date.now();
    if (opts.questionId) {
      const found = db
        .prepare('SELECT * FROM chat_threads WHERE question_id = ? ORDER BY id DESC LIMIT 1')
        .get(opts.questionId);
      if (found) return found;
    }
    const title = opts.title || (opts.questionId ? `题目 #${opts.questionId}` : '新对话');
    const info = db
      .prepare('INSERT INTO chat_threads(title, question_id, created_at, updated_at) VALUES(?,?,?,?)')
      .run(title, opts.questionId ?? null, now, now);
    return db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  function addChatMessage(threadId, role, content, meta = {}) {
    const now = meta.now ?? Date.now();
    const info = db
      .prepare('INSERT INTO chat_messages(thread_id, role, content, context, error, created_at) VALUES(?,?,?,?,?,?)')
      .run(threadId, role, String(content), meta.context || '', meta.error ? 1 : 0, now);
    db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, threadId);
    return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  function threadMessages(threadId, limit = 200) {
    return db
      .prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id ASC LIMIT ?')
      .all(threadId, limit)
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        context: m.context,
        error: Boolean(m.error),
        createdAt: m.created_at,
      }));
  }

  function listThreads(limit = 30) {
    return db
      .prepare('SELECT * FROM chat_threads ORDER BY updated_at DESC LIMIT ?')
      .all(limit)
      .map((t) => ({
        id: t.id,
        title: t.title,
        questionId: t.question_id,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        messageCount: db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE thread_id = ?').get(t.id).c,
      }));
  }

  function deleteThread(threadId) {
    db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId);
  }

  return {
    raw: db,
    saveQuestion,
    updateQuestion,
    listQuestions,
    getQuestion,
    archiveQuestion,
    archiveQuestions,
    deleteQuestions,
    listArchived,
    deleteImpact,
    countQuestions,
    startDailySession,
    sessionDetail,
    recordAnswer,
    finishSession,
    startRetryRound,
    sessionReplay,
    knowledgeStats,
    recentSessions,
    wrongBook,
    forecast,
    attemptHistory,
    sessionWrongCount,
    sessionMistakes,
    ensureGroup,
    createGroup,
    renameGroup,
    deleteGroup,
    assignQuestionsToGroup,
    listGroups,
    planSprint,
    applySprint,
    sprintStatus,
    lastSprint,
    ensureThread,
    addChatMessage,
    threadMessages,
    listThreads,
    deleteThread,
    getSetting,
    setSetting,
    allSettings,
    close,
  };
}

module.exports = { createRepo, DEFAULT_SETTINGS, localDay };
