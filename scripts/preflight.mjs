/**
 * 上传前体检 —— 准备 push 到 GitHub 之前跑一次。
 *
 * 它跟 `check` 的区别：
 *   check  守的是"代码对不对"（每次改完都跑）
 *   preflight 守的是"能不能公开"（只在上传前跑）
 *
 * 检查项：
 *   1. 凭据扫描（复用 scan-secrets）
 *   2. .gitignore 是否真的挡住了本机数据
 *   3. 工作区是否干净（有未提交改动就传上去，别人看到的是半成品）
 *   4. 是否配置了远程（没配就说明还没准备传）
 *   5. 全历史里是否曾有敏感文件（历史泄露比当前泄露更隐蔽）
 *   6. 有没有把绝对路径写进代码（会暴露用户名与目录结构）
 *
 * 用法：node scripts/preflight.mjs
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT = ['-c', 'core.quotePath=false'];

/** @type {{ok: boolean, label: string, detail?: string, blocking: boolean}[]} */
const results = [];

/** @param {boolean} ok @param {string} label @param {boolean} blocking @param {string} [detail] */
function add(ok, label, blocking, detail) {
  results.push({ ok, label, blocking, detail });
}

/* ---------------------------------------------------------------- 1. 凭据 */

{
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'scan-secrets.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  add(r.status === 0, '仓库内无凭据', true, (r.stdout || r.stderr || '').trim());
}

/* ---------------------------------------------------------------- 2. ignore */

{
  // 这些必须被 git 忽略；只要有一个没忽略，本机数据就可能被传上去
  const mustIgnore = ['config.json', 'secrets.json', 'data/x.json', 'state/x.jsonl', 'usage.jsonl', 'logs/x.log'];
  /** @type {string[]} */
  const leaked = [];
  for (const f of mustIgnore) {
    const r = spawnSync('git', [...GIT, 'check-ignore', f], { cwd: repoRoot });
    if (r.status !== 0) leaked.push(f);
  }
  add(leaked.length === 0, '.gitignore 挡住了本机数据', true, leaked.length ? `未忽略：${leaked.join(', ')}` : '');
}

/* ---------------------------------------------------------------- 3. 被跟踪的敏感文件名 */

{
  const files = execFileSync('git', [...GIT, 'ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  // 只检查"按名字就该被忽略"的那类；文档里提到 config.json 是正常的
  const suspicious = files.filter((f) => {
    const base = path.basename(f);
    return (
      base === 'config.json' ||
      base === 'secrets.json' ||
      base === 'persona.json' ||
      base === 'usage.jsonl' ||
      /^state\//.test(f) ||
      /^logs\//.test(f) ||
      /^data\//.test(f)
    );
  });
  add(suspicious.length === 0, '没有被误跟踪的配置文件', true, suspicious.join(', '));
}

/* ---------------------------------------------------------------- 4. 全历史 */

{
  // 历史里出现过敏感文件，比"当前存在"更危险：删了文件历史还在
  let bad = '';
  try {
    bad = execFileSync('git', [...GIT, 'log', '--all', '--pretty=format:', '--name-only'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    /* 空仓库 */
  }
  const everTracked = new Set(bad.split('\n').filter(Boolean));
  const hits = [...everTracked].filter(
    (f) => path.basename(f) === 'config.json' || path.basename(f) === 'secrets.json' || /^data\//.test(f),
  );
  add(hits.length === 0, '历史里从未出现过配置文件', true, hits.join(', '));
}

/* ---------------------------------------------------------------- 5. 工作区 */

{
  const r = spawnSync('git', [...GIT, 'status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = (r.stdout || '').trim();
  add(dirty === '', '工作区干净（无未提交改动）', false, dirty.split('\n').slice(0, 5).join(' / '));
}

/* ---------------------------------------------------------------- 6. 绝对路径 */

{
  const files = execFileSync('git', [...GIT, 'ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && /\.(mjs|cjs|js|json|md|txt|html|css)$/.test(f) && f !== 'scripts/preflight.mjs');

  /** @type {string[]} */
  const leaks = [];
  for (const f of files) {
    let text = '';
    try {
      text = await fs.readFile(path.join(repoRoot, f), 'utf8');
    } catch {
      continue;
    }
    /*
     * 只抓"把某个真实用户名写死"的情况。
     *
     * 这里**不能写死任何具体用户名**。早先的实现里有一个本机用户名的白名单，
     * 那等于：仓库里躺着一个真实用户名，而检查还显示通过。
     * 现在改成通用判定 —— 占位符写法放行，其余一律报。
     * 宁可误报一个占位符，也不能漏掉作者本人的用户名。
     */
    const m = text.match(/[A-Z]:\\+Users\\+([A-Za-z0-9._-]+)/g);
    if (m) {
      const me = os.userInfo().username.toLowerCase();
      const real = m.filter((x) => {
        const name = String(x).split(/[\\/]+/).pop().toLowerCase();
        // 占位符写法：<用户名>、$USER、$(whoami)、%USERNAME%、...
        if (!name || /^[<$(%{]/.test(name) || name === '...') return false;
        // 公共 / 内置 / 示例账户
        if (/^(public|default|defaultuser|all users|default user|shared|username|user|someone|yourname|xxx+)$/.test(name)) {
          return false;
        }
        // 命中本机真实用户名必然要报；其余也一并报（可能是别的机器的真实名）
        return true;
      });
      if (real.length > 0) leaks.push(`${f}: ${real[0]}`);
    }
  }
  add(leaks.length === 0, '代码里没有写死本机路径', false, leaks.slice(0, 5).join(' / '));
}

/* ---------------------------------------------------------------- 7. 远程 */

{
  const r = spawnSync('git', [...GIT, 'remote', '-v'], { cwd: repoRoot, encoding: 'utf8' });
  const has = Boolean((r.stdout || '').trim());
  add(has, '已配置远程仓库', false, has ? '' : '还没配。真要上传时：git remote add origin <url>');
}

/* ---------------------------------------------------------------- 输出 */

console.log('上传前体检（preflight）\n');

let blocking = 0;
for (const r of results) {
  const mark = r.ok ? '✓' : r.blocking ? '✖' : '·';
  console.log(`  ${mark} ${r.label}`);
  if (!r.ok && r.detail) console.log(`      ${r.detail}`);
  if (!r.ok && r.blocking) blocking += 1;
}

console.log('');
if (blocking > 0) {
  console.log(`✖ 有 ${blocking} 项阻断问题，**不要上传**。`);
  process.exit(1);
}

const warns = results.filter((r) => !r.ok && !r.blocking).length;
if (warns > 0) {
  console.log(`✓ 可以上传（另有 ${warns} 项提醒，不阻断）。`);
} else {
  console.log('✓ 可以上传。');
}
