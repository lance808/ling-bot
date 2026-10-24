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
 *
 * ## 思考内容（thinkingTrace）
 *
 * 推理模型每步返回的 `reasoning` 只累积到 `thinkingTrace` 里随返回值带出，
 * **绝不进 conversation**：一旦把思考拼回 messages，上游会直接 400
 * （官方明确禁止回传 reasoning_content），而且 token 会成倍上涨。
 * 回灌 assistant 消息时只放 `content` 与 `tool_calls`，这是有意的。
 *
 * ## 工具取回的图片（docs/vision-contract.md §7）
 *
 * 工具可以返回 `{ text, images }` 的结构化结果。图片**不能**塞进 tool 消息：
 * `wrapToolResult` 会把超过 8000 字符的内容截断，而一张 base64 图片轻松
 * 上百万字符 —— 塞进去的结果是"图片被截成半截字符串"，模型看到的是一堆
 * 乱码而不是画面，且不报错。所以这里拆成两条消息：
 *
 *   tool:  wrapToolResult(name, text + "（附 N 张图片，见下一条消息）")
 *   user:  [{type:'text', text:'（工具 xxx 取回的图片）'}, {type:'image_url',...}]
 *
 * tool 消息保持纯文本，协议兼容性不变；图片由紧随其后的 user 消息承载。
 */

import { wrapToolResult, isAllowedImageDataUrl, MAX_IMAGES_PER_MESSAGE } from './prompt.mjs';
import { mergeNativeSearchReports } from './provider-search.mjs';

export const MAX_STEPS = 8;
export const TOOL_BUDGET_MS = 30_000;

/**
 * 思考预览截到多长。
 *
 * 这里刻意留得比落盘上限（thinking.mjs 的 MAX_PREVIEW_CHARS=200）宽：
 * 预览是"摘要"，具体截断规则归仓库管，这里只负责别把整段正文一直攥在内存里。
 */
const PREVIEW_SLICE = 500;

/**
 * @typedef {object} LoopOptions
 * @property {{chat: Function}} llm
 * @property {{availableTools: () => object[], run: (name: string, args: unknown) => Promise<any>}} runner
 * @property {(schema: object) => object} toOpenAiTools
 * @property {AbortSignal} [signal]
 * @property {(delta: string) => void} [onDelta]
 * @property {(delta: string) => void} [onReasoningDelta] 思考内容逐块回调（只给界面看，不回灌）
 * @property {(info: object) => void} [onToolCall] 每次工具调用的可见通知（界面用）
 * @property {(info: object) => void} [onUsage]
 */

/**
 * 跑一回合。
 *
 * @param {LoopOptions & {messages: Array<{role: string, content: string}>, proactive?: boolean}} opts
 * @returns {Promise<{text: string, steps: number, cancelled: boolean, truncated: boolean, usage: object, toolTrace: object[], thinkingTrace: object[]}>}
 */
export async function runTurn(opts) {
  // 可用较小预算做本地验证，但任何调用方都不能把 30 秒上限调大。
  const requested = Number(opts.budgetMs);
  const budgetMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, TOOL_BUDGET_MS) : TOOL_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const controller = new AbortController();
  const signal = AbortSignal.any([opts.signal, controller.signal].filter(Boolean));
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await runTurnWithinBudget({ ...opts, signal, deadline, originalSignal: opts.signal });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function runTurnWithinBudget(opts) {
  const { llm, runner, messages, signal, onDelta, onReasoningDelta, onToolCall, onUsage, toOpenAiTools, deadline, originalSignal } = opts;
  /**
   * 本回合的原生联网证据（可能跨多次模型调用）。
   *
   * 必须让**三种返回路径**都带上它：正常结束、取消、触顶。只补正常路径
   * 是最典型的丢法 —— 用户点停止时恰好丢掉了"这次到底有没有联网"。
   */
  let nativeSearch = null;
  const stopped = () => ({ text: '', steps, cancelled: originalSignal?.aborted === true, truncated: originalSignal?.aborted !== true, usage: totalUsage, toolTrace, thinkingTrace, nativeSearch });
  const conversation = [...messages];
  const toolTrace = [];
  /** @type {Array<{n: number, reasoning: string, tools: string[], answerPreview: string}>} */
  const thinkingTrace = [];
  let steps = 0;
  // 模型调用次数（与工具步数不同：一次调用可能带 0 个或多个工具调用）
  let rounds = 0;
  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
  let truncated = false;

  while (steps < MAX_STEPS) {
    // 每次向模型发请求前刷新工具面，停用或关闸后不得继续下发旧列表。
    const tools = runner.availableTools();
    if (signal?.aborted) {
      return stopped();
    }

    // 预算耗尽：收尾，不再问模型
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }

    /*
     * 模型调用失败（上游 500 / 超时）时，把**失败前已经产生的思考**
     * 挂到错误对象上再抛。用户排查"它怎么答成这样"时，最需要看的
     * 恰恰是失败前那几步推理；丢掉它们，页面上就只剩一条孤零零的报错。
     *
     * 这里只包住单次调用，不包整个循环：错误要原样往上抛，
     * 上层的重试/降级逻辑（以及 turn-end 通知）不能被打断。
     */
    let res;
    try {
      res = await awaitWithinSignal(llm.chat({
        messages: conversation,
        tools: tools.length > 0 ? toOpenAiTools(tools) : undefined,
        signal,
        onDelta,
        onReasoningDelta,
        proactive: opts.proactive,
      }), signal);
    } catch (err) {
      if (signal.aborted) return stopped();
      if (err && typeof err === 'object') {
        /** @type {any} */ (err).thinkingTrace = thinkingTrace;
        /** @type {any} */ (err).toolTrace = toolTrace;
      }
      throw err;
    }

    rounds += 1;
    /*
     * 思考内容只在**这一步有内容时**才记一条。
     * 非推理模型（或上游没给 reasoning）时 thinkingTrace 会保持为空 ——
     * 上层据此静默降级（不写文件、不建空记录），而不是留一堆空对象。
     */
    if (typeof res.reasoning === 'string' && res.reasoning.trim().length > 0) {
      thinkingTrace.push({
        n: rounds,
        reasoning: res.reasoning,
        // 这一步调了哪些工具：让界面能显示"它想了什么、然后干了什么"
        tools: (res.toolCalls ?? []).map((tc) => tc?.name).filter((n) => typeof n === 'string' && n),
        answerPreview: String(res.text ?? '').slice(0, PREVIEW_SLICE),
      });
    }

    accumulate(totalUsage, res.usage);
    onUsage?.({ usage: res.usage, model: res.model, proactive: opts.proactive === true });
    // 上一步模型调用带回的联网证据：有就并入本回合（没有证据不会建成功态）
    nativeSearch = mergeNativeSearchReports(nativeSearch, res.webSearch ?? null);

    if (res.cancelled) {
      return stopped();
    }

    // 没有工具调用 → 这就是最终回答
    if (!res.toolCalls?.length) {
      return { text: res.text, steps, cancelled: false, truncated, usage: totalUsage, toolTrace, thinkingTrace, nativeSearch };
    }

    // 有工具调用：把模型的"意图"作为 assistant 消息记进对话，
    // 否则回灌 tool 结果时会缺少对应的调用记录（某些上游会因此 400）。
    // 注意这里**故意不带 reasoning** —— 见文件头注释。
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
      if (signal.aborted || Date.now() >= deadline) return stopped();
      if (steps >= MAX_STEPS) {
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
        : await awaitWithinSignal(runner.run(call.name, parsedArgs, { signal, deadline }), signal)
          .catch((error) => {
            if (signal.aborted) return { ok: false, code: 'E4070', message: '回合已取消或预算耗尽' };
            throw error;
          });

      /*
       * trace 要反映**真实结果**，而不只是"调用链没抛异常"。
       *
       * 插件/工具返回 `{ok:false, code}` 表示它执行了但没成功（联网关闭、
       * 上游 401、空 Key 等）。旧实现只看 outcome.ok，于是这些步骤在 trace
       * 里全是成功，统计也看不到失败率。
       */
      const inner = outcome.ok && outcome.result && typeof outcome.result === 'object'
        && !Array.isArray(outcome.result) ? outcome.result : null;
      const innerFailed = inner?.ok === false;
      toolTrace.push({
        step: steps,
        tool: call.name,
        ok: outcome.ok === true && !innerFailed,
        code: innerFailed ? (inner.code ?? 'E50XX') : (outcome.code ?? null),
      });
      if (signal.aborted || Date.now() >= deadline) return stopped();

      /*
       * 结构化结果里的图片：先校验再决定走哪条路。
       *
       * 结果里**根本没有 images 字段**时原样交给 wrapToolResult，输出与
       * 改动前逐字节一致（老工具、老插件的 `{content:'…'}` 不受影响）。
       * 有 images 字段时，无论校验剩几张，都改走 toolResultText ——
       * 它会把 images 摘掉，免得没通过白名单的 base64 被截断后混进提示词。
       */
      const images = outcome.ok ? readToolImages(outcome.result) : [];
      const resultForText = outcome.ok
        ? toolResultText(outcome.result, images)
        : `调用失败：${outcome.code ?? 'E50XX'} ${outcome.message ?? ''}`;

      // 回灌：无论成功失败都要回，否则模型不知道发生了什么会重复调用
      conversation.push({
        role: 'tool',
        // @ts-ignore  OpenAI 协议里 tool 消息需要 tool_call_id
        tool_call_id: call.id,
        content: wrapToolResult(call.name, resultForText),
      });

      /*
       * 图片作为**独立的一条 user 消息**紧跟其后（§7）。
       *
       * 为什么不拼进上一条 tool 消息：wrapToolResult 有 8000 字符截断，
       * 而一张 base64 图片通常上百万字符。拼进去的结果是图片被截成
       * 半截字符串——模型看到的是一堆乱码，且整条链路不会报任何错。
       *
       * 为什么是 user 而不是 assistant：这条消息的实际发出方是"工具"这个
       * 外部通道，不是模型自己；用 assistant 等于伪造模型说过的话。
       */
      if (images.length > 0) {
        conversation.push({
          role: 'user',
          content: [
            { type: 'text', text: `（工具 ${call.name} 取回的图片）` },
            ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
          ],
        });
      }
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
    thinkingTrace,
    nativeSearch,
  };
}

// 不配合取消的假模型/工具也不能把宿主等待拖过预算；真实任务仍收到同一信号。
function awaitWithinSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(Object.assign(new Error('回合已取消'), { code: 'E4070' }));
    };
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
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
 * 是否是"能带 images 字段"的普通对象。
 *
 * 数组和 null 都要排除：工具完全可能返回一个数组，而 `[].images` 是 undefined，
 * 但 `Array.isArray` 为真时 `{...arr}` 会变成数字键对象，把结果糟蹋掉。
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainResult(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 从工具结果里取出**校验过**的图片。
 *
 * `outcome.result.images` 是工具自报的形状，里面可能有任意字符串。
 * 这里只留通过 `isAllowedImageDataUrl` 白名单的项，并截到单条消息上限 ——
 * 校验不通过就静默丢弃，因为"工具想给图但给错了"不该让整回合失败
 * （§6 的非法 dataUrl 处理口径一致）。
 *
 * dataUrl 是唯一事实来源；`mime` / `label` 只用于展示与日志，不进请求体。
 *
 * @param {unknown} result
 * @returns {Array<{dataUrl: string, mime: string, label: string}>}
 */
function readToolImages(result) {
  if (!isPlainResult(result) || !Array.isArray(/** @type {any} */ (result).images)) return [];
  const out = [];
  for (const img of /** @type {any} */ (result).images) {
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
    const dataUrl = typeof img?.dataUrl === 'string' ? img.dataUrl : '';
    if (!isAllowedImageDataUrl(dataUrl)) continue;
    out.push({
      dataUrl,
      mime: typeof img?.mime === 'string' ? img.mime : '',
      label: typeof img?.label === 'string' ? img.label : '',
    });
  }
  return out;
}

/**
 * 把工具结果整理成**只含文本**的提示内容。
 *
 * ## 两种分支的差别是刻意的
 *
 * · 结果里没有 `images` 字段 → **原样返回**。老工具（`{content:'…'}`、
 *   纯字符串、数组……）走的就是 wrapToolResult 原本的 JSON.stringify 路径，
 *   一个字都不会变。向后兼容在这里落地。
 * · 有 `images` 字段 → 摘掉它再拼文本。base64 绝不能进提示文本：
 *   wrapToolResult 有 8000 字符截断，一张图就能把半截 base64 塞给模型，
 *   既浪费 token 又会让模型把乱码当成正常内容。图片由紧随其后的
 *   user 消息承载（见 runTurn 里的回灌段）。
 *
 * @param {unknown} result
 * @param {Array<{dataUrl: string, mime: string, label: string}>} images 已校验的图片
 * @returns {unknown} 字符串或"已去掉 images 的对象"
 */
function toolResultText(result, images) {
  if (!isPlainResult(result) || !Object.hasOwn(/** @type {any} */ (result), 'images')) return result;

  const src = /** @type {any} */ (result);
  const rest = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'text' || k === 'images') continue;
    rest[k] = v;
  }

  const parts = [];
  if (src.text !== undefined && src.text !== null) {
    parts.push(typeof src.text === 'string' ? src.text : JSON.stringify(src.text, null, 2));
  }
  // 除 text/images 之外的字段照旧 JSON.stringify 进文本（保持现有语义）
  if (Object.keys(rest).length > 0) parts.push(JSON.stringify(rest, null, 2));

  /*
   * 数量必须写出来：模型看到「见下一条消息」才知道下一条里的图属于这次调用，
   * 否则它会把图当成用户新发的内容。0 张时给另一句话 ——
   * 说"附 0 张图片，见下一条消息"而后面并没有消息，比不说更让人困惑。
   */
  parts.push(
    images.length > 0
      ? `（附 ${images.length} 张图片，见下一条消息）`
      : '（这次没有可提交的图片）',
  );

  return parts.filter((p) => p.length > 0).join('\n');
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
