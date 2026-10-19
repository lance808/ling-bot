/**
 * 「当前状态」卡片显示是否正确 —— Key 状态与测试连接。
 *
 * ## 这里钉的是什么
 *
 * 两个真踩到的 bug：
 *
 *   1. **Key 显示「未设置」但「可否对话：可以」**
 *      界面读 `brain.keySource`，后端却只把 keySource 放在 `config.llm` 里。
 *      字段对不上 → 永远 fallback 到「未设置」，同时 configured 又是 true。
 *
 *   2. **点「测试连接」没反应**
 *      原代码先 await 再写 DOM，请求期间那一片是空的；而这个请求要跑满
 *      超时才返回。加上每 2 秒整页重绘，写进去的结果还会被立刻抹掉。
 *
 * 所以检查三件事：
 *   - keySource='vault' 时显示「已加密保存」
 *   - 点按钮后**立刻**出现「请求中」
 *   - 请求期间页面不被重建（activeOps 保护）
 *
 * 用法：node scripts/ui-status.mjs
 */

import path from 'node:path';
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

async function main() {
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'ui-rebuild-preload.cjs'),
    },
  });

  await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  await new Promise((r) => setTimeout(r, 2600));

  const results = [];
  const check = (ok, label) => {
    results.push({ ok, label });
    console.log(`  ${ok ? '✓' : '✖'} ${label}`);
  };

  // 切到模型设置页
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#nav button')].find(x => x.dataset.page === 'model')?.click(); true;`,
  );
  await new Promise((r) => setTimeout(r, 900));

  /* ---------------------------------------------- Key 状态显示 */

  const statusCard = await win.webContents.executeJavaScript(`(() => {
    const card = [...document.querySelectorAll('.card')]
      .find(c => c.textContent.includes('当前状态'));
    return card ? card.textContent : '';
  })()`);

  check(statusCard.includes('已加密保存'), `Key 显示「已加密保存」（实际卡片含：${statusCard.includes('未设置') ? '未设置 ✗' : '无未设置'}）`);
  check(!statusCard.includes('Key未设置'), 'Key 不再显示「未设置」');
  check(statusCard.includes('可以'), '「可否对话」显示可以');
  check(statusCard.includes('deepseek-v4.1-flash'), '模型名显示正确');

  /* ---------------------------------------------- 测试连接立刻有反馈 */

  const immediate = await win.webContents.executeJavaScript(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '测试连接');
    if (!btn) return { ok: false, reason: '找不到测试连接按钮' };
    btn.click();
    // 只等一帧，看是否马上有"请求中"
    await new Promise(r => setTimeout(r, 60));
    const card = [...document.querySelectorAll('.card')]
      .find(c => c.textContent.includes('当前状态'));
    return {
      ok: true,
      showsPending: card.textContent.includes('请求中'),
      disabled: btn.disabled,
      btnText: btn.textContent,
    };
  })()`);

  if (!immediate.ok) {
    check(false, immediate.reason);
  } else {
    check(immediate.showsPending, '点下去立刻显示「请求中」');
    check(immediate.disabled === true, '按钮在请求期间被禁用');
    check(immediate.btnText === '测试中…', `按钮文案变成「测试中…」（实际：${immediate.btnText}）`);
  }

  /* ---------------------------------------------- 请求期间不被重绘 */

  const during = await win.webContents.executeJavaScript(`(async () => {
    // 假后端的 llm.test 会立刻返回，所以这里换成观察 activeOps 效果：
    // 直接检查 testHost 里的结果在 3 秒后还在（跨越一次以上轮询）
    await new Promise(r => setTimeout(r, 4000));
    const card = [...document.querySelectorAll('.card')]
      .find(c => c.textContent.includes('当前状态'));
    return { text: card ? card.textContent : '' };
  })()`);

  check(during.text.includes('测试结果'), '卡片里有「测试结果」这一行');
  check(during.text.includes('通过'), `「测试结果」显示通过（实际：${during.text.slice(0, 120)}）`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 状态显示与测试连接都正常' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

  app.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
