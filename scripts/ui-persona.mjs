/**
 * 人格卡界面 —— 复现"不能新建/保存/删除"。
 *
 * ## 怀疑的两个点
 *
 * 1. `prompt()` 在 Electron 里**不弹窗**（Chromium 移除了它），
 *    直接返回 null → 新建永远被 `if (!name) return;` 挡掉。
 * 2. `onSave` 用的是 `getState().snapshot` 里的 activeId，
 *    但用户可能是"切了卡但没重绘"的状态，存到了上一张卡上。
 *
 * 这个脚本把每一步都点一遍，用真实后端的行为判断哪一步断了。
 *
 * 用法：node scripts/ui-persona.mjs
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

const PRELOAD = path.join(__dirname, '.tmp-persona-preload.cjs');

/*
 * 假后端：**如实地**模拟真实后端的 5 个动作，包括重名拒绝、
 * 至少保留一张卡等约束。这样界面层的 bug 才能暴露出来 ——
 * 如果假后端什么都答应，界面就算传错了参数也测不出来。
 */
fs.writeFileSync(
  PRELOAD,
  `const { contextBridge } = require('electron');
let cards = [{ id: 'p_1', name: '默认人格', text: '你是晓凌。', length: 5, scope: 'global', scopeId: '', updatedAt: '' }];
let activeId = 'p_1';
let seq = 1;
let roles = [{ id: 'r_1', name: '默认角色', text: '你是群里的聊天参与者。', length: 12, scope: 'global', scopeId: '', updatedAt: '' }];
let roleActiveId = 'r_1';
const calls = [];

function snap() {
  return {
    state: 'online',
    health: { linked: true, verdict: 'ok', online: true },
    account: { selfId: '10001' },
    messages: [],
    counts: { messages: 0, toolCalls: 0 },
    registry: { tools: [], actions: [], pages: [], timers: [] },
    plugins: { loaded: [], skipped: [], enabled: [] },
    persona: (cards.find(c => c.id === activeId) || {}).text || '',
    personaCards: { cards: cards.map(c => ({ ...c, length: c.text.length })), activeId, resolved: {} },
    roleCards: { cards: roles.map(c => ({ ...c, length: c.text.length })), activeId: roleActiveId, resolved: {} },
    config: {
      llm: { provider: 'custom', baseUrl: '', model: 'm', timeoutMs: 60000, modelCapabilities: {} },
      allow: { groups: [], private: [] },
      deny: { groups: [], private: [] },
      dsh: { enabled: false, port: 3458, token: '', admins: [], sessionId: '' },
      plugins: { enabled: [], allowDangerous: false },
    },
    brain: { configured: true, model: 'm', keySource: 'vault', inflight: 0, queued: 0, pendingConfirms: [], conversations: [] },
    usage: { today: {}, todayProactive: {}, proactiveRatio: 0, recent: [] },
    __calls: calls,
  };
}

contextBridge.exposeInMainWorld('ling', {
  invoke(method, params) {
    if (method === 'snapshot') return Promise.resolve(snap());
    if (method !== 'action') return Promise.resolve({ ok: true });
    const name = params && params.name;
    const a = (params && params.params) || {};
    calls.push({ name, params: a });
    if (typeof name === 'string' && name.startsWith('role.')) {
      const verb = name.slice(5);
      if (verb === 'create') {
        const card = { id: 'r_' + (++seq), name: a.name || '新角色', text: a.text || '', scope: a.scope || 'global', scopeId: a.scopeId || '', updatedAt: '' };
        roles.push(card);
        return Promise.resolve({ ok: true, card });
      }
      if (verb === 'activate') { roleActiveId = a.id; return Promise.resolve({ ok: true }); }
      if (verb === 'update') {
        const c = roles.find(x => x.id === a.id);
        if (c) {
          if (typeof a.text === 'string') c.text = a.text;
          if (a.scope !== undefined) { c.scope = a.scope; c.scopeId = a.scopeId || ''; }
        }
        return Promise.resolve({ ok: true, card: c });
      }
      if (verb === 'delete') { roles = roles.filter(x => x.id !== a.id); return Promise.resolve({ ok: true }); }
      if (verb === 'duplicate') { return Promise.resolve({ ok: true }); }
    }
    if (name === 'persona.create') {
      if (!a.name) return Promise.resolve({ ok: false, code: 'E4041', message: '人格名不能为空' });
      if (cards.some(c => c.name === a.name)) {
        return Promise.resolve({ ok: false, code: 'E4041', message: '已存在同名人格：' + a.name });
      }
      const card = { id: 'p_' + (++seq), name: a.name, text: a.text || '', scope: a.scope || 'global', scopeId: a.scopeId || '', updatedAt: '' };
      cards.push(card);
      return Promise.resolve({ ok: true, card });
    }
    if (name === 'persona.update') {
      const c = cards.find(x => x.id === a.id);
      if (!c) return Promise.resolve({ ok: false, code: 'E4041', message: '人格不存在' });
      if (a.name !== undefined && a.name !== null && String(a.name).trim()) {
        if (cards.some(x => x.id !== a.id && x.name === a.name)) {
          return Promise.resolve({ ok: false, code: 'E4041', message: '已存在同名人格：' + a.name });
        }
        c.name = a.name;
      }
      if (typeof a.text === 'string') c.text = a.text;
      if (a.scope !== undefined) { c.scope = a.scope; c.scopeId = a.scopeId || ''; }
      return Promise.resolve({ ok: true, card: c });
    }
    if (name === 'persona.activate') {
      if (!cards.some(c => c.id === a.id)) return Promise.resolve({ ok: false, code: 'E4041', message: '不存在' });
      activeId = a.id;
      return Promise.resolve({ ok: true, activeId });
    }
    if (name === 'persona.delete') {
      if (cards.length === 1) return Promise.resolve({ ok: false, code: 'E4041', message: '至少要保留一张人格' });
      const i = cards.findIndex(c => c.id === a.id);
      if (i < 0) return Promise.resolve({ ok: false, code: 'E4041', message: '不存在' });
      cards.splice(i, 1);
      if (activeId === a.id) activeId = cards[0].id;
      return Promise.resolve({ ok: true, activeId });
    }
    if (name === 'persona.duplicate') {
      const src = cards.find(c => c.id === a.id);
      if (!src) return Promise.resolve({ ok: false, code: 'E4041', message: '不存在' });
      const name2 = src.name + ' 副本';
      if (cards.some(c => c.name === name2)) return Promise.resolve({ ok: false, code: 'E4041', message: '重名' });
      const card = { id: 'p_' + (++seq), name: name2, text: src.text, updatedAt: '' };
      cards.push(card);
      return Promise.resolve({ ok: true, card });
    }
    return Promise.resolve({ ok: false, message: '未登记' });
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
    width: 1400,
    height: 950,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, preload: PRELOAD },
  });

  console.log('  [1] 开始加载页面');
  await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const results = [];
  const check = (ok, label) => {
    results.push({ ok, label });
    console.log(`  ${ok ? '✓' : '✖'} ${label}`);
  };

  console.log('  [2] 页面已加载，准备切到人格页');
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#nav button')].find(x => x.dataset.page === 'persona')?.click(); true;`,
  );
  console.log('  [3] 已切页');
  await new Promise((r) => setTimeout(r, 900));

  /* ---------------------------------------------- prompt 是否可用 */

  /* ---------------------------------------------- 新建 */

  // 抓住页面里的异常：render() 抛错会让整页空白，而外部只看到 undefined
  await win.webContents.executeJavaScript(`(() => {
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    window.onerror = (m) => { window.__errs.push(String(m)); };
    const origError = console.error;
    console.error = (...a) => { window.__errs.push('console.error: ' + a.map(String).join(' ')); origError(...a); };
    return true;
  })()`);

  console.log('  [4] 准备点新建');
  const created = await win.webContents.executeJavaScript(`(async () => {
   try {
    const before = (await window.ling.invoke('snapshot')).personaCards.cards.length;
    const cards = [...document.querySelectorAll('.card')];
    const card = cards.find(c => c.textContent.includes('人格卡'));
    if (!card) return { ok: false, reason: '找不到人格卡卡片，页面上的卡片：' + JSON.stringify(cards.map(c => (c.querySelector('h2')||{}).textContent)) };
    const btn = [...card.querySelectorAll('button')].find(b => b.textContent.includes('新建'));
    if (!btn) return { ok: false, reason: '找不到新建按钮，卡片里的按钮：' + JSON.stringify([...card.querySelectorAll('button')].map(b => b.textContent)) };
    btn.click();
    await new Promise(r => setTimeout(r, 500));
    if (window.__errs && window.__errs.length) return { ok: false, reason: '页面报错：' + window.__errs.join(' | ') };

    // 点击后先看看页面上到底有什么
    const afterCards = [...document.querySelectorAll('.card')].map(c => ({ h: (c.querySelector('h2')||{}).textContent, txt: c.textContent.slice(0, 80) }));
    if (!afterCards.length) return { ok: false, reason: '点击后页面没有任何卡片' };
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('人格卡'));
    if (!after) return { ok: false, reason: '点击后找不到人格卡。页面卡片：' + JSON.stringify(afterCards) };
    // 新建表单里现在可能有多个输入框（名称 + 范围号码），按 placeholder 取名称那个
    const input = [...after.querySelectorAll('input')].find(i => (i.placeholder || '').includes('起个名字'));
    if (!input) return { ok: false, reason: '点新建后没有出现名称输入框（还在用 prompt？）' };

    input.value = '测试卡';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const createBtn = [...after.querySelectorAll('button')].find(b => b.textContent === '创建');
    if (!createBtn) return { ok: false, reason: '找不到创建按钮' };
    createBtn.click();
    await new Promise(r => setTimeout(r, 800));

    const snap = await window.ling.invoke('snapshot');
    return {
      ok: true,
      before,
      after: snap.personaCards.cards.length,
      names: snap.personaCards.cards.map(c => c.name),
      calls: snap.__calls.map(c => c.name),
    };
   } catch (e) { return { ok: false, reason: 'INLINE THROW: ' + (e && (e.stack || e.message || String(e))) }; }
  })()`);

  if (!created.ok) {
    check(false, created.reason);
  } else {
    check(created.after === created.before + 1, `点「新建」后卡片数 +1（${created.before} → ${created.after}）`);
    check((created.names ?? []).includes('测试卡'), `新卡用了输入框里的名字（${JSON.stringify(created.names)}）`);
    check((created.calls ?? []).includes('persona.create'), `发出了 persona.create（${JSON.stringify(created.calls)}）`);
  }

  /* ---------------------------------------------- 保存 */

  console.log('  [5] 新建完成，准备保存');
  const saved = await win.webContents.executeJavaScript(`(async () => {
    const area = document.querySelector('.persona-editor textarea');
    if (!area) return { ok: false, reason: '找不到编辑框' };
    area.value = '你是一只很安静的猫。';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '保存内容');
    if (!btn) return { ok: false, reason: '找不到保存按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const snap = await window.ling.invoke('snapshot');
    const active = snap.personaCards.cards.find(c => c.id === snap.personaCards.activeId);
    return { ok: true, text: active.text, name: active.name, calls: snap.__calls.map(c => ({ n: c.name, id: c.params.id })) };
  })()`);

  if (!saved.ok) {
    check(false, saved.reason);
  } else {
    check(saved.text === '你是一只很安静的猫。', `内容真的存进去了（实际：${JSON.stringify(saved.text)}）`);
    const updateCall = (saved.calls ?? []).find((c) => c.n === 'persona.update');
    check(Boolean(updateCall), '发出了 persona.update');
    check(Boolean(updateCall?.id), `update 带了 id（${updateCall?.id}）`);
  }

  /* ---------------------------------------------- 自定义名称 */

  console.log('  [6] 保存完成，检查改名入口');
  const renamed = await win.webContents.executeJavaScript(`(async () => {
    // 界面上有没有改名的入口？
    const inputs = [...document.querySelectorAll('.persona-editor input, .card input')];
    const hasNameInput = inputs.some(i => (i.placeholder || '').includes('名'));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('改名'));
    return { hasNameInput, hasRenameBtn: Boolean(btn), inputCount: inputs.length };
  })()`);

  check(renamed.hasNameInput || renamed.hasRenameBtn, `界面有改名入口（输入框：${renamed.hasNameInput}，按钮：${renamed.hasRenameBtn}）`);

  /* ---------------------------------------------- 删除 */

  /* ---------------------------------------------- 改名真的生效 */

  const renameResult = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('编辑：'));
    if (!card) return { ok: false, reason: '找不到编辑器卡片' };
    const input = card.querySelector('input');
    if (!input) return { ok: false, reason: '找不到名称输入框' };
    input.value = '改过名的卡';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '改名');
    if (!btn) return { ok: false, reason: '找不到改名按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const snap = await window.ling.invoke('snapshot');
    const active = snap.personaCards.cards.find(c => c.id === snap.personaCards.activeId);
    const call = snap.__calls.filter(c => c.name === 'persona.update').pop();
    return { ok: true, name: active && active.name, sentName: call && call.params.name };
  })()`);

  if (!renameResult.ok) {
    check(false, renameResult.reason);
  } else {
    check(renameResult.sentName === '改过名的卡', `改名请求带上了新名字（${renameResult.sentName}）`);
    check(renameResult.name === '改过名的卡', `名字真的改了（${renameResult.name}）`);
  }

  console.log('  [7] 准备删除');

  /*
   * 删除要分两步：先点一次（进入确认），再点一次（真删）。
   * 不用 reload —— 那条路会卡住。
   */
  const step1 = await win.webContents.executeJavaScript(`(async () => {
    const before = (await window.ling.invoke('snapshot')).personaCards.cards.length;
    const after = await window.ling.invoke('action', { name: 'persona.create', params: { name: '待删除', text: '' } });
    if (!after || !after.ok) return { ok: false, reason: '准备新卡失败：' + (after && after.message) };
    return { ok: true, before, now: before + 1 };
  })()`);

  if (!step1.ok) {
    check(false, step1.reason);
  } else {
    // 让界面自己拉到新快照（等一次轮询）
    await new Promise((r) => setTimeout(r, 2600));

    const del1 = await win.webContents.executeJavaScript(`(async () => {
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('人格卡'));
      const del = [...card.querySelectorAll('button')].filter(b => b.textContent === '删除')[0];
      if (!del) return { ok: false, reason: '找不到删除按钮' };
      del.click();
      await new Promise(r => setTimeout(r, 500));
      const snap = await window.ling.invoke('snapshot');
      return {
        ok: true,
        calledDelete: snap.__calls.some(c => c.name === 'persona.delete'),
        notice: document.body.textContent.includes('再点一次'),
      };
    })()`);

    check(del1.ok === true, '第一次点删除');
    check(del1.calledDelete === false, '第一次点不会立刻删（要先确认）');
    check(del1.notice === true, '给出了"再点一次"的提示');

    const del2 = await win.webContents.executeJavaScript(`(async () => {
      const before = (await window.ling.invoke('snapshot')).personaCards.cards.length;
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('人格卡'));
      const del = [...card.querySelectorAll('button')].filter(b => b.textContent === '删除')[0];
      del.click();
      await new Promise(r => setTimeout(r, 700));
      const snap = await window.ling.invoke('snapshot');
      return {
        ok: true,
        before,
        after: snap.personaCards.cards.length,
        calls: snap.__calls.map(c => c.name),
      };
    })()`);

    check(del2.after === del2.before - 1, `第二次点真的删了（${del2.before} → ${del2.after}）`);
    check((del2.calls ?? []).includes('persona.delete'), '发出了 persona.delete');
  }

  /* ---------------------------------------------- 作用范围 */

  console.log('  [8] 检查作用范围');
  const scopeUI = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('编辑：'));
    if (!card) return { ok: false, reason: '找不到编辑器' };
    const btns = [...card.querySelectorAll('button')].map(b => b.textContent);
    const hasGlobal = btns.includes('全局');
    const hasGroup = btns.includes('只对这个群');
    const hasPrivate = btns.includes('只对这个私聊');
    return { ok: true, hasGlobal, hasGroup, hasPrivate, btns };
  })()`);

  check(scopeUI.ok === true, '找到编辑器');
  check(scopeUI.hasGlobal === true, '有「全局」按钮');
  check(scopeUI.hasGroup === true, '有「只对这个群」按钮');
  check(scopeUI.hasPrivate === true, '有「只对这个私聊」按钮');

  const scopeChanged = await win.webContents.executeJavaScript(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('编辑：'));
    [...card.querySelectorAll('button')].find(b => b.textContent === '只对这个群').click();
    await new Promise(r => setTimeout(r, 400));
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('编辑：'));
    const input = after.querySelector('input[inputmode="numeric"]');
    if (!input) return { ok: false, reason: '选群后没出现群号输入框' };
    input.value = '123456';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...after.querySelectorAll('button')].find(b => b.textContent === '保存范围');
    if (!save) return { ok: false, reason: '找不到保存范围按钮' };
    save.click();
    await new Promise(r => setTimeout(r, 800));
    const snap = await window.ling.invoke('snapshot');
    const active = snap.personaCards.cards.find(c => c.id === snap.personaCards.activeId);
    const call = snap.__calls.filter(c => c.name === 'persona.update').pop();
    return { ok: true, scope: active && active.scope, scopeId: active && active.scopeId, sent: call && call.params };
  })()`);

  if (!scopeChanged.ok) {
    check(false, scopeChanged.reason);
  } else {
    check(scopeChanged.sent?.scope === 'group', `发出了 scope=group（${JSON.stringify(scopeChanged.sent)}）`);
    check(scopeChanged.sent?.scopeId === '123456', '带上了群号');
    check(scopeChanged.scope === 'group' && scopeChanged.scopeId === '123456', '后端范围真的变了');
  }

  const scopeTag = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.persona-row');
    if (!row) return { ok: false };
    return { ok: true, text: row.textContent };
  })()`);
  check(
    scopeTag.ok === true && (scopeTag.text.includes('只对群') || scopeTag.text.includes('全局')),
    `列表里显示了作用范围（${scopeTag.text}）`
  );

  /* ---------------------------------------------- 人格与角色分开 */

  console.log('  [9] 检查人格 / 角色是两个独立标签');
  const tabs = await win.webContents.executeJavaScript(`(() => {
    const segs = [...document.querySelectorAll('.seg-btn')].map(b => b.textContent);
    return { ok: true, segs };
  })()`);
  check(tabs.segs.includes('人格'), `有「人格」标签（${tabs.segs}）`);
  check(tabs.segs.includes('角色'), '有「角色」标签');

  const roleTab = await win.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('.seg-btn')].find(b => b.textContent === '角色').click();
    await new Promise(r => setTimeout(r, 500));
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('角色卡'));
    if (!card) return { ok: false, reason: '切到角色后没有角色卡卡片' };
    const btns = [...document.querySelectorAll('.card button')].map(b => b.textContent);
    return { ok: true, hasNew: btns.some(t => t.includes('新建角色卡')) };
  })()`);
  check(roleTab.ok === true, roleTab.ok ? '切到角色标签能渲染' : roleTab.reason);
  check(roleTab.hasNew === true, '角色页有「新建角色卡」按钮');

  /**
   * 最关键的一条：切到角色去改东西，不能把人格的内容也改掉。
   * 这靠的是两套独立的 activeId 和独立的编辑草稿。
   */
  const crossTalk = await win.webContents.executeJavaScript(`(async () => {
    const before = (await window.ling.invoke('snapshot')).personaCards.cards.map(c => c.text);
    // 页面上有两个渲染区（人格/角色各一块），要取当前可见那块里的
    const areas = [...document.querySelectorAll('textarea')];
    const area = areas[areas.length - 1];
    if (!area) return { ok: false, reason: '角色页没有编辑框（textarea 数：0）' };
    area.value = '只改角色，别动人格';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...document.querySelectorAll('.card button')].find(b => b.textContent === '保存内容');
    if (!save) return { ok: false, reason: '找不到保存内容' };
    save.click();
    await new Promise(r => setTimeout(r, 800));
    const snap = await window.ling.invoke('snapshot');
    return {
      ok: true,
      personaTexts: snap.personaCards.cards.map(c => c.text),
      roleTexts: snap.roleCards.cards.map(c => c.text),
      before,
    };
  })()`);

  if (!crossTalk.ok) {
    check(false, crossTalk.reason);
  } else {
    check(
      JSON.stringify(crossTalk.personaTexts) === JSON.stringify(crossTalk.before),
      '在角色页保存内容，人格卡一字未变'
    );
    check(crossTalk.roleTexts.includes('只改角色，别动人格'), '角色内容确实存进去了');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 人格卡界面正常' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

  fs.rmSync(PRELOAD, { force: true });
  app.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  fs.rmSync(PRELOAD, { force: true });
  process.exit(1);
});
