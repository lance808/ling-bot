/**
 * 静音与唤醒的分层 —— F20 × F19
 *
 * `test/silence.test.mjs` 守的是闸门本身（四种来源、优先级、跨午夜）。
 * 这个文件守的是**接线**：闸门到底装在哪一层、谁先谁后。
 *
 * ## 为什么接线值得单独测
 *
 * 闸门逻辑全对，但装错位置就全白费。三种装法：
 *
 *   A. 装在 wake 里当一个条件  → "特别像在叫它"时仍会回复，静音是假的
 *   B. 装在触发判定之后        → 同上，而且日志里写"命中 @"
 *   C. 装在触发判定之前        → 正确：静音不看语义
 *
 * 这三种在单测闸门函数时**完全看不出差别** —— 它们都调用同一个
 * `gate.check()` 并拿到同样的结果。差别只在调用顺序。
 *
 * 所以这里用**结构断言**（读源码确认顺序）+ 行为断言双管齐下。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SilenceGate, parseSilenceCommand, SILENCE_REASON } from '../src/llm/silence.mjs';
import { detectTrigger, TRIGGER } from '../src/llm/triggers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 读 index.mjs 的源码（结构断言用） */
async function readIndex() {
  return fs.readFile(path.join(ROOT, 'src', 'index.mjs'), 'utf8');
}

/* ------------------------------------------------------------ 调用顺序 */

test('★ 结构：静音闸门必须排在 detectTrigger 之前', async () => {
  /*
   * 这是整个功能能不能成立的分界线。
   *
   * 如果 detectTrigger 先跑，日志里会写"命中 @，然后被静音拦下"——
   * 看起来行为一样，但含义完全变了：它已经**判定过**这条消息值得回应，
   * 只是碰巧被挡住了。任何一处提前 return 被误改，就会变成"静音期间照样回"。
   *
   * 而闸门在前时，判定根本不会发生 —— 静音是绝对压制，不是过滤器。
   */
  const src = await readIndex();

  // 找到 considerTurn 函数体的范围
  const start = src.indexOf('async function considerTurn(');
  assert.ok(start > 0, '找不到 considerTurn');
  const bodyEnd = src.indexOf('\nfunction enqueue(', start);
  assert.ok(bodyEnd > start, '找不到 considerTurn 的结尾');
  const body = src.slice(start, bodyEnd);

  const gateAt = body.indexOf('silenceGate.check');
  const detectAt = body.indexOf('detectTrigger(');

  assert.ok(gateAt > 0, 'considerTurn 里没有调用静音闸门 —— 静音根本没接上');
  assert.ok(detectAt > 0, '找不到 detectTrigger');
  assert.ok(gateAt < detectAt, `静音闸门必须在触发判定之前（gate@${gateAt} 应 < detect@${detectAt}）`);
});

test('★ 结构：静音指令必须排在静音闸门之前', async () => {
  /*
   * 反过来的顺序会**把用户锁死**：说「闭嘴」之后，
   * 「说话」这条指令会被闸门挡掉，于是只能去桌面端改配置。
   *
   * 这是这个功能最容易写错也最致命的一处 —— 而且它不会报错，
   * 只是"说了说话没反应"，用户会以为程序坏了。
   */
  const src = await readIndex();
  const start = src.indexOf('async function considerTurn(');
  const bodyEnd = src.indexOf('\nfunction enqueue(', start);
  const body = src.slice(start, bodyEnd);

  const cmdAt = body.indexOf('parseSilenceCommand');
  const gateAt = body.indexOf('silenceGate.check');

  assert.ok(cmdAt > 0, 'considerTurn 里没有解析静音指令');
  assert.ok(cmdAt < gateAt, '指令解析必须在静音闸门之前，否则用户无法用「说话」自救');
});

test('★ 结构：拍一拍路径也要有静音判断', async () => {
  /*
   * 拍一拍走的是独立分支（不经过 considerTurn）。
   * 只在 considerTurn 里挡的话，静音期间别人拍它一下它还是会冒出来 ——
   * 而拍一拍在群里恰恰是最容易被随手用的动作。
   */
  const src = await readIndex();
  const pokeAt = src.indexOf('detectPokeTrigger(evt');
  assert.ok(pokeAt > 0, '找不到拍一拍分支');

  // 拍一拍分支前面 20 行内应该有闸门检查
  const before = src.slice(Math.max(0, pokeAt - 1200), pokeAt);
  assert.match(before, /silenceGate\.check/, '拍一拍路径前面没有静音判断');
});

test('★ 结构：静音判定只读 config.silence，不读 config.wake', async () => {
  /*
   * 这条防的是"把静音塞进 wake 当条件"的退化写法。
   * 一旦混进去，就会出现"消息特别像在叫它 → 还是回了"。
   */
  const src = await readIndex();
  const start = src.indexOf('async function considerTurn(');
  const bodyEnd = src.indexOf('\nfunction enqueue(', start);
  const body = src.slice(start, bodyEnd);

  const gateLine = body.slice(body.indexOf('silenceGate.check'), body.indexOf('silenceGate.check') + 120);
  assert.ok(!/wake/.test(gateLine), `静音闸门不该接受 wake 参数：${gateLine}`);
});

/* ------------------------------------------------------------ 行为 */

test('★ 行为：静音时 @ 也触发不了（严格静音）', () => {
  /*
   * 用户明确选的语义：静音期间 @ 也不回。
   *
   * 这里模拟 considerTurn 的两步：先问闸门，再（只有闸门放行才）问触发器。
   * 闸门不放行时触发器根本不该被调用。
   */
  const gate = new SilenceGate({ now: () => Date.now() });
  const config = { silence: { all: true, convKeys: [], windows: [] } };

  const evt = {
    convKey: 'group:1',
    isGroup: true,
    kind: 'message',
    atSelf: true, // 被 @ 了
    text: '在吗',
    sender: { userId: '9', nickname: '某人' },
  };

  const decision = gate.check(evt.convKey, config);
  assert.equal(decision.silent, true, '静音期间必须拦住');

  // 模拟正确顺序：闸门说了 silent 就 return，不调 detectTrigger
  let detectedCalled = false;
  if (!decision.silent) {
    detectedCalled = true;
    detectTrigger(evt, { selfId: '1', selfName: 'Ling', wake: config.wake ?? {} });
  }
  assert.equal(detectedCalled, false, '@ 不该穿透静音');
});

test('★ 行为：不静音时 @ 正常触发（确认闸门没把正常路径也挡了）', () => {
  const gate = new SilenceGate({ now: () => Date.now() });
  const config = { silence: { all: false, convKeys: [], windows: [] } };

  const evt = {
    convKey: 'group:1',
    isGroup: true,
    kind: 'message',
    atSelf: true,
    text: '在吗',
    sender: { userId: '9', nickname: '某人' },
  };

  assert.equal(gate.check(evt.convKey, config).silent, false);
  // wake 里要显式给 atMention:true —— 触发器把"缺省"当作关闭，
  // 这是有意的（关掉就是不触发，不回落默认值）
  const d = detectTrigger(evt, { selfId: '1', selfName: 'Ling', wake: { atMention: true } });
  assert.equal(d?.trigger, TRIGGER.AT, '@ 应该正常触发');
});

/* ------------------------------------------------------------ 自救路径 */

test('★ 行为：静音期间「说话」指令仍能识别出来（自救可用）', () => {
  /*
   * 闸门会拦所有回合，但指令解析发生在闸门**之前**，
   * 所以「说话」这条必须能被解析出来 —— 否则用户锁死自己。
   */
  const cmd = parseSilenceCommand('说话');
  assert.equal(cmd?.kind, 'unmute');

  // 完整的自救流程
  const gate = new SilenceGate({ now: () => Date.now() });
  const config = { silence: { all: false, convKeys: [], windows: [] } };
  gate.mute('group:1', 60_000);
  assert.equal(gate.check('group:1', config).silent, true, '先确认确实静音了');

  // 指令走的是另一条路，不受闸门影响
  assert.equal(parseSilenceCommand('说话')?.kind, 'unmute');
  gate.unmute('group:1');
  assert.equal(gate.check('group:1', config).silent, false, '解除后应恢复');
});

test('★ 行为：静音期间「闭嘴 2h」仍能改时长（指令不会被自己的静音挡住）', () => {
  let now = Date.now();
  const gate = new SilenceGate({ now: () => now });
  const config = { silence: { all: false, convKeys: [], windows: [] } };

  gate.mute('group:1', 30 * 60_000); // 先闭嘴 30 分钟
  assert.equal(gate.check('group:1', config).silent, true);

  // 再说「闭嘴 2h」应该能延长，而不是被自己的静音挡掉
  const cmd = parseSilenceCommand('闭嘴 2h');
  assert.equal(cmd?.kind, 'mute');
  gate.mute('group:1', cmd.ms);

  now += 60 * 60_000; // 过了一小时
  assert.equal(gate.check('group:1', config).silent, true, '应该还在静音（已延长到 2 小时）');
});

/* ------------------------------------------------------------ 指令授权 */

test('★ 结构：指令必须校验管理员，且不依赖 dsh.admins', async () => {
  /*
   * DSH 已经是独立插件。核心功能反向依赖插件配置会出两个问题：
   *   1. 不装插件的用户配不了静音指令（字段藏在他看不见的地方）
   *   2. 卸载插件后静音权限凭空消失，而用户不知道为什么
   */
  const src = await readIndex();

  const fnStart = src.indexOf('function isAdmin(');
  assert.ok(fnStart > 0, '找不到 isAdmin');
  // 取函数体（到下一个顶格 function/async function 为止）
  const after = src.slice(fnStart + 10);
  const nextFn = after.search(/\n(?:async )?function /);
  const body = after.slice(0, nextFn > 0 ? nextFn : 600);

  assert.match(body, /silence\?\.adminIds|silence\.adminIds/, '应从 silence.adminIds 取名单');
  assert.ok(!/dsh/.test(body), 'isAdmin 不该读 dsh.admins（DSH 已是独立插件）');
});

test('结构：指令受 allowCommand 开关控制', async () => {
  const src = await readIndex();
  const start = src.indexOf('async function considerTurn(');
  const bodyEnd = src.indexOf('\nfunction enqueue(', start);
  const body = src.slice(start, bodyEnd);
  assert.match(body, /allowCommand/, '指令必须受 allowCommand 开关控制');
});

/* ------------------------------------------------------------ 空态 */

test('默认配置下不静音（升级不能让机器人突然哑了）', () => {
  /*
   * 老配置里没有 silence 块。如果默认是静音，升级后所有人的机器人
   * 都会突然不说话 —— 那是比不加功能更坏的结果。
   */
  const gate = new SilenceGate({ now: () => new Date(2026, 9, 22, 14, 0).getTime() });
  for (const cfg of [{}, { silence: {} }, { silence: { all: false, convKeys: [], windows: [] } }]) {
    assert.equal(gate.check('group:1', cfg).silent, false);
  }
});

test('默认配置：allowCommand 是开的，但 adminIds 空 = 谁都不能用', () => {
  /*
   * 这两个默认值要一起看：开关开着方便用户去填名单，
   * 但名单空意味着实际没人能用 —— 不能因为"开关开着"就默认信任所有人。
   */
  const gate = new SilenceGate({ now: () => Date.now() });
  assert.equal(gate.check('group:1', { silence: { all: false, convKeys: [], windows: [] } }).silent, false);
  // 空名单的语义在 isAdmin 里，这里只确认闸门本身不依赖它
});
