/**
 * 联网搜索设置区块渲染 —— 六态文案、开关/模式写入、试搜调用与密钥不回显
 *
 * ## 它现在渲染在哪里
 *
 * 不再是独立侧栏页：`ui/src/views/plugins.mjs` 在选中 `web-search` 插件后，
 * 会把 `renderNetworkSection(snap, ctx)` 追加到插件详情下方。所以这里的断言
 * 仍针对这个区块本身，同时另有 `plugins-core` 覆盖"它确实被挂进插件页"。
 *
 * ## 为什么这一块值得单独测
 *
 * 它最容易出的不是"画不出来"，而是**画对了但语义是错的**：
 *
 *   · 把「没配 Key」显示成「不可用」—— 用户会去开总闸，而问题在插件配置
 *   · 把「后端没给数据」显示成「已关闭」—— 用户会点一个已经开着的开关
 *   · 试搜按钮绕开宿主自己发 HTTP —— 那条路没有总闸、没有 URL 限制
 *   · 页面上回显 Key —— 界面快照里本来就不该有它
 *
 * 所以这里的断言全是**语义**：文本含什么、点一下发的是哪个调用、什么不该出现。
 *
 * ## DOM 桩与假桥的顺序
 *
 * `api.mjs` 在**模块求值那一刻**就把 `globalThis.ling` 抓进常量，所以
 * 假桥必须在 import 页面模块之前装好。这里用顶层 await 保证顺序。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------ DOM 桩 */

/**
 * 最小 DOM 元素。
 *
 * 只实现页面真正会用到的方法：append / replaceChildren / setAttribute /
 * addEventListener / dataset / textContent / value / checked / hidden / disabled。
 * 多实现反而会掩盖"页面用了某个桩不支持的 API"这类问题 ——
 * 那种问题在真实浏览器里不报错，但在测试里会。
 */
class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }

  addEventListener(key, fn) {
    this.listeners[key] = fn;
  }
}

/** 装 DOM 桩，返回还原函数 */
function installDom() {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (t) => ({ textContent: String(t) }),
  };
  return () => {
    globalThis.document = prev;
  };
}

/* ------------------------------------------------------------ 假桥 */

/**
 * 桥接应答。
 *
 * 必须在 api.mjs 求值前存在（见文件头），所以做成模块级可变引用。
 *
 * @type {{ calls: Array<{method: string, params: any}>, reply: (method: string, params: any) => any }}
 */
const bridge = {
  calls: [],
  reply: () => ({ ok: true }),
};

globalThis.ling = {
  invoke: async (method, params) => {
    bridge.calls.push({ method, params });
    return bridge.reply(method, params);
  },
};

/** 清空调用记录并换应答 */
function resetBridge(reply = () => ({ ok: true })) {
  bridge.calls.length = 0;
  bridge.reply = reply;
}

/** 等一轮宏任务，让 `void save(...)` / `void runSearch()` 的 Promise 链跑完 */
const flush = () => new Promise((r) => setTimeout(r, 0));

// 必须在 globalThis.ling 装好之后才 import 页面模块
const { renderNetworkSection, resetWebSearchPageState } = await import('../ui/src/views/web-search.mjs');
const { renderPlugins, _resetPluginUiForTest } = await import('../ui/src/views/plugins.mjs');

/* ------------------------------------------------------------ 遍历工具 */

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const c of node.children ?? []) walk(c, out);
  return out;
}

function allText(node) {
  return walk(node)
    .map((n) => n.textContent ?? '')
    .filter(Boolean)
    .join('\n');
}

function button(node, label) {
  return walk(node).find((n) => n.tagName === 'BUTTON' && n.textContent === label);
}

function checkbox(node) {
  return walk(node).find((n) => n.tagName === 'INPUT' && n.attributes?.type === 'checkbox');
}

function inputByType(node, type) {
  return walk(node).find((n) => n.tagName === 'INPUT' && n.attributes?.type === type);
}

/** 所有单选框（模式三态用） */
function radios(node) {
  return walk(node).filter((n) => n.tagName === 'INPUT' && n.attributes?.type === 'radio');
}

function radioByValue(node, value) {
  return radios(node).find((n) => n.value === value);
}

/** 页面上的服务商下拉 */
function selectNode(node) {
  return walk(node).find((n) => n.tagName === 'SELECT');
}

/**
 * 抽出所有 kv 行（[键文本, 值文本]）。
 *
 * 为什么不直接断言整段文本：`4` 这种数字在页面上到处都是，
 * 只有"这一行的键就是那个标签、值就是那个数"才算真的回显对了。
 */
function kvPairs(node) {
  const out = [];
  for (const n of walk(node)) {
    if (n.className !== 'kv') continue;
    const k = (n.children ?? []).find((c) => c.className === 'k');
    const v = (n.children ?? []).find((c) => c.className === 'v');
    out.push([k?.textContent ?? '', v ? allText(v) : '']);
  }
  return out;
}

/** 找某个文字的药丸，返回它的 class（用来断言五态/六态色调真的不同） */
function pillClass(node, label) {
  const hit = walk(node).find(
    (n) => typeof n.className === 'string' && /pill pill-/.test(n.className) && n.textContent === label,
  );
  return hit?.className ?? '';
}

/**
 * `native` 块的默认形状（契约 §6 扩展）。
 *
 * 默认是"选了原生但还没配好"之外的最保守组合：未选择服务商、无上次记录。
 * 每个用例只覆盖自己关心的字段。
 *
 * @param {object} [overrides]
 */
function nativeView(overrides = {}) {
  return {
    provider: '',
    providerLabel: '未选择',
    providerKnown: true,
    protocol: '智谱 GLM · Chat Completions tools[type=web_search]',
    active: false,
    configured: false,
    evidence: { structured: false, inlineRefs: false, toolEvent: false },
    offPolicy: {
      explicit: true,
      text: '关闭后 Ling-bot 不再发送任何联网声明/工具；但服务商是否仍在其服务端自行检索无法验证。',
    },
    limitsText: '单次最多 5 条来源；不保证模型一定引用。',
    last: null,
    stats: { requests: 0, evidence: 0, noEvidence: 0, rejected: 0, lastAt: null },
    ...overrides,
  };
}

/**
 * 一份贴契约 §6 形状的联网状态。
 *
 * 默认是"一切正常"（on / api）。每个用例只覆盖自己关心的字段。
 *
 * @param {object} [overrides]
 */
function netView(overrides = {}) {
  return {
    enabled: true,
    mode: 'api',
    effectiveMode: 'api',
    provider: 'tavily',
    baseUrl: 'https://api.tavily.com',
    maxResults: 5,
    timeoutMs: 15_000,
    searchDepth: 'basic',
    allowFetch: true,
    maxFetchBytes: 204_800,
    fetchTimeoutMs: 10_000,
    configured: true,
    native: nativeView(),
    plugin: { id: 'web-search', enabled: true, status: 'ready', configured: true },
    effective: 'on',
    effectiveText: '搜索与网页读取都可用（只对管理员私聊与桌面端开放）。',
    effectivePill: '搜索可用',
    effectiveTone: 'ok',
    tools: ['plugin_web_search', 'plugin_web_fetch'],
    stats: {
      searches: 3,
      fetches: 1,
      failures: 1,
      cancelled: 0,
      lastAt: 1_760_000_000_000,
      lastError: { code: 'E4086', message: '上游故障', at: 1_760_000_000_000 },
    },
    ...overrides,
  };
}

/** 用一份快照渲染，自动装/还原 DOM 桩 */
function render(network) {
  const restore = installDom();
  try {
    resetWebSearchPageState();
    return renderNetworkSection({ network }, {});
  } finally {
    restore();
  }
}

/* ------------------------------------------------------------ 渲染与四态 */

test('★ 空快照也能渲染出页面（不白屏），并明确说"后端没给状态"', () => {
  /*
   * 首帧 / 老后端时 network 块整个不存在。这时必须渲染出一个结构完整的页面，
   * 而不是抛异常白屏；同时要**明说**"没有数据"，不能假装知道状态。
   */
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({}, {});
    assert.ok(node, '必须返回节点');
    const text = allText(node);
    assert.match(text, /实际效果/, '缺实际效果块');
    assert.match(text, /总开关|总闸/, '缺开关块');
    assert.match(text, /后端未提供联网状态/, '缺数据时要明说，不能假装知道');
    assert.match(text, /试搜/, '缺试搜块');
    assert.match(text, /运行统计/, '缺统计块');
  } finally {
    restore();
  }
});

test('★ 四态各自显示自己的结论（不合并成一句"不可用"）', () => {
  const cases = [
    ['off', /总开关关着|联网已关闭/],
    ['no-plugin', /插件没有启用|插件未启用/],
    ['needs-config', /缺 API Key|未就绪|缺配置/],
    ['on', /可用/],
  ];
  for (const [effective, re] of cases) {
    const node = render(netView({ effective }));
    assert.match(allText(node), re, `${effective} 态的文案不对`);
  }
});

test('★ 快照说 off 时，工具列表必须显示"模型看不到搜索工具"', () => {
  const node = render(netView({ effective: 'off', enabled: false, tools: [] }));
  const text = allText(node);
  assert.match(text, /没有（模型看不到搜索工具）/);
  assert.doesNotMatch(text, /plugin_web_search/);
});

test('★ 快照里给了 tools 时原样列出（界面不自作主张推导可见性）', () => {
  const node = render(netView());
  const text = allText(node);
  assert.match(text, /plugin_web_search/);
  assert.match(text, /plugin_web_fetch/);
});

test('服务配置只读回显：provider / 地址 / 条数 / 深度 / 超时', () => {
  const node = render(netView({ maxResults: 8, timeoutMs: 20_000, searchDepth: 'advanced' }));
  const text = allText(node);
  assert.match(text, /tavily/);
  assert.match(text, /api\.tavily\.com/);
  assert.match(text, /8/);
  assert.match(text, /advanced/);
  // 超时以"秒"显示（20 秒），而不是裸毫秒
  assert.match(text, /20 秒/);
});

test('★ 密钥只显示"已保存 / 未保存"，永不显示明文', () => {
  const secret = 'tvly-SHOULD-NEVER-APPEAR-IN-UI';
  const node = render(netView({ configured: true }));
  const text = allText(node);
  assert.match(text, /已保存/);
  assert.equal(text.includes(secret), false);
  // 快照里就算带了 apiKey 字段，页面也不该把它画出来
  const node2 = render(netView({ apiKey: secret, configured: true }));
  assert.equal(allText(node2).includes(secret), false, '页面不得回显快照里的密钥字段');
  /*
   * 原生联网同样可能带一把 provider Key（服务商自己的）。它也不该出现在页面上：
   * 这一页连"已配置"都要从后端给的布尔值读，更不该自己拼一个 Key 出来。
   */
  const node3 = render(netView({
    effective: 'native',
    mode: 'native',
    effectiveMode: 'native',
    native: nativeView({ provider: 'zhipu', providerLabel: '智谱 GLM', configured: true, apiKey: secret }),
  }));
  const text3 = allText(node3);
  // 值必须是"已适配"（后端 configured 的语义是"服务商已适配"），页面不能出现那把 Key
  assert.equal(kvPairs(node3).find(([k]) => k === '是否已适配')?.[1], '已适配');
  assert.equal(text3.includes(secret), false, '原生联网块也不能回显密钥');
});

test('★ 总开关文案要说清"只管 Ling-bot 自己发起的联网"', () => {
  /*
   * 这是契约 §0 的硬要求。用户关掉开关后看到模型"好像还能查到东西"
   * （其实是模型自己的知识或上游检索）时，如果界面没提前说清，
   * 他会认定这个开关是假的，从此不再相信它。
   */
  const node = render(netView());
  const text = allText(node);
  assert.match(text, /Ling-bot 自己发起|自己发起的/);
  assert.match(text, /模型服务商|服务商/);
});

/* ------------------------------------------------------------ 开关写入 */

test('★ 点开关 → setting("network.enabled", false)，且只发一次', async () => {
  resetBridge(() => ({ ok: true }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView() }, {});
    const box = checkbox(node);
    assert.ok(box, '缺总开关复选框');
    assert.equal(box.checked, true, '快照开时复选框应为选中');

    box.checked = false;
    box.listeners.change?.();
    await flush();

    const settings = bridge.calls.filter((c) => c.method === 'setting');
    assert.equal(settings.length, 1, '一次点击只该发一个 setting');
    assert.deepEqual(settings[0].params, { key: 'network.enabled', value: false });
  } finally {
    restore();
  }
});

test('保存失败 → 显示失败码，且复选框回到真实状态', async () => {
  resetBridge(() => ({ ok: false, code: 'E40XX', message: '必须是布尔值' }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView() }, {});
    const box = checkbox(node);
    box.checked = false;
    box.listeners.change?.();
    await flush();

    // 失败后重绘一次，页面必须把"保存失败"写出来
    const after = renderNetworkSection({ network: netView() }, {});
    const text = allText(after);
    assert.match(text, /保存失败/);
    assert.match(text, /E40XX/);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 三态模式 */

test('★ 三态在同一张卡里都能看到，且当前生效按 effectiveMode 回显', () => {
  /*
   * 三态不能合并成两句（"开着/关着"）。用户需要知道的是**关闭 / 独立 API /
   * 服务商原生**这三种执行方式里的哪一种，因为它们的请求形状完全不同。
   */
  const node = render(netView({ mode: 'native', effectiveMode: 'native', effective: 'native' }));
  const text = allText(node);
  assert.match(text, /联网模式/);
  assert.match(text, /① 关闭/);
  assert.match(text, /② 独立搜索 API/);
  assert.match(text, /③ 服务商原生联网/);
  // 当前生效一行必须指向 native，而不是显示成"独立 API"
  const pairs = kvPairs(node);
  const current = pairs.find(([k]) => k === '当前生效');
  assert.ok(current, '缺"当前生效"一行');
  assert.match(current[1], /服务商原生联网/);

  // 换成 api 生效时，同一行要变成独立 API
  const apiNode = render(netView({ mode: 'api', effectiveMode: 'api' }));
  const apiCurrent = kvPairs(apiNode).find(([k]) => k === '当前生效');
  assert.match(apiCurrent[1], /独立搜索 API/);
});

test('★ effectiveMode=off 时"当前生效"必须显示关闭（不是独立 API）', () => {
  const node = render(netView({
    enabled: false,
    effective: 'off',
    mode: 'api', // 存储的模式还在（关闭不会清掉模式）
    effectiveMode: 'off',
  }));
  const current = kvPairs(node).find(([k]) => k === '当前生效');
  assert.match(current[1], /关闭/);
  // 存储的模式仍回显成 api：关闭不等于把用户的选择删掉
  const api = radioByValue(node, 'api');
  assert.equal(api.checked, true);
});

test('★ 模式单选回显 net.mode，点 native 写 network.mode = native（只发一次）', async () => {
  resetBridge(() => ({ ok: true }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView({ mode: 'api', effectiveMode: 'api' }) }, {});
    const api = radioByValue(node, 'api');
    const nat = radioByValue(node, 'native');
    assert.ok(api && nat, '缺模式单选框');
    assert.equal(api.checked, true, '快照 mode=api 时 api 应选中');
    assert.equal(nat.checked, false);

    nat.checked = true;
    nat.listeners.change?.();
    await flush();

    const settings = bridge.calls.filter((c) => c.method === 'setting');
    assert.equal(settings.length, 1, '一次点击只该写一次配置');
    assert.deepEqual(settings[0].params, { key: 'network.mode', value: 'native' });
  } finally {
    restore();
  }
});

test('★ 点"独立搜索 API"写回 api（native → api 的方向也要对）', async () => {
  resetBridge(() => ({ ok: true }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView({ mode: 'native', effectiveMode: 'native' }) }, {});
    const api = radioByValue(node, 'api');
    api.checked = true;
    api.listeners.change?.();
    await flush();

    const settings = bridge.calls.filter((c) => c.method === 'setting');
    assert.equal(settings.length, 1);
    assert.deepEqual(settings[0].params, { key: 'network.mode', value: 'api' });
  } finally {
    restore();
  }
});

test('模式保存失败 → 显示失败码，且不假装已经切过去', async () => {
  resetBridge(() => ({ ok: false, code: 'E40MD', message: 'mode 必须是 api 或 native' }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView({ mode: 'api', effectiveMode: 'api' }) }, {});
    radioByValue(node, 'native').checked = true;
    radioByValue(node, 'native').listeners.change?.();
    await flush();

    // 失败后回到模块状态重绘：必须把失败写出来
    const after = renderNetworkSection({ network: netView({ mode: 'api', effectiveMode: 'api' }) }, {});
    const text = allText(after);
    assert.match(text, /模式保存失败/);
    assert.match(text, /E40MD/);
    // 意图被丢掉：单选必须回到后端真实值 api
    assert.equal(radioByValue(after, 'api').checked, true);
  } finally {
    restore();
  }
});

test('★ 模式保存失败但后端回报生效值（E4089 同类）→ 单选停在生效值，不能弹回旧值', async () => {
  /*
   * 与总开关的 `closed/value` 是同一类回报：写盘失败，但内存里**已经**按新值生效。
   * 界面若把单选弹回旧值，用户会以为没切成功，而实际请求已经按新模式发出了 ——
   * "界面与真实执行不一致"里最难自查的一种。
   */
  resetBridge(() => ({ ok: false, code: 'E4089', value: 'native', message: '配置写盘失败' }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView({ mode: 'api', effectiveMode: 'api' }) }, {});
    const nat = radioByValue(node, 'native');
    nat.checked = true;
    nat.listeners.change?.();
    await flush();

    // 写盘失败后快照可能仍是旧值 api，界面不能跟着弹回去
    const after = renderNetworkSection({ network: netView({ mode: 'api', effectiveMode: 'api' }) }, {});
    const text = allText(after);
    assert.match(text, /已生效为「服务商原生联网」/);
    assert.match(text, /E4089/);
    assert.match(text, /保存失败/);
    assert.equal(radioByValue(after, 'native').checked, true, '要停在真实生效值');
    assert.equal(radioByValue(after, 'api').checked, false);
  } finally {
    restore();
  }
});

test('★ 保存中就要有可见反馈（不是点完一片空白）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  resetBridge(() => gate);
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView({ mode: 'api' }) }, {});
    const nat = radioByValue(node, 'native');
    nat.checked = true;
    nat.listeners.change?.();

    // 请求还没回来时重绘一次（模拟 2 秒轮询），必须看到"保存中"
    const during = renderNetworkSection({ network: netView({ mode: 'api' }) }, {});
    assert.match(allText(during), /保存中/);
    // 而单选要停在新值上（意图值顶住快照回退）
    assert.equal(radioByValue(during, 'native').checked, true, '快照还没追上时单选不能弹回');

    release({ ok: true });
    await flush();
  } finally {
    restore();
  }
});

test('★ 总开关关着时给"需先打开总开关"提示，但不把已存模式清掉', () => {
  const node = render(netView({
    enabled: false,
    effective: 'off',
    effectiveMode: 'off',
    mode: 'native',
  }));
  const text = allText(node);
  assert.match(text, /需先打开总开关/);
  // 已存模式仍然选中：关闭只是暂停，不该丢用户的选择
  assert.equal(radioByValue(node, 'native').checked, true);
});

test('★ 页面要说明"原生模式与独立 API 不会同时执行"（避免重复消耗）', () => {
  const node = render(netView());
  const text = allText(node);
  assert.match(text, /结构性隐藏/);
  assert.match(text, /两条通道默认只走一条/);
  assert.match(text, /不会同时跑|不会同时执行/);
  /*
   * 后端隐藏的是**两个**插件工具（plugin_web_search + plugin_web_fetch），
   * 界面若只写"隐藏了搜索"，用户会以为 web_fetch 还能用。
   */
  assert.match(text, /web_search \/ web_fetch|web_search\/web_fetch/);
});

test('★ 原生模式下不能说"web_fetch 可用"：两个插件工具都被结构性隐藏', () => {
  /*
   * 真会踩的自相矛盾：上面「AI 能用的工具」显示"没有"，
   * 下面「读取网页正文」却写"允许（web_fetch 可用）"，而 allowFetch 是 true。
   * 后端在原生模式下把两个插件工具都隐藏了（buildNetView / disabledNetTools），
   * 所以这一行必须改成"原生模式不使用插件工具"。
   */
  const native = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    allowFetch: true,
    tools: [],
  }));
  const text = allText(native);
  assert.match(text, /原生模式不使用插件工具/);
  assert.equal(/web_fetch 可用/.test(text), false, '原生模式不能声称 web_fetch 可用');
  assert.equal(/没有（模型看不到搜索工具）/.test(text), false, '原生模式要说清是两个工具都不可见');
  assert.match(text, /web_search \/ web_fetch 都不可见/);

  // 同一份 allowFetch 在独立 API 模式下仍然按原样回显（不能为修一处改坏另一处）
  const api = render(netView({ mode: 'api', effectiveMode: 'api', allowFetch: true, tools: ['plugin_web_search', 'plugin_web_fetch'] }));
  const apiRows = kvPairs(api);
  assert.match(apiRows.find(([k]) => k === '读取网页正文')?.[1] ?? '', /允许（web_fetch 可用）/);
});

test('原生模式下 allowFetch=false 也不能写成"只能搜索"（搜索工具同样不可见）', () => {
  const node = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    allowFetch: false,
    tools: [],
  }));
  const row = kvPairs(node).find(([k]) => k === '读取网页正文');
  assert.match(row?.[1] ?? '', /原生模式不使用插件工具/);
  assert.equal(/只能搜索/.test(row?.[1] ?? ''), false);
});

/* ------------------------------------------------------ 服务商原生：写 */

test('★ 服务商下拉只有三个选项，选智谱写 network.native.provider = zhipu', async () => {
  resetBridge(() => ({ ok: true }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({
      network: netView({ mode: 'native', effectiveMode: 'native' }),
    }, {});
    const select = selectNode(node);
    assert.ok(select, '缺服务商下拉');

    const labels = walk(select).filter((n) => n.tagName === 'OPTION').map((n) => n.textContent);
    assert.deepEqual(labels, ['未选择', '智谱 GLM', 'OpenAI']);

    select.value = 'zhipu';
    select.listeners.change?.();
    await flush();

    const settings = bridge.calls.filter((c) => c.method === 'setting');
    assert.equal(settings.length, 1);
    assert.deepEqual(settings[0].params, { key: 'network.native.provider', value: 'zhipu' });
  } finally {
    restore();
  }
});

test('服务商选 OpenAI 也要写对值（不是只认一个 zhipu）', async () => {
  resetBridge(() => ({ ok: true }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView({ mode: 'native' }) }, {});
    const select = selectNode(node);
    select.value = 'openai';
    select.listeners.change?.();
    await flush();

    assert.deepEqual(
      bridge.calls.filter((c) => c.method === 'setting')[0].params,
      { key: 'network.native.provider', value: 'openai' },
    );
  } finally {
    restore();
  }
});

test('选回"未选择"是合法操作：写空串（不是删配置、不是不写）', async () => {
  resetBridge(() => ({ ok: true }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({
      network: netView({
        mode: 'native',
        native: nativeView({ provider: 'zhipu', providerLabel: '智谱 GLM' }),
      }),
    }, {});
    const select = selectNode(node);
    select.value = '';
    select.listeners.change?.();
    await flush();

    assert.deepEqual(
      bridge.calls.filter((c) => c.method === 'setting')[0].params,
      { key: 'network.native.provider', value: '' },
    );
  } finally {
    restore();
  }
});

test('服务商保存失败 → 显示失败码', async () => {
  resetBridge(() => ({ ok: false, code: 'E40PV', message: 'provider 不受支持' }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView({ mode: 'native' }) }, {});
    const select = selectNode(node);
    select.value = 'openai';
    select.listeners.change?.();
    await flush();

    const after = renderNetworkSection({ network: netView({ mode: 'native' }) }, {});
    assert.match(allText(after), /服务商保存失败/);
    assert.match(allText(after), /E40PV/);
  } finally {
    restore();
  }
});

test('★ providerKnown=false → 明说"该服务商尚未适配，不会发送任何联网参数"', () => {
  const node = render(netView({
    mode: 'native',
    effective: 'native-needs-config',
    effectiveMode: 'native',
    native: nativeView({
      provider: 'openai',
      providerLabel: 'OpenAI',
      providerKnown: false,
      active: true,
    }),
  }));
  const text = allText(node);
  assert.match(text, /该服务商尚未适配，不会发送任何联网参数/);
  // 未适配时不能出现"已适配/可用"这种相反的结论
  assert.equal(/该服务商已适配/.test(text), false);
});

test('未选择服务商 → 也明说不会发送任何联网参数', () => {
  const node = render(netView({ mode: 'native', effectiveMode: 'native' }));
  const text = allText(node);
  assert.match(text, /还没有选择服务商/);
  assert.match(text, /不会发送任何联网参数/);
});

/* ------------------------------------------------------ 原生联网：事实回显 */

test('★ 原生卡片回显协议 / 限制 / 是否配置四项（后端给什么显示什么）', () => {
  const node = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    native: nativeView({
      provider: 'zhipu',
      providerLabel: '智谱 GLM',
      active: true,
      configured: true,
      protocol: '智谱 GLM · Chat Completions tools[type=web_search]',
      limitsText: '单次最多 5 条来源；不支持站点白名单。',
    }),
  }));
  const text = allText(node);
  assert.match(text, /tools\[type=web_search\]/);
  assert.match(text, /单次最多 5 条来源/);
  assert.match(text, /智谱 GLM/);

  const pairs = kvPairs(node);
  assert.match(pairs.find(([k]) => k === '协议')?.[1] ?? '', /Chat Completions/);
  assert.match(pairs.find(([k]) => k === '是否已适配')?.[1] ?? '', /已适配/);
  assert.match(pairs.find(([k]) => k === '生效中')?.[1] ?? '', /是/);
});

test('★ 没有引用/来源（status=unknown）→ 必须写"无法确认是否真的联网"', () => {
  /*
   * 这是本轮最容易做错的一格：用户在别处见过模型"看起来很联网"的回答，
   * 于是来这里找证据。页面把"请求成功"写成"联网成功"，他就再也不会核对。
   */
  const node = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    native: nativeView({
      provider: 'zhipu',
      providerLabel: '智谱 GLM',
      active: true,
      configured: true,
      last: {
        at: 1_760_000_000_000,
        provider: 'zhipu',
        status: 'unknown',
        kind: 'none',
        sources: [],
        inlineRefs: 0,
        detail: '上游返回了回答，但没有任何 url_citation 或 web_search 事件。',
      },
    }),
  }));
  const text = allText(node);
  assert.match(text, /无法确认是否真的联网/);
  // 硬纪律：HTTP 200 / 日期正确 / 模型自称 都不能当证据，页面必须写出来
  assert.match(text, /HTTP 200/);
  assert.match(text, /自称/);
  assert.match(text, /都不算证据|不算证据/);
  // 不得出现"联网成功"这种结论
  assert.equal(/联网成功|成功联网/.test(text), false);
});

test('★ 上次证据：searched 时列出来源 title+url，但**不做可点击链接**', () => {
  const node = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    native: nativeView({
      provider: 'zhipu',
      providerLabel: '智谱 GLM',
      active: true,
      configured: true,
      last: {
        at: 1_760_000_000_000,
        provider: 'zhipu',
        status: 'searched',
        kind: 'url_citation',
        sources: [
          { title: '来源甲', url: 'https://example.com/a' },
          { title: '来源乙', url: 'https://example.org/b' },
        ],
        inlineRefs: 2,
        detail: '命中 2 条结构化引用。',
      },
    }),
  }));
  const text = allText(node);
  assert.match(text, /来源甲/);
  assert.match(text, /https:\/\/example\.com\/a/);
  assert.match(text, /来源乙/);
  // inlineRefs 数量与 detail 都要显示
  assert.match(text, /2 处/);
  assert.match(text, /命中 2 条结构化引用/);
  // 证据类型也要回显（url_citation）
  assert.match(text, /url_citation/);
  /*
   * 关键：不能出现 <a>。在 Tauri 壳里点外链会把整个界面导航走，
   * 而"能不能打开"是壳的白名单职责，不是页面能决定的。
   */
  assert.equal(walk(node).filter((n) => n.tagName === 'A').length, 0, '不能渲染 <a href>');
});

test('★ 坏来源地址（javascript:）不原样画出来，也不变成链接', () => {
  const node = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    native: nativeView({
      provider: 'zhipu',
      providerLabel: '智谱 GLM',
      last: {
        at: 1_760_000_000_000,
        provider: 'zhipu',
        status: 'searched',
        kind: 'url_citation',
        sources: [{ title: '看起来像来源', url: 'javascript:alert(1)' }],
        inlineRefs: 0,
        detail: '',
      },
    }),
  }));
  const text = allText(node);
  assert.equal(text.includes('javascript:alert(1)'), false, '坏地址不能当文本回显');
  assert.match(text, /已隐藏/);
  assert.equal(walk(node).filter((n) => n.tagName === 'A').length, 0);
});

test('★ 其余三种证据状态（rejected / not-requested / unavailable）文案可区分', () => {
  const cases = [
    ['rejected', /被上游拒绝|被拒绝/],
    ['not-requested', /没有发送联网声明或联网工具/],
    ['unavailable', /没有可用的联网能力/],
  ];
  const seen = new Set();
  for (const [status, re] of cases) {
    const node = render(netView({
      mode: 'native',
      effective: 'native',
      effectiveMode: 'native',
      native: nativeView({
        provider: 'zhipu',
        providerLabel: '智谱 GLM',
        last: {
          at: 1_760_000_000_000,
          provider: 'zhipu',
          status,
          kind: 'none',
          sources: [],
          inlineRefs: 0,
          detail: '',
        },
      }),
    }));
    const text = allText(node);
    assert.match(text, re, `${status} 态的文案不对`);
    assert.equal(/无法确认是否真的联网/.test(text), false, `${status} 不该套用 unknown 的结论`);
    seen.add(pillClass(node, status === 'rejected' ? '被拒绝' : status === 'unavailable' ? '服务商不可用' : '未发送请求'));
  }
  // 三态的药丸样式要有 dim/err 之分，不能都长成一个样
  assert.ok(seen.size >= 2, '三种状态至少要有两种视觉区分');
});

test('★ 原生统计四项计数与"关闭时的控制范围"都要显示', () => {
  const node = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    native: nativeView({
      provider: 'zhipu',
      providerLabel: '智谱 GLM',
      active: true,
      stats: { requests: 7, evidence: 5, noEvidence: 2, rejected: 1, lastAt: 1_760_000_000_000 },
      offPolicy: {
        explicit: true,
        text: '关闭后 Ling-bot 不再发送任何联网声明/工具；但服务商是否仍在其服务端自行检索无法验证。',
      },
    }),
  }));
  const text = allText(node);
  assert.match(text, /关闭时的控制范围/);
  assert.match(text, /不再发送任何联网声明/);
  assert.match(text, /无法验证/);

  const pairs = kvPairs(node);
  assert.equal(pairs.find(([k]) => k === '原生联网回合')?.[1], '7');
  assert.equal(pairs.find(([k]) => k === '有证据的回合')?.[1], '5');
  assert.equal(pairs.find(([k]) => k === '无证据的回合')?.[1], '2');
  assert.equal(pairs.find(([k]) => k === '被拒绝的回合')?.[1], '1');
});

test('没有原生统计块时显示「—」而不是 0（0 是"确实一次都没有"）', () => {
  const node = render(netView({
    mode: 'native',
    native: nativeView({ stats: null }),
  }));
  const pairs = kvPairs(node);
  assert.equal(pairs.find(([k]) => k === '原生联网回合')?.[1], '—');
  assert.equal(pairs.find(([k]) => k === '无证据的回合')?.[1], '—');
});

test('没有上次记录时明说"还没有证据"，不编一个成功状态', () => {
  const node = render(netView({ mode: 'native', native: nativeView({ last: null }) }));
  const text = allText(node);
  assert.match(text, /还没有记录到原生联网的证据/);
  assert.equal(/上次联网证据/.test(text), false, '没有 last 就不该出现"上次证据"这一节');
});

test('★ 自相矛盾的快照（searched 但没有来源/引用）→ 按"无法确认"对待', () => {
  /*
   * 与 allowFetch 那句兜底同一纪律：后端字段互相矛盾时，取更保守的解读。
   * 否则用户会看到一个"有引用证据"的药丸，下面却一条来源都没有 ——
   * 这比直接说"无法确认"更容易被当成"它真的联网了"。
   */
  const node = render(netView({
    mode: 'native',
    effective: 'native',
    effectiveMode: 'native',
    native: nativeView({
      provider: 'zhipu',
      providerLabel: '智谱 GLM',
      last: {
        at: 1_760_000_000_000,
        provider: 'zhipu',
        status: 'searched',
        kind: 'url_citation',
        sources: [],
        inlineRefs: 0,
        detail: '',
      },
    }),
  }));
  const text = allText(node);
  assert.match(text, /自相矛盾/);
  assert.match(text, /无法确认是否真的联网/);
});

test('★ 六态各有自己的药丸（native / native-needs-config 不能和 on / needs-config 合并）', () => {
  /*
   * `native` 与 `native-needs-config` 是本轮新增的两态。它们不能借 `on` /
   * `needs-config` 的文案：原生模式的失败原因（未选服务商 / 未适配）与
   * 独立 API 的（缺 Key / 地址非法）完全不同，修的地方也不同。
   */
  const cases = [
    ['on', '搜索可用', 'pill-ok'],
    ['needs-config', '未就绪', 'pill-err'],
    ['native', '原生联网', 'pill-ok'],
    ['native-needs-config', '原生联网未就绪', 'pill-warn'],
  ];
  for (const [effective, label, cls] of cases) {
    const node = render(netView({ effective, effectiveMode: effective.startsWith('native') ? 'native' : 'api' }));
    assert.equal(pillClass(node, label), `pill ${cls}`, `${effective} 态应该显示「${label}」并带 ${cls}`);
  }

  // 两种原生态的解释句要能区分：一个说"检索由服务商完成"，一个说"还没就绪"
  /*
   * 这里故意把后端文案留空：验证的是前端的**兜底**表（后端没给/不该给时用）。
   * 后端给了 effectiveText 时以它为准，那是另一条已覆盖的路径。
   */
  const okText = allText(render(netView({ effective: 'native', effectiveMode: 'native', effectiveText: '' })));
  const badText = allText(render(netView({
    effective: 'native-needs-config',
    effectiveMode: 'native',
    effectiveText: '',
  })));
  assert.match(okText, /检索由服务商在它自己服务端完成/);
  assert.match(badText, /还没就绪/);
  assert.match(badText, /不会退回独立搜索/);
});

/* ------------------------------------------------------ 缺数据时的保守态 */

test('★ 缺 network 块 / 缺 native 块时全部按保守态：不预选、不声称可用', () => {
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const noNetwork = renderNetworkSection({}, {});
    const text = allText(noNetwork);
    // 不预选任何模式：猜一个等于替用户做了选择
    for (const value of ['api', 'native']) {
      assert.equal(radioByValue(noNetwork, value).checked, false, '缺 mode 时不能预选');
    }
    assert.match(text, /后端没有给出当前的联网模式/);
    // 原生块缺失时不能声称任何原生事实
    assert.match(text, /后端未提供原生联网状态/);
    // 逐格查值（不能只查整段文本：键名「是否已适配」本身就含"已适配"，会假通过）
    const pairs = kvPairs(noNetwork);
    assert.equal(pairs.find(([k]) => k === '是否已适配')?.[1], '—');
    assert.equal(pairs.find(([k]) => k === '协议')?.[1], '—');
    assert.equal(pairs.find(([k]) => k === '生效中')?.[1], '—');
    assert.equal(/原生联网生效/.test(text), false, '缺数据时不能声称原生已生效');
    // 缺 network.native 也不能凭空写一个协议名
    assert.equal(/Chat Completions|tools\[type=web_search\]/.test(text), false);
  } finally {
    restore();
  }

  // 有 network 但没有 native（老后端）：走同一条保守路径
  const node = render(netView({ native: undefined }));
  const text2 = allText(node);
  assert.match(text2, /后端未提供原生联网状态/);
  assert.equal(kvPairs(node).find(([k]) => k === '协议')?.[1], '—');

  /*
   * native 在、但 providerKnown 缺失：不能说"已适配"（假阳性），
   * 也不能断言"不会发送"（假阴性）—— 只能说无法确认。
   */
  const partial = nativeView({ provider: 'zhipu', providerLabel: '智谱 GLM' });
  delete partial.providerKnown;
  const text3 = allText(render(netView({ mode: 'native', native: partial })));
  assert.match(text3, /providerKnown 缺失/);
  assert.match(text3, /无法确认/);
});

/* ------------------------------------------------------------ 试搜 */

test('★ 试搜走宿主的 tool.run 通道（不自己发 HTTP），并渲染来源', async () => {
  resetBridge((method) => {
    if (method === 'action') {
      return {
        ok: true,
        result: {
          ok: true,
          query: '台风路径',
          provider: 'tavily',
          count: 2,
          results: [
            { title: '来源一', url: 'https://example.com/one', snippet: '摘要一' },
            { title: '来源二', url: 'https://example.org/two', snippet: '摘要二' },
          ],
        },
      };
    }
    return { ok: true };
  });

  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView() }, {});
    const input = inputByType(node, 'search');
    assert.ok(input, '缺试搜输入框');
    input.value = '台风路径';
    input.listeners.input?.();

    const btn = button(node, '试搜');
    assert.ok(btn, '缺试搜按钮');
    btn.listeners.click?.();
    await flush();

    const actions = bridge.calls.filter((c) => c.method === 'action');
    assert.equal(actions.length, 1);
    /*
     * 关键：走的是 tool.run 这条宿主通道。
     * 如果页面自己 fetch，这里就一条 action 都看不到 —— 而那条路
     * 绕开了总闸、URL 限制与审计，是界面上的第二条联网通路。
     */
    assert.deepEqual(actions[0].params, {
      name: 'tool.run',
      params: { tool: 'plugin_web_search', args: { query: '台风路径' } },
    });
  } finally {
    restore();
  }
});

test('★ 试搜失败 → 显示错误码与建议（不是"没搜到"）', async () => {
  resetBridge((method) => {
    if (method === 'action') {
      return { ok: true, result: { ok: false, code: 'E4083', message: '额度用尽' } };
    }
    return { ok: true };
  });

  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView() }, {});
    const input = inputByType(node, 'search');
    input.value = 'x';
    input.listeners.input?.();
    button(node, '试搜').listeners.click?.();
    await flush();

    /*
     * 结果写在页面内的 result 容器里，而重绘会把它画出来。
     * 这里再渲染一次拿文本（模块级 ui.result 保存着状态）。
     */
    const after = renderNetworkSection({ network: netView() }, {});
    const text = allText(after);
    assert.match(text, /E4083/);
    assert.match(text, /额度|限流/);
  } finally {
    restore();
  }
});

test('空查询 → 本地拦下，不发任何调用', async () => {
  resetBridge(() => ({ ok: true }));
  const restore = installDom();
  try {
    resetWebSearchPageState();
    const node = renderNetworkSection({ network: netView() }, {});
    button(node, '试搜').listeners.click?.();
    await flush();
    assert.equal(bridge.calls.filter((c) => c.method === 'action').length, 0);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 统计与安全 */

test('运行统计：次数、失败、最近错误码都显示', () => {
  const node = render(netView());
  const text = allText(node);
  assert.match(text, /3/, '搜索次数');
  assert.match(text, /E4086/);
  assert.match(text, /上游故障/);
});

test('没有统计块时显示「—」而不是 0（0 是"确实没搜过"）', () => {
  const node = render(netView({ stats: null }));
  const text = allText(node);
  assert.match(text, /—/);
});

test('★ 页面不使用 inline style（CSP style-src self 会拦截）', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = await fs.readFile(path.join(root, 'ui/src/views/web-search.mjs'), 'utf8');
  assert.equal(/style:\s*['"{]/.test(src), false, '不能用 style 属性');
  assert.equal(/setAttribute\(\s*['"]style['"]/.test(src), false, '不能用 setAttribute(style)');
  assert.equal(/\.style\.\w+\s*=/.test(src), false, '不能直接改 .style');
});

/* ------------------------------------------------------------ 并入插件页 */

/**
 * 造一个插件页快照。
 *
 * @param {string} selectedName
 */
function pluginSnap() {
  const item = (id, name) => ({
    id,
    name,
    version: '1.0.0',
    status: 'ready',
    statusText: '就绪',
    description: `${name} 测试插件`,
    config: [],
    tools: [],
    notes: [],
  });
  return {
    plugins: {
      items: [item('dsh-bridge', 'DSH 桥接'), item('web-search', '联网搜索')],
      stats: { total: 2, ready: 2, error: 0, disabled: 0 },
      dirs: {},
      allowDangerous: false,
    },
    network: netView({ mode: 'native', effectiveMode: 'native' }),
  };
}

test('★ 联网设置已并入插件页：选中「联网搜索」后详情下方出现宿主级设置区块', () => {
  const restore = installDom();
  try {
    _resetPluginUiForTest();
    let rerenders = 0;
    const ctx = { rerender: () => { rerenders += 1; } };

    // 第一帧默认选中第一个插件（DSH 桥接），不应出现联网区块
    const first = renderPlugins(pluginSnap(), ctx);
    assert.equal(allText(first).includes('联网搜索（宿主级设置）'), false, '没选中就不该穿插联网区块');

    // 点「联网搜索」那一行的可点击区域（和真实用户的操作同一条路径）
    const row = walk(first).find(
      (n) => n?.listeners?.click && allText(n).includes('联网搜索') && allText(n).includes('测试插件'),
    );
    assert.ok(row, '插件列表里应有可点击的「联网搜索」行');
    row.listeners.click({});
    assert.ok(rerenders >= 1, '选中插件后应触发重绘');

    const second = renderPlugins(pluginSnap(), ctx);
    const text = allText(second);
    assert.match(text, /联网搜索（宿主级设置）/);
    assert.match(text, /不是这个插件清单里的配置项/);
    assert.match(text, /服务商原生联网/);
    assert.match(text, /实际效果/);
    assert.match(text, /原生联网服务商/);
    // 区块被真正挂载（不是只加了标题）：证据说明与计数卡都在
    assert.match(text, /关闭时的控制范围/);
    assert.match(text, /判定证据只有三样/);
    assert.match(text, /计数（本进程启动以来）/);
    /*
     * 顺序：宿主级联网设置必须在插件详情之前。
     * 放在详情之后会被 6 段说明 + 配置表单 + 工具 + 诊断埋得很难找。
     */
    assert.ok(
      text.indexOf('联网搜索（宿主级设置）') < text.indexOf('联网搜索 · 详情'),
      '联网设置应排在插件详情之前',
    );
  } finally {
    restore();
    _resetPluginUiForTest();
  }
});

test('插件页仍是唯一入口：app.mjs 不再注册 web-search 页面', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const src = await fs.readFile(path.join(root, 'ui/src/app.mjs'), 'utf8');
  assert.equal(src.includes("id: 'web-search'"), false, '侧栏不应再有联网搜索页');
  assert.equal(src.includes('renderWebSearch'), false, '页面入口不应再 import renderWebSearch');
});
