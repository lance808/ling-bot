/**
 * 定向截图：系统安全页（含图标卡片）。
 *
 * 为什么不复用 ui-shot.mjs：那个是整站批量截，切页后只等 350ms，
 * 偶发会截到上一页（我实际遇到过 security 截出来是 plugins）。
 * 这里只截一页，等待时间给足。
 *
 * 用法：node scripts/ui-shot-security.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * 自举：这个脚本必须在 Electron 里跑（要用 BrowserWindow 截离屏画面）。
 *
 * 直接用 `node` 跑时 process.versions.electron 是 undefined，
 * 此时重新用 electron 二进制执行自己一遍，并把 ELECTRON_RUN_AS_NODE 删掉 ——
 * 这台机器上那个变量会让 Electron 退化成纯 Node（app 变 undefined）。
 */
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

const PRELOAD_PATH = path.join(repoRoot, 'electron', 'preload.cjs');

/* 假后端：只提供安全页需要的字段，外加一个假的 ling 图标接口 */
const FAKE = `
const { contextBridge } = require('electron');

const snapshot = {
  ready: true,
  account: { online: true, selfId: '10086', nickname: 'Ling' },
  config: {
    llm: { provider: 'custom', baseUrl: '', model: 'deepseek-v4.1-flash', timeoutMs: 120000, modelCapabilities: {} },
    allow: { groups: ['10086'], private: [], allowAllWhenEmpty: false },
    deny: { groups: [], private: [] },
    dsh: { enabled: false, admins: [], port: 3458 },
    plugins: { enabled: [], allowDangerous: false },
  },
  registry: { tools: [] },
  plugins: { loaded: [], skipped: [], enabled: [] },
  personaCards: { cards: [], activeId: '', resolved: {} },
  roleCards: { cards: [], activeId: '', resolved: {} },
  usage: { summary: { totalTokens: 0, calls: 0 } },
  pages: [],
};

contextBridge.exposeInMainWorld('ling', {
  invoke: async (m) => (m === 'snapshot' ? snapshot : { ok: true }),
  onEvent: () => () => {},
  meta: { platform: process.platform, versions: process.versions },
  iconStatus: async () => ({ ok: true, icons: { app: { custom: false }, tray: { custom: true } } }),
  pickIconFile: async () => ({ ok: false, canceled: true }),
  uploadIcon: async () => ({ ok: true, width: 256, height: 256 }),
  resetIcon: async () => ({ ok: true }),
});
`;

async function main() {
  await app.whenReady();
  const outDir = path.join(repoRoot, '.shots');
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(PRELOAD_PATH, FAKE, 'utf8');

  const win = new BrowserWindow({
    width: 1280,
    height: 980,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, preload: PRELOAD_PATH },
  });

  await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  for (const theme of ['light', 'dark']) {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true;`,
    );
    await new Promise((r) => setTimeout(r, 300));

    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#nav button')].find(x => x.dataset.page === 'security')?.click(); true;`,
    );
    // 给足时间：切页 + 图标状态回来 + 重绘
    await new Promise((r) => setTimeout(r, 1200));

    const img = await win.webContents.capturePage();
    const out = path.join(outDir, `security-icons-${theme}.png`);
    fs.writeFileSync(out, img.toPNG());
    console.log('✓ ' + path.relative(repoRoot, out));
  }

  win.destroy();
  fs.rmSync(PRELOAD_PATH, { force: true });
  app.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(PRELOAD_PATH, { force: true });
  process.exit(1);
});
