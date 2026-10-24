/**
 * 分条发送 —— 一个回合的回复拆成若干个气泡逐条发出去
 *
 * ## 这条路径要守住的事
 *
 *   1. **每条都过同一道闸门**：白名单、出站审计、限流一条都不能跳。
 *      `send` 由调用方注入（`index.mjs` 里就是那个唯一的 `sendText`），
 *      这里不碰网络、不认识 OneBot。
 *   2. **同一会话严格串行**：两个回合几乎同时结束（群里被连问两句）时，
 *      如果各自 `await` 自己的几条消息，发出去会是穿插的 ——
 *      A1 B1 A2 B2。真人不会这样说话。所以按会话排队。
 *   3. **条间有间隔**：瞬间连发三条看起来比整条发出去还像刷屏。
 *   4. **中止要能停在消息边界**：用户点「停止」之后不该再多发一条；
 *      但已经发出去的那条不能撤回，所以要如实返回"发了几条"。
 *   5. **部分失败要能被上层看见**：哪条没发出去、为什么，必须回传给
 *      调用方 —— 因为历史只记真正发成功的内容。
 *
 * ## 为什么这里不做拆分
 *
 * 拆分是纯函数（`src/reply/split.mjs`），发送是有副作用的。
 * 混在一起的话，"协议解析对不对"就只能靠跑真机器人验证；
 * 分开之后两边都能单独测，而且发送层完全不需要知道协议长什么样。
 */

import { DEFAULT_MAX_MESSAGES, MAX_MESSAGES_HARD_CAP } from './split.mjs';

/**
 * 默认条间间隔（毫秒）。
 *
 * 800ms 是"看完一句再打下一条"的节奏下限附近：
 * 短于它像机器刷屏，长于 2s 会让人以为它卡住了。
 */
export const DEFAULT_INTERVAL_MS = 800;

/**
 * 间隔的硬上下限。
 *
 * 下限 100ms：低于它 QQ 客户端本身就会合并显示，分条没意义了。
 * 上限 10s：再长用户会以为消息丢了。
 */
export const MIN_INTERVAL_MS = 100;
export const MAX_INTERVAL_MS = 10_000;

/**
 * 把配置里的间隔夹进合法区间。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeIntervalMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.round(n)));
}

/**
 * 把配置里的条数上限夹进合法区间。
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeMaxMessages(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_MESSAGES;
  return Math.max(1, Math.min(MAX_MESSAGES_HARD_CAP, Math.trunc(n)));
}

/**
 * 默认的等待实现。
 *
 * 单独抽出来是为了测试能注入一个"立即返回、并记录每次等待"的假 sleep ——
 * 否则测分条发送就要真的睡几秒，测试会慢到没人愿意跑。
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function defaultSleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    // unref：被取消的等待不能让进程一直挂着（测试里尤其重要）
    timer.unref?.();

    /**
     * 中止时**提前结束等待**，而不是把 resolve 丢掉。
     *
     * 丢掉的写法（只在 abort 时 clearTimeout 不 resolve）会让调用方的
     * await 永远悬着 —— 表现是"点了停止，回合再也没结束"。
     */
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * 按会话串行化的执行器。
 *
 * ## 为什么是"串行化"而不是"锁"
 *
 * 锁要处理超时、重入、异常释放；而这里的需求只有一个：
 * **同一会话的发送排队，不同会话互不影响**。
 * 用一个 per-key 的 Promise 链就够，失败也不会卡住后续（catch 掉再接）。
 *
 * @returns {{run: <T>(key: string, fn: () => Promise<T>) => Promise<T>}}
 */
export function createSequencer() {
  /** @type {Map<string, Promise<any>>} */
  const chains = new Map();

  return {
    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(key, fn) {
      const prev = chains.get(key) ?? Promise.resolve();
      /*
       * 链上每一步都吞掉上一次的错误：一个回合发送失败不该让
       * 这个会话之后的每一条消息都跟着失败（链断掉就永远发不出去了）。
       */
      const next = prev.then(
        () => fn(),
        () => fn(),
      );
      /** 链上这一环的标记：清理时用它确认自己仍是链尾 */
      const tail = next.then(
        () => {},
        () => {},
      );
      chains.set(key, tail);
      /*
       * 链尾自己清理，避免 Map 里堆积已经结束的会话。
       * 只有"这一环仍然是链尾"时才删 —— 否则会把后面接上来的任务丢掉，
       * 那个会话的串行保证就断了（后来的消息会插队）。
       */
      void tail.then(() => {
        if (chains.get(key) === tail) chains.delete(key);
      });
      return next;
    },
    /** 仅测试用：当前排队中的会话数 */
    size() {
      return chains.size;
    },
  };
}

/**
 * 逐条发送一回合的回复。
 *
 * @param {object} input
 * @param {string} input.convKey
 * @param {string[]} input.messages 已拆分好的消息列表（至少一条）
 * @param {(convKey: string, text: string) => Promise<{ok: boolean, code?: string, message?: string}>} input.send
 *   唯一的发送通道（会走发送闸门）
 * @param {object} [input.sequencer] 会话串行器（跨回合共享）
 * @param {AbortSignal} [input.signal] 回合中止信号
 * @param {number} [input.intervalMs] 条间间隔
 * @param {number} [input.maxMessages] 条数上限
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [input.sleep] 测试注入
 * @returns {Promise<{
 *   ok: boolean,
 *   sent: string[],
 *   failed: Array<{index: number, text: string, code?: string, message?: string}>,
 *   aborted: boolean,
 *   planned: number,
 * }>}
 */
export async function sendBurst(input) {
  const convKey = String(input.convKey ?? '');
  const send = input.send;
  if (typeof send !== 'function') throw new TypeError('sendBurst 需要一个发送函数');

  const maxMessages = normalizeMaxMessages(input.maxMessages);
  const intervalMs = normalizeIntervalMs(input.intervalMs);
  const sequencer = input.sequencer ?? defaultSequencer;
  const sleep = input.sleep ?? defaultSleep;
  const signal = input.signal;

  /*
   * 先在这里夹一次上限。
   *
   * 上层（splitReply）已经夹过，但这条路径也可能被别的调用方直接用
   * （比如将来的手动分条发送）。**每一层都守住自己的不变量**，
   * 而不是假设调用方做对了。
   */
  const raw = (Array.isArray(input.messages) ? input.messages : [])
    .map((m) => String(m ?? '').trim())
    .filter(Boolean);
  const planned = raw.slice(0, maxMessages);

  if (planned.length === 0) {
    return { ok: false, sent: [], failed: [], aborted: false, planned: 0 };
  }

  return sequencer.run(convKey, async () => {
    /** @type {string[]} */
    const sent = [];
    /** @type {Array<{index: number, text: string, code?: string, message?: string}>} */
    const failed = [];
    let aborted = false;

    for (let i = 0; i < planned.length; i += 1) {
      const text = planned[i];

      /*
       * 中止检查放在**每条发送之前**，而不是只查一次。
       *
       * 原因：用户点停止时，前面那条可能刚发出去、间隔还在走。
       * 只查一次的话，剩下的消息会在他点完之后继续冒出来。
       */
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      // 第一条之外都要等一个间隔。中止会提前结束等待（见 defaultSleep）
      if (i > 0) {
        await sleep(intervalMs, signal);
        if (signal?.aborted) {
          aborted = true;
          break;
        }
      }

      let result;
      try {
        result = await send(convKey, text);
      } catch (err) {
        // 闸门本身不抛异常，但注入的 send 可能抛（测试、将来的实现）。这里不能崩。
        const e = /** @type {any} */ (err);
        result = { ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) };
      }

      if (result?.ok) {
        sent.push(text);
      } else {
        failed.push({
          index: i,
          text,
          code: result?.code ?? 'E50XX',
          message: result?.message ?? '未知错误',
        });
      }
    }

    return {
      // 只要有一条真的发出去就算"这一回合发出了内容"：
      // 上层据此决定记不记历史、记不记主动回合
      ok: sent.length > 0,
      sent,
      failed,
      aborted,
      planned: planned.length,
    };
  });
}

/** 默认的跨回合串行器（进程内共享） */
export const defaultSequencer = createSequencer();
