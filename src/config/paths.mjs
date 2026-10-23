/**
 * 路径解析 —— 数据放哪
 *
 * 开发期默认放仓库内 `data/`；打包后桌面壳通过 `LING_USER_DATA`
 * 指到 `%APPDATA%\ling-bot`。
 *
 * ## 但插件目录**不跟着数据根走**（2026-10-22 调整）
 *
 * 插件默认放在**程序目录**下的 `plugins/`，而不是 `%APPDATA%`。
 * 理由：插件是用户自己写/自己拷进来的东西，用户去找它的路径是
 * "我程序装在哪" —— 打完包之后没人会想到 `%APPDATA%\ling-bot\plugins`。
 * 而且改一个插件就要去 AppData 里翻，隐藏目录本身就不该是主要编辑位置。
 *
 * 升级用 `LING_PLUGINS_DIR` 覆盖（运行时给绝对路径即可）。
 *
 * 结构（对照 FUNCTIONS §5 F5）：
 *   <root>/config.json
 *   <root>/secrets.json
 *   <root>/state/sessions.json
 *   <root>/state/<convKey>.jsonl
 *   <root>/state/tool-calls.jsonl
 *   <root>/logs/app-<date>.log
 *   <program>/plugins/<id>/plugin.json    ← 不在 <root> 下
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * 程序目录 —— 插件默认落在这里。
 *
 * `import.meta.url` 指向 `<program>/src/config/paths.mjs`，
 * 往上三层就是 `<program>`。不能用 `process.cwd()`：桌面壳启动后端时
 * 会把 cwd 设成资源根，而单测/脚本的 cwd 是仓库根 —— 两者恰好都是
 * `<program>`，但 `import.meta.url` 更直接，也不受"谁 spawn 了它"影响。
 *
 * @returns {string}
 */
export function programDir() {
  // src/config/paths.mjs → src/config → src → <program>
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * 插件根目录。
 *
 * 优先级：显式传入 > `LING_PLUGINS_DIR` > `<program>/plugins`
 *
 * @param {string} [root] 数据根（只在没有覆盖时用来推导后备位置）
 * @param {string} [override] 显式指定
 * @returns {string}
 */
export function resolvePluginsDir(root, override) {
  if (override) return path.resolve(override);
  const fromEnv = process.env.LING_PLUGINS_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(programDir(), 'plugins');
}

/**
 * @typedef {object} AppPaths
 * @property {string} root 数据根目录
 * @property {string} stateDir
 * @property {string} logsDir
 * @property {string} configPath
 * @property {string} secretsPath
 * @property {string} vaultPath 加密后的凭据（DPAPI，绑定当前 Windows 账户）
 * @property {string} personaPath 人格卡：它是谁
 * @property {string} rolePath 角色卡：它在什么场景扮演什么
 * @property {string} thinkingDir 思考链路的按日归档目录
 * @property {string} sessionsPath 会话楼层仓库（state/sessions.json）
 * @property {string} diaryDir 日记的按日归档目录
 * @property {string} pluginsDir 插件根目录（默认在程序目录下，不在数据根下）
 */

/**
 * @param {string} [root]
 * @param {{pluginsDir?: string}} [opts]
 * @returns {AppPaths}
 */
export function resolvePaths(root, opts = {}) {
  const resolvedRoot = root || process.env.LING_USER_DATA || path.join(process.cwd(), 'data');
  return {
    root: resolvedRoot,
    stateDir: path.join(resolvedRoot, 'state'),
    logsDir: path.join(resolvedRoot, 'logs'),
    configPath: path.join(resolvedRoot, 'config.json'),
    secretsPath: path.join(resolvedRoot, 'secrets.json'),
    /**
     * 凭据保险箱：内容是 DPAPI 加密后的密文，**只有当前 Windows 账户能解开**。
     *
     * 注意 `.gitignore` 里同时挡了 `secrets.json` 和 `*.vault`：
     * 虽然加密了，但密文也不该进仓库（换账户就废，留着只是噪音）。
     */
    vaultPath: path.join(resolvedRoot, 'secret.vault'),
    personaPath: path.join(resolvedRoot, 'persona.json'),
    /** 角色卡：它在什么场景扮演什么（与人格正交，各自独立切换） */
    rolePath: path.join(resolvedRoot, 'role.json'),
    /**
     * 思考链路归档：一天一个 `<YYYY-MM-DD>.json`。
     *
     * 单独一个目录而不是塞进 state/：它纯属可丢弃的展示数据，
     * 清理能力（超期/超量自动删）只作用于这里，不会误伤会话与用量。
     */
    thinkingDir: path.join(resolvedRoot, 'thinking'),
    /**
     * 会话楼层仓库：`state/sessions.json`。
     *
     * 注释里一直写着它，但直到加楼层系统才真正被写。之前会话只在内存里，
     * 重启即清空 —— 而那正是「按条读取聊天记录」做不到的根本原因。
     */
    sessionsPath: path.join(resolvedRoot, 'state', 'sessions.json'),
    /**
     * 日记：一天一个 `<YYYY-MM-DD>.json`。
     *
     * 与 thinking/ 分开的理由相同：它是可清理的展示/记忆数据，
     * 清理策略不该误伤会话本身。
     */
    diaryDir: path.join(resolvedRoot, 'diary'),
    /**
     * 插件根目录：每个插件一个子目录，内含 plugin.json + 入口。
     *
     * **默认在程序目录下**，不在数据根下 —— 详见文件头注释。
     */
    pluginsDir: resolvePluginsDir(resolvedRoot, opts.pluginsDir),
    /**
     * 插件凭据保险箱：`{ "<pluginId>": { "<configKey>": <sealed> } }`。
     *
     * 与 `vaultPath`（LLM key）分开：那个文件的格式是单个 sealed 对象，
     * 而且删除它等于"清除 API Key"这个用户可见动作。插件凭据是另一回事，
     * 混在一起会让"清 key"顺手把插件令牌也清了。
     */
    pluginSecretsPath: path.join(resolvedRoot, 'plugin-secrets.vault'),
    /**
     * 插件运行数据：每个插件一个子目录。
     *
     * **刻意不放在 `plugins/<id>/` 里面**：升级插件要整体替换插件目录，
     * 数据放里面就等于每次更新都清缓存。
     */
    pluginDataDir: path.join(resolvedRoot, 'plugin-data'),
  };
}

/** 工具默认可见的根：一个无害的临时目录，而不是整个磁盘（fail-closed） */
export function defaultToolRoots() {
  return [path.join(os.tmpdir(), 'ling-bot-workspace')];
}
