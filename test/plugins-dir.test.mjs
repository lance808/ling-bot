/**
 * 插件目录定位与旧目录迁移 —— F21
 *
 * ## 为什么这条值得单独测
 *
 * 插件目录从 `%APPDATA%\ling-bot\plugins` 改到了程序目录下。
 * 这个改动有两个隐蔽的破坏方式：
 *
 *   1. **出厂源与目标重合** —— 内置插件的出厂源在 `<程序>/plugins`，
 *      新默认目录也是 `<程序>/plugins`。`fs.cp(from, to)` 在 `from === to`
 *      时会往自己身上拷，可能把插件目录拷成 `dsh-bridge/dsh-bridge/...`，
 *      而这一步在启动流程里，出错会让"插件全挂"看起来像升级失败。
 *
 *   2. **旧插件静默消失** —— 用户在旧位置装的插件不在新目录里，
 *      配置写着启用、加载器报 0 个插件、界面一切正常。
 *      这种"什么都没发生"比报错难查得多。
 *
 * 两种都不会抛明显错误，所以必须用测试钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { programDir, resolvePluginsDir, resolvePaths } from '../src/config/paths.mjs';
import { installBuiltinPlugins, migrateLegacyPlugins, FACTORY_DIR } from '../src/tools/builtin-plugins.mjs';

/** 建一个临时目录，返回 {dir, cleanup} */
async function tmpDir(prefix = 'ling-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** 造一个最小插件 */
async function makePlugin(root, id, body = 'export default {};') {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', entry: 'index.mjs', tools: [] }),
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'index.mjs'), body, 'utf8');
  return dir;
}

const silentLog = { info: () => {}, warn: () => {} };

/* ------------------------------------------------------------ 路径 */

test('★ 插件目录默认在程序目录下，不在数据根下', () => {
  /*
   * 用户要求：「插件目录默认在项目文件夹下，而不是到 C 盘」。
   *
   * 这里用真实的数据根（AppData 的形状）验证：
   * 传进去的数据根不影响插件目录的结果。
   */
  const dataRoot = 'C:/Users/someone/AppData/Roaming/ling-bot';
  const p = resolvePaths(dataRoot);

  assert.equal(path.resolve(p.root), path.resolve(dataRoot), '数据根应该还是传入的那个');
  assert.equal(path.resolve(p.pluginsDir), path.resolve(path.join(programDir(), 'plugins')));
  assert.ok(
    !path.resolve(p.pluginsDir).startsWith(path.resolve(dataRoot)),
    `插件目录不该落在数据根里：${p.pluginsDir}`,
  );
});

test('★ 数据文件仍在数据根下（只有插件目录搬家了）', () => {
  /*
   * 这次只搬插件目录。配置、凭据、日志、会话如果跟着搬，
   * 用户的配置和 API Key 会"消失" —— 那是更严重的数据事故。
   */
  const dataRoot = 'C:/Users/someone/AppData/Roaming/ling-bot';
  const p = resolvePaths(dataRoot);
  for (const key of ['configPath', 'secretsPath', 'vaultPath', 'logsDir', 'stateDir', 'sessionsPath', 'diaryDir']) {
    assert.ok(
      path.resolve(p[key]).startsWith(path.resolve(dataRoot)),
      `${key} 应仍在数据根下，实际 ${p[key]}`,
    );
  }
});

test('LING_PLUGINS_DIR 能覆盖插件目录', () => {
  const prev = process.env.LING_PLUGINS_DIR;
  try {
    process.env.LING_PLUGINS_DIR = 'D:/somewhere/else/plugins';
    assert.equal(path.resolve(resolvePluginsDir('/data')), path.resolve('D:/somewhere/else/plugins'));
  } finally {
    if (prev === undefined) delete process.env.LING_PLUGINS_DIR;
    else process.env.LING_PLUGINS_DIR = prev;
  }
});

test('显式传入的 pluginsDir 优先级最高', () => {
  const got = resolvePluginsDir('/data', 'D:/explicit/plugins');
  assert.equal(path.resolve(got), path.resolve('D:/explicit/plugins'));
});

/* ------------------------------------------------------------ 出厂源重合 */

test('★ 出厂源与目标重合时，内置插件安装直接跳过（不自我拷贝）', async () => {
  /*
   * 这是本次改动最容易炸的一处：新默认目录 = `<程序>/plugins`，
   * 而内置插件的出厂源也在这里。
   *
   * 不跳过的话，`fs.cp` 会试图把目录拷到它自己里面，
   * 生成 `dsh-bridge/dsh-bridge/` 这种嵌套，而且每次启动都嵌一层。
   */
  const r = await installBuiltinPlugins({ pluginsDir: FACTORY_DIR, log: () => {} });

  assert.deepEqual(r.failed, [], `不该有失败项：${JSON.stringify(r.failed)}`);
  assert.equal(r.installed.length, 0, '路径相同时不该"安装"任何东西');

  /*
   * 关键：确认没有产生嵌套目录。
   * 这是"有没有自我拷贝"最直接的证据。
   */
  for (const name of ['dsh-bridge', 'echo']) {
    const nested = path.join(FACTORY_DIR, name, name);
    const has = await fs
      .access(nested)
      .then(() => true)
      .catch(() => false);
    assert.equal(has, false, `出厂源里出现了嵌套目录 ${nested}，说明发生了自我拷贝`);
  }
});

test('出厂源与目标不同时，内置插件仍然正常安装', async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const r = await installBuiltinPlugins({ pluginsDir: dir, log: () => {} });
    // 出厂源存在的话应该装过去；不存在（打包裁剪）则 skipped，两种都算正常
    assert.deepEqual(r.failed, [], `不该有失败项：${JSON.stringify(r.failed)}`);
    for (const name of r.installed) {
      const ok = await fs
        .access(path.join(dir, name, 'plugin.json'))
        .then(() => true)
        .catch(() => false);
      assert.ok(ok, `${name} 报告已安装，但目标里没有 plugin.json`);
    }
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------ 迁移 */

test('★ 旧目录里的插件会被补到新目录（不静默消失）', async () => {
  const legacyRoot = await tmpDir('ling-legacy-');
  const targetRoot = await tmpDir('ling-target-');
  try {
    const legacyPlugins = path.join(legacyRoot.dir, 'plugins');
    await fs.mkdir(legacyPlugins, { recursive: true });
    await makePlugin(legacyPlugins, 'my-plugin', 'export default { marker: "legacy" };');

    const r = await migrateLegacyPlugins(
      { root: legacyRoot.dir, pluginsDir: targetRoot.dir },
      silentLog,
    );

    assert.deepEqual(r.migrated, ['my-plugin'], '应该迁移过去');
    const moved = await fs.readFile(path.join(targetRoot.dir, 'my-plugin', 'index.mjs'), 'utf8');
    assert.match(moved, /legacy/, '内容要真的拷过来');
    const manifest = await fs
      .access(path.join(targetRoot.dir, 'my-plugin', 'plugin.json'))
      .then(() => true)
      .catch(() => false);
    assert.ok(manifest, 'plugin.json 也要跟过来');
  } finally {
    await legacyRoot.cleanup();
    await targetRoot.cleanup();
  }
});

test('★ 新目录已有同名插件时不覆盖（用户已在新位置改过）', async () => {
  /*
   * 反向覆盖是最坏的结果：用户已经在新位置修好了一个插件，
   * 启动一次就被旧副本冲掉，而且没有任何提示。
   */
  const legacyRoot = await tmpDir('ling-legacy-');
  const targetRoot = await tmpDir('ling-target-');
  try {
    const legacyPlugins = path.join(legacyRoot.dir, 'plugins');
    await fs.mkdir(legacyPlugins, { recursive: true });
    await makePlugin(legacyPlugins, 'same', 'export default { v: "old" };');

    await makePlugin(targetRoot.dir, 'same', 'export default { v: "new" };');

    const r = await migrateLegacyPlugins({ root: legacyRoot.dir, pluginsDir: targetRoot.dir }, silentLog);

    assert.deepEqual(r.migrated, [], '不该迁移');
    assert.deepEqual(r.skipped, ['same'], '应记为跳过');

    const kept = await fs.readFile(path.join(targetRoot.dir, 'same', 'index.mjs'), 'utf8');
    assert.match(kept, /new/, '新目录里的内容不能被旧副本冲掉');
  } finally {
    await legacyRoot.cleanup();
    await targetRoot.cleanup();
  }
});

test('★ 旧目录被保留（不删，删了不可逆）', async () => {
  const legacyRoot = await tmpDir('ling-legacy-');
  const targetRoot = await tmpDir('ling-target-');
  try {
    const legacyPlugins = path.join(legacyRoot.dir, 'plugins');
    await fs.mkdir(legacyPlugins, { recursive: true });
    await makePlugin(legacyPlugins, 'keep-me');

    await migrateLegacyPlugins({ root: legacyRoot.dir, pluginsDir: targetRoot.dir }, silentLog);

    const stillThere = await fs
      .access(path.join(legacyPlugins, 'keep-me', 'plugin.json'))
      .then(() => true)
      .catch(() => false);
    assert.ok(stillThere, '旧目录必须留着：删是不可逆的，留着最多占点空间');
  } finally {
    await legacyRoot.cleanup();
    await targetRoot.cleanup();
  }
});

test('没有旧目录时迁移安静返回（全新安装）', async () => {
  const targetRoot = await tmpDir('ling-target-');
  try {
    const r = await migrateLegacyPlugins({ root: targetRoot.dir, pluginsDir: targetRoot.dir }, silentLog);
    assert.deepEqual(r, { migrated: [], skipped: [] });
  } finally {
    await targetRoot.cleanup();
  }
});

test('旧目录与新目录相同时不做事（避免拷到自己身上）', async () => {
  const r = await tmpDir('ling-same-');
  try {
    const plugins = path.join(r.dir, 'plugins');
    await fs.mkdir(plugins, { recursive: true });
    await makePlugin(plugins, 'x');

    const out = await migrateLegacyPlugins({ root: r.dir, pluginsDir: plugins }, silentLog);
    assert.deepEqual(out, { migrated: [], skipped: [] });
  } finally {
    await r.cleanup();
  }
});

test('旧目录里有坏目录也不影响其它插件迁移', async () => {
  const legacyRoot = await tmpDir('ling-legacy-');
  const targetRoot = await tmpDir('ling-target-');
  try {
    const legacyPlugins = path.join(legacyRoot.dir, 'plugins');
    await fs.mkdir(legacyPlugins, { recursive: true });
    await makePlugin(legacyPlugins, 'good');
    // 一个没有 plugin.json 的目录（旧结构残留）
    await fs.mkdir(path.join(legacyPlugins, 'half'), { recursive: true });
    await fs.writeFile(path.join(legacyPlugins, 'half', 'index.mjs'), 'export default {};');

    const r = await migrateLegacyPlugins({ root: legacyRoot.dir, pluginsDir: targetRoot.dir }, silentLog);
    assert.ok(r.migrated.includes('good'), '好的插件要迁过去');
  } finally {
    await legacyRoot.cleanup();
    await targetRoot.cleanup();
  }
});

test('迁移不碰以 . 开头的目录（.backup / .staging）', async () => {
  const legacyRoot = await tmpDir('ling-legacy-');
  const targetRoot = await tmpDir('ling-target-');
  try {
    const legacyPlugins = path.join(legacyRoot.dir, 'plugins');
    await fs.mkdir(path.join(legacyPlugins, '.backup', 'old'), { recursive: true });
    await makePlugin(legacyPlugins, 'real');

    const r = await migrateLegacyPlugins({ root: legacyRoot.dir, pluginsDir: targetRoot.dir }, silentLog);
    assert.deepEqual(r.migrated, ['real'], '只迁真插件');
  } finally {
    await legacyRoot.cleanup();
    await targetRoot.cleanup();
  }
});
