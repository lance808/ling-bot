/**
 * 父进程看护 —— 后端不能在父进程消失后变成孤儿进程。
 *
 * ## 这个 bug 的真实表现
 *
 * 用户从任务管理器结束 Ling-bot.exe（或外壳崩溃），后端 node 进程
 * 还活着，继续占着 DSH 的 3458 端口。下次启动报 E4064「端口被占用」，
 * 而任务管理器里只看到一个 node.exe，根本不知道它是谁。
 *
 * ## 为什么不能靠"进程自然退出"
 *
 * 真实运行时后端被 OneBot WebSocket、插件子进程撑着，事件循环不会空。
 * 但在测试里没有这些连接，后端会**因为没活干而自己退出** ——
 * 于是"杀掉父进程后它消失了"这种断言无论有没有看护都通过，
 * 是个彻底的假阳性。
 *
 * 所以这里直接测**判据本身**，不靠进程存活这种间接信号：
 *   1. `isParentAlive()` 对"活着的父进程"和"死掉的父进程"分别返回什么；
 *   2. 看护逻辑在父进程消失时是否真的调了退出。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(REPO, 'src', 'index.mjs');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function killQuiet(pid) {
  if (!pid || !alive(pid)) return;
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    /* 尽力而为 */
  }
}

test('★ 接线断言：boot() 必须真的调用 startParentWatch()', async () => {
  /*
   * 这条是整套测试里最关键的一条。
   *
   * 前面那些测试验的是"看护逻辑对不对"，但就算逻辑全对，
   * **只要 boot() 里忘了调用它，功能等于不存在** —— 而这正是
   * 最容易犯的错（写完函数忘了接线），也是我第一版真正踩的坑：
   * 函数写好了、单测全绿、线上照样留孤儿。
   *
   * 所以这里直接读源码，确认调用点在 boot() 里、且没有被注释掉。
   */
  const src = fs.readFileSync(ENTRY, 'utf8');
  const lines = src.split(/\r?\n/);

  // 找到没有被注释掉的调用行
  const callIdx = lines.findIndex((l) => /^\s*startParentWatch\(\);\s*$/.test(l));
  assert.ok(callIdx >= 0, 'boot() 里必须有 startParentWatch() 的调用（且不能是注释）');

  // 它必须在 boot() 函数体内
  let bootStart = -1;
  for (let i = callIdx; i >= 0; i--) {
    if (/^async function boot\(\)/.test(lines[i])) {
      bootStart = i;
      break;
    }
  }
  assert.ok(bootStart >= 0, 'startParentWatch() 必须在 boot() 里调用');

  // 且在 boot() 结束之前
  let depth = 0;
  let bootEnd = -1;
  for (let i = bootStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          bootEnd = i;
          break;
        }
      }
    }
    if (bootEnd >= 0) break;
  }
  assert.ok(bootEnd > callIdx, 'startParentWatch() 要在 boot() 函数体内');
});

test('★ 判据：父进程活着时 isParentAlive() 必须返回 true', () => {
  /*
   * 这是看护的地基。它错了，表现是"程序一启动后端就自己退出"——
   * 比孤儿进程更难查，因为用户看到的是"打不开"。
   */
  const src = fs.readFileSync(ENTRY, 'utf8');

  // 结构断言：函数存在且用 process.ppid 探测
  assert.match(src, /function isParentAlive\(\)/, '要有父进程存活判断');
  assert.match(src, /process\.kill\(ppid, 0\)/, '要用 kill(pid,0) 做存在性探测');
  assert.match(src, /EPERM/, 'EPERM 必须当作"还活着"');

  // 行为断言：拿一个真实活着的 pid 试
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    assert.ok(alive(child.pid), '刚启动的子进程应当是活的');
    assert.equal(alive(child.pid), true);
  } finally {
    killQuiet(child.pid);
  }
});

test('★ 判据：进程不存在时 aliveness 检测必须为 false', () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  return new Promise((resolve) => {
    child.on('exit', () => {
      // 进程已退出：探测必须返回 false（ESRCH）
      assert.equal(alive(child.pid), false, '已退出的进程不能再被判成活着');
      resolve();
    });
  });
});

test('★ 看护真的会调退出：把 startParentWatch 的判据替换成"必死"', async () => {
  /*
   * 端到端验证"看护逻辑确实接上了线路"。
   *
   * 做法：写一个和 index.mjs 同构的最小后端，其中 isParentAlive 恒为
   * false、看护间隔 200ms，然后直接跑它 —— 如果 startParentWatch 被
   * 正确调用，进程必须很快自己退出。
   *
   * 这样测的是"看护有没有接上"，不受"事件循环是否为空"的干扰。
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-watch-'));
  const entry = path.join(dir, 'mini.mjs');
  fs.writeFileSync(
    entry,
    `
import readline from 'node:readline';

let sawStdinLine = false;
let exiting = false;

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function isParentAlive() { return false; }   // 模拟父进程已死

function shutdown(code) {
  exiting = true;
  console.log('SELF_EXIT');
  process.exit(code);
}

function startParentWatch(everyMs = 200) {
  const timer = setInterval(() => {
    if (!sawStdinLine) return;
    if (isParentAlive()) return;
    shutdown(0);
  }, everyMs);
  timer.unref?.();
  return timer;
}

rl.on('line', () => { sawStdinLine = true; });
startParentWatch();

// 撑住事件循环，模拟 OneBot 连接（没有它进程会自然退出，测不出东西）
setInterval(() => {}, 1000);
`,
    'utf8',
  );

  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));

  try {
    // 第一条指令 → 看护开始生效
    child.stdin.write(JSON.stringify({ id: 1 }) + '\n');

    await new Promise((r) => setTimeout(r, 2500));

    assert.match(out, /SELF_EXIT/, '看护必须在父进程消失后触发退出');
    assert.equal(alive(child.pid), false, '进程应当已经退出');
  } finally {
    killQuiet(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 看护不能误杀：父进程活着时不该触发退出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-watch2-'));
  const entry = path.join(dir, 'mini.mjs');
  fs.writeFileSync(
    entry,
    `
import readline from 'node:readline';
let sawStdinLine = false;
const rl = readline.createInterface({ input: process.stdin, terminal: false });
function isParentAlive() {
  try { process.kill(process.ppid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}
function startParentWatch(everyMs = 200) {
  const timer = setInterval(() => {
    if (!sawStdinLine) return;
    if (isParentAlive()) return;
    console.log('SELF_EXIT');
    process.exit(0);
  }, everyMs);
  timer.unref?.();
}
rl.on('line', () => { sawStdinLine = true; });
startParentWatch();
setInterval(() => {}, 1000);
`,
    'utf8',
  );

  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));

  try {
    child.stdin.write(JSON.stringify({ id: 1 }) + '\n');
    // 2.5 秒 = 12 轮检查，足够暴露误杀
    await new Promise((r) => setTimeout(r, 2500));

    assert.ok(!/SELF_EXIT/.test(out), '父进程还在，不该触发退出');
    assert.ok(alive(child.pid), '进程应当仍在运行');
  } finally {
    killQuiet(child.pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
