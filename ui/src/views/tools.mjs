/**
 * 工具记忆
 *
 * 文档把它归到两个分层：
 *   - **L3 情境知识层**：What to know —— 当前群/用户画像、长期记忆、场景上下文
 *   - **L4 任务与工具层**：What to do —— 本轮任务 + 可用工具（白名单 Schema）
 *
 * 外加 L5 输出契约层的只读展示（它是代码约定的，不让用户改）。
 *
 * ## 为什么工具列表要显示「谁能用」
 *
 * 一个工具"存在"和"这个来源能用"是两件事。用户看到 `fs_write` 在列表里
 * 就以为机器人能写文件，但可能它是 `owner-private` 专属——
 * 群里发一句话根本调不到。所以每行都标 origins 和 confirm 要求。
 *
 * ## 为什么这一页大多是只读
 *
 * L3/L4/L5 的内容主要由**代码和配置**决定（工具注册表在代码里，
 * 记忆库在 state 里）。这一页的定位是"看清楚现在有什么"，
 * 而不是编辑它们——真正能改的只有「主动唤醒概率」这类行为参数，
 * 那几个放在人格设置页更合适。
 */

import { el, pill, card, kv } from '../render.mjs';

/**
 * 风险档 → 药丸色调。
 *
 * R0 只读无害 / R1 只读敏感 / R2 写入或执行 / R3 不可逆
 *
 * @param {string} risk
 */
function riskPill(risk) {
  if (risk === 'R0') return pill('R0 只读', 'ok');
  if (risk === 'R1') return pill('R1 敏感', 'dim');
  if (risk === 'R2') return pill('R2 写入', 'warn');
  if (risk === 'R3') return pill('R3 不可逆', 'err');
  return pill(String(risk ?? '?'), 'dim');
}

/**
 * 来源 → 人话
 *
 * @param {string} o
 */
function originText(o) {
  switch (o) {
    case 'owner-private':
      return '主人私聊';
    case 'owner-group':
      return '主人群聊';
    case 'group':
      return '普通群';
    case 'proactive':
      return '主动唤醒';
    case 'console':
      return '控制台';
    default:
      return String(o);
  }
}

/**
 * @param {any} snap
 * @param {any} [ctx]
 * @returns {HTMLElement}
 */
export function renderTools(snap, ctx = {}) {
  const root = el('div', {});

  if (snap?.booting) {
    return el('div', {}, [card('正在启动', [el('div', { class: 'muted', text: '稍等一秒…' })])]);
  }

  const registry = snap?.registry ?? {};
  const tools = Array.isArray(registry.tools) ? registry.tools : [];
  const brain = snap?.brain ?? {};
  const personaCards = snap?.personaCards ?? {};

  /* ------------------------------------------------------ L3 情境知识 */

  const convs = Array.isArray(brain.conversations) ? brain.conversations : [];

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: 'L3 情境知识层 · What to know' }),
      el('div', {
        class: 'muted',
        text: '当前会话的画像、最近活跃度与主动发言的计数。这些是机器人判断"该不该说话"的依据。',
      }),
      el('div', { class: 'spacer-10' }),
      convs.length === 0
        ? el('div', { class: 'empty', text: '还没有会话记录。' })
        : el(
            'table',
            {},
            [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: '会话' }),
                  el('th', { text: '近期消息' }),
                  el('th', { text: '主动发言' }),
                  el('th', { text: '最近人工发言' }),
                ]),
              ]),
              el(
                'tbody',
                {},
                convs.map((c) =>
                  el('tr', {}, [
                    el('td', { class: 'mono', text: String(c.convKey ?? '—') }),
                    el('td', { class: 'mono', text: String(c.recent ?? 0) }),
                    el('td', { class: 'mono', text: String(c.proactiveCount ?? c.count ?? 0) }),
                    el('td', { class: 'mono', text: c.lastHumanAt ? new Date(c.lastHumanAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }),
                  ]),
                ),
              ),
            ],
          ),
      el('div', { class: 'field-hint' }, [
        el('div', {
          text: '「主动发言」是它在没人要求的情况下说话的次数。连续主动会被 30 分钟冷却压住，避免刷屏。',
        }),
      ]),
    ]),
  );

  /* ------------------------------------------------------ L4 任务与工具 */

  const toolRows = tools.map((t) => {
    const origins = Array.isArray(t.origins) ? t.origins : [];
    const groupHidden = origins.length > 0 && !origins.includes('group');
    return el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'mono', text: String(t.name ?? '?') }),
        t.description ? el('div', { class: 'field-hint', text: String(t.description).slice(0, 90) }) : null,
      ]),
      el('td', {}, [riskPill(t.risk)]),
      el('td', {}, [
        el(
          'div',
          { class: 'row wrap' },
          origins.length === 0 ? [pill('无来源可用', 'err')] : origins.map((o) => pill(originText(o), 'dim')),
        ),
      ]),
      el('td', {}, [
        t.confirm === 'always'
          ? pill('每次都要确认', 'warn')
          : t.confirm === 'risk'
            ? pill('按风险确认', 'dim')
            : pill('不需确认', 'ok'),
        groupHidden ? el('div', { class: 'field-hint', text: '群聊不可用' }) : null,
      ]),
    ]);
  });

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: 'L4 任务与工具层 · What to do' }),
      el('div', {
        class: 'muted',
        text: '当前注册的全部工具，以及每个工具对哪些来源开放、要不要人工确认。',
      }),
      el('div', { class: 'spacer-10' }),
      tools.length === 0
        ? el('div', { class: 'empty', text: '没有注册任何工具。' })
        : el(
            'table',
            {},
            [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: '工具' }),
                  el('th', { text: '风险' }),
                  el('th', { text: '可用来源' }),
                  el('th', { text: '确认' }),
                ]),
              ]),
              el('tbody', {}, toolRows),
            ],
          ),
      el('div', { class: 'hint' }, [
        el('div', { text: '「可用来源」是硬边界，不是提示：群里发一句话永远不会拿到宿主机工具。' }),
      ]),
    ]),
  );

  /* ------------------------------------------------------ L5 输出契约 */

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: 'L5 输出契约层 · How to answer' }),
      el('div', {
        class: 'muted',
        text: '回复格式由代码约定，不开放编辑——松开它等于让模型自己决定协议。',
      }),
      el('div', { class: 'spacer-10' }),
      kv('分段发送', '允许（按空行切分，逐条发出）'),
      kv('单条长度上限', '由 OneBot 侧限制，超长会被上游截断'),
      kv('工具调用格式', 'OpenAI function calling，由运行时解析'),
      kv('出站审计', '含本机路径或凭据特征的回复会被拦下'),
    ]),
  );

  /* ------------------------------------------------------ 人格卡摘要 */

  const cards = Array.isArray(personaCards.cards) ? personaCards.cards : [];
  if (cards.length > 0) {
    root.append(
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

  return root;
}
