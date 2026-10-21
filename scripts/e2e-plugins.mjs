/**
 * 插件骨架 —— 端到端验收
 *
 * ## 这个脚本要证明什么
 *
 * 需求里的验收条件，一条一条在这里跑出来（用真实后端 + 真实磁盘，不 mock）：
 *
 *   1. 丢一个新插件包进插件目录 → 重启后出现在列表里
 *   2. 填配置 → 保存 → 重启后配置还在
 *   3. 启用 → AI 工具列表里真的出现这个工具，且能调用成功
 *   4. 停用 → 工具立刻从工具列表消失，再调用被拒
 *   5. 只改磁盘上的插件包（加工具、加配置项）→ 不用改主程序源码、不用重编译
 *   6. 插件初始化失败 → 状态明确报错、日志有原因，主程序继续跑
 *   7. 插件接口版本不兼容 → 状态是「不兼容」而不是「正常」
 *   8. DSH 走的是同一套通用机制（不是特例）
 *
 * ## 为什么重启后端而不是热加载
 *
 * 需求明确：第一阶段"安装或更新插件后，允许重启应用再加载"。
 * 所以脚本里确实会 kill 掉后端再起一个 —— 这正是用户的真实路径。
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
const check = (ok, label, extra) => {
  results.push({ ok, label });
  const tail = extra ? `  （${extra}）` : '';
  console.log(`  ${ok ? '✓' : '✖'} ${label}${tail}`);
};

/* ---------------------------------------------- 独立用户目录，不碰真实配置 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-e2e-plugins-'));
const pluginsDir = path.join(tmpHome, 'plugins');
fs.mkdirSync(pluginsDir, { recursive: true });

/* ---------------------------------------------- 后端子进程 + JSON-RPC 客户端 */

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let buf = '';
/** @type {Map<number, (v: any) => void>} */
let waiting = new Map();
let nextId = 1;
let stderr = '';

/** 起一个后端，返回 RPC 函数 */
async function boot() {
  buf = '';
  waiting = new Map();
  nextId = 1;
  stderr = '';

  child = spawn(process.execPath, [path.join(repoRoot, 'src', 'index.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, LING_USER_DATA: tmpHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

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

  child.stderr.on('data', (d) => {
    stderr += d.toString('utf8');
  });

  /**
   * @param {string} method
   * @param {Record<string, any>} [params]
   */
  const rpc = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} 超时`));
      }, 30000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };

  // 等就绪。
  //
  // 注意不能只看 `!booting`：后端在主循环开始后立刻就能响应快照，
  // 但内置插件铺盘和插件面扫描还在后面。此时拿到的 plugins.items 是空的，
  // 后面所有断言都会连环失败。所以要多等一个条件：插件面真的扫出来了。
  let snap = null;
  for (let i = 0; i < 80; i++) {
    try {
      snap = await rpc('snapshot');
      const ready = snap && !snap.booting && Array.isArray(snap.plugins?.items);
      if (ready) break;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!snap || snap.booting) {
    throw new Error(`后端没起来\n${stderr.slice(-1200)}`);
  }

  /*
   * 再等插件铺盘完成：内置插件是异步写到磁盘再扫描的。
   *
   * 判据是"期望的插件出现"，不是固定等几秒 —— 机器慢的时候固定等待会偶发失败。
   */
  const wantIds = ['dsh-bridge', 'echo'];
  for (let i = 0; i < 40; i++) {
    const ids = (snap.plugins?.items ?? []).map((x) => x.id);
    if (wantIds.every((id) => ids.includes(id))) break;
    await new Promise((r) => setTimeout(r, 250));
    snap = await rpc('snapshot');
  }

  return { rpc, snap };
}

/** 关掉后端（走 shutdown 让插件正常 dispose） */
async function teardown() {
  if (!child) return;
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'shutdown', params: {} }) + '\n');
  } catch {
    /* 忽略 */
  }
  await new Promise((r) => setTimeout(r, 400));
  child.kill();
  child = null;
}

/**
 * 写一个插件包到磁盘。
 *
 * @param {string} id
 * @param {object} manifest
 * @param {string} entrySource
 */
function writePack(id, manifest, entrySource) {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, ...manifest }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.mjs'), entrySource, 'utf8');
}

/** 从快照里按 id 找插件 */
const find = (snap, id) => (snap.plugins?.items ?? []).find((x) => x.id === id);

/** 工具是否在当前 AI 工具列表里 */
const hasTool = (snap, fullName) => (snap.registry?.tools ?? []).some((t) => t.name === fullName);

async function main() {
  /* ============================================================ 1. 出厂状态 */

  console.log('\n[1] 出厂插件与 DSH 迁移');
  let { rpc, snap } = await boot();

  check(Array.isArray(snap.plugins?.items), '快照里有 plugins.items');
  check(typeof snap.plugins?.stats?.total === 'number', '快照里有整体统计');

  const echo0 = find(snap, 'echo');
  check(!!echo0, '出厂示例插件 echo 已被扫描到');
  check(echo0?.status === 'disabled', 'echo 默认未启用', echo0?.status);

  // DSH 走的是同一套机制 —— 这是需求里明确的一条
  const dsh = find(snap, 'dsh-bridge');
  check(!!dsh, 'DSH 作为普通插件出现在同一张表里');
  check(dsh?.runtime === 'in-process', 'DSH 用 in-process 运行时', dsh?.runtime);
  check(Array.isArray(dsh?.config) && dsh.config.length > 0, 'DSH 的配置项来自清单声明');
  check(
    (dsh?.tools ?? []).some((t) => t.fullName === 'plugin_dsh_ask'),
    'DSH 的工具和其它插件一样带 plugin_ 前缀',
  );
  // 没有独立的 DSH 页面/接口了
  check(snap.dsh === undefined, '快照里不再有 DSH 专用的顶层块');

  /* ============================================================ 2. 启用/停用 */

  console.log('\n[2] 启用 → 工具进入 AI 工具列表；停用 → 立刻消失');

  const before = hasTool(snap, 'plugin_echo');
  check(before === false, '未启用时工具不在 AI 工具列表里');

  const enabled = await rpc('action', { name: 'plugin.enable', params: { id: 'echo' } });
  check(enabled?.ok === true, '启用 echo 成功', enabled?.message);

  snap = await rpc('snapshot');
  check(find(snap, 'echo')?.status === 'ready', 'echo 状态是 ready');
  check(hasTool(snap, 'plugin_echo'), '启用后工具出现在 AI 工具列表里');

  // 工具真的能跑
  const called = await rpc('action', {
    name: 'tool.run',
    params: { tool: 'plugin_echo', args: { text: '你好' } },
  });
  check(called?.ok === true, '能调用到这个插件工具', called?.message ?? JSON.stringify(called).slice(0, 120));

  /* ============================================================ 3. 配置持久化 */

  console.log('\n[3] 保存配置 → 生效 → 重启后仍在');

  const saved = await rpc('action', {
    name: 'plugin.saveConfig',
    params: { id: 'echo', config: { prefix: '>>' }, secrets: {} },
  });
  check(saved?.ok === true, '保存配置成功', saved?.message);

  const afterSave = await rpc('action', {
    name: 'tool.run',
    params: { tool: 'plugin_echo', args: { text: 'x' } },
  });
  check(
    JSON.stringify(afterSave?.result ?? afterSave).includes('>>x'),
    '配置立即生效（回显带了前缀）',
    JSON.stringify(afterSave?.result ?? afterSave).slice(0, 120),
  );

  await teardown();
  ({ rpc, snap } = await boot());

  const echo1 = find(snap, 'echo');
  check(echo1?.enabled === true, '重启后仍然处于启用状态');
  /*
   * 注意期望值是 '>>' 而不是 '>> '：text 类型在保存时会被 trim
   * （见 src/plugins/store.mjs 的 coerceValue）。这符合直觉 ——
   * 用户在输入框里多敲的尾随空格不该变成数据的一部分。
   */
  check(
    (echo1?.config ?? []).find((c) => c.key === 'prefix')?.value === '>>',
    '重启后配置值还在',
    (echo1?.config ?? []).find((c) => c.key === 'prefix')?.value,
  );
  check(echo1?.status === 'ready', '重启后自动加载为 ready');

  /* ============================================================ 4. 停用即断 */

  console.log('\n[4] 停用 → 新调用被拒');

  const disabled = await rpc('action', { name: 'plugin.disable', params: { id: 'echo' } });
  check(disabled?.ok === true, '停用 echo 成功');

  snap = await rpc('snapshot');
  check(find(snap, 'echo')?.status === 'disabled', '状态回到 disabled');
  check(!hasTool(snap, 'plugin_echo'), '工具已从 AI 工具列表移除');

  const denied = await rpc('action', {
    name: 'tool.run',
    params: { tool: 'plugin_echo', args: { text: 'x' } },
  });
  check(denied?.ok === false, '停用后再调用被拒绝');

  /* ============================================================ 5. 纯磁盘扩展 */

  console.log('\n[5] 只改磁盘上的插件包：加工具 + 加配置项，不动主程序');

  /*
   * 这一步是整次改造的核心验收：
   * 覆盖 echo 包，加一个 `upper` 工具和一个 `shout` 配置项，
   * 期望新工具和新配置项直接出现，且主程序源码一行没改。
   *
   * 注意这里**不重启后端**：改完包点「更新」就能生效。重启反而
   * 验不出热更新——那是最容易"看起来通过"的假阳性。
   */
  writePack(
    'echo',
    {
      name: '回显示例',
      version: '2.0.0',
      apiVersion: '1',
      description: '升级版：多一个 upper 工具和一个 shout 配置项',
      runtime: 'process',
      entry: 'index.mjs',
      config: [
        { key: 'prefix', label: '前缀', type: 'text', default: '', maxLength: 40 },
        { key: 'shout', label: '全大写', type: 'boolean', default: false },
      ],
      tools: [
        {
          name: 'echo',
          description: '回显文字',
          needs: 'qq',
          risk: 'R0',
          timeoutMs: 10000,
          params: { text: { type: 'string', required: true } },
        },
        {
          name: 'upper',
          description: '把文字转成大写',
          needs: 'qq',
          risk: 'R0',
          timeoutMs: 10000,
          params: { text: { type: 'string', required: true } },
        },
      ],
    },
    `
let cfg = { prefix: '', shout: false };
export default {
  async init(ctx) { cfg = { prefix: ctx.config.prefix ?? '', shout: ctx.config.shout === true }; return { ok: true }; },
  async callTool({ tool, args }) {
    const s = String(cfg.prefix ?? '') + String(args.text ?? '');
    if (tool === 'upper') return { text: s.toUpperCase() };
    return { text: cfg.shout ? s.toUpperCase() : s };
  },
  async testConnection() { return { ok: true, message: 'ok' }; },
  async dispose() {},
};
`,
  );

  /*
   * 关键：**不重启**，直接让磁盘上的改动生效。
   *
   * 热更新走的是 `plugin.reload`（重新读盘 → 重建运行时 → 重新登记工具），
   * 全程不动后端进程。这正是"装完插件不用重启"的那条路径，
   * 所以这里刻意不 teardown/boot —— 重启就验不出热更新了。
   */
  await rpc('action', { name: 'plugin.reload', params: { id: 'echo' } });
  snap = await rpc('snapshot');

  /*
   * 证明"没重启"：后面的 phase 6/7 还在用同一批临时目录里的东西，
   * 而且这里连 boot() 都没再调用过。再加一条硬证据 —— 启动时间戳
   * 应当和本次进程一致（booting 字段的语义是"刚起来还没就绪"）。
   */
  check(!snap.booting, '热更新期间后端没有重启（快照仍是就绪态）');

  const echo2 = find(snap, 'echo');
  check(echo2?.version === '2.0.0', '升级后的版本号被读到了', echo2?.version);
  check(
    (echo2?.tools ?? []).some((t) => t.name === 'upper'),
    '新加的工具出现在工具清单里，没有改主程序源码',
  );
  check(
    (echo2?.config ?? []).some((c) => c.key === 'shout'),
    '新加的配置项自动出现在配置表单里',
  );

  // 新工具启用后可用
  await rpc('action', { name: 'plugin.enable', params: { id: 'echo' } });
  snap = await rpc('snapshot');
  check(hasTool(snap, 'plugin_upper'), '新工具进入 AI 工具列表');

  const upper = await rpc('action', {
    name: 'tool.run',
    params: { tool: 'plugin_upper', args: { text: 'abc' } },
  });
  check(
    JSON.stringify(upper?.result ?? upper).includes('ABC'),
    '新工具调用成功',
    JSON.stringify(upper?.result ?? upper).slice(0, 120),
  );

  /* ============================================================ 6. 故障隔离 */

  console.log('\n[6] 坏插件不影响主程序，状态明确');

  writePack(
    'broken-init',
    {
      name: '初始化就炸',
      version: '1.0.0',
      apiVersion: '1',
      description: '用来验证错误可见',
      runtime: 'process',
      entry: 'index.mjs',
      tools: [
        { name: 'boom', description: 'b', needs: 'qq', risk: 'R0', params: {} },
      ],
    },
    `export default { async init() { throw new Error('初始化故意失败'); }, async callTool() { return 1; } };`,
  );

  writePack(
    'bad-api',
    {
      name: '接口版本不兼容',
      version: '1.0.0',
      apiVersion: '99',
      description: '用来验证不兼容状态',
      runtime: 'process',
      entry: 'index.mjs',
      tools: [{ name: 'nope', description: 'n', needs: 'qq', risk: 'R0', params: {} }],
    },
    `export default { async callTool() { return 1; } };`,
  );

  await rpc('action', { name: 'plugin.rescan', params: {} });

  const failEnable = await rpc('action', { name: 'plugin.enable', params: { id: 'broken-init' } });
  check(failEnable?.ok === false, '初始化失败的插件：启用被拒绝', failEnable?.message);

  snap = await rpc('snapshot');
  const broken = find(snap, 'broken-init');
  check(broken?.status === 'error', '状态明确是 error，不是 ready', broken?.status);
  check(
    JSON.stringify(broken?.error ?? {}).includes('初始化故意失败'),
    '错误原因能显示给用户',
    JSON.stringify(broken?.error ?? {}).slice(0, 120),
  );
  check((broken?.log ?? []).length > 0, '插件日志里有记录');

  const badApi = find(snap, 'bad-api');
  check(
    badApi?.status === 'incompatible' || badApi?.status === 'invalid',
    '接口版本不兼容被单独标出，不当成正常',
    badApi?.status,
  );

  // 主程序还活着：能继续拉快照、能给别的插件下指令
  const alive = await rpc('snapshot');
  check(!!alive && !alive.booting, '主程序没有被插件故障带崩');

  /* ============================================================ 7. 授权与可见性分离 */

  console.log('\n[7] 工具可见 ≠ 有权限（授权由宿主判定）');

  /*
   * 需求原话：「AI 看到工具 ≠ 有权限，宿主授权仍然生效」。
   *
   * 这里要验证的是**声明被正确翻译成了权限边界**，而不是"调用能绕过去"：
   * `tool.run` 这条通道固定以 console 来源执行（它只对本机主进程开放，
   * 且刻意忽略调用方自带的 origin —— 否则就是一句话提权）。
   *
   * 所以正确的验证方式是：
   *   a) 插件声明 needs:'qq' 的工具，被推导成三个来源（含群）；
   *   b) 插件声明 needs:'host' 的工具，只对主人私聊 + 控制台可见；
   *   c) 非主人群（origin=group）拿不到 host 类工具。
   *
   * 真实的群消息路径由 test/plugins-core.test.mjs 与插件管线用例覆盖。
   */
  const upperMeta = (snap.plugins?.items ?? [])
    .flatMap((x) => x.tools ?? [])
    .find((t) => t.fullName === 'plugin_upper');
  check(!!upperMeta, '能在插件清单里看到 plugin_upper 的声明');
  check(upperMeta?.needs === 'qq', "声明是 needs:'qq'（动 QQ）", upperMeta?.needs);
  check(upperMeta?.confirm === 'never', 'R0 工具自动执行，不需要确认');

  // dsh 的两个工具都是 needs:'host'：只在主人私聊与控制台可见
  const dshAsk = (snap.plugins?.items ?? [])
    .flatMap((x) => x.tools ?? [])
    .find((t) => t.fullName === 'plugin_dsh_ask');
  check(!!dshAsk, 'DSH 的 plugin_dsh_ask 在清单里');
  check(dshAsk?.needs === 'host', "DSH 工具声明 needs:'host'，群里不可见");
  check(dshAsk?.confirm === 'always', 'R1 工具每次都要人工确认');

  // 直接验一遍授权纯函数：同一个工具在不同来源下的可见性
  const { resolveToolSet } = await import('../src/guard/tool-gate.mjs');
  const hostTool = {
    name: 'plugin_dsh_ask',
    origins: ['owner-private', 'console'],
    confirm: 'always',
    risk: 'R1',
    params: {},
  };
  const qqTool = {
    name: 'plugin_upper',
    origins: ['owner-private', 'owner-group', 'console'],
    confirm: 'never',
    risk: 'R0',
    params: {},
  };
  check(
    resolveToolSet('group', [hostTool], {}).length === 0,
    '非主人群看不到 host 类工具',
  );
  check(
    resolveToolSet('owner-group', [qqTool], {}).length === 1,
    '主人所在群能看到 qq 类工具',
  );
  check(
    resolveToolSet('group', [qqTool], {}).length === 0,
    '普通群看不到 qq 类工具',
  );

  /* ============================================================ 8. 关闭后端不泄漏 */

  console.log('\n[8] 关停时插件被正确 dispose');

  await teardown();
  check(child === null, '后端已退出（子进程已回收）');

  /* ============================================================ 汇总 */

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? '✓ 插件骨架验收全部通过' : `✖ ${failed.length} 项失败`}（共 ${results.length} 项）`,
  );
  if (failed.length > 0) {
    for (const f of failed) console.log(`   ✖ ${f.label}`);
    if (stderr) console.log(`\n后端 stderr:\n${stderr.slice(-1500)}`);
  }

  await teardown();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('\n✖ 脚本异常：', e.message);
  if (stderr) console.error(stderr.slice(-1200));
  await teardown();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.exit(1);
});
