'use strict';

/**
 * HTTP 外壳的自动化验证。
 *
 * 为什么需要：Electron 的 GUI 在本机启动即崩溃（exit 0xC0000005），
 * 所以改用 Node 外壳 + 浏览器窗口。这条路径必须自动化验证到底通不通，
 * 不能靠"应该没问题"。
 *
 * ⚠ 重要设计变更（一次真实事故换来的）：
 * 这个测试以前连的是用户**正在使用**的服务（127.0.0.1:8899）。
 * 加入"格式化"接口的测试后，它真的把用户的题库清空了 ——
 * 因为那个服务用的就是 data/questions.db。
 *
 * 现在改为：测试**自己起一个独立外壳**，用临时数据目录、独立端口，
 * 完整跑鉴权 / 页面 / 核心动作 / 分组 / 集训 / 删除 / 格式化的全部断言。
 *
 * 好处有两个：
 *   1. 不可能再碰到真实数据（数据目录是临时创建、跑完删掉的）
 *   2. 不需要预先手动启动服务 —— 直接 node test/http.test.js 就能跑
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createShell, listen } = require('../src/shell-server.js');

// 临时数据目录：与真实 data/ 完全隔离
const TEST_ROOT = path.join(__dirname, '..', 'data', 'test');
fs.mkdirSync(TEST_ROOT, { recursive: true });
const DATA_DIR = fs.mkdtempSync(path.join(TEST_ROOT, 'http-'));

const PORT = Number(process.env.HTTP_TEST_PORT || 8931);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name} ${extra}`);
  }
};

/** 手工构造一个 ZIP（不引打包依赖），用于测二进制上传通道。 */
function makeTestZip(files) {
  const zlib = require('node:zlib');
  const crc32 = (buf) => {
    let table = crc32.t;
    if (!table) {
      table = crc32.t = new Int32Array(256);
      for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
    return (c ^ -1) >>> 0;
  };

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nb = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(0x800, 6);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(nb.length, 26);
    locals.push(l, nb, comp);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nb.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, nb);
    offset += l.length + nb.length + comp.length;
  }
  const cen = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(files.length, 8);
  e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cen.length, 12);
  e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, e]);
}

/** 起一个独立外壳，界面从磁盘读（与开发时一致）。 */
async function startShell() {  const rendererDir = path.join(__dirname, '..', 'desktop', 'renderer');
  const shell = createShell({
    port: PORT,
    host: '127.0.0.1',
    dataDir: DATA_DIR,
    shellName: 'node-http',
    readAsset: (rel) => {
      const target = path.join(rendererDir, rel);
      if (!target.startsWith(rendererDir)) return null;
      try {
        return fs.readFileSync(target);
      } catch {
        return null;
      }
    },
  });
  await listen(shell, PORT, '127.0.0.1');
  return shell;
}

async function main() {
  console.log(`独立测试实例：${BASE}，数据目录 ${path.relative(path.join(__dirname, '..'), DATA_DIR)}`);
  const shell = await startShell();
  const token = fs.readFileSync(path.join(DATA_DIR, '.shell-token'), 'utf8').trim();
  const url = `${BASE}/?token=${token}`;

  console.log('\n[HTTP 外壳] 鉴权');
  const noToken = await fetch(`${BASE}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'questions:counts', args: {} }),
  });
  check('缺 token 的接口调用被拒绝（403）', noToken.status === 403, `实际 ${noToken.status}`);

  // ---- 安全：公开页面不得携带 token ----
  // 踩过的坑：bridge 曾经把真实 token 内联进 index.html，而 `/` 是免校验的公开路径，
  // 于是本机任意进程 `GET /` 就能抓走 token，再拿去消耗用户的模型额度。
  console.log('\n[HTTP 外壳] 公开页不得泄露 token');
  const pageNoToken = await fetch(`${BASE}/`);
  const pageBody = await pageNoToken.text();
  check('公开页可访问（不需要 token）', pageNoToken.status === 200, `实际 ${pageNoToken.status}`);
  check('公开页里不含真实 token', !pageBody.includes(token), '页面里出现了 token 字面量');
  check('公开页里没有内联的 x-dsh-token 值', !/x-dsh-token['"]?\s*:\s*['"][a-f0-9]{16,}/.test(pageBody));
  check('桥改为从地址栏读取 token', /URLSearchParams\(location\.search\)/.test(pageBody), '应使用 location.search 取 token');
  check('取到后存入 sessionStorage（刷新不丢）', /sessionStorage/.test(pageBody));

  // 带 token 打开时，页面本身仍不应包含 token
  const pageWithToken = await fetch(url);
  const pageWithTokenBody = await pageWithToken.text();
  check('带 token 打开页面时，页面源码里也没有 token', !pageWithTokenBody.includes(token));

  // ---- 健壮性：畸形请求不得打死服务 ----
  // 踩过的坑：`new URL(req.url, ...)` 对 `//[` 抛异常，且在 token 校验之前、
  // 无人捕获，直接把整个服务进程打死（本机任意程序都能做到）。
  console.log('\n[HTTP 外壳] 畸形请求不得打死服务');
  for (const badPath of ['//[', '/%', '/..%2f..', '//%5B']) {
    let status = 0;
    let threw = false;
    try {
      const r = await fetch(`${BASE}${badPath}`);
      status = r.status;
    } catch {
      threw = true;
    }
    check(`畸形路径 ${badPath} 得到响应而不是崩溃`, !threw && status >= 200 && status < 500, threw ? '连接被重置' : `实际 ${status}`);
  }
  // 服务还活着吗
  const stillAlive = await fetch(`${BASE}/api/health`);
  check('畸形请求之后服务仍然存活', stillAlive.status === 200, `实际 ${stillAlive.status}`);

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
  // 这条以前写反了：原来是 check('桥里带上了 token', page.includes(token))，
  // 那等于要求 token 被内联进公开页面 —— 正是那个漏洞。现在断言它**不在**页面里。
  check('页面里不含 token（避免被本机任意进程抓走）', !page.includes(token));
  check('桥提供二进制上传方法（整包 zip 用）', page.includes('upload:'), '渲染层要靠它走二进制通道');

  console.log('\n[HTTP 外壳] 二进制上传（整包 ZIP）');
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('健康检查暴露上传上限（界面用来预检）',
    typeof health.uploadLimitBytes === 'number' && health.uploadLimitBytes > 0,
    JSON.stringify(health).slice(0, 160));
  check('上传上限足够大（默认 200MB）', health.uploadLimitBytes >= 200 * 1024 * 1024,
    `实际 ${(health.uploadLimitBytes / 1048576).toFixed(0)} MB`);

  // 造一个小 zip（含 2 张图 + 1 个非图片）
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const zipBuf = makeTestZip([
    { name: '第一单元/1.png', data: tinyPng },
    { name: '第一单元/2.png', data: tinyPng },
    { name: 'readme.txt', data: 'not an image' },
  ]);

  const upRes = await fetch(`${BASE}/api/upload?channel=capture:unzipBinary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-dsh-token': token },
    body: zipBuf,
  });
  const upBody = await upRes.json();
  check('二进制上传解包成功', upRes.status === 200 && upBody.ok === true,
    `HTTP ${upRes.status} ${JSON.stringify(upBody).slice(0, 160)}`);
  check('取出 2 张图片（非图片被跳过）', (upBody.items || []).length === 2,
    `实际 ${(upBody.items || []).length}`);
  check('如实报告跳过了非图片文件', upBody.nonImageSkipped === 1, JSON.stringify(upBody).slice(0, 160));

  // 逐张取回
  if (upBody.items && upBody.items.length) {
    const got = await invoke('capture:zipItem', { itemId: upBody.items[0].itemId });
    check('能逐张取回暂存的图片', got.ok === true && (got.imageBase64 || '').length > 0,
      JSON.stringify(got).slice(0, 160));
  }

  // 无 token 必须被拦（二进制通道同样受鉴权保护）
  const uploadNoToken = await fetch(`${BASE}/api/upload?channel=capture:unzipBinary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: zipBuf,
  });
  check('二进制上传没有 token 会被拒绝', uploadNoToken.status === 403, `实际 ${uploadNoToken.status}`);

  // 缺 channel 参数
  const noChannel = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-dsh-token': token },
    body: zipBuf,
  });
  check('缺少 channel 参数时报错', noChannel.status === 400, `实际 ${noChannel.status}`);

  // 不是 zip 的内容要给出可理解的错误，而不是 500
  const notZip = await fetch(`${BASE}/api/upload?channel=capture:unzipBinary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-dsh-token': token },
    body: Buffer.from('这不是一个压缩包，只是一段普通文字'),
  });
  const notZipBody = await notZip.json();
  check('上传非 ZIP 内容时给出可理解的错误',
    notZip.status === 200 && notZipBody.ok === false && /不是有效的 ZIP/.test(notZipBody.error || ''),
    `HTTP ${notZip.status} ${JSON.stringify(notZipBody).slice(0, 160)}`);

  // 空 body
  const empty = await fetch(`${BASE}/api/upload?channel=capture:unzipBinary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-dsh-token': token },
    body: Buffer.alloc(0),
  });
  const emptyBody = await empty.json();
  check('空上传内容给出明确错误', emptyBody.ok === false, JSON.stringify(emptyBody).slice(0, 160));

  // 超限 → 413 且带可操作的说明（这正是用户"一直转圈"的根因修复）
  //
  // 用**另一个小上限的实例**来测，而不是往主实例灌 200MB：
  // 分配 200MB 会给整个测试进程带来内存压力（实测出现过偶发失败）。
  // 换个上限走的是同一条判断逻辑，验证效果一样，开销小得多。
  const tinyPort = PORT + 1;
  const tinyShell = createShell({
    port: tinyPort,
    host: '127.0.0.1',
    dataDir: DATA_DIR,
    shellName: 'test-tiny-limit',
    uploadLimit: 1 * 1024 * 1024, // 1MB，方便用小数据触发超限
    readAsset: () => null,
  });
  await listen(tinyShell, tinyPort, '127.0.0.1');
  const tooBig = await fetch(`http://127.0.0.1:${tinyPort}/api/upload?channel=capture:unzipBinary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-dsh-token': token },
    body: Buffer.alloc(2 * 1024 * 1024), // 2MB，超过上面设的 1MB
  });
  const tooBigBody = await tooBig.json();
  check('超过上传上限时返回 413 而不是掐断连接', tooBig.status === 413,
    `实际 ${tooBig.status}`);
  check('超限响应里有可操作的说明', /超过上限/.test(tooBigBody.error || ''),
    JSON.stringify(tooBigBody).slice(0, 200));
  tinyShell.server.close();
  tinyShell.host.close();

  // 服务被拒绝大请求后仍然健康
  const aliveAfterBig = await fetch(`${BASE}/api/health`);
  check('超限请求之后服务仍然存活', aliveAfterBig.status === 200, `实际 ${aliveAfterBig.status}`);

  console.log('\n[HTTP 外壳] 识别数量核对（用户报告的"13 题录成 15 题"）');
  // 假读图模型：故意自报 13 道、却返回 15 条，其中一条标记为不完整。
  // 这正是用户遇到的情形，端到端验证整条链路能否把它发现出来。
  const fakeVision = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const questions = [];
      for (let i = 1; i <= 15; i += 1) {
        questions.push({
          stem: `第 ${i} 题 ____ here.`,
          options: { A: 'a', B: 'b', C: 'c', D: 'd' },
          answer: 'B',
          incomplete: i === 7,
          incompleteReason: i === 7 ? '选项 D 被裁掉' : undefined,
        });
      }
      const content = JSON.stringify({ totalInImage: 13, questions });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => fakeVision.listen(0, '127.0.0.1', r));
  shell.host.store.set({
    baseUrl: `http://127.0.0.1:${fakeVision.address().port}/v1`,
    apiKey: 'fake',
    model: 'fake',
    visionModel: 'fake',
  });

  const visionRes = await invoke('capture:extract', {
    imageBase64: Buffer.from('fake image bytes').toString('base64'),
    mime: 'image/png',
    answerInSource: true,
    saveImage: false,
  });
  check('识别结果里的题目照常返回', (visionRes.questions || []).length === 15,
    `实际 ${(visionRes.questions || []).length}`);
  check('接口报出"模型说 13 道"', visionRes.claimedTotal === 13, `实际 ${visionRes.claimedTotal}`);
  check('接口报出"实际抄出 15 条"', visionRes.actualTotal === 15, `实际 ${visionRes.actualTotal}`);
  check('接口明确标记数量不符', visionRes.countMismatch === true);
  check('接口报出不完整题数', visionRes.incompleteCount === 1, `实际 ${visionRes.incompleteCount}`);
  const vWarn = (visionRes.warnings || []).join(' ');
  check('警告里说明了数量对不上及两个数字', /数量对不上/.test(vWarn) && /13/.test(vWarn) && /15/.test(vWarn),
    vWarn.slice(0, 200));
  check('警告里提示有不完整题并建议重新识别', /不完整/.test(vWarn) && /重新识别|重拍/.test(vWarn),
    vWarn.slice(0, 200));
  check('每道题带上了来源图片名（便于追溯是哪张出的问题）',
    (visionRes.questions || []).every((q) => typeof q.sourceImage === 'string'));

  // 用原图重试的支撑能力：压缩后仍能换回原图
  if (upBody.items && upBody.items.length) {
    const firstId = upBody.items[0].itemId;
    // 模拟界面压缩后回存
    const fakeCompressed = Buffer.from('compressed-bytes-not-really-an-image').toString('base64');
    const saved = await invoke('capture:zipSaveCompressed', {
      itemId: firstId,
      imageBase64: fakeCompressed,
      mime: 'image/jpeg',
    });
    check('压缩结果能回存到服务端（原图会被留住）', saved.ok === true, JSON.stringify(saved));
    const restored = await invoke('capture:zipRestoreOriginal', { itemId: firstId });
    check('能把这一张换回未压缩的原图', restored.ok === true, JSON.stringify(restored));
    const afterRestore = await invoke('capture:zipItem', { itemId: firstId });
    check('换回后取到的是原图（不是压缩版）',
      afterRestore.ok === true && afterRestore.imageBase64 !== fakeCompressed,
      '换回后应当拿到原始字节');
  }
  fakeVision.close();
  // 等于把"公开页泄露 token"这个漏洞当成期望行为锁住了。
  // 正确的不变量是：**任何返回给浏览器的 HTML 都不能含 token**。
  check('桥里不得内联 token（安全不变量）', !page.includes(token), '页面里出现了 token');
  check('桥从地址栏/sessionStorage 取 token', /sessionStorage/.test(page));
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
  // 检查的是**测试实例自己的**数据目录，不是用户的 data/
  check('数据库文件已创建', fs.existsSync(path.join(DATA_DIR, 'questions.db')), path.join(DATA_DIR, 'questions.db'));
  check('地址文件已写出（供启动器使用）', fs.existsSync(path.join(DATA_DIR, '.shell-url')));

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

  console.log('\n[HTTP 外壳] 格式化（清空数据）');
  // 现在这是**独立实例**，可以放心真正执行清空 —— 它只影响临时数据目录。
  // （以前这里连着用户真实题库，我加了"用正确确认词"的断言，结果第一次跑就把
  //   用户的题清空了。测试能真正执行破坏性操作的前提，是它必须有自己的数据。）
  const resetPreview = await invoke('db:resetPreview');
  check('预览接口可用', resetPreview.ok === true && typeof resetPreview.counts === 'object',
    JSON.stringify(resetPreview).slice(0, 160));
  check('预览不改动数据', resetPreview.ok === true, '预览是只读动作');

  const noWord = await invoke('db:reset', {});
  check('没传确认词被拦住', noWord.ok === false && noWord.needConfirm === true,
    JSON.stringify(noWord).slice(0, 120));
  check('拦住时返回预览（让界面能展示代价）', Boolean(noWord.preview), JSON.stringify(noWord).slice(0, 160));

  const wrongWord = await invoke('db:reset', { confirm: '确定' });
  check('错误的确认词被拦住', wrongWord.ok === false, JSON.stringify(wrongWord).slice(0, 120));
  const spacedWord = await invoke('db:reset', { confirm: ' 格式化 ' });
  check('确认词带空格也不通过', spacedWord.ok === false, JSON.stringify(spacedWord).slice(0, 120));

  const beforeReset = await invoke('questions:counts');
  check('多次试探后数据仍在（防护有效）', beforeReset.ok === true && beforeReset.counts.total > 0,
    `题库 ${beforeReset.counts?.total} 题`);

  // 正确确认词 → 在隔离实例上真正执行，验证清空效果
  //
  // 先存一个 API Key：config.json 只在保存过模型设置后才存在，
  // 而"格式化要保留 Key"正是这里要验证的事。
  await invoke('settings:set', { apiKey: 'sk-http-test-key' });
  const didReset = await invoke('db:reset', { confirm: '格式化' });
  check('正确确认词才执行清空', didReset.ok === true, JSON.stringify(didReset).slice(0, 160));
  const afterReset = await invoke('questions:counts');
  check('清空后题库为 0', afterReset.counts.total === 0, `实际 ${afterReset.counts?.total}`);
  const groupsAfter = await invoke('groups:list');
  check('清空后分组为 0', groupsAfter.groups.length === 0);
  const settingsAfter = await invoke('settings:get');
  check('格式化保留 API Key', settingsAfter.settings.hasApiKey === true,
    JSON.stringify(settingsAfter.settings).slice(0, 120));
  const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
  check('格式化保留模型配置', cfg.apiKey === 'sk-http-test-key', `实际 ${JSON.stringify(cfg.apiKey)}`);

  console.log(`\n${failures === 0 ? 'HTTP 外壳全部通过' : `有 ${failures} 项失败`}\n`);

  // 收尾：关服务、删临时数据目录
  shell.server.close();
  shell.host.close();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* 删不掉也不影响结论 */
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nHTTP 检查无法完成：${e.message}`);
  console.error('请确认外壳已启动：node src/shell-http.js\n');
  process.exit(1);
});
