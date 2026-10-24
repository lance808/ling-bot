/**
 * 图片字节的纯函数层 —— 魔数、宽高、像素
 *
 * ## 为什么按魔数判定，而不信 mime / 扩展名 / Content-Type
 *
 * 这条链路上的类型信息**全部来自外部**：OneBot 段的 `mime` 可以是任意字符串，
 * HTTP 的 `Content-Type` 由对端决定，文件名更是谁都能改。而我们要做的是
 * 把字节塞进上游模型请求体 —— 类型判断错了，轻则 400，重则把一段
 * 任意二进制当成图片送出去。
 *
 * 所以唯一的判据是**头部字节**。上层给的 mime 只当"提示"，不当事实验收。
 *
 * ## 为什么还要解析宽高
 *
 * "图片炸弹"：一张 200 字节的 PNG 头可以声明 60000×60000，解码端要按
 * 2.4G 像素分配内存 —— 那会直接把进程拖死，而且**字节上限完全拦不住**
 * （文件确实只有 200 字节）。所以像素上限必须在交给上游之前自己算。
 */

/** 支持的四类格式（与契约 §3 的 E3105 同一份口径） */
export const ALLOWED_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 单张图片的绝对像素硬顶：再大就不解码了（与契约的 maxPixels 无关，这是防线本身） */
export const ABSOLUTE_MAX_PIXELS = 100_000_000;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 字节是否是一张**至少看起来像**的图片。
 *
 * "看起来像"就够了：这个函数只用来在解码前快速否掉明显的垃圾
 * （HTML 错误页、纯文本、空响应）。真正的格式合法性由上游解码器判断，
 * 我们不重复实现解码器。
 *
 * @param {unknown} buf
 * @returns {boolean}
 */
export function looksLikeImageBuffer(buf) {
  return sniffMime(buf) !== '';
}

/**
 * 按魔数判定 mime；不认识则返回空串。
 *
 * 空串（而不是 `application/octet-stream`）是刻意的：
 * 调用方必须要为"未知"单独写一个分支，就不能"顺手当成 JPEG 用"。
 *
 * @param {unknown} buf
 * @returns {'' | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'}
 */
export function sniffMime(buf) {
  if (!Buffer.isBuffer(buf)) return '';
  // 12 字节是这四种格式判定所需的最短长度（WebP 要看到第 12 字节的 'WEBP'）
  if (buf.length < 12) return '';

  if (PNG_SIG.every((b, i) => buf[i] === b)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return '';
}

/**
 * 解析宽高；解析不出来返回 null。
 *
 * 返回 null 的语义是"不知道"，**不是**"非法"：
 * JPEG 的 SOF 段可能出现在很靠后的位置（有的编码器会先放一堆大块 EXIF），
 * 缓冲区被截断时找不到 SOF 很正常，而那张图本身是好的。
 * 所以上层对 null 的处理是"跳过像素检查并记一条 note"，而不是拒绝。
 *
 * @param {unknown} buf
 * @returns {{width: number, height: number} | null}
 */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const mime = sniffMime(buf);
  try {
    let dims = null;
    if (mime === 'image/png') dims = pngDimensions(buf);
    else if (mime === 'image/gif') dims = gifDimensions(buf);
    else if (mime === 'image/jpeg') dims = jpegDimensions(buf);
    else if (mime === 'image/webp') dims = webpDimensions(buf);
    /*
     * 0×0 之类的维度必须归一成 null（"不知道"），而不是原样返回。
     *
     * 理由：`pixelCount()` 对 0 维度返回 0，而 0 在像素检查里被当成
     * "算不出来，放行"。如果这里把 0×0 当成有效答案，那么一个伪造的
     * 全零 IHDR 就能让像素上限完全失效。归一成 null 之后，
     * 上层至少还能按"尺寸不可知"统一处理。
     */
    if (!dims || !(dims.width > 0) || !(dims.height > 0)) return null;
    return dims;
  } catch {
    // 越界读会抛 RangeError。历史数据/半截下载都可能走到这里，
    // 而"解析不出尺寸"绝不该让整个回合失败。
  }
  return null;
}

/**
 * 像素数；维度不可知时返回 0（表示"算不出来"，而不是"零像素"）。
 *
 * @param {{width?: number, height?: number} | null | undefined} dims
 * @returns {number}
 */
export function pixelCount(dims) {
  const w = Number(dims?.width) || 0;
  const h = Number(dims?.height) || 0;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * 这张图片是不是**动态**的（会动）。
 *
 * ## 为什么要单独判一次
 *
 * 表情包里有相当一部分是 GIF 动图，而「读图」这条链路上有一个很容易被
 * 忽略的事实：**大多数视觉接口只取第一帧**。模型看到的是静态画面，
 * 它却会以为自己看到了整张图，然后在回复里描述"它左右横跳""它转了一圈"。
 *
 * 那种描述不是幻觉的普通形态（凭空编内容），而是**基于真实输入的过度推断**，
 * 更难被审计发现。所以判出 `animated` 之后，调用方必须把"你只看到第一帧"
 * 讲给模型听 —— 见 sticker 插件与 `docs/stickers-contract.md` §7。
 *
 * ## 三种容器的判据都不一样
 *
 *   · GIF：数图像描述符（0x2C）。≥2 个才是动图 —— 只看有没有
 *     NETSCAPE 扩展是不够的，有些单帧 GIF 也带那个块。
 *   · PNG：动图是 APNG，多一个 `acTL` 块。它通常紧跟在 IHDR 之后，
 *     但规范没强制位置，所以按块遍历找。
 *   · WebP：动画的标志在 VP8X 的 flag 位（bit 1）或出现 `ANIM` 块。
 *
 * 判不出来时一律返回 false（"当作静态"）：把静态当动态只是多说一句话，
 * 把动态当静态才会让模型编动作。等等 —— 反了。
 *
 * 这里取的是**保守方向**：**不确定时按"可能动态"处理**更安全，
 * 因为误报的代价是多一句提醒，漏报的代价是模型确信自己看到了动作。
 * 但"不确定"在实现上很难界定，所以实际策略是：
 * 明确判出动态才返回 true，其余 false；而调用方的文案对
 * `mime === 'image/gif'` 会**无条件**加一句"动图可能只看得到第一帧"。
 * 两道加起来既不会漏，也不会对 PNG 静图反复啰嗦。
 *
 * @param {unknown} buf
 * @returns {boolean}
 */
export function isAnimatedImage(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  const mime = sniffMime(buf);
  try {
    if (mime === 'image/gif') return gifFrameCount(buf) > 1;
    if (mime === 'image/png') return hasPngChunk(buf, 'acTL');
    if (mime === 'image/webp') return webpIsAnimated(buf);
  } catch {
    // 半截文件、越界读：当作静态，交给上层的"动图可能只看第一帧"兜底
  }
  return false;
}

/**
 * 数 GIF 里的图像描述符个数（每个 0x2C 开始一个帧）。
 *
 * 不做完整解析：只要看到第二个帧就可以停了。块结构里 `0x21` 是扩展
 * （后面跟标签 + 子块链），`0x3B` 是 trailer。
 *
 * @param {Buffer} buf
 * @returns {number}
 */
function gifFrameCount(buf) {
  let offset = 13; // 6 字节签名 + 7 字节逻辑屏幕描述符
  const packed = buf[10];
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1)); // 全局调色板

  let frames = 0;
  while (offset < buf.length) {
    const block = buf[offset];
    if (block === 0x3b) break;
    if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return frames;
      // 图像描述符：1 + 2 + 2 + 2 + 2 字节 = 10，然后按位判局部调色板
      const local = buf[offset + 9];
      offset += 10;
      if (local & 0x80) offset += 3 * (2 ** ((local & 0x07) + 1));
      offset += 1; // LZW 最小码长
      offset = skipGifSubBlocks(buf, offset);
      continue;
    }
    if (block === 0x21) {
      offset += 2; // 扩展引导 + 标签
      offset = skipGifSubBlocks(buf, offset);
      continue;
    }
    break; // 认不出的字节：停止，避免死循环
  }
  return frames;
}

/**
 * 跳过 GIF 的子块链（每块 1 字节长度，0 表示结束）。
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {number}
 */
function skipGifSubBlocks(buf, offset) {
  let i = offset;
  while (i < buf.length) {
    const size = buf[i];
    i += 1;
    if (size === 0) return i;
    i += size;
  }
  return i;
}

/**
 * PNG 里是否存在某个块类型（如 `acTL`）。
 *
 * 按 IHDR 的真实长度往后走，而不是假设它固定 13 字节 ——
 * 长度字段就在块头里，读它比信任规范更可靠（也顺手防住畸形文件）。
 *
 * @param {Buffer} buf
 * @param {string} type 4 字符块名
 * @returns {boolean}
 */
function hasPngChunk(buf, type) {
  let offset = 8; // 跳过 8 字节签名
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const name = buf.toString('ascii', offset + 4, offset + 8);
    if (name === type) return true;
    if (name === 'IDAT' || name === 'IEND') return false; // acTL 只会在 IDAT 之前
    offset += 12 + len; // 4 长度 + 4 类型 + 数据 + 4 CRC
  }
  return false;
}

/**
 * WebP 是不是动画。
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function webpIsAnimated(buf) {
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    // 第 20 字节是 flag 位：bit1 = animation
    return (buf[20] & 0x02) !== 0;
  }
  // 兜底：直接找 ANIM 块（有些封装把 VP8X 放在别处）
  return buf.includes(Buffer.from('ANIM', 'ascii'));
}

/**
 * 从 URL 的路径后缀猜 mime（只在魔数判定失败后作为兜底提示）。
 *
 * @param {unknown} url
 * @param {string} [fallback]
 * @returns {string}
 */export function mimeFromUrl(url, fallback = '') {
  try {
    const pathname = new URL(String(url)).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  } catch {
    // 不是合法 URL 就没什么可猜的
  }
  return fallback;
}

/**
 * 从"可能是 base64 的东西"里取出 base64 正文。
 *
 * 三种真实存在过的形状：`base64://<b64>`（OneBot 标准）、
 * `data:image/png;base64,<b64>`（段里直接内联）、以及裸 base64。
 * 裸 base64 的判定刻意保守：只有整串都是 base64 字符（允许空白）才接受，
 * 否则 `{"status":"failed"}` 这种 JSON 也会被当成 base64 解出垃圾。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function base64FromMaybe(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
  if (s.startsWith('data:')) {
    const idx = s.indexOf(',');
    return idx >= 0 ? s.slice(idx + 1).replace(/\s/g, '') : null;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
  return null;
}

/**
 * base64 编码长度 → 解码后字节数（含 padding 修正）。
 *
 * ## 为什么要有这个函数，而不是直接解
 *
 * `Buffer.from(hugeString, 'base64')` 会**先**分配出解码后的全部内存。
 * 一个 200MB 的字符串就是一次 150MB 的分配 —— 在检查字节上限之前就发生了。
 * 所以先按长度估算，超限的字符串根本不进解码器。
 *
 * @param {string} b64
 * @returns {number}
 */
export function decodedByteLength(b64) {
  if (typeof b64 !== 'string' || !b64) return 0;
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/* ------------------------------------------------------------------ 各格式 */

/** PNG：IHDR 固定在第 16/20 字节（前面是 8 字节签名 + 4 长度 + 4 类型） */
function pngDimensions(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF：逻辑屏幕宽高，小端 16 位 */
function gifDimensions(buf) {
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * JPEG：扫描到 SOF 段取宽高。
 *
 * 需要跳过的坑（都踩过）：
 *   - 填充字节 `FF FF FF...`（marker 前允许任意个 0xFF）；
 *   - 无长度的 marker（D8/D9/RSTn 只有两字节）；
 *   - `C4`(DHT) / `C8`(JPG) / `CC`(DAC) 落在 C0–CF 区间里，但它们不是 SOF。
 *
 * 段长 `len` 包含自身两字节，所以每次前进 `2 + len` 而不是 `len`。
 */
function jpegDimensions(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // 填充 0xFF 与无载荷 marker
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOF 载荷：精度(1) 高度(2) 宽度(2)
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + len;
  }
  return null;
}

/**
 * WebP：三种容器写法（VP8X / VP8L / VP8 ）。
 *
 * 只解 VP8（有损）或 VP8X（扩展）会漏掉无损图：VP8L 的宽高是
 * 14 位 + 4 位**位域**打包的，不按位解就永远是错的，而错的值不会报错 ——
 * 只会让像素上限形同虚设。所以三种都解。
 */
function webpDimensions(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);

  if (fourcc === 'VP8X') {
    // 24 位小端，存的是「宽-1 / 高-1」
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }

  if (fourcc === 'VP8L') {
    if (buf.length < 25) return null;
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }

  if (fourcc === 'VP8 ') {
    // 关键帧起始码 0x9d 0x01 0x2a 必须存在，否则这不是关键帧，宽高无意义
    if (!(buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  return null;
}
