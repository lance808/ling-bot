/**
 * 配置 —— F9 / 不变量 I9
 *
 * 严格校验：**未知键拒绝**，而不是忽略。
 * 理由：拼错键时静默失效是最难查的一类故障（参考项目为此踩过坑）。
 */

/** 默认配置。所有可调项集中在这里，便于对照文档。 */
export const DEFAULT_CONFIG = Object.freeze({
  // 环境页允许保存安装位置；必须声明，否则下次启动会被未知键校验拒绝。
  qqExe: '',
  snowlumaDir: '',
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken: '',
    followDiscoveredEndpoint: true,
  },
  llm: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
    timeoutMs: 120_000,
    /** 触发关键词（用户在界面维护）；空数组 = 不靠关键词唤醒 */
    keywords: [],
    /**
     * 提供商预设 id（见 ui/src/views/model.mjs 的 PROVIDERS）。
     * `'custom'` = 用户自己填网址。只用于界面回显，不影响实际请求
     * ——真正的地址永远以 baseUrl 为准，避免两处真相打架。
     */
    provider: '',
    /**
     * 模型能力探测结果（约定：**只记录实测结论**，不记录猜测）。
     *
     * 形状：{ [modelId]: { vision?: boolean, image?: boolean, channel?: string, probedAt?: string } }
     * 探测失败时对应字段不写，而不是写 false
     * ——"没测出来"和"确认不支持"是两件事，混在一起会误导用户。
     */
    modelCapabilities: {},
    /**
     * 思考内容（reasoning）的开启方式。
     *
     * ## 为什么这是个必需的配置项
     *
     * 请求体原来只有 model / messages / stream，思考内容全靠上游"默认给"。
     * 于是换一个模型（或换一个中转）就可能突然收不到 reasoning ——
     * 请求本身是 200，只是少了那个字段，所以**不会有任何报错**，
     * 表现是"聊天正常，但思考链路永远是空的"。
     *
     * ## 为什么默认是 openai
     *
     * 默认往请求体里加 `reasoning_effort: "medium"`：这是目前最通用的写法，
     * 推理模型见到它会按中等强度思考，非推理模型多数直接忽略。
     * 相比"什么都不加"，它能让"上游需要显式开启"的情况也能拿到思考内容。
     *
     * 代价要说清楚：极少数上游会拒绝不认识的字段（直接 400）。
     * 真遇到就在模型设置里切成 `auto`（完全不注入），或 `off`。
     *
     * 取值见 client.mjs 的 THINKING_STYLES。
     */
    thinking: 'openai',
  },
  allow: {
    groups: [],
    private: [],
  },
  deny: {
    groups: [],
    private: [],
  },
  allowAllWhenEmpty: false,
  limits: {
    maxSendPerMinute: 8,
    maxSendPerHour: 60,
  },
  proactive: {
    enabled: true,
    probability: 0.1,
    minIntervalMs: 1_800_000,
    activeWindowMs: 1_800_000,
  },
  /**
   * 唤醒设置 —— 「什么消息值得起一个回合」。
   *
   * ## ⚠️ 与参考项目 qq-bridge 的语义不同
   *
   * 那边是「AI 自主潜水」：AI 决定何时睡，桥接按条件把它叫醒。
   * Ling-bot 是消息驱动的：收到消息 → 判定够不够格起一个回合。
   *
   * 所以这里的字段映射是：
   *   minSleepMs   → 两次**主动发言**之间的最小间隔
   *   maxWakePer*  → 每会话每分/每小时最多起几个回合
   *   atMention 等 → detectTrigger 的各个开关
   *
   * ## 每个开关都是硬开关
   *
   * 关掉就是不触发，不存在"关掉走默认值"。用户关掉「提问唤醒」
   * 是因为不想被每句问话叫醒，关掉还触发的话这个开关就是假的。
   */
  wake: {
    /** active = 正常参与；diving = 只在被明确叫到时参与 */
    defaultMode: 'active',
    /** 被 @ 或引用机器人时触发 */
    atMention: true,
    /** 文本里出现机器人名字时触发 */
    nameMention: true,
    /** 被直接提问时触发（问号 / 句尾疑问助词，判定刻意保守） */
    question: true,
    /** 有人拍一拍机器人时触发 */
    poke: true,
    /** 指定群友 QQ 号：这些人发言就触发（想等某个人时用） */
    speakerIds: [],
    /**
     * 触发关键词。
     *
     * 新位置。老配置里的 `llm.keywords` 会在启动时迁过来，
     * 但那个字段**不删**（mergeStrict 对未知键 fail-fast，删了就是起不来）。
     */
    keywords: [],
    /**
     * 多条消息合并成一个回合的窗口（毫秒）。
     *
     * 治「回复混乱」的第二道保险：群里连着发三条短句时，
     * 不该触发三个回合。**合并逻辑只在一处实现**（index.mjs 的回合调度），
     * 这里只是那个窗口的长度。
     */
    batchWindowMs: 8000,
    /** 两次主动发言的最小间隔（毫秒），0 = 不限 */
    minSleepMs: 60000,
    /** 最大潜水时长（毫秒），0 = 不限 */
    maxSleepMs: 0,
    /** 每会话每分钟最多起几个回合，0 = 不限 */
    maxWakePerMinute: 6,
    /** 每会话每小时最多起几个回合，0 = 不限 */
    maxWakePerHour: 60,
    /** 连续多少次回合没有产出就自动降频 */
    noActionLimit: 3,
    /** 沉睡前观察窗口（毫秒），0 = 不限制。仅供提示，不做强制 */
    preSleepWaitMs: 300000,
    /** 推荐概率（仅参考，AI 可以不遵守；硬限制在 proactive.probability） */
    recommendedProbability: 0.05,
  },
  /**
   * 日记与淡忘。
   *
   * 权重是**派生计算**：落盘只存 weightBase/weightBaseDate，
   * 读取时按日期差现算。所以这里不需要"每天跑一次衰减"的定时器。
   */
  diary: {
    /** 新日记的初始权重 */
    initialWeight: 100,
    /** 每个自然日衰减多少 */
    decayPerDay: 1,
    /** 低于这个权重就从默认列表隐藏（0 = 不隐藏） */
    hiddenBelowWeight: 0,
    /** 低于这个权重就不进上下文（即"已经淡忘了"） */
    contextMinWeight: 60,
  },
  /**
   * 静音（「闭嘴」）。
   *
   * ## 为什么独立于 wake，而不是往里塞一个开关
   *
   * `wake` 是**语义判断**：这条消息像不像在叫它、值不值得参与。
   * 静音是**绝对压制**：现在根本不许说话，优先于一切语义判断。
   *
   * 混在一起的后果很具体：用户设了静音，但某条消息"特别像在叫它"，
   * 于是它还是开口了 —— 那静音就是假的。
   *
   * ## 严格静音
   *
   * 静音期间 @ 和私聊也**不**回。半截静音（@ 还能叫醒）会让人不敢用它：
   * 群里别人狂 @ 时噪音照旧，而用户以为自己已经让它安静了。
   */
  silence: {
    /** 全局静音：开启后所有会话都不回复，直到手动关闭 */
    all: false,
    /** 按会话静音：这些 convKey 不回复（`group:123` / `private:456`） */
    convKeys: [],
    /**
     * 时段静默：`[{ start: '23:00', end: '08:00' }]`，本地时区。
     *
     * start > end 表示**跨午夜**（23:00–08:00 是最常见的写法）。
     * start == end 视为不生效，而不是全天 —— 手写出这种多半是笔误，
     * 理解成"全天静音"会让机器人整天不说话且用户不知道为什么。
     */
    windows: [],
    /**
     * 是否允许管理员在聊天里用「闭嘴 / 说话」指令。
     *
     * 关掉之后只能从桌面端控制。注意：**解除指令永远不受静音影响** ——
     * 否则用户一开口让它闭嘴就再也没法用 QQ 叫它回来，只能去改配置。
     */
    allowCommand: true,
    /**
     * 允许用静音指令的 QQ 号。**留空 = 谁都不能用指令**。
     *
     * ## 为什么不复用 `dsh.admins`
     *
     * DSH 已经改成**独立插件**了。插件自己的配置属于插件，核心功能
     * 不该反向依赖它 —— 那样会出两个问题：
     *
     *   1. 不装 DSH 插件的用户配不了静音指令（字段藏在别处，找不到）
     *   2. 卸载插件后静音权限凭空消失，而用户不知道为什么
     *
     * 更根本的是授权范围不同：`dsh.admins` 管的是"能否操作本机 DSH"，
     * 而静音只是让它闭嘴。有人愿意把静音权限给更多信任的人，
     * 但不愿给本机操作权 —— 两个名单就该是两件事。
     */
    adminIds: [],
    /** 指令默认时长（毫秒）：只说「闭嘴」不带时长时用它。默认 30 分钟 */
    defaultMuteMs: 1800000,
    /** 单次指令的最长时长（毫秒）：再长请用全局开关。默认 24 小时 */
    maxMuteMs: 86400000,
  },
  persona: {
    /** 机器人被叫的名字（用于「叫名字」触发） */
    name: 'Ling',
  },
  tools: {
    /** 允许工具访问的根目录（留空 = 一个都不允许，fail-closed） */
    roots: [],
    allowR3: false,
  },
  plugins: {
    /**
     * 允许加载的插件 id（目录名）。**空数组 = 一个都不加载**。
     * 光把插件放进 plugins/ 目录不会生效，必须在这里点名。
     *
     * 默认带 `dsh-bridge`：它是随包内置的默认插件（需求 2 的入口）。
     * 它自己会在**没配令牌时静默待命**，所以默认启用是安全的——
     * 装了但不配 = 什么都不做，不会凭空开端口。
     */
    enabled: ['dsh-bridge'],
    /** 是否允许插件声明 R2/R3 工具（默认关闭） */
    allowDangerous: false,
    /**
     * 各插件的**普通配置**（非敏感）。
     *
     * 形状：`{ [pluginId]: { [configKey]: value } }`
     *
     * 为什么放在主配置里而不是每个插件一个文件：配置的读写必须走同一套
     * 原子写与校验（I5/I9），多开一套文件格式就等于多一处可以写坏的地方。
     * 敏感字段不在这里 —— 它们进 `plugin-secrets.vault`（见 paths.mjs）。
     *
     * 这是**动态字典**：键由磁盘上的插件决定，所以整块接受（见 DYNAMIC_MAPS）。
     */
    config: {},
  },
  /**
   * DSH 双向接入（需求 2）。
   *
   * ## 已迁移为插件配置，这里只保留"读旧配置"的能力
   *
   * 从插件骨架改造后，DSH 接入是 `dsh-bridge` 这个普通插件，
   * 它的配置在 `plugins.config['dsh-bridge']` 里，启用状态在 `plugins.enabled`。
   *
   * 但这个块**不能直接删**：老用户的 `config.json` 里还有它，
   * 而 `mergeStrict` 对未知键是 fail-fast —— 删掉字段等于让人开不了机。
   * 所以保留声明，启动时由 `migrateLegacyDsh()` 搬到新位置，
   * 搬完写回时会留下一个空块（无害）。
   *
   * @deprecated 用 `plugins.config['dsh-bridge']`
   */
  dsh: {
    /** 总开关。关着的时候端口都不起 */
    enabled: false,
    /** 桥监听端口（只绑 127.0.0.1，不接受外部连接） */
    port: 3458,
    /** 与 DSH 插件约定的共享令牌。空 = 起不来（不是"随便连"） */
    token: '',
    /**
     * 允许通过 QQ 控制 DSH 的管理员 QQ 号。
     * **空 = 一个都不允许**。只认私聊，群聊一律不响应。
     */
    admins: [],
    /** 指令投给哪个 DSH 会话（空 = 不能下指令，只能审批） */
    sessionId: '',
  },
  ui: {
    language: 'zh-CN',
    minimizeToTray: true,
  },
});

/**
 * 动态字典节点：键由用户数据决定，不是固定的配置项。
 *
 * ## 为什么需要这个名单
 *
 * `mergeStrict` 的职责是"发现拼错的配置项"（比如把 `timeoutMs` 写成
 * `timeout`），所以它要求每个键都在默认值里存在。但有些节点**本来就是
 * 任意键的映射**：
 *
 *   - `llm.modelCapabilities` → `{ [模型名]: { vision, image, ... } }`
 *
 * 它们的默认值是 `{}`，于是递归合并会把每个模型名都判成"未知配置项"。
 * 后果不是报个警告就完了 —— 用户点一次「探测模型」，配置里就多一个模型名，
 * **下次启动直接 E40XX 起不来**。
 *
 * 所以这些节点整块接受，只校验它确实是个对象。
 *
 * @type {Set<string>}
 */
const DYNAMIC_MAPS = new Set([
  'llm.modelCapabilities',
  /**
   * 插件普通配置：键是插件 id（由磁盘上的插件决定），值是该项自己的配置。
   * 不加进来会出现"装一个插件 → 配置里多一个 id → 下次启动被未知键拒绝"，
   * 也就是**装插件直接把程序搞崩**，正是这次改造要消灭的那类问题。
   */
  'plugins.config',
]);

/**
 * 深度合并 + 未知键检测。
 *
 * @param {object} defaults
 * @param {object} user
 * @param {string} [prefix]
 * @returns {{config: object, unknown: string[]}}
 */
export function mergeStrict(defaults, user, prefix = '') {
  /** @type {string[]} */
  const unknown = [];
  /** @type {Record<string, any>} */
  const out = { ...defaults };

  if (user === undefined || user === null) return { config: out, unknown };
  if (typeof user !== 'object' || Array.isArray(user)) {
    throw Object.assign(new Error(`配置项 ${prefix || '(根)'} 必须是对象`), { code: 'E40XX' });
  }

  for (const [key, value] of Object.entries(user)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in defaults)) {
      unknown.push(path);
      continue;
    }
    const def = /** @type {any} */ (defaults)[key];

    // 动态字典：键是用户数据（模型名），整块接受，只要求是对象
    if (DYNAMIC_MAPS.has(path)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(new Error(`配置项 ${path} 必须是对象`), { code: 'E40XX' });
      }
      out[key] = value;
      continue;
    }

    if (def && typeof def === 'object' && !Array.isArray(def)) {
      const merged = mergeStrict(def, value, path);
      unknown.push(...merged.unknown);
      out[key] = merged.config;
    } else {
      out[key] = value;
    }
  }

  return { config: out, unknown };
}

/**
 * 校验配置；未知键或非法值一律抛错（fail-fast）。
 *
 * @param {object} userConfig
 * @returns {object}
 */
export function validateConfig(userConfig = {}) {
  const { config, unknown } = mergeStrict(DEFAULT_CONFIG, userConfig);
  if (unknown.length > 0) {
    throw Object.assign(new Error(`存在未知配置项：${unknown.join(', ')}`), {
      code: 'E40XX',
      unknown,
    });
  }

  const p = /** @type {any} */ (config).proactive;
  if (typeof p.probability !== 'number' || p.probability < 0 || p.probability > 1) {
    throw Object.assign(new Error('配置项 proactive.probability 必须是 0~1 的数字'), { code: 'E40XX' });
  }
  const wsUrl = /** @type {any} */ (config).onebot.wsUrl;
  try {
    new URL(wsUrl);
  } catch {
    throw Object.assign(new Error(`配置项 onebot.wsUrl 不是合法 URL：${wsUrl}`), { code: 'E40XX' });
  }

  /*
   * 静音配置的形状校验。
   *
   * `mergeStrict` 对数组是整体接受的（元素的键不参与未知键检测），
   * 所以 `silence.windows` 里的元素必须在这里单独验 ——
   * 否则写错一个 `{start,end}` 会在运行时段静默悄悄失效，
   * 而用户以为设好了（这是最难排查的一类问题）。
   */
  const silence = /** @type {any} */ (config).silence;
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  if (!Array.isArray(silence.convKeys)) {
    throw Object.assign(new Error('配置项 silence.convKeys 必须是数组'), { code: 'E40XX' });
  }
  for (const k of silence.convKeys) {
    if (typeof k !== 'string' || !/^(group|private):\d+$/.test(k)) {
      throw Object.assign(
        new Error(`配置项 silence.convKeys 里的 "${k}" 不是合法会话键（应为 group:123 或 private:456）`),
        { code: 'E40XX' },
      );
    }
  }

  if (!Array.isArray(silence.adminIds)) {
    throw Object.assign(new Error('配置项 silence.adminIds 必须是数组'), { code: 'E40XX' });
  }
  for (const id of silence.adminIds) {
    if (!/^\d+$/.test(String(id))) {
      throw Object.assign(
        new Error(`配置项 silence.adminIds 里的 "${id}" 不是合法 QQ 号（应为纯数字）`),
        { code: 'E40XX' },
      );
    }
  }

  if (!Array.isArray(silence.windows)) {
    throw Object.assign(new Error('配置项 silence.windows 必须是数组'), { code: 'E40XX' });
  }
  for (const [i, w] of silence.windows.entries()) {
    if (!w || typeof w !== 'object') {
      throw Object.assign(new Error(`配置项 silence.windows[${i}] 必须是对象`), { code: 'E40XX' });
    }
    for (const field of ['start', 'end']) {
      if (!TIME_RE.test(String(w[field] ?? ''))) {
        throw Object.assign(
          new Error(`配置项 silence.windows[${i}].${field} 必须是 HH:MM（24 小时制，例如 23:00）`),
          { code: 'E40XX' },
        );
      }
    }
  }

  for (const field of ['defaultMuteMs', 'maxMuteMs']) {
    const v = silence[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw Object.assign(new Error(`配置项 silence.${field} 必须是非负数字`), { code: 'E40XX' });
    }
  }
  if (silence.maxMuteMs > 0 && silence.defaultMuteMs > silence.maxMuteMs) {
    throw Object.assign(
      new Error('配置项 silence.defaultMuteMs 不能大于 maxMuteMs（否则默认时长会被上限截短）'),
      { code: 'E40XX' },
    );
  }

  return config;
}
