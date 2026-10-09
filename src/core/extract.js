'use strict';

/**
 * 读取解析层：把视觉模型的原始输出，变成结构化的题目对象。
 *
 * 为什么单独一层：模型读图必然有错字、漏项、格式漂移。
 * 如果解析写得太脆（比如要求输出恰好是某个 JSON），用户每拍一张都要手动返工。
 * 这里的策略是"尽量抽出能用的题 + 把不确定的地方明确标出来让用户改"。
 *
 * 纯函数，不依赖网络与数据库，因此可完整单测。
 */

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** 抽取 JSON：容忍代码块包裹、前后闲聊、尾随逗号。 */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const body = s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** 从纯文本里找答案字母：支持「答案：B」「正确答案是 C」「Answer: D」等写法。 */
function parseAnswerLetter(text) {
  if (!text) return '';
  const s = String(text).trim();
  const patterns = [
    // 中文里 "正确答案是 C" / "答案选 B" 这类连接词很常见，必须容忍
    /(?:正确答案|参考答案|答案|answer|key)\s*(?:是|为|选|:|：|=)?\s*\(?([A-F])\)?(?![a-zA-Z])/i,
    /^\s*\(?([A-F])\)?[.、)．]?\s*$/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1].toUpperCase();
  }
  return '';
}

/**
 * 规范化一道题。
 * 关键行为：如果答案字母指向的选项不存在（模型标错字母），
 * 就尝试用答案文本反查选项，并把这件事记进 issues 让用户确认。
 */
function normalizeQuestion(raw, index = 0) {
  const issues = [];
  const stem = String(raw?.stem ?? raw?.question ?? raw?.题干 ?? '').trim();
  if (!stem) issues.push('缺少题干');

  // 选项：可能是 {A:..,B:..} 或 [{letter,text}] 或数组
  const options = {};
  const rawOptions = raw?.options ?? raw?.choices ?? raw?.选项;
  if (Array.isArray(rawOptions)) {
    rawOptions.forEach((item, i) => {
      const letter = (item?.letter || item?.key || LETTERS[i]).toString().trim().toUpperCase().replace(/[^A-F]/g, '');
      const text = String(item?.text ?? item?.value ?? item ?? '').trim();
      if (letter && text) options[letter] = text;
    });
  } else if (rawOptions && typeof rawOptions === 'object') {
    for (const [k, v] of Object.entries(rawOptions)) {
      const letter = k.trim().toUpperCase().replace(/[^A-F]/g, '');
      const text = String(v ?? '').trim();
      if (letter && text) options[letter] = text;
    }
  }
  if (Object.keys(options).length < 2) issues.push('选项少于 2 个，请补全');

  // 如果选项里混进了「A. xxx」这样带前缀的文本，剥掉前缀
  for (const k of Object.keys(options)) {
    options[k] = options[k].replace(new RegExp(`^${k}\\s*[.、)．]\\s*`, 'i'), '').trim();
  }

  // 答案：先按选项原文匹配（模型常把答案写成选项内容），再按字母解析。
  // 顺序很重要 —— 若先做字母解析，"goes" 会被抠出首字母 O 这种荒唐结果。
  const rawAnswer = String(raw?.answer ?? raw?.答案 ?? '').trim();
  const answerTextIndex = new Map();
  for (const [letter, text] of Object.entries(options)) {
    if (text) answerTextIndex.set(text.trim().toLowerCase(), letter);
  }

  let answer = '';
  if (rawAnswer) {
    const hit = answerTextIndex.get(rawAnswer.toLowerCase());
    if (hit) {
      answer = hit;
      // 字母本来就对得上就不必打扰用户
      if (rawAnswer.toUpperCase() !== hit) {
        issues.push(`答案写成了选项内容「${rawAnswer}」，已修正为 ${hit}`);
      }
    } else {
      answer = rawAnswer.toUpperCase();
      if (!/^[A-F]$/.test(answer)) answer = parseAnswerLetter(rawAnswer);
    }
  }

  if (!answer) {
    issues.push('未识别到答案，请手动选择');
  } else if (!options[answer]) {
    if (Object.keys(options).length > 0) issues.push(`答案 ${answer} 不在选项中，请确认`);
    answer = '';
  }

  // 知识点：数组或字符串都收
  let knowledgePoints = raw?.knowledgePoints ?? raw?.knowledge_points ?? raw?.知识点 ?? [];
  if (typeof knowledgePoints === 'string') {
    knowledgePoints = knowledgePoints.split(/[,，、;；\/]/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(knowledgePoints)) knowledgePoints = [];
  knowledgePoints = [...new Set(knowledgePoints.map((s) => String(s).trim()).filter(Boolean))];

  const confidence = Number.isFinite(Number(raw?.confidence)) ? Number(raw.confidence) : null;

  return {
    tempId: `t${index}_${Math.random().toString(36).slice(2, 8)}`,
    stem,
    options,
    answer,
    explanation: String(raw?.explanation ?? raw?.解析 ?? '').trim(),
    knowledgePoints,
    difficulty: ['easy', 'medium', 'hard'].includes(raw?.difficulty) ? raw.difficulty : 'medium',
    sourceNote: String(raw?.sourceNote ?? raw?.出处 ?? '').trim(),
    answerInSource: Boolean(raw?.answerInSource ?? raw?.答案在图上),
    confidence,
    issues,
  };
}

/**
 * 主入口：模型输出 -> 题目数组。
 * 返回 { questions, warnings, raw }，warnings 汇总需要人工确认的点，界面上要显眼提示。
 */
function parseExtraction(rawText) {
  const warnings = [];
  const json = extractJson(rawText);

  let list = [];
  if (json && Array.isArray(json.questions)) list = json.questions;
  else if (json && Array.isArray(json.题目)) list = json.题目;
  else if (Array.isArray(json)) list = json;
  else if (json && (json.stem || json.question || json.题干)) list = [json];

  if (list.length === 0) {
    warnings.push('模型输出里没有找到题目结构，请检查图片是否清晰，或改用手动录入。');
    return { questions: [], warnings, raw: rawText };
  }

  const questions = list.map((q, i) => normalizeQuestion(q, i));

  for (const q of questions) {
    for (const issue of q.issues) warnings.push(`第 ${questions.indexOf(q) + 1} 题：${issue}`);
  }
  const lowConfidence = questions.filter((q) => q.confidence !== null && q.confidence < 0.7);
  if (lowConfidence.length) warnings.push(`${lowConfidence.length} 道题模型自评置信度偏低，建议重点核对。`);

  return { questions, warnings, raw: rawText };
}

/** 生成读图提示词。answerInSource 用于"答案就印在卷面上"的情况。 */
function buildVisionPrompt(opts = {}) {
  const { answerInSource = true, language = 'zh' } = opts;
  const answerHint = answerInSource
    ? '卷面上可能有印刷的答案标记（如答案栏、圈出的选项、页脚答案表）。如果找到，填进 answer；不要靠猜。'
    : '卷面上没有答案，answer 留空字符串，只负责把题干和选项抄准。';

  return [
    '你是一个试卷录入助手。用户会给你一张英语单选题的照片或截图。',
    '任务：把图中的题目**逐字**转写成结构化数据。不要翻译，不要改写，不要补全缺失内容。',
    '',
    '严格要求：',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释。',
    '2. 题干要完整，包括空格、下划线（如 ____）、括号里的词。',
    '3. 选项必须是 4 个（A/B/C/D）；如果图里只有 3 个或识别不全，就有几个写几个，不要编造。',
    '4. 看不清的字符写成 [看不清]，不要猜测填词。',
    `5. ${answerHint}`,
    '6. knowledgePoints 填这道题考的知识点（中文短标签，如「一般过去时」「介词搭配」「固定短语」），最多 3 个。',
    '7. explanation 用中文写一句解析，说明为什么选这个答案。',
    '8. confidence 填 0~1，表示你对本次识别的把握。',
    '',
    '输出格式：',
    JSON.stringify(
      {
        questions: [
          {
            stem: 'He ____ to school every day.',
            options: { A: 'go', B: 'goes', C: 'going', D: 'gone' },
            answer: 'B',
            explanation: '主语第三人称单数，一般现在时用 goes。',
            knowledgePoints: ['一般现在时', '主谓一致'],
            difficulty: 'easy',
            answerInSource: true,
            confidence: 0.95,
          },
        ],
      },
      null,
      2,
    ),
    '',
    `界面语言：${language === 'zh' ? '中文' : 'English'}`,
  ].join('\n');
}

/** 生成"补全题干/知识点"的提示词：用于用户只给了文字、还没答案的情况。 */
function buildAnalysisPrompt(question) {
  const optionsText = Object.entries(question.options || {})
    .map(([k, v]) => `${k}. ${v}`)
    .join('\n');
  return [
    '你是英语老师。下面是一道英语单选题，请判断正确答案并拆解知识点。',
    '只输出一个 JSON 对象，不要代码块。',
    '',
    `题干：${question.stem}`,
    '选项：',
    optionsText,
    '',
    '输出格式：',
    JSON.stringify({
      answer: 'B',
      explanation: '中文解析，一到两句话。',
      knowledgePoints: ['知识点1', '知识点2'],
      difficulty: 'easy|medium|hard',
    }),
    '',
    '如果题目本身有语法错误或信息不全，在 explanation 里说明，不要硬答。',
  ].join('\n');
}

/** 把识别结果转成入库前的校验结论：哪些能存，哪些必须人工改。 */
function validateForSave(question) {
  const errors = [];
  const warns = [];
  if (!question.stem || question.stem.trim().length < 2) errors.push('题干不能为空或过短');
  const opts = Object.keys(question.options || {});
  if (opts.length < 2) errors.push('至少需要 2 个选项');
  if (!question.answer) errors.push('必须指定答案');
  else if (!question.options?.[question.answer]) errors.push(`答案 ${question.answer} 不在选项中`);
  if (!question.knowledgePoints || question.knowledgePoints.length === 0) warns.push('未标注知识点，将无法按知识点统计薄弱项');
  if (opts.length > 0 && opts.length < 4) warns.push(`只有 ${opts.length} 个选项，确认题目本身是否如此`);
  if (/\[看不清\]/.test(question.stem) || Object.values(question.options || {}).some((v) => /\[看不清\]/.test(v))) {
    warns.push('存在未识别字符，请核对');
  }
  return { ok: errors.length === 0, errors, warns };
}

/** 生成题干指纹，用于查重（同一道题反复拍照录入时提示重复）。 */
function stemFingerprint(stem) {
  return String(stem)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?"'`()[\]{}]/g, '')
    .slice(0, 200);
}

module.exports = {
  LETTERS,
  extractJson,
  parseAnswerLetter,
  normalizeQuestion,
  parseExtraction,
  buildVisionPrompt,
  buildAnalysisPrompt,
  validateForSave,
  stemFingerprint,
};
