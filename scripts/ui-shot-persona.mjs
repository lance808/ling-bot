/**
 * 用「有卡」的数据截图，看清作用范围选择器长什么样。
 *
 * ui-shot.mjs 的假数据里没有任何人格卡，所以人格页只能看到空态。
 * 这里造三张不同范围的卡，把编辑器完整截下来。
 *
 * 用法：node scripts/ui-shot-persona.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

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

const PRELOAD = path.join(__dirname, '.tmp-shot-persona.cjs');

const cards = [
  { id: 'p_1', name: '默认人格', text: '你叫 Ling，在小群里聊天。\n性格：安静但接得上话。', scope: 'global', scopeId: '' },
  { id: 'p_2', name: '技术群专用', text: '这个群里问技术问题的人多，回答具体一点。', scope: 'group', scopeId: '10086' },
  { id: 'p_3', name: '和老朋友私聊', text: '跟老朋友说话随意些，可以开玩笑。', scope: 'private', scopeId: '10010' },
].map((c) => ({ ...c, length: c.text.length, updatedAt: '' }));

const roles = [
  { id: 'r_1', name: '群聊参与者', text: '你是群里的聊天参与者，不是客服。\n有人叫你或话题接得上就说话，没人理就安静待着。', scope: 'group', scopeId: '10086' },
  { id: 'r_2', name: '一对一助手', text: '这是一对一私聊，认真回答问题，能帮上忙就帮。', scope: 'private', scopeId: '10010' },
  { id: 'r_3', name: '默认角色', text: '', scope: 'global', scopeId: '' },
].map((c) => ({ ...c, length: c.text.length, updatedAt: '' }));

fs.writeFileSync(
  PRELOAD,
  `const { contextBridge } = require('electron');
const cards = ${JSON.stringify(cards)};
const roles = ${JSON.stringify(roles)};
contextBridge.exposeInMainWorld('ling', {
  invoke(method) {
    if (method === 'snapshot') {
      return Promise.resolve({
        state: 'online',
        health: { linked: true, verdict: 'ok', online: true },
        account: { selfId: '10001' },
        messages: [],
        counts: { messages: 0, toolCalls: 0 },
        registry: { tools: [], actions: [], pages: [], timers: [] },
        plugins: { loaded: [], skipped: [], enabled: [] },
        persona: cards[0].text,
        roleCards: { limit: 6000, activeId: 'r_1', cards: roles, resolved: {} },
        personaCards: { limit: 6000, activeId: 'p_1', cards, resolved: { 'group:10086': 'p_2' } },
        config: {
          llm: { provider: 'custom', baseUrl: '', model: 'm', timeoutMs: 60000, modelCapabilities: {} },
          allow: { groups: [], private: [] },
          deny: { groups: [], private: [] },
          dsh: { enabled: false, port: 3458, token: '', admins: [], sessionId: '' },
          plugins: { enabled: [], allowDangerous: false },
        },
        brain: { configured: true, model: 'm', keySource: 'vault', inflight: 0, queued: 0, pendingConfirms: [], conversations: [] },
        usage: { today: {}, todayProactive: {}, proactiveRatio: 0, recent: [] },
      });
    }
    if (method === 'action') return Promise.resolve({ ok: true });
    return Promise.resolve({});
  },
  onEvent() { return () => {}; },
  pickFile() { return Promise.resolve({ ok: false, canceled: true }); },
  meta: { platform: 'test', versions: {} },
});
`,
  'utf8',
);

async function main() {
  await app.whenReady();

  /*
   * 只建一个窗口，切主题截两张。
   *
   * 原来每轮都 new BrowserWindow + destroy，结果第二轮 create 时
   * 进程直接退出（offscreen 模式下销毁后重建会这样）。
   * 复用同一个窗口既避开这个问题，也更接近用户真实操作。
   */
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, preload: PRELOAD },
  });

  try {
    await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  } catch {
    await new Promise((r) => setTimeout(r, 600));
    await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  }
  await new Promise((r) => setTimeout(r, 2200));

  for (const theme of ['light', 'dark']) {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true;`,
    );
    await new Promise((r) => setTimeout(r, 400));

    // 每次切主题都重进人格页，确保表格用新主题重绘
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('#nav button')].find(x => x.dataset.page === 'persona')?.click(); true;`,
    );
    await new Promise((r) => setTimeout(r, 900));

    /*
     * 人格和角色各截一张。
     *
     * 只截人格那页看不出两者是分开的 —— 而这个分开正是这次改动的重点，
     * 所以要把「角色」标签点开再截一次。
     */
    for (const [label, file] of [['人格', 'persona'], ['角色', 'role']]) {
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.seg-btn')].find(b => b.textContent === '${label}')?.click(); true;`,
      );
      await new Promise((r) => setTimeout(r, 500));

      const img = await win.webContents.capturePage();
      const out = path.join(repoRoot, '.shots', `cards-${file}-${theme}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log('✓ ' + path.relative(repoRoot, out));
    }
  }

  win.destroy();

  fs.rmSync(PRELOAD, { force: true });
  app.quit();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(PRELOAD, { force: true });
  process.exit(1);
});
