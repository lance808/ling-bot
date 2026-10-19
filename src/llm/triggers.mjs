/**
 * 触发判定 —— F7
 *
 * 决定"这条消息要不要让它说话"。分成强/弱两类，因为并发策略不同：
 *
 *   强触发（@ / 点名 / 私聊）  排队 —— 不能用"忙"当借口把人晾着
 *   弱触发（关键词 / 概率唤醒） 丢弃并记一行 —— 不值得为一个可能无关的插话排队
 *
 * ## 概率唤醒的三重护栏（缺一不可）
 *
 *   1. 该会话最近 30 分钟内有真人说话（冷群绝不主动开口）
 *   2. 同一会话两次主动发言间隔 ≥ 30 分钟（硬下限，不按概率）
 *   3. 主动回合的用量打 proactive:true（钱要看得见）
 *
 * 第 1、2 条是"能不能"，第 3 条是"记账"。前两条任意一条不过，**连掷骰子都不掷**——
 * 否则概率就被稀释成了"看起来设了 0.1 其实永远不触发"，那比不设更坏。
 */

/**
 * @typedef {object} TriggerConfig
 * @property {boolean} enabled
 * @property {string[]} keywords
 * @property {number} probability
 * @property {number} minIntervalMs
 * @property {number} activeWindowMs
 * @property {number} autoTurnPerMinute
 */

/** 默认配置与 DEFAULT_CONFIG 保持一致 */
const DEFAULTS = {
  probability: 0.1,
  minIntervalMs: 1_800_000, // 30 分钟
  activeWindowMs: 1_800_000, // 30 分钟
  autoTurnPerMinute: 1,
};

/**
 * @typedef {object} ConversationState
 * @property {number | null} lastHumanAt 最近一次真人发言时间
 * @property {number | null} lastProactiveAt 最近一次主动发言时间
 * @property {number | null} lastAutoTurnAt 最近一次自动回合时间
 */

export const TRIGGER = Object.freeze({
  NONE: 'none',
  AT: 'at',
  NAME: 'name',
  KEYWORD: 'keyword',
  PRIVATE: 'private',
  PROBABILITY: 'probability',
  COMMAND: 'command',
});

/** 强触发：值得排队等当前回合结束 */
const STRONG = new Set([TRIGGER.AT, TRIGGER.NAME, TRIGGER.PRIVATE, TRIGGER.COMMAND]);

/**
 * @param {string} trigger
 * @returns {boolean}
 */
export function isStrongTrigger(trigger) {
  return STRONG.has(trigger);
}

/**
 * 判断一条消息是否构成触发。
 *
 * 注意：这个函数**不做概率判定**（概率是掷骰子，放在 decideProactive 里），
 * 也只对「是否应该考虑让机器人说话」负责，不负责授权。
 *
 * @param {object} msg 归一化后的消息事件
 * @param {object} opts
 * @param {string} [opts.selfId]
 * @param {string} [opts.selfName]
 * @param {TriggerConfig} [opts.config]
 * @returns {{trigger: string, reason: string} | null}
 */
export function detectTrigger(msg, opts = {}) {
  if (!msg || msg.kind !== 'message') return null;

  // 私聊：永远算强触发（有人专门找你）
  if (!msg.isGroup) {
    return { trigger: TRIGGER.PRIVATE, reason: '私聊消息' };
  }

  // @机器人
  if (msg.atSelf) return { trigger: TRIGGER.AT, reason: '被 @' };

  const text = String(msg.text ?? '');

  // 叫名字
  const name = opts.selfName?.trim();
  if (name && text.includes(name)) {
    return { trigger: TRIGGER.NAME, reason: `提到了名字「${name}」` };
  }

  // 关键词
  const keywords = opts.config?.keywords ?? [];
  for (const kw of keywords) {
    if (kw && text.includes(kw)) return { trigger: TRIGGER.KEYWORD, reason: `命中关键词「${kw}」` };
  }

  return null;
}

/**
 * 概率唤醒判定（含三重护栏中的前两条）。
 *
 * 返回 `null` 表示"不主动"，返回对象表示"要主动"。
 * **宁可少说，不要多说**——这是产品判断，不是技术限制。
 *
 * @param {object} input
 * @param {ConversationState} input.state
 * @param {boolean} input.isGroup
 * @param {TriggerConfig} input.config
 * @param {number} [input.now]
 * @param {() => number} [input.random] 可注入，便于测试
 * @returns {{trigger: string, reason: string} | null}
 */
export function decideProactive(input) {
  const cfg = { ...DEFAULTS, ...input.config };
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const state = input.state ?? {};

  // 护栏 0：主动发言不适用于私聊（私聊里主动戳人属骚扰，F7 边界）
  if (!input.isGroup) return null;

  // 护栏 1：冷群不开口 —— 最近 30 分钟内必须有真人说过话
  if (!state.lastHumanAt) return null;
  if (now - state.lastHumanAt > cfg.activeWindowMs) return null;

  // 护栏 2：同一会话两次主动发言间隔 ≥ 30 分钟（硬下限，不看概率）
  if (state.lastProactiveAt && now - state.lastProactiveAt < cfg.minIntervalMs) return null;

  // 每会话每分钟最多 1 次自动回合（防互相对喷）
  if (state.lastAutoTurnAt && now - state.lastAutoTurnAt < 60_000 / Math.max(1, cfg.autoTurnPerMinute)) {
    return null;
  }

  // 三道护栏都过了，才掷骰子
  if (random() >= cfg.probability) return null;

  return { trigger: TRIGGER.PROBABILITY, reason: `概率唤醒（p=${cfg.probability}）` };
}

/**
 * 会话级触发状态簿。
 *
 * 只放在内存：重启后"上次主动发言时间"清零，最坏结果是最多重启后多说一句，
 * 比把时间戳写盘写坏要安全。（若将来要持久化，走 atomicWrite。）
 */
export class TriggerLedger {
  /** @type {Map<string, ConversationState>} */
  #state = new Map();

  /** @param {string} convKey */
  #get(convKey) {
    let s = this.#state.get(convKey);
    if (!s) {
      s = { lastHumanAt: null, lastProactiveAt: null, lastAutoTurnAt: null };
      this.#state.set(convKey, s);
    }
    return s;
  }

  /**
   * 记一次真人发言。
   *
   * @param {string} convKey
   * @param {number} [at]
   */
  noteHuman(convKey, at = Date.now()) {
    this.#get(convKey).lastHumanAt = at;
  }

  /**
   * @param {string} convKey
   * @param {number} [at]
   */
  noteProactive(convKey, at = Date.now()) {
    const s = this.#get(convKey);
    s.lastProactiveAt = at;
    s.lastAutoTurnAt = at;
  }

  /**
   * @param {string} convKey
   * @param {number} [at]
   */
  noteAutoTurn(convKey, at = Date.now()) {
    this.#get(convKey).lastAutoTurnAt = at;
  }

  /**
   * @param {string} convKey
   * @returns {ConversationState}
   */
  snapshot(convKey) {
    return { ...this.#get(convKey) };
  }

  /** 供测试与「清空」用 */
  clear(convKey) {
    if (convKey) this.#state.delete(convKey);
    else this.#state.clear();
  }
}
