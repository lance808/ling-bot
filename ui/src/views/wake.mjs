/**
 * 唤醒区块 —— F7（嵌在《语言》页的「唤醒」分栏里）
 *
 * ## 「唤醒」在这里是什么意思
 *
 * 参考项目 qq-bridge 是「AI 自主潜水」：AI 决定何时睡，桥接按条件把它叫醒。
 * **Ling-bot 不是这个模型**。这里是「收到一条消息 → 判定它够不够格起一个回合」。
 *
 * 注意：这块**不是独立页面**，它和「分条」「静音」一起组成了《语言》页。
 * 三者是同一件事的三个侧面（该不该开口 / 开口怎么说 / 现在能不能说），
 * 所以侧栏只留一个入口。页内分栏见 `ui/src/views/language.mjs`。
 *
 * 所以这一块的所有字段映射关系是：
 *
 *   触发条件（@ / 名字 / 提问 / 拍一拍 / 指定群友 / 关键词）
 *       → 这类消息要不要让它说话
 *   「潜水时长」→ 两次**主动发言**之间的最小间隔
 *   「唤醒频率」→ 每会话每分/每小时最多起几个回合
 *
 * 照抄那边的文案会做出一个"机器人自己决定什么时候不说话"的界面，
 * 而用户真正要调的是"什么消息值得回应"。
 *
 * ## 页面上为什么把「硬开关」和「推荐值」分开
 *
 * 这是用户贴的参数面里最容易被搞混的地方：同一张面板上同时有
 * 「推荐值（AI 可以不遵守）」和「硬限制」。两者语义完全不同：
 *
 *   · 硬开关 —— 关掉就是不触发，代码里就是这么判断的
 *   · 推荐值 —— 只是给 AI 的一个提示，它有权不照做
 *
 * 混在一起展示，用户会以为"我把推荐概率调成 0 它就闭嘴了"，
 * 但实际上硬限制在 proactive 那边。所以页面必须显式说明这一点。
 */

import { el, card } from '../render.mjs';
import { setting } from '../api.mjs';

/**
 * 页面级状态。
 *
 * 必须活在模块作用域：快照每 2 秒轮询、每次整页重建，
 * 局部变量会跟着 DOM 一起消失，用户刚敲进去的关键词就没了。
 */
const ui = {
  /** 关键词/群友输入框的即时反馈 */
  /** @type {Record<string, {tone: string, text: string}>} */
  hint: {},
  /** 各字段上一次保存的结果 */
  /** @type {Record<string, {ok: boolean, text: string}>} */
  lastSave: {},
};

/**
 * 保存一项设置并记录结果。
 *
 * @param {string} field
 * @param {any} value
 * @param {() => void} [rerender]
 */
async function save(field, value, rerender) {
  ui.lastSave[field] = { ok: true, text: '保存中…' };
  rerender?.();
  const r = await setting(`wake.${field}`, value);
  ui.lastSave[field] = r?.ok
    ? { ok: true, text: '已保存' }
    : { ok: false, text: `保存失败：${r?.code ?? ''} ${r?.message ?? ''}`.trim() };
  rerender?.();
}

/**
 * 一个开关行。
 *
 * @param {object} opts
 * @param {string} opts.field
 * @param {string} opts.label
 * @param {string} opts.desc 为什么需要它
 * @param {boolean} opts.value
 * @param {() => void} [opts.rerender]
 * @returns {HTMLElement}
 */
function toggleRow({ field, label, desc, value, rerender }) {
  const box = /** @type {HTMLInputElement} */ (
    el('input', { type: 'checkbox', class: 'checkbox' })
  );
  box.checked = value === true;
  box.addEventListener('change', () => void save(field, box.checked, rerender));

  const status = ui.lastSave[field];

  return el('div', { class: 'field' }, [
    el('label', { class: 'row' }, [
      box,
      el('span', { class: 'field-label', text: label }),
    ]),
    el('div', { class: 'field-hint', text: desc }),
    status
      ? el('div', { class: status.ok ? 'ok' : 'err', text: status.text })
      : null,
  ].filter(Boolean));
}

/**
 * 一个数字输入行。
 *
 * @param {object} opts
 * @param {string} opts.field
 * @param {string} opts.label
 * @param {string} opts.desc
 * @param {number} opts.value
 * @param {string} [opts.unit]
 * @param {() => void} [opts.rerender]
 * @returns {HTMLElement}
 */
function numberRow({ field, label, desc, value, unit = '', rerender }) {
  const input = /** @type {HTMLInputElement} */ (
    el('input', { type: 'number', class: 'text-input', min: '0', step: '1' })
  );
  input.value = String(value ?? 0);
  input.addEventListener('change', () => {
    const n = Number(input.value);
    void save(field, Number.isFinite(n) ? n : 0, rerender);
  });

  const status = ui.lastSave[field];

  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: unit ? `${label}（${unit}）` : label }),
    input,
    el('div', { class: 'field-hint', text: desc }),
    status ? el('div', { class: status.ok ? 'ok' : 'err', text: status.text }) : null,
  ].filter(Boolean));
}

/**
 * 标签式列表编辑器（关键词 / 指定群友共用）。
 *
 * ## 为什么做成「先加进列表、点保存才提交」
 *
 * 每敲一个字符就写配置会让后端反复重新判定，而且中途会有半截输入
 * （关键词 "小鲸" 还没打完，就已经在拦消息了）。所以先编辑本地，
 * 点保存才提交。
 *
 * @param {object} opts
 * @param {string} opts.field
 * @param {string} opts.label
 * @param {string} opts.placeholder
 * @param {string} opts.desc
 * @param {string[]} opts.items
 * @param {(s: string) => boolean} [opts.validate]
 * @param {() => void} [opts.rerender]
 * @returns {HTMLElement}
 */
function listEditor({ field, label, placeholder, desc, items, validate, rerender }) {
  const list = [...(items ?? [])];

  const tags = list.map((item) =>
    el('span', { class: 'pill' }, [
      el('span', { text: item }),
      el('button', {
        class: 'btn btn-xs',
        type: 'button',
        text: '×',
        title: `移除 ${item}`,
        onclick: () => {
          const next = list.filter((x) => x !== item);
          void save(field, next, rerender);
        },
      }),
    ]),
  );

  const input = /** @type {HTMLInputElement} */ (
    el('input', { type: 'text', class: 'text-input', placeholder, autocomplete: 'off' })
  );

  const hint = ui.hint[field];
  const say = el('div', {
    class: hint ? (hint.tone === 'ok' ? 'ok' : hint.tone === 'err' ? 'err' : 'field-hint') : 'field-hint',
    text: hint ? hint.text : '',
  });

  /** 一次粘多个（逗号/空格/换行分隔）—— 真实场景是从别处复制一串 */
  const submit = () => {
    const raw = input.value.trim();
    if (!raw) return;
    const parts = raw.split(/[\s,，;；]+/).filter(Boolean);
    const bad = parts.filter((p) => (validate ? !validate(p) : false));
    if (bad.length > 0) {
      ui.hint[field] = { tone: 'err', text: `这些值不合法：${bad.join('、')}` };
      rerender?.();
      return;
    }
    const dedup = [...new Set([...list, ...parts])];
    if (dedup.length === list.length) {
      ui.hint[field] = { tone: 'hint', text: '已经在列表里了' };
      rerender?.();
      return;
    }
    ui.hint[field] = { tone: 'ok', text: `已加入 ${dedup.length - list.length} 项` };
    input.value = '';
    void save(field, dedup, rerender);
  };

  input.addEventListener('keydown', (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  const status = ui.lastSave[field];

  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: label }),
    tags.length > 0 ? el('div', { class: 'row wrap' }, tags) : el('div', { class: 'field-hint', text: '（空）' }),
    el('div', { class: 'row' }, [
      input,
      el('button', { class: 'btn btn-sm', type: 'button', text: '添加', onclick: submit }),
    ]),
    el('div', { class: 'field-hint', text: desc }),
    say,
    status ? el('div', { class: status.ok ? 'ok' : 'err', text: status.text }) : null,
  ].filter(Boolean));
}

/**
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderWake(snap, ctx = {}) {
  const wake = snap?.wake ?? {};
  const rerender = ctx.rerender;

  /* ------------------------------------------------------------ 触发条件 */

  const triggers = card('触发条件', [
    el('div', {
      class: 'field-hint',
      text: '每个开关都是硬开关：关掉就是不触发，不存在"关掉之后走默认值"。',
    }),
    el('div', { class: 'spacer-8' }),
    toggleRow({
      field: 'atMention',
      label: '被 @ 或引用时唤醒',
      desc: '群里有人 @ 你、或引用了你上一句话时起一个回合。这是最可靠的"在叫我"信号。',
      value: wake.atMention !== false,
      rerender,
    }),
    toggleRow({
      field: 'nameMention',
      label: '被叫名字时唤醒',
      desc: `文本里出现人格卡的名字时触发。注意：名字太常见会误触发（比如名字叫"小"，那几乎每句都命中）。`,
      value: wake.nameMention !== false,
      rerender,
    }),
    toggleRow({
      field: 'question',
      label: '被提问时唤醒',
      desc:
        '判定刻意保守：只认问号和句尾疑问助词（吗/呢/吧），"今天好热"这种陈述句不会触发。' +
        '原因是活跃群里陈述句占绝大多数，判定放宽会让它变成刷屏源。',
      value: wake.question !== false,
      rerender,
    }),
    toggleRow({
      field: 'poke',
      label: '被拍一拍时唤醒',
      desc: '拍一拍是**弱触发**：会看一眼，但不会插队到正在跑的回合前面 —— 它太轻，群里还常连环互拍。',
      value: wake.poke !== false,
      rerender,
    }),
    listEditor({
      field: 'speakerIds',
      label: '指定群友发言即唤醒',
      placeholder: 'QQ 号，可一次粘多个',
      desc:
        '这些号里任意一位发言就触发。适合"我在等某个人回复"。"' +
        '这是强触发（和 @ 同级），因为用户显式点名说明那条消息有确定的重要性。',
      items: wake.speakerIds ?? [],
      // QQ 号：5~12 位数字（和闸门的白名单校验同口径）
      validate: (s) => /^\d{5,12}$/.test(s),
      rerender,
    }),
    listEditor({
      field: 'keywords',
      label: '触发关键词',
      placeholder: '关键词，可一次粘多个',
      desc: '文本里包含任意一个关键词就触发。关键词在同一会话里是弱触发（不插队）。',
      items: wake.keywords ?? [],
      rerender,
    }),
  ]);

  /* ------------------------------------------------------------ 频率硬限 */

  const limits = card('频率硬限', [
    el('div', {
      class: 'field-hint',
      text:
        '这些是**硬限制**：超限时直接不触发（不是排队）。' +
        '排队的语义是"稍后回复"，而这里的问题是"不该回"——一个活跃群每分钟几十条消息，每条都起回合就是刷屏加烧钱。',
    }),
    el('div', { class: 'spacer-8' }),
    numberRow({
      field: 'maxWakePerMinute',
      label: '每分钟最多唤醒次数',
      desc: '0 = 不限制。想让它完全闭嘴该关掉触发条件或主动发言，而不是设成 0。',
      value: wake.maxWakePerMinute ?? 6,
      unit: '次/分钟',
      rerender,
    }),
    numberRow({
      field: 'maxWakePerHour',
      label: '每小时最多唤醒次数',
      desc: '0 = 不限制。和上面那条是独立生效的，任一条超了都拦。',
      value: wake.maxWakePerHour ?? 60,
      unit: '次/小时',
      rerender,
    }),
    numberRow({
      field: 'minSleepMs',
      label: '两次主动发言的最小间隔',
      desc: '主动插话的硬下限，不看概率。这是"潜水时长"在本项目里的真实含义。',
      value: wake.minSleepMs ?? 60000,
      unit: '毫秒',
      rerender,
    }),
    numberRow({
      field: 'batchWindowMs',
      label: '多条消息合并窗口',
      desc:
        '同一会话在这段时间内的连续消息合并成一个回合，而不是每条一个。' +
        '治"回复混乱"的第二道保险——群里连发三条短句时不该触发三个回合。',
      value: wake.batchWindowMs ?? 8000,
      unit: '毫秒',
      rerender,
    }),
    numberRow({
      field: 'noActionLimit',
      label: '连续无产出后自动降频',
      desc: '连续多少次回合没有任何产出（没说话）就自动降低主动发言频率。',
      value: wake.noActionLimit ?? 3,
      unit: '次',
      rerender,
    }),
  ]);

  /* ------------------------------------------------------------ 推荐值 */

  const recommended = card('推荐值（仅供参考）', [
    el('div', {
      class: 'field-hint',
      text:
        '⚠️ 这一组和上面的「硬限制」语义**完全不同**：' +
        '推荐值只是给 AI 的一个提示，它有权不遵守；' +
        '硬限制是代码里真的会拦。把推荐概率调成 0 不等于让它闭嘴——那要改 hard 下限或关掉主动发言。',
    }),
    el('div', { class: 'spacer-8' }),
    numberRow({
      field: 'recommendedProbability',
      label: '推荐主动发言概率',
      desc: '0~1 之间。仅作为提示写进上下文，实际概率上限由「模型设置 → 主动发言」那条硬限制决定。',
      value: wake.recommendedProbability ?? 0.05,
      unit: '0~1',
      rerender,
    }),
    el('div', { class: 'field-hint' }, [
      el('div', { text: '「潜水时长」在这里映射成两次主动发言的最小间隔，不是"AI 自己决定睡多久"。' }),
      el('div', { text: '「唤醒频率」映射成每会话每分/每小时最多起几个回合，不是"桥接多久叫它一次"。' }),
    ]),
  ]);

  /* ------------------------------------------------------------ 运行态 */

  const runtime = wake.runtime && typeof wake.runtime === 'object' ? wake.runtime : {};
  const runtimeKeys = Object.keys(runtime);
  const runtimeCard = card('当前唤醒活动', [
    el('div', {
      class: 'field-hint',
      text: '这一分钟 / 这一小时各会话已经起了几个回合。超限时会在这里看到它停在上限。',
    }),
    el('div', { class: 'spacer-8' }),
    runtimeKeys.length === 0
      ? el('div', { class: 'empty', text: '还没有会话活动' })
      : el('div', {}, runtimeKeys.map((k) =>
          el('div', { class: 'row' }, [
            el('span', { text: k }),
            el('span', {
              class: 'muted',
              text: ` 最近一分钟 ${runtime[k]?.lastMinute ?? 0} 次 · 最近一小时 ${runtime[k]?.lastHour ?? 0} 次`,
            }),
          ]),
        )),
  ]);

  return el('div', {}, [
    el('div', { class: 'split' }, [triggers, limits]),
    el('div', { class: 'spacer-12' }),
    el('div', { class: 'split' }, [recommended, runtimeCard]),
  ]);
}
