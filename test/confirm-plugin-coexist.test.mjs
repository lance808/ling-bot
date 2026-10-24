/**
 * 宿主确认 与 dsh-bridge 审批 共存 —— 谁都不许抢对方那条回复
 *
 * ## 为什么必须单独测这一层
 *
 * 两张卡长得一模一样：都是管理员私聊里发一条消息，都写着"引用这条回数字"。
 * 用户在聊天里只看到两条卡片，代码里却是两套队列：
 *
 *   · 宿主：`guard/confirm.mjs`（高风险工具的人工确认）
 *   · 插件：`plugins/dsh-bridge`（DSH 的审批与提问）
 *
 * 修之前，宿主的入口排在插件**之前**且拿全局序号表认任何「1/2」，
 * 于是出现这类序列：
 *
 *   1. DSH 推来一张审批卡（编号 3）
 *   2. 宿主也有一张确认卡（第 1 条）
 *   3. 用户**引用 DSH 那张**回「1」
 *   4. 宿主先跑：不认识这个 message_id，但它不管引用，
 *      按"当前只有一条"把**自己的**确认批了
 *   5. DSH 那张永远等不到回答 → 超时 → 用户以为审批坏了
 *
 * 所以这里用真实的 DshBridge 排队 + 真实的 ConfirmRegistry，
 * 复现「两条卡片同时在册」的场景，验证四种引用分别落到谁手里。
 *
 * 测的是**路由归属**，不是两个模块各自的内部行为（那些各有专门的文件）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DshBridge } from '../plugins/dsh-bridge/lib/bridge.mjs';
import { PendingQueue } from '../plugins/dsh-bridge/lib/pending.mjs';
import { ConfirmRegistry, normalizeMessageId, parseConfirmReply } from '../src/guard/confirm.mjs';

const ADMIN = '100000001';
const ADMIN_DM = `private:${ADMIN}`;
const STRANGER = '100000002';

/**
 * 复刻宿主 `dispatchToPlugins` 的路由顺序，但把两边都换成真实现。
 *
 * 顺序本身就是被守的对象，所以这里**照抄**产品代码的结构：
 *
 *   1. 带引用 → 先问宿主（按 message_id 精确认领），不命中交回
 *   2. 不带引用 → 先问插件（它自己的队列它最清楚），不接管再问宿主
 *
 * 如果哪天有人把顺序改回去，这个测试会红 —— 那正是它存在的意义。
 *
 * @param {object} deps
 * @param {ConfirmRegistry} deps.host
 * @param {{bridge: DshBridge, msgIndex: Map<string, {id: string, at: number}>}} deps.plugin
 * @param {object} evt
 * @returns {{owner: 'host'|'plugin'|'none', handled: boolean, note?: string}}
 */
function route(deps, evt) {
  const { host, plugin } = deps;
  const convKey = String(evt.convKey ?? '');
  const senderId = String(evt.sender?.userId ?? '');
  const quotedId = normalizeMessageId(evt.replyTo?.messageId);
  const parsed = parseConfirmReply(evt.text);

  // ---- 1. 带引用：宿主先按 ID 认领 ----
  if (quotedId && parsed && convKey.startsWith('private:')) {
    const r = host.resolveByQuote({ messageId: quotedId, convKey, senderId, allow: parsed.allow });
    if (r.handled) return { owner: 'host', handled: true, note: r.reason ?? 'ok' };

    // 宿主说"不是我的" → 交给插件
    const target = plugin.msgIndex.get(quotedId);
    if (target) {
      const pr = plugin.bridge.reply(target.id, evt.text);
      if (pr.ok) {
        plugin.msgIndex.delete(quotedId);
        return { owner: 'plugin', handled: true };
      }
      return { owner: 'plugin', handled: true, note: pr.error };
    }
    return { owner: 'none', handled: false };
  }

  // ---- 2. 不带引用：插件先认 ----
  if (parsed && convKey.startsWith('private:')) {
    const ids = plugin.bridge.listPending().map((p) => p.id);
    if (/^\d+$/.test(String(evt.text ?? '')) && ids.length === 1) {
      const pr = plugin.bridge.reply(ids[0], evt.text);
      if (pr.ok) return { owner: 'plugin', handled: true };
    }
    const r = host.resolveUnquoted({ convKey, senderId, allow: parsed.allow });
    if (r.handled) return { owner: 'host', handled: true, note: r.reason ?? 'ok' };
    return { owner: 'none', handled: false };
  }

  return { owner: 'none', handled: false };
}

/** 让出一个事件循环，等插件的 onPush 真的跑完 */
const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * 造一套共存环境：宿主一条确认 + 插件一条审批，各自绑好消息 ID。
 */
async function makeWorld() {
  const host = new ConfirmRegistry({ timeoutMs: 60_000 });
  /** @type {any[]} */
  const pushed = [];
  const bridge = new DshBridge({
    token: 't',
    onAsk: async (req) => {
      pushed.push(req);
    },
  });
  /** @type {Map<string, {id: string, at: number}>} */
  const msgIndex = new Map();

  // 插件那张卡
  const start = bridge.askStart({ toolName: 'fs_write', reason: '要写 README' });
  await tick();
  assert.equal(pushed.length, 1, '插件必须推出一张卡');
  msgIndex.set('dsh-1001', { id: String(start.id), at: Date.now() });

  // 宿主那张卡
  const h = host.register({
    tool: 'shell_exec',
    risk: 'R3',
    args: { cmd: 'ls' },
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  host.bindMessage(h.id, 'host-2001');

  return {
    deps: { host, plugin: { bridge, msgIndex } },
    hostId: h.id,
    hostPromise: h.promise,
    pluginId: String(start.id),
    pluginWaiting: bridge.awaitResult(String(start.id)),
    /** 收尾：把还没答的按拒绝清掉，避免定时器拖住进程 */
    cleanup: () => host.cancelAll('test-cleanup'),
  };
}

const evtPrivate = (over = {}) => ({
  convKey: ADMIN_DM,
  sender: { userId: ADMIN },
  text: '1',
  ...over,
});

test('★ 引用宿主卡片 → 宿主结算，插件那条不受影响', async () => {
  const w = await makeWorld();
  try {
    const r = route(w.deps, evtPrivate({ replyTo: { messageId: 'host-2001' } }));
    assert.equal(r.owner, 'host');
    assert.equal(await w.hostPromise, 'allow');

    // 插件那条必须还在等 —— 这是"没有抢"的直接证据
    assert.deepEqual(w.deps.plugin.bridge.listPending().map((p) => p.id), [w.pluginId]);
  } finally {
    w.cleanup();
    w.deps.plugin.bridge.shutdown();
  }
});

test('★ 引用插件卡片 → 插件结算，宿主那条不受影响', async () => {
  const w = await makeWorld();
  try {
    const r = route(w.deps, evtPrivate({ replyTo: { messageId: 'dsh-1001' }, text: '1' }));
    assert.equal(r.owner, 'plugin', '宿主认不出这个 ID，必须交回插件');

    const outcome = await w.pluginWaiting;
    assert.equal(outcome.status, 'answered');
    assert.equal(outcome.outcome, 'allowed-once');

    // 宿主那条必须还在册（没被"猜"着批掉）
    assert.equal(w.deps.host.size, 1, '宿主的确认不能被顺带结算');
    assert.deepEqual(w.deps.host.list().map((x) => x.id), [w.hostId]);
  } finally {
    w.cleanup();
    w.deps.plugin.bridge.shutdown();
  }
});

test('★ 引用两条之外的无关消息 → 两边都不动', async () => {
  const w = await makeWorld();
  try {
    const r = route(w.deps, evtPrivate({ replyTo: { messageId: 'someone-else-3001' } }));
    assert.equal(r.owner, 'none');
    assert.equal(r.handled, false, '既不是宿主的也不是插件的 → 交回正常流程');

    assert.equal(w.deps.host.size, 1);
    assert.equal(w.deps.plugin.bridge.listPending().length, 1);
  } finally {
    w.cleanup();
    w.deps.plugin.bridge.shutdown();
  }
});

test('★ 非管理员引用宿主卡片 → 被拒，且不交回插件（避免插件乱认）', async () => {
  const w = await makeWorld();
  try {
    const r = route(
      w.deps,
      evtPrivate({ sender: { userId: STRANGER }, replyTo: { messageId: 'host-2001' } }),
    );
    assert.equal(r.owner, 'host', 'ID 是宿主的，就由宿主回"不是发给你的"');
    assert.equal(r.handled, true);
    assert.equal(w.deps.host.size, 1, '请求仍然在册');
    assert.equal(w.deps.plugin.bridge.listPending().length, 1, '插件那条不能被牵连');
  } finally {
    w.cleanup();
    w.deps.plugin.bridge.shutdown();
  }
});

test('★ 不带引用且两边各有在册 → 不吃掉任何一条', async () => {
  const w = await makeWorld();
  try {
    // 插件有一条、宿主有一条；「1」在插件那条路径上会先被认（它是唯一在册的插件请求）
    const r = route(w.deps, evtPrivate({ text: '2' }));
    assert.equal(r.owner, 'plugin', '插件只有一条在册时，数字归它 —— 这是插件的既有语义');
    assert.equal((await w.pluginWaiting).outcome, 'rejected');

    // 宿主那条必须还在（没被同一条消息批量消费）
    assert.equal(w.deps.host.size, 1);
  } finally {
    w.cleanup();
    w.deps.plugin.bridge.shutdown();
  }
});

test('★ 宿主没有待确认时，插件审批仍然正常工作（回归基线）', async () => {
  /** @type {any[]} */
  const pushed = [];
  const bridge = new DshBridge({
    token: 't',
    onAsk: async (req) => pushed.push(req),
  });
  const host = new ConfirmRegistry({ timeoutMs: 60_000 });
  /** @type {Map<string, {id: string, at: number}>} */
  const msgIndex = new Map();

  const start = bridge.askStart({ toolName: 'fs_write' });
  await tick();
  msgIndex.set('dsh-9', { id: String(start.id), at: Date.now() });
  const waiting = bridge.awaitResult(String(start.id));

  const r = route({ host, plugin: { bridge, msgIndex } }, evtPrivate({ replyTo: { messageId: 'dsh-9' } }));
  assert.equal(r.owner, 'plugin');
  assert.equal((await waiting).outcome, 'allowed-once');
  assert.equal(host.size, 0);
  host.cancelAll();
  bridge.shutdown();
});

test('★ 双方都已在册时，插件先答、宿主后答，互不干扰', async () => {
  const w = await makeWorld();
  try {
    // 先答插件（引用它的卡）
    route(w.deps, evtPrivate({ replyTo: { messageId: 'dsh-1001' }, text: '2' }));
    assert.equal((await w.pluginWaiting).outcome, 'rejected');

    // 再答宿主（引用它的卡）
    route(w.deps, evtPrivate({ replyTo: { messageId: 'host-2001' }, text: '1' }));
    assert.equal(await w.hostPromise, 'allow');

    assert.equal(w.deps.host.size, 0);
    assert.equal(w.deps.plugin.bridge.listPending().length, 0);
  } finally {
    w.cleanup();
    w.deps.plugin.bridge.shutdown();
  }
});

/* ------------------------------------------------ 派发顺序：确认不被低优先级抢 */

/**
 * 复刻**完整**派发顺序（含低优先级插件）：
 *
 *   1. 带引用 → 宿主按 message_id 认领（命中即止）
 *   2. normal 插件（dsh-bridge）
 *   3. low 插件（正则自动回复）——它按 `gate.confirmPending` 主动让路
 *   4. 不带引用的宿主确认
 *
 * 第 3 步的让路是 `docs/plugin-api.md` §5 对 `confirmPending` 的契约：
 * 为 true 时，形似确认回复的文本不要接管。
 *
 * @param {object} deps
 * @param {object} evt
 * @param {{lowCalled: boolean}} spy
 */
function routeFull(deps, evt, spy) {
  const { host, plugin } = deps;
  const convKey = String(evt.convKey ?? '');
  const senderId = String(evt.sender?.userId ?? '');
  const quotedId = normalizeMessageId(evt.replyTo?.messageId);
  const parsed = parseConfirmReply(evt.text);

  if (quotedId && parsed && convKey.startsWith('private:')) {
    const r = host.resolveByQuote({ messageId: quotedId, convKey, senderId, allow: parsed.allow });
    if (r.handled) return { owner: 'host' };
    const target = plugin.msgIndex.get(quotedId);
    if (target && plugin.bridge.reply(target.id, evt.text).ok) {
      plugin.msgIndex.delete(quotedId);
      return { owner: 'plugin' };
    }
    return { owner: 'none' };
  }

  if (parsed && convKey.startsWith('private:')) {
    // normal：dsh-bridge 只认自己的队列
    const ids = plugin.bridge.listPending().map((p) => p.id);
    if (/^\d+$/.test(String(evt.text ?? '')) && ids.length === 1) {
      if (plugin.bridge.reply(ids[0], evt.text).ok) return { owner: 'plugin' };
    }
    /*
     * low：宿主有待确认且文本像确认回复 → 必须让路（§5 gate），
     * 连规则匹配都不该开始跑。否则它可能把这条「1」当口令回掉，
     * 而用户其实是在回答那张确认卡。
     */
    const gate = { confirmPending: host.hasActionable(convKey, senderId) };
    const yieldedByLow =
      gate.confirmPending && /^(1|2|同意|拒绝|允许|取消)$/.test(String(evt.text ?? '').trim());
    if (!yieldedByLow) {
      spy.lowCalled = true; // 低优先级插件会尝试接管（本例没有规则命中）
    }

    // 走到这里说明没有插件认领，轮到宿主的不带引用确认
    const r = host.resolveUnquoted({ convKey, senderId, allow: parsed.allow });
    return { ...(r.handled ? { owner: 'host' } : { owner: 'none' }), ...(yieldedByLow ? { yieldedByLow } : {}) };
  }
  return { owner: 'none' };
}

test('★ 低优先级插件给宿主确认让路：不带引用的「1」由宿主结算', async () => {
  const host = new ConfirmRegistry({ timeoutMs: 60_000 });
  const bridge = new DshBridge({ token: 't', onAsk: async () => {} });
  const entry = host.register({
    tool: 'shell_exec',
    risk: 'R3',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  const spy = { lowCalled: false };

  try {
    const r = routeFull({ host, plugin: { bridge, msgIndex: new Map() } }, evtPrivate({ text: '1' }), spy);
    assert.equal(r.yieldedByLow, true, '低优先级插件必须看到 confirmPending 后让路');
    assert.equal(spy.lowCalled, false, '它连规则匹配都不该跑');
    assert.equal(r.owner, 'host');
    assert.equal(await entry.promise, 'allow');
    assert.equal(host.size, 0);
  } finally {
    host.cancelAll('test-cleanup');
    bridge.shutdown();
  }
});

test('★ 编号回卷不能覆盖在册审批（否则两条卡一起坏掉）', async () => {
  const q = new PendingQueue({ timeoutMs: 60_000 });
  const a = q.enqueue({
    kind: 'approval',
    title: 'A',
    choices: [{ key: 'allowed-once', label: '允许一次' }],
  });
  // 把计数器推到回卷点：下一个编号本该又是 "1"
  for (let i = 0; i < 98; i += 1) q.allocId();

  const b = q.enqueue({
    kind: 'approval',
    title: 'B',
    choices: [{ key: 'allowed-once', label: '允许一次' }],
  });

  assert.notEqual(b.id, a.id, '还在等回答的编号不能被发第二次');
  assert.equal(q.ids().length, 2, '两张卡必须都在册');
  assert.equal(q.get(a.id).title, 'A', 'A 的条目不能被覆盖');
  assert.equal(q.get(b.id).title, 'B');

  // 两张卡各自能被自己的回复结算，且结论不串
  assert.equal(q.settle(a.id, 'allowed-once').ok, true);
  assert.equal(q.settle(b.id, 'rejected').ok, true);
  assert.equal((await a.promise).value, 'allowed-once');
  assert.equal((await b.promise).value, 'rejected');
  assert.deepEqual(q.ids(), []);
});
