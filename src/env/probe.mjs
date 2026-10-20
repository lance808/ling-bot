/**
 * 环境体检：SnowLuma 与 Node 的安装/运行状态
 *
 * ## 为什么放在后端而不是界面
 *
 * 界面（WebView）没有文件系统权限，也拿不到"本机装了哪些程序"。
 * 这些判断全需要读磁盘、连端口，只能在后端做；界面只负责展示结果。
 *
 * ## 为什么不用"找进程命令行"来判断 SnowLuma 是否运行
 *
 * 进程命令行里的路径写法不固定（`\\?\` 前缀、相对路径、bat 包装），
 * 换台机器就可能匹配不上。端口能连通才是"真的能用"—— 这才是用户关心的事。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/** SnowLuma 控制台端口（OneBot 之外的另一个端口） */
export const SNOWLUMA_CONSOLE_PORT = 5099;

/** OneBot 默认端口：WS 用来对话，HTTP 是同一套能力的备选 */
export const ONEBOT_PORTS = { ws: 3001, http: 3000 };

/** 项目要求的 Node 基线 */
export const NODE_REQUIRED = { major: 24, minor: 22, patch: 0 };

/*
 * ---------------------------------------------------------------- QQ
 *
 * SnowLuma 是"注入 QQ 客户端"的，所以 QQ 有没有装、有没有运行，
 * 是这套东西能不能用的第一前提。但它不该成为硬依赖：
 * 有人可能只想先看看界面。
 */

/** QQ 常见安装位置（新版 NT 与旧版都在，顺序按命中率排） */
export function qqCandidates() {
  const list = [];
  if (process.env.LING_QQ_EXE) list.push(process.env.LING_QQ_EXE);
  const home = os.homedir();
  for (const drive of ['C', 'D', 'E', 'F']) {
    list.push(`${drive}:\\QQ\\QQ.exe`);
    list.push(`${drive}:\\Program Files\\Tencent\\QQNT\\QQ.exe`);
    list.push(`${drive}:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe`);
  }
  list.push(path.join(home, 'AppData', 'Local', 'Programs', 'Tencent', 'QQNT', 'QQ.exe'));
  return list;
}

/**
 * 从注册表读 QQ 的安装路径。
 *
 * 为什么优先注册表：用户装哪个盘不确定，而卸载项里的 `DisplayIcon`
 * 通常写成 `D:\QQ\QQ.exe,0` —— 这是程序自己写的，比猜目录可靠。
 * 只在 Windows 且 reg.exe 可用时尝试，失败就退回候选目录。
 *
 * @returns {string | null}
 */
export function qqFromRegistry() {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/s', '/f', 'QQ', '/t', 'REG_SZ'], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // 找形如  "DisplayIcon    REG_SZ    D:\QQ\QQ.exe,0"
      for (const line of out.split(/\r?\n/)) {
        const m = /DisplayIcon\s+REG_SZ\s+(.+?)(?:,\d+)?\s*$/i.exec(line.trim());
        if (!m) continue;
        const exe = m[1].trim();
        if (/qq\.exe$/i.test(exe) && fs.existsSync(exe)) return exe;
      }
    } catch {
      // reg 不可用或没有该项：继续下一个
    }
  }
  return null;
}

/** 本机是否已有 QQ 进程在跑 */
export function qqRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /qq\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** 定位 QQ 可执行文件 */
export function findQQ(explicit) {
  const fromReg = qqFromRegistry();
  if (fromReg) return { installed: true, exe: fromReg, source: 'registry' };
  const dirs = explicit ? [explicit, ...qqCandidates()] : qqCandidates();
  for (const p of dirs) {
    if (p && fs.existsSync(p)) return { installed: true, exe: p, source: 'candidate' };
  }
  return { installed: false, exe: null, source: null };
}

/**
 * SnowLuma 的常见安装位置。
 *
 * 为什么要列这么多个：它没有标准安装器，用户普遍是自己解压到某个盘。
 * 这个列表只是"优先猜中"，猜不中还能用显式配置覆盖。
 */
export function snowlumaCandidates() {
  const list = [];
  if (process.env.LING_SNOWLUMA_DIR) list.push(process.env.LING_SNOWLUMA_DIR);
  const home = os.homedir();
  for (const drive of ['C', 'D', 'E', 'F']) {
    list.push(`${drive}:\\SnowLuma`);
    list.push(`${drive}:\\Program Files\\SnowLuma`);
  }
  list.push(path.join(home, 'SnowLuma'));
  list.push(path.join(home, 'AppData', 'Local', 'SnowLuma'));
  list.push(path.join(home, 'AppData', 'Roaming', 'SnowLuma'));
  return list;
}

/**
 * 判断一个目录是不是 SnowLuma 安装目录。
 *
 * 判据用 `release.json` + `index.mjs`：前者是它自己的版本清单（每个正式
 * 发行版都有），后者是入口。只看目录存在是不够的 —— 空目录、残留目录
 * 都会被误判成"已安装"。
 *
 * @param {string} dir
 * @returns {{installed: boolean, version?: string, dir: string, reason?: string}}
 */
export function inspectSnowLumaDir(dir) {
  const out = { installed: false, dir };
  try {
    const releasePath = path.join(dir, 'release.json');
    const entryPath = path.join(dir, 'index.mjs');
    if (!fs.existsSync(releasePath) || !fs.existsSync(entryPath)) {
      out.reason = '缺少 release.json 或 index.mjs';
      return out;
    }
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    out.installed = typeof release?.version === 'string';
    if (out.installed) out.version = release.version;
    else out.reason = 'release.json 里没有 version';
  } catch (err) {
    out.reason = `读取失败：${err.message}`;
  }
  return out;
}

/** 在候选位置里找第一个真正装好的 SnowLuma */
export function findSnowLuma(explicitDir) {
  const dirs = explicitDir ? [explicitDir, ...snowlumaCandidates()] : snowlumaCandidates();
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (!fs.existsSync(dir)) continue;
    const info = inspectSnowLumaDir(dir);
    if (info.installed) return info;
  }
  return { installed: false, dir: explicitDir ?? null };
}

/**
 * 探测某个端口上是否有人在监听。
 *
 * 用 TCP 连接而不是 HTTP 请求：控制台在启动早期可能只能建连、还答不了
 * HTTP，用连接判定能更早地给出"已经在跑"。
 *
 * @param {number} port
 * @param {{host?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export function isPortOpen(port, opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = opts.timeoutMs ?? 400;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * 解析并比较 Node 版本。
 *
 * 返回 `ok` 表示满足 `>= 24.22.0 < 25`（与 .nvmrc 一致）。
 *
 * @param {string} raw 形如 v24.22.0
 */
export function checkNodeVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? '').trim());
  if (!m) return { ok: false, version: String(raw ?? ''), reason: '无法解析版本号' };
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== NODE_REQUIRED.major) {
    return {
      ok: false,
      version: `${major}.${minor}.${patch}`,
      reason: major < NODE_REQUIRED.major ? '版本过低' : '主版本超出范围（要求 24.x）',
    };
  }
  const min = NODE_REQUIRED;
  const tooOld =
    minor < min.minor || (minor === min.minor && patch < min.patch);
  if (tooOld) {
    return { ok: false, version: `${major}.${minor}.${patch}`, reason: '低于 24.22.0' };
  }
  return { ok: true, version: `${major}.${minor}.${patch}` };
}

/**
 * 下载地址。
 *
 * 用户明确要求"不要跳官网，要直达对应版本"。所以这里给的不是首页：
 *   - Node：官方 dist 目录里具体那条 v24 线，进去就是各平台的安装包
 *     （win-x64/*.msi、osx/*.pkg、linux-x64/*.tar.xz）
 *   - SnowLuma：它自己更新检查用的同一个 GitHub release 通道
 *
 * @param {string} platform
 */
export function downloadUrls(platform = 'win32') {
  const nodeBase = 'https://nodejs.org/dist/latest-v24.x/';
  const node = {
    win32: `${nodeBase}win-x64/`,
    darwin: `${nodeBase}osx-x64/`,
    linux: `${nodeBase}linux-x64/`,
  }[platform] ?? nodeBase;
  return {
    node,
    snowluma: 'https://github.com/SnowLuma/SnowLuma/releases/latest',
  };
}

/** SnowLuma 的 release 通道（与它自己的更新检查一致） */
const SNOWLUMA_RELEASE_API = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest';

/**
 * 解析 SnowLuma 最新版的**直接下载链接**。
 *
 * 为什么不直接拼一个固定 URL：版本号会变，拼死了迟早 404。
 * 这里问一次 GitHub API，从资产列表里挑当前平台的包。
 *
 * 失败时退回 releases 页 —— 探测失败不该让整个体检失败，
 * 用户点过去还能自己挑。
 *
 * @param {string} platform
 * @returns {Promise<{url: string, version: string|null, direct: boolean}>}
 */
export async function resolveSnowLumaDownload(platform = process.platform) {
  const fallback = { url: 'https://github.com/SnowLuma/SnowLuma/releases/latest', version: null, direct: false };
  const want = { win32: 'win', darwin: 'macos', linux: 'linux' }[platform];
  if (!want) return fallback;

  try {
    const res = await fetch(SNOWLUMA_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ling-bot' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return fallback;
    const rel = await res.json();
    const assets = Array.isArray(rel?.assets) ? rel.assets : [];
    /*
     * 优先非 lite 包：lite 版少带原生组件，装完可能连不上 QQ。
     * 同一平台里再按名字稳定排序，避免每次拿到不同资产。
     */
    const mine = assets
      .filter((a) => typeof a?.name === 'string' && a.name.includes(want))
      .sort((a, b) => {
        const lite = (n) => (n.includes('lite') ? 1 : 0);
        return lite(a.name) - lite(b.name) || a.name.localeCompare(b.name);
      });
    const pick = mine[0];
    if (!pick?.browser_download_url) return fallback;
    return { url: pick.browser_download_url, version: rel.tag_name ?? null, direct: true };
  } catch {
    return fallback;
  }
}

/**
 * 汇总一次完整体检。
 *
 * @param {{snowlumaDir?: string, nodeVersion?: string, consolePort?: number}} opts
 */
export async function probeEnvironment(opts = {}) {
  const consolePort = opts.consolePort ?? SNOWLUMA_CONSOLE_PORT;
  const nodeRaw = opts.nodeVersion ?? process.version;
  const node = checkNodeVersion(nodeRaw);
  const snowluma = findSnowLuma(opts.snowlumaDir);
  const platform = opts.platform ?? process.platform;

  const [consoleOpen, wsOpen, httpOpen, snowlumaDownload] = await Promise.all([
    isPortOpen(consolePort),
    isPortOpen(ONEBOT_PORTS.ws),
    isPortOpen(ONEBOT_PORTS.http),
    resolveSnowLumaDownload(platform),
  ]);

  const qq = findQQ(opts.qqExe);

  return {
    node: {
      ...node,
      // PATH 上的 node 就是后端自己用的那个，探到即"已安装"
      installed: Boolean(nodeRaw),
      required: `>=${NODE_REQUIRED.major}.${NODE_REQUIRED.minor}.${NODE_REQUIRED.patch} <25`,
    },
    /*
     * QQ 是 SnowLuma 的前置：没有 QQ，注入无从谈起。
     * 所以它的状态要独立给出来，不能等 SnowLuma 报错才让用户去猜。
     */
    qq: {
      installed: qq.installed,
      exe: qq.exe,
      running: qqRunning(),
    },
    snowluma: {
      installed: snowluma.installed,
      version: snowluma.version ?? null,
      dir: snowluma.dir ?? null,
      reason: snowluma.reason ?? null,
      /** 控制台在跑 = 它已经启动并完成注入，可以一键打开 */
      running: consoleOpen,
      consoleUrl: `http://127.0.0.1:${consolePort}/`,
      onebot: { ws: wsOpen, http: httpOpen },
    },
    platform,
    downloads: {
      ...downloadUrls(platform),
      // 能拿到直链就用直链，拿不到退回 releases 页
      snowluma: snowlumaDownload.url,
      snowlumaVersion: snowlumaDownload.version,
      snowlumaDirect: snowlumaDownload.direct,
    },
  };
}
