/**
 * 受控取图 —— 视觉链路的唯一入口（契约 §3）
 *
 * ## 这个模块要回答的问题只有一个
 *
 * 「给我一张图，能安全地拿到它的字节吗？」
 *
 * 之所以要单独一个模块而不是在需要的地方 `fetch(url)`：
 * 这条链路的输入**全部来自外部**（群消息里的段字段），而它要做的事情是
 * 「按我给的地址去取东西」。这正是 SSRF 与任意文件读取的标准形状。
 * 所以所有出口都集中在这里，只有三种，且每种都过同一套验收：
 *
 *   1. 网关 `get_image`（只接受安全缓存名）
 *   2. 段内 URL（只接受 http(s)，逐跳校验目标地址）
 *   3. 本地缓存路径（只接受 snowlumaDir 的 realpath 子树内的普通文件）
 *
 * ## 为什么每种来源都要走同一套类型/字节/像素验收
 *
 * 三者给出字节的可信度完全不同（网关可能返回垃圾、URL 可能返回 HTML 错误页、
 * 本地文件可能是被替换的符号链接）。如果验收只挂在其中一条上，
 * 换一条路就能绕过 —— 而"绕过"在这里的含义是把任意字节送进模型请求体。
 *
 * ## 为什么超时是**整次取图**的总预算
 *
 * 逐跳超时是不够的：一个恶意/故障的对端可以每 100ms 发一个字节，
 * 让 socket idle timeout 永远不触发。所以从进入 `fetchImage` 开始计时，
 * 后面每一跳都只用剩余时间，用光即 E3109。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

import {
  base64FromMaybe,
  decodedByteLength,
  imageDimensions,
  pixelCount,
  sniffMime,
} from './image-bytes.mjs';
import { isProbablySafeCacheName } from './media-refs.mjs';

/** 视界内没有显式预算时的兜底（正常情况下 vision.mjs 一定会传进来） */
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxPixels: 36_000_000,
  timeoutMs: 15_000,
});

/** 重定向最多跟几跳。QQ 图床实际最多一跳；留几跳余量，但绝不无限跟 */
const MAX_REDIRECTS = 4;

/** 会把我们带到别处的状态码（303 也当 GET 处理，因为这里本来就只发 GET） */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** DNS 解析的独立超时：它不受取图总预算之外的单独限制保护时最容易挂住 */
const DNS_TIMEOUT_MS = 5_000;

/**
 * @typedef {object} FetchDeps
 * @property {(input: {file: string}) => Promise<any>} [getImage]  // OneBot get_image
 * @property {string} [snowlumaDir]      // 允许读取的本地缓存根（未配置 = 禁止本地路径）
 * @property {(input: {url: string, maxBytes: number, timeoutMs: number}) => Promise<Buffer>} [fetchUrl]
 *   替换整个 URL 抓取实现。**替换后 SSRF 防护由它自己负责**（生产环境不传）
 * @property {() => number} [now]
 * @property {(hostname: string) => Promise<string[]>} [resolveHost]   // 测试接缝：默认走 dns
 * @property {(input: object) => Promise<{statusCode: number, headers: object, buffer: Buffer}>} [requestOnce]
 *   测试接缝：默认走 node:http(s)。用它可以验证逐跳重定向校验而不必联网
 */

/**
 * 取一张图的字节。
 *
 * @param {import('./media-refs.mjs').MediaRef} ref
 * @param {{limits?: {maxBytes?: number, maxPixels?: number, timeoutMs?: number}, deps?: FetchDeps}} [opts]
 * @returns {Promise<
 *   {ok: true, buffer: Buffer, mime: string, width: number, height: number, via: string}
 *   | {ok: false, code: string, reason: string, codes: string[]}>}
 */
export async function fetchImage(ref, opts = {}) {
  const limits = normalizeLimits(opts?.limits);
  const deps = opts?.deps && typeof opts.deps === 'object' ? opts.deps : {};
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const ctx = { limits, deps, now, deadline: now() + limits.timeoutMs };

  /** @type {Array<{code: string, reason: string}>} */
  const attempts = [];

  if (!ref || typeof ref !== 'object') {
    return fail('E3101', '没有图片引用', attempts);
  }
  // face/record 等段不进视觉链路：它们到这里只可能是调用方传错了
  if (ref.kind && ref.kind !== 'image') {
    return fail('E3101', `不支持取该类型（${String(ref.kind)}）的媒体`, attempts);
  }

  /*
   * 优先级（契约 §3）：安全的 get_image 缓存名 → 段内 URL → 本地缓存路径。
   *
   * `inline`（base64:// / data:）排在 get_image 之后、URL 之前：
   * 它和 URL 一样来自消息段，但不需要任何网络/磁盘访问，先试它没有任何代价。
   * 实际上 `file` 是 base64 时 get_image 那一跳会**自动跳过**（不是安全缓存名），
   * 所以这个顺序只在同时存在 file 与内联体（罕见但合法）时才有差别。
   */
  const hops = [
    { via: 'get_image', run: () => fromGetImage(ref, ctx) },
    { via: 'inline', run: () => fromInline(ref, ctx) },
    { via: 'url', run: () => fromUrl(ref, ctx) },
    { via: 'local', run: () => fromLocal(ref, ctx) },
  ];

  for (const hop of hops) {
    const r = await runHop(hop.run, ctx);
    if (r.ok) {
      return {
        ok: true,
        buffer: r.buffer,
        mime: r.mime,
        width: r.width,
        height: r.height,
        via: r.via ?? hop.via,
      };
    }
    // skipped = 这一跳压根没来源（不能算失败，否则统计里全是噪音）
    if (!r.skipped) attempts.push({ code: r.code, reason: r.reason });
    // 总预算已经用光就没必要再试别的来源了
    if (r.code === 'E3109') break;
  }

  if (!attempts.length) {
    return fail('E3101', '没有可用的取图来源（file/url 都为空或不安全）', attempts);
  }
  /*
   * 对外报**第一个**失败原因（按优先级，即最想用的那个来源）。
   *
   * 不报最后一个：后面的来源本来就是兜底，它们失败是常态
   * （例如本地缓存里根本没有这个文件 → E3108）。拿兜底失败去覆盖主来源失败，
   * 会让用户看到"本地路径越界"而实际上问题出在网关 —— 排查方向直接跑偏。
   * 完整链条仍在 `codes` 里，需要深挖时不会丢信息。
   */
  const first = attempts[0];
  return fail(first.code, attempts.length > 1
    ? `${first.reason}（另有 ${attempts.length - 1} 个来源也失败：${attempts.slice(1).map((a) => a.code).join('/')}）`
    : first.reason,
  attempts);
}

/* ------------------------------------------------------- URL 安全（SSRF） */

/**
 * 判断一个 IP 是否属于「不该从聊天里访问」的范围。
 *
 * ## 为什么非法地址也算私有
 *
 * 这个函数在 DNS 之后被调用，输入是解析结果。如果解析结果不是合法 IP，
 * 说明对端给了我们看不懂的东西 —— 此时**放行**比拒绝危险得多
 * （放行等于把解析权交给 OS，而 OS 的理解可能和这里不同）。
 *
 * 覆盖范围：环回、私有、链路本地、CGNAT、保留、组播、IPv4-mapped IPv6、
 * 6to4、NAT64、文档地址。这些全部是"内网可达性"的入口，
 * 少一个就可能被用来探测宿主机/局域网服务。
 *
 * @param {unknown} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  let h = String(ip ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  if (!family || h.includes('%')) return true;
  // 规范化 IPv6（`::1` 之类的压缩写法由 URL 解析器展开）
  if (family === 6) {
    try {
      h = new URL(`http://[${h}]/`).hostname.slice(1, -1);
    } catch {
      return true;
    }
  }

  if (net.isIP(h) === 4) return isPrivateIpv4(h);
  if (net.isIP(h) === 6) return isPrivateIpv6(h);
  return true;
}

/** IPv4 私有/保留段。分段写清楚比一张 CIDR 表更不容易改错 */
function isPrivateIpv4(h) {
  const parts = h.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;

  if (a === 0) return true; // 0.0.0.0/8 「本网络」
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 环回
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24 与 192.0.2/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // 文档
  if (a === 203 && b === 0 && c === 113) return true; // 文档
  if (a >= 224) return true; // 组播 + 保留 + 广播
  return false;
}

/** IPv6：唯一本地、链路本地、环回、组播、文档，以及各类 IPv4 内嵌写法 */
function isPrivateIpv6(h) {
  if (h === '::' || h === '::1') return true;
  const first = h.split(':')[0] ?? '';
  if (first.startsWith('fc') || first.startsWith('fd')) return true; // fc00::/7 唯一本地
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 链路本地
  if (/^fe[c-f]/.test(first)) return true; // 站点本地（已废弃，仍然内网）
  if (first.startsWith('ff')) return true; // ff00::/8 组播
  if (h.startsWith('2001:db8')) return true; // 文档
  if (h.startsWith('2001:2:')) return true; // 基准测试
  if (h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true; // ORCHID
  if (h.startsWith('64:ff9b:1:')) return true; // 本地 NAT64 前缀

  /*
   * 6to4（2002::/16）：紧跟在前缀后的 32 位就是内嵌的 IPv4。
   *
   * 单独处理而不是交给 embeddedIpv4()：6to4 的 IPv4 在**最前面**，
   * 而 mapped/compatible 类在内嵌地址位于**最后** 32 位。
   * 用一个函数猜两种布局必然有一边是错的。
   */
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/.exec(h);
  if (sixToFour) {
    const num = (parseInt(sixToFour[1], 16) << 16) + parseInt(sixToFour[2], 16);
    return isPrivateIpv4(`${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`);
  }

  const embedded = embeddedIpv4(h);
  if (embedded) return isPrivateIpv4(embedded);
  return false;
}

/**
 * 从 IPv6 里抠出内嵌的 IPv4（点分或十六进制两种写法都认）。
 *
 * ## 为什么十六进制形式**只在特定前缀下**才抠最后 32 位
 *
 * 任何 IPv6 都有"最后 32 位"，但绝大多数地址的这 32 位与 IPv4 毫无关系。
 * 无条件去抠，会把 `2606:4700:4700::1111` 解释成 `0.0.17.17` ——
 * 那是 0.x 网段，于是**公网地址被判成私有**，表现为"所有图片都取不到"。
 *
 * 只有这三种前缀下的最后 32 位真的是 IPv4：
 *   - `::ffff:` IPv4-mapped
 *   - `::`      IPv4-compatible（已废弃，仍可能出现在 DNS 结果里）
 *   - `64:ff9b` NAT64 well-known 前缀
 */
function embeddedIpv4(h) {
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return dotted[1];

  const mayHoldIpv4 =
    h.startsWith('::ffff:') || h.startsWith('::') || h.startsWith('64:ff9b') || h.startsWith('64:ff9b::');
  if (!mayHoldIpv4) return null;

  const groups = h.split(':');
  const last = groups[groups.length - 1];
  const prev = groups[groups.length - 2];
  if (!/^[0-9a-f]{1,4}$/.test(last)) return null;
  const num =
    prev !== undefined && /^[0-9a-f]{1,4}$/.test(prev)
      ? (parseInt(prev, 16) << 16) + parseInt(last, 16)
      : parseInt(last, 16);
  return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
}

/**
 * 同步的"明显不安全"判定：协议、凭据、字面 IP、本机名。
 *
 * 这一层不需要 DNS，所以对注入的 `fetchUrl` 也生效 —— 换来的是
 * "就算宿主换掉了抓取实现，`http://127.0.0.1/` 也进不去"。
 *
 * @param {unknown} raw
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function validateUrlShape(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, reason: 'URL 无效' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `仅允许 http/https（收到 ${url.protocol}）` };
  }
  // URL 里带账号密码等于把凭据发给对端，也常被用来做 URL 解析歧义攻击
  if (url.username || url.password) return { ok: false, reason: 'URL 不能包含凭据' };

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'URL 缺少主机名' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: '禁止访问内网/本机地址' };
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    return { ok: false, reason: '禁止访问内网/本机地址' };
  }
  return { ok: true, url };
}

/**
 * 解析主机名并确认**所有**解析结果都是公网地址。
 *
 * 检查全部结果（而不是只取第一个）是为了堵 DNS rebinding / 轮询返回内网地址：
 * 只要有一项落在内网，这次解析就不可信。
 *
 * @param {string} hostname
 * @param {(hostname: string) => Promise<string[]>} [resolveHost]
 * @returns {Promise<string>} 选定的 IP
 */
export async function resolveSafeHost(hostname, resolveHost) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw fetchErr('E3104', '主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw fetchErr('E3104', '禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw fetchErr('E3104', '禁止访问内网/本机地址');
    return h;
  }

  let addresses;
  try {
    if (typeof resolveHost === 'function') {
      const raw = await withTimer(resolveHost(h), DNS_TIMEOUT_MS, `DNS 解析 ${h}`);
      addresses = (Array.isArray(raw) ? raw : []).map((x) => (typeof x === 'string' ? x : x?.address));
    } else {
      const raw = await withTimer(
        dns.promises.lookup(h, { all: true, verbatim: true }),
        DNS_TIMEOUT_MS,
        `DNS 解析 ${h}`,
      );
      addresses = raw.map((x) => x.address);
    }
  } catch (error) {
    // 超时/解析失败都是"取不到"，不是"被策略拒绝" —— 两者要能区分
    if (error?.code === 'E3109') throw error;
    throw fetchErr('E3103', `域名解析失败：${messageOf(error)}`);
  }

  if (!addresses.length) throw fetchErr('E3103', '域名没有解析结果');
  for (const address of addresses) {
    if (isPrivateIp(address)) throw fetchErr('E3104', '域名解析到内网/本机地址，已阻止');
  }
  return addresses[0];
}

/**
 * 带 SSRF 防护与逐跳校验的图片抓取。
 *
 * ## 为什么手动跟重定向，而不是让 http 客户端自己跟
 *
 * 自动跟随等于把"下一跳去哪"的决定权交给对端。一个公网 URL 可以
 * 302 到 `http://127.0.0.1:3458/`（本机的 DSH 桥）或 `http://192.168.x.x`，
 * 而第一跳的校验完全通过。所以每一次跳转都必须重新跑一遍
 * URL 形状 + DNS + 私网判定，且重定向响应体**直接丢弃**
 * （否则对端可以用无限正文拖住连接）。
 *
 * @param {string} rawUrl
 * @param {object} opts
 * @param {number} opts.maxBytes
 * @param {number} opts.timeoutMs
 * @param {() => number} [opts.now]
 * @param {(hostname: string) => Promise<string[]>} [opts.resolveHost]
 * @param {(input: object) => Promise<{statusCode: number, headers: object, buffer: Buffer}>} [opts.requestOnce]
 * @returns {Promise<{buffer: Buffer, finalUrl: string, statusCode: number}>}
 */
export async function safeFetchBuffer(rawUrl, opts = {}) {
  const maxBytes = positiveInt(opts.maxBytes, DEFAULT_LIMITS.maxBytes);
  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_LIMITS.timeoutMs);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const deadline = now() + timeoutMs;

  let current = String(rawUrl ?? '');
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const shape = validateUrlShape(current);
    if (!shape.ok) throw fetchErr('E3104', shape.reason);

    const ip = await resolveSafeHost(shape.url.hostname, opts.resolveHost);
    const remaining = deadline - now();
    if (remaining <= 0) throw fetchErr('E3109', `取图超时（${timeoutMs}ms）`);

    let res;
    try {
      res = await withTimer(
        (opts.requestOnce ?? defaultRequestOnce)({
          url: shape.url,
          ip,
          maxBytes,
          timeoutMs: remaining,
          deadline,
          now,
        }),
        remaining,
        `请求 ${shape.url.host}`);
    } catch (error) {
      throw classifyRequestError(error, shape.url);
    }

    const status = Number(res?.statusCode) || 0;
    if (REDIRECT_STATUSES.has(status)) {
      const location = String(res?.headers?.location ?? '');
      if (!location) throw fetchErr('E3103', `重定向缺少 Location（HTTP ${status}）`);
      const next = new URL(location, shape.url).toString();
      current = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      throw fetchErr('E3103', `图片抓取失败：HTTP ${status}`);
    }

    const buf = Buffer.isBuffer(res?.buffer) ? res.buffer : Buffer.alloc(0);
    if (buf.length > maxBytes) throw fetchErr('E3106', `图片超过大小限制（${maxBytes} 字节）`);
    if (!buf.length) throw fetchErr('E3103', '响应体为空');
    return { buffer: buf, finalUrl: shape.url.toString(), statusCode: status };
  }
  throw fetchErr('E3103', '重定向次数过多，已停止');
}

/* ---------------------------------------------------------- 各来源实现 */

/**
 * 网关 get_image。
 *
 * 只接受**安全缓存名**：`file` 是路径/URL/base64 时这一跳直接跳过，
 * 绝不把外部字符串交给网关当文件名。
 */
async function fromGetImage(ref, ctx) {
  const { deps, limits } = ctx;
  if (!isProbablySafeCacheName(ref.file)) return { skipped: true };
  // 没接线（宿主未提供 getImage）不是"失败"，只是没有这个来源
  if (typeof deps.getImage !== 'function') return { skipped: true };

  let info;
  try {
    info = await withDeadline(Promise.resolve().then(() => deps.getImage({ file: String(ref.file) })), ctx);
  } catch (error) {
    if (isTimeout(error)) return { code: 'E3109', reason: timeoutReason(ctx) };
    return { code: 'E3102', reason: `网关 get_image 失败：${messageOf(error)}` };
  }

  const obj = info && typeof info === 'object' ? info : {};
  const b64 = base64FromMaybe(obj.data) ?? base64FromMaybe(obj.base64) ?? base64FromMaybe(obj.file);
  if (b64) {
    // 先按长度估算再解码：超大字符串一旦进了 Buffer.from 就已经分配完了
    const estimated = decodedByteLength(b64);
    if (estimated > limits.maxBytes) {
      return { code: 'E3106', reason: `get_image 返回的图片超过大小限制（约 ${estimated} 字节）` };
    }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return { code: 'E3102', reason: 'get_image 返回了空字节' };
    return accept(buf, 'get_image');
  }

  // 有些实现只回 URL，不内联字节；那就把它当成一跳 URL 抓取（仍过全部校验）
  if (typeof obj.url === 'string' && obj.url.trim()) {
    const r = await fetchUrlBytes(obj.url.trim(), ctx);
    return r.ok ? { ...r, via: 'get_image-url' } : r;
  }

  // 还有的实现会回本机绝对路径
  if (typeof obj.file === 'string' && path.isAbsolute(obj.file)) {
    return readLocalFile(obj.file, ctx);
  }

  return { code: 'E3102', reason: 'get_image 未返回任何图片字节' };
}

/** 段内直接内联的 base64（`base64://` / `data:`） */
async function fromInline(ref, ctx) {
  if (typeof ref.inline !== 'string' || !ref.inline.trim()) return { skipped: true };
  const b64 = base64FromMaybe(ref.inline);
  if (!b64) return { code: 'E3102', reason: '内联图片的 base64 无法解析' };
  const estimated = decodedByteLength(b64);
  if (estimated > ctx.limits.maxBytes) {
    return { code: 'E3106', reason: `内联图片超过大小限制（约 ${estimated} 字节）` };
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return { code: 'E3102', reason: '内联图片解出空字节' };
  return accept(buf, 'inline');
}

/** 段内 URL */
async function fromUrl(ref, ctx) {
  if (typeof ref.url !== 'string' || !ref.url.trim()) return { skipped: true };
  return fetchUrlBytes(ref.url.trim(), ctx);
}

async function fetchUrlBytes(rawUrl, ctx) {
  const { deps, limits, now } = ctx;
  const shape = validateUrlShape(rawUrl);
  if (!shape.ok) return { code: 'E3104', reason: shape.reason };

  const remaining = ctx.deadline - now();
  if (remaining <= 0) return { code: 'E3109', reason: timeoutReason(ctx) };

  try {
    let buf;
    if (typeof deps.fetchUrl === 'function') {
      // 宿主替换了抓取实现：形状检查已过，SSRF 由该实现负责
      buf = await withDeadline(
        Promise.resolve().then(() =>
          deps.fetchUrl({ url: shape.url.toString(), maxBytes: limits.maxBytes, timeoutMs: remaining }),
        ),
        ctx,
      );
    } else {
      const r = await safeFetchBuffer(shape.url.toString(), {
        maxBytes: limits.maxBytes,
        timeoutMs: remaining,
        now,
        resolveHost: deps.resolveHost,
        requestOnce: deps.requestOnce,
      });
      buf = r.buffer;
    }
    if (!Buffer.isBuffer(buf)) return { code: 'E3103', reason: '抓取实现没有返回字节' };
    if (!buf.length) return { code: 'E3103', reason: '响应体为空' };
    /*
     * 替换实现返回的字节也要在这里先量一遍。
     *
     * 否则一个"超限的大 JPEG"会先通过 accept() 被识别成图片，
     * 再在统一验收里因为大小被拒 —— 报出来的码一样，但诊断信息
     * 会从"太大"变成"类型/尺寸"，排查方向完全不同。
     */
    if (buf.length > limits.maxBytes) {
      return { code: 'E3106', reason: `图片超过大小限制（${buf.length} 字节，上限 ${limits.maxBytes}）` };
    }
    return accept(buf, 'url');
  } catch (error) {
    if (isTimeout(error)) return { code: 'E3109', reason: timeoutReason(ctx) };
    const code = pickCode(error, 'E3103');
    return { code, reason: messageOf(error) };
  }
}

/**
 * 本地缓存文件。
 *
 * 三道口子依次收紧：
 *   1. 路径必须能解析（无 NUL、长度合理）；
 *   2. realpath 之后必须仍在 `snowlumaDir` 的子树内 ——**必须用 realpath**，
 *      否则一个指向 `C:\Windows\System32\config\SAM` 的符号链接就能绕过
 *      "它看起来在缓存目录里"这个判断；
 *   3. 必须是普通文件（不能是目录、设备、FIFO —— 读 FIFO 会永久阻塞）。
 */
async function fromLocal(ref, ctx) {
  const candidate = typeof ref.localPath === 'string' && ref.localPath.trim()
    ? ref.localPath.trim()
    : (isProbablySafeCacheName(ref.file) ? '' : (typeof ref.file === 'string' ? ref.file.trim() : ''));
  if (!candidate) return { skipped: true };
  return readLocalFile(candidate, ctx);
}

async function readLocalFile(candidate, ctx) {
  const { deps, limits } = ctx;
  if (typeof candidate !== 'string' || !candidate || candidate.length > 4096) {
    return { code: 'E3108', reason: '本地路径格式非法' };
  }
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    return { code: 'E3108', reason: '本地路径包含控制字符' };
  }
  // 未配置缓存根 = 一律禁止：默认必须是"读不到"，而不是"哪都能读"
  if (typeof deps.snowlumaDir !== 'string' || !deps.snowlumaDir.trim()) {
    return { code: 'E3108', reason: '未配置本地缓存根，禁止读取本地路径' };
  }

  let root;
  let real;
  try {
    root = await fs.realpath(deps.snowlumaDir.trim());
    real = await fs.realpath(candidate);
  } catch (error) {
    return { code: 'E3108', reason: `本地路径不可访问：${messageOf(error)}` };
  }

  if (!isInside(real, root)) {
    return { code: 'E3108', reason: '本地缓存路径越界（不在允许的缓存根内）' };
  }

  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { code: 'E3108', reason: '本地路径不是普通文件' };
    if (stat.size > limits.maxBytes) {
      return { code: 'E3106', reason: `本地图片超过大小限制（${stat.size} 字节）` };
    }
  } catch (error) {
    return { code: 'E3108', reason: `本地路径不可访问：${messageOf(error)}` };
  }

  try {
    const buf = await fs.readFile(real);
    if (!buf.length) return { code: 'E3108', reason: '本地图片是空文件' };
    return accept(buf, 'local');
  } catch (error) {
    return { code: 'E3108', reason: `本地图片读取失败：${messageOf(error)}` };
  }
}

/* ------------------------------------------------------------ 统一验收 */

/**
 * 类型 / 字节 / 像素三项验收（所有来源共用）。
 *
 * 顺序是刻意的：先看字节再看类型，因为一张 500MB 的文本文件
 * 报"类型不对"会让人以为是格式问题，而真正的问题是它太大了。
 *
 * @param {Buffer} buf
 * @param {string} via
 * @returns {{ok: true, buffer: Buffer, mime: string, width: number, height: number, via: string}
 *         | {ok: false, code: string, reason: string}}
 */
function accept(buf, via) {
  // maxBytes 的真实检查在上游（避免超大分配）；这里只做兜底
  const mime = sniffMime(buf);
  if (!mime) {
    return { ok: false, code: 'E3105', reason: `不是 PNG/JPEG/GIF/WebP（${buf.length} 字节，头部 ${headHex(buf)}）` };
  }
  const dims = imageDimensions(buf);
  const width = Number(dims?.width) || 0;
  const height = Number(dims?.height) || 0;
  return { ok: true, buffer: buf, mime, width, height, via };
}

/**
 * 像素上限检查（在 `accept` 之后由调用方做，因为需要 limits）。
 *
 * 抽出来是因为 `accept()` 被多处调用而各处 limits 不同，
 * 混在里面很容易出现"某条路没查像素"的漏洞。
 *
 * @param {{width: number, height: number}} got
 * @param {number} maxPixels
 * @returns {{ok: true} | {ok: false, code: 'E3107', reason: string}}
 */
export function checkPixels(got, maxPixels) {
  const pixels = pixelCount(got);
  if (pixels <= 0) return { ok: true }; // 尺寸不可知：允许，但不算"检查通过"
  if (pixels > maxPixels) {
    return {
      ok: false,
      code: 'E3107',
      reason: `图片像素超限（${got.width}×${got.height} = ${pixels}，上限 ${maxPixels}）`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------- 默认传输 */

/**
 * 默认的 HTTP 传输：用**已校验的 IP** 直连，保留原 Host 与 TLS SNI。
 *
 * ## 为什么不能把域名交给 http 客户端
 *
 * 我们刚校验过 DNS 结果全部是公网地址。但如果我们只把 hostname 交给
 * 客户端，它会**再解析一次** —— 第二次解析可以返回 127.0.0.1（DNS rebinding）。
 * 所以这里连 IP，只把域名放进 Host 头与 SNI。
 *
 * ## 为什么总时限由自己控制
 *
 * socket 的 idle timeout 拦不住"每 100ms 发一个字节"的慢速滴流。
 * 这里用一个覆盖「连接 + 响应头 + 响应体」的总计时器，到点直接销毁连接。
 */
function defaultRequestOnce(input) {
  const { url, ip, maxBytes, timeoutMs } = input;
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let res = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      const error = fetchErr('E3109', `请求超时：${url.hostname}`);
      finish(error);
      req?.destroy?.(error);
      res?.destroy?.();
    }, Math.max(1, timeoutMs));
    timer.unref?.();

    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');

    try {
      req = mod.request(
        {
          hostname: ip,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            // 只带最少的东西：不带 cookie、不带 referer（那张图不需要它们，
            // 而带上它们等于把本机的会话信息发给图床）
            host: url.host,
            'user-agent': 'Ling-bot/vision',
            accept: 'image/*,*/*;q=0.8',
          },
          // SNI 必须是原域名（直连 IP 时不能拿 IP 当 SNI，否则证书校验必失败）
          servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
          rejectUnauthorized: url.protocol === 'https:',
        },
        (response) => {
          res = response;
          response.on('error', (error) => finish(error));
          response.on('aborted', () => finish(new Error('响应体读取中断')));
          response.on('close', () => {
            if (!response.complete) finish(new Error('响应体读取中断'));
          });
          if (settled) {
            response.destroy();
            return;
          }
          const statusCode = response.statusCode || 0;

          if (REDIRECT_STATUSES.has(statusCode)) {
            // 只取 Location，正文直接丢弃：否则对端可以用无限正文拖住我们
            finish(null, { statusCode, headers: response.headers, buffer: Buffer.alloc(0) });
            response.destroy();
            return;
          }

          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) {
              finish(fetchErr('E3106', `图片超过大小限制（${maxBytes} 字节）`));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            finish(null, { statusCode, headers: response.headers, buffer: Buffer.concat(chunks) });
          });
        },
      );
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
      req?.destroy?.();
    }
  });
}

/* ------------------------------------------------------------------ 工具 */

function normalizeLimits(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    maxBytes: positiveInt(src.maxBytes, DEFAULT_LIMITS.maxBytes),
    maxPixels: positiveInt(src.maxPixels, DEFAULT_LIMITS.maxPixels),
    timeoutMs: positiveInt(src.timeoutMs, DEFAULT_LIMITS.timeoutMs),
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 带码的错误。错误码只在契约 §3 的九个里选，不新造 */
function fetchErr(code, reason) {
  return Object.assign(new Error(reason), { code, reason });
}

/** 只接受契约里的码；其它（网络层的 ECONNREFUSED 之类）一律退到 fallback */
function pickCode(error, fallback) {
  const code = error?.code;
  return typeof code === 'string' && /^E310[1-9]$/.test(code) ? code : fallback;
}

function isTimeout(error) {
  return error?.code === 'E3109';
}

function classifyRequestError(error, url) {
  if (isTimeout(error)) return error;
  // 策略拒绝/超大/HTTP 状态码这些码已经在更里层判好了，原样往上报
  if (error?.code === 'E3104' || error?.code === 'E3106' || error?.code === 'E3103') return error;
  // 剩下的都是传输层问题（DNS、连接、TLS、对端断流），统一归到 E3103
  return fetchErr('E3103', `图片抓取失败：${url.host}（${messageOf(error)}）`);
}

function timeoutReason(ctx) {
  return `取图超时（${ctx.limits.timeoutMs}ms）`;
}

function messageOf(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}

/** realpath 之后的包含判定。Windows 大小写不敏感，比较前统一小写 */
function isInside(candidate, root) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const c = norm(path.resolve(candidate));
  const r = norm(path.resolve(root));
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 头部 8 字节的十六进制，用于"它到底是什么"的现场证据 */
function headHex(buf) {
  return buf.subarray(0, 8).toString('hex');
}

/** 给任意 promise 套一个总预算；超时抛 E3109 */
function withDeadline(promise, ctx) {
  const remaining = ctx.deadline - ctx.now();
  if (remaining <= 0) return Promise.reject(fetchErr('E3109', timeoutReason(ctx)));
  return withTimer(promise, remaining, timeoutReason(ctx));
}

/** 同 withDeadline，但直接给毫秒与文案（DNS / 单跳请求用） */
function withTimer(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(fetchErr('E3109', String(label)));
    }, Math.max(1, ms));
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 跑一跳；任何未预料的异常都变成该来源的失败码，而不是让整次取图炸掉 */
async function runHop(fn, ctx) {
  try {
    const r = await fn();
    if (!r || typeof r !== 'object') return { code: 'E3101', reason: '取图来源没有返回结果' };
    if (r.ok) {
      /*
       * 字节与像素两道检查在这里统一做，而不是散落在各来源里。
       *
       * 各来源自己的检查是**提前拒绝**（避免超大分配、避免下载到底才发现超限），
       * 这里是**最后一道**：任何一条新加的来源都不可能因为忘了检查而漏过去。
       */
      const bytes = Buffer.isBuffer(r.buffer) ? r.buffer.length : 0;
      if (bytes > ctx.limits.maxBytes) {
        return { code: 'E3106', reason: `图片超过大小限制（${bytes} 字节，上限 ${ctx.limits.maxBytes}）` };
      }
      const px = checkPixels(r, ctx.limits.maxPixels);
      if (!px.ok) return { code: px.code, reason: px.reason };
      return r;
    }
    return r;
  } catch (error) {
    if (isTimeout(error)) return { code: 'E3109', reason: timeoutReason(ctx) };
    return { code: pickCode(error, 'E3103'), reason: messageOf(error) };
  }
}

function fail(code, reason, attempts) {
  return {
    ok: false,
    code,
    reason,
    codes: Array.from(new Set(attempts.map((a) => a.code))),
  };
}
