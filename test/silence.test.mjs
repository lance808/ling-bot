/**
 * 静音闸门（「闭嘴」）—— F20
 *
 * ## 这个文件在防什么
 *
 * 静音是一个**压制型**功能，它出错的方式全都是「该闭嘴的时候没闭嘴」
 * 或者「该说话的时候说不出话」，而且两种都不会报错。用户只能靠观察发现，
 * 而观察需要时间——如果它半夜一直在群里说话，用户第二天早上才知道。
 *
 * 所以这里重点钉四类：
 *
 *   1. **四种来源各自生效**（全局 / 按会话 / 时段 / 指令）
 *   2. **优先级**：全局 > 按会话 > 临时 > 时段。任一命中就闭嘴
 *   3. **跨午夜时段**：23:00–08:00 是最常见的写法，也是最容易写错的
 *   4. **解除指令不受静音影响** —— 否则用户会把自己永久锁死
 *
 * 第 4 条是整个功能能不能用的前提：一旦锁死，用户只能去改配置文件，
 * 而大多数用户不知道配置文件在哪。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SilenceGate,
  SILENCE_REASON,
  parseClock,
  minutesOfDay,
  inWindow,
  matchWindow,
  parseDuration,
  parseSilenceCommand,
  DEFAULT_MUTE_MS,
  MAX_MUTE_MS,
} from '../src/llm/silence.mjs';

/** 构造某个本地时刻的毫秒时间戳 */
const at = (h, m = 0) => new Date(2026, 9, 22, h, m, 0, 0).getTime();

/** 空配置 */
const noSilence = { silence: { all: false, convKeys: [], windows: [] } };

/* ------------------------------------------------------------ 时间解析 */

test('★ 时刻解析：只接受两位补零的 HH:MM', () => {
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('23:59'), 23 * 60 + 59);
  assert.equal(parseClock('08:30'), 8 * 60 + 30);
  // 单位数写法要拒：同一时刻两种写法会让比较变复杂
  assert.equal(parseClock('7:00'), null);
  // 越界要拒
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('23:60'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(null), null);
});

test('★ 普通时段：左闭右开（23:00 整点进入，08:00 整点退出）', () => {
  const w = { start: '09:00', end: '18:00' };
  assert.equal(inWindow(9 * 60, w), true, '09:00 应已进入');
  assert.equal(inWindow(8 * 60 + 59, w), false, '08:59 还没进');
  assert.equal(inWindow(17 * 60 + 59, w), true, '17:59 还在');
  assert.equal(inWindow(18 * 60, w), false, '18:00 应已退出');
});

test('★ 跨午夜时段：23:00–08:00 覆盖午夜两侧', () => {
  /*
   * 这是最常见的写法，也是最容易写错的地方。
   * 按 start < end 的普通写法，23:00–08:00 会被算成"全天都不在区间内"，
   * 结果就是夜间完全不静音 —— 用户第二天早上发现它半夜一直在说话。
   */
  const w = { start: '23:00', end: '08:00' };
  assert.equal(inWindow(23 * 60, w), true, '23:00 应进入');
  assert.equal(inWindow(23 * 60 + 59, w), true, '23:59 还在');
  assert.equal(inWindow(0, w), true, '00:00 跨过午夜仍在');
  assert.equal(inWindow(3 * 60, w), true, '凌晨 3 点仍在');
  assert.equal(inWindow(7 * 60 + 59, w), true, '07:59 还在');
  assert.equal(inWindow(8 * 60, w), false, '08:00 应已退出');
  assert.equal(inWindow(12 * 60, w), false, '中午不在');
  assert.equal(inWindow(22 * 60 + 59, w), false, '22:59 还没进');
});

test('★ start === end 视为不生效，而不是全天静音', () => {
  /*
   * `23:00–23:00` 手写出来多半是笔误。
   * 理解成"全天静音"会让机器人整天不说话，而用户完全不知道发生了什么。
   * 不生效至少是"没起作用"，不是"起了个隐蔽的副作用"。
   */
  const w = { start: '23:00', end: '23:00' };
  for (const m of [0, 12 * 60, 23 * 60]) {
    assert.equal(inWindow(m, w), false, `${m} 分钟处不该被判定为静音`);
  }
});

test('非法时段一律不生效（不抛错，只是不起作用）', () => {
  assert.equal(inWindow(0, { start: '7:00', end: '08:00' }), false);
  assert.equal(inWindow(0, { start: null, end: null }), false);
  assert.equal(inWindow(0, {}), false);
});

test('多个时段：任一命中即静音', () => {
  const windows = [
    { start: '12:00', end: '13:00' },
    { start: '23:00', end: '08:00' },
  ];
  assert.equal(matchWindow(at(12, 30), windows).hit, true, '午休');
  assert.equal(matchWindow(at(2, 0), windows).hit, true, '凌晨');
  assert.equal(matchWindow(at(15, 0), windows).hit, false, '下午');
  assert.equal(matchWindow(at(15, 0), windows).window, null);
});

test('minutesOfDay 用本地时区', () => {
  assert.equal(minutesOfDay(at(9, 30)), 9 * 60 + 30);
  assert.equal(minutesOfDay(at(0, 0)), 0);
  assert.equal(minutesOfDay(at(23, 59)), 23 * 60 + 59);
});

/* ------------------------------------------------------------ 四种来源 */

test('★ 全局静音：任何会话、任何时刻都闭嘴', () => {
  const gate = new SilenceGate({ now: () => at(14, 0) });
  const cfg = { silence: { all: true, convKeys: [], windows: [] } };
  for (const k of ['group:1', 'private:2']) {
    const r = gate.check(k, cfg);
    assert.equal(r.silent, true);
    assert.equal(r.reason, SILENCE_REASON.GLOBAL);
  }
});

test('★ 按会话静音：只影响点名的会话', () => {
  const gate = new SilenceGate({ now: () => at(14, 0) });
  const cfg = { silence: { all: false, convKeys: ['group:1'], windows: [] } };
  assert.equal(gate.check('group:1', cfg).silent, true);
  assert.equal(gate.check('group:1', cfg).reason, SILENCE_REASON.CONVERSATION);
  assert.equal(gate.check('group:2', cfg).silent, false, '别的群不受影响');
  assert.equal(gate.check('private:1', cfg).silent, false);
});

test('★ 时段静默：在时段内闭嘴，时段外正常', () => {
  const cfg = { silence: { all: false, convKeys: [], windows: [{ start: '23:00', end: '08:00' }] } };

  const night = new SilenceGate({ now: () => at(2, 0) });
  assert.equal(night.check('group:1', cfg).silent, true);
  assert.equal(night.check('group:1', cfg).reason, SILENCE_REASON.SCHEDULE);

  const day = new SilenceGate({ now: () => at(14, 0) });
  assert.equal(day.check('group:1', cfg).silent, false);
});

test('★ 指令触发：临时静音到期自动恢复', () => {
  let now = at(14, 0);
  const gate = new SilenceGate({ now: () => now });
  const cfg = noSilence;

  gate.mute('group:1', 60_000); // 1 分钟
  assert.equal(gate.check('group:1', cfg).silent, true);
  assert.equal(gate.check('group:1', cfg).reason, SILENCE_REASON.TEMPORARY);

  // 到点后自动恢复
  now = at(14, 0) + 60_001;
  assert.equal(gate.check('group:1', cfg).silent, false, '到期应自动恢复');
});

test('临时静音只影响被静音的会话', () => {
  const gate = new SilenceGate({ now: () => at(14, 0) });
  gate.mute('group:1', 60_000);
  assert.equal(gate.check('group:1', noSilence).silent, true);
  assert.equal(gate.check('group:2', noSilence).silent, false);
});

/* ------------------------------------------------------------ 优先级 */

test('★ 优先级：全局 > 按会话 > 临时 > 时段', () => {
  /*
   * 优先级不只是"谁先返回"——它决定日志里写哪个原因。
   * 写错了用户会看到"处于静默时段"，而他真正打开的是全局静音，
   * 于是一直在等时段结束。
   */
  const now = at(2, 0); // 在夜间时段内
  const gate = new SilenceGate({ now: () => now });
  gate.mute('group:1', 60_000); // 同时有临时静音

  const cfg = {
    silence: { all: true, convKeys: ['group:1'], windows: [{ start: '23:00', end: '08:00' }] },
  };
  assert.equal(gate.check('group:1', cfg).reason, SILENCE_REASON.GLOBAL, '全局最优先');

  const cfg2 = {
    silence: { all: false, convKeys: ['group:1'], windows: [{ start: '23:00', end: '08:00' }] },
  };
  assert.equal(gate.check('group:1', cfg2).reason, SILENCE_REASON.CONVERSATION, '其次按会话');

  const cfg3 = { silence: { all: false, convKeys: [], windows: [{ start: '23:00', end: '08:00' }] } };
  assert.equal(gate.check('group:1', cfg3).reason, SILENCE_REASON.TEMPORARY, '再次临时');

  const cfg4 = { silence: { all: false, convKeys: [], windows: [{ start: '23:00', end: '08:00' }] } };
  assert.equal(gate.check('group:2', cfg4).reason, SILENCE_REASON.SCHEDULE, '最后时段');
});

test('没有静音时返回 silent:false 且 reason 是 none', () => {
  const gate = new SilenceGate({ now: () => at(14, 0) });
  const r = gate.check('group:1', noSilence);
  assert.equal(r.silent, false);
  assert.equal(r.reason, SILENCE_REASON.NONE);
  assert.equal(r.until, null);
});

test('配置缺 silence 块时按"不静音"处理，不抛错', () => {
  // 老配置里没有这一块；抛错会让整个对话挂掉
  const gate = new SilenceGate({ now: () => at(14, 0) });
  assert.equal(gate.check('group:1', {}).silent, false);
  assert.equal(gate.check('group:1', null).silent, false);
});

/* ------------------------------------------------------------ 解除 */

test('★ unmute 只清临时静音，不动配置里的全局/按会话静音', () => {
  /*
   * 这条很重要：如果一条聊天指令能把用户在配置里设的全局静音关掉，
   * 那"我明明在配置里关着它，怎么又说话了"就变成无法解释的事。
   * 聊天指令只能解自己设的那一层。
   */
  const gate = new SilenceGate({ now: () => at(14, 0) });
  gate.mute('group:1', 60_000);

  const r = gate.unmute('group:1');
  assert.equal(r.ok, true);
  assert.equal(r.wasSilent, true, '本来确实在静音');
  assert.equal(gate.check('group:1', noSilence).silent, false, '临时静音已解除');

  // 全局静音仍然有效
  const cfgGlobal = { silence: { all: true, convKeys: [], windows: [] } };
  assert.equal(gate.check('group:1', cfgGlobal).silent, true, '全局静音不该被解除');

  // 按会话静音仍然有效
  const cfgConv = { silence: { all: false, convKeys: ['group:1'], windows: [] } };
  assert.equal(gate.check('group:1', cfgConv).silent, true, '按会话静音不该被解除');
});

test('unmute 一个本来没静音的会话也不报错', () => {
  const gate = new SilenceGate({ now: () => at(14, 0) });
  const r = gate.unmute('group:9');
  assert.equal(r.ok, true);
  assert.equal(r.wasSilent, false);
});

test('clear 清空所有临时静音', () => {
  const gate = new SilenceGate({ now: () => at(14, 0) });
  gate.mute('group:1', 60_000);
  gate.mute('group:2', 60_000);
  assert.equal(gate.clear(), 2);
  assert.equal(gate.listTemporary().length, 0);
});

test('listTemporary 只列未到期的', () => {
  let now = at(14, 0);
  const gate = new SilenceGate({ now: () => now });
  gate.mute('group:1', 60_000);
  gate.mute('group:2', 10_000);
  assert.equal(gate.listTemporary().length, 2);

  now = at(14, 0) + 11_000;
  const list = gate.listTemporary();
  assert.equal(list.length, 1, '短的那个已到期');
  assert.equal(list[0].convKey, 'group:1');
  assert.ok(list[0].leftMs > 0);
});

/* ------------------------------------------------------------ 时长解析 */

test('★ 时长解析：不带单位按分钟（「闭嘴30」最自然的意思是 30 分钟）', () => {
  assert.equal(parseDuration('30'), 30 * 60_000);
  assert.equal(parseDuration('1'), 60_000);
});

test('时长解析：支持 s / m / h 单位', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('5m'), 5 * 60_000);
  assert.equal(parseDuration('2h'), 2 * 3_600_000);
  assert.equal(parseDuration('30M'), 30 * 60_000, '大小写不敏感');
});

test('★ 时长解析：超过上限被夹住（写「闭嘴 999d」不该真的闭嘴三年）', () => {
  assert.equal(parseDuration('999d'), MAX_MUTE_MS);
  assert.equal(parseDuration('100h'), MAX_MUTE_MS);
});

test('时长解析：非法输入返回 null', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('0'), null);
  assert.equal(parseDuration('-5'), null);
  assert.equal(parseDuration('5x'), null);
});

/* ------------------------------------------------------------ 指令解析 */

test('★ 指令：「闭嘴」默认 30 分钟', () => {
  const c = parseSilenceCommand('闭嘴');
  assert.equal(c?.kind, 'mute');
  assert.equal(c?.ms, DEFAULT_MUTE_MS);
});

test('★ 指令：带时长', () => {
  assert.equal(parseSilenceCommand('闭嘴 2h')?.ms, 2 * 3_600_000);
  assert.equal(parseSilenceCommand('静音30')?.ms, 30 * 60_000);
  assert.equal(parseSilenceCommand('安静 10m')?.ms, 10 * 60_000);
});

test('★ 指令：解除', () => {
  for (const t of ['说话', '解除静音', '取消静音', '恢复', '可以说了']) {
    assert.equal(parseSilenceCommand(t)?.kind, 'unmute', `「${t}」应被识别为解除`);
  }
});

test('★ 指令：正常聊天不误判（这条最要紧）', () => {
  /*
   * 群里有人说「你别闭嘴啊我还没听完」不该让机器人静音。
   * 误判的代价是它在接下来半小时都不说话，而用户不知道为什么。
   *
   * 所以要求：动词之后除了时长参数不能有别的内容。
   */
  const notCommands = [
    '你别闭嘴啊我还没听完',
    '闭嘴这个梗好老了',
    '大家都安静点听我说',
    '闭嘴吧你',
    '我要说话了',
    '恢复出厂设置',
    '静音模式怎么开',
  ];
  for (const t of notCommands) {
    assert.equal(parseSilenceCommand(t), null, `「${t}」不该被当成指令`);
  }
});

test('指令：容忍首尾标点与 @ 前缀', () => {
  assert.equal(parseSilenceCommand('闭嘴。')?.kind, 'mute');
  assert.equal(parseSilenceCommand('闭嘴！')?.kind, 'mute');
  assert.equal(parseSilenceCommand('@Ling 闭嘴')?.kind, 'mute');
  assert.equal(parseSilenceCommand('  说话  ')?.kind, 'unmute');
});

test('指令：空输入返回 null', () => {
  assert.equal(parseSilenceCommand(''), null);
  assert.equal(parseSilenceCommand('   '), null);
  assert.equal(parseSilenceCommand(null), null);
});

/* ------------------------------------------------------------ 严格静音 */

test('★ 严格静音：静音期间私聊也不回（用户明确选的语义）', () => {
  /*
   * 半截静音（@ 或私聊还能叫醒）会让人不敢用它：
   * 群里别人狂 @ 时噪音照旧，而用户以为自己已经让它安静了。
   *
   * 这里验证闸门对私聊会话一视同仁 —— 它只看 convKey，不区分群/私聊。
   */
  const gate = new SilenceGate({ now: () => at(14, 0) });
  const cfg = { silence: { all: true, convKeys: [], windows: [] } };
  assert.equal(gate.check('private:123', cfg).silent, true);
  assert.equal(gate.check('group:456', cfg).silent, true);
});

test('静音与 wake 配置无关：wake 全开也挡不住静音', () => {
  /*
   * 这条钉的是分层：静音是**绝对压制**，不是 wake 里的一个开关。
   * 如果实现成 wake 的一个条件，就会出现"消息特别像在叫它 → 还是回复了"，
   * 那静音就是假的。
   *
   * 闸门只读 config.silence，压根不看 config.wake —— 这个测试确认这一点。
   */
  const gate = new SilenceGate({ now: () => at(14, 0) });
  const cfg = {
    wake: { atMention: true, nameMention: true, question: true, poke: true },
    silence: { all: true, convKeys: [], windows: [] },
  };
  assert.equal(gate.check('group:1', cfg).silent, true);
});
