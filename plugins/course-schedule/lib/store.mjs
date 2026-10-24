/**
 * 课程表插件的存储层 —— 归属、原子写、并发、损坏检测
 *
 * ## 为什么整个插件只有这一个文件碰磁盘
 *
 * 其它模块（time / model / format）都是纯函数，好处不是"看起来干净"，而是
 * 测试可以穷举边界输入而不需要造临时目录。把 IO 全压在这一层，也让
 * "哪些路径可能写到用户数据"变成一件可以直接读出来的事。
 *
 * ## 归属为什么是 hash 出来的文件名
 *
 * 文件名如果用 `private:123` 原串，会同时带来三个问题：冒号在 Windows 上
 * 非法、群号/QQ 号直接躺在目录里、以及拼接路径时被 `../` 注入。
 * 所以文件名 = sha256(convKey + "\n" + userId) 前 32 位。原串仍然**存在文件
 * 内容里**（owner 字段）—— 那是为了读回时能校验"这份数据确实是你的"，
 * 而不是为了给别的程序看。
 *
 * ## 原子写为什么不能只 rename
 *
 * 单靠 rename 在断电时仍可能拿到空文件（元数据先落盘、数据块没落）。所以
 * 写入顺序是 write(tmp) → fsync(tmp 的 fd) → rename。fsync 之后 rename 才是
 * "要么旧内容、要么新内容"。
 *
 * ## 损坏文件为什么一定要拒绝
 *
 * 这是本文件最重要的设计决定：JSON 解析失败时**不能**返回空库。
 * 一旦那样做，下一次保存就会用一份"只有新课程"的数据覆盖掉用户仅有的副本 ——
 * 用户的几十条课程在一次 parse 错误后静默消失，而界面上一切正常。
 * 所以损坏时抛 `StorageCorrupt`，写操作也一并拒绝，只留一条显式重置路径
 * （`resetOwner`），且重置前把原文件改名留证据。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
 * 日期/时钟的判定复用 `time.mjs` 的同一份实现。
 *
 * 不在本文件里再写一套正则：两套边界值迟早会分叉，症状是"保存时拒绝、
 * 读回时放行"（或反过来），而那种数据会一直躺在磁盘上。
 *
 * 只 import 纯函数层，不 import `model.mjs`：`model` 的
 * `validateStoredCourse` 会**归一化**（例如把 termStartDate 修到周一），
 * 而读取损坏文件时契约要求"判损坏、不修补"。
 */
import { isValidDate, isValidClock, clockToMinutes, MAX_WEEK } from './time.mjs';

/** 当前文件格式版本。改结构时必须 +1，并在读取处处理旧版本。 */
export const SCHEMA_VERSION = 1;

/** 课程子目录名（与 dataDir 下的其它东西分开） */
const COURSES_DIR = 'courses';

/** 与 `model.mjs` 的 LIMITS 对齐的字段上限（读取校验用）。 */
const MAX_NAME_LEN = 60;
const MAX_LOCATION_LEN = 80;
const MAX_TEACHER_LEN = 40;
const MAX_NOTE_LEN = 200;
const MAX_PERIODS = 12;
const MAX_PERIOD = 20;

/**
 * 归属：数据属于"哪个会话里的哪个人"。
 *
 * @typedef {{convKey: string, userId: string}} Owner
 */

/**
 * 数据文件损坏 / 归属不符。
 *
 * 单独一个类而不是 `Error('xxx')`：调用方需要区分"读失败"与"业务校验失败"，
 * 前者绝不能降级成空库。`file` 带上路径，让用户能自己去看一眼。
 */
export class StorageCorrupt extends Error {
  /**
   * @param {string} message
   * @param {{file?: string, cause?: unknown, ownerMismatch?: boolean}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'StorageCorrupt';
    this.code = 'E_COURSE_STORE_CORRUPT';
    this.file = opts.file ?? '';
    this.ownerMismatch = opts.ownerMismatch === true;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * 从宿主给的可信上下文算出归属。
 *
 * ## 这里为什么不做任何"兜底"
 *
 * 没有 `convKey` 时**不能**退化成某个全局库：那等于所有拿不到会话的调用
 * （主动回合、脚本直调）共享同一份数据，而其中任何一个人都能读走别人的课表。
 * 宁可明确报错，让模型去问"你现在是在哪个会话里跟我说话"。
 *
 * @param {{convKey?: string, requester?: {id?: string}}} caller
 * @returns {Owner | null} null = 没有可信归属
 */
export function ownerFromCaller(caller) {
  const convKey = String(caller?.convKey ?? '').trim();
  if (!convKey) return null;
  const userId = String(caller?.requester?.id ?? '').trim();
  return { convKey, userId };
}

/**
 * 归属相等（逐字段，不做 trim 之外的归一）。
 *
 * @param {Owner} a
 * @param {Owner} b
 * @returns {boolean}
 */
export function sameOwner(a, b) {
  return String(a?.convKey ?? '') === String(b?.convKey ?? '') && String(a?.userId ?? '') === String(b?.userId ?? '');
}

/**
 * 归属的文件名。
 *
 * 用 `\n` 分隔而不是 `:`：如果 convKey 里恰好含分隔符，`a:b` + `c` 与
 * `a` + `b:c` 会撞成同一个 hash。换行在 convKey 与 userId 里都不可能合法出现
 * （宿主生成的是 `group:` / `private:` + 数字），所以它是个安全的分隔符。
 *
 * @param {Owner} owner
 * @returns {string}
 */
export function ownerFileBase(owner) {
  return crypto
    .createHash('sha256')
    .update(`${owner.convKey}\n${owner.userId}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * 一次读-改-写。
 *
 * @param {object} opts
 * @param {string} opts.dataDir 宿主给的插件私有数据目录
 * @param {(doc: any) => any} opts.mutate 收到当前文档，返回新文档（或抛错中止）
 * @param {Owner} opts.owner
 * @param {number} [opts.maxCourses]
 * @returns {Promise<{doc: any, written: boolean}>}
 */

/**
 * 课程表存储。
 *
 * 一个实例对应一个 dataDir。插件 init 时建一个，dispose 时清掉。
 * 实例内部按文件路径串行化读-改-写，所以同一个归属的并发调用不会互相覆盖。
 */
export class CourseStore {
  /**
   * @param {{dataDir: string, log?: (level: string, message: string, fields?: object) => void}} opts
   */
  constructor(opts) {
    this.dataDir = String(opts?.dataDir ?? '');
    this.log = opts?.log ?? (() => {});
    /**
     * 每个归属文件一条串行链。
     *
     * 只用一个全局锁也能保证正确性，但那样 A 群的保存会阻塞 B 群的查询 ——
     * 群聊场景下这是可感知的等待。按文件分链，冲突面就只剩"同一个人同时存两次"。
     *
     * @type {Map<string, Promise<any>>}
     */
    this.chains = new Map();
  }

  /** @returns {string} */
  coursesDir() {
    return path.join(this.dataDir, COURSES_DIR);
  }

  /**
   * 某归属的数据文件路径。
   *
   * @param {Owner} owner
   * @returns {string}
   */
  fileOf(owner) {
    return path.join(this.coursesDir(), `${ownerFileBase(owner)}.json`);
  }

  /**
   * 在指定文件的串行链上排一次任务。
   *
   * 用"链尾 + catch 清空"而不是 `await queue`：链上一个任务失败不能把
   * 后面所有任务一起拖垮（否则一次坏输入会让这个会话此后永远存不进东西）。
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #serial(key, fn) {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // 链尾只关心"跑完了"，不关心成败；失败由各自调用方处理
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    // 队伍跑空后清掉，避免 Map 随会话数无限增长
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /**
   * 读一份文档。
   *
   * 文件不存在 = 空库（这是**唯一**允许把"读不到"当成"没有"的情况）。
   * 文件存在但解析失败 / 形状不对 / 归属不符 = StorageCorrupt，绝不返回空库。
   *
   * @param {Owner} owner
   * @returns {Promise<{schema: number, owner: Owner, updatedAt: string, rev: number, courses: any[]}>}
   */
  async read(owner) {
    const file = this.fileOf(owner);
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'ENOENT') return emptyDoc(owner);
      throw new StorageCorrupt(`课程表读取失败：${String(/** @type {any} */ (err)?.message ?? err)}`, {
        file,
        cause: err,
      });
    }

    let doc;
    try {
      doc = JSON.parse(stripBom(raw));
    } catch (err) {
      throw new StorageCorrupt(
        `课程表数据文件不是合法 JSON（${file}）。为避免覆盖，已停止读写；请先备份该文件或显式重置。`,
        { file, cause: err },
      );
    }

    const shape = validateDocShape(doc);
    if (!shape.ok) {
      throw new StorageCorrupt(`课程表数据文件形状不正确（${file}）：${shape.message}`, { file });
    }
    if (!sameOwner(shape.doc.owner, owner)) {
      /*
       * 不一致在正常流程里不该发生（文件名就是 hash 出来的），但一旦发生，
       * 说明要么文件被手工换过、要么 hash 逻辑改过。两种情况下都不能
       * "照读"——那等于把别人的课表交给当前用户。
       */
      throw new StorageCorrupt(`课程表数据归属不符（${file}），已拒绝读取`, {
        file,
        ownerMismatch: true,
      });
    }
    return shape.doc;
  }

  /**
   * 读-改-写（串行）。
   *
   * `mutate` 收到**当前文档的深拷贝**，返回新文档；抛错则整体中止、不写盘。
   * 这样调用方的校验失败不会留下半写状态。
   *
   * @param {Owner} owner
   * @param {(doc: any) => any} mutate
   * @returns {Promise<{doc: any}>}
   */
  async update(owner, mutate) {
    const file = this.fileOf(owner);
    return this.#serial(file, async () => {
      const current = await this.read(owner);
      const draft = clone(current);
      const next = mutate(draft);
      const normalized = validateDocShape(next);
      if (!normalized.ok) {
        throw new StorageCorrupt(`准备写入的课程表形状不正确：${normalized.message}`, { file });
      }
      normalized.doc.schema = SCHEMA_VERSION;
      normalized.doc.owner = { convKey: owner.convKey, userId: owner.userId };
      normalized.doc.updatedAt = new Date().toISOString();
      normalized.doc.rev = Number(current.rev ?? 0) + 1;
      await this.#writeAtomic(file, normalized.doc);
      return { doc: normalized.doc };
    });
  }

  /**
   * 原子写：tmp → fsync → rename。
   *
   * @param {string} file
   * @param {any} doc
   */
  async #writeAtomic(file, doc) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });

    const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    const payload = `${JSON.stringify(doc, null, 2)}\n`;

    let fh;
    try {
      fh = await fs.open(tmp, 'w');
      await fh.writeFile(payload, 'utf8');
      // 先落盘再改名：断电时最多丢掉这一次写入，不会得到半截文件
      await fh.sync();
    } finally {
      await fh?.close();
    }

    try {
      await this.#renameWithRetry(tmp, file);
    } catch (err) {
      // rename 彻底失败：把临时文件清掉，别在用户目录里堆垃圾
      try {
        await fs.unlink(tmp);
      } catch {
        /* 清不掉也只是多一个点开头的临时文件 */
      }
      throw err;
    }
  }

  /**
   * rename 重试。
   *
   * Windows 上杀软/索引器会短暂持有目标文件，rename 于是报 EPERM/EBUSY。
   * 这类错误几乎总在几十毫秒内消失，直接失败会让用户看到"偶尔存不上"。
   *
   * @param {string} from
   * @param {string} to
   * @param {number} [attempts]
   */
  async #renameWithRetry(from, to, attempts = 5) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        await fs.rename(from, to);
        return;
      } catch (err) {
        lastErr = err;
        const code = /** @type {any} */ (err)?.code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
        await new Promise((r) => setTimeout(r, 30 * (i + 1)));
      }
    }
    throw lastErr;
  }

  /**
   * 显式重置一份损坏的数据文件。
   *
   * 这是**唯一**会写坏文件的路径，所以做两件事：
   *   1. 先把原文件改名成 `.corrupt-<ts>.bak`（留证据，用户还能拿回来）；
   *   2. 再写一份空库。
   *
   * 正常文件不会被重置——调用方必须显式要求，且这里会先尝试读一次：
   * 能读通就说明没坏，直接拒绝（防止误清空）。
   *
   * @param {Owner} owner
   * @returns {Promise<{backup: string | null}>}
   */
  async resetOwner(owner) {
    const file = this.fileOf(owner);
    return this.#serial(file, async () => {
      let corrupt = false;
      try {
        await this.read(owner);
      } catch (err) {
        if (!(err instanceof StorageCorrupt)) throw err;
        corrupt = true;
      }
      if (!corrupt) {
        throw new Error('数据文件可正常读取，拒绝重置（重置只用于损坏的副本）');
      }

      /** @type {string | null} */
      let backup = null;
      try {
        backup = `${file}.corrupt-${Date.now()}.bak`;
        await fs.rename(file, backup);
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'ENOENT') throw err;
        backup = null;
      }

      const doc = emptyDoc(owner);
      await this.#writeAtomic(file, doc);
      this.log('warn', '课程表数据已重置', { file, backup });
      return { backup };
    });
  }

  /**
   * 列出该 dataDir 下所有归属文件的元信息（不含内容）。
   *
   * 只给自检用：`testConnection` 里报"这个会话存了多少条"不能靠猜。
   *
   * @returns {Promise<{files: number, bytes: number, corrupt: number}>}
   */
  async statAll() {
    let entries;
    try {
      entries = await fs.readdir(this.coursesDir(), { withFileTypes: true });
    } catch {
      return { files: 0, bytes: 0, corrupt: 0 };
    }
    let bytes = 0;
    let files = 0;
    let corrupt = 0;
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      files++;
      try {
        const st = await fs.stat(path.join(this.coursesDir(), ent.name));
        bytes += st.size;
      } catch {
        /* 统计用，读不到就跳过 */
      }
      try {
        JSON.parse(stripBom(await fs.readFile(path.join(this.coursesDir(), ent.name), 'utf8')));
      } catch {
        corrupt++;
      }
    }
    return { files, bytes, corrupt };
  }
}

/* ------------------------------------------------------------------ 纯函数 */

/**
 * 一份空文档。
 *
 * @param {Owner} owner
 * @returns {{schema: number, owner: Owner, updatedAt: string, rev: number, courses: any[]}}
 */
export function emptyDoc(owner) {
  return {
    schema: SCHEMA_VERSION,
    owner: { convKey: String(owner?.convKey ?? ''), userId: String(owner?.userId ?? '') },
    updatedAt: new Date(0).toISOString(),
    rev: 0,
    courses: [],
  };
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 用户可能用记事本手改过数据文件；记事本默认加 BOM，而 `JSON.parse` 遇到
 * 它直接失败。这不是数据坏了，不该被判成损坏。
 *
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 深拷贝。
 *
 * 用 structuredClone（Node 17+）而不是 JSON 往返：文档里的日期都是字符串，
 * 看起来两者等价，但 JSON 往返会把 `undefined` 键悄悄删掉，而
 * `validateDocShape` 恰恰要看见"这个键存在但值不对"。
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return /** @type {T} */ (structuredClone(value));
}

/**
 * 校验整份文档形状。
 *
 * 逐条校验课程是刻意的：一条坏记录就说明这份文件被动过（或写过它的旧版本
 * 有 bug）。此时**不能只丢那一条**——用户会以为数据被删了，而实际是
 * 我们在悄悄丢东西。宁可整份报损坏，让用户看到提示并自己决定。
 *
 * @param {unknown} doc
 * @returns {{ok: true, doc: any} | {ok: false, message: string}}
 */
export function validateDocShape(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, message: '顶层必须是对象' };
  }
  const d = /** @type {any} */ (doc);
  if (d.schema !== SCHEMA_VERSION) {
    return { ok: false, message: `schema 应为 ${SCHEMA_VERSION}，实际 ${String(d.schema)}` };
  }
  if (!d.owner || typeof d.owner !== 'object') {
    return { ok: false, message: '缺 owner' };
  }
  if (typeof d.owner.convKey !== 'string' || typeof d.owner.userId !== 'string') {
    return { ok: false, message: 'owner 字段类型不正确' };
  }
  if (!Number.isInteger(d.rev) || d.rev < 0) {
    return { ok: false, message: `rev 必须是非负整数，实际 ${String(d.rev)}` };
  }
  if (typeof d.updatedAt !== 'string' || Number.isNaN(Date.parse(d.updatedAt))) {
    return { ok: false, message: 'updatedAt 不是合法时间' };
  }
  if (!Array.isArray(d.courses)) {
    return { ok: false, message: 'courses 必须是数组' };
  }
  for (let i = 0; i < d.courses.length; i++) {
    const bad = validateStoredShape(d.courses[i], i);
    if (bad) return bad;
  }
  return { ok: true, doc: d };
}

/**
 * 单条课程记录的**完整形状**校验（docs §2 / §7.5）。
 *
 * 与 `model.validateStoredCourse` 的分工：那个会归一化（读取即修正），
 * 用于"确认这是一条可用的课"；这里只回答"这份文件还能不能信"。
 * 所以在读取路径上用它，且**不修补任何字段**——修补会让损坏变得看不出来。
 *
 * @param {unknown} c
 * @param {number} i 0 起的下标（只用于报错）
 * @returns {{ok: false, message: string} | null} null = 合法
 */
function validateStoredShape(c, i) {
  const at = `第 ${i + 1} 条课程`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) {
    return { ok: false, message: `${at}不是对象` };
  }
  const course = /** @type {any} */ (c);
  if (typeof course.id !== 'string' || !/^c_[0-9a-f]{8}$/.test(course.id)) {
    return { ok: false, message: `${at}的 id 非法` };
  }
  if (typeof course.name !== 'string' || course.name.trim() === '') {
    return { ok: false, message: `${at}缺 name` };
  }
  const name = course.name.trim();
  if (Array.from(name).length > MAX_NAME_LEN) {
    return { ok: false, message: `${at}的 name 超过 ${MAX_NAME_LEN} 字` };
  }
  if (!/[\p{L}\p{N}]/u.test(name)) {
    return { ok: false, message: `${at}的 name 不能是纯符号` };
  }
  if (!Number.isInteger(course.weekday) || course.weekday < 1 || course.weekday > 7) {
    return { ok: false, message: `${at}的 weekday 非法` };
  }

  // ---- periods：1–20 的整数、去重升序、最多 12 项 ----
  if (!Array.isArray(course.periods)) {
    return { ok: false, message: `${at}的 periods 必须是数组` };
  }
  if (course.periods.length > MAX_PERIODS) {
    return { ok: false, message: `${at}的 periods 超过 ${MAX_PERIODS} 项` };
  }
  for (let k = 0; k < course.periods.length; k++) {
    const p = course.periods[k];
    if (!Number.isInteger(p) || p < 1 || p > MAX_PERIOD) {
      return { ok: false, message: `${at}的 periods 含非法节次 ${String(p)}` };
    }
    // 保存时的归一化保证升序去重；读回时不满足说明文件被改过
    if (k > 0 && p <= course.periods[k - 1]) {
      return { ok: false, message: `${at}的 periods 未去重升序` };
    }
  }

  // ---- 时间：成对出现、格式合法、开始早于结束 ----
  const hasStart = typeof course.startTime === 'string' && course.startTime.trim() !== '';
  const hasEnd = typeof course.endTime === 'string' && course.endTime.trim() !== '';
  if (hasStart !== hasEnd) {
    return { ok: false, message: `${at}的 startTime/endTime 必须成对出现` };
  }
  if (hasStart) {
    if (!isValidClock(course.startTime) || !isValidClock(course.endTime)) {
      return { ok: false, message: `${at}的 startTime/endTime 格式非法` };
    }
    const sm = clockToMinutes(course.startTime);
    const em = clockToMinutes(course.endTime);
    if (sm === null || em === null || sm >= em) {
      return { ok: false, message: `${at}的开始时间必须早于结束时间` };
    }
  }
  // 二选一（docs §2）：至少要有节次或成对时间
  if (course.periods.length === 0 && !hasStart) {
    return { ok: false, message: `${at}既没有节次也没有时间` };
  }

  if (typeof course.termStartDate !== 'string' || !isValidDate(course.termStartDate)) {
    return { ok: false, message: `${at}的 termStartDate 非法` };
  }
  if (
    !Number.isInteger(course.weekStart) ||
    !Number.isInteger(course.weekEnd) ||
    course.weekStart < 1 ||
    course.weekEnd > MAX_WEEK ||
    course.weekStart > course.weekEnd
  ) {
    return { ok: false, message: `${at}的周次范围非法` };
  }
  if (!['all', 'odd', 'even'].includes(course.parity)) {
    return { ok: false, message: `${at}的 parity 非法` };
  }

  // ---- 可选文本字段：可以不写，写了就必须是字符串且不超长 ----
  const optional = [
    ['location', MAX_LOCATION_LEN],
    ['teacher', MAX_TEACHER_LEN],
    ['note', MAX_NOTE_LEN],
  ];
  for (const [field, max] of optional) {
    if (course[field] === undefined || course[field] === null) continue;
    if (typeof course[field] !== 'string') {
      return { ok: false, message: `${at}的 ${field} 必须是字符串` };
    }
    if (Array.from(course[field].trim()).length > max) {
      return { ok: false, message: `${at}的 ${field} 超过 ${max} 字` };
    }
  }

  // ---- 时间戳：保存时一定写入，坏掉说明文件被改过 ----
  for (const field of ['createdAt', 'updatedAt']) {
    const value = course[field];
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return { ok: false, message: `${at}的 ${field} 不是合法时间` };
    }
  }
  return null;
}

/**
 * 检查同一个归属里 id 是否重复。
 *
 * @param {any[]} courses
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function assertUniqueIds(courses) {
  const seen = new Set();
  for (const c of courses ?? []) {
    if (seen.has(c?.id)) return { ok: false, message: `课程 id 重复：${c.id}` };
    seen.add(c?.id);
  }
  return { ok: true };
}
