/**
 * 集成：真实 ThinkingStore + 真实 RPC 调度器。
 *
 * 为什么不用管道跑真进程：后端 boot 是异步的，且 stdin EOF 会让进程退出，
 * 探针拿到的常常是 booting 快照 —— 那测的是时序，不是行为。
 * 这里把**真实的 store** 注入 vm 里的**真实 rpc 源码**，测的是同一条代码路径，
 * 但没有进程和时序的不确定性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeDsh } from '../src/config/dsh.mjs';
import { ThinkingStore } from '../src/llm/thinking.mjs';

const SOURCE = new URL('../src/index.mjs', import.meta.url);

async function rpcWith(store) {
  const source = await fs.readFile(SOURCE, 'utf8');
  const code = source.slice(source.indexOf('const rpc = {'), source.indexOf('/** 界面可见的配置')) + '\nrpc;';
  const context = {
    normalizeDsh,
    config: { dsh: { enabled: false, token: '' }, llm: { apiKey: '' } },
    paths: { configPath: 'fictional' },
    writeJsonAtomic: async () => {},
    pluginMods: [],
    sendText: () => {},
    log: { info: () => {}, warn: () => {} },
    usageLedger: { range: async (q) => ({ ...q, calls: 0 }) },
    thinkingStore: store,
    personaStore: {},
    roleStore: {},
  };
  return vm.runInNewContext(code, context);
}

/** 建一个装了真实数据的临时 store */
async function seededStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'think-int-'));
  const at = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const store = new ThinkingStore({ dir, now: () => at + 60_000 });
  store.record({
    convKey: 'group:111',
    at,
    steps: [{ n: 1, reasoning: '群里的思考', tools: ['web_search'], answerPreview: '答案A' }],
  });
  store.record({ convKey: 'private:222', at: at + 1000, steps: [{ n: 1, reasoning: '私聊的思考' }] });
  await store.flush();
  // 用新实例重新加载：验证的是"落盘后能读回来"，而不是只靠内存
  const reloaded = new ThinkingStore({ dir, now: () => at + 120_000 });
  await reloaded.load();
  return { store: reloaded, dir };
}

test('★ 集成：落盘 → 重启读取 → 快照里的 thinking 字段完整', async () => {
  const { store } = await seededStore();
  const rpc = await rpcWith(store);

  const view = rpc.thinkingView({ days: 7 });
  assert.equal(view.total, 2, '重启后两条记录都要在');
  assert.deepEqual(view.days.map((d) => d.date), ['2026-10-19']);
  assert.deepEqual(view.dayKeys, ['2026-10-19']);

  // 左栏数据源：群聊与私聊各一条，按最近记录倒序
  assert.deepEqual(view.conversations.map((c) => c.convKey), ['private:222', 'group:111']);
  assert.equal(view.conversations.find((c) => c.convKey === 'group:111').steps, 1);

  // 步骤内容要原样带出来（工具名、回答预览都不能丢）
  const step = view.days[0].entries.find((e) => e.convKey === 'group:111').steps[0];
  assert.equal(step.reasoning, '群里的思考');
  assert.deepEqual(step.tools, ['web_search']);
  assert.equal(step.answerPreview, '答案A');
});

test('★ 集成：thinking.clear 删某一天 → 文件消失、视图同步、另一天不受影响', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'think-int2-'));
  const day1 = new Date(2026, 9, 18, 12, 0, 0).getTime();
  const day2 = new Date(2026, 9, 19, 12, 0, 0).getTime();
  const store = new ThinkingStore({ dir, now: () => day2 + 60_000 });

  store.record({ convKey: 'group:111', at: day1, steps: [{ n: 1, reasoning: '前一天' }] });
  store.record({ convKey: 'group:111', at: day2, steps: [{ n: 1, reasoning: '当天' }] });
  await store.flush();

  const rpc = await rpcWith(store);
  const before = rpc.thinkingView({ days: 7 });
  assert.deepEqual(before.dayKeys, ['2026-10-18', '2026-10-19']);

  const res = await rpc.handle('action', { name: 'thinking.clear', params: { date: '2026-10-18' } });
  assert.equal(res.ok, true);
  assert.equal(res.removed, 1);

  const after = rpc.thinkingView({ days: 7 });
  assert.deepEqual(after.dayKeys, ['2026-10-19'], '被删的那一天要从索引里一起消失');
  assert.equal(after.total, 1);

  const files = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  assert.deepEqual(files, ['2026-10-19.json'], '磁盘上只能剩另一天');
});

test('★ 集成：删掉全部记录后左栏是空的，但仍然是一个合法视图', async () => {
  const { store } = await seededStore();
  const rpc = await rpcWith(store);
  await rpc.handle('action', { name: 'thinking.clear', params: { date: '2026-10-19' } });

  const view = rpc.thinkingView({ days: 7 });
  assert.deepEqual(view.days, []);
  assert.deepEqual(view.conversations, []);
  assert.deepEqual(view.dayKeys, []);
  assert.equal(view.total, 0);
  assert.equal(view.hasMore, false);
});

test('★ 集成：按会话收窄时，哪怕该会话的旧记录不在最新一页里也能查到', async () => {
  /*
   * 这条钉的是一个真实的界面矛盾：
   *
   * 左栏是"全量目录"（会话可能很多），右栏默认只取最近 50 条。
   * 如果点开一个只有旧记录的会话、却不把 convKey 传给后端，
   * 右栏就会说"暂无记录"，而左栏写着"3 回合" —— 用户会以为记录丢了。
   *
   * 所以界面必须把 convKey 传下去（app.mjs 的 pull 已经这么做）。
   * 这里验证后端确实会按它重算，而不是只在返回结果上贴个标签。
   */
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'think-int3-'));
  const base = new Date(2026, 9, 19, 0, 0, 0).getTime();
  const store = new ThinkingStore({ dir, now: () => base + 86_400_000 });

  // 先塞 60 条"别的会话"的新记录，把页面撑满
  for (let i = 0; i < 60; i += 1) {
    store.record({ convKey: 'group:999', at: base + 3_600_000 + i * 1000, steps: [{ n: 1, reasoning: `噪声${i}` }] });
  }
  // 再塞一条很旧的、来自另一个会话的记录
  store.record({ convKey: 'group:111', at: base, steps: [{ n: 1, reasoning: '很久以前的那次' }] });
  await store.flush();

  const rpc = await rpcWith(store);

  // 不筛选：这一页全是噪声，旧记录排不进来
  const all = rpc.thinkingView({ days: 7, limit: 50 });
  assert.equal(all.days.flatMap((d) => d.entries).some((e) => e.convKey === 'group:111'), false, '默认页里看不到它');

  // 左栏目录仍然完整（目录必须包含它，否则用户根本点不到）
  assert.ok(all.conversations.some((c) => c.convKey === 'group:111'), '目录里必须有这个会话');

  // 按该会话收窄：能查到
  const one = rpc.thinkingView({ days: 7, limit: 50, convKey: 'group:111' });
  const hits = one.days.flatMap((d) => d.entries);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].steps[0].reasoning, '很久以前的那次');
  // 收窄后目录还是完整的：它是"目录"，不能被筛选裁掉
  assert.equal(one.conversations.length, 2);
});
