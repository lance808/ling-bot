/**
 * 分条区块 —— F22（嵌在《语言》页的「分条」分栏里）
 *
 * 注意：这块**不是独立页面**。它和「唤醒」「静音」一起组成了《语言》页 ——
 * 三者是同一件事的三个侧面（该不该开口 / 开口怎么说 / 现在能不能说）。
 * 页内分栏见 `ui/src/views/language.mjs`。
 *
 * ## 这一块要回答的问题
 *
 * 「它为什么把一句话拆成三条发？」和「怎么让它别拆？」
 * 所以页面结构是：先讲协议长什么样（只读示例），再给三个可调项。
 *
 * ## 为什么把协议示例也放上来
 *
 * 用户改人格卡时很容易顺手写「用几条短句回复」，结果模型写成了真正的
 * 几个段落 —— 而在协议下那仍然是一条。**只有写成分条块才会真的分条**，
 * 这一点不写在界面上，用户永远调不对。示例用纯文本展示（不是可编辑的
 * 坑位），因为它必须先被模型理解，才谈得上被用户理解。
 *
 * ## 条数上限为什么有"硬上限"
 *
 * 配置里允许填到 10，超过的部分发送层会夹回去。界面把这件事说出来
 * （而不是让输入框静默接受一个不会生效的数）：用户填 30、保存成功、
 * 结果还是 10 条，会觉得是 bug。
 */

import { el, card } from '../render.mjs';
import { setting } from '../api.mjs';

/**
 * 页面级状态。
 *
 * 必须在模块作用域：快照每 2 秒轮询、每次整页重建，
 * 局部变量会跟着 DOM 一起消失。
 */
const ui = {
  /** @type {Record<string, {ok: boolean, text: string}>} */
  lastSave: {},
};

/**
 * 保存一项设置并记录结果。
 *
 * @param {string} field
 * @param {any} value
 * @param {() => void} [rerender]
 */
async function save(field, value, rerender) {
  ui.lastSave[field] = { ok: true, text: '保存中…' };
  rerender?.();
  const r = await setting(`reply.${field}`, value);
  ui.lastSave[field] = r?.ok
    ? { ok: true, text: '已保存' }
    : { ok: false, text: `保存失败：${r?.code ?? ''} ${r?.message ?? ''}`.trim() };
  rerender?.();
}

/**
 * 一个开关行。
 *
 * @param {object} opts
 * @returns {HTMLElement}
 */
function toggleRow({ field, label, desc, value, rerender }) {
  const box = /** @type {HTMLInputElement} */ (
    el('input', { type: 'checkbox', class: 'checkbox' })
  );
  box.checked = value === true;
  box.addEventListener('change', () => void save(field, box.checked, rerender));

  const status = ui.lastSave[field];

  return el('div', { class: 'field' }, [
    el('label', { class: 'row' }, [box, el('span', { class: 'field-label', text: label })]),
    el('div', { class: 'field-hint', text: desc }),
    status ? el('div', { class: status.ok ? 'ok' : 'err', text: status.text }) : null,
  ].filter(Boolean));
}

/**
 * 一个数字输入行。
 *
 * ## 为什么用 min/max 而不是"随便填、保存时再夹"
 *
 * 夹会把用户的输入**静默改掉**。输入框的 min/max 让浏览器当场拦下，
 * 用户看到的是"填不进去"，比"填进去了但没生效"清楚得多。
 *
 * @param {object} opts
 * @returns {HTMLElement}
 */
function numberRow({ field, label, desc, value, min, max, unit = '', rerender }) {
  const input = /** @type {HTMLInputElement} */ (
    el('input', { type: 'number', class: 'text-input', min: String(min), max: String(max), step: '1' })
  );
  input.value = String(value ?? min);

  const status = ui.lastSave[field];

  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: unit ? `${label}（${unit}）` : label }),
    input,
    el('div', { class: 'row' }, [
      el('button', {
        class: 'btn btn-sm',
        type: 'button',
        text: '保存',
        onclick: () => {
          const n = Number(input.value);
          /*
           * 越界不提交，直接给出说明。
           *
           * 提交了会得到后端的 E40XX（那也是对的），但让用户点一次
           * "保存"才看到错误，不如当场拦住。后端校验仍然保留 ——
           * 界面不是安全边界，只是第一道体验。
           */
          if (!Number.isInteger(n) || n < min || n > max) {
            ui.lastSave[field] = {
              ok: false,
              text: `必须是 ${min}–${max} 的整数`,
            };
            rerender?.();
            return;
          }
          void save(field, n, rerender);
        },
      }),
    ]),
    el('div', { class: 'field-hint', text: desc }),
    status ? el('div', { class: status.ok ? 'ok' : 'err', text: status.text }) : null,
  ].filter(Boolean));
}

/**
 * 协议示例（纯展示）。
 *
 * 用 pre 而不是可编辑框：它描述的是**模型**的输出格式，
 * 用户能改的是一个死字符串，改错了不会有任何效果。
 *
 * @param {string} lang
 * @returns {HTMLElement}
 */
function protocolSample(lang) {
  const sample = [
    '```' + lang,
    '["第一条完整的话", "第二条完整的话"]',
    '```',
  ].join('\n');
  return el('pre', { class: 'mono', text: sample });
}

/**
 * @param {any} snap
 * @param {{rerender?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderReplySplit(snap, ctx = {}) {
  const reply = snap?.reply ?? {};
  const rerender = ctx.rerender;
  const hardCap = Number(reply.hardCap) > 0 ? Number(reply.hardCap) : 10;
  const enabled = reply.splitEnabled !== false;

  const settings = card('分条行为', [
    el('div', {
      class: 'field-hint',
      text:
        '分条不是按标点或换行拆的：模型要显式写出下面的分条块，才会真的分开发。' +
        '没写、写坏了、超过上限，都整条原样发出——**不会丢内容，也不会猜**。',
    }),
    el('div', { class: 'spacer-8' }),
    toggleRow({
      field: 'splitEnabled',
      label: '允许分条发送',
      desc:
        '关掉之后即使模型写了分条块也整条发出。它是硬开关，不是建议值：' +
        '关掉就是不分，不存在"关掉之后走默认值"。',
      value: enabled,
      rerender,
    }),
    numberRow({
      field: 'maxMessages',
      label: '一次回复最多分几条',
      desc:
        `1 = 始终整条发。上限由代码兜住：填超过 ${hardCap} 也只按 ${hardCap} 条发，` +
        '多出来的内容会并进最后一条（不丢内容，只是合起来）。',
      value: reply.maxMessages ?? 3,
      min: 1,
      max: hardCap,
      unit: '条',
      rerender,
    }),
    numberRow({
      field: 'intervalMs',
      label: '两条之间间隔',
      desc:
        '太短看起来像刷屏，太长会让人以为它卡住了。建议 600–1500。' +
        '间隔只影响观感，不影响顺序：同一会话的消息永远按顺序发完，不同回合不会穿插。',
      value: reply.intervalMs ?? 800,
      min: 100,
      max: 10000,
      unit: '毫秒',
      rerender,
    }),
  ]);

  const protocol = card('模型输出约定', [
    el('div', {
      class: 'field-hint',
      text:
        '下面这段就是提示词里告诉模型的格式（最多条数跟着上面的设置走）。' +
        '改人格卡时不要用「分成几条发」这种说法——它不构成可校验的边界，模型会写成几个段落，而那仍然是一个气泡。',
    }),
    el('div', { class: 'spacer-8' }),
    protocolSample('ling-msgs'),
    el('div', { class: 'field-hint' }, [
      el('div', { text: '· 每个数组元素 = 一个 QQ 气泡，前后顺序就是数组顺序。' }),
      el('div', { text: '· 每一条都要能独立读懂；代码块、表格、列表必须整块留在同一条里。' }),
      el('div', { text: '· 模型没按格式写、JSON 不合法、元素不是字符串，一律整条原样发。' }),
    ]),
  ]);

  const flow = card('发送链路上的保证', [
    el('div', { class: 'list' }, [
      el('div', {}, [
        el('div', { class: 'field-label', text: '每条各过一次发送闸门' }),
        el('div', {
          class: 'field-hint',
          text: '白名单、出站审计、限流对每一条单独生效——不是"整段检查一次、然后拆开发"。',
        }),
      ]),
      el('div', {}, [
        el('div', { class: 'field-label', text: '同一会话严格按顺序' }),
        el('div', {
          class: 'field-hint',
          text: '两个回合几乎同时结束时，后来的会排队等前一个发完，不会出现 A1 B1 A2 B2。',
        }),
      ]),
      el('div', {}, [
        el('div', { class: 'field-label', text: '中止停在消息边界' }),
        el('div', {
          class: 'field-hint',
          text: '点停止之后不会再冒出新的一条；间隔中的等待会立刻结束，已发出的不会撤回。',
        }),
      ]),
      el('div', {}, [
        el('div', { class: 'field-label', text: '历史只记真正发出去的' }),
        el('div', {
          class: 'field-hint',
          text: '被限流挡下的那条不进上下文——否则下一轮它会以为自己说过了。',
        }),
      ]),
    ]),
  ]);

  return el('div', {}, [
    el('div', { class: 'split' }, [settings, protocol]),
    el('div', { class: 'spacer-12' }),
    flow,
  ]);
}

/** 仅供测试：清空保存结果，避免用例之间互相影响 */
export function resetReplySplitPageState() {
  for (const k of Object.keys(ui.lastSave)) delete ui.lastSave[k];
}
