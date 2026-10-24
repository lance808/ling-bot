/**
 * 视觉设置页 —— 图片到底能不能进对话
 *
 * 页面名是「视觉」（不再是「视觉读图」）：这一页除了"能不能读图"，
 * 还管预算、降级与运行统计，叫"读图"会让用户以为只有那一个开关。
 *
 * ## 这一页要回答的问题
 *
 * 用户点进来通常是因为两件事之一：**它不认图**，或者**它替我花了图钱**。
 *
 * 所以页面按"先看结论、再改意图、最后看能力"的顺序排：
 *
 *   1. 实际效果   —— 现在到底会不会带图（一行，先给答案）
 *   2. 开关状态   —— 你想不想开（用户意图，可改）
 *   3. 能力探测   —— 模型能不能读（实测结论，只读）
 *   4. 图片预算   —— 一次带几张、多大、等多久（成本控制，可改）
 *   5. 运行统计   —— 最近真的提交过什么（只读）
 *
 * ## 为什么开关和探测必须分成两块
 *
 * 它们是**两份不同的状态**：
 *
 *   · 开关 = 用户想不想（`vision.enabled`）
 *   · 探测 = 模型能不能（`vision.capability`）
 *
 * 混成一块最典型的翻车方式是：模型还没探测过，界面直接写"不支持"。
 * 用户看到"不支持"就不会再试了，问题被永久掩盖 —— 而真相可能只是
 * 他没点过探测按钮，或者那次探测超时了。
 *
 * 所以本页有一条硬纪律：**`supported === null` 一律显示「未探测」，
 * 绝不显示「不支持」**。这也体现在 `effectiveKey()` 的兜底分支里。
 *
 * ## 为什么"探测能用"还要单独说一句"不等于真聊过图"
 *
 * 探测是一次独立的微型请求（发一张小图问"什么颜色"）。它成功只说明
 * 这个模型/中转站**接受图片输入**。真实回合里会不会带图，还取决于：
 * 开关开没开、图取不取得到、有没有超字节/像素/总预算、这一楼是不是
 * 已经提交过。把两者混为一谈，用户会对着"读图✓"发问"那我发图它怎么看不见"。
 *
 * ## 为什么关闭文案写"停止取图与提交"，而不是"隐藏图片"
 *
 * 关掉开关如果只是界面不显示图片，请求体里照样有 base64 —— 那是**假的关闭**：
 * 用户以为省了钱，实际一张图都没少花。所以这里把行为说死：不取图
 * （不发 `get_image`、不抓 URL）、不提交（请求体里没有 `image_url`）。
 */

import { el, card, kv, pill, clock } from '../render.mjs';
import { setting } from '../api.mjs';

/**
 * 页面级状态。
 *
 * 必须在模块作用域：快照每 2 秒轮询、每次整页重建，
 * 写在 render 里的话"保存中…/已保存"会跟着 DOM 一起消失，
 * 用户点完按钮只会看到它闪一下 —— 和他没点上没区别。
 */
const ui = {
  /** @type {Record<string, {ok: boolean, text: string}>} */
  lastSave: {},
};

/**
 * 快照没到、或后端还是旧版本时的兜底预算。
 *
 * 取的是契约 §9 的默认值。**它只用于显示**：真正生效的值永远来自
 * 快照里的 `limits`（那是运行时 `normalizeVisionConfig` 夹过一遍的结果），
 * 界面自己不做任何夹取 —— 两处都夹会出现"界面说的和实际用的不一样"。
 */
const DEFAULT_LIMITS = Object.freeze({
  maxImagesPerTurn: 3,
  maxHistoryImages: 2,
  maxBytes: 4_194_304,
  maxTotalBytes: 8_388_608,
  maxPixels: 36_000_000,
  timeoutMs: 8000,
  historyWindow: 6,
  includeQuoted: true,
  cacheTtlMs: 300_000,
});

/**
 * 四种实际效果（外加一种兜底）的文案。
 *
 * 文案取自契约 §8 的降级矩阵 —— 每一行都对应"用户该期待什么"，
 * 而不是"系统内部是什么状态"。
 */
const EFFECTIVE = {
  off: {
    tone: 'dim',
    pill: '未启用',
    text: '视觉已关闭：不取图、不提交，消息里只有 [图片] 这个占位文字。',
  },
  on: {
    tone: 'ok',
    pill: '正常读图',
    text: '读图已开启（已实测支持）：回合会真的带上图片。',
  },
  'on-unprobed': {
    tone: 'warn',
    pill: '已开启（未探测）',
    text: '读图已开启（未探测）：会先带图试一次，上游拒收就自动去图重试并记一条原因。',
  },
  'on-unsupported': {
    tone: 'err',
    pill: '已开启但模型不支持',
    text: '读图已关闭：模型已实测不支持，不会提交图片。',
  },
  /*
   * `on-but-blocked` 契约 §10 里有，但 §8 的矩阵没展开。
   * 它表示"开关开着、本回合却没带图"（预算不够、取图失败、这一楼已提交过）。
   * 不把它硬塞进上面四态之一：那会让用户以为"支持"或"不支持"是结论，
   * 而真相是这一回合被别的东西挡住了 —— 去看运行统计。
   */
  'on-but-blocked': {
    tone: 'warn',
    pill: '已开启但本回合被挡下',
    text: '读图已开启，但这一回合没带图（取图失败、超出预算或这楼已经提交过）。原因见下方运行统计。',
  },
};

/**
 * 字节 → 人话。
 *
 * 只用于**说明文字**，输入框里仍然是原始字节数：
 * 换算放在界面上，配置里存真实值，避免"4MB 到底是 4e6 还是 4MiB"这种歧义。
 *
 * @param {number} n
 */
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1024 * 1024) {
    const mb = v / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/**
 * 数字兜底：快照可能缺字段（首帧、老后端），而 `.toLocaleString()` 在
 * undefined 上会直接抛错 —— 整页白屏，用户只会说"点进去是空的"。
 *
 * @param {any} n
 * @param {number} [fallback]
 */
function num(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 毫秒 → 人话。
 *
 * @param {number} n
 */
function fmtMs(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 60_000) return `${Math.round(v / 1000)} 秒`;
  const min = v / 60_000;
  return Number.isInteger(min) ? `${min} 分钟` : `${min.toFixed(1)} 分钟`;
}

/**
 * 决定"实际效果"用哪一态。
 *
 * ## 为什么后端给了 effective 还要在前端再推一遍
 *
 * 快照的 `effective` 是后端的结论，正常情况下直接用它。
 * 但有两种情况它会缺：首帧快照还没回来、以及后端版本比界面老。
 * 那时如果界面上什么都不显示，用户会以为这一页坏了。
 *
 * 兜底推导必须与契约 §8 的矩阵**逐格一致**，尤其是最后那条：
 * `supported` 为 null / undefined（没探测过）→ `on-unprobed`，
 * **绝不能**落到 `on-unsupported`。这是本需求的核心诉求之一，
 * 所以在代码里显式写成两段，而不是靠一个 `!== true` 把两者混在一起。
 *
 * @param {any} vision
 * @returns {keyof typeof EFFECTIVE}
 */
function effectiveKey(vision) {
  const raw = vision?.effective;
  if (typeof raw === 'string' && raw in EFFECTIVE) return raw;

  if (vision?.enabled !== true) return 'off';
  const supported = vision?.capability?.supported;
  if (supported === true) return 'on';
  if (supported === false) return 'on-unsupported';
  // null / undefined / 其它任何"没结论"的值，一律按未探测处理
  return 'on-unprobed';
}

/**
 * 探测结论的三态文案。
 *
 * 三态必须分开：`true` / `false` / 没有结论。
 * 把"没有结论"显示成 `false` 就等于把"没测过"说成"测过且不支持"，
 * 而这正是本页要消灭的误导。
 *
 * @param {any} cap
 * @returns {{tone: string, label: string, hint: string}}
 */
function capabilityState(cap) {
  if (typeof cap?.supported === 'boolean') {
    return cap.supported
      ? { tone: 'ok', label: '已实测支持', hint: '实测结论：这个模型接受图片输入。' }
      : { tone: 'err', label: '已实测不支持', hint: '实测结论：这个模型拒收图片。' };
  }
  if (cap?.probed === true) {
    // 探测跑过了，但没拿到结论（超时 / 网络错误 / 返回看不懂）
    return {
      tone: 'warn',
      label: '探测过，但没有结论',
      hint: '请求跑完了却没拿到明确答案，通常超时或网络问题。换个时间再测一次。',
    };
  }
  return {
    tone: 'dim',
    label: '未探测',
    hint: '还没测过。点《模型设置》页的「探测模型」才知道它到底能不能读图。',
  };
}

/**
 * 保存一项设置并记录结果。
 *
 * 走 `setting('vision.<field>', value)`：前缀由契约 §11 固定，
 * 后端 `applyVisionSetting` 会再校验一次。界面上的范围检查只是**体验**，
 * 不是安全边界 —— 所以两边都要有。
 *
 * @param {string} field
 * @param {any} value
 * @param {() => void} [rerender]
 */
async function save(field, value, rerender) {
  ui.lastSave[field] = { ok: true, text: '保存中…' };
  rerender?.();
  const r = await setting(`vision.${field}`, value);
  ui.lastSave[field] = r?.ok
    ? { ok: true, text: '已保存' }
    : { ok: false, text: `保存失败：${r?.code ?? ''} ${r?.message ?? ''}`.trim() };
  rerender?.();
}

/**
 * 一个开关行。
 *
 * @param {object} opts
 * @returns {HTMLElement}
 */
function toggleRow({ field, label, desc, value, rerender }) {
  const box = /** @type {HTMLInputElement} */ (
    el('input', { type: 'checkbox', class: 'checkbox' })
  );
  box.checked = value === true;
  box.addEventListener('change', () => void save(field, box.checked, rerender));

  const status = ui.lastSave[field];

  return el(
    'div',
    { class: 'field' },
    [
      el('label', { class: 'row' }, [box, el('span', { class: 'field-label', text: label })]),
      el('div', { class: 'field-hint', text: desc }),
      status ? el('div', { class: status.ok ? 'ok' : 'err', text: status.text }) : null,
    ].filter(Boolean),
  );
}

/**
 * 一个数字输入行。
 *
 * ## 为什么用 min/max 当场拦，而不是提交后让后端报 E40XX
 *
 * 提交之后报错，用户已经点了一次保存、看到一条红字、还要自己算"到底多少才合法"。
 * 输入框的 min/max 让浏览器直接不给提交，最快。
 * 但**后端校验不能省**（手改 config.json、别的客户端写配置都得挡住）——
 * 界面不是安全边界，只是第一道体验。
 *
 * ## 为什么 desc 里要写"当前实际生效"
 *
 * 配置里写的值可能被运行时的硬上限夹掉（比如填 100 张）。如果界面只回显
 * 用户写的值，用户会以为真的会发 100 张。所以这里把夹取后的实际值也念出来。
 *
 * @param {object} opts
 * @returns {HTMLElement}
 */
function numberRow({ field, label, desc, value, min, max, unit = '', rerender }) {
  const input = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'number',
      class: 'text-input',
      min: String(min),
      max: String(max),
      step: '1',
    })
  );
  input.value = String(value ?? min);

  const status = ui.lastSave[field];

  return el(
    'div',
    { class: 'field' },
    [
      el('label', { class: 'field-label', text: unit ? `${label}（${unit}）` : label }),
      input,
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: '保存',
          onclick: () => {
            const n = Number(input.value);
            if (!Number.isInteger(n) || n < min || n > max) {
              ui.lastSave[field] = { ok: false, text: `必须是 ${min}–${max} 的整数` };
              rerender?.();
              return;
            }
            void save(field, n, rerender);
          },
        }),
      ]),
      el('div', { class: 'field-hint', text: desc }),
      status ? el('div', { class: status.ok ? 'ok' : 'err', text: status.text }) : null,
    ].filter(Boolean),
  );
}

/**
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderVision(snap, ctx = {}) {
  const rerender = ctx?.rerender;
  const vision = snap?.vision ?? {};
  /*
   * 预算用 `{ ...默认值, ...快照 }` 合并，而不是 `快照 ?? 默认值`。
   *
   * 后者只在整块缺失时兜底；快照里有 `limits` 但少一两个键（老后端、
   * 新加字段还没接上）时，`${undefined} 张` 会原样显示出来。
   * 那种"页面上写着 undefined"比空白更糟：用户会以为配置坏了。
   */
  const limits = { ...DEFAULT_LIMITS, ...(vision.limits ?? {}) };
  const cap = vision.capability ?? {};
  const runtime = vision.runtime ?? {};

  const key = effectiveKey(vision);
  const eff = EFFECTIVE[key];
  const capState = capabilityState(cap);

  /* -------------------------------------------------- 1. 实际效果（单独一行） */

  const effectiveBlock = el('div', { class: 'vision-effective' }, [
    card('实际效果（现在到底会不会带图）', [
      /*
       * 键名用「状态」而不是「实际效果」：卡片标题已经说了这是实际效果，
       * 键再重复一遍，用户会以为右边那个药丸和标题是两个不同的东西。
       */
      kv('状态', pill(eff.pill, /** @type {any} */ (eff.tone))),
      el('div', { class: 'field-hint', text: eff.text }),
    ]),
  ]);

  /* -------------------------------------------------- 2. 开关状态（用户意图） */

  const switchBlock = el('div', { class: 'vision-switch' }, [
    card('开关状态（你的意图）', [
      el('div', {
        class: 'field-hint',
        text:
          '这一块只回答"你想不想开"。它和下面那块「能力探测」是两份不同的状态：' +
          '开关是你要不要，探测是模型能不能。任何一边单独都决定不了实际效果。',
      }),
      el('div', { class: 'spacer-8' }),
      toggleRow({
        field: 'enabled',
        label: '自动取图并把图片提交给模型',
        desc:
          '关掉之后并不是"只是界面上不显示图片"：代码不再去取图（不发 get_image、不抓 URL），' +
          '也不会把图片塞进请求体；消息文本里仍然只有 [图片] 这个占位文字。' +
          '换句话说，关掉就是真的不读图，也不会因为图片多花 token。',
        value: vision.enabled === true,
        rerender,
      }),
    ]),
  ]);

  /* -------------------------------------------------- 3. 能力探测（实测结论） */

  const capRows = [
    kv('探测结论', pill(capState.label, /** @type {any} */ (capState.tone))),
    kv('探测的模型', el('span', { class: 'mono', text: cap.model || '—' })),
    kv('判断依据', el('span', { class: 'muted', text: cap.basis || '—' })),
    kv('探测时间', el('span', { class: 'muted', text: cap.probedAt ? String(cap.probedAt).replace('T', ' ').slice(0, 19) : '—' })),
  ];
  if (cap.detail) {
    capRows.push(kv('详情', el('span', { class: 'muted', text: String(cap.detail) })));
  }

  const capBlock = el('div', { class: 'vision-cap' }, [
    card('能力探测结果（模型的实测能力）', [
      el('div', { class: 'list' }, capRows),
      el('div', { class: 'field-hint', text: capState.hint }),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'field-hint' }, [
        el('div', {
          text:
            '「未探测」不等于「不支持」：探测超时、网络错误都会让结论落空，' +
            '而模型本身可能完全支持。所以这里没结论时显示「未探测」，不会写成不支持。',
        }),
        el('div', {
          text:
            '「探测可用」也不等于「真实聊天已经读过图」：探测是一次独立的微型请求，' +
            '它只证明这个模型/中转站接受图片输入。真回合里会不会带图，还要看开关、' +
            '取图是否成功、有没有超预算、这一楼是不是已经提交过。',
        }),
      ]),
    ]),
  ]);

  /* -------------------------------------------------- 4. 图片预算（成本控制） */

  const budgetBlock = el('div', { class: 'vision-budget' }, [
    card('图片预算（每回合的上限）', [
      el('div', {
        class: 'field-hint',
        text:
          '图片的成本是双份的：token 变多，而且要先把图取回来（可能失败、可能很慢）。' +
          '所以每一条都是一道闸门。下面每项说明里写的是「夹取后实际生效的值」——' +
          '配置里写得比硬上限更宽松时，运行时会把值夹回去，这里不会骗你。',
      }),
      el('div', { class: 'spacer-8' }),
      numberRow({
        field: 'maxImagesPerTurn',
        label: '每回合最多提交几张（本轮消息）',
        desc: `只算本轮新消息里的图。当前实际生效：${limits.maxImagesPerTurn} 张；硬上限 4 张。`,
        value: limits.maxImagesPerTurn,
        min: 1,
        max: 4,
        unit: '张',
        rerender,
      }),
      numberRow({
        field: 'maxHistoryImages',
        label: '历史 / 引用图片最多提交几张',
        desc:
          `当前实际生效：${limits.maxHistoryImages} 张；硬上限 3 张，0 = 完全不补历史图。` +
          '已经提交过的楼层会被记住，下一回合不会重复发同一张。',
        value: limits.maxHistoryImages,
        min: 0,
        max: 3,
        unit: '张',
        rerender,
      }),
      numberRow({
        field: 'maxBytes',
        label: '单张图片字节上限',
        desc: `当前实际生效：${fmtBytes(limits.maxBytes)}；默认 4 MB。超过就跳过这张并记一条原因。`,
        value: limits.maxBytes,
        min: 1,
        max: 8_388_608,
        unit: '字节',
        rerender,
      }),
      numberRow({
        field: 'maxTotalBytes',
        label: '一回合图片总字节上限',
        desc:
          `当前实际生效：${fmtBytes(limits.maxTotalBytes)}；默认 8 MB。` +
          '超了从最旧的开始丢，不会因为一张大图把整个请求撑爆。',
        value: limits.maxTotalBytes,
        min: 1,
        max: 16_777_216,
        unit: '字节',
        rerender,
      }),
      numberRow({
        field: 'maxPixels',
        label: '单张图片像素上限',
        desc:
          `当前实际生效：${num(limits.maxPixels).toLocaleString('en-US')} 像素；默认 3600 万。` +
          '既防超大图被上游直接 413，也防解压炸弹。',
        value: limits.maxPixels,
        min: 1,
        max: 72_000_000,
        unit: '像素',
        rerender,
      }),
      numberRow({
        field: 'timeoutMs',
        label: '单张图取图超时',
        desc:
          `当前实际生效：${fmtMs(limits.timeoutMs)}；默认 8 秒。` +
          '一轮聊天不能被一张图无限拖住：超时就当这张取不到，其余照常往下走。' +
          '注意运行时的硬上限是 15 秒 —— 填得更大能保存，但会按 15 秒生效（上面那行就是夹取后的值）。',
        value: limits.timeoutMs,
        min: 1000,
        max: 30_000,
        unit: '毫秒',
        rerender,
      }),
      numberRow({
        field: 'cacheTtlMs',
        label: '图片缓存 TTL',
        desc:
          `当前实际生效：${fmtMs(limits.cacheTtlMs)}；默认 5 分钟。` +
          '只缓存在内存里（绝不把 base64 写进会话文件），过期即失效、不主动刷新 —— ' +
          '临时 URL 过长反而会取到已经失效的图。硬上限同为 5 分钟。',
        value: limits.cacheTtlMs,
        min: 60_000,
        max: 3_600_000,
        unit: '毫秒',
        rerender,
      }),
      numberRow({
        field: 'historyWindow',
        label: '历史回看楼层数',
        desc:
          `当前实际生效：${limits.historyWindow} 楼；硬上限 8 楼，0 = 不回看历史楼层。` +
          '只在这个范围内找没提交过的图；范围越大越可能带上旧图，token 也越多。',
        value: limits.historyWindow,
        min: 0,
        max: 8,
        unit: '楼',
        rerender,
      }),
      toggleRow({
        field: 'includeQuoted',
        label: '引用消息里的图片也带上',
        desc:
          '对方发图后引用它提问时，图就在被引用的那条消息里。不带的话模型只能看到"你引用了某条消息"。' +
          '关掉可以省一点 token，代价是"这张图你觉得怎么样"这类问法答不对。',
        value: limits.includeQuoted !== false,
        rerender,
      }),
    ]),
  ]);

  /* -------------------------------------------------- 5. 运行统计（只读） */

  const codes = Array.isArray(runtime.lastCodes) ? runtime.lastCodes.filter(Boolean) : [];
  const notes = Array.isArray(runtime.lastNotes) ? runtime.lastNotes.filter(Boolean) : [];

  const runtimeRows = [
    kv('带图回合数', String(Number(runtime.turnsWithImages) || 0)),
    kv('已提交图片张数', String(Number(runtime.imagesSubmitted) || 0)),
    kv('已提交字节数', fmtBytes(runtime.bytesSubmitted)),
    kv('因预算/失败跳过', String(Number(runtime.skipped) || 0)),
    kv('最近失败码', codes.length > 0 ? el('span', { class: 'mono err', text: codes.join(' ') }) : el('span', { class: 'muted', text: '—' })),
    kv('最近一次', el('span', { class: 'muted', text: clock(runtime.lastAt) })),
  ];

  const runtimeBlock = el('div', { class: 'vision-runtime' }, [
    card('运行统计（这一版真的提交过什么）', [
      el('div', { class: 'list' }, runtimeRows),
      notes.length > 0
        ? el('div', { class: 'field-hint' }, [
            el('div', { text: '最近一回合的说明：' }),
            ...notes.map((n) => el('div', { text: `· ${n}` })),
          ])
        : el('div', { class: 'field-hint', text: '还没有记录 —— 要么没开，要么还没遇到需要带图的消息。' }),
      el('div', { class: 'field-hint', text: '统计只反映本进程启动以来的情况，重启后从零开始。' }),
    ]),
  ]);

  return el('div', { class: 'vision-page' }, [
    effectiveBlock,
    switchBlock,
    capBlock,
    budgetBlock,
    runtimeBlock,
  ]);
}

/** 仅供测试：清空保存结果，避免用例之间互相影响 */
export function resetVisionPageState() {
  for (const k of Object.keys(ui.lastSave)) delete ui.lastSave[k];
}
