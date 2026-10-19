/**
 * 生成符号化的应用图标候选（小鲸鱼 / 对话气泡 / 字母 L）。
 *
 * ## 为什么不用原图
 *
 * 原图是一张特写线稿头像：线条密、头发丝多。实测缩到 32px 时，
 * 1024 个格子里有 624 个带墨 —— 缩下去就是一坨深色，没有可辨识形状。
 * 这类图不适合当图标，不是缩放算法能救的。
 *
 * ## 为什么用 SVG 再转 PNG
 *
 * 图标是几何图形，用 SVG 描述比用像素算法拼要准得多：圆、圆弧、圆角矩形
 * 都是解析式，不依赖采样。再用 Chromium 的离屏渲染转成 PNG ——
 * Electron 自带，零第三方依赖。
 *
 * 用法：node scripts/make-symbol-icons.mjs
 *
 * 产物（先写到 .shots/symbols/ 供挑选，确认后再推进 assets/）：
 *   whale-256.png / whale-32.png
 *   bubble-256.png / bubble-32.png
 *   letterL-256.png / letterL-32.png
 *   preview.png        —— 把三版并排、含 32px 实际大小，方便一眼比较
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.versions.electron) {
  const electronPath = require('electron');
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electronPath, [fileURLToPath(import.meta.url)], { cwd: repoRoot, env, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

delete process.env.ELECTRON_RUN_AS_NODE;

const electron = await import('electron');
const app = electron.app ?? electron.default.app;
const BrowserWindow = electron.BrowserWindow ?? electron.default.BrowserWindow;

/** 界面强调色。图标跟它一致，视觉上才是同一个产品。 */
const ACCENT = '#2f6fed';
const ACCENT_DEEP = '#1e4fc4';

/**
 * 三版候选。
 *
 * 共同原则：
 *   · 单一主体，不叠细节；
 *   · 主体占画布 70%~80%，四周留白（任务栏会裁得很紧）；
 *   · 只用一到两个对比色，靠形状而不是靠线条密度识别；
 *   · 32px 下仍能看出轮廓 —— 这是唯一的硬指标。
 */
const DESIGNS = {
  whale: {
    label: '小鲸鱼',
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${ACCENT}"/>
            <stop offset="1" stop-color="${ACCENT_DEEP}"/>
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="58" fill="url(#g)"/>
        <!-- 身体：一个圆润的椭圆，左下收尾成尾巴的起点 -->
        <path d="M52 150c0-38 30-66 68-66 34 0 58 20 64 48 3 14-1 26-10 34
                 -12 11-34 16-62 16-38 0-60-14-60-32z" fill="#fff"/>
        <!-- 尾巴：两片，向右上翘 -->
        <path d="M186 122c10-14 24-20 34-16 8 3 10 13 4 23-6 10-18 17-30 19z" fill="#fff"/>
        <path d="M188 148c14 4 26 14 28 25 2 9-5 15-14 12-11-4-20-15-24-27z" fill="#fff" opacity=".82"/>
        <!-- 眼睛：唯一的深色点，32px 下就是识别锚点 -->
        <circle cx="104" cy="132" r="9.5" fill="${ACCENT_DEEP}"/>
        <!-- 腹部高光：一条淡线，暗示鲸鱼的白肚皮 -->
        <path d="M70 166c14 8 34 12 56 12" stroke="rgba(255,255,255,.55)" stroke-width="7"
              stroke-linecap="round" fill="none"/>
      </svg>`,
  },

  bubble: {
    label: '对话气泡',
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4a86ff"/>
            <stop offset="1" stop-color="${ACCENT_DEEP}"/>
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="58" fill="url(#g)"/>
        <!-- 气泡：圆角矩形 + 左下小尾巴 -->
        <path d="M58 78h140a20 20 0 0 1 20 20v66a20 20 0 0 1-20 20h-72l-32 26v-26H58
                 a20 20 0 0 1-20-20V98a20 20 0 0 1 20-20z" fill="#fff"/>
        <!-- 三个点：代表"正在说话"，也是 32px 下的识别特征 -->
        <circle cx="92" cy="131" r="11" fill="${ACCENT}"/>
        <circle cx="128" cy="131" r="11" fill="${ACCENT}"/>
        <circle cx="164" cy="131" r="11" fill="${ACCENT}"/>
      </svg>`,
  },

  letterL: {
    label: '字母 L',
    svg: `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4a86ff"/>
            <stop offset="1" stop-color="${ACCENT_DEEP}"/>
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="58" fill="url(#g)"/>
        <!-- L：粗笔画。光学居中（向右上微调），细笔画在 16px 下会消失 -->
        <path d="M94 56h30a7 7 0 0 1 7 7v116h52a7 7 0 0 1 7 7v12a7 7 0 0 1-7 7H94
                 a7 7 0 0 1-7-7V63a7 7 0 0 1 7-7z" fill="#fff"/>
        <!-- 只有字母本身：多余装饰在 16px 下只会变成噪声 -->
      </svg>`,
  },
};

/** 把 SVG 渲染成指定尺寸的 PNG（用 Chromium 离屏渲染） */
async function renderSvg(win, svg, size) {
  // 单图渲染用小窗口，避免 capturePage 带进多余的空白
  win.setContentSize(size, size);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:${size}px;height:${size}px}</style></head>
<body>${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 120));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.toPNG();
}

async function main() {
  await app.whenReady();
  const outDir = path.join(repoRoot, '.shots', 'symbols');
  fs.mkdirSync(outDir, { recursive: true });

  /*
   * 窗口要足够大，而且要能随时改尺寸：
   *   · 渲染单个 SVG 时只要 size×size；
   *   · 渲染三栏预览时要 1120×420 左右，否则截图只能截到第一栏（踩过）。
   */
  const win = new BrowserWindow({
    width: 300,
    height: 300,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });

  for (const [key, d] of Object.entries(DESIGNS)) {
    for (const size of [512, 256, 32]) {
      const png = await renderSvg(win, d.svg, size);
      const out = path.join(outDir, `${key}-${size}.png`);
      fs.writeFileSync(out, png);
      console.log(`✓ ${path.relative(repoRoot, out)}`);
    }
  }

  /* 预览图：三版并排，每版放大 256 + 实际 32，模拟任务栏里的样子 */
  const cells = Object.entries(DESIGNS)
    .map(
      ([key, d]) => `
      <div class="cell">
        <div class="big">${d.svg}</div>
        <div class="name">${d.label}</div>
        <div class="small-row">
          <div class="s32">${d.svg}</div>
          <span class="cap">32px 实际大小</span>
        </div>
      </div>`,
    )
    .join('');

  const preview = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#f4f6fa;font-family:system-ui,"Segoe UI",sans-serif}
    .row{display:flex;gap:28px}
    .cell{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08);width:320px}
    .big svg{width:200px;height:200px;display:block;margin:0 auto}
    .name{margin-top:12px;font-weight:600;color:#1c1e24;text-align:center}
    .small-row{margin-top:14px;display:flex;align-items:center;gap:10px;justify-content:center;
      border-top:1px solid #e5e8ee;padding-top:12px}
    .s32 svg{width:32px;height:32px;display:block}
    .cap{color:#6b7280;font-size:12px}
  </style></head><body><div class="row">${cells}</div></body></html>`;

  // 三栏并排要 ~1120 宽，窗口必须先放大，否则截出来只有第一栏
  win.setContentSize(1120, 460);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(preview));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1120, height: 460 });
  const previewPath = path.join(outDir, 'preview.png');
  fs.writeFileSync(previewPath, img.toPNG());
  console.log(`✓ ${path.relative(repoRoot, previewPath)}`);

  win.destroy();
  app.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
