# 联网搜索（用户向）

这一页回答四件事：**有哪几种联网方式**、**怎么配**、**怎么判断它这次到底联没联网**、**关掉之后管住了什么、又管不住什么**。

> 实现契约见 [web-search-contract.md](web-search-contract.md)；
> 逐服务商的请求字段、引用路径与官方文档链接见 [provider-native-search.md](provider-native-search.md)；
> 插件接口（`ctx.net`）见 [plugin-api.md §5.3.2](plugin-api.md)。

## 1. 先看结论：三种模式

联网不是"一个开关"，而是三种**互斥的执行方式**：

```text
network.enabled = false ─────────────────► 关闭（effectiveMode = off）
network.enabled = true
  ├─ network.mode = "api" ───────────────► 独立搜索 API（Ling-bot 自己调搜索服务商）
  └─ network.mode = "native" ────────────► 服务商原生联网
                                             ├─ provider = zhipu / openai ─► 发送对应联网声明
                                             └─ provider 为空或未知 ───────► native-needs-config
                                                                              （不发送任何联网参数）
```

| 模式 | 配置 | 谁发请求、谁检索 | 模型看到什么 | 对哪些回合生效 | 用不用搜索服务商 Key |
| --- | --- | --- | --- | --- | --- |
| 关闭 | `network.enabled = false`（`mode` 保留原值） | 谁都不检索：Ling-bot 不发搜索请求，也不发联网声明 | 没有任何联网工具或字段 | 所有回合 | 不用 |
| 独立搜索 API | `network.enabled = true` + `network.mode = "api"` | Ling-bot 直接 `POST {baseUrl}/search`，检索在搜索服务商侧 | `web_search` / `web_fetch` 两个 function 工具 | 只有管理员私聊（`owner-private`）与桌面控制台（`console`） | 用（插件配置里那把 Key） |
| 服务商原生联网 | `network.enabled = true` + `network.mode = "native"` | Ling-bot 只在**模型请求体**里声明联网；检索由模型服务商在它自己的服务端完成 | 看不到可调用的搜索工具，只有请求里的服务端联网声明 | **每一次模型请求**（含群聊、私聊、主动回合与工具循环中的每一轮） | 不用（仍用聊天模型那把 Key） |

三种模式不是三个布尔开关。关闭不是一个存储值，而是总开关关掉后的**效果**；单选框里只有「独立搜索 API」与「服务商原生联网」两项。总开关关着时仍保留已选模式，下次打开按它生效。

## 2. 怎么配

### 2.1 联网模式（宿主配置）

总开关、联网模式（独立搜索 API / 服务商原生联网）与原生服务商，在桌面端
**《插件设置》页选中「联网搜索」插件**，在插件列表与插件详情之间的「联网搜索（宿主级设置）」区块里设置；
`network.native.maxResults`（智谱的 `count`）**本轮界面没有输入框**，只能手改 `config.json`（或在配置里写默认值 5）。

| 配置键 | 合法值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `network.enabled` | 布尔 | `true` | 总闸。缺省 `true` 是旧行为延续，只表示"允许"，不等于"已经联网" |
| `network.mode` | `api` / `native` | `api` | 存储的联网通道。总开关关着时它只是预设，不生效 |
| `network.native.provider` | `zhipu` / `openai` / `""` | `""` | 原生联网服务商。留空或未知值 = 不发送任何联网参数 |
| `network.native.maxResults` | 1–20 的整数 | `5` | 只对支持条数的协议（智谱的 `count`）生效 |

```jsonc
{
  "network": {
    "enabled": true,
    "mode": "api",
    "native": {
      "provider": "",
      "maxResults": 5
    }
  }
}
```

- 老配置（只有 `network.enabled`）会自动补上 `mode: "api"`、`native.provider: ""`、`native.maxResults: 5`，行为不变。
- `network.mode` 写成 `api` / `native` 之外的值会**校验失败**，不会静默当成 `api`；`native` 形状不对、`maxResults` 越界同理。
- 模式与原生服务商没有 QQ 聊天写路径：正常入口是桌面端《插件设置 → 联网搜索》（本机 IPC 的 setting 通道）；手改 `config.json` 同样会生效。
- 原生联网**不受** `needs: host` 的来源限制，也不经过插件工具授权链；它一旦生效，群聊与主动回合的模型请求也会带联网声明。

### 2.2 「实际效果」怎么读（六态）

《插件设置 → 联网搜索》的结论来自后端 `network.effective`，前端不重新推导：

| 显示 | 条件 | 含义 |
| --- | --- | --- |
| 联网已关闭 | `enabled = false` | 不发联网声明，独立搜索的 search / fetch 也零请求 |
| 插件未启用 | 总闸开、`mode = api`、插件不在启用列表 | AI 看不到独立搜索工具 |
| 未就绪 | 总闸开、`mode = api`、插件启用但没配好或没跑起来 | 调用会明确失败，不是"搜不到结果"；真实原因看 `effectiveDetail` |
| 搜索可用 | `mode = api` 且插件就绪、有 Key | 独立搜索可用（只对管理员私聊与桌面端） |
| 原生联网 | `mode = native` 且选了受支持的服务商 | 检索由服务商完成，Ling-bot 只发声明 |
| 原生联网未配置 | `mode = native` 但服务商为空/未适配 | 不发送任何联网参数，也不会退回独立搜索 |

原生两态**不看插件是否启用**：选了原生联网却仍去插件页折腾，是找错地方。

### 2.3 独立搜索 API 的配置（插件页）

1. 在《插件设置》里找到「联网搜索」（id `web-search`），点启用。
2. 在那张卡片里填：

| 配置项 | 说明 |
| --- | --- |
| 服务类型 | 本轮**只实现了 Tavily Search API**（`POST {baseUrl}/search`）。配成其它值会被**明确拒绝**（`E4081`），不会静默按 Tavily 发送。 |
| 服务地址 | 只填到域名，例如 `https://api.tavily.com`，程序自己拼 `/search`。必须 `https`；只有本机代理（`127.0.0.1` / `localhost` / `::1`）才允许 `http`。地址 ≤2048 字符，不能带查询串或 `#` 锚点。 |
| API Key | 只存进本机加密保险箱（Windows DPAPI，绑定当前 Windows 账户）。**不回显、不进日志、不进快照**。留空保存 = 保持原值。 |
| 结果条数 | 每次最多几条来源（1–20，默认 5）。模型调用时可以申请更少，但**不能超过**你配的这个上限（取两者较小值）。 |
| 检索深度 | 对应上游的 `search_depth`：`basic` / `fast` / `ultra-fast`（1 额度）与 `advanced`（2 额度）。 |
| 搜索超时 | 单次搜索总时限（1–60 秒，默认 15 秒）。 |
| 允许读取网页正文 | 关掉后快照/界面的工具列表里不再包含 `web_fetch`，调用它会被直接拒绝（`E4080`）；搜索仍可用。 |
| 网页大小上限 | 单页响应体上限（1 KB–1 MB，默认 200 KB）。压缩前（wire）与解压后（decoded）**都**受这个上限约束。 |
| 网页读取超时 | 单次抓取总时限（1–30 秒，默认 10 秒），包含 DNS、连接、重定向与正文。 |

3. 保存后插件立即重新初始化，**不需要重启后端**。
4. 回到《插件设置 → 联网搜索》看「实际效果」。

## 3. 各模式实际发送什么

### 3.1 独立搜索 API

Ling-bot 自己发 `POST {baseUrl}/search`，带 `Authorization: Bearer <apiKey>`，拿到结构化 `results` 后作为 `plugin_web_search` 工具结果回灌。请求与响应契约见 [web-search-contract.md §2](web-search-contract.md)。

### 3.2 智谱 GLM（`provider = zhipu`）

走现有 OpenAI 兼容 `POST /v1/chat/completions`，在请求体的 `tools` 里**追加**一个服务端联网工具（不覆盖既有 function tools）：

```json
{
  "tools": [
    {
      "type": "web_search",
      "web_search": {
        "enable": true,
        "search_result": true,
        "count": 5
      }
    }
  ]
}
```

- `count` 取 `network.native.maxResults`。
- 打开 `search_result` 是为了让正文出现 `[来源：ref_N]` 角标；不打开时通常没有可判定证据。
- 证据路径：正文角标 `[来源：ref_N]`（全角/半角冒号都认），或中转在 chunk 顶层返回的 `web_search` 数组（`title` / `link` 或 `url` / `content` / `publish_date`）。
- 官方流式 chunk 没有顶层 `web_search` 字段，所以本项目只发流式请求时，**通常拿不到结构化来源列表**；只有角标能算证据。

### 3.3 OpenAI（`provider = openai`）

走现有 OpenAI 兼容 `POST /v1/chat/completions`，请求体加：

```json
{
  "web_search_options": {
    "search_context_size": "medium"
  }
}
```

- 不追加任何 `tools`；`web_search_options` 是否生效取决于模型/端点是否支持联网检索。
- 证据路径：`choices[].delta.annotations[]` 或 `choices[].message.annotations[]` 里 `type = "url_citation"` 的条目（`url_citation.url` / `url_citation.title`）。
- 没有 `url_citation` 时状态只能是「无法确认」。

### 3.4 未选择 / 未适配的服务商

`provider` 为空或未知时：**不发送任何联网参数**，`network.effective` 是 `native-needs-config`，也不会按别家协议发送。协议只由你显式选择的服务商决定，**不读模型名、不做名字匹配**。

逐服务商的完整协议表（端点、流式/非流式引用路径、关闭写法、官方链接）见 [provider-native-search.md](provider-native-search.md)。

## 4. 怎么判断这次到底联没联网

### 4.1 三种证据判定

| 判定 | 含义 | 依据 |
| --- | --- | --- |
| `searched` | 这次请求有可验证的联网证据 | 结构化来源/引用（OpenAI `url_citation`、中转返回的智谱 `web_search[]`）或协议规定的正文角标（智谱 `[来源：ref_N]`） |
| `unknown` | 请求带了联网声明，但没有任何可验证证据 | 中转可能忽略了参数，也可能模型判断本次无需检索。**不是成功，也不是失败** |
| `rejected` | 上游明确拒绝联网参数 | `400/404/422` + 窄关键词；随后会自动去掉联网参数重试一次 |

`not-requested`（本次没有请求原生联网）与 `unavailable`（服务商未适配/未选择）两个枚举在快照与界面里也已定义，但本轮正常代码路径不会主动产生它们；它们主要用于脏值兜底与后续扩展。不要因为界面没出现这两态就以为契约漏了。

证据种类 `kind`：`url_citation`（结构化引用）、`inline_ref`（正文角标）、`none`（没有引用）。`web_search`（联网工具事件）是保留枚举，本轮两家适配器都不产生它。

### 4.2 哪些东西**不算**证据

- HTTP 200：只说明请求成功；
- 回答里的日期看起来是对的：可能来自训练数据、上游注入或幻觉；
- 模型自己说"我联网查了"：那是生成出来的文本。

这三样都不能证明这次真的检索过。同理，**"上游返回了来源"也不等于来源内容可靠**：引用仍是外部数据，结论要自己核对。

### 4.3 在哪里看

《插件设置 → 联网搜索》里的「服务商原生联网」部分只回显后端判定：

- 「上次联网证据」：判定、依据类型、内联引用数量、服务商、时间、后端说明 `detail`；
- 「计数（本进程启动以来）」：原生联网回合、有证据的回合、无证据的回合、被拒绝的回合、最近一次时间。这里的计数按**回合**统计，一回合内无论调了几次模型都只 +1。
- 「限制」与「关闭时的控制范围」：直接来自协议注册表。

这份记录只存在本进程内存里，重启归零。它只记状态、种类与条数，不把来源正文或用户提问写进日志。

### 4.4 多轮调用怎么合并

一回合内可能多次请求模型（工具循环）。合并规则：

- 状态优先级：`rejected` > `searched` > `unknown`；
- 结构化来源按 URL 去重，保留第一次出现的那条；
- 正文角标取并集；
- `rounds` 累加，表示这一回合里带联网声明的模型调用次数。

只要有一次调用带回引用，这一回合就算 `searched`；但只要出现过明确拒绝，就先显示 `rejected`——那意味着参数可能被丢掉过。

### 4.5 被拒绝之后

上游明确拒绝（典型是中转不认识 `web_search_options`）时，Ling-bot 会**自动去掉联网参数重试一次**，让这轮对话还能正常出答案；结果仍标 `rejected`，并说明"这次回答没有使用原生联网"。

判定刻意很窄：必须是 `400` / `404` / `422`，且错误文本里出现 `web_search_options`、`web_search`、`enable_search`、`unknown field`、`unsupported parameter`、`不支持的参数` 之类措辞。普通的 `400`（`max_tokens` 越界、消息顺序不对）照常报错，不会被当成"不支持联网"。

## 5. 控制范围：关掉之后到底管住了什么

### 5.1 管得住的部分（结构性、可验证）

关闭总开关（`network.enabled = false`）时：

- 不发送智谱的 `web_search` 工具对象；
- 不发送 OpenAI 的 `web_search_options`；
- 独立搜索的 `web_search` / `web_fetch` 调用返回 `E4080` 且零请求；
- 在途的独立搜索请求会被立即中止（`E4070`），socket 销毁。

从原生模式切到独立 API 模式时，同样**不发送任何联网声明**；此时独立搜索按插件配置正常工作，但已经发出的模型请求不会被中止，声明也收不回来。

原生模式下也**不会**同时跑独立搜索：插件联网工具在快照的 `tools` 里是空数组，回合级 `disabledNetTools` 还会再藏一次，结构性不可见；原生联网也不使用搜索服务商那把 Key。

### 5.2 管不住的部分（如实说明）

- **服务商是否仍在其服务端自行检索**：无法验证。模型可能因为自身知识、上游默认开启的检索或缓存而"看起来查过"。
- **中转是否静默忽略联网参数**：看不到。那会表现为 `unknown`。
- **已经发出的模型请求**：声明随请求一起走了，Ling-bot 收不回来，也无法要求服务商停止那一次检索。
- **QQ 网关、视觉取图、模型 API 连接、其它插件自己写的 `fetch`**：各有各的连接与限制，不在这一个开关的能力面里。

所以准确表述是：**关掉后 Ling-bot 不再发送联网声明，也不再代你发搜索请求**；不是"整个互联网被切断"，也不是"服务商一定没有检索"。

### 5.3 关闭时具体怎么写

| 服务商 | 关闭写法 | 说明 |
| --- | --- | --- |
| 智谱 GLM | 完全不声明 `web_search` 工具 | 智谱只有声明该工具才启用联网，不声明就是协议层面的关闭。协议里另有 `web_search.enable = false`，但它要求发送非标准工具对象，可能被非智谱中转拒绝，所以关闭时选择完全不声明。 |
| OpenAI | 不发送 `web_search_options` | OpenAI Chat Completions 没有"关闭联网"字段；不发这个字段就是协议定义的关闭方式。 |

两种写法都**无法验证**服务商是否仍在其服务端自行检索——这是控制范围的边界，不是实现遗漏。

### 5.4 两个"立即生效"不是一回事

- 独立搜索：在途请求会被**立即 abort**，因为请求由 Ling-bot 自己持有。
- 原生联网：只能停止"下一次再发声明"；**已经发出的模型请求里的声明收不回来**。那份请求若随后带回引用，仍会作为这次回答的证据显示。

### 5.5 范围、来源与预算

- 原生联网**一旦生效，声明会随每一次模型请求发出**，包括群聊回合、私聊回合、主动回合，以及一回合内工具循环的每一轮。它不像插件工具那样受 `needs: host` / `owner-private` 限制，也没有 QQ 聊天里的开关：正常入口只在桌面端《插件设置 → 联网搜索》（或手改配置）。
- 因此它可能带来额外的检索调用与费用（具体计费由服务商规则决定，本轮未验证）；本轮没有按来源单独关闭原生联网的开关。
- 原生检索发生在**那一次 chat 请求内部**，同时受回合 30 秒硬预算与 `llm.timeoutMs`（默认 120 秒）约束。慢检索可能先表现为"回合超时/截断"，而不是一条独立的搜索失败。
- 拒绝降级不会突破既有的模型重试策略：它只是在明确拒绝后额外发一次**不带联网参数**的请求；这次降级请求本身仍走原有的连接类重试。
- 上游拒绝的错误文本在进入错误消息/快照前，会先替换掉已知的 LLM Key（`[REDACTED]`）。但这只是脱敏，不是"绝无上游回显"：错误文本的其余部分仍可能出现在快照/日志里。

## 6. 限制与未适配清单

- **智谱流式没有结构化来源**：本项目只用流式请求。官方流式 chunk 没有顶层 `web_search` 字段，通常只能靠正文 `[来源：ref_N]` 角标；拿不到角标时只能记 `unknown`。中转若照搬非流式的 `web_search[]`，实现会收下来，但这不是官方流式保证。
- **OpenAI 取决于模型/端点**：`web_search_options` 只对支持联网检索的模型/端点生效。不支持时可能被明确拒绝（走降级），也可能被静默忽略（记 `unknown`）。哪些模型支持是服务商的事实，本项目不按模型名猜。
- **只走 Chat Completions**：本轮不新增端点。OpenAI Responses API（`/v1/responses`）的 `web_search` 工具不在本轮。
- **`maxResults` 只对智谱生效**：OpenAI 的 `search_context_size` 没有条数概念。
- **未适配/未确认的服务商**：
  - Moonshot Kimi：`$web_search` 官方标注 2026-10-20 下线；另有新版独立搜索 REST 端点，未在本轮适配。
  - 通义千问：`enable_search`，但 OpenAI 兼容协议不返回来源。
  - xAI、Perplexity、Gemini：未适配。
  - Anthropic：需要 `/v1/messages`，不是现有 Chat Completions 传输。
  - OpenAI Responses：需要 `/v1/responses` 与另一套事件模型。
  - 以上都不会被"按某家协议猜着发"；选择未适配的服务商等于不发送联网参数。
- **未验证真实服务商**：见下面的验证状态。不要根据本文档推断"真实流式一定返回 `annotations`/`web_search[]`"。

## 7. 独立搜索 API 的可见性与授权闸门

以下只针对独立搜索 API 的两个工具；原生联网不走这条链。

`plugin_web_search` / `plugin_web_fetch` 都声明 `needs: host`，因此**只在管理员私聊（`owner-private`）与桌面控制台（`console`）可见**，不会出现在群聊或主动回合里。群里任何人说一句话就能让它去访问一个 URL，那是最典型的 SSRF 入口；要放开需要先设计更小的能力面，而不是把开关拨开。

调用还要过既有授权链，本轮没有放宽：每次调用仍需人工确认（R1）、单回合最多八步工具调用、30 秒硬预算、能力按调用发放用完失效、不整体放开宿主网络或文件权限。

## 8. 独立搜索 API 的结果与错误码

`web_search` 返回结构化来源：

```json
{
  "ok": true,
  "query": "台风路径",
  "provider": "tavily",
  "count": 2,
  "results": [
    { "title": "…", "url": "https://…", "snippet": "…", "publishedDate": "…" }
  ],
  "attributionHint": "回答里请带上出处：至少写出来源标题或链接…"
}
```

`web_fetch` 返回已降级为纯文本的正文（`text`）、最终地址（`finalUrl`）与是否截断（`truncated`）。

三条口径：

- **空结果与失败是两件事**：`ok: true` + `results: []` 表示"上游确实没有结果"；HTTP 200 但 JSON/格式不对一律报 `E4085`。
- **请求成功不等于结果可靠**：每条 `url` 会再做一次形状校验；坏条目单条丢弃；全部不合法时报 `E4085`。
- **来源保留依赖"结构化 tool 结果 + 提示词要求引用"**：不能保证真实模型一定引用、不会引错。外部网页内容始终是不可信数据。

| 码 | 含义 | 你该做什么 |
| --- | --- | --- |
| `E4080` | 联网已关闭，或网页读取被配置关闭（`allowFetch: false`） | 打开总开关；网页读取还要在插件里打开「允许读取网页正文」 |
| `E4081` | 搜索服务未配置：缺 Key、地址不合法，或服务类型不受支持 | 去插件页补齐；不要编造结果 |
| `E4082` | 上游鉴权失败 | Key 失效或被撤销，换一个 |
| `E4083` | 额度用尽 / 限流 | 稍后再试或看服务商后台；不要连着重试 |
| `E4084` | 超时 | 换更短的查询再试一次 |
| `E4085` | 上游响应不符合协议（含参数被拒、200 但没有合法 results） | 地址写错或对方改了格式；**不是"没搜到"** |
| `E4086` | 上游故障（5xx / 连接失败） | 对方的问题，稍后再试 |
| `E4087` | 目标地址不被允许 | 内网 / 本机 / 非 http(s) / 内嵌凭据 / 非 80、443 端口 / URL 超长（读网页时才会遇到） |
| `E4088` | 内容类型或大小不被允许 | 缺少 Content-Type、类型不在白名单，或体积超限 |
| `E4089` | 关闭已经生效（安全方向），但配置没保存成功 | 稍后重试保存；在此之前不要依赖"重启后仍是关闭" |
| `E4070` | 已取消 | 这次不算数，不要当成功 |
| `E4071` | 没有可信的联网调用上下文，或这份能力已失效 | 装配/接线问题（不是搜索失败）；重启或查日志 |

原生联网被拒绝时复用模型错误码 `E3021`（附 `reason: native-search-rejected`），但会被自动降级一次；用户看到的最终结果通常是 `rejected` 而不是一条报错。

## 9. 网页正文读取的限制

读取只发生在公网 http(s) 地址上，并且：

- 只允许 `http(s)`，**没有"本地路径"这条通路**：`file://`、盘符、UNC 都没有实现；
- URL ≤ 2048 字符，端口只允许 80 / 443；
- 每一跳都重新做 URL 形状校验 + DNS 全量解析 + 私网判定（防 SSRF / DNS rebinding）；
- 最多跟 4 跳重定向，每跳重新校验；
- 响应体有上限（默认 200 KB），**压缩前与解压后都计数**；超出截断并标记 `truncated`；
- 只接受可读文本类型：`text/html`、`application/xhtml+xml`、`text/plain`、`text/markdown`、`application/json`、`application/ld+json`；**缺少 Content-Type 也拒绝**；
- 有总时限（默认 10 秒），**包含 DNS 解析**；
- 取消或截断时会销毁连接；
- 不带 Cookie / Authorization / Referer。

## 10. 常见误解

- **"关了总开关就等于整机断网。"** 不是。它只关 Ling-bot 的联网声明与受控搜索/网页读取；服务商侧行为、QQ 网关、视觉取图、其它软件都不受它控制。
- **"原生联网也是 `needs: host` 工具，所以群聊里不会发。"** 不是。原生联网是请求体里的声明，不是可授权工具；它一旦生效，每一次模型请求都会带，包括群聊与主动回合。
- **"关掉之后，已经发出去的那次检索也会停。"** 收不回来。独立搜索的在途请求会被立即中止，但已交给服务商的模型请求与检索无法撤回。
- **"HTTP 200 / 日期对 / 它说自己联网了，就是联网成功。"** 都不是证据。只认结构化引用、协议规定的正文角标或联网工具事件。
- **"选了原生联网，独立搜索还会同时跑一遍。"** 不会。原生模式下插件搜索工具被结构性隐藏，两层都拦。
- **"未适配的服务商会按某家协议猜着发。"** 不会。留给空或未知值就不发任何联网参数。
- **"服务商可以按模型名自动识别。"** 不会。协议只由显式选择的 `network.native.provider` 决定。
- **"默认总开关是开的，所以默认就在联网。"** 不是。插件默认不启用；原生模式默认 `mode: "api"`、`provider: ""`，默认一个联网声明都没有。
- **"Key 不下发是所有插件的通用规则。"** 不是。它只指 `web-search` 由宿主托管的那把 Key；原生联网用的是聊天模型 Key，走既有模型请求链路。
- **"搜不到就是开关坏了。"** 先看错误码或证据判定：`unknown` 是"无法确认"，`rejected` 是"参数被拒"，只有 `ok: true` + 空数组才是真的没结果。

## 11. 用本地模拟验证（不联网、不花钱）

```bash
node scripts/verify-web-search.mjs
node test/provider-native-search.test.mjs
```

- `verify-web-search.mjs` 起本地 HTTP 服务模拟**独立搜索**服务商，覆盖开关、工具可见性、来源保留、空结果、鉴权失败、限流、协议不符、超时、取消、内网/本机地址拒绝、超大响应与类型拒绝。
- `provider-native-search.test.mjs` 起本地 `127.0.0.1` 假 SSE/HTTP 上游，覆盖三态解析、两家请求字段、关闭/独立 API 模式零声明、证据解析、拒绝降级、回合合并与工具隐藏。

两个脚本都**不读取真实 Key、不发真实请求、不访问外网**。

## 验证状态

本节只写**实际执行过**的命令与结果；没跑过的不写成"已验证"。

### 本轮实际执行

| 命令 | 结果 |
| --- | --- |
| `node test/provider-native-search.test.mjs` | **21 通过 / 0 失败**（本地 `127.0.0.1` 假 SSE/HTTP；无真实 Key、无外网） |
| `node test/web-search-page.test.mjs` | **45 通过 / 0 失败**（三态模式、服务商选择、证据五态、关闭控制范围、并入插件页挂载、无密钥回显） |
| `node test/web-search.test.mjs` | 41 通过 / 0 失败 |
| `node test/web-search-security.test.mjs` | 14 通过 / 0 失败 |
| `node test/web-search-sources.test.mjs` | 3 通过 / 0 失败 |
| `node test/web-search-plugin.test.mjs` | 23 通过 / 0 失败 |
| `node test/web-search-plugin-state.test.mjs` | 5 通过 / 0 失败 |
| `node test/web-search-integration-hardening.test.mjs` | 12 通过 / 0 失败 |
| `node test/web-fetch-hardening.test.mjs` | 15 通过 / 0 失败 |
| `node test/network-toggle.test.mjs` | 10 通过 / 0 失败 |
| `node test/agent-loop.test.mjs` | 14 通过 / 0 失败 |
| `node test/thinking.test.mjs` | 41 通过 / 0 失败 |
| `node test/config-parity.test.mjs` | 17 通过 / 0 失败 |
| `node test/config-dynamic.test.mjs` | 6 通过 / 0 失败 |
| `node test/model-page.test.mjs` | 27 通过 / 0 失败 |
| `node test/frontend-contracts.test.mjs` | 28 通过 / 0 失败 |
| `node test/ui-shell.test.mjs` | 92 通过 / 0 失败（页面数已改为 15，无 inline style 断言未改） |
| `node scripts/verify-web-search.mjs`（真实本地 HTTP） | 65 通过 / 0 失败 |
| 相关回归（含 `web-search-plugin*` / `web-search-integration-hardening` / `plugin-*` / `tool-gate` / `capability` 等，除 `confirm.test.mjs` 外） | 合计 658 通过 / 0 失败 |

### 未重跑 / 受环境限制

| 命令 | 说明 |
| --- | --- |
| `node test/confirm.test.mjs` | 该文件用 `fork()` 起后端子进程；当前沙箱 `spawn EPERM`（7 条全部无法执行），**不是代码失败**。 |
| `node scripts/check.mjs` | 静态检查 18 项通过；子进程类自检（确认/分条/单测）与 `git` 凭据扫描因沙箱 EPERM 无法执行，不能据此声明凭据扫描已通过。 |

### 仓库既有记录（更早一轮，本轮未重跑）

以下数字来自仓库既有测试记录，不是本轮重新执行的：

| 命令 | 结果 |
| --- | --- |
| 相关回归（agent-loop / plugin-host-contract / plugin-runtime-parity / plugins-core / tool-gate / confirm-plugin-coexist / plugin-chat-media / builtin-plugins / config-parity / thinking） | 合计 199 通过 / 0 失败 |

### 未测项（如实说明）

- **未调用真实智谱 GLM / OpenAI**，**未使用真实 Key**，**未发 QQ 消息**；没有真实服务商账单或额度消耗。
- **真实流式是否返回结构化来源未验证**：智谱流式 `web_search[]`、OpenAI 流式 `delta.annotations` 都只按官方文档/SDK 类型与本地模拟覆盖；真实链路是否返回、返回什么形状，未验证。
- DPAPI 保险箱的真实加解密链路本轮未重测（既有存取代码未改）。
- 未启动真实 QQ 网关；群聊/主动回合"声明随每次模型请求发出"来自代码路径核对，未在真实群聊里观测。
