/**
 * 静态检查 —— 守住几条结构性不变量（比人工 review 可靠）
 *
 *   I1  后端不依赖 Electron
 *   I2  client / llm 里不出现 snowluma 等字样
 *   I3  代码里没有启停/注入他人的路径
 *   I4  发送动作在全仓库只有一处调用
 *   I13 群聊来源拿不到宿主机工具（跑 node:test 的子集）
 *   I14 tool-gate 不 import 对话相关模块
 *
 * 用法：node scripts/check.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const passes = [];

/** @param {string} dir @param {(full: string) => boolean} filter */
async function walk(dir, filter) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, filter)));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const rel = (p) => path.relative(repoRoot, p).replaceAll('\\', '/');

/* ---------------------------------------------------------------- I1 */

async function checkNoElectronInBackend() {
  const files = await walk(path.join(repoRoot, 'src'), (f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    if (/from\s+['"]electron['"]|require\(['"]electron['"]\)/.test(text)) offenders.push(rel(file));
  }
  if (offenders.length) failures.push(`I1 后端依赖了 Electron：${offenders.join(', ')}`);
  else passes.push('I1 后端不依赖 Electron');
}

/* ---------------------------------------------------------------- I2 */

async function checkNoUpstreamNameInClient() {
  const targets = ['src/onebot/client.mjs'];
  const offenders = [];
  for (const target of targets) {
    const text = await fs.readFile(path.join(repoRoot, target), 'utf8');
    // 允许出现在注释里说明"为什么"，但代码标识符里不允许
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    if (/snowluma|deepseek-harness/i.test(code)) offenders.push(target);
  }
  if (offenders.length) failures.push(`I2 客户端代码里出现了上游专有名：${offenders.join(', ')}`);
  else passes.push('I2 客户端与上游实现解耦（无专有名）');
}

/* ---------------------------------------------------------------- I3 */

async function checkNoProcessInjection() {
  const files = await walk(path.join(repoRoot, 'src'), (f) => f.endsWith('.mjs'));
  const offenders = [];
  const bad = [/\bspawn\s*\(.*snowluma/i, /\bexec\w*\s*\(.*(inject|snowluma)/i, /\.dll\b/i, /\.node['"]/];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    if (bad.some((re) => re.test(text))) offenders.push(rel(file));
  }
  if (offenders.length) failures.push(`I3 出现可能的注入/启停上游路径：${offenders.join(', ')}`);
  else passes.push('I3 无注入与启停上游的代码路径');
}

/* ---------------------------------------------------------------- I4 */

async function checkSingleSendPath() {
  const files = await walk(path.join(repoRoot, 'src'), (f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    // 只允许 action 声明与 client.sendAction 的通用调用
    const matches = text.match(/['"]send_(?:group|private)_msg['"]/g) ?? [];
    if (matches.length > 0 && !rel(file).endsWith('src/index.mjs')) {
      offenders.push(rel(file));
    }
  }
  if (offenders.length) failures.push(`I4 发送动作在闸门之外被调用：${offenders.join(', ')}`);
  else passes.push('I4 发送只有一条通路（src/index.mjs 的 sendText）');
}

/* ---------------------------------------------------------------- I14 */

async function checkGateIsPure() {
  const file = path.join(repoRoot, 'src/guard/tool-gate.mjs');
  const text = await fs.readFile(file, 'utf8');
  const imports = [...text.matchAll(/import\s+[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const forbidden = imports.filter((i) => /session|message|persona|llm|onebot/i.test(i));
  if (forbidden.length) {
    failures.push(`I14 tool-gate 依赖了对话相关模块：${forbidden.join(', ')}`);
  } else {
    passes.push(`I14 授权判定是纯函数（import：${imports.join(', ') || '无'}）`);
  }
}

/* ---------------------------------------------------------------- 界面硬纪律 */

async function checkNoInnerHtml() {
  const files = await walk(path.join(repoRoot, 'ui'), (f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    if (/\.innerHTML\s*=/.test(text)) offenders.push(rel(file));
  }
  if (offenders.length) failures.push(`界面里出现了 innerHTML 赋值（应走 textContent）：${offenders.join(', ')}`);
  else passes.push('界面不使用 innerHTML（外部文本一律 textContent）');
}

async function checkNoInlineStyle() {
  const files = await walk(path.join(repoRoot, 'ui'), (f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    if (/\{\s*style:\s*['"`]/.test(text)) offenders.push(rel(file));
  }
  if (offenders.length) {
    failures.push(`界面里出现 inline style（CSP 会拦截）：${offenders.join(', ')}`);
  } else {
    passes.push('界面不使用 inline style（符合 CSP style-src self）');
  }
}

async function checkPreloadIsCjs() {
  const cjs = path.join(repoRoot, 'electron/preload.cjs');
  const esm = path.join(repoRoot, 'electron/preload.mjs');
  try {
    await fs.access(esm);
    failures.push('存在 electron/preload.mjs：sandbox preload 必须是 CJS，否则加载失败');
    return;
  } catch {
    /* 不存在才是对的 */
  }
  try {
    const text = await fs.readFile(cjs, 'utf8');
    if (/^\s*import\s/m.test(text)) {
      failures.push('preload.cjs 里出现了 ESM import（sandbox 下会加载失败）');
      return;
    }
    passes.push('preload 是 CJS（sandbox 下可加载）');
  } catch {
    failures.push('缺少 electron/preload.cjs');
  }
}

/* ---------------------------------------------------------------- 文档同步 */

async function checkDocsPresent() {
  /*
   * 只检查随仓库发布的那一份。
   *
   * 设计文档（开发文档/）整目录不进公开仓库 —— 它记录的是本地设计过程，
   * 含本机环境细节。所以这里不能再要求它存在，否则公开仓库一 clone 就红。
   */
  const required = ['README.md'];
  const missing = [];
  for (const r of required) {
    try {
      await fs.access(path.join(repoRoot, r));
    } catch {
      missing.push(r);
    }
  }
  if (missing.length) failures.push(`缺少文档：${missing.join(', ')}`);
  else passes.push('README 存在');
}

/* ---------------------------------------------------------------- 注入防线 */

async function checkToolResultNeverInSystem() {
  // 工具结果只能以 tool 角色回灌，绝不能拼进 system
  const file = path.join(repoRoot, 'src/llm/agent-loop.mjs');
  const text = await fs.readFile(file, 'utf8');
  if (/role:\s*['"]system['"]\s*,\s*content:\s*wrapToolResult/.test(text)) {
    failures.push('I15 工具结果被拼进了 system prompt（注入路径）');
  } else if (!text.includes("role: 'tool'")) {
    failures.push('I15 工具结果没有以 tool 角色回灌');
  } else {
    passes.push('I15 工具结果只以 tool 角色回灌，绝不进 system');
  }
}

async function checkBehaviorLayerIsConstant() {
  // 行为层必须是代码常量，不能来自配置/文件
  const file = path.join(repoRoot, 'src/llm/prompt.mjs');
  const text = await fs.readFile(file, 'utf8');
  if (!/export const BEHAVIOR_LAYER\s*=\s*Object\.freeze/.test(text)) {
    failures.push('I16 行为层不是冻结常量（可能被运行时改写）');
  } else {
    passes.push('I16 行为层是冻结常量（运行时改不动）');
  }
}

async function checkConfirmIsFailClosed() {
  // 确认通道必须默认拒绝、有超时
  const file = path.join(repoRoot, 'src/index.mjs');
  const text = await fs.readFile(file, 'utf8');
  const bad = [];
  if (!/CONFIRM_TIMEOUT_MS\s*=\s*60_000/.test(text)) bad.push('缺 60s 确认超时');
  if (!/resolve\(['"]deny['"]\)/.test(text)) bad.push('超时没有落在 deny');

  // 只在**代码**里找"始终允许"（注释里提到它是在说明为什么不提供，不算违规）
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  if (/始终允许|alwaysAllow/.test(code)) bad.push('代码里出现了"始终允许"（一次确认只能管一次）');

  if (bad.length) failures.push(`I17 确认通道不符合 fail-closed：${bad.join('；')}`);
  else passes.push('I17 确认通道 fail-closed（超时即拒绝，无"始终允许"）');
}

async function checkProactiveGuardrails() {
  const file = path.join(repoRoot, 'src/llm/triggers.mjs');
  const text = await fs.readFile(file, 'utf8');
  const missing = [];
  if (!text.includes('activeWindowMs')) missing.push('缺"冷群不开口"护栏');
  if (!text.includes('minIntervalMs')) missing.push('缺"30 分钟间隔"护栏');
  if (!/if\s*\(!input\.isGroup\)\s*return null/.test(text)) missing.push('缺"私聊不主动"拦截');
  if (missing.length) failures.push(`I18 概率唤醒护栏不完整：${missing.join('；')}`);
  else passes.push('I18 概率唤醒三重护栏齐备');
}

/* ---------------------------------------------------------------- 凭据 */

async function checkNoSecrets() {
  // 把凭据扫描接进 check：提交前想不通过都难
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'scan-secrets.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    failures.push(`I19 凭据扫描未通过：\n${(r.stderr || r.stdout || '').trim()}`);
  } else {
    passes.push('I19 仓库内无凭据（sk-/长密钥/Authorization 头）');
  }
}

/* ---------------------------------------------------------------- key 不落明文 */

async function checkKeyNeverPlaintext() {
  // I21：API Key 只能进保险箱（DPAPI 密文），不能写进 config.json。
  //
  // 这条守的是一个很具体的错误：将来有人为了"方便"把 key 塞回配置文件。
  // 一旦那样，key 就躺在明文里，拷走即泄露。
  const src = await fs.readFile(path.join(repoRoot, 'src', 'index.mjs'), 'utf8');

  // (1) 保存 key 的动作必须写 vaultPath，不能写 configPath
  const saveBlock = src.slice(src.indexOf("name === 'secret.saveApiKey'"), src.indexOf("name === 'secret.clearApiKey'"));
  if (!saveBlock.includes('paths.vaultPath')) {
    failures.push('I21 保存 API Key 时没有写入保险箱（paths.vaultPath）');
    return;
  }
  if (saveBlock.includes('paths.configPath')) {
    failures.push('I21 保存 API Key 时写到了 config.json —— key 会以明文落盘');
    return;
  }

  // (2) 启动时必须优先从保险箱读，而不是只信 config.llm.apiKey
  if (!src.includes('openSecret(')) {
    failures.push('I21 启动时没有从保险箱读取 API Key');
    return;
  }

  // (3) 日志里绝不能出现 key 本身（只允许长度）
  const logLines = src.split('\n').filter((l) => l.includes('log.') && /apiKey|currentApiKey|key\b/.test(l));
  const leaky = logLines.filter((l) => !/len:|length|keySource|configured|已清除|已加密保存/.test(l));
  if (leaky.length > 0) {
    failures.push(`I21 日志里可能打印了 API Key：${leaky[0].trim().slice(0, 80)}`);
    return;
  }

  passes.push('I21 API Key 只进加密保险箱，不落明文、不进日志');
}

/* ---------------------------------------------------------------- 编码 */

async function checkSourceEncoding() {
  // 这个仓库踩过坑：用 PowerShell 写文件会把 .mjs 存成 UTF-16LE 或加 BOM，
  // 后果是 `SyntaxError: Invalid or unexpected token`，而报错位置在文件第 1 行，
  // 非常难看出是编码问题。所以在这里一次性拦住。
  const walk = async (dir) => {
    /** @type {string[]} */
    const out = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (/\.(mjs|cjs|js|json|html|css|md)$/.test(e.name)) out.push(full);
    }
    return out;
  };

  const files = [...(await walk(path.join(repoRoot, 'src'))), ...(await walk(path.join(repoRoot, 'ui')))];
  const bad = [];

  for (const f of files) {
    const buf = await fs.readFile(f);
    // UTF-16LE / UTF-16BE BOM
    if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
      bad.push(`${path.relative(repoRoot, f)}（UTF-16）`);
    } else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      bad.push(`${path.relative(repoRoot, f)}（含 BOM）`);
    }
  }

  // 再说一句：ESM 允许 BOM，但混用编码会让 git diff / 工具链出怪问题，统一禁止
  if (bad.length) failures.push(`I20 源文件编码不合规（要求 UTF-8 无 BOM）：${bad.join('、')}`);
  else passes.push('I20 源文件编码统一（UTF-8 无 BOM）');
}

/* ---------------------------------------------------------------- 测试 */

async function runTests() {
  // Node 24 的 --test 需要文件 glob，传目录会被当模块解析
  const testFiles = (await walk(path.join(repoRoot, 'test'), (f) => f.endsWith('.test.mjs'))).map(rel);
  if (testFiles.length === 0) {
    failures.push('未找到任何测试文件');
    return;
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--test', ...testFiles], {
      cwd: repoRoot,
      env: { ...process.env },
    });
    const m = stdout.match(/pass (\d+)/);
    passes.push(`单测全绿（${m ? m[1] : testFiles.length} 个用例）`);
  } catch (err) {
    failures.push(`单测失败：\n${String(err.stdout ?? err.message).split('\n').slice(-25).join('\n')}`);
  }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  await checkNoElectronInBackend();
  await checkNoUpstreamNameInClient();
  await checkNoProcessInjection();
  await checkSingleSendPath();
  await checkGateIsPure();
  await checkNoInnerHtml();
  await checkNoInlineStyle();
  await checkPreloadIsCjs();
  await checkDocsPresent();
  await checkToolResultNeverInSystem();
  await checkBehaviorLayerIsConstant();
  await checkConfirmIsFailClosed();
  await checkProactiveGuardrails();
  await checkNoSecrets();
  await checkKeyNeverPlaintext();
  await checkSourceEncoding();
  await runTests();

  console.log('Ling-bot 静态检查\n');
  for (const p of passes) console.log(`  ✓ ${p}`);
  if (failures.length) {
    console.log('');
    for (const f of failures) console.log(`  ✖ ${f}`);
    console.log(`\n${failures.length} 项未通过。`);
    process.exit(1);
  }
  console.log('\n全部通过。');
}

main();
