/**
 * 日期 / 时钟 / 周次 —— 课程表的"时间算术"层（纯函数）
 *
 * ## 为什么单独一层
 *
 * 其余模块几乎每个判断都要问时间：preview 要把用户说的日期归一到周一，
 * day/week 查询要算"这天是第几周、单周还是双周"，保存前要判断"这条课在第 4 周上不上"。
 * 这些问题只要有一处口径不同（周一算 0 还是 1、周次从 0 还是从 1 数），症状就是
 * "表格里多一周或少一周"，而排查它会花掉半天。所以口径只在这里写一次。
 *
 * ## 为什么一律用 `Date.UTC` 做差分
 *
 * `new Date('2026-09-07')` 只在进程时区偏移为 0 时才是那天：在上海是 08:00，
 * 在 UTC-5 是前一天 19:00。改用 `setDate()` 叠加"夏令时切换日"（有些时区一天
 * 只有 23 或 25 小时）后，+7 天甚至不再等于 +7 天。`Date.UTC(y, m, d)` 拼的是
 * 绝对毫秒数，相减再除以 86400000 永远是整数天，与宿主机器时区无关。
 * "今天"是唯一需要时区的地方，交给 `todayInZone` 用 `Intl` 单独求。
 *
 * ## 纯函数约定
 *
 * 不碰 IO、不读本地时区、不缓存、不持有模块级可变状态；对非法输入**不抛异常**
 * （返回 `false` / `null` / `''` / `NaN` / `[]`，按各函数注释），因为调用方是
 * 工具入口，它必须能把"用户给错了"翻译成一句能读的提示，而不是一个栈。
 */

/**
 * 周次上限。单条课程的 `weekEnd` 不能超过它（契约 §2）。
 *
 * 导出而不是各文件写 30：`model.mjs` 的 `LIMITS.maxWeek` 和这里的范围校验
 * 必须是同一个数，否则会出现"校验说 30 合法、展开周次时被截断"这种鬼故事。
 */
export const MAX_WEEK = 30;

/** 星期中文名。以 1 = 周一为键，直接被 `WEEKDAY_CN[course.weekday]` 取用。 */
export const WEEKDAY_CN = Object.freeze({
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
});

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 两个捕获组是给 clockToMinutes 用的：只做格式判定时用不上，但少一个组就会
// 静默算出 NaN 分钟（`Number(undefined)`），症状是"时间合法但比较永远为假"
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MS_PER_DAY = 86_400_000;

/**
 * 某年某月的天数。
 *
 * 刻意不用 `Date.UTC(y, m, 0)` 求月长：`Date.UTC` 把 0–99 年当 19xx，
 * 拿到 90 就会算成 1990 年。这里用闰年规则直接算，输入就是输入。
 *
 * @param {number} y
 * @param {number} m 1–12
 * @returns {number}
 */
function daysInMonth(y, m) {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [0, 31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];
}

/**
 * 把毫秒时间戳格式化成 `YYYY-MM-DD`（按 UTC 取各字段）。
 *
 * @param {number} ms
 * @returns {string} 超出 1000–9999 年或非法时间戳时返回 ''
 */
function isoFromMs(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getUTCFullYear();
  if (y < 1000 || y > 9999) return '';
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${day}`;
}

/**
 * 拆解 `YYYY-MM-DD`，同时做**日历合法性**校验（`2026-02-30` 不是打错格式，
 * 是那天不存在，必须拒绝）。
 *
 * 年份限制在 1000–9999：`Date.UTC` 对 0–99 会自动加 1900，而课程表也不可能
 * 用到公元 1000 年前，直接挡掉比在别处补特例干净。
 *
 * @param {unknown} s
 * @returns {{ok: true, y: number, m: number, d: number} | {ok: false, message: string}}
 */
export function parseDateParts(s) {
  if (typeof s !== 'string') return { ok: false, message: '日期必须是 YYYY-MM-DD 字符串' };
  // 首尾空白很常见（模型把日期抄进了空格），先去掉再判；不因此算"格式错误"
  const m = DATE_RE.exec(s.trim());
  if (!m) return { ok: false, message: '日期格式应为 YYYY-MM-DD' };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1000 || y > 9999) return { ok: false, message: '年份需在 1000–9999 之间' };
  if (mo < 1 || mo > 12) return { ok: false, message: '月份需在 01–12 之间' };
  if (d < 1 || d > daysInMonth(y, mo)) return { ok: false, message: `${y} 年 ${mo} 月没有 ${d} 日` };
  return { ok: true, y, m: mo, d };
}

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isValidDate(s) {
  return parseDateParts(s).ok === true;
}

/**
 * `HH:MM`（24 小时制）格式校验。与契约 §5.1 的正则一致：只收两位小时和两位分钟。
 *
 * 故意不收 `8:00` / `8：00` / `0800`：契约写明了正则，宽松化会让"保存了什么"
 * 和"校验规则是什么"对不上；这种输入应该由模型先归一，而不是让这里猜。
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isValidClock(s) {
  if (typeof s !== 'string') return false;
  return CLOCK_RE.test(s.trim());
}

/**
 * 把 `HH:MM` 换成"当天第几分钟"，用于区间比较。
 *
 * @param {unknown} s
 * @returns {number | null} 非法时 null（不是 0，避免"00:00 合法"和"解析失败"混淆）
 */
export function clockToMinutes(s) {
  if (typeof s !== 'string') return null;
  const m = CLOCK_RE.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * `a - b` 相差多少天。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} 任一非法时 NaN（不是 0：0 是合法结果，混在一起会掩盖错误）
 */
export function dayDiff(a, b) {
  const pa = parseDateParts(a);
  const pb = parseDateParts(b);
  if (!pa.ok || !pb.ok) return Number.NaN;
  const da = Date.UTC(pa.y, pa.m - 1, pa.d);
  const db = Date.UTC(pb.y, pb.m - 1, pb.d);
  // UTC 下没有夏令时，差值必然是整天的整数倍；round 只是防浮点噪声
  return Math.round((da - db) / MS_PER_DAY);
}

/**
 * 日期加减天数。
 *
 * @param {unknown} dateStr
 * @param {unknown} n 整数天，可负
 * @returns {string} `YYYY-MM-DD`；输入非法时返回 ''
 */
export function addDays(dateStr, n) {
  const p = parseDateParts(dateStr);
  if (!p.ok) return '';
  if (!Number.isInteger(n)) return '';
  return isoFromMs(Date.UTC(p.y, p.m - 1, p.d) + n * MS_PER_DAY);
}

/**
 * 星期几，周一 = 1，周日 = 7（与契约 §2 的 `weekday` 同一口径）。
 *
 * `getUTCDay()` 是周日 = 0，所以先 +6 再取模，把星期天挪到末尾。
 *
 * @param {unknown} dateStr
 * @returns {number} 1–7；非法日期返回 NaN
 */
export function weekdayOf(dateStr) {
  const p = parseDateParts(dateStr);
  if (!p.ok) return Number.NaN;
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return ((dow + 6) % 7) + 1;
}

/**
 * 该日期所在周的周一。
 *
 * @param {unknown} dateStr
 * @returns {string} `YYYY-MM-DD`；非法日期返回 ''
 */
export function mondayOf(dateStr) {
  const wd = weekdayOf(dateStr);
  if (!Number.isInteger(wd)) return '';
  return addDays(dateStr, -(wd - 1));
}

/**
 * 把学期开始日期归一到它所在周的周一（契约 §2 / §3.1 要求回写归一后的值）。
 *
 * @param {unknown} dateStr
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
export function normalizeTermStart(dateStr) {
  const p = parseDateParts(dateStr);
  if (!p.ok) return { ok: false, message: p.message };
  return { ok: true, value: mondayOf(dateStr) };
}

/**
 * 某天是学期第几周（契约 §3.2：`floor((date - termStartDate) / 7天) + 1`）。
 *
 * 结果可以 <= 0（学期还没开始）——调用方要区分"第 0 周"和"第 1 周"，
 * 所以这里不 clamp。`termStartDate` 预期已被归一成周一（`normalizeTermStart`），
 * 这里不重复归一：一旦在两个地方各归一一次，就有两套口径。
 *
 * @param {unknown} dateStr
 * @param {unknown} termStartDate
 * @returns {number} 任一输入非法时 NaN
 */
export function weekOf(dateStr, termStartDate) {
  const diff = dayDiff(dateStr, termStartDate);
  if (!Number.isFinite(diff)) return Number.NaN;
  return Math.floor(diff / 7) + 1;
}

/**
 * 周次的单双。
 *
 * @param {unknown} week
 * @returns {'odd' | 'even'} 非整数（含 NaN）一律按 'even'：
 *   本函数必须全函数、不能抛；需要"这周到底上不上"的调用方都先用
 *   `weeksInRange` 校验过，这里只是最后一步取模。
 *   负数周次用 `((w % 2) + 2) % 2`，避免 JS 的 `-1 % 2 === -1` 把学期前误判成单周。
 */
export function parityOfWeek(week) {
  if (!Number.isInteger(week)) return 'even';
  return ((week % 2) + 2) % 2 === 1 ? 'odd' : 'even';
}

/**
 * 把 `[weekStart, weekEnd]` 按单双周展开，边界包含（契约 §3.3 / §5.2 第 2 条）。
 *
 * 例：`weeksInRange(1, 16, 'odd')` → `[1,3,5,7,9,11,13,15]`。
 *
 * @param {unknown} weekStart
 * @param {unknown} weekEnd
 * @param {unknown} parity 'all' / 'odd' / 'even'；缺省（undefined / null / 空串）按 'all'
 * @returns {number[]} 非法输入返回 []（不是 null：调用方一律"求交集"，空集合天然安全）
 */
export function weeksInRange(weekStart, weekEnd, parity) {
  const p = parity === undefined || parity === null ? 'all' : String(parity).trim() || 'all';
  if (p !== 'all' && p !== 'odd' && p !== 'even') return [];
  if (!Number.isInteger(weekStart) || !Number.isInteger(weekEnd)) return [];
  if (weekStart < 1 || weekEnd > MAX_WEEK) return [];
  if (weekStart > weekEnd) return [];
  /** @type {number[]} */
  const out = [];
  // 上限 30 项、单次遍历，不会有性能或死循环问题
  for (let w = weekStart; w <= weekEnd; w += 1) {
    if (p === 'all' || parityOfWeek(w) === p) out.push(w);
  }
  return out;
}

/**
 * 取指定时区的"今天"（契约 §3.4：不读系统本地时区，用配置项 + Intl）。
 *
 * 时区名由用户写在插件配置里，写错（`Asia/Shanghia`）不该让整个工具崩掉：
 * Intl 抛异常就退回 UTC，并在返回值上体现为"日期可能差一天"——调用方仍能
 * 查询，只是"今天"按 UTC 算。宁可结果保守也不要工具不可用。
 *
 * @param {unknown} timezone IANA 时区名，如 'Asia/Shanghai'
 * @param {number} [nowMs] 毫秒时间戳；缺省取当前时间（便于单测注入）
 * @returns {string} `YYYY-MM-DD`
 */
export function todayInZone(timezone, nowMs) {
  const ms = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const tz = typeof timezone === 'string' && timezone.trim() !== '' ? timezone.trim() : 'UTC';
  try {
    // 用 formatToParts 而不是解析 format() 的结果：format 的输出受 locale 影响
    // （en-CA 是 YYYY-MM-DD，别的 locale 可能是 DD/MM/YYYY），只有 parts 的
    // type 是稳定的。
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    let y = '';
    let m = '';
    let d = '';
    for (const part of fmt.formatToParts(new Date(ms))) {
      if (part.type === 'year') y = part.value;
      else if (part.type === 'month') m = part.value;
      else if (part.type === 'day') d = part.value;
    }
    const iso = `${y}-${m}-${d}`;
    if (isValidDate(iso)) return iso;
  } catch {
    // 非法时区名 / ICU 数据缺失：落到下面的 UTC 兜底
  }
  return isoFromMs(ms);
}

/**
 * 中文日期，如 `10月23日（周五）`。
 *
 * @param {unknown} dateStr
 * @returns {string} 非法日期返回 ''（而不是把原文吐回去：那会让"格式不对"
 *   伪装成一个看起来正常的日期，模型会照着念给用户）
 */
export function formatDateCn(dateStr) {
  const p = parseDateParts(dateStr);
  if (!p.ok) return '';
  const wd = weekdayOf(dateStr);
  const week = WEEKDAY_CN[wd];
  if (!week) return '';
  return `${p.m}月${p.d}日（${week}）`;
}
