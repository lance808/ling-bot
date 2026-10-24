/**
 * `ctx.gateway.vision` 的形状 —— 宿主侧与子进程侧共用的一份定义
 *
 * ## 为什么单独抽出来
 *
 * `vision` 是**同步属性**（不是 Promise），而且必须带 `known` 可信位
 * （docs/stickers-contract.md §1）：`known: false` 表示"宿主没给这个事实"，
 * 插件此时不能声称"视觉识别已关闭" —— 它不知道。
 *
 * 这个形状在三个地方各造过一次：
 *
 *   1. `gateway-bridge.mjs` 的 `unavailableGateway()`（宿主没注入网关）；
 *   2. `gateway-bridge.mjs` 的 `makeGateway()` 里 `get vision()`（正常注入）；
 *   3. `child-runner.mjs` 里子进程侧的同步缓存默认值。
 *
 * 第 3 处漏了 `known` 键。行为上恰好等价（`undefined` 也是 falsy，插件
 * 按 `known === true` 判断仍是"不知道"），但那是**巧合**而不是契约：
 * 插件完全可能写 `'known' in vision` 或把对象直接塞进返回值，那时
 * 两端的形状差异就会露出来 —— 而"同一份清单在不同 runtime 下表现不同"
 * 是最难排查的一类问题。
 *
 * 所以把"未知状态长什么样"和"从宿主事实算出视图"收在一处，三处都调它。
 */

/**
 * 宿主没给视觉事实时的默认视图。
 *
 * `enabled: false` 是保守的取值（插件会走"按标签选"那条路），
 * 但**必须**同时给 `known: false`，否则插件会把它读成"视觉关着"。
 */
export const UNKNOWN_GATEWAY_VISION = Object.freeze({
  enabled: false,
  supported: null,
  known: false,
});

/**
 * 从宿主的视觉事实算出一份同步视图。
 *
 * @param {(() => {enabled?: boolean, supported?: boolean | null}) | null} getVision
 *   宿主注入的事实读取函数；缺省（null）表示"宿主没给这个事实"
 * @returns {{enabled: boolean, supported: boolean | null, known: boolean}}
 */
export function gatewayVisionView(getVision) {
  const known = typeof getVision === 'function';
  if (!known) return { ...UNKNOWN_GATEWAY_VISION };
  const v = getVision() ?? {};
  return {
    /*
     * `known: true` 表示"下面这两个值是宿主真的说过的话"，而不是默认值。
     * 插件据此决定说"视觉识别已关闭"还是"当前无法确认读图是否可用"。
     */
    known: true,
    enabled: v.enabled === true,
    // 三态：null = 没探测过，不能折成 false
    supported: typeof v.supported === 'boolean' ? v.supported : null,
  };
}
