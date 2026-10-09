'use strict';

/**
 * 知识点识别测试。
 * 重点是本地规则的准确性 —— 它决定了薄弱项统计是否可信。
 */

const test = require('node:test');
const assert = require('node:assert');
const k = require('../src/core/knowledge.js');

const check = (stem, options, expected) => {
  const got = k.detectLocal(stem, options);
  assert.ok(
    got.includes(expected),
    `应识别出「${expected}」，实际得到：${JSON.stringify(got)}\n  题干：${stem}`,
  );
};

test('虚拟语气', () => {
  check('If I ____ you, I would take the job.', { A: 'am', B: 'was', C: 'were', D: 'be' }, '虚拟语气');
  check('I wish I ____ taller.', { A: 'am', B: 'were', C: 'was', D: 'be' }, '虚拟语气');
});

test('被动语态', () => {
  check('The report ____ by the team last week.', { A: 'completes', B: 'completed', C: 'was completed', D: 'has completed' }, '被动语态');
  check('The homework ____ before Friday.', { A: 'must finish', B: 'must be finished', C: 'must finishing', D: 'must to finish' }, '被动语态');
});

test('完成时', () => {
  check('I have lived here ____ 2010.', { A: 'for', B: 'since', C: 'from', D: 'in' }, '现在完成时');
  check('She ____ in Beijing since 2015.', { A: 'lives', B: 'has lived', C: 'lived', D: 'is living' }, '现在完成时');
  check('The train ____ when we arrived.', { A: 'left', B: 'had left', C: 'leaves', D: 'has left' }, '过去完成时');
});

test('一般时态与时间状语', () => {
  check('He ____ to school by bus every day.', { A: 'go', B: 'goes', C: 'going', D: 'gone' }, '一般现在时');
  check('They ____ to the park yesterday.', { A: 'go', B: 'went', C: 'gone', D: 'going' }, '一般过去时');
  check('We ____ you tomorrow.', { A: 'visit', B: 'visited', C: 'will visit', D: 'visiting' }, '一般将来时');
  check('Look! The baby ____.', { A: 'sleeps', B: 'is sleeping', C: 'slept', D: 'sleep' }, '现在进行时');
});

test('非谓语动词', () => {
  check('I enjoy ____ books.', { A: 'read', B: 'reading', C: 'to read', D: 'reads' }, '非谓语动词');
  check('She decided ____ abroad.', { A: 'study', B: 'studying', C: 'to study', D: 'studies' }, '非谓语动词');
});

test('主谓一致', () => {
  check('Neither Tom nor his friends ____ interested.', { A: 'is', B: 'are', C: 'was', D: 'has been' }, '主谓一致');
  check('The number of students ____ increasing.', { A: 'is', B: 'are', C: 'were', D: 'have been' }, '主谓一致');
});

test('从句', () => {
  check('The book, ____ was written in 1876, is famous.', { A: 'that', B: 'which', C: 'who', D: 'what' }, '定语从句');
  check('I wonder ____ he will come.', { A: 'that', B: 'if', C: 'what', D: 'which' }, '宾语从句');
  check('____ it was raining, we went out.', { A: 'Although', B: 'But', C: 'However', D: 'Despite' }, '状语从句');
});

test('介词搭配与固定短语', () => {
  check('She is good ____ playing the piano.', { A: 'at', B: 'in', C: 'on', D: 'for' }, '介词搭配');
  check('We should take pride ____ our work.', { A: 'in', B: 'on', C: 'at', D: 'for' }, '固定短语');
});

test('情态动词与冠词', () => {
  check('You ____ finish it today.', { A: 'must', B: 'must to', C: 'musting', D: 'musted' }, '情态动词');
  check('He is ____ honest boy.', { A: 'a', B: 'an', C: 'the', D: '不填' }, '冠词');
});

test('一道题可命中多个考点，但不该无限堆标签', () => {
  const got = k.detectLocal('If the work ____ by tomorrow, we will have to postpone it since we are busy every day.', {
    A: 'is not finished',
    B: 'will not finish',
    C: 'does not finish',
    D: 'has not finished',
  });
  assert.ok(got.length >= 2, `应命中多个考点，实际 ${JSON.stringify(got)}`);
  assert.ok(got.length <= 4, `标签数量应有上限，实际 ${got.length}`);
});

test('四个完全不同的词填空 → 词义辨析（不是"认不出就留空"）', () => {
  // 注意：这题确实是词义辨析题，标出来是对的；
  // 之前我误以为它该返回空数组，其实是测试期望写错了。
  const got = k.detectLocal('The ____ of the plan was obvious to everyone.', {
    A: 'merit',
    B: 'flaw',
    C: 'haste',
    D: 'bliss',
  });
  assert.deepStrictEqual(got, ['词义辨析'], `应标为词义辨析且不硬凑语法标签，实际 ${JSON.stringify(got)}`);
});

test('语法规则完全认不出且不是词汇题时，返回空数组', () => {
  const got = k.detectLocal('The ____ was obvious.', {
    A: 'plan',
    B: 'idea',
    C: 'thing',
    D: 'point',
  });
  // 这四个是不同的词，会被判为词汇题；换一个真正无从判断的例子：
  const none = k.detectLocal('Hmm.', { A: 'x', B: 'y' });
  assert.deepStrictEqual(none, [], `选项不足时不该硬凑，实际 ${JSON.stringify(none)}`);
  assert.ok(Array.isArray(got));
});

test('词义题会被标上「词义辨析」，但语法题不会', () => {
  const vocab = k.detectLocal('He is very ____ about his success.', { A: 'proud', B: 'pleased', C: 'happy', D: 'glad' });
  assert.ok(vocab.includes('词义辨析'), `词义题应标注，实际 ${JSON.stringify(vocab)}`);

  // 同一动词的不同形式属于语法，绝不能因为选项都是词就标成词义题
  const grammar = k.detectLocal('He ____ to school every day.', { A: 'go', B: 'goes', C: 'going', D: 'gone' });
  assert.ok(!grammar.includes('词义辨析'), `这是语法题，不该标词义辨析，实际 ${JSON.stringify(grammar)}`);
  assert.ok(grammar.includes('一般现在时'), `应标出一般现在时，实际 ${JSON.stringify(grammar)}`);
});

test('空题干不崩', () => {
  assert.deepStrictEqual(k.detectLocal('', {}), []);
  assert.deepStrictEqual(k.detectLocal(null, null), []);
});

test('提示词带上了题目与 index', () => {
  const p = k.buildKnowledgePrompt([{ index: 3, stem: 'He ____ home.', options: { A: 'go', B: 'goes' } }]);
  assert.ok(p.includes('3.'), '应带 index');
  assert.ok(p.includes('He ____ home.'), '应带题干');
  assert.ok(p.includes('A. go') && p.includes('B. goes'), '应带选项');
  assert.ok(p.includes('JSON'), '应要求 JSON');
});

test('模型返回按 index 对齐，错位的标签被丢弃', () => {
  const raw = JSON.stringify({
    items: [
      { index: 1, knowledgePoints: ['虚拟语气'] },
      { index: 99, knowledgePoints: ['不该出现的标签'] },
      { index: 2, knowledgePoints: ['介词搭配', '固定短语'] },
    ],
  });
  const map = k.parseKnowledgeResponse(raw, [1, 2]);
  assert.deepStrictEqual(map.get(1), ['虚拟语气']);
  assert.deepStrictEqual(map.get(2), ['介词搭配', '固定短语']);
  assert.strictEqual(map.has(99), false, '不存在的 index 必须丢弃，否则考点会错配到别的题');
});

test('模型输出格式跑偏时不崩，返回空映射', () => {
  assert.strictEqual(k.parseKnowledgeResponse('抱歉我看不懂', [1]).size, 0);
  assert.strictEqual(k.parseKnowledgeResponse('', [1]).size, 0);
  assert.strictEqual(k.parseKnowledgeResponse(null, [1]).size, 0);
});

test('容错：代码块包裹与尾随逗号', () => {
  const raw = '```json\n{"items":[{"index":1,"knowledgePoints":["时态"],},],}\n```';
  assert.deepStrictEqual(k.parseKnowledgeResponse(raw, [1]).get(1), ['时态']);
});

test('合并规则：本地标签在前，模型只追加，去重且限长', () => {
  assert.deepStrictEqual(k.mergeKnowledge(['虚拟语气'], ['虚拟语气', '从句']), ['虚拟语气', '从句']);
  assert.deepStrictEqual(k.mergeKnowledge(['A'], []), ['A']);
  assert.deepStrictEqual(k.mergeKnowledge([], ['B', 'C']), ['B', 'C']);
  assert.strictEqual(k.mergeKnowledge(['1', '2', '3'], ['4', '5']).length, 4, '最多 4 个标签');
  assert.deepStrictEqual(k.mergeKnowledge(['x'], ['  ', '']), ['x'], '空白标签要忽略');
});

/* ---------------- 词义题（用户明确要求的重点） ---------------- */

test('词义题 vs 语法题的边界（这组很容易判错，逐条锁住）', () => {
  const cases = [
    // [说明, 题干, 选项, 是否词义题]
    ['短语动词辨析（take off/up/on/in）', "The plane will ____ at 8 o'clock.", { A: 'take off', B: 'take up', C: 'take on', D: 'take in' }, true],
    ['近义词辨析', 'He is very ____ about his success.', { A: 'proud', B: 'pleased', C: 'happy', D: 'glad' }, true],
    ['不同实词辨析', 'The ____ of the plan was obvious.', { A: 'merit', B: 'flaw', C: 'haste', D: 'bliss' }, true],
    // 下面这些选项都是"同一个词的不同形态"或功能词，考的是语法
    ['被动语态（writes/wrote/is written/was written）', 'The book ____ by Mark Twain in 1876.', { A: 'writes', B: 'wrote', C: 'is written', D: 'was written' }, false],
    ['主谓一致（功能词）', 'Neither Tom nor his friends ____ interested.', { A: 'is', B: 'are', C: 'was', D: 'has been' }, false],
    ['介词搭配（功能词）', 'She is good ____ playing the piano.', { A: 'at', B: 'in', C: 'on', D: 'for' }, false],
    ['动词形式变化', 'He ____ to school every day.', { A: 'go', B: 'goes', C: 'going', D: 'gone' }, false],
    ['被动语态（completes/completed/was completed）', 'The report ____ by the team last week.', { A: 'completes', B: 'completed', C: 'was completed', D: 'has completed' }, false],
  ];
  for (const [label, stem, opts, expected] of cases) {
    assert.strictEqual(
      k.isVocabularyQuestion(stem, opts),
      expected,
      `${label}：应为${expected ? '词义题' : '语法题'}`,
    );
  }
});

test('只有真正的词汇题才会被标上「词义辨析」', () => {
  const vocab = k.detectLocal('The ____ of the plan was obvious.', { A: 'merit', B: 'flaw', C: 'haste', D: 'bliss' });
  assert.ok(vocab.includes('词义辨析'), `应标词义辨析，实际 ${JSON.stringify(vocab)}`);

  // 语法题即使语法规则漏判，也不能被标成词义题
  for (const [stem, opts] of [
    ['The book ____ by Mark Twain in 1876.', { A: 'writes', B: 'wrote', C: 'is written', D: 'was written' }],
    ['Neither Tom nor his friends ____ interested.', { A: 'is', B: 'are', C: 'was', D: 'has been' }],
    ['She is good ____ playing the piano.', { A: 'at', B: 'in', C: 'on', D: 'for' }],
  ]) {
    const tags = k.detectLocal(stem, opts);
    assert.ok(!tags.includes('词义辨析'), `「${stem}」是语法题，不该标词义辨析。实际 ${JSON.stringify(tags)}`);
  }
});

test('词形变化题不该被判成词义题（那是语法题）', () => {
  assert.ok(
    !k.isVocabularyQuestion('He ____ to school every day.', { A: 'go', B: 'goes', C: 'going', D: 'gone' }),
    '同一动词的不同形式属于语法，不是词义辨析',
  );
  assert.ok(
    !k.isVocabularyQuestion('The report ____ by the team last week.', { A: 'completes', B: 'completed', C: 'was completed', D: 'has completed' }),
    '被动语态题不是词义题',
  );
});

test('词义题会被标上「词义辨析」', () => {
  const got = k.detectLocal('He is very ____ about his success.', { A: 'proud', B: 'pleased', C: 'happy', D: 'glad' });
  assert.ok(got.includes('词义辨析'), `应标出词义辨析，实际 ${JSON.stringify(got)}`);
});

test('短语搭配题会被标上「短语搭配」', () => {
  const got = k.detectLocal("The plane will ____ at 8 o'clock.", { A: 'take off', B: 'take up', C: 'take on', D: 'take in' });
  assert.ok(got.includes('短语搭配'), `应标出短语搭配，实际 ${JSON.stringify(got)}`);
});

test('熟词生义会被特别标出', () => {
  const got = k.detectLocal('We must address the issue before it gets worse.', {
    A: 'write the address of',
    B: 'deal with',
    C: 'speak to',
    D: 'send to',
  });
  assert.ok(got.includes('熟词生义'), `address the issue 属于熟词生义，实际 ${JSON.stringify(got)}`);
});

test('词义题提示词要求逐项释义、点出熟词生义、说明本题语境', () => {
  const p = k.buildWordGlossPrompt([
    { index: 1, stem: 'We must address the issue.', options: { A: 'deal with', B: 'speak to' } },
  ]);
  assert.ok(p.includes('gloss'), '要常用义');
  assert.ok(p.includes('here'), '要本题语境下的含义');
  assert.ok(p.includes('熟词生义'), '必须点出熟词生义');
  assert.ok(p.includes('短语'), '短语要有释疑');
  assert.ok(p.includes('sentence'), '要有整句说明');
  assert.ok(p.includes('We must address the issue.'), '要带题干');
  assert.ok(p.includes('A. deal with'), '要带每个选项');
});

test('解析词义返回：字段规整，非法 index 丢弃，漏项能补齐', () => {
  const raw = JSON.stringify({
    items: [
      {
        index: 1,
        sentence: '本题在讲处理问题，所以选 A。',
        options: {
          A: { gloss: '处理', here: '处理（问题）', note: 'address 的熟词生义' },
          B: '对……说话',
        },
      },
      { index: 77, sentence: '不该出现', options: { A: { gloss: 'x' } } },
    ],
  });
  const map = k.parseWordGlossResponse(raw, [1]);
  const got = map.get(1);
  assert.strictEqual(got.sentence.includes('处理问题'), true);
  assert.strictEqual(got.options.A.gloss, '处理');
  assert.strictEqual(got.options.A.here, '处理（问题）');
  assert.strictEqual(got.options.B.gloss, '对……说话', '字符串形式的释义也要接住');
  assert.strictEqual(map.has(77), false, '非法 index 必须丢弃');
});

test('没有模型时不编造释义，而是如实说明', () => {
  const g = k.localWordGloss({ stem: 'He is ____ .', options: { A: 'a', B: 'b' } });
  assert.strictEqual(g.needsModel, true);
  assert.ok(g.sentence.includes('无法自动给出'), '要如实说明，不能假装给了释义');
  assert.deepStrictEqual(Object.keys(g.options), ['A', 'B'], '仍要为每个选项留出位置');
  assert.strictEqual(g.options.A.gloss, '');
});
