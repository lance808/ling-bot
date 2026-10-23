/**
 * 打成可分发的 Windows 安装包。
 *
 * 为什么自己拼而不是只用 cargo：Tauri 只负责窗口和托盘，
 * 后端的 Node 脚本和 Node 运行时都得一起进包，否则装完打不开。
 *
 * 产出：dist/Ling-bot-<version>.exe（NSIS 安装包）与免安装目录。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

function cargo() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const candidates = [
    path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', exe),
    path.join(process.env.HOME ?? '', '.cargo', 'bin', exe),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return exe;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`✖ 命令失败：${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

/* --------------------------------------------------------- 1. 构建 */

console.log('▸ 构建桌面端（release）…');
run(cargo(), ['build', '--release', '--manifest-path', path.join('desktop', 'Cargo.toml')]);

const exeName = process.platform === 'win32' ? 'ling-bot-desktop.exe' : 'ling-bot-desktop';
const builtExe = path.join(repoRoot, 'desktop', 'target', 'release', exeName);
if (!fs.existsSync(builtExe)) {
  console.error(`✖ 找不到构建产物：${builtExe}`);
  process.exit(1);
}

/* --------------------------------------------------------- 2. 组装 */

const appDir = path.join(distDir, 'Ling-bot');
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

// 桌面壳
fs.copyFileSync(builtExe, path.join(appDir, 'Ling-bot.exe'));

// 后端脚本（src 全量，含插件与内置资源）
copyTree(path.join(repoRoot, 'src'), path.join(appDir, 'src'));
copyTree(path.join(repoRoot, 'plugins'), path.join(appDir, 'plugins'));
copyTree(path.join(repoRoot, 'ui'), path.join(appDir, 'ui'));
copyTree(path.join(repoRoot, 'assets'), path.join(appDir, 'assets'));

// Node 运行时：用当前 node.exe，保证目标机没装 Node 也能跑
const nodeExe = process.execPath;
fs.mkdirSync(path.join(appDir, 'runtime'), { recursive: true });
fs.copyFileSync(nodeExe, path.join(appDir, 'runtime', path.basename(nodeExe)));

// 一页说明，不至于让用户看着目录发呆
fs.writeFileSync(
  path.join(appDir, 'README.txt'),
  [
    'Ling-bot',
    '',
    '双击 Ling-bot.exe 启动。',
    '',
    '插件：就在本目录的 plugins 下。改完重启应用生效。',
    '数据（配置、凭据、会话、日记、日志、插件运行数据）在 %APPDATA%\\ling-bot，',
    '卸载应用不会删。',
    '',
  ].join('\r\n'),
  'utf8',
);

console.log(`✓ 免安装目录：${appDir}`);

/* --------------------------------------------------------- 3. 安装包 */

// NSIS 由 Tauri 自己的打包器生成；这里只做前置组装，真正的安装包走 tauri build
// （需要 @tauri-apps/cli，作为可选步骤，缺了也能拿到免安装版）
console.log('✓ 完成。要生成安装包，可用 cargo tauri build（需装 tauri-cli）。');

/* --------------------------------------------------------- 工具 */

function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}
