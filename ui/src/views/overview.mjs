/**
 * 数据总览
 *
 * 文档要求：链接状态 / 视觉与生图启用状态 / 当前 AI 模型及提供商 /
 * 当前启用账号 / 今日 token 消耗。
 *
 * ## 三态分离，绝不合并成一个绿点
 *
 * 这是参考项目最痛的运维问题：只显示"已连接"，于是出问题时
 * 用户不知道该看上游、看接收、还是看账号。这里拆成三个独立事实：
 *
 *   - **联通**：WebSocket 通不通
 *   - **接收**：最近还有没有消息进来（连上了但收不到 = 上游假活）
 *   - **在线**：QQ 账号本身是否在线
 *
 * 三者任一异常都会显示成非绿色，但原因不同、处理方式也不同。
 *
 * ## 为什么"未配置"和"未探测"要分开
 *
 * 模型没配 key 和模型能力没测过，是两种状态：
 * 前者要用户去填，后者只是还不知道。混成一句"未启用"会让人无从下手。
 */

import { el, pill, card, kv, clock } from '../render.mjs';

/**
 * @param {any} snap
 * @param {{turnError?: {at: number, code: string|null, message: string} | null, gotoPage?: (id: string) => void}} [ctx]
 * @returns {HTMLElement}
 */
export function renderOverview(snap, ctx = {}) {
  // 后端还在启动：给出明确的等待态，而不是渲染成一堆"—"和"0"
  if (snap?.booting) {
    return el('div', {}, [
      card('正在启动', [
        el('div', { class: 'muted', text: '后端正在装配配置与扩展面，通常不到一秒。' }),
      ]),
    ]);
  }

  const h = snap?.health ?? {};
  const cfg = snap?.config ?? {};
  const brain = snap?.brain ?? {};
  const usage = snap?.usage ?? { today: {}, todayProactive: {} };
  const plugins = snap?.plugins ?? { loaded: [], skipped: [] };
  const account = snap?.account ?? {};

  const root = el('div', {});

  /* ------------------------------------------------ 一、能不能用（三态） */

  const linkedPill = h.linked ? pill('已联通', 'ok') : pill('未联通', 'dim');
  const healthPill =
    h.verdict === 'ok'
      ? pill('接收正常', 'ok')
      : h.verdict === 'degraded'
        ? pill('接收异常', 'warn')
        : pill('接收未知', 'dim');
  const onlinePill =
    h.online === true ? pill('QQ 在线', 'ok') : h.online === false ? pill('QQ 离线', 'err') : pill('在线未知', 'dim');

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '链接状态' }),
      el('div', { class: 'metrics' }, [
        el('div', { class: 'metric' }, [
          el('div', { class: 'label', text: '连接 / 接收 / 在线' }),
          el('div', { class: 'row wrap' }, [linkedPill, healthPill, onlinePill]),
          el('div', { class: 'sub', text: h.url ?? '上游地址未知' }),
        ]),
        metric(
          '当前账号',
          account.selfId ? String(account.selfId) : '未登录',
          account.selfId ? '已登录的机器人账号' : '等待 OneBot 上报',
          account.selfId ? 'ok' : 'warn',
        ),
        metric(
          'AI 模型',
          brain.configured ? String(brain.model ?? '—') : '未配置',
          brain.configured ? String(cfg.llm?.provider ?? cfg.llm?.baseUrl ?? '') : '去「模型设置」填密钥',
          brain.configured ? 'ok' : 'warn',
        ),
        visionMetric(currentCaps(cfg.llm?.modelCapabilities ?? {}, brain.model ?? cfg.llm?.model)),
      ]),
      h.lastMessageAt
        ? el('div', { class: 'field-hint', text: `最近一条消息：${clock(h.lastMessageAt)}` })
        : null,
    ]),
  );

  /* ------------------------------------------------ 二、今日消耗 */

  const today = usage.today ?? {};
  const proactive = usage.todayProactive ?? {};
  const ratio = usage.proactiveRatio ?? 0;

  root.append(
    el('section', { class: 'card' }, [
      el('h2', { text: '今日消耗' }),
      el('div', { class: 'metrics' }, [
        metric('总 token', fmt(today.totalTokens ?? 0), `${today.calls ?? 0} 次调用`, 'dim'),
        metric('输入', fmt(today.promptTokens ?? 0), 'prompt tokens', 'dim'),
        metric('输出', fmt(today.completionTokens ?? 0), 'completion tokens', 'dim'),
        metric(
          '主动发言占比',
          `${ratio}%`,
          `其中 ${fmt(proactive.totalTokens ?? 0)} token 是它自己花的`,
          ratio > 30 ? 'warn' : 'dim',
        ),
      ]),
      (today.estimatedCalls ?? 0) > 0
        ? el('div', { class: 'field-hint', text: `有 ${today.estimatedCalls} 次调用的 token 是估算值（上游没返回用量）` })
        : null,
      ratio > 30
        ? el('div', { class: 'hint' }, [
            el('div', {
              text: `主动发言占了今日消耗的 ${ratio}%。这部分是没人要求它说话时花的钱。`,
            }),
          ])
        : null,
    ]),
  );

  /* ------------------------------------------------ 三、运行信息 */

  const detail = el('section', { class: 'card' }, [
    el('h2', { text: '运行信息' }),
    kv('会话数', String(brain.conversations?.length ?? 0)),
    kv('进行中的回合', String(brain.inflight ?? 0)),
    kv('排队的回合', String(brain.queued ?? 0)),
    kv('累计消息', String(snap?.counts?.messages ?? 0)),
    kv('累计工具调用', String(snap?.counts?.toolCalls ?? 0)),
    kv('插件（已加载 / 跳过）', `${plugins.loaded?.length ?? 0} / ${plugins.skipped?.length ?? 0}`),
  ]);

  // 最近的错误：不要只藏在日志页里，总览要能一眼看到
  const lastErr = ctx.turnError ?? snap?.lastError;
  if (lastErr) {
    detail.append(
      el('div', { class: 'hint' }, [
        el('div', {
          text: `最近一次错误：${lastErr.message ?? ''}${lastErr.code ? `（${lastErr.code}）` : ''}`,
        }),
      ]),
    );
  }

  root.append(detail);

  // 没配模型时给一条明确的路
  if (!brain.configured) {
    root.append(
      el('section', { class: 'card' }, [
        el('h2', { text: '下一步' }),
        el('div', { class: 'muted', text: '模型还没配置，QQ 里发消息不会有回复。' }),
        el('div', { class: 'spacer-10' }),
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          text: '去配置模型',
          onclick: () => ctx.gotoPage?.('model'),
        }),
      ]),
    );
  }

  return root;
}

/**
 * 一张指标卡。
 *
 * @param {string} label
 * @param {string} value
 * @param {string} [sub]
 * @param {'ok'|'warn'|'err'|'dim'} [tone]
 */
function metric(label, value, sub, tone) {
  const cls = tone === 'ok' ? 'pill-ok' : tone === 'warn' ? 'pill-warn' : tone === 'err' ? 'pill-err' : 'pill-dim';
  return el('div', { class: 'metric' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value sm', text: value }),
    sub ? el('div', { class: 'sub' }, [el('span', { class: `pill ${cls}`, text: sub })]) : null,
  ]);
}

/**
 * 「视觉与生图启用状态」——两件事放一张卡，因为它们总是一起被问。
 *
 * @param {any} caps
 */
/**
 * 从能力表里取出"当前模型"那一行。
 *
 * ## 原来错在哪
 *
 * 能力表是按模型名分层的：
 *
 *   {
 *     "deepseek-v4.1-flash": { vision: true, image: false, channel: "multimodal" },
 *     "deepseek-chat":       { vision: false, image: false }
 *   }
 *
 * 但总览直接把整张表当成能力对象传进去，于是 `caps.vision` 永远是
 * undefined —— 界面永远显示「识图 ?」「当前模型未启用这两项能力」，
 * 哪怕当前模型明明测出了 vision: true。
 *
 * 这就是"数据不同步"的来源：真实结论在表里，界面没按模型名去取。
 *
 * @param {Record<string, any>} table
 * @param {string} model
 * @returns {Record<string, any>}
 */
function currentCaps(table, model) {
  const key = String(model ?? '');
  if (!key) return {};
  return table[key] ?? {};
}

function visionMetric(caps) {
  /*
   * 字段名以探测结果为准：`vision` 和 `image`。
   *
   * 这里原来读的是 imageGen —— 那是**另一个东西**（上游的图片生成接口），
   * 而探测结果写的是 image。名字差一个词，界面就永远显示"生图 ?"。
   * 写代码时容易把两者混在一起，所以这里以真实数据结构为准。
   */
  const v = capText(caps.vision, '识图');
  const g = capText(caps.image, '生图');
  const any = caps.vision === true || caps.image === true;
  return el('div', { class: 'metric' }, [
    el('div', { class: 'label', text: '视觉与生图' }),
    el('div', { class: 'row wrap' }, [v, g]),
    el('div', { class: 'sub' }, [
      el('span', {
        class: `pill ${any ? 'pill-ok' : 'pill-dim'}`,
        text: any ? '可用于图片理解 / 生成' : '当前模型未启用这两项能力',
      }),
    ]),
  ]);
}

/**
 * 能力三态 → 药丸。
 *
 * true / false / undefined 必须分开：
 * 把"没测过"说成"不支持"会让用户以为模型坏了。
 *
 * @param {boolean | null | undefined} v
 * @param {string} name
 */
function capText(v, name) {
  if (v === true) return pill(`${name} ✓`, 'ok');
  if (v === false) return pill(`${name} ✗`, 'warn');
  return pill(`${name} ?`, 'dim');
}

/** 千分位 */
function fmt(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('zh-CN');
}
