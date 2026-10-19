/**
 * 配置 —— F9 / 不变量 I9
 *
 * 严格校验：**未知键拒绝**，而不是忽略。
 * 理由：拼错键时静默失效是最难查的一类故障（参考项目为此踩过坑）。
 */

/** 默认配置。所有可调项集中在这里，便于对照文档。 */
export const DEFAULT_CONFIG = Object.freeze({
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
     * 允许加载的插件名（目录名）。**空数组 = 一个都不加载**。
     * 光把插件放进 plugins/ 目录不会生效，必须在这里点名。
     *
     * 默认带 `dsh-bridge`：它是随包内置的默认插件（需求 2 的入口）。
     * 它自己会在**没配令牌时静默待命**，所以默认启用是安全的——
     * 装了但不配 = 什么都不做，不会凭空开端口。
     */
    enabled: ['dsh-bridge'],
    /** 是否允许插件声明 R2/R3 工具（默认关闭） */
    allowDangerous: false,
  },
  /**
   * DSH 双向接入（需求 2）。
   *
   * 默认**全部关闭**：不是每个人都在同时跑 DSH，
   * 而且这一步会让本机的 AI 能通过 QQ 被远程指挥——
   * 必须由用户显式打开，不能默认生效。
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
 * 后果不是报个警告就完了 —— 用户点一次「探测能力」，配置里就多一个模型名，
 * **下次启动直接 E40XX 起不来**。
 *
 * 所以这些节点整块接受，只校验它确实是个对象。
 *
 * @type {Set<string>}
 */
const DYNAMIC_MAPS = new Set(['llm.modelCapabilities']);

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
  return config;
}
