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
  const block = html.slice(fnStart, fnStart + 6000);
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

test('抗干扰核对：有「核对答案」入口，且冲突题会被显著标出', () => {
  assert.ok(/id="verifyBtn"/.test(html), '应有「核对答案」按钮');
  assert.ok(/capture:verifyAnswers/.test(html), '应调用核对接口');
  assert.ok(/id="verifyOut"/.test(html), '应有核对结果区域');
  assert.ok(/verifyMap/.test(html), '应保存每道题的核对结果');
  assert.ok(/function verifyBadge/.test(html), '应有核对标记的渲染');

  // 冲突必须显眼、且必须要求用户核对（不能替他决定用哪个答案）
  const badge = html.slice(html.indexOf('function verifyBadge'), html.indexOf('function verifyBadge') + 1200);
  assert.ok(/conflict/.test(badge), '应区分冲突状态');
  assert.ok(/答案可能不对/.test(badge), '冲突提示应醒目');
  assert.ok(/核对/.test(badge), '冲突时应要求人工核对');
  assert.ok(/agree/.test(badge), '应区分一致状态');
});

test('抗干扰核对：界面明确说明"答案不一定对"，并承诺不改答案', () => {
  assert.ok(/答案不一定对/.test(html), '界面应明确提示答案可能被认错');
  assert.ok(/不带图片|不看原答案/.test(html), '应说明核对方式（独立重做）');
  // 核对不得自动修改答案：只标出冲突
  const handler = html.slice(html.indexOf("$('#verifyBtn').onclick"), html.indexOf("$('#verifyBtn').onclick") + 2600);
  assert.ok(!/q\.answer\s*=\s*item\.independent/.test(handler), '核对不该自动把答案改成独立作答结果');
  assert.ok(/verifyMap\[realIdx\]/.test(handler), '应按下标映射回正确的题');
});

test('抗干扰核对：换批次时要清掉上一轮的核对标记', () => {
  // 下标含义会随新批次改变，不清空会把标记串到别的题上
  assert.ok(/keepVerify/.test(html), 'renderReview 应支持保留/清空核对结果');
  assert.ok(/if \(!keepVerify\) verifyMap = \{\}/.test(html), '默认应清空核对结果');
});

test('格式化：在设置页有危险区，且必须先输入确认词才能点', () => {
  assert.ok(/id="dangerZone"/.test(html), '应有危险区卡片');
  assert.ok(/id="resetConfirm"/.test(html), '应有确认词输入框');
  assert.ok(/id="resetBtn"/.test(html), '应有清空按钮');
  assert.ok(/id="resetPreviewBox"/.test(html), '应有"要删什么"的预览区');
  // 按钮默认禁用，且只在确认词完全匹配时才启用（防手滑）
  assert.ok(/id="resetBtn" disabled/.test(html), '清空按钮默认必须是禁用的');
  assert.ok(/const RESET_WORD = '格式化'/.test(html), '确认词应为「格式化」');
  assert.ok(/resetBtn'\)\.disabled = e\.target\.value !== RESET_WORD/.test(html), '只有确认词匹配才启用');
  // 第二次确认要如实列出代价，并提示常规删题有回收站
  assert.ok(/不可撤销/.test(html), '必须写明不可撤销');
  assert.ok(/如果只是想删掉几道题/.test(html), '应引导用户去用有回收站的常规删除');
});

test('格式化：界面如实列出要清除的数量，并说明保留了什么', () => {
  assert.ok(/db:resetPreview/.test(html), '应调用预览接口');
  assert.ok(/将清除：/.test(html), '应列出将清除的数量');
  assert.ok(/会保留/.test(html), '应说明保留了什么（否则用户以为配置也会丢）');
  assert.ok(/API Key/.test(html), '应明确 API Key 会保留');
  // 预览为 0 时不该让用户做无意义的操作
  assert.ok(/当前没有数据，无需格式化/.test(html), '没数据时应说明无需格式化');
});

test('整包识别：能选 ZIP、逐张识别、可暂停、失败可重试', () => {
  // 入口与控件
  assert.ok(/id="zipFile"/.test(html), '应有 ZIP 文件选择框');
  assert.ok(/accept="\.zip/.test(html), '应限制选择 zip');
  assert.ok(/id="zipStartBtn"/.test(html), '应有开始按钮');
  assert.ok(/id="zipPauseBtn"/.test(html), '应有暂停按钮');
  assert.ok(/id="zipClearBtn"/.test(html), '应有清空按钮');
  assert.ok(/整包识别/.test(html), '应有整包识别区块标题');

  // 后端接口
  assert.ok(/capture:unzip/.test(html), '应调用解包接口');
  assert.ok(/capture:zipItem/.test(html), '应逐张取图（不把整包塞进页面）');
  assert.ok(/capture:zipClear/.test(html), '应能释放暂存');

  // 运行逻辑
  assert.ok(/async function runZipQueue/.test(html), '应有队列执行函数');
  assert.ok(/function renderZipQueue/.test(html), '应有进度渲染');
  assert.ok(/zipBatch\.paused/.test(html), '应支持暂停');
  assert.ok(/重试失败的/.test(html), '失败应可重试');

  // 暂停后当前这张跑完即停：执行循环里必须检查标志
  const runFn = html.slice(html.indexOf('async function runZipQueue'), html.indexOf('async function runZipQueue') + 1800);
  assert.ok(/if \(zipBatch\.paused\) break/.test(runFn), '循环里必须检查暂停标志');
  assert.ok(/it\.status = 'failed'/.test(runFn), '单张失败应记为失败并继续下一张');
});

test('整包识别：结果走与单张识别相同的核对入库路径', () => {
  // 不另起一套入库流程，避免两处行为不一致
  const fn = html.slice(html.indexOf('function collectZipResults'), html.indexOf('function collectZipResults') + 900);
  assert.ok(/pending = all/.test(fn), '应把结果放进 pending');
  assert.ok(/renderReview/.test(fn), '应走同一个核对页');
});

test('整包识别：上传前压缩图片（更快更省，不损识别率）', () => {
  assert.ok(/id="zipCompress"/.test(html), '应有"上传前压缩"开关');
  assert.ok(/async function compressImageDataUrl/.test(html), '应有压缩函数');
  assert.ok(/COMPRESS_MAX_DIM/.test(html) && /COMPRESS_QUALITY/.test(html), '应有尺寸与质量参数');
  // 用浏览器自带 canvas，不引第三方图像库
  assert.ok(/createElement\('canvas'\)/.test(html), '应使用 canvas 压缩');
  assert.ok(/toDataURL\('image\/jpeg'/.test(html), '应转成 JPEG（PNG 截图通常很大）');
  // JPEG 不支持透明，必须先铺白底，否则透明区域会变黑
  assert.ok(/fillStyle = '#fff'/.test(html), '应先铺白底再画（避免透明区域变黑）');
  // 小图不该被重新编码（反而可能变糊、变大）
  assert.ok(/COMPRESS_MIN_BYTES/.test(html), '应有"太小的图不压"的下限');

  // 压缩只是优化，不能因为它让流程走不下去
  assert.ok(/压缩失败/.test(html), '压缩失败时应回退原图');
  assert.ok(/压了之后反而更大/.test(html), '压完更大时应回退原图');
});

test('整包识别：超限当场说清楚，而不是白等一次上传', () => {
  // 踩过的坑：65MB 的包转 base64 后 87MB，超限被拒且连接被掐断，界面一直转圈
  assert.ok(/ZIP_UPLOAD_LIMIT/.test(html), '应有上传上限常量');
  assert.ok(/超过了/.test(html), '应提示超过了多少');
  assert.ok(/uploadLimitBytes/.test(html), '上限应从服务端读，避免前后端各写一个数字');
  // 预检必须在读取文件之前
  const from = html.indexOf("$('#zipFile').onchange");
  const handler = html.slice(from, from + 1800);
  const preCheck = handler.indexOf('ZIP_UPLOAD_LIMIT');
  const readFile = handler.indexOf('readAsArrayBuffer');
  assert.ok(preCheck !== -1 && readFile !== -1 && preCheck < readFile,
    '大小预检必须在读取文件之前（否则用户白等）');
});

test('核对页：有问题的题排前面，并标注来自哪张图', () => {
  // 需求：识别有问题的题目要放在前面，并告诉我源自哪个文件，方便核对修改
  assert.ok(/function problemScore/.test(html), '应有问题严重度分级');
  assert.ok(/function reviewOrder/.test(html), '应有显示顺序计算');
  assert.ok(/function shortSource/.test(html), '应有来源文件名缩短');
  assert.ok(/来自：/.test(html), '题卡上应标出来自哪张图');
  assert.ok(/data-f="sourceNote"/.test(html), '出处应可编辑（便于写成更好记的说法）');

  // 排序不能改动 pending 本身，否则编辑/删除会错位
  const ro = html.slice(html.indexOf('function reviewOrder'), html.indexOf('function reviewOrder') + 500);
  assert.ok(/\.map\(\(q, i\) => \(\{ q, i, score/.test(ro), '排序视图要带上真实下标');
  assert.ok(/a\.i - b\.i/.test(ro), '同严重度内必须保持原始先后（稳定排序）');

  // 无法入库的问题必须最优先（缺题干/选项不足/缺答案）
  const ps = html.slice(html.indexOf('function problemScore'), html.indexOf('function problemScore') + 700);
  assert.ok(/return 3/.test(ps), '无法入库的问题应为最高优先级');
  assert.ok(/incomplete/.test(ps), '不完整题应被识别');
  assert.ok(/conflict/.test(ps), '答案存疑应被识别');

  // 排序只影响显示顺序，题卡上的 data-i 必须指向真实下标
  const rqFrom = html.indexOf('function renderQList');
  const rq = html.slice(rqFrom, rqFrom + 3000);
  assert.ok(/data-i="\$\{i\}"/.test(rq), '题卡的 data-i 必须是真实下标（否则编辑/删除会串题）');
  assert.ok(/data-del="\$\{i\}"/.test(rq), '删除按钮也必须用真实下标');
});

test('整包识别：点文件名能看图片，方便核对题目', () => {
  // 需求：点击文件名字可以打开图片，方便核对题目
  assert.ok(/class="zipsrc"/.test(html), '文件名应做成可点的链接');
  assert.ok(/capture:zipImage/.test(html), '应有取图接口');
  assert.ok(/function openViewerAt/.test(html), '应有查看器');
  assert.ok(/box\.id = 'imgViewer'/.test(html), '应动态创建查看器容器');
  assert.ok(/function closeViewer/.test(html), '应能关闭');

  // 一批几十张，必须能连续翻页，不能一张张点开
  assert.ok(/function viewerStep/.test(html), '应支持左右翻页');
  assert.ok(/ivPrev/.test(html) && /ivNext/.test(html), '应有上一张/下一张按钮');
  assert.ok(/ArrowLeft/.test(html) && /ArrowRight/.test(html), '应支持键盘翻页');
  assert.ok(/Escape/.test(html), '应支持 Esc 关闭');

  // 默认看"识别时实际送去的那一版"（用户核对的正是模型看到了什么）
  assert.ok(/variant = 'recognized'/.test(html), '默认应看识别用的版本');
  assert.ok(/got\.meta\.compressed/.test(html), '应如实标明这是压缩后的版本');
  assert.ok(/看原图/.test(html), '应能切到未压缩原图');

  // 没识别过的图也要能看（解包后就想预览是常见需求）
  const ovFrom = html.indexOf('async function openViewerAt');
  const ov = html.slice(ovFrom, html.indexOf('function shortSource', ovFrom));
  assert.ok(/it\.status === 'pending'/.test(ov), '未识别的图也要能查看');
  assert.ok(/还没识别/.test(ov), '应说明这张还没识别');

  // 翻页要包起来（到末尾回到开头），不能卡在最后一张
  const vsFrom = html.indexOf('function viewerStep');
  const vs = html.slice(vsFrom, html.indexOf('async function openViewerAt', vsFrom));
  assert.ok(/% items\.length/.test(vs), '翻页应循环');
});

test('不完整题正常录入：核对页提示「有 N 道题选项可能不完整」，不排除', () => {
  // 判定标准是题干是否在画面里，残缺题（选项被裁掉）仍要录入，只是提醒补全
  assert.ok(/function countIncomplete/.test(html), '应有统计不完整题数的纯函数');
  assert.ok(/incomplete === true/.test(html), '应依据 incomplete===true 计数');
  // 单张识别与整包识别都不再分离，直接 pending = all
  assert.ok(/pending = all/.test(html), '识别结果应整体放进 pending，不排除残缺题');
  // 核对页显示的是「提醒补全」的提示条，而非「排除/恢复」
  assert.ok(/有 \$\{incCount\} 道题选项可能不完整/.test(html), '核对页应提示选项可能不完整');
  assert.ok(/请核对补充/.test(html), '提示应是提醒补全而非排除');
  // 不再有「查看并恢复」这类排除机制
  assert.ok(!/查看并恢复/.test(html), '不应再有排除后的恢复入口');
  assert.ok(!/已自动排除/.test(html), '不应再出现「已自动排除」');
});

test('录入草稿：pending 提升到模块级，并用 localStorage 持久化', () => {
  // 模块级变量（不再因切页面重建 screens.capture 闭包而丢失）
  assert.ok(/let pending = \[\];/.test(html), 'pending 应为模块级变量');
  // localStorage 持久化：存/取/清除三个入口都要有
  assert.ok(/DRAFT_KEY = 'capture-draft-v1'/.test(html), '草稿 key 应为 capture-draft-v1');
  assert.ok(/function saveDraft/.test(html), '应有保存草稿函数');
  assert.ok(/function loadDraft/.test(html), '应有读取草稿函数');
  assert.ok(/function clearDraft/.test(html), '应有清除草稿函数');
  assert.ok(/localStorage\.setItem/.test(html), '应写入 localStorage');
  assert.ok(/localStorage\.getItem/.test(html), '应从 localStorage 读取');
  assert.ok(/localStorage\.removeItem/.test(html), '应能清除 localStorage');
  // 恢复草稿时明确提示用户，而不是静默
  assert.ok(/已恢复上次未完成的录入/.test(html), '恢复草稿时应提示用户');
  // 入库成功后清除草稿（避免下次误恢复已入库的题）
  assert.ok(/clearDraft\(\)/.test(html), '入库成功后应清除草稿');
  // 写入失败要静默降级（隐私模式），不能影响主流程
  assert.ok(/catch \(e\) \{ \/\* 隐私模式/.test(html), '写入失败应 try/catch 静默降级');
});

test('今日页：关掉窗口后仍能继续重做上次的错题', () => {
  assert.ok(/practice:pendingRetry/.test(html), '应查询是否存在未订正的错题会话');
  assert.ok(/id="pendingRetry"/.test(html), '今日页应有放「继续重做」按钮的容器');
  assert.ok(/继续重做上次的错题/.test(html), '应有「继续重做上次的错题」按钮');
  assert.ok(/id="resumeRetryBtn"/.test(html), '按钮应可点击触发重做');
  assert.ok(/go\('practice', rr\.session, Boolean\(rr\.resumed\)\)/.test(html), '重做应进入练习页并带上 resumed');
});

test('重做错题：今日页与结果页都把 resumed 传给练习页，续做时跳过已答题', () => {
  // 两处 practice:retry 的 go('practice', ...) 第三参都应是 Boolean(rr.resumed)
  const calls = html.match(/go\('practice', rr\.session, Boolean\(rr\.resumed\)\)/g) || [];
  assert.strictEqual(calls.length, 2, '今日页与结果页两处都应把 resumed 传给练习页');
  // 结果页的 #retryBtn 也是同一写法，不应有残留的写死 false 版本
  assert.ok(!/go\('practice', rr\.session, false\)/.test(html), '不应再有写死 resumed=false 的调用');
});

test('核对答案：自动补全解析，只补无用解析、不改答案', () => {
  // 核对返回后把模型独立作答的依据写回 explanation
  assert.ok(/pending\[realIdx\]\.explanation = item\.reason/.test(html), '应把模型的 reason 写回解析');
  // 只补"无用解析"：空，或「卷面未标注答案 / 无法确定 / 看不清」这类占位
  assert.ok(/卷面未标注答案\|无法确定\|看不清/.test(html), '应只匹配无用解析占位');
  assert.ok(/if \(!cur \|\|/.test(html), '只有空或无用解析才补，不覆盖用户已写好的解析');
  // 补全后要提示数量
  assert.ok(/已自动补全 \$\{filledCount\} 道题的解析/.test(html), '应在核对结果里提示补全了多少道');
  // 硬约束：只动 explanation，绝不动 answer（冲突仍由用户对照原卷决定）
  assert.ok(!/pending\[realIdx\]\.answer\s*=/.test(html), '核对不得改答案');
});

test('练习页「我不会」：独立按钮、记为 IDK、与选项共用同一作答路径', () => {
  assert.ok(/id="idkBtn"/.test(html), '应有「我不会」按钮');
  assert.ok(/我不会 \/ 不猜了/.test(html), '按钮文案应为「我不会 / 不猜了」');
  assert.ok(/不确定就别猜/.test(html), '应有简短说明');
  // fmtPicked：把 'IDK' 显示成人话，避免直接显示 IDK 字母
  assert.ok(/const fmtPicked\s*=/.test(html), '应有 fmtPicked 工具函数');
  assert.ok(/p === 'IDK' \? '我不会'/.test(html), 'fmtPicked 应把 IDK 显示为「我不会」');
  // 选项点击与「我不会」共用 answerWith，避免两条路径行为分叉
  assert.ok(/const answerWith = async \(picked\)/.test(html), '应有统一作答函数 answerWith');
  assert.ok(/answerWith\(picked\)/.test(html), '选项点击应走 answerWith');
  assert.ok(/answerWith\('IDK'\)/.test(html), '「我不会」应走 answerWith 且传 IDK');
});

test('练习页：有「上一题/下一题」，返回时撤销刚作答的那一题', () => {
  assert.ok(/id="undoBtn"/.test(html), '应有「上一题」按钮');
  assert.ok(/id="nextBtn"/.test(html), '应有「下一题」按钮');
  assert.ok(/practice:undoAnswer/.test(html), '返回撤销应调用 practice:undoAnswer');
  assert.ok(/let lastAnsweredIdx = -1/.test(html), '应有 lastAnsweredIdx 跟踪最近作答');
  assert.ok(/lastAnsweredIdx = idx/.test(html), '作答成功后应记录 lastAnsweredIdx');
  assert.ok(/idx === 0 \? 'disabled'/.test(html), '第一题时「上一题」应禁用');
  assert.ok(/idx >= items\.length - 1 \? 'disabled'/.test(html), '最后一题时「下一题」应禁用');
  assert.ok(/delete answered\[prev\.questionId\]/.test(html), '撤销后应清除前端 answered 记录');
});
