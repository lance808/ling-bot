/**
 * 一个回合的回复怎么落地 —— 拆分 → 逐条发送 → 记账
 *
 * ## 为什么这段要单独抽出来
 *
 * 「历史只记真正发出去的内容」这条要求，实现位置在**发送结果之后**：
 * 必须知道哪几条成功了才敢记。它同时牵动三件事：
 *
 *   1. 上下文（`pushRecent`）—— 记错了下一轮模型会重复自己
 *   2. 主动回合计数（`noteProactive`）—— 按条记会让 30 分钟护栏被打穿
 *   3. `turn-end` 通知（界面上显示什么）
 *
 * 这三件事以前散在 `startTurn` 里，只能靠跑真机器人验证。抽出来之后
 * 可以用注入的 fake send 精确复现"第二条被限流""发到一半点了停止"，
 * 而那正是最容易出错、也最难在真机上复现的路径。
 *
 * ## 触顶说明为什么在这里拼
 *
 * 「工具调用已达上限」是**回答的一部分**，不是一条独立消息。
 * 拼在最后一条后面，用户读到的顺序才是"答案 → 补充说明"。
 * 如果先拆分再拼，说明会凭空变成一个新气泡，甚至单独占一条。
 */

import { splitReply } from './split.mjs';
import { sendBurst } from './send.mjs';

/**
 * 把触顶说明挂到最后一条消息上。
 *
 * @param {string[]} messages
 * @param {string | null} notice
 * @returns {string[]}
 */
export function attachNotice(messages, notice) {
  if (!notice) return messages;
  if (messages.length === 0) return [notice];
  const out = [...messages];
  out[out.length - 1] = `${out[out.length - 1]}\n${notice}`;
  return out;
}

/**
 * 发送一个回合的回复并记账。
 *
 * @param {object} input
 * @param {string} input.convKey
 * @param {string} input.text 模型本回合的最终文本（可能带分条块）
 * @param {string | null} [input.notice] 触顶说明（拼在最后一条后面）
 * @param {(convKey: string, text: string) => Promise<{ok: boolean, code?: string, message?: string}>} input.send
 * @param {object} [input.sequencer]
 * @param {AbortSignal} [input.signal]
 * @param {{splitEnabled?: boolean, maxMessages?: number, intervalMs?: number}} [input.config]
 * @param {(text: string) => void} [input.onSent] 每成功发出**一条**时调用（用于记上下文）
 * @param {() => void} [input.onDelivered] 整个回合**至少发出一条**时调用一次（用于回合计数）
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [input.sleep] 测试注入
 * @returns {Promise<{
 *   ok: boolean,
 *   empty: boolean,
 *   sent: string[],
 *   failed: Array<{index: number, text: string, code?: string, message?: string}>,
 *   aborted: boolean,
 *   planned: number,
 *   splitMode: string,
 *   splitReason: string | null,
 *   clamped: boolean,
 * }>}
 */
export async function deliverReply(input) {
  const text = String(input.text ?? '').trim();
  const notice = input.notice ? String(input.notice).trim() : '';
  const cfg = input.config ?? {};

  if (!text && !notice) {
    return {
      ok: false,
      empty: true,
      sent: [],
      failed: [],
      aborted: false,
      planned: 0,
      splitMode: 'plain',
      splitReason: 'empty',
      clamped: false,
    };
  }

  /*
   * 先拆分，再拼触顶说明。
   *
   * 反过来的话，说明会变成一个独立气泡 —— 而它本该跟着最后一条走。
   * 注意 `text` 为空时 splitReply 返回空数组，attachNotice 会补成 [notice]，
   * 那是"模型没说话但触顶了"的情况，说明本身就是要发的内容。
   */
  const split = splitReply(text, {
    enabled: cfg.splitEnabled !== false,
    maxMessages: cfg.maxMessages,
  });
  const messages = attachNotice(split.messages, notice || null);

  const burst = await sendBurst({
    convKey: input.convKey,
    messages,
    send: input.send,
    sequencer: input.sequencer,
    signal: input.signal,
    intervalMs: cfg.intervalMs,
    maxMessages: cfg.maxMessages,
    sleep: input.sleep,
  });

  /*
   * 记账顺序：逐条记上下文，回合计数只记一次。
   *
   * onSent 在循环里逐条调用 —— 每条都真的发出去了，所以每条都该进历史。
   * onDelivered 在所有发送结束后调用一次 —— 一条回复就是一个回合，
   * 不是三条。按条记会让「两次主动发言最小间隔」这类护栏被一次回复打穿。
   */
  for (const one of burst.sent) input.onSent?.(one);
  if (burst.sent.length > 0) input.onDelivered?.();

  return {
    ok: burst.sent.length > 0,
    empty: false,
    sent: burst.sent,
    failed: burst.failed,
    aborted: burst.aborted,
    planned: burst.planned,
    splitMode: split.mode,
    splitReason: split.reason ?? null,
    clamped: split.clamped === true,
  };
}
