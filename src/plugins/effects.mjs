/**
 * 插件工具的行为分类（effects）—— 把「做了什么」和「声明多危险」分开
 *
 * ## 为什么光有 risk 不够
 *
 * 在引入 effects 之前，一个插件工具的风险档是**作者自己填的**。于是最自然的
 * 事情发生了：为了让它自动执行、别每次弹确认，作者就写 `risk: "R0"`。
 *
 * 但"发消息到群里"和"读一行本地文件"显然不是同一类事：
 *
 *   - 发消息有**外部影响**（群里几十个人看到了，撤不回）；
 *   - 收费的图片生成会**花钱**；
 *   - 写插件自己的缓存会**改状态**（下次启动的行为就不同了）。
 *
 * 这三件事都不该被伪装成"只读无害"。所以风险改为：
 *
 *   **生效风险 = max(作者声明的 risk, effects 推导出的下限)**
 *
 * 作者可以继续声明 R0（那是他的意图），但声明 `chat.send` 之后宿主会把它抬到
 * R1 —— 意图不能让一个会往外发东西的工具变成"无副作用"。
 *
 * ## 为什么 effects 不做成布尔旗标
 *
 * 旗标会漂移成十几个含义重叠的开关（`canSend` / `sendEnabled` / `allowChat`…）。
 * 这里用**少数几个互斥语义的词**，一个新能力只加一个词，而且每个词都能对应到
 * 一条具体的权限边界（见下面的下限表）。
 *
 * 注意：effects 与 `permissions`（清单里的展示字段）不是一回事 ——
 * 后者只是给界面看的声明，不参与任何判定；effects 参与风险推导与授权判定。
 */

/**
 * 允许出现的 effect 词。
 *
 * 加词要谨慎：每一个词都要同时给出「风险下限」和「授权上的含义」，
 * 否则它就只是一个好听的名字。
 *
 * 当前的九个词是**互不重叠**的语义，不是十来个开关的堆叠。新增一个之前先问：
 * 它能不能被现有的词准确覆盖？能就不要加 —— 两个近义词并存时，作者会随机挑一个，
 * 而授权判定只看其中一个。
 */
export const EFFECTS = Object.freeze([
  /** 读插件自己的 plugin-data/<id>/ */
  'data.read',
  /** 写插件自己的 plugin-data/<id>/ */
  'data.write',
  /**
   * 读写插件 dataDir 内、**按宿主 caller 会话/用户隔离**的业务数据。
   *
   * 和 `data.write` 的区别只有一条，但很关键：**归属由宿主给**。
   * 工具的 params 里没有任何"用户/会话"参数（`RESERVED_PARAM_NAMES` 也挡着），
   * 插件只能从 `ctx.caller` 拿到本次调用的身份，于是"我这份课程表"永远是
   * 当前这个会话里的这个人自己的 —— 拿不到别人的，也写不了别人的。
   *
   * 它**不是技术沙箱**：`process` 运行时里插件依然能 `fs.writeFile` 任意路径。
   * 这一项是「授权分类 + 作者声明」：让管理员看得见"它会写按会话隔离的业务数据"，
   * 也让宿主能把风险定在一个合理档位。真正的强制点在 `ctx.caller`
   * （见 docs/course-schedule.md §1、docs/plugin-api.md §5.2）。
   */
  'data.session',
  /** 读**当前会话**的消息与媒体 */
  'chat.read',
  /** 向**当前会话**发文本 */
  'chat.send',
  /** 向**当前会话**发媒体 */
  'chat.send.media',
  /**
   * 读 **QQ 账号**级别的东西（收藏表情列表、账号资料）。
   *
   * 和 `chat.read` 的区别：那个读的是「当前会话里别人说过的话」，
   * 而这个读的是「这个 QQ 号自己攒下来的东西」—— 它**不属于任何一个会话**，
   * 读完的结果会跨会话共享（比如表情库只有一份）。
   */
  'qq.account.read',
  /**
   * 写 **QQ 账号**级别的东西（收藏表情、改账号里的备注）。
   *
   * 这一条必须单独存在，不能拿 `data.write` 冒充：`data.write` 写的是
   * 插件自己的目录，删了能重建；而这里改的是**用户在 QQ 里真正攒下的资产**，
   * 而且它跨会话可见、在 QQ 客户端里也能看到、删掉之后通常找不回来。
   */
  'qq.account.write',
  /** 普通外部网络访问 */
  'net',
  /** 收费的外部操作（生图、付费 API 等）：会花钱 */
  'paid',
  /** 执行本机命令 */
  'exec',
]);

/**
 * effect → 风险下限。
 *
 * 三条判断理由：
 *
 *   · `data.read` 是 **R0**：它只能读插件自己的缓存目录，没有外部影响。
 *     若给 R1，一个"读自己课程表缓存"的工具每次都要人工确认，
 *     用户很快就会去把整个授权关掉 —— 过度确认等于没有确认。
 *   · `chat.send` / `chat.send.media` / `net` 是 **R1**：有外部影响，但可撤销
 *     （消息可以撤回、网络请求失败就失败了）。
 *   · `data.session` 也是 **R1**：它确实写盘，但写的是**用户自己的、按会话隔离的**
 *     业务数据（课程表、提醒事项这类），改错了可以改回来，也不会波及其他会话。
 *     定成 R2 的后果很具体：R2 进不了聊天来源（§2.6 的上限是 R1），
 *     于是"群里有人让机器人记一条课程"这件事永远做不到 —— 而那是这个 effect
 *     存在的全部意义。它和 `data.write` 的分界就在于"归属由宿主给"：
 *     `data.write` 是插件对自己目录的任意写（可以塞全局配置、跨用户索引），
 *     `data.session` 只能落在当前 caller 的那一份里。
 *   · `data.write` / `paid` / `qq.account.write` 是 **R2**：前者改变了下次运行的状态，
 *     中者直接动钱，后者改的是 QQ 账号里的资产 —— 三者都不能自动发生。
 *   · `qq.account.read` 是 **R1**：外部读、结果跨会话共享，但它是只读的，
 *     而且"让它在群里看一眼表情库"正是这个能力的主要价值。
 *     定成 R2 会让表情包在群聊里彻底用不了（读都读不到，谈何选图）。
 *   · `exec` 是 **R3**：不可逆（一条 `rm` 之后没有撤销）。
 */
export const EFFECT_RISK_FLOOR = Object.freeze({
  'data.read': 'R0',
  'data.write': 'R2',
  'data.session': 'R1',
  'chat.read': 'R1',
  'chat.send': 'R1',
  'chat.send.media': 'R1',
  'qq.account.read': 'R1',
  'qq.account.write': 'R2',
  net: 'R1',
  paid: 'R2',
  exec: 'R3',
});

/** 风险档从低到高 */
export const RISK_ORDER = Object.freeze(['R0', 'R1', 'R2', 'R3']);

/**
 * 取两个风险档里更高的那个。
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function maxRisk(a, b) {
  const ia = RISK_ORDER.indexOf(String(a));
  const ib = RISK_ORDER.indexOf(String(b));
  if (ia < 0) return b;
  if (ib < 0) return a;
  return ia >= ib ? a : b;
}

/**
 * 归一化 effects 声明。
 *
 * 不认识的词**直接拒绝**，而不是忽略：
 * 忽略会让作者以为自己声明了 `chat.sned`（拼错）就获得了发送能力，
 * 而实际风险下限没抬起来 —— 症状是"它有时候会自动发消息"，很难归因。
 *
 * @param {unknown} raw
 * @returns {{ok: true, effects: string[]} | {ok: false, code: string, message: string, field?: string}}
 */
export function normalizeEffects(raw) {
  if (raw === undefined || raw === null) return { ok: true, effects: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'E4041', message: 'effects 必须是字符串数组', field: 'effects' };
  }
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, code: 'E4041', message: 'effects 里有非字符串项', field: 'effects' };
    }
    const word = item.trim();
    if (!EFFECTS.includes(word)) {
      return {
        ok: false,
        code: 'E4041',
        message: `未知的 effect：${word}（可用：${EFFECTS.join(' / ')}）`,
        field: 'effects',
      };
    }
    if (!out.includes(word)) out.push(word);
  }
  return { ok: true, effects: out };
}

/**
 * 一组 effects 推导出的风险下限。
 *
 * @param {ReadonlyArray<string>} effects
 * @returns {string}
 */
export function riskFloorOf(effects) {
  let floor = 'R0';
  for (const word of effects ?? []) {
    const one = EFFECT_RISK_FLOOR[/** @type {keyof typeof EFFECT_RISK_FLOOR} */ (word)];
    if (one) floor = maxRisk(floor, one);
  }
  return floor;
}

/**
 * 是否声明了某个 effect。
 *
 * @param {ReadonlyArray<string> | undefined} effects
 * @param {string} word
 * @returns {boolean}
 */
export function hasEffect(effects, word) {
  return Array.isArray(effects) && effects.includes(word);
}

/**
 * 声明是否触及"钱"。
 *
 * 单独给一个函数而不是让调用方写 `hasEffect(x,'paid')`：
 * 这个判断以后可能变成"paid 或 net.charged"之类，收在一处就不会漏改。
 *
 * @param {object} tool
 * @returns {boolean}
 */
export function isPaidTool(tool) {
  return hasEffect(tool?.effects, 'paid');
}
