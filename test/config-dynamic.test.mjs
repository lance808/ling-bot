/**
 * 配置校验里的动态字典
 *
 * ## 这条规则为什么值得单独测
 *
 * `mergeStrict` 的职责是发现**拼错的配置项**（`timeoutMs` 写成 `timeout`），
 * 所以它要求每个键都在默认值里存在。
 *
 * 但 `llm.modelCapabilities` 是 `{ [模型名]: {...} }` —— 键来自用户数据。
 * 它的默认值是 `{}`，于是每个模型名都被判成"未知配置项"。
 *
 * 后果不是警告，是**应用起不来**：
 *
 *   1. 用户在界面上点「探测能力」
 *   2. 探测结果写进 config.json：`modelCapabilities: { "deepseek-v4.1": {...} }`
 *   3. 下次启动 → E40XX「存在未知配置项：llm.modelCapabilities.deepseek-v4.1」
 *   4. 后端反复重启失败，界面一片空白
 *
 * 真踩到了，所以这里钉住两个方向：
 *   - 动态键要放行
 *   - 真正的拼写错误仍然要抓
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config/schema.mjs';
import { resolveThinkingBody } from '../src/llm/client.mjs';

test('未配置思考风格时默认发送 reasoning_effort: medium，保留显式选择', () => {
  for (const saved of [{}, { llm: { model: 'deepseek-v4.1-flash' } }]) {
    const cfg = validateConfig(saved);
    assert.equal(cfg.llm.thinking, 'openai');
    assert.deepEqual(resolveThinkingBody(cfg.llm.thinking), { reasoning_effort: 'medium' });
  }
  const explicit = validateConfig({ llm: { thinking: 'auto' } });
  assert.equal(explicit.llm.thinking, 'auto');
  assert.deepEqual(resolveThinkingBody(explicit.llm.thinking), {});
});

test('环境页保存的安装路径经配置序列化后仍能启动', () => {
  const saved = JSON.parse(JSON.stringify({
    qqExe: 'C:/Apps/QQ/QQ.exe',
    snowlumaDir: 'C:/Apps/SnowLuma',
  }));
  const cfg = validateConfig(saved);
  assert.equal(cfg.qqExe, saved.qqExe);
  assert.equal(cfg.snowlumaDir, saved.snowlumaDir);
  assert.throws(() => validateConfig({ qqExee: saved.qqExe }), /未知配置项/);
});

test('★ modelCapabilities 里的模型名不算未知配置项', () => {
  const cfg = validateConfig({
    llm: {
      model: 'deepseek-v4.1',
      modelCapabilities: {
        'deepseek-v4.1': { vision: true, probedAt: '2026-10-19T00:00:00Z' },
        'some-other-model': { vision: false },
      },
    },
  });
  assert.equal(Object.keys(cfg.llm.modelCapabilities).length, 2);
  assert.equal(cfg.llm.modelCapabilities['deepseek-v4.1'].vision, true);
  assert.equal(cfg.llm.modelCapabilities['some-other-model'].vision, false);
});

test('★ modelCapabilities 不是对象要报错', () => {
  // 豁免的是"键名任意"，不是"什么值都收"
  assert.throws(() => validateConfig({ llm: { modelCapabilities: ['a'] } }), /必须是对象/);
  assert.throws(() => validateConfig({ llm: { modelCapabilities: null } }), /必须是对象/);
});

test('★ 真正的拼写错误仍然要抓出来', () => {
  // 动态字典的豁免不能把整个校验放开
  assert.throws(() => validateConfig({ llm: { timeout: 5000 } }), /未知配置项/);
  assert.throws(() => validateConfig({ llm: { provider: 'x' }, typo: 1 }), /未知配置项/);
});

test('★ 嵌套在动态字典里的值不做深度校验', () => {
  // 里面存的是探测结论，形状由 llm.probe 决定，配置层不该理解它
  const cfg = validateConfig({
    llm: {
      modelCapabilities: {
        m1: { vision: true, image: false, channel: 'openai', probedAt: 'x', 任意字段: 1 },
      },
    },
  });
  assert.equal(cfg.llm.modelCapabilities.m1.channel, 'openai');
});
