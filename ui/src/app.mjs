/**
 * 前端启动 —— 原生 JS，无框架
 *
 * 页面按「看 / 配 / 查」分成三组（见 PAGES 的 group 字段）：
 *
 *   概览  数据总览 / 会话总览 / 思考链路
 *   配置  模型设置 / 人物设置 / 工具记忆 / 插件 / 系统安全
 *   记录  词元消耗 / 运行日志
 *
 * 分组不只是好看：页面平铺在侧栏里，用户要一行行读完才知道
 * "我要改的东西在哪"。分组后「改配置」有固定的位置。
 *
 * 注意：**没有「DSH 接入」这一页**。DSH 已经是普通插件，
 * 它的配置、启停、诊断全部在「插件」页里，由插件清单驱动。
 * 这样再加一个插件不需要再往侧栏里塞一个入口。
 *
 * 每 2 秒拉一次快照（单一入口），不做每页面各自轮询。
 */

import { getState, set, subscribe, toast } from './store.mjs';
import { snapshot, action, setting, onEvent, meta, hasBridge, restartBackend } from './api.mjs';
import { el, clear } from './render.mjs';
import { snapshotQuery, usageQuery } from './contracts.mjs';
import { snapshotFingerprint } from './snapshot-diff.mjs';
import { renderOverview } from './views/overview.mjs';
import { renderSessions } from './views/sessions.mjs';
import { renderPersona, renderBehaviorLayer } from './views/persona.mjs';
import { renderSecurity } from './views/security.mjs';
import { renderLogs } from './views/logs.mjs';
import { renderConfirmBar } from './views/confirm.mjs';
import { renderModelSettings } from './views/model.mjs';
import { renderUsage } from './views/usage.mjs';
import { renderTools } from './views/tools.mjs';
import { renderPlugins } from './views/plugins.mjs';
import { renderThinkingPanel } from './views/thinking.mjs';

/**
 * @typedef {object} Page
 * @property {string} id
 * @property {string} label
 * @property {string} group
 * @property {string} [sub] 顶栏副标题（说明这一页干什么）
 * @property {(snap: any, ctx: any) => any} render
 */

/** @type {Page[]} */
const PAGES = [
  { id: 'overview', group: '概览', label: '数据总览', sub: '连接、模型、账号与今日消耗', render: (s, ctx) => renderOverview(s, ctx) },
  { id: 'sessions', group: '概览', label: '会话总览', sub: '群聊与私聊的对话历史，可直接手动发送', render: (s, ctx) => renderSessions(s, ctx.sessions) },
  // 思考链路是「概览」下的第三个页面，不是常驻侧栏 —— 它属于"看数据"这一类，
  // 和前后台运行状态无关，长期占着右侧会一直挤压主内容区。
  { id: 'thinking', group: '概览', label: '思考链路', sub: '每个会话近期的思考过程，按日归档', render: () => el('div', { class: 'think-page' }) },

  { id: 'model', group: '配置', label: '模型设置', sub: '提供商、密钥、模型列表与能力探测', render: (s, ctx) => renderModelSettings(s, ctx.model) },
  { id: 'persona', group: '配置', label: '人物设置', sub: '人格 = 它是谁；角色 = 它在什么场景扮演什么', render: (s, ctx) => el('div', {}, [renderPersona(s, { persona: ctx.persona, role: ctx.role, tab: ctx.tab, onTab: ctx.onTab }), el('div', { class: 'spacer-12' }), renderBehaviorLayer()]) },
  { id: 'tools', group: '配置', label: '工具记忆', sub: 'L3 情境知识 / L4 任务与工具 / L5 输出契约', render: (s, ctx) => renderTools(s, ctx.tools) },
  { id: 'plugins', group: '配置', label: '插件设置', sub: '启用停用、配置、工具与诊断', render: (s, ctx) => renderPlugins(s, ctx.plugins) },
  { id: 'security', group: '配置', label: '系统安全', sub: '白名单、管理员与控制台凭证', render: (s, ctx) => renderSecurity(s, ctx.security) },

  { id: 'usage', group: '记录', label: '词元消耗', sub: '输入 / 输出、缓存命中与时间范围', render: (s, ctx) => renderUsage(s, ctx.usage) },
  { id: 'logs', group: '记录', label: '运行日志', sub: '工具调用历史与每次唤醒的消耗', render: (s, ctx) => renderLogs(s, ctx.logs) },
];

/** 插件自带的专用页面（当前为空；将来由插件清单的 ui 字段驱动） */
const pluginPages = [];

/**
 * 注册一个插件专用页面。
 *
 * 本次骨架**不真正加载**插件页面：先把这个边界留出来，证明"加页面"
 * 不需要改导航代码。将来扫描插件清单的 ui 字段后调用它即可。
 *
 * 注意生效时机：侧栏是在模块加载时遍历 PAGES 建好的，所以这个函数
 * 只对**导航重建之后**生效 —— 现在它连导航项都不会出现。别指望热加。
 *
 * @param {{ id: string, label: string, group?: string, sub?: string, render: (snap: any, ctx: any) => any }} def
 * @returns {boolean} 是否注册成功（id 重复或参数非法返回 false）
 */
export function registerPluginPage(def) {
  if (!def || typeof def.id !== 'string' || typeof def.render !== 'function') return false;
  if (PAGES.some((p) => p.id === def.id)) return false;
  const page = { group: '插件', sub: '', ...def };
  pluginPages.push(page);
  PAGES.push(page);
  return true;
}

/**
 * 插件动作的统一出口。
 *
 * 所有 `plugin.*` 都是写操作，成功后必须重新拉一次快照 ——
 * 否则界面还显示旧状态，用户会以为没生效并重复点。
 *
 * @param {string} name
 * @param {Record<string, any>} params
 */
async function callPlugin(name, params) {
  const r = await action(name, params);
  await pull();
  return r;
}

/** 本地编辑态（不进 store，因为它不参与跨页渲染） */
const local = {
  /*
   * 人格与角色各有一份编辑草稿。
   *
   * 必须分开：两者的脏标记如果共用一个，"改了人格没保存就切到角色"
   * 会把人格草稿写进角色卡（或者反过来），而且是静默的。
   *
   * key 是 'persona' | 'role'。
   */
  /** @type {Record<string, string>} */
  cardDraft: {},
  /** @type {Record<string, boolean>} */
  cardDirty: {},
  /** 人物页当前看的是哪一套卡 */
  personaTab: 'persona',
  logLines: [],
  /** 当前正在跑的回合（流式展示用） */
  /** @type {{turnId: string, convKey: string, text: string, tool: string|null, proactive: boolean} | null} */
  turn: null,
  /** 最近一次回合错误（在总览里显示，避免一闪而过的 toast 被错过） */
  /** @type {{at: number, code: string|null, message: string} | null} */
  lastTurnError: null,
  /** 词元页的时间范围选择 */
  usageRange: '24h',
  usageData: null,
  usageLoadedAt: 0,
  /*
   * 右侧思考面板的界面状态。
   *
   * 必须活在模块作用域：快照每 2 秒轮询并整页重建 DOM，
   * 任何存在 DOM 上的状态（class / dataset / 展开的正文）都会在两秒后
   * 被打回原样 —— 表现成"刚展开，它自己折回去了"。
   *
   *   collapsed   整块面板是否收起（只剩一条竖边）
   *   filter      'all' | 'current'：看全部会话还是只看当前会话
   *   expanded    展开全文的步骤 key 集合（key 形如 "<at>#<convKey>#<n>"）
   *   closedDays  被折起来的日期分组（默认全展开，所以记"关掉的"更省）
   *
   * 滚动位置**不在这里**：它必须每一帧从真实 DOM 上现取，
   * 存成模块状态反而会拿到上一次的值（见 paintThinkPanel）。
   */
  think: {
    collapsed: false,
    days: 1,
    before: null,
    /**
     * 左栏选中的会话。
     *
     * 空串 = 「全部会话」。不用 null：它要原样塞进快照查询里，
     * 而空串在 JSON 里比 null 更不容易被 midway 的判空逻辑吞掉。
     */
    convKey: '',
    /** 正在等你点「确认删除」的日期（null = 没有待确认的） */
    pendingDelete: null,
    /** @type {Set<string>} */
    expanded: new Set(),
    /** @type {Set<string>} */
    closedDays: new Set(),
  },
};

const nav = /** @type {HTMLElement} */ (document.getElementById('nav'));
const view = /** @type {HTMLElement} */ (document.getElementById('view'));
const title = /** @type {HTMLElement} */ (document.getElementById('page-title'));
const subTitle = /** @type {HTMLElement} */ (document.getElementById('page-sub'));
const toastEl = /** @type {HTMLElement} */ (document.getElementById('toast'));

/** 确认条挂载点：独立于页面内容，切页不消失 */
const confirmHost = /** @type {HTMLElement} */ (document.getElementById('confirm-host'));

/**
 * 右侧思考面板挂载点。
 *
 * **只在「思考链路」页存在** —— 它是页面内容，不是常驻侧栏。
 * 其他页面下它是 null，所有调用点都必须容忍这一点（paintThinkPanel 会直接返回）。
 *
 * @type {HTMLElement | null}
 */
let thinkPanel = /** @type {HTMLElement | null} */ (null);

/**
 * 顶栏的开启/收起按钮。
 *
 * 改成页面之后不再需要它：思考链路已经是导航里的一项，
 * 而"收起"在页面内由面板自己的折叠按钮负责。
 *
 * 保留这个变量（恒为 null）是为了让 syncThinkToggle 不必到处判空，
 * 也方便将来真要加回顶栏开关时只改这一处。
 *
 * @type {HTMLButtonElement | null}
 */
const thinkToggle = /** @type {HTMLButtonElement | null} */ (null);

/* ---------------------------------------------------------------- 主题 */

const themeApi = /** @type {any} */ (globalThis);

/** 把「亮 / 暗」按钮的按下状态同步成当前主题 */
function syncThemeButtons() {
  const cur = themeApi.__getTheme ? themeApi.__getTheme() : 'light';
  for (const btn of document.querySelectorAll('#theme-switch button')) {
    const t = btn.getAttribute('data-theme-set');
    btn.setAttribute('aria-pressed', t === cur ? 'true' : 'false');
  }
}

for (const btn of document.querySelectorAll('#theme-switch button')) {
  btn.addEventListener('click', () => {
    const t = btn.getAttribute('data-theme-set');
    if (themeApi.__setTheme) themeApi.__setTheme(t);
    syncThemeButtons();
  });
}
syncThemeButtons();

/* ---------------------------------------------------------------- 思考面板 */

/**
 * 面板收起/展开。
 *
 * 顶栏按钮和面板自己的折叠按钮都走这里，两条入口必须同步 ——
 * 否则会出现"面板已经收起了，顶栏按钮还亮着"的错位。
 *
 * @param {boolean} collapsed
 */
function setThinkCollapsed(collapsed) {
  local.think.collapsed = collapsed === true;
  // 收起时把展开的正文留在 expanded 里：用户再展开时还能接着看
  refreshThinkOnly();
}

/**
 * 只刷新右侧面板，不动页面内容。
 *
 * ## 为什么不能直接调 render()
 *
 * render() 有输入保护：用户正在页面里打字的时侯它整页跳过，
 * 面板就跟着一起冻住 —— 表现成"我在填密钥，右边思考链路不更新了"，
 * 以及更糟的一种"点了展开没反应"。
 *
 * 面板和页面是两块独立的区域：页面的输入状态不该限制面板重绘。
 * 所以面板自己的交互 + 每轮轮询都走这个入口。
 */
function refreshThinkOnly() {
  paintThinkPanel(getState());
  syncThinkToggle();
}

/**
 * 删除某一天的思考记录。
 *
 * ## 为什么删完必须 pull(true)
 *
 * 快照指纹只看内容。删掉一天之后，如果那一天正好不在当前页
 * （比如翻到了第 2 页），新快照的内容和旧的一模一样 → 指纹相同 →
 * 跳过重绘 → 用户觉得"点了没反应"。force 就是让这一帧无论如何都落下去。
 *
 * ## 为什么失败要说清楚
 *
 * 删除失败最常见的原因是文件被占用（另一个进程正开着它）。
 * 只说"删除失败"用户只能反复点；带上后端 message 才知道去关什么。
 *
 * @param {string} date `YYYY-MM-DD`
 */
async function deleteThinkDay(date) {
  if (typeof date !== 'string' || !date) return;
  try {
    const res = await action('thinking.clear', { date });
    if (res?.ok) {
      toast(res.removed > 0 ? `已删除 ${date} 的 ${res.removed} 条记录` : `${date} 已经没有记录了`);
      // 删掉的这天若正好被折叠过，把残留状态清掉，免得下次同一天再出现时是折着的
      if (local.think.closedDays instanceof Set) local.think.closedDays.delete(date);
      void pull(true);
      return;
    }
    toast(res?.message ? `删除失败：${res.message}` : '删除失败，后端没有说明原因');
  } catch (error) {
    toast(`删除失败：${String(error?.message ?? error)}`);
  }
  /*
   * 失败时也要重绘：确认条已经退出（pendingDelete 在调用前就清空了），
   * 不重绘的话那个"确认删除 / 取消"还挂在屏幕上，看着像删成功了。
   */
  refreshThinkOnly();
}

/**
 * 当前会话。
 *
 * 优先级：会话总览里选中的那个 > 正在进行的回合 > 没有。
 * 用"选中的"优先是因为用户点了某个会话就是在看它，
 * 此时在途回合很可能是别的群来的消息。
 *
 * @param {any} state
 * @returns {string}
 */
function currentConvOf(state) {
  const selected = state.selectedConv;
  if (typeof selected === 'string' && selected) return selected;
  if (local.turn && typeof local.turn.convKey === 'string') return local.turn.convKey;
  return '';
}

/**
 * 面板在清空 view 之前采到的滚动状态。
 *
 * 为什么需要这个变量：页面形态下面板会随 view 一起被销毁重建，
 * 等到 paintThinkPanel 执行时旧节点已经没了，读不到用户的滚动位置。
 * 所以必须在 render() 里、clear(view) 之前先把位置存下来。
 */
let capturedThinkScroll = /** @type {{top: number, height: number, client: number} | null} */ (null);

/** 清空后旧节点已脱离文档，恢复焦点时要用它兜底 */
let capturedShell = /** @type {HTMLElement | null} */ (null);

/**
 * 在销毁旧 DOM 之前采集滚动状态。
 *
 * 只在「思考链路」页调用；其他页面没有面板，采集了也没意义。
 */
function captureThinkScroll() {
  const shell = view.querySelector('.think-page .think-scroll');
  if (!shell) {
    capturedThinkScroll = null;
    capturedShell = null;
    return;
  }
  capturedThinkScroll = {
    top: shell.scrollTop,
    height: shell.scrollHeight,
    client: shell.clientHeight,
  };
  capturedShell = shell;
}

/**
 * 挂载/刷新右侧思考面板。
 *
 * ## 滚动位置保护（这里是整个面板最容易做错的地方）
 *
 * 快照每 2 秒回来一次，面板会被整块重建。如果不做保护：
 *   - 用户正读到中间，两秒后 DOM 被换掉，scrollTop 归零 → 跳回顶部
 *   - 想"跟随最新"就一律滚到底，于是用户往上翻的时候被强行拽回去
 *
 * 做法：**重建前**从旧 DOM 上读 scrollTop / scrollHeight，
 * 判断此刻是不是"贴着底"（用户没有手动上翻），重建后再恢复。
 *
 * 为什么不能把 scrollTop 存进 local：轮询发生在任意时刻，
 * 存下来的值会晚一拍，滚动期间会累积偏差。
 */
function paintThinkPanel(state) {
  if (!thinkPanel) return;

  /*
   * 滚动位置从**旧 DOM** 上取。
   *
   * 页面形态下 render() 会先 clear(view) 再重建，此时传进来的 thinkPanel
   * 是一个全新的空节点，它的 scrollTop 恒为 0 —— 拿它判断"是否贴底"
   * 会永远得到"贴底"，于是用户每次往上翻都被下一轮轮询拽回底部。
   *
   * 所以优先用清空之前采集到的那份（capturedThinkScroll），
   * 只有在没有采集值时才退回读当前节点（比如纯面板内交互、没走清空）。
   */
  const shell = thinkPanel.querySelector('.think-scroll') ?? capturedShell;
  const prevTop = capturedThinkScroll
    ? capturedThinkScroll.top
    : shell
      ? shell.scrollTop
      : 0;
  const prevHeight = capturedThinkScroll
    ? capturedThinkScroll.height
    : shell
      ? shell.scrollHeight
      : 0;
  const prevClient = capturedThinkScroll
    ? capturedThinkScroll.client
    : shell
      ? shell.clientHeight
      : 0;
  // 贴底判定留 24px 容差：分数像素和滚动条圆角会让 exact 比较永远为 false
  const wasAtBottom = prevHeight <= prevClient + 24 || prevTop + prevClient >= prevHeight - 24;

  // 有没有真的采到过位置：用来区分"用户翻到过这里"和"这是第一次渲染"
  const capturedForRestore = capturedThinkScroll !== null;

  /*
   * 记住焦点在哪一条。
   *
   * 面板里的正文是可聚焦的（tabindex=0），重建会把焦点节点一起丢掉。
   * 不恢复的话，键盘用户按一次回车展开、焦点就掉回 body，
   * 再按 Tab 要重新从侧栏走一遍 —— 用起来非常难受。
   *
   * 左栏的会话按钮同理：点一下左栏、两秒后焦点丢了，
   * 之后就再也用不了方向键在会话之间移动。
   */
  const active = document.activeElement;
  const focusKey =
    active instanceof HTMLElement && thinkPanel.contains(active)
      ? focusSelectorOf(active)
      : '';

  clear(thinkPanel);
  thinkPanel.classList.toggle('is-collapsed', local.think.collapsed === true);

  const node = renderThinkingPanel(state.snapshot, {
    // 左栏选中哪个会话，由 local 决定；右栏只按它过滤
    ui: local.think,
    onCollapse: (v) => setThinkCollapsed(v),
    /*
     * 切换会话：只改筛选，不重新拉快照。
     *
     * 快照里已经是"全部会话"的完整数据，前端过滤即可 —— 没有网络往返，
     * 切换是瞬时的。只有翻页（before）必须走后端，因为分页是后端算的。
     *
     * 这里要清掉 before：翻到第 2 页的游标是**上一个会话**的，
     * 换会话后它必然对不上。清掉之后就回到最新一页，符合直觉。
     */
    onSelectConv: (convKey) => {
      const next = typeof convKey === 'string' ? convKey : '';
      if (local.think.convKey === next) return;
      local.think.convKey = next;
      local.think.before = null;
      local.think.pendingDelete = null;
      /*
       * force 重绘：切换会话后 days 可能**内容完全相同**
       * （比如两个会话在同一个页面里都有记录），
       * 指纹一样就会跳过重绘，表现为"点了左栏没反应"。
       */
      void pull(true);
    },
    onDays: (days) => { local.think.days = days; local.think.before = null; void pull(true); },
    onOlder: (before) => { local.think.before = before; void pull(true); },
    onLatest: () => { local.think.before = null; void pull(true); },
    /*
     * 删除某一天：两段式。
     *
     * onAskDelete(date) 只是把这一天标成"待确认"，不碰后端；
     * onDeleteDay(date) 才真删。中间的状态放在 local 里，
     * 所以 2 秒一次的轮询重绘不会把确认态冲掉。
     */
    onAskDelete: (date) => {
      local.think.pendingDelete = typeof date === 'string' && date ? date : null;
      refreshThinkOnly();
    },
    onDeleteDay: (date) => {
      local.think.pendingDelete = null;
      void deleteThinkDay(date);
    },
    onToggleStep: (key) => {
      if (!(local.think.expanded instanceof Set)) local.think.expanded = new Set();
      if (local.think.expanded.has(key)) local.think.expanded.delete(key);
      else local.think.expanded.add(key);
      refreshThinkOnly();
    },
    onToggleDay: (date) => {
      if (!(local.think.closedDays instanceof Set)) local.think.closedDays = new Set();
      if (local.think.closedDays.has(date)) local.think.closedDays.delete(date);
      else local.think.closedDays.add(date);
      refreshThinkOnly();
    },
  });

  thinkPanel.append(node);

  /*
   * 恢复滚动。
   *
   * 三种情况：
   *   1. 用户本来就贴着底 → 继续贴底（新内容来了自然跟上）
   *   2. 用户往上翻了 → 原样恢复他的位置，**绝不**拽回底部
   *   3. 内容变短了（比如切了筛选）→ 旧位置越界，scrollTop 会被浏览器夹到最大值
   *
   * 这里**不加** scrollHeight 的差值。面板内容是「旧的在上、新的在下」，
   * 新回合只会从底部追加；追加不移动上面的内容，所以保持同一个
   * scrollTop 就是保持用户眼前那一段不动。加上差值反而会把他往下推。
   */
  const next = thinkPanel.querySelector('.think-scroll');
  if (next) {
    /*
     * 首帧（没有采集值）要**停在顶部**，不要贴底。
     *
     * 侧栏时代贴底是对的 —— 面板一直在、新内容从底部追加，用户想看最新的。
     * 但改成页面之后，每次进入这一页都是全新重建：没有采集值时三个数都是 0，
     * `0 <= 0 + 24` 恒成立，会被判成"贴底"然后滚到底 —— 打开页面直接落在
     * 中间，连"今天"的日期头都看不见。
     *
     * 所以只有**确实采到过位置**时才恢复；没采到就停在顶部，让人从头看。
     */
    if (!capturedForRestore) {
      next.scrollTop = 0;
    } else if (wasAtBottom) {
      next.scrollTop = next.scrollHeight;
    } else {
      next.scrollTop = prevTop;
    }
  }

  if (focusKey) {
    const again = next?.querySelector(focusKey);
    again?.focus?.();
  }

  // 采集值只对紧接这一次重建有效：留着会让下一次（纯面板内交互）
  // 误用上一次的位置，表现成"点展开后滚到别处去"
  capturedThinkScroll = null;
  capturedShell = null;
}

/**
 * 把一个"重建后要找回来的元素"翻译成 CSS 选择器。
 *
 * 左栏会话、步骤正文、日期折叠头三处都可聚焦，重建后都要能把焦点还回去。
 * 以前只认 `data-think-key` 和 `data-think-day`，加上左栏之后分支变多，
 * 索性集中到这里 —— 少一处手写选择器，就少一次漏转义。
 *
 * 注意 `#` 和 `:` 必须转义：步骤 key 形如 `<at>#<convKey>#<n>`，
 * 不转义会被选择器当成 id / 伪类解析，轻则匹配不到，重则抛错。
 *
 * @param {HTMLElement} node
 * @returns {string} 空串表示"这个元素不需要找回焦点"
 */
function focusSelectorOf(node) {
  const dataset = node.dataset ?? {};
  if (typeof dataset.thinkKey === 'string' && dataset.thinkKey) {
    return `[data-think-key="${cssEscape(dataset.thinkKey)}"]`;
  }
  if (typeof dataset.thinkDay === 'string' && dataset.thinkDay) {
    return `[data-think-day="${cssEscape(dataset.thinkDay)}"]`;
  }
  if (typeof dataset.thinkConv === 'string') {
    // 空串是「全部会话」那一项，也要能找回焦点
    return `[data-think-conv="${cssEscape(dataset.thinkConv)}"]`;
  }
  return '';
}

/**
 * 把任意字符串塞进属性选择器前的转义。
 *
 * key 里带 `#` 和 `:`（`<at>#<convKey>#<n>`），不转义会被选择器当成
 * id / 伪类解析 —— 直接抛错，或者更糟，匹配到别的元素。
 *
 * @param {string} value
 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * 把顶栏开关的按下状态同步成面板的真实状态。
 *
 * 抽出成函数是因为它有两条调用路径（整页重绘、以及输入保护下的
 * 只刷新面板）。两处各写一遍，早晚会漂移成一边亮一边灭。
 */
function syncThinkToggle() {
  if (!thinkToggle) return;
  thinkToggle.setAttribute('aria-pressed', local.think.collapsed === true ? 'false' : 'true');
}
/* ---------------------------------------------------------------- 导航 */

// 按 group 分组渲染，组的顺序按 PAGES 里第一次出现的顺序
const groups = [];
for (const page of PAGES) {
  let g = groups.find((x) => x.name === page.group);
  if (!g) {
    g = { name: page.group, pages: [] };
    groups.push(g);
  }
  g.pages.push(page);
}

for (const g of groups) {
  nav.append(el('div', { class: 'nav-group', text: g.name }));
  for (const page of g.pages) {
    nav.append(
      el('button', {
        type: 'button',
        text: page.label,
        'data-page': page.id,
        onclick: () => set({ page: page.id }),
      }),
    );
  }
}

document.getElementById('btn-reconnect')?.addEventListener('click', async () => {
  const res = await action('reconnect').catch((e) => ({ ok: false, message: String(e) }));
  toast(res?.ok ? '已请求重连' : `重连失败：${res?.message ?? ''}`);
});

document.getElementById('btn-restart')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await restartBackend();
    toast(result.ok ? (result.message || '已请求重启后端') : `重启失败：${result.message}`);
  } finally {
    button.disabled = false;
  }
});

/* ---------------------------------------------------------------- 环境信息 */

const env = document.getElementById('env-info');
if (env) {
  const m = meta();
  // 桌面壳换过一茬（Electron → Tauri），这里按可用字段拼，不写死名字
  const shell = m.shell ?? (m.versions?.tauri ? 'Tauri' : 'Electron');
  const shellVer = m.versions?.tauri ?? m.versions?.electron ?? '?';
  const parts = [`${shell} ${shellVer}`];
  if (m.versions?.node) parts.push(`Node ${m.versions.node}`);
  if (m.platform) parts.push(m.platform);
  env.textContent = parts.join(' · ');
}

if (!hasBridge()) {
  view.append(
    el('div', { class: 'card' }, [
      el('h2', { text: '未连接主进程' }),
      el('div', { class: 'muted', text: '页面被直接打开时没有 preload，请通过应用启动。' }),
    ]),
  );
}

/* ---------------------------------------------------------------- 快照轮询 */

let polling = false;
let pullAgain = false;
/**
 * 排队中的那次重跑是否需要强制重绘。
 *
 * 必须是独立变量：轮询进行到一半时用户点了「保存」，那次 pull(true)
 * 只会设 pullAgain；如果重跑时一律用轮询的 force=false，用户刚做完的
 * 操作就没有一次重绘落地 —— 又是"点了没反应"。
 */
let pullAgainForce = false;
let lastSnapshotAt = 0;

/**
 * 屏幕上是哪一份快照的指纹（由 render() 维护）。
 *
 * 相同就说明这次轮询没有用户看得见的变化 —— 不收、不重绘。
 * 见 snapshot-diff.mjs 里的说明。
 */
let lastSnapshotFingerprint = '';

const snapshotNotice = el('div', { class: 'hint', role: 'status', hidden: true });
view.before(snapshotNotice);

function showSnapshotHealth(error = '') {
  const text = error
    ? `数据暂未更新：${error}。${lastSnapshotAt ? `当前显示 ${new Date(lastSnapshotAt).toLocaleTimeString()} 的快照。` : '尚未取得后端快照。'}`
    : '';
  // 每 2 秒都会走这里，没变化就别写 DOM（写 textContent 也会触发一次布局）
  if (snapshotNotice.textContent === text && snapshotNotice.hidden === !error) return;
  snapshotNotice.hidden = !error;
  snapshotNotice.textContent = text;
}

/**
 * toast 的 4 秒窗口。
 *
 * 原来是靠"下一次重绘"来收起它的，于是收起时机跟着 2 秒轮询走。
 * 现在没变化就不重绘了，必须自己计时 —— 否则提示会一直挂在屏幕上。
 *
 * @type {ReturnType<typeof setTimeout> | null}
 */
let toastTimer = null;

function syncToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  const s = getState();
  const left = s.toast ? 4000 - (Date.now() - s.toast.at) : 0;
  if (left <= 0) {
    toastEl.hidden = true;
    return;
  }
  toastEl.hidden = false;
  toastEl.textContent = s.toast.text;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = null;
  }, left);
}

let usageLoading = false;
async function loadUsage() {
  if (usageLoading) return;
  usageLoading = true;
  const range = local.usageRange;
  try {
    const result = await action('usage.query', usageQuery(range));
    if (range === local.usageRange) {
      local.usageData = result.ok ? (result.range ?? result.usage?.range ?? result) : { ...usageQuery(range), covered: false, lastError: result.message };
      local.usageLoadedAt = Date.now();
    }
  } finally { usageLoading = false; }
}

/**
 * 拉一次快照。
 *
 * @param {boolean} [force] 是否无条件重绘。
 *   默认 **true**：调用方都是"刚做完一件事，必须让用户看见结果"
 *   （保存配置、点测试连接、确认工具调用……），这些地方不能省这一次重绘。
 *
 *   只有 2 秒轮询传 false —— 那才是需要"没变化就别碰 DOM"的地方。
 *   定时器不能直接把 pull 传进去：setInterval 会把毫秒数当参数塞进来，
 *   非 0 即真，等于永远强制重绘。
 */
async function pull(force = true) {
  if (polling) {
    pullAgain = true;
    // 只要排队中的任意一次要求强制，重跑就必须强制（见 pullAgainForce）
    if (force) pullAgainForce = true;
    return;
  }
  polling = true;
  try {
    const snap = await snapshot(snapshotQuery({
      /*
       * 选中的会话要传给后端，不能只在前端过滤。
       *
       * 原因：`view()` 的 `limit` 截的是"最近 N 条"，默认 50。如果只在前端筛，
       * 用户点开一个**只有旧记录**的会话（它的记录排在这 50 条之外）时，
       * 右栏会显示"暂无思考记录"，而左栏明明写着"5 回合 12 步" —— 自相矛盾。
       * 传下去之后，这一页就是按该会话重新算的，翻页、hasMore 也都对得上。
       *
       * 左栏不受影响：`conversations` 是后端按**全部留存数据**算的，
       * 不随 convKey 收窄（那才叫目录）。
       *
       * 游标安全性：切换会话时前端已经把 before 清空（见 onSelectConv），
       * 所以不会拿上一个会话的游标来用；即使真串了，view() 也只是
       * 忽略游标、退回第一页并置 cursorIgnored，不会再让整份快照失败。
       */
      convKey: local.think.convKey || null,
      days: local.think.days, before: local.think.before,
    }));
    /*
     * 后端说游标被丢了（损坏 / 口径不一致）→ 把前端游标也复位。
     *
     * 不复位的话界面会一直带着那个坏游标去请求，每次都被忽略、
     * 却仍然显示"更早记录"可用，用户点了没反应。
     */
    if (snap?.thinking?.cursorIgnored && local.think.before) {
      local.think.before = null;
      pullAgain = true;
      pullAgainForce = true;
    }
    // Full journal aggregation is cached separately; do not rescan it every two seconds.
    if (!snap.booting && (!local.usageData || Date.now() - local.usageLoadedAt > 30000)) await loadUsage();
    if (snap.usage && local.usageData) snap.usage.range = local.usageData;
    lastSnapshotAt = Date.now();
    showSnapshotHealth();

    /*
     * 内容没变就别碰 DOM —— 这是"每 2 秒闪一下"的根因。
     *
     * 原来这里无条件 set()，于是每轮都 clear(view) 整页重建。重建期间
     * 滚动容器的高度塌成 0、卡片节点全部重新插入，贴着视口边缘的
     * box-shadow 被裁掉又画回来，看起来就是"阴影消失再出现"。
     *
     * 指纹的记账在 render() 里（那边才知道这一份到底有没有落到 DOM 上），
     * 所以这里只做比较。
     */
    const fingerprint = snapshotFingerprint(snap);
    if (!force && fingerprint === lastSnapshotFingerprint) {
      // 去重只跳过重绘；统计时间边界仍须更新，否则换页后会误判账本过期。
      set({ snapshot: snap }, { notify: false });
      return;
    }

    set({ snapshot: snap });
  } catch (error) {
    showSnapshotHealth(String(error?.message ?? error));
  } finally {
    polling = false;
    if (pullAgain) {
      const nextForce = pullAgainForce;
      pullAgain = false;
      pullAgainForce = false;
      void pull(nextForce);
    }
  }
}

setInterval(() => void pull(false), 2000);
void pull();

/* ---------------------------------------------------------------- 事件订阅 */

onEvent((msg) => {
  if (msg.event === 'backend-crashed' || msg.event === 'backend-restarting') {
    toast(
      msg.event === 'backend-crashed'
        ? `后端已退出（code=${msg.payload?.code}），正在重启`
        : `后端将在 ${Math.round((msg.payload?.delayMs ?? 0) / 1000)}s 后重启（第 ${msg.payload?.attempt} 次）`,
    );
  } else if (msg.event === 'backend-gave-up') {
    toast(msg.payload?.message ?? '后端多次启动失败，需要人工介入');
  } else if (msg.event === 'backend-stderr') {
    pushLog(msg.payload?.line ?? '');
  } else if (msg.event === 'message' && msg.payload?.kind === 'message') {
    pushLog(`[消息] ${msg.payload.convKey} ${msg.payload.text ?? ''}`);
  } else if (msg.event === 'turn-start') {
    local.turn = { turnId: msg.payload.turnId, convKey: msg.payload.convKey, text: '', tool: null, proactive: msg.payload.proactive };
    pushLog(`[回合开始] ${msg.payload.convKey}（${msg.payload.trigger}）`);
    render();
  } else if (msg.event === 'turn-delta') {
    if (local.turn && local.turn.turnId === msg.payload.turnId) {
      local.turn.text += msg.payload.delta ?? '';
      // 流式只更新那一块，不整体重渲染（否则输入框会丢焦点）
      updateStream();
    }
  } else if (msg.event === 'turn-tool') {
    if (local.turn) {
      local.turn.tool = `${msg.payload.tool}（第 ${msg.payload.step} 步）`;
      updateStream();
    }
  } else if (msg.event === 'turn-end') {
    const p = msg.payload ?? {};
    pushLog(
      p.cancelled
        ? '[回合] 已取消'
        : p.ok
          ? `[回合完成] ${p.text?.slice(0, 80) ?? ''}`
          : `[回合失败] ${p.code ?? ''} ${p.message ?? ''}`,
    );

    // 失败必须让人看见：只写日志等于没说
    if (!p.ok && !p.cancelled) {
      const friendly = friendlyTurnError(p.code);
      toast(friendly ?? `回合失败：${p.code ?? ''} ${p.message ?? ''}`);
      local.lastTurnError = { at: Date.now(), code: p.code ?? null, message: p.message ?? friendly ?? '' };
    } else if (p.code === 'E2020') {
      toast('回复被出站审计拦下了（含本机路径或凭据特征）');
    }

    local.turn = null;
    render();
  } else if (msg.event === 'confirm-request') {
    toast(`需要确认：${msg.payload.tool}`);
    pull();
  } else if (msg.event === 'confirm-timeout') {
    toast(`${msg.payload.tool} 的确认已超时，按拒绝处理`);
    pull();
  }
});

/** 只更新流式区块，避免整页重绘 */
function updateStream() {
  const box = document.getElementById('turn-stream');
  if (!box || !local.turn) return;
  const body = box.querySelector('.body');
  if (body) body.textContent = local.turn.text || '（等待模型…）';
  const toolLine = box.querySelector('.tool-line');
  if (toolLine) toolLine.textContent = local.turn.tool ? `正在调用 ${local.turn.tool}` : '';
}

/* ------------------------------------------------ 重绘时的输入保护 */

/**
 * 用户是否正在某个输入框里打字。
 *
 * ## 这个函数存在的唯一原因
 *
 * 快照每 2 秒轮询一次，每次都会 `clear(view)` 整页重建 DOM。
 * 重建会**销毁旧的输入框节点**——用户刚敲进去的字符随之消失，
 * 表现就是"点进去准备打字，它自己恢复了"。
 *
 * 这不是某个页面的问题，是所有带输入框的页面共有的。
 *
 * ## 判断依据
 *
 * 焦点是否在可编辑元素上。`document.activeElement` 在焦点丢失时
 * 会变成 body，所以不能用"有没有焦点"来判断——必须确认它确实是
 * 一个输入控件。
 *
 * @returns {boolean}
 */
function isEditing() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (/** @type {HTMLElement} */ (a).isContentEditable) return true;
  return false;
}

/**
 * 上一次真正渲染过的页面 id。
 *
 * 用它区分两种情况：
 *   - 用户点了导航 → 必须重绘（哪怕正在输入，因为他要走了）
 *   - 只是轮询回来了 → 正在输入就不重绘
 */
let lastRenderedPage = null;

/**
 * 正在执行的操作数（点「测试连接」「保存 Key」这类）。
 *
 * ## 为什么需要它
 *
 * 输入保护只挡住"焦点在输入框里"的情况。但用户点「测试连接」之后，
 * 焦点在**按钮**上，重绘照常发生——于是 2 秒后整页重建，
 * 结果文字刚写进去就被抹掉，表现成"点了没反应"。
 *
 * 这类操作有个共同点：**结果要写进一个临时区域**（testHost 之类），
 * 而那块区域不属于快照数据，重建后就没了。
 *
 * 所以操作进行期间必须暂停重绘。用计数器而不是布尔值，
 * 因为可能同时有两三个操作在跑（保存地址 + 读取模型）。
 */
let activeOps = 0;

/**
 * 包一层：执行期间暂停重绘。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPaintLock(fn) {
  activeOps += 1;
  try {
    return await fn();
  } finally {
    activeOps -= 1;
    /*
     * 这里**故意不**调用 render()。
     *
     * 一开始我在这个 finally 里补了一次渲染，想着"操作结束后让界面刷新"。
     * 那是错的，而且症状很隐蔽：
     *
     *   await ctx.onTest()        ← withPaintLock 在这里返回
     *   ↳ finally 先跑 render()    ← 把 testHost 清空
     *   out.textContent = '✓ …'    ← 调用方随后才写结果，写进了已脱离文档的节点
     *
     * 于是「测试连接」永远显示不出结果。
     *
     * 结论：解锁之后不要主动重绘。调用方写入的结果留在当前 DOM 里，
     * 下一次 2 秒轮询自然会把它刷新掉 —— 那是用户预期内的更新。
     */
  }
}

/**
 * 把错误码翻译成人话。
 *
 * 用户看到 "E3020" 只会困惑；看到"API Key 无效"才知道该去改哪个设置。
 *
 * @param {string | null} code
 * @returns {string | null}
 */
function friendlyTurnError(code) {
  switch (code) {
    case 'E3020':
      return '模型鉴权失败：llm.apiKey 无效或未填';
    case 'E3021':
      return '模型名不存在或接口返回错误，检查 llm.model 与 baseUrl';
    case 'E3011':
      return '模型响应超时，可以稍后重试';
    case 'E3012':
      return '连不上模型服务，检查网络与 baseUrl';
    case 'E20XX':
      return '回复被白名单拦下了（目标会话不在 allow 里）';
    case 'E2020':
      return '回复含本机路径或凭据特征，被出站审计拦下';
    case 'E2030':
      return '发送太频繁，被限流了';
    case 'E1001':
      return 'QQ 未联通，先检查上游';
    default:
      return null;
  }
}

/** @param {string} line */
function pushLog(line) {
  if (!line) return;
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  local.logLines.push(`${stamp} ${line}`);
  if (local.logLines.length > 500) local.logLines.shift();
  if (getState().page === 'logs') render();
}

/* ---------------------------------------------------------------- 人物页工厂 */

/**
 * 造一份"卡仓库"的渲染上下文。人格与角色各用一份。
 *
 * ## 为什么要工厂
 *
 * 人格和角色的界面行为完全一致：列表、选中、新建、改名、改范围、
 * 保存内容、删除、副本。写两遍的话，改一边忘一边是迟早的事，
 * 而且那种不一致只有用户真的点到才会发现。
 *
 * ## 为什么草稿要按 kind 分开存
 *
 * 两套卡的编辑草稿必须互不干扰。如果共用一个 `local.persona`，
 * "改了人格没保存就切到角色"会把人格草稿写进角色卡，而且静默成功。
 * 所以草稿和脏标记都是 `Record<kind, ...>`。
 *
 * @param {'persona' | 'role'} kind
 */
function makeCardCtx(kind) {
  /** 快照里对应的字段：personaCards / roleCards */
  const snapKey = kind === 'persona' ? 'personaCards' : 'roleCards';
  /** 后端动作前缀 */
  const act = kind;

  return {
    kind,
    cards: getState().snapshot?.[snapKey]?.cards ?? [],
    activeId: getState().snapshot?.[snapKey]?.activeId ?? '',
    defaultId: getState().snapshot?.[snapKey]?.defaultId ?? '',
    onSetDefault: async (id) => {
      const r = await action(`${act}.setDefault`, { id });
      if (r.ok) await pull();
      return r;
    },
    draft: local.cardDirty[kind]
      ? local.cardDraft[kind]
      : ((getState().snapshot?.[snapKey]?.cards ?? []).find(
          (c) => c.id === getState().snapshot?.[snapKey]?.activeId,
        )?.text ?? ''),
    dirty: local.cardDirty[kind] === true,

    onDraft: (v) => {
      local.cardDraft[kind] = v;
      local.cardDirty[kind] = true;
    },

    onSelect: async (id) => {
      const r = await action(`${act}.activate`, { id });
      // 切卡后丢弃草稿，否则会把上一张卡的内容写进新卡
      if (r.ok) local.cardDirty[kind] = false;
      await pull();
      return r;
    },

    /**
     * 新建一张卡。
     *
     * @param {string} name
     * @param {string} [scope]   'global' | 'group' | 'private'
     * @param {string} [scopeId]
     */
    onCreate: async (name, scope = 'global', scopeId = '') => {
      const r = await action(`${act}.create`, { name, text: '', scope, scopeId });
      // 新建后把这张卡设为当前编辑对象，否则用户还要自己去点一下
      if (r?.ok && r.card?.id) {
        await action(`${act}.activate`, { id: r.card.id });
      }
      await pull();
      return r;
    },

    /**
     * 只改作用范围。
     *
     * 单独一个通道而不是复用 onSave：onSave 会把正文也一起提交，
     * 而"改范围"时正文可能正被用户编辑着（草稿未保存），
     * 混在一起会把草稿提前写进去。
     */
    onSaveScope: async (id, scope, scopeId) => {
      const r = await action(`${act}.update`, { id, scope, scopeId });
      if (r?.ok) await pull();
      return r;
    },

    /**
     * 保存内容，或改名，或两者同时。
     *
     * @param {{name?: string}} [patch]
     */
    onSave: async (patch = {}) => {
      const id = getState().snapshot?.[snapKey]?.activeId;
      if (!id) return { ok: false, code: 'E4041', message: '没有选中的卡' };
      /** @type {any} */
      const args = { id };
      // 只在真的传了名字时才改名，否则会把当前名字重复提交一次
      if (typeof patch.name === 'string') args.name = patch.name;
      // 内容：有草稿就用草稿，否则沿用当前文本
      const cur = (getState().snapshot?.[snapKey]?.cards ?? []).find((c) => c.id === id);
      args.text = local.cardDirty[kind] ? local.cardDraft[kind] : (cur?.text ?? '');
      const r = await action(`${act}.update`, args);
      if (r?.ok) {
        local.cardDirty[kind] = false;
        await pull();
      }
      return r;
    },

    onDelete: async (id) => {
      const r = await action(`${act}.delete`, { id });
      if (r.ok) local.cardDirty[kind] = false;
      await pull();
      return r;
    },

    onDuplicate: async (id) => {
      const r = await action(`${act}.duplicate`, { id });
      await pull();
      return r;
    },

    /**
     * 主动重绘。
     *
     * 人物页有多个展开/收起状态（新建表单、删除确认、改名草稿），
     * 都必须立刻反映，不能等 2 秒轮询 —— 否则点了像没反应。
     */
    rerender: () => render(),
  };
}

/* ---------------------------------------------------------------- 渲染 */

function render() {
  const s = getState();
  const page = PAGES.find((p) => p.id === s.page) ?? PAGES[0];

  /*
   * 输入保护。
   *
   * 快照每 2 秒回来一次，每次都会触发重绘。重绘会销毁旧输入框，
   * 用户敲的字跟着没了——表现成"点进去它自己恢复"。
   *
   * 规则：**换了页面就照常重绘**（用户要走了，丢掉输入是他自己的选择），
   * **还在同一页且焦点在输入框里**就跳过整页重建。
   *
   * 只跳过视图重建，导航高亮、标题、主题按钮这些仍然更新——
   * 它们不会毁掉输入状态。右侧思考面板同理：它不在 #view 里，
   * 重建它不会碰到任何输入框，所以**也要照常刷新** ——
   * 否则用户在填密钥时右边就冻住了。
   */
  const pageChanged = lastRenderedPage !== page.id;
  if (!pageChanged && (isEditing() || activeOps > 0)) {
    /*
     * 这一次没落到 DOM 上，所以**不记指纹**。
     *
     * 记了的话，等用户从输入框挪开焦点，就没有任何一轮再来补这次重绘 ——
     * 数据已经变了、界面还停在旧值，而且此后再也不会刷新（后面的快照
     * 指纹都和这份"已记账"的一样）。不记的话，下一轮轮询仍然判定为
     * "有变化"，会再走一遍 set() → render()，那时输入结束，自然就刷新了。
     */
    refreshThinkOnly();
    syncThemeButtons();
    syncToast();
    return;
  }
  lastRenderedPage = page.id;

  title.textContent = page.label;
  if (subTitle) subTitle.textContent = page.sub ?? '';
  for (const btn of nav.querySelectorAll('button')) {
    if (btn.getAttribute('data-page') === page.id) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }

  const ctx = {
    turnError: local.lastTurnError,

    /** 页面内跳转（例如总览的「去模型设置」按钮） */
    gotoPage: (id) => set({ page: id }),

    // API Key 的保存/清除。key 只在这一次 action 里传递，
    // 不写进 local 状态、不进日志（后端也只存密文）。
    onSaveApiKey: async (key) => {
      const r = await action('secret.saveApiKey', { key });
      await pull();
      return r;
    },
    onClearApiKey: async () => {
      const r = await action('secret.clearApiKey', {});
      await pull();
      return r;
    },

    model: {
      onSaveSetting: (k, v) => withPaintLock(async () => {
        const r = await setting(k, v);
        await pull();
        return r;
      }),
      onSaveApiKey: (key) =>
        withPaintLock(async () => {
          const r = await action('secret.saveApiKey', { key });
          await pull();
          return r;
        }),
      onClearApiKey: () => withPaintLock(async () => {
        const r = await action('secret.clearApiKey', {});
        await pull();
        return r;
      }),
      onTest: () => withPaintLock(() => action('llm.test', {})),
      onDetectModels: () => withPaintLock(() => action('llm.models', {})),
      onProbe: (model, probe) => withPaintLock(() => action('llm.probe', { model, probe })),
    },
    sessions: {
      selectedConv: s.selectedConv,
      onSelect: (k) => set({ selectedConv: k }),
      onSend: (k, t) => action('send-text', { convKey: k, text: t }),
      /**
       * 发媒体。路径来自主进程的原生文件选择器。
       *
       * 这里不做任何校验——路径合法性、大小、类型、
       * 白名单、出站审计**全部由后端判定**。
       * 界面只负责把用户选的路径交上去。
       */
      onSendMedia: (k, kind, filePath) => action('send-media', { convKey: k, kind, path: filePath }),
    },
    /**
     * 人物页：人格与角色各一套卡。
     *
     * 两者**完全对称**（同样的 CRUD、同样的作用范围、同样独立切换），
     * 所以用工厂生成两份，而不是写两遍 —— 写两遍必然漂移：
     * 改了一个忘另一个，而这类不一致只有用户实际遇到时才暴露。
     */
    persona: makeCardCtx('persona'),
    role: makeCardCtx('role'),
    /** 当前看的是哪一套 */
    tab: local.personaTab,
    onTab: (which) => {
      local.personaTab = which;
      render();
    },
    tools: {
      registry: s.snapshot?.registry ?? { tools: [] },
      persona: s.snapshot?.personaCards ?? { cards: [] },
    },
    plugins: {
      /*
       * 插件页要的东西全部来自快照，页面本身不认识任何具体插件。
       *
       * 这是骨架改造的关键：加一个插件、加一个配置项、加一个工具，
       * 这个文件一个字都不用改。
       */
      items: s.snapshot?.plugins?.items ?? [],
      stats: s.snapshot?.plugins?.stats ?? { total: 0, ready: 0, error: 0, disabled: 0 },
      dirs: s.snapshot?.plugins?.dirs ?? {},
      allowDangerous: s.snapshot?.plugins?.allowDangerous === true,
      onToggle: (id, on) => callPlugin(on ? 'plugin.enable' : 'plugin.disable', { id }),
      onSaveConfig: (id, config, secrets) =>
        callPlugin('plugin.saveConfig', { id, config, secrets }),
      onTest: (id) => callPlugin('plugin.test', { id }),
      onReload: (id) => callPlugin('plugin.reload', { id }),
      onRescan: () => callPlugin('plugin.rescan', {}),
      /**
       * 危险权限开关。
       *
       * 它改的是 `plugins.allowDangerous`，属于配置而不是插件动作，
       * 所以仍走 setting 通道；后端会在下次插件加载时生效。
       */
      onDangerous: (on) =>
        withPaintLock(async () => {
          const r = await setting('plugins.allowDangerous', on === true);
          await pull();
          return r;
        }),
      rerender: () => render(),
    },
    security: {
      onSaveSetting: async (k, v) => {
        const r = await setting(k, v);
        await pull();
        return r;
      },
      /**
       * 主动重绘。
       *
       * 白名单页有"编辑缓冲"：加了号或删了号之后，列表要立刻变，
       * 不能等 2 秒轮询 —— 否则用户以为没加上，会重复点。
       */
      rerender: () => render(),
    },
    usage: {
      range: local.usageRange,
      onRange: (r) => {
        local.usageRange = r;
        local.usageData = null;
        render();
        void pull();
      },
    },
    logs: {
      lines: local.logLines,
      onClear: () => {
        local.logLines.length = 0;
        render();
      },
    },
  };

  // 必须在 clear(view) 之前采：清空之后旧节点就没了，读不到用户的滚动位置
  captureThinkScroll();

  clear(view);
  try {
    view.append(page.render(s.snapshot, ctx));
  } catch (err) {
    view.append(
      el('div', { class: 'card' }, [
        el('h2', { text: '渲染失败' }),
        el('div', { class: 'muted', text: String(err) }),
      ]),
    );
  }

  /*
   * 思考链路页：把面板挂进刚渲染出来的容器里。
   *
   * 它是**页面内容**而不是常驻侧栏 —— 其他页面下 thinkPanel 一律为 null，
   * paintThinkPanel 会直接返回，这样轮询重绘不会去碰不存在的节点。
   *
   * 顺序很重要：先让 page.render 建出 .think-page 容器，再往里 append，
   * 否则拿不到挂载点（踩过）。
   */
  if (page.id === 'thinking') {
    thinkPanel = /** @type {HTMLElement | null} */ (view.querySelector('.think-page'));
    if (thinkPanel) {
      thinkPanel.classList.toggle('is-collapsed', local.think.collapsed === true);
      paintThinkPanel(s);
    }
  } else {
    thinkPanel = null;
  }

  // 流式区块：只在有在途回合时出现
  if (local.turn) {
    view.append(
      el('div', { class: 'turn-stream', id: 'turn-stream' }, [
        el('div', { class: 'head' }, [
          el('span', { text: `${local.turn.convKey} 正在说话${local.turn.proactive ? '（主动）' : ''}` }),
          el('span', { class: 'tool-line', text: local.turn.tool ? `正在调用 ${local.turn.tool}` : '' }),
        ]),
        el('div', { class: 'body', text: local.turn.text || '（等待模型…）' }),
      ]),
    );
  }

  // 确认条：始终挂在最外层（不随页面切换消失，否则高风险工具会永远等不到人）
  const pending = s.snapshot?.brain?.pendingConfirms ?? [];
  clear(confirmHost);
  confirmHost.append(
    renderConfirmBar(pending, {
      onResolve: async (id, allow) => {
        const res = await action('confirm.resolve', { id, allow });
        if (!res?.ok) toast(res?.message ?? '确认失败');
        pull();
      },
    }),
  );

  /*
   * toast 的收起改成自己计时。
   *
   * 原来是"每 2 秒重绘时顺带判断一次"，现在没变化就不重绘了，
   * 靠重绘收尾会让提示一直挂着 —— 所以计时器必须在 syncToast 里。
   */
  syncToast();

  syncThinkToggle();

  syncThemeButtons();

  /*
   * 记下"屏幕上这一份"的指纹。
   *
   * 必须在这里记，不能放在 pull() 里：只有走完整页重建，DOM 才真的
   * 和这份快照对齐。上面那个输入保护的分支会提前 return（不记），
   * 于是下一轮轮询仍判定"有变化"，再试一次 —— 用户在打字时不该被
   * 重建打断，但也不能因此永久停在旧数据上。
   */
  if (s.snapshot) lastSnapshotFingerprint = snapshotFingerprint(s.snapshot);
}

subscribe(render);
render();
