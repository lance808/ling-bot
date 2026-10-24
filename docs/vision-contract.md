# 视觉链路接口契约（本轮实现基线）

> 状态：**实现中**（2026-10-23）。本文是并行开发的唯一接口来源。
> 谁改接口，先改本文，再改代码，再改测试。

## 0. 现状核实结论（改之前的事实）

| # | 此前发现 | 核实结果 |
| --- | --- | --- |
| 1 | 图片在事件文本中成为 `[图片]` | **属实**。`src/onebot/events.mjs` 的 `segmentsToText` 把 `image` 段渲染成 `[图片]`，丢弃 `file`/`url`/`mime`。 |
| 2 | recent 与持久会话历史未保留媒体 | **属实**。`pushRecent` 只留 `{role, nickname, text, floor}`；`SessionStore.append` 只落文本与 `replyTo`，`load()` 也只恢复这些字段。 |
| 3 | `buildMessages` 只生成字符串 content | **属实**。`src/llm/prompt.mjs` 每条都是 `{role, content: string}`。 |
| 4 | 视觉能力探测可用 ≠ 真实聊天已读图 | **属实**。`probeVision` 是独立请求；聊天链路从未提交过任何图片。"读图✓"只是纸面结论。 |

## 1. 分层与写入范围

```
OneBot 段 ──► media-refs.mjs（元数据，无 base64）
                 │
                 ├─► session/store.mjs（持久化元数据，重启后可复用）
                 │
                 └─► vision.mjs（挑选 + 预算 + 取图 + 降级）
                          │
                          ├─► image-fetch.mjs（受控取图：URL / get_image / 本地缓存路径）
                          │        └─► image-bytes.mjs（魔数、尺寸、像素）
                          │
                          └─► prompt.mjs（组装 text + image_url）
                                   └─► client.mjs（真实请求）
```

写入范围（**不要越界改别人的文件**）：

| 归属 | 文件 |
| --- | --- |
| 视觉核心 | `src/llm/image-bytes.mjs`、`src/llm/image-fetch.mjs`、`src/llm/media-refs.mjs`、`src/llm/vision.mjs`、`test/vision-core.test.mjs` |
| 会话与提示 | `src/session/store.mjs`、`src/llm/prompt.mjs`、`src/llm/agent-loop.mjs`、`src/llm/client.mjs`、`test/vision-history.test.mjs`、`test/vision-prompt.test.mjs` |
| 配置与界面 | `src/config/schema.mjs`、`config.example.json`、`ui/src/views/vision.mjs`、`ui/src/app.mjs`、`ui/styles/pages.css`、`test/vision-page.test.mjs`、`test/ui-shell.test.mjs`（仅页面数断言） |
| 宿主接线 | `src/index.mjs`、`src/tools/chat-image.mjs`、`test/vision-wiring.test.mjs`、`docs/*`、`README.md` |

## 2. 媒体引用元数据（`media-refs.mjs`）

```js
/**
 * @typedef {object} MediaRef
 * @property {'image'} kind          // 本轮只处理 image；face/record 等不进视觉链路
 * @property {string} [file]         // OneBot 段的 file 字段（可能是网关缓存文件名）
 * @property {string} [url]          // 临时鉴权 URL（**只存内存**，见 §5）
 * @property {string} mime           // 已知或嗅探出的 image/png|jpeg|gif|webp，未知为 ''
 * @property {number} bytes          // 已知字节数，未知为 0
 * @property {number} width          // 已知宽度，未知为 0
 * @property {number} height         // 已知高度，未知为 0
 * @property {string} name           // 展示名（basename，仅用于提示文本）
 */
```

导出：

```js
export function extractImageRefs(segments, opts = {})   // → MediaRef[]，最多 opts.max 张
export function mediaRefsFromStored(list)               // → 旧数据/脏数据归一化，永不抛
export function isProbablySafeCacheName(value)          // 参考项目的安全缓存名判定（无路径、无协议、无 ..）
export function stripSecretsFromUrl(url)                // → 布尔：该 URL 是否可作为持久化依据（本实现恒 false）
```

硬规则：

- `extractImageRefs` **不读磁盘、不发请求**，纯函数。
- 段里的 `file` 若形如 `base64://...`、`data:`、`http(s)://`，**不当作缓存名**，只当 URL/内联来源处理；`isProbablySafeCacheName` 只接受 `^[\w.+=@-]{1,512}$`。
- 未知字段一律丢弃，不原样透传（防止把上游私有字段写进会话 JSON）。

## 3. 受控取图（`image-fetch.mjs`）

```js
/**
 * @typedef {object} FetchDeps
 * @property {(input: {file: string}) => Promise<any>} [getImage]  // OneBot get_image
 * @property {string} [snowlumaDir]      // 允许读取的本地缓存根（未配置 = 禁止本地路径）
 * @property {(input: {url: string, maxBytes: number, timeoutMs: number}) => Promise<Buffer>} [fetchUrl]
 * @property {() => number} [now]
 */

/**
 * @param {MediaRef} ref
 * @param {object} opts
 * @param {object} opts.limits {maxBytes, maxPixels, timeoutMs}
 * @param {FetchDeps} opts.deps
 * @returns {Promise<{ok: true, buffer: Buffer, mime: string, width: number, height: number, via: string}
 *                 | {ok: false, code: string, reason: string}>}
 */
export async function fetchImage(ref, opts)
```

错误码（**不得混用**，界面与日志据此区分原因）：

| code | 含义 |
| --- | --- |
| `E3101` | 没有可用的取图来源（file/url 都不安全或都为空） |
| `E3102` | 网关 `get_image` 失败或无字节 |
| `E3103` | URL 抓取失败（DNS/连接/HTTP 状态） |
| `E3104` | 被安全策略拒绝（私网地址、重定向到私网、凭据 URL、非 http(s)） |
| `E3105` | 类型不是 PNG/JPEG/GIF/WebP（按魔数判定） |
| `E3106` | 超过字节上限 |
| `E3107` | 超过像素上限 |
| `E3108` | 本地缓存路径越界（不在 snowlumaDir 内 / realpath 逃逸 / 非普通文件） |
| `E3109` | 超时 |

优先级（与参考项目一致）：**安全的 `get_image` 缓存名 → inline（`base64://` / `data:`）→ 段内 URL → 本地缓存路径**。每一跳都必须过类型/字节/像素检查。

### 3.1 三处实现补充（vision-core 实现后回填，**已裁决**）

1. **inline 来源必须在链路上**。§2 已规定 `file` 里的 `base64://`/`data:` 不能当缓存名；如果 §3 的优先级里没有它，这类图会恒定报 `E3101`。所以顺序里显式插入 inline，且排在 `get_image` 之后（能走缓存名时优先走网关，请求更小、也避免把 base64 再解一遍）。
2. **`get_image` 返回值里的本机绝对路径这一路保留**，但必须完整过 `E3108` 的校验（`realpath` + 必须落在 `snowlumaDir` 内 + 普通文件）。`get_image` 的 `url` 字段同样走完整 URL 校验，不因为"是网关给的"就跳过。
3. **多来源都失败时，对外报优先级最高的那个原因**，其余码放进 `codes`。否则兜底的 `E3108`（未配置 `snowlumaDir`）会掩盖真正的 `E3102`（网关失败），把排查方向带偏。

### 3.2 像素不可知时的处理（**已裁决：放行**）

JPEG 的 SOF 段可能落在被截断的缓冲区之外，解析不出宽高是**正常**情况，不代表图有问题。此时跳过像素检查、只保留字节上限（`maxBytes` 本身已经挡住了"图片炸弹"的主要形态）。"不可知即拒绝"会把大量合法 JPEG 挡在门外，代价远大于收益。

### 3.3 持久层的投影函数（**已裁决：各写一份，用测试锁口径**）

`session/store.mjs` 与 `media-refs.mjs` 各有一份"六个键白名单"的归一化（`normalizeMediaItem` / `pickPersistedRef`）。
**有意不让 `session/store.mjs` import `media-refs.mjs`**：会话仓库是比 LLM 层更底层的模块，反向依赖会让"存消息"这件事开始依赖取图链路的实现。两份实现的一致性由测试保证（同一组脏输入必须产出同一个六键对象），而不是靠 import 强制。

两处**刻意不同**的一点，不要"修"：

- `store` 保留 `file` 为空的项 —— 图片确实在那条消息里，丢掉会让历史变成"没有图"，这是不实的展示；
- `vision` 的 `mediaRefsFromStored` 丢弃 `file` 为空的项 —— 取不到字节的引用每回合只会产生 `E3101` 噪音。

### 3.4 裁剪方向（**已裁决：按候选优先级裁，不按 floor**）

候选顺序是"本期 → 引用 → 历史（新→旧）"，这就是成本优先级。超上限时从尾部裁掉，因此本期消息的图永远不会被历史图挤掉 —— 这正是需求里的成本意图。不要改成纯按楼层号排序裁剪。

## 4. 预算与挑选（`vision.mjs`）

```js
export const VISION_LIMITS_HARD = Object.freeze({
  maxImagesPerTurn: 4,      // 本期消息
  maxHistoryImages: 3,      // 历史/引用
  maxBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPixels: 36_000_000,
  timeoutMs: 15000,
  historyWindow: 8,         // 只回看最近 N 楼
  cacheTtlMs: 5 * 60 * 1000,
  cacheMaxEntries: 32,
  cacheMaxBytes: 24 * 1024 * 1024,
});

/** 用户在配置里写的值夹到硬上限内 */
export function normalizeVisionConfig(raw) // → 完整、已夹取的配置对象

/**
 * 组装一回合的图片清单。
 * @returns {Promise<{
 *   images: Array<{messageId, floor, index, dataUrl, mime, bytes, width, height, label, origin: 'current'|'history'|'quoted'}>,
 *   notes: string[],            // 追加进提示的说明（数量/降级原因），空数组表示无需说明
 *   stats: {attempted, loaded, skipped, bytes},
 *   codes: string[],            // 失败码，供运行时统计
 * }>}
 */
export async function collectTurnImages(input)
```

`collectTurnImages` 的输入（全部由宿主注入，模块自己不碰全局）：

```js
{
  config,                 // 已 normalize 的 vision 配置
  convKey, isGroup,
  trigger: { messageId, evt },      // 本次触发的消息（可能为空：主动回合）
  quoted: { messageId, evt } | null, // 已由宿主做过会话归属校验
  history: Array<{floor, messageId, evt, imagesSeen: boolean}>, // 宿主按楼层升序给
  alreadySeen: Set<number>,          // 已提交过图片的楼层
  deps: FetchDeps,
  now: () => number,
}
```

挑选规则（**成本控制的落点**）：

1. 本次消息：最多 `maxImagesPerTurn` 张，全部尝试。
2. 引用消息：`includeQuoted` 为真且与本次消息不是同一条时，最多 `maxImagesPerTurn` 张，排在本期之后。
3. 历史：只取 `historyWindow` 内、`imagesSeen === false`、且不在 `alreadySeen` 里的楼层，从新到旧，最多 `maxHistoryImages` 张。
4. **总预算**：`maxTotalBytes` 与 `maxImagesPerTurn + maxHistoryImages` 双重上限；超了从最旧的开始丢，并记一条 note。
5. 同一张图（同 messageId + 同 file/url）在一次调用内不重复取。
6. 一旦某楼被真的提交，宿主必须把它记入 `alreadySeen`（持久化），下一回合不再提交 —— 这是"避免每轮重复提交历史图片"的唯一机制。

## 5. 缓存边界

- 图片字节**只进内存缓存**（`fetchedAt` + TTL + 条数/字节双上限）。
- **绝不把 base64 写进 `sessions.json`**；持久层只允许 `{kind, file, mime, bytes, width, height, name}`。
- URL（可能带鉴权参数）**不落盘**；重启后 URL 丢失是预期行为，取图退回 `get_image` 或直接降级。
- 内存缓存在 `convKey + messageId + index` 维度命中，跨回合复用；TTL 到期即失效，不主动刷新。

## 6. 提示层接口（`prompt.mjs`）

`context.recent` 的每一项新增**可选**字段：

```js
images?: Array<{dataUrl: string, mime: string, label?: string}>
```

`buildMessages` 的产出规则：

- `images` 为空 / 非法 → `content` 仍是**字符串**（文本模型与旧调用完全不变，逐字节兼容）。
- `images` 非空 → `content` 是数组：
  ```js
  [{ type: 'text', text: '小明：看这个' },
   { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }]
  ```
- `assistant` / `system` 消息**永不**带 `image_url`。
- 数组里第一个元素永远是 text（部分上游要求 text 必须在最前）。
- 每张图最多 `MAX_IMAGES_PER_MESSAGE`（=4）张，多余忽略（不报错）。
- `dataUrl` 必须匹配 `^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$`，否则该图被丢弃（防止把任意字符串塞进请求体）。

## 7. 工具结果的图像回灌（`agent-loop.mjs`）

工具 `run()` 可以返回结构化结果：

```js
{ ok: true, result: { text: '消息 123 的媒体内容（1 项）', images: [{ dataUrl, mime, label }] } }
```

`runTurn` 的处理：

1. `tool` 角色的消息**仍然只放文本**（`wrapToolResult(name, result.text ?? JSON.stringify 其余字段)`），并写明"（附 N 张图片，见下一条消息）"。
2. 紧接着追加一条 `user` 角色消息，`content` 为 `[{type:'text', text:'（工具 xxx 取回的图片）'}, {type:'image_url',...}]`。
3. 这样既不破坏 tool 消息的协议兼容性，又保证图像真的进到模型上下文（而不是 base64 被截断成字符串）。

`result` 里除 `text`/`images` 之外的字段照旧 `JSON.stringify` 进文本（保持现有语义）。

## 8. 降级矩阵（`index.mjs`）

| 开关 | 能力探测 | 行为 | 界面提示 |
| --- | --- | --- | --- |
| 关 | 任意 | **不取图、不提交**；消息文本仍是 `[图片]` | 「视觉已关闭：图片只会以占位文字出现」 |
| 开 | `true` | 正常带图 | 「读图已开启（已实测支持）」 |
| 开 | `false` | 不取图；文本占位追加「（当前模型已实测不支持读图）」 | 「读图已关闭：模型已实测不支持」 |
| 开 | `null` / 未探测 | **仍然尝试**带图；被上游拒收时自动去图重试一次并落记录 | 「读图已开启（未探测，将按上游实际反应降级）」 |
| 开 | 任意 | 取图失败/过期 | 文本占位追加一次原因，**不写进 capabilities** | 「本回合有 N 张图取不到：<原因>」 |

"图像被拒收"的判定在 `client.mjs` 导出：

```js
export function looksLikeImageRejection(status, message) // → boolean
```

只在状态码 400/413/415/422 且文本命中图片相关关键词时返回 true；401/403/429/5xx 一律 false（那是 key/额度/服务问题，不是"不支持图片"）。

## 9. 配置形状（`config/schema.mjs`）

```js
vision: {
  enabled: false,
  maxImagesPerTurn: 3,
  maxHistoryImages: 2,
  maxBytes: 4194304,
  maxTotalBytes: 8388608,
  maxPixels: 36000000,
  timeoutMs: 8000,
  historyWindow: 6,
  includeQuoted: true,
  cacheTtlMs: 300000,
}
```

- 全部字段必须在 `DEFAULT_CONFIG` 与 `config.example.json` 中同时出现（`test/config-parity.test.mjs` 会查）。
- `validateConfig` 必须校验：`enabled` 布尔、`maxImagesPerTurn` 1–4、`maxHistoryImages` 0–3、`historyWindow` 0–8 整数、字节与像素为正整数且不超过硬上限的 2 倍、`timeoutMs` 1000–30000、`cacheTtlMs` 60000–3600000。

### 9.1 配置区间与硬上限的分工（**已定，勿再当成冲突**）

契约 §9 的区间是「允许写进 config.json 的范围」，§4 的 `VISION_LIMITS_HARD` 是「运行时真正生效的上限」。
两者**故意不同**，方向是"写入宽松、生效收紧"，理由与 `reply.maxMessages` 一致：

| 项 | 配置层允许 | 运行时夹到 | 为什么 |
| --- | --- | --- | --- |
| `timeoutMs` | 1000–30000 | ≤ 15000 | 用户想放宽是合理需求；但单张图 15 秒还取不回来，基本就是源不可达，再等只会拖死整个回合 |
| `cacheTtlMs` | 60000–3600000 | ≤ 300000 | 缓存过期不刷新，超过 5 分钟的图片很可能已被上游回收 |
| `maxBytes` / `maxTotalBytes` / `maxPixels` | ≤ 硬上限 ×2 | 硬上限 | 允许"想更宽松"，但真正提交给模型前必须守住字节/像素炸弹边界 |

**界面的责任**：显示 `limits`（夹取后实际生效的值），而不是配置里的原始值，并说明"填得更大能保存，但会按 X 生效"。vision-ui 已按此实现。

**判定 `effective: 'on-but-blocked'`**（原先 §10 有值、§8 无定义，现补齐）：

- 仅当 `enabled === true` 且 `capability.supported !== false`，且**最近一回合**满足 `runtime.lastTurn.attempted > 0 && runtime.lastTurn.loaded === 0` 时产出。
- 语义是"开关和能力都没问题，但这一回合一张图都没取到"，和 `off`（用户关了）、`on-unsupported`（模型不能）都不是一回事。
- 因此运行时统计**必须**记录 `lastTurn: {attempted, loaded, bytes, codes}`，不能只累计总数。没有这一格，`on-but-blocked` 就是死代码。

**`runtime.lastAt` 单位**：毫秒时间戳（`Date.now()`），与快照其他时间字段一致；`render.mjs` 的 `clock()` 会自动识别。

## 10. 运行时快照（`index.mjs` 的 snapshot）

```js
vision: {
  enabled: boolean,                 // 开关状态（用户意图）
  limits: { ...normalizeVisionConfig(config.vision) },
  capability: {                     // 能力探测结果（与开关无关）
    probed: boolean, supported: true|false|null,
    model: string, basis: string, detail: string, probedAt: string|null,
  },
  effective: 'off'|'on'|'on-unprobed'|'on-unsupported'|'on-but-blocked',
  runtime: {
    turnsWithImages: number, imagesSubmitted: number, bytesSubmitted: number,
    skipped: number, lastCodes: string[], lastNotes: string[], lastAt: number|null,
  },
}
```

界面必须**分两块**展示 `enabled` 与 `capability`，并单独一行展示 `effective`（"实际效果"）。

## 11. 设置项

`setting` 通道新增前缀 `vision.`：

```js
vision.enabled | vision.maxImagesPerTurn | vision.maxHistoryImages | vision.maxBytes
| vision.maxTotalBytes | vision.maxPixels | vision.timeoutMs | vision.historyWindow
| vision.includeQuoted | vision.cacheTtlMs
```

- 类型/范围校验在 `index.mjs` 的 `applyVisionSetting`，非法值返回 `E40XX`，**不落盘**。
- 保存成功后 `persistConfig()`，并清空运行时统计里的"上回合"字段（避免界面显示旧状态）。

## 12. 测试基线（谁写谁测）

| 文件 | 覆盖 |
| --- | --- |
| `test/vision-core.test.mjs` | 段→元数据、安全缓存名、魔数、尺寸解析、像素/字节/超时、URL 私网与重定向、本地路径越界、get_image 失败、缓存 TTL、预算与去重 |
| `test/vision-history.test.mjs` | 持久化媒体元数据、旧数据（无 media 字段）兼容、`imagesSeenFloors` 修剪、重启后只靠 file 的降级 |
| `test/vision-prompt.test.mjs` | 字符串/数组两种 content、非 image 段不出现 image_url、非法 dataUrl 丢弃、tool 结果图像回灌顺序 |
| `test/vision-page.test.mjs` | 开关与探测结果分区渲染、effective 文案、保存失败提示 |
| `test/vision-wiring.test.mjs` | 关闭时不取图（用 spy 断言零调用）、能力 unknown 仍带图、supports=false 不带图、上游拒图后去图重试并记录、历史图只提交一次、引用图归属校验 |

**全部使用本地模拟**：不连真实 QQ、不调收费模型（`fetch` 与 `getImage` 全部注入假实现）。
