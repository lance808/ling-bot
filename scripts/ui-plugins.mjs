/**
 * 插件权限卡片的按钮 —— 界面层验证。
 *
 * ## 为什么单独测这一块
 *
 * 它原本只有一行 `pill('已关闭（推荐）')`：**没有任何可点的东西**。
 * 看起来像写死的状态，用户想开也开不了。这类"只读扮成只读"的问题
 * 单元测试很难发现，必须真的把页面渲染出来看有没有按钮。
 *
 * 这里检查：
 *   - 卡片里有「开启…」按钮
 *   - 点它会出现二次确认
 *   - 确认后会发出 allowDangerous 写入请求
 *
 * 用法：node scripts/ui-plugins.mjs
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
  if (typeof electronPath !== 'string') {
    console.error('✖ 找不到 Electron');
    process.exit(1);
  }
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

const PRELOAD = path.join(__dirname, '.tmp-plugins-preload.cjs');

fs.writeFileSync(
  PRELOAD,
  `const { contextBridge } = require('electron');
let dangerous = false;
const calls = [];
contextBridge.exposeInMainWorld('ling', {
  invoke(method, params) {
    if (method === 'snapshot') {
      return Promise.resolve({
        state: 'online',
        health: { linked: true, verdict: 'ok', online: true },
        account: { selfId: '10001' },
        messages: [],
        counts: { messages: 0, toolCalls: 0 },
        registry: { actions: [], tools: [], pages: [], timers: [] },
        plugins: {
          loaded: [{ name: 'dsh-bridge', ok: true }],
          skipped: [],
          enabled: ['dsh-bridge'],
          allowDangerous: dangerous,
        },
        persona: '',
        personaCards: { cards: [], activeId: '' },
        config: {
          llm: { provider: 'custom', baseUrl: '', model: 'm', timeoutMs: 60000, modelCapabilities: {} },
          allow: { groups: [], private: [] },
          dsh: { enabled: false, port: 3458, token: '', admins: [], sessionId: '' },
          plugins: { enabled: ['dsh-bridge'], allowDangerous: dangerous },
        },
        brain: { configured: true, model: 'm', keySource: 'vault', inflight: 0, queued: 0, pendingConfirms: [], conversations: [] },
        usage: { today: {}, todayProactive: {}, proactiveRatio: 0, recent: [] },
        __calls: calls,
      });
    }
    if (method === 'setting') {
      calls.push(params);
      if (params && params.key === 'plugins.allowDangerous') dangerous = params.value === true;
      return Promise.resolve({ ok: true });
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

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, preload: PRELOAD },
  });

  await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const results = [];
  const check = (ok, label) => {
    results.push({ ok, label });
    console.log(`  ${ok ? '✓' : '✖'} ${label}`);
  };

  // 切到插件设置
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#nav button')].find(x => x.dataset.page === 'plugins')?.click(); true;`,
  );
  await new Promise((r) => setTimeout(r, 900));

  const layout = await win.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('插件权限'));
    if (!card) return { ok: false };
    const btns = [...card.querySelectorAll('button')].map(b => b.textContent);
    return { ok: true, text: card.textContent, btns };
  })()`);

  check(layout.ok === true, '找到「插件权限」卡片');
  check((layout.btns ?? []).length > 0, `卡片里有按钮（实际：${JSON.stringify(layout.btns)}）`);
  check((layout.btns ?? []).some((t) => t.includes('开启')), '按钮是「开启…」');
  check(layout.text.includes('已关闭') || layout.text.includes('已开启'), '仍显示当前状态');

  /* ---------------------------------------------- 点按钮 → 二次确认 */

  const confirmStep = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('插件权限'));
    const btn = [...card.querySelectorAll('button')].find(b => b.textContent.includes('开启'));
    if (!btn) return { ok: false };
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('插件权限'));
    return {
      ok: true,
      hasConfirm: after.textContent.includes('确认开启'),
      confirmBtns: [...after.querySelectorAll('button')].map(b => b.textContent),
    };
  })()`);

  check(confirmStep.ok === true, '能点到开启按钮');
  check(confirmStep.hasConfirm === true, '出现二次确认');
  check((confirmStep.confirmBtns ?? []).includes('确认开启'), '确认按钮存在');

  /* ---------------------------------------------- 关键：跨越轮询后还在 */

  // 先装重建计数器，确认这 5 秒里页面真的重绘过（否则测试没意义）
  await win.webContents.executeJavaScript(`(() => {
    window.__rebuilds = 0;
    window.__seen = new WeakSet();
    const view = document.getElementById('view');
    const tick = () => {
      const root = view.firstElementChild;
      if (root && !window.__seen.has(root)) { window.__seen.add(root); window.__rebuilds += 1; }
      requestAnimationFrame(tick);
    };
    tick();
    return true;
  })()`);

  const persists = await win.webContents.executeJavaScript(`(async () => {
    // 等 5 秒，跨过至少两次 2 秒轮询 —— 这正是"弹窗消失过快"的成因
    const before = window.__rebuilds;
    await new Promise(r => setTimeout(r, 5000));
    const rebuilds = window.__rebuilds - before;
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('插件权限'));
    return {
      rebuilds,
      hasConfirm: card ? card.textContent.includes('确认开启') : false,
      inDoc: Boolean(document.getElementById('danger-ask')),
    };
  })()`);
  check(persists.rebuilds >= 2, `这 5 秒里页面重建了 ${persists.rebuilds} 次（≥2 才说明轮询在跑，测试才有效）`);
  check(persists.hasConfirm === true, '等待 5 秒（跨越两次轮询）后确认框仍在');
  check(persists.inDoc === true, '确认框节点没有被重建掉');

  /* ---------------------------------------------- 确认 → 真的写入 */

  const written = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('插件权限'));
    const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '确认开启');
    if (!btn) return { ok: false, reason: '找不到确认按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const snap = await window.ling.invoke('snapshot');
    const calls = snap.__calls ?? [];
    return { ok: true, calls, dangerous: snap.plugins.allowDangerous };
  })()`);

  if (!written.ok) {
    check(false, written.reason);
  } else {
    const wrote = (written.calls ?? []).some((c) => c && c.key === 'plugins.allowDangerous');
    check(wrote, `发出了 allowDangerous 写入（${JSON.stringify(written.calls)}）`);
    check(written.dangerous === true, '后端状态变成已开启');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 插件权限开关可用' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

  fs.rmSync(PRELOAD, { force: true });
  app.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(PRELOAD, { force: true });
  process.exit(1);
});
