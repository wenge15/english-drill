'use strict';

/**
 * 知识点识别 + 对话窗口 + 第二次错讲评 的测试。
 * 这些是用户明确要求的功能，必须有测试保护。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../src/host.js');

const TEST_ROOT = path.join(__dirname, '..', 'data', 'test');
function tmpDir() {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_ROOT, 'teach-'));
}

function mkHost(config) {
  const host = createHost({ dataDir: tmpDir() });
  host.repo.setSetting('shuffleOptions', false);
  host.repo.setSetting('shuffleOrder', false);
  if (config) host.store.set(config);
  return host;
}

/** 假模型服务：按 prompt 内容返回，同时记录收到的消息。 */
function fakeModel(handler) {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        received.push(parsed);
        const content = handler(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

const SAMPLE = `1. If I ____ you, I would take the job.
A. am
B. was
C. were
D. be
答案：C

2. She ____ in Beijing since 2015.
A. lives
B. has lived
C. lived
D. is living
答案：B`;

test('录入题目时自动识别知识点（不需要模型）', async () => {
  const host = mkHost();
  const r = await host.invoke('import:parseText', { text: SAMPLE });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.questions.length, 2);
  assert.ok(r.questions[0].knowledgePoints.includes('虚拟语气'), `第1题应识别出虚拟语气，实际 ${JSON.stringify(r.questions[0].knowledgePoints)}`);
  assert.ok(r.questions[1].knowledgePoints.includes('现在完成时'), `第2题应识别出完成时，实际 ${JSON.stringify(r.questions[1].knowledgePoints)}`);
  assert.ok(r.warnings.some((w) => w.includes('自动识别')), '应告诉用户已自动标注');
  host.close();
});

test('一键给题库里的旧题补知识点', async () => {
  const host = mkHost();
  // 先存一道没有知识点的题
  await host.invoke('questions:save', {
    questions: [{ stem: 'If I ____ you, I would go.', options: { A: 'am', B: 'was', C: 'were', D: 'be' }, answer: 'C' }],
  });
  const before = await host.invoke('questions:list', {});
  assert.deepStrictEqual(before.questions[0].knowledgePoints, []);

  const r = await host.invoke('knowledge:tagBank', { useModel: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.updated, 1);

  const after = await host.invoke('questions:list', {});
  assert.ok(after.questions[0].knowledgePoints.includes('虚拟语气'));
  host.close();
});

test('补知识点：没配模型时只用本地规则，并说明情况', async () => {
  const host = mkHost();
  const r = await host.invoke('knowledge:autoTag', {
    questions: [{ stem: 'She ____ here since 2015.', options: { A: 'lives', B: 'has lived', C: 'lived', D: 'is living' } }],
    useModel: true,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.usedModel, false);
  assert.ok(r.items[0].knowledgePoints.includes('现在完成时'));
  assert.ok(r.notes.length > 0, '应说明为什么没用模型');
  host.close();
});

test('补知识点：配了模型时把模型结论追加进来', async () => {
  const fake = await fakeModel(() =>
    JSON.stringify({ items: [{ index: 1, knowledgePoints: ['固定搭配 take pride in'] }] }),
  );
  const host = mkHost({ baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'k', model: 'text-model' });
  const r = await host.invoke('knowledge:autoTag', {
    questions: [{ stem: 'If I ____ you, I would take the job.', options: { A: 'am', B: 'was', C: 'were', D: 'be' } }],
  });
  assert.strictEqual(r.usedModel, true);
  assert.ok(r.items[0].knowledgePoints.includes('虚拟语气'), '本地标签应保留');
  assert.ok(r.items[0].knowledgePoints.includes('固定搭配 take pride in'), '模型标签应追加');
  fake.server.close();
  host.close();
});

/* ---------------- 第二次做错的讲评 ---------------- */

test('讲评材料：给出知识点与前几次选错的具体答案', async () => {
  const host = mkHost();
  const parsed = await host.invoke('import:parseText', { text: SAMPLE });
  await host.invoke('import:commit', { questions: parsed.questions });

  // 第一轮：故意选错
  const s1 = await host.invoke('practice:start', { force: true });
  const q = s1.session.items.find((x) => x.stem.includes('If I'));
  // 第一次错：选 A
  await host.invoke('practice:answer', { sessionId: s1.session.id, questionId: q.questionId, picked: 'A' });
  const teach1 = await host.invoke('teach:mistake', { questionId: q.questionId, sessionId: s1.session.id });
  assert.strictEqual(teach1.wrongCount, 1);
  assert.strictEqual(teach1.needsTeaching, false, '第一次错还不必展开讲评');
  assert.strictEqual(teach1.wrongAttempts.length, 1);
  assert.strictEqual(teach1.wrongAttempts[0].picked, 'A');

  // 重做轮再错一次：选 B
  await host.invoke('practice:finish', { sessionId: s1.session.id });
  await host.invoke('practice:retry', { sessionId: s1.session.id });
  await host.invoke('practice:answer', { sessionId: s1.session.id, questionId: q.questionId, picked: 'B', round: 2 });
  const teach2 = await host.invoke('teach:mistake', { questionId: q.questionId, sessionId: s1.session.id });
  assert.strictEqual(teach2.wrongCount, 2, '累计应错 2 次');
  assert.strictEqual(teach2.needsTeaching, true, '第二次错才展开讲评');
  const picked = teach2.wrongAttempts.map((x) => x.picked);
  assert.ok(picked.includes('A') && picked.includes('B'), `应记录两次选的答案，实际 ${JSON.stringify(picked)}`);
  // 讲评必须带知识点
  assert.ok(teach2.question.knowledgePoints.length > 0, '讲评必须带知识点');
  // 而且要说清正确选项的文本
  assert.strictEqual(teach2.question.answerText, 'were');
  host.close();
});

test('讲评材料在从未做错时不误报', async () => {
  const host = mkHost();
  const parsed = await host.invoke('import:parseText', { text: SAMPLE });
  await host.invoke('import:commit', { questions: parsed.questions });
  const s = await host.invoke('practice:start', { force: true });
  const q = s.session.items[0];
  const t = await host.invoke('teach:mistake', { questionId: q.questionId, sessionId: s.session.id });
  assert.strictEqual(t.wrongCount, 0);
  assert.strictEqual(t.needsTeaching, false);
  host.close();
});

/* ---------------- 对话窗口 ---------------- */

test('没配模型时提问会明确告知，并给出可复制的上下文', async () => {
  const host = mkHost();
  const parsed = await host.invoke('import:parseText', { text: SAMPLE });
  await host.invoke('import:commit', { questions: parsed.questions });
  const list = await host.invoke('questions:list', {});
  const q = list.questions[0];

  const r = await host.invoke('chat:ask', { questionId: q.id, message: '为什么不能选 A？' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NO_MODEL');
  assert.ok(r.context.includes(q.stem), '上下文里要有题干，方便复制出去提问');
  assert.ok(r.threadId, '即使没配模型也要把这条问题存进对话记录');
  host.close();
});

test('配了模型时提问：自动带上题目与作答历史作为上下文', async () => {
  const fake = await fakeModel(() => '因为 were 是虚拟语气的固定用法。');
  const host = mkHost({ baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'k', model: 'text-model' });

  const parsed = await host.invoke('import:parseText', { text: SAMPLE });
  await host.invoke('import:commit', { questions: parsed.questions });
  const list = await host.invoke('questions:list', {});
  const q = list.questions.find((x) => x.stem.includes('If I'));

  // 先做错一次，制造历史
  const s = await host.invoke('practice:start', { force: true });
  await host.invoke('practice:answer', { sessionId: s.session.id, questionId: q.id, picked: 'A' });
  await host.invoke('practice:finish', { sessionId: s.session.id });

  const r = await host.invoke('chat:ask', { questionId: q.id, message: '为什么不能选 A？' });
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.ok(r.reply.includes('were'));

  // 关键：送给模型的消息里必须包含题干、选项、正确答案、知识点、以及我的作答历史
  const sent = JSON.stringify(fake.received[0].messages);
  assert.ok(sent.includes('If I'), '上下文应含题干');
  assert.ok(sent.includes('were'), '上下文应含正确选项文本');
  assert.ok(sent.includes('虚拟语气'), '上下文应含知识点');
  assert.ok(sent.includes('选A') || sent.includes('选 A'), `上下文应含我的作答历史，实际片段：${sent.slice(0, 400)}`);
  fake.server.close();
  host.close();
});

test('对话记录会保存，并能取回继续追问', async () => {
  const fake = await fakeModel((body) => {
    const last = body.messages[body.messages.length - 1].content;
    return `回答：${last}`;
  });
  const host = mkHost({ baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'k', model: 'text-model' });

  const r1 = await host.invoke('chat:ask', { message: '什么是虚拟语气？' });
  assert.strictEqual(r1.ok, true);
  const tid = r1.threadId;

  const r2 = await host.invoke('chat:ask', { threadId: tid, message: '那 would 呢？' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.threadId, tid, '续问应落在同一个对话里');

  const msgs = await host.invoke('chat:messages', { threadId: tid });
  assert.strictEqual(msgs.ok, true);
  assert.strictEqual(msgs.messages.length, 4, '两问两答应有 4 条消息');
  assert.strictEqual(msgs.messages[0].role, 'user');
  assert.strictEqual(msgs.messages[1].role, 'assistant');
  assert.ok(msgs.messages[1].content.includes('什么是虚拟语气'));

  // 第二次请求应带上第一轮的历史（否则模型不知道在追问什么）
  const second = fake.received[1].messages.map((m) => m.content).join('\n');
  assert.ok(second.includes('什么是虚拟语气'), '追问时应把上一轮对话一起发给模型');
  fake.server.close();
  host.close();
});

test('模型回答失败时给出可读提示，并把错误留在对话里', async () => {
  const host = mkHost({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', timeoutMs: 800 });
  const r = await host.invoke('chat:ask', { message: '这题怎么理解？' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.length > 0);
  const msgs = await host.invoke('chat:messages', { threadId: r.threadId });
  assert.strictEqual(msgs.messages.length, 2, '问题和失败提示都应留存');
  assert.strictEqual(msgs.messages[1].error, true);
  host.close();
});

test('空提问被拦住，不浪费一次调用', async () => {
  const host = mkHost();
  const r = await host.invoke('chat:ask', { message: '   ' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('输入问题'));
  host.close();
});

/* ---------------- 词汇题逐项释义（用户明确的重点要求） ---------------- */

test('词汇题释义：本地释义库直接给出每个选项的意思，不需要模型', async () => {
  const host = mkHost();
  await host.invoke('questions:save', {
    questions: [
      {
        stem: 'The plane will ____ at 8 o\'clock.',
        options: { A: 'take off', B: 'take up', C: 'take on', D: 'take in' },
        answer: 'A',
      },
    ],
  });
  const list = await host.invoke('questions:list', {});
  const q = list.questions[0];
  const r = await host.invoke('knowledge:explainWords', { questionId: q.id });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'local', '本地释义库应能覆盖，无需模型');
  assert.strictEqual(r.covered, 4, `四个选项都该有释义，实际 ${r.covered}`);
  assert.strictEqual(r.total, 4);
  // 每个选项都要有常用义与短语释疑
  for (const L of ['A', 'B', 'C', 'D']) {
    assert.ok(r.gloss.options[L].gloss, `选项 ${L} 应有常用义`);
    assert.ok(r.gloss.options[L].phrase, `选项 ${L} 是短语，应有释疑`);
  }
  // 本题语境义：飞机 → 起飞
  assert.ok(r.gloss.options.A.here.includes('起飞'), `take off 本题意思应是"起飞"，实际 ${r.gloss.options.A.here}`);
  host.close();
});

test('词汇题释义：熟词生义会单独给出，且只给真正用引申义的那个选项', async () => {
  const host = mkHost();
  await host.invoke('questions:save', {
    questions: [
      {
        stem: 'We must ____ the issue before it gets worse.',
        options: { A: 'address', B: 'speak to', C: 'write to', D: 'send to' },
        answer: 'A',
        knowledgePoints: ['熟词生义'],
      },
    ],
  });
  const list = await host.invoke('questions:list', {});
  const q = list.questions[0];
  const r = await host.invoke('knowledge:explainWords', { questionId: q.id });
  assert.strictEqual(r.ok, true);
  // address 的熟词生义必须点出
  assert.ok(r.gloss.options.A.rare.includes('处理'), `address 应给出熟词生义"处理"，实际 ${r.gloss.options.A.rare}`);
  // 每个选项都要有释义
  for (const L of ['A', 'B', 'C', 'D']) {
    assert.ok(r.gloss.options[L].found, `选项 ${L} 应被收录`);
    assert.ok(r.gloss.options[L].gloss, `选项 ${L} 应有常用义`);
  }
  host.close();
});

test('词汇题释义：本地未收录时明确告知，不编造意思', async () => {
  const host = mkHost();
  await host.invoke('questions:save', {
    questions: [
      {
        stem: 'The ____ of the plan was obvious.',
        options: { A: 'xylophonequartz', B: 'zzzunknownword', C: 'qwertyuiop', D: 'asdfghjkl' },
        answer: 'A',
      },
    ],
  });
  const list = await host.invoke('questions:list', {});
  const q = list.questions[0];
  const r = await host.invoke('knowledge:explainWords', { questionId: q.id });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.covered, 0, '一个都不该被"编"出释义');
  assert.ok(r.note.includes('未收录'), `应明确告知未收录，实际 ${r.note}`);
  for (const L of ['A', 'B', 'C', 'D']) {
    assert.strictEqual(r.gloss.options[L].gloss, '', `选项 ${L} 不该被编造释义`);
  }
  host.close();
});

/* ---------------- 预置校准（旧配置拿不到新默认值的问题） ---------------- */

test('预置校准：从没保存过的配置也能匹配上预置并补全读图模型', async () => {
  // 踩过的坑：用户从没保存过时 store 里 baseUrl 是空的，界面显示的是默认值。
  // 若拿空字符串去比对预置就永远匹配不上，"按预置更新"形同虚设。
  const host = mkHost(); // 不设任何 config，模拟全新/从未保存的状态
  const before = await host.invoke('settings:get');
  assert.strictEqual(before.settings.visionModel, 'deepseek-flash', '界面应显示默认的读图模型');

  const r = await host.invoke('settings:alignPreset');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true, `应补全字段，实际：${r.reason}`);
  assert.ok(r.message.includes('deepseek-flash'), `提示应说明补了什么，实际 ${r.message}`);

  const after = await host.invoke('settings:get');
  assert.strictEqual(after.settings.visionModel, 'deepseek-flash');
  assert.strictEqual(after.settings.baseUrl, 'https://api.deepseek.com');
  assert.strictEqual(after.settings.model, 'deepseek-flash');
  host.close();
});

test('预置校准：已经是最新时不改动任何东西', async () => {
  const host = mkHost();
  await host.invoke('settings:alignPreset');
  const second = await host.invoke('settings:alignPreset');
  assert.strictEqual(second.changed, false, '第二次不该再改');
  assert.ok(second.reason.includes('最新'), `应说明已是最新，实际 ${second.reason}`);
  host.close();
});

test('预置校准：绝不覆盖用户自己填的读图模型', async () => {
  const host = mkHost({
    baseUrl: 'https://api.deepseek.com',
    model: 'my-text-model',
    visionModel: 'my-vision-model',
  });
  const r = await host.invoke('settings:alignPreset');
  assert.strictEqual(r.changed, false, '用户已填内容时不该改动');
  const s = await host.invoke('settings:get');
  assert.strictEqual(s.settings.visionModel, 'my-vision-model', '用户填的读图模型必须保留');
  assert.strictEqual(s.settings.model, 'my-text-model', '用户填的文本模型必须保留');
  host.close();
});

test('预置校准：自定义服务地址不被改动（避免破坏自建网关）', async () => {
  const host = mkHost({ baseUrl: 'https://my-own-gateway.example.com/v1', model: 'gpt-4o' });
  const r = await host.invoke('settings:alignPreset');
  assert.strictEqual(r.changed, false, '不在预置里的地址不该被动');
  assert.ok(r.reason.includes('不在已知预置'), `应说明原因，实际 ${r.reason}`);
  const s = await host.invoke('settings:get');
  assert.strictEqual(s.settings.baseUrl, 'https://my-own-gateway.example.com/v1', '自定义地址必须保留');
  host.close();
});

test('预置校准：只补空缺，不动用户已填的地址', async () => {
  // 地址手填但与预置相同，读图模型空着 —— 应只补读图模型
  const host = mkHost({ baseUrl: 'https://api.deepseek.com' });
  const r = await host.invoke('settings:alignPreset');
  assert.strictEqual(r.changed, true);
  assert.ok(r.patch.visionModel, '应补读图模型');
  assert.strictEqual(r.patch.baseUrl, undefined, '地址已填，不该出现在补丁里');
  host.close();
});
