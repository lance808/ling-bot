/**
 * 日志页 —— F10
 *
 * 首版只做「尾部实时 + 本窗口搜索」。全量检索是刻意不做的（F10 边界）。
 */

import { el, card } from '../render.mjs';

/**
 * @param {any} snap
 * @param {{lines: string[], onClear: ()=>void}} ctx
 * @returns {HTMLElement}
 */
export function renderLogs(snap, ctx) {
  const lines = ctx.lines ?? [];
  const tail = el('div', { class: 'log-tail', text: lines.join('\n') || '（暂无日志）' });

  const search = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      placeholder: '在已载入的日志里搜索…',
      oninput: (e) => {
        const q = /** @type {HTMLInputElement} */ (e.target).value.trim();
        const filtered = q ? lines.filter((l) => l.includes(q)) : lines;
        tail.textContent = filtered.join('\n') || '（无匹配）';
        tail.scrollTop = tail.scrollHeight;
      },
    })
  );

  queueMicrotask(() => {
    tail.scrollTop = tail.scrollHeight;
  });

  return el('div', {}, [
    card('日志尾部', [
      el('div', { class: 'row' }, [
        search,
        el('button', { class: 'btn', type: 'button', text: '清空', onclick: ctx.onClear }),
      ]),
      tail,
      el('div', { class: 'muted', text: `已载入 ${lines.length} 行（轮转：单文件 10MB × 保留 5 份）` }),
    ]),
    card('诊断', [
      el('div', { class: 'list' }, [
        el('div', { class: 'kv' }, [
          el('span', { class: 'k', text: '后端状态' }),
          el('span', { class: 'v', text: snap?.state ?? 'unknown' }),
        ]),
        el('div', { class: 'kv' }, [
          el('span', { class: 'k', text: '最近错误' }),
          el('span', { class: 'v', text: snap?.lastError ? `${snap.lastError.code}: ${snap.lastError.message}` : '无' }),
        ]),
      ]),
    ]),
  ]);
}

