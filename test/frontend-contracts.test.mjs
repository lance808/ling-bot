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

renderTest('plugin config saves one transaction and never submits the secret back', async () => {
  /*
   * 两个要点：
   *  1) 一次保存只发一个 action（不是每个字段发一次）；
   *  2) 密钥字段即使快照里有值也不回传 —— 前端拿到的 value 恒为空，
   *     用户没重新输入就不该出现在提交里（否则等于把掩码写回去）。
   */
  const { renderPlugins } = await import('../ui/src/views/plugins.mjs');
  const calls = [];
  const snap = {
    plugins: {
      items: [
        {
          id: 'dsh-bridge',
          name: 'DSH 接入',
          version: '1.0.0',
          description: '双向通道',
          apiVersion: '1',
          runtime: 'in-process',
          enabled: true,
          status: 'ready',
          statusText: '运行中',
          error: null,
          tools: [],
          config: [
            { key: 'port', label: '端口', type: 'number', value: 3458, min: 1, max: 65535, integer: true },
            {
              key: 'token',
              label: '令牌',
              type: 'password',
              secret: true,
              required: true,
              value: '',
              hasSecret: true,
            },
          ],
          log: [],
        },
      ],
      stats: { total: 1, ready: 1, error: 0, disabled: 0 },
      dirs: { plugins: 'D:/plugins' },
      allowDangerous: false,
    },
  };
  const root = renderPlugins(snap, {
    onSaveConfig: async (...args) => {
      calls.push(args);
      return { ok: true, message: 'ok' };
    },
    rerender() {},
  });
  await button(root, '保存配置').listeners.click();
  assert.equal(calls.length, 1, '一次保存只发一个请求');
  assert.equal(calls[0][0], 'dsh-bridge');
  // 密钥没被重新输入 → 不该进 secrets
  assert.equal('token' in (calls[0][2] ?? {}), false, '没重新输入就不该提交密钥');
  // 普通配置照常提交
  assert.equal(calls[0][1].port, '3458');
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
  const now = Date.now();
  return {
    thinking: {
      total: 3,
      hasMore: false,
      nextBefore: null,
      dayKeys: ['2026-10-19'],
      conversations: [
        // 三个会话分别落在「今日 / 7 天内 / 30 天内」三个时间桶里
        { convKey: 'private:200', entries: 1, steps: 1, lastAt: now - 60_000 },
        { convKey: 'group:100', entries: 1, steps: 2, lastAt: now - 3 * 86_400_000 },
        { convKey: 'group:101', entries: 1, steps: 1, lastAt: now - 10 * 86_400_000 },
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

renderTest('思考链路：左栏按今日 / 7 天内 / 30 天内分组，右栏按选中会话过滤', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');

  // 选中群 100：右栏只应出现它的两步，别的会话内容必须消失
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: 'group:100' } });
  const body = text(byClass(root, 'think-col-main')[0]);
  assert.match(body, /群一百的第一步/);
  assert.match(body, /群一百的第二步/);
  assert.doesNotMatch(body, /私聊里的想法/);
  assert.doesNotMatch(body, /群一零一的想法/);

  // 左栏按最近活跃时间分组：三个会话各落一个桶
  const side = text(byClass(root, 'think-col-left')[0]);
  assert.match(side, /今日/);
  assert.match(side, /7 天内/);
  assert.match(side, /30 天内/);
  assert.match(side, /全部会话/);
  assert.match(side, /群 100/);
  assert.match(side, /群 101/);
  assert.match(side, /私聊 200/);
  // 时间分组之后群聊/私聊混排，靠类型徽章区分
  assert.match(side, /群聊/);
  assert.match(side, /私聊/);
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

/* ------------------------------------------- 管理员卡片（授权来源） */

renderTest('★ 安全页把管理员与白名单分开显示（白名单不等于管理员）', async () => {
  const { renderSecurity } = await import('../ui/src/views/security.mjs');
  const root = renderSecurity(
    {
      registry: { tools: [] },
      config: { allow: { groups: [], private: ['100000002'] }, deny: { groups: [], private: [] } },
      admin: {
        qqIds: ['100000001'],
        inheritWhitelist: false,
        deliverable: ['100000001', '100000004'],
        whitelistCount: 1,
      },
    },
    {},
  );
  const body = text(root);
  assert.match(body, /管理员（L2 授权）/, '要有独立的管理员卡片');
  assert.match(body, /白名单不等于管理员/, '要写明两者不同');
  // 核心管理员出现在卡片里
  assert.match(body, /100000001/);
  // 投递名单单独列，且点明不代表能批宿主机操作
  assert.match(body, /投递豁免/, '要把投递名单单独说清楚');
  assert.match(body, /不代表他们能批准宿主机操作/, '不能让用户误以为 DSH 管理员也有本机权限');
});

renderTest('★ 安全页：没有管理员时要警告当前谁都没有权限', async () => {
  const { renderSecurity } = await import('../ui/src/views/security.mjs');
  const root = renderSecurity(
    {
      registry: { tools: [] },
      config: { allow: { groups: [], private: [] }, deny: { groups: [], private: [] } },
      admin: { qqIds: [], inheritWhitelist: false, deliverable: [], whitelistCount: 0 },
    },
    {},
  );
  assert.match(text(root), /还没有管理员/, '空名单必须明确警告');
});

renderTest('★ 安全页：老后端没有 admin 块时不能崩（升级兼容）', async () => {
  const { renderSecurity } = await import('../ui/src/views/security.mjs');
  const root = renderSecurity(
    {
      registry: { tools: [] },
      config: { allow: { groups: [], private: [] }, deny: { groups: [], private: [] } },
    },
    {},
  );
  // 降级成"没有管理员"，而不是抛错或显示 undefined
  assert.match(text(root), /管理员（L2 授权）/);
  assert.doesNotMatch(text(root), /undefined/);
});

renderTest('★ 安全页：加管理员走 admin.qqIds 这个 key', async () => {
  const { renderSecurity } = await import('../ui/src/views/security.mjs');
  /** @type {any[]} */
  const calls = [];
  const root = renderSecurity(
    {
      registry: { tools: [] },
      config: { allow: { groups: [], private: [] }, deny: { groups: [], private: [] } },
      admin: { qqIds: [], inheritWhitelist: false, deliverable: [], whitelistCount: 0 },
    },
    {
      onSaveSetting: async (key, value) => {
        calls.push([key, value]);
        return { ok: true };
      },
      rerender: () => {},
    },
  );
  /*
   * 页面上有多个「添加」按钮（白名单群/私聊、黑名单群/私聊、管理员）。
   * 管理员卡片在最后，所以取**最后一个** —— 按下标取而不是按文案找，
   * 否则会点到白名单那个，测试就变成在验证另一件事了。
   */
  const adders = nodes(root).filter((n) => n.tagName === 'BUTTON' && n.textContent === '添加');
  assert.ok(adders.length >= 5, `期望至少 5 个添加按钮，实际 ${adders.length}`);
  const adminAdd = adders[adders.length - 1];

  const inputs = nodes(root).filter((n) => n.tagName === 'INPUT' && n.type === 'text');
  const adminInput = inputs[inputs.length - 1];
  assert.ok(adminInput, '要有管理员输入框');
  adminInput.value = '100000005';

  await adminAdd.listeners.click();
  // submit 是 async 的，点击回调不是 —— 让出一次事件循环等它跑完
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(calls[0], ['admin.qqIds', ['100000005']], '必须写到 admin.qqIds，不能写进 allow');
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

/* ------------------------------------------------ 对话式：气泡 / 折叠 / 排序 */

renderTest('思考链路：右栏是对话流，一个回合一个气泡', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: '' } });
  assert.equal(byClass(root, 'think-msg').length, 3, '三个回合 = 三条消息');
  assert.equal(byClass(root, 'think-bubble').length, 3, '每条消息一个气泡');
  assert.equal(byClass(root, 'think-avatar').length, 3, '每条消息一个头像');
  assert.match(text(root), /Ling/);
});

renderTest('思考链路：每句思考默认展开，点标题可以收成一行摘要', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');

  // 默认展开：没有回答的那几步也必须直接看得见思考正文
  const opened = renderThinkingPanel(thinkingSnap(), { ui: { convKey: 'group:100' } });
  const heads = byClass(opened, 'think-thought-head');
  assert.equal(heads.length, 2);
  assert.equal(heads[0]['aria-expanded'], 'true');
  const bodies = byClass(opened, 'think-thought-body');
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].hidden, '', '默认态正文必须可见');
  assert.match(text(opened), /群一百的第一步/);

  // 用户主动收起：aria-expanded=false、正文 hidden、摘要顶上
  const picked = [];
  const foldKey = '2000#group:100#1';
  const folded = renderThinkingPanel(thinkingSnap(), {
    ui: { convKey: 'group:100', folded: new Set([foldKey]) },
    onToggleStep: (key) => picked.push(key),
  });
  const foldedHeads = byClass(folded, 'think-thought-head');
  assert.equal(foldedHeads[0]['aria-expanded'], 'false');
  assert.equal(byClass(folded, 'think-thought-body')[0].hidden, '', '收起态正文必须 hidden');
  await foldedHeads[0].listeners.click();
  assert.deepEqual(picked, [foldKey]);
});

renderTest('思考链路：正序/倒序切换按回合翻转，步骤内部保持原顺序', async () => {
  const { renderThinkingPanel } = await import('../ui/src/views/thinking.mjs');

  const asc = renderThinkingPanel(thinkingSnap(), { ui: { convKey: '', order: 'asc' } });
  const ascText = text(byClass(asc, 'think-col-main')[0]);
  assert.ok(ascText.indexOf('群一零一的想法') < ascText.indexOf('私聊里的想法'), '正序：旧的在上面');

  const desc = renderThinkingPanel(thinkingSnap(), { ui: { convKey: '', order: 'desc' } });
  const descText = text(byClass(desc, 'think-col-main')[0]);
  assert.ok(descText.indexOf('私聊里的想法') < descText.indexOf('群一零一的想法'), '倒序：新的在上面');
  // 一步推理里的先后顺序是内容本身，不能跟着翻转
  assert.ok(
    descText.indexOf('群一百的第一步') < descText.indexOf('群一百的第二步'),
    '步骤内部必须保持正序',
  );

  const picked = [];
  const root = renderThinkingPanel(thinkingSnap(), { ui: { convKey: '' }, onOrder: (o) => picked.push(o) });
  assert.equal(button(root, '正序')['aria-pressed'], 'true');
  await button(root, '倒序').listeners.click();
  await button(root, '正序').listeners.click();
  assert.deepEqual(picked, ['desc', 'asc']);
});
