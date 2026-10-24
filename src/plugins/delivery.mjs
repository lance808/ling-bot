/**
 * 插件后台媒体投递 —— 让"先生成、后发送"的插件仍然走统一队列与闸门
 *
 * ## 为什么需要它
 *
 * `ctx.chat` 绑定在**一次工具调用**上：调用一返回，它就不再可用。这对
 * "调用里立刻发图"的工具够用，但对生图这类**异步**任务是错的 ——
 * 图片要几十秒后才出来，那时工具调用早就结束了。
 *
 * 现实里只有三个选择：
 *
 *   1. 让工具调用一直挂着等图片 —— 工具超时（默认 20s）先到，而且模型回合
 *      被一张图卡住，用户体验很差；
 *   2. 插件自己去调 OneBot 或往磁盘上写文件后开一个后门发送 —— 绕过白名单、
 *      出站审计、限流，等于给所有插件开一条"往任意会话发文件"的通道；
 *   3. 宿主给一个**受控的后台投递能力**：目标会话由调用时的可信上下文给出，
 *      文件必须在插件自己的 dataDir 里，发送仍然走 `sendSegments` 与串行器。
 *
 * 这里实现的是第 3 种。它不是 `ctx.chat` 的替代品，也不给 process 插件：
 * 后者没有任何"可信调用上下文"可言，给它一个 target convKey 参数就等于
 * 把"往任意群发文件"做成公开 API。所以只有 in-process + trusted 的第一方
 * 插件拿得到（装配见 manager.startOne）。
 *
 * ## 沿用 ctx.chat 的三条纪律
 *
 *   · **文件受控**：只接受 dataDir 内的普通文件（resolve + realpath 两步），
 *     单文件 ≤ 10MB —— 与 ctx.chat.registerMedia 完全同一口径。
 *   · **统一出口**：不自己拼 OneBot 动作，交给注入的 `sendSegments`；
 *     它内部就是白名单 / 出站审计 / 限流那一套。
 *   · **失败返回结果对象，不抛异常**：后台任务最怕的是一句异常把 worker 打死。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { isValidConvKey } from '../onebot/events.mjs';

/** 允许投递的媒体类型（与 ctx.chat 一致） */
const MEDIA_KINDS = new Set(['image', 'record', 'video', 'file']);

/** 单文件上限：与 ctx.chat.registerMedia 的 10MB 对齐 */
export const MAX_DELIVERY_BYTES = 10 * 1024 * 1024;

/**
 * 创建一个"按插件绑定"的投递函数工厂。
 *
 * @param {object} opts
 * @param {(input: {convKey: string, segments: any[], auditText: string, signal?: AbortSignal}) => Promise<any>} opts.sendSegments
 *   统一发送通路（宿主的白名单/审计/限流都在里面）
 * @param {{run: <T>(key: string, fn: () => Promise<T>) => Promise<T>}} [opts.sequencer]
 *   按会话串行器。必须与 AI 回复、表情发送共用同一个，否则后台任务会插到
 *   正在分条发送的回复中间。
 * @param {import('./media-handles.mjs').MediaHandleRegistry} [opts.media]
 *   媒体句柄表。提供时投递成功会返回一个句柄，便于任务记录与追溯。
 * @param {(level: string, message: string, fields?: object) => void} [opts.log]
 * @returns {(input: object) => Promise<object>}
 */
export function createMediaDelivery(opts) {
  const sendSegments = opts.sendSegments;
  const sequencer = opts.sequencer ?? null;
  const media = opts.media ?? null;
  const log = opts.log ?? (() => {});

  /**
   * 投递一个插件 dataDir 内的文件到指定会话。
   *
   * @param {object} input
   * @param {string} input.pluginId 归属插件（由宿主绑定，不接受插件参数）
   * @param {string} input.dataDir 插件数据目录（由宿主绑定）
   * @param {string} input.convKey 目标会话（由插件的**调用上下文**给出；后台任务会持久化它）
   * @param {string} input.path dataDir 内的相对路径（也接受绝对路径，但必须落在 dataDir 内）
   * @param {string} [input.kind]
   * @param {string} [input.mime]
   * @param {string} [input.name]
   * @param {unknown} [input.quote] 引用的消息 id（必须属于目标会话，由 sendSegments 侧校验）
   * @param {string} [input.auditText]
   * @param {AbortSignal} [input.signal]
   * @param {() => boolean} [input.isActive] 插件是否仍然存活
   * @returns {Promise<{ok: boolean, code?: string, message?: string, messageId?: any, handle?: string, bytes?: number}>}
   */
  return async function deliver(input = {}) {
    if (!sendSegments) {
      return { ok: false, code: 'E4072', message: '宿主未提供媒体发送能力' };
    }
    const checkActive = () => {
      if (typeof input.isActive === 'function' && input.isActive() === false) {
        return { ok: false, code: 'E4067', message: '插件已停用，拒绝后台投递' };
      }
      if (input.signal?.aborted) return { ok: false, code: 'E4070', message: '后台投递已取消' };
      return null;
    };
    const inactive = checkActive();
    if (inactive) return inactive;

    const pluginId = String(input.pluginId ?? '');
    const dataDir = String(input.dataDir ?? '');
    const convKey = String(input.convKey ?? '').trim();

    if (!pluginId) return { ok: false, code: 'E4071', message: '后台投递缺少插件身份' };
    if (!dataDir) return { ok: false, code: 'E4071', message: '后台投递缺少插件数据目录' };
    if (!isValidConvKey(convKey)) {
      return { ok: false, code: 'E4074', message: `目标会话不合法：${convKey || '(空)'}` };
    }

    const kind = String(input.kind ?? 'image');
    if (!MEDIA_KINDS.has(kind)) {
      return { ok: false, code: 'E4073', message: `不支持的媒体类型：${kind}` };
    }

    const raw = typeof input.path === 'string' ? input.path.trim() : '';
    if (!raw) return { ok: false, code: 'E4073', message: '需要 path' };

    /*
     * 路径三道校验，与 ctx.chat.registerMedia 完全一致：
     *   1) resolve 后必须落在 dataDir 内（挡 ../）
     *   2) realpath 后再判一次（挡符号链接）
     *   3) 必须是普通文件、体积受限
     * 少任何一步，这个能力就变成"把本机任意文件发到任意会话"。
     */
    const base = path.resolve(dataDir);
    const candidate = path.resolve(base, raw);
    if (candidate !== base && !candidate.startsWith(base + path.sep)) {
      return { ok: false, code: 'E4075', message: '只能投递插件自己数据目录内的文件' };
    }

    let real;
    try {
      real = await fs.realpath(candidate);
    } catch {
      return { ok: false, code: 'E4073', message: '文件不存在或不可读' };
    }
    if (real !== base && !real.startsWith(base + path.sep)) {
      return { ok: false, code: 'E4075', message: '文件实际指向插件数据目录之外（符号链接）' };
    }

    let st;
    try {
      st = await fs.stat(real);
    } catch {
      return { ok: false, code: 'E4073', message: '文件不存在或不可读' };
    }
    if (!st.isFile()) return { ok: false, code: 'E4073', message: '不是一个文件' };
    if (st.size > MAX_DELIVERY_BYTES) {
      return {
        ok: false,
        code: 'E4073',
        message: `文件太大（${Math.round(st.size / 1024)}KB，上限 ${MAX_DELIVERY_BYTES / 1024 / 1024}MB）`,
      };
    }

    const name = String(input.name ?? path.basename(real)).slice(0, 120);
    const segment = kind === 'file'
      ? { type: 'file', data: { file: real, name } }
      : { type: kind, data: { file: real } };

    const auditText = String(input.auditText ?? `[${kind}] ${name}`).slice(0, 200);

    // 入队到执行之间可能停用或取消；必须在统一队列真正轮到它时再检查。
    const send = () => checkActive()
      ?? sendSegments({ convKey, segments: [segment], auditText, signal: input.signal });
    let result;
    try {
      result = sequencer
        ? await sequencer.run(convKey, send)
        : await send();
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) };
    }

    if (!result?.ok) {
      // 闸门拒绝是**返回**而不是抛异常：原样交给调用方（后台任务据此决定是否重试投递）
      return {
        ok: false,
        code: result?.code ?? 'E2020',
        message: result?.message ?? '发送被拒绝',
      };
    }

    let handle = '';
    if (media) {
      try {
        const view = media.register({
          pluginId,
          convKey,
          kind,
          name,
          mime: String(input.mime ?? ''),
          bytes: st.size,
          source: { file: real },
        });
        handle = String(view?.handle ?? '');
      } catch (err) {
        // 句柄只是追溯信息，登记失败不影响"已经发出去了"这个事实
        log('warn', `后台投递已成功，但登记媒体句柄失败：${String(/** @type {any} */ (err)?.message ?? err)}`);
      }
    }

    log('debug', `后台投递成功：${pluginId} → ${convKey}（${name}，${st.size} 字节）`);
    return { ok: true, messageId: result.messageId, handle, bytes: st.size };
  };
}
