# 表情包插件（stickers）

一句话：它让机器人**看**得懂 QQ 收藏里的表情、**记**得每张图是什么意思、
按语境**选**一张、并**发**出去。插件默认**不启用**；工具默认也不在聊天来源可见。
启用与点名是两次独立的管理员动作。

本文面向使用者。实现约定、工具签名、错误码与限制的**唯一事实来源**是
[stickers-contract.md](stickers-contract.md)；宿主侧能力（`effects`、聊天来源授权）
见 [plugin-api.md](plugin-api.md)。

- 插件目录：`plugins/stickers/`
- 运行数据：`<用户数据目录>/plugin-data/stickers/`
- 接口版本：`apiVersion: "1"`

---

## 1. 怎么打开

三步，缺一步都不会有效果。

1. 打开「插件」页，选中 `stickers`，填配置，保存，**启用**。
   状态应显示「运行中」，「工具清单」里出现 6 个 `plugin_sticker_*` 工具。
2. 自己用（管理员私聊、桌面端）不需要再做什么：
   `owner-private` / `owner-group` / `console` 三个来源不受 `plugins.chatTools` 约束。
3. 群聊里要用，必须在 `plugins.chatTools.group.tools` 里**逐一点名**：

```json
{ "method": "setting", "params": { "key": "plugins.chatTools.group",
  "value": { "enabled": true, "allowPaid": false,
    "tools": ["plugin_sticker_list", "plugin_sticker_search",
              "plugin_sticker_image", "plugin_sticker_send"] } } }
```

桌面端「安全」页里点选也可以。注意三档互相独立：群聊开了不等于私聊开了，
**主动回合（`proactive`）要单独开**。

还有一道前置条件在配置之外：人格里写着「不用表情包」时，这些工具对该会话**根本不出现**，
上面三步全做对也不会生效。见 §8.2。

### 1.1 为什么 `note` 与 `collect` 永远进不了群

| 工具 | 声明 | 生效风险 | 卡在哪 |
| --- | --- | --- | --- |
| `plugin_sticker_note` | R0 + `data.write` | **R2** | 聊天来源上限是 R1；`data.write` 被 `isWriteOrExecTool` 二次拦 |
| `plugin_sticker_collect` | R0 + `qq.account.write` | **R2** | 同上，且 `qq.account.write` 也在同一份黑名单里 |

两个原因叠在一起：

- **表情库是整个账号一份的**（跨会话共享正是它的价值），所以「记含义」是
  `data.write`（插件对自己目录的任意写），不是 `data.session`（只能写当前 caller 那一份）。
- **「收藏」是往 QQ 账号里加东西**，属于 `qq.account.write`：账号级共享状态、
  影响所有会话、**不可撤销**（删了得回 QQ 客户端里找回来）。

一句话：群里的任何人都不该能往这个账号的收藏面里塞图、或改写全账号共用的备注。
把这两件事留在管理员私聊与桌面端，是刻意的取舍，不是漏配。

把名字写进 `chatTools` 也没用——写着可见、实际不生效。排查时先看这一节。

---

## 2. 六个工具

模型看到的名字是 `plugin_<name>`。

| 工具 | 做什么 | 风险（声明 → 生效） | 群里能不能用 |
| --- | --- | --- | --- |
| `sticker_list` | 列出表情库，给每张一个稳定引用 | R0 → **R0** | 需点名 |
| `sticker_search` | 按关键词找表情（匹配备注、本地含义与标签） | R0 → **R0** | 需点名 |
| `sticker_image` | 取一张表情的图片给模型**看**（走视觉通道） | R1 → **R1** | 需点名 |
| `sticker_note` | 记录这张图是什么意思（只写本地库） | R0 → **R2** | **否** |
| `sticker_collect` | 把当前会话里的一张图**加进 QQ 收藏** | R0 → **R2** | **否** |
| `sticker_send` | 往**当前会话**发一张表情 | R0 → **R1** | 需点名 |

为什么 `sticker_send` 只到 R1：它只能往 `ctx.caller` 圈定的那个会话发一个媒体，
影响面被会话本身限住。为什么 `sticker_image` 是 R1 而 `list` 是 R0：前者要读
**QQ 账号**的图（`qq.account.read`），后者只读本地索引。

「需点名」的含义是：**不点名就看不见**，点名之后也不再逐次确认。
被授权本身就是一次写下来、看得见、可撤回的管理员决定。

### 2.1 六个工具**都没有**「目标会话」参数

这不是漏写，是能力层面就没有：所有工具只作用于 `ctx.caller` 圈定的那个会话。
插件参数里不存在 `convKey` / `origin` / `caller`，宿主还用 `RESERVED_PARAM_NAMES`
挡着同名的键。所以「往隔壁群发个表情」「收藏别的群里那张图」在结构上做不到，
不是靠提示词约束的。

### 2.2 参数与返回

参数名都符合 `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`，清单没声明的键会被丢掉（不报错）。

| 工具 | 参数 | 成功返回（JSON） |
| --- | --- | --- |
| `sticker_list` | `query`? string(60)、`count`? number(1–200)、`refresh`? boolean | `{ok, total, matched, truncated, stickers:[{id, desc, localNote, tags, usage, useCount, animated, hasImage}]}` |
| `sticker_search` | `query` string(60, **必填**)、`count`? number(1–100) | 同上；无命中返回 `matched: 0`，不是错误 |
| `sticker_image` | `ref` string(120, **必填**) | `{ok, text, images:[{dataUrl, mime, label}], sticker:{id, desc, localNote, tags, animated, tooLarge}}` |
| `sticker_note` | `ref` string(120, **必填**)、`note`? string(200)、`tags`? string[](≤20)、`usage`? string(200) | `{ok, id, entry:{…}}` |
| `sticker_collect` | `messageId` string(64, **必填**)、`index`? number(0–3)、`desc`? string(50)、`note`? string(200)、`tags`? string[] | `{ok, emojiId, entry:{…}, warning}` |
| `sticker_send` | `ref` string(120, **必填**)、`replyToMessageId`? string(64)、`atUserId`? string(20) | `{ok, messageId, sticker:{id}}` |

`sticker_note` 的三个内容参数（`note` / `tags` / `usage`）**至少给一个**，
全空返回 `E_STICKER_EMPTY_PATCH`——「什么都没改」不该被回报成一次成功的写入。

`sticker_image` 是六个工具里**唯一**会返回 `images` 的那个，其它工具不往视觉通道塞图。

`list` 与 `search` 的区别只有一个：`query` 是否必填。`list` 不给 `query` 就是「都有什么」，
`search` 不给就被参数校验挡下。两者命中为 0 都不算失败。

---

## 3. 表情库是什么

位置：`<用户数据目录>/plugin-data/stickers/library.json`。整个账号一份，**跨会话共享**。

顶层字段：

| 字段 | 说明 |
| --- | --- |
| `version` | 格式版本，当前 `1` |
| `account` | 这份库属于哪个 QQ 号（`selfId`） |
| `syncedAt` | 上次成功同步的时间戳 |
| `lastSyncComplete` | 上次拿到的是不是完整列表 |
| `lastError` | 上次失败的错误码、消息、时间；成功时为空 |
| `entries` | 条目数组 |

每条条目主要字段：

| 字段 | 含义 |
| --- | --- |
| `id` / `resId` / `md5` | QQ 侧标识。`md5` **大写**，用于和账号收藏比对 |
| `sha256` | 本地去重键，**小写**十六进制 |
| `file` | 本地缓存路径（`faces/<sha256>.<ext>`），发送用它 |
| `mime` / `bytes` / `width` / `height` / `animated` | 按**魔数**判定，不看扩展名 |
| `origin` | `qq`（来自账号收藏）/ `local`（只在本地） |
| `desc` | QQ 侧官方备注，同步时会被更新 |
| `localNote` | AI 记录的「这张图什么意思」，**同步时永远保留** |
| `tags` / `usage` | 标签与用法，最多 20 个标签、每个标签 ≤ 24 字 |
| `useCount` / `lastUsedAt` / `lastContext` | 真的发成功才累加 |
| `sourceMessageId` / `sourceConvKey` | 收藏时来自哪条消息、哪个会话 |
| `createdAt` / `updatedAt` | 时间戳 |

没有 `url` 字段，这是下一节要讲的规矩。

### 3.1 为什么不存图片 URL

QQ 的图片 URL 带**临时鉴权参数**。落盘等于把一张私有图片的长期入口写进明文文件；
重启后它必然失效，留下的是一个看着能用、实际取不到的地址。所以：

- URL 只在内存里活一次，不写进 `library.json`；
- 发送用 `file`（本地缓存）或现取一次；
- 缓存文件本身按 `sha256` 命名并幂等复用。

同一条纪律在视觉链路里已经存在（见 [vision.md](vision.md)）：URL 与 base64 都不落盘。

### 3.2 为什么备注必须单行化

库是**跨会话共享**的，也就是任何会话里写进去的文本，都可能出现在下一次别处的提示词里。
多行备注因此天然是一条提示词注入通道：一行看起来像「备注」的文字，换行之后就能伪装成
指令。所以所有文本字段一律**单行化 + 截断**：

| 字段 | 上限 |
| --- | --- |
| `desc` / `localNote` / `usage` | 200 字 |
| `tag` | 24 字 |
| `tags` 数量 | 20 个 |

这不是洁癖。去掉换行之后，「这是一条备注」和「这是一句指令」在结构上就不再可混淆。

---

## 4. QQ 账号收藏 vs 本地记录

这是**两件不同的事**，界面上、返回文本里都不许混：

| | 「收藏」 | 「记录含义」 |
| --- | --- | --- |
| 写哪里 | **QQ 账号**的自定义表情 | 只写本地 `library.json` |
| 工具 | `sticker_collect` | `sticker_note` |
| 需要网关 | 要（`add_custom_face`，可选 `modify_custom_face`） | 不要 |
| 生效风险 | R2 | R2 |
| 群里可用 | 否 | 否 |
| 别人的会话能看见吗 | 能（账号级） | 能（库是账号级共享） |
| 撤销方式 | 回 QQ 客户端删 | 删除本地条目或改备注 |

**本地保存永远不显示成 QQ 收藏成功。** 网关不支持收藏时，工具返回
`E_GATEWAY_UNSUPPORTED`，**不会**偷偷写一条 `origin: "local"` 的条目然后说
「收藏好了」。那样做的结果是：用户以为账号里多了一张图，其实只在自己的插件目录里
多了一条记录，换台机器就没了。

只有 `add_custom_face` 真的返回了 `emoji_id`，才写 `origin: "qq"` 的条目。

备注是附带动作：给了 `desc` 才会再调 `modify_custom_face`。**备注失败不影响收藏成功**，
返回 `ok: true`，`warning` 非空并在里面写明失败原因。

`warning` 非空只表示一件事：**收藏成功了，QQ 备注没写上**。它不影响这次收藏，
也不影响本地建条目——条目照建，`desc` 留空或保留旧值。别把 `warning` 当成失败信号去重试，
重试会得到一条重复的收藏。

### 4.1 网关不支持时具体报什么

| 情况 | 返回 |
| --- | --- |
| `get_supported_actions` 成功返回数组、里面没有该动作 | `E_GATEWAY_UNSUPPORTED`（实测结论，可采信） |
| `get_supported_actions` 调用失败 / 返回非数组 / 没探出来 | cap 保持 `unknown`，**不是** `unsupported`；真正去调时才知道结果 |
| 真正调用时网关报「未知动作 / 不支持」 | `E_GATEWAY_UNSUPPORTED`，并把该动作降为 `unsupported` |
| 网关没联通 / 动作调用失败 | `E_GATEWAY_UNAVAILABLE`（**不是**「不支持」） |
| 宿主完全没注入网关能力 | `E4072` |
| 网关返回的结构不符合约定 | `E_GATEWAY_BAD_PAYLOAD`，库不清空 |

为什么要区分 `unknown` 与 `unsupported`：把「没探出来」折成「不支持」，用户会以为
机器人坏了，实际只是这个网关版本没实现 `get_supported_actions`。这两句话的
维修方向完全不同。

`E_GATEWAY_UNAVAILABLE` 也一样不能读成「网关不支持表情包」。它是「这次没连上 /
这个动作调失败了」——等一会儿、检查配置，很可能就好了。而 `unsupported` 是
「这个网关没有这个功能」，等多久都不会变好，只能升级网关或换实现。把前者显示成
后者，等于把一次可恢复的连接问题说成一个改不了的能力缺失。

---

## 5. 同步规则

| 问题 | 答案 |
| --- | --- |
| 什么时候拉 | `init` 时预热一次（`syncOnInit`）；之后按需拉，缓存 `syncTtlMs`（默认 60 秒） |
| 探测缓存多久 | `caps()` 缓存 5 分钟；`probe({force:true})` 忽略缓存 |
| 什么情况删本地条目 | 只在「这次拿到了**完整**列表」且该条 `origin === 'qq'`、又不在列表里时删 |
| 什么是完整 | `items.length < count` 才算完整 |
| 读失败怎么办 | 库**逐字节不变**，只写 `lastError` |
| 图片缓存 | 按 `sha256` 落到 `faces/`，同 sha 直接复用 |

### 5.1 为什么「只拿到一部分列表时不删」

列表接口可能被截断：请求 100 条、正好返回 100 条，你无法判断是「刚好只有 100 张」
还是「被砍到 100 张」。如果按「返回里没有 = QQ 侧已删」处理，一次截断就能把
第 101 张之后的所有条目连 `localNote` 一起删光，而界面一切正常。

所以 `complete` 只由「返回条数严格小于请求条数」推出。`complete === false` 时**一条都不删**。
`origin === 'local'` 的条目本来就不在 QQ 列表里，**永远不删**。

注意这里有两个数：`maxListCount`（配置项，默认 60、上限 200）限制的是**返回给模型的条数**，
而「完整与否」的判断依据是**向网关要的那一次**返回了多少。两者不是同一个数，
所以「列表只显示了 60 条」不代表「QQ 里只有 60 张」，更不代表其余条目被删了。

### 5.2 为什么读失败不清空库

损坏或读不到的 `library.json` 被当成空库再写回，等于用一次「看起来正常」的写操作
把 AI 积累的所有 `localNote` 永久清零。所以读失败抛 `StorageCorrupt`，调用方降级为
**只读**：任何写工具返回 `E_STICKER_STORE_READONLY`，绝不回写。

单条脏记录（缺 `id`、类型不对）只丢那一条，其余照常加载。这不算损坏。

### 5.3 缓存什么时候回收

`faces/` 会随使用增长，插件自己管，宿主不管：

| 时机 | 动作 |
| --- | --- |
| 同步删掉条目 | 删它独占的缓存文件（先确认没有别的条目引用同一 `sha256`） |
| `init` | 清掉「没有任何条目引用」的孤儿文件（上次崩溃留下的半成品） |
| 其它时候 | **不按时间、不按体积自动淘汰** |

不做定时/限额淘汰是有意的：删掉一个可能马上要用的缓存，表现是「表情发不出去」，
而且只在某一次发送时炸；占点磁盘是安静的，排查起来也直白得多。
两种失败里，选那个容易被解释的。

---

## 6. 收藏的限制

| 限制 | 说明 |
| --- | --- |
| 只收**真实收到**的 | 只能收藏 `ctx.caller.convKey` 里确实出现过的消息图片 |
| 不能收自己的 | 发送者是机器人自己 → `E_STICKER_SELF_COLLECT` |
| 同一张图不重复 | 先比本地 `sha256`，再比账号列表的 `md5`；命中 → `E_STICKER_DUPLICATE`，并返回已有条目 id |
| 有频次上限 | `collectPerHour` 默认 6 次/小时，`0` 表示禁止 |
| 备注字数 | `maxRemarkChars` 默认 20 字（QQ 侧备注本就只有 20 字左右） |
| 图片预算 | 识别用的 `maxImageBytes` 默认 96 KB；超了仍然落盘、仍然能发，只是这次看不到 |

顺序是固定的：先查会话归属，再查发送者，再算 `sha256` 去重，最后过频次闸门。
任何一步不过就拒绝，**不会调用** `add_custom_face`。

只认 `image` 段。`face` 段没有字节，`mface` 是商城表情——两者都不是「这张图」，
拿去收藏只会得到一条对不上任何东西的记录。一条消息里有多张图时，按 `index` 选第几张
（从 0 起，越界会被夹到范围内而不是报错）。

### 6.1 为什么群里用不了

「收藏」是一次**账号级写入**：它加进去的图会出现在这个 QQ 号的所有会话里，
不加好友、不在群里，别人也照样能在别处看到它。执行它的人不需要对这个会话
有任何权限，只要能让机器人去收藏就行。

而且它**不可撤销**——从账号里删掉一张表情，得有人在 QQ 客户端里手动做。
群聊里任何人（以及任何一条被模型解读的消息）都能触发它，等于把账号的收藏面
交给陌生人。所以 R2 是硬上限，不是建议。

### 6.2 限频是子进程内存，不是安全边界

插件用的是 `process` 运行时（不声明 `trusted` / `in-process`）。于是：

| 层 | 存在哪 | 什么时候清零 |
| --- | --- | --- |
| 插件层频次（`collectPerHour` / `sendPerHour` / `sendMinIntervalMs`） | **子进程内存** | 子进程重启：崩溃后自动拉起、点「重载」、改配置后重新 `init` |
| 宿主发送限流（`RateLimiter`） | 宿主进程 | 后端重启才会清；**不受插件重启影响** |

两层管的是两件不同的事：插件层是「别刷屏」，宿主层是「别把号发没」。所以
「重启插件就能绕过限频」只对前者成立，后者照样拦。前者本来就不是安全边界，
它只是让机器人别自己刷自己的屏。

每次子进程重启都会重新 `init`，`syncOnInit` 会再同步一次表情库（受 `syncTtlMs` 约束，
不会每次都打网关）。

---

## 7. 视觉与动图

插件**不自己调模型**。它返回结构化结果，由宿主把图片作为紧跟 tool 消息的一条
user 消息送进视觉通道（[vision-contract.md](vision-contract.md) §7）。

### 7.1 视觉的三态：开着、关着、不知道

宿主通过一个只在 `callTool` 期间存在的只读字段告诉插件当前事实：
`ctx.gateway.vision = { enabled, supported, known }`。这是事实注入，不是授权。

| 情况 | 行为 | 返回文本要怎么写 |
| --- | --- | --- |
| `known && enabled` | 正常返回 `images`，模型真的能看到图 | 不用特别声明 |
| `known && !enabled` + 已有标签（`fallbackToTagsWhenVisionOff` 为 true） | **仍能选图**，但不返回 `images` | 「视觉识别已关闭，这次是按已有标签选的，我没有看这张图」 |
| `known && !enabled` + 没有任何可用标签 | `E_STICKER_VISION_OFF`，不凭空认图 | — |
| `!known` | 宿主没给这个事实（没接线、或来自配置校验）。仍然按标签选 | 「当前无法确认读图是否可用，我只按标签选」 |

**`known: false` 时不能说「视觉识别已关闭」。** 那是把「不知道」说成一个具体的事实，
而且是个会误导用户去检查开关的假陈述。同理，也不能说「我看到了」——没给的图就是没给的图。

两句话的差别看起来只有几个字，但对用户的意义完全不同：前者让他去翻「视觉」页，
后者让他去看宿主接线或日志。说错就等于把排查引到错的地方。

关键是最后那层「文字里的诚实」。模型看的是说明文本，不是「它应该知道自己没看图」
这件事本身；不写清楚，它就会开始描述一张其实没看到的图。

### 7.2 动图只到第一帧

GIF / APNG / 动画 WebP 在视觉通道里通常只被取首帧，有的服务直接拒绝。
所以：

- `sticker_image` 的返回文本必须包含「这是动图，你看到的是第一帧/静态画面；
  不要根据它推断完整动作」；
- `localNote` 里**不该**写「它会左右横跳」这种只看动图才能知道的结论；只能写第一帧
  能确认的内容 + 印象性描述；
- 发送时**原样发原始文件**，不转码、不抽帧——QQ 客户端负责播放；
- 字节上限对动图同样生效。超上限的动图只落盘、不识别（`tooLarge: true`）。

### 7.3 两个上限不是一回事

| 上限 | 值 | 超了会怎样 | 谁管 |
| --- | --- | --- | --- |
| 识别预算 `maxImageBytes` | 默认 96 KB，可传 4096–131072 | 仍然落盘、仍然能发；`tooLarge: true`，`dataUrl` 为空，模型这次看不到 | 插件配置 |
| 下载上限 | 4 MB（固定） | 直接 `E_STICKER_FETCH_FAILED`，**不落盘**，发也发不了 | 宿主 |

一句话：96 KB 那条是「给模型看的预算」，4 MB 那条是「根本不该抓这么大的东西」。
前者的结果是「这次看不到」，后者的结果是「这张图拿不到」。所以**超大图仍然能发**，
只是这次看不到——不要把 `tooLarge` 当成失败，也不是错误码（契约里没有它的码）。

---

## 8. 和人格的冲突

内置人格里就写着这句话：

```text
说话习惯：不用表情包，不用颜文字，句子短。
```

出处是 `src/llm/prompt.mjs` 的 `DEFAULT_PERSONA`。**插件不会偷偷改用户的人格文本。**
改掉它等于替用户决定「你现在会用表情包了」，而人格卡是用户的东西。

做法是读人格、判三态、只在一态下注入策略：

| 人格里的表态 | 检测 | 行为 |
| --- | --- | --- |
| 明确禁止 | `forbid` | 完全不注入表情策略；**表情工具对该会话不出现** |
| 没提 | `unset`（空白卡，或人格里没谈表情） | 注入「可以用，但克制」的策略 |
| 明确允许 | `allow` | 注入同样的策略 |

检测用一条保守的正则（`不(用|要|发|使?用).{0,4}表情` 这一类），只认「这句话是在说表情」。
用户自己写的人格大部分是 `unset`；**内置的 `DEFAULT_PERSONA` 命中的是 `forbid`**，
所以默认状态下表情工具根本不可见。

为什么是收窄工具面，而不是只在提示词里劝：提示词里的「别用」会被聊天内容顶掉，
工具面的收窄不会——它来自管理员的人格设置，不来自对话内容。

### 8.1 `overridePersona`

`plugins.config.stickers.overridePersona`（默认 `false`）是**插件自己的配置项**，
住在插件的 `plugin.json` 的 `config` 里——它就是「这个插件要不要压过人格」这个参数，
不属于主配置的结构。管理员的一次**显式决定**：

- `false`：人格怎么写就怎么办；
- `true`：即使人格写着「不用表情包」，也注入表情策略，并在策略里写明
  「以下策略优先于人格中关于表情的那句话」。

但那仍然是**提示**，不是硬边界。它也**不会**回写人格文本 ——
关掉开关，人格卡还是原来那段话，一个字符都没被改过。这是硬约束，不是承诺。

### 8.2 打不开表情工具时，先查人格

现象：插件已启用、配置也对、群里点名了，模型还是从不调用表情工具。
先看这一条。人格（或角色卡）里只要有一句「不用表情包」，工具对这个会话就不出现，
和配置无关。确认方式：看工具清单里有没有 `plugin_sticker_*`；把人格那句删掉，
或显式打开 `overridePersona`，再试。

---

## 9. 发送行为

| 事实 | 含义 |
| --- | --- |
| 走统一发送队列 | per-会话串行，和 AI 回复共用，不会和自己的文字抢顺序 |
| 走同一道闸门 | 白名单、出站审计、限流逐条生效，拒绝码原样透传（`E2020` / `E2030` / `E20XX`） |
| 一个气泡一张表情 | 消息段是 `reply?` → `at?` → `image`，**没有文字段** |
| 文字与表情是两个气泡 | 想说话就单独发一条文字，别指望塞进表情气泡 |
| 只发成功才记账 | 失败时 `useCount` 不增加，也不写进上下文 |
| 发过会记一笔 | 宿主记 `[表情]`，下一轮模型知道自己发过 |

`atUserId` 只在群聊里有效；私聊里传它会得到 `E_STICKER_TARGET_NOT_GROUP`。
引用与 `@` 各最多一个。

`replyToMessageId` **必须属于当前会话**：宿主会用 `lookupMessage` 校验，
不属于就返回 `E4074`。这不是可选项——允许引用别的会话的消息，就等于给了一条
跨会话把话递过去的通道，而这条通道恰好不受 `ctx.caller` 约束。

还有一条是给模型看的口径：**不要在回答里重复描述「我发了表情」**。
宿主在发送成功时已经记过一笔 `[表情]`，模型下一轮看得见这件事；再补一句
「（我发了个表情）」，用户看到的就是一句多余的话——表情本来就看得见。
调用成功就够了，不复述。

---

## 10. 配置项

在「插件」页的配置表单里填，等价于写进 `plugins.config.stickers`。

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `listEnabled` | boolean | `true` | 列表 / 搜索工具开关 |
| `imageEnabled` | boolean | `true` | 看表情图片开关 |
| `collectEnabled` | boolean | `true` | 收藏开关（独立于发送） |
| `sendEnabled` | boolean | `true` | 发送开关（独立于收藏） |
| `noteEnabled` | boolean | `true` | 记录含义开关 |
| `maxListCount` | number | `60` | 单次列表条数，1–200 |
| `syncTtlMs` | number | `60000` | 同步缓存时间，0–3600000 |
| `maxImageBytes` | number | `98304` | 识别用图片字节上限（96 KB），4096–131072；超了仍能发，只是看不到 |
| `collectPerHour` | number | `6` | 每小时收藏次数上限，0–60，`0` = 禁止 |
| `sendPerHour` | number | `20` | 每小时发送次数上限，0–120 |
| `sendMinIntervalMs` | number | `8000` | 两次表情发送的最小间隔，0–600000 |
| `maxRemarkChars` | number | `20` | 写进 QQ 备注的字数上限，0–50 |
| `syncOnInit` | boolean | `true` | `init` 时预热同步一次 |
| `fallbackToTagsWhenVisionOff` | boolean | `true` | 视觉关闭时允许按标签选图 |
| `overridePersona` | boolean | `false` | 人格写着「不用表情包」时是否仍注入表情策略（本插件的配置项，见 §8.1） |

所有开关默认 `true` 是安全的：插件默认不启用，工具在聊天来源默认不可见。
启用与点名是两次独立动作，不存在「装好就自动生效」。

`maxImageBytes` 默认压到 96 KB 有一个硬理由：工具返回值整体不能超 256 KB，
base64 会膨胀 4/3，还要留出文本与 JSON 包装的余量。它和 4 MB 的下载上限
是两道不同的闸（见 §7.3）：这道管「能不能给模型看」，那道管「要不要抓回来」。

频次是**子进程内存**的滑动窗口，子进程重启就清零；宿主的发送限流是另一层，
不受插件重启影响（见 §6.2）。

---

## 11. 错误码

### 11.1 插件自己的码

| code | 含义 |
| --- | --- |
| `E_STICKER_NO_IDENTITY` | 本次调用没有可信会话上下文 |
| `E_STICKER_DISABLED` | 对应能力的开关关着 |
| `E_STICKER_STORE_READONLY` | 库损坏/读失败，已降级只读，拒绝写入 |
| `E_STICKER_NOT_FOUND` | 按引用找不到表情条目 |
| `E_STICKER_DUPLICATE` | 这张图已经在库里/账号收藏里 |
| `E_STICKER_SELF_COLLECT` | 不能收藏自己发的消息 |
| `E_STICKER_EMPTY_PATCH` | `sticker_note` 三个内容参数一个都没给 |
| `E_STICKER_VISION_OFF` | 视觉关着且没有可用标签（不能凭空认图） |
| `E_STICKER_RATE_LIMITED` | 命中插件层频次闸门 |
| `E_STICKER_TARGET_NOT_GROUP` | 在私聊里传了 `atUserId` |
| `E_GATEWAY_UNSUPPORTED` | 网关不支持该扩展动作（实测结论） |
| `E_GATEWAY_BAD_PAYLOAD` | 网关返回的结构不符合约定（不清空库） |
| `E_GATEWAY_UNAVAILABLE` | 网关未联通 / 动作调用失败（**不是**「不支持」） |

这些前缀和宿主的 `E40xx` 是两套：`E40xx` 是宿主拒绝（授权、参数、会话），
`E_STICKER_*` 是插件自己的判断，`E_GATEWAY_*` 是网关侧结论。排查时先分这三类。

**没有 `E_STICKER_IMAGE_TOO_LARGE`。** 图片超识别预算不是错误：
按契约 §1.3，它仍然是 `ok: true`，文件落盘、能发，只是 `tooLarge: true`
这次不给模型看（见 §7.3）。把它列成错误码会让人去做一次没必要的重试。

### 11.2 宿主实际还会返回的码

这些由 `gateway-bridge.mjs` 产生，插件**原样透传**，不改写：

| code | 触发 |
| --- | --- |
| `E_STICKER_NO_IMAGE` | 想收藏的那条消息里没有图片段（只有文本 / 表情 id / 转发） |
| `E_STICKER_NO_IMAGE_URL` | 表情条目没有 http(s) 图片地址，或地址不是 http(s) |
| `E_STICKER_FETCH_FAILED` | 取字节失败：网络、非图片魔数、超 4 MB、像素超限、缓存写失败 |
| `E_STICKER_COLLECT_NO_ID` | `add_custom_face` 成功但没返回 `emoji_id`（**不得**当成功） |
| `E4070` | 调用已取消 |
| `E4071` | 宿主未配置插件数据目录 |
| `E4072` | 宿主没注入网关能力 |
| `E4073` | 参数形状不合法（缺 `messageId`、引用 id 非整数等） |
| `E4074` | 消息 / 引用不属于当前会话 |
| `E4075` | 路径越界（缓存或发送文件跑出插件 `dataDir`） |
| `E2020` / `E2030` / `E20XX` | 发送闸门拒绝：审计拦截 / 限流 / 白名单 |

`E_STICKER_COLLECT_NO_ID` 值得单独记住：它**不是**收藏失败，是「无法确认成功」。
按契约，这时不该写本地条目，也不该告诉用户「收藏好了」。

`E2020` / `E2030` / `E20XX` 要原样交给用户，别包成插件的错误：它们是**可恢复**的
（等一会儿、放宽限流、改白名单），而 `E_STICKER_*` 多半要先动配置或数据。

---

## 12. 已知边界

| 边界 | 后果 |
| --- | --- |
| QQ 侧备注只有 20 字左右 | 收不进「含义 + 用法 + 标签」的全部信息。长内容留在 `localNote` |
| QQ 收藏有上限 | 收藏会失败，具体码由网关给；插件不替网关猜剩余额度 |
| 网关扩展动作可能没实现 | 收藏/看账号表情可能直接不可用。`unsupported` 与 `unknown` 分开报 |
| 表情库是账号级共享 | 换号就是换库；多个会话写同一份 `localNote`，后写的覆盖先写的 |
| 动图识别只到第一帧 | 库里关于动作的描述不可信，文案也不该那么写 |
| 限频在子进程内存里 | 插件重启（崩溃拉起、点重载）就清零。它不是安全边界，宿主限流才是 |
| 视觉开关由宿主注入 | 插件读的是调用期间的一次性事实；`known:false` 时它只能说自己不知道 |
| 表情缓存不做定时淘汰 | `faces/` 只增不减，除非条目被删或 `init` 清孤儿。磁盘要自己看一眼 |
| 运行时是 `process` | 子进程崩溃会重启并重新 `init`，`syncOnInit` 会再同步一次 |

还有一条不算边界的边界：**这个插件不能自己造表情**。它只能从已收藏/已缓存的内容里挑。
如果要「生成一张图再发」，那是生图工具（`paid`）的事，两条路的风险档也不同。

---

## 13. 验收口径

不连真 QQ、不消耗模型额度也能验证的部分：

| 步骤 | 期望 |
| --- | --- |
| 把 `library.json` 截断成半截 JSON，再调任一写工具 | 返回 `E_STICKER_STORE_READONLY`；**文件逐字节不变**；`sticker_list` 仍可读（其余条目照常加载） |
| 关掉「视觉」，调 `sticker_image` | 返回文本含「视觉识别已关闭」；`images` 为空；仍能按 `tags` 选出一张 |
| 让 `ctx.gateway.vision.known === false`，再调 `sticker_image` | 返回文本含「无法确认读图是否可用」；**不能**出现「已关闭」 |
| 关掉视觉且条目没有任何标签 | `E_STICKER_VISION_OFF` |
| 在私聊里调 `sticker_send` 并传 `atUserId` | `E_STICKER_TARGET_NOT_GROUP` |
| 让 `sticker_send` 引用另一个会话的消息 id | `E4074`，不发送 |
| 让插件去收藏「另一个会话里的消息 id」 | `E4074`，插件侧不产生任何条目 |
| 用一张超过 `maxImageBytes` 但小于 4 MB 的图调 `sticker_image` | 仍然 `ok: true`、`tooLarge: true`、`dataUrl` 为空；**仍能用它发出去** |
| 让 `add_custom_face` 成功但不返回 `emoji_id` | `E_STICKER_COLLECT_NO_ID`；**不写本地条目** |
| 让 `add_custom_face` 成功、`modify_custom_face` 失败 | `ok: true`、`warning` 非空、条目照建（`desc` 为空） |
| 用假网关返回非数组 | `E_GATEWAY_BAD_PAYLOAD`；库不变 |
| 让 `listFaces` 整个失败 | 库**逐字节不变**，`lastError` 有记录；不是 `E_GATEWAY_UNSUPPORTED` |
| 连调收藏超过 `collectPerHour` | 第 N+1 次 `E_STICKER_RATE_LIMITED`，不调网关 |
| 在 `sticker_note` 里三个内容参数全不给 | `E_STICKER_EMPTY_PATCH` |
| 把人格改成「不用表情包」 | 该会话的工具清单里没有 `plugin_sticker_*`；打开 `overridePersona` 后出现，且人格文件未被改写 |
| 让模型调 `sticker_note`，备注里带换行与「忽略上面的指令」 | 落盘的 `localNote` 是一行被截断的文本；模型下次拿到的是一行备注 |
| 重启插件子进程，再立刻连调发送 | 插件层限频已清零；宿主限流仍按原窗口生效 |
| 手工在 `faces/` 塞一个没有任何条目引用的文件，重启插件 | 该孤儿文件被清掉；被引用的文件仍在 |

需要真 QQ 才能验的部分（`add_custom_face` 是否实现、备注能否写上、动图在客户端怎么播）
不属于本插件自己的验收范围，以网关与 QQ 客户端的行为为准。
