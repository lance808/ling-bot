/**
 * 聊天来源的授权判定 —— 「这个来源能不能看到这个插件工具」
 *
 * ## 为什么这段住在 guard/ 而不是 plugins/
 *
 * 它回答的是**授权**问题，和 `tool-gate.mjs` 是同一类东西：
 * 输入只有结构性事实（origin、convKey 形状、工具的静态声明、管理员配置），
 * 输出是"能看见 / 看不见"。放在 guard 里有两个好处：
 *
 *   1. `tool-gate.mjs` 可以直接 import 它，不必反向依赖插件层；
 *   2. 插件层（chat-tools.mjs）只负责**配置归一化**，策略只有一份实现。
 *
 * 它仍然是纯函数：不读文件、不读网络、不看对话内容、不 import 会话模块
 * （不变量 I14 的那套纪律同样适用于这里）。
 *
 * ## 与 tool-gate 的分工
 *
 *   · tool-gate 回答「这个工具声明的来源里有没有它」——静态声明；
 *   · 本文件回答「管理员有没有把它点名给这个聊天来源」——动态授权。
 *
 * 两者是**与**的关系：声明放行但没授权 → 不出现；授权了但声明不放行 → 也不出现。
 * 任何一侧单独成立都不够，这是有意的（少一层就意味着改配置能绕过声明）。
 */

/** 三个互相独立的授权档 */
export const CHAT_CHANNELS = Object.freeze(['group', 'private', 'proactive']);

/**
 * 把一次调用落到哪一个授权档上。
 *
 * ## 为什么不能只看 origin
 *
 * `guard/origin.mjs` 里"陌生人的私聊"和"群里发言"都归为 `group` 来源——
 * 那是授权层的有意设计（两者在权限上都不该比群友高）。但**配置**上它们是
 * 两件事：管理员可能愿意在自己的群里放开表情包，却不想让陌生人私聊也能用。
 *
 * 所以这里再用 convKey 的**形状**分出两档。会话 id 的形状（`group:` 还是
 * `private:`）是结构性事实，不是对话内容，I14 的纪律没有被破坏。
 *
 * @param {string} origin
 * @param {string} [convKey]
 * @returns {'group'|'private'|'proactive'|''} 空串 = 该来源不受 chatTools 约束
 */
export function channelOf(origin, convKey) {
  if (origin === 'proactive') return 'proactive';
  if (origin === 'group') return String(convKey ?? '').startsWith('group:') ? 'group' : 'private';
  /*
   * owner-private / owner-group / console **不受** chatTools 约束。
   *
   * 这三个来源背后都是管理员本人：他在私聊里、在自己的群里、在桌面端点按钮时，
   * 需要的是一套能干活的手边工具，而不是每次都去安全页勾一遍。
   * 它们仍然受 needs（host 类不进群）与 risk 的约束 —— 这里只是不额外加配置门槛。
   */
  return '';
}

/**
 * 解析某个调用对应的授权档与规则。
 *
 * @param {object} input
 * @param {any} input.chatTools 已归一化的 chatTools（见 plugins/chat-tools.mjs）
 * @param {string} input.origin
 * @param {string} [input.convKey]
 * @returns {{channel: string, rule: object} | null} null = 未启用/未配置
 */
export function resolveChatGrant(input) {
  const channel = channelOf(input?.origin, input?.convKey);
  if (!channel) return null;
  const rule = input?.chatTools?.[channel];
  if (!rule || rule.enabled !== true) return null;
  return { channel, rule };
}

/**
 * 工具是否属于"写入/执行"类 —— 这类永远不进聊天来源。
 *
 * 判据用 effects 而不是只看 risk：作者可以把 risk 写成 R0，
 * 但声明了 `exec` / `data.write` 就说明它真的会改东西。
 *
 * ## 为什么 `data.session` **不在**这里面
 *
 * 它确实写盘，但只写**当前 caller 的那一份**（`ctx.caller` 决定了归属，
 * 工具参数里根本没有"用户/会话"这个字段）。区别是实质性的：
 *
 *   · `data.write` 是插件对自己目录的**任意**写：可以存全局配置、可以写一份
 *     跨用户的索引、可以放"下次启动就生效"的东西。它的影响**不局限于**
 *     发起这次调用的那个人，所以群里任何一个人触发都会波及管理员自己。
 *   · `data.session` 的影响面被 `ctx.caller` 圈死在"这次说话的这个会话里的这个人"。
 *     群友让机器人记一条课程表，写的是他自己的课程表；管理员那份碰不到。
 *
 * 把它也拦掉，等于规定"群里的机器人永远不能替人记住任何东西"——
 * 那课程表、提醒、签到这类插件在群聊里就全都不可用，而这个能力正是
 * `plugins.chatTools` 想让管理员**自己决定**开不开的东西。
 *
 * 注意风险上限仍然有效：`data.session` 的推导下限是 R1，正好落在
 * "聊天来源最多 R1"这条线内，所以它依然要管理员点名才可见、且不收费时免确认。
 * 换句话说，放行它的不是这一行代码，而是管理员在配置里写下的那个工具名。
 *
 * ## 为什么 `qq.account.write` **在**这里面
 *
 * 它和 `data.write` 是同一类影响面，甚至更宽：改的是**QQ 账号里的收藏表情**，
 * 跨会话可见、在 QQ 客户端里也看得见、删掉通常找不回来。
 * 群里任何一个人能触发它，等于把账号的收藏面交给陌生人。
 *
 * 这里再列一次不是多余的：`qq.account.write` 的推导下限本来就是 R2，
 * 那条 R1 上限已经能拦住它。加这一行是防止将来有人把下限调低时，
 * 这条路线**无声地**跟着放开 —— 两道判断各自独立，改一处不会同时失效。
 *
 * @param {object} tool
 * @param {boolean} [allowTaskStorage] 已通过收费插件自审窄例外时允许其任务库持久化
 * @returns {boolean}
 */
function isWriteOrExecTool(tool, allowTaskStorage = false) {
  const effects = Array.isArray(tool?.effects) ? tool.effects : [];
  return (
    effects.includes('exec') ||
    (effects.includes('data.write') && !allowTaskStorage) ||
    effects.includes('qq.account.write')
  );
}

/**
 * 工具是否收费。
 *
 * @param {object} tool
 * @returns {boolean}
 */
export function isPaidToolDeclaration(tool) {
  return Array.isArray(tool?.effects) && tool.effects.includes('paid');
}

/**
 * 某个工具能不能进入这个授权档。
 *
 * 只做"聊天来源"这一层的判定；工具自身 origins 的判定仍在 tool-gate 里，
 * 两者是**与**的关系。
 *
 * @param {object} tool 工具声明（含 name / kind / risk / effects / plugin）
 * @param {{channel: string, rule: object}} grant
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function chatGrantAllows(tool, grant) {
  const rule = grant?.rule;
  if (!rule) return { ok: false, reason: 'chat-not-granted' };

  // needs: host 的工具永远不进聊天来源（tool-gate 里还有一道，双保险）
  if (tool?.kind === 'host') return { ok: false, reason: 'host-tool-in-chat' };

  const paid = isPaidToolDeclaration(tool);
  if (paid && rule.allowPaid !== true) return { ok: false, reason: 'paid-not-allowed' };
  const allowed = Array.isArray(rule.tools) ? rule.tools : [];
  // approval: plugin 只有 manifest 已验证 trusted + in-process + paid 才会注册。
  // 只为这种 R2 工具留出例外，不能让 paid 同时绕过 R3 或非法风险档。
  const pluginPaidR2 = Boolean(tool?.plugin) && tool?.approval === 'plugin' && paid && tool?.risk === 'R2';
  // 候选收费任务的data.write还须通过下面的来源/点名检查；其余写入执行仍绝对拒绝。
  if (isWriteOrExecTool(tool, pluginPaidR2)) return { ok: false, reason: 'write-or-exec-tool' };
  if (tool?.risk !== 'R0' && tool?.risk !== 'R1') {
    if (!pluginPaidR2) return { ok: false, reason: 'risk-too-high-for-chat' };
    if (grant.channel !== 'group' && grant.channel !== 'private') {
      return { ok: false, reason: 'paid-plugin-in-proactive' };
    }
    // 收费例外必须点名完整工具名，通配符无法授权它。
    if (!/^plugin_[a-z][a-z0-9_]{1,32}$/.test(String(tool?.name)) || !allowed.includes(tool.name)) {
      return { ok: false, reason: 'tool-not-listed' };
    }
  }

  // 工具名必须在白名单里（`*` 仅覆盖普通合格工具）
  if (allowed.includes('*')) return { ok: true };
  if (!allowed.includes(String(tool?.name))) return { ok: false, reason: 'tool-not-listed' };

  return { ok: true };
}

/**
 * 某个来源下，插件工具是否需要人工确认。
 *
 * 规则刻意简单：
 *
 *   · 被授权进聊天来源的 R0/R1 工具 → **不确认**。
 *     管理员把工具名写进白名单，本身就是"我同意它在这个来源发生"这个决定。
 *     若仍然逐次确认，群里每问一句就弹一张卡，用户很快就会把整个功能关掉 ——
 *     过度确认等于没有确认。
 *   · 收费工具 → **永远确认**。授权只能说明"允许它出现在这里"，
 *     不能说明"允许它现在花这笔钱"。
 *   · 其余来源（管理员私聊/桌面端/主动回合）沿用工具自己的 confirm 声明。
 *
 * @param {object} tool
 * @param {{chatGranted: boolean, channel?: string}} input
 * @returns {boolean}
 */
export function needsConfirmInChat(tool, input) {
  if (!input?.chatGranted) return false; // 交给原有 confirm 逻辑
  if (isPaidToolDeclaration(tool)) return true;
  return false;
}
