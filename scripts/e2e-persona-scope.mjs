/**
 * 人格卡作用范围 —— 端到端。
 *
 * ## 这里最该验证的是"匹配优先级"
 *
 * 界面上能做三件事（选全局/选群/选私聊）很容易，
 * 真正会出错的是**解析**：某个群到底命中哪张卡？
 *
 * 规则：private > group > global。如果这条错了，表现是
 * "我明明给这个群写了人格，它却还在用全局那张" —— 而界面上
 * 一切看起来都正常。所以这里直接打后端，并且逐条验证优先级。
 *
 * 用法：node scripts/e2e-persona-scope.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PersonaStore } from '../src/llm/persona.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const results = [];
const check = (ok, label) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '✓' : '✖'} ${label}`);
};

/* ================================================ 第一层：纯逻辑 */

async function pureChecks() {
console.log('【解析优先级】');

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-scope-'));
  const store = new PersonaStore({ filePath: path.join(tmp, 'persona.json') });
  await store.load();

  const g = await store.create('全局人格', '我是全局的', 'global');
  const grp = await store.create('某群专属', '我只在这个群', 'group', '111111');
  const prv = await store.create('某人专属', '我只对这个私聊', 'private', '222222');

  check(g.ok && grp.ok && prv.ok, '三种范围都能创建');

  check(store.resolveFor('group:111111')?.id === grp.card.id, '群 111111 命中群专属卡');
  check(store.resolveFor('private:222222')?.id === prv.card.id, '私聊 222222 命中私聊专属卡');
  check(store.resolveFor('group:999999')?.id === g.card.id, '没专属卡的群回退到全局');
  check(store.resolveFor('private:888888')?.id === g.card.id, '没专属卡的私聊回退到全局');

  // 同号既是群又是私聊：各自匹配，不能串
  await store.create('同号私聊', '私聊版本', 'private', '111111');
  check(
    store.resolveFor('group:111111')?.name === '某群专属',
    '群 111111 仍然命中群卡（私聊专属不抢群的）',
  );
  check(
    store.resolveFor('private:111111')?.name === '同号私聊',
    '私聊 111111 命中私聊卡',
  );

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n【写入约束】');

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-scope2-'));
  const store = new PersonaStore({ filePath: path.join(tmp, 'persona.json') });
  await store.load();

  await store.create('A', '', 'group', '555555');
  const dupRange = await store.create('B', '', 'group', '555555');
  check(dupRange.ok === false, '同一个群不能有两张专属卡');
  check(String(dupRange.message ?? '').includes('已经有一张'), `给了明确提示（${dupRange.message}）`);

  const badId = await store.create('C', '', 'group', 'abc');
  check(badId.ok === false, '群号非法被拒');
  check(String(badId.message ?? '').includes('不是有效'), '提示说了格式问题');

  const noId = await store.create('D', '', 'private', '');
  check(noId.ok === false, '私聊不填号被拒');

  // 同名不同范围允许
  await store.create('同名', '', 'group', '666666');
  const sameName = await store.create('同名', '', 'group', '777777');
  check(sameName.ok === true, '不同范围可以有同名卡');

  // 同名同范围拒绝
  const sameBoth = await store.create('同名', '', 'group', '666666');
  check(sameBoth.ok === false, '同范围同名被拒');

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n【旧数据迁移】');

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-scope3-'));
  const p = path.join(tmp, 'persona.json');
  // 写一份旧格式：没有 scope 字段
  fs.writeFileSync(
    p,
    JSON.stringify({
      version: 2,
      activeId: 'p_old',
      cards: [{ id: 'p_old', name: '老卡', text: '升级前写的', updatedAt: '' }],
    }),
    'utf8',
  );
  const store = new PersonaStore({ filePath: p });
  await store.load();

  check(store.cards.length === 1, '旧卡没有被丢掉');
  check(store.cards[0].scope === 'global', '旧卡被补成 global');
  check(store.cards[0].scopeId === '', 'global 的 scopeId 是空串');
  check(store.resolveFor('group:123456')?.name === '老卡', '旧卡仍然全局生效');

  fs.rmSync(tmp, { recursive: true, force: true });
}

}

/* ================================================ 第二层：真实后端 */

console.log('\n【后端 RPC】');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-scope-rpc-'));
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });

const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'index.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, LING_USER_DATA: tmpHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
/** @type {null | (() => void)} */
let readyWait = null;
/** @type {Map<number, (v: any) => void>} */
const waiting = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === 'event' && msg.params?.event === 'ready' && typeof readyWait === 'function') {
      const fn = readyWait;
      readyWait = null;
      fn();
    }
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(method + ' 超时'));
    }, 20000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        console.error('RAW ERROR:', JSON.stringify(msg).slice(0, 600));
        reject(new Error(String(msg.error.message ?? msg.error.code ?? 'unknown')));
      }
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const act = (name, params) => rpc('action', { name, params });

async function main() {
  await pureChecks();

  /*
   * 必须等后端真正 ready 才发 snapshot。
   *
   * 只 poll "booting 字段"是不够的：snapshot 里有 usageLedger.summary()，
   * 而 usageLedger 是在 boot() 中途才赋值的。boot 没走完就去读，
   * 会抛 "Cannot read properties of undefined (reading 'summary')" ——
   * 看起来像人格代码坏了，其实只是问得太早。
   */
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后端 20 秒内没有 ready')), 20000);
    readyWait = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  let snap = await rpc('snapshot');
  for (let i = 0; i < 40 && snap?.booting; i++) {
    await new Promise((r) => setTimeout(r, 250));
    snap = await rpc('snapshot');
  }

  const pcs = snap.personaCards;
  if (!pcs || !Array.isArray(pcs.cards) || pcs.cards.length === 0) {
    console.error('✖ snapshot 里没有 personaCards.cards，实际：', JSON.stringify(Object.keys(snap)));
    child.kill();
    process.exit(1);
  }
  const base = pcs.cards[0];
  check(base.scope === 'global', `默认卡是 global（${base.scope}）`);
  check(base.scopeId === '', 'global 的 scopeId 为空');

  // 建一张群专属
  const made = await act('persona.create', {
    name: '群专属',
    text: '我在这个群话很少',
    scope: 'group',
    scopeId: '123456',
  });
  check(made?.ok === true, '能通过 RPC 建群专属卡');
  check(made?.card?.scope === 'group', '返回的卡 scope 是 group');
  check(made?.card?.scopeId === '123456', 'scopeId 正确');

  snap = await rpc('snapshot');
  const found = snap.personaCards.cards.find((c) => c.id === made.card.id);
  check(found?.scope === 'group', '快照里带着 scope');

  // 改范围
  const moved = await act('persona.update', { id: made.card.id, scope: 'private', scopeId: '777777' });
  check(moved?.ok === true, '能改作用范围');
  snap = await rpc('snapshot');
  const after = snap.personaCards.cards.find((c) => c.id === made.card.id);
  check(after?.scope === 'private' && after?.scopeId === '777777', '范围改成了 private:777777');

  // 改回全局，scopeId 应清空
  const back = await act('persona.update', { id: made.card.id, scope: 'global' });
  check(back?.ok === true, '能改回全局');
  snap = await rpc('snapshot');
  const g2 = snap.personaCards.cards.find((c) => c.id === made.card.id);
  check(g2?.scopeId === '', '改回全局时 scopeId 被清空');

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 作用范围全链路正确' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'shutdown', params: {} }) + '\n');
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('✖', e && e.stack ? e.stack : e);
  child.kill();
  process.exit(1);
});
