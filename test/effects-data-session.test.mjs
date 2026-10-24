/**
 * `data.session` effect：读写按会话隔离的业务数据
 *
 * ## 这个 effect 要守的语义
 *
 * 它是 `data.write` 的**窄化版**：写盘，但只写「当前 caller 的那一份」。
 * 归属由宿主从 `ctx.caller` 算出来，工具参数里没有用户/会话字段
 * （`RESERVED_PARAM_NAMES` 挡着，见 docs/course-schedule.md §1）。
 *
 * 于是它的授权形状必须同时满足两条看似矛盾的要求：
 *
 *   1. **能进聊天来源**：群里有人让机器人记一条课程表，写的是那个人自己的
 *      数据，管理员点名授权之后应当可用（这正是 chatTools 存在的意义）；
 *   2. **不能白拿**：下限是 R1，落不进 R0 那档"自动执行"，仍然要管理员点名；
 *      而 `data.write` / `exec` 依旧永远进不了聊天来源。
 *
 * 另外要确认它是**声明 + 授权分类**，不是技术隔离：`process` 运行时拦不住
 * 插件写任意路径。这条在文档里写清了（docs/plugin-api.md §4.2），
 * 测试只能守"分类与风险",不能替文档证明沙箱存在。
 *
 * 全部是纯函数调用：不写盘、起进程、联网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EFFECTS,
  EFFECT_RISK_FLOOR,
  normalizeEffects,
  riskFloorOf,
  maxRisk,
  hasEffect,
} from '../src/plugins/effects.mjs';
import { normalizeManifest, deriveToolPolicy } from '../src/plugins/manifest.mjs';
import {
  chatGrantAllows,
  resolveChatGrant,
  needsConfirmInChat,
} from '../src/guard/chat-grant.mjs';
import {
  resolveToolSet,
  isToolGranted,
  pluginChatAccess,
  needsConfirmFor,
  DEFAULT_POLICY,
  toJsonSchema,
  validateParams,
} from '../src/guard/tool-gate.mjs';
import { normalizeChannelRule, defaultChatTools } from '../src/plugins/chat-tools.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';

/** 造一份最小合法清单 */
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
        params: { text: { type: 'string' } },
      },
    ],
    ...over,
  };
}

/** 造一个「被真正推导过」的插件工具声明（手写夹具会和真实推导漂移） */
function pluginTool(over = {}) {
  const declared = {
    name: 'plugin_course_save',
    needs: 'qq',
    risk: 'R1',
    effectiveRisk: 'R1',
    effects: ['data.session'],
    plugin: 'course-schedule',
    ...over,
  };
  return { ...declared, ...deriveToolPolicy(declared) };
}

/** 管理员把某个工具点名给某个授权档 */
function allowFor(channel, tools, extra = {}) {
  return {
    ...defaultChatTools(),
    [channel]: { enabled: true, tools, allowPaid: false, ...extra },
  };
}

/* ==================================================== effects 白名单与下限 */

test('★ data.session 在 EFFECTS 白名单里，且下限是 R1', () => {
  assert.ok(EFFECTS.includes('data.session'), '它必须是宿主认识的词，否则清单会被 E4041 拒掉');
  assert.equal(EFFECT_RISK_FLOOR['data.session'], 'R1');
  assert.equal(riskFloorOf(['data.session']), 'R1');

  // 归一化不拒绝、不丢词
  const one = normalizeEffects(['data.session']);
  assert.equal(one.ok, true);
  assert.deepEqual(one.effects, ['data.session']);
  assert.equal(hasEffect(one.effects, 'data.session'), true);
});

test('data.session 与其它 effect 组合时取最高下限', () => {
  assert.equal(riskFloorOf(['data.read', 'data.session']), 'R1');
  assert.equal(riskFloorOf(['data.session', 'paid']), 'R2');
  assert.equal(riskFloorOf(['data.session', 'exec']), 'R3');
});

test('★ 清单：声明 data.session 而 risk 写 R0，生效风险被抬到 R1', () => {
  /*
   * 这是这个 effect 的核心价值：作者不能靠写 R0 让一个会写业务数据的工具
   * 变成"自动执行、不弹确认"。R1 同时意味着它会被排除在 R0 档之外。
   */
  const r = normalizeManifest(
    baseManifest({
      tools: [
        {
          name: 'course_save',
          description: '保存课程表',
          needs: 'qq',
          risk: 'R0',
          effects: ['data.session'],
        },
      ],
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, true, r.message);

  const tool = r.manifest.tools[0];
  assert.equal(tool.risk, 'R0', '声明的风险原样保留（界面要能显示差距）');
  assert.equal(tool.effectiveRisk, 'R1');
  assert.deepEqual(tool.effects, ['data.session']);

  const policy = deriveToolPolicy(tool);
  assert.equal(policy.risk, 'R1', '授权与确认都按生效风险走');
  assert.equal(policy.confirm, 'always', 'R1 在非聊天来源下仍需确认');
});

test('★ 兼容：data.session 不改变旧工具的生效风险（没声明就没有下限抬升）', () => {
  const r = normalizeManifest(
    baseManifest({
      tools: [
        { name: 'plain', description: '纯回显', needs: 'qq', risk: 'R0' },
        { name: 'reader', description: '读缓存', needs: 'qq', risk: 'R0', effects: ['data.read'] },
      ],
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, true, r.message);
  for (const t of r.manifest.tools) {
    assert.deepEqual(
      t.effects.includes('data.session'),
      false,
      `${t.name} 不该凭空多出 data.session`,
    );
    assert.equal(t.effectiveRisk, t.risk);
  }
});

/* ================================================= data.session 能进聊天来源 */

test('★ data.session 不被写入类拦截：管理员点名后群里可见', () => {
  /*
   * 这是「课程表在群里能用吗」的唯一开关。
   * isWriteOrExecTool 只看 `exec` / `data.write`，data.session 不在其中。
   */
  const tool = pluginTool();
  assert.equal(tool.risk, 'R1', '生效风险必须是 R1（聊天来源上限）');

  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_course_save']) };
  assert.equal(
    resolveToolSet(ORIGIN.GROUP, [tool], policy, { convKey: 'group:1' }).length,
    1,
    '授权之后群里应当看得到它',
  );

  const one = chatGrantAllows(tool, { channel: 'group', rule: policy.chatTools.group });
  assert.equal(one.ok, true, one.reason);

  const access = pluginChatAccess(tool, ORIGIN.GROUP, policy, { convKey: 'group:1' });
  assert.equal(access.granted, true);
  assert.equal(access.channel, 'group');
});

test('★ data.session 仍然要管理员点名：默认群里看不到', () => {
  const tool = pluginTool();
  // DEFAULT_POLICY.chatTools 是 null = 三档全关（fail-closed）
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], DEFAULT_POLICY, { convKey: 'group:1' }).length, 0);

  // 开了 group 档但没点名这个工具
  const otherOnly = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_echo']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], otherOnly, { convKey: 'group:1' }).length, 0);

  const blocked = chatGrantAllows(tool, { channel: 'group', rule: otherOnly.chatTools.group });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'tool-not-listed');
});

test('★ data.session 也不能被降成 R0 混进"自动执行"那档', () => {
  /*
   * 反过来的绕过路径：作者写 risk: R0 + effects: ["data.session"]。
   * 清单会把生效风险抬到 R1，于是它仍然需要确认 / 仍然要管理员点名。
   */
  const r = normalizeManifest(
    baseManifest({
      tools: [
        { name: 'saver', description: '存数据', needs: 'qq', risk: 'R0', effects: ['data.session'] },
      ],
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, true, r.message);
  const declared = r.manifest.tools[0];
  const tool = {
    name: 'plugin_saver',
    plugin: 'demo',
    effects: declared.effects,
    ...deriveToolPolicy(declared),
  };

  assert.equal(tool.risk, 'R1');
  assert.equal(tool.confirm, 'always');
  assert.equal(needsConfirmFor(tool, {}), true, '未授权来源仍然要确认');
});

test('data.session 被授权后免逐次确认（管理员点名 = 一次性授权）', () => {
  const tool = pluginTool();
  assert.equal(needsConfirmFor(tool, { chatGranted: true }), false);
  assert.equal(needsConfirmInChat(tool, { chatGranted: true }), false);
  // 未授权时回到工具自己的 confirm 声明（R1 → always）
  assert.equal(needsConfirmFor(tool, { chatGranted: false }), true);
});

test('★ data.session 与 chat.send 可共存：两个都在意，风险取最高', () => {
  const tool = pluginTool({ effects: ['data.session', 'chat.send'] });
  assert.equal(riskFloorOf(tool.effects), 'R1');
  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_course_save']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], policy, { convKey: 'group:1' }).length, 1);
});

/* ======================================================= data.write 仍然不可 */

test('★ data.write 仍然进不了聊天来源（即使被点名）', () => {
  const writeTool = pluginTool({
    name: 'plugin_saver',
    risk: 'R2',
    effectiveRisk: 'R2',
    effects: ['data.write'],
  });

  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_saver']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [writeTool], policy, { convKey: 'group:1' }).length, 0);
  assert.equal(isToolGranted(writeTool, ORIGIN.GROUP, policy, { convKey: 'group:1' }), false);

  const one = chatGrantAllows(writeTool, { channel: 'group', rule: policy.chatTools.group });
  assert.equal(one.ok, false);
  assert.equal(one.reason, 'write-or-exec-tool', '写入类是被这道闸拦下的，不是靠风险档');
});

test('★ exec 仍然进不了聊天来源（即使被点名）', () => {
  const execTool = pluginTool({
    name: 'plugin_exec',
    needs: 'host',
    risk: 'R3',
    effectiveRisk: 'R3',
    effects: ['exec'],
  });
  const forced = { ...execTool, origins: [...execTool.origins, 'group'] };
  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_exec']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [forced], policy, { convKey: 'group:1' }).length, 0);

  const one = chatGrantAllows(forced, { channel: 'group', rule: policy.chatTools.group });
  assert.equal(one.ok, false);
  // host 类先被 needs 那条挡住；这里再确认写入/执行那条也在
  assert.ok(['host-tool-in-chat', 'write-or-exec-tool'].includes(one.reason), one.reason);
});

test('★ data.write + data.session 同时声明时按更严的来（会话隔离不是豁免牌）', () => {
  /*
   * 声明了 data.session 并不"洗白"同一个工具上的 data.write。
   * 作者想表达"我也能写全局缓存"时必须诚实，而那份诚实会让它进不了群。
   */
  const both = pluginTool({
    name: 'plugin_mixed',
    risk: 'R2',
    effectiveRisk: 'R2',
    effects: ['data.session', 'data.write'],
  });
  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_mixed']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [both], policy, { convKey: 'group:1' }).length, 0);

  const one = chatGrantAllows(both, { channel: 'group', rule: policy.chatTools.group });
  assert.equal(one.ok, false);
  assert.equal(one.reason, 'write-or-exec-tool');
});

/* ======================================================== paid 仍需 allowPaid */

test('★ data.session + paid：仍然需要 allowPaid，且逐次确认', () => {
  /*
   * ## paid R2 能不能进聊天来源，取决于是不是 **§2.6 的精确例外**
   *
   * docs/plugin-api.md §2.6「收费插件的精确授权例外」列了全部条件：
   *   · 清单已验证 `trusted: true` + `runtime: "in-process"`；
   *   · 工具声明 `approval: "plugin"`（插件自审、逐次人工审批）；
   *   · **生效风险严格等于 R2**；
   *   · 该授权档 `enabled: true` 且 `allowPaid: true`；
   *   · 点名**完整**工具名（`*` 不覆盖收费例外）；主动回合禁止。
   *
   * 少了 `approval: "plugin"` 这一条，deriveToolPolicy 推出 `approval: "host"`，
   * chat-grant 的 `pluginPaidR2` 为 false → `risk-too-high-for-chat`。
   * 于是**即便开了 allowPaid，R2 收费工具也一条都进不来** —— 这是契约要的
   * fail-closed，而不是漏了一条路径（见本文件上方的负例断言）。
   */
  const paidDecl = {
    name: 'plugin_paid',
    risk: 'R2',
    effectiveRisk: 'R2',
    effects: ['data.session', 'paid'],
  };

  // 负例：没有 approval: "plugin" —— 任何 allowPaid 都进不了聊天来源
  const noApproval = pluginTool(paidDecl);
  assert.equal(noApproval.approval, 'host', '前置条件：没声明 approval 的工具由宿主审批');
  const paidButNoApproval = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_paid'], { allowPaid: true }) };
  assert.equal(
    resolveToolSet(ORIGIN.GROUP, [noApproval], paidButNoApproval, { convKey: 'group:1' }).length,
    0,
    '不属于 §2.6 精确例外的 R2 工具，即使 allowPaid 也不可见',
  );

  // 正例：§2.6 精确例外（trusted + in-process + approval:"plugin" + 严格 R2）
  const paidTool = pluginTool({ ...paidDecl, approval: 'plugin' });
  assert.equal(paidTool.approval, 'plugin', '前置条件：approval 的合法性已在清单层校验');

  // 点名了但没开 allowPaid
  const noPaid = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_paid']) };
  const blocked = chatGrantAllows(paidTool, { channel: 'group', rule: noPaid.chatTools.group });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'paid-not-allowed', '花钱要单独授权，data.session 不能替代它');
  assert.equal(resolveToolSet(ORIGIN.GROUP, [paidTool], noPaid, { convKey: 'group:1' }).length, 0);

  // 开了 allowPaid：可见，但仍然每次确认
  const withPaid = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_paid'], { allowPaid: true }) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [paidTool], withPaid, { convKey: 'group:1' }).length, 1);
  assert.equal(needsConfirmFor(paidTool, { chatGranted: true }), true, '收费工具永远逐次确认');
  assert.equal(needsConfirmInChat(paidTool, { chatGranted: true }), true);
});

/* ============================================ 与配置归一化 / 真实清单的一致性 */

test('chatTools 归一化照常接受带 data.session 的工具名', () => {
  const one = normalizeChannelRule({ enabled: true, tools: ['plugin_course_save'] }, 'group');
  assert.equal(one.ok, true, one.message);
  assert.deepEqual(one.rule.tools, ['plugin_course_save']);

  const bad = normalizeChannelRule({ enabled: true, tools: ['course_save'] }, 'group');
  assert.equal(bad.ok, false, '只接受 plugin_ 前缀的完整名');
});

test('resolveChatGrant：三档互相独立，data.session 工具只跟着被点名的那档走', () => {
  const tool = pluginTool();
  const onlyGroup = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_course_save']) };

  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], onlyGroup, { convKey: 'group:1' }).length, 1);
  // 陌生人私聊没开：不可见
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], onlyGroup, { convKey: 'private:9' }).length, 0);
  // 主动回合没开：不可见（群里能用 ≠ 自己发起时能用）
  assert.equal(resolveToolSet(ORIGIN.PROACTIVE, [tool], onlyGroup, { convKey: 'group:1' }).length, 0);

  assert.equal(resolveChatGrant({ chatTools: onlyGroup.chatTools, origin: ORIGIN.GROUP, convKey: 'group:1' })?.channel, 'group');
  assert.equal(resolveChatGrant({ chatTools: onlyGroup.chatTools, origin: ORIGIN.GROUP, convKey: 'private:9' }), null);
});

test('★ 真实清单：course-schedule 的写工具声明 data.session，且生效风险是 R1', async () => {
  /*
   * 用出厂清单而不是夹具：这份清单是插件侧与宿主侧的共同事实。
   * 它一旦漂移（比如有人把 save 的 effects 写成 data.write），
   * 症状会是"群里突然用不了课程表"，而那时不会有人想到是这一项。
   */
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const raw = JSON.parse(
    await fs.readFile(path.join(REPO, 'plugins', 'course-schedule', 'plugin.json'), 'utf8'),
  );
  const r = normalizeManifest(raw, { dirName: 'course-schedule' });
  assert.equal(r.ok, true, r.message);

  const writers = r.manifest.tools.filter((t) => t.effects.includes('data.session'));
  assert.deepEqual(
    writers.map((t) => t.name).sort(),
    ['course_delete', 'course_save', 'course_update'],
    '读写业务数据的三个工具要声明 data.session',
  );
  for (const t of writers) {
    assert.equal(t.effectiveRisk, 'R1', `${t.name} 的生效风险应当是 R1`);
    assert.equal(t.effects.includes('data.write'), false, `${t.name} 不该声明 data.write`);
  }

  // 用真实清单声明 + 真实推导造出工具，再过一遍授权判定
  const save = r.manifest.tools.find((t) => t.name === 'course_save');
  const tool = { name: save.fullName, plugin: 'course-schedule', effects: save.effects, ...deriveToolPolicy(save) };
  const policy = { ...DEFAULT_POLICY, chatTools: allowFor('group', ['plugin_course_save']) };
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], policy, { convKey: 'group:1' }).length, 1);
  assert.equal(needsConfirmFor(tool, { chatGranted: true }), false);

  // 最高声明风险与宿主上限的关系：R1 不需要 allowDangerous
  assert.ok(['R0', 'R1'].includes(tool.risk));
});

test('data.session 工具的参数照常递归校验（effect 不改变参数语义）', () => {
  const params = {
    courses: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string', required: true } } },
    },
  };
  const schema = toJsonSchema(params);
  assert.equal(schema.properties.courses.items.type, 'object');

  const ok = validateParams(params, { courses: [{ name: '高数', extra: 1 }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.courses, [{ name: '高数' }]);

  const bad = validateParams(params, { courses: [{ extra: 1 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /courses\[0\]\.name/);
});
