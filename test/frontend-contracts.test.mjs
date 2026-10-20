import test from 'node:test';
import assert from 'node:assert/strict';
import { resultOf, snapshotQuery, usageQuery, usageAggregate } from '../ui/src/contracts.mjs';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
}
globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => ({ textContent: text }) };
const nodes = (root) => [root, ...(root.children ?? []).flatMap(nodes)];
const button = (root, label) => nodes(root).find((n) => n.tagName === 'BUTTON' && n.textContent === label);
const text = (root) => nodes(root).map((n) => n.textContent ?? '').join('\n');

test('IPC failures and malformed success become explicit failure values', async () => {
  assert.deepEqual(await resultOf(() => Promise.reject(new Error('offline'))), { ok: false, code: undefined, message: 'offline' });
  assert.equal((await resultOf(() => undefined)).ok, false);
  assert.deepEqual(await resultOf(() => ({ ok: true, message: 'accepted' })), { ok: true, message: 'accepted' });
});

test('query includes conversation filtering and opaque pagination before truncation', () => {
  assert.deepEqual(snapshotQuery({ convKey: 'group:fixture', days: 7, before: 'opaque' }), { thinking: { convKey: 'group:fixture', days: 7, before: 'opaque', limit: 50 } });
  assert.equal(usageQuery('30d', 40 * 86400000).since, 10 * 86400000);
});

test('cache denominator covers only calls with reported details', () => {
  const agg = usageAggregate({ calls: 2, promptTokens: 200, totalTokens: 240, cachedTokens: 50, cachePromptTokens: 100, cacheReported: 1 });
  assert.equal(agg.hitRate, 50);
  assert.equal(agg.missTokens, 50);
  assert.equal(usageAggregate({ cachePromptTokens: 0, cacheReported: 0 }).hitRate, null);
});

test('usage page uses journal aggregate rather than the bounded recent detail', async () => {
  const { renderUsage } = await import('../ui/src/views/usage.mjs');
  const now = Date.now();
  const root = renderUsage({ usage: { recent: [{ at: now, totalTokens: 3 }], range: { ...usageQuery('24h', now), calls: 123, totalTokens: 99999, promptTokens: 90000, completionTokens: 9999, covered: true } } });
  assert.match(text(root), /123 次调用/);
  assert.match(text(root), /99,999/);
});

test('DSH saves one transaction and never submits the snapshot mask', async () => {
  const { renderDsh } = await import('../ui/src/views/dsh.mjs');
  const calls = [];
  const root = renderDsh({ config: { dsh: { token: 'masked-value', enabled: false, admins: [], port: 3458 } } }, { onSaveSetting: async (...args) => { calls.push(args); return { ok: true }; } });
  await button(root, '保存').listeners.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'dsh.config');
  assert.equal(calls[0][1].token, '');
});

test('failed sends retain draft across snapshot rerenders', async () => {
  const { renderSessions } = await import('../ui/src/views/sessions.mjs');
  const snap = { messages: [{ convKey: 'group:fixture', text: 'fixture', time: 1 }] };
  const ctx = { selectedConv: 'group:fixture', onSelect() {}, onSend: async () => ({ ok: false, message: 'blocked' }) };
  const root = renderSessions(snap, ctx);
  const area = nodes(root).find((n) => n.tagName === 'TEXTAREA');
  area.value = 'unsent draft'; area.listeners.input();
  await button(root, '发送文本').listeners.click();
  const next = renderSessions(snap, ctx);
  assert.equal(nodes(next).find((n) => n.tagName === 'TEXTAREA').value, 'unsent draft');
  assert.match(text(next), /blocked/);
});

test('thinking history forwards the opaque cursor and distinguishes steps from turns', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const cursors = [];
  const root = renderThinkingPanel({ thinking: { days: [], total: 12, hasMore: true, nextBefore: 'opaque-page' } }, { ui: {}, onOlder: (cursor) => cursors.push(cursor) });
  await button(root, '更早记录').listeners.click();
  assert.deepEqual(cursors, ['opaque-page']);
  assert.ok(nodes(root).some((node) => String(node.title).includes('12 个回合')));
});

test('editing a persona is distinct from setting its global default', async () => {
  const { renderPersona } = await import('../ui/src/views/persona.mjs');
  const calls = [];
  const cards = [{ id: 'a', name: 'A', text: '', length: 0, scope: 'global' }, { id: 'b', name: 'B', text: '', length: 0, scope: 'global' }];
  const ctx = { cards, activeId: 'b', defaultId: 'a', draft: '', onDraft() {}, rerender() {}, onSetDefault: async (id) => { calls.push(id); return { ok: true }; } };
  const root = renderPersona({}, { persona: ctx, role: ctx, tab: 'persona', onTab() {} });
  assert.match(text(root), /编辑中/); assert.match(text(root), /全局默认/);
  assert.doesNotMatch(text(root), /使用中/);
  await button(root, '设为全局默认').listeners.click();
  assert.deepEqual(calls, ['b']);
});
