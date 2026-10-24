/**
 * 受控网关能力 —— `ctx.gateway` 的来源
 *
 * ## 为什么需要这个模块，而不是让插件自己调 OneBot
 *
 * 表情包这件事有四个动作，其中三个碰不到现有的 `ctx.chat`：
 *
 *   · 拉取 QQ 账号的收藏表情（`fetch_custom_face_detail`）
 *   · 取一个收藏表情的图片字节（不在任何会话消息里）
 *   · 把当前会话的图片收藏进账号（`add_custom_face`，这是对**账号**的写）
 *
 * 如果让插件自己做这三件事，等于把「任意 OneBot 动作调用」交给插件 ——
 * 那会直接推翻 `docs/plugin-api.md` §2.4 与 I4（发送只有一条通路）的边界：
 * 一个插件能发 `get_group_list`，就能拿到全部群；能发 `send_*_msg`，
 * 就绕过了发送闸门。
 *
 * 所以这里只暴露**四个语义化动作**，参数是"表情"/"消息"，不是 OneBot 报文。
 * 它和 `ctx.chat` 是同一套纪律：
 *
 *   1. **没有目标会话参数。** 收藏只能收藏 `ctx.caller.convKey` 里的消息。
 *   2. **归属由宿主给。** 插件参数里没有 convKey，`RESERVED_PARAM_NAMES` 也挡着。
 *   3. **失败返回结果对象，不抛异常。** 与 `ctx.chat` 一致。
 *   4. **发送仍走统一闸门与队列。** 这里**不实现**发送规则，只转交 `sendSegments`。
 *   5. **不落盘 QQ 图片 URL。** URL 带临时鉴权参数，只在内存里活一次。
 *
 * ## 网关扩展动作不能假设存在
 *
 * `fetch_custom_face_detail` / `add_custom_face` 是 OneBot 的**扩展**动作，
 * 不是标准。不同网关（SnowLuma / NapCat / LuckyLilliaBot）支持面不同，
 * 同一种网关的不同版本也不一样。所以能力探测是一条单独的路：
 *
 *   · `get_supported_actions` 成功返回数组 → 里面没有就是**实测不支持**；
 *   · 它失败 / 不返回数组 → 三态是 **unknown**，不是 unsupported。
 *
 * 把「没测出来」折成「不支持」是这条链路上最容易犯的错：用户会看到
 * 「你的网关不支持表情包」，而真相只是一次探测超时。反过来，
 * 把「不支持」当成「没测过」则会让每次调用都失败一次。
 *
 * ## 图片字节为什么必须由宿主取
 *
 * 收藏表情的 `url` 是 QQ 的 CDN 地址，抓它要过 SSRF / 重定向 / 体积 / 像素
 * 四道关。这些判定**已经在** `llm/image-fetch.mjs` 里写好了一份，
 * 插件再用自己的 fetch 就是第二份实现 —— 而第二份实现永远会慢慢漂移。
 *
 * 所以取字节这件事留在宿主，复用的是同一条 `safeFetchBuffer`。
 * 落盘到插件 `dataDir/faces/` 是为了两件事：发送时不必再抓一次，
 * 以及给模型看的 base64 不必每次重新下载。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { safeFetchBuffer } from '../llm/image-fetch.mjs';
import { isAnimatedImage, imageDimensions, sniffMime } from '../llm/image-bytes.mjs';
import { gatewayVisionView, UNKNOWN_GATEWAY_VISION } from './gateway-vision.mjs';

/** 表情图片的取字节预算（与 docs/stickers-contract.md §1.3 一致） */
export const FACE_FETCH_LIMITS = Object.freeze({
  /** 单次取图超时（含 DNS 与每一跳） */
  timeoutMs: 8000,
  /** 发送用途的字节硬顶：表情包很少超过它，超过基本是别的东西 */
  hardMaxBytes: 4 * 1024 * 1024,
  /** 像素上限：与视觉链路同口径，防图片炸弹 */
  maxPixels: 36_000_000,
});

/** 能力探测结果缓存多久（毫秒）。短一点：用户可能刚升级了网关 */
const CAP_TTL_MS = 5 * 60 * 1000;

/** 一次列表最多取多少条（网关侧的 count 参数上限） */
const MAX_LIST_COUNT = 500;

/** 收藏/发送的表情文件落在 dataDir 下的哪个子目录 */
const FACES_DIR = 'faces';

/** ctx.gateway 能做的事（探测用的动作名清单） */
export const GATEWAY_ACTIONS = Object.freeze({
  listFaces: 'fetch_custom_face_detail',
  collectFace: 'add_custom_face',
  modifyFaceDesc: 'modify_custom_face',
});

/**
 * 网关不可用/不支持时的统一错误。
 *
 * 分三个 code 而不是一个：它们指向完全不同的处理方向。
 *   E_GATEWAY_UNAVAILABLE  —— 网关没连上（等一会儿/检查配置）
 *   E_GATEWAY_UNSUPPORTED  —— 网关明确不支持（升级网关，或换实现）
 *   E_GATEWAY_BAD_PAYLOAD  —— 网关返回了看不懂的东西（可能是版本不匹配）
 *
 * @param {string} code
 * @param {string} message
 * @returns {{ok: false, code: string, message: string}}
 */
function gwFail(code, message) {
  return { ok: false, code, message };
}

/**
 * 判断一次调用失败是不是"网关不认识这个动作"。
 *
 * ## 为什么不能只看 message 里有没有某几个字
 *
 * 因为**这就是实际能拿到的全部信息**。OneBot 对未知动作的回应五花八门：
 * 标准一点的 `retcode: 1404` + `wording: "不支持的 API"`；有的实现回
 * `status: "failed"` 且 `wording` 为空；还有的干脆断开连接。
 *
 * 所以这里做两件事：优先看结构化的 `retcode`（1404 / -404 是常见的
 * "没有这个 API"），再看文案。文案匹配刻意保守（只认几个明确词），
 * 因为把"网络超时"误判成"不支持"会让用户去升级一个根本不需要升级的东西。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function looksLikeUnsupportedAction(error) {
  const e = /** @type {any} */ (error);
  const retcode = Number(e?.retcode ?? NaN);
  if (retcode === 1404 || retcode === 404 || retcode === -404) return true;

  const text = `${e?.message ?? ''} ${e?.wording ?? ''}`.toLowerCase();
  if (!text.trim()) return false;
  return /不支持|unknown action|unsupported|not implement|未实现|没有这个 ?api|invalid action/.test(text);
}

/**
 * 表情文件的落盘名。
 *
 * 用内容 sha256 而不是 emoji_id：同一张图可能被收藏两次（id 不同），
 * 按内容命名天然去重；而且 id 里可能有网关侧的奇怪字符，sha256 不会。
 *
 * @param {string} mime
 * @param {string} sha256
 * @returns {string}
 */
function faceFileName(mime, sha256) {
  const ext =
    mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'jpg';
  return `${sha256}.${ext}`;
}

/**
 * 从 `fetch_custom_face_detail` 的条目里挑出可用字段。
 *
 * 不同网关的字段名不完全一样（`emoji_id` / `resId` / `id`），
 * 这里统一成 `{ id, resId, md5, desc, url }`。**没有 id 的条目直接丢弃** ——
 * 没有稳定 id 就无法引用，留着只会让模型选到一个发不出去的条目。
 *
 * @param {unknown} raw
 * @returns {{id: string, resId: string, md5: string, desc: string, url: string} | null}
 */
export function normalizeFaceItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const one = /** @type {any} */ (raw);
  const id = String(one.emoji_id ?? one.resId ?? one.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    resId: String(one.resId ?? one.emoji_id ?? id).trim(),
    md5: String(one.md5 ?? '').trim().toUpperCase(),
    desc: String(one.desc ?? one.summary ?? '').trim().slice(0, 200),
    url: String(one.url ?? one.path ?? '').trim(),
  };
}

/**
 * 受控网关。
 *
 * 依赖全部注入：它不认识 PluginManager，也不知道 OneBot 客户端的具体类型。
 * 这样它能在纯 Node 下被测（不需要起机器人、不需要连 QQ）。
 */
export class GatewayBridge {
  /**
   * @param {object} opts
   * @param {(action: string, params?: object) => Promise<any>} opts.request
   *   发一个 OneBot 动作。失败时应 reject（或返回 `{status:'failed'}`）。
   * @param {(input: {convKey: string, messageId: unknown}) => {ok: boolean, event?: any, code?: string, message?: string}} opts.lookupMessage
   *   按 id 在**指定会话**里找消息（归属校验的唯一依据）
   * @param {(input: {convKey: string, segments: any[], auditText: string, signal?: AbortSignal}) => Promise<any>} opts.sendSegments
   *   唯一发送通路（白名单 + 出站审计 + 限流都在里面）
   * @param {(level: string, message: string, fields?: object) => void} [opts.log]
   * @param {() => number} [opts.now] 测试注入
   * @param {(input: {url: string, maxBytes: number, timeoutMs: number}) => Promise<{buffer: Buffer}>} [opts.fetchUrl]
   *   测试接缝：替换 URL 抓取（生产环境不传，走受控链路）
   */
  constructor(opts) {
    this.request = opts.request;
    this.lookupMessage = opts.lookupMessage;
    this.sendSegments = opts.sendSegments;
    this.log = opts.log ?? (() => {});
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.fetchUrl = opts.fetchUrl ?? null;

    /**
     * 发送串行器（per-conversation）。
     *
     * ## 为什么表情必须走这里
     *
     * AI 自己回的文本走 `reply/send.mjs` 的 sequencer，表情如果自己直发，
     * 就会出现：模型在一个回合里"先说话再发表情"，而两件事并发时
     * 表情可能先冒出来 —— 读起来像在抢话。
     *
     * 宿主传入的 `replySequencer` 是**同一个实例**，所以文字与表情
     * 天然按会话排队。没注入时退化成"直接发"（单测场景）。
     *
     * @type {{run: (key: string, fn: () => Promise<any>) => Promise<any>} | null}
     */
    this.sequencer = opts.sequencer ?? null;

    /**
     * 表情发送前的短暂停顿（毫秒）。
     *
     * 真人发表情不是"文字发完立刻跟一张图"，中间会有一两秒。这里只做
     * 一个很轻的随机延迟，让顺序看起来自然；它不是安全机制。
     */
    this.sendDelayMs = opts.sendDelayMs ?? [400, 1200];

    /** 新表情写入队列后的回调（用于让模型知道自己发过） */
    this.onFaceSent = typeof opts.onFaceSent === 'function' ? opts.onFaceSent : null;

    /**
     * 能力探测缓存。
     *
     * 形状：`{ probedAt, supported: {action: boolean}, reason }`
     * `supported[action] === undefined` 表示"没测出来"，与 `false` 严格区分。
     *
     * @type {{probedAt: number, supported: Record<string, boolean>, reason: string, listOk: boolean}}
     */
    this.caps = { probedAt: 0, supported: {}, reason: '', listOk: false };

    /** 上次探测是否成功拿到 `get_supported_actions` 的数组 */
    this.capsProbed = false;
  }

  /**
   * 主动探测网关支持哪些扩展动作。
   *
   * @param {{force?: boolean}} [input]
   * @returns {Promise<{ok: boolean, caps: object, message?: string}>}
   */
  async probe(input = {}) {
    const force = input?.force === true;
    const age = this.now() - this.caps.probedAt;
    if (!force && this.caps.probedAt > 0 && age >= 0 && age < CAP_TTL_MS) {
      return { ok: true, caps: this.capsView(), message: '' };
    }

    let actions = null;
    try {
      const data = await this.request('get_supported_actions', {});
      // 有的实现把数组放在 data / actions 里，有的直接返回数组
      if (Array.isArray(data)) actions = data;
      else if (Array.isArray(data?.actions)) actions = data.actions;
      else if (Array.isArray(data?.data)) actions = data.data;
    } catch (error) {
      /*
       * 探测本身失败**不改变**任何结论：三态仍是 unknown。
       *
       * 这里刻意不把 caps 清空：上一次成功探测的结论还有效，
       * 一次网络抖动不该让"已知支持"退回"不知道"。
       */
      this.caps.reason = `能力探测失败：${String(/** @type {any} */ (error)?.message ?? error)}`;
      this.log('debug', `[gateway] ${this.caps.reason}`);
      return { ok: false, caps: this.capsView(), message: this.caps.reason };
    }

    if (!actions) {
      /*
       * 网关没有实现 `get_supported_actions`（或者实现的形状不认识）。
       *
       * 这是**结果未知**，不是"不支持"：很多网关只是没实现这个元动作，
       * 但扩展动作本身是有的。所以保持 unknown，真正调用时再判。
       */
      this.caps.reason = '网关未返回可识别的动作列表（不代表不支持扩展动作）';
      this.caps.probedAt = this.now();
      this.log('debug', `[gateway] ${this.caps.reason}`);
      return { ok: true, caps: this.capsView(), message: this.caps.reason };
    }

    const set = new Set(actions.map((a) => String(a)));
    /** @type {Record<string, boolean>} */
    const supported = {};
    for (const action of Object.values(GATEWAY_ACTIONS)) supported[action] = set.has(action);

    this.caps = { probedAt: this.now(), supported, reason: '', listOk: true };
    this.capsProbed = true;
    this.log(
      'info',
      `[gateway] 能力探测：${Object.entries(supported)
        .map(([k, v]) => `${k}=${v ? '有' : '无'}`)
        .join(' / ')}`,
    );
    return { ok: true, caps: this.capsView(), message: '' };
  }

  /**
   * 给插件看的只读能力视图。
   *
   * 三态用字符串而不是布尔：`'unknown'` 必须能和 `'unsupported'` 区分开。
   *
   * @returns {{prober: string, fetchCustomFaceDetail: string, addCustomFace: string, modifyCustomFace: string, probedAt: number|null, reason: string}}
   */
  capsView() {
    const state = (action) => {
      const v = this.caps.supported[action];
      if (v === true) return 'supported';
      if (v === false) return 'unsupported';
      return 'unknown';
    };
    return {
      prober: this.capsProbed ? 'ok' : this.caps.probedAt > 0 ? 'failed' : 'unknown',
      fetchCustomFaceDetail: state(GATEWAY_ACTIONS.listFaces),
      addCustomFace: state(GATEWAY_ACTIONS.collectFace),
      modifyCustomFace: state(GATEWAY_ACTIONS.modifyFaceDesc),
      probedAt: this.caps.probedAt > 0 ? this.caps.probedAt : null,
      reason: this.caps.reason,
    };
  }

  /**
   * 一次动作调用，把"网关不认识这个动作"与"调用失败"分开报。
   *
   * @param {string} action
   * @param {object} params
   * @returns {Promise<{ok: true, data: any} | {ok: false, code: string, message: string}>}
   */
  async call(action, params) {
    /*
     * 已知不支持就别再发一次了。
     *
     * 不发这一步很重要：对一个明确不支持动作的网关反复请求，
     * 有的实现会开始回错误码或断开连接，症状是"用了一会儿就掉线"。
     */
    if (this.caps.supported[action] === false) {
      return gwFail('E_GATEWAY_UNSUPPORTED', `网关不支持 ${action}（能力探测结论）`);
    }

    let data;
    try {
      data = await this.request(action, params);
    } catch (error) {
      if (looksLikeUnsupportedAction(error)) {
        /*
         * 实测结论可以采信：把它记成不支持，后续调用直接短路。
         *
         * 但只降级"unknown → false"，不覆盖已有的 true —— 一次偶发的
         * 代理错误不该把"探测说有"的东西永久标成没有。
         */
        if (this.caps.supported[action] === undefined) this.caps.supported[action] = false;
        return gwFail('E_GATEWAY_UNSUPPORTED', `网关不支持 ${action}：${String(/** @type {any} */ (error)?.message ?? error)}`);
      }
      return gwFail('E_GATEWAY_UNAVAILABLE', `${action} 调用失败：${String(/** @type {any} */ (error)?.message ?? error)}`);
    }

    // 有些实现不 reject，而是回 `{status:'failed'}`。
    if (data && typeof data === 'object' && data.status === 'failed') {
      const wording = String(data.wording ?? data.message ?? '');
      if (looksLikeUnsupportedAction({ retcode: data.retcode, wording, message: wording })) {
        if (this.caps.supported[action] === undefined) this.caps.supported[action] = false;
        return gwFail('E_GATEWAY_UNSUPPORTED', `网关不支持 ${action}：${wording || data.retcode || 'unknown'}`);
      }
      return gwFail('E_GATEWAY_UNAVAILABLE', `${action} 失败：${wording || data.retcode || 'unknown'}`);
    }

    // 调用成功了：把 unknown 升成 supported（这是实测，比探测可靠）
    if (this.caps.supported[action] === undefined) this.caps.supported[action] = true;
    return { ok: true, data };
  }

  /**
   * 拉取账号的收藏表情。
   *
   * ## 只有拿到合法数组才算成功
   *
   * `data` 缺失 / 不是数组时返回 `E_GATEWAY_BAD_PAYLOAD`，**绝不**退化成空数组。
   * 空数组会让调用方以为"账号里一个表情都没有"，然后按"QQ 侧已清空"去删本地条目 ——
   * 一次网关版本不匹配就能把 AI 积累的备注全部清掉。
   *
   * ## `complete` 为什么是 `length < count`
   *
   * count 是"最多取几条"。拿满就等于"可能还有没返回的"，这时**不能**
   * 据此判定其他条目已被删除。少拿才算"这次拿到了全量"。
   *
   * @param {{count?: number}} [input]
   * @returns {Promise<{ok: true, complete: boolean, items: Array<object>, count: number} | {ok: false, code: string, message: string}>}
   */
  async listFaces(input = {}) {
    const countRaw = Number(input?.count);
    const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(MAX_LIST_COUNT, Math.trunc(countRaw))) : 100;

    const r = await this.call(GATEWAY_ACTIONS.listFaces, { count });
    if (!r.ok) return r;

    const raw = r.data;
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null;
    if (!list) {
      return gwFail(
        'E_GATEWAY_BAD_PAYLOAD',
        `${GATEWAY_ACTIONS.listFaces} 返回的 data 不是数组，已放弃同步（不清空本地库）`,
      );
    }

    /** @type {Array<object>} */
    const items = [];
    for (const one of list) {
      const item = normalizeFaceItem(one);
      if (item) items.push(item);
    }

    return {
      ok: true,
      // 拿满 count 时可能被截断；只有少拿才能证明是"全量"
      complete: list.length < count,
      items,
      count,
    };
  }

  /**
   * 下载一个表情的图片字节，落盘到插件 dataDir，并判定动图。
   *
   * ## 为什么缓存到磁盘
   *
   * 两个原因，都很具体：
   *   1. **发送时不必再抓一次**。QQ 的 CDN 链接有时效，一次对话里
   *      "先看再发"是常态，第二次抓很可能已经过期。
   *   2. **模型看到的是同一份字节**。如果发送时重新下载，可能出现
   *      "AI 看到的图和真正发出去的图不是同一张"（CDN 缓存换了版本）。
   *
   * ## `tooLarge` 是一个正常结果，不是失败
   *
   * 识别有字节预算（base64 膨胀后要塞进工具返回值），但**发送没有**。
   * 所以大图照常落盘并返回 `file`，只是 `dataUrl` 为空 —— 让调用方
   * 能发、但不能"假装看过"。
   *
   * @param {object} input
   * @param {string} input.dir 插件数据目录（绝对路径）
   * @param {{id?: string, resId?: string, md5?: string, url?: string}} input.ref
   * @param {number} [input.maxBytes] 识别预算（不是下载上限）
   * @param {AbortSignal} [input.signal]
   * @returns {Promise<object>}
   */
  async fetchFaceImage(input) {
    const dir = String(input?.dir ?? '');
    if (!dir) return gwFail('E4071', '宿主未配置插件数据目录');

    const ref = input?.ref && typeof input.ref === 'object' ? input.ref : {};
    const url = String(ref.url ?? '').trim();
    if (!url) {
      /*
       * 没有 URL 就没法取字节。
       *
       * 这里报的是"这条记录没有地址"，不是网关不支持：收藏列表里的
       * 条目理论上有 url，但有的实现只给 emoji_id（图片要另外查）。
       * 分开报能让用户知道该去升级网关还是该刷新列表。
       */
      return gwFail('E_STICKER_NO_IMAGE_URL', `表情 ${String(ref.id ?? '')} 没有可用的图片地址`);
    }

    if (!/^https?:\/\//i.test(url)) {
      // 非 http(s) 的地址一律拒绝：file:// / data: 都是绕过受控链路的入口
      return gwFail('E_STICKER_NO_IMAGE_URL', '表情的图片地址不是 http(s)，已拒绝取图');
    }

    let buffer;
    try {
      const got = await withAbort(
        this.fetchUrl
          ? this.fetchUrl({ url, maxBytes: FACE_FETCH_LIMITS.hardMaxBytes, timeoutMs: FACE_FETCH_LIMITS.timeoutMs })
          : safeFetchBuffer(url, {
              maxBytes: FACE_FETCH_LIMITS.hardMaxBytes,
              timeoutMs: FACE_FETCH_LIMITS.timeoutMs,
            }),
        input?.signal,
      );
      buffer = Buffer.isBuffer(got?.buffer) ? got.buffer : Buffer.from(got?.buffer ?? []);
    } catch (error) {
      const e = /** @type {any} */ (error);
      if (e?.code === 'E4070') return gwFail('E4070', '调用已取消');
      return gwFail('E_STICKER_FETCH_FAILED', `取表情图片失败：${String(e?.message ?? e)}`);
    }
    if (!buffer.length) return gwFail('E_STICKER_FETCH_FAILED', '取到的图片是空字节');

    const mime = sniffMime(buffer);
    if (!mime) {
      return gwFail('E_STICKER_FETCH_FAILED', '取到的内容不是 PNG/JPEG/GIF/WebP（按魔数判定）');
    }
    const dims = imageDimensions(buffer);
    const pixels = (Number(dims?.width) || 0) * (Number(dims?.height) || 0);
    if (pixels > FACE_FETCH_LIMITS.maxPixels) {
      return gwFail('E_STICKER_FETCH_FAILED', `表情像素超限（${dims.width}×${dims.height}）`);
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = path.posix.join(FACES_DIR, faceFileName(mime, sha256));

    // 落盘：先 resolve 再校验边界，防 `..` 与符号链接（目录是我们建的，仍然验一次）
    const facesDir = path.resolve(dir, FACES_DIR);
    const abs = path.resolve(dir, file);
    if (abs !== facesDir && !abs.startsWith(facesDir + path.sep)) {
      return gwFail('E4075', '表情缓存路径越界');
    }
    try {
      await fs.mkdir(facesDir, { recursive: true });
      // 同 sha256 已存在就是同一份字节，读一次的大小写反而更慢
      const exists = await fs
        .stat(abs)
        .then((st) => st.isFile())
        .catch(() => false);
      if (!exists) await writeFileAtomic(abs, buffer);
    } catch (error) {
      return gwFail('E_STICKER_FETCH_FAILED', `表情缓存写入失败：${String(/** @type {any} */ (error)?.message ?? error)}`);
    }

    const maxBytesRaw = Number(input?.maxBytes);
    /*
     * 识别预算被夹在 **4096..131072** 之间（docs/stickers-contract.md §1.3）。
     *
     * 上界不是随手取的：`dataUrl` 是 base64，会膨胀 4/3，而工具返回值整体
     * 不得超 256KB（runtime-inprocess 的 MAX_RESULT_BYTES）。按 128KB 夹住之后
     * 最坏是 ~175KB 的 base64，仍在预算内；夹到 4MB（下载硬顶）就会让
     * 一次取图把返回值撞爆、整次调用变成 E4066 —— 症状是"插件偶尔坏掉"。
     *
     * 下界 4KB 与配置项 `maxImageBytes` 的 min 一致：更小的预算等于"永远
     * 看不到图"，那不该是调用方能要到的东西。
     */
    const maxBytes = Number.isFinite(maxBytesRaw)
      ? Math.max(4096, Math.min(131072, Math.trunc(maxBytesRaw)))
      : 96 * 1024;
    const tooLarge = buffer.length > maxBytes;

    return {
      ok: true,
      bytes: buffer.length,
      sha256,
      mime,
      width: Number(dims?.width) || 0,
      height: Number(dims?.height) || 0,
      animated: isAnimatedImage(buffer),
      file,
      // 超预算时不返回 base64：它进不了模型，只进返回值就把 256KB 上限撞爆了
      dataUrl: tooLarge ? '' : `data:${mime};base64,${buffer.toString('base64')}`,
      tooLarge,
    };
  }

  /**
   * 把当前会话里的一条消息图片收藏进 QQ 账号。
   *
   * ## 归属与"不能收藏自己"都在这里判
   *
   * 插件传来的只有 `messageId`。它属于哪个会话由 `ctx.caller.convKey` 决定，
   * 而且是**先查归属再取字节**：一个不属于当前会话的 id 连图片都拿不到。
   *
   * 查不到一律报 `E4074`（不区分"不存在"与"在别的会话"）——
   * 区分了就等于给了一个跨会话探测原语。
   *
   * @param {object} input
   * @param {string} input.convKey 宿主给的会话（插件拿不到，也不能传）
   * @param {unknown} input.messageId
   * @param {number} [input.index] 同一条消息里的第几个图片段（0 起）
   * @param {string} [input.desc] 收藏后写进 QQ 备注的短句
   * @param {string} [input.selfId] 机器人自己的 QQ 号（判"收藏自己"）
   * @param {AbortSignal} [input.signal]
   * @returns {Promise<object>}
   */
  async collectFace(input) {
    const convKey = String(input?.convKey ?? '');
    const messageId = input?.messageId;
    if (messageId === undefined || messageId === null || String(messageId).trim() === '') {
      return gwFail('E4073', '需要 messageId');
    }

    const hit = this.lookupMessage({ convKey, messageId });
    if (!hit?.ok) {
      return gwFail('E4074', '该消息不存在或不属于当前会话');
    }

    const evt = hit.event ?? {};
    const senderId = String(evt?.sender?.userId ?? evt?.sender?.id ?? evt?.userId ?? '');
    const selfId = String(input?.selfId ?? '').trim();
    if (selfId && senderId && senderId === selfId) {
      return gwFail('E_STICKER_SELF_COLLECT', '不能收藏自己发的表情，只能收藏别人发的');
    }

    // 只认图片段；face 段没有字节，mface 是商城表情（不同概念）
    const segs = Array.isArray(evt?.segments) ? evt.segments : [];
    const images = segs.filter((s) => s?.type === 'image');
    if (images.length === 0) {
      return gwFail('E_STICKER_NO_IMAGE', '这条消息里没有可收藏的图片');
    }
    const idxRaw = Number(input?.index);
    const idx = Number.isFinite(idxRaw) ? Math.max(0, Math.min(images.length - 1, Math.trunc(idxRaw))) : 0;
    const seg = images[idx];

    /*
     * 取字节走**宿主自己的受控链路**，而不是把消息里的 URL 交给网关去下载。
     *
     * 那条路有两个问题：网关会绕过 SSRF 防护（它替我们发请求），
     * 而且消息段里的 `file` 可能是本机路径 —— 交给网关等于让它读我们磁盘。
     */
    const got = await this.imageBytesFromSegment(seg, input?.signal);
    if (!got.ok) return got;

    const add = await this.call(GATEWAY_ACTIONS.collectFace, { file: `base64://${got.buffer.toString('base64')}` });
    if (!add.ok) return add;

    const payload = add.data ?? {};
    const emojiId = String(payload?.emoji_id ?? payload?.emojiId ?? payload?.resId ?? payload?.data?.emoji_id ?? '').trim();
    if (!emojiId) {
      /*
       * 收藏"成功"了但没给 id：不能当成成功。
       *
       * 没有 id 的条目在列表里对不上、也没法引用，等于收了一个不知道是什么的东西。
       * 报出来让上层决定，比默默写一条脏记录好。
       */
      return gwFail('E_STICKER_COLLECT_NO_ID', '网关收藏成功但未返回 emoji_id，无法确认收藏结果');
    }

    const desc = String(input?.desc ?? '').trim().slice(0, 50);
    let warning = '';
    if (desc) {
      const mod = await this.call(GATEWAY_ACTIONS.modifyFaceDesc, { emoji_id: emojiId, desc });
      if (!mod.ok) {
        /*
         * 备注失败不影响收藏成功。
         *
         * 这是真实会发生的：有的网关支持 add 不支持 modify。把整次收藏
         * 判成失败会让用户重试，而重试会再收藏一张重复的图。
         */
        warning = `已收藏，但写入 QQ 备注失败（${mod.code}）：${mod.message}`;
        this.log('warn', `[gateway] ${warning}`);
      }
    }

    return {
      ok: true,
      emojiId,
      desc,
      sha256: got.sha256,
      md5: got.md5,
      mime: got.mime,
      animated: got.animated,
      viaQqAccount: true,
      warning,
    };
  }

  /**
   * 从一条消息段里取图片字节（受控链路）。
   *
   * 与 `llm/image-fetch.mjs` 的 `fetchImage` 不同：那是给"会话里的图"用的，
   * 输入是 MediaRef；这里输入是 OneBot 段。两者最终都收在 `safeFetchBuffer`
   * / `get_image` 上，没有第二套下载实现。
   *
   * @param {object} seg
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: true, buffer: Buffer, sha256: string, md5: string, mime: string, animated: boolean} | {ok: false, code: string, message: string}>}
   */
  async imageBytesFromSegment(seg, signal) {
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};

    /** @type {Buffer | null} */
    let buffer = null;

    // 1) 段里直接内联的 base64（`base64://` / `data:`）——不需要任何网络访问
    const inline = data?.base64 ?? data?.file;
    if (typeof inline === 'string' && (inline.startsWith('base64://') || inline.startsWith('data:'))) {
      const b64 = inline.startsWith('base64://')
        ? inline.slice('base64://'.length)
        : inline.slice(inline.indexOf(',') + 1);
      const estimated = Math.floor((b64.replace(/\s/g, '').length * 3) / 4);
      if (estimated > FACE_FETCH_LIMITS.hardMaxBytes) {
        return gwFail('E_STICKER_FETCH_FAILED', `内联图片过大（约 ${estimated} 字节）`);
      }
      buffer = Buffer.from(b64, 'base64');
    }

    // 2) 段里的 URL：走受控下载
    if (!buffer && typeof data?.url === 'string' && /^https?:\/\//i.test(data.url)) {
      try {
        const got = await withAbort(
          this.fetchUrl
            ? this.fetchUrl({ url: data.url, maxBytes: FACE_FETCH_LIMITS.hardMaxBytes, timeoutMs: FACE_FETCH_LIMITS.timeoutMs })
            : safeFetchBuffer(data.url, {
                maxBytes: FACE_FETCH_LIMITS.hardMaxBytes,
                timeoutMs: FACE_FETCH_LIMITS.timeoutMs,
              }),
          signal,
        );
        buffer = Buffer.isBuffer(got?.buffer) ? got.buffer : Buffer.from(got?.buffer ?? []);
      } catch (error) {
        const e = /** @type {any} */ (error);
        if (e?.code === 'E4070') return gwFail('E4070', '调用已取消');
        return gwFail('E_STICKER_FETCH_FAILED', `取消息图片失败：${String(e?.message ?? e)}`);
      }
    }

    /*
     * 3) 最后才试网关的 get_image（缓存名）。
     *
     * 放在最后是因为它只认"安全缓存名"，而缓存名缺失是常态（重启后、
     * 别的会话转发过来的消息）。但它也是最可靠的一跳：字节直接来自网关缓存，
     * 不受 CDN 鉴权过期影响。
     */
    if (!buffer && typeof data?.file === 'string' && !/[/\\:]/.test(data.file)) {
      try {
        const info = await this.request('get_image', { file: data.file });
        const b64 = typeof info?.base64 === 'string' ? info.base64 : typeof info?.data === 'string' ? info.data : '';
        if (b64) {
          const estimated = Math.floor((b64.length * 3) / 4);
          if (estimated > FACE_FETCH_LIMITS.hardMaxBytes) {
            return gwFail('E_STICKER_FETCH_FAILED', `图片过大（约 ${estimated} 字节）`);
          }
          buffer = Buffer.from(b64, 'base64');
        }
      } catch {
        // 取不到就算了：上面两条路都失败时才走到这里，报错已经在下面统一给
      }
    }

    if (!buffer || !buffer.length) {
      return gwFail('E_STICKER_FETCH_FAILED', '无法安全获取该图片的字节，已拒绝收藏');
    }
    if (buffer.length > FACE_FETCH_LIMITS.hardMaxBytes) {
      return gwFail('E_STICKER_FETCH_FAILED', `图片超过 ${FACE_FETCH_LIMITS.hardMaxBytes} 字节上限`);
    }

    const mime = sniffMime(buffer);
    if (!mime) return gwFail('E_STICKER_FETCH_FAILED', '该图片不是 PNG/JPEG/GIF/WebP（按魔数判定）');

    return {
      ok: true,
      buffer,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      md5: crypto.createHash('md5').update(buffer).digest('hex').toUpperCase(),
      mime,
      animated: isAnimatedImage(buffer),
    };
  }

  /**
   * 发送一个表情（一个气泡，只有一张图，不带文字）。
   *
   * ## 为什么文字与表情必须分开
   *
   * QQ 的一条消息里，"图 + 文"会显示成一个带说明的气泡，而真人发表情时
   * 通常只发图。更重要的是：混在一起之后，"我要引用的人"和"我要发的图"
   * 会绑死在同一段里，模型很难只改其中一个。
   *
   * ## 为什么必须走 sendSegments
   *
   * 那是**唯一**的发送通路（I4）。插件发的每一条消息都要过白名单、
   * 出站审计、限流，和 AI 自己发的没有区别。这里不实现任何判定，
   * 只负责把句柄换成段然后转交。
   *
   * @param {object} input
   * @param {string} input.convKey
   * @param {string} input.dir 插件数据目录
   * @param {string} input.file 相对路径（faces/...）
   * @param {string} [input.label] 审计用的文本（不含路径）
   * @param {unknown} [input.replyToMessageId]
   * @param {unknown} [input.atUserId]
   * @param {AbortSignal} [input.signal]
   * @returns {Promise<object>}
   */
  async sendFace(input) {
    const convKey = String(input?.convKey ?? '');
    const dir = String(input?.dir ?? '');
    const rel = String(input?.file ?? '').trim();
    if (!rel) return gwFail('E4073', '需要表情文件');
    if (!dir) return gwFail('E4071', '宿主未配置插件数据目录');

    /*
     * 路径校验分三步（与 chat-bridge 的 registerMedia 同一套）：
     * resolve 后必须在 faces/ 内、realpath 后再验一次（防符号链接）、必须是普通文件。
     *
     * 第一步（纯 `path.resolve`，**同步**）在这里做：它便宜，而且能让
     * "明显越界"在入队之前就被拒掉。
     *
     * ## 为什么入队要尽可能早
     *
     * 队列保证的是"**入队顺序** = 落地顺序"。如果实现在入队之前先 await
     * 几次文件 IO，那么同一个回合里并发到达的调用就可能被后到者插队 ——
     * 表现是"文字明明先发，表情却冒在了前面"。
     *
     * 所以：同步能判的判完**立刻入队**，异步的部分（realpath / stat /
     * 停顿 / 闸门）全部放进队列里执行。文件校验很快，占住队列的时间可以忽略。
     */
    const facesDir = path.resolve(dir, FACES_DIR);
    const abs = path.resolve(dir, rel);
    if (abs !== facesDir && !abs.startsWith(facesDir + path.sep)) {
      return gwFail('E4075', '只能发送插件自己缓存目录里的表情');
    }

    /**
     * 队列里执行的那一段：校验文件 → 组段 → 停顿 → 过闸门发送。
     *
     * @returns {Promise<object>}
     */
    const run = async () => {
      if (input?.signal?.aborted) return gwFail('E4070', '调用已取消');

      let real;
      try {
        real = await fs.realpath(abs);
      } catch {
        return gwFail('E_STICKER_NOT_FOUND', '表情文件不存在或已被清理，请重新取一次图片');
      }
      if (!real.startsWith(facesDir + path.sep)) {
        return gwFail('E4075', '表情文件实际指向缓存目录之外（符号链接）');
      }
      let st;
      try {
        st = await fs.stat(real);
      } catch {
        return gwFail('E_STICKER_NOT_FOUND', '表情文件不存在或已被清理，请重新取一次图片');
      }
      if (!st.isFile()) return gwFail('E4073', '不是一个文件');
      if (st.size > FACE_FETCH_LIMITS.hardMaxBytes) {
        return gwFail('E4073', `表情文件过大（${Math.round(st.size / 1024)}KB）`);
      }

      /** @type {any[]} */
      const segments = [];

      const replyTo = input?.replyToMessageId;
      if (replyTo !== undefined && replyTo !== null && String(replyTo).trim() !== '') {
        const rid = String(replyTo).trim();
        if (!/^-?[1-9]\d*$/.test(rid)) return gwFail('E4073', 'replyToMessageId 必须是非零整数');
        // 引用必须属于当前会话：否则"引用别处的消息"就是跨会话钓鱼
        const hit = this.lookupMessage({ convKey, messageId: rid });
        if (!hit?.ok) return gwFail('E4074', '引用的消息不存在或不属于当前会话');
        segments.push({ type: 'reply', data: { id: rid } });
      }

      const at = input?.atUserId;
      if (at !== undefined && at !== null && String(at).trim() !== '') {
        if (!convKey.startsWith('group:')) return gwFail('E_STICKER_TARGET_NOT_GROUP', '私聊里不能 @ 人');
        const qq = String(at).trim();
        if (!/^\d+$/.test(qq)) return gwFail('E4073', 'atUserId 必须是正整数 QQ 号');
        segments.push({ type: 'at', data: { qq } });
      }

      /*
       * 图片用本机绝对路径，而不是 base64。
       *
       * OneBot 的 image 段接受本机路径；用 base64 会让一条消息的报文
       * 膨胀到几 MB，经过 WebSocket 时更容易被网关拒收。
       * 路径是我们自己刚校验过的（在插件缓存目录内）。
       */
      segments.push({ type: 'image', data: { file: real } });

      const label = `[表情] ${String(input?.label ?? '').trim()}`.trim();

      /*
       * 停顿放在**闸门之前**：如果先过闸门再等，限流计数会在
       * "还没发出去"的时候就被扣掉，排队中的那条一旦被取消，
       * 额度就白花了。
       *
       * 真人发表情不是"文字发完立刻跟一张图"，中间会有一两秒。
       */
      await sleep(this.#pickDelay());
      if (input?.signal?.aborted) return gwFail('E4070', '调用已取消');

      try {
        const r = await this.sendSegments({ convKey, segments, auditText: label, signal: input?.signal });
        if (!r?.ok) {
          // 闸门拒绝原样返回：让插件能把"被限流"这种可恢复信息交给模型
          return gwFail(r?.code ?? 'E2020', r?.message ?? '发送被拒绝');
        }
        /*
         * 记账交给宿主：`pushRecent` 让模型下一轮知道自己发过。
         *
         * 为什么不在插件里记：插件的库是"账号级"的，而"这条会话里
         * 它刚刚发过一张表情"是**会话级**事实，属于宿主的上下文。
         * 记错地方会让 A 群的表情出现在 B 群的上下文里。
         */
        try {
          this.onFaceSent?.({ convKey, messageId: r.messageId ?? null, file: rel });
        } catch {
          /* 记账失败不影响已发送的事实 */
        }
        return { ok: true, messageId: r.messageId ?? null, bubbles: 1 };
      } catch (error) {
        const e = /** @type {any} */ (error);
        return gwFail(e?.code ?? 'E50XX', String(e?.message ?? e));
      }
    };

    // 与文本共用同一队列：先文字后表情的顺序不会被并发调用打乱
    if (this.sequencer) return this.sequencer.run(convKey, run);
    return run();
  }

  /**
   * 本次发送前的停顿（毫秒）。
   *
   * @returns {number}
   */
  #pickDelay() {
    const [lo, hi] = Array.isArray(this.sendDelayMs) ? this.sendDelayMs : [0, 0];
    const a = Math.max(0, Number(lo) || 0);
    const b = Math.max(a, Number(hi) || 0);
    if (b === 0) return 0;
    return a + Math.floor(Math.random() * (b - a + 1));
  }
}

/**
 * 等待若干毫秒。
 *
 * 单独抽出来是为了测试能注入一个立即返回的实现 —— 否则每测一次发送
 * 就要真睡一秒，测试会慢到没人愿意跑。
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    // unref：被取消的等待不能让进程一直挂着
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 创建网关能力工厂 —— 每次工具调用产出**一份** `ctx.gateway`。
 *
 * ## 为什么是工厂而不是单例
 *
 * `ctx.gateway.sendFace` 和 `ctx.gateway.collectFace` 都必须绑定
 * 「这次调用在哪个会话、哪个插件的 dataDir、用哪个取消信号」。
 *
 * 做成单例就必须在调用时往里写"当前会话"，而两个调用同时发生时
 * 后一个会覆盖前一个 —— 症状是"表情偶尔发到别的群"，且极难复现。
 * 这与 `host-chat.mjs` 里 `ctx.chat` 的理由完全一样。
 *
 * 探测结论（caps）反而是**共享**的：它是账号级事实，每个插件各探一遍
 * 既浪费一次往返，也会出现"A 插件说支持、B 插件说不支持"的分裂。
 *
 * @param {object} opts
 * @param {(action: string, params?: object) => Promise<any>} opts.request
 * @param {(input: {convKey: string, messageId: unknown}) => object} opts.lookupMessage
 * @param {(input: object) => Promise<any>} opts.sendSegments
 * @param {() => string} [opts.getSelfId] 机器人自己的 QQ 号（判"收藏自己"）
 * @param {() => {enabled: boolean, supported: boolean|null}} [opts.getVision]
 * @param {(level: string, message: string, fields?: object) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {(input: object) => Promise<{buffer: Buffer}>} [opts.fetchUrl] 测试接缝
 * @returns {{bridge: GatewayBridge, makeGateway: (input: object) => object}}
 */
export function createGatewayFactory(opts) {
  const bridge = new GatewayBridge({
    request: opts.request,
    lookupMessage: opts.lookupMessage,
    sendSegments: opts.sendSegments,
    log: opts.log,
    now: opts.now,
    fetchUrl: opts.fetchUrl,
    sequencer: opts.sequencer ?? null,
    sendDelayMs: opts.sendDelayMs,
    onFaceSent: opts.onFaceSent,
  });

  const getSelfId = typeof opts.getSelfId === 'function' ? opts.getSelfId : () => '';
  /*
   * 默认**不声明**视觉事实（`known: false`），而不是假装"视觉关着"。
   *
   * 假装关着会让插件对用户说"我没看过这张图"，而事实可能是开着的 ——
   * 那是一个具体的、指向错误方向的谎。
   */
  const getVision = typeof opts.getVision === 'function' ? opts.getVision : null;

  /**
   * @param {object} input
   * @param {string} input.convKey 本次调用所在会话（宿主给，插件改不动）
   * @param {string} [input.dataDir] 插件私有数据目录
   * @param {AbortSignal} [input.signal]
   * @returns {object}
   */
  function makeGateway(input) {
    const convKey = String(input?.convKey ?? '');
    const dataDir = String(input?.dataDir ?? '');
    const signal = input?.signal;

    /*
     * 没有会话就没有"当前会话里的消息"。
     *
     * 这与 `ctx.chat` 的处理一致：能力在这里就是不可用的，而不是
     * 给一个空会话去读。`available` 保持 true（网关本身是通的），
     * 每个动作单独返回 E4074 —— 让插件看到的是"没有会话上下文"
     * 而不是"宿主没装这个能力"。
     */
    const precheck = () => {
      if (signal?.aborted) return gwFail('E4070', '调用已取消');
      return null;
    };

    return {
      /** 宿主确实注入了这个能力（区分"没注入"与"网关没连上"） */
      available: true,

      /** 本次调用能看到的视觉事实（只读，不构成授权） */
      get vision() {
        /*
         * 事实由宿主注入；没注入时给"未知"（`known: false`），而不是假装
         * "视觉关着" —— 后者会让插件对用户说一句具体的谎。形状定义收在
         * gateway-vision.mjs 里，子进程侧的默认值与它共用同一份。
         */
        return gatewayVisionView(getVision);
      },

      caps() {
        return bridge.capsView();
      },

      async probe(input2 = {}) {
        const pre = precheck();
        if (pre) return pre;
        return bridge.probe({ force: input2?.force === true });
      },

      async listFaces(input2 = {}) {
        const pre = precheck();
        if (pre) return pre;
        return bridge.listFaces({ count: input2?.count });
      },

      async fetchFaceImage(input2 = {}) {
        const pre = precheck();
        if (pre) return pre;
        if (!dataDir) return gwFail('E4071', '宿主未配置插件数据目录');
        return bridge.fetchFaceImage({
          dir: dataDir,
          ref: input2?.ref,
          maxBytes: input2?.maxBytes,
          signal,
        });
      },

      async collectFace(input2 = {}) {
        const pre = precheck();
        if (pre) return pre;
        if (!convKey) return gwFail('E4074', '本次调用没有合法会话，无法收藏');
        return bridge.collectFace({
          convKey,
          messageId: input2?.messageId,
          index: input2?.index,
          desc: input2?.desc,
          selfId: getSelfId(),
          signal,
        });
      },

      async sendFace(input2 = {}) {
        const pre = precheck();
        if (pre) return pre;
        if (!convKey) return gwFail('E4074', '本次调用没有合法会话，无法发送');
        if (!dataDir) return gwFail('E4071', '宿主未配置插件数据目录');
        return bridge.sendFace({
          convKey,
          dir: dataDir,
          file: input2?.file,
          label: input2?.label,
          replyToMessageId: input2?.replyToMessageId,
          atUserId: input2?.atUserId,
          signal,
        });
      },
    };
  }

  return { bridge, makeGateway };
}

/**
 * 宿主没注入网关能力时的占位对象。
 *
 * 每个方法都返回同一个明确的错误，而不是 `undefined`：
 * 插件调用一个不存在的方法会抛 TypeError，那个异常会被包成 E4066
 * （"执行异常"），而真实原因是"宿主没提供这个能力" —— 排查方向完全不同。
 *
 * 形状与正常实现保持一致（`caps()` / `vision` 属性都在），
 * 否则插件读 `ctx.gateway.vision.enabled` 会先炸在 undefined 上。
 *
 * @param {string} message
 * @returns {object}
 */
export function unavailableGateway(message) {
  const err = () => ({ ok: false, code: 'E4072', message });
  return {
    available: false,
    // 宿主没提供这个能力 = 它不知道视觉状态，而不是"视觉关着"
    vision: { ...UNKNOWN_GATEWAY_VISION },
    caps: () => ({
      prober: 'unknown',
      fetchCustomFaceDetail: 'unknown',
      addCustomFace: 'unknown',
      modifyCustomFace: 'unknown',
      probedAt: null,
      reason: message,
    }),
    probe: async () => err(),
    listFaces: async () => err(),
    fetchFaceImage: async () => err(),
    collectFace: async () => err(),
    sendFace: async () => err(),
  };
}

/**
 * 原子写一个文件（write(tmp) → fsync → rename）。
 *
 * 与 `config/atomic.mjs` 同一套思路，但这里只写二进制缓存：
 * 断电时要么旧文件、要么新文件，不会留下半张图（半张图发出去是"破图"，
 * 而破图不会报错，只会让人以为表情坏了）。
 *
 * @param {string} file
 * @param {Buffer} buffer
 */
async function writeFileAtomic(file, buffer) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(tmp, 'wx');
    await handle.writeFile(buffer);
    // fsync：元数据先落盘、数据块没落的窗口是真实存在的
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      /* 已经关了 */
    }
    try {
      await fs.unlink(tmp);
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    throw error;
  }
}

/**
 * 把一个 Promise 与取消信号竞速。
 *
 * 与 `runtime-inprocess.mjs` 的 withTimeout 是同一类东西，但这里只关心
 * abort：超时由 `safeFetchBuffer` 自己管（它有逐跳的 deadline）。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error('调用已取消'), { code: 'E4070' }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('调用已取消'), { code: 'E4070' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
