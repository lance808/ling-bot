/**
 * DSH 接入页 —— 让 QQ 能审批和指挥 DSH
 *
 * ## 这一页要解决的实际问题
 *
 * 这个功能跨了三个进程（QQ / Ling-bot / DSH），配置散在两边。
 * 如果只给一段说明让人自己去改两份配置文件，几乎不可能配对成功——
 * 而令牌一旦对不上，表现是"什么都没发生"，没有任何报错。
 *
 * 所以这一页的职责是：
 *   1. 把**必须一致**的东西（令牌）生成好，可一键复制
 *   2. 把**两边各自要填什么**分开写清楚，不混在一起
 *   3. 能当场看到"通没通"，而不是配完去猜
 *
 * ## 关于令牌
 *
 * 令牌在两处必须一致：这里的 `dsh.token`，和 DSH 插件设置里的 `bridgeToken`。
 * 它同时是**鉴权凭据**（没它端口拒绝一切请求），所以：
 *   - 只在本地生成，不联网、不上报
 *   - 界面上默认遮起来，要按"显示"才看得到全貌（防偷窥）
 */

import { el, card, kv, pill } from '../render.mjs';

/** 生成一个足够随机的令牌（32 字节 → 43 字符 base64url） */
function mintToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 跨重渲染保留的"未保存编辑"。
 *
 * ## 为什么必须在模块作用域
 *
 * 每次 `pull()` 都会重新渲染整页，`local` 随之重建、从快照重新取值。
 * 于是这样一串操作会出错：
 *
 *   1. 点「生成」—— local.token 变成新令牌（还没保存）
 *   2. 点「保存」—— 保存成功后 `pull()` 触发重渲染
 *   3. 新渲染的 local.token 从**快照里的旧值**初始化
 *   4. 框里显示旧令牌 —— 就是用户看到的那个 bug
 *
 * 把"用户刚输入、还没保存的值"提到模块作用域，重渲染时优先用它，
 * 保存成功后再清掉，让快照重新说了算。
 *
 * @type {{token?: string, admins?: string, port?: string, sessionId?: string}}
 */
const draft = {};
let notice = null;

/** 丢掉所有草稿（保存成功后调用） */
function clearDraft() {
  for (const k of Object.keys(draft)) delete draft[k];
}

/**
 * @param {any} snap
 * @param {any} ctx
 * @returns {HTMLElement}
 */
export function renderDsh(snap, ctx) {
  const dsh = snap?.config?.dsh ?? {};
  /** 快照里的形状是 {loaded, skipped}，不是数组 */
  const loadedPlugins = snap?.plugins?.loaded ?? [];
  const bridgePlugin = loadedPlugins.find?.((p) => p.name === 'dsh-bridge');

  const local = {
    // 草稿优先：用户刚改了还没保存的值不能被重渲染冲掉
    token: draft.token ?? '',
    revealed: draft.revealed === true,
    admins: draft.admins ?? (Array.isArray(dsh.admins) ? dsh.admins.join(',') : ''),
    port: draft.port ?? String(dsh.port ?? 3458),
    sessionId: draft.sessionId ?? String(dsh.sessionId ?? ''),
    enabled: dsh.enabled === true,
  };

  const msg = el('div', { class: notice?.cls ?? 'muted mono', text: notice?.text ?? '', role: 'status' });
  const say = (t, cls = 'muted mono') => {
    notice = { text: t, cls };
    msg.className = cls;
    msg.textContent = t;
  };

  /* ---------------------------------------------------------------- 令牌 */

  const tokenInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'password',
      class: 'text-input mono',
      value: local.token,
      placeholder: dsh.token ? '已设置（不回显）；留空保持原令牌' : '点「生成」得到一个随机令牌',
      autocomplete: 'off',
      spellcheck: false,
    })
  );

  tokenInput.addEventListener('input', () => {
    local.token = tokenInput.value.trim();
    // 记进草稿：重渲染时用它，否则会退回快照里的旧值
    draft.token = local.token;
  });

  const revealBtn = el('button', {
    class: 'btn btn-ghost',
    type: 'button',
    text: '显示',
    onclick: () => {
      local.revealed = !local.revealed;
      draft.revealed = local.revealed;
      tokenInput.type = local.revealed ? 'text' : 'password';
      revealBtn.textContent = local.revealed ? '隐藏' : '显示';
    },
  });

  const mintBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: '生成',
    onclick: () => {
      local.token = mintToken();
      draft.token = local.token;
      tokenInput.value = local.token;
      tokenInput.type = 'text';
      local.revealed = true;
      draft.revealed = true;
      revealBtn.textContent = '隐藏';
      say('已生成新令牌。要两边都更新：这里保存后，还要贴到 DSH 插件的 bridgeToken。', 'warn mono');
    },
  });

  const copyBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: '复制',
    onclick: async () => {
      const v = tokenInput.value.trim();
      if (!v) return say('还没有令牌', 'err mono');
      try {
        await navigator.clipboard.writeText(v);
        say('✓ 已复制，去贴到 DSH 插件的 bridgeToken', 'ok mono');
      } catch {
        // 剪贴板可能被权限挡住，退回"显示出来自己选"
        tokenInput.type = 'text';
        local.revealed = true;
        revealBtn.textContent = '隐藏';
        tokenInput.select();
        say('复制不了（浏览器权限），已选中，请手动 Ctrl+C', 'warn mono');
      }
    },
  });

  /* ---------------------------------------------------------------- 字段 */

  const portInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'number',
      class: 'text-input',
      value: local.port,
      min: '1024',
      max: '65535',
    })
  );

  const adminsInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      class: 'text-input',
      value: local.admins,
      placeholder: '例如 10001,10002',
      autocomplete: 'off',
    })
  );

  const sessionInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      class: 'text-input mono',
      value: local.sessionId,
      placeholder: '例如 session-3（留空则只能审批，不能下指令）',
      autocomplete: 'off',
    })
  );

  // 这几个字段同样要记草稿：保存失败（比如校验没过）时页面不重渲染，
  // 但一旦成功保存触发 pull()，没记草稿的输入就会退回快照旧值。
  for (const [input, key] of [
    [portInput, 'port'],
    [adminsInput, 'admins'],
    [sessionInput, 'sessionId'],
  ]) {
    input.addEventListener('input', () => {
      (/** @type {any} */ (draft))[key] = input.value;
    });
  }

  const enabledToggle = el('input', { type: 'checkbox', checked: draft.enabled ?? local.enabled });
  enabledToggle.addEventListener('change', () => { draft.enabled = enabledToggle.checked; });

  const saveBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: '保存',
    onclick: async () => {
      const token = tokenInput.value.trim();
      const admins = adminsInput.value
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const port = Number(portInput.value);
      const sessionId = sessionInput.value.trim();

      // 做了就要能起：先拦掉必然起不来的组合，别让人保存完去猜为什么没反应
      if (enabledToggle.checked) {
        if (!token && !dsh.token) return say('开了总开关就必须有令牌，否则端口起不来', 'err mono');
        if (admins.length === 0) return say('开了总开关就必须有管理员，否则审批推出去没人能答', 'err mono');
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          return say('端口要在 1024–65535 之间', 'err mono');
        }
      }
      for (const a of admins) {
        if (!/^\d{4,15}$/.test(a)) return say(`管理员「${a}」不像 QQ 号（应为 4–15 位数字）`, 'err mono');
      }

      saveBtn.disabled = true;
      const r = await ctx.onSaveSetting('dsh.config', { enabled: enabledToggle.checked, token, admins, port, sessionId });
      saveBtn.disabled = false;
      if (!r?.ok) return say(`保存失败：${r?.message ?? r?.code}`, 'err mono');
      local.enabled = enabledToggle.checked;
      // 保存成功 = 磁盘已经是这些值了，草稿完成使命。
      // 清掉之后下一次渲染才会老老实实从快照取值（否则草稿会一直压着快照）。
      clearDraft();
      say(r.message ?? r.runtime?.message ?? '✓ 接入配置已保存', r.restartRequired || r.applied === false || r.runtime?.restartRequired ? 'warn mono' : 'ok mono');
    },
  });

  /* ---------------------------------------------------------------- 连通状态 */

  const isOn = local.enabled && Boolean(dsh.token) && (dsh.admins?.length ?? 0) > 0;
  const ready = isOn && bridgePlugin?.ok === true;

  /* ---------------------------------------------------------------- 组装 */

  const sideNote = (title, lines) =>
    el('div', { class: 'dsh-note' }, [
      el('div', { class: 'dsh-note-title', text: title }),
      ...lines.map((t) => el('div', { class: 'dsh-note-line', text: t })),
    ]);

  return el('div', { class: 'cols' }, [
    el('div', {}, [
      card('当前状态', [
        el('div', { class: 'list' }, [
          kv('总开关', local.enabled ? pill('已开启', 'ok') : pill('已关闭', 'dim')),
          kv('插件', bridgePlugin ? (bridgePlugin.ok ? pill('已加载', 'ok') : pill('加载失败', 'err')) : pill('未加载', 'err')),
          kv('管理员', (dsh.admins?.length ?? 0) > 0 ? `${dsh.admins.length} 个` : pill('未设置', 'warn')),
          kv('监听端口', dsh.token ? `${dsh.port ?? 3458}（仅本机）` : pill('未配置令牌', 'warn')),
          kv('绑定会话', dsh.sessionId ? dsh.sessionId : pill('未绑定', 'dim')),
        ]),
        el('div', { class: 'spacer-10' }),
        ready
          ? el('div', { class: 'ok mono', text: '✓ 配置齐全，DSH 侧插件连上后即可用' })
          : el('div', { class: 'warn mono', text: '还没配齐，下面按步骤填' }),
      ]),

      card('怎么用', [
        el('div', { class: 'list' }, [
          kv('审批', el('span', { class: 'muted', text: 'DSH 要跑危险工具时推一条 QQ，回「同意 3」' })),
          kv('下指令', el('span', { class: 'muted', text: '私聊发「/dsh 帮我看看日志」' })),
          kv('查排队', el('span', { class: 'muted', text: '发「待审批」' })),
          kv('免打扰', el('span', { class: 'muted', text: '发「免打扰 30分钟」，期间审批自动同意' })),
        ]),
        el('div', { class: 'field-hint', text: '只认管理员私聊。群里一律不响应——不能让群友遥控你的电脑。' }),
      ]),
    ]),

    el('div', {}, [
      card('接入配置', [
        el('div', { class: 'step-title', text: '1. 总开关' }),
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: '启用' }),
          el('div', { class: 'field-control' }, [
            el('label', { class: 'check-line' }, [enabledToggle, el('span', { text: '允许 QQ 控制和审批 DSH' })]),
            el('div', { class: 'field-hint', text: '关着的时候端口都不起，插件静默待命。' }),
          ]),
        ]),

        el('div', { class: 'step-gap' }),
        el('div', { class: 'step-title', text: '2. 共享令牌（两边必须一致）' }),
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: '令牌' }),
          el('div', { class: 'field-control' }, [
            tokenInput,
            el('div', { class: 'row' }, [mintBtn, revealBtn, copyBtn]),
            el('div', {
              class: 'field-hint',
              text: '这串东西同时是密码。这里保存后，还要贴到 DSH 插件的 bridgeToken，两边一模一样才连得上。',
            }),
          ]),
        ]),

        el('div', { class: 'step-gap' }),
        el('div', { class: 'step-title', text: '3. 谁能用' }),
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: '管理员 QQ' }),
          el('div', { class: 'field-control' }, [
            adminsInput,
            el('div', { class: 'field-hint', text: '逗号分隔，可以填多个。只有这些号能审批和发指令。' }),
          ]),
        ]),

        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: '监听端口' }),
          el('div', { class: 'field-control' }, [
            portInput,
            el('div', {
              class: 'field-hint',
              text: '只绑 127.0.0.1，外部连不上。改了要重启 Ling-bot；DSH 那边会自动发现新端口，不用跟着改。',
            }),
          ]),
        ]),

        el('div', { class: 'step-gap' }),
        el('div', { class: 'step-title', text: '4. 指令投给哪个 DSH 会话' }),
        el('div', { class: 'field-row' }, [
          el('label', { class: 'field-label', text: '会话 ID' }),
          el('div', { class: 'field-control' }, [
            sessionInput,
            el('div', { class: 'field-hint', text: '留空就只能审批，不能下指令。' }),
          ]),
        ]),

        el('div', { class: 'spacer-10' }),
        saveBtn,
        el('div', { class: 'spacer-10' }),
        msg,
      ]),

      card('DSH 那边要填什么', [
        sideNote('在 DSH 的插件设置里（命名空间 dsh-qq-bridge）', [
          'bridgeUrl   →  留空即可（自动发现端口）',
          'bridgeToken →  和上面这串令牌一字不差',
          'admins      →  同样的 QQ 号',
          'relayApprovals → 打开，否则审批还在 DSH 界面里点',
        ]),
        el('div', {
          class: 'field-hint',
          text: 'onUnreachable 留空即可：QQ 不通时交还 DSH 自己的策略，不会把你的任务全部判死。端口不用填——Ling-bot 会把自己的实际端口写到一个两边都看得见的位置。',
        }),
      ]),
    ]),
  ]);
}
