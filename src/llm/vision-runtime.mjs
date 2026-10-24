/**
 * 视觉降级判定 —— 把「开关 / 能力 / 结果」三份事实合成一个结论（契约 §8 / §10）
 *
 * ## 为什么单独一个文件，而不是写在 index.mjs 里
 *
 * 这段逻辑有六种组合（开关开/关 × 能力 true/false/未知 × 本回合是否取到图），
 * 而它恰好是**最容易写错、也最难靠肉眼验收**的一块：
 *
 *   · 写错一个分支，表现是"界面写着支持、实际不带图"，没有任何报错；
 *   · 它在 index.mjs 里的话，要验证只能起一个真机器人发一张真图。
 *
 * 所以把它抽成纯函数：输入是三份普通数据，输出是一份普通数据。
 * 测试可以直接把所有组合跑一遍，一次网络请求都不发。
 *
 * ## 为什么"未探测"必须单独一态
 *
 * 这是本需求反复强调的一点，也是历史上真实踩过的坑：
 * `supported` 的三态里 `null`（没测出来）与 `false`（测过、不支持）
 * 完全不是一回事。把 `null` 当 `false` 处理，用户会看到"模型不支持读图"，
 * 于是再也不试 —— 而真相可能只是一次探测超时。
 *
 * 所以判定顺序里，`enabled` 与 `supported` 各占一个独立分支，
 * 任何一个分支都不允许把 `null` 折叠进 `false`。
 */

/**
 * 本回合的实际效果。
 *
 * @typedef {'off'|'on'|'on-unprobed'|'on-unsupported'|'on-but-blocked'} VisionEffective
 */

/**
 * 依据开关、能力探测与本回合取图结果，算出"这一回合到底会怎样"。
 *
 * ## 判定顺序（顺序本身就是语义）
 *
 *   1. 开关关着 → `off`（**第一优先**：关掉就是关掉，能力再强也不带图）
 *   2. 已实测不支持 → `on-unsupported`（开关开着也不带，避免每回合白取一次图）
 *   3. 能力未知/未探测 → 带图（`on-unprobed`），失败由上游拒收兜底
 *   4. 已实测支持 → 带图（`on`）
 *   5. 开关开、能力没问题，但本回合一张都没装进去 → `on-but-blocked`
 *
 * 第 5 条必须排在最后：它描述的是"这一回合的结果"，不是"配置或能力"。
 * 放在前面会让"取图失败"看起来像"配置错了"。
 *
 * @param {object} input
 * @param {boolean} [input.enabled]            开关状态（用户意图）
 * @param {boolean|null} [input.supported]     能力探测结论：true / false / null（未知）
 * @param {boolean} [input.mayAttach]          被允许进入本回合的图片候选数 > 0
 * @param {{attempted: number, loaded: number}} [input.lastTurn] 本回合取图结果
 * @returns {VisionEffective}
 */
export function resolveEffective(input = {}) {
  if (input.enabled !== true) return 'off';
  if (input.supported === false) return 'on-unsupported';

  const last = input.lastTurn ?? {};
  const attempted = toCount(last.attempted);
  const loaded = toCount(last.loaded);

  /*
   * 「开着、能力也没问题、这一回合确实尝试过、但一张都没成」= 被挡下。
   *
   * 没有 `attempted > 0` 这个前提会误报：一个纯文字回合本来就不该带图，
   * 那时 loaded 也是 0，但它不是"被挡下"，而是"本来就没图"。
   * 这正是把 attempted 单独统计出来的原因。
   */
  if (attempted > 0 && loaded === 0) return 'on-but-blocked';

  if (input.supported === true) return 'on';
  return 'on-unprobed';
}

/**
 * 一回合的取图结果里，哪些楼层的图片**真的被提交**了。
 *
 * ## 为什么按楼层去重，而不是按图片去重
 *
 * `imagesSeenFloors` 的语义是"这条消息的图片进过模型"。粒度比单张图粗
 * 是有意选的：同一条消息里的第二张图下次是否重发，价值远小于"这条消息
 * 整条已经看过了"这个判断；而更细的粒度会让持久层多存一个图片级集合。
 *
 * ## 为什么只认 floor 是数字的项
 *
 * `floor` 为 null 表示"这条消息不来自楼层仓库"（例如工具结果、或主动回合
 * 的合成事件）。给它记一个假的楼层号，会让未来某个真实的楼层被误判成
 * "已提交"，那条消息的图永远不会再进模型。
 *
 * @param {Array<{floor?: number|null}>} images
 * @returns {number[]} 去重后的楼层号
 */
export function floorsWithSubmittedImages(images) {
  const out = new Set();
  for (const img of Array.isArray(images) ? images : []) {
    const f = img?.floor;
    if (typeof f === 'number' && Number.isSafeInteger(f) && f > 0) out.add(f);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 把本回合的取图结果并进运行时统计（**就地修改**，返回同一个对象）。
 *
 * ## 为什么要单独一个函数，而不是在回合里手写三行加法
 *
 * 统计有六个数，其中 `lastTurn` 是**覆盖**（本回合）、其余是**累加**（历史）。
 * 混在一起手写时最容易犯的错是"把 lastTurn 也累加了"，于是界面上的
 * "本回合"panel 显示的是历史总量 —— 那种数字看起来完全合理，没人会怀疑。
 *
 * @param {object} runtime  视觉运行时统计（形如 index.mjs 的 visionRuntime）
 * @param {{images: Array<object>, stats: {attempted: number, loaded: number, skipped: number, bytes: number, codes: string[]}, notes: string[]}} outcome
 * @param {() => number} [now]
 * @returns {object} 同一个 runtime
 */
export function recordVisionTurn(runtime, outcome, now = Date.now) {
  const rt = runtime && typeof runtime === 'object' ? runtime : {};
  const stats = outcome?.stats ?? {};
  const images = Array.isArray(outcome?.images) ? outcome.images : [];
  const bytes = toCount(stats.bytes);

  if (images.length > 0) {
    rt.turnsWithImages = toCount(rt.turnsWithImages) + 1;
    rt.imagesSubmitted = toCount(rt.imagesSubmitted) + images.length;
    rt.bytesSubmitted = toCount(rt.bytesSubmitted) + bytes;
  }
  rt.skipped = toCount(rt.skipped) + toCount(stats.skipped);

  rt.lastTurn = {
    attempted: toCount(stats.attempted),
    loaded: images.length,
    bytes,
    codes: Array.isArray(stats.codes) ? stats.codes.slice(0, 12) : [],
    notes: (Array.isArray(outcome?.notes) ? outcome.notes : []).slice(0, 6),
  };

  const codes = Array.isArray(stats.codes) ? stats.codes : [];
  if (codes.length > 0) {
    // 只留有界的近期失败码，界面据此显示"最近为什么失败"
    const merged = [...new Set([...codes, ...(Array.isArray(rt.lastCodes) ? rt.lastCodes : [])])];
    rt.lastCodes = merged.slice(0, 12);
  }

  rt.lastAt = now();
  return rt;
}

/**
 * 快照里给界面的那份视觉状态（契约 §10）。
 *
 * 三个字段回答三个不同的问题，**永远不要合并**：
 *   - `enabled`    用户想不想（可改）
 *   - `capability` 模型能不能（只读，实测结论）
 *   - `effective`  这一回合实际会怎样（结论）
 *
 * @param {object} input
 * @param {object} input.config       原始配置（会被 normalize 夹取）
 * @param {object} [input.capability] 能力探测结论对象
 * @param {object} [input.runtime]    运行时统计
 * @param {(raw: object) => object} input.normalize   normalizeVisionConfig
 * @returns {object}
 */
export function buildVisionSnapshot(input) {
  const normalize = typeof input?.normalize === 'function' ? input.normalize : (raw) => ({ ...(raw ?? {}) });
  const limits = normalize(input?.config);
  const cap = input?.capability && typeof input.capability === 'object' ? input.capability : {};
  const runtime = input?.runtime && typeof input.runtime === 'object' ? input.runtime : {};

  const supported = typeof cap.supported === 'boolean' ? cap.supported : null;

  return {
    enabled: limits.enabled === true,
    limits,
    capability: {
      probed: cap.probed === true,
      supported,
      model: String(cap.model ?? ''),
      basis: String(cap.basis ?? ''),
      detail: String(cap.detail ?? ''),
      probedAt: cap.probedAt ?? null,
    },
    effective: resolveEffective({
      enabled: limits.enabled,
      supported,
      lastTurn: runtime.lastTurn,
    }),
    runtime: {
      turnsWithImages: toCount(runtime.turnsWithImages),
      imagesSubmitted: toCount(runtime.imagesSubmitted),
      bytesSubmitted: toCount(runtime.bytesSubmitted),
      skipped: toCount(runtime.skipped),
      lastCodes: Array.isArray(runtime.lastCodes) ? runtime.lastCodes.slice(0, 12) : [],
      lastNotes: Array.isArray(runtime.lastTurn?.notes) ? runtime.lastTurn.notes.slice(0, 6) : [],
      lastTurn: {
        attempted: toCount(runtime.lastTurn?.attempted),
        loaded: toCount(runtime.lastTurn?.loaded),
        bytes: toCount(runtime.lastTurn?.bytes),
      },
      imageRejectedCount: toCount(runtime.imageRejectedCount),
      lastImageRejectedAt: runtime.lastImageRejectedAt ?? null,
      lastAt: runtime.lastAt ?? null,
    },
  };
}

/**
 * 把一条消息的文本改写成"带图占位说明"的版本。
 *
 * 当一回合取不到图（没开、模型不支持、取图失败）时，模型看到的仍是
 * `[图片]` 这个占位符。它不知道那是"一张图但你看不到"还是"一个奇怪的字"，
 * 于是经常回答"我看不到图片内容"或干脆忽略。加一句短说明能显著改善。
 *
 * ## 为什么说明要短、且不带原因细节
 *
 * 这段文字会进每一次请求。详细原因（E3106、5MB、重定向）对模型没有意义，
 * 只会浪费 token 并诱导它复述技术细节到群里。细节走 notes（给界面看）。
 *
 * @param {string} text
 * @param {VisionEffective} effective
 * @param {string[]} [notes] 本回合的降级说明
 * @returns {string}
 */
export function annotateImagePlaceholders(text, effective, notes = []) {
  const body = String(text ?? '');
  if (!body.includes('[图片]')) return body;

  /** @type {Record<string, string>} */
  const suffix = {
    off: '（图片识别已关闭，你看不到图里的内容；不要猜图里是什么）',
    'on-unsupported': '（当前模型不支持读图，你看不到图里的内容；不要猜图里是什么）',
    'on-but-blocked': '（这张图这次没能取到，你看不到内容；不要猜图里是什么）',
  };

  const line = suffix[effective] ?? '';
  if (!line) {
    // 开着且有图能取 —— 但本回合仍可能有部分图失败，这时给一句更轻的说明
    return notes.length > 0 ? `${body}\n${notes.map((n) => `（${n}）`).join('')}` : body;
  }
  return `${body}\n${line}`;
}

/**
 * 从一条消息的 content 里安全地取出纯文本。
 *
 * 多模态之后 `content` 可能是字符串，也可能是 `[{type:'text'}, {type:'image_url'}]`。
 * 直接 `String(content)` / `content.join()` 会产出 `[object Object]`，
 * 而这个字符串会进用量记账（`promptText`）与日志 —— 一旦变成
 * `[object Object]`，缺 usage 时的 token 估算就完全失真（几乎为 0），
 * 表现为"这个月账单和界面数字对不上"，且没有任何报错。
 *
 * @param {unknown} content
 * @returns {string}
 */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
    // 图片占位：不取 base64，只标一个数量记号，避免 promptText 变成几 MB 的字符串
    else if (item && typeof item === 'object' && item.type === 'image_url') {
      parts.push('[图片]');
    }
  }
  return parts.join('\n');
}

/**
 * 把整份 messages 拼成可以估 token 的文本。
 *
 * @param {Array<{role?: string, content?: unknown}>} messages
 * @returns {string}
 */
export function messagesToPlainText(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map((m) => contentToText(m?.content)).filter(Boolean).join('\n');
}

function toCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
}
