/**
 * 唤醒设置：什么消息值得起一个回合 —— F7
 *
 * ## 这个文件在防什么
 *
 * 「唤醒」在本项目里的语义是**消息驱动的触发判定**，不是参考项目那套
 * "AI 自主潜水/被叫醒"。所以这里断言的是：
 *
 *   1. 每个开关都是**硬开关** —— 关掉就是不触发，不存在"关掉走默认"
 *   2. 提问判定**保守** —— 宁可漏掉一个问句，也不要把整个群变成刷屏源
 *   3. 频率硬限真的拦得住 —— 而且用的是滑动窗口，没有边界突刺
 *   4. 强/弱触发的分类对 —— 拍一拍不该插队，@ 必须插队
 *
 * 第 1 条尤其重要：如果开关关掉还按别的规则触发，那这个开关就是骗人的，
 * 而"设了没生效"是最难排查也最伤信任的一类 bug。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIGGER,
  detectTrigger,
  detectPokeTrigger,
  isStrongTrigger,
  looksLikeQuestion,
  decideProactive,
  WakeLedger,
} from '../src/llm/triggers.mjs';

/** 造一条群消息 */
const groupMsg = (over = {}) => ({
  kind: 'message',
  isGroup: true,
  atSelf: false,
  text: '随便说说',
  sender: { userId: '1001', nickname: 'u1001' },
  ...over,
});

const privateMsg = (over = {}) => ({ ...groupMsg(), isGroup: false, ...over });

/* ------------------------------------------------------------ 强/弱分类 */

test('强触发：@ / 点名 / 私聊 / 指定群友', () => {
  for (const t of [TRIGGER.AT, TRIGGER.NAME, TRIGGER.PRIVATE, TRIGGER.COMMAND, TRIGGER.SPEAKER]) {
    assert.equal(isStrongTrigger(t), true, `${t} 应是强触发`);
  }
});

test('★ 拍一拍是弱触发：不该插队到正在跑的回合前面', () => {
  // 拍一拍没有正文，是很轻的动作；群里还常连环互拍
  assert.equal(isStrongTrigger(TRIGGER.POKE), false);
});

test('关键词 / 提问 / 概率是弱触发', () => {
  for (const t of [TRIGGER.KEYWORD, TRIGGER.QUESTION, TRIGGER.PROBABILITY]) {
    assert.equal(isStrongTrigger(t), false, `${t} 应是弱触发`);
  }
});

/* ------------------------------------------------------------ 基础触发 */

test('默认（没给 wake 配置）时 @ 照常触发', () => {
  // 老配置里没有 wake 这一块，默认必须开 —— 否则升级后 @ 全部失效
  const r = detectTrigger(groupMsg({ atSelf: true }), { selfName: 'Ling' });
  assert.equal(r?.trigger, TRIGGER.AT);
});

test('私聊永远是强触发', () => {
  const r = detectTrigger(privateMsg(), { selfName: 'Ling' });
  assert.equal(r?.trigger, TRIGGER.PRIVATE);
});

test('提到名字触发', () => {
  const r = detectTrigger(groupMsg({ text: 'Ling 你在吗' }), { selfName: 'Ling' });
  assert.equal(r?.trigger, TRIGGER.NAME);
});

test('关键词触发', () => {
  const r = detectTrigger(groupMsg({ text: '今天讨论一下小鲸鱼' }), {
    wake: { keywords: ['小鲸鱼'] },
  });
  assert.equal(r?.trigger, TRIGGER.KEYWORD);
});

test('没有触发条件时返回 null', () => {
  const r = detectTrigger(groupMsg({ text: '哈哈哈哈' }), { selfName: 'Ling', wake: {} });
  assert.equal(r, null);
});

/* ------------------------------------------------------------ 硬开关 */

test('★ 关掉 @ 唤醒后，被 @ 也不触发', () => {
  const r = detectTrigger(groupMsg({ atSelf: true }), { wake: { atMention: false } });
  assert.equal(r, null, '关掉的开关必须真的关掉');
});

test('★ 关掉名字唤醒后，提到名字也不触发', () => {
  const r = detectTrigger(groupMsg({ text: 'Ling 你好' }), {
    selfName: 'Ling',
    wake: { nameMention: false },
  });
  assert.equal(r, null);
});

test('★ 关掉关键词后，命中关键词也不触发', () => {
  const r = detectTrigger(groupMsg({ text: '小鲸鱼在吗' }), {
    wake: { keywords: ['小鲸鱼'], keywords_enabled: false, question: false },
  });
  // keywords 开关写在 keywords 字段上：命中即触发，关掉要清空数组
  // 这里断言的是：清空关键词确实不再命中
  const cleared = detectTrigger(groupMsg({ text: '小鲸鱼在吗' }), { wake: { keywords: [], question: false } });
  assert.equal(cleared, null);
  assert.equal(r?.trigger, TRIGGER.KEYWORD, '有关键词时仍应触发');
});

test('★ 关掉提问唤醒后，问句也不触发', () => {
  const r = detectTrigger(groupMsg({ text: '这是什么' }), {
    selfName: 'Ling',
    wake: { question: false, keywords: [] },
  });
  assert.equal(r, null);
});

test('关掉提问但开着关键词时，命中关键词仍触发', () => {
  const r = detectTrigger(groupMsg({ text: '这是什么小鲸鱼' }), {
    wake: { question: false, keywords: ['小鲸鱼'] },
  });
  assert.equal(r?.trigger, TRIGGER.KEYWORD);
});

/* ------------------------------------------------------------ 指定群友 */

test('★ 指定群友发言即触发', () => {
  const r = detectTrigger(groupMsg({ sender: { userId: '88888', nickname: 'x' } }), {
    wake: { speakerIds: ['88888'], question: false },
  });
  assert.equal(r?.trigger, TRIGGER.SPEAKER);
});

test('★ 非指定群友发言不触发', () => {
  const r = detectTrigger(groupMsg({ sender: { userId: '11111', nickname: 'x' }, text: '哈哈哈' }), {
    wake: { speakerIds: ['88888'], question: false },
  });
  assert.equal(r, null);
});

test('speakerIds 支持数字与字符串混用', () => {
  const r = detectTrigger(groupMsg({ sender: { userId: '88888', nickname: 'x' } }), {
    wake: { speakerIds: [88888], question: false },
  });
  assert.equal(r?.trigger, TRIGGER.SPEAKER, 'QQ 号在不同来源可能是数字或字符串');
});

test('指定群友的优先级高于关键词', () => {
  // 日志上"等的人在说话"比"命中关键词"更有解释力
  const r = detectTrigger(groupMsg({ sender: { userId: '88888', nickname: 'x' }, text: '小鲸鱼' }), {
    wake: { speakerIds: ['88888'], keywords: ['小鲸鱼'] },
  });
  assert.equal(r?.trigger, TRIGGER.SPEAKER);
});

/* ------------------------------------------------------------ 提问判定 */

test('提问判定：明确问号算', () => {
  for (const s of ['这是什么？', '你去吗?', '为什么']) {
    assert.equal(looksLikeQuestion(s), true, `${s} 应判为提问`);
  }
});

test('提问判定：句尾疑问助词算', () => {
  for (const s of ['你吃了吗', '这个呢', '是吧']) {
    assert.equal(looksLikeQuestion(s), true, `${s} 应判为提问`);
  }
});

test('★ 提问判定：普通陈述句不能算', () => {
  /*
   * 这是防刷屏的核心断言。如果"今天好热"被判成提问，
   * 一个活跃群会变成每句都触发 —— 那比不触发更糟。
   */
  for (const s of ['今天好热', '哈哈哈哈', '我吃完了他也吃了', '这个好吃']) {
    assert.equal(looksLikeQuestion(s), false, `${s} 不该判为提问`);
  }
});

test('★ 提问判定：疑问词在句中不算（"我什么都不想吃"）', () => {
  assert.equal(looksLikeQuestion('我什么都不想吃'), false);
  // 但短句以疑问词开头算
  assert.equal(looksLikeQuestion('怎么弄'), true);
});

test('提问判定：空文本不算', () => {
  assert.equal(looksLikeQuestion(''), false);
  assert.equal(looksLikeQuestion('   '), false);
  assert.equal(looksLikeQuestion(null), false);
});

/* ------------------------------------------------------------ 拍一拍 */

const pokeEvt = (over = {}) => ({ kind: 'poke', convKey: 'group:1', from: '1001', target: '9999', ...over });

test('拍一拍：拍的是自己才触发', () => {
  const r = detectPokeTrigger(pokeEvt({ target: '9999' }), { selfId: '9999', wake: {} });
  assert.equal(r?.trigger, TRIGGER.POKE);
});

test('★ 拍一拍：别人互拍不触发', () => {
  const r = detectPokeTrigger(pokeEvt({ target: '5555' }), { selfId: '9999', wake: {} });
  assert.equal(r, null);
});

test('拍一拍：关掉开关后不触发', () => {
  const r = detectPokeTrigger(pokeEvt({ target: '9999' }), { selfId: '9999', wake: { poke: false } });
  assert.equal(r, null);
});

test('拍一拍：拿不到 selfId 时不触发', () => {
  const r = detectPokeTrigger(pokeEvt({ target: '9999' }), { selfId: '', wake: {} });
  assert.equal(r, null, '不知道我是谁就不能判断是被拍');
});

/* ------------------------------------------------------------ 频率硬限 */

test('★ 频率硬限：超过每分钟上限后不再触发', () => {
  let now = 1_000_000;
  const ledger = new WakeLedger({ now: () => now });
  const limits = { maxPerMinute: 3, maxPerHour: 100 };

  for (let i = 0; i < 3; i++) {
    assert.equal(ledger.checkAndNote('group:1', limits).ok, true, `第 ${i + 1} 次应放行`);
    now += 1000;
  }
  const blocked = ledger.checkAndNote('group:1', limits);
  assert.equal(blocked.ok, false, '第 4 次应被拦');
  assert.equal(blocked.code, 'E2040');
  assert.ok(blocked.retryAfterMs > 0);
});

test('频率硬限：窗口滑过后恢复', () => {
  let now = 1_000_000;
  const ledger = new WakeLedger({ now: () => now });
  const limits = { maxPerMinute: 2, maxPerHour: 100 };

  ledger.checkAndNote('group:1', limits);
  ledger.checkAndNote('group:1', limits);
  assert.equal(ledger.check('group:1', limits).ok, false);

  now += 61_000; // 滑过一分钟
  assert.equal(ledger.check('group:1', limits).ok, true);
});

test('★ 频率硬限：滑动窗口没有边界突刺', () => {
  /*
   * 固定桶实现在分钟交界处会瞬间放行两倍数量。这里连打 4 次
   * 跨越 59s→61s，断言不会因为"进入新的一分钟"就多放行一批。
   */
  let now = 1_000_000;
  const ledger = new WakeLedger({ now: () => now });
  const limits = { maxPerMinute: 3, maxPerHour: 100 };

  ledger.checkAndNote('group:1', limits); // t=0
  now += 20_000;
  ledger.checkAndNote('group:1', limits); // t=20s
  now += 20_000;
  ledger.checkAndNote('group:1', limits); // t=40s
  now += 19_000; // t=59s，仍在一分钟内
  assert.equal(ledger.check('group:1', limits).ok, false, '59s 时不该放行');
});

test('频率硬限：每小时上限独立生效', () => {
  let now = 1_000_000;
  const ledger = new WakeLedger({ now: () => now });
  const limits = { maxPerMinute: 100, maxPerHour: 2 };

  ledger.checkAndNote('group:1', limits);
  now += 70_000;
  ledger.checkAndNote('group:1', limits);
  now += 70_000;
  const r = ledger.check('group:1', limits);
  assert.equal(r.ok, false, '每分钟够但每小时超了');
  assert.match(r.message, /每小时/);
});

test('频率硬限：按会话隔离', () => {
  let now = 1_000_000;
  const ledger = new WakeLedger({ now: () => now });
  const limits = { maxPerMinute: 1, maxPerHour: 100 };

  assert.equal(ledger.checkAndNote('group:1', limits).ok, true);
  assert.equal(ledger.checkAndNote('group:1', limits).ok, false, '同会话超限');
  assert.equal(ledger.checkAndNote('group:2', limits).ok, true, '另一个会话不受影响');
});

test('★ 上限为 0 表示不限制，而不是"一次都不许"', () => {
  // 用户把"每分钟最多"清成 0 的意思是"我不管"，
  // 真想让机器人闭嘴该关 wake 总开关
  const ledger = new WakeLedger({ now: () => 1_000_000 });
  for (let i = 0; i < 20; i++) {
    assert.equal(ledger.checkAndNote('group:1', { maxPerMinute: 0, maxPerHour: 0 }).ok, true);
  }
});

test('snapshot 给出窗口内的次数', () => {
  let now = 1_000_000;
  const ledger = new WakeLedger({ now: () => now });
  ledger.note('group:1');
  now += 1000;
  ledger.note('group:1');
  const snap = ledger.snapshot('group:1');
  assert.equal(snap.lastMinute, 2);
  assert.equal(snap.lastHour, 2);
});

/* ------------------------------------------------------------ 概率护栏 */

test('概率唤醒：私聊永不主动', () => {
  const r = decideProactive({
    state: { lastHumanAt: Date.now(), lastProactiveAt: null, lastAutoTurnAt: null },
    isGroup: false,
    config: { probability: 1 },
  });
  assert.equal(r, null);
});

test('概率唤醒：冷群不掷骰子', () => {
  const r = decideProactive({
    state: { lastHumanAt: null, lastProactiveAt: null, lastAutoTurnAt: null },
    isGroup: true,
    config: { probability: 1 },
    now: Date.now(),
  });
  assert.equal(r, null);
});

test('概率唤醒：没过间隔不掷骰子', () => {
  const now = Date.now();
  const r = decideProactive({
    state: { lastHumanAt: now, lastProactiveAt: now - 1000, lastAutoTurnAt: null },
    isGroup: true,
    config: { probability: 1, minIntervalMs: 1_800_000 },
    now,
  });
  assert.equal(r, null);
});

test('概率唤醒：护栏都过且骰子中才触发', () => {
  const now = Date.now();
  const r = decideProactive({
    state: { lastHumanAt: now, lastProactiveAt: null, lastAutoTurnAt: null },
    isGroup: true,
    config: { probability: 1 },
    now,
    random: () => 0.5, // 0.5 < 1
  });
  assert.equal(r?.trigger, TRIGGER.PROBABILITY);
});

test('概率唤醒：骰子不中时不触发', () => {
  const now = Date.now();
  const r = decideProactive({
    state: { lastHumanAt: now, lastProactiveAt: null, lastAutoTurnAt: null },
    isGroup: true,
    config: { probability: 0.1 },
    now,
    random: () => 0.9,
  });
  assert.equal(r, null);
});
