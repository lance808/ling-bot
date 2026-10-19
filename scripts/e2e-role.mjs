/**
 * 人格 × 角色 正交性 —— 端到端。
 *
 * ## 这里唯一必须验证的事：互相不影响
 *
 * 界面上做两个标签很容易，真正会出错的是**两者混在一起**：
 * 换角色把人格也换了、角色文件被写进人格内容、某一套的 activeId 覆盖另一套。
 *
 * 这些故障都表现成"看起来正常，但设定没生效"，用户很难描述清楚。
 * 所以这里逐条打后端验证：
 *   1. 两套卡存在两个文件里，各自的 activeId 独立
 *   2. 换角色不动人格，换人格不动角色
 *   3. 注入时两者各按 convKey 解析
 *
 * 用法：node scripts/e2e-role.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMessages, DEFAULT_ROLE_GROUP, DEFAULT_ROLE_PRIVATE } from '../src/llm/prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const results = [];
const check = (ok, label) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '✓' : '✖'} ${label}`);
};

/* ================================================ 第一层：提示层 */

console.log('【提示层：人格与角色分成两段】');

{
  const msgs = buildMessages({
    persona: '我是小明，说话很冲。',
    role: '你是客服，要耐心。',
    context: { convKey: 'group:1', isGroup: true, recent: [] },
  });
  const sys = msgs[0].content;

  check(sys.includes('# 你的人格（用户可编辑）'), '有人格段');
  check(sys.includes('# 你的角色（用户可编辑）'), '有角色段');
  check(sys.includes('我是小明，说话很冲。'), '人格内容进来了');
  check(sys.includes('你是客服，要耐心。'), '角色内容进来了');
  check(sys.indexOf('# 你的人格') < sys.indexOf('# 你的角色'), '人格在角色之前');
  // 行为层仍然在两者之前，且不可被覆盖
  check(sys.indexOf('# 行为规范') < sys.indexOf('# 你的人格'), '行为层在最前');
}

{
  // 不给角色时按场景给默认值 —— 这正是角色层存在的理由
  const g = buildMessages({ persona: 'x', context: { convKey: 'group:1', isGroup: true, recent: [] } });
  check(g[0].content.includes(DEFAULT_ROLE_GROUP.split('\n')[0]), '群聊没给角色时用群聊默认');

  const p = buildMessages({ persona: 'x', context: { convKey: 'private:1', isGroup: false, recent: [] } });
  check(p[0].content.includes(DEFAULT_ROLE_PRIVATE.split('\n')[0]), '私聊没给角色时用私聊默认');
  check(DEFAULT_ROLE_GROUP !== DEFAULT_ROLE_PRIVATE, '两套默认角色不同');
}

/* ================================================ 第二层：真实后端 */

console.log('\n【后端：两套卡各自独立】');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-role-'));
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });

const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'index.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, LING_USER_DATA: tmpHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
/** @type {Map<number, (v: any) => void>} */
const waiting = new Map();
/** @type {null | (() => void)} */
let readyWait = null;
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
      if (msg.error) reject(new Error(String(msg.error.message ?? msg.error.code ?? 'unknown')));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const act = (name, params) => rpc('action', { name, params });

async function main() {
  // 等 ready：snapshot 里有 usageLedger.summary()，问太早会抛 reading 'summary'
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('后端 20 秒内没有 ready')), 20000);
    readyWait = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  let snap = await rpc('snapshot');

  check(Array.isArray(snap.personaCards?.cards), '快照里有人格卡');
  check(Array.isArray(snap.roleCards?.cards), '快照里有角色卡');
  check(snap.personaCards.cards.length >= 1, '启动时至少有 1 张人格卡');
  check(snap.roleCards.cards.length >= 1, '启动时至少有 1 张角色卡');

  const p0 = snap.personaCards.cards[0];
  const r0 = snap.roleCards.cards[0];
  check(p0.id.startsWith('p_'), `人格 id 是 p_ 前缀（${p0.id}）`);
  check(r0.id.startsWith('r_'), `角色 id 是 r_ 前缀（${r0.id}）`);

  // 两个不同的文件
  check(fs.existsSync(path.join(tmpHome, 'persona.json')), 'persona.json 存在');
  check(fs.existsSync(path.join(tmpHome, 'role.json')), 'role.json 存在');
  const pFile = JSON.parse(fs.readFileSync(path.join(tmpHome, 'persona.json'), 'utf8'));
  const rFile = JSON.parse(fs.readFileSync(path.join(tmpHome, 'role.json'), 'utf8'));
  check(
    !JSON.stringify(pFile).includes('"r_'),
    '人格文件里没有角色卡（两套确实分开存）',
  );

  /* ---------------- 换角色不动人格 ---------------- */

  const madeRole = await act('role.create', {
    name: '客服角色',
    text: '你是客服，要耐心。',
    scope: 'global',
  });
  check(madeRole?.ok === true, '能新建角色卡');

  const activateRole = await act('role.activate', { id: madeRole.card.id });
  check(activateRole?.ok === true, '能切换角色卡');

  snap = await rpc('snapshot');
  check(snap.roleCards.activeId === madeRole.card.id, '角色 activeId 变了');
  check(snap.personaCards.activeId === p0.id, '人格 activeId 没被角色切换影响');

  /* ---------------- 换人格不动角色 ---------------- */

  const madePersona = await act('persona.create', { name: '暴脾气人格', text: '说话很冲。', scope: 'global' });
  check(madePersona?.ok === true, '能新建人格卡');
  await act('persona.activate', { id: madePersona.card.id });

  snap = await rpc('snapshot');
  check(snap.personaCards.activeId === madePersona.card.id, '人格 activeId 变了');
  check(snap.roleCards.activeId === madeRole.card.id, '角色 activeId 没被人生切换影响');

  /* ---------------- 改内容也不串 ---------------- */

  await act('role.update', { id: madeRole.card.id, text: '客服角色改过了。' });
  snap = await rpc('snapshot');
  const personaText = snap.personaCards.cards.find((c) => c.id === madePersona.card.id)?.text;
  check(personaText === '说话很冲。', '改角色内容不影响人格内容');

  const roleText = snap.roleCards.cards.find((c) => c.id === madeRole.card.id)?.text;
  check(roleText === '客服角色改过了。', '角色内容确实改了');

  /* ---------------- 作用范围也各自独立 ---------------- */

  await act('role.update', { id: madeRole.card.id, scope: 'group', scopeId: '20001' });
  snap = await rpc('snapshot');
  const rScoped = snap.roleCards.cards.find((c) => c.id === madeRole.card.id);
  check(rScoped.scope === 'group' && rScoped.scopeId === '20001', '角色能用作用范围');
  const pUnchanged = snap.personaCards.cards.find((c) => c.id === madePersona.card.id);
  check(pUnchanged.scope === 'global', '给角色设范围不影响人格的范围');

  /* ---------------- 删角色不动人格 ---------------- */

  const beforePersonaCount = snap.personaCards.cards.length;
  const delRole = await act('role.delete', { id: madeRole.card.id });
  check(delRole?.ok === true, '能删除角色卡');

  snap = await rpc('snapshot');
  check(snap.personaCards.cards.length === beforePersonaCount, '删角色不影响人格卡数量');
  check(snap.roleCards.cards.length === 1, '角色卡少了一张');

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 人格与角色确实互不影响' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

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
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.exit(1);
});
