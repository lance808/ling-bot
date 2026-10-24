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
    /*
     * 三种写法都要抓：
     *
     *   1. 对象字面量里的 `style:` —— 注意**不能**要求前面紧挨着 `{`。
     *      属性常有多个且可跨行（`{ class: ..., style: ... }`），
     *      原来那个正则要求 `{\s*style:`，只要前面多一个属性就漏检。
     *      这个漏洞让一处权重条的 inline style 逃过了检查。
     *   2. `setAttribute('style', ...)` —— 绕过对象字面量的写法
     *   3. `.style.xxx =` —— 直接改样式属性
     */
    const hasInline =
      /(?<![\w$.])style\s*:/.test(text) ||
      /setAttribute\(\s*['"`]style['"`]/.test(text) ||
      /\.style\.[\w-]+\s*=/.test(text);
    if (hasInline) offenders.push(rel(file));
  }
  if (offenders.length) {
    failures.push(`界面里出现 inline style（CSP 会拦截）：${offenders.join(', ')}`);
  } else {
    passes.push('界面不使用 inline style（符合 CSP style-src self）');
  }
}

/**
 * I23：`.spacer-*` 只能当占位块，不能当容器。
 *
 * ## 为什么这条值得进不变量检查
 *
 * `.spacer-8` / `.spacer-10` / `.spacer-12` / `.spacer-16` 都是
 * `height: Npx` 的**纯占位块**，语义是"在这里留 N 像素空白"。
 *
 * 但它的类名读起来像"带 8px 间距的容器"，于是很容易被写成
 * `el('div', { class: 'spacer-8' }, [ ...子元素... ])`：
 * 盒子只有 8px 高，子内容却按自己的高度渲染 —— 溢出到盒子外面，
 * 压住后面的兄弟元素。
 *
 * 真实后果：静音页的管理员列表压住了下面的输入框，
 * "移出"按钮和输入框叠在一起。这类问题不会报错、不会崩，
 * 只会让界面看起来"坏了"，而且极难从代码里看出来 ——
 * 因为 div 嵌套本身完全合法。
 *
 * 正确写法：容器不带 spacer，间距作为**第一个子元素**单独放。
 *
 *   el('div', {}, [el('div', { class: 'spacer-8' }), ...子元素])
 */
async function checkSpacerIsNotContainer() {
  const files = await walk(path.join(repoRoot, 'ui'), (f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      // spacer 类后面紧跟一个子元素数组 → 它被当成了容器
      if (/class:\s*['"`]spacer-\d+['"`]\s*\}\s*,\s*\[/.test(line)) {
        offenders.push(`${rel(file)}:${i + 1}`);
      }
    });
  }
  if (offenders.length) {
    failures.push(
      `.spacer-* 被当成容器用（它是固定高度的占位块，子内容会溢出压住后面的元素）：${offenders.join(', ')}`,
    );
  } else {
    passes.push('.spacer-* 只作占位块使用（未当容器）');
  }
}

/**
 * I24：`.row` 上不能再叠 `.spacer-*`。
 *
 * 这是同一个坑的另一种写法。`.row` 是 flex 行，叠上 `height: 8px`
 * 会把整行压成 8 像素高，行内元素溢出到下一块内容上。
 *
 * 两处规则分开写，是因为它们的成因不同：
 *   · I23 是"内容放不进盒子"
 *   · I24 是"盒子本身被压扁"
 * 分开报错能让人一眼看出该改哪边。
 */
async function checkRowHasNoSpacer() {
  const files = await walk(path.join(repoRoot, 'ui'), (f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const file of files) {
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      // class 字符串里同时出现 row 与 spacer
      for (const m of line.matchAll(/class:\s*['"`]([^'"`]*)['"`]/g)) {
        const cls = m[1];
        if (/\brow\b/.test(cls) && /\bspacer-\d+\b/.test(cls)) {
          offenders.push(`${rel(file)}:${i + 1} → "${cls}"`);
        }
      }
    });
  }
  if (offenders.length) {
    failures.push(`.row 上叠了 .spacer-*（会把整行压扁，内容溢出）：${offenders.join(', ')}`);
  } else {
    passes.push('.row 上没有叠加 .spacer-*（行高未被压扁）');
  }
}

/**
 * I22：桌面壳的桥接面必须比页面窄。
 *
 * 页面只认识 window.ling 的五个能力，桥接层必须只暴露这些；
 * 一旦有人往桥接层里塞"顺手再加个命令"，渲染层就重新获得了
 * 任意调用桌面命令的能力，窄接口就失效了。
 */
async function checkBridgeSurface() {
  const file = path.join(repoRoot, 'desktop/bridge.js');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    failures.push('缺少 desktop/bridge.js（桌面桥接层）');
    return;
  }
  const allowed = ['snapshot', 'action', 'setting'];
  const m = text.match(/ALLOWED_METHODS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (!m) {
    failures.push('桥接层必须有 ALLOWED_METHODS 白名单');
    return;
  }
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...allowed].sort())) {
    failures.push(`桥接层白名单应恰为 ${allowed.join('/')}，实际 ${listed.join('/')}`);
    return;
  }
  // 登录态/凭据类东西绝不能出现在桥接层
  if (/secret\.|apiKey|vault/i.test(text)) {
    failures.push('桥接层出现了凭据相关字样');
    return;
  }
  passes.push('I22 桌面桥接层只暴露 snapshot/action/setting');
}

/* ---------------------------------------------------------------- 外部接口闸门 */

/**
 * `ling_open_url` / `ling_spawn_snowluma` 是两个"能对系统做事"的接口，
 * 它们的安全性完全落在 Rust 侧的校验上。JS 侧的规则可以被绕过，
 * 所以必须断言原生侧真的有闸门，而不是只在注释里写了。
 */
async function checkShellGates() {
  let rpc;
  try {
    rpc = await fs.readFile(path.join(repoRoot, 'desktop/src/rpc.rs'), 'utf8');
  } catch {
    failures.push('缺少 desktop/src/rpc.rs');
    return;
  }

  // 1. 打开网址必须有主机白名单，且白名单是常量
  if (!/const\s+ALLOWED_URL_HOSTS/.test(rpc)) {
    failures.push('ling_open_url 必须带 ALLOWED_URL_HOSTS 主机白名单');
    return;
  }
  if (!/fn\s+url_allowed/.test(rpc)) {
    failures.push('ling_open_url 必须先过 url_allowed 校验');
    return;
  }
  // 2. 必须拒绝非 http(s)：file:// 和 javascript: 是这类接口最常见的绕过方式
  if (!/strip_prefix\("http:\/\/"\)/.test(rpc) || !/strip_prefix\("https:\/\/"\)/.test(rpc)) {
    failures.push('ling_open_url 必须只接受 http/https');
    return;
  }
  // 3. 必须拒绝 user@host 伪装
  if (!/contains\('@'\)/.test(rpc)) {
    failures.push('ling_open_url 必须拒绝含 @ 的 authority（防 user@host 伪装）');
    return;
  }

  // 4. 启动 SnowLuma 必须校验目录里真有 index.mjs，否则等于"用任意参数启动任意程序"
  if (!/join\("index\.mjs"\)/.test(rpc) || !/is_file\(\)/.test(rpc)) {
    failures.push('ling_spawn_snowluma 必须校验目录内存在 index.mjs');
    return;
  }
  // 5. 启动时不能弹控制台
  if (!/creation_flags\(0x0800_0000\)/.test(rpc)) {
    failures.push('ling_spawn_snowluma 启动子进程必须带 CREATE_NO_WINDOW');
    return;
  }

  passes.push('I23 外部接口带闸门（网址白名单 / 只允许 http(s) / 启动前校验目录）');
}

/**
 * 托盘"退出"必须真的能退出。
 *
 * 这里守的是一个实际发生过的 bug：窗口的 CloseRequested 无条件
 * prevent_close（为了让点 X 只隐藏），结果托盘 quit 里调 app.exit(0)
 * 时，Tauri 去关窗口又被拦下 —— 点退出毫无反应，进程还留着。
 *
 * 修法是让 CloseRequested 先看"是否正在退出"。这条检查确保：
 * 那个退出标志必须既被写、也被读；只写不读等于没有。
 */
async function checkQuitPath() {
  let lib;
  try {
    lib = await fs.readFile(path.join(repoRoot, 'desktop/src/lib.rs'), 'utf8');
  } catch {
    failures.push('缺少 desktop/src/lib.rs');
    return;
  }

  if (!/CloseRequested/.test(lib)) return; // 没有关窗拦截，无需检查
  if (!/prevent_close/.test(lib)) return;

  // 有 prevent_close 就必须有对应的"放行"条件，否则退出永远被拦
  const writes = (lib.match(/quitting\.store\(\s*true/g) ?? []).length;
  const reads = (lib.match(/quitting\.load\(/g) ?? []).length;

  if (writes === 0) {
    failures.push('托盘退出必须设置 quitting 标志');
    return;
  }
  if (reads === 0) {
    failures.push(
      'quitting 只写不读：CloseRequested 会无条件 prevent_close，导致托盘退出无反应',
    );
    return;
  }
  /*
   * 放行必须发生在拦截之前（先判断再拦）。
   *
   * 注意只认**代码行**，不认注释：注释里也会写 prevent_close 和
   * quitting，按子串位置比较会得出相反结论（这个检查第一版就栽过）。
   */
  const codeLines = lib
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

  const idxRead = codeLines.findIndex((l) => l.includes('quitting.load('));
  const idxPrevent = codeLines.findIndex((l) => l.includes('api.prevent_close()'));

  if (idxRead === -1 || idxPrevent === -1 || idxRead > idxPrevent) {
    failures.push('quitting 的判断必须早于 api.prevent_close()，否则起不到放行作用');
    return;
  }

  passes.push('I24 托盘退出真的能退出（quitting 标志读写成对）');
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
  /*
   * 确认通道必须默认拒绝、有超时。
   *
   * ## 为什么要读两个文件
   *
   * 这条不变量原来只读 `src/index.mjs` —— 那时超时、序号、结算全挤在
   * 那个文件里。现在结算逻辑收进了 `src/guard/confirm.mjs`
   * （唯一结算入口，超时/取消/双端竞争都走它），所以：
   *
   *   · `index.mjs` 负责**注入超时值**（CONFIRM_TIMEOUT_MS = 60_000）
   *   · `confirm.mjs` 负责**按时落 deny**
   *
   * 只检查其中一个，就会在"逻辑搬家"时给出假红灯（或更糟：假绿灯）。
   * 两处都验，才真的钉住"超时即拒绝"。
   */
  const indexText = await fs.readFile(path.join(repoRoot, 'src/index.mjs'), 'utf8');
  const registryText = await fs.readFile(path.join(repoRoot, 'src/guard/confirm.mjs'), 'utf8');

  const bad = [];
  if (!/CONFIRM_TIMEOUT_MS\s*=\s*60_000/.test(indexText)) bad.push('缺 60s 确认超时');
  if (!/timeoutMs:\s*CONFIRM_TIMEOUT_MS/.test(indexText)) {
    bad.push('超时值没有传进确认登记表（配了也不生效）');
  }
  // 超时必须落在 deny：定时器回调与惰性清理两条路径都要
  const denyOnTimeout = /#settle\(\s*entry,\s*'deny',\s*SETTLE_REASON\.TIMEOUT/.test(registryText);
  if (!denyOnTimeout) bad.push('超时没有落在 deny');

  // 只在**代码**里找"始终允许"（注释里提到它是在说明为什么不提供，不算违规）
  const strip = (text) =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
  if (/始终允许|alwaysAllow/.test(strip(indexText) + strip(registryText))) {
    bad.push('代码里出现了"始终允许"（一次确认只能管一次）');
  }

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

  // (1) 保存 key 的动作必须写 vaultPath。
  //     可以重写 configPath，但只能写入空 apiKey（迁移旧明文），
  //     不能把 key 变量写进配置文件。
  const saveBlock = src.slice(src.indexOf("name === 'secret.saveApiKey'"), src.indexOf("name === 'secret.clearApiKey'"));
  if (!saveBlock.includes('paths.vaultPath')) {
    failures.push('I21 保存 API Key 时没有写入保险箱（paths.vaultPath）');
    return;
  }
  const writesConfig = saveBlock.includes('paths.configPath');
  const clearsConfigKey = /apiKey:\s*''/.test(saveBlock);
  const writesRawKey = /apiKey:\s*(?!'')\w/.test(saveBlock);
  if (writesRawKey) {
    failures.push('I21 保存 API Key 时把 key 写进了 config.json —— 明文落盘');
    return;
  }
  if (writesConfig && !clearsConfigKey) {
    failures.push('I21 保存 API Key 时重写 config.json 但没有清空 apiKey 字段');
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

/* ---------------------------------------------------------------- 确认路由 */

/**
 * 确认回复的路由归属 —— 跑真实链路自检。
 *
 * ## 为什么把它接进 check 而不是留一个独立脚本
 *
 * `scripts/verify-confirm-route.mjs` 从**原始 OneBot JSON** 开始，
 * 走真实的 normalizeEvent → 归属判定 → 结算。它能抓到单测抓不到的一类问题：
 * 字段名读错（DECISIONS K33 就是 `evt.replyToMessageId` 不存在，
 * 而所有单测都构造了正确字段，全绿）。
 *
 * 这类回归的代价很高：卡片发出去、用户回了、什么也没发生，
 * 而且日志里看起来一切正常。所以它必须**每次 check 都跑**，
 * 而不是"想起来的时候手动跑一下"。
 */
async function checkConfirmRoute() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-confirm-route.mjs')], {
      cwd: repoRoot,
      env: { ...process.env },
    });
    const m = stdout.match(/(\d+) 通过 \/ (\d+) 失败/);
    passes.push(`确认回复路由自检通过（${m ? m[1] : '?'} 项，含真实 OneBot 事件）`);
  } catch (err) {
    failures.push(`确认回复路由自检失败：\n${String(err.stdout ?? err.message).split('\n').slice(-20).join('\n')}`);
  }
}

/* ---------------------------------------------------------------- 测试 */

/**
 * 分条链路自检 —— 跑真实的解析 / 拆分 / 串行 / 记账模块，只有 send 是假的。
 *
 * ## 为什么这条也要进 check
 *
 * 单测各自 mock 得很干净，而真正出问题时往往是**接线**错了
 * （比如把 split 的结果喂给了错的参数）。那种错误在"每个函数都对"
 * 的单测里看不见，但会在真实链路上把回复发成碎片或整段丢失。
 *
 * 它不碰网络、不发 QQ、不调模型，所以每次 check 都跑得起。
 */
async function checkReplySplitRoute() {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'verify-reply-split.mjs')],
      { cwd: repoRoot, env: { ...process.env } },
    );
    const ok = (stdout.match(/✓/g) ?? []).length;
    passes.push(`分条链路自检通过（${ok} 项：解析 / 拆分 / 串行 / 记账）`);
  } catch (err) {
    failures.push(`分条链路自检失败：\n${String(err.stdout ?? err.message).split('\n').slice(-20).join('\n')}`);
  }
}

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
  await checkSpacerIsNotContainer();
  await checkRowHasNoSpacer();
  await checkBridgeSurface();
  await checkShellGates();
  await checkQuitPath();
  await checkDocsPresent();
  await checkToolResultNeverInSystem();
  await checkBehaviorLayerIsConstant();
  await checkConfirmIsFailClosed();
  await checkProactiveGuardrails();
  await checkConfirmRoute();
  await checkReplySplitRoute();
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
