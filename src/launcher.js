'use strict';

/**
 * 启动器（用 Node 实现，避开 cmd.exe 的编码坑）。
 *
 * 为什么不用纯批处理：cmd.exe 按系统 ANSI 代码页（本机 GBK）读取 .bat 文件，
 * UTF-8 写的中文注释会被拆成乱码并把命令行撑坏（实测踩过）。
 * 所以 .bat 只保留三行 ASCII，一切逻辑与中文提示都在这里。
 *
 * 做的事：
 *   1. 服务没跑就把它拉起来（分离进程，不占着这个窗口）
 *   2. 等服务就绪
 *   3. 用 Edge 的应用窗口打开界面
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const URL_FILE = path.join(DATA_DIR, '.shell-url');
const TOKEN_FILE = path.join(DATA_DIR, '.shell-token');
const PORT = Number(process.env.PORT || 8899);
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取得界面地址：优先用已有的 .shell-url，否则用 .shell-token 拼出来。
 * token 由外壳进程创建；这里读不到就临时生成一个（外壳之后会读到同一个文件）。
 */
function readOrCreateUrl() {
  try {
    const existing = fs.readFileSync(URL_FILE, 'utf8').trim();
    if (/^https?:\/\/.+token=.+/.test(existing)) return existing;
  } catch {
    /* 没有或坏了，往下走 */
  }
  let token = '';
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    token = '';
  }
  if (!token) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      token = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    } catch {
      return '';
    }
  }
  return `http://127.0.0.1:${PORT}/?token=${token}`;
}

/** 探测服务是否就绪。必须检查响应内容而不是只看状态码：
 *  早期版本里 /api/health 被鉴权拦下时也返回 200，导致启动器误判为"已就绪"。 */
function ping() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 在当前目录下找 Edge（应用模式需要一个基于 Chromium 的浏览器）。 */
function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

(async () => {
  const running = await ping();

  if (!running) {
    console.log('正在启动英语练习服务…');
    // detached + 忽略 stdio：服务独立存活，不依赖这个启动器进程
    const child = spawn(process.execPath, [path.join(__dirname, 'shell-http.js')], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PORT: String(PORT) },
    });
    child.unref();

    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      if (await ping()) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      console.error('\n服务启动失败或超时。');
      console.error('请在本目录手动运行以下命令，并查看它打印的错误：');
      console.error('    node src\\shell-http.js');
      process.exit(1);
    }
    console.log('服务已就绪。');
  }

  // 构造界面地址。
  //
  // 为什么不用 .shell-url 文件：曾经这里读那个文件，而启动器（VBS）为了判断
  // "这一次是否启动成功"会先把它删掉。于是当服务**本来就在跑**时，
  // 这里读不到文件就报错退出 —— 窗口永远打不开（实测踩过，用户双击没反应）。
  // 现在改成自己从 .shell-token 拼地址，任何情况下都能算出正确 URL。
  const url = readOrCreateUrl();
  if (!url) {
    console.error('\n无法确定界面地址：读不到访问令牌。');
    console.error(`请检查数据目录是否可写：${DATA_DIR}`);
    process.exit(1);
  }
  // 顺手把地址写盘，方便其它工具（快捷方式、排错脚本）读取
  try {
    fs.writeFileSync(URL_FILE, url, 'utf8');
  } catch {
    /* 写不了不影响开窗口 */
  }

  const browser = findEdge();
  if (browser) {
    // 用应用窗口打开：没有地址栏和标签页，观感就是一个独立桌面软件。
    //
    // 必须指定独立的 --user-data-dir：
    // Edge 已经在运行时，`--app=URL` 会被交给**现有**的浏览器进程处理，
    // 结果只是在你原来的窗口里多开一个标签页，看起来像"没弹出窗口"（实测踩过）。
    // 用独立配置目录会启动一个真正独立的实例，稳定得到应用窗口，
    // 也不会干扰用户自己的 Edge 配置。
    const profileDir = path.join(DATA_DIR, 'browser-profile');
    try {
      fs.mkdirSync(profileDir, { recursive: true });
    } catch {
      /* 建不了就退回默认行为 */
    }
    const args = [
      `--app=${url}`,
      '--window-size=1280,900',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,EdgeCollections',
    ];
    if (fs.existsSync(profileDir)) args.push(`--user-data-dir=${profileDir}`);

    spawn(browser, args, { detached: true, stdio: 'ignore' }).unref();
    console.log('已打开英语练习窗口。');
  } else {
    // 没有 Edge/Chrome 时退化为默认浏览器
    try {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      console.log('已用默认浏览器打开界面。');
    } catch {
      console.log(`请手动在浏览器打开：\n${url}`);
    }
  }

  // 写一个明确的"本次启动成功"标记。
  // 启动器（VBS）靠它判断成功与否 —— 不能靠 .shell-url：那个文件在服务
  // 本来就在跑的情况下可能不存在，会造成"明明成功了却报失败"。
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, '.launcher-ok'),
      `${new Date().toISOString()} ${url}\n`,
      'utf8',
    );
  } catch {
    /* 写不了不影响使用 */
  }
})().catch((e) => {
  console.error(`启动失败：${e.message}`);
  process.exit(1);
});
