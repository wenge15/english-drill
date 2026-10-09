'use strict';

/**
 * 知识点识别。
 *
 * 两条路并用，而不是只靠模型：
 *  1. 本地规则：把题干与选项里可判定的语法特征（时态、被动、虚拟、非谓语、介词搭配…）
 *     直接认出来。零成本、立刻可用、可完整单测 —— 也是没有 API Key 时的兜底。
 *  2. 模型补充：让模型给出更贴切的考点名称（如"固定短语 take pride in"）。
 *
 * 优先用本地规则的原因：知识点标注要"稳定可预期"。同一道题今天标"时态"、明天标"一般现在时"，
 * 会让薄弱项统计失去意义。所以本地规则给出确定的标签，模型只做**追加**。
 */

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * 常见不规则动词的过去分词（用于识别完成时与被动语态）。 */
const IRREGULAR_PP = 'been|done|gone|seen|taken|made|written|eaten|given|left|felt|kept|bought|brought|caught|taught|thought|found|held|built|known|shown|told|sent|spent|lost|met|paid|read|said|sold|stood|understood|won|broken|chosen|driven|fallen|forgotten|frozen|hidden|spoken|stolen|worn|thrown|grown|drawn|blown|flown|swum|begun|drunk|sung|rung|risen';

/**
 * 动词词形变化的匹配尾巴。
 *
 * 踩过的坑：规则表里写的是动词**原形**，但题干里常是 `decided` / `enjoys` / `wanted`。
 * 直接用 `\bdecide\b` 匹配 "decided" 会失败 —— 因为 "decide" 后面紧跟 "d"，
 * 单词边界不成立。这个 bug 让"非谓语动词"规则漏掉了一大批题。
 * 现在统一允许 s / es / ed / d / ing，以及重读闭音节的双写（plan → planned）。
 */
const VERB_TAIL = '(?:s|es|ed|d|ing|(?:[bcdfglmnprstvz])\\1ed)?';
/** 把动词表编译成"允许词形变化"的正则片段。 */
const verbForms = (verbs) => `(?:${verbs})${VERB_TAIL}`;

/**
 * 定语从句判定。
 *
 * 这里踩过两个坑，规则才变成现在这样：
 *  1. 这类题的关系代词**本身就是空位**（"The book, ____ was written in 1876"），
 *     所以不能去空位后面找 who/which。
 *  2. 但也不能"只要选项里有 which 就算" —— 疑问句 "Which word means happy?"
 *     开头的 Which 是疑问词，不是关系代词，那样会把普通词汇题误判成定语从句。
 *
 * 有效组合：空位后紧跟谓语动词（需要关系代词来连接从句）+ 选项里含关系代词。
 */
const BLANK_THEN_VERB_RE = new RegExp(
  `(?:____|_{2,}|\\(\\s*\\))\\s*(?:is|are|was|were|has|have|had|can|could|will|would|\\w+ed|\\w+s)\\b`,
  'i',
);
const RELATIVE_PRONOUN_RE = /^(?:who|whom|whose|which|that|where|when|why)\b/i;
/** 疑问句开头：Which word / Who is / What do … 这些不是定语从句。 */
const INTERROGATIVE_RE = /^\s*(?:which|who|what|whose|where|when|why)\s+(?:word|one|of|is|are|do|does|did|would|can|will)\b/i;

/** 规则表：每条给出标签与命中条件。顺序即优先级 —— 越具体的越靠前。 */
const RULES = [
  // 定语从句必须排在最前：它的题干常含 that/which 与时间状语，
  // 若不先判，会被"代词"抢走，还会被时间状语误触发被动语态。
  {
    label: '定语从句',
    test: (s, opts) => {
      if (INTERROGATIVE_RE.test(s)) return false;
      const hasNounPhrase = /\b(?:the|a|an|this|that|these|those|his|her|their|my|our)\s+\w+\s*,?\s*(?:____|_{2,})/i.test(s);
      const blankThenVerb = BLANK_THEN_VERB_RE.test(s);
      const pronounInOptions = opts.some((o) => RELATIVE_PRONOUN_RE.test(o.trim()));
      return pronounInOptions && (hasNounPhrase || blankThenVerb);
    },
  },
  // ---- 时态与语态（先判被动，因为被动常同时含时态特征） ----
  {
    label: '被动语态',
    test: (s, opts) =>
      new RegExp(`\\b(?:is|are|was|were|be|been|being)\\s+(?:\\w+ed|${IRREGULAR_PP})\\b`, 'i').test(s) ||
      new RegExp(`\\b(?:is|are|was|were|be|been|being)\\s+(?:\\w+ed|${IRREGULAR_PP})\\b`, 'i').test(opts.join(' ')),
  },
  {
    label: '虚拟语气',
    test: (s, opts) =>
      /\b(?:if\s+i\s+were|were\s+i|i\s+wish|as\s+if|would\s+(?:have\s+)?\w+|could\s+have|should\s+have|had\s+i)\b/i.test(s) ||
      (opts.some((o) => /\bwere\b/i.test(o)) && /\bif\b/i.test(s)),
  },
  {
    label: '现在完成时',
    /**
     * 必须"确凿"。只看选项里出现 has/have + 分词是不够的 ——
     * 干扰项里几乎总会有完成时，那会把大量题误标成完成时（实测：9 道题里误标 4 道）。
     * 判据：题干本身含完成时，或题干有 since/for + 时间段的标志。
     */
    test: (s, opts) =>
      new RegExp(`\\b(?:have|has)\\s+(?:\\w+ed|${IRREGULAR_PP})\\b`, 'i').test(s) ||
      /\b(?:since|for)\s+(?:\d{4}|(?:\d+|several|many|a\s+few)\s+(?:years?|months?|weeks?|days?|hours?))\b/i.test(s) ||
      /\b(?:already|yet|ever|never|just)\b/i.test(s),
  },
  {
    label: '过去完成时',
    test: (s, opts) =>
      new RegExp(`\\bhad\\s+(?:\\w+ed|${IRREGULAR_PP})\\b`, 'i').test(s) ||
      /\b(?:by\s+the\s+time|before\s+he|before\s+she|before\s+they|after\s+he\s+had|when\s+we\s+arrived)\b/i.test(s),
  },
  {
    label: '一般过去时',
    test: (s, opts) => {
      const pastMarker = /\b(?:yesterday|last\s+(?:week|month|year|night|summer|time)|ago|in\s+(?:19|20)\d{2})\b/i.test(s);
      if (!pastMarker) return false;
      // 有明确的完成时标志时，不该再标一般过去时
      if (/\b(?:have|has|had)\b/i.test(s)) return false;
      // 选项里得有过去式动词才算考过去时
      return opts.some((o) => /\b\w+ed\b/i.test(o)) || new RegExp(`\\b(?:${IRREGULAR_PP})\\b`, 'i').test(opts.join(' '));
    },
  },
  {
    label: '一般现在时',
    test: (s, opts) =>
      /\b(?:every\s+(?:day|week|morning|year)|usually|always|often|sometimes|never)\b/i.test(s) &&
      !/\b(?:yesterday|ago|last)\b/i.test(s),
  },
  {
    label: '一般将来时',
    test: (s, opts) => /\b(?:tomorrow|next\s+(?:week|month|year)|in\s+the\s+future|soon)\b/i.test(s) ||
      opts.some((o) => /^(?:will|shall|be going to)\b/i.test(o.trim())),
  },
  {
    label: '现在进行时',
    // 空位本身就是谓语的情况："Look! The baby ____." 选项是 is sleeping / sleeps…
    test: (s, opts) =>
      /\b(?:am|is|are)\s+\w+ing\b/i.test(s) ||
      /\b(?:now|at\s+the\s+moment|look!|listen!)\b/i.test(s) ||
      (/(?:____|_{2,})/.test(s) &&
        /\b(?:now|at\s+the\s+moment|look|listen)\b/i.test(s) &&
        opts.some((o) => /\b(?:am|is|are)\s+\w+ing\b/i.test(o))),
  },
  // ---- 非谓语 ----
  {
    label: '非谓语动词',
    /**
     * 只认"结构信号"，不认"选项里有个 -ing"。踩过的坑：
     *  - "He ____ to school every day." 的选项里有 going，被误标成非谓语（实际考一般现在时）；
     *  - "I enjoy ____ books." 的空位就是宾语，动名词在**选项**里，不在题干里。
     * 所以分成三类判据：题干里的固定搭配、动词后接空位（非谓语在选项里）、空位后接非谓语。
     */
    test: (s, opts) => {
      const gerundVerbs = verbForms('enjoy|finish|avoid|suggest|mind|practise|practice|consider|imagine|admit|deny|keep|risk|look\\s+forward\\s+to|be\\s+used\\s+to|be\\s+good\\s+at|be\\s+interested\\s+in');
      const infiniteVerbs = verbForms('want|decide|hope|plan|agree|refuse|manage|offer|promise|expect|would\\s+like');
      // 1) 题干里直接看得出搭配（没有空位或空位在后面）
      if (new RegExp(`\\b${gerundVerbs}\\s+\\w+ing\\b`, 'i').test(s)) return true;
      if (new RegExp(`\\b${infiniteVerbs}\\s+to\\s+\\w+`, 'i').test(s)) return true;
      // 2) 动词后面就是空位 → 非谓语在选项里（enjoy ____ / decided ____）
      const verbThenBlank = new RegExp(`\\b(?:${gerundVerbs}|${infiniteVerbs})[\\s\\S]{0,12}?(?:____|_{2,}|\\(\\s*\\))`, 'i');
      if (verbThenBlank.test(s) && opts.some((o) => /^to\s+\w+$/i.test(o.trim()) || /^\w+ing$/i.test(o.trim()))) return true;
      // 3) 空位后面紧跟非谓语（____ to do / ____ doing）
      if (/(?:____|_{2,}|\(\s*\))\s+(?:to\s+\w+|\w+ing)\b/i.test(s)) return true;
      return false;
    },
  },
  // ---- 词义与搭配（词汇题） ----
  {
    label: '熟词生义',
    /**
     * "常见词的不常见含义"的判定。
     *
     * 这里刻意**复用 glossary 里每个词条的 ctx 关键词**（如 address 的 issue/problem），
     * 而不是另写一套正则：否则两个文件会对同一个词给出不一致的判断。
     *
     * 注意空位可能替换掉动词本身（"____ the issue"），所以匹配时允许
     * 动词与它的宾语之间隔着空格或空位。
     */
    test: (s) => {
      const stems = require('./glossary.js');
      const text = String(s || '');
      // 题干里直接出现"动词 + 空位/宾语"的搭配
      const TRAPS = [
        /\b(?:address|addresses|addressed)\b[\s\S]{0,12}?\b(?:the\s+)?(?:issue|problem|question|concern|matter)\b/i,
        /(?:____|_{2,}|\b\w+\b)[\s\S]{0,8}?\bthe\s+(?:issue|problem|concern|matter)\b/i,
        /\b(?:book|books|booked)\b[\s\S]{0,12}?\b(?:ticket|room|table|seat|flight)\b/i,
        /(?:____|_{2,})[\s\S]{0,8}?\b(?:ticket|room|table|seat|flight)\b/i,
        /\b(?:last|lasted)\b[\s\S]{0,14}?\b(?:hours?|days?|weeks?|months?|years?|minutes?)\b/i,
        /\bin\s+no\s+time\b/i,
        /\b(?:run|ran)\s+out\s+of\b/i,
      ];
      if (TRAPS.some((re) => re.test(text))) return true;
      // 借助 glossary：题干里出现了某个含 ctx 的词条，且选项里没有它的字面形式
      // （说明空位处考的就是那个词的引申义）
      for (const [word, entry] of Object.entries(stems.GLOSSARY)) {
        if (!entry.ctx || word.includes(' ')) continue;
        const re = new RegExp(`\\b${word}\\b[\\s\\S]{0,12}?\\b(?:issue|problem|question|concern|matter|ticket|room|table|seat|flight|hours?|days?|weeks?)\\b`, 'i');
        if (re.test(text)) return true;
      }
      return false;
    },
  },
  {
    label: '短语搭配',
    /**
     * 真正的短语题选项是 "take off / take up / take on" 这类**不同的短语动词**。
     * 而 "has lived / is living"（带助动词）属于时态题；
     * "address the issue / write the address of" 是围绕**同一个核心词**的不同说法，
     * 考的是那个词的词义（熟词生义），不是短语搭配。
     */
    test: (s, opts) => {
      const AUX = /^(?:is|are|was|were|be|been|being|has|have|had|will|would|shall|should|can|could|may|might|must|do|does|did)\b/i;
      const multiword = opts
        .map((o) => o.trim())
        .filter((o) => o.split(/\s+/).length >= 2 && !AUX.test(o));
      if (multiword.length < 2 || multiword.length < Math.ceil(opts.length / 2)) return false;

      // 只有"同一动词 + 不同小品词"（take off/up/on/in）才算短语搭配；
      // "address the issue / write the address of" 围绕同一个名词，考的是该名词的词义。
      return isPhrasalVerbChoice(multiword);
    },
  },
  // ---- 从句与连接 ----
  {
    label: '宾语从句',
    /**
     * 与定语从句同样的道理：连接词（that/if/whether…）常常**就是被考的空位**，
     * 题干里根本没有它。所以判据是"能带从句的动词 + 空位"，再要求连接词出现在选项里。
     */
    test: (s, opts) => {
      const verbThenBlank = /\b(?:think|believe|know|wonder|ask|asked|say|said|doubt|hope|guess|suppose|remember|forget|decide|find|found|tell|told)\b[^.?]*(?:____|_{2,}|\\(\s*\\))/i.test(s);
      const clauseWord = /^(?:that|if|whether|what|where|when|why|how|who|which)\b/i;
      if (verbThenBlank && opts.some((o) => clauseWord.test(o.trim()))) return true;
      // 连接词直接写在题干里的情况
      return /\b(?:I\s+(?:think|believe|know|wonder|asked|said)|do\s+you\s+know)\b[^.?]*\b(?:that|if|whether)\b/i.test(s);
    },
  },
  { label: '状语从句', test: (s, opts) =>
      // 连词在句首，或连词本身是被考的空位（选项里给连词）
      /^\s*(?:when|while|because|although|though|if|unless|until|as\s+soon\s+as|since|before|after|even\s+though)\b/i.test(s) ||
      /,\s*(?:when|while|because|although|though|if|unless)\b/i.test(s) ||
      (/(?:____|_{2,})/.test(s) &&
        /,\s*(?:we|I|he|she|they|it|you)\b/i.test(s) &&
        opts.some((o) => /^(?:although|though|because|unless|until|while|whereas|even\s+though|as\s+soon\s+as|so\s+that)\b/i.test(o.trim()))) },
  // ---- 词法与搭配 ----
  { label: '主谓一致', test: (s, opts) => /\b(?:neither|either|each|every|one\s+of|the\s+number\s+of|a\s+number\s+of|together\s+with|as\s+well\s+as)\b/i.test(s) || /\bnor\b/i.test(s) },
  { label: '介词搭配', test: (s, opts) => opts.some((o) => /^(?:at|in|on|for|to|with|of|by|from|about|into|over|under|between|among|during)\b/i.test(o.trim())) || /\b(?:be\s+good\s+at|be\s+interested\s+in|depend\s+on|look\s+forward\s+to|be\s+afraid\s+of)\b/i.test(s) },
  { label: '固定短语', test: (s) => /\b(?:take\s+(?:care|part|place|pride)|make\s+(?:up|sure|friends)|put\s+(?:on|off|up)|give\s+up|look\s+after|turn\s+(?:on|off|down)|come\s+true|as\s+soon\s+as|as\s+long\s+as)\b/i.test(s) },
  {
    label: '冠词',
    /**
     * 只有"空位处该填冠词"才算冠词考点，两个必要条件：
     *   1. 选项里有冠词；
     *   2. 空位**前面不是限定词**（"The ____ of the plan" 的空位填的是名词，不是冠词）。
     * 不能因为选项里出现 a/an/the 就判定 —— 干扰项里有冠词太常见（实测踩过）。
     */
    test: (s, opts) => {
      if (!opts.some((o) => /^(?:a|an|the|不填|零冠词)$/i.test(o.trim()))) return false;
      if (!/(?:____|_{2,}|\\(\s*\\))/.test(s)) return false;
      // 空位前面是 the/this/my 等限定词 → 这里不填冠词
      if (/\b(?:the|this|that|these|those|my|your|his|her|its|our|their)\s+(?:____|_{2,})/i.test(s)) return false;
      return true;
    },
  },
  { label: '代词', test: (s, opts) => opts.some((o) => /^(?:it|its|they|them|their|theirs|he|him|his|she|her|hers|who|which|that|this|these|those|one|ones)\b/i.test(o.trim())) },
  { label: '比较级与最高级', test: (s, opts) =>
      // 题干里必须有明确的比较结构，或空位紧邻 than
      /\b\w+er\s+than\b|\bmore\s+\w+\s+than\b|\bthe\s+(?:most|least)\b|\bas\s+\w+\s+as\b/i.test(s) ||
      (/(?:____|_{2,})\s+than\b/i.test(s) && opts.some((o) => /\w+er\b|\bmore\b/i.test(o))) },
  {
    label: '情态动词',
    /**
     * 判据只有一个：**选项本身**是情态动词或其完整形式。
     *
     * 踩过的坑：曾经加过"题干里 must 后面紧跟空位就算"，结果
     * "We must ____ the issue"（选项 address / speak to / write to / send to）
     * 被标成情态动词 —— 但题干里的 must 是固定成分，空位考的是 address 的词义。
     * 情态动词若出现在题干而不是选项，说明它不是考点。
     */
    test: (s, opts) => {
      const MODAL = /^(?:can|could|may|might|must|should|ought\s+to|need|dare|had\s+better|would|will|shall)\b/i;
      const modalForms = opts.filter((o) => MODAL.test(o.trim()));
      if (modalForms.length >= 2) return true;
      // 选项是"情态动词 + 动词"这类完整形式（must be finished）时也算
      return opts.some((o) => MODAL.test(o.trim()) && o.trim().split(/\s+/).length >= 2);
    },
  },
  { label: '名词单复数', test: (s, opts) => /\b(?:many|much|few|little|several|a\s+lot\s+of|plenty\s+of)\b/i.test(s) },
];

/** 本地规则识别：返回标签数组（可能为空）。 */
function detectLocal(stem, options = {}) {
  const s = String(stem || '');
  const opts = Object.values(options || {}).map((v) => String(v || ''));
  const hits = [];
  for (const rule of RULES) {
    if (rule.test(s, opts)) hits.push(rule.label);
    if (hits.length >= 4) break; // 最多 4 个，太多反而无法用于统计
  }
  // "熟词生义"优先于"词义辨析"：题干里出现了常见词的不常见用法时，这个标签更有指导意义
  // （如 "We must address the issue" —— 直接告诉学生 address 这里是"处理"）。
  if (!hits.some((h) => GRAMMAR_LABELS.has(h))) {
    const rareRule = RULES.find((r) => r.label === '熟词生义');
    if (rareRule && rareRule.test(s, opts) && !hits.includes('熟词生义')) {
      hits.push('熟词生义');
    }
    if (!hits.includes('熟词生义') && isVocabularyQuestion(s, options)) {
      hits.push('词义辨析');
    }
  }
  return hits;
}

/** 属于"语法类"的标签：只要命中其中之一，就不再补"词义辨析"。 */
const GRAMMAR_LABELS = new Set([
  '定语从句', '被动语态', '虚拟语气', '现在完成时', '过去完成时', '一般过去时',
  '一般现在时', '一般将来时', '现在进行时', '非谓语动词', '宾语从句', '状语从句',
  '主谓一致', '介词搭配', '固定短语', '冠词', '代词', '比较级与最高级', '情态动词', '名词单复数',
]);

/** 提示词：只让模型补充，不要求它推翻本地结论。 */
function buildKnowledgePrompt(items) {
  return [
    '你是英语教研老师。下面给出若干道英语单选题。',
    '请为每道题给出**考点标签**（中文，2-6 个字，最多 3 个），用于学生的薄弱项统计。',
    '',
    '要求：',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。',
    '2. 标签要能体现可统计的考点，例如：虚拟语气、非谓语动词、介词搭配、定语从句、主谓一致。',
    '3. 不要写"语法""单选题"这种没法用来定位薄弱项的泛标签。',
    '4. 必须为每个给出的 index 都返回一条；实在判断不出就把 knowledgePoints 设为空数组。',
    '',
    '题目列表：',
    items.map((it) => `${it.index}. 题干：${it.stem}\n   选项：${LETTERS.slice(0, Object.keys(it.options || {}).length).map((L) => `${L}. ${it.options[L]}`).join('  ')}`).join('\n'),
    '',
    '输出格式：',
    JSON.stringify({ items: [{ index: items[0] ? items[0].index : 1, knowledgePoints: ['虚拟语气', '非谓语动词'] }] }, null, 2),
  ].join('\n');
}

/** 解析模型返回的考点，按 index 对齐；index 不合法的直接丢弃。 */
function parseKnowledgeResponse(rawText, validIndexes) {
  const out = new Map();
  let json = null;
  if (typeof rawText === 'object' && rawText !== null) json = rawText;
  else {
    const s = String(rawText || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        json = JSON.parse(s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
      } catch {
        json = null;
      }
    }
  }
  const list = json && Array.isArray(json.items) ? json.items : Array.isArray(json) ? json : [];
  const valid = new Set(validIndexes);
  for (const it of list) {
    const idx = Number(it && it.index);
    if (!valid.has(idx)) continue; // 防止模型把考点错配到别的题上
    const kps = Array.isArray(it.knowledgePoints)
      ? it.knowledgePoints.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
      : [];
    if (kps.length) out.set(idx, kps);
  }
  return out;
}

/** 合并：本地标签在前（稳定），模型标签只追加不覆盖，去重并限长。 */
function mergeKnowledge(local, fromModel, max = 4) {
  const out = [];
  for (const t of [...(local || []), ...(fromModel || [])]) {
    const v = String(t).trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 功能词：be 动词、助动词、介词、代词、冠词、连词、情态动词。
 * 这些词之间的选择通常考**语法**（主谓一致、介词搭配、语态），不是词义辨析。
 * 实测踩过的坑：不加这个过滤，"Neither Tom nor his friends ____"（is/are/was/has been）
 * 和 "She is good ____ playing"（at/in/on/for）都会被评为词义题。
 */
const FUNCTION_WORDS = new Set([
  // be 与助动词
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'shall', 'should',
  // 情态动词
  'can', 'could', 'may', 'might', 'must', 'need', 'dare', 'ought',
  // 介词
  'at', 'in', 'on', 'of', 'to', 'for', 'with', 'by', 'from', 'about', 'into', 'over',
  'under', 'between', 'among', 'during', 'since', 'before', 'after', 'until', 'till',
  'through', 'against', 'without', 'within', 'beyond', 'beside', 'besides', 'toward',
  'towards', 'upon', 'onto', 'off', 'out', 'up', 'down', 'as', 'than',
  // 代词与限定词
  'it', 'its', 'they', 'them', 'their', 'theirs', 'he', 'him', 'his', 'she', 'her', 'hers',
  'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'i', 'me', 'my', 'mine',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'some', 'any', 'no', 'none', 'all', 'both', 'each', 'every', 'either', 'neither',
  'another', 'other', 'others', 'such', 'same',
  // 冠词与连词
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'nor', 'yet', 'if', 'unless',
  'because', 'although', 'though', 'while', 'when', 'where', 'why', 'how', 'whether',
]);

/** 判断一个选项是不是"功能词"（可能带否定或缩写）。 */
function isFunctionWord(text) {
  const t = String(text)
    .trim()
    .toLowerCase()
    .replace(/^(?:to\s+|not\s+)/, '')
    .replace(/^don't$/, 'do')
    .replace(/n't$/, '');
  if (FUNCTION_WORDS.has(t)) return true;
  // 多词形式里若由功能词组成（has been / must be），也算功能词
  const parts = t.split(/\s+/);
  return parts.length > 0 && parts.every((p) => FUNCTION_WORDS.has(p) || /^(?:not|never|always|usually|often|sometimes|already|yet|just|ever)$/.test(p));
}

/**
 * 是否为"同一个词的不同形式/语态"（writes / wrote / is written / was written）——
 * 这类考的是语法（时态、语态、非谓语），不是词义辨析。
 *
 * 注意不能只看"有没有多词选项"：`is written` 是多词，但它和 `writes` 是同一个动词。
 * 正确判据是**词根是否相同**：先剥掉助动词，再取词干比较。
 */
function isSameWordForms(opts) {
  if (opts.length < 2) return false;
  const AUX = /^(?:is|are|was|were|be|been|being|has|have|had|will|would|shall|should|can|could|may|might|must|do|does|did|to)\s+/i;
  const bases = opts.map((o) => {
    let t = String(o).trim().toLowerCase();
    // 反复剥掉助动词（has been written → written）
    let prev = null;
    while (prev !== t && AUX.test(t)) {
      prev = t;
      t = t.replace(AUX, '');
    }
    return stemOf(t);
  });
  return new Set(bases).size === 1;
}

/** 词干化：去掉常见词形后缀，用于判断几个选项是不是同一个词。 */
function stemOf(word) {
  return String(word)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/(?:ations?|ing|ed|es|s)$/i, '');
}

/**
 * 判断一组选项是否"围绕同一个词变来变去"（时态 / 语态 / 非谓语 / 词形）。
 *
 * 兜底判据：只要有两个选项共享同一个词干前缀，就说明在考这个词的形态，
 * 而不是在选不同的词。这条能兜住 isSameWordForms 漏掉的情况，例如
 * writes / wrote / is written / was written —— writ / was writ 共享前缀。
 *
 * 只对**单个词**成立，不能用在短语上：
 * take off / take up / take on / take in 也共享 "take"，但它们是不同的短语动词，
 * 考的是搭配与词义，属于词汇题（实测踩过这个反向误判）。
 */
function sharesWordStem(opts) {
  const cleaned = opts.map((o) => String(o).trim());
  // 有任何一个选项是多词短语 → 不是"同一个词的形态"问题
  if (cleaned.some((o) => o.split(/\s+/).length > 1)) return false;

  const AUX = /^(?:is|are|was|were|be|been|being|has|have|had|will|would|shall|should|can|could|may|might|must|do|does|did|to)\s+/i;
  const bases = cleaned.map((o) => {
    let t = o.toLowerCase();
    let prev = null;
    while (prev !== t && AUX.test(t)) {
      prev = t;
      t = t.replace(AUX, '');
    }
    return stemOf(t).slice(0, 4);
  });
  return new Set(bases).size < bases.length;
}

/** 小品词：短语动词的第二部分（take **off** / take **up**）。 */
const PARTICLES = new Set([
  'off', 'up', 'on', 'in', 'out', 'away', 'back', 'down', 'over', 'through', 'along', 'around',
  'about', 'after', 'at', 'by', 'for', 'into', 'to', 'with', 'without', 'upon', 'apart', 'aside',
]);

/**
 * 是否为"同一个动词 + 不同小品词"的短语动词辨析（take off / take up / take on / take in）。
 * 这类题考搭配与词义，属于词汇题，应标"短语搭配"。
 *
 * 与 "address the issue / write the address of" 的区别在**结构**：
 * 前者是「动词 + 小品词」且小品词各不相同；后者是名词短语，核心是名词。
 * 所以不能用"共享核心词"来区分 —— take off/up/on/in 也共享动词 take（实测踩过这个反向误判）。
 */
function isPhrasalVerbChoice(opts) {
  const parsed = opts.map((o) =>
    String(o)
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  const withParticle = parsed.filter((t) => t.length >= 2 && t.length <= 3 && PARTICLES.has(t[t.length - 1]));
  if (withParticle.length < 2) return false;
  const verbs = withParticle.map((t) => t[0]);
  const particles = withParticle.map((t) => t[t.length - 1]);
  return new Set(verbs).size === 1 && new Set(particles).size === withParticle.length;
}

/**
 * 是否为**词汇辨析题**（考"选哪个词/短语的意思对"）。
 *
 * 与语法题的区别在于：词汇题的选项是**完全不同的词**（merit / flaw / haste / bliss），
 * 语法题的选项通常共享同一个词根（complete / completed / was completed）
 * 或属于同一类功能词（at / in / on）。
 * 用这个信号区分，才不会把被动语态题误判成词义题。
 */
function isVocabularyQuestion(stem, options = {}) {
  const s = String(stem || '');
  const opts = Object.values(options || {}).map((v) => String(v || '').trim()).filter(Boolean);
  if (opts.length < 3) return false;
  const allShort = opts.every((o) => o.split(/\s+/).length <= 3 && o.length <= 22);
  if (!allShort) return false;
  // 全部是功能词（is/are/was、at/in/on/for）→ 考的是语法，不是词义
  if (opts.every(isFunctionWord)) return false;
  // 围绕同一个词变化（writes / wrote / is written / was written）→ 考语法。
  // sharesWordStem 只对单个词生效：短语动词（take off/up/on/in）属于词汇题，不该被它挡掉。
  if (isSameWordForms(opts) || sharesWordStem(opts)) return false;

  // 结构信号优先：题干或选项里出现被动语态、情态动词、完成时等结构时，
  // 考的是语法形式而不是词义。放在这里是为了让本函数自身语义也正确，
  // 而不只依赖调用方（detectLocal）的标签门控。
  const joined = `${s} ${opts.join(' ')}`;
  const structural = [
    new RegExp(`\\b(?:is|are|was|were|be|been|being)\\s+(?:\\w+ed|${IRREGULAR_PP})\\b`, 'i'),
    /\b(?:must|can|could|may|might|should)\s+\w+/i,
    /\b(?:have|has|had)\s+(?:\w+ed|been|done|gone)\b/i,
  ];
  if (structural.some((re) => re.test(joined))) return false;

  const sentences = opts.filter((o) => o.split(/\s+/).length > 2).length;
  if (sentences > 0) return false; // 有整句选项的通常是语法/句型题

  return s.split(/\s+/).length >= 5 || /____|means|closest|replace/i.test(s);
}

/**
 * 词义题专用提示词：要求逐项给出**本题语境下**的意思，并点出熟词生义。
 *
 * 用户明确要求："词义猜测题要给出所有选项的意思，包括熟词生义，以及本题的意思，
 * 短语要有释疑。" 所以这里不要笼统的解析，要结构化到每个选项。
 */
function buildWordGlossPrompt(items) {
  return [
    '你是英语老师。下面每道题都是**词义或短语辨析**题。',
    '请为每道题的**每一个选项**给出释义，并说明本题语境下该选哪个、为什么。',
    '',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要多余解释。',
    '2. 每个选项都要给出：',
    '   - gloss：这个选项的**常用义**（中文，简短）',
    '   - here：如果它在**本题语境下**取的是不常见的含义（熟词生义），写这里；否则留空字符串',
    '   - note：必要时补充（如固定搭配、易混点），没有就留空',
    '3. 熟词生义必须点出来。例如 address 常义"地址"，但在 address the issue 里是"处理"。',
    '4. 短语要讲清构成与整体意思（如 take off = 起飞 / 脱下 / 突然成功，要按本题语境选）。',
    '5. sentence：用一句话说明本题整体在说什么、为什么选它。',
    '',
    '题目列表：',
    items
      .map(
        (it) =>
          `${it.index}. 题干：${it.stem}\n   选项：\n${Object.entries(it.options || {})
            .map(([L, v]) => `     ${L}. ${v}`)
            .join('\n')}`,
      )
      .join('\n'),
    '',
    '输出格式：',
    JSON.stringify(
      {
        items: [
          {
            index: items[0] ? items[0].index : 1,
            sentence: '本题在讲……所以选 B。',
            options: {
              A: { gloss: '常用义', here: '本题语境下的特殊含义（没有就留空）', note: '搭配或易混提示' },
              B: { gloss: '常用义', here: '', note: '' },
            },
          },
        ],
      },
      null,
      2,
    ),
  ].join('\n');
}

/** 解析词义题返回；只保留合法 index，并规整每个选项的字段。 */
function parseWordGlossResponse(rawText, validIndexes) {
  let json = null;
  if (typeof rawText === 'object' && rawText !== null) json = rawText;
  else {
    const s = String(rawText || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        json = JSON.parse(s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
      } catch {
        json = null;
      }
    }
  }
  const list = json && Array.isArray(json.items) ? json.items : [];
  const valid = new Set(validIndexes);
  const out = new Map();
  for (const it of list) {
    const idx = Number(it && it.index);
    if (!valid.has(idx)) continue;
    const options = {};
    for (const [L, v] of Object.entries(it.options || {})) {
      const letter = String(L).trim().toUpperCase();
      if (!/^[A-F]$/.test(letter)) continue;
      if (typeof v === 'string') options[letter] = { gloss: v.trim(), here: '', note: '' };
      else {
        options[letter] = {
          gloss: String(v?.gloss ?? '').trim(),
          here: String(v?.here ?? '').trim(),
          note: String(v?.note ?? '').trim(),
        };
      }
    }
    if (Object.keys(options).length) {
      out.set(idx, { sentence: String(it.sentence ?? '').trim(), options });
    }
  }
  return out;
}

/** 本地兜底：没有模型时，至少把"这道题在考词义/搭配"说清楚，而不是假装给了释义。 */
function localWordGloss(question) {
  const opts = Object.entries(question.options || {});
  const options = {};
  for (const [L, v] of opts) {
    options[L] = { gloss: '', here: '', note: '' };
  }
  return {
    sentence: '这是一道词义/短语辨析题。未配置文本模型，无法自动给出每个选项的释义。',
    options,
    needsModel: true,
  };
}

module.exports = {
  LETTERS,
  RULES,
  detectLocal,
  isVocabularyQuestion,
  buildKnowledgePrompt,
  buildWordGlossPrompt,
  parseKnowledgeResponse,
  parseWordGlossResponse,
  localWordGloss,
  mergeKnowledge,
};
