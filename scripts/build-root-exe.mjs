/**
 * 构建并把桌面端复制到仓库根为 Ling-bot.exe。
 *
 * 为什么要这一步：根目录的 exe 是要随仓库分发的（clone 完不用装 Rust
 * 就能双击）。但它必须和 desktop/ 的源码同源，否则仓库里那份迟早会和
 * 源码对不上，变成没人知道怎么来的二进制。
 *
 * 用法：
 *   node scripts/build-root-exe.mjs           # 构建 + 复制
 *   node scripts/build-root-exe.mjs --check   # 只检查根目录 exe 是否最新
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeName = process.platform === 'win32' ? 'ling-bot-desktop.exe' : 'ling-bot-desktop';
const built = path.join(repoRoot, 'desktop', 'target', 'release', exeName);
const target = path.join(repoRoot, process.platform === 'win32' ? 'Ling-bot.exe' : 'Ling-bot');

const checkOnly = process.argv.includes('--check');

/** cargo 在用户目录下，PATH 里不一定有 */
function cargo() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  for (const c of [
    path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', exe),
    path.join(process.env.HOME ?? '', '.cargo', 'bin', exe),
  ]) {
    if (c && fs.existsSync(c)) return c;
  }
  return exe;
}

if (checkOnly) {
  if (!fs.existsSync(target)) {
    console.error('✖ 根目录缺少 Ling-bot.exe（应随仓库分发）');
    process.exit(1);
  }
  console.log(`✓ 根目录存在 Ling-bot.exe（${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} MB）`);
  process.exit(0);
}

console.log('▸ 构建桌面端（release）…');
const r = spawnSync(
  cargo(),
  ['build', '--release', '--manifest-path', path.join('desktop', 'Cargo.toml')],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (r.status !== 0) {
  console.error('✖ 构建失败');
  process.exit(r.status ?? 1);
}

if (!fs.existsSync(built)) {
  console.error(`✖ 找不到构建产物：${built}`);
  process.exit(1);
}

fs.copyFileSync(built, target);
const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(2);
console.log(`✓ 已复制到 ${path.relative(repoRoot, target)}（${mb} MB）`);
console.log('');
console.log('提醒：这个 exe 只负责窗口与后端进程管理，后端本身是 Node 脚本。');
console.log('     目标机器仍需 Node >= 24.22（见 README 版本基线）。');
