/**
 * preload —— F1 / F13 边界第 4 条
 *
 * 只暴露**窄接口**：
 *   window.ling.invoke(method, payload)  —— 白名单 method（snapshot / action / setting）
 *   window.ling.onEvent(fn)              —— 订阅后端推送
 *
 * 关键：**不按功能加通道**。加「发语音」页面时不需要改这个文件（I11）。
 *
 * 为什么是 .cjs 而不是 .mjs：
 *   sandbox: true 的 preload 由 Electron 以 CommonJS 方式加载，
 *   写 ESM 会直接报 "Cannot use import statement outside a module"，
 *   表现为 window.ling 不存在、界面永远拿不到数据（踩过一次，记在这里）。
 *   注意本文件里**不能**出现 `require('node:fs')` 之类的宿主模块——
 *   沙箱 preload 只允许 electron 与极少数内置模块。
 */

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_METHODS = new Set(['snapshot', 'action', 'setting']);

contextBridge.exposeInMainWorld('ling', {
  /**
   * @param {string} method
   * @param {any} payload
   * @returns {Promise<any>}
   */
  invoke(method, payload) {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`未允许的 IPC method：${method}`));
    }
    return ipcRenderer.invoke('ling:invoke', method, payload);
  },

  /** @param {(msg: {event: string, payload: any}) => void} fn */
  onEvent(fn) {
    const listener = (_evt, msg) => fn(msg);
    ipcRenderer.on('ling:event', listener);
    return () => ipcRenderer.removeListener('ling:event', listener);
  },

  /**
   * 弹系统文件选择器，只返回路径。
   *
   * ## 为什么这不是「按功能加通道」
   *
   * I11 那条纪律针对的是 **QQ 能力**：加一个"发语音"不该新增 IPC 通道，
   * 因为它属于 action 的范畴，后端才是权威。
   *
   * 选文件不是 QQ 能力——它不碰 QQ、不碰配置，只是拿到一条本机路径。
   * 渲染进程被 CSP 关掉了 file:// 且不该有文件系统权限，
   * 所以这件事只能由主进程用原生对话框做。
   *
   * 它返回的是路径字符串，界面再把这个路径交给 `action('send-media')`。
   * 也就是说：**能不能发仍然由后端判定**，这个通道不参与授权。
   *
   * @param {{kind?: 'image'|'video'|'record'|'file'}} [opts]
   * @returns {Promise<{ok: boolean, path?: string, canceled?: boolean}>}
   */
  pickFile(opts) {
    return ipcRenderer.invoke('ling:pick-file', opts ?? {});
  },

  /**
   * 图标：上传 / 重置 / 查询。
   *
   * ## 为什么这也不是「按功能加通道」
   *
   * I11 针对的是 **QQ 能力**。图标是应用自身的外观设置：
   * 它不碰 QQ、不碰后端配置，只是把一张图缩放到 userData 下。
   * 而且只有主进程有 nativeImage，后端进程根本做不到这件事。
   *
   * 传的是**路径**，不是文件内容 —— 界面先用 pickIconFile 拿到路径，
   * 再把路径交给 uploadIcon。这样渲染进程始终不需要文件系统权限。
   */
  uploadIcon(payload) {
    return ipcRenderer.invoke('ling:icon-upload', payload ?? {});
  },

  resetIcon(payload) {
    return ipcRenderer.invoke('ling:icon-reset', payload ?? {});
  },

  iconStatus() {
    return ipcRenderer.invoke('ling:icon-status');
  },

  /**
   * 选一张图标图片（只返回路径，不做缩放）。
   *
   * 和 pickFile 分开是为了把类型先卡死在图片上 —— 用户不该在选图标时
   * 看到一个"所有文件"的选项。
   */
  pickIconFile() {
    return ipcRenderer.invoke('ling:pick-file', { kind: 'image', title: '选择图标图片' });
  },

  /**
   * 把当前图标重新编进启动器 exe。
   *
   * 为什么需要它：任务栏和快捷方式图标读的是 exe 里嵌的资源，
   * 不是 Electron 窗口的 icon。换完自定义图标后必须重编 exe 才看得到。
   */
  rebuildExeIcon() {
    return ipcRenderer.invoke('ling:icon-rebuild-exe');
  },

  /** 只读的运行环境信息（给界面显示，不含凭据） */
  meta: {
    platform: process.platform,
    versions: {
      node: process.versions.node,
      chrome: process.versions.chrome,
      electron: process.versions.electron,
    },
  },
});
