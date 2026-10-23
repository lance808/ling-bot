/**
 * 会话楼层仓库 —— F5
 *
 * 每条消息在本会话里有一个**楼层号**（floor）：1、2、3……单调递增，重启不倒退。
 * 楼层号是本地概念，和 QQ 的 messageId 是两件事 —— messageId 由上游给、
 * 可能重复也可能缺，楼层号由我们自己分配、保证唯一且连续。
 *
 * ## 为什么要楼层，而不直接「取最近 20 条」
 *
 * 「最近 N 条」这个说法里藏着一个致命的模糊：**N 条从哪里算起**。
 * 一旦模型看了一部分、没看另一部分，就需要一个精确的记号回答
 * 「它看到哪儿了」，否则会出现两种坏情况：
 *
 *   · 重复处理 —— 同一批消息被喂给模型两次，它重复回答
 *   · 静默跳过 —— 中间几条被跳过，用户的问题永远没被回答
 *
 * 楼层号 + 读楼层（readThroughFloor）就是这个记号。规则只有一条，
 * 但它必须绝对可靠：
 *
 *   **读楼层只能停在「已喂给模型」或「已被缓冲淘汰」的楼之前。**
 *
 * 也就是说，中间只要还有一栋楼没被喂过，读楼层就不许越过它 ——
 * 否则那条消息永远不会再被处理，而且没有任何报错。
 *
 * ## 为什么淘汰也能推进读楼层
 *
 * 缓冲有上限（默认 200 条/会话）。被挤出去的消息已经不可能再被展示或处理，
 * 如果读楼层还卡在它前面，就会**永久卡死**：每次算读楼层都停在同一处，
 * 后面的消息再也进不了模型。所以淘汰时要记下 `evictedThrough`，
 * 让读楼层可以合法地跨过这些"已经不存在的楼"。
 *
 * ## 落盘
 *
 * 整个仓库是一个 `sessions.json`，原子写。防抖 400ms，退出时 flush。
 * 这里照搬 thinking.mjs 的 dirty/version 做法，因为那边踩过一个真实的坑：
 * 写盘期间进来的新数据被误标为"已保存"，于是只在内存里活到进程退出。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../config/atomic.mjs';

/** 每会话保留多少条消息（超出丢最旧的，并把 floor 记进 evictedThrough） */
export const MAX_MESSAGES_PER_CONV = 200;
/** 每个会话最多记多少个「已喂给模型」的楼层号（防无限增长） */
export const MAX_SEEN_FLOORS = 500;
/** 落盘防抖：一回合可能连写很多条，没必要每条都碰磁盘 */
const FLUSH_DEBOUNCE_MS = 400;
/** 会话总数上限：防止被大量临时群/私聊撑爆内存与磁盘 */
export const MAX_CONVERSATIONS = 500;

/** 会话键形状，与 onebot/events.mjs 的约定一致 */
const CONV_KEY_RE = /^(group|private):\d+$/;

/** 本地日期键形状：只接受两位补零，避免同一日期有两种写法 */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 空会话状态。
 *
 * @param {string} convKey
 * @returns {object}
 */
function emptyConv(convKey) {
  return {
    convKey,
    /** 该会话收到过的最高楼层 */
    lastFloor: 0,
    /** 已确认读到第几楼（可以跨过的只有"喂过"和"已淘汰"的楼） */
    readThroughFloor: 0,
    /** 真正喂给过模型的消息楼层（有界） */
    modelSeenFloors: new Set(),
    /** 已被缓冲淘汰掉的最高楼层：这些楼不可能再被处理，读楼层可以跨过 */
    evictedThrough: 0,
    /** 消息本体，按楼层升序 */
    messages: [],
    /**
     * 每天有多少条消息：`{ 'YYYY-MM-DD': count }`。
     *
     * ## 为什么单独记一份，而不是从 messages 里数
     *
     * messages 只有最近 200 条。一个活跃群两天就能刷满，昨天之前的部分
     * 全被淘汰了 —— 那时候从 messages 里数"昨天有没有活动"会得到 0，
     * 于是日记生成器以为昨天没人说话，直接不生成。用户看到的是
     * "日记整个消失"，而且没有任何报错。
     *
     * 这个映射只增不减（按日期，键的数量以天为单位增长，很小），
     * 所以它描述的是"历史事实"而不是"当前缓冲里有什么"。
     */
    activityByDate: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 会话楼层仓库。
 *
 * 设计上刻意**不碰网络、不碰配置**：它只管"存消息、发楼层号、记谁被看过"。
 * 这样它可以在测试里用临时目录完整跑一遍，而不需要起机器人。
 */
export class SessionStore {
  /** @type {Map<string, object>} */
  #convs = new Map();
  /** @type {string} */
  #filePath;
  /** @type {() => number} */
  #now;
  /** @type {number} */
  #maxMessages;
  /** @type {boolean} 有未落盘的改动 */
  #dirty = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #flushTimer = null;
  /**
   * 每次改动递增的版本号。
   *
   * 落盘是异步的：序列化之后、写盘完成之前完全可能又进来一条消息。
   * 如果写完就无条件把 dirty 清掉，那条新消息会被当成"已保存"，
   * 之后只在内存里活到进程退出 —— thinking.mjs 在这里真丢过数据。
   */
  #version = 0;
  /** 正在进行的落盘 Promise（防止并发写同一个文件） */
  /** @type {Promise<void> | null} */
  #flushing = null;

  /**
   * @param {{filePath: string, now?: () => number, maxMessages?: number}} opts
   */
  constructor(opts) {
    if (!opts?.filePath) throw new TypeError('SessionStore 需要 filePath');
    this.#filePath = opts.filePath;
    this.#now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.#maxMessages = Number.isFinite(opts.maxMessages)
      ? Math.max(1, Math.round(Number(opts.maxMessages)))
      : MAX_MESSAGES_PER_CONV;
  }

  /* ------------------------------------------------------------ 读 */

  /**
   * 取（或建）一个会话的状态。**内部用，返回的是活对象**。
   *
   * @param {string} convKey
   * @returns {object | null} 会话键非法时返回 null
   */
  #conv(convKey, create = true) {
    if (!CONV_KEY_RE.test(String(convKey ?? ''))) return null;
    let c = this.#convs.get(convKey);
    if (!c) {
      if (!create) return null;
      c = emptyConv(convKey);
      c.createdAt = this.#now();
      c.updatedAt = c.createdAt;
      this.#convs.set(convKey, c);
      this.#evictOldConversations();
    }
    return c;
  }

  /** 会话键是否合法（供上层提前校验，避免悄悄建出一个空会话） */
  isValidKey(convKey) {
    return CONV_KEY_RE.test(String(convKey ?? ''));
  }

  /**
   * 列出所有会话的概要（不含消息本体），按最近更新排序。
   *
   * @returns {Array<{convKey: string, lastFloor: number, readThroughFloor: number, unread: number, count: number, updatedAt: number}>}
   */
  list() {
    return [...this.#convs.values()]
      .map((c) => ({
        convKey: c.convKey,
        lastFloor: c.lastFloor,
        readThroughFloor: this.readThroughFloor(c.convKey),
        unread: Math.max(0, c.lastFloor - this.readThroughFloor(c.convKey)),
        count: c.messages.length,
        updatedAt: c.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 按楼层取一页消息。
   *
   * 三种调用方式（互斥，同时给会抛错）：
   *   · 都不给      → 最新一页（尾部）
   *   · afterFloor  → 楼层号 > afterFloor 的**最早**一页（补读未读）
   *   · beforeFloor → 楼层号 < beforeFloor 的**最晚**一页（向上翻历史）
   *
   * @param {string} convKey
   * @param {{afterFloor?: number, beforeFloor?: number, limit?: number}} [opts]
   * @returns {{ok: true, messages: object[], readThroughFloor: number, lastFloor: number, hasMore: boolean}
   *          | {ok: false, code: string, message: string}}
   */
  page(convKey, opts = {}) {
    const c = this.#conv(convKey, false);
    const limit = normalizeLimit(opts.limit);
    if (limit === null) {
      return { ok: false, code: 'E4010', message: 'limit 必须是 1~200 的整数' };
    }

    const hasAfter = opts.afterFloor !== undefined && opts.afterFloor !== null;
    const hasBefore = opts.beforeFloor !== undefined && opts.beforeFloor !== null;
    if (hasAfter && hasBefore) {
      return { ok: false, code: 'E4010', message: 'afterFloor 与 beforeFloor 不能同时给' };
    }
    if (hasAfter && !isFloorNumber(opts.afterFloor)) {
      return { ok: false, code: 'E4010', message: 'afterFloor 必须是非负整数' };
    }
    if (hasBefore && !isFloorNumber(opts.beforeFloor)) {
      return { ok: false, code: 'E4010', message: 'beforeFloor 必须是非负整数' };
    }

    // 会话不存在不是错误：界面刚打开、这个群还没消息，就该是空列表
    if (!c) {
      return { ok: true, messages: [], readThroughFloor: 0, lastFloor: 0, hasMore: false };
    }

    const all = c.messages;
    let slice;
    let hasMore;

    if (hasAfter) {
      // 最早的一页：从读楼层之后按时间顺序取
      const from = all.findIndex((m) => m.floor > opts.afterFloor);
      const start = from < 0 ? all.length : from;
      slice = all.slice(start, start + limit);
      hasMore = start + slice.length < all.length;
    } else if (hasBefore) {
      // 向上翻：取 beforeFloor 之前最靠近它的那一页
      const to = all.findIndex((m) => m.floor >= opts.beforeFloor);
      const end = to < 0 ? all.length : to;
      const start = Math.max(0, end - limit);
      slice = all.slice(start, end);
      hasMore = start > 0;
    } else {
      // 默认：最新一页
      const start = Math.max(0, all.length - limit);
      slice = all.slice(start);
      hasMore = start > 0;
    }

    return {
      ok: true,
      // 返回副本：调用方改到消息对象不该反过来污染仓库
      messages: slice.map((m) => ({ ...m })),
      readThroughFloor: this.readThroughFloor(convKey),
      lastFloor: c.lastFloor,
      hasMore,
    };
  }

  /**
   * 取某个会话在指定楼层之后、尚未喂给模型的楼层列表。
   *
   * 这是回合开始时要消费的内容 —— 它必须和读楼层的口径一致，
   * 否则会出现「读楼层说读过了，但模型其实没看到」。
   *
   * @param {string} convKey
   * @param {{afterFloor?: number, limit?: number}} [opts]
   * @returns {object[]}
   */
  unreadMessages(convKey, opts = {}) {
    const c = this.#conv(convKey, false);
    if (!c) return [];
    const after = isFloorNumber(opts.afterFloor) ? opts.afterFloor : this.readThroughFloor(convKey);
    const limit = normalizeLimit(opts.limit) ?? 50;
    return c.messages.filter((m) => m.floor > after).slice(0, limit).map((m) => ({ ...m }));
  }

  /**
   * 已读到第几楼。
   *
   * ## 算法（唯一的正确性要点）
   *
   * 从当前读楼层开始往上走，只要下一栋楼是「喂过模型」或者「已经被淘汰」，
   * 就前进一步；一旦遇到一栋**还存在但没喂过**的楼，立刻停住。
   *
   * 这就是「绝不允许越过一栋仍然待处理的楼」的落地方式。
   *
   * @param {string} convKey
   * @returns {number}
   */
  readThroughFloor(convKey) {
    const c = this.#conv(convKey, false);
    if (!c) return 0;

    let through = Math.max(0, c.readThroughFloor | 0);
    const last = c.lastFloor | 0;

    while (through < last) {
      const next = through + 1;
      if (c.modelSeenFloors.has(next) || next <= c.evictedThrough) {
        through = next;
        continue;
      }
      break;
    }
    return through;
  }

  /**
   * 未读条数：最高楼层减去读楼层。
   *
   * @param {string} convKey
   * @returns {number}
   */
  unreadCount(convKey) {
    const c = this.#conv(convKey, false);
    if (!c) return 0;
    return Math.max(0, c.lastFloor - this.readThroughFloor(convKey));
  }

  /* ------------------------------------------------------------ 写 */

  /**
   * 追加一条消息，返回它的楼层号。
   *
   * 楼层号由仓库分配，**不接受调用方传入** —— 否则两处同时给号就会撞。
   *
   * @param {string} convKey
   * @param {object} evt 归一化后的事件
   * @returns {{ok: true, floor: number, message: object} | {ok: false, code: string, message: string}}
   */
  append(convKey, evt) {
    const c = this.#conv(convKey);
    if (!c) return { ok: false, code: 'E4010', message: `会话键非法：${convKey}` };

    const floor = (c.lastFloor | 0) + 1;
    const at = this.#now();
    const message = {
      floor,
      messageId: evt?.messageId ?? null,
      userId: String(evt?.sender?.userId ?? ''),
      nickname: evt?.sender?.nickname ?? '',
      text: String(evt?.text ?? ''),
      atSelf: evt?.atSelf === true,
      replyTo: evt?.replyTo ?? null,
      isGroup: evt?.isGroup === true,
      time: evt?.time ?? Math.floor(at / 1000),
      /** 入库时刻（毫秒），与 QQ 的 time（秒）区分开 */
      receivedAt: at,
    };

    c.lastFloor = floor;
    c.messages.push(message);
    c.updatedAt = at;

    /*
     * 按本地日期记账。
     *
     * 用本地日期键而不是 UTC：用户眼里的"昨天"是本地的昨天
     * （UTC+8 早上八点前 UTC 还停在昨天，日记就会在错误的时刻生成）。
     */
    const dayKey = localDayKey(at);
    if (dayKey) c.activityByDate[dayKey] = (c.activityByDate[dayKey] ?? 0) + 1;

    // 超出上限：丢最旧的，并把它的楼层记进 evictedThrough（否则读楼层会永久卡死）
    if (c.messages.length > this.#maxMessages) {
      const drop = c.messages.length - this.#maxMessages;
      const removed = c.messages.splice(0, drop);
      const lastRemoved = removed[removed.length - 1];
      if (lastRemoved) c.evictedThrough = Math.max(c.evictedThrough, lastRemoved.floor);
      this.#pruneSeen(c);
    }

    this.#touch();
    return { ok: true, floor, message: { ...message } };
  }

  /**
   * 标记这些楼层已经喂给过模型。
   *
   * 只接受**真实存在**的楼层：凭空记一个未来楼层会让读楼层直接跳过
   * 中间还没处理的消息 —— 那是这个模块最不能犯的错。
   *
   * @param {string} convKey
   * @param {number[]} floors
   * @returns {number} 实际登记了几个
   */
  markModelSeen(convKey, floors) {
    const c = this.#conv(convKey, false);
    if (!c) return 0;
    if (!Array.isArray(floors)) return 0;

    const existing = new Set(c.messages.map((m) => m.floor));
    let added = 0;
    for (const f of floors) {
      if (!isFloorNumber(f)) continue;
      if (!existing.has(f)) continue; // 不存在或已淘汰的楼：不记
      if (c.modelSeenFloors.has(f)) continue;
      c.modelSeenFloors.add(f);
      added += 1;
    }
    if (added > 0) {
      this.#pruneSeen(c);
      c.updatedAt = this.#now();
      this.#touch();
    }
    return added;
  }

  /**
   * 显式把读楼层推到某处（例如用户点了「全部标记已读」）。
   *
   * 仍然受同一条约束：不许越过未处理且未淘汰的楼。所以这里不是直接赋值，
   * 而是先把 throughFloor 之前的楼全部登记为「已喂过」，再让算法自己算。
   *
   * @param {string} convKey
   * @param {number} floor
   * @returns {{ok: boolean, readThroughFloor: number}}
   */
  acknowledge(convKey, floor) {
    const c = this.#conv(convKey, false);
    if (!c) return { ok: false, readThroughFloor: 0 };
    if (!isFloorNumber(floor)) return { ok: false, readThroughFloor: this.readThroughFloor(convKey) };

    const target = Math.min(floor, c.lastFloor);
    // 把 target 及之前的、仍存在的楼全部算作"已处理"
    for (const m of c.messages) {
      if (m.floor <= target) c.modelSeenFloors.add(m.floor);
    }
    this.#pruneSeen(c);
    c.readThroughFloor = target;
    c.updatedAt = this.#now();
    this.#touch();
    return { ok: true, readThroughFloor: this.readThroughFloor(convKey) };
  }

  /**
   * 某个本地日期有没有会话活动。
   *
   * 日记生成器用它判断「昨天值不值得写一篇」：没人说话的日期
   * 生成出来只会是一条纯占位，没有意义。
   *
   * 这里查的是 activityByDate（历史累计），**不是** messages ——
   * 后者只有最近 200 条，活跃群两天就会把昨天的部分淘汰掉。
   *
   * @param {string} date 本地日期键 `YYYY-MM-DD`
   * @returns {boolean}
   */
  hasActivityOn(date) {
    const key = String(date ?? '');
    for (const c of this.#convs.values()) {
      if ((c.activityByDate[key] ?? 0) > 0) return true;
    }
    return false;
  }

  /**
   * 某个本地日期的消息总数（跨所有会话）。
   *
   * @param {string} date
   * @returns {number}
   */
  activityCountOn(date) {
    const key = String(date ?? '');
    let total = 0;
    for (const c of this.#convs.values()) total += c.activityByDate[key] ?? 0;
    return total;
  }

  /**
   * 某个本地日期有活动的会话列表，按当天消息数降序。
   *
   * 日记生成时用它决定"今天主要聊了什么"，以及取哪些会话的摘录。
   *
   * @param {string} date
   * @returns {Array<{convKey: string, count: number}>}
   */
  conversationsOn(date) {
    const key = String(date ?? '');
    const out = [];
    for (const c of this.#convs.values()) {
      const count = c.activityByDate[key] ?? 0;
      if (count > 0) out.push({ convKey: c.convKey, count });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  /** 删掉一个会话（界面「清空」用） */
  remove(convKey) {
    const ok = this.#convs.delete(convKey);
    if (ok) this.#touch();
    return ok;
  }

  /** 会话数量（诊断用） */
  get conversationCount() {
    return this.#convs.size;
  }

  /* ------------------------------------------------------------ 内部 */

  /**
   * 修剪 modelSeenFloors：只保留仍存在（或仍有意义）的楼层，并限制总量。
   *
   * 不修剪的后果不是"多占一点内存"：`Set` 会一直涨，而且淘汰掉的楼层
   * 已经由 evictedThrough 表达了，留着它们只是噪音。
   *
   * @param {object} c
   */
  #pruneSeen(c) {
    const existing = new Set(c.messages.map((m) => m.floor));
    for (const f of c.modelSeenFloors) {
      if (!existing.has(f)) c.modelSeenFloors.delete(f);
    }
    if (c.modelSeenFloors.size <= MAX_SEEN_FLOORS) return;
    // 超限时保留较大的楼层号（较新的），旧的由 readThroughFloor 的历史值兜住
    const sorted = [...c.modelSeenFloors].sort((a, b) => a - b);
    const drop = sorted.slice(0, sorted.length - MAX_SEEN_FLOORS);
    for (const f of drop) c.modelSeenFloors.delete(f);
  }

  /** 会话总数超限时淘汰最久没更新的（保留活跃的） */
  #evictOldConversations() {
    if (this.#convs.size <= MAX_CONVERSATIONS) return;
    const sorted = [...this.#convs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    const drop = sorted.slice(0, this.#convs.size - MAX_CONVERSATIONS);
    for (const c of drop) this.#convs.delete(c.convKey);
  }

  /** 标脏并排一次防抖落盘 */
  #touch() {
    this.#dirty = true;
    this.#version += 1;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    this.#flushTimer.unref?.();
  }

  /* ------------------------------------------------------------ 落盘 */

  /**
   * 落盘。
   *
   * 用版本号判断"写盘期间有没有新改动"：只有没被改过才清 dirty，
   * 否则留着让下一轮再写一次。这是 thinking.mjs 用真实数据丢过之后的做法。
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (!this.#dirty) return;
    // 已经有落盘在跑：等它跑完再说，避免两个写同一文件
    if (this.#flushing) return this.#flushing;

    const versionAtStart = this.#version;
    const payload = this.#serialize();
    this.#dirty = false;

    this.#flushing = (async () => {
      try {
        await writeJsonAtomic(this.#filePath, payload);
      } catch {
        // 写失败必须重新标脏，否则这批数据就永远丢了
        this.#dirty = true;
      } finally {
        this.#flushing = null;
        // 写盘期间又有改动 → 保持脏，下一轮再写
        if (this.#version !== versionAtStart) this.#dirty = true;
      }
    })();

    return this.#flushing;
  }

  /** @returns {object} */
  #serialize() {
    const conversations = {};
    for (const [key, c] of this.#convs) {
      conversations[key] = {
        convKey: c.convKey,
        lastFloor: c.lastFloor,
        readThroughFloor: c.readThroughFloor,
        evictedThrough: c.evictedThrough,
        modelSeenFloors: [...c.modelSeenFloors],
        activityByDate: c.activityByDate,
        messages: c.messages,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    }
    return { version: 1, savedAt: this.#now(), conversations };
  }

  /**
   * 从磁盘恢复。
   *
   * ## 损坏文件绝不能拦住启动
   *
   * 会话历史是"有更好、没有也能聊"的数据。为了它起不来是本末倒置。
   * 所以这里把所有异常都吃掉，把坏文件改名成 `.corrupt` 留证据，
   * 然后从一个空仓库开始 —— 用户至少能继续用。
   *
   * @returns {Promise<{ok: boolean, loaded: number, recovered: boolean, error?: string}>}
   */
  async load() {
    let raw;
    try {
      const text = await fs.readFile(this.#filePath, 'utf8');
      raw = JSON.parse(text);
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.code === 'ENOENT') return { ok: true, loaded: 0, recovered: false };
      // 文件在但读不出来 / 不是合法 JSON：留证据后重建
      await this.#quarantine(e?.message ?? String(e));
      return { ok: false, loaded: 0, recovered: true, error: String(e?.message ?? e) };
    }

    if (!raw || typeof raw !== 'object' || typeof raw.conversations !== 'object' || raw.conversations === null) {
      await this.#quarantine('结构不是 { conversations: {...} }');
      return { ok: false, loaded: 0, recovered: true, error: '文件结构非法' };
    }

    let loaded = 0;
    for (const [key, val] of Object.entries(raw.conversations)) {
      if (!CONV_KEY_RE.test(key)) continue;
      if (!val || typeof val !== 'object') continue;

      const c = emptyConv(key);
      c.lastFloor = toCount(val.lastFloor);
      c.readThroughFloor = Math.min(toCount(val.readThroughFloor), c.lastFloor);
      c.evictedThrough = Math.min(toCount(val.evictedThrough), c.lastFloor);
      c.createdAt = toCount(val.createdAt);
      c.updatedAt = toCount(val.updatedAt);

      const msgs = Array.isArray(val.messages) ? val.messages : [];
      c.messages = msgs
        .filter((m) => m && isFloorNumber(m.floor) && m.floor <= c.lastFloor)
        .map((m) => ({
          floor: m.floor,
          messageId: m.messageId ?? null,
          userId: String(m.userId ?? ''),
          nickname: String(m.nickname ?? ''),
          text: String(m.text ?? ''),
          atSelf: m.atSelf === true,
          replyTo: m.replyTo ?? null,
          isGroup: m.isGroup === true,
          time: toCount(m.time),
          receivedAt: toCount(m.receivedAt),
        }))
        .sort((a, b) => a.floor - b.floor);

      // 只保留仍然存在的楼层，避免脏数据把读楼层算歪
      const existing = new Set(c.messages.map((m) => m.floor));
      const seen = Array.isArray(val.modelSeenFloors) ? val.modelSeenFloors : [];
      c.modelSeenFloors = new Set(seen.filter((f) => isFloorNumber(f) && existing.has(f)));

      /*
       * 恢复按日统计。
       *
       * 兼容老文件（没有这个字段）：从现存消息里重建一份。
       * 重建只能覆盖最近 200 条对应的那些天，比完全没有好，
       * 但比落盘过的那份少 —— 所以落盘时必须写它，见 #serialize。
       */
      if (val.activityByDate && typeof val.activityByDate === 'object') {
        for (const [day, n] of Object.entries(val.activityByDate)) {
          if (DAY_KEY_RE.test(day) && isFloorNumber(n) && n > 0) c.activityByDate[day] = n;
        }
      } else {
        for (const m of c.messages) {
          const day = localDayKey(m.receivedAt || m.time * 1000);
          if (day) c.activityByDate[day] = (c.activityByDate[day] ?? 0) + 1;
        }
      }

      this.#convs.set(key, c);
      loaded += 1;
    }

    this.#dirty = false;
    return { ok: true, loaded, recovered: false };
  }

  /**
   * 把坏文件改名留证，不删。
   *
   * 不删的原因：里面可能有用户唯一的会话历史，哪怕结构坏了，
   * 也许还能手工捞出来一部分。悄悄删掉是不可接受的。
   *
   * @param {string} reason
   */
  async #quarantine(reason) {
    try {
      await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
      await fs.rename(this.#filePath, `${this.#filePath}.corrupt`);
    } catch {
      /* 留证失败也不能拦住启动 */
    }
  }

  /** 退出时兜底：取消防抖定时器并立即写一次 */
  async close() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.flush();
  }
}

/* ------------------------------------------------------------------ 工具 */

/**
 * 本地时区的日期键 `YYYY-MM-DD`。
 *
 * 刻意不用 `toISOString()`：那是 UTC。UTC+8 的凌晨会被算成前一天，
 * 于是"昨天的日记"会在早上八点之前被当成今天，或者反过来漏掉一整天。
 *
 * @param {number} ms
 * @returns {string} 非法时间戳返回空串（调用方据此跳过记账）
 */
function localDayKey(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 楼层号必须是正的安全整数（0 只用于"还没有楼"的哨兵值）。
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isFloorNumber(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function toCount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/**
 * 归一化分页 limit：默认 50，上限 200。非法值返回 null（由调用方报错）。
 *
 * @param {unknown} v
 * @returns {number | null}
 */
function normalizeLimit(v) {
  if (v === undefined || v === null) return 50;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return Math.min(200, n);
}
