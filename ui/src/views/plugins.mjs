/**
 * 插件设置
 *
 * 文档要求：已安装插件 ｜ 已启用插件，启用 / 禁用。
 *
 * ## 「已安装」和「已启用」是两件事
 *
 * 插件被加载进内存（installed/loaded）和它在 config.plugins.enabled 里
 * 是两条独立的线。一个插件「装了但没启用」和「启用了但加载失败」
 * 是完全不同的问题，混在一个列表里用户没法判断该修哪个。
 *
 * 所以分三栏：
 *   已加载 = 真的在跑
 *   已跳过 = 装了但被配置排除，或加载时报错
 *   已启用 = 配置里点名要启用的
 *
 * ## 为什么禁用要写进 config 而不是直接卸载
 *
 * 插件目录在用户数据目录里，卸载意味着删文件。用户想"先关掉试试"
 * 时不该被迫做破坏性操作。所以禁用 = 从 enabled 列表里移除，
 * 文件还在，随时能开回来。
 */

import { el, pill, card } from '../render.mjs';

/**
 * @param {any} snap
 * @param {any} [ctx]
 * @returns {HTMLElement}
 */
/**
 * 页面级状态，必须活在模块作用域。
 *
 * ## dangerAsk 为什么不能是局部变量
 *
 * 确认框原来用渲染函数里的局部变量控制。快照每 2 秒轮询一次、
 * 每次整页重建，那个变量连同它挂的 DOM 一起消失 ——
 * 用户看到的就是"点了开启，弹窗一闪就没了"。
 *
 * 放进模块作用域后，重绘时按它把确认框画回来，于是它能一直留着，
 * 直到用户确认或取消。
 */
const ui = {
  /** 危险权限的确认框是否展开 */
  dangerAsk: false,
};

export function renderPlugins(snap, ctx = {}) {
  if (snap?.booting) {
    return el('div', {}, [card('正在启动', [el('div', { class: 'muted', text: '稍等一秒…' })])]);
  }

  const p = snap?.plugins ?? {};
  const loaded = Array.isArray(p.loaded) ? p.loaded : [];
  const skipped = Array.isArray(p.skipped) ? p.skipped : [];
  const enabled = Array.isArray(p.enabled) ? p.enabled : [];

  const root = el('div', {});


  /**
   * 一个插件是否在跑。
   *
   * loaded 里既可能是字符串，也可能是 {name} 对象（不同版本不一致），
   * 两种都要认。
   *
   * @param {string} name
   */
  const isLoaded = (name) =>
    loaded.some((x) => (typeof x === 'string' ? x : String(x?.name ?? x?.id ?? '')) === name);

  /** @param {string} name */
  const skipReason = (name) => {
    const s = skipped.find((x) => (typeof x === 'string' ? x : String(x?.name ?? x?.id ?? '')) === name);
    if (!s || typeof s === 'string') return typeof s === 'string' ? s : '';
    return String(s?.reason ?? s?.error ?? '');
  };

  /* ------------------------------------------------------ 总览 */

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '概况' }),
      el('div', { class: 'metrics' }, [
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '已加载' }),
          el('div', { class: 'value', text: String(loaded.length) }),
          el('div', { class: 'sub' }, [el('span', { class: 'pill pill-ok', text: '正在运行' })]),
        ]),
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '已启用' }),
          el('div', { class: 'value', text: String(enabled.length) }),
          el('div', { class: 'sub' }, [el('span', { class: 'pill pill-dim', text: '配置中点名' })]),
        ]),
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '已跳过' }),
          el('div', { class: 'value', text: String(skipped.length) }),
          el('div', { class: 'sub' }, [
            el('span', {
              class: `pill ${skipped.length > 0 ? 'pill-warn' : 'pill-dim'}`,
              text: skipped.length > 0 ? '未运行，见下方原因' : '无',
            }),
          ]),
        ]),
      ]),
    ]),
  );

  /* ------------------------------------------------------ 插件列表 */

  // 把三份名单并成一张表，每行显示它到底处于什么状态
  /** @type {Set<string>} */
  const names = new Set();
  for (const x of loaded) names.add(typeof x === 'string' ? x : String(x?.name ?? x?.id ?? ''));
  for (const x of skipped) names.add(typeof x === 'string' ? x : String(x?.name ?? x?.id ?? ''));
  for (const n of enabled) names.add(String(n));
  names.delete('');

  const rows = [...names].sort().map((name) => {
    const running = isLoaded(name);
    const wanted = enabled.includes(name);
    const reason = skipReason(name);

    const status = running
      ? pill('运行中', 'ok')
      : wanted
        ? pill('启用但未加载', 'err')
        : pill('已禁用', 'dim');

    return el('div', { class: 'msg' }, [
      el('div', { class: 'row-between' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'row wrap' }, [
            el('span', { class: 'mono', text: name }),
            status,
            // 「装在内置目录」和「用户自己放的」要区分，否则用户不知道
            // 升级应用会不会覆盖掉它
            name === 'dsh-bridge' ? pill('内置', 'dim') : null,
          ]),
          reason ? el('div', { class: 'field-hint', text: reason }) : null,
        ]),
        el('div', { class: 'row' }, [
          el('button', {
            type: 'button',
            class: `btn btn-sm ${wanted ? 'btn-danger' : 'btn-primary'}`,
            text: wanted ? '禁用' : '启用',
            onclick: async (ev) => {
              const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
              btn.disabled = true;
              btn.textContent = '…';
              const r = await ctx.onToggle?.(name, !wanted);
              if (r && r.ok === false) {
                btn.disabled = false;
                btn.textContent = wanted ? '禁用' : '启用';
              }
              // 成功时不用手动恢复：pull() 会重渲染整页
            },
          }),
        ]),
      ]),
    ]);
  });

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '已安装插件 ｜ 已启用插件' }),
      rows.length === 0
        ? el('div', { class: 'empty', text: '没有发现任何插件。' })
        : el('div', { class: 'list' }, rows),
      el('div', { class: 'field-hint' }, [
        el('div', {
          text: '禁用只是从启用列表里移除，插件文件仍在用户数据目录，随时可以开回来。',
        }),
      ]),
    ]),
  );

  /* ------------------------------------------------------ 危险开关 */

  const allowDangerous = p.allowDangerous === true;

  /*
   * 确认框的开关状态必须存在模块作用域。
   *
   * 原来它是渲染函数里的局部变量（let confirmHost = null）。快照每 2 秒
   * 轮询一次、每次整页重建，那个变量连同它挂的 DOM 一起消失 ——
   * 用户看到的就是"点了开始，弹窗一闪就没了"。
   *
   * 放进模块作用域后，重绘时按它决定要不要把确认框画出来。
   */
  const dangerAskOpen = ui.dangerAsk;
  const sayConfirm = el('div', { class: 'hint' });
  const setAsk = (open) => {
    ui.dangerAsk = open;
    if (open) {
      const box = el('div', { class: 'row', id: 'danger-ask' }, [
        el('span', {
          class: 'muted',
          text: '开启后，插件可以申请写入文件、执行命令这类工具。确实要开？',
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          text: '确认开启',
          onclick: async (ev) => {
            const b = /** @type {HTMLButtonElement} */ (ev.currentTarget);
            b.disabled = true;
            b.textContent = '…';
            const r = await ctx.onDangerous?.(true);
            if (r && r.ok === false) {
              b.disabled = false;
              b.textContent = '确认开启';
              sayConfirm.textContent = `失败：${r.message ?? r.code}`;
              return;
            }
            ui.dangerAsk = false;
          },
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: '取消',
          onclick: () => {
            ui.dangerAsk = false;
            // 立即收掉，不等下次重绘
            document.getElementById('danger-ask')?.remove();
          },
        }),
      ]);
      sayConfirm.replaceChildren(box);
    } else {
      sayConfirm.replaceChildren();
    }
  };

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '插件权限' }),
      el('div', { class: 'row-between' }, [
        el('div', { class: 'grow' }, [
          el('div', { text: '允许插件申请 R2 以上风险的工具' }),
          el('div', {
            class: 'field-hint',
            text: allowDangerous
              ? '已开启。插件可以申请写入、执行类工具，每次仍会要求人工确认。'
              : '已关闭。插件申请的风险被限制在 R1（只读敏感），写入与执行类一律被拒绝。',
          }),
        ]),
        /*
         * 这里原来只有一个 pill，也就是**只读展示**：标注了"已关闭"，
         * 但没有开关，用户想开也开不了 —— 看起来像写死的状态。
         *
         * 改成按钮。开关本身风险很高（插件能申请写入/执行类工具），
         * 所以做成"两步"：先点按钮，再确认。
         */
        el('button', {
          type: 'button',
          class: `btn btn-sm ${allowDangerous ? 'btn-danger' : 'btn'}`,
          text: allowDangerous ? '关闭' : '开启…',
          onclick: async (ev) => {
            const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
            if (!allowDangerous) {
              setAsk(!ui.dangerAsk);
              return;
            }
            btn.disabled = true;
            btn.textContent = '…';
            await ctx.onDangerous?.(false);
          },
        }),
      ]),
      el('div', { class: 'spacer-8' }),
      sayConfirm,
      el('div', { class: 'hint' }, [
        el('div', {
          text: '插件不是沙箱。这里只拦「按声明越权」——插件仍与主进程同权限运行，只装你信得过的插件。',
        }),
      ]),
    ]),
  );

  // 重绘后按状态恢复确认框（它不会因为 2 秒轮询而消失）
  setAsk(ui.dangerAsk === true);

  return root;
}
