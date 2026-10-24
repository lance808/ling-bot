/**
 * 去图重试的工具守卫 —— 防止"同一张图/同一句话被发两遍"。
 *
 * ## 这个文件在守什么
 *
 * 上游拒收图片时，`src/index.mjs` 的 `startTurn` 会**整轮重跑**：
 * 把带 `image_url` 的消息退回纯文本，再喂一次模型。
 *
 * 问题在于工具副作用不会回滚。第一次尝试里模型可能已经：
 *   · `ctx.chat.send` 发过一句话；
 *   · `ctx.chat.sendMedia` / `sendFace` 发过一张图或表情；
 *   · 生图插件的后台任务投递过一张已生成的图。
 *
 * 这些都已经真实出现在 QQ 里。重试如果继续把同一批工具交给模型，
 * 它多半会再调一次 —— 用户看到"同一张图两条"，而日志里只有一次成功回合，
 * 极难排查。
 *
 * 所以判定是：**第一次尝试调用过工具 → 重试轮不给任何工具**；
 * 一次都没调用过（没有副作用可重复）→ 原样保留工具，避免无谓地
 * 让本来能答的问题答不出来。
 *
 * ## 为什么单独抽一个可导出函数
 *
 * `startTurn` 需要真的 boot 后端 + 真实上游拒收才能走到，测试里做不到
 * （沙箱禁子进程，也不该调收费模型）。把判定抽成纯函数后，这里可以
 * **直接调用它**验证行为，而不是靠读源码正则去"证明"那段逻辑存在。
 * 源码断言只用来锁接线（重试那一轮确实用了这个 runner）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildImageRetryRunner } from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'src', 'index.mjs');

/** 造一个最简 runner：真的有两把工具、真的能被调用 */
function fakeRunner() {
  const calls = [];
  return {
    calls,
    availableTools: () => [{ name: 'plugin_sticker_send' }, { name: 'plugin_image_generate' }],
    run: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, result: { text: 'sent' } };
    },
  };
}

test('第一次尝试没调用过工具：原样返回同一个 runner（不为重试凭空削能力）', () => {
  const runner = fakeRunner();
  assert.equal(buildImageRetryRunner(runner, 0), runner);
  // 非数字/负数也按"没调用过"处理，绝不能把一次真实回答变成没有工具
  assert.equal(buildImageRetryRunner(runner, undefined), runner);
  assert.equal(buildImageRetryRunner(runner, -1), runner);
  // 原 runner 的工具仍然在
  assert.equal(runner.availableTools().length, 2);
});

test('★ 第一次尝试调用过工具：重试轮一个工具都不给', () => {
  const runner = fakeRunner();
  const retry = buildImageRetryRunner(runner, 3);

  assert.notEqual(retry, runner, '必须换成一个不带工具的 runner');
  assert.deepEqual(retry.availableTools(), [], '模型看不到任何工具，就不会发起调用');

  // 即使模型硬调，也拿不到执行结果 —— 这里要的是"不可能产生副作用"
  return retry.run('plugin_sticker_send', {}).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E4071');
    assert.equal(runner.calls.length, 0, '原 runner 一次都不能被调用');
  });
});

test('重试 runner 的 run 不依赖参数：任何工具名都被挡住', async () => {
  const retry = buildImageRetryRunner(fakeRunner(), 1);
  for (const name of ['plugin_sticker_send', 'plugin_image_generate', 'fs_read']) {
    const r = await retry.run(name, { any: 'thing' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E4071');
  }
});

test('接线：startTurn 的重试确实用这个 runner，且第一次尝试仍用原 runner', async () => {
  const src = await fs.readFile(ENTRY, 'utf8');

  // 第一次尝试：正常 runner
  assert.match(
    src,
    /result = await runOnce\(messagesForModel\);/,
    '第一次尝试必须用本回合的 runner（带工具）',
  );
  // 重试：换成守卫过的 runner
  assert.match(
    src,
    /const retryRunner = buildImageRetryRunner\(runner, toolCallsThisTurn\);/,
    '重试必须经过 buildImageRetryRunner',
  );
  assert.match(
    src,
    /result = await runOnce\(usedMessages, retryRunner\);/,
    '重试那一轮必须传入 retryRunner，否则守卫形同虚设',
  );

  // 计数必须真的在工具回调里递增（否则守卫永远看到 0）
  assert.match(src, /onToolCall: \(info\) => \{\s*toolCallsThisTurn \+= 1;/);

  // runOnce 必须接受 runner 覆盖，否则第二参数会被静默忽略
  assert.match(src, /const runOnce = async \(msgs, attemptRunner = runner\) =>/);
  assert.match(src, /runner: attemptRunner,/);
});
