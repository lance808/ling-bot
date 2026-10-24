/**
 * 静音区块（「闭嘴」）—— F20（嵌在《语言》页的「静音」分栏里）
 *
 * 注意：这块**不是独立页面**。它和「唤醒」「分条」一起组成了《语言》页 ——
 * 三者是同一件事的三个侧面（该不该开口 / 开口怎么说 / 现在能不能说）。
 * 页内分栏见 `ui/src/views/language.mjs`。
 *
 * ## 这一块要回答的问题
 *
 * 用户切过来通常只有两个原因：**它太吵了**，或者**它不说话了**。
 * 所以顶部必须一眼给出「现在到底闭没闭嘴、为什么」，
 * 而不是先摆一堆开关让人自己推。
 *
 * ## 为什么把「配置里设的」和「现在实际生效的」分开显示
 *
 * 这是本页最重要的一点。用户看到的必须是**现在为什么不说话**：
 *
 *   · 时段静默可能在半夜自动开始 —— 开关都是关的，它就是不回话
 *   · 聊天里的「闭嘴」指令开了一个 30 分钟的临时静音 —— 配置里完全看不出来
 *
 * 只显示配置会让用户对着开关发愣：「我明明没开全局静音，它怎么不回我？」
 * 所以顶部那块「当前状态」是独立计算的，和下面的开关不是同一份数据。
 *
 * ## 四种静音的分层
 *
 * 全局 > 按会话 > 临时 > 时段。任一命中就闭嘴。
 * 页面上按这个顺序排，因为这也是排查顺序 —— 用户从上往下看就能找到原因。
 */

import { el, card, pill } from '../render.mjs';
import { setting, action } from '../api.mjs';

/**
 * 页面级状态（快照每次轮询都整页重建，所以只放输入草稿与反馈）。
 */
const ui = {
  /** 新增会话键的输入框内容 */
  convDraft: '',
  /** 新增时段的草稿 */
  winStart: '23:00',
  winEnd: '08:00',
  /** 操作反馈 */
  /** @type {{ok: boolean, text: string} | null} */
  note: null,
  /** 正在保存 */
  busy: false,
};

/**
 * 现在为什么闭嘴 —— 一行话。
 *
 * @param {any} s 快照里的 silence
 * @returns {{tone: string, text: string}}
 */
function statusLine(s) {
  if (s?.all === true) {
    return { tone: 'err', text: s.summary || '全局静音：所有会话都不回复' };
  }
  if (s?.windowHit === true) {
    return { tone: 'warn', text: s.summary || '处于静默时段' };
  }
  const temp = Array.isArray(s?.temporary) ? s.temporary : [];
  if (temp.length > 0) {
    return { tone: 'warn', text: `${temp.length} 个会话被临时静音` };
  }
  if ((s?.convKeys?.length ?? 0) > 0) {
    return { tone: 'warn', text: `${s.convKeys.length} 个会话被单独静音` };
  }
  return { tone: 'ok', text: '正常说话中' };
}

/** 毫秒 → 人类可读 */
function humanMs(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return '不限';
  if (n < 60_000) return `${Math.round(n / 1000)} 秒`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)} 分钟`;
  const h = n / 3_600_000;
  return Number.isInteger(h) ? `${h} 小时` : `${h.toFixed(1)} 小时`;
}

/** 保存一项设置并重绘 */
async function save(key, value, rerender) {
  ui.busy = true;
  ui.note = { ok: true, text: '保存中…' };
  rerender?.();
  const r = await setting(key, value);
  ui.busy = false;
  ui.note = r?.ok
    ? { ok: true, text: '已保存' }
    : { ok: false, text: `${r?.code ?? ''} ${r?.message ?? '保存失败'}`.trim() };
  rerender?.();
}

/**
 * 开关行。
 *
 * 结构与唤醒页的 `toggleRow` 保持一致（`field` > `label.row` > checkbox + `field-label`）：
 * 两个页面都是"一排开关 + 说明"，样式不同会让用户以为是两种东西。
 *
 * @param {string} label
 * @param {string} hint
 * @param {boolean} checked
 * @param {(v: boolean) => void} onChange
 * @param {boolean} [disabled]
 */
function switchRow(label, hint, checked, onChange, disabled = false) {
  const box = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', class: 'checkbox' }));
  box.checked = checked === true;
  if (disabled) box.disabled = true;
  box.addEventListener('change', () => onChange(box.checked));

  return el('div', { class: 'field' }, [
    el('label', { class: 'row' }, [box, el('span', { class: 'field-label', text: label })]),
    el('div', { class: 'field-hint', text: hint }),
  ]);
}

/**
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderSilence(snap, ctx = {}) {
  const s = snap?.silence ?? {};
  const rerender = ctx.rerender;
  const st = statusLine(s);
  const temp = Array.isArray(s.temporary) ? s.temporary : [];
  const windows = Array.isArray(s.windows) ? s.windows : [];
  const convKeys = Array.isArray(s.convKeys) ? s.convKeys : [];
  const adminIds = Array.isArray(s.adminIds) ? s.adminIds : [];

  /* ------------------------------------------------ 当前状态 */

  const status = card('当前状态', [
    el('div', { class: 'row wrap' }, [
      pill(st.text, /** @type {any} */ (st.tone)),
      s.allowCommand ? pill('可用聊天指令', 'dim') : pill('聊天指令已关闭', 'dim'),
    ]),
    el('div', { class: 'spacer-8' }),
    el('div', {
      class: 'field-hint',
      text:
        '静音期间 @ 和私聊也**不回复** —— 这是有意的，半截静音（@ 还能叫醒）会让人不敢用它。' +
        '想让它回来：在聊天里发「说话」，或者直接关掉下面的开关。',
    }),
    temp.length > 0
      ? el('div', {}, [
          el('div', { class: 'spacer-12' }),
          el('div', { class: 'field-label', text: '临时静音（聊天指令开的）' }),
          el(
            'div',
            { class: 'list' },
            temp.map((t) =>
              el('div', { class: 'msg' }, [
                el('div', { class: 'row-between' }, [
                  el('span', { class: 'grow', text: t.convKey }),
                  el('button', {
                    class: 'btn btn-sm',
                    type: 'button',
                    text: '恢复',
                    disabled: ui.busy ? '' : undefined,
                    onclick: async () => {
                      ui.busy = true;
                      ui.note = { ok: true, text: '恢复中…' };
                      rerender?.();
                      const r = await action('silence.unmute', { convKey: t.convKey });
                      ui.busy = false;
                      ui.note = r?.ok
                        ? { ok: true, text: `已恢复 ${t.convKey}` }
                        : { ok: false, text: `${r?.code ?? ''} ${r?.message ?? '操作失败'}`.trim() };
                      rerender?.();
                    },
                  }),
                ]),
                el('div', {
                  class: 'muted',
                  text: `还剩约 ${Math.max(1, Math.round(t.leftMs / 1000))} 秒（到 ${new Date(t.until).toLocaleTimeString('zh-CN', { hour12: false })}）`,
                }),
              ]),
            ),
          ),
          el('div', { class: 'spacer-8' }),
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: '全部恢复',
            disabled: ui.busy ? '' : undefined,
            onclick: async () => {
              ui.busy = true;
              ui.note = { ok: true, text: '恢复中…' };
              rerender?.();
              const r = await action('silence.clear', {});
              ui.busy = false;
              ui.note = r?.ok
                ? { ok: true, text: `已恢复 ${r.cleared ?? 0} 个会话` }
                : { ok: false, text: `${r?.code ?? ''} ${r?.message ?? '操作失败'}`.trim() };
              rerender?.();
            },
          }),
        ])
      : null,
    ui.note ? el('div', { class: ui.note.ok ? 'ok' : 'err', text: ui.note.text }) : null,
  ].filter(Boolean));

  /* ------------------------------------------------ 全局 */

  const globalCard = card('全局静音', [
    switchRow(
      '让所有会话都闭嘴',
      '这是最直接的开关：打开后不管谁 @ 它、私聊它，都不回复，直到你手动关掉。适合「我现在不想让它说话」。',
      s.all === true,
      (v) => save('silence.all', v, rerender),
    ),
  ]);

  /* ------------------------------------------------ 按会话 */

  const convCard = card('按会话静音', [
    el('div', {
      class: 'field-hint',
      text: '只让某个群 / 某个私聊闭嘴，其它会话照常回复。会话键格式：group:群号 或 private:QQ号。',
    }),
    convKeys.length > 0
      ? el('div', {}, [
          el('div', { class: 'spacer-12' }),
          el(
            'div',
            { class: 'list' },
            convKeys.map((k) =>
              el('div', { class: 'msg' }, [
                el('div', { class: 'row-between' }, [
                  el('span', { class: 'grow', text: k }),
                  el('button', {
                    class: 'btn btn-sm',
                    type: 'button',
                    text: '移出',
                    disabled: ui.busy ? '' : undefined,
                    onclick: () =>
                      save(
                        'silence.convKeys',
                        convKeys.filter((x) => x !== k),
                        rerender,
                      ),
                  }),
                ]),
              ]),
            ),
          ),
        ])
      : el('div', { class: 'empty', text: '还没有单独静音的会话。' }),
    el('div', { class: 'spacer-12' }),
    el('div', { class: 'row wrap' }, [
      el('input', {
        class: 'text-input grow',
        type: 'text',
        placeholder: 'group:123456',
        value: ui.convDraft,
        oninput: (e) => {
          ui.convDraft = /** @type {any} */ (e.target).value;
        },
      }),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '加入',
        disabled: ui.busy ? '' : undefined,
        onclick: () => {
          const k = String(ui.convDraft ?? '').trim();
          if (!k) {
            ui.note = { ok: false, text: '请先填会话键（group:123 或 private:456）' };
            rerender?.();
            return;
          }
          ui.convDraft = '';
          void save('silence.convKeys', [...convKeys, k], rerender);
        },
      }),
    ]),
  ]);

  /* ------------------------------------------------ 时段 */

  const windowCard = card('静默时段', [
    el('div', {
      class: 'field-hint',
      text:
        '每天到点自动闭嘴、到点自动恢复，适合夜间。' +
        '23:00–08:00 这种跨午夜的写法是支持的（这是最常见的用法）。',
    }),
    windows.length > 0
      ? el('div', {}, [
          el('div', { class: 'spacer-12' }),
          el(
            'div',
            { class: 'list' },
            windows.map((w, i) =>
              el('div', { class: 'msg' }, [
                el('div', { class: 'row-between' }, [
                  el('span', { class: 'grow', text: `${w.start} – ${w.end}` }),
                  el('button', {
                    class: 'btn btn-sm',
                    type: 'button',
                    text: '删除',
                    disabled: ui.busy ? '' : undefined,
                    onclick: () =>
                      save(
                        'silence.windows',
                        windows.filter((_, j) => j !== i),
                        rerender,
                      ),
                  }),
                ]),
              ]),
            ),
          ),
        ])
      : el('div', { class: 'empty', text: '还没有静默时段，全天都会回复。' }),
    el('div', { class: 'spacer-12' }),
    el('div', { class: 'row wrap' }, [
      el('input', {
        class: 'text-input',
        type: 'time',
        value: ui.winStart,
        oninput: (e) => {
          ui.winStart = /** @type {any} */ (e.target).value;
        },
      }),
      el('span', { class: 'muted', text: '到' }),
      el('input', {
        class: 'text-input',
        type: 'time',
        value: ui.winEnd,
        oninput: (e) => {
          ui.winEnd = /** @type {any} */ (e.target).value;
        },
      }),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '添加',
        disabled: ui.busy ? '' : undefined,
        onclick: () => {
          const start = String(ui.winStart ?? '').trim();
          const end = String(ui.winEnd ?? '').trim();
          if (!start || !end) {
            ui.note = { ok: false, text: '请填开始和结束时间' };
            rerender?.();
            return;
          }
          if (start === end) {
            // 提前拦住：存进去之后它什么都不做，用户会以为夜间静音开着
            ui.note = { ok: false, text: `${start}–${end} 起止相同，不会生效` };
            rerender?.();
            return;
          }
          void save('silence.windows', [...windows, { start, end }], rerender);
        },
      }),
    ]),
  ]);

  /* ------------------------------------------------ 指令 */

  const cmdCard = card('聊天指令', [
    switchRow(
      '允许管理员用「闭嘴 / 说话」',
      '在群里发「闭嘴」就静音 30 分钟，「闭嘴 2h」静音两小时，「说话」立刻恢复。',
      s.allowCommand !== false,
      (v) => save('silence.allowCommand', v, rerender),
    ),
    el('div', { class: 'spacer-12' }),
    el('div', { class: 'field-label', text: '谁可以用指令（QQ 号）' }),
    el('div', {
      class: 'field-hint',
      text:
        '留空 = 谁都不能用指令，只能从这一页控制。' + '不填的话，没人能让他闭嘴。',
    }),
    adminIds.length > 0
      ? el('div', {}, [
          el('div', { class: 'spacer-8' }),
          el(
            'div',
            { class: 'list' },
            adminIds.map((id) =>
              el('div', { class: 'msg' }, [
                el('div', { class: 'row-between' }, [
                  el('span', { class: 'grow', text: id }),
                  el('button', {
                    class: 'btn btn-sm',
                    type: 'button',
                    text: '移出',
                    disabled: ui.busy ? '' : undefined,
                    onclick: () =>
                      save(
                        'silence.adminIds',
                        adminIds.filter((x) => x !== id),
                        rerender,
                      ),
                  }),
                ]),
              ]),
            ),
          ),
        ])
      : null,
    el('div', { class: 'spacer-8' }),
    el('div', { class: 'row wrap' }, [
      el('input', {
        class: 'text-input grow',
        type: 'text',
        placeholder: 'QQ 号，例如 10001',
        onkeydown: (e) => {
          if (/** @type {any} */ (e).key !== 'Enter') return;
          const v = String(/** @type {any} */ (e.target).value ?? '').trim();
          if (!v) return;
          /** @type {any} */ (e.target).value = '';
          void save('silence.adminIds', [...adminIds, v], rerender);
        },
      }),
      el('div', { class: 'muted', text: '填好按回车加入' }),
    ]),
    el('div', { class: 'spacer-12' }),
    el('div', { class: 'row wrap' }, [
      el('span', { class: 'muted', text: `默认静音时长：${humanMs(s.defaultMuteMs)}` }),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '改成 1 小时',
        disabled: ui.busy ? '' : undefined,
        onclick: () => save('silence.defaultMuteMs', 3_600_000, rerender),
      }),
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '改成 30 分钟',
        disabled: ui.busy ? '' : undefined,
        onclick: () => save('silence.defaultMuteMs', 1_800_000, rerender),
      }),
      el('span', { class: 'muted', text: `· 单次上限 ${humanMs(s.maxMuteMs)}` }),
    ]),
  ]);

  return el('div', {}, [
    status,
    el('div', { class: 'spacer-12' }),
    globalCard,
    el('div', { class: 'spacer-12' }),
    convCard,
    el('div', { class: 'spacer-12' }),
    windowCard,
    el('div', { class: 'spacer-12' }),
    cmdCard,
  ]);
}

/** 测试/调试用：重置页面状态 */
export function resetSilencePageState() {
  ui.convDraft = '';
  ui.winStart = '23:00';
  ui.winEnd = '08:00';
  ui.note = null;
  ui.busy = false;
}
