/**
 * 语言页 —— 「怎么说、什么时候说、什么时候别说」
 *
 * ## 为什么这三块合成一页
 *
 * 它们回答的是同一件事的三个侧面，而且**互相牵制**：
 *
 *   唤醒   —— 什么消息值得起一个回合（该不该开口）
 *   分条   —— 一次回复拆成几个气泡（开口了怎么说）
 *   静音   —— 现在根本不许说话（绝对不提）
 *
 * 拆成三个侧栏入口时，用户想调"它说话太密"得在《唤醒》和《静音》之间来回跳，
 * 看到"唤醒频率 6 次/分"也不知道还有个分条上限在起作用。
 * 合成一页之后，「语言」这个入口本身就说明了范围。
 *
 * ## 为什么用页内分栏而不是三段平铺
 *
 * 三块合起来有二十多个字段。平铺会让用户滚很久才找到"静音"，
 * 而它们本来就不是同一时刻要调的东西 —— 分栏保留了"一次只调一件事"的清晰度。
 *
 * ## 状态为什么放在模块作用域
 *
 * 快照每 2 秒轮询、每次整页重建 DOM。当前选中哪一栏如果存在局部变量里，
 * 两秒后就会跳回第一栏 —— 表现成"我刚切到静音，它自己跳回去了"。
 * 各子区块自己的保存结果同理，都在各自模块里（silence.mjs / reply-split.mjs）。
 */

import { el } from '../render.mjs';
import { renderWake } from './wake.mjs';
import { renderReplySplit } from './reply-split.mjs';
import { renderSilence } from './silence.mjs';

/**
 * 页内状态。
 *
 * @type {{tab: 'wake'|'split'|'silence'}}
 */
const ui = { tab: 'wake' };

/**
 * 三个分栏。
 *
 * 顺序就是用户的思考顺序：先"该不该开口"，再"开口怎么说"，
 * 最后"怎么让它别开口"。静音放最后是有意的 —— 它是兜底手段，
 * 不是日常调节项（用户真正想调的多半是唤醒与分条）。
 */
const TABS = [
  {
    id: 'wake',
    label: '唤醒',
    hint: '什么消息值得起一个回合，以及频率硬限',
    render: (snap, ctx) => renderWake(snap, ctx),
  },
  {
    id: 'split',
    label: '分条',
    hint: '一次回复拆成几个气泡，以及模型输出约定',
    render: (snap, ctx) => renderReplySplit(snap, ctx),
  },
  {
    id: 'silence',
    label: '静音',
    hint: '让它闭嘴：全局 / 按会话 / 时段 / 聊天指令',
    render: (snap, ctx) => renderSilence(snap, ctx),
  },
];

/**
 * 页内分栏条。
 *
 * 用 `.seg` / `.seg-btn`（和《人物设置》的人格/角色切换同一套）：
 * 同一类交互在同一个界面里用同一种外观，用户不用重新学。
 *
 * @param {() => void} [rerender]
 * @returns {HTMLElement}
 */
function tabBar(rerender) {
  return el(
    'div',
    { class: 'seg' },
    TABS.map((t) =>
      el('button', {
        type: 'button',
        class: `seg-btn${ui.tab === t.id ? ' active' : ''}`,
        text: t.label,
        onclick: () => {
          if (ui.tab === t.id) return;
          ui.tab = /** @type {any} */ (t.id);
          rerender?.();
        },
      }),
    ),
  );
}

/**
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderLanguage(snap, ctx = {}) {
  const rerender = ctx.rerender;
  const current = TABS.find((t) => t.id === ui.tab) ?? TABS[0];

  const intro = el('div', { class: 'field-hint', text: `${current.label}：${current.hint}` });

  /*
   * 子区块的 rerender 用的还是整页重绘 —— 和《人物设置》一致。
   *
   * 不各自只刷自己那一段，是因为保存成功后快照要重新拉（配置变了），
   * 而局部刷新拿不到新快照。整页重绘会保留当前分栏（状态在模块里），
   * 所以用户看不到"跳回第一栏"。
   */
  const body = current.render(snap, { rerender });

  return el('div', {}, [tabBar(rerender), el('div', { class: 'spacer-10' }), intro, el('div', { class: 'spacer-12' }), body]);
}

/** 仅供测试：把分栏复位到第一栏，避免用例之间互相影响 */
export function resetLanguagePageState() {
  ui.tab = 'wake';
}

/** 仅供测试：读当前分栏 */
export function currentLanguageTab() {
  return ui.tab;
}
