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
 *       origins 与 confirm 由宿主按 `needs`（host/qq）与 `risk`（R0–R3）推导；
 *       执行逻辑必须放在本文件的 callTool 里。
 *
 *   [6] 插件包必须**自包含**：只能 import `node:` 内置模块和包内相对路径，
 *       不能 import 主程序的 src/，也不要放 node_modules（宿主不装依赖）。
 *
 *   [7] 返回值必须 JSON 可序列化且 ≤ 256KB。返回
 *       `{ ok: false, code, message }` 是**合法的工具结果**（会回灌给模型），
 *       不是宿主异常 —— 用它表达"业务上没成功"。
 *
 * ============================================================================
 * 运行时
 * ============================================================================
 *
 * 清单里 `runtime` 是默认的 `process`：宿主用**独立 Node 子进程**加载本文件。
 * 好处是插件崩溃/死循环不会拖垮主程序；代价是拿不到宿主内部对象，
 * 只能用 ctx 暴露的少数能力（config / secrets / log / sendText / dataDir / signal）。
 *
 * `in-process` 只给随包内置的第一方插件，且必须显式写 `"trusted": true`。
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
   * @param {any} ctx PluginContext：{ plugin, config, secrets, log, sendText, dataDir, signal }
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
    // 长任务要自己看 signal：宿主停用插件时会 abort。
    // 不看的话它会一直跑到超时，用户看到的是"停用了还在转"。
    if (signal?.aborted) {
      return { ok: false, code: 'E4066', message: '调用已取消（插件正在停用）' };
    }

    switch (String(tool ?? '')) {
      case 'hello': {
        const text = String(args?.text ?? '');
        // init 没跑过（例如宿主直接调工具）时退回读 ctx.config，
        // 免得因为生命周期顺序的细节报一个看不懂的错。
        const prefix = current?.prefix ?? String(ctx?.config?.prefix ?? '').trim();
        const repeatRaw = Number(current?.repeat ?? ctx?.config?.repeat ?? 1);
        const repeat = Number.isInteger(repeatRaw) && repeatRaw >= 1 ? repeatRaw : 1;

        // 这里把配置真的用上：prefix 拼在前面，repeat 控制重复次数。
        // 返回值必须 JSON 可序列化。
        return {
          echoed: prefix + text,
          repeat,
          text: (prefix + text).repeat(repeat),
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
      },
    };
  },

  /**
   * 停用 / 重载前释放资源：关端口、清定时器、把数据落盘。
   *
   * 宿主最多等 3 秒，超时只记日志、不阻塞停用。所以这里不要做长任务。
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
   * 只有 `runtime: "in-process"` 会真正收到消息；process 运行时不会调用它。
   * 模板默认 process，所以这里保持省略 —— 不需要的能力不要写，
   * 免得读者以为 process 插件也能接管消息。
   */
  // async handleMessage({ evt, sendText, ctx }) {},
};
