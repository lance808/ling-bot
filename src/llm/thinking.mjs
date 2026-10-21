/**
 * 思考链路仓库 —— 只存不传的展示数据
 *
 * 推理模型（deepseek-reasoner / v4 等）会把「想的过程」放在 `reasoning_content`
 * 里单独返回。它**绝不能**拼回下一次请求的 messages：
 *   · 官方明确说过不要回传，部分上游会直接 400；
 *   · 它比答案长得多，回灌会让 token 暴涨。
 * 所以它只能走一条独立的侧信道：落盘、给界面看、然后忘掉。
 *
 * ## 为什么是「一天一个文件」
 *
 * 界面按日期分组展示，一天一个文件正好对上这个分组；
 * 也避免了「每次写都重写一个越来越大的单文件」——
 * 那样一天结束时的一次写入可能变成几十 MB，且原子替换的窗口很长。
 *
 * ## 三条容量闸门（都不是建议值）
 *
 *   MAX_REASONING_CHARS          单条思考截断，防一条把整个文件撑大
 *   MAX_ENTRIES_PER_CONV_PER_DAY 同会话当天条数上限，防一个话痨会话把别人挤掉
 *   MAX_DAYS / MAX_TOTAL_BYTES   超期删除 + 总量封顶，防磁盘被静默吃掉
 *
 * ## 写入必须原子
 *
 * 先写同目录的 `.tmp` 再 `rename`：进程被杀时不会留下半个 JSON。
 * 半个 JSON 的后果不是"丢这一条"，而是**下次启动整个文件读不出来**，
 * 于是那一天的所有思考全没了。
 *
 * 预判而不是事后补救：超过 8MB 时是**先删最旧的文件再写**，
 * 不是"写完发现超了再删"——后者在两次检查之间就可能把磁盘撑爆。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { writeTextAtomic } from '../config/atomic.mjs';

/** 单条思考最多存多少字符（超出截断并标注原长） */
export const MAX_REASONING_CHARS = 4000;
/** 同一会话同一天最多保留多少条（超出丢最旧的） */
export const MAX_ENTRIES_PER_CONV_PER_DAY = 200;
/** 只保留最近多少天 */
export const MAX_DAYS = 30;
/** 磁盘总占用上限（字节） */
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** 答案预览与工具名列表的长度上限（纯展示，不参与逻辑） */
export const MAX_PREVIEW_CHARS = 200;
export const MAX_TOOLS_PER_STEP = 20;

/** 落盘文件名的形状：只认 `<YYYY-MM-DD>.json`，`.tmp` 和杂物一律忽略 */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
/** 记录后合并写入的延迟：一回合可能连续记多条，没必要每条都碰一次磁盘 */
const FLUSH_DEBOUNCE_MS = 400;
/** 截断标记模板 */
const TRUNCATED_SUFFIX = (n) => `…（已截断，原 ${n} 字符）`;

/**
 * 本地时区的日期键 `YYYY-MM-DD`。
 *
 * 必须用本地时间而不是 UTC：用户晚上 11 点写的东西如果被算到"明天"，
 * 界面按日分组就会出现「今天只有下午的记录、上午的跑到昨天」这种怪事。
 *
 * @param {number} ts
 * @returns {string}
 */
export function localDateKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * N 天前的日期键。
 *
 * 用 setDate 而不是减 86400000 毫秒：夏令时切换那天不是 86400000 毫秒，
 * 减毫秒会让一些地区的日期算错一天。
 *
 * @param {number} now
 * @param {number} n
 * @returns {string}
 */
function daysAgoKey(now, n) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return localDateKey(d.getTime());
}

/**
 * 思考链路仓库。
 *
 * `record()` 是同步的（回合结束时调用方不该等着写盘），落盘由 `flush()` 完成；
 * 记录后会排一次防抖的自动落盘，进程正常退出时再显式 flush 一次兜底。
 */
export class ThinkingStore {
  /** @type {Map<string, {date: string, entries: Array<{at: number, convKey: string, steps: object[]}>}>} */
  #days = new Map();
  /** @type {string} */
  #dir;
  /** @type {() => number} */
  #now;
  /** @type {number} */
  #maxDays;
  /** @type {number} */
  #maxTotalBytes;
  /** 待落盘的日期 */
  /** @type {Set<string>} */
  #dirty = new Set();
  /**
   * 每个日期的修改版本号。
   *
   * ## 为什么必须有它（这里曾经真丢过数据）
   *
   * `#doFlush` 的形状是「先序列化 → await 写盘 → 清 dirty 标记」。写盘是
   * 真正的异步 IO，期间完全可能有一次 `record()` 落到同一天上。旧写法
   * 写完后无条件 `dirty.delete(date)`，于是那条**没被序列化进去**的新记录
   * 被一起当成"已保存"——它此后只在内存里，直到进程退出都不会再碰磁盘。
   *
   * 实测能丢得很难看：并发 200 次记录只落盘 32 条，用户看到的是
   * "思考链路里刚才明明有，重启就没了"。
   *
   * 所以记录写入带版本号：只有"写盘期间没有被改过"的日期才清 dirty，
   * 被改过的留着，下一轮 flush 再写一次。
   *
   * @type {Map<string, number>}
   */
  #rev = new Map();
  /** @type {NodeJS.Timeout | null} */
  #timer = null;
  /** @type {Promise<any> | null} */
  #inflight = null;
  /** 最近一次写盘/读盘的错误（不抛给上层，但留着可查） */
  /** @type {any} */
  lastError = null;

  /**
   * @param {{dir: string, now?: () => number, maxDays?: number, maxTotalBytes?: number}} opts
   */
  constructor(opts = {}) {
    const dir = opts?.dir;
    if (!dir) throw new TypeError('dir 必填');
    this.#dir = dir;
    this.#now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.#maxDays = Number.isFinite(opts.maxDays) ? Number(opts.maxDays) : MAX_DAYS;
    this.#maxTotalBytes = Number.isFinite(opts.maxTotalBytes)
      ? Number(opts.maxTotalBytes)
      : MAX_TOTAL_BYTES;
  }

  /** 目录（测试与排查用） */
  get dir() {
    return this.#dir;
  }

  /** 当前生效的总量上限（构造时可覆盖，默认 MAX_TOTAL_BYTES） */
  get maxTotalBytes() {
    return this.#maxTotalBytes;
  }

  /** 当前留给最近多少天（构造时可覆盖，默认 MAX_DAYS） */
  get maxDays() {
    return this.#maxDays;
  }

  /**
   * 启动时读回近期数据。
   *
   * 一个坏文件只跳过它自己：不能让某天的半截 JSON 把整个历史拖没。
   * `.tmp` 残留一律忽略——那是上次被杀的进程留下的，内容不保证完整。
   *
   * @returns {Promise<{loaded: number, removed: number}>}
   */
  async load() {
    const result = { loaded: 0, removed: 0 };

    let names;
    try {
      names = await fs.readdir(this.#dir);
    } catch (err) {
      // 首次运行没有这个目录是正常的，不该当成错误
      if (/** @type {any} */ (err)?.code !== 'ENOENT') this.lastError = err;
      return result;
    }

    this.#days.clear();
    this.#dirty.clear();
    this.#rev.clear();
    this.lastError = null;
    const cutoff = daysAgoKey(this.#now(), this.#maxDays - 1);

    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const date = m[1];
      // 超期的文件交给 pruneExpired 统一删（它同时会清内存）
      if (date < cutoff) continue;

      let raw;
      try {
        raw = await fs.readFile(this.#file(date), 'utf8');
      } catch (err) {
        this.lastError = err;
        continue;
      }
      const day = parseDay(date, raw);
      if (day) this.#days.set(date, day);
      else this.lastError = new Error('思考历史文件格式损坏');
    }

    result.loaded = this.#days.size;
    result.removed += await this.#pruneExpired();
    result.removed += await this.#trimToMax(new Map());
    return result;
  }

  /**
   * 记一次回合的思考。
   *
   * 没有 reasoning 就**什么都不做**：非推理模型（或上游没给）时整个功能
   * 必须静默降级，不能留一堆空对象把界面塞满。
   *
   * @param {{convKey?: string, at?: number, steps?: object[], answerPreview?: string}} entry
   * @returns {{at: number, convKey: string, steps: object[]} | null} 实际存下的记录；没存返回 null
   */
  record(entry) {
    const convKey = String(entry?.convKey ?? '');
    if (!convKey) return null;

    const at = Number.isFinite(entry?.at) ? Number(entry.at) : this.#now();
    /*
     * 已经超出保留期的 entry 直接丢。
     *
     * 正常情况下 at 就是 Date.now()，走不到这里；但补跑历史、时钟回拨、
     * 或者调用方传了旧时间戳时，先写一个建好就立刻被删的文件纯属浪费，
     * 更糟的是它可能在那次 flush 前的一瞬间被界面看到"多了个不该有的日期"。
     */
    if (localDateKey(at) < daysAgoKey(this.#now(), this.#maxDays - 1)) return null;

    // 入口给的 answerPreview 只作为"某一步自己没带预览"时的兜底
    const fallbackPreview = String(entry?.answerPreview ?? '');
    const steps = normalizeSteps(entry?.steps, fallbackPreview);
    if (steps.length === 0) return null;

    const date = localDateKey(at);
    const day = this.#day(date);

    // 同会话当天超限：丢这个会话最旧的那几条，别动别人的记录
    let same = day.entries.filter((e) => e.convKey === convKey).length;
    if (same >= MAX_ENTRIES_PER_CONV_PER_DAY) {
      let over = same - (MAX_ENTRIES_PER_CONV_PER_DAY - 1);
      for (let i = 0; i < day.entries.length && over > 0; ) {
        if (day.entries[i].convKey === convKey) {
          day.entries.splice(i, 1);
          over -= 1;
        } else {
          i += 1;
        }
      }
    }

    /** @type {{at: number, convKey: string, steps: object[]}} */
    const rec = { at, convKey, steps };
    day.entries.push(rec);
    this.#markDirty(date);
    this.#scheduleFlush();
    return rec;
  }

  /**
   * 给界面看的视图。
   *
   * 语义（前端依赖，改之前先对齐）：
   *   · `days` 按日期升序（旧 → 新），每天内部按 `at` 升序；
   *   · `days` 取**最近 N 个有数据的日期**（不是"最近 N 个自然日"），
   *     这样刚过零点时不会看到一个空面板；
   *   · `limit` 截的是"最近的 N 条"，先截再按时间升序返回；
   *   · `total` 是过滤后**所有留存天数**的条目总数，不受 days / limit 影响；
   *   · `conversations` 是**不受分页/筛选影响**的全量会话索引，
   *     供界面左栏列出"哪些群、哪些私聊有记录"。
   *
   * ## 游标坏了不许抛错（这里曾经让整条快照失败）
   *
   * 旧实现在游标解码失败或 convKey 不一致时直接 throw。而 `view()` 是在
   * `rpc.handle('snapshot')` 里同步调的 —— 一次抛错等于**一份完整快照都拿不到**，
   * 界面上表现成"新思考链路拉取失败"，连消息列表和连接状态一起冻住。
   *
   * 触发条件还很日常：用户先在「全部会话」翻了一页拿到游标，再切到
   * 「当前会话」，旧游标带着 `convKey: null` 过来，必然不匹配。
   *
   * 所以游标只当作**提示**：认不出来就退回最新一页，并置 `cursorIgnored`
   * 让界面把页码跳回第一页，而不是让整个界面白屏。
   *
   * 返回的是拷贝：调用方（界面快照）随便改都不会污染内存里的记录。
   *
   * @param {{convKey?: string | null, days?: number, limit?: number, before?: string, beforeDate?: string}} [query]
   * @returns {{days: Array<{date: string, entries: object[]}>, total: number}}
   */
  view(query = {}) {
    const convKey = query?.convKey ? String(query.convKey) : null;
    const dayCount = clampInt(query?.days, 1, 1, this.#maxDays);
    const limit = clampInt(query?.limit, 50, 1, 500);

    let total = 0;
    /** @type {Array<{date: string, entries: object[]}>} */
    const perDay = [];
    /*
     * 会话索引：一次遍历顺手攒出来。
     *
     * 它必须基于**全部留存数据**，而不是这一页的内容 —— 左栏是"目录"，
     * 目录不能因为翻到第 3 页就少几个会话。
     */
    /** @type {Map<string, {entries: number, steps: number, lastAt: number, firstAt: number}>} */
    const convIndex = new Map();
    for (const date of [...this.#days.keys()].sort()) {
      const day = this.#days.get(date);
      if (!day) continue;
      for (const entry of day.entries) {
        const slot = convIndex.get(entry.convKey) ?? { entries: 0, steps: 0, lastAt: 0, firstAt: Infinity };
        slot.entries += 1;
        slot.steps += entry.steps.length;
        slot.lastAt = Math.max(slot.lastAt, entry.at);
        slot.firstAt = Math.min(slot.firstAt, entry.at);
        convIndex.set(entry.convKey, slot);
      }
      const entries = day.entries
        .filter((e) => !convKey || e.convKey === convKey)
        .slice()
        .sort((a, b) => a.at - b.at);
      total += entries.length;
      if (entries.length > 0) perDay.push({ date, entries });
    }

    const available = perDay.filter(d => !query.beforeDate || d.date < String(query.beforeDate));

    /*
     * 解游标：任何异常都退化成"第一页"，不往上抛。
     * 前端会读 cursorIgnored 把页码复位，用户看到的只是"回到了最新一页"。
     */
    let pageEnd = null;
    let cursorIgnored = false;
    if (query.before) {
      const cursor = decodeCursor(query.before);
      if (cursor && cursor.convKey === convKey) {
        pageEnd = cursor.end;
      } else {
        cursorIgnored = true;
      }
    }

    const picked = available;
    /** @type {Array<{date: string, entry: any}>} */
    const flat = [];
    for (const day of picked) for (const entry of day.entries) flat.push({ date: day.date, entry });
    const end = pageEnd === null ? flat.length : Math.min(pageEnd, flat.length);
    const dates = [...new Set(flat.slice(0, end).map(x => x.date))].slice(-dayCount);
    let start = Math.max(0, end - limit);
    while (start < end && !dates.includes(flat[start].date)) start++;
    const keep = flat.slice(start, end);

    /** @type {Map<string, object[]>} */
    const grouped = new Map();
    for (const { date, entry } of keep) {
      const list = grouped.get(date) ?? [];
      list.push(cloneEntry(entry));
      grouped.set(date, list);
    }

    return {
      days: [...grouped.entries()].map(([date, entries]) => ({ date, entries })),
      total,
      entryCount: keep.length,
      stepCount: keep.reduce((n, x) => n + x.entry.steps.length, 0),
      hasMore: start > 0,
      nextBefore: start > 0 ? Buffer.from(JSON.stringify({ convKey, end: start })).toString('base64url') : null,
      nextBeforeDate: start > 0 ? keep[0]?.date ?? null : null,
      /** 游标被丢弃（损坏或与当前筛选不匹配）→ 界面应把页码复位 */
      cursorIgnored,
      /*
       * 全量会话索引，按"最近有记录"倒序。
       *
       * 带上 entries / steps 两个计数：左栏要显示"几条思考"，
       * 而一条记录可能含多步，直接给两个数比让前端自己加更省事。
       */
      conversations: [...convIndex.entries()]
        .map(([key, v]) => ({ convKey: key, entries: v.entries, steps: v.steps, lastAt: v.lastAt, firstAt: v.firstAt }))
        .sort((a, b) => b.lastAt - a.lastAt),
      /** 所有有数据的日期（升序），供"删除某一天"确认与范围提示 */
      dayKeys: [...this.#days.keys()].sort(),
      lastError: this.lastError ? '思考仓库读取或写入失败，历史可能不完整' : null,
      retentionDays: this.#maxDays,
    };
  }

  /**
   * 清空某一天（默认今天）。
   *
   * @param {string} [date] `YYYY-MM-DD`
   * @returns {Promise<{date: string, removed: number}>}
   */
  async clearDay(date) {
    const target = typeof date === 'string' && date ? date : localDateKey(this.#now());
    const day = this.#days.get(target);
    const removed = day?.entries.length ?? 0;

    this.#days.delete(target);
    this.#dirty.delete(target);
    // 版本号也要跟着作废：否则下次同一天再记录时，脏标记会和旧版本号对不上
    this.#rev.set(target, this.#revOf(target) + 1);
    try {
      await fs.unlink(this.#file(target));
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'ENOENT') {
        this.lastError = err;
        // 删不掉时把内存也退回去：否则界面说"已清空"、重启又全回来了
        if (day) this.#days.set(target, day);
        return { date: target, removed: 0 };
      }
    }
    return { date: target, removed };
  }

  /**
   * 落盘。
   *
   * 串行化：同一时刻只允许一次写，后来的调用排在前一次之后。
   * 并发写同一个文件会互相覆盖（rename 有先后），最后留下哪份是碰运气。
   *
   * @returns {Promise<{written: number, removed: number}>}
   */
  flush() {
    if (this.#inflight) return this.#inflight.then(() => this.flush());
    this.#inflight = this.#doFlush().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /* ------------------------------------------------------------ 内部 */

  /**
   * @param {string} date
   */
  #day(date) {
    let day = this.#days.get(date);
    if (!day) {
      day = { date, entries: [] };
      this.#days.set(date, day);
    }
    return day;
  }

  /** @param {string} date */
  #file(date) {
    return path.join(this.#dir, `${date}.json`);
  }

  /**
   * 标记某天待落盘，并把它的版本号 +1。
   *
   * 所有"内存里的这一天变了"的路径都必须走这里（record / clearDay 回滚），
   * 否则版本号对不上，落盘会误判成"没变化"而跳过。
   *
   * @param {string} date
   */
  #markDirty(date) {
    this.#dirty.add(date);
    this.#rev.set(date, (this.#rev.get(date) ?? 0) + 1);
  }

  /** @param {string} date */
  #revOf(date) {
    return this.#rev.get(date) ?? 0;
  }

  /** 排一次防抖落盘；已经排了就不重复排 */
  #scheduleFlush() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // flush 内部已经吃掉错误；这里的 catch 只是防"连 catch 都抛"的极端情况
      void this.flush().catch(() => {});
    }, FLUSH_DEBOUNCE_MS);
    // 定时器不该拖住进程退出（退出前会显式 flush）
    this.#timer.unref?.();
  }

  async #doFlush() {
    const result = { written: 0, removed: 0 };
    const dates = [...this.#dirty].sort();
    if (dates.length === 0) return result;

    try {
      await fs.mkdir(this.#dir, { recursive: true });
    } catch (err) {
      this.lastError = err;
      return result;
    }

    // 1) 先按天龄删，比按体积删便宜且覆盖绝大多数情况
    result.removed += await this.#pruneExpired();

    // 2) 序列化待写内容，算清楚"写完会占多大"
    //
    //    **版本号必须和文本一起记下来**：写盘是异步的，等它回来时
    //    这一天可能已经被追加过新记录，那时就不能清 dirty（见 #rev 的注释）。
    /** @type {Map<string, string>} */
    const payloads = new Map();
    /** @type {Map<string, number>} 序列化时的版本号（date → rev） */
    const written = new Map();
    for (const date of dates) {
      const day = this.#days.get(date);
      if (!day) {
        this.#dirty.delete(date);
        continue;
      }
      payloads.set(date, serializeDay(day));
      written.set(date, this.#revOf(date));
    }
    if (payloads.size === 0) return result;

    // 3) **写之前**就把体积压到上限内：写完再删的话，
    //    两次检查之间的窗口里磁盘可能已经被撑爆
    result.removed += await this.#trimToMax(payloads);

    for (const [date, text] of payloads) {
      try {
        await writeTextAtomic(this.#file(date), text);
        /*
         * 只有"写盘期间这一天没再被改过"才清 dirty。
         *
         * 这里曾经是无条件 delete，于是写盘期间新 record 进来的那条
         * 从未落盘（序列化时它还不存在，写完却被标成已保存）。
         * 数据只在内存里活到进程退出 —— 表现为"历史未保存"。
         */
        if (this.#revOf(date) === written.get(date)) {
          this.#dirty.delete(date);
        } else {
          // 还有没写进去的新内容：留着 dirty，让下一轮 flush 再写
          result.rewritten = (result.rewritten ?? 0) + 1;
          this.#scheduleFlush();
        }
        result.written += 1;
      } catch (err) {
        // 保留 dirty 标记：下次 flush 会再试一次
        this.lastError = err;
      }
    }
    return result;
  }

  /**
   * 删除超过 MAX_DAYS 的日期（内存 + 磁盘）。
   *
   * @returns {Promise<number>}
   */
  async #pruneExpired() {
    const cutoff = daysAgoKey(this.#now(), this.#maxDays - 1);
    const sizes = await this.#existingSizes();
    const all = new Set([...this.#days.keys(), ...sizes.keys()]);
    let removed = 0;
    for (const date of all) {
      if (date >= cutoff) continue;
      try {
        await fs.unlink(this.#file(date));
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'ENOENT') this.lastError = err;
      }
      this.#days.delete(date);
      this.#dirty.delete(date);
      removed += 1;
    }
    return removed;
  }

  /**
   * 把总占用压到上限内：从最旧的文件开始删。
   *
   * 待写的日期不参与删除——正在记的这条不能被"腾地方"顺手删掉。
   *
   * @param {Map<string, string>} payloads 本次要写的（date → 文本）
   * @returns {Promise<number>}
   */
  async #trimToMax(payloads) {
    const sizes = await this.#existingSizes();
    let total = 0;
    for (const [date, text] of payloads) total += byteLength(text);
    for (const [date, size] of sizes) if (!payloads.has(date)) total += size;
    if (total <= this.#maxTotalBytes) return 0;

    let removed = 0;
    const olds = [...sizes.keys()].filter((d) => !payloads.has(d)).sort();
    for (const date of olds) {
      if (total <= this.#maxTotalBytes) break;
      try {
        await fs.unlink(this.#file(date));
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'ENOENT') this.lastError = err;
        continue;
      }
      total -= sizes.get(date) ?? 0;
      this.#days.delete(date);
      this.#dirty.delete(date);
      removed += 1;
    }
    return removed;
  }

  /**
   * 目录里现有的按日文件及大小。
   *
   * @returns {Promise<Map<string, number>>}
   */
  async #existingSizes() {
    /** @type {Map<string, number>} */
    const sizes = new Map();
    let names;
    try {
      names = await fs.readdir(this.#dir);
    } catch {
      return sizes;
    }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      try {
        const st = await fs.stat(path.join(this.#dir, name));
        sizes.set(m[1], st.size);
      } catch {
        // 刚好被删掉：忽略
      }
    }
    return sizes;
  }
}

/* ---------------------------------------------------------------- 纯函数 */

/**
 * 归一化入参里的 steps：没有思考的步直接丢掉（不留空对象）。
 *
 * @param {any} steps
 * @param {string} fallbackPreview
 * @returns {object[]}
 */
function normalizeSteps(steps, fallbackPreview) {
  if (!Array.isArray(steps)) return [];
  const out = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const reasoning = typeof s?.reasoning === 'string' ? s.reasoning : '';
    if (reasoning.trim().length === 0) continue;
    const own = typeof s?.answerPreview === 'string' ? s.answerPreview : '';
    out.push({
      n: Number.isFinite(s?.n) ? Number(s.n) : i + 1,
      reasoning: truncateReasoning(reasoning),
      tools: Array.isArray(s?.tools)
        ? s.tools.filter((t) => typeof t === 'string').slice(0, MAX_TOOLS_PER_STEP)
        : [],
      answerPreview: truncatePreview(own || fallbackPreview),
    });
  }
  return out;
}

/**
 * 从磁盘读回时的归一化：不复用 normalizeSteps。
 *
 * 原因：已经截断过的文本再截一次会把「…（已截断，原 N 字符）」里的 N 改错，
 * 而且会丢掉标记尾巴。磁盘上的数据是我们自己原子写下去的，只需校验形状。
 *
 * @param {any} steps
 * @returns {object[]}
 */
function normalizeStepsFromDisk(steps) {
  if (!Array.isArray(steps)) return [];
  const out = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const reasoning = typeof s?.reasoning === 'string' ? s.reasoning : '';
    if (reasoning.trim().length === 0) continue;
    out.push({
      n: Number.isFinite(s?.n) ? Number(s.n) : i + 1,
      reasoning,
      tools: Array.isArray(s?.tools)
        ? s.tools.filter((t) => typeof t === 'string').slice(0, MAX_TOOLS_PER_STEP)
        : [],
      answerPreview: typeof s?.answerPreview === 'string' ? s.answerPreview : '',
    });
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateReasoning(text) {
  if (text.length <= MAX_REASONING_CHARS) return text;
  return `${text.slice(0, MAX_REASONING_CHARS)}${TRUNCATED_SUFFIX(text.length)}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncatePreview(text) {
  const s = String(text ?? '');
  return s.length <= MAX_PREVIEW_CHARS ? s : `${s.slice(0, MAX_PREVIEW_CHARS)}…`;
}

/**
 * @param {{date: string, entries: object[]}} day
 * @returns {string}
 */
function serializeDay(day) {
  // 紧凑 JSON：8MB 是硬上限，缩进换来的可读性不值这个空间
  return `${JSON.stringify({ date: day.date, entries: day.entries })}\n`;
}

/**
 * @param {string} date
 * @param {string} raw
 * @returns {{date: string, entries: object[]} | null} 坏数据返回 null
 */
function parseDay(date, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data?.entries)) return null;

  const entries = [];
  for (const e of data.entries) {
    if (!e || typeof e !== 'object') continue;
    const convKey = String(e.convKey ?? '');
    if (!convKey) continue;
    const steps = normalizeStepsFromDisk(e.steps);
    if (steps.length === 0) continue;
    entries.push({ at: Number.isFinite(e.at) ? Number(e.at) : 0, convKey, steps });
  }
  entries.sort((a, b) => a.at - b.at);
  return { date, entries };
}

/**
 * @param {object} entry
 * @returns {object}
 */
function cloneEntry(entry) {
  return {
    at: entry.at,
    convKey: entry.convKey,
    steps: entry.steps.map((s) => ({
      n: s.n,
      reasoning: s.reasoning,
      tools: [...s.tools],
      answerPreview: s.answerPreview,
    })),
  };
}

/**
 * 解一个分页游标。
 *
 * 游标是 `{convKey, end}` 的 base64url。**任何不合法的输入都返回 null**，
 * 绝不抛错 —— 它来自界面，而界面状态可能是上一轮筛选留下的、
 * 也可能被中途重启打断。解不开只应该"退回第一页"，不该让整份快照失败。
 *
 * @param {any} raw
 * @returns {{convKey: string | null, end: number} | null}
 */
function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let text;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let cursor;
  try {
    cursor = JSON.parse(text);
  } catch {
    return null;
  }
  if (!cursor || typeof cursor !== 'object') return null;
  const convKey = typeof cursor.convKey === 'string' && cursor.convKey ? cursor.convKey : null;
  if (!Number.isSafeInteger(cursor.end) || cursor.end < 0) return null;
  return { convKey, end: cursor.end };
}

/**
 * @param {string} text
 * @returns {number}
 */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * @param {any} value
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
