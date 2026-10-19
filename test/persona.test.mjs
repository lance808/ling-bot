/**
 * 人格卡存储 —— F8
 *
 * 重点守两件事：
 *   1. **旧格式自动迁移**：用户不该因为升级丢掉写了好久的人格
 *   2. **不会把自己删空**：删到最后一张必须被拦住
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PersonaStore, DEFAULT_PERSONA_LIMIT, clampLimit } from '../src/llm/persona.mjs';

/** @returns {Promise<{store: PersonaStore, file: string, dir: string}>} */
async function makeStore(seed) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-persona-'));
  const file = path.join(dir, 'persona.json');
  if (seed !== undefined) await fs.writeFile(file, JSON.stringify(seed), 'utf8');
  const store = new PersonaStore({ filePath: file });
  await store.load();
  return { store, file, dir };
}

test('迁移：旧格式 { text } 自动变成一张卡', async () => {
  const { store } = await makeStore({ text: '我是旧版人格', updatedAt: '2026-01-01T00:00:00.000Z' });

  assert.equal(store.cards.length, 1);
  assert.equal(store.cards[0].name, '默认人格');
  assert.equal(store.activeText(), '我是旧版人格');
  assert.ok(store.activeId);
});

test('迁移后会回写新格式（下次读就是 cards）', async () => {
  const { store, file } = await makeStore({ text: '旧内容' });
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));

  assert.equal(raw.version, 2);
  assert.ok(Array.isArray(raw.cards));
  assert.equal(raw.cards.length, 1);
});

test('新建：重名被拒', async () => {
  const { store } = await makeStore();
  const a = await store.create('助手', '内容');
  assert.equal(a.ok, true);

  const b = await store.create('助手', '别的内容');
  assert.equal(b.ok, false);
  assert.match(b.message, /同名/);
});

test('新建：空名被拒', async () => {
  const { store } = await makeStore();
  const r = await store.create('   ', 'x');
  assert.equal(r.ok, false);
});

test('更新：超限拒绝，且不静默截断', async () => {
  const { store } = await makeStore();
  const { card } = await store.create('卡', '短内容');

  const r = await store.update(card.id, { text: 'x'.repeat(DEFAULT_PERSONA_LIMIT + 1) });
  assert.equal(r.ok, false);
  assert.match(r.message, /超限/);

  // 原内容必须没被改动
  assert.equal(store.cards[0].text, '短内容');
});

test('更新：恰好等于上限可以保存', async () => {
  const { store } = await makeStore();
  const { card } = await store.create('卡', '');
  const r = await store.update(card.id, { text: 'x'.repeat(DEFAULT_PERSONA_LIMIT) });
  assert.equal(r.ok, true);
});

test('删除：最后一张不允许删（否则它就没可用人格了）', async () => {
  const { store } = await makeStore();
  await store.create('唯一', 'x');
  const r = await store.remove(store.activeId);
  assert.equal(r.ok, false);
  assert.match(r.message, /至少/);
});

test('删除：删掉使用中的卡会自动切到第一张', async () => {
  const { store } = await makeStore();
  await store.create('A', 'a');
  const { card: b } = await store.create('B', 'b');
  await store.activate(b.id);
  assert.equal(store.activeText(), 'b');

  const r = await store.remove(b.id);
  assert.equal(r.ok, true);
  assert.equal(store.activeText(), 'a', '删掉使用中的卡后要自动切走');
});

test('启用：不存在的 id 被拒', async () => {
  const { store } = await makeStore();
  await store.create('A', 'a');
  const r = await store.activate('p_not_exist');
  assert.equal(r.ok, false);
});

test('副本：内容一致、名字不同', async () => {
  const { store } = await makeStore();
  const { card } = await store.create('原卡', '原内容');
  const r = await store.duplicate(card.id);

  assert.equal(r.ok, true);
  const copy = store.cards.find((c) => c.id === r.card.id);
  assert.equal(copy.text, '原内容');
  assert.notEqual(copy.name, '原卡');
  assert.notEqual(copy.id, card.id);
});

test('持久化：新实例能读回全部卡片与启用状态', async () => {
  const { store, file } = await makeStore();
  await store.create('A', 'aaa');
  const { card: b } = await store.create('B', 'bbb');
  await store.activate(b.id);

  const store2 = new PersonaStore({ filePath: file });
  await store2.load();

  assert.equal(store2.cards.length, 2);
  assert.equal(store2.activeId, b.id);
  assert.equal(store2.activeText(), 'bbb');
});

test('view()：带字数，供界面显示', async () => {
  const { store } = await makeStore();
  await store.create('A', '12345');
  const v = store.view();

  assert.equal(v.limit, DEFAULT_PERSONA_LIMIT);
  assert.equal(v.cards.length, 1);
  assert.equal(v.cards[0].length, 5);
});

test('clampLimit：越界值被夹到合法区间', () => {
  assert.equal(clampLimit(100), 1000, '低于下限取 1000');
  assert.equal(clampLimit(99_999), 20_000, '高于上限取 20000');
  assert.equal(clampLimit(6000), 6000);
  assert.equal(clampLimit('abc'), DEFAULT_PERSONA_LIMIT);
});
