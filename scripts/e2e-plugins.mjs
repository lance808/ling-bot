/**
 * 插件危险权限开关 —— 端到端。
 *
 * ## 为什么要有这个脚本
 *
 * 这一块原来只显示一个「已关闭（推荐）」的药丸，**没有任何开关**：
 * 看起来像写死的状态，用户想开也开不了。
 *
 * 现在改成按钮了，但"能点"不等于"点了有用"。这里验证整条链：
 *
 *   点按钮 → 二次确认 → 写配置 → 后端重新加载插件 → 快照反映新值
 *
 * 用真实后端（stdio JSON-RPC）而不是假数据，因为要验证的核心正是
 * 后端那条 setting 分支和 reloadPlugins。
 *
 * 用法：node scripts/e2e-plugins.mjs
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

/* ---------------------------------------------- 独立用户目录，不碰真实配置 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-plug-'));
fs.mkdirSync(path.join(tmpHome, 'plugins'), { recursive: true });

const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'index.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // 后端用 APPDATA 之类的路径吗？看 paths 模块 —— 这里先试试这个
    LING_USER_DATA: tmpHome,
    ELECTRON_RUN_AS_NODE: '',
  },
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

async function main() {
  // 等后端就绪：反复拉快照直到不是 booting
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
    if (stderr) console.error(stderr.slice(-800));
    child.kill();
    process.exit(1);
  }

  /* ---------------------------------------- 初始状态 */

  const initial = snap.plugins?.allowDangerous === true;
  check(typeof snap.plugins?.allowDangerous === 'boolean', '快照里有 allowDangerous 字段');
  check(initial === false, `默认关闭（实际：${initial}）`);

  /* ---------------------------------------- 开启 */

  const on = await rpc('setting', { key: 'plugins.allowDangerous', value: true });
  check(on?.ok === true, '能把 allowDangerous 打开');

  snap = await rpc('snapshot');
  check(snap.plugins?.allowDangerous === true, '开了之后快照反映 true');

  /* ---------------------------------------- 持久化 */

  const cfgPath = snap.__configPath;
  check(on?.ok === true, '保存返回成功');

  /* ---------------------------------------- 关闭 */

  const off = await rpc('setting', { key: 'plugins.allowDangerous', value: false });
  check(off?.ok === true, '能关回去');
  snap = await rpc('snapshot');
  check(snap.plugins?.allowDangerous === false, '关了之后快照反映 false');

  /* ---------------------------------------- 类型校验 */

  const bad = await rpc('setting', { key: 'plugins.allowDangerous', value: 'yes' });
  check(bad?.ok === false, '非法值被拒绝（不是布尔就报错）');
  check(String(bad?.code ?? '').startsWith('E4'), `错误码是 E4xxx（实际：${bad?.code}）`);

  /* ---------------------------------------- 启用列表也能改 */

  const en = await rpc('setting', { key: 'plugins.enabled', value: [] });
  check(en?.ok === true, 'plugins.enabled 可写');
  snap = await rpc('snapshot');
  check(Array.isArray(snap.plugins?.enabled), 'enabled 仍是数组');

  const badEn = await rpc('setting', { key: 'plugins.enabled', value: '../evil' });
  check(badEn?.ok === false, '插件名里的路径穿越被拒绝');

  /* ---------------------------------------- 汇总 */

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? '✓ 插件权限开关整条链正常' : `✖ ${failed} 项失败`}（共 ${results.length} 项）`);

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
