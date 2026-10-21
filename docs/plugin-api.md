# Ling-bot 插件接口 v1

本文是**宿主与插件之间的唯一契约**。插件包只要满足这里的规定，就可以通过更新磁盘上的文件来扩展 Ling-bot，不需要修改主程序源码，也不需要重新编译 exe。

- 契约版本：`apiVersion = "1"`（宿主当前只接受主版本 `1`）
- 宿主实现：`src/plugins/`
- 插件出厂示例：`plugins/dsh-bridge/`（DSH 接入，内置）、`plugins/echo/`（最小工具插件）
- 模板：`docs/plugin-template/`

> 先说清楚安全边界：**独立进程不是安全沙箱。**
> 它防的是「一个插件卡死/崩溃拖垮主程序」，不是「恶意插件干坏事」。
> 装插件等于在自己电脑上运行别人写的程序，只装信得过的。真正的授权边界仍然在
> `src/guard/tool-gate.mjs`：它决定「模型能调用什么」，与插件代码本身的能力无关。

---

## 1. 插件包布局

```
<userData>/plugins/<plugin-id>/
  plugin.json      # 必需：清单（唯一事实来源）
  index.mjs        # 必需：入口（清单 entry 可改名）
  ...              # 插件自带资源
```

- 目录名**必须**等于清单里的 `id`（否则拒绝加载，避免"启用哪个"无法推理）。
- 以 `.` 或 `_` 开头的目录会被跳过（可用来放模板/备份）。
- 插件包内**不能**包含用户配置、密钥、运行数据。这些由宿主统一管理（见 §6）。
- 插件目录里不要放 `node_modules`：宿主不安装依赖，插件必须自包含（纯 ESM，或自带单文件依赖）。

用户数据目录（Windows 默认 `%APPDATA%\ling-bot`）：

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `plugins/<id>/` | 插件代码 | 安装/更新时整体替换，保留失败回退 |
| `config.json` → `plugins.config.<id>` | 用户配置 | 非敏感配置，明文，由宿主原子写入 |
| `plugin-secrets.vault` | 用户凭据 | 敏感配置，DPAPI 加密，绑定当前 Windows 账户 |
| `plugin-data/<id>/` | 运行数据 | 插件自己的缓存/状态，升级不覆盖 |
| `plugins/.backup/<id>-<ts>/` | 回退副本 | 安装失败时自动回滚 |

---

## 2. `plugin.json` 清单

```json
{
  "id": "echo",
  "name": "回声",
  "version": "1.0.0",
  "apiVersion": "1",
  "description": "最小示例插件：把文字原样回显，附带一组配置项演示自动表单。",
  "author": "ling-bot",
  "runtime": "process",
  "entry": "index.mjs",
  "permissions": ["qq.read"],
  "config": [
    {
      "key": "prefix",
      "label": "前缀",
      "type": "text",
      "default": "",
      "required": false,
      "maxLength": 40,
      "help": "回显时加在文字前面的内容。"
    }
  ],
  "tools": [
    {
      "name": "echo",
      "description": "把传入的文字原样回显。",
      "needs": "qq",
      "risk": "R0",
      "timeoutMs": 10000,
      "params": {
        "text": { "type": "string", "required": true, "description": "要回显的文字", "maxLength": 4000 }
      }
    }
  ],
  "notes": [
    { "title": "怎么用", "lines": ["在插件页填好配置并启用后，AI 就能调用 plugin_echo。"] }
  ],
  "ui": null
}
```

### 2.1 顶层字段

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `id` | 是 | `^[a-z][a-z0-9-]{1,40}$`，且等于目录名。稳定不变，改名视为另一个插件 |
| `name` | 是 | 显示名，1–60 字符 |
| `version` | 是 | `x.y.z` 语义化版本，1–32 字符 |
| `apiVersion` | 是 | `"1"`；宿主只接受主版本 1，其它值状态为「接口不兼容」 |
| `description` | 是 | 1–500 字符，插件页列表直接显示 |
| `author` | 否 | 作者/来源，≤80 字符 |
| `runtime` | 否 | `"process"`（默认）或 `"in-process"` |
| `trusted` | 否 | `runtime: "in-process"` 时**必须**为 `true`。只有随包内置/第一方插件才这么写 |
| `entry` | 否 | 默认 `index.mjs`；必须是包内相对路径，禁止 `..` |
| `permissions` | 否 | 能力声明数组，仅用于展示与审计，**不构成授权**。见 §2.5 |
| `config` | 否 | 配置项声明数组，最多 40 项，见 §3 |
| `tools` | 否 | 工具声明数组，最多 32 个，见 §4。可以为空（纯通道插件） |
| `handleMessage` | 否 | `true` 表示这是**纯通道插件**：没有工具，但要接管 QQ 消息。声明了它就允许 `tools` 为空（见 §5）。仅 `trusted: true` 的 `in-process` 插件可用 |
| `notes` | 否 | `[{ title, lines: string[] }]`，插件页「说明」卡片，最多 10 组 |
| `ui` | 否 | 专用页面声明，见 §8。当前宿主保留接口但未开放渲染 |

未知顶层字段会被忽略（向前兼容），但拼错的 `config`/`tools` 不会被猜。

### 2.2 运行时

| runtime | 适用 | 行为 |
| --- | --- | --- |
| `process`（默认） | 所有第三方插件 | 宿主用独立 Node 子进程加载插件；调用有超时，超时/崩溃只杀子进程，主程序继续运行；下一次调用会尝试自动重启（连续 3 次失败后转为 `error`，需在插件页点「重载」） |
| `in-process` | 仅 `trusted: true` 的内置插件 | 与后端同进程，便于提供 HTTP 监听、消息接管等能力；宿主仍做 try/catch 与超时，但**无法在插件死循环时强杀**，崩溃可能影响主程序 |

普通动态 `import()` 不构成隔离。第三方插件一律走 `process`。

### 2.3 工具命名

- 插件内工具名：`^[a-z][a-z0-9_]{1,32}$`，同一插件内不得重复。
- 对 AI 暴露的完整工具名：`plugin_<工具名>`（与既有内置约定一致）。
- 完整名与任何已登记工具（内置或其它插件）冲突时，**整个插件拒绝启用**并明确报错，不做静默覆盖。
- 一个插件里任何一个工具声明不合法，整个插件不启用（避免"部分加载"的状态歧义）。

### 2.4 权限要求（工具）

| 字段 | 含义 |
| --- | --- |
| `needs: "host"` | 需要动本机：只对「主人私聊」与「桌面端控制台」可见，群里不可见 |
| `needs: "qq"` | 只动 QQ：主人私聊 + 主人所在群 + 桌面端 |
| `risk: "R0"` | 只读无副作用，自动执行 |
| `risk: "R1"` | 只读敏感 / 有外部影响，每次调用需人工确认 |
| `risk: "R2"/"R3"` | 写入/执行/不可逆，默认拒绝；需在插件页显式打开「允许高风险工具」 |

`origins` 与 `confirm` **由宿主推导**，插件在清单里写这两个字段会被忽略。

### 2.5 `permissions` 能力声明（仅展示）

建议使用以下词汇，宿主原样展示在插件页「权限」一栏：

`host.fs`（读写本机文件）、`host.net`（访问网络）、`host.exec`（执行命令）、
`qq.read`（读取 QQ 消息）、`qq.send`（发送 QQ 消息）、`host.net.loopback`（仅本机回环端口）。

这些字符串不参与授权判定；实际能不能被模型调用，由 §2.4 的 `needs`/`risk` 与
`guard/tool-gate.mjs` 决定。

---

## 3. 配置项声明

宿主根据 `config` 数组自动生成表单，并把用户填的值持久化。**插件新增配置项只需要更新 `plugin.json`，不需要改主程序页面。**

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `key` | 全部 | `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`，同一插件内唯一 |
| `label` | 全部 | 表单标签，缺省用 `key` |
| `type` | 全部 | `text` / `textarea` / `password` / `number` / `boolean` / `enum` |
| `default` | 全部 | 默认值，必须符合类型。`secret: true` 的字段**禁止**写默认值（宿主直接拒绝，报 E4041）——默认值会以明文留在插件包里，那正是密钥最不该待的地方 |
| `required` | 全部 | 必填。缺失时插件状态为「待配置」，不可启用 |
| `secret` | text/textarea/password | `true` = 敏感信息，由宿主加密保存、界面不回显、不进日志 |
| `help` | 全部 | 字段下方说明文字，≤300 字符 |
| `placeholder` | 文本类 | 输入框占位文字 |
| `maxLength` | text/textarea/password | 最大长度，text 默认 512，textarea 默认 8000 |
| `pattern` | text/textarea/password | 正则（锚定），不匹配则拒绝保存 |
| `min` / `max` / `integer` | number | 数值范围与整数约束 |
| `options` | enum | `["a","b"]` 或 `[{ "value": "a", "label": "A" }]`，1–50 项 |
| `generate` | 密钥类 | 目前只支持 `"token"`：界面提供「生成」按钮（32 字节随机 base64url） |

规则：

- `type: "password"` 隐含 `secret: true`。
- `secret` 字段的值**永远不写进 `config.json`**，只进 `plugin-secrets.vault`；快照里只给 `hasSecret: true` 与空值。
- 保存时若密钥字段留空且此前已保存过，则保留原值（避免"改端口把令牌清掉"）。
- 配置里出现未声明的键会被丢弃（插件删掉字段后旧值不残留）。

---

## 4. 工具声明

```json
{
  "name": "dsh_ask",
  "description": "把一句话交给 DSH 执行（DSH 会真的动手）。返回「已投递」。",
  "needs": "host",
  "risk": "R1",
  "timeoutMs": 30000,
  "params": {
    "text": { "type": "string", "required": true, "maxLength": 4000, "description": "要交给 DSH 的指令" },
    "sessionId": { "type": "string", "required": false, "description": "投给哪个 DSH 会话" }
  }
}
```

- `params` 与既有工具系统一致：`type` 支持 `string` / `number` / `boolean` / `array`；
  另有 `required`、`description`、`maxLength`、`maxItems`、`enum`、`items`。
- `timeoutMs`：单次调用超时，默认 `20000`，上限 `120000`。超时后：`process` 运行时直接杀掉子进程并记为失败；`in-process` 运行时只能中断信号与记失败。
- 返回值必须是 **JSON 可序列化**且 ≤ 256KB 的对象；否则按执行失败处理（`E4066`）。
- 插件返回 `{ ok: false, code, message }` 是合法的**工具结果**（会回灌给模型），不是宿主异常。

---

## 5. 入口模块（`index.mjs`）

入口 `export default` 一个对象，实现以下钩子。所有钩子都可以省略，但至少要实现 `callTool`（声明了工具时）或 `handleMessage`（纯通道插件）。

```js
export default {
  /**
   * 初始化。启用插件时调用；配置保存后若已启用，宿主会先 dispose 再 init。
   * 抛错或返回 { ok:false } = 初始化失败，插件状态转为「初始化失败」，工具不会进入 AI 工具列表。
   * @param {PluginContext} ctx
   */
  async init(ctx) {},

  /**
   * 执行一个工具。
   * @param {{ tool: string, args: object, ctx: PluginContext, signal: AbortSignal }} input
   * @returns {Promise<any>} JSON 可序列化结果
   */
  async callTool({ tool, args, ctx, signal }) {},

  /**
   * 测试连接 / 自检。可以不在初始化状态下调用：不要依赖 init 里建的运行时单例。
   * @returns {Promise<{ok: boolean, message?: string, details?: object}>}
   */
  async testConnection(ctx) {},

  /**
   * 停用 / 重载前释放资源（关端口、清定时器、落盘）。
   * 宿主最多等 3 秒，超时只记日志，不阻塞停用。
   */
  async dispose(ctx) {},

  /**
   * 可选：接管 QQ 消息（返回 true 表示已处理，不再走 AI 回合）。
   * 仅 in-process 运行时支持；process 运行时不会收到消息。
   * @param {{ evt: object, sendText: (convKey: string, text: string) => Promise<any>, ctx: PluginContext }} input
   */
  async handleMessage({ evt, sendText, ctx }) {},
};
```

### 5.1 `PluginContext`

```js
{
  plugin: { id, name, version, dir, dataDir, runtime },
  config: { /* 已校验的配置值（含默认值，不含密钥） */ },
  secrets: { /* 密钥字段的明文，仅在插件进程内可见 */ },
  log: (level: 'debug'|'info'|'warn'|'error', message: string, fields?: object) => void,
  sendText: (convKey: string, text: string) => Promise<{ok: boolean, messageId?: any, message?: string}>,
  dataDir: string,           // 等于 plugin.dataDir，方便直接用
  signal: AbortSignal,       // 插件整体停用时中断
}
```

- `sendText` 仍然走宿主的发送闸门（白名单、频率、审计）；插件拿不到 `client`、`config` 之外的宿主对象。
- 日志会带上插件 id 写进主日志，同时进入插件页的「最近日志」（保留最近 50 条）。
- `process` 运行时下，`log`/`sendText` 由宿主代理实现，行为一致。

### 5.2 生命周期

```
扫描目录 → 校验清单与接口版本 → 读取启用状态与配置
        → 校验配置（必填/类型/规则）
        → 初始化已启用且配置有效的插件（init）
        → 登记工具（冲突则整个插件失败）
        → AI 可见 / 可调用（每次调用仍过宿主授权与确认）
停用 → 立即注销工具（阻止新调用）→ 中断/等待在途调用 → dispose
```

- 启用失败不会留下"半个插件"：工具要么全部登记，要么一个都不登记。
- 单个插件加载失败、初始化超时或崩溃，不影响其它插件与主程序。
- 保存配置后：已启用且配置有效的插件会**重新初始化并立即生效**；确实需要重启才能生效的，返回 `restartRequired: true`，界面明确提示。
- 插件包更新后（版本号或文件变化），状态显示「有更新，重启后端或点重载后生效」。

---

## 6. 配置与密钥的归属

| 数据 | 存放 | 谁能读 |
| --- | --- | --- |
| 插件代码 | `plugins/<id>/` | 所有人（就是磁盘上的文件） |
| 普通配置 | `config.json` → `plugins.config.<id>` | 插件（通过 ctx.config）、界面 |
| 敏感凭据 | `plugin-secrets.vault`（DPAPI） | 仅当前 Windows 账户 + 插件进程 |
| 运行数据 | `plugin-data/<id>/` | 插件自己 |

- 宿主是配置的唯一写入方：插件不得自己写 `config.json` 或保险箱。
- 界面快照里密钥字段永远为空串 + `hasSecret` 标记，**不回显明文**。
- 保险箱解不开（换机器/换账户）时，插件状态显示「凭据不可用」，不会静默当成空值。

---

## 7. 状态与错误码

插件状态（界面直接展示，不允许"看起来正常但其实没跑"）：

| status | 含义 |
| --- | --- |
| `disabled` | 已安装但未启用 |
| `needs-config` | 已启用或待启用，但必填配置缺失/不合法 |
| `starting` | 正在初始化 |
| `ready` | 正常运行，工具已进入 AI 工具列表 |
| `error` | 初始化/运行失败（附错误码与原因） |
| `crashed` | 子进程崩溃，等待重载或自动重启 |
| `invalid` | 清单不合法 |
| `incompatible` | 接口版本不兼容 |
| `missing` | 启用列表里有，但磁盘上找不到插件目录 |
| `stale` | 插件包已更新，等待重载/重启 |

| 错误码 | 含义 |
| --- | --- |
| `E4041` | 清单/工具/配置声明不合法 |
| `E4042` | 工具声明了 R2/R3，但未打开「允许高风险工具」 |
| `E4043` | 工具名与已登记工具冲突 |
| `E4044` | 插件目录/入口文件不存在 |
| `E4045` | 入口导入失败 |
| `E4060` | 缺少 `plugin.json` |
| `E4061` | `apiVersion` 不兼容 |
| `E4062` | 配置值不合法（类型/范围/规则） |
| `E4063` | 配置不完整（缺必填项） |
| `E4064` | 初始化失败 |
| `E4065` | 工具执行超时 |
| `E4066` | 工具执行异常 / 返回值不可序列化 |
| `E4067` | 插件未启用或未就绪 |
| `E4068` | 插件未实现测试连接 |
| `E4069` | 安装/更新失败（已回滚） |
| `E4101` | 本机无法使用加密存储（DPAPI 不可用） |

---

## 8. 专用页面与侧栏入口（可选，边界已预留）

清单可以声明：

```json
"ui": { "page": "ui/page.mjs", "title": "我的插件", "sidebar": true }
```

宿主会校验路径、在插件页显示「该插件声明了专用页面」并在快照里给出
`ui: { page, title, sidebar, available: false, reason }`。

当前版本 `available` 恒为 `false`：界面资源随 exe 内嵌，加载磁盘上的任意 ESM
需要宿主提供新的资源协议（CSP `script-src 'self'` 不允许直接 import 用户目录）。
将来开放时只需要：

1. 宿主新增一个只读资源协议/端点，按插件 id 提供 `ui/page.mjs`；
2. 前端 `registerPluginPage(def)`（见 `ui/src/app.mjs`）把导航项与渲染函数接上；
3. 插件清单的 `ui` 字段形状不变。

在开放之前，插件应把可配置项全部放进 `config`，用自动表单管理，不要依赖专用页面。

---

## 9. 安装、更新与回退

- 宿主安装/更新时先在 `plugins/.staging/<id>-<随机>/` 完整落盘并校验清单，
  校验通过后再替换到 `plugins/<id>/`；替换前把旧目录移到 `plugins/.backup/`。
- 任一步失败：删除暂存目录，恢复备份，状态显示 `E4069`，不会留下"半包"。
- 插件更新不覆盖 `plugin-data/<id>/`、`plugins.config.<id>` 与密钥。
- 第一阶段允许"更新插件包 → 重启应用（或点插件页的「重载」）→ 生效"，不要求热更新。

---

## 10. 宿主快照与 RPC 形状（界面契约）

界面只通过既有三个 RPC 方法工作（不新增通道）：

### 10.1 `snapshot` 里的 `plugins`

```js
plugins: {
  enabled: string[],          // 兼容旧字段：启用中的插件 id
  allowDangerous: boolean,    // 是否允许 R2/R3 工具
  loaded: [...],              // 兼容旧字段：{ id, name, ok, tools, status, message }
  skipped: string[],          // 兼容旧字段：已安装但未启用的 id
  items: [PluginView],        // 插件页的数据源
  stats: { total, ready, error, disabled },
  dirs: { plugins, data },    // 只读展示用
}

// PluginView
{
  id, name, version, description, author, apiVersion,
  runtime, trusted,
  enabled, installed,
  status,                     // 见 §7
  statusText,                 // 中文短语，直接显示
  error: { code, message } | null,
  restartRequired,            // 保存配置后确需重启
  hasUpdate,                  // 磁盘上的插件包版本与已加载的不同
  tools: [{
    name, fullName, description, needs, risk, confirm,
    timeoutMs, params,          // confirm 由宿主推导，只读展示
    enabled,                    // 该插件当前是否 ready
  }],
  config: [{                    // 自动表单的数据源
    key, label, type, secret, required, help, placeholder,
    default, options, min, max, maxLength, integer, pattern, generate,
    value,                      // 非密钥字段的当前值；密钥字段恒为 ''
    hasSecret,                  // 密钥字段是否已保存
    missing,                    // 必填但未填
  }],
  permissions: string[],
  notes: [{ title, lines }],
  ui: { page, title, sidebar, available, reason } | null,
  log: [{ at, level, message }],   // 最近 50 条
  dir, dataDir,
  lastErrorAt,
}
```

### 10.2 `action` 名称

| action | 参数 | 返回 |
| --- | --- | --- |
| `plugin.enable` | `{ id }` | `{ ok, status, restartRequired?, message? }` |
| `plugin.disable` | `{ id }` | `{ ok, cancelled: number }` |
| `plugin.saveConfig` | `{ id, config: {...}, secrets: {...} }` | `{ ok, applied, restartRequired, message }` |
| `plugin.test` | `{ id }` | `{ ok, message, details? }` |
| `plugin.reload` | `{ id }` | `{ ok, status, message? }` |
| `plugin.rescan` | `{}` | `{ ok, added: string[], removed: string[] }` |
| `plugin.install` | `{ path }` | `{ ok, id, version, backup?: string }` |

`setting` 通道保留 `plugins.enabled`（数组）与 `plugins.allowDangerous`（布尔）以兼容旧界面与脚本，内部委托给同一套管理器。

## 11. 验收清单（新增一个工具插件，零主程序改动）

1. 把插件包放到 `<userData>/plugins/<id>/`（或调用宿主的安装能力）。
2. 重启后端（或插件页点「重新扫描」）→ 插件出现在列表，状态「已安装未启用」。
3. 在插件页填配置并保存 → 重启后配置仍在；密钥只显示「已设置」。
4. 启用 → 状态「运行中」，工具出现在「工具清单」；AI 能看到并按授权调用。
5. 停用 → 工具立即从 AI 工具列表消失，新的调用被拒绝（`E4067`）。
6. 插件更新（加工具/加配置项/改实现）→ 只需替换插件包，主程序源码与 exe 不变。
7. 插件初始化失败、崩溃或超时 → 插件页显示错误码与日志，主程序继续正常运行。

可执行验收脚本：`scripts/e2e-plugins.mjs`（真实后端 stdio JSON-RPC）。
