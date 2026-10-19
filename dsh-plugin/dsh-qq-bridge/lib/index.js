/**
 * dsh-qq-bridge —— 把 DSH 的工具审批与会话控制暴露到 QQ
 *
 * ## 它解决什么
 *
 * DSH 跑起来后，危险工具（写文件、跑命令）默认要在界面里点"同意"。
 * 人不在电脑前时，任务就卡在那里。这个插件把审批请求推到 QQ，
 * 你在手机上回一句"同意 3"就继续了。反过来，也能从 QQ 发指令让 DSH 干活。
 *
 * ## 一个必须说清的取舍：DSH 侧不存 QQ 的连接
 *
 * 桥进程（Ling-bot 那边的 `scripts/dsh-bridge.mjs`）是**独立进程**，
 * 它自己连 QQ。插件不碰 QQ 的 API，只跟桥进程用一个 HTTP 端口说话。
 *
 * 这样做的好处：DSH 崩了不影响 QQ，QQ 崩了不影响 DSH，
 * 任一重启都不需要另一个跟着重启。
 *
 * ## fail-closed 还是 fail-open
 *
 * 这里的方向和 Ling-bot 的其他地方**相反**，而且是故意的：
 *
 *   - Ling-bot 的发送闸门是 fail-closed：拿不准就不发（宁可少说，不能乱说）
 *   - 这里的审批在 QQ 不可达时默认 **delegate**：调 next() 交还 DSH 自己的策略
 *
 * 理由：审批是"卡住别人干活"的操作。如果 QQ 掉线就直接判拒绝，
 * 一次网络抖动会让你所有任务全部失败，而 DSH 本来的界面审批明明是好的。
 * 交还默认处理是最不坏的选择——它不会放宽任何权限，
 * 因为 DSH 自己的策略仍然要过。
 *
 * 配置项 `onUnreachable: 'deny'` 可以改成严格模式。
 *
 * ## 时钟与超时
 *
 * 审批请求带 `signal`，DSH 那边可能提前取消。这里所有等待都监听它，
 * 一旦 abort 立刻返回 'cancelled'，绝不让一个已经没人等的请求挂着。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

/* ------------------------------------------------------------------ 诊断 */

/**
 * 诊断日志写系统临时目录。
 *
 * **不要**按相对层级往上爬：插件是以 `link:<DSH_HOME>/plugins/<name>`
 * 装进 profile 的，往上会落到 <DSH_HOME>/.. ——
 * 那会在用户主目录旁凭空造出目录，且只在作者机器上"看起来正常"。
 *
 * 可用 QQ_BRIDGE_DIAG 覆盖（空字符串 = 关闭）。
 */
const DIAG = process.env.QQ_BRIDGE_DIAG ?? path.join(os.tmpdir(), 'dsh-qq-bridge.log');

/** @param {string} msg */
function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* 写不了日志不能影响主流程 */
  }
}

/* ------------------------------------------------------------------ 常量 */

export const name = 'dsh-qq-bridge';

/**
 * 命名空间属于 settings seam：声明依赖让 entry 等 settings 就绪后再 activate。
 * 没这个声明，apply 可能在 settings 还没挂上时被调用。
 */
export const inject = ['settings'];

/** settings 命名空间名（必须与 cordis.patch.yml 里 entry 的 id 一致）。 */
export const NS = 'dsh-qq-bridge';

/** 审批等待上限。超过就按 onUnreachable 策略处理，不让 DSH 无限等。 */
const APPROVAL_TIMEOUT_MS = 120_000;

/** 单次 HTTP 调用的超时（问桥进程"有人在吗"之类） */
const HTTP_TIMEOUT_MS = 5_000;

/* ------------------------------------------------------------------ 配置 */

/**
 * 作为 loader entry 的 `Config` 暴露出去的配置。
 *
 * 每个字段都要 `volatile`（`.extra('volatile', true)`）：
 * 那是 DSH 的"可热改、不重挂载"标记，也是命名空间能被**写入**的必要条件
 * （volatileForm 只保留带该标记的字段，否则抛
 * "Plugin entry ... has no volatile fields"）。
 *
 * ⚠️ 刻意**不写 `.volatile()`**：那只是 DSH 自带那份 schemastery 的语法糖，
 * 本仓库钉的 `^3.18.1` 解析出来的那份没有这个方法，写了会直接
 * `TypeError: .volatile is not a function`。`.extra` 两边都有，行为一致。
 */
export const Config = z.object({
  bridgeUrl: z
    .string()
    .default('')
    .description('桥进程 HTTP 地址，例如 http://127.0.0.1:3458 ；留空表示不启用')
    .extra('volatile', true),
  bridgeToken: z
    .string()
    .default('')
    .description('与桥进程约定的共享令牌；留空表示不启用')
    .extra('volatile', true),
  admins: z
    .string()
    .default('')
    .description('允许控制 DSH 的管理员 QQ 号（逗号分隔）；留空表示一个都不允许')
    .extra('volatile', true),
  relayApprovals: z
    .boolean()
    .default(false)
    .description('是否把工具审批请求推到 QQ')
    .extra('volatile', true),
  onUnreachable: z
    .string()
    .default('')
    .description("QQ 不可达时的处理：'delegate' 交还 DSH 默认策略（推荐）；'deny' 直接拒绝")
    .extra('volatile', true),
});


/**
 * 解析本插件在 settings 里的**真实命名空间**。
 *
 * ## 为什么不能写死
 *
 * `settings.update(ns, ...)` 要的 ns 是 loader entry 的 **id**，
 * 而通过 bundle 装进来的条目，id 会被加上 `include:` 前缀
 * （实测是 `include:dsh-qq-bridge`，不是我以为的 `dsh-qq-bridge`）。
 *
 * 写死的后果是 `settings.update` 抛 "No configurable plugin entry"，
 * 而前端的表现只是一句"保存失败"。
 *
 * 所以：先 `describe()` 查一遍，找出**名字对得上**的那行的 ns。
 * 查不到才退回硬编码值——fail 的方向是"至少还有一个能用的猜测"。
 *
 * @param {any} ctx
 * @returns {string}
 */
function resolveNs(ctx) {
  try {
    // **不要** redactSecrets：那是给远程调用方的。
    // 插件自己必须拿到真实令牌才能连桥；脱敏后拿到的是 { path, set }，
    // 归一化时被当成"没有值"，于是 enabled 变 false、什么也发不出去。
    const list = ctx.settings?.describe?.();
    if (Array.isArray(list)) {
      // 顺序很重要：**先找不带前缀的那个**。
      //
      // 实证：image-tool 的 entry id 在 inspect 里显示为 `include:image-tool`，
      // 但它的代码直接用 `'image-tool'` 调 settings.update 且工作正常。
      // 说明 settings 这一层认的是 entry 的 options.id（不带 include: 前缀），
      // 而 describe() 返回的 ns 大概也是这个形式。
      const exact = list.find((d) => String(d?.ns) === NS);
      if (exact) return String(exact.ns);

      // 其次才容忍前缀形式（换了加载方式时仍能对上）
      const prefixed = list.find((d) => String(d?.ns) === `include:${NS}`);
      if (prefixed) return String(prefixed.ns);

      // 最后：ns 里包含包名
      const loose = list.find((d) => String(d?.ns ?? '').includes(NS));
      if (loose) return String(loose.ns);
    }
  } catch {
    /* 查不到就退回默认 */
  }
  return NS;
}

/* ------------------------------------------------------------------ 设置页路由 */

/**
 * 挂上设置页的数据接口。
 *
 * 每一步都独立容错：路由挂不上不该拖垮审批和指令这两个真功能。
 * 平台会把 apply 里任何未捕获异常呈现为"插件启动失败"，
 * 而我们这一行挂了三四件互相独立的事，让一件拖垮全部既难查也没必要。
 *
 * @param {any} ctx
 * @param {any} cfg 当前配置
 */
function mountRoutes(ctx, cfg) {
  try {
    if (typeof ctx.inject !== 'function') {
      diag('ctx.inject 不可用 —— 设置页接口未挂载（审批与指令不受影响）');
      return;
    }

    ctx.inject(['connection', 'webServer'], (routeCtx) => {
      try {
        const webServer = routeCtx.get?.('webServer') ?? routeCtx.webServer;
        if (!webServer?.register) {
          diag('没有 webServer —— 设置页接口未挂载');
          return;
        }
        const connection = routeCtx.get?.('connection') ?? routeCtx.connection;

        const dispose = registerBridgeRoutes(webServer, {
          /**
           * 每次现读，不缓存：设置页刚保存就要能看到新值，
           * 缓存会导致"保存成功但界面还是旧的"。
           */
          readConfig: () => readEffectiveConfig(ctx, cfg),
          // 服务方法签名是**位置参数** update(ns, patch)，
          // 与 RPC 的 {ns, patch} 信封不是一回事，混了会静默写到别处
          updateConfig: (patch) => ctx.settings.update(resolveNs(ctx), patch),
          // 清 secret 只能走 unset：写空串在 secret 字段上等于"没改"
          clearToken: () =>
            ctx.settings.mutate(resolveNs(ctx), [{ op: 'unset', path: ['bridgeToken'] }]),
          connection,
          log: diag,
        });

        if (typeof routeCtx.effect === 'function') routeCtx.effect(() => dispose);
      } catch (err) {
        diag(`设置页接口挂载失败：${String(err?.message ?? err)}`);
      }
    });
  } catch (err) {
    diag(`设置页接口挂载异常：${String(err?.message ?? err)}`);
  }
}

/**
 * 读当前**生效**的配置。
 *
 * 优先从 settings 的实时值读，拿不到再退回 apply 时那份。
 * 这样设置页保存后立刻能看到新值，而不用等重启。
 *
 * @param {any} ctx
 * @param {any} fallback
 */
function readEffectiveConfig(ctx, fallback) {
  try {
    const list = ctx.settings?.describe?.();
    if (Array.isArray(list)) {
      // 用和写入同一套匹配规则：entry id 可能带 include: 前缀，
      // 只按包名精确比对会漏掉它（那样"保存成功但界面还是旧的"）
      const ns = resolveNs(ctx);
      const row = list.find((d) => String(d?.ns) === ns);
      if (row?.value && typeof row.value === 'object') {
        // 不脱敏取值，所以这里能拿到真实的 bridgeToken。
        // 仍保留"对象即无值"的兜底：万一宿主换了行为，
        // 归一化会把对象当空串，而不是 "[object Object]"。
        return { ...fallback, ...row.value };
      }
    }
  } catch {
    /* 读不到就用 fallback */
  }
  return fallback;
}

/* ------------------------------------------------------------------ 工具 */

// 判定逻辑在 logic.js（那份不依赖 schemastery，便于单测）
import { parseAdmins, isAdmin, unreachableOutcome } from './logic.js';
import { registerBridgeRoutes } from './routes.js';
import { resolveBridgeUrl } from './discovery.js';

export { parseAdmins, isAdmin, unreachableOutcome };

/* ------------------------------------------------------------------ 桥客户端 */

/**
 * 极简的桥进程客户端。
 *
 * 只做三件事：ping（有人在吗）、ask（问一个审批）、notify（上报事件）。
 * 刻意不引第三方 HTTP 库——Node 自带 fetch 够了。
 */
export class BridgeClient {
  /** @type {{url: string, token: string}} */
  #cfg;

  /**
   * @param {{url: string, token: string}} cfg
   */
  constructor(cfg) {
    this.#cfg = cfg;
  }

  /** 仅用于诊断：当前实际会连的地址 */
  /**
   * 换一份地址/令牌。
   *
   * 热更新必须在**原地**改这个对象，不能新建一个：
   * 轮询器和审批处理器都握着这个引用，换对象它们就还在用旧的。
   *
   * @param {{url: string, token: string}} cfg
   */
  reconfigure(cfg) {
    const url = String(cfg?.url ?? '').trim();
    const token = String(cfg?.token ?? '').trim();
    if (!url || !token) return false;
    this.#cfg = { url, token };
    return true;
  }

  get urlForDiag() {
    return this.#cfg.url;
  }

  get enabled() {
    return Boolean(this.#cfg.url && this.#cfg.token);
  }

  /**
   * @param {string} p
   * @returns {string}
   */
  #abs(p) {
    return `${this.#cfg.url.replace(/\/+$/, '')}${p}`;
  }

  /**
   * 发一个带令牌的请求。**不抛 HTTP 错误**，由调用方按状态码判断。
   *
   * @param {string} p
   * @param {object} [body]
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>}
   */
  async #post(p, body, signal) {
    if (!this.enabled) return { ok: false, status: 0, data: null, error: '桥未配置' };

    const sig = signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(this.#abs(p), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#cfg.token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: sig,
      });
      const text = await res.text().catch(() => '');
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { _raw: text };
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      const e = /** @type {any} */ (err);
      // abort 与网络错误要分开：前者是调用方主动放弃，不算桥故障
      const aborted = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      return {
        ok: false,
        status: 0,
        data: null,
        error: aborted ? 'aborted' : String(e?.message ?? e),
      };
    }
  }

  /** 探活：QQ 那边有人能处理吗 */
  async ping(signal) {
    return this.#post('/dsh/ping', {}, signal);
  }

  /**
   * 问一个审批。
   *
   * @param {object} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, outcome?: string, error?: string}>}
   */
  async ask(req, signal) {
    const res = await this.#post('/dsh/ask', req, signal);
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
    const outcome = res.data?.outcome;
    // 桥进程只允许返回这几个词。其它值一律当"没结论"，不猜。
    const VALID = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
    if (!VALID.has(outcome)) {
      return { ok: false, error: `桥返回了无法识别的结论：${String(outcome)}` };
    }
    return { ok: true, outcome };
  }

  /**
   * 上报一条事件（给 QQ 侧做通知用）。
   *
   * @param {object} evt
   */
  async notify(evt) {
    return this.#post('/dsh/event', evt);
  }

  /**
   * 问一个问题，等 QQ 那边回答。
   *
   * 与审批同一条通路，但答案形状不同（要按 question id 组装）。
   *
   * @param {{questions: Array<object>}} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, answer?: any, error?: string}>}
   */
  async askQuestion(req, signal) {
    const res = await this.#post('/dsh/ask-question', req, signal);
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
    // answer 为 null 表示没人回答（超时/取消）。
    // 这个区分很重要：null 不能被当成"用户选了默认项"。
    return { ok: true, answer: res.data?.answer ?? null };
  }

  /**
   * 取走桥里排队的 QQ 指令。
   *
   * @returns {Promise<{ok: boolean, items?: any[], error?: string}>}
   */
  async drain() {
    const res = await this.#post('/dsh/drain', {}, AbortSignal.timeout(HTTP_TIMEOUT_MS));
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
    return { ok: true, items: Array.isArray(res.data?.items) ? res.data.items : [] };
  }

  /**
   * 报告一条指令投递失败，让 QQ 侧能告诉用户"没生效"。
   *
   * @param {{text: string, error: string}} info
   */
  async reportDelivery(info) {
    return this.#post('/dsh/delivery-failed', info, AbortSignal.timeout(HTTP_TIMEOUT_MS));
  }
}

/* ------------------------------------------------------------------ 插件装配 */

/**
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {

  // apply 收到的 config 常常是**未求值的占位对象**（每个字段都是 {}），
  // 见 normalizeConfig 上的注释。真正的值要用 settings.describe() 读。
  //
  // 所以这里先归一化传入值，再和 settings 里的实时值合并：
  // settings 读得到就用它，读不到才退回传入值。
  const fromArgs = normalizeConfig(config);
  const fromSettings = normalizeConfig(readEffectiveConfig(ctx, config));
  const cfg = {
    bridgeUrl: fromSettings.bridgeUrl || fromArgs.bridgeUrl,
    bridgeToken: fromSettings.bridgeToken || fromArgs.bridgeToken,
    admins: fromSettings.admins || fromArgs.admins,
    relayApprovals: fromSettings.relayApprovals || fromArgs.relayApprovals,
    onUnreachable: fromSettings.onUnreachable || fromArgs.onUnreachable,
  };

  /* ---- 配置热更新 ------------------------------------------------------ */

  // 用户保存设置页之后，DSH 会把新值写进 profile patch，
  // 并发 'settings/document-updated'。
  //
  // **但是**插件实例不会因此重建：实测诊断日志里，保存完只有一行
  // "配置已更新"，之后再没出现过 apply，于是运行中的实例继续拿着
  // 旧的 relay=false / admins=[] 干活。表现是最难查的那种：
  // "设置里明明开着，功能就是不工作"。
  //
  // 所以自己订阅：配置一变就把新值读进这个可变对象，
  // 下游全部从它读，不再直接捕获闭包里的旧值。
  const live = {
    relayApprovals: cfg.relayApprovals,
    onUnreachable: cfg.onUnreachable,
    admins: cfg.admins,
  };

  const applyLive = () => {
    const next = normalizeConfig(readEffectiveConfig(ctx, config));
    live.relayApprovals = next.relayApprovals;
    live.onUnreachable = next.onUnreachable;
    live.admins = next.admins;

    // 地址和令牌也要跟着更新——这一条最关键。
    //
    // apply 往往在 settings 就绪**之前**执行（实测日志里两者相差约 1 秒），
    // 那一刻读到的 token 是空的，BridgeClient 于是 disabled。
    // 如果热更新只补 relay/admins 而不管 url/token，
    // 这个实例就会永远废着：轮询在跑、没有任何报错、桥一次也没被访问过。
    //
    // 所以这里重新算一次地址，生效后立刻把 bridge 修复成可用状态。
    const nextUrl = resolveBridgeUrl(next.bridgeUrl) ?? next.bridgeUrl;
    if (nextUrl && next.bridgeToken) {
      if (!bridge.enabled) {
        diag(`桥配置已补全，重新启用：${nextUrl}`);
      }
      bridge.reconfigure({ url: nextUrl, token: next.bridgeToken });
    }

    diag(
      `配置热更新：relay=${live.relayApprovals} admins=${parseAdmins(live.admins).length} bridge=${bridge.enabled ? 'enabled' : 'disabled'}`,
    );
  };

  try {
    if (typeof ctx.on === 'function') {
      ctx.effect(() =>
        ctx.on('settings/document-updated', (ns) => {
          if (!String(ns ?? '').includes(NS)) return;
          try {
            applyLive();
          } catch (err) {
            diag(`配置热更新失败：${String(err?.message ?? err)}`);
          }
        }),
      );
    }
  } catch (err) {
    diag(`订阅配置变更失败（不影响主功能）：${String(err?.message ?? err)}`);
  }
  const admins = parseAdmins(live.admins);

  // 端口自动发现。
  //
  // bridgeUrl 留空时去读 Ling-bot 写的发现文件（`~/.ling-bot/bridge.json`），
  // 于是"端口不固定"这件事用户不用管：只要填一次令牌，地址自动跟上。
  //
  // 用户显式填了就以他填的为准——自动发现只是兜底，绝不覆盖人的选择。
  const resolvedUrl = resolveBridgeUrl(cfg.bridgeUrl);
  if (!cfg.bridgeUrl && resolvedUrl) {
    diag(`bridgeUrl 未填，自动发现到 ${resolvedUrl}`);
  } else if (!cfg.bridgeUrl) {
    diag('bridgeUrl 未填，且没找到端口发现文件（Ling-bot 可能没启动过）');
  }

  const bridge = new BridgeClient({ url: resolvedUrl ?? cfg.bridgeUrl, token: cfg.bridgeToken });

  /* ---- 设置页接口 ------------------------------------------------------ */

  // 必须在**任何 return 之前**挂上。
  // 设置页恰恰是"还没配令牌"时要用的东西——如果挂不上，用户就没有任何入口
  // 去填第一份配置，只能去改 YAML。
  mountRoutes(ctx, cfg);

  diag(
    `apply: bridge=${bridge.enabled ? 'enabled' : 'disabled'} relay=${live.relayApprovals} admins=${parseAdmins(live.admins).length}`,
  );

  // **不在这里 return。**
  //
  // 以前是"桥没配就直接退出"，看着干净，实际有个致命副作用：
  // apply 经常跑在 settings 就绪之前（实测两者相差约 1 秒），
  // 那一刻 token 还是空的，于是两个方向**都还没注册**。
  // 之后即使热更新把令牌补上，也没有任何东西会去用它——
  // 表现就是"配置明明填好了，功能就是不动"。
  //
  // 改成：先把处理器挂上，让它们自己在运行时看 bridge.enabled。
  // 未配置时什么都不做，配置好了立刻开始工作。
  if (!bridge.enabled) {
    diag('桥尚未配置 —— 处理器已就位，等配置补全后自动开始工作');
  }

  /* ---- 方向一：QQ → DSH（下指令）------------------------------------- */

  // 与审批转推**互相独立**：只要桥配了就能用。
  // 这样"只想从 QQ 发指令、审批继续在界面点"是一种可用组合。
  const stopPoller = startCommandPoller(ctx, bridge);
  ctx.effect(() => () => {
    stopPoller();
    diag('已停止指令轮询');
  });
  diag('已启动指令轮询');

  /* ---- 方向二：DSH → QQ（审批转推）----------------------------------- */

  // 同样**不能**在这里 return：relayApprovals 可能是热更新之后才打开的，
  // 提前 return 会让审批处理器永远不被注册。改成注册后每次调用时再看开关。
  if (!live.relayApprovals) {
    diag('relayApprovals 当前关闭 —— 处理器已就位，打开后立即生效');
  }

  ctx.on('approval/request', async (req, next) => {
    const answer = () => next();

    // 每次调用都现读开关和名单，不用 apply 时那份快照。
    // apply 常常跑在 settings 就绪之前，那时这两样都还是空的。
    if (!live.relayApprovals) {
      return answer();
    }

    // 没配管理员 = 没人有权决定 = 不接管（不是"全放行"）
    if (parseAdmins(live.admins).length === 0) {
      diag('没有配置管理员 —— 不接管审批');
      return answer();
    }

    const signal = req?.signal;
    if (signal?.aborted) return 'cancelled';

    /** 供 ask 与超时竞速用 */
    const timeout = new AbortController();
    const onAbort = () => timeout.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), APPROVAL_TIMEOUT_MS);

    try {
      const res = await bridge.ask(
        {
          toolName: String(req?.toolName ?? 'unknown'),
          reason: String(req?.reason ?? ''),
          displayReason: req?.displayReason ?? null,
          agentId: String(req?.agent?.id ?? ''),
          callId: req?.callId ? String(req.callId) : '',
          // 让 QQ 那边知道该发给谁（管理员列表由 QQ 侧持有，这里只做提示）
          timeoutMs: APPROVAL_TIMEOUT_MS,
        },
        timeout.signal,
      );

      // 调用方在等的时候取消了 → 明确报 cancelled，不要给一个假的结论
      if (signal?.aborted) return 'cancelled';

      if (!res.ok) {
        diag(`桥不可达或返回异常：${res.error} —— 按 onUnreachable 处理`);
        const fallback = unreachableOutcome(live.onUnreachable);
        // null 表示"交还 DSH 默认策略"，不是"同意"
        return fallback === null ? answer() : fallback;
      }

      diag(`审批结论：${req?.toolName} → ${res.outcome}`);
      return res.outcome;
    } catch (err) {
      // 任何意外都按 onUnreachable 处理，绝不让异常穿透到 DSH 的审批链
      diag(`审批处理异常：${String(err?.message ?? err)}`);
      const fallback = unreachableOutcome(live.onUnreachable);
      return fallback === null ? answer() : fallback;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  });

  diag('已接管 approval/request');

  /* ---- 提问也要能推到 QQ ---------------------------------------------- */

  // `user-questions/request` 是 waterfall：返回答案，或 `next()` 交还界面。
  //
  // 与审批的关键区别：**没有"只有一种答案合法"这回事**。
  // 选项数量、是否多选、是否自由输入，全由这次请求自己决定。
  // 所以这里只做搬运：把 questions 原样送到桥，把答案原样搬回来。
  if (typeof ctx.on === 'function') {
    ctx.on('user-questions/request', async (request, next) => {
      const answer = () => next();

      if (!live.relayApprovals) return answer();

      // 一次只转推**一组**问题，且必须至少有一个选项——
      // 纯自由输入的问题在 QQ 端没有编号可回，硬转只会让人无从下手。
      const questions = Array.isArray(request?.questions) ? request.questions : [];
      const hasOptions = questions.some(
        (q) => Array.isArray(q?.options) && q.options.length > 0,
      );
      if (!hasOptions) {
        diag('提问没有选项（纯自由输入）—— 交还界面');
        return answer();
      }

      const signal = request?.signal;
      if (signal?.aborted) throw new Error('ASK_ABORTED');

      try {
        const res = await bridge.askQuestion({ questions }, signal);
        if (!res.ok) {
          diag(`提问转推失败：${res.error} —— 交还界面`);
          return answer();
        }
        if (!res.answer) {
          // null = 超时/取消。交还界面，让用户还能在 DSH 里回答。
          diag('提问没人回答 —— 交还界面');
          return answer();
        }
        diag(`提问答案：${JSON.stringify(res.answer).slice(0, 120)}`);
        return res.answer;
      } catch (err) {
        // 任何异常都交还界面：绝不能让 QQ 侧的问题把 DSH 卡死
        diag(`提问处理异常：${String(err?.message ?? err)} —— 交还界面`);
        return answer();
      }
    });
    diag('已接管 user-questions/request');
  }
}

/**
 * 把可能为空的配置整理成确定的形状。
 *
 * @param {any} raw
 */
/**
 * 把 DSH 传进来的 config 归一化。
 *
 * ## 为什么不能直接 `String(x ?? '')`
 *
 * 实测：apply 收到的每一个字段都可能是**空对象** `{}`，不是值。
 * 因为 Config schema 把每个字段声明成
 * `anyOf: [string, loaderExpression]`，而 loaderExpression 是
 * `{ __jsExpr: string }` —— 未求值时就是一个普通对象。
 *
 * `String({})` 得到字面量 `"[object Object]"`。
 * 于是 bridgeUrl 变成 "[object Object]"、token 变成 "[object Object]"，
 * 两者都"非空"，`enabled` 于是为 true，请求发往
 * `[object Object]/dsh/drain` —— 报 "Failed to parse URL"。
 *
 * 更糟的是这看起来一切正常：插件说 enabled、轮询在跑、日志不报错。
 * 这一层必须把"对象"一律当**没有值**，而不是当字符串。
 *
 * @param {any} raw
 */
function normalizeConfig(raw) {
  const c = raw ?? {};

  /** 只接受真正的字符串/数字/布尔，其它一律当没有 */
  const str = (v) => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    // 对象（含 { __jsExpr } 与占位 {}）、数组、null、undefined 都不算值
    return '';
  };

  return {
    bridgeUrl: str(c.bridgeUrl),
    bridgeToken: str(c.bridgeToken),
    admins: str(c.admins),
    relayApprovals: c.relayApprovals === true,
    onUnreachable: str(c.onUnreachable),
  };
}

/* ------------------------------------------------------------------ 下指令 */

/** 轮询间隔。3 秒对"人发指令"这个节奏足够了，也不会把 CPU 空转起来。 */
const POLL_MS = 3_000;

/**
 * 把 QQ 指令投进 DSH 的会话。
 *
 * ## 为什么用 `sessionController.prompt()` 而不是自己造消息
 *
 * `prompt()` 是 DSH 自己的**公开入口**：它会走完整的准入流程
 * （会话存在性、队列/插话语义、持久化）。绕开它直接改会话事件流
 * 会跳过这些检查，而且下次 DSH 升级内部结构就会崩。
 *
 * ## mode 选 'queue'
 *
 * 'queue' = 排队，等当前回合结束再处理；'steer' = 打断当前回合。
 * 从 QQ 发来的指令**不应该**打断正在跑的任务——你人在外面，
 * 不知道它进行到哪一步，插话更可能把有用的中间结果丢掉。
 *
 * @param {any} ctx
 * @param {{sessionId: string, text: string}} cmd
 * @returns {Promise<void>}
 */
async function deliverCommand(ctx, cmd) {
  const sc = ctx.get('sessionController');
  if (!sc) throw new Error('sessionController 不可用（DSH 版本可能不匹配）');

  const sessionId = String(cmd?.sessionId ?? '');
  if (!sessionId) throw new Error('指令没有指定会话');

  // requestId 必须唯一：同一个 requestId 重复提交会被 DSH 当成幂等重放
  const requestId = `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await sc.prompt(
    {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: String(cmd.text) }],
    },
    new AbortController().signal,
  );
}

/**
 * 起一个轮询循环，从桥进程取指令并投给 DSH。
 *
 * @param {any} ctx
 * @param {BridgeClient} bridge
 * @returns {() => void} 停止函数
 */
function startCommandPoller(ctx, bridge) {
  let stopped = false;
  /** 失败计数：只记前几次，避免刷屏 */
  let failCount = 0;
  /** tick 计数：确认轮询是否真的重入 */
  let tickCount = 0;
  let timer = /** @type {NodeJS.Timeout | null} */ (null);

  const tick = async () => {
    /** @type {any} */
    let res;
    if (stopped) return;
    // 只在前两次记心跳：够证明轮询重入了，又不至于把日志淹掉
    if (++tickCount <= 2) diag(`tick #${tickCount}（stopped=${stopped}）bridge=${bridge.urlForDiag ?? '?'} enabled=${bridge.enabled}`);
    try {
      res = await bridge.drain();
      if (res.ok && Array.isArray(res.items)) {
        for (const cmd of res.items) {
          try {
            await deliverCommand(ctx, cmd);
            diag(`指令已投递：${String(cmd?.text ?? '').slice(0, 40)}`);
          } catch (err) {
            // 投递失败要上报，否则用户以为指令生效了
            diag(`指令投递失败：${String(err?.message ?? err)}`);
            await bridge
              .reportDelivery({
                text: String(cmd?.text ?? ''),
                error: String(err?.message ?? err),
              })
              .catch(() => {});
          }
        }
      }
    } catch (err) {
      // 之前这里完全静默，结果是"轮询已启动"却一次都没连上，
      // 而日志一片安静 —— 排查时毫无线索。
      // 现在只记前几次：既不刷屏，也能证明到底通没通。
      if (failCount < 3) {
        failCount++;
        diag(`drain 失败(#${failCount})：${String(err?.message ?? err)}`);
      }
    }
    if (typeof res !== 'undefined' && res && !res.ok && failCount < 3) {
      // 桥可达但返回失败：最常见的是令牌对不上（401），
      // 或者 enabled=false 时 #post 直接短路（status=0）。
      // 这段以前根本不存在，于是"轮询在跑但什么也没发生"完全没有痕迹。
      failCount++;
      diag(`drain 未成功(#${failCount})：status=${res.status} ${res.error ?? JSON.stringify(res.data ?? null)?.slice(0, 160) ?? ''}`);
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };

  timer = setTimeout(tick, POLL_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
