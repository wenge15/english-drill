'use strict';

/**
 * 本地释义库：我自己维护的"常用义 + 熟词生义 + 本题语境义 + 短语释疑"。
 *
 * 为什么要有这一层，而不是全靠模型：
 *  1. 用户明确要求词汇题必须给出**每个选项**的意思（含熟词生义）与本题语境义；
 *  2. 这属于可沉淀的知识，同一个词被考到多次时不该每次都去问模型（花钱且有波动）；
 *  3. 没有 API Key 时也要能用。
 *
 * 数据结构（每个词条）：
 *   pos     词性简写
 *   gloss   常用义（必填）
 *   senses  其它常见义（数组，例如 last 的"持续"）
 *   rare    熟词生义：常见词的不常见含义（这是用户特别要求的重点）
 *   note    易混点、搭配提示
 *   ctx     语境义（由**选项措辞**决定）：键是选项里出现的关键词\n *   stemCtx 语境义（由**题干内容**决定）：如 take off 要看主语是飞机还是人
 *   phrase  当词条是短语时，拆解 + 整体意思（"短语要有释疑"）
 *
 * 找不到词条时返回 null，界面会明确告知"未收录"，而不是编一个意思。
 */

const GLOSSARY = {
  /* ================= 时间与介词类（高频易混，常被当作"语法"，实际靠词义区分） ================= */
  since: {
    pos: 'prep./conj.',
    gloss: '自从（某时间点起）',
    senses: ['既然（表原因）'],
    note: '后接**时间点**或**过去时的从句**；主句通常用完成时。与 for 的区别：for 接时间段。',
    // 语境由**题干**决定（主句是不是完成时），所以用 stemCtx 而不是 ctx
    stemCtx: { 'have|has|had': '自从……（主句完成时 + since + 时间点）' },
  },
  for: {
    pos: 'prep.',
    gloss: '为了；给；因为',
    senses: ['持续（一段时间）', '对于'],
    note: '表"持续多久"时接**时间段**（for three years）。',
    stemCtx: { 'have|has|had': '持续了……（完成时 + for + 时间段）' },
  },
  during: {
    pos: 'prep.',
    gloss: '在……期间',
    note: '后接**名词**（during the war），不能接从句；表"某事发生在这段时间内"。与 for 不同，它不强调"持续多久"。',
  },
  from: {
    pos: 'prep.',
    gloss: '从……（起点）',
    note: 'from ... to ... 表起止；但"从 2010 年起一直住在这里"要用 since，不能用 from。',
  },
  until: { pos: 'prep./conj.', gloss: '直到……为止', note: 'not ... until 是"直到……才"。' },
  by: { pos: 'prep.', gloss: '在……之前（不迟于）；通过；被', note: 'by + 时间点 = 到那时为止（常配完成时）；被动语态里表施动者。' },

  /* ================= 熟词生义：常见词的不常见含义 ================= */
  last: {
    pos: 'v./adj.',
    gloss: '最后的；上一个的',
    senses: ['持续、维持（动词）'],
    rare: '作动词时是"持续、够用"（The meeting lasted two hours. / The food will last three days.）',
    note: '看到 last 先别急着当"最后"——后面有没有接时间长度是判断依据。',
    ctx: { 'how long|hours|days|weeks|months|years': '持续（作动词，后面接时间长度）' },
  },
  address: {
    pos: 'v./n.',
    gloss: '地址（名词）',
    senses: ['演说、致辞'],
    rare: '作动词是"处理、应对（问题）"（address the issue / address the problem）',
    note: '看到 address + 问题/困难 这类宾语，就是"处理"，不是"写地址"。',
    ctx: { 'issue|problem|question|concern|matter': '处理、应对（问题）' },
  },
  book: {
    pos: 'v./n.',
    gloss: '书（名词）',
    rare: '作动词是"预订"（book a ticket / book a room）',
    ctx: { 'ticket|room|table|seat|flight': '预订' },
  },
  run: {
    pos: 'v.',
    gloss: '跑',
    senses: ['经营、管理（run a company）'],
    note: 'run out of = 用完；run into = 偶遇；in the long run = 从长远看。',
  },
  'run out of': {
    pos: 'phrase',
    gloss: '用完、耗尽',
    phrase: 'run（跑）+ out（出去）+ of → 字面"从……里跑光了"→ 用完了。主语通常是"人"，宾语是"被用完的东西"。',
    note: '易混：run out（主语是物：Time is running out.）｜run out of（主语是人：We ran out of time.）',
  },
  'give up': { pos: 'phrase', gloss: '放弃', phrase: 'give（给）+ up（向上/完全）→ 交出去 → 放弃。后接动名词：give up smoking。' },
  'put off': { pos: 'phrase', gloss: '推迟', phrase: 'put（放）+ off（离开）→ 往后放 → 推迟。同义 postpone。' },
  'take off': {
    pos: 'phrase',
    gloss: '起飞（飞机）',
    senses: ['脱下（衣服）', '突然走红、迅速发展'],
    phrase: 'take（拿）+ off（离开表面）→ 离开地面=起飞；离开身体=脱下。',
    note: '判断靠主语：飞机/火箭 → 起飞；人 + 衣服 → 脱下；产品/销量 → 突然成功。',
    // 意思取决于**题干的主语**，所以用 stemCtx（与"看选项措辞"的 ctx 区分开）
    stemCtx: {
      'plane|flight|aircraft|rocket': '起飞',
      'clothes|coat|shoes|hat|shirt': '脱下',
      'sales|product|business|popular': '迅速走红、大受欢迎',
    },
  },
  'take up': { pos: 'phrase', gloss: '开始从事；占用（时间/空间）', phrase: 'take + up（向上拿起）→ 拿起来做 → 开始做；占掉 → 占用。' },
  'take on': { pos: 'phrase', gloss: '承担；呈现（面貌）', phrase: 'take + on（在身上）→ 扛上身 → 承担；显出某种样子 → 呈现。' },
  'take in': { pos: 'phrase', gloss: '理解、吸收；欺骗', phrase: 'take + in（向内）→ 收进来 → 吸收、理解；把人骗进来 → 欺骗。' },
  'pick up': {
    pos: 'phrase',
    gloss: '捡起；（开车）接人',
    senses: ['（偶然）学会', '接电话', '好转'],
    phrase: 'pick（拾）+ up（起来）→ 捡起来；把人/话拾起来 → 接人、学会。',
    note: '一词多义最典型的短语，必须看宾语与语境。',
    ctx: { 'learn|language|english|skill': '（不经意间）学会' },
  },
  'figure out': { pos: 'phrase', gloss: '弄明白、想通', phrase: 'figure（数字/计算）+ out（出来）→ 算出来 → 想明白。' },
  'see off': { pos: 'phrase', gloss: '送行', phrase: 'see（看见）+ off（离开）→ 看着某人离开 → 送行。' },
  'stand for': { pos: 'phrase', gloss: '代表、象征；容忍', phrase: 'stand（站）+ for（为了/代替）→ 站在某物的位置上 → 代表。' },
  'count on': { pos: 'phrase', gloss: '依靠、指望', phrase: 'count（计算）+ on（在……上）→ 把希望算在某物上 → 依靠。' },
  'in no time': { pos: 'phrase', gloss: '立刻、很快', phrase: 'in（在）+ no（没有）+ time（时间）→ 不花时间 → 马上。注意不是"没时间"。' },
  'look forward to': { pos: 'phrase', gloss: '期待', phrase: 'to 在这里是介词，后面接动名词：look forward to hearing from you。' },
  'be used to': {
    pos: 'phrase',
    gloss: '习惯于（to 是介词，接动名词/名词）',
    phrase: 'be used to doing = 习惯于；used to do = 过去常常；be used to do = 被用来做。三个结构必须分清。',
    note: '题里出现 used to 先分清是哪一个。',
  },

  /* ================= 常见近义词辨析（词义题的典型） ================= */
  proud: { pos: 'adj.', gloss: '自豪的、骄傲的', note: 'be proud of 为……自豪；贬义时指"自负"。' },
  pleased: { pos: 'adj.', gloss: '高兴的、满意的', note: 'be pleased with/about 对……满意；比 happy 更强调"满意"。' },
  happy: { pos: 'adj.', gloss: '快乐的、幸福的', note: '最通用的"高兴"；be happy to do 乐意做。' },
  glad: { pos: 'adj.', gloss: '高兴的（多指一时的事）', note: 'be glad to do 乐意；不能说 glad about 某事（不如 pleased 自然）。' },
  merit: { pos: 'n./v.', gloss: '优点、长处', senses: ['值得（动词）'], note: 'on merit 凭实力。' },
  flaw: { pos: 'n.', gloss: '缺点、瑕疵', note: 'a flaw in the plan 计划中的缺陷。' },
  haste: { pos: 'n.', gloss: '匆忙、仓促', note: 'in haste 匆忙地；More haste, less speed. 欲速则不达。' },
  bliss: { pos: 'n.', gloss: '极乐、幸福', note: '语气很强，日常少用。' },
  affect: { pos: 'v.', gloss: '影响（动词）', note: '易混 effect（名词，影响）。affect = 动词，effect = 名词。' },
  effect: { pos: 'n.', gloss: '影响、效果（名词）', note: 'have an effect on。' },
  raise: { pos: 'v.', gloss: '举起；提高；抚养', note: '及物动词，必须带宾语（raise your hand）。' },
  rise: { pos: 'v.', gloss: '上升、升起（不及物）', note: '不带宾语（The sun rises.）。' },
  borrow: { pos: 'v.', gloss: '借入（从别人那里借来）', note: 'borrow sth from sb。' },
  lend: { pos: 'v.', gloss: '借出（把东西借给别人）', note: 'lend sth to sb。' },
  accept: { pos: 'v.', gloss: '接受（主动愿意）', note: '强调主观接受。' },
  receive: { pos: 'v.', gloss: '收到（客观接到）', note: '强调客观收到，不一定接受。' },
  cost: { pos: 'v./n.', gloss: '花费（主语是物）', note: 'sth costs sb money。主语是**物品或事情**，不是人。' },
  spend: { pos: 'v.', gloss: '花费（主语是人）', note: 'sb spends time/money on sth / (in) doing。主语必须是**人**。' },
  take: { pos: 'v.', gloss: '花费（时间）', note: 'It takes sb time to do sth —— 用 it 作形式主语，人也出现在句中但不是主语。' },
  pay: { pos: 'v.', gloss: '付款（主语是人）', note: 'sb pays money for sth。主语是**人**，宾语是钱。' },

  /* ================= 动词 + 介词：考点在介词，必须逐个收录 ================= */
  'speak to': { pos: 'phrase', gloss: '对……说话', phrase: 'speak（说）+ to（朝向）→ 朝着某人说 → 对某人说话。to 指向对象，不能省。', note: 'speak to sb（对某人说）；speak with sb 更强调"交谈"。' },
  'speak with': { pos: 'phrase', gloss: '与……交谈', phrase: 'with 表"一起"，强调双向交流。' },
  'send to': { pos: 'phrase', gloss: '寄给、送到', phrase: 'send（送）+ to（朝向）→ 送到某人/某地。to 指向接收方。', note: 'send sth to sb；若用 for 则变成"为某人去取/寄"。' },
  'write to': { pos: 'phrase', gloss: '写信给', phrase: 'write to sb = 给某人写信（英式常用）。' },
  'listen to': { pos: 'phrase', gloss: '听……', phrase: 'listen 是不及物动词，必须加 to 才能带宾语。' },
  'look at': { pos: 'phrase', gloss: '看……', phrase: 'look 不及物，加 at 才能带宾语。' },
  'arrive at': { pos: 'phrase', gloss: '到达（小地点）', phrase: 'arrive at + 小地点（车站、机场）；arrive in + 大地点（城市、国家）。' },
  'arrive in': { pos: 'phrase', gloss: '到达（大地点）', phrase: 'arrive in + 城市/国家。' },
  'good at': { pos: 'phrase', gloss: '擅长', phrase: 'be good at + 名词/动名词。at 表"在某个方面"。', note: 'be good at / be good for（对……有益）/ be good with（善于应付人）要分清。' },
  'interested in': { pos: 'phrase', gloss: '对……感兴趣', phrase: 'be interested in + 名词/动名词。in 表"在……之中"。' },
  'afraid of': { pos: 'phrase', gloss: '害怕', phrase: 'be afraid of + 名词/动名词。' },
  'depend on': { pos: 'phrase', gloss: '依靠、取决于', phrase: 'depend（依赖）+ on（在……上）→ 靠着某物 → 依靠。' },
  'belong to': { pos: 'phrase', gloss: '属于', phrase: 'belong 不及物，必须加 to。' },
};

/** 归一化查询键：小写、去多余空格、去掉 a/an/the 这类冠词前缀。 */
function normalizeKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(?:a|an|the)\s+/, '');
}

/**
 * 查词条。三级回退，顺序很重要：
 *   1. 整条短语（"take off"、"run out of"）—— 最精确
 *   2. 去掉冠词/所有格/代词后的短语（"the last"→"last"）
 *   3. 短语里的**核心词**（"address the issue"→"address"、"write the address of"→"address"）
 * 第 3 级不能少：词义题的选项常写成短语（"address the issue"），
 * 而释义库以单词为核心，"address"的意义才是考点。
 */
function lookup(text, stem = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const key = normalizeKey(raw);
  if (!key) return null;

  let entry = null;
  let matchedWord = key;
  const isMultiWord = key.split(/\s+/).length > 1;

  if (isMultiWord) {
    // 多词选项：先查整条短语
    if (GLOSSARY[key]) {
      entry = GLOSSARY[key];
    } else {
      // 再逐个查词。
      // 这里**不能**把 to/for/of 这类介词过滤掉："speak to"、"send to" 的考点就是那个介词。
      // 但也不能让介词盖过实义词，所以按"长度降序"取第一个命中的词。
      const tokens = key
        .replace(/[^a-z\s'-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      for (const t of tokens) {
        if (GLOSSARY[t]) {
          entry = GLOSSARY[t];
          matchedWord = t;
          break;
        }
      }
    }
  } else if (GLOSSARY[key]) {
    // 单个词：精确匹配。**不做语境义替换**（"write the address of" 里的 address 就是"地址"）
    entry = GLOSSARY[key];
  }

  if (!entry) return null;

  // 本题语境义，两种来源分开处理：
  //   ctx      —— 由**选项自身的措辞**决定（"address the issue" 里的 issue 说明是"处理"）
  //   stemCtx  —— 由**题干的内容/主语**决定（take off 是"起飞"还是"脱下"要看主语）
  // 分开的原因：ctx 若拿题干匹配，会把同一题干下的干扰项也套上引申义（实测踩过）。
  let here = '';
  const stemText = String(stem || '');

  if (entry.ctx) {
    for (const [pattern, meaning] of Object.entries(entry.ctx)) {
      try {
        const re = new RegExp(pattern, 'i');
        // 选项自身带了语境线索（"address the issue"）→ 一定在考这个引申义
        if (re.test(key)) {
          here = meaning;
          break;
        }
        // 否则看题干：空位把动词挖掉了（"We must ____ the issue"），
        // 线索在题干里，而这个选项正是候选动词 → 也要给出引申义。
        if (isMultiWord === false && re.test(stemText)) {
          here = meaning;
          break;
        }
      } catch {
        /* 关键词写错不影响其它条目 */
      }
    }
  }

  if (!here && entry.stemCtx) {
    for (const [pattern, meaning] of Object.entries(entry.stemCtx)) {
      try {
        if (new RegExp(pattern, 'i').test(stemText)) {
          here = meaning;
          break;
        }
      } catch {
        /* 同上 */
      }
    }
  }

  return {
    word: raw,
    matched: matchedWord,
    found: true,
    pos: entry.pos || '',
    gloss: entry.gloss || '',
    senses: entry.senses || [],
    rare: entry.rare || '',
    note: entry.note || '',
    phrase: entry.phrase || '',
    here,
  };
}

/**
 * 为一道题的每个选项给出释义。
 * 返回 { options: {A:{...}}, covered, total, missing:[], note }
 * covered 表示有词典释义的选项数 —— 界面据此决定是否还需要问模型。
 */
function glossQuestion(question) {
  const stem = question?.stem || '';
  const opts = question?.options || {};
  const options = {};
  const missing = [];
  let covered = 0;

  for (const [L, text] of Object.entries(opts)) {
    const hit = lookup(text, stem);
    if (hit) {
      covered += 1;
      options[L] = hit;
    } else {
      missing.push({ letter: L, text: String(text) });
      options[L] = {
        word: String(text),
        found: false,
        pos: '',
        gloss: '',
        senses: [],
        rare: '',
        note: '',
        phrase: '',
        here: '',
      };
    }
  }

  const total = Object.keys(opts).length;
  return {
    options,
    covered,
    total,
    missing,
    note:
      covered === total
        ? ''
        : `有 ${missing.length} 个选项未收录在本地释义库（${missing.map((m) => m.text).join('、')}）。可以配一个文本模型让它释义，或直接问。`,
  };
}

module.exports = { GLOSSARY, normalizeKey, lookup, glossQuestion };
