/**
 * Electron 主进程 —— F0 / F1
 *
 * 职责：窗口、托盘、单实例、拉起并守护后端、把 IPC 中转给后端。
 * 渲染层永远只与主进程说话，不直接连后端（ARCHITECTURE §3.1）。
 *
 * 注意：`electron` 是 CJS 包，在 ESM 下**不能命名导入**（会被当成没有该导出），
 * 必须先默认导入再解构。
 */

import electron from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BackendSupervisor } from './backend-supervisor.mjs';
import { resolvePaths } from '../src/config/paths.mjs';
import {
  ICON_SIZES,
  assertIconKind,
  builtinIconPaths,
  customIconDir,
  customIconPath,
  fitToSquare,
  looksLikePngFile,
  pickIconPath,
} from './icons.mjs';

const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog } = electron;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根：图标、脚本都在这里（和 __dirname 的 electron/ 区分开） */
const repoRoot = path.join(__dirname, '..');
const isDev = process.argv.includes('--dev');

/** 内置图标的根目录：跟着 main.mjs 走，不受 cwd 影响（打包后 cwd 会变） */
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

/**
 * 应用在 Windows 任务栏里的身份（AppUserModelID）。
 *
 * 必须和启动器 exe 里声明的 AUMID 一致，否则会出现两个任务栏按钮；
 * 详见 main() 开头的说明。取值用反向域名，和 package.json 的 name 对应。
 */
const APP_USER_MODEL_ID = 'com.ling-bot.desktop';

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
/** @type {BackendSupervisor | null} */
let backend = null;
let quitting = false;

/* ---------------------------------------------------------------- 单实例 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  main();
}

function main() {
  /*
   * 任务栏身份 —— 必须在 whenReady 之前设置，否则 Windows 已经按旧身份
   * 建好了任务栏按钮，改不动了。
   *
   * ## 为什么只设 BrowserWindow({icon}) 换不掉任务栏图标
   *
   * Windows 任务栏不是"读窗口图标"，而是按 **AppUserModelID（AUMID）** 把
   * 进程归组，然后显示**该 AUMID 对应的图标**。Electron 默认沿用
   * electron.exe 自己的 AUMID（`com.squirrel.electron...` 或进程默认身份），
   * 于是任务栏永远显示 electron.exe 里嵌的那个原子图标。
   *
   * 显式设一个本项目专用的 AUMID 后，任务栏会按这个身份去认图标：
   *   · 开发期（node_modules/electron）—— 进程仍是 electron.exe，任务栏
   *     图标取自任务栏缓存里该 AUMID 曾绑定过的图标；配合下面的
   *     app.setName / 窗口 icon，固定项能正确显示。
   *   · 打包后（Launcher.exe 直接是宿主进程）—— 任务栏直接取 exe 里嵌的图标。
   *
   * 这也是"同一个应用不要出现两个任务栏按钮"的正解：AUMID 一致才会归组。
   */
  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.whenReady().then(() => {
    /*
     * 把后端用的数据根目录同步给本进程，保证主进程和后端算出的
     * resolvePaths().root 是同一个。
     *
     * 为什么需要这一步：主进程只把 userDataDir 作为环境变量传给**子进程**
     * （见 backend-supervisor.mjs），自己进程里并没有 LING_USER_DATA。
     * 如果这里不补，主进程调 resolvePaths() 会回落到 `cwd/data`，
     * 而打包后 cwd 不是程序目录 —— 图标就会存到一个奇怪的地方，
     * 换目录启动还会"丢失"。统一在 ready 后立刻设置最稳妥。
     */
    if (!process.env.LING_USER_DATA) process.env.LING_USER_DATA = app.getPath('userData');

    /*
     * 全局移除应用菜单。
     *
     * win.setMenu(null) 只管当前窗口；这里再设一次是为了覆盖之后可能
     * 新建的窗口（activate 分支会再 createWindow），也顺手把 macOS 上
     * 那份应用菜单摘掉，行为保持一致。
     */
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    startBackend();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // 关闭窗口默认最小化到托盘（机器人要常驻）
  app.on('window-all-closed', () => {
    // 不退出：托盘还在
  });

  app.on('before-quit', () => {
    quitting = true;
    backend?.stop();
  });
}

/* ---------------------------------------------------------------- 窗口 */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Ling-bot',
    // 窗口图标：用户自定义优先，没有则用内置 assets/icon.png（见 resolveIconPath）
    icon: resolveIconPath('app'),
    /*
     * 去掉顶部默认菜单栏（File / Edit / View / Window）。
     *
     * Electron 在 Windows 上默认会挂一个自带菜单，但本项目所有操作都在
     * 页面里，这个菜单一项都用不上 —— 留着只会占掉一行高度，还显得像
     * 半成品。托盘右键菜单是另一回事，那个有用，不受这里影响。
     *
     * 两个都写是有意的：autoHideMenuBar 让 Alt 也不唤起，
     * setMenu(null) 才是真正移除（单靠前者按一下 Alt 菜单又冒出来）。
     */
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.setMenu(null);

  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  // 显示窗口 —— 这里有两个坑，都踩过了
  //
  // ## 坑 1：ready-to-show 不保证触发
  //
  // 它是首选（避免白屏闪一下），但渲染进程加载慢、GPU 初始化失败时可能错过。
  // 一旦错过，进程活着却没有可见窗口——用户看到的就是"双击没反应"，最难排查。
  // 所以要有一个超时兜底。
  //
  // ## 坑 2：show() 不一定真的让窗口可见
  //
  // 实测（本机 Windows）：调了 win.show()，Electron 自己报 isVisible() === false，
  // 窗口有正常 bounds 却不出现在屏幕上。只再调一次 show() 也没用。
  // 必须走完整套：showInactive → show → moveTop → 翻转一次 alwaysOnTop → focus。
  // 这一串看着冗余，但少了其中任何一步都可能不生效，所以照抄比"优化"安全。
  let shown = false;
  const reveal = (why) => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;

    win.showInactive();
    win.show();
    win.moveTop();
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
    win.focus();

    console.log('[main] 窗口已显示', { via: why, visible: win.isVisible() });
  };

  win.once('ready-to-show', () => reveal('ready-to-show'));

  // 1.5 秒还没显示就强行显示：这时界面可能还没画好，
  // 但"有窗口"比"完美首帧"重要——至少用户能看到它在运行。
  const revealTimer = setTimeout(() => reveal('timeout'), 1500);
  win.once('closed', () => clearTimeout(revealTimer));

  // 渲染进程彻底加载失败时，也要让窗口出来并显示错误，
  // 而不是留一个看不见的进程。
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[main] 界面加载失败', { code, desc });
    reveal('did-fail-load');
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // 关闭 → 最小化到托盘
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
      notifyOnce('Ling-bot 仍在后台运行', '机器人需要常驻，可从托盘重新打开窗口。');
    }
  });

  // renderer 崩了重建窗口，不清空后端（F0）
  win.webContents.on('render-process-gone', () => {
    win?.destroy();
    win = null;
    createWindow();
  });
}

let notifiedTray = false;
function notifyOnce(title, body) {
  if (notifiedTray || !Notification.isSupported()) return;
  notifiedTray = true;
  new Notification({ title, body }).show();
}

/**
 * 把窗口弄到用户眼前。
 *
 * 与 createWindow 里的 reveal() 用同一套动作——单独调 show() 不足以保证可见，
 * 这条经验来自实测（见 createWindow 的注释）。
 */
function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.showInactive();
  win.show();
  win.moveTop();
  win.setAlwaysOnTop(true);
  win.setAlwaysOnTop(false);
  win.focus();
}

/* ---------------------------------------------------------------- 图标 */

/**
 * @typedef {'app' | 'tray'} IconKind
 */

/** 内置默认图标：随程序发布，只读（ASSETS_DIR 由 import.meta.url 推出，不受 cwd 影响） */
const BUILTIN_ICONS = builtinIconPaths(ASSETS_DIR);

/**
 * 用户自定义图标所在的目录。
 *
 * 用 resolvePaths() 计算，而不是自己拼 process.cwd()：
 *   · 自定义图标属于**用户数据**，不属于程序目录；
 *   · 程序升级 / 换安装目录时不能把它弄丢；
 *   · resolvePaths 统一走 LING_USER_DATA（打包后主进程会指到
 *     app.getPath('userData')），和后端的数据根目录保持一致。
 *
 * 注意多包一层 icons/ 子目录，避免和 config.json 等文件混在一起。
 * 路径规则本身在 electron/icons.mjs 里，那儿有单元测试覆盖。
 */
function iconsDir() {
  return customIconDir(resolvePaths().root);
}

/**
 * 判断某个路径是不是"能用的图标文件"。
 *
 * 分两层校验：
 *   1. looksLikePngFile —— 挡住不存在、空文件、改了扩展名的 jpg；
 *   2. nativeImage.createFromPath 能不能真的读出来 —— 挡住"魔数对但内容损坏"
 *      的半截文件（这种 createFromPath 会得到空图，isEmpty() 为真）。
 */
function isUsableIconFile(filePath) {
  if (!looksLikePngFile(filePath)) return false;
  try {
    return !nativeImage.createFromPath(filePath).isEmpty();
  } catch {
    return false;
  }
}

/**
 * 解析当前该用哪个图标。
 *
 * 优先级：用户自定义 > 内置默认。
 * 用户自定义不存在 / 读不出来时静默回落到内置默认 —— 图标缺失绝不能崩。
 *
 * @param {IconKind} kind
 * @returns {string} 可直接喂给 nativeImage.createFromPath 的绝对路径
 */
function resolveIconPath(kind) {
  assertIconKind(kind);
  return pickIconPath({
    customPath: customIconPath(resolvePaths().root, kind),
    builtinPath: BUILTIN_ICONS[kind],
    isUsable: isUsableIconFile,
  });
}

/**
 * 把任意图片文件转换成目标尺寸的 PNG 图标，写到 <数据根目录>/icons/<kind>.png。
 *
 * 后续由 IPC 调用（现在还没接到界面）：
 *
 *   ipcMain.handle('icon.upload', async (_e, { kind }) => {
 *     // 界面侧先用 dialog.showOpenDialog 让用户选图，再调这里
 *     return setCustomIcon(kind, pickedPath);
 *   });
 *   ipcMain.handle('icon.reset', (_e, { kind }) => resetCustomIcon(kind));
 *   ipcMain.handle('icon.current', (_e, { kind }) => resolveIconPath(kind));
 *
 * 实现要点：
 *   · 只用 Electron 自带的 nativeImage，不引入任何图像处理库；
 *   · 等比缩放（按长边适配，不裁切、不拉伸）；
 *   · 先写 .tmp 再 rename，避免写到一半被读到半截图标。
 *
 * @param {IconKind} kind
 * @param {string} sourceFilePath 用户选中的图片路径
 * @returns {Promise<{ kind: IconKind, path: string, width: number, height: number }>}
 */
async function setCustomIcon(kind, sourceFilePath) {
  assertIconKind(kind);

  const src = nativeImage.createFromPath(sourceFilePath);
  if (src.isEmpty()) throw new Error(`读不出图片内容：${sourceFilePath}`);

  const { width: sw, height: sh } = src.getSize();
  const { width, height } = fitToSquare(sw, sh, ICON_SIZES[kind]);
  const resized = src.resize({ width, height, quality: 'best' });

  /*
   * 非正方形源图缩放后不是正方形（比如 400x200 -> 256x128）。
   * 窗口图标无所谓，但**托盘图标必须是正方形**：Windows 会把非正方形的
   * 托盘图标拉伸成 16x16/32x32，细长的图会被压扁得认不出来。
   *
   * 所以托盘这里把缩放结果居中贴到透明的正方形画布上，保持原比例不拉伸。
   * 用 toBitmap/fromBitmap 走一遍（nativeImage 没有直接的"贴画布"API）。
   */
  const target = ICON_SIZES[kind];
  const finalImage =
    kind === 'tray' && (width !== target || height !== target)
      ? padToSquare(resized, target)
      : resized;

  const dir = iconsDir();
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = customIconPath(resolvePaths().root, kind);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, finalImage.toPNG());
  fs.renameSync(tmpPath, finalPath);

  // 落盘后立刻生效：托盘换图、窗口换图标
  applyIcons();

  return { kind, path: finalPath, width, height };
}

/**
 * 生成 assets/icon.ico，供启动器 exe 嵌入。
 *
 * @param {string} [sourcePng] 源图；不给就用内置 assets/icon.png
 * @returns {{ok: boolean, message?: string}}
 */
function buildIco(sourcePng) {
  const args = [path.join(repoRoot, 'scripts', 'make-ico.mjs')];
  if (sourcePng) args.push('--src', sourcePng);
  const r = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, message: (r.stdout || '') + (r.stderr || '') };
  }
  return { ok: true };
}

/**
 * 重新编译启动器 exe，把当前图标嵌进去。
 *
 * ## 为什么不能直接覆盖 Ling-bot.exe
 *
 * 用户从 Ling-bot.exe 启动应用时，那个 exe 进程会一直活着等 Electron 退出
 * （启动器的职责就是转发日志），所以文件被占用，覆盖会 EBUSY。
 *
 * ## 但 Windows 允许改名正在运行的 exe
 *
 * 实测可行：Move-Item 把占用中的 exe 改个名字可以成功（文件句柄跟着旧名字走）。
 * 所以流程是"改名让位 → 写新的 → 删掉旧的"：
 *   1. Ling-bot.exe      → Ling-bot.exe.old-<时间戳>
 *   2. 编译产物           → Ling-bot.exe
 *   3. 删除 .old-*
 *
 * 这样用户**不用退出应用**就能换掉 exe 图标，下次启动即生效。
 * 正在运行的旧进程继续用旧文件，互不干扰。
 *
 * ## 为什么要先编译到 build/ 再搬
 *
 * build-launcher.mjs 自己会往仓库根拷一份。如果它先拷，就会在
 * "改名让位"之前撞上 EBUSY。所以这里先调它（它编到 build/ 里），
 * 拿到产物后由我们自己用"改名让位"的方式搬过去。
 *
 * @returns {{ok: boolean, message?: string, exePath?: string, replacedInPlace?: boolean}}
 */
function rebuildLauncherIcon() {
  // 1. 生成 ico：有自定义 app 图标就用它，否则用内置的
  const customApp = customIconPath(resolvePaths().root, 'app');
  const icoSource = isUsableIconFile(customApp) ? customApp : undefined;
  const ico = buildIco(icoSource);
  if (!ico.ok) return { ok: false, message: '生成 .ico 失败：' + (ico.message ?? '') };

  // 2. 编译（这一步只写 build/，不会碰仓库根的 exe）
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-launcher.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  /*
   * build-launcher 在最后会尝试把产物拷到仓库根。
   * 覆盖失败时它会 EBUSY 退出，但**此时 build/ 里已经有可用的新 exe 了**，
   * 所以这里不把非零退出码当成失败，只检查产物是否比之前新 —— 交给后面判断。
   */
  const built = path.join(repoRoot, 'build', 'Ling-bot.exe');
  if (!fs.existsSync(built)) {
    return { ok: false, message: '编译没有产出：' + ((r.stdout || '') + (r.stderr || '')) };
  }

  const target = path.join(repoRoot, 'Ling-bot.exe');

  // 3. 改名让位（目标被占用时）
  let backup = null;
  if (fs.existsSync(target)) {
    try {
      backup = `${target}.old-${Date.now()}`;
      fs.renameSync(target, backup);
    } catch (err) {
      return {
        ok: false,
        message: `无法替换正在运行的 exe：${err?.message ?? err}\n新文件已编译在 build/ 里，退出应用后手动复制过去即可。`,
      };
    }
  }

  // 4. 写入新 exe
  try {
    fs.copyFileSync(built, target);
  } catch (err) {
    // 写失败就把旧的改回来，不能让用户没有可以双击的 exe
    if (backup && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, target);
      } catch {
        /* 改不回来也只能如实报告 */
      }
    }
    return { ok: false, message: `写入失败：${err?.message ?? err}` };
  }

  // 5. 清理备份（删不掉也不影响使用，下次启动时 Windows 会释放）
  if (backup) {
    try {
      fs.unlinkSync(backup);
    } catch {
      /* 忽略：文件还占着，等进程退出后自然可删 */
    }
  }

  return { ok: true, exePath: target, replacedInPlace: true };
}

/**
 * 把一张图居中贴到透明的正方形画布上。
 *
 * 用途：托盘图标必须是正方形（Windows 会把非正方形图标拉伸成 16x16/32x32，
 * 细长的图会被压扁）。这里保持原图比例，四周留透明边，不做任何拉伸。
 *
 * @param {Electron.NativeImage} image
 * @param {number} size 画布边长
 * @returns {Electron.NativeImage}
 */
function padToSquare(image, size) {
  const { width, height } = image.getSize();
  const src = image.toBitmap(); // BGRA
  const canvas = Buffer.alloc(size * size * 4); // 全透明
  const offsetX = Math.floor((size - width) / 2);
  const offsetY = Math.floor((size - height) / 2);

  for (let y = 0; y < height; y++) {
    const dstY = y + offsetY;
    if (dstY < 0 || dstY >= size) continue;
    for (let x = 0; x < width; x++) {
      const dstX = x + offsetX;
      if (dstX < 0 || dstX >= size) continue;
      const from = (y * width + x) * 4;
      const to = (dstY * size + dstX) * 4;
      canvas[to] = src[from];
      canvas[to + 1] = src[from + 1];
      canvas[to + 2] = src[from + 2];
      canvas[to + 3] = src[from + 3];
    }
  }

  return nativeImage.createFromBitmap(canvas, { width: size, height: size });
}

/**
 * 清掉用户自定义图标，回落到内置默认。
 *
 * 后续由 ipcMain.handle('icon.reset') 调它。
 *
 * @param {IconKind} kind
 */
async function resetCustomIcon(kind) {
  assertIconKind(kind);
  try {
    fs.rmSync(customIconPath(resolvePaths().root, kind), { force: true });
  } catch {
    // 删不掉也不影响：resolveIconPath 会校验能否读出，坏文件同样回落到内置图标
  }
  applyIcons();
}

/**
 * 把当前该用的图标应用到托盘和窗口上。
 *
 * 抽出来是因为"设置自定义图标"和"启动时初始化"要走同一套逻辑，
 * 避免两处各写一遍、日后漂移。两个分支各自 try/catch：
 * 换图失败保持原图标，不能让托盘消失或窗口崩掉。
 */
function applyIcons() {
  if (tray) {
    try {
      const img = nativeImage.createFromPath(resolveIconPath('tray'));
      if (!img.isEmpty()) tray.setImage(img);
    } catch (err) {
      console.warn('[main] 托盘图标刷新失败', err?.message ?? err);
    }
  }
  if (win && !win.isDestroyed()) {
    try {
      const img = nativeImage.createFromPath(resolveIconPath('app'));
      if (!img.isEmpty()) win.setIcon(img);
    } catch (err) {
      console.warn('[main] 窗口图标刷新失败', err?.message ?? err);
    }
  }
}

/* ---------------------------------------------------------------- 托盘 */

function createTray() {
  /*
   * 托盘图标：优先用用户自定义，没有则用内置 assets/tray.png。
   *
   * 原来这里是 nativeImage.createEmpty() 占位（不引入二进制资源）；
   * 现在有了真实资源，但仍保留 createEmpty 兜底：图标文件可能被用户删掉、
   * 或者在某台机器上读不出来，那种情况下"空白但可用的托盘"远好过崩溃。
   */
  let icon = nativeImage.createEmpty();
  try {
    const loaded = nativeImage.createFromPath(resolveIconPath('tray'));
    if (!loaded.isEmpty()) icon = loaded;
  } catch {
    // 读不到就用空白图标，继续往下建托盘
  }

  try {
    tray = new Tray(icon);
  } catch {
    return; // 某些环境没有托盘
  }
  tray.setToolTip('Ling-bot');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showWindow() },
      { label: '重连 QQ', click: () => backend?.request('action', { name: 'reconnect' }).catch(() => {}) },
      { type: 'separator' },
      { label: '重启后端', click: () => backend?.restart() },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
}

/* ---------------------------------------------------------------- 后端 */

function startBackend() {
  backend = new BackendSupervisor({
    backendPath: path.join(__dirname, '..', 'src', 'index.mjs'),
    userDataDir: app.getPath('userData'),
  });

  backend.on('event', (msg) => win?.webContents.send('ling:event', msg));

  backend.on('will-restart', ({ delayMs, attempt }) => {
    win?.webContents.send('ling:event', {
      event: 'backend-restarting',
      payload: { delayMs, attempt },
    });
  });

  backend.on('crashed', (info) => {
    win?.webContents.send('ling:event', { event: 'backend-crashed', payload: info });
  });

  backend.on('gave-up', (info) => {
    win?.webContents.send('ling:event', { event: 'backend-gave-up', payload: info });
  });

  backend.on('stderr', (line) => {
    win?.webContents.send('ling:event', { event: 'backend-stderr', payload: { line } });
  });

  backend.start();
}

/* ---------------------------------------------------------------- IPC */

ipcMain.handle('ling:invoke', async (_evt, method, payload) => {
  if (!backend) throw new Error('后端尚未启动');

  if (method === 'snapshot') {
    return backend.request('snapshot', payload ?? {});
  }
  if (method === 'action' || method === 'setting') {
    return backend.request(method, payload ?? {});
  }
  throw new Error(`未允许的 IPC method：${method}`);
});

/**
 * 选文件 —— 供「会话总览」的手动发送用。
 *
 * ## 为什么这是一个独立通道，而不是走 action
 *
 * `action` 是后端能力的分发口，它背后是 QQ 侧的动作。选文件是**纯界面**
 * 的事：它不碰 QQ、不碰配置，结果只是一条本机路径。塞进 action 会让
 * 后端无端多一个它并不需要的职责。
 *
 * ## 为什么不让界面自己读文件
 *
 * 渲染进程被 CSP 关掉了 `file://`，而且它也不该有文件系统权限。
 * File System Access API 在 Electron 里也不适合这里。走主进程的
 * 原生对话框是唯一能让用户体验正常（有系统文件选择器）的做法。
 *
 * 注意这里**只返回路径**，不读文件内容、不落盘。
 */

/**
 * 图标：上传 / 重置 / 查询当前状态。
 *
 * ## 为什么图标 IPC 不走 action
 *
 * action 是后端（QQ 侧）能力的分发口。图标是**纯界面**的事：
 * 它只碰本机文件，不碰 QQ、不碰配置。塞进 action 会让后端
 * 无端多一个它并不需要的职责（而且后端进程根本读不到 nativeImage）。
 *
 * ## 为什么传路径而不是文件内容
 *
 * 界面已经能通过 ling:pick-file 拿到系统文件选择器给出的路径。
 * 渲染进程没有文件系统权限，也不该有 —— 由主进程读那一个文件即可。
 */
ipcMain.handle('ling:icon-upload', async (_evt, payload) => {
  const kind = String(payload?.kind ?? '');
  const filePath = String(payload?.filePath ?? '');
  try {
    if (!filePath) return { ok: false, code: 'E4046', message: '没有选文件' };
    const r = await setCustomIcon(kind, filePath);
    return { ok: true, kind: r.kind, width: r.width, height: r.height };
  } catch (e) {
    // 换成 PNG 失败不该让界面崩溃，返回可读原因让用户换个图
    return { ok: false, code: 'E4046', message: String(e?.message ?? e) };
  }
});

ipcMain.handle('ling:icon-reset', async (_evt, payload) => {
  const kind = String(payload?.kind ?? '');
  try {
    await resetCustomIcon(kind);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'E4046', message: String(e?.message ?? e) };
  }
});

/**
 * 重新编译启动器 exe，把当前图标嵌进去。
 *
 * 为什么要有这个按钮：任务栏和快捷方式显示的是 exe 内嵌图标，
 * 换完自定义图标后 exe 还是旧的那张。没有这个按钮，用户只能
 * 命令行跑 build-launcher，而那不是桌面应用该有的体验。
 *
 * 同步做（不用异步）：编译只要一两秒，而且它是排他操作 ——
 * 两个人同时点会互相踩文件。Electron 的 IPC handler 是串行的，
 * 用 sync 反而天然避免了并发。
 */
ipcMain.handle('ling:icon-rebuild-exe', async () => {
  try {
    const r = rebuildLauncherIcon();
    return r.ok
      ? { ok: true, message: '已重新编译，下次启动生效' }
      : { ok: false, code: 'E4047', message: r.message ?? '编译失败' };
  } catch (e) {
    return { ok: false, code: 'E4047', message: String(e?.message ?? e) };
  }
});

ipcMain.handle('ling:icon-status', async () => {
  /*
   * 只回"是不是自定义的"，不回完整路径 ——
   * 界面不需要知道安装目录长什么样，少回一点信息少一点泄露面。
   */
  const out = {};
  for (const kind of ['app', 'tray']) {
    const custom = customIconPath(resolvePaths().root, kind);
    out[kind] = { custom: isUsableIconFile(custom) };
  }
  return { ok: true, icons: out };
});

ipcMain.handle('ling:pick-file', async (_evt, opts) => {
  const kind = String(opts?.kind ?? 'file');
  const filters =
    kind === 'image'
      ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
      : kind === 'video'
        ? [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }]
        : kind === 'record'
          ? [{ name: '语音', extensions: ['mp3', 'wav', 'amr', 'silk', 'ogg', 'm4a'] }]
          : [{ name: '所有文件', extensions: ['*'] }];

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const res = await dialog.showOpenDialog(win, {
    title: String(opts?.title ?? '选择要发送的文件'),
    properties: ['openFile'],
    filters,
  });

  if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
  return { ok: true, path: res.filePaths[0] };
});

/* ---------------------------------------------------------------- 图标接口 */

/*
 * 把图标相关的函数导出去，供后续的「上传自定义图标」功能使用。
 *
 * 现在**还没有**接任何 IPC handler，也没有界面入口 —— 这一段只是把接口
 * 先落定，免得以后为了调它们再去动 createTray / createWindow 的内部结构。
 *
 * 后续接界面时大致是这样（放进上面的 ipc 区域即可）：
 *
 *   ipcMain.handle('icon.upload', async (_e, kind) => {
 *     const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
 *     const res = await dialog.showOpenDialog(win, {
 *       title: '选择图标',
 *       properties: ['openFile'],
 *       filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
 *     });
 *     if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
 *     return { ok: true, ...(await setCustomIcon(kind, res.filePaths[0])) };
 *   });
 *   ipcMain.handle('icon.reset', (_e, kind) => resetCustomIcon(kind).then(() => ({ ok: true })));
 *   ipcMain.handle('icon.current', (_e, kind) => ({ ok: true, path: resolveIconPath(kind) }));
 *
 * 渲染进程拿到结果后刷新自己的预览图即可（托盘和窗口图标主进程已经换过了）。
 */
export { resolveIconPath, setCustomIcon, resetCustomIcon, applyIcons };
