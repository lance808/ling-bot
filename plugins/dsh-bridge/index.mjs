/**
 * dsh-bridge —— 默认内置插件：把 DSH 的能力接进 Ling-bot（需求 2）
 *
 * ## 这个插件做什么
 *
 * 提供一组**工具**，让 AI 能操作 DSH：
 *   - `dsh_ask`       给 DSH 的会话发一句话，拿回它的答复
 *   - `dsh_sessions`  列出 DSH 里有哪些会话
 *
 * 同时它也负责**反方向**：起一个回环端口，让 DSH 那边的
 * `dsh-qq-bridge` 插件把工具审批请求推过来，再通过 QQ 问管理员。
 *
 * ## 为什么工具要分 R0/R1
 *
 * `dsh_sessions` 只是读列表 → R0（不需确认）。
 * `dsh_ask` 会让 DSH 真的干活（可能写文件、跑命令）→ R1，
 * 而且它**不在群里可用**：群里任何人都能触发，等于把 DSH 遥控器交给陌生人。
 *
 * 这个限制由宿主推导（见 `needs: 'host'`），不是插件自己说了算。
 *
 * ## 为什么插件里自己起 HTTP 端口
 *
 * DSH 是**主动来问**的（审批必须同步等结果），Ling-bot 不能反向连 DSH——
 * DSH 没有对外开放的批准接口，只有 `approval/request` 事件。
 * 所以唯一可行的形态是：DSH 插件 → HTTP → 本插件 → QQ → 回复 → HTTP 响应。
 *
 * 端口只绑 127.0.0.1，且要求共享令牌。没有令牌就不启动。
 */

import { DshBridge, serve, DEFAULT_PORT } from './lib/bridge.mjs';
import { parseCommand, formatPendingList } from './lib/command.mjs';
import { renderPrompt } from './lib/prompt.mjs';
import { writeDiscovery, clearDiscovery } from './lib/discovery.mjs';

/* ------------------------------------------------------------------ 运行时 */

/**
 * 插件的运行时单例。
 *
 * 为什么用单例：HTTP 端口是进程级资源，同一进程里起两个会撞端口。
 * 而插件加载器只加载一次，所以单例在这里是安全的。
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
   * 日志函数。
   *
   * `handleMessage` 是模块级导出，拿不到 `startBridge` 的参数，
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
 * 读配置。
 *
 * 优先用**宿主传进来的 config**，环境变量只是后备：
 * 用户在设置页改的东西必须立刻生效，不能要求他设环境变量再重启。
 *
 * 环境变量存在的意义只有一个：自动化测试时注入，
 * 免得为了跑一次 e2e 去改用户的 config.json。
 *
 * @param {any} [hostCfg]
 */
function readCfg(hostCfg) {
  const d = hostCfg?.dsh ?? {};

  const adminsRaw = d.admins ?? process.env.LING_DSH_ADMINS ?? '';
  const admins = (Array.isArray(adminsRaw) ? adminsRaw : String(adminsRaw).split(/[,，、\s]+/))
    .map((s) => String(s).trim())
    .filter((s) => /^\d{4,15}$/.test(s));

  return {
    token: String(d.token ?? process.env.LING_DSH_TOKEN ?? '').trim(),
    port: Number(d.port ?? process.env.LING_DSH_PORT) || DEFAULT_PORT,
    admins,
    sessionId: String(d.sessionId ?? process.env.LING_DSH_SESSION ?? '').trim(),
  };
}

/**
 * 宿主配置的当前快照。
 *
 * 插件不缓存它：配置随时可能被设置页改掉，
 * 每次读都取最新的一份，才不会出现"改了要重启"。
 * @type {() => any}
 */
let getConfig = () => ({});

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
 */
async function toolAsk(args) {
  const text = String(args?.text ?? '').trim();
  if (!text) return { ok: false, code: 'E4041', message: 'text 不能为空' };

  const b = rt.bridge;
  if (!b) return { ok: false, code: 'E1001', message: 'DSH 桥未启动（检查 config.dsh.enabled）' };

  const cfg = readCfg(getConfig());
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

/** 列出当前等待审批的请求（让 AI 能回答"DSH 有什么卡着"） */
async function toolPending() {
  const b = rt.bridge;
  if (!b) return { ok: false, code: 'E1001', message: 'DSH 桥未启动' };
  const items = b.listPending();
  return {
    ok: true,
    count: items.length,
    items: items.map((p) => ({ id: p.id, tool: p.toolName, reason: p.reason })),
    text: formatPendingList(items),
  };
}

/* ------------------------------------------------------------------ 生命周期 */

/**
 * 启动桥端口。幂等。
 *
 * @param {object} o
 * @param {(convKey: string, text: string) => Promise<any>} o.sendText
 * @param {(msg: string, meta?: object) => void} [o.log]
 * @param {() => any} [o.getConfig] 取宿主配置的函数（不传则只能用环境变量）
 */
export async function startBridge({ sendText, log, getConfig: gc }) {
  if (typeof gc === 'function') getConfig = gc;
  // 模块级的 handleMessage 要用（见 Runtime.log 的注释）
  rt.log = typeof log === 'function' ? log : null;
  if (rt.server) return { ok: true, port: rt.port };

  const cfg = readCfg(getConfig());
  if (!cfg.token) {
    // 没配令牌 = 不启动。这是"默认装上但什么都不做"的关键：
    // 不会凭空开端口，也不需要用户先去关掉它。
    return { ok: false, error: '还没配共享令牌（设置 → DSH 接入 → 令牌）' };
  }
  if (cfg.admins.length === 0) {
    return { ok: false, error: '还没配管理员 QQ 号（设置 → DSH 接入 → 管理员）' };
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

      log?.(`${kind === 'approval' ? '审批' : '提问'} ${id}：准备推送到 ${rt.ownerConvKey}`);
      try {
        const r = await sendText(rt.ownerConvKey, text);
        if (r && r.ok === false) {
          // 闸门拒绝是**返回**而不是抛错，不检查就会静默失败：
          // 请求在桥里挂着，QQ 那边什么也没收到，DSH 一直等到超时。
          log?.(`推送被拒：${r.code} ${r.message}`);
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
          log?.(`推送已发送 ${id}（message_id=${mid ?? '?'}）`);
        }
      } catch (err) {
        log?.(`推送失败：${String(err?.message ?? err)}`);
      }
    },
    // 用队列模式：DSH 侧轮询 /dsh/drain 取走，插件不主动连 DSH
    onCommand: null,
  });

  try {
    rt.server = await serve(rt.bridge, cfg.port, '127.0.0.1');
    rt.port = rt.server.port;
    log?.(`DSH 桥已监听 127.0.0.1:${rt.port}`);
    // 把**实际**端口写到两侧共享的位置。
    // DSH 侧桥地址留空时会读它——于是换端口不用两边各改一次。
    if (await writeDiscovery({ port: rt.port })) {
      log?.('端口发现文件已更新');
    }
    return { ok: true, port: rt.port };
  } catch (err) {
    const e = /** @type {any} */ (err);
    rt.bridge = null;
    const msg = e?.code === 'EADDRINUSE' ? `端口 ${cfg.port} 被占用` : String(e?.message ?? e);
    return { ok: false, error: msg };
  }
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
 * @param {object} evt
 * @param {(convKey: string, text: string) => Promise<any>} sendText
 * @returns {Promise<boolean>}
 */
export async function handleMessage(evt, sendText) {
  if (!rt.bridge) return false;

  const text = String(evt?.text ?? '').trim();
  if (!text) return false;

  // 群聊一律不接管：群里任何人都看得见，不能让群友遥控 DSH
  if (evt?.isGroup) return false;

  const cfg = readCfg(getConfig());
  const senderId = String(evt?.sender?.userId ?? '');
  if (!cfg.admins.includes(senderId)) return false;

  const convKey = String(evt?.convKey ?? `private:${senderId}`);
  const log = rt.log;

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
        await sendText(convKey, `没处理成功：${r.error}`);
        return true;
      }
      // 用掉了就销毁映射：不允许对同一条回复两次
      rt.msgIndex.delete(quotedId);
      await sendText(convKey, describeChoice(r));
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
        await sendText(convKey, describeChoice(r));
        return true;
      }
    } else if (ids.length > 1) {
      await sendText(convKey, `现在有 ${ids.length} 条待回复，请**引用**你要回答的那条再回数字。`);
      return true;
    }
  }

  const pendingIds = rt.bridge.listPending().map((p) => p.id);
  const parsed = parseCommand(text, { pendingIds });

  if (parsed.kind === 'unknown') return false;

  if (parsed.kind === 'approve' || parsed.kind === 'reject') {
    const outcome = parsed.kind === 'approve' ? 'allowed-once' : 'rejected';
    const r = rt.bridge.answer(parsed.id, outcome);
    await sendText(
      convKey,
      r.ok ? `${outcome === 'allowed-once' ? '✓ 已同意' : '✗ 已拒绝'} ${parsed.id}` : `没处理成功：${r.error}`,
    );
    return true;
  }

  if (parsed.kind === 'pending') {
    await sendText(convKey, formatPendingList(rt.bridge.listPending()));
    return true;
  }

  if (parsed.kind === 'quiet') {
    const ms = rt.bridge.quiet(parsed.ms ?? 0);
    await sendText(convKey, `已免打扰 ${Math.round(ms / 60000)} 分钟，期间审批自动同意。`);
    return true;
  }

  if (parsed.kind === 'unquiet') {
    rt.bridge.unquiet();
    await sendText(convKey, '已取消免打扰。');
    return true;
  }

  if (parsed.kind === 'command') {
    const r = await rt.bridge.command({
      text: parsed.text,
      sessionId: cfg.sessionId,
      from: senderId,
    });
    await sendText(convKey, r.ok ? `已交给 DSH：${parsed.text.slice(0, 60)}` : `交不过去：${r.error}`);
    return true;
  }

  return false;
}

/** 停掉端口，让等待中的审批拿到结论（不让 DSH 无限等） */
export async function stopBridge() {
  if (rt.server) {
    await rt.server.close();
    rt.server = null;
    rt.bridge = null;
    rt.port = 0;
    // 桥没了，发现文件就过期了。不删的话 DSH 会一直去连一个没人听的端口。
    await clearDiscovery();
  }
}

/* ------------------------------------------------------------------ 插件声明 */

export default {
  name: 'dsh-bridge',
  /**
   * 工具声明。
   *
   * `needs: 'host'` = 只给主人私聊和桌面端用，**群里不可见**。
   * 这是由宿主推导出来的，不是这里写了就算。
   */
  tools: [
    {
      name: 'dsh_ask',
      needs: 'host',
      risk: 'R1',
      description:
        '把一句话交给 DSH 执行（DSH 会真的动手，可能写文件或跑命令）。返回"已投递"，答复稍后发到管理员私聊。',
      params: {
        text: { type: 'string', required: true, maxLength: 4000, description: '要交给 DSH 的指令' },
        sessionId: { type: 'string', required: false, description: '投给哪个 DSH 会话；省略则用默认会话' },
      },
      run: (args) => toolAsk(args),
    },
    {
      name: 'dsh_pending',
      needs: 'host',
      risk: 'R0',
      description: '查看 DSH 当前有哪些操作在等管理员审批（只读）。',
      params: {},
      run: () => toolPending(),
    },
  ],
};
