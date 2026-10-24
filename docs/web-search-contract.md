# 联网与独立搜索 —— 实施契约（最终行为）

> 本文件是**跨模块契约**，不是用户文档。用户向说明见 [web-search.md](web-search.md)。
> 三个并行工作面（核心模块 / 宿主接线 / 界面）只认这里定义的形状与语义。
> 本文描述的是**本轮收口后的最终行为**；未落地或未验证的项会在「验证状态」里注明。

## 0. 范围与非目标

本轮实现三种**互斥**的执行方式：

| 模式 | 存储 / 生效值 | 含义 |
| --- | --- | --- |
| 关闭 | `enabled = false` → `effectiveMode = 'off'` | Ling-bot **自己发起的**受控搜索 / 网页读取一律拒绝（`ctx.net.search` / `ctx.net.fetch`）；模型请求里也**不发送任何联网声明**。 |
| 独立搜索 API | `enabled = true` + `mode = 'api'` | 由 Ling-bot 直接调一个搜索服务商的结构化 API，结果作为**工具**交给模型（原 Tavily 插件链路）。 |
| 服务商原生联网 | `enabled = true` + `mode = 'native'` | Ling-bot 只在**模型请求体**里声明联网；检索由模型服务商在其自己的服务端完成。本轮只适配智谱 GLM 与 OpenAI。 |

「关闭」不是存储值：`network.mode` 只有 `api` / `native` 两个合法值，关闭由总闸表达；
快照同时给存储值 `mode` 与生效值 `effectiveMode`，避免界面把"预设"读成"正在生效"。

### 「联网开关」的控制面（两层，能力不同）

第一层是**结构性、可验证的**：关掉总开关（或处于独立 API 模式）后，Ling-bot 不再往模型请求里
发送任何联网声明/联网工具，也不再发独立搜索请求。这一层由请求体断言与工具可见性测试保证。

第二层是**不可验证的**：服务商是否仍在它自己的服务端自行检索、中转是否静默忽略参数、
已经发出的模型请求是否真的检索过 —— Ling-bot 看不到，也无法拦截。

它**不**控制：

- 模型服务商在其服务端的检索行为（包括不发送声明时它自己的默认行为）；
- QQ 网关（SnowLuma）自己的网络，以及模型 API、视觉取图等其它链路；
- 任意插件/脚本自己写的 `fetch`（没走 `ctx.net` 就不受这里约束）；
- 用户在别的软件里做的事。

**禁止表述**："所有外网流量都受控"、"关掉就彻底断网"、"服务商一定没有检索"。

### 非目标（明确不做）

- 按模型名 / 预设 id 自动推断原生服务商（协议只由用户显式选择的 `network.native.provider` 决定）；
- 新增 `/v1/responses`、`/v1/messages` 等端点或另一套事件模型；
- Moonshot Kimi、通义千问、xAI、Perplexity、Gemini、Anthropic、OpenAI Responses 的适配；
- 原生联网按来源（群聊 / 私聊 / 主动回合）单独开关；
- 群聊开放 `needs: host` 工具、站点白名单方案 —— 仍留到后续单独一轮。

## 1. 配置

`src/config/schema.mjs` 的 `DEFAULT_CONFIG` 含：

```jsonc
{
  "network": {
    "enabled": true,              // 总闸。缺省 true 是旧行为延续
    "mode": "api",                // 存储的联网通道：api | native（关闭由 enabled 表达）
    "native": {
      "provider": "",             // 显式选择：zhipu | openai；留空 = 不发送任何联网参数
      "maxResults": 5             // 1–20；仅智谱用作 count
    }
  },
  "plugins": {
    "enabled": ["dsh-bridge"], // 注意：默认**不含** web-search
    "config": {
      "web-search": {
        "provider": "tavily",
        "baseUrl": "https://api.tavily.com",
        "maxResults": 5,
        "searchDepth": "basic",
        "timeoutMs": 15000,
        "allowFetch": true,
        "maxFetchBytes": 204800,
        "fetchTimeoutMs": 10000
      }
    }
  }
}
```

- `network.enabled` 缺省 **true** 是**旧实现/旧配置的延续**，不是任务新增的默认值；
  它只表示"允许"，不等于"已经联网"。**不要再变更这个默认，也不要暗示默认就联网。**
- `network.mode` 缺省 `api`。老配置（只有 `enabled`）在校验/归一化时自动补
  `mode: 'api'`、`native.provider: ''`、`native.maxResults: 5`，行为不变。
- `network.mode` **只认** `api` / `native`：其它值在 `validateConfig` 直接失败，
  不静默当成 `api`。`network.native` 必须是对象；`provider` 必须是 ≤40 字符的字符串
  （归一化时 `trim().toLowerCase()`）；`maxResults` 必须是 1–20 的整数。
- `web-search` 插件默认**不在** `plugins.enabled` 里（铺盘 ≠ 启用，与 stickers /
  course-schedule 同一纪律）。所以默认配置下既没有搜索工具，也没有原生联网声明。
- 敏感项（`apiKey`）只能进 `plugin-secrets.vault`（DPAPI），**不得**出现在
  `config.json`、快照、日志、错误消息、工具结果里。原生联网**不使用**这把 Key。
- 独立搜索配置项的合法域（宿主归一化时兜底，保存时另校验）：
  `provider` 只认 `tavily`；`baseUrl` ≤2048、必须 https（仅 `127.0.0.1` /
  `localhost` / `::1` 允许 http）、不得带 query/hash；`maxResults` 1–20；
  `searchDepth` ∈ `basic|fast|ultra-fast|advanced`；`timeoutMs` 1–60 秒；
  `allowFetch` 布尔；`maxFetchBytes` 1 KB–1 MB；`fetchTimeoutMs` 1–30 秒。
- 模式与服务商没有 QQ 聊天写路径：正常入口是桌面端《插件设置 → 联网搜索》
  （本机 IPC 的 `setting` 通道，键为 `network.mode`、`network.native.provider`、
  `network.native.maxResults`）；手改 `config.json` 同样生效。

## 2. 搜索协议：Tavily Search API（唯一实现）

只实现**一个**真实协议，不猜测通用格式。

```
POST {baseUrl}/search
Authorization: Bearer <apiKey>
Content-Type: application/json

{
  "query": "<清洗后的查询词>",
  "max_results": 1..20,
  "search_depth": "basic" | "advanced" | "fast" | "ultra-fast",
  "topic": "general" | "news" | "finance",
  "include_answer": false,
  "include_raw_content": false,
  "include_images": false
}
```

- `query` 清洗后为空 → `E4085`（参数不合法），不发请求。
- `searchDepth` 非法值回 `basic`；`topic` 非法值回 `general`。
- **`max_results` 取 `min(配置 maxResults, 调用参数 maxResults, 协议上限 20)`**：
  调用参数只能**减少**条数，永远不能突破管理员配置的上限。
- 响应体上限 256 KB，超出按 `E4085`（响应不符合协议）处理。

成功响应（只取需要的字段，其余忽略）：

```json
{
  "query": "…",
  "results": [
    { "title": "…", "url": "https://…", "content": "…", "score": 0.81, "published_date": "…" }
  ],
  "response_time": 1.67,
  "request_id": "…"
}
```

结果归一化：`title` 截 200 字符（缺失用 hostname）、`snippet` 取
`content`/`snippet` 截 600 字符、`url` 必须通过 http(s) 且不带凭据的形状校验。
坏条目**单条丢弃**；若上游给了结果但全部不合法，返回 `E4085` 而不是空结果。
结果按 URL 去重。

错误响应：`{ "detail": { "error": "…" } }`（422 时 `detail` 是数组）。

| HTTP | 语义 | 我们的码 |
| --- | --- | --- |
| 401 / 403 | Key 缺失或非法 | `E4082` |
| 429 | 限流（带 `Retry-After`） | `E4083` |
| 432 / 433 / 402 | 套餐额度或付费额度用尽 | `E4083` |
| 400 / 422 | 请求参数不合法 | `E4085` |
| 5xx | 上游故障 | `E4086` |
| 其它非 2xx | 上游故障 | `E4086` |

**`provider` 配成非 `tavily` 的值 → 明确 `E4081`**（服务未配置/不受支持），
零请求，不静默按 Tavily 发送，也不降级到别的格式。

## 3. `ctx.net` 形状与可信调用

宿主在**每次工具调用**时构造并注入（与 `ctx.chat` / `ctx.gateway` 同一纪律：
按调用生成、不复用、不可由模型参数影响）。

```js
net: {
  available: true,          // 宿主是否注入了这个能力（占位对象时为 false）
  enabled: boolean,         // 构造这一刻的总闸状态（同步快照，供插件提前短路）
  provider: 'tavily',
  configured: boolean,      // 有 baseUrl 且解密得到 Key，且 provider 受支持

  // 搜索。**失败不抛异常**，返回结果对象。
  async search({ query, maxResults?, topic?, searchDepth? }):
    | { ok: true, provider, query, results: Source[], tookMs, credits?, truncated }
    | { ok: false, code, message, retryAfterMs? },

  // 抓网页正文（配置 allowFetch 为 false 时返回 E4080）
  async fetch({ url, maxChars? }):
    | { ok: true, url, finalUrl, status, contentType, truncated, text, bytes, redirects }
    | { ok: false, code, message },

  revoke(): void,           // 调用结束时宿主调用，之后该对象上的能力全部失效（E4071）
}

// Source
{ title: string, url: string, snippet: string, publishedDate?: string, score?: number }
```

### 3.1 可信 invocation（硬边界）

`makeFor({ pluginId, config, secrets })` 返回的对象在**每次调用**时接收
`{ invocation, signal, allowRequests }`，必须同时满足：

| 条件 | 不满足的结果 |
| --- | --- |
| `pluginId === 'web-search'` | `E4071`，零请求 |
| `invocation.origin ∈ { owner-private, console }` | `E4071`，零请求 |
| `search` 只由 `invocation.tool === 'plugin_web_search'` 发起 | `E4071`，零请求 |
| `fetch` 只由 `invocation.tool === 'plugin_web_fetch'` 发起 | `E4071`，零请求 |
| 有 invocation（不在 `init` / `testConnection` / 生命周期阶段） | `E4071`，零请求 |

**为什么精确到工具**：`search` 与 `fetch` 的风险面不同（后者才是 SSRF 入口）。
只校验插件的话，一个被改坏的 `web_search` 实现就能顺手调 `ctx.net.fetch` 去探测内网。

### 3.2 能力生命周期

- 能力对象**按调用生成**；调用结束后宿主调用 `revoke()`（executor 的
  `finally` / runtime 的 signal 一起收尾）。revoke 后任何调用返回 `E4071`。
- `init` / `testConnection` 阶段没有调用上下文（`allowRequests: false`），
  `search` / `fetch` 返回 `E4071` —— 装配与自检阶段不发请求、不花额度。
- `process` 运行时：子进程只拿到 `available / enabled / provider / configured`
  四个同步事实，真实请求由父进程代发；**Key 不下发**。

### 3.3 开关与取消

1. **开关现读**：`search` / `fetch` 进入时重新读总闸，不缓存构造时的值。
   关闭时立即 `E4080`，且不发出任何网络请求。
2. **取消**：接受宿主传入的 `signal`（即 `ctx.signal`），abort 时返回
   `{ ok:false, code:'E4070' }`，并保证连接被销毁。
3. **在途取消**：总闸 true → false 时，`netFactory.refresh()` **abort 所有在途请求**
   （不是"下次调用再拦"）。

### 3.4 Key 的边界（只限这一把）

"Key 不下发 / 不进日志 / 不回显"只针对 **`web-search` 由宿主托管的那把 Key**：
它不进插件 `init` 或调用 `ctx`、不进快照、不进日志、不进结果/错误消息。

**这不可泛化为其他插件的通用 secrets 契约**：其他插件仍按
[plugin-api.md §5.1 / §6](plugin-api.md) 的既有约定，在自己的 `init` 里拿到
自己清单声明的 `secrets`。`web-search` 是特例，因为它把请求交给宿主代发。

脱敏是补丁而不是数学保证：实现会对已知 Key 明文、URL 编码与 JSON 转义形式做替换；
含脱敏占位符的 URL 不会作为来源返回。

## 4. 网页读取的访问限制

实现直接复用 `src/llm/image-fetch.mjs` 已有的两件已审计工具，
**不另写一套判定**：

- `validateUrlShape(raw)`：只允许 http/https、禁止 URL 内嵌凭据、
  禁止 `localhost` / `.local` / `.internal` / 各种私网与保留地址字面量；
- `resolveSafeHost(hostname)`：DNS 解析后**全部**结果都必须是公网地址
  （防 DNS rebinding）。

在此之上：

| 限制 | 值 / 行为 |
| --- | --- |
| 协议 | 只 `http:` / `https:`；**没有** `file://` / 盘符 / UNC 这条分支 |
| URL 长度 | ≤ 2048 字符（首跳与每一跳都查） |
| 端口 | 只允许 80 / 443（`url.port` 为空时按协议取默认值） |
| 目标校验 | 首跳与**每一跳**都重新做 URL 形状 + DNS 全量解析 + 私网判定 |
| 重定向 | ≤ 4 跳，每跳重新校验；重定向正文直接丢弃 |
| 内容类型 | 白名单：`text/html`、`application/xhtml+xml`、`text/plain`、`text/markdown`、`application/json`、`application/ld+json`；**缺失 Content-Type 也拒绝**（`E4088`），不猜 HTML |
| 响应体 | wire（压缩前）与 decoded（解压后）**都**以 `maxFetchBytes` 为上限；超出截断并置 `truncated` |
| 内容编码 | 只接受空 / `identity` / `gzip` / `x-gzip` / `deflate` / `br`；多重编码与未知值 → `E4088` |
| 总时限 | `fetchTimeoutMs`（1–30 秒），覆盖 **DNS + 连接 + 全部跳 + 正文**；DNS 也必须受 deadline/signal 约束 |
| 方法 / 头 | 只 GET；不带 Cookie / Authorization / Referer |
| 取消/截断 | 取消或截断后销毁 req/res/decoder 与定时器，不允许继续下载 |
| 关闭路径 | `allowFetch: false` 时 `fetch` 直接 `E4080` |

返回的 `text` 已由宿主降级为纯文本（删 script/style/注释、解常见实体、压空白），
字符上限 200–50000（默认 20000），**仍是外部内容**。

## 5. 工具声明（插件清单推导）

| 工具 | needs | risk | effects | 说明 |
| --- | --- | --- | --- | --- |
| `plugin_web_search` | `host` | `R1` | `["net"]` | 出站 HTTP，有外部影响但只读 |
| `plugin_web_fetch` | `host` | `R1` | `["net"]` | 同上（读的是别人的页面） |

`needs: host` 的直接后果（既有推导，不改）：**永远进不了群聊 / 陌生人私聊 /
主动回合**，只在 `owner-private` / `console` 可见。第三方网页内容由群里任何人的
一句话就能触发抓取，那是 SSRF 的入口，本轮不开。

`allowFetch: false` 时：

- 快照 / 界面的 `tools` **不含** `plugin_web_fetch`（这是用户可见的结构性事实，
  不是"调用了才拒"）；
- 插件注册表本轮仍保留该工具，硬调 `ctx.net.fetch` 返回 `E4080` ——
  不要把它宣传成"模型绝对看不到、也调不到"。

总闸关闭时的情形不同：`disabledNetTools(config)` 会把两个工具名放进
`disabledTools`，`getPolicy` 每回合现算，模型可见集里**结构性没有**它们。

原生联网模式（`effectiveMode === 'native'`）同样由 `disabledNetTools` 把两个工具名
整体禁用，`buildNetView` 也给空 `tools` —— 两条通道不默认同时执行，见 §6.1.7。
注意原生联网本身不是这两个工具，不经过这里的 `needs: host` / R1 授权链。

## 6. 快照里的 `network` 视图

**界面位置**：不再有独立侧栏页。`ui/src/views/plugins.mjs` 在选中 `web-search`
插件后，把 `renderNetworkSection(snap, ctx)` 追加到**插件列表之后、插件详情之前**
（前面有一张「联网搜索（宿主级设置）」说明卡，写明这不是插件清单配置项）。
因此快照 `network` 块必须始终提供，不能假设「只有在某个页面才需要它」。

```js
network: {
  enabled: boolean,                 // 总闸
  mode: 'api' | 'native',           // 存储的通道（界面单选框回显用；关闭时保留原值）
  effectiveMode: 'off' | 'api' | 'native', // 生效的通道（off 优先）
  provider: 'tavily',               // 独立搜索 API 的服务商（不是原生服务商）
  baseUrl: string,
  maxResults: number,               // 独立搜索的条数上限
  timeoutMs: number,
  searchDepth: string,
  allowFetch: boolean,
  maxFetchBytes: number,
  fetchTimeoutMs: number,
  configured: boolean,              // 独立搜索：有 Key + baseUrl 合法 + provider 受支持（不回显 Key）
  plugin: {
    id: 'web-search',
    enabled: boolean,               // 在 plugins.enabled 里
    status: string,                 // disabled/ready/needs-config/error/crashed…
    configured: boolean,
  },
  native: {
    provider: string,               // 用户显式选择；'' = 未选择
    providerLabel: string,          // 智谱 GLM / OpenAI / 未选择
    providerKnown: boolean,         // 是否在 NATIVE_PROVIDERS 注册表里
    protocol: string,               // 协议摘要（注册表给）
    transport: string,              // 'chat/completions'
    requestFields: string,          // 请求字段摘要（注册表给）
    active: boolean,                // effectiveMode === 'native' 且 providerKnown
    configured: boolean,            // 与 providerKnown 同值：这里指"服务商受支持"，不是"有 Key"
    evidence: {                     // 该协议能提供哪类证据
      structuredSources: boolean,
      inlineRefs: boolean,
      toolEvent: boolean,
    },
    offPolicy: { explicit: boolean, text: string }, // 关闭写法与"能否收回"说明
    limitsText: string,             // 该服务商的已知限制
    last: null | {
      at: number | null,
      provider: string,
      status: 'searched' | 'unknown' | 'rejected' | 'not-requested' | 'unavailable',
      kind: 'url_citation' | 'web_search' | 'inline_ref' | 'none',
      sources: Array<{ title: string, url: string }>, // 快照只留前 5 条，且不含正文
      inlineRefs: number,           // 数量，不是数组
      detail: string,               // ≤400 字符，后端说明
    },
    stats: {
      requests: number,             // 本进程启动以来产生过原生联网报告的**回合数**（一回合只 +1）
      evidence: number,             // status = searched
      noEvidence: number,           // unknown / not-requested / unavailable
      rejected: number,             // status = rejected
      lastAt: number | null,
    },
  },
  effective: 'off' | 'no-plugin' | 'needs-config' | 'on' | 'native' | 'native-needs-config',
  effectiveText: string,            // 给用户看的一句结论（后端是唯一来源）
  effectiveDetail?: string,         // 真实原因/下一步（不改变状态枚举）
  effectivePill: string,            // 界面药丸文案（后端给）
  effectiveTone: 'dim' | 'warn' | 'ok' | 'err',
  tools: string[],                  // 本回合真正可见的工具名
  stats: {
    searches: number,
    fetches: number,
    failures: number,
    cancelled: number,
    lastAt: number | null,
    lastError: { code: string, message: string, at: number } | null,
  },
}
```

`effective` 的语义（界面必须逐格显示，不许合并）：

| 值 | 条件 | 用户该看到 |
| --- | --- | --- |
| `off` | `network.enabled === false` | 联网已关闭：不发联网声明，搜索与网页读取也零请求 |
| `no-plugin` | 总闸开、`mode = api`、插件未启用 | 插件未启用，AI 看不到搜索工具 |
| `needs-config` | 总闸开、`mode = api`、插件启用但状态不是 ready / 缺 Key / baseUrl 非法 / provider 不受支持 | 缺配置；`effectiveDetail` 说明**真实原因**（不要一律说"缺 Key"） |
| `on` | `mode = api` 且条件齐备 | 搜索可用；`allowFetch: false` 时读作"搜索可用，网页正文读取已关闭" |
| `native` | 总闸开、`mode = native`、`native.providerKnown === true` | 原生联网生效：检索由服务商完成，Ling-bot 只发声明 |
| `native-needs-config` | 总闸开、`mode = native`、服务商为空/未适配 | 不发送任何联网参数，也不会退回独立搜索 |

原生两态**先于插件判定**：`mode = native` 时插件是否启用不影响 `effective`。
原生模式下 `tools` 必须是 `[]`（插件联网工具结构性隐藏）。

界面纪律：

- **只展示后端给的 `effective` / `effectiveText` / `effectiveDetail` / `effectivePill`**，前端不重新推导；
  快照缺 `network` 块时按最保守态显示，并明说"后端未提供联网状态"。
- `tools` 原样展示；总闸关或原生模式时后端给空数组，前端不得自己补。
- `native` 块原样展示；`native.last` 是后端记录的最近一次证据，不是前端推算。
  若 `status === 'searched'` 却既无 `sources` 又无 `inlineRefs`，按"无法确认"对待并提示快照自相矛盾。
- `allowFetch: false` 时，界面不得再写"搜索与网页读取都可用"。
- 密钥只显示「已保存 / 未保存」，永不出现明文。

### 6.1 服务商原生联网协议契约

这一节是**原生联网的唯一行为口径**。注册表在 `src/llm/provider-search.mjs`；
请求体合并在 `src/llm/client.mjs`；回合级证据合并在 `src/llm/agent-loop.mjs`；
快照形状在 `src/net/view.mjs`；运行状态与设置键在 `src/index.mjs`。

#### 6.1.1 服务商注册表（本轮只有两家）

| provider | 传输 | 请求字段 | 结构化来源 | 正文角标 | 联网工具事件 |
| --- | --- | --- | --- | --- | --- |
| `zhipu` | `POST /v1/chat/completions` | `tools[].type = "web_search"`，`web_search:{enable:true, search_result:true, count}` | 有（顶层 `web_search[]`；流式通常没有） | 有（`[来源：ref_N]`） | 无 |
| `openai` | `POST /v1/chat/completions` | `web_search_options:{search_context_size:"medium"}` | 有（`annotations[].url_citation`） | 无 | 无 |

`provider` 为空或未知 → 不发送任何联网参数，`providerKnown = false`、`active = false`、
`plan = null`、`effective = 'native-needs-config'`。**不得**按模型名猜、不得改用别家协议。

#### 6.1.2 请求合并规则

`LlmClient` 的 `webSearch` 是**每次请求现读**的解析器（`resolveNativeSearch(config)`）；
返回 `plan` 才带联网参数，返回 `null` 就完全不带。

`plan` 形状：

```js
{
  provider: 'zhipu' | 'openai',
  label: string,
  protocol: string,
  tools: object[],          // 要**追加**到 function tools 后面的服务端工具
  bodyPatch: object,        // 要合并进请求体的字段
  evidenceKind: 'zhipu' | 'openai',
}
```

- 智谱：`tools` 追加 `{ type:'web_search', web_search:{ enable:true, search_result:true, count:maxResults } }`；
  `bodyPatch` 为空。**不能覆盖**既有的 function tools（课程表、表情包等）。
- OpenAI：`tools` 为空；`bodyPatch` 为 `{ web_search_options: { search_context_size: 'medium' } }`。
- 合并后只要请求体里有非空 `tools`，就显式写 `tool_choice: 'auto'`；没有工具时不写
  `tools` / `tool_choice`，保持旧请求体不变。
- 传输始终是现有 Chat Completions（`stream: true`）。本轮不新增端点、不改事件模型。

#### 6.1.3 证据解析路径

每个模型请求创建一个证据收集器；每个 SSE chunk 先交给适配器（在 `choice` 判定之前，
因为智谱的顶层 `web_search` 可能出现在没有 `choices` 的 chunk 里），`finish(text)` 时
再看正文角标。解析异常被吞掉，最多导致 `unknown`，不打断整条流。

| provider | 收集位置 | 归一化 |
| --- | --- | --- |
| `zhipu` | chunk 顶层 `web_search[]`：`title`、`link` 或 `url`、`content`、`publish_date`；收尾时从正文提取 `[来源：ref_N]` | 标题截 200；摘要截 300；URL ≤2048 且通过 `validateUrlShape`（只 http/https、不带凭据）；坏条目单条丢弃；同 URL 保留第一次出现 |
| `openai` | `choices[0].delta.annotations` 或 `choices[0].message.annotations`；只认 `type === 'url_citation'`，取 `url_citation.url` / `url_citation.title` | 同上；其它 `type` 不猜、不收集 |

正文角标只认协议约定的 `[来源：ref_N]`（全角/半角冒号都认，`ref` 大小写不敏感）。
`[1]`、`[来源]`、`[来源：某网站]` 都**不算**证据。

一回合的报告形状：

```js
{
  provider: string,
  providerLabel: string,
  status: 'searched' | 'unknown' | 'rejected',
  kind: 'url_citation' | 'inline_ref' | 'none',
  sources: Array<{ title, url, snippet?, publishedDate? }>, // ≤20
  inlineRefs: string[],     // ['ref_1', ...]
  rounds: number,           // 合并时累加：带联网声明的模型调用轮数
  fallback?: boolean,       // 仅 rejected 路径带
  detail: string,
}
```

- `status`：只有 `searched` / `unknown` / `rejected` 由本轮代码产生。
  `not-requested` / `unavailable` 在快照与界面里**已定义**（脏值兜底、后续扩展），
  但本轮正常路径不主动产生。
- `kind`：`url_citation`（有结构化来源）、`inline_ref`（只有正文角标）、`none`。
  `web_search`（联网工具事件）是保留枚举，两家适配器当前都不产生。
- 有结构化来源 + 角标 → `kind = url_citation`；只有角标 → `kind = inline_ref`；两者都没有 → `unknown`。
- `sources` 报告最多 20 条；快照 `native.last.sources` 只留前 5 条，且只保留 `title` / `url`。
- `rounds` 是带联网声明的模型调用轮数，不是工具步数。

合并规则（`mergeNativeSearchReports`）：

- 状态优先级 `rejected` > `searched` > `unknown`；
- 来源按 URL 去重，保留第一次出现；
- `inlineRefs` 取并集；
- `rounds` 累加。

#### 6.1.4 `searched | unknown | rejected` 口径（重点）

| 状态 | 判据 | 禁止的写法 |
| --- | --- | --- |
| `searched` | 有结构化来源/引用，或协议规定的正文角标 | 不能把 HTTP 200、回答日期正确、模型自称联网当证据；不能因为"请求发出去了"就写成功 |
| `unknown` | 请求带了联网声明，但没有任何可验证证据 | 不能写成"联网成功"，也不能写成"搜索失败"；它同时覆盖"中转忽略参数"与"模型判断无需检索" |
| `rejected` | 上游明确拒绝联网参数（见 6.1.5），随后自动降级一次 | 不能静默改写成成功；必须让用户看到"这次没有用上原生联网" |

补充：

- `searched` 只代表"上游给了可核对的引用/角标"，**不代表引用内容可靠**；引用仍是外部数据。
- 上游返回 `200` 且没有任何引用/角标时，状态必须是 `unknown`；
- 上游返回非 2xx 但不是"明确拒绝联网参数"时，按普通模型错误处理，不产生 `unknown`/`searched`。

#### 6.1.5 拒绝判定与降级重试

只有同时满足两个条件才算"上游不支持原生联网参数"：

1. HTTP 状态码 ∈ `{400, 404, 422}`；
2. 错误文本（小写后）包含至少一个窄关键词：
   `web_search_options`、`web_search`、`enable_search`、`search_options`、
   `unknown field`、`unrecognized request argument`、`unsupported parameter`、
   `不支持的参数`、`未知参数`、`无法识别`。

典型反例（**不得**判成拒绝）：`max_tokens too large`、`messages[0] role invalid`、
`401 web_search_options`、`500 web_search_options failed`。

命中后：

- 先把错误体里已知的 LLM Key 替换成 `[REDACTED]`，再截断进错误消息/证据说明；
- 抛出的 `LlmError` 带 `code: 'E3021'`、`reason: 'native-search-rejected'`、
  `nativeSearchRejected = true`、`nativeDetail`（脱敏后的错误文本）；
- `chat()` 捕获后**自动去掉联网参数重试一次**（`plan = null`，即 6.1.6 的关闭写法），
  成功则返回 `rejectedNativeSearchReport(..., fallback = true)`：
  `status = 'rejected'`、`fallback = true`、`detail` 说明"已改用不带联网参数的请求重试一次；
  这次回答没有使用原生联网"；
- 降级请求本身失败时，抛出的是重试那次的错误；不会再退回原始拒绝错误；
- 降级只有**一次**；它不改变既有的连接类重试策略（`maxRetries` 仍按原逻辑生效）。

普通 400 不触发降级，原样报错——把普通 400 当成"不支持联网"会掩盖真正的问题
（`max_tokens` 越界、消息顺序不对），让用户以为"关掉联网就好了"。

#### 6.1.6 关闭语义

关闭 = `plan = null`。请求体里**零联网声明**：

- 不出现 `web_search` 工具对象；
- 不出现 `web_search_options`；
- 不出现 `enable_search`；
- 也不出现 `tool_choice`（如果没有其它 function tools）。

具体到两家：

| provider | 关闭写法 | 为什么这样写 |
| --- | --- | --- |
| 智谱 | 完全不声明 `web_search` 工具 | 智谱只有声明该工具才启用联网，不声明就是协议层面的关闭。协议里另有 `web_search.enable = false`，但它要求发送一个非标准工具对象，可能被非智谱中转拒绝，所以关闭时选择**完全不声明**。 |
| OpenAI | 不发送 `web_search_options` | Chat Completions 没有"关闭联网"字段；不发这个字段就是协议定义的关闭方式。 |

契约明确：**以上都是"我们不再发送声明"，不是"服务商一定没有检索"**。
服务端是否仍自行检索、中转是否忽略/缓存过参数，Ling-bot 无法验证；不得表述成
"关闭后服务商绝对不会检索"。

补充边界：

- 关闭只能作用于**之后**的请求；已经发出的模型请求里的声明收不回来。
- 独立搜索的在途请求会被立即 abort（`E4070`）；原生联网没有对应的"在途撤回"。
- 原生联网不使用 `plugins.config['web-search']` 的 Key；它走聊天模型那条请求与 Key。

#### 6.1.7 工具可见性（避免重复消耗）

原生模式下，插件联网工具必须**结构性不可见**，而不是"看得到但调用失败"：

- `buildNetView`：只有 `effective === 'on'` 才返回工具名；原生两态 `tools = []`。
- `disabledNetTools`：总闸关或 `effectiveMode === 'native'` 时，返回
  `['plugin_web_search', 'plugin_web_fetch']`，由回合策略合并进 `disabledTools`。
- 两处是同一判定的两层落地：快照有轮询间隔，回合级判定防止快照滞后时模型仍看到工具；
  改一处必须同时改另一处。
- 插件注册表本身仍保留两个工具（与 `allowFetch: false` 的处理一致），
  但模型可见性由上述两层保证；不要宣传成"插件里已经不存在这个工具"。

原生模式与独立搜索**不默认同时执行**：原生不需要、也不使用搜索服务商那把 Key；
一次提问不应该产生两份检索与两份来源。

#### 6.1.8 生效范围、预算与时序

- 原生声明**随每一次模型请求发出**，包括群聊、私聊、主动回合，以及一回合内工具循环的每一轮。
  它不是 `needs: host` 工具，不经过 `owner-private` / `console` 的来源过滤，
  也不经过工具授权与人工确认。
- 因此它没有 QQ 聊天里的开关：正常入口只在桌面端《插件设置 → 联网搜索》（或手改配置），
  开启后所有来源的模型请求都会带声明，可能产生额外检索与费用
  （计费规则由服务商决定，本轮未验证）。
- 原生检索发生在**那一次 chat 请求内部**：同时受回合 30 秒硬预算与
  `llm.timeoutMs`（默认 120000 ms）约束。慢检索可能先表现为回合截断/超时，
  而不是一条独立的搜索失败；此时不能补记 `searched`。
- 关闭总闸时：正在进行的 model 请求无法撤回其已带声明；下一次请求起不再带。
  这与独立搜索"在途立即 abort"是两个不同的边界，文档与界面都必须分开写。
- 拒绝路径会先把已知 LLM Key 脱敏；但快照里的 `native.last.detail` 仍可能含上游错误文本的其余部分，
  不能宣称"绝无任何上游回显"。

#### 6.1.9 验收清单（本地模拟，不联网、不花钱）

`test/provider-native-search.test.mjs` 必须覆盖（当前 21 个用例）：

1. 三态解析：关 / 独立 API / 原生，且总闸优先（关着绝不 `active`）；
2. `provider` 为空或未知 → 不 active、`plan = null`、不按别家协议发送；
3. 老配置通过校验，默认仍是 `mode = api`、`native.provider = ''`、`maxResults = 5`；
4. 非法 `mode` / `native` 形状 / `maxResults` 越界 → 校验硬失败，不静默降级；
5. 智谱请求体含 `tools[type=web_search]`，`enable/search_result` 为 true，`count` 取配置上限，
   且保留既有 function tools；
6. OpenAI 请求体含 `web_search_options`，且不追加 `tools`；
7. 关闭 / 独立 API / 未适配服务商 → 请求体零联网声明，且 `webSearch = null`；
8. 智谱 200 + 正文 `[来源：ref_1]` → `searched` + `kind = inline_ref`，`sources = []`
   （不假装拿到结构化来源）；
9. 智谱 chunk 顶层 `web_search[]` → 结构化来源；坏 URL 单条丢弃；
10. OpenAI 200 但无 `annotations` → `unknown`，绝不记成功；
11. OpenAI `delta.annotations` 的 `url_citation` → `searched` + 结构化来源；同 URL 去重，
    只认 http(s)、拒绝带凭据 URL；
12. 正文角标只认 `[来源：ref_N]`，不误认 `[1]` / `[来源]`；
13. 拒绝判定只认 400/404/422 + 窄关键词；普通 400 与 5xx 不算；
14. 明确拒绝 → 自动去掉联网参数重试一次，返回可读答案 + `status = rejected` +
    `fallback = true`；
15. 普通 400 不重试、不吞错误原因；
16. `agent-loop` 跨多次模型调用合并证据（`rounds` 累加，最终结果带出）；
17. 原生模式：快照 `tools = []`，`disabledNetTools` 仍返回两个工具名；
18. 原生模式未选服务商：`effective = native-needs-config`，零工具；
19. 独立 API 模式保持旧行为：总闸开 + 插件就绪 + 有 Key → `on` 且工具可见；
20. 原生联网不改变 `text` / `reasoning` / `toolCalls` / `usage` 的既有形状；
21. 服务商注册表只包含 `zhipu` / `openai`。



## 7. 结果状态与错误码

**状态口径（最容易做错的一格）**：

- `ok: true` + `results: []` 是**合法的空结果**（上游确实没有匹配内容）；
- HTTP 200 但 JSON 非法 / 缺 `results` 数组 → `E4085`；
- 上游给了结果但全部 URL 不合法 → `E4085`；
- "请求成功"不等于"结果可靠"：单条坏 URL 丢弃，不连累其余，也不改写成空结果；
- **插件内层失败/取消不得记成外层成功**：executor 对 `ok:false` 的结果记
  `failed:true` 并带上真实错误码（取消是 `E4070`）；宿主的 `stats.cancelled`
  单独计数、业务失败计入 `stats.failures` 并写 `lastError`。

| 码 | 含义 | 模型该怎么理解 |
| --- | --- | --- |
| `E4080` | 联网已关闭，或该能力被配置禁用（`allowFetch: false`） | 不要重试、不要换工具绕过；如实说明无法联网 |
| `E4081` | 搜索服务未配置（无 Key / baseUrl 非法 / provider 不受支持） | 告诉用户去配置，不要编造结果 |
| `E4082` | 上游鉴权失败 | Key 失效，去检查配置 |
| `E4083` | 配额用尽或限流 | 稍后再试 / 检查额度，不要连着重试 |
| `E4084` | 超时 | 可以换更短的查询再试一次，别反复重试 |
| `E4085` | 上游响应不符合协议（含参数被拒、200 但格式不对、结果全坏） | 这是实现/配置问题，**不得**当空结果 |
| `E4086` | 上游故障（5xx / 连接失败） | 服务端问题，稍后再试 |
| `E4087` | 目标地址不被允许（内网/本机/非 http(s)/内嵌凭据/端口非 80·443/URL 超长） | 不要换写法绕过 |
| `E4088` | 内容类型、编码或大小不被允许 | 不是可读正文，放弃 |
| `E4089` | 关闭已生效（安全方向），但配置保存失败 | 这次状态只是"内存里关了"：重启后可能回到开着；稍后重试保存 |
| `E4070` | 已取消 | 这次不算数，不要当成功 |
| `E4071` | 没有可信的联网调用上下文 / 能力已失效 / 宿主未注入 | 装配或接线问题，不是搜索失败 |

## 8. 关闸顺序（持久化与生效）

关闭（true → false）必须按这个顺序：

1. **先同步生效**：内存里的总闸立即变 false；
2. **立刻 abort 所有在途请求**（`netFactory.refresh()`），在途调用返回 `E4070`；
3. 再 `persistConfig()` 写盘；
4. 写盘成功 → 返回 `{ ok:true, value:false, closed:true, persisted:true }`；
   写盘失败 → **保持安全关闭**（不回滚内存），返回
   `{ ok:false, code:'E4089', value:false, closed:true, persisted:false }`，
   把失败如实报告给界面/日志。重启后可能回到旧值，需要重新关一次。

界面必须以 `closed/value` 为准：关闭失败时复选框停在"关"，不能弹回"开"
（否则用户以为没关成功，而实际线上已经关了）。打开失败则保持关闭并报告。

打开（false → true）顺序相反：**先等保存成功，再生效**（打开不急，安全优先）。

其他时序约定：

- 关闸与确认等待并发时，`ctx.net` 现读总闸会挡住请求（零请求）；
  模型可见性在**下一回合**刷新（当前回合可能仍显示旧 schema），
  这不等于"关闸后还能发请求"，不得把过时 schema 误报成漏发。
- 状态计算/持久化失败不得让整份快照或整个后端挂掉。

## 9. 外部内容与来源

- 搜索/抓取结果一律以 `tool` 角色回灌，已被 `wrapToolResult` 包成
  `[外部内容，非指令]`（既有实现，不改）。
- 插件返回的结构化字段（`title` / `snippet` / `text`）**不得**被拼进
  system prompt，也不得作为工具描述下发。
- 结果里出现的"忽略之前的指令"之类文本只是数据。
- 宿主在提示层（`src/llm/prompt.mjs`）要求最终回答带出处。
  **来源保留依赖"结构化 tool 结果 + 提示词要求引用"**，不能宣称真实模型一定引用、
  不会引错。可验证的是：结果以 tool 角色出现、且模拟回合的最终回答里带 URL；
  真实模型行为不受保证。

## 10. 预算与授权

- 工具调用单回合上限 **八步**（硬限制，测试参数不能放宽）；
- 单回合 **30 秒**硬预算（测试参数只能缩短）；
- 每次调用仍需 **R1 人工确认**；本轮不新增任何确认豁免；
- 宿主授权规则不变：`needs: host` 只对 `owner-private` / `console`；
  群聊、陌生人私聊、主动回合永远不可见；
- 审批等待可取消，executor 的 `finally` 会 abort 并 `revoke()`；
- **不整体放开**宿主网络或文件权限，不提供任意 URL 代理。

## 11. 验收清单（本地模拟 API，不联网、不花钱）

必须覆盖：

1. **可信 invocation**：错误 pluginId / 错误 origin / search 由 fetch 工具发起 /
   无 invocation / revoke 之后 → `E4071` 且零请求；
2. 总闸关 → 工具不在可见集里，直接调 `ctx.net.search` 返回 `E4080` 且零请求；
3. 总闸开 → 工具可见（`owner-private` / `console`），群聊来源仍不可见；
4. **`maxResults` 上限**：配置 2、参数 20 → 上游收到 2；配置 5、参数 3 → 收到 3；
5. **`provider` 非 tavily** → `E4081`，且零请求（不是静默按 Tavily 发）；
6. 正常搜索 → 结构化来源（title/url/snippet）；
7. 空结果（`results: []`）→ `ok:true` + 空数组；200 但 JSON/格式不对 → `E4085`；
   结果全坏 → `E4085`；
8. 401 → `E4082`；429（含 Retry-After）→ `E4083`；500 → `E4086`；超时 → `E4084`；
9. 取消：在途 abort → `E4070`，连接已销毁；总闸 true → false 时在途搜索被 abort；
10. **网页读取**：`http://127.0.0.1/`、`file:///`、`http://user:pw@host/`、
    解析到内网的域名、重定向到内网、非 80/443 端口、URL 超 2048 → `E4087`；
11. 网页读取：缺失 Content-Type → `E4088`；`application/octet-stream` → `E4088`；
    超 wire 与超 decoded 都截断且 `truncated: true`；多重/未知 Content-Encoding 拒绝；
    总时限覆盖 DNS；取消/截断后连接销毁；
12. 日志、快照、统计、工具结果里不出现 Key 明文（含 URL 编码与 JSON 转义形式）；
13. 插件内层失败/取消被执行链标成失败/取消（不记成功）；
14. `allowFetch: false`：快照 `tools` 不含 `plugin_web_fetch`，`fetch` → `E4080`，
    界面文案为"搜索可用，网页正文读取已关闭"；
15. 假 LLM 回合：来源以 tool 角色进入上下文，最终回答带 URL；
16. 快照 `effectiveDetail` 能表达真实未就绪原因（崩溃/加载失败/Key 解不开）；
17. 关闸写盘失败（模拟 `save` 抛错）：返回 `E4089`、`closed:true`、`persisted:false`，
    内存保持关闭，界面复选框停在"关"。
18. **界面位置**：侧栏不再有 `web-search` 页（页面数 15）；《插件设置》选中
    「联网搜索」插件后，在插件列表与详情之间渲染宿主级联网区块；没选中时不穿插；
    `app.mjs` 不再 import `renderWebSearch`。

## 12. 验证状态

只写实际执行过的命令与结果；其余以仓库既有记录与 Lead 的最终报告为准。

### 本轮实际执行

| 命令 | 结果 |
| --- | --- |
| `node test/provider-native-search.test.mjs` | **21 通过 / 0 失败**（本地 `127.0.0.1` 假 SSE/HTTP；无真实 Key、无外网） |
| `node test/web-search-page.test.mjs` | **45 通过 / 0 失败**（三态模式、服务商选择、证据五态、关闭控制范围、并入插件页挂载） |
| `node test/ui-shell.test.mjs` | 92 通过 / 0 失败（页面数已改为 15，无 inline style 断言未改） |
| `node test/web-search.test.mjs` | 41 通过 / 0 失败 |
| `node test/web-search-security.test.mjs` | 14 通过 / 0 失败 |
| `node test/agent-loop.test.mjs` | 14 通过 / 0 失败 |
| `node test/frontend-contracts.test.mjs` | 28 通过 / 0 失败 |
| `node scripts/verify-web-search.mjs`（真实本地 HTTP） | 65 通过 / 0 失败 |
| `node test/web-search-plugin.test.mjs` | 23 通过 / 0 失败 |
| `node test/web-search-plugin-state.test.mjs` | 5 通过 / 0 失败 |
| `node test/web-search-integration-hardening.test.mjs` | 12 通过 / 0 失败 |
| `node test/web-fetch-hardening.test.mjs` | 15 通过 / 0 失败 |

### 仓库既有记录（本轮未重跑）

| 命令 | 结果 |
| --- | --- |
| 相关回归（plugin-host-contract / plugin-runtime-parity / plugins-core / tool-gate / builtin-plugins / capability / plugin-chat-media） | 本轮实际复跑合计 151 通过 / 0 失败 |

宿主级搜索/插件/硬化测试与 `node scripts/verify-web-search.mjs` 的最终数字，
**以 Lead 的最终报告为准**。环境限制：受限沙箱下子进程/DPAPI 相关步骤可能
EPERM 或不可用（`confirm.test.mjs` 的 7 条用例因 `spawn EPERM` 未能执行，
`scan-secrets.mjs` 因 `git EPERM` 未能执行），不能据此宣称"加密存取已实测"
或"已联网验证"。

**未测项**：未调用真实智谱 GLM / OpenAI，未使用真实 Key，未发 QQ 消息；
真实流式是否返回智谱 `web_search[]` 或 OpenAI `delta.annotations` 未验证；
群聊/主动回合"声明随每次模型请求发出"来自代码路径核对，未在真实会话观测。
