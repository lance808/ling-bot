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
    // 模拟"老版本装过，但没有 .builtin-version"这个状态
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, '// 老版本', 'utf8');

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

test('清单里只有 dsh-bridge（默认启用的那个）', () => {
  assert.deepEqual(BUILTIN_PLUGINS, ['dsh-bridge']);
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

test('铺过去的插件入口是合法的 ES 模块', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'plugins');
  try {
    await installBuiltinPlugins({ pluginsDir: target });
    // 真导入一次：能导入才算装好了，光有文件不算
    const mod = await import(`file://${path.join(target, 'dsh-bridge', 'index.mjs').replace(/\\/g, '/')}`);
    assert.equal(typeof mod.default, 'object');
    assert.ok(Array.isArray(mod.default.tools));
    assert.equal(typeof mod.handleMessage, 'function');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
