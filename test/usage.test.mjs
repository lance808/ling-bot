/**
 * 用量账本 —— 落盘与回读
 *
 * ## 这组测试针对的是一个真实缺陷
 *
 * `record()` 一直在往 usage.jsonl 追加，但启动时从来没有 `load()` 回读，
 * 于是每次打开应用「今日消耗」全归零 —— 用户看到的数字和实际花费无关。
 *
 * 落盘而不回读，比不落盘更糟：它让人以为数据被记住了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { UsageLedger } = await import('../src/llm/usage.mjs');

/** @param {number} at */
function rec(at, promptTokens, completionTokens, proactive = false) {
  return {
    at,
    convKey: 'group:100000001',
    model: 'deepseek-v4.1-flash',
    proactive,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: false,
  };
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-usage-'));
  return { dir, file: path.join(dir, 'usage.jsonl') };
}

/** @param {string} file @param {object[]} rows */
function seed(file, rows) {
  fs.writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}

test('启动时把今天的累计读回来（这是「每次打开都重置」的修复）', async () => {
  const { dir, file } = tempFile();
  const now = Date.now();
  seed(file, [rec(now - 5000, 300, 100), rec(now - 4000, 40, 20, true), rec(now - 3000, 7, 3)]);

  const ledger = new UsageLedger({ filePath: file });
  const restored = await ledger.load();
  const s = ledger.summary();

  assert.equal(restored.today, 3, '今天应有 3 次调用');
  assert.equal(s.today.calls, 3);
  assert.equal(s.today.totalTokens, 470);
  assert.equal(s.today.promptTokens, 347);
  assert.equal(s.today.completionTokens, 123);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('昨天的记录不进今日累计，但要留在 recent 里', async () => {
  const { dir, file } = tempFile();
  const now = Date.now();
  const day = 86_400_000;
  seed(file, [rec(now - day, 1000, 500), rec(now - day + 1000, 20, 10, true), rec(now - 1000, 30, 10)]);

  const ledger = new UsageLedger({ filePath: file });
  await ledger.load();
  const s = ledger.summary();

  assert.equal(s.today.calls, 1, '只有今天那条算进今日');
  assert.equal(s.today.totalTokens, 40);
  assert.equal(s.recent.length, 3, 'recent 应包含跨天的历史，便于查看最近调用');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('主动支出单独累计，占比按今日总量算', async () => {
  const { dir, file } = tempFile();
  const now = Date.now();
  seed(file, [rec(now - 2000, 100, 0, true), rec(now - 1000, 300, 0, false)]);

  const ledger = new UsageLedger({ filePath: file });
  await ledger.load();
  const s = ledger.summary();

  assert.equal(s.todayProactive.totalTokens, 100);
  assert.equal(s.today.totalTokens, 400);
  // 100 / 400 = 25%
  assert.equal(s.proactiveRatio, 25);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('坏行只跳过它自己，不拖垮整个文件的统计', async () => {
  const { dir, file } = tempFile();
  const now = Date.now();
  fs.writeFileSync(
    file,
    `${JSON.stringify(rec(now - 1000, 50, 50))}\n这不是 JSON\n{"at": "不是数字"}\n\n${JSON.stringify(rec(now - 500, 25, 25))}\n`,
    'utf8',
  );

  const ledger = new UsageLedger({ filePath: file });
  await ledger.load();
  const s = ledger.summary();

  assert.equal(s.today.calls, 2, '两条合法记录都要算进去');
  assert.equal(s.today.totalTokens, 150);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件不存在是首次运行，不报错也不崩', async () => {
  const { dir, file } = tempFile();
  const ledger = new UsageLedger({ filePath: file });
  const r = await ledger.load();

  assert.deepEqual(r, { loaded: 0, today: 0 });
  assert.equal(ledger.summary().today.calls, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('只读尾部：超过 limit 时不把整个文件读进 recent', async () => {
  const { dir, file } = tempFile();
  const now = Date.now();
  const rows = [];
  // 造 600 条（limit 是 500），全部是今天
  for (let i = 0; i < 600; i += 1) rows.push(rec(now - (600 - i) * 1000, 1, 1));
  seed(file, rows);

  const ledger = new UsageLedger({ filePath: file });
  await ledger.load();
  const s = ledger.summary();

  assert.equal(ledger.recent.length, 500, 'recent 上限是 500');
  assert.equal(s.today.calls, 600, '今日累计不受 recent 上限影响');
  assert.equal(s.today.totalTokens, 1200);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('回读之后再记录，累计是接着涨而不是从头开始', async () => {
  const { dir, file } = tempFile();
  const now = Date.now();
  seed(file, [rec(now - 2000, 100, 50)]);

  const ledger = new UsageLedger({ filePath: file });
  await ledger.load();
  assert.equal(ledger.summary().today.totalTokens, 150);

  await ledger.record({ convKey: 'group:100000001', model: 'm', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false } });

  const s = ledger.summary();
  assert.equal(s.today.calls, 2);
  assert.equal(s.today.totalTokens, 165);

  // 也要真的写追加进文件，下次启动还能读到
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('回读不重复计数：load 调两次结果不变', async () => {
  const { dir, file } = tempFile();
  const now = Date.now();
  seed(file, [rec(now - 2000, 100, 50), rec(now - 1000, 10, 5)]);

  const ledger = new UsageLedger({ filePath: file });
  await ledger.load();
  const first = ledger.summary().today.totalTokens;
  await ledger.load();
  const second = ledger.summary().today.totalTokens;

  assert.equal(first, second, 'load 必须重建而不是累加，否则数字会翻倍');
  assert.equal(second, 165);

  fs.rmSync(dir, { recursive: true, force: true });
});
