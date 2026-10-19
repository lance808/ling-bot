/**
 * 前端启动 —— 原生 JS，无框架
 *
 * 九个页面，按「看 / 配 / 查」分成三组（见 PAGES 的 group 字段）：
 *
 *   概览  数据总览 / 会话总览
 *   配置  模型设置 / 人格设置 / 工具记忆 / 插件设置 / 系统安全 / DSH 接入
 *   记录  词元消耗 / 运行日志
 *
 * 分组不只是好看：9 个页面平铺在侧栏里，用户要一行行读完才知道
 * "我要改的东西在哪"。分组后「改配置」有固定的位置。
 *
 * 每 2 秒拉一次快照（单一入口），不做每页面各自轮询。
 */

import { getState, set, subscribe, toast } from './store.mjs';
import { snapshot, action, setting, onEvent, meta, hasBridge } from './api.mjs';
import { el, clear } from './render.mjs';
import { renderOverview } from './views/overview.mjs';
import { renderSessions } from './views/sessions.mjs';
import { renderPersona, renderBehaviorLayer } from './views/persona.mjs';
import { renderSecurity } from './views/security.mjs';
import { renderLogs } from './views/logs.mjs';
import { renderConfirmBar } from './views/confirm.mjs';
import { renderModelSettings } from './views/model.mjs';
import { renderDsh } from './views/dsh.mjs';
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

  { id: 'model', group: '配置', label: '模型设置', sub: '提供商、密钥、模型列表与能力探测', render: (s, ctx) => renderModelSettings(s, ctx.model) },
  { id: 'persona', group: '配置', label: '人物设置', sub: '人格 = 它是谁；角色 = 它在什么场景扮演什么', render: (s, ctx) => el('div', {}, [renderPersona(s, { persona: ctx.persona, role: ctx.role, tab: ctx.tab, onTab: ctx.onTab }), el('div', { class: 'spacer-12' }), renderBehaviorLayer()]) },
  { id: 'tools', group: '配置', label: '工具记忆', sub: 'L3 情境知识 / L4 任务与工具 / L5 输出契约', render: (s, ctx) => renderTools(s, ctx.tools) },
  { id: 'plugins', group: '配置', label: '插件设置', sub: '已安装与已启用的插件', render: (s, ctx) => renderPlugins(s, ctx.plugins) },
  { id: 'security', group: '配置', label: '系统安全', sub: '白名单、管理员与控制台凭证', render: (s, ctx) => renderSecurity(s, ctx.security) },
  { id: 'dsh', group: '配置', label: 'DSH 接入', sub: '双向通道：审批推送到 QQ，QQ 下指令给 DSH', render: (s, ctx) => renderDsh(s, ctx.model) },

  { id: 'usage', group: '记录', label: '词元消耗', sub: '输入 / 输出、缓存命中与时间范围', render: (s, ctx) => renderUsage(s, ctx.usage) },
  { id: 'logs', group: '记录', label: '运行日志', sub: '工具调用历史与每次唤醒的消耗', render: (s, ctx) => renderLogs(s, ctx.logs) },
];

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
    filter: 'all',
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

/** 右侧思考面板挂载点（它是 .app 的第三列，不在 .main 里） */
const thinkPanel = /** @type {HTMLElement} */ (document.getElementById('think-panel'));

/** 顶栏的开启/收起按钮 */
const thinkToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-think'));

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

  const shell = thinkPanel.querySelector('.think-scroll');
  const prevTop = shell ? shell.scrollTop : 0;
  const prevHeight = shell ? shell.scrollHeight : 0;
  const prevClient = shell ? shell.clientHeight : 0;
  // 贴底判定留 24px 容差：分数像素和滚动条圆角会让 exact 比较永远为 false
  const wasAtBottom = prevHeight <= prevClient + 24 || prevTop + prevClient >= prevHeight - 24;

  /*
   * 记住焦点在哪一条。
   *
   * 面板里的正文是可聚焦的（tabindex=0），重建会把焦点节点一起丢掉。
   * 不恢复的话，键盘用户按一次回车展开、焦点就掉回 body，
   * 再按 Tab 要重新从侧栏走一遍 —— 用起来非常难受。
   */
  const active = document.activeElement;
  const focusKey =
    active instanceof HTMLElement && thinkPanel.contains(active)
      ? (active.dataset?.thinkKey ?? (active.dataset?.thinkDay ? `day:${active.dataset.thinkDay}` : ''))
      : '';

  clear(thinkPanel);
  thinkPanel.classList.toggle('is-collapsed', local.think.collapsed === true);

  const node = renderThinkingPanel(state.snapshot, {
    currentConv: currentConvOf(state),
    ui: local.think,
    onCollapse: (v) => setThinkCollapsed(v),
    onFilter: (f) => {
      local.think.filter = f;
      refreshThinkOnly();
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
    if (wasAtBottom) next.scrollTop = next.scrollHeight;
    else next.scrollTop = prevTop;
  }

  if (focusKey) {
    const again = next?.querySelector(`[data-think-key="${cssEscape(focusKey)}"]`);
    again?.focus?.();
  }
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

/**
 * 顶栏开关。
 *
 * 用的是"当前状态取反"而不是读 aria-pressed：aria 是渲染产物，
 * 在重绘之间可能与 local 短暂不一致，拿它当输入会让连点两下卡住。
 */
thinkToggle?.addEventListener('click', () => {
  setThinkCollapsed(!local.think.collapsed);
});

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

document.getElementById('btn-restart')?.addEventListener('click', () => {
  toast('已请求重启后端，窗口保持开启');
});

/* ---------------------------------------------------------------- 环境信息 */

const env = document.getElementById('env-info');
if (env) {
  const m = meta();
  env.textContent = `Electron ${m.versions?.electron ?? '?'} · Node ${m.versions?.node ?? '?'} · ${m.platform ?? ''}`;
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

async function pull() {
  if (polling) return;
  polling = true;
  try {
    const snap = await snapshot();
    // 后端还在 boot()：不要把它当"空数据"渲染，避免误导成"一个群都没配"
    if (snap?.booting) {
      set({ snapshot: snap });
      return;
    }
    set({ snapshot: snap });
  } catch {
    // 后端可能正在重启；保持上一次快照，不刷错误
  } finally {
    polling = false;
  }
}

setInterval(pull, 2000);
pull();

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
      local.cardDirty[kind] = false;
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
      local.cardDirty[kind] = false;
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
    refreshThinkOnly();
    syncThemeButtons();
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
      onSaveSetting: async (k, v) => {
        const r = await setting(k, v);
        await pull();
        return r;
      },
      onSaveApiKey: (key) =>
        withPaintLock(async () => {
          const r = await action('secret.saveApiKey', { key });
          await pull();
          return r;
        }),
      onClearApiKey: async () => {
        const r = await action('secret.clearApiKey', {});
        await pull();
        return r;
      },
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
      state: s.snapshot?.plugins ?? { loaded: [], skipped: [], enabled: [] },
      onToggle: async (name, on) => {
        const cur = s.snapshot?.plugins?.enabled ?? [];
        const next = on ? [...new Set([...cur, name])] : cur.filter((x) => x !== name);
        const r = await setting('plugins.enabled', next);
        await pull();
        return r;
      },
      /**
       * 危险权限开关。
       *
       * 和 onToggle 走同一条 setting 通道，只是键不同 —— 后端会重新加载
       * 插件面，所以点完立刻生效，不用重启。
       */
      onDangerous: (on) =>
        withPaintLock(async () => {
          const r = await setting('plugins.allowDangerous', on === true);
          await pull();
          return r;
        }),
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
        render();
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

  if (s.toast && Date.now() - s.toast.at < 4000) {
    toastEl.hidden = false;
    toastEl.textContent = s.toast.text;
  } else {
    toastEl.hidden = true;
  }

  /*
   * 思考面板在确认条之后挂载：两者是不同网格列，互不遮挡；
   * 顺序只影响"先算谁"，放后面是为了让主视图先出现在屏幕上。
   */
  paintThinkPanel(s);
  syncThinkToggle();

  syncThemeButtons();
}

subscribe(render);
render();
