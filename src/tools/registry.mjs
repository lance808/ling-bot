/**
 * 工具注册表 —— F14.2
 *
 * 工具是**声明**，不是随便挂上去的函数。每个工具必须显式写：
 *   - risk       风险档（R0–R3）
 *   - origins    哪些回合来源可见（不写 = 谁都看不到，fail-closed）
 *   - confirm    是否需要人工确认
 *   - limits / pathPolicy 约束
 *
 * 显式注册而非动态扫描目录：这样整份工具面可以静态审计，
 * 也能在启动时打印出来给人核对（见 listTools）。
 *
 * 注意：本文件只负责"登记"，**不负责授权**。授权在 guard/tool-gate.mjs。
 */

/** @type {Map<string, object>} */
const registry = new Map();

/**
 * 登记一个工具。
 *
 * @param {object} tool
 * @returns {object} 登记后的工具
 */
export function defineTool(tool) {
  if (!tool || typeof tool !== 'object') {
    throw new TypeError('工具声明必须是对象');
  }
  if (typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(tool.name)) {
    throw new TypeError(`工具名非法：${String(tool.name)}`);
  }
  if (!Array.isArray(tool.origins) || tool.origins.length === 0) {
    // 硬性：必须显式声明来源，否则等于谁都能用
    throw new TypeError(`工具 ${tool.name} 必须显式声明 origins`);
  }
  if (typeof tool.run !== 'function') {
    throw new TypeError(`工具 ${tool.name} 缺 run()`);
  }
  if (registry.has(tool.name)) {
    throw new TypeError(`工具重复登记：${tool.name}`);
  }

  const normalized = {
    kind: 'qq',
    risk: 'R0',
    confirm: 'never',
    params: {},
    limits: {},
    pathPolicy: 'none',
    ...tool,
  };
  registry.set(normalized.name, normalized);
  return normalized;
}

/** @returns {object[]} */
export function listTools() {
  return [...registry.values()];
}

/**
 * @param {string} name
 * @returns {object | undefined}
 */
export function getTool(name) {
  return registry.get(name);
}

/** 仅供测试使用：清空注册表 */
export function _clearToolsForTest() {
  registry.clear();
}

/**
 * 启动时打印一份工具面清单。
 * 目的：让人一眼看到"这个机器人现在能做什么"，而不是去翻代码。
 *
 * @returns {string}
 */
export function describeTools() {
  const tools = listTools();
  if (tools.length === 0) return '（未登记任何工具）';
  return tools
    .map((t) => {
      const origins = t.origins.join(',');
      const confirm = t.confirm === 'never' ? '' : ` confirm=${t.confirm}`;
      return `  ${t.name.padEnd(16)} ${t.risk}  [${origins}]${confirm}`;
    })
    .join('\n');
}
