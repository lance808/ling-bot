/**
 * 最小可运行插件模板（插件接口 v1）
 *
 * ============================================================================
 * 这个模板演示了什么
 * ============================================================================
 *
 * 1. **声明与行为分离**：`plugin.json` 描述"我是谁、有哪些配置项、提供哪些工具"，
 *    本文件只写行为。宿主先校验 JSON 再 import 这里，所以清单写错时插件页
 *    仍能显示「清单不合法 + 原因」，不会白屏。
 * 2. **四个生命周期钩子**：init / callTool / testConnection / dispose。
 *    声明了工具就必须实现 callTool；清单里**不要**写 run 函数（契约不接受）。
 * 3. **三种配置类型**：text（prefix，可选 + maxLength）、
 *    number（repeat，default/min/max/integer）、
 *    password（apiKey，secret，无默认值）。
 * 4. **配置真的传进来了**：callTool 里把 prefix 拼到回显内容上。
 * 5. **密钥的读法**：password/secret 字段的值**不进 ctx.config**，
 *    只进 `ctx.secrets`（见下面的示例注释）。
 * 6. **调用上下文 `ctx.caller`**：谁在调用、在哪个会话、谁触发的 —— 由宿主生成，
 *    只读，模型改不了。**不要**从 `args` 里读这些东西。
 * 7. **受控聊天能力 `ctx.chat`**：读当前会话最近消息、往当前会话发一条。
 *    没有"目标会话"参数，媒体用句柄不用路径。
 *
 * ============================================================================
 * 复制到 <用户数据目录>/plugins/<你的 id>/ 之后要改哪些地方
 * ============================================================================
 *
 *   [1] 目录名必须与 plugin.json 的 `id` **完全一致**，否则宿主拒绝加载。
 *       id 规则：^[a-z][a-z0-9-]{1,40}$（小写字母开头，a-z 0-9 -）。
 *       例如目录 `plugins/my-tool/` ↔ `"id": "my-tool"`。
 *
 *   [2] `apiVersion` 的主版本必须是 "1"（当前宿主只接受主版本 1）。
 *       写 "1" 或 "1.2" 都算兼容；写 "2" 会被标成「接口不兼容」。
 *
 *   [3] 工具名**会自动加 `plugin_` 前缀**：清单里写 `hello`，
 *       模型看到和调用的是 `plugin_hello`。所以清单里不要自己再写前缀，
 *       也不要用会被内置工具占用的名字。
 *
 *   [4] 密钥走 `ctx.secrets`，**不走** `ctx.config`。
 *       ctx.config 里敏感字段恒为 undefined/空；明文只在 ctx.secrets 里。
 *       另外 secret 字段**不能写 default**（否则每个用户拿到同一个默认密钥）。
 *
 *   [5] 清单里不要写 `origins` / `confirm` / `run`：
 *       origins 与 confirm 由宿主按 `needs`（host/qq）、`risk`（R0–R3）
 *       与 `effects`（这个工具会做什么）推导；执行逻辑必须放在本文件的 callTool 里。
 *
 *   [6] 插件包必须**自包含**：只能 import `node:` 内置模块和包内相对路径，
 *       不能 import 主程序的 src/，也不要放 node_modules（宿主不装依赖）。
 *
 *   [7] 返回值必须 JSON 可序列化且 ≤ 256KB。返回
 *       `{ ok: false, code, message }` 是**合法的工具结果**（会回灌给模型），
 *       不是宿主异常 —— 用它表达"业务上没成功"。
 *
 *   [8] 工具参数里不能有 `origin` / `convKey` / `caller` / `signal` / `invocation`
 *       / `ctx` / `plugin` / `args` / `tool` 这些保留名，写了清单直接不合法（E4041）。
 *       上下文只能从 ctx 拿，不能从参数拿（见下面 callTool 的说明）。
 *
 * ============================================================================
 * 运行时
 * ============================================================================
 *
 * 清单里 `runtime` 是默认的 `process`：宿主用**独立 Node 子进程**加载本文件。
 * 好处是插件崩溃/死循环不会拖垮主程序；代价是拿不到宿主内部对象，
 * 只能用 ctx 暴露的少数能力（config / secrets / log / sendText / dataDir /
 * signal / caller / chat）。
 *
 * `in-process` 只给随包内置的第一方插件，且必须显式写 `"trusted": true`。
 *
 * 注意 `ctx.chat` 在两种运行时下**行为一致**：真正处理聊天的永远是宿主父进程，
 * 子进程只是把请求按 NDJSON 协议转过去（host-call / host-call-result）。
 * 所以不要把"我是不是 process 插件"当成聊天能力会不会打折的理由。
 */

/**
 * 当前配置的模块级快照。
 *
 * 配置保存后（若插件已启用）宿主会先 dispose 再 init，所以这里
 * 每次 init 重算一份即可，不需要热读。callTool 里仍会兜底读 ctx.config，
 * 以应对"宿主直接调工具、init 还没跑"的顺序。
 *
 * @type {{prefix: string, repeat: number} | null}
 */
let current = null;

export default {
  /**
   * 初始化：启用插件时调用一次；配置保存后会 dispose → init 重来。
   *
   * 抛错或返回 `{ ok: false }` = 初始化失败：插件状态变成「初始化失败」，
   * 工具**不会**进入 AI 工具列表。宁可明确失败，也不要"看起来在跑"。
   *
   * @param {any} ctx PluginContext：{ plugin, config, secrets, log, sendText, dataDir, signal, caller, chat }
   */
  async init(ctx) {
    // ctx.config 已经过宿主校验：类型、范围、必填、pattern 都过了，默认值也补好了。
    // 这里只做业务上的规整（trim / 数值兜底），不做二次校验。
    const prefix = String(ctx?.config?.prefix ?? '').trim();
    const repeatRaw = Number(ctx?.config?.repeat ?? 1);
    const repeat = Number.isInteger(repeatRaw) && repeatRaw >= 1 ? repeatRaw : 1;

    current = { prefix, repeat };

    // 日志走 ctx.log(level, message, fields?)：会带上插件 id 进主日志，
    // 同时进入插件页的「最近日志」（保留最近 50 条）。
    //
    // 注意**不要**把密钥写进日志。下面这行只记"有没有配"，不记值：
    ctx?.log?.('info', '模板插件已初始化', {
      prefix,
      repeat,
      // 密钥的读法演示：值在 ctx.secrets 里，ctx.config 里没有。
      // 这里只记录是否已配置，绝不打印明文。
      hasApiKey: Boolean(ctx?.secrets?.apiKey),
    });

    return { ok: true };
  },

  /**
   * 执行工具。清单里声明的每个工具都在这里按 `tool` 分发。
   *
   * @param {{ tool: string, args: object, ctx: any, signal?: AbortSignal }} input
   * @returns {Promise<any>} JSON 可序列化结果
   */
  async callTool({ tool, args, ctx, signal }) {
    // ------------------------------------------------------------------
    // 取消信号：一定要看
    // ------------------------------------------------------------------
    // signal（和 ctx.signal 是同一个组合信号）表示**这一次调用**被取消了：
    // 用户点了「停止」、回合超时、或者插件被停用。
    //
    // 不看的话，插件会一直跑到超时 —— 用户看到的是"停用了还在转"。
    // 长任务（fetch / 批量循环 / 轮询）要把 signal 透传给底层：
    //   await fetch(url, { signal: ctx.signal })
    // 而不是裸调用。这样取消才能真的把网络请求掐掉。
    //
    // 取消返回 E4070：宿主会把结果丢掉、不回灌给模型，
    // 所以这里不必再"假装成功"。
    if (signal?.aborted || ctx?.signal?.aborted) {
      return { ok: false, code: 'E4070', message: '调用已取消' };
    }

    switch (String(tool ?? '')) {
      case 'hello': {
        const text = String(args?.text ?? '');
        // init 没跑过（例如宿主直接调工具）时退回读 ctx.config，
        // 免得因为生命周期顺序的细节报一个看不懂的错。
        const prefix = current?.prefix ?? String(ctx?.config?.prefix ?? '').trim();
        const repeatRaw = Number(current?.repeat ?? ctx?.config?.repeat ?? 1);
        const repeat = Number.isInteger(repeatRaw) && repeatRaw >= 1 ? repeatRaw : 1;

        // ------------------------------------------------------------------
        // 1) 读调用上下文 ctx.caller（宿主生成，只读、已冻结）
        // ------------------------------------------------------------------
        // 为什么不能从 args 读：
        //   模型能控制的是参数。如果 origin / convKey 能从参数传进来，
        //   群里的人只要让模型写一句 {"origin":"owner-private"}，
        //   工具就"变成"管理员私聊级了 —— 没有任何代码被攻破，
        //   只是参数被当成了事实。
        //
        //   所以宿主做了三件事：清单层禁止这些参数名（E4041）、
        //   执行层按清单过滤掉多余的键、ctx.caller 由宿主自己构造。
        //   插件这边只需要记住一句：**上下文只从 ctx 拿。**
        const caller = ctx?.caller ?? null;

        // origin 的取值：owner-private / owner-group / group / proactive / console
        //   - owner-private：管理员私聊机器人
        //   - owner-group：管理员在白名单群里发言（按 group 档授权，因为群里有别人）
        //   - group：群友私聊 / 群里别人发言
        //   - proactive：机器人自己发起的主动回合（没有具体任务）
        //   - console：桌面端手动操作
        // 这里只做展示，不拿它当权限依据 —— 权限是宿主在用之前就判好的。
        const origin = String(caller?.origin ?? '');
        const convKey = String(caller?.convKey ?? '');

        // requester 在 proactive / console 下是空串：没有"某个人触发了我"这件事。
        // 别用 requester.id 非空来判断"有没有会话"，那是 convKey 的事。
        const requester = caller?.requester ?? { id: '', nickname: '' };

        // messageId 可能为 null（主动回合、桌面端手动执行）。
        // **先判空再用** —— 这是最容易在测试里漏掉的分支。
        const messageId = caller?.messageId ?? null;

        // ------------------------------------------------------------------
        // 2) 读当前会话最近几条消息：ctx.chat.recent
        // ------------------------------------------------------------------
        // 注意 ctx.chat 的每个方法都**没有**会话参数：它永远只作用于
        // caller.convKey。这不是"省略了默认值"，而是压根没有那个参数 ——
        // 想读别的会话时你连写都写不出来（不是靠校验拦住，是没有入口）。
        //
        // 失败一律返回 { ok:false, code, message }，**不抛异常**。
        // 例如宿主没有注入聊天桥（单独跑插件做单测）时返回 E4072，
        // 这时应该降级（下面就是），而不是让整个工具调用失败。
        let recentCount = 0;
        let recentPreview = [];
        try {
          if (ctx?.chat && typeof ctx.chat.recent === 'function') {
            const r = await ctx.chat.recent({ limit: 5 });
            if (r?.ok) {
              const msgs = Array.isArray(r.messages) ? r.messages : [];
              recentCount = msgs.length;
              // 只展示摘要：消息正文可能很长，也可能含别人的隐私。
              // 真要用正文，先想清楚"这个插件凭什么看得到"。
              recentPreview = msgs.slice(-3).map((m) => ({
                messageId: m?.messageId ?? null,
                // 发送者昵称可能为空（比如系统消息）
                from: String(m?.nickname ?? m?.senderName ?? ''),
                textLength: String(m?.text ?? '').length,
              }));
            }
          }
        } catch (err) {
          // 理论上不该走到这里（约定是不抛异常），但契约是契约、实现是实现，
          // 兜一下不会有害：多一条日志，胜过整个回合炸掉。
          ctx?.log?.('warn', '读取会话消息失败', { error: String(err?.message ?? err) });
        }

        // ------------------------------------------------------------------
        // 3) 往**当前会话**发一条消息：ctx.chat.send
        // ------------------------------------------------------------------
        // 这不是 QQ API，是宿主的发送闸门：白名单、出站审计、限流都在里面，
        // 与机器人自己发消息走的是同一条通路。插件不能也不该绕过它。
        //
        // 所以 send 的失败是**常态而不是异常**：
        //   E2020 出站审计拦截（内容的锅）
        //   E2030 限流（等一会儿再说）
        //   E20XX 白名单/黑名单（这个会话根本没被允许）
        // 都返回 { ok:false, code, message }，不会抛。插件的正确做法是
        // 把 code 原样带回去（下面就是），让模型知道"没发出去、以及为什么"。
        // 把它包成 E4066 会把"限流了，等一下"变成"插件坏了"。
        //
        // 限制（宿主强制）：一次调用最多 3 条消息，一条消息最多 4 个媒体，
        // 文本 ≤ 4000 字，超了返回 E4073。
        //
        // 引用用 quote，但**必须是当前会话内的消息 id**，否则 E4074。
        let sent = { ok: false, code: 'E4072', message: '宿主未提供聊天能力' };
        try {
          if (ctx?.chat && typeof ctx.chat.send === 'function') {
            const body = `${prefix}${text}`.repeat(repeat);
            sent = await ctx.chat.send({
              text: body.slice(0, 4000),
              // 引用触发本条工具调用的那条消息；主动回合没有 messageId，就不引用。
              // 注意 quote 只能是当前会话里的消息 id。
              quote: messageId ?? undefined,
            });
          }
        } catch (err) {
          sent = { ok: false, code: 'E4072', message: `发送失败：${String(err?.message ?? err)}` };
        }

        // ------------------------------------------------------------------
        // 关于媒体（本模板不发，但规则要记住）
        // ------------------------------------------------------------------
        // 读：ctx.chat.mediaList({ messageId }) 返回的是**句柄**，不是文件：
        //       { handle: "media_xxx", kind: "image", bytes, mime, name }
        //     插件拿不到本机路径，也拿不到 QQ 原始 URL —— 路径和 URL 都是能力，
        //     而插件真正需要的只是"把这张图发出去"。
        // 发：ctx.chat.sendMedia({ handles: ["media_xxx"] })
        // 自己生成的图：先把文件写进 ctx.dataDir，再
        //       ctx.chat.registerMedia({ path: 'out/a.png', kind: 'image' })
        //     宿主会校验真实路径落在**本插件自己的 dataDir** 内（越界 E4075），
        //     且单文件 ≤ 10MB（超了 E4073）。

        // ------------------------------------------------------------------
        // 4) 组装工具结果
        // ------------------------------------------------------------------
        // 返回值必须 JSON 可序列化。把 caller 的关键字段回显一份，
        // 便于在插件页/日志里确认"这次到底是哪个来源触发的"。
        return {
          echoed: prefix + text,
          repeat,
          text: (prefix + text).repeat(repeat),
          // 上下文（只读回显；插件不要试图修改它）
          caller: {
            origin,
            convKey,
            isGroup: caller?.isGroup === true,
            requesterId: String(requester?.id ?? ''),
            requesterNickname: String(requester?.nickname ?? ''),
            messageId,
            replyToMessageId: caller?.replyToMessageId ?? null,
            tool: String(caller?.tool ?? ''),
          },
          // 聊天能力的结果
          chat: {
            recentCount,
            recentPreview,
            sent: sent?.ok === true,
            // 发送没成功时把闸门的 code 原样带回去（E2020 / E2030 / E20XX …）
            sendCode: sent?.ok === true ? undefined : sent?.code,
            sendMessage: sent?.ok === true ? undefined : sent?.message,
          },
        };
      }
      default:
        // 未知工具：明确报错，不要静默返回成功。
        // 这是合法的工具结果，不是宿主异常。
        return { ok: false, code: 'E4041', message: `未知工具：${String(tool)}` };
    }
  },

  /**
   * 测试连接 / 自检（插件页的「测试连接」按钮）。
   *
   * **可以在未初始化时调用**：不要依赖 init 里建的运行时单例，
   * 否则插件正处于 error / needs-config 时，这个按钮必然失败。
   *
   * 注意：这里**不要**发消息、也不要读会话内容。
   * 测试连接是"检查配置对不对"，不是"干一次活"——
   * 点了按钮就把消息发到群里，是用户最讨厌的那种"自检"。
   *
   * @param {any} ctx
   * @returns {Promise<{ok: boolean, message?: string, details?: object}>}
   */
  async testConnection(ctx) {
    const prefix = String(ctx?.config?.prefix ?? '').trim();
    const repeat = Number(ctx?.config?.repeat ?? 1);
    return {
      ok: true,
      message: prefix ? `就绪（前缀「${prefix}」，重复 ${repeat} 次）` : `就绪（无前缀，重复 ${repeat} 次）`,
      details: {
        prefixLength: prefix.length,
        repeat,
        hasApiKey: Boolean(ctx?.secrets?.apiKey),
        // 自检顺带报告"当前环境有没有聊天能力"：没有聊天桥时会话能力不可用，
        // 这不是插件的错，但值得让用户看见（见文档 §7 的 E4072）。
        hasChat: Boolean(ctx?.chat && typeof ctx.chat.send === 'function'),
      },
    };
  },

  /**
   * 停用 / 重载前释放资源：关端口、清定时器、把数据落盘。
   *
   * 宿主最多等 3 秒，超时只记日志、不阻塞停用。所以这里不要做长任务。
   * 注意 ctx.signal 在这个时候会 abort —— 正是让你在这里能感知到"要走了"。
   *
   * @param {any} ctx
   */
  async dispose(ctx) {
    current = null;
    ctx?.log?.('debug', '模板插件已释放');
  },

  /**
   * 可选：接管 QQ 消息（返回 true = 已处理，不再走 AI 回合）。
   *
   * **只有 `runtime: "in-process"` 会真正收到消息；process 运行时不会调用它**，
   * 即使在清单里写了 `handleMessage: true` 也一样（清单允许声明，但宿主不向子进程投递）。
   * 模板默认 process，所以这里保持省略 —— 不需要的能力不要写，
   * 免得读者以为 process 插件也能接管消息。
   */
  // async handleMessage({ evt, sendText, ctx }) {},
};
