/**
 * regex-reply 的**宿主行为**测试 —— 用真实宿主模块，不启后端、不连 QQ
 *
 * ## 这个文件和 `regex-reply.test.mjs` 的分工
 *
 * 那个文件测"插件自己怎么判定"；这个文件测"宿主怎么对待它"：
 *
 *   1. 清单能被真实 `normalizeManifest` 接受，两个新字段被正确落进 manifest；
 *   2. `PluginManager.dispatchMessage` 的**两轮派发**真的让 normal 先跑、
 *      low 后跑，而且 normal 认领之后 low 根本不被调用；
 *   3. 真实 `ConfirmRegistry` 算出 `confirmPending` 之后，低优先级插件
 *      不会抢走确认形回复；
 *   4. 旧插件（`plugins/echo`）的清单归一结果里，两个新字段取默认值
 *      （`'normal'` / `false`）—— 这是"旧插件行为完全不变"的可执行断言；
 *   5. 保存配置时 `validateConfig` 在**落盘之前**生效（坏规则存不进去）。
 *
 * ## 为什么必须用真实模块而不是 mock
 *
 * 这一组断言的全是**顺序**与**时机**：谁先被调用、校验发生在写盘前还是后。
 * mock 出来的宿主只能验证"我以为的顺序"，而这次改动的全部风险恰好在于
 * "真实代码里的顺序和以为的不一样"。所以这里真的建 `PluginManager`、
 * 真的从磁盘加载插件、真的 import 插件入口。
 *
 * ## 临时目录
 *
 * 每个用例在一个独立临时目录里造 plugins 目录（把真实的
 * `plugins/regex-reply` 整个拷进去 + 一个假的 `dsh-bridge` 占位），
 * 用完在 `finally` / `t.after` 里删干净 —— 不在仓库里留任何东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeManifest } from '../src/plugins/manifest.mjs';
import { PluginManager } from '../src/plugins/manager.mjs';
import { ConfirmRegistry } from '../src/guard/confirm.mjs';
import { readJson } from '../src/config/atomic.mjs';

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const REAL_PLUGIN_DIR = path.join(REPO, 'plugins', 'regex-reply');

/* ------------------------------------------------------------------ 工具 */

/**
 * 造一条与宿主一致的 `evt`。
 *
 * @param {string} text
 * @param {Record<string, any>} [over]
 * @returns {object}
 */
function makeEvt(text, over = {}) {
  return {
    kind: 'message',
    convKey: 'group:1001',
    isGroup: true,
    messageId: 'm1',
    sender: { userId: '2001', nickname: '小明' },
    text,
    atSelf: false,
    ...over,
  };
}

/** 默认 gate（宿主在 dispatchToPlugins 里算出来的那份形状）。 */
function makeGate(over = {}) {
  return { whitelisted: true, silenced: false, confirmPending: false, selfId: '9999', ...over };
}

/**
 * 在临时目录里造一份插件根目录。
 *
 * ## 假 dsh-bridge 为什么写 globalThis
 *
 * `InProcessRuntime` import 入口时加了 `?v=<timestamp>` 查询串，
 * 所以**测试 import 的那份**和**管理器 import 的那份**是两个模块实例，
 * 模块级变量不共享。要跨这个边界传信号，`globalThis` 是唯一不依赖
 * 模块缓存的手段。
 *
 * @param {object} opts
 * @param {string} opts.pluginsDir
 * @param {object} opts.regexConfig regex-reply 的配置
 * @param {boolean} [opts.withRegexReply] 是否拷入真实的 regex-reply
 * @returns {Promise<void>}
 */
async function seedPluginsDir({ pluginsDir, regexConfig, withRegexReply = true }) {
  await fs.mkdir(pluginsDir, { recursive: true });

  if (withRegexReply) {
    await fs.cp(REAL_PLUGIN_DIR, path.join(pluginsDir, 'regex-reply'), { recursive: true });
  }

  /* ---- 假 dsh-bridge：normal 优先级的"归属明确接管者" ---- */
  const stubDir = path.join(pluginsDir, 'dsh-bridge');
  await fs.mkdir(stubDir, { recursive: true });

  await fs.writeFile(
    path.join(stubDir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'dsh-bridge',
        name: 'DSH 接入（占位）',
        version: '1.0.0',
        apiVersion: '1',
        description: '测试占位：模拟 dsh-bridge 的审批接管（normal 优先级）。',
        runtime: 'in-process',
        trusted: true,
        entry: 'index.mjs',
        handleMessage: true,
        permissions: ['qq.read'],
        tools: [],
        notes: [{ title: '占位', lines: ['只用于优先级测试。'] }],
      },
      null,
      2,
    ),
    'utf8',
  );

  /*
   * 行为：仅当文本在 `globalThis.__stubHandled` 里时返回 true，
   * 并把每次被调用的文本记下来。
   *
   * 用全局数组而不是返回值来验证"谁先被调用"：这是唯一能证明
   * "low 插件根本没被调用"（而不只是"它的结果被忽略"）的方式。
   */
  await fs.writeFile(
    path.join(stubDir, 'index.mjs'),
    `/**
 * 测试占位插件：模拟 dsh-bridge 的消息接管（normal 优先级）。
 *
 * 只做一件事：把每次被调用的文本记到 globalThis，并在文本命中
 * globalThis.__stubHandled 时认领这条消息。
 */
export default {
  async init() {
    globalThis.__stubInit = (globalThis.__stubInit ?? 0) + 1;
    return { ok: true };
  },
  async dispose() {},
  async handleMessage({ evt }) {
    const text = String(evt?.text ?? '');
    (globalThis.__stubCalls ??= []).push(text);
    const handled = globalThis.__stubHandled ?? [];
    return handled.includes(text);
  },
};
`,
    'utf8',
  );

  // ---- 配置（模拟 config.json 里的 plugins 段）----
  globalThis.__stubCalls = [];
  globalThis.__stubHandled = [];
  globalThis.__regexConfig = regexConfig;
}

/**
 * 造一个真实的 PluginManager + 可变配置。
 *
 * @param {{pluginsDir: string, root: string, getCfg: () => any, setCfg: (n: any) => void}} env
 * @returns {{mgr: PluginManager, sent: Array<{convKey: string, text: string}>, logs: Array<[string, string]>}}
 */
function makeManager(env) {
  /** @type {Array<{convKey: string, text: string}>} */
  const sent = [];
  /** @type {Array<[string, string]>} */
  const logs = [];

  const mgr = new PluginManager({
    pluginsDir: env.pluginsDir,
    userDataRoot: env.root,
    secretsPath: path.join(env.root, 'secrets.vault'),
    getConfig: env.getCfg,
    persistConfig: async (n) => {
      env.setCfg(n);
    },
    log: (level, message) => logs.push([String(level), String(message)]),
    sendText: async (convKey, text) => {
      sent.push({ convKey: String(convKey), text: String(text) });
      return { ok: true, messageId: `mid-${sent.length}` };
    },
  });

  return { mgr, sent, logs };
}

/**
 * 建一个完整的宿主环境：临时目录 + 插件 + 管理器，并完成一次 loadAll。
 *
 * @param {NodeJS.TestContext} t
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.regexConfig] regex-reply 的配置部分
 * @param {boolean} [opts.withRegexReply]
 * @returns {Promise<{mgr: PluginManager, sent: any[], logs: any[], pluginsDir: string, root: string, getCfg: () => any, setCfg: (n: any) => void}>}
 */
async function setup(t, opts = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-reply-host-'));
  const pluginsDir = path.join(root, 'plugins');

  await seedPluginsDir({
    pluginsDir,
    regexConfig: opts.regexConfig ?? {},
    withRegexReply: opts.withRegexReply !== false,
  });

  let cfg = {
    plugins: {
      // 刻意把 regex-reply 排在前面：用来证明"派发顺序不取决于 records 顺序"
      enabled: opts.withRegexReply === false ? ['dsh-bridge'] : ['regex-reply', 'dsh-bridge'],
      allowDangerous: false,
      config: {
        'regex-reply': opts.regexConfig ?? {},
      },
    },
  };

  const env = {
    pluginsDir,
    root,
    getCfg: () => cfg,
    setCfg: (n) => {
      cfg = n;
    },
  };

  const { mgr, sent, logs } = makeManager(env);
  const loaded = await mgr.loadAll();

  t.after(async () => {
    // 先释放插件（杀掉 regex-reply 的 worker），否则 worker 会钉住事件循环
    try {
      await mgr.shutdown();
    } catch {
      /* 收尾失败不该掩盖断言失败 */
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  return { mgr, sent, logs, pluginsDir, root, getCfg: env.getCfg, setCfg: env.setCfg, loaded };
}

/* ---------------------------------------------------------------- 清单 */

test('清单：真实 plugin.json 通过 normalizeManifest，两个新字段落进 manifest', async () => {
  const raw = await readJson(path.join(REAL_PLUGIN_DIR, 'plugin.json'));
  const r = normalizeManifest(raw, { dirName: 'regex-reply' });

  assert.equal(r.ok, true, r.ok ? '' : `清单不合法：${r.code} ${r.message}`);

  const m = r.manifest;
  assert.equal(m.id, 'regex-reply');
  assert.equal(m.apiVersion, '1');
  assert.equal(m.runtime, 'in-process');
  assert.equal(m.trusted, true, 'in-process 必须 trusted: true');
  assert.equal(m.handleMessage, true, '纯通道插件必须声明 handleMessage');
  assert.equal(m.messagePriority, 'low', '必须声明 low，否则会抢在 dsh-bridge 前面');
  assert.equal(m.validateConfig, true, '必须在保存前自校验规则');

  // tools 为空是合法的（纯通道插件）
  assert.deepEqual(m.tools, []);
  assert.equal(m.entry, 'index.mjs');
  assert.ok(m.permissions.includes('qq.read'));
  assert.ok(m.permissions.includes('qq.send'));

  // 两个新字段不能被当成"未知键"
  assert.ok(!m.unknownKeys.includes('messagePriority'));
  assert.ok(!m.unknownKeys.includes('validateConfig'));

  // notes 至少两组：怎么用、安全边界
  assert.ok(m.notes.length >= 2);
  assert.ok(m.notes.some((n) => n.title === '怎么用'));
  assert.ok(m.notes.some((n) => n.title === '安全边界'));
});

test('清单：config 项形状合法（类型/范围/默认值/help 长度）', async () => {
  const raw = await readJson(path.join(REAL_PLUGIN_DIR, 'plugin.json'));
  const r = normalizeManifest(raw, { dirName: 'regex-reply' });
  assert.equal(r.ok, true);

  const byKey = new Map(r.manifest.config.map((c) => [c.key, c]));
  // 顺序即界面顺序：规则输入框必须排第一
  assert.equal(r.manifest.config[0].key, 'rules');

  const expectations = [
    ['rules', 'textarea', '[]'],
    ['enabled', 'boolean', true],
    ['defaultCooldownMs', 'number', 0],
    ['maxRepliesPerMinute', 'number', 6],
    ['maxRepliesPerHour', 'number', 60],
    ['maxInputLength', 'number', 500],
    ['matchTimeoutMs', 'number', 50],
    ['multiMatch', 'enum', 'priority'],
    ['replyOnSendFail', 'boolean', false],
  ];
  for (const [key, type, def] of expectations) {
    const spec = byKey.get(key);
    assert.ok(spec, `缺配置项 ${key}`);
    assert.equal(spec.type, type, `${key} 的 type`);
    assert.deepEqual(spec.default, def, `${key} 的默认值`);
    assert.ok(spec.help.length > 0, `${key} 必须有 help`);
    assert.ok(spec.help.length <= 300, `${key} 的 help 超过 300 字符`);
  }

  // 数值项的范围必须与 LIMITS 对齐（文档与实现不能各写一套）
  assert.equal(byKey.get('defaultCooldownMs').min, 0);
  assert.equal(byKey.get('defaultCooldownMs').max, 86_400_000);
  assert.equal(byKey.get('defaultCooldownMs').integer, true);
  assert.equal(byKey.get('maxRepliesPerMinute').min, 1);
  assert.equal(byKey.get('maxRepliesPerMinute').max, 60);
  assert.equal(byKey.get('maxRepliesPerHour').min, 1);
  assert.equal(byKey.get('maxRepliesPerHour').max, 600);
  assert.equal(byKey.get('maxInputLength').min, 1);
  assert.equal(byKey.get('maxInputLength').max, 4000);
  assert.equal(byKey.get('matchTimeoutMs').min, 5);
  assert.equal(byKey.get('matchTimeoutMs').max, 500);
  assert.equal(byKey.get('rules').maxLength, 60_000);

  // enum 选项
  assert.deepEqual(
    byKey.get('multiMatch').options.map((o) => o.value),
    ['priority', 'all'],
  );
});

test('清单：旧插件 echo 的两个新字段取默认值（messagePriority normal / validateConfig false）', async () => {
  const raw = await readJson(path.join(REPO, 'plugins', 'echo', 'plugin.json'));
  const r = normalizeManifest(raw, { dirName: 'echo' });

  assert.equal(r.ok, true);
  // 旧插件没有写这两个字段 —— 归一结果必须是"等于没写"的语义
  assert.equal(r.manifest.messagePriority, 'normal', '旧插件必须默认 normal，不能变成 low');
  assert.equal(r.manifest.validateConfig, false, '旧插件不该被要求实现 validateConfig');
  assert.equal(r.manifest.handleMessage, false);
  assert.equal(r.manifest.runtime, 'process');
  // 它们也不能出现在 unknownKeys 里（否则界面会提示"有未识别字段"）
  assert.ok(!r.manifest.unknownKeys.includes('messagePriority'));
  assert.ok(!r.manifest.unknownKeys.includes('validateConfig'));
});

test('清单：messagePriority 的约束仍然生效（process 插件声明 low 会被拒）', () => {
  const base = {
    id: 'demo',
    name: '演示',
    version: '1.0.0',
    apiVersion: '1',
    description: '演示',
    handleMessage: true,
    tools: [],
  };

  // process 插件收不到消息，声明 low 是无意义的假开关
  const bad = normalizeManifest({ ...base, runtime: 'process', messagePriority: 'low' }, { dirName: 'demo' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /in-process/);

  // 没有 handleMessage 却声明 low：没有作用对象
  const bad2 = normalizeManifest(
    { ...base, runtime: 'in-process', trusted: true, handleMessage: false, messagePriority: 'low' },
    { dirName: 'demo' },
  );
  assert.equal(bad2.ok, false);
  assert.match(bad2.message, /handleMessage/);

  // 非 in-process 插件声明 validateConfig 会被拒。
  // 这里必须带一个工具，否则会先撞上"既没 tools 也没 handleMessage"那条校验，
  // 测不到 validateConfig 本身。
  const bad3 = normalizeManifest(
    {
      ...base,
      handleMessage: false,
      validateConfig: true,
      tools: [{ name: 'ping', description: 'ping', needs: 'qq', risk: 'R0' }],
    },
    { dirName: 'demo' },
  );
  assert.equal(bad3.ok, false);
  assert.match(bad3.message, /validateConfig/);
});

/* ------------------------------------------------------------ 派发顺序 */

test('★ 派发优先级：normal 插件认领时 low 插件根本不被调用', async (t) => {
  const env = await setup(t, {
    regexConfig: {
      // 这条规则能匹配 "approve"：如果顺序错了，regex-reply 会先回一句
      rules: JSON.stringify([{ id: 'approve', pattern: '^approve$', reply: '正则也想回' }]),
    },
  });

  // 两个插件都必须真的起来了，否则这个测试证明不了任何东西
  const snapshot = await env.mgr.snapshot();
  const ready = snapshot.items.filter((i) => i.status === 'ready').map((i) => i.id);
  assert.deepEqual(ready.sort(), ['dsh-bridge', 'regex-reply']);

  // 让占位 dsh-bridge 认领 "approve"
  globalThis.__stubHandled = ['approve'];
  globalThis.__stubCalls = [];

  const handled = await env.mgr.dispatchMessage(makeEvt('approve'), makeGate());

  assert.equal(handled, true, '应由 normal 插件认领');
  // 关键断言：low 插件一次都没被调用过（不是"调用了但结果被忽略"）
  assert.deepEqual(globalThis.__stubCalls, ['approve']);
  assert.equal(env.sent.length, 0, 'regex-reply 不该发出任何消息');
});

test('★ 派发优先级：normal 返回 false 之后才轮到 low', async (t) => {
  const env = await setup(t, {
    regexConfig: {
      rules: JSON.stringify([{ id: 'hi', pattern: '^你好$', reply: '你好呀，{user}' }]),
    },
  });

  globalThis.__stubHandled = ['approve'];
  globalThis.__stubCalls = [];

  // 普通文本：dsh-bridge 明确说"不是我的"，于是落到 regex-reply
  const handled = await env.mgr.dispatchMessage(makeEvt('你好'), makeGate());

  assert.equal(handled, true);
  assert.deepEqual(globalThis.__stubCalls, ['你好'], 'normal 先被问到');
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].text, '你好呀，小明');
});

test('派发优先级：两条消息分别走不同插件，互不影响', async (t) => {
  const env = await setup(t, {
    regexConfig: {
      rules: JSON.stringify([{ id: 'hi', pattern: '^你好$', reply: '正则回复' }]),
    },
  });

  globalThis.__stubHandled = ['approve'];
  globalThis.__stubCalls = [];

  assert.equal(await env.mgr.dispatchMessage(makeEvt('approve'), makeGate()), true);
  assert.equal(await env.mgr.dispatchMessage(makeEvt('你好'), makeGate()), true);
  assert.equal(await env.mgr.dispatchMessage(makeEvt('无关内容'), makeGate()), false);

  assert.deepEqual(globalThis.__stubCalls, ['approve', '你好', '无关内容']);
  // 只有"你好"那一条被正则插件回了
  assert.deepEqual(
    env.sent.map((s) => s.text),
    ['正则回复'],
  );
});

/* ------------------------------------------------------------ 审批不被抢 */

test('★ 真实 ConfirmRegistry：confirmPending 为 true 时 low 插件不抢确认形回复', async (t) => {
  const env = await setup(t, {
    regexConfig: {
      // 规则特意能匹配 "1"，用来证明拦下它的是 gate 而不是"规则写不出来"
      rules: JSON.stringify([{ id: 'one', pattern: '^1$', reply: '收到 1' }]),
    },
  });

  const confirms = new ConfirmRegistry({ timeoutMs: 60_000 });
  let entry;
  try {
    entry = confirms.register({
      tool: 'plugin_demo',
      risk: 'R1',
      args: {},
      convKey: 'group:1001',
      replyConvKey: 'group:1001',
      allowedSenders: ['2001'],
    });

    // 宿主的宽口径：本会话本人名下有未结算确认就为 true
    assert.equal(confirms.hasActionable('group:1001', '2001'), true);
    assert.equal(confirms.hasActionable('group:2002', '2001'), false, '别的群不该有可处理确认');

    globalThis.__stubHandled = [];
    globalThis.__stubCalls = [];

    const gate = makeGate({ confirmPending: confirms.hasActionable('group:1001', '2001') });
    const handled = await env.mgr.dispatchMessage(makeEvt('1'), gate);

    assert.equal(handled, false, '有待确认时这条 "1" 不能被正则插件接管');
    assert.equal(env.sent.length, 0);

    // 同一个文本、同一份规则，没有待确认时就该正常命中 ——
    // 这一半证明"是 gate 在起作用"，而不是规则写错了
    const handled2 = await env.mgr.dispatchMessage(
      makeEvt('1', { convKey: 'group:2002' }),
      makeGate({ confirmPending: confirms.hasActionable('group:2002', '2001') }),
    );
    assert.equal(handled2, true);
    assert.deepEqual(
      env.sent.map((s) => s.text),
      ['收到 1'],
    );
  } finally {
    confirms.cancelAll('shutdown');
    // 让挂起的 promise 有个结论，避免未处理的 rejection 干扰后续用例
    void entry?.promise?.catch?.(() => {});
  }
});

test('真实 ConfirmRegistry：静音与白名单同样在派发前被遵守', async (t) => {
  const env = await setup(t, {
    regexConfig: {
      rules: JSON.stringify([{ id: 'hi', pattern: '^你好$', reply: '不该发出' }]),
    },
  });

  globalThis.__stubHandled = [];
  globalThis.__stubCalls = [];

  assert.equal(
    await env.mgr.dispatchMessage(makeEvt('你好'), makeGate({ silenced: true })),
    false,
    '静音时不该接管',
  );
  assert.equal(
    await env.mgr.dispatchMessage(makeEvt('你好'), makeGate({ whitelisted: false })),
    false,
    '白名单不通过时不该接管',
  );
  assert.equal(
    await env.mgr.dispatchMessage(
      makeEvt('你好', { sender: { userId: '9999', nickname: '自己' } }),
      makeGate(),
    ),
    false,
    '自消息不该接管',
  );
  assert.equal(env.sent.length, 0);
});

/* -------------------------------------------------- 保存前的规则自校验 */

test('★ 保存配置：坏规则在落盘之前就被拦下，旧配置不被覆盖', async (t) => {
  const goodRules = JSON.stringify([{ id: 'hi', pattern: '^你好$', reply: '你好呀' }]);
  const env = await setup(t, { regexConfig: { rules: goodRules } });

  // 先确认它已经跑起来了
  const before = await env.mgr.snapshot();
  const item = before.items.find((i) => i.id === 'regex-reply');
  assert.equal(item.status, 'ready', `插件应已就绪，实际 ${item.status}：${item.error?.message ?? ''}`);

  const savedBefore = JSON.parse(JSON.stringify(env.getCfg()));

  // 第 2 条是坏正则（u 模式下的 identity escape）
  const badRules = JSON.stringify([
    { id: 'ok', pattern: '^a$', reply: 'ok' },
    { id: 'broken', pattern: '^a\\-b$', reply: 'x' },
  ]);

  const r = await env.mgr.saveConfig('regex-reply', { config: { rules: badRules } });

  assert.equal(r.ok, false, '坏规则必须保存失败');
  assert.match(r.message, /第 2 条/, `报错要能定位到第几条，实际：${r.message}`);

  // ---- 关键：没写盘 ----
  const cfgAfter = env.getCfg();
  assert.deepEqual(
    cfgAfter.plugins.config['regex-reply'],
    savedBefore.plugins.config['regex-reply'],
    '保存失败时磁盘配置必须保持原样（否则用户会丢掉那份能用的配置）',
  );

  // 插件仍在正常工作：说明既没写盘、也没被一次坏配置弄坏
  globalThis.__stubHandled = [];
  globalThis.__stubCalls = [];
  assert.equal(await env.mgr.dispatchMessage(makeEvt('你好'), makeGate()), true);
  assert.equal(env.sent.at(-1).text, '你好呀');
});

test('保存配置：合法规则能存进去并生效', async (t) => {
  const env = await setup(t, { regexConfig: { rules: '[]' } });

  const r = await env.mgr.saveConfig('regex-reply', {
    config: { rules: JSON.stringify([{ id: 'new-one', pattern: '^新规则$', reply: '生效了' }]) },
  });
  assert.equal(r.ok, true, `合法配置应保存成功：${r.message}`);

  /*
   * ★ 保存配置后**不该**提示需要重启。
   *
   * 这条守的是一个真实缺陷：`saveConfig` 原来对 in-process 插件无条件返回
   * `restartRequired: true`。于是改一条正则规则、点保存，界面弹的是
   * 「配置已保存，但需要重启后端才能彻底生效」—— 而配置其实已经生效
   * （保存只改 config.json，紧接着 dispose→init 重新读过一遍）。
   *
   * 后果不是"多一句提示"，而是用户要么白重启一次，要么以为规则没生效
   * 而反复保存。契约 §5.6 也写明只有**确实需要**重启时才该返回 true。
   */
  assert.equal(
    r.restartRequired,
    false,
    '保存配置不该要求重启：配置已通过 dispose→init 生效',
  );
  assert.doesNotMatch(
    String(r.message),
    /重启/,
    `保存配置的提示里不该出现"重启"，实际：${r.message}`,
  );

  globalThis.__stubHandled = [];
  globalThis.__stubCalls = [];
  assert.equal(await env.mgr.dispatchMessage(makeEvt('新规则'), makeGate()), true);
  assert.equal(env.sent.at(-1).text, '生效了');
});
