/**
 * 会话总览 —— F5 / F6
 *
 * 文档要求：群聊 / 私聊分栏、对话历史、手动发送（文本 / 图片 / 视频 / 文件）。
 *
 * ## 为什么群聊和私聊要分两组而不是混在一起
 *
 * 它们的行为约束完全不同：群里说的话所有人都看得见，且群聊**永远不会**
 * 被授予宿主机工具；私聊是主人的地方。混在一个列表里，用户很容易
 * 在错误的会话里说错话——而这类错误没法撤回。
 *
 * ## 手动发送为什么必须显示拒因
 *
 * 发送走的是和白名单、出站审计同一道闸门。被拒是**正常行为**
 * （比如目标不在 allow 里），不是 bug。如果只显示"失败"，
 * 用户会以为程序坏了，然后去改代码——其实他该去改白名单。
 * 所以拒因要显示到码和原因。
 */

import { el, card, clock } from '../render.mjs';
import { pickFile } from '../api.mjs';

const draft = { text: '', picked: null, result: null, target: '' };

/** 手动发送支持的类型 */
const MEDIA = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'record', label: '语音' },
  { kind: 'file', label: '文件' },
];

/**
 * @param {any} snap
 * @param {{selectedConv: string|null, onSelect: (k:string)=>void, onSend: (k:string, t:string)=>Promise<any>}} ctx
 * @returns {HTMLElement}
 */
export function renderSessions(snap, ctx) {
  const messages = snap?.messages ?? [];

  /** @type {Map<string, any[]>} */
  const byConv = new Map();
  for (const m of messages) {
    const key = m.convKey ?? 'unknown';
    if (!byConv.has(key)) byConv.set(key, []);
    byConv.get(key).push(m);
  }

  const groupKeys = [...byConv.keys()].filter((k) => k.startsWith('group:'));
  const privateKeys = [...byConv.keys()].filter((k) => k.startsWith('private:'));
  const allKeys = [...groupKeys, ...privateKeys];

  const selected = ctx.selectedConv && byConv.has(ctx.selectedConv) ? ctx.selectedConv : allKeys[0] ?? null;

  /* ---------------------------------------------------------- 会话列表 */

  /** @param {string} key */
  const convButton = (key) => {
    const list = byConv.get(key) ?? [];
    const last = list[list.length - 1];
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1] ?? '';
    return el(
      'button',
      {
        class: 'pick',
        type: 'button',
        'aria-current': key === selected ? 'true' : 'false',
        onclick: () => ctx.onSelect(key),
      },
      [
        el('span', { class: 'pick-title', text: isGroup ? `群 ${id}` : `私聊 ${id}` }),
        el('span', {
          class: 'pick-sub',
          text: `${list.length} 条 · ${last ? clock(last.time) : ''}`,
        }),
      ],
    );
  };

  const listBody =
    allKeys.length === 0
      ? [el('div', { class: 'empty', text: '还没有收到任何消息' })]
      : [
          groupKeys.length > 0
            ? el('div', { class: 'nav-group', text: `群聊 ${groupKeys.length}` })
            : null,
          ...groupKeys.map(convButton),
          privateKeys.length > 0
            ? el('div', { class: 'nav-group', text: `私聊 ${privateKeys.length}` })
            : null,
          ...privateKeys.map(convButton),
        ].filter(Boolean);

  /* ---------------------------------------------------------- 时间线 */

  const timeline =
    selected && byConv.has(selected)
      ? byConv.get(selected).map((m) =>
          el('div', { class: 'msg' }, [
            el('div', { class: 'meta' }, [
              el('span', { text: m.sender?.nickname ?? m.sender?.userId ?? '?' }),
              el('span', { text: ` · ${clock(m.time)}` }),
            ]),
            el('div', { text: m.text || '（无文本）' }),
          ]),
        )
      : [el('div', { class: 'empty', text: '选择左侧会话查看对话历史' })];

  /* ---------------------------------------------------------- 手动发送 */

  const sel = el('select', {}, [
    el('option', { value: '', text: '选择会话…' }),
    ...allKeys.map((k) =>
      el('option', { value: k, text: k.startsWith('group:') ? `群 ${k.split(':')[1]}` : `私聊 ${k.split(':')[1]}` }),
    ),
  ]);
  /** @type {any} */ (sel).value = allKeys.includes(draft.target) ? draft.target : selected ?? '';
  sel.addEventListener('change', () => { draft.target = sel.value; });

  const result = el('div', { class: 'field-hint', text: '' });

  /** 当前选中的媒体（只在界面上暂存，不落盘） */
  let picked = draft.picked;
  const pickedLabel = el('div', { class: 'field-hint', text: picked ? `已选：${picked.kind} · ${picked.path}` : '' });

  const input = /** @type {HTMLTextAreaElement} */ (
    el('textarea', { placeholder: '输入要发送的文本（会经过白名单与出站审计）', rows: 3 })
  );

  input.value = draft.text;
  input.addEventListener('input', () => { draft.text = input.value; });

  const showResult = (/** @type {any} */ res) => {
    draft.result = res;
    if (res?.ok) {
      result.textContent = '已发送';
      result.className = 'field-hint';
    } else {
      // 拒因要完整显示：码 + 人话。只写"失败"用户会去怀疑程序
      result.textContent = `被拒：${res?.code ?? ''} ${res?.message ?? ''}`.trim();
      result.className = 'field-hint';
    }
  };

  const sendTextBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: '发送文本',
    onclick: async () => {
      const target = /** @type {any} */ (sel).value;
      const value = input.value.trim();
      if (!target) return showResult({ ok: false, message: '先选择会话' });
      if (!value) return showResult({ ok: false, message: '内容为空' });
      sendTextBtn.disabled = true;
      try {
        const response = await ctx.onSend(target, value);
        showResult(response);
        if (response?.ok && draft.text.trim() === value) {
          input.value = '';
          draft.text = '';
        }
      } finally {
        sendTextBtn.disabled = false;
      }
    },
  });

  /** 选文件 → 暂存 → 点发送 */
  const mediaButtons = MEDIA.map((m) =>
    el('button', {
      class: 'btn btn-sm',
      type: 'button',
      text: m.label,
      onclick: async () => {
        const r = await pickFile(/** @type {any} */ (m.kind));
        if (!r?.ok) {
          if (!r?.canceled) pickedLabel.textContent = '选择文件失败';
          return;
        }
        picked = { kind: m.kind, path: String(r.path) };
        draft.picked = picked;
        pickedLabel.textContent = `已选：${m.label} · ${r.path}`;
      },
    }),
  );

  const sendMediaBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: '发送文件',
    onclick: async () => {
      const target = /** @type {any} */ (sel).value;
      if (!target) return showResult({ ok: false, message: '先选择会话' });
      if (!picked) return showResult({ ok: false, message: '先选择要发送的文件' });
      sendMediaBtn.disabled = true;
      try {
        const res = await ctx.onSendMedia(target, picked.kind, picked.path);
        showResult(res);
        if (res?.ok) {
          picked = null;
          draft.picked = null;
          pickedLabel.textContent = '';
        }
      } finally {
        sendMediaBtn.disabled = false;
      }
    },
  });

  if (draft.result) showResult(draft.result);
  return el('div', { class: 'split' }, [
    card('会话', [el('div', {}, listBody)]),
    el('div', {}, [
      card('对话历史', [
        selected ? el('div', { class: 'field-hint', text: `当前：${selected}` }) : null,
        el('div', { class: 'spacer-8' }),
        el('div', { class: 'list' }, timeline),
      ]),
      card('手动发送', [
        el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '目标会话' }), sel]),
        input,
        el('div', { class: 'spacer-8' }),
        el('div', { class: 'row wrap' }, [sendTextBtn, result]),
        el('div', { class: 'spacer-16' }),
        el('div', { class: 'field-label', text: '发送文件' }),
        el('div', { class: 'row wrap' }, [...mediaButtons, sendMediaBtn]),
        pickedLabel,
        el('div', { class: 'field-hint' }, [
          el('div', {
            text: '只支持本机文件（不支持网址），单文件上限 100MB。图片/视频/语音/文件都走同一道白名单与出站审计。',
          }),
        ]),
      ]),
    ]),
  ]);
}
