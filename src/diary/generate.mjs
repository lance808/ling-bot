/**
 * 日记生成 —— F5
 *
 * 「日志在第二天识别为生成日记时，生成昨日总结日记，启动时，读取日记」
 *
 * ## 这一层为什么单独存在
 *
 * `diary/store.mjs` 只负责**存**（按日归档、原子写、锁定、淡忘权重），
 * 它刻意不 import LlmClient —— 那样它就没法在测试里跑，而它承载的是
 * "数据不丢"这种最需要测试的性质。
 *
 * 所以「怎么把一天的聊天变成一篇总结」放在这里：它调模型、拼上下文、
 * 处理模型不可用时的降级，然后**把结果交给 store 去存**。
 *
 * ## 降级策略：模型不可用也要有一篇日记
 *
 * 用户打开日记页，看到的是"这天聊了什么"的记录，而不是"AI 有没有上班"。
 * 所以模型挂了、没配 key、超时，都要产出一篇**基于原始摘录的降级日记**：
 * 至少列出当天聊了哪些会话、有多少条消息、几条摘录。
 * 空着不生成会让用户以为程序坏了；而 degraded:true 让界面能如实标注
 * 「这篇没生成总结，只有原始记录」。
 *
 * ## 摘录为什么要截断
 *
 * 一个活跃群一天几千条消息。全塞进提示词既超长又没用 ——
 * 总结需要的是"聊了什么主题"，不是逐字复述。所以按会话取最近的
 * 若干条、并截断单条长度。
 */

import { localDateKey } from './decay.mjs';

/** 单个会话最多取几条消息进提示词 */
export const MAX_MESSAGES_PER_CONV = 40;

/** 单条消息最多保留多少字符（长贴文只取开头） */
export const MAX_TEXT_CHARS = 200;

/** 最多涉及几个会话（按当天消息数排序，取最活跃的几个） */
export const MAX_CONVERSATIONS = 8;

/** 每天最多几条要点 */
export const MAX_HIGHLIGHTS = 12;

/** 单条要点的长度上限 */
export const MAX_HIGHLIGHT_CHARS = 200;

/**
 * 把一天的消息整理成"给模型看的摘录"。
 *
 * ## 为什么按会话分组而不是按时间平铺
 *
 * 群聊总结需要的是"这个群里讨论了什么"。平铺成一条时间线会让模型
 * 在多个群之间反复跳转，写出来的总结变成大杂烩。
 *
 * @param {Array<{convKey: string, messages: object[]}>} groups
 * @returns {{text: string, messageCount: number, convKeys: string[]}}
 */
export function buildDigest(groups) {
  const lines = [];
  const convKeys = [];
  let messageCount = 0;

  for (const g of groups ?? []) {
    if (!g || !Array.isArray(g.messages) || g.messages.length === 0) continue;
    if (convKeys.length >= MAX_CONVERSATIONS) break;

    convKeys.push(g.convKey);
    messageCount += g.messages.length;
    const label = g.convKey.startsWith('group:') ? `群 ${g.convKey.split(':')[1]}` : `私聊 ${g.convKey.split(':')[1]}`;
    lines.push(`## ${label}（${g.messages.length} 条）`);

    // 取最近的若干条：越靠后的越接近当天收尾，往往是话题结论
    const recent = g.messages.slice(-MAX_MESSAGES_PER_CONV);
    for (const m of recent) {
      const who = m.nickname || m.userId || '某人';
      const text = String(m.text ?? '').trim();
      if (!text) continue;
      const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
      lines.push(`${who}：${clipped}`);
    }
    lines.push('');
  }

  return { text: lines.join('\n').trim(), messageCount, convKeys };
}

/**
 * 生成日记要用的提示词。
 *
 * ## 为什么要求"只写发生过的事"
 *
 * 日总结最容易出的问题是模型开始编造——把"讨论了某个话题"写成
 * "决定做某件事"。用户回头翻日记时会把编造当成真的。
 * 所以提示词里要明确要求可追溯到原文。
 *
 * @param {string} date
 * @param {string} digest
 * @returns {Array<{role: string, content: string}>}
 */
export function buildSummaryPrompt(date, digest) {
  return [
    {
      role: 'system',
      content: [
        '你在为聊天机器人写当天聊天的日记。',
        '要求：',
        '1. 只写材料里确实发生过的事，不要编造决定、承诺或结论。',
        '2. 用第一人称写下"我记得今天"的口吻，但不要假装是自己经历的情绪。',
        '3. 结构：先两三句话概述今天主要在聊什么，再列 3~8 条要点。',
        '4. 每条要点一句话，能追溯到具体的人或话题。',
        '5. 涉及隐私（密码、证件号、住址）一律不写。',
        '6. 用中文。不要写"根据提供的内容"这类套话。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `日期：${date}\n\n当天聊天摘录：\n${digest || '（当天没有可摘录的内容）'}`,
    },
  ];
}

/**
 * 从模型回复里拆出「概述」与「要点」。
 *
 * 模型不一定严格按格式输出，所以这里要宽容：能拆出要点就拆，
 * 拆不出来就整段当概述（宁可少一点结构，也不要丢掉内容）。
 *
 * @param {string} text
 * @returns {{summary: string, highlights: string[]}}
 */
export function parseSummary(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { summary: '', highlights: [] };

  const lines = raw.split('\n');
  /** @type {string[]} */
  const highlights = [];
  /** @type {string[]} */
  const body = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    /*
     * 要点行：`- `、`* `、`1. `、`1、`、`• `。
     * 用宽松匹配是因为模型经常混用，硬要求一种格式会整天解析失败。
     */
    const m = /^(?:[-*•]|\d+[.、)])\s*(.+)$/.exec(t);
    if (m && m[1]) {
      const item = m[1].trim();
      if (item && highlights.length < MAX_HIGHLIGHTS) {
        highlights.push(item.length > MAX_HIGHLIGHT_CHARS ? `${item.slice(0, MAX_HIGHLIGHT_CHARS)}…` : item);
      }
      continue;
    }
    body.push(t);
  }

  // 没有要点行时，整段都是概述（不要为了结构整齐而丢内容）
  return { summary: body.join('\n').trim(), highlights };
}

/**
 * 模型不可用时的降级日记。
 *
 * ## 为什么不干脆不生成
 *
 * 空着会让用户以为程序坏了。而降级内容本身是有价值的：
 * "这天聊了 3 个群、237 条"这件事就是一条真实的记录，
 * 加上几条原文摘录，至少能让人想起那天发生了什么。
 *
 * ## 入参为什么收 digest 字符串而不是 buildDigest 的返回值
 *
 * 两种调用点都有（一个已经有了字符串，一个刚 build 完）。
 * 所以这里两种都接：传对象就取它的 `.text`，传字符串直接用。
 * 之前只接字符串，调用方传对象时要点会静默变成空数组 ——
 * 那正是"降级日记看起来更空"的来源，所以两种都容。
 *
 * @param {string} date
 * @param {{convKeys?: string[], messageCount?: number, digest?: string | {text?: string}}} input
 * @returns {{summary: string, highlights: string[]}}
 */
export function buildDegradedSummary(date, input) {
  const n = input?.messageCount ?? 0;
  const convs = input?.convKeys ?? [];
  const summary =
    n > 0
      ? `${date} 这天共有 ${n} 条消息，分布在 ${convs.length} 个会话里。这篇没有生成总结（模型当时不可用），下面是原始摘录。`
      : `${date} 这天没有可摘录的聊天内容。`;

  /*
   * 摘录来源有三种传法，都要容：
   *   1. 直接传 buildDigest() 的返回值（此时它就是 input 本身）
   *   2. 传 { digest: '<字符串>' }
   *   3. 传 { digest: buildDigest() 的返回值 }
   *
   * 只认第一种之外的某一种会让另一种调用点静默得到空要点 ——
   * 那正是"降级日记看起来比预期更空"的来源。
   */
  const rawDigest =
    typeof input === 'string'
      ? input
      : typeof input?.digest === 'string'
        ? input.digest
        : typeof input?.digest?.text === 'string'
          ? input.digest.text
          : typeof input?.text === 'string'
            ? input.text
            : '';

  /*
   * 从摘录里挑几行当要点。
   *
   * 跳过分组标题（`## `）和空行 —— 它们是结构不是内容。
   */
  const highlights = rawDigest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('##'))
    .slice(0, MAX_HIGHLIGHTS)
    .map((l) => (l.length > MAX_HIGHLIGHT_CHARS ? `${l.slice(0, MAX_HIGHLIGHT_CHARS)}…` : l));

  return { summary, highlights };
}

/**
 * 生成一天的日记并交给 store 保存。
 *
 * 这个函数**不抛异常**：所有失败路径都降级成一篇 degraded 日记。
 * 日记是"有更好"的数据，为了它让主流程崩掉是本末倒置。
 *
 * @param {object} input
 * @param {string} input.date 本地日期键
 * @param {Array<{convKey: string, messages: object[]}>} input.groups 当天各会话的消息
 * @param {object | null} input.llm LlmClient 实例（可为 null / 未配置）
 * @param {string} [input.model] 记入日记的模型名
 * @param {(messages: object[], opts?: object) => Promise<any>} [input.chat] 可注入的对话函数（便于测试）
 * @param {object} input.store DiaryStore 实例
 * @returns {Promise<{ok: boolean, date: string, degraded: boolean, messageCount: number, error?: string}>}
 */
export async function generateDiary(input) {
  const date = String(input?.date ?? '');
  const groups = Array.isArray(input?.groups) ? input.groups : [];
  const digest = buildDigest(groups);

  /*
   * 完全没内容时也要记一条：说明"这天没聊什么"。
   * 否则日记页会缺一天，看起来像漏生成。
   */
  if (digest.messageCount === 0) {
    const degraded = buildDegradedSummary(date, digest);
    const saved = await input.store.save({
      date,
      model: '',
      source: { convKeys: [], messageCount: 0 },
      summary: degraded.summary,
      highlights: degraded.highlights,
      degraded: true,
    });
    return { ok: saved.ok, date, degraded: true, messageCount: 0, error: saved.error };
  }

  /** @type {{summary: string, highlights: string[], degraded: boolean, error?: string}} */
  let result = { summary: '', highlights: [], degraded: true };
  let model = String(input?.model ?? '');

  // 只有真的配了客户端才尝试调模型
  const canCall = Boolean(input?.llm && typeof (input.chat ?? input.llm.chat) === 'function');
  if (canCall) {
    try {
      const messages = buildSummaryPrompt(date, digest.text);
      const call = input.chat ?? ((msgs, opts) => input.llm.chat(msgs, opts));
      const response = await call(messages, { temperature: 0.3 });
      const text = typeof response === 'string' ? response : (response?.text ?? '');
      const parsed = parseSummary(text);
      if (parsed.summary || parsed.highlights.length > 0) {
        result = { summary: parsed.summary, highlights: parsed.highlights, degraded: false };
      } else {
        // 模型返回了空内容：算降级，但记下原因
        result = { ...buildDegradedSummary(date, digest), degraded: true, error: '模型返回空内容' };
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      result = { ...buildDegradedSummary(date, digest), degraded: true, error: String(e?.message ?? e) };
    }
  } else {
    result = { ...buildDegradedSummary(date, digest), degraded: true, error: 'LLM 未配置或不可用' };
  }

  if (result.degraded) model = '';

  const saved = await input.store.save({
    date,
    model,
    source: { convKeys: digest.convKeys, messageCount: digest.messageCount },
    summary: result.summary,
    highlights: result.highlights,
    degraded: result.degraded,
  });

  return {
    ok: saved.ok,
    date,
    degraded: result.degraded,
    messageCount: digest.messageCount,
    error: saved.error ?? result.error,
  };
}

/**
 * 取某一天各会话的消息（供 generateDiary 的 groups 入参）。
 *
 * ## 为什么不在 store 里做
 *
 * session/store.mjs 只保留最近 200 条/会话。要生成**昨天**的日记，
 * 而这些消息可能已经被今天的消息挤掉了 —— 那时只能拿到残片。
 *
 * 所以这里显式声明这个局限：能取到多少就说多少，
 * 并在 messageCount 里如实反映。不要假装拿到了一整天的数据。
 *
 * @param {object} sessionStore SessionStore 实例
 * @param {string} date 本地日期键
 * @param {(tsMs: number) => string} toDayKey 把毫秒时间戳转成本地日期键
 * @returns {Array<{convKey: string, messages: object[]}>}
 */
export function collectGroupsForDate(sessionStore, date, toDayKey) {
  const convs = typeof sessionStore?.conversationsOn === 'function' ? sessionStore.conversationsOn(date) : [];
  const groups = [];
  for (const { convKey } of convs) {
    const page = sessionStore.page(convKey, { limit: 200 });
    if (!page?.ok) continue;
    const msgs = page.messages.filter((m) => {
      const ts = m.receivedAt || (m.time ? m.time * 1000 : 0);
      return toDayKey(ts) === date;
    });
    if (msgs.length > 0) groups.push({ convKey, messages: msgs });
  }
  return groups;
}

export { localDateKey };
