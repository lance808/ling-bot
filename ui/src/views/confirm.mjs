/**
 * 确认弹框 —— F14
 *
 * R2/R3 工具执行前必须有人点头。这个组件是那个"人"的入口。
 *
 * 三条 UI 纪律：
 *   1. **默认拒绝**：不点"允许"就不算允许；60 秒后自动关掉并拒绝
 *   2. **不用"始终允许"**：一次确认只对一次调用有效，避免养成盲点
 *   3. **参数可见**：要让人看到它到底想干什么，而不是只显示工具名
 */

import { el } from '../render.mjs';

/**
 * 渲染待确认列表。
 *
 * @param {Array<{id: string, tool: string, risk: string, convKey: string, args: object, timeoutMs: number}>} pending
 * @param {{onResolve: (id: string, allow: boolean) => Promise<any>}} ctx
 * @returns {HTMLElement}
 */
export function renderConfirmBar(pending, ctx) {
  if (!pending || pending.length === 0) {
    return el('div', { class: 'confirm-bar', hidden: true });
  }

  return el(
    'div',
    { class: 'confirm-bar' },
    pending.map((p) => {
      const deadline = el('span', { class: 'muted mono', text: '' });
      const started = Date.now();

      // 倒计时：让人知道"不点就会自动拒绝"
      const timer = setInterval(() => {
        const left = Math.max(0, Math.ceil(((p.timeoutMs ?? 60_000) - (Date.now() - started)) / 1000));
        deadline.textContent = left > 0 ? `${left}s 后自动拒绝` : '已过期';
        if (left <= 0) clearInterval(timer);
      }, 1000);
      deadline.textContent = `${Math.round((p.timeoutMs ?? 60_000) / 1000)}s 后自动拒绝`;

      return el('div', { class: 'confirm-card' }, [
        el('div', { class: 'confirm-head' }, [
          el('strong', { text: '需要你确认' }),
          el('span', { class: 'pill pill-warn', text: `${p.tool} · ${p.risk}` }),
        ]),
        el('div', { class: 'muted', text: `目标会话：${p.convKey}` }),
        el('pre', { class: 'confirm-args', text: JSON.stringify(p.args ?? {}, null, 2) }),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: '允许这一次',
            onclick: async () => {
              clearInterval(timer);
              await ctx.onResolve(p.id, true);
            },
          }),
          el('button', {
            class: 'btn',
            type: 'button',
            text: '拒绝',
            onclick: async () => {
              clearInterval(timer);
              await ctx.onResolve(p.id, false);
            },
          }),
          deadline,
        ]),
      ]);
    }),
  );
}
