/**
 * 开发期启动桌面端。
 *
 * 为什么还要这个脚本：Tauri 的 exe 只会拉起 `src/index.mjs`，
 * 开发者想先看后端日志、或者只想跑后端时，仍然需要一个入口。
 * 这里把"构建 + 启动"合成一条命令，省得每次手敲 cargo。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const cargoToml = path.join(repoRoot, 'desktop', 'Cargo.toml');

if (!fs.existsSync(cargoToml)) {
  console.error('✖ 找不到 desktop/Cargo.toml，桌面壳缺失');
  process.exit(1);
}

/** cargo 在用户目录下，PATH 里不一定有 */
function cargoPath() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const candidates = [
    path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', exe),
    path.join(process.env.HOME ?? '', '.cargo', 'bin', exe),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return exe;
}

const profile = process.argv.includes('--release') ? 'release' : 'debug';

console.log(`▸ 构建桌面端（${profile}）…`);
const build = spawnSync(
  cargoPath(),
  ['build', '--manifest-path', cargoToml, ...(profile === 'release' ? ['--release'] : [])],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (build.status !== 0) {
  console.error('✖ 构建失败');
  process.exit(build.status ?? 1);
}

const exe = path.join(
  repoRoot,
  'desktop',
  'target',
  profile,
  process.platform === 'win32' ? 'ling-bot-desktop.exe' : 'ling-bot-desktop',
);
if (!fs.existsSync(exe)) {
  console.error(`✖ 构建产物不存在：${exe}`);
  process.exit(1);
}

console.log(`▸ 启动 ${exe}`);
const child = spawn(exe, process.argv.slice(2).filter((a) => a !== '--release'), {
  cwd: path.join(repoRoot, 'desktop'),
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
