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
 *
 * ## 楼层与分页（本次新增）
 *
 * 每条消息在会话里有一个**楼层号**，单调递增、重启不倒退。
 * 界面据此可以做三件事：
 *
 *   · 显示楼层号 —— 出问题时能对着日志说"第 137 楼"
 *   · 向上加载更早 —— 首屏只给最新一页，历史按需翻
 *   · 未读徽标 —— 最高楼层减已读楼层
 *
 * 首屏**故意不拉全量历史**：一个活跃群几千条消息，一次性塞进 DOM
 * 会让页面卡死，而用户 99% 的时候只看最后几句。
 */

import { el, card, clock } from '../render.mjs';
import { pickFile, action } from '../api.mjs';

const draft = { text: '', picked: null, result: null, target: '' };

/**
 * 分页状态。
 *
 * 必须活在模块作用域：快照每 2 秒轮询、每次整页重建，
 * 局部变量会跟着 DOM 一起消失，用户刚翻到的位置就没了。
 *
 * 形状：`{ [convKey]: { messages: [], hasMore: bool, readThroughFloor: number, loading: bool, error: string|null } }`
 */
const pages = {};

/** 每页条数。50 足够一屏多，又不至于让一次点击等太久 */
const PAGE_SIZE = 50;

/** 手动发送支持的类型 */
const MEDIA = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'record', label: '语音' },
  { kind: 'file', label: '文件' },
];

/**
 * 把一页消息并入缓存。
 *
 * 用楼层号去重而不是整体替换：向上翻页时新拿到的更早消息要**接在前面**，
 * 而实时推送的新消息要接在后面。两种方向混在一起，只有按 floor 合并才对。
 *
 * @param {string} convKey
 * @param {object[]} incoming
 * @param {{prepend?: boolean}} [opts]
 */
function mergePage(convKey, incoming, opts = {}) {
  const cur = pages[convKey] ?? { messages: [], hasMore: false, readThroughFloor: 0, loading: false, error: null };
  /** @type {Map<number, object>} */
  const byFloor = new Map();
  for (const m of cur.messages) byFloor.set(m.floor, m);
  for (const m of incoming) {
    // 没有楼层号的（理论上不该出现）用 messageId 兜底，避免整条丢掉
    const key = typeof m.floor === 'number' ? m.floor : String(m.messageId ?? Math.random());
    byFloor.set(/** @type {any} */ (key), m);
  }
  const merged = [...byFloor.values()].sort((a, b) => {
    if (typeof a.floor !== 'number') return 1;
    if (typeof b.floor !== 'number') return -1;
    return a.floor - b.floor;
  });
  pages[convKey] = { ...cur, messages: merged, ...opts };
}

/**
 * @param {any} snap
 * @param {{selectedConv: string|null, onSelect: (k:string)=>void, onSend: (k:string, t:string)=>Promise<any>, onSendMedia?: Function, rerender?: () => void}} ctx
 * @returns {HTMLElement}
 */
export function renderSessions(snap, ctx) {
  const messages = snap?.messages ?? [];
  const sessionMeta = snap?.sessions ?? [];

  /** 每个会话的楼层概要，按 convKey 索引 */
  const metaByConv = new Map(sessionMeta.map((s) => [s.convKey, s]));

  /** @type {Map<string, any[]>} */
  const byConv = new Map();
  for (const m of messages) {
    const key = m.convKey ?? 'unknown';
    if (!byConv.has(key)) byConv.set(key, []);
    byConv.get(key).push(m);
  }
  /*
   * 会话列表要并上「楼层仓库里存在、但最近 100 条快照里没出现」的会话。
   * 否则重启之后如果某个群很久没说话，它在列表里就消失了 ——
   * 而用户明明能看到它的历史（store 里有），只是没显示出来。
   */
  for (const meta of sessionMeta) {
    if (!byConv.has(meta.convKey)) byConv.set(meta.convKey, []);
  }

  const groupKeys = [...byConv.keys()].filter((k) => k.startsWith('group:'));
  const privateKeys = [...byConv.keys()].filter((k) => k.startsWith('private:'));
  const allKeys = [...groupKeys, ...privateKeys];

  const selected = ctx.selectedConv && byConv.has(ctx.selectedConv) ? ctx.selectedConv : allKeys[0] ?? null;

  /* ---------------------------------------------------------- 会话列表 */

  /** @param {string} key */
  const convButton = (key) => {
    const list = byConv.get(key) ?? [];
    const meta = metaByConv.get(key);
    const last = list[list.length - 1];
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1] ?? '';
    const unread = meta?.unread ?? 0;
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
          text: `${meta?.count ?? list.length} 条 · ${last ? clock(last.time) : ''}`,
        }),
        // 未读徽标：有未读才出现，避免整列都是 0
        unread > 0
          ? el('span', {
              class: 'pill pill-accent',
              text: `${unread} 未读`,
              title: `已读到第 ${meta?.readThroughFloor ?? 0} 楼，最新第 ${meta?.lastFloor ?? 0} 楼`,
            })
          : null,
      ].filter(Boolean),
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

  /** 取（必要时懒加载）某会话的分页数据 */
  const ensurePage = async (convKey, opts = {}) => {
    const cur = pages[convKey];
    if (!cur || opts.reload) {
      pages[convKey] = { messages: [], hasMore: false, readThroughFloor: 0, loading: true, error: null };
      ctx.rerender?.();
      const r = await action('session.page', { convKey, limit: PAGE_SIZE });
      if (r?.ok) {
        pages[convKey] = {
          messages: [],
          hasMore: r.hasMore === true,
          readThroughFloor: r.readThroughFloor ?? 0,
          loading: false,
          error: null,
        };
        mergePage(convKey, r.messages ?? []);
      } else {
        pages[convKey] = {
          messages: [],
          hasMore: false,
          readThroughFloor: 0,
          loading: false,
          // 错误要显示出来，不能静默变成空列表
          error: `${r?.code ?? ''} ${r?.message ?? '读取失败'}`.trim(),
        };
      }
      ctx.rerender?.();
    }
  };

  /** 向上加载更早一页 */
  const loadEarlier = async (convKey) => {
    const cur = pages[convKey];
    if (!cur || cur.loading) return;
    const first = cur.messages[0];
    if (!first || typeof first.floor !== 'number') return;
    pages[convKey] = { ...cur, loading: true };
    ctx.rerender?.();
    const r = await action('session.page', { convKey, beforeFloor: first.floor, limit: PAGE_SIZE });
    if (r?.ok) {
      mergePage(convKey, r.messages ?? [], { hasMore: r.hasMore === true, loading: false });
    } else {
      pages[convKey] = { ...pages[convKey], loading: false, error: `${r?.code ?? ''} ${r?.message ?? ''}`.trim() };
    }
    ctx.rerender?.();
  };

  /** 跳到未读：只拉读楼层之后的消息 */
  const jumpUnread = async (convKey) => {
    const cur = pages[convKey];
    const after = cur?.readThroughFloor ?? 0;
    pages[convKey] = { ...(cur ?? {}), loading: true, error: null };
    ctx.rerender?.();
    const r = await action('session.page', { convKey, afterFloor: after, limit: PAGE_SIZE });
    if (r?.ok) {
      mergePage(convKey, r.messages ?? [], { loading: false });
    } else {
      pages[convKey] = { ...pages[convKey], loading: false, error: `${r?.code ?? ''} ${r?.message ?? ''}`.trim() };
    }
    ctx.rerender?.();
  };

  /** 标记已读到最新 */
  const markAllRead = async (convKey) => {
    const meta = metaByConv.get(convKey);
    const floor = meta?.lastFloor ?? 0;
    if (!floor) return;
    await action('session.markRead', { convKey, floor });
    ctx.rerender?.();
  };

  if (selected && !pages[selected]) void ensurePage(selected);

  const page = selected ? pages[selected] : null;

  /**
   * 一条消息。
   *
   * 楼层号显示成 `#137`：出问题时用户能直接说"第 137 楼"，
   * 对着日志和 store 一眼就能定位，不用再描述"大概晚上八点那条"。
   */
  const msgNode = (m, isUnread) =>
    el('div', { class: isUnread ? 'msg msg-unread' : 'msg' }, [
      el('div', { class: 'meta' }, [
        el('span', { class: 'muted', text: typeof m.floor === 'number' ? `#${m.floor}` : '#?' }),
        el('span', { text: ` ${m.sender?.nickname ?? m.sender?.userId ?? m.userId ?? '?'}` }),
        el('span', { text: ` · ${clock(m.time)}` }),
        isUnread ? el('span', { class: 'pill pill-accent', text: '未读' }) : null,
      ].filter(Boolean)),
      el('div', { text: m.text || '（无文本）' }),
    ]);

  /** 首屏用快照里的消息（够快），翻过页之后用分页缓存（够全） */
  const sourceMessages =
    page && page.messages.length > 0
      ? page.messages
      : (selected ? byConv.get(selected) ?? [] : []);
  const readThrough = page?.readThroughFloor ?? metaByConv.get(selected ?? '')?.readThroughFloor ?? 0;

  const timeline =
    selected && sourceMessages.length > 0
      ? sourceMessages.map((m) => msgNode(m, typeof m.floor === 'number' && m.floor > readThrough))
      : [el('div', { class: 'empty', text: selected ? '这个会话还没有消息' : '选择左侧会话查看对话历史' })];

  const meta = selected ? metaByConv.get(selected) : null;

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

  /* ---------------------------------------------------------- 历史工具条 */

  const historyTools = selected
    ? el('div', { class: 'row wrap' }, [
        page?.hasMore
          ? el('button', {
              class: 'btn btn-sm',
              type: 'button',
              text: page.loading ? '加载中…' : '加载更早',
              disabled: page.loading ? '' : undefined,
              onclick: () => void loadEarlier(selected),
            })
          : el('span', { class: 'muted', text: '已到最早' }),
        (meta?.unread ?? 0) > 0
          ? el('button', {
              class: 'btn btn-sm',
              type: 'button',
              text: `跳到未读（${meta.unread}）`,
              onclick: () => void jumpUnread(selected),
            })
          : null,
        (meta?.unread ?? 0) > 0
          ? el('button', {
              class: 'btn btn-sm',
              type: 'button',
              text: '全部标记已读',
              onclick: () => void markAllRead(selected),
            })
          : null,
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: '刷新',
          onclick: () => void ensurePage(selected, { reload: true }),
        }),
        el('span', {
          class: 'muted',
          text: meta
            ? `共 ${meta.lastFloor} 楼 · 读到 ${meta.readThroughFloor} 楼 · 未读 ${meta.unread}`
            : '暂无楼层信息',
        }),
      ].filter(Boolean))
    : null;

  if (draft.result) showResult(draft.result);
  return el('div', { class: 'split' }, [
    card('会话', [el('div', {}, listBody)]),
    el('div', {}, [
      card('对话历史', [
        selected ? el('div', { class: 'field-hint', text: `当前：${selected}` }) : null,
        historyTools,
        // 分页错误必须显示：静默变空列表会被误读成"这个会话没有历史"
        page?.error ? el('div', { class: 'field-hint', text: `读取失败：${page.error}` }) : null,
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

/**
 * 清掉某个会话的分页缓存（会话被删、或测试用）。
 *
 * @param {string} [convKey]
 */
export function clearSessionPages(convKey) {
  if (convKey) delete pages[convKey];
  else for (const k of Object.keys(pages)) delete pages[k];
}
