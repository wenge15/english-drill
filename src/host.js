'use strict';

/**
 * 宿主逻辑：把数据层与模型层包成一组"动作"，供任意外壳（Electron 主进程、Node HTTP 服务）调用。
 *
 * 这样拆的原因是：UI 将来可能换壳（Electron → WebView2 或反过来），
 * 但业务动作不该跟着重写。外壳只负责传参和渲染。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createRepo } = require('./core/db.js');
const srs = require('./core/srs.js');
const extract = require('./core/extract.js');
const model = require('./core/model.js');
const textparse = require('./core/textparse.js');
const knowledge = require('./core/knowledge.js');
const glossary = require('./core/glossary.js');

/** API Key 等敏感设置单独存一个文件，和题库数据库分开，便于备份/清理。 */
function createStore(configPath) {
  let filePath = configPath;
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (patch) => {
    const cur = read();
    const next = { ...cur, ...patch };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  };
  return {
    get: read,
    set: write,
    setPath(p) {
      filePath = p;
    },
    get path() {
      return filePath;
    },
  };
}

function createHost(opts) {
  const dataDir = opts.dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const repo = createRepo(path.join(dataDir, 'questions.db'));
  const store = createStore(path.join(dataDir, 'config.json'));
  const imagesDir = path.join(dataDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const modelConfig = () => {
    const s = store.get();
    return {
      ...model.DEFAULT_CONFIG,
      baseUrl: s.baseUrl || model.DEFAULT_CONFIG.baseUrl,
      model: s.model || model.DEFAULT_CONFIG.model,
      visionModel: s.visionModel || '',
      apiKey: s.apiKey || '',
      provider: s.provider || 'openai-compatible',
      timeoutMs: s.timeoutMs || model.DEFAULT_CONFIG.timeoutMs,
    };
  };

  const actions = {
    // ---------- 题库 ----------
    'questions:list': (payload = {}) => {
      const all = repo.listQuestions(payload);
      // 分组信息一起带上：界面要显示每道题属于哪个单元
      const groupMap = new Map(repo.listGroups().groups.map((g) => [g.id, g.name]));
      const questions = all.map((q) => ({ ...q, groupName: q.groupId ? groupMap.get(q.groupId) || '' : '' }));
      return { ok: true, questions };
    },
    'questions:get': ({ id }) => ({ ok: true, question: repo.getQuestion(id) }),
    'questions:save': (payload) => {
      const { questions, onDuplicate } = payload;
      const results = [];
      for (const q of questions) {
        const v = extract.validateForSave(q);
        if (!v.ok) {
          results.push({ ok: false, errors: v.errors, warns: v.warns, stem: q.stem });
          continue;
        }
        const saved = repo.saveQuestion(q, { onDuplicate });
        results.push({ ok: true, ...saved, warns: v.warns, stem: q.stem });
      }
      return {
        ok: true,
        results,
        created: results.filter((r) => r.action === 'created').length,
        skipped: results.filter((r) => r.action === 'skipped' || r.action === 'duplicate').length,
        overwritten: results.filter((r) => r.action === 'overwritten').length,
        failed: results.filter((r) => !r.ok).length,
      };
    },
    'questions:update': ({ id, patch }) => ({ ok: true, question: repo.updateQuestion(id, patch) }),
    'questions:archive': ({ id, archived = true }) => {
      repo.archiveQuestion(id, archived);
      return { ok: true };
    },

    /**
     * 批量删除。
     * mode='archive'（默认）= 移入回收站，可恢复；
     * mode='purge' = 彻底删除，连同作答历史，不可恢复。
     * 删之前先用 questions:deleteImpact 告知影响范围，避免误删。
     */
    'questions:bulkDelete': ({ ids, mode = 'archive' }) => {
      const clean = (ids || []).map(Number).filter((n) => Number.isFinite(n));
      if (clean.length === 0) return { ok: false, error: '没有选中任何题目' };
      if (mode === 'purge') {
        const impact = repo.deleteImpact(clean);
        const r = repo.deleteQuestions(clean);
        return {
          ok: true,
          mode: 'purge',
          ...r,
          impact,
          message: `已彻底删除 ${r.deleted} 道题（同时清除 ${r.attemptsDeleted} 条作答记录，涉及 ${r.sessionsAffected} 次练习）`,
        };
      }
      const r = repo.archiveQuestions(clean, true);
      return {
        ok: true,
        mode: 'archive',
        ...r,
        message: `已把 ${r.updated} 道题移入回收站（数据仍在，可随时恢复）`,
      };
    },
    /** 删除前的影响预估：让界面能明确告诉用户"会牵连什么"。 */
    'questions:deleteImpact': ({ ids }) => ({ ok: true, impact: repo.deleteImpact(ids) }),

    // ---------- 回收站 ----------
    'trash:list': ({ limit = 500 } = {}) => {
      const items = repo.listArchived(limit);
      const groupMap = new Map(repo.listGroups().groups.map((g) => [g.id, g.name]));
      return {
        ok: true,
        items: items.map((q) => ({ ...q, groupName: q.groupId ? groupMap.get(q.groupId) || '' : '' })),
      };
    },
    'trash:restore': ({ ids }) => {
      const r = repo.archiveQuestions(ids, false);
      return { ok: true, ...r, message: `已恢复 ${r.updated} 道题` };
    },
    'trash:purge': ({ ids }) => {
      const r = repo.deleteQuestions(ids);
      return {
        ok: true,
        ...r,
        message: `已彻底删除 ${r.deleted} 道题（同时清除 ${r.attemptsDeleted} 条作答记录）`,
      };
    },
    'trash:empty': () => {
      const all = repo.listArchived(5000).map((q) => q.id);
      if (all.length === 0) return { ok: true, deleted: 0, message: '回收站已经是空的' };
      const r = repo.deleteQuestions(all);
      return { ok: true, ...r, message: `已清空回收站：彻底删除 ${r.deleted} 道题` };
    },
    'questions:counts': () => ({ ok: true, counts: repo.countQuestions(), today: localDayLabel() }),

    // ---------- 拍照录入 ----------
    'capture:extract': async ({ imageBase64, mime, answerInSource = true, saveImage = true }) => {
      const bytes = Buffer.from(String(imageBase64).replace(/^data:[^,]+,/, ''), 'base64');
      if (bytes.length === 0) return { ok: false, error: '图片为空，请重新拍照' };
      let imagePath = '';
      if (saveImage) {
        const name = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${(mime || 'image/png').split('/')[1] || 'png'}`;
        imagePath = path.join(imagesDir, name);
        fs.writeFileSync(imagePath, bytes);
      }
      try {
        const r = await model.extractQuestionsFromImage(modelConfig(), bytes, { mime, answerInSource });
        return {
          ok: true,
          questions: r.questions.map((q) => ({ ...q, imagePath })),
          warnings: r.warnings,
          modelUsed: r.modelUsed,
          imagePath,
        };
      } catch (e) {
        return { ok: false, error: e.message, code: e.code, imagePath };
      }
    },
    'capture:analyze': async ({ question }) => {
      try {
        const r = await model.analyzeQuestion(modelConfig(), question);
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    'capture:readClipboardImage': () => ({ ok: false, error: '该功能需要外壳支持，请使用文件选择' }),
    /** 外壳注入能力：浏览器外壳用文件对话框上传的图片走这里；Electron 走 IPC。 */
    'shell:pickImage': (payload = {}) => ({ ok: true, files: payload.files || [] }),

    // ---------- 练习 ----------
    'practice:start': (payload = {}) => {
      const r = repo.startDailySession({ force: payload.force });
      if (r.empty) {
        return {
          ok: true,
          empty: true,
          counts: repo.countQuestions(),
          message: '今日没有要练的题了。可以继续拍照录入新题，或把新题上限调大。',
        };
      }
      return { ok: true, resumed: r.resumed, session: repo.sessionDetail(r.session.id) };
    },
    'practice:answer': ({ sessionId, questionId, picked }) => {
      const r = repo.recordAnswer(sessionId, questionId, picked);
      if (!r) return { ok: false, error: '这一题不在当前练习中，可能已被重做覆盖' };
      // 刻意不返回对错：练完才揭晓是明确的产品要求
      return { ok: true };
    },
    'practice:finish': ({ sessionId }) => {
      const summary = repo.finishSession(sessionId);
      if (!summary) return { ok: false, error: '练习会话不存在' };
      return { ok: true, summary, replay: repo.sessionReplay(sessionId) };
    },
    'practice:retry': ({ sessionId }) => {
      const r = repo.startRetryRound(sessionId);
      if (!r) return { ok: false, error: '练习会话不存在' };
      if (r.items.length === 0) return { ok: true, empty: true, message: '错题已全部订正' };
      return { ok: true, session: repo.sessionDetail(sessionId, Date.now(), r.round) };
    },
    'practice:history': ({ limit = 30 } = {}) => ({ ok: true, sessions: repo.recentSessions(limit) }),
    /** 回看某次练习的结果（结果页深链接 #session=<id> 用）。 */
    'practice:replay': ({ sessionId }) => {
      const s = repo.sessionDetail(sessionId);
      if (!s) return { ok: false, error: '这次练习记录不存在' };
      const replay = repo.sessionReplay(sessionId);
      // summary 由会话表里的最终统计反推，保证与练习结束时看到的一致
      const wrongRows = replay.filter((r) => r.correct === false);
      const answered = replay.filter((r) => r.correct !== null);
      const applied = repo.raw
        .prepare('SELECT question_id, correct FROM practice_questions WHERE session_id = ? ORDER BY round, position')
        .all(sessionId);
      // 回看历史时 finishSession 的实时统计已经拿不到了，用重做轮次反推：
      // 只出现在第 1 轮 = 一次做对；出现多轮 = 重做过几次。
      const roundsOf = new Map();
      for (const r of replay) {
        if (r.correct === null) continue;
        const cur = roundsOf.get(r.questionId) || { rounds: [], firstCorrect: null };
        cur.rounds.push(r.round);
        if (cur.firstCorrect === null) cur.firstCorrect = r.correct;
        roundsOf.set(r.questionId, cur);
      }
      return {
        ok: true,
        summary: {
          sessionId: Number(sessionId),
          round: s.round,
          total: answered.length,
          correct: answered.filter((r) => r.correct).length,
          accuracy: s.accuracy,
          wrong: wrongRows.map((r) => ({
            questionId: r.questionId,
            stem: r.stem,
            picked: r.picked,
            answer: r.answer,
            explanation: r.explanation,
            knowledgePoints: r.knowledgePoints,
          })),
          knowledgePoints: srs.summarizeKnowledge(wrongRows),
          applied: applied.map((a) => {
            const info = roundsOf.get(a.question_id) || { rounds: [1], firstCorrect: null };
            // 回看历史时，显示这道题"当前"的下次复习时间（比留空有用得多）
            const q = repo.getQuestion(a.question_id);
            const daysToDue = q && q.state.reps > 0 && q.state.dueAt ? Math.round((q.state.dueAt - Date.now()) / 86400000) : null;
            return {
              questionId: a.question_id,
              finalCorrect: Boolean(a.correct),
              firstTryCorrect: info.firstCorrect,
              attempts: info.rounds.length,
              dueInDays: daysToDue,
              alreadyDue: daysToDue !== null && daysToDue <= 0,
            };
          }),
          needsRetry: s.phase !== 'done',
        },
        replay,
        session: { id: s.id, day: s.day, phase: s.phase, round: s.round },
      };
    },

    // ---------- 统计 ----------
    'stats:overview': () => ({
      ok: true,
      counts: repo.countQuestions(),
      knowledge: repo.knowledgeStats(),
      forecast: repo.forecast(),
      recent: repo.recentSessions(10),
    }),
    'stats:wrongBook': ({ limit = 200 } = {}) => ({ ok: true, items: repo.wrongBook(limit) }),

    // ---------- 设置 ----------
    'settings:get': () => {
      const s = store.get();
      return {
        ok: true,
        settings: {
          ...repo.allSettings(),
          baseUrl: s.baseUrl || model.DEFAULT_CONFIG.baseUrl,
          model: s.model || model.DEFAULT_CONFIG.model,
          visionModel: s.visionModel || '',
          provider: s.provider || 'openai-compatible',
          hasApiKey: Boolean(s.apiKey),
          apiKeyMasked: s.apiKey ? `${s.apiKey.slice(0, 4)}****${s.apiKey.slice(-4)}` : '',
          presets: Object.fromEntries(Object.entries(model.PRESETS).map(([k, v]) => [k, { label: v.label, canReadImages: v.canReadImages, baseUrl: v.baseUrl, model: v.model, visionModel: v.visionModel }])),
        },
      };
    },
    'settings:set': (patch) => {
      const { practice, ...rest } = patch;
      if (practice) {
        for (const [k, v] of Object.entries(practice)) repo.setSetting(k, v);
      }
      const allowed = ['baseUrl', 'model', 'visionModel', 'apiKey', 'provider', 'timeoutMs'];
      const toStore = {};
      for (const [k, v] of Object.entries(rest)) if (allowed.includes(k)) toStore[k] = v;
      if (Object.keys(toStore).length) store.set(toStore);
      return { ok: true };
    },
    'settings:test': async ({ vision = false } = {}) => {
      const r = await model.testConnection(modelConfig(), { vision });
      return { ok: true, result: r };
    },
    'settings:dataDir': () => ({ ok: true, dataDir, imagesDir }),

    // ---------- 文本导入（主路径：把题目文本直接粘进来） ----------
    /**
     * 只解析不入库，让用户先在界面上核对修改。
     * 这是"拍题录入"的主路径：图片由宿主读成文本，粘贴到这里。
     */
    'import:parseText': ({ text, answerKey }) => {
      const r = textparse.parseQuestionsFromText(text || '');
      // 录入时立刻用本地规则标上知识点（快且免费）。
      // 更贴切的考点名称可以在核对页点「自动补知识点」用模型再补一轮。
      for (const q of r.questions) {
        const local = knowledge.detectLocal(q.stem, q.options);
        if (local.length) q.knowledgePoints = local;
      }
      const warnings = [...r.warnings];
      const autoTagged = r.questions.filter((q) => (q.knowledgePoints || []).length).length;
      if (autoTagged) {
        warnings.push(`已自动识别出 ${autoTagged} 道题的知识点（基于语法规则，可在下方修改）。`);
      }
      // 可选：用户另外贴了答案表（"1-5 BCDAB" 这种）
      if (answerKey && String(answerKey).trim() !== '') {
        const map = textparse.parseAnswerKey(answerKey);
        if (map.size === 0) {
          warnings.push('答案表没能解析出内容，请检查格式（支持「1-5 BCDAB」「1.B 2.C」或纯字母串）。');
        } else {
          const res = textparse.applyAnswerKey(r.questions, map);
          if (res.unmatched.length) {
            warnings.push(`有 ${res.unmatched.length} 道题在答案表里找不到对应题号：${res.unmatched.slice(0, 10).join('、')}`);
          }
          warnings.push(`已从答案表补上 ${res.applied} 个答案。`);
        }
      }
      return {
        ok: true,
        questions: r.questions,
        warnings,
        stats: {
          parsed: r.questions.length,
          withAnswer: r.questions.filter((q) => q.answer).length,
          needAttention: r.questions.filter((q) => (q.issues || []).length > 0).length,
        },
      };
    },
    /** 解析结果核对后一键入库。 */
    'import:commit': ({ questions, onDuplicate = 'skip' }) =>
      actions['questions:save']({ questions, onDuplicate }),

    // ---------- 维护 ----------
    /**
     * 把到期的题目提前拉进今天（不改记忆强度与复习次数）。
     * 用途：用户白天想多练一会儿，或补做昨天漏掉的复习。
     * 刻意不叫"重置"：它不影响调度算法的学习结果，只是把到期时间提前。
     */
    'practice:pullDueForward': () => {
      const now = Date.now();
      const all = repo.listQuestions({ limit: 10000 });
      let moved = 0;
      for (const q of all) {
        if (q.state.reps > 0 && q.state.dueAt > now) {
          repo.raw.prepare('UPDATE questions SET due_at = ? WHERE id = ?').run(now - 1000, q.id);
          moved += 1;
        }
      }
      return { ok: true, moved, counts: repo.countQuestions() };
    },

    // ---------- 知识点自动识别 ----------
    /**
     * 给题目补知识点。本地规则立刻出结果（不花时间、不要 Key），
     * 配了文本模型再用它补充更贴切的考点名称。
     */
    'knowledge:autoTag': async ({ questions, useModel = true }) => {
      if (!Array.isArray(questions) || questions.length === 0) {
        return { ok: false, error: '没有要标注的题目' };
      }
      // 本地规则先铺一遍：即使模型不可用，也一定有标签
      const local = questions.map((q) => knowledge.detectLocal(q.stem || '', q.options || {}));
      let items = local.map((kp) => ({ knowledgePoints: kp }));
      let usedModel = false;
      const notes = [];

      if (useModel) {
        const full = repo.allSettings();
        const r = await model.detectKnowledgePoints(modelConfig(), questions);
        if (r.ok) {
          items = r.items;
          usedModel = r.usedModel;
          notes.push(...(r.notes || []));
        } else {
          notes.push(`模型标注失败：${r.error || '未知原因'}`);
        }
      } else {
        notes.push('只用了本地规则（未调用模型）。');
      }

      const tagged = items.filter((x) => x.knowledgePoints.length).length;
      return {
        ok: true,
        items,
        usedModel,
        notes,
        stats: { total: questions.length, tagged, untagged: questions.length - tagged },
      };
    },
    /** 给题库里已有的题补知识点（老数据用）。 */
    'knowledge:tagBank': async ({ limit = 200, overwrite = false } = {}) => {
      const all = repo.listQuestions({ limit });
      const need = overwrite ? all : all.filter((q) => !q.knowledgePoints || q.knowledgePoints.length === 0);
      if (need.length === 0) return { ok: true, updated: 0, message: '所有题目都已标注过知识点。' };

      let items = need.map((q) => ({ knowledgePoints: knowledge.detectLocal(q.stem, q.options) }));
      let usedModel = false;
      const notes = [];
      try {
        const r = await model.detectKnowledgePoints(modelConfig(), need);
        if (r.ok) {
          items = r.items;
          usedModel = r.usedModel;
          notes.push(...(r.notes || []));
        }
      } catch (e) {
        notes.push(`模型标注失败（${e.message}），本次只用本地规则。`);
      }

      let updated = 0;
      need.forEach((q, i) => {
        const kp = items[i] ? items[i].knowledgePoints : [];
        if (kp.length) {
          repo.updateQuestion(q.id, { knowledgePoints: kp });
          updated += 1;
        }
      });
      return {
        ok: true,
        updated,
        total: all.length,
        checked: need.length,
        usedModel,
        notes,
        untagged: need.length - updated,
      };
    },

    /**
     * 词义题逐项释义：每个选项的意思 + 本题语境下的含义 + 熟词生义提醒。
     *
     * 三级来源，按可靠性排序：
     *   1. 本地释义库（我维护的，含熟词生义与短语释疑）—— 立刻返回、零成本、不编造
     *   2. 文本模型 —— 只用来补本地没有的词条
     *   3. 都没有 —— 明确告知未收录，让用户去问，而不是编一个意思
     */
    'knowledge:explainWords': async ({ questionId, useModel = true }) => {
      const q = repo.getQuestion(Number(questionId));
      if (!q) return { ok: false, error: '题目不存在' };

      const local = glossary.glossQuestion(q);
      let gloss = local;
      let usedModel = false;

      const missingWords = local.missing.map((m) => m.text);
      // 本地未收录时要**说清是哪些词** —— 用户需要据此决定去问哪个词
      let note = missingWords.length
        ? `本地释义库未收录：${missingWords.join('、')}。可配一个文本模型自动补，或点「复制内容发给我」来问。`
        : '';

      // 本地未完全覆盖时，才动用模型补缺
      const canCall = useModel && local.missing.length > 0;
      if (canCall) {
        try {
          const r = await model.explainWords(modelConfig(), q);
          if (r.ok && r.usedModel && r.gloss && r.gloss.options) {
            usedModel = true;
            // 合并：本地词条优先（更可靠），模型只补本地没有的
            const merged = { options: { ...local.options }, note: '' };
            for (const [L, fromModel] of Object.entries(r.gloss.options)) {
              const cur = merged.options[L];
              if (cur && cur.found) continue; // 本地已有，保留
              merged.options[L] = {
                word: cur ? cur.word : String(q.options[L] || ''),
                found: Boolean(fromModel.gloss || fromModel.here),
                pos: '',
                gloss: fromModel.gloss || '',
                senses: [],
                rare: fromModel.here || '',
                note: fromModel.note || '',
                phrase: '',
                here: fromModel.here || '',
              };
            }
            gloss = merged;
            const stillMissing = Object.values(merged.options).filter((o) => !o.found).map((o) => o.word);
            note = stillMissing.length
              ? `以下词条本地与模型都没给出释义，需要你确认：${stillMissing.join('、')}`
              : '';
            if (r.gloss.sentence) gloss.sentence = r.gloss.sentence;
          } else if (r.note) {
            note = `${note}（模型补充失败：${r.note}）`;
          }
        } catch (e) {
          note = `${note}（模型补充失败：${e.message}）`;
        }
      } else if (missingWords.length && !useModel) {
        note = `本地释义库未收录：${missingWords.join('、')}。已按你的设置跳过模型补充。`;
      }

      const covered = Object.values(gloss.options).filter((o) => o.found).length;
      const total = Object.keys(q.options || {}).length;
      return {
        ok: true,
        questionId: q.id,
        isVocabulary: knowledge.isVocabularyQuestion(q.stem, q.options),
        usedModel,
        source: usedModel ? 'local+model' : 'local',
        gloss,
        covered,
        total,
        note,
      };
    },

    /* ---------------- 问答（对话窗口） ---------------- */
    /**
     * 提问。会自动带上题目上下文（题干、选项、答案、知识点、你的作答历史），
     * 所以你可以直接问"为什么不是 B"，不用把题目再抄一遍。
     */
    'chat:ask': async ({ threadId, questionId, message, useContext = true }) => {
      const text = String(message || '').trim();
      if (!text) return { ok: false, error: '请先输入问题' };

      const thread = repo.ensureThread({ questionId: questionId || null });
      const tid = threadId ? Number(threadId) : thread.id;

      // 收集上下文
      let contextText = '';
      let contextMeta = null;
      if (useContext && questionId) {
        const q = repo.getQuestion(Number(questionId));
        if (q) {
          const history = repo.attemptHistory(q.id, 6);
          contextMeta = {
            questionId: q.id,
            stem: q.stem,
            options: q.options,
            answer: q.answer,
            explanation: q.explanation,
            knowledgePoints: q.knowledgePoints,
            attempts: history,
          };
          contextText = [
            '【当前题目】',
            `题干：${q.stem}`,
            `选项：${Object.entries(q.options).map(([k, v]) => `${k}. ${v}`).join('  ')}`,
            `正确答案：${q.answer}. ${q.options[q.answer] || ''}`,
            q.explanation ? `已有解析：${q.explanation}` : '',
            q.knowledgePoints.length ? `知识点：${q.knowledgePoints.join('、')}` : '',
            history.length
              ? `学生作答记录（最近在前）：${history
                  .map((h) => `${h.day || ''} 第${h.round}轮 选${h.picked || '未答'}${h.correct ? '（对）' : '（错）'}`)
                  .join('；')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
      }

      const prior = repo.threadMessages(tid, 40);
      const sys = [
        '你是一位耐心的英语老师，正在帮学生解决单选题的疑问。',
        '回答要求：',
        '1. 用简体中文，直接回答问题，不要客套。',
        '2. 讲清语法道理，指出干扰项为什么错。',
        '3. 如果学生反复做错同一题，不要只重复解析，要换个角度讲（比如给同类例句、指出他的错误模式）。',
        '4. 只依据题目本身与通用语法知识回答，不要编造这道题的出处。',
      ].join('\n');

      const messages = [{ role: 'system', content: sys }];
      if (contextText) messages.push({ role: 'system', content: contextText });
      for (const m of prior.slice(-12)) {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      }
      messages.push({ role: 'user', content: text });

      repo.addChatMessage(tid, 'user', text, {});

      const cfg = modelConfig();
      const canCall = Boolean(cfg.apiKey) || /localhost|127\.0\.0\.1/.test(cfg.baseUrl || '');
      if (!canCall) {
        const hint = '（未配置文本模型，我暂时无法在软件里回答。点下面的「复制问题」，把它发给我，我来解答。）';
        const saved = repo.addChatMessage(tid, 'assistant', hint, { context: contextText, error: 1 });
        return { ok: false, code: 'NO_MODEL', error: '未配置文本模型', threadId: tid, message: saved, context: contextText };
      }

      try {
        const reply = await model.chat(cfg, messages, { temperature: 0.3 });
        const saved = repo.addChatMessage(tid, 'assistant', reply, { context: contextText });
        return { ok: true, threadId: tid, reply, message: saved, context: contextText };
      } catch (e) {
        const saved = repo.addChatMessage(tid, 'assistant', `回答失败：${e.message}`, { context: contextText, error: 1 });
        return { ok: false, error: e.message, threadId: tid, message: saved, context: contextText };
      }
    },
    'chat:threads': ({ limit = 30 } = {}) => ({ ok: true, threads: repo.listThreads(limit) }),
    'chat:messages': ({ threadId }) => {
      const t = repo.raw.prepare('SELECT * FROM chat_threads WHERE id = ?').get(Number(threadId));
      if (!t) return { ok: false, error: '这个对话不存在' };
      return {
        ok: true,
        thread: { id: t.id, title: t.title, questionId: t.question_id },
        messages: repo.threadMessages(Number(threadId)),
      };
    },
    'chat:ensureThread': ({ questionId }) => ({ ok: true, thread: repo.ensureThread({ questionId: questionId || null }) }),
    'chat:deleteThread': ({ threadId }) => {
      repo.deleteThread(Number(threadId));
      return { ok: true };
    },

    /**
     * 「这道题我第二次做错了」的讲评材料：
     * 知识点 + 我前几次分别选了什么（这是最有说服力的材料）。
     */
    'teach:mistake': ({ questionId, sessionId }) => {
      const q = repo.getQuestion(Number(questionId));
      if (!q) return { ok: false, error: '题目不存在' };
      const history = repo.attemptHistory(q.id, 10);
      const sessionWrong = sessionId ? repo.sessionWrongCount(Number(sessionId), q.id) : 0;
      const totalWrong = history.filter((h) => !h.correct).length;
      const wrongAttempts = history.filter((h) => !h.correct).slice(0, 4);

      return {
        ok: true,
        question: {
          id: q.id,
          stem: q.stem,
          options: q.options,
          answer: q.answer,
          answerText: q.options[q.answer] || '',
          explanation: q.explanation,
          knowledgePoints: q.knowledgePoints,
        },
        /** 这是第几次错（累计） */
        wrongCount: totalWrong,
        sessionWrong,
        /** 前几次错的答案，最近的在前 */
        wrongAttempts: wrongAttempts.map((h) => ({
          picked: h.picked,
          pickedText: q.options[h.picked] || '',
          day: h.day,
          round: h.round,
        })),
        history: history.map((h) => ({
          ...h,
          pickedText: q.options[h.picked] || '',
        })),
        /** 累计错 2 次及以上才需要展开讲评 */
        needsTeaching: totalWrong >= 2,
      };
    },

    // ---------- 分组（按单元组织题目） ----------
    'groups:list': () => ({ ok: true, ...repo.listGroups() }),
    'groups:create': ({ name, note }) => {
      const r = repo.createGroup({ name, note });
      return r.ok ? { ok: true, id: r.id, groups: repo.listGroups().groups } : { ok: false, error: r.error, id: r.id };
    },
    'groups:rename': ({ id, name, note }) => {
      const r = repo.renameGroup(Number(id), name, note);
      return r.ok ? { ok: true, groups: repo.listGroups().groups } : { ok: false, error: r.error };
    },
    'groups:delete': ({ id }) => {
      const r = repo.deleteGroup(Number(id));
      return { ok: true, ...r, groups: repo.listGroups().groups };
    },
    'groups:assign': ({ questionIds, groupId }) => {
      const r = repo.assignQuestionsToGroup(questionIds, groupId);
      return r.error ? { ok: false, error: r.error } : { ok: true, ...r };
    },
    /** 某分组的题目列表（按单元刷题/查看用）。 */
    'groups:questions': ({ groupId, limit = 500 }) => {
      const all = repo.listQuestions({ limit: 10000 });
      const gid = groupId === null || groupId === undefined ? null : Number(groupId);
      const questions = all.filter((q) => (gid === null ? q.groupId === null : q.groupId === gid)).slice(0, limit);
      return { ok: true, questions };
    },

    // ---------- 考前集训（一周内把错题过一遍） ----------
    /**
     * 生成集训计划。**只生成计划，不改数据** —— 用户可以先看"哪天复习多少题"。
     */
    'sprint:plan': ({ days = 7, perDayCap = 60 } = {}) => {
      const p = repo.planSprint({ days, perDayCap });
      return { ok: true, ...p, status: repo.sprintStatus() };
    },
    /** 应用计划：把错题的到期时间铺到计划的每一天。 */
    'sprint:start': ({ plan }) => {
      const r = repo.applySprint(plan);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, ...r, status: repo.sprintStatus(), counts: repo.countQuestions() };
    },
    'sprint:status': () => ({ ok: true, ...repo.sprintStatus(), counts: repo.countQuestions() }),
    /** 一键生成并应用（题目不多时最省事）。 */
    'sprint:quickStart': ({ days = 7, perDayCap = 60 } = {}) => {
      const p = repo.planSprint({ days, perDayCap });
      if (p.empty) return { ok: true, empty: true, message: p.message };
      const r = repo.applySprint(p.plan);
      return {
        ok: true,
        empty: false,
        plan: p,
        applied: r,
        status: repo.sprintStatus(),
        counts: repo.countQuestions(),
        message:
          `已把 ${r.moved} 道错题排进 ${r.days} 天：每天 ${p.perDayCounts.join('/')} 道。` +
          `今天就有 ${p.plan[0]?.count ?? 0} 道可以先做，回到「今日练习」开始即可。`,
      };
    },

    // ---------- 示例数据 ----------
    'demo:seed': () => {
      const samples = [
        { stem: 'He ____ to school by bus every day.', options: { A: 'go', B: 'goes', C: 'going', D: 'gone' }, answer: 'B', explanation: '主语 He 为第三人称单数，一般现在时动词加 -es。', knowledgePoints: ['一般现在时', '主谓一致'], difficulty: 'easy' },
        { stem: 'She is good ____ playing the piano.', options: { A: 'at', B: 'in', C: 'on', D: 'for' }, answer: 'A', explanation: 'be good at 是固定搭配，表示"擅长"。', knowledgePoints: ['介词搭配', '固定短语'], difficulty: 'easy' },
        { stem: 'If I ____ you, I would take the job.', options: { A: 'am', B: 'was', C: 'were', D: 'be' }, answer: 'C', explanation: '虚拟语气中，与现在事实相反用 were。', knowledgePoints: ['虚拟语气'], difficulty: 'hard' },
        { stem: 'The book ____ by Mark Twain in 1876.', options: { A: 'writes', B: 'wrote', C: 'is written', D: 'was written' }, answer: 'D', explanation: '书是被写的，且时间是过去，故用一般过去时被动语态。', knowledgePoints: ['被动语态', '一般过去时'], difficulty: 'medium' },
        { stem: 'I have lived here ____ 2010.', options: { A: 'for', B: 'since', C: 'from', D: 'in' }, answer: 'B', explanation: 'since 后接时间点，for 后接时间段。', knowledgePoints: ['现在完成时', '介词搭配'], difficulty: 'medium' },
        { stem: 'Neither Tom nor his friends ____ interested in the film.', options: { A: 'is', B: 'are', C: 'was', D: 'has been' }, answer: 'B', explanation: 'neither...nor 遵循就近原则，靠近 friends 用 are。', knowledgePoints: ['主谓一致'], difficulty: 'hard' },
      ];
      const res = actions['questions:save']({ questions: samples, onDuplicate: 'skip' });
      return { ok: true, ...res };
    },
  };

  function localDayLabel(ts = Date.now()) {
    const d = new Date(ts);
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 周${week}`;
  }

  return {
    actions,
    repo,
    store,
    dataDir,
    imagesDir,
    srs,
    /** 统一入口：任何外壳都通过它调用，便于统一错误处理与日志。 */
    async invoke(channel, payload) {
      const fn = actions[channel];
      if (!fn) return { ok: false, error: `未知操作：${channel}` };
      try {
        const r = await fn(payload ?? {});
        return r === undefined ? { ok: true } : r;
      } catch (e) {
        return { ok: false, error: e.message, stack: e.stack };
      }
    },
    close() {
      repo.close();
    },
  };
}

module.exports = { createHost, createStore };
