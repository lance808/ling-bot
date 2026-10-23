/**
 * 安全页 —— F9 / F14
 *
 * 核心是让用户**看见授权模型**：
 * 哪些工具对哪些来源可见，这是结构性事实，不是提示词说服的结果。
 *
 * ## 为什么白名单和黑名单都在这一页
 *
 * 两者是 L1 准入门的两个方向，而且**黑名单优先**：
 * 一个号同时在两边时，拉黑生效。这是有意的 —— 万一某个号被盗，
 * 先拉黑应该立刻起作用，而不是还要先去白名单里把它删掉。
 *
 * 所以两张卡片并排放、并把"谁优先"写在卡片里，用户才不会困惑。
 *
 * ## 编辑为什么做成"先加进缓冲、再保存"
 *
 * 直接每敲一个字符就写配置，后端会反复重新判定准入，而且中途会有
 * 半截数字（"369" 这种）被当成真号。所以先编辑本地列表，点保存才提交，
 * 后端还会再校验一遍形状（见 normalizeIdLists）。
 */

import { el, card, kv, pill } from '../render.mjs';

/**
 * 一个号码列表的编辑缓冲。
 *
 * @typedef {{
 *   groups: string[],
 *   private: string[],
 * }} IdListDraft
 */

/**
 * 页面级状态。
 *
 * 必须活在模块作用域 —— 快照每 2 秒轮询一次、每次整页重建，
 * 局部变量会跟着 DOM 一起消失，用户刚敲进去的号就没了。
 */
const ui = {
  /** @type {{allow: IdListDraft | null, deny: IdListDraft | null}} */
  draft: { allow: null, deny: null },
  /**
   * 每个列表上一次保存的结果。
   *
   * 键形如 `allow:groups`、`deny:private`。
   *
   * @type {Record<string, {ok: boolean, text: string}>}
   */
  lastSave: {},
  /**
   * 各输入框的即时反馈（"已加入 2 个" / "abc123 不是有效号码"）。
   *
   * 必须存这里 —— 原来写进一个局部 DOM 节点，紧接着 ctx.rerender()
   * 把整页重建，那个节点就没了，提示永远看不到。
   *
   * @type {Record<string, {tone: string, text: string}>}
   */
  hint: {},
};

/**
 * @param {any} snap
 * @param {any} ctx
 * @returns {HTMLElement}
 */
export function renderSecurity(snap, ctx = {}) {
  const tools = snap?.registry?.tools ?? [];
  const allow = snap?.config?.allow ?? { groups: [], private: [] };
  const deny = snap?.config?.deny ?? { groups: [], private: [] };
  const allowAllWhenEmpty = snap?.config?.allowAllWhenEmpty === true;
  /**
   * 管理员列表现在住在插件配置里（`plugins.config['dsh-bridge'].admins`）。
   *
   * 这里以前读 `config.dsh.admins` —— 那是迁移前的旧位置，迁移后永远是空数组，
   * 于是下面那条"管理员私聊也能收到审批推送"的提示**再也不会显示**，
   * 用户会以为审批推送坏了。保留旧位置兜底：万一迁移还没跑到。
   */
  const adminRaw =
    snap?.config?.plugins?.config?.['dsh-bridge']?.admins ?? snap?.config?.dsh?.admins ?? '';
  const admins = Array.isArray(adminRaw)
    ? adminRaw
    : String(adminRaw ?? '')
        .split(/[,，、\s]+/)
        .filter(Boolean);

  const hostTools = tools.filter((t) => t.kind === 'host');
  const qqTools = tools.filter((t) => t.kind !== 'host');

  /* ============================================================ 列表编辑组件 */

  /**
   * 生成一张「号码列表」卡片。
   *
   * 白名单和黑名单结构完全一样，只有语义和文案不同，所以做成参数化的，
   * 避免两处各写一遍然后渐渐走样。
   *
   * @param {'allow' | 'deny'} which
   * @param {{
   *   title: string,
   *   intro: string,
   *   groupLabel: string,
   *   privateLabel: string,
   *   saveText: string,
   *   emptyGroup: string,
   *   emptyPrivate: string,
   * }} copy
   */
  const listCard = (which, copy) => {
    const source = which === 'allow' ? allow : deny;

    // 没有草稿时用快照的值；有草稿就保留用户的编辑
    if (!ui.draft[which]) {
      ui.draft[which] = {
        groups: [...(source.groups ?? [])],
        private: [...(source.private ?? [])],
      };
    }
    const draft = /** @type {IdListDraft} */ (ui.draft[which]);

    /**
     * 一个可删除的号码条目。
     *
     * @param {'groups' | 'private'} listName
     * @param {string} id
     */
    const chip = (listName, id) =>
      el('span', { class: 'chip' }, [
        el('span', { class: 'mono', text: id }),
        el('button', {
          type: 'button',
          class: 'chip-x',
          text: '×',
          title: `从${which === 'deny' ? '黑名单' : '白名单'}移除 ${id}`,
          onclick: () => {
            ui.draft[which][listName] = ui.draft[which][listName].filter((x) => x !== id);
            // 立刻重绘，不用等 2 秒轮询
            ctx.rerender?.();
          },
        }),
      ]);

    /**
     * @param {'groups' | 'private'} listName
     * @param {string} placeholder
     * @param {string} label
     */
    const adder = (listName, placeholder, label) => {
      const key = `${which}:${listName}`;
      const input = /** @type {HTMLInputElement} */ (
        el('input', {
          type: 'text',
          class: 'text-input',
          placeholder,
          inputmode: 'numeric',
          autocomplete: 'off',
        })
      );

      const prev = ui.hint[key];
      const say = el('div', {
        class: prev ? (prev.tone === 'ok' ? 'ok' : prev.tone === 'err' ? 'err' : 'field-hint') : 'field-hint',
        text: prev ? prev.text : '',
      });

      const submit = () => {
        const raw = input.value.trim();
        if (!raw) return;
        /*
         * 允许一次粘多个（逗号/空格/换行分隔）。
         *
         * 真实场景里用户是从别处复制一串号过来，挨个粘贴很烦。
         * 但每个都必须过格式校验 —— 形状不对的号在闸门里会导致
         * 名单静默失效，所以这里挡住比后面出问题好。
         */
        const parts = raw.split(/[\s,，;；]+/).filter(Boolean);
        /** @type {string[]} */
        const bad = [];
        /** @type {string[]} */
        const added = [];
        for (const p of parts) {
          if (!/^\d{5,12}$/.test(p)) {
            bad.push(p);
            continue;
          }
          if (!ui.draft[which][listName].includes(p)) {
            ui.draft[which][listName].push(p);
            added.push(p);
          }
        }
        input.value = '';
        /*
         * 提示必须存进模块级状态再重绘。
         *
         * 直接改局部节点的话，紧接着的 ctx.rerender() 会整页重建，
         * 那个节点跟着消失 —— 用户什么都看不到，以为没反应。
         */
        if (bad.length > 0) {
          ui.hint[key] = { tone: 'err', text: `已忽略 ${bad.join('、')}：不是有效的号码（5–12 位数字）` };
        } else if (added.length > 0) {
          ui.hint[key] = { tone: 'ok', text: `已加入 ${added.length} 个，记得点「${copy.saveText}」` };
        } else {
          ui.hint[key] = { tone: 'muted', text: '已经在名单里了' };
        }
        ctx.rerender?.();
      };

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') submit();
      });

      return el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: label }),
        el('div', { class: 'field-control' }, [
          el('div', { class: 'row' }, [
            el('div', { class: 'grow' }, [input]),
            el('button', { type: 'button', class: 'btn btn-sm', text: '添加', onclick: submit }),
          ]),
          say,
        ]),
      ]);
    };

    const lastSave = ui.lastSave[which];

    const saveBtn = el('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: copy.saveText,
      onclick: async (ev) => {
        const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
        btn.disabled = true;
        btn.textContent = '保存中…';
        const r = await ctx.onSaveSetting?.(which, {
          groups: ui.draft[which].groups,
          private: ui.draft[which].private,
        });
        btn.disabled = false;
        btn.textContent = copy.saveText;
        if (r?.ok !== true) {
          ui.lastSave[which] = { ok: false, text: `保存失败：${r?.message ?? r?.code ?? '接口未返回成功结果'}` };
        } else {
          ui.lastSave[which] = { ok: true, text: '✓ 已保存，立刻生效' };
          // 下次渲染重新从快照取，避免草稿和配置不一致
          ui.draft[which] = null;
        }
        ctx.rerender?.();
      },
    });

    const saveHint = el('div', {
      class: `field-hint ${lastSave ? (lastSave.ok ? 'ok' : 'err') : ''}`,
      text: lastSave ? lastSave.text : '',
    });

    /*
     * 黑名单是"额外拦下"而不是"必须填"，空了没有副作用。
     * 白名单空了才要警告（名单为空 + 不放行全部 = 谁都进不来）。
     */
    const emptyWarn =
      which === 'allow' && !allowAllWhenEmpty && draft.groups.length === 0 && draft.private.length === 0
        ? el('div', { class: 'hint' }, [
            el('div', {
              text: '⚠ 白名单是空的，而且「空名单放行全部」是关闭的 —— 现在谁的消息都进不来。',
            }),
          ])
        : null;

    /**
     * 白名单特有的提示：管理员私聊即使不在名单里也能收到审批。
     *
     * 这条不写清楚，用户会以为"审批推送坏了"。
     */
    const adminNote =
      which === 'allow' && admins.length > 0
        ? el('div', { class: 'field-hint', text: `管理员私聊（${admins.length} 个）即使不在白名单里，也能收到审批推送。` })
        : null;

    return card(copy.title, [
      el('div', { class: 'muted', text: copy.intro }),
      el('div', { class: 'spacer-10' }),

      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: `${copy.groupLabel}（${draft.groups.length}）` }),
        el('div', { class: 'field-control' }, [
          draft.groups.length === 0
            ? el('div', { class: 'muted', text: copy.emptyGroup })
            : el('div', { class: 'chips' }, draft.groups.map((id) => chip('groups', id))),
        ]),
      ]),

      adder('groups', '输入群号，多个用逗号分隔', `添加${copy.groupLabel}`),

      el('div', { class: 'spacer-16' }),

      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: `${copy.privateLabel}（${draft.private.length}）` }),
        el('div', { class: 'field-control' }, [
          draft.private.length === 0
            ? el('div', { class: 'muted', text: copy.emptyPrivate })
            : el('div', { class: 'chips' }, draft.private.map((id) => chip('private', id))),
        ]),
      ]),

      adder('private', '输入 QQ 号，多个用逗号分隔', `添加${copy.privateLabel}`),

      emptyWarn,

      el('div', { class: 'spacer-16' }),
      el('div', { class: 'row' }, [saveBtn]),
      saveHint,
      adminNote,
    ]);
  };

  return el('div', {}, [
    listCard('allow', {
      title: '白名单（L1 准入）',
      intro: '名单外的群聊与私聊，消息根本进不来 —— 这是最靠前的一道闸，不是提示词能绕过的。',
      groupLabel: '群聊',
      privateLabel: '私聊',
      saveText: '保存白名单',
      emptyGroup: '还没有群。在下面输入群号添加。',
      emptyPrivate: '还没有私聊对象。在下面输入 QQ 号添加。',
    }),

    listCard('deny', {
      title: '黑名单（优先于白名单）',
      intro:
        '名单里的群聊与私聊，消息一律拒收 —— 优先级高于白名单，也高于管理员身份。' +
        '某个号被盗时，先拉黑比先去白名单删更直接。',
      groupLabel: '群聊',
      privateLabel: '私聊',
      saveText: '保存黑名单',
      emptyGroup: '黑名单为空。要拦某个群就在下面加。',
      emptyPrivate: '黑名单为空。要拦某个人就在下面加。',
    }),

    /*
     * 四层防线。
     *
     * 原来用「L1 准入 / L2 授权 / L3 约束 / L4 审计」编号。
     * 改成语义名称：L 编号原来在记忆页也有一套（L3 情境 / L4 工具 / L5 契约），
     * 两套编号撞在一起 —— 用户在两个页面看到两个不同的「L3」，
     * 会以为是同一套体系里的同一个东西。记忆那套已经删了，
     * 但编号本身没有信息量，不如直接说它管什么。
     */
    card('四层防线', [
      el('div', { class: 'list' }, [
        kv(
          '准入',
          `白名单 群 ${allow.groups.length} / 私聊 ${allow.private.length}，黑名单 ${deny.groups.length + deny.private.length}`,
        ),
        kv('授权', '只看回合来源（origin），不看对话内容'),
        kv('约束', '路径根 / 命令白名单 / 上限 / 跨会话隔离'),
        kv('审计', '出站文本 + 调用流水'),
      ]),
    ]),

    /*
     * 这里原来有一张「工具面（F14）」列表，逐条列出宿主工具与 QQ 工具。
     *
     * 已经删掉：完整工具列表现在只在《工具调用》页维护一份。
     * 同一批数据在两个页面各画一遍，加一个工具就得记得改两处 ——
     * 漏改的那次不会报错，只会让两个页面说的不一样，
     * 而用户没法判断该信哪个。
     *
     * 这一页保留的是**安全判定本身**（谁能调、按什么规则判），
     * 那才是"系统安全"该讲的东西。
     */

    card('工具面（F14）', [
      el('div', { class: 'muted', text: '未声明 origins 的工具谁都调不到；群聊来源永远看不到宿主机工具。' }),
      el('div', { class: 'spacer-10' }),
      el('div', { class: 'row wrap' }, [
        pill(`宿主机工具 ${hostTools.length} 个`, hostTools.length > 0 ? 'warn' : 'dim'),
        pill(`QQ 工具 ${qqTools.length} 个`, qqTools.length > 0 ? 'dim' : 'dim'),
      ]),
      el('div', { class: 'spacer-8' }),
      el('div', {
        class: 'field-hint',
        text: '具体有哪些工具、各自对谁开放，见「工具调用」页。',
      }),
    ]),

    /*
     * 来源表也保留 —— 但这是**判定规则**，不是工具清单。
     * 工具清单会变（插件装卸），来源规则不会变（写在代码里）。
     */
    card('回合来源与默认工具集', [
      el('div', { class: 'list' }, [
        kv('owner-private（管理员私聊）', pill('宿主机工具（按配置）', 'warn')),
        kv('owner-group（管理员在群里）', pill('仅 QQ 工具', 'dim')),
        kv('group（群友）', pill('空集 + 只读 QQ', 'ok')),
        kv('proactive（主动发言）', pill('空集', 'ok')),
        kv('console（桌面端）', pill('按管理员规则', 'dim')),
      ]),
    ]),

    card('本轮说明', [
      el('div', {
        class: 'muted',
        text: [
          '有人能说服模型做任何事，但改不了它能调用什么。',
          '这就是为什么授权判定的输入里没有对话内容——',
          '提示注入只能用结构防，不能用提示词防。',
        ].join(''),
      }),
    ]),
  ]);
}
