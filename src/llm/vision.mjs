/**
 * 视觉链路的编排层 —— 挑选、预算、取图、降级（契约 §4 / §5）
 *
 * ## 这一层真正的职责：**成本控制**
 *
 * 取图本身很便宜（就是一次 HTTP），贵的是把它塞进模型请求：每张图都按
 * token 计费，而群聊里"上一张图、这张图、引用那张图"叠起来能轻松到十几张。
 * 一旦每回合都把这些历史图重新提交一遍，成本是**每回合**都在付的，
 * 而模型得到的边际信息几乎为零 —— 它上一回合已经看过同一张图了。
 *
 * 所以本模块所有的复杂度都花在三件事上：
 *
 *   1. **只挑该挑的**：本期消息全试、引用其次、历史只取没提交过的楼层；
 *   2. **有硬预算**：张数、单张字节、总字节、像素、总时限，逐层夹紧；
 *   3. **不重复取**：内存缓存（convKey + messageId + index）+ 调用内去重。
 *
 * ## 为什么缓存只在内存里
 *
 * 图片字节一旦落盘就是几百 KB 到几 MB 的 base64 进了 `sessions.json`，
 * 而那个文件的读取路径是"每次启动全量解析"。缓存命中省下的那点网络时间，
 * 远不值得把启动变慢、把磁盘写满。所以缓存的语义是"这次进程活着的时候有效"，
 * 重启即空 —— 契约 §5 说的就是这个。
 *
 * ## 为什么所有输入都由宿主注入
 *
 * 这个模块不读 `config.json`、不建 OneBot 客户端、不碰全局定时器。
 * 它只看传进来的 `config` / `deps` / `now`。这换来的是：测试里可以
 * 完整地跑一遍预算与降级逻辑，一次网络请求都不发。
 */

import { extractImageRefs, mediaRefsFromStored } from './media-refs.mjs';
import { fetchImage } from './image-fetch.mjs';

/**
 * 硬上限。
 *
 * 配置可以比它小，但**不能比它大**：用户把 `maxImagesPerTurn` 填成 50
 * 时要被夹回 4，而不是真的往请求体里塞 50 张图。这不是不信任用户，
 * 是"填错一个数就烧掉一个月额度"这种代价不值得让配置去承担。
 *
 * @type {Readonly<{
 *   maxImagesPerTurn: number, maxHistoryImages: number, maxBytes: number,
 *   maxTotalBytes: number, maxPixels: number, timeoutMs: number,
 *   historyWindow: number, cacheTtlMs: number, cacheMaxEntries: number, cacheMaxBytes: number,
 * }>}
 */
export const VISION_LIMITS_HARD = Object.freeze({
  maxImagesPerTurn: 4, // 本期消息
  maxHistoryImages: 3, // 历史/引用
  maxBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPixels: 36_000_000,
  timeoutMs: 15_000,
  historyWindow: 8, // 只回看最近 N 楼
  cacheTtlMs: 5 * 60 * 1000,
  cacheMaxEntries: 32,
  cacheMaxBytes: 24 * 1024 * 1024,
});

/**
 * 契约 §9 给的默认值。
 *
 * 和硬上限分开写着，因为它们回答的是不同问题：
 * 硬上限是"最多能开多大"，默认值是"开箱给多少"。混在一起改一个就会动另一个。
 */
const VISION_DEFAULTS = Object.freeze({
  enabled: false,
  maxImagesPerTurn: 3,
  maxHistoryImages: 2,
  maxBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPixels: 36_000_000,
  timeoutMs: 8000,
  historyWindow: 6,
  includeQuoted: true,
  cacheTtlMs: 300_000,
});

/**
 * 把用户配置夹到硬上限内，返回**完整**的配置对象。
 *
 * 永不抛：调用方（宿主）在每个回合都会跑它，一个手改坏的
 * `maxBytes: "abc"` 不该让机器人停止回复。坏值一律退回默认值。
 *
 * @param {object} [raw]
 * @returns {typeof VISION_DEFAULTS}
 */
export function normalizeVisionConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    maxImagesPerTurn: clampInt(src.maxImagesPerTurn, VISION_DEFAULTS.maxImagesPerTurn, 0, VISION_LIMITS_HARD.maxImagesPerTurn),
    maxHistoryImages: clampInt(src.maxHistoryImages, VISION_DEFAULTS.maxHistoryImages, 0, VISION_LIMITS_HARD.maxHistoryImages),
    maxBytes: clampInt(src.maxBytes, VISION_DEFAULTS.maxBytes, 1, VISION_LIMITS_HARD.maxBytes),
    maxTotalBytes: clampInt(src.maxTotalBytes, VISION_DEFAULTS.maxTotalBytes, 1, VISION_LIMITS_HARD.maxTotalBytes),
    maxPixels: clampInt(src.maxPixels, VISION_DEFAULTS.maxPixels, 1, VISION_LIMITS_HARD.maxPixels),
    // 契约 §9.1：配置层允许到 30000，运行时夹到 15000（单张图 15 秒回不来基本就是源不可达）
    timeoutMs: clampInt(src.timeoutMs, VISION_DEFAULTS.timeoutMs, 1000, VISION_LIMITS_HARD.timeoutMs),
    historyWindow: clampInt(src.historyWindow, VISION_DEFAULTS.historyWindow, 0, VISION_LIMITS_HARD.historyWindow),
    includeQuoted: src.includeQuoted !== false,
    /*
     * cacheTtlMs 与 timeoutMs 一样是"写入宽松、生效收紧"：
     * 配置层允许 60000–3600000（契约 §9.1），这里夹到 60 秒–5 分钟。
     *
     * 上限只取 5 分钟不是因为内存省不下，而是因为**图片 URL 会过期**：
     * 缓存只是省一次网络请求，拿一件可能已经被上游回收的字节去提交，
     * 换来的失败排查成本远高于省下的那点流量。
     */
    cacheTtlMs: clampInt(src.cacheTtlMs, VISION_DEFAULTS.cacheTtlMs, 60_000, VISION_LIMITS_HARD.cacheTtlMs),
  };
}

/**
 * 一回合的图片清单。
 *
 * 这个结构直接喂给 `prompt.mjs`（`context.recent[].images`）与运行时统计，
 * 所以字段名要和契约 §4、§6 对齐。
 *
 * @typedef {object} TurnImages
 * @property {Array<{messageId: any, floor: number|null, index: number, dataUrl: string,
 *   mime: string, bytes: number, width: number, height: number, label: string,
 *   origin: 'current'|'history'|'quoted'}>} images
 *   **只含 dataUrl**（提交给模型用）。URL / 原始 base64 / 本机路径一律不出现在这里。
 * @property {string[]} notes   追加进提示的说明（空数组 = 无需说明；已净化，不含 URL 与 base64）
 * @property {{attempted: number, loaded: number, skipped: number, bytes: number, codes: string[]}} stats
 *   `attempted` = 本回合进入取图流程的张数（缓存命中计入；张数裁剪掉的**不**计入），
 *   `loaded` = 真正装进消息的张数，`skipped` = 放弃的张数。
 *   恒有 `attempted === loaded + skipped`；界面据此判定
 *   `attempted > 0 && loaded === 0` = 「开关开着但本回合一图未得」。
 * @property {string[]} codes   失败码，供运行时统计（与 `stats.codes` 同一份）
 */

/**
 * 组装一回合要提交的图片。
 *
 * 挑选顺序（这个顺序就是成本优先级，不要随手调换）：
 *
 *   1. **本次消息**：用户刚发的图，几乎总是最相关的；
 *   2. **引用消息**：用户特意引用过来，意图明确；
 *   3. **历史**：只取 `historyWindow` 内、没提交过、不在 `alreadySeen` 里的楼层，
 *      从新到旧。
 *
 * 任何一张图取不到都不影响其余图片，也绝不抛错 —— 一回合降级成
 * "只有文字"是完全可以接受的结局，而一个异常会毁掉整次回复。
 *
 * @param {object} input
 * @param {object} input.config            normalize 过的 vision 配置（raw 也接受）
 * @param {string} [input.convKey]         会话键（缓存命名空间）
 * @param {boolean} [input.isGroup]
 * @param {{messageId?: any, floor?: number, evt?: any}|null} [input.trigger]
 * @param {{messageId?: any, floor?: number, evt?: any}|null} [input.quoted]
 * @param {Array<{floor: number, messageId: any, evt: any, imagesSeen?: boolean}>} [input.history]
 * @param {Set<number>|Array<number>} [input.alreadySeen]
 * @param {object} [input.deps]            传给 fetchImage（getImage / fetchUrl / snowlumaDir）
 * @param {() => number} [input.now]
 * @returns {Promise<TurnImages>}
 */
export async function collectTurnImages(input = {}) {
  const cfg = normalizeVisionConfig(input?.config);
  const convKey = String(input?.convKey ?? '');
  const now = typeof input?.now === 'function' ? input.now : Date.now;
  const deps = input?.deps && typeof input.deps === 'object' ? input.deps : {};

  /*
   * 显式关闭时在**这一层**也拦一次，不能只靠宿主。
   *
   * ## 为什么是"显式 false"而不是"不是 true 就拦"
   *
   * 宿主的 `visionGate()` 会在调用本函数**之前**就挡住"关掉"与"模型不支持"，
   * 所以正常路径下这里永远不会命中。加这一道是纵深防御：本函数是公开导出，
   * 未来的调用方（插件、CLI、下一条链路）可能直接调它 —— 那时漏判的后果是
   * **真的发请求取图**：用户明明关了视觉，网关照样在收 `get_image`。
   *
   * 但判定必须只认**显式 `false`**：
   *
   *   · 生产路径里 `config.vision` 一定带这个字段（schema 默认 false），
   *     所以显式 false 覆盖了全部真实场景；
   *   · `undefined` 表示"调用方没提这件事"（单测、工具内部的候选组装），
   *     这时不该替它做"关掉"的决定 —— 那会让本模块无法独立测试，
   *     也会让"只想取几张图"的内部调用莫名其妙地什么都不做。
   *
   * 换句话说：**关掉是明确意思，不写只是没表态**。把后者当后者处理。
   */
  if (input?.config && typeof input.config === 'object' && input.config.enabled === false) {
    return {
      images: [],
      notes: [],
      stats: { attempted: 0, loaded: 0, skipped: 0, bytes: 0, codes: [] },
      codes: [],
    };
  }

  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const codes = [];

  /** @type {Array<{ref: any, origin: 'current'|'history'|'quoted', messageId: any, floor: number|null, index: number, imgIndex: number}>} */
  const candidates = [];
  const seenKeys = new Set();
  /** 每条消息内的图片序号：缓存键要用它，而不是全局序号（全局序号跨回合不稳定） */
  const perMessageIndex = new Map();
  /** 没有 file/url/inline 的图只能靠序号区分身份，这里给一个单调递增计数器 */
  let anonymousSeq = 0;

  const push = (ref, origin, messageId, floor) => {
    /*
     * 同一张图（同 messageId + 同 file/url）在一次调用内只取一次。
     *
     * ident 为空时（file/url/inline 全都没有）不能按空串合并 ——
     * 那会把同一条消息里互不相关的多张图错误地压成一张，
     * 所以退回用单调递增序号作为身份（用 candidates.length 会随集合变化，不可靠）。
     */
    const ident = ref?.file || ref?.url || ref?.inline || '';
    let key;
    if (ident) {
      key = `${String(messageId)}|${ident}`;
    } else {
      // 用 candidates.length 会随集合变化而不稳定，所以自己数一个单调序号
      anonymousSeq += 1;
      key = `${String(messageId)}|#anon-${anonymousSeq}`;
    }
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const msgId = String(messageId ?? '');
    const imgIndex = perMessageIndex.get(msgId) ?? 0;
    perMessageIndex.set(msgId, imgIndex + 1);

    candidates.push({ ref, origin, messageId, floor: floor ?? null, index: candidates.length, imgIndex });
  };

  /*
   * 1) 本次消息
   *
   * 主动回合（没有 trigger）没有"本次消息"，直接跳过。
   */
  if (input?.trigger?.evt || Array.isArray(input?.trigger?.images)) {
    const refs = refsOfEvent(input.trigger).slice(0, cfg.maxImagesPerTurn);
    refs.forEach((ref) => push(ref, 'current', input.trigger?.messageId ?? null, input.trigger?.floor ?? null));
  }

  /*
   * 2) 引用消息
   *
   * 与本次消息是同一条时不算"引用"（自己引用自己毫无意义，只会把同一张图
   * 在请求体里放两遍）。这条判断必须在这里做，而不是指望宿主别传。
   */
  const quotedIsSame = sameMessage(input?.quoted, input?.trigger);
  if (cfg.includeQuoted && input?.quoted && !quotedIsSame) {
    const refs = refsOfEvent(input.quoted).slice(0, cfg.maxImagesPerTurn);
    refs.forEach((ref) => push(ref, 'quoted', input.quoted?.messageId ?? null, input.quoted?.floor ?? null));
  }

  /*
   * 3) 历史：只取最近 window 楼、没见过、且不在 alreadySeen 里的。
   *
   * 宿主按楼层升序给，所以先取尾部再反转 —— 这就是"从新到旧"。
   */
  const alreadySeen = toFloorSet(input?.alreadySeen);
  const windowSize = cfg.historyWindow;
  const history = Array.isArray(input?.history) ? input.history : [];
  const recentHistory = windowSize > 0 ? history.slice(-windowSize) : [];
  const unseen = recentHistory
    .filter((h) => h && h.imagesSeen !== true && !alreadySeen.has(Number(h.floor)))
    .reverse();

  let historyRefs = 0;
  for (const h of unseen) {
    if (historyRefs >= cfg.maxHistoryImages) break;
    const refs = refsOfEvent(h);
    for (const ref of refs) {
      if (historyRefs >= cfg.maxHistoryImages) break;
      push(ref, 'history', h.messageId ?? null, h.floor ?? null);
      historyRefs += 1;
    }
  }

  /*
   * 4) 张数上限：`maxImagesPerTurn + maxHistoryImages`。
   *
   * 超出的按**从旧到新**丢 —— candidates 已经是新→旧的优先级顺序，
   * 所以保留前缀就是在丢最旧的那部分。
   */
  const maxTotalImages = cfg.maxImagesPerTurn + cfg.maxHistoryImages;
  let dropped = 0;
  while (candidates.length > maxTotalImages) {
    candidates.pop();
    dropped += 1;
  }
  if (dropped > 0) {
    notes.push(`本回合图片数量超过上限（${maxTotalImages} 张），已从最旧的开始跳过 ${dropped} 张`);
  }

  /** @type {TurnImages['images']} */
  const images = [];
  let totalBytes = 0;
  let skipped = 0;
  const limitNotes = new Map();

  for (const item of candidates) {
    /*
     * 缓存键 = 会话 + 消息 + 该消息内的第几张图。
     *
     * 不含 `origin`：同一张图这一回合作为"本期消息"、下一回合作为"历史"
     * 出现时应当命中同一份字节 —— 那正是缓存的意义。
     * 也不含全局序号：全局序号随候选集合变化，跨回合不稳定，会导致永远 miss。
     */
    const cacheKey = `${convKey}|${String(item.messageId)}|${item.imgIndex}`;
    const cached = cacheGet(cacheKey, cfg, now);
    if (cached) {
      /*
       * 缓存命中也要过总字节预算。
       *
       * 直觉上"字节已经在内存里了，不算新成本"，但这里省的是**网络**，
       * 不是**请求体**：上游照样按 token 收钱。所以缓存命中不许绕过预算，
       * 否则缓存越热、每回合提交的图越多，账单反而越高。
       */
      if (totalBytes + cached.bytes > cfg.maxTotalBytes) {
        skipped += 1;
        /*
         * 缓存命中也必须记下失败码，理由与下面两条字节预算出口一致：
         * 宿主只在 `codes.length > 0` 时把原因拼进占位说明
         * （src/index.mjs 调 annotateImagePlaceholders 的那个条件）。
         *
         * 不记的后果很具体：本回合候选**全部命中缓存**、又都被总字节预算
         * 挡下时，`codes` 为空、`notes` 只剩一条对用户不可见的说明，
         * 于是 effective 判成 `on-but-blocked`，而模型与用户都看不到
         * "为什么一张都没进来"。缓存越热（第二回合以后）越容易走到这里。
         */
        codes.push('E3106');
        if (!limitNotes.has('E3106')) {
          limitNotes.set('E3106', `图片总字节超过上限（${cfg.maxTotalBytes} 字节）`);
        }
        continue;
      }
      totalBytes += cached.bytes;
      images.push({ ...cached, messageId: item.messageId, floor: item.floor, index: images.length, origin: item.origin });
      continue;
    }

    // 总字节预算：已经装不下了就别浪费一次网络请求
    const remainingBytes = cfg.maxTotalBytes - totalBytes;
    if (remainingBytes <= 0) {
      skipped += 1;
      /*
       * 这条出口同样要记码。它是"预算已被前面的图吃光"的情形：
       * 跳过是真的，但没有任何取图失败，所以如果不在这里补一个 E3106，
       * 本回合的 codes 就可能整体为空 —— 而宿主靠 codes 判断"要不要
       * 给 [图片] 占位补一句原因"。少记一个码 = 模型对着占位符瞎猜，
       * 用户也看不到"是被预算挡下的"。
       *
       * 用 E3106 而不是新造码：它在这三处出口的含义都是"超过字节上限"
       * （契约 §3 错误码表），排查指向同一个原因。
       */
      codes.push('E3106');
      if (!limitNotes.has('E3106')) {
        limitNotes.set('E3106', `图片总字节超过上限（${cfg.maxTotalBytes} 字节）`);
      }
      continue;
    }

    const got = await fetchImage(item.ref, {
      limits: {
        maxBytes: Math.min(cfg.maxBytes, remainingBytes),
        maxPixels: cfg.maxPixels,
        timeoutMs: cfg.timeoutMs,
      },
      deps: { ...deps, now },
    });

    if (!got.ok) {
      skipped += 1;
      codes.push(got.code);
      // 同一个码只记一次原因，避免 4 张图各失败一次就把提示撑满
      if (!limitNotes.has(got.code)) limitNotes.set(got.code, got.reason);
      continue;
    }

    const bytes = got.buffer.length;
    if (totalBytes + bytes > cfg.maxTotalBytes) {
      // 取到了但装不下：这张图作废（字节已经在内存里，不缓存也不提交）
      skipped += 1;
      codes.push('E3106');
      if (!limitNotes.has('E3106')) {
        limitNotes.set('E3106', `图片总字节超过上限（${cfg.maxTotalBytes} 字节）`);
      }
      continue;
    }

    const entry = {
      mime: got.mime,
      bytes,
      width: got.width,
      height: got.height,
      dataUrl: `data:${got.mime};base64,${got.buffer.toString('base64')}`,
      label: item.ref.name || `图片${item.index + 1}`,
    };
    cacheSet(cacheKey, entry, cfg, now);
    totalBytes += bytes;
    images.push({ ...entry, messageId: item.messageId, floor: item.floor, index: images.length, origin: item.origin });
  }

  /*
   * 降级说明。
   *
   * 每个**去重后**的码只写一次，而且不写完整堆栈：这段文字会进模型上下文，
   * 也可能被它复述到群里。"网关 get_image 失败：E3102"对人够用，
   * 对模型只是噪音。
   *
   * `sanitizeNote` 是**必须**的，不是洁癖：这些 reason 来自取图链路，
   * 里面可能带上 URL（含临时鉴权参数）或本机绝对路径。notes 会被拼进
   * 提示词发给上游，等于把本机目录结构与图片鉴权入口一起送出去。
   */
  if (codes.length > 0) {
    const summary = Array.from(new Set(codes)).join('/');
    const detail = Array.from(limitNotes.values()).map(sanitizeNote).join('；');
    notes.push(`本回合有 ${codes.length} 张图取不到（${summary}）：${detail}`);
  }

  return {
    images,
    notes,
    stats: {
      attempted: candidates.length,
      loaded: images.length,
      skipped,
      bytes: totalBytes,
      codes: [...codes],
    },
    codes,
  };
}

/* ------------------------------------------------------------------ 缓存 */

/**
 * 图片内存缓存。
 *
 * 键含 `convKey`：两个群里出现同一条 messageId 是完全可能的
 * （不同会话的消息编号各自独立），不隔离就会把 A 群的图提交到 B 群。
 *
 * @type {Map<string, {dataUrl: string, mime: string, bytes: number, width: number, height: number, label: string, at: number}>}
 */
const CACHE = new Map();
let cacheBytes = 0;

/**
 * 取缓存项（顺手清掉过期的）。
 *
 * @param {string} key
 * @param {{cacheTtlMs: number}} cfg
 * @param {() => number} now
 * @returns {any | null}
 */
function cacheGet(key, cfg, now) {
  const at = now();
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (at - hit.at > cfg.cacheTtlMs) {
    CACHE.delete(key);
    cacheBytes -= hit.bytes;
    return null;
  }
  // 命中不算过期，但要刷新 LRU 顺序（Map 保序，删了再塞回去）
  CACHE.delete(key);
  CACHE.set(key, hit);
  return hit;
}

/**
 * 写缓存，并维持条数与字节双上限。
 *
 * ## 为什么超额是**淘汰最旧**而不是拒绝写入
 *
 * 拒绝写入会让"刚取到的图"永远进不了缓存（缓存满了就再也不更新），
 * 表现为每次刷新都重新下载。淘汰最旧才能让缓存始终保存"最近真的用到的"。
 *
 * @param {string} key
 * @param {any} entry
 * @param {{cacheTtlMs: number}} cfg
 * @param {() => number} now
 */
function cacheSet(key, entry, cfg, now) {
  // 单张就超过缓存总字节时干脆不缓存：塞进去会把别的全挤掉，得不偿失
  if (entry.bytes > VISION_LIMITS_HARD.cacheMaxBytes) return;

  const existing = CACHE.get(key);
  if (existing) {
    cacheBytes -= existing.bytes;
    CACHE.delete(key);
  }

  CACHE.set(key, { ...entry, at: now() });
  cacheBytes += entry.bytes;

  // 过期项先清（TTL 到期的项不该占着字节预算）
  sweepCache(cfg.cacheTtlMs, now());

  while (CACHE.size > VISION_LIMITS_HARD.cacheMaxEntries || cacheBytes > VISION_LIMITS_HARD.cacheMaxBytes) {
    const oldestKey = CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = CACHE.get(oldestKey);
    CACHE.delete(oldestKey);
    cacheBytes -= oldest?.bytes ?? 0;
  }
}

function sweepCache(ttlMs, at) {
  for (const [key, entry] of CACHE) {
    if (at - entry.at > ttlMs) {
      CACHE.delete(key);
      cacheBytes -= entry.bytes;
    }
  }
}

/**
 * 清空缓存。
 *
 * 给测试与"用户切换模型/关掉视觉"用：关掉视觉之后再打开，
 * 旧图不该被静默复用（那会绕过"每回合重新判定"的语义）。
 */
export function resetVisionCache() {
  CACHE.clear();
  cacheBytes = 0;
}

/**
 * 缓存当前状态（仅用于界面/测试观测，不要拿它做逻辑判断）。
 *
 * @returns {{entries: number, bytes: number}}
 */
export function visionCacheStats() {
  return { entries: CACHE.size, bytes: cacheBytes };
}

/* ------------------------------------------------------------------ 内部 */

/**
 * 把一条说明净化成"可以进提示词、可以进日志"的形状。
 *
 * ## 为什么要专门一个函数
 *
 * `notes` 与 `codes` 的消费方有两处，而两处都不能接受原始 reason：
 *
 *   1. `notes` 会被拼进系统提示、发给上游模型（可能再被复述到群里）；
 *   2. `codes` / `lastNotes` 会进运行时快照与界面日志。
 *
 * 而 reason 是从取图链路一路传上来的字符串，里面**可能**含 URL
 * （`https://...?term=2&key=...`，带临时鉴权）或本机绝对路径。
 * 所以这里按模式剥掉：URL、base64 长串、盘符路径、UNC。
 *
 * 剩下的信息（"图片超过大小限制（5000000 字节）"）对人仍然够用。
 *
 * @param {unknown} text
 * @returns {string}
 */
function sanitizeNote(text) {
  return String(text ?? '')
    // http(s)://... 整段（含查询串里的鉴权参数）→ 只留协议，说明"这里曾有个 URL"
    .replace(/\b(?:https?|ftp|ws|wss|file):\/\/[^\s，。；）)]*/gi, '[链接已隐去]')
    // 很长的 base64/data URL 片段（≥40 个 base64 字符）→ 隐去
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[数据已隐去]')
    // Windows 盘符路径与 UNC
    .replace(/\b[a-zA-Z]:[\\/][^\s，。；）)]*/g, '[路径已隐去]')
    .replace(/\\\\[^\s，。；）)]*/g, '[路径已隐去]')
    // POSIX 绝对路径（只剥够长的，避免把 "1/2" 这种误伤）
    .replace(/(?:^|[\s（(])\/(?:[\w.@-]+\/)+[\w.@-]+/g, (m) => `${m.startsWith('/') ? '' : m[0]}[路径已隐去]`)
    .slice(0, 200);
}

/**
 * 从一条"事件或消息"里取图片引用。
 *
 * 三种形状都要认，因为调用方来自不同年代的数据：
 *   - `evt.segments`（实时归一化事件）
 *   - `evt.message`（原始 OneBot 数组）
 *   - `evt.media`（持久化后的元数据，没有段结构）
 *
 * @param {any} holder
 * @returns {Array<import('./media-refs.mjs').MediaRef>}
 */
function refsOfEvent(holder) {
  const evt = holder?.evt ?? holder;
  if (!evt || typeof evt !== 'object') {
    // 宿主也可以只给 images 数组（例如工具结果回灌）
    return Array.isArray(holder?.images) ? mediaRefsFromStored(holder.images) : [];
  }
  if (Array.isArray(evt.media)) return mediaRefsFromStored(evt.media);
  if (Array.isArray(evt.segments)) return extractImageRefs(evt.segments);
  if (Array.isArray(evt.message)) return extractImageRefs(evt.message);
  return [];
}

/** 两条消息是不是同一条（messageId 可能是数字或字符串，统一按字符串比） */
function sameMessage(a, b) {
  if (!a || !b) return false;
  const ida = a.messageId;
  const idb = b.messageId;
  if (ida === null || ida === undefined || idb === null || idb === undefined) return false;
  return String(ida) === String(idb);
}

/** alreadySeen 允许 Set 或数组，元素可能是字符串（持久化后） */
function toFloorSet(value) {
  const out = new Set();
  if (value instanceof Set) {
    for (const v of value) out.add(Number(v));
  } else if (Array.isArray(value)) {
    for (const v of value) out.add(Number(v));
  }
  return out;
}

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
