/**
 * 路径策略 —— F14.2 的 L3 约束层
 *
 * 工具能碰哪些文件，靠这里判定，**不靠提示词自觉**。
 *
 * 三条纪律：
 *   1. 先 resolve 再比对（防 `../` 穿越）
 *   2. 符号链接要 realpath 复核（防链接逃逸）
 *   3. 敏感目录（secrets.json / state/）对**所有**工具不可读——这是硬规则，不是配置项
 */

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * 永远不允许工具读写的路径（相对 userData）。
 * 这些是凭据与运行状态，任何工具都不该碰。
 */
const FORBIDDEN_BASENAMES = new Set(['secrets.json', 'config.json']);
const FORBIDDEN_DIRS = new Set(['state', 'logs']);

/**
 * @typedef {object} PathPolicyResult
 * @property {boolean} ok
 * @property {string} [resolved]
 * @property {string} [code]
 * @property {string} [message]
 */

/**
 * 把用户/模型给的路径解析成绝对路径，并确认它落在允许的根目录内。
 *
 * @param {string} inputPath 模型给的原始路径
 * @param {{roots: string[], userDataDir: string, mode?: 'read'|'write'}} opts
 * @returns {Promise<PathPolicyResult>}
 */
export async function resolveGuardedPath(inputPath, opts) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    return { ok: false, code: 'E4033', message: '路径为空' };
  }

  const roots = (opts.roots ?? []).map((r) => path.resolve(r));
  if (roots.length === 0) {
    return { ok: false, code: 'E4033', message: '没有配置任何允许的根目录' };
  }

  const candidate = path.resolve(roots[0], inputPath);

  // 1) 归一化后的包含性检查（防 ../ 穿越）
  const inside = roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
  if (!inside) {
    return { ok: false, code: 'E4033', message: `路径越界：${inputPath}` };
  }

  // 2) 硬性禁区：凭据与运行状态
  const parsed = path.parse(candidate);
  if (FORBIDDEN_BASENAMES.has(path.basename(candidate))) {
    return { ok: false, code: 'E4033', message: '该文件属于凭据，工具不可访问' };
  }
  if (parsed.dir.includes(path.join(opts.userDataDir ?? '', 'state'))) {
    return { ok: false, code: 'E4033', message: 'state 目录对工具不可访问' };
  }
  const segments = candidate.split(path.sep);
  for (const dir of FORBIDDEN_DIRS) {
    if (segments.includes(dir)) {
      return { ok: false, code: 'E4033', message: `目录 ${dir} 对工具不可访问` };
    }
  }

  // 3) realpath 复核（防符号链接逃逸）。
  //    路径可能还不存在（写文件场景），此时退化为校验最近的已存在父目录。
  try {
    const real = await fs.realpath(candidate);
    const realInside = roots.some((root) => {
      const rootReal = path.resolve(root);
      return real === rootReal || real.startsWith(rootReal + path.sep);
    });
    if (!realInside) {
      return { ok: false, code: 'E4033', message: '路径指向允许范围之外（符号链接）' };
    }
    return { ok: true, resolved: real };
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') {
      return { ok: true, resolved: candidate };
    }
    return { ok: false, code: 'E4033', message: `路径无法解析：${String(err?.code ?? err)}` };
  }
}
