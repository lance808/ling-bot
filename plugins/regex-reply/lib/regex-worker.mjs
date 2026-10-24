/**
 * 正则匹配 worker —— 需求 4「正则必须隔离执行」的落点
 *
 * ## 为什么必须开一个线程
 *
 * 正则引擎是**不可中断**的：一条 `^(a+)+$` 配上 40 个 `a` 再跟一个 `b`，
 * 会让 `exec()` 在同一个调用里跑掉几十秒甚至几分钟。这个特性对
 * `in-process` 插件是致命的 —— 插件和宿主同进程，主线程被正则占住意味着
 * 后端连"点插件页关掉它"的请求都处理不了，整个机器人静默失联。
 *
 * 所以匹配一律在 worker 线程里跑。主线程持有超时控制权：时间一到就
 * `worker.terminate()`。terminate 是**唯一**能真正中断正在执行的正则的手段
 * （没有"给正则发个 abort 信号"这种东西），代价是线程里的一切状态全丢 ——
 * 这正是本文件要缓存编译结果、而父侧要在超时后重建 worker 的原因。
 *
 * ## 边界（这个文件不该做的事）
 *
 * - **不读文件、不写文件、不联网**：worker 的输入只有消息里的那点数据，
 *   输出只有匹配结果。任何 IO 都会让"超时即丢弃"变得不安全 ——
 *   一个被 terminate 的线程可能停在写文件的半途。
 * - **不 import 宿主模块**：插件包要能被单独拷走。这里只 import
 *   `./rules.mjs` 里的上限常量（同包内的纯函数层）。
 * - **不判断"该不该回"**：范围、冷却、限频、模板渲染全在父侧。
 *   worker 只回答"这条正则在这段文本上命中了吗、组是什么"。
 *   把策略放进 worker 会让每次超时都丢掉一部分决策状态。
 *
 * ## 协议（父侧 → 这里）
 *
 * ```
 * { seq, rules: [{ id, pattern, flags }], input }
 * ```
 *
 * 回包（这里 → 父侧），同一条消息里可能有多条：
 *
 * ```
 * { type: 'begin',  seq, ruleId }                 即将开始跑这条规则（超时后用它定位是哪条）
 * { type: 'result', seq, ruleId, hit, full, groups, named }
 * { type: 'error',  seq, ruleId, message }        这条规则编译失败，继续下一条
 * { type: 'done',   seq }                         本批跑完
 * ```
 *
 * `begin` 是刻意加的：父侧超时后 worker 已经被杀了，没法再问它"刚才卡在
 * 哪条规则上"。唯一能拿到答案的时机是超时**之前**收到的 `begin`，
 * 所以父侧记住最近一条 `begin` 的 ruleId，超时时把那条规则拉黑。
 */

import { parentPort } from 'node:worker_threads';

import { LIMITS } from './rules.mjs';

/**
 * 编译缓存：`id → { pattern, flags, re } | { error }`。
 *
 * ## 为什么要缓存
 *
 * 每个 worker 生命周期内会处理成百上千条消息。`new RegExp` 本身不算贵，
 * 但它是每条规则每条消息一次 —— 64 条规则 × 每条消息 = 64 次编译，
 * 而真正贵的是**编译失败**的路径（V8 要生成错误信息）。
 *
 * ## 为什么也缓存失败
 *
 * 一条写坏的正则会在每条消息上重复编译、重复失败。缓存住"编译失败"这个
 * 结论，就能把重复的语法错误分析从热路径上摘掉。
 *
 * ## 为什么 key 是 id 而不是 pattern
 *
 * 规则 id 唯一（parseRules 保证），而 pattern 可能很长。用 id 做 key
 * 顺便还得到一条性质：**同 id 的规则内容变了，缓存会失效**（下面比对
 * pattern/flags，不一致就重新编译）。父侧改了规则会 dispose 重建 worker，
 * 但这一层自愈让"忘了重建"也不会用旧正则匹配。
 *
 * @type {Map<string, {pattern: string, flags: string, re: RegExp | null, error: string}>}
 */
const cache = new Map();

/**
 * 缓存条数上限。
 *
 * 规则上限是 64 条，但运行时**跳过表**会让父侧送来的 id 集合变化，
 * 而规则被反复改配置时 id 也可能变化（用户改 id 是允许的）。
 * 留一个上限并按"超了就整体清空"处理：这里存的是纯派生数据（能从
 * pattern 重新编译出来），清空的代价只是下次多编译几次，不会丢正确性。
 */
const MAX_CACHE = 256;

/**
 * 取一条规则的正则实例（编译并缓存）。
 *
 * ## 每次都新建实例？不 —— 但也不复用 `lastIndex`
 *
 * 这里复用同一个 `RegExp` 对象，前提是**没有 `g`/`y` 标志**：
 * 只有带状态标志时 `lastIndex` 才会在调用之间残留。`parseRules` 已经
 * 明确拒绝 `g`/`y`（见 rules.mjs 的 ALLOWED_FLAGS），所以这里的复用
 * 是安全的，并且省掉了每条消息的分配。
 *
 * 万一日后有人放宽了 flags，这里必须改成"每次 new RegExp" —— 否则会
 * 出现"同一条规则时好时坏"这种最难查的问题。下面的断言式重置
 * （`re.lastIndex = 0`）就是给那种改动留的保险。
 *
 * @param {{id: string, pattern: string, flags: string}} rule
 * @returns {{ok: true, re: RegExp} | {ok: false, message: string}}
 */
function compile(rule) {
  const id = String(rule?.id ?? '');
  const pattern = String(rule?.pattern ?? '');
  const flags = String(rule?.flags ?? '');

  const hit = cache.get(id);
  if (hit && hit.pattern === pattern && hit.flags === flags) {
    if (hit.error) return { ok: false, message: hit.error };
    return { ok: true, re: /** @type {RegExp} */ (hit.re) };
  }

  if (cache.size >= MAX_CACHE) cache.clear();

  try {
    const re = new RegExp(pattern, flags);
    cache.set(id, { pattern, flags, re, error: '' });
    return { ok: true, re };
  } catch (err) {
    // 编译失败**不中断整批**：一条规则写坏了，其它规则仍然该正常工作。
    // 父侧收到 error 后只记日志并跳过这一条。
    const message = String(/** @type {any} */ (err)?.message ?? err);
    cache.set(id, { pattern, flags, re: null, error: message });
    return { ok: false, message };
  }
}

/**
 * 把 `exec()` 的结果整理成父侧要的形状。
 *
 * ## 三个必须处理的细节
 *
 * 1. **未参与匹配的组是 `undefined`**，不是 `''`。`(a)|(b)` 匹配 `a` 时
 *    第 2 组就是 `undefined`。统一转成空串，否则模板渲染会出
 *    `"undefined"` 字面量（`String(undefined)`）。
 * 2. **组数要截断到 `LIMITS.maxCaptures`（20）**。一个写疯的正则可以有
 *    几千个组，把它们全跨线程传一遍纯属浪费；而模板最多也只用得到
 *    `{1}`..`{20}`。截断在这里做而不是父侧做，是为了让传输量有界。
 * 3. **`named` 只保留命名组**，且同样把 `undefined` 转空串。
 *
 * 注意 `groups` **不含 full**：`groups[0]` 是第 1 个捕获组。这是与
 * `renderTemplate` 约定好的下标基准（`{0}` → `match.full`，
 * `{N}` → `groups[N-1]`）。
 *
 * @param {RegExpExecArray} m
 * @returns {{full: string, groups: string[], named: Record<string, string>}}
 */
function shape(m) {
  const rawGroups = m.slice(1, LIMITS.maxCaptures + 1);
  const groups = rawGroups.map((g) => (g === undefined || g === null ? '' : String(g)));

  /** @type {Record<string, string>} */
  const named = {};
  const rawNamed = m.groups;
  if (rawNamed && typeof rawNamed === 'object') {
    for (const [key, value] of Object.entries(rawNamed)) {
      named[key] = value === undefined || value === null ? '' : String(value);
    }
  }

  return { full: String(m[0] ?? ''), groups, named };
}

/**
 * 处理一批规则。
 *
 * 顺序严格按父侧给的数组（父侧已经 `sortByPriority` 过），
 * **命中也不提前返回** —— 父侧要按 `multiMatch` 决策，可能需要
 * 多个命中结果。这里只负责"全部跑一遍并报出来"，
 * 至于"哪条赢"由父侧决定。这也让超时降级的语义简单：
 * 没跑完就是没命中，不需要回滚已产出的结果。
 *
 * @param {number} seq
 * @param {Array<{id: string, pattern: string, flags: string}>} rules
 * @param {string} input
 */
function runBatch(seq, rules, input) {
  const list = Array.isArray(rules) ? rules : [];
  const text = typeof input === 'string' ? input : String(input ?? '');

  for (const rule of list) {
    const ruleId = String(rule?.id ?? '');

    /*
     * 先报 `begin` 再匹配。
     *
     * 顺序不能反：父侧超时后拿到的是**已经发出**的消息，而
     * "开始跑这条"这条消息必须在 `exec()` 阻塞之前进到消息队列里。
     * 写在 `exec()` 之后的话，灾难性回溯的那条规则永远来不及报出
     * 自己的 id，父侧的跳过表就永远空着 —— 于是每条消息都卡一次超时。
     */
    parentPort?.postMessage({ type: 'begin', seq, ruleId });

    const compiled = compile(rule);
    if (!compiled.ok) {
      parentPort?.postMessage({ type: 'error', seq, ruleId, message: compiled.message });
      continue;
    }

    const re = compiled.re;
    // 保险：即使将来有人放开了 g/y，也不让 lastIndex 跨消息残留。
    re.lastIndex = 0;

    let m;
    try {
      m = re.exec(text);
    } catch (err) {
      // 极少数情况（例如某些引擎在极端嵌套下的内部错误）后仍要报清楚是哪条规则
      parentPort?.postMessage({
        type: 'error',
        seq,
        ruleId,
        message: `执行时出错：${String(/** @type {any} */ (err)?.message ?? err)}`,
      });
      continue;
    }

    if (!m) {
      parentPort?.postMessage({ type: 'result', seq, ruleId, hit: false, full: '', groups: [], named: {} });
      continue;
    }

    const shaped = shape(m);
    parentPort?.postMessage({ type: 'result', seq, ruleId, hit: true, ...shaped });
  }

  // 无论中间是否有规则编译失败，最后都要报 done：
  // 父侧靠它结束等待，缺一条 done 会让那条消息一直等到超时预算耗尽。
  parentPort?.postMessage({ type: 'done', seq });
}

/**
 * 只接受"一条消息一批"的形式。
 *
 * 不做批量深拷贝、不做结构化校验的宽容处理：父侧是同一份代码
 * （`index.mjs`），字段名对不上属于编码错误，越早暴露越好。
 * 真正不可信的输入是**用户写的正则文本**，而那条路径已经由
 * `parseRules` 与 try/catch 双重兜住了。
 */
parentPort?.on('message', (msg) => {
  // 没带的 seq 用 0：父侧会把它当作"不属于任何一批"丢弃，
  // 这比在这里抛错导致 worker 崩掉更安全。
  const seq = Number.isInteger(msg?.seq) ? msg.seq : 0;
  runBatch(seq, msg?.rules, msg?.input);
});

/*
 * 告诉父侧"我准备好了"。
 *
 * ## 为什么需要这条消息
 *
 * 新起一个 worker 要付出**模块加载 + 编译**的代价（Windows 上实测
 * 20–60ms，其中大头是加载 `./rules.mjs`）。如果父侧把这段启动时间
 * 也算进 `matchTimeoutMs`（默认 50ms），那么**每条在 worker 重建之后
 * 到来的消息都会被误判超时** —— 而超时的后果是"把一条完全无辜的规则
 * 拉黑 5 分钟"。用户看到的现象会是：一条正则偶尔写坏之后，
 * 其它规则也跟着时好时坏，且没有任何规律。
 *
 * 所以启动与匹配必须分段计时：
 *
 *   ready 之前 —— 用父侧一个独立的、宽松的启动预算
 *   ready 之后 —— 才把 matchTimeoutMs 交给这一批
 *
 * 发在模块顶层而不是等第一条消息再发，是因为"模块已加载"正是父侧
 * 需要知道的那件事；晚于第一批消息发送也没有意义。
 */
parentPort?.postMessage({ type: 'ready' });
