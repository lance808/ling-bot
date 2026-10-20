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
 * 这个项目要装到别人电脑上，所以不能靠"猜盘符"。按可靠性从高到低试：
 *
 *   1. Tencent\QQNT 的 `Install` 值
 *      —— QQ 安装器自己写的安装目录（实测 HKLM\SOFTWARE\WOW6432Node\
 *      Tencent\QQNT 下 Install = D:\QQ）。这是最权威的来源：不管装在
 *      哪个盘、哪个自定义目录，只要走正常安装流程就会写这个值。
 *
 *   2. App Paths\QQ.exe
 *      —— Windows 按程序名定位 exe 的标准位置。有些安装方式会写这里，
 *      写了的机器上它能直接给出完整 exe 路径。
 *
 *   3. 卸载项里的 DisplayIcon / InstallLocation
 *      —— 最后的注册表兜底。DisplayIcon 常写成 "D:\QQ\QQ.exe,0"，
 *      要剥掉逗号后的图标序号。
 *
 * 每条都要落到"文件真实存在"才算数：注册表可能残留旧路径，
 * 用户可能把 QQ 卸了但没清干净。
 *
 * @returns {string | null}
 */
export function qqFromRegistry() {
  if (process.platform !== 'win32') return null;

  /** 跑 reg query，拿 stdout；失败返回 null */
  const query = (key, ...extra) => {
    try {
      return execFileSync('reg', ['query', key, ...extra], {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  /** 从一段 reg 输出里取某个值的字符串内容 */
  const readValue = (text, name) => {
    if (!text) return null;
    // 形如 "    Install    REG_SZ    D:\QQ"
    const re = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.+?)\\s*$`, 'im');
    const m = re.exec(text);
    return m ? m[1].trim() : null;
  };

  // ---- 1. Tencent\QQNT 的 Install ----
  const qqntKeys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
    'HKLM\\SOFTWARE\\Tencent\\QQNT',
    'HKCU\\SOFTWARE\\Tencent\\QQNT',
  ];
  for (const key of qqntKeys) {
    const dir = readValue(query(key), 'Install');
    if (!dir) continue;
    const exe = path.join(dir, 'QQ.exe');
    if (fs.existsSync(exe)) return exe;
  }

  // ---- 2. App Paths ----
  const appPathKeys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QQ.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QQ.exe',
  ];
  for (const key of appPathKeys) {
    const raw = readValue(query(key), '');
    if (!raw) continue;
    // 这个值可能带引号
    const exe = raw.replace(/^"|"$/g, '').trim();
    if (/qq\.exe$/i.test(exe) && fs.existsSync(exe)) return exe;
  }

  // ---- 3. 卸载项 ----
  const uninstallKeys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of uninstallKeys) {
    const out = query(root, '/s', '/f', 'QQ', '/t', 'REG_SZ');
    if (!out) continue;
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      // DisplayIcon 优先，其次是 InstallLocation
      const mIcon = /^DisplayIcon\s+REG_SZ\s+(.+?)(?:,\d+)?\s*$/i.exec(t);
      if (mIcon) {
        const exe = mIcon[1].trim().replace(/^"|"$/g, '');
        if (/qq\.exe$/i.test(exe) && fs.existsSync(exe)) return exe;
      }
      const mLoc = /^InstallLocation\s+REG_SZ\s+(.+?)\s*$/i.exec(t);
      if (mLoc) {
        const dir = mLoc[1].trim().replace(/^"|"$/g, '');
        if (dir) {
          const exe = path.join(dir, 'QQ.exe');
          if (fs.existsSync(exe)) return exe;
        }
      }
    }
  }

  return null;
}

/*
 * ---------------------------------------------------------------- 进程存活
 *
 * 为什么不解析 `tasklist` 的文本：它在中文 Windows 上是 GBK，
 * 用 utf8 解码会得到乱码（实测 `��Ϣ`）；而且"没有匹配"那句
 * 提示语里也含 `QQ.exe`，正则容易被它骗到。
 *
 * 改用 WMIC / PowerShell 拿**结构化**结果，只问"进程在不在"，
 * 不碰任何需要本地化的文字。
 */

/**
 * 某个进程名当前有几个实例。
 *
 * @param {string} name 例如 'QQ.exe'
 * @returns {number}
 */
export function processCount(name) {
  if (process.platform !== 'win32') return 0;

  /*
   * 先用 wmic：它比启动 PowerShell 快一个数量级（约 100ms vs 700ms），
   * 而体检卡每次刷新都要问一次。PowerShell 留作兜底 ——
   * 新版 Windows 已经开始移除 wmic，不能只依赖它。
   */
  try {
    const out = execFileSync('wmic', ['process', 'where', `name='${name}'`, 'get', 'ProcessId'], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 输出形如 "ProcessId\n1234\n5678\n"：数字行数就是进程数
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)).length;
  } catch {
    // wmic 不存在或被禁用：退回 CIM
  }

  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='${name}'" -ErrorAction SilentlyContinue).Count`,
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** 本机是否已有 QQ 进程在跑 */
export function qqRunning() {
  return processCount('QQ.exe') > 0;
}

/** 定位 QQ 可执行文件 */
/**
 * 定位 QQ 可执行文件。
 *
 * 优先级：**用户手动指定 > 注册表 > 猜常见目录**。
 *
 * 手动指定必须排第一 —— 那是用户在界面上亲手指的路径，
 * 机器上可能装着两套 QQ（新旧版并存），或者装在自动识别
 * 够不到的地方。自动识别再"聪明"也不该覆盖人的明确选择。
 *
 * `explicit` 既接受 exe 路径，也接受安装目录：
 * 用户从资源管理器复制过来的往往是目录。
 *
 * @param {string} [explicit]
 */
export function findQQ(explicit) {
  if (explicit) {
    const raw = String(explicit).trim().replace(/^"|"$/g, '');
    if (raw) {
      // 是个目录就给补上 QQ.exe；已经是 exe 就直接用
      const asExe = /\.exe$/i.test(raw) ? raw : path.join(raw, 'QQ.exe');
      if (fs.existsSync(asExe)) return { installed: true, exe: asExe, source: 'manual' };
      /*
       * 用户填了但文件不在：不能静默回退到自动识别 —— 那样他会以为
       * 自己填的生效了。这里如实报"没找到"，让界面提示他路径有问题。
       */
      return { installed: false, exe: null, source: 'manual', badPath: raw };
    }
  }

  const fromReg = qqFromRegistry();
  if (fromReg) return { installed: true, exe: fromReg, source: 'registry' };

  for (const p of qqCandidates()) {
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
      /*
       * 来源要让界面能看见：手动指定 / 注册表 / 猜出来的目录。
       * 自动找到的路径可能不是用户想要的那套（机器上装着两份 QQ），
       * 标出来他才好判断要不要手动改。
       */
      source: qq.source ?? null,
      /** 用户填了但文件不存在时，把这个值带回去让他改 */
      badPath: qq.badPath ?? null,
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
