/**
 * 右侧「思考链路」面板
 *
 * ## 为什么它不是 PAGES 里的一页
 *
 * 思考内容是**正在发生**的东西：用户看会话列表时也可能想知道"它刚才在
 * 想什么"。做成一个页面就必须来回切，切走就看不到新的了。
 * 常驻面板让它一直在，且不打断当前页面。
 *
 * ## 状态为什么放在 app.mjs 的 local
 *
 * 快照每 2 秒轮询一次并整页重建 DOM。展开/折叠如果记在 DOM 上
 * （class、dataset），重建瞬间就没了 —— 表现成"刚展开，两秒后自己折回去"。
 * 所以 ui 状态由调用方持有、通过 ctx.ui 传进来，这个文件只读不写它。
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
 * @typedef {{ready: boolean, total: number, days: ThinkDay[]}} ThinkView
 */

/**
 * 把 `snapshot.thinking` 整理成面板能直接用的形状。
 *
 * 后端还没实现这个字段时（snapshot.thinking === undefined），
 * 这里返回 ready:false 而不是抛错 —— 面板必须能优雅降级成
 * 「暂无思考记录」，不能因为后端没跟上就让整个界面白屏。
 *
 * 顺带做两件事：
 *   - 丢掉没有思考文本的步骤（空卡片只会让面板变成一片空白）
 *   - 按时间正序排列（最新在底部，自动贴底才有意义）
 *
 * @param {any} snap
 * @returns {ThinkView}
 */
function readThinking(snap) {
  const raw = snap && typeof snap === 'object' ? snap.thinking : null;
  if (!raw || typeof raw !== 'object') return { ready: false, total: 0, days: [] };

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
  };
}

/**
 * 按「全部会话 / 当前会话」过滤。
 *
 * 不重新请求后端：快照里已经有全部数据，纯前端筛选没有延迟，
 * 也不会因为切换筛选把正在看的内容刷走。
 *
 * @param {ThinkDay[]} days
 * @param {'all'|'current'} filter
 * @param {string} currentConv
 * @returns {ThinkDay[]}
 */
function filterDays(days, filter, currentConv) {
  if (filter !== 'current' || !currentConv) return days;

  /** @type {ThinkDay[]} */
  const out = [];
  for (const day of days) {
    const entries = day.entries.filter((e) => e.convKey === currentConv);
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
  const filter = ui.filter === 'current' ? 'current' : 'all';
  const currentConv = typeof ctx.currentConv === 'string' ? ctx.currentConv : '';

  const data = readThinking(snap);
  const days = filterDays(data.days, filter, currentConv);
  const shown = countSteps(days);

  /*
   * 收起态：只留表头一行。
   *
   * 以前这里是「一条竖边」（竖排文字 + 箭头 + 条数），因为面板当时是常驻
   * 右侧的一列，收起后必须留下够窄又能点开的东西。
   * 改成页面之后不需要了 —— 页面本来就有导航项和标题，
   * 收起只应该把正文折掉，表头留着让人知道这里有什么、以及怎么展开。
   */
  if (folded) {
    return el('div', { class: 'think-shell' }, [
      el('header', { class: 'think-head' }, [
        el('div', { class: 'think-head-row' }, [
          el('h2', { class: 'think-title', text: '思考链路' }),
          el('span', {
            class: 'think-count',
            text: shown > 0 ? `${shown} 条` : '空',
            title: data.total > shown ? `后端共记录 ${data.total} 条，这里显示最近 ${shown} 条` : '',
          }),
          el(
            'button',
            {
              class: 'think-fold',
              type: 'button',
              title: '展开思考链路',
              'aria-label': '展开思考链路',
              onclick: () => ctx.onCollapse?.(false),
            },
            [el('span', { text: '‹' })],
          ),
        ]),
        el('div', { class: 'think-folded-hint', text: '已收起，点 ‹ 展开' }),
      ]),
    ]);
  }

  const root = el('div', { class: 'think-shell' }, [
    el('header', { class: 'think-head' }, [
      el('div', { class: 'think-head-row' }, [
        el('h2', { class: 'think-title', text: '思考链路' }),
        // 标题只报"眼前这一屏里有几条"，后端总数放进 title：
        // 面板很窄，`5 / 12 条` 这种写法会挤掉标题本身
        el('span', {
          class: 'think-count',
          text: shown > 0 ? `${shown} 条` : '空',
          title: data.total > shown ? `后端共记录 ${data.total} 条，这里显示最近 ${shown} 条` : '',
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
          [el('span', { text: '›' })],
        ),
      ]),
      el('div', { class: 'think-seg' }, [
        segBtn('全部会话', filter === 'all', () => ctx.onFilter?.('all'), false),
        segBtn(
          '当前会话',
          filter === 'current',
          () => ctx.onFilter?.('current'),
          !currentConv,
          currentConv ? `只看 ${convLabel(currentConv)}` : '还没识别到当前会话',
        ),
      ]),
    ]),
  ]);

  const scroll = el('div', { class: 'think-scroll' });

  if (days.length === 0) {
    scroll.append(
      el('div', { class: 'think-empty' }, [
        el('div', { class: 'think-empty-title', text: '暂无思考记录' }),
        el('div', { class: 'think-empty-hint', text: emptyHint(data, filter, currentConv) }),
      ]),
    );
  } else {
    for (const day of days) scroll.append(renderDay(day, ui, ctx));
  }

  root.append(scroll);
  return root;
}

/**
 * @param {string} label
 * @param {boolean} pressed
 * @param {() => void} onClick
 * @param {boolean} disabled
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
 * "模型这次没思考"。所以按三种情况分别解释。
 *
 * @param {ThinkView} data
 * @param {'all'|'current'} filter
 * @param {string} currentConv
 */
function emptyHint(data, filter, currentConv) {
  if (!data.ready) {
    return '后端还没有上报思考内容。推理模型返回 reasoning 时，这里会自动出现记录。';
  }
  if (filter === 'current' && !currentConv) {
    return '还没识别到当前会话。去会话总览选一个会话，或者切回「全部会话」。';
  }
  if (filter === 'current') {
    return `当前会话（${convLabel(currentConv)}）还没有思考记录，切到「全部会话」可以看其他会话。`;
  }
  return '这个时间范围内没有思考内容。非推理模型不会返回 reasoning。';
}

/**
 * 一个日期分组。
 *
 * @param {ThinkDay} day
 * @param {any} ui
 * @param {any} ctx
 */
function renderDay(day, ui, ctx) {
  const closed = ui.closedDays instanceof Set ? ui.closedDays.has(day.date) : false;
  const n = countSteps([day]);

  return el('section', { class: `think-day${closed ? ' is-closed' : ''}` }, [
    el(
      'button',
      {
        class: 'think-day-head',
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
