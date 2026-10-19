/**
 * 图标设置页 —— F8.5
 *
 * ## 为什么单独一页
 *
 * 它既不是人物设定（跟模型行为无关），也不是安全边界（跟准入授权无关）。
 * 最早塞在「系统安全」里，但那个页面的主题是"谁能进来"，图标跟它没有关系 ——
 * 用户在自己的配置里找不到它，得去安全页翻，这是放错了地方。
 *
 * ## 为什么上传的是一个文件而不是一堆尺寸
 *
 * 用户只需要给一张图，其余交给程序：等比缩放（按长边适配，不裁切、不拉伸），
 * 窗口缩到 256、托盘缩到 32。让用户自己准备多个尺寸是把自己的麻烦转嫁给他，
 * 而且大部分人不知道托盘到底要几像素。
 *
 * ## 自定义图标的落地位置
 *
 * `<数据根目录>/icons/app.png` 与 `<数据根目录>/icons/tray.png`。
 * 放数据目录而不是程序目录：程序升级 / 换安装目录不能把用户换过的图标弄丢。
 * 文件不存在时自动回落到内置图标（见 `electron/icons.mjs` 的 `pickIconPath`）。
 *
 * ## 为什么按钮要 disabled
 *
 * 缩放 + 写盘虽然快，但连点会同时写同一个文件。写入是先写 .tmp 再 rename，
 * 理论上不会写坏，但界面上会出现"点了两下"的错觉。
 */

import { el, card } from '../render.mjs';

/**
 * 页面级状态。
 *
 * 必须活在模块作用域 —— 快照每 2 秒重绘一次，局部变量会跟着 DOM 一起消失
 * （结果就是"点了没反应"，这个坑已经踩过好几次）。
 */
const ui = {
  /** 哪些图标已经是自定义的；null 表示还没查到 */
  /** @type {{app: boolean, tray: boolean} | null} */
  status: null,
  /** @type {{tone: string, text: string} | null} */
  notice: null,
  /** 正在处理中 */
  busy: false,
  /** 正在重新编译 exe */
  building: false,
  /** 正在查状态（避免每次重绘都发一次请求） */
  probing: false,
};

/** 各尺寸要求，直接写在界面上 —— 用户想自己准备图时不用去翻源码 */
const SPECS = [
  { kind: 'app', label: '窗口图标', size: 256, hint: '任务栏和窗口左上角显示的那个。原图建议 256×256 以上。' },
  { kind: 'tray', label: '托盘图标', size: 32, hint: '缩到 32×32 也要能认出来 —— 太细的线稿会糊成一团。' },
];

/**
 * 产出图标设置的三张卡片。
 *
 * ## 为什么是"返回卡片"而不是"一个页面"
 *
 * 入口在「系统安全」页。这里只提供内容，不注册导航 ——
 * 图标是这台机器上应用的外观，和"谁能进来"同属本机设置，
 * 放一起不用多一次点击。
 *
 * @param {{rerender?: () => void}} ctx
 * @returns {HTMLElement[]}
 */
/**
 * 尺寸要求的一行：左边名称、右边规格。
 *
 * 和 kv() 分开是因为这里右边是长句（带括号说明），
 * 需要允许换行，不能像短标签那样 nowrap 对齐。
 *
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function specRow(label, value) {
  return el('div', { class: 'spec-row' }, [
    el('span', { class: 'spec-label', text: label }),
    el('span', { class: 'spec-value', text: value }),
  ]);
}

export function renderIconCards(ctx = {}) {
  const ling = /** @type {any} */ (globalThis).ling;
  const rerender = ctx.rerender ?? (() => {});

  /** 提示写入：先存状态再重绘，否则提示会被冲掉 */
  const say = (tone, text) => {
    ui.notice = { tone, text };
    rerender();
  };

  /* 首次渲染问一次当前状态；之后靠本地状态，不每 2 秒发请求 */
  if (ui.status === null && !ui.probing) {
    ui.probing = true;
    Promise.resolve(ling?.iconStatus?.())
      .then((r) => {
        if (r?.ok) {
          ui.status = {
            app: r.icons?.app?.custom === true,
            tray: r.icons?.tray?.custom === true,
          };
        } else {
          ui.status = { app: false, tray: false };
        }
      })
      .catch(() => {
        ui.status = { app: false, tray: false };
      })
      .finally(() => {
        ui.probing = false;
        rerender();
      });
  }

  const doUpload = async (kind) => {
    if (ui.busy) return;
    ui.busy = true;
    rerender();
    try {
      const picked = await ling?.pickIconFile?.();
      if (!picked?.ok) {
        // 用户主动取消不当成错误，静默返回
        if (!picked?.canceled) say('err', '没能选到文件');
        return;
      }
      const r = await ling?.uploadIcon?.({ kind, filePath: picked.path });
      if (r?.ok) {
        ui.status = { ...(ui.status ?? { tray: false, app: false }), [kind]: true };
        say('ok', `已换好（${r.width}×${r.height}），立刻生效`);
      } else {
        say('err', `换图标失败：${r?.message ?? '未知原因'}`);
      }
    } finally {
      ui.busy = false;
      rerender();
    }
  };

  const doReset = async (kind) => {
    if (ui.busy) return;
    ui.busy = true;
    rerender();
    try {
      const r = await ling?.resetIcon?.({ kind });
      if (r?.ok) {
        ui.status = { ...(ui.status ?? { tray: false, app: false }), [kind]: false };
        say('ok', '已恢复默认图标');
      } else {
        say('err', `恢复失败：${r?.message ?? '未知原因'}`);
      }
    } finally {
      ui.busy = false;
      rerender();
    }
  };

  /**
   * 重新编译启动器 exe，把当前图标嵌进去。
   *
   * 编译期间禁用按钮：这一步会写 exe 文件，连点会互相踩。
   */
  const doRebuild = async () => {
    if (ui.busy || ui.building) return;
    ui.building = true;
    ui.notice = null;
    rerender();
    try {
      const r = await ling?.rebuildExeIcon?.();
      if (r?.ok) {
        say('ok', r.message ?? '已重新编译，下次启动生效');
      } else {
        say('err', `编译失败：${r?.message ?? '未知原因'}`);
      }
    } finally {
      ui.building = false;
      rerender();
    }
  };

  const rows = SPECS.map((spec) => {
    const custom = ui.status?.[spec.kind] === true;
    return el('div', { class: 'icon-row' }, [
      el('div', { class: 'icon-row-main' }, [
        el('div', { class: 'row' }, [
          el('strong', { text: spec.label }),
          el('span', { class: `tag${custom ? ' tag-strong' : ''}`, text: custom ? '自定义' : '默认' }),
          el('span', { class: 'tag', text: `${spec.size}×${spec.size}` }),
        ]),
        el('div', { class: 'muted', text: spec.hint }),
      ]),
      el('div', { class: 'row' }, [
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: custom ? '换一张' : '上传图片',
          disabled: ui.busy,
          onclick: () => doUpload(spec.kind),
        }),
        custom
          ? el('button', {
              type: 'button',
              class: 'btn btn-sm btn-ghost',
              text: '恢复默认',
              disabled: ui.busy,
              onclick: () => doReset(spec.kind),
            })
          : null,
      ]),
    ]);
  });

  const notice = ui.notice
    ? el('div', { class: ui.notice.tone === 'ok' ? 'ok' : 'err', text: ui.notice.text })
    : el('div', { class: 'field-hint', text: '' });

  return [
    card('应用图标', [
      el('div', {
        class: 'muted',
        text:
          '给一张图就行，程序会等比缩放（按长边适配，不裁切、不拉伸）。支持 PNG / JPG / WebP / BMP。', 
      }),
      el('div', { class: 'spacer-10' }),
      ...rows,
      el('div', { class: 'spacer-10' }),
      notice,
      el('div', { class: 'spacer-10' }),

      /*
       * 重新编译 exe。
       *
       * 这一块必须存在：任务栏上"固定的那一项"和资源管理器里的快捷方式，
       * 显示的是 **exe 内嵌的图标**，不是窗口图标。换完自定义图标后
       * exe 还是旧的那张，用户会觉得"换了没用"。
       *
       * 换成"改名让位 → 写新的 → 删旧的"，所以**不用退出应用**就能替换，
       * 下次启动看到新图标。
       */
      el('div', { class: 'icon-row' }, [
        el('div', { class: 'icon-row-main' }, [
          el('div', { class: 'row' }, [el('strong', { text: '把当前图标嵌进启动器' })]),
          el('div', {
            class: 'muted',
            text: '任务栏和快捷方式读的是 exe 里的图标。改完图标点一下，下次启动生效，不用退出。',
          }),
        ]),
        el('div', { class: 'row' }, [
          el('button', {
            type: 'button',
            class: 'btn btn-sm',
            text: ui.building ? '编译中…' : '重新编译嵌入图标',
            disabled: ui.busy || ui.building,
            onclick: () => doRebuild(),
          }),
        ]),
      ]),
    ]),

    card('尺寸要求（想自己准备图时看这里）', [
      el('div', { class: 'list' }, [
        specRow('窗口图标', '256×256，正方形，PNG'),
        specRow('托盘图标', '32×32，正方形，PNG（任务栏会缩到 16px，线别太细）'),
        specRow('打包用大图', '512×512，正方形，PNG（仅打包时需要，界面里不用管）'),
      ]),
      el('div', { class: 'spacer-10' }),
      el('div', {
        class: 'field-hint',
        text: '源图不是正方形也接受：会按长边等比缩放，托盘额外补成正方形（Windows 会把非正方形托盘图标拉伸变形）。',
      }),
    ]),

    card('图标存在哪', [
      el('div', {
        class: 'muted',
        text: '自定义图标写在数据目录的 icons 文件夹里，不在程序目录 —— 程序升级或换安装位置都不会把它弄丢。',
      }),
      el('div', { class: 'spacer-10' }),
      el('div', { class: 'mono', text: 'userData/icons/app.png\nuserData/icons/tray.png' }),
      el('div', { class: 'spacer-10' }),
      el('div', {
        class: 'field-hint',
        text: '这两个文件被删掉或读不出来时，会自动回落到程序内置的图标，不会白屏也不会崩。',
      }),
    ]),
  ];
}
