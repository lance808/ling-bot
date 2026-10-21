/**
 * 示例插件：echo —— 插件接口 v1 的最小可运行示例
 *
 * ## 分工
 *
 * 这个文件只有**行为**。所有声明都在同目录的 `plugin.json` 里：
 * 插件名、版本、配置项、工具的参数/权限/超时。
 * 宿主先读 JSON 校验，通过后才 import 这个文件——所以清单坏了
 * 也不会让插件页白屏。
 *
 * ## 起用步骤
 *
 *   1. 把整个 `echo/` 目录放到 `<userData>/plugins/echo/`
 *   2. 插件页「重新扫描」→ 出现在列表 → 填配置 → 启用
 *   3. AI 就能调用 `plugin_echo`
 *
 * ## 注意它的"不做"
 *
 * 它**没有**声明 origins，也**没有**声明 confirm —— 因为插件无权决定这两件事。
 * 宿主会按 `needs: 'qq'` 推导成「主人私聊 + 主人所在群」，
 * 按 `risk: 'R0'` 推导成「自动执行，不用确认」。
 *
 * 这就是插件通道的安全模型：插件说"我需要什么"，宿主决定"给你什么"。
 *
 * ## process 运行时
 *
 * 清单里 runtime 是默认的 `process`：宿主用独立子进程加载本文件，
 * 所以这里拿到的 ctx.config 是**序列化后**的普通对象，
 * 不能指望拿到任何宿主内部对象（也拿不到）。
 */

/** @type {{prefix: string} | null} 当前配置（init 时写入） */
let current = null;

export default {
  /**
   * 初始化。启用时调用；配置保存后会先 dispose 再 init。
   *
   * @param {any} ctx PluginContext
   */
  async init(ctx) {
    // config 已经过宿主校验并补好默认值，直接用即可。
    // 这里做一次 trim 只是为了让 prefix 末尾的空格不变成"看不见的前缀"。
    const prefix = String(ctx?.config?.prefix ?? '').trim();
    current = { prefix };
    ctx?.log?.('info', 'echo 已初始化', { prefix });
    return { ok: true };
  },

  /**
   * 执行工具。清单里声明的每个工具都在这里分发。
   *
   * @param {{tool: string, args: object, ctx: any, signal?: AbortSignal}} input
   * @returns {Promise<any>} 必须 JSON 可序列化
   */
  async callTool({ tool, args, ctx }) {
    if (String(tool) !== 'echo') {
      // 返回 {ok:false, code} 是合法的工具结果，会回灌给模型，不是宿主异常
      return { ok: false, code: 'E4041', message: `未知工具：${String(tool)}` };
    }

    const text = String(args?.text ?? '');
    // init 没跑过（比如宿主直接调工具）时退回读 ctx.config，
    // 免得因为生命周期顺序的细节让工具报一个看不懂的错。
    const prefix = current?.prefix ?? String(ctx?.config?.prefix ?? '').trim();

    return { echoed: `${prefix}${text}` };
  },

  /**
   * 测试连接 / 自检。可能在没有 init 的情况下被调用，
   * 所以**不要**依赖上面的模块级变量。
   *
   * @param {any} ctx
   */
  async testConnection(ctx) {
    const prefix = String(ctx?.config?.prefix ?? '').trim();
    return {
      ok: true,
      message: prefix ? `就绪（前缀「${prefix}」）` : '就绪（无前缀）',
      details: { prefixLength: prefix.length },
    };
  },

  /**
   * 释放资源。echo 没有任何资源要放，留个空实现演示形状。
   *
   * @param {any} ctx
   */
  async dispose(ctx) {
    current = null;
    ctx?.log?.('debug', 'echo 已释放');
  },
};
