/**
 * 插件骨架冒烟测试 —— 直接跑真实文件，不 mock
 *
 * 覆盖：清单校验、配置归一、工具策略推导、管理器扫描/启停/配置保存。
 *
 * 注意每个用例末尾都要 `mgr.shutdown()`：`process` 运行时会 fork 子进程，
 * 不收尾子进程会钉住事件循环，测试进程退不出去（表现为"测试挂起"）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  normalizeManifest,
  deriveToolPolicy,
  checkRiskAllowed,
  mintToken,
  isSafeRelative,
} from '../src/plugins/manifest.mjs';
import { coerceValue, resolveConfig, PluginConfigStore } from '../src/plugins/store.mjs';
import { PluginManager } from '../src/plugins/manager.mjs';
import { getTool, _clearToolsForTest } from '../src/tools/registry.mjs';

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');

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
        params: { text: { type: 'string', required: true } },
      },
    ],
    ...over,
  };
}

/**
 * 造一个管理器 + 可变的配置对象。
 *
 * @param {string} pluginsDir
 * @param {string} root
 */
function makeManager(pluginsDir, root) {
  let cfg = { plugins: { enabled: [], allowDangerous: false, config: {} } };
  const mgr = new PluginManager({
    pluginsDir,
    userDataRoot: root,
    secretsPath: path.join(root, 'secrets.vault'),
    getConfig: () => cfg,
    persistConfig: async (n) => {
      cfg = n;
    },
    log: () => {},
    sendText: async () => ({ ok: true }),
  });
  return { mgr, getCfg: () => cfg, setCfg: (n) => (cfg = n) };
}

/* ---------------------------------------------------------------- 清单 */

test('清单：合法的最小清单通过，并补全默认值', () => {
  const r = normalizeManifest(baseManifest(), { dirName: 'demo' });
  assert.equal(r.ok, true);
  assert.equal(r.manifest.runtime, 'process');
  assert.equal(r.manifest.entry, 'index.mjs');
  assert.equal(r.manifest.trusted, false);
  assert.equal(r.manifest.tools[0].fullName, 'plugin_ping');
  assert.equal(r.manifest.tools[0].timeoutMs, 20000);
});

test('清单：id 与目录名不一致必须拒绝', () => {
  const r = normalizeManifest(baseManifest(), { dirName: 'other' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4041');
  assert.match(r.message, /不一致/);
});

test('清单：apiVersion 主版本不兼容报 E4061', () => {
  const r = normalizeManifest(baseManifest({ apiVersion: '2' }), { dirName: 'demo' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4061');
});

test('清单：apiVersion 1.x 视为兼容', () => {
  const r = normalizeManifest(baseManifest({ apiVersion: '1.4' }), { dirName: 'demo' });
  assert.equal(r.ok, true);
});

test('清单：in-process 必须显式 trusted', () => {
  const bad = normalizeManifest(baseManifest({ runtime: 'in-process' }), { dirName: 'demo' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /trusted/);

  const good = normalizeManifest(baseManifest({ runtime: 'in-process', trusted: true }), { dirName: 'demo' });
  assert.equal(good.ok, true);
  assert.equal(good.manifest.trusted, true);
});

test('清单：既没 tools 也没 handleMessage 的插件被拒绝', () => {
  const r = normalizeManifest(baseManifest({ tools: [] }), { dirName: 'demo' });
  assert.equal(r.ok, false);
  assert.match(r.message, /tools/);

  const channel = normalizeManifest(baseManifest({ tools: [], handleMessage: true }), { dirName: 'demo' });
  assert.equal(channel.ok, true);
});

test('清单：entry 不能穿越目录', () => {
  for (const bad of ['../evil.mjs', '/etc/passwd', 'C:\\x.mjs', 'a/../../b.mjs']) {
    assert.equal(isSafeRelative(bad), false, bad);
  }
  assert.equal(isSafeRelative('index.mjs'), true);
  assert.equal(isSafeRelative('ui/page.mjs'), true);
});

test('清单：工具名与参数非法一律拒绝', () => {
  const badName = normalizeManifest(
    baseManifest({ tools: [{ name: 'Bad-Name', description: 'x', needs: 'qq' }] }),
    { dirName: 'demo' },
  );
  assert.equal(badName.ok, false);

  const badParam = normalizeManifest(
    baseManifest({
      tools: [{ name: 'ok_name', description: 'x', needs: 'qq', params: { a: { type: 'object' } } }],
    }),
    { dirName: 'demo' },
  );
  assert.equal(badParam.ok, false);
  assert.match(badParam.message, /类型不受支持/);
});

test('清单：插件内工具重名被拒绝', () => {
  const r = normalizeManifest(
    baseManifest({
      tools: [
        { name: 'dup', description: 'a', needs: 'qq' },
        { name: 'dup', description: 'b', needs: 'qq' },
      ],
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /重复/);
});

test('清单：配置项 password 隐含 secret，且不允许默认值', () => {
  const ok = normalizeManifest(baseManifest({ config: [{ key: 'tok', type: 'password' }] }), {
    dirName: 'demo',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.config[0].secret, true);

  const bad = normalizeManifest(
    baseManifest({ config: [{ key: 'tok', type: 'password', default: 'abc' }] }),
    { dirName: 'demo' },
  );
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不允许写默认值/);
});

test('清单：enum 选项两种写法都支持，缺省取第一项', () => {
  const r = normalizeManifest(
    baseManifest({ config: [{ key: 'mode', type: 'enum', options: ['a', { value: 'b', label: 'B' }] }] }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.manifest.config[0].options, [
    { value: 'a', label: 'a' },
    { value: 'b', label: 'B' },
  ]);
  assert.equal(r.manifest.config[0].default, 'a');
});

/* ---------------------------------------------------------------- 权限 */

test('权限：needs 决定 origins，插件无权声明', () => {
  const host = deriveToolPolicy({ needs: 'host', risk: 'R1' });
  assert.deepEqual(host.origins, ['owner-private', 'console']);
  assert.equal(host.kind, 'host');
  assert.equal(host.confirm, 'always');

  const qq = deriveToolPolicy({ needs: 'qq', risk: 'R0' });
  assert.deepEqual(qq.origins, ['owner-private', 'owner-group', 'console']);
  assert.equal(qq.confirm, 'never');
});

test('权限：R2/R3 需要显式放行', () => {
  assert.equal(checkRiskAllowed('R0', false).ok, true);
  assert.equal(checkRiskAllowed('R1', false).ok, true);
  assert.equal(checkRiskAllowed('R2', false).ok, false);
  assert.equal(checkRiskAllowed('R2', false).code, 'E4042');
  assert.equal(checkRiskAllowed('R3', true).ok, true);
});

test('令牌生成是 base64url 且每次不同', () => {
  const t = mintToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t, mintToken());
});

/* ---------------------------------------------------------------- 配置 */

test('配置：类型归一（字符串表单值 → number/boolean）', () => {
  const num = { key: 'n', label: 'N', type: 'number', min: 1, max: 10, integer: true };
  assert.deepEqual(coerceValue(num, '5'), { ok: true, value: 5 });
  assert.equal(coerceValue(num, '99').ok, false);
  assert.equal(coerceValue(num, '1.5').ok, false);

  const bool = { key: 'b', label: 'B', type: 'boolean', default: false };
  assert.deepEqual(coerceValue(bool, 'true'), { ok: true, value: true });
  assert.deepEqual(coerceValue(bool, 'false'), { ok: true, value: false });
  // 空字符串 = 未填 → 用默认值
  assert.deepEqual(coerceValue(bool, ''), { ok: true, value: false });
});

test('配置：必填缺失进 missing', () => {
  const decls = [
    { key: 'a', label: 'A', type: 'text', required: true, secret: false },
    { key: 'b', label: 'B', type: 'text', required: false, secret: false },
  ];
  const r = resolveConfig(decls, {}, {});
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['a']);
});

test('配置：密钥不进 config，只进 secrets', () => {
  const decls = [{ key: 'tok', label: '令牌', type: 'password', secret: true, required: true }];
  const r = resolveConfig(decls, { tok: '明文不该在这里' }, { tok: 'secret-value' });
  assert.equal(r.config.tok, '');
  assert.equal(r.secrets.tok, 'secret-value');
  assert.equal(r.ok, true);
});

test('配置：界面视图里密钥字段恒为空 + hasSecret', () => {
  const decls = [{ key: 'tok', label: '令牌', type: 'password', secret: true, required: true }];
  const view = PluginConfigStore.toView(decls, {}, { tok: 'x' });
  assert.equal(view[0].value, '');
  assert.equal(view[0].hasSecret, true);
});

test('配置：未声明的键被丢弃', () => {
  const decls = [{ key: 'keep', label: 'K', type: 'text', secret: false }];
  const r = resolveConfig(decls, { keep: 'v', removed: 'old' }, {});
  assert.equal(r.config.keep, 'v');
  assert.equal('removed' in r.config, false);
});

/* ---------------------------------------------------------------- 管理器 */

test('管理器：扫描磁盘、区分启用与未启用、识别坏清单', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-scan-'));
  const pluginsDir = path.join(root, 'plugins');
  await fs.mkdir(path.join(pluginsDir, 'good'), { recursive: true });
  await fs.writeFile(
    path.join(pluginsDir, 'good', 'plugin.json'),
    JSON.stringify(baseManifest({ id: 'good' })),
  );
  await fs.writeFile(path.join(pluginsDir, 'good', 'index.mjs'), 'export default {};');

  await fs.mkdir(path.join(pluginsDir, 'broken'), { recursive: true });
  await fs.writeFile(path.join(pluginsDir, 'broken', 'plugin.json'), '{ not json');

  await fs.mkdir(path.join(pluginsDir, 'nomanifest'), { recursive: true });

  const { mgr } = makeManager(pluginsDir, root);

  const found = await mgr.scan();
  assert.equal(found.get('good').manifest.id, 'good');
  assert.equal(found.get('broken').error.code, 'E4041');
  assert.equal(found.get('nomanifest').error.code, 'E4060');

  const r = await mgr.loadAll();
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.skipped.sort(), ['broken', 'good', 'nomanifest']);

  const snap = await mgr.snapshot();
  assert.equal(snap.stats.total, 3);
  // 只有 good 是"已安装未启用"；另外两个清单有问题，状态是 invalid
  assert.equal(snap.stats.disabled, 1);
  assert.equal(snap.stats.error, 2);

  await mgr.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

test('管理器：启用→工具登记→停用→工具立刻消失', async () => {
  _clearToolsForTest();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-life-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'demo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(baseManifest()));
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default {
      async init() { return { ok: true }; },
      async callTool({ tool, args }) { return { tool, echoed: args.text }; },
      async dispose() {},
    };`,
  );

  const { mgr } = makeManager(pluginsDir, root);

  await mgr.loadAll();
  assert.equal(getTool('plugin_ping'), undefined);

  const en = await mgr.enable('demo');
  assert.equal(en.ok, true, en.message);
  assert.equal(en.status, 'ready');

  const tool = getTool('plugin_ping');
  assert.ok(tool, '工具应当已登记');
  // 宿主推导，不是插件声明的
  assert.deepEqual(tool.origins, ['owner-private', 'owner-group', 'console']);
  assert.equal(tool.confirm, 'never');
  assert.equal(tool.plugin, 'demo');

  const out = await tool.run({ args: { text: 'hi' } });
  assert.deepEqual(out, { tool: 'ping', echoed: 'hi' });

  const dis = await mgr.disable('demo');
  assert.equal(dis.ok, true);
  assert.equal(getTool('plugin_ping'), undefined, '停用后工具必须立刻消失');

  await mgr.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

test('管理器：配置不完整时状态是 needs-config，不登记工具', async () => {
  _clearToolsForTest();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-cfg-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'needscfg');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      baseManifest({
        id: 'needscfg',
        config: [{ key: 'token', label: '令牌', type: 'password', secret: true, required: true }],
      }),
    ),
  );
  await fs.writeFile(path.join(dir, 'index.mjs'), 'export default { async callTool() { return 1; } };');

  const { mgr, setCfg } = makeManager(pluginsDir, root);
  setCfg({ plugins: { enabled: ['needscfg'], allowDangerous: false, config: {} } });

  const r = await mgr.loadAll();
  assert.deepEqual(r.failed, ['needscfg']);

  const snap = await mgr.snapshot();
  const item = snap.items.find((i) => i.id === 'needscfg');
  assert.equal(item.status, 'needs-config');
  assert.equal(item.error.code, 'E4063');
  assert.equal(getTool('plugin_ping'), undefined);

  await mgr.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

test('管理器：工具名冲突时整个插件不启用（不留半个插件）', async () => {
  _clearToolsForTest();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-dup-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'dup');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(baseManifest({ id: 'dup' })));
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default { async callTool() { return 1; }, async dispose() {} };`,
  );

  const { mgr } = makeManager(pluginsDir, root);
  await mgr.loadAll();
  const first = await mgr.enable('dup');
  assert.equal(first.ok, true);

  // 第二个插件用同一个工具名 → 必须整体失败
  const dir2 = path.join(pluginsDir, 'dup2');
  await fs.mkdir(dir2, { recursive: true });
  await fs.writeFile(path.join(dir2, 'plugin.json'), JSON.stringify(baseManifest({ id: 'dup2' })));
  await fs.writeFile(
    path.join(dir2, 'index.mjs'),
    `export default { async callTool() { return 2; }, async dispose() {} };`,
  );
  await mgr.rescan();
  const second = await mgr.enable('dup2');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E4043');

  // 第一个插件的工具还在（没被误删）
  assert.ok(getTool('plugin_ping'));

  await mgr.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

test('管理器：init 抛异常只影响自己，状态是 error', async () => {
  _clearToolsForTest();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-throw-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'boom');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(baseManifest({ id: 'boom' })));
  await fs.writeFile(
    path.join(dir, 'index.mjs'),
    `export default { async init() { throw new Error('炸了'); }, async callTool() { return 1; } };`,
  );

  const { mgr, setCfg } = makeManager(pluginsDir, root);
  setCfg({ plugins: { enabled: ['boom'], allowDangerous: false, config: {} } });

  const r = await mgr.loadAll();
  assert.deepEqual(r.failed, ['boom']);
  const snap = await mgr.snapshot();
  assert.equal(snap.items[0].status, 'error');
  assert.match(snap.items[0].error.message, /炸了/);
  assert.equal(getTool('plugin_ping'), undefined);

  await mgr.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

test('管理器：安装走暂存目录，失败不留半个包', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-inst-'));
  const pluginsDir = path.join(root, 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });

  const { mgr } = makeManager(pluginsDir, root);

  // 正常安装
  const src = path.join(root, 'src-demo');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'plugin.json'), JSON.stringify(baseManifest()));
  await fs.writeFile(path.join(src, 'index.mjs'), 'export default {};');

  const ok = await mgr.install(src);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.id, 'demo');
  assert.ok(await fs.stat(path.join(pluginsDir, 'demo', 'plugin.json')));

  // 坏包安装
  const badSrc = path.join(root, 'src-bad');
  await fs.mkdir(badSrc, { recursive: true });
  await fs.writeFile(path.join(badSrc, 'plugin.json'), JSON.stringify(baseManifest({ id: 'Bad Id' })));

  const bad = await mgr.install(badSrc);
  assert.equal(bad.ok, false);
  // 暂存目录必须清干净
  const leftovers = (await fs.readdir(pluginsDir)).filter((n) => n.startsWith('.staging'));
  assert.deepEqual(leftovers, []);

  await mgr.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

test('★ 未启用的插件也要有配置视图（否则新装的插件无从下手）', async () => {
  /*
   * 真踩到的坑：配置视图只在 startOne() 里算，而 startOne 只在启用时才跑。
   * 于是刚装好、还没启用的插件在插件页上配置区是**空的** ——
   * 而它恰恰是最需要填配置的时刻（必填项空着，点启用就被拒）。
   * 用户看到「配置」下面什么都没有，只会以为插件坏了。
   */
  _clearToolsForTest();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-plugin-cfgview-'));
  const pluginsDir = path.join(root, 'plugins');
  const dir = path.join(pluginsDir, 'fresh');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify(
      baseManifest({
        id: 'fresh',
        config: [
          { key: 'endpoint', label: '地址', type: 'text', default: 'https://example.test' },
          { key: 'token', label: '令牌', type: 'password', secret: true, required: true },
        ],
      }),
    ),
  );
  await fs.writeFile(path.join(dir, 'index.mjs'), 'export default { async callTool() { return 1; } };');

  const { mgr } = makeManager(pluginsDir, root);
  // 注意：enabled 是空的 —— 这个插件从未被启用过
  await mgr.loadAll();

  const snap = await mgr.snapshot();
  const item = snap.items.find((i) => i.id === 'fresh');
  assert.equal(item.enabled, false);
  assert.equal(item.status, 'disabled');

  // 关键断言：配置声明要在快照里，界面才有东西可渲染
  assert.equal(item.config.length, 2, '未启用时也要返回配置项声明');
  const endpoint = item.config.find((c) => c.key === 'endpoint');
  assert.equal(endpoint.value, 'https://example.test', '默认值要回填');
  const token = item.config.find((c) => c.key === 'token');
  assert.equal(token.secret, true);
  assert.equal(token.value, '', '密钥字段的 value 恒为空');
  assert.equal(token.hasSecret, false, '没存过就是 false');
  assert.equal(token.missing, true, '必填未填要标出来');

  await mgr.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

test('仓库里的出厂插件清单都能通过校验', async () => {
  for (const id of ['dsh-bridge', 'echo']) {
    const dir = path.join(REPO, 'plugins', id);
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    const r = normalizeManifest(raw, { dirName: id });
    assert.equal(r.ok, true, `${id}: ${r.message}`);
    assert.equal(r.manifest.id, id);
  }
});
