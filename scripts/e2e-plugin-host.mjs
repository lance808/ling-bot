/**
 * 插件子进程端到端自检（**需要能 spawn 子进程的环境**）
 *
 * ## 为什么不进单测
 *
 * `process` 运行时的关键路径是"宿主 ↔ 真实子进程"的 NDJSON 往返。
 * 单测里我们用假子进程验证了协议形状（见 test/plugin-runtime-parity.test.mjs），
 * 但有两件事只有真进程能验：
 *
 *   1. `child-runner.mjs` 真的能被 import 并跑通；
 *   2. 子进程里的 `ctx.chat.*` 代理真的能回到父进程执行。
 *
 * 而受限环境（CI 容器、某些沙箱）里 `spawn` 会直接 EPERM —— 那种情况下
 * 单测会**全部**失败，症状像"代码全坏了"。所以真实进程验证单独放这里，
 * 由人按需运行。
 *
 * 用法：
 *   node scripts/e2e-plugin-host.mjs
 *
 * 它不连 QQ、不发消息、不写用户目录：插件目录与 dataDir 都在临时目录里，
 * 发送通道是假的。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProcessRuntime } from '../src/plugins/runtime-process.mjs';
import { createChatFactory } from '../src/plugins/host-chat.mjs';
import { normalizeManifest } from '../src/plugins/manifest.mjs';

/** 记录"宿主真的被要求发了什么" */
/** @type {any[]} */
const sent = [];
let failed = 0;

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const GROUP_A = 'group:1001';
const GROUP_B = 'group:2002';

/** 待跑的子进程插件源码 */
const PLUGIN_SRC = `
export default {
  async init(ctx) {
    ctx.log('info', 'e2e 插件已初始化');
    return { ok: true };
  },
  async callTool({ tool, args, ctx, signal }) {
    const recent = ctx.chat.recent({ limit: 3 });
    const sentOne = await ctx.chat.send({ text: '来自子进程的问候' });

    // 再造一张"自己生成"的图片并登记成句柄
    const media = await ctx.chat.registerMedia({ path: 'gen.txt', kind: 'file', name: '结果.txt' });
    const mediaSent = media.ok ? await ctx.chat.sendMedia({ handles: [media.handle] }) : media;

    // 跨会话引用：必须被拒
    const crossQuote = await ctx.chat.send({ text: '跨群引用', quote: args.foreignMessageId });

    return {
      caller: ctx.caller,
      recentOk: recent.ok,
      recentConv: recent.convKey,
      sentOk: sentOne.ok,
      sentMessageId: sentOne.messageId,
      mediaRegistered: media.ok === true,
      mediaSentOk: mediaSent.ok === true,
      crossQuoteCode: crossQuote.code ?? null,
      aborted: signal?.aborted === true,
    };
  },
  async testConnection() {
    return { ok: true, message: '就绪' };
  },
  async dispose() {
    // 留空
  },
};
`;

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-e2e-host-'));
  const dir = path.join(root, 'demo');
  const dataDir = path.join(root, 'plugin-data', 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.mjs'), PLUGIN_SRC);
  // 插件"生成"的文件（registerMedia 的合法来源）
  await fs.writeFile(path.join(dataDir, 'gen.txt'), '这是插件自己生成的内容');

  const raw = {
    id: 'demo',
    name: '端到端演示',
    version: '1.0.0',
    apiVersion: '1',
    description: 'e2e 用的最小插件',
    runtime: 'process',
    entry: 'index.mjs',
    tools: [
      {
        name: 'probe',
        description: '探测上下文',
        needs: 'qq',
        risk: 'R1',
        effects: ['chat.read', 'chat.send'],
        timeoutMs: 20000,
        params: { foreignMessageId: { type: 'string' } },
      },
    ],
  };

  const norm = normalizeManifest(raw, { dirName: 'demo' });
  if (!norm.ok) {
    console.log(`清单校验失败：${norm.code} ${norm.message}`);
    process.exit(1);
  }

  const factory = createChatFactory({
    readMessages: ({ convKey, limit }) => ({
      ok: true,
      messages: Array.from({ length: limit }, (_, i) => ({
        messageId: `${convKey}-${i}`,
        sender: { userId: '1', nickname: '甲' },
        text: `第 ${i} 条`,
      })),
    }),
    lookupMessage: ({ convKey, messageId }) =>
      String(messageId).startsWith(`${convKey}-`)
        ? { ok: true, event: { messageId, segments: [] } }
        : { ok: false },
    sendSegments: async ({ convKey, segments, auditText }) => {
      sent.push({ convKey, segments, auditText });
      return { ok: true, messageId: `sent-${sent.length}` };
    },
    media: {},
  });

  const rt = new ProcessRuntime({
    manifest: norm.manifest,
    dir,
    dataDir,
    config: {},
    secrets: {},
    log: (level, message) => {
      if (level === 'error') console.log(`    [插件日志/${level}] ${message}`);
    },
    sendText: async () => ({ ok: true }),
    makeChat: (input) => factory.makeChat(input),
    nodePath: process.execPath,
  });

  console.log('插件宿主端到端自检（真实子进程）\n');

  const init = await rt.init();
  check('子进程 init 成功', init.ok === true, init.message);
  if (!init.ok) {
    await rt.dispose();
    await fs.rm(root, { recursive: true, force: true });
    process.exit(1);
  }

  const invocation = {
    pluginId: 'demo',
    tool: 'plugin_probe',
    origin: 'group',
    convKey: GROUP_A,
    isGroup: true,
    requester: { id: '777', nickname: '群友' },
    messageId: `${GROUP_A}-0`,
    replyToMessageId: null,
    callId: 'e2e-call-1',
    at: Date.now(),
  };

  const r = await rt.callTool({
    tool: 'probe',
    args: { foreignMessageId: `${GROUP_B}-0` },
    timeoutMs: 15000,
    invocation,
  });

  check('工具调用成功返回', r.ok === true, r.message);
  if (r.ok) {
    const v = r.value;
    check('ctx.caller 由宿主下发（convKey 正确）', v.caller?.convKey === GROUP_A, JSON.stringify(v.caller));
    check('ctx.caller 的 origin 正确', v.caller?.origin === 'group');
    check('ctx.caller 带 requester', v.caller?.requester?.id === '777');
    check('ctx.chat.recent 可用且是当前会话', v.recentOk === true && v.recentConv === GROUP_A);
    check('ctx.chat.send 经宿主通道发出', v.sentOk === true && String(v.sentMessageId).startsWith('sent-'));
    check('ctx.chat.registerMedia 接受插件 dataDir 内文件', v.mediaRegistered === true);
    check('ctx.chat.sendMedia 发出自己生成的媒体', v.mediaSentOk === true);
    check('跨会话引用被拒（E4074）', v.crossQuoteCode === 'E4074', String(v.crossQuoteCode));
  }

  check('宿主只收到当前会话的两次发送', sent.length === 2 && sent.every((s) => s.convKey === GROUP_A), JSON.stringify(sent.map((s) => s.convKey)));

  // ---- 取消 ----
  const controller = new AbortController();
  const pending = rt.callTool({
    tool: 'probe',
    args: {},
    timeoutMs: 15000,
    invocation: { ...invocation, callId: 'e2e-call-2' },
    signal: controller.signal,
  });
  // 稍微等一下让子进程真的开始跑，然后取消
  setTimeout(() => controller.abort(), 5);
  const cancelled = await pending;
  check('取消返回 E4070', cancelled.ok === false && cancelled.code === 'E4070', `${cancelled.code} ${cancelled.message}`);

  // 取消之后进程必须还活着（取消 ≠ kill）
  const afterCancel = await rt.testConnection();
  check('取消之后子进程仍然可用（取消没有 kill）', afterCancel.ok === true, afterCancel.message);

  // ---- 停用 ----
  await rt.dispose();
  check('dispose 完成', true);

  // 清理：确认临时目录里没有残留（插件不该往别处写）
  await fs.rm(root, { recursive: true, force: true });

  console.log('');
  if (failed > 0) {
    console.log(`${failed} 项未通过。`);
    process.exit(1);
  }
  console.log('全部通过。');
}

main().catch((err) => {
  console.log(`自检异常：${String(/** @type {any} */ (err)?.message ?? err)}`);
  if (String(/** @type {any} */ (err)?.code) === 'EPERM') {
    console.log('（EPERM = 当前环境禁止创建子进程，这个脚本需要在普通终端里运行）');
  }
  process.exit(1);
});
