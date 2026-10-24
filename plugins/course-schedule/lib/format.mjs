/**
 * 文本渲染 —— 课程表的"给人看"的那一层（纯函数）
 *
 * ## 为什么不能直接用 `padEnd`
 *
 * 群聊是等宽字体。中文、全角标点在终端里占 **2** 列，而 `'高等数学'.length === 4`
 * 只是"4 个码元"。用 `padEnd` 对齐的结果是第二行起整体错位，越往后越歪——
 * 用户看到的是一张斜的表。所以这里自己算"列宽"，再按列宽补空格。
 *
 * ## 为什么要截断
 *
 * 宿主单条消息上限 4000 字（契约 §8）。课程名上限 60 字、地点 80 字，真按上限
 * 填满时一张周表必然超限。截断**必须发生在渲染层**：`model.mjs` 负责让数据合法，
 * 渲染层负责让输出放得下，两件事分开才不会互相拉扯。
 *
 * ## 纯函数约定
 *
 * 不碰 IO、不持有状态；入参一律按"可能是脏数据"处理（缺字段、非字符串、非数组），
 * 因为本层的输入有时是磁盘上读回来的旧记录。
 */

/** 单行文本的默认宽度上限（契约 §8：表头最多 60 字符宽） */
export const MAX_LINE_WIDTH = 60;

/** 全局文本上限：宿主单条消息 4000 字 */
export const MAX_TEXT_LENGTH = 4000;

/** 空值占位。契约要求"不写未知以外的编造内容"，破折号表示"这里没有信息" */
export const EMPTY_CELL = '—';

/**
 * 码点是否占 2 列（东亚宽字符）。
 *
 * 范围按 Unicode East Asian Width 的 W / F 类粗分，不做完整表：
 * 课程表里出现的无非是汉字、平假名、全角标点、少量 emoji，这些段足够覆盖，
 * 漏掉的生僻字最多让某一列差 1 列，不影响可读性。
 *
 * @param {number} cp
 * @returns {boolean}
 */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // 康熙部首、CJK 部首、中文标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、注音、CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji（表情）
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后
  );
}

/**
 * 组合字符宽度 0：否则 `é`（e + 重音符）会被算成 2 列而让整列右移。
 *
 * @param {number} cp
 * @returns {boolean}
 */
function isZeroWidthCodePoint(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // 组合用变音符号
    cp === 0x200b || // 零宽空格
    cp === 0x200c ||
    cp === 0x200d || // ZWJ（emoji 组合）
    (cp >= 0xfe00 && cp <= 0xfe0f) // 变体选择符
  );
}

/**
 * 文本占多少显示列。
 *
 * @param {unknown} s
 * @returns {number}
 */
export function textWidth(s) {
  const str = s === undefined || s === null ? '' : String(s);
  let width = 0;
  // for..of 按码点迭代，代理对（emoji）不会拆成两半各算 1 列
  for (const ch of str) {
    if (ch === '\n' || ch === '\r') continue; // 换行不参与宽度（调用方保证单行）
    const cp = ch.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(cp)) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/**
 * 截到指定显示列宽，超出时末尾补 `…`（`…` 自身占 1 列，算在内）。
 *
 * @param {unknown} s
 * @param {number} max 目标列宽，<=0 时返回 ''
 * @returns {string}
 */
export function truncateWidth(s, max) {
  const str = s === undefined || s === null ? '' : String(s);
  const limit = Number.isFinite(max) ? Math.floor(max) : 0;
  if (limit <= 0) return '';
  if (textWidth(str) <= limit) return str;
  if (limit === 1) return '…';
  // 留 1 列给省略号
  const budget = limit - 1;
  let out = '';
  let used = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = isZeroWidthCodePoint(cp) ? 0 : isWideCodePoint(cp) ? 2 : 1;
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/**
 * 按显示列宽左对齐（右侧补空格）。
 *
 * @param {unknown} s
 * @param {number} width
 * @returns {string}
 */
export function padEndWidth(s, width) {
  const str = s === undefined || s === null ? '' : String(s);
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const gap = w - textWidth(str);
  return gap > 0 ? str + ' '.repeat(gap) : str;
}

/**
 * 按显示列宽右对齐（左侧补空格）。数字列（节次、周次）用它。
 *
 * @param {unknown} s
 * @param {number} width
 * @returns {string}
 */
export function padStartWidth(s, width) {
  const str = s === undefined || s === null ? '' : String(s);
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const gap = w - textWidth(str);
  return gap > 0 ? ' '.repeat(gap) + str : str;
}

/**
 * 单元格取值：空字符串 / null / undefined 统一显示破折号。
 *
 * 契约 §8 的"不编造"要求空地点显示 `—` 而不是"未知"或"待定"——
 * 前者一眼看出是空缺，后者会被误读成已知信息。
 *
 * @param {unknown} v
 * @returns {string}
 */
function cell(v) {
  if (v === undefined || v === null) return EMPTY_CELL;
  const s = String(v).replace(/[\r\n]+/g, ' ').trim();
  return s === '' ? EMPTY_CELL : s;
}

/**
 * 渲染等宽表格（中文按 2 列宽对齐）。
 *
 * ## 列宽怎么定
 *
 * 先取每列的自然宽度（表头与所有单元格的最大值），再按 `maxWidth` 收窄：
 * 每次从当前**最宽**的列减 1 列，直到放得下或全都到下限。这样长课程名会先被
 * 截断，而"星期""节次"这类短列不会被连坐——表格里最该保住的正是窄的固定列。
 *
 * @param {ReadonlyArray<unknown>} headers
 * @param {ReadonlyArray<ReadonlyArray<unknown>>} rows
 * @param {{maxWidth?: number, sep?: string}} [opts]
 *   maxWidth 整行最大列宽（默认 60）；sep 列分隔符（默认 ' | '）
 * @returns {string} 含表头行与分隔行；没有数据行时也返回表头（便于"这天没课"）
 */
export function renderTable(headers, rows, opts = {}) {
  const head = Array.isArray(headers) ? headers.map(cell) : [];
  if (head.length === 0) return '';
  const body = Array.isArray(rows) ? rows : [];
  const sep = typeof opts.sep === 'string' ? opts.sep : ' | ';
  const maxWidth = Number.isFinite(opts.maxWidth) ? Math.floor(opts.maxWidth) : MAX_LINE_WIDTH;
  const cols = head.length;

  /** @type {number[]} */
  const widths = head.map((h) => textWidth(h));
  for (const row of body) {
    const cells = Array.isArray(row) ? row : [];
    for (let i = 0; i < cols; i += 1) {
      const w = textWidth(cell(cells[i]));
      if (w > widths[i]) widths[i] = w;
    }
  }

  // 下限：表头宽度，但最多 4 列——表头本身很窄，保它是为了"知道哪列是什么"
  const minWidths = head.map((h) => Math.min(textWidth(h), 4));
  let total = widths.reduce((a, b) => a + b, 0) + sep.length * (cols - 1);
  while (total > maxWidth) {
    // 找当前可收窄的列里最宽的一列；一样宽时靠前的先让，结果才稳定可测
    let pick = -1;
    for (let i = 0; i < cols; i += 1) {
      if (widths[i] <= minWidths[i]) continue;
      if (pick < 0 || widths[i] > widths[pick]) pick = i;
    }
    if (pick < 0) break; // 已经全部到下限，宁可超宽也不把表头截成乱码
    widths[pick] -= 1;
    total -= 1;
  }

  const headLine = head.map((h, i) => padEndWidth(truncateWidth(h, widths[i]), widths[i])).join(sep);
  const lines = [headLine];
  for (const row of body) {
    const cells = Array.isArray(row) ? row : [];
    lines.push(
      widths
        .map((w, i) => padEndWidth(truncateWidth(cell(cells[i]), w), w))
        .join(sep),
    );
  }
  // 用等号分隔表头：`|` 在数据里也可能出现，等号行不会混淆
  lines.splice(1, 0, widths.map((w) => '='.repeat(w)).join(sep));
  return lines.join('\n');
}

/**
 * 把 `periods` 数组写成"1-2" / "1,3" 形式；没有节次时返回 ''。
 *
 * 相邻节次合并成区间：课表里"1-2 节"是习惯写法，比"1,2"短且好读。
 *
 * @param {unknown} periods
 * @returns {string}
 */
export function periodsLabel(periods) {
  if (!Array.isArray(periods) || periods.length === 0) return '';
  const list = periods
    .map((v) => (Number.isInteger(v) ? v : Number(v)))
    .filter((v) => Number.isInteger(v))
    .sort((a, b) => a - b);
  if (list.length === 0) return '';
  // 去重（保序，已排序）
  const uniq = list.filter((v, i) => i === 0 || v !== list[i - 1]);
  /** @type {string[]} */
  const parts = [];
  let start = uniq[0];
  let prev = uniq[0];
  for (let i = 1; i <= uniq.length; i += 1) {
    const cur = uniq[i];
    if (cur !== undefined && cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    if (cur !== undefined) {
      start = cur;
      prev = cur;
    }
  }
  return parts.join(',');
}

/**
 * 周次文字，如 `1-16周` / `1-16周(单)` / `3周`。
 *
 * @param {object} c 归一化后的课程对象
 * @returns {string}
 */
export function weeksLabel(c) {
  const start = Number(c?.weekStart);
  const end = Number(c?.weekEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return '';
  const range = start === end ? `${start}` : `${start}-${end}`;
  const parity = String(c?.parity ?? 'all');
  if (parity === 'odd') return `${range}周(单)`;
  if (parity === 'even') return `${range}周(双)`;
  return `${range}周`;
}

/**
 * 课程的一行表格单元格：星期 | 节次 | 课程 | 地点 | 教师 | 周次（契约 §8 的列序）。
 *
 * 节次列优先用 `periods`；只有时间的课用 `08:00-09:40`——契约 §2 说两者可并存，
 * 并存时表格主键是节次，所以时间只在没有节次时出现。
 *
 * @param {object} c
 * @returns {string[]}
 */
export function courseRow(c) {
  const course = c && typeof c === 'object' ? c : {};
  const weekdayNum = Number(course.weekday);
  // 与 model.WEEKDAY_CN 同值；这里内联一份是为了让渲染层不依赖 model 的加载顺序
  const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekday = Number.isInteger(weekdayNum) && weekdayNum >= 1 && weekdayNum <= 7
    ? weekdayNames[weekdayNum]
    : '';
  const periods = periodsLabel(course.periods);
  const start = typeof course.startTime === 'string' ? course.startTime : '';
  const end = typeof course.endTime === 'string' ? course.endTime : '';
  const slot = periods !== '' ? `${periods}节` : start && end ? `${start}-${end}` : '';
  return [
    weekday,
    slot,
    course.name,
    course.location,
    course.teacher,
    weeksLabel(course),
  ];
}

/** 表格列名（契约 §8）。导出是为了让 index.mjs 与测试引用同一份，不要各写一份。 */
export const COURSE_TABLE_HEADERS = Object.freeze(['星期', '节次', '课程', '地点', '教师', '周次']);

/**
 * 一组课程的表格。
 *
 * @param {ReadonlyArray<object>} courses
 * @param {{maxWidth?: number, empty?: string}} [opts]
 * @returns {string}
 */
export function renderCourseTable(courses, opts = {}) {
  const list = Array.isArray(courses) ? courses : [];
  const table = renderTable(COURSE_TABLE_HEADERS, list.map(courseRow), opts);
  if (list.length === 0 && typeof opts.empty === 'string' && opts.empty !== '') {
    return `${table}\n${opts.empty}`;
  }
  return table;
}

/**
 * 课程清单：一条一行，**带 id**（用户说"把 3f8a 那节删了"时模型要能对上号）。
 *
 * 表格适合"看时间"，清单适合"看全部字段 + 拿 id 去改"。两者都保留，
 * 因为 index.mjs 的 `course_list` 要同时给出 `table` 和可引用的 id。
 *
 * @param {ReadonlyArray<object>} courses
 * @returns {string} 空数组时返回 '（暂无课程）'
 */
export function renderCourseList(courses) {
  const list = Array.isArray(courses) ? courses : [];
  if (list.length === 0) return '（暂无课程）';
  return list
    .map((c) => {
      const course = c && typeof c === 'object' ? c : {};
      const row = courseRow(course).map((v) => (v === '' ? EMPTY_CELL : v));
      const id = typeof course.id === 'string' && course.id !== '' ? course.id : EMPTY_CELL;
      // 学期起止单独标出来：跨学期多条时，不写学期就分不清哪张表
      const term = typeof course.termStartDate === 'string' && course.termStartDate !== ''
        ? ` 学期自 ${course.termStartDate}`
        : '';
      const note = typeof course.note === 'string' && course.note.trim() !== ''
        ? ` 备注：${course.note.trim()}`
        : '';
      return `${id} | ${row.join(' | ')}${term}${note}`;
    })
    .join('\n');
}

/**
 * 长度裁剪到 `max` 字符（按码点计，不是 UTF-16 码元），超出时追加提示。
 *
 * 提示语里不带"仅显示前 N 条"这种具体数字：截断可能发生在任意位置
 * （表格中间、列表中间），说"条"反而是错的；"内容过长，已截断"永远成立。
 *
 * @param {unknown} s
 * @param {number} [max]
 * @returns {string}
 */
export function clampText(s, max = MAX_TEXT_LENGTH) {
  const str = s === undefined || s === null ? '' : String(s);
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : MAX_TEXT_LENGTH;
  const chars = Array.from(str);
  if (chars.length <= limit) return str;
  const suffix = '\n…（内容过长，已截断）';
  const suffixLen = Array.from(suffix).length;
  if (limit <= suffixLen) {
    // 上限比提示语还短：只能硬截，保证总长不超
    return chars.slice(0, limit).join('');
  }
  return chars.slice(0, limit - suffixLen).join('') + suffix;
}
