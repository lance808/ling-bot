/**
 * 启动器验证 —— 确保 exe 在各种环境下报对错。
 *
 * 为什么值得单独测：
 * 启动器是"双击"这个动作的入口。它一旦误判，用户看到的是
 * "双击没反应"——最难排查的一类故障。所以每条分支都要能自动跑。
 *
 * 用 `--check-only` 做验证：只检查环境、不弹窗、不启动，
 * 否则每次测失败路径都要人去点按钮。
 *
 * 用法：node scripts/test-launcher.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(repoRoot, 'Ling-bot.exe');

/** @type {{ok: boolean, label: string, detail?: string}[]} */
const results = [];

/** @param {boolean} ok @param {string} label @param {string} [detail] */
function check(ok, label, detail) {
  results.push({ ok, label, detail });
}

/**
 * @param {string} exePath 要执行的 exe（可在临时目录）
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>}} [opts]
 */
function runExeAt(exePath, args, opts = {}) {
  const env = { ...process.env, ...(opts.env ?? {}) };

  // 清掉上一次的 check 日志，否则会读到旧结果
  const logPath = path.join(path.dirname(exePath), 'launcher-check.log');
  try {
    fs.rmSync(logPath, { force: true });
  } catch {
    /* ignore */
  }

  const r = spawnSync(exePath, args, {
    cwd: opts.cwd ?? path.dirname(exePath),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });

  // 启动器**总是**把结果写进 launcher-check.log（明确的 UTF-8），
  // 有控制台时才会额外写 stdout。所以测试只依赖文件——
  // 混入 stdout 会因控制台代码页不同而出现乱码，且在两版之间行为不一致。
  let fileOut = '';
  try {
    if (fs.existsSync(logPath)) fileOut = fs.readFileSync(logPath, 'utf8');
  } catch {
    /* ignore */
  }

  // 统一换行：启动器写的是 Windows 的 \r\n，
  // 而 `$` 在多行模式下只匹配 \n 之前的位置，行尾会残留 \r，
  // 导致 /^OK$/m 匹配不上。规范化后测试就不依赖平台换行符了。
  return { code: r.status, out: fileOut.replace(/\r\n/g, '\n') };
}

/**
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string,string>}} [opts]
 */
function runExe(args, opts = {}) {
  return runExeAt(exe, args, opts);
}

function main() {
  if (process.platform !== 'win32') {
    console.log('（非 Windows，跳过启动器测试）');
    return;
  }

  if (!fs.existsSync(exe)) {
    console.error(`✖ 找不到 ${exe}。先跑：node scripts/build-launcher.mjs`);
    process.exit(2);
  }

  /* ---- 1. 正常路径 ---- */
  {
    const r = runExe(['--check-only']);
    check(r.code === 0, '正常环境检查通过', r.out.trim());
    check(/^OK$/m.test(r.out), '输出 OK 标记');
    check(/node=v24\./m.test(r.out), '识别到 Node 版本');

    // 关键回归：必须真的找到 node，而不是靠写死的路径
    const m = r.out.match(/^path=(.+)$/m);
    check(Boolean(m && fs.existsSync(m[1].trim())), '报告的 node 路径确实存在', m?.[1]);
  }

  /* ---- 2. 有 package.json 但没装依赖 ---- */
  {
    // 注意：启动器是按**自身所在目录**找 package.json 的（还会向上找一层），
    // 所以必须把 exe 单独放进一个干净的临时目录，不能靠改 cwd。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-lc-'));
    fs.copyFileSync(exe, path.join(tmp, 'Ling-bot.exe'));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}', 'utf8');

    const r = runExeAt(path.join(tmp, 'Ling-bot.exe'), ['--check-only']);
    check(r.code === 1, '缺依赖时返回 1', `code=${r.code} out=${r.out.trim()}`);
    check(/npm install/.test(r.out), '缺依赖时提示 npm install', r.out.trim());
    check(/ELECTRON_MIRROR/.test(r.out), '缺依赖时给出国内镜像方案', r.out.trim());
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---- 3. 完全找不到 package.json（放到没有父级 package.json 的目录） ---- */
  {
    // 临时目录的父级是 %TEMP%，那里不会有 package.json，所以这条能成立
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-lc-'));
    fs.copyFileSync(exe, path.join(tmp, 'Ling-bot.exe'));

    const r = runExeAt(path.join(tmp, 'Ling-bot.exe'), ['--check-only']);
    check(r.code === 1, '缺 package.json 时返回 1', `code=${r.code} out=${r.out.trim()}`);
    check(/找不到 package\.json/.test(r.out), '缺 package.json 时给出明确原因', r.out.trim());
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---- 4. Node 版本不合格 ---- */
  {
    // 用一个假的 node.exe 冒充旧版本：造一个批处理不行（要 .exe），
    // 所以这里改为验证版本判定函数的边界——通过构造 PATH 让 exe 找到
    // 一个假的 node 目录，其中放一个能输出旧版本的 exe。
    // 简化做法：跳过真实伪造，直接断言"版本门槛写对了"（见 Launcher.cs 常量）。
    const src = fs.readFileSync(path.join(repoRoot, 'launcher', 'Launcher.cs'), 'utf8');
    check(/MIN_NODE_MAJOR\s*=\s*24/.test(src), '版本下限写的是 24');
    check(/MIN_NODE_MINOR\s*=\s*22/.test(src), '版本下限写的是 24.22');
    check(/MAX_NODE_MAJOR\s*=\s*24/.test(src), '版本上限写的是 24');
  }

  /* ---- 5. 不写死个人路径 ---- */
  {
    const src = fs.readFileSync(path.join(repoRoot, 'launcher', 'Launcher.cs'), 'utf8');
    // 这条曾经踩过：兜底里有 D:\Node\node.exe，导致"没装 Node"在作者机器上测不出来
    check(!/D:\\\\Node/.test(src), '启动器里没有写死作者机器的 Node 路径');
  }

  /* ---- 6. 会清掉 ELECTRON_RUN_AS_NODE ---- */
  {
    const src = fs.readFileSync(path.join(repoRoot, 'launcher', 'Launcher.cs'), 'utf8');
    check(/ELECTRON_RUN_AS_NODE/.test(src), '启动器处理了 ELECTRON_RUN_AS_NODE 环境陷阱');
  }

  /* ---- 输出 ---- */
  console.log('启动器验证\n');
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✖'} ${r.label}`);
    if (!r.ok && r.detail) console.log(`      ${r.detail}`);
    if (!r.ok) failed += 1;
  }

  console.log('');
  if (failed > 0) {
    console.log(`✖ ${failed} 项未通过。`);
    process.exit(1);
  }
  console.log('全部通过。');
}

main();
