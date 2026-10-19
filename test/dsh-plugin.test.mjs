/**
 * dsh-qq-bridge 插件侧逻辑
 *
 * 这里测的都是**判定**，不碰 DSH 运行时：
 * 管理员解析、不可达策略、结论词表、桥客户端行为。
 *
 * 为什么不测 `apply()`：它要真实 ctx（事件总线、effect 作用域），
 * 造一个假 ctx 只能证明"假 ctx 能跑"，证明不了真 DSH 里能跑。
 * 那部分靠实测（安装后真跑一轮），单元测试守的是判定逻辑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = () =>
  readFileSync(new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url), 'utf8');

import {
  parseAdmins,
  isAdmin,
  unreachableOutcome,
} from '../dsh-plugin/dsh-qq-bridge/lib/logic.js';

// index.js 顶部要 import schemastery（只存在于 DSH profile），
// 所以这里用动态导入并容忍失败：
// 环境里没有它就跳过 BridgeClient 相关用例，而不是让整个文件崩掉。
let BridgeClient = null;
let pluginName = '';
let NS = '';
try {
  const mod = await import('../dsh-plugin/dsh-qq-bridge/lib/index.js');
  BridgeClient = mod.BridgeClient;
  pluginName = mod.name;
  NS = mod.NS;
} catch {
  // 没装 DSH 依赖：只跑纯判定测试
}

/* ---------------------------------------------------------------- 基本声明 */

test('插件名与命名空间一致（loader entry id 必须等于包名）', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, () => {
  assert.equal(pluginName, 'dsh-qq-bridge');
  assert.equal(NS, 'dsh-qq-bridge');
});

/* ---------------------------------------------------------------- 管理员 */

test('管理员列表容忍各种分隔符', () => {
  assert.deepEqual(parseAdmins('10001'), ['10001']);
  assert.deepEqual(parseAdmins('10001,10002'), ['10001', '10002']);
  assert.deepEqual(parseAdmins('10001，10002'), ['10001', '10002']); // 全角逗号
  assert.deepEqual(parseAdmins('10001、10002'), ['10001', '10002']); // 顿号
  assert.deepEqual(parseAdmins(' 10001  10002 '), ['10001', '10002']); // 空格
});

test('★ 非法内容不会被当成管理员', () => {
  // 空、纯字母、太短、带冒号（防止有人塞 "10001:admin" 这类想绕过的写法）
  assert.deepEqual(parseAdmins(''), []);
  assert.deepEqual(parseAdmins('admin'), []);
  assert.deepEqual(parseAdmins('123'), []);
  assert.deepEqual(parseAdmins('10001:admin'), []);
  assert.deepEqual(parseAdmins('../../etc/passwd'), []);
});

test('管理员判定严格相等，不做前缀/包含匹配', () => {
  const admins = ['10001'];
  assert.equal(isAdmin('10001', admins), true);
  assert.equal(isAdmin('1000', admins), false);
  assert.equal(isAdmin('100011', admins), false);
  // 数字与字符串要能对上（QQ 号来自不同来源时类型可能不同）
  assert.equal(isAdmin(10001, admins), true);
});

/* ---------------------------------------------------------------- 不可达策略 */

test('★ 默认策略是 delegate（交还 DSH），不是拒绝', () => {
  // 这是本插件最重要的一条：QQ 掉线不该让所有任务失败。
  // 返回 null = 调 next() 交回 DSH 自己的策略。
  assert.equal(unreachableOutcome(''), null);
  assert.equal(unreachableOutcome('delegate'), null);
  assert.equal(unreachableOutcome('随便什么'), null);
});

test('显式 deny 才判拒绝', () => {
  assert.equal(unreachableOutcome('deny'), 'rejected');
});

test('★ delegate 与 rejected 是两件不同的事', () => {
  // 这条断言看着啰嗦，但它守的是一个真实的设计陷阱：
  // 如果哪天有人把 delegate 的返回值改成 'rejected'，
  // QQ 一断线所有任务就开始失败，而测试会立刻发现。
  assert.notEqual(unreachableOutcome('delegate'), 'rejected');
});

/* ---------------------------------------------------------------- 配置 schema */

// Config 需要 @deepseek-ai/schemastery，它只存在于 DSH 的 profile 里，
// 不在本仓库的依赖里。所以这里**有条件地**验证：
// 能解析到就测真实 schema，解析不到就只检查声明形状。
// 这样单元测试在两种环境里都有意义，不会因为环境差异整个文件崩掉。

test('Config 声明了所有 volatile 字段（否则设置写不进去）', async () => {
  const src = await import('node:fs/promises').then((m) =>
    m.readFile(new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url), 'utf8'),
  );
  // 每个配置字段都要有 extra('volatile', true)，否则 DSH 的设置写入会抛
  // "Plugin entry ... has no volatile fields"
  for (const field of ['bridgeUrl', 'bridgeToken', 'admins', 'relayApprovals', 'onUnreachable']) {
    const re = new RegExp(String.raw`${field}:[\s\S]{0,400}?extra\('volatile', true\)`);
    assert.match(src, re, `字段 ${field} 缺 extra('volatile', true)`);
  }
});

test('★ 不写 .volatile()（本仓库钉的 schemastery 版本没有这个方法）', async () => {
  const src = await import('node:fs/promises').then((m) =>
    m.readFile(new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url), 'utf8'),
  );
  // .volatile() 是 DSH 自带那份 schemastery 的语法糖，
  // ^3.18.1 解析出来的那份没有，写了会直接 TypeError。
  //
  // 只看**代码行**，不看注释：注释里提到 ".volatile()" 是说明性的，
  // 不该被当成真的调用了它。
  const codeLines = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  assert.equal(/\.volatile\(\)/.test(codeLines), false, '不要用 .volatile()，用 .extra(volatile, true)');
});

/* ---------------------------------------------------------------- 桥客户端 */

test('桥未配置时 enabled 为 false，且请求直接失败不抛', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const b = new BridgeClient({ url: '', token: '' });
  assert.equal(b.enabled, false);
  const r = await b.ping();
  assert.equal(r.ok, false);
  assert.match(r.error, /未配置/);
});

test('只有 url 没有 token 也不算启用', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, () => {
  assert.equal(new BridgeClient({ url: 'http://x', token: '' }).enabled, false);
  assert.equal(new BridgeClient({ url: '', token: 't' }).enabled, false);
});

test('★ 桥返回词表外的结论时不猜，按失败处理', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  // 造一个假 fetch 返回非法结论
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, outcome: '随便放行' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const b = new BridgeClient({ url: 'http://x', token: 't' });
    const r = await b.ask({ toolName: 'fs_write' });
    assert.equal(r.ok, false, '非法结论必须当成失败，不能当同意');
    assert.match(r.error, /无法识别/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('桥返回合法结论时才接受', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const orig = globalThis.fetch;
  for (const want of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true, outcome: want }), { status: 200 });
    try {
      const b = new BridgeClient({ url: 'http://x', token: 't' });
      const r = await b.ask({ toolName: 'fs_write' });
      assert.equal(r.ok, true);
      assert.equal(r.outcome, want);
    } finally {
      globalThis.fetch = orig;
    }
  }
});

test('HTTP 401 时 ask 返回失败而不是抛异常', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":false}', { status: 401 });
  try {
    const b = new BridgeClient({ url: 'http://x', token: 'bad' });
    const r = await b.ask({ toolName: 'fs_write' });
    assert.equal(r.ok, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('请求头里带 Bearer 令牌', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  let seen = '';
  const orig = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    seen = init.headers.authorization;
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const b = new BridgeClient({ url: 'http://x', token: 'secret-tk' });
    await b.ping();
    assert.equal(seen, 'Bearer secret-tk');
  } finally {
    globalThis.fetch = orig;
  }
});

/* ---------------------------------------------------------------- 命名空间 */

test('★ 命名空间要能认出带 include: 前缀的 entry', async () => {
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url), "utf8");
  // 关键：不能只用 === NS 精确比对，否则 include:dsh-qq-bridge 会漏掉
  assert.ok(src.includes("include:"), '必须处理 include: 前缀');
  assert.ok(/includes\(NS\)/.test(src), '要有"包含包名"的宽松匹配');
});

test('★ 写配置不能写死命名空间（否则抛 No configurable plugin entry）', async () => {
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
  // update/mutate 的第一个参数必须是解析出来的，不能是常量 NS
  assert.equal(/settings\.update\(NS,/.test(code), false, "update 不能写死 NS");
  assert.equal(/settings\.mutate\(NS,/.test(code), false, "mutate 不能写死 NS");
  assert.ok(/resolveNs\(ctx\)/.test(code), "必须用 resolveNs");
});

test('★ 订阅 settings/document-updated 做热更新', async () => {
  // 守的坑：保存设置之后 DSH **不会**重建插件实例，
  // 运行中的实例继续拿旧配置。诊断日志实测：保存完只有一行"配置已更新"，
  // 再没有任何 apply。表现是"设置里开着，功能就是不工作"。
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url), "utf8");
  assert.ok(src.includes("settings/document-updated"), "必须订阅配置变更事件");
  assert.ok(src.includes("ctx.effect"), "订阅要挂在 effect 上，插件卸载时一起释放");
});

test('★ relay/admins 不能从闭包旧值读，要走 live 对象', async () => {
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url), "utf8");
  const lines = src.split("\n");
  // 只允许 live 初始化那几行出现 cfg.relayApprovals 等
  const offenders = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /cfg\.(relayApprovals|onUnreachable|admins)/.test(l))
    .filter(({ l }) => !/^\s*(relayApprovals|onUnreachable|admins): cfg\./.test(l));
  assert.deepEqual(
    offenders.map((o) => `${o.i + 1}: ${o.l.trim()}`),
    [],
    "下游必须读 live.*，否则热更新不生效",
  );
});

/* -------------------------------------------------- 提问转推 */

test('★ 要接管 user-questions/request', async () => {
  const src = readSource();
  assert.match(src, /ctx\.on\('user-questions\/request'/, '提问必须能推到 QQ');
});

test('★ 提问没有选项时要交还界面，不能硬转', async () => {
  // 纯自由输入的问题在 QQ 端没有编号可回，硬转只会让人无从下手。
  const src = readSource();
  const i = src.indexOf("user-questions/request");
  const block = src.slice(i, i + 1800);
  assert.match(block, /hasOptions/, '要检查有没有选项');
  assert.match(block, /return answer\(\)/, '没选项要交还界面');
});

test('★ 提问失败必须交还界面，不能把 DSH 卡死', async () => {
  const src = readSource();
  const i = src.indexOf("user-questions/request");
  const block = src.slice(i, i + 1800);
  assert.match(block, /catch[\s\S]{0,200}answer\(\)/, '异常路径也要交还界面');
});

test('★ 答案为空时交还界面（不能当成"用户选了默认项"）', async () => {
  const src = readSource();
  const i = src.indexOf("user-questions/request");
  const block = src.slice(i, i + 1800);
  assert.match(block, /if \(!res\.answer\)/, 'null 要和"有答案"区分开');
});
