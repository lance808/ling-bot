/**
 * dsh-qq-bridge —— 浏览器半（设置页「Ling-bot」）
 *
 * ## 为什么单独做一个设置页
 *
 * 这个插件的配置（bridgeUrl / bridgeToken / admins）必须和 Ling-bot 那边
 * **一字不差**才连得上。如果只能去改 YAML，几乎一定会抄错：
 * 令牌是 43 个随机字符，多一个空格就失败，而失败的表现是"什么都没发生"。
 * 有个输入框能复制粘贴，是能不能用起来的分界线。
 *
 * ## 三个刻意的选择
 *
 * 1. **手写 ModuleLoader bundle，没有构建步骤。** 外壳自己提供 `react`，
 *    这个文件只 `require('react')`。改完刷新就生效，不需要打包器。
 *
 * 2. **数据走插件自己的 HTTP 路由**（`/api/qq-bridge/config`），不绑 RPC。
 *    那条路由由 host 半用 `ctx.webServer.register` 挂上，前端不依赖任何
 *    会随内核版本变化的 RPC 契约。
 *
 * 3. **不在前端保存令牌副本。** 每次读写都走服务端；清空输入框等于"不改"，
 *    要清必须显式点按钮——把"清空"和"没填"分开，否则手滑全删就把令牌弄丢了。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useState, useEffect, useCallback } = React;

    /** 只声明真正用到的 client 服务 */
    const inject = ['slots'];

    const API = '/api/qq-bridge';

    /**
     * 发一个请求，并保证**永远**给出人能看懂的错误。
     *
     * 之前直接 `await res.json()`，一旦服务端返回纯文本（比如路由没挂上时
     * 兜底处理器回的 "not found"），界面上就只有
     * `Unexpected token 'o', "not found" is not valid JSON` ——
     * 那句话既没说哪里错了，也没说该怎么办。
     *
     * 所以这里分三步：先看状态码，再看是不是 JSON，最后才是解析。
     * 任何一步失败都给出一句能照着做的中文。
     */
    async function callApi(path, init) {
      let res;
      try {
        res = await fetch(API + path, init);
      } catch (err) {
        throw new Error(`连不上 DSH 的接口（${err?.message ?? err}）`);
      }

      const raw = await res.text();

      if (res.status === 401 || res.status === 403) {
        throw new Error('没有权限（浏览器会话未通过鉴权）。刷新页面后重试。');
      }
      if (res.status === 404) {
        throw new Error('接口不存在：插件的服务端路由没挂上。重启 DSH 后再试；仍然不行就是插件版本不对。');
      }

      let data = null;
      if (raw && raw.trim()) {
        try {
          data = JSON.parse(raw);
        } catch {
          // 非 JSON：把原始内容截断后带出来，别让人只看一句 parse 错误
          const brief = raw.trim().slice(0, 80).replace(/\s+/g, ' ');
          throw new Error(`服务端返回了非 JSON 内容（HTTP ${res.status}）：${brief}`);
        }
      }

      if (!res.ok) {
        throw new Error(data?.error ? `${data.error}（HTTP ${res.status}）` : `请求失败（HTTP ${res.status}）`);
      }
      return data ?? {};
    }

    /* ------------------------------------------------------------ 主题 */

    // 全部取自外壳的主题变量，不写死任何颜色，深浅色切换后依然可读
    const T = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    /* ------------------------------------------------------------ 小组件 */

    /** 一行：左标签 + 右控件。标签宽度固定，多行输入时也不会跳。 */
    function Row({ label, hint, children }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 0' } },
        h(
          'div',
          { style: { flex: '0 0 170px', paddingTop: 8, color: T.text, fontSize: 13 } },
          label,
          hint
            ? h('div', { style: { color: T.muted, fontSize: 11, marginTop: 3, lineHeight: 1.5 } }, hint)
            : null,
        ),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          children,
        ),
      );
    }

    const inputStyle = {
      flex: '1 1 260px',
      minWidth: 0,
      padding: '6px 9px',
      fontSize: 12.5,
      fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
      color: T.text,
      background: 'transparent',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      outline: 'none',
    };

    function Button({ children, onClick, kind = 'ghost', disabled }) {
      const primary = kind === 'primary';
      const danger = kind === 'danger';
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          style: {
            padding: '6px 12px',
            fontSize: 12,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            borderRadius: 6,
            color: primary ? '#fff' : danger ? T.error : T.text,
            background: primary ? T.brand : 'transparent',
            border: `1px solid ${primary ? T.brand : danger ? T.error : T.border}`,
            whiteSpace: 'nowrap',
          },
        },
        children,
      );
    }

    function Note({ children, tone }) {
      const color = tone === 'error' ? T.error : tone === 'success' ? T.success : tone === 'warn' ? T.warn : T.muted;
      return h('div', { style: { color, fontSize: 11.5, lineHeight: 1.7, marginTop: 6, whiteSpace: 'pre-wrap' } }, children);
    }

    /* ------------------------------------------------------------ 设置页 */

    function SettingsPage() {
      const [cfg, setCfg] = useState(null);
      const [loading, setLoading] = useState(true);
      const [msg, setMsg] = useState('');
      const [tone, setTone] = useState('muted');

      // 表单态与"已保存态"分开：输入框留空表示不改，不是清空
      const [url, setUrl] = useState('');
      const [token, setToken] = useState('');
      const [admins, setAdmins] = useState('');
      const [relay, setRelay] = useState(false);
      const [policy, setPolicy] = useState('');

      const load = useCallback(async () => {
        try {
          const data = await callApi('/config', { headers: { accept: 'application/json' } });
          setCfg(data);
          setUrl(data.bridgeUrl ?? '');
          setAdmins(data.admins ?? '');
          setRelay(data.relayApprovals === true);
          setPolicy(data.onUnreachable ?? '');
          setToken('');
          setTone('muted');
          setMsg('');
        } catch (err) {
          setTone('error');
          setMsg(`读不到配置：${err?.message ?? err}`);
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      const save = useCallback(async () => {
        setMsg('保存中…');
        setTone('muted');
        try {
          const patch = {
            bridgeUrl: url.trim(),
            admins: admins.trim(),
            relayApprovals: relay === true,
            onUnreachable: policy.trim(),
          };
          // 只有真的输入了才改令牌：留空 = 保持原样
          if (token.trim()) patch.bridgeToken = token.trim();

          await callApi('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          setToken('');
          setTone('success');
          setMsg('✓ 已保存。令牌与地址改动会立即生效。');
          await load();
        } catch (err) {
          setTone('error');
          setMsg(`保存失败：${err?.message ?? err}`);
        }
      }, [url, admins, relay, policy, token, load]);

      const clearToken = useCallback(async () => {
        try {
          await callApi('/config/clear-token', { method: 'POST' });
          setTone('success');
          setMsg('已清除令牌。桥会立刻停止接受请求。');
          await load();
        } catch (err) {
          setTone('error');
          setMsg(`清除失败：${err?.message ?? err}`);
        }
      }, [load]);

      /** 一键生成随机令牌（在浏览器算，不联网） */
      const mint = useCallback(() => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const t = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        setToken(t);
        setTone('warn');
        setMsg('已生成新令牌。点保存后，把它原样复制到 Ling-bot 的「DSH 接入」页。');
      }, []);

      if (loading) {
        return h('div', { style: { padding: 24, color: T.muted, fontSize: 13 } }, '读取中…');
      }

      const hasToken = cfg?.hasToken === true;

      return h(
        'div',
        { style: { padding: '4px 2px 24px', maxWidth: 820 } },
        h('h2', { style: { fontSize: 16, margin: '8px 0 4px', color: T.text } }, 'Ling-bot'),
        h(
          'p',
          { style: { color: T.muted, fontSize: 12, margin: '0 0 18px', lineHeight: 1.7 } },
          '把 QQ 接进来：审批请求推到手机，指令从手机发过来。',
        ),

        /* ---- 状态 ---- */
        h(
          'div',
          {
            style: {
              padding: '10px 12px',
              marginBottom: 18,
              borderRadius: 8,
              border: `1px solid ${T.border}`,
              background: T.surface,
              fontSize: 12,
              color: T.text,
              lineHeight: 1.9,
            },
          },
          h('div', {}, `令牌：${hasToken ? '已配置' : '未配置'}`),
          h('div', {}, `地址：${cfg?.bridgeUrl || (cfg?.discovered ? `${cfg.effectiveUrl}（自动发现）` : '未配置')}`),
          h(
            'div',
            {},
            cfg?.discovered
              ? '端口自动发现中：Ling-bot 换了端口也不用改这里'
              : hasToken && (url || cfg?.effectiveUrl)
                ? '等待 Ling-bot 启动后连接'
                : '还不能用，下面填完保存',
          ),
        ),

        /* ---- 桥地址 ---- */
        h(
          Row,
          { label: '桥地址', hint: '留空即自动发现，一般不用填' },
          h('input', {
            style: inputStyle,
            value: url,
            placeholder: '留空自动发现；或显式填 http://127.0.0.1:端口',
            spellCheck: false,
            onChange: (e) => setUrl(e.target.value),
          }),
        ),

        /* ---- 令牌 ---- */
        h(
          Row,
          { label: '共享令牌', hint: hasToken ? '已保存。留空表示不改' : '两边必须一字不差' },
          h('input', {
            style: inputStyle,
            type: 'password',
            value: token,
            placeholder: hasToken ? '已配置，留空不改' : '点「生成」得到一串随机字符',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (e) => setToken(e.target.value),
          }),
          h(Button, { onClick: mint }, '生成'),
          hasToken ? h(Button, { onClick: clearToken, kind: 'danger' }, '清除') : null,
        ),

        /* ---- 管理员 ---- */
        h(
          Row,
          { label: '管理员 QQ', hint: '逗号分隔，可多个。只有这些号能审批和发指令' },
          h('input', {
            style: inputStyle,
            value: admins,
            placeholder: '例如 10001,10002',
            spellCheck: false,
            onChange: (e) => setAdmins(e.target.value),
          }),
        ),

        /* ---- 审批转推 ---- */
        h(
          Row,
          { label: '审批推到 QQ', hint: '关掉的话，审批仍在 DSH 界面里点' },
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: T.text, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: relay,
              onChange: (e) => setRelay(e.target.checked),
            }),
            relay ? '已开启' : '已关闭',
          ),
        ),

        /* ---- 不可达策略 ---- */
        h(
          Row,
          {
            label: 'QQ 不通时',
            hint: '留空 = 交还 DSH 自己处理（推荐）',
          },
          h(
            'select',
            {
              style: { ...inputStyle, fontFamily: 'inherit' },
              value: policy,
              onChange: (e) => setPolicy(e.target.value),
            },
            h('option', { value: '' }, '交还 DSH 默认策略（推荐）'),
            h('option', { value: 'delegate' }, '同上，显式写 delegate'),
            h('option', { value: 'deny' }, '直接拒绝（严格，断网时任务会全失败）'),
          ),
        ),

        /* ---- 保存 ---- */
        h('div', { style: { marginTop: 16, display: 'flex', gap: 8 } }, h(Button, { onClick: save, kind: 'primary' }, '保存')),
        msg ? h(Note, { tone }, msg) : null,

        /* ---- 说明 ---- */
        h(
          'div',
          {
            style: {
              marginTop: 26,
              paddingTop: 16,
              borderTop: `1px solid ${T.border}`,
              color: T.muted,
              fontSize: 11.5,
              lineHeight: 1.9,
            },
          },
          h('div', { style: { color: T.text, fontSize: 12, marginBottom: 6 } }, '怎么用'),
          h('div', {}, '· 审批：DSH 要跑危险工具时推一条到 QQ，回「同意 3」'),
          h('div', {}, '· 下指令：在 QQ 私聊发「/dsh 帮我看看日志」'),
          h('div', {}, '· 查排队：发「待审批」'),
          h('div', {}, '· 免打扰：发「免打扰 30分钟」，期间审批自动同意（最长 1 小时）'),
          h(
            'div',
            { style: { marginTop: 10 } },
            '只认管理员私聊。群里一律不响应——不能让群友遥控这台电脑。',
          ),
        ),
      );
    }

    /* ------------------------------------------------------------ 装配 */

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'ling-bot',
            order: 43,
            label: () => 'Ling-bot',
          },
          () => h(SettingsPage),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-qq-bridge';
    return module.exports;
  },
});
