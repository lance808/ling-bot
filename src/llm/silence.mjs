/**
 * 静音闸门 —— F20「闭嘴」
 *
 * 四种来源，任一命中就闭嘴：
 *
 *   global        全局开关      —— 「我现在不想让它说话」
 *   conversation  按会话静音    —— 只让某个群闭嘴，其它照常
 *   schedule      时段静默      —— 例如 23:00–08:00 不回复
 *   temporary     指令触发      —— 在群里说「闭嘴 2h」，到点自动恢复
 *
 * ## 为什么是「静音闸门」而不是又往 wake 里塞一个开关
 *
 * `wake` 回答的是「什么消息值得起一个回合」——那是一个**语义判断**：
 * 这条消息像不像在叫它、值不值得参与。
 *
 * 静音回答的是「现在根本不许说话」——那是一个**绝对压制**，
 * 优先于所有语义判断。把两者混在一起会出一个很坏的结果：
 * 用户设了静音，但某条消息「特别像在叫它」，于是它还是开口了。
 * 那静音就是假的。
 *
 * 所以闸门必须**独立于** wake，并且排在它**前面**。
 *
 * ## 严格静音：@ 也穿透不了
 *
 * 这条是用户明确选的，也符合「闭嘴」这个词的直觉。
 * 半截静音（@ 还能叫醒）会让人不敢用它 —— 因为群里别人狂 @ 时，
 * 噪音照旧，而用户以为自己已经让它安静了。
 *
 * 代价是「@ 它也没反应」，所以有下面这条补偿。
 *
 * ## 解除指令必须不受静音影响（否则会把自己锁死）
 *
 * 如果静音闸门连「说话」「解除静音」这种指令也挡，用户一旦开口让它闭嘴，
 * 就**再也没有办法**用 QQ 叫它回来 —— 只能去桌面端改配置。
 * 那是设计缺陷，不是安全特性。
 *
 * 所以顺序是固定的：
 *
 *   1. 先看是不是管理员的静音/解除指令  → 是就直接处理（不看静音状态）
 *   2. 再看静音闸门                    → 命中就闭嘴
 *   3. 最后才走正常的触发判定
 *
 * ## 时段静默为什么要处理跨午夜
 *
 * 「23:00–08:00」是最常见的写法，而它是**跨日**的：
 * start > end 时区间是 [start, 24:00) ∪ [00:00, end)。
 * 按 start < end 的普通方式写会在午夜整点翻转成「全天静音」或「全天不静音」，
 * 而用户第二天早上会发现它一句话都不说、或者半夜一直在说。
 *
 * ## 时区
 *
 * 一律用**本地时区**（和日记的日期键同口径）。用户说的「晚上 11 点」是他手表上的 11 点。
 */

/**
 * 静音来源。
 *
 * 这些字符串会进日志和界面，所以用有意义的英文而不是数字。
 */
export const SILENCE_REASON = Object.freeze({
  NONE: 'none',
  GLOBAL: 'global',
  CONVERSATION: 'conversation',
  SCHEDULE: 'schedule',
  TEMPORARY: 'temporary',
});

/** 时间段格式：`HH:MM`，只接受两位补零 */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * 把 `HH:MM` 解析成「当天第几分钟」。
 *
 * 不接受 `7:00` 这种单位数写法：同一时刻两种写法会让去重和比较都变复杂，
 * 而配置是手写的，宁可在这里报错让人改对。
 *
 * @param {unknown} value
 * @returns {number | null} 非法返回 null
 */
export function parseClock(value) {
  const m = TIME_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 当前时刻在本地是第几分钟。
 *
 * @param {number} now 毫秒时间戳
 * @returns {number}
 */
export function minutesOfDay(now) {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 判断某一分钟是否落在静默时段内。
 *
 * ## 三种情况
 *
 *   start < end   普通区间 [start, end)
 *   start > end   跨午夜：[start, 24:00) ∪ [00:00, end)
 *   start == end  视为**不生效**，而不是全天
 *
 * 最后一条是刻意的：`23:00–23:00` 手写出来多半是想表达别的东西，
 * 把它理解成「全天静音」会让机器人整天不说话，而用户根本不知道发生了什么。
 * 不生效至少是"没起作用"，不是"起了个隐蔽的副作用"。
 *
 * @param {number} minute 当天第几分钟
 * @param {{start: string, end: string}} window
 * @returns {boolean}
 */
export function inWindow(minute, window) {
  const start = parseClock(window?.start);
  const end = parseClock(window?.end);
  if (start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  // 跨午夜
  return minute >= start || minute < end;
}

/**
 * 当前是否落在任一时段里。
 *
 * @param {number} now
 * @param {Array<{start: string, end: string}>} windows
 * @returns {{hit: boolean, window: {start: string, end: string} | null}}
 */
export function matchWindow(now, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return { hit: false, window: null };
  const minute = minutesOfDay(now);
  for (const w of windows) {
    if (inWindow(minute, w)) return { hit: true, window: w };
  }
  return { hit: false, window: null };
}

/**
 * 静音闸门。
 *
 * 只有**临时静音**（指令触发）有状态，其余三种都从配置现算 ——
 * 所以这个对象重启后不需要恢复任何东西，持久配置本身就在文件里。
 */
export class SilenceGate {
  /**
   * 临时静音：`convKey -> 截止时刻（毫秒）`。
   *
   * 只放内存：重启后临时静音失效。这是有意的 ——
   * 「我让它闭嘴两小时」不应该跨越一次重启还继续生效，
   * 用户重启程序往往就是想让它恢复。永久静音请用全局开关。
   *
   * @type {Map<string, number>}
   */
  #temporary = new Map();
  /** @type {() => number} */
  #now;
  /** 最近一次被自动清理的条数（诊断用） */
  #lastSwept = 0;

  /** @param {{now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.#now = typeof opts.now === 'function' ? opts.now : Date.now;
  }

  /**
   * 现在能不能说话。
   *
   * 返回对象里带 `reason` 和 `detail`：界面上「它为什么不说话」
   * 必须能解释清楚，否则用户只能猜。
   *
   * @param {string} convKey
   * @param {object} config 完整配置（读 `config.silence`）
   * @param {number} [at]
   * @returns {{silent: boolean, reason: string, detail: string, until: number | null}}
   */
  check(convKey, config, at) {
    const now = Number.isFinite(at) ? /** @type {number} */ (at) : this.#now();
    const cfg = config?.silence ?? {};

    // 1) 全局：优先级最高，也最容易解释
    if (cfg.all === true) {
      return { silent: true, reason: SILENCE_REASON.GLOBAL, detail: '全局静音已开启', until: null };
    }

    /*
     * 2) 按会话。
     *
     * 放在时段之前：用户点名让某个群闭嘴，比"现在是夜间"更具体，
     * 日志里写"这个群被静音了"比"处于静默时段"更有解释力。
     */
    const convKeys = Array.isArray(cfg.convKeys) ? cfg.convKeys : [];
    if (convKeys.some((k) => String(k) === String(convKey))) {
      return {
        silent: true,
        reason: SILENCE_REASON.CONVERSATION,
        detail: `会话 ${convKey} 已被静音`,
        until: null,
      };
    }

    // 3) 临时（指令触发）
    const until = this.#temporary.get(convKey);
    if (Number.isFinite(until)) {
      if (until > now) {
        const left = Math.ceil((until - now) / 1000);
        return {
          silent: true,
          reason: SILENCE_REASON.TEMPORARY,
          detail: `临时静音中，还剩约 ${left} 秒`,
          until,
        };
      }
      // 已过期，顺手清掉
      this.#temporary.delete(convKey);
    }

    // 4) 时段
    const w = matchWindow(now, cfg.windows);
    if (w.hit) {
      return {
        silent: true,
        reason: SILENCE_REASON.SCHEDULE,
        detail: `处于静默时段 ${w.window?.start}–${w.window?.end}`,
        until: null,
      };
    }

    return { silent: false, reason: SILENCE_REASON.NONE, detail: '', until: null };
  }

  /**
   * 让某个会话临时闭嘴。
   *
   * @param {string} convKey
   * @param {number} ms 时长（毫秒）
   * @param {number} [at]
   * @returns {{ok: boolean, until: number, ms: number}}
   */
  mute(convKey, ms, at) {
    const now = Number.isFinite(at) ? /** @type {number} */ (at) : this.#now();
    const span = Math.max(0, Math.round(Number(ms) || 0));
    const until = now + span;
    this.#temporary.set(String(convKey), until);
    return { ok: true, until, ms: span };
  }

  /**
   * 解除某个会话的临时静音。
   *
   * 只清临时的。全局开关和按会话静音在配置里，属于用户显式设置，
   * 不该被一条聊天指令悄悄改掉 —— 那会让"我明明在配置里关着它，怎么又说话了"
   * 变成一件无法解释的事。
   *
   * @param {string} convKey
   * @returns {{ok: boolean, wasSilent: boolean}}
   */
  unmute(convKey) {
    const key = String(convKey);
    const had = this.#temporary.has(key);
    this.#temporary.delete(key);
    return { ok: true, wasSilent: had };
  }

  /**
   * 当前临时静音的会话清单（界面展示用）。
   *
   * @param {number} [at]
   * @returns {Array<{convKey: string, until: number, leftMs: number}>}
   */
  listTemporary(at) {
    const now = Number.isFinite(at) ? /** @type {number} */ (at) : this.#now();
    const out = [];
    for (const [convKey, until] of this.#temporary) {
      if (until > now) out.push({ convKey, until, leftMs: until - now });
      else this.#temporary.delete(convKey);
    }
    return out.sort((a, b) => a.until - b.until);
  }

  /** 清空所有临时静音（测试与「全部恢复」用） */
  clear() {
    const n = this.#temporary.size;
    this.#temporary.clear();
    this.#lastSwept = n;
    return n;
  }

  /** 诊断：上一次 clear 掉了几个 */
  get lastSwept() {
    return this.#lastSwept;
  }
}

/* ---------------------------------------------------------------- 指令 */

/**
 * 「闭嘴」指令的解析结果。
 *
 * @typedef {{kind: 'mute', ms: number} | {kind: 'unmute'} | null} SilenceCommand
 */

/** 默认闭嘴时长：30 分钟。太短没意义，太长容易忘了自己开过 */
export const DEFAULT_MUTE_MS = 30 * 60 * 1000;

/** 单次闭嘴的上限：24 小时。再长请用全局开关 */
export const MAX_MUTE_MS = 24 * 60 * 60 * 1000;

/** 「闭嘴」类动词 */
const MUTE_WORDS = ['闭嘴', '静音', '安静', '别说了', '禁言'];
/** 「恢复」类动词 */
const UNMUTE_WORDS = ['说话', '解除静音', '取消静音', '恢复', '可以说了'];

/**
 * 解析时长参数。
 *
 * 支持：`30`（分钟）、`30m`、`90s`、`2h`
 *
 * 不给单位时按**分钟**算 —— 这是人写「闭嘴30」时最自然的意思。
 *
 * @param {string} raw
 * @returns {number | null} 毫秒；无法解析返回 null
 */
export function parseDuration(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? 'm'; // 默认分钟
  const factor =
    unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = Math.round(n * factor);
  // 上限内夹住：写「闭嘴 999d」不该真的闭嘴三年
  return Math.min(ms, MAX_MUTE_MS);
}

/**
 * 解析一条文本是不是静音指令。
 *
 * ## 为什么要求**整句**匹配
 *
 * 只在句首或句中「出现」闭嘴两个字不算 —— 群里有人聊天说
 * 「你别闭嘴啊我还没听完」不该让它把自己静音。
 * 所以要求指令词之后除了时长参数没有别的内容。
 *
 * @param {string} text
 * @returns {SilenceCommand}
 */
export function parseSilenceCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  // 去掉常见的 @ 前缀与首尾标点
  const cleaned = raw
    .replace(/^@\S+\s*/, '')
    .replace(/^[\[\【(（]?\s*/, '')
    .replace(/[\s。.!！?？~～]+$/, '')
    .trim();
  if (!cleaned) return null;

  for (const w of UNMUTE_WORDS) {
    if (cleaned === w) return { kind: 'unmute' };
  }

  for (const w of MUTE_WORDS) {
    if (cleaned === w) return { kind: 'mute', ms: DEFAULT_MUTE_MS };
    if (cleaned.startsWith(w)) {
      const rest = cleaned.slice(w.length).trim();
      if (!rest) return { kind: 'mute', ms: DEFAULT_MUTE_MS };
      const ms = parseDuration(rest);
      // 动词后面跟了解析不出来的东西 → 不是指令（是正常聊天）
      if (ms === null) return null;
      return { kind: 'mute', ms };
    }
  }

  return null;
}
