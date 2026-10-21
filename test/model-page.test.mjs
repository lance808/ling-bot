/**
 * 模型设置页 —— 行为测试（不是静态字符串匹配）
 *
 * 这里盯的是用户在界面上真实遇到过的几件事：
 *
 *   1. 「可否对话」永远显示「可以」——哪怕 key 是错的、模型名不存在
 *   2. 「探测状态」没有三态，失败和没测过长得一样，用户不知道下一步做什么
 *   3. 点完「探测模型」之后，选择模型那一块不更新（文案还是旧的）
 *   4. 目录读不到时界面里总有一份写死的 DeepSeek 清单，看起来像"服务商提供的"
 *
 * 用最小 DOM 桩把 renderModelSettings 真跑一遍，比断言源码里有没有某句话
 * 可靠得多 —— 后面几条 bug 都是"代码看着对、跑起来不对"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------ 最小 DOM 桩 */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.disabled = false;
    this.parent = null;
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n && typeof n === 'object') n.parent = this;
      this.children.push(n);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  /** 探测页里只用过这一种选择器：[data-probe-row] */
  querySelector(sel) {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    if (!m) return null;
    return find(this, (n) => m[1] in n.attributes || m[1] in (n.dataset ?? {}));
  }

  replaceWith(next) {
    const p = this.parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i < 0) return;
    if (next) next.parent = p;
    p.children[i] = next;
  }

  addEventListener(key, fn) {
    const previous = this.listeners[key];
    this.listeners[key] = previous ? (...args) => { previous(...args); return fn(...args); } : fn;
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }
}

function find(root, fn) {
  if (fn(root)) return root;
  for (const c of root.children ?? []) {
    if (!c || typeof c !== 'object') continue;
    const hit = find(c, fn);
    if (hit) return hit;
  }
  return null;
}

globalThis.document = {
  createElement: (tag) => new El(tag),
  createTextNode: (t) => ({ textContent: String(t), isText: true }),
  getElementById: () => null,
  activeElement: null,
};

const nodes = (root) => [root, ...(root.children ?? []).flatMap((c) => (c && c.tagName ? nodes(c) : [c]))];
const text = (root) => nodes(root).map((n) => n.textContent ?? '').join('\n');
const button = (root, label) => nodes(root).find((n) => n.tagName === 'BUTTON' && n.textContent === label);
const options = (root) => nodes(root).filter((n) => n.tagName === 'OPTION');
/**
 * 某一行 kv 的文本。
 *
 * `.kv` 容器自己的 textContent 是空的 —— render.mjs 的 el() 把子节点 append 进去，
 * 不会把文字聚合到父节点上（真 DOM 里也一样）。所以必须遍历子节点去取。
 */
const kvRow = (root, label) => {
  const row = nodes(root).find((n) => n.className === 'kv' && text(n).includes(label));
  return row ? text(row) : '';
};
/** 属性统一走 attributes：render.mjs 对非特殊键用的是 setAttribute */
const attr = (node, key) => node?.attributes?.[key] ?? node?.[key];

const { renderModelSettings } = await import('../ui/src/views/model.mjs');

/** 一份最小快照 */
function snap(o = {}) {
  return {
    config: {
      llm: {
        baseUrl: o.baseUrl ?? 'https://a.example/v1',
        model: o.model ?? 'm-1',
        timeoutMs: 60000,
        provider: 'custom',
        modelCapabilities: o.caps ?? {},
      },
    },
    brain: { configured: o.configured === true, model: o.model ?? 'm-1', baseUrl: o.baseUrl, keySource: o.keySource ?? 'none' },
  };
}

/** 收集渲染期用到的 ctx */
function ctxOf(o = {}) {
  const calls = { probe: [], save: [], models: 0 };
  return {
    calls,
    ctx: {
      onSaveSetting: async (k, v) => {
        calls.save.push([k, v]);
        return { ok: true };
      },
      onSaveApiKey: async () => ({ ok: true }),
      onClearApiKey: async () => ({ ok: true }),
      onTest: async () => o.testResult ?? ({ ok: true }),
      onDetectModels: async () => {
        calls.models += 1;
        return o.modelsResult ?? { ok: true, models: [{ id: 'm-1', channelLabel: '文本' }] };
      },
      onProbe: async (model, probe) => {
        calls.probe.push([model, probe]);
        return o.probeResult ?? { ok: true, caps: { vision: true }, probes: { vision: { supported: true } }, channel: { label: '多模态' } };
      },
    },
  };
}

/* ------------------------------------------------------------ 1. 可否对话 */

test('★ 没 Key 时「可否对话」不能显示「可以」', () => {
  const root = renderModelSettings(snap({ configured: false }), ctxOf().ctx);
  const t = text(root);
  assert.match(t, /缺少 Key/, '要明确说缺 Key');
  // 「可否对话」那一行的值是药丸；整页不该出现独立的「可以」
  assert.doesNotMatch(kvRow(root, '可否对话'), /\n可以\n/);
});

test('★ 有 Key 但没验证过 → 显示「未验证」，不是「可以」', () => {
  // 真 bug：只要 vault 里有 key 就永远绿的「可以」，
  // 地址写错 / 模型名不存在也照样绿，结果 QQ 里发消息没反应。
  const root = renderModelSettings(snap({ configured: true, caps: {} }), ctxOf().ctx);
  const t = text(root);
  assert.match(t, /未验证/, '没人验过就只能是未验证');
});

test('★ 测试连接失败后「可否对话」变「不可以」', async () => {
  const { ctx } = ctxOf({ testResult: { ok: false, code: 'E3020', message: 'key 无效' } });
  // 先渲染一次，再点「测试连接」，让 state.lastTest 记下来
  let root = renderModelSettings(snap({ configured: true, baseUrl: 'https://b.example/v1' }), ctx);
  await button(root, '测试连接').listeners.click();
  const line = kvRow(root, '可否对话');
  assert.ok(line, '要有「可否对话」这一行');
  assert.match(line, /不可以/, '失败证据必须反映出来');
});

test('★ 图像能力探测成功仍不能代替文本对话验证', async () => {
  const { ctx } = ctxOf({
    probeResult: { ok: true, caps: { vision: true }, probes: { vision: { supported: true } }, channel: { label: '多模态' } },
  });
  const s = () => snap({ configured: true, model: 'm-1', baseUrl: 'https://c.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '探测模型').listeners.click();
  const line = kvRow(root, '可否对话');
  assert.match(line, /未验证/);
});

/* --------------------------------------------------------- 2. 探测三态 */

test('★ 探测状态三态各有自己的文案', () => {
  const root = renderModelSettings(snap({ configured: true }), ctxOf().ctx);
  assert.match(text(root), /未探测/, '还没点过要显示未探测');
  assert.match(text(root), /先点「探测模型」/, '要告诉用户下一步');
});

test('★ 探测失败要显示「探测失败」并指向地址与 Key', async () => {
  const { ctx } = ctxOf({ probeResult: { ok: false, code: 'E3020', message: 'API Key 无效' } });
  const s = () => snap({ configured: true, baseUrl: 'https://d.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '探测模型').listeners.click();
  const again = renderModelSettings(s(), ctx);
  const t = text(again);
  assert.match(t, /探测失败/);
  assert.match(t, /接口地址与 API Key/, '失败时要指出排查方向');
});

test('★ 落了盘但没结论的探测结果算「探测失败」，不是「已探测」', () => {
  // 真实形状：E3012 / E404 时后端不写 vision/image，只写 probes
  const root = renderModelSettings(
    snap({
      configured: true,
      caps: { 'm-1': { probes: { vision: { supported: null, detail: 'fetch failed' } }, probedAt: '2026-10-21T00:00:00Z' } },
    }),
    ctxOf().ctx,
  );
  assert.match(text(root), /探测失败/);
});

test('★ 落盘且有明确结论 → 「已探测」', () => {
  const root = renderModelSettings(
    snap({ configured: true, caps: { 'm-1': { vision: true, image: false, probedAt: '2026-10-21T00:00:00Z' } } }),
    ctxOf().ctx,
  );
  assert.match(text(root), /已探测/);
  // 只看「探测状态」那一行：能力卡里的「未测」和别处的排查提示不算
  const row = nodes(root).find((n) => n.className === 'row wrap' && text(n).includes('探测状态'));
  assert.ok(row, '要有探测状态行');
  assert.match(text(row), /已探测/);
  assert.ok(!/探测失败/.test(text(row)), '有结论的不该显示失败');
});

/* --------------------------------------- 3. 探测后选择模型区必须更新 */

test('★ 探测成功后下拉里的能力标注要跟着变', async () => {
  // 真 bug：探测完只重建了下拉的节点，但下拉项文字是按探测结果现算的，
  // 没有重算 → 用户看到的是"点了探测，选择模型那部分没更新"。
  const { ctx, calls } = ctxOf({
    modelsResult: { ok: true, models: [{ id: 'm-1', channelLabel: '文本' }, { id: 'm-2', channelLabel: '文本' }] },
    probeResult: { ok: true, caps: { vision: true }, probes: { vision: { supported: true } }, channel: { label: '多模态' } },
  });
  const s = () => snap({ configured: true, model: 'm-1', baseUrl: 'https://e.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '读取模型列表').listeners.click();

  await button(root, '探测模型').listeners.click();
  assert.deepEqual(calls.probe.at(-1)[0], 'm-1', '要探测下拉里当前选中的那个');

  const after = root;
  const opts = options(after).map((o) => o.textContent);
  assert.ok(opts.some((o) => o.includes('m-1') && o.includes('读图✓')), `探测结果要进下拉标注：${opts.join(' | ')}`);
  assert.match(text(after), /已探测/);
  assert.ok(!opts.some((o) => o.includes('读图✓') && o.includes('｜文本')), '最新视觉结果必须更新旧目录通道');
});

test('★ 探测哪个模型由下拉的当前值决定，不用已保存的模型', async () => {
  const { ctx, calls } = ctxOf({ modelsResult: { ok: true, models: [{ id: 'm-1' }, { id: 'm-2' }] } });
  const s = () => snap({ configured: true, model: 'm-1', baseUrl: 'https://f.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '读取模型列表').listeners.click();

  const mid = renderModelSettings(s(), ctx);
  const select = nodes(mid).find((n) => n.tagName === 'SELECT');
  select.value = 'm-2';
  select.listeners.change();
  await button(mid, '探测模型').listeners.click();
  assert.equal(calls.probe.at(-1)[0], 'm-2', '要探测用户在下拉里选的那个，不是已保存的');
});

/* ------------------------------------- 4. 不再有写死的 DeepSeek 兜底 */

test('★ 目录读不到时不再塞写死的模型清单', async () => {
  const { ctx } = ctxOf({ modelsResult: { ok: false, code: 'E3021', message: 'HTTP 404' } });
  const s = () => snap({ configured: true, baseUrl: 'https://g.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '读取模型列表').listeners.click();

  const after = renderModelSettings(s(), ctx);
  const t = text(after);
  assert.match(t, /HTTP 404|检查接口地址与 API Key/, '要如实说读不到');
  assert.doesNotMatch(t, /deepseek-v4\.1/, '不能凭空出现 DeepSeek 模型');
  // 读不到就切成手填，让用户还能继续配
  assert.ok(
    nodes(after).some((n) => n.tagName === 'INPUT' && String(attr(n, 'placeholder')).includes('deepseek-chat')),
    '要提供手填模型名',
  );
});

test('服务商空目录与网络失败分开显示，错误原因跨重绘保留', async () => {
  const { ctx } = ctxOf({ modelsResult: { ok: false, code: 'E3021', reason: 'empty_catalog', message: '服务商返回空模型目录，请检查令牌分组与模型权限' } });
  const s = () => snap({ configured: true, baseUrl: 'https://empty.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '读取模型列表').listeners.click();
  assert.match(text(root), /目录为空/);
  assert.match(text(root), /令牌分组与模型权限/);
  assert.doesNotMatch(text(root), /读取模型列表失败/);
  const again = renderModelSettings(s(), ctx);
  assert.match(text(again), /目录为空/);
  assert.match(text(again), /令牌分组与模型权限/);
});

test('★ 手填的模型名也能探测', async () => {
  const { ctx, calls } = ctxOf({
    modelsResult: { ok: false, code: 'E3021', message: 'HTTP 404' },
    probeResult: { ok: true, caps: { vision: true }, probes: { vision: { supported: true } }, channel: { label: '多模态' } },
  });
  const s = () => snap({ configured: true, model: '', baseUrl: 'https://h.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '读取模型列表').listeners.click();

  const mid = renderModelSettings(s(), ctx);
  const input = nodes(mid).find((n) => n.tagName === 'INPUT' && String(attr(n, 'placeholder')).includes('deepseek-chat'));
  input.value = 'my-model';
  input.listeners.input();
  await button(mid, '探测模型').listeners.click();
  assert.equal(calls.probe.at(-1)[0], 'my-model');
});

test('文本测试原地更新，失败后成功恢复；切模型和换Key使验证失效', async () => {
  const s = () => snap({ configured: true, baseUrl: 'https://verification.example/v1' });
  const { ctx } = ctxOf({ testResult: { ok: false } });
  const root = renderModelSettings(s(), ctx);
  await button(root, '测试连接').listeners.click();
  assert.match(kvRow(root, '可否对话'), /不可以/);
  ctx.onTest = async () => ({ ok: true });
  await button(root, '测试连接').listeners.click();
  assert.match(kvRow(root, '可否对话'), /\n可以\n/);
  await button(root, '探测模型').listeners.click();
  assert.match(kvRow(root, '可否对话'), /\n可以\n/);
  const switched = renderModelSettings(snap({ configured: true, model: 'm-2', baseUrl: 'https://verification.example/v1' }), ctx);
  assert.match(kvRow(switched, '可否对话'), /未验证/);
  await button(switched, '测试连接').listeners.click();
  assert.match(kvRow(switched, '可否对话'), /\n可以\n/);
  const key = nodes(switched).find((n) => attr(n, 'type') === 'password');
  key.value = 'replacement-test-key';
  await button(switched, '保存 Key').listeners.click();
  assert.match(kvRow(switched, '可否对话'), /未验证/);
  assert.doesNotMatch(text(switched), /点「测试连接」或「探测模型」确认它真能用/);
});

test('明确不支持图像或仅生图成功，都不宣告可以对话', async () => {
  for (const supported of [false, true]) {
    const { ctx } = ctxOf({ probeResult: { ok: true, caps: { image: supported }, probes: { image: { supported } } } });
    const root = renderModelSettings(snap({ configured: true, baseUrl: `https://image-${supported}.example/v1` }), ctx);
    await button(root, '探测模型').listeners.click();
    assert.match(kvRow(root, '可否对话'), /未验证/);
  }
});

test('手填切到另一模型立即显示其未探测状态，草稿经重绘保留', async () => {
  const { ctx } = ctxOf();
  const s = () => snap({ configured: true, baseUrl: 'https://draft.example/v1' });
  const root = renderModelSettings(s(), ctx);
  await button(root, '探测模型').listeners.click();
  const input = nodes(root).find((n) => n.tagName === 'INPUT' && String(attr(n, 'placeholder')).includes('deepseek-chat'));
  input.value = 'new-model';
  input.listeners.input();
  const row = nodes(root).find((n) => attr(n, 'data-probe-row'));
  assert.match(text(row), /未探测/);
  const next = renderModelSettings(s(), ctx);
  const draft = nodes(next).find((n) => n.tagName === 'INPUT' && String(attr(n, 'placeholder')).includes('deepseek-chat'));
  assert.equal(draft.value, 'new-model');
});

test('目录接口抛出异常仍恢复按钮并允许手填', async () => {
  const { ctx } = ctxOf();
  ctx.onDetectModels = async () => { throw new Error('IPC disconnected'); };
  const root = renderModelSettings(snap({ configured: true, baseUrl: 'https://exception.example/v1' }), ctx);
  await button(root, '读取模型列表').listeners.click();
  assert.equal(button(root, '读取模型列表').disabled, false);
  assert.match(text(root), /IPC disconnected/);
});

/* ------------------------------------------------------------ 交互细节 */

test('★ 探测时会禁用按钮，防止连点发两次真实请求', async () => {
  let released = 0;
  const ctx = {
    onProbe: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          released += 1;
          resolve({ ok: true, caps: {}, probes: {}, channel: { label: 'x' } });
        }, 1);
      }),
    onDetectModels: async () => ({ ok: true, models: [{ id: 'm-1' }] }),
    onSaveSetting: async () => ({ ok: true }),
    onSaveApiKey: async () => ({ ok: true }),
    onClearApiKey: async () => ({ ok: true }),
    onTest: async () => ({ ok: true }),
  };
  const root = renderModelSettings(snap({ configured: true, baseUrl: 'https://i.example/v1' }), ctx);
  await button(root, '读取模型列表').listeners.click();
  const mid = renderModelSettings(snap({ configured: true, baseUrl: 'https://i.example/v1' }), ctx);
  const b = button(mid, '探测模型');
  const p = b.listeners.click();
  assert.equal(b.disabled, true, '请求期间要禁用');
  await p;
  assert.equal(b.disabled, false, '结束后要恢复');
  assert.equal(released, 1);
});
