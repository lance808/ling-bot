# Ling-bot 联网搜索任务交接

> **历史文档（2026-10-24 上一轮）**：本文件记录的是「独立搜索 API」那一轮的交接与修补过程。
> 本轮已新增「服务商原生联网」三态；随后又按用户要求**删除独立侧栏页，把联网设置并入
> 《插件设置 → 联网搜索》插件页（插件列表与详情之间）**。当前口径以 [web-search.md](web-search.md)、
> [web-search-contract.md](web-search-contract.md) 与 [provider-native-search.md](provider-native-search.md) 为准。
> 下文出现的“不控制服务商侧检索”“联网搜索页”等表述属于当时边界，已被本轮更新替代。
>
> 最新整理：2026-10-24。用户已要求停止、换对话；所有已派发的任务代理均已结束。本文已合并最终停笔报告，删除“可能仍在写”的过时状态。
>
> **2026-10-24 后续更新：第 6 节的 A–F 已全部收口，任务已完成。最终交付与验证证据见 §11。** 下文 §1–§10 保留为历史交接记录（用于解释为什么做过这些修补），不再代表当前状态。

## 1. 下一对话先做什么

先读本文件，再核对实际代码和未提交改动，继续原任务。不要把旧回复、旧任务板的 completed 或早期测试通过当作最终验收。不要 reset、checkout、清理或覆盖用户原有改动。

- 工作目录：`D:\Ling-bot`。
- 只读参考：`D:\deepseek-harness\default-workspace\qq-bridge`，重点是工具设计和外部不可信内容处理；未修改参考项目。
- Node：v24.22.0；原生 ESM、原生 JS UI、Tauri 桌面端，无需另起 DSH GUI 或替换服务器。
- 未发现 AGENTS.md；约定主要来自[架构说明](../开发文档/ARCHITECTURE.md)、[插件接口](plugin-api.md)和既有代码。
- **不读 data/、真实保险箱或真实 Key；不做收费搜索；不发送真实 QQ 消息。** 验证仅用假 Key、本地模拟 HTTP、测试接缝和隔离临时目录。

## 2. 原任务与本轮范围

实现“关闭联网”和“独立搜索 API”两种模式，完成配置、界面、工具调用和测试。模型服务商原生联网留后续，不同时适配多家模型协议。

要求包括：

1. 搜索作为可配置插件，独立地址、服务类型、Key、超时、结果数量。
2. 使用真实协议，不猜通用 API，不伪造结果，也不用“答对今天日期”判断联网。
3. Key 用现有敏感配置存储，不回显、不进日志。
4. 关闭禁止相关新调用，并支持取消在途请求；明确开关只控制 Ling-bot 发起的受控搜索/网页读取。
5. 只在授权会话按需使用，返回标题、URL、摘要等结构化来源，最终回答能保留出处。
6. 外部内容是不可信 tool 数据，不进高权限指令。
7. 如加网页正文读取，限制 URL、DNS、重定向、响应大小、类型、时间，禁止本地路径和内网探测。
8. 不重复叠加搜索工具，不把 HTTP 成功当结果可靠。
9. 处理额度、限流、超时、空结果、格式错误、上游失败。
10. 遵守既有授权、八步上限和三十秒回合预算，不整体开放宿主网络或文件权限。

已选真实协议：**Tavily Search API**，`POST {baseUrl}/search`，`Authorization: Bearer <Key>`，请求 `query/max_results/search_depth/topic`，响应 `results[].title/url/content`。此前查阅官方[OpenAPI 文档](https://docs.tavily.com/documentation/api-reference/endpoint/search.md)，未调用真实搜索服务。

## 3. 为什么需要重新审查

模型切换前的 assistant 多次把内部推演或 XML/DSML 伪工具调用发成 final，导致任务被提前结束；设计反复变动，部分“完成”没有对应验证。旧 durable 队友中途停笔，Lead 补齐部分文件后把任务板标 completed，但随后安全审查发现测试遗漏。

本次恢复已改为以磁盘事实为准。发现了真实授权、密钥、超时、预算及网页限制缺陷，已完成一部分修补。**当前不是可直接上线的最终版本。**

## 4. 已落地的主体功能

| 范围 | 文件与实现 |
| --- | --- |
| 总闸与错误码 | [gate.mjs](../src/net/gate.mjs)，`network.enabled`；当前缺省 true，搜索插件默认不启用。这个默认是旧实现选择，不是用户强制要求。 |
| 搜索协议 | [search.mjs](../src/net/search.mjs)，Tavily 原生 HTTP/HTTPS POST、错误分类、响应大小限制、结果归一化。 |
| 网页读取 | [http.mjs](../src/net/http.mjs)，复用视觉模块的 URL/DNS/私网判定、固定已校验 IP、逐跳重定向、HTML 转文本、解压与截断；**仍有待修缺陷**。 |
| 宿主能力 | [host-net.mjs](../src/net/host-net.mjs)，`ctx.net` 工厂、总闸现读、在途 AbortController、refresh 取消、统计。 |
| 快照 | [view.mjs](../src/net/view.mjs)，network 状态、工具名和禁用列表；状态表达仍待修。 |
| 插件 | [清单](../plugins/web-search/plugin.json)、[入口](../plugins/web-search/index.mjs)、[版本标记](../plugins/web-search/.builtin-version)。第一方 `in-process + trusted`；工具名 `plugin_web_search`、`plugin_web_fetch`。 |
| 授权 | 两工具 `needs: host`、`risk: R1`、`effects: [net]`，现有规则仅 owner-private/console 可见，仍需确认；未给群聊开放宿主工具。 |
| 配置 | 插件字段 provider=tavily、baseUrl、secret apiKey、maxResults、searchDepth、timeoutMs、allowFetch、maxFetchBytes、fetchTimeoutMs。Key 复用 plugin-secrets.vault DPAPI；未配 Key 时 needs-config，不注册工具。 |
| 接线 | [index.mjs](../src/index.mjs) 的工厂、快照、setting、policy；[manager](../src/plugins/manager.mjs)、两种 runtime 和 child-runner 的 ctx.net。 |
| 界面 | [web-search.mjs](../ui/src/views/web-search.mjs)、[app.mjs](../ui/src/app.mjs)、[pages.css](../ui/styles/pages.css)：导航第16页“联网搜索”、开关、只读配置、tool.run 试搜、统计。 |
| 来源与不可信内容 | [prompt.mjs](../src/llm/prompt.mjs) 加来源规则；工具结果继续通过 wrapToolResult 以 tool 角色回灌。尚需补模拟最终回答保留来源的测试。 |
| 配套 | schema/example、builtin 插件清单、package 的 verify:web-search、[用户说明](web-search.md)、[实施契约](web-search-contract.md)、[README](../README.md)、插件接口及测试。文档有过度承诺，待统一。 |

插件已通过本次真实 edit 加入 `.gitignore` 放行：`!plugins/web-search/`。旧 final 中的伪 edit 没执行；现在 Git 可看到该目录。

## 5. 本次审查后已经修补的内容

### 5.1 Lead 已落盘，尚未完整复测

- 新增 [redact.mjs](../src/net/redact.mjs)：已知 secret 的明文、URL 编码和 JSON 转义脱敏。
- [search.mjs](../src/net/search.mjs)：包装 searchInternal 并脱敏返回值；错误 body 在提取/截断前脱敏；JSON 在 parse 前脱敏；非 JSON 错误不再回显响应前缀；含脱敏占位符的 URL 不返回为来源。
- 地址长度限制为2048；拒绝 query/hash，不再静默删除；远程 HTTP 拒绝，本机代理地址才允许 HTTP；HTTPS 可配置。
- 搜索响应增加 aborted/close/settled 处理，2xx 检查 JSON MIME；结果按 URL 去重。
- [host-net.mjs](../src/net/host-net.mjs)：显式非法地址归一后为空，不再替换成官方地址。
- [http.mjs](../src/net/http.mjs)：网页修复代理只成功加了 dns import 和严格 contentTypeOf，**其余网页修复未完成**。

这些变更后尚未重跑完整搜索测试。旧测试“baseUrl 带查询串应自动去掉”需要更新为拒绝，不能为旧断言撤销安全修补。

### 5.2 已停笔宿主修复代理的最终落盘报告

代理 `393fc4d8-06e8-4f6e-af95-c9c196cda99b` 已明确停止，后台完成通知已返回，不会继续修改或测试。它只改以下文件：

- [manager.mjs](../src/plugins/manager.mjs)：`netFactoryFor` 仅给 web-search 注入；`runtimeSecretsFor` 剥离该插件 apiKey，宿主闭包仍可用；其他插件 secrets 契约保留。
- [runtime-inprocess.mjs](../src/plugins/runtime-inprocess.mjs)：构造器防御剥离 web-search apiKey；每次工具独立取消控制器，超时真实 abort，不停用整个实例；生命周期只读事实。
- [runtime-process.mjs](../src/plugins/runtime-process.mjs)：同样剥离 apiKey，netFacts 传 allowRequests:false；父进程代发请求随单调用超时取消。
- [child-runner.mjs](../src/plugins/child-runner.mjs)：子工具超时 abort。
- [executor.mjs](../src/tools/executor.mjs)：`run(name,args,{signal,deadline})`，审批等待可取消，实时查询注册表，不退回已停用工具缓存，真实信号传给工具。
- [agent-loop.mjs](../src/llm/agent-loop.mjs)：三十秒硬预算（测试参数 budgetMs 只能缩短）、八步硬限制、每次模型请求重新取工具列表；不合作的 LLM/runner 也结束等待。
- 新增 [web-search-integration-hardening.test.mjs](../test/web-search-integration-hardening.test.mjs)，文件已在本次重新整理时确认存在，含12个测试。

代理**没有改** index/net/plugin/ui/docs。其最终测试结果见§7；Lead没有在代理停笔后重复跑全套。

## 6. 尚未完成的问题：下一对话按此继续

### A. 宿主调用鉴权与配置上限

manager 限定插件只是第一层；[host-net.mjs](../src/net/host-net.mjs) 目前仍不核验可信 invocation，只检查总闸和 allowRequests。下一步应：

- 限 pluginId=web-search。
- 限可信 origin=owner-private/console。
- search 仅对 invocation.tool=plugin_web_search，fetch 仅对 plugin_web_fetch；生命周期或无 invocation 不发请求。
- 不新增确认豁免，继续走 executor 既有 R1 授权。
- 调用结束后保存的能力应失效；结合 executor finally abort 和 runtime signal 验证。
- 直接测试工厂的旧测试要填可信 invocation，不能为迁就测试允许缺上下文。

已复现 cfg.maxResults=2、模型参数20时，上游收到20。需 `min(配置上限, 参数, 协议上限)`，参数只能减少数量。provider 未知目前仍执行 Tavily，需明确拒绝。configured 目前只看 Key，要同时看协议/地址合法。allowFetch 对脏类型的处理需明确验证。

### B. 上游 Key 回显防护

新增恶意上游 sentinel Key 测试：401/429、长错误截断、非 JSON、标题/摘要/URL/query、encoded Key、日志与统计。现有脱敏是补丁，不能当作已验证保证。

host-net 当前仍记录上游 query，建议移除查询正文日志；网页 fetch 的返回和错误同样要考虑已知 Key 文本回显。不要用真实 Key 测。

### C. 网页读取安全限制（仍未修完整）

[http.mjs](../src/net/http.mjs) 仍有：

- DNS await 不受整次 deadline/signal 控制，取消后晚返回可能继续发请求。
- 缺 Content-Type 猜 HTML；类型检查太晚，下载完整正文后才拒。
- 仅限制解压后字节；压缩前可持续流入。
- 截断只 destroy 解压流，res/socket 可能继续下载。
- 未知/多重 Content-Encoding、incomplete close、解码失败需正确分类。
- maxChars 硬上限仍200000，与工具说明50000不符；URL长度与端口限制未实现。

修复建议：单个总AbortController+deadline覆盖DNS与全部跳；每次await后检查取消；头部到即拒缺失/非法MIME；wire/decoded各有限制；所有结束路径销毁req/res/decoder并清监听器和timer；逻辑网页URL限制80/443与2048字符。继续复用 image-fetch 私网判定，不要放宽视觉链路规则。

本地模拟脚本的逻辑 URL 目前有随机端口；若限制端口，改成 `http://public.example/path`，只有 requestOnce 测试接缝转到本机随机端口，不能给生产加私网白名单。尚无 web-fetch-hardening 测试文件。

### D. 关闸时机与实时策略

[index.mjs](../src/index.mjs) setting 当前改内存后 `await persistConfig()` 再 `netFactory.refresh()`。落盘慢会延迟取消，失败则不refresh。关闭应先同步生效并abort，再持久化；落盘失败保持安全关闭并报告。打开可等保存成功再生效。需模拟持久化挂起/失败的测试。

executor 已实时读 registry，loop 已每轮重取 schema，**但 index.makeRunner 仍传固定 toolPolicy 对象**。仍需动态 policy getter 或 wrapper，并在确认后复查策略。

注意真实结论：确认期间关闸后，host-net 现读总闸已挡住HTTP，模拟请求增量0；不能把 stale schema 误报为“确认后关闸仍漏发HTTP”。当前问题是模型可见性过时与拒绝结果成功口径。

### E. 结果状态和界面真实性

- 插件将内层 `{ok:false,code:E4070/E4080}` 当普通结果返回，executor/trace可能记外层成功。取消应进统一取消分支，一般业务错误应正确显示/统计；避免改变其他插件合法结果约定。
- allowFetch:false时 view 文案仍称“搜索与网页读取都可用”、工具列表仍含fetch，应结构性移除并准确提示。
- 插件 crashed/error/stale 且有Key被归needs-config提示缺Key，应保留真实未就绪原因。

### F. 文档与范围说明

[用户说明](web-search.md)、[契约](web-search-contract.md)、[插件API](plugin-api.md)、[README](../README.md)需统一以下实际边界：

- 开关只管新增受控搜索/网页读取，不能声称所有外网流量都受控。模型API、OneBot、视觉以及任意Node插件自行联网不是同一条能力面。
- “Key不下发”只限web-search宿主管理的Key，不可泛化为其他插件的通用secrets契约。
- 生命周期禁止请求、超时真实取消、八步和三十秒预算要以最终代码和测试为依据。
- 最终来源保留当前依靠结构化tool结果+提示词；补假LLM回合验证来源进入tool角色且最终回答带URL，不能宣称真实模型一定引用。
- 默认network.enabled=true、插件默认关闭是旧实现决定；别无说明反复变更默认或扩大群聊权限。

## 7. 测试证据与限制

### 7.1 最新宿主修复代理报告

以下为**代理最终报告**，不是Lead停笔后再次执行：

| 测试 | 通过数量 |
| --- | ---: |
| web-search-integration-hardening | 12 |
| agent-loop | 14 |
| thinking | 41 |
| plugin-host-contract | 25 |
| plugin-runtime-parity | 18 |
| plugins-core | 27 |
| plugin-grant-wiring | 16 |
| confirm-plugin-coexist | 7 |
| plugin-chat-media | 25 |
| web-search-plugin | 21 |

Lead在暂停检查期间也曾直跑agent-loop14、tool-gate11通过。最后宿主代码的语法检查曾通过；中途编辑间隙的一次缺括号报错已不适用，不要按那个瞬时错误覆盖文件。

### 7.2 旧实现历史记录

安全审查前曾有：搜索核心41、插件21、页面15、本地HTTP verifier47通过，以及ui-shell92、frontend28等相关回归。**不代表最新search/host-net/http补丁全通过，更不代表整体完成。**

### 7.3 建议恢复后命令

先审查最终实现，再依次运行（单文件超时，不要无限全量loop）：

```powershell
node test/web-search-integration-hardening.test.mjs
node test/web-search.test.mjs
node test/web-search-plugin.test.mjs
node test/web-search-page.test.mjs
node scripts/verify-web-search.mjs
```

补网页/回显/配置/持久化专项后，跑相关回归与 `node scripts/check.mjs`。旧地址query断言应更新为拒绝；网页随机逻辑端口测试可能需调整。

环境限制：Node子进程spawn/execFileSync曾EPERM；直接 `node test/xxx.test.mjs` 可跑。聚合check的确认/分条/单测runner因spawn失败，凭据扫描因spawnSync git失败；确认/分条验证脚本直接运行曾通过。discovery测试写用户目录 `.ling-bot/bridge.json` 被拒，不可为测试扩大权限。DPAPI seal/open因spawn PowerShell受限，未读取真实vault，不能宣称加密存取已实测通过。

本地HTTP监听与请求可用，无需收费服务。backend smoke必须隔离临时数据、空Key、不发QQ；等待ready后再写stdin。PowerShell producer中的Start-Sleep会延迟启动下游node，不能用它证明post-boot快照；此前已用ProcessStartInfo控制stdin验证过未配Key/关闸状态。

## 8. 停止状态、目标和进程

**所有任务代理均已结束，不会继续写文件：**

| 代理 | 最终状态 |
| --- | --- |
| host-wirer / ui-builder（durable teammates） | inactive，旧任务板completed仅为历史记录 |
| 1760e264-3587-423c-a313-157a333ac16f（只读审查） | 已完成；只用假Key与内存模拟，不写业务文件 |
| dc92331b-4407-4adf-bd45-5ff3e7174c1b（网页修复） | 已结束；写入被沙箱拒绝，只落dns import/contentTypeOf；没写专项测试、没跑测试 |
| 393fc4d8-06e8-4f6e-af95-c9c196cda99b（宿主修复） | **已明确停笔并收到完成通知**；落盘与测试见§5.2/§7.1 |

旧后台测试作业 `pwsh-a8db72da86db422f`、`pwsh-b613744920e8461b` 均killed；本次重新整理已再查job_list，没有运行中的已知后台作业。没有新开常驻开发服务器；本地verifier和临时backend曾正常结束。

系统进程枚举Get-CimInstance被拒，不能据此承诺整个系统没有Node进程；不要结束用户未知进程。

持久目标 `goal-de487173-cad5-4aa9-85a9-ef5523214cf1` 为 **paused、revision 2、disarmed**。下一对话若继承目标，应在用户要求继续时resume，不要complete。

## 9. 工作区保护

仓库从任务开始就有大量未提交改动（管理员/视觉/分条/插件/表情/模型等），README/schema/index/runtimes/agent-loop等原本已M。没有commit、reset或回退。不能把相对HEAD的全部diff都归本网路任务。

另有非本任务文件在暂停前后出现：`plugins/dsh-bridge/index.mjs`、`src/plugins/delivery.mjs`、`test/image-generation-host.test.mjs`、`test/image-generation-protocol.test.mjs`；可能来自并行工作，**不改不删**。

本网路任务新增文件集中在：`src/net/`、`plugins/web-search/`、联网UI、新web-search测试、本地verifier和web-search文档；接线文件与用户原改动重叠，必须局部edit。

`git diff --check`此前发现session/store既有尾空格、pages.css末尾额外空行，不必为此改无关文件。旧中途SHA256已过期，已从本文移除；以最终磁盘内容为准。

## 10. 恢复顺序

1. 读取本交接，核对最新diff及上述最终宿主修复，不必再等旧代理。
2. 收紧host-net可信调用、配置上限与已知Key回显，补测试。
3. 完成网页DNS/取消/类型/压缩大小/资源销毁限制与专项本地模拟。
4. 补index实时policy、关闸立即abort、失败取消口径和界面真实状态。
5. 审查预算修复与确认链兼容性，补模拟LLM来源保留测试。
6. 同步文档和配置说明，跑实际验证并明确环境未测项，再向用户交付。**目前只交接，不算任务完成。**

## 11. 最终交付（2026-10-24，本轮已完成）

### 11.1 A–F 收口结果

| 交接项 | 最终状态 |
| --- | --- |
| A. 宿主调用鉴权与配置上限 | `src/net/host-net.mjs` 校验 invocation：pluginId=web-search、tool 精确匹配 `plugin_web_search`/`plugin_web_fetch`、origin 仅 `owner-private`/`console`；无上下文/不匹配/`revoke()` 后一律 `E4071` 且零请求。`maxResults = min(配置, 参数, 20)`，参数只能减少。`configured = Key && 合法 baseUrl && provider=='tavily'`；未知 provider 明确 `E4081`、零请求。 |
| B. 上游 Key 回显 | 错误体先脱敏再提取人话；非 JSON 不回显前缀；results 的 title/snippet/query/URL 全部脱敏，含 `[REDACTED]` 的 URL 不作为来源。日志不再记录 query 正文（只记长度），统计 `lastError` 同样脱敏。测试覆盖 401/429/500/非 JSON/URL 编码/JSON 转义。 |
| C. 网页读取限制 | `src/net/http.mjs`：URL ≤2048、端口只 80/443、DNS 受总 deadline + signal 约束（取消后晚到结果不再发请求）、头部到即校验 Content-Type（缺失即 `E4088`，不猜 HTML）、多重/未知 Content-Encoding 拒绝、wire 与 decoded 双上限、截断/取消销毁 req/res/解压流。 |
| D. 关闸时机与实时策略 | 新增 `src/net/toggle.mjs`：关闭 = 同步 commit → abort 在途 → 落盘；落盘失败保持关闭并返回 `E4089`（closed:true/persisted:false）；打开 = 保存成功后才 commit。`createToolRunner` 支持 `getPolicy`，`makeRunner` 与 index 的设置通道改为现算，同一回合关闸后下一次 `availableTools()` 立即为空。 |
| E. 结果状态与界面真实性 | manager 把插件内层 `E4070` 提升为外层失败（统一取消分支，不标 crashed、不撤工具）；executor 记录内层失败 `failed` 与真实 code；agent-loop 的 toolTrace 同步标 ok=false。`view.mjs` 增加 `effectiveDetail` 保留真实未就绪原因（crashed/error/stale 不再统一说“缺 Key”）；`allowFetch:false` 时工具列表结构性移除 `plugin_web_fetch` 并改文案。 |
| F. 文档与范围 | `docs/web-search.md`、`docs/web-search-contract.md`、`docs/plugin-api.md`、`README.md`、`ui/src/views/web-search.mjs` 已统一边界（开关只管 Ling-bot 自己发起的受控搜索/网页读取；Key 只限 web-search 宿主托管；默认 true 但插件默认不启用；仅 Tavily；八步/30 秒/R1 不变；来源保留依赖结构化 tool 结果+提示词）。 |

### 11.2 新增/更新文件

- 新增：`src/net/toggle.mjs`、`test/web-search-security.test.mjs`、`test/web-fetch-hardening.test.mjs`、`test/network-toggle.test.mjs`、`test/web-search-sources.test.mjs`、`test/web-search-plugin-state.test.mjs`。
- 更新：`src/net/{host-net,http,view,search(既有)}.mjs`、`src/index.mjs`、`src/tools/executor.mjs`、`src/plugins/{manager,runtime-inprocess,runtime-process}.mjs`、`src/llm/agent-loop.mjs`、`plugins/web-search/{index.mjs,plugin.json}`、`scripts/verify-web-search.mjs`、`test/web-search.test.mjs`、`test/web-search-page.test.mjs`。

### 11.3 验证证据（本地模拟，未联网、未用真实 Key、未发 QQ）

| 命令 | 结果 |
| --- | --- |
| `node test/web-search.test.mjs` | 41 / 41 |
| `node test/web-search-security.test.mjs` | 13 / 13 |
| `node test/web-fetch-hardening.test.mjs` | 15 / 15 |
| `node test/network-toggle.test.mjs` | 10 / 10 |
| `node test/web-search-sources.test.mjs` | 3 / 3 |
| `node test/web-search-plugin-state.test.mjs` | 5 / 5 |
| `node test/web-search-plugin.test.mjs` | 21 / 21 |
| `node test/web-search-integration-hardening.test.mjs` | 12 / 12 |
| `node test/web-search-page.test.mjs` | 15 / 15 |
| `node test/ui-shell.test.mjs` | 92 / 92 |
| `node scripts/verify-web-search.mjs`（真实本地 HTTP） | 65 / 65 |
| 相关回归：agent-loop 14、plugin-host-contract 25、plugin-runtime-parity 18、plugins-core 27、tool-gate 11、confirm-plugin-coexist 7、plugin-chat-media 25、builtin-plugins 14、config-parity 17、thinking 41 | 全部通过 |

### 11.4 环境未测/未做

- 未调用真实 Tavily 服务、未使用真实 Key（不花额度）；DPAPI 保险箱的真实加解密链路未在本轮实测（既有存取代码未改）。
- 未启动真实 QQ 网关、未发送任何 QQ 消息。
- 模型服务商原生联网（provider 侧 `web_search` / `*-search-preview`）不在本轮范围，未适配。
- 工作区仍有大量任务前既有的未提交改动；本轮未 commit、未 reset、未清理用户改动。
