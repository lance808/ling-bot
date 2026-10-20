/**
 * 模型能力探测 —— 视觉 / 生图 / 通道类型
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
 * 探测发的是**真实请求**，会消耗额度（虽然极少：一张 1×1 图 + 几个 token）。
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
    return { supported: capabilityRejection(res.status, msg, 'vision'), code: `E${res.status}`, detail: msg };
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
 * 探测模型是否支持生图。
 *
 * 两种常见形态都要试：
 *   1. `/images/generations`（OpenAI 标准生图端点）
 *   2. chat 接口里带 `modalities: ['image']`（部分中转的多模态形态）
 *
 * 只发最小的 1 张图请求。不支持时服务端会返回 4xx 或明确报错。
 *
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {number} [o.timeoutMs]
 * @returns {Promise<ProbeResult & {via?: string}>}
 */
export async function probeImageGen({ baseUrl, apiKey, model, timeoutMs = 30000 }) {
  if (!apiKey) return { supported: null, code: 'E3020', detail: '还没配置 API Key' };

  // (1) 先试标准生图端点
  let standardRejected = false;
  const imgUrl = imagesUrlOf(baseUrl);
  try {
    const res = await postJson(
      imgUrl,
      apiKey,
      { model, prompt: 'a red dot', n: 1, size: '256x256' },
      timeoutMs,
    );
    if (res.status === 200) {
      const n = Array.isArray(res.data?.data) ? res.data.data.filter(hasImageEvidence).length : 0;
      if (n > 0) return { supported: true, via: 'images', detail: `返回 ${n} 张图` };
      return { supported: null, via: 'images', detail: '接口正常但没有可验证图片' };
    }
    // 404/405 说明这家根本没有生图端点，继续试第二种形态
    if (res.status !== 404 && res.status !== 405) {
      const msg = extractErr(res.data, res.status);
      // 有些站对不支持的模型返回 400 且信息里带 "not support"
      if (capabilityRejection(res.status, msg, 'image') === false) {
        standardRejected = true;
      }
      // 其它 4xx 也可能是模型不支持，但证据不足 → 继续试 chat 形态
    }
  } catch {
    /* 网络问题：继续试下一种形态 */
  }

  // (2) 再试 chat + modalities
  try {
    const res = await postJson(
      chatUrlOf(baseUrl),
      apiKey,
      {
        model,
        messages: [{ role: 'user', content: '画一个红点' }],
        modalities: ['image'],
        max_tokens: 32,
      },
      timeoutMs,
    );
    if (res.status === 200) {
      const msg = res.data?.choices?.[0]?.message;
      const hasImage = (Array.isArray(msg?.images) && msg.images.some(hasImageEvidence)) || (Array.isArray(msg?.content) && msg.content.some(b => /image/.test(b?.type ?? '') && hasImageEvidence(b)));
      if (hasImage) return { supported: true, via: 'chat', detail: '对话接口返回了图片' };
      return { supported: null, via: 'chat', detail: '接口接受了请求但没有可验证图片' };
    }
    const m = extractErr(res.data, res.status);
    return { supported: standardRejected && capabilityRejection(res.status, m, 'image') === false ? false : null, via: 'chat', detail: m };
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { supported: null, code: e?.code ?? 'E3012', detail: String(e?.message ?? e) };
  }
}

/**
 * 判定模型通道类型。
 *
 * 这是**基于模型目录元信息的推断**，不是实测——所以标签用词必须留余地：
 * 说"文本通道"而不是"只能处理文本"。
 *
 * 依据（按优先级）：
 *   1. 已实测过视觉 → 多模态通道
 *   2. 模型 id 里带 embed/rerank → 向量通道
 *   3. id 里带 image/dall-e/sd/flux → 生图通道
 *   4. id 里带 audio/tts/whisper → 音频通道
 *   5. 其它 → 文本通道
 *
 * @param {{model: string, caps?: {vision?: boolean, image?: boolean}}} o
 * @returns {{channel: string, label: string, basis: string}}
 */
export function inferChannel({ model, caps }) {
  const id = String(model ?? '').toLowerCase();

  if (caps?.vision === true) {
    return { channel: 'multimodal', label: '多模态（可读图）', basis: '已实测：图片输入可用' };
  }
  if (caps?.image === true) {
    return { channel: 'imageGen', label: '生图', basis: '已实测：生图可用' };
  }

  // 实测**否定**过视觉的，名字再像也不能判成多模态。
  // 名字只是猜测，实测结论必须压过它。
  const visionKnownFalse = caps?.vision === false;

  if (/embed|rerank/.test(id)) {
    return { channel: 'embedding', label: '向量', basis: '模型名含 embed/rerank' };
  }
  if (/(^|[-_/])(dall-e|dalle|sd|sdxl|flux|image|imagen|kolors)/.test(id)) {
    return { channel: 'imageGen', label: '生图', basis: '模型名像生图模型' };
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
 * @param {string[]} ids
 * @param {Record<string, any>} capsByModel
 * @returns {Array<{id: string, channel: string, channelLabel: string, basis: string, vision: boolean|null, image: boolean|null}>}
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
      image: typeof caps.image === 'boolean' ? caps.image : null,
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

/** 生图端点（同样的规范化思路） */
export function imagesUrlOf(baseUrl) {
  const base = trimSlash(baseUrl);
  if (/\/chat\/completions$/.test(base)) {
    return `${base.replace(/\/chat\/completions$/, '')}/images/generations`;
  }
  if (/\/v\d+$/.test(base)) return `${base}/images/generations`;
  return `${base}/v1/images/generations`;
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

/** 从各家不同的错误形状里抠出人能看懂的句子 */
function capabilityRejection(status, msg, kind) {
  if ([401, 403, 408, 409, 429].includes(status) || status >= 500) return null;
  if (/size|dimension|resolution|width|height|参数|尺寸|分辨率/i.test(msg)) return null;
  return /(?:model|vision|image|visual).*(?:not\s*support|unsupported)|(?:not\s*support|unsupported).*(?:model|vision|image|visual)|不支持.*(?:图片|图像|视觉|生图)|无法.*(?:图片|图像|视觉)/i.test(msg) ? false : null;
}
function hasImageEvidence(value) {
  if (typeof value === 'string') return /^(https?:\/\/|data:image\/|base64:)/i.test(value);
  if (!value || typeof value !== 'object') return false;
  if (typeof value.b64_json === 'string' && value.b64_json.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.b64_json)) return true;
  if (value.image_url && typeof value.image_url === 'object') return hasImageEvidence(value.image_url);
  return ['url', 'image_url', 'data'].some(k => typeof value[k] === 'string' && /^(https?:\/\/|data:image\/|base64:)/i.test(value[k]));
}

function extractErr(data, status) {
  const e = data?.error;
  if (typeof e === 'string') return e.slice(0, 200);
  if (e?.message) return String(e.message).slice(0, 200);
  if (data?.message) return String(data.message).slice(0, 200);
  if (data?._raw) return String(data._raw).slice(0, 200);
  return `HTTP ${status}`;
}
