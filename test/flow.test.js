'use strict';

/**
 * 全链路测试：直接驱动宿主层（不需要 Electron、不需要真实 API Key）。
 * 覆盖"录入 → 每日练习 → 不揭晓对错 → 结算正确率 → 错题重做 → 调度更新"的完整闭环。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHost } = require('../src/host.js');

/**
 * 建测试用数据目录。
 *
 * 注意：刻意不用 os.tmpdir()。DSH 沙箱只允许在会话工作区内写文件，
 * node:sqlite 在系统临时目录打开数据库会报 "disk I/O error"（即使 fs.writeFileSync 能成功），
 * 那会让整套全链路测试全红，而问题其实与被测代码无关。
 */
const TEST_DATA_ROOT = path.join(__dirname, '..', 'data', 'test');
function tmpDir() {
  fs.mkdirSync(TEST_DATA_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_DATA_ROOT, 'run-'));
}

function mkHost(extra = {}) {
  const dir = tmpDir();
  const host = createHost({ dataDir: dir });
  host.__dir = dir;
  // 测试要确定性：关掉两个乱序（生产默认都是开的）
  host.repo.setSetting('shuffleOptions', false);
  host.repo.setSetting('shuffleOrder', false);
  if (extra.config) host.store.set(extra.config);
  return host;
}

const sample = (i, kp = ['时态']) => ({
  stem: `Full flow question ${i} ____ here.`,
  options: { A: `a${i}`, B: `b${i}`, C: `c${i}`, D: `d${i}` },
  answer: 'B',
  explanation: `解析 ${i}`,
  knowledgePoints: kp,
  difficulty: 'medium',
});

test('示例题导入 → 今日练习 → 结算正确率 → 错题重做 → 调度更新', async () => {
  const host = mkHost();
  host.repo.setSetting('shuffleOptions', false);

  // 1) 导入示例题
  const seeded = await host.invoke('demo:seed');
  assert.strictEqual(seeded.ok, true);
  assert.strictEqual(seeded.created, 6);

  // 2) 开始今日练习
  const started = await host.invoke('practice:start', {});
  assert.strictEqual(started.ok, true);
  assert.strictEqual(started.empty, undefined);
  const session = started.session;
  assert.strictEqual(session.items.length, 6);

  // 3) 关键产品要求：作答过程中不返回任何对错信息
  for (const item of session.items) {
    assert.strictEqual(item.correct, null);
    assert.strictEqual(item.answer, null);
    assert.strictEqual(item.explanation, '');
  }

  // 4) 作答：前 4 题故意答对，后 2 题故意答错。
  //    正确答案必须从题库里读，不能硬编码 —— 示例题库各题答案本来就不同（B/A/C/D/B/B）。
  const bank = await host.invoke('questions:list', {});
  const answerOf = new Map(bank.questions.map((q) => [q.id, q.answer]));
  const chooseWrong = (correct) => ['A', 'B', 'C', 'D'].find((L) => L !== correct);

  for (let i = 0; i < session.items.length; i += 1) {
    const it = session.items[i];
    const right = answerOf.get(it.questionId);
    assert.ok(right, `题库里应能找到第 ${it.questionId} 题的答案`);
    const picked = i < 4 ? right : chooseWrong(right);
    const r = await host.invoke('practice:answer', { sessionId: session.id, questionId: it.questionId, picked });
    assert.strictEqual(r.ok, true);
    // 提交答案的返回里也不能泄露对错
    assert.strictEqual(r.correct, undefined);
  }

  // 5) 结算
  const fin = await host.invoke('practice:finish', { sessionId: session.id });
  assert.strictEqual(fin.ok, true);
  assert.strictEqual(fin.summary.total, 6);
  assert.strictEqual(fin.summary.correct, 4);
  assert.ok(Math.abs(fin.summary.accuracy - 4 / 6) < 1e-9);
  assert.strictEqual(fin.summary.wrong.length, 2);
  assert.strictEqual(fin.summary.needsRetry, true);
  // 结算后才给出答案与解析
  assert.ok(fin.summary.wrong.every((w) => w.answer && w.explanation));

  // 6) 错题重做：错的两题要全部答对
  const retry = await host.invoke('practice:retry', { sessionId: session.id });
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(retry.session.items.length, 2, '只重做错的两题');
  for (const it of retry.session.items) {
    assert.strictEqual(it.correct, null, '重做轮同样不能提前泄露');
    await host.invoke('practice:answer', {
      sessionId: session.id,
      questionId: it.questionId,
      picked: answerOf.get(it.questionId),
    });
  }
  const fin2 = await host.invoke('practice:finish', { sessionId: session.id });
  assert.strictEqual(fin2.ok, true);
  assert.strictEqual(fin2.summary.needsRetry, false, '重做全对后不应再要求重做');

  // 7) 调度：最终做对的题应该排到未来，而不是停在 1 天
  const all = await host.invoke('questions:list', {});
  const byStem = new Map(all.questions.map((q) => [q.stem, q]));
  for (const w of retry.session.items) {
    const q = [...byStem.values()].find((x) => x.id === w.questionId);
    assert.ok(q.state.reps >= 1, '应记录复习次数');
    assert.ok(q.state.intervalDays >= 1, '排期应至少 1 天');
  }

  host.close();
});

test('续练：同一天重新打开不会丢失进度', async () => {
  const host = mkHost();
  host.repo.setSetting('shuffleOptions', false);
  await host.invoke('demo:seed');
  const first = await host.invoke('practice:start', {});
  await host.invoke('practice:answer', { sessionId: first.session.id, questionId: first.session.items[0].questionId, picked: 'B' });

  const second = await host.invoke('practice:start', {});
  assert.strictEqual(second.resumed, true, '应续用同一个会话');
  assert.strictEqual(second.session.id, first.session.id);
  const answered = second.session.items.filter((i) => i.picked !== null);
  assert.strictEqual(answered.length, 1, '已作答的进度必须保留');
  host.close();
});

test('题库为空时给出可读提示而不是报错', async () => {
  const host = mkHost();
  const r = await host.invoke('practice:start', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, true);
  assert.ok(r.message.includes('拍照录入') || r.message.includes('没有要练的题'));
  host.close();
});

test('查重：同一批里重复的题只入库一次', async () => {
  const host = mkHost();
  const r = await host.invoke('questions:save', { questions: [sample(1), sample(1), sample(2)], onDuplicate: 'skip' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.created, 2);
  assert.strictEqual(r.skipped, 1);
  host.close();
});

test('校验拦住缺答案的题，并告知为什么', async () => {
  const host = mkHost();
  const bad = { ...sample(9), answer: '' };
  const r = await host.invoke('questions:save', { questions: [bad] });
  assert.strictEqual(r.failed, 1);
  assert.ok(r.results[0].errors.some((e) => e.includes('答案')));
  const list = await host.invoke('questions:list', {});
  assert.strictEqual(list.questions.length, 0, '不合格的题不能入库');
  host.close();
});

test('未知操作返回可读错误而不是崩溃', async () => {
  const host = mkHost();
  const r = await host.invoke('not:a:real:action', {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('未知操作'));
  host.close();
});

test('设置读写：练习参数持久化，API Key 不回传明文', async () => {
  const host = mkHost();
  await host.invoke('settings:set', { practice: { newLimit: 7, targetRetention: 0.85 }, apiKey: 'sk-secret-1234567890' });
  const r = await host.invoke('settings:get');
  assert.strictEqual(r.settings.newLimit, 7);
  assert.strictEqual(r.settings.targetRetention, 0.85);
  assert.strictEqual(r.settings.hasApiKey, true);
  assert.ok(!JSON.stringify(r.settings).includes('sk-secret-1234567890'), '完整 Key 绝不能回传给界面');
  assert.ok(r.settings.apiKeyMasked.startsWith('sk-s'));
  host.close();
});

test('统计：知识点薄弱排行与错题本', async () => {
  const host = mkHost();
  host.repo.setSetting('shuffleOptions', false);
  await host.invoke('questions:save', { questions: [sample(1, ['一般时态']), sample(2, ['虚拟语气'])] });
  const s = await host.invoke('practice:start', {});
  // 全答错
  for (const it of s.session.items) {
    await host.invoke('practice:answer', { sessionId: s.session.id, questionId: it.questionId, picked: 'A' });
  }
  await host.invoke('practice:finish', { sessionId: s.session.id });

  const ov = await host.invoke('stats:overview');
  assert.strictEqual(ov.ok, true);
  assert.ok(ov.knowledge.length >= 2);
  assert.strictEqual(ov.forecast.length, 7);

  const wb = await host.invoke('stats:wrongBook', {});
  assert.strictEqual(wb.items.length, 2, '两题都错过，都该在错题本里');
  host.close();
});

test('拍照录入全链路（假模型服务）：识别 → 校验 → 入库 → 可练习', async () => {
  // 假读图服务：模拟真实返回，包含一处需要用户确认的问题（答案字母非法）
  const fake = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const hasImage = JSON.stringify(parsed.messages).includes('data:image');
        const content = hasImage
          ? JSON.stringify({
              questions: [
                {
                  stem: 'The report ____ by the team last week.',
                  options: { A: 'completes', B: 'completed', C: 'was completed', D: 'has completed' },
                  answer: 'C',
                  explanation: 'report 是被完成的，且时间为过去。',
                  knowledgePoints: ['被动语态', '一般过去时'],
                  confidence: 0.92,
                },
                {
                  stem: 'She has been working here ____ five years.',
                  options: { A: 'since', B: 'for', C: 'from', D: 'during' },
                  answer: 'E', // 故意非法，验证会不会被标出来
                  knowledgePoints: ['现在完成时'],
                  confidence: 0.6,
                },
              ],
            })
          : JSON.stringify({ answer: 'B', explanation: '固定搭配。', knowledgePoints: ['介词搭配'] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

  const host = mkHost({
    config: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'test-key', model: 'text-model', visionModel: 'vision-model' },
  });

  const img = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const r = await host.invoke('capture:extract', { imageBase64: img, mime: 'image/png', answerInSource: true });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.questions.length, 2);
  assert.strictEqual(r.modelUsed, 'vision-model');
  assert.ok(r.imagePath && fs.existsSync(r.imagePath), '原图应被留存，便于日后核对');
  assert.ok(r.warnings.length >= 1, '非法答案字母必须提示用户确认');
  assert.ok(r.warnings.some((w) => w.includes('置信度')), '低置信度也要提示');

  // 第一题直接入库
  const save1 = await host.invoke('questions:save', { questions: [r.questions[0]] });
  assert.strictEqual(save1.created, 1);

  // 第二题答案非法，入库必须被拦住
  const save2 = await host.invoke('questions:save', { questions: [r.questions[1]] });
  assert.strictEqual(save2.failed, 1);

  // 用户修正后再入库
  const fixed = { ...r.questions[1], answer: 'B' };
  const save3 = await host.invoke('questions:save', { questions: [fixed] });
  assert.strictEqual(save3.created, 1);
  assert.strictEqual(save3.skipped, 0, '修正后不该被当成重复');

  // 入库后能立刻练习
  const started = await host.invoke('practice:start', {});
  assert.strictEqual(started.session.items.length, 2);

  // 文本模型补全答案
  const an = await host.invoke('capture:analyze', {
    question: { stem: 'She is good ____ math.', options: { A: 'at', B: 'in', C: 'on', D: 'for' } },
  });
  assert.strictEqual(an.ok, true);
  assert.strictEqual(an.answer, 'B');

  fake.server.close();
  host.close();
});

test('拍照录入失败时给出可执行提示（未配置读图模型）', async () => {
  const host = mkHost({ config: { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-chat' } });
  const r = await host.invoke('capture:extract', { imageBase64: Buffer.from('x').toString('base64'), mime: 'image/png' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NO_VISION_MODEL');
  assert.ok(r.error.includes('可读图'));
  host.close();
});

test('图片为空时不浪费一次模型调用', async () => {
  const host = mkHost();
  const r = await host.invoke('capture:extract', { imageBase64: '', mime: 'image/png' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('图片为空'));
  host.close();
});
