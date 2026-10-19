/**
 * 白名单编辑卡片 —— 界面层验证。
 *
 * ## 为什么要真的渲染出来测
 *
 * 这一块是纯交互：加号、删号、保存。单元测试只能检查代码里有几个
 * 字符串，证明不了"点了真的会变"。而且这个项目已经踩过三次
 * "看起来有按钮、点了没反应"的坑（插件禁用、测试连接、确认框），
 * 所以必须真的点。
 *
 * 检查：
 *   - 卡片里有输入框和「添加」按钮
 *   - 输入群号后点添加，标签出现
 *   - 点标签上的 × 能删掉
 *   - 点保存会发出 allow 写入，且形状是 { groups, private }
 *   - 非法号被拒绝并给出提示
 *
 * 用法：node scripts/ui-whitelist.mjs
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

const PRELOAD = path.join(__dirname, '.tmp-wl-preload.cjs');

fs.writeFileSync(
  PRELOAD,
  `const { contextBridge } = require('electron');
let allow = { groups: ['111111'], private: [] };
let deny = { groups: [], private: [] };
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
        registry: { tools: [], actions: [], pages: [], timers: [] },
        plugins: { loaded: [], skipped: [], enabled: [] },
        persona: '',
        personaCards: { cards: [], activeId: '' },
        config: {
          llm: { provider: 'custom', baseUrl: '', model: 'm', timeoutMs: 60000, modelCapabilities: {} },
          allow,
          deny,
          allowAllWhenEmpty: false,
          dsh: { enabled: false, port: 3458, token: '', admins: [], sessionId: '' },
          plugins: { enabled: [], allowDangerous: false },
        },
        brain: { configured: true, model: 'm', keySource: 'vault', inflight: 0, queued: 0, pendingConfirms: [], conversations: [] },
        usage: { today: {}, todayProactive: {}, proactiveRatio: 0, recent: [] },
        __calls: calls,
      });
    }
    if (method === 'setting') {
      calls.push({ key: params && params.key, value: params && params.value });
      if (params && params.key === 'allow') allow = params.value;
      if (params && params.key === 'deny') deny = params.value;
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
    height: 950,
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

  // 切到系统安全
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#nav button')].find(x => x.dataset.page === 'security')?.click(); true;`,
  );
  await new Promise((r) => setTimeout(r, 900));

  /* ---------------------------------------------- 卡片存在 */

  const cardInfo = await win.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    if (!card) return { ok: false };
    return {
      ok: true,
      text: card.textContent,
      inputs: card.querySelectorAll('input').length,
      btns: [...card.querySelectorAll('button')].map(b => b.textContent),
      chips: card.querySelectorAll('.chip').length,
    };
  })()`);

  check(cardInfo.ok === true, '找到「白名单」卡片');
  check(cardInfo.inputs === 2, `有两个输入框（群/私聊，实际 ${cardInfo.inputs}）`);
  check((cardInfo.btns ?? []).includes('添加'), '有「添加」按钮');
  check((cardInfo.btns ?? []).includes('保存白名单'), '有「保存白名单」按钮');
  check(cardInfo.chips === 1, `已有号码显示为标签（实际 ${cardInfo.chips} 个）`);
  check(cardInfo.text.includes('111111'), '快照里的号显示出来了');

  /* ---------------------------------------------- 加一个号 */

  const added = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    const input = card.querySelector('input');
    input.value = '222222';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '添加');
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    return { text: after.textContent, chips: after.querySelectorAll('.chip').length };
  })()`);

  check(added.text.includes('222222'), '点添加后新号出现');
  check(added.chips === 2, `标签变成 2 个（实际 ${added.chips}）`);

  /* ---------------------------------------------- 一次加多个 */

  const multi = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    const input = card.querySelector('input');
    input.value = '333333，444444 555555';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...card.querySelectorAll('button')].find(b => b.textContent === '添加').click();
    await new Promise(r => setTimeout(r, 300));
    return { chips: document.querySelectorAll('.card .chip').length, text: document.body.textContent };
  })()`);

  check(multi.chips === 5, `逗号/空格分隔一次加三个（实际 ${multi.chips} 个标签）`);

  /* ---------------------------------------------- 非法号被拒 */

  const bad = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    const input = card.querySelector('input');
    input.value = 'abc123';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...card.querySelectorAll('button')].find(b => b.textContent === '添加').click();
    await new Promise(r => setTimeout(r, 300));
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    return { text: after.textContent, chips: after.querySelectorAll('.chip').length };
  })()`);

  check(bad.text.includes('不是有效'), '非法号给出提示');
  check(!bad.text.includes('abc123</'), '非法号没有被真的加进去');
  check(bad.chips === 5, `标签数没变（实际 ${bad.chips}）`);

  /* ---------------------------------------------- 删一个 */

  const removed = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    const x = card.querySelector('.chip-x');
    x.click();
    await new Promise(r => setTimeout(r, 300));
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    return { chips: after.querySelectorAll('.chip').length };
  })()`);

  check(removed.chips === 4, `点 × 删掉一个（实际剩 ${removed.chips}）`);

  /* ---------------------------------------------- 保存 */

  const saved = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    [...card.querySelectorAll('button')].find(b => b.textContent === '保存白名单').click();
    await new Promise(r => setTimeout(r, 800));
    const snap = await window.ling.invoke('snapshot');
    return { calls: snap.__calls ?? [], allow: snap.config.allow, text: document.body.textContent };
  })()`);

  const allowCall = (saved.calls ?? []).find((c) => c.key === 'allow');
  check(Boolean(allowCall), `发出了 allow 写入（${JSON.stringify((saved.calls ?? []).map((c) => c.key))}）`);
  check(Array.isArray(allowCall?.value?.groups), '形状是 { groups, private }');
  check(saved.text.includes('已保存'), '显示保存成功');

  /* ---------------------------------------------- 保存后不能丢 */

  const persists = await win.webContents.executeJavaScript(`(async () => {
    // 跨过 2 秒轮询：保存后的列表要来自快照，不能变回旧值
    await new Promise(r => setTimeout(r, 3500));
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('白名单'));
    return { text: card ? card.textContent : '', chips: card ? card.querySelectorAll('.chip').length : 0 };
  })()`);

  check(persists.chips === 4, `轮询后标签数仍是 4（实际 ${persists.chips}）`);
  check(persists.text.includes('222222'), '保存的号没有被回滚');

  /* ---------------------------------------------- 黑名单卡片 */

  const denyCard = await win.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('黑名单（优先于白名单）'));
    if (!card) return { ok: false };
    return {
      ok: true,
      text: card.textContent,
      inputs: card.querySelectorAll('input').length,
      btns: [...card.querySelectorAll('button')].map(b => b.textContent),
    };
  })()`);

  check(denyCard.ok === true, '找到黑名单卡片');
  check(denyCard.inputs === 2, `黑名单也有两个输入框（实际 ${denyCard.inputs}）`);
  check((denyCard.btns ?? []).includes('保存黑名单'), '有「保存黑名单」按钮');
  check(
    (denyCard.text ?? '').includes('优先级高于白名单'),
    '说明了黑名单优先于白名单',
  );

  /* ---------------------------------------------- 往黑名单加一个号 */

  const denyAdded = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('黑名单（优先于白名单）'));
    const input = card.querySelector('input');
    input.value = '999999';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...card.querySelectorAll('button')].find(b => b.textContent === '添加').click();
    await new Promise(r => setTimeout(r, 300));
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('黑名单（优先于白名单）'));
    return { chips: after.querySelectorAll('.chip').length, text: after.textContent };
  })()`);

  check(denyAdded.chips === 1, `黑名单标签出现（实际 ${denyAdded.chips}）`);
  check(denyAdded.text.includes('999999'), '拉黑的号显示出来了');

  /* ---------------------------------------------- 保存黑名单 */

  const denySaved = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('黑名单（优先于白名单）'));
    [...card.querySelectorAll('button')].find(b => b.textContent === '保存黑名单').click();
    await new Promise(r => setTimeout(r, 800));
    const snap = await window.ling.invoke('snapshot');
    return { calls: snap.__calls ?? [], deny: snap.config.deny };
  })()`);

  const denyCall = (denySaved.calls ?? []).find((c) => c.key === 'deny');
  check(Boolean(denyCall), `发出了 deny 写入（${JSON.stringify((denySaved.calls ?? []).map((c) => c.key))}）`);
  check(Array.isArray(denyCall?.value?.groups), '形状是 { groups, private }');
  check((denySaved.deny?.groups ?? []).includes('999999'), '黑名单真的写进去了');

  /* ---------------------------------------------- 两个卡片互不干扰 */

  const isolated = await win.webContents.executeJavaScript(`(async () => {
    await new Promise(r => setTimeout(r, 3000));
    const cards = [...document.querySelectorAll('.card')];
    const wl = cards.find(c => c.textContent.includes('白名单（L1 准入）'));
    const bl = cards.find(c => c.textContent.includes('黑名单（优先于白名单）'));
    return { wlChips: wl ? wl.querySelectorAll('.chip').length : -1, blChips: bl ? bl.querySelectorAll('.chip').length : -1 };
  })()`);

  check(isolated.wlChips === 4, `白名单仍是 4 个（实际 ${isolated.wlChips}）`);
  check(isolated.blChips === 1, `黑名单仍是 1 个（实际 ${isolated.blChips}）`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 白名单编辑可用' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

  fs.rmSync(PRELOAD, { force: true });
  app.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(PRELOAD, { force: true });
  process.exit(1);
});
