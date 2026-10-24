/**
 * 聊天来源的工具授权配置 —— 「管理员明确点名，才允许在群里用插件工具」
 *
 * ## 为什么需要这一层
 *
 * 改造前，插件工具的可见来源是**机械推导**的：`needs: "qq"` → 主人私聊 +
 * 主人所在群 + 桌面端。于是把 `echo` 装上去之后，任何**白名单群**里的任何人都
 * 能让机器人调用它。
 *
 * 对 `echo` 这种回显工具无所谓；但接下来的课程表、表情包、生图插件，
 * 一个"能发图片"的工具在群里被陌生人反复触发，就是刷屏；
 * 一个"会花钱"的生图工具被陌生人触发，就是替管理员烧钱。
 *
 * 所以改成两层：
 *
 *   1. **工具自身声明**（needs / risk / effects）—— 决定它**最多能去哪**；
 *   2. **管理员授权**（本文件的 chatTools）—— 决定它**实际去不去**。
 *
 * 两层都必须通过。默认第二层是空的 = 聊天来源拿不到任何插件工具。
 *
 * ## 为什么主动回合要单独一档
 *
 * 主动回合是"它自己发起说话"，没有具体的人、没有明确的请求。
 * 给主动回合开放工具，等于让它可以在没人要求的时候自己下载西、发图片、花钱。
 * 这和"群里有人问它一句，它调用一次工具"是两种性质。
 * 所以 `proactive` 是独立开关，不复用 `group`。
 *
 * ## 为什么配置里是完整工具名
 *
 * `plugin_echo` 这种完整名是**主程序与插件两边都能对上**的唯一标识
 * （插件里叫 `echo`，模型看到的是 `plugin_echo`）。用短名会让"到底授权了哪个"
 * 变成需要推理的问题 —— 而授权最不该需要推理。
 */

import { chatGrantAllows as guardChatGrantAllows } from '../guard/chat-grant.mjs';

/** 三个互相独立的授权档 */
export const CHAT_CHANNELS = Object.freeze(['group', 'private', 'proactive']);

/** 单档放行的最大工具数（防止有人把整个工具面全放开） */
const MAX_TOOLS_PER_CHANNEL = 32;

/**
 * 空授权：三档全关。
 *
 * 这必须是**默认值**。默认全开会让升级后"群里突然多了几个工具"，
 * 而用户完全不知道发生了什么。
 *
 * @returns {{group: object, private: object, proactive: object}}
 */
export function defaultChatTools() {
  return {
    group: { enabled: false, tools: [], allowPaid: false },
    private: { enabled: false, tools: [], allowPaid: false },
    proactive: { enabled: false, tools: [], allowPaid: false },
  };
}

/**
 * 归一化单档授权。
 *
 * @param {unknown} raw
 * @param {string} channel
 * @returns {{ok: true, rule: object} | {ok: false, code: string, message: string}}
 */
export function normalizeChannelRule(raw, channel) {
  const name = String(channel);
  if (raw === undefined || raw === null) {
    return { ok: true, rule: { enabled: false, tools: [], allowPaid: false } };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'E40XX', message: `chatTools.${name} 必须是对象` };
  }
  const r = /** @type {any} */ (raw);

  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
    return { ok: false, code: 'E40XX', message: `chatTools.${name}.enabled 必须是布尔值` };
  }
  if (r.allowPaid !== undefined && typeof r.allowPaid !== 'boolean') {
    return { ok: false, code: 'E40XX', message: `chatTools.${name}.allowPaid 必须是布尔值` };
  }

  /** @type {string[]} */
  const tools = [];
  if (r.tools !== undefined && r.tools !== null) {
    if (!Array.isArray(r.tools)) {
      return { ok: false, code: 'E40XX', message: `chatTools.${name}.tools 必须是字符串数组` };
    }
    if (r.tools.length > MAX_TOOLS_PER_CHANNEL) {
      return { ok: false, code: 'E40XX', message: `chatTools.${name}.tools 最多 ${MAX_TOOLS_PER_CHANNEL} 项` };
    }
    for (const item of r.tools) {
      if (typeof item !== 'string') {
        return { ok: false, code: 'E40XX', message: `chatTools.${name}.tools 里有非字符串项` };
      }
      const v = item.trim();
      if (v === '') continue;
      /*
       * 只接受 `plugin_xxx` 或 `*`。
       *
       * 拒绝裸的内置工具名（`fs_read`）很重要：这张表管的是**插件**工具。
       * 允许写内置工具名会让人误以为"在这里能改内置工具的授权"，
       * 而内置工具的来源是由各自的声明决定的 —— 写了也不生效，
       * 那种"配了没用"的开关比不给还糟。
       */
      if (v !== '*' && !/^plugin_[a-z][a-z0-9_]{1,32}$/.test(v)) {
        return {
          ok: false,
          code: 'E40XX',
          message: `chatTools.${name}.tools 里「${v}」不是合法工具名（应为 plugin_xxx 或 *）`,
        };
      }
      if (!tools.includes(v)) tools.push(v);
    }
  }

  /*
   * `*` 与具体名字同时存在时，丢掉具体名字。
   *
   * 不折叠的话，界面会显示 `plugin_echo, *` —— 用户看到会以为
   * "只放开了 echo，外加一个通配"，而实际效果是全都放开。
   * 授权表最不该有这种"看起来更严、实际更松"的歧义。
   */
  if (tools.includes('*') && tools.length > 1) {
    tools.splice(0, tools.length, '*');
  }

  return {
    ok: true,
    rule: {
      enabled: r.enabled === true,
      tools,
      allowPaid: r.allowPaid === true,
    },
  };
}

/**
 * 归一化整块 chatTools 配置。
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: object} | {ok: false, code: string, message: string}}
 */
export function normalizeChatTools(raw) {
  const base = defaultChatTools();
  if (raw === undefined || raw === null) return { ok: true, value: base };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'E40XX', message: 'chatTools 必须是对象' };
  }
  const r = /** @type {any} */ (raw);

  // 未知档位直接拒绝：`chatTool.group`（少个 s）会静默不生效，最难查
  for (const key of Object.keys(r)) {
    if (!CHAT_CHANNELS.includes(key)) {
      return { ok: false, code: 'E40XX', message: `chatTools 里有未知档位：${key}（可用：${CHAT_CHANNELS.join(' / ')}）` };
    }
  }

  /** @type {Record<string, any>} */
  const out = { ...base };
  for (const channel of CHAT_CHANNELS) {
    const one = normalizeChannelRule(r[channel], channel);
    if (!one.ok) return one;
    out[channel] = one.rule;
  }
  return { ok: true, value: out };
}

/**
 * 把一次调用落到哪一个授权档上。
 *
 * 注意 `origin === 'group'` 同时表示"普通群聊"和"陌生人私聊"（见
 * guard/origin.mjs 的 resolveOrigin：非管理员的私聊也算 group 来源，
 * 因为它在权限上不该比群友更高）。所以这里必须再用 convKey 的**形状**
 * 分出 group / private 两档，不能只看 origin。
 *
 * 这是结构性事实（会话 id 的形状），不是对话内容。
 *
 * @param {string} origin
 * @param {string} convKey
 * @returns {'group'|'private'|'proactive'|''} 空串 = 这一来源不受 chatTools 约束
 */
export function channelOf(origin, convKey) {
  if (origin === 'proactive') return 'proactive';
  if (origin === 'group') return String(convKey ?? '').startsWith('group:') ? 'group' : 'private';
  /*
   * owner-private / owner-group / console **不受** chatTools 约束：
   *
   * 这三个来源背后都是"管理员本人"。管理员在私聊里、在自己的群里、
   * 在桌面端点按钮时，需要的是一套能干活的手边工具，而不是每次都去
   * 安全页勾一遍。它们的限制仍然由 needs（host 不进群）与 risk 决定。
   */
  return '';
}

/**
 * 解析某个调用在授权上的**生效结果**。
 *
 * 返回 null 表示"这个来源不该看到插件工具"（未启用、未点名、风险过高、收费未放行）。
 *
 * @param {object} input
 * @param {any} input.chatTools 已归一化的 chatTools 配置
 * @param {string} input.origin
 * @param {string} input.convKey
 * @returns {{channel: string, rule: object} | null}
 */
export function resolveChatGrant({ chatTools, origin, convKey }) {
  const channel = channelOf(origin, convKey);
  if (!channel) return null;
  const rule = chatTools?.[channel];
  if (!rule || rule.enabled !== true) return null;
  return { channel, rule };
}

/**
 * 某个工具能不能进入这个来源。
 *
 * 只做"聊天来源"的额外判定；工具自身 origins/risk 的判定仍在 tool-gate 里，
 * 两者是**与**的关系。
 *
 * @param {object} tool 工具声明（含 name / risk / kind / effects / plugin）
 * @param {{channel: string, rule: object}} grant
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function chatGrantAllows(tool, grant) {
  // 配置层和实际 tool-gate 共用一份风险、effects 与收费例外判定。
  return guardChatGrantAllows(tool, grant);
}
