/**
 * 人格卡 5 个动作 —— 直接打后端，不经过界面。
 *
 * ## 为什么要先单独测后端
 *
 * 用户报了三件事：不能新建、不能保存、不能删除。这三条可能全部是
 * 界面问题，也可能后端也有问题。先隔离变量：如果后端 5 个动作都正常，
 * 那问题就 100% 在界面层，不用去翻存储代码。
 *
 * 用法：node scripts/e2e-persona.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const results = [];
const check = (ok, label) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '✓' : '✖'} ${label}`);
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-persona-'));
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

let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString('utf8');
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${method} 超时`));
    }, 20000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const act = (name, params) => rpc('action', { name, params });

async function main() {
  /*
   * 等 ready 再问 snapshot。
   *
   * 只 poll booting 字段不够：snapshot 里有 usageLedger.summary()，
   * usageLedger 是 boot() 中途才赋值的。问太早会抛
   * "reading 'summary'"，看着像数据坏了，其实只是还没到那一步。
   */
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后端 20 秒内没有 ready')), 20000);
    readyWait = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  let snap = await rpc('snapshot');

  const initial = snap.personaCards?.cards ?? [];
  check(initial.length >= 1, `启动时至少有 1 张卡（实际 ${initial.length}）`);
  check(typeof snap.personaCards?.activeId === 'string' && snap.personaCards.activeId !== '', '有 activeId');

  /* ---------------------------------------------- 新建 */

  const created = await act('persona.create', { name: '测试卡 A', text: '' });
  check(created?.ok === true, `新建成功（${created?.message ?? 'ok'}）`);

  snap = await rpc('snapshot');
  const afterCreate = snap.personaCards?.cards ?? [];
  check(afterCreate.length === initial.length + 1, `卡片数 +1（${initial.length} → ${afterCreate.length}）`);
  check(
    afterCreate.some((c) => c.name === '测试卡 A'),
    '新卡名字正确',
  );

  /* ---------------------------------------------- 重名 */

  const dup = await act('persona.create', { name: '测试卡 A', text: '' });
  check(dup?.ok === false, '重名被拒绝');

  /* ---------------------------------------------- 保存内容+改名 */

  const target = afterCreate.find((c) => c.name === '测试卡 A');
  const saved = await act('persona.update', {
    id: target.id,
    name: '改名后的卡',
    text: '你是一只话很少的猫。',
  });
  check(saved?.ok === true, `保存成功（${saved?.message ?? 'ok'}）`);

  snap = await rpc('snapshot');
  const afterSave = (snap.personaCards?.cards ?? []).find((c) => c.id === target.id);
  check(afterSave?.name === '改名后的卡', '名字改了');
  check(afterSave?.text === '你是一只话很少的猫。', '内容存了');
  check(afterSave?.length === 10, `字数对得上（实际 ${afterSave?.length}）`);

  /* ---------------------------------------------- 切换 */

  const other = (snap.personaCards?.cards ?? []).find((c) => c.id !== target.id);
  const activated = await act('persona.activate', { id: other.id });
  check(activated?.ok === true, '切换成功');
  snap = await rpc('snapshot');
  check(snap.personaCards?.activeId === other.id, 'activeId 变了');

  /* ---------------------------------------------- 副本 */

  const copied = await act('persona.duplicate', { id: target.id });
  check(copied?.ok === true, `建副本成功（${copied?.message ?? 'ok'}）`);
  check(String(copied?.card?.name ?? '').includes('副本'), `副本名字带"副本"（${copied?.card?.name}）`);

  /* ---------------------------------------------- 删除 */

  snap = await rpc('snapshot');
  const beforeDelete = snap.personaCards.cards.length;
  const del = await act('persona.delete', { id: target.id });
  check(del?.ok === true, `删除成功（${del?.message ?? 'ok'}）`);
  snap = await rpc('snapshot');
  check(snap.personaCards.cards.length === beforeDelete - 1, '卡片数 -1');
  check(!snap.personaCards.cards.some((c) => c.id === target.id), '删掉的卡真的没了');

  /* ---------------------------------------------- 持久化 */

  // 路径由 paths 模块决定，扫一遍找
  let found = null;
  for (const dir of fs.readdirSync(tmpHome, { recursive: true, withFileTypes: true })) {
    const p = path.join(tmpHome, String(dir.name));
    try {
      if (dir.isFile() && String(dir.name).includes('persona')) found = p;
    } catch {
      /* 忽略 */
    }
  }
  check(Boolean(found), `人格文件落盘了（${found ?? '没找到'}）`);
  if (found) {
    const parsed = JSON.parse(fs.readFileSync(found, 'utf8'));
    check(Array.isArray(parsed.cards), '文件里是 cards 数组');
    check(typeof parsed.activeId === 'string', '文件里存了 activeId');
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 后端五个动作全正常' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);
  if (failed > 0 && stderr) console.log(stderr.slice(-500));

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
  console.error('✖', e.message);
  if (stderr) console.error(stderr.slice(-600));
  child.kill();
  process.exit(1);
});
