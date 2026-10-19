/**
 * dsh-qq-bridge 的纯判定逻辑
 *
 * 单独一个文件，**不导入 schemastery**：这样单元测试可以直接测这些判定，
 * 不需要 DSH 的运行时依赖。schema 声明留在 index.js。
 */

export function parseAdmins(raw) {
  return String(raw ?? '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4,15}$/.test(s));
}

/**
 * 判断一个 QQ 号是不是管理员。
 *
 * @param {string} qq
 * @param {string[]} admins
 * @returns {boolean}
 */
export function isAdmin(qq, admins) {
  return admins.includes(String(qq));
}

/**
 * 决定 QQ 不可达时返回什么审批结论。
 *
 * 注意返回 `null` 表示"不接管，调 next()"，
 * 与返回 `'rejected'` 是两件完全不同的事：
 * 前者把决定权交回 DSH，后者是替 DSH 做了拒绝的决定。
 *
 * @param {string} policy
 * @returns {'rejected'|null}
 */
export function unreachableOutcome(policy) {
  return policy === 'deny' ? 'rejected' : null;
}

