/**
 * 媒体句柄注册表 —— 把「媒体」变成不可伪造的引用
 *
 * ## 为什么不给插件真实路径 / URL
 *
 * 这是本模块存在的唯一理由，必须说清楚，否则很容易为了"方便"退化回去：
 *
 * 一旦插件拿到 `C:\Users\me\Pictures\a.png` 或 `https://gchat.qpic.cn/...`，
 * 它能做的事情立刻超出"发这张图"：
 *
 *   - 路径可以被写进工具的返回值，模型就能把它念到群里（出站审计拦得住一部分，
 *     但那是**兜底**，不是设计）；
 *   - 路径可以被拿去读、被拿去删（插件本来就有本机文件权限，但"能不碰就不碰"
 *     和"顺手就能碰"是两种风险姿态）；
 *   - URL 带着 QQ 的临时鉴权参数，泄露出去等于把那张图公开。
 *
 * 所以插件看到的是 `media_<随机>` 这样的**句柄**：
 *
 *   - 它没有语义（看不出指向哪个文件），不能被猜；
 *   - 它绑定**插件 id**（A 插件拿不到 B 插件的句柄）；
 *   - 它绑定**会话**（群 A 的句柄不能在群 B 用，防止拿群里的图去别处发）；
 *   - 它**会过期**（10 分钟），一次对话内的"发这张图"用不着更久；
 *   - 真实来源只存在宿主内存里，进程重启即失效（失败即"句柄无效"，不降级成路径）。
 *
 * ## 为什么不做成签名 token
 *
 * 签名 token 能让句柄跨进程重启有效，但也会带来一个新问题：**撤销**。
 * 用户撤回了那张图、退群了、或者插件被停用，句柄却还在有效期内。
 * 内存表 + 短过期 + 绑定插件/会话是最省事且最容易推理的方案：
 * 进程重启 = 全部失效，这个语义简单到不会有人理解错。
 */

import crypto from 'node:crypto';

/** 句柄前缀：一眼能看出这是句柄而不是路径 */
const HANDLE_PREFIX = 'media_';

/** 句柄默认有效期：10 分钟。够一次对话来回，又不至于长期留着一张图的入口 */
export const DEFAULT_HANDLE_TTL_MS = 10 * 60 * 1000;

/** 每个插件最多同时持有多少个句柄（防止一个插件刷爆内存） */
const MAX_HANDLES_PER_PLUGIN = 200;

/** 句柄字面量规则（校验用，不对应任何真实数据） */
const HANDLE_RE = /^media_[A-Za-z0-9_-]{16,64}$/;

/**
 * 判断一个值看起来是不是句柄。
 *
 * 注意：**形状像**不等于有效。真正的校验必须走 resolve()，
 * 它会同时检查归属、会话、过期。这个函数只用于"先给出一个更准确的错误信息"。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeHandle(value) {
  return typeof value === 'string' && HANDLE_RE.test(value);
}

/**
 * 生成一个句柄。
 *
 * 16 字节 base64url（22 字符）足够不可猜；不加时间戳等可推断信息。
 *
 * @returns {string}
 */
function mintHandle() {
  return HANDLE_PREFIX + crypto.randomBytes(16).toString('base64url');
}

/**
 * 媒体句柄注册表。
 */
export class MediaHandleRegistry {
  constructor(opts = {}) {
    /** @type {Map<string, any>} handle → entry */
    this.entries = new Map();
    this.ttlMs = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : DEFAULT_HANDLE_TTL_MS;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.maxPerPlugin = Number.isFinite(opts.maxPerPlugin) ? Number(opts.maxPerPlugin) : MAX_HANDLES_PER_PLUGIN;
  }

  /**
   * 清掉过期项。每次读写都顺手跑一遍，成本 O(n) 而 n ≤ 几十。
   * 不起定时器：定时器会拖住进程退出（测试里尤其明显）。
   */
  sweep() {
    const now = this.now();
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(handle);
    }
  }

  /**
   * 登记一个媒体，返回给插件看的句柄与元数据。
   *
   * `source` 是**宿主专用**字段（真实路径 / OneBot 段），
   * 它绝不出现在返回值里 —— 见下面的 publicView()。
   *
   * @param {object} input
   * @param {string} input.pluginId 归属插件
   * @param {string} input.convKey 归属会话（跨会话使用会被拒）
   * @param {string} input.kind image / record / video / file
   * @param {string} [input.name] 展示用文件名（不含目录）
   * @param {string} [input.mime]
   * @param {number} [input.bytes]
   * @param {object} input.source 宿主内部来源（路径或 OneBot 段），不会外泄
   * @param {string} [input.messageId] 来源消息 id（便于追溯）
   * @returns {object} 公开视图
   */
  register(input) {
    this.sweep();

    const pluginId = String(input.pluginId ?? '');
    if (!pluginId) throw new TypeError('register 需要 pluginId');

    // 单个插件的句柄上限：超过就淘汰它自己最旧的那个，
    // 而不是抛错 —— 插件不该因为"用得久"就突然发不出图。
    const mine = [...this.entries.entries()].filter(([, e]) => e.pluginId === pluginId);
    if (mine.length >= this.maxPerPlugin) {
      mine.sort((a, b) => a[1].createdAt - b[1].createdAt);
      const drop = mine.slice(0, mine.length - this.maxPerPlugin + 1);
      for (const [handle] of drop) this.entries.delete(handle);
    }

    const handle = mintHandle();
    const now = this.now();
    const entry = {
      handle,
      pluginId,
      convKey: String(input.convKey ?? ''),
      kind: String(input.kind ?? 'image'),
      name: String(input.name ?? ''),
      mime: String(input.mime ?? ''),
      bytes: Number.isFinite(input.bytes) ? Number(input.bytes) : 0,
      messageId: input.messageId === undefined ? null : input.messageId,
      source: input.source,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.entries.set(handle, entry);
    return publicView(entry);
  }

  /**
   * 解析句柄，并**同时校验归属**。
   *
   * 三种拒绝分开报，因为它们对应完全不同的排查方向：
   *   - 不存在 / 过期 → 插件自己用旧了（或者宿主重启过）
   *   - 归属不符     → 拿别的插件的句柄（越权尝试）
   *   - 会话不符     → 拿别的群的句柄来这边发（越权尝试）
   *
   * @param {object} input
   * @param {string} input.pluginId
   * @param {string} input.convKey
   * @param {unknown} input.handle
   * @returns {{ok: true, entry: any} | {ok: false, code: string, message: string}}
   */
  resolve(input) {
    this.sweep();
    const handle = typeof input?.handle === 'string' ? input.handle.trim() : '';
    if (!looksLikeHandle(handle)) {
      return { ok: false, code: 'E4073', message: `媒体句柄格式非法：${String(input?.handle ?? '')}` };
    }
    const entry = this.entries.get(handle);
    if (!entry) {
      return { ok: false, code: 'E4073', message: '媒体句柄不存在或已过期' };
    }
    if (entry.pluginId !== String(input.pluginId ?? '')) {
      /*
       * 归属不符**不区分**"不存在"与"不是你的"吗？
       *
       * 这里刻意区分（而不是统一报"不存在"）：插件作者是自己人，
       * 明确告诉他"这个句柄属于别的插件"能让他立刻发现自己传错了对象；
       * 而对外（模型可见的工具结果）不会出现句柄，所以不存在利用这条信息
       * 探测他人句柄的路径 —— 句柄先得被猜中才行，而这不可能。
       */
      return { ok: false, code: 'E4074', message: '媒体句柄不属于当前插件' };
    }
    if (entry.convKey !== String(input.convKey ?? '')) {
      return { ok: false, code: 'E4074', message: '媒体句柄不属于当前会话' };
    }
    return { ok: true, entry };
  }

  /**
   * 会话/插件都匹配时，批量解析。
   *
   * @param {{pluginId: string, convKey: string, handles: unknown[]}} input
   * @returns {{ok: true, entries: any[]} | {ok: false, code: string, message: string}}
   */
  resolveMany(input) {
    const list = Array.isArray(input?.handles) ? input.handles : [];
    /** @type {any[]} */
    const entries = [];
    for (const handle of list) {
      const r = this.resolve({ pluginId: input.pluginId, convKey: input.convKey, handle });
      if (!r.ok) return r;
      entries.push(r.entry);
    }
    return { ok: true, entries };
  }

  /** 插件停用时清掉它的全部句柄（不能让停用的插件还留着入口） */
  forgetPlugin(pluginId) {
    let n = 0;
    for (const [handle, entry] of this.entries) {
      if (entry.pluginId === pluginId) {
        this.entries.delete(handle);
        n += 1;
      }
    }
    return n;
  }

  /** 仅供测试 */
  size() {
    this.sweep();
    return this.entries.size;
  }
}

/**
 * 句柄的公开视图（给插件/模型看的那一份）。
 *
 * **必须**只挑字段返回，不能 `{...entry}`：
 * 一旦哪天 entry 上多挂了一个 `path`，展开写法就会把它悄悄泄露出去。
 *
 * @param {any} entry
 * @returns {{handle: string, kind: string, name: string, mime: string, bytes: number, expiresAt: number}}
 */
export function publicView(entry) {
  return {
    handle: entry.handle,
    kind: entry.kind,
    name: entry.name,
    mime: entry.mime,
    bytes: entry.bytes,
    expiresAt: entry.expiresAt,
  };
}
