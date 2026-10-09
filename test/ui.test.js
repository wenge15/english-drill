'use strict';

/**
 * 界面静态检查。
 * 存在的理由：界面里的语法错误会让整页哑掉，但后端不会报任何错，
 * 只在打开软件时才暴露 —— 必须在测试阶段拦住。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'desktop', 'renderer', 'index.html');
const html = fs.readFileSync(file, 'utf8');

test('内联脚本语法正确', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, '应存在内联脚本');
  scripts.forEach((m, i) => {
    assert.doesNotThrow(() => new vm.Script(m[1]), `内联脚本 #${i + 1} 有语法错误`);
  });
});

test('$ 引用的元素 id 都能找到来源', () => {
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // 也在 JS 里动态创建过（el.id = 'xxx' 或 innerHTML 模板里的 id="xxx"）
  const dynamic = new Set([...html.matchAll(/\.id\s*=\s*'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
  const used = [...new Set([...html.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  assert.ok(used.length > 10, `应能提取到足够多的选择器，实际 ${used.length}`);

  const missing = used.filter((id) => !defined.has(id) && !dynamic.has(id));
  assert.deepStrictEqual(missing, [], `引用了既不在页面、也没在 JS 里创建的元素：${missing.join(', ')}`);

  // 页签容器与手动录入字段由模板字符串生成，确认它们确实被生成了
  for (const id of ['tab-text', 'tab-image', 'tab-manual', 'mA', 'mB', 'mC', 'mD']) {
    assert.ok(defined.has(id), `模板里应生成 id=${id}`);
  }
});

test('页面基础结构完整', () => {
  for (const tag of ['<!DOCTYPE html>', '<html lang="zh-CN">', '<meta charset="utf-8"', '<title>']) {
    assert.ok(html.includes(tag), `缺少 ${tag}`);
  }
});

test('无外部 CDN 依赖，可离线运行', () => {
  assert.ok(!/<(script|link)[^>]+(src|href)="https?:\/\//i.test(html), '不应引用外部资源');
});

test('不把 API Key 硬编码进界面', () => {
  assert.ok(!/sk-[a-zA-Z0-9]{16,}/.test(html), '界面里不应出现密钥');
});

test('作答阶段：第一次错不揭晓，只有第二次错才就地讲评（用户明确要求）', () => {
  const start = html.indexOf('async function practiceScreen');
  const finish = html.indexOf('async function renderFinish');
  assert.ok(start !== -1 && finish > start, '应能定位到作答阶段代码');
  const answering = html.slice(start, finish);
  assert.ok(answering.length > 500, '作答阶段代码长度异常');

  // 点击选项后只标记"已选"，不做任何对错高亮
  assert.ok(/classList\.add\('picked'\)/.test(answering), '点击后应标记为已选（中性状态）');
  assert.ok(!/classList\.add\('(right|wrong)/.test(answering), '不应即时高亮正确/错误选项');

  // 揭晓必须由"错了几次"这个条件门控 —— 第一次错不能揭晓
  assert.ok(/wrongCount\s*>=\s*2/.test(answering), '揭晓答案必须用 wrongCount >= 2 门控');
  const gateIdx = answering.indexOf('wrongCount >= 2');
  const teachIdx = answering.indexOf('renderInlineTeach');
  assert.ok(gateIdx !== -1 && teachIdx > gateIdx, '讲评应在门控之后才调用');
  // 门控之后必须有"直接进入下一题"的分支，保证第一次错不展示任何答案
  const between = answering.slice(gateIdx, gateIdx + 400);
  assert.ok(/idx \+= 1/.test(between), '不满足条件时应直接进入下一题（不展示答案）');
});

test('第二次错时就地展开：正确答案、知识点、前几次答案、对话窗口（用户明确要求）', () => {
  const start = html.indexOf('function renderInlineTeach');
  const end = html.indexOf('async function renderFinish');
  assert.ok(start !== -1 && end > start, '应能定位到 renderInlineTeach');
  const block = html.slice(start, end);

  // 用户要求：第二次错误在题目下方出现对话窗口
  assert.ok(/id="inlineChat"/.test(block), '应包含内嵌对话区域');
  assert.ok(/id="inlineAskHere"|id="askHere"/.test(block), '应包含"就这道题问问"入口');
  assert.ok(/id="inlineSend"/.test(block), '对话应有发送按钮');
  assert.ok(/chat:ask/.test(block), '对话应调用 chat:ask 并带上题目上下文');
  assert.ok(/questionId: q\.id/.test(block), '提问要带上这道题的 id，才能自动附上下文');

  // 展示内容：正确答案、考点、前几次选了什么
  assert.ok(/正确答案是/.test(block), '应展示正确答案');
  assert.ok(/考点/.test(block), '应展示考点');
  assert.ok(/你前几次选的/.test(block), '应展示前几次选了什么');
  assert.ok(/history/.test(block), '应有作答历史列表');

  // 就地在题目下方：讲评渲染进 feedback 容器，而不是弹窗
  assert.ok(/\$\('#feedback'\)/.test(block), '讲评应渲染到题目下方的 feedback 容器');
  assert.ok(!/position:fixed/.test(block), '不该用弹窗遮挡题目');
});

test('题号只在练习页出现（用户明确要求）', () => {
  // 练习页有醒目的题号标记
  const practiceStart = html.indexOf('async function practiceScreen');
  const practiceEnd = html.indexOf('async function renderFinish');
  const practice = html.slice(practiceStart, practiceEnd);
  assert.ok(/class="qno"/.test(practice), '练习页应有题号元素');
  assert.ok(/第 \$\{idx \+ 1\} 题/.test(practice), '题号应按本次练习的顺序编号');
  assert.ok(/共 \$\{items\.length\} 题/.test(practice), '应显示本次练习总题数');

  // 录入页（核对题目）不应出现题号
  const capStart = html.indexOf('screens.capture');
  const capEnd = html.indexOf('screens.groups');
  const capture = html.slice(capStart, capEnd);
  assert.ok(!/class="qno"/.test(capture), '录入页不该显示练习题号');
});

test('单元分组：有分组页、录入时能选分组、题库页能批量归类', () => {
  assert.ok(html.includes('data-screen="groups"'), '侧栏应有单元分组入口');
  assert.ok(html.includes('screens.groups'), '应有分组页实现');
  assert.ok(/groups:list/.test(html), '分组页应读取分组列表');
  assert.ok(/groups:rename/.test(html) && /groups:delete/.test(html), '应支持改名与删除');
  // 录入时可指定分组
  assert.ok(/id="importGroup"/.test(html), '录入页应有分组输入框');
  assert.ok(/id="batchGroup"/.test(html), '核对时应有批量分组输入框');
  assert.ok(/data-f="group"/.test(html), '每道题应能单独调整分组');
  assert.ok(/groupName/.test(html), '入库时应带上分组名');
});

test('考前集训：有排期预览与开始按钮（用户明确要求）', () => {
  assert.ok(/id="startSprint"/.test(html), '应有"开始集训"按钮');
  assert.ok(/id="planSprint"/.test(html), '应有"查看排期计划"按钮');
  assert.ok(/sprint:quickStart/.test(html), '应调用集训接口');
  assert.ok(/id="sprintDays"/.test(html), '应能设置天数');
  assert.ok(/value="7" selected/.test(html), '默认应为一周（7 天）');
  assert.ok(/sprint:status/.test(html), '应显示集训进度');
  // 计划里要能看出每天多少题、主要考点
  assert.ok(/renderPlan/.test(html), '应渲染排期计划');
  assert.ok(/第 \$\{d\.dayIndex\} 天/.test(html), '计划应按天展示');
});

test('结果页确实展示对错与解析（练完才揭晓）', () => {
  const block = html.slice(html.indexOf('function renderResultCard'));
  assert.ok(block.length > 800, '应能定位到结果页渲染代码');
  assert.ok(/正确率/.test(block), '结果页应展示正确率');
  assert.ok(/错题解析/.test(block), '结果页应展示错题解析');
  assert.ok(/正确答案是/.test(block), '结果页应给出正确答案');
  assert.ok(/复习安排/.test(block), '结果页应展示复习安排');
  assert.ok(/作答时间线/.test(block), '结果页应展示含重做轮的时间线');
});

test('关键功能入口都存在', () => {
  for (const fn of ['practiceScreen', 'renderFinish', 'renderReview', 'filesToBase64', 'pickImages']) {
    assert.ok(html.includes(fn), `界面缺少 ${fn}`);
  }
  // 新主路径必须有文本导入
  assert.ok(html.includes('import:parseText'), '界面应调用 import:parseText');
  assert.ok(html.includes('import:commit'), '界面应调用 import:commit');
});

test('练习流程包含错题重做与正确率展示', () => {
  assert.ok(html.includes('practice:retry'), '应有错题重做入口');
  assert.ok(/正确率/.test(html), '应展示正确率');
  assert.ok(/错题解析/.test(html), '应展示错题解析');
});

test('设置页提供两个乱序开关（题目顺序 + 选项顺序）', () => {
  assert.ok(html.includes('id="shuffleOptions"'), '应有选项乱序开关');
  assert.ok(html.includes('id="shuffleOrder"'), '应有题目乱序开关');
  assert.ok(/shuffleOrder: \$\('#shuffleOrder'\)\.value/.test(html), '保存时应把题目乱序设置一起提交');
  // 练习页应把当前乱序状态显示出来，避免用户以为设置没生效
  assert.ok(/shuffleNote/.test(html), '练习页应明示当前的乱序状态');
});

test('批量删除：录入时自选题目后一键删除（用户明确要求）', () => {
  assert.ok(/id="pickAll"/.test(html), '应有全选勾选框');
  assert.ok(/class="qpick"/.test(html), '每道题应有勾选框');
  assert.ok(/id="pickInfo"/.test(html), '应显示"已选中 N 道"');
  assert.ok(/id="delPicked"/.test(html), '应有"删除选中的题"按钮');
  assert.ok(/id="clearAll"/.test(html), '应有"全部清空"按钮');
  // 删的是"还没入库"的题；必须从后往前删，否则索引错位会删错题
  assert.ok(/pending\.splice\(i, 1\)/.test(html), '应从 pending 里移除');
  assert.ok(/sort\(\(a, b\) => b - a\)/.test(html), '应从后往前删，避免索引错位');
  // 顺序要求：先绑定批量按钮，再渲染列表（否则勾选后按钮不响应）
  const fnStart = html.indexOf('function renderReview');
  const block = html.slice(fnStart, fnStart + 4000);
  const bindIdx = block.indexOf("$('#delPicked').onclick");
  const renderIdx = block.indexOf('renderQList();');
  assert.ok(bindIdx !== -1 && renderIdx !== -1 && bindIdx < renderIdx, '批量删除按钮的绑定必须在 renderQList() 之前');
});

test('批量删除：题库页能删已入库的题，且区分"回收站"与"彻底删除"', () => {
  assert.ok(/id="archivePicked"/.test(html), '应有"删除选中的题"（移入回收站）');
  assert.ok(/id="purgePicked"/.test(html), '应有"彻底删除（不可恢复）"');
  assert.ok(/mode: 'archive'/.test(html), '默认删除应走归档');
  assert.ok(/mode: 'purge'/.test(html), '彻底删除应走 purge');
  // 彻底删除前必须告知影响范围，这是防误删的关键
  assert.ok(/questions:deleteImpact/.test(html), '彻底删除前应预估影响');
  assert.ok(/不可恢复/.test(html), '界面必须写明不可恢复');
  assert.ok(/data-delq=/.test(html), '每道题应有单独删除按钮');
});

test('回收站：能看、能恢复、能彻底清空', () => {
  assert.ok(html.includes('data-screen="trash"'), '侧栏应有回收站入口');
  assert.ok(html.includes('screens.trash'), '应有回收站页实现');
  assert.ok(/trash:list/.test(html), '应列出已删除的题');
  assert.ok(/trash:restore/.test(html), '应能恢复');
  assert.ok(/trash:purge/.test(html), '应能彻底删除选中的');
  assert.ok(/trash:empty/.test(html), '应能清空回收站');
  assert.ok(/id="trashPickAll"/.test(html), '回收站应支持全选');
});
