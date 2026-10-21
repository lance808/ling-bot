/**
 * 「思考链路」页
 *
 * ## 布局：左 1/5 会话列表 + 右 4/5 内容
 *
 * 思考记录天然按「会话」分开：一个群的思考过程和另一个私聊的完全是两回事。
 * 全部堆在一条时间线上，用户要在一堆 `群 123456` 里靠眼睛找自己想看的那条。
 * 所以左栏先选会话，右栏只看它。
 *
 * 左栏同时承担「目录」职责：它列出**所有有记录的会话**（群聊 / 私聊分组），
 * 数据来自后端 `thinking.conversations`，**不受分页与筛选影响** ——
 * 翻到第 2 页时目录不能少几个会话，否则用户会以为记录丢了。
 *
 * ## 状态为什么由调用方持有
 *
 * 快照每 2 秒轮询一次并整页重建 DOM。选中会话、展开的步骤、折叠的日期、
 * 待确认的删除，如果记在 DOM 上（class / dataset），重建瞬间就没了 ——
 * 表现成"刚展开，两秒后自己折回去"。所以这些状态在 app.mjs 的 local 里，
 * 通过 ctx.ui 传进来，这个文件只读不写它。
 *
 * ## 删除为什么是两段式
 *
 * 一天删掉就找不回来了（数据只在本地那份 JSON 里）。所以点「删除」只是
 * 把这一天标成待确认，再点「确认删除」才真删。中间任何一次重绘都不会
 * 悄悄把确认态清掉（状态在 local 里，不在 DOM 上）。
 *
 * ## CSP
 *
 * 所有样式在 ui/styles/pages.css 里。这里**不能**出现 style 属性 ——
 * CSP 是 `style-src 'self'`，内联样式会被静默拦掉，看起来像"样式没生效"。
 */

import { el, clock } from '../render.mjs';

/* ------------------------------------------------------------ 数据整形 */

/**
 * @typedef {{n: number, reasoning: string, tools: string[], answerPreview: string}} ThinkStep
 * @typedef {{at: number, convKey: string, steps: ThinkStep[]}} ThinkEntry
 * @typedef {{date: string, entries: ThinkEntry[]}} ThinkDay
 * @typedef {{convKey: string, entries: number, steps: number, lastAt: number}} ThinkConv
 * @typedef {{ready: boolean, total: number, days: ThinkDay[], conversations: ThinkConv[], dayKeys: string[], hasMore: boolean, nextBefore: string | null}} ThinkView
 */

/**
 * 把 `snapshot.thinking` 整理成页面能直接用的形状。
 *
 * 后端还没实现这个字段时（snapshot.thinking === undefined），
 * 这里返回 ready:false 而不是抛错 —— 页面必须能优雅降级成
 * 「暂无思考记录」，不能因为后端没跟上就让整个界面白屏。
 *
 * 顺带做三件事：
 *   - 丢掉没有思考文本的步骤（空卡片只会让页面变成一片空白）
 *   - 按时间正序排列（最新在底部）
 *   - 后端没给 conversations 时，从前面的 days 里现推一份（老后端兼容）
 *
 * @param {any} snap
 * @returns {ThinkView}
 */
function readThinking(snap) {
  const raw = snap && typeof snap === 'object' ? snap.thinking : null;
  if (!raw || typeof raw !== 'object') {
    return { ready: false, total: 0, days: [], conversations: [], dayKeys: [], hasMore: false, nextBefore: null };
  }

  /** @type {ThinkDay[]} */
  const days = [];

  for (const d of Array.isArray(raw.days) ? raw.days : []) {
    if (!d || typeof d !== 'object') continue;

    /** @type {ThinkEntry[]} */
    const entries = [];
    for (const e of Array.isArray(d.entries) ? d.entries : []) {
      if (!e || typeof e !== 'object') continue;

      /** @type {ThinkStep[]} */
      const steps = [];
      for (const s of Array.isArray(e.steps) ? e.steps : []) {
        if (!s || typeof s !== 'object') continue;
        const reasoning = String(s.reasoning ?? '');
        // 没有思考文本的步骤没有展示价值：它只会占掉三行高度显示"（空）"
        if (!reasoning.trim()) continue;
        steps.push({
          n: Number.isFinite(Number(s.n)) ? Number(s.n) : steps.length + 1,
          reasoning,
          tools: Array.isArray(s.tools) ? s.tools.map((t) => String(t)).filter(Boolean) : [],
          answerPreview: String(s.answerPreview ?? ''),
        });
      }

      if (steps.length === 0) continue;
      entries.push({
        at: Number(e.at) || 0,
        convKey: String(e.convKey ?? ''),
        steps,
      });
    }

    if (entries.length === 0) continue;
    // 同一天里后端给的顺序不保证，按 at 正序排一遍
    entries.sort((a, b) => a.at - b.at);
    days.push({ date: String(d.date ?? ''), entries });
  }

  // 日期也要正序：升序 + 贴底滚动 = 用户看到的是最新的一条
  days.sort((a, b) => a.date.localeCompare(b.date));

  const reported = Number(raw.total);
  return {
    ready: true,
    total: Number.isFinite(reported) ? reported : countSteps(days),
    days,
    conversations: readConversations(raw, days),
    dayKeys: readDayKeys(raw, days),
    /*
     * 分页游标是后端的不透明值，前端只负责原样回传 —— 不要试图解析它。
     * 两个字段必须同时存在才认为"还有更早的"：只有 hasMore 却没有游标时
     * 按钮点下去会传 undefined，后端只能忽略它、界面看起来像卡住了。
     */
    hasMore: raw.hasMore === true && typeof raw.nextBefore === 'string' && raw.nextBefore.length > 0,
    nextBefore: typeof raw.nextBefore === 'string' && raw.nextBefore ? raw.nextBefore : null,
  };
}

/**
 * 会话目录。
 *
 * 优先用后端给的全量索引（它不受分页影响）；后端没给时退化成
 * "从这一页里推"，至少左栏不会是空的 —— 只是会话可能不全。
 *
 * @param {any} raw
 * @param {ThinkDay[]} days
 * @returns {ThinkConv[]}
 */
function readConversations(raw, days) {
  const list = Array.isArray(raw.conversations) ? raw.conversations : null;
  if (list && list.length > 0) {
    return list
      .filter((c) => c && typeof c === 'object' && c.convKey)
      .map((c) => ({
        convKey: String(c.convKey),
        entries: Number(c.entries) || 0,
        steps: Number(c.steps) || 0,
        lastAt: Number(c.lastAt) || 0,
      }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** @type {Map<string, ThinkConv>} */
  const derived = new Map();
  for (const day of days) {
    for (const entry of day.entries) {
      const cur = derived.get(entry.convKey) ?? { convKey: entry.convKey, entries: 0, steps: 0, lastAt: 0 };
      cur.entries += 1;
      cur.steps += entry.steps.length;
      cur.lastAt = Math.max(cur.lastAt, entry.at);
      derived.set(entry.convKey, cur);
    }
  }
  return [...derived.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * 有数据的日期列表（升序）。后端没给时从 days 推。
 *
 * @param {any} raw
 * @param {ThinkDay[]} days
 * @returns {string[]}
 */
function readDayKeys(raw, days) {
  if (Array.isArray(raw.dayKeys) && raw.dayKeys.length > 0) {
    return raw.dayKeys.map((d) => String(d)).filter(Boolean);
  }
  return days.map((d) => d.date);
}

/**
 * 只保留某个会话的记录。
 *
 * ## 这层是双保险，不是主逻辑
 *
 * 主路径是后端按 convKey 收窄（app.mjs 的 pull 会把选中的会话传下去）——
 * 那一层才是必要的：`limit` 截的是"最近 N 条"，只在前端筛的话，
 * 点开一个只有旧记录的会话会看到"暂无记录"，而左栏写着"5 回合"。
 *
 * 这里再筛一遍是为了兼容"后端还没按 convKey 收窄"的情形：
 * 传了筛选却拿回全量数据时，至少别把别的会话混进右栏。
 * 正常情况下这次过滤是空操作（数据已经只有该会话了）。
 *
 * @param {ThinkDay[]} days
 * @param {string} convKey 空串 = 全部会话
 * @returns {ThinkDay[]}
 */
function filterDays(days, convKey) {
  if (!convKey) return days;

  /** @type {ThinkDay[]} */
  const out = [];
  for (const day of days) {
    const entries = day.entries.filter((e) => e.convKey === convKey);
    // 整天空掉就不渲染这一天，否则会留一个只有日期头的空块
    if (entries.length === 0) continue;
    out.push({ date: day.date, entries });
  }
  return out;
}

/**
 * @param {ThinkDay[]} days
 * @returns {number}
 */
function countSteps(days) {
  let n = 0;
  for (const day of days) {
    for (const entry of day.entries) n += entry.steps.length;
  }
  return n;
}

/* ------------------------------------------------------------ 格式化 */

/**
 * 会话键 → 人能读的形式。
 *
 * `group:100000001` 直接显示出来，用户得先在心里翻译一遍才知道是群还是私聊。
 *
 * @param {string} key
 * @returns {string}
 */
function convLabel(key) {
  const s = String(key ?? '');
  if (!s) return '未知会话';
  const i = s.indexOf(':');
  if (i < 0) return s;
  const kind = s.slice(0, i);
  const id = s.slice(i + 1);
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return `${kind} ${id}`;
}

/** 本地日期 → YYYY-MM-DD（不能用 toISOString：那是 UTC，晚上会差一天） */
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 日期标题。
 *
 * "2026-10-19" 这种完整日期在同一天里反复出现是噪音，但完全省略年份
 * 又会在跨年时产生歧义，所以：最近两天叫人话，其余带年月日。
 *
 * @param {string} date
 */
function dayLabel(date) {
  if (!date) return '未知日期';
  const now = new Date();
  if (date === localDateKey(now)) return '今天';
  if (date === localDateKey(new Date(now.getTime() - 86_400_000))) return '昨天';

  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  if (m[1] === String(now.getFullYear())) return `${Number(m[2])}月${Number(m[3])}日`;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 列表里的短时间戳：今天只给时分，更早给「月日」。
 *
 * 直接上 `clock()` 会得到 `14:52:12` —— 在只有一列宽的左栏里太长，
 * 而且用户真正想知道的是"多久以前"，不是秒。
 *
 * @param {number} ts 毫秒
 */
function shortStamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (localDateKey(d) === localDateKey(now)) return time;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 一条步骤的稳定 key（用于记住"这一条是展开的"）。
 *
 * 不能只用下标：新条目插入会让下标整体位移，展开状态就跳到别的条目上了。
 *
 * @param {ThinkEntry} entry
 * @param {number} index
 */
function stepKey(entry, index) {
  const step = entry.steps[index];
  return `${entry.at}#${entry.convKey}#${step?.n ?? index}`;
}

/* ------------------------------------------------------------ 渲染 */

/**
 * @param {any} snap
 * @param {any} [ctx]
 * @returns {HTMLElement}
 */
export function renderThinkingPanel(snap, ctx = {}) {
  const ui = ctx.ui ?? {};
  const folded = ui.collapsed === true;
  // 空串 / null 都表示「全部会话」
  const selected = typeof ui.convKey === 'string' ? ui.convKey : '';

  const data = readThinking(snap);
  const days = filterDays(data.days, selected);
  const shown = countSteps(days);

  /*
   * 收起态：只留表头一行。
   *
   * 收起只应该把正文折掉，表头留着让人知道这里有什么、以及怎么展开。
   */
  if (folded) {
    return el('div', { class: 'think-shell' }, [
      el('header', { class: 'think-head' }, [
        el('div', { class: 'think-head-row' }, [
          el('h2', { class: 'think-title', text: '思考链路' }),
          el('span', { class: 'think-count', text: shown > 0 ? `${shown} 条` : '空' }),
          el(
            'button',
            {
              class: 'think-fold',
              type: 'button',
              title: '展开思考链路',
              'aria-label': '展开思考链路',
              onclick: () => ctx.onCollapse?.(false),
            },
            [el('span', { text: '⌄', 'aria-hidden': 'true' })],
          ),
        ]),
        el('div', { class: 'think-folded-hint', text: '已收起，点向下箭头展开' }),
      ]),
    ]);
  }

  const root = el('div', { class: 'think-shell' }, [
    renderConvColumn(data, selected, ui, ctx),
    renderMainColumn(data, days, selected, ui, ctx),
  ]);
  return root;
}

/* ------------------------------------------------------- 左栏：会话列表 */

/**
 * 左栏（约占 1/5）。
 *
 * 三个区块：「全部会话」置顶，然后群聊、私聊分开列。
 * 分开的理由和会话总览一样：群里的思考和私聊里的不是一回事，
 * 混在一起用户容易在错的会话上找。
 *
 * @param {ThinkView} data
 * @param {string} selected
 * @param {any} ui
 * @param {any} ctx
 * @returns {HTMLElement}
 */
function renderConvColumn(data, selected, ui, ctx) {
  const convs = data.conversations;
  const groups = convs.filter((c) => c.convKey.startsWith('group:'));
  const privates = convs.filter((c) => c.convKey.startsWith('private:'));
  const others = convs.filter((c) => !c.convKey.startsWith('group:') && !c.convKey.startsWith('private:'));

  const totalSteps = convs.reduce((n, c) => n + c.steps, 0);

  /** @param {ThinkConv} conv */
  const item = (conv) =>
    el(
      'button',
      {
        class: 'think-pick',
        type: 'button',
        // 选中态用 aria-current：和会话总览的 .pick 保持同一套表达
        'aria-current': conv.convKey === selected ? 'true' : 'false',
        title: conv.convKey,
        dataset: { thinkConv: conv.convKey },
        onclick: () => ctx.onSelectConv?.(conv.convKey),
      },
      [
        el('span', { class: 'think-pick-title', text: convLabel(conv.convKey) }),
        el('span', {
          class: 'think-pick-sub',
          text: `${conv.entries} 回合 · ${conv.steps} 步 · ${shortStamp(conv.lastAt)}`,
        }),
      ],
    );

  const body = [];
  if (convs.length === 0) {
    body.push(el('div', { class: 'think-pick-empty', text: '还没有会话有思考记录' }));
  } else {
    body.push(
      el(
        'button',
        {
          class: 'think-pick',
          type: 'button',
          'aria-current': selected ? 'false' : 'true',
          title: '不筛选，按时间看全部会话',
          dataset: { thinkConv: '' },
          onclick: () => ctx.onSelectConv?.(''),
        },
        [
          el('span', { class: 'think-pick-title', text: '全部会话' }),
          el('span', { class: 'think-pick-sub', text: `${convs.length} 个会话 · ${totalSteps} 步` }),
        ],
      ),
    );
    if (groups.length > 0) body.push(el('div', { class: 'think-nav-group', text: `群聊 ${groups.length}` }), ...groups.map(item));
    if (privates.length > 0) body.push(el('div', { class: 'think-nav-group', text: `私聊 ${privates.length}` }), ...privates.map(item));
    if (others.length > 0) body.push(el('div', { class: 'think-nav-group', text: `其他 ${others.length}` }), ...others.map(item));
  }

  return el('aside', { class: 'think-col-left', 'aria-label': '会话列表' }, [
    el('div', { class: 'think-col-head', text: '会话' }),
    el('div', { class: 'think-pick-list' }, body),
  ]);
}

/* ------------------------------------------------------- 右栏：内容 */

/**
 * 右栏（约占 4/5）：筛选 + 滚动内容。
 *
 * @param {ThinkView} data
 * @param {ThinkDay[]} days
 * @param {string} selected
 * @param {any} ui
 * @param {any} ctx
 * @returns {HTMLElement}
 */
function renderMainColumn(data, days, selected, ui, ctx) {
  const shown = countSteps(days);

  const head = el('header', { class: 'think-head' }, [
    el('div', { class: 'think-head-row' }, [
      el('h2', { class: 'think-title', text: selected ? convLabel(selected) : '全部会话' }),
      // 标题只报"眼前这一屏里有几条"，后端总数放进 title
      el('span', {
        class: 'think-count',
        text: shown > 0 ? `${shown} 条` : '空',
        title: `留存 ${data.total} 个回合，本页 ${shown} 个思考步骤`,
      }),
      el(
        'button',
        {
          class: 'think-fold',
          type: 'button',
          title: '收起面板',
          'aria-label': '收起思考链路面板',
          onclick: () => ctx.onCollapse?.(true),
        },
        [el('span', { text: '⌃', 'aria-hidden': 'true' })],
      ),
    ]),
    el('div', { class: 'row wrap think-tools-row' }, [
      ...[1, 7, 30].map((n) => segBtn(`最近 ${n} 个记录日`, (ui.days ?? 1) === n, () => ctx.onDays?.(n))),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: '最新记录',
        disabled: !ui.before,
        onclick: () => ctx.onLatest?.(),
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: '更早记录',
        disabled: !data.hasMore,
        title: data.hasMore ? '往回翻一页' : '没有更早的记录了',
        onclick: () => data.hasMore && ctx.onOlder?.(data.nextBefore),
      }),
    ]),
  ]);

  const scroll = el('div', { class: 'think-scroll' });

  if (days.length === 0) {
    scroll.append(
      el('div', { class: 'think-empty' }, [
        el('div', { class: 'think-empty-title', text: '暂无思考记录' }),
        el('div', { class: 'think-empty-hint', text: emptyHint(data, selected) }),
      ]),
    );
  } else {
    for (const day of days) scroll.append(renderDay(day, ui, ctx));
  }

  return el('div', { class: 'think-col-main' }, [head, scroll]);
}

/**
 * @param {string} label
 * @param {boolean} pressed
 * @param {() => void} onClick
 * @param {boolean} [disabled]
 * @param {string} [hint]
 */
function segBtn(label, pressed, onClick, disabled, hint) {
  return el('button', {
    type: 'button',
    text: label,
    'aria-pressed': pressed ? 'true' : 'false',
    title: hint ?? '',
    disabled: disabled === true,
    onclick: onClick,
  });
}

/**
 * 空态文案。
 *
 * "暂无思考记录"这句话本身不够用：用户分不清是"后端坏了"还是
 * "模型这次没思考"还是"筛错了会话"。所以按情况分别解释。
 *
 * @param {ThinkView} data
 * @param {string} selected
 */
function emptyHint(data, selected) {
  if (!data.ready) {
    return '后端还没有上报思考内容。推理模型返回 reasoning 时，这里会自动出现记录。';
  }
  if (selected) {
    return `${convLabel(selected)} 在当前范围内没有思考记录。可以返回「全部会话」，或者扩大记录日范围。`;
  }
  return '这个时间范围内没有思考内容。非推理模型不会返回 reasoning。';
}

/**
 * 一个日期分组。
 *
 * 头部由「折叠按钮」和「删除按钮」两个独立按钮组成 —— 不能嵌套按钮
 * （HTML 不允许，浏览器会把内层那个吞掉，表现成删不掉）。
 *
 * @param {ThinkDay} day
 * @param {any} ui
 * @param {any} ctx
 */
function renderDay(day, ui, ctx) {
  const closed = ui.closedDays instanceof Set ? ui.closedDays.has(day.date) : false;
  const n = countSteps([day]);
  // 这一天是否处于"等你再点一次"的状态
  const pending = ui.pendingDelete === day.date;

  const head = el('div', { class: `think-day-head${pending ? ' is-confirming' : ''}` }, [
    el(
      'button',
      {
        class: 'think-day-toggle',
        type: 'button',
        'aria-expanded': closed ? 'false' : 'true',
        title: day.date,
        dataset: { thinkDay: day.date },
        onclick: () => ctx.onToggleDay?.(day.date),
      },
      [
        el('span', { class: 'think-day-arrow', text: closed ? '▸' : '▾' }),
        el('span', { class: 'think-day-label', text: dayLabel(day.date) }),
        el('span', { class: 'think-day-count', text: `${n} 条` }),
      ],
    ),
    pending
      ? el('span', { class: 'think-day-confirm' }, [
          el('span', { class: 'think-day-confirm-text', text: '删掉这一天？不能撤销' }),
          el('button', {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            text: '确认删除',
            title: `删除 ${day.date} 的全部思考记录`,
            onclick: () => ctx.onDeleteDay?.(day.date),
          }),
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: '取消',
            onclick: () => ctx.onAskDelete?.(null),
          }),
        ])
      : el('button', {
          class: 'think-day-del',
          type: 'button',
          text: '删除',
          title: `删除 ${day.date} 这一天的记录`,
          'aria-label': `删除 ${day.date} 这一天的记录`,
          onclick: () => ctx.onAskDelete?.(day.date),
        }),
  ]);

  return el('section', { class: `think-day${closed ? ' is-closed' : ''}` }, [
    head,
    closed ? null : el('div', { class: 'think-day-body' }, day.entries.map((e) => renderEntry(e, ui, ctx))),
  ]);
}

/**
 * 一次回合：头部是时间 + 会话，下面是它的各步思考。
 *
 * @param {ThinkEntry} entry
 * @param {any} ui
 * @param {any} ctx
 */
function renderEntry(entry, ui, ctx) {
  return el('article', { class: 'think-entry' }, [
    el('div', { class: 'think-entry-head' }, [
      el('span', { class: 'think-time', text: clock(entry.at) }),
      el('span', { class: 'think-conv', title: entry.convKey, text: convLabel(entry.convKey) }),
    ]),
    ...entry.steps.map((step, i) => renderStep(entry, step, i, ui, ctx)),
  ]);
}

/**
 * 一步思考。
 *
 * 默认截断到 3 行（CSS line-clamp），点正文展开全文。
 * 展开态按 stepKey 存，所以整页重建后仍然展开。
 *
 * @param {ThinkEntry} entry
 * @param {ThinkStep} step
 * @param {number} index
 * @param {any} ui
 * @param {any} ctx
 */
function renderStep(entry, step, index, ui, ctx) {
  const key = stepKey(entry, index);
  const open = ui.expanded instanceof Set ? ui.expanded.has(key) : false;

  const toggle = () => ctx.onToggleStep?.(key);

  return el('div', { class: `think-step${open ? ' is-open' : ''}` }, [
    el('div', { class: 'think-step-head' }, [
      el('span', { class: 'think-step-n', text: `第 ${step.n} 步` }),
      step.tools.length > 0
        ? el(
            'span',
            { class: 'think-tools' },
            step.tools.map((t) => el('span', { class: 'think-tool', text: t })),
          )
        : null,
    ]),
    el(
      'div',
      {
        class: 'think-reason-wrap',
        role: 'button',
        tabindex: '0',
        title: open ? '点击收起' : '点击展开全文',
        'aria-expanded': open ? 'true' : 'false',
        // 重绘后要能把焦点还给同一条 —— 否则键盘用户每展开一次就丢一次焦点
        dataset: { thinkKey: key },
        onclick: toggle,
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        },
      },
      [el('div', { class: `think-reason${open ? ' is-open' : ''}`, text: step.reasoning })],
    ),
    step.answerPreview
      ? el('div', { class: 'think-answer', title: step.answerPreview, text: `回答预览：${step.answerPreview}` })
      : null,
  ]);
}
