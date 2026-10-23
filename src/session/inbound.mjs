/**
 * 入站消息的三道闸门 —— F3 / F7
 *
 * 一条消息从 OneBot 到达之后、「要不要为它起一个回合」之前，必须先过三关：
 *
 *   1. **是不是我们自己发的**（自消息）
 *   2. **是不是已经处理过的同一条**（重复投递）
 *   3. **该会话当前有没有回合在跑**（排队还是丢弃）
 *
 * ## 为什么这三件事要单独成一个模块
 *
 * 它们都是「有界状态 + 纯判定」，没有 IO、不碰网络、不碰配置。抽出来之后
 * 可以拿假事件单测，而 `index.mjs` 只负责接线。留在 `index.mjs` 里的坏处
 * 是这个文件已经两千多行，任何一条判定都只能靠跑真机器人来验证 ——
 * 而「回复混乱」这类问题恰恰是最难复现的。
 *
 * ## 这三关各自治什么病
 *
 * **自消息过滤**：自己发出去的话如果被上游当作普通 `message` 事件推回来，
 * 会原样进入 `recentByConv`，下一轮被渲染成「群友：<自己刚说的话>」。
 * 模型于是接自己的话、重复自己 —— 这是「回复混乱」最直接的来源。
 *
 * **重复投递去重**：断线重连、上游补发都会把同一条消息再推一次。
 * 没有去重就同一个问题跑两个回合，用户看到两条回复。
 *
 * **FIFO 排队**：以前是「每会话一个槽位」，第二强的触发直接覆盖第一个 ——
 * 连问两句只回最后一句，而且前一句永远不会再被回。这是个会静默丢消息的 bug，
 * 改成队列之后，回合结束按顺序消费，一条都不丢。
 */

/**
 * 这条消息是不是机器人自己发的？
 *
 * ## 为什么拿不到 selfId 时返回 false
 *
 * 保守方向是有意选的：如果 `selfId` 还没拿到（刚连上、lifecycle 还没来），
 * 返回 true 会把**所有消息**当成自己的而全部吞掉 —— 那是整个机器人失聪。
 * 返回 false 的代价只是"自消息暂时漏过去一条"，等 selfId 到位就恢复。
 *
 * 两种情况必须搞清楚哪个更坏，而不是"默认安全"就完了。
 *
 * @param {{sender?: {userId?: string}} | null | undefined} evt
 * @param {string} selfId
 * @returns {boolean}
 */
export function isSelfMessage(evt, selfId) {
  const self = String(selfId ?? '').trim();
  if (!self) return false;
  const from = String(evt?.sender?.userId ?? '').trim();
  if (!from) return false;
  return from === self;
}

/**
 * 判断"该不该在回复里点名某个发送者"之类的事情时用的字符串归一。
 *
 * 这里单独抽出来只是为了让 `index.mjs` 不必再散落一层 String() 包装，
 * 不承载业务判断。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeId(value) {
  return String(value ?? '').trim();
}

/** 去重键的分隔符：用不可见字符，避免 convKey 与 messageId 拼接歧义 */
const KEY_SEP = '\u0000';

/**
 * 已处理消息的环形去重表。
 *
 * ## 为什么不是无界的 Set
 *
 * 一个活跃群一天几千条消息，无界 Set 就是一条只涨不跌的内存曲线，
 * 而且是"看起来一切正常，跑够久就 OOM"的那种。所以有两条独立的上限：
 * `capacity`（条数）和 `ttlMs`（时间）——任一条先到就回收。
 *
 * ## 为什么两种上限都要
 *
 * 只按条数：半夜没人说话时表里会永久留着几百条早就不可能的重复投递。
 * 只按时间：有人刷屏时短时间内就能把内存撑起来。
 *
 * ## messageId 为空时为什么不去重
 *
 * 有些实现不返回 `message_id`。这时**宁可重复也不能丢** ——
 * 丢一条消息用户会以为机器人坏了，重复一条至少对话还能继续。
 *
 * @example
 * const dedup = new MessageDedup();
 * if (dedup.markSeen(evt.convKey, evt.messageId)) return; // 重复，丢弃
 */
export class MessageDedup {
  /** @type {Map<string, number>} 键 → 首次见到的时间戳（插入顺序即时间顺序） */
  #seen = new Map();
  /** @type {number} */
  #ttlMs;
  /** @type {number} */
  #capacity;
  /** @type {() => number} */
  #now;

  /**
   * @param {{ttlMs?: number, capacity?: number, now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    /*
     * 默认 10 分钟 / 500 条。
     *
     * 10 分钟的依据：一次断线重连的补发窗口通常在秒级，10 分钟已经宽松得
     * 离谱；再长只会占内存，不会多挡住什么。
     */
    this.#ttlMs = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : 600_000;
    this.#capacity = Number.isFinite(opts.capacity) ? Number(opts.capacity) : 500;
    this.#now = typeof opts.now === 'function' ? opts.now : Date.now;
  }

  /**
   * 检查并登记。**这个方法是"检查即登记"**：第一次返回 false 之后
   * 同一条再来就返回 true，调用方不需要自己再记一次。
   *
   * @param {string} convKey
   * @param {unknown} messageId
   * @returns {boolean} true = 重复，应当丢弃
   */
  markSeen(convKey, messageId) {
    const id = normalizeId(messageId);
    // 没有 messageId 就没法判断"同一条"，见文件头说明
    if (!id) return false;

    const now = this.#now();
    this.#sweep(now);

    const key = `${convKey}${KEY_SEP}${id}`;
    if (this.#seen.has(key)) return true;

    this.#seen.set(key, now);
    this.#trim();
    return false;
  }

  /**
   * 只查不记（给"要不要重复提示"这类读场景用）。
   *
   * @param {string} convKey
   * @param {unknown} messageId
   * @returns {boolean}
   */
  has(convKey, messageId) {
    const id = normalizeId(messageId);
    if (!id) return false;
    this.#sweep(this.#now());
    return this.#seen.has(`${convKey}${KEY_SEP}${id}`);
  }

  /** 当前登记了多少条（测试与诊断用） */
  get size() {
    return this.#seen.size;
  }

  /** 清空（会话删除、测试用） */
  clear() {
    this.#seen.clear();
  }

  /**
   * 从最早的一端丢掉过期项。
   *
   * 依赖 Map 的插入顺序，而同一个键只会插入一次，所以时间戳在迭代顺序上
   * 是单调不减的 —— 遇到第一条未过期的就可以停。
   *
   * @param {number} now
   */
  #sweep(now) {
    if (this.#ttlMs <= 0) return;
    for (const [key, at] of this.#seen) {
      if (now - at < this.#ttlMs) return;
      this.#seen.delete(key);
    }
  }

  /** 条数超上限时丢最早的 */
  #trim() {
    if (this.#capacity <= 0) return;
    while (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.keys().next();
      if (oldest.done) break;
      this.#seen.delete(oldest.value);
    }
  }
}

/**
 * 每会话一条 FIFO 的待处理回合队列。
 *
 * ## 为什么必须是队列而不是单槽
 *
 * 原来的实现是 `Map<string, job>` —— 一个会话只有一个槽位。
 * 回合还在跑的时候连续来两条 @，第二条直接 `set` 把第一条**覆盖**掉：
 * 第一条永远不会得到回复，而日志上看起来"排过队"。这类静默丢弃是最难查的，
 * 因为没有任何错误、没有异常，只是少了一条回复。
 *
 * ## 为什么还要有上限
 *
 * 变成队列之后，一个刷屏的群可以把队列堆到无限长，然后每一条都跑一次模型 ——
 * 这既烧钱又让回复严重滞后（用户三分钟后收到对早就不相关的话的回答）。
 * 所以超上限时**丢最旧的**：新消息更可能还是当前话题。
 *
 * 上限取得很小（默认 5）是产品判断：真到第 6 条还没轮到，说明这个群
 * 现在不是在一问一答，而是在刷屏，插入进去只会制造噪音。
 */
export class TurnQueue {
  /** @type {Map<string, object[]>} */
  #queues = new Map();
  /** @type {number} */
  #limit;

  /**
   * @param {{limit?: number}} [opts]
   */
  constructor(opts = {}) {
    this.#limit = Number.isFinite(opts.limit) && Number(opts.limit) > 0 ? Math.round(Number(opts.limit)) : 5;
  }

  /**
   * 入队。
   *
   * @param {string} convKey
   * @param {object} job
   * @returns {{accepted: boolean, dropped: object | null, length: number}}
   *   `dropped` 非空表示为了放下这一条而丢掉了哪一条（调用方负责记日志）
   */
  push(convKey, job) {
    const arr = this.#queues.get(convKey) ?? [];
    arr.push(job);

    let dropped = null;
    while (arr.length > this.#limit) dropped = arr.shift() ?? dropped;

    this.#queues.set(convKey, arr);
    return { accepted: true, dropped, length: arr.length };
  }

  /**
   * 取出最早的一条（回合结束后由调用方消费）。
   *
   * @param {string} convKey
   * @returns {object | null}
   */
  shift(convKey) {
    const arr = this.#queues.get(convKey);
    if (!arr || arr.length === 0) {
      this.#queues.delete(convKey);
      return null;
    }
    const next = arr.shift() ?? null;
    if (arr.length === 0) this.#queues.delete(convKey);
    return next;
  }

  /**
   * 队列长度。
   *
   * @param {string} convKey
   * @returns {number}
   */
  size(convKey) {
    return this.#queues.get(convKey)?.length ?? 0;
  }

  /** 所有会话的排队总数（快照里展示"积压了多少"） */
  get total() {
    let n = 0;
    for (const arr of this.#queues.values()) n += arr.length;
    return n;
  }

  /** 某个会话当前排队的触发类型（诊断用，不返回 job 本体避免泄漏上下文） */
  triggers(convKey) {
    return (this.#queues.get(convKey) ?? []).map((job) => job?.trigger ?? null);
  }

  clear(convKey) {
    if (convKey) this.#queues.delete(convKey);
    else this.#queues.clear();
  }
}
