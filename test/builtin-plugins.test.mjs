/**
 * 内置插件铺盘
 *
 * 这里守的核心规则只有一条：**不覆盖用户已有的文件**。
 * 覆盖是不可逆的数据损失；而不覆盖最坏只是"新版本没装上"，
 * 用户重装一次就好。两者的代价不对称。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { installBuiltinPlugins, BUILTIN_PLUGINS } from '../src/tools/builtin-plugins.mjs';
import { normalizeManifest } from '../src/plugins/manifest.mjs';
import { DEFAULT_CONFIG } from '../src/config/schema.mjs';

/** 造一个临时目标目录 */
async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ling-builtin-'));
}

test('首次运行会装好内置插件', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  try {
    const r = await installBuiltinPlugins({ pluginsDir: target });
    assert.deepEqual(r.failed, []);
    assert.ok(r.installed.includes('dsh-bridge'), '应该装上了 dsh-bridge');
    // 入口文件必须真的存在，否则加载器会跳过它
    await fs.access(path.join(target, 'dsh-bridge', 'index.mjs'));
    // lib 下的实现文件也要一起铺过去（插件必须自包含）
    await fs.access(path.join(target, 'dsh-bridge', 'lib', 'bridge.mjs'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ 版本没变时，已存在的文件不会被覆盖', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  const entry = path.join(target, 'dsh-bridge', 'index.mjs');
  try {
    // 先正常装一次（带版本标记），再模拟用户改了文件
    await installBuiltinPlugins({ pluginsDir: target });
    await fs.writeFile(entry, '// 用户自己改过的内容', 'utf8');

    const r = await installBuiltinPlugins({ pluginsDir: target });

    const after = await fs.readFile(entry, 'utf8');
    assert.equal(after, '// 用户自己改过的内容', '用户改动必须原样保留');
    assert.ok(r.skipped.includes('dsh-bridge'), '应记为跳过而不是新装');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没有版本标记的旧安装会被补齐（否则程序自己的升级进不去）', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  const entry = path.join(target, 'dsh-bridge', 'index.mjs');
  try {
    /*
     * 模拟"老版本装过，但没有 .builtin-version"这个状态。
     *
     * 注意必须同时写 plugin.json：骨架改造后**清单是唯一事实来源**，
     * 判断"装没装"看的是清单而不是入口文件。只有入口没有清单的目录
     * 会被判成"未安装"，于是走新装路径（同样会补齐文件）——
     * 两种路径都该得到"文件被补上"的结果。
     */
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, '// 老版本', 'utf8');
    await fs.writeFile(
      path.join(target, 'dsh-bridge', 'plugin.json'),
      JSON.stringify({ id: 'dsh-bridge', name: 'DSH', version: '0.0.1', apiVersion: '1', description: 'x' }),
      'utf8',
    );

    const r = await installBuiltinPlugins({ pluginsDir: target });
    assert.ok(r.installed.includes('dsh-bridge'), '没有版本标记应判为需要升级');
    assert.notEqual(await fs.readFile(entry, 'utf8'), '// 老版本');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('第二次运行是幂等的', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  try {
    const first = await installBuiltinPlugins({ pluginsDir: target });
    const second = await installBuiltinPlugins({ pluginsDir: target });
    assert.ok(first.installed.includes('dsh-bridge'));
    assert.ok(second.skipped.includes('dsh-bridge'));
    assert.deepEqual(second.installed, [], '第二次不该再算新装');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('目标目录不存在时会自己建', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'deep', 'nested', 'plugins');
  try {
    const r = await installBuiltinPlugins({ pluginsDir: target });
    assert.deepEqual(r.failed, []);
    await fs.access(path.join(target, 'dsh-bridge', 'index.mjs'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('清单里带默认启用的 dsh-bridge，外加示例 echo、正则回复、课程表、表情包与联网搜索', () => {
  // dsh-bridge 是默认启用的内置插件；echo 是随包的示例/验收插件；
  // regex-reply 是随包的「正则直达回复」插件（默认不启用，避免装上就自动在群里说话）；
  // course-schedule 是随包的课程表插件（默认不启用，要写按会话隔离的业务数据）；
  // stickers 是随包的表情包插件（默认不启用，会往 QQ 账号里写收藏）；
  // web-search 是随包的联网搜索插件（默认不启用，会往外发请求并吃搜索额度）。
  assert.deepEqual(
    BUILTIN_PLUGINS,
    ['dsh-bridge', 'echo', 'regex-reply', 'course-schedule', 'stickers', 'web-search', 'image-generation'],
  );
  assert.ok(BUILTIN_PLUGINS.includes('dsh-bridge'));
});

test('★ web-search 随包分发但默认不启用（联网必须由用户主动打开）', () => {
  /*
   * 三条同时成立才会有搜索工具：总闸开 + 插件启用 + 插件配了 Key。
   *
   * 总闸（network.enabled）缺省是 true，这是既有行为的延续；
   * 但"缺省开"不等于"装上就联网" —— 插件不在启用列表里，
   * 工具根本不会登记，也就没有任何出站请求。
   */
  assert.ok(BUILTIN_PLUGINS.includes('web-search'), '它必须在内置清单里，否则用户装不到');
  assert.ok(
    !DEFAULT_CONFIG.plugins.enabled.includes('web-search'),
    '它默认不启用：会往外发请求并消耗搜索额度，应由用户主动打开',
  );
  assert.equal(DEFAULT_CONFIG.network.enabled, true, '总闸缺省开（旧配置行为不变）');
});

test('★ stickers 随包分发但默认不启用', () => {
  /*
   * 它有两个"装上就生效"的坏处：
   *   1. 收藏是往 QQ 账号里写（R2、不可撤销、跨会话可见）；
   *   2. 内置默认人格写着「不用表情包」—— 默认启用会立刻出现
   *      "提示词说别用、工具却摆着"的分裂状态。
   */
  assert.ok(BUILTIN_PLUGINS.includes('stickers'), '它必须在内置清单里，否则用户装不到');
  assert.ok(
    !DEFAULT_CONFIG.plugins.enabled.includes('stickers'),
    '它默认不启用：收藏会改 QQ 账号，应由用户主动打开',
  );
});

test('★ regex-reply 随包分发但不默认启用（自动回复要由主人决定开不开）', () => {
  assert.ok(BUILTIN_PLUGINS.includes('regex-reply'), '它必须在内置清单里，否则装了也没有');
  // 默认启用列表来自 config schema：那里不该出现它
  assert.ok(
    !DEFAULT_CONFIG.plugins.enabled.includes('regex-reply'),
    '它默认不启用：自动回复会在群里说话，不能装上就开',
  );
});

test('★ course-schedule 随包分发但默认不启用', () => {
  /*
   * 铺盘 ≠ 启用。不铺过去，插件页里根本看不到这个目录，
   * 用户也就找不到"在哪启用它"；写上启用列表则等于替用户决定开始攒数据。
   */
  assert.ok(BUILTIN_PLUGINS.includes('course-schedule'), '它必须在内置清单里，否则用户装不到');
  assert.ok(
    !DEFAULT_CONFIG.plugins.enabled.includes('course-schedule'),
    '它默认不启用：课程表要写按会话隔离的业务数据，应由用户主动打开',
  );
});

test('★ course-schedule 铺过去之后清单与入口对得上、且能被宿主校验通过', async () => {
  /*
   * 这条是"声明与行为分离"的落点：清单说它有 8 个工具，入口就必须真的有 callTool。
   * course-schedule 是 runtime: process 的第三方风格插件，铺盘时最容易漏掉的
   * 恰恰是 lib/ 下的文件（它必须自包含）。
   */
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  try {
    const r = await installBuiltinPlugins({ pluginsDir: target });
    assert.deepEqual(r.failed, []);
    const pluginDir = path.join(target, 'course-schedule');

    const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.id, 'course-schedule');
    assert.equal(manifest.apiVersion, '1');
    /*
     * 这里**不**断言具体 runtime。
     *
     * 它改过——最初写 `process`（第三方风格），后来因为当前环境禁止 spawn
     * 子进程（`spawn EPERM`）改成 `in-process` + `trusted`。运行时是可调整的
     * 实现细节，铺盘测试该守的是"清单与入口对得上、宿主能校验通过"，
     * 把 runtime 钉死只会让合法改动变成假红灯。
     */
    assert.ok(['process', 'in-process'].includes(manifest.runtime), manifest.runtime);
    if (manifest.runtime === 'in-process') {
      assert.equal(manifest.trusted, true, 'in-process 必须显式 trusted');
    }
    assert.equal(manifest.tools.length, 8, '清单里声明的 8 个工具');

    // lib 下的实现文件要跟着铺过去，否则插件一 import 就 ENOENT
    for (const f of ['lib/store.mjs', 'lib/model.mjs', 'lib/time.mjs', 'lib/format.mjs']) {
      await fs.access(path.join(pluginDir, f));
    }

    // 入口能导入，且实现的是 callTool（新接口），不是旧的 run
    const mod = await import(`file://${path.join(pluginDir, 'index.mjs').replace(/\\/g, '/')}`);
    assert.equal(typeof mod.default?.callTool, 'function');
    assert.equal(mod.default?.tools, undefined, '入口不再声明 tools（在 plugin.json 里）');

    // 清单必须过宿主校验：这里同时覆盖了 object / 对象数组参数与 data.session
    const v = normalizeManifest(manifest, { dirName: 'course-schedule' });
    assert.equal(v.ok, true, v.message);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('不会把 node_modules 拷进去', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  try {
    await installBuiltinPlugins({ pluginsDir: target });
    // 内置插件本来就没有依赖；这条是防止以后有人加了依赖却没考虑体积
    const has = await fs
      .access(path.join(target, 'dsh-bridge', 'node_modules'))
      .then(() => true)
      .catch(() => false);
    assert.equal(has, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('铺过去的插件入口是合法的 ES 模块，且清单与入口对得上', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  try {
    await installBuiltinPlugins({ pluginsDir: target });
    // 真导入一次：能导入才算装好了，光有文件不算
    const mod = await import(`file://${path.join(target, 'dsh-bridge', 'index.mjs').replace(/\\/g, '/')}`);
    assert.equal(typeof mod.default, 'object');

    /*
     * 骨架改造后，工具声明搬到了 plugin.json —— 入口对象上**不该**再有 tools。
     * 这条断言就是那个分工：声明在清单，行为在代码。
     * 如果哪天有人把 tools 加回入口，就说明两层又混在一起了。
     */
    assert.equal(mod.default.tools, undefined, '入口不再声明 tools（在 plugin.json 里）');
    assert.equal(typeof mod.default.callTool, 'function', '入口要实现 callTool');
    assert.equal(typeof mod.default.handleMessage, 'function', '入口要实现 handleMessage');
    assert.equal(typeof mod.handleMessage, 'function', '兼容命名导出仍在');

    // 清单必须随包铺过去，且 id 与目录名一致
    const manifest = JSON.parse(
      await fs.readFile(path.join(target, 'dsh-bridge', 'plugin.json'), 'utf8'),
    );
    assert.equal(manifest.id, 'dsh-bridge');
    assert.equal(manifest.apiVersion, '1');
    assert.ok(Array.isArray(manifest.tools) && manifest.tools.length > 0, '清单里要有工具声明');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('★ 旧版目录（有入口、没清单）必须被迁移，不能留下"新清单 + 旧代码"', async () => {
  /*
   * 真踩到的线上 bug。
   *
   * 老用户的 <userData>/plugins/dsh-bridge/ 是骨架改造**之前**的结构：
   * 有 index.mjs（旧接口，工具带 run），没有 plugin.json。
   *
   * 旧逻辑只看 plugin.json 判断"装没装"，于是：
   *   isInstalled → false → 走"不覆盖已有文件"分支
   *   → 补上 plugin.json，旧 index.mjs 被 EEXIST 跳过
   *   → 加载时 E4041「声明了 tools 但入口没有实现 callTool()」
   *
   * 最阴的是它只坏一次：第二次启动 plugin.json 已存在，判定变成
   * "已安装"，这个坏状态被永久固化，再也不会自愈。
   */
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  const pluginDir = path.join(target, 'dsh-bridge');
  await fs.mkdir(pluginDir, { recursive: true });

  const LEGACY = `
export default {
  name: 'dsh-bridge',
  tools: [{ name: 'dsh_ask', needs: 'host', risk: 'R1', run: async () => ({ legacy: true }) }],
};
`;
  await fs.writeFile(path.join(pluginDir, 'index.mjs'), LEGACY, 'utf8');
  // 旧版有版本标记，但没有清单
  await fs.writeFile(path.join(pluginDir, '.builtin-version'), '4', 'utf8');

  try {
    await installBuiltinPlugins({ pluginsDir: target });

    // 清单补上了
    const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.id, 'dsh-bridge');

    // 关键：入口必须换成新接口
    const mod = await import('file:///' + path.join(pluginDir, 'index.mjs').replace(/\\/g, '/') + '?m=' + Date.now());
    assert.equal(typeof mod.default?.callTool, 'function', '入口要实现 callTool（新接口）');
    assert.equal(mod.default?.tools, undefined, '工具声明不该再挂在默认导出上');

    // 再跑一次：判定为已最新，且不能把好状态弄坏
    const r2 = await installBuiltinPlugins({ pluginsDir: target });
    assert.deepEqual(r2.installed, [], '第二次启动不该重复迁移');
    const again = await import('file:///' + path.join(pluginDir, 'index.mjs').replace(/\\/g, '/') + '?m=' + Date.now() + 'b');
    assert.equal(typeof again.default?.callTool, 'function', '第二次启动不该破坏入口');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
