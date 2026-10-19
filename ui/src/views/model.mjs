/**
 * 模型设置页 —— 按接入顺序组织：提供商 → Key → 读模型 → 选模型 → 探能力
 *
 * ## 为什么按这个顺序
 *
 * 这几步是**有依赖**的：没有地址和 key 就读不到模型列表，没有列表就只能手填，
 * 手填名字又不知道它到底能不能读图。按依赖顺序摆放，用户不用猜下一步做什么。
 *
 * 参考了 qq-bridge 控制台的两个做法：
 *
 * 1. **模型从目录里选，不手填**。拼错一个字的表现是 404 / "Model is not
 *    supported"，用户分不清是名字错还是服务挂了。
 * 2. **能力靠实测，不靠查表**。它发一张微型图片问"什么颜色"来判定视觉，
 *    这里同样做法——同一个模型名在不同中转站的能力可以完全不同。
 *
 * ## 三态能力显示（这条很重要）
 *
 * 每个能力有**三种**状态，不能压成两种：
 *   ✓ 已确认支持 / ✗ 已确认不支持 / ? 未测（或没测出来）
 *
 * 把"没测出来"显示成"不支持"是很容易犯的错：
 * 超时和网络错误都会导致探测失败，但模型本身可能完全支持。
 * 用户看到"不支持"就不会再试了，问题被永久掩盖。
 */

import { el, card, kv, pill } from '../render.mjs';

/**
 * 提供商预设。
 *
 * 两种形态，对应两种用户：
 *   - **预设**：点一下就自动填好地址，适合用官方或常见服务的
 *   - **自定义**：自己填第三方地址
 *
 * 只列有公开文档的官方服务，**不列任何具体中转站**
 * ——中转站是私人用的，写进源码既没意义也容易过期。
 *
 * `baseUrl` 只是"选了之后自动填进输入框"的便捷默认值，用户可以再改
 * ——所以它不构成第二真相源，实际请求永远以输入框里的地址为准。
 */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', note: '官方直连' },
  { id: 'openai', name: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', note: '官方直连' },
  { id: 'moonshot', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', note: '官方直连' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', note: '国内可直连' },
];

/** 目录读不到时的兜底清单：只放几乎确定存在的 */
const FALLBACK_MODELS = ['deepseek-v4.1', 'deepseek-v4.1-flash', 'deepseek-v4-pro'];

/** 通道标签的配色 */
const CHANNEL_TONE = {
  multimodal: 'ok',
  imageGen: 'ok',
  text: 'dim',
  embedding: 'dim',
  audio: 'dim',
};

/**
 * 页面级状态，必须活在模块作用域。
 *
 * ## 为什么不能写在 render 里
 *
 * 最初 `const local = {...}` 是写在 `renderModelSettings` 内部的。
 * 那样每次渲染（快照每 2 秒来一次）都会**重新创建一个新对象**，
 * 初值取自快照。后果：
 *
 *   - 用户正在输入框里打字 → 重绘销毁节点 → 字没了
 *   - 用户输了一半切换页面再回来 → 草稿没了
 *   - 「读取模型列表」拉到的 catalog 在下次渲染时消失
 *
 * 表现就是"点进去准备输入，它自动给我恢复了"。
 *
 * 放到模块作用域后，状态跨渲染存活；只有显式 reset 才清空。
 *
 * @type {{
 *   provider: string,
 *   baseUrl: string,
 *   catalog: Array<any>|null,
 *   picked: string,
 *   probes: Record<string, any>,
 *   busy: string,
 *   dirty: boolean,
 * }}
 */
const state = {
  provider: '',
  baseUrl: '',
  catalog: null,
  picked: '',
  probes: {},
  busy: '',
  /**
   * API Key 的输入草稿。
   *
   * 单独存，因为后端永远不回明文 key（只回掩码），
   * 所以它不能从快照恢复——重绘后只能靠这份草稿回填。
   * 仅存在内存里，保存成功或清除后置空。
   *
   * @type {string}
   */
  keyDraft: '',
  /**
   * 超时的输入草稿。
   *
   * @type {string | null}
   */
  timeoutDraft: null,
  /**
   * 最近一次「测试连接」的结果。
   *
   * ## 为什么必须存在这里而不是直接画进 DOM
   *
   * 测试结果原本写在一个临时 div（testHost）里，而快照每 2 秒轮询一次、
   * 每次都会整页重建，那个 div 立刻被销毁 —— 用户看到结果闪一下就没了。
   *
   * 存进模块级 state 后，每次重绘都能把它画回来，于是它像一行常驻数据
   * 那样留在「当前状态」卡片里，直到下一次测试或重启。
   *
   * @type {{ ok: boolean, at: number } | null}
   */
  lastTest: null,
  /**
   * 用户是否动过这些输入。
   *
   * 没动过时，每次渲染都可以用快照的最新值填充（这样后端改了配置
   * 界面会跟着变）。动过之后就不能再覆盖了，否则用户输入被吃掉。
   */
  dirty: false,
};

/**
 * @param {any} snap
 * @param {any} ctx
 * @returns {HTMLElement}
 */
export function renderModelSettings(snap, ctx) {
  const llm = snap?.config?.llm ?? {};
  const brain = snap?.brain ?? {};
  const configured = Boolean(brain.configured);
  const capsAll = llm.modelCapabilities ?? {};

  // 用户没动过输入时，用快照刷新；动过就保留他的草稿
  if (!state.dirty) {
    state.provider = llm.provider || (llm.baseUrl ? 'custom' : 'deepseek');
    state.baseUrl = llm.baseUrl ?? '';
    state.picked = llm.model ?? '';
  }

  const local = state;

  const msg = el('div', { class: 'muted mono', text: '' });
  const say = (text, cls = 'muted mono') => {
    msg.className = cls;
    msg.textContent = text;
  };

  /* ============================================================ 第 1 步：提供商 */

  const baseUrlInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      class: 'text-input',
      placeholder: 'https://api.example.com/v1',
      autocomplete: 'off',
      spellcheck: false,
      value: local.baseUrl,
    })
  );

  /**
   * 提供商卡片切换。
   *
   * 为什么用卡片不用下拉：
   *   - 下拉框把选项藏起来，用户不知道有哪几种、也没法一眼比较
   *   - 卡片能同时展示"名字 + 地址 + 说明"，选之前就能判断
   *   - 「自定义」作为一个平级选项出现，不会被漏掉
   */
  const providerCards = el('div', { class: 'provider-cards' });

  const renderProviderCards = () => {
    const cards = [];

    for (const p of PROVIDERS) {
      const active = local.provider === p.id;
      cards.push(
        el(
          'button',
          {
            class: `provider-card${active ? ' active' : ''}`,
            type: 'button',
            onclick: () => {
              local.provider = p.id;
              baseUrlInput.value = p.baseUrl;
              local.baseUrl = p.baseUrl;
              renderProviderCards();
              baseUrlInput.focus();
            },
          },
          [
            el('div', { class: 'provider-card-name', text: p.name }),
            el('div', { class: 'provider-card-url mono', text: p.baseUrl.replace(/^https?:\/\//, '') }),
            el('div', { class: 'provider-card-note', text: p.note }),
          ],
        ),
      );
    }

    // 自定义：作为同级卡片，不是"其它"这种藏在末尾的选项
    const customActive = local.provider === 'custom';
    cards.push(
      el(
        'button',
        {
          class: `provider-card${customActive ? ' active' : ''}`,
          type: 'button',
          onclick: () => {
            local.provider = 'custom';
            // 切到自定义时**不清空**已填地址：
            // 清空会让人以为刚才的输入丢了。用户想改直接改就行。
            renderProviderCards();
            baseUrlInput.focus();
            baseUrlInput.select();
          },
        },
        [
          el('div', { class: 'provider-card-name', text: '自定义第三方' }),
          el('div', { class: 'provider-card-url mono', text: '自己填网址' }),
          el('div', { class: 'provider-card-note', text: '中转站 / 自建服务' }),
        ],
      ),
    );

    providerCards.replaceChildren(...cards);
  };

  renderProviderCards();

  baseUrlInput.addEventListener('input', () => {
    local.baseUrl = baseUrlInput.value.trim();
    // 一旦用户改过，后续渲染不能再用快照覆盖它
    local.dirty = true;
  });

  const saveBaseUrlBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: '保存地址',
    onclick: async () => {
      const v = baseUrlInput.value.trim();
      if (!v) return say('地址不能为空', 'err mono');
      const r = await ctx.onSaveSetting('llm.baseUrl', v);
      if (!r?.ok) return say(`保存失败：${r?.message ?? r?.code}`, 'err mono');
      await ctx.onSaveSetting('llm.provider', local.provider);
      local.baseUrl = v;
      local.dirty = false;
      say('✓ 地址已保存', 'ok mono');
    },
  });

  /* ============================================================ 第 2 步：Key */

  const keyInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'password',
      class: 'text-input',
      placeholder: configured ? '已配置。要更换请输入新的 key' : '粘贴 API Key（sk-…）',
      autocomplete: 'off',
      spellcheck: false,
    })
  );

  /*
   * Key 的草稿要单独留住。
   *
   * 这个框的值不能被快照覆盖（后端永远不回明文 key），
   * 但重绘会重建节点，值就丢了。所以存在模块级 state 里，
   * 重绘后回填。
   *
   * 注意：这只是**本次会话的内存**，不落盘、不进日志。
   */
  keyInput.value = state.keyDraft ?? '';
  keyInput.addEventListener('input', () => {
    state.keyDraft = keyInput.value;
  });

  const saveKeyBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: '保存 Key',
    onclick: async () => {
      const k = keyInput.value.trim();
      if (!k) return say('先粘贴 Key', 'err mono');
      const r = await ctx.onSaveApiKey(k);
      if (!r?.ok) return say(`保存失败：${r?.message ?? r?.code}`, 'err mono');
      // 已经进保险箱了，内存里的草稿没有留着的理由
      state.keyDraft = '';
      keyInput.value = '';
      keyInput.value = '';
      say('✓ Key 已加密保存', 'ok mono');
    },
  });

  const clearKeyBtn = configured
    ? el('button', {
        class: 'btn btn-ghost btn-danger',
        type: 'button',
        text: '清除 Key',
        onclick: async () => {
          const r = await ctx.onClearApiKey();
          say(r?.ok ? '已清除 Key' : '清除失败', r?.ok ? 'muted mono' : 'err mono');
        },
      })
    : null;

  /* ============================================================ 第 3 步：读目录 */

  const catalogHost = el('div', {});

  const loadBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: '读取模型列表',
    onclick: async (e) => {
      const b = /** @type {HTMLButtonElement} */ (e.target);
      b.disabled = true;
      say('正在读取模型列表…');
      try {
        const r = await ctx.onDetectModels();
        if (r?.ok && Array.isArray(r.models) && r.models.length > 0) {
          local.catalog = r.models;
          // 当前选中的模型如果不在目录里，仍然保留显示（见 renderCatalog）
          say(`✓ 读到 ${r.models.length} 个模型`, 'ok mono');
        } else {
          local.catalog = FALLBACK_MODELS.map((id) => ({ id }));
          say(`读取失败（${r?.message ?? r?.code ?? '未知'}），已退回内置清单`, 'err mono');
        }
        catalogHost.replaceChildren(renderCatalog());
      } finally {
        b.disabled = false;
      }
    },
  });

  /* ============================================================ 第 4 步：选模型 + 能力 */

  const renderCatalog = () => {
    const items = local.catalog ?? local.picked
      ? (local.catalog ?? [])
      : [];

    const list = (items.length > 0 ? items : FALLBACK_MODELS.map((id) => ({ id })));

    // 当前值不在列表里：补一项，否则下拉会跳到第一项，用户以为模型被偷改了
    const hasPicked = list.some((m) => m.id === local.picked);
    const merged = hasPicked || !local.picked
      ? list
      : [{ id: local.picked, channel: null, channelLabel: '当前值', basis: '不在目录里' }, ...list];

    const select = /** @type {HTMLSelectElement} */ (el('select', { class: 'text-input' }));
    for (const m of merged) {
      const caps = local.probes[m.id]?.caps ?? capsAll[m.id] ?? {};
      const ch = m.channelLabel ?? inferLabel(m.id, caps);
      const flags = [];
      if (caps.vision === true) flags.push('读图✓');
      if (caps.vision === false) flags.push('读图✗');
      if (caps.image === true) flags.push('生图✓');
      const tail = flags.length ? ` · ${flags.join(' ')}` : '';
      select.appendChild(el('option', { value: m.id, text: `${m.id}｜${ch}${tail}` }));
    }
    if (local.picked) select.value = local.picked;

    const applyBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: '用这个模型',
      onclick: async () => {
        const r = await ctx.onSaveSetting('llm.model', select.value);
        if (!r?.ok) return say(`保存失败：${r?.message ?? r?.code}`, 'err mono');
        local.picked = select.value;
        say(`✓ 已切换到 ${select.value}`, 'ok mono');
        catalogHost.replaceChildren(renderCatalog());
      },
    });

    const probeBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: '探测能力',
      title: '会发一次极小的真实请求（一张 1×1 图片 / 一次 1 张生图），消耗极少额度',
      onclick: async (e) => {
        const b = /** @type {HTMLButtonElement} */ (e.target);
        b.disabled = true;
        say('正在探测（会发真实请求，约几秒）…');
        try {
          const r = await ctx.onProbe(select.value, ['vision', 'image']);
          if (!r?.ok) {
            say(`探测失败：${r?.message ?? r?.code}`, 'err mono');
          } else {
            local.probes[select.value] = { caps: r.caps, probes: r.probes };
            const v = r.probes?.vision;
            const g = r.probes?.image;
            const fmt = (x, yes, no) =>
              x?.supported === true ? yes : x?.supported === false ? no : '没测出来';
            say(
              `读图：${fmt(v, '✓ 支持', '✗ 不支持')}｜生图：${fmt(g, '✓ 支持', '✗ 不支持')}｜通道：${r.channel?.label ?? '-'}`,
              'muted mono',
            );
            catalogHost.replaceChildren(renderCatalog());
            renderCapabilityDetail(select.value);
          }
        } finally {
          b.disabled = false;
        }
      },
    });

    return el('div', {}, [
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field-label', text: '模型' }),
        el('div', { class: 'field-control' }, [
          select,
          el('div', { class: 'row' }, [applyBtn, probeBtn]),
        ]),
      ]),
      capabilityHost,
    ]);
  };

  /* ---- 能力详情 ---- */

  const capabilityHost = el('div', {});

  const renderCapabilityDetail = (modelId) => {
    const p = local.probes[modelId];
    const caps = p?.caps ?? capsAll[modelId] ?? {};
    const ch = inferChannelLabel(modelId, caps);

    /** 三态渲染：true/false/null 必须分别显示 */
    const tri = (v, yesText, noText) => {
      if (v === true) return pill(yesText, 'ok');
      if (v === false) return pill(noText, 'err');
      return pill('未测', 'dim');
    };

    const rows = [
      kv('通道', pill(ch.label, CHANNEL_TONE[ch.channel] ?? 'dim')),
      kv('判断依据', el('span', { class: 'muted', text: ch.basis })),
      kv('读图（视觉）', tri(caps.vision, '✓ 支持', '✗ 不支持')),
      kv('生图', tri(caps.image, '✓ 支持', '✗ 不支持')),
    ];

    if (caps.probedAt) {
      rows.push(kv('探测时间', el('span', { class: 'muted', text: String(caps.probedAt).replace('T', ' ').slice(0, 19) })));
    }

    // 探测失败的具体原因要看得到，否则"没测出来"等于没说
    const detailLines = [];
    for (const [k, label] of [['vision', '读图'], ['image', '生图']]) {
      const r = p?.probes?.[k];
      if (r && r.supported !== true && r.detail) {
        detailLines.push(`${label}：${r.detail}`);
      }
    }

    capabilityHost.replaceChildren(
      card('模型能力', [
        el('div', { class: 'list' }, rows),
        detailLines.length > 0
          ? el('div', { class: 'field-hint', text: detailLines.join('\n') })
          : null,
        el('div', {
          class: 'field-hint',
          text:
            '能力只能实测，不能按名字猜：同一个模型名在不同中转站可能完全不同。\n' +
            '「未测」不等于「不支持」——超时或网络错误也会导致没结论。',
        }),
      ]),
    );
  };

  /* ---- 初始渲染 ---- */

  if (local.picked) {
    renderCapabilityDetail(local.picked);
  } else {
    capabilityHost.replaceChildren(
      card('模型能力', [
        el('div', { class: 'muted', text: '先读取模型列表并选一个模型，再点「探测能力」。' }),
      ]),
    );
  }

  catalogHost.replaceChildren(renderCatalog());

  /* ============================================================ 第 5 步：超时 */

  const timeoutInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'number',
      class: 'text-input',
      // 草稿优先：用户改过但还没保存时，不能被快照里的旧值盖回去
      value: state.timeoutDraft ?? String(llm.timeoutMs ?? 60000),
      min: '5000',
      max: '300000',
      step: '1000',
    })
  );

  timeoutInput.addEventListener('input', () => {
    state.timeoutDraft = timeoutInput.value;
  });

  const timeoutField = el('div', { class: 'field-row' }, [
    el('label', { class: 'field-label', text: '超时（毫秒）' }),
    el('div', { class: 'field-control' }, [
      timeoutInput,
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: '保存',
          onclick: async () => {
            const r = await ctx.onSaveSetting('llm.timeoutMs', Number(timeoutInput.value));
            // 存住了就不需要草稿了，之后用快照的值
            if (r?.ok) state.timeoutDraft = null;
            say(
              r?.ok ? `✓ 超时已设为 ${timeoutInput.value} ms` : `保存失败：${r?.message ?? r?.code}`,
              r?.ok ? 'ok mono' : 'err mono',
            );
          },
        }),
      ]),
      el('div', {
        class: 'field-hint',
        text: '太短会让正常请求全超时（看起来像模型坏了）。建议 30000–120000。',
      }),
    ]),
  ]);

  /* ============================================================ 测试连接 */

  const testHost = el('div', {});
  const testBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: '测试连接',
    onclick: async () => {
      /*
       * 为什么这里要先把"请求中…"写进 DOM 再发请求。
       *
       * 原来的写法是：await ctx.onTest() → 拿到结果 → 才写 testHost。
       * 也就是说**请求期间那一块是空的**。而这个测试可能跑满 120 秒
       * 超时，用户看到的就是"点了没反应"。
       *
       * 正确的做法是先把状态画出来，再等结果。UI 必须在动作开始时就反馈，
       * 而不是等动作结束。
       */
      const out = el('div', { class: 'muted mono', text: '请求中…（最长等超时时间）' });
      testHost.replaceChildren(out);
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';

      try {
        const r = await ctx.onTest();
        if (r?.ok) {
          out.className = 'ok mono';
          out.textContent = `✓ 通了：${r.reply ?? ''}（${r.ms ?? '?'}ms，${r.model ?? ''}）`;
          // 只记结论；长句不持久化（状态行要一眼扫完）
          state.lastTest = { ok: true, at: Date.now() };
        } else {
          out.className = 'err mono';
          out.textContent = `✖ ${r?.code ?? 'E50XX'} ${r?.message ?? '失败'}`;
          state.lastTest = { ok: false, at: Date.now() };
        }
      } catch (err) {
        // ctx.onTest 抛异常（IPC 断了之类）也要让人看到，不能静默
        out.className = 'err mono';
        out.textContent = `✖ 请求失败：${String(err?.message ?? err)}`;
        state.lastTest = { ok: false, at: Date.now() };
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '测试连接';
        /*
         * 把「测试结果」那一行原地换掉。
         *
         * 那一行是本次渲染时按 state.lastTest 生成的节点，而结果是在
         * 这之后才拿到的 —— 不刷新它就会一直显示"未测试"，直到 2 秒后
         * 那次整页重绘才变。用户会以为测试没生效。
         *
         * 这里只替换那一行，不重绘整页：不打断输入、也不丢别处的状态。
         */
        const row = document.getElementById('test-result');
        const fresh = testResultCell();
        // testResultCell 返回的节点已经带同一个 id，直接替换即可
        row?.replaceWith(fresh);
      }
    },
  });

  /* ============================================================ 组装 */

  const stepNo = (n, title) => el('div', { class: 'step-title', text: `${n}. ${title}` });

  /**
   * 「测试结果」那一行的内容：药丸 + 具体信息。
   *
   * 只给一个"通过/失败"信息量不够——失败时用户最需要知道**为什么**失败
   * （603 超时？404 模型名？401 key 无效？）。所以药丸后面跟上原文。
   */
  function testResultCell() {
    const r = state.lastTest;
    if (!r) return el('span', { class: 'row', id: 'test-result' }, [pill('未测试', 'dim')]);
    /*
     * 这里只放结论，不放那一长串原文。
     *
     * 「通了：通了（2134ms，deepseek-v4.1-flash）」放在这一行会把它撑得很宽，
     * 也不该进"常驻状态"——状态行要一眼扫完。长句留在按钮下方那个临时区域，
     * 需要细节时看那里。
     */
    return el('span', { class: 'row', id: 'test-result' }, [
      pill(r.ok ? '通过' : '失败', r.ok ? 'ok' : 'err'),
    ]);
  }

  return el('div', { class: 'cols' }, [
    el('div', {}, [
      card('当前状态', [
        el('div', { class: 'list' }, [
          /*
           * 测试结果放在第一行。
           *
           * 为什么要有这一行：测试连接的结果原来只写在按钮下面的临时区域，
           * 那个区域 2 秒后就被重绘清掉，用户只看到一闪。
           * 这里把它变成一条常驻数据 —— 和「可否对话」「模型」平级，
           * 每次重绘都从 state.lastTest 画回来。
           */
          kv('测试结果', testResultCell()),
          kv('可否对话', configured ? pill('可以', 'ok') : pill('缺少 Key', 'warn')),
          kv('模型', llm.model || pill('未设置', 'warn')),
          kv('地址', llm.baseUrl || pill('未设置', 'warn')),
          kv(
            'Key',
            brain.keySource === 'vault'
              ? pill('已加密保存', 'ok')
              : brain.keySource === 'env'
                ? pill('环境变量', 'dim')
                : brain.keySource === 'config'
                  ? pill('配置文件（明文）', 'warn')
                  : brain.keySource === 'vault-broken'
                    ? pill('解不开，需重填', 'err')
                    : pill('未设置', 'dim'),
          ),
          kv('超时', `${llm.timeoutMs ?? '?'} ms`),
        ]),
        el('div', { class: 'spacer-10' }),
        testBtn,
        testHost,
      ]),
    ]),

    el('div', {}, [
      card('接入', [
        stepNo(1, '选择模型提供商'),
        providerCards,
        el('div', { class: 'field-hint', text: '点卡片选预设地址；「自定义第三方」可填任何 OpenAI 兼容地址。' }),
        el('div', { class: 'field-row step-inner' }, [
          el('label', { class: 'field-label', text: '接口地址' }),
          el('div', { class: 'field-control' }, [
            baseUrlInput,
            el('div', { class: 'row' }, [saveBaseUrlBtn]),
            el('div', {
              class: 'field-hint',
              text: '填到 /v1 即可，程序自己补 /chat/completions。填错的表现是连不上或 404。',
            }),
          ]),
        ]),

        el('div', { class: 'step-gap' }),
        stepNo(2, '输入 API Key'),
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: 'API Key' }),
          el('div', { class: 'field-control' }, [
            keyInput,
            el('div', { class: 'row' }, [saveKeyBtn, clearKeyBtn]),
            el('div', {
              class: 'field-hint',
              text:
                '用 Windows DPAPI 加密，只有当前 Windows 账户能解开。\n' +
                '不防"以你的身份运行的恶意程序"，这类防护超出本程序范围。',
            }),
          ]),
        ]),

        el('div', { class: 'step-gap' }),
        stepNo(3, '识别上游模型列表'),
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: '模型目录' }),
          el('div', { class: 'field-control' }, [
            el('div', { class: 'row' }, [loadBtn]),
            el('div', {
              class: 'field-hint',
              text: '请求服务商的 /models 接口，拿到它实际提供的模型。读不到时退回内置清单。',
            }),
          ]),
        ]),

        el('div', { class: 'step-gap' }),
        stepNo(4, '选择模型并探测能力'),
        catalogHost,

        el('div', { class: 'step-gap' }),
        stepNo(5, '调优（一般不用改）'),
        timeoutField,

        el('div', { class: 'spacer-10' }),
        msg,
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ 小工具 */

/** 前端侧的通道推断（与后端 inferChannel 保持一致的口径） */
function inferChannelLabel(model, caps) {
  const id = String(model ?? '').toLowerCase();
  if (caps?.vision === true) return { channel: 'multimodal', label: '多模态', basis: '已实测：可读图' };
  if (caps?.image === true) return { channel: 'imageGen', label: '生图', basis: '已实测：可生图' };

  // 实测否定过视觉的，名字再像也不能判成多模态
  const visionKnownFalse = caps?.vision === false;

  if (/embed|rerank/.test(id)) return { channel: 'embedding', label: '向量', basis: '名字含 embed/rerank' };
  if (/(dall-e|dalle|sdxl|flux|imagen|kolors)/.test(id)) {
    return { channel: 'imageGen', label: '生图', basis: '名字像生图模型' };
  }
  if (/whisper|tts|audio|speech/.test(id)) return { channel: 'audio', label: '音频', basis: '名字像音频模型' };
  if (!visionKnownFalse && /-vl-|-vision-|(^|[-_])vl($|[-_])/.test(id)) {
    return { channel: 'multimodal', label: '多模态（未实测）', basis: '名字含 vl/vision' };
  }
  if (visionKnownFalse) {
    return { channel: 'text', label: '文本', basis: '已实测：不支持图片（名字不足为凭）' };
  }
  return { channel: 'text', label: '文本', basis: '无多模态特征' };
}

/** 列表项上的短标签 */
function inferLabel(model, caps) {
  return inferChannelLabel(model, caps).label;
}
