/**
 * 原子写 —— 不变量 I5
 *
 * 所有状态写一律「临时文件 + rename」；读时吃掉 UTF-8 BOM，写回保留原 BOM。
 * 否则改一个字段会让整个文件在 git / 编辑器里显示为全量重写。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const BOM = '\uFEFF';

/**
 * 读文本，吃掉 BOM，并告知原本有没有 BOM。
 *
 * @param {string} filePath
 * @returns {Promise<{text: string, hadBom: boolean} | null>} 文件不存在返回 null
 */
export async function readText(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const hadBom = raw.charCodeAt(0) === 0xfeff;
    return { text: hadBom ? raw.slice(1) : raw, hadBom };
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 原子写文本。
 *
 * @param {string} filePath
 * @param {string} text
 * @param {{bom?: boolean}} [opts]
 */
export async function writeTextAtomic(filePath, text, opts = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload = opts.bom ? BOM + text : text;
  await fs.writeFile(tmp, payload, 'utf8');
  await renameWithRetry(tmp, filePath);
}

/**
 * Windows 上 rename 可能因杀软/句柄占用短暂 EPERM，退避重试几次。
 *
 * @param {string} from
 * @param {string} to
 * @param {number} [attempts]
 */
async function renameWithRetry(from, to, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = /** @type {any} */ (err)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  try {
    await fs.unlink(from);
  } catch {
    /* 清理失败不影响主流程 */
  }
  throw lastErr;
}

/**
 * 原子写 JSON（保留原 BOM）。
 *
 * @param {string} filePath
 * @param {any} value
 */
export async function writeJsonAtomic(filePath, value) {
  const existing = await readText(filePath);
  await writeTextAtomic(filePath, JSON.stringify(value, null, 2) + '\n', {
    bom: existing?.hadBom ?? false,
  });
}

/**
 * 读 JSON。
 *
 * @param {string} filePath
 * @returns {Promise<any | null>}
 */
export async function readJson(filePath) {
  const res = await readText(filePath);
  if (!res) return null;
  try {
    return JSON.parse(res.text);
  } catch (err) {
    throw Object.assign(new Error(`JSON 解析失败：${filePath}`), { code: 'E40XX', cause: err });
  }
}
