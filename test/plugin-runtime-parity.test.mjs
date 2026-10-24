/**
 * 运行时一致性 —— `process` 与 `in-process` 必须提供同一套新能力
 *
 * ## 为什么这条必须单独测
 *
 * `ctx.caller` 与 `ctx.chat` 在两端的实现路径完全不同：
 *
 *   · in-process：宿主直接调用插件，ctx 对象在同一个进程里造出来；
 *   · process：宿主把 invocation 随 `call` 下发给子进程，子进程的
 *     `ctx.chat.*` 只是一层代理，真正执行回到父进程（host-call）。
 *
 * 两条路很容易长出不一样的行为 —— 比如子进程能自己伪造上下文、
 * 或者代理方法的参数形状和宿主不一致。而"某个运行时的插件行为不同"
 * 是最难排查的一类问题：同一个插件包，装在不同 runtime 上表现不一样。
 *
 * ## 怎么测（不 fork 子进程）
 *
 * 本文件直接驱动两端的**运行时类**：
 *
 *   · in-process：真的 import 一个临时插件文件，调 callTool；
 *   · process：用一个假的 `child`（stdin 写出去的东西被我们截获），
 *     把子进程该发的协议消息喂回去。
 *
 * 这样既能验证协议形状（invocation 下发、cancel、host-call 往返），
 * 又不需要真的 spawn —— 沙箱里 spawn 会被拒（EPERM），而那是环境限制，
 * 不该让契约测试跟着红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { InProcessRuntime, combineSignals, unavailableChat } from '../src/plugins/runtime-inprocess.mjs';
import { ProcessRuntime } from '../src/plugins/runtime-process.mjs';
import { createChatFactory } from '../src/plugins/host-chat.mjs';
import { createGatewayFactory, unavailableGateway } from '../src/plugins/gateway-bridge.mjs';
import { deriveToolPolicy } from '../src/plugins/manifest.mjs';
import { freezeCaller } from '../src/plugins/caller.mjs';
import { buildCallContext } from '../src/plugins/child-runner.mjs';
import { UNKNOWN_GATEWAY_VISION } from '../src/plugins/gateway-vision.mjs';

const GROUP_A = 'group:1001';

/**
 * 一份最小清单（运行时需要 tools / entry 等字段）。
 *
 * @param {object} [over]
 */
function manifest(over = {}) {
  return {
    id: 'demo',
    name: '演示',
    version: '1.0.0',
    entry: 'index.mjs',
    runtime: 'in-process',
    trusted: true,
    handleMessage: false,
    tools: [
      {
        name: 'probe',
        fullName: 'plugin_probe',
        description: '探测上下文',
        needs: 'qq',
        risk: 'R0',
        effectiveRisk: 'R0',
        effects: [],
        timeoutMs: 5000,
        params: { text: { type: 'string' } },
      },
    ],
    ...over,
  };
}

/** 造一个宿主侧聊天工厂（只读空会话，发送记录下来） */
function makeChatHost() {
  /** @type {any[]} */
  const sent = [];
  const factory = createChatFactory({
    readMessages: ({ convKey, limit }) => ({
      ok: true,
      messages: [{ messageId: 'm-1', sender: { userId: '1', nickname: '甲' }, text: `${convKey}/${limit}` }],
    }),
    lookupMessage: ({ convKey, messageId }) =>
      String(messageId) === 'm-1' ? { ok: true, event: { messageId: 'm-1', convKey, segments: [] } } : { ok: false },
    sendSegments: async ({ convKey, segments, auditText }) => {
      sent.push({ convKey, segments, auditText });
      return { ok: true, messageId: `sent-${sent.length}` };
    },
    media: {},
  });
  return { factory, sent };
}

/* ================================================================ 信号组合 */

test('combineSignals：任一源 abort 即 abort，且不泄漏监听器', () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = combineSignals([a.signal, b.signal]);
  assert.equal(combined.aborted, false);

  a.abort();
  assert.equal(combined.aborted, true);

  // 只有一个源时直接用它的 signal（不额外造对象）
  const single = combineSignals([b.signal]);
  assert.equal(single, b.signal);

  // 空输入：返回一个永不 abort 的 signal，而不是 undefined
  const none = combineSignals([]);
  assert.equal(typeof none.aborted, 'boolean');
});

test('combineSignals：已 abort 的源立刻反映到结果上', () => {
  const a = new AbortController();
  a.abort();
  const combined = combineSignals([a.signal, new AbortController().signal]);
  assert.equal(combined.aborted, true);
});

/* ================================================================ in-process */

test('★ in-process：callTool 拿到 caller 与 chat，并发调用互不串会话', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-rt-ip-'));
  const dir = path.join(root, 'demo');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  /*
   * 插件把"它以为的会话"原样返回。
   *
   * 两次调用**并发**（不 await 第一个就发第二个）：如果 ctx 被复用，
   * 后一次会覆盖前一次，返回的两个 convKey 就会相同 —— 那正是
   * "图发到别的群"这类事故的形态。
   */
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default {
      async init() { return { ok: true }; },
      async callTool({ tool, ctx, signal }) {
        const recent = ctx.chat.recent({ limit: 1 });
        await new Promise((r) => setTimeout(r, 5));
        return {
          tool,
          convKey: ctx.caller?.convKey ?? null,
          origin: ctx.caller?.origin ?? null,
          requester: ctx.caller?.requester ?? null,
          callId: ctx.caller?.callId ?? null,
          recentOk: recent.ok,
          aborted: signal?.aborted ?? null,
        };
      },
      async dispose() {},
    };`,
  );

  const { factory } = makeChatHost();
  const rt = new InProcessRuntime({
    manifest: manifest(),
    dir,
    dataDir,
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
    makeChat: (input) => factory.makeChat(input),
  });

  const init = await rt.init();
  assert.equal(init.ok, true, init.message);

  const [a, b] = await Promise.all([
    rt.callTool({
      tool: 'probe',
      args: {},
      timeoutMs: 2000,
      invocation: { convKey: 'group:111', origin: 'owner-private', callId: 'c1', requester: { id: '1', nickname: 'A' } },
    }),
    rt.callTool({
      tool: 'probe',
      args: {},
      timeoutMs: 2000,
      invocation: { convKey: 'group:222', origin: 'group', callId: 'c2', requester: { id: '2', nickname: 'B' } },
    }),
  ]);

  assert.equal(a.ok, true, a.message);
  assert.equal(b.ok, true, b.message);
  assert.equal(a.value.convKey, 'group:111');
  assert.equal(b.value.convKey, 'group:222', '并发调用绝对不能串会话');
  assert.equal(a.value.origin, 'owner-private');
  assert.equal(b.value.origin, 'group');
  assert.equal(a.value.callId, 'c1');
  assert.equal(b.value.callId, 'c2');
  assert.deepEqual(a.value.requester, { id: '1', nickname: 'A' });
  assert.equal(a.value.recentOk, true);

  await rt.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test('★ in-process：没有 invocation 时 caller 为 null（不伪造一个）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-rt-noinv-'));
  const dir = path.join(root, 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default {
      async callTool({ ctx }) {
        return { caller: ctx.caller, chatRecent: ctx.chat.recent({}) };
      },
    };`,
  );

  const rt = new InProcessRuntime({
    manifest: manifest(),
    dir,
    dataDir: path.join(root, 'data'),
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
    // 故意不注入 makeChat：验证"宿主没提供"时的行为
  });
  await rt.init();
  const r = await rt.callTool({ tool: 'probe', args: {}, timeoutMs: 2000 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.value.caller, null, '没有可信上下文时必须是 null，不能编一个');
  // 没注入聊天能力 → 明确 E4072，而不是抛 TypeError
  assert.equal(r.value.chatRecent.code, 'E4072');

  await rt.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test('★ in-process：取消信号让 callTool 立刻返回 E4070（不等插件跑完）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-rt-cancel-'));
  const dir = path.join(root, 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default {
      async callTool() {
        // 一个不检查 signal 的笨插件：宿主必须能放弃等待
        await new Promise((r) => setTimeout(r, 5000));
        return { ok: true };
      },
    };`,
  );

  const rt = new InProcessRuntime({
    manifest: manifest(),
    dir,
    dataDir: path.join(root, 'data'),
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  await rt.init();

  const controller = new AbortController();
  const started = Date.now();
  const pending = rt.callTool({ tool: 'probe', args: {}, timeoutMs: 4000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const r = await pending;

  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4070', '取消必须是 E4070（不能是 E4065 超时或 E4066 崩溃）');
  assert.ok(Date.now() - started < 1000, '取消必须立刻返回，不该等插件跑完');

  await rt.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

test('in-process：停用插件时 ctx.signal 会 abort（长任务要能收手）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-rt-dispose-'));
  const dir = path.join(root, 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default {
      async callTool({ signal }) {
        // 协作式取消：轮询自己的信号
        for (let i = 0; i < 100; i += 1) {
          if (signal.aborted) return { stopped: true };
          await new Promise((r) => setTimeout(r, 10));
        }
        return { stopped: false };
      },
    };`,
  );

  const rt = new InProcessRuntime({
    manifest: manifest(),
    dir,
    dataDir: path.join(root, 'data'),
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  await rt.init();

  const pending = rt.callTool({ tool: 'probe', args: {}, timeoutMs: 5000 });
  setTimeout(() => void rt.dispose(), 40);
  const r = await pending;
  // 结果可能是插件自己协作退出（stopped=true），也可能是宿主放弃等待（E4070）。
  // 两者都算"停用打断了它"，唯一不能接受的是"它跑完了"。
  const cooperated = r.ok === true && r.value?.stopped === true;
  const abandoned = r.ok === false && r.code === 'E4070';
  assert.ok(cooperated || abandoned, `停用必须打断在途调用，实际：${JSON.stringify(r)}`);

  await fs.rm(root, { recursive: true, force: true });
});

/* ================================================================ process（协议层，不 spawn） */

/**
 * 造一个"可对话的假子进程"。
 *
 * 它做三件事：
 *   1. 冒充 child（stdin.write / kill / exit 事件），让 ProcessRuntime 能用；
 *   2. 把父进程写出去的消息按行解析，交给 `onParentMessage`；
 *   3. 提供 `emitJson(msg)` 模拟子进程 → 父进程的协议消息。
 *
 * ## 为什么 emitJson 直接调 runtime.onData
 *
 * `child.stdout.on('data')` 的监听器是在 `spawnChild()` 里注册的，而这里
 * 为了绕开 spawn（沙箱里会 EPERM）直接把假 child 塞进 runtime。
 * 那样监听器从来没注册过 —— 事件发出去没人收，表现是"子进程回应了但
 * 宿主一直等到超时"。直接调 `onData` 才等价于真实路径上的数据到达。
 *
 * 所以调用方要先 `child.rt = runtime`（见 attach），emitJson 才能找到它。
 *
 * @param {(msg: any) => void} onParentMessage
 */
function makeFakeChild(onParentMessage) {
  const child = new EventEmitter();
  /** @type {any[]} */
  const written = [];
  child.stdin = { destroyed: false };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0, null);
  };

  child.stdin.write = (line) => {
    const msg = JSON.parse(String(line).trim());
    written.push(msg);
    try {
      onParentMessage(msg);
    } catch {
      /* 测试回调自己炸了不该影响协议 */
    }
    return true;
  };

  child.written = written;
  /**
   * 把运行时挂上来，之后 emitJson 才能把数据喂进它的 onData。
   *
   * 做成一个显式方法而不是直接赋值：忘记挂的时候报"未挂载运行时"，
   * 而不是一个看不懂的 TypeError。
   *
   * @param {any} runtime
   */
  child.attach = (runtime) => {
    child.rt = runtime;
    runtime.child = child;
    return child;
  };
  child.emitJson = (msg) => {
    if (!child.rt) throw new Error('假子进程没有 attach 到运行时');
    // 走真实入口：ProcessRuntime.onData 负责按行切分与分发
    child.rt.onData(Buffer.from(JSON.stringify(msg) + '\n', 'utf8'));
  };
  return child;
}

test('★ process：invocation 随 call 下发，子进程拿到同一份 caller', async () => {
  /** 收到的 call 消息 */
  let callMsg = null;

  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });

  // 绕过 spawn：直接把假子进程塞进去，并把 ready 状态标好
  const child = makeFakeChild((msg) => {
    if (msg.type === 'call') {
      callMsg = msg;
      // 子进程回一个结果
      child.emitJson({ type: 'result', id: msg.id, ok: true, value: { got: msg.invocation } });
    }
  });
  child.attach(rt);
  rt.ready = true;

  const invocation = {
    pluginId: 'demo',
    tool: 'plugin_probe',
    origin: 'group',
    convKey: GROUP_A,
    isGroup: true,
    requester: { id: '9', nickname: '群友' },
    messageId: 'm-9',
    replyToMessageId: null,
    callId: 'c-9',
    at: 1,
  };

  const r = await rt.callTool({ tool: 'probe', args: { text: 'hi' }, timeoutMs: 1000, invocation });
  assert.equal(r.ok, true, r.message);
  assert.ok(callMsg, '父进程必须发出 call 消息');
  assert.deepEqual(callMsg.invocation, invocation, 'invocation 必须原样随 call 下发');
  assert.equal(r.value.got.convKey, GROUP_A);
});

test('★ process：host-call 只带 callId，上下文由父进程查表（子进程伪造无效）', async () => {
  const { factory, sent } = makeChatHost();
  let hostCallReplied = null;

  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
    makeChat: (input) => factory.makeChat(input),
  });

  const child = makeFakeChild((msg) => {
    if (msg.type === 'call') {
      /*
       * 子进程**故意**在 host-call 里夹带伪造的 convKey / origin。
       * 父进程必须完全忽略它们，只用自己记下的 callId 上下文。
       */
      child.emitJson({
        type: 'host-call',
        id: 77,
        callId: msg.id,
        method: 'send',
        args: { text: '伪造发到别处', convKey: 'group:9999', origin: 'owner-private' },
      });
      return;
    }
    if (msg.type === 'host-call-result') {
      hostCallReplied = msg.result;
      // 收到宿主结果后再回 call 的 result
      child.emitJson({ type: 'result', id: msg.__callId ?? 1, ok: true, value: hostCallReplied });
    }
  });
  child.attach(rt);
  rt.ready = true;

  const r = await rt.callTool({
    tool: 'probe',
    args: {},
    timeoutMs: 1000,
    invocation: { convKey: GROUP_A, origin: 'group', callId: 'c-1' },
  });

  assert.equal(r.ok, true, r.message);
  assert.ok(hostCallReplied, '父进程必须回应 host-call');
  assert.equal(hostCallReplied.ok, true, JSON.stringify(hostCallReplied));

  // 关键断言：消息发到了**父进程认定的会话**，不是子进程伪造的那个
  assert.equal(sent.length, 1);
  assert.equal(sent[0].convKey, GROUP_A, '子进程伪造的 convKey 不能生效');
  assert.equal(sent[0].auditText, '伪造发到别处');
});

test('★ process：host-call 的 callId 不存在 → E4071（指向"调用已结束"，不是会话错误）', async () => {
  /** @type {any} */
  let replied = null;
  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });

  // 临时挂个 child 来收回复（此时 rt.child 存在 = 不像"已停用"）
  const child = makeFakeChild(() => {});
  child.attach(rt);
  await rt.handleHostCall({ id: 5, callId: 12345, method: 'send', args: { text: 'x' } });
  replied = child.written.find((m) => m.type === 'host-call-result');
  assert.ok(replied, '必须回一条 host-call-result');
  assert.equal(replied.result.ok, false);
  /*
   * E4071 而不是 E4074：callId 查不到最常见的原因是"这次调用已经结束"
   * （取消/超时后父进程删了表项）。报 E4074（会话归属错误）会把插件作者
   * 引去查会话，而他真正遇到的是调用生命周期问题。
   */
  assert.equal(replied.result.code, 'E4071');
  assert.match(replied.result.message, /已结束/);
});

test('★ process：插件停用后迟到的 host-call → E4070（已取消）', async () => {
  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  const child = makeFakeChild(() => {});
  child.attach(rt);
  rt.disposed = true;

  await rt.handleHostCall({ id: 9, callId: 1, method: 'send', args: { text: 'x' } });
  const replied = child.written.find((m) => m.type === 'host-call-result');
  assert.equal(replied.result.code, 'E4070');
});

test('★ process：不认识的宿主能力 → E4071（不静默成功）', async () => {
  const { factory } = makeChatHost();
  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
    makeChat: (input) => factory.makeChat(input),
  });

  const child = makeFakeChild(() => {});
  child.attach(rt);
  rt.callContexts.set(5, { invocation: { convKey: GROUP_A }, signal: new AbortController().signal });

  await rt.handleHostCall({ id: 1, callId: 5, method: 'dropDatabase', args: {} });
  const replied = child.written.find((m) => m.type === 'host-call-result');
  assert.equal(replied.result.ok, false);
  assert.equal(replied.result.code, 'E4071');
  assert.match(replied.result.message, /不支持的宿主能力/);
});

test('★ process：取消只发 cancel、不 kill 子进程', async () => {
  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });

  /** @type {any[]} */
  const outbound = [];
  const child = makeFakeChild((msg) => {
    outbound.push(msg);
    // 故意不回 result：模拟一个不理会的子进程
  });
  child.attach(rt);
  rt.ready = true;

  const controller = new AbortController();
  const pending = rt.callTool({
    tool: 'probe',
    args: {},
    timeoutMs: 5000,
    invocation: { convKey: GROUP_A },
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4070');

  const cancelMsg = outbound.find((m) => m.type === 'cancel');
  assert.ok(cancelMsg, '取消必须通知子进程 abort');
  assert.equal(child.killed, false, '取消**不能** kill 子进程（那是超时的处理方式）');
});

test('★ process：取消不计入崩溃次数（连续取消不会把插件推到不再重启）', async () => {
  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });

  const child = makeFakeChild(() => {});
  child.attach(rt);
  rt.ready = true;
  rt.failures = 0;

  for (let i = 0; i < 5; i += 1) {
    const controller = new AbortController();
    const pending = rt.callTool({
      tool: 'probe',
      args: {},
      timeoutMs: 5000,
      invocation: { convKey: GROUP_A },
      signal: controller.signal,
    });
    controller.abort();
    const r = await pending;
    assert.equal(r.code, 'E4070');
  }
  assert.equal(rt.failures, 0, '取消不该累加失败次数（否则用户点几次停止就把插件点死）');
});

test('process：超时仍然 kill（与取消区分开）', async () => {
  const rt = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });

  const child = makeFakeChild(() => {
    // 不回应 → 让宿主走到超时分支
  });
  child.attach(rt);
  rt.ready = true;

  const r = await rt.callTool({ tool: 'probe', args: {}, timeoutMs: 100, invocation: { convKey: GROUP_A } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4065');
  assert.equal(child.killed, true, '超时必须 kill（否则卡死的进程会留在后台占端口）');
});

/* ================================================================ 两端一致 */

test('★ 一致性：两端的 ctx.chat 方法集合相同', () => {
  // in-process 的占位对象（宿主没注入时）
  const placeholder = unavailableChat('x');
  // 正常实现的形状（用一个真实的 bridge 造一份）
  const { factory } = makeChatHost();
  const real = factory.makeChat({ pluginId: 'demo', invocation: { convKey: GROUP_A } });

  const expected = ['recent', 'message', 'mediaList', 'send', 'sendMedia', 'registerMedia'].sort();
  assert.deepEqual(Object.keys(placeholder).sort(), expected);
  assert.deepEqual(Object.keys(real).sort(), expected);
});

test('★ 一致性：两端的 ctx.gateway 方法集合与同步属性相同', () => {
  /*
   * gateway 有一个 chat 没有的坑：`vision` 与 `caps()` 是**同步**属性。
   *
   * 子进程侧如果把它们做成 async，插件写 `ctx.gateway.vision.enabled`
   * 会拿到 undefined（Promise 没有这个字段），表现是"视觉永远被当成关着"，
   * 而代码看起来完全正确。所以形状必须逐键对齐，连"是不是 Promise"也要验。
   */
  const placeholder = unavailableGateway('x');
  const { bridge } = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  });
  const real = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  }).makeGateway({ convKey: GROUP_A, dataDir: '/tmp/x' });

  const methods = ['caps', 'probe', 'listFaces', 'fetchFaceImage', 'collectFace', 'sendFace'].sort();
  for (const one of [placeholder, real]) {
    for (const m of methods) {
      assert.equal(typeof one[m], 'function', `缺方法 ${m}`);
    }
    assert.equal(typeof one.available, 'boolean');
    // vision 必须是同步属性（不是函数、不是 Promise）
    assert.equal(typeof one.vision, 'object');
    assert.equal(typeof one.vision?.then, 'undefined', 'vision 不能是 Promise');
    assert.equal(typeof one.vision?.known, 'boolean', 'vision 必须带 known 可信位');
  }
  assert.equal(placeholder.available, false);
  assert.equal(real.available, true);
  assert.equal(placeholder.vision.known, false, '未注入时不能谎称视觉状态');
  void bridge;
});

test('★ 一致性：同一份 invocation 在两端产出的 caller 完全相同', async () => {
  const invocation = {
    pluginId: 'demo',
    tool: 'plugin_probe',
    origin: 'group',
    convKey: GROUP_A,
    isGroup: true,
    requester: { id: '5', nickname: '甲' },
    messageId: 'm-1',
    replyToMessageId: 'm-0',
    callId: 'c-x',
    at: 123,
  };

  // in-process
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-rt-same-'));
  const dir = path.join(root, 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default { async callTool({ ctx }) { return ctx.caller; } };`,
  );
  const ip = new InProcessRuntime({
    manifest: manifest(),
    dir,
    dataDir: path.join(root, 'data'),
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  await ip.init();
  const ipR = await ip.callTool({ tool: 'probe', args: {}, timeoutMs: 2000, invocation });
  assert.equal(ipR.ok, true, ipR.message);
  await ip.dispose();
  await fs.rm(root, { recursive: true, force: true });

  // process：协议层直传，所以"下发什么就是什么"
  let downlinked = null;
  const proc = new ProcessRuntime({
    manifest: manifest({ runtime: 'process', trusted: false }),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  const child = makeFakeChild((msg) => {
    if (msg.type === 'call') {
      downlinked = msg.invocation;
      child.emitJson({ type: 'result', id: msg.id, ok: true, value: msg.invocation });
    }
  });
  child.attach(proc);
  proc.ready = true;
  const procR = await proc.callTool({ tool: 'probe', args: {}, timeoutMs: 2000, invocation });
  assert.equal(procR.ok, true, procR.message);

  // 两端拿到的 caller 必须逐字段相同
  assert.deepEqual(ipR.value, procR.value);
  assert.deepEqual(downlinked, invocation);
});

/* ================================================================ 冻结上下文 */

test('★ freezeCaller：契约形状 + 递归冻结（requester 也不能改）', () => {
  /*
   * docs/plugin-api.md §5.2：「caller 是冻结的（Object.freeze）。想"改一下 origin
   * 再调自己"这种写法会失败，这是故意的」。
   *
   * 修复前这条在**两种运行时里都不成立**：
   *   · in-process 用 `{ ...invocation }` 展开 —— 展开会丢掉 freeze，
   *     产出一个可变的普通对象；
   *   · process 侧拿到的是 JSON 反序列化出来的对象，本来就没冻结。
   * 而只冻结外层还不够：`requester` 是嵌套对象，`caller.requester.id = 'x'`
   * 仍然能改，那正好是插件最容易顺手写的地方。
   */
  const caller = freezeCaller({
    pluginId: 'demo',
    tool: 'plugin_probe',
    origin: 'group',
    convKey: GROUP_A,
    isGroup: true,
    requester: { id: '5', nickname: '甲' },
    messageId: 'm-1',
    replyToMessageId: null,
    callId: 'c-1',
    at: 123,
  });

  assert.equal(Object.isFrozen(caller), true, 'caller 本身必须冻结');
  assert.equal(Object.isFrozen(caller.requester), true, 'requester 也必须冻结，否则照样能改');

  // 契约字段一个不多一个不少
  assert.deepEqual(Object.keys(caller).sort(), [
    'at',
    'callId',
    'convKey',
    'isGroup',
    'messageId',
    'origin',
    'pluginId',
    'replyToMessageId',
    'requester',
    'tool',
  ]);

  // 严格模式下赋值会抛 TypeError；非严格模式静默失败但值不变
  assert.throws(() => {
    caller.origin = 'owner-private';
  }, TypeError);
  assert.equal(caller.origin, 'group', 'origin 不能被子进程/插件改写');
  assert.throws(() => {
    caller.requester.id = '999';
  }, TypeError);
  assert.equal(caller.requester.id, '5');

  // 没有可信上下文时是 null，而不是编一个空 convKey 的假上下文
  assert.equal(freezeCaller(undefined), null);
  assert.equal(freezeCaller(null), null);
});

test('★ in-process：插件拿到的 ctx.caller 是冻结的（修复前是可变的展开副本）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-rt-freeze-'));
  const dir = path.join(root, 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default {
      async callTool({ ctx }) {
        let mutated = false;
        try { ctx.caller.origin = 'owner-private'; mutated = ctx.caller.origin !== 'group'; } catch { mutated = false; }
        let reqMutated = false;
        try { ctx.caller.requester.id = '999'; reqMutated = ctx.caller.requester.id !== '5'; } catch { reqMutated = false; }
        return {
          frozen: Object.isFrozen(ctx.caller),
          frozenRequester: Object.isFrozen(ctx.caller.requester),
          mutated,
          reqMutated,
          origin: ctx.caller.origin,
        };
      },
    };`,
  );

  const rt = new InProcessRuntime({
    manifest: manifest(),
    dir,
    dataDir: path.join(root, 'data'),
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  await rt.init();
  const r = await rt.callTool({
    tool: 'probe',
    args: {},
    timeoutMs: 2000,
    invocation: {
      pluginId: 'demo',
      tool: 'plugin_probe',
      origin: 'group',
      convKey: GROUP_A,
      isGroup: true,
      requester: { id: '5', nickname: '甲' },
      messageId: 'm-1',
      replyToMessageId: null,
      callId: 'c-1',
      at: 1,
    },
  });
  await rt.dispose();
  await fs.rm(root, { recursive: true, force: true });

  assert.equal(r.ok, true, r.message);
  assert.equal(r.value.frozen, true, 'ctx.caller 必须冻结（文档承诺）');
  assert.equal(r.value.frozenRequester, true, 'requester 也必须冻结');
  assert.equal(r.value.mutated, false, '改 origin 必须失败');
  assert.equal(r.value.reqMutated, false, '改 requester.id 必须失败');
  assert.equal(r.value.origin, 'group');
});

/* ============================================== 两端 caller / vision 形状 */

/**
 * 造一份"宿主什么都没注入"的子进程侧调用上下文。
 *
 * `request` 换成假实现：真实现会把 host-call 写进 stdout ——
 * 那是子进程的协议通道，在测试进程里写出去只会污染输出。
 *
 * @param {object} [invocation]
 * @param {(callId: number, method: string, args: object) => Promise<any>} [request]
 */
function processSideCtx(invocation, request = async () => ({ ok: false, code: 'E4071', message: '测试未接线' })) {
  return buildCallContext({
    baseCtx: { plugin: { id: 'demo' }, config: {}, dataDir: '/tmp/x', log: () => {}, sendText: async () => ({ ok: true }) },
    invocation,
    callId: 7,
    signal: new AbortController().signal,
    netFacts: { available: false },
    request,
  });
}

const CALLER_INVOCATION = {
  pluginId: 'demo',
  tool: 'plugin_probe',
  origin: 'group',
  convKey: GROUP_A,
  isGroup: true,
  requester: { id: '5', nickname: '甲' },
  messageId: 'm-1',
  replyToMessageId: null,
  callId: 'c-1',
  at: 123,
};

test('★ 一致性：两端 ctx.caller 都在顶层与 requester 上冻结，且字段集合一致', () => {
  /*
   * 修复前：
   *   · in-process 用 `{...invocation}` 展开 → 产出一个**未冻结**的新对象
   *     （executor 那边的 Object.freeze 在这一步被丢掉了）；
   *   · process 侧直接把父进程下发、JSON 反序列化出来的普通对象挂上去。
   * 于是文档 §5.2 承诺的"caller 不可变"在两端都不成立。
   * 现在两端都走 caller.mjs 的 freezeCaller。
   */
  const inproc = new InProcessRuntime({
    manifest: manifest(),
    dir: 'C:\\fake-plugin',
    dataDir: 'C:\\fake-data',
    config: {},
    secrets: {},
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  const inCtx = inproc.makeCallContext({ invocation: CALLER_INVOCATION, signal: new AbortController().signal });
  const procCtx = processSideCtx(CALLER_INVOCATION);

  for (const [label, caller] of [['in-process', inCtx.caller], ['process', procCtx.caller]]) {
    assert.equal(Object.isFrozen(caller), true, `${label}：caller 必须冻结`);
    assert.equal(Object.isFrozen(caller.requester), true, `${label}：requester 子对象也必须冻结`);
  }

  // 字段集合必须完全一致（两端同形状，插件不能靠 runtime 分支写代码）
  assert.deepEqual(Object.keys(inCtx.caller).sort(), Object.keys(procCtx.caller).sort());
  assert.deepEqual(inCtx.caller, procCtx.caller, '同一份 invocation 在两端产出的 caller 必须逐字段相同');

  // 没有可信上下文时两端都是 null，而不是各自编一个
  assert.equal(inproc.makeCallContext({ invocation: null }).caller, null);
  assert.equal(processSideCtx(null).caller, null);
});

test('★ 一致性：两端 gateway.vision 都带 known，且未知时三态都是 unknown', async () => {
  /*
   * `vision` 是同步属性，且 `known: false` 必须能表达"宿主没给这个事实"。
   * 子进程侧原来是手写默认值 `{enabled:false, supported:null}` —— 漏了 `known`。
   * 行为上恰好等价（undefined 也 falsy），但形状不一致：插件写
   * `'known' in vision` 或把对象塞进返回值时就会露馅。
   */
  // in-process：宿主没接 getVision
  const { makeGateway } = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
  });
  const inVision = makeGateway({ pluginId: 'demo', dataDir: '/tmp/x', convKey: GROUP_A }).vision;

  // process：宿主没接线 → 父进程返回 E4071，代理保持默认值
  const procVision = processSideCtx(CALLER_INVOCATION).gateway.vision;

  for (const [label, v] of [['in-process', inVision], ['process', procVision]]) {
    assert.equal(typeof v.known, 'boolean', `${label}：vision 必须带 known 可信位`);
    assert.equal(v.known, false, `${label}：宿主没给事实时 known 必须是 false（不能谎称"视觉关着"）`);
    assert.equal(v.enabled, false);
    assert.equal(v.supported, null, `${label}：没探测过时 supported 是 null，不能折成 false`);
  }
  assert.deepEqual(inVision, procVision);
  assert.deepEqual(Object.keys(inVision).sort(), Object.keys(procVision).sort());
  assert.deepEqual(UNKNOWN_GATEWAY_VISION, { enabled: false, supported: null, known: false });

  // 宿主给了事实时：两端都 known:true，且三态一致
  const withFacts = createGatewayFactory({
    request: async () => [],
    lookupMessage: () => ({ ok: false }),
    sendSegments: async () => ({ ok: true }),
    getVision: () => ({ enabled: true, supported: null }),
  });
  const inKnown = withFacts.makeGateway({ pluginId: 'demo', dataDir: '/tmp/x', convKey: GROUP_A }).vision;
  assert.deepEqual(inKnown, { known: true, enabled: true, supported: null });

  // 子进程侧：父进程返回同一份事实 → 刷新后形状必须相同
  const procKnownCtx = processSideCtx(
    CALLER_INVOCATION,
    async (callId, method) => (method === 'vision'
      ? { ok: true, value: { known: true, enabled: true, supported: null } }
      : { ok: false, code: 'E4071', message: '测试未接线' }),
  );
  assert.equal(procKnownCtx.gateway.vision.known, false, '第一次读先给"未知"，同时后台刷新');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(procKnownCtx.gateway.vision, inKnown, '刷新后两端必须给出同一份事实');
});

/* ================================================================ 快照一致性 */

test('★ 快照的 confirm 必须等于"该工具在该来源下的实际确认策略"', async () => {
  /*
   * 这条守的是一个界面欺诈：快照说"自动执行"，实际执行却弹确认。
   *
   * 根源是 confirm 有两种算法：
   *   · deriveToolPolicy(tool).confirm —— 只看 risk，与来源无关
   *   · needsConfirmFor(tool, {chatGranted}) —— 已授权聊天来源免确认
   *
   * 快照只能展示"最常用场景"（管理员私聊 / 未授权），所以它应该
   * 与 needsConfirmFor(tool, {chatGranted:false}) 一致。
   */
  const t = { needs: 'qq', risk: 'R1', effectiveRisk: 'R1', effects: ['chat.send'] };
  const derived = deriveToolPolicy(t).confirm;
  // R1 → always（未授权时每次确认）
  assert.equal(derived, 'always');

  const { needsConfirmFor } = await import('../src/guard/tool-gate.mjs');
  assert.equal(needsConfirmFor({ ...t, confirm: derived }, { chatGranted: false }), true);
  // 已授权聊天来源下会被降成 false（快照不承诺这个值，界面文案要写"按来源"）
  assert.equal(needsConfirmFor({ ...t, confirm: derived }, { chatGranted: true }), false);
});
