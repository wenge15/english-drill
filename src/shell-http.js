'use strict';

/**
 * 浏览器外壳（开发用）：用 Node 起一个只监听本机的服务，界面与打包版完全相同。
 *
 * 为什么需要它：Electron 需要下载约 100MB 的运行时；在下载受限或想立刻试用时，
 * 这个外壳能让软件马上跑起来（用 Edge 的 --app 模式还能得到独立的桌面窗口观感）。
 * 业务逻辑完全复用 src/host.js，而 HTTP 层与打包版共用 src/shell-server.js，
 * 两条外壳不会走偏。
 *
 * 安全：只监听 127.0.0.1，并校验一次性 token，避免本机其它程序白嫖你的模型额度。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createShell, listen } = require('./shell-server.js');

const PORT = Number(process.env.PORT || 8899);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'desktop', 'renderer');

const shell = createShell({
  port: PORT,
  host: HOST,
  dataDir: DATA_DIR,
  shellName: 'node-http',
  readAsset: (rel) => {
    const target = path.join(PUBLIC_DIR, rel);
    // 只允许读界面目录内的文件
    if (!target.startsWith(PUBLIC_DIR)) return null;
    try {
      return fs.readFileSync(target);
    } catch {
      return null;
    }
  },
});

listen(shell, PORT, HOST)
  .then(() => {
    console.log('[english-drill] 界面地址（请用这个带 token 的地址打开）：');
    console.log(`  ${shell.url}`);
    console.log(`[english-drill] 数据目录：${DATA_DIR}`);
    console.log(
      `[english-drill] API Key：${shell.host.store.get().apiKey ? '已配置' : '未配置（图片识别路径需要，文本导入不需要）'}`,
    );

    // 启动时自动备份一次数据库。
    //
    // 教训：2026-10 用户的题库丢过一次 —— WAL 里是新数据、主库停在旧检查点，
    // 而当时没有任何备份，只能靠手工解析 WAL 才救回来。所以现在每次启动都留一份
    // 自洽快照（VACUUM INTO，不受 WAL 状态影响），保留最近 10 份。
    // 备份失败只打日志，不阻塞启动。
    try {
      const bk = shell.host.repo.backupTo(path.join(DATA_DIR, 'backups'));
      if (bk.ok) {
        console.log(`[english-drill] 已备份数据库：${path.basename(bk.path)}（保留最近 ${bk.kept} 份）`);
      } else {
        console.error(`[english-drill] 备份数据库失败：${bk.error}`);
      }
    } catch (e) {
      console.error(`[english-drill] 备份数据库异常：${e.message}`);
    }

    // 把地址写盘，供启动脚本/快捷方式直接读取，避免 token 每次变化
    try {
      fs.writeFileSync(path.join(DATA_DIR, '.shell-url'), shell.url, 'utf8');
    } catch {
      /* 写不了不影响使用 */
    }
    if (process.env.PRINT_URL === '1') console.log(`URL=${shell.url}`);
  })
  .catch((e) => {
    console.error(`[english-drill] 启动失败：${e.message}`);
    process.exit(1);
  });

module.exports = { server: shell.server, host: shell.host, TOKEN: shell.token };
