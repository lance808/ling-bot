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
/**
 * 每个会话最多记多少个「这些楼层的图片已经提交过」的楼层号。
 *
 * 为什么需要这个集合：历史图片一旦提交过就不能再提交，
 * 否则每一回合都把同样的几张图重新塞进上下文 —— token 账单会翻倍，
 * 而且模型会以为自己反复看到同一张图。楼层号淘汰后就无从判断，
 * 所以必须持久化。
 *
 * 上限与 MAX_SEEN_FLOORS 取同一个量级：它们的量级都由"缓冲 200 条"决定，
 * 500 只是留出跨淘汰的余量，不是使用需要。
 */
export const MAX_IMAGES_SEEN_FLOORS = 500;
/** 落盘防抖：一回合可能连写很多条，没必要每条都碰磁盘 */
const FLUSH_DEBOUNCE_MS = 400;
/** 会话总数上限：防止被大量临时群/私聊撑爆内存与磁盘 */
export const MAX_CONVERSATIONS = 500;

/**
 * 媒体元数据允许持久化的键，**只有这六个**。
 *
 * ## 为什么是白名单而不是"把不需要的删掉"
 *
 * 上游的图片段里带 `url`，而 QQ 的图片 URL 是**临时鉴权链接**：
 * 它能把图片直接拉下来，等于把用户聊天里的图片长期暴露在 sessions.json
 * 这个明文文件里。base64 更直接 —— 一条 4MB 的图会让会话文件涨到不可用
 * 的大小，而且每次落盘都要重写一遍全量 JSON。
 *
 * 所以这里是"只留已知的几个标量键"，其余一概丢弃。将来要给 MediaRef 加
 * 字段（比如 sha1）时，必须同时改这张表和 docs/vision-contract.md §2 —— 
 * 这样"不小心把 url 写进去"不可能悄悄发生。
 */
export const MEDIA_PERSIST_KEYS = Object.freeze(['kind', 'file', 'mime', 'bytes', 'width', 'height', 'name']);

/** 会话键形状，与 onebot/events.mjs 的约定一致 */
const CONV_KEY_RE = /^(group|private):\d+$/;

/** 本地日期键形状：只接受两位补零，避免同一日期有两种写法 */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 安全缓存名的形状，与 docs/vision-contract.md §2 的 `isProbablySafeCacheName`
 * 完全一致（无路径、无协议、无 `..`）。
 *
 * ## 为什么持久层还要自己判一次，而不是信任上游
 *
 * `file` 是重启后唯一还能用的取图依据。如果它其实是
 * `https://multimedia.nt.qq.com.cn/...?rkey=SECRET`（上游把 URL 塞进了 file
 * 字段，或者旧代码/别处手滑写进来的），那我们"只留六个键"就白留了 ——
 * 鉴权 URL 换了个键名照样落盘，sessions.json 里照样有长期有效的取图链接。
 *
 * 键名白名单管不住**值**，所以这里按内容再筛一道：不像缓存名的就给空串。
 * 空字符串等价于"重启后取不到这张图"，那是可以接受的降级（契约 §5：
 * URL 丢失是预期行为）。
 *
 * 规则与 `src/llm/media-refs.mjs` 的 `isProbablySafeCacheName` **同口径**，
 * 但**故意不 import 它**：持久层与视觉核心是两个并行开发的模块，
 * 让会话仓库依赖取图模块会把"取图逻辑改动"变成"会话文件格式风险"。
 * 改这条规则时，两边要一起改（契约 §2 是唯一来源）。
 */
const SAFE_CACHE_NAME_RE = /^[\w.+=@-]{1,512}$/;

/**
 * @param {unknown} v
 * @returns {string} 安全缓存名；不像缓存名（URL / data: / 路径 / 内联 base64）时给空串
 */
function toCacheName(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!SAFE_CACHE_NAME_RE.test(s)) return '';
  /*
   * 再挡 `..`：字符集规则放过了点号（真实缓存名里常有扩展名），
   * 但 `..` 单独一条就是路径穿越记号。char 集已禁掉 `/` 与 `\`，
   * 所以 `..` 本身不能真的走出目录，但留着它没有任何取图价值，
   * 只会让"这个 file 字段到底安不安全"多一种需要解释的情况。
   */
  if (s.includes('..')) return '';
  return s;
}

/**
 * 把任意形状的媒体元数据归一化成"只含六个键的干净对象"。
 *
 * 规则与 load() 对脏数据的口径一致（同一个函数两处复用，避免"写入时宽松、
 * 读回时严格"这种不对称 —— 那种不对称会让一条脏数据在内存里正常、
 * 重启后突然消失，排查起来毫无头绪）：
 *
 *   · 非对象 / 数组 → null（调用方丢弃，不抛）
 *   · kind 必须是 'image'（本轮视觉链路只处理图片，见 §2）
 *   · `file` 必须像安全缓存名，否则清空（见 SAFE_CACHE_NAME_RE）
 *   · 字符串键截到合理长度，数值键必须是有限的非负数
 *   · **任何未列出的键都不带过去**，尤其是 url 与 base64
 *
 * 不在这里判断"这张图重启后还能不能取到"：那是 vision.mjs 的事。
 * 持久层只保证"存进来的是元数据，不是凭据"。
 *
 * @param {unknown} raw
 * @returns {{kind: string, file: string, mime: string, bytes: number, width: number, height: number, name: string} | null}
 */
function normalizeMediaItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = /** @type {any} */ (raw);
  if (src.kind !== 'image') return null;

  return {
    kind: 'image',
    file: toCacheName(src.file),
    mime: toShortString(src.mime),
    bytes: toCount(src.bytes),
    width: toCount(src.width),
    height: toCount(src.height),
    name: toShortString(src.name),
  };
}

/**
 * 归一化 evt.media：非数组 → 空数组，脏项丢弃，其余逐项收敛到六个键。
 *
 * 返回空数组而不是 undefined，是为了让"存过图"和"没存过图"在落盘时
 * 有稳定形状：老消息对象里根本没有 media 字段（保持逐字段兼容），
 * 新消息哪怕一张图都没有也带 `media: []` —— 这样读代码的人不用猜
 * "没有 media 字段"到底是老数据还是新逻辑漏写。
 *
 * 注意**不因为 `file` 为空就丢弃这一项**：图片确实出现在那条消息里，
 * 只是重启后取不到字节（契约 §5 说这是预期行为）。丢掉这项会让历史
 * 记录变成"这条消息没有图片"，那是**不实**的展示；留着它，上层看到的是
 * "有图、但重启后取不到"，可以如实降级。
 *
 * @param {unknown} list
 * @returns {Array<object>}
 */
export function normalizeMediaList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const item = normalizeMediaItem(raw);
    if (item) out.push(item);
  }
  return out;
}

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
    /**
     * 已经**提交过图片**的楼层（有界）。
     *
     * 与 modelSeenFloors 是两件事，绝不能合流：
     *   · modelSeenFloors = "这条消息的文本进过模型"，它推进 readThroughFloor
     *   · imagesSeenFloors = "这条消息的图片进过模型"，只用于去重
     *
     * 合流的后果是读楼层语义被悄悄改掉：一条消息的文本还没喂过、
     * 但它的图已经被别的回合提交过（历史回看），那时读楼层就会提前跨过去，
     * 这条消息的文本永远不会被处理 —— 而且是静默的。
     */
    imagesSeenFloors: new Set(),
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
      /*
       * 返回副本：调用方改到消息对象不该反过来污染仓库。
       *
       * media 必须**深一层**复制：`{...m}` 只复制了数组引用，
       * 调用方一个 `m.media[0].file = 'x'` 就能改到仓库里的持久数据，
       * 而这种改动既不标脏也没有日志 —— 落盘时写下去的是被改坏的值。
       */
      messages: slice.map(copyMessage),
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
    return c.messages.filter((m) => m.floor > after).slice(0, limit).map(copyMessage);
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
   * `evt.media`（可选数组）会被持久化，但只保留六个元数据键，见
   * `MEDIA_PERSIST_KEYS`。它**不参与**任何读楼层计算：媒体是展示信息，
   * 不是"这条消息处理到哪了"的记号。
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
    const media = normalizeMediaList(evt?.media);
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
    /*
     * 只有真的带图时才写 media 字段。
     *
     * 这样"老形状消息"（没有 media）继续存在，任何按 `m.media` 做可选读取
     * 的调用方（界面、插件、未来的视觉链路）都能用同一个判断处理两代数据，
     * 不必区分"这条是旧版本写的"还是"这条本来就没图"。
     */
    if (media.length > 0) message.media = media;

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
      /*
       * 图片已提交集合也必须跟着淘汰。
       *
       * 不修剪的话它会一直涨（每次淘汰只是从 Set 里少几项、又加几项），
       * 而且被淘汰的楼层已经不可能再取图，留着它们纯属噪音 ——
       * 更麻烦的是这些"幽灵楼层号"会在未来某次重新编号时撞上新的楼，
       * 于是新消息的图莫名其妙被当成"已提交"。
       */
      this.#pruneImagesSeen(c);
    }

    this.#touch();
    return { ok: true, floor, message: copyMessage(message) };
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
   * 给一条**已经入库**的消息补上媒体元数据。
   *
   * ## 为什么需要"补"这个动作，而不是全在 append 里做
   *
   * 入站事件进 `append()` 时，媒体段还在 `evt.segments` 里；但解析媒体
   * 需要 `media-refs.mjs`（视觉链路）。让会话仓库反过来 import 它，
   * 会把"存消息"这件事绑到取图链路上 —— 那两层本该互不知道对方。
   *
   * 所以宿主分两步：先 `append()` 拿楼层号，再 `attachMedia(floor, refs)`。
   * 仓库这一侧只做"把干净的六键对象挂到那栋楼上"，不认识 OneBot、
   * 也不认识 URL。
   *
   * ## 楼层不存在时静默返回 0
   *
   * 调用方拿到的是 `append()` 的返回，正常不会走到这里；真发生了
   * （例如并发淘汰把那条消息挤掉了）也没什么可做的 —— 一张图没有元数据
   * 只会降级成"取不到图"，不该让整条消息入队失败。
   *
   * @param {string} convKey
   * @param {number|null} floor
   * @param {unknown} refs MediaRef[] 或已归一化的六键对象数组
   * @returns {number} 实际挂上了几张
   */
  attachMedia(convKey, floor, refs) {
    const c = this.#conv(convKey, false);
    if (!c) return 0;
    if (!isFloorNumber(floor) || floor <= 0) return 0;

    const target = c.messages.find((m) => m.floor === floor);
    if (!target) return 0;

    const media = normalizeMediaList(refs);
    if (media.length === 0) return 0;

    /*
     * 合并而不是覆盖：同一条消息理论上只 attach 一次，但补发/重放
     * 可能让它来第二趟。按 file 去重，避免同一张图在历史里出现两次。
     */
    const existing = Array.isArray(target.media) ? target.media : [];
    const seen = new Set(existing.map((m) => `${m.file}|${m.name}`));
    let added = 0;
    for (const item of media) {
      const key = `${item.file}|${item.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      existing.push(item);
      added += 1;
    }
    if (added === 0) return 0;

    target.media = existing;
    c.updatedAt = this.#now();
    this.#touch();
    return added;
  }

  /**
   * 标记这些楼层的图片**已经提交过**，下一回合不再提交。
   *
   * ## 为什么与 markModelSeen 分开
   *
   * 这两个集合回答的是不同问题：
   *   · modelSeenFloors：这条消息的**文本**进过模型 → 推进 readThroughFloor
   *   · imagesSeenFloors：这条消息的**图片**进过模型 → 只用于去重
   *
   * 合成一个集合是最省事、也是最隐蔽的错误：历史回看时，一条更早的消息
   * 可能只被提交了图片、文本还没被当前回合喂过；这时读楼层会提前跨过它，
   * 那条消息的文本永远不会被处理，而且没有任何报错（readThroughFloor 的
   * 算法只看 modelSeenFloors 和 evictedThrough）。
   *
   * 与 markModelSeen 一样只接受**真实存在**的楼层：记一个被淘汰的楼层
   * 没有意义（那张图再也取不到），记一个未来楼层则会让下一回合误以为
   * "已经提交过"从而永远不提交。
   *
   * @param {string} convKey
   * @param {number[]} floors
   * @returns {number} 实际登记了几个
   */
  markImagesSeen(convKey, floors) {
    const c = this.#conv(convKey, false);
    if (!c) return 0;
    if (!Array.isArray(floors)) return 0;

    const existing = new Set(c.messages.map((m) => m.floor));
    let added = 0;
    for (const f of floors) {
      if (!isFloorNumber(f)) continue;
      if (!existing.has(f)) continue; // 不存在或已淘汰的楼：不记
      if (c.imagesSeenFloors.has(f)) continue;
      c.imagesSeenFloors.add(f);
      added += 1;
    }
    if (added > 0) {
      this.#pruneImagesSeen(c);
      c.updatedAt = this.#now();
      this.#touch();
    }
    return added;
  }

  /**
   * 取某个会话里"图片已经提交过"的楼层集合（副本）。
   *
   * 返回副本而不是活 Set：调用方（视觉链路）会拿它做 `Set.has` 判断，
   * 万一手滑改到它，就会让"已提交"状态凭空变化 —— 那种改动既不会落盘
   * 也不会有日志，下一回合行为和这一回合不一致，非常难查。
   *
   * @param {string} convKey
   * @returns {Set<number>}
   */
  imagesSeenFor(convKey) {
    const c = this.#conv(convKey, false);
    if (!c) return new Set();
    return new Set(c.imagesSeenFloors);
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

  /**
   * 修剪 imagesSeenFloors：只保留仍存在的楼层，并限制总量。
   *
   * 单独一个方法与 #pruneSeen 并列，而不是合并成"修剪所有 Set"：
   * 两者淘汰时的取舍语义不同 —— modelSeenFloors 丢旧号有 readThroughFloor
   * 的历史值兜底，而 imagesSeenFloors 丢旧号意味着**那张图可能被重新提交**。
   * 分开写，将来想把淘汰策略改成"保留最近的"时不会误伤读楼层算法。
   *
   * @param {object} c
   */
  #pruneImagesSeen(c) {
    const existing = new Set(c.messages.map((m) => m.floor));
    for (const f of c.imagesSeenFloors) {
      if (!existing.has(f)) c.imagesSeenFloors.delete(f);
    }
    if (c.imagesSeenFloors.size <= MAX_IMAGES_SEEN_FLOORS) return;
    // 超限时保留较大的楼层号（较新的）：旧图重新提交的代价比新图漏提交小
    const sorted = [...c.imagesSeenFloors].sort((a, b) => a - b);
    for (const f of sorted.slice(0, sorted.length - MAX_IMAGES_SEEN_FLOORS)) c.imagesSeenFloors.delete(f);
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
        /*
         * 图片已提交楼层必须落盘：它是"同一张图只提交一次"的唯一依据。
         * 只放内存的话，重启后历史图片会被重新提交一遍 —— 用户看到的账单
         * 在重启后凭空翻倍，而且没有界面能解释为什么。
         */
        imagesSeenFloors: [...c.imagesSeenFloors],
        activityByDate: c.activityByDate,
        /*
         * 消息在这里**过一遍** media 白名单再写。
         *
         * 虽然 append 与 load 都已经归一化过，但消息对象是活的：插件、
         * 界面、未来的视觉链路都可能把 `url` 之类塞进 `m.media`。
         * 序列化是最后一道关，只在这里做能保证"写进文件的永远只有六个键"，
         * 不必依赖每个调用方都守规矩。
         */
        messages: c.messages.map(serializeMessage),
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
        .map(restoreMessage)
        .sort((a, b) => a.floor - b.floor);

      // 只保留仍然存在的楼层，避免脏数据把读楼层算歪
      const existing = new Set(c.messages.map((m) => m.floor));
      const seen = Array.isArray(val.modelSeenFloors) ? val.modelSeenFloors : [];
      c.modelSeenFloors = new Set(seen.filter((f) => isFloorNumber(f) && existing.has(f)));

      /*
       * 恢复「图片已提交」楼层。
       *
       * 老文件里没有这个字段（视觉链路是后加的），`Array.isArray` 为假，
       * 得到一个空 Set —— 语义上正好等于"这些楼都没提交过图"，也就是
       * 升级后第一回合会把历史图各提交一次。这是有意的：老版本从没提交过
       * 图片，把它们标成"已见"反而会让用户升级后"图片永远读不到"。
       *
       * 同样只保留仍然存在的楼层：被淘汰的楼已经不可能再取图，
       * 留着它们只会让集合无界增长。
       */
      const seenImages = Array.isArray(val.imagesSeenFloors) ? val.imagesSeenFloors : [];
      c.imagesSeenFloors = new Set(seenImages.filter((f) => isFloorNumber(f) && existing.has(f)));
      this.#pruneImagesSeen(c);

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
 * 返回给调用方的消息副本。
 *
 * 为什么要比 `{...m}` 多一层：media 是数组，浅拷贝只复制引用。
 * 调用方（界面、插件、视觉链路）改一下 `m.media[0]` 就改到了仓库里的
 * 持久数据，而仓库不会因此标脏 —— 下一次落盘写下去的是被改坏的值。
 * 这种污染没有任何报错，只会在某天变成"会话文件里的图片信息不对"。
 *
 * @param {object} m
 * @returns {object}
 */
function copyMessage(m) {
  const copy = { ...m };
  if (Array.isArray(m.media)) copy.media = m.media.map((item) => ({ ...item }));
  return copy;
}

/**
 * 字符串键的安全收敛：非字符串给空串，过长截断。
 *
 * 为什么截断：`name` / `file` / `mime` 都来自上游消息段。上游可能给一个
 * 几 KB 的"文件名"，原样写进 sessions.json 会让文件无端膨胀，而且这些值
 * 只用于展示与取图提示，不需要那么长。512 与 media-refs.mjs 的缓存名上限一致。
 *
 * @param {unknown} v
 * @returns {string}
 */
function toShortString(v) {
  return typeof v === 'string' ? v.slice(0, 512) : '';
}

/**
 * 落盘时的消息形状（**最后一道 media 白名单**）。
 *
 * 只输出已知字段，media 逐项过 normalizeMediaItem。
 * 这里刻意不用 `{...m}` 展开：展开会把任何后来被塞进消息对象的字段
 * （比如别处手滑挂上去的 `url`、`raw`、`segments`）一起写进磁盘。
 *
 * @param {object} m
 * @returns {object}
 */
function serializeMessage(m) {
  const out = {
    floor: m.floor,
    messageId: m.messageId ?? null,
    userId: m.userId,
    nickname: m.nickname,
    text: m.text,
    atSelf: m.atSelf === true,
    replyTo: m.replyTo ?? null,
    isGroup: m.isGroup === true,
    time: m.time,
    receivedAt: m.receivedAt,
  };
  const media = normalizeMediaList(m.media);
  // 与运行时的形状保持一致：没图就不带这个键，免得磁盘上的老消息多出 `media: []`
  if (media.length > 0) out.media = media;
  return out;
}

/**
 * 读回时的消息形状（与 serializeMessage 对称）。
 *
 * 老文件里没有 `media` 字段是**正常情况**（视觉链路是后加的），
 * 这里直接跳过，消息对象上就不会出现 media —— 与追加时的行为一致。
 *
 * @param {any} m
 * @returns {object}
 */
function restoreMessage(m) {
  const out = {
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
  };
  const media = normalizeMediaList(m.media);
  if (media.length > 0) out.media = media;
  return out;
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
