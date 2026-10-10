'use strict';

/**
 * 格式化数据库（清空数据）的测试。
 *
 * 这个功能不可逆，所以测试要覆盖两类风险：
 *   1. 该清的没清干净 → 残留数据污染新使用
 *   2. 不该动的被动到了 → 用户白白丢配置/Key
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { createRepo } = require('../src/core/db.js');
const { createHost } = require('../src/host.js');

function freshRepo() {
  const repo = createRepo(':memory:');
  repo.setSetting('shuffleOptions', false);
  repo.setSetting('shuffleOrder', false);
  return repo;
}

function addQuestions(repo, n, groupName, prefix = 'Reset') {
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const r = repo.saveQuestion({
      stem: `${prefix} question ${i} ____ here.`,
      options: { A: `a${i}`, B: `b${i}` },
      answer: 'B',
      groupName,
    });
    assert.strictEqual(r.action, 'created');
    ids.push(r.id);
  }
  return ids;
}

/** 造一份"有内容"的库：题目、分组、作答、会话、问答全都有。 */
function seedEverything(repo) {
  const ids = addQuestions(repo, 4, '测试单元');
  // 注意方法名是 startDailySession（不是 createSession），
  // 题目要从 sessionDetail().items 里取
  const started = repo.startDailySession({ force: true });
  const sessionId = started.session.id;
  const detail = repo.sessionDetail(sessionId);
  repo.recordAnswer(sessionId, detail.items[0].questionId, 'A');
  repo.recordAnswer(sessionId, ids[1], 'B');
  repo.finishSession(sessionId);

  const th = repo.ensureThread({ questionId: ids[0] });
  repo.addChatMessage(th.id, 'user', '这道题为什么选 B？');
  repo.addChatMessage(th.id, 'assistant', '因为……');
  return { ids, sessionId };
}

test('格式化：清空题目、分组、作答、会话、问答', () => {
  const repo = freshRepo();
  const { ids } = seedEverything(repo);

  // 先确认确实有数据
  assert.ok(repo.countQuestions().total > 0, '前置条件：应有题目');
  assert.ok(repo.listGroups().groups.length > 0, '前置条件：应有分组');
  assert.ok(repo.raw.prepare('SELECT COUNT(*) c FROM attempts').get().c > 0, '前置条件：应有作答');
  assert.ok(repo.raw.prepare('SELECT COUNT(*) c FROM sessions').get().c > 0, '前置条件：应有会话');
  assert.ok(repo.raw.prepare('SELECT COUNT(*) c FROM chat_messages').get().c > 0, '前置条件：应有问答');

  const r = repo.resetAll();
  assert.ok(r.total > 0, '应报告删了多少行');

  // 全都空了
  assert.strictEqual(repo.countQuestions().total, 0, '题目应清空');
  assert.strictEqual(repo.listGroups().groups.length, 0, '分组应清空');
  assert.strictEqual(repo.listGroups().ungrouped, 0, '不该有残留的未分组题');
  for (const t of ['attempts', 'practice_questions', 'sessions', 'chat_threads', 'chat_messages']) {
    assert.strictEqual(repo.raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, `${t} 应清空`);
  }
  assert.strictEqual(repo.wrongBook().length, 0, '错题本应清空');
  // 没有错题时 planSprint 返回 { empty: true }，没有 totalWrong 字段
  const plan = repo.planSprint({ days: 7 });
  assert.strictEqual(plan.empty, true, '集训不该还有错题');
  assert.strictEqual(repo.getQuestion(ids[0]), null, '按 id 也查不到旧题');
  repo.close();
});

test('格式化：保留设置（每日题量、乱序开关等偏好不能被清掉）', () => {
  const repo = freshRepo();
  repo.setSetting('newLimit', 7);
  repo.setSetting('maxTotal', 123);
  repo.setSetting('targetRetention', 0.85);
  repo.setSetting('shuffleOptions', true);
  seedEverything(repo);

  repo.resetAll();

  const s = repo.allSettings();
  assert.strictEqual(s.newLimit, 7, '每日新题上限应保留');
  assert.strictEqual(s.maxTotal, 123, '每日总题上限应保留');
  assert.strictEqual(s.targetRetention, 0.85, '目标保持率应保留');
  assert.strictEqual(s.shuffleOptions, true, '乱序开关应保留');
  repo.close();
});

test('格式化：表结构完好，清空后能立刻正常使用', () => {
  const repo = freshRepo();
  seedEverything(repo);
  repo.resetAll();

  // 清空后应能立刻重新录题、建分组、练习
  const r = repo.saveQuestion({
    stem: 'After reset ____ works.',
    options: { A: 'a', B: 'b' },
    answer: 'B',
    groupName: '新单元',
  });
  assert.strictEqual(r.action, 'created', '清空后应能正常录题');
  assert.strictEqual(repo.countQuestions().total, 1);
  assert.strictEqual(repo.listGroups().groups[0].total, 1, '分组功能也应正常');
  repo.close();
});

test('格式化：预览只报告数量，不改动任何数据', () => {
  const repo = freshRepo();
  seedEverything(repo);
  const beforeTotal = repo.countQuestions().total;
  const beforeAttempts = repo.raw.prepare('SELECT COUNT(*) c FROM attempts').get().c;

  const p = repo.resetPreview();
  assert.ok(p.counts.questions > 0, '预览应报告题目数');
  assert.ok(p.counts.groups > 0, '预览应报告分组数');
  assert.ok(p.total > 0, '应报告总行数');
  assert.ok(p.labels.questions, '应提供中文标签供界面使用');

  // 关键：预览绝不能改数据
  assert.strictEqual(repo.countQuestions().total, beforeTotal, '预览不该动数据');
  assert.strictEqual(repo.raw.prepare('SELECT COUNT(*) c FROM attempts').get().c, beforeAttempts, '预览不该动作答');
  repo.close();
});

test('格式化：自增 id 归零，新库的题从 1 开始', () => {
  const repo = freshRepo();
  addQuestions(repo, 5, 'Unit');
  repo.resetAll();
  const r = repo.saveQuestion({
    stem: 'Fresh start ____ here.',
    options: { A: 'a', B: 'b' },
    answer: 'B',
  });
  assert.strictEqual(r.id, 1, `清空后第一道题应是 id=1，实际 ${r.id}`);
  repo.close();
});

test('格式化：空库上执行也不报错', () => {
  const repo = freshRepo();
  const r = repo.resetAll();
  assert.strictEqual(r.total, 0, '空库应报告删了 0 行');
  assert.ok(repo.countQuestions().total === 0);
  repo.close();
});

test('格式化：可以重复执行（幂等，不报错）', () => {
  const repo = freshRepo();
  seedEverything(repo);
  repo.resetAll();
  const second = repo.resetAll();
  assert.strictEqual(second.total, 0, '第二次应报告删了 0 行');
  repo.close();
});

/* ---------------- 宿主动作层面：确认词防护 ---------------- */

function tmpHostDir(name) {
  const dir = path.join(process.cwd(), 'data', 'test', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('宿主：没传确认词时只返回预览，绝不执行清空', async () => {
  const dir = tmpHostDir('reset-guard');
  const host = createHost({ dataDir: dir });
  host.repo.setSetting('shuffleOptions', false);
  // 造点数据
  await host.invoke('questions:save', {
    questions: [{ stem: 'Guard ____ here.', options: { A: 'a', B: 'b' }, answer: 'B' }],
  });

  // 情况一：完全没传
  let r = await host.invoke('db:reset', {});
  assert.strictEqual(r.ok, false, '没确认词不该执行');
  assert.strictEqual(r.needConfirm, true, '应要求确认');
  assert.ok(r.error.includes('格式化'), `错误里应说明确认词，实际 ${r.error}`);
  assert.ok(r.preview.counts.questions > 0, '应带上预览让用户知道会删什么');
  assert.strictEqual(host.repo.countQuestions().total, 1, '数据必须还在');

  // 情况二：传错词
  r = await host.invoke('db:reset', { confirm: '确定' });
  assert.strictEqual(r.ok, false, '错误的确认词不该通过');
  assert.strictEqual(host.repo.countQuestions().total, 1, '数据必须还在');

  // 情况三：大小写/空格差异也不该通过（确认词就是为了让人停下来）
  r = await host.invoke('db:reset', { confirm: ' 格式化 ' });
  assert.strictEqual(r.ok, false, '带空格的确认词不该通过');
  assert.strictEqual(host.repo.countQuestions().total, 1, '数据必须还在');

  // 正确确认词才执行
  r = await host.invoke('db:reset', { confirm: '格式化' });
  assert.strictEqual(r.ok, true, `正确的确认词应执行，实际 ${r.error || ''}`);
  assert.strictEqual(host.repo.countQuestions().total, 0, '这时才该清空');
  assert.ok(r.message.includes('设置与 API Key 保留'), '应告知保留了哪些配置');
  host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('宿主：格式化保留 API Key 与模型配置', async () => {
  const dir = tmpHostDir('reset-keepkey');
  const host = createHost({ dataDir: dir });
  host.store.set({ apiKey: 'sk-test-keep-me', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
  await host.invoke('questions:save', {
    questions: [{ stem: 'Key keep ____ here.', options: { A: 'a', B: 'b' }, answer: 'B' }],
  });

  const r = await host.invoke('db:reset', { confirm: '格式化' });
  assert.strictEqual(r.ok, true);

  // API Key 存在 config.json，不该被清
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.apiKey, 'sk-test-keep-me', 'API Key 必须保留');
  assert.strictEqual(cfg.model, 'deepseek-flash', '模型配置必须保留');

  // 界面读出来的配置也应还在
  const s = await host.invoke('settings:get');
  assert.strictEqual(s.settings.hasApiKey, true, '界面应仍显示已配置 Key');
  assert.strictEqual(s.settings.model, 'deepseek-flash');
  host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('宿主：格式化会清掉题目配图，但不碰 token 文件', async () => {
  const dir = tmpHostDir('reset-images');
  const host = createHost({ dataDir: dir });
  // 造两张假配图
  fs.writeFileSync(path.join(dir, 'images', 'a.png'), Buffer.from('x'));
  fs.writeFileSync(path.join(dir, 'images', 'b.png'), Buffer.from('y'));
  // token 文件（外壳创建，格式化不该动它）
  fs.writeFileSync(path.join(dir, '.shell-token'), 'abc123', 'utf8');

  const r = await host.invoke('db:reset', { confirm: '格式化' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.imagesRemoved, 2, `应清掉 2 张配图，实际 ${r.imagesRemoved}`);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'images')).length, 0, '配图目录应清空');
  assert.strictEqual(fs.existsSync(path.join(dir, '.shell-token')), true, 'token 文件必须保留');
  host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('宿主：格式化后预览归零，界面不会再显示旧数据', async () => {
  const dir = tmpHostDir('reset-after');
  const host = createHost({ dataDir: dir });
  host.repo.setSetting('shuffleOptions', false);
  await host.invoke('questions:save', {
    questions: [{ stem: 'After reset ____ here.', options: { A: 'a', B: 'b' }, answer: 'B' }],
  });
  await host.invoke('db:reset', { confirm: '格式化' });

  const p = await host.invoke('db:resetPreview');
  assert.strictEqual(p.counts.questions, 0);
  assert.strictEqual(p.counts.groups, 0);
  assert.strictEqual(p.total, 0, '总行数应为 0');

  const counts = await host.invoke('questions:counts');
  assert.strictEqual(counts.counts.total, 0, '题库统计应为 0');
  const groups = await host.invoke('groups:list');
  assert.strictEqual(groups.groups.length, 0);
  assert.strictEqual(groups.ungrouped, 0);
  host.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
