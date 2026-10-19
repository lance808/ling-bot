/**
 * 人物页 —— F8
 *
 * ## 人格和角色是两件事，各有一套卡
 *
 *   **人格** = 它是谁（性格、说话风格）
 *   **角色** = 它在什么场景扮演什么（群里的聊天参与者 / 私聊助手 / 客服）
 *
 * 两者正交：同一个「私聊助手」角色，可以配正经人格，也可以配话痨人格。
 * 所以两套卡**各自独立切换** —— 换角色不动人格，换人格不动角色。
 *
 * ## 布局：从上到下，不是左右两栏
 *
 * 侧栏已经有十几项了，再拆一页出来只会更挤。而这两件事都属于
 * "设定它怎么表现"，放一页里用顶部标签切换最省事。
 * 页面内部也不再用左右分栏 —— 卡片列表在上、编辑器在下，
 * 窄窗口下不会把列表挤成竖排（那个坑踩过：名字被压成一字一行）。
 *
 * ## 三层结构里只有这两层可改
 *
 * 行为层是代码常量，只读展示。切换人格或角色只改"注入哪段文字"，
 * **不会影响任何安全判定**（不变量 I14）。
 *
 * 注入上限默认 6000 字符，超限时保存被拒并提示字数（不是静默截断）——
 * 静默截断最坏：用户以为写进去了，实际模型看到的是半句话。
 *
 * ## 为什么不用 prompt()
 *
 * **Electron 不支持 prompt**：Chromium 早就把它从桌面端移除了，
 * 调用它会阻塞甚至直接返回 null —— 表现就是"点新建没反应"。
 * 所以名字走页面内的输入框，都是普通 DOM。
 */

import { el, card } from '../render.mjs';

const INJECT_LIMIT = 6000;

/** 作用范围的中文名 */
const SCOPE_LABEL = {
  global: '全局',
  group: '只对这个群',
  private: '只对这个私聊',
};

/** 两套卡的文案。除了名字和提示语，行为完全一样。 */
const KINDS = {
  persona: {
    label: '人格',
    cardTitle: '人格卡',
    newButton: '＋ 新建人格卡',
    emptyList: '还没有人格卡，点上面「新建」开始。',
    emptyEditor: '还没有人格卡。先点上面的「＋ 新建人格卡」，给它起个名字。',
    namePlaceholder: '给这张卡起个名字（例如：正经助理 / 群里那个话痨）',
    textPlaceholder:
      '用 Markdown 写它的人格：它是谁、什么性格、怎么说话。\n不要写工具用法（模型自己读工具描述），也不要写安全规则（那是行为层的事）。',
    explain: '人格管「它是谁」：性格、说话风格。换人格不影响角色。',
  },
  role: {
    label: '角色',
    cardTitle: '角色卡',
    newButton: '＋ 新建角色卡',
    emptyList: '还没有角色卡，点上面「新建」开始。',
    emptyEditor: '还没有角色卡。先点上面的「＋ 新建角色卡」，给它起个名字。',
    namePlaceholder: '给这张卡起个名字（例如：群里那个 / 一对一助手 / 客服）',
    textPlaceholder:
      '写它在什么场景扮演什么：\n- 在这个群里你是聊天参与者还是助手？\n- 有人问你事情时该多认真？\n- 什么时候该闭嘴？\n不要写性格（那是人格的事），也不要写安全规则。',
    explain: '角色管「它在什么场景扮演什么」。换角色不影响人格。',
  },
};

/**
 * 把 scope + scopeId 说成一句人话。
 *
 * @param {string} scope
 * @param {string} scopeId
 * @returns {string}
 */
function describeScope(scope, scopeId) {
  if (scope === 'group') return `只对群 ${scopeId}`;
  if (scope === 'private') return `只对私聊 ${scopeId}`;
  return '全局';
}

/**
 * 页面级状态。
 *
 * 必须活在模块作用域 —— 快照每 2 秒轮询一次、每次整页重建，
 * 局部变量会跟着 DOM 一起消失（这个坑已经踩过好几次了）。
 *
 * 注意：带 kind 下标的字段是**两套卡共用**的结构，键是 'persona' | 'role'，
 * 这样两套卡的草稿不会互相污染。
 */
const ui = {
  /** 新建表单是否展开（按 kind 分） */
  /** @type {Record<string, boolean>} */
  creating: {},
  /** 新建表单里的名字（按 kind 分） */
  /** @type {Record<string, string>} */
  newName: {},
  /** 改名输入框里的名字（按 kind 分；null 表示跟随当前卡） */
  /** @type {Record<string, string | null>} */
  nameDraft: {},
  /** 提示信息（按 kind 分，切标签时不会串） */
  /** @type {Record<string, {tone: string, text: string} | null>} */
  notice: {},
  /** 待确认删除的卡 id（按 kind 分） */
  /** @type {Record<string, string | null>} */
  confirmDelete: {},
  /** 作用范围的编辑草稿（按 kind 分） */
  /** @type {Record<string, {scope: string, scopeId: string} | null>} */
  scopeDraft: {},
  /** 新建表单里选的范围（按 kind 分） */
  /** @type {Record<string, {scope: string, scopeId: string}>} */
  newScope: {},
};

/**
 * 取某个状态的默认空值，避免到处写 `?? {}`。
 *
 * @param {'creating'|'newName'|'nameDraft'|'notice'|'confirmDelete'|'scopeDraft'|'newScope'} field
 * @param {string} kind
 */
function slot(field, kind) {
  const empty = {
    creating: false,
    newName: '',
    nameDraft: null,
    notice: null,
    confirmDelete: null,
    scopeDraft: null,
    newScope: { scope: 'global', scopeId: '' },
  };
  return ui[field][kind] ?? empty[field];
}

/**
 * @param {any} snap
 * @param {object} ctx
 * @param {any} ctx.persona 人格那套的上下文（见 app.mjs 的 makeCardCtx）
 * @param {any} ctx.role    角色那套的上下文
 * @param {'persona'|'role'} ctx.tab 当前看哪一套
 * @param {(which: 'persona'|'role') => void} ctx.onTab
 * @returns {HTMLElement}
 */
export function renderPersona(snap, ctx) {
  const which = ctx.tab === 'role' ? 'role' : 'persona';
  const copy = KINDS[which];
  /** 当前这套卡的上下文 */
  const cur = ctx[which];

  /* ------------------------------------------------------------ 顶部标签 */

  const tabs = el('div', { class: 'seg' }, [
    el('button', {
      type: 'button',
      class: `seg-btn${which === 'persona' ? ' active' : ''}`,
      text: '人格',
      onclick: () => ctx.onTab?.('persona'),
    }),
    el('button', {
      type: 'button',
      class: `seg-btn${which === 'role' ? ' active' : ''}`,
      text: '角色',
      onclick: () => ctx.onTab?.('role'),
    }),
  ]);

  const intro = el('div', { class: 'muted', text: copy.explain });

  /*
   * 标签和说明放在最上面、独立于内容之外。
   *
   * 用户的诉求是"不要用侧栏，从上到下"。所以这里不是左右分栏，
   * 而是：标签 → 说明 → 卡片列表 → 编辑器，一路往下。
   */
  const header = el('div', { class: 'persona-header' }, [tabs, el('div', { class: 'spacer-8' }), intro]);

  const body = renderKind(snap, cur, which, copy);

  return el('div', { class: 'persona-stack' }, [header, el('div', { class: 'spacer-12' }), ...body]);
}

/**
 * 渲一套卡（列表 + 编辑器）。
 *
 * @param {any} snap
 * @param {any} ctx 这一套卡的上下文
 * @param {'persona'|'role'} which
 * @param {any} copy
 * @returns {HTMLElement[]}
 */
function renderKind(snap, ctx, which, copy) {
  const cards = ctx.cards ?? [];
  const active = cards.find((c) => c.id === ctx.activeId) ?? cards[0] ?? null;
  const value = ctx.draft ?? active?.text ?? '';

  /** 统一的提示写入：先存状态再重绘，否则提示会被冲掉 */
  const say = (tone, text) => {
    ui.notice[which] = { tone, text };
    ctx.rerender?.();
  };

  const setField = (field, v) => {
    ui[field][which] = v;
  };

  const counter = el('span', {
    class: `counter${value.length > INJECT_LIMIT ? ' over' : ''}`,
    text: `${value.length} / ${INJECT_LIMIT}`,
  });

  const area = /** @type {HTMLTextAreaElement} */ (
    el('textarea', {
      rows: 12,
      placeholder: copy.textPlaceholder,
      oninput: (e) => {
        const v = /** @type {HTMLTextAreaElement} */ (e.target).value;
        ctx.onDraft(v);
        counter.textContent = `${v.length} / ${INJECT_LIMIT}`;
        counter.className = `counter${v.length > INJECT_LIMIT ? ' over' : ''}`;
      },
    })
  );
  area.value = value;

  /* ------------------------------------------------------------ 作用范围 */

  /**
   * 范围选择器。
   *
   * ## 为什么写成 function 而不是 const 箭头函数
   *
   * 它被 createForm 和编辑器两处调用，而两处都在它之前声明。
   * `const f = () => {}` 不会提升，调用点会撞上暂时性死区（TDZ），
   * render() 直接抛错 —— 表现是整个页面空白，而且浏览器只说
   * "Cannot read properties of undefined"，完全看不出跟顺序有关。
   *
   * function 声明会提升，顺序怎么写都不会炸。
   *
   * ## 为什么不是 <select>
   *
   * 选项只有三个，按钮点一下就到；而且下拉框的展开状态很难跨 2 秒重绘保持。
   */
  function scopePicker(opts) {
    const scope = opts.scope;
    const idValue = opts.scopeId;

    const idInput = /** @type {HTMLInputElement} */ (
      el('input', {
        type: 'text',
        class: 'text-input',
        placeholder: scope === 'group' ? '群号' : 'QQ 号',
        inputmode: 'numeric',
        autocomplete: 'off',
        oninput: (e) => {
          opts.onId(/** @type {HTMLInputElement} */ (e.target).value);
        },
      })
    );
    idInput.value = idValue;

    return el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '作用范围' }),
      el('div', { class: 'field-control' }, [
        el(
          'div',
          { class: 'row' },
          ['global', 'group', 'private'].map((s) =>
            el('button', {
              type: 'button',
              class: `btn btn-sm${scope === s ? ' btn-primary' : ''}`,
              text: SCOPE_LABEL[s],
              onclick: () => opts.onScope(s),
            })
          )
        ),
        scope === 'global' ? null : el('div', { class: 'spacer-8' }),
        scope === 'global' ? null : el('div', { class: 'row' }, [el('div', { class: 'grow' }, [idInput])]),
        el('div', {
          class: 'field-hint',
          text:
            scope === 'global'
              ? `没有专属${copy.label}的群和私聊都用这张。`
              : `只对${scope === 'group' ? '这个群' : '这个私聊'}生效；其它会话仍用全局那张。号码填${scope === 'group' ? '群号' : 'QQ 号'}。`,
        }),
      ]),
    ]);
  }

  /* ------------------------------------------------------------ 新建表单 */

  const nameInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      class: 'text-input',
      placeholder: copy.namePlaceholder,
      autocomplete: 'off',
      oninput: (e) => {
        setField('newName', /** @type {HTMLInputElement} */ (e.target).value);
      },
      onkeydown: (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === 'Enter') submitCreate();
      },
    })
  );
  nameInput.value = slot('newName', which);

  const submitCreate = async () => {
    const name = String(slot('newName', which) ?? '').trim();
    if (!name) {
      say('err', '先给它起个名字');
      return;
    }
    if (name.length > 40) {
      say('err', '名字太长了（最多 40 字）');
      return;
    }
    const ns = slot('newScope', which);
    const r = await ctx.onCreate?.(name, ns.scope, ns.scopeId);
    if (r?.ok) {
      setField('creating', false);
      setField('newName', '');
      setField('nameDraft', null);
      setField('scopeDraft', null);
      setField('newScope', { scope: 'global', scopeId: '' });
      say('ok', `已创建「${name}」`);
    } else {
      say('err', `创建失败：${r?.message ?? r?.code ?? '未知原因'}`);
    }
  };

  const creating = slot('creating', which);
  const createForm = creating
    ? el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: `新${copy.label}卡的名称` }),
        el('div', { class: 'field-control' }, [
          el('div', { class: 'row' }, [
            el('div', { class: 'grow' }, [nameInput]),
            el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: '创建', onclick: submitCreate }),
            el('button', {
              type: 'button',
              class: 'btn btn-sm',
              text: '取消',
              onclick: () => {
                setField('creating', false);
                setField('newName', '');
                ctx.rerender?.();
              },
            }),
          ]),
          el('div', { class: 'field-hint', text: '名字用来区分多张卡，随时可以改。' }),
        ]),
        scopePicker({
          scope: slot('newScope', which).scope,
          scopeId: slot('newScope', which).scopeId,
          onScope: (s) => {
            const ns = slot('newScope', which);
            setField('newScope', { scope: s, scopeId: s === 'global' ? '' : ns.scopeId });
            ctx.rerender?.();
          },
          onId: (v) => {
            setField('newScope', { scope: slot('newScope', which).scope, scopeId: v });
          },
        }),
      ])
    : null;

  /* ------------------------------------------------------------ 卡片列表 */

  /** 两段式删除：第一次点只记下 id，第二次才真删 */
  const askDelete = async (c) => {
    if (slot('confirmDelete', which) !== c.id) {
      setField('confirmDelete', c.id);
      say('err', `再点一次「删除」确认删除「${c.name}」`);
      return;
    }
    setField('confirmDelete', null);
    const r = await ctx.onDelete?.(c.id);
    if (r?.ok) {
      setField('nameDraft', null);
      say('ok', `已删除「${c.name}」`);
    } else {
      say('err', `删除失败：${r?.message ?? ''}`);
    }
  };

  const list = el(
    'div',
    { class: 'list' },
    cards.length === 0
      ? [el('div', { class: 'muted', text: copy.emptyList })]
      : cards.map((c) =>
          el('div', { class: 'persona-row' }, [
            el(
              'button',
              {
                class: `persona-pick${c.id === ctx.activeId ? ' active' : ''}`,
                type: 'button',
                title: c.text.slice(0, 200),
                onclick: async () => {
                  if (c.id === ctx.activeId) return;
                  const r = await ctx.onSelect?.(c.id);
                  // 切卡后名字草稿要跟着换，否则改名会改到上一张
                  setField('nameDraft', null);
                  say(
                    r?.ok ? 'ok' : 'err',
                    r?.ok ? `已切换到「${c.name}」，下一回合生效` : `切换失败：${r?.message ?? ''}`,
                  );
                },
              },
              [
                el('span', { class: 'name', text: c.name }),
                /*
                 * 范围必须显示在列表里。
                 *
                 * 不显示的话，用户看到一堆相似名字的卡，完全不知道
                 * 哪张在哪个群生效 —— 而这正是最需要一眼看清的信息。
                 */
                el('span', {
                  class: `tag${c.scope === 'global' ? '' : ' tag-strong'}`,
                  text: c.scope === 'global' ? '全局' : describeScope(c.scope, c.scopeId),
                }),
                el('span', { class: 'muted', text: c.id === ctx.activeId ? '使用中' : `${c.length} 字` }),
              ],
            ),
            el('button', {
              class: 'btn btn-ghost',
              type: 'button',
              text: '副本',
              title: '复制这张卡的内容到新卡',
              onclick: async () => {
                const r = await ctx.onDuplicate?.(c.id);
                say(r?.ok ? 'ok' : 'err', r?.ok ? `已创建副本「${r?.card?.name ?? ''}」` : `失败：${r?.message ?? ''}`);
              },
            }),
            el('button', {
              class: 'btn btn-ghost btn-danger',
              type: 'button',
              text: '删除',
              onclick: () => askDelete(c),
            }),
          ])
        )
  );

  /* ------------------------------------------------------------ 改名 */

  const nameField = active
    ? (() => {
        const input = /** @type {HTMLInputElement} */ (
          el('input', {
            type: 'text',
            class: 'text-input',
            placeholder: `${copy.label}卡名称`,
            autocomplete: 'off',
            oninput: (e) => {
              setField('nameDraft', /** @type {HTMLInputElement} */ (e.target).value);
            },
            onkeydown: (e) => {
              if (/** @type {KeyboardEvent} */ (e).key === 'Enter') {
                /** @type {HTMLButtonElement|null} */ (document.getElementById(`btn-rename-${which}`))?.click();
              }
            },
          })
        );
        input.value = slot('nameDraft', which) ?? active.name;
        return el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '名称' }),
          el('div', { class: 'field-control' }, [
            el('div', { class: 'row' }, [
              el('div', { class: 'grow' }, [input]),
              el('button', {
                id: `btn-rename-${which}`,
                type: 'button',
                class: 'btn btn-sm',
                text: '改名',
                onclick: async () => {
                  const next = String(slot('nameDraft', which) ?? '').trim();
                  if (!next) {
                    say('err', '名字不能为空');
                    return;
                  }
                  if (next === active.name) {
                    say('muted', '名字没变');
                    return;
                  }
                  const r = await ctx.onSave?.({ name: next });
                  if (r?.ok) {
                    setField('nameDraft', null);
                    say('ok', `已改名为「${next}」`);
                  } else {
                    say('err', `改名失败：${r?.message ?? r?.code ?? ''}`);
                  }
                },
              }),
            ]),
            el('div', { class: 'field-hint', text: '改名只影响卡的标识，不改变注入内容。' }),
          ]),
        ]);
      })()
    : null;

  /* ------------------------------------------------------------ 提示条 */

  const notice = slot('notice', which);
  const noticeEl = notice
    ? el('div', {
        class: notice.tone === 'ok' ? 'ok' : notice.tone === 'err' ? 'err' : 'field-hint',
        text: notice.text,
      })
    : el('div', { class: 'field-hint', text: '' });

  /* ------------------------------------------------------------ 拼装 */

  /** 列表卡：新建按钮 + 列表 */
  const listCard = card(copy.cardTitle, [
    el('div', { class: 'row' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: creating ? '取消新建' : copy.newButton,
        onclick: () => {
          setField('creating', !creating);
          setField('newName', '');
          ctx.rerender?.();
        },
      }),
    ]),
    createForm ? el('div', { class: 'spacer-10' }) : null,
    createForm,
    el('div', { class: 'spacer-10' }),
    list,
    el('div', { class: 'spacer-10' }),
    noticeEl,
  ]);

  /** 编辑器卡 */
  const draftScope = slot('scopeDraft', which);
  const scope = draftScope?.scope ?? active?.scope ?? 'global';
  const scopeId = draftScope?.scopeId ?? active?.scopeId ?? '';

  const editorCard = active
    ? card(`编辑：${active.name}（${copy.label}）`, [
        nameField,
        el('div', { class: 'spacer-8' }),
        scopePicker({
          scope,
          scopeId,
          onScope: (s) => {
            setField('scopeDraft', {
              scope: s,
              // 切到 global 时清掉号码，免得以后切回来带着旧值
              scopeId: s === 'global' ? '' : (draftScope?.scopeId ?? active.scopeId ?? ''),
            });
            ctx.rerender?.();
          },
          onId: (v) => {
            setField('scopeDraft', {
              scope: draftScope?.scope ?? active.scope ?? 'global',
              scopeId: v,
            });
          },
        }),
        el('div', { class: 'row' }, [
          el('button', {
            type: 'button',
            class: 'btn btn-sm',
            text: '保存范围',
            onclick: async () => {
              const d = slot('scopeDraft', which) ?? { scope: active.scope, scopeId: active.scopeId };
              const r = await ctx.onSaveScope?.(active.id, d.scope, d.scopeId);
              if (r?.ok) {
                setField('scopeDraft', null);
                say('ok', `作用范围已改为${SCOPE_LABEL[d.scope] ?? d.scope}`);
              } else {
                say('err', `改范围失败：${r?.message ?? r?.code ?? ''}`);
              }
            },
          }),
          draftScope ? el('span', { class: 'muted', text: '范围有未保存的改动' }) : null,
        ]),
        el('div', { class: 'spacer-10' }),
        el('div', { class: 'persona-editor' }, [
          area,
          el('div', { class: 'list' }, [
            el('div', { class: 'muted', text: '注入字符数' }),
            counter,
            el('div', { class: 'spacer-10' }),
            el('div', { class: 'row' }, [
              el('button', {
                class: 'btn btn-primary',
                type: 'button',
                text: '保存内容',
                onclick: async (e) => {
                  const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
                  btn.disabled = true;
                  btn.textContent = '保存中…';
                  try {
                    if (area.value.length > INJECT_LIMIT) {
                      say('err', `超限：${area.value.length} / ${INJECT_LIMIT}，未保存`);
                      return;
                    }
                    const res = await ctx.onSave?.({});
                    say(res?.ok ? 'ok' : 'err', res?.ok ? '已保存，下一回合生效' : `保存失败：${res?.message ?? ''}`);
                  } finally {
                    btn.disabled = false;
                    btn.textContent = '保存内容';
                  }
                },
              }),
              ctx.dirty ? el('span', { class: 'muted', text: '有未保存的改动' }) : null,
            ]),
          ]),
        ]),
      ])
    : card(`编辑${copy.label}`, [el('div', { class: 'empty', text: copy.emptyEditor })]);

  return [listCard, editorCard];
}

/**
 * 行为层只读展示。
 *
 * 单独导出是因为它和"哪一套卡"无关 —— 它永远在页面最下面，
 * 提示用户人格/角色都改不动安全边界。
 *
 * @returns {HTMLElement}
 */
export function renderBehaviorLayer() {
  return card('行为层（只读）', [
    el('div', { class: 'muted', text: '内置常量，谁都改不了。人格卡和角色卡被改写都不会影响任何安全判定。' }),
    el('div', { class: 'spacer-10' }),
    el('div', {
      class: 'mono',
      text: [
        '· 不扮演别的身份去骗人',
        '· 不透露本机路径、凭据、配置',
        '· 群聊里没有宿主机工具（这是结构，不是规则）',
        '· 不确定就说不确定，不编造',
      ].join('\n'),
    }),
  ]);
}
