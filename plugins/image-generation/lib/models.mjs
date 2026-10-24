/**
 * 上游模型目录探测 —— 只读、可搬移、无计费
 *
 * ## 它回答什么
 *
 * 1. 配置的独立生图端点是否暴露 OpenAI 兼容的 `GET {base}/models`；
 * 2. 上游目录里有哪些模型 ID；
 * 3. 目录是否在元数据里**声明**了生图、改图、视觉或聊天能力；
 * 4. 当前配置的模型（或调用方指定的模型）是否出现在目录里。
 *
 * ## 它不回答什么
 *
 * `/models` 的元数据在各家中转/服务商之间并不统一：很多实现只返回
 * `{id, object}`，甚至不实现这个端点。所以这里**绝不按模型名推断**
 * （`dall-e` / `flux` / `sd` 之类名字不是能力证据），也不把
 * “目录里没有”说成“不可用”。
 *
 * 更重要的是：**不通过真实生图请求验证能力**。一次 `POST
 * /images/generations` 就是一次计费调用，而且失败回包可能仍然收费；
 * 用“故意传错参数”来探测也不可靠（上游可能忽略参数按默认值出图）。
 * 因此本模块只做一次 GET，不改任务库、不写图片、不触发审批。
 *
 * ## 安全边界
 *
 * - 地址来自显式配置，可为本机 HTTP 服务，但拒绝 URL 内凭据/查询/片段；
 * - 只发一次 GET，不重试，拒绝任何 3xx（避免把 Key 带到别的主机）；
 * - 响应有 2 MiB 上限，模型数与单个字段都有上限；
 * - 错误只给本地 code/status，不透传上游正文（可能含 Key、内部地址或提示词）；
 * - 输出只含模型 ID、`ownedBy` 与声明能力，不返回原始响应。
 */

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_MODELS = 1000;
const DEFAULT_MAX_MODELS = 100;
const DEFAULT_TIMEOUT_MS = 15000;
const HOUR_MS = 60 * 60 * 1000;
/** 工具结果预算（宿主上限 256KiB，留出 note/配置核对等余量）。 */
const RESULT_BUDGET_BYTES = 160 * 1024;

/** 只用于本地结果与日志的错误；不携带上游正文。 */
export class ModelProbeError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'ModelProbeError';
    this.code = code;
    /** 模型探测永远是只读请求，没有“可能已计费”的不确定态。 */
    this.outcomeUnknown = false;
    if (status !== undefined) this.status = status;
  }
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, outcomeUnknown: false, ...extra };
}

/**
 * 去掉控制字符、压缩空白并截断。
 *
 * 上游目录是外部数据，模型 ID 里出现换行/ANSI/超长串时不能原样进入
 * 工具结果或日志。
 */
export function cleanText(value, max = 200) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) out += ' ';
    else out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 把配置地址规范成模型目录端点。
 *
 * 兼容三种常见填法：基址（`https://x/v1`）、已写到生图端点
 * （`.../images/generations`）以及已写到模型端点（`.../models`）。
 */
export function modelsEndpoint(apiUrl) {
  const raw = String(apiUrl ?? '').trim();
  if (!raw) throw new ModelProbeError('CONFIG_BAD_API_URL', '未配置生图 API 地址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ModelProbeError('CONFIG_BAD_API_URL', '生图 API 地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelProbeError('CONFIG_BAD_API_URL', '生图 API 地址必须是 http/https');
  }
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    throw new ModelProbeError('CONFIG_BAD_API_URL', '生图 API 地址不能包含凭据、查询参数或片段');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  // 地址可能被填成生图端点；先退回基址，避免拼出
  // /images/generations/models 这种不存在的路径。
  pathname = pathname.replace(/\/images\/(?:generations|edits)$/, '');
  if (!pathname.endsWith('/models')) pathname = `${pathname}/models`;
  url.pathname = pathname;
  return url.href;
}

function addToken(tokens, value) {
  if (tokens.size >= 64) return;
  const token = cleanText(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
  if (token) tokens.add(token);
}

/**
 * 从模型条目的**能力字段**里收集声明。
 *
 * 只读这些字段：capabilities / features / modalities / tasks / type /
 * metadata。刻意不读 `description`（噪声大、可能包含整段广告），
 * 也不读模型名本身。
 */
function declaredOf(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const fields = [
    'capabilities', 'capability', 'features', 'feature',
    'modalities', 'modality', 'input_modalities', 'output_modalities',
    'tasks', 'task', 'type', 'metadata',
  ];
  /** @type {Set<string>} */
  const tokens = new Set();
  let present = false;

  const visit = (value, depth, key) => {
    if (depth > 2 || tokens.size >= 64) return;
    if (typeof value === 'boolean') {
      // false 是明确的否定声明，不能因为键名出现就记成支持。
      if (value && key) addToken(tokens, key);
      return;
    }
    const negativeString = typeof value === 'string'
      && /^(?:false|no|none|0|unsupported|disabled)$/i.test(value.trim());
    if (typeof value === 'string') {
      // 字符串形式的 "false" 同样是否定声明，不能把键名记成支持。
      if (key && !negativeString) addToken(tokens, key);
      addToken(tokens, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) visit(item, depth + 1, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value).slice(0, 32)) visit(v, depth + 1, k);
    }
  };

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    present = true;
    visit(row[field], 0, field);
  }
  if (!present) return null;

  const match = (patterns) => {
    for (const token of tokens) {
      for (const pattern of patterns) if (pattern.test(token)) return token;
    }
    return null;
  };
  const imageGeneration = match([
    /image_generation/, /image_gen/, /text_to_image/, /generate_image/,
    /image_output/, /^images?$/, /t2i/,
  ]);
  const imageEditing = match([/image_edit/, /edit_image/, /inpaint/, /outpaint/, /^edits?$/]);
  const vision = match([/vision/, /image_input/, /image_url/, /multimodal/]);
  const chat = match([/chat/, /completion/, /text_generation/, /^text$/, /conversation/]);

  return {
    // null 表示“元数据里没有这项声明”，不等于确认不支持。
    imageGeneration: imageGeneration ? true : null,
    imageEditing: imageEditing ? true : null,
    vision: vision ? true : null,
    chat: chat ? true : null,
    metadataPresent: true,
    evidence: [imageGeneration, imageEditing, vision, chat].filter(Boolean).slice(0, 5),
  };
}

/**
 * 解析各种现实中的模型目录形状。
 *
 * 兼容裸数组、`{data:[...]}`、`{models:[...]}`，条目可为字符串或对象；
 * 对象里 `id` / `name` / `model` / `slug` 任一存在即可。
 * 去重后按 ID 排序，超过上限只截断返回，但 `total` 保留真实数量。
 */
export function parseModelCatalog(body, { maxModels = DEFAULT_MAX_MODELS } = {}) {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : null;
  if (rows === null) {
    throw new ModelProbeError('UPSTREAM_BAD_MODELS', '上游模型目录格式不受支持');
  }

  /** @type {Map<string, object>} */
  const byId = new Map();
  let invalidRows = 0;
  // 目录可能异常大；解析本身也要有硬上限，先截断候选行。
  for (const row of rows.slice(0, 20000)) {
    const id = typeof row === 'string'
      ? cleanText(row, 200)
      : cleanText(row?.id ?? row?.name ?? row?.model ?? row?.slug, 200);
    if (!id) {
      invalidRows += 1;
      continue;
    }
    if (byId.has(id)) continue;
    const ownedBy = typeof row === 'object' && row !== null
      ? cleanText(row?.owned_by ?? row?.ownedBy ?? row?.owner ?? row?.provider ?? row?.creator, 120)
      : '';
    /** @type {any} */
    const entry = { id };
    if (ownedBy) entry.ownedBy = ownedBy;
    const declared = typeof row === 'object' && row !== null ? declaredOf(row) : null;
    if (declared) entry.declared = declared;
    byId.set(id, entry);
  }

  const all = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const limit = clamp(maxModels, 1, HARD_MAX_MODELS, DEFAULT_MAX_MODELS);
  return {
    models: all.slice(0, limit),
    total: all.length,
    truncated: all.length > limit,
    invalidRows,
  };
}

/**
 * 在当前返回的目录里核对一个模型。
 *
 * 先精确匹配，再大小写不敏感匹配；不做前缀/模糊匹配 —— 模糊匹配会让
 * `flux` 命中 `flux-pro` 之类，进而给出错误的“存在”结论。
 */
export function findCatalogModel(models, wanted) {
  const id = cleanText(wanted, 200);
  if (!id) return { id: '', entry: null, matchedBy: null };
  const exact = models.find((m) => m.id === id);
  if (exact) return { id, entry: exact, matchedBy: 'exact' };
  const lowered = id.toLowerCase();
  const ci = models.find((m) => m.id.toLowerCase() === lowered);
  if (ci) return { id, entry: ci, matchedBy: 'case-insensitive' };
  return { id, entry: null, matchedBy: null };
}

async function discard(response) {
  try {
    Promise.resolve(response?.body?.cancel()).catch(() => {});
  } catch {
    /* 尽力而为 */
  }
}

async function readBoundedJson(response, limit) {
  const declared = response?.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await discard(response);
    throw new ModelProbeError('UPSTREAM_TOO_LARGE', `模型目录响应超过 ${limit} 字节上限`);
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          try {
            await reader.cancel();
          } catch {
            /* 尽力而为 */
          }
          throw new ModelProbeError('UPSTREAM_TOO_LARGE', `模型目录响应超过 ${limit} 字节上限`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 已释放 */
      }
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    } catch {
      throw new ModelProbeError('UPSTREAM_BAD_JSON', '模型目录不是合法 JSON');
    }
  }

  let text;
  try {
    text = await response.text();
  } catch {
    throw new ModelProbeError('UPSTREAM_BAD_RESPONSE', '模型目录响应不可读');
  }
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new ModelProbeError('UPSTREAM_TOO_LARGE', `模型目录响应超过 ${limit} 字节上限`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelProbeError('UPSTREAM_BAD_JSON', '模型目录不是合法 JSON');
  }
}

/**
 * 一次只读模型目录请求。
 *
 * @param {object} input
 * @param {string} input.apiUrl 独立生图 API 地址（可为完整 generations 端点）
 * @param {string} input.apiKey 独立生图 Key；只进 Authorization 头
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 * @param {typeof fetch} [input.fetchImpl] 测试接缝
 * @param {number} [input.maxBytes]
 * @param {number} [input.maxModels]
 * @returns {Promise<{endpoint: string, models: object[], total: number, truncated: boolean, invalidRows: number}>}
 */
export async function listModels({
  apiUrl,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_RESPONSE_BYTES,
  maxModels = DEFAULT_MAX_MODELS,
} = {}) {
  const endpoint = modelsEndpoint(apiUrl);
  const key = String(apiKey ?? '').trim();
  if (!key || /[\x00-\x1f\x7f]/.test(key)) {
    throw new ModelProbeError('CONFIG_BAD_API_KEY', '未配置可用的独立生图 API Key');
  }
  if (signal?.aborted) throw new ModelProbeError('UPSTREAM_ABORTED', '模型目录请求已取消');

  const budget = clamp(timeoutMs, 1000, 60000, DEFAULT_TIMEOUT_MS);
  const limit = clamp(maxBytes, 1024, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
  const controller = new AbortController();
  let abortError = null;
  /** @type {(v?: any) => void} */
  let rejectAbort = () => {};
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (code) => {
    if (abortError) return;
    abortError = new ModelProbeError(
      code,
      code === 'UPSTREAM_TIMEOUT' ? '模型目录请求超时（只读请求，未计费）' : '模型目录请求已取消（只读请求，未计费）',
    );
    controller.abort();
    rejectAbort(abortError);
  };
  const onAbort = () => abort('UPSTREAM_ABORTED');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort('UPSTREAM_TIMEOUT'), budget);
  const check = () => {
    if (abortError) throw abortError;
  };

  const work = async () => {
    check();
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${key}`,
        },
      });
    } catch {
      if (abortError) throw abortError;
      throw new ModelProbeError('UPSTREAM_UNREACHABLE', '无法连接上游模型目录（只读请求，未计费）');
    }
    check();
    const status = Number(response?.status);
    if (!Number.isFinite(status)) {
      throw new ModelProbeError('UPSTREAM_BAD_RESPONSE', '上游模型目录返回异常响应（只读请求，未计费）');
    }
    if (status >= 300 && status < 400) {
      await discard(response);
      throw new ModelProbeError('UPSTREAM_REDIRECT', '上游模型目录返回重定向，已拒绝跟随（只读请求，未计费）', { status });
    }
    if (status < 200 || status >= 300) {
      await discard(response);
      throw new ModelProbeError('UPSTREAM_HTTP_ERROR', `上游模型目录返回 HTTP ${status}（只读请求，未计费）`, { status });
    }
    const body = await readBoundedJson(response, limit);
    check();
    // 200 + {error:...} 的网关很常见；不能把它当成“目录为空”。
    const hasRows = Array.isArray(body) || Array.isArray(body?.data) || Array.isArray(body?.models);
    if (body?.error && !hasRows) {
      throw new ModelProbeError('UPSTREAM_ERROR', '上游模型目录返回错误（只读请求，未计费）');
    }
    const parsed = parseModelCatalog(body, { maxModels });
    return { endpoint, ...parsed };
  };

  try {
    return await Promise.race([work(), abortPromise]);
  } catch (error) {
    if (abortError) throw abortError;
    if (error instanceof ModelProbeError) throw error;
    throw new ModelProbeError('UPSTREAM_BAD_RESPONSE', '模型目录探测失败（只读请求，未计费）');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // 让不合作的传输在总预算到点时也松开连接。
    controller.abort();
  }
}

/**
 * 带限流与结果整理的探测门面。
 *
 * 限流是**进程内**的：插件重启后清零。它防的是脚本化反复打上游目录，
 * 不是安全边界。真正的开销控制仍在上游：一次 GET，不重试。
 */
export class ModelProbe {
  /**
   * @param {object} input
   * @param {object} input.config 已归一化配置
   * @param {string} input.apiKey
   * @param {typeof listModels} [input.listFn] 测试接缝
   * @param {() => number} [input.now]
   */
  constructor({ config, apiKey, listFn = listModels, now = Date.now } = {}) {
    this.cfg = config ?? {};
    this.apiKey = String(apiKey ?? '');
    this.listFn = listFn;
    this.now = now;
    this.inFlight = false;
    /** @type {Map<string, {windowStart: number, count: number, lastAt: number}>} */
    this.byRequester = new Map();
  }

  get enabled() {
    return this.cfg.probeEnabled !== false;
  }

  sweep(now) {
    if (this.byRequester.size <= 64) return;
    for (const [id, entry] of this.byRequester) {
      if (now - entry.windowStart > HOUR_MS && now - entry.lastAt > 10 * 60 * 1000) {
        this.byRequester.delete(id);
      }
    }
    // 即使请求者很多，也不让进程内计数表无限增长。
    if (this.byRequester.size > 256) {
      const oldest = [...this.byRequester.entries()]
        .sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (oldest) this.byRequester.delete(oldest[0]);
    }
  }

  /**
   * @param {object} input
   * @param {string} [input.requesterId] 可信请求者（主人私聊/桌面端）
   * @param {string} [input.model] 要核对的模型；省略用配置模型
   * @param {AbortSignal} [input.signal]
   */
  async run({ requesterId = 'console', model = '', signal } = {}) {
    if (!this.enabled) return fail('IMAGE_PROBE_DISABLED', '模型探测已在插件配置中关闭');
    if (!this.cfg.apiUrl || !this.apiKey) return fail('IMAGE_PROBE_NOT_CONFIGURED', '请先配置独立生图 API 地址与 Key');
    if (signal?.aborted) return fail('IMAGE_PROBE_ABORTED', '模型探测已取消');

    const now = Number(this.now()) || Date.now();
    this.sweep(now);
    const who = cleanText(requesterId, 64) || 'console';
    let record = this.byRequester.get(who);
    if (this.inFlight) return fail('IMAGE_PROBE_BUSY', '已有模型探测在运行，请稍后再试');
    if (record) {
      if (now - record.windowStart >= HOUR_MS) {
        record.windowStart = now;
        record.count = 0;
      }
      const cooldown = clamp(this.cfg.probeCooldownMs, 0, 600000, 10000);
      if (cooldown > 0 && now - record.lastAt < cooldown) {
        const retryAfterMs = Math.max(0, cooldown - (now - record.lastAt));
        return fail('IMAGE_PROBE_RATE_LIMITED', `模型探测太频繁，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`, { retryAfterMs });
      }
      const perHour = clamp(this.cfg.probePerHour, 1, 600, 60);
      if (record.count >= perHour) {
        return fail('IMAGE_PROBE_RATE_LIMITED', '本小时模型探测次数已达上限', {
          retryAfterMs: Math.max(0, record.windowStart + HOUR_MS - now),
        });
      }
    } else {
      record = { windowStart: now, count: 0, lastAt: 0 };
    }
    record.lastAt = now;
    record.count += 1;
    this.byRequester.set(who, record);

    this.inFlight = true;
    try {
      const maxModels = clamp(this.cfg.probeMaxModels, 1, HARD_MAX_MODELS, DEFAULT_MAX_MODELS);
      const catalog = await this.listFn({
        apiUrl: this.cfg.apiUrl,
        apiKey: this.apiKey,
        timeoutMs: this.cfg.probeTimeoutMs,
        // 核对要看到完整目录；输出展示上限另算，避免“模型排在 101 位就被误报不存在”。
        maxModels: HARD_MAX_MODELS,
        signal,
      });
      // 即使注入的 listFn 没有按上限裁剪，也不把超大目录塞进工具结果。
      if (!Array.isArray(catalog?.models)) {
        throw new ModelProbeError('UPSTREAM_BAD_MODELS', '上游模型目录格式不受支持');
      }
      const total = Math.max(0, Number.isFinite(catalog.total) ? catalog.total : catalog.models.length);
      const completeCatalog = catalog.models.length >= total;
      const wanted = cleanText(model, 200) || cleanText(this.cfg.model, 200);
      // 在完整目录（最多 HARD_MAX_MODELS）里核对；输出列表再裁剪。
      const found = findCatalogModel(catalog.models, wanted);
      const models = catalog.models.slice(0, maxModels);
      // 工具结果体积预算；宿主单次结果硬限 256KiB。
      const measure = (list) => Buffer.byteLength(
        JSON.stringify({ endpoint: catalog.endpoint, total, models: list }),
        'utf8',
      );
      while (models.length > 1 && measure(models) > RESULT_BUDGET_BYTES) models.pop();
      const trimmedForSize = models.length < Math.min(catalog.models.length, maxModels);
      const truncated = catalog.truncated === true || !completeCatalog || catalog.models.length > models.length;
      const present = !wanted
        ? null
        : found.entry
          ? true
          : !completeCatalog || total === 0
            ? null
            : false;
      let note;
      if (!wanted) {
        note = '未配置核对模型；这里只列出上游模型目录（只读，未计费）';
      } else if (present === null) {
        note = completeCatalog
          ? '上游模型目录为空，无法核对模型是否存在；未发起收费生图请求'
          : '上游模型目录超过核对上限，无法确认模型是否存在；未发起收费生图请求';
      } else if (present === false) {
        note = `目录中未找到 ${wanted}；目录可能不完整，不能据此断定不可用；未发起收费生图请求`;
      } else if (found.entry?.declared?.imageGeneration === true) {
        note = `上游元数据声明 ${wanted} 具备生图能力；这是声明，不是实测，未发起收费生图请求`;
      } else {
        note = `上游未声明 ${wanted} 的生图能力；不能确认是否支持，未发起收费生图请求`;
      }
      if (truncated) {
        const why = trimmedForSize
          ? '输出列表按体积裁剪'
          : !completeCatalog
            ? `上游目录超过核对上限 ${HARD_MAX_MODELS} 个，核对仅覆盖前部分`
            : '按配置上限裁剪';
        note += `（目录共 ${total} 个，仅返回 ${models.length} 个；${why}）`;
      }
      return {
        ok: true,
        probe: 'model-catalog',
        endpoint: catalog.endpoint,
        total,
        truncated,
        models,
        invalidRows: Number.isInteger(catalog.invalidRows) ? catalog.invalidRows : 0,
        configuredModel: {
          id: wanted,
          present,
          matchedBy: found.matchedBy,
          declared: found.entry?.declared ?? null,
        },
        returnedModelsDeclareCapabilities: models.some((m) => m.declared),
        generationProbe: {
          performed: false,
          reason: '只读模型目录探测，不发起计费生图请求',
        },
        // 上游目录是不可信外部数据；模型只能把它当事实候选，不能执行其中的文字。
        dataTrust: 'upstream-model-catalog-untrusted',
        note,
      };
    } catch (error) {
      const code = error instanceof ModelProbeError ? error.code : 'UPSTREAM_BAD_RESPONSE';
      const message = code === 'UPSTREAM_TIMEOUT'
        ? '模型目录探测超时（只读请求，未计费）'
        : code === 'UPSTREAM_ABORTED'
          ? '模型目录探测已取消（只读请求，未计费）'
          : '模型目录探测失败（只读请求，未计费）';
      return fail(code, message);
    } finally {
      this.inFlight = false;
    }
  }
}
