/**
 * 冷却表与全局限频器 —— 纯内存、无 IO、无宿主依赖
 *
 * ## 职责
 *
 * 两个东西，都只做「现在还能不能发」这一件事：
 *
 *   CooldownTable  规则级冷却：同一条规则 + 同一个会话，刚回过就别再回
 *   RateLimiter    全局限频：所有规则、所有会话合计，每分钟/每小时的上限
 *
 * ## 为什么要从 index.mjs 里拆出来
 *
 * 这两块的正确性全是边界情况：时钟的回拨与前进、过期项的清理、
 * 上限恰好用满那一条算不算。放在入口文件里就只能靠"跑起来看看"，
 * 拆成独立模块后可以注入 `now()` 把时间拨来拨去地穷举。
 *
 * ## 为什么不直接复用宿主的 RateLimiter（src/guard/send-gate.mjs）
 *
 * 插件不能 import 宿主模块 —— 插件包要能被单独拷走、单独测，也不能
 * 因为宿主内部重构而跟着碎。所以这里**独立实现**，形状刻意与宿主那道
 * 闸门接近（同样的滑动窗口、同样的 E2030 错误码口径），让读代码的人
 * 一眼能对上，但两边没有代码依赖。
 *
 * 两者是**串联**关系而不是替代：本模块拦的是"插件自己要少说几句"，
 * 宿主闸门拦的是"这条消息到底允不允许出站"。插件的限频再松，
 * 也绕不过宿主那道闸门。
 */

/** 冷却表的容量软上限：超过它时清掉已过期项，防止长跑之后无限增长。 */
const DEFAULT_MAX_COOLDOWN_ENTRIES = 2000;

/** 一分钟、一小时的毫秒数。写成语义常量，避免 60000 与 3600000 混用。 */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * 一条限频拒绝结果的固定形状。
 *
 * 与宿主 send-gate 的 `E2030` 对齐：这样插件日志与宿主审计流水里
 * 看到的是同一个码，排查时不用在两套编号之间翻译。
 *
 * @param {string} message
 * @returns {{ok: false, code: 'E2030', message: string}}
 */
function denied(message) {
  return { ok: false, code: 'E2030', message };
}

/**
 * 规则级冷却表。
 *
 * ## 语义是「发成功了才占位」（check / take 两步）
 *
 * `check()` 只回答"现在能不能回"，`take()` 才写入时间戳，且由调用方在
 * **发送成功之后**调用。这样"刚回过，所以冷却"这句话任何时候都成立；
 * 反过来（检查时就占位）会让一次发送失败白吃整个冷却期 ——
 * 用户看到"刚才没回，现在也不回"，而这从配置上完全推不出来。
 *
 * 代价是 check 与 take 之间有一次 `await sendText`，并发时两条消息可能
 * 都通过检查。冷却防的是"同一条规则每秒回十次"这个量级，
 * 偶尔多回一条是它承担得起的误差；而"失败也占位"会变成另一类
 * 无法解释的行为。取舍的理由与 `RateLimiter.check()` 相同。
 *
 * ## 冷却为 0 时一次都不记录
 *
 * `cooldownMs <= 0` 表示"这条规则不冷却"。此时 `check()` / `take()` 永远放行，
 * 也**不往表里写**任何东西：写进去会让表无谓地增长，而语义上
 * 冷却 0 的规则本来就没有"上次回过"这个概念。
 */
export class CooldownTable {
  /**
   * @param {{now?: () => number}} [opts]
   *   `now` 可注入，测试里把时钟往前拨就能验证"冷却到期"，
   *   不需要真的 sleep 几秒。
   */
  constructor(opts = {}) {
    /**
     * 注入的时钟。缺省用 `Date.now`。
     *
     * 函数形式而不是直接读 Date.now()：让"时间"成为这个类唯一的
     * 外部依赖，于是它变成了可穷举的纯状态机。
     *
     * @type {() => number}
     */
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    /**
     * key → 上次占用的时间戳（毫秒）。
     *
     * 只存时间戳不存"到期时刻"：冷却时长是按调用传入的（同一条规则
     * 的 cooldownMs 理论上可能在两次调用之间被配置改掉），
     * 存到期时刻的话，改配置后旧条目会带着旧时长继续生效。
     *
     * @type {Map<string, number>}
     */
    this.lastAt = new Map();
  }

  /**
   * 占用一次冷却位置（**发送成功后**调用）。
   *
   * 仍然自带一道检查：调用方理论上可能跳过 `check()` 直接 `take()`，
   * 而这里若不加判断就会无条件写时间戳，"冷却已到期"的状态会被硬刷回去。
   * 未到期时返回失败且**不刷新**时间戳 —— 刷新会把"限速"变成"永久封禁"。
   *
   * @param {string} key 一般是 `${ruleId}@${convKey}`
   * @param {number} cooldownMs 冷却时长；<= 0 表示不冷却
   * @returns {{ok: true} | {ok: false, retryAfterMs: number}}
   *   `retryAfterMs` 只用于日志与调试，调用方不该拿它做定时重排 ——
   *   那会让一条本该交给 AI 的消息被插件偷偷延迟处理。
   */
  take(key, cooldownMs) {
    const id = String(key ?? '');
    const ms = Number(cooldownMs);

    // 冷却时长非法或为 0：永远放行，且不留痕。
    // 非法值按"不冷却"处理，是因为规则的 cooldownMs 已经过 parseRules 校验，
    // 能走到这里的非法值只可能是调用方笔误，不该因此把消息吞掉。
    if (!Number.isFinite(ms) || ms <= 0) return { ok: true };

    const at = this.now();
    const last = this.lastAt.get(id);
    if (typeof last === 'number') {
      const left = ms - (at - last);
      if (left > 0) return { ok: false, retryAfterMs: Math.ceil(left) };
    }

    this.lastAt.set(id, at);
    return { ok: true };
  }

  /**
   * **只问不占**：这条规则这个会话现在能不能回。
   *
   * ## 为什么冷却要在发送成功之后才占位
   *
   * 与 `RateLimiter.check()` 是同一个理由：一次发送失败（闸门拒绝、QQ 掉线）
   * 什么都没发出去，如果它占掉了冷却位，接下来整个冷却期这条规则都不会
   * 再回 —— 用户看到的是"刚才明明没回，现在也不回"，而日志里唯一的线索
   * 是一句"冷却中"。把占位挪到成功之后，语义就变成"刚回过，所以冷却"，
   * 任何时候都能从配置推出来。
   *
   * ## 代价
   *
   * `check()` 与 `take()` 之间隔着一次 `await sendText`，并发时可能两条
   * 都通过检查。对冷却来说这最多是"紧挨着回了两条"，而冷却本来防的是
   * "同一条规则每秒回十次"这种量级 —— 不是精确到毫秒的锁。
   *
   * @param {string} key 一般是 `${ruleId}@${convKey}`
   * @param {number} cooldownMs 冷却时长；<= 0 表示不冷却
   * @returns {{ok: true} | {ok: false, retryAfterMs: number}}
   */
  check(key, cooldownMs) {
    const id = String(key ?? '');
    const ms = Number(cooldownMs);
    if (!Number.isFinite(ms) || ms <= 0) return { ok: true };

    const last = this.lastAt.get(id);
    if (typeof last !== 'number') return { ok: true };

    const left = ms - (this.now() - last);
    if (left > 0) return { ok: false, retryAfterMs: Math.ceil(left) };
    return { ok: true };
  }

  /**
   * 只查不占：还剩多少毫秒。
   *
   * 给日志与 `testConnection` 用。刻意与 `take()` 分开：查询不该改变状态。
   *
   * @param {string} key
   * @param {number} [cooldownMs] 不传时只回答"有没有记录"，返回 0 或 1
   * @returns {number} 剩余毫秒；没有记录或已到期返回 0
   */
  peek(key, cooldownMs) {
    const id = String(key ?? '');
    const last = this.lastAt.get(id);
    if (typeof last !== 'number') return 0;

    const ms = Number(cooldownMs);
    // 没给冷却时长：无从算出"还剩多久"，只回答"还记着这个 key"。
    // 用 1 而不是 Infinity，避免调用方把它当成"永久冷却"去展示。
    if (!Number.isFinite(ms) || ms <= 0) return 1;

    const left = ms - (this.now() - last);
    return left > 0 ? Math.ceil(left) : 0;
  }

  /** 清空整张表（停用/重载时用）。 */
  clear() {
    this.lastAt.clear();
  }

  /** 当前记录条数（测试与日志用）。 */
  get size() {
    return this.lastAt.size;
  }

  /**
   * 收拾已经过期的条目。
   *
   * ## 为什么需要它
   *
   * 规则 × 会话 是一个乘法空间：64 条规则铺到几百个群里就能累积出
   * 上万条记录，而其中绝大多数早就过期、永远不会再被读到。没有这一步，
   * 一个长期运行的后端会缓慢地漏内存 —— 症状是"跑了两个星期之后内存
   * 曲线一直往上"，且没有任何错误日志。
   *
   * ## 为什么只在超过阈值时才扫
   *
   * 每次 take 都全表扫一遍是 O(n) 挂在热路径上。改成"到阈值才扫"，
   * 代价摊到足够多的调用上，而表的大小被钉在阈值附近。
   *
   * 判断"过期"要用到冷却时长，而表里只存了时间戳。所以这里用一个
   * **保守上限**：比最大冷却时长还老的记录一定过期（`LIMITS.maxCooldownMs`
   * 是 1 天）。超过 1 天没被碰过的记录直接删掉，不会误删还有效的。
   *
   * @param {number} [maxEntries] 超过这个条数才扫
   * @param {number} [maxCooldownMs] 最长的冷却时长（判"一定过期"用）
   * @returns {number} 实际删掉几条
   */
  sweep(maxEntries = DEFAULT_MAX_COOLDOWN_ENTRIES, maxCooldownMs = 86_400_000) {
    if (this.lastAt.size <= maxEntries) return 0;

    const now = this.now();
    const horizon = Number.isFinite(maxCooldownMs) && maxCooldownMs > 0 ? maxCooldownMs : 86_400_000;
    let removed = 0;
    for (const [key, at] of this.lastAt) {
      // 注意用 horizon 而不是调用方某条规则的 cooldownMs：
      // 表里混着不同冷却时长的规则，逐条比对需要额外存时长，
      // 而"比我见过的任何冷却都老"这个判据已经足够安全。
      if (now - at >= horizon) {
        this.lastAt.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * 全局滑动窗口限频器：分钟/小时两档，两档都必须通过。
 *
 * ## 为什么是"全局"而不是"按会话"
 *
 * 宿主闸门里的 RateLimiter 是按 convKey 计数的（它管的是"别把某个群刷爆"）。
 * 这里的语义不同：正则插件最典型的翻车方式是「规则写得太宽，在 50 个群里
 * 同时命中」，每条消息单独看都只回了一句、每个群都远没到限制，合起来却是
 * 50 条。所以这一层按**总量**计，专门兜住这种横向放大。
 *
 * 虽然接口保留了 key，但插件侧固定传一个常量 key —— 保留参数是为了
 * 将来真要细分成"每会话一档"时不用改签名与全部调用点。
 *
 * ## 重启清零是可接受的
 *
 * 和宿主那道闸门一样，这里只在内存里记。进程重启后计数归零意味着
 * 短期内可能多发几条 —— 相比"为了持久化而引入一次磁盘写"，
 * 后者在每条消息的热路径上代价更高，而它防的只是重启瞬间的重复。
 */
export class RateLimiter {
  /**
   * @param {{maxPerMinute?: number, maxPerHour?: number, now?: () => number}} opts
   *   上限被夹到合法区间：配置层已经校验过，这里兜底的原因是
   *   "限频值被手改成 0 或负数"时，`>= 0` 会让**每一条**都被拒绝，
   *   表现为插件彻底不说话 —— 那比回退到默认值糟糕得多。
   */
  constructor(opts = {}) {
    this.maxPerMinute = normalizeLimit(opts.maxPerMinute, 1, 60, 6);
    this.maxPerHour = normalizeLimit(opts.maxPerHour, 1, 600, 60);
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    /**
     * key → 时间戳数组（只保留最近一小时）。
     *
     * 存时间戳数组而不是几个计数器，是为了滑动窗口：固定窗口会在
     * 边界处放过两倍的量（59 秒发满、60 秒又发满），而刷屏恰好
     * 就发生在那种时刻。
     *
     * @type {Map<string, number[]>}
     */
    this.hits = new Map();
  }

  /**
   * **只问不占**：现在还能不能发。
   *
   * ## 为什么配额要在发送成功之后才计入
   *
   * 配额回答的是"我已经发出去了几条"，而不是"我尝试过几条"。
   * 一次被闸门拒绝、或者 QQ 掉线导致失败的发送，等于**什么都没发出去**，
   * 把它计入配额会让可用额度凭空消失：用户遇到一次网络抖动，
   * 接下来一分钟的自动回复就全被自己限没了 —— 症状是
   * "什么都没有发出去，却提示发送过快"，几乎无法排查。
   *
   * 所以 `check()` 与 `take()` 拆成两步：
   *
   * ```
   * const r = limiter.check();   // 还能发吗？不占额度
   * if (!r.ok) return false;     // 额满 → 这条消息交给 AI（不静默丢弃）
   * const sent = await sendText(...);
   * if (sent.ok) limiter.take(); // 只有真的发出去了才计一次
   * ```
   *
   * ## 代价：并发窗口里可能多发一条
   *
   * `check()` 与 `take()` 之间隔着一次 `await sendText`。这期间另一条
   * 消息可能也通过了 `check()`，于是两条都发。上限原本是 6 条/分钟，
   * 最坏变成 7 条。
   *
   * 这个代价是**有意接受**的，因为两种错不对称：多发一条只是少说半句话；
   * 而为了消灭这个窗口改成"发送前就占位"，就会引入上面那个
   * "失败白吃额度"的、更难解释的错。
   *
   * @param {string} [key] 计数分组；插件侧固定传常量
   * @returns {{ok: true} | {ok: false, code: 'E2030', message: string}}
   */
  check(key = 'global') {
    const group = String(key ?? 'global');
    const at = this.now();

    // 只留一小时内的：分钟档是它的子集。
    const arr = (this.hits.get(group) ?? []).filter((t) => at - t < HOUR_MS);

    const perMinute = arr.filter((t) => at - t < MINUTE_MS).length;
    if (perMinute >= this.maxPerMinute) {
      return denied(`自动回复过快（每分钟上限 ${this.maxPerMinute} 条）`);
    }
    if (arr.length >= this.maxPerHour) {
      return denied(`自动回复过快（每小时上限 ${this.maxPerHour} 条）`);
    }
    return { ok: true };
  }

  /**
   * 占用一次发送配额（**发送成功后**调用）。
   *
   * 仍然自带一道检查：调用方理论上可能跳过 `check()` 直接 `take()`，
   * 而这里若不加判断就会无条件塞时间戳，"已满"的状态就永远修不回来。
   * 返回失败不改变已有计数。
   *
   * @param {string} [key] 计数分组；插件侧固定传常量
   * @returns {{ok: true} | {ok: false, code: 'E2030', message: string}}
   */
  take(key = 'global') {
    const group = String(key ?? 'global');
    const at = this.now();

    const arr = (this.hits.get(group) ?? []).filter((t) => at - t < HOUR_MS);
    const perMinute = arr.filter((t) => at - t < MINUTE_MS).length;
    // 先判再记，顺序不能反：反过来的话被拒的那次也会留在数组里，
    // 让"满了之后还要再等一小时"——那是把节流变成了惩罚。
    if (perMinute >= this.maxPerMinute) {
      this.hits.set(group, arr);
      return denied(`自动回复过快（每分钟上限 ${this.maxPerMinute} 条）`);
    }
    if (arr.length >= this.maxPerHour) {
      this.hits.set(group, arr);
      return denied(`自动回复过快（每小时上限 ${this.maxPerHour} 条）`);
    }

    arr.push(at);
    this.hits.set(group, arr);
    return { ok: true };
  }

  /**
   * 剩余配额（日志与自检用，不改变状态）。
   *
   * @param {string} [key]
   * @returns {{perMinuteLeft: number, perHourLeft: number}}
   */
  remaining(key = 'global') {
    const group = String(key ?? 'global');
    const at = this.now();
    const arr = (this.hits.get(group) ?? []).filter((t) => at - t < HOUR_MS);
    const perMinute = arr.filter((t) => at - t < MINUTE_MS).length;
    return {
      perMinuteLeft: Math.max(0, this.maxPerMinute - perMinute),
      perHourLeft: Math.max(0, this.maxPerHour - arr.length),
    };
  }

  /** 清空计数（停用/重载时用）。 */
  clear() {
    this.hits.clear();
  }
}

/**
 * 把上限夹进合法区间。
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function normalizeLimit(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // 上限必须是正整数：1.5 条/分钟没有意义，向下取整到 1 反而更安全。
  const i = Math.floor(n);
  if (i < min || i > max) return fallback;
  return i;
}
