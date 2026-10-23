/**
 * 记忆 —— F21
 *
 * 这一页回答一个问题：**它记得什么？**
 *
 * 组成只有三块，都是"记忆"的不同形态：
 *
 *   1. **情境知识**：每个会话的近况、主动发言计数 —— 短期、按会话
 *   2. **日记**：每天一篇的经历总结，权重随时间淡忘 —— 长期、按天
 *   3. **人格卡**：跨会话的记忆载体，切换会换掉整套人设 —— 全局
 *
 * ## 为什么把日记并进来
 *
 * 日记和人格卡本来是"它记得什么"的两种形态，分成两个侧栏入口，
 * 用户会以为它们是两套互不相干的机制：调完日记的淡忘，
 * 又去另一页找"记忆"在哪。
 *
 * ## 为什么工具列表搬走了
 *
 * 工具列表曾经也在这一页。但它不是记忆 —— 它是**能力清单**：
 * 机器人现在能做什么、哪些来源能用、要不要确认。和"记得什么"无关。
 *
 * 放在这里的实际后果是：用户想确认"群里到底能不能让机器人读文件"
 * 时，得先想到去看一个叫「工具记忆」的页面。名字和内容对不上。
 *
 * 现在拆到《工具调用》页，和插件设置用同一套逻辑（见 `tools.mjs`）。
 *
 * ## 为什么这一页大部分是只读
 *
 * 情境知识由运行时行为决定（发了多少、什么时候主动过），
 * 日记由调度器生成。用户能做的只有"锁定某天"和"重新生成"。
 * 给这些加编辑框是假的 —— 改数字不会改变它实际记得什么。
 */

import { el, pill, card } from '../render.mjs';
import { renderDiarySection } from './diary.mjs';

/**
 * 毫秒 → 「刚 / 5 分钟前 / 2 小时前」。
 *
 * 比绝对时间有用：用户看「14:32:07」还得自己算过了多久，
 * 而这里要判断的正是"还算不算新鲜"。
 *
 * @param {number} ts 毫秒时间戳
 */
function relativeTime(ts) {
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff) || diff < 0) return '—';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 毫秒 → 「约 12 分钟」。
 *
 * @param {number} ms
 */
function humanMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60_000) return `约 ${Math.max(1, Math.round(n / 1000))} 秒`;
  if (n < 3_600_000) return `约 ${Math.round(n / 60_000)} 分钟`;
  return `约 ${(n / 3_600_000).toFixed(1)} 小时`;
}

/**
 * 「现在能主动吗」这一格。
 *
 * ## 三档而不是两档
 *
 *   · 冷却/冷群 → 黄色，附"还要等多久"
 *   · 护栏都过了 → 蓝色，但明说"看概率"
 *   · 私聊       → 灰色，说明它本来就不在私聊主动
 *
 * 中间那档是关键：它**不是**绿色。给绿色等于承诺"马上会说"，
 * 而实际上按 10% 概率大部分时候不动 —— 用户会以为功能坏了。
 *
 * @param {{ready?: boolean, reason?: string, retryAfterMs?: number | null, rollable?: boolean}} [p]
 * @returns {HTMLElement}
 */
function proactiveCell(p) {
  if (!p) return el('span', { class: 'muted', text: '—' });

  if (p.rollable === true) {
    return el('div', {}, [
      pill('可以，但看概率', 'dim'),
      el('div', { class: 'field-hint', text: p.reason ?? '' }),
    ]);
  }

  const retry = Number(p.retryAfterMs);
  if (Number.isFinite(retry) && retry > 0) {
    return el('div', {}, [
      pill('冷却中', 'warn'),
      el('div', { class: 'field-hint', text: `还要${humanMs(retry)}（${p.reason ?? ''}）` }),
    ]);
  }

  return el('div', {}, [
    pill('不会主动', 'dim'),
    el('div', { class: 'field-hint', text: p.reason ?? '' }),
  ]);
}

/**
 * @param {any} snap
 * @param {any} [ctx]
 * @returns {HTMLElement}
 */
export function renderMemory(snap, ctx = {}) {
  const root = el('div', {});

  if (snap?.booting) {
    return el('div', {}, [card('正在启动', [el('div', { class: 'muted', text: '稍等一秒…' })])]);
  }

  const brain = snap?.brain ?? {};
  const convs = Array.isArray(brain.conversations) ? brain.conversations : [];
  const personaCards = snap?.personaCards ?? {};

  /* ------------------------------------------------ 情境知识 */

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '情境知识' }),
      el('div', {
        class: 'muted',
        text:
          '每个会话现在的触发状态：它凭什么判断该不该主动开口，以及还差什么。' +
          '「主动发言」是累计真实次数。',
      }),
      el('div', { class: 'spacer-10' }),
      convs.length === 0
        ? el('div', {
            class: 'empty',
            text:
              '还没有会话记录。这里读的是落盘的会话楼层，' +
              '所以收到过消息之后即使重启也仍然会显示。',
          })
        : el('table', {}, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: '会话' }),
                el('th', { text: '消息' }),
                el('th', { text: '未读' }),
                el('th', { text: '主动发言' }),
                el('th', { text: '最近真人发言' }),
                el('th', { text: '现在能主动吗' }),
              ]),
            ]),
            el(
              'tbody',
              {},
              convs.map((c) =>
                el('tr', {}, [
                  el('td', { class: 'mono', text: String(c.convKey ?? '—') }),
                  el('td', { class: 'mono', text: String(c.recent ?? 0) }),
                  /*
                   * 未读为 0 时显示破折号而不是 0：
                   * 一列全是 0 会让人以为这个数字没在更新。
                   */
                  el('td', {
                    class: 'mono',
                    text: (c.unread ?? 0) > 0 ? String(c.unread) : '—',
                  }),
                  el('td', { class: 'mono', text: String(c.proactiveCount ?? 0) }),
                  el('td', {
                    class: 'mono',
                    text: c.lastHumanAt ? relativeTime(c.lastHumanAt) : '—',
                  }),
                  el('td', {}, [proactiveCell(c.proactive)]),
                ]),
              ),
            ),
          ]),
      el('div', { class: 'field-hint' }, [
        el('div', {
          text:
            '主动发言要同时过三道护栏：最近 30 分钟内有人说过话（冷群不开口）、' +
            '距上次主动 ≥ 30 分钟、自动回合节流。都过了还要按概率掷骰子 —— ' +
            '所以那一列显示「可以，但看概率」不等于它马上会说。',
        }),
        el('div', {
          text:
            '「主动发言」与「最近真人发言」是运行期状态，重启后归零；' +
            '「消息」「未读」来自落盘楼层，重启后仍然准确。',
        }),
      ]),
    ]),
  );

  /* ------------------------------------------------ 日记 */

  root.append(
    el('div', { class: 'spacer-12' }),
    el('section', { class: 'card' }, [
      el('h2', { text: '日记与淡忘' }),
      el('div', {
        class: 'muted',
        text: '跨过零点后生成前一天的经历总结。每篇有权重，随时间淡忘。',
      }),
      el('div', { class: 'spacer-10' }),
      renderDiarySection(snap, { rerender: ctx.rerender }),
    ]),
  );

  /* ------------------------------------------------ 人格卡 */

  const cards = Array.isArray(personaCards.cards) ? personaCards.cards : [];
  if (cards.length > 0) {
    root.append(
      el('div', { class: 'spacer-12' }),
      el('section', { class: 'card' }, [
        el('h2', { text: '记忆载体 · 人格卡' }),
        el('div', {
          class: 'muted',
          text: '人格卡是跨会话的记忆载体：切换卡片会换掉整套人设与上下文。',
        }),
        el('div', { class: 'spacer-10' }),
        el(
          'div',
          { class: 'list' },
          cards.map((c) =>
            el('div', { class: 'msg' }, [
              el('div', { class: 'meta' }, [
                c.id === personaCards.activeId ? pill('当前使用', 'ok') : pill('备用', 'dim'),
              ]),
              el('div', { text: String(c.name ?? c.id ?? '未命名') }),
            ]),
          ),
        ),
      ]),
    );
  }

  /* ------------------------------------------------ 指向工具页 */

  root.append(
    el('div', { class: 'spacer-12' }),
    el('section', { class: 'card' }, [
      el('h2', { text: '它现在能做什么？' }),
      el('div', {
        class: 'muted',
        text:
          '工具不是记忆，是能力。它现在注册了哪些工具、对哪些来源开放、' +
          '要不要人工确认，都在「工具调用」页。',
      }),
    ]),
  );

  return root;
}
