/**
 * 表情库的存储层 —— 唯一碰磁盘的地方
 *
 * ## 这个文件承担的三件事，以及为什么它们必须都在这里
 *
 * 1. **`library.json` 的读写**：整个账号一份、跨会话共享。
 * 2. **损坏检测**：读不动 / 解析失败 / 顶层形状不对 → `StorageCorrupt`，
 *    **绝不**降级成空库。
 * 3. **`faces/` 缓存回收**：条目被同步删除时删掉它独占的文件，`init` 时清孤儿。
 *
 * 把 IO 压在一个文件里，好处不是"看起来干净"，而是"哪些操作会碰用户数据"
 * 变成一件可以直接读出来的事。别的模块（model / policy）因此可以做到零 IO，
 * 于是它们的单测不需要造临时目录、也不需要 mock 磁盘异常。
 *
 * ## 为什么损坏必须抛出而不是返回空库
 *
 * 这是本文件最重要的设计决定。把"解析失败"当成"没有收藏"，下一次写盘就会用
 * 一份只含本次新条目的数据覆盖掉 AI 攒了几个月的 `localNote` / `tags` / `useCount` ——
 * 用户看到的界面一切正常，只是所有认知在一夜之间归零。
 *
 * 所以读失败一律抛 `StorageCorrupt`，调用方据此降级成**只读**：
 * 所有写工具返回 `E_STICKER_STORE_READONLY`，一个字都不回写。
 * 唯一的例外是"文件不存在"—— 那是首次使用的正常状态，返回空库。
 *
 * ## 为什么缓存文件只删两种，不做按时间淘汰
 *
 * 删掉一个可能还在用的缓存，下一次发送就会失败一次；而"表情发不出去"这个现象
 * 比"多占了一点磁盘"难解释得多。所以只删**确定没人引用**的文件：
 * 同步确认删掉的条目独占的缓存，以及 `init` 时发现的孤儿（上次崩溃留下的半成品）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { SCHEMA_VERSION, normalizeEntries } from './model.mjs';

/** 库文件名（与 docs/stickers-contract.md §4 一致） */
const LIBRARY_FILE = 'library.json';

/** 表情图片缓存目录（由宿主的受控取图链路写入，本插件只读） */
const FACES_DIR = 'faces';

/**
 * 库文件损坏 / 读失败。
 *
 * 单独一个类而不是 `Error('...')`：调用方需要把"存储坏了，我拒绝写"
 * 与"业务校验没过"分开。前者绝不能被当成"空库可以覆盖"。
 *
 * `code` 用 `E_STICKER_STORE_READONLY` 而不是再造一个 `..._CORRUPT`：
 * 契约 §9 的错误码表里只有前者，模型/用户看到的就是"库坏了，已降级只读"。
 */
export class StorageCorrupt extends Error {
  /**
   * @param {string} message
   * @param {{file?: string, cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'StorageCorrupt';
    this.code = 'E_STICKER_STORE_READONLY';
    this.file = opts.file ?? '';
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * 一份空库。
 *
 * `syncOnInit` / `syncedAt` 这些顶层字段即使还没有值也写出来：读取方
 * （包括界面与排查时看文件的人）不该靠"这个键存不存在"推断状态。
 *
 * @param {{account?: string}} [opts]
 * @returns {object}
 */
export function emptyDoc(opts = {}) {
  return {
    version: SCHEMA_VERSION,
    account: String(opts?.account ?? ''),
    syncedAt: 0,
    lastSyncComplete: false,
    lastError: null,
    entries: [],
  };
}

/**
 * 去掉 UTF-8 BOM。
 *
 * 用户很可能用记事本手改过这个文件，而记事本默认加 BOM、`JSON.parse` 遇到它
 * 直接失败。那不是数据坏了，不该被判成损坏。
 *
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 校验整份文档的形状。
 *
 * 单条脏记录**不**在这里报错：`entries` 里那一条由 `normalizeEntries` 丢弃，
 * 其余照常加载（契约 §4.1）。这里只管"整份文件还能不能读"。
 *
 * @param {unknown} doc
 * @param {string} file
 * @returns {object}
 * @throws {StorageCorrupt}
 */
function validateDocShape(doc, file) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new StorageCorrupt(`表情库顶层必须是对象（${file}），已停止写入以免覆盖已有收藏`, { file });
  }
  const d = /** @type {any} */ (doc);

  /*
   * 版本检查只拦"来自更新版本的文件"。
   *
   * 缺失 version 是旧库（早期手写/别的工具写的），按当前版本读没问题；
   * 但 version **大于**当前版本说明这份文件是更新的插件写的，里面的字段
   * 我们可能不认识 —— 此时按旧格式读会丢字段，再写回去就是数据丢失。
   */
  const version = d.version === undefined || d.version === null ? SCHEMA_VERSION : Number(d.version);
  if (!Number.isFinite(version) || version < 0) {
    throw new StorageCorrupt(`表情库的 version 字段非法（${String(d.version)}），已停止写入`, { file });
  }
  if (version > SCHEMA_VERSION) {
    throw new StorageCorrupt(
      `表情库是更新版本（v${version}）写的，当前插件只认到 v${SCHEMA_VERSION}。为避免丢字段，已停止写入；请升级插件或先备份该文件。`,
      { file },
    );
  }

  if (!Array.isArray(d.entries)) {
    throw new StorageCorrupt(`表情库的 entries 必须是数组（${file}），已停止写入以免覆盖已有收藏`, { file });
  }

  return {
    version: SCHEMA_VERSION,
    account: String(d.account ?? ''),
    syncedAt: Math.max(0, Number(d.syncedAt) || 0),
    lastSyncComplete: d.lastSyncComplete === true,
    lastError:
      d.lastError && typeof d.lastError === 'object'
        ? {
            code: String(d.lastError.code ?? ''),
            message: String(d.lastError.message ?? ''),
            at: Math.max(0, Number(d.lastError.at) || 0),
          }
        : null,
    entries: normalizeEntries(d.entries),
  };
}

/**
 * 深拷贝（结构化克隆）。
 *
 * 用 `structuredClone` 而不是 JSON 往返：后者会把 `undefined` 键悄悄删掉，
 * 而"这个键存在但值不对"恰恰是要能看见的信息。
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return /** @type {T} */ (structuredClone(value));
}

/**
 * 表情库存储。
 *
 * 一个实例对应一个 dataDir。所有写路径都过同一条串行链 —— 表情库是账号级
 * 单文件，并发写会让"后写的整份覆盖前一份"，表现为收了一张丢一张。
 */
export class StickerStore {
  /**
   * @param {{dataDir: string, log?: (level: string, message: string, fields?: object) => void}} opts
   */
  constructor(opts) {
    this.dataDir = String(opts?.dataDir ?? '');
    this.log = opts?.log ?? (() => {});
    /**
     * 串行链尾。
     *
     * 只用一个全局链而不是按文件分：这个库里只有一个数据文件，
     * 分键只会多一层没有作用的间接。
     *
     * @type {Promise<any>}
     */
    this.chain = Promise.resolve();
  }

  /** @returns {string} */
  file() {
    return path.join(this.dataDir, LIBRARY_FILE);
  }

  /** @returns {string} */
  facesDir() {
    return path.join(this.dataDir, FACES_DIR);
  }

  /**
   * 在串行链上排一次任务。
   *
   * 链尾只关心"跑完了"，不关心成败：一次失败不能把后面所有写操作一起拖垮，
   * 否则一次坏输入会让这个账号此后永远存不进东西。
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 读整份库。
   *
   * 文件不存在（ENOENT）是**唯一**允许当成"空库"的情况 —— 那是首次使用。
   * 其余任何失败（EACCES / EBUSY / 解析失败 / 形状不对）都抛 `StorageCorrupt`。
   *
   * @returns {Promise<object>}
   */
  async load() {
    const file = this.file();
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code === 'ENOENT') return emptyDoc();
      throw new StorageCorrupt(`表情库读取失败（${String(/** @type {any} */ (error)?.message ?? error)}）`, {
        file,
        cause: error,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(stripBom(text));
    } catch (error) {
      throw new StorageCorrupt(
        `表情库不是合法 JSON（${file}）。为避免把已有收藏覆盖成空库，已停止写入；请先备份该文件或修复它。`,
        { file, cause: error },
      );
    }
    return validateDocShape(parsed, file);
  }

  /**
   * 原子写整份库：tmp → fsync → rename。
   *
   * 为什么不能只 rename：断电时元数据可能先落盘、数据块没落，rename 之后
   * 拿到的是一个空文件。先 fsync 再 rename，"要么旧内容、要么新内容"才成立。
   *
   * @param {object} doc
   * @returns {Promise<void>}
   */
  async save(doc) {
    const file = this.file();
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });

    const tmp = path.join(dir, `.${LIBRARY_FILE}.${crypto.randomUUID()}.tmp`);
    const payload = `${JSON.stringify(doc, null, 2)}\n`;

    let fh;
    try {
      fh = await fs.open(tmp, 'w');
      await fh.writeFile(payload, 'utf8');
      await fh.sync();
    } finally {
      await fh?.close();
    }

    try {
      await renameWithRetry(tmp, file);
    } catch (error) {
      // rename 彻底失败：清掉临时文件。留着的话，下次排查"库为什么没更新"时
      // 那个带随机串的 .tmp 会被误认为一次成功写入。
      try {
        await fs.unlink(tmp);
      } catch {
        /* 清不掉也只是多一个点开头的临时文件 */
      }
      throw error;
    }
  }

  /**
   * 读-改-写（串行）。
   *
   * `mutate` 收到当前文档的深拷贝，返回新文档；抛错则整体中止、**不写盘**。
   * 这样调用方的校验失败不会留下半写状态。
   *
   * @param {(doc: any) => any} mutate
   * @returns {Promise<object>} 写下去的文档
   */
  async update(mutate) {
    return this.#serial(async () => {
      const current = await this.load();
      const draft = clone(current);
      const next = mutate(draft);
      const normalized = validateDocShape(next, this.file());
      await this.save(normalized);
      return normalized;
    });
  }

  /**
   * 列出 `faces/` 下已有的文件（只给缓存回收用）。
   *
   * @returns {Promise<string[]>} 文件名（不含目录）
   */
  async listFaceFiles() {
    try {
      const ents = await fs.readdir(this.facesDir(), { withFileTypes: true });
      return ents.filter((e) => e.isFile()).map((e) => e.name);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
      // 列目录失败不该让 init 失败：回收是"尽力而为"的维护动作
      this.log('warn', '表情缓存目录无法读取，跳过回收', {
        message: String(/** @type {any} */ (error)?.message ?? error),
      });
      return [];
    }
  }

  /**
   * 删除指定缓存文件。
   *
   * @param {string[]} files 形如 `faces/<name>`
   * @returns {Promise<number>} 实际删掉几个
   */
  async removeFiles(files) {
    const base = path.resolve(this.facesDir());
    let removed = 0;
    for (const rel of Array.isArray(files) ? files : []) {
      const name = path.basename(String(rel ?? ''));
      if (!name || name === '.' || name === '..') continue;
      const abs = path.resolve(base, name);
      /*
       * 只允许删 faces/ 目录下的直接子文件。
       *
       * 库里的 `file` 是"可以被手改的文本"，而这里真的会 unlink —— 所以
       * 判据是**解析后的绝对路径**在 faces/ 内，不是字符串前缀匹配。
       */
      if (path.dirname(abs) !== base) continue;
      try {
        await fs.unlink(abs);
        removed++;
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (code !== 'ENOENT') {
          this.log('warn', '表情缓存文件删除失败', { file: name, message: String(/** @type {any} */ (error)?.message ?? error) });
        }
      }
    }
    return removed;
  }

  /**
   * 清理没有任何条目引用的孤儿缓存文件（`init` 时调用）。
   *
   * 孤儿从哪来：上次取图成功、写库之前进程被杀；或者条目被同步删掉后
   * 删除文件那一步失败。它们永远不会再被引用，留着只是占盘。
   *
   * @param {any[]} entries
   * @returns {Promise<{removed: number, kept: number}>}
   */
  async pruneOrphans(entries) {
    const names = await this.listFaceFiles();
    if (names.length === 0) return { removed: 0, kept: 0 };
    /** @type {Set<string>} */
    const used = new Set();
    for (const e of Array.isArray(entries) ? entries : []) {
      const f = String(e?.file ?? '');
      if (f) used.add(path.basename(f));
    }
    /** @type {string[]} */
    const orphans = [];
    for (const name of names) {
      if (!used.has(name)) orphans.push(`${FACES_DIR}/${name}`);
    }
    // 上限是刻意的：首次清理一个很大的目录时，一次删掉几千个文件会让
    // init 变慢到宿主误判"初始化超时"。剩下的下次 init 继续清。
    const removed = await this.removeFiles(orphans.slice(0, 200));
    if (removed > 0) this.log('info', `已清理 ${removed} 个无人引用的表情缓存文件`);
    return { removed, kept: used.size };
  }

  /**
   * 目录与库文件的基本统计（只读，自检用）。
   *
   * @returns {Promise<{ok: boolean, file: string, bytes: number, exists: boolean, faces: number, corrupt: boolean, message: string}>}
   */
  async stat() {
    const file = this.file();
    let exists = false;
    let bytes = 0;
    try {
      const st = await fs.stat(file);
      exists = st.isFile();
      bytes = st.size;
    } catch {
      /* 不存在就是首次使用 */
    }
    let corrupt = false;
    /** @type {string} */
    let message = '';
    if (exists) {
      try {
        await this.load();
      } catch (error) {
        corrupt = true;
        message = String(/** @type {any} */ (error)?.message ?? error);
      }
    }
    const faces = (await this.listFaceFiles()).length;
    return { ok: !corrupt, file, bytes, exists, faces, corrupt, message };
  }
}

/**
 * rename 重试。
 *
 * Windows 上杀软/索引器会短暂持有目标文件，rename 于是报 EPERM/EBUSY。
 * 这类错误几乎总在几十毫秒内消失，直接失败会让用户看到"偶尔存不上"。
 *
 * @param {string} from
 * @param {string} to
 * @param {number} [attempts]
 * @returns {Promise<void>}
 */
async function renameWithRetry(from, to, attempts = 5) {
  /** @type {any} */
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastErr = error;
      const code = /** @type {any} */ (error)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await new Promise((r) => setTimeout(r, 30 * (i + 1)));
    }
  }
  throw lastErr;
}
