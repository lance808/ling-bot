/**
 * 把 QQ 里收到的文本，解析成「审批回复」或「下给 DSH 的指令」
 *
 * ## 为什么单独一个模块
 *
 * 解析是**纯函数**：给定文本和当前待审批列表，输出一个确定的动作。
 * 把它从网络代码里拆出来，才能对"人会怎么打字"做穷举测试——
 * 而人打字的花样是多到想不出来的。
 *
 * ## 编号制带来的一个真问题
 *
 * 用户看到的是"同意 3"，但 3 这个编号只管一小段时间（超时就回收）。
 * 如果一个旧指令在新编号复用后到达（编号 99 之后回卷到 1），
 * 就会错误地批准一个新请求。
 *
 * 处理方式：**只看当前在册的编号**。不在册就明确回"没有这个编号"，
 * 绝不猜测用户想批哪一条。宁可让他重发一次。
 */

/** 审批同意 */
const APPROVE = /^(?:同意|批准|准|通过|allow|approve|ok|yes|y)$/i;
/** 审批拒绝 */
const REJECT = /^(?:拒绝|不同意|否|驳回|deny|reject|no|n)$/i;

/**
 * @typedef {'approve'|'reject'|'cancel'|'quiet'|'unquiet'|'pending'|'command'|'unknown'} ParseKind
 *
 * @typedef {object} Parsed
 * @property {ParseKind} kind
 * @property {string} [id]       approve/reject 时的审批编号
 * @property {number} [ms]       quiet 时的免打扰毫秒数
 * @property {string} [text]     command 时的指令正文
 * @property {string} [reason]   unknown 时的说明
 */

/**
 * 把 "10分钟" / "30s" / "1小时" 这类说法换成毫秒。
 *
 * @param {string} s
 * @returns {number} 解析不出时返回 0
 */
export function parseDuration(s) {
  const m = String(s ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(秒|s|sec|分钟|分|min|m|小时|时|h|hour)?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = (m[2] ?? 'm').toLowerCase();
  if (/^(秒|s|sec)$/.test(unit)) return Math.round(n * 1000);
  if (/^(小时|时|h|hour)$/.test(unit)) return Math.round(n * 3600_000);
  // 无单位默认按分钟 —— "免打扰10" 最自然的理解是 10 分钟
  return Math.round(n * 60_000);
}

/**
 * 解析一条来自管理员的 QQ 文本。
 *
 * @param {string} raw
 * @param {{pendingIds?: string[]}} [ctx]
 * @returns {Parsed}
 */
export function parseCommand(raw, ctx = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'unknown', reason: '空消息' };

  const pendingIds = new Set((ctx.pendingIds ?? []).map(String));

  // ---- 前缀指令：/dsh 或 #dsh 开头的内容一律当作"下给 DSH 的指令" ----
  // 放在最前面，因为这是唯一"内容原样传递"的形式，
  // 不能让下面的关键词规则把它吃掉（比如指令正文恰好是"同意"）。
  const prefixed = text.match(/^(?:\/|#)dsh(?:\s+([\s\S]*))?$/i);
  if (prefixed) {
    const body = String(prefixed[1] ?? '').trim();
    if (!body) return { kind: 'unknown', reason: '指令内容为空。用法：/dsh 你的指令' };
    return { kind: 'command', text: body };
  }

  // ---- 免打扰 ----
  // "免打扰 30分钟" / "安静 1小时" / "放行10分钟"
  const quiet = text.match(/^(?:免打扰|安静|勿扰|放行|quiet)\s*([\d.]+\s*\S*)?$/i);
  if (quiet) {
    const ms = parseDuration(quiet[1] ?? '10');
    if (ms <= 0) return { kind: 'unknown', reason: '时长看不懂，例如：免打扰 30分钟' };
    return { kind: 'quiet', ms };
  }
  if (/^(?:取消免打扰|恢复|解除勿扰|unquiet)$/i.test(text)) {
    return { kind: 'unquiet' };
  }

  // ---- 查看待审批 ----
  if (/^(?:待审批|待处理|有哪些|列表|pending|list)$/i.test(text)) {
    return { kind: 'pending' };
  }

  // ---- 审批回复：动词 + 编号（也允许 编号 + 动词）----
  // 三种写法都接受："同意 3" / "同意3" / "3 同意"
  const verbFirst = text.match(
    /^(同意|批准|准|通过|allow|approve|ok|yes|y|拒绝|不同意|否|驳回|deny|reject|no|n)\s*#?(\d+)?$/i,
  );
  const numFirst = text.match(
    /^#?(\d+)\s*(同意|批准|准|通过|allow|approve|ok|yes|y|拒绝|不同意|否|驳回|deny|reject|no|n)$/i,
  );

  const verb = verbFirst?.[1] ?? numFirst?.[2];
  const num = verbFirst?.[2] ?? numFirst?.[1];

  if (verb) {
    const isApprove = APPROVE.test(verb);
    const isReject = REJECT.test(verb);
    if (!isApprove && !isReject) return { kind: 'unknown', reason: '看不懂是同意还是拒绝' };

    // 没给编号：只有恰好一条待审批时才允许省略，否则必须问清
    if (num === undefined) {
      if (pendingIds.size === 1) {
        return { kind: isApprove ? 'approve' : 'reject', id: [...pendingIds][0] };
      }
      if (pendingIds.size === 0) {
        return { kind: 'unknown', reason: '现在没有待审批' };
      }
      return {
        kind: 'unknown',
        reason: `现在有 ${pendingIds.size} 条待审批，请带上编号，例如「同意 3」`,
      };
    }

    // 给了编号但不在册：明确拒绝，不猜
    if (!pendingIds.has(String(num))) {
      if (pendingIds.size === 0) {
        return { kind: 'unknown', reason: `编号 ${num} 不存在（当前没有待审批）` };
      }
      return {
        kind: 'unknown',
        reason: `编号 ${num} 不存在，当前待审批：${[...pendingIds].join('、')}`,
      };
    }

    return { kind: isApprove ? 'approve' : 'reject', id: String(num) };
  }

  // ---- 都不是：不当作指令 ----
  // 这条很重要：普通聊天内容**不会**被当成给 DSH 的指令。
  // 否则群里随便一句话都可能让 DSH 干起活来。
  return { kind: 'unknown', reason: '不是可识别的指令。给 DSH 下指令请用 /dsh 开头' };
}

/**
 * 把一条待审批渲染成人看的文本。
 *
 * @param {{id: string, toolName: string, reason?: string, createdAt?: number}} p
 * @returns {string}
 */
export function formatApproval(p) {
  const lines = [`[${p.id}] ${p.toolName}`];
  const reason = String(p.reason ?? '').trim();
  if (reason) lines.push(reason.length > 300 ? `${reason.slice(0, 300)}…` : reason);
  return lines.join('\n');
}

/**
 * 一组待审批 → 一条汇总消息。
 *
 * 多条时不逐条发（会刷屏），合并成一条，每条一行。
 *
 * @param {Array<{id: string, toolName: string, reason?: string}>} items
 * @returns {string}
 */
export function formatPendingList(items) {
  if (items.length === 0) return '现在没有待审批。';
  const body = items.map((p) => formatApproval(p)).join('\n\n');
  return `待审批 ${items.length} 条：\n\n${body}\n\n回复「同意 N」或「拒绝 N」。`;
}
