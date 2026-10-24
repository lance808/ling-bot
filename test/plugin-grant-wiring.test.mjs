/**
 * 授权配置的接线测试 —— 「配了到底生不生效」
 *
 * ## 为什么需要这一层
 *
 * `tool-gate` 的纯函数测试证明"给对参数就判对"，但它证明不了**接线**：
 * 配置从 `config.json` 读出来、经过归一化、进到 `toolPolicy()`、再到
 * `resolveToolSet` 的这条路上，任何一环漏了，表现都是"我在界面开了，
 * 群里还是不能用"—— 而每个函数单看都是对的。
 *
 * 所以这里用真实模块把链路拼起来：
 *
 *   DEFAULT_CONFIG → validateConfig → normalizeChatTools → toolPolicy 形状
 *   → resolveToolSet → 可见性
 *
 * 全部是纯内存，不连 QQ、不写磁盘。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, validateConfig, mergeStrict } from '../src/config/schema.mjs';
import { normalizeChatTools, normalizeChannelRule } from '../src/plugins/chat-tools.mjs';
import { resolveToolSet, DEFAULT_POLICY } from '../src/guard/tool-gate.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';
import { deriveToolPolicy, normalizeManifest } from '../src/plugins/manifest.mjs';
import { normalizeChatTools as normalizeInGuardUse } from '../src/plugins/chat-tools.mjs';

/**
 * 复刻 index.mjs 的 toolPolicy()（真实文件里有模块级状态，不能直接 import）。
 *
 * 复刻而不是 import 的原因：直接 import index.mjs 会启动整个后端。
 * 所以这里逐字照抄那个函数体 —— 这也意味着**它改了两边要一起改**，
 * 所以下面有一条测试专门比对形状（防止漂移成两套）。
 *
 * @param {any} config
 */
function toolPolicyOf(config) {
  const chat = normalizeInGuardUse(config.plugins?.chatTools);
  return {
    groupHostToolsForbidden: true,
    proactiveHostToolsForbidden: true,
    allowR3Default: config.tools.allowR3 === true,
    chatTools: chat.ok ? chat.value : normalizeInGuardUse(undefined).value,
  };
}

/** 一个真实的 qq 类插件工具（经过清单推导） */
function echoTool() {
  const r = normalizeManifest(
    {
      id: 'echo',
      name: '回声',
      version: '1.0.0',
      apiVersion: '1',
      description: '回声',
      tools: [{ name: 'echo', description: '回显', needs: 'qq', risk: 'R0' }],
    },
    { dirName: 'echo' },
  );
  assert.equal(r.ok, true, r.message);
  const t = r.manifest.tools[0];
  return { name: t.fullName, plugin: 'echo', effects: t.effects, ...deriveToolPolicy(t) };
}

/* ================================================================ 配置默认值 */

test('schema：plugins.chatTools 有默认值，三档全关', () => {
  const d = DEFAULT_CONFIG.plugins.chatTools;
  for (const ch of ['group', 'private', 'proactive']) {
    assert.equal(d[ch].enabled, false, `${ch} 默认必须关闭`);
    assert.deepEqual(d[ch].tools, []);
    assert.equal(d[ch].allowPaid, false);
  }
});

test('schema：没有任何 plugins 块的旧配置也能通过校验（向前兼容）', () => {
  // 老用户的 config.json 里可能只有 onebot / llm / allow
  const cfg = validateConfig({
    onebot: { wsUrl: 'ws://127.0.0.1:3001' },
    llm: { model: 'deepseek-chat' },
  });
  assert.equal(cfg.plugins.chatTools.group.enabled, false);
  // 默认启用的内置插件仍在
  assert.ok(Array.isArray(cfg.plugins.enabled));
});

test('schema：写成字符串 enabled 一律启动失败（不静默当 false）', () => {
  assert.throws(
    () =>
      validateConfig({
        plugins: { chatTools: { group: { enabled: 'true', tools: [], allowPaid: false } } },
      }),
    /enabled 必须是布尔值/,
  );
});

test('schema：tools 里写裸内置工具名 → 启动失败（避免假开关）', () => {
  assert.throws(
    () =>
      validateConfig({
        plugins: { chatTools: { group: { enabled: true, tools: ['fs_read'], allowPaid: false } } },
      }),
    /不是合法工具名/,
  );
});

test('schema：chatTools.allowPaid 非布尔也拒绝', () => {
  assert.throws(
    () =>
      validateConfig({
        plugins: { chatTools: { private: { enabled: true, tools: [], allowPaid: 1 } } },
      }),
    /allowPaid 必须是布尔值/,
  );
});

test('schema：未知档位不会通过（防止 chatTool 拼写错误）', () => {
  // 未知键在 plugins.chatTools 内部不是 DYNAMIC_MAP，走 mergeStrict 的未知键检测
  const { unknown } = mergeStrict(DEFAULT_CONFIG, {
    plugins: { chatTools: { chatTool: { enabled: true } } },
  }, '');
  // 沿着 plugins.chatTools.chatTool 应被报告为未知
  assert.ok(unknown.some((u) => u.includes('chatTool')), `unexpected unknown: ${unknown.join(',')}`);
});

/* ================================================================ 接线 */

test('★ 接线：默认配置下，群里看不到插件工具；管理员私聊能看到', () => {
  const cfg = validateConfig({});
  const policy = toolPolicyOf(cfg);
  const tool = echoTool();

  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], policy, { convKey: 'group:1' }).length, 0);
  assert.equal(resolveToolSet(ORIGIN.OWNER_PRIVATE, [tool], policy, { convKey: 'private:1' }).length, 1);
});

test('★ 接线：管理员开启后，群里立刻可见（不重启后端）', () => {
  /*
   * 这就是"改完立刻生效"的验证：每次 toolPolicy() 都从 config 现算，
   * 所以同一个进程里改完 config 再算一次就能看到变化。
   */
  const cfg = validateConfig({
    plugins: { chatTools: { group: { enabled: true, tools: ['plugin_echo'], allowPaid: false } } },
  });
  const tool = echoTool();

  const before = toolPolicyOf(validateConfig({}));
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], before, { convKey: 'group:1' }).length, 0);

  const after = toolPolicyOf(cfg);
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], after, { convKey: 'group:1' }).length, 1);
});

test('★ 接线：只开 group 不会顺带打开主动回合与陌生人私聊', () => {
  const cfg = validateConfig({
    plugins: { chatTools: { group: { enabled: true, tools: ['plugin_echo'], allowPaid: false } } },
  });
  const policy = toolPolicyOf(cfg);
  const tool = echoTool();

  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], policy, { convKey: 'group:1' }).length, 1);
  assert.equal(resolveToolSet(ORIGIN.PROACTIVE, [tool], policy, { convKey: 'group:1' }).length, 0, '主动回合必须单独开');
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], policy, { convKey: 'private:9' }).length, 0, '陌生人私聊必须单独开');
});

test('★ 接线：配置坏掉时退回"全关"，而不是让所有工具炸掉', () => {
  // 模拟 config.json 被手改坏（绕过 validateConfig 的情况）
  const broken = { plugins: { chatTools: { group: { enabled: 'yes' } } }, tools: {} };
  const policy = toolPolicyOf(broken);
  for (const ch of ['group', 'private', 'proactive']) {
    assert.equal(policy.chatTools[ch].enabled, false, `${ch} 应退回关闭`);
  }
  // 退回全关之后，正常来源仍然工作
  const tool = echoTool();
  assert.equal(resolveToolSet(ORIGIN.OWNER_PRIVATE, [tool], policy, { convKey: 'private:1' }).length, 1);
});

test('接线：DEFAULT_POLICY 的 chatTools 缺省为 null（无配置 = 聊天来源全关）', () => {
  assert.equal(DEFAULT_POLICY.chatTools, null);
  const tool = echoTool();
  assert.equal(resolveToolSet(ORIGIN.GROUP, [tool], DEFAULT_POLICY, { convKey: 'group:1' }).length, 0);
});

/* ================================================================ 设置写入 */

test('★ setting：单档写入只改那一档，其余两档保持不变', () => {
  // 复刻 index.mjs 的写入逻辑（整块写入 vs 单档替换）
  let current = normalizeChatTools(undefined).value;

  // 先开 group
  current = normalizeChatTools({ ...current, group: { enabled: true, tools: ['plugin_echo'], allowPaid: false } }).value;
  assert.equal(current.group.enabled, true);

  // 再开 private（不应影响 group）
  const next = normalizeChatTools({
    ...current,
    private: { enabled: true, tools: ['plugin_echo', 'plugin_pic'], allowPaid: false },
  });
  assert.equal(next.ok, true);
  assert.equal(next.value.group.enabled, true, 'group 不能被覆盖掉');
  assert.equal(next.value.group.tools.length, 1, 'group 的工具列表保持原样');
  assert.deepEqual(next.value.private.tools, ['plugin_echo', 'plugin_pic']);
  assert.equal(next.value.proactive.enabled, false);
});

test('setting：写入非法值不会部分生效（整体拒绝）', () => {
  const r = normalizeChatTools({
    group: { enabled: true, tools: ['not-a-plugin-tool'], allowPaid: false },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E40XX');
  // 整块拒绝意味着调用方不会拿到"半套配置"去落盘
  assert.equal(r.value, undefined);
});

test('setting：单档写入也能接受 * 通配', () => {
  const r = normalizeChannelRule({ enabled: true, tools: ['*'], allowPaid: true }, 'proactive');
  assert.equal(r.ok, true);
  assert.equal(r.rule.allowPaid, true);
  assert.deepEqual(r.rule.tools, ['*']);
});

/* ================================================================ 形状一致 */

test('★ 形状：快照里的 chatTools 与配置同形（界面能直接渲染）', () => {
  const cfg = validateConfig({
    plugins: { chatTools: { group: { enabled: true, tools: ['plugin_echo'], allowPaid: false } } },
  });
  const policy = toolPolicyOf(cfg);
  for (const ch of ['group', 'private', 'proactive']) {
    const rule = policy.chatTools[ch];
    assert.deepEqual(Object.keys(rule).sort(), ['allowPaid', 'enabled', 'tools'], `${ch} 字段形状`);
    assert.equal(typeof rule.enabled, 'boolean');
    assert.equal(Array.isArray(rule.tools), true);
    assert.equal(typeof rule.allowPaid, 'boolean');
  }
});

test('★ 一致性：chat-tools 与 guard/chat-grant 的档位定义必须相同', async () => {
  const { CHAT_CHANNELS } = await import('../src/plugins/chat-tools.mjs');
  const guard = await import('../src/guard/chat-grant.mjs');
  assert.deepEqual([...CHAT_CHANNELS].sort(), [...guard.CHAT_CHANNELS].sort());

  /*
   * 两处各有一份档位清单，漂移的后果很具体：配置里写了 proactive 但
   * 判定只看 group/private，于是"开了主动回合却永远不生效"。
   */
  assert.deepEqual([...CHAT_CHANNELS].sort(), ['group', 'private', 'proactive']);
});
