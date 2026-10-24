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
     * 形状：{ [modelId]: { vision?: boolean, probes?: object, channel?: string, probedAt?: string } }
     * 探测失败时对应字段不写，而不是写 false
     * ——"没测出来"和"确认不支持"是两件事，混在一起会误导用户。
     *
     * **只记视觉（读图）**：生图能力归独立插件 `image-generation`，
     * 不在聊天模型这里探测，也不按模型名推断。老配置里遗留的
     * `image` / `imageGen` / `probes.image` 会在启动时被
     * `sanitizeModelCapabilities()` 清掉（见 src/llm/capability.mjs）。
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
  /**
   * 回复分条 —— 一次回复拆成几个气泡说
   *
   * ## 为什么这是配置而不是写死的常数
   *
   * 分条的合适密度取决于场景与人格：
   *
   *   - 私聊里一两句一条很自然；
   *   - 群里三条以上就是刷屏；
   *   - 有人格卡是"话很多"的风格，上限给 1 会让它永远只能发一大段。
   *
   * 所以条数和间隔都交给用户，但**上限本身仍然受硬边界约束**
   * （见 `src/reply/split.mjs` 的 MAX_MESSAGES_HARD_CAP）：配置里填 100
   * 会被夹到 10，而不是让机器人真的发 100 条。
   *
   * ## 为什么默认 3 条 / 800ms
   *
   * 3 条的语义是"最多分三口气说完"，覆盖了绝大多数真实场景；
   * 800ms 是"看完一句再打下一条"的节奏附近，短了像刷屏，长了像卡住。
   */
  reply: {
    /**
     * 是否允许分条。
     *
     * 关掉之后模型即使写了分条块也整条发出 —— 它是一个**硬开关**，
     * 不是"建议值"。用户关掉它的理由通常很具体（某个群里分条显得吵）。
     */
    splitEnabled: true,
    /** 单次回复最多分几条（1 = 始终整条发；硬上限见 MAX_MESSAGES_HARD_CAP） */
    maxMessages: 3,
    /** 相邻两条之间的间隔（毫秒） */
    intervalMs: 800,
  },
  allow: {
    groups: [],
    private: [],
  },
  /**
   * 管理员 —— 「谁能让它动本机」。
   *
   * ## 为什么要从白名单里拆出来
   *
   * 在这之前，`owner-private` 的来源判定读的是 `allow.private`。
   * 那是把两件事合成一件：
   *
   *   | 清单 | 回答的问题 |
   *   | --- | --- |
   *   | `allow.private` | **谁能跟它说话**（L1 准入） |
   *   | `admin.qqIds` | **谁能让它动本机**（L2 授权） |
   *
   * 合并的具体后果：为了让机器人能回某人的私聊，把他加进白名单
   * （那本来只是"允许对话"），他就**同时**拿到宿主机工具与
   * 高风险操作的确认权 —— 而用户完全不知道加白名单还顺带授了权。
   *
   * ## 为什么默认空
   *
   * 空 = 没有管理员 = 没人能拿到宿主机工具。这是 fail-closed 的方向：
   * 少给权限永远比多给安全，而补权限只需要在界面点两下。
   *
   * ## `inheritWhitelist` 是什么
   *
   * 老用户的白名单里可能确实填的是自己的号。升级后一声不响地全部
   * 失去权限，表现是"以前能读文件现在报没权限"，而且不知道该去哪补 ——
   * 那是很糟的升级体验。所以留一个**显式**开关把它们并进来。
   *
   * 但它不能默认打开：默认打开就等于这次拆分没做。
   * 打开时启动日志会留一行，界面上也写明风险。
   */
  admin: {
    /** 核心管理员 QQ 号。空 = 谁都没有管理员权限 */
    qqIds: [],
    /** 兼容开关：把 allow.private 也当成管理员（见上方说明） */
    inheritWhitelist: false,
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
  /**
   * 视觉读图 —— 图片到底能不能进对话（见 docs/vision-contract.md §9）。
   *
   * ## 为什么默认关闭
   *
   * 图片一旦进请求体，代价是**双份**的：token 变多，而且每张图都要先取回来
   * （走网关 `get_image` 或 URL 抓取，可能失败、可能很慢）。默认打开等于
   * 让所有用户在升级后突然为看不见的图片付费。
   *
   * ## 为什么"开关"和"能力"必须是两份状态
   *
   * `enabled` 是**用户想不想**；实测出来的模型能力是**模型能不能**。
   * 两者分开存、分开显示（快照里是 `vision.enabled` 与 `vision.capability`）：
   * 把「没探测过」显示成「不支持」会让用户以为功能坏了，其实只是没测过。
   * 因此这一块只存用户意图与预算，**不存任何能力结论**。
   *
   * ## 单位和取值范围
   *
   * 字节一律用**真实的字节数**（不是 MB），像素用**真实像素数**：
   * 配置是给代码读的，换算只发生在界面上。手改 config.json 的人看到
   * 4194304 就知道那是 4 MB，看到 "4MB" 反而要猜解析规则。
   */
  vision: {
    /** 总开关。关 = 不取图、不提交图片，消息文本里仍是 `[图片]` 占位 */
    enabled: false,
    /** 本轮消息最多提交几张图（硬上限 4） */
    maxImagesPerTurn: 3,
    /** 引用/历史图片最多提交几张（硬上限 3，0 = 完全不提交历史图） */
    maxHistoryImages: 2,
    /** 单张图片的字节上限（4 MB）：再大就别发，base64 会把请求撑爆 */
    maxBytes: 4_194_304,
    /** 一回合所有图片的字节总和（8 MB） */
    maxTotalBytes: 8_388_608,
    /** 单张图片的像素上限（3600 万）：既防解压炸弹，也防上游直接 413 */
    maxPixels: 36_000_000,
    /** 单张图的取图超时（毫秒）：一轮聊天不能被一张图拖住太久 */
    timeoutMs: 8000,
    /** 只回看最近几楼的历史图片（硬上限 8） */
    historyWindow: 6,
    /** 是否把「被引用那条消息」里的图片也带上 */
    includeQuoted: true,
    /** 已取回的图片字节在内存里缓存多久（5 分钟） */
    cacheTtlMs: 300_000,
  },
  persona: {
    /** 机器人被叫的名字（用于「叫名字」触发） */
    name: 'Ling',
  },
  /**
   * 联网 —— Ling-bot **自己发起**的外网访问总闸。
   *
   * ## 这个开关控制什么，不控制什么
   *
   * 控制：搜索 API、网页正文读取（`ctx.net.*`）。关掉之后这两条通路
   * 一个请求都不发，AI 的工具列表里也不会出现它们。
   *
   * **不**控制：模型服务商在自己服务端做的检索。那是上游行为，我们
   * 看不到也拦不住。界面上必须原样写清这一点 —— 否则用户关掉开关后
   * 看到模型"好像还能查到东西"，会以为开关是假的。
   *
   * ## 为什么缺省是 true
   *
   * 这是既有行为的延续：本轮之前没有任何出站搜索能力，所以
   * "配置里没有 network 字段"的旧部署行为必须完全不变。
   *
   * 而且"缺省开"不会凭空打开联网：`web-search` 插件默认**不**在
   * `plugins.enabled` 里（铺盘 ≠ 启用，与 stickers / course-schedule
   * 同一套纪律）。三条同时成立才会有搜索工具：
   * 总闸开 + 插件启用 + 插件配了 Key。
   *
   * ## 独立搜索 API 的配置在哪
   *
   * 服务商、地址、Key、条数、超时都在插件配置里（`plugins.config['web-search']`），
   * 因为它们是**那个插件**的事：换搜索服务商不该要求宿主改配置结构。
   *
   * ## 为什么原生联网放在这里
   *
   * 它和独立搜索 API 不同：请求由**模型客户端**发出，不属于任何插件，
   * 也不使用搜索服务商那把 Key。所以这里只放两条最小的跨模块决定：
   * 「走哪条通道」和「原生通道用哪家服务商」。真正的协议字段在
   * `src/llm/provider-search.mjs` 里按服务商注册。
   */
  network: {
    /** 总闸。关 = 搜索与网页读取全部拒绝（含在途请求立即中止） */
    enabled: true,
    /**
     * 联网通道（**只在总闸开着时生效**）：
     *   · `api`    独立搜索 API：Ling-bot 自己发请求，结果作为工具（在插件配置里配）
     *   · `native` 服务商原生联网：只在模型请求体里声明，检索由服务商完成
     *
     * 为什么是枚举而不是再从 `llm.provider` 推断：那个字段只做界面回显，
     * 而且中转/自建的字段支持各不相同。按模型名或预设 id 猜服务商，
     * 会把"按 A 家协议发请求、实际打到 B 家"变成静默失败。
     */
    mode: 'api',
    /**
     * 服务商原生联网的配置。
     *
     * `provider` 是**用户显式选择**的服务商（`zhipu` / `openai`）；
     * 留空或未知值一律不发送任何联网参数（不会按别的服务商协议发）。
     * `maxResults` 只对支持条数的协议（智谱）生效，1–20。
     */
    native: {
      provider: '',
      maxResults: 5,
    },
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
     * 聊天来源的插件工具授权 —— 「哪些插件工具可以在群里/陌生人私聊/
     * 主动回合被调用」。
     *
     * ## 为什么默认全关
     *
     * 改造前，`needs: 'qq'` 的插件工具在**任何白名单群**里都可用。
     * 对 `echo` 这类回显工具无所谓，但接下来的课程表、表情包、生图插件
     * 一旦装上去就等于把"能发图 / 会花钱"的能力交给了群里每个人。
     *
     * 所以默认值必须是"一个都不开放"，由管理员显式点名。
     * 默认全开会造成升级后"群里突然多了几个工具"，而用户完全不知道。
     *
     * ## 三个档为什么互相独立
     *
     *   group     白名单群里的群友
     *   private   陌生人（非管理员）私聊
     *   proactive 主动唤醒回合（没有具体的人、没有明确请求）
     *
     * 三者的风险完全不同：管理员可能愿意在自己的群里放开表情包，
     * 却不想让陌生人私聊也能用；更不想让"它自己想起说话"的时候
     * 顺手发一张图或花一次钱。合并成一个开关就等于把三者绑在一起。
     *
     * ## tools 里写什么
     *
     * 完整工具名（`plugin_echo`）。`"*"` 表示该档全部**合格**工具
     * （R0/R1、非写入/执行类），不推荐但留着应急。
     * 写内置工具名不生效、也不报错？不 —— 保存时直接拒绝（E40XX），
     * 免得留下一个"配了没反应"的假开关。
     */
    chatTools: {
      group: { enabled: false, tools: [], allowPaid: false },
      private: { enabled: false, tools: [], allowPaid: false },
      proactive: { enabled: false, tools: [], allowPaid: false },
    },
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
 *   - `llm.modelCapabilities` → `{ [模型名]: { vision, probes, ... } }`
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

  /*
   * 管理员名单的形状校验。
   *
   * 这一条比别的配置更要紧：名单最终会进 `isCoreAdmin()` 做字符串比对。
   * 混进空串或说明文字不会报错，只会让比较**永远不成立** ——
   * 表现是"我明明把自己填成管理员了，还是说没权限"，而日志里一片安静。
   */
  const admin = /** @type {any} */ (config).admin;
  if (!admin || typeof admin !== 'object' || Array.isArray(admin)) {
    throw Object.assign(new Error('配置项 admin 必须是对象'), { code: 'E40XX' });
  }
  if (!Array.isArray(admin.qqIds)) {
    throw Object.assign(new Error('配置项 admin.qqIds 必须是数组'), { code: 'E40XX' });
  }
  for (const id of admin.qqIds) {
    if (!/^\d{4,15}$/.test(String(id))) {
      throw Object.assign(
        new Error(`配置项 admin.qqIds 里的 "${id}" 不是合法 QQ 号（应为 4–15 位数字）`),
        { code: 'E40XX' },
      );
    }
  }
  if (typeof admin.inheritWhitelist !== 'boolean') {
    throw Object.assign(new Error('配置项 admin.inheritWhitelist 必须是布尔值'), { code: 'E40XX' });
  }

  /*
   * 联网总闸的形状校验。
   *
   * 为什么必须在这里硬失败而不是运行时兜底：`network.enabled` 是安全开关。
   * 手写 `"enabled": "false"`（字符串）时，若运行时做真值转换就会得到
   * `true` —— 用户写了关闭，实际开着，而界面上一切正常。这是这个开关
   * 唯一不能容忍的错法，所以启动就拒绝。
   */
  const network = /** @type {any} */ (config).network;
  if (!network || typeof network !== 'object' || Array.isArray(network)) {
    throw Object.assign(new Error('配置项 network 必须是对象'), { code: 'E40XX' });
  }
  if (typeof network.enabled !== 'boolean') {
    throw Object.assign(
      new Error('配置项 network.enabled 必须是布尔值（true / false，不要写成字符串）'),
      { code: 'E40XX' },
    );
  }
  /*
   * 联网通道必须是枚举。
   *
   * 为什么硬失败：`mode` 决定"请求里发哪种联网声明"。写成别的值再按
   * 默认当 `api` 处理，会让用户以为自己开了原生联网，而实际走的还是插件。
   */
  if (network.mode !== 'api' && network.mode !== 'native') {
    throw Object.assign(
      new Error('配置项 network.mode 只能是 "api"（独立搜索 API）或 "native"（服务商原生联网）'),
      { code: 'E40XX' },
    );
  }
  /*
   * 原生联网块：只校验形状与上限。
   *
   * 服务商名**不在这里白名单**：手改配置写了个还没适配的名字时，运行时会
   * 明确报"尚未适配、不会发送任何联网参数"，而不是让人起不来。这跟
   * provider 白名单的运行时判定是同一套纪律（见 src/llm/provider-search.mjs）。
   */
  if (!network.native || typeof network.native !== 'object' || Array.isArray(network.native)) {
    throw Object.assign(new Error('配置项 network.native 必须是对象'), { code: 'E40XX' });
  }
  if (typeof network.native.provider !== 'string') {
    throw Object.assign(new Error('配置项 network.native.provider 必须是字符串'), { code: 'E40XX' });
  }
  if (network.native.provider.length > 40) {
    throw Object.assign(new Error('配置项 network.native.provider 过长（≤40 字符）'), { code: 'E40XX' });
  }
  if (
    !Number.isInteger(network.native.maxResults)
    || network.native.maxResults < 1
    || network.native.maxResults > 20
  ) {
    throw Object.assign(
      new Error('配置项 network.native.maxResults 必须是 1–20 的整数'),
      { code: 'E40XX' },
    );
  }

  const wsUrl = /** @type {any} */ (config).onebot.wsUrl;
  try {
    new URL(wsUrl);
  } catch {
    throw Object.assign(new Error(`配置项 onebot.wsUrl 不是合法 URL：${wsUrl}`), { code: 'E40XX' });
  }

  /*
   * 分条配置。
   *
   * ## 为什么要在这里挡，而不是运行时再夹
   *
   * 运行时的 `normalizeMaxMessages` 会把 100 夹成 10、把字符串夹成默认值 ——
   * 那是对的兜底，但它**静默**。用户手改了 config.json、写了 "5条"，
   * 启动后看到界面上是 5，就以为自己设对了，其实一直用的是 10。
   *
   * 所以启动校验必须硬失败：写错就报出来，改对了才起得来。
   */
  const reply = /** @type {any} */ (config).reply;
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw Object.assign(new Error('配置项 reply 必须是对象'), { code: 'E40XX' });
  }
  if (typeof reply.splitEnabled !== 'boolean') {
    throw Object.assign(new Error('配置项 reply.splitEnabled 必须是布尔值'), { code: 'E40XX' });
  }
  if (!Number.isInteger(reply.maxMessages) || reply.maxMessages < 1 || reply.maxMessages > 10) {
    throw Object.assign(
      new Error('配置项 reply.maxMessages 必须是 1–10 的整数（1 = 始终整条发）'),
      { code: 'E40XX' },
    );
  }
  if (!Number.isInteger(reply.intervalMs) || reply.intervalMs < 100 || reply.intervalMs > 10000) {
    throw Object.assign(
      new Error('配置项 reply.intervalMs 必须是 100–10000 的整数（毫秒）'),
      { code: 'E40XX' },
    );
  }

  /*
   * 视觉配置（docs/vision-contract.md §9）。
   *
   * ## 为什么这里必须抛错，而不是像运行时那样夹取
   *
   * 运行时有一条 `normalizeVisionConfig`，它负责把超过硬上限的值**夹回去**：
   * 那是给"老配置、手改配置、插件写进来的值"兜底用的，不能让程序因为一个
   * 数字就起不来。
   *
   * 但用户在界面上填 999 张时，夹取的后果是"保存成功、界面上还显示 999、
   * 实际只发 4 张"。用户下次再来调，看到的仍是那个假的 999 —— 这类静默
   * 失效比启动失败难查得多。所以：
   *
   *   启动/保存校验 → 硬失败（这里）
   *   运行期兜底   → 静默夹取（vision.mjs 的 normalizeVisionConfig）
   *
   * 两侧都不省略，但职责不同。
   *
   * ## 范围从哪来
   *
   * 上界一律取 `VISION_LIMITS_HARD` 的 **2 倍**（而不是等值）：
   * 用户想调得比默认硬上限更宽松是合理需求，允许他写下来，
   * 真正生效时由运行时夹到硬上限。超过 2 倍就不再是"想宽松一点"，
   * 而是笔误（多半是把字节当成 MB 填了），该当场拦下。
   *
   * 注意这个文件**不 import vision.mjs**：配置层不该依赖运行时模块
   * （vision.mjs 会拉进取图链路，启动早期就用它太重了）。所以这里写死
   * 同一组数字，并在注释里标明它们与 VISION_LIMITS_HARD 的对应关系。
   */
  const VISION_HARD = {
    maxImagesPerTurn: 4,
    maxHistoryImages: 3,
    maxBytes: 4_194_304,
    maxTotalBytes: 8_388_608,
    maxPixels: 36_000_000,
    timeoutMs: 15000,
    historyWindow: 8,
    cacheTtlMs: 300_000,
  };

  const vision = /** @type {any} */ (config).vision;
  if (!vision || typeof vision !== 'object' || Array.isArray(vision)) {
    throw Object.assign(new Error('配置项 vision 必须是对象'), { code: 'E40XX' });
  }

  if (typeof vision.enabled !== 'boolean') {
    throw Object.assign(new Error('配置项 vision.enabled 必须是布尔值'), { code: 'E40XX' });
  }
  if (typeof vision.includeQuoted !== 'boolean') {
    throw Object.assign(new Error('配置项 vision.includeQuoted 必须是布尔值'), { code: 'E40XX' });
  }

  /**
   * 整数 + 区间校验的小工具。
   *
   * @param {string} field
   * @param {number} min
   * @param {number} max
   * @param {string} unit
   */
  const checkInt = (field, min, max, unit) => {
    const v = vision[field];
    if (!Number.isInteger(v) || v < min || v > max) {
      throw Object.assign(
        new Error(`配置项 vision.${field} 必须是 ${min}–${max} 的整数（${unit}）`),
        { code: 'E40XX' },
      );
    }
  };

  // 张数：1 张是下限（填 0 等于"开了但一张都不发"，那是关掉开关该干的事）；
  // 历史张数允许 0 —— 「只想看本轮、不补历史」是个合理选择。
  checkInt('maxImagesPerTurn', 1, VISION_HARD.maxImagesPerTurn, '张');
  checkInt('maxHistoryImages', 0, VISION_HARD.maxHistoryImages, '张');
  // 字节/像素：上界是硬上限的 2 倍（理由见上面那段注释）
  checkInt('maxBytes', 1, VISION_HARD.maxBytes * 2, '字节');
  checkInt('maxTotalBytes', 1, VISION_HARD.maxTotalBytes * 2, '字节');
  checkInt('maxPixels', 1, VISION_HARD.maxPixels * 2, '像素');
  // 超时与缓存：这两项没有"2 倍"的余量。等太久会把一个回合卡死，
  // 缓存留太久则会一直用旧字节（图片 URL 可能已经过期）。
  checkInt('timeoutMs', 1000, 30_000, '毫秒');
  checkInt('cacheTtlMs', 60_000, 3_600_000, '毫秒');
  // 回看窗口：契约 §9 没有写它的区间，所以这里与运行时
  // `normalizeVisionConfig`（vision.mjs）的口径对齐 —— 它接受 0–8。
  // 0 的语义是"不回看任何楼层"（等于只读本轮消息），是个合理选择；
  // 配置层比运行时更严的后果是"运行时能吃下的配置启动不了"，那更糟。
  checkInt('historyWindow', 0, VISION_HARD.historyWindow, '楼');

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

  /*
   * 聊天来源的插件工具授权（plugins.chatTools）。
   *
   * ## 为什么在这里也要验一遍
   *
   * 校验逻辑在 `plugins/chat-tools.mjs`（运行时保存走它）。启动时这里再验，
   * 是为了挡住**手改 config.json** 的情况：写错一个 `enabled: "true"`（字符串）
   * 不会报错，运行时归一化会把它当 false —— 表现为"我明明开了，群里还是不能用"，
   * 而日志里一片安静。启动就失败比这种静默失效好得多。
   */
  const chatTools = /** @type {any} */ (config).plugins?.chatTools;
  if (!chatTools || typeof chatTools !== 'object' || Array.isArray(chatTools)) {
    throw Object.assign(new Error('配置项 plugins.chatTools 必须是对象'), { code: 'E40XX' });
  }
  for (const channel of ['group', 'private', 'proactive']) {
    const rule = chatTools[channel];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw Object.assign(new Error(`配置项 plugins.chatTools.${channel} 必须是对象`), { code: 'E40XX' });
    }
    if (typeof rule.enabled !== 'boolean') {
      throw Object.assign(
        new Error(`配置项 plugins.chatTools.${channel}.enabled 必须是布尔值`),
        { code: 'E40XX' },
      );
    }
    if (typeof rule.allowPaid !== 'boolean') {
      throw Object.assign(
        new Error(`配置项 plugins.chatTools.${channel}.allowPaid 必须是布尔值`),
        { code: 'E40XX' },
      );
    }
    if (!Array.isArray(rule.tools)) {
      throw Object.assign(
        new Error(`配置项 plugins.chatTools.${channel}.tools 必须是数组`),
        { code: 'E40XX' },
      );
    }
    for (const name of rule.tools) {
      // 与 plugins/chat-tools.mjs 同一套口径：只认插件工具全名或 `*`
      if (typeof name !== 'string' || (name !== '*' && !/^plugin_[a-z][a-z0-9_]{1,32}$/.test(name))) {
        throw Object.assign(
          new Error(
            `配置项 plugins.chatTools.${channel}.tools 里的「${String(name)}」不是合法工具名（应为 plugin_xxx 或 *）`,
          ),
          { code: 'E40XX' },
        );
      }
    }
  }

  return config;
}
