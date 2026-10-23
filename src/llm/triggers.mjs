/**
 * 触发判定 —— F7
 *
 * 决定"这条消息要不要让它说话"。分成强/弱两类，因为并发策略不同：
 *
 *   强触发（@ / 点名 / 私聊 / 指定群友）  排队 —— 不能用"忙"当借口把人晾着
 *   弱触发（关键词 / 概率 / 提问 / 拍一拍） 丢弃并记一行 —— 不值得为可能无关的插话排队
 *
 * ## ⚠️ 「唤醒」在本项目里的含义
 *
 * 参考项目 qq-bridge 是「AI 自主潜水」模型：AI 决定何时睡，桥接按条件把它叫醒。
 * **Ling-bot 不是这个模型**。它是「收到一条消息 → 判定它够不够格起一个对话回合」。
 *
 * 所以「唤醒设置」在这里的正确映射是：
 *
 *   参考项目的「潜水时长」   → 两次主动发言之间的最小间隔（minSleepMs）
 *   参考项目的「唤醒频率」   → 每会话每分钟/每小时最多起几个回合
 *   参考项目的「唤醒条件」   → detectTrigger 的各个开关
 *
 * 这不是改名，是**语义不同**：那边是 AI 主动睡/被叫醒，这边是消息驱动。
 * 照抄那边的实现会做出一个"机器人自己决定什么时候不说话"的东西，
 * 而这里要的是"什么消息值得回应"。
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
 * @property {boolean} [enabled]
 * @property {string[]} [keywords]
 * @property {number} [probability]
 * @property {number} [minIntervalMs]
 * @property {number} [activeWindowMs]
 * @property {number} [autoTurnPerMinute]
 */

/**
 * @typedef {object} WakeConfig
 * @property {boolean} [atMention]      被 @ / 引用时触发
 * @property {boolean} [nameMention]    文本里出现名字
 * @property {boolean} [question]       被直接提问
 * @property {boolean} [poke]           拍一拍
 * @property {string[]} [speakerIds]    这些群友发言即触发
 * @property {string[]} [keywords]      关键词
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
 * @property {number} [proactiveCount] 累计主动发言次数
 */

export const TRIGGER = Object.freeze({
  NONE: 'none',
  AT: 'at',
  NAME: 'name',
  KEYWORD: 'keyword',
  PRIVATE: 'private',
  PROBABILITY: 'probability',
  COMMAND: 'command',
  /** 被直接提问（"这是什么"这种，不是每句都算） */
  QUESTION: 'question',
  /** 有人拍一拍 */
  POKE: 'poke',
  /** 指定的群友发言（想等某个人时用） */
  SPEAKER: 'speaker',
});

/**
 * 强触发：值得排队等当前回合结束。
 *
 * ## 为什么拍一拍是弱的
 *
 * 拍一拍是很轻的动作（"嘿"、"在吗"），没有具体内容。让它插队排在
 * 一个正在认真回答的回合前面，代价远大于收益 —— 而且群里常有连环互拍。
 * 它够格"让它看一眼"，但不够格"停下手上的事"。
 *
 * ## 为什么指定群友是强的
 *
 * 用户显式配置了"等这个人说话"，说明那条消息对他有确定的重要性。
 * 这和 @ 是同一级别的意图。
 */
const STRONG = new Set([TRIGGER.AT, TRIGGER.NAME, TRIGGER.PRIVATE, TRIGGER.COMMAND, TRIGGER.SPEAKER]);

/**
 * @param {string} trigger
 * @returns {boolean}
 */
export function isStrongTrigger(trigger) {
  return STRONG.has(trigger);
}

/**
 * 提问判定的特征。
 *
 * ## 为什么要做得保守
 *
 * 群里"今天好热"、"哈哈哈"这类话占绝大多数，它们都不是问句。
 * 如果把提问判定做宽（比如只要出现"什么"就算），一个活跃群会变成
 * 每一句都触发 —— 那比不触发更糟：机器人会变成刷屏的噪音源。
 *
 * 所以这里只认**明确的问句信号**：问号，或者句尾的疑问助词。
 * 中间出现的"什么"不算（"我什么都不想吃"不是问句）。
 */
const QUESTION_TAIL_RE = /(吗|呢|么|吧|嘛)[?？]?$/;
const QUESTION_MARK_RE = /[?？]/;

/**
 * 疑问词开头的典型问句（"怎么弄"、"为什么"、"能不能"…）。
 *
 * 这些词出现在**句首或句尾**才算信号，出现在中间不算 ——
 * 见上面 QUESTION_TAIL_RE 的说明。
 */
const QUESTION_LEAD_RE = /^(怎么|为什么|为何|如何|什么|哪个|哪里|哪儿|谁|多少|几时|能不能|可不可以|是不是|有没有|要不要)/;

/**
 * 判断一句话是不是"在问"。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeQuestion(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  // 问号最可靠，直接算
  if (QUESTION_MARK_RE.test(s)) return true;
  // 句尾的疑问助词
  if (QUESTION_TAIL_RE.test(s)) return true;
  // 疑问词开头：只在**句子较短**时认（长句里"我什么都不想吃"不该触发）
  if (s.length <= 20 && QUESTION_LEAD_RE.test(s)) return true;
  return false;
}

/**
 * 判断一条消息是否构成触发。
 *
 * 注意：这个函数**不做概率判定**（概率是掷骰子，放在 decideProactive 里），
 * 也只对「是否应该考虑让机器人说话」负责，不负责授权。
 *
 * ## 每个开关都是硬开关
 *
 * 关掉就是**不触发**，不存在"关掉之后走默认值"。这个语义很重要：
 * 用户关掉「提问唤醒」是因为他不想被每句问话叫醒，
 * 如果关掉还按别的规则触发，那这个开关就是假的。
 *
 * @param {object} msg 归一化后的消息事件
 * @param {object} opts
 * @param {string} [opts.selfId]
 * @param {string} [opts.selfName]
 * @param {TriggerConfig} [opts.config] 主动发言配置（含 keywords）
 * @param {WakeConfig} [opts.wake] 唤醒开关配置
 * @returns {{trigger: string, reason: string} | null}
 */
export function detectTrigger(msg, opts = {}) {
  if (!msg || msg.kind !== 'message') return null;

  const wake = opts.wake ?? {};
  /*
   * 开关的默认值：**没给配置时全部按开启处理**。
   *
   * 为什么默认开：老配置里根本没有 wake 这一块，如果默认关，
   * 升级后所有人的 @ 都不再触发 —— 那是比不加功能更坏的结果。
   * 显式写 false 才关。
   */
  const on = (key) => wake[key] !== false;

  // 私聊：永远算强触发（有人专门找你）
  if (!msg.isGroup) {
    return { trigger: TRIGGER.PRIVATE, reason: '私聊消息' };
  }

  // @机器人
  if (msg.atSelf) {
    if (!on('atMention')) return null;
    return { trigger: TRIGGER.AT, reason: '被 @' };
  }

  const text = String(msg.text ?? '');

  // 叫名字
  const name = opts.selfName?.trim();
  if (name && text.includes(name)) {
    if (!on('nameMention')) return null;
    return { trigger: TRIGGER.NAME, reason: `提到了名字「${name}」` };
  }

  /*
   * 指定的群友发言。
   *
   * 放在关键词之前：用户显式点了名的人比关键词更精确，
   * 日志里写"等的人在说话"比"命中关键词"更有解释力。
   */
  const speakerIds = Array.isArray(wake.speakerIds) ? wake.speakerIds : [];
  if (speakerIds.length > 0) {
    const from = String(msg.sender?.userId ?? '');
    if (from && speakerIds.some((id) => String(id) === from)) {
      return { trigger: TRIGGER.SPEAKER, reason: '指定群友发言' };
    }
  }

  // 关键词
  const keywords = wake.keywords ?? opts.config?.keywords ?? [];
  for (const kw of keywords) {
    if (kw && text.includes(kw)) {
      if (!on('keywords')) return null;
      return { trigger: TRIGGER.KEYWORD, reason: `命中关键词「${kw}」` };
    }
  }

  // 被提问
  if (looksLikeQuestion(text)) {
    if (!on('question')) return null;
    return { trigger: TRIGGER.QUESTION, reason: '看起来是在提问' };
  }

  return null;
}

/**
 * 拍一拍的触发判定。
 *
 * 单独一个函数是因为拍一拍是 `notice` 事件，不是 `message` ——
 * 它没有正文，`detectTrigger` 的整条路径都不适用。
 *
 * @param {object} pokeEvt
 * @param {{selfId?: string, wake?: WakeConfig}} opts
 * @returns {{trigger: string, reason: string} | null}
 */
export function detectPokeTrigger(pokeEvt, opts = {}) {
  if (!pokeEvt || pokeEvt.kind !== 'poke') return null;
  if (opts.wake?.poke === false) return null;

  // 拍的是自己才算"叫我"；别人互拍不该触发
  const self = String(opts.selfId ?? '').trim();
  if (!self) return null;
  if (String(pokeEvt.target ?? '') !== self) return null;

  return { trigger: TRIGGER.POKE, reason: '被拍一拍' };
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
 * 唤醒频率账本。
 *
 * ## 为什么需要单独一个账本
 *
 * `TriggerLedger` 管的是"主动发言的间隔"，那是**它自己想说话**的节奏。
 * 这里管的是"因为别人的消息起回合"的节奏，是两件不同的事：
 *
 *   · 一个活跃群每分钟几十条消息，每条都起回合 = 刷屏 + 烧钱
 *   · 而且回合跑得比消息慢，队列会越堆越长，回复越来越滞后
 *
 * 所以按会话限制每分钟/每小时最多起几个回合。超限时**不触发**
 * （而不是排队），因为排队的意义是"稍后回复"，而这里的问题是"不该回"。
 *
 * ## 为什么用滑动窗口而不是固定桶
 *
 * 固定桶（"第 3 分钟的第 1 秒"这种）会出现边界突刺：
 * 两个桶交界处可以瞬间放行两倍的数量。滑动窗口没有这个问题，
 * 代价只是每次要多筛几个时间戳 —— 数量很小，无所谓。
 */
export class WakeLedger {
  /** @type {Map<string, {minute: number[], hour: number[]}>} */
  #state = new Map();
  /** @type {() => number} */
  #now;

  /** @param {{now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.#now = typeof opts.now === 'function' ? opts.now : Date.now;
  }

  /**
   * 检查还能不能再起一个回合。**只检查，不记账**。
   *
   * @param {string} convKey
   * @param {{maxPerMinute?: number, maxPerHour?: number}} limits
   * @returns {{ok: true} | {ok: false, code: string, message: string, retryAfterMs: number}}
   */
  check(convKey, limits = {}) {
    const now = this.#now();
    const s = this.#get(convKey);
    this.#sweep(s, now);

    const maxMin = Number.isFinite(limits.maxPerMinute) ? Math.max(0, Math.round(Number(limits.maxPerMinute))) : 0;
    const maxHour = Number.isFinite(limits.maxPerHour) ? Math.max(0, Math.round(Number(limits.maxPerHour))) : 0;

    /*
     * 上限为 0 表示**不限制**，而不是"一次都不许"。
     * 这是配置界面的直觉：用户把"每分钟最多"清成 0 的意思是"我不管"，
     * 如果他真想让机器人闭嘴，该关掉 wake 总开关，而不是设成 0。
     */
    if (maxMin > 0 && s.minute.length >= maxMin) {
      const oldest = s.minute[0] ?? now;
      return {
        ok: false,
        code: 'E2040',
        message: `唤醒太频繁（每分钟上限 ${maxMin}）`,
        retryAfterMs: Math.max(0, 60_000 - (now - oldest)),
      };
    }
    if (maxHour > 0 && s.hour.length >= maxHour) {
      const oldest = s.hour[0] ?? now;
      return {
        ok: false,
        code: 'E2040',
        message: `唤醒太频繁（每小时上限 ${maxHour}）`,
        retryAfterMs: Math.max(0, 3_600_000 - (now - oldest)),
      };
    }
    return { ok: true };
  }

  /**
   * 记一次回合。
   *
   * @param {string} convKey
   * @param {number} [at]
   */
  note(convKey, at) {
    const now = Number.isFinite(at) ? /** @type {number} */ (at) : this.#now();
    const s = this.#get(convKey);
    s.minute.push(now);
    s.hour.push(now);
    this.#sweep(s, now);
  }

  /**
   * 检查并记账（一步到位，供调用方少写一行）。
   *
   * @param {string} convKey
   * @param {{maxPerMinute?: number, maxPerHour?: number}} limits
   * @returns {{ok: true} | {ok: false, code: string, message: string, retryAfterMs: number}}
   */
  checkAndNote(convKey, limits = {}) {
    const r = this.check(convKey, limits);
    if (r.ok) this.note(convKey);
    return r;
  }

  /** 快照（界面展示"这一分钟还剩几次"） */
  snapshot(convKey) {
    const now = this.#now();
    const s = this.#get(convKey);
    this.#sweep(s, now);
    return { lastMinute: s.minute.length, lastHour: s.hour.length };
  }

  clear(convKey) {
    if (convKey) this.#state.delete(convKey);
    else this.#state.clear();
  }

  /** @param {string} convKey */
  #get(convKey) {
    let s = this.#state.get(convKey);
    if (!s) {
      s = { minute: [], hour: [] };
      this.#state.set(convKey, s);
    }
    return s;
  }

  /**
   * 丢掉窗口外的记录。
   *
   * @param {{minute: number[], hour: number[]}} s
   * @param {number} now
   */
  #sweep(s, now) {
    const minCut = now - 60_000;
    const hourCut = now - 3_600_000;
    while (s.minute.length > 0 && (s.minute[0] ?? now) <= minCut) s.minute.shift();
    while (s.hour.length > 0 && (s.hour[0] ?? now) <= hourCut) s.hour.shift();
  }
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
    /*
     * 真实累加主动发言次数。
     *
     * 之前界面读 `proactiveCount`，而后端根本没有这个字段 ——
     * 那一列恒为 0，看起来像"功能正常、只是还没触发过"。
     *
     * 计数放在 noteProactive 里而不是界面自己算：界面的快照是 2 秒一次的
     * 采样，它没有任何办法从若干次采样中"数出"发生过几次。
     */
    s.proactiveCount = (s.proactiveCount ?? 0) + 1;
  }

  /**
   * @param {string} convKey
   * @param {number} [at]
   */
  noteAutoTurn(convKey, at = Date.now()) {
    this.#get(convKey).lastAutoTurnAt = at;
  }

  /**
   * 读某个会话的触发状态。
   *
   * ## 为什么用 `.get` 而不是 `#get`
   *
   * `#get` 是"读时创建"——没这个会话就建一个空的。那对**写入**是对的
   * （要往上面记东西），但对**读取**是错的：快照会遍历所有已知会话调它，
   * 于是一个从没活跃过、只是被扫到的 convKey 就会在内存里永久留个空壳。
   *
   * 所以读的时候用 `.get`，没有就返回一份全 null 的默认值（形状不变，
   * 界面不用再判空），但**不写回 Map**。
   *
   * @param {string} convKey
   * @returns {ConversationState}
   */
  snapshot(convKey) {
    const s = this.#state.get(convKey);
    if (!s) {
      return {
        lastHumanAt: null,
        lastProactiveAt: null,
        lastAutoTurnAt: null,
        proactiveCount: 0,
      };
    }
    return { ...s };
  }

  /** 当前有状态记录的会话数（供诊断，不创建新记录） */
  size() {
    return this.#state.size;
  }

  /**
   * 某个会话**现在**的主动发言可用性。
   *
   * ## 为什么这个比"主动发言次数"有用
   *
   * 用户真正的困惑是「它刚才为什么不说话 / 什么时候才肯说话」。
   * 累计次数回答不了这个问题 —— 看到 12 次既不知道是不是正常，
   * 也不知道现在能不能主动。
   *
   * 而"还要等多久"是直接的：命中冷却就说还剩几分钟，
   * 冷群就说群太安静了。
   *
   * 判定顺序与 `decideProactive` **必须一致**，否则界面说的和实际做的
   * 会是两回事 —— 那是比不显示更糟的。
   *
   * @param {string} convKey
   * @param {import('./triggers.mjs').TriggerConfig} config
   * @param {boolean} isGroup
   * @param {number} [now]
   * @returns {{ready: boolean, reason: string, retryAfterMs: number | null}}
   */
  proactiveStatus(convKey, config = {}, isGroup = true, now = Date.now()) {
    const cfg = { ...DEFAULTS, ...config };
    const s = this.snapshot(convKey);

    // 与 decideProactive 的护栏 0 对齐
    if (!isGroup) {
      return { ready: false, reason: '私聊不主动发言', retryAfterMs: null };
    }

    // 护栏 1：冷群不开口
    if (!s.lastHumanAt) {
      return { ready: false, reason: '还没有真人发言', retryAfterMs: null };
    }
    const sinceHuman = now - s.lastHumanAt;
    if (sinceHuman > cfg.activeWindowMs) {
      return {
        ready: false,
        reason: '群已经安静太久了',
        retryAfterMs: null,
      };
    }

    // 护栏 2：两次主动发言的硬间隔
    if (s.lastProactiveAt) {
      const sinceProactive = now - s.lastProactiveAt;
      if (sinceProactive < cfg.minIntervalMs) {
        return {
          ready: false,
          reason: '距上次主动还不够久',
          retryAfterMs: cfg.minIntervalMs - sinceProactive,
        };
      }
    }

    // 护栏 3：自动回合节流
    if (s.lastAutoTurnAt) {
      const gap = 60_000 / Math.max(1, cfg.autoTurnPerMinute);
      const sinceAuto = now - s.lastAutoTurnAt;
      if (sinceAuto < gap) {
        return { ready: false, reason: '自动回合节流中', retryAfterMs: gap - sinceAuto };
      }
    }

    /*
     * 到这里说明三道护栏都过了，只剩概率。
     *
     * **ready 仍然是 false** —— 因为还没有掷骰子，不能保证会说。
     * 报 true 会让用户以为"它马上就会说话"，而实际上按 10% 概率
     * 大部分时候不动。这是刻意的：宁可说"可以，但看概率"，
     * 也不要给出一个兑现不了的承诺。
     */
    return {
      ready: false,
      reason: `护栏都过了，按 ${Math.round(cfg.probability * 100)}% 概率决定`,
      retryAfterMs: null,
      rollable: true,
    };
  }

  /** 供测试与「清空」用 */
  clear(convKey) {
    if (convKey) this.#state.delete(convKey);
    else this.#state.clear();
  }
}
