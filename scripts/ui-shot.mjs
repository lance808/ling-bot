/**
 * 只截图，不做断言 —— 用来肉眼核对九个页面在亮/暗两种主题下的样子。
 *
 * 用法：node scripts/ui-shot.mjs
 * 产出：.shots/<page>-<theme>.png
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

if (!process.versions.electron) {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string') {
    console.error('✖ 找不到 Electron 可执行文件');
    process.exit(1);
  }
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env };
  // 这个变量会让 Electron 以纯 Node 模式启动，拿不到 BrowserWindow
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  process.exit(r.status ?? 1);
}

delete process.env.ELECTRON_RUN_AS_NODE;

// ESM 下不能靠 createRequire 拿 Electron 的 API（只会得到可执行文件路径），
// 必须用 import 才能拿到真正的模块命名空间。
const electron = await import('electron');
const app = electron.app ?? electron.default.app;
const BrowserWindow = electron.BrowserWindow ?? electron.default.BrowserWindow;

const PAGES = ['overview', 'sessions', 'model', 'persona', 'tools', 'plugins', 'security', 'dsh', 'usage', 'logs'];

async function main() {
  await app.whenReady();
  const outDir = path.join(repoRoot, '.shots');
  fs.mkdirSync(outDir, { recursive: true });

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true },
  });

  await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  // 等快照轮询回来并完成首屏渲染
  await new Promise((r) => setTimeout(r, 3000));

  const themes = ['light', 'dark'];
  for (const theme of themes) {
    await win.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true;`,
    );
    for (const id of PAGES) {
      // 点导航切页
      await win.webContents.executeJavaScript(`(() => {
        const b = [...document.querySelectorAll('#nav button')].find((x) => x.dataset.page === ${JSON.stringify(id)});
        b?.click();
        return Boolean(b);
      })()`);
      await new Promise((r) => setTimeout(r, 350));

      const img = await win.webContents.capturePage();
      const file = path.join(outDir, `${id}-${theme}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log(`✓ ${id}-${theme}.png`);
    }
  }

  app.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
