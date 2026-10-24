/**
 * 聊天模型能力探测 —— 视觉（读图）与通道类型
 *
 * ## 这里**不探测生图**
 *
 * 生图（`POST /images/generations` 那类接口）是**另一套服务、另一把 Key、
 * 另一个模型**，归独立插件 `plugins/image-generation` 管理。拿聊天模型的
 * 地址和 Key 去试生图端点，既可能误判（中转的聊天与生图常常不是同一家），
 * 又会在用户只是想知道"能不能读图"时**真的花掉一次生图的钱**。
 *
 * 所以本模块只负责视觉能力；生图能力不由聊天模型宣布，也不按模型名推断。
 *
 * ## 为什么不查表
 *
 * 同一个模型名在不同中转站的能力可能不同：官方支持的视觉，白牌中转可能没接；
 * 中转可能把 `gpt-4o` 转到一个纯文本后端。所以**能力只能实测**，
 * 不能按名字猜。
 *
 * 参考项目 qq-bridge 的做法也是实测：发一张微型图片问"这是什么颜色"，
 * 能正常回答就算支持视觉。这里同样做法。
 *
 * ## 一个必须说清的边界
 *
 * 探测发的是**真实请求**，会消耗额度（虽然极少：一张 64×64 图 + 几个 token）。
 * 所以只在用户点按钮时探测，绝不在启动时自动跑。
 *
 * ## "没测出来" ≠ "不支持"
 *
 * 超时、网络错、额度不足都会导致探测失败，但这不代表模型没有这个能力。
 * 所以返回值里 `supported` 只在**拿到了明确结论**时才给 true/false，
 * 网络层失败返回 `supported: null`。界面据此区分三种状态。
 */

import zlib from 'node:zlib';

import { LlmError } from './client.mjs';

/**
 * 1×1 红色 PNG（base64）。
 *
 * 用 64×64 纯红图，**不能用 1×1**。
 *
 * 实测教训：部分模型有图像尺寸下限，1×1 会被拒，
 * 错误信息是「The image length and width do not meet the model request」。
 * 那是"图太小"，不是"不支持视觉"——用 1×1 会把支持视觉的模型误判成不支持
 * （qwen3.8-max 就是这样被误判的）。
 *
 * 64×64 足够小（168 字节）又满足常见的下限，且纯红色最好辨认。
 */
export const RED_SQUARE_PNG_BASE64 = (() => {
  // 运行时生成，避免在源码里粘一坨 base64（也便于改尺寸）
  const w = 64;
  const h = 64;
  const tbl = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = tbl[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0); // filter type
    for (let x = 0; x < w; x++) raw.push(255, 0, 0);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
})();

/** 旧名字保留一版，避免外部引用直接炸（内部已改用 RED_SQUARE） */
export const RED_PIXEL_PNG_BASE64 = RED_SQUARE_PNG_BASE64;

/** 探测用的提示词：要求短答，减少 token 与等待 */
const VISION_PROMPT = '这张图片主要是什么颜色？只回答颜色名，不要解释。';

/**
 * @typedef {object} ProbeResult
 * @property {boolean|null} supported true=确认支持 / false=确认不支持 / null=没测出来
 * @property {string} [detail] 人话说明（成功时的回答，失败时的原因）
 * @property {string} [code] 失败时的错误码
 */

/**
 * 探测模型是否支持图片输入（视觉）。
 *
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {number} [o.timeoutMs]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<ProbeResult>}
 */
export async function probeVision({ baseUrl, apiKey, model, timeoutMs = 20000, signal }) {
  if (!apiKey) return { supported: null, code: 'E3020', detail: '还没配置 API Key' };

  const url = chatUrlOf(baseUrl);
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PIXEL_PNG_BASE64}` } },
        ],
      },
    ],
    // 给足 token。实测 16 会被推理型模型的思考过程吃光，
    // 导致 content 为空、看起来像"没回答"。
    max_tokens: 200,
  };

  try {
    const res = await postJson(url, apiKey, body, timeoutMs, signal);
    if (res.status === 200) {
      return judgeVisionAnswer(res.data);
    }
    // 4xx/5xx：看错误信息判断是不是"不支持图片"
    const msg = extractErr(res.data, res.status);
    return { supported: capabilityRejection(res.status, msg), code: `E${res.status}`, detail: msg };
  } catch (err) {
    // 网络层失败：没结论，不能判成"不支持"
    const e = /** @type {any} */ (err);
    return { supported: null, code: e?.code ?? 'E3012', detail: String(e?.message ?? e) };
  }
}

/**
 * 判定一次视觉探测的回答，是不是真的"看到了图"。
 *
 * ## 为什么不能只看 content 非空
 *
 * 实测同一批模型出现了三种完全不同的情况，只看"有没有回答"会判错：
 *
 * 1. `deepseek-v4.1` → `content: "红色"` —— 明确看到
 * 2. `kimi-k3` → `content: ""`，但 `reasoning_content` 里写着
 *    "The image is clearly solid red" —— **它确实看到了**，
 *    只是 max_tokens 被思考过程吃光，正式回答还没开始
 * 3. `glm-5.3` → `content: null`，`reasoning_content` 里写着
 *    "I cannot process the image" —— **它看不了图**
 *
 * 情况 2 和 3 的表象（正式回答为空）一模一样，但结论相反。
 * 所以必须连 `reasoning_content` 一起看，并且**识别"我无法处理图片"这类否定表述**。
 *
 * 这是在读模型自己的话判断它有没有看到图 —— 不完美，但比"只看有没有回答"准确得多。
 *
 * @param {any} data
 * @returns {{supported: boolean|null, detail: string}}
 */
export function judgeVisionAnswer(data) {
  const msg = data?.choices?.[0]?.message ?? {};
  const content = String(msg.content ?? '').trim();
  const reasoning = String(msg.reasoning_content ?? msg.reasoning ?? '').trim();
  const finish = String(data?.choices?.[0]?.finish_reason ?? '');

  /** 模型明确说自己处理不了图片的常见说法 */
  const cannotSee =
    /cannot\s+(process|see|view|read|analy[sz]e)\s+(the\s+)?(image|picture|photo)|unable\s+to\s+(process|see|view|read)|no\s+(image|visual)\s+(was\s+)?(provided|attached)|不支持(图片|图像|视觉)|无法(处理|查看|识别)(图片|图像)/i;

  const said = `${content}\n${reasoning}`;

  // (1) 明确说看不了 → 不支持。优先判断，因为它的证据最强。
  if (cannotSee.test(said)) {
    return { supported: false, detail: '模型明确表示无法处理图片' };
  }

  // 固定红图必须得到颜色证据；普通文字不能证明图片被读取。
  if (content.length > 0) {
    return { supported: /红色|红的|纯红|\bred\b/i.test(content) ? true : null, detail: /红色|红的|纯红|\bred\b/i.test(content) ? '识别固定红图颜色（单次探测）' : '回答没有验证目标颜色，尚不能确认视觉能力' };
  }

  // (3) 正式回答为空，但思考内容在描述图片 → 看到了（只是被 max_tokens 截断）
  if (reasoning.length > 0) {
    // 思考里在描述颜色/内容，就说明视觉通路是通的
    const describesImage =
      /(\bred\b|红色|纯红)/i.test(
        reasoning,
      );
    if (describesImage) {
      return {
        supported: true,
        detail: `思考内容显示读到了图（正式回答被 ${finish || '长度限制'} 截断）`,
      };
    }
    return { supported: null, detail: '回答为空，且思考内容不足以判断' };
  }

  // (4) 什么都没有：没结论，不能判成"不支持"
  return { supported: null, detail: `空回答（finish_reason=${finish || '未知'}）` };
}

/**
 * 探测聊天模型的能力 —— **只有视觉**。
 *
 * 抽成一个入口是为了让"聊天探测会发哪些请求"这件事可被测到：
 * 调用方（宿主的 `llm.probe`）只拿这个函数，不存在某个参数能让它
 * 顺手去请求 `/images/generations`。生图归独立插件，不在这条链路上。
 *
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {number} [o.timeoutMs]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{probes: {vision: ProbeResult}, channel: {channel: string, label: string, basis: string}}>}
 */
export async function probeModel({ baseUrl, apiKey, model, timeoutMs = 20000, signal }) {
  const vision = await probeVision({ baseUrl, apiKey, model, timeoutMs, signal });
  const caps = typeof vision.supported === 'boolean' ? { vision: vision.supported } : {};
  return { probes: { vision }, channel: inferChannel({ model, caps }) };
}

/**
 * 清掉旧配置里遗留的**生图探测状态**。
 *
 * 早先的聊天模型探测会同时写 `image` / `probes.image`，还可能记下
 * `channel: 'imageGen'`。这些结论现在既没有出处（不再探测），也没有用途
 * （生图归独立插件），留着只会让界面显示一个来路不明的"生图 ✓/✗"。
 *
 * ## 什么该删、什么该留
 *
 * - 删：`image`、`imageGen` 字段；`probes.image`；`channel === 'imageGen'`
 *   （它是旧探测的结论，不是名字推断，留着会让界面继续宣称"生图可用"）。
 * - 留：`vision`、`probes.vision`、`probedAt`、`endpoint` 及其它未知字段
 *   —— 视觉结论仍然有效，配置层也不该丢掉它不认识的元信息。
 * - **整条删**：删完既没有 `vision` 布尔值、也没有 `probes.vision` 的条目。
 *   那种条目只测过生图，对聊天模型能力**一句话都没说过**；留着会显示成
 *   "探测失败"，而用户其实从没测过读图 —— 那比空着更误导。
 *
 * 幂等：对已经清理过的配置再跑一次不会产生变化（changed=false）。
 *
 * @param {Record<string, any>} capsByEndpoint
 * @returns {{caps: Record<string, any>, changed: boolean}}
 */
export function sanitizeModelCapabilities(capsByEndpoint) {
  if (!capsByEndpoint || typeof capsByEndpoint !== 'object' || Array.isArray(capsByEndpoint)) {
    return { caps: capsByEndpoint ?? {}, changed: false };
  }

  let changed = false;
  /** @type {Record<string, any>} */
  const out = {};

  for (const [endpoint, models] of Object.entries(capsByEndpoint)) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      out[endpoint] = models;
      continue;
    }

    /** @type {Record<string, any>} */
    const kept = {};
    for (const [model, entry] of Object.entries(models)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        kept[model] = entry;
        continue;
      }

      const next = { ...entry };
      let droppedLegacy = false;
      for (const legacy of ['image', 'imageGen']) {
        if (legacy in next) {
          delete next[legacy];
          droppedLegacy = true;
          changed = true;
        }
      }

      if (next.probes && typeof next.probes === 'object' && !Array.isArray(next.probes)) {
        if ('image' in next.probes) {
          const probes = { ...next.probes };
          delete probes.image;
          next.probes = Object.keys(probes).length > 0 ? probes : undefined;
          if (next.probes === undefined) delete next.probes;
          changed = true;
          droppedLegacy = true;
        }
      }

      if (next.channel === 'imageGen') {
        /*
         * `channel: 'imageGen'` 只可能来自旧探测（名字推断现在用 `other`）。
         * 删掉它；若整条只剩这个字段，下面的"无视觉证据"规则会把条目
         * 一起丢掉 —— 一个空的 `{}` 对界面没有意义，反而会让"最近探测过"
         * 看起来像真的。
         */
        delete next.channel;
        changed = true;
        droppedLegacy = true;
      }

      /*
       * 只测过生图的条目：删完没有任何视觉证据，整条丢掉。
       * 注意 `probes.vision` 存在时即使结论是 null 也要留 —— 那是"测过但没测出来"。
       */
      if (droppedLegacy && typeof next.vision !== 'boolean' && !next.probes?.vision) {
        changed = true;
        continue;
      }

      kept[model] = next;
    }
    out[endpoint] = kept;
  }

  return { caps: changed ? out : capsByEndpoint, changed };
}

/**
 * 判定模型通道类型。
 *
 * 这是**基于模型目录元信息的推断**，不是实测——所以标签用词必须留余地：
 * 说"文本通道"而不是"只能处理文本"，说"疑似非对话模型"而不是"这是生图模型"。
 *
 * 依据（按优先级）：
 *   1. 已实测过视觉 → 多模态通道
 *   2. 模型 id 里带 embed/rerank → 向量通道
 *   3. id 里带 image/dall-e/sd/flux → 疑似非对话模型（**不据此宣布能生图**）
 *   4. id 里带 audio/tts/whisper → 音频通道
 *   5. 其它 → 文本通道
 *
 * ## 为什么第 3 条不再标成"生图"
 *
 * 名字像生图模型（`dall-e-3`、`flux-1.1`）**不等于**当前服务商的这套地址
 * 真能生图：能力要实测，而生图归独立插件、由它自己的地址与 Key 决定。
 * 聊天模型页按名字宣布"生图"，用户就会拿聊天 Key 去期待生图 —— 这正是
 * 本次清理要消掉的误导。所以这里只提示"它可能不是用来对话的"。
 *
 * @param {{model: string, caps?: {vision?: boolean}}} o
 * @returns {{channel: string, label: string, basis: string}}
 */
export function inferChannel({ model, caps }) {
  const id = String(model ?? '').toLowerCase();

  if (caps?.vision === true) {
    return { channel: 'multimodal', label: '多模态（可读图）', basis: '已实测：图片输入可用' };
  }

  // 实测**否定**过视觉的，名字再像也不能判成多模态。
  // 名字只是猜测，实测结论必须压过它。
  const visionKnownFalse = caps?.vision === false;

  if (/embed|rerank/.test(id)) {
    return { channel: 'embedding', label: '向量', basis: '模型名含 embed/rerank' };
  }
  if (/(^|[-_/])(dall-e|dalle|sd|sdxl|flux|image|imagen|kolors)/.test(id)) {
    return {
      channel: 'other',
      label: '疑似非对话模型',
      basis: '模型名像图像类模型；生图能力归独立插件，不按名字认定',
    };
  }
  if (/whisper|tts|audio|speech|voice/.test(id)) {
    return { channel: 'audio', label: '音频', basis: '模型名像音频模型' };
  }
  if (!visionKnownFalse && (/(^|[-_/])(vl|vision)/.test(id) || /-vl-|-vision-/.test(id))) {
    return {
      channel: 'multimodal',
      label: '多模态（名字像，未实测）',
      basis: '模型名含 vl/vision',
    };
  }
  if (visionKnownFalse) {
    // 说清"为什么不把它当多模态"，否则用户会疑惑名字明明写着 vision
    return { channel: 'text', label: '文本', basis: '已实测：不支持图片输入（名字不足为凭）' };
  }
  return { channel: 'text', label: '文本', basis: '无多模态特征' };
}

/**
 * 把模型 id 列表整理成带能力信息的目录。
 *
 * 只带**视觉**三态：生图不是聊天模型的能力，目录里不出现它，
 * 免得界面把"这个模型可能能生图"当成一个可选项呈现。
 *
 * @param {string[]} ids
 * @param {Record<string, any>} capsByModel
 * @returns {Array<{id: string, channel: string, channelLabel: string, basis: string, vision: boolean|null}>}
 */
export function endpointKey(baseUrl) {
  const u = new URL(chatUrlOf(baseUrl));
  u.username = ''; u.password = ''; u.hash = ''; u.search = '';
  return u.href;
}
export function endpointCapabilities(all, baseUrl) { return all?.[endpointKey(baseUrl)] ?? {}; }

export function describeCatalog(ids, capsByModel = {}) {
  return ids.map((id) => {
    const caps = capsByModel[id] ?? {};
    const ch = inferChannel({ model: id, caps });
    return {
      id,
      channel: ch.channel,
      channelLabel: ch.label,
      basis: ch.basis,
      // 三态：true / false / null（未测）。null 必须保留，不能压成 false。
      vision: typeof caps.vision === 'boolean' ? caps.vision : null,
    };
  });
}

/* ------------------------------------------------------------------ 内部 */

/** @param {string} baseUrl */
function trimSlash(baseUrl) {
  return String(baseUrl ?? '').replace(/\/+$/, '');
}

/** 与 LlmClient.chatUrl 保持一致的规范化 */
export function chatUrlOf(baseUrl) {
  const base = trimSlash(baseUrl);
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 发一个 POST JSON 请求，**不抛 HTTP 错误**（由调用方按状态码判断）。
 * 只有网络层问题才抛。
 */
async function postJson(url, apiKey, body, timeoutMs, signal) {
  /** @type {AbortSignal} */
  let sig;
  if (signal) sig = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  else sig = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: sig,
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new LlmError(`探测超时（>${timeoutMs}ms）`, { code: 'E3011' });
    }
    throw new LlmError(`连不上模型服务：${e?.message ?? e}`, { code: 'E3012' });
  }

  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  return { status: res.status, data };
}

/**
 * 从各家不同的错误形状里抠出"这个模型不支持图片输入"的证据。
 *
 * `kind` 参数随生图探测一起删掉了：现在只会用来判定视觉。
 * 403/429/5xx 一律不算"不支持"——那是配额或服务端问题，不能当成能力结论。
 */
function capabilityRejection(status, msg) {
  if ([401, 403, 408, 409, 429].includes(status) || status >= 500) return null;
  if (/size|dimension|resolution|width|height|参数|尺寸|分辨率/i.test(msg)) return null;
  return /(?:model|vision|image|visual).*(?:not\s*support|unsupported)|(?:not\s*support|unsupported).*(?:model|vision|image|visual)|不支持.*(?:图片|图像|视觉)|无法.*(?:图片|图像|视觉)/i.test(msg) ? false : null;
}

function extractErr(data, status) {
  const e = data?.error;
  if (typeof e === 'string') return e.slice(0, 200);
  if (e?.message) return String(e.message).slice(0, 200);
  if (data?.message) return String(data.message).slice(0, 200);
  if (data?._raw) return String(data._raw).slice(0, 200);
  return `HTTP ${status}`;
}
