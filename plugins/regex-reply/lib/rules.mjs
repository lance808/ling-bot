/**
 * 规则解析与运行时求值 —— 纯函数层
 *
 * ## 职责与边界
 *
 * 本模块只做四类纯计算，**不碰 IO、不碰宿主对象、不持有状态**：
 *
 * 1. 把用户提交的规则 JSON 解析、校验、规范化成 `NormalizedRule`；
 * 2. 判断一条规则在某个会话上下文里是否适用（`inScope`）；
 * 3. 按优先级排序（`sortByPriority`，稳定）；
 * 4. 把回复模板渲染成最终文本（`renderTemplate`）并做长度裁剪（`clampReply`）。
 *
 * 所有函数对同样的入参永远给出同样的结果，且不修改入参。这样它才能被单测
 * 穷举——正则规则的错法本来就多，靠线上试错代价太高。
 *
 * ## 为什么解析和求值放在同一个文件
 *
 * 它们共享同一批常量（`LIMITS` / `ALLOWED_FLAGS`）和同一套「什么是合法规则」的
 * 定义。拆开会立刻出现两份不一致的边界值，而这类不一致的症状是"保存时说合法、
 * 匹配时才炸"。同文件的代价只是文件长一点，值得。
 *
 * ## 一个反复出现的坑：正则是有状态的
 *
 * `g` / `y` 会让 `RegExp` 带 `lastIndex`，在多次 `test()` 之间累积。同一条规则
 * 于是"这次匹配、下次不匹配"。这个模块从入口就拒绝这两个 flag，并且**永不**
 * 复用正则实例（编译只用于校验，真正匹配由调用方每次新建）。
 */

/**
 * 各类上限的单一来源。
 *
 * 全部集中在这里，是为了让管理端的展示、导入校验、运行时限流读同一份数字；
 * 分散成字面量的话，改一处漏一处。
 *
 * @type {Readonly<{
 *   maxRules: number,
 *   maxPatternLength: number,
 *   maxTemplateLength: number,
 *   maxInputLength: number,
 *   maxReplyLength: number,
 *   maxScopeIds: number,
 *   defaultMatchTimeoutMs: number,
 *   maxMatchTimeoutMs: number,
 *   defaultCooldownMs: number,
 *   maxCooldownMs: number,
 *   minPriority: number,
 *   maxPriority: number,
 *   maxCaptures: number,
 * }>}
 */
export const LIMITS = Object.freeze({
  maxRules: 64,
  maxPatternLength: 500,
  maxTemplateLength: 1000,
  maxInputLength: 4000,
  maxReplyLength: 4000,
  maxScopeIds: 200,
  defaultMatchTimeoutMs: 50,
  maxMatchTimeoutMs: 500,
  defaultCooldownMs: 0,
  maxCooldownMs: 86_400_000,
  minPriority: -1000,
  maxPriority: 1000,
  // 上游用它对捕获数组做上限裁剪，避免模板引用几十个组；本模块不改写 groups。
  maxCaptures: 20,
});

/**
 * 允许的 flags。顺序即规范化输出顺序，改动这里等于改契约。
 *
 * 没有 `g` / `y`：它们是**带状态**的。`g` 让 `lastIndex` 在多次 `test()` 间累积，
 * 典型症状是同一条规则"时好时坏"——同一条消息测两次结果不同。本模块每条消息
 * 都用新正则，根本不需要 `g`。拒绝比"悄悄剥掉"好：静默剥掉会让用户以为自己
 * 写的 `/.../g` 生效了。
 *
 * 没有 `v`：它是 `u` 的互斥升级版，两人的字符类语义不同，同时放进来会让
 * "到底按哪套解析"变成隐式行为。要支持得单开一个 flag 位。
 *
 * @type {ReadonlyArray<'i'|'m'|'s'|'u'>}
 */
export const ALLOWED_FLAGS = Object.freeze(['i', 'm', 's', 'u']);

/**
 * 规则 id 的格式：小写字母开头，2–41 字符。
 *
 * 限制得这么死，是因为 id 会出现在日志、管理端 URL、模板 `{ruleId}` 里，
 * 还要能稳定对应用户手写的一份配置。允许大写/空格就会逼着每个消费方
 * 自己写一遍"如何比较 id"，迟早出现两个只差大小写的 id。
 */
const ID_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** 群号 / QQ 号：纯数字。上限 20 位，防的是把一串数字当 id 塞进来的误用。 */
const NUMERIC_ID_RE = /^\d{1,20}$/;

/** 会话 key 的形状，与宿主约定 `group:<id>` / `private:<id>`。 */
const CONV_KEY_RE = /^(group|private):(\d{1,20})$/;

/** 默认 scope：全开、不按 id 限制、不限管理员。 */
const DEFAULT_KINDS = ['group', 'private'];

/**
 * 模板变量单次扫描器。
 *
 * 关键点是**一次扫描**，不能写成 sed 式的多次 `replace` 串联：
 * 第一遍替换出来的文本会被第二遍再次匹配（用户回复里出现 `{user}` 字面量、
 * 或者 `{{` 转义产出的 `{`），于是"内容"被当成"模板"二次求值。
 *
 * @type {RegExp}
 */
const TEMPLATE_RE = /\{\{|\}\}|\{([^{}]*)\}/g;

/**
 * @typedef {object} Scope
 * @property {Array<'group'|'private'>} kinds 哪些会话类型生效
 * @property {string[]} ids 白名单；空数组表示不按 id 限制
 * @property {string[]} excludeIds 黑名单，优先级高于白名单
 * @property {boolean} adminOnly 是否只对管理员生效
 */

/**
 * @typedef {object} NormalizedRule
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {string} pattern
 * @property {string} flags 规范化后固定含 `u`
 * @property {string} reply
 * @property {number} priority
 * @property {Scope} scope
 * @property {number} cooldownMs
 * @property {string[]} captureNames
 */

/**
 * @typedef {object} RuleError
 * @property {false} ok
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {object} RuleOk
 * @property {true} ok
 * @property {NormalizedRule} rule
 */

/**
 * 构造一个失败结果。
 *
 * @param {string} code 机器可读错误码
 * @param {string} message 面向人的说明
 * @returns {RuleError}
 */
function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * 取某条规则在报错里的称呼，形如 `第 2 条规则（id=help）`。
 *
 * 序号从 1 开始：用户看到的是列表里的第几条，而不是数组下标。若 id 还没解析
 * 出来就只报序号，避免出现 `id=undefined` 这种二次困惑。
 *
 * @param {unknown} rule 待校验的原始规则
 * @param {number} index 0 起的下标
 * @returns {string}
 */
function ruleLabel(rule, index) {
  const no = Number.isInteger(index) ? index + 1 : '?';
  const rawId = rule && typeof rule === 'object' && !Array.isArray(rule) ? rule.id : undefined;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  return id ? `第 ${no} 条规则（id=${id}）` : `第 ${no} 条规则`;
}

/**
 * 规范化 flags：校验合法性、拒绝有状态的 flag、去重、定序、自动补 `u`。
 *
 * ## 为什么强制补 `u`
 *
 * `u` 模式下 `\p{Script=Han}`、代理对（emoji）、`\u{1F600}` 才是正确语义；不加 `u`
 * 时这些写法要么静默按字面匹配、要么把 emoji 拆成两个码元匹配，规则"看起来对
 * 但匹配不上"。所以无论用户写没写，最终编译都带 `u`。
 *
 * ## 代价（调用方必须知道）
 *
 * `u` 会让一部分非 `u` 下合法的"宽松转义"变成 SyntaxError，比如 `\-`、
 * `\_`、`\A` 这类 identity escape 在 `u` 模式下非法。这属于**变严格**：
 * 会在保存时报错，而不是在运行时悄悄匹配错。
 *
 * @param {unknown} rawFlags
 * @returns {{ ok: true, flags: string } | RuleError}
 */
function normalizeFlags(rawFlags) {
  if (rawFlags === undefined || rawFlags === null) {
    return { ok: true, flags: 'u' };
  }
  if (typeof rawFlags !== 'string') {
    return fail('E_RULE_FLAGS', 'flags 必须是字符串，例如 "i" 或 "im"');
  }

  const chars = Array.from(rawFlags);
  for (const ch of chars) {
    if (ch === 'g' || ch === 'y') {
      return fail(
        'E_RULE_FLAGS',
        `flags 不能包含 ${ch}：${ch} 是有状态的（lastIndex 会跨消息累积），` +
          '会让同一条规则的匹配结果时好时坏。每条消息都会新建正则，不需要它。',
      );
    }
    if (!ALLOWED_FLAGS.includes(ch)) {
      return fail(
        'E_RULE_FLAGS',
        `flags 只允许 i、m、s、u（可组合），收到非法字符 "${ch}"`,
      );
    }
  }

  // 按固定顺序输出，`u` 无条件补上。用集合去重，`iim` 视同 `im`。
  const set = new Set(chars);
  let flags = '';
  for (const ch of ALLOWED_FLAGS) {
    if (ch === 'u' || set.has(ch)) flags += ch;
  }
  return { ok: true, flags };
}

/**
 * 从 pattern 里按出现顺序收集命名捕获组。
 *
 * 不能拿 `\(?<(\w+)>` 一把梭：那会把
 *   - lookbehind `(?<=` / `(?<!` 误当成命名组，
 *   - 字符类里 `[(?<x>]` 的字面文本误当成组，
 *   - 转义后的 `\(?<x>` 误当成组。
 * 所以按字符扫：跳过转义、跳过字符类，只在真正遇到 `(?<` 且第三个字符不是
 * `=` / `!` 时读组名。
 *
 * 重名组在 ES 里只允许出现在互斥分支中，这里按"首次出现"去重，保持模板里
 * `{name}` 的取值为第一个。
 *
 * @param {string} pattern
 * @returns {string[]}
 */
function collectCaptureNames(pattern) {
  /** @type {string[]} */
  const names = [];
  const seen = new Set();
  let inClass = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    // 转义符：连同下一个字符一起跳过，避免把 `\[` 当成字符类开始。
    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }

    if (ch === '(' && pattern[i + 1] === '?' && pattern[i + 2] === '<') {
      const head = pattern[i + 3];
      // `(?<=` `(?<!` 是 lookbehind，不是命名组。
      if (head === '=' || head === '!') continue;

      let j = i + 3;
      let name = '';
      while (j < pattern.length && pattern[j] !== '>') {
        name += pattern[j];
        j += 1;
      }
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      // 跳到 `>`，主循环的 i += 1 会落到它后面。
      i = j;
    }
  }

  return names;
}

/**
 * 解析并规范化 scope。
 *
 * 容错方向是**从严**：写错的范围宁可直接报错，也不能退化成"全开"——
 * 一条本该只在某个群生效的规则，因为字段名打错而变成全群生效，属于越权。
 * 唯一的例外是 `raw` 缺省（没写 scope 就按全开，这是有意的默认值）。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, scope: Scope } | RuleError}
 */
export function normalizeScope(raw) {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      scope: { kinds: [...DEFAULT_KINDS], ids: [], excludeIds: [], adminOnly: false },
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('E_RULE_SCOPE', 'scope 必须是对象，例如 { "kinds": ["group"], "ids": ["123456"] }');
  }

  // ---- kinds：去重后按固定顺序输出 ----
  // 固定顺序（group 在前）而不是保持输入顺序，是为了让规范化结果可做深比较、
  // 也避免"同一个 scope 两种写法"在管理端显示成两条不同的配置。
  let kinds = [...DEFAULT_KINDS];
  if (raw.kinds !== undefined && raw.kinds !== null) {
    if (!Array.isArray(raw.kinds)) {
      return fail('E_RULE_SCOPE', 'scope.kinds 必须是数组，元素只能是 "group" 或 "private"');
    }
    if (raw.kinds.length === 0) {
      return fail('E_RULE_SCOPE', 'scope.kinds 不能为空数组，想全关请把 enabled 设为 false');
    }
    const set = new Set();
    for (const kind of raw.kinds) {
      if (kind !== 'group' && kind !== 'private') {
        return fail(
          'E_RULE_SCOPE',
          `scope.kinds 的元素只能是 "group" 或 "private"，收到 ${JSON.stringify(kind)}`,
        );
      }
      set.add(kind);
    }
    if (set.size === 0) {
      return fail('E_RULE_SCOPE', 'scope.kinds 不能为空数组，想全关请把 enabled 设为 false');
    }
    kinds = DEFAULT_KINDS.filter((k) => set.has(k));
  }

  /** @param {'ids'|'excludeIds'} field */
  const readIdList = (field) => {
    const value = raw[field];
    if (value === undefined || value === null) return { ok: true, list: [] };
    if (!Array.isArray(value)) {
      return fail('E_RULE_SCOPE', `scope.${field} 必须是数组，元素是群号或 QQ 号`);
    }
    if (value.length > LIMITS.maxScopeIds) {
      return fail(
        'E_RULE_SCOPE',
        `scope.${field} 最多 ${LIMITS.maxScopeIds} 项，收到 ${value.length} 项`,
      );
    }
    /** @type {string[]} */
    const list = [];
    const seen = new Set();
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      // 允许直接写数字（JSON 里群号很容易写成数字），统一转字符串再校验。
      const text =
        typeof item === 'string'
          ? item.trim()
          : typeof item === 'number'
            ? String(item)
            : null;
      if (text === null || !NUMERIC_ID_RE.test(text)) {
        return fail(
          'E_RULE_SCOPE',
          `scope.${field} 第 ${i + 1} 项不是合法的群号/QQ 号：${JSON.stringify(item)}（只能是 1–20 位数字）`,
        );
      }
      if (!seen.has(text)) {
        seen.add(text);
        list.push(text);
      }
    }
    return { ok: true, list };
  };

  const idsRes = readIdList('ids');
  if (!idsRes.ok) return idsRes;
  const excludeRes = readIdList('excludeIds');
  if (!excludeRes.ok) return excludeRes;

  // adminOnly 只接受布尔。字符串 "true" 静默转 true 的话，一个手写配置的笔误
  // 就可能把"仅管理员"变成"所有人"——安全相关的字段不接受模糊输入。
  let adminOnly = false;
  if (raw.adminOnly !== undefined && raw.adminOnly !== null) {
    if (typeof raw.adminOnly !== 'boolean') {
      return fail('E_RULE_SCOPE', 'scope.adminOnly 必须是布尔值 true / false');
    }
    adminOnly = raw.adminOnly;
  }

  return {
    ok: true,
    scope: { kinds, ids: idsRes.list, excludeIds: excludeRes.list, adminOnly },
  };
}

/**
 * 校验并规范化单条规则。
 *
 * 只做"单条自身是否自洽"的判断：**不检查 id 重复**——那需要整批视野，由
 * `parseRules` 负责。这样单独测一条规则时不用先造一个数组。
 *
 * 未知字段不报错（向前兼容：新版配置里多出的字段不该让旧版整个拒绝），
 * 但会以不可枚举的 `unknownFields` 记录在返回的规则上，方便管理端提示
 * "这些字段没被识别"。用不可枚举是刻意的：它不该出现在 JSON、展开运算或
 * 深比较里，否则调用方传给宿主的规则会莫名多一个字段。
 *
 * @param {unknown} rule
 * @param {number} [index] 0 起的下标，仅用于错误信息；缺省视为 0
 * @returns {RuleOk | RuleError}
 */
export function validateRule(rule, index = 0) {
  const label = ruleLabel(rule, index);

  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    return fail('E_RULE_SHAPE', `${label}必须是对象，例如 { "id": "help", "pattern": "...", "reply": "..." }`);
  }
  const src = /** @type {Record<string, unknown>} */ (rule);

  // ---- id：必填，且必须是稳定标识 ----
  if (src.id === undefined || src.id === null) {
    return fail('E_RULE_ID', `${label}缺少 id。id 是稳定标识，必须显式给出，格式 ${ID_RE}`);
  }
  if (typeof src.id !== 'string') {
    return fail('E_RULE_ID', `${label}的 id 必须是字符串，格式 ${ID_RE}`);
  }
  const id = src.id.trim();
  if (!ID_RE.test(id)) {
    return fail(
      'E_RULE_ID',
      `${label}的 id 非法："${src.id}"。格式要求：小写字母开头，只含小写字母、数字、下划线、短横线，共 2–41 字符`,
    );
  }

  // ---- name：显示名，缺省用 id ----
  let name = id;
  if (src.name !== undefined && src.name !== null) {
    if (typeof src.name !== 'string') {
      return fail('E_RULE_NAME', `${label}的 name 必须是字符串`);
    }
    const trimmed = src.name.trim();
    // 空串等同于没写：显示名是给人看的，空显示名比用 id 更难辨认。
    if (trimmed.length > 0) {
      if (trimmed.length > 60) {
        return fail('E_RULE_NAME', `${label}的 name 最长 60 字符，收到 ${trimmed.length} 字符`);
      }
      name = trimmed;
    }
  }

  // ---- enabled：只收布尔 ----
  let enabled = true;
  if (src.enabled !== undefined && src.enabled !== null) {
    if (typeof src.enabled !== 'boolean') {
      return fail('E_RULE_ENABLED', `${label}的 enabled 必须是布尔值 true / false，不接受字符串或数字`);
    }
    enabled = src.enabled;
  }

  // ---- pattern：非空、限长、能编译 ----
  if (typeof src.pattern !== 'string') {
    return fail('E_RULE_PATTERN', `${label}的 pattern 必须是字符串`);
  }
  // 不 trim：前导/尾随空格可能是刻意的匹配目标。只拦真正的空串。
  if (src.pattern.length === 0) {
    return fail('E_RULE_PATTERN', `${label}的 pattern 不能为空`);
  }
  if (src.pattern.length > LIMITS.maxPatternLength) {
    return fail(
      'E_RULE_PATTERN',
      `${label}的 pattern 最长 ${LIMITS.maxPatternLength} 字符，收到 ${src.pattern.length} 字符`,
    );
  }

  // ---- flags：规范化后拿到最终 flags，再用它编译 ----
  const flagsRes = normalizeFlags(src.flags);
  if (!flagsRes.ok) {
    return fail(flagsRes.code, `${label}${flagsRes.message}`);
  }
  const flags = flagsRes.flags;

  // 必须用**最终** flags 编译：显式 flag 与自动补的 `u` 都会改变语法
  // （`u` 下 `\p{...}` 合法而 identity escape 非法），只拿用户原始 flags 校验会漏。
  try {
    // eslint-disable-next-line no-new
    new RegExp(src.pattern, flags);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail('E_RULE_PATTERN', `${label}的 pattern 无法编译（flags=${flags}）：${reason}`);
  }

  // ---- reply：模板，非空、限长 ----
  if (typeof src.reply !== 'string') {
    return fail('E_RULE_TEMPLATE', `${label}的 reply 必须是字符串（回复模板）`);
  }
  // 判空看 trim：全空白的回复发出去等于刷屏空气。
  if (src.reply.trim().length === 0) {
    return fail('E_RULE_TEMPLATE', `${label}的 reply 不能为空`);
  }
  if (src.reply.length > LIMITS.maxTemplateLength) {
    return fail(
      'E_RULE_TEMPLATE',
      `${label}的 reply 最长 ${LIMITS.maxTemplateLength} 字符，收到 ${src.reply.length} 字符`,
    );
  }
  // 刻意保留原文（不 trim）：模板作者可能就是要前后空格。这里只校验不加工。
  const reply = src.reply;

  // ---- priority / cooldownMs：只收整数 ----
  // 字符串数字（"10"）不转：竞态与排序里，一个静默转换会让"为什么这条排前面"
  // 无法从配置直接读出来。报错让人改配置更省事。
  let priority = 0;
  if (src.priority !== undefined && src.priority !== null) {
    if (typeof src.priority !== 'number' || !Number.isInteger(src.priority)) {
      return fail(
        'E_RULE_PRIORITY',
        `${label}的 priority 必须是整数（不带引号），范围 ${LIMITS.minPriority}..${LIMITS.maxPriority}`,
      );
    }
    if (src.priority < LIMITS.minPriority || src.priority > LIMITS.maxPriority) {
      return fail(
        'E_RULE_PRIORITY',
        `${label}的 priority 超出范围 ${LIMITS.minPriority}..${LIMITS.maxPriority}，收到 ${src.priority}`,
      );
    }
    priority = src.priority;
  }

  let cooldownMs = LIMITS.defaultCooldownMs;
  if (src.cooldownMs !== undefined && src.cooldownMs !== null) {
    if (typeof src.cooldownMs !== 'number' || !Number.isInteger(src.cooldownMs)) {
      return fail(
        'E_RULE_COOLDOWN',
        `${label}的 cooldownMs 必须是整数毫秒（不带引号），范围 0..${LIMITS.maxCooldownMs}`,
      );
    }
    if (src.cooldownMs < 0 || src.cooldownMs > LIMITS.maxCooldownMs) {
      return fail(
        'E_RULE_COOLDOWN',
        `${label}的 cooldownMs 超出范围 0..${LIMITS.maxCooldownMs}，收到 ${src.cooldownMs}`,
      );
    }
    cooldownMs = src.cooldownMs;
  }

  // ---- scope ----
  const scopeRes = normalizeScope(src.scope);
  if (!scopeRes.ok) {
    return fail(scopeRes.code, `${label}的 ${scopeRes.message}`);
  }

  // ---- 组装 ----
  /** @type {NormalizedRule} */
  const normalized = {
    id,
    name,
    enabled,
    pattern: src.pattern,
    flags,
    reply,
    priority,
    scope: scopeRes.scope,
    cooldownMs,
    captureNames: collectCaptureNames(src.pattern),
  };

  // 未知字段只记录、不报错。不可枚举，理由见函数文档。
  const known = new Set([
    'id', 'name', 'enabled', 'pattern', 'flags', 'reply',
    'priority', 'scope', 'cooldownMs',
  ]);
  const unknownFields = Object.keys(src).filter((key) => !known.has(key));
  if (unknownFields.length > 0) {
    Object.defineProperty(normalized, 'unknownFields', {
      value: unknownFields,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  return { ok: true, rule: normalized };
}

/**
 * 解析用户提交的整批规则。
 *
 * ## 为什么不排序
 *
 * 返回顺序 === 输入顺序。排序是 `sortByPriority` 的职责，由调用方显式决定。
 * 如果这里顺手排了序，报错里的 `index` 就会和用户看到的顺序对不上——
 * 用户按界面第 3 条改了配置，报错却说第 5 条，这比不排序糟糕得多。
 *
 * ## 空规则集是合法的
 *
 * 空串 / null / undefined / `[]` 都返回 `{ ok:true, rules: [] }`。插件刚装上、
 * 用户清空规则、配置还没写好，都是正常状态，不该报错。
 *
 * @param {unknown} raw 规则 JSON 文本，或已解析的数组
 * @param {{ maxRules?: number }} [opts]
 * @returns {{ ok: true, rules: NormalizedRule[] } | { ok: false, code: string, message: string, index?: number }}
 */
export function parseRules(raw, opts = {}) {
  if (raw === undefined || raw === null) {
    return { ok: true, rules: [] };
  }

  let list;
  if (typeof raw === 'string') {
    // 全空白视同"没配"，避免 JSON.parse(' ') 抛出一个难懂的错误。
    if (raw.trim().length === 0) {
      return { ok: true, rules: [] };
    }
    try {
      list = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 'E_RULES_JSON', message: `规则不是合法 JSON：${reason}` };
    }
  } else {
    list = raw;
  }

  if (!Array.isArray(list)) {
    return {
      ok: false,
      code: 'E_RULES_SHAPE',
      message: `顶层必须是规则数组，例如 [ { "id": "help", "pattern": "^帮助$", "reply": "..." } ]，收到 ${Array.isArray(list) ? 'array' : typeof list}`,
    };
  }

  // maxRules 若被传坏（0、负数、字符串），回退默认值：配置层的笔误不该让
  // 所有规则一起失效，而"用默认上限继续"总能给出可用的结果。
  const maxRules =
    Number.isInteger(opts?.maxRules) && opts.maxRules > 0 ? opts.maxRules : LIMITS.maxRules;
  if (list.length > maxRules) {
    return {
      ok: false,
      code: 'E_RULES_LIMIT',
      message: `规则数量超过上限：最多 ${maxRules} 条，收到 ${list.length} 条`,
    };
  }

  /** @type {NormalizedRule[]} */
  const rules = [];
  /** @type {Map<string, number>} id -> 首次出现的下标（0 起） */
  const seenIds = new Map();

  for (let i = 0; i < list.length; i += 1) {
    const res = validateRule(list[i], i);
    if (!res.ok) {
      return { ok: false, code: res.code, message: res.message, index: i };
    }
    const previous = seenIds.get(res.rule.id);
    if (previous !== undefined) {
      return {
        ok: false,
        code: 'E_RULE_ID_DUP',
        message: `${ruleLabel(list[i], i)}的 id "${res.rule.id}" 与第 ${previous + 1} 条重复。id 必须唯一（它是稳定的引用标识）`,
        index: i,
      };
    }
    seenIds.set(res.rule.id, i);
    rules.push(res.rule);
  }

  return { ok: true, rules };
}

/**
 * 判断规则是否适用于某个会话。
 *
 * ## 短路顺序（重要）
 *
 * 按「越便宜、越是否定的判断越靠前」排列：
 *
 * 1. 会话类型不在 `scope.kinds` → false
 * 2. `scope.excludeIds` 命中 → false（黑名单优先于白名单，这样"在 100 个群里
 *    启用，但排除其中 1 个"可以写成白名单 + 排除，不用列 99 个）
 * 3. `adminOnly` 且调用方没明确说 `isAdmin === true` → false（只认严格 true：
 *    `undefined` 表示"不知道是不是管理员"，这种情况必须按否处理，不能放行）
 * 4. 有白名单 `scope.ids` 但没命中 → false
 * 5. 否则 true
 *
 * ## 容错的方向是"收紧"
 *
 * `rule` 没有 `scope` 时按默认全开（这是缺省值的语义）；但 `ctx.convKey` 非法
 * 时一律 false，**不做**"从 isGroup/id 猜一个"的兜底。上下文不完整时放行，
 * 等于把范围限制静默变成全开，正是范围字段要防的事。
 *
 * `ctx.isGroup` / `ctx.senderId` 这里不参与判定：会话类型只从 `convKey` 取，
 * 避免两个来源互相打架；senderId 留给调用方记日志。
 *
 * @param {unknown} rule
 * @param {{ convKey?: string, isGroup?: boolean, id?: string|number, senderId?: string|number, isAdmin?: boolean }} ctx
 * @returns {boolean}
 */
export function inScope(rule, ctx) {
  // `rule` 本身不是对象时返回 false，而**不是**按"没有 scope 就全开"处理。
  // 两者语义不同：`{}` 是一个没写 scope 的规则（全开），`null` 是"调用方传错了"。
  // 传错时必须拒绝——把 null 当全开，等于让一个 bug 变成"所有规则对所有会话生效"。
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return false;

  const context = ctx && typeof ctx === 'object' ? ctx : {};

  const convKey = typeof context.convKey === 'string' ? context.convKey.trim() : '';
  const matched = CONV_KEY_RE.exec(convKey);
  if (!matched) return false;

  const kind = matched[1];
  // 调用方给的 id 更权威（它可能来自事件而不是字符串解析），缺省才回落到 convKey。
  const rawId = context.id;
  const idFromCtx =
    rawId === undefined || rawId === null
      ? ''
      : typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).trim()
        : '';
  const id = idFromCtx || matched[2];
  if (!NUMERIC_ID_RE.test(id)) return false;

  const rawScope = rule.scope;
  const scope =
    rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope) ? rawScope : null;

  const kinds =
    scope && Array.isArray(scope.kinds) && scope.kinds.length > 0 ? scope.kinds : DEFAULT_KINDS;
  const ids = scope && Array.isArray(scope.ids) ? scope.ids.map(String) : [];
  const excludeIds = scope && Array.isArray(scope.excludeIds) ? scope.excludeIds.map(String) : [];
  const adminOnly = scope ? scope.adminOnly === true : false;

  if (!kinds.includes(kind)) return false;
  if (excludeIds.includes(id)) return false;
  if (adminOnly && context.isAdmin !== true) return false;
  if (ids.length > 0 && !ids.includes(id)) return false;
  return true;
}

/**
 * 按优先级降序排序，返回新数组。
 *
 * ## 稳定性是契约的一部分
 *
 * 同优先级的规则必须保持配置里的先后顺序，否则"优先级相同"就失去了可预测性，
 * 用户调整顺序会看到莫名的跳动。这里依赖 `Array.prototype.sort` 的稳定性：
 * ES2019 起规范强制要求稳定排序，V8 在更早的版本也已经稳定。
 *
 * 不改动入参：调用方经常持有"原始配置"和"运行时列表"两份引用。
 *
 * @param {unknown} rules
 * @returns {NormalizedRule[]}
 */
export function sortByPriority(rules) {
  if (!Array.isArray(rules)) return [];
  /** @param {any} r */
  const priorityOf = (r) => (r && Number.isInteger(r.priority) ? r.priority : 0);
  // b - a 即降序。slice 一次再排，入参不受影响。
  return rules.slice().sort((a, b) => priorityOf(b) - priorityOf(a));
}

/**
 * 把数字补到两位。
 *
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 取本地时间的 `HH:mm:ss`。
 *
 * 用 `getHours` 而不是 `getUTCHours`：模板是给群里的人看的，必须跟他们的钟一致。
 * 用 UTC 的话，国内用户会看到 8 小时前的时刻，第一反应是"这插件坏了"。
 *
 * @param {unknown} now 毫秒时间戳或 Date；非法时返回空串
 * @returns {string}
 */
function formatLocalTime(now) {
  let date;
  if (now instanceof Date) {
    date = now;
  } else if (typeof now === 'number' && Number.isFinite(now)) {
    date = new Date(now);
  } else {
    date = new Date();
  }
  if (Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * 把字符串安全地转成模板可用的文本。
 *
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/**
 * 渲染回复模板。
 *
 * 支持的占位符：
 * - `{0}` 整条匹配；`{1}`…`{N}` 第 N 个捕获组（越界或 undefined 都是空串）
 * - `{name}` 命名捕获组优先；否则内置变量 `user` / `userId` / `convKey` /
 *   `convId` / `group` / `ruleId` / `rule` / `time`
 * - `{{` → `{`，`}}` → `}`
 * - 其它 `{xxx}` 一律替换成空串
 *
 * ## 为什么未知变量不报错
 *
 * 模板是运行时素材，写完规则后再改文案很常见；如果保存时因为"多写了个
 * `{foo}`"就拒绝，用户会被迫删掉一句还没想好的文案。渲染成空串既能让规则
 * 立刻可用，也不会把 `{foo}` 原样发到群里（那样更难看）。
 *
 * ## 扫描方式与输出
 *
 * 单次正则扫描，不做二次替换（见 `TEMPLATE_RE` 的注释）。输出**不 trim**：
 * 模板作者可能就想要前后空格或换行。长度不在这里限制，交给 `clampReply`，
 * 免得同一个上限在两个函数里各写一遍。
 *
 * @param {unknown} template
 * @param {{
 *   match?: { full?: string, groups?: unknown[], named?: Record<string, unknown> },
 *   evt?: { user?: string, userId?: string|number, convKey?: string, group?: string },
 *   rule?: { id?: string, name?: string },
 *   now?: number|Date,
 * }} [ctx]
 * @returns {string}
 */
export function renderTemplate(template, ctx = {}) {
  const src = typeof template === 'string' ? template : textOf(template);
  if (!src) return '';

  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const match = context.match && typeof context.match === 'object' ? context.match : {};
  const evt = context.evt && typeof context.evt === 'object' ? context.evt : {};
  const rule = context.rule && typeof context.rule === 'object' ? context.rule : {};

  const full = textOf(match.full);
  const groups = Array.isArray(match.groups) ? match.groups : [];
  const named = match.named && typeof match.named === 'object' ? match.named : {};

  const convKey = textOf(evt.convKey);
  // convId 每次都从 convKey 现推：调用方可能只给 convKey，多一个必填字段只会
  // 让渲染调用方到处补默认值。
  const convId = (() => {
    const m = CONV_KEY_RE.exec(convKey.trim());
    return m ? m[2] : '';
  })();
  const group = textOf(evt.group) || (CONV_KEY_RE.exec(convKey.trim())?.[1] === 'group' ? convId : '');
  const time = formatLocalTime(context.now);

  /**
   * 解析一个变量名。
   *
   * @param {string} key
   * @returns {string}
   */
  const resolve = (key) => {
    // 数字索引放在最前面：`{0}` / `{1}` 是最高频的写法，也别被同名捕获组抢走。
    if (/^\d+$/.test(key)) {
      const n = Number(key);
      if (n === 0) return full;
      const value = groups[n - 1];
      // 越界或未参与匹配的组（undefined）都是空串，而不是字符串 "undefined"。
      return textOf(value);
    }

    // 命名捕获组优先：用户给组起了名，应该能覆盖内置变量。
    if (Object.prototype.hasOwnProperty.call(named, key)) {
      return textOf(named[key]);
    }

    switch (key) {
      case 'user':
        return textOf(evt.user);
      case 'userId':
        return textOf(evt.userId);
      case 'convKey':
        return convKey;
      case 'convId':
        return convId;
      case 'group':
        return group;
      case 'ruleId':
        return textOf(rule.id);
      case 'rule':
        return textOf(rule.name) || textOf(rule.id);
      case 'time':
        return time;
      default:
        // 未知变量 → 空串。见函数文档里"为什么未知变量不报错"。
        return '';
    }
  };

  // replace 的回调签名里，第一个参数是整段命中；`{{` / `}}` 直接返回对应单字符。
  return src.replace(TEMPLATE_RE, (hit, inner) => {
    if (hit === '{{') return '{';
    if (hit === '}}') return '}';
    return resolve(typeof inner === 'string' ? inner : '');
  });
}

/**
 * 限制回复文本长度。
 *
 * ## 为什么按码点切
 *
 * `String.prototype.slice` 按 UTF-16 码元切，会把代理对（emoji、部分扩展
 * 汉字）切成半个——发出去是 `\uFFFD`，或者干脆让 QQ 侧整条消息显示异常。
 * `Array.from` 按码点切就不会切断代理对。
 *
 * 注意这是**码点级**而不是字素簇级：`👨‍👩‍👧`（ZWJ 连接）和带肤色修饰的
 * emoji 仍可能被切在连接符上。要做到字素簇级得用 `Intl.Segmenter`，为本功能
 * 引入这层依赖不划算；只切断"半对代理"已经消除了最严重的乱码。
 *
 * ## 省略号也算在长度里
 *
 * 先留 1 个位置给 `…` 再截，保证返回值总长 ≤ max。否则"截断后仍超长"，
 * 调用方按返回值再校验时会二次截断，末尾出现两个省略号。
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {{ text: string, truncated: boolean }}
 */
export function clampReply(text, max = LIMITS.maxReplyLength) {
  const src = typeof text === 'string' ? text : textOf(text);
  // 上限传坏时回退默认值：宁可长一点，也不要因为一个 undefined 变成空回复。
  const limit = Number.isInteger(max) && max > 0 ? max : LIMITS.maxReplyLength;
  if (src.length === 0) return { text: '', truncated: false };

  // 快路径：码点数 ≤ 码元数，先比一次长度能省掉绝大多数情况的数组化。
  if (src.length <= limit) return { text: src, truncated: false };

  const points = Array.from(src);
  if (points.length <= limit) return { text: src, truncated: false };

  // limit 至少为 1，最差情况返回单个 `…`。
  const body = points.slice(0, Math.max(0, limit - 1)).join('');
  return { text: `${body}…`, truncated: true };
}
