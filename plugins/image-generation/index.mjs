import { ImageTasks } from './lib/tasks.mjs';
import { normalizeConfig } from './lib/config.mjs';

// 每次宿主重载入口创建独立实例；后台任务仅持有init生命周期能力。
let tasks = null;
let detach = null;
export default {
  validateConfig(config) {
    try { normalizeConfig(config); return {ok:true}; }
    catch { return {ok:false,message:'生图配置不合法：请检查HTTP(S)地址、尺寸与限额范围'}; }
  },
  async init(ctx) {
    if (typeof ctx.deliverMedia !== 'function') return {ok:false,code:'E4072',message:'宿主未提供受控后台媒体投递，请升级宿主'};
    const engine = new ImageTasks({dataDir:ctx.dataDir,config:ctx.config,apiKey:String(ctx.secrets?.apiKey ?? ''),sendText:ctx.sendText,deliverMedia:ctx.deliverMedia});
    tasks=engine;
    const stop=()=>{ void engine.dispose().catch(()=>{}); };
    ctx.signal?.addEventListener('abort',stop,{once:true}); detach=()=>ctx.signal?.removeEventListener('abort',stop);
    try {
      const starting=engine.init();
      if(ctx.signal?.aborted) stop();
      await starting;
      if(!engine.active) return {ok:false,code:'IMAGE_STOPPED',message:'插件初始化已取消'};
      return {ok:true};
    } catch {
      await engine.dispose(); await engine.idle(); await engine.releaseLock();
      detach?.();detach=null;tasks=null;
      return {ok:false,code:'E4064',message:'生图初始化失败：请检查独立API配置、管理员、任务库和数据目录锁；未调用生图接口'};
    }
  },
  async callTool({tool,args,ctx,signal}) {
    if (!tasks || !tasks.active) return {ok:false,code:'IMAGE_STOPPED',message:'生图插件未运行'};
    try {
      switch(tool) {
        case 'image_generate': return await tasks.submit(args,ctx.caller,signal);
        case 'image_task': return await tasks.query(args.taskId,ctx.caller,ctx.chat);
        case 'image_cancel': return await tasks.cancel(args.taskId,ctx.caller);
        case 'image_retry_delivery': return await tasks.retryDelivery(args.taskId,ctx.caller);
        default: return {ok:false,code:'IMAGE_BAD_TOOL',message:'未知生图工具'};
      }
    } catch { return {ok:false,code:'IMAGE_REQUEST_FAILED',message:'生图任务操作失败：请检查参数、可信调用上下文或任务存储；请先查询已有任务，不要盲目重新提交'}; }
  },
  async handleMessage({evt}) { return tasks?.active ? tasks.handleMessage(evt) : false; },
  async testConnection(ctx) {
    try {
      const c=normalizeConfig(ctx.config);
      if(!c.apiUrl || !c.model || !c.admins.length || !String(ctx.secrets?.apiKey ?? '').trim()) return {ok:false,message:'请配置独立生图API地址、Key、模型和审核管理员；未发送网络请求'};
      return {ok:true,message:'本地配置校验通过，尚未验证上游连通性；此按钮不请求收费生图接口，真实任务需管理员引用审批'};
    } catch { return {ok:false,message:'本地配置不合法，未发送网络请求'}; }
  },
  async dispose() { detach?.(); detach=null; if(tasks) { await tasks.dispose(); await tasks.idle(); await tasks.releaseLock?.(); } tasks=null; },
};
