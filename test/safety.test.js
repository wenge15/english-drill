'use strict';

/**
 * 安全守护：确保没有任何测试会操作真实数据。
 *
 * 为什么需要这个文件（一次真实事故换来的）：
 *   `test/http.test.js` 曾经连的是用户正在使用的服务（127.0.0.1:8899，
 *   数据目录就是 data/）。给它加上「格式化」接口的测试后，
 *   用正确确认词跑一次就把用户的题库清空了，且不可恢复。
 *
 *   根因不是某个断言写错了，而是**测试与真实数据没有隔离**。
 *   只要测试连着真实服务，迟早会有人写出破坏性断言。
 *
 * 所以这里用静态检查把规矩钉住：以后谁再把测试指回真实数据，测试会直接失败。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const ROOT = path.join(__dirname, '..');

function testFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'));
}

test('守护：没有测试把路径指向真实 data/（data/test 沙箱除外）', () => {
  const offenders = [];
  for (const f of testFiles()) {
    // 跳过本文件自己（它含检测规则的说明文字，会被自己误报）
    if (f === 'safety.test.js') continue;
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      // 跳过注释行：说明文字里会出现这些片段（本文件就是例子）
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith("'")) return;
      // 只要这行在拼路径且出现了 'data' 就要检查。
      // 注意不能要求必须是 path.join(...) —— 实际写法可能是
      // require('node:path').join(...)，那样的规则会漏掉危险代码（实测漏过一次）。
      if (!/join\(|resolve\(/.test(line)) return;
      if (!line.includes("'data'") && !line.includes('"data"')) return;
      // 允许：data/test —— 测试自己的沙箱
      const isSandbox =
        line.includes("'data', 'test'") ||
        line.includes('"data", "test"') ||
        line.includes("'data','test'");
      if (!isSandbox) offenders.push(`${f}:${i + 1}  ${trimmed}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    `以下位置把路径指向了真实 data/（会摧毁用户数据）：\n${offenders.join('\n')}`);
});

test('守护：没有测试硬编码用户正在使用的端口 8899', () => {
  const offenders = [];
  for (const f of testFiles()) {
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (/127\.0\.0\.1:8899/.test(line)) {
        // 注释里提到这个端口作为"历史教训"是允许的
        const isComment = /^\s*(\*|\/\/|')/.test(line);
        if (!isComment) offenders.push(`${f}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    `测试不该连用户正在使用的服务（8899）：\n${offenders.join('\n')}`);
});

test('守护：http 测试自带独立实例，不依赖预先启动的服务', () => {
  const src = fs.readFileSync(path.join(TEST_DIR, 'http.test.js'), 'utf8');
  assert.ok(/createShell/.test(src), 'http 测试应自己创建外壳实例');
  assert.ok(/mkdtempSync/.test(src), 'http 测试应使用临时数据目录');
  assert.ok(/fs\.rmSync/.test(src), '跑完应清理临时数据目录');
  assert.ok(!/process\.env\.BASE/.test(src), '不该再依赖外部传入的 BASE（那样会连到真实服务）');
});

test('守护：真正调用破坏性接口的测试必须带独立数据目录', () => {
  // 判断依据是"是不是真的会发起调用"，而不是"文件里有没有出现这个名字"。
  // ui.test.js 只是检查界面结构（字符串断言），不会真的清数据，所以不算。
  const destructiveCalls = [
    /invoke\(\s*'db:reset'/,
    /host\.invoke\(\s*'db:reset'/,
    /\.resetAll\(/,
    /invoke\(\s*'trash:empty'/,
    /invoke\(\s*'trash:purge'/,
  ];
  const offenders = [];
  for (const f of testFiles()) {
    if (f === 'safety.test.js') continue;
    const src = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    const callsDestructive = destructiveCalls.some((re) => re.test(src));
    if (!callsDestructive) continue;
    const isolated =
      /mkdtempSync/.test(src) || /tmpDir\(/.test(src) || /createRepo\(':memory:'\)/.test(src);
    if (!isolated) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, [],
    `以下测试调用了破坏性接口但没有独立数据目录：\n${offenders.join('\n')}`);
});

test('守护：真实数据目录不在 git 追踪范围内', () => {
  const root = ROOT;
  // data/ 必须被 .gitignore 覆盖（否则用户的题库会被推上远端）
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(/^data\//m.test(ignore), '.gitignore 必须忽略 data/');
  assert.ok(/\.shell-token/.test(ignore), '.gitignore 必须忽略访问令牌');
});

test('守护：格式化确认词不能被简化成"点两下就过"', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src', 'host.js'), 'utf8');
  // 必须比对完整的确认词，而不是只判断"非空"
  assert.ok(/const WORD = '格式化'/.test(host), '确认词应明确为「格式化」');
  assert.ok(/confirm !== WORD/.test(host), '必须做完整比对，不能只判非空');
  // 不传确认词时应该返回预览而不是执行
  assert.ok(/needConfirm: true/.test(host), '未确认时应返回 needConfirm 而不是执行');
});
