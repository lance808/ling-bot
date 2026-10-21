/**
 * 快照指纹 —— 判断这次轮询到底有没有"真变化"
 *
 * ## 为什么值得单独一个文件
 *
 * 这段逻辑决定"要不要重绘整页"，而重绘整页是这个界面里代价最大的动作。
 * 它必须能被单测钉住：哪几个字段该被忽略、哪几个必须参与比较，
 * 一旦改错，表现是"界面不刷新"或者"每 2 秒闪一下"，两种都很难现场归因。
 */

/**
 * 每轮必然在变、但界面**不显示**的字段。
 *
 * 上游心跳一秒来一次，这几个时间戳于是每 2 秒必然不同。
 * 把它们算进指纹，指纹就永远对不上，等于没做。
 *
 * 只剥这三个。`brain.conversations[].lastHumanAt` 之类虽然也是时间戳，
 * 但工具页会把它显示成"最近有人说话"的时间 —— 剥掉就会变成
 * "有人说话、列表却不动"。
 */
export const VOLATILE_SNAPSHOT_KEYS = Object.freeze([
  'lastHeartbeatAt',
  'lastEventAt',
  'lastGoodAt',
]);

/**
 * 用量区间里**只用于内部对齐**的两个边界。
 *
 * `usage.query` 的入参是 { since: now - 窗口, until: now }，每次查询都一样
 * 带着"当时的时间"回来，于是每 30 秒刷新一次就必然差一点 —— 但那不是
 * 用户看得见的变化：`until` 界面根本不读；`since` 只被
 * `views/usage.mjs` 用 60 秒容差判"这份汇总还对不对得上当前窗口"，
 * 而汇总每 30 秒刷新一次，pull 仍将最新边界静默写入 store，保持容差成立。
 *
 * 所以这两个不进指纹：否则每 30 秒白闪一下。
 */
export const VOLATILE_RANGE_KEYS = Object.freeze(['since', 'until']);

const VOLATILE = new Set(VOLATILE_SNAPSHOT_KEYS);
const VOLATILE_RANGE = new Set(VOLATILE_RANGE_KEYS);

/**
 * 剥掉"噪声字段"后的深拷贝，供 fingerprint 序列化。
 *
 * 用 JSON 的 replacer 做不到"只在 usage.range 这一层剥"，所以先走一遍
 * 深拷贝。快照体量不大（消息 100 条、思考 50 条），这点开销远小于
 * 一次整页 DOM 重建。
 *
 * @param {any} value
 * @param {string} location
 * @returns {any}
 */
function strip(value, location) {
  if (Array.isArray(value)) return value.map((v, i) => strip(v, `${location}.${i}`));
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE.has(k)) continue;
      if (location === 'usage.range' && VOLATILE_RANGE.has(k)) continue;
      out[k] = strip(v, location ? `${location}.${k}` : k);
    }
    return out;
  }
  return value;
}

/**
 * 生成快照指纹。
 *
 * 相同 = 这一轮没有用户看得见的变化，不必重绘。
 *
 * @param {any} snap
 * @returns {string}
 */
export function snapshotFingerprint(snap) {
  return JSON.stringify(strip(snap, ''));
}
