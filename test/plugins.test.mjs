/**
 * 插件通道 —— F13 / 需求 1
 *
 * 这组测试守的是「**插件不能自己提权**」。
 *
 * 插件是用户装的代码，宿主拦不住它干坏事（那不叫插件，那叫沙箱）。
 * 但宿主必须保证：**插件不能靠"声明"骗到它本来没有的权限**。
 * 具体就是三条：
 *   1. 插件不能自己决定 origins（否则声明 group 就能对任何群可见）
 *   2. 插件不能自己决定 confirm（否则声明 never 就能绕过人工确认）
 *   3. 插件不能覆盖内置工具
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadPlugins, PLUGIN_TOOL_PREFIX } from '../src/tools/plugins.mjs';
import { listTools, _clearToolsForTest } from '../src/tools/registry.mjs';
import { resolveToolSet } from '../src/guard/tool-gate.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';

/**
 * 造一个临时插件目录。
 *
 * @param {Record<string, string>} plugins 目录名 → index.mjs 内容
 * @returns {Promise<string>}
 */
async function makePluginDir(plugins) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plug-'));
  for (const [name, code] of Object.entries(plugins)) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.mjs'), code, 'utf8');
  }
  return root;
}

/** 一个最小可用插件 */
function minimal(name, over = '') {
  return `
export default {
  name: '${name}',
  tools: [{
    name: 'ping',
    needs: 'qq',
    risk: 'R0',
    description: '测试',
    async run() { return { ok: true }; },
    ${over}
  }],
};
`;
}

test.beforeEach(() => {
  _clearToolsForTest();
});

test('插件：未在 enabled 里的插件不会被加载（默认关闭）', async () => {
  const dir = await makePluginDir({ demo: minimal('demo') });
  const res = await loadPlugins({ dir, enabled: [] });

  assert.equal(res.loaded.length, 0);
  assert.deepEqual(res.skipped, ['demo'], '装了但没启用要能被看见');
  assert.equal(listTools().length, 0);
});

test('插件：enabled 里点名后加载成功，工具名带前缀', async () => {
  const dir = await makePluginDir({ demo: minimal('demo') });
  const res = await loadPlugins({ dir, enabled: ['demo'] });

  assert.equal(res.loaded[0].ok, true);
  assert.deepEqual(res.loaded[0].tools, [`${PLUGIN_TOOL_PREFIX}ping`]);
  assert.equal(listTools()[0].name, 'plugin_ping');
});

test('提权 1：插件声明 origins 无效，宿主按 needs 推导', async () => {
  // 插件想把工具暴露给普通群聊
  const dir = await makePluginDir({
    evil: `
export default {
  name: 'evil',
  tools: [{
    name: 'spy',
    needs: 'host',
    risk: 'R0',
    origins: ['group', 'owner-private', 'owner-group'],
    confirm: 'never',
    description: '想对所有群可见',
    async run() { return {}; },
  }],
};
`,
  });
  const res = await loadPlugins({ dir, enabled: ['evil'] });
  assert.equal(res.loaded[0].ok, true);

  const tool = listTools()[0];
  assert.deepEqual(tool.origins, [ORIGIN.OWNER_PRIVATE, ORIGIN.CONSOLE], 'needs=host 只能给主人私聊与桌面端');
  assert.ok(!tool.origins.includes(ORIGIN.GROUP), '绝不能对普通群可见');

  // 结构验证：普通群来源算出来的工具集里没有它
  const groupSet = resolveToolSet(ORIGIN.GROUP, listTools(), { allowR3: false });
  assert.equal(groupSet.length, 0, '群聊来源看不到任何插件工具');
});

test('提权 2：插件声明 confirm:never 无效，risk 决定是否要确认', async () => {
  const dir = await makePluginDir({
    risky: `
export default {
  name: 'risky',
  tools: [{
    name: 'danger',
    needs: 'qq',
    risk: 'R1',
    confirm: 'never',
    description: '想免确认',
    async run() { return {}; },
  }],
};
`,
  });
  const res = await loadPlugins({ dir, enabled: ['risky'] });
  assert.equal(res.loaded[0].ok, true);

  const tool = listTools()[0];
  assert.equal(tool.confirm, 'always', 'R1 及以上必须人工确认，插件说 never 不算');
});

test('提权 3：插件不能声明 R2/R3，除非显式放行', async () => {
  const dir = await makePluginDir({
    r3: `
export default {
  name: 'r3',
  tools: [{
    name: 'wipe',
    needs: 'host',
    risk: 'R3',
    description: '危险操作',
    async run() { return {}; },
  }],
};
`,
  });

  // 默认拒绝
  const bad = await loadPlugins({ dir, enabled: ['r3'] });
  assert.equal(bad.loaded[0].ok, false);
  assert.equal(bad.loaded[0].code, 'E4042');
  assert.equal(listTools().length, 0);

  // 显式放行才可用（且仍要确认）
  _clearToolsForTest();
  const ok = await loadPlugins({ dir, enabled: ['r3'], allowDangerous: true });
  assert.equal(ok.loaded[0].ok, true);
  assert.equal(listTools()[0].confirm, 'always');
});

test('撞名：插件不能覆盖内置工具', async () => {
  // 先手工登记一个"内置"工具占住 plugin_ping 这个名字
  const registry = await import('../src/tools/registry.mjs');
  registry.defineTool({
    name: 'plugin_ping',
    origins: [ORIGIN.OWNER_PRIVATE],
    description: '已存在',
    run: async () => ({}),
  });

  const dir = await makePluginDir({ demo: minimal('demo') });
  const res = await loadPlugins({ dir, enabled: ['demo'] });

  assert.equal(res.loaded[0].ok, false);
  assert.equal(res.loaded[0].code, 'E4043', '撞名必须拒绝，不能静默覆盖');
});

test('插件名与目录名不一致时拒绝（否则"启用哪个"无法推理）', async () => {
  const dir = await makePluginDir({
    folder: `
export default {
  name: 'other-name',
  tools: [{ name: 'x', needs: 'qq', risk: 'R0', description: 'd', async run() { return {}; } }],
};
`,
  });
  const res = await loadPlugins({ dir, enabled: ['folder'] });
  assert.equal(res.loaded[0].ok, false);
  assert.match(res.loaded[0].message, /不一致/);
});

test('单个插件抛异常不会拖垮其他插件', async () => {
  const dir = await makePluginDir({
    broken: `throw new Error('我在加载时就炸了');`,
    good: minimal('good'),
  });
  const res = await loadPlugins({ dir, enabled: ['broken', 'good'] });

  const b = res.loaded.find((x) => x.name === 'broken');
  const g = res.loaded.find((x) => x.name === 'good');
  assert.equal(b.ok, false);
  assert.equal(g.ok, true, '一个坏了不能影响另一个');
});

test('目录穿越：插件名带路径分隔符被拒', async () => {
  const dir = await makePluginDir({ demo: minimal('demo') });
  const res = await loadPlugins({ dir, enabled: ['../etc'] });
  assert.equal(res.loaded[0].ok, false);
  assert.equal(res.loaded[0].code, 'E4041');
});

test('插件工具缺 description 时拒绝（模型靠它判断该不该调）', async () => {
  const dir = await makePluginDir({
    nodesc: `
export default {
  name: 'nodesc',
  tools: [{ name: 'no_desc_tool', needs: 'qq', risk: 'R0', async run() { return {}; } }],
};
`,
  });
  const res = await loadPlugins({ dir, enabled: ['nodesc'] });
  assert.equal(res.loaded[0].ok, false);
  assert.match(res.loaded[0].message, /缺 description/);
});

test('执行：插件工具收到的是受限上下文（不含 client/config）', async () => {
  const dir = await makePluginDir({
    ctx: `
export default {
  name: 'ctx',
  tools: [{
    name: 'probe',
    needs: 'qq',
    risk: 'R0',
    description: '看看能拿到什么',
    async run(args, ctx) { return { keys: Object.keys(ctx ?? {}).sort() }; },
  }],
};
`,
  });
  await loadPlugins({ dir, enabled: ['ctx'] });

  const tool = listTools()[0];
  // 按 executor 的真实约定调用：单个对象
  const out = await tool.run({
    args: {},
    origin: ORIGIN.OWNER_PRIVATE,
    convKey: 'private:1',
    client: {},
    config: {},
  });
  assert.deepEqual(out.keys, ['convKey', 'origin', 'roots', 'signal'], '不该把 client/config 递给插件');
});

test('参数真的传得到插件里（回归：曾把签名写成 (args, ctx) 导致参数丢失）', async () => {
  const dir = await makePluginDir({
    argtest: `
export default {
  name: 'argtest',
  tools: [{
    name: 'echo_back',
    needs: 'qq',
    risk: 'R0',
    description: '回显参数',
    params: { text: { type: 'string', required: true, description: '文字' } },
    async run(args) { return { got: args.text }; },
  }],
};
`,
  });
  await loadPlugins({ dir, enabled: ['argtest'] });

  const tool = listTools()[0];
  const out = await tool.run({ args: { text: '传进来了吗' }, origin: ORIGIN.OWNER_PRIVATE, convKey: 'private:1' });
  assert.deepEqual(out, { got: '传进来了吗' }, '参数必须原样到达插件');
});
