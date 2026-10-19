/**
 * 用量记账 —— F7 / F10
 *
 * 落盘到 `userData/state/usage.jsonl`，一行一次调用。
 *
 * 为什么要有 `proactive` 这一列：
 * 主动唤醒是**纯消费**——没人要求它说话，钱是它自己花的。
 * 这部分必须能在「总览」里单列出来看得见，否则用户月底只会看到
 * 一个说不清来路的总额。这是产品要求，不是可选的统计。
 *
 * 另一个纪律：**无 usage 时明确标估算**，不要假装精确。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { estimateTokens } from '../llm/client.mjs';

/**
 * @typedef {object} UsageRecord
 * @property {number} at
 * @property {string} convKey
 * @property {string} model
 * @property {boolean} proactive
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} totalTokens
 * @property {boolean} estimated
 */

export class UsageLedger {
  /**
   * @param {{filePath: string}} opts
   */
  constructor(opts) {
    this.filePath = opts.filePath;
    /** @type {UsageRecord[]} 内存里留最近若干条，供界面直接读 */
    this.recent = [];
    this.limit = 500;
    /** 今日累计 */
    this.today = newDayBucket();
    /** 今日主动支出（单列） */
    this.todayProactive = newDayBucket();
    this.#dayKey = dayKey(Date.now());
  }

  #dayKey = '';

  /**
   * 启动时把历史记录读回内存。
   *
   * ## 为什么必须做这件事
   *
   * `record()` 一直在往 jsonl 追加，但**没有人读回来** ——
   * 于是每次打开应用「今日消耗」全是 0，前一天花掉的 token 无从累计。
   * 落盘而不回读，等于白存。
   *
   * ## 只读需要的部分
   *
   * 文件会一直变长（一行一次调用），全量读进内存没有必要，也会越来越慢。
   * 这里只需要两样东西：
   *   - **今天**的记录 → 重建今日累计（跨重启后仍然连续）
   *   - **最近 limit 条** → 界面上的「最近调用」列表
   *
   * 所以从文件尾部往前读：先按行切，从后往前扫，凑够 recent 上限、
   * 或遇到明显在今天之前的记录就停。文件再大也只读尾部一截。
   *
   * 坏行跳过而不是整个放弃 —— 一行写坏不该让历史统计全部归零。
   *
   * @returns {Promise<{loaded: number, today: number}>}
   */
  async load() {
    let text = '';
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch {
      // 文件不存在 = 第一次运行，不是错误
      return { loaded: 0, today: 0 };
    }

    const todayKey = dayKey(Date.now());
    this.#dayKey = todayKey;
    this.today = newDayBucket();
    this.todayProactive = newDayBucket();
    this.recent = [];

    const lines = text.split('\n');
    /** @type {UsageRecord[]} */
    const tail = [];
    let todayStarted = false;

    /*
     * 从后往前扫。
     *
     * 两个上限是**分开**的，这里踩过一次：
     *
     *   recent 最多留 limit 条 —— 这是界面显示用的
     *   今日累计必须扫到"不再是今天"为止 —— 这是给用户看钱的
     *
     * 一开始写成"凑够 limit 条就整段停"，结果今天调用超过 limit 次时
     * 今日总量会偏小（实测 600 条只累到 500 条）。花钱的数字不能少算。
     */
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;

      /** @type {UsageRecord | null} */
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 坏行跳过，不牵连同文件的其它记录
      }
      if (!parsed || typeof parsed.at !== 'number') continue;

      const isToday = dayKey(parsed.at) === todayKey;
      if (isToday) {
        addTo(this.today, parsed);
        if (parsed.proactive) addTo(this.todayProactive, parsed);
        todayStarted = true;
      }

      /*
       * 停止条件。
       *
       * 三条都考虑到了，否则必错一边：
       *
       *   recent 已经凑够                    ← 列表不用再往前收
       *   或者 今天还没出现过且列表已满       ← 今天一次没调用，不必读完整个文件
       *   或者 今天扫完并已越过边界           ← 今天的累计齐了，再往前都是更早的日子
       *
       * 只按"越过今天边界"就停，会在"先昨天、再今天"的顺序下漏掉 recent；
       * 只按 recent 满了就停，又会在今天调用超过上限时少算今天的总量
       * （实测 600 条只累到 500 条）。花钱的数字不能少算。
       */
      const doneWithToday = todayStarted && !isToday;
      if (tail.length >= this.limit && (doneWithToday || !todayStarted)) break;

      // recent 独立限流：满了仍然继续往前扫今天的累计
      if (tail.length < this.limit) tail.push(parsed);
    }

    // tail 是从后往前收集的，反转回时间正序
    this.recent = tail.reverse();

    const todayCount = this.today.calls;
    return { loaded: this.recent.length, today: todayCount };
  }

  /**
   * 记一次调用。
   *
   * @param {object} input
   * @param {string} input.convKey
   * @param {string} input.model
   * @param {object} input.usage
   * @param {boolean} [input.proactive]
   * @param {string} [input.promptText] 用于估算
   * @param {string} [input.completionText] 用于估算
   */
  async record(input) {
    const now = Date.now();
    this.#rollDay(now);

    let usage = input.usage ?? null;
    let estimated = usage?.estimated === true;

    // 上游没给 usage：按字符估算并明确标注
    if (!usage || (!usage.totalTokens && !usage.promptTokens)) {
      const p = estimateTokens(input.promptText ?? '');
      const c = estimateTokens(input.completionText ?? '');
      usage = { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: true };
      estimated = true;
    }

    /** @type {UsageRecord} */
    const rec = {
      at: now,
      convKey: input.convKey,
      model: input.model,
      proactive: input.proactive === true,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      estimated,
    };

    this.recent.push(rec);
    if (this.recent.length > this.limit) this.recent.shift();

    addTo(this.today, rec);
    if (rec.proactive) addTo(this.todayProactive, rec);

    // 追加写：JSONL 不需要原子替换（追加是原子的），文件坏了也只坏一行
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(rec)}\n`, 'utf8');
    } catch {
      // 记账失败不能影响对话本身
    }

    return rec;
  }

  /**
   * 给界面看的总计。
   *
   * @returns {object}
   */
  summary() {
    this.#rollDay(Date.now());
    return {
      today: { ...this.today },
      todayProactive: { ...this.todayProactive },
      /** 主动支出占比：用户一眼看出"有多少钱是它自己花的" */
      proactiveRatio:
        this.today.totalTokens > 0 ? Math.round((this.todayProactive.totalTokens / this.today.totalTokens) * 100) : 0,
      recent: this.recent.slice(-50),
    };
  }

  /** @param {number} now */
  #rollDay(now) {
    const key = dayKey(now);
    if (key === this.#dayKey) return;
    this.#dayKey = key;
    this.today = newDayBucket();
    this.todayProactive = newDayBucket();
  }
}

function newDayBucket() {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCalls: 0 };
}

/** @param {any} bucket @param {UsageRecord} rec */
function addTo(bucket, rec) {
  bucket.calls += 1;
  bucket.promptTokens += rec.promptTokens;
  bucket.completionTokens += rec.completionTokens;
  bucket.totalTokens += rec.totalTokens;
  if (rec.estimated) bucket.estimatedCalls += 1;
}

/** @param {number} ts */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
