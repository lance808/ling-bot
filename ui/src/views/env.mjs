/**
 * 环境体检卡：SnowLuma 与 Node 的安装 / 运行状态
 *
 * 位置在「链接状态」与「今日消耗」之间 —— 因为那两块都在说"现在能用什么"，
 * 而"能不能用"的前提恰恰是本机装没装、跑没跑。
 *
 * ## 为什么要分「已安装」和「正在运行」两件事
 *
 * 这两个状态的处理完全不同：
 *   - 装了没运行 → 点「启动」就行
 *   - 没装       → 得先下载，此时才显示下载按钮
 * 混成一个「不可用」会让人不知道该下载还是该启动。
 *
 * ## 为什么下载按钮给的是直链
 *
 * 用户明确要求"跳转对应版本的下载链接，而不是官网"。所以：
 *   - Node → nodejs.org/dist 里具体那条 v24 线
 *   - SnowLuma → 由后端问 GitHub 拿当前平台的真实资产直链
 * 平台默认跟着系统走，另给 Windows / macOS / Linux 三个切换按钮。
 */

import { el, pill } from '../render.mjs';
import { action, openUrl, spawnSnowLuma, spawnQQ, setting, pickFile } from '../api.mjs';

/** 平台切换按钮 */
const PLATFORMS = [
  { id: 'win32', label: 'Windows' },
  { id: 'darwin', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
];

/** 当前系统对应的默认平台 */
function defaultPlatform() {
  const p = globalThis.ling?.meta?.platform;
  if (p === 'darwin' || p === 'macos') return 'darwin';
  if (p === 'linux') return 'linux';
  return 'win32';
}

/**
 * 模块级 UI 状态。
 *
 * 页面每次重绘都会把整页清空重建，所以提示文字不能只存在闭包里 ——
 * 否则操作成功/失败的那一句在下次重绘后就消失了（这个坑 security.mjs
 * 里也踩过，注释写得很清楚）。
 */
const ui = {
  /** @type {{text: string, tone: string} | null} */
  hint: null,
};

/**
 * 环境体检卡。
 *
 * @param {any} env 后端 `env.probe` 的返回
 * @param {{onRefresh?: () => void, onProbe?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderEnvCard(env, ctx = {}) {
  const card = el('section', { class: 'card env-card' });
  const platform = env?.platform ?? defaultPlatform();
  let pickPlatform = defaultPlatform();

  /** 操作结果提示条 */
  const note = el('div', { class: 'env-note', hidden: true });
  const say = (text, tone) => {
    ui.hint = { text: String(text ?? ''), tone: tone ?? 'dim' };
    paintHint();
  };
  const paintHint = () => {
    const h = ui.hint;
    note.hidden = !h;
    if (!h) return;
    note.textContent = h.text;
    note.className = `env-note ${h.tone === 'err' ? 'err' : h.tone === 'warn' ? 'warn' : 'ok'}`;
  };

  /* ---------------------------------------------------- 头部 */

  const refreshBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '重新检测' });
  refreshBtn.addEventListener('click', () => {
    ui.hint = null;
    ctx.onRefresh?.();
  });

  card.append(
    el('div', { class: 'env-head' }, [
      el('h2', { text: '环境体检' }),
      el('div', { class: 'env-head-actions' }, [
        pill(env ? '已检测' : '未检测', env ? 'ok' : 'dim'),
        refreshBtn,
      ]),
    ]),
  );

  if (!env) {
    card.append(
      el('div', {
        class: 'field-hint',
        text: '还没检测。点「重新检测」看看本机是否装好了 SnowLuma 与 Node。',
      }),
    );
    return card;
  }

  const sl = env.snowluma ?? {};
  const node = env.node ?? {};
  const qq = env.qq ?? {};

  /* ---------------------------------------------------- 状态取值 */

  const slState = sl.installed ? (sl.running ? 'ok' : 'warn') : 'err';
  const slText = sl.installed ? '已安装' : '未安装';

  const nodeState = node.ok ? 'ok' : node.installed ? 'warn' : 'err';
  const nodeText = node.ok ? '已安装' : node.installed ? '版本不符' : '未安装';

  const qqState = qq.installed ? (qq.running ? 'ok' : 'warn') : 'err';
  const qqText = qq.installed ? (qq.running ? '运行中' : '已安装') : '未安装';

  /* ---------------------------------------------------- 大按钮工具箱 */

  /** 大按钮内部：主标题 + 一行说明 */
  const bigLabel = (main, sub) => [el('span', { text: main }), el('span', { class: 'env-big-sub', text: sub })];

  /**
   * 造一个大按钮。
   *
   * @param {{main: string, sub: string, primary?: boolean, disabled?: boolean, onClick?: () => any}} spec
   */
  const bigBtn = (spec) => {
    const btn = el('button', {
      class: `btn env-big${spec.primary ? ' btn-primary' : ''}`,
      type: 'button',
    });
    btn.replaceChildren(...bigLabel(spec.main, spec.sub));
    btn.disabled = Boolean(spec.disabled);
    if (spec.onClick) btn.addEventListener('click', spec.onClick);
    return btn;
  };

  /* ---------------------------------------------------- 第 3 列：QQ 启动（上） */

  /** 把按钮画成"运行中 / 可启动"两态之一 */
  const paintQQ = (running) => {
    qqBtn.disabled = Boolean(running) || !qq.installed;
    qqBtn.replaceChildren(
      ...bigLabel(
        running ? 'QQ 已在运行' : 'QQ 启动',
        running ? '无需重复启动' : qq.installed ? '拉起 QQ 客户端' : '未检测到 QQ',
      ),
    );
  };

  const qqBtn = bigBtn({
    main: qq.running ? 'QQ 已在运行' : 'QQ 启动',
    sub: qq.running ? '无需重复启动' : qq.installed ? '拉起 QQ 客户端' : '未检测到 QQ',
    disabled: Boolean(qq.running) || !qq.installed,
    onClick: async () => {
      if (!qq.exe) {
        say('没找到 QQ 的安装路径，无法启动', 'warn');
        return;
      }
      qqBtn.disabled = true;
      qqBtn.replaceChildren(...bigLabel('启动中…', '正在确认 QQ 是否起来'));

      const r = await spawnQQ(qq.exe);

      /*
       * 是否运行成功，以**这次启动的返回结果**为准，不能用闭包里
       * 那份旧快照 qq.running —— 它反映的是这个卡片画出来的那一刻。
       * 之前就栽在这里：启动其实成功了，界面却按旧值把按钮画回
       * "可启动"，看起来像失败。
       */
      const nowRunning = r.ok ? r.running > 0 || r.ok : Boolean(qq.running);
      paintQQ(nowRunning);
      say(r.ok ? (r.message ?? '已启动 QQ') : (r.message ?? '启动 QQ 失败'), r.ok ? 'ok' : 'err');

      // 强制绕过 30 秒缓存重新探一次，让状态点、控制台可用性一起更新
      if (r.ok) ctx.onProbe?.();
    },
  });

  /* ---------------------------------------------------- 第 3 列：SnowLuma 启动（下） */

  /** 把按钮画成"运行中 / 可启动"两态之一 */
  const paintSL = (running) => {
    startBtn.disabled = Boolean(running) || !sl.installed;
    startBtn.replaceChildren(
      ...bigLabel(
        running ? '已在运行' : 'SnowLuma 启动',
        running ? '无需重复启动' : sl.installed ? '拉起本机实例' : '需先安装',
      ),
    );
  };

  const startBtn = bigBtn({
    main: sl.running ? '已在运行' : 'SnowLuma 启动',
    sub: sl.running ? '无需重复启动' : sl.installed ? '拉起本机实例' : '需先安装',
    primary: true,
    disabled: Boolean(sl.running) || !sl.installed,
    onClick: async () => {
      if (!sl.dir) {
        say('没找到 SnowLuma 的安装目录，无法启动', 'warn');
        return;
      }
      startBtn.disabled = true;
      startBtn.replaceChildren(...bigLabel('启动中…', '正在拉起进程'));
      const r = await spawnSnowLuma(sl.dir);

      if (r.ok) {
        say(r.message ?? '已启动 SnowLuma', 'ok');
        /*
         * 注入原生组件需要时间，但按钮不能等 4 秒才变。
         * 先把按钮画成"运行中"给个即时反馈，再延迟重探确认真实状态 ——
         * 探回来若发现没起来，refresh 会把它改回去，不会骗人。
         */
        paintSL(true);
        setTimeout(() => ctx.onProbe?.(), 4000);
      } else {
        say(r.message ?? '启动失败', 'err');
        paintSL(Boolean(sl.running));
      }
    },
  });

  /* ---------------------------------------------------- 第 4 列：控制台（跨两行） */

  const consoleBtn = bigBtn({
    main: 'SnowLuma 控制台',
    sub: sl.running ? '打开 127.0.0.1:5099' : '需先运行',
    disabled: !sl.running,
    onClick: async () => {
      const r = await openUrl(sl.consoleUrl ?? 'http://127.0.0.1:5099/');
      if (!r.ok) say(r.message ?? '打不开控制台', 'err');
    },
  });

  /*
   * 四列两行的紧凑布局：
   *
   *   第 1 列（竖排）  第 2 列（状态）    第 3 列（操作）      第 4 列
   *   Q                  SnowLuma 已装/未装    QQ 启动             SnowLuma 控制台
   *   Q                  Node 已装/未装        SnowLuma 启动       （纵跨两行）
   *
   * 第 1 列的 "Q / Q" 是故意的：QQ 两个字竖着占两行，刚好把左边
   * 那一栏的垂直空间用掉，不用再单独放一行标题。
   *
   * 相比上一版，这里去掉了各条的路径副行 —— 高度是主要矛盾，
   * 路径属于排查时才需要的信息，移到「重新检测」失败时的提示里。
   */
  card.append(
    el('div', { class: 'env-grid' }, [
      el('div', { class: 'env-qq-v', title: `QQ：${qqText}` }, [
        el('span', { text: 'Q' }),
        el('span', { text: 'Q' }),
      ]),
      el('div', { class: 'env-col-status' }, [
        el('div', { class: 'env-cell' }, [
          el('div', { class: 'env-cell-head' }, [
            el('strong', { text: 'SnowLuma' }),
            sl.version ? el('span', { class: 'env-ver', text: `v${sl.version}` }) : null,
            pill(slText, slState),
          ]),
        ]),
        el('div', { class: 'env-cell' }, [
          el('div', { class: 'env-cell-head' }, [
            el('strong', { text: 'Node.js' }),
            node.version ? el('span', { class: 'env-ver', text: `v${node.version}` }) : null,
            pill(nodeText, nodeState),
          ]),
        ]),
      ]),
      el('div', { class: 'env-col-mid' }, [qqBtn, startBtn]),
      el('div', { class: 'env-col-right' }, [consoleBtn]),
    ]),
  );

  /*
   * QQ 的状态不能只靠"竖排的 QQ"暗示，所以在标题旁补一个短标签。
   * 它比单独一行省高度，又不会让 QQ 的检测结果无处可看。
   */
  card.querySelector('.env-qq-v')?.append(
    el('span', { class: `env-qq-pill pill pill-${qqState}`, text: qqText }),
  );

  if (!sl.installed && sl.reason) {
    card.append(el('div', { class: 'env-path', text: `检测说明：${sl.reason}` }));
  }

  /* ---------------------------------------------------- QQ 路径可手动指定 */

  /*
   * 为什么需要这一行：自动识别（注册表 + 猜常见目录）在**别人电脑上**
   * 总有够不到的情况 —— 装在非系统盘的自定义目录、绿色版、
   * 同时装了新旧两版、注册表被清理过。与其把识别逻辑堆到无限长去猜，
   * 不如给一个明确入口让人自己指。
   *
   * 平时它不显眼（只是一个可编辑的路径行），识别失败时才提示得重一些。
   */
  const qqSourceText = {
    manual: '手动指定',
    registry: '注册表识别',
    candidate: '常见目录',
  }[qq.source] ?? '未识别';

  const qqPathInput = el('input', {
    class: 'env-input',
    type: 'text',
    value: qq.badPath ?? qq.exe ?? '',
    placeholder: '例如 D:\\QQ （安装目录）或 D:\\QQ\\QQ.exe',
    spellcheck: 'false',
    // 用户手动指过就直接亮出来；否则只是"当前识别到的"
    title: qq.badPath
      ? '这个路径下没找到 QQ.exe，改一下或点「重新检测」'
      : '可以填安装目录，也可以直接填 QQ.exe 的完整路径；留空表示自动识别',
  });

  const saveQQPath = async (value) => {
    const r = await setting('qqExe', value);
    if (!r.ok) {
      say(r.message ?? '保存失败', 'err');
      return false;
    }
    return true;
  };

  const qqPathRow = el('div', { class: 'env-pathbar' }, [
    el('span', { class: 'env-pathbar-label', text: 'QQ 路径' }),
    qqPathInput,
    (() => {
      const b = el('button', { class: 'btn btn-sm', type: 'button', text: '选目录' });
      b.addEventListener('click', async () => {
        const picked = await pickFile('dir');
        if (picked.canceled || !picked.path) return;
        qqPathInput.value = picked.path;
        if (await saveQQPath(picked.path)) {
          say(`已记住 QQ 目录：${picked.path}`, 'ok');
          ctx.onProbe?.();
        }
      });
      return b;
    })(),
    (() => {
      const b = el('button', { class: 'btn btn-sm', type: 'button', text: '选 QQ.exe' });
      b.addEventListener('click', async () => {
        const picked = await pickFile('exe');
        if (picked.canceled || !picked.path) return;
        qqPathInput.value = picked.path;
        if (await saveQQPath(picked.path)) {
          say(`已记住 QQ 路径：${picked.path}`, 'ok');
          ctx.onProbe?.();
        }
      });
      return b;
    })(),
    el('span', { class: 'env-pathbar-src', text: qqSourceText }),
  ]);

  // 回车即保存，输入框旁边不需要再多一个按钮
  qqPathInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (await saveQQPath(qqPathInput.value)) {
      say('已保存 QQ 路径', 'ok');
      ctx.onProbe?.();
    }
  });

  card.append(qqPathRow);

  /*
   * 识别失败时把话说明白：用户最需要知道的是"去哪儿找"。
   * 只在他看得见的地方多写一句，正常时不占地方。
   */
  if (!qq.installed) {
    card.append(
      el('div', {
        class: 'env-note warn',
        text: qq.badPath
          ? `你填的路径下没找到 QQ.exe：${qq.badPath}。改一下，或点「选目录」重新指定。`
          : '没自动识别到 QQ。点「选目录」选 QQ 的安装文件夹（里面有 QQ.exe），或直接选 QQ.exe。',
      }),
    );
  }

  /* ---------------------------------------------------- 缺失时的下载区 */

  const missing = !sl.installed || !node.ok;
  const downloadBox = el('div', { class: 'env-downloads' });

  /** 渲染下载按钮（随平台切换重画） */
  function paintDownloads() {
    downloadBox.replaceChildren();
    const urls = env.downloads ?? {};

    if (!sl.installed) {
      const isNative = pickPlatform === env.platform;
      const label =
        isNative && urls.snowlumaVersion
          ? `下载 SnowLuma ${urls.snowlumaVersion}${pickPlatform === 'win32' ? '（Windows 64 位）' : ''}`
          : '下载 SnowLuma';
      const btn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: label });
      btn.addEventListener('click', async () => {
        /*
         * 后端解析出的直链只对应"后端此刻所在的平台"（资产名里带 win/linux/macos）。
         * 用户切到别的平台时，拿不到那台机器的真实资产名 —— 此时退回 releases 页，
         * 比硬拼一个大概率 404 的地址要好。
         */
        const url = isNative ? urls.snowluma : 'https://github.com/SnowLuma/SnowLuma/releases/latest';
        const r = await openUrl(url);
        if (!r.ok) say(r.message ?? '打开下载页失败', 'err');
      });
      downloadBox.append(btn);
    }

    if (!node.ok) {
      const btn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '下载 Node.js 24' });
      btn.addEventListener('click', async () => {
        // 直达该平台的目录，不是 nodejs.org 首页
        const base = 'https://nodejs.org/dist/latest-v24.x/';
        const sub = { win32: 'win-x64/', darwin: 'osx-arm64/', linux: 'linux-x64/' }[pickPlatform] ?? 'win-x64/';
        const r = await openUrl(base + sub);
        if (!r.ok) say(r.message ?? '打开下载页失败', 'err');
      });
      downloadBox.append(btn);
    }
  }

  if (missing) {
    const platformChips = PLATFORMS.map((p) => {
      const btn = el('button', {
        class: `env-chip${p.id === pickPlatform ? ' active' : ''}`,
        type: 'button',
        text: p.label,
      });
      btn.addEventListener('click', () => {
        pickPlatform = p.id;
        for (const b of card.querySelectorAll('.env-platforms .env-chip')) {
          b.classList.toggle('active', b === btn);
        }
        paintDownloads();
      });
      return btn;
    });

    card.append(
      el('div', { class: 'env-install' }, [
        el('div', { class: 'env-install-head' }, [
          el('strong', { text: '需要安装' }),
          el('span', { class: 'field-hint', text: '装完再点一次「重新检测」' }),
        ]),
        el('div', { class: 'env-platforms' }, platformChips),
        downloadBox,
      ]),
    );
    paintDownloads();
  }

  /* ---------------------------------------------------- OneBot 提示 */

  const ob = sl.onebot ?? {};
  if (sl.running && (!ob.ws || !ob.http)) {
    card.append(
      el('div', {
        class: 'env-note warn',
        text: 'SnowLuma 在跑，但 OneBot 端口还没起来 —— 去控制台把 OneBot 服务打开。',
      }),
    );
  }

  paintHint();
  // 提示条永远挂在卡片最后，操作后可见
  card.append(note);

  return card;
}

/** 触发一次环境检测 */
export async function fetchEnv() {
  const r = await action('env.probe');
  return r?.env ?? null;
}

/*
 * ---------------------------------------------------------------- 缓存
 *
 * 页面每次重绘都是「清空 + 重建」，所以卡片不能自己 await 探测结果：
 * 那会让每次刷新都重新探端口、问 GitHub，画面还会闪一下。
 *
 * 这里把结果缓存在模块作用域：重绘时先用上次结果立刻画出来，
 * 需要时在后台刷新并**只替换这张卡**。
 */

/** @type {any} */
let cachedEnv = null;
/** 上次探测时间，用于避免频繁探测 */
let probedAt = 0;
/** 正在探测中，避免并发重复请求 */
let inflightProbe = null;

/** 探针比较重（要连端口、要问 GitHub），短时间内不重复跑 */
const PROBE_TTL_MS = 30_000;

/**
 * 带缓存的体检卡。
 *
 * 先立即画出已知状态（可能还"未检测"），再在后台刷新并原地替换。
 *
 * @param {{onRefreshAll?: () => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderEnvCardCached(ctx = {}) {
  const holder = el('div', { class: 'env-holder' });

  const paint = (env) => {
    holder.replaceChildren(
      renderEnvCard(env, {
        // 「重新检测」按钮：清掉缓存重探
        onRefresh: () => refresh(true),
        // 启动动作之后用：同样绕过缓存，但保留操作提示
        onProbe: () => refresh(true),
      }),
    );
  };

  const refresh = (force) => {
    const fresh = !force && cachedEnv && Date.now() - probedAt < PROBE_TTL_MS;
    if (fresh) return;
    if (inflightProbe) return;
    inflightProbe = (async () => {
      try {
        const env = await fetchEnv();
        if (env) {
          cachedEnv = env;
          probedAt = Date.now();
          paint(cachedEnv);
        }
      } catch {
        // 探测失败不该让整页变红：保留上一次结果
      } finally {
        inflightProbe = null;
      }
    })();
  };

  paint(cachedEnv);
  refresh(false);
  return holder;
}
