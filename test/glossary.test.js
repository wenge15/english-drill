'use strict';

/**
 * 本地释义库测试。
 * 用户明确要求：词汇题要给出**每个选项**的意思，含熟词生义，以及本题语境下的意思；
 * 短语要有释疑。这份测试逐条锁住这四点。
 */

const test = require('node:test');
const assert = require('node:assert');
const g = require('../src/core/glossary.js');

test('常用义：能查到基本意思', () => {
  const hit = g.lookup('proud');
  assert.ok(hit, 'proud 应有词条');
  assert.ok(hit.gloss.includes('自豪'), `proud 的常用义应含"自豪"，实际 ${hit.gloss}`);
});

test('熟词生义：last / address / book 的不常见含义必须点出来', () => {
  const last = g.lookup('last');
  assert.ok(last.rare.includes('持续'), `last 的熟词生义应是"持续"，实际 ${last.rare}`);

  const address = g.lookup('address');
  assert.ok(address.rare.includes('处理'), `address 的熟词生义应是"处理"，实际 ${address.rare}`);

  const book = g.lookup('book');
  assert.ok(book.rare.includes('预订'), `book 的熟词生义应是"预订"，实际 ${book.rare}`);
});

test('本题语境义：同一个词在不同选项文本下给出不同意思', () => {
  // 约定：语境义是**按选项文本**判定的 —— 选项里带着语境关键词（issue/ticket/plane）才给引申义。
  // 这样同一题干下的干扰项不会被一起解释成引申义（"write the address of" 就是"地址"）。
  const a = g.lookup('address the issue', 'We must address the issue before it gets worse.');
  assert.ok(a.here.includes('处理'), `"address the issue" 的语境义应是"处理"，实际 ${JSON.stringify(a.here)}`);

  // 同一题干下，写成"地址"的那个选项不给引申义
  const distractor = g.lookup('write the address of', 'We must address the issue before it gets worse.');
  assert.strictEqual(distractor.here, '', '干扰项不该被套上"处理"这个引申义');

  const b = g.lookup('book a ticket', 'You should book a ticket in advance.');
  assert.ok(b.here.includes('预订'), `"book a ticket" 的语境义应是"预订"，实际 ${b.here}`);

  const c = g.lookup('take off', 'The plane will take off at 8.');
  assert.ok(c.here.includes('起飞'), `"take off" 在飞机语境下应是"起飞"，实际 ${JSON.stringify(c.here)}`);
  // 同一个短语、不同主语，意思应该变
  const d = g.lookup('take off', 'He took off his coat and sat down.');
  assert.ok(d.here.includes('脱下'), `主语是衣服时 take off 应是"脱下"，实际 ${JSON.stringify(d.here)}`);
});

test('短语释疑：短语要有构成拆解与整体意思', () => {
  for (const phrase of ['run out of', 'take off', 'pick up', 'look forward to', 'be used to', 'in no time']) {
    const hit = g.lookup(phrase);
    assert.ok(hit, `${phrase} 应有词条`);
    assert.ok(hit.phrase && hit.phrase.length > 8, `${phrase} 应有"短语释疑"（构成+整体意思），实际 ${JSON.stringify(hit.phrase)}`);
  }
});

test('易混点提示：borrow/lend、accept/receive、spend/take/pay 要讲清区别', () => {
  assert.ok(g.lookup('borrow').note.includes('from'), 'borrow 要提示 from');
  assert.ok(g.lookup('lend').note.includes('to'), 'lend 要提示 to');
  assert.ok(g.lookup('accept').note.includes('主观'), 'accept 要提示主观接受');
  assert.ok(g.lookup('receive').note.includes('客观'), 'receive 要提示客观收到');
  assert.ok(g.lookup('spend').note.includes('人'), 'spend 要提示主语是人');
});

test('介词类易混：since 与 for 的区别要写清', () => {
  const since = g.lookup('since');
  const forWord = g.lookup('for');
  assert.ok(since.note.includes('时间点'), 'since 要说明接时间点');
  assert.ok(forWord.note.includes('时间段'), 'for 要说明接时间段');
  // 在完成时的题干里要给语境义
  assert.ok(g.lookup('since', 'I have lived here ____ 2010.').here.includes('自从'));
  assert.ok(g.lookup('for', 'I have studied English ____ five years.').here.includes('持续'));
});test('未收录的词返回 null，绝不编造释义', () => {
  assert.strictEqual(g.lookup('xylophonequartz'), null);
  assert.strictEqual(g.lookup(''), null);
  assert.strictEqual(g.lookup(null), null);
});

test('查询容错：大小写、多余空格、冠词前缀', () => {
  assert.ok(g.lookup('  Last  '), '大小写与空格应被容错');
  assert.ok(g.lookup('the last'), '冠词前缀应被容错');
  assert.ok(g.lookup('RUN OUT OF'), '短语大写应能查到');
});

test('整题释义：逐个选项给出结果，并统计覆盖率', () => {
  const r = g.glossQuestion({
    stem: 'We must address the issue before it gets worse.',
    options: { A: 'write the address of', B: 'deal with', C: 'speak to', D: 'send to' },
  });
  assert.strictEqual(r.total, 4);
  assert.strictEqual(Object.keys(r.options).length, 4, '每个选项都要有位置');
  assert.ok(r.options.B.found === false || r.options.B.gloss, '未收录的选项也要有结构，不能缺项');
  assert.ok(typeof r.covered === 'number');
  assert.ok(r.note === '' || r.note.includes('未收录'), '有未收录时要说明');
});

test('整题释义：全部收录时不提示缺项', () => {
  const r = g.glossQuestion({
    stem: 'I have lived here ____ 2010.',
    options: { A: 'for', B: 'since', C: 'from', D: 'during' },
  });
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.covered, 4, `这四个词都应收录，实际覆盖 ${r.covered}`);
  assert.strictEqual(r.missing.length, 0);
  assert.strictEqual(r.note, '');
  // 每个选项都要有常用义
  for (const L of ['A', 'B', 'C', 'D']) {
    assert.ok(r.options[L].gloss, `选项 ${L} 应给出常用义`);
  }
});

test('词条结构完整：该有的字段不能少', () => {
  for (const [word, entry] of Object.entries(g.GLOSSARY)) {
    assert.ok(entry.gloss, `${word} 缺常用义`);
    for (const key of Object.keys(entry)) {
      assert.ok(
        ['pos', 'gloss', 'senses', 'rare', 'note', 'ctx', 'stemCtx', 'phrase'].includes(key),
        `${word} 有未知字段 ${key}`,
      );
    }
  }
  assert.ok(Object.keys(g.GLOSSARY).length >= 40, `释义库应有足够词条，实际 ${Object.keys(g.GLOSSARY).length}`);
});
