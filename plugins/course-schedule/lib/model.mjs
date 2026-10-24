/**
 * 归一化 / 校验 / 冲突 / 重复 —— 课程表的"数据规则"层（纯函数）
 *
 * ## 这一层要解决的核心问题：区分"值错了"和"还没说"
 *
 * 模型的输入几乎总是**不完整**的："周五上午高数"——有星期、有课程名、没有
 * 学期开始日期、没有节次。这种情况**不是错误**，它是"需要再问用户一句"。
 * 如果这里直接返回 `E_COURSE_BAD_ARG`，模型会把它当成"我搞错了"，于是二选一：
 * 要么放弃整件事，要么**自己编一个日期**填进去。后者是真正的灾难——
 * 用户拿到一张时间全是错的课程表，而且看起来很正常。
 *
 * 所以本模块的输出分两条路，且**永不混用**：
 *
 *   · 值本身非法（`weekday: 0`、`25:00`、`2026-02-30`、61 字的课程名）
 *     → `{ ok: false, code: 'E_COURSE_BAD_ARG', message, issues }`
 *   · 值都合法但必要字段没给（缺 name / weekday / 时间 / 学期 / 周次）
 *     → `{ ok: true, course, issues, missing: [...], optionalMissing: [...] }`
 *
 * 判断标准只有一条：**用户说了什么错的东西**才算非法；**用户什么都没说**
 * 只算缺失。`name: ''` 按其语义算"没说"，`name: '!'` 算"说了一个非法值"。
 *
 * 冲突与重复单独成函数：它们需要现有的整个课程库，而单条归一化只需要自己。
 *
 * ## 约定
 *
 * 不碰 IO、不持有模块级可变状态、不修改入参（每次都产出新对象）——
 * 它要能被单测穷举，而课程表最怕的就是"校验通过但对象被改坏了"。
 */

import {
  MAX_WEEK,
  clockToMinutes,
  isValidClock,
  normalizeTermStart,
  parityOfWeek,
  weekdayOf,
  weekOf,
  weeksInRange,
} from './time.mjs';

/** 星期中文名：1 = 周一（与 `weekday` 字段同口径） */
export const WEEKDAY_CN = Object.freeze({
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
});

/** 单双周的中文说法。空 `parity` 一律按"每周"理解（契约 §2 默认值） */
export const PARITY_CN = Object.freeze({
  all: '每周',
  odd: '单周',
  even: '双周',
});

/** 合法的 parity 值，顺序即展示顺序 */
export const PARITY_VALUES = Object.freeze(['all', 'odd', 'even']);

/**
 * 各类上限的单一来源。
 *
 * 与 `time.MAX_WEEK` 必须一致，所以这里直接引用而不写字面量 30：
 * 两份 30 迟早会变成 30 和 31，症状是"保存时合法、展开周次时少一周"。
 *
 * @type {Readonly<object>}
 */
export const LIMITS = Object.freeze({
  /** 课程名最多 60 字 */
  name: 60,
  /** 地点最多 80 字 */
  location: 80,
  /** 教师最多 40 字 */
  teacher: 40,
  /** 备注最多 200 字 */
  note: 200,
  /** 一条课最多 12 个节次 */
  maxPeriods: 12,
  /** 节次范围 1–20 */
  maxPeriod: 20,
  /** 周次上限 30 */
  maxWeek: MAX_WEEK,
  /** `maxCourses` 配置项的硬上限（契约 §5.1 / §10.3） */
  maxCoursesHard: 200,
});

/** 课程 id 形状：`c_` + 8 位十六进制（契约 §2，模型可读不可写） */
const COURSE_ID_RE = /^c_[0-9a-f]{8}$/;

/**
 * 内部：判断一个值是否"没给"。
 *
 * `null` 和空串都算没给 —— 模型的 JSON 里 `""` 的含义就是"我不知道"，
 * 把它当成"用户给了一个空地点"只会制造一条看起来合法、实际缺信息的数据。
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isAbsent(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * 内部：把数字或纯数字串转成整数；其它一律 null。
 *
 * 允许 `"3"` 是因为工具参数经过 JSON 序列化后，模型偶尔会把整数写成字符串。
 * 拒绝 `"3.5"`、`"3节"`、`true`：猜这些等于替用户决定，猜错了看不出来。
 *
 * @param {unknown} v
 * @returns {number | null}
 */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  return null;
}

/**
 * 内部：按**码点**数长度（emoji 算 1 字，不是 2）。
 *
 * @param {string} s
 * @returns {number}
 */
function charLength(s) {
  return Array.from(s).length;
}

/**
 * 内部：课程名是否"全是符号"（契约 §2：不能是纯符号）。
 *
 * 判据是"有没有字母/数字/汉字"，而不是"有没有标点"：`C++`、`线代&高数`、
 * `高数（上）` 都是正常的课程名，`---`、`!!!` 才该被拒。
 *
 * @param {string} s
 * @returns {boolean}
 */
function isPureSymbols(s) {
  return !/[\p{L}\p{N}]/u.test(s);
}

/**
 * 构造一条 issue。
 *
 * @param {string} field
 * @param {string} code
 * @param {string} message
 * @returns {{field: string, code: string, message: string}}
 */
function issue(field, code, message) {
  return { field, code, message };
}

/**
 * 归一化一条课程输入（模型给的对象 → 可保存的课程形状）。
 *
 * 归一化包括：去首尾空白、`periods` 去重升序、`parity` 补默认值、
 * `termStartDate` 归一到所在周的周一。**不做**任何推断（不补地点、不猜学期）。
 *
 * @param {unknown} raw 模型给的对象
 * @param {{termStartDateDefault?: unknown}} [opts]
 *   `termStartDateDefault` 是配置项 `defaultTermStartDate`：仅在用户没给学期
 *   开始日期时**借用**它，此时必须记 `assumed` issue、且 `missing` 里仍保留
 *   `termStartDate`——"建议值"不能冒充"用户确认过的值"（契约 §10.3）。
 * @returns {
 *   {ok: true, course: object, issues: object[], missing: string[], optionalMissing: string[]} |
 *   {ok: false, code: 'E_COURSE_BAD_ARG', message: string, issues: object[]}
 * }
 */
export function normalizeCourseInput(raw, opts = {}) {
  /** @type {object[]} 值非法的问题 */
  const errors = [];
  /** @type {object[]} 归一化/假设的提示（不是错误，要回灌给模型让它知道发生了什么） */
  const notes = [];
  /** @type {string[]} 必要字段缺失 */
  const missing = [];
  /** @type {string[]} 建议字段缺失 */
  const optionalMissing = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      code: 'E_COURSE_BAD_ARG',
      message: '课程必须是一个对象',
      issues: [issue('course', 'invalid', '课程必须是一个对象')],
    };
  }

  // ---------- name ----------
  let name = '';
  if (isAbsent(raw.name)) {
    missing.push('name');
  } else if (typeof raw.name !== 'string') {
    errors.push(issue('name', 'invalid', '课程名必须是字符串'));
  } else {
    name = raw.name.trim();
    if (name === '') {
      missing.push('name');
    } else if (charLength(name) > LIMITS.name) {
      errors.push(issue('name', 'invalid', `课程名最多 ${LIMITS.name} 字`));
    } else if (isPureSymbols(name)) {
      errors.push(issue('name', 'invalid', '课程名不能是纯符号'));
    }
  }

  // ---------- weekday ----------
  /** @type {number | null} */
  let weekday = null;
  if (isAbsent(raw.weekday)) {
    missing.push('weekday');
  } else {
    const v = toInt(raw.weekday);
    if (v === null || v < 1 || v > 7) {
      errors.push(issue('weekday', 'invalid', 'weekday 需为 1–7 的整数（1 = 周一）'));
    } else {
      weekday = v;
    }
  }

  // ---------- periods ----------
  // 空数组 = "没有节次"，与"没给"等价；它是否非法取决于有没有时间（见下面 time 段）
  /** @type {number[]} */
  let periods = [];
  if (!isAbsent(raw.periods)) {
    if (!Array.isArray(raw.periods)) {
      errors.push(issue('periods', 'invalid', 'periods 必须是整数数组'));
    } else {
      /** @type {number[]} */
      const parsed = [];
      let bad = false;
      for (const item of raw.periods) {
        const v = toInt(item);
        if (v === null || v < 1 || v > LIMITS.maxPeriod) {
          errors.push(issue('periods', 'invalid', `节次需为 1–${LIMITS.maxPeriod} 的整数`));
          bad = true;
          break;
        }
        parsed.push(v);
      }
      if (!bad) {
        // 去重升序是契约要求的归一化动作，不算错误
        const uniq = [...new Set(parsed)].sort((a, b) => a - b);
        if (uniq.length > LIMITS.maxPeriods) {
          errors.push(issue('periods', 'invalid', `一条课最多 ${LIMITS.maxPeriods} 个节次`));
        } else if (uniq.length !== parsed.length) {
          notes.push(issue('periods', 'normalized', '节次已去重并升序排列'));
        }
        periods = uniq;
      }
    }
  }

  // ---------- startTime / endTime ----------
  // 契约 §2：必须成对出现，且 start < end。只给一半是"值非法"而不是"缺失"——
  // 用户明确说了一个起点却没给终点，这正是需要模型回头澄清的那条信息。
  let startTime = '';
  let endTime = '';
  const hasStart = !isAbsent(raw.startTime);
  const hasEnd = !isAbsent(raw.endTime);
  if (hasStart !== hasEnd) {
    errors.push(issue('time', 'invalid', '开始时间和结束时间必须成对出现'));
  } else if (hasStart && hasEnd) {
    const s = String(raw.startTime).trim();
    const e = String(raw.endTime).trim();
    if (!isValidClock(s)) {
      errors.push(issue('startTime', 'invalid', '开始时间格式应为 HH:MM（24 小时制）'));
    }
    if (!isValidClock(e)) {
      errors.push(issue('endTime', 'invalid', '结束时间格式应为 HH:MM（24 小时制）'));
    }
    if (isValidClock(s) && isValidClock(e)) {
      const sm = clockToMinutes(s);
      const em = clockToMinutes(e);
      if (sm !== null && em !== null && sm >= em) {
        errors.push(issue('time', 'invalid', '开始时间必须早于结束时间'));
      } else {
        startTime = s;
        endTime = e;
      }
    }
  }
  // 时段二选一（契约 §2）：既没有节次、也没有成对合法的时间 → 必要字段缺失。
  // 注意这里必须等 errors 收齐再判：用户写了 `25:00` 属于"值非法"，
  // 已经在上面进了 errors，不该再被重复标成"缺失"。
  const timePairOk = startTime !== '' && endTime !== '';
  const slotMalformed = errors.some(
    (i) => i.field === 'periods' || i.field === 'time' || i.field === 'startTime' || i.field === 'endTime',
  );
  if (periods.length === 0 && !timePairOk && !slotMalformed) {
    missing.push('time');
  }

  // ---------- termStartDate ----------
  let termStartDate = '';
  if (isAbsent(raw.termStartDate)) {
    const fallback = opts?.termStartDateDefault;
    const norm = isAbsent(fallback) ? { ok: false } : normalizeTermStart(fallback);
    if (norm.ok) {
      termStartDate = norm.value;
      notes.push(issue('termStartDate', 'assumed', `学期开始日期未提供，暂用建议值 ${norm.value}（需用户确认）`));
    }
    // 契约 + 任务要求：即使借用了建议值，missing 里仍必须有它
    missing.push('termStartDate');
  } else {
    const norm = normalizeTermStart(raw.termStartDate);
    if (!norm.ok) {
      errors.push(issue('termStartDate', 'invalid', `学期开始日期非法：${norm.message}`));
    } else {
      termStartDate = norm.value;
      const given = String(raw.termStartDate).trim();
      if (given !== norm.value) {
        // 契约 §2 要求归一到周一并回写；告诉模型"我改了"，免得它以为丢了一天
        notes.push(issue('termStartDate', 'normalized', `学期开始日期已归一到该周周一 ${norm.value}`));
      }
    }
  }

  // ---------- weekStart / weekEnd ----------
  // 成对使用：缺任一半都算 `weeks` 缺失，因为单独一个数字算不出周次区间
  const hasWeekStart = !isAbsent(raw.weekStart);
  const hasWeekEnd = !isAbsent(raw.weekEnd);
  let weekStart = null;
  let weekEnd = null;
  if (!hasWeekStart && !hasWeekEnd) {
    missing.push('weeks');
  } else if (!hasWeekStart || !hasWeekEnd) {
    // 只给了一半：值本身没错，缺的是另一半 → 仍按"缺失"处理，并把原因说清
    missing.push('weeks');
    notes.push(issue('weeks', 'partial', '周次区间需要同时给出周开始和周结束'));
  } else {
    const s = toInt(raw.weekStart);
    const e = toInt(raw.weekEnd);
    if (s === null || s < 1 || s > LIMITS.maxWeek) {
      errors.push(issue('weekStart', 'invalid', `周开始需为 1–${LIMITS.maxWeek} 的整数`));
    }
    if (e === null || e < 1 || e > LIMITS.maxWeek) {
      errors.push(issue('weekEnd', 'invalid', `周结束需为 1–${LIMITS.maxWeek} 的整数`));
    }
    if (s !== null && e !== null && s >= 1 && e >= 1 && s <= LIMITS.maxWeek && e <= LIMITS.maxWeek) {
      if (s > e) {
        errors.push(issue('weeks', 'invalid', '周开始不能晚于周结束'));
      } else {
        weekStart = s;
        weekEnd = e;
      }
    }
  }

  // ---------- parity ----------
  let parity = 'all';
  if (!isAbsent(raw.parity)) {
    const p = String(raw.parity).trim().toLowerCase();
    if (!PARITY_VALUES.includes(p)) {
      errors.push(issue('parity', 'invalid', 'parity 只能是 all / odd / even'));
    } else {
      parity = p;
    }
  }

  // ---------- location / teacher / note ----------
  /**
   * 可选文本字段的公共处理。
   *
   * @param {string} field
   * @param {number} max
   * @param {boolean} trackMissing 是否计入 optionalMissing（note 不算，因为它没有"问用户"的价值）
   * @returns {string}
   */
  function optionalText(field, max, trackMissing) {
    if (isAbsent(raw[field])) {
      if (trackMissing) optionalMissing.push(field);
      return '';
    }
    if (typeof raw[field] !== 'string') {
      errors.push(issue(field, 'invalid', `${field} 必须是字符串`));
      return '';
    }
    const v = raw[field].trim();
    if (v === '') {
      if (trackMissing) optionalMissing.push(field);
      return '';
    }
    if (charLength(v) > max) {
      errors.push(issue(field, 'invalid', `${field} 最多 ${max} 字`));
      return '';
    }
    return v;
  }

  const location = optionalText('location', LIMITS.location, true);
  const teacher = optionalText('teacher', LIMITS.teacher, true);
  const note = optionalText('note', LIMITS.note, false);

  if (errors.length > 0) {
    const first = errors[0];
    return {
      ok: false,
      code: 'E_COURSE_BAD_ARG',
      // message 点名第一个字段：模型据此知道改哪里，而不是"参数不合法"
      message: `${first.field}：${first.message}`,
      issues: [...errors, ...notes],
    };
  }

  return {
    ok: true,
    course: {
      name,
      weekday,
      periods,
      startTime,
      endTime,
      location,
      teacher,
      termStartDate,
      weekStart,
      weekEnd,
      parity,
      note,
    },
    issues: notes,
    missing,
    optionalMissing,
  };
}

/**
 * 校验一条**磁盘上读回来的**课程（契约 §7.5：读取时做完整形状校验）。
 *
 * 与 `normalizeCourseInput` 的区别：这里一切字段都必须已经齐全（`missing` 非空
 * 就是损坏），并且必须有合法的 `id` 与时间戳。**不修补**数据——修补会让
 * "文件坏了"变得看不出来，而契约要求损坏时必须让用户知道并保留原文件。
 *
 * @param {unknown} obj
 * @returns {{ok: true, course: object} | {ok: false, message: string}}
 */
export function validateStoredCourse(obj) {
  const base = normalizeCourseInput(obj);
  if (!base.ok) return { ok: false, message: `课程记录非法：${base.message}` };
  if (base.missing.length > 0) {
    return { ok: false, message: `课程记录缺少必要字段：${base.missing.join(', ')}` };
  }
  const id = typeof obj?.id === 'string' ? obj.id : '';
  if (!COURSE_ID_RE.test(id)) return { ok: false, message: `课程 id 非法：${id || '(空)'}` };
  const createdAt = typeof obj?.createdAt === 'string' ? obj.createdAt.trim() : '';
  if (createdAt === '' || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, message: '课程记录缺少合法的 createdAt' };
  }
  const updatedAt = typeof obj?.updatedAt === 'string' ? obj.updatedAt.trim() : '';
  if (updatedAt === '' || Number.isNaN(Date.parse(updatedAt))) {
    return { ok: false, message: '课程记录缺少合法的 updatedAt' };
  }
  return {
    ok: true,
    // 用归一化后的值：旧文件里 termStartDate 不是周一时，读取即修正，
    // 这样后续的周次/冲突计算不会因为"同一学期两种基准"而算错
    course: { id, ...base.course, createdAt, updatedAt },
  };
}

/**
 * 生成课程 id：`c_` + 8 位十六进制（契约 §2）。
 *
 * 用 `globalThis.crypto`（Node 18+ 内置 WebCrypto）而不是自拼 `Math.random`：
 * 后者在进程刚启动时种子相近，理论上会撞；8 位空间虽然小，但这里只是
 * "同一归属内不重复"的短标识，不承担安全职责。
 *
 * @returns {string}
 */
export function newCourseId() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `c_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 内部：单边取节次集合（非空整数，排序去重）。
 *
 * @param {object} c
 * @returns {number[]}
 */
function periodsOf(c) {
  if (!Array.isArray(c?.periods)) return [];
  return [...new Set(c.periods.filter((v) => Number.isInteger(v)))].sort((a, b) => a - b);
}

/**
 * 内部：单边取时间区间（分钟）；缺任一端返回 null。
 *
 * @param {object} c
 * @returns {{start: number, end: number} | null}
 */
function timeRangeOf(c) {
  const s = isValidClock(c?.startTime) ? clockToMinutes(c.startTime) : null;
  const e = isValidClock(c?.endTime) ? clockToMinutes(c.endTime) : null;
  if (s === null || e === null || s >= e) return null;
  return { start: s, end: e };
}

/**
 * 内部：取两边周次集合的交集。
 *
 * @param {object} a
 * @param {object} b
 * @returns {number[]}
 */
function weekIntersection(a, b) {
  const wa = weeksInRange(a?.weekStart, a?.weekEnd, a?.parity);
  const wb = weeksInRange(b?.weekStart, b?.weekEnd, b?.parity);
  if (wa.length === 0 || wb.length === 0) return [];
  // 周次上限 30，用 Set 比双循环更直白
  const setB = new Set(wb);
  return wa.filter((w) => setB.has(w));
}

/**
 * 两条课程是否冲突（契约 §5.2）。
 *
 * 三个条件全部成立才冲突：同学期同星期、周次有交集、时段重叠。
 *
 * ## 为什么"节次 vs 时间"要报潜在冲突
 *
 * `periods` 和 `startTime/endTime` 是两套坐标系：前者是"第几节"，后者是"几点"。
 * 没有作息表就无法把 3-4 节映射成 10:00–11:40。这种情况下**不做任何猜测**，
 * 直接标成潜在冲突交给用户确认——宁可多问一句"这两门课时间是不是重了"，
 * 也不要静默放行，让用户在两节课撞车之后才发现。
 *
 * @param {object} a
 * @param {object} b
 * @returns {{conflict: boolean, reason: string}} 不冲突时 reason 为 ''
 */
export function conflictBetween(a, b) {
  const none = { conflict: false, reason: '' };
  if (!a || !b) return none;

  // 1. 不同学期、不同星期 → 无冲突。termStartDate 缺失视为"无法比较"，同样不报
  const ta = typeof a.termStartDate === 'string' ? a.termStartDate.trim() : '';
  const tb = typeof b.termStartDate === 'string' ? b.termStartDate.trim() : '';
  if (ta === '' || tb === '' || ta !== tb) return none;
  if (Number(a.weekday) !== Number(b.weekday)) return none;

  // 2. 周次无交集 → 无冲突（单双周不同是最常见的"看起来重其实不重"）
  if (weekIntersection(a, b).length === 0) return none;

  // 3. 时段
  const pa = periodsOf(a);
  const pb = periodsOf(b);
  if (pa.length > 0 && pb.length > 0) {
    const setB = new Set(pb);
    for (const p of pa) {
      if (setB.has(p)) return { conflict: true, reason: '节次重叠' };
    }
    return none;
  }
  if (pa.length > 0 || pb.length > 0) {
    // 一边有节次、一边只有时间：坐标系不同，按潜在冲突处理（契约 §5.2 第 3 条）
    return { conflict: true, reason: '时间与节次无法比较' };
  }

  // 两边都只有时间：端点相接不算冲突（10:00–11:40 与 11:40–12:00 是连堂）
  const ra = timeRangeOf(a);
  const rb = timeRangeOf(b);
  if (!ra || !rb) return none;
  if (ra.start < rb.end && rb.start < ra.end) return { conflict: true, reason: '时间重叠' };
  return none;
}

/**
 * 候选课程与已有课程库的所有冲突（契约 §5.2）。
 *
 * @param {object} candidate 待写入的课程（归一化后）
 * @param {ReadonlyArray<object>} existing 该归属下的已有课程
 * @param {{excludeId?: string}} [opts] 修改场景要排除自己，否则"改自己"永远和自己冲突
 * @returns {Array<{withCourseId: string, withName: string, weekday: number, reason: string}>}
 */
export function findConflicts(candidate, existing, opts = {}) {
  const list = Array.isArray(existing) ? existing : [];
  const excludeId = typeof opts?.excludeId === 'string' ? opts.excludeId : '';
  /** @type {Array<object>} */
  const out = [];
  for (const other of list) {
    if (!other || typeof other !== 'object') continue;
    if (excludeId !== '' && other.id === excludeId) continue;
    const r = conflictBetween(candidate, other);
    if (!r.conflict) continue;
    out.push({
      // 已有记录一定带 id；没有时给空串，让调用方按"未知记录"展示而不是崩掉
      withCourseId: typeof other.id === 'string' ? other.id : '',
      withName: typeof other.name === 'string' ? other.name : '',
      weekday: Number(other.weekday),
      reason: r.reason,
    });
  }
  return out;
}

/**
 * 两条课程是否重复（契约 §5.3）。
 *
 * 判据是"同一学期里、同一门课、同一时段、同一周次"：
 * `name + weekday + periods + startTime + termStartDate + weekStart + weekEnd + parity`。
 *
 * `termStartDate` 参与比较是**必需的**：
 *
 *   · 语义上，2026 秋的高等数学与 2027 春的高等数学是两门不同的课；
 *   · 体验上，如果不比学期，用户每个新学期录课都要显式点一次
 *     「确实要再存一份」，久了就会条件反射地确认 —— 那才是真正让检查失效。
 *
 * 反过来看这条规则的代价：如果用户真的在同一学期里录了两条一模一样的课
 * （通常是口误或重复粘贴），仍然会被拦下来要求确认。这正是它该做的事。
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function isDuplicate(a, b) {
  if (!a || !b) return false;
  const norm = (c) => ({
    name: typeof c.name === 'string' ? c.name.trim() : '',
    weekday: Number(c.weekday),
    periods: periodsOf(c).join(','),
    startTime: typeof c.startTime === 'string' ? c.startTime.trim() : '',
    /*
     * `termStartDate` 必须参与比较。
     *
     * 契约最初只列了 7 个字段，于是"2026 秋的高等数学"和"2027 春的高等数学"
     * 会被判成重复 —— 用户每学期都要显式传一次 allowDuplicate 才能存进去。
     * 那不是"保护"，是逼用户对每个学期都说一句"我确定"，久了就会习惯性
     * 点确认，反而让这个检查失效。
     *
     * 学期不同 = 两门不同的课，这是日历事实，不需要用户确认。
     */
    termStartDate: typeof c.termStartDate === 'string' ? c.termStartDate.trim() : '',
    weekStart: Number(c.weekStart),
    weekEnd: Number(c.weekEnd),
    parity: String(c.parity ?? 'all'),
  });
  const na = norm(a);
  const nb = norm(b);
  for (const key of Object.keys(na)) {
    if (na[key] !== nb[key]) return false;
  }
  return true;
}

/**
 * 应用局部修改（`course_update` 的 `patch`）。
 *
 * 合并后跑完整归一化，因此"改完之后是否合法"与"新建时是否合法"永远是同一套规则
 * —— 这是 `update` 不需要第二套校验代码的原因，也避免了"新建拦住了、修改能存进去"。
 *
 * `id` / `createdAt` 从原记录保留（模型不可写）；`updatedAt` 不在这里管，
 * 它由存储层在落盘时统一打时间戳。
 *
 * @param {object} course 原课程（带 id）
 * @param {object} patch 局部字段
 * @returns {{ok: true, course: object} | {ok: false, message: string, issues: object[]}}
 */
export function applyPatch(course, patch) {
  if (!course || typeof course !== 'object') {
    return { ok: false, message: '原课程不存在', issues: [issue('course', 'invalid', '原课程不存在')] };
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, message: 'patch 必须是一个对象', issues: [issue('patch', 'invalid', 'patch 必须是一个对象')] };
  }

  // 不允许通过 patch 改 id / 时间戳：它们是标识，不是用户能编辑的内容
  const { id, createdAt, updatedAt, ...rest } = /** @type {any} */ (patch);
  void id;
  void createdAt;
  void updatedAt;

  const merged = { ...course, ...rest };
  const normalized = normalizeCourseInput(merged);
  if (!normalized.ok) {
    return { ok: false, message: normalized.message, issues: normalized.issues };
  }
  // 修改后必填项反而缺失（例如把 name 置空）→ 拒绝，而不是写一条残缺记录
  if (normalized.missing.length > 0) {
    const msg = `修改后缺少必要字段：${normalized.missing.join(', ')}`;
    return {
      ok: false,
      message: msg,
      issues: [issue(normalized.missing[0], 'missing', msg)],
    };
  }
  return {
    ok: true,
    course: {
      ...normalized.course,
      id: typeof course.id === 'string' ? course.id : '',
      createdAt: typeof course.createdAt === 'string' ? course.createdAt : '',
    },
  };
}

/**
 * 按"某天是否有课"的角度看一条课：星期对上、周次在范围内。
 *
 * 放在 model 而不是 time：它同时用到 `weekday`、周次区间与 parity，
 * 是"课程规则"而不是单纯的日期算术。`index.mjs` 的 day/week 查询直接用它。
 *
 * @param {object} course
 * @param {{weekday: number, week: number}} ctx 目标日的星期与周次
 * @returns {boolean}
 */
export function courseOnWeekdayWeek(course, ctx) {
  if (!course || !ctx) return false;
  if (Number(course.weekday) !== Number(ctx.weekday)) return false;
  const weeks = weeksInRange(course.weekStart, course.weekEnd, course.parity);
  return weeks.includes(Number(ctx.week));
}

/**
 * 计算"某天"的上下文（星期 + 学期周次 + 单双），供 day/week 查询使用。
 *
 * 一条课可以属于不同学期；给定日期时，候选学期 = `termStartDate <= date` 的记录，
 * 命中多个时取 `termStartDate` 最晚的那个（契约 §3.5）。
 *
 * 这里**不读时钟**：`date` 由调用方用 `time.todayInZone` 算好再传进来，
 * 保持本模块可测。
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {ReadonlyArray<object>} courses 该归属下的全部课程
 * @returns {{date: string, weekday: number, week: number, parity: string, termStartDate: string}}
 *   `termStartDate` 为空串表示这天的学期无法确定（没有课程或所有课程学期都在这天之后）
 */
export function dayContext(date, courses) {
  const weekday = weekdayOf(date);
  const list = Array.isArray(courses) ? courses : [];
  /** @type {string[]} */
  const terms = [];
  for (const c of list) {
    const t = typeof c?.termStartDate === 'string' ? c.termStartDate.trim() : '';
    if (t === '') continue;
    // 候选学期：开始日不晚于这天。字符串比较即可 —— `YYYY-MM-DD` 的字典序
    // 就是时间序，且不受时区影响
    if (t <= date && !terms.includes(t)) terms.push(t);
  }
  // 取最晚的那个（契约 §3.5：多个学期同时可能命中时以最近的学期为准）
  terms.sort();
  const termStartDate = terms.length > 0 ? terms[terms.length - 1] : '';
  // 周次口径统一交给 time.weekOf，本模块不再自带一份日期算术
  const week = termStartDate === '' ? Number.NaN : weekOf(date, termStartDate);
  return {
    date,
    weekday: Number.isInteger(weekday) ? weekday : Number.NaN,
    week,
    parity: Number.isInteger(week) ? parityOfWeek(week) : '',
    termStartDate,
  };
}

