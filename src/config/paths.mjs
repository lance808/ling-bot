/**
 * 路径解析 —— 数据放哪
 *
 * 开发期默认放仓库内 `data/`；打包后主进程通过 `LING_USER_DATA`
 * 指到 Electron 的 `app.getPath('userData')`。
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
    /** 插件根目录：每个插件一个子目录，入口 index.mjs */
    pluginsDir: path.join(resolvedRoot, 'plugins'),
  };
}

/** 工具默认可见的根：一个无害的临时目录，而不是整个磁盘（fail-closed） */
export function defaultToolRoots() {
  return [path.join(os.tmpdir(), 'ling-bot-workspace')];
}
