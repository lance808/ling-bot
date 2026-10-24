/**
 * 确认回复的身份校验与请求归属 —— 行为测试
 *
 * ## 这一组守的是什么
 *
 * 修之前，「1/2」这条入口有三处结构性问题，每一处都能用一次真实的
 * 误操作复现：
 *
 *   1. **不认人**：任何人回「1」都算数 → 群友能批准宿主机操作
 *   2. **不认会话**：A 私聊的卡，B 在另一个会话里回「1」也命中
 *   3. **不认引用**：卡片写着"引用那条回数字"，但结算只按序号 →
 *      并发两条时批错对象；更糟的是**抢走 dsh-bridge 的引用审批**
 *
 * 所以下面每个用例都对应一个具体的误操作场景，而不是断言实现细节。
 *
 * 这里测的是 `guard/confirm.mjs` —— 它不读配置、不发消息、不写日志，
 * 时钟可以注入。所以过期、并发、双端竞争都能在毫秒级穷举。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfirmRegistry,
  parseConfirmReply,
  normalizeMessageId,
  SETTLE_REASON,
} from '../src/guard/confirm.mjs';

const ADMIN = '100000001';
const ADMIN2 = '100000002';
const STRANGER = '100000003';
const ADMIN_DM = `private:${ADMIN}`;
const ADMIN2_DM = `private:${ADMIN2}`;
const GROUP = 'group:100000004';

/**
 * 本文件创建过的登记表。
 *
 * ## 为什么必须收着并在最后清空
 *
 * 每条登记都会挂一个 60 秒的定时器。断言只关心"结算结果对不对"，
 * 但**没被结算的那些**会把定时器留到真实时间到点 —— 表现是整个
 * 测试文件明明每个用例都是毫秒级，却要跑满 60 秒。
 *
 * 那不是产品缺陷（运行时的定时器本来就该留着），是测试没有清理
 * 自己创建的资源。所以这里统一收口：用例想留活的就留，
 * 文件结束时一次性 cancelAll。
 */
const created = [];

test.after(() => {
  for (const reg of created) reg.cancelAll('test-cleanup');
});

/**
 * 造一个可注入时钟的登记表。
 *
 * 用可控时钟而不是真等 60 秒：过期与并发是这里最需要覆盖的路径，
 * 而它们靠真实计时器测得又慢又脆。
 */
function makeRegistry(over = {}) {
  let now = 1_000_000;
  const reg = new ConfirmRegistry({
    timeoutMs: 60_000,
    now: () => now,
    ...over,
  });
  created.push(reg);
  return {
    reg,
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
  };
}

/** 登记一条绑好消息 ID 的请求 */
function register(reg, over = {}) {
  const { id, seq, promise } = reg.register({
    tool: 'fs_write',
    risk: 'R2',
    args: { path: 'a.txt' },
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
    ...over,
  });
  return { id, seq, promise };
}

/* ------------------------------------------------------------------ 解析 */

test('解析：1 = 同意，2 = 拒绝', () => {
  assert.deepEqual(parseConfirmReply('1'), { allow: true });
  assert.deepEqual(parseConfirmReply(' 2 '), { allow: false });
});

test('解析：文字形式与带序号的写法', () => {
  assert.deepEqual(parseConfirmReply('同意'), { allow: true });
  assert.deepEqual(parseConfirmReply('拒绝'), { allow: false });
  assert.deepEqual(parseConfirmReply('允许'), { allow: true });
  assert.deepEqual(parseConfirmReply('取消'), { allow: false });
  assert.deepEqual(parseConfirmReply('同意 3'), { allow: true, seq: 3 });
  assert.deepEqual(parseConfirmReply('拒绝 2'), { allow: false, seq: 2 });
  assert.deepEqual(parseConfirmReply('同意 #3'), { allow: true, seq: 3 });
  assert.deepEqual(parseConfirmReply('同意 confirm-1-abc'), { allow: true, id: 'confirm-1-abc' });
});

test('★ 解析：不是确认回复的一律返回 null（不能抢聊天内容）', () => {
  for (const s of ['', '3', '12', '2 点了', '你好', '同意吗？', 'ok', 'yes', 'approve']) {
    assert.equal(parseConfirmReply(s), null, `"${s}" 不该被当成确认回复`);
  }
});

test('★ messageId 归一：数字与字符串必须等价', () => {
  // 不统一的话 msgIndex.get(number) 与 get(string) 会得到两个答案，
  // 症状是"引用明明存在却说没有这条"
  assert.equal(normalizeMessageId(123456), '123456');
  assert.equal(normalizeMessageId('123456'), '123456');
  assert.equal(normalizeMessageId(-98765), '-98765');
  assert.equal(normalizeMessageId(null), '');
  assert.equal(normalizeMessageId(undefined), '');
  assert.equal(normalizeMessageId('  '), '');
});

/* ------------------------------------------------------------ 正确引用 */

test('★ 正确引用：按消息 ID 精确结算', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  assert.equal(reg.bindMessage(id, 5001).ok, true);

  const r = reg.resolveByQuote({ messageId: '5001', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'allow');
  assert.equal(r.via ?? 'quote', 'quote');
  assert.equal(await promise, 'allow', '等待方拿到的是 allow');
});

test('★ 数字形式的 messageId 也能命中（OneBot int64 差异）', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, '6001');
  const r = reg.resolveByQuote({ messageId: 6001, convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(r.ok, true);
  assert.equal(await promise, 'deny');
});

test('★ 引用另一条：只结算被引用的那一条（并发时不能批错对象）', async () => {
  const { reg } = makeRegistry();
  const a = register(reg, { tool: 'fs_write', args: { path: 'a' } });
  const b = register(reg, { tool: 'shell_exec', args: { cmd: 'ls' } });
  reg.bindMessage(a.id, '7001');
  reg.bindMessage(b.id, '7002');

  // 给 A 挂一个观察器：它必须一直不落定
  let aSettled = false;
  void a.promise.then(() => {
    aSettled = true;
  });

  // 引用 B，但文本是 1（同意）
  const r = reg.resolveByQuote({ messageId: '7002', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.ok, true);
  assert.equal(r.id, b.id, '结算的必须是 B');
  assert.equal(await b.promise, 'allow');

  // A 仍然在册，且它的 Promise 还没落定
  assert.equal(reg.entries.has(a.id), true);
  assert.equal(reg.entries.has(b.id), false);
  // 让出一次事件循环，确认 A 的 then 没被触发
  await new Promise((r2) => setImmediate(r2));
  assert.equal(aSettled, false, 'A 不能被顺带批准');
});

/* ------------------------------------------------------- 引用不属于本表 */

test('★ 引用不属于本表：必须交回，绝不猜', () => {
  const { reg } = makeRegistry();
  // 有一条待确认，但它没绑这条消息
  const { id } = register(reg);
  reg.bindMessage(id, '8001');

  const r = reg.resolveByQuote({ messageId: '9999', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.handled, false, 'handled=false = 交回插件');
  assert.equal(r.reason, 'unknown-quote');
  // 那条待确认不能被顺带结算
  assert.equal(reg.entries.has(id), true, '不能被"猜"着结算掉');
});

test('★ 插件审批不被抢：DSH 引用在无待确认时也不被吞', () => {
  const { reg } = makeRegistry();
  const r = reg.resolveByQuote({ messageId: 'dsh-42', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.handled, false, '宿主没有任何请求时，这条引用必须原样交回 dsh-bridge');
});

test('★ 插件审批不被抢：宿主有请求时，DSH 的引用仍交回', () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, '8101');

  const r = reg.resolveByQuote({ messageId: 'dsh-99', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(r.handled, false, 'ID 不匹配就不是我的');
  assert.equal(reg.entries.has(id), true);
  // 宿主那条不能被这次拒绝影响
  reg.resolveByQuote({ messageId: '8101', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  return promise;
});

/* ------------------------------------------------ 已结算引用的会话归属 */

test('★ 重复回复：只有卡片所在会话能看到"已处理过"', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, '8201');

  assert.equal(reg.resolveByQuote({ messageId: '8201', convKey: ADMIN_DM, senderId: ADMIN, allow: true }).ok, true);
  assert.equal(await promise, 'allow');

  // 另一个会话引用同一个 message_id：不是这张卡的回复，必须原样交回
  const foreign = reg.resolveByQuote({ messageId: '8201', convKey: ADMIN2_DM, senderId: ADMIN2, allow: false });
  assert.equal(foreign.handled, false, '别的会话的引用不能被本入口消费');
  assert.equal(foreign.reason, 'unknown-quote');

  // 卡片所在会话再回一次：明确告知已处理
  const same = reg.resolveByQuote({ messageId: '8201', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(same.handled, true);
  assert.equal(same.reason, 'duplicate');
  assert.equal(same.outcome, 'allow', '结论仍然是第一次的 allow');
});

test('★ 重复回复：cancelAll 后别的会话引用也不能被"已处理过"消费', () => {
  const { reg } = makeRegistry();
  const { id } = register(reg);
  reg.bindMessage(id, '8202');
  reg.cancelAll();

  const foreign = reg.resolveByQuote({ messageId: '8202', convKey: ADMIN2_DM, senderId: ADMIN2, allow: true });
  assert.equal(foreign.handled, false);

  const same = reg.resolveByQuote({ messageId: '8202', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(same.reason, 'duplicate');
});

/* ------------------------------------------------------------ 错误用户 */

test('★ 错误用户：非允许者引用正确消息 → 拒绝，且不结算', () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, '9001');

  const r = reg.resolveByQuote({ messageId: '9001', convKey: ADMIN_DM, senderId: STRANGER, allow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden');
  assert.match(r.message, /不是发给你的/);
  assert.equal(reg.entries.has(id), true, '请求必须还在册');

  // 真正的管理员仍然能处理
  reg.resolveByQuote({ messageId: '9001', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  return promise;
});

test('★ 错误用户：不带引用时说「同意」也不能结算（恰好一条也不行）', () => {
  const { reg } = makeRegistry();
  const { id } = register(reg);

  const r = reg.resolveUnquoted({ convKey: ADMIN_DM, senderId: STRANGER, allow: true });
  assert.equal(r.handled, false, '他名下没有可处理请求');
  assert.equal(reg.entries.has(id), true);
});

test('★ allowedSenders 为空 = 只能桌面端处理（QQ 侧任何人都不行）', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg, { allowedSenders: [] });
  reg.bindMessage(id, '9101');

  const r = reg.resolveByQuote({ messageId: '9101', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'forbidden', '名单为空时谁都不许在 QQ 上批');

  // 桌面端仍然可以
  assert.equal(reg.resolveFromConsole({ id, allow: false }).ok, true);
  assert.equal(await promise, 'deny');
});

test('★ 非法号码在 allowedSenders 里被过滤（不能静默变成"谁都可以"）', () => {
  const { reg } = makeRegistry();
  const { id } = register(reg, { allowedSenders: ['', null, 'abc', '管理员'] });
  assert.deepEqual(reg.entries.get(id).allowedSenders, [], '非法项全部丢弃，名单为空');
});

/* ------------------------------------------------------------ 错误会话 */

test('★ 错误会话：引用正确消息但在别的会话里回 → 拒绝', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, '9201');

  const r = reg.resolveByQuote({ messageId: '9201', convKey: ADMIN2_DM, senderId: ADMIN, allow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong-session');
  assert.equal(reg.entries.has(id), true);

  reg.resolveByQuote({ messageId: '9201', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  return promise;
});

test('★ 群聊里回「同意」不能结算私聊的确认', () => {
  const { reg } = makeRegistry();
  const { id } = register(reg);
  const r = reg.resolveUnquoted({ convKey: GROUP, senderId: ADMIN, allow: true });
  assert.equal(r.handled, false, '群会话不是卡片的投递会话');
  assert.equal(reg.entries.has(id), true);
});

test('★ replyConvKey 为空（群聊来源的请求）不能在 QQ 侧结算', () => {
  const { reg } = makeRegistry();
  // 群聊来源：不投卡片，只走桌面端
  const { id } = register(reg, { convKey: GROUP, replyConvKey: '', allowedSenders: [ADMIN] });
  const r = reg.resolveUnquoted({ convKey: GROUP, senderId: ADMIN, allow: true });
  assert.equal(r.handled, false);
  assert.equal(reg.entries.has(id), true);
});

test('★ 只能桌面端确认的请求，不能被提示成"去别的会话回答"', () => {
  const { reg } = makeRegistry();
  // 群聊来源的请求：replyConvKey 为空 = QQ 侧根本没有可回答的会话
  register(reg, { convKey: GROUP, replyConvKey: '', allowedSenders: [ADMIN] });

  assert.equal(
    reg.hasActionableElsewhere(ADMIN_DM, ADMIN),
    false,
    '没有可回答的会话时不能引导用户去"那个会话"',
  );
  // 桌面端仍然能处理，所以它也不算"名下没有请求"
  assert.equal(reg.hasActionable(ADMIN_DM, ADMIN), false);
  assert.equal(reg.size, 1);

  // 控制组：真的在另一个会话里有一张卡时，才提示去那里
  const { reg: reg2 } = makeRegistry();
  register(reg2, { convKey: ADMIN2_DM, replyConvKey: ADMIN2_DM, allowedSenders: [ADMIN] });
  assert.equal(reg2.hasActionableElsewhere(ADMIN_DM, ADMIN), true);
});

/* ------------------------------------------------------------ 并发请求 */

test('★ 并发两条：不带引用的「1」必须被拒（要求引用）', async () => {
  const { reg } = makeRegistry();
  const a = register(reg, { tool: 'fs_write' });
  const b = register(reg, { tool: 'shell_exec' });

  const r = reg.resolveUnquoted({ convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.match(r.message, /引用/, '要明确要求引用');
  // 两条都还在
  assert.equal(reg.entries.has(a.id), true);
  assert.equal(reg.entries.has(b.id), true);

  // 收尾：按引用分别答掉
  reg.bindMessage(a.id, 'a1');
  reg.bindMessage(b.id, 'b1');
  reg.resolveByQuote({ messageId: 'a1', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  reg.resolveByQuote({ messageId: 'b1', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(await a.promise, 'allow');
  assert.equal(await b.promise, 'deny');
});

test('★ 并发时显式序号能定位（「同意 2」）', async () => {
  const { reg } = makeRegistry();
  const a = register(reg);
  const b = register(reg);
  const r = reg.resolveUnquoted({ convKey: ADMIN_DM, senderId: ADMIN, allow: true, seq: b.seq });
  assert.equal(r.ok, true);
  assert.equal(r.id, b.id);
  assert.equal(reg.entries.has(a.id), true);
});

test('★ 序号在登记时冻结：答掉一条后另一条的序号不变', () => {
  const { reg } = makeRegistry();
  const a = register(reg);
  const b = register(reg);
  assert.deepEqual([a.seq, b.seq], [1, 2]);

  // 答掉第 1 条
  reg.resolveFromConsole({ id: a.id, allow: true });
  // 第 2 条的序号必须还是 2 —— 卡片上印的就是 2
  assert.equal(reg.entries.get(b.id).seq, 2, '卡片上的序号不能变');
  assert.equal(reg.seqOf.get(b.id), 2);

  const r = reg.resolveUnquoted({ convKey: ADMIN_DM, senderId: ADMIN, allow: false, seq: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.id, b.id);
});

test('★ 并发不同管理员：A 的卡不能被 B 结算', () => {
  const { reg } = makeRegistry();
  const a = register(reg, { convKey: ADMIN_DM, replyConvKey: ADMIN_DM, allowedSenders: [ADMIN] });
  const b = register(reg, { convKey: ADMIN2_DM, replyConvKey: ADMIN2_DM, allowedSenders: [ADMIN2] });

  // ADMIN2 在自己会话里只看到自己那一条
  const r = reg.resolveUnquoted({ convKey: ADMIN2_DM, senderId: ADMIN2, allow: true });
  assert.equal(r.ok, true);
  assert.equal(r.id, b.id);
  assert.equal(reg.entries.has(a.id), true, 'A 那条不能被动');
});

/* ------------------------------------------------------------ 过期 */

test('★ 过期：超时后按拒绝结算，等待方拿到 deny', async () => {
  const { reg, advance } = makeRegistry();
  const { id, promise } = register(reg);
  assert.equal(reg.entries.has(id), true);

  advance(60_000);
  // 手动触发一次"到点"的路径：直接调用 list 不会结算，
  // 所以用一个可处理的回复来触发过期判定
  const r = reg.resolveByQuote({ messageId: 'nope', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.handled, false, '未知引用仍交回');

  // 用带引用的方式在同一个请求上触发过期分支
  reg.bindMessage(id, 'x1');
  const late = reg.resolveByQuote({ messageId: 'x1', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
  assert.match(late.message, /超时/);
  assert.equal(await promise, 'deny', '过期的请求不能被迟到的回复翻案');
});

test('★ 过期：定时器自己也会按拒绝落定', async () => {
  // 真定时器：给很短的上限，验证无人回复的路径
  const reg = new ConfirmRegistry({ timeoutMs: 20 });
  created.push(reg);
  const { promise } = reg.register({
    tool: 'fs_write',
    risk: 'R2',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  assert.equal(await promise, 'deny', '没人应答 = 拒绝（fail-closed）');
  assert.equal(reg.size, 0, '过期后不能还占着位置');
});

test('★ 过期：超时会触发 onTimeout 回调（界面要收得到）', async () => {
  /** @type {any[]} */
  const seen = [];
  const reg = new ConfirmRegistry({ timeoutMs: 20, onTimeout: (info) => seen.push(info) });
  created.push(reg);
  reg.register({
    tool: 'shell_exec',
    risk: 'R3',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'shell_exec');
});

test('★ 过期后序号被释放（不会让下一个请求顶着"第 3 条"）', async () => {
  const { reg, advance } = makeRegistry();
  const { id, promise } = register(reg);
  const seq = reg.entries.get(id).seq;
  advance(60_000);
  reg.resolveByQuote({ messageId: 'zzz', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  // 触发过期结算
  reg.entries.get(id) && reg.resolveUnquoted({ convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(reg.idOfSeq.has(seq), false, '过期后序号必须释放');
  await promise;
});

/* ------------------------------------------------------------ 重复回复 */

test('★ 重复回复：同一个 messageId 再引用一次 → 明确告知已处理', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, 'r1');

  const first = reg.resolveByQuote({ messageId: 'r1', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(first.ok, true);

  const second = reg.resolveByQuote({ messageId: 'r1', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(second.ok, false);
  assert.equal(second.handled, true, '同一条消息的重复回复由本入口处理（要告诉用户）');
  assert.equal(second.reason, 'duplicate');
  assert.match(second.message, /已经处理过/);
  assert.equal(await promise, 'allow', '第一次的结论不能被第二次覆盖');
});

test('★ 重复回复：请求 ID 只能结算一次', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);

  assert.equal(reg.resolveFromConsole({ id, allow: true }).ok, true);
  const again = reg.resolveFromConsole({ id, allow: false });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'duplicate');
  assert.match(again.message, /已经处理过/);
  assert.equal(await promise, 'allow');
});

test('★ 重复回复：桌面端拒绝后 QQ 再同意，结论不变', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, 'dup1');

  reg.resolveFromConsole({ id, allow: false });
  const qq = reg.resolveByQuote({ messageId: 'dup1', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(qq.ok, false);
  assert.equal(qq.reason, 'duplicate');
  assert.equal(await promise, 'deny', '先到的那次生效');
});

test('★ 结算后不能再用序号找到它', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  const seq = reg.entries.get(id).seq;
  reg.resolveFromConsole({ id, allow: true });

  const r = reg.resolveUnquoted({ convKey: ADMIN_DM, senderId: ADMIN, allow: false, seq });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-id');
  await promise;
});

/* ------------------------------------------------------- 双端竞争 */

test('★ 双端竞争：桌面端先点 → QQ 那条按重复处理', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, 'c1');

  assert.equal(reg.resolveFromConsole({ id, allow: true }).ok, true);
  const qq = reg.resolveByQuote({ messageId: 'c1', convKey: ADMIN_DM, senderId: ADMIN, allow: false });
  assert.equal(qq.ok, false);
  assert.equal(qq.reason, 'duplicate');
  assert.equal(await promise, 'allow');
  assert.equal(reg.size, 0);
});

test('★ 双端竞争：QQ 先回 → 桌面端按钮再点也不生效', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, 'c2');

  assert.equal(reg.resolveByQuote({ messageId: 'c2', convKey: ADMIN_DM, senderId: ADMIN, allow: false }).ok, true);
  const console = reg.resolveFromConsole({ id, allow: true });
  assert.equal(console.ok, false);
  assert.equal(console.reason, 'duplicate');
  assert.equal(await promise, 'deny', '先到的拒绝不能被后来的同意改写');
});

test('★ 双端竞争：并发同时到 → 恰好一次生效', async () => {
  const { reg } = makeRegistry();
  /** @type {any[]} */
  const results = [];
  const { id, promise } = register(reg);
  reg.bindMessage(id, 'c3');

  // 模拟"同时"：同步连续调用，两者之间没有任何 await
  results.push(reg.resolveByQuote({ messageId: 'c3', convKey: ADMIN_DM, senderId: ADMIN, allow: true }));
  results.push(reg.resolveFromConsole({ id, allow: false }));
  results.push(reg.resolveByQuote({ messageId: 'c3', convKey: ADMIN_DM, senderId: ADMIN, allow: false }));

  assert.equal(results.filter((r) => r.ok).length, 1, '只能有一次结算生效');
  assert.equal(await promise, 'allow', '第一次（QQ 同意）生效');
});

/* ------------------------------------------------------------ 取消 */

test('★ 取消：cancelAll 把在册的按拒绝结算', async () => {
  const { reg } = makeRegistry();
  const a = register(reg);
  const b = register(reg);
  assert.equal(reg.cancelAll(SETTLE_REASON.SHUTDOWN), 2);
  assert.equal(await a.promise, 'deny');
  assert.equal(await b.promise, 'deny');
  assert.equal(reg.size, 0, '退出后不能还挂着一堆');
});

test('★ 取消之后不能用旧引用翻案', async () => {
  const { reg } = makeRegistry();
  const { id, promise } = register(reg);
  reg.bindMessage(id, 'z1');
  reg.cancelAll();

  const r = reg.resolveByQuote({ messageId: 'z1', convKey: ADMIN_DM, senderId: ADMIN, allow: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'duplicate');
  assert.equal(await promise, 'deny');
});

/* ------------------------------------------------------- 容量与清理 */

test('★ 容量上限：挂着太多时不再受理，直接给拒绝', async () => {
  const { reg } = makeRegistry({ maxEntries: 2 });
  register(reg);
  register(reg);
  const over = reg.register({
    tool: 'x',
    risk: 'R2',
    args: {},
    convKey: ADMIN_DM,
    replyConvKey: ADMIN_DM,
    allowedSenders: [ADMIN],
  });
  assert.equal(await over.promise, 'deny', '超限时明确拒绝，不能静默挂起');
  assert.equal(reg.size, 2);
});

test('★ 已结算的消息 ID 不会无限增长（墓碑有上限）', () => {
  const { reg } = makeRegistry({ maxMessages: 3 });
  for (let i = 0; i < 6; i += 1) {
    const { id } = register(reg);
    reg.bindMessage(id, `m${i}`);
    reg.resolveFromConsole({ id, allow: true });
  }
  assert.ok(reg.tombstones.size <= 3, `墓碑超限：${reg.tombstones.size}`);
});

test('★ 推送失败：markPushFailed 留痕，但请求仍然在册', () => {
  const { reg } = makeRegistry();
  const { id } = register(reg);
  reg.markPushFailed(id, 'E2030 发送过快');
  const item = reg.list().find((x) => x.id === id);
  assert.equal(item.pushError, 'E2030 发送过快', '界面要能看到"卡片没送出去"');
  assert.equal(item.quoted, false, '没绑 ID 时不能说自己可引用');
  assert.equal(reg.entries.has(id), true);
});

test('★ 绑定无效 messageId 必须失败（不能绑一个假 ID）', () => {
  const { reg } = makeRegistry();
  const { id } = register(reg);
  assert.equal(reg.bindMessage(id, null).ok, false);
  assert.equal(reg.bindMessage(id, '').ok, false);
  assert.equal(reg.bindMessage('confirm-not-exist', 1).ok, false);
  assert.equal(reg.entries.get(id).messageIds.size, 0);
});

test('★ 已结算的请求不能再绑消息 ID', () => {
  const { reg } = makeRegistry();
  const { id } = register(reg);
  reg.resolveFromConsole({ id, allow: true });
  const r = reg.bindMessage(id, 'late-1');
  assert.equal(r.ok, false);
});

/* ----------------------------------------------------------- 快照形状 */

test('★ 快照形状：list() 给出界面需要的字段', () => {
  const { reg, advance } = makeRegistry();
  const { id } = register(reg);
  reg.bindMessage(id, 's1');
  advance(15_000);

  const [item] = reg.list();
  assert.equal(item.id, id);
  assert.equal(item.tool, 'fs_write');
  assert.equal(item.risk, 'R2');
  assert.equal(item.replyConvKey, ADMIN_DM);
  assert.deepEqual(item.args, { path: 'a.txt' });
  assert.equal(item.timeoutMs, 60_000);
  assert.equal(item.leftMs, 45_000, '剩余时间是现算的');
  assert.equal(item.quoted, true);
});

test('★ list() 不泄漏定时器与 resolve 函数（快照要能 JSON 序列化）', () => {
  const { reg } = makeRegistry();
  register(reg);
  const [item] = reg.list();
  assert.equal('timer' in item, false);
  assert.equal('resolve' in item, false);
  assert.doesNotThrow(() => JSON.stringify(item));
});
