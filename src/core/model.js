'use strict';

/**
 * 模型接入层。
 *
 * 为什么单独一层：读图的服务商五花八门（DeepSeek / 智谱 / 通义 / OpenAI / 本地 Ollama），
 * 但绝大多数兼容 OpenAI 的 chat/completions 协议。所以这里只写一个协议适配器 +
 * 可配置的 baseURL/model，换服务商只需要改设置，不改代码。
 *
 * 只依赖 fetch 与 base64 编解码，因此主进程和渲染进程都能用，也便于用假服务器单测。
 */

const { buildVisionPrompt, buildAnalysisPrompt, parseExtraction, extractJson } = require('./extract.js');

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  visionModel: 'deepseek-flash',
  apiKey: '',
  timeoutMs: 120000,
  provider: 'openai-compatible',
};

/** 把图片字节转成 data URL（OpenAI 兼容协议的图片入参格式）。 */
function toDataUrl(bytes, mime = 'image/png') {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 已知服务商的默认配置，方便用户一键切换。 */
const PRESETS = {
  deepseek: {
    // deepseek-flash 是多模态模型，既能纯文本对话，也能读图。
    // 依据：https://api-docs.deepseek.com/zh-cn/guides/vision/
    // （支持 JPEG/PNG/GIF/WebP，走标准 OpenAI 兼容的 image_url 格式；
    // 旧模型名 deepseek-v4-flash-vision-exp 已下线，请求由最新的 Flash 承接。
    // 旧的 deepseek-chat 不能读图 —— 本预置以前标注"不能读图"是过时信息。）
    label: 'DeepSeek（可读图：deepseek-flash）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    visionModel: 'deepseek-flash',
    canReadImages: true,
  },
  zhipu: {
    label: '智谱 GLM（可读图：glm-4v）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    visionModel: 'glm-4v-flash',
    canReadImages: true,
  },
  dashscope: {
    label: '通义千问（可读图：qwen-vl-max）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    visionModel: 'qwen-vl-max',
    canReadImages: true,
  },
  openai: {
    label: 'OpenAI（可读图：gpt-4o）',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    visionModel: 'gpt-4o',
    canReadImages: true,
  },
  ollama: {
    label: '本地 Ollama（离线，可读图：llava/qwen2-vl）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    visionModel: 'qwen2.5vl:7b',
    canReadImages: true,
  },
};

/** 统一发一次 chat/completions 请求，返回助手文本。 */
async function chat(config, messages, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.baseUrl) throw new Error('未配置模型服务地址（baseUrl）');
  const needsKey = !/localhost|127\.0\.0\.1/.test(cfg.baseUrl);
  if (needsKey && !cfg.apiKey) throw new Error('未配置 API Key');

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: opts.model || cfg.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || DEFAULT_CONFIG.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`模型请求超时（${cfg.timeoutMs}ms），可换更快的模型或缩短题目数量`);
    throw new Error(`无法连接模型服务：${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    // 常见错误给出可执行的提示，而不是把原始 JSON 甩给用户
    if (res.status === 401) throw new Error('API Key 无效或已过期（401）');
    if (res.status === 402 || res.status === 429) throw new Error(`额度不足或触发限流（${res.status}）：${text.slice(0, 200)}`);
    if (res.status === 404) throw new Error(`模型或接口不存在（404）：请检查 baseUrl 与模型名。${text.slice(0, 200)}`);
    throw new Error(`模型返回错误 ${res.status}：${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`模型返回的不是合法 JSON：${text.slice(0, 200)}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`模型未返回内容：${JSON.stringify(json).slice(0, 200)}`);
  // OpenAI 的 4o 有时把内容放在数组里
  return content;
}

/**
 * 从图片里抽取题目。
 * @param {Buffer|Uint8Array} imageBytes
 */
async function extractQuestionsFromImage(config, imageBytes, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.visionModel && cfg.provider === 'openai-compatible' && !opts.forceVision) {
    const err = new Error(
      '当前模型不支持读图。请在设置里选择一个「可读图」的服务商（如智谱 glm-4v、通义 qwen-vl，或本地 Ollama 的 llava），或改用手动录入。',
    );
    err.code = 'NO_VISION_MODEL';
    throw err;
  }
  const mime = opts.mime || 'image/png';
  const prompt = buildVisionPrompt({ answerInSource: opts.answerInSource !== false });
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: toDataUrl(imageBytes, mime) } },
      ],
    },
  ];
  const raw = await chat(cfg, messages, { model: cfg.visionModel || cfg.model, json: true });
  const parsed = parseExtraction(raw);
  return { ...parsed, modelUsed: cfg.visionModel || cfg.model, provider: cfg.provider };
}

/** 只给题干+选项，让模型判断答案并拆解知识点（手动录入时的补全）。 */
async function analyzeQuestion(config, question) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const raw = await chat(cfg, [{ role: 'user', content: buildAnalysisPrompt(question) }], { json: true });
  const json = extractJson(raw);
  if (!json) {
    return { ok: false, error: '模型返回无法解析，请手动填写答案与知识点。', raw };
  }
  const letters = Object.keys(question.options || {});
  let answer = String(json.answer ?? '').trim().toUpperCase();
  if (!/^[A-F]$/.test(answer)) {
    // 模型可能返回了选项原文
    const hit = Object.entries(question.options || {}).find(([, v]) => String(v).trim() === String(json.answer).trim());
    answer = hit ? hit[0] : '';
  }
  if (answer && !letters.includes(answer)) answer = '';
  return {
    ok: true,
    answer,
    explanation: String(json.explanation ?? '').trim(),
    knowledgePoints: Array.isArray(json.knowledgePoints)
      ? json.knowledgePoints.map((s) => String(s).trim()).filter(Boolean).slice(0, 4)
      : [],
    difficulty: ['easy', 'medium', 'hard'].includes(json.difficulty) ? json.difficulty : 'medium',
  };
}

/**
 * 批量识别知识点。
 * 设计：本地规则先给出确定的标签，模型只做**追加**。
 * 分批调用（每批 10 题）并逐批容错 —— 某一批失败不该让整次录入白做。
 */
async function detectKnowledgePoints(config, questions, opts = {}) {
  const knowledge = require('./knowledge.js');
  const batchSize = opts.batchSize ?? 10;
  const items = questions.map((q, i) => ({
    index: i + 1,
    stem: q.stem || '',
    options: q.options || {},
    local: knowledge.detectLocal(q.stem || '', q.options || {}),
  }));

  // 先把本地结果铺上：即使模型调用失败，录入也不会没有知识点
  const result = items.map((it) => ({ knowledgePoints: [...it.local] }));
  const notes = [];

  const cfg = { ...DEFAULT_CONFIG, ...config };
  const canCallModel = Boolean(cfg.apiKey) || /localhost|127\.0\.0\.1/.test(cfg.baseUrl || '');
  if (!canCallModel || opts.localOnly) {
    notes.push('未配置文本模型，知识点由本地规则识别。');
    return { ok: true, items: result, usedModel: false, notes };
  }

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    try {
      const raw = await chat(cfg, [{ role: 'user', content: knowledge.buildKnowledgePrompt(batch) }], { temperature: 0.1 });
      const map = knowledge.parseKnowledgeResponse(raw, batch.map((b) => b.index));
      let added = 0;
      for (const b of batch) {
        const fromModel = map.get(b.index) || [];
        if (fromModel.length) added += 1;
        result[b.index - 1] = { knowledgePoints: knowledge.mergeKnowledge(b.local, fromModel) };
      }
      if (added === 0) notes.push(`第 ${start + 1}~${start + batch.length} 题模型没给出可用考点，已只用本地规则。`);
    } catch (e) {
      notes.push(`第 ${start + 1}~${start + batch.length} 题的模型调用失败（${e.message}），这部分只用本地规则。`);
    }
  }

  return { ok: true, items: result, usedModel: true, notes };
}

/**
 * 词义题：逐项给出释义（含熟词生义）与本题语境下的含义。
 * 用户明确要求："词义猜测题要给出所有选项的意思，包括熟词生义，以及本题的意思，短语要有释疑。"
 * 没有模型时不编造释义，而是如实说明并让界面引导用户去问。
 */
async function explainWords(config, question) {
  const knowledge = require('./knowledge.js');
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const canCall = Boolean(cfg.apiKey) || /localhost|127\.0\.0\.1/.test(cfg.baseUrl || '');
  if (!canCall) {
    return { ok: true, usedModel: false, gloss: knowledge.localWordGloss(question), note: '未配置文本模型，无法自动给出每个选项的释义。' };
  }
  try {
    const item = { index: 1, stem: question.stem || '', options: question.options || {} };
    const raw = await chat(cfg, [{ role: 'user', content: knowledge.buildWordGlossPrompt([item]) }], { temperature: 0.2 });
    const map = knowledge.parseWordGlossResponse(raw, [1]);
    const got = map.get(1);
    if (!got) {
      return { ok: true, usedModel: true, gloss: knowledge.localWordGloss(question), note: '模型返回无法解析，已退回基础提示。' };
    }
    // 补齐模型漏掉的选项，保证界面每个选项都有位置可显示
    for (const L of Object.keys(question.options || {})) {
      if (!got.options[L]) got.options[L] = { gloss: '', here: '', note: '' };
    }
    return { ok: true, usedModel: true, gloss: got };
  } catch (e) {
    return { ok: false, error: e.message, gloss: knowledge.localWordGloss(question) };
  }
}

/** 测试连通性：设置界面的「测试连接」按钮用。 */
async function testConnection(config, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const started = Date.now();
  try {
    const reply = await chat(cfg, [{ role: 'user', content: '回复两个字：正常' }], {
      model: opts.vision ? cfg.visionModel || cfg.model : cfg.model,
      temperature: 0,
    });
    return { ok: true, ms: Date.now() - started, model: opts.vision ? cfg.visionModel || cfg.model : cfg.model, reply: reply.slice(0, 50) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.message };
  }
}

module.exports = {
  DEFAULT_CONFIG,
  PRESETS,
  toDataUrl,
  chat,
  extractQuestionsFromImage,
  analyzeQuestion,
  detectKnowledgePoints,
  explainWords,
  testConnection,
};
