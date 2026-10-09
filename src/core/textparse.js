'use strict';

/**
 * 文本导入解析器：把「纯文本形式的题目」解析成结构化题目。
 *
 * 存在意义：能稳定读图的是宿主（AI），而将来读图要长期可用要靠应用自己。
 * 但两者产出的都是**文本**，所以只要把「文本 → 结构化题目」做扎实，
 * 无论题目来自 AI 转写、老师发的电子版、还是自己敲的，都能一键入库。
 *
 * 用法约定（尽量宽容，用户贴什么格式都能认）：
 *   - 题干可以跨行
 *   - 选项支持 "A. go" / "A、go" / "(A) go" / "A) go" / "A: go"，也支持一行内多个选项
 *   - 答案支持 "答案：B" / "答案 B" / "Answer: B"，可通过 answerMarkers 自定义
 *   - 解析结果带 warnings，明确告诉用户哪些地方需要人工确认
 *
 * 纯函数、不依赖网络与数据库，浏览器与 Node 通用。
 */

/**
 * 选项行/片段：A. go / A、go / (A) go / A) go / A: go / A）go
 *
 * 两个坑都踩过，注释留给人看：
 * 1. 分隔符必须用后行断言 (?<=...) 而不是消费它。若写成 (?:^|[\s\t|])，
 *    第一个选项的 "^" 分支会消费掉位置 0，同一行后续选项前的空格就匹配不到了。
 * 2. 值必须是**惰性**的，并显式停在"下一个选项标记"之前。若写成 [^\n]*，
 *    第一个选项会把整行后面的选项一起吞掉，得到 {A:"go  B. goes  C. going  D. gone"}。
 */
const OPTION_RE = /(?<=^|[\s\t|])[（(]?([A-Ha-h])[)）.、:：]\s*([\s\S]*?)(?=\s+[（(]?[A-Ha-h][)）.、:：]|$)/g;
/** 判断某一行**开头**是否像选项。这里必须包含 : 与 ：，否则 "A. go  B. goes  C. going" 会被整段吞进 A */
const OPTION_LINE_RE = /^\s*[（(]?([A-Ha-h])[)）.、:：]\s*\S/;
/** 全卷答案表里的单条："21-B" / "21.B" / "21、B" / "21：B" / "21 B" */
const ANSWER_ENTRY_RE = /(\d{1,3})\s*[-–—.、:：)）]?\s*([A-Ha-h])(?![A-Za-z0-9])/g;
/** 题号：21. / 21、/ (21) / 21) / Q21 / 第21题 */
const QUESTION_START_RE = /^\s*(?:[（(]?(\d{1,3})[)）.、:：]|Q\s*(\d{1,3})[.、:：)]?|第\s*(\d{1,3})\s*题[.、:：]?)\s*(.*)$/;

const DEFAULT_ANSWER_MARKERS = [
  // 行内答案标记："答案：B" / "正确答案是 C" / "答案选 B" / "Answer: D"
  // 刻意**不加行首锚点**：答案可能出现在题干行尾（"1. He ____ to school. 答案：B"），
  // 加了 ^ 就认不出来。"整行就是答案"的判断另由 isAnswerOnlyLine 负责。
  // 必须同时容忍半角与全角冒号（中文材料里「答案：B」最常见）。
  /(?:正确答案|参考答案|答案|answer|key)\s*(?:是|为|选|is)?\s*[:：=]?\s*[（(]?([A-Ha-h])[)）]?(?![A-Za-z0-9])/i,
  // 整行只有一个字母（可能带括号或句点），如 "B" / "(B)" / "B."
  // 必须带 m 标志：否则 ^ 与 $ 只匹配整个字符串的首尾，
  // 多行文本里单独一行的答案（如 "…school.\nB"）永远找不到。
  /^\s*[（(]?([A-Ha-h])[)）.、]?\s*$/m,
];

/** 判断一行是否是选项行（用于区分题干续行与选项）。 */
function looksLikeOptionLine(line) {
  return OPTION_LINE_RE.test(line);
}

/** 从文本里抽"题号→答案"的映射（全卷答案表用，如 "21-B 22-C"）。 */
function findAnswerEntries(text) {
  const map = new Map();
  const re = new RegExp(ANSWER_ENTRY_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    const letter = m[2].toUpperCase();
    if (!map.has(num)) map.set(num, letter);
  }
  return map;
}

/** 删除行尾的答案（用于题干清理）。 */
function stripTrailingAnswer(line) {
  return line.replace(/\s*[（(]?(?:正确答案|参考答案|答案|answer|key)\s*(?:是|为|选|is)?\s*[:：=]?\s*[（(]?[A-Ha-h][)）]?\s*$/i, '');
}

function normalizeLetters(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const letter = String(k).trim().toUpperCase();
    if (/^[A-H]$/.test(letter) && String(v).trim() !== '') out[letter] = String(v).trim();
  }
  return out;
}

/** 从一段文本里抽选项：兼容同行多选项、每行一个、带括号等写法。 */
function parseOptionsFromText(text) {
  const options = {};
  const re = new RegExp(OPTION_RE.source, 'g');
  // 关键：给每行补一个前导空格。否则首字母前的空白被 (?:^|[\s\t|]) 吃掉后，
  // 第一个选项的贪婪匹配会把同一行后面所有选项一起吞掉。
  const src = String(text).split('\n').map((l) => ` ${l}`).join('\n');
  let m;
  while ((m = re.exec(src)) !== null) {
    const letter = m[1].toUpperCase();
    const value = (m[2] || '').trim();
    if (value === '') continue;
    // 同一字母重复出现时取第一次（通常是题干里的 "(A)" 之类误命中）
    if (options[letter] === undefined) options[letter] = value;
  }
  return options;
}

/** 从一段文本里找答案字母（只认带标记的写法，用于"每题后面跟了答案"的排版）。 */
function findAnswer(text, markers = DEFAULT_ANSWER_MARKERS) {
  for (const re of markers) {
    const m = text.match(re);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return '';
}

/** 判断一行是否"整行就是答案标记"（如 "答案：B" 或单独一个 "B"）。 */
function isAnswerOnlyLine(line, markers = DEFAULT_ANSWER_MARKERS) {
  const t = line.trim();
  if (!t) return false;
  return markers.some((re) => new RegExp(`^(?:${re.source})$`, re.flags.replace(/[gm]/g, '')).test(t));
}

/**
 * 主解析入口。
 * @param {string} rawText
 * @param {object} opts
 * @param {RegExp[]} opts.answerMarkers  自定义答案标记
 * @param {boolean}  opts.keepAnswerInStem 是否保留题干里的答案文本（默认剥掉）
 */
function parseQuestionsFromText(rawText, opts = {}) {
  const markers = opts.answerMarkers && opts.answerMarkers.length ? opts.answerMarkers : DEFAULT_ANSWER_MARKERS;
  const text = String(rawText ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const warnings = [];

  // 第一步：按题号切块。没有题号时整段当作一题。
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(QUESTION_START_RE);
    // 只有形如 "12." 且后面有内容，或 "第12题" 才算新题，避免把 "2010." 当题号
    const isQuestionStart = Boolean(m) && (m[3] !== undefined || /\S/.test(m[4] || '') || /^\s*\d{1,3}[)）.、:：]\s*$/.test(line));
    if (isQuestionStart) {
      if (current) blocks.push(current);
      const num = Number(m[1] ?? m[2] ?? m[3]);
      current = { number: num, lines: [m[4] || ''] };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim() !== '') {
      // 题号之前的说明文字（如 "Choose the best answer"）先丢掉，但记一笔
      current = null;
    }
  }
  if (current) blocks.push(current);

  const preamble = lines.slice(0, lines.findIndex((l) => QUESTION_START_RE.test(l)) === -1 ? 0 : lines.findIndex((l) => QUESTION_START_RE.test(l)))
    .map((l) => l.trim()).filter(Boolean);

  if (blocks.length === 0) {
    // 没有任何题号：退化为整段一题
    const body = text.trim();
    if (!body) return { questions: [], warnings: ['没有可解析的内容。'], preamble: [] };
    warnings.push('没有识别到题号，已把整段内容当作一道题处理，请确认。');
    blocks.push({ number: null, lines: lines });
  }

  // 答案表（"21-B 22-C" 这类）通常跨越多个题块，必须在全部题块切好之后统一处理，
  // 否则每个题块都只看到"最后一个答案"，答案会整体串位。
  const globalAnswerEntries = findAnswerEntries(text);

  const questions = blocks.map((block) => {
    const blockText = block.lines.join('\n');
    const issues = [];

    // 第一步：逐行分类。
    // optionLines   —— 选项行，单独收集
    // stemLines     —— 去掉答案标记后的题干行（用于生成题干）
    // contentLines  —— 未剥答案的非常规行（**找答案必须用这一份**：
    //                  若在已剥掉答案的 stemLines 上找，行尾答案就永远找不到了）
    const optionLines = [];
    const stemLines = [];
    const contentLines = [];
    for (const line of block.lines) {
      if (looksLikeOptionLine(line)) {
        optionLines.push(line);
        continue;
      }
      contentLines.push(line);
      const stripped = stripTrailingAnswer(line);
      if (stripped.trim() !== '') stemLines.push(stripped);
    }

    // 第二步：在"题干 + 答案行"（未剥答案）上找答案，选项行不参与。
    // 选项不参与的原因：选项 "B. goes" 会被当成答案标记匹配到空字母，把真正的答案挡住。
    const contentOnly = contentLines.join('\n');
    let answer = findAnswer(contentOnly, markers);
    if (!answer && block.number !== null && globalAnswerEntries.has(block.number)) {
      answer = globalAnswerEntries.get(block.number);
    }

    // 第三步：组建题干与选项。
    const stemParts = stemLines.map((l) => l.trim()).filter(Boolean);
    let stem = stemParts.join(' ').replace(/\s{2,}/g, ' ').trim();
    let options = normalizeLetters(parseOptionsFromText(optionLines.join('\n')));

    // 兜底：选项和题干挤在同一行（题干含下划线时最容易发生）
    if (Object.keys(options).length < 2) {
      const inline = normalizeLetters(parseOptionsFromText(contentOnly));
      if (Object.keys(inline).length >= 2) {
        options = inline;
        stem = stem.replace(/(?:^|\s)[（(]?[A-Ha-h][)）.、:：].*$/s, '').trim();
        issues.push('题干与选项挤在同一行，已自动拆分，请核对');
      }
    }

    if (!stem) issues.push('题干为空，请补全');
    if (Object.keys(options).length < 2) issues.push('选项少于 2 个，请补全');
    if (!answer) issues.push('未找到答案，请手动选择');

    return {
      number: block.number,
      stem,
      options,
      answer,
      explanation: '',
      knowledgePoints: [],
      difficulty: 'medium',
      issues,
      sourceText: blockText,
    };
  });

  // 第三步：跨题校验。答案个数与题数不符是最常见的粘贴事故。
  const withAnswer = questions.filter((q) => q.answer);
  if (withAnswer.length > 0 && withAnswer.length < questions.length) {
    warnings.push(
      `共 ${questions.length} 道题，但只找到 ${withAnswer.length} 个答案。` +
      `请检查答案行是否漏贴，或勾选下方「答案在末尾统一列出」并粘贴答案表。`,
    );
  }
  if (preamble.length) {
    warnings.push(`已忽略题号前的说明文字：${preamble.slice(0, 2).join(' / ').slice(0, 80)}`);
  }
  const dupNumbers = questions.map((q) => q.number).filter((n, i, arr) => n !== null && arr.indexOf(n) !== i);
  if (dupNumbers.length) warnings.push(`题号重复：${[...new Set(dupNumbers)].join('、')}，请确认是否粘贴重复。`);

  return { questions, warnings, preamble };
}

/**
 * 解析"答案集中在末尾"的答案表，例如：
 *   1-5 BCDAB
 *   6-10 ACBDA
 * 或
 *   1.B 2.C 3.A
 * 返回 { 题号: 字母 } 映射。
 */
function parseAnswerKey(text) {
  const map = new Map();
  const src = String(text ?? '');

  // 形式一：1.B 2.C 3.A（连续键值对）
  const pairRe = /(\d{1,3})\s*[.、:：)）-]?\s*([A-Ha-h])(?![A-Za-z])/g;
  let m;
  let pairCount = 0;
  while ((m = pairRe.exec(src)) !== null) {
    map.set(Number(m[1]), m[2].toUpperCase());
    pairCount += 1;
  }
  if (pairCount > 0) return map;

  // 形式二：1-5 BCDAB（区间 + 连续字母串）
  const rangeRe = /(\d{1,3})\s*[-–~至]\s*(\d{1,3})\s*[:：.、]?\s*([A-Ha-h]{2,})/g;
  while ((m = rangeRe.exec(src)) !== null) {
    const from = Number(m[1]);
    const letters = m[3].toUpperCase().split('');
    letters.forEach((L, i) => map.set(from + i, L));
  }
  if (map.size > 0) return map;

  // 形式三：纯字母串（按顺序对应第 1 题起）
  const pure = src.trim().match(/^[A-Ha-h\s,，]+$/);
  if (pure) {
    let n = 1;
    for (const ch of pure[0].replace(/[\s,，]/g, '').toUpperCase()) {
      if (/[A-H]/.test(ch)) map.set(n++, ch);
    }
  }
  return map;
}

/** 把答案表应用到题目上（题号对不上时明确报告，而不是静默错配）。 */
function applyAnswerKey(questions, answerMap) {
  const applied = [];
  const unmatched = [];
  for (const q of questions) {
    if (q.number !== null && answerMap.has(q.number)) {
      q.answer = answerMap.get(q.number);
      q.issues = (q.issues || []).filter((i) => !i.includes('未找到答案'));
      applied.push(q.number);
    } else if (!q.answer) {
      unmatched.push(q.number);
    }
  }
  return { applied: applied.length, unmatched };
}

module.exports = {
  OPTION_RE,
  OPTION_LINE_RE,
  ANSWER_ENTRY_RE,
  QUESTION_START_RE,
  DEFAULT_ANSWER_MARKERS,
  looksLikeOptionLine,
  parseOptionsFromText,
  findAnswer,
  findAnswerEntries,
  isAnswerOnlyLine,
  stripTrailingAnswer,
  parseQuestionsFromText,
  parseAnswerKey,
  applyAnswerKey,
};
