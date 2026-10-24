/**
 * 联网总闸切换 —— 顺序、失败方向、持久化挂起
 *
 * ## 这个文件守什么
 *
 * 「关掉联网」不是一次普通配置写入，它有两条**安全方向**的硬要求：
 *
 *   1. **先生效、后落盘**：点关闭的那一刻起，新请求必须被拒、在途请求
 *      必须立刻停；磁盘慢（杀毒扫描 / 网络盘）不能让这几百毫秒变成
 *      "我关了它还在联网"。
 *   2. **落盘失败保持关闭**：保存失败时绝不能把内存里的开关反弹回 true，
 *      否则界面显示"开"、用户以为已经关了。
 *
 * 打开则相反：先确认保存成功再生效（保存失败时保持关闭才是安全方向）。
 *
 * 这里用假的 `commit / save / abortInflight` 直接钉住顺序与失败路径 ——
 * 不需要真的写 config.json，也不碰真实配置。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyNetworkToggle, NET_TOGGLE_SAVE_FAILED } from '../src/net/toggle.mjs';

/**
 * 造一套可观测的桩。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.saveOk] save 是否成功（false = 抛错）
 * @param {Error} [opts.saveError]
 * @param {number|Error} [opts.abortResult] 返回中止数量，或抛错
 * @param {Promise<any>} [opts.saveGate] 用外部可控 Promise 卡住落盘
 */
function harness(opts = {}) {
  /** @type {string[]} */
  const order = [];
  let current = opts.initial ?? false;
  /** @type {boolean[]} */
  const commits = [];
  let aborts = 0;

  const saveImpl = async (value) => {
    order.push(`save:${value}`);
    if (opts.saveGate) await opts.saveGate;
    if (opts.saveOk === false || opts.saveError) {
      throw opts.saveError ?? new Error('磁盘只读');
    }
  };

  return {
    order,
    commits,
    get current() {
      return current;
    },
    get aborts() {
      return aborts;
    },
    input: {
      commit: (value) => {
        order.push(`commit:${value}`);
        commits.push(value);
        current = value;
      },
      save: saveImpl,
      abortInflight: () => {
        order.push('abort');
        aborts += 1;
        if (opts.abortResult instanceof Error) throw opts.abortResult;
        return typeof opts.abortResult === 'number' ? opts.abortResult : opts.abortCount ?? 0;
      },
    },
  };
}

/* ------------------------------------------------------------ 参数校验 */

test('★ value 不是布尔 → ok:false，且不 commit / 不 save / 不 abort', async () => {
  for (const value of ['false', 'true', 0, 1, null, undefined, {}, []]) {
    const h = harness();
    const r = await applyNetworkToggle({ value, ...h.input });
    assert.equal(r.ok, false, `${JSON.stringify(value)} 不是布尔，必须拒绝`);
    assert.equal(r.persisted, false);
    assert.ok(typeof r.message === 'string' && r.message.length > 0, '必须给一句人话说明');
    assert.deepEqual(h.order, [], `${JSON.stringify(value)}：拒绝时不得产生任何副作用`);
    assert.deepEqual(h.commits, []);
    assert.equal(h.aborts, 0);
  }
});

/* ------------------------------------------------------------ 关闭 */

test('★ 关闭顺序：同步 commit(false) → abortInflight() → await save(false)', async () => {
  const h = harness({ abortCount: 2 });
  const r = await applyNetworkToggle({ value: false, ...h.input });

  assert.deepEqual(h.order, ['commit:false', 'abort', 'save:false'], '顺序必须是先生效、再中止、最后落盘');
  assert.equal(h.current, false);
  assert.equal(r.ok, true);
  assert.equal(r.closed, true, '返回值必须明确"现在是关着的"');
  assert.equal(r.persisted, true);
  assert.equal(r.aborted, 2, '中止数量要如实带回');
});

test('★ 关闭是**同步生效**的：函数返回 Promise 时内存状态已经变了', async () => {
  const h = harness();
  const pending = applyNetworkToggle({ value: false, ...h.input });
  // 还没 await：关闭必须已经落到内存里（否则磁盘慢的窗口期仍然能联网）
  assert.deepEqual(h.commits, [false], 'commit(false) 必须在第一个 await 之前完成');
  assert.equal(h.aborts, 1, '在途请求必须在第一个 await 之前就被中止');
  const r = await pending;
  assert.equal(r.ok, true);
});

test('★ 关闭时持久化挂起：关闭与中止都已经生效，持久化仍未完成', async () => {
  /** @type {(v?: any) => void} */
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ saveGate: gate });
  let settled = false;
  const pending = applyNetworkToggle({ value: false, ...h.input }).then((r) => {
    settled = true;
    return r;
  });

  await Promise.resolve();
  assert.equal(h.current, false, '落盘挂起期间关闭必须已经生效');
  assert.deepEqual(h.commits, [false]);
  assert.equal(h.aborts, 1, '落盘挂起期间在途请求必须已经中止');
  assert.equal(settled, false, '落盘未完成前不该声称已完成');

  release();
  const r = await pending;
  assert.equal(r.ok, true);
  assert.equal(r.persisted, true);
  assert.deepEqual(h.order, ['commit:false', 'abort', 'save:false']);
});

test('★ 关闭时保存失败 → ok:false / closed:true / persisted:false，且不反弹回开', async () => {
  const h = harness({ saveOk: false });
  const r = await applyNetworkToggle({ value: false, ...h.input });

  assert.equal(r.ok, false, '保存失败必须如实报告');
  assert.equal(r.closed, true, '安全方向已经生效：现在是关着的');
  assert.equal(r.persisted, false, '没保存成功');
  assert.equal(h.current, false, '内存状态必须保持关闭（绝不反弹回 true）');
  assert.deepEqual(h.commits, [false], '只能 commit 一次（false）');
  assert.match(r.message, /关闭|保存/, 'message 要说明"已关闭但没保存成功"');
});

test('★ 关闭时中止在途抛错：不阻止保存，错误信息带回来', async () => {
  const h = harness({ abortResult: new Error('取消在途失败') });
  const r = await applyNetworkToggle({ value: false, ...h.input });

  assert.ok(h.order.includes('save:false'), '中止失败不能跳过落盘');
  assert.equal(h.current, false, '关闭依然生效');
  assert.equal(r.closed, true);
  assert.equal(r.persisted, true, '保存仍然成功');
  assert.ok(
    String(r.abortError ?? r.message ?? '').includes('取消在途失败'),
    `返回值必须带出中止错误（实际 ${JSON.stringify(r)}）`,
  );
});

test('关闭时 abortInflight 返回脏值 → aborted 归一成 0', async () => {
  for (const dirty of [undefined, null, -1, '3', Number.NaN]) {
    const h = harness();
    h.input.abortInflight = () => {
      h.order.push('abort');
      return dirty;
    };
    const r = await applyNetworkToggle({ value: false, ...h.input });
    assert.equal(r.ok, true, `脏值 ${String(dirty)} 不该让关闭失败`);
    assert.equal(r.aborted, 0, `脏值 ${String(dirty)} 应归一成 0`);
  }
});

/* ------------------------------------------------------------ 打开 */

test('★ 打开顺序：先 await save(true)，成功后才 commit(true)', async () => {
  const h = harness({ initial: false });
  const r = await applyNetworkToggle({ value: true, ...h.input });

  assert.deepEqual(h.order, ['save:true', 'commit:true'], '打开必须先保存成功再生效');
  assert.equal(h.current, true);
  assert.equal(r.ok, true);
  assert.equal(r.closed, false);
  assert.equal(r.persisted, true);
  assert.equal(r.aborted, 0, '打开时没有在途请求要中止');
});

test('★ 打开时持久化挂起：提交必须等到保存成功之后', async () => {
  /** @type {(v?: any) => void} */
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ saveGate: gate });
  const pending = applyNetworkToggle({ value: true, ...h.input });

  await Promise.resolve();
  assert.deepEqual(h.commits, [], '保存还在挂起时不得提前 commit(true)');
  assert.equal(h.current, false, '此刻仍应保持关闭');
  assert.deepEqual(h.order, ['save:true']);

  release();
  const r = await pending;
  assert.deepEqual(h.order, ['save:true', 'commit:true']);
  assert.equal(r.ok, true);
  assert.equal(h.current, true);
});

test('★ 打开时保存失败 → 保持关闭、ok:false、不 commit', async () => {
  const h = harness({ saveOk: false });
  const r = await applyNetworkToggle({ value: true, ...h.input });

  assert.equal(r.ok, false, '保存失败不能声称已打开');
  assert.equal(r.code, NET_TOGGLE_SAVE_FAILED, `应返回 ${NET_TOGGLE_SAVE_FAILED}（已按安全方向生效但没保存）`);
  assert.equal(r.closed, true, '仍然保持关闭');
  assert.equal(r.persisted, false);
  assert.deepEqual(h.commits, [], '保存失败绝不能 commit(true)');
  assert.equal(h.current, false);
  assert.match(r.message, /关闭/, 'message 要说明联网仍保持关闭');
});
