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
import { action, openUrl, spawnSnowLuma } from '../api.mjs';

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
 * @param {{onRefresh?: () => void}} [ctx]
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

  /* ---------------------------------------------------- 左列：三个状态 */

  const slState = sl.installed ? (sl.running ? 'ok' : 'warn') : 'err';
  const slText = sl.installed ? (sl.running ? '正在运行' : '已安装') : '未安装';

  const nodeState = node.ok ? 'ok' : node.installed ? 'warn' : 'err';
  const nodeText = node.ok ? '已安装' : node.installed ? '版本不符' : '未安装';

  const qqState = qq.installed ? (qq.running ? 'ok' : 'warn') : 'err';
  const qqText = qq.installed ? (qq.running ? '正在运行' : '已安装') : '未安装';

  /** 左列一行：名字 + 版本 + 状态标签 + 可选说明 */
  const leftCell = (name, version, pillText, tone, extra) =>
    el('div', { class: 'env-cell' }, [
      el('div', { class: 'env-cell-head' }, [
        el('strong', { text: name }),
        version ? el('span', { class: 'env-ver', text: version }) : null,
        pill(pillText, tone),
      ]),
      extra ?? null,
    ]);

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

  /* ---------------------------------------------------- 中列：QQ 启动（上） */

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
      qqBtn.replaceChildren(...bigLabel('启动中…', '正在拉起 QQ'));
      const r = await spawnQQ(qq.exe);
      if (r.ok) {
        say(r.message ?? '已启动 QQ', 'ok');
        setTimeout(() => ctx.onRefresh?.(), 4000);
      } else {
        say(r.message ?? '启动 QQ 失败', 'err');
      }
      qqBtn.disabled = Boolean(qq.running);
      qqBtn.replaceChildren(
        ...bigLabel(qq.running ? 'QQ 已在运行' : 'QQ 启动', qq.running ? '无需重复启动' : '拉起 QQ 客户端'),
      );
    },
  });

  /* ---------------------------------------------------- 中列：SnowLuma 启动（下） */

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
        // 它注入原生组件需要时间，等一会儿再检测；否则立刻探还是"未运行"
        setTimeout(() => ctx.onRefresh?.(), 4000);
      } else {
        say(r.message ?? '启动失败', 'err');
      }
      startBtn.disabled = Boolean(sl.running);
      startBtn.replaceChildren(
        ...bigLabel(
          sl.running ? '已在运行' : 'SnowLuma 启动',
          sl.running ? '无需重复启动' : sl.installed ? '拉起本机实例' : '需先安装',
        ),
      );
    },
  });

  /* ---------------------------------------------------- 右列：控制台（跨两行） */

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
   * 三列布局：
   *   左 = 三个状态（QQ / SnowLuma / Node）
   *   中 = 两个按钮竖排（QQ 启动 在上，SnowLuma 启动 在下）
   *   右 = 控制台，纵跨整列高度
   *
   * 为什么 QQ 放最上：它是整条链路的最外层前提 —— 没有 QQ，
   * SnowLuma 无处注入，OneBot 也连不上。按依赖顺序排比按字母排好懂。
   */
  card.append(
    el('div', { class: 'env-grid' }, [
      el('div', { class: 'env-col-left' }, [
        leftCell('QQ', '', qqText, qqState, qq.exe ? el('div', { class: 'env-path', text: qq.exe }) : null),
        leftCell('SnowLuma', sl.version ? `v${sl.version}` : '', slText, slState,
          sl.dir ? el('div', { class: 'env-path', text: sl.dir }) : null),
        leftCell('Node.js', node.version ? `v${node.version}` : '—', nodeText, nodeState,
          el('div', { class: 'env-path', text: `要求 ${node.required ?? '>=24.22.0'}` })),
      ]),
      el('div', { class: 'env-col-mid' }, [qqBtn, startBtn]),
      el('div', { class: 'env-col-right' }, [consoleBtn]),
    ]),
  );

  if (!sl.installed && sl.reason) {
    card.append(el('div', { class: 'env-path', text: `检测说明：${sl.reason}` }));
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
        onRefresh: () => refresh(true),
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
