/**
 * 日记仓库 —— 按日归档的「昨日总结」
 *
 * 用户要的是：「日志在第二天识别为生成日记时，生成昨日总结日记，启动时，读取日记」。
 * 拆开是三件事，三件都容易做错：
 *
 *   1. **什么时候算「第二天」** —— 必须用本地时区的日期键。
 *      `toISOString()` 是 UTC，UTC+8 的凌晨会被算成前一天：
 *      日记要么在早上八点整才"想起"要生成，要么干脆写到错误的日期上。
 *      日期键统一走 `decay.mjs` 的 `localDateKey()`，本文件不再实现第二份。
 *
 *   2. **同一天只能生成一次** —— 定时器每分钟 tick、进程可能重启、
 *      上一次可能生成到一半崩了。幂等靠两道锁：内存里的「已生成日期集合」
 *      **加上** 磁盘上的存在性检查。任何一道单独都够用，两道都在是因为
 *      「重启后内存集合必然是空的」这个一定会发生的情况。
 *
 *   3. **IO 失败不能让进程崩** —— 日记是「有更好、没有也能聊」的数据。
 *      坏文件改名留证、写盘失败只记 `lastError`，绝不往上抛。
 *
 * ## 为什么一天一个文件
 *
 * 和 thinking.mjs 同一个理由：界面按日期分组展示，一天一个文件正好对上；
 * 也避免每次写都重写一个越来越大的单文件（原子替换的窗口会变长）。
 *
 * ## 为什么权重是派生计算
 *
 * 落盘只存 `weightBase` / `weightBaseDate`，当前权重由 `computeWeight()` 现算。
 * 这样程序没开也照常衰减，而且不用每天写一遍磁盘。
 * **任何读权重的地方都必须走 `computeWeight()`**，不能直接读 `weightBase` ——
 * 那是「写下那天」的快照，不是当前值。
 *
 * ## 写盘的版本号保护（和 thinking.mjs 是同一个坑）
 *
 * 形状是「序列化 → await 写盘 → 清脏标记」。写盘是真正的异步 IO，期间完全
 * 可能有一次新的 `save()` 落到同一天上。如果写完就无条件认为「已保存」，
 * 那条新内容此后只在内存里，直到进程退出都不会再碰磁盘 ——
 * thinking.mjs 用真实数据丢过（并发 200 次记录只落盘 32 条）。
 *
 * 所以每个日期带一个修改版本号：只有「写盘期间没有被改过」才算干净；
 * 被改过的继续写，直到追上最新版本。`flush()` 是退出前的兜底。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { writeJsonAtomic } from '../config/atomic.mjs';
import {
  localDateKey,
  daysBetween,
  computeWeight,
  lockDiary,
  unlockDiary,
} from './decay.mjs';

/** 本地日期键：直接复用 decay.mjs 的实现，本文件不写第二份 */
export { localDateKey };

/** 新日记的默认基准权重（与 decay.mjs 的 0~100 刻度一致） */
export const DEFAULT_WEIGHT_BASE = 100;
/** 一条日记最多存多少条要点 */
export const MAX_HIGHLIGHTS = 20;
/** 单条要点的字符上限（要点是给人扫一眼的，不是正文） */
export const MAX_HIGHLIGHT_CHARS = 300;
/** 单次 save 最多为追上最新版本重写几轮（防极端情况下的死循环） */
export const MAX_WRITE_ROUNDS = 3;
/** 生成失败后的退避窗口：期间 tick 不再重试，避免每分钟打一次 LLM */
export const RETRY_BACKOFF_MS = 60_000;

/** 落盘文件名的形状：只认 `<YYYY-MM-DD>.json`，`.corrupt` 与杂物一律忽略 */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * 本地时区下 N 天前的日期键。
 *
 * 用 `setDate` 而不是减 86400000 毫秒：夏令时切换那天不是 86400000 毫秒，
 * 减毫秒会让一些地区的日期算错一天。thinking.mjs 里也有同一个函数，
 * 但那边是私有实现且这里只多两行，不值得为此把日记仓库耦合到思考仓库上。
 *
 * @param {number} now 毫秒时间戳
 * @param {number} n 往前推几天
 * @returns {string}
 */
function daysAgoKey(now, n) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return localDateKey(d);
}

/**
 * 是不是一个真实存在的日期键 `YYYY-MM-DD`。
 *
 * 借 `daysBetween` 做真实性校验：它内部会把日期回读一遍，
 * 所以 `2026-02-30` 这种会被 Date 静默进位成 3-2 的写法也会被拒绝。
 * 自己写一遍正则 + 回读等于把同一件事做第二遍，没必要。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    daysBetween(value, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {number} n
 * @returns {number}
 */
function clampWeight(n) {
  return Math.min(100, Math.max(0, n));
}

/**
 * 空日记记录。
 *
 * `degraded` 默认 true：还没有 summary 就一定是「没总结成功」的状态。
 * 真正的降级占位由 `mergeRecord()` 在 summary 为空时填上，这里只给形状。
 *
 * @param {string} date
 * @param {number} now
 * @returns {object}
 */
function emptyRecord(date, now) {
  return {
    date,
    createdAt: Number.isFinite(now) ? now : Date.now(),
    /** 生成用的模型名，空串表示未生成 */
    model: '',
    source: { convKeys: [], messageCount: 0 },
    summary: '',
    highlights: [],
    degraded: true,
    weightBase: DEFAULT_WEIGHT_BASE,
    weightBaseDate: date,
    locked: false,
    lockedWeight: null,
    lockedDate: null,
  };
}

/**
 * 把调用方给的部分字段归一化成「可以覆盖进记录」的补丁。
 *
 * 只认已知字段，**不认的字段一律丢掉**：磁盘上的数据形状必须稳定，
 * 否则以后加字段时会和调用方顺手塞进来的东西打架。
 *
 * 返回的是「只含显式给出的字段」，没有的键就是没有 —— 合并阶段靠这个
 * 区分「调用方没给」和「调用方给了空值」，否则每次 save 都会把
 * `weightBase` 重置回 100、把 `createdAt` 改成现在。
 *
 * @param {any} input
 * @returns {object}
 */
function normalizeInput(input) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!input || typeof input !== 'object') return out;

  if (Number.isFinite(input.createdAt)) out.createdAt = Number(input.createdAt);
  if (typeof input.model === 'string') out.model = input.model;

  if (input.source && typeof input.source === 'object') {
    const seen = new Set();
    const convKeys = [];
    for (const key of Array.isArray(input.source.convKeys) ? input.source.convKeys : []) {
      if (typeof key !== 'string') continue;
      const s = key.trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      convKeys.push(s);
    }
    out.source = {
      convKeys,
      messageCount: Number.isFinite(input.source.messageCount)
        ? Math.max(0, Math.trunc(Number(input.source.messageCount)))
        : 0,
    };
  }

  if (typeof input.summary === 'string') out.summary = input.summary;

  if (Array.isArray(input.highlights)) {
    out.highlights = input.highlights
      .filter((h) => typeof h === 'string')
      .map((h) => h.trim())
      .filter((h) => h.length > 0)
      .slice(0, MAX_HIGHLIGHTS)
      .map((h) => (h.length <= MAX_HIGHLIGHT_CHARS ? h : `${h.slice(0, MAX_HIGHLIGHT_CHARS)}…`));
  }

  if (typeof input.degraded === 'boolean') out.degraded = input.degraded;
  if (Number.isFinite(input.weightBase)) out.weightBase = clampWeight(Number(input.weightBase));
  if (isDateKey(input.weightBaseDate)) out.weightBaseDate = input.weightBaseDate;
  if (typeof input.locked === 'boolean') out.locked = input.locked;
  if (Number.isFinite(input.lockedWeight)) out.lockedWeight = clampWeight(Number(input.lockedWeight));
  if (input.lockedWeight === null) out.lockedWeight = null;
  if (isDateKey(input.lockedDate)) out.lockedDate = input.lockedDate;
  if (input.lockedDate === null) out.lockedDate = null;

  return out;
}

/**
 * 没总结成功时的占位正文。
 *
 * 「原始摘录」优先用调用方给的 highlights —— 那本来就是从当天消息里摘出来的；
 * 连摘录都没有时，至少留下一句可读的统计，**绝不留空文件**：
 * 空 summary 的日记在界面上和"加载失败"长得一模一样，用户无法区分。
 *
 * @param {object} rec
 * @returns {string}
 */
function degradedSummary(rec) {
  const lines = rec.highlights.filter((h) => typeof h === 'string' && h.length > 0);
  if (lines.length > 0) return lines.join('\n');
  const count = rec.source?.messageCount ?? 0;
  const convs = rec.source?.convKeys?.length ?? 0;
  return `（未生成总结：当天共 ${count} 条消息，涉及 ${convs} 个会话）`;
}

/**
 * 合并出一条完整记录。
 *
 * `keepLock` 是「锁定保护」的开关：调用方拿着旧快照（locked: false）
 * 回来改摘要时，默认不能把锁定状态冲掉 —— 否则用户钉住的日记会在
 * 下一次自动生成时悄悄解锁，而界面上完全看不出发生过什么。
 * 真正的解锁只能走 `unlock()`，它显式传 `keepLock: false`。
 *
 * @param {object | null} prev 现有记录（可能是空记录）
 * @param {any} input 调用方给的记录/补丁
 * @param {string} date 以文件名为准的日期键
 * @param {number} now
 * @param {boolean} keepLock
 * @returns {object}
 */
function mergeRecord(prev, input, date, now, keepLock) {
  const base = prev ? { ...prev } : emptyRecord(date, now);
  const patch = normalizeInput(input);
  const rec = { ...base, ...patch, date };

  // 「没给」不等于「清空」：这三个字段被误重置的后果分别是
  // 创建时间变成现在、权重凭空回满、衰减基准漂到今天。
  if (patch.createdAt === undefined) rec.createdAt = base.createdAt;
  if (patch.weightBase === undefined) rec.weightBase = base.weightBase;
  if (patch.weightBaseDate === undefined) rec.weightBaseDate = base.weightBaseDate;

  if (keepLock && base.locked && patch.locked !== true) {
    rec.locked = true;
    rec.lockedWeight = base.lockedWeight;
    rec.lockedDate = base.lockedDate;
  }

  // 锁着但冻结权重丢了（手改文件、旧版本数据）→ 按当前时刻补算，
  // 否则 decay.mjs 会退回「继续衰减」，一条钉住的日记就悄悄开始掉分。
  if (rec.locked && !Number.isFinite(rec.lockedWeight)) {
    rec.lockedWeight = computeWeight({ ...rec, now }).weight;
    if (!isDateKey(rec.lockedDate)) rec.lockedDate = date;
  }
  if (!rec.locked) {
    rec.lockedWeight = null;
    rec.lockedDate = null;
  }

  if (typeof rec.summary !== 'string') rec.summary = '';
  if (!rec.summary.trim()) {
    rec.degraded = true;
    rec.summary = degradedSummary(rec);
  }
  if (!isDateKey(rec.weightBaseDate)) rec.weightBaseDate = date;
  if (!Number.isFinite(rec.weightBase)) rec.weightBase = DEFAULT_WEIGHT_BASE;
  if (!Array.isArray(rec.highlights)) rec.highlights = [];
  if (!rec.source || typeof rec.source !== 'object') rec.source = { convKeys: [], messageCount: 0 };

  return rec;
}

/**
 * 返回副本：调用方（界面快照、测试）随便改都不会污染内存里的记录。
 *
 * @param {object} rec
 * @returns {object}
 */
function cloneRecord(rec) {
  return {
    date: rec.date,
    createdAt: rec.createdAt,
    model: rec.model,
    source: { convKeys: [...rec.source.convKeys], messageCount: rec.source.messageCount },
    summary: rec.summary,
    highlights: [...rec.highlights],
    degraded: rec.degraded,
    weightBase: rec.weightBase,
    weightBaseDate: rec.weightBaseDate,
    locked: rec.locked,
    lockedWeight: rec.lockedWeight,
    lockedDate: rec.lockedDate,
  };
}

/**
 * 从磁盘文本还原一条记录。
 *
 * 只把「不是 JSON」「不是对象」当成坏文件；字段缺失/类型不对一律用默认值修好。
 * 区分这两类是有意的：结构坏了没法猜，而字段坏了猜起来很便宜。
 *
 * @param {string} date
 * @param {string} raw
 * @param {number} now
 * @returns {object | null} 坏文件返回 null
 */
function parseRecord(date, raw, now) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  // 以文件名为准：内部 date 和文件名不一致时信文件名，
  // 否则「1-02.json 里写着 1-03」会让 list() 出现重复日期。
  return mergeRecord(null, { ...data, date }, date, now, false);
}

/**
 * 日记仓库。
 *
 * 刻意不碰网络、不碰配置、**不调 LLM**：`summary` 由调用方生成好再传进来。
 * 这样它能在测试里用临时目录完整跑一遍，而不需要起机器人或配 key。
 *
 * 所有时间都从构造参数 `now` 取，内部不读系统时间。
 */
export class DiaryStore {
  /** @type {Map<string, object>} 日期键 → 记录 */
  #records = new Map();
  /** @type {string} */
  #dir;
  /** @type {() => number} */
  #now;
  /**
   * 每个日期的修改版本号。
   *
   * 落盘是异步的：序列化之后、写盘完成之前完全可能又进来一次 save。
   * 写完就无条件清脏，那条新内容会被当成「已保存」而永远不落盘
   * （thinking.mjs 在这里真丢过数据，见文件头注释）。
   *
   * @type {Map<string, number>}
   */
  #rev = new Map();
  /** 每个日期「已经写进磁盘」的版本号 @type {Map<string, number>} */
  #writtenRev = new Map();
  /** 每个日期的写盘串行链：同一天同时只允许一个写在跑 @type {Map<string, Promise<any>>} */
  #chain = new Map();
  /** 最近一次读/写失败的原因（不抛给上层，但留着可查） */
  /** @type {any} */
  lastError = null;

  /**
   * @param {{dir: string, now?: () => number}} opts
   */
  constructor(opts = {}) {
    const dir = opts?.dir;
    if (!dir) throw new TypeError('DiaryStore 需要 dir');
    this.#dir = dir;
    this.#now = typeof opts.now === 'function' ? opts.now : Date.now;
  }

  /** 目录（测试与排查用） */
  get dir() {
    return this.#dir;
  }

  /** 内存里有多少天的日记 */
  get size() {
    return this.#records.size;
  }

  /**
   * 本地时区日期键。转调 decay.mjs 的实现，本文件不写第二份。
   *
   * @param {number} [ts]
   * @returns {string}
   */
  static localDateKey(ts = Date.now()) {
    return localDateKey(ts);
  }

  /* ------------------------------------------------------------ 读 */

  /**
   * 启动时读回全部日记。
   *
   * 一个坏文件只隔离它自己：不能让某天的半截 JSON 把整个日记历史拖没。
   * `.corrupt` 和 `.tmp` 残留一律忽略 —— 前者是上一次隔离的证据，
   * 后者是上次被杀的进程留下的，内容不保证完整。
   *
   * 返回值里的 `ok` 指「仓库整体可用」：单个坏文件被隔离不算失败
   * （那正是设计好的降级路径），只有目录都读不了才是 ok: false。
   *
   * @returns {Promise<{ok: boolean, loaded: number, recovered: boolean}>}
   */
  async load() {
    const result = { ok: true, loaded: 0, recovered: false };

    let names;
    try {
      names = await fs.readdir(this.#dir);
    } catch (err) {
      // 首次运行没有这个目录是正常的，不该当成错误
      if (/** @type {any} */ (err)?.code !== 'ENOENT') {
        this.lastError = err;
        result.ok = false;
      }
      this.#reset();
      return result;
    }

    this.#reset();
    this.lastError = null;

    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const date = m[1];

      let raw;
      try {
        raw = await fs.readFile(this.#file(date), 'utf8');
      } catch (err) {
        // 读不出来（权限/句柄）不是内容坏了，隔离它没有意义
        this.lastError = err;
        continue;
      }

      const rec = parseRecord(date, raw, this.#now());
      if (!rec) {
        result.recovered = true;
        this.lastError = new Error(`日记文件损坏，已隔离：${date}`);
        await this.#quarantine(date);
        continue;
      }

      this.#records.set(date, rec);
      // 磁盘上的内容就是当前内容：rev 与 writtenRev 对齐，避免 load 后无谓重写
      this.#rev.set(date, 0);
      this.#writtenRev.set(date, 0);
      result.loaded += 1;
    }

    return result;
  }

  /**
   * 全部日记，按日期**倒序**（新的在前）。
   *
   * **包含已淡忘的**：藏不藏是上层（界面/上下文注入）的决定，
   * 仓库在这里做过滤会让「显示已淡忘」这个开关无从实现。
   *
   * @returns {object[]}
   */
  list() {
    return [...this.#records.keys()]
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .map((date) => cloneRecord(this.#records.get(date)));
  }

  /**
   * @param {string} date `YYYY-MM-DD`
   * @returns {object | null}
   */
  get(date) {
    const rec = this.#records.get(String(date ?? ''));
    return rec ? cloneRecord(rec) : null;
  }

  /**
   * @param {string} date `YYYY-MM-DD`
   * @returns {boolean}
   */
  has(date) {
    return this.#records.has(String(date ?? ''));
  }

  /* ------------------------------------------------------------ 写 */

  /**
   * 写入一天（新增或覆盖）。
   *
   * `record.date` 必须合法，否则抛 TypeError —— 这是调用方的编程错误，
   * 越早暴露越好；IO 失败则**不抛**，只返回 `{ok: false}` 并记 `lastError`。
   *
   * 合并语义（改之前先看清楚）：
   *   · 没给的字段沿用旧值，不会被默认值冲掉（权重/创建时间尤其重要）
   *   · 已经锁定的记录，除非显式 `keepLock: false`，否则保持锁定
   *   · summary 为空 → 强制 `degraded: true` 并填占位摘录
   *
   * @param {any} record
   * @param {{keepLock?: boolean}} [opts]
   * @returns {Promise<{ok: boolean, date: string, record: object, error?: string}>}
   */
  async save(record, opts = {}) {
    const date = typeof record?.date === 'string' ? record.date : '';
    if (!isDateKey(date)) {
      throw new TypeError(`DiaryStore.save 需要合法日期键 YYYY-MM-DD，收到：${String(record?.date)}`);
    }

    const keepLock = opts?.keepLock !== false;
    const prev = this.#records.get(date) ?? null;
    const merged = mergeRecord(prev, record, date, this.#now(), keepLock);

    this.#records.set(date, merged);
    this.#bump(date);

    const written = await this.#flushDate(date);
    return written.ok
      ? { ok: true, date, record: cloneRecord(merged) }
      : { ok: false, date, record: cloneRecord(merged), error: written.error };
  }

  /**
   * 钉住某天的日记（豁免衰减）。
   *
   * 锁定逻辑**复用 decay.mjs 的 lockDiary**，这里不再写一份 ——
   * 两份锁定逻辑迟早会在「重复锁定要不要刷新 lockedDate」这种细节上分叉。
   *
   * @param {string} date
   * @returns {Promise<{ok: boolean, date: string, record: object | null, error?: string}>}
   */
  async lock(date) {
    const key = String(date ?? '');
    const rec = this.#records.get(key);
    if (!rec) return { ok: false, date: key, record: null };

    // 已经锁着：原样返回，不写盘（lockDiary 本身也保证不刷新 lockedDate）
    if (rec.locked) return { ok: true, date: key, record: cloneRecord(rec) };

    const next = lockDiary(rec, this.#now());
    return this.save(next, { keepLock: false });
  }

  /**
   * 解锁，从当天继续衰减（不补算锁定期，见 decay.mjs 的说明）。
   *
   * @param {string} date
   * @returns {Promise<{ok: boolean, date: string, record: object | null, error?: string}>}
   */
  async unlock(date) {
    const key = String(date ?? '');
    const rec = this.#records.get(key);
    if (!rec) return { ok: false, date: key, record: null };

    if (!rec.locked) return { ok: true, date: key, record: cloneRecord(rec) };

    const next = unlockDiary(rec, this.#now());
    return this.save(next, { keepLock: false });
  }

  /**
   * 把所有「内存里比磁盘新」的日期再写一遍。
   *
   * 退出前的兜底，也用于 `save()` 撞上 MAX_WRITE_ROUNDS 之后补写。
   * 正常情况下不需要显式调用 —— save 自己会等写盘完成。
   *
   * @returns {Promise<{ok: boolean, written: number}>}
   */
  async flush() {
    const pending = [...this.#records.keys()].filter(
      (date) => this.#revOf(date) !== (this.#writtenRev.get(date) ?? -1),
    );
    const results = await Promise.all(pending.map((date) => this.#flushDate(date)));
    return { ok: results.every((r) => r.ok), written: results.filter((r) => r.ok).length };
  }

  /* ------------------------------------------------------------ 内部 */

  /** 清空内存状态（load 重建前调用） */
  #reset() {
    this.#records.clear();
    this.#rev.clear();
    this.#writtenRev.clear();
    this.#chain.clear();
  }

  /** @param {string} date */
  #file(date) {
    return path.join(this.#dir, `${date}.json`);
  }

  /**
   * 把某天的版本号 +1。所有「内存里的这一天变了」的路径都必须走这里，
   * 否则版本号对不上，落盘会误判成「没变化」而跳过。
   *
   * @param {string} date
   */
  #bump(date) {
    this.#rev.set(date, this.#revOf(date) + 1);
  }

  /** @param {string} date */
  #revOf(date) {
    return this.#rev.get(date) ?? 0;
  }

  /**
   * 同一天的写盘串行化。
   *
   * 并发写同一个文件会互相覆盖（rename 有先后），最后留下哪份是碰运气。
   * 后来的调用排在前一次之后，并且每次都会重新取「最新的记录」来写。
   *
   * @param {string} date
   * @returns {Promise<{ok: boolean, date: string, error?: string}>}
   */
  #flushDate(date) {
    const prev = this.#chain.get(date) ?? Promise.resolve();
    const run = prev.then(
      () => this.#writeUntilClean(date),
      () => this.#writeUntilClean(date),
    );
    this.#chain.set(date, run);
    const done = () => {
      if (this.#chain.get(date) === run) this.#chain.delete(date);
    };
    run.then(done, done);
    return run;
  }

  /**
   * 一直写到「磁盘上的版本追平内存里的版本」为止。
   *
   * 每轮都重新取一次版本号和记录：写盘期间若又有 save 进来，
   * 版本号会变，于是再写一轮 —— 这正是防丢数据的核心，
   * 不能改成「写完就认为干净」。
   *
   * @param {string} date
   * @returns {Promise<{ok: boolean, date: string, error?: string}>}
   */
  async #writeUntilClean(date) {
    for (let round = 0; round < MAX_WRITE_ROUNDS; round += 1) {
      const rev = this.#revOf(date);
      if (this.#writtenRev.get(date) === rev) return { ok: true, date };

      const rec = this.#records.get(date);
      if (!rec) return { ok: true, date };

      try {
        await writeJsonAtomic(this.#file(date), rec);
        this.#writtenRev.set(date, rev);
      } catch (err) {
        // 保留旧 writtenRev：下次 save/flush 会再试一次
        this.lastError = err;
        return { ok: false, date, error: String(/** @type {any} */ (err)?.message ?? err) };
      }

      if (this.#revOf(date) === rev) return { ok: true, date };
    }

    // 写盘期间记录一直在变（极端情况）：数据还在内存里，交给下一次 save/flush
    return { ok: false, date, error: '写入期间记录持续变化，尚未落盘' };
  }

  /**
   * 把坏文件改名留证，**不删**。
   *
   * 不删的原因和 SessionStore 一样：里面可能有用户唯一的一段回忆，
   * 哪怕结构坏了，也许还能手工捞出来一部分。悄悄删掉不可接受。
   *
   * @param {string} date
   */
  async #quarantine(date) {
    const from = this.#file(date);
    try {
      await fs.rename(from, `${from}.corrupt`);
    } catch {
      try {
        // 已经有同名 `.corrupt` 时退一步加时间戳，别覆盖上一份证据
        await fs.rename(from, `${from}.corrupt-${this.#now()}`);
      } catch {
        /* 留证失败也不能拦住启动 */
      }
    }
  }
}

/**
 * 跨日判定器 —— 纯逻辑，**不读写磁盘、不调 LLM**。
 *
 * 为什么单独抽出来：跨日判定是整个日记功能里最容易「在错误的日子生成」
 * 的一环，而它一旦和 IO 缠在一起就没法单测。这里只依赖注入进来的
 * `now` / `hasDiary` / `hasActivity` / `onGenerate` 四个回调，
 * 真正的生成由调用方完成。
 *
 * ## 两个触发点
 *
 *   a) 运行中跨零点：外部定时器每分钟调 `tick()`。
 *      日期键变了就生成「昨日」。跨了多天（时钟跳变、进程被挂起）时
 *      **只补最近一天** —— 一次补 30 天会把 LLM 配额和磁盘一起炸掉。
 *
 *   b) 启动补生成：`catchUpOnStartup()`。
 *      只在「昨日缺失 **且** 昨日有会话活动」时触发。
 *      没活动的那天生成出来只会是一条纯占位，纯属噪音。
 *
 * ## 幂等靠两道锁
 *
 *   1. `#generated`：内存里的已生成日期集合（同一次运行内绝不重复）
 *   2. `hasDiary(date)`：磁盘存在性检查（重启后内存集合是空的，靠它兜住）
 *
 * 生成失败时**不进** `#generated`，而是记一个退避窗口：
 * 退避期内 tick 不再重试（否则每分钟打一次 LLM），退避过后自动重试。
 * 日记生成失败不该静默，也不该把启动拦住。
 */
export class DiaryScheduler {
  /** @type {() => number} */
  #now;
  /** 上次 tick 观察到的日期键；null 表示还没观察过 */
  /** @type {string | null} */
  #lastSeenDate;
  /** 跨日之后还没成功生成的那一天 @type {string | null} */
  #rolloverDate = null;
  /** 内存里的已生成日期集合 @type {Set<string>} */
  #generated = new Set();
  /** @type {(date: string) => boolean} */
  #hasDiary;
  /** @type {(date: string) => boolean} */
  #hasActivity;
  /** @type {((date: string, trigger: string) => any) | null} */
  #onGenerate;
  /** 生成失败的退避截止时刻（毫秒）；0 表示不在退避中 */
  #failedUntil = 0;
  /** 最近一次生成失败的原因 */
  /** @type {any} */
  lastError = null;

  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] 注入时钟；测试必须给，内部不读系统时间
   * @param {(date: string) => boolean} [opts.hasDiary] 该日是否已有日记（磁盘存在性检查）
   * @param {(date: string) => boolean} [opts.hasActivity] 该日是否有会话活动
   * @param {(date: string, trigger: string) => any} [opts.onGenerate] 实际生成钩子
   * @param {string} [opts.lastSeenDate] 上次观察到的日期键（可用于测试跨日）
   */
  constructor(opts = {}) {
    this.#now = typeof opts?.now === 'function' ? opts.now : Date.now;
    this.#lastSeenDate = typeof opts?.lastSeenDate === 'string' ? opts.lastSeenDate : null;
    this.#hasDiary = typeof opts?.hasDiary === 'function' ? opts.hasDiary : () => false;
    // 默认「没有活动」：调用方忘了注入时宁可不生成，也不要凭空造一条空日记
    this.#hasActivity = typeof opts?.hasActivity === 'function' ? opts.hasActivity : () => false;
    this.#onGenerate = typeof opts?.onGenerate === 'function' ? opts.onGenerate : null;
  }

  /** 当前观察到的日期键（诊断用） */
  get lastSeenDate() {
    return this.#lastSeenDate;
  }

  /** 还没成功生成的跨日目标（诊断用） */
  get pendingDate() {
    return this.#rolloverDate;
  }

  /**
   * 「现在是不是该生成昨日了」。
   *
   * 三个条件缺一不可：观察过日期、日期键变了、昨日还没生成。
   * 注意它**不改变任何状态**，可以在任意时刻重复调用。
   *
   * @returns {boolean}
   */
  shouldGenerateYesterday() {
    if (this.#lastSeenDate === null) return false;
    const today = localDateKey(this.#now());
    if (this.#lastSeenDate === today) return false;
    return this.#decide(daysAgoKey(this.#now(), 1)) === 'ready';
  }

  /**
   * 启动补生成的判定（纯判断，不执行）。
   *
   * 只看**昨天**一天：多天缺失时只补最近一天。
   * 昨天没有任何会话活动时不补 —— 生成出来只会是一条纯占位。
   *
   * @returns {{needed: boolean, date: string, reason: string}}
   */
  pendingOnStartup() {
    const date = daysAgoKey(this.#now(), 1);
    const reason = this.#decide(date);
    if (reason !== 'ready') return { needed: false, date, reason };
    if (!this.#hasActivity(date)) return { needed: false, date, reason: 'no-activity' };
    return { needed: true, date, reason: 'ready' };
  }

  /**
   * 执行启动补生成（判定 + 生成）。
   *
   * 失败时**不抛**，而是把这一天挂到跨日目标上：退避窗口过后，
   * 每分鐘一次的 `tick()` 会自动重试。否则「启动那一次恰好失败」
   * 就等于这一天永远没有日记 —— 用户看不到任何报错，只看到少了一天。
   *
   * @returns {Promise<{generated: boolean, date: string, reason: string}>}
   */
  async catchUpOnStartup() {
    const pending = this.pendingOnStartup();
    if (!pending.needed) return { generated: false, date: pending.date, reason: pending.reason };

    const ok = await this.#run(pending.date, 'startup');
    if (!ok) this.#rolloverDate = pending.date;
    return { generated: ok, date: pending.date, reason: ok ? 'generated' : 'failed' };
  }

  /**
   * 定时器每分钟调一次。
   *
   * 第一次调用只记下「今天是哪天」，不生成 —— 启动补生成是
   * `catchUpOnStartup()` 的职责，两个入口不能互相顶替。
   *
   * 跨日之后如果生成失败，`#rolloverDate` 会保留，后面的 tick 在退避
   * 结束后会自动重试；成功（或发现已存在）才清掉。
   *
   * @returns {Promise<{rolled: boolean, today: string, yesterday: string, generated: boolean, date: string | null, reason: string}>}
   */
  async tick() {
    const now = this.#now();
    const today = localDateKey(now);
    const yesterday = daysAgoKey(now, 1);

    if (this.#lastSeenDate === null) {
      this.#lastSeenDate = today;
      /*
       * 首 tick 通常只记日期就返回。但有一种例外必须继续往下走：
       * 启动补生成那一次失败了，`#rolloverDate` 正挂着一个待重试的日期。
       * 这时直接返回 first-tick 会让它一直挂着 —— 只有等下一次真正跨日
       * 才会被重新判定，等于「这一天永远没有日记」。
       */
      if (!this.#rolloverDate) {
        return { rolled: false, today, yesterday, generated: false, date: null, reason: 'first-tick' };
      }
    }

    const rolled = this.#lastSeenDate !== today;
    if (rolled) {
      this.#lastSeenDate = today;
      // 跨了多天也只补最近一天：一次补 30 天会炸
      this.#rolloverDate = yesterday;
    }

    const date = this.#rolloverDate;
    if (!date) {
      return { rolled, today, yesterday, generated: false, date: null, reason: 'same-day' };
    }

    const reason = this.#decide(date);
    if (reason === 'already-exists' || reason === 'already-generated') {
      // 已经有人生成过了：跨日目标完成，清掉
      this.#rolloverDate = null;
      return { rolled, today, yesterday, generated: false, date, reason };
    }
    if (reason === 'backoff') {
      return { rolled, today, yesterday, generated: false, date, reason };
    }

    const ok = await this.#run(date, 'rollover');
    if (ok) this.#rolloverDate = null;
    return { rolled, today, yesterday, generated: ok, date, reason: ok ? 'generated' : 'failed' };
  }

  /**
   * 外部自己生成成功后登记，避免调度器再生成一次。
   *
   * 例如调用方在别处补跑了一天日记，不通知这里的话，下一次 tick
   * 会以为那天还缺（内存集合里没有），白跑一遍生成。
   *
   * @param {string} date
   * @returns {boolean}
   */
  markGenerated(date) {
    if (!isDateKey(date)) return false;
    this.#generated.add(date);
    return true;
  }

  /* ------------------------------------------------------------ 内部 */

  /**
   * 这一天到底该不该生成。
   *
   * @param {string} date
   * @returns {'already-generated' | 'already-exists' | 'backoff' | 'ready'}
   */
  #decide(date) {
    if (this.#generated.has(date)) return 'already-generated';
    if (this.#hasDiary(date)) return 'already-exists';
    if (this.#failedUntil > this.#now()) return 'backoff';
    return 'ready';
  }

  /**
   * 真正调用生成钩子。
   *
   * 失败**不抛**：日记生成失败不该把定时器或启动流程打断。
   * 记退避窗口 + lastError，让下一轮自动重试。
   *
   * @param {string} date
   * @param {'rollover' | 'startup'} trigger
   * @returns {Promise<boolean>}
   */
  async #run(date, trigger) {
    if (!this.#onGenerate) return false;
    try {
      await this.#onGenerate(date, trigger);
      this.#generated.add(date);
      this.#failedUntil = 0;
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err;
      this.#failedUntil = this.#now() + RETRY_BACKOFF_MS;
      return false;
    }
  }
}
