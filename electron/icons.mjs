/**
 * 图标路径解析（纯逻辑，不 import electron）
 *
 * 单独拆出来是为了两件事：
 *   1. 这段规则能被单元测试覆盖 —— main.mjs 是主进程入口，import 它会直接
 *      启动整个应用；把"该用哪个图标文件"的判定抽出来后，测试可以只验证规则。
 *   2. 主进程和后端用同一套根目录规则，避免出现两套会漂移的路径计算。
 *
 * 真正的"这张图能不能读出来"由调用方（main.mjs）用 nativeImage 再验一层；
 * 这里只负责文件系统层面能判断的部分。
 */

import fs from 'node:fs';
import path from 'node:path';

/** PNG 文件头魔数 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 支持的图标种类：窗口 / 托盘 */
export const ICON_KINDS = Object.freeze(['app', 'tray']);

/** 各图标的目标尺寸（用户上传的图会等比缩到这个尺寸再落盘） */
export const ICON_SIZES = Object.freeze({ app: 256, tray: 32 });

/**
 * 内置图标的路径。
 *
 * @param {string} assetsDir `<仓库根>/assets` 的绝对路径
 * @returns {{app: string, tray: string}}
 */
export function builtinIconPaths(assetsDir) {
  return {
    app: path.join(assetsDir, 'icon.png'),
    tray: path.join(assetsDir, 'tray.png'),
  };
}

/**
 * 用户自定义图标的存放目录。
 *
 * 放在 <数据根目录>/icons/ 下，而不是程序目录：
 *   · 自定义图标属于**用户数据**；
 *   · 程序升级 / 换安装目录不能把它弄丢。
 *
 * @param {string} userDataRoot 数据根目录（由 resolvePaths().root 提供）
 * @returns {string}
 */
export function customIconDir(userDataRoot) {
  return path.join(userDataRoot, 'icons');
}

/**
 * 用户自定义图标的目标路径。
 *
 * @param {string} userDataRoot
 * @param {'app' | 'tray'} kind
 * @returns {string}
 */
export function customIconPath(userDataRoot, kind) {
  return path.join(customIconDir(userDataRoot), `${kind}.png`);
}

/**
 * 判断文件是否"看起来"是一个 PNG（存在、够长、魔数对得上）。
 *
 * 这是第一道轻量校验，能在纯 Node 下跑；它挡不住"魔法数对但内容损坏"，
 * 那一层交给调用方的 nativeImage.isEmpty()。
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function looksLikePngFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < PNG_SIGNATURE.length) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(PNG_SIGNATURE.length);
      fs.readSync(fd, head, 0, head.length, 0);
      return head.equals(PNG_SIGNATURE);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 解析当前该用哪个图标：用户自定义 > 内置默认。
 *
 * @param {object} opts
 * @param {string} opts.customPath 用户自定义图标的绝对路径
 * @param {string} opts.builtinPath 内置默认图标的绝对路径
 * @param {(filePath: string) => boolean} [opts.isUsable] 额外校验（主进程会传 nativeImage 版本）
 * @returns {string} 应该使用的图标绝对路径
 */
export function pickIconPath({ customPath, builtinPath, isUsable }) {
  const usable = isUsable ?? looksLikePngFile;
  try {
    if (usable(customPath)) return customPath;
  } catch {
    // 校验本身出错也要回落到内置图标，绝不能让图标缺失导致启动失败
  }
  return builtinPath;
}

/**
 * 等比缩放的目标尺寸：按长边适配，不裁切、不拉伸。
 *
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} target 目标边长
 * @returns {{width: number, height: number}}
 */
export function fitToSquare(srcWidth, srcHeight, target) {
  if (!srcWidth || !srcHeight) throw new Error(`图片尺寸异常：${srcWidth}x${srcHeight}`);
  const scale = target / Math.max(srcWidth, srcHeight);
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

/**
 * 校验图标种类，非法值直接抛错（fail-closed，不做静默纠正）。
 *
 * @param {string} kind
 * @returns {'app' | 'tray'}
 */
export function assertIconKind(kind) {
  if (!ICON_KINDS.includes(kind)) throw new Error(`未知的图标种类：${kind}`);
  return /** @type {'app' | 'tray'} */ (kind);
}
