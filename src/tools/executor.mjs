/**
 * 工具执行器 —— F14
 *
 * 一次工具调用的完整生命周期：
 *   1. 查注册表（不存在 → E4032）
 *   2. 授权（origin + 声明 → isToolGranted；拒绝 → E4032）
 *   3. 参数校验（不信任模型给的任何值 → E4041）
 *   4. 需要确认的挂起等人工点头（超时按拒绝 → E4034）
 *   5. 执行（捕获异常，绝不让一个工具炸掉整个回合）
 *   6. 记录调用流水（成功与拒绝都记）
 *
 * 注意：本文件**不是**授权判定的地方，判定在 guard/tool-gate.mjs（纯函数）。
 * 这里只做编排，避免把安全逻辑摊在流程里。
 *
 * ## 可信调用上下文（invocation）
 *
 * 插件执行时需要一个"这次调用是谁、在哪个会话、由谁触发"的上下文。
 * 它在**这里**构造，因为只有这里同时知道 origin、convKey、消息 id 与工具名。
 *
 * 关键约束：**模型无法影响它**。
 *
 *   · 它不由 `args` 派生（args 只保留清单声明的字段，见 validateParams）；
 *   · 它不读消息正文；
 *   · 插件 manifest 不允许声明这些参数名（manifest.mjs 的 RESERVED_PARAM_NAMES）。
 *
 * 三条加起来，一句 `{"origin":"owner-private"}` 不可能完成提权 ——
 * 它连 args 都进不去，进了也会被 validateParams 丢掉。
 *
 * ## 取消信号
 *
 * 回合被取消（用户点「停止」）、宿主超时、插件被停用，三者都要能让**正在跑**的
 * 工具体面地停下。所以 `signal` 一路透传：executor → runner → runtime →
 * 插件 callTool({ signal })。
 *
 * 取消与失败要分开报：取消是 `E4070`（"这次不算数"），
 * 失败是工具自己的错误码。混成一个会让用户分不清"我点了停止"和"它坏了"。
 */

import { listTools, getTool } from './registry.mjs';
import { resolveToolSet, validateParams, needsConfirmFor, isApprovalDelegated, RISK, pluginChatAccess } from '../guard/tool-gate.mjs';
import { assertOrigin } from '../guard/origin.mjs';

/**
 * @typedef {object} ToolRunContext
 * @property {import('../guard/origin.mjs').Origin} origin
 * @property {string} convKey
 * @property {{id?: string, nickname?: string}} [requester] 触发者（主动回合为空）
 * @property {unknown} [messageId] 触发调用的消息 id
 * @property {unknown} [replyToMessageId] 该消息引用的消息 id
 * @property {AbortSignal} [signal] 整个回合的取消信号
 * @property {() => string} [newCallId] 生成调用 id（便于测试注入确定性值）
 * @property {(rec: object) => void} [onRecord] 调用流水回调
 * @property {(req: {tool: string, risk: string, args: object, convKey: string}) => Promise<'allow'|'deny'>} [askConfirm]
 */

/**
 * 生成一个调用 id。
 *
 * 用随机串而不是自增数字：自增会在重启后从 1 开始，
 * 于是日志里两条不同调用的 id 相同，排查时对不上。
 *
 * @returns {string}
 */
function defaultCallId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `call_${Buffer.from(bytes).toString('hex')}`;
}

/**
 * 构造可信调用上下文。
 *
 * 导出是为了让测试能直接断言形状（以及断言"模型给的字段进不来"）。
 *
 * @param {object} input
 * @param {string} input.toolFullName
 * @param {import('../guard/origin.mjs').Origin} input.origin
 * @param {string} input.convKey
 * @param {string} [input.pluginId]
 * @param {{id?: string, nickname?: string}} [input.requester]
 * @param {unknown} [input.messageId]
 * @param {unknown} [input.replyToMessageId]
 * @param {string} input.callId
 * @param {number} [input.at]
 * @returns {object}
 */
export function makeInvocation(input) {
  const convKey = String(input.convKey ?? '');
  return Object.freeze({
    pluginId: String(input.pluginId ?? ''),
    tool: String(input.toolFullName ?? ''),
    origin: input.origin,
    convKey,
    isGroup: convKey.startsWith('group:'),
    requester: Object.freeze({
      id: String(input.requester?.id ?? ''),
      nickname: String(input.requester?.nickname ?? ''),
    }),
    messageId: input.messageId === undefined ? null : input.messageId,
    replyToMessageId: input.replyToMessageId === undefined ? null : input.replyToMessageId,
    callId: String(input.callId ?? ''),
    at: Number.isFinite(input.at) ? Number(input.at) : Date.now(),
  });
}

/**
 * @param {object} opts
 * @param {ReadonlyArray<object>} [opts.tools]
 * @param {object} [opts.policy]
 * @param {ToolRunContext} opts.context
 */
export function createToolRunner(opts) {
  const tools = opts.tools ?? listTools();
  /*
   * policy 支持两种写法：
   *   · `policy`      —— 固定对象（老调用方与测试）
   *   · `getPolicy()` —— 每次现取（宿主用它把"联网总闸"这类环境级开关
   *                     实时反映到工具可见集里）
   *
   * 为什么需要 getter：runner 在一个回合里是长期对象。若在构造时快照 policy，
   * 用户在回合中途关掉联网，`availableTools()` 仍会把搜索工具下发给模型 ——
   * 模型看得到、会调用、拿 E4080，然后换个说法重试。把它从下一次请求里
   * 结构性移除才是确定的。
   */
  const policyFor = typeof opts.getPolicy === 'function' ? opts.getPolicy : () => opts.policy;
  const ctx = opts.context;

  /**
   * 授权判定用的 `where`。
   *
   * 只传 convKey（用于区分群聊/私聊授权档）。**不要**往里加消息或 args：
   * 那会让授权判定变成"可被对话内容影响"，I14 就破了。
   */
  const where = { convKey: ctx.convKey };

  /**
   * 当前来源可见的工具（下发给模型的那份）。
   * 群聊来源在这里就已经是空集了——不是执行时才拒，是模型看不到。
   */
  function availableTools() {
    return resolveToolSet(ctx.origin, opts.tools ?? listTools(), policyFor(), where);
  }

  /**
   * @param {string} name
   * @param {unknown} rawArgs
   * @returns {Promise<{ok: true, result: any} | {ok: false, code: string, message: string}>}
   */
  async function run(name, rawArgs, options = {}) {
    const controller = new AbortController();
    const signals = [ctx.signal, options.signal, controller.signal].filter(Boolean);
    const signal = AbortSignal.any(signals);
    const deadline = Number(options.deadline);
    const timer = Number.isFinite(deadline)
      ? setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
      : null;
    try {
      if (signal.aborted || (Number.isFinite(deadline) && deadline <= Date.now())) {
        return { ok: false, code: 'E4070', message: '调用已取消或预算已耗尽' };
      }
      // 即使工具或审批不主动监听 signal，预算到点也必须结束宿主等待。
      return await abortable(execute(name, rawArgs, signal), signal);
    } catch (error) {
      if (signal.aborted || error?.code === 'E4070') {
        return { ok: false, code: 'E4070', message: '调用已取消或预算已耗尽' };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function execute(name, rawArgs, signal) {
    const currentTools = opts.tools ?? listTools();
    const tool = currentTools.find((t) => t.name === name);

    // 1) 不存在
    if (!tool) {
      record({ tool: name, denied: true, reason: 'unknown-tool', code: 'E4032' });
      return { ok: false, code: 'E4032', message: `工具不存在：${name}` };
    }

    // 2) 授权（唯一依据是 origin + 管理员配置，不看对话内容）
    const granted = resolveToolSet(ctx.origin, [tool], policyFor(), where).length > 0;
    if (!granted) {
      record({ tool: name, denied: true, reason: 'not-granted', code: 'E4032' });
      return { ok: false, code: 'E4032', message: `当前来源（${ctx.origin}）没有 ${name} 权限` };
    }

    // 3) 参数
    const parsed = validateParams(tool.params ?? {}, rawArgs);
    if (!parsed.ok) {
      record({ tool: name, denied: true, reason: 'bad-params', code: parsed.code });
      return { ok: false, code: parsed.code, message: parsed.message };
    }

    /*
     * 4) 人工确认
     *
     * 用 needsConfirmFor 而不是 needsConfirm：插件工具落进聊天来源之后，
     * "已授权 + 不收费"可以把 always 降成 never（管理员在配置里点过名），
     * 而收费工具仍然每次确认。非插件工具走原来的路径，行为不变。
     *
     * 例外是 `approval: "plugin"`：收费工具的"这一次"由插件自己的审批链路问
     * （例如私信管理员、引用回复 1/2）。这里跳过的是**重复的通用卡**，不是
     * 审批本身 —— 风险档与 effects 都不变，见 tool-gate.isApprovalDelegated。
     * 合法性在清单层已按 in-process + trusted + paid 校验。
     */
    const access = pluginChatAccess(tool, ctx.origin, policyFor(), where);
    if (!isApprovalDelegated(tool) && needsConfirmFor(tool, { chatGranted: access.granted })) {
      const verdict = ctx.askConfirm
        ? await abortable(ctx.askConfirm({ tool: name, risk: tool.risk, args: parsed.value, convKey: ctx.convKey }), signal)
        : 'deny';
      if (verdict !== 'allow') {
        record({ tool: name, denied: true, reason: 'not-confirmed', code: 'E4034', risk: tool.risk });
        return { ok: false, code: 'E4034', message: '操作未获批准，已取消' };
      }
    }

    // 4.5) 确认期间可能已经被取消（用户点了停止 / 插件被停用）
    if (signal?.aborted) {
      record({ tool: name, denied: true, reason: 'cancelled', code: 'E4070' });
      return { ok: false, code: 'E4070', message: '调用已取消' };
    }

    // 确认期间可能停用了插件；不得回退到创建 runner 时缓存的工具对象。
    const live = (opts.tools ?? listTools()).find((t) => t.name === name);
    if (live !== tool || resolveToolSet(ctx.origin, [live], policyFor(), where).length === 0) {
      return { ok: false, code: 'E4032', message: '工具已停用或授权已变更' };
    }

    /*
     * 5) 执行
     *
     * invocation 在这里构造并随 run 一起传给工具。插件工具会把它原样带到
     * 插件的 ctx.caller —— 这是"上下文由宿主生成"的落点。
     */
    const startedAt = Date.now();
    const callId = String(ctx.newCallId?.() ?? defaultCallId());
    const invocation = makeInvocation({
      toolFullName: name,
      origin: ctx.origin,
      convKey: ctx.convKey,
      pluginId: tool.plugin ?? '',
      requester: ctx.requester,
      messageId: ctx.messageId,
      replyToMessageId: ctx.replyToMessageId,
      callId,
      at: startedAt,
    });

    try {
      const result = await abortable(tool.run({
        args: parsed.value,
        origin: ctx.origin,
        convKey: ctx.convKey,
        invocation,
        signal,
      }), signal);
      /*
       * 工具**执行成功**，但插件返回的业务结果是失败（例如搜索被总闸拒绝、
       * 上游 401）。这两层必须分开记：
       *
       *   · 外层 ok:true  —— 调用链没坏，模型能看到结构化失败原因
       *   · failed 标记   —— 流水与统计要知道"这次没拿到结果"
       *
       * 只记外层成功会让 trace 与统计把"搜索失败"算成成功，排查时永远
       * 看不到真实失败率。
       */
      const inner = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
      const innerFailed = inner?.ok === false;
      record({
        tool: name,
        denied: false,
        risk: tool.risk,
        ms: Date.now() - startedAt,
        callId,
        argsDigest: digest(parsed.value),
        ...(innerFailed ? { failed: true, code: String(inner?.code ?? 'E50XX') } : {}),
      });
      return { ok: true, result };
    } catch (err) {
      const e = /** @type {any} */ (err);
      /*
       * 取消与失败分开报。
       *
       * 工具被取消时抛出来的很可能是 AbortError（fetch 干的），
       * 直接报成 E50XX 会让用户以为它坏了 —— 而事实是"你点了停止"。
       */
      const cancelled = e?.code === 'E4070' || e?.name === 'AbortError' || signal?.aborted === true;
      record({
        tool: name,
        denied: false,
        failed: true,
        cancelled,
        code: cancelled ? 'E4070' : (e?.code ?? 'E50XX'),
        ms: Date.now() - startedAt,
        callId,
        argsDigest: digest(parsed.value),
      });
      if (cancelled) return { ok: false, code: 'E4070', message: '调用已取消' };
      return { ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) };
    }
  }

  /** @param {object} rec */
  function record(rec) {
    ctx.onRecord?.({ at: Date.now(), convKey: ctx.convKey, origin: ctx.origin, ...rec });
  }

  return { availableTools, run, tools };
}

/**
 * 参数摘要：日志里不落完整参数（可能含长文本或路径）。
 *
 * @param {Record<string, any>} args
 */
function digest(args) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = v.length > 60 ? `${v.slice(0, 60)}…(${v.length})` : v;
    else out[k] = v;
  }
  return out;
}

// 完成与取消都移除监听器，避免同一回合连续调用积累监听。
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(Object.assign(new Error('调用已取消'), { code: 'E4070' }));
    };
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** 供提示层描述可用工具（不暴露 R3 细节给模型） */
export function describeForModel(tools) {
  return tools.map((t) => `- ${t.name}（${t.risk}）：${t.description}`).join('\n');
}

export { RISK, assertOrigin };
