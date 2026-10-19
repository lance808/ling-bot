/**
 * 上游健康 —— F4
 *
 * 这个文件存在的唯一理由：把「连上了但收不到消息」讲清楚。
 * 参考项目里这个失败被反复误报成桥接自身的 bug，代价是用户白排查很久。
 *
 * ## 三态分离，永不合并成一个绿点
 *
 *   linked   我方 WS 与端点握手成功，能收发动作响应
 *   healthy  上游自评 status.good === true（「QQ → hook → 我」这条链真的在来数据）
 *   online   get_status 的 {online, good}，60s 兜底
 *
 * ## 两条硬禁令
 *
 *   1. **不要用 get_login_info 取 good** —— 它只返回 {user_id, nickname}，
 *      取错字段不会报错，good 永远是 null，这条判断会变成永不触发的死代码。
 *   2. **不要用"事件包到达时间"证明收得到 QQ 数据** —— 心跳会一直来。
 */

/** 上游静默多久后认为「good 已过期」，参考实测约 105s 后上游自己会翻 false */
const GOOD_STALE_MS = 150_000;

export class UpstreamHealth {
  #linked = false;
  #good = null;
  #online = null;
  #lastHeartbeatAt = null;
  #lastEventAt = null;
  #lastGoodAt = null;
  /** @type {{at: number, reason: string} | null} */
  #endpointHealed = null;

  /** @param {{linked: boolean, detail?: object}} e */
  onState(state, detail) {
    if (state === 'linked') {
      this.#linked = true;
    } else if (state === 'backoff' || state === 'idle') {
      this.#linked = false;
      // 断线不代表上游不健康；保留上次 good，但标记为陈旧
    }
    void detail;
  }

  /** @param {object} evt 归一化后的事件 */
  onEvent(evt) {
    this.#lastEventAt = Date.now();
    if (evt.kind !== 'meta') return;

    if (evt.metaType === 'heartbeat') {
      this.#lastHeartbeatAt = Date.now();
      const status = evt.status ?? {};
      if (typeof status.good === 'boolean') {
        this.#good = status.good;
        if (status.good) this.#lastGoodAt = Date.now();
      }
      if (typeof status.online === 'boolean') this.#online = status.online;
    }
  }

  /** @param {any} status get_status 的返回 */
  onStatusPoll(status) {
    if (!status) return;
    if (typeof status.online === 'boolean') this.#online = status.online;
    if (typeof status.good === 'boolean') {
      this.#good = status.good;
      if (status.good) this.#lastGoodAt = Date.now();
    }
  }

  /** 端点被自动更正时记一笔（I8：只记 info，不升级 error） */
  noteEndpointHealed(reason) {
    this.#endpointHealed = { at: Date.now(), reason };
  }

  /**
   * 当前健康快照。
   *
   * `receiving` 是给界面看的合判断：联通 + good 为真 + good 未陈旧。
   * 注意 good 会陈旧：上游静默久了我们要主动把它当作"未知/可疑"，
   * 而不是继续显示上一次的 true。
   *
   * @returns {object}
   */
  snapshot() {
    const now = Date.now();
    const goodFresh = this.#lastGoodAt !== null && now - this.#lastGoodAt < GOOD_STALE_MS;
    const receiving = this.#linked && this.#good === true && goodFresh;

    /** @type {'ok'|'degraded'|'unknown'|'offline'} */
    let verdict = 'unknown';
    if (!this.#linked) verdict = 'unknown';
    else if (this.#good === false) verdict = 'degraded';
    else if (receiving) verdict = 'ok';
    else if (this.#good === null) verdict = 'unknown';

    return {
      linked: this.#linked,
      good: this.#good,
      goodFresh,
      online: this.#online,
      receiving,
      verdict,
      lastHeartbeatAt: this.#lastHeartbeatAt,
      lastEventAt: this.#lastEventAt,
      lastGoodAt: this.#lastGoodAt,
      endpointHealed: this.#endpointHealed,
      hint: this.#hint(verdict),
    };
  }

  /**
   * 归因顺序固定（I7）：上游健康 → 准入 → 模式/静默 → 模型。
   * 这里只负责第一段：把话说清楚，并直接指向 [Hook]。
   */
  #hint(verdict) {
    if (verdict === 'degraded') {
      return {
        level: 'warn',
        title: 'SnowLuma 自评接收链路异常',
        text: '问题在 SnowLuma 的 [Hook]，不在 Ling-bot。',
        steps: [
          '看 SnowLuma 日志里的 [Hook] 行（是否有 receive path stale）',
          '确认 hookAutoLoad 是否为 false（false 时不会自动注入）',
          '在 SnowLuma 里手动注入 QQ 进程后重试',
        ],
      };
    }
    if (verdict === 'unknown' && !this.#linked) {
      return {
        level: 'info',
        title: '未联通',
        text: '连不上端点。按这个顺序查，通常第一条就是原因。',
        steps: [
          'SnowLuma 的 OneBot 服务是否启用（wsServers 里 role=Universal 那条）',
          '端口对不对：3000 是 HTTP、3001 是 WS（返回 426 就说明它是 WS 口）',
          '用对 token：HTTP 与 WS 是**两个不同的值**，别混用',
          'token 走 ?access_token=，不是 header',
        ],
      };
    }
    return null;
  }
}
