/**
 * 视觉链路核心 —— 契约 §2/§3/§4/§5
 *
 * ## 这个测试文件的铁律：**一次网络请求都不发**
 *
 * 取图那一段的正常路径是"发 HTTP 请求"和"问网关要字节"。在测试里
 * 这两件事都必须被替换掉，否则：
 *
 *   - 测试会依赖外网（CI 上必挂，而失败原因看起来像代码 bug）；
 *   - 测试会真的把 QQ 图床的图放进仓库；
 *   - "SSRF 防护失效"这种问题反而测不出来 —— 因为真的连上了。
 *
 * 所以 `fetchImage` 的 `deps.getImage` / `deps.fetchUrl` / `deps.resolveHost` /
 * `deps.requestOnce` 全部注入假实现，连 DNS 都不解析。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  extractImageRefs,
  isProbablySafeCacheName,
  mediaRefsFromStored,
  pickPersistedRef,
  stripSecretsFromUrl,
} from '../src/llm/media-refs.mjs';
import {
  base64FromMaybe,
  decodedByteLength,
  imageDimensions,
  looksLikeImageBuffer,
  mimeFromUrl,
  pixelCount,
  sniffMime,
} from '../src/llm/image-bytes.mjs';
import {
  checkPixels,
  fetchImage,
  isPrivateIp,
  resolveSafeHost,
  safeFetchBuffer,
  validateUrlShape,
} from '../src/llm/image-fetch.mjs';
import {
  VISION_LIMITS_HARD,
  collectTurnImages,
  normalizeVisionConfig,
  resetVisionCache,
  visionCacheStats,
} from '../src/llm/vision.mjs';

/* ------------------------------------------------------------- 构造样本 */

/** 完整的小 PNG（真解码也认），像素数可控 */
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    // CRC 对我们的解析器不重要（我们只读 IHDR 的宽高），但留着长度字段一致
    const crc = Buffer.alloc(4);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // 一行真实像素数据（不做压缩，反正没有解码器校验 CRC）
  const raw = Buffer.alloc(1 + width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', raw),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 只伪造 IHDR 的 PNG 头：用来构造"声明 8000×8000 但只有几十字节"的图片炸弹 */
function makePngBomb(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'ascii').copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 2;
  return buf;
}

function makeGif(width, height) {
  const buf = Buffer.alloc(32);
  Buffer.from('GIF89a', 'ascii').copy(buf, 0);
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function makeJpeg(width, height) {
  const parts = [Buffer.from([0xff, 0xd8])];

  const app0 = Buffer.alloc(16);
  app0.writeUInt16BE(16, 0);
  Buffer.from('JFIF\0', 'ascii').copy(app0, 2);
  app0[7] = 1;
  app0[8] = 1;
  app0[9] = 0;
  app0.writeUInt16BE(1, 10);
  app0.writeUInt16BE(1, 12);
  parts.push(Buffer.from([0xff, 0xe0]), app0);

  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3;
  parts.push(Buffer.from([0xff, 0xc0]), sof);

  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function makeWebpVp8x(width, height) {
  const buf = Buffer.alloc(40);
  Buffer.from('RIFF', 'ascii').copy(buf, 0);
  buf.writeUInt32LE(32, 4);
  Buffer.from('WEBP', 'ascii').copy(buf, 8);
  Buffer.from('VP8X', 'ascii').copy(buf, 12);
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

/** 假 getImage：按 file 名返回预设结果 */
function fakeGetImage(map, counter) {
  return async ({ file }) => {
    if (counter) counter.n += 1;
    const hit = map[file];
    if (hit === undefined) throw new Error(`未知缓存名：${file}`);
    return typeof hit === 'function' ? hit() : hit;
  };
}

/* ------------------------------------------------------- §2 段 → 元数据 */

test('段 → 元数据：缓存名 / base64:// / 段内 URL 三分流', () => {
  const refs = extractImageRefs([
    { type: 'image', data: { file: 'ABCDEF0123.image', url: 'https://gchat.qpic.cn/a?term=2&key=secret' } },
    { type: 'image', data: { file: 'base64://aGVsbG8=' } },
    { type: 'image', data: { url: 'https://gchat.qpic.cn/b.png', file_size: '2048' } },
    { type: 'face', data: { id: '14' } },
    { type: 'record', data: { file: 'x.amr' } },
    { type: 'image', data: { file: '../../etc/passwd' } },
  ]);

  // face / record 不进视觉链路；越界文件名只保留为 localPath（能否读由 image-fetch 判定）
  assert.equal(refs.length, 4);

  assert.equal(refs[0].file, 'ABCDEF0123.image');
  assert.equal(refs[0].url, 'https://gchat.qpic.cn/a?term=2&key=secret');
  assert.equal(refs[0].name, 'ABCDEF0123.image');

  // base64:// 不是缓存名：绝不交出 file，只有内存字段 inline
  assert.equal(refs[1].file, '');
  assert.equal(refs[1].inline, 'aGVsbG8=');

  assert.equal(refs[2].file, '');
  assert.equal(refs[2].url, 'https://gchat.qpic.cn/b.png');
  assert.equal(refs[2].bytes, 2048);
  assert.equal(refs[2].name, 'b.png');

  assert.equal(refs[3].file, '');
  assert.equal(refs[3].localPath, '../../etc/passwd');
});

test('段 → 元数据：未知字段一律丢弃，不把上游私有字段带进会话 JSON', () => {
  const refs = extractImageRefs([
    { type: 'image', data: { file: 'a.png', url: 'https://x/a.png', path: 'C:\\secret.txt', foo: 'bar' } },
  ]);
  assert.equal(refs.length, 1);
  const keys = Object.keys(refs[0]).sort();
  assert.deepEqual(keys, ['bytes', 'file', 'height', 'kind', 'mime', 'name', 'url', 'width']);
  assert.equal(JSON.stringify(refs[0]).includes('secret'), false);
});

test('段 → 元数据：max 上限与脏输入', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ type: 'image', data: { file: `f${i}.png` } }));
  assert.equal(extractImageRefs(many).length, 8); // 默认 8
  assert.equal(extractImageRefs(many, { max: 3 }).length, 3);
  assert.equal(extractImageRefs(many, { max: 0 }).length, 0);
  assert.deepEqual(extractImageRefs(null), []);
  assert.deepEqual(extractImageRefs([null, 1, 'x', { type: 'image' }]).length, 1);
});

test('安全缓存名：路径 / 协议 / 盘符 / .. 一律拒绝', () => {
  for (const ok of ['a.png', 'ABCDEF.image', 'x_1-2.+=@z', '9f8e7d.webp']) {
    assert.equal(isProbablySafeCacheName(ok), true, ok);
  }
  for (const bad of [
    '../a.png',
    'a/b.png',
    'a\\b.png',
    'C:\\a.png',
    'http://x/a.png',
    'base64://AAAA',
    'file:///etc/passwd',
    'a\u0000.png',
    '',
    '   ',
    'x'.repeat(600),
    '..',
  ]) {
    assert.equal(isProbablySafeCacheName(bad), false, String(bad));
  }
});

test('持久化元数据：脏数据永不抛，缺 file 的项被丢弃', () => {
  assert.deepEqual(mediaRefsFromStored(null), []);
  assert.deepEqual(mediaRefsFromStored([null, 'x', 42]), []);
  // 没有 file 的记录重启后必然取不到，留着只会每回合产生 E3101 噪音
  assert.deepEqual(mediaRefsFromStored([{ kind: 'image', url: 'https://x/a.png' }]), []);

  const one = mediaRefsFromStored([
    { kind: 'image', file: 'a.png', mime: 'image/png', bytes: 123, width: 4, height: 5, name: 'a.png' },
  ]);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], {
    kind: 'image',
    file: 'a.png',
    url: '',
    mime: 'image/png',
    bytes: 123,
    width: 4,
    height: 5,
    name: 'a.png',
  });

  // 非法 mime / 负数 / 非数字全部归一化，不抛
  const dirty = mediaRefsFromStored([{ file: 'b.png', mime: 'text/html', bytes: -5, width: 'x', height: null }]);
  assert.equal(dirty[0].mime, '');
  assert.equal(dirty[0].bytes, 0);
  assert.equal(dirty[0].width, 0);
});

test('落盘投影：URL / inline / localPath 永远不进持久层', () => {
  const persisted = pickPersistedRef({
    kind: 'image',
    file: 'a.png',
    url: 'https://gchat.qpic.cn/a?key=secret',
    inline: 'aGVsbG8=',
    localPath: 'C:\\Users\\me\\a.png',
    mime: 'image/png',
    bytes: 10,
    width: 1,
    height: 1,
    name: 'a.png',
  });
  assert.equal(persisted.url, undefined);
  assert.equal(persisted.inline, undefined);
  assert.equal(persisted.localPath, undefined);
  assert.equal(JSON.stringify(persisted).includes('secret'), false);
  // URL 永不作为持久化依据
  assert.equal(stripSecretsFromUrl('https://x/a.png?key=1'), false);
});

/* --------------------------------------------------------- §3 字节判定 */

test('魔数：PNG / JPEG / GIF / WebP 各自认得，伪造头不认', () => {
  assert.equal(sniffMime(makePng(2, 2)), 'image/png');
  assert.equal(sniffMime(makeJpeg(2, 2)), 'image/jpeg');
  assert.equal(sniffMime(makeGif(2, 2)), 'image/gif');
  assert.equal(sniffMime(makeWebpVp8x(2, 2)), 'image/webp');

  // HTML 错误页 / 纯文本 / JSON / 空 / 太短
  assert.equal(sniffMime(Buffer.from('<!DOCTYPE html><html>404</html>')), '');
  assert.equal(sniffMime(Buffer.from('{"status":"failed"}')), '');
  assert.equal(sniffMime(Buffer.alloc(0)), '');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50])), '');
  assert.equal(sniffMime(null), '');
  assert.equal(sniffMime('not a buffer'), '');

  // 只有 PNG 前四字节、其余是 0 —— 完整签名（含 0d 0a 1a 0a）不满足，
  // 所以连魔数都不算通过：这正是"伪造头"该被拦在门口的样子
  const fake = Buffer.alloc(32);
  fake[0] = 0x89;
  fake[1] = 0x50;
  fake[2] = 0x4e;
  fake[3] = 0x47;
  assert.equal(sniffMime(fake), '');
  assert.equal(looksLikeImageBuffer(fake), false);

  // 完整签名 + 后面全是垃圾：魔数过、宽高解析必须失败（上层据此跳过像素检查）
  const sigOnly = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(sigOnly, 0);
  assert.equal(looksLikeImageBuffer(sigOnly), true);
  assert.equal(imageDimensions(sigOnly), null);

  // RIFF 但不是 WEBP（例如 WAV/AVI）
  const riff = Buffer.alloc(32);
  Buffer.from('RIFF', 'ascii').copy(riff, 0);
  Buffer.from('WAVE', 'ascii').copy(riff, 8);
  assert.equal(sniffMime(riff), '');
});

test('尺寸解析：PNG / JPEG / GIF / WebP 三种容器', () => {
  assert.deepEqual(imageDimensions(makePng(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageDimensions(makeGif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(makeJpeg(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(imageDimensions(makeWebpVp8x(800, 600)), { width: 800, height: 600 });

  // 尺寸不可知 ≠ 非法：返回 null 让上层"跳过像素检查并记 note"
  assert.equal(imageDimensions(Buffer.from('GIF89a')), null);
  assert.equal(imageDimensions(makeJpeg(1, 1).subarray(0, 20)), null);
});

test('像素：pixelCount / checkPixels 的边界', () => {
  assert.equal(pixelCount({ width: 100, height: 50 }), 5000);
  assert.equal(pixelCount(null), 0);
  assert.equal(pixelCount({ width: 0, height: 50 }), 0);

  assert.equal(checkPixels({ width: 6000, height: 6000 }, 36_000_000).ok, true);
  assert.equal(checkPixels({ width: 8000, height: 8000 }, 36_000_000).ok, false);
  // 算不出像素时放行（信息不足不该当成违规）
  assert.equal(checkPixels({ width: 0, height: 0 }, 36_000_000).ok, true);
});

test('base64 工具：三种形状 + 解码字节估算', () => {
  assert.equal(base64FromMaybe('base64://aGVsbG8='), 'aGVsbG8=');
  assert.equal(base64FromMaybe('data:image/png;base64,aGVsbG8='), 'aGVsbG8=');
  assert.equal(base64FromMaybe('aGVs\nbG8='), 'aGVsbG8=');
  assert.equal(base64FromMaybe('{"status":"ok"}'), null);
  assert.equal(base64FromMaybe(42), null);

  const buf = Buffer.from('hello world');
  const b64 = buf.toString('base64');
  assert.equal(decodedByteLength(b64), buf.length);
  assert.equal(decodedByteLength(''), 0);
});

test('mimeFromUrl：只按后缀给提示，不改变判定口径', () => {
  assert.equal(mimeFromUrl('https://x/a.PNG?k=1'), 'image/png');
  assert.equal(mimeFromUrl('https://x/a.webp'), 'image/webp');
  assert.equal(mimeFromUrl('https://x/a.gif'), 'image/gif');
  assert.equal(mimeFromUrl('https://x/a.jpeg'), 'image/jpeg');
  assert.equal(mimeFromUrl('not a url'), '');
});

/* --------------------------------------------------- §3 受控取图：来源 */

test('取图：安全缓存名走 get_image，成功返回字节与元数据', async () => {
  const png = makePng(8, 6);
  let calls = 0;
  const r = await fetchImage(
    { kind: 'image', file: 'ABCD.image', url: '', mime: '', bytes: 0, width: 0, height: 0, name: 'ABCD.image' },
    {
      limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 },
      deps: { getImage: fakeGetImage({ 'ABCD.image': { data: png.toString('base64') } }, { get n() { return calls; }, set n(v) { calls = v; } }) },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.mime, 'image/png');
  assert.equal(r.via, 'get_image');
  assert.equal(r.width, 8);
  assert.equal(r.height, 6);
  assert.equal(r.buffer.length, png.length);
});

test('取图：不安全的 file 不会交给网关（E3108 且零调用）', async () => {
  let called = 0;
  // `../../secret` 会被识别成"路径"而不是缓存名，于是走本地那一跳；
  // 但没配置 snowlumaDir（或越界），所以是 E3108 —— 关键是**网关一次都没被调用**
  const r = await fetchImage(
    { kind: 'image', file: '../../secret', url: '', mime: '', bytes: 0, width: 0, height: 0, name: 'secret' },
    { limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 }, deps: { getImage: async () => { called += 1; return {}; } } },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E3108');
  assert.equal(called, 0, '不安全缓存名绝不能进 get_image');
});

test('取图：没有来源（file/url 都为空）→ E3101', async () => {
  const r = await fetchImage(
    { kind: 'image', file: '', url: '', mime: '', bytes: 0, width: 0, height: 0, name: '图片1' },
    { limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 }, deps: { getImage: async () => ({}) } },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E3101');
});

test('取图：get_image 失败 / 返回垃圾 / 返回空字节 → E3102', async () => {
  const base = { kind: 'image', file: 'a.png', url: '', mime: '', bytes: 0, width: 0, height: 0, name: 'a.png' };
  const limits = { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 };

  const boom = await fetchImage(base, {
    limits,
    deps: { getImage: async () => { throw new Error('网关 500'); } },
  });
  assert.equal(boom.code, 'E3102');
  assert.match(boom.reason, /网关/);

  // 返回 HTML 错误页（有字节但不是图）
  const junk = await fetchImage(base, {
    limits,
    deps: { getImage: async () => ({ data: Buffer.from('<html>error</html>').toString('base64') }) },
  });
  assert.equal(junk.code, 'E3105');

  const empty = await fetchImage(base, {
    limits,
    deps: { getImage: async () => ({ data: 'base64://' }) },
  });
  assert.equal(empty.code, 'E3102');
});

test('取图：字节超限 E3106 —— 从长度估算就拒，不进解码器', async () => {
  const big = makePng(2, 2);
  // 声明 maxBytes 只有 10 字节
  const r = await fetchImage(
    { kind: 'image', file: 'a.png', url: '', mime: '', bytes: 0, width: 0, height: 0, name: 'a.png' },
    {
      limits: { maxBytes: 10, maxPixels: 1_000_000, timeoutMs: 1000 },
      deps: { getImage: async () => ({ data: big.toString('base64') }) },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E3106');
});

test('取图：像素超限 E3107（8000×8000 的 PNG 头）', async () => {
  const bomb = makePngBomb(8000, 8000);
  const r = await fetchImage(
    { kind: 'image', file: 'bomb.png', url: '', mime: '', bytes: 0, width: 0, height: 0, name: 'bomb.png' },
    {
      limits: { maxBytes: 4 * 1024 * 1024, maxPixels: 36_000_000, timeoutMs: 1000 },
      deps: { getImage: async () => ({ data: bomb.toString('base64') }) },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E3107');
  assert.match(r.reason, /8000×8000/);
});

test('取图：超时 E3109（get_image 永挂）', async () => {
  const r = await fetchImage(
    { kind: 'image', file: 'a.png', url: '', mime: '', bytes: 0, width: 0, height: 0, name: 'a.png' },
    {
      limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 30 },
      deps: { getImage: () => new Promise(() => {}) },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E3109');
});

test('取图：段内 URL 走注入的 fetchUrl', async () => {
  const png = makePng(4, 4);
  let seen = null;
  const r = await fetchImage(
    { kind: 'image', file: '', url: 'https://gchat.qpic.cn/a.png', mime: '', bytes: 0, width: 0, height: 0, name: 'a.png' },
    {
      limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 },
      deps: {
        fetchUrl: async (input) => {
          seen = input;
          return png;
        },
      },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.via, 'url');
  assert.equal(seen.url, 'https://gchat.qpic.cn/a.png');
  assert.equal(seen.maxBytes, 4096);
});

test('取图：URL 私网 / 环回 / 凭据 / 非 http(s) → E3104', async () => {
  const limits = { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 };
  for (const url of [
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://[::1]/a.png',
    'http://192.168.1.7/a.png',
    'http://10.0.0.5/a.png',
    'http://169.254.169.254/latest/meta-data',
    'https://user:pass@example.com/a.png',
    'file:///C:/a.png',
    'ftp://example.com/a.png',
  ]) {
    const r = await fetchImage(
      { kind: 'image', file: '', url, mime: '', bytes: 0, width: 0, height: 0, name: 'a.png' },
      { limits, deps: { fetchUrl: async () => { throw new Error('不该被调用'); } } },
    );
    assert.equal(r.ok, false, url);
    assert.equal(r.code, 'E3104', url);
  }
});

test('取图：域名解析到私网也被拒（DNS rebinding 面）', async () => {
  const r = await fetchImage(
    { kind: 'image', file: '', url: 'https://evil.example.com/a.png', mime: '', bytes: 0, width: 0, height: 0, name: 'a.png' },
    {
      limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 },
      deps: {
        resolveHost: async () => ['10.0.0.5'],
        requestOnce: async () => { throw new Error('不该被调用'); },
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E3104');
  assert.match(r.reason, /内网/);
});

test('取图：重定向到私网必须被逐跳校验拦住（E3104）', async () => {
  const png = makePng(4, 4);
  let hops = 0;
  const r = await fetchImage(
    { kind: 'image', file: '', url: 'https://cdn.example.com/a.png', mime: '', bytes: 0, width: 0, height: 0, name: 'a.png' },
    {
      limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 2000 },
      deps: {
        resolveHost: async () => ['93.184.216.34'],
        requestOnce: async ({ url }) => {
          hops += 1;
          if (hops === 1) {
            return { statusCode: 302, headers: { location: 'http://127.0.0.1:3458/steal' }, buffer: Buffer.alloc(0) };
          }
          return { statusCode: 200, headers: {}, buffer: png };
        },
      },
    },
  );
  assert.equal(hops, 1, '第二跳在校验阶段就被拦住，不该发出请求');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E3104');
});

test('safeFetchBuffer：跳转公网 → 公网可用；超跳数停止', async () => {
  const png = makePng(4, 4);
  const ok = await safeFetchBuffer('https://a.example.com/x', {
    maxBytes: 4096,
    timeoutMs: 2000,
    resolveHost: async () => ['93.184.216.34'],
    requestOnce: async ({ url }) => {
      if (url.hostname === 'a.example.com') {
        return { statusCode: 301, headers: { location: 'https://b.example.com/y.png' }, buffer: Buffer.alloc(0) };
      }
      return { statusCode: 200, headers: {}, buffer: png };
    },
  });
  assert.equal(ok.buffer.length, png.length);
  assert.match(ok.finalUrl, /b\.example\.com/);

  // 无限重定向：必须停下，而不是一直跟
  let n = 0;
  await assert.rejects(
    () =>
      safeFetchBuffer('https://loop.example.com/x', {
        maxBytes: 4096,
        timeoutMs: 2000,
        resolveHost: async () => ['93.184.216.34'],
        requestOnce: async () => {
          n += 1;
          return { statusCode: 302, headers: { location: 'https://loop.example.com/x' }, buffer: Buffer.alloc(0) };
        },
      }),
    (error) => {
      assert.equal(error.code, 'E3103');
      return true;
    },
  );
  assert.ok(n <= 6, `重定向跳数应有限，实际 ${n}`);
});

test('safeFetchBuffer：HTTP 非 2xx → E3103；超限 → E3106', async () => {
  const resolveHost = async () => ['93.184.216.34'];

  await assert.rejects(
    () =>
      safeFetchBuffer('https://a.example.com/x', {
        maxBytes: 4096,
        timeoutMs: 2000,
        resolveHost,
        requestOnce: async () => ({ statusCode: 404, headers: {}, buffer: Buffer.alloc(0) }),
      }),
    (error) => error.code === 'E3103',
  );

  await assert.rejects(
    () =>
      safeFetchBuffer('https://a.example.com/x', {
        maxBytes: 16,
        timeoutMs: 2000,
        resolveHost,
        requestOnce: async () => ({ statusCode: 200, headers: {}, buffer: makePng(4, 4) }),
      }),
    (error) => error.code === 'E3106',
  );
});

/* ------------------------------------------------- §3 本地路径与越界 */

test('本地路径：snowlumaDir 内可读，越界 / 未配置一律 E3108', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-core-'));
  try {
    const cacheDir = path.join(root, 'snowluma', 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const inside = path.join(cacheDir, 'ok.png');
    await fs.writeFile(inside, makePng(3, 3));

    const outside = path.join(root, 'outside.png');
    await fs.writeFile(outside, makePng(3, 3));

    const limits = { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 };

    const good = await fetchImage(
      { kind: 'image', file: '', url: '', localPath: inside, mime: '', bytes: 0, width: 0, height: 0, name: 'ok.png' },
      { limits, deps: { snowlumaDir: path.join(root, 'snowluma') } },
    );
    assert.equal(good.ok, true);
    assert.equal(good.via, 'local');
    assert.equal(good.mime, 'image/png');

    // ../ 越界
    const escape = await fetchImage(
      { kind: 'image', file: '', url: '', localPath: path.join(cacheDir, '..', '..', 'outside.png'), mime: '', bytes: 0, width: 0, height: 0, name: 'o.png' },
      { limits, deps: { snowlumaDir: path.join(root, 'snowluma') } },
    );
    assert.equal(escape.ok, false);
    assert.equal(escape.code, 'E3108');

    // 未配置缓存根 = 一律禁止（fail-closed）
    const none = await fetchImage(
      { kind: 'image', file: '', url: '', localPath: inside, mime: '', bytes: 0, width: 0, height: 0, name: 'ok.png' },
      { limits, deps: {} },
    );
    assert.equal(none.ok, false);
    assert.equal(none.code, 'E3108');

    // 不存在
    const missing = await fetchImage(
      { kind: 'image', file: '', url: '', localPath: path.join(cacheDir, 'nope.png'), mime: '', bytes: 0, width: 0, height: 0, name: 'n.png' },
      { limits, deps: { snowlumaDir: path.join(root, 'snowluma') } },
    );
    assert.equal(missing.code, 'E3108');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('本地路径：符号链接/junction 逃逸出缓存根 → E3108', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-core-link-'));
  const linkPath = path.join(root, 'snowluma', 'cache', 'escape');
  try {
    const cacheDir = path.join(root, 'snowluma', 'cache');
    const outsideDir = path.join(root, 'outside');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'secret.png'), makePng(2, 2));

    let linked = true;
    try {
      // Windows 上 'junction' 不需要管理员权限；POSIX 上退化成 'dir'
      await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked = false;
    }
    if (!linked) return; // 环境不支持符号链接：跳过这一条，而不是让它变成假失败

    const r = await fetchImage(
      {
        kind: 'image',
        file: '',
        url: '',
        localPath: path.join(linkPath, 'secret.png'),
        mime: '',
        bytes: 0,
        width: 0,
        height: 0,
        name: 'secret.png',
      },
      {
        limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 },
        deps: { snowlumaDir: path.join(root, 'snowluma') },
      },
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E3108');
  } finally {
    // junction 在 Windows 上不算普通目录，递归 rm 可能报 ENOTEMPTY；
    // 先单独摘掉链接再删临时根，避免清理失败把用例变成假红。
    await fs.rm(linkPath, { force: true, recursive: false }).catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('本地路径：目录不是普通文件（E3108）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-core-dir-'));
  try {
    const dir = path.join(root, 'cache', 'sub');
    await fs.mkdir(dir, { recursive: true });
    const r = await fetchImage(
      { kind: 'image', file: '', url: '', localPath: dir, mime: '', bytes: 0, width: 0, height: 0, name: 'sub' },
      { limits: { maxBytes: 4096, maxPixels: 1_000_000, timeoutMs: 1000 }, deps: { snowlumaDir: path.join(root, 'cache') } },
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E3108');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- §3 安全判定 */

test('isPrivateIp：内网/环回/链路本地/CGNAT/组播/内嵌 IPv4 全部拦下', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:c0a8:101',
    '2002:7f00:1::',
    '64:ff9b::c0a8:101',
    'not-an-ip',
    '',
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('validateUrlShape：只放行干净的 http(s)', () => {
  assert.equal(validateUrlShape('https://gchat.qpic.cn/a.png?term=2').ok, true);
  assert.equal(validateUrlShape('http://example.com:8080/a').ok, true);
  assert.equal(validateUrlShape('javascript:alert(1)').ok, false);
  assert.equal(validateUrlShape('data:image/png;base64,AAAA').ok, false);
  assert.equal(validateUrlShape('').ok, false);
  assert.equal(validateUrlShape('http://a.local/x').ok, false);
  assert.equal(validateUrlShape('http://a.internal/x').ok, false);
});

test('resolveSafeHost：本机名 / 私网 IP / 空解析结果都抛', async () => {
  await assert.rejects(() => resolveSafeHost('localhost'), (e) => e.code === 'E3104');
  await assert.rejects(() => resolveSafeHost('127.0.0.1'), (e) => e.code === 'E3104');
  await assert.rejects(() => resolveSafeHost(''), (e) => e.code === 'E3104');
  await assert.rejects(() => resolveSafeHost('a.example.com', async () => []), (e) => e.code === 'E3103');
  await assert.rejects(
    () => resolveSafeHost('a.example.com', async () => ['1.1.1.1', '10.0.0.1']),
    (e) => e.code === 'E3104',
  );
  assert.equal(await resolveSafeHost('a.example.com', async () => ['1.1.1.1']), '1.1.1.1');
});

/* ------------------------------------------------------- §4 预算与挑选 */

/** 一条带 n 张图的假历史楼层 */
function floorOf(floor, messageId, files) {
  return {
    floor,
    messageId,
    imagesSeen: false,
    evt: { segments: files.map((file) => ({ type: 'image', data: { file } })) },
  };
}

test('collectTurnImages：本次消息优先，引用次之，历史从新到旧', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const served = [];
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 2, maxHistoryImages: 2, historyWindow: 5, includeQuoted: true },
    convKey: 'group:1',
    trigger: { messageId: 100, evt: { segments: [{ type: 'image', data: { file: 'cur1.png' } }] } },
    quoted: { messageId: 90, evt: { segments: [{ type: 'image', data: { file: 'quo1.png' } }] } },
    history: [
      floorOf(1, 10, ['h1.png']),
      floorOf(2, 20, ['h2.png']),
      floorOf(3, 30, ['h3.png']),
    ],
    deps: {
      getImage: async ({ file }) => {
        served.push(file);
        return { data: png.toString('base64') };
      },
    },
    now: () => 1000,
  });

  assert.equal(r.images.length, 4); // 1 current + 1 quoted + 2 history
  assert.deepEqual(
    r.images.map((i) => i.origin),
    ['current', 'quoted', 'history', 'history'],
  );
  // 历史从新到旧：floor 3 先于 floor 2
  assert.deepEqual(
    r.images.filter((i) => i.origin === 'history').map((i) => i.floor),
    [3, 2],
  );
  assert.deepEqual(served, ['cur1.png', 'quo1.png', 'h3.png', 'h2.png']);
  assert.equal(r.stats.loaded, 4);
  assert.equal(r.stats.attempted, 4);
  assert.equal(r.stats.skipped, 0);
  // 契约 §9.1：stats 必须带"本回合"维度，界面用 attempted>0 && loaded===0 判 on-but-blocked
  assert.deepEqual(r.stats.codes, []);
  assert.equal(r.stats.attempted, r.stats.loaded + r.stats.skipped);
  assert.match(r.images[0].dataUrl, /^data:image\/png;base64,/);
});

test('collectTurnImages：alreadySeen 与 imagesSeen 让历史不再提交', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const served = [];
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 1, maxHistoryImages: 3, historyWindow: 10 },
    convKey: 'group:2',
    trigger: null,
    quoted: null,
    history: [
      { ...floorOf(1, 11, ['seen.png']), imagesSeen: true },
      floorOf(2, 22, ['a.png']),
      floorOf(3, 33, ['b.png']),
    ],
    alreadySeen: new Set([2]), // floor 2 已经提交过
    deps: {
      getImage: async ({ file }) => {
        served.push(file);
        return { data: png.toString('base64') };
      },
    },
    now: () => 0,
  });

  assert.deepEqual(served, ['b.png']);
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0].floor, 3);
});

test('collectTurnImages：historyWindow 之外的楼层不看', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const served = [];
  const history = [1, 2, 3, 4, 5].map((n) => floorOf(n, n * 10, [`f${n}.png`]));
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 0, maxHistoryImages: 5, historyWindow: 2 },
    convKey: 'group:3',
    history,
    deps: {
      getImage: async ({ file }) => {
        served.push(file);
        return { data: png.toString('base64') };
      },
    },
    now: () => 0,
  });
  assert.deepEqual(served, ['f5.png', 'f4.png']);
});

test('collectTurnImages：同一条消息里重复的图只取一次', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  let calls = 0;
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 4 },
    convKey: 'group:4',
    trigger: {
      messageId: 500,
      evt: {
        segments: [
          { type: 'image', data: { file: 'same.png' } },
          { type: 'image', data: { file: 'same.png' } },
        ],
      },
    },
    deps: {
      getImage: async () => {
        calls += 1;
        return { data: png.toString('base64') };
      },
    },
    now: () => 0,
  });
  assert.equal(calls, 1);
  assert.equal(r.images.length, 1);
});

test('collectTurnImages：引用与本期是同一条时不重复提交', async () => {
  resetVisionCache();
  let calls = 0;
  const png = makePng(2, 2);
  const evt = { messageId: 600, segments: [{ type: 'image', data: { file: 'x.png' } }] };
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 4, includeQuoted: true },
    convKey: 'group:5',
    trigger: { messageId: 600, evt },
    quoted: { messageId: 600, evt },
    deps: {
      getImage: async () => {
        calls += 1;
        return { data: png.toString('base64') };
      },
    },
    now: () => 0,
  });
  assert.equal(calls, 1);
  assert.equal(r.images.length, 1);
});

test('collectTurnImages：总张数上限（maxImagesPerTurn + maxHistoryImages）', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const history = [1, 2, 3, 4, 5].map((n) => floorOf(n, n * 10, [`h${n}.png`]));
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 1, maxHistoryImages: 1, historyWindow: 10 },
    convKey: 'group:6',
    trigger: { messageId: 900, evt: { segments: [{ type: 'image', data: { file: 'cur.png' } }] } },
    history,
    deps: {
      getImage: async () => ({ data: png.toString('base64') }),
    },
    now: () => 0,
  });
  assert.equal(r.images.length, 2);
  assert.equal(r.images[0].origin, 'current');
});

test('collectTurnImages：总字节预算把后来的图丢掉并记 note', async () => {
  resetVisionCache();
  const png = makePng(40, 40); // 每张几百字节
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 2, maxHistoryImages: 0, maxBytes: png.length, maxTotalBytes: png.length + 10 },
    convKey: 'group:7',
    trigger: {
      messageId: 700,
      evt: {
        segments: [
          { type: 'image', data: { file: 'one.png' } },
          { type: 'image', data: { file: 'two.png' } },
        ],
      },
    },
    deps: { getImage: async () => ({ data: png.toString('base64') }) },
    now: () => 0,
  });
  assert.equal(r.images.length, 1);
  assert.equal(r.stats.skipped, 1);
  assert.ok(r.notes.length > 0);
  assert.match(r.notes.join('\n'), /E3106|上限/);
});

test('★ 总字节预算被前面的图吃光时，仍然记录 E3106（否则 on-but-blocked 没有原因）', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const r = await collectTurnImages({
    // 恰好只够第一张：第二张的 remainingBytes 为 0，根本不会去取图
    config: { maxImagesPerTurn: 2, maxHistoryImages: 0, maxBytes: png.length * 2, maxTotalBytes: png.length },
    convKey: 'group:budget-a',
    trigger: {
      messageId: 750,
      evt: {
        segments: [
          { type: 'image', data: { file: 'first.png' } },
          { type: 'image', data: { file: 'second.png' } },
        ],
      },
    },
    deps: { getImage: async () => ({ data: png.toString('base64') }) },
    now: () => 0,
  });

  assert.equal(r.images.length, 1);
  assert.equal(r.stats.skipped, 1);
  /*
   * 宿主只在 `codes.length > 0` 时才把原因拼进占位说明（index.mjs 的
   * annotateImagePlaceholders 调用条件）。这条预算出口若不记码，用户与模型
   * 都看不到"第二张是被总字节预算挡下的"，界面的 lastCodes 也会是空的。
   */
  assert.deepEqual(r.codes, ['E3106'], `预算挡下也必须记 E3106，实际 ${JSON.stringify(r.codes)}`);
  assert.match(r.notes.join('\n'), /E3106/);
  // 契约的 on-but-blocked 判定依据：attempted>0 且 loaded===0
  assert.equal(r.stats.attempted, r.stats.loaded + r.stats.skipped);
});

test('★ 缓存命中但超出总字节预算时，同样记录 E3106（缓存热了也要有原因）', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const deps = { getImage: async () => ({ data: png.toString('base64') }) };
  const evt = {
    messageId: 751,
    segments: [
      { type: 'image', data: { file: 'c1.png' } },
      { type: 'image', data: { file: 'c2.png' } },
    ],
  };
  const run = (config) => collectTurnImages({
    config, convKey: 'group:budget-b', trigger: { messageId: 751, evt }, deps, now: () => 0,
  });

  // 第一次预算充足：两张都进内存缓存
  const first = await run({ maxImagesPerTurn: 2, maxHistoryImages: 0, cacheTtlMs: 300000 });
  assert.equal(first.images.length, 2);

  // 第二次预算只够一张：第二张走的是"缓存命中 + 超预算"这条出口
  const second = await run({ maxImagesPerTurn: 2, maxHistoryImages: 0, maxTotalBytes: png.length, cacheTtlMs: 300000 });
  assert.equal(second.images.length, 1);
  assert.equal(second.stats.skipped, 1);
  assert.deepEqual(second.codes, ['E3106'], `缓存命中被预算挡下也必须记码，实际 ${JSON.stringify(second.codes)}`);
  assert.match(second.notes.join('\n'), /E3106/);

  // 一张都装不下时，effective 的依据必须齐备：attempted>0 && loaded===0
  const third = await run({ maxImagesPerTurn: 2, maxHistoryImages: 0, maxTotalBytes: 1, cacheTtlMs: 300000 });
  assert.equal(third.images.length, 0);
  assert.equal(third.stats.attempted, 2);
  assert.equal(third.stats.loaded, 0);
  assert.deepEqual(third.codes, ['E3106', 'E3106'], '两张都被预算挡下，各记一次');
  assert.match(third.notes.join('\n'), /E3106/);
});

test('collectTurnImages：取图失败不抛，只记码与说明', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 4 },
    convKey: 'group:8',
    trigger: {
      messageId: 800,
      evt: {
        segments: [
          { type: 'image', data: { file: 'ok.png' } },
          { type: 'image', data: { file: 'bad.png' } },
        ],
      },
    },
    deps: {
      getImage: async ({ file }) => {
        if (file === 'ok.png') return { data: png.toString('base64') };
        return { data: Buffer.from('<html>nope</html>').toString('base64') };
      },
    },
    now: () => 0,
  });
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.codes, ['E3105']);
  assert.match(r.notes.join('\n'), /E3105/);
  assert.equal(r.stats.skipped, 1);
});

test('collectTurnImages：内存缓存命中（同会话同消息不再取图）', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  let calls = 0;
  const deps = {
    getImage: async () => {
      calls += 1;
      return { data: png.toString('base64') };
    },
  };
  const input = () => ({
    config: { maxImagesPerTurn: 2, cacheTtlMs: 300000 },
    convKey: 'group:9',
    trigger: { messageId: 900, evt: { segments: [{ type: 'image', data: { file: 'c.png' } }] } },
    deps,
    now: () => 1000,
  });

  const first = await collectTurnImages(input());
  assert.equal(calls, 1);
  const second = await collectTurnImages(input());
  assert.equal(calls, 1, 'TTL 内应命中缓存');
  assert.equal(second.images[0].dataUrl, first.images[0].dataUrl);

  // 另一个会话的同一 messageId 不能复用（否则会把 A 群的图提交到 B 群）
  await collectTurnImages({ ...input(), convKey: 'group:10' });
  assert.equal(calls, 2);

  // TTL 到期后重新取
  await collectTurnImages({ ...input(), now: () => 1000 + 300000 + 1 });
  assert.equal(calls, 3);
});

test('collectTurnImages：缓存条数上限（淘汰最旧）', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const deps = { getImage: async () => ({ data: png.toString('base64') }) };
  for (let i = 0; i < 40; i++) {
    await collectTurnImages({
      config: { maxImagesPerTurn: 1, cacheTtlMs: 300000 },
      convKey: 'group:cache',
      trigger: { messageId: 10_000 + i, evt: { segments: [{ type: 'image', data: { file: `m${i}.png` } }] } },
      deps,
      now: () => 0,
    });
  }
  const stats = visionCacheStats();
  assert.ok(stats.entries <= VISION_LIMITS_HARD.cacheMaxEntries, `条数 ${stats.entries}`);
  assert.ok(stats.bytes <= VISION_LIMITS_HARD.cacheMaxBytes, `字节 ${stats.bytes}`);
  resetVisionCache();
  assert.equal(visionCacheStats().entries, 0);
});

/* ------------------------------------------------------- §4 配置夹取 */

test('normalizeVisionConfig：夹到硬上限，坏值退回默认', () => {
  const def = normalizeVisionConfig();
  assert.equal(def.enabled, false);
  assert.equal(def.maxImagesPerTurn, 3);
  assert.equal(def.includeQuoted, true);

  const clamped = normalizeVisionConfig({
    enabled: 'yes',
    maxImagesPerTurn: 99,
    maxHistoryImages: 99,
    maxBytes: 999 * 1024 * 1024,
    maxTotalBytes: 999 * 1024 * 1024,
    maxPixels: 999_999_999,
    timeoutMs: 999_999,
    historyWindow: 999,
    cacheTtlMs: 99_999_999,
  });
  assert.equal(clamped.enabled, false, '字符串 "yes" 不是 true');
  assert.equal(clamped.maxImagesPerTurn, VISION_LIMITS_HARD.maxImagesPerTurn);
  assert.equal(clamped.maxHistoryImages, VISION_LIMITS_HARD.maxHistoryImages);
  assert.equal(clamped.maxBytes, VISION_LIMITS_HARD.maxBytes);
  assert.equal(clamped.maxTotalBytes, VISION_LIMITS_HARD.maxTotalBytes);
  assert.equal(clamped.maxPixels, VISION_LIMITS_HARD.maxPixels);
  assert.equal(clamped.timeoutMs, VISION_LIMITS_HARD.timeoutMs);
  assert.equal(clamped.historyWindow, VISION_LIMITS_HARD.historyWindow);
  assert.equal(clamped.cacheTtlMs, VISION_LIMITS_HARD.cacheTtlMs);

  const bad = normalizeVisionConfig({ maxBytes: 'abc', maxPixels: null, timeoutMs: 1 });
  assert.equal(bad.maxBytes, 4 * 1024 * 1024);
  assert.equal(bad.maxPixels, 36_000_000);
  assert.equal(bad.timeoutMs, 1000, '低于下限夹到下限');

  assert.equal(normalizeVisionConfig({ includeQuoted: false }).includeQuoted, false);
  // 硬上限本身是冻结的，改不动
  assert.equal(Object.isFrozen(VISION_LIMITS_HARD), true);
});

test('normalizeVisionConfig：契约 §9.1 的"写入宽松、生效收紧"逐项成立，且绝不抛', () => {
  // 配置层允许、运行时收紧的区间：全部必须**静默夹回**，而不是拒绝或抛错
  const cases = [
    // [输入, 期望生效值]
    [{ timeoutMs: 30000 }, 15000],
    [{ timeoutMs: 1000 }, 1000],
    [{ cacheTtlMs: 3_600_000 }, 300_000],
    [{ cacheTtlMs: 60_000 }, 60_000],
    // 字节/像素：配置允许到硬上限 2 倍
    [{ maxBytes: 8_388_608 }, 4_194_304],
    [{ maxTotalBytes: 16_777_216 }, 8_388_608],
    [{ maxPixels: 72_000_000 }, 36_000_000],
  ];
  for (const [input, expected] of cases) {
    const cfg = normalizeVisionConfig(input);
    const key = Object.keys(input)[0];
    assert.equal(cfg[key], expected, `${key}=${input[key]} 应夹到 ${expected}`);
  }

  // 绝不抛：老配置/手改配置/插件写进来的怪值全部能吃
  for (const raw of [
    null,
    undefined,
    0,
    'x',
    [],
    { maxBytes: {} },
    { maxImagesPerTurn: -1, maxHistoryImages: -1, timeoutMs: -1, cacheTtlMs: -1 },
    { historyWindow: Number.NaN },
    { enabled: 1 },
  ]) {
    assert.doesNotThrow(() => normalizeVisionConfig(raw), JSON.stringify(raw));
  }

  // historyWindow 的 0 是合法值（0 = 不回看历史楼层），不能被 fallback 吃掉
  assert.equal(normalizeVisionConfig({ historyWindow: 0 }).historyWindow, 0);
  assert.equal(normalizeVisionConfig({ maxImagesPerTurn: 0 }).maxImagesPerTurn, 0);
});

test('collectTurnImages：historyWindow=0 时完全不看历史', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  let calls = 0;
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 1, maxHistoryImages: 3, historyWindow: 0 },
    convKey: 'group:hw0',
    history: [floorOf(1, 10, ['a.png']), floorOf(2, 20, ['b.png'])],
    deps: {
      getImage: async () => {
        calls += 1;
        return { data: png.toString('base64') };
      },
    },
    now: () => 0,
  });
  assert.equal(calls, 0);
  assert.equal(r.images.length, 0);
  assert.equal(r.stats.attempted, 0);
});

test('stats 形状：attempted = loaded + skipped，codes 与顶层一致', async () => {
  resetVisionCache();
  const png = makePng(2, 2);
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 3 },
    convKey: 'group:stats',
    trigger: {
      messageId: 1234,
      evt: {
        segments: [
          { type: 'image', data: { file: 'ok1.png' } },
          { type: 'image', data: { file: 'bad.png' } },
          { type: 'image', data: { file: 'ok2.png' } },
        ],
      },
    },
    deps: {
      getImage: async ({ file }) =>
        file === 'bad.png' ? { data: Buffer.from('nope').toString('base64') } : { data: png.toString('base64') },
    },
    now: () => 0,
  });
  assert.deepEqual(Object.keys(r.stats).sort(), ['attempted', 'bytes', 'codes', 'loaded', 'skipped']);
  assert.equal(r.stats.attempted, 3);
  assert.equal(r.stats.loaded, 2);
  assert.equal(r.stats.skipped, 1);
  assert.equal(r.stats.attempted, r.stats.loaded + r.stats.skipped);
  assert.deepEqual(r.stats.codes, r.codes);
  assert.deepEqual(r.stats.codes, ['E3105']);
  assert.ok(r.stats.bytes > 0);
});

test('stats：一图未得时 attempted>0 && loaded===0（on-but-blocked 的判定依据）', async () => {
  resetVisionCache();
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 2 },
    convKey: 'group:blocked',
    trigger: {
      messageId: 4321,
      evt: { segments: [{ type: 'image', data: { file: 'x.png' } }] },
    },
    deps: {
      getImage: async () => {
        throw new Error('网关挂了');
      },
    },
    now: () => 0,
  });
  assert.equal(r.images.length, 0);
  assert.equal(r.stats.loaded, 0);
  assert.ok(r.stats.attempted > 0);
  assert.deepEqual(r.stats.codes, ['E3102']);
});

test('泄漏边界：images 只带 dataUrl，notes/codes 不含 URL 与 base64', async () => {
  resetVisionCache();
  const secretUrl = 'https://gchat.qpic.cn/gchatpic_new/1/2-3?term=2&key=SUPERSECRET';
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 2 },
    convKey: 'group:leak',
    trigger: {
      messageId: 5555,
      evt: {
        segments: [
          // URL 是私网/非法 → 失败，失败原因里原本可能带着 URL
          { type: 'image', data: { url: 'http://127.0.0.1:3458/steal?token=abc', file: '' } },
          { type: 'image', data: { url: secretUrl, file: '' } },
        ],
      },
    },
    deps: {
      // 让第二张图走到"抓取失败"，错误信息里带完整 URL
      fetchUrl: async ({ url }) => {
        throw new Error(`图片抓取失败：${url}`);
      },
      resolveHost: async () => ['93.184.216.34'],
    },
    now: () => 0,
  });

  const notes = r.notes.join('\n');
  // notes / codes 里绝不能出现完整 URL 或 base64
  assert.equal(notes.includes('SUPERSECRET'), false, notes);
  assert.equal(notes.includes('token=abc'), false, notes);
  assert.equal(notes.includes('gchat.qpic.cn'), false, notes);
  assert.equal(/[A-Za-z0-9+/]{40,}={0,2}/.test(notes), false, notes);
  // images 只有 dataUrl（模型提交用），没有 url/原始 base64 字段
  for (const img of r.images) {
    assert.equal(img.url, undefined);
    assert.equal(img.buffer, undefined);
    assert.equal(typeof img.dataUrl, 'string');
    if (img.dataUrl) assert.match(img.dataUrl, /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/);
  }
  // codes 只允许契约 §3 的九个码
  for (const code of r.codes) assert.match(code, /^E310[1-9]$/);
});

test('泄漏边界：成功的取图结果里不带任何 URL/inline/localPath', async () => {
  resetVisionCache();
  const png = makePng(4, 4);
  const r = await collectTurnImages({
    config: { maxImagesPerTurn: 1 },
    convKey: 'group:leak2',
    trigger: {
      messageId: 6666,
      evt: {
        segments: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/x?key=SECRET2', file: 'safe.png' } }],
      },
    },
    deps: { getImage: async () => ({ data: png.toString('base64') }) },
    now: () => 0,
  });
  assert.equal(r.images.length, 1);
  const keys = Object.keys(r.images[0]).sort();
  assert.deepEqual(keys, ['bytes', 'dataUrl', 'floor', 'height', 'index', 'label', 'messageId', 'mime', 'origin', 'width']);
  assert.equal(JSON.stringify(r.images[0]).includes('SECRET2'), false);
  assert.equal(JSON.stringify(r.stats).includes('SECRET2'), false);
  assert.equal(JSON.stringify(r.notes).includes('SECRET2'), false);
});
