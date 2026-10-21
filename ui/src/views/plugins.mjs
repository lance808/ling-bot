/**
 * 插件管理 —— 通用插件骨架的界面
 *
 * ## 这个页面的立场
 *
 * 它**不认识任何具体插件**。列表、开关、配置表单、工具清单、诊断，
 * 全部由快照里的 `snap.plugins.items[]` 驱动（形状见 docs/plugin-api.md §10.1）。
 *
 * 这就是本次骨架改造要验证的事：新装一个插件、加一个配置项、改一个工具，
 * 这个文件一个字都不用改。
 *
 * ## 页面级状态必须放模块作用域
 *
 * 快照每 2 秒回来一次，`render()` 会整页重建。任何"用户正在操作"的状态
 * （选中哪个插件、表单草稿、确认框、测试结果）如果放局部变量，
 * 都会在下次轮询时连同 DOM 一起消失 —— 表现是"填了一半的字自己没了"、
 * "点了开启弹窗一闪"。仓库里为此踩过好几次，所以这里一律提到模块级。
 *
 * ## 表单草稿的键要带插件 id
 *
 * 草稿不能只按字段 key 存：两个插件都有 `token` 字段时，
 * 切换插件会看到上一个插件的令牌草稿。所以键是 `id + '.' + key`。
 */

import { el, pill, card } from '../render.mjs';

/**
 * 页面级状态（跨重绘保留）。
 */
const ui = {
  /** 当前选中的插件 id；null = 用列表第一个 */
  selected: null,
  /** 危险权限的确认框是否展开 */
  dangerAsk: false,
  /** 配置表单草稿：`<pluginId>.<configKey>` → 输入框里的字符串 */
  draft: Object.create(null),
  /** 哪些插件有未保存的改动（用于提示） */
  dirty: new Set(),
  /** 正在进行的操作：`<action>:<pluginId>`，用来禁用按钮防重复点 */
  busy: new Set(),
  /** 上一次测试连接的结果：`<pluginId>` → {ok, message, at} */
  testResult: Object.create(null),
  /** 上一次操作的提示信息（成功/失败），5 秒后由重绘自然清掉 */
  toast: null,
  toastAt: 0,
};

/** 状态 → 药丸颜色 */
const TONE = {
  ready: 'ok',
  starting: 'warn',
  'needs-config': 'warn',
  stale: 'warn',
  disabled: 'dim',
  missing: 'err',
  error: 'err',
  crashed: 'err',
  invalid: 'err',
  incompatible: 'err',
};

/**
 * @param {any} snap
 * @param {any} [ctx]
 * @returns {HTMLElement}
 */
export function renderPlugins(snap, ctx = {}) {
  lastCtx = ctx;
  if (snap?.booting) {
    return el('div', {}, [card('正在启动', [el('div', { class: 'muted', text: '稍等一秒…' })])]);
  }

  const p = snap?.plugins ?? {};
  const items = Array.isArray(p.items) ? p.items : [];
  const stats = p.stats ?? { total: items.length, ready: 0, error: 0, disabled: 0 };

  const root = el('div', {});

  /* ------------------------------------------------------ 提示条 */

  if (ui.toast && Date.now() - ui.toastAt < 6000) {
    const tone = ui.toast.ok === false ? 'err' : 'ok';
    root.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'row-between' }, [
          el('div', { class: 'grow row wrap' }, [
            pill(ui.toast.ok === false ? '失败' : '完成', tone),
            el('span', { class: 'muted', text: String(ui.toast.message ?? '') }),
          ]),
          el('button', {
            type: 'button',
            class: 'btn btn-sm',
            text: '知道了',
            onclick: () => {
              ui.toast = null;
              ctx.rerender?.();
            },
          }),
        ]),
      ]),
    );
  }

  /* ------------------------------------------------------ 概况 */

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '插件概况' }),
      el('div', { class: 'metrics' }, [
        metric('已安装', stats.total ?? items.length, 'dim', '磁盘上的插件包'),
        metric('运行中', stats.ready ?? 0, (stats.ready ?? 0) > 0 ? 'ok' : 'dim', '工具已进入 AI 工具列表'),
        metric(
          '异常',
          stats.error ?? 0,
          (stats.error ?? 0) > 0 ? 'err' : 'dim',
          (stats.error ?? 0) > 0 ? '见下方诊断' : '无',
        ),
        metric('未启用', stats.disabled ?? 0, 'dim', '已安装但关闭'),
      ]),
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'row wrap' }, [
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: ui.busy.has('rescan') ? '扫描中…' : '重新扫描目录',
          disabled: ui.busy.has('rescan'),
          onclick: async (ev) => {
            /*
             * 用「捕获按钮自身」而不是只依赖 ev.currentTarget：
             * 程序化点击（测试、键盘触发）不一定带事件对象，
             * 直接读 ev.currentTarget 会抛 TypeError —— 表现是"点了没反应"。
             */
            const b = /** @type {HTMLButtonElement} */ (ev?.currentTarget ?? undefined);
            if (b) b.disabled = true;
            await run('rescan', '', async () => {
              const r = await ctx.onRescan?.();
              if (r?.ok === false) return r;
              const added = Array.isArray(r?.added) ? r.added : [];
              const removed = Array.isArray(r?.removed) ? r.removed : [];
              return {
                ok: true,
                message: `扫描完成：新增 ${added.length} 个、移除 ${removed.length} 个`,
              };
            });
          },
        }),
        p.dirs?.plugins
          ? el('span', { class: 'field-hint', text: `插件目录：${p.dirs.plugins}` })
          : null,
      ]),
      el('div', { class: 'field-hint' }, [
        el('div', {
          text: '插件是磁盘上的独立包（plugin.json + 入口文件）。新增、更新、改配置、启停都不需要重新编译主程序，也不用手动重启程序 —— 换掉包之后点「更新」即可。',
        }),
      ]),
    ]),
  );

  /* ------------------------------------------------------ 插件列表 */

  if (items.length === 0) {
    root.append(
      el('section', { class: 'card' }, [
        el('h2', { text: '插件列表' }),
        el('div', { class: 'empty', text: '还没有安装任何插件。' }),
        el('div', { class: 'field-hint' }, [
          el('div', {
            text: '把插件包放到上面的插件目录里（每个插件一个子目录，内含 plugin.json），然后点「重新扫描目录」。',
          }),
        ]),
      ]),
    );
    return root;
  }

  // 选中的插件：找不到就退回第一个（插件可能被删了）
  const selected = items.find((x) => x.id === ui.selected) ?? items[0];
  ui.selected = selected.id;

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '插件列表' }),
      el('div', { class: 'plugin-rows' }, items.map((item) => pluginRow(item, item.id === selected.id, ctx))),
    ]),
  );

  /* ------------------------------------------------------ 详情 */

  root.append(pluginDetail(selected, ctx));

  /* ------------------------------------------------------ 危险开关 */

  root.append(dangerCard(p.allowDangerous === true, ctx));

  return root;
}

/**
 * 概况里的一个数字块。
 *
 * @param {string} label
 * @param {number} value
 * @param {string} tone
 * @param {string} sub
 */
function metric(label, value, tone, sub) {
  return el('div', { class: 'metric' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: String(value) }),
    el('div', { class: 'sub' }, [pill(sub, tone)]),
  ]);
}

/**
 * 列表里的一行。
 *
 * @param {any} item
 * @param {boolean} active
 * @param {any} ctx
 */
function pluginRow(item, active, ctx) {
  const status = String(item.status ?? 'disabled');
  const tone = TONE[status] ?? 'dim';
  const busy = ui.busy.has(`toggle:${item.id}`);

  return el('div', { class: `plugin-row ${active ? 'plugin-row-active' : ''}` }, [
    el('div', {
      class: 'plugin-row-main',
      onclick: () => {
        ui.selected = item.id;
        ctx.rerender?.();
      },
    }, [
      el('div', { class: 'row wrap' }, [
        el('span', { class: 'mono plugin-name', text: String(item.name ?? item.id) }),
        el('span', { class: 'field-hint', text: `v${String(item.version ?? '?')}` }),
        pill(String(item.statusText ?? status), tone),
        item.hasUpdate ? pill('有更新待重载', 'warn') : null,
        item.runtime === 'in-process' ? pill('同进程', 'warn') : null,
      ]),
      el('div', { class: 'field-hint plugin-desc', text: String(item.description ?? '') }),
      item.error?.message
        ? el('div', { class: 'field-hint plugin-err', text: `${item.error.code ?? ''} ${item.error.message}` })
        : null,
    ]),
    el('div', { class: 'row plugin-row-actions' }, [
      /*
       * 磁盘上的包被换掉后，这里直接给一个「更新」按钮。
       *
       * 热更新是真实可用的：`plugin.reload` 会重新读盘、重建运行时、
       * 重新登记工具，全程不重启后端（scripts/e2e-plugins.mjs 里验过）。
       * 所以不需要弹窗让用户重启程序 —— 让用户重启只是因为没把这个
       * 入口露出来。
       */
      item.hasUpdate
        ? el('button', {
            type: 'button',
            class: 'btn btn-sm btn-primary',
            text: busy ? '…' : '更新',
            disabled: busy,
            title: '重新读取磁盘上的插件包，不需要重启程序',
            onclick: async (ev) => {
              ev?.stopPropagation?.();
              const b = btnOf(ev);
              if (b) b.disabled = true;
              const r = await run(`reload:${item.id}`, item.id, async () => {
                const res = await ctx.onReload?.(item.id);
                if (res?.ok === false) return res;
                return { ok: true, message: `已更新 ${item.name ?? item.id} 到 v${String(res?.version ?? '')}` };
              });
              if (r?.ok === false && b) b.disabled = false;
            },
          })
        : null,
      el('button', {
        type: 'button',
        class: `btn btn-sm ${item.enabled ? 'btn-danger' : 'btn-primary'}`,
        text: busy ? '…' : item.enabled ? '停用' : '启用',
        disabled: busy,
        onclick: async (ev) => {
          ev?.stopPropagation?.();
          const b = btnOf(ev);
          if (b) b.disabled = true;
          const r = await run(`toggle:${item.id}`, item.id, async () => {
            const res = await ctx.onToggle?.(item.id, !item.enabled);
            if (res?.ok === false) return res;
            // 启停成功后清掉草稿以外的选择状态，避免显示过期错误
            return {
              ok: true,
              message: item.enabled
                ? `已停用 ${item.name ?? item.id}，工具已从 AI 工具列表移除`
                : `已启用 ${item.name ?? item.id}`,
            };
          });
          if (r?.ok === false && b) b.disabled = false;
        },
      }),
    ]),
  ]);
}

/**
 * 选中插件的详情：配置 / 工具 / 诊断。
 *
 * @param {any} item
 * @param {any} ctx
 */
function pluginDetail(item, ctx) {
  const sections = [
    el('h2', { text: `${String(item.name ?? item.id)} · 详情` }),
    el('div', { class: 'row wrap' }, [
      pill(String(item.statusText ?? item.status), TONE[String(item.status)] ?? 'dim'),
      el('span', { class: 'field-hint', text: `id: ${String(item.id)}` }),
      el('span', { class: 'field-hint', text: `接口 v${String(item.apiVersion ?? '?')}` }),
      el('span', { class: 'field-hint', text: `运行时: ${String(item.runtime ?? '?')}` }),
      item.author ? el('span', { class: 'field-hint', text: `作者: ${String(item.author)}` }) : null,
    ]),
  ];

  if (Array.isArray(item.permissions) && item.permissions.length > 0) {
    sections.push(
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'row wrap' }, [
        el('span', { class: 'field-hint', text: '声明能力：' }),
        ...item.permissions.filter(Boolean).map((x) => pill(String(x), 'dim')),
      ]),
    );
  }

  /*
   * 插件声明了专用页面（`ui` 块）。
   *
   * 宿主目前**不渲染**插件自定义页面（接口保留，见 docs §8）。
   * 必须把这件事显式说出来：否则用户以为功能该出现却没出现，
   * 只会当成"插件坏了"。声明可见、能力不可用，比静默消失好。
   */
  if (item.ui && typeof item.ui === 'object') {
    sections.push(
      el('div', { class: 'spacer-8' }),
      el('div', { class: 'row wrap' }, [
        pill('声明了专用页面', 'warn'),
        el('span', {
          class: 'field-hint',
          text: `该插件想提供一个自定义页面（${String(item.ui.title ?? item.ui.id ?? '未命名')}）。当前宿主还不会渲染它，插件声明的配置项和工具不受影响。`,
        }),
      ]),
    );
  }

  // 说明（插件自带的 notes）
  if (Array.isArray(item.notes) && item.notes.length > 0) {
    sections.push(el('div', { class: 'spacer-12' }));
    for (const note of item.notes) {
      sections.push(
        el('div', { class: 'plugin-note' }, [
          el('div', { class: 'plugin-note-title', text: String(note?.title ?? '') }),
          ...(Array.isArray(note?.lines) ? note.lines : []).map((line) =>
            el('div', { class: 'field-hint', text: String(line) }),
          ),
        ]),
      );
    }
  }

  sections.push(el('div', { class: 'spacer-12' }));
  sections.push(configSection(item, ctx));
  sections.push(el('div', { class: 'spacer-12' }));
  sections.push(toolsSection(item));
  sections.push(el('div', { class: 'spacer-12' }));
  sections.push(diagnosticsSection(item, ctx));

  return el('section', { class: 'card' }, sections);
}

/**
 * 配置表单 —— 完全由 item.config 声明生成。
 *
 * @param {any} item
 * @param {any} ctx
 */
function configSection(item, ctx) {
  const fields = Array.isArray(item.config) ? item.config.filter(Boolean) : [];
  const head = el('h3', { text: '配置' });

  if (fields.length === 0) {
    return el('div', {}, [
      head,
      el('div', { class: 'field-hint', text: '该插件没有声明任何配置项。' }),
    ]);
  }

  const inputs = [];
  for (const spec of fields) {
    inputs.push(configField(item, spec));
  }

  const saveBusy = ui.busy.has(`save:${item.id}`);
  const dirty = ui.dirty.has(item.id);

  const saveBtn = el('button', {
    type: 'button',
    class: 'btn btn-primary btn-sm',
    text: saveBusy ? '保存中…' : '保存配置',
    disabled: saveBusy,
    onclick: async (ev) => {
      const b = btnOf(ev);
      if (b) b.disabled = true;
      const { config, secrets } = collectForm(item);
      await run(`save:${item.id}`, item.id, async () => {
        const r = await ctx.onSaveConfig?.(item.id, config, secrets);
        if (r?.ok === false) return r;
        // 保存成功：清掉这个插件的草稿（快照里会带回新值）
        clearDraft(item.id, item);
        const extra = r?.restartRequired ? '（需重启后端彻底生效）' : '';
        return { ok: true, message: `${r?.message ?? '配置已保存'}${extra}` };
      });
      if (b) b.disabled = false;
    },
  });

  const resetBtn = el('button', {
    type: 'button',
    class: 'btn btn-sm',
    text: '放弃改动',
    disabled: !dirty,
    onclick: () => {
      clearDraft(item.id, item);
      ctx.rerender?.();
    },
  });

  return el('div', {}, [
    head,
    el('div', { class: 'form-grid' }, inputs),
    el('div', { class: 'spacer-8' }),
    el('div', { class: 'row' }, [
      saveBtn,
      resetBtn,
      dirty ? pill('有未保存的改动', 'warn') : null,
    ]),
    el('div', { class: 'field-hint' }, [
      el('div', {
        text: '保存后：已启用的插件会立即重新初始化；确实需要重启才能生效的，会明确提示。',
      }),
    ]),
  ]);
}

/**
 * 生成一个配置控件。
 *
 * @param {any} item
 * @param {any} spec
 */
function configField(item, spec) {
  const key = String(spec.key ?? '');
  const draftKey = `${item.id}.${key}`;
  const isSecret = spec.secret === true;

  // 草稿优先；没有草稿时用快照里的值（密钥恒为空，由 hasSecret 表达）
  const initial = draftKey in ui.draft ? ui.draft[draftKey] : spec.value ?? '';
  const current = initial === null || initial === undefined ? '' : String(initial);

  const markDirty = () => {
    ui.dirty.add(item.id);
  };

  /** @type {HTMLElement} */
  let control;

  if (spec.type === 'boolean') {
    const checked = current === 'true' || current === true;
    control = el('input', {
      type: 'checkbox',
      class: 'input-check',
      checked: checked ? true : null,
      onchange: (ev) => {
        ui.draft[draftKey] = /** @type {HTMLInputElement} */ (ev.currentTarget).checked ? 'true' : 'false';
        markDirty();
      },
    });
  } else if (spec.type === 'enum') {
    const options = Array.isArray(spec.options) ? spec.options : [];
    const sel = el(
      'select',
      {
        class: 'input',
        onchange: (ev) => {
          ui.draft[draftKey] = /** @type {HTMLSelectElement} */ (ev.currentTarget).value;
          markDirty();
        },
      },
      options.map((o) =>
        el('option', {
          value: String(o?.value ?? ''),
          text: String(o?.label ?? o?.value ?? ''),
          selected: String(o?.value ?? '') === current ? true : null,
        }),
      ),
    );
    // 没有命中任何选项时（旧值被删了）落到第一项，避免显示空白
    if (current === '' && options.length > 0) {
      ui.draft[draftKey] = String(options[0]?.value ?? '');
    }
    control = sel;
  } else if (spec.type === 'textarea') {
    control = el('textarea', {
      class: 'input input-area',
      rows: '4',
      placeholder: String(spec.placeholder ?? ''),
      value: current,
      oninput: (ev) => {
        ui.draft[draftKey] = /** @type {HTMLTextAreaElement} */ (ev.currentTarget).value;
        markDirty();
      },
    });
  } else {
    const type = spec.type === 'number' ? 'number' : isSecret ? 'password' : 'text';
    const input = el('input', {
      type,
      class: 'input',
      placeholder: isSecret && spec.hasSecret ? '已设置（留空保持不变）' : String(spec.placeholder ?? ''),
      value: current,
      ...(spec.type === 'number' && spec.min !== null && spec.min !== undefined
        ? { min: String(spec.min) }
        : {}),
      ...(spec.type === 'number' && spec.max !== null && spec.max !== undefined
        ? { max: String(spec.max) }
        : {}),
      ...(spec.maxLength ? { maxlength: String(spec.maxLength) } : {}),
      oninput: (ev) => {
        ui.draft[draftKey] = /** @type {HTMLInputElement} */ (ev.currentTarget).value;
        markDirty();
      },
    });
    control = input;

    // 密钥类字段给一个「生成」按钮（32 字节随机 base64url）
    if (spec.generate === 'token') {
      const gen = el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: '生成',
        onclick: () => {
          const token = mintToken();
          ui.draft[draftKey] = token;
          /*
           * 注意这里必须写 `input`，不能写 `control`：
           * control 在下面几行就被换成包住按钮的 div 了，往 div 上赋 .value
           * 什么都不会显示 —— 用户点了「生成」看到框里还是空的。
           */
          input.value = token;
          markDirty();
        },
      });
      control = el('div', { class: 'row' }, [input, gen]);
    }
  }

  const label = el('label', { class: 'form-label' }, [
    el('span', { text: String(spec.label ?? key) }),
    spec.required ? el('span', { class: 'form-required', text: ' *' }) : null,
    spec.missing ? pill('未填', 'warn') : null,
  ]);

  const hints = [];
  if (spec.help) hints.push(el('div', { class: 'field-hint', text: String(spec.help) }));
  if (isSecret && spec.hasSecret) {
    hints.push(el('div', { class: 'field-hint', text: '已保存过凭据（加密存储，不回显）。留空表示保持原值。' }));
  }
  if (spec.type === 'number' && (spec.min !== null || spec.max !== null)) {
    hints.push(
      el('div', {
        class: 'field-hint',
        text: `范围 ${spec.min ?? '−∞'} ~ ${spec.max ?? '+∞'}${spec.integer ? '，整数' : ''}`,
      }),
    );
  }

  return el('div', { class: 'form-field' }, [label, control, ...hints]);
}

/**
 * 从表单草稿里收出 { config, secrets }。
 *
 * 密钥字段只在用户真的输入了内容时才放进 secrets —— 留空表示"保持原值"，
 * 这个语义由后端实现（见 src/plugins/store.mjs）。
 *
 * @param {any} item
 */
function collectForm(item) {
  /** @type {Record<string, any>} */
  const config = {};
  /** @type {Record<string, any>} */
  const secrets = {};
  const fields = Array.isArray(item.config) ? item.config.filter(Boolean) : [];

  for (const spec of fields) {
    const key = String(spec.key ?? '');
    const draftKey = `${item.id}.${key}`;
    const has = draftKey in ui.draft;
    const raw = has ? ui.draft[draftKey] : spec.value ?? '';

    if (spec.secret === true) {
      // 留空 = 不改。绝不把空串当"清空"提交（那会把令牌抹掉）
      if (has && String(raw) !== '') secrets[key] = String(raw);
      continue;
    }
    if (spec.type === 'boolean') {
      config[key] = raw === 'true' || raw === true;
    } else {
      config[key] = raw === null || raw === undefined ? '' : String(raw);
    }
  }

  return { config, secrets };
}

/**
 * 清掉某个插件的草稿。
 *
 * @param {string} pluginId
 * @param {any} [item]
 */
function clearDraft(pluginId, item) {
  const prefix = `${pluginId}.`;
  for (const k of Object.keys(ui.draft)) {
    if (k.startsWith(prefix)) delete ui.draft[k];
  }
  ui.dirty.delete(pluginId);
  // 布尔/enum 的默认值需要回填，否则下一次渲染会读到空
  const fields = Array.isArray(item?.config) ? item.config.filter(Boolean) : [];
  for (const spec of fields) {
    if (spec.type === 'boolean' && spec.default !== undefined) {
      ui.draft[`${pluginId}.${spec.key}`] = spec.default === true ? 'true' : 'false';
    }
  }
}

/**
 * 工具清单。
 *
 * @param {any} item
 */
function toolsSection(item) {
  const tools = Array.isArray(item.tools) ? item.tools.filter(Boolean) : [];
  const head = el('h3', { text: `工具清单（${tools.length}）` });

  if (tools.length === 0) {
    return el('div', {}, [
      head,
      el('div', { class: 'field-hint', text: '该插件没有提供工具（可能是纯通道插件）。' }),
    ]);
  }

  const rows = tools.map((t) =>
    el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'mono', text: String(t.fullName ?? t.name ?? '') }),
        t.enabled === false ? pill('未生效', 'dim') : null,
      ]),
      el('td', { class: 'plugin-tool-desc', text: String(t.description ?? '') }),
      el('td', {}, [pill(String(t.needs ?? 'qq'), t.needs === 'host' ? 'warn' : 'dim')]),
      el('td', {}, [pill(String(t.risk ?? 'R0'), String(t.risk ?? 'R0') === 'R0' ? 'ok' : 'warn')]),
      el('td', { class: 'muted', text: t.confirm === 'never' ? '自动' : '需确认' }),
      el('td', { class: 'muted', text: `${Math.round(Number(t.timeoutMs ?? 0) / 1000)}s` }),
    ]),
  );

  return el('div', {}, [
    head,
    el('table', { class: 'table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '工具名' }),
          el('th', { text: '用途' }),
          el('th', { text: '范围' }),
          el('th', { text: '风险' }),
          el('th', { text: '确认' }),
          el('th', { text: '超时' }),
        ]),
      ]),
      el('tbody', {}, rows),
    ]),
    el('div', { class: 'field-hint' }, [
      el('div', {
        text: '「范围 host」= 只对主人私聊与桌面端可见；「qq」= 加上主人所在群。风险与确认由宿主按声明推导，插件改不了。',
      }),
    ]),
  ]);
}

/**
 * 诊断：状态、错误、测试连接、重载、日志。
 *
 * @param {any} item
 * @param {any} ctx
 */
function diagnosticsSection(item, ctx) {
  const test = ui.testResult[item.id];
  const testing = ui.busy.has(`test:${item.id}`);
  const reloading = ui.busy.has(`reload:${item.id}`);

  const rows = [
    kvRow('运行状态', `${String(item.statusText ?? item.status)}（${String(item.status)}）`),
    kvRow('启用状态', item.enabled ? '已启用' : '未启用'),
    kvRow('插件目录', String(item.dir ?? '—')),
    kvRow('数据目录', String(item.dataDir ?? '—')),
  ];
  if (item.error) {
    rows.push(kvRow('错误', `${String(item.error.code ?? '')} ${String(item.error.message ?? '')}`));
  }
  if (item.lastErrorAt) rows.push(kvRow('最近出错', String(item.lastErrorAt)));
  if (item.restartRequired) rows.push(kvRow('注意', '配置已保存，但需要重启后端才能彻底生效'));

  const logs = Array.isArray(item.log) ? item.log.filter(Boolean).slice(-50) : [];
  const logBox = el(
    'div',
    { class: 'plugin-log' },
    logs.length === 0
      ? [el('div', { class: 'muted', text: '（暂无日志）' })]
      : logs.map((l) =>
          el('div', { class: `plugin-log-line plugin-log-${String(l?.level ?? 'info')}` }, [
            el('span', { class: 'muted', text: localStamp(l?.at) }),
            el('span', { text: ` ${String(l?.message ?? '')}` }),
          ]),
        ),
  );

  return el('div', {}, [
    el('h3', { text: '诊断' }),
    el('div', { class: 'kv-list' }, rows),
    el('div', { class: 'spacer-8' }),
    el('div', { class: 'row wrap' }, [
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: testing ? '测试中…' : '测试连接',
        disabled: testing,
        onclick: async (ev) => {
          const b = btnOf(ev);
          if (b) b.disabled = true;
          const r = await run(`test:${item.id}`, item.id, async () => {
            const res = await ctx.onTest?.(item.id);
            ui.testResult[item.id] = {
              ok: res?.ok === true,
              message: String(res?.message ?? (res?.ok ? '连接正常' : '测试失败')),
              at: Date.now(),
            };
            return { ok: true, message: `测试完成：${ui.testResult[item.id].message}` };
          });
          if (r?.ok === false && b) b.disabled = false;
          ctx.rerender?.();
        },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-sm',
        text: reloading ? '重载中…' : '重载插件',
        disabled: reloading,
        onclick: async (ev) => {
          const b = btnOf(ev);
          if (b) b.disabled = true;
          await run(`reload:${item.id}`, item.id, async () => {
            const res = await ctx.onReload?.(item.id);
            if (res?.ok === false) return res;
            return { ok: true, message: `已重载 ${item.name ?? item.id}` };
          });
          if (b) b.disabled = false;
        },
      }),
    ]),
    test
      ? el('div', { class: 'row' }, [
          pill(test.ok ? '测试通过' : '测试失败', test.ok ? 'ok' : 'err'),
          el('span', { class: 'muted', text: test.message }),
        ])
      : null,
    el('div', { class: 'spacer-8' }),
    el('div', { class: 'field-hint', text: '最近日志（最多 50 条）' }),
    logBox,
  ]);
}

/**
 * 诊断里的一行键值。
 *
 * @param {string} k
 * @param {string} v
 */
function kvRow(k, v) {
  return el('div', { class: 'kv' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v mono', text: v }),
  ]);
}

/**
 * 插件高风险工具开关（保留旧行为，含二次确认）。
 *
 * @param {boolean} allowDangerous
 * @param {any} ctx
 */
function dangerCard(allowDangerous, ctx) {
  const sayConfirm = el('div', { class: 'hint' });

  const renderConfirm = (open) => {
    if (!open) {
      sayConfirm.replaceChildren();
      return;
    }
    sayConfirm.replaceChildren(
      el('div', { class: 'row', id: 'danger-ask' }, [
        el('span', {
          class: 'muted',
          text: '开启后，插件可以申请写入文件、执行命令这类工具。确实要开？',
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          text: '确认开启',
          onclick: async (ev) => {
            const b = btnOf(ev);
            if (b) {
              b.disabled = true;
              b.textContent = '…';
            }
            const r = await run('danger', '', async () => {
              const res = await ctx.onDangerous?.(true);
              if (res?.ok === false) return res;
              return { ok: true, message: '已允许插件申请高风险工具' };
            });
            ui.dangerAsk = false;
            if (r?.ok === false && b) {
              b.disabled = false;
              b.textContent = '确认开启';
            }
            ctx.rerender?.();
          },
        }),
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          text: '取消',
          onclick: () => {
            ui.dangerAsk = false;
            document.getElementById('danger-ask')?.remove();
          },
        }),
      ]),
    );
  };

  renderConfirm(ui.dangerAsk === true);

  return el('section', { class: 'card' }, [
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
      el('button', {
        type: 'button',
        class: `btn btn-sm ${allowDangerous ? 'btn-danger' : 'btn'}`,
        text: allowDangerous ? '关闭' : '开启…',
        onclick: async (ev) => {
          const btn = btnOf(ev);
          if (!allowDangerous) {
            ui.dangerAsk = !ui.dangerAsk;
            renderConfirm(ui.dangerAsk);
            return;
          }
          if (btn) {
            btn.disabled = true;
            btn.textContent = '…';
          }
          await run('danger', '', async () => {
            const res = await ctx.onDangerous?.(false);
            if (res?.ok === false) return res;
            return { ok: true, message: '已禁止插件申请高风险工具' };
          });
          if (btn) btn.disabled = false;
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
  ]);
}

/**
 * 把 ISO 时间串转成本地时间显示。
 *
 * 为什么不能直接 `slice(0, 19)`：后端给的是 `toISOString()`
 * （UTC，带 Z）。硬截出来的是 UTC 时间，用户在东八区看到的日志
 * 会差 8 小时 —— 排查故障时对不上现实时间，很容易误判。
 *
 * @param {any} at ISO 字符串或毫秒/秒时间戳
 * @returns {string}
 */
function localStamp(at) {
  if (!at) return '';
  const ms = typeof at === 'number' ? (at > 1e12 ? at : at * 1000) : Date.parse(String(at));
  if (!Number.isFinite(ms)) return String(at);
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 统一的"执行一个操作"包装。
 *
 * 负责三件事：标记 busy（按钮禁用）、记 toast、最后强制刷新。
 * 每个操作都手写一遍这三步，迟早有一个忘了刷新，用户看到的是
 * "点了没反应"。
 *
 * ## busy 必须在刷新**之前**清掉
 *
 * `fn` 里的 `ctx.onXxx` 成功后会在内部 `await pull()` 触发整页重绘。
 * 如果 busy 标记留到 finally 才删，那次重绘读到的还是"忙"状态，
 * 按钮就显示成「保存中…」并 disabled，要等下一次 2 秒轮询才恢复 ——
 * 用户会以为卡住了，再点一次。所以操作一结束就清标记，再刷新。
 *
 * @param {string} key busy 标记
 * @param {string} _pluginId 保留参数（便于将来按插件区分 busy）
 * @param {() => Promise<{ok?: boolean, message?: string} | any>} fn
 */
async function run(key, _pluginId, fn) {
  ui.busy.add(key);
  try {
    const r = await fn();
    if (r && r.ok === false) {
      ui.toast = { ok: false, message: String(r.message ?? r.code ?? '操作失败') };
    } else {
      ui.toast = { ok: true, message: String(r?.message ?? '完成') };
    }
    ui.toastAt = Date.now();
    return r;
  } catch (err) {
    ui.toast = { ok: false, message: String(/** @type {any} */ (err)?.message ?? err) };
    ui.toastAt = Date.now();
    return { ok: false, message: ui.toast.message };
  } finally {
    /*
     * 先清标记，再让刷新发生。
     *
     * `ctx.onXxx` 内部会 `await pull()` 触发重绘；这里的 finally 跑在
     * 那次重绘**之后**，所以光在这里删是不够的 —— 需要让调用方在
     * 操作结束、刷新开始前就清掉（见下面 rerenderAfterIdle）。
     */
    ui.busy.delete(key);
    rerenderAfterIdle();
  }
}

/**
 * 等在途的 busy 全部结束后再触发一次重绘。
 *
 * 为什么不是直接 `ctx.rerender()`：按钮的禁用/文案是渲染时算的，
 * 而 `pull()` 触发的重绘发生在 busy 还没清掉的时候，那一次画出来的
 * 就是「保存中…」。等这一次事件循环结束（此时 finally 已跑完、
 * 标记已清）再补一次重绘，界面立刻回到正常态，不用等 2 秒轮询。
 *
 * 只在还有操作在跑的时候补，空闲时不制造额外重绘。
 */
let rerenderQueued = false;
function rerenderAfterIdle() {
  if (rerenderQueued || ui.busy.size > 0) return;
  rerenderQueued = true;
  void Promise.resolve().then(() => {
    rerenderQueued = false;
    if (ui.busy.size === 0) lastCtx?.rerender?.();
  });
}

/** 最近一次渲染用的 ctx（rerenderAfterIdle 需要它） */
let lastCtx = null;

/**
 * 从点击事件里安全取到按钮元素。
 *
 * 为什么需要它：`el()` 只做 `addEventListener('click', fn)`，
 * 程序化触发（测试、键盘回车、某些浏览器行为）调过来的可能没有
 * `currentTarget`。直接 `ev.currentTarget.disabled = true` 会抛
 * TypeError，用户看到的就是"点了没反应、也没报错"。
 *
 * @param {any} ev
 * @returns {HTMLButtonElement | null}
 */
function btnOf(ev) {
  const t = ev?.currentTarget ?? ev?.target ?? null;
  return t && typeof t === 'object' && 'disabled' in t ? /** @type {any} */ (t) : null;
}

/**
 * 生成一个随机令牌（32 字节 → base64url，43 字符）。
 *
 * 与后端 `mintToken()` 同算法。放在前端是为了"点一下就填进去"，
 * 不用先去别处生成再粘贴。
 *
 * @returns {string}
 */
function mintToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 仅供测试：重置页面级状态 */
export function _resetPluginUiForTest() {
  ui.selected = null;
  ui.dangerAsk = false;
  ui.draft = Object.create(null);
  ui.dirty = new Set();
  ui.busy = new Set();
  ui.testResult = Object.create(null);
  ui.toast = null;
  ui.toastAt = 0;
}
