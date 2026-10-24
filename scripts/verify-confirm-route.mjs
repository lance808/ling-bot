/**
 * 真实链路自检：OneBot 事件 → normalizeEvent → 宿主/插件路由 → 结算
 *
 * 这是 DECISIONS 里 K33/K34 的教训：**重启前先在本地把真实链路跑一遍**，
 * 构造 OneBot 原始事件、走真实归一化、命中编号、解析、结算 ——
 * 跑通了再交给用户去试。
 *
 * 与单测的区别：这里从**原始 OneBot JSON** 开始，所以能抓到
 * "字段名读错"这类问题（K33 就是 `evt.replyToMessageId` 不存在）。
 *
 * 用法：node scripts/verify-confirm-route.mjs
 * 退出码：0 全部通过 / 1 有断言失败
 */

import assert from 'node:assert/strict';

import { normalizeEvent } from '../src/onebot/events.mjs';
import { ConfirmRegistry, parseConfirmReply, normalizeMessageId } from '../src/guard/confirm.mjs';
import { DshBridge } from '../plugins/dsh-bridge/lib/bridge.mjs';
import { coreAdminIds, isCoreAdmin, deliverableAdminIds } from '../src/guard/admin.mjs';
import { validateConfig } from '../src/config/schema.mjs';

const ADMIN = '100000001';
const STRANGER = '100000002';
const ADMIN_DM = `private:${ADMIN}`;

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => any | Promise<any>} fn
 */
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  ✖ ${name}`);
    console.error(`    ${String(/** @type {any} */ (err)?.message ?? err)}`);
    failed += 1;
  }
}

/** 造一条真实的 OneBot 私聊消息事件 */
function onebotPrivate({ text, from = ADMIN, messageId = 9001, replyTo = null }) {
  /** @type {any[]} */
  const message = [];
  if (replyTo !== null) message.push({ type: 'reply', data: { id: String(replyTo) } });
  message.push({ type: 'text', data: { text } });
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    time: Math.floor(Date.now() / 1000),
    self_id: 200000001,
    user_id: Number(from),
    message_id: messageId,
    message,
    sender: { user_id: Number(from), nickname: `u${from}` },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

console.log('确认回复路由自检（真实 OneBot 事件 → 结算）\n');

/*
 * ## 为什么这个脚本需要自己拿住事件循环
 *
 * 确认定时器是 `unref()` 的 —— 这是**有意**的：用户关窗时进程必须能退，
 * 不能因为还有一个"60 秒后自动拒绝"的定时器就卡住不关。
 *
 * 代价是：当进程里没有别的东西撑着（后端有 OneBot 连接与 stdin，
 * 这个脚本没有），事件循环会直接空掉，定时器永远不触发。
 *
 * 第一次跑这个脚本时正是这样：最后一项「无人应答按拒绝结算」直接挂起，
 * 报 "Detected unsettled top-level await"。所以脚本要自己 hold 住。
 */
const keepAlive = setInterval(() => {}, 1000);

/* -------------------------------------------------- 1. 归一化形状 */

await check('normalizeEvent 产出的 replyTo.messageId 与宿主读取的字段一致', () => {
  const evt = normalizeEvent(onebotPrivate({ text: '1', replyTo: 555 }));
  assert.ok(evt, '事件必须能归一化');
  // K33 的病灶：插件读 evt.replyToMessageId（不存在），引用永远识别不到
  assert.ok(evt.replyTo, '必须有 replyTo');
  assert.equal(normalizeMessageId(evt.replyTo.messageId), '555');
  assert.equal(evt.text, '1');
  assert.equal(evt.convKey, ADMIN_DM);
});

await check('归一化后的文本去掉引用段，只剩用户打的内容', () => {
  const evt = normalizeEvent(onebotPrivate({ text: '同意 2', replyTo: 777 }));
  assert.equal(evt.text, '同意 2');
  assert.deepEqual(parseConfirmReply(evt.text), { allow: true, seq: 2 });
});

/* ------------------------------------------- 2. 宿主：正确引用 */

await check('宿主：引用卡片回 1 → 结算为 allow', async () => {
  const reg = new ConfirmRegistry({ timeoutMs: 60_000 });
  const { id, promise } = reg.register({
    tool: 'fs_write',
    risk: 'R2',
    args: { path: 'a.txt' },
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  reg.bindMessage(id, 10001);

  const evt = normalizeEvent(onebotPrivate({ text: '1', replyTo: 10001 }));
  const r = reg.resolveByQuote({
    messageId: normalizeMessageId(evt.replyTo.messageId),
    convKey: evt.convKey,
    senderId: String(evt.sender.userId),
    allow: parseConfirmReply(evt.text).allow,
  });
  assert.equal(r.ok, true);
  assert.equal(await promise, 'allow');
});

await check('宿主：非管理员引用同一张卡 → 被拒，请求仍在册', async () => {
  const reg = new ConfirmRegistry({ timeoutMs: 60_000 });
  const { id } = reg.register({
    tool: 'fs_write',
    risk: 'R2',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  reg.bindMessage(id, 10002);

  const evt = normalizeEvent(onebotPrivate({ text: '1', replyTo: 10002, from: STRANGER }));
  const r = reg.resolveByQuote({
    messageId: normalizeMessageId(evt.replyTo.messageId),
    convKey: evt.convKey, // 陌生人私聊的会话键是 private:<他>，天然不同
    senderId: String(evt.sender.userId),
    allow: true,
  });
  assert.equal(r.ok, false);
  assert.equal(reg.size, 1);
  reg.cancelAll();
});

/* ------------------------------------------- 3. 插件：不被抢 */

await check('插件：DSH 审批引用回复仍然生效（宿主没有同类请求时）', async () => {
  /** @type {any[]} */
  const pushed = [];
  const bridge = new DshBridge({ token: 't', onAsk: async (r) => pushed.push(r) });
  const reg = new ConfirmRegistry({ timeoutMs: 60_000 });

  const start = bridge.askStart({ toolName: 'fs_write' });
  await tick();
  assert.equal(pushed.length, 1, '插件必须推出卡片');

  /** @type {Map<string, {id: string, at: number}>} */
  const msgIndex = new Map([[String(20001), { id: String(start.id), at: Date.now() }]]);
  const waiting = bridge.awaitResult(String(start.id));

  const evt = normalizeEvent(onebotPrivate({ text: '1', replyTo: 20001 }));
  const mid = normalizeMessageId(evt.replyTo.messageId);

  // 宿主先认领：必须交回
  const hostR = reg.resolveByQuote({ messageId: mid, convKey: evt.convKey, senderId: ADMIN, allow: true });
  assert.equal(hostR.handled, false, '宿主必须交回不属于自己的引用');

  // 插件接手
  const target = msgIndex.get(mid);
  assert.ok(target, '插件必须能从 message_id 反查到编号');
  assert.equal(bridge.reply(target.id, evt.text).ok, true);
  assert.equal((await waiting).outcome, 'allowed-once');

  reg.cancelAll();
  bridge.shutdown();
});

await check('插件：宿主也有请求时，DSH 的引用不被宿主结算掉', async () => {
  /** @type {any[]} */
  const pushed = [];
  const bridge = new DshBridge({ token: 't', onAsk: async (r) => pushed.push(r) });
  const reg = new ConfirmRegistry({ timeoutMs: 60_000 });

  const start = bridge.askStart({ toolName: 'fs_write' });
  await tick();
  const waiting = bridge.awaitResult(String(start.id));

  const host = reg.register({
    tool: 'shell_exec',
    risk: 'R3',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  reg.bindMessage(host.id, 20002);
  /** @type {Map<string, {id: string, at: number}>} */
  const msgIndex = new Map([[String(20003), { id: String(start.id), at: Date.now() }]]);

  // 引用插件的卡
  const evt = normalizeEvent(onebotPrivate({ text: '2', replyTo: 20003 }));
  const mid = normalizeMessageId(evt.replyTo.messageId);
  const hostR = reg.resolveByQuote({ messageId: mid, convKey: evt.convKey, senderId: ADMIN, allow: false });
  assert.equal(hostR.handled, false);
  assert.equal(reg.size, 1, '宿主的请求不能被牵连');

  bridge.reply(msgIndex.get(mid).id, evt.text);
  assert.equal((await waiting).outcome, 'rejected');

  reg.cancelAll();
  bridge.shutdown();
});

/* ------------------------------------------- 4. 授权来源 */

await check('授权：白名单里的号不是管理员（默认）', () => {
  const cfg = validateConfig({ allow: { groups: [], private: [ADMIN] } });
  assert.deepEqual(coreAdminIds(cfg), []);
  assert.equal(isCoreAdmin(cfg, ADMIN), false);
});

await check('授权：显式 admin.qqIds 才生效；投递名单另算', () => {
  const cfg = validateConfig({
    admin: { qqIds: [ADMIN] },
    plugins: { config: { 'dsh-bridge': { admins: STRANGER } } },
  });
  assert.deepEqual(coreAdminIds(cfg), [ADMIN]);
  assert.equal(isCoreAdmin(cfg, ADMIN), true);
  assert.equal(isCoreAdmin(cfg, STRANGER), false, 'DSH 管理员不是宿主机管理员');
  const deliverable = deliverableAdminIds(cfg);
  assert.ok(deliverable.includes(ADMIN));
  assert.ok(deliverable.includes(STRANGER), '但仍要能收到审批推送');
});

/* ------------------------------------------- 5. 并发与重复 */

await check('并发：两条在册时裸数字被拒，引用可分别答掉', async () => {
  const reg = new ConfirmRegistry({ timeoutMs: 60_000 });
  const a = reg.register({ tool: 'a', risk: 'R2', args: {}, convKey: ADMIN_DM, replyConvKey: ADMIN_DM, allowedSenders: [ADMIN] });
  const b = reg.register({ tool: 'b', risk: 'R2', args: {}, convKey: ADMIN_DM, replyConvKey: ADMIN_DM, allowedSenders: [ADMIN] });
  reg.bindMessage(a.id, 30001);
  reg.bindMessage(b.id, 30002);

  const evt = normalizeEvent(onebotPrivate({ text: '1' }));
  const bare = reg.resolveUnquoted({ convKey: evt.convKey, senderId: ADMIN, allow: true });
  assert.equal(bare.handled, true);
  assert.equal(bare.reason, 'ambiguous', '两条在册时不能猜');

  reg.resolveByQuote({ messageId: '30001', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  reg.resolveByQuote({ messageId: '30002', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(await a.promise, 'allow');
  assert.equal(await b.promise, 'deny');
});

await check('重复：同一条引用再回一次 → 明确告知已处理，结论不变', async () => {
  const reg = new ConfirmRegistry({ timeoutMs: 60_000 });
  const { id, promise } = reg.register({
    tool: 'fs_write',
    risk: 'R2',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  reg.bindMessage(id, 40001);

  assert.equal(reg.resolveByQuote({ messageId: '40001', convKey: ADMIN_DM, senderId: ADMIN, allow: true }).ok, true);
  const again = reg.resolveByQuote({ messageId: '40001', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'duplicate');
  assert.equal(await promise, 'allow');
});

/* ------------------------------------------- 6. fail-closed */

await check('fail-closed：无人应答按拒绝结算', async () => {
  const reg = new ConfirmRegistry({ timeoutMs: 20 });
  const { promise } = reg.register({
    tool: 'shell_exec',
    risk: 'R3',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  assert.equal(await promise, 'deny');
});

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✖ 有失败项'}：${passed} 通过 / ${failed} 失败`);
clearInterval(keepAlive);
process.exit(failed === 0 ? 0 : 1);
