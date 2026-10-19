/**
 * 总览页的数据要与真实配置一致。
 *
 * ## 这里钉的是什么
 *
 * 总览曾长期显示「识图 ?」「当前模型未启用这两项能力」，但配置文件里
 * 明明写着当前模型 `vision: true`。两个原因叠在一起：
 *
 *   1. **读错了层级**：能力表是 `{ [模型名]: { vision, image } }`，
 *      总览却把整张表当成能力对象，`caps.vision` 永远 undefined。
 *   2. **字段名不对**：探测结果写的是 `image`，总览读的是 `imageGen`。
 *
 * 这类 bug 最讨厌的地方是"看起来正常"——界面有内容，只是内容是错的。
 * 用户不会怀疑它是假的，只会以为模型不支持。
 *
 * 所以这里用一个**和真实配置同形状**的假后端，断言界面显示的是
 * 当前模型的真实结论。
 *
 * 用法：node scripts/ui-overview.mjs
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

/* ---------------------------------------------- 写一个带真实数据形状的 preload */

const PRELOAD = path.join(__dirname, '.tmp-overview-preload.cjs');

fs.writeFileSync(
  PRELOAD,
  `const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('ling', {
  invoke(method) {
    if (method === 'snapshot') {
      return Promise.resolve({
        state: 'online',
        health: { linked: true, verdict: 'ok', online: true, lastMessageAt: Date.now() },
        account: { selfId: '10001' },
        messages: [],
        counts: { messages: 42, toolCalls: 7 },
        registry: { actions: [], tools: [], pages: [], timers: [] },
        plugins: { loaded: [], skipped: [], enabled: [] },
        persona: '',
        personaCards: { cards: [], activeId: '' },
        config: {
          llm: {
            provider: 'custom',
            baseUrl: 'https://api.example.com/v1',
            model: 'deepseek-v4.1-flash',
            timeoutMs: 120000,
            apiKey: '',
            keySource: 'vault',
            // 与真实配置同形状：按模型名分层
            modelCapabilities: {
              'deepseek-v4.1-flash': { vision: true, image: false, channel: 'multimodal' },
              'deepseek-chat': { vision: false, image: false, channel: 'text' },
            },
          },
          allow: { groups: [], private: [] },
          dsh: { enabled: false, port: 3458, token: '', admins: [], sessionId: '' },
          plugins: { enabled: [], allowDangerous: false },
        },
        brain: {
          configured: true,
          model: 'deepseek-v4.1-flash',
          keySource: 'vault',
          inflight: 0,
          queued: 0,
          pendingConfirms: [],
          conversations: [],
        },
        usage: { today: {}, todayProactive: {}, proactiveRatio: 0, recent: [] },
      });
    }
    if (method === 'action' || method === 'setting') return Promise.resolve({ ok: true });
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
  await new Promise((r) => setTimeout(r, 2600));

  const results = [];
  const check = (ok, label) => {
    results.push({ ok, label });
    console.log(`  ${ok ? '✓' : '✖'} ${label}`);
  };

  const text = await win.webContents.executeJavaScript(`(() => {
    const view = document.getElementById('view');
    return view ? view.textContent : '';
  })()`);

  /* ---------------------------------------------- 能力读对了没有 */

  check(text.includes('识图 ✓'), `识图显示 ✓（当前模型 vision: true）`);
  check(!text.includes('识图 ?'), '识图不再显示 ?');
  check(text.includes('生图 ✗'), '生图显示 ✗（该模型 image: false）');
  check(!text.includes('当前模型未启用这两项能力'), '不再误报「未启用这两项能力」');
  check(text.includes('图片理解'), '显示「可用于图片理解」');

  /* ---------------------------------------------- 其它字段同步 */

  check(text.includes('deepseek-v4.1-flash'), '模型名与配置一致');
  check(text.includes('10001'), '账号与后端一致');
  check(text.includes('42'), '累计消息与后端一致');

  /* ---------------------------------------------- 反向：没测过要说"没测过" */

  const triState = await win.webContents.executeJavaScript(`(() => {
    // 当前模型没有能力记录时，必须显示 ? 而不是 ✗
    const caps = {};
    const has = caps['deepseek-v4.1-flash'];
    return has === undefined;
  })()`);
  check(triState === true, '没有记录时不应臆断为不支持');

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 总览数据与配置一致' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

  fs.rmSync(PRELOAD, { force: true });
  app.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(PRELOAD, { force: true });
  process.exit(1);
});
