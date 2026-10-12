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

test('守护：压缩包必须走二进制通道，不能退回 base64', () => {
  // 踩过的坑：整包识别最初用 JSON + base64 上传，65MB 的压缩包会变成 87MB，
  // 撞上请求体上限后被拒，而超限时连接被掐断 —— 界面一直转圈，用户不知道原因。
  const html = fs.readFileSync(path.join(ROOT, 'desktop', 'renderer', 'index.html'), 'utf8');
  const shell = fs.readFileSync(path.join(ROOT, 'src', 'shell-server.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src', 'host.js'), 'utf8');

  // 界面读 zip 必须用 ArrayBuffer，不能是 readAsDataURL
  const from = html.indexOf("$('#zipFile').onchange");
  const zipHandler = html.slice(from, from + 3000);
  assert.ok(/readAsArrayBuffer/.test(zipHandler), '读压缩包应使用 readAsArrayBuffer（二进制）');
  assert.ok(!/readAsDataURL/.test(zipHandler), '读压缩包不该用 readAsDataURL（会膨胀 33%）');
  assert.ok(/UPLOAD\(/.test(zipHandler), '应走二进制上传通道');
  assert.ok(/capture:unzipBinary/.test(zipHandler), '应调用二进制解包动作');

  // 外壳必须提供该通道，并有独立的（更大的）上限
  assert.ok(/\/api\/upload/.test(shell), '外壳应提供 /api/upload 通道');
  assert.ok(/uploadLimit/.test(shell), '应有独立的上传上限');
  assert.ok(/BODY_TOO_LARGE/.test(shell), '超限要有专门的错误码，便于界面区分提示');

  // 超限时不能直接 destroy —— 否则浏览器只看到"连接被重置"
  const readBodyStart = shell.indexOf('function readBody');
  const readBodyFn = shell.slice(readBodyStart, readBodyStart + 1400);
  assert.ok(!/req\.destroy\(\)/.test(readBodyFn), '超限时不该 destroy 连接（要让 4xx 响应能送达）');

  // 宿主两条路径共用同一套处理，避免行为分叉
  assert.ok(/function processZipBuffer/.test(host), '解包处理应抽成共用函数');
  assert.ok(/capture:unzipBinary/.test(host), '宿主应支持二进制解包');
});
