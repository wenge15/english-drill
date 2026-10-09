'use strict';

/**
 * 文本导入解析器测试。
 * 这份测试直接对应真实用法：用户把 AI 转写的题目粘进来，格式必然不统一。
 */

const test = require('node:test');
const assert = require('node:assert');
const tp = require('../src/core/textparse.js');

test('标准格式：每行一个选项', () => {
  const r = tp.parseQuestionsFromText(`21. He ____ to school by bus every day.
A. go
B. goes
C. going
D. gone
答案：B`);
  assert.strictEqual(r.questions.length, 1);
  const q = r.questions[0];
  assert.strictEqual(q.number, 21);
  assert.strictEqual(q.stem, 'He ____ to school by bus every day.');
  assert.deepStrictEqual(q.options, { A: 'go', B: 'goes', C: 'going', D: 'gone' });
  assert.strictEqual(q.answer, 'B');
});

test('多题连续：题号切分正确，答案各归其位', () => {
  const r = tp.parseQuestionsFromText(`21. He ____ to school.
A. go
B. goes
C. going
D. gone
答案：B
22. The report ____ by the team last week.
A. completes
B. completed
C. was completed
D. has completed
答案：C`);
  assert.strictEqual(r.questions.length, 2);
  assert.strictEqual(r.questions[0].number, 21);
  assert.strictEqual(r.questions[0].answer, 'B');
  assert.strictEqual(r.questions[1].number, 22);
  assert.strictEqual(r.questions[1].answer, 'C');
  assert.strictEqual(r.questions[1].options.C, 'was completed');
});

test('选项各种写法都能认：顿号、括号、冒号、同行', () => {
  const variants = [
    'A、go\nB、goes\nC、going\nD、gone',
    '(A) go\n(B) goes\n(C) going\n(D) gone',
    'A) go\nB) goes\nC) going\nD) gone',
    'A: go\nB: goes\nC: going\nD: gone',
    'A. go  B. goes  C. going  D. gone',
  ];
  for (const v of variants) {
    const r = tp.parseQuestionsFromText(`1. He ____ to school.\n${v}\n答案：B`);
    assert.deepStrictEqual(
      r.questions[0].options,
      { A: 'go', B: 'goes', C: 'going', D: 'gone' },
      `这种写法没解析对：${JSON.stringify(v)}`,
    );
  }
});

test('答案写法各种变体', () => {
  for (const a of ['答案：B', '答案 B', '答案是 B', '正确答案：B', 'Answer: B', '答案选 B', 'B']) {
    // 注意：要用拼接构造用例。若用 replace 把 "答案：B" 换成 "B"，
    // 会连带把选项行 "B. goes" 改成 ". goes"，那是测试自身的 bug 而不是解析器的。
    const text = `1. He ____ to school.\nA. go\nB. goes\n${a}`;
    const r = tp.parseQuestionsFromText(text);
    assert.strictEqual(r.questions[0].answer, 'B', `没认出这种答案写法：${a}`);
  }
});

test('题干跨行时能正确合并，不会把续行当选项', () => {
  const r = tp.parseQuestionsFromText(`3. The manager, together with his assistants,
____ the meeting yesterday.
A. attend
B. attends
C. attended
D. attending
答案：C`);
  const q = r.questions[0];
  assert.ok(q.stem.includes('The manager'), '题干第一段应保留');
  assert.ok(q.stem.includes('the meeting yesterday'), '题干续行应并入题干');
  assert.deepStrictEqual(Object.keys(q.options).sort(), ['A', 'B', 'C', 'D']);
  assert.strictEqual(q.stem.includes('A. attend'), false, '选项不能混进题干');
});

test('题干里的答案文本会被剥掉（否则练习时会漏答案）', () => {
  const r = tp.parseQuestionsFromText(`1. He ____ to school. 答案：B
A. go
B. goes`);
  assert.strictEqual(r.questions[0].answer, 'B');
  assert.ok(!/答案/.test(r.questions[0].stem), `题干里不该残留答案标记：${r.questions[0].stem}`);
});

test('题干里的数字年份不会被误当题号', () => {
  const r = tp.parseQuestionsFromText(`5. The war ended in 1945.
A. 1945
B. 1939
答案：A`);
  assert.strictEqual(r.questions.length, 1, '1945. 不能被当成新题号');
  assert.strictEqual(r.questions[0].number, 5);
  assert.ok(r.questions[0].stem.includes('1945'));
});

test('部分题缺答案时给出明确警告（粘贴事故最常见的形态）', () => {
  const r = tp.parseQuestionsFromText(`1. First ____ question.
A. a
B. b
答案：A
2. Second ____ question.
A. a
B. b`);
  assert.strictEqual(r.questions.length, 2);
  assert.strictEqual(r.questions[1].answer, '');
  assert.ok(r.warnings.some((w) => w.includes('只找到 1 个答案')), `应有答案缺失警告：${r.warnings.join('|')}`);
  assert.ok(r.questions[1].issues.some((i) => i.includes('未找到答案')));
});

test('完全没有题号时退化为整段一题，并提示', () => {
  const r = tp.parseQuestionsFromText(`He ____ to school every day.
A. go
B. goes
答案：B`);
  assert.strictEqual(r.questions.length, 1);
  assert.ok(r.warnings.some((w) => w.includes('没有识别到题号')));
});

test('忽略题号前的说明文字，并告知用户', () => {
  const r = tp.parseQuestionsFromText(`Choose the best answer for each blank.
1. He ____ to school.
A. go
B. goes
答案：B`);
  assert.strictEqual(r.questions.length, 1);
  assert.ok(r.warnings.some((w) => w.includes('说明文字')));
});

test('题号重复会被指出来', () => {
  const r = tp.parseQuestionsFromText(`1. First.
A. a
B. b
1. Duplicated.
A. a
B. b`);
  assert.ok(r.warnings.some((w) => w.includes('题号重复')));
});

test('空输入不崩，返回可读提示', () => {
  const r = tp.parseQuestionsFromText('');
  assert.strictEqual(r.questions.length, 0);
  assert.ok(r.warnings.length > 0);
});

test('答案表：1-5 BCDAB 区间形式', () => {
  const m = tp.parseAnswerKey('1-5 BCDAB\n6-10 ACBDA');
  assert.strictEqual(m.get(1), 'B');
  assert.strictEqual(m.get(5), 'B');
  assert.strictEqual(m.get(6), 'A');
  assert.strictEqual(m.get(10), 'A');
});

test('答案表：1.B 2.C 3.A 键值形式', () => {
  const m = tp.parseAnswerKey('1.B 2.C 3.A 4.D');
  assert.strictEqual(m.get(1), 'B');
  assert.strictEqual(m.get(4), 'D');
});

test('答案表：纯字母串按顺序对应', () => {
  const m = tp.parseAnswerKey('B C A D');
  assert.strictEqual(m.get(1), 'B');
  assert.strictEqual(m.get(4), 'D');
});

test('答案表应用到题目：题号对不上时不静默错配', () => {
  const r = tp.parseQuestionsFromText(`1. First.
A. a
B. b
2. Second.
A. a
B. b`);
  const map = tp.parseAnswerKey('1.A');
  const res = tp.applyAnswerKey(r.questions, map);
  assert.strictEqual(res.applied, 1);
  assert.strictEqual(r.questions[0].answer, 'A');
  assert.strictEqual(r.questions[1].answer, '', '没匹配到的题不能瞎填答案');
  assert.deepStrictEqual(res.unmatched, [2]);
});

test('真实场景：AI 转写的完整试卷文本端到端解析', () => {
  // 这段文本模拟"宿主读图后返回的内容"——它其实就来自我读那张 exam-photo.png 的结果
  const aiOutput = `Choose the best answer for each blank.

21. He ____ to school by bus every day.
A. go
B. goes
C. going
D. gone

22. The report ____ by the team last week.
A. completes
B. completed
C. was completed
D. has completed

23. I have lived here ____ 2010.
A. for
B. since
C. from
D. during

Answers: 21-B  22-C  23-B`;

  const r = tp.parseQuestionsFromText(aiOutput);
  assert.strictEqual(r.questions.length, 3, `应解析出 3 题，实际 ${r.questions.length}`);

  // 答案在末尾且逐题带答案标记，应能直接命中
  assert.strictEqual(r.questions[0].answer, 'B');
  assert.strictEqual(r.questions[1].answer, 'C');
  assert.strictEqual(r.questions[2].answer, 'B');

  assert.deepStrictEqual(r.questions[1].options, {
    A: 'completes', B: 'completed', C: 'was completed', D: 'has completed',
  });
  assert.ok(r.questions[2].stem.includes('2010'), '题干里的年份要保留');
  // 三题都有答案，不该报"答案缺失"
  assert.ok(!r.warnings.some((w) => w.includes('只找到')), `不该有答案缺失警告：${r.warnings.join('|')}`);
});

test('真实场景：答案统一列在末尾时需要答案表补全', () => {
  const body = `21. He ____ to school.
A. go
B. goes
22. The report ____ last week.
A. completes
B. completed`;
  const r = tp.parseQuestionsFromText(body);
  assert.strictEqual(r.questions.filter((q) => !q.answer).length, 2, '这种排版下两题都还没答案');

  const map = tp.parseAnswerKey('21-B 22-B');
  const res = tp.applyAnswerKey(r.questions, map);
  assert.strictEqual(res.applied, 2);
  assert.strictEqual(r.questions[0].answer, 'B');
  assert.strictEqual(r.questions[1].answer, 'B');
});
