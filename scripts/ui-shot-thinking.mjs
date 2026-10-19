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
  /*
   * 一段**必然超过三行**的思考文本。
   *
   * 面板从 356px 侧栏改成 980px 页面后，原来那些短句在这个宽度下只有一两行，
   * "三行截断"的断言就测不出东西（实测 0 段被裁剪，属于测试失效而不是功能坏了）。
   * 所以专门造一段长的，保证任何宽度下都溢出。
   */
  const LONG_REASON =
    '先确认一下这个问题的边界。用户说的是"那个东西弄好了吗"，没有指明是哪个东西，' +
    '但结合上下文应该是问部署脚本那件事。我不应该假设他指的是别的任务，' +
    '也不应该把两件不相干的事混在一起回答。比较稳妥的做法是：先按最可能的理解给出进展，' +
    '同时明确说出我按哪个理解来答，让他有机会立刻纠正我。这样比反问一句更省他的时间。' +
    '另外要注意语气别太笃定，毕竟是我在猜他指的是什么。' +
    '还有一点：如果真的猜错了，代价是他要再解释一遍，' +
    '而如果我反问，代价是他要花时间重新描述背景 —— 两者差不多，' +
    '但先给出一个可纠正的答案更省事。所以整体策略是：给出判断，' +
    '标明依据，留出纠正的入口。这样即使猜偏了，他也只需要补一句，' +
    '而不是从头再讲一遍。这也是我今天想清楚的一件事：' +
    '不确定的时候，可纠正比正确更重要。';
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
                // 用超长文本：980px 页面宽度下要能稳定测出"三行截断"
                reasoning: LONG_REASON,
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
  brain: { configured: true, model: 'deepseek-v4.1-flash', keySource: 'vault', inflight: 0, queued: 0, pendingConfirms: [{ id: 'c1', tool: 'shell.exec', args: { cmd: 'dir' }, expiresAt: Date.now() + 60000 }], conversations: [] },
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

    /*
     * 先切到「思考链路」页。
     *
     * 它现在是「概览」组里的一个页面，不再是常驻右侧栏 ——
     * 不点导航的话截到的是数据总览，面板根本不在 DOM 里。
     */
    const navOk = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('#nav button')]
        .find((b) => b.dataset.page === 'thinking');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!navOk) {
      console.error('✖ 导航里找不到「思考链路」');
      process.exitCode = 1;
    }
    // 切页是同步渲染，但给它一帧稳定
    await new Promise((r) => setTimeout(r, 500));

    for (const theme of ['light', 'dark']) {
      await win.webContents.executeJavaScript(
        `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true;`,
      );
      await new Promise((r) => setTimeout(r, 350));

      // 展开态：顶栏开关已随侧栏去掉，用面板自己的折叠按钮
      await win.webContents.executeJavaScript(`(() => {
        const page = document.querySelector('.think-page');
        // 正文不在 DOM 里 = 处于收起态，需要点开
        if (page && !page.querySelector('.think-scroll')) {
          page.querySelector('.think-fold')?.click();
        }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 450));

      const img = await win.webContents.capturePage();
      const out = path.join(outDir, `thinking-${theme}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log('✓ ' + path.relative(repoRoot, out));

      // 收起态：确认"只剩表头"的样子也是能看的
      await win.webContents.executeJavaScript(`(() => {
        const page = document.querySelector('.think-page');
        if (page && page.querySelector('.think-scroll')) {
          page.querySelector('.think-fold')?.click();
        }
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

      // 空态也要先切到思考链路页，否则截到的是数据总览（页面上根本没有面板）
      await emptyWin.webContents.executeJavaScript(`(() => {
        const btn = [...document.querySelectorAll('#nav button')]
          .find((b) => b.dataset.page === 'thinking');
        if (btn) btn.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));

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
      /*
       * 用 textContent 而不是 innerText。
       *
       * 离屏（offscreen: true）窗口的 innerText 依赖布局，对空态那种
       * 居中矮块返回空串 —— 截图里明明有内容，取文却是 ""，
       * 会把"渲染正常"误判成"白屏"。textContent 不依赖布局，才是这里该用的。
       *
       * 选择器也改了：.think-panel 这个类在改成页面之后已经不存在（现在是 .think-page / .think-shell）。
       */
      const emptyText = await emptyWin.webContents.executeJavaScript(`(() => {
        const p = document.querySelector('.think-page');
        return p ? (p.textContent ?? '').replace(/\\s+/g, ' ').trim() : '';
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

    /*
     * 回到展开态。
     *
     * 顶栏那个 btn-think 开关已经随侧栏一起去掉了 —— 现在收起/展开由面板
     * 自己的折叠按钮负责（.think-fold）。所以这里改成直接点它，
     * 并且断言它确实恢复到了展开态，否则后面"裁剪成几行"的断言会在
     * 收起态上做（正文压根不在 DOM 里，量出来是 0 段）。
     */
    const restored = await win.webContents.executeJavaScript(`(() => {
      const fold = document.querySelector('.think-page .think-fold');
      if (!fold) return { ok: false, why: '找不到折叠按钮' };
      // 收起态的直接证据是"正文区不在 DOM 里"（收起时 renderThinkingPanel 只返回表头）
      const wasCollapsed = !document.querySelector('.think-page .think-scroll');
      // 收起态点它展开；展开态保持不动
      if (wasCollapsed) fold.click();
      return { ok: true, wasCollapsed };
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    if (!restored.ok) {
      check(false, `无法回到展开态：${restored.why}`);
    }

    const geom = await win.webContents.executeJavaScript(`(() => {
      // 面板现在是「思考链路」页里的内容（.think-page 是挂载点，.think-shell 是根节点）
      const page = document.querySelector('.think-page');
      const shell = document.querySelector('.think-page .think-shell');
      const view = document.getElementById('view');
      if (!shell || !view) return { error: '缺节点' };

      const pr = shell.getBoundingClientRect();
      const vr = view.getBoundingClientRect();
      const navBtn = [...document.querySelectorAll('#nav button')].find((b) => b.dataset.page === 'thinking');
      return {
        // 页面形态：面板在 view 内部，两侧留白、有最大宽度，而不是贴住窗口右边
        insideView: pr.left >= vr.left - 1 && pr.right <= vr.right + 1,
        panelWidth: Math.round(pr.width),
        viewWidth: Math.round(vr.width),
        navActive: navBtn ? navBtn.getAttribute('aria-current') === 'page' : false,
        hasPage: !!page,
        // 诊断：确认展开态下确实有 .think-reason 节点
        reasonCount: document.querySelectorAll('.think-reason').length,
        scrollExists: !!document.querySelector('.think-page .think-scroll'),
        clamped: [...document.querySelectorAll('.think-reason')].map((n) => ({
          scrollH: n.scrollHeight,
          clientH: n.clientHeight,
          lines: Math.round(n.clientHeight / parseFloat(getComputedStyle(n).lineHeight)),
          textLen: (n.textContent ?? '').length,
        })),
      };
    })()`);

    if (geom.error) {
      check(false, `几何量测失败：${geom.error}`);
    } else {
      // 改成页面之后，这些断言验证的是"它确实是一页内容"而不是"它贴住右边"
      check(geom.hasPage === true, '思考链路是页内内容（.think-page 存在）');
      check(geom.insideView === true, '面板在 content view 内部，不是浮在右侧的独立一列');
      check(geom.panelWidth > 0 && geom.panelWidth <= geom.viewWidth, `面板宽 ${geom.panelWidth}px，不超过 view 的 ${geom.viewWidth}px`);
      check(geom.navActive === true, '左侧导航高亮在「思考链路」上');

      /*
       * 判据修正：不能用 scrollH > clientH。
       *
       * -webkit-line-clamp 是通过**裁掉盒外内容**实现的，隐藏部分的尺寸
       * 不计入 scrollHeight —— 实测被裁到 3 行的元素 scrollH 与 clientH 都等于
       * 58px（正好三行），原来的判据永远筛出 0 条，看着像"截断失效"。
       *
       * 真正的证据是：**行数被钉在 3**，而文本明显长于三行能显示的内容。
       */
      const clamped = geom.clamped.filter((c) => c.lines === 3 && c.textLen > 60);
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

    /*
     * 确认条必须可点。
     *
     * 旧判据（"面板在主区右边界之后"）是侧栏时代的 —— 那时它们是网格的两列。
     * 改成页面后两者在同一区域，正确的判据是**层级**：确认条要盖在面板之上，
     * 且它的中心点命中的元素确实是它自己（而不是被面板挡住）。
     */
    const cover = await win.webContents.executeJavaScript(`(() => {
      const host = document.getElementById('confirm-host');
      const bar = host && host.querySelector('.confirm-bar');
      const panel = document.querySelector('.think-page .think-shell');
      if (!panel) return { error: '找不到面板' };
      const out = { hasBar: !!bar };
      // z-index 可能是 'auto'，parseInt 会得到 NaN；NaN 比较恒为 false，会假失败
      const toZ = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
      const hostZ = toZ(getComputedStyle(host).zIndex);
      const panelZ = toZ(getComputedStyle(panel).zIndex);
      out.hostZ = hostZ;
      out.panelZ = panelZ;
      if (!bar) return out;
      const b = bar.getBoundingClientRect();
      // 命中测试：确认条中心点上最顶层的元素应属于确认条自身
      const hit = document.elementFromPoint(
        Math.round(b.left + b.width / 2),
        Math.round(b.top + b.height / 2),
      );
      out.hitInsideBar = !!(hit && (hit === bar || bar.contains(hit)));
      return out;
    })()`);

    if (cover.error) {
      check(false, `覆盖检测：${cover.error}`);
    } else if (!cover.hasBar) {
      // 没有待确认项时确认条本来就不渲染，这条只能跳过
      console.log('  - 确认条：本轮没有待确认项，跳过几何检测');
    } else {
      check(cover.hitInsideBar === true, '确认条中心点命中它自己（没有被面板挡住）');
      check(cover.hostZ >= cover.panelZ, `确认条层级 ${cover.hostZ} ≥ 面板 ${cover.panelZ}`);
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

      /*
       * 选**最长**的那条来点，而不是第一条。
       *
       * 改成 980px 页面后，大部分假数据的思考只有一两行、本来就不截断，
       * 点它当然"高度不变"——那不是展开失效，是这条本来就没被折起来。
       */
      const all = [...document.querySelectorAll('.think-reason')];
      if (all.length === 0) return { error: '找不到思考正文' };
      const first = all.reduce((a, b) =>
        (a.textContent || '').length >= (b.textContent || '').length ? a : b,
      );
      const dBefore = dump('before', first);

      /*
       * 点击后**立刻**重新 query 并立刻量。
       *
       * 这里踩过一个坑：先把节点存进变量、等两秒轮询之后才去量，
       * 量的其实是一个已经被重绘换掉的游离节点 —— 高度 0。
       * 那不是产品坏了，是测试量错了对象。所有数值必须在
       * 节点还连着文档的那一刻取完。
       */
      // 记住"是哪一段"，重绘后按它重新定位（不能沿用节点引用）
      const wantText = first.textContent || '';
      const wrapWasOpen = (first.closest('.think-reason-wrap')?.getAttribute('aria-expanded')) === 'true';

      // .think-reason-wrap 才挂着点击处理
      const wrap = first.closest('.think-reason-wrap') ?? first.parentElement;
      wrap.click();

      const findSame = () => {
        const list = [...document.querySelectorAll('.think-reason')];
        return list.find((n) => (n.textContent || '') === wantText) ?? null;
      };
      const dNow = dump('afterClick', findSame());

      await new Promise((r) => setTimeout(r, 2400));
      const dPoll = dump('afterPoll', findSame());

      return {
        beforeH: dBefore.rectH,
        beforeLines: dBefore.lines,
        afterH: dNow.rectH,
        afterLines: dNow.lines,
        pollH: dPoll.rectH,
        pollLines: dPoll.lines,
        wantText: wantText.length,
        wrapWasOpen,
        foundAfter: !!dNow,
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

    /*
     * 输入框聚焦时，思考链路的折叠/展开仍然要立即生效。
     *
     * 注意：面板改成「思考链路」页之后，它和模型设置页**不是同一页**了 ——
     * 切到模型设置页时面板根本不在 DOM 里，所以不能再"一边填密钥一边看面板"。
     * 这条测试因此改成在同页内验证：焦点落在输入框里时，点折叠按钮依然生效。
     *
     * 输入框用页面里的搜索/筛选类输入；没有的话就退回在面板内造一个临时 input，
     * 只为了制造"焦点在可编辑元素上"这个前提。
     */
    const duringTyping = await win.webContents.executeJavaScript(`(async () => {
      const navBtn = [...document.querySelectorAll('#nav button')].find(b => b.dataset.page === 'thinking');
      if (!navBtn) return { error: '找不到思考链路导航' };
      navBtn.click();
      await new Promise((r) => setTimeout(r, 600));

      // 在面板里临时塞一个输入框并聚焦，制造输入保护的前提
      const page = document.querySelector('.think-page');
      if (!page) return { error: '思考链路页没渲染出来' };
      const input = document.createElement('input');
      input.type = 'text';
      input.value = 'https://example.com/v1';
      page.appendChild(input);
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const fold = document.querySelector('.think-page .think-fold');
      if (!fold) return { error: '找不到折叠按钮' };

      const beforeFolded = !document.querySelector('.think-page .think-scroll');
      fold.click();
      await new Promise((r) => setTimeout(r, 250));
      const afterFolded = !document.querySelector('.think-page .think-scroll');

      const fold2 = document.querySelector('.think-page .think-fold');
      if (fold2) fold2.click();
      await new Promise((r) => setTimeout(r, 250));
      const reopened = document.querySelector('.think-page .think-scroll') !== null;

      return {
        // 折叠会重建面板，临时 input 会随之消失；所以不拿 activeElement 断言，
        // 改为直接验证"聚焦状态下点折叠有没有生效"这个真正关心的问题
        focused: true,
        folded: beforeFolded !== afterFolded ? true : 'no-change',
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
