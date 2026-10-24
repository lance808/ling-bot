/**
 * 人工确认登记表 —— **唯一**决定「一条 1/2 回复该落到哪个请求」的地方
 *
 * ## 它修的是什么
 *
 * 原来的实现把所有待确认请求放进一个全局 `Map`，然后用一张
 * 「序号 → 请求」的表来认回复。这有三处结构性问题：
 *
 *   1. **不认人**：谁回「1」都算数。群里任何人、任何私聊里任何人，
 *      只要恰好有一条第 N 条待确认，就能把它批掉。
 *   2. **不认会话**：A 私聊里的确认卡，B 在另一个私聊里回「1」也会命中。
 *   3. **不认引用**：卡片上写了「引用这条消息回数字」，但真正结算时
 *      只看序号 —— 引用被完全忽略，于是"引用 A 回 1"可能批了 B。
 *
 * 现在每条请求在**登记那一刻**就把自己的全部上下文钉死：
 *
 *   | 绑什么 | 字段 | 为什么要绑 |
 *   | --- | --- | --- |
 *   | 允许处理的身份 | `allowedSenders` | 谁有资格点头 |
 *   | 会话归属 | `replyConvKey` | 回复必须来自卡片所在的会话 |
 *   | 推送消息 ID | `messageIds` | 引用回复靠它精确定位，不靠猜 |
 *   | 有效期 | `createdAt` / `expiresAt` | 过期请求不能被迟到的回复翻案 |
 *   | 请求 ID | `id` | 桌面端与 QQ 端结算同一条 |
 *   | 结算状态 | `settled` | 只能结算一次 |
 *
 * ## 引用优先，且未知引用**必须交回**
 *
 * 用户引用了某条消息，那条消息就是**唯一**的意图表达。所以：
 *
 *   - 引用命中本表 → 只认那一条，绝不"顺便"落到别的待确认上；
 *   - 引用不在本表 → **不是这个入口的事**，返还给调用方（通常是插件），
 *     由它自己判断。这里绝不退化成"按当前待确认数量猜一个"。
 *
 * 后者是授权边界：DSH 的审批卡和这里的确认卡长得一样（都是引用回数字），
 * 抢走一条不属于自己的引用，等于用 A 的点头批准了 B 的操作。
 *
 * ## 不带引用时为什么要求"恰好一条"
 *
 * 「1」和「2」在聊天里是极普通的字符（"2 点了"）。所以裸数字只在
 * **当前会话 + 当前这个人**名下有且仅有 1 条可处理请求时才认。
 * 两条以上必须引用 —— 猜错对象是这里最危险的错误。
 *
 * 本模块不读配置文件、不发消息、不写日志：它只做状态机与判定，
 * 所以能在纯 Node 下穷举并发、过期、重复回复与双端竞争。
 */

/** 单次确认的等待上限。超时按**拒绝**处理（fail-closed）。 */
export const CONFIRM_TIMEOUT_MS = 60_000;

/** 同时挂起的上限。超过就不再受理 —— 无限增长等于把内存交给用户点。 */
const DEFAULT_MAX_ENTRIES = 50;

/** 消息 ID → 请求 的映射上限（推送过的卡片数，正常远小于它）。 */
const DEFAULT_MAX_MESSAGES = 200;

/**
 * 结算状态。
 *
 * `cancelled` 与 `timeout` 分开记：对排查来说它们完全不同 ——
 * 一个是程序退出/插件停用，一个是用户没看手机。
 */
export const SETTLE_REASON = Object.freeze({
  USER: 'user',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  CONSOLE: 'console',
  SHUTDOWN: 'shutdown',
});

/**
 * 把 OneBot 的 message_id 归一成字符串。
 *
 * 上游可能给数字、字符串、负数、甚至 null。不统一的话，
 * `msgIndex.get(number)` 与 `msgIndex.get(string)` 会得到两个答案，
 * 而症状是"引用明明存在却说没有这条"。
 *
 * @param {unknown} value
 * @returns {string} 无效时返回空串
 */
export function normalizeMessageId(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s || s === 'undefined' || s === 'null') return '';
  return s;
}

/**
 * 回复文本 → 「同意 / 拒绝 + 可选的定位信息」。
 *
 * 接受三种写法，全部落到"同意/拒绝"：
 *
 *   `1` / `2`                  —— 卡片上的主路径（不带定位，靠上下文唯一）
 *   `同意` / `拒绝`             —— 习惯打字的用户（同样靠上下文唯一）
 *   `同意 1` / `拒绝 #confirm-…` —— 显式指定序号或请求 ID
 *
 * 返回 `null` 表示这条文本**不是**确认回复，调用方应原样放行。
 *
 * @param {unknown} raw
 * @returns {{ allow: boolean } & ({ seq: number } | { id: string } | {}) | null}
 */
export function parseConfirmReply(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 裸数字：只有 1 / 2 有意义。3 以上不猜（可能是"3 点了"）
  if (text === '1') return { allow: true };
  if (text === '2') return { allow: false };

  /*
   * 文字形式。
   *
   * 分隔符吃三种：空格、`#`、中文顿号。用户抄卡片时常常多打一个空格，
   * 而多一个空格就认不出来的话，表现是"我明明回了它没反应"。
   */
  const m = /^(同意|拒绝|允许|取消)\s*[#＃]?\s*(\d+|confirm-[0-9a-z-]+)?$/i.exec(text);
  if (!m) return null;

  const allow = m[1] === '同意' || m[1] === '允许';
  const where = m[2];
  if (where === undefined) return { allow };
  if (/^\d+$/.test(where)) return { allow, seq: Number(where) };
  return { allow, id: where };
}

/**
 * 一次结算的结论。
 *
 * @typedef {object} SettleResult
 * @property {boolean} ok          是否真的完成了结算
 * @property {boolean} handled     这条消息是否属于本入口（false = 交回调用方）
 * @property {string} [code]
 * @property {string} [message]
 * @property {string} [id]
 * @property {number} [seq]
 * @property {'allow'|'deny'} [outcome]
 * @property {'unknown-quote'|'duplicate'|'expired'|'forbidden'|'wrong-session'|'ambiguous'|'unknown-id'} [reason]
 */

export class ConfirmRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {() => number} [opts.now] 注入时钟，便于在测试里把时间拨到过期之后
   * @param {number} [opts.maxEntries]
   * @param {number} [opts.maxMessages]
   * @param {(info: object) => void} [opts.onTimeout] 超时回调（宿主用来通知桌面端）
   */
  constructor(opts = {}) {
    this.timeoutMs =
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) : CONFIRM_TIMEOUT_MS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    this.maxMessages =
      Number.isInteger(opts.maxMessages) && opts.maxMessages > 0 ? opts.maxMessages : DEFAULT_MAX_MESSAGES;
    this.onTimeout = typeof opts.onTimeout === 'function' ? opts.onTimeout : null;

    /** 在册请求：id → entry @type {Map<string, any>} */
    this.entries = new Map();
    /** 请求 ID → 当前序号 @type {Map<string, number>} */
    this.seqOf = new Map();
    /** 序号 → 请求 ID @type {Map<number, string>} */
    this.idOfSeq = new Map();
    /** 已推送消息 ID → 请求 ID @type {Map<string, {id: string, at: number}>} */
    this.messageIndex = new Map();
    /**
     * 已结算消息 ID 的墓碑。
     *
     * 为什么留着：用户可能会**再引用同一条**回一次（手滑、或以为没发出去）。
     * 那时如果直接从索引里删掉，就会掉进"未知引用 → 交回插件"的分支，
     * 插件再回一句"没有这条待回复"—— 用户看到的是"我批了但系统说没有"。
     * 留一个短墓碑，能明确回答"这条已经处理过了，结论是 X"。
     */
    this.tombstones = new Map();
    /**
     * 已结算**请求 ID** 的墓碑。
     *
     * 与消息墓碑分开：桌面端是按请求 ID 结算的（按钮点的是 `id`），
     * 那条路径根本没有 messageId。没有这张表的话，用户连点两次
     * "允许"会得到「该确认已过期或不存在」—— 而不是"已经处理过了"。
     * 前者听起来像出了故障，后者才是事实。
     */
    this.settledIds = new Map();
    this.nextSeq = 1;
  }

  /** 在册数量（界面快照与"恰好一条"判定用） */
  get size() {
    return this.entries.size;
  }

  /**
   * 分配一个序号：最小可用正整数。
   *
   * 复用被释放的号，避免长时间运行后卡片上写着"第 47 条"
   * 而其实只有一条待确认。序号在**登记那一刻**定下并写进卡片，
   * 之后不再重排 —— 用户看到的是"第 3 条"，中途有人答掉一条不能让
   * 这张卡变成"第 2 条"，否则他照着卡片回的数字会落到别人身上。
   *
   * @param {string} id
   * @returns {number}
   */
  allocSeq(id) {
    let n = this.nextSeq;
    while (this.idOfSeq.has(n)) n += 1;
    this.nextSeq = n + 1;
    this.idOfSeq.set(n, id);
    this.seqOf.set(id, n);
    return n;
  }

  /**
   * 释放序号。
   *
   * 必须与 entries 同步释放：漏掉这一句，卡片上的序号和实际能回复的
   * 序号就会错开，用户回「1」会被判成"没有第 1 条"。
   *
   * @param {number} seq
   */
  releaseSeq(seq) {
    if (!Number.isInteger(seq)) return;
    const id = this.idOfSeq.get(seq);
    this.idOfSeq.delete(seq);
    if (id !== undefined && this.seqOf.get(id) === seq) this.seqOf.delete(id);
    // nextSeq 不回退：回退会让刚释放的号立刻被复用，
    // 而用户手里可能还留着上一条卡片的旧号。
  }

  /**
   * 登记一次确认请求。
   *
   * 返回的 Promise 只会 settle 一次，值恒为 `'allow'` / `'deny'`。
   * 所有清理（定时器、序号、消息索引、墓碑）都在这一个地方做，
   * 所以"超时 / 取消 / 重复回复 / 发送失败"不会各写一份而漏掉某一条。
   *
   * @param {object} spec
   * @param {string} spec.tool
   * @param {string} spec.risk
   * @param {object} spec.args 已脱敏的参数（只用于展示）
   * @param {string} spec.convKey 发起请求的会话（快照展示用）
   * @param {string} [spec.replyConvKey] 卡片投递到的会话：回复必须来自这里
   * @param {string[]} spec.allowedSenders 允许处理的 QQ 号（空 = 只能桌面端处理）
   * @returns {{id: string, seq: number, entry: object, promise: Promise<'allow'|'deny'>}}
   */
  register(spec) {
    const at = this.now();
    const id = `confirm-${at}-${Math.random().toString(16).slice(2, 8)}`;
    const seq = this.allocSeq(id);

    /*
     * 上限：挂着太多请求时不再受理。
     *
     * 直接返回一个已拒绝的 Promise，而不是抛错或静默排队 ——
     * 调用方（工具执行器）拿到 deny 就会明确回"未获批准"，
     * 用户至少能知道发生了什么。
     */
    if (this.entries.size >= this.maxEntries) {
      this.releaseSeq(seq);
      return {
        id,
        seq,
        entry: { id, seq, settled: null, rejectedReason: 'too-many' },
        promise: Promise.resolve(/** @type {'deny'} */ ('deny')),
      };
    }

    /** @type {any} */
    const entry = {
      id,
      seq,
      tool: String(spec?.tool ?? ''),
      risk: String(spec?.risk ?? ''),
      args: spec?.args ?? {},
      /** 发起请求的会话（展示 + 审计） */
      convKey: String(spec?.convKey ?? ''),
      /** 回复必须来自这个会话；空串 = 不接受 QQ 回复 */
      replyConvKey: String(spec?.replyConvKey ?? ''),
      allowedSenders: normalizeSenders(spec?.allowedSenders),
      createdAt: at,
      expiresAt: at + this.timeoutMs,
      /** 推送过的消息 ID（推送失败时为空） */
      messageIds: /** @type {Set<string>} */ (new Set()),
      /** 推送失败的原因（有值说明卡片没送到，界面要能看见） */
      pushError: '',
      settled: /** @type {null | {outcome: 'allow'|'deny', reason: string, by: string, via: string, at: number}} */ (null),
      timer: /** @type {any} */ (null),
      resolve: /** @type {any} */ (null),
    };

    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });

    entry.timer = setTimeout(() => {
      /*
       * 超时 = 拒绝。这里不 await、不抛：定时器回调抛错会变成
       * uncaughtException，把整个后端带走 —— 而没人应答是**正常**路径。
       */
      const r = this.#settle(entry, 'deny', SETTLE_REASON.TIMEOUT, '', 'timeout');
      if (r.ok) {
        try {
          this.onTimeout?.({ id: entry.id, tool: entry.tool, seq: entry.seq });
        } catch {
          /* 通知是尽力而为，不能影响结算本身 */
        }
      }
    }, this.timeoutMs);
    // 不能因为这个定时器把进程钉住：用户关窗时进程必须能退
    entry.timer?.unref?.();

    this.entries.set(id, entry);
    return { id, seq, entry, promise };
  }

  /**
   * 把一次成功推送的 message_id 绑到请求上。
   *
   * ## 为什么绑定必须发生在发送**之后**
   *
   * 引用定位的全部依据就是这个消息 ID。发送失败（闸门拒绝、QQ 掉线）
   * 时上游不会给出 message_id，硬编一个假值只会让之后所有的引用
   * 都"查不到"或更糟 —— "查到一个错误的请求"。
   *
   * 所以绑定失败时保持未绑定：该请求仍然可以按"会话 + 人 + 恰好一条"
   * 来回答，并且它的 `pushError` 会被记下来给界面看。
   *
   * @param {string} id
   * @param {unknown} messageId
   * @returns {{ok: boolean, message?: string}}
   */
  bindMessage(id, messageId) {
    const entry = this.entries.get(String(id));
    if (!entry) return { ok: false, message: '该确认已过期或不存在' };
    if (entry.settled) return { ok: false, message: '该确认已结算' };

    const mid = normalizeMessageId(messageId);
    if (!mid) return { ok: false, message: '推送结果里没有 message_id，无法用引用定位' };

    entry.messageIds.add(mid);
    this.messageIndex.set(mid, { id: entry.id, at: this.now() });
    this.#trimMessages();
    return { ok: true };
  }

  /**
   * 记下推送失败。
   *
   * 不改变"仍然等待"的语义：卡片可能只是没送到，而桌面端还能点，
   * 用户也可能重连后自己想起来。失败只影响一句提示与界面显示。
   *
   * @param {string} id
   * @param {string} [message]
   */
  markPushFailed(id, message) {
    const entry = this.entries.get(String(id));
    if (!entry) return;
    entry.pushError = String(message ?? '推送失败');
  }

  /** 在册请求的展示视图（界面快照用） */
  list() {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      seq: e.seq,
      tool: e.tool,
      risk: e.risk,
      convKey: e.convKey,
      replyConvKey: e.replyConvKey,
      args: e.args,
      timeoutMs: this.timeoutMs,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      leftMs: Math.max(0, e.expiresAt - this.now()),
      pushError: e.pushError || null,
      quoted: e.messageIds.size > 0,
    }));
  }

  /**
   * 按引用消息结算 —— 主路径。
   *
   * @param {object} req
   * @param {unknown} req.messageId 被引用的消息 ID
   * @param {string} req.convKey 回复所在的会话
   * @param {string} req.senderId 回复人
   * @param {boolean} req.allow
   * @returns {SettleResult}
   */
  resolveByQuote(req) {
    const mid = normalizeMessageId(req?.messageId);
    if (!mid) return { ok: false, handled: false, code: 'E4037', reason: 'unknown-quote', message: '这条回复没有引用任何消息' };

    /*
     * 这里**刻意不先 sweep**。
     *
     * 过期条目被 sweep 掉会进墓碑，之后再来一条回复只会得到
     * 「已经处理过」，而用户真正需要知道的是「它超时了」——
     * 前者听起来像自己答过，后者才解释得清工具为什么没执行。
     *
     * 所以把过期交给 #settleWithChecks 的显式分支处理。
     */
    const hit = this.messageIndex.get(mid);
    if (!hit) {
      /*
       * 引用不属于本表 —— **交回调用方**。
       *
       * 这里绝不能退化成"按当前待确认数量猜一个"：DSH 的审批卡
       * 与这里的确认卡都是"引用回数字"，猜错就是用 A 的点头批 B 的操作。
       */
      const tomb = this.tombstones.get(mid);
      if (tomb && tomb.convKey === String(req?.convKey ?? '')) {
        /*
         * 已结算的重复回复：只回给**卡片所在的那个会话**。
         *
         * 墓碑上记着结算时绑定的 replyConvKey。同一条 message_id 出现在
         * 别的会话里（卡片被转发、或上游复用了消息 id）不是这张卡的
         * 回答，按"未知引用"交回：既不能替别人消费掉那条消息，
         * 也不该把"第 N 条已经处理过（已放行）"这种结论说给无关的人听。
         */
        return {
          ok: false,
          handled: true,
          code: 'E4035',
          reason: 'duplicate',
          id: tomb.id,
          outcome: tomb.outcome,
          message: `这条确认已经处理过了（${describeOutcome(tomb.outcome)}），不用再回。`,
        };
      }
      return { ok: false, handled: false, code: 'E4037', reason: 'unknown-quote' };
    }

    return this.#settleWithChecks({ entry: this.entries.get(hit.id), ...req, via: 'quote', mid });
  }

  /**
   * 不引用时结算 —— 仅当**当前人 + 当前会话**下有且仅有一条可处理请求。
   *
   * @param {object} req
   * @param {string} req.convKey
   * @param {string} req.senderId
   * @param {boolean} req.allow
   * @param {number} [req.seq] 用户显式给了序号
   * @param {string} [req.id] 用户显式给了请求 ID
   * @returns {SettleResult}
   */
  resolveUnquoted(req) {
    const convKey = String(req?.convKey ?? '');
    const senderId = String(req?.senderId ?? '');

    if (req?.id !== undefined) {
      return this.#settleWithChecks({ ...req, entry: this.entries.get(String(req.id)), via: 'id' });
    }

    if (req?.seq !== undefined) {
      const id = this.idOfSeq.get(Number(req.seq));
      if (!id) {
        return {
          ok: false,
          handled: true,
          code: 'E4036',
          reason: 'unknown-id',
          message: `没有第 ${req.seq} 条待确认。当前有：${[...this.seqOf.values()].sort((a, b) => a - b).join('、') || '（无）'}。`,
        };
      }
      return this.#settleWithChecks({ ...req, entry: this.entries.get(id), via: 'seq' });
    }

    const candidates = this.#actionableFor(convKey, senderId);
    if (candidates.length === 0) {
      // 没有可处理的：裸数字很可能只是闲聊（"2 点了"），交回正常流程
      return { ok: false, handled: false, code: 'E4038', reason: 'unknown-id' };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        handled: true,
        code: 'E4036',
        reason: 'ambiguous',
        message: `现在有 ${candidates.length} 条待确认，请**引用**你要回答的那条再回数字，或用「同意 ${candidates[0].seq}」指定，避免批错对象。`,
      };
    }

    return this.#settleWithChecks({ ...req, entry: candidates[0], via: 'sole' });
  }

  /**
   * 桌面端结算（界面按钮）。
   *
   * 桌面端就是用户本人在操作，所以跳过 QQ 身份/会话校验 ——
   * 但仍然要校验存在性、有效期与未结算状态：那两个是**请求本身的**
   * 事实，与谁来点无关。
   *
   * @param {object} req
   * @param {string} req.id
   * @param {boolean} req.allow
   * @returns {SettleResult}
   */
  resolveFromConsole(req) {
    const wanted = String(req?.id ?? '');
    const entry = this.entries.get(wanted);
    if (!entry) {
      const tomb = this.settledIds.get(wanted);
      return {
        ok: false,
        handled: true,
        code: tomb ? 'E4035' : 'E4034',
        reason: tomb ? 'duplicate' : 'unknown-id',
        id: tomb ? wanted : undefined,
        message: tomb
          ? `这条确认已经处理过了（${describeOutcome(tomb.outcome)}）。`
          : '该确认已过期或不存在',
      };
    }
    return this.#settleWithChecks({ entry, allow: req?.allow === true, by: 'console', via: 'console' });
  }

  /**
   * 本会话本人名下**有没有**可处理的确认。
   *
   * ## 为什么这个查询要单独暴露出来
   *
   * 消息派发时有多个接管者（宿主的引用/裸数字确认、各插件）。其中
   * 「正则自动回复」这类插件优先级最低，但它**可能把一条 `1` 当成
   * 某种口令回掉** —— 而那条 `1` 其实是用户在回答一张确认卡。
   *
   * 插件自己没法判断这件事：确认表在宿主里，插件拿到的事件里没有任何
   * 字段能表示"这条消息可能属于宿主"。所以宿主必须在派发前把这个事实
   * 算出来，作为 `gate.confirmPending` 交给低优先级插件。
   *
   * 语义取**宽**：只要本会话本人名下有未结算、未过期的确认就返回 true，
   * 不管文本长什么样。理由是有待确认时"少回一条"只是少一句自动回复，
   * 而"多回一条"可能让用户以为自己的确认被系统拒绝了。
   *
   * @param {string} convKey
   * @param {string} senderId
   * @returns {boolean}
   */
  hasActionable(convKey, senderId) {
    return this.#actionableFor(String(convKey ?? ''), String(senderId ?? '')).length > 0;
  }

  /**
   * 本会话本人名下没有可处理请求时，用来判断"要不要提示去别的会话"。
   *
   * `replyConvKey === ''` 的请求**没有 QQ 投递目标**（群聊来源的确认只能
   * 在桌面端点）。把它们算成"别的会话里有待确认"会让宿主回一句
   * "请去那个会话说" —— 用户真去了也答不了，只能干等到超时。
   * 所以这里只统计**存在一个能回答的会话**的请求。
   *
   * @param {string} convKey
   * @param {string} senderId
   * @returns {boolean}
   */
  hasActionableElsewhere(convKey, senderId) {
    const at = this.now();
    return [...this.entries.values()].some(
      (e) =>
        !e.settled &&
        at < e.expiresAt &&
        e.allowedSenders.includes(senderId) &&
        e.replyConvKey !== '' &&
        e.replyConvKey !== convKey,
    );
  }

  /**
   * 全部按拒绝结算（退出 / 停用时）。
   *
   * 不这么做的话，在途工具调用会一直等到超时 —— 而进程马上就要没了，
   * 那条 Promise 永远等不到结果，工具调用方悬在半空。
   *
   * @param {string} [reason]
   * @returns {number} 结算了几条
   */
  cancelAll(reason = SETTLE_REASON.SHUTDOWN) {
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (this.#settle(entry, 'deny', String(reason), '', 'cancel').ok) n += 1;
    }
    return n;
  }

  /**
   * 把已经过期、但定时器还没跑到的条目按拒绝落定。
   *
   * ## 为什么需要一条**惰性**清理路径
   *
   * 定时器是唯一的常规结算路径，但它有个必然的盲区：进程被挂起、
   * 系统睡眠、事件循环被长任务占住时，定时器会**晚到**。
   * 那段时间里 `entries` 里的条目已经逻辑过期，却仍然占着序号、
   * 仍然出现在 `#actionableFor()` 的结果里 —— 于是"恰好一条"的判断
   * 会把一条早该作废的请求算进去。
   *
   * 所以每次做归属判定之前都先扫一遍。它很便宜（在册数量是个位数），
   * 换来的是"过期"这件事不依赖定时器准时。
   *
   * @returns {number} 清掉几条
   */
  sweepExpired() {
    const at = this.now();
    let n = 0;
    for (const entry of [...this.entries.values()]) {
      if (at < entry.expiresAt) continue;
      if (this.#settle(entry, 'deny', SETTLE_REASON.TIMEOUT, '', 'timeout').ok) {
        n += 1;
        try {
          this.onTimeout?.({ id: entry.id, tool: entry.tool, seq: entry.seq });
        } catch {
          /* 通知是尽力而为 */
        }
      }
    }
    return n;
  }

  /* ------------------------------------------------------------ 内部 */

  /**
   * 当前会话里、当前这个人能处理的请求。
   *
   * 三个条件缺一不可：会话一致、允许处理、未过期未结算。
   * 少一条都会变成"别人会话里的确认被这个人批掉"。
   *
   * @param {string} convKey
   * @param {string} senderId
   * @returns {any[]}
   */
  #actionableFor(convKey, senderId) {
    // 先清掉逻辑过期但定时器没跑到的：它们不该参与"恰好一条"的判断
    this.sweepExpired();
    const at = this.now();
    return [...this.entries.values()].filter(
      (e) =>
        !e.settled &&
        at < e.expiresAt &&
        e.replyConvKey !== '' &&
        e.replyConvKey === convKey &&
        e.allowedSenders.includes(senderId),
    );
  }

  /**
   * 校验 + 结算。
   *
   * 五个校验（顺序即含义）：
   *   1. 请求在册（不存在 → 明确说过期，不猜）
   *   2. 未结算（已结算 → 重复回复）
   *   3. 未过期（过期 → 立刻按拒绝落定，回复本身不生效）
   *   4. 会话归属（回复必须来自卡片所在会话）
   *   5. 身份（必须在 allowedSenders 里）
   *
   * 4/5 放在 2/3 之后：先回答"这条请求还在不在"，
   * 再回答"你有没有资格"—— 顺序反了会把"已过期"说成"没权限"，
   * 用户会以为自己被针对。
   *
   * @param {object} req
   * @returns {SettleResult}
   */
  #settleWithChecks(req) {
    const entry = req?.entry;
    if (!entry) {
      return { ok: false, handled: true, code: 'E4034', reason: 'unknown-id', message: '该确认已过期或不存在' };
    }

    if (entry.settled) {
      return {
        ok: false,
        handled: true,
        code: 'E4035',
        reason: 'duplicate',
        id: entry.id,
        seq: entry.seq,
        outcome: entry.settled.outcome,
        message: `第 ${entry.seq} 条已经处理过了（${describeOutcome(entry.settled.outcome)}），不用再回。`,
      };
    }

    if (this.now() >= entry.expiresAt) {
      // 迟到的回复**不能翻案**：先按超时处理掉，再告诉用户它过期了
      this.#settle(entry, 'deny', SETTLE_REASON.TIMEOUT, '', 'timeout');
      return {
        ok: false,
        handled: true,
        code: 'E4034',
        reason: 'expired',
        id: entry.id,
        seq: entry.seq,
        message: `第 ${entry.seq} 条已经超时，按拒绝处理了。需要的话请重新发起。`,
      };
    }

    const via = String(req?.via ?? 'quote');
    // console 是用户本人在电脑前点按钮：不存在"会话归属"这回事
    if (via !== 'console') {
      const senderId = String(req?.senderId ?? '');
      const convKey = String(req?.convKey ?? '');

      if (entry.replyConvKey === '' || convKey !== entry.replyConvKey) {
        return {
          ok: false,
          handled: true,
          code: 'E4039',
          reason: 'wrong-session',
          id: entry.id,
          seq: entry.seq,
          message: '这条确认不是在这个会话里发起的，不能在这里回答。',
        };
      }
      if (!entry.allowedSenders.includes(senderId)) {
        return {
          ok: false,
          handled: true,
          code: 'E4039',
          reason: 'forbidden',
          id: entry.id,
          seq: entry.seq,
          message: '这条确认不是发给你的，不能由你来回答。',
        };
      }
    }

    const outcome = req?.allow === true ? 'allow' : 'deny';
    const r = this.#settle(entry, outcome, String(req?.reason ?? (via === 'console' ? SETTLE_REASON.CONSOLE : SETTLE_REASON.USER)), String(req?.by ?? req?.senderId ?? ''), via);
    return { ok: r.ok, handled: true, code: r.ok ? undefined : 'E4035', id: entry.id, seq: entry.seq, outcome };
  }

  /**
   * 唯一结算入口：清理 + 落定 + 通知等待方。
   *
   * ## 为什么所有路径都走这里
   *
   * 超时、取消、QQ 回复、桌面端点击都会落到这一处，所以
   * "序号释放"和"定时器清理"不可能被漏掉某一边。
   * 之前正是"只删 pendingConfirms 不释放序号"导致卡片上的
   * 序号与实际能回的对不上。
   *
   * `settled` 先写再 resolve：Promise 的 then 可能是同步排队的，
   * 若回调里又来一次 resolve（双端竞争），第二次必须看到 settled。
   *
   * @param {any} entry
   * @param {'allow'|'deny'} outcome
   * @param {string} reason
   * @param {string} by
   * @param {string} via
   * @returns {{ok: boolean}}
   */
  #settle(entry, outcome, reason, by, via) {
    if (!entry || entry.settled) return { ok: false };

    entry.settled = { outcome, reason, by: String(by ?? ''), via, at: this.now() };
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.entries.delete(entry.id);
    this.releaseSeq(entry.seq);

    // 请求 ID 的墓碑：桌面端连点两次要得到"已处理过"，不是"不存在"
    this.settledIds.set(entry.id, { id: entry.id, outcome, reason, at: this.now() });
    this.#trimSettledIds();

    // 消息 ID 从"可回答"索引搬进墓碑：之后同一引用的回复会被明确告知"已处理"
    for (const mid of entry.messageIds) {
      this.messageIndex.delete(mid);
      this.tombstones.set(mid, {
        id: entry.id,
        outcome,
        reason,
        at: this.now(),
        /*
         * 墓碑要记住这张卡投递到哪个会话。
         *
         * 重复回复的提示（"已经处理过了"）只能回给卡片所在会话：
         * 别处引用同一个 message_id 不是对这张卡的回答，必须交回。
         */
        convKey: entry.replyConvKey,
      });
    }
    this.#trimTombstones();

    try {
      entry.resolve?.(outcome);
    } catch {
      /* resolve 不会被 here 抛；真抛了也不能影响结算结果 */
    }
    return { ok: true };
  }

  /** 消息索引上限：超了丢最旧的（推送过的卡片总有不再需要的时候） */
  #trimMessages() {
    if (this.messageIndex.size <= this.maxMessages) return;
    const oldest = [...this.messageIndex.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) this.messageIndex.delete(oldest[0]);
  }

  /** 墓碑上限：它只用于"重复回复"的提示，不需要长期保留 */
  #trimTombstones() {
    if (this.tombstones.size <= this.maxMessages) return;
    const oldest = [...this.tombstones.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) this.tombstones.delete(oldest[0]);
  }

  /** 已结算请求 ID 的墓碑，同样限量 */
  #trimSettledIds() {
    if (this.settledIds.size <= this.maxMessages) return;
    const oldest = [...this.settledIds.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) this.settledIds.delete(oldest[0]);
  }
}

/**
 * 允许处理的 QQ 号列表。
 *
 * 只收纯数字：混进空串或说明文字后，`includes(senderId)` 永远不成立，
 * 表现就是"管理员明明在名单里却说没权限"——静默失效。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeSenders(raw) {
  const list = Array.isArray(raw) ? raw : [];
  /** @type {string[]} */
  const out = [];
  for (const v of list) {
    const id = String(v ?? '').trim();
    if (!/^\d{4,15}$/.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 结算结论 → 人能读的一句话。
 *
 * @param {'allow'|'deny'} outcome
 * @returns {string}
 */
export function describeOutcome(outcome) {
  return outcome === 'allow' ? '已放行' : '已拒绝';
}
