# Ling-bot

Ling-bot 是面向 Windows 的 QQ 机器人桌面端。它通过 SnowLuma 提供的 OneBot v11 WebSocket 接收和发送 QQ 消息，直接连接 OpenAI 兼容模型接口，并提供会话查看、人格与角色设置、工具权限、用量和日志界面。

日常 QQ 对话不依赖 DeepSeek Harness（DSH）。需要从 QQ 审批或指挥 DSH 时，可以单独启用内置桥接插件。

## 项目结构与已实现功能

```text
QQ 客户端 ←→ SnowLuma / OneBot v11 ←→ Node.js 后端 ←→ 模型服务
                                       ├─ stdio JSON-RPC ←→ Tauri 2 / WebView2 界面
                                       └─ 可选本地 HTTP 桥 ←→ DSH 侧插件
```

Tauri 负责窗口、托盘、单实例和后端进程管理；Node 后端负责连接、消息、模型调用与权限判定。Ling-bot 自身不实现 QQ 注入，QQ 接入由单独安装的 SnowLuma 完成。

| 功能 | 当前实现 |
| --- | --- |
| 模型连接 | DeepSeek、OpenAI、Moonshot、硅基流动的地址预设，以及自定义 OpenAI 兼容地址；实际请求以保存的地址为准。 |
| 模型选择 | 请求服务商的 `GET /models`，从返回目录选择模型；目录读取失败、为空或缺少目标模型时，可以手输模型 ID。不会用内置模型目录冒充上游结果。 |
| 连接与能力测试 | “测试连接”发送真实文本对话请求；“探测模型”分别测试读图与生图能力，区分支持、不支持和未得到结论。 |
| 对话 | 流式内容在桌面端展示，完成后一次性发到 QQ；支持中止回合和多轮工具调用。私聊、群内 @、叫名字及配置的关键词可触发回复。 |
| 主动参与 | 群消息到来时按概率判断是否接话，并检查近期活跃、发言间隔与频率；主动回合用量单独统计。默认开启，可在配置中关闭。 |
| 人格与角色 | 两套独立卡片，支持新建、修改、复制、删除和切换；可设全局默认，或绑定某个群、某个私聊。内置行为规范只读。 |
| 会话 | 群聊、私聊分组查看本次运行收到的消息；手动发送文本或本机图片、视频、语音、文件，单文件上限 100 MB。媒体实际投递能力取决于 SnowLuma 和 QQ。 |
| 工具与权限 | 内置 `fs_list`、`fs_read` 只读工具；按来源、风险等级、允许目录和人工确认规则筛选工具。工具页展示当前注册项及可用来源。 |
| 插件 | 从用户数据目录加载显式启用的插件；提供启停与加载状态。随包内置 `dsh-bridge`，另有 `echo` 示例。 |
| DSH 桥接 | 转发审批与提问、接收管理员私聊指令、查看待审批项，并将 DSH 回复送回管理员私聊。需要 DSH 侧兼容插件。 |
| 运行观察 | 连接状态、环境体检、用量查询、工具调用记录、日志，以及上游返回的 reasoning 内容展示、按日归档和导出。 |
| 桌面操作 | 托盘显示窗口、重连 QQ、重启后端、退出；后端异常退出后有限次退避重启。关闭窗口只隐藏到托盘。 |

图像能力探测不代表 QQ 对话已接入自动读图或生图流程。当前常规模型对话按文本上下文组装；手动发送媒体与模型能力探测是独立功能。好友与加群请求目前只记录，不自动同意；也没有完整的群管理、Qzone 或语音识别/合成功能。

## 运行前提

- **Windows x64**：当前桌面运行与打包流程以此为目标。其他平台的下载选项不代表完整桌面支持。
- **Node.js 24.22.x**：项目基线见 [.nvmrc](.nvmrc)，[package.json](package.json) 和版本校验接受 `>=24.22.0 <25`。源码运行和构建时先执行 `npm run verify:node`；便携分发目录会带上打包时正在使用的 Node。
- **Microsoft Edge WebView2 Runtime**：桌面界面依赖系统 WebView2。没有时从 [Microsoft 官方页面](https://developer.microsoft.com/microsoft-edge/webview2/)安装 Evergreen Runtime。
- **QQ 与 SnowLuma**：需要真实收发 QQ 时另行安装和配置。请使用 SnowLuma 支持的 QQ 版本，并按其说明完成登录、注入和 OneBot 启用。
- **模型服务与 API Key**：需要可访问的 OpenAI 兼容 Chat Completions 接口。各服务对 SSE、工具调用、模型目录和图像接口的支持并不完全相同。

编译桌面壳还需要 [Rust MSVC 工具链](https://www.rust-lang.org/tools/install)和带“使用 C++ 的桌面开发”组件的 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)。具体 Windows 构建依赖可参考 [Tauri 官方前提说明](https://v2.tauri.app/start/prerequisites/)。仅运行已经构建好的 exe 不需要 Rust。

## 选择启动方式

| 方式 | 操作 | 需要什么 |
| --- | --- | --- |
| 仓库根目录 exe | 双击 [Ling-bot.exe](Ling-bot.exe) | 保留完整仓库目录，安装 Node 和 WebView2；不用现场编译 Rust。 |
| 开发启动 | `npm start`，或 `npm run dev` | Node、Rust MSVC、C++ 构建工具和 WebView2；脚本先构建 debug 壳，再启动。 |
| 便携分发目录 | `npm run bundle:desktop` 后运行 `dist/Ling-bot/` 内的 exe | 构建机需要上述编译工具；目标机需要 WebView2，Ling-bot 后端使用随包 Node。 |
| 仅后端 | `npm run backend` | Node；不打开桌面窗口，供调试 stdio JSON-RPC 使用。 |

根目录 exe 只是桌面壳，不能单独拷走使用：后端来自仓库中的源码目录，Node 默认从 `PATH` 查找，也可用环境变量 `LING_NODE` 指定。它不会在启动时重新编译界面和 Rust 代码。修改源码后，开发时使用 `npm start`；要更新根目录 exe，执行 `npm run build:root-exe`。

在仓库根目录执行：

```powershell
npm run verify:node
npm install
npm start
```

当前 Node 后端没有 npm 第三方运行依赖；首次运行的数据目录和内置插件由程序初始化，`npm install` 本身不承担这项工作。

生成便携目录：

```powershell
npm run verify:node
npm run bundle:desktop
```

分发时复制整个 `dist/Ling-bot/`，保留 exe、源码、插件和 `runtime/` 等内容。该脚本目前**只组装免安装目录**，不会自动产出 NSIS 安装包；也不包含 QQ、SnowLuma 或 WebView2。它复制当前 Node 可执行文件，因此应在 Windows x64、符合基线的 Node 环境下打包。开发和便携脚本目前按默认的 `desktop/target/` 位置查找构建结果；设置自定义 `CARGO_TARGET_DIR` 可能导致找不到产物。

“便携”指应用文件可整体移动，用户数据仍写入系统应用数据目录，不随 exe 放置。

## 首次配置

### 1. 接通模型

打开“模型设置”，依次完成：

1. 选择提供商或“自定义第三方”，填写并保存接口地址。常见形式为服务商域名或以 `/v1` 结尾的 API 地址；客户端会补齐 `/chat/completions` 与 `/models`。
2. 输入 API Key，点击“保存 Key”。
3. 点击“读取模型列表”，选择目标模型；服务商不提供目录或目录为空时，手输其文档中确认可用的模型 ID。
4. 点击“用这个模型”保存，再点击“测试连接”，确认当前地址、Key 和模型能完成文本对话。
5. 如需了解图像能力，再点“探测模型”。测试连接和能力探测都会发真实请求，可能计费；能力探测成功不替代文本连接测试。

更换地址、Key 或模型后需要重新验证。“未测”与“不支持”不同；目录为空时应检查服务商的令牌分组、模型权限和接口地址，也可继续手填模型。

API Key 的读取优先级为：`LING_LLM_KEY` 环境变量 → DPAPI 保险箱 → 旧配置中的明文 `llm.apiKey`。通过界面保存时，Key 加密写入用户数据目录下的 `secret.vault`，同时清除配置中的旧明文 Key。环境变量存在时仍优先使用环境变量，界面清除本地 Key 不会移除启动环境里的值。

保险箱使用 Windows DPAPI `CurrentUser`，依赖 Windows PowerShell；无法使用 DPAPI 时，界面保存会报错，不会自动改存明文。换账户或迁移到另一台机器后通常需要重新填写 Key。DPAPI 不能防止以同一 Windows 账户运行的恶意程序。OneBot 和 DSH 令牌目前保存在配置中，**不属于 API Key 保险箱的加密范围**。

### 2. 接通 QQ / SnowLuma

1. 按 [SnowLuma 官方说明](https://github.com/SnowLuma/SnowLuma)安装并准备受支持的 QQ 客户端。
2. 概览的“环境体检”可检测 Node、QQ、SnowLuma，打开下载地址与本地控制台，并提供“QQ 启动”和“SnowLuma 启动”按钮。QQ 使用检测到的 `QQ.exe`；SnowLuma 在其目录执行 `node index.mjs`，优先使用该目录自带的 Node，否则使用 `LING_NODE` 或系统 Node。
3. 完成 QQ 登录与 SnowLuma 注入，在 SnowLuma 控制台启用 **OneBot v11 正向 WebSocket 服务端**。本项目作为客户端主动连接它，不是反向 WebSocket 接收端。
4. 在 Ling-bot 用户配置中填写 `onebot.wsUrl` 和对应 WebSocket 服务的 `accessToken`。默认地址为 `ws://127.0.0.1:3001`；HTTP 与 WebSocket 的令牌可能不同，应使用 `networks.wsServers` 对应项的值。
5. 重启后端，检查连接状态及 QQ 在线状态；在“安全”页添加需要参与的群和私聊白名单，再进行测试。

环境体检使用默认控制台与 OneBot 端口做 TCP 检测，端口开放只表示有服务监听，不能证明 QQ 已登录或 OneBot 鉴权正确。“SnowLuma 启动”返回成功仅表示启动进程已创建，仍需等待并检查实际连接。当前没有对应的 SnowLuma 停止按钮，也不会代替用户完成 QQ 登录。

便携包内的 Node 用于 Ling-bot 后端；启动 SnowLuma 时仍按上文规则寻找 Node。自动检测不到安装位置时，可在启动 Ling-bot 前设置 `LING_QQ_EXE`、`LING_SNOWLUMA_DIR`，或在配置中填写 `qqExe`、`snowlumaDir`。界面在未检测到 QQ 或已有手动指定路径时，也会显示 QQ 目录和 exe 选择入口。

### 3. 配置文件和参与范围

桌面端（包括开发启动的桌面壳）使用 `%APPDATA%\ling-bot` 保存用户数据。首次尚无配置文件时使用默认值；界面保存设置后写入配置。需要手工配置 OneBot 时，先从托盘退出应用，将 [config.example.json](config.example.json) 复制到该数据目录，命名为 `config.json`，再填写；若已有配置，应修改现有文件，不要直接覆盖。**仓库根目录中的同名配置不是桌面端默认读取位置。**

仅后端运行默认使用当前工作目录下的 `data/`，可通过 `LING_USER_DATA` 指定数据根目录。完整默认配置与校验规则见 [schema.mjs](src/config/schema.mjs)，示例配置只列出常用项；未知字段会导致启动校验失败。

默认 `allow.groups`、`allow.private` 为空，`allowAllWhenEmpty` 为 `false`，普通 AI 对话不会向所有群和私聊开放。黑名单优先于白名单。DSH 管理员私聊可以作为审批通知的投递目标，但仍受黑名单、出站过滤和限流约束；普通 AI 对话的参与范围仍应配置白名单。

需要调整触发词、主动发言、发送限额或工具目录时，退出后编辑相应的 `llm.keywords`、`persona.name`、`proactive`、`limits` 和 `tools.roots`，再重启。`proactive.enabled` 默认是 `true`；不希望概率接话时设为 `false`。`tools.roots` 为空时，当前启动逻辑会使用系统临时目录中的专用工作区，并不开放整个磁盘。

## 工具、权限和插件

模型看到的工具按来源与声明筛选，普通群聊和主动回合不提供宿主机工具。管理员私聊与本机控制台可使用被允许的宿主机工具；管理员身份来自 `dsh.admins`。人格文字和聊天内容不会修改这些授权规则。

内置文件工具只读，限制在允许目录中，并检查路径越界和符号链接。默认不注册通用文件写入或 shell 执行工具。R3 默认关闭；需要人工确认的操作若没有批准或等待超时则取消。具体可用项以界面的工具列表为准。

插件运行位置是用户数据目录下的 `plugins/<插件名>/`，不是仓库的出厂插件目录。安装插件后还需在“插件”页启用；宿主会推导工具来源和确认策略，R2/R3 插件工具需要额外开启危险权限。内置插件启动时会安装到用户数据目录，出厂版本变化时可能更新相应文件。

**插件不是沙箱。** 插件代码与后端处在同一 Node 进程，可使用当前账户的文件和网络权限。工具闸门约束模型通过注册工具发起的调用，不能把不可信插件变成安全代码。插件格式可参考 [echo 示例](plugins/echo/index.mjs)和[插件加载器](src/tools/plugins.mjs)。

## 可选：连接 DeepSeek Harness

普通 QQ 聊天无需此步骤。DSH 桥接默认关闭；随包 `dsh-bridge` 插件默认在启用列表中，但未打开 DSH 总开关时不启动桥接监听。

1. 在“DSH 接入”页生成共享令牌，填写允许操作的管理员 QQ、监听端口；默认端口为 `3458`，只绑定 `127.0.0.1`。
2. 需要从 QQ 下指令时填写目标 DSH 会话 ID；留空只能处理审批与提问。
3. 在 DSH 侧另行安装兼容的 `dsh-qq-bridge` 插件，填入相同 `bridgeToken`、管理员列表，并按需启用 `relayApprovals`。该 DSH 侧插件不在本仓库内，Ling-bot 不会自动替你安装。
4. DSH 侧支持端口发现时，`bridgeUrl` 可留空；否则按该插件说明配置本地地址。保存后查看应用结果，若提示监听失败或需要重启，排查端口后重试或重启后端。

桥接只接管管理员的私聊消息，不接管群聊。可发送 `/dsh <指令>`、`待审批`，或引用某条审批/提问推送回复数字选项。并发有多条待回复时应引用目标推送，避免回答错对象。审批通知目前主要发给管理员列表中的第一位。

`免打扰 30分钟` 的实际语义是**在限定时段内自动同意审批**，不是单纯静音通知；使用前应理解它会放宽人工确认。DSH 发出的指令可能真的修改文件或执行命令，其执行权限仍取决于 DSH 侧配置。

## 验证与测试命令

在仓库根目录运行。测试规模会变化，以命令输出为准。

| 命令 | 用途与影响 |
| --- | --- |
| `npm run verify:node` | 校验当前 Node 基线。 |
| `npm test` | 运行 Node 单元测试。 |
| `npm run check` | 执行静态约束检查并运行测试；不是实际 QQ 投递或模型兼容性证明。 |
| `npm run smoke` | 启动临时数据目录中的后端，检查 JSON-RPC、快照和发送拒绝行为。 |
| `npm run e2e:llm` | 使用本地模拟 HTTP/SSE 上游验证解析和工具循环，不消耗模型服务额度。 |
| `npm run live -- <wsUrl> <wsToken>` | 连接真实 OneBot，读取登录/状态/列表并短时监听事件；不发 QQ 消息，输出可能包含账号、群与事件信息。 |
| `npm run live:llm` | 真实模型的流式对话、工具调用与中断检查；读取 `LING_LLM_BASE`、`LING_LLM_KEY`、可选的 `LING_LLM_MODEL`，会消耗额度。 |
| `npm run e2e:real -- <测试群号>` | 连接真实模型与 QQ，向指定群实际投递消息；配置 `LING_LLM_BASE`、`LING_LLM_KEY`，按需设置 `LING_LLM_MODEL`、`LING_ONEBOT_WS`、`LING_ONEBOT_TOKEN`。 |
| `npm run scan:secrets` | 扫描已跟踪文件和 Git 索引中的疑似凭据与环境信息。 |
| `npm run preflight` | 发布前检查忽略规则、敏感文件、Git 历史及仓库状态等。 |

[真实端到端脚本](scripts/e2e-real.mjs)会发送群消息并消耗模型额度，运行前应确认目标群和环境变量。API Key 由环境变量传给后端，不写入配置；OneBot WS 令牌写入临时配置，正常结束时清理。不要把真实令牌写进脚本、提交记录或公开的命令输出；命令行参数也可能被本机进程查看。

## 目录与数据

| 仓库目录 / 文件 | 内容 |
| --- | --- |
| [desktop](desktop/) | Tauri 2 Rust 壳、托盘、原生对话框与 stdio 桥接。 |
| [ui](ui/) | 桌面界面，使用原生 JavaScript 模块与 CSS。 |
| [src](src/) | Node 后端入口及业务逻辑。 |
| [src/onebot](src/onebot/) | OneBot 连接、事件归一化和健康状态。 |
| [src/llm](src/llm/) | 模型客户端、触发、提示、卡片、工具循环、用量和 reasoning 展示记录。 |
| [src/guard](src/guard/) | 准入、发送过滤、限流、工具与路径授权。 |
| [plugins](plugins/) | 随包插件源与示例。 |
| [scripts](scripts/) / [test](test/) | 启动、构建、联调、发布前检查与测试。 |
| [assets](assets/) | 图标和静态资源。 |
| [config.example.json](config.example.json) | 无真实凭据的常用配置示例。 |

用户数据目录中主要包括 `config.json`（普通配置及连接令牌）、`secret.vault`（加密 API Key）、`persona.json`、`role.json`、`state/usage.jsonl`（用量账本）、`thinking/`（按日 reasoning 展示记录）、`logs/` 与 `plugins/`。复制便携目录或删除应用文件不会自动清除这些数据。

会话页目前展示内存中近期收到的消息，聊天历史及模型近期上下文不会在重启后自动恢复；不要将它当作 QQ 历史备份或完整长期记忆库。用量与 reasoning 展示记录有各自的持久化逻辑；reasoning 只来自上游显式返回的字段，并受截断、保留时间和容量限制，不代表模型全部内部过程。

## 隐私过滤与当前限制

文本发送前会检查白/黑名单、发送频率及本机路径、凭据等特征；命中过滤时整条拒发，界面和日志提供拒因。日志有脱敏处理，工具结果也会被标记为外部数据。这些是基于规则的防护，可能误拦，也可能漏掉未匹配的敏感内容。

对话上下文及获准调用的工具结果会发往你配置的模型服务。手动媒体发送的过滤对象主要是文件名等描述，**不检查文件正文、图片内容或元数据**；发送文件前仍需自行检查内容。工具路径限制也不等同于覆盖全部敏感文件的保险箱。

仓库的 [.gitignore](.gitignore) 排除了常见配置、运行数据、保险箱和构建目录；它不能删除已经进入 Git 历史的内容，也不能替代提交前检查。日志、reasoning 导出与真实联调输出可能包含对话、账号或本机环境信息，分享前应人工检查。

目前还应留意：

- `onebot.followDiscoveredEndpoint` 已出现在配置中，但当前后端没有完整的 OneBot 端点自动发现接线；应明确配置 WebSocket 地址与令牌。
- 便携构建不是安装包构建，应用自身也不提供 QQ 或 SnowLuma 二进制。安装、版本适配和登录按各自官方说明处理。
- `/models`、工具调用、读图与生图探测能否成功取决于服务商。用量缺失时部分统计使用估算；界面的 token 数不是账单承诺，也不涵盖所有独立探测请求。

## 致谢与许可说明

感谢 [SnowLuma](https://github.com/SnowLuma/SnowLuma) 提供 QQ 接入与 OneBot 服务端，感谢 [Tauri](https://tauri.app/)、[Node.js](https://nodejs.org/) 和 [Microsoft WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) 提供运行基础。项目也参考了 [qq-bridge](https://github.com/Derpyu520/qq-bridge)、[AstrBot](https://github.com/AstrBotDevs/AstrBot) 与 [go-cqhttp](https://github.com/Mrs4s/go-cqhttp) 等项目的实现思路和协议实践。

当前仓库没有独立的 LICENSE 文件；构建元数据中的许可字段不替代完整仓库授权文本。这里不额外声明开源许可证。QQ、SnowLuma、模型服务及其他第三方组件各自的许可与使用条款仍需分别查看。
