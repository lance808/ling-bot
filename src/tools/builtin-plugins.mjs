/**
 * 内置插件安装 —— 把随包的插件铺到用户数据目录
 *
 * ## 为什么必须有这一步
 *
 * 插件加载器只认 `<userData>/plugins/<name>/`。仓库里的 `plugins/`
 * 是**出厂源**，不是运行位置。不铺过去，那个"默认启用"的插件
 * 就永远不在磁盘上——它的表现不是报错，而是**什么都没发生**：
 * 配置里写着启用，加载器报"0 个插件"，端口没起，界面上一切正常。
 *
 * ## 三条规则
 *
 * 1. **只在缺失时铺，不覆盖已有文件。**
 *    用户可能改了插件（修 bug、加工具）。每次启动把改动冲掉是灾难。
 *    升级由版本号判断（见 `marker`），不是靠覆盖。
 *
 * 2. **失败不致命。**
 *    铺不上就记一条日志，主程序照常跑。一个可选功能装不上，
 *    不该让整个程序起不来。
 *
 * 3. **全部在 `<userData>/plugins/` 内。**
 *    不往仓库、系统目录、临时目录写任何东西。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根的 `plugins/`（出厂源）。从 src/config/ 往上两层。 */
const SRC_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const FACTORY_DIR = path.join(SRC_ROOT, 'plugins');

/** 随包分发的内置插件清单。只列目录名。 */
export const BUILTIN_PLUGINS = ['dsh-bridge'];

/**
 * 递归复制。
 *
 * 默认**不覆盖**已存在的文件（保护用户改动）；
 * `overwrite` 为 true 时覆盖全部（出厂版本更新时走这条路）。
 *
 * @param {string} from
 * @param {string} to
 * @param {boolean} [overwrite]
 */
async function copyMissing(from, to, overwrite = false) {
  await fs.mkdir(to, { recursive: true });
  const items = await fs.readdir(from, { withFileTypes: true });
  for (const item of items) {
    const src = path.join(from, item.name);
    const dst = path.join(to, item.name);
    if (item.isDirectory()) {
      // 跳过 node_modules / .git 之类：内置插件目前没有依赖，
      // 真有了也不该把一份 node_modules 拷进用户数据目录（体积大且有原生模块）
      if (item.name === 'node_modules' || item.name === '.git') continue;
      await copyMissing(src, dst, overwrite);
      continue;
    }
    if (overwrite) {
      // 升级路径：直接覆盖。只在"出厂版本比已装的新"时才会走到这里
      await fs.copyFile(src, dst);
      continue;
    }
    try {
      // wx = 只在不存在时创建。已有文件一律保留
      await fs.copyFile(src, dst, fs.constants?.COPYFILE_EXCL ?? 1);
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
    }
  }
}

/**
 * 读出厂的版本标记（插件目录里的 `.builtin-version`）。
 *
 * 没有这个文件就当 `0`，于是旧版本一定会被新版本"升级"一次——
 * 那正是要的效果：补齐以前缺失的逻辑。
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function readVersion(dir) {
  try {
    return (await fs.readFile(path.join(dir, '.builtin-version'), 'utf8')).trim() || '0';
  } catch {
    return '0';
  }
}

/**
 * 把内置插件铺到用户数据目录。
 *
 * @param {object} opts
 * @param {string} opts.pluginsDir 目标 `<userData>/plugins`
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{installed: string[], skipped: string[], failed: {name: string, message: string}[]}>}
 */
export async function installBuiltinPlugins(opts) {
  const log = opts.log ?? (() => {});
  /** @type {{installed: string[], skipped: string[], failed: {name: string, message: string}[]}} */
  const out = { installed: [], skipped: [], failed: [] };

  for (const name of BUILTIN_PLUGINS) {
    const from = path.join(FACTORY_DIR, name);
    const to = path.join(opts.pluginsDir, name);

    try {
      const exists = await fs
        .access(path.join(from, 'index.mjs'))
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        // 打包后可能没有出厂源（tree-shake 掉了），这不是错误
        out.skipped.push(name);
        continue;
      }

      const already = await fs
        .access(path.join(to, 'index.mjs'))
        .then(() => true)
        .catch(() => false);

      // 版本比较决定"要不要覆盖已装的文件"。
      //
      // 不覆盖是为了保住用户手动改的插件；但那样一来**程序自己的升级也进不去**，
      // 症状是"代码改了、重启了、行为没变"——非常难查（我踩过一次）。
      // 所以：出厂版本 > 已装版本时才覆盖，否则一个字节都不动。
      const factoryVer = await readVersion(from);
      const installedVer = already ? await readVersion(to) : '';
      const upgrade = already && factoryVer !== installedVer && factoryVer !== '0';

      await copyMissing(from, to, upgrade);

      if (!already) {
        out.installed.push(name);
        log(`内置插件 ${name} 已安装到 ${to}`);
      } else if (upgrade) {
        out.installed.push(name);
        log(`内置插件 ${name} 已升级 ${installedVer || '0'} → ${factoryVer}`);
      } else {
        out.skipped.push(name);
        log(`内置插件 ${name} 已是最新（${installedVer || '0'}），未覆盖`);
      }
    } catch (err) {
      const message = String(/** @type {any} */ (err)?.message ?? err);
      out.failed.push({ name, message });
      // 装不上只记一笔：它不是主程序的必要部分
      log(`内置插件 ${name} 安装失败（不影响主程序）：${message}`);
    }
  }

  return out;
}

export { FACTORY_DIR };
