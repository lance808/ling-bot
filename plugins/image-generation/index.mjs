import { ImageTasks } from './lib/tasks.mjs';
import { ModelProbe } from './lib/models.mjs';
import { normalizeConfig } from './lib/config.mjs';

/**
 * 插件实例工厂。
 *
 * 宿主只加载一次并复用默认导出；工厂让测试能在同一进程里创建互不共享
 * 任务库/锁/限流状态的实例，避免 `--test-isolation=none` 下不同测试
 * 互相污染。
 *
 * @param {{listModelsImpl?: Function}} [deps] 仅供测试注入只读模型目录实现
 */
export function createImagePlugin({ listModelsImpl } = {}) {
  /** @type {ImageTasks | null} */
  let tasks = null;
  /** @type {ModelProbe | null} */
  let probe = null;
  /** @type {null | (() => void)} */
  let detach = null;

  return {
    validateConfig(config) {
      try {
        normalizeConfig(config);
        return { ok: true };
      } catch {
        return { ok: false, message: '生图配置不合法：请检查 HTTP(S) 地址、尺寸、限额与模型探测范围' };
      }
    },

    async init(ctx) {
      if (typeof ctx.deliverMedia !== 'function') {
        return { ok: false, code: 'E4072', message: '宿主未提供受控后台媒体投递，请升级宿主' };
      }

      let engine;
      try {
        engine = new ImageTasks({
          dataDir: ctx.dataDir,
          config: ctx.config,
          apiKey: String(ctx.secrets?.apiKey ?? ''),
          sendText: ctx.sendText,
          deliverMedia: ctx.deliverMedia,
        });
      } catch {
        return { ok: false, code: 'E4064', message: '生图配置不合法；未调用生图接口' };
      }

      // 先挂生命周期再 init：恢复的 queued 任务可能马上开始收费请求，
      // 此时宿主停用必须能立即打断它。
      tasks = engine;
      probe = new ModelProbe({
        config: engine.cfg,
        apiKey: String(ctx.secrets?.apiKey ?? ''),
        listFn: listModelsImpl,
      });
      const stop = () => {
        void engine.dispose().catch(() => {});
      };
      ctx.signal?.addEventListener('abort', stop, { once: true });
      detach = () => ctx.signal?.removeEventListener('abort', stop);

      try {
        const starting = engine.init();
        if (ctx.signal?.aborted) stop();
        await starting;
        if (!engine.active) {
          // 初始化期间被停用：可能已经拿到目录锁，必须在这里释放，
          // 否则下一次启用会保守地拒绝启动。
          await engine.idle();
          await engine.releaseLock();
          detach?.();
          detach = null;
          tasks = null;
          probe = null;
          return { ok: false, code: 'IMAGE_STOPPED', message: '插件初始化已取消' };
        }
        return { ok: true };
      } catch {
        await engine.dispose();
        await engine.idle();
        await engine.releaseLock();
        detach?.();
        detach = null;
        tasks = null;
        probe = null;
        return {
          ok: false,
          code: 'E4064',
          message: '生图初始化失败：请检查独立 API 配置、管理员、任务库和数据目录锁；未调用生图接口',
        };
      }
    },

    async callTool({ tool, args, ctx, signal }) {
      if (!tasks || !tasks.active) {
        return { ok: false, code: 'IMAGE_STOPPED', message: '生图插件未运行' };
      }
      if (tool === 'image_probe_models') {
        if (!probe) return { ok: false, code: 'IMAGE_PROBE_NOT_CONFIGURED', message: '模型探测未初始化' };
        // 宿主已按 needs:host 把工具限制在主人私聊/桌面端；这里仍只把
        // 可信 caller 的请求者 ID 用作限流键，不接受模型传入身份。
        try {
          return await probe.run({
            requesterId: String(ctx?.caller?.requester?.id ?? 'console'),
            model: args?.model,
            signal,
          });
        } catch {
          return {
            ok: false,
            code: 'IMAGE_PROBE_FAILED',
            message: '模型目录探测失败（只读请求，未计费）',
            outcomeUnknown: false,
          };
        }
      }
      try {
        switch (tool) {
          case 'image_generate':
            return await tasks.submit(args, ctx.caller, signal);
          case 'image_task':
            return await tasks.query(args.taskId, ctx.caller, ctx.chat);
          case 'image_cancel':
            return await tasks.cancel(args.taskId, ctx.caller);
          case 'image_retry_delivery':
            return await tasks.retryDelivery(args.taskId, ctx.caller);
          default:
            return { ok: false, code: 'IMAGE_BAD_TOOL', message: '未知生图工具' };
        }
      } catch {
        return {
          ok: false,
          code: 'IMAGE_REQUEST_FAILED',
          message: '生图任务操作失败：请检查参数、可信调用上下文或任务存储；请先查询已有任务，不要盲目重新提交',
        };
      }
    },

    async handleMessage({ evt }) {
      return tasks?.active ? tasks.handleMessage(evt) : false;
    },

    /**
     * 自检仍**不发网络请求**（与联网搜索插件同一约定）：模型探测是
     * 可能产生上游调用的动作，交给显式工具 `plugin_image_probe_models`。
     * 这样用户点“测试连接”时不会意外把 Key 打到刚填的地址上。
     */
    async testConnection(ctx) {
      try {
        const c = normalizeConfig(ctx.config);
        if (!c.apiUrl || !c.model || !c.admins.length || !String(ctx.secrets?.apiKey ?? '').trim()) {
          return {
            ok: false,
            message: '请配置独立生图 API 地址、Key、模型和审核管理员；未发送网络请求',
          };
        }
        return {
          ok: true,
          message: c.probeEnabled
            ? '本地配置校验通过；此按钮不发送网络请求。使用 plugin_image_probe_models 只读探测上游模型目录，不会发起收费生图请求'
            : '本地配置校验通过；模型探测已关闭；此按钮不发送网络请求',
        };
      } catch {
        return { ok: false, message: '本地配置不合法，未发送网络请求' };
      }
    },

    async dispose() {
      detach?.();
      detach = null;
      probe = null;
      if (tasks) {
        await tasks.dispose();
        await tasks.idle();
        await tasks.releaseLock?.();
      }
      tasks = null;
    },
  };
}

export default createImagePlugin();
