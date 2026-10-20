/**
 * 从 assets/icon.png 生成 assets/icon.ico（多尺寸）。
 *
 * 这是图标链路的第一环：assets/icon-512.png → assets/icon.ico
 * →（scripts/make-tauri-icons.mjs）→ desktop/icons/*.png + icon.ico
 * → 由 tauri.conf.json 打进安装包。
 *
 * ## 为什么需要这个文件
 *
 * 任务栏上显示的图标来自**可执行文件内嵌的资源**，不是窗口运行时设的属性。
 * 换桌面壳（Electron → Tauri）之后这一点没有变，只是嵌入动作从
 * csc 的 /win32icon: 换成了 Tauri 打包时读 bundle.icon。
 *
 * ## 为什么是 .ico 而不是 .png
 *
 * Windows 的可执行文件图标必须是 .ico（一个文件里装多个尺寸）。
 *
 * ## 为什么用 PowerShell + System.Drawing
 *
 * 理由和别处一致：Windows 自带，零第三方依赖。
 * 这里手工拼 ICO 容器（ICONDIR + ICONDIRENTRY + PNG 数据），
 * 因为 .NET 的 Icon 类不能直接把 PNG 打包成多尺寸 ICO。
 *
 * 用法：node scripts/make-ico.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** --src 指定源图；不给就用内置 assets/icon.png */
const srcArg = process.argv.indexOf('--src');
const src = srcArg >= 0 ? path.resolve(process.argv[srcArg + 1]) : path.join(repoRoot, 'assets', 'icon.png');
const out = path.join(repoRoot, 'assets', 'icon.ico');

/**
 * ICO 里要装哪些尺寸。
 *
 * ## 为什么**大尺寸排在前面**
 *
 * Windows 和 csc.exe 在挑"exe 图标"时，会优先用 ICO 里的**第一张**
 * （尤其是资源管理器的小图标视图、以及部分旧版 shell 代码路径）。
 * 如果第一张是 16x16，任务栏和列表视图就会用 16x16 放大，糊得很明显。
 *
 * 所以顺序是从大到小：256 打头，让任何"只取第一张"的场景都拿到最清晰的。
 * 真正需要小尺寸时，Windows 会自己按尺寸挑对应的那张（ICO 本来就支持）。
 */
const SIZES = [256, 128, 64, 48, 32, 24, 20, 16];

if (!fs.existsSync(src)) {
  console.error(`✖ 找不到 ${src}`);
  process.exit(1);
}

/* 用 PowerShell 把 icon.png 缩成各尺寸的 PNG 字节，输出成 base64 便于回传 */
const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src.replace(/'/g, "''")}')
$sizes = @(${SIZES.join(',')})
$out = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $out += [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
}
$src.Dispose()
$out -join "|"
`;

const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (r.status !== 0) {
  console.error('✖ 生成尺寸失败：');
  console.error(r.stderr || r.stdout);
  process.exit(1);
}

const parts = (r.stdout || '').trim().split('|').filter(Boolean);
if (parts.length !== SIZES.length) {
  console.error(`✖ 期望 ${SIZES.length} 张，实际 ${parts.length} 张`);
  process.exit(1);
}

const images = parts.map((b64) => Buffer.from(b64, 'base64'));

/* -------------------------------------------------- 拼 ICO 容器 */

const count = images.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(count, 4); // 图像数量

const entries = [];
let offset = 6 + count * 16;

images.forEach((png, i) => {
  const size = SIZES[i];
  const e = Buffer.alloc(16);
  // 256 在 ICO 里用 0 表示（单字节放不下 256）
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height
  e.writeUInt8(0, 2); // 调色板数
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(png.length, 8); // 数据长度
  e.writeUInt32LE(offset, 12); // 数据偏移
  offset += png.length;
  entries.push(e);
});

const ico = Buffer.concat([header, ...entries, ...images]);
fs.writeFileSync(out, ico);

console.log(`✓ ${path.relative(repoRoot, out)}  ${(ico.length / 1024).toFixed(1)} KB`);
console.log(`  尺寸：${SIZES.join(' / ')}`);
