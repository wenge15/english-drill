'use strict';

/**
 * 测试运行器：跑 test/ 下所有 *.test.js，并汇总结果。
 *
 * 为什么要有个运行器：
 *   1. 原来的 npm test 只列了 5 个文件，新增的测试很容易忘记加进去（实际已经漏了 8 个）；
 *   2. 每个测试文件单独起进程，互不干扰（它们各自建库、各自关库）；
 *   3. 汇总"多少项通过"，一眼能看出有没有回归。
 *
 * http.test.js 需要先启动服务，所以默认跳过；
 * 用 --with-http 或在服务已运行时加 --http 才会跑。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_DIR = path.join(__dirname, '..', 'test');
const args = process.argv.slice(2);
const withHttp = args.includes('--with-http') || args.includes('--http');
// 单个测试文件的硬超时。
// 踩过的坑：某条测试忘了关闭它自己启动的假 HTTP 服务器，进程就一直挂着不退出，
// 整个套件卡死而且不报错（实际卡了两分钟才发现）。这里加超时，超时按失败处理。
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 120000);

const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => (withHttp ? true : f !== 'http.test.js'))
  .sort();

let totalPass = 0;
let totalFail = 0;
const failures = [];

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

  const passMatch = out.match(/^ℹ pass (\d+)/m);
  const failMatch = out.match(/^ℹ fail (\d+)/m);
  const pass = passMatch ? Number(passMatch[1]) : 0;
  const fail = failMatch ? Number(failMatch[1]) : 0;

  totalPass += pass;
  totalFail += fail;

  const bad = timedOut || crashed || fail > 0 || pass === 0;
  const mark = bad ? '✗' : '✓';
  const label = file.replace(/\.test\.js$/, '');
  process.stdout.write(`${mark} ${label.padEnd(16)} ${String(pass).padStart(4)} 通过`);
  if (fail > 0) process.stdout.write(`  ${fail} 失败`);
  if (timedOut) process.stdout.write(`  ⏱ 超时 ${TIMEOUT_MS / 1000}s（进程未退出，通常是漏了关服务器/定时器）`);
  else if (crashed) process.stdout.write('  （进程异常退出）');
  process.stdout.write('\n');

  if (bad) {
    failures.push({ file, out, timedOut });
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
    // 只打关键行，避免刷屏
    const lines = f.out.split('\n');
    const keep = lines.filter(
      (l) => /AssertionError|Error:|✖|not ok|at .*\.test\.js/.test(l) && !/^\s*✔/.test(l),
    );
    process.stdout.write(`${(keep.length ? keep : lines.slice(-30)).slice(0, 40).join('\n')}\n\n`);
  }
}

process.stdout.write(`合计：${totalPass} 项通过，${totalFail} 项失败\n`);
if (!withHttp) {
  process.stdout.write('（未包含 http.test.js —— 它需要先启动服务。用 npm run test:http 单独跑）\n');
}

process.exit(totalFail > 0 || failures.length > 0 ? 1 : 0);
