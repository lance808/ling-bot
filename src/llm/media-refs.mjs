/**
 * 媒体引用元数据 —— 视觉链路的第一段（契约 §2）
 *
 * ## 这一层只做一件事：把 OneBot 段变成**可信的元数据**
 *
 * 不读磁盘、不发请求、不碰 base64 字节。两个理由：
 *
 *   1. 这段代码在**每条消息**上都会跑（包括视觉关闭的时候）。任何 IO 都会
 *      变成消息吞吐的瓶颈，而它本来只需要几十微秒；
 *   2. 这些元数据最终会进 `sessions.json`。一旦这一层能读盘/联网，
 *      "写进会话文件的东西"就再也说不清是从哪来的了。
 *
 * ## 为什么未知字段一律丢弃，而不是原样透传
 *
 * 上游网关、中转、各种 OneBot 实现都会往段里塞私有字段。透传等于让
 * **外部**决定我们落盘的 JSON 长什么样 —— 哪天某个字段恰好叫 `path`，
 * 本机路径就跟着消息一起进文件了。所以这里只挑白名单字段，其余在门口扔掉。
 *
 * ## 为什么 URL 单独拎出来说一句
 *
 * 段里的 `url` 通常带**临时鉴权参数**（`?term=2&key=...`），它是一次性的、
 * 有时效的、换个人就能用的东西。所以它只活在内存里（见 `stripSecretsFromUrl`），
 * 永远不落盘；重启后 URL 丢了是**预期行为**，取图退回 `get_image`。
 */

/** 本链路只认这四种图（与契约 §3 的 E3105 同一份口径） */
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * 安全缓存名的字面规则。
 *
 * 只允许字母数字下划线、点、加号、等号、@、连字符 —— 这些是
 * SnowLuma / NapCat / LLOneBot 实际用到的字符集（哈希名、`xxx.image`、
 * 偶见的 `name@2x.png`）。**故意**不含 `/`、`\`、`:`，
 * 这样路径、盘符、协议前缀在字符层面就不可能通过。
 */
const CACHE_NAME_RE = /^[\w.+=@-]{1,512}$/;

/** `extractImageRefs` 未显式给 max 时的默认张数（够一次批量消息用） */
const DEFAULT_MAX_REFS = 8;

/** 单次解析的硬顶：再多的段也不会给自己找麻烦 */
const MAX_REFS_HARD = 64;

/** 文件名后缀 → mime。只用于"已知"，最终以魔数为准（image-bytes.mjs 会复核） */
const EXT_MIME = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

/**
 * @typedef {object} MediaRef
 * @property {'image'} kind          // 本轮只处理 image；face/record 等不进视觉链路
 * @property {string} file           // OneBot 段的 file 字段（已确认是安全缓存名，否则为空）
 * @property {string} url            // 临时鉴权 URL（**只存内存**，见契约 §5）
 * @property {string} mime           // 已知或嗅探出的 image/png|jpeg|gif|webp，未知为 ''
 * @property {number} bytes          // 已知字节数，未知为 0
 * @property {number} width          // 已知宽度，未知为 0
 * @property {number} height         // 已知高度，未知为 0
 * @property {string} name           // 展示名（basename，仅用于提示文本）
 * @property {string} [inline]       // 段里直接带来的 base64 体或 data URL（**内存字段，不落盘**）
 * @property {string} [localPath]    // 段里直接带来的本机绝对路径（**内存字段，不落盘**）
 */

/**
 * 判断一个字符串能不能当成 OneBot 缓存文件名交给网关。
 *
 * ## 为什么必须在这里挡，而不是交给网关
 *
 * `get_image` 的参数会被网关当成"去哪个文件取图"。如果它能是
 * `../../config.json` 或 `http://127.0.0.1:3458/x`，那么一条群消息
 * 就能让网关读本机任意文件、或者替我们打内网端口 —— 而这条链路的
 * 起点是**任何群里任何人**都能发的图片段。
 *
 * 所以规则很窄：无路径分隔符、无盘符、无协议前缀、无 `..`、无控制字符。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isProbablySafeCacheName(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s || s.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (s.includes('..')) return false;
  // 显式再挡一遍：字符集规则已经覆盖，但这两条是"读起来就知道在防什么"
  if (s.includes('/') || s.includes('\\') || s.includes(':')) return false;
  return CACHE_NAME_RE.test(s);
}

/**
 * 这个 URL 是否可以作为**持久化依据**。
 *
 * 恒为 false —— 这不是"保守实现"，是结论：
 *
 * QQ 图片 URL 普遍形如 `https://gchat.qpic.cn/gchatpic_new/...?term=2&is_origin=1`，
 * 鉴权参数和路径混在一起，任何"清理参数"的规则都会在某次上游改版后失效。
 * 清理失败的代价是把一张私有图片的长期入口写进明文会话文件。
 * 所以这里不做任何启发式，直接判定"不可持久化"。
 *
 * @param {unknown} _url
 * @returns {false}
 */
export function stripSecretsFromUrl(_url) {
  return false;
}

/**
 * 从 OneBot 消息段里提取图片引用（纯函数）。
 *
 * @param {Array<object>} segments
 * @param {{max?: number}} [opts] max = 最多返回几张（默认 8，硬顶 64）
 * @returns {MediaRef[]}
 */
export function extractImageRefs(segments, opts = {}) {
  const max = clampInt(opts?.max, DEFAULT_MAX_REFS, 0, MAX_REFS_HARD);
  if (!Array.isArray(segments) || max <= 0) return [];

  /** @type {MediaRef[]} */
  const out = [];
  for (const seg of segments) {
    if (out.length >= max) break;
    // face / record / video / mface 等一律不进视觉链路：它们要么没有字节，
    // 要么语义完全不同（表情 id、语音编码），混进来只会污染预算。
    if (!seg || seg.type !== 'image') continue;
    out.push(refFromSegmentData(seg.data, out.length + 1));
  }
  return out;
}

/**
 * 把持久化的媒体元数据归一化回 MediaRef。
 *
 * ## "永不抛"是硬要求
 *
 * 它的输入是**磁盘上的历史数据**：可能是旧版本写的、可能被手工编辑过、
 * 可能是半截写入的。一条脏记录不该让整个会话加载失败。
 *
 * ## 为什么没有 file 的项直接丢掉
 *
 * 持久层不保存 URL（契约 §5），所以一条没有 `file` 的记录重启后
 * **永远取不到字节**。留着它只会让每个回合都产生一条 E3101 噪音，
 * 让"取图失败"的统计永远不为零 —— 那比丢掉更难排查。
 *
 * @param {unknown} list
 * @returns {MediaRef[]}
 */
export function mediaRefsFromStored(list) {
  if (!Array.isArray(list)) return [];
  /** @type {MediaRef[]} */
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind !== undefined && item.kind !== 'image') continue;
    const file = isProbablySafeCacheName(item.file) ? String(item.file).trim() : '';
    if (!file) continue;
    const mime = ALLOWED_MIMES.has(item.mime) ? String(item.mime) : '';
    out.push({
      kind: 'image',
      file,
      // 落盘的 URL 一律不采信：即使旧版本真的写进去了，也当它不存在
      url: '',
      mime,
      bytes: clampInt(item.bytes, 0, 0, Number.MAX_SAFE_INTEGER),
      width: clampInt(item.width, 0, 0, 100_000),
      height: clampInt(item.height, 0, 0, 100_000),
      name: safeDisplayName(item.name),
    });
  }
  return out;
}

/**
 * 把一张 MediaRef 投影成**允许落盘**的形状（契约 §5）。
 *
 * 持久层只允许 `{kind, file, mime, bytes, width, height, name}`。
 * `url` / `inline` / `localPath` 都留在内存里：
 *
 *   - URL 带临时鉴权参数（见 `stripSecretsFromUrl`）；
 *   - inline 是 base64，会把 `sessions.json` 撑成几 MB；
 *   - localPath 是本机信息，写进会话文件等于泄露目录结构。
 *
 * 这里**逐字段挑**而不是 `{...ref}` 再删几个键：后者在将来有人往
 * MediaRef 上加字段时会静默泄露，而白名单写法不会。
 *
 * 没有 `file` 的项返回 null —— 它重启后必然取不到，不该占一个位置。
 *
 * @param {any} ref
 * @returns {{kind: 'image', file: string, mime: string, bytes: number,
 *   width: number, height: number, name: string} | null}
 */
export function pickPersistedRef(ref) {
  const one = mediaRefsFromStored([ref])[0];
  if (!one) return null;
  return {
    kind: 'image',
    file: one.file,
    mime: one.mime,
    bytes: one.bytes,
    width: one.width,
    height: one.height,
    name: one.name,
  };
}

/* ------------------------------------------------------------------ 内部 */

/**
 * 单个 image 段 → MediaRef。
 *
 * 字段来源只有三个：`file`、`url`、`file_size`（外加可选的 `width`/`height`）。
 * 其余一律不看。
 *
 * @param {any} data
 * @param {number} index 1 基（仅用于兜底展示名）
 * @returns {MediaRef}
 */
function refFromSegmentData(data, index) {
  const rawFile = typeof data?.file === 'string' ? data.file.trim() : '';
  const rawUrl = typeof data?.url === 'string' ? data.url.trim() : '';

  let file = '';
  let url = '';
  let inline = '';
  let localPath = '';

  // file 字段在不同实现里可能是三种完全不同的东西：
  // 缓存文件名（绝大多数）、`base64://...`（网关已内联）、或本机绝对路径（部分实现）。
  // 必须按内容分流，而不是按字段名假设 —— 这是本模块最容易被写错的一处。
  if (rawFile) {
    if (rawFile.startsWith('base64://')) {
      inline = rawFile.slice('base64://'.length);
    } else if (/^data:/i.test(rawFile)) {
      inline = rawFile;
    } else if (/^https?:\/\//i.test(rawFile)) {
      url = rawFile;
    } else if (isProbablySafeCacheName(rawFile)) {
      file = rawFile;
    } else if (looksLikeLocalPath(rawFile)) {
      localPath = rawFile;
    }
  }

  if (!url && rawUrl) {
    if (/^https?:\/\//i.test(rawUrl)) url = rawUrl;
    else if (rawUrl.startsWith('base64://')) inline ||= rawUrl.slice('base64://'.length);
    else if (/^data:/i.test(rawUrl)) inline ||= rawUrl;
    // 非 http(s) 的 url（ws:、file:、javascript:）故意丢掉：它们不是取图来源
  }

  const name = displayNameOf({ file, url, localPath }, index);
  const bytes = clampInt(data?.file_size ?? data?.fileSize, 0, 0, Number.MAX_SAFE_INTEGER);
  const width = clampInt(data?.width, 0, 0, 100_000);
  const height = clampInt(data?.height, 0, 0, 100_000);

  /** @type {MediaRef} */
  const ref = {
    kind: 'image',
    file,
    url,
    mime: mimeFromName(name),
    bytes,
    width,
    height,
    name,
  };
  // 这两个只在内存里有意义，不进持久层（见 pickPersistedRef）
  if (inline) ref.inline = inline;
  if (localPath) ref.localPath = localPath;
  return ref;
}

/** 展示名：只用于提示文本，所以取不到就退回「图片N」，绝不抛 */
function displayNameOf({ file, url, localPath }, index) {
  let candidate = file || '';
  if (!candidate && url) {
    try {
      candidate = new URL(url).pathname.split('/').pop() ?? '';
    } catch {
      candidate = '';
    }
  }
  if (!candidate && localPath) candidate = localPath.split(/[\\/]/).pop() ?? '';
  const cleaned = safeDisplayName(candidate);
  return cleaned || `图片${index}`;
}

/** 展示名清洗：去控制字符、去路径、截断。任何脏输入都退化成空串 */
function safeDisplayName(value) {
  if (typeof value !== 'string') return '';
  const base = value.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, 120);
}

/** 后缀猜 mime（只是"已知"，最终以魔数为准） */
function mimeFromName(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name ?? ''));
  if (!m) return '';
  return EXT_MIME.get(m[1].toLowerCase()) ?? '';
}

/**
 * 看起来像不像一个**路径**（绝对、相对、盘符、UNC）。
 *
 * 认出它是路径 ≠ 允许读它。这里只负责"把它归到本地来源那一类"，
 * 真正的放行判定在 image-fetch.mjs（realpath + snowlumaDir 包含 + 普通文件），
 * 那里的结论是 E3108。
 *
 * 为什么要认相对路径：`../../config.json` 不是安全缓存名（含 `..` 与 `/`），
 * 如果在这里直接丢掉，错误会退化成 E3101「没有来源」——
 * 而实际情况是"有人在试路径穿越"，两者在日志里的处置完全不同。
 */
function looksLikeLocalPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true; // C:\... / C:/...
  if (value.startsWith('\\\\')) return true; // UNC
  if (value.startsWith('/')) return true; // POSIX 绝对
  if (value.startsWith('./') || value.startsWith('../')) return true; // 相对
  if (value.startsWith('.\\') || value.startsWith('..\\')) return true;
  // 含分隔符但没通过缓存名校验的，也按路径处理（例如 `a/b.png`）
  return value.includes('/') || value.includes('\\');
}

/**
 * 夹取整数。
 *
 * `null` / `''` / `undefined` 必须走 fallback，而不是被 `Number()` 变成 0 ——
 * 否则"没填"会被悄悄当成"填了 0"，而 0 在这里往往是个有效且危险的值。
 */
function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
