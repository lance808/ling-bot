/**
 * Standalone, text-only OpenAI images/generations protocol. No DSH, persistence,
 * logging, retries, or QQ side effects. apiUrl is explicit trusted configuration;
 * image URLs are untrusted and always pass the project's SSRF checks.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const MIB = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * MIB;
const MAX_DOWNLOAD_BYTES = 10 * MIB;
const ROW_OVERHEAD = 64 * 1024;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Only locally authored messages are exposed; never attach upstream errors/causes. */
class ProtocolError extends Error {}
function failure(code, outcomeUnknown, status) {
  const error = Object.assign(new ProtocolError(`Image generation failed (${code}).`), {
    name: 'ImageGenerationError', code, outcomeUnknown,
  });
  if (status !== undefined) error.status = status;
  return error;
}

/** Local/private HTTP APIs are allowed, but embedded credentials/query/hash are not. */
export function generationsEndpoint(apiUrl) {
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) throw failure('CONFIG_BAD_API_URL', false);
  let url;
  try { url = new URL(apiUrl.trim()); } catch { throw failure('CONFIG_BAD_API_URL', false); }
  // Check delimiters as well: URL.search/hash omit an empty '?' or '#'.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || apiUrl.includes('?') || apiUrl.includes('#')) throw failure('CONFIG_BAD_API_URL', false);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/images/generations') ? path : `${path}/images/generations`;
  return url.href;
}

function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw failure('CONFIG_BAD_SNAPSHOT', false);
  return value;
}

function prepare(snapshot, apiKey) {
  if (!snapshot || typeof snapshot !== 'object') throw failure('CONFIG_BAD_SNAPSHOT', false);
  const endpoint = generationsEndpoint(snapshot.apiUrl);
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\x00-\x1f\x7f]/.test(apiKey)) {
    throw failure('CONFIG_BAD_API_KEY', false);
  }
  if (typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim()) throw failure('BAD_PROMPT', false);
  const payload = { prompt: snapshot.prompt.trim(), n: integer(snapshot.count, 1, 8), response_format: 'b64_json' };
  for (const key of ['model', 'size']) {
    if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string') throw failure('CONFIG_BAD_SNAPSHOT', false);
    if (snapshot[key]?.trim()) payload[key] = snapshot[key].trim();
  }
  const timeoutMs = integer(snapshot.timeoutMs, 180_000, 2_147_483_647);
  const maxImageBytes = integer(snapshot.maxImageBytes, MAX_DOWNLOAD_BYTES, MAX_RESPONSE_BYTES);
  // Base64 expansion + bounded JSON/URL metadata, scaled with the requested count.
  const responseLimit = Math.min(MAX_RESPONSE_BYTES, payload.n * (4 * Math.ceil(maxImageBytes / 3) + ROW_OVERHEAD));
  return { endpoint, key: apiKey.trim(), payload, timeoutMs, maxImageBytes, responseLimit };
}

async function discard(response) {
  // Do not await a potentially uncooperative stream cancellation.
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
}

async function boundedJson(response, limit) {
  const declared = response.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await discard(response);
    throw failure('UPSTREAM_TOO_LARGE', true);
  }
  if (!response.body?.getReader) throw failure('UPSTREAM_BAD_JSON', true);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw failure('UPSTREAM_TOO_LARGE', true);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch { throw failure('UPSTREAM_BAD_JSON', true); }
}

function decodeBase64(raw, maxBytes) {
  // Canonical RFC 4648 base64 only: no ignored whitespace/garbage, URL alphabet,
  // missing padding, or nonzero pad bits (Buffer.from alone silently accepts all).
  let text = raw;
  if (text.startsWith('data:')) {
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,(.*)$/s.exec(text);
    if (!match) throw failure('UPSTREAM_BAD_BASE64', true);
    text = match[1];
  }
  if (!text.length || text.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw failure('UPSTREAM_BAD_BASE64', true);
  }
  const bytes = text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0);
  if (bytes > maxBytes) throw failure('UPSTREAM_IMAGE_TOO_LARGE', true);
  const buffer = Buffer.from(text, 'base64');
  if (buffer.toString('base64') !== text) throw failure('UPSTREAM_BAD_BASE64', true);
  return buffer;
}

function imageResult(buffer, maxBytes) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw failure('UPSTREAM_BAD_IMAGE', true);
  if (buffer.length > maxBytes) throw failure('UPSTREAM_IMAGE_TOO_LARGE', true);
  const mime = sniffMime(buffer);
  if (!mime) throw failure('UPSTREAM_BAD_IMAGE', true);
  return { buffer, mime, extension: EXTENSIONS[mime] };
}

function imageUrl(row) {
  // Some gateways put the URL under either key, as a string or {url: string}.
  for (const item of [row?.url, row?.image_url]) {
    if (typeof item === 'string' && item) return item;
    if (typeof item?.url === 'string' && item.url) return item.url;
  }
  return null;
}

// Portable narrow implementation of src/net/http.mjs's safe download design:
// validate all DNS answers, pin the selected IP, retain Host/TLS SNI, bound the
// entire body, and refuse redirects. Kept here so an installed plugin does not
// depend on a source checkout or DSH. Deliberately no generic fetch download seam.
function privateIpv4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113 || a >= 224;
}
function privateIp(ip) {
  const family = net.isIP(ip);
  if (!family || ip.includes('%')) return true;
  if (family === 4) return privateIpv4(ip);
  // Only global unicast 2000::/3; reject transition mechanisms/reserved ranges
  // outright rather than risk their embedded IPv4 or tunnel reaching a LAN.
  const host = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  if (!/^[23][0-9a-f]{3}:/.test(host)) return true;
  const second = host.split(':')[1];
  return host.startsWith('2002:') || host.startsWith('2001:db8:')
    || host.startsWith('2001:') && parseInt(second || '0', 16) < 0x200;
}
function validateUrlShape(raw) {
  let url;
  try { url = new URL(raw); } catch { return { ok: false }; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)
      || net.isIP(host) && privateIp(host)) return { ok: false };
  return { ok: true, url };
}
async function resolveSafeHost(hostname, resolveHost, signal) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (net.isIP(host)) {
    if (privateIp(host)) throw { code: 'E3104' };
    return host;
  }
  // Abort-aware race prevents an unresolved resolver from holding the workflow.
  const answers = await new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener('abort', stop);
      reject(failure('UPSTREAM_ABORTED', true));
    };
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(() => resolveHost ? resolveHost(host) : dns.lookup(host, { all: true, verbatim: true }))
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
  if (!Array.isArray(answers) || !answers.length) throw failure('UPSTREAM_IMAGE_DOWNLOAD_FAILED', true);
  const addresses = answers.map((answer) => typeof answer === 'string' ? answer : answer?.address);
  if (addresses.some((address) => typeof address !== 'string' || privateIp(address))) throw { code: 'E3104' };
  return addresses[0];
}
function requestOnce(input) {
  if (input.requestOnce) return input.requestOnce(input);
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
      // Every path closes the socket, including non-2xx and the one-byte probe.
      response?.destroy();
      request?.destroy();
    };
    const abort = () => finish(failure('UPSTREAM_ABORTED', true));
    const timer = setTimeout(() => finish(failure('UPSTREAM_TIMEOUT', true)), input.timeoutMs);
    if (input.signal.aborted) { abort(); return; }
    input.signal.addEventListener('abort', abort, { once: true });
    const { url } = input;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    try {
      request = (url.protocol === 'https:' ? https : http).request({
        hostname: input.ip, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`, method: 'GET',
        headers: { host: url.host, accept: input.accept, 'user-agent': input.userAgent,
          'accept-encoding': 'identity', connection: 'close' },
        servername: url.protocol === 'https:' && !net.isIP(host) ? host : undefined,
        rejectUnauthorized: true,
      }, (res) => {
        response = res;
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(failure('UPSTREAM_IMAGE_DOWNLOAD_FAILED', true)));
        res.on('close', () => { if (!res.complete) finish(failure('UPSTREAM_IMAGE_DOWNLOAD_FAILED', true)); });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          finish(null, { statusCode, buffer: Buffer.alloc(0) });
          return;
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          finish(failure('UPSTREAM_IMAGE_DOWNLOAD_FAILED', true));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          if (size + chunk.length >= input.maxBytes) {
            finish(null, { statusCode, buffer: Buffer.alloc(0), truncated: true });
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on('end', () => finish(null, { statusCode, buffer: Buffer.concat(chunks, size) }));
      });
      request.on('error', (error) => finish(error));
      request.end();
    } catch (error) { finish(error); }
  });
}
function sniffMime(buffer) {
  if (buffer.length < 12) return '';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('latin1', 0, 6))) return 'image/gif';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

async function downloadImage(raw, context) {
  const shape = validateUrlShape(raw);
  if (!shape.ok || shape.url.hash || raw.includes('#')) throw failure('UPSTREAM_IMAGE_URL_BLOCKED', true);
  let ip;
  try { ip = await resolveSafeHost(shape.url.hostname, context.downloadDeps?.resolveHost, context.signal); }
  catch (error) {
    throw failure(error?.code === 'E3104' ? 'UPSTREAM_IMAGE_URL_BLOCKED' : 'UPSTREAM_IMAGE_DOWNLOAD_FAILED', true);
  }
  context.check();
  const maxBytes = Math.min(context.maxImageBytes, MAX_DOWNLOAD_BYTES);
  let response;
  try {
    response = await requestOnce({
      url: shape.url, ip,
      // The shared transport reports truncated at >= maxBytes. One probe byte
      // distinguishes an exactly-at-limit image from a genuinely oversized one.
      maxBytes: maxBytes + 1,
      timeoutMs: Math.max(1, context.deadline - Date.now()),
      signal: context.signal,
      accept: 'image/png,image/jpeg,image/gif,image/webp',
      userAgent: 'Ling-bot/image-generation',
      requestOnce: context.downloadDeps?.requestOnce,
    });
  } catch { throw failure('UPSTREAM_IMAGE_DOWNLOAD_FAILED', true); }
  context.check();
  const status = Number(response?.statusCode);
  if (status >= 300 && status < 400) throw failure('UPSTREAM_IMAGE_REDIRECT', true);
  if (!(status >= 200 && status < 300)) throw failure('UPSTREAM_IMAGE_DOWNLOAD_FAILED', true);
  if (response.truncated || response.buffer?.length > maxBytes) throw failure('UPSTREAM_IMAGE_TOO_LARGE', true);
  return imageResult(response.buffer, maxBytes);
}

/**
 * @param {object} input
 * @param {{apiUrl:string,model?:string,size?:string,count?:number,prompt:string,timeoutMs?:number,maxImageBytes?:number}} input.snapshot
 * @param {string} input.apiKey Explicit caller-owned key; no credential files are read.
 * @param {AbortSignal} [input.signal]
 * @param {typeof fetch} [input.fetchImpl] Trusted test seam for POST only.
 * @param {{resolveHost?:Function,requestOnce?:Function}} [input.downloadDeps]
 * Trusted DNS/transport test seams; URL and DNS safety checks still run. No API
 * authorization/cookie headers are ever forwarded to image downloads.
 * @returns {Promise<Array<{buffer:Buffer,mime:string,extension:string}>>}
 * Errors expose code and outcomeUnknown. After POST invocation every failure is
 * conservatively unknown (possibly billed), except an explicit HTTP 4xx response.
 * One total timeout includes POST, body parsing, DNS, and all image downloads.
 */
export async function generateImages({ snapshot, apiKey, signal, fetchImpl = globalThis.fetch, downloadDeps } = {}) {
  const prepared = prepare(snapshot, apiKey);
  if (signal?.aborted) throw failure('UPSTREAM_ABORTED', false);
  const controller = new AbortController();
  const deadline = Date.now() + prepared.timeoutMs;
  let submitted = false;
  let abortError;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = (code) => {
    if (abortError) return;
    abortError = failure(code, submitted);
    controller.abort();
    rejectAbort(abortError);
  };
  const onAbort = () => abort('UPSTREAM_ABORTED');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort('UPSTREAM_TIMEOUT'), prepared.timeoutMs);
  const check = () => {
    if (abortError) throw abortError;
    if (Date.now() >= deadline) { abort('UPSTREAM_TIMEOUT'); throw abortError; }
  };
  const work = async () => {
    check();
    submitted = true;
    // Exactly one invocation. Never retry a potentially billable POST, including
    // connection errors/5xx, and never allow automatic redirects to resend a key.
    const response = await fetchImpl(prepared.endpoint, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${prepared.key}` },
      body: JSON.stringify(prepared.payload),
    });
    check();
    const status = Number(response?.status);
    if (!(status >= 200 && status < 300)) {
      await discard(response);
      if (status >= 300 && status < 400) throw failure('UPSTREAM_REDIRECT', true, status);
      throw failure('UPSTREAM_HTTP_ERROR', !(status >= 400 && status < 500), Number.isFinite(status) ? status : undefined);
    }
    const body = await boundedJson(response, prepared.responseLimit);
    check();
    if (!Array.isArray(body?.data) || !body.data.length) throw failure('UPSTREAM_NO_IMAGE', true);
    if (body.data.length > prepared.payload.n) throw failure('UPSTREAM_IMAGE_COUNT', true);
    const results = [];
    for (const row of body.data) {
      check();
      if (typeof row?.b64_json === 'string') {
        results.push(imageResult(decodeBase64(row.b64_json, prepared.maxImageBytes), prepared.maxImageBytes));
      } else {
        const url = imageUrl(row);
        if (!url) throw failure('UPSTREAM_BAD_IMAGE_ROW', true);
        results.push(await downloadImage(url, {
          downloadDeps, deadline, check, signal: controller.signal, maxImageBytes: prepared.maxImageBytes,
        }));
      }
    }
    check();
    return results;
  };
  try {
    return await Promise.race([work(), abortPromise]);
  } catch (error) {
    if (abortError) throw abortError;
    if (error instanceof ProtocolError) throw error;
    throw failure('UPSTREAM_UNREACHABLE', submitted);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Also cancel in-flight body reads when the deadline wins Promise.race.
    controller.abort();
  }
}
