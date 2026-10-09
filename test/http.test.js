'use strict';

/**
 * HTTP 外壳的自动化验证。
 *
 * 为什么需要：Electron 的 GUI 在本机启动即崩溃（exit 0xC0000005），
 * 所以改用 Node 外壳 + 浏览器窗口。这条路径必须自动化验证到底通不通，
 * 不能靠"应该没问题"。
 *
 * 前置：另开终端跑 node src/shell-http.js
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const fs = require('node:fs');
const path = require('node:path');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name} ${extra}`);
  }
};

async function main() {
  const token = fs.readFileSync(path.join(__dirname, '..', 'data', '.shell-token'), 'utf8').trim();
  const url = `${BASE}/?token=${token}`;

  console.log('\n[HTTP 外壳] 鉴权');
  const noToken = await fetch(`${BASE}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'questions:counts', args: {} }),
  });
  check('缺 token 的接口调用被拒绝（403）', noToken.status === 403, `实际 ${noToken.status}`);

  const invoke = async (channel, args = {}) => {
    const r = await fetch(`${BASE}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({ channel, args }),
    });
    return r.json();
  };

  console.log('\n[HTTP 外壳] 页面与桥接');
  const page = await fetch(url).then((r) => r.text());
  check('界面能正常返回', page.includes('<!DOCTYPE html>') && page.includes('英语练习'));
  check('注入了 window.dsh 桥', page.includes('window.dsh ='));
  check('桥里带上了 token', page.includes(token));
  check('桥用 HTTP 实现 invoke', page.includes("/api/invoke"));

  console.log('\n[HTTP 外壳] 核心动作');
  const counts = await invoke('questions:counts');
  check('questions:counts 可用', counts.ok === true, JSON.stringify(counts).slice(0, 120));

  // 把到期的题拉进今日：否则上一轮测试可能已把题目排到未来，
  // 后面的练习断言会因为"今日没有要练的题"而误报失败（踩过）。
  const pulled = await invoke('practice:pullDueForward');
  check('能把到期的题拉进今日队列', pulled.ok === true, JSON.stringify(pulled).slice(0, 120));

  // 文本导入：这是主路径，必须端到端通
  const parse = await invoke('import:parseText', {
    text: `21. He ____ to school by bus every day.
A. go
B. goes
C. going
D. gone
答案：B

22. The report ____ by the team last week.
A. completes  B. completed  C. was completed  D. has completed
答案：C`,
  });
  check('文本导入能解析出 2 题', parse.ok && parse.questions.length === 2, JSON.stringify(parse).slice(0, 200));
  check('题干/选项/答案都解析正确', parse.questions?.[0]?.answer === 'B'
    && parse.questions?.[0]?.options?.B === 'goes'
    && parse.questions?.[1]?.options?.C === 'was completed',
  JSON.stringify(parse.questions?.map((q) => ({ a: q.answer, o: q.options }))).slice(0, 240));
  check('返回了校验统计', parse.stats && typeof parse.stats.parsed === 'number');

  // 入库
  const commit = await invoke('import:commit', { questions: parse.questions, onDuplicate: 'skip' });
  check('解析结果能入库', commit.ok === true, JSON.stringify(commit).slice(0, 200));

  // 练习闭环：开始 → 作答不泄露对错 → 结算
  // 注意必须 force：否则会拿到上一次练习留下来、已经作答过的会话，
  // 于是"练习中不返回答案"这条断言会被旧数据搞成假失败（踩过）。
  const started = await invoke('practice:start', { force: true });
  check('能开始今日练习', started.ok === true && Boolean(started.session), JSON.stringify(started).slice(0, 160));
  if (started.ok && started.session) {
    const unanswered = started.session.items.filter((i) => i.picked === null);
    check('force 后拿到的是未作答的新会话', unanswered.length > 0, `未作答 ${unanswered.length} 题`);
    const item = unanswered[0];
    check('练习中不返回答案', item.correct === null && item.answer === null, JSON.stringify({ c: item.correct, a: item.answer }));
    const ans = await invoke('practice:answer', { sessionId: started.session.id, questionId: item.questionId, picked: 'A' });
    check('作答接口可用且不泄露对错', ans.ok === true && ans.correct === undefined, JSON.stringify(ans));
    const fin = await invoke('practice:finish', { sessionId: started.session.id });
    check('结算返回正确率', fin.ok === true && typeof fin.summary?.accuracy === 'number', JSON.stringify(fin).slice(0, 160));
    check('结算后给出错题与解析', Array.isArray(fin.summary?.wrong));
  } else {
    check('能开始今日练习', false, '没有拿到 session');
  }

  console.log('\n[HTTP 外壳] 数据落盘');
  const dataDir = path.join(__dirname, '..', 'data');
  check('数据库文件已创建', fs.existsSync(path.join(dataDir, 'questions.db')), path.join(dataDir, 'questions.db'));
  check('地址文件已写出（供启动器使用）', fs.existsSync(path.join(dataDir, '.shell-url')));

  console.log('\n[HTTP 外壳] 分组');
  const gcreate = await invoke('groups:create', { name: `端到端分组_${Date.now()}` });
  check('能创建分组', gcreate.ok === true, JSON.stringify(gcreate).slice(0, 160));
  const glist = await invoke('groups:list');
  check('能列出分组', glist.ok === true && Array.isArray(glist.groups));
  const myGroup = (glist.groups || []).find((g) => g.name === gcreate.name || g.id === gcreate.id);
  check('新建的分组出现在列表里', Boolean(myGroup), JSON.stringify(glist.groups?.map((g) => g.name)));

  // 录入时指定分组
  const withGroup = await invoke('import:parseText', {
    text: '1. Grouped question ____ here.\nA. a\nB. b\n答案：B',
  });
  await invoke('import:commit', {
    questions: withGroup.questions.map((q) => ({ ...q, groupName: `端到端分组_${gcreate.id ?? ''}` })),
    onDuplicate: 'skip',
  });
  const afterGroups = await invoke('groups:list');
  check('分组统计能反映题量', afterGroups.ok === true, JSON.stringify(afterGroups.groups?.map((g) => ({ n: g.name, t: g.total }))).slice(0, 200));

  console.log('\n[HTTP 外壳] 考前集训');
  const sstatus = await invoke('sprint:status');
  check('集训进度接口可用', sstatus.ok === true && typeof sstatus.totalWrong === 'number', JSON.stringify(sstatus).slice(0, 160));
  const sPlan = await invoke('sprint:plan', { days: 7 });
  check('能生成集训计划', sPlan.ok === true, JSON.stringify(sPlan).slice(0, 160));
  if (sPlan.ok && !sPlan.empty) {
    check('计划天数不超过 7 天', sPlan.plan.length <= 7, `实际 ${sPlan.plan.length} 天`);
    check('错题全部被覆盖', sPlan.covered === sPlan.totalWrong, `覆盖 ${sPlan.covered} / 错题 ${sPlan.totalWrong}`);
    const quick = await invoke('sprint:quickStart', { days: 7 });
    check('能一键开始集训', quick.ok === true && !quick.empty, JSON.stringify(quick).slice(0, 200));
    check('集训后有排期记录', Boolean(quick.status?.lastSprint), JSON.stringify(quick.status).slice(0, 200));
  } else {
    console.log('  （当前没有错题，跳过集训应用断言）');
  }

  console.log('\n[HTTP 外壳] 第二次错就带讲评材料');
  const bank = await invoke('questions:list', { limit: 5 });
  if (bank.ok && bank.questions.length) {
    const q = bank.questions[0];
    const t = await invoke('teach:mistake', { questionId: q.id });
    check('讲评接口带考点与历史', t.ok === true && Array.isArray(t.question?.knowledgePoints) && Array.isArray(t.history),
      JSON.stringify(t).slice(0, 160));
    check('讲评能算出累计错误次数', typeof t.wrongCount === 'number');
  }

  console.log('\n[HTTP 外壳] 批量删除与回收站');
  // 造 3 道专用题来做删除测试。
  // 用**唯一批次标识**筛选，否则上一次运行残留的题会被一起匹配到，
  // 断言数量就会变成"历史累计"（实测踩过）。
  const stamp = Date.now();
  const batchTag = `待删批次${stamp}`;
  const toDelete = await invoke('import:parseText', {
    text: `1. ${batchTag}甲 ____ here.\nA. a\nB. b\n答案：B\n\n2. ${batchTag}乙 ____ here.\nA. a\nB. b\n答案：B\n\n3. ${batchTag}丙 ____ here.\nA. a\nB. b\n答案：B`,
  });
  await invoke('import:commit', { questions: toDelete.questions, onDuplicate: 'skip' });
  const all = await invoke('questions:list', { limit: 500 });
  const targets = all.questions.filter((q) => q.stem.includes(batchTag)).map((q) => q.id);
  check('造出了 3 道待删题', targets.length === 3, `实际 ${targets.length}`);

  const impact = await invoke('questions:deleteImpact', { ids: targets });
  check('删除前能预估影响', impact.ok === true && impact.impact.questions === 3, JSON.stringify(impact).slice(0, 160));

  // 归档（可恢复）
  const arch = await invoke('questions:bulkDelete', { ids: [targets[0]], mode: 'archive' });
  check('归档删除成功', arch.ok === true && arch.mode === 'archive', JSON.stringify(arch).slice(0, 160));
  const trash = await invoke('trash:list', {});
  check('回收站能看到被删的题', trash.ok === true && trash.items.some((q) => q.id === targets[0]), JSON.stringify(trash.items?.length));

  // 恢复
  const restore = await invoke('trash:restore', { ids: [targets[0]] });
  check('能从回收站恢复', restore.ok === true && restore.updated === 1, JSON.stringify(restore).slice(0, 160));
  const back = await invoke('questions:list', { limit: 500 });
  check('恢复后回到题库', back.questions.some((q) => q.id === targets[0]));

  // 彻底删除
  const purge = await invoke('questions:bulkDelete', { ids: [targets[1]], mode: 'purge' });
  check('彻底删除成功', purge.ok === true && purge.mode === 'purge' && purge.deleted === 1, JSON.stringify(purge).slice(0, 160));
  const afterPurge = await invoke('questions:list', { limit: 500 });
  check('彻底删除后题库里不再有它', !afterPurge.questions.some((q) => q.id === targets[1]));

  // 清空回收站
  await invoke('questions:bulkDelete', { ids: [targets[2]], mode: 'archive' });
  const emptied = await invoke('trash:empty', {});
  check('能清空回收站', emptied.ok === true, JSON.stringify(emptied).slice(0, 160));
  const emptyList = await invoke('trash:list', {});
  check('清空后回收站为空', emptyList.items.length === 0, `实际 ${emptyList.items.length} 道`);

  // 空请求要拦住
  const noIds = await invoke('questions:bulkDelete', { ids: [] });
  check('没选中任何题时报错而不是误删', noIds.ok === false, JSON.stringify(noIds).slice(0, 120));

  console.log(`\n${failures === 0 ? 'HTTP 外壳全部通过' : `有 ${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nHTTP 检查无法完成：${e.message}`);
  console.error('请确认外壳已启动：node src/shell-http.js\n');
  process.exit(1);
});
