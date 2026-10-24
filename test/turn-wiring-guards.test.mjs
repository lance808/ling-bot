/**
 * 回合接线守卫 —— 视觉图片归属、联网总闸口径、取图异常说明。
 *
 * ## 为什么这些用例读源码
 *
 * 它们守的是 `startTurn` 里的**接线**，而不是某个纯函数：
 *   · 引用图的 `floor` 有没有被投影进候选（漏了 → 图取回来也挂不上请求）；
 *   · 挂不上楼层的图有没有被补成一条独立图文消息（否则取到了也白取，
 *     还会被 `markImagesSeen` 永久记成"已提交"）；
 *   · `[图片]` 占位在 `on-but-blocked` / 有 note 时有没有补说明；
 *   · 联网总闸的读取口径是否与 `src/net/gate.mjs` 同一处。
 *
 * 这些都需要真的 boot 后端、连假上游才能端到端跑，而本环境禁止子进程
 * （`spawn EPERM`），也不该为了一个接线断言去调收费模型。所以这里
 * **断言源码里那条接线确实存在**，并把对应纯函数的语义单独测死。
 * 这与仓库里 `parent-watch.test.mjs`（读 `boot()` 里的调用点）、
 * `backend-rpc.test.mjs`（读方法表）是同一套取舍：宁可锁住接线，
 * 也不要让"函数写好了、忘了接上"这类回归静默回来。
 *
 * 另一半（可执行的）用例测 `buildImageRetryRunner` 与
 * `networkEnabledFrom`，见文末。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { networkEnabledFrom } from '../src/net/gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'src', 'index.mjs');

/** @returns {Promise<string>} */
function readEntry() {
  return fs.readFile(ENTRY, 'utf8');
}

/* ------------------------------------------------- 视觉：引用图必须带 floor */

test('★ 引用图候选必须带 floor，否则取回来也挂不到请求上', async () => {
  const src = await readEntry();

  const block = src.slice(
    src.indexOf('/** 引用消息：只在同一会话内查'),
    src.indexOf('/*\n   * 历史：仓库里的最近 200 条里'),
  );
  assert.ok(block.length > 0, '必须能找到引用消息的投影段');
  assert.match(block, /floor:\s*typeof hit\.floor === 'number'/, 'quoted 投影必须带 floor');
  assert.match(block, /quoted = \{/, '仍然要把引用投影成 collectTurnImages 认识的形状');
});

/* --------------------------------- 视觉：挂不上楼层的图要补一条独立图文消息 */

test('★ 挂不上楼层的图必须补成独立图文消息，不能取到就丢', async () => {
  const src = await readEntry();

  assert.match(
    src,
    /const orphans = visionOutcome\.images\.filter\(/,
    '必须计算"没能挂到任何 recent 项上"的图',
  );
  assert.match(
    src,
    /recentForModel\.push\(\{\s*role: 'user',[\s\S]{0,200}images: chunk\.map\(/,
    '这些图要以 user 图文消息补进请求，而不是静默丢弃',
  );
  // 每条最多 4 张：prompt.mjs 的 MAX_IMAGES_PER_MESSAGE 是 4，超了会被静默忽略
  assert.match(src, /const IMAGES_PER_MESSAGE = 4;/, '必须按每消息 4 张分组');
  assert.match(src, /for \(let i = 0; i < orphans\.length; i \+= IMAGES_PER_MESSAGE\)/);
});

test('只有真的挂上了（或被补成独立消息）的图才计入"已提交"', async () => {
  const src = await readEntry();

  /*
   * 顺序要求：先挂图、再补孤儿消息、最后才是 markImagesSeen。
   * 反过来（先记账后挂图）会出现"图没进请求却被标记为已提交"——
   * 那就是"历史图只提交一次"这条契约最坏的失败方向：永久丢失。
   */
  const attachAt = src.indexOf("if (item.role !== 'user') continue;\n        const imgs = byFloor.get(item.floor);");
  const orphanAt = src.indexOf('const orphans = visionOutcome.images.filter(');
  const markAt = src.indexOf('const withImages = floorsWithSubmittedImages(visionOutcome.images);');

  assert.ok(attachAt > 0, '必须存在按 floor 挂图的循环，且只挂到 user 项上');
  assert.ok(orphanAt > attachAt, '补孤儿消息必须发生在挂图之后');
  assert.ok(markAt > orphanAt, 'markImagesSeen 必须发生在"所有图都进请求"之后');
});

test('图片只挂在 user 项上（assistant 带图不会渲染，等于白取）', async () => {
  const src = await readEntry();

  const attachBlock = src.slice(
    src.indexOf('for (const item of recentForModel) {'),
    src.indexOf('const attachedFloors = new Set('),
  );
  assert.match(
    attachBlock,
    /if \(item\.role !== 'user'\) continue;/,
    '提示词层只渲染 user 的图片，挂到 assistant 上等于没挂',
  );
});

/* ------------------------------------------- 视觉：[图片] 占位说明的触发条件 */

test('★ on-but-blocked 与取图异常都要补 [图片] 说明', async () => {
  const src = await readEntry();

  const start = src.indexOf('const shouldAnnotate =');
  assert.ok(start > 0, '占位说明的判定必须收敛到一处（shouldAnnotate）');
  const block = src.slice(start, start + 600);

  assert.match(block, /gate\.effective === 'off'/, '关掉读图时要说明');
  assert.match(block, /gate\.effective === 'on-unsupported'/, '模型不支持时要说明');
  assert.match(
    block,
    /turnEffective === 'on-but-blocked'/,
    '开关与能力正常但一张都没取到（on-but-blocked）也要说明',
  );
  assert.match(block, /visionOutcome\.notes\.length > 0/, '有具体原因（notes）时就该把原因带上');

  // 取图整段抛异常时必须留下 note，否则上面的 notes 条件永远不成立
  const catchBlock = src.slice(
    src.indexOf("log.warn('视觉取图异常，本回合按纯文本继续'"),
    src.indexOf('把图挂到对应的 recent 项上'),
  );
  assert.match(catchBlock, /notes: \['本回合取图过程异常/, '取图异常必须写进 notes');
});

/* ---------------------------------------------------- 联网总闸：口径必须一处 */

test('★ 联网总闸读取与 src/net/gate.mjs 同一口径（缺省开）', async () => {
  const src = await readEntry();

  assert.match(src, /import \{ networkEnabledFrom \} from '\.\/net\/gate\.mjs';/);
  assert.match(src, /getEnabled: \(\) => networkEnabledFrom\(config\)/, '真正发请求的闸门必须用同一函数');

  // 绝不能再出现"另一套判定"：非布尔/缺字段时 === true 会得出相反结论
  const offenders = src
    .split(/\r?\n/)
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    // 注释里允许讨论它（本文件就有解释），只查真正的代码行
    .filter(({ line }) => !line.startsWith('*') && !line.startsWith('//'))
    .filter(({ line }) => /config\.network\?\.enabled === true/.test(line));
  assert.deepEqual(
    offenders.map((o) => `${o.no}: ${o.line}`),
    [],
    '不允许再出现 config.network?.enabled === true 的第二套口径',
  );
});

test('networkEnabledFrom：缺省开、显式布尔照搬（旧部署行为不变）', () => {
  assert.equal(networkEnabledFrom({}), true, '没有 network 字段的旧配置视为开');
  assert.equal(networkEnabledFrom({ network: {} }), true, 'network 存在但缺 enabled 也视为开');
  assert.equal(networkEnabledFrom({ network: { enabled: true } }), true);
  assert.equal(networkEnabledFrom({ network: { enabled: false } }), false);
  assert.equal(networkEnabledFrom({ network: { enabled: 'no' } }), true, '非布尔不当作关闭');
  assert.equal(networkEnabledFrom(null), true);
});
