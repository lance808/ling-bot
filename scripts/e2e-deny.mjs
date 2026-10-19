/**
 * 黑名单：写入 + 优先级。
 *
 * ## 为什么必须验证优先级
 *
 * 黑名单"能编辑"不等于"真的拦得住"。语义上它优先于白名单和管理员身份
 * （见 guard/send-gate.mjs），这条规则如果错了，界面看起来正常、
 * 实际放行了本该拦下的人 —— 是最危险的一类失败。
 *
 * 所以这里分两层测：
 *   1. 后端能存（setting 'deny'）
 *   2. 闸门判定真的优先（直接调 checkWhitelist，不经过网络）
 *
 * 用法：node scripts/e2e-deny.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkWhitelist } from '../src/guard/send-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const results = [];
const check = (ok, label) => {
  results.push({ ok, label });
  console.log(`  ${ok ? '✓' : '✖'} ${label}`);
};

/* ================================================ 第一层：闸门优先级 */

console.log('【闸门判定】');

// 一个号同时在白名单和黑名单里 → 拦
check(
  checkWhitelist('group:555555', {
    allow: { groups: ['555555'], private: [] },
    deny: { groups: ['555555'], private: [] },
    allowAllWhenEmpty: false,
    admins: [],
  }).ok === false,
  '同时出现在两边时，白名单不生效（黑名单优先）',
);

// 管理员私聊被拉黑 → 也要拦
check(
  checkWhitelist('private:777777', {
    allow: { groups: [], private: [] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    admins: [],
  }).ok === false,
  '管理员私聊不在白名单时不放行（对照）',
);

check(
  checkWhitelist('private:777777', {
    allow: { groups: [], private: [] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    admins: ['777777'],
  }).ok === true,
  '管理员私聊有豁免（审批必须送得到）',
);

check(
  checkWhitelist('private:777777', {
    allow: { groups: [], private: [] },
    deny: { private: ['777777'], groups: [] },
    allowAllWhenEmpty: false,
    admins: ['777777'],
  }).ok === false,
  '管理员私聊被拉黑时，豁免不生效（拉黑更说了算）',
);

// 黑名单里的群，即使 allowAllWhenEmpty 打开也拦
check(
  checkWhitelist('group:888888', {
    allow: { groups: [], private: [] },
    deny: { groups: ['888888'], private: [] },
    allowAllWhenEmpty: true,
    admins: [],
  }).ok === false,
  '拉黑的群即使开了「空名单放行全部」也拦',
);

// 不在黑名单的正常群照常放行
check(
  checkWhitelist('group:222222', {
    allow: { groups: ['222222'], private: [] },
    deny: { groups: ['999999'], private: [] },
    allowAllWhenEmpty: false,
    admins: [],
  }).ok === true,
  '没被拉黑的群正常放行',
);

// 群和私聊的黑名单分开
check(
  checkWhitelist('group:333333', {
    allow: { groups: ['333333'], private: [] },
    deny: { groups: [], private: ['333333'] },
    allowAllWhenEmpty: false,
    admins: [],
  }).ok === true,
  '私聊黑名单不会误伤同名群',
);

/* ================================================ 第二层：后端写入 */

console.log('\n【后端写入】');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-deny-'));
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });

const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'index.mjs')], {
  cwd: repoRoot,
  env: { ...process.env, LING_USER_DATA: tmpHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
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

async function main() {
  let snap = null;
  for (let i = 0; i < 40; i++) {
    try {
      snap = await rpc('snapshot');
      if (snap && !snap.booting) break;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!snap || snap.booting) {
    console.error('✖ 后端没起来');
    child.kill();
    process.exit(1);
  }

  const w = await rpc('setting', {
    key: 'deny',
    value: { groups: ['444444'], private: ['666666'] },
  });
  check(w?.ok === true, '能写黑名单');

  snap = await rpc('snapshot');
  check(snap.config.deny.groups.includes('444444'), '群的拉黑进了配置');
  check(snap.config.deny.private.includes('666666'), '私聊的拉黑进了配置');

  // 形状校验
  const bad = await rpc('setting', { key: 'deny', value: { groups: 'not-array' } });
  check(bad?.ok === false, '非法形状被拒绝');
  check(String(bad?.code ?? '').startsWith('E4'), `错误码 E4xxx（实际 ${bad?.code}）`);

  // 非法号码
  const badId = await rpc('setting', { key: 'deny', value: { groups: ['abc'] } });
  check(badId?.ok === false, '非法号码被拒绝');

  // 清空
  const clear = await rpc('setting', { key: 'deny', value: { groups: [], private: [] } });
  check(clear?.ok === true, '能清空黑名单');
  snap = await rpc('snapshot');
  check((snap.config.deny.groups ?? []).length === 0, '清空后确实没了');

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 黑名单写入与优先级都正确' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

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
  child.kill();
  process.exit(1);
});
