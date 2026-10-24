/**
 * 待回复队列 —— 审批与提问共用一张表
 *
 * ## 为什么要统一
 *
 * DSH 有两类要人回答的请求，形状差别很大：
 *
 * - **审批**：答案是 `'allowed-once' | 'rejected'`，两个值。
 * - **提问**：答案是 `{answers: [{id, selected[], custom?}]}`，选项是动态数组，
 *   可能多选、可能多题、可能允许自由输入。
 *
 * 如果各写一套队列，就要维护两套超时、两套编号、两套"回复该落到哪"。
 * 而且用户看到的是同一个界面：**引用某条消息，回一个数字**。
 *
 * 所以这里统一成"一条待回复 = 一张选项表 + 一个 resolver"：
 *   - 推送时把选项表存下（用户看到的是它的渲染结果）
 *   - 用户回数字时按表查（不猜、不越界）
 *   - 查到了就把对应值交给 resolver，队列移除
 *
 * ## 编号会复用，所以必须按"当前在册"校验
 *
 * 编号到 99 回卷，超时也会回收。一个迟到的旧回复可能命中新请求——
 * 那是**用旧意图批准新操作**，属于最危险的一类错误。
 * 所以只认当前在册的编号，不在册就明确说"没有这条"。
 */

/**
 * @typedef {object} PendingEntry
 * @property {string} id
 * @property {'approval'|'question'} kind
 * @property {string} title
 * @property {Array<{key: string, label: string, detail?: string}>} choices
 * @property {boolean} multiSelect
 * @property {string} preview     展示用摘要（工具名 / 第一个问题）
 * @property {number} createdAt
 * @property {NodeJS.Timeout} timer
 * @property {(v: any) => void} resolve
 */

export class PendingQueue {
  /**
   * @param {object} o
   * @param {number} o.timeoutMs 单条等待上限
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.timeoutMs = o.timeoutMs;
    this.now = o.now ?? (() => Date.now());
    /** @type {Map<string, PendingEntry>} */
    this.entries = new Map();
    /** 自增编号；到 99 回卷，够用且好念 */
    this.nextNo = 1;
    /**
     * 两位数编号全部在册时的溢出号。
     *
     * 99 个编号同时挂起是极端情况，但一旦发生就**不能**再回卷：
     * 覆盖掉一个还在等回答的条目，等于两条审批一起坏掉。宁可编号长一点。
     */
    this.nextOverflowNo = 100;
  }

  /**
   * 取下一个编号（99 之后回卷到 1）。
   *
   * ## 为什么必须跳过**当前在册**的编号
   *
   * 回卷本身是设计的一部分：编号回收后复用，用户看到的仍是两位数。
   * 危险的是回卷到一个**还没结算**的编号 —— `enqueue` 会直接
   * `entries.set(id, newEntry)` 覆盖对方：
   *
   *   · 被覆盖那条的 Promise 永远悬着（没人再能 resolve 它）；
   *   · 它的定时器到点后删掉的是**新**条目的登记，
   *     于是新卡片在用户还没回答时就被判成超时。
   *
   * 编号是否在册是队列自己就知道的事实，所以这里按在册校验，
   * 而不是指望"用户不会同时挂 98 条"。
   *
   * @returns {string}
   */
  allocId() {
    for (let i = 0; i < 99; i += 1) {
      const id = String(this.nextNo);
      this.nextNo = this.nextNo >= 99 ? 1 : this.nextNo + 1;
      if (!this.entries.has(id)) return id;
    }
    const id = String(this.nextOverflowNo);
    this.nextOverflowNo += 1;
    return id;
  }

  /**
   * 登记一条待回复，返回编号和结算 Promise。
   *
   * ## 为什么要把编号交出去
   *
   * 光有 Promise 时，调用方只能"等结果"，没法**主动结束**它：
   * DSH 桌面端先回答了，QQ 这条就该撤销，但调用方不知道要撤销哪一条。
   * 把编号一起返回，撤销就有据可依（见 withdraw）。
   *
   * @param {object} spec
   * @param {'approval'|'question'} spec.kind
   * @param {string} spec.title
   * @param {Array<{key: string, label: string, detail?: string}>} spec.choices
   * @param {boolean} [spec.multiSelect]
   * @param {string} [spec.preview]
   * @param {(entry: PendingEntry) => void} [spec.onPush] 推送回调（失败不影响等待）
   * @returns {{id: string, promise: Promise<{status: 'answered', value: any} | {status: 'timeout'} | {status: 'withdrawn', reason: string} | {status: 'cancelled'}>}}
   */
  enqueue(spec) {
    const id = this.allocId();
    const promise = new Promise((resolve) => {
      /** @type {PendingEntry} */
      const entry = {
        id,
        kind: spec.kind,
        title: spec.title,
        choices: spec.choices,
        multiSelect: spec.multiSelect === true,
        preview: String(spec.preview ?? ''),
        createdAt: this.now(),
        timer: /** @type {any} */ (null),
        resolve: (v) => {
          const settled = this.entries.get(id);
          if (settled) {
            clearTimeout(settled.timer);
            this.entries.delete(id);
          }
          resolve(v);
        },
      };
      entry.timer = setTimeout(() => {
        // 超时不是拒绝：用户可能只是没看手机。交给上层按策略处理。
        if (this.entries.delete(id)) resolve({ status: 'timeout' });
      }, this.timeoutMs);

      this.entries.set(id, entry);

      // 推送失败不等于等待失败：可能只是 QQ 没连上，
      // 那也应该等超时，而不是立刻给出一个假结论。
      try {
        spec.onPush?.(entry);
      } catch {
        /* 忽略：推送是尽力而为 */
      }
    });

    return { id, promise };
  }

  /**
   * 登记一条待回复，只取结算 Promise。
   *
   * 保留这个入口是因为大多数调用方只关心"等到什么"；
   * 需要撤销的调用方用 enqueue 拿编号。
   *
   * @param {object} spec 同 enqueue
   * @returns {Promise<{status: 'answered', value: any} | {status: 'timeout'} | {status: 'withdrawn', reason: string} | {status: 'cancelled'}>}
   */
  wait(spec) {
    return this.enqueue(spec).promise;
  }

  /**
   * 撤销一条在册的待回复（另一端已经处理了）。
   *
   * 结算成 `withdrawn` 而不是 `cancelled`：两者对调用方的含义不同——
   * `cancelled` 是"这次请求被撤了，当作没发生"，
   * `withdrawn` 是"别人已经答过了，你这边别再等"。
   *
   * @param {string} id
   * @param {string} [reason] 撤销来源（协议里目前只有 'desktop'）
   * @returns {{ok: boolean, error?: string}}
   */
  withdraw(id, reason) {
    const e = this.entries.get(String(id));
    if (!e) return { ok: false, error: `没有编号为 ${id} 的待回复（可能已回答或超时）` };
    // reason 缺省按 desktop：目前只有 DSH 桌面端会主动撤销。
    // 不硬编码空串，是为了让调用方能从结论里看出"谁撤的"。
    e.resolve({ status: 'withdrawn', reason: String(reason ?? '').trim() || 'desktop' });
    return { ok: true };
  }

  /** 取一条在册记录（不存在返回 undefined） */
  get(id) {
    return this.entries.get(String(id));
  }

  /** 当前在册的编号列表 */
  ids() {
    return [...this.entries.keys()];
  }

  /** 当前在册的全部记录（给"有什么卡着"用） */
  list() {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      preview: e.preview,
      choices: e.choices,
      multiSelect: e.multiSelect,
      createdAt: e.createdAt,
    }));
  }

  /**
   * 用编号结算一条。
   *
   * `value` 由调用方按 kind 决定形状（审批给字符串，提问给结构化答案）。
   *
   * @param {string} id
   * @param {any} value
   * @returns {{ok: boolean, error?: string}}
   */
  settle(id, value) {
    const e = this.entries.get(String(id));
    if (!e) return { ok: false, error: `没有编号为 ${id} 的待回复（可能已超时）` };
    e.resolve({ status: 'answered', value });
    return { ok: true };
  }

  /** 全部按"取消"结算（插件卸载时用） */
  cancelAll() {
    for (const e of [...this.entries.values()]) {
      e.resolve({ status: 'cancelled' });
    }
    this.entries.clear();
  }
}
