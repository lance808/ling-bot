# Ling-bot

一个**独立的** QQ 机器人桌面端：只借 SnowLuma 的 QQ 进程注入能力，不依赖 DeepSeek Harness。

> 当前 **P1–P3 已完成并对真实 SnowLuma 联调通过**：能收、能发、能思考、能调工具。
> P4 打磨中（打包、更多工具）。进度见下方「当前进度」。

---

## 三种启动方式

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| **双击 exe** | `npm run bundle:desktop` 生成 `dist/Ling-bot/Ling-bot.exe`，之后双击即可 | 日常使用 |
| 开发运行 | `npm start` | 开发调试（自动构建并启动桌面壳） |
| 只跑后端 | `npm run backend` | 纯 Node 下跑回归 |

**桌面壳做什么**：Tauri 2 负责窗口、托盘与单实例；它拉起 Node 后端进程，
并通过 stdin/stdout 上的 JSON-RPC 转发界面的请求。

后端脚本和 Node 运行时随包一起分发，**目标机器不需要预装 Node**。

> 打包产物含一份 Node 运行时，整包约 94 MB。


---

## 三句话说明它是什么

1. **唯一的 QQ 注入面来自 SnowLuma** —— 它把原生组件注入 QQ 客户端进程，对外暴露 OneBot v11。
   Ling-bot 只是 OneBot 的**客户端**，自身**没有任何注入面**，不写 DLL、不碰 QQ 进程内存。
2. **不往 DSH 里装任何东西** —— 不写 `cordis.patch.yml`、不注册 bundle、不生成 agent preset、不挂 MCP。
   AI 大脑直连 OpenAI 兼容接口。
3. **桌面端用 Tauri 2，不用 Electron** —— 窗口/托盘由 Rust 承担，界面走系统 WebView2，
   后端仍是纯 Node 进程。这样安装包更小、启动没有额外控制台窗口、
   任务栏图标由安装包资源直接决定，不再受 Electron 宿主身份影响。

---

## 当前进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| **P0 骨架** | ✅ 完成 | Tauri 窗口 + 托盘 + 单实例、后端进程守护、stdio JSON-RPC、**扩展骨架**、**权限模型** |
| **P1 收消息** | ✅ 完成 | 自实现 OneBot 11 客户端、事件归一化、上游健康三态。**已对真实 SnowLuma 联调通过**（收：`group:<测试群号>` 实测） |
| **P2 发消息** | ✅ 完成 | 唯一发送闸门（白名单 + 出站审计 + 限流）。**真实投递验证通过**（`message_id` 已返回） |
| **P3 接大脑** | ✅ 完成 | 提示三层、流式 SSE、8 步/30 秒工具循环、R2/R3 人工确认（fail-closed）、概率唤醒三重护栏、用量记账（主动支出单列） |
| P4 打磨 | 🚧 进行中 | 打包、人格卡 CRUD、更多工具 |
| P5 扩展功能 | ⬜ 待做 | 语音、表情包、群管理、Qzone（架构已留口） |

当前自检规模：**438 个单测 + 16 项静态检查 + 启动自检 + 两套端到端**。

```bash
npm run verify:node    # Node 版本基线（>= 24.22 < 25）
npm test               # 438 个单测
npm run check          # 16 项静态检查（含 I15–I18 安全不变量）+ 单测
npm run smoke          # 启动自检（后端 + JSON-RPC + 闸门行为）
npm run live           # 真实端点只读联调（需参数：ws url + WS token）
npm run e2e:llm        # 真实 HTTP+SSE 路径（本地假上游，不烧 token）
npm start              # 构建并启动桌面端
npm run bundle:desktop # 生成可分发的 dist/Ling-bot
```

> `npm run live` 的 token 要从 `D:\SnowLuma\config\onebot_<QQ号>.json` 的
> `networks.wsServers[0].accessToken` 取 —— **HTTP 与 WS 是两个不同的值**，别混用。

---


## 版本基线

| 组件 | 版本 | 备注 |
| --- | --- | --- |
| **SnowLuma** | **2.0.0** | 唯一 QQ 接入端；装于 `D:\SnowLuma` |
| **Node.js** | **24.22.0** | SnowLuma 2.0.0 要求 `>=24`；也是随包分发的运行时 |
| **npm** | **11.19.1** | 随 Node 24 一同升级 |
| **Tauri** | **2.x** | 桌面壳；Windows 上用系统 WebView2 渲染 |
| **Rust** | **stable（MSVC）** | 编译桌面壳，需 VS 生成工具提供链接器 |
| **OS** | Windows x64 | 开发机 AMD64 |

> ⚠️ **Node 必须 ≥ 24**。`engines` 不匹配时 npm 只警告不阻断，会埋下「构建过、运行炸」的隐患。
> 项目级 Node 请锁 24.22.x —— 打包时会把这份运行时一起带上。

---

## 快速开始

```bash
# 前置：SnowLuma 已启动并完成 QQ 注入
# 1. 确认 SnowLuma 侧 OneBot 端口（默认 HTTP 3000 / WS 3001）
# 2. 装依赖并启动桌面端
npm install
npm start              # 开发运行（需 Rust + VS 生成工具）
npm run bundle:desktop # 或直接出一份可分发目录
```

---

## 文档

本仓库只带这一份 README。设计文档（决策记录、架构、功能编号与验收矩阵）
留在作者本地，不随仓库发布 —— 它们记录的是本地设计过程，含环境细节与
对外部项目的评价，逐一脱敏的成本高于其公开价值。

想了解设计取向，代码注释里保留了理由（本项目约定：注释解释**为什么**，
不解释做什么）。

---

## 硬边界（不可协商）

| 边界 | 说明 |
| --- | --- |
| **不打包 / 不分发 SnowLuma** | EULA §5.4 禁止复制、再分发其专有组件 |
| **不启动 / 停止 SnowLuma** | 只连它的 OneBot，不管它的生命周期 |
| **不注入 QQ 进程** | 注入是 SnowLuma 的事 |
| **不调用 SnowLuma 原生层** | 2.0.0 起原生调用全面异步化，这条路会随主版本反复断裂 |

---

## 参考与致谢

| 项目 | 链接 | 关系 |
| --- | --- | --- |
| **SnowLuma** | <https://github.com/SnowLuma/SnowLuma> | **核心依赖**：QQ 注入 + OneBot v11 服务端 |
| qq-bridge | <https://github.com/Derpyu520/qq-bridge> | 同作者的参考实现，只读借鉴设计与踩坑经验 |
| NapCatQQ | <https://github.com/NapNeko/NapCatQQ> | 同族前代，其 README 推荐 SnowLuma |
| LuckyLilliaBot | <https://github.com/LLOneBot/LuckyLilliaBot> | 同族实现，支持 OneBot 11 / Satori / Milky |
| Lagrange.Core | <https://github.com/LagrangeDev/Lagrange.Core> | 纯协议重实现路线（本项目未选） |
| dsh-im | <https://github.com/xmanrui/dsh-im> | 已评估未采用，借鉴其术语表与崩溃恢复语义 |
| AstrBot | <https://github.com/AstrBotDevs/AstrBot> | 多平台 Bot 框架，架构参考 |
| go-cqhttp | <https://github.com/Mrs4s/go-cqhttp> | OneBot 11 事实标准实现，协议参考 |

这些项目的设计取舍在本地决策记录里有详细评估，不随仓库发布。

---

## 许可与合规

本项目**不包含也不分发** SnowLuma 的任何二进制或其修改版。
使用本项目前请自行阅读 [SnowLuma EULA](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md)，
并遵守腾讯 QQ 的用户协议与当地法律法规。
