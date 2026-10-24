/**
 * 插件聊天能力（ctx.chat）—— 媒体句柄、跨会话拒绝、发送代理
 *
 * ## 测什么、不测什么
 *
 * 这个文件**不发任何 QQ 消息**：发送通道是注入的假实现，它只记录
 * "宿主真的让它发了什么"，然后返回一个 messageId。
 *
 * 这样测的才是关键部分：插件能拿到的**引用**（句柄）是不是受限的、
 * 归属校验是不是真的在拦、配额是不是真的生效。
 * "QQ 有没有收到"属于 e2e 的范畴，和接口契约无关。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MediaHandleRegistry, looksLikeHandle, publicView } from '../src/plugins/media-handles.mjs';
import {
  HostChatBridge,
  displayTextOf,
  pickMediaSegments,
  MAX_SENDS_PER_CALL,
  MAX_MEDIA_PER_MESSAGE,
  MAX_TEXT_CHARS,
  MAX_REGISTER_BYTES,
} from '../src/plugins/chat-bridge.mjs';
import { createChatFactory } from '../src/plugins/host-chat.mjs';
import { createSequencer } from '../src/reply/send.mjs';

const GROUP_A = 'group:1001';
const GROUP_B = 'group:2002';
const PRIVATE_A = 'private:3003';

/**
 * 造一个假世界：两个群、一个私聊，各有几条消息（其中带图片段）。
 *
 * 会话数据是**宿主侧**的：bridge 通过注入的 read/lookup 访问它，
 * 插件永远拿不到这个对象。
 */
function makeWorld() {
  /** @type {Map<string, any[]>} */
  const conversations = new Map();

  const push = (convKey, msg) => {
    const list = conversations.get(convKey) ?? [];
    list.push(msg);
    conversations.set(convKey, list);
  };

  push(GROUP_A, {
    messageId: 'a-1',
    convKey: GROUP_A,
    text: '看看这个图',
    segments: [
      { type: 'text', data: { text: '看看这个图' } },
      { type: 'image', data: { file: 'https://example.invalid/a.png', name: 'a.png', bytes: 1024 } },
    ],
    sender: { userId: '1001', nickname: '甲' },
    time: 1700000000,
  });
  push(GROUP_A, {
    messageId: 'a-2',
    convKey: GROUP_A,
    text: '第二张',
    segments: [
      { type: 'image', data: { file: 'https://example.invalid/b.jpg', name: 'b.jpg' } },
      { type: 'image', data: { file: 'https://example.invalid/c.jpg', name: 'c.jpg' } },
    ],
    sender: { userId: '1001', nickname: '甲' },
    time: 1700000010,
  });
  push(GROUP_B, {
    // 同样的 id 形状，但在**另一个群**里：跨会话必须被拒
    messageId: 'b-1',
    convKey: GROUP_B,
    text: '别的群',
    segments: [{ type: 'image', data: { file: 'https://example.invalid/secret.png', name: 'secret.png' } }],
    sender: { userId: '2002', nickname: '乙' },
    time: 1700000020,
  });
  push(PRIVATE_A, {
    messageId: 'p-1',
    convKey: PRIVATE_A,
    text: '私聊',
    segments: [],
    sender: { userId: '3003', nickname: '丙' },
    time: 1700000030,
  });
  // 群里一条**纯文本**消息：用来验证"没有媒体时返回空数组而不是报错"
  push(GROUP_A, {
    messageId: 'a-3',
    convKey: GROUP_A,
    text: '纯文字',
    segments: [{ type: 'text', data: { text: '纯文字' } }],
    sender: { userId: '1001', nickname: '甲' },
    time: 1700000040,
  });

  /** 假发送通道：记录宿主真的被要求发了什么 */
  /** @type {any[]} */
  const sent = [];

  const factory = createChatFactory({
    readMessages: ({ convKey, limit }) => {
      const list = conversations.get(convKey) ?? [];
      return {
        ok: true,
        messages: list.slice(-limit).map((m) => ({
          messageId: m.messageId,
          sender: m.sender,
          text: m.text,
          at: m.time * 1000,
        })),
      };
    },
    lookupMessage: ({ convKey, messageId }) => {
      const list = conversations.get(convKey) ?? [];
      const hit = list.find((m) => String(m.messageId) === String(messageId));
      // 注意：这里**只**在指定会话里找。跨会话的 id 一律找不到。
      if (!hit) return { ok: false, code: 'E4074', message: '不在当前会话' };
      return { ok: true, event: hit };
    },
    sendSegments: async ({ convKey, segments, auditText, signal }) => {
      if (signal?.aborted) return { ok: false, code: 'E4070', message: '调用已取消' };
      sent.push({ convKey, segments, auditText });
      return { ok: true, messageId: `sent-${sent.length}` };
    },
    media: { now: () => 1_700_000_000_000 },
  });

  /**
   * 造一次调用的 ctx.chat。
   *
   * @param {{convKey?: string, pluginId?: string, dataDir?: string, signal?: AbortSignal}} [over]
   */
  const chatFor = (over = {}) => {
    const convKey = over.convKey ?? GROUP_A;
    return factory.makeChat({
      pluginId: over.pluginId ?? 'echo',
      invocation: { convKey, origin: 'group', tool: 'plugin_echo' },
      dataDir: over.dataDir,
      signal: over.signal,
    });
  };

  return { conversations, sent, factory, chatFor, chat: chatFor() };
}

/* ================================================================ 句柄 */

test('句柄：形状不可推断，且公开视图不含真实来源', () => {
  const reg = new MediaHandleRegistry({ now: () => 1_000_000 });
  const view = reg.register({
    pluginId: 'echo',
    convKey: GROUP_A,
    kind: 'image',
    name: 'a.png',
    bytes: 10,
    source: { segment: { type: 'image', data: { file: 'C:\\secret\\a.png' } } },
  });

  assert.equal(looksLikeHandle(view.handle), true);
  assert.match(view.handle, /^media_[A-Za-z0-9_-]{16,64}$/);
  assert.equal(view.name, 'a.png');
  assert.equal(view.kind, 'image');

  /*
   * 公开视图**不能**带出 source / 路径 / URL。
   * 这条是"不给插件任意路径"的落点：只要有一个字段漏出去，
   * 插件（和它背后的模型）就能拿到真实位置。
   */
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('secret'), false, '公开视图泄露了真实路径');
  assert.equal('source' in view, false);
  assert.deepEqual(Object.keys(publicView({ handle: 'h', kind: 'image', name: '', mime: '', bytes: 0, expiresAt: 0 })).sort(), [
    'bytes',
    'expiresAt',
    'handle',
    'kind',
    'mime',
    'name',
  ]);
});

test('★ 句柄：绑定插件与会话，越权一律拒绝', () => {
  const reg = new MediaHandleRegistry({ now: () => 1_000_000 });
  const view = reg.register({
    pluginId: 'echo',
    convKey: GROUP_A,
    kind: 'image',
    source: { segment: { type: 'image', data: {} } },
  });

  // 同一个插件 + 同一个会话：可以
  assert.equal(reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: view.handle }).ok, true);

  // 别的插件：拒（E4074）
  const otherPlugin = reg.resolve({ pluginId: 'image-gen', convKey: GROUP_A, handle: view.handle });
  assert.equal(otherPlugin.ok, false);
  assert.equal(otherPlugin.code, 'E4074');

  // 别的会话：拒（E4074）
  const otherConv = reg.resolve({ pluginId: 'echo', convKey: GROUP_B, handle: view.handle });
  assert.equal(otherConv.ok, false);
  assert.equal(otherConv.code, 'E4074');

  // 伪造句柄：拒（E4073，形状不对 / 不存在）
  assert.equal(reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: 'media_AAAAAAAAAAAAAAAA' }).ok, false);
  assert.equal(reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: 'C:\\secret\\a.png' }).code, 'E4073');
});

test('★ 句柄：过期即失效（不降级成路径）', () => {
  let now = 1_000_000;
  const reg = new MediaHandleRegistry({ ttlMs: 1000, now: () => now });
  const view = reg.register({
    pluginId: 'echo',
    convKey: GROUP_A,
    kind: 'image',
    source: { segment: { type: 'image', data: {} } },
  });
  assert.equal(reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: view.handle }).ok, true);

  now += 1001;
  const expired = reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: view.handle });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'E4073');
  assert.match(expired.message, /过期/);
});

test('句柄：单插件上限会淘汰最旧的，而不是抛错', () => {
  let now = 1_000_000;
  const reg = new MediaHandleRegistry({ maxPerPlugin: 3, now: () => now });
  const handles = [];
  for (let i = 0; i < 5; i += 1) {
    now += 1;
    handles.push(
      reg.register({ pluginId: 'echo', convKey: GROUP_A, kind: 'image', source: { segment: { type: 'image', data: {} } } })
        .handle,
    );
  }
  assert.equal(reg.size(), 3);
  // 最早的被淘汰
  assert.equal(reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: handles[0] }).ok, false);
  assert.equal(reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: handles[4] }).ok, true);
});

test('句柄：停用插件会清掉它的全部句柄', () => {
  const reg = new MediaHandleRegistry();
  const a = reg.register({ pluginId: 'echo', convKey: GROUP_A, kind: 'image', source: { segment: { type: 'image', data: {} } } });
  const b = reg.register({ pluginId: 'other', convKey: GROUP_A, kind: 'image', source: { segment: { type: 'image', data: {} } } });
  assert.equal(reg.forgetPlugin('echo'), 1);
  assert.equal(reg.resolve({ pluginId: 'echo', convKey: GROUP_A, handle: a.handle }).ok, false);
  assert.equal(reg.resolve({ pluginId: 'other', convKey: GROUP_A, handle: b.handle }).ok, true);
});

/* ================================================================ 读取 */

test('chat.recent：只读当前会话，且返回结构里没有本机路径', () => {
  const w = makeWorld();
  const r = w.chat.recent({ limit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.convKey, GROUP_A);
  assert.equal(r.messages.length, 3);
  assert.equal(r.messages[0].messageId, 'a-1');
  assert.equal(r.messages[0].sender.id, '1001');
  assert.equal(r.messages[0].sender.nickname, '甲');
  // 不能带出 segments（里面含真实 file 字段）
  assert.equal(JSON.stringify(r).includes('example.invalid'), false);
  // 也不能带出别的会话（GROUP_B 那条也在假世界里）
  assert.equal(r.messages.some((m) => m.messageId === 'b-1'), false);
});

test('chat.recent：limit 被夹在 1–50', () => {
  const w = makeWorld();
  assert.equal(w.chat.recent({ limit: 0 }).messages.length, 1, 'limit 下限是 1');
  assert.equal(w.chat.recent({ limit: 9999 }).messages.length, 3, 'limit 上限 50，这里只有 3 条');
  // 非法 limit 退回默认 10，而不是抛错或返回空
  assert.equal(w.chat.recent({ limit: 'x' }).messages.length, 3);
});

test('★ chat.message：跨会话的消息 id 一律 E4074', () => {
  const w = makeWorld();
  // 自己的
  const mine = w.chat.message({ messageId: 'a-1' });
  assert.equal(mine.ok, true);
  assert.equal(mine.message.messageId, 'a-1');
  // 别的群：即使 id 存在也必须拒
  const other = w.chat.message({ messageId: 'b-1' });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'E4074');
});

test('★ chat.mediaList：只返回句柄，跨会话被拒', () => {
  const w = makeWorld();
  const r = w.chat.mediaList({ messageId: 'a-1' });
  assert.equal(r.ok, true);
  assert.equal(r.handles.length, 1);
  assert.equal(r.handles[0].kind, 'image');
  assert.equal(r.handles[0].name, 'a.png');
  assert.equal(looksLikeHandle(r.handles[0].handle), true);
  // 关键：不能出现真实 URL
  assert.equal(JSON.stringify(r).includes('example.invalid'), false);

  const other = w.chat.mediaList({ messageId: 'b-1' });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'E4074');

  // 没有媒体的消息（当前会话里的纯文本）：空数组，不是报错
  assert.deepEqual(w.chat.mediaList({ messageId: 'a-3' }), { ok: true, handles: [] });

  // 别的会话里的纯文本消息：仍然要报归属错误（不能因为"反正没媒体"就放行）
  const crossConv = w.chat.mediaList({ messageId: 'p-1' });
  assert.equal(crossConv.ok, false);
  assert.equal(crossConv.code, 'E4074');
});

test('chat.mediaList：一条消息最多登记 4 个媒体', () => {
  const w = makeWorld();
  // 造一条带 6 张图的消息
  w.conversations.set(GROUP_A, [
    ...(w.conversations.get(GROUP_A) ?? []),
    {
      messageId: 'many',
      convKey: GROUP_A,
      text: '',
      segments: Array.from({ length: 6 }, (_, i) => ({
        type: 'image',
        data: { file: `https://example.invalid/${i}.png`, name: `${i}.png` },
      })),
      sender: { userId: '1001', nickname: '甲' },
      time: 1700000100,
    },
  ]);
  const r = w.chat.mediaList({ messageId: 'many' });
  assert.equal(r.ok, true);
  assert.equal(r.handles.length, MAX_MEDIA_PER_MESSAGE);
});

/* ================================================================ 发送 */

test('★ chat.send：走宿主发送通道，且不暴露 QQ API', async () => {
  const w = makeWorld();
  const r = await w.chat.send({ text: '你好' });
  assert.equal(r.ok, true);
  assert.match(r.messageId, /^sent-/);

  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].convKey, GROUP_A, '只能发到当前会话');
  assert.equal(w.sent[0].auditText, '你好', '审计文本就是正文');
  assert.deepEqual(
    w.sent[0].segments.map((s) => s.type),
    ['text'],
  );
});

test('★ chat.send：文本为空/超长被拒（E4073）', async () => {
  const w = makeWorld();
  assert.equal((await w.chat.send({ text: '   ' })).code, 'E4073');
  assert.equal((await w.chat.send({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) })).code, 'E4073');
  assert.equal(w.sent.length, 0, '被拒的内容不能真的发出去');
});

test('★ chat.send：单次调用最多 3 条（配额）', async () => {
  const w = makeWorld();
  for (let i = 0; i < MAX_SENDS_PER_CALL; i += 1) {
    assert.equal((await w.chat.send({ text: `第 ${i} 条` })).ok, true);
  }
  const over = await w.chat.send({ text: '第四条' });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'E4073');
  assert.match(over.message, /最多发 3 条/);
  assert.equal(w.sent.length, MAX_SENDS_PER_CALL, '超限的那条不能发出去');

  // 配额是"每次调用一份"：新的调用重新计数
  const fresh = w.chatFor();
  assert.equal((await fresh.send({ text: '新调用' })).ok, true);
});

test('★ chat.send：引用必须属于当前会话（E4074）', async () => {
  const w = makeWorld();
  const ok = await w.chat.send({ text: '回你', quote: 'a-1' });
  assert.equal(ok.ok, true);
  // 第一个段是 reply
  assert.equal(w.sent[0].segments[0].type, 'reply');
  assert.equal(w.sent[0].segments[0].data.id, 'a-1');

  const bad = await w.chatFor().send({ text: '跨群引用', quote: 'b-1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E4074');
  assert.equal(w.sent.length, 1, '被拒的引用不能发出去');
});

test('★ chat.sendMedia：用句柄发，一条消息最多 4 个', async () => {
  const w = makeWorld();
  const list = w.chat.mediaList({ messageId: 'a-1' });
  const r = await w.chat.sendMedia({ handles: [list.handles[0].handle] });
  assert.equal(r.ok, true);
  assert.equal(w.sent.length, 1);
  const img = w.sent[0].segments.find((s) => s.type === 'image');
  assert.ok(img, '必须真的拼出 image 段');
  assert.equal(img.data.file, 'https://example.invalid/a.png');

  // 五个以上句柄 → 拒（一条消息最多 4 个媒体）
  w.conversations.set(GROUP_A, [
    ...(w.conversations.get(GROUP_A) ?? []),
    {
      messageId: 'six',
      convKey: GROUP_A,
      text: '',
      segments: Array.from({ length: 6 }, (_, i) => ({
        type: 'image',
        data: { file: `https://example.invalid/${i}.png` },
      })),
      sender: { userId: '1001', nickname: '甲' },
      time: 1,
    },
  ]);
  const six = w.chat.mediaList({ messageId: 'six' });
  assert.equal(six.handles.length, MAX_MEDIA_PER_MESSAGE, 'mediaList 本身也只登记 4 个');

  /*
   * sendMedia 的 5 个句柄上限要**另外**验证：mediaList 已经截断到 4 个，
   * 拿它去测 sendMedia 永远测不到那条分支。直接拿两个消息的句柄凑够 5 个。
   */
  const more = w.chat.mediaList({ messageId: 'a-2' });
  const five = [...six.handles.map((h) => h.handle), more.handles[0].handle];
  assert.equal(five.length, 5);
  const over = await w.chatFor().sendMedia({ handles: five });
  assert.equal(over.code, 'E4073');
  assert.match(over.message, /最多 4 个媒体/);
});

test('★ chat.sendMedia：跨会话句柄被拒，且不发出去', async () => {
  const w = makeWorld();
  const handle = w.chat.mediaList({ messageId: 'a-1' }).handles[0].handle;

  // 同一个插件，但换到另一个群去发
  const other = w.chatFor({ convKey: GROUP_B });
  const r = await other.sendMedia({ handles: [handle] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4074');
  assert.equal(w.sent.length, 0);
});

test('★ chat：闸门拒绝原样返回 code（不抛异常）', async () => {
  /** @type {any[]} */
  const sent = [];
  const factory = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: false, code: 'E2020', message: '消息含本机路径或凭据特征，已拦截不发' }),
    media: {},
  });
  const chat = factory.makeChat({
    pluginId: 'echo',
    invocation: { convKey: GROUP_A },
    signal: new AbortController().signal,
  });

  const r = await chat.send({ text: 'C:\\secret\\a.txt' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E2020');
  assert.match(r.message, /拦截/);
  assert.equal(sent.length, 0);
});

/* ================================================================ 取消 */

test('★ chat：取消后所有方法返回 E4070，不再发消息', async () => {
  const w = makeWorld();
  const controller = new AbortController();
  const chat = w.chatFor({ signal: controller.signal });

  assert.equal((await chat.send({ text: '取消前' })).ok, true);
  controller.abort();

  assert.equal((await chat.send({ text: '取消后' })).code, 'E4070');
  assert.equal(chat.recent({}).code, 'E4070');
  assert.equal(chat.message({ messageId: 'a-1' }).code, 'E4070');
  assert.equal((await chat.sendMedia({ handles: ['media_aaaaaaaaaaaaaaaa'] })).code, 'E4070');
  assert.equal(w.sent.length, 1, '取消之后不能再发出任何消息');
});

/* ================================================================ registerMedia */

test('★ chat.registerMedia：只允许自己 dataDir 内的文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-media-'));
  const dataDir = path.join(root, 'plugin-data', 'image-gen');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'out.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

  // 目录外的文件（用来验证越界）
  const outside = path.join(root, 'secret.txt');
  await fs.writeFile(outside, 'top secret');

  const w = makeWorld();
  const chat = w.chatFor({ pluginId: 'image-gen', dataDir });

  // 正常：写在自己 dataDir 里
  const ok = await chat.registerMedia({ path: 'out.png', kind: 'image', name: '生成结果.png' });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(looksLikeHandle(ok.handle), true);
  assert.equal(ok.name, '生成结果.png');

  // 真的能发出去
  const sentRes = await chat.sendMedia({ handles: [ok.handle] });
  assert.equal(sentRes.ok, true, sentRes.message);

  // 越界：相对路径穿越
  const escape = await chat.registerMedia({ path: '../secret.txt' });
  assert.equal(escape.code, 'E4075');

  // 越界：绝对路径
  const abs = await chat.registerMedia({ path: outside });
  assert.equal(abs.code, 'E4075');

  await fs.rm(root, { recursive: true, force: true });
});

test('★ chat.registerMedia：符号链接指向外部一律拒绝', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-link-'));
  const dataDir = path.join(root, 'plugin-data', 'image-gen');
  await fs.mkdir(dataDir, { recursive: true });
  const outside = path.join(root, 'outside.png');
  await fs.writeFile(outside, Buffer.from('89504e470d0a1a0a', 'hex'));

  const link = path.join(dataDir, 'link.png');
  let linked = false;
  try {
    await fs.symlink(outside, link);
    linked = true;
  } catch {
    // Windows 上非管理员可能建不了符号链接：跳过这条断言（不是失败）
  }

  if (linked) {
    const w = makeWorld();
    const chat = w.chatFor({ pluginId: 'image-gen', dataDir });
    const r = await chat.registerMedia({ path: 'link.png' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E4075');
  }

  await fs.rm(root, { recursive: true, force: true });
});

test('★ chat.registerMedia：不支持的媒体类型与超大文件被拒', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-size-'));
  const dataDir = path.join(root, 'plugin-data', 'image-gen');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'x.png'), 'x');

  const w = makeWorld();
  const chat = w.chatFor({ pluginId: 'image-gen', dataDir });

  assert.equal((await chat.registerMedia({ path: 'x.png', kind: 'exe' })).code, 'E4073');
  assert.equal((await chat.registerMedia({ path: '' })).code, 'E4073');
  assert.equal((await chat.registerMedia({ path: 'missing.png' })).code, 'E4073');

  // 超过 10MB 的文件
  const big = path.join(dataDir, 'big.png');
  await fs.writeFile(big, Buffer.alloc(MAX_REGISTER_BYTES + 1));
  const r = await chat.registerMedia({ path: 'big.png' });
  assert.equal(r.code, 'E4073');
  assert.match(r.message, /太大/);

  await fs.rm(root, { recursive: true, force: true });
});

/* ================================================================ 边界 */

test('chat：会话键非法时所有方法返回 E4074（而不是去读空会话）', async () => {
  /** @type {any[]} */
  const calls = [];
  const factory = createChatFactory({
    readMessages: (i) => {
      calls.push(i);
      return { ok: true, messages: [] };
    },
    lookupMessage: (i) => {
      calls.push(i);
      return { ok: false };
    },
    sendSegments: async (i) => {
      calls.push(i);
      return { ok: true };
    },
    media: {},
  });

  const chat = factory.makeChat({ pluginId: 'echo', invocation: { convKey: 'evil:1' } });
  assert.equal(chat.recent({}).code, 'E4074');
  assert.equal(chat.message({ messageId: 'x' }).code, 'E4074');
  await chat.send({ text: 'hi' });
  assert.equal(calls.length, 0, '非法会话键不该落到真实的读取/发送实现上');
});

test('chat：没有会话上下文时明确报 E4072（不是半残对象）', async () => {
  const factory = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
    media: {},
  });
  const chat = factory.makeChat({ pluginId: 'echo', invocation: {} });
  const r = chat.recent({});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4072');
});

test('pickMediaSegments：只挑媒体段，忽略文本/at/reply', () => {
  const segs = [
    { type: 'text', data: { text: 'hi' } },
    { type: 'at', data: { qq: '1' } },
    { type: 'image', data: { file: 'x.png' } },
    { type: 'reply', data: { id: 'm' } },
    { type: 'record', data: { file: 'y.amr' } },
  ];
  const picked = pickMediaSegments(segs);
  assert.deepEqual(picked.map((p) => p.type), ['image', 'record']);
  assert.deepEqual(picked.map((p) => p.index), [2, 4]);
});

test('HostChatBridge：宿主未注入 lookups 时不会崩（E4072）', async () => {
  const media = new MediaHandleRegistry();
  const bridge = new HostChatBridge({
    media,
    readMessages: () => ({ ok: false, code: 'E4072', message: '没有能力' }),
    lookupMessage: () => ({ ok: false, code: 'E4072', message: '没有能力' }),
    sendSegments: async () => ({ ok: false, code: 'E4072', message: '没有能力' }),
  });
  const chat = bridge.forCall({ pluginId: 'echo', convKey: GROUP_A });
  assert.equal(chat.recent({}).code, 'E4072');
  assert.equal((await chat.send({ text: 'x' })).code, 'E4072');
});

/* ==================================================== 串行器（跨功能 A） */

/**
 * 造一个"可观测"的串行器：它串行化同一个 key，并把实际执行顺序记下来。
 *
 * 用真的 `createSequencer` 而不是自己的假实现：要验的正是"它被用上了"，
 * 换成假实现就等于只测假实现。
 */
function makeSequencer() {
  const seq = createSequencer();
  /** @type {string[]} */
  const order = [];
  return {
    order,
    run: (key, fn) => seq.run(key, async () => {
      order.push(`start:${key}`);
      const r = await fn();
      order.push(`end:${key}`);
      return r;
    }),
  };
}

test('★ chat.sendMedia 必须进 per-会话串行器：不会插进正在发的分条中间', async () => {
  /*
   * 场景（docs/plugin-api.md §5.3.1 与 reply-split-protocol §5 的不变量）：
   * AI 的一次分条回复正在发出（第一条已经出去了，第二条在等 800ms），
   * 这时插件的工具调用 `ctx.chat.sendMedia` 到达。它**必须**排在这次
   * burst 后面，而不是插到两条之间 —— 否则用户看到"第一句 → 图 → 第二句"。
   *
   * 修复前的行为：`sendOnce` 直接 await `sendSegments`，不走队列，
   * 于是这张图在第二条文本之前就发出去了（下面的 order 会立刻暴露）。
   */
  const w = makeWorld();
  const seq = makeSequencer();

  /** @type {string[]} */
  const delivered = [];
  const factory = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: ({ convKey, messageId }) => {
      const hit = (w.conversations.get(convKey) ?? []).find((m) => String(m.messageId) === String(messageId));
      return hit ? { ok: true, event: hit } : { ok: false };
    },
    sendSegments: async ({ segments }) => {
      delivered.push(segments.map((s) => s.type).join('+'));
      // 模拟"发送本身要花一点时间"
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, messageId: `m-${delivered.length}` };
    },
    sequencer: seq,
    media: {},
  });
  const chat = factory.makeChat({ pluginId: 'echo', invocation: { convKey: GROUP_A }, signal: new AbortController().signal });

  const handle = chat.mediaList({ messageId: 'a-1' }).handles[0].handle;

  /*
   * 模拟 AI 的一次 burst：这一整段占住队列（内部发两条文本）。
   * 插件调用在它进行中被发起。
   */
  const burst = seq.run(GROUP_A, async () => {
    delivered.push('burst:1');
    await new Promise((r) => setTimeout(r, 20));
    delivered.push('burst:2');
  });

  const pluginSend = chat.sendMedia({ handles: [handle] });
  await Promise.all([burst, pluginSend]);

  assert.deepEqual(
    delivered,
    ['burst:1', 'burst:2', 'image'],
    '插件发送必须排在整段 burst 之后（修复前会插在 burst:1 与 burst:2 之间）',
  );
});

test('★ chat.send 也走串行器；引用非法时在**入队前**就被拒（不占队列）', async () => {
  const seq = makeSequencer();
  /** @type {any[]} */
  const sent = [];
  const factory = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }), // 任何 id 都属于"别的会话"
    sendSegments: async (input) => {
      sent.push(input);
      return { ok: true, messageId: 'm-1' };
    },
    sequencer: seq,
    media: {},
  });
  const chat = factory.makeChat({ pluginId: 'echo', invocation: { convKey: GROUP_A }, signal: new AbortController().signal });

  // 引用不属于当前会话 → E4074，且**一个字节都没发**、队列也没被占用
  const bad = await chat.send({ text: 'hi', quote: 'm-elsewhere' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E4074');
  assert.equal(sent.length, 0);
  assert.deepEqual(seq.order, [], '引用校验必须在入队之前完成，非法引用不该占队列');

  // 正常发送：确实进了队列
  const ok = await chat.send({ text: 'hi' });
  assert.equal(ok.ok, true);
  assert.deepEqual(seq.order, [`start:${GROUP_A}`, `end:${GROUP_A}`]);
});

/* ================================================ 上下文记账（跨功能 B） */

test('★ 插件发出去的东西要写进模型上下文：onSent 带上可读文本', async () => {
  /*
   * 没有这条记账时，模型下一轮完全不知道自己用工具发过 —— 于是它会把
   * 同一件事再做一遍（重复发图/重复说话）。
   *
   * 文本要"人能读"：文字段原样，媒体段换成 `[图片]` 这类占位。
   * 绝不能把本机路径带进上下文。
   */
  /** @type {any[]} */
  const events = [];
  const factory = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: ({ convKey, messageId }) =>
      String(messageId) === 'a-1' && convKey === GROUP_A
        ? {
            ok: true,
            event: {
              messageId: 'a-1',
              convKey: GROUP_A,
              segments: [
                { type: 'text', data: { text: '看图' } },
                { type: 'image', data: { file: 'https://example.invalid/a.png', name: 'a.png' } },
              ],
            },
          }
        : { ok: false },
    sendSegments: async ({ segments }) => {
      assert.ok(segments.length > 0);
      return { ok: true, messageId: 'sent-1' };
    },
    onSent: (input) => events.push(input),
    media: {},
  });
  const chat = factory.makeChat({
    pluginId: 'echo',
    invocation: { convKey: GROUP_A },
    dataDir: undefined,
    signal: new AbortController().signal,
  });

  const text = await chat.send({ text: '看一下这张图' });
  assert.equal(text.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].convKey, GROUP_A);
  assert.equal(events[0].messageId, 'sent-1');
  assert.equal(events[0].text, '看一下这张图');

  // 媒体：上下文里只留占位，不留路径
  const view = chat.mediaList({ messageId: 'a-1' });
  const sentMedia = await chat.sendMedia({ handles: [view.handles[0].handle] });
  assert.equal(sentMedia.ok, true, sentMedia.message);
  assert.equal(events.length, 2);
  assert.equal(events[1].text.includes('https://example.invalid'), false, '上下文里不能有真实地址');
  assert.equal(events[1].text, '[图片]');
});

test('onSent：被闸门拒绝 / 被取消时不该记账（否则模型以为发出去了）', async () => {
  /** @type {any[]} */
  const events = [];
  const factory = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: false, code: 'E2030', message: '限流' }),
    onSent: (input) => events.push(input),
    media: {},
  });
  const chat = factory.makeChat({ pluginId: 'echo', invocation: { convKey: GROUP_A } });
  const r = await chat.send({ text: 'hi' });
  assert.equal(r.code, 'E2030');
  assert.equal(events.length, 0, '没发出去就不能记账');
});

test('onSent 抛错不影响已经成功的发送', async () => {
  const factory = createChatFactory({
    readMessages: () => ({ ok: true, messages: [] }),
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true, messageId: 'm' }),
    onSent: () => {
      throw new Error('记账炸了');
    },
    media: {},
  });
  const chat = factory.makeChat({ pluginId: 'echo', invocation: { convKey: GROUP_A } });
  const r = await chat.send({ text: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 'm');
});

test('displayTextOf：引用段不进上下文，媒体段用中文占位', () => {
  assert.equal(
    displayTextOf([
      { type: 'reply', data: { id: 'm0' } },
      { type: 'text', data: { text: '给你' } },
      { type: 'image', data: { file: 'C:\\secret\\a.png' } },
      { type: 'video', data: { file: 'C:\\secret\\b.mp4' } },
    ]),
    '给你 [图片] [视频]',
  );
});
