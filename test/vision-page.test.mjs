/**
 * 视觉页渲染 —— 开关状态与能力探测必须分成两块
 *
 * ## 为什么这个文件值得单独存在
 *
 * 这一页的核心诉求不是"能把几个开关摆出来"，而是一条**语义纪律**：
 *
 *   开关开着但没探测过 ≠ 模型不支持
 *
 * 把这两者显示成同一件事，用户就会看到"不支持"而不再尝试，
 * 问题被永久掩盖 —— 而真相往往只是没点过探测按钮，或那次探测超时了。
 * 这类错误不会崩、不会报错，只会在界面上静静地误导人。
 *
 * 所以这里用一份最小 DOM 桩真的把页面渲染出来，对**结构**和**文案**做断言。
 * 桩只实现 render.mjs 真正用到的那几个方法，多实现反而会掩盖问题。
 *
 * ## 为什么桥接要在 import 之前装好
 *
 * `api.mjs` 在**模块求值时**就把 `globalThis.ling` 抓进了一个常量：
 *
 *   const ling = globalThis.ling;      // 只读这一次
 *   export function setting(k, v) { return resultOf(() => ling.invoke(...)) }
 *
 * 所以"先 import 页面、再装假桥"是无效的 —— ling 已经被固定成 undefined，
 * 调用会抛 TypeError 然后被 resultOf 吞成 { ok:false }，于是测试看起来
 * "保存失败了"，其实根本没走到断言。这里改成顶层 await 动态 import，
 * 保证假桥先就位。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------ DOM 桩 */

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.dataset = {};
    this.disabled = false;
    this.checked = false;
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
 * 桥接的应答函数。
 *
 * 必须在 api.mjs 求值前就存在（见文件头说明），所以做成模块级可变引用，
 * 每个用例只改 `bridge.reply`。
 *
 * @type {{ calls: Array<{method: string, params: any}>, reply: (key: string, value: any) => any }}
 */
const bridge = {
  calls: [],
  reply: () => ({ ok: true }),
};

globalThis.ling = {
  invoke: async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'setting') return bridge.reply(params?.key, params?.value);
    return { ok: true };
  },
};

/** 清空调用记录并换应答 */
function resetBridge(reply = () => ({ ok: true })) {
  bridge.calls.length = 0;
  bridge.reply = reply;
}

/** 等一轮宏任务，让 `void save(...)` 的 Promise 链跑完 */
const flush = () => new Promise((r) => setTimeout(r, 0));

// 注意：必须在 globalThis.ling 装好之后才 import 页面模块（理由见文件头）
const { renderVision, resetVisionPageState } = await import('../ui/src/views/vision.mjs');

/* ------------------------------------------------------------ 遍历工具 */

/** 深度遍历，收集所有节点 */
function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const c of node.children ?? []) walk(c, out);
  return out;
}

/** 收集页面上的全部可见文本 */
function allText(node) {
  return walk(node)
    .map((n) => n.textContent ?? '')
    .filter(Boolean)
    .join('\n');
}

/** 收集所有 className */
function allClasses(node) {
  return walk(node)
    .map((n) => n.className ?? '')
    .join(' ');
}

/** 按标签与文字找按钮 */
function button(node, label) {
  return walk(node).find((n) => n.tagName === 'BUTTON' && n.textContent === label);
}

/** 找第一个带某个 class 的容器 */
function byClass(node, cls) {
  return walk(node).find((n) => String(n.className).split(/\s+/).includes(cls));
}

/** 找复选框 */
function checkbox(node) {
  return walk(node).find((n) => n.tagName === 'INPUT' && n.attributes?.type === 'checkbox');
}

/** 找数字输入框（按当前值） */
function numberInput(node, value) {
  return walk(node).find(
    (n) => n.tagName === 'INPUT' && n.attributes?.type === 'number' && (value === undefined || n.value === String(value)),
  );
}

/** 一份完整的、贴契约 §10 形状的快照 */
function fullSnap(overrides = {}) {
  return {
    vision: {
      enabled: true,
      limits: {
        maxImagesPerTurn: 3,
        maxHistoryImages: 2,
        maxBytes: 4_194_304,
        maxTotalBytes: 8_388_608,
        maxPixels: 36_000_000,
        timeoutMs: 8000,
        historyWindow: 6,
        includeQuoted: true,
        cacheTtlMs: 300_000,
      },
      capability: {
        probed: true,
        supported: true,
        model: 'deepseek-vl',
        basis: '实测',
        detail: '',
        probedAt: '2026-10-23T10:00:00.000Z',
      },
      effective: 'on',
      runtime: {
        turnsWithImages: 3,
        imagesSubmitted: 5,
        bytesSubmitted: 1024,
        skipped: 1,
        lastCodes: [],
        lastNotes: [],
        lastAt: 1_760_000_000_000,
      },
      ...overrides,
    },
  };
}

/* ------------------------------------------------------------ 空快照 */

test('★ 空快照也能渲染出页面（不白屏）', () => {
  /*
   * 首帧时 snapshot 可能还没到，vision 字段完全不存在。
   * 这时必须渲染出一个"结构完整但没有值"的页面，
   * 而不是抛异常导致整页白屏 —— 白屏是最难向用户解释的故障。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision({}, {});
    assert.ok(node, '必须返回节点');
    const text = allText(node);
    assert.match(text, /实际效果/, '缺实际效果块');
    assert.match(text, /开关状态/, '缺开关块');
    assert.match(text, /能力探测/, '缺能力探测块');
    assert.match(text, /图片预算/, '缺预算块');
  } finally {
    restore();
  }
});

test('vision 字段为 undefined 时不崩，且按"未启用"渲染', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision({ vision: undefined }, {});
    assert.match(allText(node), /未启用/, '没有 vision 字段时应显示未启用');
  } finally {
    restore();
  }
});

test('rerender 缺失时也不崩（首帧没有 ctx）', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    assert.doesNotThrow(() => renderVision(fullSnap()));
    assert.doesNotThrow(() => renderVision({}, undefined));
  } finally {
    restore();
  }
});

/* ------------------------------------------------ 开关与探测必须是两块 */

test('★ 开关状态与能力探测是两个独立区块', () => {
  /*
   * 这是本页的第一条硬要求：两件事分成两块渲染。
   * 断言落在**容器结构**上（而不是只查文字）—— 把两块合并进一张卡，
   * 同样可以写出这两句文字来。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap(), {});
    assert.ok(byClass(node, 'vision-switch'), '缺独立的开关区块');
    assert.ok(byClass(node, 'vision-cap'), '缺独立的能力探测区块');
    assert.ok(byClass(node, 'vision-effective'), '缺独立的实际效果区块');
    // 实际效果必须在最前：用户点进来第一眼要的是答案，不是开关
    const root = walk(node)[0];
    assert.equal(root.children[0]?.className, 'vision-effective', '实际效果要排在最前面');
  } finally {
    restore();
  }
});

test('★ 实际效果与开关状态是两回事：开关开着但模型不支持', () => {
  /*
   * `enabled: true` + `supported: false` 时，实际效果是 on-unsupported。
   * 如果页面只把 enabled 显示成"已开启"，用户会以为图片真的发出去了。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      fullSnap({
        enabled: true,
        effective: 'on-unsupported',
        capability: {
          probed: true, supported: false, model: 'text-only', basis: '实测', detail: '', probedAt: '2026-10-23T10:00:00Z',
        },
      }),
      {},
    );
    const text = allText(node);
    assert.match(text, /实际效果/, '要有「实际效果」这一块');
    assert.match(text, /已开启但模型不支持/, '实际效果要按 on-unsupported 显示');
    // 开关块仍然反映用户意图（开着）—— 两处同时存在才证明它们是两块
    assert.equal(checkbox(node)?.checked, true, '开关块要反映用户意图（开着）');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 四态文案 */

test('★ off：关掉时说清楚"停止取图与提交"，而不是只隐藏界面', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      fullSnap({
        enabled: false,
        effective: 'off',
        capability: { probed: false, supported: null, model: '', basis: '', detail: '', probedAt: null },
      }),
      {},
    );
    const text = allText(node);
    assert.match(text, /未启用/, 'off 要显示未启用');
    assert.match(text, /不取图/, '要说明不取图');
    assert.match(text, /不提交/, '要说明不提交');
    assert.match(text, /\[图片\]/, '要说明消息文本里仍是 [图片] 占位');
  } finally {
    restore();
  }
});

test('★ on：已开启且已实测支持', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap({ enabled: true, effective: 'on' }), {});
    const text = allText(node);
    assert.match(text, /正常读图/, 'on 要显示正常读图');
    assert.match(text, /已实测支持/, '能力块要显示已实测支持');
  } finally {
    restore();
  }
});

test('★ on-unprobed：未探测必须显示「未探测」，绝不能显示「不支持」', () => {
  /*
   * 这是整个需求的核心诉求之一。
   *
   * `supported: null` 的含义是"还没结论"，可能是没测过，也可能是探测超时。
   * 一旦把它渲染成"不支持"，用户会认为这个模型永远不能读图，
   * 于是再也不去点探测 —— 一个纯展示层的措辞就把功能判了死刑。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      fullSnap({
        enabled: true,
        effective: 'on-unprobed',
        capability: { probed: false, supported: null, model: '', basis: '', detail: '', probedAt: null },
      }),
      {},
    );
    const text = allText(node);
    assert.match(text, /未探测/, '未探测要明确显示');
    assert.match(text, /已开启（未探测）/, 'effective 要按 on-unprobed 显示');
    assert.ok(!/已实测不支持/.test(text), '未探测绝不能渲染成不支持');
    assert.ok(!/已开启但模型不支持/.test(text), 'effective 不能被说成 on-unsupported');
  } finally {
    restore();
  }
});

test('★ 探测过但没结论时也不显示「不支持」', () => {
  /*
   * 第二种误导形态：探测确实跑过了，但结果没拿到（超时 / 网络错误）。
   * `probed: true` + `supported: null` 既不是"支持"也不是"不支持"。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      fullSnap({
        enabled: true,
        effective: 'on-unprobed',
        capability: {
          probed: true, supported: null, model: 'x', basis: '', detail: '请求超时', probedAt: '2026-10-23T10:00:00Z',
        },
      }),
      {},
    );
    const text = allText(node);
    assert.match(text, /探测过，但没有结论/, '要区分"探测过但没有结论"');
    assert.ok(!/已实测不支持/.test(text), '没有结论不能写成不支持');
    assert.match(text, /请求超时/, '原因要显示出来');
  } finally {
    restore();
  }
});

test('★ on-unsupported：已实测不支持时说明不会提交图片', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      fullSnap({
        enabled: true,
        effective: 'on-unsupported',
        capability: {
          probed: true, supported: false, model: 'text-only', basis: '实测', detail: '模型拒收图片', probedAt: '2026-10-23T10:00:00Z',
        },
      }),
      {},
    );
    const text = allText(node);
    assert.match(text, /已实测不支持/, '能力块要显示已实测不支持');
    assert.match(text, /不会提交图片/, '要说明这种状态下不会提交图片');
  } finally {
    restore();
  }
});

test('后端没给 effective 时，前端按 §8 矩阵自己推（未探测 → on-unprobed）', () => {
  /*
   * 老后端 / 首帧可能没有 effective。兜底推导必须与契约一致，
   * 尤其是 null 那一格：兜底成 on-unsupported 就等于把"没测过"说成"不支持"。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const off = renderVision(fullSnap({ enabled: false, effective: undefined }), {});
    assert.match(allText(off), /未启用/, 'enabled=false 要推到 off');

    const unprobed = renderVision(
      fullSnap({ enabled: true, effective: undefined, capability: { probed: false, supported: null } }),
      {},
    );
    assert.match(allText(unprobed), /已开启（未探测）/, 'supported=null 要推到 on-unprobed');

    const unsupported = renderVision(
      fullSnap({ enabled: true, effective: undefined, capability: { probed: true, supported: false } }),
      {},
    );
    assert.match(allText(unsupported), /已开启但模型不支持/, 'supported=false 要推到 on-unsupported');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 预算文案 */

test('★ 预算区八项数字 + 引用开关都在', () => {
  /*
   * 漏一项不会报错，只会让用户以为"这一项不用配"。
   * 这里按数量钉住：8 个数字输入框 + 1 个复选框（enabled 之外）。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap(), {});
    const numbers = walk(node).filter((n) => n.tagName === 'INPUT' && n.attributes?.type === 'number');
    assert.equal(numbers.length, 8, `预算区应有 8 个数字项，实际 ${numbers.length}`);
    // 每一项都必须带 min/max：没有边界的话越界就只剩后端报错了
    for (const n of numbers) {
      assert.ok(n.attributes.min !== undefined, '数字项要带 min');
      assert.ok(n.attributes.max !== undefined, '数字项要带 max');
    }
    // 整页两个开关：enabled + includeQuoted
    const boxes = walk(node).filter((n) => n.tagName === 'INPUT' && n.attributes?.type === 'checkbox');
    assert.equal(boxes.length, 2, `应有 2 个开关（总开关 + 引用图），实际 ${boxes.length}`);
  } finally {
    restore();
  }
});

test('★ 预算用可读单位说明（用户不用自己换算字节）', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const text = allText(renderVision(fullSnap(), {}));
    assert.match(text, /4 MB/, '单图字节要换算成人话');
    assert.match(text, /8 MB/, '总字节要换算成人话');
    assert.match(text, /36,000,000|3600 万/, '像素要显示');
    assert.match(text, /8 秒/, '超时要显示');
    assert.match(text, /5 分钟/, '缓存 TTL 要显示');
    assert.match(text, /6 楼|硬上限 8 楼/, '回看楼层要显示');
  } finally {
    restore();
  }
});

test('★ 预算区显示"实际生效的值"，而不是配置里写的原始值', () => {
  /*
   * 配置里写 100 张，运行时夹到 4 张。界面若回显 100，用户会以为真发 100。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      fullSnap({ limits: { ...fullSnap().vision.limits, maxImagesPerTurn: 4, maxHistoryImages: 3 } }),
      {},
    );
    const text = allText(node);
    assert.match(text, /当前实际生效：4 张/, '要回显夹取后的值');
    assert.match(text, /当前实际生效：3 张/, '历史张数同理');
  } finally {
    restore();
  }
});

test('★ 残缺的 limits 不该把 undefined 渲染到页面上', () => {
  /*
   * 老后端可能只给一部分 limits 字段。用 `快照 ?? 默认值` 兜底时，
   * 整块存在但缺键就兜不住 —— 页面上会出现「当前实际生效：undefined 张」。
   * 那种文案比空白更糟：用户会以为配置坏了。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      { vision: { enabled: true, effective: 'on', limits: { maxImagesPerTurn: 4 }, capability: { probed: true, supported: true } } },
      {},
    );
    const text = allText(node);
    assert.ok(!/undefined/.test(text), `不该出现 undefined：${text.slice(0, 200)}`);
    assert.ok(!/NaN/.test(text), '不该出现 NaN');
    assert.match(text, /当前实际生效：4 张/, '有的字段要用快照值');
    assert.match(text, /当前实际生效：2 张/, '缺的字段要用默认值补齐');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 关键文案 */

test('★ 页面明确说明"探测可用 ≠ 真实聊天已读图"', () => {
  /*
   * 用户最容易的误解：看到「读图✓」就以为刚才那张图它真的看见了。
   * 实际可能图根本没取到，或者这一楼已经提交过。
   */
  const restore = installDom();
  try {
    resetVisionPageState();
    const text = allText(renderVision(fullSnap(), {}));
    assert.match(text, /不等于/, '要有"不等于"的对照句');
    assert.match(text, /真实聊天/, '要提到真实聊天');
    assert.match(text, /微型请求/, '要说明探测是独立请求');
  } finally {
    restore();
  }
});

test('★ 关闭说明写清"不取图、不提交、仍是 [图片] 占位"', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(
      fullSnap({ enabled: false, effective: 'off', capability: { probed: false, supported: null } }),
      {},
    );
    const text = allText(node);
    assert.match(text, /get_image|抓 URL/, '要说明连取图都不做');
    assert.match(text, /请求体/, '要说明请求体里没有图片');
    assert.match(text, /占位/, '要说明消息文本里是占位文字');
  } finally {
    restore();
  }
});

test('★ 运行统计说明只反映本进程', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const text = allText(renderVision(fullSnap(), {}));
    assert.match(text, /带图回合数/, '要有带图回合数');
    assert.match(text, /已提交图片张数/, '要有提交张数');
    assert.match(text, /重启后从零开始/, '要说明统计的生命周期');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 保存 */

test('★ 点开关发出的是 vision.enabled', async () => {
  const restore = installDom();
  resetBridge();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap({ enabled: false, effective: 'off' }), { rerender() {} });
    const box = checkbox(node);
    assert.ok(box, '要有开关');
    box.checked = true;
    box.listeners.change({ target: box });
    await flush();
    const call = bridge.calls.find((c) => c.method === 'setting');
    assert.ok(call, '必须走 setting 通道');
    assert.equal(call.params.key, 'vision.enabled');
    assert.equal(call.params.value, true);
  } finally {
    restore();
  }
});

test('★ 数字框保存的是数字，不是字符串', async () => {
  /*
   * 输入框的 .value 永远是字符串。原样提交会得到后端的 E40XX（"必须是整数"），
   * 或者更糟：`"3"` 被当成真值通过了某种宽松判断。
   */
  const restore = installDom();
  resetBridge();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap(), { rerender() {} });
    const input = numberInput(node, 3);
    assert.ok(input, '要能找到张数输入框');
    input.value = '2';
    button(node, '保存').listeners.click();
    await flush();
    const call = bridge.calls.find((c) => c.method === 'setting');
    assert.ok(call, '必须走 setting 通道');
    assert.match(call.params.key, /^vision\./);
    assert.equal(typeof call.params.value, 'number', '必须是数字');
    assert.equal(call.params.value, 2);
  } finally {
    restore();
  }
});

test('★ 保存失败要在页面上留红线（不能只 console.error）', async () => {
  /*
   * 保存失败的常见原因是超范围（后端 E40XX）或配置不可写。
   * 只在控制台报错，用户会以为已经生效 —— 而重启后设置又变回去了。
   */
  const restore = installDom();
  resetBridge(() => ({ ok: false, code: 'E4012', message: '超出范围' }));
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap({ enabled: false, effective: 'off' }), { rerender() {} });
    const box = checkbox(node);
    box.checked = true;
    box.listeners.change({ target: box });
    await flush();
    // 保存结果存在模块级 ui 里，重绘后必须还在
    const again = renderVision(fullSnap({ enabled: false, effective: 'off' }), { rerender() {} });
    const text = allText(again);
    assert.match(text, /保存失败/, '要显示保存失败');
    assert.match(text, /E4012/, '要带上错误码');
  } finally {
    restore();
  }
});

test('★ 保存中/已保存的状态跨重绘存活（模块级 state）', async () => {
  /*
   * 快照每 2 秒整页重建。状态若存在局部变量里，用户点完只会看到它闪一下。
   */
  const restore = installDom();
  resetBridge(() => ({ ok: true }));
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap({ enabled: false, effective: 'off' }), { rerender() {} });
    const box = checkbox(node);
    box.checked = true;
    box.listeners.change({ target: box });
    await flush();

    const again = renderVision(fullSnap({ enabled: true, effective: 'on' }), { rerender() {} });
    assert.match(allText(again), /已保存/, '重绘后「已保存」要还在');
  } finally {
    restore();
  }
});

test('★ 越界的数字不提交，当场给出提示', async () => {
  /*
   * 前端拦住只是为了体验（后端校验照旧）。但若拦了却不给提示，
   * 用户会以为按钮坏了 —— 点了没任何反应。
   */
  const restore = installDom();
  resetBridge();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap(), { rerender() {} });
    const input = numberInput(node, 3);
    input.value = '999';
    button(node, '保存').listeners.click();
    await flush();
    assert.equal(bridge.calls.filter((c) => c.method === 'setting').length, 0, '越界不该提交');
    const again = renderVision(fullSnap(), { rerender() {} });
    assert.match(allText(again), /必须是/, '要给出范围提示');
  } finally {
    restore();
  }
});

test('resetVisionPageState 能清掉保存反馈（用例之间不串味）', async () => {
  const restore = installDom();
  resetBridge();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap(), { rerender() {} });
    const input = numberInput(node, 3);
    input.value = '1';
    button(node, '保存').listeners.click();
    await flush();
    assert.match(allText(renderVision(fullSnap(), {})), /已保存/);
    resetVisionPageState();
    assert.ok(!/已保存/.test(allText(renderVision(fullSnap(), {}))), '清空后不该还挂着「已保存」');
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------ 布局纪律 */

test('★ 页面不使用 inline style（CSP style-src self）', () => {
  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap(), {});
    const offenders = walk(node).filter((n) => n.attributes && 'style' in n.attributes);
    assert.deepEqual(offenders, [], '不该出现 inline style，样式一律走 class');
  } finally {
    restore();
  }
});

test('★ 页面容器类都在样式表里有定义', async () => {
  /*
   * 视图里写了一个新 class 但忘了加 CSS，页面不会报错 ——
   * 只会"看起来没样式"，而且只有打开这一页才看得见。
   */
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const css = readFileSync(path.join(ROOT, 'ui', 'styles', 'pages.css'), 'utf8');
  for (const cls of ['vision-page', 'vision-effective', 'vision-switch', 'vision-cap', 'vision-budget', 'vision-runtime']) {
    assert.match(css, new RegExp(`\\.${cls}[\\s,{.]`), `样式表缺 .${cls}`);
  }

  const restore = installDom();
  try {
    resetVisionPageState();
    const node = renderVision(fullSnap(), {});
    assert.ok(allClasses(node).includes('vision-page'), '页面根节点要有 .vision-page');
  } finally {
    restore();
  }
});
