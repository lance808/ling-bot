/**
 * 日记淡忘 —— 权重衰减
 *
 * 每条日记有 0~100 的权重，每过一个自然日掉 1 分，掉到 0 就算彻底忘了。
 * 用户可以把某条日记「钉住」（locked）豁免衰减。
 *
 * ## 为什么是派生计算，而不是每天批量改写文件
 *
 * 落盘只存 weightBase / weightBaseDate / locked / lockedWeight / lockedDate，
 * 读的时候按日期差现算。换来两件事：
 *
 *   1. 程序没开也照常衰减 —— 定时任务断了不会让所有日记停在一周前的分数上
 *   2. 不用每天写盘 —— 一次写盘就是一次可能写到一半崩掉的机会，能省就省
 *
 * 代价是：任何读权重的地方都必须走 computeWeight()，不能直接读 weightBase。
 * 那是「写下那天」的快照，不是当前值。这条是整块设计唯一容易踩的坑，
 * 所以下面所有函数只认「记录 + now」这一种入参，不在内部偷读系统时间。
 *
 * ## 为什么日期键必须是本地时区的 YYYY-MM-DD
 *
 * 用户眼里的「昨天」是本地的昨天。若用 UTC，UTC+8 的人在早上八点之前
 * 拿到的还是 UTC 的前一天，日记就会在莫名其妙的时刻集体掉一分。
 *
 * ## 为什么解锁不补算锁定期
 *
 * 锁一年再解锁直接归零，这不是「淡忘」，是惩罚用户把东西留下来。
 * 解锁 = 从今天、从现在这个权重重新开始衰减（见 unlockDiary）。
 */

/** 权重刻度 0~100：100 = 刚写下，0 = 忘干净了 */
const MAX_WEIGHT = 100;
const MIN_WEIGHT = 0;

/** 默认每天掉 1 分；允许调用方覆盖，但别让每个调用点各写一个魔数 */
const DEFAULT_DECAY_PER_DAY = 1;

/** 只接受两位月/日：'2026-1-5' 这类写法一律判非法，避免同一日期有两种键 */
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 一天的毫秒数，仅用于 UTC 正午基准的差值换算（不是拿本地时间戳相减） */
const MS_PER_DAY = 86_400_000;

/**
 * @typedef {object} DiaryWeightRecord
 * @property {number} [weightBase] 写下时的权重
 * @property {string} [weightBaseDate] weightBase 对应的本地日期键
 * @property {boolean} [locked] 是否豁免衰减
 * @property {number | null} [lockedWeight] 冻结权重
 * @property {string | null} [lockedDate] 锁定日期键
 */

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 把「毫秒时间戳或 Date」统一成毫秒数。
 *
 * 收 Date 只是为了让调用方少写一层 .getTime()，并不打算支持字符串——
 * 字符串时间戳的解析规则太容易随环境变，宁可回退到默认值。
 *
 * @param {number | Date | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function toMs(value, fallback) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : fallback;
  }
  return Number.isFinite(value) ? /** @type {number} */ (value) : fallback;
}

/**
 * 解析日期键为「UTC 正午」的毫秒数。
 *
 * 用正午而不是零点：正午 ±12 小时都不会跨到相邻日期，任何时区偏移或夏令时
 * 都不会把它挤出去，所以只要按整天换算就不会出现差一天的问题。
 *
 * 回读校验是必须的：Date.UTC 会把 2 月 30 日悄悄进位成 3 月 2 日，
 * 而静默进位在这里等价于静默算错一天——宁可抛错也不要算出看起来合理的错数。
 *
 * @param {string} key
 * @returns {number}
 */
function parseDateKey(key) {
  const m = DATE_KEY_RE.exec(String(key ?? ''));
  if (!m) {
    throw Object.assign(new Error(`日期键形状非法：${String(key)}（需要 YYYY-MM-DD）`), { code: 'E4041' });
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw Object.assign(new Error(`日期键不是真实存在的日期：${key}`), { code: 'E4041' });
  }
  return ms;
}

/**
 * 本地时区的日期键 `YYYY-MM-DD`。
 *
 * 刻意不用 toISOString()：那是 UTC。UTC+8 的凌晨会被算成前一天，
 * 日记就会在早上八点整集体掉一分。
 *
 * @param {number | Date} [ts] 毫秒时间戳，默认当前时刻
 * @returns {string}
 */
export function localDateKey(ts = Date.now()) {
  const ms = toMs(ts, Number.NaN);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    throw Object.assign(new Error(`时间戳非法：${String(ts)}`), { code: 'E4041' });
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 两个日期键之间的自然日差（B 减 A）。
 *
 * 两边都换算到 UTC 正午再相减，所以不吃夏令时那 1 小时；
 * 结果取整是为了消化极端时区下正午基准可能偏出的零头。
 * **不要**改成拿本地时间戳直接做毫秒除法——夏令时那天会少算一天。
 *
 * @param {string} dateKeyA 较早的日期键
 * @param {string} dateKeyB 较晚的日期键
 * @returns {number} 天数差，B 在 A 之前时为负
 */
export function daysBetween(dateKeyA, dateKeyB) {
  return Math.round((parseDateKey(dateKeyB) - parseDateKey(dateKeyA)) / MS_PER_DAY);
}

/**
 * 算出某条日记「现在」的权重。
 *
 * 这是整个淡忘系统唯一的权重入口。已锁定的记录里 daysElapsed 返回的是
 * 「锁了多久」，只用于展示，不参与权重计算。
 *
 * @param {object} input
 * @param {number} [input.weightBase] 写下时的权重，缺省按满分
 * @param {string} [input.weightBaseDate] weightBase 对应的本地日期键
 * @param {boolean} [input.locked]
 * @param {number} [input.lockedWeight] 锁定时冻结下来的权重
 * @param {string} [input.lockedDate] 锁定的本地日期键
 * @param {number} [input.decayPerDay] 每天衰减量
 * @param {number | Date} [input.now] 默认当前时刻，测试必须显式注入
 * @returns {{weight: number, faded: boolean, daysElapsed: number}}
 */
export function computeWeight(input = {}) {
  const at = input.now === undefined ? Date.now() : input.now;
  const today = localDateKey(at);
  const decayPerDay = Number.isFinite(input.decayPerDay)
    ? /** @type {number} */ (input.decayPerDay)
    : DEFAULT_DECAY_PER_DAY;

  if (input.locked && Number.isFinite(input.lockedWeight)) {
    const weight = clamp(/** @type {number} */ (input.lockedWeight), MIN_WEIGHT, MAX_WEIGHT);
    const daysElapsed = input.lockedDate ? daysBetween(input.lockedDate, today) : 0;
    return { weight, faded: weight <= MIN_WEIGHT, daysElapsed };
  }

  // 锁定标记在、lockedWeight 却写没了，说明这条记录写坏了。
  // 这时退回「继续按 weightBase 衰减」，而不是假装它还锁着或假装满分：
  // 宁可多掉一分，也不要凭空把一条旧日记拉回 100。
  const base = Number.isFinite(input.weightBase) ? /** @type {number} */ (input.weightBase) : MAX_WEIGHT;

  // 没有基准日期只能当「今天刚写下」：缺字段不该让权重跳水
  const daysElapsed = input.weightBaseDate ? daysBetween(input.weightBaseDate, today) : 0;
  const weight = clamp(base - decayPerDay * daysElapsed, MIN_WEIGHT, MAX_WEIGHT);
  return { weight, faded: weight <= MIN_WEIGHT, daysElapsed };
}

/**
 * 钉住一条日记，豁免衰减。
 *
 * 已经锁着的记录原样返回：重复锁定不该刷新 lockedDate。
 * 否则「锁了多久」会被悄悄清零，界面上看不出任何异常，数据已经骗人了。
 *
 * @param {DiaryWeightRecord & Record<string, any>} record
 * @param {number | Date} [now]
 * @returns {object} 新记录，不改入参
 */
export function lockDiary(record = {}, now) {
  if (record.locked) return { ...record };
  const at = now === undefined ? Date.now() : now;
  const { weight } = computeWeight({ ...record, now: at });
  return { ...record, locked: true, lockedWeight: weight, lockedDate: localDateKey(at) };
}

/**
 * 解锁，并把衰减基准重置到今天。
 *
 * 关键决策：**不补算锁定期**。锁一年再解锁直接归零不是淡忘，是惩罚用户
 * 把东西留下来。解锁 = 从今天、从这个权重重新开始掉分。
 *
 * lockedWeight / lockedDate 清成 null：留着它们会让下一次读取误以为这条还锁着，
 * 也容易在界面上出现「已解锁但显示锁定权重」的错位。
 *
 * @param {DiaryWeightRecord & Record<string, any>} record
 * @param {number | Date} [now]
 * @returns {object} 新记录，不改入参
 */
export function unlockDiary(record = {}, now) {
  if (!record.locked) return { ...record };
  const at = now === undefined ? Date.now() : now;
  const { weight } = computeWeight({ ...record, now: at });
  return {
    ...record,
    locked: false,
    weightBase: weight,
    weightBaseDate: localDateKey(at),
    lockedWeight: null,
    lockedDate: null,
  };
}

/**
 * 权重坏掉时（NaN / undefined / 字符串）一律当 0：
 * 宁可少带一条日记进上下文，也不要拿 NaN 去比较——
 * NaN 参与比较的结果全 false，会把整条筛选逻辑变成静默失效。
 *
 * @param {number} weight
 * @returns {number}
 */
function weightOrZero(weight) {
  return Number.isFinite(weight) ? weight : 0;
}

/**
 * 这条日记够不够格进上下文。
 *
 * 口径固定为 `weight >= contextMinWeight`：**等于阈值要带**。
 * 阈值缺省 0，即没配阈值时全带——把 0 理解成「全屏蔽」是个反直觉的坑。
 *
 * @param {number} weight
 * @param {number} [contextMinWeight]
 * @returns {boolean}
 */
export function shouldIncludeInContext(weight, contextMinWeight = 0) {
  const min = Number.isFinite(contextMinWeight) ? /** @type {number} */ (contextMinWeight) : 0;
  return weightOrZero(weight) >= min;
}

/**
 * 这条日记该不该在界面上藏起来。
 *
 * 口径固定为 `weight < hiddenBelowWeight`：**等于阈值仍然可见**。
 * 和 shouldIncludeInContext 的 `>=` 正好互补，同一阈值下不会出现
 * 「既被藏起来又被带进上下文」或者「既可见又没被带进上下文」的裂缝。
 *
 * @param {number} weight
 * @param {number} [hiddenBelowWeight]
 * @returns {boolean}
 */
export function isHidden(weight, hiddenBelowWeight = 0) {
  const below = Number.isFinite(hiddenBelowWeight) ? /** @type {number} */ (hiddenBelowWeight) : 0;
  return weightOrZero(weight) < below;
}
