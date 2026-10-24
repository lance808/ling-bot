/**
 * regex-reply —— 正则自动回复（插件接口 v1，in-process 纯通道插件）
 *
 * ## 这个插件做什么
 *
 * 消息先过一遍用户自定义的正则规则：**命中就直接回复，并结束这条消息的
 * 处理（不调用 AI）**；没命中就原样交回宿主，继续走原来的 AI 流程。
 *
 * 它是「纯通道插件」：`tools: []` + `handleMessage: true`。
 * 它不对 AI 暴露任何工具 —— 能力全在"抢占一条消息"上。
 *
 * ## 与宿主的分工（清单里两个字段是前提）
 *
 * - `messagePriority: "low"`：宿主先跑所有 normal 插件（dsh-bridge 的审批
 *   回复、/dsh 指令等归属明确的接管者），再跑本插件。所以**审批回复永远
 *   先被 dsh-bridge 认领**，正则拿不到。顺序由宿主保证，不靠本文件猜。
 * - `validateConfig: true`：宿主在**写盘之前**调用本文件的 `validateConfig()`。
 *   规则写错时保存直接失败、旧配置不被覆盖 —— 这是"无效规则保存时明确报错"
 *   的落点。
 *
 * ## 本文件负责 / 不负责
 *
 * 负责：判定顺序、worker 池与超时降级、冷却与限频、模板渲染、发送。
 * 不负责：规则解析与模板渲染的纯逻辑（`lib/rules.mjs`，由另一位实现者维护）、
 * 正则执行（`lib/regex-worker.mjs`，独立线程）、冷却与限频的数据结构
 * （`lib/limiter.mjs`）。
 *
 * 这样做是因为**正则的执行必须离开主线程**：一条灾难性回溯的正则能让
 * `exec()` 跑几十秒，而本插件与宿主同进程，主线程被占住就等于后端失联。
 * 所以本文件从不直接 `new RegExp(...).exec(...)` 去匹配用户消息
 * （唯一例外是 `testConnection` 里的编译校验，那只是一次 `new RegExp`，
 * 不执行匹配，毫秒级）。
 *
 * ## 一条消息的完整判定顺序
 *
 * 顺序本身是需求，每一条的注释都写了"为什么它在这个位置"。简表：
 *
 * ```
 *  1. 不是消息 / 无文本            → false
 *  2. 自己发的消息                 → false
 *  3. 插件总开关关着               → false
 *  4. 会话不在白名单               → false
 *  5. 宿主静音                     → false
 *  6. 有待确认 + 文本像确认回复     → false（交给审批，不抢）
 *  7. 输入超过 maxInputLength       → false
 *  8. 没有启用的规则               → false
 *  9. 全局限频用满                 → false
 * 10. worker 里按优先级匹配（带超时）→ 超时降级为未命中
 * 11. 按 multiMatch 选出候选
 * 12. 逐条：范围 / 冷却 → 跳过
 * 13. 渲染模板 → clampReply → 发送
 * 14. 成功：占冷却 + 计限频 → true
 * 15. 失败：记 error，**不回退 AI、不重试** → true
 * 16. 至少一条发成功 → true；全被跳过 → false
 * ```
 */

import { Worker } from 'node:worker_threads';

import {
  LIMITS,
  parseRules,
  inScope,
  sortByPriority,
  renderTemplate,
  clampReply,
} from './lib/rules.mjs';
import { CooldownTable, RateLimiter } from './lib/limiter.mjs';

/* ------------------------------------------------------------------ 常量 */

/**
 * 默认配置。
 *
 * 与 `plugin.json` 里的 `default` 一一对应。为什么两处都要写：
 * 清单的 default 是给**宿主表单**用的（用户没填时它填进去），
 * 而这里的默认值是给**插件自己**用的（宿主没给全配置时也要能跑，
 * 单测直接 import 时也需要）。漏了这里的后果是"清单说默认 6，
 * 实际不限频"—— 那种不一致只能靠跑起来才发现。
 *
 * @type {Readonly<Record<string, any>>}
 */
const DEFAULTS = Object.freeze({
  rules: '[]',
  enabled: true,
  defaultCooldownMs: 0,
  maxRepliesPerMinute: 6,
  maxRepliesPerHour: 60,
  maxInputLength: 500,
  matchTimeoutMs: 50,
  multiMatch: 'priority',
  replyOnSendFail: false,
});

/**
 * `multiMatch: 'all'` 时一条消息最多回几条。
 *
 * 3 是宿主插件契约里"一次工具调用最多发 3 条"的同一个数字（见
 * docs/plugin-api.md §5.3）。这里对齐它不是巧合：一条 QQ 消息触发
 * 四五条回复，观感上就是刷屏，而"命中几条回几条"本来就应该由
 * 用户显式选 all 才发生。超出部分只记 debug 日志，不静默。
 */
const MAX_REPLIES_PER_MESSAGE = 3;

/**
 * 超时的规则被跳过多久。
 *
 * 5 分钟是个折中：短到用户改完配置能比较快恢复，长到足以让
 * "反复超时"这件事在日志里留下可辨认的痕量、而不至于每条消息都
 * 卡一次超时预算。这条跳过表是"有界匹配"的第二道保险 ——
 * 第一道是 worker 的 terminate。
 */
const SKIP_TTL_MS = 5 * 60_000;

/**
 * 运行时跳过表的容量上限。
 *
 * 规则上限 64 条，所以正常情况下远不会到 200；设上限是为了防止
 * "规则 id 一直变"这种异常配置把表撑大。
 */
const MAX_SKIP_ENTRIES = 200;

/**
 * worker **启动**（模块加载 + 编译）的独立预算。
 *
 * ## 为什么不能和 matchTimeoutMs 共用
 *
 * 见 `runMatch` 里的注释：新线程要加载 `node:worker_threads` 与
 * `./rules.mjs`，Windows 上实测 20–60ms。而 `matchTimeoutMs` 默认只有 50ms、
 * 允许低到 5ms。把启动时间算进匹配预算，就等于"worker 重建后的第一条消息
 * 大概率被判超时"，而超时会拉黑一条无辜的规则 5 分钟。
 *
 * 所以启动单独计费，取一个宽松到不会误伤、又不至于让进程无限等的值。
 * 它只在**重建**时才会花掉（正常路径下 worker 常驻）。
 */
const WORKER_START_TIMEOUT_MS = 5000;

/**
 * 形似确认回复的文本。
 *
 * ## 为什么用"像"而不是精确匹配
 *
 * 宿主那边的 `parseConfirmReply` 接受 `1` / `2` / `同意` / `拒绝` /
 * `同意 3` 等写法。这里取一个**更宽**的集合：只要文本看起来像是在
 * 回答一张确认卡，本插件就不接管。
 *
 * 放宽的理由是不对称的：漏判一条（当成普通消息去匹配规则）会让用户
 * 以为自己的确认被系统拒绝了；误判一条（明明不是确认却放给宿主）
 * 只是少了一句自动回复，宿主的确认逻辑本来也会说"没有待确认"，
 * 用户再发一次即可。宁可少回一句。
 *
 * ## 为什么词表里还有 DSH 审批的写法
 *
 * 宿主 `gate.confirmPending` 只反映**宿主确认表**（`1` / `2` / `同意` /
 * `拒绝` / `允许` / `取消`）。但同一句「是」「yes」也可能是用户在回答
 * `dsh-bridge` 的审批卡：那边在"有多条待审批"时解析不出编号，会把消息
 * 放回（`parseCommand` 返回 unknown 后 `onMessage` 返回 false），而
 * `dsh-bridge` 是 normal 优先级、此时已经先跑过一轮。若本插件把「是」
 * 当成普通口令回掉，用户会以为自己批了，实际什么都没发生——审批最怕的
 * 就是这种"看起来成功了"。
 *
 * 所以词表取**两边用语的并集**：宁可少回一句自动回复，也不替审批作答。
 *
 * @type {RegExp}
 */
const CONFIRM_WORDS = [
  // 宿主确认表（见 src/guard/confirm.mjs 的 parseConfirmReply）
  '同意', '拒绝', '允许', '取消', '可以', '不行',
  // DSH 审批的动词（见 plugins/dsh-bridge/lib/command.mjs）
  '批准', '通过', '准', '驳回', '确定', '确认',
  '是', '否', 'yes', 'y', 'no', 'n', 'ok', 'allow', 'approve', 'deny', 'reject',
].join('|');

const CONFIRM_LIKE_RE = new RegExp(
  /*
   * 两种顺序都接受，与 dsh-bridge 的 parseCommand 对齐：
   *   「同意」「同意 3」「1」 —— 动词在前（或裸数字 1/2）
   *   「3 同意」「#3 同意」   —— 编号在前
   */
  `^(?:(?:[12])|(?:${CONFIRM_WORDS}))(?:\\s*[#＃]?\\s*(?:\\d+|confirm-[0-9a-z-]+)?)?$` +
    `|^[#＃]?\\d+\\s*(?:${CONFIRM_WORDS})$`,
  'i',
);

/* ------------------------------------------------------------------ 日志 */

/**
 * 把宿主的 `(level, message, fields)` 日志函数包成单参数形式。
 *
 * @param {any} ctx
 * @param {'debug'|'info'|'warn'|'error'} level
 * @returns {(message: string, fields?: object) => void}
 */
function loggerFor(ctx, level) {
  const hostLog = typeof ctx?.log === 'function' ? ctx.log : null;
  return (message, fields) => {
    if (hostLog) {
      hostLog(level, String(message), fields);
      return;
    }
    /*
     * 没有宿主日志时（单测直接 import、或宿主没注入 log）退回 console。
     * 为什么不是静默吞掉：排查"插件明明该回却没回"时，一条 warn 往往
     * 就是全部线索。但只在 debug/error 级别打印，避免热路径刷控制台。
     */
    if (level === 'debug') return;
    // eslint-disable-next-line no-console
    console.log(`[regex-reply/${level}] ${String(message)}`);
  };
}

/* ------------------------------------------------------------------ 配置 */

/**
 * 把配置里的一个数值项夹到合法区间。
 *
 * 宿主保存时已经校验过（清单里声明了 min/max/integer），这里兜底是
 * 为了两种场景：配置被手改过；以及单测直接调 `init()` 不经过宿主。
 * 非法值回退**默认值**而不是最小值 —— 回退最小值会让"配错了"表现为
 * "限频变成 1 条/分钟"，那看起来像插件坏了而不是配置坏了。
 *
 * @param {unknown} raw
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function intInRange(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min || i > max) return fallback;
  return i;
}

/**
 * 读并归一配置。
 *
 * @param {any} ctx
 * @returns {{
 *   rules: string, enabled: boolean, defaultCooldownMs: number,
 *   maxRepliesPerMinute: number, maxRepliesPerHour: number,
 *   maxInputLength: number, matchTimeoutMs: number,
 *   multiMatch: 'priority'|'all', replyOnSendFail: boolean,
 * }}
 */
function readConfig(ctx) {
  const c = ctx?.config ?? {};
  const multiMatch = String(c.multiMatch ?? DEFAULTS.multiMatch) === 'all' ? 'all' : 'priority';
  return {
    rules: typeof c.rules === 'string' ? c.rules : JSON.stringify(c.rules ?? []),
    // 只有显式 false 才算关闭：`undefined`、字符串 'false' 都不该让插件静默失效
    enabled: c.enabled !== false,
    defaultCooldownMs: intInRange(c.defaultCooldownMs, 0, LIMITS.maxCooldownMs, DEFAULTS.defaultCooldownMs),
    maxRepliesPerMinute: intInRange(c.maxRepliesPerMinute, 1, 60, DEFAULTS.maxRepliesPerMinute),
    maxRepliesPerHour: intInRange(c.maxRepliesPerHour, 1, 600, DEFAULTS.maxRepliesPerHour),
    maxInputLength: intInRange(c.maxInputLength, 1, LIMITS.maxInputLength, DEFAULTS.maxInputLength),
    matchTimeoutMs: intInRange(
      c.matchTimeoutMs,
      5,
      LIMITS.maxMatchTimeoutMs,
      DEFAULTS.matchTimeoutMs,
    ),
    multiMatch,
    replyOnSendFail: c.replyOnSendFail === true,
  };
}

/**
 * 配置自检 —— **不依赖 init 建的运行时**。
 *
 * 保存前（宿主 `validateConfig: true`）与「测试连接」按钮都走这里，
 * 因此它必须是纯计算：不建 worker、不发消息、不写文件。
 *
 * @param {unknown} config 宿主编织好的配置（含默认值），或原始的 ctx.config
 * @returns {{ok: boolean, message: string, details?: object}}
 */
function checkConfig(config) {
  const c = config && typeof config === 'object' ? config : {};

  // ---- 1. 数值项范围（宿主已校验，这里做独立自检）----
  /*
   * 只列 `[key, min, max]` 三元组，**不带 fallback**。
   *
   * 早先这里每个都带了个 fallback 值又用 `void fallback` 占位，
   * 那会让读代码的人以为"越界会回退到它"——而本函数是**校验**，
   * 越界就是返回失败，回退是 `readConfig` 的事。两件事别揉在一起。
   */
  const numeric = [
    ['defaultCooldownMs', 0, LIMITS.maxCooldownMs],
    ['maxRepliesPerMinute', 1, 60],
    ['maxRepliesPerHour', 1, 600],
    ['maxInputLength', 1, LIMITS.maxInputLength],
    ['matchTimeoutMs', 5, LIMITS.maxMatchTimeoutMs],
  ];
  for (const [key, min, max] of numeric) {
    const raw = c[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { ok: false, message: `配置无效：${key} 必须是数字（当前 ${JSON.stringify(raw)}）` };
    }
    if (!Number.isInteger(n)) {
      return { ok: false, message: `配置无效：${key} 必须是整数（当前 ${n}）` };
    }
    if (n < min || n > max) {
      return { ok: false, message: `配置无效：${key} 必须在 ${min}..${max} 之间（当前 ${n}）` };
    }
  }

  const multiMatch = c.multiMatch;
  if (multiMatch !== undefined && multiMatch !== 'priority' && multiMatch !== 'all') {
    return {
      ok: false,
      message: `配置无效：multiMatch 只能是 "priority" 或 "all"（当前 ${JSON.stringify(multiMatch)}）`,
    };
  }

  // ---- 2. 规则本身 ----
  const parsed = parseRules(c.rules, { maxRules: LIMITS.maxRules });
  if (!parsed.ok) {
    /*
     * 直接复用 parseRules 的 message。
     *
     * rules.mjs 的报错里已经带了「第 N 条规则（id=xxx）」这个**1 起**的
     * 人类序号（见它的 ruleLabel），再拼一遍会变成
     * 「第 2 条规则：第 2 条规则（id=help）…」。所以这里只加前缀。
     */
    return { ok: false, message: `规则配置无效：${parsed.message}` };
  }

  const rules = parsed.rules;
  const enabledRules = rules.filter((r) => r.enabled);
  const skipped = rules.filter((r) => !r.enabled);

  // ---- 3. 空规则集：合法但不该静默 ----
  if (rules.length === 0) {
    return {
      ok: true,
      message: '规则 0 条：保存后本插件不会回复任何消息（消息全部交给 AI）',
      details: { rules: 0, enabledRules: 0, disabledRules: 0 },
    };
  }
  if (enabledRules.length === 0) {
    return {
      ok: true,
      message: `规则 ${rules.length} 条，但全部是 enabled: false，实际不会回复任何消息`,
      details: { rules: rules.length, enabledRules: 0, disabledRules: skipped.length },
    };
  }

  // ---- 4. 模板试渲染：只为发现"明显问题" ----
  /*
   * 空上下文渲染一次。
   *
   * 这一步**不报错**（未知变量渲染成空串是契约行为），只用来统计
   * "渲染完是空字符串"的规则 —— 一条 reply 全是变量、而变量在空上下文下
   * 都是空的规则，实际发出去会是一条空消息，必然被发送闸门按 E2031 拒掉。
   * 那属于"保存时看不出来、跑起来才发现"的一类问题，值得提示一句。
   *
   * 注意：**不能**因此判失败。规则里写 `{1}` 是完全合理的，命中时就有值。
   * 所以这里只收集、不拦截。
   */
  const emptyRender = [];
  for (const rule of enabledRules) {
    const text = renderTemplate(rule.reply, {
      match: { full: '', groups: [], named: {} },
      evt: { user: '', userId: '', convKey: '', group: '' },
      rule: { id: rule.id, name: rule.name },
      now: Date.now(),
    });
    if (text.trim().length === 0) emptyRender.push(rule.id);
  }

  return {
    ok: true,
    message: `规则 ${rules.length} 条，全部有效（启用 ${enabledRules.length} 条${
      skipped.length > 0 ? `，停用 ${skipped.length} 条` : ''
    }）`,
    details: {
      rules: rules.length,
      enabledRules: enabledRules.length,
      disabledRules: skipped.length,
      /**
       * 空上下文下渲染为空的规则 id。
       *
       * 不是错误，但值得让用户知道：那些规则的回复可能依赖捕获组，
       * 命中时才有内容。真正的发送仍会在发送闸门处按"内容为空"拒绝。
       */
      emptyRenderRules: emptyRender,
    },
  };
}

/* ------------------------------------------------------------------ 运行时 */

/**
 * 插件的运行时单例。
 *
 * ## 为什么是单例
 *
 * worker 线程与冷却/限频表都是**进程级**资源：同一份配置只该有一个 worker，
 * 否则每次 init 都漏一个线程。而宿主对 in-process 插件的加载是单次的
 * （dispose → init 走同一模块实例），所以单例在这里是安全的。
 *
 * ## `handleMessage` 怎么拿到它
 *
 * `handleMessage` 是模块导出的方法，拿不到 init 的参数，所以运行时状态
 * 只能挂在模块级。**但每次调用仍以入参 `ctx` 为准**（配置快照用 init 那份，
 * 因为宿主改配置会 dispose → init；日志和 gate 用当次传入的）。
 */
class Runtime {
  /** init 时归一好的配置 */
  cfg = null;
  /** 排序后的规则（已过滤掉 enabled:false） */
  rules = [];
  /** 全部规则（含停用，用于自检与日志） */
  allRules = [];
  /** 规则级冷却表 */
  cooldowns = null;
  /** 全局限频器 */
  rateLimiter = null;
  /** worker 线程（懒启动） */
  worker = null;
  /** 同一时刻只跑一批：串行化用的 promise 链尾 */
  queue = Promise.resolve();
  /** 批次序号（用于丢弃迟到的回包） */
  seq = 0;
  /** 最近的 begin 报上来的规则 id（超时时用它定位） */
  lastBeginRuleId = '';
  /** 本次 init 挂上的 abort 监听（dispose 时摘掉） */
  detachSignal = null;
  /** 宿主日志（按级别缓存几个函数） */
  log = null;
  /**
   * 超时规则的运行时跳过表：ruleId → 解禁时间戳。
   *
   * 「有界匹配」的第二道保险：worker 的 terminate 保证单次不会卡死，
   * 这张表保证**不会每条消息都卡一次**。没有它的话，一条灾难性回溯的
   * 规则会让每条消息都耗掉整个超时预算 —— 比卡死好，但仍然不可用。
   *
   * @type {Map<string, number>}
   */
  skipUntil = new Map();
}

const rt = new Runtime();

/**
 * 建一个空的运行时（init 失败时也要能安全 dispose）。
 */
function resetRuntime() {
  rt.cfg = null;
  rt.rules = [];
  rt.allRules = [];
  rt.cooldowns = null;
  rt.rateLimiter = null;
  rt.lastBeginRuleId = '';
  rt.skipUntil.clear();
}

/* ------------------------------------------------------------- worker 池 */

/**
 * 取当前可用的规则列表：过滤掉停用的，以及跳过表里未解禁的。
 *
 * @returns {Array<{id: string, pattern: string, flags: string}>}
 */
function dispatchableRules() {
  const now = Date.now();
  /** @type {Array<{id: string, pattern: string, flags: string}>} */
  const out = [];
  for (const rule of rt.rules) {
    const until = rt.skipUntil.get(rule.id);
    if (typeof until === 'number') {
      if (now < until) {
        // 还在跳过期：直接不进 worker。这是让"反复超时"不拖慢每条消息的关键。
        rt.log?.debug(`规则 ${rule.id} 在超时跳过期内，本次不参与匹配`);
        continue;
      }
      rt.skipUntil.delete(rule.id);
    }
    out.push({ id: rule.id, pattern: rule.pattern, flags: rule.flags });
  }
  return out;
}

/**
 * 启动 worker（懒启动、幂等）。
 *
 * ## 为什么用 `new URL('./lib/regex-worker.mjs', import.meta.url)`
 *
 * 插件运行时位于**用户数据目录**（或内置插件目录），路径完全由宿主决定。
 * `__dirname` 在 ESM 里不存在，`process.cwd()` 也不可信。`import.meta.url`
 * 是唯一可靠的锚点 —— 它由模块加载器给出，与当前工作目录无关。
 *
 * `Worker` 直接接受 `URL` 对象，所以**不要**转成路径字符串：
 * Windows 上 `file:///D:/...` → `D:\...` 的转换容易漏掉盘符前多一个斜杠
 * 这类细节，而留着 URL 就绕过了整个问题。
 *
 * @returns {Worker}
 */
function ensureWorker() {
  if (rt.worker) return rt.worker;

  const worker = new Worker(new URL('./lib/regex-worker.mjs', import.meta.url));
  rt.worker = worker;

  /*
   * 常驻监听：只用来抓 `ready` 并记进 READY_WORKERS。
   *
   * 之所以要有一个**常驻**监听，而不是只靠 `whenWorkerReady` 临时挂：
   * worker 的 ready 消息只会发一次，而"挂临时监听"与"消息到达"之间有
   * 一个真实存在的竞态窗口（模块加载极快时尤其明显）。一旦错过，
   * `whenWorkerReady` 就会白等到启动超时 —— 那条消息虽然仍按未命中处理
   * （结果不错），但要慢 5 秒，而且每次重建都会重复一次。
   *
   * 这个监听是同步挂上的（构造函数返回后立刻 attach），早于任何消息
   * 被派发的时机，所以不存在错过。
   */
  worker.on('message', (msg) => {
    if (String(msg?.type ?? '') === 'ready') READY_WORKERS.add(worker);
  });

  /*
   * 正常收尾时 worker 不该自己退出。退出即视为异常：
   * 置空引用，下一次 ensureWorker 会重建 —— 而不是留一个死线程
   * 让后续每条消息都等满超时。
   *
   * 注意"我们自己 terminate 的"要由 killWorker 先登记进 KILLED_WORKERS，
   * 否则每次超时都会紧跟着一条假的"异常退出"error 日志 ——
   * 而那次终止是**我们自己的决定**，不是崩溃。混在一起会淹没真实崩溃。
   */
  worker.on('exit', (code) => {
    if (rt.worker === worker) rt.worker = null;
    if (KILLED_WORKERS.has(worker)) return;
    if (code !== 0) {
      rt.log?.error(`正则 worker 异常退出（code=${code}），本次匹配按未命中处理`, { code });
    }
  });

  worker.on('error', (err) => {
    if (rt.worker === worker) rt.worker = null;
    // 崩溃不是"这条消息不匹配"，而是"这次匹配没结论"。按未命中降级
    // （消息继续走 AI），并留下 error 日志，避免静默变成"插件不工作"。
    // 我们主动 terminate 时也会触发 error 事件，那不算崩溃。
    if (KILLED_WORKERS.has(worker)) return;
    rt.log?.error(`正则 worker 崩溃：${String(/** @type {any} */ (err)?.message ?? err)}`, {
      stack: String(/** @type {any} */ (err)?.stack ?? ''),
    });
  });

  return worker;
}

/**
 * 被我们**主动 terminate** 的 worker 集合。
 *
 * 用 WeakSet 而不是给 worker 加属性：`Worker` 是宿主的类实例，
 * 往外部对象上加字段在升级 Node 时可能撞名；WeakSet 不改变对象形状，
 * 也不会阻止回收。
 *
 * @type {WeakSet<Worker>}
 */
const KILLED_WORKERS = new WeakSet();

/**
 * 已经报告过 ready 的 worker。
 *
 * worker 在模块顶层 `postMessage({type:'ready'})`，但那个消息可能在
 * 我们挂监听**之前**就到达 —— 那时它会被直接丢掉，于是
 * `whenWorkerReady` 会一直等到启动超时。用一个标记把"已经就绪"这件事
 * 记在父侧，就绕开了这个竞态（同时让常驻 worker 的后续调用立刻返回）。
 *
 * @type {WeakSet<Worker>}
 */
const READY_WORKERS = new WeakSet();

/**
 * 等到 worker 报告就绪。
 *
 * ## 为什么要等
 *
 * 见 `WORKER_START_TIMEOUT_MS` 与 `runMatch` 的注释：启动时间不能算进
 * 匹配预算，否则重建后的第一条消息会被误判超时、连累一条无辜规则被拉黑。
 *
 * ## 竞态
 *
 * `ready` 有可能在监听挂上之前就已经到达（模块加载极快时）。所以除了
 * 等消息，还要在挂监听的同时检查一次 `READY_WORKERS` —— 否则会白等到
 * 启动超时，而那条消息又会被当成未命中（这不会错，但会慢 5 秒）。
 *
 * @param {Worker} worker
 * @returns {Promise<void>}
 */
function whenWorkerReady(worker) {
  if (READY_WORKERS.has(worker)) return Promise.resolve();

  return new Promise((resolve) => {
    /** @param {any} msg */
    const onMessage = (msg) => {
      if (String(msg?.type ?? '') !== 'ready') return;
      worker.off('message', onMessage);
      READY_WORKERS.add(worker);
      resolve();
    };
    worker.on('message', onMessage);

    /*
     * worker 在挂监听之前就已经 ready 的竞态：`READY_WORKERS` 由
     * ensureWorker 里那个**常驻**监听到达。这里再查一次覆盖
     * "监听刚好在查完之后才触发"的顺序。
     */
    if (READY_WORKERS.has(worker)) {
      worker.off('message', onMessage);
      resolve();
    }
  });
}

/**
 * 把 worker 丢掉（超时/崩溃后调用）。
 *
 * @param {string} reason
 */
function killWorker(reason) {
  const worker = rt.worker;
  rt.worker = null;
  if (!worker) return;
  // 先登记"这是主动终止"，再 terminate：exit/error 事件是异步的，
  // 但登记必须发生在它触发之前，否则日志里还是会冒出假的"异常退出"。
  KILLED_WORKERS.add(worker);
  // terminate 是唯一能真正打断正在执行的正则的手段。不 await：
  // 它返回的 promise 可能晚于我们需要的时机，而这里的目标只是"别再占 CPU"。
  worker.terminate().catch(() => {});
  rt.log?.warn(`已终止正则 worker：${reason}`);
}

/**
 * 把一条规则加进跳过表。
 *
 * @param {string} ruleId
 * @param {string} reason
 */
function skipRule(ruleId, reason) {
  const id = String(ruleId ?? '');
  if (!id) return;
  if (rt.skipUntil.size >= MAX_SKIP_ENTRIES) {
    // 表满了就清掉已解禁的项；还满就整体清空（它是缓存，丢了只会让
    // 那条规则再试一次，不会丢正确性）。
    const now = Date.now();
    for (const [key, until] of rt.skipUntil) {
      if (now >= until) rt.skipUntil.delete(key);
    }
    if (rt.skipUntil.size >= MAX_SKIP_ENTRIES) rt.skipUntil.clear();
  }
  rt.skipUntil.set(id, Date.now() + SKIP_TTL_MS);
  rt.log?.warn(`规则 ${id} 已加入跳过表 ${SKIP_TTL_MS / 60000} 分钟：${reason}`);
}

/**
 * 在 worker 里跑一批规则，带总预算超时。
 *
 * ## 串行化
 *
 * 同一时刻只允许一批在跑。理由不是性能，而是**正确性**：worker 用 `seq`
 * 区分回包，但 `lastBeginRuleId` 只有一个槽位。两批并发时，"最近 begin 的
 * 是哪条规则"会串到另一批身上 —— 超时后拉黑的可能是无辜的规则。
 * 串行化把这个问题从"需要小心处理"变成"不存在"。
 *
 * ## 超时 → terminate → 降级为未命中
 *
 * 这里刻意**不重试**、也不把"超时"当成错误返回给用户。理由：
 * 超时说明这条规则在这段输入上是病态的，重试只会再卡一次；
 * 而降级为未命中意味着这条消息继续走 AI —— 用户至少还能得到回复，
 * 而不是石沉大海。同时把超时的那条规则拉黑 5 分钟，让后续消息不再
 * 每条都付一次超时代价。
 *
 * ## 用 `lastBeginRuleId` 定位超时规则
 *
 * worker 被杀之后没法再问它"卡在哪条"，唯一的信息来源是超时**之前**
 * 收到的 `begin`。所以 worker 必须在 `exec()` 之前先报 begin
 * （见 regex-worker.mjs 的注释）。
 *
 * @param {string} input
 * @param {number} timeoutMs
 * @returns {Promise<{ok: true, hits: Array<{ruleId: string, full: string, groups: string[], named: Record<string,string>}>, errors: Array<{ruleId: string, message: string}>} | {ok: false, timedOut: true, ruleId: string}>}
 */
function runMatch(input, timeoutMs) {
  const rules = dispatchableRules();
  if (rules.length === 0) return Promise.resolve({ ok: true, hits: [], errors: [] });

  // 链到队列尾部：保证同一时刻只有一批在 worker 里。
  const task = rt.queue.then(
    () =>
      new Promise((resolve) => {
        let worker;
        try {
          worker = ensureWorker();
        } catch (err) {
          // 连线程都起不来（极端环境，例如线程数上限）：降级为未命中，
          // 而不是让这条消息彻底失败。
          rt.log?.error(`无法启动正则 worker：${String(/** @type {any} */ (err)?.message ?? err)}`);
          resolve({ ok: true, hits: [], errors: [] });
          return;
        }

        /*
         * 先等 worker 就绪，**之后才开始计 matchTimeoutMs**。
         *
         * ## 为什么这个先后顺序是必须的
         *
         * 新起一个 worker 要付模块加载与编译的代价（Windows 上实测 20–60ms）。
         * 如果把它算进 50ms 的匹配预算，那么 worker 重建后的**第一条消息**
         * 会有一半概率被判超时 —— 而超时的后果是把一条完全无辜的规则
         * 拉黑 5 分钟。用户看到的是"某条正则偶尔写坏之后，别的规则也跟着
         * 时好时坏"，且毫无规律。启动与匹配必须分开计费。
         *
         * 启动本身也要有上限（WORKER_START_TIMEOUT_MS）：worker 起不来时
         * 不能无限等，否则那条消息就永远没有结论。
         */
        const startTimer = setTimeout(() => {
          killWorker(`worker 启动超时 ${WORKER_START_TIMEOUT_MS}ms`);
          resolve({ ok: true, hits: [], errors: [] });
        }, WORKER_START_TIMEOUT_MS);
        if (typeof startTimer.unref === 'function') startTimer.unref();

        whenWorkerReady(worker).then(() => {
          clearTimeout(startTimer);
          startBatch(worker);
        });

        /**
         * 真正跑一批（worker 已就绪）。
         *
         * @param {Worker} w
         */
        function startBatch(w) {
          const seq = ++rt.seq;
          rt.lastBeginRuleId = '';

          /** 本次批次的命中 */
          const hits = [];
          /** 本次批次的编译/执行错误 */
          const errors = [];
          /** 是否已经收尾（防 done 与 timeout 双结算） */
          let settled = false;

          /**
           * 收尾：摘监听、清定时器、resolve。
           *
           * 不清监听的话，被杀 worker 的迟到消息会继续走进来，
           * 而这时 `rt.worker` 已经指向新实例 —— 老的 result 会被当成新的。
           * `settled` + 序号校验双保险。
           *
           * @param {any} value
           */
          const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            w.off('message', onMessage);
            resolve(value);
          };

          /**
           * @param {any} msg
           */
          const onMessage = (msg) => {
            // 迟到的其它批次消息：直接丢。串行化之下正常不会出现，
            // 但 terminate 之后的重建窗口里有可能。
            if (Number(msg?.seq) !== seq) return;

            const type = String(msg?.type ?? '');
            if (type === 'begin') {
              rt.lastBeginRuleId = String(msg?.ruleId ?? '');
              return;
            }
            if (type === 'result') {
              if (msg?.hit === true) {
                hits.push({
                  ruleId: String(msg?.ruleId ?? ''),
                  full: String(msg?.full ?? ''),
                  groups: Array.isArray(msg?.groups) ? msg.groups.map(String) : [],
                  named:
                    msg?.named && typeof msg.named === 'object'
                      ? Object.fromEntries(Object.entries(msg.named).map(([k, v]) => [k, String(v)]))
                      : {},
                });
              }
              return;
            }
            if (type === 'error') {
              errors.push({
                ruleId: String(msg?.ruleId ?? ''),
                message: String(msg?.message ?? '未知错误'),
              });
              return;
            }
            if (type === 'done') finish({ ok: true, hits, errors });
          };

          w.on('message', onMessage);

          // 定时器不钉住进程：后端退出时不该被这个计时器拖住。
          const timer = setTimeout(() => {
            const timedOutRuleId = rt.lastBeginRuleId;
            /*
             * 先杀 worker 再 resolve。
             *
             * 顺序有意义：resolve 之后调用方会立即返回 false 让宿主走 AI，
             * 而如果那时 worker 还在占着 CPU，整个后端仍会卡顿 ——
             * 用户会觉得"插件把机器人搞慢了"。terminate 实测能在百毫秒内
             * 中断灾难性回溯。
             */
            killWorker(`匹配超时 ${timeoutMs}ms（规则 ${timedOutRuleId || '未知'}）`);
            if (timedOutRuleId) {
              skipRule(timedOutRuleId, '匹配超时，已自动跳过');
            }
            finish({ ok: false, timedOut: true, ruleId: timedOutRuleId });
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();

          try {
            w.postMessage({ seq, rules, input });
          } catch (err) {
            // postMessage 失败（worker 已死）同样按未命中降级
            rt.log?.error(`向 worker 投递失败：${String(/** @type {any} */ (err)?.message ?? err)}`);
            finish({ ok: true, hits: [], errors: [] });
          }
        }
      }),
  );

  // 队列尾部永远指向"这一批结束之后"，无论成功失败都要往下走。
  rt.queue = task.then(
    () => {},
    () => {},
  );
  return task;
}

/* ---------------------------------------------------------------- 判定 */

/**
 * 取消息的会话 id（纯数字）。
 *
 * `inScope` 要的是纯数字（群号/QQ 号），而 evt 上只有 convKey。
 * 这里从 convKey 解析；解析不出来就返回空串，让 `inScope` 自己拒绝 ——
 * **不要**退化成"猜一个 id"，那会让范围限制在数据不全时变成全开。
 *
 * @param {object} evt
 * @returns {string}
 */
function convIdOf(evt) {
  const convKey = String(evt?.convKey ?? '');
  const idx = convKey.indexOf(':');
  if (idx < 0) return '';
  return convKey.slice(idx + 1);
}

/**
 * 处理一条 QQ 消息。返回 true = 已接管，宿主不再走 AI 回合。
 *
 * ## 判定顺序就是需求
 *
 * 下面每一步的注释都写明了"为什么排在这里"。总原则有两条：
 *
 * 1. **便宜的、纯否定的判断在前**：一条群消息里 99% 不命中任何规则，
 *    所以"不是消息/自己发的/开关关着/不在白名单/静音/没规则"这些
 *    零成本的判断必须先跑，不能先花 50ms 去跑正则。
 * 2. **宿主的事实判断在前**：白名单、静音、待确认这三件事的状态只在
 *    宿主手里（插件读不到配置、也读不到确认表），所以宿主通过 `gate`
 *    传进来。它们必须排在**任何语义判断**之前 —— 一旦插件先回了一句，
 *    宿主后面的闸门就没有机会执行了（消息已经被认定为"已处理"）。
 *
 * @param {{evt: object, sendText: (convKey: string, text: string) => Promise<any>, ctx: any, gate?: object}} input
 * @returns {Promise<boolean>}
 */
async function onMessage({ evt, sendText, ctx, gate }) {
  const cfg = rt.cfg;
  const logDebug = loggerFor(ctx, 'debug');
  const logInfo = loggerFor(ctx, 'info');
  const logWarn = loggerFor(ctx, 'warn');
  const logError = loggerFor(ctx, 'error');

  /* ---- 1. 必须是带文本的消息 ------------------------------------------ */
  /*
   * 放在第一位：`evt.kind` 不是 'message'（自己发的、拍一拍、撤回、请求、
   * 元事件）时，后面所有判断都无从谈起，而这一步是零成本的。
   */
  if (String(evt?.kind ?? '') !== 'message') return false;
  const text = typeof evt?.text === 'string' ? evt.text : '';
  if (text.trim().length === 0) return false;

  /* ---- 2. 自己发的消息 ------------------------------------------------ */
  /*
   * 自消息必须无条件放过，原因和"白名单"不同：它不是权限问题，而是
   * **必然的自激循环**。如果机器人自己发的消息能被正则命中，一条
   * "检测到 X 就回复 Y"的规则会让它回 Y，而 Y 又可能命中另一条规则……
   * 宿主上游其实已经过滤过自消息（`kind: 'self-sent'`），这里再判一次
   * 是因为 `gate.selfId` 是宿主给的权威事实，而"上游过滤过了"这件事
   * 会随宿主重构而变。多一次判断，代价是一行 if。
   */
  const selfId = String(gate?.selfId ?? '');
  const senderId = String(evt?.sender?.userId ?? '');
  if (selfId && senderId && selfId === senderId) {
    logDebug('跳过：这是机器人自己发的消息');
    return false;
  }

  /* ---- 3. 插件总开关 -------------------------------------------------- */
  /*
   * 配置里的 `enabled: false` 是"临时静默"。它的语义必须与"停用插件"
   * 区分开：停用是卸载能力（宿主不再派发），静默是**保留规则配置、
   * 只关掉自动回复**，消息全部交给 AI。所以插件内部还要再看一眼。
   */
  if (!cfg || cfg.enabled !== true) return false;

  /* ---- 4. 白名单 ------------------------------------------------------ */
  /*
   * 宿主在这条消息上判不过白黑名单时，正则一律不参与。
   *
   * 为什么这条要排在冷却/限频之前：白名单不通过的会话，本来就不该
   * 被自动回复（否则等于用"正则插件"绕开了"谁能命令机器人"这张表）。
   * 而它又不该消耗限频额度 —— 先判白名单，可以让额度留给真正要回的会话。
   *
   * `gate.whitelisted` 为 **undefined** 时不拦截：那是"宿主没给这个字段"
   * （例如直接跑单测），而宿主侧最后一道发送闸门仍会拦下不该发的消息。
   * 这与 `silenced` 的处理刻意不同，见下一条。
   */
  if (gate && gate.whitelisted === false) {
    logDebug('跳过：会话未通过宿主白黑名单');
    return false;
  }

  /* ---- 5. 静音 -------------------------------------------------------- */
  /*
   * 静音优先于一切语义判断，与宿主静音闸门同口径。
   *
   * 为什么它必须排在"规则匹配"之前：静音是用户明确表达的"别说话"。
   * 如果先匹配再判静音，结果一样，但代价是白跑一次正则；
   * 更糟的是如果顺序写反成"静音放在发送前"，一条命中规则的消息会
   * 先把限频额度与冷却位吃掉，然后才被静音拦下 —— 静音期间额度被
   * 空耗，解除静音后反而回不动了。
   *
   * 与白名单相反，`silenced` 缺省按 false：宿主没给这个字段时
   * 我们**不能**假设"静音"（那会让插件永远不说话），假设"未静音"
   * 是唯一能让插件工作的选择，而宿主发送闸门仍会拦下不该发的。
   */
  if (gate?.silenced === true) {
    logDebug('跳过：宿主处于静音状态');
    return false;
  }

  /* ---- 6. 有待确认时的确认形文本 -------------------------------------- */
  /*
   * 宿主还有待处理的确认（审批卡、提问卡），而这条文本看起来像是在
   * 回答它 —— 交给宿主，不抢。
   *
   * ## 为什么这条排在规则匹配之前
   *
   * 一旦本插件回了 true，宿主就不会再执行它自己的确认处理（见
   * src/index.mjs 的 dispatchToPlugins）。所以"可能是给宿主的"这条
   * 判断必须在**任何回 true 的可能之前**完成。放到发送前再判已经晚了：
   * 那时消息已经被认定为已处理。
   *
   * ## 为什么还要看文本形状
   *
   * `confirmPending` 取的是宽口径（本会话本人名下有未结算的确认就为 true）。
   * 如果无条件据此放弃，用户在看确认卡的这段时间里，所有正常发言都会
   * 失去自动回复 —— 那是把"别抢审批"扩大成了"有审批时插件停摆"。
   * 所以只让**形似确认回复**的文本退让。放宽的判据见 CONFIRM_LIKE_RE 的注释：
   * 漏判比误判糟得多。
   */
  if (gate?.confirmPending === true && CONFIRM_LIKE_RE.test(text.trim())) {
    logDebug('跳过：宿主有待确认，且这条文本形似确认回复');
    return false;
  }

  /* ---- 7. 输入长度 ---------------------------------------------------- */
  /*
   * 超过 `maxInputLength` 整条不匹配。
   *
   * 理由不是"长了就不算指令"，而是正则的代价随文本长度增长：一条
   * 写坏的规则配上一段 3000 字的转发文本，足以把超时预算吃满。
   * 长度闸门让"最坏情况"在进入 worker 之前就被掐掉，比只靠超时兜底
   * 更便宜，而且用户能看到明确的配置项（`maxInputLength`）。
   *
   * 注意它排在规则匹配之前但排在 gate 之后：白名单/静音是硬事实，
   * 长度只是"这条消息不值当匹配"。先让硬事实否决，日志才说得清原因。
   */
  if (text.length > cfg.maxInputLength) {
    logDebug(`跳过：消息长度 ${text.length} 超过上限 ${cfg.maxInputLength}`);
    return false;
  }

  /* ---- 8. 没有启用的规则 ---------------------------------------------- */
  if (rt.rules.length === 0) return false;

  /*
   * 到了这一步才开始花时间。后面的判断都可能有成本（worker 往返、
   * 发送），所以先确认"发送通道可用"—— 没有通道就没必要匹配。
   */
  const send = typeof sendText === 'function' ? sendText : null;
  if (!send) {
    logWarn('没有可用的发送通道（sendText 缺失），跳过匹配');
    return false;
  }

  /* ---- 9. 全局限频（只查不占） ---------------------------------------- */
  /*
   * 额度用满 → 整条消息交给 AI（返回 false），而不是静默丢弃。
   *
   * ## 为什么是"整条"而不是"这条规则"
   *
   * 限频是**全局**的，与是哪条规则无关：额度已经用完，换一条规则也发不出去。
   * 所以这一层在匹配之前判，省掉一次 worker 往返。
   *
   * ## 为什么用 check() 而不是 take()
   *
   * 配额回答的是"已经发出去几条"。一次发送失败什么都没发出去，
   * 不该吃掉额度（否则网络抖一下，接下来一分钟全被自己限没）。
   * 所以这里只查，发送成功后才 take()。代价是并发窗口里可能多发一条，
   * 见 lib/limiter.mjs 的说明。
   */
  const quota = rt.rateLimiter.check();
  if (!quota.ok) {
    logDebug(`跳过：${quota.code} ${quota.message}`);
    return false;
  }

  /* ---- 10. 在 worker 里匹配（带总预算超时） --------------------------- */
  const matched = await runMatch(text, cfg.matchTimeoutMs);

  if (matched.ok !== true) {
    /*
     * 超时 → **降级为未命中**。
     *
     * 为什么不报错、不重试、也不把"超时"告诉用户：
     *   · 重试只会让同一条病态规则再卡一次；
     *   · 这条消息的最佳归宿是继续走 AI —— 用户至少还能得到一次回复，
     *     而"插件卡住了所以你没收到任何回复"是更糟的结果；
     *   · 超时的那条规则已经进跳过表（killWorker 之后 skipRule），
     *     所以代价只付一次。
     */
    logWarn(
      matched.ruleId
        ? `匹配超时，已降级为未命中（规则 ${matched.ruleId} 已跳过 5 分钟）`
        : '匹配超时，已降级为未命中',
    );
    return false;
  }

  // 编译/执行出错的规则只记日志：一条写坏的正则不该让整批失效。
  for (const err of matched.errors) {
    logWarn(`规则 ${err.ruleId || '(未知)'} 匹配出错，已跳过：${err.message}`);
  }

  if (matched.hits.length === 0) return false;

  /*
   * 把命中结果映射回规则对象。worker 只回报 id + 捕获组，
   * 规则本体（模板、范围、冷却）留在主线程 —— 这样 worker 的消息
   * 大小可控，而策略变更不需要动 worker。
   */
  /** @type {Map<string, any>} */
  const byId = new Map(rt.rules.map((r) => [r.id, r]));
  /** @type {Array<{rule: any, match: {full: string, groups: string[], named: Record<string,string>}}>} */
  const hits = [];
  for (const hit of matched.hits) {
    const rule = byId.get(hit.ruleId);
    if (!rule) continue;
    hits.push({ rule, match: { full: hit.full, groups: hit.groups, named: hit.named } });
  }
  if (hits.length === 0) return false;

  /* ---- 11. 按 multiMatch 选候选 --------------------------------------- */
  /*
   * worker 已按优先级顺序返回，所以这里可以直接取前 N 条。
   * 顺序本身依赖 `sortByPriority`（稳定排序、priority 降序），
   * 由 init 保证；这里不再排一次，避免两处排序规则将来不一致。
   */
  let candidates = hits;
  if (cfg.multiMatch !== 'all') {
    candidates = hits.slice(0, 1);
    if (hits.length > 1) {
      logDebug(
        `同时命中 ${hits.length} 条规则，按 priority 只回最高一条（${hits[0].rule.id}），其余忽略：${hits
          .slice(1)
          .map((h) => h.rule.id)
          .join(', ')}`,
      );
    }
  } else if (hits.length > MAX_REPLIES_PER_MESSAGE) {
    /*
     * all 模式下截断到 3 条。
     *
     * 截断而不是"降级成只发第一条"：用户显式选了 all，说明他要多回；
     * 截断至少按优先级给出最该发的那几条。剩余只记日志，不静默 ——
     * "我配了五条规则，怎么只回三条"必须有据可查。
     */
    logInfo(
      `同时命中 ${hits.length} 条规则，按上限只回前 ${MAX_REPLIES_PER_MESSAGE} 条，其余忽略：${hits
        .slice(MAX_REPLIES_PER_MESSAGE)
        .map((h) => h.rule.id)
        .join(', ')}`,
    );
    candidates = hits.slice(0, MAX_REPLIES_PER_MESSAGE);
  }

  /* ---- 12~15. 逐条：范围 → 冷却 → 渲染 → 发送 ------------------------ */
  const scopeCtx = {
    convKey: String(evt?.convKey ?? ''),
    isGroup: evt?.isGroup === true,
    // inScope 要纯数字 id；解析不出来给空串，让它自己按"非法"拒绝
    id: convIdOf(evt),
    senderId,
    /*
     * 管理员身份只能由宿主给（`gate.isAdmin`）。
     *
     * ## 为什么必须 fail-closed
     *
     * `scope.adminOnly` 是安全相关的限制。如果宿主没给 isAdmin 就当成
     * "管理员"，一条"只有管理员能用"的规则会对所有人生效 —— 而宿主没给
     * 字段这件事（版本没跟上、字段被改名）本身是可能的。
     * 所以这里只在 `=== true` 时认管理员，缺省一律按非管理员，
     * 结果是"规则不生效"，而不是"规则对所有人放开"。
     */
    isAdmin: gate?.isAdmin === true,
  };

  /** 本批是否至少成功发出了一条 */
  let anySent = false;
  /** 本批是否至少有一条**本该发**但被跳过 */
  let anySkipped = false;

  for (const { rule, match } of candidates) {
    /* ---- 12a. 范围 ---- */
    if (!inScope(rule, scopeCtx)) {
      anySkipped = true;
      logDebug(`规则 ${rule.id} 不适用于本会话（scope），跳过`);
      continue;
    }

    /* ---- 12b. 规则级冷却（只查不占） ---- */
    /*
     * 冷却 key 是 `${ruleId}@${convKey}`：冷却的粒度是"这条规则在这个会话里"。
     * 不用全局冷却（一个群回过，别的群就回不了）也不用纯规则（同一条规则
     * 在两个群里各回一条是合理的）。
     *
     * 规则自己写了 cooldownMs 就用它，否则回落到全局 defaultCooldownMs。
     * 注意 rules.mjs 把"没写"归一成 0，所以无法区分"显式 0"与"未填 0"；
     * 代价是显式写 `cooldownMs: 0` 的规则也会吃全局默认。这个偏差是
     * 已知且可接受的：显式 0 的意图是"不冷却"，而默认值通常也是 0。
     */
    const cooldownMs = rule.cooldownMs > 0 ? rule.cooldownMs : cfg.defaultCooldownMs;
    const cooldownKey = `${rule.id}@${scopeCtx.convKey}`;
    const cd = rt.cooldowns.check(cooldownKey, cooldownMs);
    if (!cd.ok) {
      anySkipped = true;
      logDebug(`规则 ${rule.id} 冷却中（还剩 ${cd.retryAfterMs}ms），跳过`);
      continue;
    }

    /* ---- 13a. 渲染模板 ---- */
    /*
     * 渲染失败（模板里有病态的构造）不该让整批挂掉：
     * 记 warn 跳过这一条，其它命中的规则继续。
     */
    let rendered;
    try {
      rendered = renderTemplate(rule.reply, {
        match,
        evt: {
          user: String(evt?.sender?.nickname ?? ''),
          userId: senderId,
          convKey: scopeCtx.convKey,
          group: evt?.isGroup === true ? scopeCtx.id : '',
        },
        rule: { id: rule.id, name: rule.name },
        now: Date.now(),
      });
    } catch (err) {
      logWarn(`规则 ${rule.id} 模板渲染失败，跳过：${String(/** @type {any} */ (err)?.message ?? err)}`);
      anySkipped = true;
      continue;
    }

    /* ---- 13b. 截断 ---- */
    /*
     * 上限用 LIMITS.maxReplyLength（4000），与宿主"单条文本最长 4000 字"
     * 的闸门一致。不截断的话，超长回复会被宿主整条拒绝 —— 那对用户
     * 表现为"规则命中了但什么都没发生"。
     *
     * 截断要有痕迹：debug 级记一行，排查时能看到是哪条规则超长了。
     */
    const { text: outText, truncated } = clampReply(rendered, LIMITS.maxReplyLength);
    if (truncated) {
      logDebug(`规则 ${rule.id} 的回复超长，已截断到 ${LIMITS.maxReplyLength} 字`);
    }

    /*
     * 空回复不发。
     *
     * 模板可能全部由变量组成（`{1}` 之类），而这次匹配里那些组恰好是空的。
     * 发一条空消息会被宿主的发送闸门按"内容为空（E2031）"拒绝，
     * 徒增一条错误日志；直接跳过更干净，也不影响"是否接管"的判断
     * （这条规则等于没命中）。
     */
    if (outText.trim().length === 0) {
      logDebug(`规则 ${rule.id} 渲染结果是空文本，跳过发送`);
      anySkipped = true;
      continue;
    }

    /* ---- 13c. 发送 ---- */
    let sendResult;
    try {
      sendResult = await send(scopeCtx.convKey, outText);
    } catch (err) {
      sendResult = { ok: false, message: String(/** @type {any} */ (err)?.message ?? err) };
    }

    const ok = sendResult?.ok !== false && sendResult !== false;

    if (ok) {
      /* ---- 14. 成功：占冷却 + 计限频 ---- */
      /*
       * 顺序是"先发出去了，才记账"。
       *
       * 冷却与限频都在这里才占用，而不是在检查时 —— 理由见
       * lib/limiter.mjs 的 check/take 注释：失败不该白吃额度。
       */
      rt.cooldowns.take(cooldownKey, cooldownMs);
      rt.rateLimiter.take();

      anySent = true;
      logInfo(
        `已按规则 ${rule.id} 回复 ${scopeCtx.convKey}${truncated ? '（回复已截断）' : ''}`,
        { ruleId: rule.id, convKey: scopeCtx.convKey, length: outText.length },
      );
      continue;
    }

    /* ---- 15. 失败：不回退 AI、不重试 ---- */
    /*
     * ## 为什么"不回退 AI"是硬规则
     *
     * 回退给 AI 意味着：这条消息会被当成没被处理，AI 会**再回一遍**。
     * 而用户看到的是两条回复，其中一条还是"被拒绝的那条的替代品"。
     * 重复比缺失更糟：缺失时用户会再问一次，重复时用户会怀疑机器人坏了。
     *
     * 同理不重试：发送失败的原因几乎都是"现在不允许发"（限流 E2030、
     * 白名单 E20XX、审计 E2020）。这些是**状态**，不是瞬时故障；
     * 立刻重试只会再被拒一次，还可能把审计流水刷满。
     *
     * 而"闸门拒绝"本来就不该由 AI 补发：闸门拒绝的是这条消息，
     * 不是"这个插件"。绕过它去让 AI 发，等于用 AI 通道规避发送审计 ——
     * 那正是不能做的事。
     *
     * ## 为什么仍然返回 true
     *
     * 已经命中并尝试发送，这条消息的归属就在本插件。返回 false 会让
     * 宿主继续走 AI，那就是上面说的重复回复。
     */
    logError(
      `规则 ${rule.id} 回复发送失败：${String(sendResult?.code ?? '')} ${String(
        sendResult?.message ?? '未知原因',
      )}`.trim(),
      { ruleId: rule.id, code: sendResult?.code ?? '', message: sendResult?.message ?? '' },
    );
    anySent = true;

    if (cfg.replyOnSendFail) {
      /*
       * 可选的"补一条提示"。
       *
       * 默认关闭：失败提示自己也要走同一道闸门，闸门拒绝时这条提示
       * 大概率同样发不出去，结果只是多一条错误日志；而且多数用户
       * 不需要知道"有个自动回复没发出去"。
       *
       * 打开时也只用 `catch` 包住、不发第二遍 —— 它是一条提示，
       * 不是重试。
       */
      try {
        await send(scopeCtx.convKey, `（自动回复未发出：${String(sendResult?.code ?? '发送失败')}）`);
      } catch {
        /* 提示失败就彻底算了，不递归 */
      }
    }
  }

  /* ---- 16. 汇总 ------------------------------------------------------- */
  /*
   * 有任何一条成功（或已尝试发送但失败）→ 接管，不再走 AI。
   * 全部因范围/冷却被跳过 → 交回宿主（继续走 AI）。
   *
   * "被跳过"与"发送失败"的区别很重要：前者是**本来不该回**，
   * 所以消息该继续走 AI；后者是"该回但没发出去"，消息归属已经定了。
   */
  if (anySent) return true;
  if (anySkipped) {
    logDebug('命中规则全部因范围/冷却被跳过，交回宿主继续走 AI');
    return false;
  }
  return false;
}

/* ---------------------------------------------------------------- 生命周期 */

/**
 * 初始化：解析配置 → 编译规则 → 建限流器。
 *
 * ## 为什么在这里编译规则
 *
 * `parseRules` 会把每条规则的 pattern 用最终 flags 编译一次（见
 * rules.mjs 的 validateRule）。也就是说"正则写错"在 init 就会暴露，
 * 而不是等到第一条消息来了才发现。配置非法时返回 `E4062`，宿主据此
 * 把插件标成「待配置/初始化失败」—— 比"装上了但什么都不做"好排查。
 *
 * ## 为什么不在这里创建 worker
 *
 * worker 是**懒启动**的：一个插件装好但规则为空（或者用户只是启用看看）
 * 时，没必要先占一个线程。`runMatch` 里第一次用到才建。
 *
 * @param {any} ctx
 * @returns {Promise<{ok: boolean, code?: string, message: string}>}
 */
async function init(ctx) {
  const cfg = readConfig(ctx);
  rt.cfg = cfg;
  rt.log = {
    debug: loggerFor(ctx, 'debug'),
    info: loggerFor(ctx, 'info'),
    warn: loggerFor(ctx, 'warn'),
    error: loggerFor(ctx, 'error'),
  };

  // 列表与表都重建：init 意味着"这套配置从头生效"，沿用旧表会让
  // 改配置之前的冷却/计数影响新配置（例如把冷却从 60s 改成 0 之后，
  // 旧记录还在，规则仍然回不了）。
  rt.skipUntil.clear();

  const check = checkConfig(ctx?.config ?? {});
  if (!check.ok) {
    resetRuntime();
    return { ok: false, code: 'E4062', message: check.message };
  }

  const parsed = parseRules(cfg.rules, { maxRules: LIMITS.maxRules });
  if (!parsed.ok) {
    // 理论上不可达（checkConfig 已解析过），但配置可能在两次调用之间被改。
    resetRuntime();
    return { ok: false, code: 'E4062', message: `规则配置无效：${parsed.message}` };
  }

  rt.allRules = parsed.rules;
  // 只保留启用的规则，并按 priority 降序（稳定）。顺序即"谁先匹配"。
  rt.rules = sortByPriority(parsed.rules.filter((r) => r.enabled));

  rt.cooldowns = new CooldownTable();
  rt.rateLimiter = new RateLimiter({
    maxPerMinute: cfg.maxRepliesPerMinute,
    maxPerHour: cfg.maxRepliesPerHour,
  });

  // 宿主停用插件时 abort ctx.signal：顺手放掉 worker，不让它占着线程。
  if (ctx?.signal && typeof ctx.signal.addEventListener === 'function' && !rt.detachSignal) {
    const onAbort = () => {
      killWorker('插件停用');
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    rt.detachSignal = () => ctx.signal.removeEventListener('abort', onAbort);
  }

  const enabledCount = rt.rules.length;
  const skippedCount = rt.allRules.length - enabledCount;
  return {
    ok: true,
    message:
      enabledCount === 0
        ? `已初始化，但没有启用中的规则（共 ${rt.allRules.length} 条）。填好规则并在配置里启用后才会回复。`
        : `已初始化：${enabledCount} 条规则生效${
            skippedCount > 0 ? `（另有 ${skippedCount} 条 enabled:false 未生效）` : ''
          }；限频 ${cfg.maxRepliesPerMinute}/分钟、${cfg.maxRepliesPerHour}/小时；匹配超时 ${cfg.matchTimeoutMs}ms`,
  };
}

/**
 * 保存配置前的自校验。
 *
 * 宿主在**写盘之前**调用它（清单 `validateConfig: true`），返回值决定
 * 这次保存成不成立。所以它必须：
 *
 *   · 是纯计算（不建 worker、不发消息、不写文件）—— 保存是同步语义；
 *   · 不依赖 init 建的运行时 —— 插件可能处于 error/needs-config；
 *   · 出错时能**定位到第几条规则** —— message 直接复用 parseRules 的
 *     文案（它已含「第 N 条规则（id=xxx）」）。
 *
 * @param {any} config 宿主传的是**候选配置**（这次要保存的那份）
 * @returns {{ok: boolean, message: string, details?: object}}
 */
function validateConfig(config) {
  return checkConfig(config);
}

/**
 * 「测试连接」/ 自检 —— 不依赖 init 实例。
 *
 * 与 `validateConfig` 的区别：这里多一层**主线程的编译校验**。
 * `validateConfig` 依赖 `parseRules`（它内部也会编译），但 `parseRules`
 * 的行为由 rules.mjs 决定；这里独立 `new RegExp(pattern, flags)` 再编一次，
 * 是为了让"规则到底能不能编译"这件事有一个不依赖别人实现第二证据 ——
 * 两边不一致时（rules.mjs 改了校验、或 flags 规范化变了）能立刻看出来。
 *
 * 注意这只是在主线程**编译**，不执行匹配，所以不会卡（编译是线性时间）。
 * 真正的执行在 worker。
 *
 * @param {any} ctx
 * @returns {Promise<{ok: boolean, message: string, details: object}>}
 */
async function testConnection(ctx) {
  const cfg = readConfig(ctx);
  const log = loggerFor(ctx, 'info');

  /** @type {Record<string, any>} */
  const details = {
    enabled: cfg.enabled,
    rules: 0,
    enabledRules: 0,
    matchTimeoutMs: cfg.matchTimeoutMs,
    maxInputLength: cfg.maxInputLength,
    maxRepliesPerMinute: cfg.maxRepliesPerMinute,
    maxRepliesPerHour: cfg.maxRepliesPerHour,
    defaultCooldownMs: cfg.defaultCooldownMs,
    multiMatch: cfg.multiMatch,
    workerAlive: rt.worker !== null,
    skippedRules: [...rt.skipUntil.keys()],
  };

  const parsed = parseRules(cfg.rules, { maxRules: LIMITS.maxRules });
  if (!parsed.ok) {
    return { ok: false, message: `规则配置无效：${parsed.message}`, details };
  }

  details.rules = parsed.rules.length;
  details.enabledRules = parsed.rules.filter((r) => r.enabled).length;

  /*
   * 逐条在主线程再编译一次。
   *
   * 收集**所有**失败项而不是遇到第一条就返回：用户点一次「测试」，
   * 期望看到"哪几条有问题"，而不是修一条、点一次、再修下一条。
   */
  /** @type {{id: string, message: string}[]} */
  const compileErrors = [];
  for (const rule of parsed.rules) {
    if (!rule.enabled) continue;
    try {
      // eslint-disable-next-line no-new
      new RegExp(rule.pattern, rule.flags);
    } catch (err) {
      compileErrors.push({
        id: rule.id,
        message: String(/** @type {any} */ (err)?.message ?? err),
      });
    }
  }
  if (compileErrors.length > 0) {
    details.compileErrors = compileErrors;
    return {
      ok: false,
      message: `有 ${compileErrors.length} 条规则无法编译：${compileErrors
        .map((e) => `${e.id}（${e.message}）`)
        .join('；')}`,
      details,
    };
  }

  // ---- 取值合理性 ----
  /*
   * 超时与限频的"合理性"不是能不能跑，而是"跑起来能不能用"：
   *   · 超时 5ms 在稍复杂的正则上必然误伤 → 大量"降级为未命中"，
   *     用户看到的是"规则时好时坏"；
   *   · 限频 1 条/分钟在活跃群里等于几乎不工作。
   * 这些值是合法的（清单允许），所以**不判失败**，只给提示。
   */
  /** @type {string[]} */
  const hints = [];
  if (cfg.matchTimeoutMs <= 10) {
    hints.push(`匹配超时 ${cfg.matchTimeoutMs}ms 偏小，稍复杂的正则会被判超时并跳过 5 分钟`);
  }
  if (cfg.matchTimeoutMs >= 300) {
    hints.push(`匹配超时 ${cfg.matchTimeoutMs}ms 偏大，一条病态正则会阻塞那条消息半秒`);
  }
  if (cfg.maxRepliesPerMinute <= 1) {
    hints.push('每分钟上限只有 1 条，活跃群里基本不会触发自动回复');
  }
  if (cfg.maxInputLength > 2000) {
    hints.push(`参与匹配的最大字数 ${cfg.maxInputLength} 偏大，长文本会让匹配更慢`);
  }
  if (!cfg.enabled) {
    hints.push('插件内的「启用自动回复」是关闭状态：规则不会生效，消息全部交给 AI');
  }
  if (details.rules > 0 && details.enabledRules === 0) {
    hints.push('所有规则都是 enabled:false，实际不会回复任何消息');
  }
  if (hints.length > 0) details.hints = hints;

  const skipped = details.skippedRules.length;
  let message =
    parsed.rules.length === 0
      ? '配置可用，但规则为空：不会回复任何消息（消息全部交给 AI）'
      : `配置可用：${details.rules} 条规则（启用 ${details.enabledRules} 条），全部可以编译；` +
        `超时 ${cfg.matchTimeoutMs}ms、限频 ${cfg.maxRepliesPerMinute}/分钟`;
  if (skipped > 0) {
    message += `；有 ${skipped} 条规则因匹配超时在跳过期内（5 分钟后自动恢复）`;
  }
  if (hints.length > 0) {
    message += `。注意：${hints.join('；')}`;
  }

  log(`自检完成：${message}`);
  return { ok: true, message, details };
}

/**
 * 停用 / 重载前释放资源。
 *
 * 顺序：摘 abort 监听 → 杀 worker → 清表。
 *
 * 为什么必须杀 worker：不杀的话，每一次"保存配置"（宿主会 dispose → init）
 * 都会漏一个线程，几次之后线程数就上去了，而症状只是"后端越来越吃内存"。
 *
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function dispose(ctx) {
  rt.detachSignal?.();
  rt.detachSignal = null;

  const worker = rt.worker;
  rt.worker = null;
  if (worker) {
    // 同 killWorker：先登记"主动终止"，别让它变成一条假的崩溃日志
    KILLED_WORKERS.add(worker);
    try {
      await worker.terminate();
    } catch {
      /* 停用必须完成，不因为一个线程收不干净而失败 */
    }
  }

  rt.cooldowns?.clear();
  rt.rateLimiter?.clear();
  rt.skipUntil.clear();
  rt.rules = [];
  rt.allRules = [];
  rt.cfg = null;

  loggerFor(ctx, 'info')('已停止：worker 已回收，冷却与限频表已清空');
}

/* ---------------------------------------------------------------- 导出 */

export default {
  init,
  validateConfig,
  testConnection,
  dispose,
  /**
   * 接管 QQ 消息（仅 in-process 运行时）。
   *
   * `gate` 由宿主在派发前算好（白名单 / 静音 / 是否待确认 / 自身 QQ 号），
   * 本插件只读不写。字段缺失时的取舍见 onMessage 里每一步的注释。
   *
   * @param {{evt: object, sendText: (convKey: string, text: string) => Promise<any>, ctx: any, gate?: object}} input
   * @returns {Promise<boolean>} true = 已接管，宿主不再走 AI 回合
   */
  async handleMessage({ evt, sendText, ctx, gate }) {
    return onMessage({ evt, sendText, ctx, gate });
  },
};
