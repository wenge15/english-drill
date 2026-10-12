'use strict';

/**
 * 本机 HTTP 外壳的**共用实现**。
 *
 * 单独抽出来是为了让"换外壳"不用改业务代码：
 *   - src/shell-http.js  开发用（源码目录直接跑，界面从 desktop/renderer 读）
 *   - 打包版（单文件 exe）也复用这里的 createShell，只是 readAsset 换成从 exe 内部读
 *
 * 安全：只监听 127.0.0.1，并校验 token，避免本机其它程序白嫖你的模型额度。
 * token 固定存盘（否则每次重启地址都变，桌面快捷方式就失效了）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHost } = require('./host.js');

/** 读取或生成本机访问 token（固定存盘）。 */
function loadToken(dataDir) {
  const tokenFile = path.join(dataDir, '.shell-token');
  let token = process.env.SHELL_TOKEN || '';
  if (!token) {
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      token = '';
    }
  }
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, token, 'utf8');
  }
  return token;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 默认请求体上限：图片走 base64（会放大 33%），所以给得宽一些。 */
const DEFAULT_BODY_LIMIT = 60 * 1024 * 1024;

/**
 * 读取请求体。
 * @param {object} req
 * @param {number} limit 字节上限
 * @param {boolean} asBuffer true 返回 Buffer（二进制上传用），false 返回 UTF-8 字符串
 *
 * 超限时**不立刻 destroy**：先让事件循环把响应写出去，
 * 否则浏览器只会看到"连接被重置"，用户以为卡住了却不知道原因（实测踩过：
 * 65MB 的 zip 转 base64 后约 87MB，超过上限后界面一直转圈）。
 */
function readBody(req, limit = DEFAULT_BODY_LIMIT, asBuffer = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!aborted) {
          aborted = true;
          const mb = (limit / 1048576).toFixed(0);
          const err = new Error(`文件太大：超过上限 ${mb} MB。请分卷压缩，或先把图片压缩一遍再打包`);
          err.code = 'BODY_TOO_LARGE';
          reject(err);
        }
        // 继续把流读掉（不 destroy），让服务端能把 4xx 响应完整送出去
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const buf = Buffer.concat(chunks);
      resolve(asBuffer ? buf : buf.toString('utf8'));
    });
    req.on('error', (e) => {
      if (!aborted) reject(e);
    });
  });
}

/**
 * 二进制上传通道：原样接收文件字节，不做任何编码转换。
 *
 * 为什么单独开一条：走 JSON 必须把二进制转成 base64（体积 +33%），
 * 65MB 的压缩包会变成 87MB —— 既慢，又容易撞上限，内存还要同时留两份。
 * 这条路直接把字节送进来，省掉全部这些开销。
 *
 * 鉴权与 /api/invoke 一致：token 走查询参数或 x-dsh-token 头。
 */
function readRawUpload(req, limit) {
  return readBody(req, limit, true);
}

/**
 * 创建外壳。
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.host
 * @param {string} opts.dataDir
 * @param {(rel:string)=>Buffer|null} opts.readAsset  读取界面资源（相对路径，如 'index.html'）
 * @param {string} [opts.shellName]
 * @param {boolean} [opts.quiet]  自检时不打印日志（避免构建流程被噪声淹没）
 * @returns {{server:import('node:http').Server, host:object, token:string, url:string}}
 */
function createShell(opts) {
  const {
    port,
    host: hostAddr,
    dataDir,
    readAsset,
    shellName = 'node-http',
    quiet = false,
    // 二进制上传（整包 zip）的上限。给得宽是因为这条路不做编码转换，
    // 65MB 的压缩包就是 65MB；而走 JSON 时同样的包会变成 87MB。
    // 可用 UPLOAD_LIMIT_MB 环境变量覆盖（例如遇到特别大的包）。
    uploadLimit = (Number(process.env.UPLOAD_LIMIT_MB) || 200) * 1024 * 1024,
  } = opts;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const token = loadToken(dataDir);
  const appHost = createHost({ dataDir });

  const server = http.createServer(async (req, res) => {
    // 解析请求目标必须容错，而且要在做任何事之前。
    // 踩过的坑：`new URL(req.url, ...)` 对 `//[` 这类畸形路径会抛 Invalid URL；
    // 这个异常发生在 token 校验之前且没人捕获，直接把整个服务进程打死
    // —— 本机任意程序发一个畸形请求就能让用户的练习中断。
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      json(res, 400, { ok: false, error: '请求路径不合法' });
      return;
    }
    const { pathname } = url;

    // 只允许带正确 token 的请求；页面本身与健康检查除外
    // （健康检查必须免 token：启动器要用它判断服务是否就绪，而它只监听本机、只返回状态）
    const PUBLIC_PATHS = new Set(['/', '/index.html', '/api/health']);
    if (
      !PUBLIC_PATHS.has(pathname) &&
      url.searchParams.get('token') !== token &&
      req.headers['x-dsh-token'] !== token
    ) {
      json(res, 403, { ok: false, error: '缺少或错误的访问令牌。请从启动时打印的地址打开界面。' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/invoke') {
      let payload;
      try {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } catch (e) {
        // 体积超限单独给出可操作的提示（而不是笼统的"解析失败"）
        json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, {
          ok: false,
          error: e.code === 'BODY_TOO_LARGE' ? e.message : `请求解析失败：${e.message}`,
          code: e.code || '',
        });
        return;
      }
      const { channel, args } = payload;
      const result = await appHost.invoke(channel, args);
      json(res, 200, result);
      return;
    }

    /**
     * 二进制上传：原样接收文件字节（不转 base64）。
     * 目前用于整包识别上传 ZIP。查询参数 channel 指定要调用的动作，
     * 外壳把收到的 Buffer 放进 args.bytes 传给宿主。
     */
    if (req.method === 'POST' && pathname === '/api/upload') {
      const channel = url.searchParams.get('channel') || '';
      if (!channel) {
        json(res, 400, { ok: false, error: '缺少 channel 参数' });
        return;
      }
      let bytes;
      let extra = {};
      try {
        bytes = await readRawUpload(req, uploadLimit);
        // 允许通过头传一些简单参数（例如答案标记），避免再走一次请求
        const rawExtra = req.headers['x-dsh-args'];
        if (rawExtra) {
          try {
            extra = JSON.parse(Buffer.from(String(rawExtra), 'base64').toString('utf8'));
          } catch {
            extra = {};
          }
        }
      } catch (e) {
        json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, {
          ok: false,
          error: e.code === 'BODY_TOO_LARGE' ? e.message : `读取上传内容失败：${e.message}`,
          code: e.code || '',
        });
        return;
      }
      try {
        const result = await appHost.invoke(channel, { ...extra, bytes });
        json(res, 200, result);
      } catch (e) {
        json(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      json(res, 200, {
        ok: true,
        shell: shellName,
        dataDir,
        hasApiKey: Boolean(appHost.store.get().apiKey),
        // 把上限告诉界面，让它在选文件时就能预检 ——
        // 免得前后端各写一个数字，改了一边忘了另一边
        uploadLimitBytes: uploadLimit,
      });
      return;
    }

    if (req.method === 'GET') {
      const rel = pathname === '/' || pathname === '/index.html'
        ? 'index.html'
        : decodeURIComponent(pathname).replace(/^\/+/, '');
      // 拒绝路径穿越：只允许读取已知的界面资源
      if (rel.includes('..') || rel.includes('\\') || rel.startsWith('/')) {
        json(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      let buf = null;
      try {
        buf = readAsset(rel);
      } catch {
        buf = null;
      }
      if (!buf) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      let body = buf;
      // 把原生浏览器外壳的桥注入页面：window.dsh 用 HTTP 实现，界面代码无需改动
      if (rel === 'index.html') {
        // token 从**地址栏**读取，绝不写进这份 HTML。
        //
        // 踩过的坑：以前这里直接把真实 token 内联成 'x-dsh-token': '<token>'，
        // 而 `/` 是免校验的公开路径 —— 于是本机任意进程 `GET /` 就能抓走 token，
        // 再拿去调 /api/invoke 消耗用户的模型额度。
        // 现在页面自己从 location.search 里取（那是启动器打开时就带上的），
        // 取到后存进 sessionStorage，后续跳转/刷新也不会丢。
        const bridge = `<script>
(function () {
  var KEY = 'dsh-token';
  var fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { sessionStorage.setItem(KEY, fromUrl); } catch (e) { /* 隐私模式可能拒绝 */ }
    // 把 token 从地址栏抹掉，避免被截图、被历史记录、被其它页面读到
    try {
      var u = new URL(location.href);
      u.searchParams.delete('token');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) { /* 不支持就算了，不影响使用 */ }
  }
  var token = fromUrl;
  if (!token) { try { token = sessionStorage.getItem(KEY); } catch (e) { token = null; } }
  window.dsh = {
    isElectron: false,
    invoke: async (channel, payload) => {
      const r = await fetch('/api/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dsh-token': token || '' },
        body: JSON.stringify({ channel, args: payload || {} }),
      });
      return r.json();
    },
    /**
     * 上传二进制内容（整包 zip 用）。
     *
     * 为什么不复用 invoke：invoke 走 JSON，二进制必须先转 base64（体积 +33%）。
     * 65MB 的压缩包会变成 87MB，既慢又容易撞上限。这条通道原样传字节。
     * 渲染层只调用 dsh.upload(...)，不需要知道外壳是怎么实现的。
     */
    upload: async (channel, bytes, extraArgs) => {
      const headers = { 'Content-Type': 'application/octet-stream', 'x-dsh-token': token || '' };
      if (extraArgs) {
        try {
          headers['x-dsh-args'] = btoa(unescape(encodeURIComponent(JSON.stringify(extraArgs))));
        } catch (e) { /* 参数编不了就不带，宿主会用默认值 */ }
      }
      const r = await fetch('/api/upload?channel=' + encodeURIComponent(channel), {
        method: 'POST',
        headers,
        body: bytes,
      });
      let data = null;
      try {
        data = await r.json();
      } catch (e) {
        // 服务端返回了非 JSON（例如被中间层拦掉），给出可理解的说明
        throw new Error('上传失败（HTTP ' + r.status + '）');
      }
      if (!r.ok && data && data.error) return data;
      return data;
    },
  pickImage: async () => {
    // 浏览器没有系统文件对话框的能力，用隐藏的 file input 实现同样的语义：
    // 渲染层只调用 dsh.pickImage()，不需要知道自己跑在哪种外壳里。
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/png,image/jpeg,image/webp,image/bmp';
      inp.multiple = true;
      inp.onchange = async () => {
        const out = [];
        for (const f of [...inp.files]) {
          const dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = rej;
            fr.readAsDataURL(f);
          });
          out.push({ path: '', name: f.name, mime: f.type, base64: dataUrl.split(',')[1] });
        }
        resolve({ ok: true, files: out });
      };
      inp.oncancel = () => resolve({ ok: true, files: [] });
      inp.click();
    });
  },
  openDataDir: async () => ({ ok: true, dataDir: ${JSON.stringify(dataDir)} }),
  };
})();
<\/script>`;
        body = Buffer.from(
          buf.toString('utf8').replace('<script>\n\'use strict\';', `${bridge}\n<script>\n'use strict';`),
          'utf8',
        );
      }
      const ext = path.extname(rel).toLowerCase();
      const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': `${type}; charset=utf-8`,
        // 必须禁缓存：否则改了界面按 F5 还是旧版本，会被误判成"修改没生效"
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      });
      res.end(body);
      return;
    }

    json(res, 405, { ok: false, error: 'method not allowed' });
  });

  const url = `http://${hostAddr}:${port}/?token=${token}`;
  void log;
  return { server, host: appHost, token, url, dataDir };
}

/** 监听端口；端口被占用等失败会 reject，调用方据此换端口重试。 */
function listen(shell, port, hostAddr) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      shell.server.removeListener('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      shell.server.removeListener('error', onError);
      // 成功监听后把地址写盘，供启动器/快捷方式读取。
      // 收在这里而不是放在各个入口，是因为创建外壳的每一处都需要它
      // （开发外壳、打包 exe、测试用的独立实例），分散写容易出现"某个入口忘了写"。
      try {
        fs.writeFileSync(path.join(shell.dataDir, '.shell-url'), shell.url, 'utf8');
      } catch {
        /* 写不了不影响使用 */
      }
      resolve();
    };
    shell.server.once('error', onError);
    shell.server.once('listening', onOk);
    shell.server.listen(port, hostAddr);
  });
}

module.exports = { createShell, listen, loadToken };
