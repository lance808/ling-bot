# 表情包插件：实现契约（并行开发唯一事实来源）

本文件描述 `plugins/stickers` 与它的宿主受控能力 `ctx.gateway`。它**先于代码**存在：
宿主层、插件层、测试层三方各写不同文件，接口以本文件为准，任何一方改动都要先改这里。

实现完成后，面向用户的说明写在 [stickers.md](stickers.md)；宿主契约文档见
[plugin-api.md](plugin-api.md)（本文件是它的补充，不是替代）。

---

## 0. 为什么需要新增宿主能力

表情包这件事有四个动作，**前三个都碰不到现有的 `ctx.chat`**：

| 动作 | 为什么现有能力不够 |
| --- | --- |
| 拉取 QQ 账号收藏表情 | 这是 OneBot 扩展动作（`fetch_custom_face_detail`），不是「当前会话的消息」 |
| 取一个收藏表情的图片字节 | 图片不在任何会话消息里，`ctx.chat.mediaList` 只认会话消息 id |
| 把当前会话的图片收藏进账号 | 这是对 **QQ 账号**的写操作（`add_custom_face`），不是对某个会话 |
| 发送一个表情 | 这一条**能**用 `ctx.chat.sendMedia`，走的是同一条闸门 |

前三条如果让插件自己做，等于把「任意 OneBot 动作调用」交给插件，那会直接推翻
`docs/plugin-api.md` §2.4 与 I4（发送只有一条通路）的边界。所以新增一个
**受控网关能力** `ctx.gateway`：它只暴露这四个动作，参数是**语义**而不是 OneBot 报文，
且**没有**任何「目标会话」参数。

### 0.1 硬约束（照抄 `ctx.chat` 的纪律）

1. **没有目标会话参数。** 收藏只能收藏 `ctx.caller.convKey` 里真实收到的消息。
2. **归属由宿主给。** 插件参数里没有 `convKey` / `origin`，`RESERVED_PARAM_NAMES` 也挡着。
3. **失败返回结果对象，不抛异常。** 与 `ctx.chat` 一致（`{ok:false, code, message}`）。
4. **发送仍走统一闸门与队列。** `gateway.sendFace` 内部委托宿主的 `sendSegments`，
   与 AI 回复共用 per-conversation 队列。
5. **不落盘 QQ 图片 URL。** URL 带临时鉴权参数，只在内存里活一次。

---

## 1. `ctx.gateway` 接口

只在 `callTool` 期间存在（与 `ctx.chat` 同）。`init` / `testConnection` / `dispose` 里为 `undefined`。
宿主未注入时，每个方法返回 `E4072`（与 `unavailableChat` 同口径）。

```js
gateway: {
  available: boolean,                 // 宿主是否注入了网关能力
  vision: {                           // 同步属性（不是 Promise），见 §7
    enabled: boolean,                 // 视觉开关是否开着
    supported: boolean | null,        // null = 没探测过；**不可**折成 false
    known: boolean,                   // false = 宿主没给这个事实（能力未注入）
  },
  caps(): {                            // 同步，纯内存（最近一次探测结论）
    prober: 'unknown' | 'ok' | 'failed',
    fetchCustomFaceDetail: 'unknown' | 'supported' | 'unsupported',
    addCustomFace: 'unknown' | 'supported' | 'unsupported',
    modifyCustomFace: 'unknown' | 'supported' | 'unsupported',
    probedAt: number | null,
    reason: string,                    // 空串或一句人话
  },
  async probe({ force }): Promise<{ok, caps, message?}>,   // 主动探测（会发一次 get_supported_actions）
  async listFaces({ count }): Promise<{
    ok: true,
    complete: boolean,                 // true 才能据此判定「QQ 侧已删除」
    items: Array<{ id, resId, md5, desc, url }>,
    count: number,
  } | { ok: false, code, message }>,
  async fetchFaceImage({ ref, maxBytes }): Promise<{
    ok: true,
    bytes: number, sha256: string, mime: string, width: number, height: number,
    animated: boolean, file: string,  // 相对插件 dataDir 的缓存路径，插件用它发送
    dataUrl: string,                  // 仅当 maxBytes 之内；超出时为 ''
    tooLarge: boolean,
  } | { ok: false, code, message }>,
  async collectFace({ messageId, index, desc }): Promise<{
    ok: true, emojiId: string, desc: string, viaQqAccount: true,
    sha256: string, md5: string, mime: string, animated: boolean,
    warning: string,                  // 非空 = 收藏成功但备注失败
  } | { ok: false, code, message }>,
  async sendFace({ file, replyToMessageId, atUserId }): Promise<{
    ok: true, messageId: any, bubbles: 1,
  } | { ok: false, code, message }>,
}
```

### 1.1 `caps()` / `probe()`

网关是否实现了扩展动作**不能假设**。探测顺序：

1. 调 `get_supported_actions`（OneBot 标准动作）。返回数组 → 逐个比对目标动作名。
2. 返回非数组 / 该动作不可用 / 调用失败 → 三态一律是 `'unknown'`，**不是** `'unsupported'`。
   把「没探出来」折成「不支持」会让用户以为机器人坏了。
3. `'unsupported'` 只在一件事发生时出现：`get_supported_actions` **成功返回数组**且其中没有该动作。
4. 真正调用时如果网关报「未知动作 / 不支持」，宿主把结果标成 `E_GATEWAY_UNSUPPORTED`，
   并把该动作的 cap 从 `'unknown'` 降为 `'unsupported'`（这是**实测**结论，可以采信）。

`probe()` 结果缓存 5 分钟；`force: true` 忽略缓存。

### 1.2 `listFaces({count})`

- `count` 夹在 `1..500`，默认 100。
- 内部调用 `fetch_custom_face_detail`。**只有拿到合法数组**才算成功。
- `complete` 的判定：`items.length < count`。等于 `count` 时说明可能被截断，
  调用方**不得**据此清理本地条目（要求 3）。
- 网关返回非数组 → `{ok:false, code:'E_GATEWAY_BAD_PAYLOAD'}`，**绝不**退化成空数组。

### 1.3 `fetchFaceImage({ref, maxBytes})`

`ref` 是 `id` / `resId` / `md5` / `url` 之一（插件从 `listFaces` 拿到）。

- 宿主先解析出图片 URL，再用**宿主自己的受控下载链路**取字节：
  拒绝私网/回环、逐跳校验重定向、字节与像素上限。**不能**把 URL 交给网关重新抓。
- 结果缓存到插件 `dataDir/faces/<sha256>.<ext>`，返回相对路径 `file`。
  同一 sha256 已存在就直接复用（幂等）。
- `maxBytes` 默认 `96*1024`，**可传范围 `4096..131072`**（超出按边界夹取）。
  超过它时：仍然落盘并返回 `file`，但 `dataUrl: ''`、`tooLarge: true`。
  这是给「识别」用的预算，不影响「发送」。
  上限压在 96KB 是因为**工具返回值整体不得超 256KB**（`runtime-inprocess.mjs` 的
  `MAX_RESULT_BYTES`）：base64 会膨胀 4/3，再留出文本与 JSON 包装的余量。

- 另一条**下载**上限是 `FACE_FETCH_LIMITS.hardMaxBytes`（4MB），与 `maxBytes`
  不是一回事：前者防"抓回来一个视频"，后者防"把 256KB 的返回值撞爆"。
  超过 4MB 直接 `E_STICKER_FETCH_FAILED`，不落盘。
- `mime` 按**魔数**判定（PNG/JPEG/GIF/WebP），不看扩展名。`animated` 由 GIF 帧数
  / APNG `acTL` / 动画 WebP `ANIM` 判定。

### 1.4 `collectFace({messageId, index, desc})`

- 只允许 `ctx.caller.convKey` 里的消息：宿主用 `lookupMessage` 校验归属，
  查不到一律 `E4074`（不区分「不存在」与「在别的会话」）。
- 消息发送者等于机器人自己 → `E_STICKER_SELF_COLLECT`（不能收藏自己的消息）。
- 图片字节走宿主的受控取图链路（与 `fetchFaceImage` 同一套），再以
  `base64://` 交给 `add_custom_face`。
- `desc` 非空时再调 `modify_custom_face`；**备注失败不影响收藏成功**，
  返回 `ok:true` 并在 `warning` 里说明。
- 网关不支持 → `E_GATEWAY_UNSUPPORTED`，**不得**降级成本地收藏并回报成功（要求 6）。

### 1.5 `sendFace({file, replyToMessageId, atUserId})`

- `file` 必须是插件 dataDir 内的相对路径（`faces/...`）。宿主 `realpath` 后再校验一次。
- 组装消息段：`reply`（可选）→ `at`（可选，仅群聊）→ `image`。
  **一个气泡里只有一张表情**，没有文字段。
- 走宿主 `sendSegments`（同一道白名单 / 出站审计 / 限流），并进入**per-会话发送队列**。
- 成功后由宿主记一条 `pushRecent(convKey, {role:'assistant', text:'[表情]'})`，
  让模型下一轮知道自己发过（要求 9）。
- 任何拒绝原样返回该 code（`E2020` / `E2030` / `E20XX`），插件不得包成别的错误。

---

## 2. effects：新增两个词

`documents/plugin-api.md` §4.2 的九词扩展为十一词。**这不是"给插件放权"，
而是把一条本来会被写错的声明补上正确名字**：

| effect | 含义 | 推导下限 | 为什么 |
| --- | --- | --- | --- |
| `qq.account.read` | 读 **QQ 账号**的收藏表情列表 | R1 | 外部读，且结果跨会话共享 |
| `qq.account.write` | 写 **QQ 账号**的收藏表情（收藏/改备注） | R2 | 账号级共享状态的持久写，影响所有会话；不可撤销（删了要在 QQ 里找回来） |

规则：

- 给 `qq.account.write` 写 `risk: "R0"` 会被抬到 **R2**。这是要求 12 的落点：
  **不得用错误的低风险档绕过授权**。
- R2 → 该工具**进不了聊天来源**（`chat-grant.mjs` 的上限是 R1）。
  于是「收藏」「改 QQ 备注」只在管理员私聊 / 桌面端可用。
  这是刻意的：群里任何人都能往账号里塞表情，等于把账号的收藏面交给陌生人。
- `qq.account.read` 是 R1，**可以**被点名进群 —— 「看图、选图」是群聊里的主要价值。

`chat-grant.mjs` 的 `isWriteOrExecTool` 追加 `qq.account.write`（与 `data.write` 同列），
这样即使有人把它写成 R1 也会被 effects 抬升并由这条二次拦住。

---

## 3. 插件工具的 effects 矩阵

| 工具 | needs | 声明 risk | effects | 生效 risk | 群里可用 |
| --- | --- | --- | --- | --- | --- |
| `sticker_list` | qq | R0 | `data.read` | R0 | 需点名（chatTools ≤ R1 允许） |
| `sticker_search` | qq | R0 | `data.read` | R0 | 需点名 |
| `sticker_image` | qq | R1 | `data.read`, `qq.account.read` | R1 | 需点名 |
| `sticker_note` | qq | R0 | `data.write` | **R2** | **否** |
| `sticker_collect` | qq | R0 | `qq.account.write`, `data.write` | **R2** | **否** |
| `sticker_send` | qq | R0 | `chat.send.media` | **R1** | 需点名 |

`sticker_note` 为什么是 R2：表情库是**整个账号一份**的（跨会话共享是它的核心价值），
写它属于 `data.write`（插件对自己目录的任意写），不是 `data.session`
（后者只能写按 caller 隔离的那一份）。诚实声明比"在群里也能记笔记"重要。

`sticker_send` 为什么只到 R1：它只往**当前会话**发一个媒体，影响面被 `ctx.caller` 圈死。

### 3.1 六个工具的参数与返回

参数名都必须是 `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`，且不能是
`RESERVED_PARAM_NAMES`（`origin` / `convKey` / `caller` / …）。
**任何工具都不得有"目标会话"参数。**

| 工具 | 参数 | 成功返回（JSON） |
| --- | --- | --- |
| `sticker_list` | `query`?string(60)、`count`?number(1–200)、`refresh`?boolean | `{ok, total, matched, truncated, stickers:[{id, desc, localNote, tags, usage, useCount, animated, hasImage}]}` |
| `sticker_search` | `query` string(60, **必填**)、`count`?number(1–100) | 同上，但 `query` 必填；无命中返回 `matched: 0` 而不是错误 |
| `sticker_image` | `ref` string(120, **必填**) | `{ok, text, images:[{dataUrl, mime, label}], sticker:{id,desc,localNote,tags,animated,tooLarge}}` |
| `sticker_note` | `ref` string(120, **必填**)、`note`?string(200)、`tags`?array<string>(maxItems 20)、`usage`?string(200) | `{ok, id, entry:{…}}`；三个内容参数**至少给一个**，全空时 `E_STICKER_EMPTY_PATCH` |
| `sticker_collect` | `messageId` string(64, **必填**)、`index`?number(0–3)、`desc`?string(50)、`note`?string(200)、`tags`?array<string> | `{ok, emojiId, entry:{…}, warning}` |
| `sticker_send` | `ref` string(120, **必填**)、`replyToMessageId`?string(64)、`atUserId`?string(20) | `{ok, messageId, sticker:{id}}` |

#### `ref` 接受什么（六个工具统一）

`ref` 是一个**标识符**，按固定优先级逐级精确匹配，**不做**模糊/子串匹配：

1. 条目 `id`（= QQ 的 `emoji_id`）
2. `resId`
3. `sha256`（小写）
4. `md5`（大小写不敏感）
5. 图片 URL 的规范化形式（仅当库里有 url 记录时；正常条目里没有 url，所以这一级实际上很少命中）

**不接受自然语言描述。** "那个笑哭的表情" 不是合法 `ref` —— 模型应该先用
`sticker_search`（关键词）或 `sticker_list` 找到 id，再把它传给 `sticker_image`
/ `sticker_send`。找不到时返回 `E_STICKER_NOT_FOUND`，并在 `message` 里
提示"先用 sticker_search 或 sticker_list 拿到 id"。

不做模糊匹配是一个刻意的取舍：模糊匹配会让"发错表情"变成常态
（相似备注的两张图），而表情发出去就撤不回。让模型多走一步查询是值得的。

#### `sticker_collect` 的 `desc` 与 `note` 分工

两个都是可选，但**写的地方不同**：

| 参数 | 写到哪 | 上限 | 谁能看到 |
| --- | --- | --- | --- |
| `desc` | **QQ 账号**的表情备注（`modify_custom_face`） | 50（实际 QQ 侧约 20 字） | 在 QQ 客户端里也看得见 |
| `note` | **本地库**的 `localNote` | 200 | 只有本插件/模型 |

两个都给时都写；只给 `desc` 时本地 `localNote` 留空（不复制 `desc`，
否则以后改 QQ 备注时会出现两处不一致）；只给 `note` 时不动 QQ 备注。

`desc` 写失败不影响收藏成功（见 §1.4 的 `warning`）。


`sticker_send` 的 `replyToMessageId` **必须属于当前会话**：宿主用 `lookupMessage`
校验，不符合返回 `E4074`。这是跨会话引用边界，不是可选项。
`atUserId` 只在群聊可用，私聊传它返回 `E_STICKER_TARGET_NOT_GROUP`。

`sticker_image` 是唯一会返回 `images` 的工具。宿主 `agent-loop.mjs` 会把它们
作为一条紧随 tool 消息的 user 消息送进视觉通道（见 §7）。

### 3.2 `sticker_send` 之后不要再描述"我发了表情"

宿主在发送成功后已经 `pushRecent(convKey, {role:'assistant', text:'[表情]'})`，
模型下一轮**看得见**这件事。若它在最终回答里再写一句"（我发了个表情）"，
用户会看到一条多余的话 —— 表情本来就看得见。

所以工具描述里要明确：**调用成功就够了，不要复述**。

---

## 4. 表情库格式（`plugin-data/stickers/library.json`）

```json
{
  "version": 1,
  "account": "<selfId>",
  "syncedAt": 1730000000000,
  "lastSyncComplete": false,
  "lastError": { "code": "E_GATEWAY_UNSUPPORTED", "message": "...", "at": 1730000000000 },
  "entries": [
    {
      "id": "1234567",
      "resId": "1234567",
      "md5": "AABBCC...",
      "sha256": "9f2c...",
      "file": "faces/9f2c....gif",
      "mime": "image/gif",
      "bytes": 20480,
      "width": 240,
      "height": 240,
      "animated": true,
      "origin": "qq",
      "desc": "官方备注（来自 QQ）",
      "localNote": "本地含义（AI 记录的认知）",
      "tags": ["嘲讽", "笑哭"],
      "usage": "接梗时用",
      "useCount": 3,
      "lastUsedAt": 1730000000000,
      "lastContext": "group:123",
      "sourceMessageId": "",
      "sourceConvKey": "",
      "createdAt": "2026-10-23T00:00:00.000Z",
      "updatedAt": "2026-10-23T00:00:00.000Z"
    }
  ]
}
```

规则：

- **不入库的字段**：`url`。QQ 图片 URL 带临时鉴权参数，落盘等于把私有图片的长期入口
  写进明文文件。发送前用 `file`（本地缓存）或 `gateway.fetchFaceImage` 现取。
- `md5` 大写；`sha256` 小写十六进制（本地去重键）。
- `origin`：`qq`（来自账号收藏）/ `local`（仅本地收藏）。
- 文本字段一律**单行化** + 截断（`desc`/`localNote`/`usage` ≤ 200，`tag` ≤ 24，最多 20 个），
  理由同参考实现的 `sanitizeStickerText`：库是跨会话共享的，多行备注会变成提示词注入通道。
- `animated: true` 的来源条目，`localNote` 里**不得**声称看到了完整动作（见 §7）。

### 4.1 损坏与降级

| 情况 | 行为 |
| --- | --- |
| 文件不存在 | 空库（首次使用），`writable: true` |
| 读失败（EACCES/EBUSY/…） | `throw StorageCorrupt`，调用方降级为**只读不写** |
| JSON 解析失败 / 顶层非对象 / `entries` 非数组 | 同上 |
| 单条脏记录（缺 id / 类型错） | 丢弃那一条，其余照常加载 |

**只读降级下，任何写工具都返回 `E_STICKER_STORE_READONLY`，绝不回写。**
一次截断 + 一次"空库写回"就能把 AI 积累的 `localNote` 永久清零，而界面一切正常。

### 4.2 同步合并（`mergeLibrary(existing, fetched, {complete})`）

- 逐条比对键优先级：`id` → `resId` → `md5`。
- **只更新 QQ 侧字段**：`id` / `resId` / `md5` / `desc`（`desc` 为空时保留旧值，不清空）。
- **保留本地认知**：`localNote` / `tags` / `usage` / `useCount` / `lastUsedAt` / `lastContext` /
  `createdAt`。这是要求 3 的核心。
- `complete === true` 时，删除「`origin === 'qq'` 且不在 fetched 里」的条目
  （QQ 侧确实删了）。`complete === false` 时**一条都不删**。
- `origin === 'local'` 的条目**永远不删**（它们本来就不在 QQ 列表里）。

---

## 5. 收藏去重与归属（要求 4）

收藏前依次检查，任一不过即拒绝：

1. `ctx.caller.convKey` 存在且合法（否则 `E_STICKER_NO_IDENTITY`）。
2. `gateway.collectFace` 的归属校验（消息不属于当前会话 → `E4074`）。
3. 发送者是自己 → `E_STICKER_SELF_COLLECT`。
4. **来源去重（调用网关之前）**：库里已有 `sourceMessageId + sourceIndex` 相同的条目
   → `E_STICKER_DUPLICATE`，带上已有条目 id。这条覆盖了最常见的重复：
   模型重试同一次收藏。
5. 频次闸门（见 §6）。
6. 调 `add_custom_face`。成功后拿到 `sha256` / `md5`，再比对：
   - 库里已有同 `sha256` → `E_STICKER_DUPLICATE`（返回已有条目 id）。
   - `listFaces` 里已有同 `md5` → `E_STICKER_DUPLICATE`。

> **第 6 步必然是"事后"的，这一点要如实承认。**
>
> `sha256` / `md5` 是对**这张图的字节**算出来的，而字节要等 `collectFace`
> 从账号缓存里取回来才有（`fetchFaceImage` 需要 `ref.url`，而新收藏的表情
> 还没有 url）。所以在 `add_custom_face` 之前唯一能比的判据，就是
> 「同一条消息的同一个图片段」。
>
> 后果要写进返回文案：**QQ 账号那边可能已经多了一张重复的表情**，
> 需要用户自己去 QQ 里删。谎称"没有重复"会让用户永远查不明白为什么收藏里
> 多了一张。

**只有 QQ 收藏真的成功**（`add_custom_face` 返回 `emoji_id`）才写 `origin: 'qq'` 条目。
网关不支持时明确报错，**不得**写一条本地条目然后说"收藏好了"（要求 6）。

`add_custom_face` 成功但**没有返回 `emoji_id`** → `E_STICKER_COLLECT_NO_ID`，
且**不写本地条目**：一个对不上账号任何一条的条目，比没有更糟。

---

## 6. 配置项（`plugin.json`）

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `listEnabled` | boolean | true | 列表 / 搜索工具开关 |
| `imageEnabled` | boolean | true | 看表情图片开关 |
| `collectEnabled` | boolean | true | 收藏开关（独立于发送） |
| `sendEnabled` | boolean | true | 发送开关（独立于收藏） |
| `noteEnabled` | boolean | true | 记录含义开关 |
| `maxListCount` | number | 60 | 单次列表条数（1–200） |
| `syncTtlMs` | number | 60000 | 同步缓存时间（0–3600000） |
| `maxImageBytes` | number | 98304 | 识别用图片字节上限（4096–131072） |
| `collectPerHour` | number | 6 | 每小时收藏次数上限（0–60，0 = 禁止） |
| `sendPerHour` | number | 20 | 每小时发送次数上限（0–120） |
| `sendMinIntervalMs` | number | 8000 | 两次表情发送的最小间隔（0–600000） |
| `maxRemarkChars` | number | 20 | 收藏时写进 QQ 备注的字数上限（0–50） |
| `syncOnInit` | boolean | true | init 时预热同步一次 |
| `fallbackToTagsWhenVisionOff` | boolean | true | 视觉关闭时允许按标签选图 |
| `overridePersona` | boolean | false | 人格说「不用表情包」时仍然让表情工具可用 |

**`overridePersona` 住在插件配置里**（`plugin.json` 的 `config`，即
`plugins.config.stickers.overridePersona`）。理由：它是"这个插件要不要压过人格"的
决定，属于插件自己的行为参数，不该进主配置的结构。

### 6.1 运行时是 `process`

第三方风格的插件，**不**声明 `trusted` / `in-process`。代价要知道：

- 限频窗口在**子进程内存**里，子进程重启（崩溃后自动拉起、点重载）就清零。
  这不是安全边界，是"别刷屏"的节流；真正的发送上限在宿主的 `RateLimiter` 里，
  那一个是进程级的，不受插件重启影响。
- 每次子进程重启都会重新 `init`，`syncOnInit` 会再同步一次表情库
  （受 `syncTtlMs` 约束，不会每次都打网关）。

### 6.2 表情缓存回收

`faces/` 会随使用增长。策略（插件负责，宿主不管）：

- 条目被同步逻辑删除时，删掉它独占的 `file`（先检查**没有其他条目**引用同一 sha256）。
- `init` 时清掉「没有任何条目引用」的孤儿文件（上次崩溃留下的半成品）。
- 不做按时间/体积的自动淘汰：删掉可能还在用的缓存会让下一次发送失败一次，
  而失败的表现是"表情发不出去"——比占点磁盘难解释得多。

**所有开关都默认 `true` 是安全的**，因为插件本身默认不启用，且工具在聊天来源
默认不可见（`chatTools` 全关）。启用 + 点名是两次独立的管理员动作。

频次是**进程内存**的滑动窗口（重启清零），与宿主的发送限流是两层：
插件层是"别刷屏"，宿主层是"别把号发没"。

---

## 7. 视觉链路与动图（要求 7、8）

插件**不自己调模型**，也不自己取图给模型看。它返回结构化结果：

```js
{ text: '...', images: [{ dataUrl, mime, label }] }
```

`agent-loop.mjs` 会把这些图片作为紧随 tool 消息的一条 user 消息送进视觉通道
（`docs/vision-contract.md` §7）。所以：

- **视觉开关关着时**（`vision.enabled !== true`），插件**仍然**能按已有
  `localNote` / `tags` 选图，但必须在 `text` 里写明
  「视觉识别已关闭，这次是按已有标签选的，我没有看这张图」。要求 7 的落点。
- 插件无法直接读宿主的 `vision.enabled`。宿主通过一个**只在 callTool 期间存在**的
  只读字段告诉它：`ctx.gateway.vision: { enabled, supported, known }`。
  这是事实注入，不是授权。
- **`known` 是关键。** `known: false` 表示宿主没注入这个事实（例如宿主没接线、
  或调用来自配置校验）。这时插件**不能**说"视觉识别已关闭"——它不知道。
  正确文案是「当前无法确认读图是否可用，我只按标签选」。
  把"不知道"说成"关着"，等于对用户撒了一个具体的谎。
- **动图（GIF / APNG / 动画 WebP）**：
  - 有的视觉服务只取首帧，有的直接拒绝；模型看到的多半是**静态的第一帧**。
  - 因此 `sticker_image` 的返回文本必须包含一句：
    「这是动图，你看到的是第一帧/静态画面；不要根据它推断完整动作。」
  - `localNote` 里也不该写"它会左右横跳"这种只有看动图才知道的结论；
    只能写第一帧可确认的内容 + 印象性描述。
  - 发送时**原样发原始文件**，不转码、不抽帧 —— QQ 客户端负责播放。
  - 字节上限对动图同样生效；超上限的动图只落盘不识别（`tooLarge: true`）。

---

## 8. 人格协调（要求 11）

内置 `DEFAULT_PERSONA` 里有一句「说话习惯：不用表情包，不用颜文字，句子短。」

**不静默改写它。** 做法：

1. `src/llm/prompt.mjs` 新增纯函数 `buildStickerGuidance({ enabled, maxPerTurn })`
   与 `resolvePersonaStickerPolicy(personaText)`：
   - 检测人格文本里是否有「不用表情包」类表述（正则：`不(用|要|发|使?用).{0,4}表情`）。
   - 返回 `'forbid' | 'allow' | 'unset'`。
2. 三态决策，**只有 `'unset'` 才注入表情策略**：

   | 人格里的表态 | 行为 |
   | --- | --- |
   | `forbid` | 完全不注入表情策略；插件工具对模型不可见（宿主收窄） |
   | `unset`（含默认人格） | 注入"可以用，但克制"的策略 |
   | `allow` | 注入同样的策略 |

3. **默认人格就是 `forbid`**（它写着「不用表情包」）。于是默认状态下：
   - 不会偷偷改用户的人格；
   - 表情工具对该会话**不出现**（避免"提示词说别用、工具又摆在那儿"的分裂）；
   - 用户想用，就自己改人格（或新建一张卡），或者显式打开插件配置
     `overridePersona: true`（默认 false，见 §6）。
4. `overridePersona: true` 是**管理员的显式决定**，注入的策略里会写一句
   「以下策略优先于人格中关于表情的那句话」——但那仍是提示，不是硬边界。
   **用户的人格文本一个字符都不会被改写**，这是硬约束。

> 关键区别：`forbid` 时**收窄工具面**（结构性），而不是只在提示词里劝（那可是会被
> 聊天内容影响的）。收窄的判据是「管理员的人格设置」，不是对话内容，故不违反 I14。

---

## 9. 错误码（插件前缀，避免与宿主 E40xx 混淆）

| code | 含义 |
| --- | --- |
| `E_STICKER_NO_IDENTITY` | 本次调用没有可信会话上下文 |
| `E_STICKER_DISABLED` | 对应能力的开关关着 |
| `E_STICKER_STORE_READONLY` | 库损坏/读失败，已降级只读，拒绝写入 |
| `E_STICKER_NOT_FOUND` | 按引用找不到表情条目 |
| `E_STICKER_DUPLICATE` | 这张图已经在库里/账号收藏里 |
| `E_STICKER_SELF_COLLECT` | 不能收藏自己发的消息 |
| `E_STICKER_EMPTY_PATCH` | `sticker_note` 没给任何要写入的内容 |
| `E_STICKER_VISION_OFF` | 视觉关着且没有可用标签（不能凭空认图） |
| `E_STICKER_RATE_LIMITED` | 命中插件层频次闸门 |
| `E_STICKER_TARGET_NOT_GROUP` | 在私聊里传了 `atUserId` |
| `E_GATEWAY_UNSUPPORTED` | 网关不支持该扩展动作（实测结论） |
| `E_GATEWAY_BAD_PAYLOAD` | 网关返回的结构不符合约定（不清空库） |
| `E_GATEWAY_UNAVAILABLE` | 网关未联通 / 动作调用失败（**不是**"不支持"） |

### 9.1 宿主侧 `gateway` 实际还会返回的码

这些由 `src/plugins/gateway-bridge.mjs` 产生，插件**原样透传**，不要改写：

| code | 触发 |
| --- | --- |
| `E_STICKER_NO_IMAGE` | 消息里没有图片段（只有文本/表情 id/转发） |
| `E_STICKER_NO_IMAGE_URL` | 表情条目没有 http(s) 图片地址，或地址不是 http(s) |
| `E_STICKER_FETCH_FAILED` | 取字节失败：网络、非图片魔数、超 4MB、像素超限、缓存写失败 |
| `E_STICKER_COLLECT_NO_ID` | `add_custom_face` 成功但没返回 `emoji_id`（**不得**当成功） |
| `E4070` | 调用已取消 |
| `E4071` | 宿主未配置插件数据目录 |
| `E4073` | 参数形状不合法（缺 messageId、reply id 非整数等） |
| `E4074` | 消息/引用不属于当前会话 |
| `E4075` | 路径越界（表情缓存或发送文件跑出插件 `dataDir`） |
| `E2020` / `E2030` / `E20XX` | 发送闸门拒绝：审计拦截 / 限流 / 白名单 |

> **不要**把 `E_GATEWAY_UNAVAILABLE` 显示成"网关不支持表情包"。前者是
> "这次没连上/这个动作调失败了"，后者是"这个网关没有这个功能"。
> 两者对用户的行动指引完全相反。

---

## 10. 测试矩阵（不连 QQ、不发真消息、不调收费模型）

实现落在两个文件里：

| 文件 | 覆盖 |
| --- | --- |
| `test/stickers-host.test.mjs` | effects / 授权 / 网关能力 / 人格收窄（46 项） |
| `test/stickers-plugin.test.mjs` | 插件行为：库、合并、去重、限频、视觉、动图（56 项） |
| `test/plugin-runtime-parity.test.mjs` | `ctx.gateway` 两种运行时形状一致（新增 1 项） |

| 主题 | 断言要点 |
| --- | --- |
| 同步合并 | 保留 `localNote`/`tags`/`useCount`；只更新 `desc`/`md5`；`complete:false` 不删 |
| 部分列表 | `items.length === count` → `complete:false` → 未返回条目仍在 |
| **空列表** | `complete:true` 但 `items=[]` 且本地有条目 → **一条都不删**，`E_GATEWAY_EMPTY_LIST` |
| 同步失败 | `listFaces` 失败 → 库**逐字节不变**，`warning` 带出错误码 |
| 损坏库 | 截断 JSON → `StorageCorrupt`；写工具返回 `E_STICKER_STORE_READONLY`；文件保持原样 |
| 脏记录 | 单条缺 id → 只丢那一条，其余照常加载 |
| 跨会话 | 别的会话的 messageId → `E4074`；插件侧不产生任何条目 |
| 去重（来源） | 同 `sourceMessageId + sourceIndex` → `E_STICKER_DUPLICATE`，**不调** `add_custom_face` |
| 去重（内容） | 同 sha256 → `E_STICKER_DUPLICATE`，返回已有条目 id（已如实提示账号侧可能多一张） |
| 自己消息 | `sender.id === selfId` → `E_STICKER_SELF_COLLECT` |
| 网关不支持 | `get_supported_actions` 成功且缺动作 → `E_GATEWAY_UNSUPPORTED`；**不写本地条目** |
| 网关未注入 | `ctx.gateway` 缺失或 `available:false` → `E4072`（不是"不支持"） |
| 视觉关闭 | 返回文本含「视觉识别已关闭」；`images` 为空；仍可按 tags 选 |
| 视觉未知 | `known:false` 时**不说**"已关闭"，只说按标签选 |
| 动图 | `animated:true` → 返回文本含「动图」「第一帧」 |
| 超大图 | `tooLarge:true` → `images` 为空但 `ok:true`（仍然能发） |
| 发送失败 | 闸门 `E2030` 原样透传；`useCount` **不增加** |
| 限频 | 超 `sendPerHour` / `collectPerHour` → `E_STICKER_RATE_LIMITED`，不调网关 |
| 间隔 | 短于 `sendMinIntervalMs` → 同码；`perHour=0` → `E_STICKER_DISABLED` |
| 开关独立 | `sendEnabled=false` 不影响收藏，反之亦然 |
| 气泡 | 表情消息段里没有 text 段；`sendFace` 只传一个 `file` |
| 返回值体积 | 60 条满字段的列表 < 256KB |
| effects | `max(声明, 下限)`：`sticker_note`/`sticker_collect` → R2，`sticker_send` → R1 |
| 授权 | `qq.account.write` 的工具即使被 `chatTools` 点名 + `allowPaid` 也**进不了群** |
| 人格 | `forbid` → 六个工具从候选集消失；`unset`/`allow` → 注入策略；`overridePersona` 不改人格文本 |

---

## 11. 文件归属（并行写入范围，互不重叠）

| 范围 | 归属 |
| --- | --- |
| `plugins/stickers/**` | plugin-impl |
| `test/stickers-*.test.mjs` | tests |
| `docs/stickers.md` | docs |
| `src/plugins/effects.mjs`、`src/guard/chat-grant.mjs`、`src/onebot/client.mjs`、`src/plugins/gateway-bridge.mjs`、`src/plugins/runtime-*.mjs`、`src/plugins/child-runner.mjs`、`src/plugins/manager.mjs`、`src/plugins/host-chat.mjs`、`src/index.mjs`、`src/llm/prompt.mjs`、`src/tools/builtin-plugins.mjs`、`docs/plugin-api.md`、`README.md` | Lead |
