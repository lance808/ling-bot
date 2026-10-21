/**
 * 路径解析 —— 数据放哪
 *
 * 开发期默认放仓库内 `data/`；打包后桌面壳通过 `LING_USER_DATA`
 * 指到 `%APPDATA%\ling-bot`。
 *
 * 结构（对照 FUNCTIONS §5 F5）：
 *   <root>/config.json
 *   <root>/secrets.json
 *   <root>/state/sessions.json
 *   <root>/state/<convKey>.jsonl
 *   <root>/state/tool-calls.jsonl
 *   <root>/logs/app-<date>.log
 */

import path from 'node:path';
import os from 'node:os';

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
 * @property {string} pluginsDir
 */

/**
 * @param {string} [root]
 * @returns {AppPaths}
 */
export function resolvePaths(root) {
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
    /** 插件根目录：每个插件一个子目录，内含 plugin.json + 入口 */
    pluginsDir: path.join(resolvedRoot, 'plugins'),
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
