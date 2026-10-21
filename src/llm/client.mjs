/**
 * LLM 客户端 —— F7
 *
 * 直连 OpenAI 兼容 `/v1/chat/completions`，用 Node 内置 fetch（无需第三方 SDK）。
 *
 * 三条纪律：
 *   1. **不逐字转发**：流式只推到界面，回合结束一次性发 QQ（避免刷屏与半句话）。
 *   2. **可中断**：AbortController 真断连接，已收内容不发送，回合标记 cancelled。
 *   3. **重试只对连接类错误**：4xx 重试没有意义，只会放大问题。
 */

/** 连接类错误（值得重试一次）；4xx 一律不重试 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'EPIPE',
]);

/**
 * @typedef {object} LlmOptions
 * @property {string} baseUrl
 * @property {string} model
 * @property {string} apiKey
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @property {'auto' | 'off' | 'deepseek' | 'openai' | 'anthropic' | 'qwen'} [thinking]
 *   思考开关注入方式，见 resolveThinkingBody()
 */

/**
 * 各家的「打开思考」写法。
 *
 * ## 为什么需要这张表（这里真的踩过）
 *
 * 请求体原本只有 `model / messages / stream`，思考内容完全依赖上游**默认**
 * 行为。同一个人把模型从 A 换成 B，A 默认带 reasoning、B 默认不带，
 * 于是思考链路从此一片空白 —— 而这中间没有任何报错，因为请求本身是成功的，
 * 只是少了那个字段。
 *
 * `deepseek-v4.1-flash` 这类模型本身是推理模型，但不少中转要求显式
 * 打开才会返回 `reasoning_content`。所以这里按"用哪种写法"分派，
 * 而不是去猜模型名。
 *
 * 每一项是**要合并进请求体**的片段。空对象表示"什么都不加"。
 */
export const THINKING_STYLES = Object.freeze({
  // DeepSeek 官方与多数兼容中转
  deepseek: { thinking: { type: 'enabled' } },
  // OpenAI 新式（o 系列 / gpt-5 一脉）
  openai: { reasoning_effort: 'medium' },
  // Anthropic 直连风格
  anthropic: { thinking: { type: 'enabled', budget_tokens: 4096 } },
  // 通义/百炼一脉
  qwen: { enable_thinking: true },
  off: {},
});

/**
 * 算出这次请求该额外带什么"打开思考"的字段。
 *
 * 语义分两层，别混淆：
 *   · **没传 / `auto`** → 不注入任何字段（本函数的行为）
 *   · 配置项 `llm.thinking` 的**默认值**是 `openai`（见 config/schema.mjs），
 *     所以正常运行时配置会传一个明确风格进来，走的是下面的查表分支
 *
 * 函数本身为什么不对 undefined 兜底成 openai：`LlmClient` 还有探测、测试这类
 * 内部调用方，它们不该被"用户的默认偏好"悄悄改变行为。默认值放在配置层，
 * 内部调用保持"不写就不发"的可预测性。
 *
 * `auto` 依然是显式选项：有些上游对不认识的字段直接 400，
 * 那时用户需要一条"什么都不加"的退路。
 *
 * @param {string | undefined} style
 * @returns {Record<string, any>}
 */
export function resolveThinkingBody(style) {
  if (!style || style === 'auto') return {};
  return { ...(THINKING_STYLES[/** @type {keyof typeof THINKING_STYLES} */ (style)] ?? {}) };
}

export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, retryable?: boolean, reason?: string}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = meta.code ?? 'E30XX';
    this.status = meta.status ?? null;
    this.retryable = meta.retryable ?? false;
    this.reason = meta.reason ?? null;
  }
}

export class LlmClient {
  /** @type {LlmOptions} */
  #opts;

  constructor(opts) {
    if (!opts?.baseUrl) throw new TypeError('baseUrl 必填');
    if (!opts?.model) throw new TypeError('model 必填');
    this.#opts = {
      timeoutMs: 120_000,
      maxRetries: 1,
      ...opts,
    };
  }

  get configured() {
    return Boolean(this.#opts.apiKey);
  }

  /**
   * 拼出 chat/completions 的完整 URL。
   *
   * 现实里的 baseUrl 有两种写法，都必须支持：
   *   https://api.deepseek.com        → 补 /v1/chat/completions
   *   https://xxx.com/v1              → 补 /chat/completions（**不能再加一个 /v1**）
   *   https://xxx.com/v1/chat/completions → 原样使用
   *
   * 不做这个判断的话，填了带 /v1 的地址就会打到 /v1/v1/chat/completions，
   * 表现为莫名其妙的 404——而用户会以为是 key 错了。
   *
   * @returns {string}
   */
  chatUrl() {
    const base = trimSlash(this.#opts.baseUrl);
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  /**
   * 模型目录地址（OpenAI 兼容的 `GET /models`）。
   *
   * 与 chatUrl 同样的规范化逻辑：填到 /v1 就用 /v1/models，
   * 只填域名就补 /v1/models。两处必须保持一致，
   * 否则会出现"对话能通但读目录 404"这种割裂现象。
   *
   * @returns {string}
   */
  modelsUrl() {
    const base = trimSlash(this.#opts.baseUrl);
    // 用户可能把 chat 地址整个填进来，这里回退到同级目录
    if (/\/chat\/completions$/.test(base)) return `${base.replace(/\/chat\/completions$/, '')}/models`;
    if (/\/v\d+$/.test(base)) return `${base}/models`;
    return `${base}/v1/models`;
  }

  /**
   * 读服务商实际提供的模型列表。
   *
   * 为什么值得做：模型名是手填的，拼错一个字的表现是 404 /
   * "Model is not supported"，用户没法判断是名字错还是服务不可用。
   * 直接从服务商读，拼错这件事从根上不存在。
   *
   * **只读**：不解密、不留存、不改配置。读失败就抛错让上层降级。
   *
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<string[]>}
   */
  async listModels(opts = {}) {
    if (!this.configured) throw new LlmError('还没配置 API Key', { code: 'E3020' });

    let res;
    try {
      res = await fetch(this.modelsUrl(), {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#opts.apiKey}` },
        signal: opts.signal ?? AbortSignal.timeout(this.#opts.timeoutMs ?? 20000),
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      throw new LlmError(`连不上模型服务：${e?.message ?? e}`, { code: 'E3012' });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(`读模型列表失败（HTTP ${res.status}）：${body.slice(0, 200)}`, { code: 'E3021' });
    }

    // 关键：不能只看状态码。实测不少中转站会把未知路径**回退到首页**，
    // 于是 baseUrl 填错时拿到的是 HTTP 200 + 一段 HTML —— 状态码完全正常。
    // 如果只按 200 判断，这里会解析出"0 个模型"并显示成"读取成功"，
    // 用户会以为服务商一个模型都没提供。这是静默失败，必须显式拦下。
    const raw = await res.text().catch(() => '');
    const looksHtml = /^\s*<(!doctype|html)/i.test(raw);
    if (looksHtml) {
      throw new LlmError(
        `这个地址返回的是网页而不是模型列表（${this.modelsUrl()}）。检查 baseUrl 是否填对。`,
        { code: 'E3021' },
      );
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LlmError(`模型列表不是 JSON（${this.modelsUrl()}）：${raw.slice(0, 120)}`, { code: 'E3021' });
    }

    // 兼容两种形状：{data:[{id}]}（OpenAI 标准）与 [{id}]（部分中转）
    const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    const ids = arr
      .map((m) => (typeof m === 'string' ? m : m?.id))
      .filter((id) => typeof id === 'string' && id.length > 0);

    // 解析成功但一个都没有：说明接口形状不对，同样是错，不能当"成功但为空"
    if (ids.length === 0) {
      if (Array.isArray(data) || Array.isArray(data?.data)) {
        throw new LlmError(
          `服务商返回空模型目录（${this.modelsUrl()}）。当前 Key 未列出可用模型，请到服务商控制台检查令牌分组与模型权限，或手填服务商确认可用的模型名。`,
          { code: 'E3021', reason: 'empty_catalog' },
        );
      }
      throw new LlmError(`模型列表格式无法识别（${this.modelsUrl()}），需要 {data:[{id}]} 或模型数组`, { code: 'E3021' });
    }

    // 去重并排序：目录乱序时下拉框会跳来跳去
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  /**
   * 发起一次对话（流式）。
   *
   * @param {object} req
   * @param {Array<{role: string, content: string}>} req.messages
   * @param {object[]} [req.tools] OpenAI 兼容的 function tools
   * @param {AbortSignal} [req.signal] 外部中断信号（界面「停止」）
   * @param {(delta: string) => void} [req.onDelta] 逐块回调（只给界面看）
   * @param {(delta: string) => void} [req.onReasoningDelta] 思考内容逐块回调（**只给界面看**）
   * @param {boolean} [req.proactive] 主动回合标记（记账用）
   * @returns {Promise<{text: string, reasoning: string, toolCalls: object[], usage: object, model: string, cancelled: boolean}>}
   */
  async chat(req) {
    let lastErr = null;
    const attempts = (this.#opts.maxRetries ?? 1) + 1;

    for (let i = 0; i < attempts; i++) {
      try {
        return await this.#once(req);
      } catch (err) {
        const e = /** @type {LlmError} */ (err);
        lastErr = e;
        // 用户主动中断：不重试，直接返回已收内容
        if (e.code === 'E3010') {
          return cancelledResult(this.#opts.model);
        }
        if (!e.retryable || i === attempts - 1) break;
        // 退避：1s → 2s
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** i));
      }
    }
    throw lastErr;
  }

  /**
   * @param {object} req
   * @returns {Promise<{text: string, reasoning: string, toolCalls: object[], usage: object, model: string, cancelled: boolean}>}
   */
  async #once(req) {
    // 外部中断与超时合并成一个信号
    const timeoutSignal = AbortSignal.timeout(this.#opts.timeoutMs);
    const signal = req.signal ? anySignal([req.signal, timeoutSignal]) : timeoutSignal;

    /** @type {Record<string, any>} */
    const body = {
      model: this.#opts.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      /*
       * 思考开关。放在最前面合并，让下面的 tools 等业务字段可以覆盖它
       * （万一某个上游把同名键用作别的含义）。
       */
      ...resolveThinkingBody(this.#opts.thinking),
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }

    let res;
    try {
      res = await fetch(this.chatUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (req.signal?.aborted) {
        return cancelledResult(this.#opts.model);
      }
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new LlmError(`模型 ${this.#opts.timeoutMs}ms 内无响应`, { code: 'E3011', retryable: true });
      }
      throw new LlmError(`连接模型失败：${e?.message ?? e}`, {
        code: 'E3012',
        retryable: RETRYABLE_CODES.has(e?.code) || e?.name === 'TypeError',
      });
    }

    if (!res.ok) {
      const detail = await safeText(res);
      // 4xx 不重试：key 错、模型名错，重试只会重复失败
      throw new LlmError(`模型返回 ${res.status}：${detail.slice(0, 300)}`, {
        code: res.status === 401 || res.status === 403 ? 'E3020' : 'E3021',
        status: res.status,
        retryable: res.status >= 500,
      });
    }

    return parseSse(res, req.onDelta, this.#opts.model, req.onReasoningDelta);
  }
}

/**
 * 中断时的统一返回值。
 *
 * @param {string} model
 */
function cancelledResult(model) {
  return {
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: emptyUsage(),
    model,
    cancelled: true,
  };
}

/**
 * 解析 SSE 流。
 *
 * ## 思考内容（reasoning）三条纪律
 *
 * 1. **只累积，不回灌**：`reasoning` 是返回值里的一等字段，但绝不允许被上层
 *    拼进下一次请求的 messages。DeepSeek 官方明确说过不要把 reasoning_content
 *    传回去（会 400），而且它比正文长得多，回灌会让 token 暴涨。
 *    本文件只负责"收下来"，怎么用由上层决定（见 agent-loop 的 thinkingTrace）。
 * 2. **字段名三种都要认**：`reasoning_content`（DeepSeek）、`reasoning`（部分中转）、
 *    `thinking`（Anthropic 风格）。只认一个的话，换个上游就静默丢光了。
 *    同一 chunk 里按这个优先级取第一个非空，避免三家都填时内容被重复拼。
 * 3. **它是分片到达的**：和 content 一样要逐块累积，不能只取最后一次的 chunk。
 *
 * @param {Response} res
 * @param {((d: string) => void) | undefined} onDelta
 * @param {string} model
 * @param {((d: string) => void) | undefined} [onReasoningDelta]
 */
async function parseSse(res, onDelta, model, onReasoningDelta) {
  if (!res.body) throw new LlmError('模型响应没有 body', { code: 'E3021' });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let text = '';
  let reasoning = '';
  /** @type {Map<number, {id: string, name: string, args: string}>} */
  const toolAcc = new Map();
  let usage = emptyUsage();
  let usedModel = model;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 半包/脏包跳过，不打断整条流
        }

        if (chunk.model) usedModel = chunk.model;
        if (chunk.usage) usage = normalizeUsage(chunk.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content;
          onDelta?.(delta.content);
        }

        /*
         * 思考内容可能挂在 delta 上（流式增量），也可能挂在 message 上
         * （个别中转把整段一次给过来，仍走 SSE 但只发一个 chunk）。
         * 两处都看，代价可以忽略。
         */
        const thinkChunk = pickReasoning(delta) ?? pickReasoning(choice.message);
        if (thinkChunk) {
          reasoning += thinkChunk;
          onReasoningDelta?.(thinkChunk);
        }

        // 工具调用是分片到达的：按 index 累积 name 与 arguments 字符串
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const slot = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
            toolAcc.set(idx, slot);
          }
        }
      }
    }
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }));

  return { text, reasoning, toolCalls, usage, model: usedModel, cancelled: false };
}

/**
 * 从一坨对象里取思考文本。
 *
 * 优先级 `reasoning_content` > `reasoning` > `thinking`：
 * 取第一个非空而不是全部拼起来 —— 三家上游同时填同一个值时，
 * 拼起来会把同一段思考存三遍，界面看着像复读。
 *
 * @param {any} obj
 * @returns {string | null}
 */
function pickReasoning(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * @param {any} usage
 */
export function normalizeUsage(usage) {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens;
  return {
    ...(Number.isFinite(cached) && cached >= 0 ? { cachedTokens: cached } : {}),
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    /** 无 usage 时按字符估算；这个标记决定界面上是否显示"估算" */
    estimated: false,
  };
}

function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true };
}

/**
 * 合并多个中断信号（外部取消 + 超时）。
 *
 * @param {AbortSignal[]} signals
 * @returns {AbortSignal}
 */
function anySignal(signals) {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/**
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** @param {string} s */
function trimSlash(s) {
  return s.replace(/\/+$/, '');
}

/**
 * 无 `usage` 时的字符估算（明确标注，不假装精确）。
 *
 * 经验值：中文约 1.5 字/token，英文约 4 字符/token。这里取保守折中。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}
