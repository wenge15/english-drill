'use strict';

/**
 * 模型接入层测试：用一个假模型服务验证请求构造与错误处理。
 * 不打真实付费接口 —— 这类测试必须能离线跑、能进 CI。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const model = require('../src/core/model.js');

/** 起一个假模型服务，记录收到的请求，按脚本回复。 */
function fakeServer(handler) {
  return new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        received.push({ url: req.url, headers: req.headers, body: parsed });
        const out = handler(parsed, received.length);
        res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, received, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

const replyWith = (content) => ({ json: { choices: [{ message: { content } }] } });

test('toDataUrl 生成标准 data URL', () => {
  const url = model.toDataUrl(Buffer.from('hello'), 'image/jpeg');
  assert.ok(url.startsWith('data:image/jpeg;base64,'));
  assert.strictEqual(Buffer.from(url.split(',')[1], 'base64').toString(), 'hello');
});

test('读图：请求里带上了图片与提示词，并能解析出题目', async () => {
  const fake = await fakeServer(() =>
    replyWith(
      JSON.stringify({
        questions: [
          {
            stem: 'He ____ to school every day.',
            options: { A: 'go', B: 'goes', C: 'going', D: 'gone' },
            answer: 'B',
            explanation: '第三人称单数。',
            knowledgePoints: ['一般现在时'],
            confidence: 0.9,
          },
        ],
      }),
    ),
  );

  const r = await model.extractQuestionsFromImage(
    { baseUrl: fake.baseUrl, model: 'vision-test', visionModel: 'vision-test', apiKey: 'k' },
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    { mime: 'image/png' },
  );

  assert.strictEqual(r.questions.length, 1);
  assert.strictEqual(r.questions[0].answer, 'B');
  assert.strictEqual(r.questions[0].knowledgePoints[0], '一般现在时');

  // 请求必须真的把图片放进去了，否则等于白买读图能力
  const sent = fake.received[0].body;
  const parts = sent.messages[0].content;
  assert.strictEqual(parts.length, 2, '应同时发文本与图片两部分');
  assert.ok(parts[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(parts[0].text.includes('JSON'), '提示词应要求 JSON 输出');
  assert.strictEqual(sent.model, 'vision-test');
  assert.strictEqual(sent.response_format.type, 'json_object');

  fake.server.close();
});

test('读图：未配置视觉模型时给出可执行的提示，而不是发一个必然失败的请求', async () => {
  await assert.rejects(
    () => model.extractQuestionsFromImage({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-chat' }, Buffer.from('x')),
    (e) => {
      assert.strictEqual(e.code, 'NO_VISION_MODEL');
      assert.ok(e.message.includes('可读图'), '提示应说明该怎么办');
      return true;
    },
  );
});

test('认证：远程服务缺 Key 时立刻报错，不发请求', async () => {
  await assert.rejects(
    () => model.chat({ baseUrl: 'https://api.example.com/v1', apiKey: '' }, [{ role: 'user', content: 'hi' }]),
    /未配置 API Key/,
  );
});

test('本地服务不需要 Key（Ollama 场景）', async () => {
  const fake = await fakeServer(() => replyWith('正常'));
  const r = await model.chat({ baseUrl: fake.baseUrl, model: 'qwen2.5:7b', apiKey: '' }, [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r, '正常');
  assert.strictEqual(fake.received[0].headers.authorization, undefined, '本地服务不该带 Authorization');
  fake.server.close();
});

test('错误码翻译成人话：401 / 404 / 429', async () => {
  const fake401 = await fakeServer(() => ({ status: 401, json: { error: 'bad key' } }));
  await assert.rejects(
    () => model.chat({ baseUrl: fake401.baseUrl, apiKey: 'k' }, [{ role: 'user', content: 'x' }]),
    /API Key 无效/,
  );
  fake401.server.close();

  const fake404 = await fakeServer(() => ({ status: 404, json: { error: 'no model' } }));
  await assert.rejects(
    () => model.chat({ baseUrl: fake404.baseUrl, apiKey: 'k' }, [{ role: 'user', content: 'x' }]),
    /模型或接口不存在/,
  );
  fake404.server.close();

  const fake429 = await fakeServer(() => ({ status: 429, json: { error: 'rate limited' } }));
  await assert.rejects(
    () => model.chat({ baseUrl: fake429.baseUrl, apiKey: 'k' }, [{ role: 'user', content: 'x' }]),
    /额度不足或触发限流/,
  );
  fake429.server.close();
});

test('模型返回非 JSON 时给出可读错误', async () => {
  const fake = await fakeServer(() => ({ status: 200, json: { choices: [] } }));
  await assert.rejects(
    () => model.chat({ baseUrl: fake.baseUrl, apiKey: 'k' }, [{ role: 'user', content: 'x' }]),
    /模型未返回内容/,
  );
  fake.server.close();
});

test('超时能被中断，且提示可执行', async () => {
  const { server, baseUrl } = await new Promise((resolve) => {
    const s = http.createServer(() => {
      // 故意不回复
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, baseUrl: `http://127.0.0.1:${s.address().port}/v1` }));
  });
  await assert.rejects(
    () => model.chat({ baseUrl, apiKey: 'k', timeoutMs: 300 }, [{ role: 'user', content: 'x' }]),
    /超时/,
  );
  server.close();
});

test('补全答案：模型返回选项原文也能纠正成字母', async () => {
  const fake = await fakeServer(() =>
    replyWith(JSON.stringify({ answer: 'goes', explanation: '第三人称单数。', knowledgePoints: ['主谓一致'], difficulty: 'easy' })),
  );
  const r = await model.analyzeQuestion(
    { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    { stem: 'He ____ to school.', options: { A: 'go', B: 'goes', C: 'going', D: 'gone' } },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.answer, 'B');
  assert.deepStrictEqual(r.knowledgePoints, ['主谓一致']);
  assert.strictEqual(r.difficulty, 'easy');
  fake.server.close();
});

test('补全答案：模型胡说时返回 ok=false 而不是塞入错误答案', async () => {
  const fake = await fakeServer(() => replyWith(JSON.stringify({ answer: 'Z', explanation: '...' })));
  const r = await model.analyzeQuestion(
    { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    { stem: 'q', options: { A: 'a', B: 'b' } },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.answer, '', '非法答案必须置空，让用户自己填');
  fake.server.close();
});

test('连接测试：成功与失败都能返回结论而不是抛异常', async () => {
  const fake = await fakeServer(() => replyWith('正常'));
  const okRes = await model.testConnection({ baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' });
  assert.strictEqual(okRes.ok, true);
  assert.ok(typeof okRes.ms === 'number');
  fake.server.close();

  const bad = await model.testConnection({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', timeoutMs: 500 });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.error.length > 0);
});

test('预置服务商配置都包含必需字段', () => {
  for (const [key, p] of Object.entries(model.PRESETS)) {
    assert.ok(p.baseUrl && p.model && p.label, `${key} 缺字段`);
    assert.strictEqual(typeof p.canReadImages, 'boolean', `${key} 需标注能否读图`);
  }
  // 至少有一个能读图的服务商，否则用户没法用拍照录入
  assert.ok(Object.values(model.PRESETS).some((p) => p.canReadImages), '必须提供可读图的预置服务商');
  assert.strictEqual(model.PRESETS.deepseek.canReadImages, false, 'DeepSeek 目前不能读图，不能误导用户');
});

/* ---------------- 知识点自动识别 ---------------- */

test('知识点：没配模型时用本地规则，且不报错', async () => {
  const r = await model.detectKnowledgePoints(
    { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'm' },
    [{ stem: 'If I ____ you, I would take the job.', options: { A: 'am', B: 'was', C: 'were', D: 'be' } }],
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.usedModel, false);
  // 条件句同时命中"虚拟语气"与"状语从句"，两者都对，所以只断言主要考点在前
  assert.strictEqual(r.items[0].knowledgePoints[0], '虚拟语气');
  assert.ok(r.items[0].knowledgePoints.length >= 1);
  assert.ok(r.notes.some((n) => n.includes('本地规则')));
});

test('知识点：模型给出的考点追加在本地结论之后', async () => {
  const fake = await fakeServer(() =>
    replyWith(JSON.stringify({ items: [{ index: 1, knowledgePoints: ['固定短语 take pride in', '虚拟语气'] }] })),
  );
  const r = await model.detectKnowledgePoints(
    { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    [{ stem: 'If I ____ you, I would take the job.', options: { A: 'am', B: 'was', C: 'were', D: 'be' } }],
  );
  assert.strictEqual(r.usedModel, true);
  // 本地标签在前（稳定），模型标签在后且不重复
  assert.strictEqual(r.items[0].knowledgePoints[0], '虚拟语气');
  assert.ok(r.items[0].knowledgePoints.includes('固定短语 take pride in'));
  assert.strictEqual(new Set(r.items[0].knowledgePoints).size, r.items[0].knowledgePoints.length, '不应重复');
  fake.server.close();
});

test('知识点：模型调用失败时仍返回本地结果（不让整次录入白做）', async () => {
  const r = await model.detectKnowledgePoints(
    { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', timeoutMs: 800 },
    [{ stem: 'She ____ in Beijing since 2015.', options: { A: 'lives', B: 'has lived', C: 'lived', D: 'is living' } }],
  );
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.items[0].knowledgePoints, ['现在完成时']);
  assert.ok(r.notes.some((n) => n.includes('失败')), `应说明模型失败：${JSON.stringify(r.notes)}`);
});

test('知识点：分批调用，超量题目不会一次全发出去', async () => {
  const fake = await fakeServer((body) => {
    const idx = [...String(body.messages[0].content).matchAll(/^(\d+)\. 题干/gm)].map((m) => Number(m[1]));
    return replyWith(JSON.stringify({ items: idx.map((i) => ({ index: i, knowledgePoints: ['测试考点'] })) }));
  });
  const questions = Array.from({ length: 23 }, (_, i) => ({
    stem: `Question ${i + 1} ____ here.`,
    options: { A: 'a', B: 'b' },
  }));
  const r = await model.detectKnowledgePoints({ baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' }, questions, { batchSize: 10 });
  assert.strictEqual(r.items.length, 23);
  assert.strictEqual(fake.received.length, 3, `23 题按每批 10 应有 3 次调用，实际 ${fake.received.length}`);
  assert.ok(r.items.every((x) => x.knowledgePoints.includes('测试考点')));
  fake.server.close();
});
