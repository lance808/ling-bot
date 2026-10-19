/**
 * 配置归一化 —— 每一个字段都可能是「未求值占位对象」
 *
 * 这是本项目踩过最隐蔽的一个坑：
 *
 * DSH 的 Config schema 把字段声明成 `anyOf: [string, loaderExpression]`，
 * 其中 loaderExpression 是 `{ __jsExpr: string }`。插件 apply 时拿到的
 * 就可能是**空对象** `{}` 而不是值。
 *
 * 原来的实现 `String(v ?? '')` 把 `{}` 变成字面量 "[object Object]"：
 *   - bridgeUrl  → "[object Object]"
 *   - bridgeToken → "[object Object]"
 * 两者都"非空"，于是 enabled = true，请求发往 `[object Object]/dsh/drain`，
 * 报 "Failed to parse URL from [object Object]"。
 *
 * 而表层现象是：插件说 enabled、轮询每秒都在跑、日志几乎不报错。
 * 所以这条必须钉死：**对象一律等于没有值**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const SRC = new URL('../dsh-plugin/dsh-qq-bridge/lib/index.js', import.meta.url);

/**
 * 从源码里抠出 normalizeConfig 单独求值。
 *
 * 不直接 import 整个模块：那会连带 schemastery 等依赖，
 * 而这里只想测纯函数。
 */
async function loadNormalize() {
  const src = await fs.readFile(SRC, 'utf8');
  const start = src.indexOf('function normalizeConfig');
  assert.ok(start > 0, '找不到 normalizeConfig');
  const end = src.indexOf('/* ------------------------------------------------------------------ 下指令 */', start);
  assert.ok(end > start, '找不到函数结尾');
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return normalizeConfig;`)();
}

test('★ 空对象不能被当成值（"[object Object]" 那个坑）', async () => {
  const normalizeConfig = await loadNormalize();
  const cfg = normalizeConfig({
    bridgeUrl: {},
    bridgeToken: {},
    admins: {},
    relayApprovals: {},
    onUnreachable: {},
  });

  assert.equal(cfg.bridgeUrl, '', '空对象必须归一化为空串');
  assert.equal(cfg.bridgeToken, '', '空对象必须归一化为空串');
  assert.equal(cfg.admins, '');
  assert.equal(cfg.onUnreachable, '');
  assert.equal(cfg.relayApprovals, false);

  // 最关键的一条：绝不能出现这个字符串
  assert.equal(
    JSON.stringify(cfg).includes('[object Object]'),
    false,
    '任何字段都不能变成 "[object Object]"',
  );
});

test('★ { __jsExpr } 形状同样当作没有值', async () => {
  const normalizeConfig = await loadNormalize();
  const cfg = normalizeConfig({
    bridgeUrl: { __jsExpr: 'process.env.X' },
    bridgeToken: { __jsExpr: 'foo' },
  });
  assert.equal(cfg.bridgeUrl, '');
  assert.equal(cfg.bridgeToken, '');
});

test('正常的字符串能通过', async () => {
  const normalizeConfig = await loadNormalize();
  const cfg = normalizeConfig({
    bridgeUrl: '  http://127.0.0.1:3458  ',
    bridgeToken: ' abc123 ',
    admins: ' 10001,10002 ',
    relayApprovals: true,
    onUnreachable: 'delegate',
  });
  assert.equal(cfg.bridgeUrl, 'http://127.0.0.1:3458', '要去掉首尾空白');
  assert.equal(cfg.bridgeToken, 'abc123');
  assert.equal(cfg.admins, '10001,10002');
  assert.equal(cfg.relayApprovals, true);
  assert.equal(cfg.onUnreachable, 'delegate');
});

test('relayApprovals 只认布尔 true（字符串 "true" 不算）', async () => {
  const normalizeConfig = await loadNormalize();
  assert.equal(normalizeConfig({ relayApprovals: 'true' }).relayApprovals, false);
  assert.equal(normalizeConfig({ relayApprovals: 1 }).relayApprovals, false);
  assert.equal(normalizeConfig({ relayApprovals: true }).relayApprovals, true);
});

test('缺失字段是空串，不是 undefined', async () => {
  const normalizeConfig = await loadNormalize();
  const cfg = normalizeConfig({});
  assert.equal(cfg.bridgeUrl, '');
  assert.equal(cfg.bridgeToken, '');
  assert.equal(cfg.admins, '');
});

test('null / undefined 的 config 不崩', async () => {
  const normalizeConfig = await loadNormalize();
  assert.equal(normalizeConfig(null).bridgeUrl, '');
  assert.equal(normalizeConfig(undefined).bridgeUrl, '');
});

test('★ 读配置时不能要求脱敏（否则拿不到 token，永远连不上）', async () => {
  const src = await fs.readFile(SRC, 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n');
  assert.equal(
    /describe\?\.\(\s*\{\s*redactSecrets:\s*true/.test(code),
    false,
    '插件自己要用令牌，不能要求脱敏；脱敏后拿到 { path, set }，会被当成没有值',
  );
});

test('★ apply 不能盲信传入的 config，要能从 settings 补', async () => {
  const src = await fs.readFile(SRC, 'utf8');
  const i = src.indexOf('export function apply');
  const block = src.slice(i, i + 1600);
  assert.match(block, /readEffectiveConfig/, 'apply 必须读 settings 里的真实值');
  assert.match(block, /fromSettings/, '要有 settings 来源的合并');
});

test('★ apply 不能因为"桥没配"就提前 return（否则热更新补上也来不及）', async () => {
  // 实测：apply 跑在 settings 就绪之前约 1 秒，那一刻 token 是空的。
  // 以前这里直接 return，导致指令轮询和审批处理器**都没注册**，
  // 之后热更新把令牌补上也没有任何东西去用它。
  const src = await fs.readFile(SRC, "utf8");
  const i = src.indexOf("export function apply");
  const end = src.indexOf("/* ------------------------------------------------------------------ 下指令 */", i);
  const body = src.slice(i, end > i ? end : undefined);

  assert.doesNotMatch(
    body,
    /桥未配置[^\n]*\n\s*return;/,
    '桥未配置时不能 return，要先把处理器挂上',
  );
});

test('★ 审批处理器运行时现读开关和名单', async () => {
  const src = await fs.readFile(SRC, 'utf8');
  const i = src.indexOf("ctx.on('approval/request'");
  assert.ok(i > 0, '找不到审批处理器');
  const block = src.slice(i, i + 900);
  assert.match(block, /live\.relayApprovals/, '开关要现读，不能用 apply 时的快照');
  assert.match(block, /parseAdmins\(live\.admins\)/, '名单要现读');
});

test('★ 热更新要把地址和令牌也补上', async () => {
  const src = await fs.readFile(SRC, 'utf8');
  const i = src.indexOf('const applyLive');
  const block = src.slice(i, i + 1200);
  assert.match(block, /reconfigure/, '必须能就地修复 bridge 的地址/令牌');
});
