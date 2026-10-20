/**
 * 插件加载器 —— F13 的扩展通道（对应你笔记里的需求 1）
 *
 * ## 先说清楚一件事：插件不是沙箱
 *
 * 插件是**用户自己安装的代码**，它跑在同一个进程里，能读文件、能发网络。
 * 所以"插件"这个机制**不提供任何隔离**，它的价值是：
 *   让 AI 能调用的工具面可以被**扩展**，而不必改核心代码。
 *
 * 真正的安全边界仍在 `guard/tool-gate.mjs`：
 * 它管的是"**模型**能被允许调用什么"，不是"插件代码能干什么"。
 * 装一个恶意插件 = 你自己在电脑上运行了恶意代码，这跟装别的软件一样。
 * 文档里必须写清这一点，免得有人以为"插件是安全的"。
 *
 * ## 那这个加载器负责防什么
 *
 * 防的是**插件在授权声明上作弊**——这是实际会遇到的问题：
 *
 * | 插件可能想干的事 | 宿主怎么处理 |
 * | --- | --- |
 * | 声明 `origins: ['group']` 让自己对任何群聊可见 | **宿主覆盖 origins**，插件说了不算 |
 * | 声明 `confirm: 'never'` 绕过人工确认 | **宿主按 risk 自己算 confirm** |
 * | 起名 `fs_read` 顶掉内置工具 | 拒绝加载（不许覆盖内置） |
 * | 声明 `risk: 'R0'` 但实际干危险的事 | risk 上限 R1；R2/R3 需显式开关 |
 * | 加载时抛异常拖垮整个程序 | 单插件失败隔离，只记一行 |
 *
 * 所以：**插件只声明"我是谁、要什么"，权限由宿主决定。**
 *
 * ## 默认关闭
 *
 * 不在 `config.plugins.enabled` 里列出的插件一律不加载。
 * 光把文件放进 plugins/ 不会生效——多一道明确的动作。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ORIGIN } from '../guard/origin.mjs';
import { RISK } from '../guard/tool-gate.mjs';
import { defineTool, getTool } from './registry.mjs';

/** 插件只允许声明这两档能力需求 */
const VALID_NEEDS = new Set(['host', 'qq']);

/** 插件工具名统一加前缀，避免与内置撞名（也让人一眼看出是插件） */
export const PLUGIN_TOOL_PREFIX = 'plugin_';

/** 插件允许声明的最高风险档；R2/R3 需要宿主显式放行 */
const PLUGIN_MAX_RISK = RISK.R1;

/**
 * @typedef {object} PluginLoadResult
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [code]
 * @property {string} [message]
 * @property {string[]} tools 成功登记的工具名
 * @property {any} [mod] 插件模块本身（宿主需要调用它的生命周期钩子）
 */

/**
 * 加载插件。
 *
 * @param {object} opts
 * @param {string} opts.dir 插件根目录
 * @param {string[]} opts.enabled 允许加载的插件名（空 = 一个都不加载）
 * @param {boolean} [opts.allowDangerous] 是否允许插件声明 R2/R3
 * @param {(msg: string, meta?: object) => void} [opts.log]
 * @param {object} [opts.host] 宿主能力（sendText 等），显式注入而非全局
 * @returns {Promise<{loaded: PluginLoadResult[], skipped: string[]}>}
 */
export async function loadPlugins(opts) {
  const log = opts.log ?? (() => {});
  /** @type {PluginLoadResult[]} */
  const loaded = [];
  /** @type {string[]} */
  const skipped = [];

  // 目录不存在是正常情况（还没装任何插件）
  let entries;
  try {
    entries = await fs.readdir(opts.dir, { withFileTypes: true });
  } catch {
    return { loaded, skipped };
  }

  const present = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // 目录里有、但没在 enabled 里 → 明确告诉用户"存在但未启用"
  for (const name of present) {
    if (!opts.enabled.includes(name)) skipped.push(name);
  }

  for (const name of opts.enabled) {
    // 名字要能被当目录名用，不能带路径分隔符（防目录穿越）
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(name)) {
      loaded.push({ name, ok: false, code: 'E4041', message: '插件名非法', tools: [] });
      continue;
    }
    if (!present.includes(name)) {
      loaded.push({ name, ok: false, code: 'E4044', message: '插件目录不存在', tools: [] });
      continue;
    }

    try {
      const result = await loadOne(path.join(opts.dir, name), name, opts.allowDangerous === true, opts.host);
      loaded.push(result);
      if (result.ok) log(`插件已加载：${name}（${result.tools.length} 个工具）`);
      else log(`插件加载失败：${name} → ${result.code} ${result.message}`);
    } catch (err) {
      // 单插件抛异常不能拖垮启动
      const e = /** @type {any} */ (err);
      loaded.push({ name, ok: false, code: 'E4045', message: String(e?.message ?? e), tools: [] });
      log(`插件加载异常：${name} → ${String(e?.message ?? e)}`);
    }
  }

  return { loaded, skipped };
}

/**
 * 加载单个插件。
 *
 * @param {string} dir
 * @param {string} dirName
 * @param {boolean} allowDangerous
 * @returns {Promise<PluginLoadResult>}
 */
async function loadOne(dir, dirName, allowDangerous, host) {
  const entry = await findEntry(dir);
  if (!entry) {
    return { name: dirName, ok: false, code: 'E4044', message: '缺入口文件（index.mjs 或 index.js）', tools: [] };
  }

  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { name: dirName, ok: false, code: 'E4045', message: `导入失败：${e?.message ?? e}`, tools: [] };
  }

  const plugin = mod.default ?? mod.plugin;
  if (!plugin || typeof plugin !== 'object') {
    return { name: dirName, ok: false, code: 'E4041', message: '入口必须 export default 一个对象', tools: [] };
  }
  if (plugin.name !== dirName) {
    // 名字与目录不一致会让"启用哪个"变得难以推理
    return { name: dirName, ok: false, code: 'E4041', message: `插件自报名 ${plugin.name} 与目录名不一致`, tools: [] };
  }
  if (!Array.isArray(plugin.tools) || plugin.tools.length === 0) {
    return { name: dirName, ok: false, code: 'E4041', message: '插件没有声明任何工具', tools: [] };
  }

  /** @type {string[]} */
  const registered = [];

  for (const t of plugin.tools) {
    const check = validatePluginTool(t, dirName, allowDangerous);
    if (!check.ok) {
      // 一个工具不合格就整插件失败：避免"部分加载"造成的状态不明
      return { name: dirName, ok: false, code: check.code, message: check.message, tools: [] };
    }

    try {
      const built = buildTool(t, dirName);
      defineTool(built);
      registered.push(built.name);
    } catch (err) {
      const e = /** @type {any} */ (err);
      return { name: dirName, ok: false, code: 'E4041', message: String(e?.message ?? e), tools: [] };
    }
  }

  // 生命周期钩子：插件若导出 startBridge(host)，加载完成后调用一次。
  // **失败不影响工具注册** —— 工具能用比附加通道更重要。
  if (typeof mod.startBridge === 'function' && (dirName !== 'dsh-bridge' || host?.getConfig?.()?.dsh?.enabled === true)) {
    try {
      const r = await mod.startBridge(host ?? {});
      if (r && r.ok === false) host?.log?.(`插件 ${dirName} 的通道未启动：${r.error}`);
    } catch (err) {
      const e = /** @type {any} */ (err);
      host?.log?.(`插件 ${dirName} 的通道启动异常：${String(e?.message ?? e)}`);
    }
  }

  return { name: dirName, ok: true, tools: registered, mod };
}

/**
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function findEntry(dir) {
  for (const f of ['index.mjs', 'index.js']) {
    const p = path.join(dir, f);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) return p;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

/**
 * 校验插件工具声明。
 *
 * 注意这里刻意**不接受**插件声明的 `origins` / `confirm`：
 * 它们由 buildTool 按 needs 与 risk 重新推导。
 * 插件写这两个字段也不会生效（不是报错，是直接忽略——减少插件作者的困惑）。
 *
 * @param {any} t
 * @param {string} pluginName
 * @param {boolean} allowDangerous
 */
function validatePluginTool(t, pluginName, allowDangerous) {
  if (!t || typeof t !== 'object') return { ok: false, code: 'E4041', message: '工具声明必须是对象' };

  if (typeof t.name !== 'string' || !/^[a-z][a-z0-9_]{1,32}$/.test(t.name)) {
    return { ok: false, code: 'E4041', message: `工具名非法：${String(t.name)}（小写字母开头，≤34 字符）` };
  }
  if (typeof t.run !== 'function') {
    return { ok: false, code: 'E4041', message: `工具 ${t.name} 缺 run()` };
  }
  if (!VALID_NEEDS.has(t.needs)) {
    return { ok: false, code: 'E4041', message: `工具 ${t.name} 的 needs 必须是 host 或 qq` };
  }
  if (typeof t.description !== 'string' || t.description.trim().length === 0) {
    // 描述是模型判断"该不该调它"的唯一依据，不能为空
    return { ok: false, code: 'E4041', message: `工具 ${t.name} 缺 description` };
  }

  const risk = t.risk ?? RISK.R0;
  if (!Object.values(RISK).includes(risk)) {
    return { ok: false, code: 'E4041', message: `工具 ${t.name} 的 risk 非法：${String(risk)}` };
  }
  if (risk !== RISK.R0 && risk !== PLUGIN_MAX_RISK && !allowDangerous) {
    return {
      ok: false,
      code: 'E4042',
      message: `工具 ${t.name} 声明了 ${risk}，但插件高风险未放行（config.plugins.allowDangerous）`,
    };
  }

  // 撞名检查：内置与被占用的名字都不许覆盖
  const finalName = PLUGIN_TOOL_PREFIX + t.name;
  if (getTool(finalName)) {
    return { ok: false, code: 'E4043', message: `工具名已被占用：${finalName}` };
  }

  // 插件内重名
  return { ok: true };
}

/**
 * 把插件声明转成宿主工具。
 *
 * **关键：origins 与 confirm 由宿主推导，不是插件说什么就是什么。**
 *
 * @param {any} t
 * @param {string} pluginName
 * @returns {object}
 */
function buildTool(t, pluginName) {
  // needs 决定"这个工具能出现在哪些回合"
  //   host = 需要动本机，只给主人私聊（+ 桌面端本人操作）
  //   qq   = 只动 QQ，主人私聊 + 主人所在群（+ 桌面端）
  //
  // CONSOLE 与内置工具保持一致：桌面端就是用户本人坐在电脑前，
  // 不给它反而会出现"界面里手动试工具却报没权限"的怪事。
  const origins =
    t.needs === 'host'
      ? [ORIGIN.OWNER_PRIVATE, ORIGIN.CONSOLE]
      : [ORIGIN.OWNER_PRIVATE, ORIGIN.OWNER_GROUP, ORIGIN.CONSOLE];

  const risk = t.risk ?? RISK.R0;

  return {
    name: PLUGIN_TOOL_PREFIX + t.name,
    kind: t.needs === 'host' ? 'host' : 'qq',
    // 宿主推导，插件无权声明
    origins,
    risk,
    // R0 自动执行，其余一律要人点头（与内置工具同一套规则）
    confirm: risk === RISK.R0 ? 'never' : 'always',
    description: `${t.description}（来自插件 ${pluginName}）`,
    params: t.params ?? {},
    limits: t.limits ?? {},
    pathPolicy: t.needs === 'host' ? 'roots' : 'none',
    /** 标记来源，便于界面区分"内置"与"插件" */
    plugin: pluginName,
    /**
     * 注意签名：executor 用**单个对象**调用 `run({ args, origin, convKey })`，
     * 与内置工具保持完全一致。
     *
     * 这里曾经把插件侧写成 `(args, ctx)` 两个参数，结果插件永远收不到参数
     * （`args` 整个对象被当成了参数包，`args.text` 是 undefined）。
     * 插件的书写风格由这里决定，所以适配只在这一层做——插件作者只见 `(args, ctx)`。
     */
    run: async ({ args, origin, convKey, roots, signal }) => {
      // 插件工具拿到的是一个受限上下文：不给它 client、不给它 config
      // （真给了也拦不住它自己 require，但至少不会因为便利而诱发越权）
      const safeCtx = { origin, convKey, roots: roots ?? [], signal };
      return t.run(args ?? {}, safeCtx);
    },
  };
}

/**
 * 生成一份插件面清单（启动日志与界面用）。
 *
 * @param {PluginLoadResult[]} loaded
 * @param {string[]} skipped
 * @returns {string}
 */
export function describePlugins(loaded, skipped) {
  const lines = [];
  if (loaded.length === 0 && skipped.length === 0) return '（未安装任何插件）';

  for (const p of loaded) {
    lines.push(p.ok ? `  ✓ ${p.name}  ${p.tools.join(', ')}` : `  ✖ ${p.name}  ${p.code} ${p.message}`);
  }
  for (const s of skipped) {
    lines.push(`  · ${s}  （已安装但未启用）`);
  }
  return lines.join('\n');
}
