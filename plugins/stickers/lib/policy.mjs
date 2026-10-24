/**
 * 表情包插件的策略层 —— 配置归一化、频次闸门、视觉/人格三态、话术
 *
 * ## 为什么这些要单独一层
 *
 * 入口文件里剩下的应该只有"编排"：取身份 → 查库 → 调网关 → 写库 → 回话。
 * 而下面这三类东西**都不是一次动作**，它们各自有一套容易写错的边界：
 *
 *  1. **配置的数值范围。** 契约给了每个数字的上下限，但用户能直接改 config.json。
 *     手改坏之后（`collectPerHour: -1`、`maxImageBytes: 1e9`）不能表现为
 *     "插件突然坏了"，也不能表现为"突然允许做更多事"。归一化必须夹取，
 *     且**夹取规则只有一处** —— 分散在两个文件里迟早会分叉。
 *  2. **频次。** 滑动窗口的边界（第 N 次算不算、时钟回拨怎么办、窗口到期怎么清）
 *     全是可以在测试里穷举的东西，只要把 `now` 做成注入项。放进入口文件里就
 *     只能靠"跑起来看看"。
 *  3. **话术。** "视觉关闭时不能宣称看过图""动图只能说第一帧"是两条**诚实性**要求。
 *     它们不是格式化问题：一句写错的话，模型就会开始描述一张它没看到的图，
 *     或者根据一帧静止画面讲它怎么左右横跳。所以这些句子集中在这里，
 *     每句都写明它防的是哪种错误。
 *
 * ## 这一层不碰什么
 *
 * 不碰磁盘、不碰网关、不碰 ctx，也不打印日志。唯一的外部输入是注入的 `now`。
 */

// 只借一个"单行化 + 截断"：说明文案里会拼进库里的文本（备注/标签），
// 而它们可能带换行。那句话最终会进提示词，所以同一套净化规则，不另写一遍。
import { sanitizeText } from './model.mjs';

/* ============================================================ 配置归一化 */

/**
 * 配置默认值（契约 §6）。
 *
 * 全部开关默认 `true` 是安全的：插件本身默认不启用，工具在聊天来源里默认
 * 也不可见（`plugins.chatTools` 三档全关）。"启用插件"和"点名进群"是两次
 * 独立的管理员动作 —— 中间任何一次不做，这个插件都不会自己开口。
 */
export const DEFAULT_CONFIG = Object.freeze({
  listEnabled: true,
  imageEnabled: true,
  collectEnabled: true,
  sendEnabled: true,
  noteEnabled: true,
  maxListCount: 60,
  syncTtlMs: 60_000,
  maxImageBytes: 98_304,
  collectPerHour: 6,
  sendPerHour: 20,
  sendMinIntervalMs: 8_000,
  maxRemarkChars: 20,
  syncOnInit: true,
  fallbackToTagsWhenVisionOff: true,
  /**
   * `overridePersona` 不在契约 §6 的表里，但 `docs/stickers.md` §8.1 / §10 把它
   * 列成配置项，且它是**宿主**（`src/llm/prompt.mjs`）读的那个开关。
   * 插件这边声明它，只是为了让自动表单能把它渲染出来、能存下来；
   * 插件自己**不**用它做任何判断（人格文本不在 ctx 里）。
   * 这一点已在交付报告里作为接口歧义提出。
   */
  overridePersona: false,
});

/**
 * 每个数值配置的合法区间。区间直接抄契约 §6，不在用到的地方面前再夹一次。
 */
const RANGES = Object.freeze({
  maxListCount: [1, 200],
  syncTtlMs: [0, 3_600_000],
  maxImageBytes: [4_096, 131_072],
  collectPerHour: [0, 60],
  sendPerHour: [0, 120],
  sendMinIntervalMs: [0, 600_000],
  maxRemarkChars: [0, 50],
});

/**
 * 把一个值夹成区间内的整数。
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/**
 * 布尔值归一化。
 *
 * 只认真正的 `false` / `"false"` / `0`，其余一律走默认值。
 * 为什么不干脆 `Boolean(v)`：config 被手改成字符串 `"false"` 时，`Boolean("false")`
 * 是 `true` —— 用户关掉了开关，插件却在用。这是"看起来设置生效了"的经典形态。
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function toBool(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return fallback;
}

/**
 * 配置归一化：补齐默认值 + 夹取所有数值。
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  /** @type {any} */
  const out = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof DEFAULT_CONFIG[key] === 'boolean') out[key] = toBool(c[key], DEFAULT_CONFIG[key]);
  }
  for (const [key, range] of Object.entries(RANGES)) {
    out[key] = clampInt(c[key], range[0], range[1], DEFAULT_CONFIG[key]);
  }
  return /** @type {typeof DEFAULT_CONFIG} */ (out);
}

/* ================================================================ 频次闸门 */

const HOUR_MS = 3_600_000;

/**
 * 滑动窗口频次闸门（进程内存）。
 *
 * ## 为什么是 check / take 两步而不是一步"占用"
 *
 * 配额回答的是"我已经**做成**了几次"，不是"我尝试了几次"。
 * 一次被网关拒绝、被闸门拦下、或者用户自己取消的收藏，什么都没发生；
 * 如果它在检查时就把名额占掉，可用额度会凭空消失 —— 用户遇到一次网关抖动，
 * 接下来一小时的表情功能就全被自己限没了，而日志里只有一句"频次超限"。
 *
 * 所以调用方必须：`check()` → 真的做成 → `take()`。
 * 代价是并发窗口里可能多做一次（两次调用同时通过 check），
 * 而这个代价远小于"失败也扣额度"：前者最多多发一张表情，后者是功能突然不可用。
 *
 * ## 为什么重启清零是可接受的
 *
 * 这一层防的是"别刷屏"，不是"别把号发没"（后者是宿主的发送限流）。
 * 为了跨重启精确计数而引入一次磁盘写，等于把每次发送都绑上一次 fsync，
 * 换来的只是重启瞬间可能多一张 —— 不划算。
 *
 * ## 时钟回拨
 *
 * 机器调时间/从睡眠唤醒后 `Date.now()` 可能往回跳。若只按"比现在早一小时"过滤，
 * 回拨会让窗口里出现"未来"的时间戳并永久占住名额；若按"比现在晚"就丢弃，
 * 回拨一次就能把额度清零（用户在"刚刚明明没发"之后突然能连发）。
 * 这里的取舍是：**一小时以内的"未来"时间戳保留**（既不冻结也不清零），
 * 超过一小时的一律丢弃。两个方向都不会失控。
 */
export class StickerRateLimiter {
  /**
   * @param {{now?: () => number}} [opts] `now` 可注入，测试里不必真的等一小时
   */
  constructor(opts = {}) {
    /** @type {() => number} */
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {number[]} 收藏成功的时间戳 */
    this.collectHits = [];
    /** @type {number[]} 发送成功的时间戳 */
    this.sendHits = [];
    /** 上次发送成功的时间戳；0 = 从没发过 */
    this.lastSendAt = 0;
  }

  /**
   * 清掉窗口外的记录。
   *
   * @param {number} at
   * @returns {{collects: number[], sends: number[]}}
   */
  #window(at) {
    const keep = (arr) => arr.filter((t) => at - t < HOUR_MS && t - at < HOUR_MS);
    this.collectHits = keep(this.collectHits);
    this.sendHits = keep(this.sendHits);
    if (this.lastSendAt > 0 && at - this.lastSendAt >= HOUR_MS) this.lastSendAt = 0;
    return { collects: this.collectHits, sends: this.sendHits };
  }

  /**
   * 还能不能收藏。
   *
   * `perHour === 0` 返回 `E_STICKER_DISABLED` 而不是频次超限：配置写 0 的语义是
   * "关掉这件事"，而不是"你现在恰好用完了"。两句话对模型的意思完全不同 ——
   * 前者它该换个办法，后者它该等一会儿。
   *
   * @param {{perHour: number}} opts
   * @returns {{ok: true} | {ok: false, code: string, message: string, retryAfterMs?: number}}
   */
  checkCollect(opts) {
    const limit = clampInt(opts?.perHour, 0, 60, DEFAULT_CONFIG.collectPerHour);
    if (limit === 0) {
      return {
        ok: false,
        code: 'E_STICKER_DISABLED',
        message: '收藏功能已被管理员关闭（collectPerHour=0）。',
      };
    }
    const at = this.now();
    const { collects } = this.#window(at);
    if (collects.length >= limit) {
      const oldest = Math.min(...collects);
      const retryAfterMs = Math.max(0, HOUR_MS - (at - oldest));
      return {
        ok: false,
        code: 'E_STICKER_RATE_LIMITED',
        message: `一小时内已经收藏了 ${collects.length} 次（上限 ${limit} 次），${Math.ceil(retryAfterMs / 60_000)} 分钟后再试。这是防止刷收藏的插件层限频。`,
        retryAfterMs,
      };
    }
    return { ok: true };
  }

  /**
   * 还能不能发。
   *
   * 两道闸：每小时总量 + 两次之间的最小间隔。后者比前者更早触发 ——
   * 一小时 20 次是"别刷屏一整天"，8 秒间隔是"别连着三条都是表情"，
   * 而模型在连续接梗时最容易犯的恰好是后一种。
   *
   * @param {{perHour: number, minIntervalMs: number}} opts
   * @returns {{ok: true} | {ok: false, code: string, message: string, retryAfterMs?: number}}
   */
  checkSend(opts) {
    const limit = clampInt(opts?.perHour, 0, 120, DEFAULT_CONFIG.sendPerHour);
    const minInterval = clampInt(opts?.minIntervalMs, 0, 600_000, DEFAULT_CONFIG.sendMinIntervalMs);
    if (limit === 0) {
      return { ok: false, code: 'E_STICKER_DISABLED', message: '发送表情已被管理员关闭（sendPerHour=0）。' };
    }
    const at = this.now();
    const { sends } = this.#window(at);

    if (minInterval > 0 && this.lastSendAt > 0) {
      const left = minInterval - (at - this.lastSendAt);
      // left > 0 才算"还在间隔内"：时钟回拨导致的负数不该被当成"再等更久"
      if (left > 0) {
        return {
          ok: false,
          code: 'E_STICKER_RATE_LIMITED',
          message: `刚发过一张表情，两次之间至少要隔 ${Math.ceil(minInterval / 1000)} 秒，还要等 ${Math.ceil(left / 1000)} 秒。`,
          retryAfterMs: left,
        };
      }
    }
    if (sends.length >= limit) {
      const oldest = Math.min(...sends);
      const retryAfterMs = Math.max(0, HOUR_MS - (at - oldest));
      return {
        ok: false,
        code: 'E_STICKER_RATE_LIMITED',
        message: `一小时内已经发了 ${sends.length} 张表情（上限 ${limit} 张），${Math.ceil(retryAfterMs / 60_000)} 分钟后再试。`,
        retryAfterMs,
      };
    }
    return { ok: true };
  }

  /** 记一次**成功**的收藏。 */
  takeCollect() {
    this.collectHits.push(this.now());
  }

  /** 记一次**成功**的发送。 */
  takeSend() {
    const at = this.now();
    this.sendHits.push(at);
    this.lastSendAt = at;
  }

  /** 清空计数（停用 / 重载 / 测试用）。 */
  reset() {
    this.collectHits = [];
    this.sendHits = [];
    this.lastSendAt = 0;
  }

  /**
   * 当前用量快照（日志与自检用，不改变状态）。
   *
   * @param {{collectPerHour: number, sendPerHour: number}} cfg
   */
  snapshot(cfg) {
    const at = this.now();
    const { collects, sends } = this.#window(at);
    const left = (used, limit) => Math.max(0, clampInt(limit, 0, 1_000_000, 0) - used);
    return {
      collectsLastHour: collects.length,
      collectsLeft: left(collects.length, cfg?.collectPerHour),
      sendsLastHour: sends.length,
      sendsLeft: left(sends.length, cfg?.sendPerHour),
      lastSendAt: this.lastSendAt || null,
    };
  }
}

/* ======================================================== 视觉与动图的三态 */

/**
 * 视觉能力的归一化结果。
 *
 * ## 为什么"读不到"必须当成"关着"
 *
 * 宿主通过 `ctx.gateway.vision` 注入一次性的只读事实。插件看不到宿主的
 * `vision.enabled` 配置，所以这个字段一旦缺失（老版本宿主、单测环境、
 * 装配出错），**唯一安全的解释是"关着"**：
 *
 *   - 当成开着 → 插件会返回 dataUrl，而不带图的模型会开始**编造**画面
 *     （"图上是一只猫在笑"），这比"看不到图"糟得多；
 *   - 当成关着 → 大不了这次只按标签选，功能少一点，但话是诚实的。
 *
 * 这也是契约 §7 的口径：`vision.enabled !== true` 一律按关闭处理。
 *
 * @param {any} gateway 或直接传 `gateway.vision`
 * @returns {{enabled: boolean, supported: boolean | null, off: boolean, known: boolean}}
 */
export function resolveVisionState(gateway) {
  const v = gateway && typeof gateway === 'object' ? gateway.vision ?? null : null;
  /*
   * `known` 必须由**宿主显式给出**，不能靠"有这个对象"就推断出来。
   *
   * 宿主在没接线时给的是 `{enabled:false, supported:null, known:false}` ——
   * 形状齐全但内容是"不知道"。若这里把"形状像对象"当成"知道"，
   * 就会在明明开着视觉的机器上说"视觉识别已关闭"，那是一个具体的谎。
   */
  const known = v && typeof v === 'object' && v.known === true;
  const enabled = known && v.enabled === true;
  /** @type {boolean | null} */
  const supported = v && typeof v === 'object' && typeof v.supported === 'boolean' ? v.supported : null;
  return { enabled, supported, off: !enabled, known: Boolean(known) };
}

/**
 * 视觉关闭时的固定说明（契约 §7 要求文本里出现「视觉识别已关闭」）。
 *
 * 这句话必须与"我看到了"互斥。把它写成常量而不是各处拼接：
 * 一旦有人改了措辞忘了改另一处，审查时很难发现"某个分支又在假装看过图"。
 */
export const VISION_OFF_NOTICE =
  '视觉识别已关闭，这次是按已有标签选图的，我没有看这张图。';

/**
 * 视觉状态**未知**时的固定说明。
 *
 * 与 `VISION_OFF_NOTICE` 是两句不同的话，且**不能合并**：
 * `known:false` 表示宿主没给这个事实（没接线、配置校验调用、单测环境），
 * 此时视觉可能其实是开着的。说"已关闭"是一个具体的、指向错误方向的谎 ——
 * 用户会去检查明明没关的开关。所以这里只陈述"我按标签选的"这件事实，
 * 不对开关状态下任何断言。
 */
export const VISION_UNKNOWN_NOTICE =
  '当前无法确认读图是否可用，这次我只按已有标签选，没有把图片提交给你看。';

/**
 * 按视觉状态取对应的"我没看图"说明。
 *
 * 只在这两种情况下返回非空串：**视觉确实关着** 或 **宿主没给这个事实**。
 * 视觉开着时返回空串 —— 那种情况下图真的进了模型上下文，再多说一句
 * "我没看图"就是反向的谎。
 *
 * @param {{enabled: boolean, known: boolean}} vision
 * @returns {string}
 */
export function noVisionNotice(vision) {
  if (vision?.known === true && vision.enabled === true) return '';
  return vision?.known === true ? VISION_OFF_NOTICE : VISION_UNKNOWN_NOTICE;
}

/**
 * 动图说明（契约 §7 要求文本里出现「这是动图」与「第一帧」）。
 *
 * 为什么要把"别推断动作"也写进同一句：只说"这是动图"时，模型很容易理解成
 * "我看到的是动图的第一帧，所以我大概知道它怎么动"。真实情况是视觉服务通常
 * 只取首帧、甚至直接拒绝，模型看到的就是一张静止画面。
 */
export const ANIMATED_NOTICE =
  '这是动图，你看到的是静态的第一帧；不要根据这一帧推断它在完整播放时的动作（"会左右横跳"这类结论得不出）。';

/** 图片超出识别预算时的说明 */
export function tooLargeNotice(bytes, limit) {
  const kb = (n) => `${Math.round((Number(n) || 0) / 1024)}KB`;
  return `这张图有 ${kb(bytes)}，超过识别预算 ${kb(limit)}，只缓存了文件、没有提交给你看。`;
}

/**
 * 选图提示：不能看图时，怎么"按标签选"。
 *
 * 三种情况分开说，因为模型的下一步动作不同：
 *   · 有 localNote / tags → 让它照这些选，并明说没看过图；
 *   · 什么都没有 → 这就是 `E_STICKER_VISION_OFF`，不能凭空认图；
 *   · 配置禁止按标签兜底 → 直接告诉它这会儿选不了。
 *
 * ## 为什么"视觉关着"与"视觉状态未知"要分成两条说明
 *
 * 两者的**后续动作**完全不同：前者用户该去把视觉开关打开；后者是宿主没接线，
 * 用户去看开关只会看到一个本来是开的按钮。所以 `notice` 由调用方按
 * `resolveVisionState` 的结果传进来（`VISION_OFF_NOTICE` / `VISION_UNKNOWN_NOTICE`），
 * 而这个函数只负责"按标签怎么选"这一半。
 *
 * @param {any} entry 归一化后的条目
 * @param {{fallbackToTags?: boolean, notice?: string}} [opts]
 * @returns {{ok: true, text: string} | {ok: false, code: string, message: string}}
 */
export function visionOffSelection(entry, opts = {}) {
  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  const note = String(entry?.localNote ?? '');
  const desc = String(entry?.desc ?? '');
  const hasHints = tags.length > 0 || note.length > 0 || desc.length > 0;
  // 调用方没传就按"已关闭"说：那是保守的那一侧（说"不知道"更容易被当成能看图）
  const notice = sanitizeText(opts.notice, 200) || VISION_OFF_NOTICE;

  if (opts.fallbackToTags === false) {
    return {
      ok: false,
      code: 'E_STICKER_VISION_OFF',
      message: `${notice}当前配置又不允许按标签兜底（fallbackToTagsWhenVisionOff=false），所以这次选不了图。`,
    };
  }
  if (!hasHints) {
    return {
      ok: false,
      code: 'E_STICKER_VISION_OFF',
      message: `${notice}而这张表情还没有任何备注/标签，没法凭空猜它是什么。可以先用 sticker_note 记下它的含义（管理员私聊/桌面端）。`,
    };
  }
  const parts = [notice];
  if (desc) parts.push(`QQ 备注：「${desc}」。`);
  if (note) parts.push(`我记的含义：「${note}」。`);
  if (tags.length) parts.push(`标签：${tags.join('、')}。`);
  parts.push('上面这些是文字资料，不是这张图长什么样；要发送可以直接用 sticker_send。');
  return { ok: true, text: parts.join('') };
}

/**
 * 人格里关于表情的表态三态（契约 §8）。
 *
 * ## 为什么这里也会有这个函数
 *
 * 真正决定"表情工具对这个会话出不出现"的是**宿主**（`src/llm/prompt.mjs`）：
 * 插件在 `callTool` 里根本拿不到人格文本，拿不到就不该自己猜。
 * 那为什么还要在这里留一份判据？因为三态的定义必须**只有一个出处**：
 * 宿主判定与插件/文档的描述一旦分叉，症状是"文档说能用、工具就是不出现"，
 * 而这类 bug 的排查方向会全错。所以函数放在纯函数层、可被单测穷举，
 * 宿主与文档都引用同一套措辞。
 *
 * ## 为什么只有 forbid 重要
 *
 * 三态里 `unset` 与 `allow` 的行为**完全相同**（注入同一份"克制使用"策略），
 * 所以判定在它们之间犹豫不产生任何可观察差异。只有 `forbid` 会收窄工具面
 * （结构性动作），所以正则只要做到"绝不把明确的禁止读成 unset"即可：
 * 宁可漏判 allow，也不要漏判 forbid。
 *
 * @param {unknown} personaText
 * @returns {'forbid' | 'allow' | 'unset'}
 */
export function resolvePersonaStickerPolicy(personaText) {
  const text = String(personaText ?? '');
  if (!text) return 'unset';
  // 判据抄契约 §8：不(用|要|发|使?用)，中间允许几个修饰字（不用/不要/不发/不使用/别用）
  if (/不(用|要|发|使?用|许|准|能|得)[^。！？\n]{0,4}表情/.test(text)) return 'forbid';
  if (/别[^。！？\n]{0,4}表情/.test(text)) return 'forbid';
  // allow 用得少，判错也无害（与 unset 同行为）；只认非常明确的几种说法
  if (/(可以|能|多|尽情|适当|鼓励|欢迎|允许)[^。！？\n]{0,6}(用|发|发表情|表情包)/.test(text)) return 'allow';
  return 'unset';
}

/**
 * "可以用，但克制"的策略文本（契约 §8）。
 *
 * 宿主在 `unset` / `allow`（或 `overridePersona`）时注入它。写在这里的理由同上：
 * 措辞与三态判据同源。插件自己不注入提示词，这个函数供宿主与测试复用。
 *
 * @param {{enabled?: boolean, maxPerTurn?: number, overridePersona?: boolean}} [opts]
 * @returns {string}
 */
export function buildStickerGuidance(opts = {}) {
  if (opts.enabled === false) return '';
  const maxPerTurn = clampInt(opts.maxPerTurn, 1, 5, 1);
  const lines = [
    '【表情包】可以用，但克制：一轮最多 ' + maxPerTurn + ' 张，普通闲聊别每句都配图。',
  ];
  if (opts.overridePersona === true) {
    lines.push('（以下策略优先于人格里关于表情的那句话。）');
  }
  lines.push('选图优先用能准确对上语境的备注/标签；没把握就先看一眼再发。');
  lines.push('一张表情就是一个气泡，不能和文字挤在一起；要说话另外发一条。');
  lines.push('发出去之后不必再补一句"我发了个表情"，那等于把同一件事说了两遍。');
  return lines.join('\n');
}

/* ================================================================== 小工具 */

/**
 * 把 OneBot 消息 id 从模型给的字符串还原成可传给网关的值。
 *
 * 参数声明成 `string` 是刻意的：QQ 消息 id 可能是负数、也可能是超过 2^31 的整数，
 * 模型从上下文里抄过来的往往是一串数字字符。声明成 `number` 会让它偶尔
 * 传成字符串而整次调用失败（E4041），而失败一次就少一次机会。
 * 这里只在"整串都是数字"时才转成数字，其余原样透传 —— 网关两侧都接受字符串。
 *
 * @param {unknown} value
 * @returns {number | string}
 */
export function toMessageId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value ?? '').trim();
  if (!s) return '';
  // 只处理安全的整数范围，超出的保持字符串（JS 数字会丢精度）
  if (!/^-?\d{1,15}$/.test(s)) return s;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : s;
}
