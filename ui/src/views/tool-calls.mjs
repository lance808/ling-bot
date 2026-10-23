/**
 * 工具调用 —— F21
 *
 * 这一页回答一个问题：**它现在能做什么？**
 *
 * ## 和「插件设置」的分工
 *
 * 两页看的是同一批工具，但视角不同：
 *
 *   插件设置  —— 按**插件**组织：这个插件启用了吗、它的工具能不能用
 *   工具调用  —— 按**工具**组织：这个工具谁调得到、要不要确认
 *
 * 统一的地方在于：**两页的数据都来自同一个运行时注册表**（`snap.registry.tools`），
 * 不做第二份缓存。所以插件启用/停用后，工具在这里会自动出现或消失，
 * 不需要重启，也不需要手动刷新 —— 快照轮询本身就带了这个变化。
 *
 * ## 为什么这一页单独存在
 *
 * 工具列表原先挂在《工具记忆》页，和"它记得什么"混在一起。
 * 后果很具体：用户想确认「群里到底能不能让它读文件」时，
 * 得先想到去看一个叫「工具记忆」的页面。名字和内容对不上。
 *
 * 现在拆出来，和插件设置放一起 —— 它们是同一类东西（能力），
 * 而不是记忆。
 *
 * ## 为什么工具列表必须显示「谁能用」
 *
 * 一个工具"存在"和"这个来源能用"是两件事。用户看到 `fs_write` 在列表里
 * 就以为机器人能写文件，但可能它是 `owner-private` 专属 ——
 * 群里发一句话根本调不到。所以每行都标 origins 和 confirm。
 */

import { el, pill, card } from '../render.mjs';

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
export function renderToolCalls(snap, ctx = {}) {
  if (snap?.booting) {
    return el('div', {}, [card('正在启动', [el('div', { class: 'muted', text: '稍等一秒…' })])]);
  }

  const registry = snap?.registry ?? {};
  const tools = Array.isArray(registry.tools) ? registry.tools : [];

  /*
   * 按来源分组统计。
   *
   * 这比"一共 N 个工具"有用得多 —— 用户真正关心的是
   * "群里能用几个"，而那正是最容易出错的地方。
   */
  const hostOnly = tools.filter((t) => {
    const origins = Array.isArray(t.origins) ? t.origins : [];
    return origins.length > 0 && !origins.includes('group') && !origins.includes('owner-group');
  });
  const groupUsable = tools.filter((t) => {
    const origins = Array.isArray(t.origins) ? t.origins : [];
    return origins.includes('group') || origins.includes('owner-group');
  });
  const dead = tools.filter((t) => (Array.isArray(t.origins) ? t.origins : []).length === 0);

  const toolRows = tools.map((t) => {
    const origins = Array.isArray(t.origins) ? t.origins : [];
    const groupHidden = origins.length > 0 && !origins.includes('group') && !origins.includes('owner-group');
    return el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'mono', text: String(t.name ?? '?') }),
        t.description ? el('div', { class: 'field-hint', text: String(t.description).slice(0, 90) }) : null,
        // 插件来源要标出来：用户据此去「插件设置」页定位。
        // 字段名是 `plugin`（由 PluginManager 注册时写入），不是 pluginId。
        t.plugin ? el('div', { class: 'field-hint', text: `来自插件 ${t.plugin}` }) : null,
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

  const listCard = el('section', { class: 'card' }, [
    el('h2', { text: '当前注册的工具' }),
    el('div', {
      class: 'muted',
      text: '运行时注册表里的全部工具。插件启用或停用后这里会立即反映，不需要重启。',
    }),
    el('div', { class: 'spacer-10' }),
    tools.length === 0
      ? el('div', { class: 'empty', text: '没有注册任何工具。' })
      : el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: '工具' }),
              el('th', { text: '风险' }),
              el('th', { text: '可用来源' }),
              el('th', { text: '确认' }),
            ]),
          ]),
          el('tbody', {}, toolRows),
        ]),
    el('div', { class: 'hint' }, [
      el('div', { text: '「可用来源」是硬边界，不是提示：群里发一句话永远不会拿到宿主机工具。' }),
    ]),
  ]);

  const summaryCard = el('section', { class: 'card' }, [
    el('h2', { text: '来源边界' }),
    el('div', {
      class: 'muted',
      text: '同样的工具，不同来源的可见性由代码约定，配置改不了。',
    }),
    el('div', { class: 'spacer-10' }),
    el('div', { class: 'row wrap' }, [
      pill(`共 ${tools.length} 个工具`, 'dim'),
      pill(`群聊可用 ${groupUsable.length} 个`, groupUsable.length > 0 ? 'ok' : 'dim'),
      pill(`仅宿主机 ${hostOnly.length} 个`, 'warn'),
      dead.length > 0 ? pill(`${dead.length} 个谁都调不到`, 'err') : null,
    ].filter(Boolean)),
    el('div', { class: 'spacer-12' }),
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [el('th', { text: '回合来源' }), el('th', { text: '能用什么工具' })]),
      ]),
      el('tbody', {}, [
        el('tr', {}, [
          el('td', { class: 'mono', text: 'owner-private' }),
          el('td', {}, [pill('宿主机工具（按配置）', 'warn')]),
        ]),
        el('tr', {}, [
          el('td', { class: 'mono', text: 'owner-group' }),
          el('td', {}, [pill('仅 QQ 工具', 'dim')]),
        ]),
        el('tr', {}, [
          el('td', { class: 'mono', text: 'group' }),
          el('td', {}, [pill('仅 QQ 工具', 'dim')]),
        ]),
      ]),
    ]),
  ]);

  return el('div', {}, [summaryCard, el('div', { class: 'spacer-12' }), listCard]);
}
