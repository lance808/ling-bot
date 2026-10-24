/**
 * 课程表插件入口 —— 自然语言 → 结构化 → 预览确认 → 保存 → 查询 / 修改 / 删除
 *
 * ## 这个插件为什么长成这样
 *
 * 课程表是**用户自己的数据**，不是模型的草稿纸。所以有三条硬规则贯穿全文：
 *
 * 1. **归属只能来自宿主。** 每次调用都从 `ctx.caller` 取 `convKey` 与
 *    `requester.id`，工具参数里没有任何"用户/会话"字段（清单里也不可能有，
 *    宿主把 `convKey` / `caller` 列为保留参数名）。模型想让插件读别人的课表，
 *    在能力层面就写不出来。
 * 2. **保存的就是用户看到的那份。** `course_preview` 把归一化后的课程存进
 *    内存草案并返回 `draftId`；`course_save` **只收 draftId**，不收课程内容。
 *    否则模型可以在"展示表格"和"保存"之间偷偷改一个地点或时间，而用户
 *    以为自己确认了表格里的内容。
 * 3. **不编造。** 地点、教师、学期开始日期缺失时，预览只会标出来并要求追问，
 *    绝不填默认值。时间冲突 / 重复课程也不会被静默丢弃——要么拒绝，要么
 *    需要显式确认。
 *
 * ## 草案为什么放在内存而不是磁盘
 *
 * 草案是"用户正在确认中的一次输入"，不是数据。落盘会带来两个问题：
 * 重启后它还在（用户早就忘了这张表）、以及需要一个清理机制。
 * 放内存则天然满足"重启即失效"，过期由 `draftTtlMs` 控制，上限 20 条防泄漏。
 *
 * ## 模块分工
 *
 *   lib/time.mjs    日期 / 周次 / 单双周 / 时区（纯函数）
 *   lib/model.mjs   字段归一化 / 校验 / 冲突 / 重复（纯函数）
 *   lib/store.mjs   归属 / 原子写 / 并发 / 损坏检测（唯一 IO）
 *   lib/format.mjs  文本表格（纯函数）
 *   index.mjs       编排：参数 → 模型 → 存储 → 文本
 */

import crypto from 'node:crypto';

import {
  mondayOf,
  weekOf,
  parityOfWeek,
  todayInZone,
  isValidDate,
  formatDateCn,
  addDays,
} from './lib/time.mjs';
import {
  normalizeCourseInput,
  validateStoredCourse,
  newCourseId,
  findConflicts,
  isDuplicate,
  applyPatch,
  WEEKDAY_CN,
  PARITY_CN,
} from './lib/model.mjs';
import { CourseStore, StorageCorrupt, ownerFromCaller, sameOwner } from './lib/store.mjs';
import { renderTable, courseRow, renderCourseList, clampText } from './lib/format.mjs';

/** 草案上限：超过后淘汰最旧的 */
const MAX_DRAFTS = 20;

/** 单次预览最多接收多少条课程（与清单 maxItems 对齐，双保险） */
const MAX_PREVIEW_COURSES = 20;

/**
 * 待确认草案表（模块级）。
 *
 * key = draftId，value = { id, owner, entries, termStartDate, createdAt, expiresAt }
 *
 * 并发上不需要锁：Node 单线程 + 这里全是同步读写，插入与删除之间没有 await。
 */
/** @type {Map<string, any>} */
const drafts = new Map();

/** 当前运行状态（init 时写入） */
/** @type {{store: CourseStore | null, config: any}} */
let runtime = { store: null, config: {} };

/* ==================================================================== 工具 */

/**
 * 统一失败结果。
 *
 * 插件返回 `{ok:false, code, message}` 是**合法的工具结果**，会回灌给模型，
 * 不是宿主异常。用它表达"业务上没成功"，模型才知道下一步该问什么。
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 */
function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * 取归属，取不到就报错。
 *
 * 刻意**不**兜底成"某个默认库"：那等于让所有拿不到会话的调用共享一份数据，
 * 其中任何人都会读到别人的课表。
 *
 * @param {any} ctx
 * @returns {{ok: true, owner: any} | {ok: false, code: string, message: string}}
 */
function requireOwner(ctx) {
  const owner = ownerFromCaller(ctx?.caller);
  if (!owner) {
    return {
      ok: false,
      code: 'E_COURSE_NO_IDENTITY',
      message: '无法确定这份课程表属于谁：本次调用没有可信会话上下文（ctx.caller）。请让用户在具体会话里再试。',
    };
  }
  return { ok: true, owner };
}

/**
 * 取存储实例。
 *
 * init 没跑过（宿主直接调工具、或单测里跳过 init）时按 `ctx.dataDir` 懒建，
 * 免得因为生命周期顺序的细节报一个看不懂的错。
 *
 * @param {any} ctx
 */
function storeOf(ctx) {
  const dataDir = String(ctx?.dataDir ?? ctx?.plugin?.dataDir ?? '');
  if (!dataDir) {
    throw Object.assign(new Error('宿主没有提供插件数据目录（ctx.dataDir）'), { code: 'E_COURSE_NO_STORE' });
  }
  if (!runtime.store || runtime.store.dataDir !== dataDir) {
    runtime.store = new CourseStore({ dataDir, log: (l, m, f) => ctx?.log?.(l, m, f) });
  }
  return runtime.store;
}

/**
 * 当前生效配置（合并默认值）。
 *
 * 每次都从 ctx.config 现读：宿主保存配置后会 dispose → init，但工具也可能
 * 在 init 之前被直接调用，现读是最不容易错的做法。
 *
 * @param {any} ctx
 */
function configOf(ctx) {
  const c = ctx?.config ?? runtime.config ?? {};
  const tz = String(c.timezone ?? '').trim() || 'Asia/Shanghai';
  const maxCoursesRaw = Number(c.maxCourses ?? 60);
  const ttlRaw = Number(c.draftTtlMs ?? 900_000);
  return {
    timezone: tz,
    defaultTermStartDate: String(c.defaultTermStartDate ?? '').trim(),
    maxCourses: Number.isInteger(maxCoursesRaw) && maxCoursesRaw >= 1 ? Math.min(maxCoursesRaw, 200) : 60,
    draftTtlMs: Number.isInteger(ttlRaw) && ttlRaw >= 60_000 ? Math.min(ttlRaw, 3_600_000) : 900_000,
  };
}

/**
 * 把存储异常翻译成工具结果。
 *
 * 这一步存在的意义：`StorageCorrupt` 必须原样报给模型与用户（含文件路径），
 * 而不是被包成一句含糊的"插件出错"。用户在群里看到的应该是
 * "数据文件坏了，需要你确认怎么处理"，而不是"工具失败"。
 *
 * @param {unknown} err
 */
function storeFail(err) {
  const e = /** @type {any} */ (err);
  if (e instanceof StorageCorrupt || e?.code === 'E_COURSE_STORE_CORRUPT') {
    return fail('E_COURSE_STORE_CORRUPT', String(e.message ?? '课程表数据损坏'), {
      file: e.file ?? '',
      hint: '数据文件没有被当成空库，也没有被覆盖。需要用户确认后才能重置（course_delete: all=true, forceCorrupt=true）。',
    });
  }
  return fail('E_COURSE_IO', `课程表读写失败：${String(e?.message ?? e)}`);
}

/* ------------------------------------------------------------------ 草案 */

/**
 * 生成草案 id。
 *
 * 用随机串而不是自增：自增在重启后从头开始，日志里两次不同草案会撞号。
 * 前缀 `d_` 让它在日志/返回里一眼可辨。
 */
function newDraftId() {
  return `d_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 清理过期草案。
 *
 * 在每次创建/查找时顺手做，不另设定时器：插件被停用时不必收尾，
 * 也不会因为一个忘掉的 interval 让宿主进程退不出去。
 */
function sweepDrafts(now = Date.now()) {
  for (const [id, d] of drafts) {
    if (d.expiresAt <= now) drafts.delete(id);
  }
}

/**
 * 容量控制：超过上限时淘汰最旧的。
 */
function trimDrafts() {
  while (drafts.size > MAX_DRAFTS) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const [id, d] of drafts) {
      if (d.createdAt < oldestAt) {
        oldestAt = d.createdAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    drafts.delete(oldestId);
  }
}

/* ------------------------------------------------------- 工具：course_preview */

/**
 * 整理并预览。
 *
 * 返回的 `courses` 是**归一化后**的课程（没有 id，因为还没存），每条附
 * `issues`。`missing` / `optionalMissing` 是给模型看的追问清单。
 *
 * @param {any} ctx
 * @param {any} args
 */
async function toolPreview(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  const cfg = configOf(ctx);
  const store = storeOf(ctx);

  const rawCourses = Array.isArray(args?.courses) ? args.courses : null;
  if (!rawCourses) {
    return fail('E_COURSE_BAD_ARG', '参数 courses 必须是课程数组（每条是一个对象）');
  }
  if (rawCourses.length === 0) {
    return fail('E_COURSE_BAD_ARG', 'courses 是空数组：至少给一条课程');
  }
  if (rawCourses.length > MAX_PREVIEW_COURSES) {
    return fail('E_COURSE_LIMIT', `一次最多预览 ${MAX_PREVIEW_COURSES} 条课程，请分批处理`);
  }

  // 整批共用的学期开始日期（用户说"这学期的课"时通常只给一次）
  const batchTerm = String(args?.termStartDate ?? '').trim();
  if (batchTerm && !isValidDate(batchTerm)) {
    return fail('E_COURSE_BAD_ARG', `termStartDate「${batchTerm}」不是合法日期（应为 YYYY-MM-DD）`, {
      field: 'termStartDate',
    });
  }

  // 已有课程：冲突与重复都要跟它们比。读不出来（损坏）时**不能**继续 ——
  // 否则"看起来没有冲突"会让用户存进一份必然冲突的数据。
  let existing = [];
  try {
    const doc = await store.read(o.owner);
    existing = doc.courses;
  } catch (err) {
    return storeFail(err);
  }

  /** @type {any[]} */
  const entries = [];
  /** @type {any[]} */
  const conflicts = [];
  /** @type {any[]} */
  const duplicates = [];
  /** @type {string[]} */
  const warnings = [];

  for (let i = 0; i < rawCourses.length; i++) {
    const raw = rawCourses[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      entries.push({
        index: i,
        ok: false,
        course: null,
        issues: [{ field: 'courses', code: 'not_object', message: `第 ${i + 1} 条不是对象` }],
        missing: ['name', 'weekday', 'time', 'termStartDate', 'weeks'],
        optionalMissing: [],
      });
      continue;
    }

    /*
     * 学期开始日期的来源优先级：
     *   1. 这条课程自己写的
     *   2. 整批共用的 termStartDate
     *   3. 配置里的**建议值**（只会作为假设出现在预览里，仍要求确认）
     *
     * 三条都没有时，`missing` 里会包含 termStartDate —— 这是"必须追问"的信号。
     *
     * ## 为什么批量日期要在**这里**填进 raw，而不是交给 model 当默认值
     *
     * 两者的语义不同：`termStartDate` 参数是调用方（模型代表用户）明确给出的，
     * 等同于"每条都写了这个日期"；而 `defaultTermStartDate` 是配置里的建议，
     * 用户从没确认过。model 只能看到一个 `termStartDateDefault`，如果两种来源
     * 都塞进去，它就分不清该不该把 `termStartDate` 记进 `missing`。
     *
     * 所以分层处理：批量日期在这里直接写进 raw（用户给了，不算缺），
     * 配置建议值才走 model 的 `termStartDateDefault`（算缺，要确认）。
     */
    const courseTerm = String(raw.termStartDate ?? '').trim();
    // 批量日期 = 调用方明确给出 → 直接当作每条都写了（不算"缺失"）
    const seeded = courseTerm || !batchTerm ? raw : { ...raw, termStartDate: batchTerm };
    const seedDefault = courseTerm || batchTerm ? '' : cfg.defaultTermStartDate;

    const norm = normalizeCourseInput(seeded, {
      termStartDateDefault: seedDefault,
    });

    if (!norm.ok) {
      entries.push({
        index: i,
        ok: false,
        course: null,
        issues: norm.issues ?? [{ field: '', code: 'bad', message: norm.message }],
        missing: ['name', 'weekday', 'time', 'termStartDate', 'weeks'],
        optionalMissing: [],
      });
      warnings.push(`第 ${i + 1} 条无法解析：${norm.message}`);
      continue;
    }

    const missing = Array.isArray(norm.missing) ? norm.missing : [];
    const optionalMissing = Array.isArray(norm.optionalMissing) ? norm.optionalMissing : [];
    const issues = Array.isArray(norm.issues) ? norm.issues : [];
    /*
     * docs §4：`optionalMissing` 非空的记录要带一句可直接转述的 `askUser`。
     *
     * 只给 `optionalMissing` 不够——模型看到的是一个字段名列表，
     * 它得自己组织成"请先问用户，不要编造"，而那正是最容易丢的一步。
     * 把话写死在返回里，模型照着念就行。
     */
    const askUser = buildAskUser(optionalMissing);

    let entryConflicts = [];
    let duplicateOf = null;

    if (missing.length === 0) {
      /*
       * 冲突要跟**两批**课程比：
       *   · existing —— 已经保存的（同一个人之前存过的课）
       *   · entries 里前几条 —— 同一批里的（用户一次说"周一 1-2 高数、周一 2-3 物理"，
       *     这两条自己就撞了，不跟已存课程比就查不出来）
       *
       * 早先只比 existing，于是"同一批里互相冲突"要等到保存那次才被发现，
       * 而那时用户已经看过一张"看起来没问题"的预览表了。
       */
      const earlier = entries
        .filter((e) => e.ok && e.course)
        .map((e, idx) => ({ ...e.course, id: `c_${String(idx).padStart(8, '0')}` }));

      entryConflicts = findConflicts(norm.course, existing, {});
      for (const prior of earlier) {
        const pair = findConflicts(norm.course, [prior], {});
        for (const one of pair) {
          entryConflicts.push({ ...one, withName: `${one.withName}（同批第 ${earlier.indexOf(prior) + 1} 条）` });
        }
      }
      for (const c of entryConflicts) conflicts.push({ courseIndex: i, ...c });

      const dup = existing.find((e) => isDuplicate(e, norm.course));
      if (dup) {
        duplicateOf = { courseId: dup.id, name: dup.name };
        duplicates.push({ courseIndex: i, courseId: dup.id, name: dup.name });
      }
      const dupInBatch = earlier.find((e) => isDuplicate(e, norm.course));
      if (!duplicateOf && dupInBatch) {
        duplicateOf = { courseId: '', name: `${dupInBatch.name}（同批）` };
        duplicates.push({ courseIndex: i, courseId: '', name: dupInBatch.name, inBatch: true });
      }
    }

    entries.push({
      index: i,
      ok: missing.length === 0,
      course: norm.course,
      issues,
      missing,
      optionalMissing,
      askUser,
      conflicts: entryConflicts,
      duplicateOf,
    });
  }

  const now = Date.now();
  sweepDrafts(now);

  const draftId = newDraftId();
  const expiresAt = now + cfg.draftTtlMs;
  drafts.set(draftId, {
    id: draftId,
    owner: o.owner,
    entries,
    termStartDate: batchTerm || null,
    createdAt: now,
    expiresAt,
  });
  trimDrafts();

  const saveable = entries.filter((e) => e.ok);
  const table = renderTable(
    ['星期', '节次', '课程', '地点', '教师', '周次'],
    saveable.map((e) => courseRow(e.course)),
  );

  const missingAll = [...new Set(entries.flatMap((e) => e.missing ?? []))];

  return {
    ok: true,
    draftId,
    count: entries.length,
    saveableCount: saveable.length,
    courses: entries.map((e) => ({
      index: e.index,
      ok: e.ok,
      course: e.course,
      issues: e.issues,
      missing: e.missing,
      optionalMissing: e.optionalMissing,
      // 只有确实缺了建议字段才带这一句；否则返回一个空字段只会让模型误以为要追问
      ...(e.askUser ? { askUser: e.askUser } : {}),
      conflicts: e.conflicts ?? [],
      duplicateOf: e.duplicateOf ?? null,
    })),
    table,
    missing: missingAll,
    optionalMissing: [...new Set(entries.flatMap((e) => e.optionalMissing ?? []))],
    conflicts,
    duplicates,
    warnings,
    expiresAt,
    requiresConfirmation: true,
    hints: buildPreviewHints({ entries, missingAll, conflicts, duplicates }),
  };
}

/**
 * docs §4：把 `optionalMissing` 变成一句模型可以直接转述的话。
 *
 * @param {string[]} optionalMissing
 * @returns {string} 没有缺项时返回空串
 */
function buildAskUser(optionalMissing) {
  const parts = [];
  for (const field of optionalMissing) {
    const label = field === 'location' ? '地点' : field === 'teacher' ? '教师' : field;
    parts.push(`${label}未提供：请先向用户确认，不要自行编造。`);
  }
  return parts.join(' ');
}

/**
 * 给模型的下一步提示。
 *
 * 这一段是刻意写成"可直接转述"的中文句子：模型在群里被追问时，
 * 最容易出错的是自由发挥（自己编一个地点）。把话写出来，它照着说就好。
 */
function buildPreviewHints({ entries, missingAll, conflicts, duplicates }) {
  /** @type {string[]} */
  const hints = [];
  if (missingAll.length > 0) {
    hints.push(`还缺这些信息：${missingAll.join('、')}。请先向用户确认，不要自行编造。`);
  }
  for (const e of entries) {
    if ((e.optionalMissing ?? []).includes('location')) {
      hints.push(`第 ${e.index + 1} 条没给地点：请先问用户上课地点，不要编造。`);
    }
    if ((e.optionalMissing ?? []).includes('teacher')) {
      hints.push(`第 ${e.index + 1} 条没给教师：可问用户，用户说不知道就留空。`);
    }
  }
  if (conflicts.length > 0) {
    hints.push('存在时间冲突（见 conflicts）。请把冲突说清楚，用户确认要保留时才传 overwriteConflicts。');
  }
  if (duplicates.length > 0) {
    hints.push('有课程与已保存的记录重复（见 duplicates）。确认用户真的要再存一份时才传 allowDuplicate。');
  }
  hints.push('请把上面的课程表格展示给用户，等用户明确同意后再调用 course_save（只传 draftId）。');
  return hints;
}

/* ---------------------------------------------------------- 工具：course_save */

/**
 * 保存草案。
 *
 * 只认 draftId，内容来自草案 —— 这样"保存的"与"用户看到的"必然是同一份。
 *
 * @param {any} ctx
 * @param {any} args
 */
async function toolSave(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  const cfg = configOf(ctx);
  const store = storeOf(ctx);

  const draftId = String(args?.draftId ?? '').trim();
  if (!draftId) return fail('E_COURSE_BAD_ARG', '缺少 draftId：请先调用 course_preview 生成预览');

  const now = Date.now();
  sweepDrafts(now);

  const draft = drafts.get(draftId);
  if (!draft) {
    return fail(
      'E_COURSE_DRAFT_MISSING',
      '这份草案不存在或已过期（草案只在生成后 15 分钟内有效，重启后也会失效）。请重新调用 course_preview。',
    );
  }
  if (!sameOwner(draft.owner, o.owner)) {
    // 归属不符时报"不存在"而不是"别人的"：区分两者等于给人一个探测手段
    return fail('E_COURSE_DRAFT_MISSING', '这份草案不存在或已过期。请重新调用 course_preview。');
  }

  const entries = draft.entries ?? [];
  const incomplete = entries.filter((e) => !e.ok);
  if (incomplete.length > 0) {
    return fail(
      'E_COURSE_NEEDS_INFO',
      `还有 ${incomplete.length} 条课程信息不完整，不能保存。缺少：${[...new Set(incomplete.flatMap((e) => e.missing ?? []))].join('、')}`,
      { missing: [...new Set(incomplete.flatMap((e) => e.missing ?? []))] },
    );
  }

  const optionalMissing = [...new Set(entries.flatMap((e) => e.optionalMissing ?? []))];
  if (optionalMissing.length > 0 && args?.acknowledgeOptionalMissing !== true) {
    const labels = optionalMissing.map((k) => (k === 'location' ? '地点' : k === 'teacher' ? '教师' : k));
    return fail(
      'E_COURSE_NEEDS_INFO',
      `有课程缺少${labels.join('、')}。请先向用户确认这些内容，或让用户明确表示「就空着」后再保存（acknowledgeOptionalMissing=true）。`,
      { optionalMissing, askUser: `请确认${labels.join('、')}，不要自行编造。` },
    );
  }

  const candidates = entries.map((e) => e.course);
  const stamp = new Date().toISOString();
  /** @type {any[]} */
  const saved = [];
  /** @type {any[]} */
  let conflictsSeen = [];
  /** @type {any[]} */
  let duplicatesSeen = [];

  try {
    await store.update(o.owner, (doc) => {
      const courses = Array.isArray(doc.courses) ? doc.courses : [];
      if (courses.length + candidates.length > cfg.maxCourses) {
        throw Object.assign(
          new Error(
            `保存后会超过每人 ${cfg.maxCourses} 条课程的上限（当前 ${courses.length} 条，本次 ${candidates.length} 条）。请先删除一些旧课程，或让用户确认分批保存。`,
          ),
          { code: 'E_COURSE_LIMIT' },
        );
      }

      /*
       * 冲突与重复在**写盘这一次**重新算，而不是沿用预览时的结果。
       *
       * 草案是快照，用户确认可能隔着几十秒；这期间同一个人（或同一个人
       * 在另一个会话里）可能又存了一门课。沿用旧结论会出现"预览时说没冲突、
       * 保存后真的撞车"，而这是课程表最不该有的错。
       */
      conflictsSeen = [];
      duplicatesSeen = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        for (let j = 0; j < i; j++) {
          const other = { ...candidates[j], id: `c_${String(j).padStart(8, '0')}` };
          const pair = findConflicts(c, [other], { excludeId: '' });
          if (pair.length > 0) conflictsSeen.push({ courseIndex: i, withCourseIndex: j, ...pair[0] });
          /*
           * 同一批内部的重复也要拦（docs §5.3：同一归属下字段完全相同的
           * 两条记录视为重复，save 默认拒绝）。
           *
           * 预览会标 `inBatch: true` 的 duplicateOf，但保存不能沿用预览的
           * 结论——而"两条一样的课"一旦写进去，之后每次查询/冲突判定都要
           * 带着这份重复。所以在这里与"已有记录"同等对待：allowDuplicate
           * 是唯一的放行方式。
           */
          if (isDuplicate(candidates[j], c)) {
            duplicatesSeen.push({
              courseIndex: i,
              withCourseIndex: j,
              courseId: '',
              name: String(candidates[j].name ?? ''),
              inBatch: true,
            });
          }
        }
        for (const existingCourse of courses) {
          const found = findConflicts(c, [existingCourse], {});
          if (found.length > 0) conflictsSeen.push({ courseIndex: i, ...found[0] });
          if (isDuplicate(existingCourse, c)) {
            duplicatesSeen.push({ courseIndex: i, courseId: existingCourse.id, name: existingCourse.name });
          }
        }
      }

      if (conflictsSeen.length > 0 && args?.overwriteConflicts !== true) {
        throw Object.assign(new Error(`有 ${conflictsSeen.length} 处时间冲突，未保存`), {
          code: 'E_COURSE_CONFLICT',
          conflicts: conflictsSeen,
        });
      }
      if (duplicatesSeen.length > 0 && args?.allowDuplicate !== true) {
        throw Object.assign(new Error(`有 ${duplicatesSeen.length} 条课程与已保存的记录完全相同`), {
          code: 'E_COURSE_DUPLICATE',
          duplicates: duplicatesSeen,
        });
      }

      for (const c of candidates) {
        const course = {
          ...c,
          id: newCourseId(),
          createdAt: stamp,
          updatedAt: stamp,
        };
        // 双保险：写盘前再验一遍形状（normalizeCourseInput 已经验过，但存储层
        // 是唯一会被别的路径（如 applyPatch）绕过的入口，这里不能只信上游）
        const v = validateStoredCourse(course);
        if (!v.ok) throw Object.assign(new Error(`准备保存的课程不合法：${v.message}`), { code: 'E_COURSE_BAD_ARG' });
        courses.push(v.course);
        saved.push(v.course);
      }
      doc.courses = courses;
      return doc;
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === 'E_COURSE_LIMIT') return fail('E_COURSE_LIMIT', String(e.message));
    if (e?.code === 'E_COURSE_CONFLICT') {
      return fail(
        'E_COURSE_CONFLICT',
        `${String(e.message)}。请把冲突告诉用户；用户确认要保留时再传 overwriteConflicts=true。`,
        { conflicts: e.conflicts ?? [] },
      );
    }
    if (e?.code === 'E_COURSE_DUPLICATE') {
      return fail(
        'E_COURSE_DUPLICATE',
        `${String(e.message)}。确认用户真的要再存一份时传 allowDuplicate=true。`,
        { duplicates: e.duplicates ?? [] },
      );
    }
    if (e instanceof StorageCorrupt || e?.code === 'E_COURSE_STORE_CORRUPT') return storeFail(e);
    if (e?.code === 'E_COURSE_BAD_ARG') return fail('E_COURSE_BAD_ARG', String(e.message));
    return storeFail(e);
  }

  // 保存成功才丢弃草案：失败时用户还能重试，不用重新预览
  drafts.delete(draftId);

  return {
    ok: true,
    saved: saved.length,
    count: saved.length,
    courses: saved,
    table: renderTable(['星期', '节次', '课程', '地点', '教师', '周次'], saved.map((c) => courseRow(c))),
    list: renderCourseList(saved),
  };
}

/* -------------------------------------------------------- 工具：course_cancel */

/**
 * 丢弃草案。
 *
 * @param {any} ctx
 * @param {any} args
 */
async function toolCancel(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  sweepDrafts();

  const draftId = String(args?.draftId ?? '').trim();
  if (draftId) {
    const d = drafts.get(draftId);
    if (!d || !sameOwner(d.owner, o.owner)) {
      return { ok: true, cancelled: 0 };
    }
    drafts.delete(draftId);
    return { ok: true, cancelled: 1 };
  }

  let n = 0;
  for (const [id, d] of drafts) {
    if (sameOwner(d.owner, o.owner)) {
      drafts.delete(id);
      n++;
    }
  }
  return { ok: true, cancelled: n };
}

/* ----------------------------------------------------------- 工具：course_day */

/**
 * 某个归属在某一天有哪些课。
 *
 * ## 学期怎么选
 *
 * 同一用户可能有多个学期（`termStartDate` 不同）。这里先看"哪些课在这一天
 * 真的成立"，若有则取学期开始日最晚的那个 —— 它一定是用户当前更关心的。
 * 若一条都不成立，再退回"最近的学期"，用于回答"今天没课，现在是第几周"。
 *
 * @param {any[]} courses
 * @param {string} date
 */
function dayView(courses, date) {
  const weekday = weekdayNumber(date);

  /** @type {any[]} */
  const applicable = [];
  for (const c of courses) {
    const week = weekOf(date, c.termStartDate);
    const inRange = week >= c.weekStart && week <= c.weekEnd;
    const parityOk = c.parity === 'all' || c.parity === parityOfWeek(week);
    if (week >= 1 && inRange && parityOk && c.weekday === weekday) applicable.push({ course: c, week });
  }

  const term = pickTerm(courses, applicable.map((a) => a.course.termStartDate), date);
  const week = term ? weekOf(date, term) : null;

  const list = applicable.filter((a) => a.course.termStartDate === term).map((a) => a.course);

  /*
   * `afterTerm` 的判据是"这一天已经越过了该学期的最后一周"，而不是
   * "这条课今天没上"。两者差在"单周不上双周的课"这种情形上：那属于
   * 正常的"今天没课"，不该说"学期已经结束"。
   *
   * 用该学期里**最晚的周结束**来比，避免某门课早就结课（weekEnd 小）
   * 就把整学期判成结束了。
   */
  const maxWeekEnd = term
    ? Math.max(0, ...courses.filter((c) => c.termStartDate === term).map((c) => Number(c.weekEnd) || 0))
    : 0;

  return {
    date,
    weekday,
    weekdayCn: WEEKDAY_CN[weekday] ?? '',
    termStartDate: term,
    week,
    parity: week ? parityOfWeek(week) : null,
    parityCn: week ? PARITY_CN[parityOfWeek(week)] : '',
    courses: list.sort(byStart),
    beforeTerm: week !== null && week < 1,
    afterTerm: week !== null && week > maxWeekEnd,
  };
}

/**
 * 选学期。
 *
 * 三级回退，每一级都对应一种真实的提问场景：
 *
 *   1. `hitTerms` —— 这一天真有课的学期。有多个时取最晚的那个（用户当前更
 *      关心的那个）；同一用户跨学期保存过课程时，这一级决定展示哪份。
 *   2. 不晚于该日期的最晚学期 —— 用于回答"今天没课，那现在是第几周"。
 *   3. **最早的学期** —— 用于回答"现在还没开学吧？"。少了这一级，
 *      开学前的查询会退化成"没有学期"，于是没法告诉用户"还差几周开学"。
 *
 * ## 为什么要覆盖 `hitTerms` 而不是直接用 model.dayContext
 *
 * `dayContext` 只看"学期开始日不晚于目标日"，它不知道**这门课今天到底上不上**。
 * 于是当用户在「2026 秋」和「2027 春」都存了课、而两个学期又都开始于目标日之前
 * （比如查一个处于两个学期之间的日期），`dayContext` 会选更晚的那个学期，
 * 尽管那天真正有课的可能是更早的那个 —— 后者才该被展示。
 *
 * 所以这里的顺序是"先看谁的课真的成立，再看学期的新旧"。`model.dayContext`
 * 仍然是只有日期、没有课程语义的查询（比如 week 视图里算"这周是第几周"）的正解，
 * 两处各有各的用途，不是两份重复实现。
 *
 * @param {any[]} courses
 * @param {string[]} hitTerms
 * @param {string} date
 */
function pickTerm(courses, hitTerms, date) {
  const hits = [...new Set(hitTerms.filter(Boolean))].sort();
  if (hits.length > 0) return hits[hits.length - 1];
  const all = [...new Set(courses.map((c) => c.termStartDate).filter(Boolean))].sort();
  const eligible = all.filter((t) => t <= date);
  if (eligible.length > 0) return eligible[eligible.length - 1];
  return all.length > 0 ? all[0] : null;
}

/**
 * 星期几（1=周一 … 7=周日），纯日历计算。
 *
 * 用 `Date.UTC(...).getUTCDay()` 而不是 `getDay()`：后者按**本机时区**
 * 解释日期，在 UTC-5 之类的机器上 `2026-09-07` 会算出前一天。
 * 课程表里的日期是"日历上的那一天"，与机器在哪无关。
 *
 * @param {string} date
 */
function weekdayNumber(date) {
  const p = date.split('-').map(Number);
  const day = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0=周日
  return day === 0 ? 7 : day;
}

/**
 * 按开始时间 / 起始节次排序。
 *
 * @param {any} a
 * @param {any} b
 */
function byStart(a, b) {
  const pa = Array.isArray(a.periods) && a.periods.length > 0 ? a.periods[0] : 99;
  const pb = Array.isArray(b.periods) && b.periods.length > 0 ? b.periods[0] : 99;
  if (pa !== pb) return pa - pb;
  return String(a.startTime ?? '').localeCompare(String(b.startTime ?? ''));
}

/**
 * 解析查询日期（缺省 = 今天）。
 *
 * @param {any} ctx
 * @param {any} args
 * @returns {{ok: true, date: string, timezone: string} | {ok: false, code: string, message: string}}
 */
function resolveDate(ctx, args) {
  const cfg = configOf(ctx);
  const timezone = String(args?.timezone ?? '').trim() || cfg.timezone;
  const raw = String(args?.date ?? '').trim();
  if (raw) {
    if (!isValidDate(raw)) {
      return { ok: false, code: 'E_COURSE_BAD_ARG', message: `date「${raw}」不是合法日期（应为 YYYY-MM-DD）` };
    }
    return { ok: true, date: raw, timezone };
  }
  return { ok: true, date: todayInZone(timezone, Date.now()), timezone };
}

/**
 * @param {any} ctx
 * @param {any} args
 */
async function toolDay(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  const d = resolveDate(ctx, args);
  if (!d.ok) return d;

  const store = storeOf(ctx);
  /** @type {any[]} */
  let courses = [];
  try {
    const doc = await store.read(o.owner);
    courses = doc.courses;
  } catch (err) {
    return storeFail(err);
  }

  const view = dayView(courses, d.date);

  /** @type {string[]} */
  const notes = [];
  if (courses.length === 0) {
    notes.push('还没有保存任何课程。可以先用自然语言把课表告诉我，我会整理好让你确认。');
  } else if (view.termStartDate === null) {
    // 有课但都在"这一天之后才开始"的学期里：不是"没课"，是"还没到那个学期"
    notes.push('这一天还没有对应到任何已保存的学期（所有学期都在这天之后开始）。');
  } else if (view.beforeTerm) {
    notes.push(`这一天在第 ${view.week} 周，学期还没开始（学期开始日 ${view.termStartDate}）。`);
  } else if (view.afterTerm) {
    notes.push('这一天已经超出该学期的最后一周（可能学期已结束，或这门课已经结课）。');
  } else if (view.courses.length === 0) {
    notes.push(`第 ${view.week} 周（${view.parityCn}）这天没有课。`);
  }

  const table =
    view.courses.length > 0
      ? renderTable(['星期', '节次', '课程', '地点', '教师', '周次'], view.courses.map((c) => courseRow(c)))
      : '（当天没有课）';

  return {
    ok: true,
    date: view.date,
    dateCn: formatDateCn(view.date),
    weekday: view.weekday,
    weekdayCn: view.weekdayCn,
    termStartDate: view.termStartDate,
    week: view.week,
    parity: view.parity,
    parityCn: view.parityCn,
    count: view.courses.length,
    courses: view.courses,
    table: clampText(table),
    notes,
  };
}

/* ---------------------------------------------------------- 工具：course_week */

/**
 * 某一周的整张表。
 *
 * ## 为什么按"日历周"而不是"某个学期第几周"来选
 *
 * 所有术语开始日都被归一到周一（见 lib/time.mjs），所以一个日历周在任何学期里
 * 都对应**同一个**周次编号。这让"这一周"成为一个不依赖学期选择的概念 ——
 * 用户说"下周有什么课"时不需要先告诉我们在哪个学期。
 *
 * @param {any} ctx
 * @param {any} args
 */
async function toolWeek(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  const d = resolveDate(ctx, args);
  if (!d.ok) return d;

  const store = storeOf(ctx);
  /** @type {any[]} */
  let courses = [];
  try {
    const doc = await store.read(o.owner);
    courses = doc.courses;
  } catch (err) {
    return storeFail(err);
  }

  const monday = mondayOf(d.date);
  const sunday = addDays(monday, 6);

  /*
   * 选学期：这一周里"按某个学期算、且确实有课"的最晚学期。
   * 都没有则退回不晚于本周的最近学期（用于回答"这一周是第几周、没课"）。
   */
  /** @type {string[]} */
  const hitTerms = [];
  for (const c of courses) {
    const week = weekOf(monday, c.termStartDate);
    const inRange = week >= c.weekStart && week <= c.weekEnd;
    const parityOk = c.parity === 'all' || c.parity === parityOfWeek(week);
    if (week >= 1 && inRange && parityOk) hitTerms.push(c.termStartDate);
  }
  const term = pickTerm(courses, hitTerms, sunday);
  const week = term ? weekOf(monday, term) : null;
  const parity = week ? parityOfWeek(week) : null;

  const inWeek = term
    ? courses.filter((c) => {
        if (c.termStartDate !== term) return false;
        if (week === null || week < c.weekStart || week > c.weekEnd) return false;
        if (c.parity !== 'all' && c.parity !== parity) return false;
        return true;
      })
    : [];

  const rows = [];
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const wd = i + 1;
    const dayCourses = inWeek.filter((c) => c.weekday === wd).sort(byStart);
    for (const c of dayCourses) {
      rows.push(courseRow(c));
      count++;
    }
    if (dayCourses.length === 0) {
      rows.push([WEEKDAY_CN[wd], '—', '（无课）', '—', '—', '—']);
    }
  }

  /** @type {string[]} */
  const notes = [];
  if (courses.length === 0) {
    notes.push('还没有保存任何课程。可以先用自然语言把课表告诉我，我会整理好让你确认。');
  } else if (week !== null && week < 1) {
    notes.push(`这一周在第 ${week} 周，学期还没开始。`);
  } else if (count === 0) {
    notes.push(week !== null ? `第 ${week} 周（${PARITY_CN[parity]}）整周没有课。` : '还没有可对应的学期。');
  }

  return {
    ok: true,
    week,
    parity,
    parityCn: parity ? PARITY_CN[parity] : '',
    termStartDate: term,
    monday,
    sunday,
    mondayCn: formatDateCn(monday),
    sundayCn: formatDateCn(sunday),
    count,
    courses: inWeek,
    table: clampText(renderTable(['星期', '节次', '课程', '地点', '教师', '周次'], rows)),
    notes,
  };
}

/* ---------------------------------------------------------- 工具：course_list */

/**
 * 列出全部课程（按学期分组）。
 *
 * @param {any} ctx
 * @param {any} args
 */
async function toolList(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  const store = storeOf(ctx);
  /** @type {any[]} */
  let courses = [];
  try {
    const doc = await store.read(o.owner);
    courses = doc.courses;
  } catch (err) {
    return storeFail(err);
  }

  const weekdayRaw = args?.weekday;
  if (weekdayRaw !== undefined && weekdayRaw !== null) {
    const wd = Number(weekdayRaw);
    if (!Number.isInteger(wd) || wd < 1 || wd > 7) {
      return fail('E_COURSE_BAD_ARG', 'weekday 必须是 1–7 的整数（1=周一）', { field: 'weekday' });
    }
    courses = courses.filter((c) => c.weekday === wd);
  }

  const termFilter = String(args?.termStartDate ?? '').trim();
  if (termFilter) {
    if (!isValidDate(termFilter)) {
      return fail('E_COURSE_BAD_ARG', `termStartDate「${termFilter}」不是合法日期`, { field: 'termStartDate' });
    }
    courses = courses.filter((c) => c.termStartDate === termFilter);
  }

  const byTerm = new Map();
  for (const c of courses) {
    if (!byTerm.has(c.termStartDate)) byTerm.set(c.termStartDate, []);
    byTerm.get(c.termStartDate).push(c);
  }

  const terms = [...byTerm.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([termStartDate, list]) => ({
      termStartDate,
      count: list.length,
      courses: list.sort((a, b) => a.weekday - b.weekday || byStart(a, b)),
      table: clampText(
        renderTable(['星期', '节次', '课程', '地点', '教师', '周次'], list.sort((a, b) => a.weekday - b.weekday || byStart(a, b)).map((c) => courseRow(c))),
      ),
    }));

  const flat = courses.slice().sort((a, b) => a.termStartDate.localeCompare(b.termStartDate) || a.weekday - b.weekday || byStart(a, b));

  return {
    ok: true,
    count: courses.length,
    termCount: terms.length,
    terms,
    courses: flat,
    table: clampText(renderTable(['星期', '节次', '课程', '地点', '教师', '周次'], flat.map((c) => courseRow(c)))),
    list: clampText(renderCourseList(flat)),
  };
}

/* -------------------------------------------------------- 工具：course_update */

/**
 * 局部修改一条课程。
 *
 * 语义是**合并**而不是替换：`patch` 里没出现的字段保持原值。这是刻意的 ——
 * 用户说"高数换到 302 了"，模型只需传 `{location:"302"}`，不必把整条课程
 * 重写一遍（重写就有抄错的风险）。
 *
 * @param {any} ctx
 * @param {any} args
 */
async function toolUpdate(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  const store = storeOf(ctx);
  const courseId = String(args?.courseId ?? '').trim();
  if (!courseId) return fail('E_COURSE_BAD_ARG', '缺少 courseId（从 course_list 里取）');

  const patch = args?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail('E_COURSE_BAD_ARG', '参数 patch 必须是要修改的字段对象');
  }
  if (Object.keys(patch).length === 0) {
    return fail('E_COURSE_BAD_ARG', 'patch 是空的：没有要修改的字段');
  }

  /** @type {any} */
  let updated = null;
  /** @type {any[]} */
  let conflicts = [];

  try {
    await store.update(o.owner, (doc) => {
      const idx = doc.courses.findIndex((c) => c.id === courseId);
      if (idx < 0) {
        throw Object.assign(new Error(`找不到课程 ${courseId}（可能已被删除）`), { code: 'E_COURSE_NOT_FOUND' });
      }

      const merged = applyPatch(doc.courses[idx], patch);
      if (!merged.ok) {
        throw Object.assign(new Error(`修改后的课程不合法：${merged.message}`), { code: 'E_COURSE_BAD_ARG' });
      }

      const found = findConflicts(merged.course, doc.courses, { excludeId: courseId });
      if (found.length > 0 && args?.overwriteConflicts !== true) {
        throw Object.assign(new Error(`修改后会与 ${found.length} 条已有课程时间冲突`), {
          code: 'E_COURSE_CONFLICT',
          conflicts: found,
        });
      }

      const course = {
        ...merged.course,
        id: doc.courses[idx].id,
        createdAt: doc.courses[idx].createdAt ?? merged.course.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const v = validateStoredCourse(course);
      if (!v.ok) throw Object.assign(new Error(`修改后的课程不合法：${v.message}`), { code: 'E_COURSE_BAD_ARG' });

      doc.courses[idx] = v.course;
      updated = v.course;
      conflicts = found;
      return doc;
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === 'E_COURSE_NOT_FOUND') return fail('E_COURSE_NOT_FOUND', String(e.message));
    if (e?.code === 'E_COURSE_BAD_ARG') return fail('E_COURSE_BAD_ARG', String(e.message));
    if (e?.code === 'E_COURSE_CONFLICT') {
      return fail(
        'E_COURSE_CONFLICT',
        `${String(e.message)}。请把冲突告诉用户；用户确认要保留时再传 overwriteConflicts=true。`,
        { conflicts: e.conflicts ?? [] },
      );
    }
    return storeFail(e);
  }

  return {
    ok: true,
    course: updated,
    conflicts,
    table: renderTable(['星期', '节次', '课程', '地点', '教师', '周次'], [courseRow(updated)]),
  };
}

/* -------------------------------------------------------- 工具：course_delete */

/**
 * 删除一条 / 清空全部 / 重置损坏文件。
 *
 * @param {any} ctx
 * @param {any} args
 */
async function toolDelete(ctx, args) {
  const o = requireOwner(ctx);
  if (!o.ok) return o;

  const store = storeOf(ctx);
  const all = args?.all === true;
  const courseId = String(args?.courseId ?? '').trim();

  // 损坏重置：单独一条显式路径，且必须 all=true 才允许（防止误删单条时顺手清库）
  if (all && args?.forceCorrupt === true) {
    try {
      const { backup } = await store.resetOwner(o.owner);
      return {
        ok: true,
        reset: true,
        backup,
        message: backup
          ? `数据文件已损坏，原文件已备份为 ${backup}，并写入空课程表。`
          : '数据文件不可读，已写入空课程表。',
      };
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e instanceof StorageCorrupt || e?.code === 'E_COURSE_STORE_CORRUPT') return storeFail(e);
      // resetOwner 在"文件其实没坏"时会抛这句
      return fail('E_COURSE_BAD_ARG', String(e?.message ?? e));
    }
  }

  if (!all && !courseId) {
    return fail('E_COURSE_BAD_ARG', '要么传 courseId 删除一条，要么传 all=true 清空全部');
  }

  let deleted = 0;
  try {
    await store.update(o.owner, (doc) => {
      if (all) {
        deleted = doc.courses.length;
        doc.courses = [];
        return doc;
      }
      const before = doc.courses.length;
      doc.courses = doc.courses.filter((c) => c.id !== courseId);
      deleted = before - doc.courses.length;
      if (deleted === 0) {
        throw Object.assign(new Error(`找不到课程 ${courseId}（可能已被删除）`), { code: 'E_COURSE_NOT_FOUND' });
      }
      return doc;
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === 'E_COURSE_NOT_FOUND') return fail('E_COURSE_NOT_FOUND', String(e.message));
    return storeFail(e);
  }

  return { ok: true, deleted, all };
}

/* ==================================================================== 生命周期 */

export default {
  /**
   * 初始化。
   *
   * 这里只做两件事：建存储实例（顺带确认 dataDir 可写）、清空草案表。
   * **不在 init 里读数据文件** —— 一个损坏的文件不该让整个插件起不来，
   * 它应该在用户真正查询时才被报出来（带路径、带"不会覆盖"的说明）。
   *
   * @param {any} ctx
   */
  async init(ctx) {
    const dataDir = String(ctx?.dataDir ?? ctx?.plugin?.dataDir ?? '');
    runtime = {
      store: dataDir ? new CourseStore({ dataDir, log: (l, m, f) => ctx?.log?.(l, m, f) }) : null,
      config: { ...(ctx?.config ?? {}) },
    };
    drafts.clear();

    if (!dataDir) {
      ctx?.log?.('warn', '宿主没有提供 dataDir，课程表将无法读写');
    }

    ctx?.log?.('info', '课程表插件已初始化', {
      timezone: configOf(ctx).timezone,
      maxCourses: configOf(ctx).maxCourses,
    });
    return { ok: true };
  },

  /**
   * 执行工具。
   *
   * @param {{tool: string, args: object, ctx: any, signal?: AbortSignal}} input
   */
  async callTool({ tool, args, ctx, signal }) {
    // 取消：宿主点了「停止」/ 回合超时 / 插件被停用。这里全是短操作，
    // 但仍要检查——保存正在排队等锁时取消，不该再写进去。
    if (signal?.aborted || ctx?.signal?.aborted) {
      return { ok: false, code: 'E4070', message: '调用已取消' };
    }

    const name = String(tool ?? '');
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

    try {
      switch (name) {
        case 'course_preview':
          return await toolPreview(ctx, a);
        case 'course_save':
          return await toolSave(ctx, a);
        case 'course_cancel':
          return await toolCancel(ctx, a);
        case 'course_day':
          return await toolDay(ctx, a);
        case 'course_week':
          return await toolWeek(ctx, a);
        case 'course_list':
          return await toolList(ctx, a);
        case 'course_update':
          return await toolUpdate(ctx, a);
        case 'course_delete':
          return await toolDelete(ctx, a);
        default:
          return fail('E4041', `未知工具：${name}`);
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.code === 'E4070' || e?.name === 'AbortError') {
        return { ok: false, code: 'E4070', message: '调用已取消' };
      }
      ctx?.log?.('error', '课程表工具执行异常', { tool: name, message: String(e?.message ?? e) });
      // 兜底：仍然返回结构化结果，让模型知道"失败了"，而不是让回合炸掉
      return fail('E_COURSE_INTERNAL', `课程表插件内部错误：${String(e?.message ?? e)}`);
    }
  },

  /**
   * 自检。
   *
   * 只检查"配置与数据目录能不能用"，**不读也不改任何课程数据**。
   * 点一下测试连接就把用户的课表动一遍，是最讨厌的那种自检。
   *
   * @param {any} ctx
   */
  async testConnection(ctx) {
    const cfg = configOf(ctx);
    const dataDir = String(ctx?.dataDir ?? ctx?.plugin?.dataDir ?? '');
    if (!dataDir) {
      return { ok: false, message: '宿主没有提供插件数据目录，无法保存课程表' };
    }
    try {
      const store = new CourseStore({ dataDir });
      const stats = await store.statAll();
      return {
        ok: true,
        message: `就绪（时区 ${cfg.timezone}；已有 ${stats.files} 份课程表${stats.corrupt > 0 ? `，其中 ${stats.corrupt} 份读取异常` : ''}）`,
        details: {
          timezone: cfg.timezone,
          maxCourses: cfg.maxCourses,
          draftTtlMs: cfg.draftTtlMs,
          dataDir,
          files: stats.files,
          bytes: stats.bytes,
          corrupt: stats.corrupt,
        },
      };
    } catch (err) {
      return { ok: false, message: `数据目录不可用：${String(/** @type {any} */ (err)?.message ?? err)}` };
    }
  },

  /**
   * 停用 / 重载前释放。
   *
   * 草案全部丢弃（它们本来就只在内存里），存储实例置空。
   * 不在这里落盘：所有写操作都是"写完才返回"，没有待刷新的缓冲。
   *
   * @param {any} ctx
   */
  async dispose(ctx) {
    drafts.clear();
    runtime = { store: null, config: {} };
    ctx?.log?.('debug', '课程表插件已释放');
  },
};
