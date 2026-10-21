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

/**
 * 探测状态的三态文案。
 *
 * 这三态必须分开显示，理由和能力的三态一样：
 *   - 未探测：还不知道，用户该去点按钮
 *   - 已探测：拿到了明确结论
 *   - 探测失败：请求没成 / 没测出结论，要去看地址和 Key
 *
 * 把"失败"显示成"未探测"会让人一直以为按钮没点；显示成"不支持"更糟，
 * 那会让人以为模型坏了。
 */
const PROBE_LABEL = { none: '未探测', ok: '已探测', fail: '探测失败' };
const PROBE_TONE = { none: 'dim', ok: 'ok', fail: 'err' };

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
 *   keyDraft: string,
 *   timeoutDraft: string|null,
 *   lastTest: { ok: boolean, at: number }|null,
 *   notice: { text: string, cls: string }|null,
 *   endpoint: string,
 *   catalogSource: 'none'|'remote',
 *   manualMode: boolean,
 *   manualModel: string,
 *   selectDraft: string,
 *   probeStatus: Record<string, { state: 'none'|'ok'|'fail', at: number, message: string, detail: string }>,
 *   lastProbe: { model: string, ok: boolean }|null,
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
  credentialRevision: 0,
  notice: null,
  endpoint: '',
  /**
   * 当前是否在看真实目录。
   *
   * 'remote' = 从服务商 /models 读到的
   * 'none'   = 还没读，或读失败 —— 这时只能手填模型名
   *
   * ## 为什么不再有"内置兜底清单"
   *
   * 原来读不到目录时会塞进一份写死的 deepseek 列表。那造成两个问题：
   *   1. 用户会以为这些模型是"当前服务商提供的"，照着选然后 404；
   *   2. 界面看起来永远有 DeepSeek 可选，像是默认值被写死了。
   * 现在读不到就老实说读不到，改成手填。
   *
   * @type {'none' | 'remote'}
   */
  catalogSource: 'none',
  catalogError: null,
  /**
   * 「手填模型名」模式。
   *
   * 目录读到了也可以切到它 —— 中转站常常有目录里没列出来、
   * 但实际能用的模型名。
   */
  manualMode: false,
  /**
   * 手填模型名的草稿。
   *
   * 和 keyDraft 同理：重绘会重建 input，值不存进模块状态就会丢。
   *
   * @type {string}
   */
  manualModel: '',
  /**
   * 下拉框里当前看的模型（**不等于已保存的 llm.model**）。
   *
   * 用户在下拉里换一个模型、还没点「用这个模型」时，不该被重绘打回旧值；
   * 探测之后也要停留在刚探测的那个模型上。
   *
   * @type {string}
   */
  selectDraft: '',
  /**
   * 每个模型的探测状态。
   *
   * 与 `probes`（探测明细）分开：这里只放界面上要显示的三态结论。
   *   none = 没点过
   *   ok   = 拿到了明确结论
   *   fail = 请求没成 / 没测出结论
   *
   * @type {Record<string, { state: 'none'|'ok'|'fail', at: number, message: string, detail: string }>}
   */
  probeStatus: {},
  /**
   * 最近一次探测的汇总，供「可否对话」判断。
   *
   * 只采纳**和已保存模型同一个**的探测结论：探测别的模型成功，
   * 说明这个中转站通，但不说明当前配置的模型能用。
   *
   * @type {{ model: string, ok: boolean } | null}
   */
  lastProbe: null,
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
  const llm = { ...(snap?.config?.llm ?? {}) };
  const brain = snap?.brain ?? {};
  let configured = Boolean(brain.configured);
  let capsAll = llm.modelCapabilities ?? {};
  if (state.endpoint !== (llm.baseUrl ?? '')) {
    state.endpoint = llm.baseUrl ?? '';
    /*
     * 换了服务地址，之前读到的一切都作废。
     *
     * 模型目录、探测结论、测试结果全都绑在**那一个端点**上：
     * 把 A 站的目录/结论留在界面上，用户会拿 B 站的 key 去选 A 站的模型，
     * 然后得到一个无法解释的 404。所以这里必须一起清掉。
     */
    state.catalog = null;
    state.catalogSource = 'none';
    state.catalogError = null;
    state.probes = {};
    state.probeStatus = {};
    state.lastProbe = null;
    state.selectDraft = '';
    state.manualMode = false;
    state.manualModel = '';
    state.lastTest = null;
  }

  // 用户没动过输入时，用快照刷新；动过就保留他的草稿
  if (!state.dirty) {
    state.provider = llm.provider || (llm.baseUrl ? 'custom' : 'deepseek');
    state.baseUrl = llm.baseUrl ?? '';
    state.picked = llm.model ?? '';
  }

  const local = state;
  const verificationScope = () => `${llm.baseUrl ?? ''}\n${llm.model ?? ''}\n${llm.thinking ?? 'openai'}\n${local.credentialRevision}`;
  const currentTest = () => local.lastTest?.scope === verificationScope() ? local.lastTest : null;
  const dialogueHost = el('span', { class: 'row', id: 'dialogue-state' });
  const testResultHost = el('span', { class: 'row', id: 'test-result' });
  const paintCurrentStatus = () => {
    const d = dialogueState();
    dialogueHost.replaceChildren(pill(d.label, d.tone), ...(d.why ? [el('span', { class: 'muted', text: d.why })] : []));
    const t = currentTest();
    testResultHost.replaceChildren(pill(t ? (t.ok ? '通过' : '失败') : '未测试', t ? (t.ok ? 'ok' : 'err') : 'dim'));
  };
  const invalidateVerification = () => {
    local.credentialRevision += 1;
    local.lastTest = null;
    local.lastProbe = null;
    local.probes = {};
    local.probeStatus = {};
    paintCurrentStatus();
  };

  const msg = el('div', { class: state.notice?.cls ?? 'muted mono', text: state.notice?.text ?? '', role: 'status' });
  const say = (text, cls = 'muted mono') => {
    state.notice = { text, cls };
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
              local.dirty = true;
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
            local.dirty = true;
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
      const providerResult = await ctx.onSaveSetting('llm.provider', local.provider);
      if (!providerResult?.ok) return say(`地址已保存，但提供商标记保存失败：${providerResult?.message ?? providerResult?.code}`, 'err mono');
      local.baseUrl = v;
      local.dirty = false;
      /*
       * 换了地址，之前那些"验证通过"就一文不值。
       *
       * 不清的话，「可否对话」会拿 A 站的成功结论替 B 站背书，
       * 用户就又回到"绿着但发不出消息"的状态。
       */
      if (local.endpoint !== v) {
        local.endpoint = v;
        local.catalog = null;
        local.catalogSource = 'none';
        local.catalogError = null;
        local.probes = {};
        local.probeStatus = {};
        local.lastProbe = null;
        local.lastTest = null;
        local.selectDraft = '';
        local.manualMode = false;
        local.manualModel = '';
        llm.baseUrl = v;
        capsAll = {};
      }
      paintCurrentStatus();
      paintCatalogStatus();
      rebuildStep4();
      renderCapabilityDetail(local.picked);
      say('✓ 地址已保存，请重新读取模型列表并探测', 'ok mono');
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
      configured = true;
      invalidateVerification();
      local.catalog = null;
      local.catalogSource = 'none';
      local.catalogError = null;
      capsAll = {};
      paintCatalogStatus();
      rebuildStep4();
      renderCapabilityDetail(local.selectDraft || local.picked);
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
          if (r?.ok) {
            state.keyDraft = ''; keyInput.value = ''; configured = false;
            invalidateVerification();
          }
          say(r?.message ?? (r?.ok ? '已清除 Key' : '清除失败'), r?.ok ? 'muted mono' : 'err mono');
        },
      })
    : null;

  /* ============================================================ 第 3 步：读目录 */

  const catalogHost = el('div', {});

  /*
   * 「模型目录」的状态行。
   *
   * 读成功 / 读失败都要有个常驻的结论，而不是只在按钮下面闪一句提示 ——
   * 提示会随着下一次重绘消失，用户回头看不到"到底读没读到"。
   */
  const catalogStatusCell = el('span', { class: 'row', 'data-catalog-status': '1' });
  const paintCatalogStatus = () => {
    catalogStatusCell.replaceChildren(
      local.catalogSource === 'remote'
        ? pill(`已读到 ${local.catalog?.length ?? 0} 个`, 'ok')
        : local.catalogError
          ? pill(local.catalogError.reason === 'empty_catalog' ? '目录为空' : '读取失败', 'warn')
          : pill('未读取', 'dim'),
    );
  };

  const loadBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: '读取模型列表',
    onclick: async () => {
      // 用闭包里的这个节点，不依赖 event.target —— 合成点击时它可能是 undefined
      loadBtn.disabled = true;
      say('正在读取模型列表…');
      try {
        const r = await ctx.onDetectModels();
        if (r?.ok && Array.isArray(r.models) && r.models.length > 0) {
          local.catalog = r.models;
          local.catalogSource = 'remote';
          local.catalogError = null;
          // 目录读到了就把手填模式让出来（用户想手填可以再点回去）
          local.manualMode = false;
          say(`✓ 读到 ${r.models.length} 个模型，请选一个再点「探测模型」`, 'ok mono');
        } else {
          /*
           * 读不到就**如实说读不到**。
           *
           * 这里原来会塞一份写死的 deepseek 清单当兜底，于是界面永远
           * 有模型可选、看起来"正常的"，用户选了才发现 404 —— 而真正
           * 的原因（地址或 Key 不对）被这层掩盖了。现在目录空着，
           * 直接把排查方向写出来。
           */
          local.catalog = null;
          local.catalogSource = 'none';
          local.manualMode = true;
          local.manualModel = local.manualModel || local.picked;
          local.catalogError = { reason: r?.reason ?? null, message: String(r?.message ?? r?.code ?? '未知错误') };
          say(
            r?.reason === 'empty_catalog'
              ? local.catalogError.message
              : `读取模型列表失败（${r?.message ?? r?.code ?? '未知'}）。请检查接口地址与 API Key，或改用手填模型名`,
            'err mono',
          );
        }
        paintCatalogStatus();
        catalogHost.replaceChildren(renderCatalog());
      } catch (err) {
        local.catalog = null;
        local.catalogSource = 'none';
        local.manualMode = true;
        local.catalogError = { reason: null, message: String(err?.message ?? err) };
        say(`读取模型列表失败：${local.catalogError.message}。请检查接口地址与 API Key`, 'err mono');
        paintCatalogStatus();
        catalogHost.replaceChildren(renderCatalog());
      } finally {
        loadBtn.disabled = false;
      }
    },
  });

  /* ============================================================ 第 4 步：选模型 + 能力 */

  /**
   * 某个模型现在显示的探测状态。
   *
   * 优先用本次会话的探测结果；没有就看配置里有没有落过盘（跨重启保留）。
   *
   * @param {string} modelId
   * @returns {'none'|'ok'|'fail'}
   */
  const probeStateOf = (modelId) => {
    const s = local.probeStatus[modelId];
    if (s) return s.state;
    const saved = capsAll[modelId];
    if (!saved?.probedAt) return 'none';
    /*
     * 落了盘也算"探过"，但要看结论：
     * 视觉或生图任一有明确布尔值 = 拿到了结论；否则只说明请求跑过、
     * 没测出来（E3012 / E404 之类），那仍然是"探测失败"。
     */
    const latest = saved.probes ? Object.values(saved.probes) : [];
    if (latest.length) return latest.some((p) => typeof p?.supported === 'boolean') ? 'ok' : 'fail';
    return typeof saved.vision === 'boolean' || typeof saved.image === 'boolean' ? 'ok' : 'fail';
  };

  /** 探测失败时的原因，取自最近一次结果或落盘的明细 */
  const probeMessageOf = (modelId) => {
    const s = local.probeStatus[modelId];
    if (s?.message) return s.message;
    const saved = capsAll[modelId];
    const p = saved?.probes;
    if (!p) return '';
    const first = p.vision?.detail || p.image?.detail || '';
    return first ? String(first).slice(0, 120) : '';
  };

  /**
   * 探测状态药丸。
   *
   * 三态必须分开：未探测（还没点）、已探测（拿到结论）、
   * 探测失败（请求没成，要去看地址和 Key）。
   *
   * @param {string} modelId
   */
  const probePill = (modelId) => {
    const st = probeStateOf(modelId);
    return pill(PROBE_LABEL[st], PROBE_TONE[st]);
  };

  /**
   * 「探测状态」整行。
   *
   * 三态之外还要给下一步动作，否则用户看到红字也不知道该改什么：
   *   未探测 → 提示去点按钮
   *   已探测 → 只有结论，不用多说
   *   探测失败 → 直接指出"检查接口地址与 API Key"
   *
   * @param {string} modelId
   */
  const probeRow = (modelId) => {
    const st = probeStateOf(modelId);
    const kids = [el('span', { class: 'muted', text: '探测状态' }), probePill(modelId)];
    if (st === 'none') {
      kids.push(el('span', { class: 'muted', text: '先点「探测模型」' }));
    } else if (st === 'fail') {
      kids.push(el('span', { class: 'err', text: '检查接口地址与 API Key' }));
    }
    return el('div', { class: 'row wrap', 'data-probe-row': '1' }, kids);
  };

  const renderCatalog = () => {
    const list = Array.isArray(local.catalog) ? local.catalog : [];
    const selectId = local.selectDraft || local.picked;
    const useManual = local.manualMode || list.length === 0;

    /* ---------------- 手填模式 ---------------- */

    if (useManual) {
      const manualInput = /** @type {HTMLInputElement} */ (
        el('input', {
          type: 'text',
          class: 'text-input',
          placeholder: '例如 deepseek-chat（填服务商文档里写的名字）',
          autocomplete: 'off',
          spellcheck: false,
          value: local.manualModel || local.picked || '',
        })
      );
      manualInput.addEventListener('input', () => {
        local.manualModel = manualInput.value.trim();
        // 输入变化立即更新当前模型的能力和探测状态。
        local.selectDraft = local.manualModel;
        renderCapabilityDetail(local.manualModel);
        const row = catalogHost.querySelector('[data-probe-row]');
        if (row) row.replaceWith(probeRow(local.manualModel));
      });

      const current = () => (manualInput.value || local.manualModel || '').trim();

      const applyBtn = el('button', {
        class: 'btn',
        type: 'button',
        text: '用这个模型',
        onclick: async () => {
          const v = current();
          if (!v) return say('先填模型名', 'err mono');
          const r = await ctx.onSaveSetting('llm.model', v);
          if (!r?.ok) return say(`保存失败：${r?.message ?? r?.code}`, 'err mono');
          local.picked = v;
          llm.model = v;
          paintCurrentStatus();
          local.selectDraft = v;
          local.manualModel = v;
          say(`✓ 已切换到 ${v}`, 'ok mono');
          catalogHost.replaceChildren(renderCatalog());
        },
      });

      const probeBtn = el('button', {
        class: 'btn',
        type: 'button',
        text: '探测模型',
        title: '会发一次极小的真实请求（一张 64×64 图片 / 一次 1 张生图），消耗极少额度',
        onclick: async () => {
          const model = current();
          if (!model) return say('先填模型名，再点「探测模型」', 'err mono');
          probeBtn.disabled = true;
          say(`正在探测 ${model}（会发真实请求，约几秒）…`);
          try {
            await runProbe(model);
          } finally {
            probeBtn.disabled = false;
          }
        },
      });

      /*
       * 主按钮只有一个（和下拉模式同一套规则）：
       * 名字还没保存 → 「用这个模型」；已保存但没验证 → 「探测模型」。
       */
      const paintBtnTone = () => {
        const v = current();
        const saved = Boolean(v) && v === local.picked;
        const verified = saved && probeStateOf(v) === 'ok';
        applyBtn.className = `btn${saved ? '' : ' btn-primary'}`;
        probeBtn.className = `btn${saved && !verified ? ' btn-primary' : ''}`;
      };
      paintBtnTone();
      manualInput.addEventListener('input', paintBtnTone);

      return el('div', {}, [
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: '模型（手填）' }),
          el('div', { class: 'field-control' }, [
            manualInput,
            el('div', { class: 'row' }, [applyBtn, probeBtn]),
            probeRow(local.selectDraft || local.picked || ''),
            (() => {
              const m = probeMessageOf(local.selectDraft || local.picked || '');
              return m ? el('div', { class: 'field-hint err', text: m }) : null;
            })(),
            el('div', {
              class: 'field-hint',
              text:
                local.catalogError?.reason === 'empty_catalog'
                  ? '服务商的 /models 返回了空目录。请在服务商控制台检查令牌分组与模型权限；也可手填已确认可用的模型名。'
                  : list.length === 0
                    ? '先点上方「读取模型列表」。若服务商不提供目录，也可手填其文档中的模型名。'
                    : '中转站常有目录里没列的模型名，可以直接填。',
            }),
          ]),
        ]),
        capabilityHost,
      ]);
    }

    /* ---------------- 目录下拉模式 ---------------- */

    // 当前值不在列表里：补一项，否则下拉会跳到第一项，用户以为模型被偷改了
    const hasCurrent = list.some((m) => m.id === selectId);
    const merged = hasCurrent || !selectId
      ? list
      : [{ id: selectId, channel: null, channelLabel: '当前值', basis: '不在目录里' }, ...list];

    const select = /** @type {HTMLSelectElement} */ (el('select', { class: 'text-input' }));
    for (const m of merged) {
      const caps = local.probes[m.id]?.caps ?? capsAll[m.id] ?? {};
      const ch = local.probes[m.id] || caps.probedAt ? inferLabel(m.id, caps) : (m.channelLabel ?? inferLabel(m.id, caps));
      const flags = [];
      if (caps.vision === true) flags.push('读图✓');
      if (caps.vision === false) flags.push('读图✗');
      if (caps.image === true) flags.push('生图✓');
      const st = probeStateOf(m.id);
      if (st === 'fail') flags.push('探测失败');
      const tail = flags.length ? ` · ${flags.join(' ')}` : '';
      select.appendChild(el('option', { value: m.id, text: `${m.id}｜${ch}${tail}` }));
    }
    select.value = selectId || merged[0]?.id || '';

    /*
     * 下拉一变就记进 selectDraft。
     *
     * 不记的话，2 秒一次的整页重绘会用回 local.picked —— 用户刚选中的
     * 模型跳回旧的，接着「探测」就探了另一个模型。这正是"点了探测模型、
     * 选模型部分没更新"的一半原因。
     */
    select.addEventListener('change', () => {
      local.selectDraft = select.value;
      renderCapabilityDetail(select.value);
      const row = catalogHost.querySelector('[data-probe-row]');
      if (row) row.replaceWith(probeRow(select.value));
      paintBtnTone();
    });

    const applyBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: '用这个模型',
      onclick: async () => {
        const v = select.value;
        const r = await ctx.onSaveSetting('llm.model', v);
        if (!r?.ok) return say(`保存失败：${r?.message ?? r?.code}`, 'err mono');
        local.picked = v;
        llm.model = v;
        paintCurrentStatus();
        local.selectDraft = v;
        say(`✓ 已切换到 ${v}`, 'ok mono');
        catalogHost.replaceChildren(renderCatalog());
      },
    });

    const manualBtn = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: '手填',
      title: '目录里没有想要的模型时，直接填名字',
      onclick: () => {
        local.manualMode = true;
        local.manualModel = select.value || local.picked || '';
        catalogHost.replaceChildren(renderCatalog());
      },
    });

    const probeBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: '探测模型',
      title: '会发一次极小的真实请求（一张 64×64 图片 / 一次 1 张生图），消耗极少额度',
      onclick: async () => {
        const model = select.value;
        if (!model) return say('先选一个模型', 'err mono');
        probeBtn.disabled = true;
        say(`正在探测 ${model}（会发真实请求，约几秒）…`);
        try {
          await runProbe(model);
        } finally {
          probeBtn.disabled = false;
        }
      },
    });

    /*
     * 主按钮只有一个。
     *
     * 三步是递进的：选模型 → 保存 → 探测。所以：
     *   - 选择还没保存 → 「用这个模型」是主按钮
     *   - 已保存但没探测过 / 探测失败 → 「探测模型」是主按钮
     *   - 两个都做完了 → 都退成普通按钮
     *
     * 原来两个都写死 btn-primary，一屏两个蓝按钮，看不出下一步该点哪个。
     */
    const paintBtnTone = () => {
      const saved = select.value === local.picked;
      const verified = saved && probeStateOf(select.value) === 'ok';
      applyBtn.className = `btn${saved ? '' : ' btn-primary'}`;
      probeBtn.className = `btn${saved && !verified ? ' btn-primary' : ''}`;
    };
    paintBtnTone();

    const msgLine = probeMessageOf(select.value);

    return el('div', {}, [
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field-label', text: '模型' }),
        el('div', { class: 'field-control' }, [
          select,
          el('div', { class: 'row' }, [applyBtn, probeBtn, manualBtn]),
          probeRow(select.value),
          msgLine ? el('div', { class: 'field-hint err', text: msgLine }) : null,
          el('div', {
            class: 'field-hint',
            text: '先选模型，再点「探测模型」—— 探测前不知道它能不能读图 / 生图。',
          }),
        ]),
      ]),
      capabilityHost,
    ]);
  };

  /**
   * 执行一次探测，并把三态结论写到界面上。
   *
   * 抽成一个函数，是因为手填模式和下拉模式都要用它，而这段逻辑
   * （成功 / 失败 / 抛异常）以前散在按钮回调里，改一处漏一处。
   *
   * @param {string} modelId
   */
  const runProbe = async (modelId) => {
    /** @type {any} */
    let r = null;
    try {
      r = await ctx.onProbe(modelId, ['vision', 'image']);
    } catch (err) {
      r = { ok: false, code: 'E50XX', message: String(/** @type {any} */ (err)?.message ?? err) };
    }

    if (!r?.ok) {
      const message = String(r?.message ?? r?.code ?? '未知错误');
      local.probeStatus[modelId] = { state: 'fail', at: Date.now(), message, detail: message };
      local.lastProbe = { model: modelId, ok: false };
      say(`探测失败：${message}。请检查接口地址与 API Key`, 'err mono');
    } else {
      local.probes[modelId] = { caps: r.caps, probes: r.probes };
      local.selectDraft = modelId;

      const v = r.probes?.vision;
      const g = r.probes?.image;
      const known = typeof v?.supported === 'boolean' || typeof g?.supported === 'boolean';
      const reason = [v, g]
        .filter((x) => x && x.supported !== true && x.detail)
        .map((x) => String(x.detail).slice(0, 120))
        .join('；');

      local.probeStatus[modelId] = {
        state: known ? 'ok' : 'fail',
        at: Date.now(),
        message: known ? '' : reason || '没测出结论',
        detail: reason,
      };
      local.lastProbe = { model: modelId, ok: known };

      const fmt = (x) => (x?.supported === true ? '✓ 支持' : x?.supported === false ? '✗ 不支持' : '没测出来');
      say(
        known
          ? `✓ 已探测 ${modelId}｜读图：${fmt(v)}｜生图：${fmt(g)}｜通道：${r.channel?.label ?? '-'}`
          : `探测失败：没能得到结论（${reason || '超时或网络错误'}）。请检查接口地址与 API Key`,
        known ? 'ok mono' : 'err mono',
      );
    }

    /*
     * 探测之后**必须重建第 4 步整块**。
     *
     * 原来只替换了下拉（catalogHost.replaceChildren(renderCatalog())），
     * 但下拉里的每项文字（读图✓ / 探测失败）和能力详情都是按探测结果
     * 现算的 —— 不重建就还是旧文案。用户看到的就是"点了探测，选择模型
     * 那部分没更新"。
     */
    rebuildStep4();
    renderCapabilityDetail(modelId);
  };

  /** 选中模型变化时，能力卡片要跟着换 */
  const rebuildStep4 = () => {
    catalogHost.replaceChildren(renderCatalog());
  };


  /* ---- 能力详情 ---- */

  const capabilityHost = el('div', {});

  const renderCapabilityDetail = (modelId) => {
    const p = local.probes[modelId];
    const caps = p?.caps ?? capsAll[modelId] ?? {};
    const ch = inferChannelLabel(modelId, caps);
    const st = probeStateOf(modelId);

    /** 三态渲染：true/false/null 必须分别显示 */
    const tri = (v, yesText, noText) => {
      if (v === true) return pill(yesText, 'ok');
      if (v === false) return pill(noText, 'err');
      return pill('未测', 'dim');
    };

    /*
     * 还没探测时，这张卡片顶部就必须有一句"去点探测"。
     *
     * 否则打开页面看到的是一张填满「未测」的表 —— 用户不知道该先点按钮，
     * 容易以为"这个模型什么都不支持"。这正是要在探测之前先提示的原因。
     */
    const prompt =
      st === 'none'
        ? el('div', { class: 'field-hint' }, [
            el('strong', { text: `还没探测 ${modelId}。` }),
            el('span', { text: '点上方「探测模型」才知道它到底能不能读图 / 生图。' }),
          ])
        : null;

    const rows = [
      kv('探测状态', pill(PROBE_LABEL[st], PROBE_TONE[st])),
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
      const r = (p?.probes ?? caps.probes)?.[k];
      if (r && r.supported !== true && r.detail) {
        detailLines.push(`${label}：${r.detail}`);
      }
    }
    const sessionMsg = local.probeStatus[modelId]?.message;
    if (sessionMsg && !detailLines.some((l) => l.includes(sessionMsg))) detailLines.push(sessionMsg);

    capabilityHost.replaceChildren(
      card('模型能力', [
        prompt,
        el('div', { class: 'list' }, rows),
        detailLines.length > 0
          ? el('div', { class: 'field-hint err', text: detailLines.join('\n') })
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

  paintCatalogStatus();

  // 用 selectDraft：用户可能刚在下拉里换了一个但还没保存，重绘不该把它打回去
  const initialModel = local.selectDraft || local.picked;
  if (initialModel) {
    renderCapabilityDetail(initialModel);
  } else {
    capabilityHost.replaceChildren(
      card('模型能力', [
        el('div', { class: 'muted', text: '先读取模型列表（或手填模型名）并选中一个模型，再点「探测模型」。' }),
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

  /*
   * 思考内容（reasoning）的开启方式。
   *
   * 放这里的原因：它属于"换模型之后才需要动"的开关，不是必填项。
   * 但必须能在界面上改 —— 否则"思考链路突然空了"只能靠改代码解决。
   *
   * 默认 openai（请求体加 reasoning_effort:"medium"）。这是最通用的写法，
   * 推理模型按中等强度思考，非推理模型多数直接忽略。选中后写进配置。
   * 顺序上把默认值放第一项：用户点开时看到的就是当前在用的那个。
   */
  const THINKING_OPTIONS = [
    ['openai', 'OpenAI 风格 reasoning_effort（默认）', '请求体加 reasoning_effort:"medium"。最通用，推荐先用这个。'],
    ['auto', '自动（不加任何字段）', '适合上游默认就返回 reasoning 的情况。若报 400 说字段不认识，切这个。'],
    ['deepseek', 'DeepSeek 风格 thinking', '请求体加 thinking:{type:"enabled"}。'],
    ['qwen', '通义风格 enable_thinking', '请求体加 enable_thinking:true。'],
    ['anthropic', 'Anthropic 风格 thinking+budget', '请求体加 thinking:{type,budget_tokens}。'],
    ['off', '不注入思考参数', '不添加思考控制字段；若上游默认返回 reasoning，仍会记录。'],
  ];

  const thinkingSelect = /** @type {HTMLSelectElement} */ (el('select', { class: 'text-input' }));
  const currentThinking = String(llm.thinking ?? 'openai');
  if (!THINKING_OPTIONS.some(([v]) => v === currentThinking)) {
    // 配置里出现了未知值：仍然列出来，否则下拉框会静默显示成第一项，看着像"设错了"
    thinkingSelect.appendChild(el('option', { value: currentThinking, text: `${currentThinking}（未识别）` }));
  }
  for (const [value, label] of THINKING_OPTIONS) {
    thinkingSelect.appendChild(el('option', { value, text: label }));
  }
  thinkingSelect.value = currentThinking;

  const thinkingHint = el('div', {
    class: 'field-hint',
    text: THINKING_OPTIONS.find(([v]) => v === currentThinking)?.[2] ?? '',
  });
  thinkingSelect.addEventListener('change', () => {
    thinkingHint.textContent = THINKING_OPTIONS.find(([v]) => v === thinkingSelect.value)?.[2] ?? '';
  });

  const thinkingField = el('div', { class: 'field-row' }, [
    el('label', { class: 'field-label', text: '思考内容' }),
    el('div', { class: 'field-control' }, [
      thinkingSelect,
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: '保存',
          onclick: async () => {
            const r = await ctx.onSaveSetting('llm.thinking', thinkingSelect.value);
            if (r?.ok && llm.thinking !== thinkingSelect.value) {
              llm.thinking = thinkingSelect.value;
              invalidateVerification();
            }
            say(
              r?.ok
                ? `✓ 思考开关已设为 ${thinkingSelect.value}`
                : `保存失败：${r?.message ?? r?.code}`,
              r?.ok ? 'ok mono' : 'err mono',
            );
          },
        }),
      ]),
      thinkingHint,
      el('div', {
        class: 'field-hint',
        text:
          '换模型后「思考链路」不再出现新记录时，先看这里。\n' +
          '模型本身是推理模型、但中转要求显式打开时才返回 reasoning —— 选对应风格即可。',
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

      const scope = verificationScope();
      try {
        const r = await ctx.onTest();
        if (r?.ok) {
          out.className = 'ok mono';
          out.textContent = `✓ 通了：${r.reply ?? ''}（${r.ms ?? '?'}ms，${r.model ?? ''}）`;
          // 只记结论；长句不持久化（状态行要一眼扫完）
          state.lastTest = { ok: true, at: Date.now(), scope };
        } else {
          out.className = 'err mono';
          out.textContent = `✖ ${r?.code ?? 'E50XX'} ${r?.message ?? '失败'}`;
          state.lastTest = { ok: false, at: Date.now(), scope };
        }
      } catch (err) {
        // ctx.onTest 抛异常（IPC 断了之类）也要让人看到，不能静默
        out.className = 'err mono';
        out.textContent = `✖ 请求失败：${String(err?.message ?? err)}`;
        state.lastTest = { ok: false, at: Date.now(), scope };
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
        paintCurrentStatus();
      }
    },
  });

  /* ============================================================ 组装 */

  const stepNo = (n, title) => el('div', { class: 'step-title', text: `${n}. ${title}` });

  /**
   * 「可否对话」的真实状态。
   *
   * ## 原来错在哪
   *
   * 原来是 `configured ? 可以 : 缺少 Key` —— 只要保险箱里有一把 key
   * 就永远是绿的。可"填了 key"和"能对话"是两件事：地址写错、模型名
   * 不存在、key 限流，全都表现为绿的「可以」，然后在 QQ 里发消息没反应。
   *
   * ## 现在的判据
   *
   * 先检查 Key、模型、地址，再采用当前配置最近一次文本对话测试。
   * 切换模型、地址或凭据后需要重新验证；图像能力结论只用于能力标签。
   * 没有匹配的文本测试结果时显示「未验证」。
   *
   * 第 4 种必须单独一态：什么都没试过就显示"可以"正是这个 bug 的来源，
   * 而显示"不可以"又太绝对 —— 它可能完全正常，只是没人测过。
   *
   * @returns {{ label: string, tone: 'ok'|'warn'|'err'|'dim', why: string }}
   */
  function dialogueState() {
    const model = llm.model || '';
    if (!configured) {
      return { label: '缺少 Key', tone: 'warn', why: '先在下面第 2 步填 API Key' };
    }
    if (!model) {
      return { label: '缺少模型', tone: 'warn', why: '先在第 4 步选一个模型' };
    }
    if (!llm.baseUrl) {
      return { label: '缺少地址', tone: 'warn', why: '先在第 1 步填接口地址' };
    }

    // 图像能力结论不证明文本对话可用。只采用当前配置的真实对话测试。
    const verified = currentTest();
    if (verified) {
      return verified.ok
        ? { label: '可以', tone: 'ok', why: '测试连接已通过' }
        : { label: '不可以', tone: 'err', why: '测试连接失败，见测试结果' };
    }

    // 4. 有 key 有模型，但没人验过
    return { label: '未验证', tone: 'warn', why: '' };
  }

  paintCurrentStatus();

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
          kv('测试结果', testResultHost),
          /*
           * 「可否对话」必须反映**真实可用性**，不能只看有没有 key。
           *
           * 原样是 configured ? 可以 : 缺少 Key，于是一把填错的 key 也让
           * 它常年显示绿的「可以」。三种状态的分法见 dialogueState()。
           */
          kv('可否对话', dialogueHost),
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
            el('div', { class: 'row' }, [loadBtn, catalogStatusCell]),
            el('div', {
              class: 'field-hint',
              text:
                '请求服务商的 /models 接口，拿到它实际提供的模型。\n' +
                '读不到就如实空着，不塞内置清单——那会让人以为这些模型是服务商提供的。',
            }),
          ]),
        ]),

        el('div', { class: 'step-gap' }),
        stepNo(4, '选择模型并探测能力'),
        catalogHost,

        el('div', { class: 'step-gap' }),
        stepNo(5, '调优（一般不用改）'),
        timeoutField,
        thinkingField,

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
