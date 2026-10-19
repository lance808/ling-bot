/**
 * 定向截图：右侧「思考链路」面板（亮 / 暗两套主题）。
 *
 * ## 假后端怎么注入
 *
 * 页面在模块加载时就把 `globalThis.ling` 取走了（api.mjs 顶层 const），
 * 所以假后端只能在 preload 里注入，loadFile 之后再打补丁已经晚了。
 *
 * 但**不能**就地改写 `electron/preload.cjs` —— 那种"改完再恢复"的写法
 * 只要中途死一次就会把仓库里的真 preload 留成假数据版。
 * 所以假 preload 写到 scripts/.shot-preload-thinking.cjs，
 * BrowserWindow 直接指向它，仓库里的真 preload 全程只读。
 *
 * ## 假数据为什么要造这么长
 *
 * 三行截断只有在正文确实超过三行时才看得出来。如果只喂一句短文本，
 * "看起来正常"其实什么都没验证到 —— 这是最容易自欺的地方。
 *
 * 用法：node scripts/ui-shot-thinking.mjs
 * 产出：.shots/thinking-<theme>.png、.shots/thinking-folded-<theme>.png
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

/**
 * 造一份像真一样的思考历史。
 *
 * 刻意混了三样东西：
 *   - 超长正文（验证三行截断真的生效）
 *   - 多工具（验证工具标签排得下、会换行）
 *   - 两个会话 + 两天（验证筛选和日期分组）
 *
 * @param {number} now
 */
function makeThinking(now) {
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  /** @param {Date} d */
  const dateKey = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  return {
    total: 7,
    days: [
      {
        date: dateKey(yesterday),
        entries: [
          {
            at: now - 86_400_000 - 3_600_000,
            convKey: 'group:100000001',
            steps: [
              {
                n: 1,
                reasoning:
                  '用户在问昨天那个部署脚本为什么又挂了。先看最近的日志时间，昨天下午三点之后没有成功记录，说明是那次改动之后开始坏的。我先确认一下改动内容，再决定要不要让他回滚，还是直接修。',
                tools: ['web_search'],
                answerPreview: '先把昨天下午那次改动贴出来看看。',
              },
            ],
          },
        ],
      },
      {
        date: dateKey(today),
        entries: [
          {
            at: now - 1_800_000,
            convKey: 'group:100000001',
            steps: [
              {
                n: 1,
                reasoning:
                  '这条消息提到了一个我没见过的库名，先别急着答。它可能是用户自己项目里的东西，也可能是打错的。搜一下比瞎猜强，搜不到就老实说不确定，别编一个 API 出来 —— 编错了比说不知道糟糕得多。',
                tools: ['web_search'],
                answerPreview: '这个库我没查到，你能给个仓库地址吗？',
              },
              {
                n: 2,
                reasoning:
                  '搜索结果里有两个同名项目，一个三年前归档了，一个上个月还在更新。用户大概率说的是新的那个。但两个的接口完全不一样，直接按新的答有风险，所以我要在回答里点明我按哪个版本理解，让他能立刻纠正我。',
                tools: ['web_search', 'fetch_url'],
                answerPreview: '我按 2024 那个新版本来理解，它的接口是这样的……',
              },
            ],
          },
          {
            at: now - 600_000,
            convKey: 'private:100000002',
            steps: [
              {
                n: 1,
                reasoning: '私聊，对方问的是「那个东西弄好了吗」。指代不明，但结合上下文应该是问部署的事。',
                tools: [],
                answerPreview: '还在弄，晚上前给你。',
              },
            ],
          },
          {
            at: now - 900_000,
            convKey: 'group:100000003',
            steps: [
              {
                n: 1,
                reasoning:
                  '有人 @ 我问那个配置文件里的路径该写绝对还是相对。这题有标准答案，但直接给答案对他没好处 —— 下次换机器他还是会踩。先说清为什么，再给结论。',
                tools: ['read_file'],
                answerPreview: '写相对更稳，因为绝对路径换机器就废了。',
              },
              {
                n: 2,
                reasoning:
                  '不过他问的是 Electron 的打包场景，那里相对路径会以 asar 内的路径为准，跟开发时不一样。这一点必须补上，否则他照着改完打包还是坏的。',
                tools: ['read_file', 'web_search'],
                answerPreview: '打包后要用 app.getAppPath() 拼，不能直接相对。',
              },
            ],
          },
          {
            at: now - 1_200_000,
            convKey: 'group:100000001',
            steps: [
              {
                n: 1,
                reasoning: '有人在问上次那个报错解决了没有。我不知道后续，不该假装知道。',
                tools: [],
                answerPreview: '后来怎么样了？我这边没看到结果。',
              },
            ],
          },
          {
            at: now - 1_500_000,
            convKey: 'private:100000002',
            steps: [
              {
                n: 1,
                reasoning:
                  '他连着发了三条，语气比平时急。先别按条回，那样会显得机械。把三句当成一件事来答，直接给结论和下一步。',
                tools: [],
                answerPreview: '别急，我按顺序都看了。结论是……',
              },
            ],
          },
          {
            at: now - 2_100_000,
            convKey: 'group:100000003',
            steps: [
              {
                n: 1,
                reasoning:
                  '群里在讨论要不要把那个测试跑在 CI 上。这是个判断题，不是查资料能解决的。我的观点是值得，但要说清代价：跑一次三分钟，换来的是不会再出现「本地过了线上挂」。',
                tools: [],
                answerPreview: '值得，三分钟买一个确定。',
              },
            ],
          },
          {
            at: now - 2_700_000,
            convKey: 'group:100000001',
            steps: [
              {
                n: 1,
                reasoning:
                  '这条消息只有一张图，没有文字。得先看图才能判断他想问什么。如果图里是报错，就解释原因；如果图里是界面，可能是问样式。猜错会很尴尬，所以看完再说。',
                tools: ['read_image'],
                answerPreview: '这个是端口被占用，换个端口就行。',
              },
            ],
          },
          {
            at: now - 3_300_000,
            convKey: 'private:100000002',
            steps: [
              {
                n: 1,
                reasoning: '晚安消息，不需要实质回应。回一个字就够，多说是打扰。',
                tools: [],
                answerPreview: '晚安。',
              },
            ],
          },
          {
            at: now - 120_000,
            convKey: 'group:100000001',
            steps: [
              {
                n: 1,
                reasoning:
                  '群里在开玩笑，没有实质问题。这个场合不需要长篇回答，接一句就行。但要注意别把玩笑接得太满 —— 太满会显得像在抢话。',
                tools: [],
                answerPreview: '哈哈那确实。',
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * 生成假 preload。
 *
 * 除了 thinking 之外，其它字段都按真实快照的形状给最小可用值 ——
 * 缺字段会让某些页面渲染成"渲染失败"，而那时截图看起来像面板坏了，
 * 实际上是别的地方先炸了，排查会很绕。
 *
 * @param {any} thinking
 */
function fakePreload(thinking) {
  return `const { contextBridge } = require('electron');

const snapshot = {
  ready: true,
  state: 'online',
  health: { linked: true, verdict: 'ok', online: true },
  account: { online: true, selfId: '10086', nickname: 'Ling' },
  messages: [],
  counts: { messages: 0, toolCalls: 0 },
  config: {
    llm: { provider: 'custom', baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4.1-flash', timeoutMs: 120000, modelCapabilities: {} },
    allow: { groups: ['100000001'], private: ['100000002'], allowAllWhenEmpty: false },
    deny: { groups: [], private: [] },
    dsh: { enabled: false, admins: [], port: 3458 },
    plugins: { enabled: [], allowDangerous: false },
  },
  registry: { tools: [], actions: [], pages: [], timers: [] },
  plugins: { loaded: [], skipped: [], enabled: [] },
  persona: '',
  personaCards: { cards: [], activeId: '', resolved: {} },
  roleCards: { cards: [], activeId: '', resolved: {} },
  brain: { configured: true, model: 'deepseek-v4.1-flash', keySource: 'vault', inflight: 0, queued: 0, pendingConfirms: [], conversations: [] },
  usage: { summary: { totalTokens: 0, calls: 0 }, today: {}, todayProactive: {}, proactiveRatio: 0, recent: [] },
  pages: [],
  thinking: ${JSON.stringify(thinking)},
};

contextBridge.exposeInMainWorld('ling', {
  invoke: async (m) => (m === 'snapshot' ? snapshot : { ok: true }),
  onEvent: () => () => {},
  meta: { platform: process.platform, versions: process.versions },
  pickFile: async () => ({ ok: false, canceled: true }),
});
`;
}

async function main() {
  await app.whenReady();
  const outDir = path.join(repoRoot, '.shots');
  fs.mkdirSync(outDir, { recursive: true });

  /*
   * 假 preload 写到 scripts/ 下的独立临时文件，**绝不覆盖 electron/preload.cjs**。
   *
   * 以前是就地改真 preload、截完再写回去，结果一次中断就把仓库里的
   * preload 留成了假数据版（图标 API 全丢）。这种"改完再恢复"的写法
   * 只要中途死一次就污染工作区，不该出现在截图脚本里。
   *
   * 现在 BrowserWindow 直接指向临时文件，仓库里的真 preload 全程只读。
   * 退出路径（成功 / 抛错 / 超时）都删一次，删不干净也只是多一个临时文件。
   */
  const sandboxPreload = path.join(repoRoot, 'scripts', '.shot-preload-thinking.cjs');
  const cleanupPreload = () => {
    try {
      fs.rmSync(sandboxPreload, { force: true });
    } catch {
      /* 删不掉不影响结果 */
    }
  };

  /** 让窗口在任一环节出错时也能收尾 */
  let win = null;

  try {
    fs.writeFileSync(sandboxPreload, fakePreload(makeThinking(Date.now())), 'utf8');

    win = new BrowserWindow({
      width: 1440,
      height: 940,
      show: false,
      webPreferences: { offscreen: true, contextIsolation: true, preload: sandboxPreload },
    });

    await win.loadFile(path.join(repoRoot, 'ui', 'index.html'));
    // 等首屏 + 第一次轮询完成后才有数据；给足时间，避免截到空态
    await new Promise((r) => setTimeout(r, 2600));

    for (const theme of ['light', 'dark']) {
      await win.webContents.executeJavaScript(
        `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true;`,
      );
      await new Promise((r) => setTimeout(r, 350));

      // 展开态
      await win.webContents.executeJavaScript(`(() => {
        const btn = document.getElementById('btn-think');
        if (btn && btn.getAttribute('aria-pressed') === 'false') btn.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 450));

      const img = await win.webContents.capturePage();
      const out = path.join(outDir, `thinking-${theme}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log('✓ ' + path.relative(repoRoot, out));

      // 收起态：确认竖边本身也是能看的样子
      await win.webContents.executeJavaScript(`(() => {
        const btn = document.getElementById('btn-think');
        if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));

      const img2 = await win.webContents.capturePage();
      const out2 = path.join(outDir, `thinking-folded-${theme}.png`);
      fs.writeFileSync(out2, img2.toPNG());
      console.log('✓ ' + path.relative(repoRoot, out2));
    }

    /*
     * 空态：没有思考记录时长什么样。
     *
     * 这一段是补上来的 —— 空态渲染路径写了，但一直没人真的看过它长什么样。
     * 「写了代码」和「确认它能看」是两件事，尤其空态往往是最容易被忽略、
     * 而用户最可能第一眼看到的那一屏（刚装好、还没接过推理模型时就是它）。
     */
    {
      // 换一份 thinking 为空的数据，再开一个窗口；不复用旧窗口是为了避免
      // 上一轮注入的 thinking 还留在页面的状态里（快照是轮询拉的，会覆盖）
      fs.writeFileSync(sandboxPreload, fakePreload({ days: [], total: 0 }), 'utf8');

      const emptyWin = new BrowserWindow({
        width: 1440,
        height: 940,
        show: false,
        webPreferences: { offscreen: true, contextIsolation: true, preload: sandboxPreload },
      });
      await emptyWin.loadFile(path.join(repoRoot, 'ui', 'index.html'));
      await new Promise((r) => setTimeout(r, 2600));

      for (const theme of ['light', 'dark']) {
        await emptyWin.webContents.executeJavaScript(
          `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true;`,
        );
        await new Promise((r) => setTimeout(r, 350));
        const img = await emptyWin.webContents.capturePage();
        const out3 = path.join(outDir, `thinking-empty-${theme}.png`);
        fs.writeFileSync(out3, img.toPNG());
        console.log('✓ ' + path.relative(repoRoot, out3));
      }

      // 空态必须给出可读的解释，而不是一片空白
      const emptyText = await emptyWin.webContents.executeJavaScript(`(() => {
        const p = document.getElementById('think-panel');
        return p ? p.innerText.trim() : '';
      })()`);
      const emptyOk = emptyText.includes('暂无思考记录') && emptyText.length > 12;
      console.log(`  ${emptyOk ? '✓' : '✖'} 空态有明确文案（不是白屏）：${JSON.stringify(emptyText.slice(0, 60))}`);
      if (!emptyOk) process.exitCode = 1;

      emptyWin.destroy();
    }

    /* ------------------------------------------------ 运行时断言 */

    /*
     * 截图只能证明"看起来还行"，下面这些是截图看不出来的：
     *
     *   - 三行截断：截图里文字确实被裁了，但看不出是 3 行还是 4 行
     *   - 重绘不重置滚动：必须在轮询真的跑起来之后才测得出来
     *   - 确认条不被遮挡：需要量真实几何位置，而不是看 z-index 写了多少
     */
    const results = [];
    const check = (ok, label) => {
      results.push({ ok, label });
      console.log(`  ${ok ? '✓' : '✖'} ${label}`);
    };

    // 回到展开态
    await win.webContents.executeJavaScript(`(() => {
      const btn = document.getElementById('btn-think');
      if (btn && btn.getAttribute('aria-pressed') === 'false') btn.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));

    const geom = await win.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('think-panel');
      const view = document.getElementById('view');
      if (!panel || !view) return { error: '缺节点' };

      const pr = panel.getBoundingClientRect();
      const vr = view.getBoundingClientRect();
      return {
        panelRight: Math.round(window.innerWidth - pr.right),
        panelTop: Math.round(pr.top),
        panelWidth: Math.round(pr.width),
        viewWidth: Math.round(vr.width),
        clamped: [...document.querySelectorAll('.think-reason')].map((n) => ({
          scrollH: n.scrollHeight,
          clientH: n.clientHeight,
          lines: Math.round(n.clientHeight / parseFloat(getComputedStyle(n).lineHeight)),
        })),
      };
    })()`);

    if (geom.error) {
      check(false, `几何量测失败：${geom.error}`);
    } else {
      check(geom.panelRight === 0, `面板贴住右边缘（右间距 ${geom.panelRight}px）`);
      check(geom.panelTop === 0, `面板从顶部开始（上间距 ${geom.panelTop}px）`);
      check(geom.panelWidth >= 270 && geom.panelWidth <= 380, `面板宽度 ${geom.panelWidth}px 在 270~380 之间`);
      check(geom.viewWidth >= 520, `主内容区仍有 ${geom.viewWidth}px（不能被压死）`);

      const clamped = geom.clamped.filter((c) => c.scrollH > c.clientH + 2);
      check(clamped.length > 0, `有 ${clamped.length} 段长思考文本确实被裁剪`);
      check(
        clamped.every((c) => c.lines === 3),
        `裁剪高度正好 3 行（实测 ${clamped.map((c) => c.lines).join('/')} 行）`,
      );
    }

    /* 滚到中间，等两轮轮询（4s+），位置必须还是原来那个 */
    const scroll = await win.webContents.executeJavaScript(`(async () => {
      const sc = document.querySelector('.think-scroll');
      if (!sc) return { error: '找不到滚动区' };
      if (sc.scrollHeight <= sc.clientHeight + 10) return { error: '内容不够长，测不出滚动' };
      sc.scrollTop = 40;
      const want = sc.scrollTop;
      // 4.5 秒：跨过至少两轮 2s 轮询，每轮都会重建整个面板
      await new Promise((r) => setTimeout(r, 4500));
      const now = document.querySelector('.think-scroll');
      return {
        want,
        got: now ? Math.round(now.scrollTop) : -1,
        // 确认重建确实发生过
        rebuilt: now !== sc,
      };
    })()`);

    if (scroll.error) {
      check(false, `滚动保护：${scroll.error}`);
    } else {
      check(scroll.rebuilt === true, '4.5 秒内面板确实被轮询重建过（否则这条测试没意义）');
      check(
        Math.abs(scroll.got - scroll.want) <= 2,
        `用户上翻后重绘不拽回顶部（期望 ${scroll.want}，实际 ${scroll.got}）`,
      );
    }

    /* 贴底时应当跟随最新 */
    const stick = await win.webContents.executeJavaScript(`(async () => {
      const sc = document.querySelector('.think-scroll');
      if (!sc) return { error: '找不到滚动区' };
      sc.scrollTop = sc.scrollHeight;
      await new Promise((r) => setTimeout(r, 2500));
      const now = document.querySelector('.think-scroll');
      return {
        atBottom: Math.abs(now.scrollTop + now.clientHeight - now.scrollHeight) <= 3,
      };
    })()`);

    if (stick.error) check(false, `贴底：${stick.error}`);
    else check(stick.atBottom === true, '贴在底部时重绘后仍然贴底（跟随最新）');

    /* 确认条必须可点：真实量一次几何覆盖 */
    const cover = await win.webContents.executeJavaScript(`(() => {
      const host = document.getElementById('confirm-host');
      const bar = host && host.querySelector('.confirm-bar');
      const panel = document.getElementById('think-panel').getBoundingClientRect();
      const main = document.querySelector('main.main').getBoundingClientRect();
      const out = { panelLeft: Math.round(panel.left), mainRight: Math.round(main.right) };
      if (!bar) return out;
      const b = bar.getBoundingClientRect();
      out.overlap = b.right > panel.left + 1;
      out.barRight = Math.round(b.right);
      return out;
    })()`);

    check(
      cover.panelLeft >= cover.mainRight - 1,
      `面板从主区右边界之后开始（main 右 ${cover.mainRight}，面板左 ${cover.panelLeft}），不可能遮挡确认条`,
    );
    if (cover.overlap !== undefined) {
      check(!cover.overlap, `确认条没有被面板覆盖（条右 ${cover.barRight} ≤ 面板左 ${cover.panelLeft}）`);
    }

    /* 点正文应当展开，且重绘后保持展开 */
    const expand = await win.webContents.executeJavaScript(`(async () => {
      const dump = (tag, n) => {
        if (!n) return { tag, missing: true };
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        return {
          tag,
          cls: n.className,
          rectH: Math.round(r.height),
          clientH: n.clientHeight,
          scrollH: n.scrollHeight,
          display: cs.display,
          lineClamp: cs.webkitLineClamp,
          overflow: cs.overflow,
          textLen: (n.textContent || '').length,
          connected: n.isConnected,
          lines: Math.round(parseFloat(cs.lineHeight) > 0 ? r.height / parseFloat(cs.lineHeight) : 0),
        };
      };

      const first = document.querySelector('.think-reason');
      if (!first) return { error: '找不到思考正文' };
      const dBefore = dump('before', first);

      /*
       * 点击后**立刻**重新 query 并立刻量。
       *
       * 这里踩过一个坑：先把节点存进变量、等两秒轮询之后才去量，
       * 量的其实是一个已经被重绘换掉的游离节点 —— 高度 0。
       * 那不是产品坏了，是测试量错了对象。所有数值必须在
       * 节点还连着文档的那一刻取完。
       */
      first.parentElement.click();
      const dNow = dump('afterClick', document.querySelector('.think-reason'));

      await new Promise((r) => setTimeout(r, 2400));
      const dPoll = dump('afterPoll', document.querySelector('.think-reason'));

      return {
        beforeH: dBefore.rectH,
        beforeLines: dBefore.lines,
        afterH: dNow.rectH,
        afterLines: dNow.lines,
        pollH: dPoll.rectH,
        pollLines: dPoll.lines,
        kept: String(dPoll.cls || '').includes('is-open'),
        diag: [dBefore, dNow, dPoll],
      };
    })()`);

    if (expand.error) {
      check(false, `展开：${expand.error}`);
    } else {
      // 断言失败时要能直接看出是哪一层高度塌了，而不是再来一轮猜
      if (process.env.SHOT_DEBUG) console.log(JSON.stringify(expand.diag, null, 2));

      check(
        expand.afterH > expand.beforeH,
        `点正文后变高（${expand.beforeH} → ${expand.afterH}px）`,
      );
      check(
        expand.afterLines > expand.beforeLines,
        `展开后行数确实变多（${expand.beforeLines} → ${expand.afterLines} 行）`,
      );
      check(expand.kept === true, '展开状态活过了 2 秒后的轮询重建（没被自动折回去）');
      check(
        expand.pollH === expand.afterH,
        `重建后高度不变（点击时 ${expand.afterH}px，轮询后 ${expand.pollH}px）`,
      );
    }

    /* 输入框聚焦时面板仍然要刷新（输入保护只该保护 #view） */
    const duringTyping = await win.webContents.executeJavaScript(`(async () => {
      // 切到模型设置页，那里有输入框
      const navBtn = [...document.querySelectorAll('#nav button')].find(b => b.dataset.page === 'model');
      if (!navBtn) return { error: '找不到模型设置导航' };
      navBtn.click();
      await new Promise((r) => setTimeout(r, 700));

      const input = document.querySelector('#view input[type="text"], #view input:not([type])');
      if (!input) return { error: '模型页没有输入框' };
      input.focus();
      input.value = 'https://example.com/v1';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const scroll = document.querySelector('.think-scroll');
      const before = scroll && scroll.firstElementChild ? scroll.firstElementChild.outerHTML.length : 0;
      // 折叠再展开：这个操作必须立刻生效，不能因为焦点在输入框就被吞掉
      document.getElementById('btn-think').click();
      await new Promise((r) => setTimeout(r, 200));
      const folded = document.getElementById('think-panel').classList.contains('is-collapsed');
      document.getElementById('btn-think').click();
      await new Promise((r) => setTimeout(r, 200));
      const reopened = document.querySelector('.think-scroll') !== null;

      return {
        focused: document.activeElement === input,
        folded,
        reopened,
        stillTyped: input.value,
      };
    })()`);

    if (duringTyping.error) {
      check(false, `输入时面板：${duringTyping.error}`);
    } else {
      check(duringTyping.focused === true, '测试前提：焦点确实在输入框里');
      check(duringTyping.folded === true, '输入框聚焦时点折叠仍然立即生效（没被输入保护吞掉）');
      check(duringTyping.reopened === true, '输入框聚焦时也能重新展开');
      check(duringTyping.stillTyped === 'https://example.com/v1', '期间输入框内容没被清掉');
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${failed === 0 ? '✓ 面板运行时行为全部通过' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

    win.destroy();
    win = null;
    cleanupPreload();
    app.quit();
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error(err);
    if (win && !win.isDestroyed()) win.destroy();
    cleanupPreload();
    app.quit();
    process.exit(1);
  }
}

main();
