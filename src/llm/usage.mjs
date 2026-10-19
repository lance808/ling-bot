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
