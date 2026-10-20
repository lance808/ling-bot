/**
 * 词元消耗
 *
 * 文档要求：总花费 token / 输入 ｜ 输出 / 缓存命中率（命中 ｜ 未命中）/
 * 平均每轮 / 时间范围（24h / 3d / 7d / 30d）。
 *
 * ## 三个必须诚实的地方
 *
 * **① 不支持计算花费。** 文档明确写了"不支持计算花费"。
 * 不同提供商的计价单位、阶梯、缓存折扣都不一样，硬算出一个金额
 * 只会给人一个错误的确定感。所以这一页**只显示 token**，
 * 不出现任何货币符号。
 *
 * **② 缓存命中率可能没有。** 只有部分提供商在 usage 里返回
 * `prompt_tokens_details.cached_tokens`。拿不到时显示"—"并说明原因，
 * 绝不显示 0%——0% 是"一次都没命中"，和"不知道"是两件事。
 *
 * **③ 估算值要标出来。** 上游没返回 usage 时我们按字符估，
 * 那部分必须单独计数，否则用户会把它当成精确值。
 */

import { el, pill, clock } from '../render.mjs';
import { usageAggregate } from '../contracts.mjs';

/** 时间范围选项 */
const RANGES = [
  { key: '24h', label: '近 24 小时', ms: 24 * 3600_000 },
  { key: '3d', label: '近 3 天', ms: 3 * 24 * 3600_000 },
  { key: '7d', label: '近 7 天', ms: 7 * 24 * 3600_000 },
  { key: '30d', label: '近 30 天', ms: 30 * 24 * 3600_000 },
];

/**
 * @param {any} snap
 * @param {{range?: string, onRange?: (r: string) => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderUsage(snap, ctx = {}) {
  const rangeKey = ctx.range ?? '24h';
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0];

  const usage = snap?.usage ?? {};
  const recent = Array.isArray(usage.recent) ? usage.recent : [];

  const root = el('div', {});

  /* ---------------------------------------------------- 时间范围 */

  const seg = el('div', { class: 'segmented' });
  for (const r of RANGES) {
    seg.append(
      el('button', {
        type: 'button',
        text: r.label,
        'aria-pressed': r.key === rangeKey ? 'true' : 'false',
        onclick: () => ctx.onRange?.(r.key),
      }),
    );
  }

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '统计范围' }),
      el('div', { class: 'row wrap' }, [
        seg,
        el('span', {
          class: 'field-hint',
          text: '按本机完整账本统计；切换范围读取本地历史，不请求上游。',
        }),
      ]),
    ]),
  );

  /* ---------------------------------------------------- 聚合 */

  const cutoff = Date.now() - range.ms;
  const inRange = recent.filter((r) => Number(r.at ?? 0) >= cutoff);

  const agg = {
    calls: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    estimated: 0,
    cached: 0,
    /** 有多少次调用真的报告了缓存明细 */
    cacheReported: 0,
  };

  const totals = usage.range;
  const matchesRange = totals && Math.abs(Number(totals.since) - cutoff) < 60000;
  const complete = matchesRange && totals.covered === true;
  if (matchesRange) {
    Object.assign(agg, usageAggregate(totals));
  }
  const cachePrompt = matchesRange ? num(totals.cachePromptTokens) : 0;
  const avgPerTurn = agg.calls > 0 ? Math.round(agg.total / agg.calls) : 0;
  const missTokens = Math.max(0, cachePrompt - agg.cached);
  const hitRate = cachePrompt > 0 && agg.cacheReported > 0 ? Math.round((agg.cached / cachePrompt) * 100) : null;
  if (!complete) root.append(el('div', { class: 'hint', role: 'status', text: matchesRange ? `统计可能不完整：${totals.lastError?.message ?? totals.lastError ?? '部分历史记录无法读取'}` : '正在读取所选范围的完整账本，当前不以最近记录代替总量。' }));

  /* ---------------------------------------------------- 总量 */

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: `总消耗（${range.label}）` }),
      el('div', { class: 'metrics' }, [
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '总 token' }),
          el('div', { class: 'value', text: matchesRange ? fmt(agg.total) : '—' }),
          el('div', { class: 'sub' }, [el('span', { class: 'pill pill-dim', text: matchesRange ? `${agg.calls} 次调用` : '等待统计' })]),
        ]),
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '输入 ｜ 输出' }),
          el('div', { class: 'value sm', text: matchesRange ? `${fmt(agg.prompt)} ｜ ${fmt(agg.completion)}` : '—' }),
          el('div', { class: 'sub' }, [
            el('span', {
              class: 'pill pill-dim',
              text: agg.total > 0 ? `输入占 ${Math.round((agg.prompt / agg.total) * 100)}%` : '暂无数据',
            }),
          ]),
        ]),
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '平均每轮' }),
          el('div', { class: 'value', text: matchesRange ? fmt(avgPerTurn) : '—' }),
          el('div', { class: 'sub' }, [el('span', { class: 'pill pill-dim', text: 'token / 次调用' })]),
        ]),
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '缓存命中率' }),
          el('div', { class: 'value', text: hitRate === null ? '—' : `${hitRate}%` }),
          el('div', { class: 'sub' }, [
            el('span', {
              class: `pill ${hitRate === null ? 'pill-dim' : 'pill-ok'}`,
              text: hitRate === null ? '没有可用缓存明细' : `命中 ${fmt(agg.cached)} / 未命中 ${fmt(missTokens)}（${agg.cacheReported}/${agg.calls} 次有明细）`,
            }),
          ]),
        ]),
      ]),
      // 缓存缺失要说清原因，否则"—"看起来像坏了
      hitRate === null
        ? el('div', { class: 'field-hint' }, [
            el('div', {
              text:
                agg.calls > 0
                  ? '这个区间内的调用都没有返回缓存明细。多数第三方中转不提供该字段，只报告总 prompt token。'
                  : '这个区间还没有调用记录。',
            }),
          ])
        : null,
      agg.estimated > 0
        ? el('div', { class: 'hint' }, [
            el('div', {
              text: `其中 ${agg.estimated} 次调用的 token 是按字符估算的（上游没返回 usage），那部分不是精确值。`,
            }),
          ])
        : null,
    ]),
  );

  /* ---------------------------------------------------- 不支持计价 */

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '关于花费' }),
      el('div', { class: 'muted', text: '本页只统计 token，不折算金额。' }),
      el('div', { class: 'field-hint' }, [
        el('div', {
          text:
            '不同提供商的计价单位、阶梯价、缓存折扣都不一样，用一张价目表硬算会给出错误的确定感。要算钱请在提供商后台看账单。',
        }),
      ]),
    ]),
  );

  /* ---------------------------------------------------- 明细 */

  const rows = inRange.slice(-50).reverse();
  const table = el('table', {}, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '时间' }),
        el('th', { text: '会话' }),
        el('th', { text: '模型' }),
        el('th', { text: '输入' }),
        el('th', { text: '输出' }),
        el('th', { text: '合计' }),
        el('th', { text: '来源' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      rows.map((r) =>
        el('tr', {}, [
          el('td', { class: 'mono', text: clock(r.at) }),
          el('td', { class: 'mono', text: shortConv(r.convKey) }),
          el('td', { class: 'mono', text: String(r.model ?? '—') }),
          el('td', { class: 'mono', text: fmt(r.promptTokens) }),
          el('td', { class: 'mono', text: fmt(r.completionTokens) }),
          el('td', { class: 'mono', text: `${fmt(r.totalTokens)}${r.estimated ? ' ≈' : ''}` }),
          el('td', {}, [r.proactive ? pill('主动', 'warn') : pill('被动', 'dim')]),
        ]),
      ),
    ),
  ]);

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: `明细（最近 ${rows.length} 条）` }),
      rows.length === 0 ? el('div', { class: 'empty', text: '这个区间还没有调用记录。' }) : table,
      rows.some((r) => r.estimated)
        ? el('div', { class: 'field-hint', text: '带 ≈ 的是估算值。' })
        : null,
    ]),
  );

  return root;
}

/** @param {any} n */
function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** 千分位 */
function fmt(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

/**
 * 会话键缩写。
 *
 * `group:<群号>` 这种完整键在表格里太长，但也不能截断成看不出类型。
 * 保留前缀，只压缩中间。
 *
 * @param {string} key
 */
function shortConv(key) {
  const s = String(key ?? '');
  if (!s) return '—';
  const [kind, id] = s.split(':');
  const k = kind === 'group' ? '群' : kind === 'private' ? '私' : kind;
  return id ? `${k} ${id.slice(-6)}` : s;
}
