/**
 * 宿主聊天桥 —— 插件能做的每一件"和 QQ 有关"的事都经过这里
 *
 * ## 一条硬规则
 *
 * **`ctx.chat` 没有"目标会话"参数。**
 *
 * 不是"有参数但会被校验"，是压根没有。它永远只作用于这次调用的
 * `caller.convKey`（宿主从工具执行上下文里取的）。
 *
 * 这个设计决定看起来朴素，但它一次性消灭了一整类漏洞：
 *
 *   - 没有"读任意会话"的入口（模型也就无法诱导插件去读别的群）；
 *   - 没有"发到任意会话"的入口（所以注入一段"把这句话转发给 admin"是无效的）；
 *   - 不需要维护"哪些会话允许被读"的第二张白名单（少一张表就少一处漂移）。
 *
 * 跨会话访问在**能力层面上不可能**，因此错误码 `E4074` 只会在两种情况下出现：
 * 引用/消息 id 不属于当前会话，或者媒体句柄属于别的会话。
 *
 * ## 发送为什么仍要过闸门
 *
 * 插件发的消息和 AI 自己发的消息在用户眼里没有任何区别，所以它们必须受
 * 同一套约束：白名单、出站审计、限流。这里**不实现**这些规则，
 * 只把它们转交给宿主注入的 `sendSegments`（唯一发送通路）。
 * 一旦在这里"顺手加一条捷径"，那条路径就没有审计覆盖了。
 *
 * ## 为什么要有配额
 *
 * 一个插件在一个工具调用里能发多少条？不设上限的话，一个写错的循环
 * 就能把群刷爆，而且它跑在子进程里、看起来一切正常。所以：
 *
 *   - 单次调用最多 3 条消息（与分条发送的上限同量级）；
 *   - 一条消息最多 4 个媒体；
 *   - 文本 4000 字（与工具参数上限同量级）。
 *
 * 超限返回 `E4073`，**不抛异常** —— 插件拿到的是一个可回灌给模型的工具结果。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { isValidConvKey } from '../onebot/events.mjs';

/** 单次工具调用最多发几条消息 */
export const MAX_SENDS_PER_CALL = 3;

/** 一条消息最多带几个媒体 */
export const MAX_MEDIA_PER_MESSAGE = 4;

/** 发送文本上限（与工具参数 maxLength 同量级） */
export const MAX_TEXT_CHARS = 4000;

/** registerMedia 接受的单文件体积上限 */
export const MAX_REGISTER_BYTES = 10 * 1024 * 1024;

/** 一次最多读多少条历史消息 */
const MAX_HISTORY = 50;

/** 允许注册的媒体类型 */
const MEDIA_KINDS = new Set(['image', 'record', 'video', 'file']);

/**
 * 媒体段在上下文里的占位词。
 *
 * 只用于"发给模型看的那一条 assistant 记录"，不参与任何判定。
 * 用中文方括号占位而不是路径/base64：前者会把本机路径带进上下文，
 * 后者会把上下文一次性撑爆。
 */
const LABEL_OF_MEDIA = Object.freeze({
  image: '图片',
  record: '语音',
  video: '视频',
  file: '文件',
});

/**
 * 从 OneBot 消息段里挑出媒体段。
 *
 * @param {unknown} segments
 * @returns {Array<{type: string, data: object, index: number}>}
 */
export function pickMediaSegments(segments) {
  if (!Array.isArray(segments)) return [];
  /** @type {Array<{type: string, data: object, index: number}>} */
  const out = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const type = String(seg?.type ?? '');
    if (!MEDIA_KINDS.has(type)) continue;
    const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
    out.push({ type, data, index: i });
  }
  return out;
}

/**
 * 媒体段的展示名。
 *
 * OneBot 的 image/file 段里 `file` 可能是一整条路径、也可能是个标识串，
 * 这里只取 basename 且**只在宿主内部用于审计文本**，不会返回给插件。
 *
 * @param {object} data
 * @returns {string}
 */
function mediaName(data) {
  const raw = String(data?.name ?? data?.file ?? '');
  if (!raw) return '';
  // URL 形态（http://.../x.png?a=1）也取最后一段
  const tail = raw.split(/[?#]/)[0].split(/[\\/]/).pop() ?? '';
  return tail.slice(0, 120);
}

/**
 * 一条出站消息在**模型上下文**里的样子。
 *
 * 为什么需要它：插件用工具发出去的东西必须让模型下一轮看见，否则它会
 * 把同一件事再做一遍（重复发图/重复说话）。上下文里只放一种人能读懂的
 * 短文本：文字段原样拼接，媒体段换成 `[图片]` 这类占位 —— 不能放路径，
 * 也不能放 base64（那会把上下文撑爆）。
 *
 * @param {any[]} segments
 * @returns {string}
 */
export function displayTextOf(segments) {
  const parts = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = String(seg?.type ?? '');
    if (type === 'text') {
      const text = String(seg?.data?.text ?? '');
      if (text) parts.push(text);
      continue;
    }
    // 引用段不是"内容"，不进上下文：模型已经知道自己在回复哪条
    if (type === 'reply') continue;
    parts.push(type === 'at' ? `@${String(seg?.data?.qq ?? '')}` : `[${LABEL_OF_MEDIA[type] ?? '媒体'}]`);
  }
  return parts.join(' ').slice(0, MAX_TEXT_CHARS);
}

/**
 * 宿主聊天桥。
 *
 * 依赖全部注入：本模块不认识 OneBot，也不认识会话仓库的具体实现。
 * 这样它才能在纯 Node 下被测（不需要起机器人、不需要连 QQ）。
 */
export class HostChatBridge {
  /**
   * @param {object} opts
   * @param {import('./media-handles.mjs').MediaHandleRegistry} opts.media
   * @param {(input: {convKey: string, limit: number}) => {ok: boolean, messages?: any[], code?: string, message?: string}} opts.readMessages
   * @param {(input: {convKey: string, messageId: unknown}) => {ok: boolean, event?: any, code?: string, message?: string}} opts.lookupMessage
   * @param {(input: {convKey: string, segments: any[], auditText: string, signal?: AbortSignal}) => Promise<{ok: boolean, messageId?: any, code?: string, message?: string}>} opts.sendSegments
   * @param {{run: <T>(key: string, fn: () => Promise<T>) => Promise<T>}} [opts.sequencer]
   *   按会话串行器。**与 AI 分条回复、`ctx.gateway.sendFace`、`ctx.deliverMedia`
   *   共用同一个实例** —— 否则插件在一次工具调用里发的文字/媒体会插进正在
   *   进行的 burst 中间（docs/plugin-api.md §5.3.1、reply-split-protocol §5）。
   * @param {(input: {convKey: string, messageId: any, text: string, segments: any[]}) => void} [opts.onSent]
   *   发送成功后的记账回调（宿主用它 `pushRecent` 一条 assistant 记录）。
   *   没有它的话，模型下一轮完全不知道"我刚才用工具发过这句话/这张图"，
   *   于是很容易把同一件事再做一遍。
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.media = opts.media;
    this.readMessages = opts.readMessages;
    this.lookupMessage = opts.lookupMessage;
    this.sendSegments = opts.sendSegments;
    this.sequencer = opts.sequencer ?? null;
    this.onSent = typeof opts.onSent === 'function' ? opts.onSent : null;
    this.log = opts.log ?? (() => {});
  }

  /**
   * 为一次工具调用创建 `ctx.chat`。
   *
   * @param {object} ctx
   * @param {string} ctx.pluginId
   * @param {string} ctx.convKey
   * @param {AbortSignal} [ctx.signal]
   * @param {string} [ctx.dataDir] 插件自己的数据目录（registerMedia 的边界）
   * @returns {object}
   */
  forCall(ctx) {
    const pluginId = String(ctx.pluginId ?? '');
    const convKey = String(ctx.convKey ?? '');
    const signal = ctx.signal;
    const dataDir = ctx.dataDir ? path.resolve(String(ctx.dataDir)) : '';

    /*
     * 把依赖抓成局部常量。
     *
     * ## 为什么不能用 this.xxx
     *
     * 下面返回的是一个**普通对象**，插件会以 `ctx.chat.send(...)` 调用它。
     * 那种写法里 `this` 指向那个对象，而不是 HostChatBridge 实例 ——
     * 于是 `this.sendSegments` 是 undefined，报出来的错是
     * 「this.sendSegments is not a function」，看起来像"宿主没接好"。
     *
     * 用闭包捕获依赖就没有这个问题：插件的调用方式（解构、绑定、
     * 转手传给别处）都不会影响它。
     */
    const readMessages = this.readMessages;
    const lookupMessage = this.lookupMessage;
    const sendSegments = this.sendSegments;
    const media = this.media;
    const sequencer = this.sequencer;
    const onSent = this.onSent;

    /**
     * 每次调用一份配额计数。
     *
     * 放在 forCall 的闭包里而不是对象上：一次工具调用一份配额，
     * 用完即弃。放在对象上会让"上一次调用发满了"影响下一次。
     */
    const quota = { sends: 0 };

    /**
     * 统一的前置检查：会话合法 + 未取消。
     *
     * @returns {{ok: true} | {ok: false, code: string, message: string}}
     */
    const precheck = () => {
      if (!isValidConvKey(convKey)) {
        return { ok: false, code: 'E4074', message: `当前调用没有合法会话：${convKey || '(空)'}` };
      }
      if (signal?.aborted) {
        return { ok: false, code: 'E4070', message: '调用已取消' };
      }
      return { ok: true };
    };

    /**
     * 把一个媒体句柄换成 OneBot 消息段。
     *
     * @param {any} entry
     * @returns {{type: string, data: object}}
     */
    const segmentOf = (entry) => {
      /*
       * entry.source 是宿主登记的原始来源：
       *   - 入站消息里的媒体段：{ segment: {type, data} }
       *   - 插件 dataDir 里的文件：{ file: <绝对路径> }
       *
       * 两条路都**只在宿主侧**使用，句柄本身不携带任何可推断信息。
       */
      if (entry?.source?.segment?.data) {
        return { type: entry.source.segment.type, data: { ...entry.source.segment.data } };
      }
      if (entry?.source?.file) {
        const data = entry.kind === 'file'
          ? { file: entry.source.file, name: entry.name || path.basename(entry.source.file) }
          : { file: entry.source.file };
        return { type: entry.kind, data };
      }
      // 不该发生：登记时必然带 source。报出来，别静默发一条空消息。
      throw Object.assign(new Error('媒体句柄缺少来源（宿主内部错误）'), { code: 'E4073' });
    };

    /**
     * 发一条（或多条消息段）。
     *
     * ## 为什么真正发送的那一步要进串行器
     *
     * `sendSegments` 自己只做"一道闸门"（白名单 / 审计 / 限流），它**不排队**。
     * 排队由 per-会话的 `replySequencer` 负责，而 AI 的分条回复
     * （800ms 间隔的 burst）、`ctx.gateway.sendFace`、`ctx.deliverMedia`
     * 都在这条链上。插件如果绕过它直发，就会插进 burst 中间：
     * 用户看到"第一句 → 表情 → 第三句"，而模型说的是"第三句之后才发图"。
     *
     * 入队点刻意放在**配额与参数检查之后、真正的 `sendSegments` 之前**：
     *   · 引用归属校验（`quoteSegment`）已经在调用方同步做完了，
     *     所以不存在"入队之后才发现引用非法"；
     *   · 入队前还查一次 signal，排队期间被取消的那条不会再发出去。
     *
     * @param {object} input
     * @param {any[]} input.segments
     * @param {string} input.auditText
     * @returns {Promise<{ok: boolean, messageId?: any, code?: string, message?: string}>}
     */
    const sendOnce = async ({ segments, auditText }) => {
      const pre = precheck();
      if (!pre.ok) return pre;
      if (quota.sends >= MAX_SENDS_PER_CALL) {
        return {
          ok: false,
          code: 'E4073',
          message: `单次调用最多发 ${MAX_SENDS_PER_CALL} 条消息（已发 ${quota.sends} 条）`,
        };
      }
      if (segments.length === 0) {
        return { ok: false, code: 'E4073', message: '没有要发送的内容' };
      }
      quota.sends += 1;

      /** 真正出队时才执行的那一段 */
      const deliver = async () => {
        // 排队期间可能已被取消（用户点停止 / 插件停用）：此时一个字节都别发
        const again = precheck();
        if (!again.ok) return again;
        try {
          const r = await sendSegments({ convKey, segments, auditText, signal });
          if (!r?.ok) {
            // 闸门拒绝是**返回**而不是抛异常：原样把 code/message 交给插件，
            // 让它能作为工具结果回灌给模型（"被限流了"也是有用的信息）。
            return { ok: false, code: r?.code ?? 'E2020', message: r?.message ?? '发送被拒绝' };
          }
          /*
           * 记账：让模型下一轮知道自己用工具发过东西。
           *
           * 记在这里（而不是插件里）是因为"这条会话里它刚发过"是**会话级**
           * 事实，属于宿主的上下文。插件记的话，A 群的记录会跑到 B 群的上下文里。
           * 记账失败不影响"已经发出去了"这件事。
           */
          try {
            onSent?.({
              convKey,
              messageId: r.messageId ?? null,
              text: displayTextOf(segments),
              segments,
            });
          } catch {
            /* 记账失败不能让一次成功的发送变成失败 */
          }
          return { ok: true, messageId: r.messageId };
        } catch (err) {
          const e = /** @type {any} */ (err);
          return { ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) };
        }
      };

      // 与 AI 回复 / 表情 / 后台投递共用同一个 per-会话队列
      if (sequencer) return sequencer.run(convKey, deliver);
      return deliver();
    };

    return {
      /**
       * 当前会话的最近消息。
       *
       * @param {{limit?: number}} [input]
       */
      recent(input = {}) {
        const pre = precheck();
        if (!pre.ok) return pre;
        const limitRaw = Number(input?.limit ?? 10);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_HISTORY, Math.trunc(limitRaw))) : 10;
        try {
          const r = readMessages({ convKey, limit });
          if (!r?.ok) {
            return { ok: false, code: r?.code ?? 'E4071', message: r?.message ?? '读取会话消息失败' };
          }
          const messages = (r.messages ?? []).map((m) => ({
            messageId: m?.messageId ?? null,
            /*
             * 同时兼容两种发送者字段名：
             *   · `sender.userId` —— OneBot 归一化事件（index.mjs 传进来的）
             *   · `sender.id`     —— 会话仓库的读取形状 / 外部注入的读实现
             * 只认一种会让"某个运行时的 sender 恒为空"，而那不是错误，
             * 只是个字段名没对上 —— 插件却会拿到一个匿名的消息。
             */
            sender: {
              id: String(m?.sender?.id ?? m?.sender?.userId ?? m?.userId ?? ''),
              nickname: String(m?.sender?.nickname ?? m?.nickname ?? ''),
            },
            text: String(m?.text ?? ''),
            at: Number(m?.at ?? m?.time ?? 0),
            self: m?.self === true,
          }));
          return { ok: true, convKey, messages };
        } catch (err) {
          const e = /** @type {any} */ (err);
          return { ok: false, code: e?.code ?? 'E4071', message: String(e?.message ?? e) };
        }
      },

      /**
       * 按 id 取一条消息，**校验它属于当前会话**。
       *
       * @param {{messageId?: unknown}} input
       */
      message(input = {}) {
        const pre = precheck();
        if (!pre.ok) return pre;
        const messageId = input?.messageId;
        if (messageId === undefined || messageId === null || String(messageId).trim() === '') {
          return { ok: false, code: 'E4073', message: '需要 messageId' };
        }
        const r = lookupMessage({ convKey, messageId });
        if (!r?.ok) {
          /*
           * 找不到就一律报"不属于当前会话"。
           *
           * 为什么不区分"不存在"：如果宿主能区分，那么"这条消息在别的群"
           * 就成了一个可探测的事实 —— 拿一串递增 id 试探就能得知
           * 别的会话里有没有某条消息。统一口径把这条路堵死。
           */
          return { ok: false, code: 'E4074', message: '该消息不存在或不属于当前会话' };
        }
        const evt = r.event ?? {};
        const media = pickMediaSegments(evt.segments).map((m) => ({
          kind: m.type,
          name: mediaName(m.data),
        }));
        return {
          ok: true,
          message: {
            messageId: evt.messageId ?? messageId,
            sender: {
              id: String(evt.sender?.userId ?? evt.sender?.id ?? ''),
              nickname: String(evt.sender?.nickname ?? ''),
            },
            text: String(evt.text ?? ''),
            at: Number(evt.time ?? 0) * 1000 || Number(evt.receivedAt ?? 0),
            media,
            /**
             * 引用关系也一并给出：插件常需要"回复的哪条"来判断上下文。
             * 仍然是 id，不是内容。
             */
            replyToMessageId: evt.replyTo?.messageId ?? null,
          },
        };
      },

      /**
       * 列出某条消息里的媒体（返回句柄）。
       *
       * @param {{messageId?: unknown}} input
       */
      mediaList(input = {}) {
        const pre = precheck();
        if (!pre.ok) return pre;
        const messageId = input?.messageId;
        if (messageId === undefined || messageId === null || String(messageId).trim() === '') {
          return { ok: false, code: 'E4073', message: '需要 messageId' };
        }
        const r = lookupMessage({ convKey, messageId });
        if (!r?.ok) {
          return { ok: false, code: 'E4074', message: '该消息不存在或不属于当前会话' };
        }
        const segs = pickMediaSegments(r.event?.segments);
        if (segs.length === 0) return { ok: true, handles: [] };

        /** @type {any[]} */
        const handles = [];
        for (const seg of segs.slice(0, MAX_MEDIA_PER_MESSAGE)) {
          handles.push(
            media.register({
              pluginId,
              convKey,
              kind: seg.type,
              name: mediaName(seg.data),
              mime: String(seg.data?.mime ?? ''),
              bytes: Number(seg.data?.bytes ?? 0) || 0,
              messageId: r.event?.messageId ?? messageId,
              source: { segment: { type: seg.type, data: seg.data } },
            }),
          );
        }
        return { ok: true, handles };
      },

      /**
       * 把插件自己生成的文件登记成句柄（生图插件的入口）。
       *
       * 只允许插件 **自己的** dataDir 下的文件：这样"发一张图"不需要
       * 让插件（或模型）碰到本机任意路径。越界 `E4075`。
       *
       * @param {{path?: unknown, kind?: unknown, name?: unknown, mime?: unknown}} input
       */
      async registerMedia(input = {}) {
        const pre = precheck();
        if (!pre.ok) return pre;
        if (!dataDir) {
          return { ok: false, code: 'E4071', message: '宿主未配置插件数据目录' };
        }
        const raw = typeof input?.path === 'string' ? input.path.trim() : '';
        if (!raw) return { ok: false, code: 'E4073', message: '需要 path' };

        const kind = String(input?.kind ?? 'image');
        if (!MEDIA_KINDS.has(kind)) {
          return { ok: false, code: 'E4073', message: `不支持的媒体类型：${kind}` };
        }

        /*
         * 路径校验分三步，缺一不可：
         *   1. resolve 后必须落在 dataDir 内（防 ../../）
         *   2. realpath 后再验一次（防符号链接指到外面）
         *   3. 必须是普通文件、体积受限
         */
        const candidate = path.resolve(dataDir, raw);
        if (candidate !== dataDir && !candidate.startsWith(dataDir + path.sep)) {
          return { ok: false, code: 'E4075', message: '只能登记插件自己数据目录内的文件' };
        }

        let real;
        try {
          real = await fs.realpath(candidate);
        } catch {
          return { ok: false, code: 'E4073', message: '文件不存在或不可读' };
        }
        if (real !== dataDir && !real.startsWith(dataDir + path.sep)) {
          return { ok: false, code: 'E4075', message: '文件实际指向插件数据目录之外（符号链接）' };
        }

        let st;
        try {
          st = await fs.stat(real);
        } catch {
          return { ok: false, code: 'E4073', message: '文件不存在或不可读' };
        }
        if (!st.isFile()) return { ok: false, code: 'E4073', message: '不是一个文件' };
        if (st.size > MAX_REGISTER_BYTES) {
          return {
            ok: false,
            code: 'E4073',
            message: `文件太大（${Math.round(st.size / 1024)}KB，上限 ${MAX_REGISTER_BYTES / 1024 / 1024}MB）`,
          };
        }

        const name = String(input?.name ?? path.basename(real)).slice(0, 120);
        const view = media.register({
          pluginId,
          convKey,
          kind,
          name,
          mime: String(input?.mime ?? ''),
          bytes: st.size,
          source: { file: real },
        });
        return { ok: true, ...view };
      },

      /**
       * 发文本。
       *
       * @param {{text?: unknown, quote?: unknown}} input
       */
      async send(input = {}) {
        const pre = precheck();
        if (!pre.ok) return pre;
        const text = typeof input?.text === 'string' ? input.text : String(input?.text ?? '');
        if (text.trim() === '') return { ok: false, code: 'E4073', message: '文本为空' };
        if (text.length > MAX_TEXT_CHARS) {
          return { ok: false, code: 'E4073', message: `文本超长（${text.length} > ${MAX_TEXT_CHARS}）` };
        }

        /** @type {any[]} */
        const segments = [];
        const quote = quoteSegment(convKey, input?.quote);
        if (quote) {
          if (!quote.ok) return quote;
          segments.push(quote.segment);
        }
        segments.push({ type: 'text', data: { text } });

        return sendOnce({ segments, auditText: text });
      },

      /**
       * 发媒体（句柄）。
       *
       * @param {{handles?: unknown, quote?: unknown}} input
       */
      async sendMedia(input = {}) {
        const pre = precheck();
        if (!pre.ok) return pre;
        const list = Array.isArray(input?.handles) ? input.handles : [];
        if (list.length === 0) return { ok: false, code: 'E4073', message: '需要至少一个媒体句柄' };
        if (list.length > MAX_MEDIA_PER_MESSAGE) {
          return { ok: false, code: 'E4073', message: `一条消息最多 ${MAX_MEDIA_PER_MESSAGE} 个媒体` };
        }

        const resolved = media.resolveMany({ pluginId, convKey, handles: list });
        if (!resolved.ok) return resolved;

        /** @type {any[]} */
        const segments = [];
        const quote = quoteSegment(convKey, input?.quote);
        if (quote) {
          if (!quote.ok) return quote;
          segments.push(quote.segment);
        }
        for (const entry of resolved.entries) {
          try {
            segments.push(segmentOf(entry));
          } catch (err) {
            const e = /** @type {any} */ (err);
            return { ok: false, code: e?.code ?? 'E4073', message: String(e?.message ?? e) };
          }
        }

        const label = resolved.entries
          .map((e) => `[${e.kind}] ${e.name || ''}`.trim())
          .join(' ');
        return sendOnce({ segments, auditText: label });
      },
    };

    /**
     * 引用段的构造与归属校验（闭包版本）。
     *
     * `quote` 必须属于**当前会话**：否则"引用群里某条消息"就变成了
     * 一个跨会话的探测/钓鱼原语（引用一段你没权限看的内容）。
     *
     * ## 为什么是同步的
     *
     * 它看起来该是 async，但**不该**：归属查询是纯内存查找
     * （注入的 lookupMessage 是同步的）。写成 async 会让 send() 里
     * 多一个 await 点，而那个点之后信号可能已经 abort 了 ——
     * 于是"取消之后仍然发出去一条"。
     *
     * @param {string} convKey
     * @param {unknown} quote
     * @returns {{ok: true, segment: object} | {ok: false, code: string, message: string} | null}
     */
    function quoteSegment(convKey, quote) {
      if (quote === undefined || quote === null || String(quote).trim() === '') return null;
      const id = String(quote).trim();
      const r = lookupMessage({ convKey, messageId: id });
      if (!r?.ok) {
        return { ok: false, code: 'E4074', message: '引用的消息不存在或不属于当前会话' };
      }
      return { ok: true, segment: { type: 'reply', data: { id: r.event?.messageId ?? id } } };
    }
  }
}
