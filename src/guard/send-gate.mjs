/**
 * 发送闸门 —— F6 / F13 边界第 2 条
 *
 * 这是全仓库**唯一**的发送通路。闸门在函数内部，任何调用方都绕不过。
 *
 * 顺序（任何一条不过即拒绝，且拒绝也要留审计行）：
 *   1. 目标形状合法
 *   2. 命中白名单且未命中黑名单
 *   3. 出站审计通过
 *   4. 未触及限流
 *   5. 内容非空
 */

import { isValidConvKey } from '../onebot/events.mjs';

/**
 * @typedef {object} GateConfig
 * @property {{groups: string[], private: string[]}} allow
 * @property {{groups: string[], private: string[]}} deny
 * @property {boolean} [allowAllWhenEmpty]
 * @property {{maxPerMinute: number, maxPerHour: number}} [limits]
 * @property {string[]} [admins] 管理员 QQ：他们的**私聊**始终可送达
 */

/**
 * 白名单判定：`deny` 优先于 `allow`；两侧统一 String() 比较
 * （兼容 OneBot int64 数字/字符串差异）。
 *
 * ## 为什么管理员私聊要豁免白名单
 *
 * 白名单回答的是"**谁能命令机器人**"。而审批推送是反方向：
 * **机器人主动找管理员**。
 *
 * 这两件事用同一张表会让一个必然场景失败：管理员配好了审批推送，
 * 但没把自己的私聊加进白名单（那本来是为"允许谁发指令"准备的），
 * 于是审批发不出去——而且是静默失败，DSH 那边一直等到超时。
 *
 * 管理员本来就拥有最高权限，让他们能**收到**自己要求收到的消息，
 * 不是放宽边界，而是把边界放对地方。
 *
 * 仍然保留 `deny` 的优先权：显式拉黑比管理员身份更说了算，
 * 这样万一某个号被盗、先拉黑是立即生效的。
 *
 * @param {string} convKey
 * @param {GateConfig} cfg
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function checkWhitelist(convKey, cfg) {
  if (!isValidConvKey(convKey)) {
    return { ok: false, code: 'E4033', message: `会话键形状非法：${String(convKey)}` };
  }
  const [kind, id] = convKey.split(':');
  const denyList = (kind === 'group' ? cfg.deny?.groups : cfg.deny?.private) ?? [];
  const allowList = (kind === 'group' ? cfg.allow?.groups : cfg.allow?.private) ?? [];

  if (denyList.some((x) => String(x) === id)) {
    return { ok: false, code: 'E20XX', message: `目标在黑名单：${convKey}` };
  }
  if (allowList.some((x) => String(x) === id)) {
    return { ok: true };
  }
  // 管理员私聊：审批/通知必须送得到，不受"谁能命令机器人"那张表限制
  if (kind === 'private' && (cfg.admins ?? []).some((x) => String(x) === id)) {
    return { ok: true };
  }
  // 空白名单时 fail-closed 是默认；只有显式打开才放行
  if (allowList.length === 0 && cfg.allowAllWhenEmpty === true) {
    return { ok: true };
  }
  return { ok: false, code: 'E20XX', message: `目标不在白名单：${convKey}` };
}

/**
 * 简单滑动窗口限流（内存态即可：重启清零是可接受的语义）。
 */
export class RateLimiter {
  /** @param {{maxPerMinute: number, maxPerHour: number}} limits */
  constructor(limits) {
    this.limits = limits;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /**
   * @param {string} key
   * @returns {{ok: true} | {ok: false, code: string, message: string}}
   */
  take(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < 3600_000);
    const perMinute = arr.filter((t) => now - t < 60_000).length;
    if (perMinute >= this.limits.maxPerMinute) {
      return { ok: false, code: 'E2030', message: `发送过快（每分钟上限 ${this.limits.maxPerMinute}）` };
    }
    if (arr.length >= this.limits.maxPerHour) {
      return { ok: false, code: 'E2030', message: `发送过快（每小时上限 ${this.limits.maxPerHour}）` };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true };
  }
}

/**
 * 这个会话是不是管理员私聊。
 *
 * @param {string} convKey
 * @param {GateConfig} cfg
 * @returns {boolean}
 */
export function isAdminPrivate(convKey, cfg) {
  if (!isValidConvKey(convKey)) return false;
  const [kind, id] = convKey.split(':');
  if (kind !== 'private') return false;
  return (cfg.admins ?? []).some((x) => String(x) === id);
}

/**
 * 发送闸门。
 *
 * @param {object} req
 * @param {string} req.convKey
 * @param {string} req.text
 * @param {GateConfig} req.config
 * @param {(text: string) => {ok: boolean, code?: string, message?: string, hits?: string[]}} req.audit
 * @param {RateLimiter} req.limiter
 * @returns {{ok: true, text: string} | {ok: false, code: string, message: string, denied: true}}
 */
export function passSendGate(req) {
  const { convKey, text, config, audit, limiter } = req;

  const wl = checkWhitelist(convKey, config);
  if (!wl.ok) return { ok: false, denied: true, code: wl.code, message: wl.message };

  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, denied: true, code: 'E2031', message: '内容为空' };
  }

  const audited = audit(text);
  if (!audited.ok) {
    return { ok: false, denied: true, code: audited.code ?? 'E2020', message: audited.message ?? '出站审计拦截' };
  }

  /*
   * 限流对**管理员私聊**不设限。
   *
   * ## 为什么必须豁免
   *
   * 限流回答的是"别把消息刷爆"，它针对的是群发、主动发言、AI 回合这些
   * 可能连续产出的场景。而管理员私聊是**一对一的服务通道**：
   *
   *   - 审批推送、提问推送、确认卡、确认回执，全部走它；
   *   - 一次审批往返至少 2 条（卡片 + 回执），一个稍微忙一点的回合就是 6~8 条。
   *
   * 默认 8 条/分钟、60 条/小时，**正常使用就会撞上**。后果不是"少发一条"，
   * 而是：确认卡发不出去 → 用户不知道要确认 → 60 秒后按拒绝处理；
   * 或者回执发不出去 → 用户确认成功了却什么都没收到，只能反复重试。
   *
   * 这两种失败都是静默的（`sendText` 返回 `{ok:false}` 而不是抛异常），
   * 排查时几乎无从下手。
   *
   * ## 这不是放宽安全边界
   *
   * - 白名单和出站审计**照旧生效**，管理员也不能让凭据/本机路径发出去；
   * - 只对 `private:<admin QQ>` 生效，群聊与陌生人私聊完全不受影响；
   * - 管理员本来就有最高权限，不让他收到自己要求的通知没有安全收益。
   */
  if (!isAdminPrivate(convKey, config)) {
    const rl = limiter.take(convKey);
    if (!rl.ok) return { ok: false, denied: true, code: rl.code, message: rl.message };
  }

  return { ok: true, text };
}
