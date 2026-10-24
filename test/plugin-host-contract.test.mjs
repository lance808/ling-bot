/**
 * 插件宿主接口 v1.1 —— 契约与授权
 *
 * ## 这组测试守什么
 *
 * 改造后插件能拿到两样新东西：**可信调用上下文**（ctx.caller）和
 * **受控聊天能力**（ctx.chat）。这两样都是"能做事"的能力，所以
 * 测试的重点不是"功能好不好用"，而是：
 *
 *   1. 聊天来源默认拿不到任何插件工具（fail-closed）；
 *   2. 管理员点名之后才可见，而且三档互相独立（主动回合要单独开）；
 *   3. 模型**无法**通过参数伪造上下文；
 *   4. 风险不能被 `risk: "R0"` 骗低（effects 抬下限）；
 *   5. 取消信号真的会传到插件，且不被当成崩溃。
 *
 * 全部是本地模拟：不起 QQ、不调模型、不发消息。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeEffects,
  riskFloorOf,
  maxRisk,
  EFFECTS,
} from '../src/plugins/effects.mjs';
import {
  normalizeChatTools,
  normalizeChannelRule,
  defaultChatTools,
} from '../src/plugins/chat-tools.mjs';
import {
  channelOf,
  resolveChatGrant,
  chatGrantAllows,
  needsConfirmInChat,
} from '../src/guard/chat-grant.mjs';
import {
  resolveToolSet,
  isToolGranted,
  needsConfirmFor,
  pluginChatAccess,
  DEFAULT_POLICY,
} from '../src/guard/tool-gate.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';
import { normalizeManifest, deriveToolPolicy, RESERVED_PARAM_NAMES } from '../src/plugins/manifest.mjs';
import { makeInvocation, createToolRunner } from '../src/tools/executor.mjs';
import { defineTool, _clearToolsForTest, getTool } from '../src/tools/registry.mjs';

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');

/**
 * 造一份最小合法清单。
 *
 * @param {object} [over]
 */
function baseManifest(over = {}) {
  return {
    id: 'demo',
    name: '演示',
    version: '1.0.0',
    apiVersion: '1',
    description: '测试用插件',
    tools: [
      {
        name: 'ping',
        description: 'ping 一下',
        needs: 'qq',
        risk: 'R0',
        params: { text: { type: 'string', required: false } },
      },
    ],
    ...over,
  };
}

/** 管理员把某个工具点名给某个来源 */
function allowFor(channel, tools, extra = {}) {
  return {
    ...defaultChatTools(),
    [channel]: { enabled: true, tools, allowPaid: false, ...extra },
  };
}

/**
 * 造一个"被真正推导过的"插件工具声明。
 *
 * 直接用 deriveToolPolicy 而不是手写 origins：手写的夹具会和真实推导
 * 漂移，于是测试在"授权真的能生效吗"这件事上给出假绿灯
 * （本次改造第一次跑就踩到了：origins 里没有 group，授权永远不可能生效）。
 *
 * @param {object} [over]
 */
function pluginTool(over = {}) {
  const declared = {
    name: 'plugin_echo',
    needs: 'qq',
    risk: 'R0',
    effectiveRisk: 'R0',
    effects: [],
    plugin: 'echo',
    ...over,
  };
  const policy = deriveToolPolicy(declared);
  return { ...declared, ...policy };
}

/* ================================================================ effects */

test('effects：只认白名单里的词，拼错直接拒绝', () => {
  const ok = normalizeEffects(['chat.read', 'chat.send']);
  assert.equal(ok.ok, true);
  // 去重
  assert.deepEqual(normalizeEffects(['chat.send', 'chat.send']).effects, ['chat.send']);

  const bad = normalizeEffects(['chat.sned']);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E4041');
  assert.match(bad.message, /未知的 effect/);

  assert.equal(normalizeEffects('chat.send').ok, false);
  assert.equal(normalizeEffects([1]).ok, false);
  assert.deepEqual(normalizeEffects(undefined).effects, []);
});

test('effects：风险下限表符合约定（data.read 是 R0、exec 是 R3）', () => {
  assert.equal(riskFloorOf([]), 'R0');
  assert.equal(riskFloorOf(['data.read']), 'R0');
  assert.equal(riskFloorOf(['chat.read']), 'R1');
  assert.equal(riskFloorOf(['chat.send']), 'R1');
  assert.equal(riskFloorOf(['chat.send.media']), 'R1');
  assert.equal(riskFloorOf(['net']), 'R1');
  assert.equal(riskFloorOf(['data.write']), 'R2');
  assert.equal(riskFloorOf(['paid']), 'R2');
  assert.equal(riskFloorOf(['exec']), 'R3');
  // 取最高的那个
  assert.equal(riskFloorOf(['data.read', 'exec', 'net']), 'R3');

  assert.equal(maxRisk('R0', 'R2'), 'R2');
  assert.equal(maxRisk('R3', 'R1'), 'R3');
});

test('★ 清单：risk 写 R0 但声明 chat.send，生效风险是 R1', () => {
  /*
   * 这是这次改造最容易被绕过的一条：作者把 risk 写小、effects 写全，
   * 就能让一个"会往群里发消息"的工具自动执行（R0 = confirm never）。
   */
  const r = normalizeManifest(
    baseManifest({
      tools: [
        {
          name: 'sender',
          description: '发一条消息',
          needs: 'qq',
          risk: 'R0',
          effects: ['chat.send'],
        },
      ],
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, true, r.message);
  const tool = r.manifest.tools[0];
  assert.equal(tool.risk, 'R0', '声明的风险要原样保留，界面要能显示差距');
  assert.equal(tool.effectiveRisk, 'R1');
  assert.deepEqual(tool.effects, ['chat.send']);

  // 授权形状按生效风险走：R1 → 需要确认
  const policy = deriveToolPolicy(tool);
  assert.equal(policy.risk, 'R1');
  assert.equal(policy.confirm, 'always');
});

test('★ 清单：声明 exec 的工具即使写 R0，生效风险也是 R3', () => {
  const r = normalizeManifest(
    baseManifest({
      tools: [{ name: 'runner', description: '跑命令', needs: 'host', risk: 'R0', effects: ['exec'] }],
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, true, r.message);
  assert.equal(r.manifest.tools[0].effectiveRisk, 'R3');
  assert.equal(deriveToolPolicy(r.manifest.tools[0]).risk, 'R3');
});

test('★ 清单：保留参数名一律拒绝（origin / convKey / caller …）', () => {
  for (const name of RESERVED_PARAM_NAMES) {
    const r = normalizeManifest(
      baseManifest({
        tools: [
          {
            name: 'leaky',
            description: '想伪造上下文',
            needs: 'qq',
            params: { [name]: { type: 'string' } },
          },
        ],
      }),
      { dirName: 'demo' },
    );
    assert.equal(r.ok, false, `${name} 必须被拒绝`);
    assert.equal(r.code, 'E4041');
    assert.match(r.message, /保留字/);
  }
});

test('清单：生效风险与推导来源（qq 类含 group/proactive，host 类不含）', () => {
  const qq = deriveToolPolicy({ needs: 'qq', risk: 'R0' });
  assert.deepEqual(qq.origins.sort(), ['console', 'group', 'owner-group', 'owner-private', 'proactive'].sort());

  const host = deriveToolPolicy({ needs: 'host', risk: 'R1' });
  // host 类工具永远没有 group / proactive：这条是 I13 的落点
  assert.equal(host.origins.includes('group'), false);
  assert.equal(host.origins.includes('proactive'), false);
  assert.deepEqual(host.origins.sort(), ['console', 'owner-private'].sort());
});

/* ================================================================ chatTools 配置 */

test('chatTools：默认三档全关', () => {
  const d = defaultChatTools();
  for (const ch of ['group', 'private', 'proactive']) {
    assert.equal(d[ch].enabled, false);
    assert.deepEqual(d[ch].tools, []);
    assert.equal(d[ch].allowPaid, false);
  }
  assert.deepEqual(normalizeChatTools(undefined).value, d);
});

test('chatTools：非法形状一律 E40XX（不静默降级）', () => {
  assert.equal(normalizeChatTools([]).ok, false);
  assert.equal(normalizeChatTools({ group: { enabled: 'true' } }).ok, false);
  assert.equal(normalizeChatTools({ group: { enabled: true, tools: 'plugin_echo' } }).ok, false);
  // 未知档位：chatTool 少了 s，静默忽略会让人以为配好了
  assert.equal(normalizeChatTools({ chatTool: {} }).ok, false);
  // 裸工具名（内置工具）：这张表只管插件工具
  const bad = normalizeChannelRule({ enabled: true, tools: ['fs_read'] }, 'group');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不是合法工具名/);
});

test('chatTools：接受 plugin_xxx 与 *，并去重', () => {
  const r = normalizeChatTools({
    group: { enabled: true, tools: ['plugin_echo', 'plugin_echo', '*'] },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.group.tools, ['*']);
  assert.equal(r.value.private.enabled, false, '没写的档位要补成关闭');
});

/* ================================================================ 授权判定 */

test('★ 群聊默认拿不到插件工具（fail-closed）', () => {
  const tool = pluginTool();
  const policy = { ...DEFAULT_POLICY, chatTools: defaultChatTools() };

  // 群友：一开始就看不到
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], policy, { convKey: 'group:123' }).length, 0);
  assert.equal(isToolGranted(tool, ORIGIN.GROUP, policy, { convKey: 'group:123' }), false);

  // 管理员私聊仍然可以用（chatTools 不管这个档）
  assert.equal(resolveToolSet(ORIGIN.OWNER_PRIVATE, [tool], policy, { convKey: 'private:1' }).length, 1);
  // 管理员在自己群里也仍然可以用
  assert.equal(resolveToolSet(ORIGIN.OWNER_GROUP, [tool], policy, { convKey: 'group:123' }).length, 1);
});

test('★ 管理员点名后群聊可见；未点名时不可见', () => {
  const echo = pluginTool();
  const other = pluginTool({ name: 'plugin_other' });

  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_echo']) };
  const granted = resolveToolSet(ORIGIN.GROUP, [echo, other], policy, { convKey: 'group:123' });
  assert.deepEqual(granted.map((t) => t.name), ['plugin_echo'], '只有被点名的那个可见');

  // 通配符
  const wild = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['*']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [echo, other], wild, { convKey: 'group:123' }).length, 2);
});

test('★ 主动回合单独控制：开了群聊不等于开了主动回合', () => {
  const tool = pluginTool();
  const onlyGroup = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_echo']) };

  /*
   * 推导出来的 origins 里含 proactive（qq 类工具有这个候选位），
   * 所以这里能真正验证"chatTools.proactive 是独立开关"这件事。
   */
  assert.equal(tool.origins.includes('proactive'), true, 'qq 类工具应当有 proactive 候选位');
  assert.equal(
    resolveToolSet(ORIGIN.PROACTIVE, [tool], onlyGroup, { convKey: 'group:123' }).length,
    0,
    '只开了 group 时，主动回合仍然拿不到',
  );

  const both = {
    ...DEFAULT_POLICY,
    chatTools: {
      ...allowFor('group', ['plugin_echo']),
      proactive: { enabled: true, tools: ['plugin_echo'], allowPaid: false },
    },
  };
  assert.equal(resolveToolSet(ORIGIN.PROACTIVE, [tool], both, { convKey: 'group:123' }).length, 1);
});

test('★ 群聊与陌生人私聊分属两档（origin 都是 group）', () => {
  const tool = pluginTool();
  const onlyPrivate = { ...DEFAULT_POLICY, chatTools: allowFor('private', ['plugin_echo']) };

  // 陌生人私聊：可见
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], onlyPrivate, { convKey: 'private:999' }).length, 1);
  // 群聊：不可见（没开 group 档）
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], onlyPrivate, { convKey: 'group:123' }).length, 0);

  assert.equal(channelOf(ORIGIN.GROUP, 'group:1'), 'group');
  assert.equal(channelOf(ORIGIN.GROUP, 'private:1'), 'private');
  assert.equal(channelOf(ORIGIN.PROACTIVE, 'group:1'), 'proactive');
  assert.equal(channelOf(ORIGIN.OWNER_PRIVATE, 'private:1'), '', '管理员私聊不受 chatTools 约束');
});

test('★ 写入/执行类工具永远进不了聊天来源（即使被点名）', () => {
  const writeTool = pluginTool({
    name: 'plugin_saver',
    risk: 'R1',
    effectiveRisk: 'R1',
    effects: ['data.write'],
  });
  const execTool = pluginTool({
    name: 'plugin_exec',
    risk: 'R3',
    effectiveRisk: 'R3',
    effects: ['exec'],
  });

  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_saver', 'plugin_exec']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [writeTool], policy, { convKey: 'group:1' }).length, 0);
  assert.equal(resolveToolSet(ORIGIN.GROUP, [execTool], policy, { convKey: 'group:1' }).length, 0);

  const one = chatGrantAllows(writeTool, { channel: 'group', rule: allowFor('group', ['plugin_saver']).group });
  assert.equal(one.ok, false);
  assert.equal(one.reason, 'write-or-exec-tool');
});

test('★ 插件自审收费R2：allowPaid加点名才可见，普通host审批R2仍不可见', () => {
  const genTool = pluginTool({
    name: 'plugin_gen',
    risk: 'R2',
    effectiveRisk: 'R2',
    effects: ['paid', 'net'],
    approval: 'plugin',
  });

  // 点名了但没开 allowPaid
  const noPaid = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_gen']) };
  const blocked = chatGrantAllows(genTool, { channel: 'group', rule: noPaid.chatTools.group });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'paid-not-allowed');
  assert.equal(resolveToolSet(ORIGIN.GROUP, [genTool], noPaid, { convKey: 'group:1' }).length, 0);

  // 开了 allowPaid：可见
  const withPaid = {
    ...DEFAULT_POLICY,
    chatTools: allowFor('group', ['plugin_gen'], { allowPaid: true }),
  };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [genTool], withPaid, { convKey: 'group:1' }).length, 1);
  assert.equal(resolveToolSet(ORIGIN.GROUP, [{ ...genTool, approval: 'host' }], withPaid, { convKey: 'group:1' }).length, 0,
    '普通收费R2不能通过插件自审例外');

  // 底层确认要求仍保持：执行器由approval委托插件问，不降低risk/effects
  const granted = pluginChatAccess(genTool, ORIGIN.GROUP, withPaid, { convKey: 'group:1' });
  assert.equal(granted.granted, true);
  assert.equal(needsConfirmFor(genTool, { chatGranted: true }), true, '收费工具必须逐次确认');
  assert.equal(needsConfirmInChat(genTool, { chatGranted: true }), true);

  // 非收费的已授权工具：免确认（管理员点名 = 授权）
  const plain = pluginTool({ name: 'plugin_echo' });
  assert.equal(needsConfirmFor(plain, { chatGranted: true }), false);
});

test('授权：needs host 的工具永远进不了聊天来源', () => {
  const hostTool = pluginTool({ name: 'plugin_fs', needs: 'host' });
  // 推导结果里本来就没有 group/proactive，这里再显式把 group 塞进去验证第二道闸
  const forced = { ...hostTool, origins: [...hostTool.origins, 'group'] };
  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_fs']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [forced], policy, { convKey: 'group:1' }).length, 0);
});

/* ================================================================ invocation */

test('★ invocation：由宿主构造，模型给的字段进不来', () => {
  const inv = makeInvocation({
    toolFullName: 'plugin_echo',
    origin: ORIGIN.GROUP,
    convKey: 'group:123',
    pluginId: 'echo',
    requester: { id: '1001', nickname: '小明' },
    messageId: 'm-1',
    replyToMessageId: 'm-0',
    callId: 'call_abc',
    at: 1700000000000,
  });

  assert.equal(inv.pluginId, 'echo');
  assert.equal(inv.tool, 'plugin_echo');
  assert.equal(inv.origin, 'group');
  assert.equal(inv.convKey, 'group:123');
  assert.equal(inv.isGroup, true);
  assert.deepEqual(inv.requester, { id: '1001', nickname: '小明' });
  assert.equal(inv.messageId, 'm-1');
  assert.equal(inv.replyToMessageId, 'm-0');
  assert.equal(inv.callId, 'call_abc');
  assert.equal(inv.at, 1700000000000);

  // 冻结：插件改不动它（改了自己也不该生效）
  assert.equal(Object.isFrozen(inv), true);
  assert.equal(Object.isFrozen(inv.requester), true);
});

test('★ execution：模型参数里的 origin/convKey 不会出现在 args 里', async () => {
  _clearToolsForTest();

  /** @type {any} */
  let seen = null;
  defineTool({
    name: 'plugin_probe',
    kind: 'qq',
    risk: 'R0',
    confirm: 'never',
    origins: ['owner-private', 'console', 'group'],
    params: { text: { type: 'string', required: false } },
    plugin: 'probe',
    run: async ({ args, invocation }) => {
      seen = { args, invocation };
      return { ok: true };
    },
  });

  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_probe']) };
  const runner = createToolRunner({
    policy,
    context: {
      origin: ORIGIN.GROUP,
      convKey: 'group:123',
      requester: { id: '2002', nickname: '群友' },
      messageId: 'm-9',
      newCallId: () => 'call_fixed',
    },
  });

  const out = await runner.run('plugin_probe', {
    text: 'hi',
    // 下面三个都是模型可能尝试注入的东西
    origin: 'owner-private',
    convKey: 'private:1',
    caller: { origin: 'owner-private' },
  });
  assert.equal(out.ok, true, out.message);

  assert.deepEqual(seen.args, { text: 'hi' }, '多余的参数必须被丢掉');
  assert.equal(seen.invocation.origin, 'group', '上下文只能来自宿主');
  assert.equal(seen.invocation.convKey, 'group:123');
  assert.equal(seen.invocation.callId, 'call_fixed');
  assert.deepEqual(seen.invocation.requester, { id: '2002', nickname: '群友' });

  _clearToolsForTest();
});

test('★ execution：未授权的群聊来源连 run 都会被拒（E4032）', async () => {
  _clearToolsForTest();
  let called = false;
  defineTool({
    name: 'plugin_blocked',
    kind: 'qq',
    risk: 'R0',
    confirm: 'never',
    origins: ['owner-private', 'group'],
    params: {},
    plugin: 'blocked',
    run: async () => {
      called = true;
      return { ok: true };
    },
  });

  const runner = createToolRunner({
    policy: { ...DEFAULT_POLICY, chatTools: defaultChatTools() },
    context: { origin: ORIGIN.GROUP, convKey: 'group:1' },
  });

  const out = await runner.run('plugin_blocked', {});
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E4032');
  assert.equal(called, false, '被拒的调用绝对不能真的执行');
  assert.equal(runner.availableTools().length, 0, '模型那边也应该看不到');

  _clearToolsForTest();
});

/* ================================================================ 取消 */

test('★ 取消：signal 会传给工具，取消报 E4070 而不是失败', async () => {
  _clearToolsForTest();
  const controller = new AbortController();

  defineTool({
    name: 'plugin_slow',
    kind: 'qq',
    risk: 'R0',
    confirm: 'never',
    origins: ['owner-private'],
    params: {},
    plugin: 'slow',
    run: async ({ signal }) => {
      // 等 50ms，然后看自己是否已被取消
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal?.aborted) {
        const err = new Error('调用已取消');
        /** @type {any} */ (err).code = 'E4070';
        throw err;
      }
      return { ok: true };
    },
  });

  const runner = createToolRunner({
    policy: DEFAULT_POLICY,
    context: { origin: ORIGIN.OWNER_PRIVATE, convKey: 'private:1', signal: controller.signal },
  });

  const pending = runner.run('plugin_slow', {});
  // 让工具进入执行状态后再取消
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  const out = await pending;
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E4070', '取消必须是 E4070，不能混成 E50XX');

  _clearToolsForTest();
});

test('★ 取消：进函数前已取消的工具不会被执行', async () => {
  _clearToolsForTest();
  const controller = new AbortController();
  controller.abort();

  let called = false;
  defineTool({
    name: 'plugin_never',
    kind: 'qq',
    risk: 'R0',
    confirm: 'never',
    origins: ['owner-private'],
    params: {},
    plugin: 'never',
    run: async () => {
      called = true;
      return { ok: true };
    },
  });

  const runner = createToolRunner({
    policy: DEFAULT_POLICY,
    context: { origin: ORIGIN.OWNER_PRIVATE, convKey: 'private:1', signal: controller.signal },
  });
  const out = await runner.run('plugin_never', {});
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E4070');
  assert.equal(called, false, '已取消的调用不该白跑一次插件代码');

  _clearToolsForTest();
});

/* ================================================================ 旧插件兼容 */

test('★ 兼容：出厂插件清单仍然全部通过校验', async () => {
  for (const id of ['dsh-bridge', 'echo']) {
    const raw = JSON.parse(await fs.readFile(path.join(REPO, 'plugins', id, 'plugin.json'), 'utf8'));
    const r = normalizeManifest(raw, { dirName: id });
    assert.equal(r.ok, true, `${id}: ${r.message}`);
    // 没有 effects 的旧清单：生效风险等于声明风险
    for (const t of r.manifest.tools) {
      assert.deepEqual(t.effects, [], `${id}/${t.name} 不该凭空多出 effects`);
      assert.equal(t.effectiveRisk, t.risk);
    }
  }
});

test('★ 兼容：模板清单（docs/plugin-template）仍然合法', async () => {
  const raw = JSON.parse(
    await fs.readFile(path.join(REPO, 'docs', 'plugin-template', 'plugin.json'), 'utf8'),
  );
  const r = normalizeManifest(raw, { dirName: 'plugin-template' });
  assert.equal(r.ok, true, r.message);
});

test('★ 兼容：没有 chatTools 配置时，内置工具行为完全不变', () => {
  const builtin = {
    name: 'fs_read',
    kind: 'host',
    risk: 'R0',
    origins: ['owner-private', 'console'],
  };
  // 不带 plugin 字段 = 内置工具，chatTools 对它没有任何影响
  assert.equal(resolveToolSet(ORIGIN.OWNER_PRIVATE, [builtin], DEFAULT_POLICY, {}).length, 1);
  assert.equal(resolveToolSet(ORIGIN.GROUP, [builtin], DEFAULT_POLICY, { convKey: 'group:1' }).length, 0);

  const qqBuiltin = { name: 'send_message', kind: 'qq', risk: 'R0', origins: ['group'] };
  // 内置 QQ 工具在群里仍然按 origins 放行（不经过插件授权）
  assert.equal(resolveToolSet(ORIGIN.GROUP, [qqBuiltin], DEFAULT_POLICY, { convKey: 'group:1' }).length, 1);
});

/* ================================================================ 临时目录清理 */

test('临时目录不残留（兜底检查）', async () => {
  // 本文件不写磁盘，这里只是确认 os.tmpdir 可用（测试环境健康检查）
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-contract-'));
  await fs.writeFile(path.join(dir, 'x.txt'), 'ok');
  assert.equal(await fs.readFile(path.join(dir, 'x.txt'), 'utf8'), 'ok');
  await fs.rm(dir, { recursive: true, force: true });
});
