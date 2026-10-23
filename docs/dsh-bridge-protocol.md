# DSH ⇄ Ling-bot 桥协议（v2）

两边各有一个插件：

| 侧 | 位置 | 角色 |
| --- | --- | --- |
| Ling-bot | `plugins/dsh-bridge` | 起回环 HTTP 端口（默认 3458），把审批/提问推给管理员私聊，把回复转成结论 |
| DSH | `dsh-qq-bridge`（`D:\deepseek-harness\default-workspace\dsh-qq-bridge`） | 在 `approval/request` / `user-questions/request` 里同时触发桌面 UI 与 QQ，先到先得 |

所有路由都是 `POST`、只绑 `127.0.0.1`、要求 `Authorization: Bearer <共享令牌>`。

## 为什么是两段式（v2）

v1 的 `/dsh/ask` 是一个长轮询：DSH 发请求后一直挂着，直到有人回答。
问题在于 **DSH 插件必须知道这次请求的编号**，才能在「桌面端先回答」时
把 QQ 那条待回复撤销掉。长轮询的响应头/响应体都要等结果，拿不到编号。

所以 v2 拆成三步：

1. `/dsh/ask` —— 登记并立刻返回编号（同时异步推送 QQ）
2. `/dsh/await` —— 用编号长轮询结果
3. `/dsh/withdraw` —— 撤销一条还没回答的待回复（桌面端已经处理了）

## 1. 登记：`POST /dsh/ask`

请求体：

```json
{
  "kind": "approval",
  "toolName": "fs_write",
  "reason": "要写入 README",
  "displayReason": null,
  "agentId": "agent-1",
  "callId": "call-1",
  "timeoutMs": 120000
}
```

`kind` 省略时按 `approval`。提问用 `kind: "question"` 并带 `questions` 数组
（形状与 DSH 的 `user-questions/request` 一致）。

响应：

```json
{ "ok": true, "id": "3" }
```

免打扰期间审批直接放行，不产生待回复：

```json
{ "ok": true, "id": null, "outcome": "allowed-once" }
```

提问一个选项都没有（纯自由输入）时同样不产生待回复 —— QQ 端没有编号可回，
硬转只会让人无从下手：

```json
{ "ok": true, "id": null, "answer": null }
```

`timeoutMs` 目前被 Ling-bot 侧**忽略**：单条等待上限由桥内固定 120 秒决定。
调用方等结果时自己的超时必须比它长（DSH 侧取 125 秒），否则会先 abort，
把「超时」退化成一个普通网络错误。

## 2. 等待：`POST /dsh/await`

请求体：`{ "id": "3", "timeoutMs": 125000 }`

响应（`status` 是唯一判据）：

```json
{ "ok": true, "status": "answered", "kind": "approval", "outcome": "allowed-once" }
{ "ok": true, "status": "answered", "kind": "question", "answer": { "answers": [ ... ] } }
{ "ok": true, "status": "timeout" }
{ "ok": true, "status": "withdrawn", "reason": "desktop" }
{ "ok": true, "status": "cancelled" }
{ "ok": true, "status": "unknown" }
```

- `timeout` 不是拒绝，调用方按 `onUnreachable` 策略处理。
- `withdrawn` 表示另一端（DSH 桌面）已经处理，QQ 这条作废。
- `cancelled` 表示 DSH 侧撤销了请求（工具执行被中止）。

## 3. 撤销：`POST /dsh/withdraw`

请求体：`{ "id": "3", "reason": "desktop" }`

响应：`{ "ok": true, "removed": true }`

效果：从待回复队列移除该编号；如果已经推送过 QQ，再发一条通知
「编号 #3 已在 DSH 桌面端处理，QQ 这条不用再回了」，避免用户重复回答。

**失败形状**：编号不在册（已经答过 / 已超时）时回 **400** +
`{ "ok": false, "removed": false, "error": "..." }`。

调用方必须把它当成**可忽略**的失败 —— 典型场景是 QQ 先答、桌面面板上
迟到的点击又触发了一次撤销。撤不掉不说明审批失败。

`/dsh/ask-question` 保留为兼容别名，语义是**旧的长轮询**（一直等到有结论，
回 `{ok, answer}`）。它不给编号，所以也无法撤销；新调用方请走
`/dsh/ask` + `/dsh/await`。

## 4. 双通道判定（DSH 侧）

`approval/request` 与 `user-questions/request` 都以 `{ prepend: true }` 注册，
保证在浏览器 UI 的 remote forwarder **之前**：

1. 先调用 `next()` —— 桌面端审批面板照常出现（这是关键：不能消失）。
2. 同时 `/dsh/ask` + `/dsh/await` 推 QQ。
3. 两边竞速，**谁先给出决定就用谁**：
   - 桌面先答 `allowed-once` / `rejected` / `cancelled` → 采用，并 `/dsh/withdraw` 撤销 QQ。
   - 桌面返回 `unavailable`（没有 UI 应答者）→ 继续等 QQ。
   - QQ 先答 `allowed-once` / `rejected` → 采用（桌面面板保留，迟到的点击会被 DSH 丢弃）。
   - QQ 超时/不可达 → 按 `onUnreachable`：`delegate` 等桌面结果；`deny` 直接拒绝。
4. 两边都没有结论 → `unavailable`（由 DSH 拒绝关闭）。

### 两个实现细节（都不是可选的）

**撤销要等登记结果，不能只看"现在有没有编号"。**
本地面板点一下是微秒级，而 `/dsh/ask` 是一次 HTTP 往返。
桌面完全可能比登记还快，那一刻编号还是空的 —— 直接判断 `if (id)`
就会静默跳过撤销，QQ 那条白挂到超时。所以撤销前先等登记 Promise。

**结论定了就 abort 挂着的 `/dsh/await`，但登记不能挂在这个 signal 上。**
否则 abort 会把"还没返回的登记"一起取消，撤销就永远拿不到编号了。
两条请求的取消源必须分开：登记跟调用方的 signal，等待跟本地的超时。

**QQ 先答时桌面面板无法从插件侧关闭。** 撤销 `req.signal` 会被工具执行器
当成「用户取消」，那是完全不同的语义。所以迟到的桌面点击由 DSH 丢弃，
面板等自己超时才收起 —— 宁可多一个空面板，也不能把「取消」误传给正在跑的工具。

## 5. 其余路由（不变）

| 路由 | 作用 |
| --- | --- |
| `/dsh/ping` | 探活，返回待回复数量与路由命中统计 |
| `/dsh/drain` | DSH 取走 QQ 排队的指令 |
| `/dsh/delivery-failed` | DSH 上报指令投递失败，让 QQ 侧告诉用户 |
| `/dsh/event` | 事件通知（不参与授权） |
| `/qq/command` | Ling-bot 下发指令 |
| `/qq/answer` | 用编号回复（`reply` 优先，`outcome` 兼容旧调用） |
| `/qq/pending` | 查待回复列表 |
| `/qq/quiet` | 设置/取消免打扰 |

## 6. 失败方向

任何一步出错都**不能**把审批变成「同意」：

- 令牌缺失 → 桥不启动，DSH 侧 `bridge.enabled=false`，走桌面端。
- 桥不可达 → `unreachable`，按 `onUnreachable` 交还 DSH 或拒绝。
- 结论不在 `allowed-once / rejected / cancelled / unavailable` 词表 → 当失败，不猜。
