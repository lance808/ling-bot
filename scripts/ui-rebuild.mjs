/**
 * 重绘是否真的发生了？—— 验证「输入保护」确实在起作用。
 *
 * ## 这个脚本为什么存在
 *
 * 第一版验证（ui-typing.mjs）有三个致命缺陷，都会造成**假通过**：
 *
 *   1. 直接 loadFile 打开页面时没有 preload，window.ling 不存在 →
 *      snapshot() 抛错 → pull() 在 catch 里静默失败 → **根本没有重绘**。
 *      于是"输入没丢"永远成立，因为什么也没发生。
 *   2. 用 MutationObserver 数 firstChild 变化：clear() 和 append()
 *      在同一个任务里完成，观察不到中间态；新内容的 firstChild 还可能
 *      和旧的相同。计数恒为 0。
 *   3. 直接在同一个节点上读写，即使整页被重建也可能读到刚建好的新节点。
 *
 * 所以这个脚本做两件事：
 *   - 用 preload 注入假后端（ui-rebuild-preload.cjs），保证轮询真的在跑
 *   - 用 rAF 轮询根节点对象身份，见一个新对象就 +1
 *
 * 判据（两条必须同时成立）：
 *   - 焦点移开时等 6 秒 → 重建 ≥2 次（证明轮询在跑）
 *   - 焦点在输入框里等 6 秒 → 重建 0 次
 *
 * 只有第二条成立说明轮询坏了，测试没有意义。
 *
 * 用法：node scripts/ui-rebuild.mjs
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
      // 关键：必须走 preload，window.ling 才会在页面脚本执行前就存在
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

  /* ---------------------------------------------- 先确认假后端通了 */

  const backendAlive = await win.webContents.executeJavaScript(
    `typeof window.ling === 'object' && typeof window.ling.invoke === 'function'`,
  );
  check(backendAlive === true, '假后端已注入（window.ling 存在）');

  /* ---------------------------------------------- 装重建计数器 */

  await win.webContents.executeJavaScript(`(() => {
    window.__viewRebuilds = 0;
    window.__seenRoots = new WeakSet();
    const view = document.getElementById('view');
    const tick = () => {
      const root = view.firstElementChild;
      if (root && !window.__seenRoots.has(root)) {
        window.__seenRoots.add(root);
        window.__viewRebuilds += 1;
      }
      requestAnimationFrame(tick);
    };
    tick();
    return true;
  })()`);

  // 切到模型设置页
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#nav button')].find(x => x.dataset.page === 'model')?.click(); true;`,
  );
  await new Promise((r) => setTimeout(r, 900));

  /* ---------------------------------------------- 基线：没输入时会重建 */

  const baseline = await win.webContents.executeJavaScript(`(async () => {
    document.activeElement?.blur?.();
    const before = window.__viewRebuilds;
    await new Promise((r) => setTimeout(r, 6000));
    return { rebuilds: window.__viewRebuilds - before };
  })()`);

  check(
    baseline.rebuilds >= 2,
    `基线：没输入时 6 秒内重建了 ${baseline.rebuilds} 次（证明轮询在跑，≥2 才有效）`,
  );

  /* ---------------------------------------------- 输入中不该重建 */

  const typing = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('input[placeholder^="https://api.example.com"]');
    if (!input) return { ok: false, reason: '找不到接口地址输入框' };
    input.focus();
    input.value = '';
    for (const ch of 'https://api.example.com/v1') {
      input.value += ch;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const typed = input.value;
    const before = window.__viewRebuilds;
    await new Promise((r) => setTimeout(r, 6000));
    const after = window.__viewRebuilds;
    const sameNode = document.querySelector('input[placeholder^="https://api.example.com"]') === input;
    return {
      ok: true, typed, rebuilds: after - before,
      sameNode, stillInDoc: document.body.contains(input),
      valueNow: input.value,
    };
  })()`);

  if (!typing.ok) {
    check(false, `输入中：${typing.reason}`);
  } else {
    check(typing.rebuilds === 0, `输入中 6 秒内没有重建（${typing.rebuilds} 次）`);
    check(typing.sameNode, '输入框节点没有被替换');
    check(typing.stillInDoc, '输入框仍在文档里');
    check(typing.valueNow === typing.typed, `输入内容保留（"${typing.valueNow}"）`);
  }

  /* ---------------------------------------------- 焦点移开之后 */

  const afterBlur = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('input[placeholder^="https://api.example.com"]');
    input.blur();
    document.body.focus?.();
    // 此时 isEditing() 为 false，重绘应恢复
    await new Promise((r) => setTimeout(r, 3000));
    const after = document.querySelector('input[placeholder^="https://api.example.com"]')?.value ?? '';
    return { after };
  })()`);

  // 焦点移开后允许重建，但草稿必须还在（来自模块级 state）
  check(afterBlur.after === 'https://api.example.com/v1', `焦点移开后草稿仍在（"${afterBlur.after}"）`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 输入保护确实生效' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

  app.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
