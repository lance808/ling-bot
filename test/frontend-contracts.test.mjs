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

/**
 * 装一份最小 DOM 桩，**返回还原函数**。
 *
 * 为什么不用 `test.beforeEach`：node:test 的钩子是全局注册的，在
 * `--experimental-test-isolation=none`（所有文件共用一个 realm）下会连带
 * 覆盖别的测试文件的 document 桩 —— model-page 那套断言就全挂了。
 * 也不能就地装完不还：本文件先于别的文件执行时，留在全局的桩同样会串台。
 * 所以只包住自己要渲染的那一条，出来就还回去。
 *
 * @returns {() => void}
 */
function installDom() {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => ({ textContent: text }) };
  return () => { globalThis.document = previous; };
}

/**
 * 注册一条"要渲染界面"的测试：自动装 DOM 桩并在结束时还原。
 *
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
function renderTest(name, fn) {
  test(name, async () => {
    const restore = installDom();
    try {
      await fn();
    } finally {
      restore();
    }
  });
}

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

test('快照查询：选中的会话必须落到 convKey 上，否则右栏会漏掉旧记录', () => {
  /*
   * 这不是形式主义：`limit` 截的是"最近 N 条"。用户点开一个只有旧记录的
   * 会话时，如果不把 convKey 传下去，后端返回的仍是"最近 50 条全局"，
   * 那个会话的记录根本不在里面 → 右栏说"暂无记录"，左栏写着"5 回合"。
   */
  assert.equal(snapshotQuery({ convKey: 'group:111', days: 7 }).thinking.convKey, 'group:111');
  // 「全部会话」用 null，不是空串：空串在 JSON 里也是个值，会被后端当成一次收窄
  assert.equal(snapshotQuery({ convKey: null, days: 7 }).thinking.convKey, null);
  assert.equal(snapshotQuery().thinking.convKey, null);
});

test('cache denominator covers only calls with reported details', () => {
  const agg = usageAggregate({ calls: 2, promptTokens: 200, totalTokens: 240, cachedTokens: 50, cachePromptTokens: 100, cacheReported: 1 });
  assert.equal(agg.hitRate, 50);
  assert.equal(agg.missTokens, 50);
  assert.equal(usageAggregate({ cachePromptTokens: 0, cacheReported: 0 }).hitRate, null);
});

renderTest('usage page uses journal aggregate rather than the bounded recent detail', async () => {
  const { renderUsage } = await import('../ui/src/views/usage.mjs');
  const now = Date.now();
  const root = renderUsage({ usage: { recent: [{ at: now, totalTokens: 3 }], range: { ...usageQuery('24h', now), calls: 123, totalTokens: 99999, promptTokens: 90000, completionTokens: 9999, covered: true } } });
  assert.match(text(root), /123 次调用/);
  assert.match(text(root), /99,999/);
});

renderTest('DSH saves one transaction and never submits the snapshot mask', async () => {
  const { renderDsh } = await import('../ui/src/views/dsh.mjs');
  const calls = [];
  const root = renderDsh({ config: { dsh: { token: 'masked-value', enabled: false, admins: [], port: 3458 } } }, { onSaveSetting: async (...args) => { calls.push(args); return { ok: true }; } });
  await button(root, '保存').listeners.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'dsh.config');
  assert.equal(calls[0][1].token, '');
});

renderTest('failed sends retain draft across snapshot rerenders', async () => {
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

renderTest('thinking history forwards the opaque cursor and distinguishes steps from turns', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const cursors = [];
  const root = renderThinkingPanel({ thinking: { days: [], total: 12, hasMore: true, nextBefore: 'opaque-page' } }, { ui: {}, onOlder: (cursor) => cursors.push(cursor) });
  await button(root, '更早记录').listeners.click();
  assert.deepEqual(cursors, ['opaque-page']);
  assert.ok(nodes(root).some((node) => String(node.title).includes('12 个回合')));
});

/* ------------------------------------------------ 思考链路：左会话 / 右内容 */

/** 一份"两个群 + 一个私聊各有记录"的快照 */
function thinkingSnap() {
  return {
    thinking: {
      total: 3,
      hasMore: false,
      nextBefore: null,
      dayKeys: ['2026-10-19'],
      conversations: [
        { convKey: 'private:200', entries: 1, steps: 1, lastAt: 3000 },
        { convKey: 'group:100', entries: 1, steps: 2, lastAt: 2000 },
        { convKey: 'group:101', entries: 1, steps: 1, lastAt: 1000 },
      ],
      days: [
        {
          date: '2026-10-19',
          entries: [
            { at: 1000, convKey: 'group:101', steps: [{ n: 1, reasoning: '群一零一的想法' }] },
            {
              at: 2000,
              convKey: 'group:100',
              steps: [
                { n: 1, reasoning: '群一百的第一步', tools: ['web_search'] },
                { n: 2, reasoning: '群一百的第二步' },
              ],
            },
            { at: 3000, convKey: 'private:200', steps: [{ n: 1, reasoning: '私聊里的想法' }] },
          ],
        },
      ],
    },
  };
}

const byClass = (root, cls) => nodes(root).filter((n) => String(n.className ?? '').split(/\s+/).includes(cls));

renderTest('思考链路：左栏列出群聊与私聊，右栏按选中会话过滤', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');

  // 选中群 100：右栏只应出现它的两步，别的会话内容必须消失
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: 'group:100' } });
  const body = text(byClass(root, 'think-col-main')[0]);
  assert.match(body, /群一百的第一步/);
  assert.match(body, /群一百的第二步/);
  assert.doesNotMatch(body, /私聊里的想法/);
  assert.doesNotMatch(body, /群一零一的想法/);

  // 左栏要分组：群聊 / 私聊各一个组头，且两个群 + 一个私聊都在
  const side = text(byClass(root, 'think-col-left')[0]);
  assert.match(side, /群聊 2/);
  assert.match(side, /私聊 1/);
  assert.match(side, /全部会话/);
  assert.match(side, /群 100/);
  assert.match(side, /群 101/);
  assert.match(side, /私聊 200/);
});

renderTest('思考链路：点左栏会话会带着 convKey 回调（空串=全部）', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const picked = [];
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: 'group:100' }, onSelectConv: (k) => picked.push(k) });

  const item = (key) => nodes(root).find((n) => n.dataset?.thinkConv === key);
  // 「全部会话」那一项的 convKey 是空串 —— 必须能点，否则用户回不去全部
  await item('').listeners.click();
  await item('private:200').listeners.click();
  await item('group:101').listeners.click();
  assert.deepEqual(picked, ['', 'private:200', 'group:101']);
});

renderTest('思考链路：选中态用 aria-current，而不是只有一个 class', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: 'private:200' } });
  const on = nodes(root).filter((n) => n.dataset?.thinkConv !== undefined && n['aria-current'] === 'true');
  assert.equal(on.length, 1, '有且只有一个当前项');
  assert.equal(on[0].dataset.thinkConv, 'private:200');
});

renderTest('思考链路：全部会话时三条记录都在，且标题不是某个会话名', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: '' } });
  const body = text(byClass(root, 'think-col-main')[0]);
  assert.match(body, /群一百的第一步/);
  assert.match(body, /私聊里的想法/);
  assert.match(body, /群一零一的想法/);
});

renderTest('思考链路：删除某一天是两段式，先确认再回调 onDeleteDay', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const asked = [];
  const deleted = [];

  // 第一段：点「删除」只进入待确认，不许直接删
  const root = renderThinkingPanel(thinkingSnap(), {
    ui: { convKey: '' },
    onAskDelete: (d) => asked.push(d),
    onDeleteDay: (d) => deleted.push(d),
  });
  await button(root, '删除').listeners.click();
  assert.deepEqual(asked, ['2026-10-19']);
  assert.deepEqual(deleted, [], '第一次点击绝不能真删');

  // 第二段：确认态下才出现「确认删除」，点它才回调
  const confirming = renderThinkingPanel(thinkingSnap(), {
    ui: { convKey: '', pendingDelete: '2026-10-19' },
    onAskDelete: (d) => asked.push(d),
    onDeleteDay: (d) => deleted.push(d),
  });
  assert.match(text(confirming), /不能撤销/, '要明确告诉用户不可撤销');
  await button(confirming, '确认删除').listeners.click();
  assert.deepEqual(deleted, ['2026-10-19']);

  // 「取消」把待确认清掉，不删
  await button(confirming, '取消').listeners.click();
  assert.equal(asked.at(-1), null);
  assert.deepEqual(deleted, ['2026-10-19']);
});

renderTest('思考链路：删除按钮和折叠按钮是并列的两个按钮，不能嵌套', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: '' } });
  const del = nodes(root).find((n) => String(n.className ?? '').includes('think-day-del'));
  const toggle = nodes(root).find((n) => String(n.className ?? '').includes('think-day-toggle'));
  assert.ok(del && toggle);
  // 嵌套 button 会被浏览器吞掉内层，删除按钮就从界面上消失了
  const insideToggle = nodes(toggle).includes(del);
  assert.equal(insideToggle, false, '删除按钮不能在折叠按钮里面');
});

renderTest('思考链路：后端没上报 thinking 时降级成空态而不是抛错', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  for (const snap of [{}, { thinking: null }, null]) {
    const root = renderThinkingPanel(snap, { ui: {} });
    assert.match(text(root), /暂无思考记录/);
    assert.match(text(root), /还没有会话有思考记录/);
  }
});

renderTest('思考链路：只有 hasMore 没有游标时不认为可翻页（避免点了没反应）', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const root = renderThinkingPanel({ thinking: { days: [], total: 5, hasMore: true, nextBefore: null } }, { ui: {} });
  const older = button(root, '更早记录');
  // el() 用 setAttribute 表达 disabled，所以真实值是 ''（属性存在）而不是 true
  assert.ok(older.disabled !== undefined && older.disabled !== false, '按钮必须处于禁用态');
  assert.equal(older.title, '没有更早的记录了');
});

renderTest('editing a persona is distinct from setting its global default', async () => {
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

/* ------------------------------------------- 「刚才那条怎么没出现」要能自己解释 */

/** 有历史记录、并且后端报告"最近一回合没有思考内容"的时刻 */
function snapWithSkip(skipAt) {
  const now = Date.now();
  const yesterday = now - 86_400_000;
  return {
    thinking: {
      total: 1,
      hasMore: false,
      nextBefore: null,
      days: [
        {
          date: '2026-10-20',
          entries: [{ at: yesterday, convKey: 'group:1', steps: [{ n: 1, reasoning: '昨天的想法' }] }],
        },
      ],
      conversations: [{ convKey: 'group:1', entries: 1, steps: 1, lastAt: yesterday }],
      dayKeys: ['2026-10-20'],
      lastSkip: skipAt == null ? null : { convKey: 'group:1', at: skipAt },
    },
  };
}

renderTest('思考链路：最新一回合没有 reasoning 时要自己说明原因', async () => {
  /*
   * 真实踩过的坑：换了模型之后上游不再返回 reasoning，于是这一页永远不更新，
   * 而页面上还挂着昨天那条记录 —— 看起来完全正常，日志里也一个字都没有。
   * 所以这条提示不是装饰，它是用户唯一能分辨"模型不对"和"程序坏了"的地方。
   */
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const root = renderThinkingPanel(snapWithSkip(Date.now()), { ui: { days: 7 } });
  assert.match(text(root), /没有产生思考内容/);
  assert.match(text(root), /reasoning/, '要指明是 reasoning 缺失，而不是笼统说失败');
  // 历史记录不能被这条提示顶掉
  assert.match(text(root), /昨天的想法/);
});

renderTest('思考链路：之后又有正常记录了，那条提示就不能再显示', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  // 标记时间比最新记录更早 → 说明它已经过期
  const root = renderThinkingPanel(snapWithSkip(1), { ui: { days: 7 } });
  assert.doesNotMatch(text(root), /没有产生思考内容/);
});

renderTest('思考链路：后端没上报 lastSkip 时不显示提示（老后端兼容）', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const root = renderThinkingPanel(snapWithSkip(null), { ui: { days: 7 } });
  assert.doesNotMatch(text(root), /没有产生思考内容/);
});

renderTest('思考链路：lastSkip 字段脏掉也不能把面板弄崩', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  for (const bad of ['junk', 42, { at: 'not-a-number' }, { at: -1 }, [], { at: null }]) {
    const snap = snapWithSkip(null);
    snap.thinking.lastSkip = bad;
    const root = renderThinkingPanel(snap, { ui: { days: 7 } });
    assert.match(text(root), /昨天的想法/, `lastSkip=${JSON.stringify(bad)} 时历史仍要正常显示`);
  }
});
