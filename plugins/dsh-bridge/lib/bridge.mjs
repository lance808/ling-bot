#!/usr/bin/env node
/**
 * dsh-bridge —— Ling-bot 与 DSH 插件之间的独立桥进程
 *
 * ## 为什么是独立进程
 *
 * 三方（QQ / Ling-bot / DSH）各有自己的生命周期。把桥做成独立进程，
 * 任一重启都不需要另两个跟着重启：
 *
 *     QQ ──OneBot WS──> Ling-bot ──stdio/HTTP──> dsh-bridge <──HTTP── DSH 插件
 *
 * 如果做成"插件直连 Ling-bot 的 state 文件"，DSH 崩了会把 Ling-bot 的文件写到一半；
 * 如果做成"桥跑在 Ling-bot 后端里"，DSH 重启时 Ling-bot 也得重连。
 *
 * ## 两个方向
 *
 * **DSH → QQ**：插件在 `approval/request` 里 POST `/dsh/ask`，
 *   桥把请求转成一条带编号的 QQ 消息，等管理员回复，再把结论作为 HTTP 响应返回。
 *
 * **QQ → DSH**：Ling-bot 收到管理员指令，POST `/qq/command`，
 *   桥缓存下来，插件下次轮询（或桥主动回调）时取走。
 *
 * 这里是**请求-响应**模型，不是消息队列：审批必须同步等结果，
 * 否则 DSH 那边的一轮对话没法继续。
 *
 * ## fail 的方向
 *
 * 桥任何一步出问题都**不能**让审批变成"同意"。默认返回 `unavailable`，
 * 由插件按自己的 `onUnreachable` 策略决定是交还 DSH 还是拒绝。
 * 桥自己不替用户做授权决定 —— 这条和 Ling-bot 的 tool-gate 是同一条原则。
 */

import http from 'node:http';
import crypto from 'node:crypto';

import { PendingQueue } from './pending.mjs';
import { approvalChoices, questionChoices, parseReply } from './prompt.mjs';

/* ------------------------------------------------------------------ 配置 */

/** 默认端口。刻意选一个不像常见服务的号，减少撞车。 */
const DEFAULT_PORT = 3458;

/** 审批等待上限（毫秒）。超时就按"没人回答"处理。 */
const APPROVAL_TIMEOUT_MS = 120_000;

/** 免打扰的最长时长，防止手滑设成"永久放行"。 */
const MAX_QUIET_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------ 状态 */

/**
 * 一个等待中的审批。
 *
 * @typedef {object} PendingApproval
 * @property {string} id        短编号（给用户看的，如 "3"）
 * @property {string} toolName
 * @property {string} reason
 * @property {number} createdAt
 * @property {(outcome: string) => void} resolve
 * @property {NodeJS.Timeout} timer
 */

export class DshBridge {
  /**
   * 待回复队列：审批和提问共用。
   *
   * 统一成"一条待回复 = 一张选项表 + 一个 resolver"，
   * 是因为用户看到的界面是同一个：引用某条消息，回一个数字。
   * 分成两套队列就要维护两套超时、两套编号、两套"回复该落到哪"。
   *
   * @type {PendingQueue}
   */
  #queue;
  /** 各路由被调用次数：用来证明"DSH 侧真的连过来了" */
  #hits = /** @type {Record<string, number>} */ ({});
  /** 免打扰截止时间戳（0 = 没有免打扰） */
  #quietUntil = 0;
  /** 待投递给 DSH 的指令队列 */
  #commands = [];
  /** 投递失败记录（等 Ling-bot 取走告诉用户） */
  #failures = [];
  /** 共享令牌。空 = 拒绝一切请求（不是"放行一切"） */
  #token;
  /** 把审批请求推给 QQ 的回调 */
  #onAsk;
  /** 把指令交给 DSH 的回调 */
  #onCommand;

  /**
   * @param {object} o
   * @param {string} o.token
   * @param {(req: any) => Promise<void>} o.onAsk   推送一条审批到 QQ
   * @param {(cmd: any) => Promise<void>} o.onCommand 把 QQ 指令交给 DSH
   */
  constructor({ token, onAsk, onCommand }) {
    this.#token = String(token ?? '');
    this.#onAsk = onAsk;
    this.#onCommand = onCommand;
    this.#queue = new PendingQueue({ timeoutMs: APPROVAL_TIMEOUT_MS });
  }

  /** 令牌是否已配置。没配就等于没启用。 */
  get enabled() {
    return this.#token.length > 0;
  }

  /**
   * 校验请求令牌。
   *
   * 用 `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同字符处返回，
   * 逐字节的响应时间差可以被用来猜令牌。这是本地端口，风险低，但成本也低。
   *
   * @param {string} got
   * @returns {boolean}
   */
  checkToken(got) {
    if (!this.enabled) return false;
    const a = Buffer.from(String(got ?? ''));
    const b = Buffer.from(this.#token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /* ---------------------------------------------------------------- 免打扰 */

  /**
   * 进入免打扰。期间的审批直接放行（`allowed-once`）。
   *
   * @param {number} ms
   * @returns {number} 实际设置的毫秒数（会被上限截断）
   */
  quiet(ms) {
    const clamped = Math.max(0, Math.min(Number(ms) || 0, MAX_QUIET_MS));
    this.#quietUntil = Date.now() + clamped;
    return clamped;
  }

  /** @returns {{quietUntil: number, quiet: boolean}} */
  /** 记一次路由调用（诊断用，不参与任何判断） */
  noteHit(route) {
    const k = String(route);
    this.#hits[k] = (this.#hits[k] ?? 0) + 1;
  }

  /** 各路由被调用的次数快照 */
  hitStats() {
    return { ...this.#hits };
  }

  quietState() {
    return {
      quietUntil: this.#quietUntil,
      quiet: Date.now() < this.#quietUntil,
    };
  }

  /** 清掉免打扰 */
  unquiet() {
    this.#quietUntil = 0;
  }

  /* ---------------------------------------------------------------- 审批 */

  /**
   * 处理一次审批请求（插件调用）。
   *
   * @param {object} req
   * @returns {Promise<string>} ApprovalOutcome 词表里的值
   */
  /**
   * 处理一次审批请求（插件调用）。
   *
   * 选项表由 approvalChoices() 给出，随推送一起送到 QQ。
   * 回复时按表把数字翻译回 ApprovalOutcome。
   *
   * @param {object} req
   * @returns {Promise<string>} ApprovalOutcome 词表里的值
   */
  async ask(req) {
    // 免打扰期内直接放行。这是用户显式选择的，且有时长上限。
    if (Date.now() < this.#quietUntil) {
      return 'allowed-once';
    }

    const spec = approvalChoices(req?.toolName);
    const r = await this.#queue.wait({
      kind: 'approval',
      title: spec.title,
      choices: spec.choices,
      preview: String(req?.toolName ?? 'unknown'),
      onPush: (entry) => {
        // 推送失败不代表审批失败——可能只是 QQ 没连上，
        // 那也应该等超时而不是立刻返回。
        Promise.resolve()
          .then(() =>
            this.#onAsk?.({
              id: entry.id,
              kind: 'approval',
              spec: { title: entry.title, choices: entry.choices },
              preview: entry.preview,
              ...req,
            }),
          )
          .catch(() => {});
      },
    });

    if (r.status === 'timeout') {
      // 超时 = 没人回答。不能当成拒绝（用户可能只是没看手机），
      // 也不能当成同意。返回 unavailable 让插件按策略处理。
      return 'unavailable';
    }
    if (r.status === 'cancelled') return 'cancelled';
    return String(r.value);
  }

  /**
   * 处理一次提问请求（插件调用）。
   *
   * 与审批最大的不同：选项来自 DSH 的实时数据，数量不固定，
   * 回传的形状也不同（要按 question id 组装）。
   *
   * @param {{questions: Array<object>}} req
   * @returns {Promise<{answers: Array<{id: string, selected: string[], custom?: string}>} | null>}
   */
  async askQuestion(req) {
    const spec = questionChoices(req);
    if (spec.choices.length === 0) {
      // 没有任何选项：只能自由输入。也给它一个编号位，避免"没法回"。
      return null;
    }

    const r = await this.#queue.wait({
      kind: 'question',
      title: '需要你决定',
      choices: spec.choices,
      multiSelect: spec.multiSelect,
      preview: String(req?.questions?.[0]?.question ?? '提问').slice(0, 40),
      onPush: (entry) => {
        Promise.resolve()
          .then(() =>
            this.#onAsk?.({
              id: entry.id,
              kind: 'question',
              spec: { title: entry.title, choices: entry.choices, multiSelect: entry.multiSelect },
              lines: spec.lines,
              questions: req?.questions ?? [],
            }),
          )
          .catch(() => {});
      },
    });

    if (r.status !== 'answered') return null;

    // 把选中的编号翻译回**题目里的选项文案**再交给 DSH：
    // DSH 的答案格式要的是 selected 里的值，而我们给用户看的是编号。
    return this.#toAnswer(req, spec, r.value);
  }

  /**
   * 编号 → DSH 的答案结构。
   *
   * 一条推送可能覆盖多道题，所以先把每个编号定位到"第几题的第几项"，
   * 再按题目聚合。
   *
   * @param {{questions: Array<object>}} req
   * @param {{choices: Array<{key: string, label: string}>, note?: string}} spec
   * @param {{keys: string[], note?: string}} picked
   */
  #toAnswer(req, spec, picked) {
    const questions = Array.isArray(req?.questions) ? req.questions : [];
    // 重建"编号 → 题目索引 + 选项索引"的映射，与 questionChoices 的编号顺序一致
    /** @type {Array<{qIdx: number, optIdx: number, label: string}>} */
    const index = [];
    questions.forEach((q, qIdx) => {
      const opts = Array.isArray(q?.options) ? q.options : [];
      opts.forEach((opt, optIdx) => {
        index.push({ qIdx, optIdx, label: String(opt?.label ?? '') });
      });
    });

    /** @type {Map<number, {selected: string[], custom?: string}>} */
    const byQuestion = new Map();

    for (const key of picked.keys) {
      const n = Number(key);
      const hit = index[n - 1];
      if (!hit) continue;
      const cur = byQuestion.get(hit.qIdx) ?? { selected: [] };
      cur.selected.push(hit.label);
      byQuestion.set(hit.qIdx, cur);
    }

    // 说明文字挂到第一道被选中的题上：DSH 的 custom 是单题字段
    if (picked.note) {
      const first = [...byQuestion.keys()][0];
      if (first !== undefined) byQuestion.get(first).custom = picked.note;
    }

    const answers = questions.map((q, qIdx) => {
      const got = byQuestion.get(qIdx);
      return {
        id: String(q?.id ?? ''),
        selected: got?.selected ?? [],
        ...(got?.custom ? { custom: got.custom } : {}),
      };
    });

    return { answers };
  }

  /**
   * 用编号回复（Ling-bot 调用）。
   *
   * 这是**唯一**的回复入口：数字先按当初发出的选项表翻译成 key，
   * 再交给队列结算。不猜、不越界、对不上就明确报错。
   *
   * @param {string} id
   * @param {string} raw 用户原始回复（"1"、"2"、"4.补充说明"）
   * @returns {{ok: boolean, error?: string, kind?: string, value?: any}}
   */
  reply(id, raw) {
    const entry = this.#queue.get(String(id));
    if (!entry) {
      return { ok: false, error: `没有编号为 ${id} 的待回复（可能已超时）` };
    }

    const parsed = parseReply(raw, entry);
    if (!parsed.ok) return { ok: false, error: parsed.reason, kind: entry.kind };

    if (entry.kind === 'approval') {
      // 审批只能单选；key 直接就是 ApprovalOutcome
      if (parsed.keys.length !== 1) {
        return { ok: false, error: '审批只能选一个', kind: entry.kind };
      }
      const outcome = parsed.keys[0];
      if (!['allowed-once', 'rejected'].includes(outcome)) {
        return { ok: false, error: `结论不合法：${outcome}`, kind: entry.kind };
      }
      this.#queue.settle(String(id), outcome);
      return { ok: true, kind: 'approval', value: outcome };
    }

    // 提问：把编号和说明原样交给结算，由 askQuestion 里的 #toAnswer 组装
    this.#queue.settle(String(id), { keys: parsed.keys, note: parsed.note });
    return { ok: true, kind: 'question', value: { keys: parsed.keys, note: parsed.note } };
  }

  /**
   * 直接指定结论（保留给旧调用方 / 内部使用）。
   *
   * @param {string} id
   * @param {string} outcome
   * @returns {{ok: boolean, error?: string}}
   */
  answer(id, outcome) {
    const VALID = new Set(['allowed-once', 'rejected', 'cancelled']);
    if (!VALID.has(outcome)) {
      return { ok: false, error: `结论必须是 allowed-once / rejected / cancelled，收到 ${outcome}` };
    }
    return this.#queue.settle(String(id), outcome);
  }

  /** 当前等待中的条目（给 QQ 侧展示"还有哪些没处理"） */
  listPending() {
    return this.#queue.list();
  }

  /* ---------------------------------------------------------------- 指令 */

  /**
   * 收下一条来自 QQ 的指令（Ling-bot 调用）。
   *
   * @param {object} cmd
   * @returns {{ok: boolean, error?: string}}
   */
  async command(cmd) {
    const text = String(cmd?.text ?? '').trim();
    if (!text) return { ok: false, error: '指令不能为空' };
    if (text.length > 4000) return { ok: false, error: '指令太长（上限 4000 字）' };

    const item = {
      text,
      sessionId: cmd?.sessionId ? String(cmd.sessionId) : '',
      from: String(cmd?.from ?? ''),
      at: Date.now(),
    };

    // 先交给 DSH。交不出去就明确报错，不要静默丢——
    // 用户以为指令发出去了，实际什么都没发生，这是最难查的故障。
    if (this.#onCommand) {
      try {
        await this.#onCommand(item);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    }

    // 没有投递通道就排队，等 DSH 侧来取
    this.#commands.push(item);
    if (this.#commands.length > 50) this.#commands.shift();
    return { ok: true };
  }

  /** 取走排队中的指令（DSH 侧轮询用） */
  drainCommands() {
    const out = this.#commands;
    this.#commands = [];
    return out;
  }

  /**
   * 记录一条投递失败，等 Ling-bot 来取。
   *
   * 不直接在这里发 QQ 消息：桥不认识 QQ，也不该认识。
   * 它只负责攒着，由 Ling-bot 决定怎么告诉用户。
   *
   * @param {{text?: string, error?: string}} info
   */
  reportFailure(info) {
    this.#failures.push({
      text: String(info?.text ?? '').slice(0, 200),
      error: String(info?.error ?? '未知原因').slice(0, 300),
      at: Date.now(),
    });
    if (this.#failures.length > 20) this.#failures.shift();
  }

  /** 取走投递失败记录 */
  drainFailures() {
    const out = this.#failures;
    this.#failures = [];
    return out;
  }

  /* ---------------------------------------------------------------- 生命周期 */

  /** 清掉所有等待中的条目（进程退出前调用，让 DSH 不会一直卡住） */
  shutdown() {
    this.#queue.cancelAll();
  }
}

/* ------------------------------------------------------------------ HTTP */

/**
 * 起一个最小 HTTP 服务。
 *
 * 只认这四条路由，且全部要求 `Authorization: Bearer <token>`。
 * 不实现 CORS、不实现静态文件、不实现 OPTIONS —— 少一个入口就少一条被利用的路径。
 *
 * @param {DshBridge} bridge
 * @param {number} port
 * @param {string} [host] 默认只绑回环地址
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>}>}
 */
export function serve(bridge, port = DEFAULT_PORT, host = '127.0.0.1') {
  /** @param {http.ServerResponse} res @param {number} code @param {any} body */
  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      // 明确禁止缓存：审批结论是实时的，缓存会给出过期答案
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    // 只接受本机回环来源。绑 127.0.0.1 已经拦住了外部，
    // 这里再挡一次是防止将来有人把 host 改成 0.0.0.0。
    const remote = req.socket.remoteAddress ?? '';
    const isLoopback =
      remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) return json(res, 403, { ok: false, error: '只接受本机请求' });

    // 鉴权：所有路由都要。没配令牌时 checkToken 恒为 false → 全拒。
    const auth = String(req.headers.authorization ?? '');
    const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!bridge.checkToken(got)) {
      return json(res, 401, { ok: false, error: '令牌无效' });
    }

    // 读请求体，带长度上限（防止有人往里灌大包占内存）
    const MAX_BODY = 64 * 1024;
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) {
          return json(res, 413, { ok: false, error: '请求体过大' });
        }
      }
    } catch {
      return json(res, 400, { ok: false, error: '读取请求体失败' });
    }

    /** @type {any} */
    let body = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
    }

    const url = req.url ?? '/';
    const route = url.split('?')[0];

    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: '只接受 POST' });
    }

    // 计数：用来回答"DSH 侧到底连过来了没有"。
    // 光看桥在监听不足以证明这一点——监听只说明本进程活着。
    bridge.noteHit(route);

    switch (route) {
      /* 插件探活：QQ 这边有没有人能处理审批 */
      case '/dsh/ping':
        return json(res, 200, {
          ok: true,
          ...bridge.quietState(),
          pending: bridge.listPending().length,
          // 诊断：哪些路由被调过、各几次。
          // 判断"DSH 侧真的连过来了吗"这是唯一客观依据——
          // 桥在监听只说明本进程活着，不代表对面来过。
          hits: bridge.hitStats(),
        });

      /* 插件问审批：这是唯一会**长时间挂起**的请求 */
      case '/dsh/ask': {
        const outcome = await bridge.ask(body);
        return json(res, 200, { ok: true, outcome });
      }

      /* 插件问问题（与审批同一条通路，但答案形状不同） */
      case '/dsh/ask-question': {
        const answer = await bridge.askQuestion(body);
        // null = 没人回答/超时/没有选项。调用方据此走自己的策略，
        // 绝不能把 null 当成"用户同意了"。
        return json(res, 200, { ok: true, answer });
      }

      /* 插件上报事件（用于 QQ 侧通知，不参与授权） */
      case '/dsh/event':
        return json(res, 200, { ok: true });

      /* Ling-bot 下发指令给 DSH */
      case '/qq/command': {
        const r = await bridge.command(body);
        return json(res, r.ok ? 200 : 400, r);
      }

      /* Ling-bot 用编号回复（统一入口：审批和提问都走这里） */
      case '/qq/answer': {
        // reply 是主路径（数字按选项表翻译）；
        // 老调用方仍可传 outcome 直接给结论。
        const r =
          body?.reply !== undefined
            ? bridge.reply(String(body?.id ?? ''), String(body.reply))
            : bridge.answer(String(body?.id ?? ''), String(body?.outcome ?? ''));
        return json(res, r.ok ? 200 : 400, r);
      }

      /* Ling-bot 查当前待审批列表 */
      case '/qq/pending':
        return json(res, 200, {
          ok: true,
          items: bridge.listPending(),
          failures: bridge.drainFailures(),
        });

      /* Ling-bot 设置/取消免打扰 */
      case '/qq/quiet': {
        if (body?.cancel) {
          bridge.unquiet();
          return json(res, 200, { ok: true, ...bridge.quietState() });
        }
        const ms = bridge.quiet(Number(body?.ms ?? 0));
        return json(res, 200, { ok: true, ms, ...bridge.quietState() });
      }

      /* DSH 侧取走排队中的指令 */
      case '/dsh/drain':
        return json(res, 200, { ok: true, items: bridge.drainCommands() });

      /* DSH 侧报告指令投递失败——必须让用户知道，否则他以为指令生效了 */
      case '/dsh/delivery-failed':
        bridge.reportFailure(body);
        return json(res, 200, { ok: true });

      default:
        return json(res, 404, { ok: false, error: `没有这个路由：${route}` });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        close: () =>
          new Promise((done) => {
            bridge.shutdown();
            server.close(() => done());
            // 强制关掉 keep-alive 连接，否则 close 会一直等
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

export { DEFAULT_PORT, APPROVAL_TIMEOUT_MS, MAX_QUIET_MS };
