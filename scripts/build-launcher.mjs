/**
 * 编译 exe 启动器 —— 用系统自带的 .NET Framework 编译器。
 *
 * 为什么不用 electron-builder / pkg / nexe：
 *   那些都会往里塞一整个运行时（200MB+）。而这个启动器只做
 *   "检查环境 → 拉 npm start" 这一件事，几十 KB 就够了。
 *   Windows 自带 csc.exe，零新增依赖。
 *
 * 产物：build/Ling-bot.exe
 *
 * 用法：
 *   node scripts/build-launcher.mjs          # 编译
 *   node scripts/build-launcher.mjs --run    # 编译后立刻运行
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(repoRoot, 'launcher', 'Launcher.cs');
const outDir = path.join(repoRoot, 'build');
/** 静默版（默认）：双击不弹黑窗口 */
const outExe = path.join(outDir, 'Ling-bot.exe');
/** 调试版：保留控制台，能看 --check-only 输出；不参与发布 */
const outExeConsole = path.join(outDir, 'Ling-bot-console.exe');

/** 找 csc.exe：优先 64 位 .NET Framework 4.x，再到 32 位，最后看 PATH */
function findCsc() {
  const candidates = [
    'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // PATH 里找（有些环境预装了 Roslyn）
  const r = spawnSync('where', ['csc.exe'], { encoding: 'utf8', shell: true });
  if (r.status === 0) {
    const first = (r.stdout || '').split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

function main() {
  if (process.platform !== 'win32') {
    console.error('✖ 这个启动器只面向 Windows（用到 .NET Framework 与 WinForms 对话框）。');
    process.exit(2);
  }

  if (!fs.existsSync(src)) {
    console.error(`✖ 找不到源码：${src}`);
    process.exit(2);
  }

  const csc = findCsc();
  if (!csc) {
    console.error('✖ 找不到 csc.exe（.NET Framework 编译器）。');
    console.error('  Windows 10/11 一般自带。若确实没有，可安装 .NET Framework 4.x 开发者包。');
    process.exit(2);
  }

  fs.mkdirSync(outDir, { recursive: true });

  // /target:winexe = GUI 子系统，双击**不弹黑窗口**
  //
  // 代价：没有控制台可写 Console.WriteLine，`--check-only` 的输出也看不到。
  // 解决方式：编译时定义 QUIET 常量，源码里所有控制台输出走条件编译；
  // 需要看输出时用 /target:exe 编一个调试版（--console 参数）。
  const consoleMode = process.argv.includes('--console');

  /** 启动器 exe 要嵌的图标（没有就跳过，不影响编译） */
  const icoPath = path.join(repoRoot, 'assets', 'icon.ico');

  const args = [
    '/nologo',
    consoleMode ? '/target:exe' : '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    `/out:${consoleMode ? outExeConsole : outExe}`,
    '/reference:System.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    /*
     * 嵌入 exe 图标。
     *
     * 任务栏上"固定到任务栏的那一项"和资源管理器里的快捷方式，
     * 显示的是 **exe 里嵌的图标**，不是 Electron 窗口的 icon。
     * 只设 BrowserWindow({icon}) 的话，任务栏图标换不掉。
     *
     * .ico 由 scripts/make-ico.mjs 从 assets/icon.png 生成（多尺寸）。
     * 文件不存在时不加这个参数 —— 编译仍然成功，只是图标是系统默认的，
     * 不能让"少一个图标文件"阻断整个构建。
     */
    ...(fs.existsSync(icoPath) ? [`/win32icon:${icoPath}`] : []),
    ...(consoleMode ? [] : ['/define:QUIET']),
    src,
  ];

  const built = consoleMode ? outExeConsole : outExe;
  console.log(`编译器：${csc}`);
  console.log(`模式  ：${consoleMode ? '调试版（带控制台）' : '静默版（无黑窗口）'}`);
  console.log(`输出  ：${built}\n`);

  const r = spawnSync(csc, args, { encoding: 'utf8' });

  if (r.status !== 0) {
    console.error('✖ 编译失败：');
    console.error((r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }

  const size = fs.statSync(built).size;
  console.log(`✓ 编译成功（${(size / 1024).toFixed(1)} KB）`);

  // 把 exe 放到仓库根一份，方便双击（这是用户的实际使用位置）
  const rootCopy = path.join(repoRoot, consoleMode ? 'Ling-bot-console.exe' : 'Ling-bot.exe');
  fs.copyFileSync(built, rootCopy);
  console.log(`✓ 已放置：${rootCopy}`);

  // 静默版没有控制台，`--check-only` 的输出看不到，
  // 所以两个版本并存：验证用 console 版跑，日常用静默版。
  if (!consoleMode) {
    console.log('\n提示：静默版看不到控制台输出。');
    console.log('      要跑 --check-only 验证，请用：node scripts/build-launcher.mjs --console');
  }

  if (process.argv.includes('--run')) {
    console.log('\n启动中…\n');
    const run = spawnSync(rootCopy, [], { cwd: repoRoot, stdio: 'inherit' });
    process.exit(run.status ?? 0);
  }
}

main();
