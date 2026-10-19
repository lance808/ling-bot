/**
 * 回合来源（trust origin）——F14.1
 *
 * 这是整个安全模型的地基：**授权只看"这个回合是谁发起的"**，
 * 判定输入里不允许出现任何来自对话内容的东西（消息、人格卡、模型给的理由都不行）。
 *
 * 不变量：`tool-gate` 的入参里若混入对话内容，这条防线即失效。
 */

/** @typedef {'owner-private'|'owner-group'|'group'|'proactive'|'console'} Origin */

export const ORIGIN = Object.freeze({
  /** 管理员私聊机器人：唯一能碰本机的来源 */
  OWNER_PRIVATE: 'owner-private',
  /** 管理员在白名单群里发言：群里有别人，按群里算 */
  OWNER_GROUP: 'owner-group',
  /** 群友发言 / @ / 拍一拍 */
  GROUP: 'group',
  /** 概率唤醒（自己发起）：没有任务，不需要工具 */
  PROACTIVE: 'proactive',
  /** 桌面端界面操作 */
  CONSOLE: 'console',
});

const ALL = new Set(Object.values(ORIGIN));

/**
 * 校验一个来源标签是否合法。
 * 任何拼错或伪造的来源都必须显式失败，不能静默降级成某个更宽松的档。
 *
 * @param {unknown} value
 * @returns {Origin}
 */
export function assertOrigin(value) {
  if (typeof value !== 'string' || !ALL.has(value)) {
    const err = new Error(`非法回合来源：${String(value)}`);
    err.code = 'E4032';
    throw err;
  }
  return /** @type {Origin} */ (value);
}

/**
 * 是否属于"管理员本人"这一族。
 * 只有这两种来源可能拿到宿主机工具，且 owner-group 只拿受限 QQ 子集。
 *
 * @param {Origin} origin
 * @returns {boolean}
 */
export function isOwnerOrigin(origin) {
  return origin === ORIGIN.OWNER_PRIVATE || origin === ORIGIN.OWNER_GROUP;
}
