'use strict';

/**
 * 读取解析层测试。
 * 重点：模型读图必然出错（错字、漏项、字母标错），解析层必须"尽量能用 + 明确标出要人工确认的点"，
 * 而不是一遇格式漂移就整体失败。
 */

const test = require('node:test');
const assert = require('node:assert');
const ex = require('../src/core/extract.js');

test('能从代码块和闲聊里抠出 JSON', () => {
  assert.deepStrictEqual(ex.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.strictEqual(ex.extractJson('好的，结果如下：{"a":1} 以上。').a, 1);
  assert.strictEqual(ex.extractJson('没有 json'), null);
  assert.strictEqual(ex.extractJson(''), null);
});

test('容忍尾随逗号（模型常见瑕疵）', () => {
  const r = ex.extractJson('{"questions":[{"stem":"a",}],}');
  assert.strictEqual(r.questions[0].stem, 'a');
});

test('答案字母识别：中文、英文、纯字母都能认', () => {
  assert.strictEqual(ex.parseAnswerLetter('答案：B'), 'B');
  assert.strictEqual(ex.parseAnswerLetter('正确答案是 C'), 'C');
  assert.strictEqual(ex.parseAnswerLetter('Answer: d'), 'D');
  assert.strictEqual(ex.parseAnswerLetter('(A)'), 'A');
  assert.strictEqual(ex.parseAnswerLetter('B'), 'B');
  assert.strictEqual(ex.parseAnswerLetter('见解析'), '');
});

test('选项支持对象、数组、带前缀三种形态', () => {
  const fromObj = ex.normalizeQuestion({ stem: 'q', options: { A: 'go', B: 'goes' }, answer: 'B' });
  assert.deepStrictEqual(fromObj.options, { A: 'go', B: 'goes' });

  const fromArr = ex.normalizeQuestion({
    stem: 'q',
    options: [{ letter: 'A', text: 'go' }, { letter: 'B', text: 'goes' }],
    answer: 'B',
  });
  assert.deepStrictEqual(fromArr.options, { A: 'go', B: 'goes' });

  // 选项文本自带 "A. " 前缀时要剥掉，否则界面上会出现 "A. A. go"
  const withPrefix = ex.normalizeQuestion({ stem: 'q', options: { A: 'A. go', B: 'B) goes' }, answer: 'A' });
  assert.deepStrictEqual(withPrefix.options, { A: 'go', B: 'goes' });
});

test('答案字母不存在时，按选项内容反查并明确记录修正', () => {
  const q = ex.normalizeQuestion({
    stem: 'q',
    options: { A: 'go', B: 'goes', C: 'going', D: 'gone' },
    answer: 'E',
    // 模型把答案写成了选项内容
  });
  assert.ok(q.issues.some((i) => i.includes('E')), '应提示答案字母不合法');
});

test('答案写成选项原文时能自动纠正字母', () => {
  const q = ex.normalizeQuestion({
    stem: 'He ____ to school.',
    options: { A: 'go', B: 'goes', C: 'going', D: 'gone' },
    answer: 'goes',
  });
  assert.strictEqual(q.answer, 'B', '应把 "goes" 匹配回字母 B');
  assert.ok(q.issues.some((i) => i.includes('修正')), '修正必须让用户可见');
});

test('知识点支持字符串与数组，且去重去空', () => {
  const a = ex.normalizeQuestion({ stem: 'q', options: { A: 'a', B: 'b' }, answer: 'A', knowledgePoints: '时态、介词，时态' });
  assert.deepStrictEqual(a.knowledgePoints, ['时态', '介词']);
  const b = ex.normalizeQuestion({ stem: 'q', options: { A: 'a', B: 'b' }, answer: 'A', knowledgePoints: ['介词', '', '  '] });
  assert.deepStrictEqual(b.knowledgePoints, ['介词']);
});

test('缺少题干或选项过少时记入 issues 而不是静默通过', () => {
  const q = ex.normalizeQuestion({ options: { A: 'a' }, answer: 'A' });
  assert.ok(q.issues.some((i) => i.includes('题干')));
  assert.ok(q.issues.some((i) => i.includes('选项')));
});

test('完整解析模型输出：多题 + 汇总警告', () => {
  const raw = JSON.stringify({
    questions: [
      {
        stem: 'He ____ to school every day.',
        options: { A: 'go', B: 'goes', C: 'going', D: 'gone' },
        answer: 'B',
        explanation: '第三人称单数用 goes。',
        knowledgePoints: ['一般现在时'],
        difficulty: 'easy',
        confidence: 0.95,
      },
      {
        stem: 'She is good ____ math.',
        options: { A: 'at', B: 'in', C: 'on', D: 'for' },
        answer: 'A',
        knowledgePoints: ['介词搭配'],
        confidence: 0.5,
      },
    ],
  });
  const r = ex.parseExtraction(raw);
  assert.strictEqual(r.questions.length, 2);
  assert.strictEqual(r.questions[0].answer, 'B');
  assert.strictEqual(r.questions[1].options.A, 'at');
  assert.ok(r.warnings.some((w) => w.includes('置信度')), '低置信度必须提示用户核对');
});

test('模型输出完全跑偏时给出可读提示而不是抛异常', () => {
  const r = ex.parseExtraction('抱歉，我无法识别这张图片。');
  assert.strictEqual(r.questions.length, 0);
  assert.ok(r.warnings[0].includes('没有找到题目结构'));
});

test('单题对象（非数组）也能解析', () => {
  const r = ex.parseExtraction(JSON.stringify({ stem: 'q', options: { A: 'a', B: 'b' }, answer: 'A' }));
  assert.strictEqual(r.questions.length, 1);
});

test('看不清的字符会被标记，并在保存校验时提醒', () => {
  const q = ex.normalizeQuestion({
    stem: 'He [看不清] to school.',
    options: { A: 'go', B: 'goes' },
    answer: 'B',
    knowledgePoints: ['时态'],
  });
  const v = ex.validateForSave(q);
  assert.ok(v.warns.some((w) => w.includes('未识别字符')));
});

test('保存校验：缺答案、答案不在选项内都必须拦住', () => {
  const noAnswer = ex.validateForSave({ stem: 'q', options: { A: 'a', B: 'b' }, answer: '', knowledgePoints: ['x'] });
  assert.strictEqual(noAnswer.ok, false);
  assert.ok(noAnswer.errors.some((e) => e.includes('答案')));

  const badAnswer = ex.validateForSave({ stem: 'q', options: { A: 'a', B: 'b' }, answer: 'C', knowledgePoints: ['x'] });
  assert.strictEqual(badAnswer.ok, false);
  assert.ok(badAnswer.errors.some((e) => e.includes('不在选项中')));
});

test('保存校验：缺知识点只警告不拦截（用户可以先录入后补）', () => {
  const v = ex.validateForSave({ stem: 'He goes home.', options: { A: 'a', B: 'b' }, answer: 'A', knowledgePoints: [] });
  assert.strictEqual(v.ok, true, `不该拦截，实际错误：${v.errors.join('；')}`);
  assert.ok(v.warns.some((w) => w.includes('知识点')));
});

test('题干指纹：空格与标点差异不影响查重', () => {
  const a = ex.stemFingerprint('He  ____ to school, every day.');
  const b = ex.stemFingerprint('he ____ to school every day');
  assert.strictEqual(a, b, '同一道题的不同排版应得到相同指纹');
  assert.notStrictEqual(a, ex.stemFingerprint('She goes home.'));
});

test('提示词包含关键约束，避免模型自由发挥', () => {
  const p = ex.buildVisionPrompt({ answerInSource: false });
  assert.ok(p.includes('JSON'));
  assert.ok(p.includes('不要翻译'), '必须禁止翻译');
  assert.ok(p.includes('[看不清]'), '必须要求标出看不清的字符');
  assert.ok(p.includes('answer 留空'), '无答案场景必须要求留空而不是猜');

  const withAnswer = ex.buildVisionPrompt({ answerInSource: true });
  assert.ok(withAnswer.includes('答案'), '有答案场景应提示寻找印刷答案');
});

test('补全提示词带上了题干与选项', () => {
  const p = ex.buildAnalysisPrompt({ stem: 'He ____ to school.', options: { A: 'go', B: 'goes' } });
  assert.ok(p.includes('He ____ to school.'));
  assert.ok(p.includes('A. go'));
  assert.ok(p.includes('B. goes'));
  assert.ok(p.includes('JSON'));
});

/* ---------------- 抗干扰核对 ---------------- */

test('独立作答提示词：只给题干与选项，不给答案', () => {
  const p = ex.buildSolverPrompt({
    stem: 'He ____ to school every day.',
    options: { A: 'go', B: 'goes' },
    // 即使调用方传了 answer，也不该出现在提示词里
    answer: 'B',
  });
  assert.ok(p.includes('He ____ to school every day.'), '应包含题干');
  assert.ok(p.includes('A. go') && p.includes('B. goes'), '应包含选项');
  assert.ok(p.includes('JSON'), '应要求 JSON 输出');
  assert.ok(/独立/.test(p), '应明确要求独立完成');
  // 关键：不能泄露答案，否则模型会顺着走，"核对"退化成复读
  assert.ok(!/答案是\s*B|正确答案[：:]\s*B/.test(p), '提示词不得出现答案');
  assert.ok(!p.includes('answer": "B'), '提示词不得把答案当示例给出');
});

test('独立作答提示词：允许模型承认题目有问题，而不是硬猜', () => {
  const p = ex.buildSolverPrompt({ stem: '____', options: { A: 'a', B: 'b' } });
  assert.ok(/设为空字符串|不完整|多个选项/.test(p), '应允许模型表示无法确定');
});

test('答案比对：一致 / 冲突 / 无法判断 三种情况都要覆盖', () => {
  // 一致
  let r = ex.crossCheckAnswers('B', 'B');
  assert.strictEqual(r.status, 'agree');
  assert.ok(r.message.includes('一致'));

  // 大小写与空格归一化后仍算一致
  r = ex.crossCheckAnswers(' b ', 'B');
  assert.strictEqual(r.status, 'agree', '大小写/空格不该被当成不一致');

  // 冲突：必须如实列出两边分别是什么
  r = ex.crossCheckAnswers('C', 'B');
  assert.strictEqual(r.status, 'conflict');
  assert.ok(r.message.includes('C') && r.message.includes('B'), `要写清两边，实际 ${r.message}`);
  assert.ok(/核对|确认/.test(r.suggestion), '冲突时必须要求人工核对');

  // 一边缺失 → unknown，不能硬判成冲突（否则会误导用户去改对的答案）
  assert.strictEqual(ex.crossCheckAnswers('B', '').status, 'unknown');
  assert.strictEqual(ex.crossCheckAnswers('', 'B').status, 'unknown');
  assert.strictEqual(ex.crossCheckAnswers('', '').status, 'unknown');

  // 非法字母（模型可能返回 Z 或汉字）不能算有效答案
  assert.strictEqual(ex.crossCheckAnswers('B', 'Z').status, 'unknown');
  assert.strictEqual(ex.crossCheckAnswers('甲', 'B').status, 'unknown');
});

test('答案比对：识别的答案不可用时，提示参考独立作答但别直接采信', () => {
  const r = ex.crossCheckAnswers('', 'B');
  assert.strictEqual(r.status, 'unknown');
  assert.ok(r.message.includes('B'), '应告诉用户独立作答得出什么');
  assert.ok(/确认/.test(r.suggestion), '应提醒自己确认');
});
