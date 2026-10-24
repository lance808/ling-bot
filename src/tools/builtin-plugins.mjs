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

/**
 * 随包分发的内置插件清单。只列目录名。
 *
 * ## 为什么 `regex-reply` 也在里面
 *
 * 它回答的是一个和"插件机制"同样基础的问题：**不是每条消息都值得跑一次模型。**
 * 固定的口令、菜单、签到、格式纠正，用一条正则回掉就够；让它们进模型
 * 既慢又贵，而且模型的回答还不稳定（同一句「帮助」两次可能给两份不同的菜单）。
 *
 * 它默认**不启用**（`plugins.enabled` 里没有它）。这是有意的：自动回复
 * 会在群里说话，属于"装上就该由主人决定开不开"的那类能力。
 *
 * ## 为什么 `course-schedule` 也默认不启用
 *
 * 它同样**不在** `plugins.enabled` 里，原因和 regex-reply 不同：
 * 课程表要写磁盘、要按「会话 + 用户」保存业务数据（`effects: data.session`），
 * 而且它的工具需要管理员在 `plugins.chatTools` 里点名之后才会出现在群里。
 * 一个"装上就开始攒数据"的插件不该是默认状态 —— 用户主动打开它，
 * 才说明他确实想让机器人替他记课程表。
 *
 * 但**铺盘**和**启用**是两件事：不铺过去，用户连"在哪里启用"都找不到
 * （插件页只列磁盘上真实存在的目录）。所以它在清单里、不在启用列表里。
 *
 * ## 为什么 `stickers` 也默认不启用
 *
 * 它要写 QQ 账号里的收藏（R2）和一份跨会话共享的表情库。
 * 「收藏」是不可撤销的账号级写入：塞进去一张，用户在 QQ 客户端里能看到、
 * 得自己去删。而它最有趣的行为（群里接梗发表情）依赖模型自己判断时机 ——
 * 一个"装上就开始往外发图"的插件不该是默认状态。
 *
 * 另外它和默认人格直接冲突：内置人格写着「不用表情包」。默认启用会让
 * 用户看到一个"提示词说别用、工具却摆着"的分裂状态，而他现在根本
 * 没打算要这个功能。
 *
 * ## 为什么 `web-search` 也不默认启用
 *
 * 它要**往外发网络请求**（搜索 API + 抓网页），而且吃的是用户自己买的
 * 搜索额度。一个"装上就会联网"的插件不该是默认状态 —— 用户主动启用、
 * 主动填 Key，才说明他确实想让机器人去查外网。
 *
 * 注意联网总闸（`network.enabled`）缺省是 true，但那条开关**管不到**
 * "插件有没有被启用"：三条同时成立（总闸开 + 插件启用 + 配了 Key）
 * 才会有搜索工具。所以默认配置下 grep 不到任何联网工具。
 *
 * 它同样必须铺盘：插件页只列磁盘上真实存在的目录，不铺过去用户连
 * "在哪里启用它"都找不到。
 */
// image-generation 默认不启用：独立收费服务必须先配置管理员与逐次引用审批。
export const BUILTIN_PLUGINS = ['dsh-bridge', 'echo', 'regex-reply', 'course-schedule', 'stickers', 'web-search', 'image-generation'];

/**
 * 一个目录算不算"装好了的插件"。
 *
 * 判据是 `plugin.json`，不是入口文件：骨架改造后**清单是唯一事实来源**，
 * 只有入口没有清单的目录在新加载器眼里是 `E4060`（缺清单）。
 * 所以"要不要铺"也必须按清单判断，否则会出现
 * "目录里有 index.mjs → 判定已安装 → 永远不补清单 → 插件永远加载失败"。
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isInstalled(dir) {
  try {
    await fs.access(path.join(dir, 'plugin.json'));
    return true;
  } catch {
    return false;
  }
}

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

    /*
     * 出厂源与目标**可能是同一个目录**。
     *
     * 2026-10-22 起插件目录默认是 `<程序目录>/plugins`，而内置插件的
     * 出厂源也在 `<程序目录>/plugins` —— 两者重合。
     *
     * 这时必须直接跳过：`fs.cp(from, to)` 在 `from === to` 时
     * 会往自己身上拷，轻则报 EINVAL，重则把插件目录拷成嵌套的
     * `dsh-bridge/dsh-bridge/...`。而这一步是启动流程里的，
     * 出错会让"插件全挂"看起来像是升级失败。
     *
     * 判定用 resolve 后的真实路径比较，避免 `D:\a\..\a` 这种写法漏判。
     */
    if (path.resolve(from) === path.resolve(to)) {
      out.skipped.push(name);
      continue;
    }

    try {
      const exists = await fs
        .access(path.join(from, 'plugin.json'))
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        // 打包后可能没有出厂源（tree-shake 掉了），这不是错误
        out.skipped.push(name);
        continue;
      }

      const already = await isInstalled(to);

      /*
       * 目录存在但**没有 plugin.json** = 骨架改造前的旧版安装。
       *
       * 这种目录必须整目录覆盖，不能走"不覆盖已有文件"的路。
       * 真踩到过：旧版只有 index.mjs（工具带 run 的老接口），
       * `isInstalled` 因为没清单判成"没装过"，于是只补了 plugin.json、
       * 老 index.mjs 被 EEXIST 跳过 —— 结果是"新清单 + 旧代码"，
       * 加载时报 E4041「声明了 tools 但入口没有实现 callTool()」。
       *
       * 更隐蔽的是它只发生一次：第二次启动时 plugin.json 已经在，
       * 判定变成"已安装"，于是这个坏状态被永久固化，再也不会自愈。
       */
      const hasOldDir = await fs
        .access(to)
        .then(() => true)
        .catch(() => false);

      // 版本比较决定"要不要覆盖已装的文件"。
      //
      // 不覆盖是为了保住用户手动改的插件；但那样一来**程序自己的升级也进不去**，
      // 症状是"代码改了、重启了、行为没变"——非常难查（我踩过一次）。
      // 所以：出厂版本 > 已装版本时才覆盖，或者这是旧版目录时（必须迁移）。
      const factoryVer = await readVersion(from);
      const installedVer = already ? await readVersion(to) : '';
      const upgrade = (already && factoryVer !== installedVer && factoryVer !== '0') || (!already && hasOldDir);

      await copyMissing(from, to, upgrade);

      /*
       * 升级后清掉可能残留的旧文件。
       *
       * 新结构下入口仍是 index.mjs，但插件目录里的文件会变（比如删掉了
       * 某个 lib、换了入口名）。`copyMissing` 只增不减，残留的旧文件
       * 可能被误 import —— 那是最难查的一类"改了没生效"。
       *
       * 只在**升级**时做，且只删"出厂源里没有、而旧版本标记里有的"文件，
       * 避免误删用户自己加的文件。这里保守处理：只删 `index.js` 这种
       * 明确的旧命名，其余交给用户。
       */
      if (upgrade) {
        try {
          await fs.unlink(path.join(to, 'index.js'));
        } catch {
          /* 不存在就是最好的情况 */
        }
      }

      if (upgrade && already) {
        out.installed.push(name);
        log(`内置插件 ${name} 已升级 ${installedVer || '0'} → ${factoryVer}`);
      } else if (upgrade) {
        // 旧版目录（有入口没清单）被整体覆盖成新结构
        out.installed.push(name);
        log(`内置插件 ${name} 已从旧版结构迁移到插件清单格式`);
      } else if (!already) {
        out.installed.push(name);
        log(`内置插件 ${name} 已安装到 ${to}`);
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

/**
 * 旧插件目录 → 新插件目录的一次性补齐。
 *
 * ## 为什么需要它
 *
 * 插件目录从 `%APPDATA%\ling-bot\plugins` 改到了程序目录下。
 * 不迁移的话，用户在旧位置装的插件会**静默消失**：配置里还写着启用，
 * 加载器报 0 个插件，界面上一切正常。这种"什么都没发生"的故障
 * 比报错难查得多。
 *
 * ## 三条规则
 *
 * 1. **只补缺，不覆盖。** 新目录里已有同名插件 = 用户已在新位置改过，
 *    旧副本不能反向冲掉它。
 * 2. **不删旧目录。** 删是不可逆的，而留着最多是占点空间。
 *    用户可能还有别的程序在读它，或者想手动比对。
 * 3. **失败不致命。** 迁移不上只是"插件没跟过来"，记一条日志即可，
 *    不该让主程序起不来。
 *
 * @param {{root: string, pluginsDir: string}} paths
 * @param {{info: Function, warn: Function}} log
 * @returns {Promise<{migrated: string[], skipped: string[]}>}
 */
export async function migrateLegacyPlugins(paths, log) {
  /** @type {{migrated: string[], skipped: string[]}} */
  const out = { migrated: [], skipped: [] };

  const legacyDir = path.join(paths.root, 'plugins');
  const targetDir = paths.pluginsDir;

  // 同一个目录就不用迁（新默认就是程序目录，数据根也可能正好是程序目录）
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return out;

  let names;
  try {
    const entries = await fs.readdir(legacyDir, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    // 没有旧目录 = 全新安装，正常
    return out;
  }

  for (const name of names) {
    const from = path.join(legacyDir, name);
    const to = path.join(targetDir, name);
    try {
      // 新位置已经有这个插件：用户已在新位置维护，跳过
      const exists = await fs
        .access(path.join(to, 'plugin.json'))
        .then(() => true)
        .catch(() => false);
      if (exists) {
        out.skipped.push(name);
        continue;
      }

      await fs.mkdir(targetDir, { recursive: true });
      await fs.cp(from, to, { recursive: true, force: false, errorOnExist: false });
      out.migrated.push(name);
      log.info(`插件 ${name} 已从旧目录迁移到 ${to}`, { from });
    } catch (err) {
      const message = String(/** @type {any} */ (err)?.message ?? err);
      log.warn(`插件 ${name} 迁移失败（不影响主程序）`, { from, message });
    }
  }

  if (out.migrated.length > 0) {
    log.info('旧插件目录迁移完成', {
      migrated: out.migrated,
      legacyDir,
      // 明确告诉用户旧目录还在，可以自己删
      note: '旧目录仍保留，确认新目录可用后可手动删除',
    });
  }

  return out;
}
