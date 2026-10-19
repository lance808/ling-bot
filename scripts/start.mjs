/**
 * 桌面端启动器 —— 绕开一个本机环境陷阱
 *
 * 这台机器上存在 `ELECTRON_RUN_AS_NODE=1`（多半是某个工具留下的）。
 * 它会让 Electron 退化成纯 Node：没有窗口、`app` 是 undefined、
 * `require('electron')` 返回一个字符串。表现像"代码写错了"，其实不是。
 *
 * 所以 npm start 走这个壳：**先删掉该变量**，再拉起 Electron。
 * 这样启动方式对所有人一致，不用每次手动清环境。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

/** 拿到 electron 可执行文件路径（这个包在 Node 下默认导出就是路径字符串） */
function electronPath() {
  const mod = require('electron');
  if (typeof mod !== 'string') {
    throw new Error(
      '拿不到 Electron 可执行文件路径。请先安装：npm install（国内网络可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）',
    );
  }
  return mod;
}

let exe;
try {
  exe = electronPath();
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/** 透传 `--dev` 给主进程（打开 DevTools） */
const args = ['.', ...process.argv.slice(2)];

/**
 * stdio 的取舍：
 *
 * - 从终端跑（npm start）：希望看到实时日志 → 'inherit'
 * - 从 exe 静默启动：父进程把我们的 stdout 重定向到了管道（不是 TTY），
 *   这时用 'inherit' 会把 Electron 的输出写到一个管道里，最终落到 launcher.log。
 *   但如果用 'ignore'，日志就完全消失了——静默模式下出问题时无从排查。
 *
 * 所以这里用 'pipe' 并手动转发：无论有没有控制台，输出都不丢。
 */
const hasConsole = Boolean(process.stdout.isTTY);

const child = spawn(exe, args, {
  cwd: repoRoot,
  env,
  stdio: hasConsole ? 'inherit' : 'pipe',
  // Windows 上禁止弹出新窗口（配合 CreateNoWindow）
  windowsHide: true,
});

if (!hasConsole) {
  // 静默模式：把子进程输出转到自己的 stdout，
  // 由启动器统一写进 logs/launcher.log
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
}

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`✖ 启动失败：${err.message}`);
  process.exit(1);
});
