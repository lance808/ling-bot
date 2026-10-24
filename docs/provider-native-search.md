# 服务商原生联网协议（逐服务商）

这一页只回答一件事：**选了某个服务商之后，Ling-bot 到底往模型请求里放了什么、又从哪里读证据。**

用户向说明（三种模式、怎么配、怎么读证据、控制范围）见 [web-search.md](web-search.md)；
跨模块契约见 [web-search-contract.md §6.1](web-search-contract.md)。

## 0. 结论先行

- 本轮只适配 **两家**：智谱 GLM（`zhipu`）与 OpenAI（`openai`）。
- 两家都走**现有** OpenAI 兼容 `POST /v1/chat/completions`，不新增端点。
- 协议只由用户**显式选择**的 `network.native.provider` 决定，不读模型名、不做名字匹配。
- `provider` 为空或未知 → 不发送任何联网参数，也不会按别家协议猜着发。
- 判定"联没联网"只认协议定义的证据；HTTP 200、日期正确、模型自称联网都不算。

## 1. 协议对照表

| 项 | 智谱 GLM | OpenAI |
| --- | --- | --- |
| provider id | `zhipu` | `openai` |
| 传输 | `POST {llm.baseUrl}/chat/completions`（现有客户端） | 同左 |
| 请求字段 | `tools[]` 追加 `{type:"web_search", web_search:{enable:true, search_result:true, count}}` | `web_search_options:{search_context_size:"medium"}` |
| 是否追加 function tools 之外的 `tools` | 是（追加，不覆盖既有 function tools） | 否 |
| 流式引用路径 | 官方流式 chunk 无顶层 `web_search`；正文 `[来源：ref_N]`；中转可能照搬顶层 `web_search[]` | `choices[0].delta.annotations[]` 中 `type = "url_citation"` |
| 非流式引用路径 | 响应顶层 `web_search[]` | `choices[0].message.annotations[]` 中 `type = "url_citation"` |
| 关闭写法 | 完全不声明 `web_search` 工具 | 不发送 `web_search_options` |
| 正向证据 | 结构化 `web_search[]` 或正文 `[来源：ref_N]` | `url_citation`（`url` / `title`） |
| 反证 | 200 但没有上述任一证据 → `unknown` | 200 但没有 `url_citation` → `unknown` |
| 已知限制 | 流式通常拿不到结构化来源列表；`count` 只此一家使用 | 是否生效取决于模型/端点；不支持时可能被拒或静默忽略 |
| 官方文档 | [智谱 · 对话中的网络搜索](https://docs.bigmodel.cn/cn/guide/tools/web-search.md) | [OpenAI SDK `completion_create_params.py`](https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/completion_create_params.py)、[`chat_completion_message.py`](https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/chat/chat_completion_message.py) |

## 2. 智谱 GLM（`zhipu`）

### 2.1 请求

在既有请求体的 `tools` 数组里**追加**一个服务端联网工具：

```json
{
  "model": "<当前聊天模型>",
  "messages": [ "…" ],
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": { "name": "echo", "parameters": { "type": "object" } }
    },
    {
      "type": "web_search",
      "web_search": {
        "enable": true,
        "search_result": true,
        "count": 5
      }
    }
  ],
  "tool_choice": "auto"
}
```

字段含义：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `type` | `"web_search"` | 服务端联网工具，不是 function 工具 |
| `web_search.enable` | `true` | 只有声明该工具才启用联网 |
| `web_search.search_result` | `true` | 让检索结果参与生成；不打开时正文通常没有 `[来源：ref_N]` 角标 |
| `web_search.count` | `1–20` | 取 `network.native.maxResults`；官方范围 1–50，本项目沿用 1–20 |

合并规则：原生工具**追加**在既有 function tools 后面，不覆盖它们；合并后只要 `tools` 非空，
客户端显式写 `tool_choice: "auto"`；没有工具时不写 `tools` / `tool_choice`。

### 2.2 证据

| 位置 | 形状 | 说明 |
| --- | --- | --- |
| 流式响应 chunk 顶层 | `web_search: [{ title, link \| url, content, publish_date }]` | 官方流式 schema 没有该字段；中转若照搬，客户端会收下。**不保证出现** |
| 非流式响应顶层 | 同上 | 官方文档的非流式形状；本项目只发流式请求，正常不会走到这里 |
| 正文 | `[来源：ref_N]`（全角/半角冒号都认） | 流式下通常唯一可用的证据 |

解析口径：

- 顶层 `web_search[]` 里的 `link` 或 `url` 会做 http(s)、长度 ≤2048、无内嵌凭据的形状校验；
  坏条目**单条丢弃**，同 URL 只保留第一次出现；标题截 200、摘要截 300。
- 正文角标只认 `[来源：ref_N]`；`[1]`、`[来源]`、`[来源：某网站]` 都不算证据。
- 有结构化来源 → `kind = "url_citation"`；只有角标 → `kind = "inline_ref"`；
  两者都没有 → `status = "unknown"`。

### 2.3 关闭

不发送任何 `web_search` 工具对象。

协议里另有 `web_search.enable = false`，但发送它仍要求构造一个非标准的工具对象，
可能被非智谱中转拒绝；因此关闭时选择**完全不声明**。智谱只有声明该工具才启用联网，
不声明就是协议层面的关闭。

### 2.4 正证据 / 反证

| 类型 | 例子 | 结论 |
| --- | --- | --- |
| 正证据 | 顶层 `web_search[]` 有合法 URL | `searched`，来源入报告 |
| 正证据 | 正文出现 `[来源：ref_1]` | `searched`，`kind = inline_ref`，`sources = []`（不假装有结构化来源） |
| 反证 | HTTP 200 + 正文没有任何角标、也没有 `web_search[]` | `unknown`（中转忽略参数，或模型判断无需检索） |
| 反证 | 回答里日期正确 / 模型自称"我查了" | 不算证据 |

### 2.5 已知限制

- **流式没有结构化来源列表**：本项目只发流式请求，通常只能靠正文角标；拿不到角标时只能记 `unknown`。
- `count` 只影响智谱这一家；其它服务商没有条数字段。
- 正文角标是模型生成的一部分，可能被模型写错或省略；它只能证明"正文按协议带了角标"，
  不能证明角标对应的链接一定被访问过。

## 3. OpenAI（`openai`）

### 3.1 请求

在现有 Chat Completions 请求体里加一个字段，不追加 `tools`：

```json
{
  "model": "<当前聊天模型>",
  "messages": [ "…" ],
  "stream": true,
  "web_search_options": {
    "search_context_size": "medium"
  }
}
```

字段含义：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `web_search_options` | 对象 | Chat Completions 的联网选项；不发送就是关闭 |
| `search_context_size` | `"medium"` | 本轮固定 medium，可选项还有 `low` / `high`（未暴露为配置） |

这个字段只对**支持联网检索的模型/端点**生效。哪些模型支持是服务商的事实，本项目不按模型名猜；
不支持时上游可能明确拒绝（走降级重试），也可能静默忽略（记 `unknown`）。

### 3.2 证据

| 位置 | 形状 | 说明 |
| --- | --- | --- |
| 流式 | `choices[0].delta.annotations[]` | 只认 `type = "url_citation"`，取 `url_citation.url` / `url_citation.title` |
| 非流式 / 中转整段返回 | `choices[0].message.annotations[]` | 同上；客户端对 `delta` 与 `message` 都解析 |

解析口径：

- 其它 `type` 的 annotation 不猜、不收集；
- URL 必须通过 http(s)、长度 ≤2048、无内嵌凭据的形状校验；带凭据或非 http(s) 的条目单条丢弃；
- 同 URL 只保留第一次出现；标题为空时用 hostname；
- 没有 `url_citation` → `status = "unknown"`，不是成功、也不是失败。

### 3.3 关闭

不发送 `web_search_options`。

OpenAI Chat Completions 没有"关闭联网"字段；不发这个字段就是协议定义的关闭方式。
Responses API 的 `web_search` 工具不在本轮，不能用它的写法来推断 Chat 的行为。

### 3.4 正证据 / 反证

| 类型 | 例子 | 结论 |
| --- | --- | --- |
| 正证据 | `delta.annotations` 里有 `url_citation` | `searched`，来源入报告 |
| 反证 | HTTP 200，没有任何 `url_citation` | `unknown` |
| 反证 | 回答里出现链接，但不是 `url_citation` | 不算证据；普通正文链接不是协议引用 |
| 反证 | 模型自称"我联网查了" | 不算证据 |

### 3.5 已知限制

- 依赖模型/端点支持；不支持时可能是 `unknown`（静默忽略）或 `rejected`（明确拒绝，自动降级一次）。
- 只有 `search_context_size` 一个可调项；没有条数、站点、时间范围等参数。
- Responses API（`/v1/responses` 的 `web_search` 工具）需要另一套端点与事件模型，**本轮不做**。
- 引用内容仍是外部数据，`searched` 不代表来源可靠。

## 4. 公共证据判定

两家共用同一套报告与状态：

| 状态 | 判据 |
| --- | --- |
| `searched` | 有结构化来源/引用，或协议规定的正文角标 |
| `unknown` | 请求带了联网声明，但没有任何可验证证据（中转忽略参数，或模型判断无需检索） |
| `rejected` | 上游明确拒绝联网参数（`400/404/422` + 窄关键词），随后自动去掉参数重试一次 |

**不算证据**：HTTP 200、回答日期正确、模型自称联网、普通正文链接。
**保留枚举**：`not-requested` / `unavailable`（快照与界面已定义，本轮正常路径不产生）；
`kind = web_search`（联网工具事件）也是保留值，两家适配器当前都不产生。

拒绝判定与降级重试的完整规则见 [web-search-contract.md §6.1.5](web-search-contract.md)。

## 5. 未适配 / 未确认清单

以下服务商**不在本轮实现范围**。选择它们（或手填未知 `provider`）不会发送任何联网参数，
也不会按已有两家的协议猜着发。

| 服务商 / 接口 | 已知事实 | 为什么没做 | 当前行为 |
| --- | --- | --- | --- |
| Moonshot Kimi | `$web_search` 官方标注 **2026-10-20 下线**；另有新版独立搜索 REST 端点 | 需要另一套调用方式与响应解析；旧字段即将失效 | 未适配；不发送任何联网参数 |
| 通义千问 | `enable_search` 可开联网 | OpenAI 兼容协议不返回来源，无法判定证据 | 未适配；不发送 |
| xAI | 未确认稳定字段 | 缺少可核对的公开协议与证据路径 | 未适配；不发送 |
| Perplexity | 未确认稳定字段 | 同上 | 未适配；不发送 |
| Gemini | 未确认稳定字段 | 同上 | 未适配；不发送 |
| Anthropic | 需要 `/v1/messages` 与 Anthropic 事件模型 | 不是现有 Chat Completions 传输 | 未适配；不发送 |
| OpenAI Responses | 需要 `/v1/responses` 的 `web_search` 工具与另一套事件 | 属于"换协议"，不是"加字段" | 未做；Chat 路径仍只认 `web_search_options` |

另外，任何**中转/自建代理**都不在"已适配"名单里：同一模型名走官方、中转、自建的字段支持可能完全不同，
所以协议不从模型名推断，只看用户显式选择的 `provider`。

## 6. 验证状态

| 项目 | 状态 |
| --- | --- |
| `node test/provider-native-search.test.mjs` | **21 通过 / 0 失败**（本地 `127.0.0.1` 假 SSE/HTTP；无真实 Key、无外网） |
| 真实智谱 GLM 调用 | **未验证** |
| 真实 OpenAI 调用 | **未验证** |
| 真实 Key / 真实计费 | **未使用、未验证** |
| 智谱流式真实返回 `web_search[]` | **未验证**（本地模拟覆盖；官方流式 schema 无此字段） |
| OpenAI 流式真实返回 `delta.annotations` | **未验证**（本地模拟覆盖） |
| QQ 消息投递 | **未测试**（本轮不涉及） |

所以本文档描述的是"按官方文档/SDK 类型实现的协议与本地模拟断言"，不是"已在真实服务商链路验证"。
真实流式上游是否返回结构化来源、返回什么形状，仍需用真实 Key 实测后才能下结论。
