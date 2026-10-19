/**
 * 扩展骨架：动作表 —— F13
 *
 * 一个 QQ 能力 = 一个声明。加新能力（发语音、发表情、群管理）
 * 只需要新增文件 + 在 index.mjs 注册一行，**不改 client / 闸门 / IPC**。
 *
 * 声明字段：
 *   name         内部名
 *   onebotAction OneBot 11 的动作名
 *   params       JS 版 schema（运行时校验，不信任调用方）
 *   permission   read / send / manage / qzone（决定走哪档闸门）
 *   audit        text / file / none（决定走哪套出站审计）
 *   rateLimit    read / send / manage / voice ...（限流档）
 *   capability   需要探测的上游能力名（I12：外部能力必须探测，不硬编码假设）
 */

/** @type {Map<string, object>} */
const actions = new Map();

/** 合法权限档。`manage` / `qzone` 首版登记但默认不启用（E4030）。 */
export const PERMISSIONS = Object.freeze(['read', 'send', 'manage', 'qzone']);

/**
 * @param {object} action
 * @returns {object}
 */
export function defineAction(action) {
  if (!action || typeof action.name !== 'string' || !action.name) {
    throw new TypeError('动作必须有 name');
  }
  if (typeof action.onebotAction !== 'string' || !action.onebotAction) {
    throw new TypeError(`动作 ${action.name} 必须有 onebotAction`);
  }
  if (!PERMISSIONS.includes(action.permission)) {
    throw new TypeError(`动作 ${action.name} 的 permission 非法：${String(action.permission)}`);
  }
  if (actions.has(action.name)) {
    throw new TypeError(`动作重复登记：${action.name}`);
  }
  const normalized = {
    params: {},
    audit: 'none',
    rateLimit: action.permission,
    capability: null,
    ...action,
  };
  actions.set(normalized.name, normalized);
  return normalized;
}

/** @returns {object[]} */
export function listActions() {
  return [...actions.values()];
}

/**
 * @param {string} name
 * @returns {object | undefined}
 */
export function getAction(name) {
  return actions.get(name);
}

/** 仅供测试 */
export function _clearActionsForTest() {
  actions.clear();
}
