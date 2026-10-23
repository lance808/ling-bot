/**
 * 日记 —— 已并入《记忆》页（F18）
 *
 * 「日记有淡忘系统，默认 100，每一天减 1，可手动设置为锁定」
 *
 * ## 为什么不单独占一个侧栏入口
 *
 * 日记和人格卡、会话画像是同一类东西：**它是机器人"记得什么"**。
 * 分成两个入口，用户会以为它们是两套互不相干的机制 ——
 * 于是调完日记的淡忘，又去另一页找"记忆"在哪。
 *
 * 所以本模块只导出**可嵌入的区块**，由 `views/memory.mjs` 组装成一页。
 * 它自己不再是一个页面，也不再往侧栏注册。
 *
 * ## 这一页要解释清的三件事
 *
 * 用户第一次打开会看到权重条，但不知道它意味着什么。所以页面上必须说清：
 *
 *   1. **权重不是打分** —— 它是"还记得多清楚"，每天掉一点，掉完就淡忘了
 *   2. **锁定 = 别再动它** —— 锁住的日子不再衰减，解锁后从现在重新开始算，
 *      **不补算**锁定期（锁一年再解锁直接归零不是淡忘，是惩罚）
 *   3. **淡忘不等于删除** —— 掉到 0 的日子仍在，只是默认折叠起来、
 *      也不再影响它的判断。用户可以手动展开、手动锁定
 *
 * ## 为什么权重条要显示「还剩几天」
 *
 * "87 分"这个数字对用户没有直觉。但"大概两周后淡忘"有。
 * 所以除了百分比，还要给出剩余天数的估算 —— 按当前衰减速度。
 *
 * ## 为什么锁定按钮要即时重绘
 *
 * 锁定是一次真实的磁盘写入，不是纯界面状态。不重绘的话用户点完
 * 看不出变化，会以为没生效然后反复点。
 */

import { el, card, pill } from '../render.mjs';
import { action } from '../api.mjs';

/**
 * 页面级状态（模块作用域：快照每次轮询都会整页重建）。
 */
const ui = {
  /** 是否显示已淡忘的日记 */
  showFaded: false,
  /** 每个日期的操作反馈 */
  /** @type {Record<string, {ok: boolean, text: string}>} */
  note: {},
  /** 正在处理的日期（防重复点击） */
  /** @type {Record<string, boolean>} */
  busy: {},
};

/**
 * 权重条的视觉分档。
 *
 * 分三档而不是连续渐变：用户只需要知道"还清楚 / 在淡 / 快忘了"，
 * 精确到个位的色差没有意义，反而让人以为是评分体系。
 *
 * @param {number} weight
 * @returns {{tone: string, label: string}}
 */
function weightTone(weight) {
  if (weight >= 60) return { tone: 'ok', label: '还记得' };
  if (weight >= 20) return { tone: 'warn', label: '在淡忘' };
  return { tone: 'err', label: '快忘了' };
}

/**
 * 一条日记卡片。
 *
 * @param {any} day
 * @param {{rerender?: () => void, decayPerDay: number}} opts
 * @returns {HTMLElement}
 */
function diaryCard(day, opts) {
  const weight = Number(day?.weight ?? 0);
  const { tone, label } = weightTone(weight);
  const busy = ui.busy[day.date] === true;
  const note = ui.note[day.date];

  /*
   * 剩余天数：按当前衰减速度算。
   * decayPerDay 为 0（永不衰减）时只显示"不衰减"，不要算出 Infinity 天。
   */
  const perDay = Number(opts.decayPerDay ?? 1);
  const remainText =
    day.locked === true
      ? '已锁定，不衰减'
      : perDay <= 0
        ? '不衰减'
        : weight <= 0
          ? '已淡忘'
          : `约 ${Math.ceil(weight / perDay)} 天后淡忘`;

  /** 锁 / 解锁 */
  const lockBtn = el('button', {
    class: day.locked ? 'btn btn-sm btn-primary' : 'btn btn-sm',
    type: 'button',
    text: day.locked ? '解锁' : '锁定',
    title: day.locked
      ? '解锁后从今天重新开始衰减，不会补算锁定期'
      : '锁定后这条日记不再衰减',
    disabled: busy ? '' : undefined,
    onclick: async () => {
      ui.busy[day.date] = true;
      ui.note[day.date] = { ok: true, text: day.locked ? '解锁中…' : '锁定中…' };
      opts.rerender?.();
      const r = await action(day.locked ? 'diary.unlock' : 'diary.lock', { date: day.date });
      ui.busy[day.date] = false;
      ui.note[day.date] = r?.ok
        ? { ok: true, text: day.locked ? '已解锁' : '已锁定' }
        : { ok: false, text: `${r?.code ?? ''} ${r?.message ?? '操作失败'}`.trim() };
      opts.rerender?.();
    },
  });

  /** 重新生成（锁定的不让点，避免把用户钉住的内容冲掉） */
  const regenBtn = el('button', {
    class: 'btn btn-sm',
    type: 'button',
    text: '重新生成',
    disabled: day.locked || busy ? '' : undefined,
    title: day.locked ? '先解锁才能重新生成' : '用当天的聊天重新生成这篇',
    onclick: async () => {
      ui.busy[day.date] = true;
      ui.note[day.date] = { ok: true, text: '生成中…' };
      opts.rerender?.();
      const r = await action('diary.regenerate', { date: day.date });
      ui.busy[day.date] = false;
      ui.note[day.date] = r?.ok
        ? { ok: true, text: '已重新生成' }
        : { ok: false, text: `${r?.code ?? ''} ${r?.message ?? '生成失败'}`.trim() };
      opts.rerender?.();
    },
  });

  /*
   * 权重条。
   *
   * ## 为什么用 10 档 class 而不是 inline style
   *
   * CSP 是 `style-src self`，inline style 会被直接拦截 —— 写上去
   * 在开发机可能看不出问题（某些环境下 CSP 未生效），打包后条子就是空的。
   * 项目不变量也禁止 inline style。
   *
   * 取整到 10 档是**有意的降级**：权重只表示"还记得多清楚"，
   * 每差 1 分的色差没有意义，反而会让人以为这是可以刷分的评分。
   * 所以 `w-37` 实际显示成 `w-40`，视觉上完全够用。
   */
  const bucket = Math.round(Math.max(0, Math.min(100, weight)) / 10) * 10;
  const bar = el('div', { class: 'bar-track', title: `当前权重 ${weight} / 100` }, [
    el('div', { class: `bar-fill bar-${tone} w-${bucket}` }),
  ]);

  return el('section', { class: 'card' }, [
    el('h2', {}, [
      el('span', { text: day.date }),
      el('span', { class: 'spacer-8' }),
      day.locked ? pill('已锁定', 'ok') : pill(label, /** @type {any} */ (tone)),
      day.degraded ? pill('无总结', 'dim') : null,
      day.inContext === false ? pill('不进上下文', 'dim') : null,
    ].filter(Boolean)),
    el('div', { class: 'row wrap' }, [
      el('span', { class: 'muted', text: `权重 ${weight} / 100` }),
      el('span', { class: 'muted', text: ` · ${remainText}` }),
      day.daysElapsed > 0 && !day.locked
        ? el('span', { class: 'muted', text: ` · 已过 ${day.daysElapsed} 天` })
        : null,
    ].filter(Boolean)),
    el('div', { class: 'spacer-8' }),
    bar,
    el('div', { class: 'spacer-12' }),
    el('div', { text: day.summary || '（这天没有总结）' }),
    (day.highlights?.length ?? 0) > 0
      ? el('div', {}, [
          el('div', { class: 'spacer-8' }),
          el('div', { class: 'field-label', text: '要点' }),
          el('ul', {}, (day.highlights ?? []).map((h) => el('li', { text: String(h) }))),
        ])
      : null,
    el('div', { class: 'spacer-12' }),
    el('div', { class: 'row wrap' }, [
      lockBtn,
      regenBtn,
      el('span', {
        class: 'muted',
        text: [
          day.source?.messageCount != null ? `当天 ${day.source.messageCount} 条消息` : null,
          (day.source?.convKeys?.length ?? 0) > 0 ? `${day.source.convKeys.length} 个会话` : null,
          day.model ? `模型 ${day.model}` : null,
        ].filter(Boolean).join(' · '),
      }),
    ]),
    note ? el('div', { class: note.ok ? 'ok' : 'err', text: note.text }) : null,
  ].filter(Boolean));
}

/**
 * 日记区块 —— 供《记忆》页嵌入。
 *
 * 只返回**内容**，不带页面级标题（`<h2>`）。标题由《记忆》页统一给，
 * 否则嵌进去之后会出现两级标题打架，层级看着像嵌错了地方。
 *
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderDiarySection(snap, ctx = {}) {
  const diary = snap?.diary ?? {};
  const days = Array.isArray(diary.days) ? diary.days : [];
  // 配置在顶层 snapshot.diaryConfig 里；缺省用与 DEFAULT_CONFIG 一致的值
  const cfg = snap?.diaryConfig ?? {};
  const decayPerDay = Number(cfg.decayPerDay ?? 1);
  const hiddenBelow = Number(cfg.hiddenBelowWeight ?? 0);
  const contextMin = Number(cfg.contextMinWeight ?? 60);
  const rerender = ctx.rerender;

  /*
   * 按 hiddenBelowWeight 过滤。
   *
   * 口径与后端 isHidden 一致：**等于阈值仍然可见**（`< ` 才隐藏）。
   * 两边口径不一致会让同一条日记"界面能看到但后端说已淡忘"。
   */
  const visible = days.filter((d) => ui.showFaded || !(Number(d.weight) < hiddenBelow));

  const fadedHidden = days.length - visible.length;

  /*
   * 注意：这里刻意**不套 `card()`**，直接建 section。
   *
   * 它现在是被《记忆》页嵌进去的一段，不是独立页面。`card()` 一定会
   * 渲染一个 h2（`card('')` 也会留下空 h2，把间距撑开），
   * 而外层已经有「日记与淡忘」这个标题了。
   */
  const header = el('section', { class: 'card' }, [
    el('div', {
      class: 'field-hint',
      text:
        '日记每过一天掉一点权重（默认每天 1）。权重表示"还记得多清楚"，不是打分。' +
        `掉到 0 就是淡忘了——仍然保留、不删除，但默认折叠，且不会再影响它的判断（低于 ${contextMin} 就不进上下文）。`,
    }),
    el('div', { class: 'field-hint', text:
      '锁定 = 别再动它。锁住的日子不再衰减；解锁后从今天重新开始算，**不补算**锁定期——' +
      '锁一年再解锁直接归零不是淡忘，是惩罚用户把东西留下来。' }),
    el('div', { class: 'spacer-12' }),
    el('div', { class: 'row wrap' }, [
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: ui.showFaded ? '隐藏已淡忘' : `显示已淡忘${fadedHidden > 0 ? `（${fadedHidden}）` : ''}`,
        onclick: () => {
          ui.showFaded = !ui.showFaded;
          rerender?.();
        },
      }),
      el('span', {
        class: 'muted',
        text: `共 ${days.length} 篇 · 每天 -${decayPerDay} · 低于 ${hiddenBelow} 隐藏 · 低于 ${contextMin} 不进上下文`,
      }),
    ]),
  ]);

  const body =
    days.length === 0
      ? el('section', { class: 'card' }, [
          el('div', { class: 'empty', text: '跨过零点之后会生成前一天的日记。也可以等第一次跨日后回来看。' }),
        ])
      : visible.length === 0
        ? el('section', { class: 'card' }, [
            el('div', {
              class: 'empty',
              text: `这 ${days.length} 篇都已经淡忘了（权重低于 ${hiddenBelow}）。点上面的「显示已淡忘」可以看到它们。`,
            }),
          ])
        : el('div', {}, visible.map((d) => diaryCard(d, { rerender, decayPerDay })));

  return el('div', {}, [header, el('div', { class: 'spacer-12' }), body]);
}

/**
 * 兼容导出：整块日记（含标题）。
 *
 * 目前只有测试在用。留着的意义是让"日记这块能不能独立渲染"仍然可测，
 * 而不用反过来依赖《记忆》页。
 *
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 */
export function renderDiary(snap, ctx = {}) {
  return el('div', {}, [
    el('h2', { text: '日记与淡忘' }),
    renderDiarySection(snap, ctx),
  ]);
}

/** 测试/调试用：重置页面状态 */
export function resetDiaryPageState() {
  ui.showFaded = false;
  ui.note = {};
  ui.busy = {};
}
