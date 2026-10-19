/**
 * 工具调用循环 —— F7 / F14
 *
 * 一回合的完整形状：
 *
 *   messages → 模型 → 若返回 tool_calls → 逐个执行 → 结果回灌 → 再问模型 → … 直到出文本或触顶
 *
 * ## 三个硬上限（不是建议值）
 *
 *   MAX_STEPS  8 步：防止模型在两个工具之间来回打转，把 token 烧光
 *   BUDGET_MS  30 秒：工具总预算，防止一个慢工具拖死整回合
 *
 * 触顶后的行为很重要：**必须收尾并告知用户**，不能静默截断
 * （用户会以为机器人没听见，实际是它卡在工具里了）。
 *
 * ## 工具结果怎么回灌
 *
 * 一律作为独立的 `tool` 角色消息，内容用 wrapToolResult 包起来。
 * **绝不拼进 system prompt** —— 那是把外部内容抬成指令，是最典型的注入路径。
 */

import { wrapToolResult } from './prompt.mjs';

export const MAX_STEPS = 8;
export const TOOL_BUDGET_MS = 30_000;

/**
 * @typedef {object} LoopOptions
 * @property {{chat: Function}} llm
 * @property {{availableTools: () => object[], run: (name: string, args: unknown) => Promise<any>}} runner
 * @property {(schema: object) => object} toOpenAiTools
 * @property {AbortSignal} [signal]
 * @property {(delta: string) => void} [onDelta]
 * @property {(info: object) => void} [onToolCall] 每次工具调用的可见通知（界面用）
 * @property {(info: object) => void} [onUsage]
 */

/**
 * 跑一回合。
 *
 * @param {LoopOptions & {messages: Array<{role: string, content: string}>, proactive?: boolean}} opts
 * @returns {Promise<{text: string, steps: number, cancelled: boolean, truncated: boolean, usage: object, toolTrace: object[]}>}
 */
export async function runTurn(opts) {
  const { llm, runner, messages, signal, onDelta, onToolCall, onUsage, toOpenAiTools } = opts;

  const startedAt = Date.now();
  const conversation = [...messages];
  const toolTrace = [];
  let steps = 0;
  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
  let truncated = false;

  // 本回合可见工具：由来源决定，群聊在这里就是空集
  const tools = runner.availableTools();

  while (steps < MAX_STEPS) {
    if (signal?.aborted) {
      return { text: '', steps, cancelled: true, truncated, usage: totalUsage, toolTrace };
    }

    // 预算耗尽：收尾，不再问模型
    if (Date.now() - startedAt > TOOL_BUDGET_MS) {
      truncated = true;
      break;
    }

    const res = await llm.chat({
      messages: conversation,
      tools: tools.length > 0 ? toOpenAiTools(tools) : undefined,
      signal,
      onDelta,
      proactive: opts.proactive,
    });

    accumulate(totalUsage, res.usage);
    onUsage?.({ usage: res.usage, model: res.model, proactive: opts.proactive === true });

    if (res.cancelled) {
      return { text: '', steps, cancelled: true, truncated, usage: totalUsage, toolTrace };
    }

    // 没有工具调用 → 这就是最终回答
    if (!res.toolCalls?.length) {
      return { text: res.text, steps, cancelled: false, truncated, usage: totalUsage, toolTrace };
    }

    // 有工具调用：把模型的"意图"作为 assistant 消息记进对话，
    // 否则回灌 tool 结果时会缺少对应的调用记录（某些上游会因此 400）
    conversation.push({
      role: 'assistant',
      content: res.text ?? '',
      // @ts-ignore  OpenAI 协议里 assistant 消息可带 tool_calls
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const call of res.toolCalls) {
      if (Date.now() - startedAt > TOOL_BUDGET_MS) {
        truncated = true;
        break;
      }

      let parsedArgs = {};
      let parseError = null;
      try {
        parsedArgs = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        parseError = `参数不是合法 JSON：${String(call.arguments).slice(0, 120)}`;
      }

      steps += 1;
      onToolCall?.({ tool: call.name, args: parsedArgs, step: steps });

      const outcome = parseError
        ? { ok: false, code: 'E4041', message: parseError }
        : await runner.run(call.name, parsedArgs);

      toolTrace.push({ step: steps, tool: call.name, ok: outcome.ok === true, code: outcome.code ?? null });

      // 回灌：无论成功失败都要回，否则模型不知道发生了什么会重复调用
      const content = outcome.ok
        ? wrapToolResult(call.name, outcome.result)
        : wrapToolResult(call.name, `调用失败：${outcome.code ?? 'E50XX'} ${outcome.message ?? ''}`);

      conversation.push({
        role: 'tool',
        // @ts-ignore  OpenAI 协议里 tool 消息需要 tool_call_id
        tool_call_id: call.id,
        content,
      });
    }

    if (truncated) break;
  }

  // 走到这里说明触顶：给一个明确的收尾（不静默）
  return {
    text: '',
    steps,
    cancelled: false,
    truncated: true,
    usage: totalUsage,
    toolTrace,
  };
}

/**
 * @param {object} acc
 * @param {object} usage
 */
function accumulate(acc, usage) {
  acc.promptTokens += usage?.promptTokens ?? 0;
  acc.completionTokens += usage?.completionTokens ?? 0;
  acc.totalTokens += usage?.totalTokens ?? 0;
  // 只要有一次是估算，整体就标估算（不虚报精确）
  acc.estimated = acc.estimated || usage?.estimated === true;
}

/**
 * 触顶时给用户的说明。
 *
 * @param {{steps: number, truncated: boolean}} res
 * @returns {string | null}
 */
export function truncationNotice(res) {
  if (!res.truncated) return null;
  if (res.steps > 0) {
    return `（工具调用已达上限：${res.steps} 步 / ${Math.round(TOOL_BUDGET_MS / 1000)} 秒，我先停在这里。）`;
  }
  return '（这一轮处理超时了，先停在这里。）';
}
