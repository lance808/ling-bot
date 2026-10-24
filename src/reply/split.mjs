/**
 * 回复分条协议 —— 模型的一次输出 → 若干个独立气泡
 *
 * ## 为什么需要协议而不是"按行拆"
 *
 * 旧实现把 `result.text` 整段交给一次 `sendText`，于是模型即使把话说成
 * 三段、中间还空了一行，在 QQ 里也只是一个气泡。看起来像"一口气说完"，
 * 而真人聊天是分几条发的。
 *
 * 但**不能**按逗号、句号或所有换行机械拆分：
 *
 *   - 一句话被切成两半，读起来像被打断；
 *   - 代码块、表格、列表一旦被拆开，QQ 里就是一堆没有意义的碎片；
 *   - 模型的行数不受控，一段长回答能拆出二十条，直接刷屏。
 *
 * 所以边界必须**由模型显式给出**，而且必须**可校验**：
 * 解析不出来就整条原样发，绝不猜。
 *
 * ## 协议
 *
 * 模型要分条时，把整个回复写成一个带语言标记的围栏块：
 *
 *   ```ling-msgs
 *   ["第一句", "第二句"]
 *   ```
 *
 * 校验规则（任何一条不过 → 整段降级成一条普通消息）：
 *
 *   1. 恰好一个 `ling-msgs` 围栏；
 *   2. 围栏内容是合法 JSON；
 *   3. 顶层是数组；
 *   4. 每个元素都是字符串，且至少有一个非空元素。
 *
 * 围栏前后的普通文字（"分两条说："这类）不会被丢掉：
 * 前面的作为第一条、后面的作为最后一条。
 *
 * ## 为什么用围栏而不是裸 JSON
 *
 * 裸 JSON 数组会和正常回答撞车：用户让模型"写一个数组示例"时，
 * 那段示例就是合法 JSON 数组。围栏带语言标记，这个标记只属于本协议，
 * 模型写代码示例时不会用它。
 *
 * 同时，真实代码块用的是 ``` 或 ~~~（不带 `ling-msgs`），永远不会被误判 ——
 * 这正是"保护代码块"的实现方式：不是靠拆分时小心翼翼，而是**根本不看**
 * 那些块。
 *
 * ## 兜底
 *
 * 没写协议、写坏了、超出条数上限，都走同一条路：整段原样发。
 * 少分几条是体验问题，丢内容/发错内容是事故。
 */

/** 围栏语言标记：只有这个标记才表示"这是分条协议" */
export const SPLIT_FENCE_LANG = 'ling-msgs';

/** 默认最多分几条 */
export const DEFAULT_MAX_MESSAGES = 3;

/**
 * 上限的硬边界。
 *
 * 配置校验与运行时都夹到这里：再大就不叫"像真人"了，而是刷屏源。
 */
export const MAX_MESSAGES_HARD_CAP = 10;

/**
 * 围栏块识别。
 *
 * 注意 `m.index` 与 `m[0].length`：前后文字要按**原始位置**切，
 * 不能用 split —— 内容里可能还有别的 ```（普通代码块），split 会切错。
 */
const FENCE_RE = /```[ \t]*ling-msgs[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i;

/**
 * 这段文本结束时是否还停在未闭合的代码围栏里。
 *
 * 只关心"``` / ~~~ 出现在行首"这种围栏形态，不解析 info string 细节 ——
 * 我们只拿它判断模型有没有把一块代码拆到两条消息里。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isFenceOpen(text) {
  /** @type {string | null} 当前打开的围栏字符（` 或 ~） */
  let open = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const ch = m[1][0];
    if (open === null) open = ch;
    else if (ch === open) open = null;
  }
  return open !== null;
}

/**
 * 把被拆开的代码块重新合回一条。
 *
 * ## 为什么需要这一步
 *
 * 协议要求"代码块整块留在同一个元素里"，但模型并不总是听话：
 * 一段长代码被切成两条时，QQ 里第一块没有收尾围栏、第二块凭空开始，
 * 两边都渲染不出代码 —— 用户看到的是两个残缺片段。
 *
 * 这里按围栏状态做一次结构修复：只要上一条结束时围栏还开着，
 * 就把下一条接上去，直到围栏闭合。
 *
 * 修不好怎么办：未闭合的那条**照原样发**，不丢内容也不编造结尾。
 *
 * @param {string[]} items
 * @returns {string[]}
 */
export function mergeUnbalancedFences(items) {
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let pending = null;

  for (const item of items) {
    if (pending !== null) {
      pending = `${pending}\n${item}`;
      if (!isFenceOpen(pending)) {
        out.push(pending);
        pending = null;
      }
      continue;
    }
    if (isFenceOpen(item)) {
      pending = item;
      continue;
    }
    out.push(item);
  }

  // 走到最后还没闭合：原样交出去，交给 QQ 渲染，至少内容没丢
  if (pending !== null) out.push(pending);
  return out;
}

/**
 * 解析一次模型输出里的分条块。
 *
 * @param {string} text
 * @returns {{found: false}
 *   | {found: true, ok: false, reason: string, detail?: string}
 *   | {found: true, ok: true, items: string[], before: string, after: string}}
 */
export function parseSplitBlock(text) {
  const raw = String(text ?? '');
  const m = FENCE_RE.exec(raw);
  if (!m) return { found: false };

  const before = raw.slice(0, m.index).trim();
  const after = raw.slice(m.index + m[0].length).trim();

  let data;
  try {
    data = JSON.parse(m[1].trim());
  } catch (err) {
    // 坏 JSON 一律不修：改写模型输出比原样发出去危险得多
    return { found: true, ok: false, reason: 'invalid-json', detail: String(/** @type {any} */ (err)?.message ?? err) };
  }

  if (!Array.isArray(data)) return { found: true, ok: false, reason: 'not-array' };

  /** @type {string[]} */
  const items = [];
  for (const item of data) {
    /*
     * 非字符串元素直接判定整块无效，而不是 String() 转换。
     *
     * 理由：`String({})` 会得到 "[object Object]"，那会把模型的
     * 结构错误变成一条发给用户的乱码消息 —— 宁可整段降级回原文。
     */
    if (typeof item !== 'string') return { found: true, ok: false, reason: 'non-string-item' };
    const s = item.trim();
    if (s) items.push(s);
  }
  if (items.length === 0) return { found: true, ok: false, reason: 'empty' };

  return { found: true, ok: true, items, before, after };
}

/**
 * 把超出上限的部分并进最后一条。
 *
 * ## 为什么不直接丢掉
 *
 * 丢内容是最坏的降级：用户不知道少了什么，模型也以为自己说完了。
 * 合并之后条数受控、内容完整，代价只是最后一条长一点。
 *
 * @param {string[]} items
 * @param {number} max
 * @returns {{items: string[], clamped: boolean}}
 */
export function clampToMax(items, max) {
  const limit = Math.max(1, Math.min(MAX_MESSAGES_HARD_CAP, Math.trunc(Number(max) || DEFAULT_MAX_MESSAGES)));
  if (items.length <= limit) return { items, clamped: false };
  const head = items.slice(0, limit - 1);
  const tail = items.slice(limit - 1).join('\n');
  return { items: [...head, tail], clamped: true };
}

/**
 * 顶层入口：模型输出 → 要发送的消息列表。
 *
 * @param {string} text 模型这一回合的最终文本（不含触顶说明）
 * @param {{maxMessages?: number, enabled?: boolean}} [options]
 * @returns {{
 *   mode: 'plain' | 'structured',
 *   messages: string[],
 *   reason?: string,
 *   clamped?: boolean,
 *   detail?: string,
 * }}
 */
export function splitReply(text, options = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { mode: 'plain', messages: [], reason: 'empty' };

  // 关掉分条：即使模型写了协议也整条发（配置是硬开关）
  if (options.enabled === false) return { mode: 'plain', messages: [raw], reason: 'disabled' };

  const parsed = parseSplitBlock(raw);
  if (!parsed.found) return { mode: 'plain', messages: [raw], reason: 'no-block' };
  if (!parsed.ok) return { mode: 'plain', messages: [raw], reason: parsed.reason, detail: parsed.detail };

  /** @type {string[]} */
  let items = [...parsed.items];
  /*
   * 围栏前后的说明文字并进相邻那一条，而不是各自独立成一个气泡。
   *
   * ## 为什么不是"前插一条、后接一条"
   *
   * "分两条说："这种只有几个字的引导语独立成一条，用户看到的是一个
   * 没有内容的碎气泡 —— 那正是"完整意思保留在一条消息里"要避免的。
   * 并进相邻气泡之后条数不变，也不会把 maxMessages 顶爆。
   */
  if (parsed.before) items[0] = `${parsed.before}\n${items[0]}`;

  /*
   * 围栏之后可能还有东西。
   *
   * 两种都要处理：
   *   · 普通文字 → 并进最后一条（同上，避免碎气泡）；
   *   · 又写了一个分条块（模型偶尔会重复）→ 把它拆出来的条目追加进去。
   *     整块原样发出去会让用户看到一段 JSON，比多分一条糟得多。
   */
  let after = parsed.after;
  while (after) {
    const more = parseSplitBlock(after);
    if (!more.found || !more.ok) {
      items[items.length - 1] = `${items[items.length - 1]}\n${after}`;
      break;
    }
    if (more.before) items[items.length - 1] = `${items[items.length - 1]}\n${more.before}`;
    items.push(...more.items);
    after = more.after;
  }

  items = mergeUnbalancedFences(items);

  const { items: clampedItems, clamped } = clampToMax(items, options.maxMessages);
  items = clampedItems;

  if (items.length <= 1) {
    return { mode: 'plain', messages: items, reason: clamped ? 'clamped' : 'single', clamped };
  }
  return { mode: 'structured', messages: items, clamped };
}
