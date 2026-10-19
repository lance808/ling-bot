/**
 * 测试用假 preload —— 只为 scripts/ui-rebuild.mjs 服务。
 *
 * 为什么需要它：直接 loadFile 打开页面时没有 preload，window.ling 不存在，
 * snapshot() 每次抛错、pull() 在 catch 里静默失败，于是**根本没有重绘**。
 * 那样任何"输入没丢"的测试都会假通过。
 *
 * 必须在页面脚本执行前就把 window.ling 放好，所以只能是 preload，
 * 不能在 loadFile 之后注入（app.mjs 在模块加载时就已经取走 globalThis.ling）。
 */

const { contextBridge } = require('electron');

let n = 0;

contextBridge.exposeInMainWorld('ling', {
  invoke(method) {
    if (method === 'snapshot') {
      n += 1;
      return Promise.resolve({
        state: 'offline',
        health: { linked: false, verdict: 'unknown', online: null },
        account: { selfId: null },
        messages: [],
        counts: { messages: 0, toolCalls: 0 },
        registry: { actions: [], tools: [], pages: [], timers: [] },
        plugins: { loaded: [], skipped: [], enabled: [] },
        persona: '',
        personaCards: { cards: [], activeId: '' },
        config: {
          llm: { provider: 'custom', baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4.1-flash', timeoutMs: 120000, apiKey: '', keySource: 'vault' },
          allow: { groups: [], private: [] },
          dsh: { enabled: false, port: 3458, token: '', admins: [], sessionId: '' },
          plugins: { enabled: [], allowDangerous: false },
        },
        brain: { configured: true, model: 'deepseek-v4.1-flash', keySource: 'vault', inflight: 0, queued: 0, pendingConfirms: [], conversations: [] },
        usage: { today: {}, todayProactive: {}, proactiveRatio: 0, recent: [] },
        // 每次都是不同的值，确保 store 真的变化
        tick: n,
      });
    }
    if (method === 'action') {
      // 延迟返回，模拟真实请求耗时 —— 否则观察不到"请求中"这个中间态
      return new Promise((resolve) =>
        setTimeout(() => resolve({ ok: true, reply: '通了', ms: 1234, model: 'deepseek-v4.1-flash' }), 2500),
      );
    }
    if (method === 'setting') return Promise.resolve({ ok: true });
    return Promise.resolve({});
  },
  onEvent() {
    return () => {};
  },
  pickFile() {
    return Promise.resolve({ ok: false, canceled: true });
  },
  meta: { platform: 'test', versions: { electron: 'test', node: 'test' } },
});
