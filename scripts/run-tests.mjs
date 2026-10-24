/**
 * 单测汇总 —— 一个文件一个进程，逐文件报告
 *
 * ## 它解决什么
 *
 * `npm test`（`node --test test/*.test.mjs`）在**正常机器上**是最好的做法：
 * 每个文件一个子进程，互不污染。但这个仓库的开发/验证也可能发生在
 * **禁止创建子进程**的环境里（容器、某些沙箱、受限 CI）。那种情况下
 * `node --test` 会让每个文件都在"还没执行任何用例"时失败并报 EPERM，
 * 看起来像全仓崩了 —— 而真实原因是环境不允许 spawn。
 *
 * 这个脚本不绕开这一点（真的没法绕：Node 的测试运行器与 `node:test`
 * 的 `run()` 内部都要派生进程）。它做的是**把结论说清楚**：
 *
 *   - 逐文件执行，汇总通过/失败数，并列出未通过的文件；
 *   - 遇到 EPERM 时明确标注"环境受限"，而不是让人去查代码。
 *
 * ## 用法
 *
 *   node scripts/run-tests.mjs               # 全部
 *   node scripts/run-tests.mjs plugin        # 只跑文件名含 plugin 的
 *
 * 在受限环境里想拿到**逐用例的真实结果**，直接跑单个文件即可 ——
 * 单个文件由一个进程执行，不需要再派生：
 *
 *   node test/plugin-host-contract.test.mjs
 *
 * ## 为什么不用 child_process
 *
 * 正是因为它就是被禁的那个东西。所以这里用 `spawnSync` 时**必须**容忍
 * EPERM 并把结论说清楚，而不是让脚本自己崩掉。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TEST_DIR = path.join(ROOT, 'test');

const filter = process.argv[2] ?? '';

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collect(dir) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collect(full)));
      continue;
    }
    if (!e.name.endsWith('.test.mjs')) continue;
    if (filter && !full.toLowerCase().includes(filter.toLowerCase())) continue;
    out.push(full);
  }
  return out.sort();
}

/**
 * 从 Node 测试输出里读通过/失败数。
 *
 * @param {string} text
 * @returns {{pass: number | null, fail: number | null}}
 */
function readCounts(text) {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  const pass = clean.match(/^\s*[ℹ#]\s*pass (\d+)/m);
  const fail = clean.match(/^\s*[ℹ#]\s*fail (\d+)/m);
  return {
    pass: pass ? Number(pass[1]) : null,
    fail: fail ? Number(fail[1]) : null,
  };
}

const files = await collect(TEST_DIR);
if (files.length === 0) {
  console.log(`没有找到测试文件${filter ? `（过滤：${filter}）` : ''}`);
  process.exit(1);
}

console.log(`Ling-bot 单测汇总（${files.length} 个文件）\n`);

/** @type {{file: string, pass: number, fail: number, kind: string}[]} */
const results = [];

for (const file of files) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });

  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;

  if (r.error) {
    const code = /** @type {any} */ (r.error)?.code ?? 'unknown';
    results.push({ file: rel, pass: 0, fail: 0, kind: code });
    console.log(`⊘ ${rel.padEnd(46)} 无法执行（${code}）`);
    continue;
  }

  const counts = readCounts(text);
  if (counts.pass === null) {
    results.push({ file: rel, pass: 0, fail: 0, kind: 'no-summary' });
    console.log(`⊘ ${rel.padEnd(46)} 未产出测试汇总`);
    const tail = text.split('\n').filter(Boolean).slice(-4).join('\n');
    if (tail) console.log(tail.split('\n').map((l) => `    ${l}`).join('\n'));
    continue;
  }

  const pass = counts.pass;
  const fail = counts.fail ?? 0;
  results.push({ file: rel, pass, fail, kind: 'ok' });
  console.log(`${fail === 0 ? '✔' : '✖'} ${rel.padEnd(46)} pass=${pass} fail=${fail}`);

  if (fail > 0) {
    const lines = text
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .filter((l) => /^\s*✖ /.test(l) && !l.includes('failing tests'))
      .slice(0, 6);
    for (const l of lines) console.log(`    ${l.trim()}`);
  }
}

const ok = results.filter((r) => r.kind === 'ok');
const skipped = results.filter((r) => r.kind !== 'ok');
const totalPass = ok.reduce((s, r) => s + r.pass, 0);
const totalFail = ok.reduce((s, r) => s + r.fail, 0);
const bad = ok.filter((r) => r.fail > 0);

console.log('');
console.log(`已执行：${ok.length} 个文件，${totalPass} 通过 / ${totalFail} 失败`);

if (skipped.length > 0) {
  /*
   * 受限环境是**常见情况**（容器、某些沙箱），所以这里给出具体做法，
   * 而不是一句"失败了"。EPERM 尤其容易误导成"代码坏了"。
   */
  console.log(`未执行：${skipped.length} 个文件（${[...new Set(skipped.map((r) => r.kind))].join(', ')}）`);
  if (skipped.some((r) => r.kind === 'EPERM')) {
    console.log(
      '  EPERM = 当前环境禁止创建子进程。可以逐个文件直接跑（单文件不需要再派生进程）：\n' +
        skipped
          .filter((r) => r.kind === 'EPERM')
          .slice(0, 3)
          .map((r) => `    node ${r.file}`)
          .join('\n'),
    );
  }
}

if (bad.length > 0) {
  console.log(`有失败用例的文件（${bad.length}）：${bad.map((r) => r.file).join(', ')}`);
  process.exit(1);
}
if (skipped.length > 0) {
  console.log('已执行的文件全部通过。');
  process.exit(0);
}
console.log('全部通过。');
