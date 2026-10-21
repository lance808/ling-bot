/**
 * dsh-bridge —— 默认内置插件：把 DSH 的能力接进 Ling-bot（插件接口 v1）
 *
 * ## 这个插件做什么
 *
 * 提供一组**工具**，让 AI 能操作 DSH：
 *   - `dsh_ask`       给 DSH 的会话发一句话，拿回它的答复
 *   - `dsh_pending`   查看当前待审批/待回答的推送
 *
 * 清单（`plugin.json`）里声明的就是这两个；别再往这里加"文档里才有的"工具 ——
 * 工具清单以 JSON 为准，写在这里只会让读代码的人以为存在一个调不到的工具。
 *
 * 同时它也负责**反方向**：起一个回环端口，让 DSH 那边的
 * `dsh-qq-bridge` 插件把工具审批请求推过来，再通过 QQ 问管理员。
 *
 * ## v1 契约下的分工
 *
 * `plugin.json` 是**唯一事实来源**：id / 名称 / 配置项 / 工具声明全在那里，
 * 宿主只读 JSON 就能画出配置表单和工具清单，不需要先执行本文件。
 * 这里只负责**行为**：
 *
 *   init(ctx)          用 ctx.config + ctx.secrets 起端口
 *   callTool({tool})   执行清单里声明过的工具（清单里不再有 run）
 *   testConnection()   自检（不依赖 init 建的运行时单例）
 *   dispose()          关端口 + 清发现文件
 *   handleMessage()    接管管理员私聊里的审批回复与 /dsh 指令
 *
 * ## 为什么工具要分 R0/R1
 *
 * `dsh_pending` 只是读列表 → R0（不需确认）。
 * `dsh_ask` 会让 DSH 真的干活（可能写文件、跑命令）→ R1，
 * 而且它**不在群里可用**：群里任何人都能触发，等于把 DSH 遥控器交给陌生人。
 *
 * 这个限制由宿主按 `needs: 'host'` 推导（见 src/plugins/manifest.mjs），
 * 不是插件自己说了算。
 *
 * ## 为什么插件里自己起 HTTP 端口
 *
 * DSH 是**主动来问**的（审批必须同步等结果），Ling-bot 不能反向连 DSH——
 * DSH 没有对外开放的批准接口，只有 `approval/request` 事件。
 * 所以唯一可行的形态是：DSH 插件 → HTTP → 本插件 → QQ → 回复 → HTTP 响应。
 *
 * 端口只绑 127.0.0.1，且要求共享令牌。没有令牌就不启动。
 */

import http from 'node:http';

import { DshBridge, serve, DEFAULT_PORT } from './lib/bridge.mjs';
import { parseCommand, formatPendingList } from './lib/command.mjs';
import { renderPrompt } from './lib/prompt.mjs';
import { writeDiscovery, clearDiscovery } from './lib/discovery.mjs';

/* ------------------------------------------------------------------ 运行时 */

/**
 * 插件的运行时单例。
 *
 * 为什么用单例：HTTP 端口是进程级资源，同一进程里起两个会撞端口。
 * 而插件加载器只加载一次（in-process 运行时），所以单例在这里是安全的。
 */
class Runtime {
  /** @type {DshBridge | null} */
  bridge = null;
  /** @type {{close: () => Promise<void>, port: number} | null} */
  server = null;
  /** 管理员私聊会话键（审批消息的去处） */
  ownerConvKey = '';
  /** 发给 DSH 的 HTTP 地址由 DSH 侧决定，这里只记日志 */
  port = 0;
  /** init 时解析好的配置快照（配置变更时宿主会 dispose → init，所以不需要热读） */
  cfg = null;
  /** 宿主注入的发送函数（ctx.sendText） */
  sendText = null;
  /** 清理 signal 监听，避免重复 dispose */
  detachSignal = null;
  /**
   * 发出的消息 → 待回复编号。
   *
   * 用户引用某条消息回数字时，靠它反查出该结算哪一条。
   * 不用消息正文去匹配：正文会被 QQ 转义、截断、换行，
   * 匹配正文迟早会错，而 message_id 是平台给的唯一标识。
   *
   * @type {Map<string, {id: string, at: number}>}
   */
  msgIndex = new Map();
  /**
   * 日志函数（单参数包装，内部转成宿主契约的 (level, message, fields)）。
   *
   * handleMessage 是模块级导出，拿不到 init 的参数，
   * 所以要把 log 存在这里。之前在那边直接写 `log?.(...)`，
   * 运行时抛 `log is not defined`——而那个异常被上层吞掉、
   * 消息转给了 AI，表现就是"回复了但没反应"。
   *
   * @type {((msg: string) => void) | null}
   */
  log = null;
}

const rt = new Runtime();

/* ------------------------------------------------------------------ 配置 */

/**
 * 把清单里的 admins 文本解析成 QQ 号数组。
 *
 * 契约的配置类型只支持 text/textarea/password/number/boolean/enum，
 * 没有数组类型，所以清单里是「逗号分隔的文本」，解析放在这里。
 * 中英文逗号、顿号、空白都当分隔符（用户会怎么打字就怎么认）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseAdmins(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、\s]+/);
  /** @type {string[]} */
  const out = [];
  for (const v of list) {
    const s = String(v).trim();
    // 只收看起来像 QQ 号的：4–15 位数字。别的直接丢掉，
    // 免得一个手滑的空格把 admin 列表变成空。
    if (/^\d{4,15}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 端口兜底：非法值退回默认端口。
 *
 * 清单里已经声明了 min/max/integer，正常保存不进来非法值；
 * 这里兜底是为了"配置被手改过"时不至于监听随机端口。
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizePort(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

/**
 * 从宿主上下文读配置。
 *
 * **密钥走 ctx.secrets**：契约规定 secret 字段的值永远不进 config，
 * 只进保险箱，由宿主解密后放在 secrets 里给插件进程。
 *
 * @param {any} ctx
 */
function readConfig(ctx) {
  const c = ctx?.config ?? {};
  const s = ctx?.secrets ?? {};
  return {
    // password 类型隐含 secret，所以正常路径是 s.token；c.token 只是兜底
    token: String(s.token ?? c.token ?? '').trim(),
    port: normalizePort(c.port),
    admins: parseAdmins(c.admins),
    sessionId: String(c.sessionId ?? '').trim(),
  };
}

/**
 * 把宿主的 (level, message, fields) 日志函数包成单参数形式。
 *
 * @param {any} ctx
 * @returns {(msg: string, fields?: object) => void}
 */
function makeLog(ctx) {
  const hostLog = typeof ctx?.log === 'function' ? ctx.log : null;
  return (msg, fields) => {
    if (hostLog) {
      hostLog('info', String(msg), fields);
      return;
    }
    // 没有宿主日志时（例如单元测试直接 import）退回控制台，别静默吞掉
    console.log(`[dsh-bridge] ${String(msg)}`);
  };
}

/* ------------------------------------------------------------------ 工具 */

/**
 * 给 DSH 发一句话并等答复。
 *
 * 这里刻意**不**自己实现一套 HTTP 调用：DSH 的对外接口形态由
 * `dsh-qq-bridge` 插件决定，插件间通过桥进程通信，
 * 而不是让 Ling-bot 去猜 DSH 的内部 API（那会随版本碎掉）。
 *
 * 所以 `dsh_ask` 的行为是：把指令放进桥的队列，
 * DSH 插件轮询取走后执行，结果通过 `dsh_replies` 取回。
 *
 * @param {any} args
 * @param {any} ctx
 */
async function toolAsk(args, ctx) {
  const text = String(args?.text ?? '').trim();
  if (!text) return { ok: false, code: 'E4041', message: 'text 不能为空' };

  const b = rt.bridge;
  if (!b) return { ok: false, code: 'E1001', message: 'DSH 桥未启动（检查插件配置与启用状态）' };

  const cfg = rt.cfg ?? readConfig(ctx);
  const r = await b.command({
    text,
    sessionId: String(args?.sessionId ?? cfg.sessionId ?? ''),
    from: 'tool',
  });
  if (!r.ok) return { ok: false, code: 'E1001', message: r.error };

  return {
    ok: true,
    /** 告诉调用方：指令已交给 DSH，答复会稍后送到 QQ */
    message: '已交给 DSH，答复会发到管理员私聊',
  };
}

/**
 * 列出当前等待审批的请求（让 AI 能回答"DSH 有什么卡着"）
 *
 * @param {any} ctx
 */
async function toolPending(ctx) {
  const b = rt.bridge;
  if (!b) return { ok: false, code: 'E1001', message: 'DSH 桥未启动' };
  const items = b.listPending();
  // 队列里存的是 {id, kind, title, preview}；formatPendingList 要的是
  // {id, toolName, reason}。在这里做形状适配，不去改 lib 的导出签名。
  const rows = items.map((p) => ({ id: p.id, toolName: p.preview, reason: p.title }));
  return {
    ok: true,
    count: rows.length,
    items: rows.map((p) => ({ id: p.id, tool: p.toolName, reason: p.reason })),
    text: formatPendingList(rows),
  };
}

/* ------------------------------------------------------------------ 生命周期 */

/**
 * 起桥端口。幂等。
 *
 * @param {any} ctx 宿主 PluginContext
 * @returns {Promise<{ok: boolean, code?: string, message: string}>}
 */
async function startBridge(ctx) {
  // 已经起着：重复 init 不该撞端口，也不该重置 ownerConvKey
  if (rt.server) return { ok: true, message: `已在监听 127.0.0.1:${rt.port}` };

  const cfg = readConfig(ctx);
  rt.cfg = cfg;
  rt.log = makeLog(ctx);
  if (typeof ctx?.sendText === 'function') rt.sendText = ctx.sendText;

  if (!cfg.token) {
    // 没配令牌 = 不启动。这是"默认装上但什么都不做"的关键：
    // 不会凭空开端口，也不需要用户先去关掉它。
    return { ok: false, code: 'E4063', message: '还没配共享令牌（插件页 → DSH 接入 → 共享令牌）' };
  }
  if (cfg.admins.length === 0) {
    return { ok: false, code: 'E4063', message: '还没配管理员 QQ 号（插件页 → DSH 接入 → 管理员 QQ）' };
  }

  rt.ownerConvKey = `private:${cfg.admins[0]}`;
  rt.bridge = new DshBridge({
    token: cfg.token,
    onAsk: async (req) => {
      const id = String(req?.id ?? '?');
      const kind = String(req?.kind ?? 'approval');

      // 推送内容**完全由选项表决定**：审批两项、提问可能五项。
      // 渲染和解析用的是同一张表（桥里存着），所以"界面上有 3"
      // 和"后端认 3"永远一致。
      const lines = [];
      if (kind === 'approval') {
        lines.push(`DSH 要执行：${String(req?.preview ?? req?.toolName ?? '未知工具')}`);
        const reason = String(req?.reason ?? '').trim();
        if (reason) lines.push(reason.length > 300 ? `${reason.slice(0, 300)}…` : reason);
      } else {
        // 提问：题干来自 questionChoices 的 lines；选项由 renderPrompt 统一渲染
        lines.push(`DSH 在问你（${String(req?.preview ?? '')}）`);
        lines.push(...(Array.isArray(req?.lines) ? req.lines : []));
      }

      const text = renderPrompt({
        id,
        title: kind === 'approval' ? '操作审批' : '需要你决定',
        spec: {
          title: kind === 'approval' ? '操作审批' : '需要你决定',
          choices: req?.spec?.choices ?? [],
          multiSelect: req?.spec?.multiSelect === true,
        },
        lines,
      });

      rt.log?.(`${kind === 'approval' ? '审批' : '提问'} ${id}：准备推送到 ${rt.ownerConvKey}`);
      const send = rt.sendText;
      if (!send) {
        rt.log?.('没有可用的发送通道（ctx.sendText 缺失），推送跳过');
        return;
      }
      try {
        const r = await send(rt.ownerConvKey, text);
        if (r && r.ok === false) {
          // 闸门拒绝是**返回**而不是抛错，不检查就会静默失败：
          // 请求在桥里挂着，QQ 那边什么也没收到，DSH 一直等到超时。
          rt.log?.(`推送被拒：${r.code} ${r.message}`);
        } else {
          // 记住"这条消息对应哪个待回复编号"。
          // 用户引用它回数字时，靠这张表把引用反查回编号——
          // 这是唯一可靠的定位方式，不依赖"当前只有一条"这种猜测。
          const mid = r?.messageId;
          if (mid !== undefined && mid !== null) {
            rt.msgIndex.set(String(mid), { id, at: Date.now() });
            // 只留最近 50 条，避免长时间运行后无限增长
            if (rt.msgIndex.size > 50) {
              const oldest = [...rt.msgIndex.entries()].sort((a, b) => a[1].at - b[1].at)[0];
              if (oldest) rt.msgIndex.delete(oldest[0]);
            }
          }
          rt.log?.(`推送已发送 ${id}（message_id=${mid ?? '?'}）`);
        }
      } catch (err) {
        rt.log?.(`推送失败：${String(/** @type {any} */ (err)?.message ?? err)}`);
      }
    },
    // 用队列模式：DSH 侧轮询 /dsh/drain 取走，插件不主动连 DSH
    onCommand: null,
  });

  try {
    rt.server = await serve(rt.bridge, cfg.port, '127.0.0.1');
    rt.port = rt.server.port;
    rt.log?.(`DSH 桥已监听 127.0.0.1:${rt.port}`);
    // 把**实际**端口写到两侧共享的位置。
    // DSH 侧桥地址留空时会读它——于是换端口不用两边各改一次。
    if (await writeDiscovery({ port: rt.port })) {
      rt.log?.('端口发现文件已更新');
    }
    return { ok: true, message: `已监听 127.0.0.1:${rt.port}` };
  } catch (err) {
    const e = /** @type {any} */ (err);
    rt.bridge = null;
    const msg = e?.code === 'EADDRINUSE' ? `端口 ${cfg.port} 被占用` : String(e?.message ?? e);
    return { ok: false, code: 'E4064', message: msg };
  }
}

/**
 * 停掉端口，让等待中的审批拿到结论（不让 DSH 无限等）。
 *
 * @returns {Promise<void>}
 */
async function stopBridge() {
  rt.detachSignal?.();
  rt.detachSignal = null;
  if (rt.server) {
    await rt.server.close();
    rt.server = null;
    rt.bridge = null;
    rt.port = 0;
    // 桥没了，发现文件就过期了。不删的话 DSH 会一直去连一个没人听的端口。
    await clearDiscovery();
  }
  rt.msgIndex.clear();
}

/**
 * 待回复队列 → 给人看的行。
 *
 * 队列条目是 {id, kind, title, preview, choices}，而 formatPendingList
 * 期待 {id, toolName, reason}。两者字段名不同，直接传会渲染成
 * 「[3] undefined」——所以在这一层适配，不改 lib 的导出签名。
 *
 * @returns {Array<{id: string, toolName: string, reason: string}>}
 */
function pendingRows() {
  const items = rt.bridge?.listPending() ?? [];
  return items.map((p) => ({
    id: String(p.id),
    toolName: String(p.preview ?? ''),
    reason: String(p.title ?? ''),
  }));
}

/**
 * 把一次成功回复转成人能读的回执。
 *
 * 为什么不是简单回"已处理"：用户是按编号答的，他需要看到
 * **编号实际对应了什么**。审错一项的代价可能是批准一次写文件。
 *
 * @param {{kind?: string, value?: any}} r
 * @returns {string}
 */
function describeChoice(r) {
  if (r?.kind === 'approval') {
    return r.value === 'allowed-once' ? '✓ 允许一次' : '✗ 已拒绝';
  }
  if (r?.kind === 'question') {
    const keys = r.value?.keys ?? [];
    const note = String(r.value?.note ?? '').trim();
    return `✓ 已提交：${keys.join(', ')}${note ? `（备注：${note}）` : ''}`;
  }
  return '✓ 已提交';
}

/**
 * 处理一条 QQ 消息。返回 true 表示已接管（不再走 AI 回合）。
 *
 * 注意：群聊一律不接管——群里任何人都看得见，不能让群友遥控 DSH。
 *
 * @param {object} evt
 * @param {(convKey: string, text: string) => Promise<any>} sendText
 * @param {any} [ctx]
 * @returns {Promise<boolean>}
 */
async function onMessage(evt, sendText, ctx) {
  if (!rt.bridge) return false;

  const text = String(evt?.text ?? '').trim();
  if (!text) return false;

  // 群聊一律不接管：群里任何人都看得见，不能让群友遥控 DSH
  if (evt?.isGroup) return false;

  const cfg = rt.cfg ?? readConfig(ctx);
  const senderId = String(evt?.sender?.userId ?? '');
  if (!cfg.admins.includes(senderId)) return false;

  const convKey = String(evt?.convKey ?? `private:${senderId}`);
  const log = rt.log;
  // 优先用宿主这次调用传进来的发送函数；init 里存的那份是兜底
  const send = typeof sendText === 'function' ? sendText : rt.sendText;
  if (!send) {
    log?.('没有可用的发送通道，消息无法回执');
    return false;
  }

  /* ---- 主路径：引用某条推送后回复数字 ---------------------------------- */

  // 引用是**唯一**能确定"你在回答哪一条"的依据。
  // 不靠"当前只有一条待回复"来推断——那个推断在并发时会批错对象。
  //
  // 字段来自 normalizeEvent：`replyTo = { messageId }`。
  // 早先这里读的是 `evt.replyToMessageId`（不存在的字段），
  // 于是引用永远识别不到，回数字全被当成普通消息。
  const quotedId = String(
    evt?.replyTo?.messageId ?? evt?.replyToMessageId ?? '',
  ).trim();
  if (quotedId) {
    const target = rt.msgIndex?.get(quotedId);
    if (target) {
      const r = rt.bridge.reply(target.id, text);
      if (!r.ok) {
        await send(convKey, `没处理成功：${r.error}`);
        return true;
      }
      // 用掉了就销毁映射：不允许对同一条回复两次
      rt.msgIndex.delete(quotedId);
      await send(convKey, describeChoice(r));
      return true;
    }
  }

  // 没引用但回了数字：只有在恰好一条待回复时才接受。
  // 有多条时必须让用户引用，否则无法确定意图。
  if (/^\d+(?:\s*[.。,，、:：]\s*[\s\S]*)?$/.test(text)) {
    const ids = rt.bridge.listPending().map((p) => p.id);
    if (ids.length === 1) {
      const r = rt.bridge.reply(ids[0], text);
      if (r.ok) {
        await send(convKey, describeChoice(r));
        return true;
      }
    } else if (ids.length > 1) {
      await send(convKey, `现在有 ${ids.length} 条待回复，请**引用**你要回答的那条再回数字。`);
      return true;
    }
  }

  const pendingIds = rt.bridge.listPending().map((p) => p.id);
  const parsed = parseCommand(text, { pendingIds });

  if (parsed.kind === 'unknown') return false;

  if (parsed.kind === 'approve' || parsed.kind === 'reject') {
    const outcome = parsed.kind === 'approve' ? 'allowed-once' : 'rejected';
    const r = rt.bridge.answer(parsed.id, outcome);
    await send(
      convKey,
      r.ok ? `${outcome === 'allowed-once' ? '✓ 已同意' : '✗ 已拒绝'} ${parsed.id}` : `没处理成功：${r.error}`,
    );
    return true;
  }

  if (parsed.kind === 'pending') {
    await send(convKey, formatPendingList(pendingRows()));
    return true;
  }

  if (parsed.kind === 'quiet') {
    const ms = rt.bridge.quiet(parsed.ms ?? 0);
    await send(convKey, `已免打扰 ${Math.round(ms / 60000)} 分钟，期间审批自动同意。`);
    return true;
  }

  if (parsed.kind === 'unquiet') {
    rt.bridge.unquiet();
    await send(convKey, '已取消免打扰。');
    return true;
  }

  if (parsed.kind === 'command') {
    const r = await rt.bridge.command({
      text: parsed.text,
      sessionId: cfg.sessionId,
      from: senderId,
    });
    await send(convKey, r.ok ? `已交给 DSH：${parsed.text.slice(0, 60)}` : `交不过去：${r.error}`);
    return true;
  }

  return false;
}

/**
 * 端口自检：临时 bind 一下再放开。
 *
 * 只在没有现成监听时用。**不依赖 init 建的运行时单例**——契约要求
 * testConnection 可以在未初始化状态下调用（插件页点「测试连接」时
 * 插件可能正是 error/needs-config）。
 *
 * @param {number} port
 * @returns {Promise<{ok: boolean, message: string, code?: string}>}
 */
function probePort(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once('error', (err) => {
      const e = /** @type {any} */ (err);
      resolve({
        ok: false,
        code: e?.code === 'EADDRINUSE' ? 'E4064' : 'E4064',
        message:
          e?.code === 'EADDRINUSE'
            ? `端口 ${port} 已被占用，请换一个端口`
            : `无法监听 127.0.0.1:${port}（${String(e?.message ?? e)}）`,
      });
    });
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve({ ok: true, message: `端口 ${port} 可用（127.0.0.1）` }));
    });
  });
}

/* ------------------------------------------------------------------ 插件声明 */

export default {
  /**
   * 初始化：起回环端口 + 写端口发现文件。
   *
   * 配置不合法（缺令牌/缺管理员）时返回 {ok:false}：
   * 宿主据此把状态标成「初始化失败」或「待配置」，工具不会进入 AI 工具列表。
   * 这比"装上了但静默什么都不做"好排查得多。
   *
   * @param {any} ctx
   */
  async init(ctx) {
    const r = await startBridge(ctx);

    // 宿主停用插件时会 abort ctx.signal。挂上去是为了"停用即关端口"，
    // 而不是等宿主在 3 秒后放弃等待。
    if (ctx?.signal && typeof ctx.signal.addEventListener === 'function' && !rt.detachSignal) {
      const onAbort = () => {
        void stopBridge().catch(() => {});
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      rt.detachSignal = () => ctx.signal.removeEventListener('abort', onAbort);
    }

    return r;
  },

  /**
   * 执行清单里声明的工具。
   *
   * 清单只描述形状（参数、needs、risk、超时），执行逻辑全在这里。
   * 返回 `{ok:false, code, message}` 是合法的**工具结果**（会回灌给模型），
   * 不是宿主异常。
   *
   * @param {{tool: string, args: object, ctx: any, signal?: AbortSignal}} input
   */
  async callTool({ tool, args, ctx, signal }) {
    if (signal?.aborted) {
      return { ok: false, code: 'E4066', message: '调用已取消（插件正在停用）' };
    }
    switch (String(tool ?? '')) {
      case 'dsh_ask':
        return toolAsk(args, ctx);
      case 'dsh_pending':
        return toolPending(ctx);
      default:
        return { ok: false, code: 'E4041', message: `未知工具：${String(tool)}` };
    }
  },

  /**
   * 测试连接 / 自检。
   *
   * 不启动桥、不写发现文件、不依赖 init 建的实例：
   * 只校验配置形状，并试探端口是否可 bind。这样"插件没启用"时
   * 也能回答"我这套配置到底能不能跑"。
   *
   * @param {any} ctx
   */
  async testConnection(ctx) {
    const cfg = readConfig(ctx);
    /** @type {Record<string, any>} */
    const details = {
      port: cfg.port,
      adminCount: cfg.admins.length,
      tokenConfigured: cfg.token.length > 0,
      sessionId: cfg.sessionId || null,
      listening: rt.server !== null,
    };

    if (!cfg.token) {
      return { ok: false, message: '还没配共享令牌：没有令牌桥不会启动', details };
    }
    if (cfg.admins.length === 0) {
      return { ok: false, message: '还没配管理员 QQ 号：审批没有收件人', details };
    }
    // 桥已经在跑：端口必然可用，不用再 bind 一次（否则自己撞自己）
    if (rt.server) {
      return {
        ok: true,
        message: `桥正在监听 127.0.0.1:${rt.port}`,
        details: { ...details, port: rt.port },
      };
    }

    const probe = await probePort(cfg.port);
    return {
      ok: probe.ok,
      message: probe.ok ? `配置有效，${probe.message}` : probe.message,
      details,
    };
  },

  /**
   * 停用 / 重载前释放资源：关端口、清发现文件、取消在等的审批。
   *
   * @param {any} ctx
   */
  async dispose(ctx) {
    await stopBridge();
    rt.log?.(`DSH 桥已停止（端口 ${rt.port || '无'}）`);
  },

  /**
   * 接管 QQ 消息（仅 in-process 运行时）。
   *
   * 返回 true = 已处理，不再走 AI 回合。
   *
   * @param {{evt: object, sendText: (convKey: string, text: string) => Promise<any>, ctx: any}} input
   */
  async handleMessage({ evt, sendText, ctx }) {
    return onMessage(evt, sendText, ctx);
  },
};

/**
 * 兼容垫片：宿主 v1 只调用 `default.handleMessage`，
 * 这个命名导出留给"还按旧签名 `handleMessage(evt, sendText)` 调用"的代码路径。
 * 两者最终走同一个实现，不会出现两套行为。
 *
 * @param {object} evt
 * @param {(convKey: string, text: string) => Promise<any>} sendText
 * @returns {Promise<boolean>}
 */
export async function handleMessage(evt, sendText) {
  return onMessage(evt, sendText, null);
}
