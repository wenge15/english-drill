'use strict';

/**
 * 测试运行器：跑 test/ 下所有 *.test.js，并汇总结果。
 *
 * 为什么要有个运行器：
 *   1. 原来的 npm test 只列了 5 个文件，新增的测试很容易忘记加进去；
 *   2. 每个测试文件单独起进程，互不干扰（它们各自建库、各自关库）；
 *   3. 汇总"多少项通过"，一眼能看出有没有回归。
 *
 * http.test.js 现在自带独立实例（临时数据目录 + 独立端口），
 * 不再需要预先启动服务，所以**默认一起跑**。
 * （以前它连的是用户正在使用的服务，结果把用户题库清空了 —— 见下面的超时说明）
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_DIR = path.join(__dirname, '..', 'test');
const args = process.argv.slice(2);
// 默认包含 http（它已自带实例）；需要跳过时传 --no-http
const skipHttp = args.includes('--no-http');
// 单个测试文件的硬超时。
// 踩过的坑：某条测试忘了关闭它自己启动的假 HTTP 服务器，进程就一直挂着不退出，
// 整个套件卡死而且不报错（实际卡了两分钟才发现）。这里加超时，超时按失败处理。
// 另一个坑：被 kill 时输出可能只写了一半，于是"通过数"莫名变少
// （实测出现过 352 → 348 的漂移）。所以下面遇到异常退出会明确标注"数字不完整"。
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120000);

const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !(skipHttp && f === 'http.test.js'))
  .sort();

let totalPass = 0;
let totalFail = 0;
const failures = [];
const shortFiles = [];

/**
 * 每个测试文件的**期望断言数**。
 *
 * 为什么要这张表：踩过一个很难查的坑 —— 某个测试块写在
 * `if (数据满足条件) { ...断言... }` 里，一旦前置数据不成立，
 * 断言就被**静默跳过**：通过数变少、退出码仍是 0，看起来完全正常。
 * 实测遇到过 92 → 88 的漂移，查了很久才发现是集训那 4 条被跳过了。
 *
 * 有了这张表，"测试少了几项"会立刻暴露。改测试后如果断言数变了，
 * 就要同步改这里 —— 强制你确认"这个变化是我想要的"。
 */
const EXPECTED = {
  'bulk-delete.test.js': 11,
  'db.test.js': 15,
  'extract.test.js': 27,
  'flow.test.js': 11,
  'glossary.test.js': 11,
  'group-sprint.test.js': 19,
  'http.test.js': 94,
  'knowledge.test.js': 28,
  'model.test.js': 28,
  'reset.test.js': 11,
  'safety.test.js': 7,
  'shuffle.test.js': 12,
  'srs.test.js': 15,
  'teach-chat.test.js': 22,
  'textparse.test.js': 18,
  'ui.test.js': 27,
  'zip.test.js': 16,
};

for (const file of files) {
  const full = path.join(TEST_DIR, file);
  const res = spawnSync(process.execPath, [full], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });

  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT');
  const crashed = !timedOut && res.status !== 0;

  // 两种计数方式：node:test 输出「ℹ pass N」，自写的 check() 输出「PASS  名称」。
  // 只认前一种会让 http.test.js 显示成 0 通过并被误判为失败。
  const passMatch = out.match(/^ℹ pass (\d+)/m);
  const failMatch = out.match(/^ℹ fail (\d+)/m);
  const pass = passMatch ? Number(passMatch[1]) : (out.match(/^\s*PASS\s/gm) || []).length;
  const fail = failMatch ? Number(failMatch[1]) : (out.match(/^\s*FAIL\s/gm) || []).length;

  totalPass += pass;
  totalFail += fail;

  // 断言数比预期少 = 有测试被静默跳过（条件不成立时最典型）。
  // 这类问题不会让退出码非 0，所以必须显式抓出来。
  const expected = EXPECTED[file];
  const shrunk = expected !== undefined && pass < expected;

  // 注意：判断"是否失败"要用真正的失败/超时/崩溃，而不是 pass===0 ——
  // 有的测试文件可能合法地输出 0 项（例如全部条件都被跳过）
  const bad = timedOut || crashed || fail > 0 || shrunk;
  const mark = bad ? '✗' : '✓';
  const label = file.replace(/\.test\.js$/, '');
  process.stdout.write(`${mark} ${label.padEnd(16)} ${String(pass).padStart(4)} 通过`);
  if (fail > 0) process.stdout.write(`  ${fail} 失败`);
  if (shrunk) {
    process.stdout.write(`  ⚠ 比预期少 ${expected - pass} 项（应有 ${expected}）—— 可能有断言被静默跳过`);
    shortFiles.push({ file, expected, pass });
  }
  if (timedOut) process.stdout.write(`  ⏱ 超时 ${TIMEOUT_MS / 1000}s（进程未退出，通常是漏了关服务器/定时器）`);
  else if (crashed) process.stdout.write('  （进程异常退出）');
  process.stdout.write('\n');
  if (fail === 0 && pass > 0 && out.includes('[HTTP 外壳]')) {
    // HTTP 测试输出很长，折叠一下
    process.stdout.write('   （为了让运行器能识别，这里只统计结果；详细输出请单独跑 node test/http.test.js）\n');
  }

  if (bad) {
    failures.push({ file, out, timedOut, shrunk, expected, pass });
  }
}

process.stdout.write('\n');

if (failures.length > 0) {
  process.stdout.write('失败详情：\n\n');
  for (const f of failures) {
    process.stdout.write(`--- ${f.file} ---\n`);
    if (f.timedOut) {
      process.stdout.write('进程在超时前没有退出。常见原因：测试里启动了 HTTP 服务器或定时器但忘了关闭。\n\n');
      continue;
    }
    if (f.shrunk) {
      process.stdout.write(
        `断言数比预期少：实际 ${f.pass}，期望 ${f.expected}。\n` +
          '某个测试块的条件不成立，里面的断言被静默跳过了 ——\n' +
          '这类问题退出码仍是 0，所以必须靠期望数表才能发现。\n' +
          '请检查该测试是否依赖了前面测试遗留的数据（应自己准备数据），\n' +
          '或确认是有意删减后同步更新 EXPECTED。\n\n',
      );
      continue;
    }
    // 只打关键行，避免刷屏
    const lines = f.out.split('\n');
    const keep = lines.filter(
      (l) => /AssertionError|Error:|✖|not ok|at .*\.test\.js/.test(l) && !/^\s*✔/.test(l),
    );
    process.stdout.write(`${(keep.length ? keep : lines.slice(-30)).slice(0, 40).join('\n')}\n\n`);
  }
}

process.stdout.write(`合计：${totalPass} 项通过，${totalFail} 项失败\n`);
if (shortFiles.length > 0) {
  process.stdout.write(
    `⚠ 有 ${shortFiles.length} 个文件的断言数少于预期：` +
      shortFiles.map((s) => `${s.file}（${s.pass}/${s.expected}）`).join('、') +
      '\n  这通常意味着某个测试块的条件不成立、里面的断言被静默跳过了。\n' +
      '  请检查该测试是否依赖了前面测试留下的数据 —— 好的测试应该自己准备数据。\n' +
      '  如果确实是有意删掉/合并了断言，请同步更新 test/run-all.js 里的 EXPECTED。\n',
  );
}
if (failures.length > 0) {
  // 有文件异常退出时，各文件的输出可能不完整，合计数字会偏小 —— 说清楚
  process.stdout.write('（注意：上面有文件异常退出，它的输出可能不完整，合计数字可能偏小）\n');
}
if (skipHttp) {
  process.stdout.write('（按要求跳过了 http.test.js）\n');
}

process.exit(totalFail > 0 || failures.length > 0 ? 1 : 0);
