/**
 * 界面级端到端验证。
 *
 * 起真实后端 + 真实 Electron 窗口 + 本地假 LLM，
 * 走完"收到消息 → 触发回合 → 流式 → 发送"整条链路，
 * 并抓取 DOM 断言界面真的反映了这些状态。
 *
 * 用法：node scripts/ui-e2e.mjs
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fork, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * 测试群号。
 *
 * 真实群号属于**环境数据**，不写进仓库（否则等于公开"这个机器人跑在哪个群"，
 * 换环境还得改代码）。从环境变量取；没给就退化成假号——
 * 那时唯一会失败的是"真的发出去"这一步，链路本身照常验证。
 *
 * 用法：`$env:LING_TEST_GROUP="<群号>"; node scripts/ui-e2e.mjs`
 */
const TEST_GROUP = process.env.LING_TEST_GROUP || '100000001';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// 这个脚本必须在 Electron 里跑（要用 BrowserWindow）。
// 在纯 Node 下 require('electron') 只返回一个可执行文件路径字符串，
// 所以先自举：用 electron 重新拉起自己。
if (!process.versions.electron) {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string') {
    console.error('✖ 找不到 Electron 可执行文件');
    process.exit(1);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electronPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  process.exit(child.status ?? 1);
}

delete process.env.ELECTRON_RUN_AS_NODE;

/**
 * 从本机 SnowLuma 配置里读 WS token（只读，不修改任何东西）。
 *
 * 注意 HTTP 与 WS 是**两个不同的 token**，这里必须取 wsServers 那一份。
 *
 * @returns {string}
 */
function readSnowLumaToken() {
  try {
    const dir = 'D:/SnowLuma/config';
    const file = fs.readdirSync(dir).find((f) => f.startsWith('onebot_') && f.endsWith('.json'));
    if (!file) return '';
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    return cfg?.networks?.wsServers?.[0]?.accessToken ?? '';
  } catch {
    return '';
  }
}

/** 假 LLM：固定回一句话 */
function startFakeLlm() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const text = '嗯，我在。';
      for (const ch of text) {
        res.write(`data: ${JSON.stringify({ model: 'fake', choices: [{ index: 0, delta: { content: ch } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ model: 'fake', choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server: llmServer, port: llmPort } = await startFakeLlm();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-ue2e-'));

  // 尝试从本机 SnowLuma 配置里取真实 WS token；
  // 取不到就用空 token —— 那样发送会失败（E1001），但大脑链路仍可验证。
  const wsToken = readSnowLumaToken();

  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: wsToken },
      llm: { baseUrl: `http://127.0.0.1:${llmPort}`, model: 'fake', apiKey: 'test', keywords: ['测试'] },
      allow: { groups: [TEST_GROUP], private: [] },
      deny: { groups: [], private: [] },
      proactive: { enabled: false, probability: 0 },
    }),
  );

  if (!wsToken) {
    console.log('⚠ 未读到 SnowLuma WS token，本次只验证大脑链路，发送会失败（E1001）\n');
  }

  // 起后端（连真实 SnowLuma，但 LLM 指向本地假服务）
  const backend = fork(path.join(repoRoot, 'src', 'index.mjs'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, LING_USER_DATA: dataDir, LING_LOG_LEVEL: 'error' },
  });
  backend.stderr.on('data', () => {});

  /** @type {Map<number, Function>} */
  const waiting = new Map();
  /** @type {object[]} */
  const events = [];
  let seq = 0;
  readline.createInterface({ input: backend.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m.result);
        waiting.delete(m.id);
      } else if (m.method === 'event') {
        events.push(m.params);
      }
    } catch {
      /* 日志 */
    }
  });

  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => reject(new Error(`超时：${method}`)), 10_000);
      waiting.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      backend.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  await new Promise((r) => setTimeout(r, 1200));

  const { app, BrowserWindow, ipcMain } = require('electron');
  await app.whenReady();

  ipcMain.handle('ling:invoke', async (_e, method, payload) => rpc(method, payload ?? {}));

  const win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 820,
    webPreferences: {
      preload: path.join(repoRoot, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  /** @type {string[]} */
  const errors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message);
  });

  await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));

  const before = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll(".card h2")].map(h => h.textContent);
    const viewText = document.getElementById("view")?.innerText ?? "";
    return {
      // 数据总览的三块：链接状态 / 今日消耗 / 运行信息
      linkCard: cards.includes("链接状态"),
      usageCard: cards.includes("今日消耗"),
      infoCard: cards.includes("运行信息"),
      // 三态分离是硬要求：不能合并成一个"已连接"
      triState: viewText.includes("已联通") || viewText.includes("未联通"),
      hasTokenMetric: viewText.includes("总 token"),
      hasModelNav: [...document.querySelectorAll("#nav button")].some(b => b.textContent.includes("模型设置")),
      // 九个页面都要在导航里
      navCount: document.querySelectorAll("#nav button").length,
      navLabels: [...document.querySelectorAll("#nav button")].map(b => b.textContent),
      text: viewText
    };
  })()`);

  // 主题：两个按钮，点了要真的切换 data-theme
  const themeCheck = await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll("#theme-switch button")];
    const before = document.documentElement.getAttribute("data-theme");
    const dark = btns.find(b => b.getAttribute("data-theme-set") === "dark");
    const light = btns.find(b => b.getAttribute("data-theme-set") === "light");
    if (!dark || !light) return { ok: false, reason: "没有亮/暗按钮" };
    dark.click();
    const afterDark = document.documentElement.getAttribute("data-theme");
    const darkPressed = dark.getAttribute("aria-pressed");
    light.click();
    const afterLight = document.documentElement.getAttribute("data-theme");
    return {
      ok: afterDark === "dark" && afterLight === "light" && darkPressed === "true",
      buttons: btns.length,
      before, afterDark, afterLight, darkPressed
    };
  })()`);

  // 切到「模型设置」页并检查关键字段是否真的渲染出来
  const apiPage = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll("#nav button")].find(b => b.textContent.includes("模型设置"));
    if (!btn) return { ok: false, reason: "导航里没有模型设置" };
    btn.click();
    return { ok: true };
  })()`);

  await new Promise((r) => setTimeout(r, 600));

  const apiView = await win.webContents.executeJavaScript(`(() => {
    const t = document.getElementById("view")?.innerText ?? "";
    const inputs = [...document.querySelectorAll("#view input")].length;
    return {
      text: t,
      inputs,
      selects: [...document.querySelectorAll("#view select")].length,
      cards: [...document.querySelectorAll("#view .provider-card")].length,
      activeCard: [...document.querySelectorAll("#view .provider-card.active")].length,
      cardText: [...document.querySelectorAll("#view .provider-card")].map(b => b.innerText).join("|"),
      hasCustomCard: [...document.querySelectorAll("#view .provider-card")].some(b => b.innerText.includes("自定义")),
      hasBaseUrl: t.includes("接口地址"),
      hasModel: t.includes("模型"),
      hasTimeout: t.includes("超时"),
      hasKey: t.includes("API Key"),
      hasTest: t.includes("测试连接"),
      // 绝不能把 key 回显到界面上
      leaksKey: /sk-[A-Za-z0-9_-]{16,}/.test(t),
    };
  })()`);

  // DSH 接入页：切过去再取一次
  const dshPage = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('#nav button')].find((b) => b.innerText.includes('DSH'));
    if (!btn) return { ok: false, hasAdmins: false, hasPort: false, hasSteps: false, pwd: false };
    btn.click();
    return new Promise((resolve) => setTimeout(() => {
      const t = document.getElementById('view')?.innerText ?? '';
      resolve({
        ok: t.includes('共享令牌'),
        hasAdmins: t.includes('管理员'),
        hasPort: t.includes('监听端口'),
        hasSteps: t.includes('DSH 那边要填什么'),
        // 令牌默认必须是密码框，不能明文摊在屏幕上
        pwd: document.querySelector('#view input[type="password"]') !== null,
      });
    }, 250));
  })()`);

  // 手动触发一个回合（走白名单内会话）
  await rpc('action', { name: 'turn.manual', params: { convKey: `group:${TEST_GROUP}`, text: '测试一下' } });

  // 等回合跑完
  let waited = 0;
  let hasTurnEvent = false;
  while (waited < 15_000) {
    await new Promise((r) => setTimeout(r, 300));
    waited += 300;
    if (events.some((e) => e.event === 'turn-end')) {
      hasTurnEvent = true;
      break;
    }
  }

  await new Promise((r) => setTimeout(r, 1500));

  const after = await win.webContents.executeJavaScript(`(() => ({
    text: document.getElementById("view")?.innerText ?? "",
    streamPresent: Boolean(document.getElementById("turn-stream")),
    confirmHost: Boolean(document.getElementById("confirm-host"))
  }))()`);

  const turnStart = events.find((e) => e.event === 'turn-start')?.payload;
  const turnEnd = events.find((e) => e.event === 'turn-end')?.payload;
  const deltas = events.filter((e) => e.event === 'turn-delta');

  console.log('界面断言：');
  const checks = [
    [before.linkCard, '总览有「链接状态」卡片'],
    [before.usageCard, '总览有「今日消耗」卡片'],
    [before.infoCard, '总览有「运行信息」卡片'],
    // 三态分离：绝不能只显示一个「已连接」绿点
    [before.triState, '总览区分联通状态（不是单一绿点）'],
    [before.hasTokenMetric, '总览显示 token 指标'],
    [before.hasModelNav, '导航里有「模型设置」'],
    [before.navCount === 10, `导航有 10 个页面（实际 ${before.navCount}）`],
    [before.navLabels.includes('工具记忆'), '导航里有「工具记忆」'],
    [before.navLabels.includes('插件设置'), '导航里有「插件设置」'],
    [before.navLabels.includes('词元消耗'), '导航里有「词元消耗」'],
    [themeCheck.ok, `主题亮/暗可切换（${themeCheck.before} → ${themeCheck.afterDark} → ${themeCheck.afterLight}）`],
    [themeCheck.buttons === 2, `主题是两个按钮（${themeCheck.buttons}）`],

    // 模型设置页
    [apiPage.ok, `能切换到模型设置页${apiPage.ok ? '' : `（${apiPage.reason}）`}`],
    [apiView.hasBaseUrl, '模型设置页有「接口地址」'],
    [apiView.hasModel, '模型设置页有「模型」'],
    [apiView.hasTimeout, '模型设置页有「超时」'],
    [apiView.hasKey, '模型设置页有「API Key」'],
    [apiView.hasTest, '模型设置页有「测试连接」'],
    [apiView.inputs >= 3, `模型设置页有可编辑输入框（${apiView.inputs} 个）`],
    [dshPage.ok, 'DSH 接入页有共享令牌'],
    [dshPage.hasAdmins, 'DSH 接入页有管理员配置'],
    [dshPage.hasPort, 'DSH 接入页有端口配置'],
    [dshPage.hasSteps, 'DSH 接入页有 DSH 侧填写说明'],
    [dshPage.pwd, 'DSH 令牌默认不明文显示'],
    [apiView.selects >= 1, `模型设置页有模型下拉框（${apiView.selects} 个）`],
    [apiView.cards >= 2, `提供商是卡片式切换（${apiView.cards} 张）`],
    [apiView.activeCard === 1, `同时只有一张卡片被选中（${apiView.activeCard}）`],
    [apiView.hasCustomCard, '有「自定义第三方」卡片'],
    // 不能把某一家的名字写死进产品界面
    [!/(beichen|中转站名)/i.test(apiView.cardText), '提供商卡片里没有写死具体中转站'],
    // 界面绝不能回显 key —— 后端只返回掩码，这里做一次真实检查
    [!apiView.leaksKey, '模型设置页没有回显明文 Key'],

    [after.confirmHost, '确认挂载点存在'],
    [Boolean(turnStart), '后端发出 turn-start'],
    [deltas.length > 0, `收到流式分片（${deltas.length} 片）`],
    [Boolean(turnEnd), '后端发出 turn-end'],
    [turnEnd?.ok === true, `回合发送成功（code=${turnEnd?.code ?? '-'}）`],
    [turnEnd?.text === '嗯，我在。', `回复内容正确（"${turnEnd?.text}"）`],
    [errors.length === 0, `无 console 错误（${JSON.stringify(errors)}）`],
  ];

  let failed = 0;
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? '✓' : '✖'} ${label}`);
    if (!ok) failed += 1;
  }

  console.log('\n回合事件摘要：');
  console.log(`  turn-start trigger=${turnStart?.trigger} proactive=${turnStart?.proactive}`);
  console.log(`  turn-delta × ${deltas.length}，拼接=${JSON.stringify(deltas.map((d) => d.payload.delta).join(''))}`);
  console.log(`  turn-end ok=${turnEnd?.ok} steps=${turnEnd?.steps} usage=${JSON.stringify(turnEnd?.usage)}`);

  backend.kill();
  llmServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  app.quit();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`✖ 失败：${err?.stack ?? err}`);
  process.exit(1);
});
