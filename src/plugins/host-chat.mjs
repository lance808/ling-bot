/**
 * 宿主聊天能力工厂 —— `ctx.chat` 的来源
 *
 * ## 它解决的问题
 *
 * 插件需要"看当前会话最近几条消息""把一张图发到当前会话"。这些能力
 * 分散在三个地方：会话仓库（读）、发送闸门（写）、媒体句柄表（引用）。
 * 而插件**不该知道**这三样东西的存在 —— 它只该看到一组方法。
 *
 * 所以本文件把三者装成一个对象，并按**每一次工具调用**产出一份。
 *
 * ## 为什么每次调用都要新建
 *
 * `ctx.chat` 绑定的是"这次调用的会话"。做成长期单例就必须在调用时
 * 往里写"当前会话"，而两个调用同时发生时后一个会覆盖前一个 ——
 * 症状是"图偶尔发到别的群"，且极难复现。
 *
 * 所以：一次调用一个实例，闭包里带着不可变的 pluginId / convKey / signal。
 *
 * ## 两种运行时共用这一份
 *
 * `in-process` 直接调用这些方法；`process` 通过 NDJSON 转发（host-call）。
 * 真正的判定全在父进程这里，因此两端语义**必然**一致 ——
 * 这也是"process 与 in-process 新能力保持一致"的实现方式：
 * 不是写两遍保证一致，而是只有一遍。
 */

import { HostChatBridge } from './chat-bridge.mjs';
import { MediaHandleRegistry } from './media-handles.mjs';
import { unavailableChat } from './runtime-inprocess.mjs';

/**
 * 媒体类型 → 列表展示用的中文名（只用于日志/审计文本，不参与判定）
 */
const KIND_LABEL = Object.freeze({
  image: '图片',
  record: '语音',
  video: '视频',
  file: '文件',
});

/**
 * 媒体类型的中文名。
 *
 * @param {string} kind
 * @returns {string}
 */
export function mediaKindLabel(kind) {
  return KIND_LABEL[String(kind)] ?? String(kind ?? '媒体');
}

/**
 * 创建宿主聊天能力工厂。
 *
 * 依赖全部注入，因此它能在纯 Node 下被测：不需要连 QQ、不需要起后端。
 *
 * @param {object} opts
 * @param {(input: {convKey: string, limit: number}) => any} opts.readMessages
 *   读当前会话最近消息。返回 `{ok, messages}` 或 `{ok:false, code, message}`。
 * @param {(input: {convKey: string, messageId: unknown}) => any} opts.lookupMessage
 *   按 id 在**指定会话**里找消息（找不到就 `{ok:false}`）。
 * @param {(input: {convKey: string, segments: any[], auditText: string, signal?: AbortSignal}) => Promise<any>} opts.sendSegments
 *   唯一发送通路（白名单 + 出站审计 + 限流都在里面）。
 * @param {{run: <T>(key: string, fn: () => Promise<T>) => Promise<T>}} [opts.sequencer]
 *   按会话串行器（与 AI 分条回复、表情发送、后台投递共用同一个实例）。
 * @param {(input: {convKey: string, messageId: any, text: string, segments: any[]}) => void} [opts.onSent]
 *   发送成功后的上下文记账回调（宿主 pushRecent 用）。
 * @param {(level: string, message: string) => void} [opts.log]
 * @param {{ttlMs?: number, now?: () => number}} [opts.media]
 * @returns {{makeChat: (input: object) => object, media: MediaHandleRegistry, bridge: HostChatBridge}}
 */
export function createChatFactory(opts) {
  const media = new MediaHandleRegistry(opts.media ?? {});
  const log = opts.log ?? (() => {});

  const bridge = new HostChatBridge({
    media,
    readMessages: opts.readMessages,
    lookupMessage: opts.lookupMessage,
    sendSegments: opts.sendSegments,
    sequencer: opts.sequencer ?? null,
    onSent: opts.onSent ?? null,
    log,
  });

  /**
   * 为一次调用创建 ctx.chat。
   *
   * @param {object} input
   * @param {string} input.pluginId
   * @param {object} input.invocation 可信调用上下文（含 convKey）
   * @param {string} [input.dataDir]
   * @param {AbortSignal} [input.signal]
   * @returns {object}
   */
  function makeChat(input) {
    const convKey = String(input?.invocation?.convKey ?? '');
    if (!convKey) {
      /*
       * 没有会话就没有聊天能力。
       *
       * 这会在什么时候发生？桌面端手动试工具（origin=console）时
       * convKey 可能是 `private:0` 这种占位值 —— 那是合法的。
       * 真正为空只可能是宿主装配错误，此时给一个明确错误比
       * 让它去读 `''` 会话（store 会返回"会话键非法"）更清楚。
       */
      return unavailableChat(`本次调用没有会话上下文（convKey 为空），聊天能力不可用`);
    }

    return bridge.forCall({
      pluginId: String(input?.pluginId ?? ''),
      convKey,
      dataDir: input?.dataDir,
      signal: input?.signal,
    });
  }

  return { makeChat, media, bridge };
}

/**
 * 插件停用时清掉它的媒体句柄。
 *
 * 为什么需要：句柄有 10 分钟有效期，而插件停用可能发生在第 1 分钟。
 * 不停用就清掉的话，一个已经停用的插件留下的句柄仍然能被……
 * 其实不能 —— 句柄的归属校验要求 `pluginId` 相同，而停用的插件不再被调用。
 * 但**重载**会创建新实例，旧句柄就永远没人用了，白占内存。
 *
 * 所以这里在停用/重载路径上顺手清掉，让"停用"在内存上也是干净的。
 *
 * @param {MediaHandleRegistry} media
 * @param {string} pluginId
 * @returns {number} 清掉的句柄数
 */
export function forgetPluginMedia(media, pluginId) {
  try {
    return media?.forgetPlugin?.(String(pluginId)) ?? 0;
  } catch {
    return 0;
  }
}
