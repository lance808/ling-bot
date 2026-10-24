/**
 * 分条链路自检 —— 真实模块，假 send
 *
 * ## 这个脚本和单测的分工
 *
 * 单测（`test/reply-*.test.mjs`）逐个断言**机制**，跑在 `node --test` 里。
 * 这个脚本跑的是**同一条链路串起来**的样子：一个模型输出进去，
 * 若干个气泡出来，中途经过解析、拆分、串行、闸门、记账。
 *
 * 为什么值得单独一个脚本：单测各自 mock 得很干净，而真正出问题时
 * 往往是**接线**错了（比如把 split 的结果喂给了错的参数），
 * 那种错误在"每个函数都对"的单测里看不见。
 *
 * ## 安全边界
 *
 * 只有 `send` 是假的。整条链路到**发送闸门之前**为止：
 * 不连 OneBot、不向真实 QQ 发消息、不调用模型。
 *
 * 用法：`node scripts/verify-reply-split.mjs`
 */

import { splitReply } from '../src/reply/split.mjs';
import { sendBurst, createSequencer } from '../src/reply/send.mjs';
import { deliverReply } from '../src/reply/deliver.mjs';

/** 按脚本返回结果的假 send（第 N 次用第 N 个结果，超出后复用最后一个） */
const scripted = (results) => {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
};

/** 造一个分条块 */
const block = (items) => ['```ling-msgs', JSON.stringify(items), '```'].join('\n');

let failed = 0;
/**
 * 一次检查。
 *
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

async function main() {
  console.log('分条链路自检（真实模块 + 假 send，不发 QQ）\n');

  /* ------------------------------------------------------ 解析 */

  const two = splitReply(block(['下午三点那个会我记着了。', '要我把资料先整理一版吗？']), { maxMessages: 3 });
  check('协议两条', two.mode === 'structured' && two.messages.length === 2, `条数 ${two.messages.length}`);

  const plain = splitReply('第一段。\n\n第二段。\n\n第三段。');
  check('普通换行不拆', plain.messages.length === 1, `条数 ${plain.messages.length}`);

  const code = '看这段\n```js\nconst a=1;\n\nconst b=2;\n```\n完事';
  check('代码块不拆', splitReply(code).messages.length === 1);

  const bad = ['```ling-msgs', '["没闭合', '```'].join('\n');
  const badR = splitReply(bad);
  check('坏 JSON 整条降级且保留原文', badR.mode === 'plain' && badR.messages[0].includes('没闭合'), badR.reason);

  const clamped = splitReply(block(['一', '二', '三', '四', '五']), { maxMessages: 3 });
  check('超上限并进最后一条', clamped.messages.length === 3 && clamped.clamped === true);

  /* ------------------------------------------------------ 发送 */

  const seq = createSequencer();
  const hist = [];
  const partial = await deliverReply({
    convKey: 'group:1',
    text: block(['第一条。', '第二条。', '第三条。']),
    config: { splitEnabled: true, maxMessages: 3, intervalMs: 800 },
    sequencer: seq,
    sleep: async () => {},
    send: scripted([{ ok: true }, { ok: false, code: 'E2030', message: '发送过快' }, { ok: true }]),
    onSent: (t) => hist.push(t),
    onDelivered: () => {},
  });
  check(
    '部分失败：其余照发、失败的不进历史',
    partial.sent.length === 2 && partial.failed.length === 1 && hist.length === 2,
    `sent=${partial.sent.length} failed=${partial.failed.length} 历史=${hist.length}`,
  );

  const order = [];
  const makeSend = (tag) => async () => {
    await new Promise((r) => setTimeout(r, 1));
    order.push(tag);
    return { ok: true };
  };
  await Promise.all([
    sendBurst({ convKey: 'g', messages: ['1', '2'], send: makeSend('A'), sequencer: seq, sleep: async () => {} }),
    sendBurst({ convKey: 'g', messages: ['1', '2'], send: makeSend('B'), sequencer: seq, sleep: async () => {} }),
  ]);
  check('同一会话两回合不交错', order.join('') === 'AABB', order.join(' '));

  const controller = new AbortController();
  const aborted = await sendBurst({
    convKey: 'g2',
    messages: ['1', '2', '3'],
    send: async () => {
      controller.abort();
      return { ok: true };
    },
    sequencer: seq,
    signal: controller.signal,
    sleep: async () => {},
  });
  check('中止停在消息边界', aborted.sent.length === 1 && aborted.aborted === true, `发出 ${aborted.sent.length} 条`);

  console.log('');
  if (failed > 0) {
    console.log(`${failed} 项未通过。`);
    process.exitCode = 1;
    return;
  }
  console.log('全部通过。');
}

await main();
