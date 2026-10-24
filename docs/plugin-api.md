# Ling-bot 插件接口 v1

本文是**宿主与插件之间的唯一契约**。插件包只要满足这里的规定，就可以通过更新磁盘上的文件来扩展 Ling-bot，不需要修改主程序源码，也不需要重新编译 exe。

- 契约版本：`apiVersion = "1"`（宿主当前只接受主版本 `1`）
- 宿主实现：`src/plugins/`
- 插件出厂示例：`plugins/dsh-bridge/`（DSH 接入，内置）、`plugins/echo/`（最小工具插件）
- 模板：`docs/plugin-template/`

> **本次扩展没有升 `apiVersion`**，因为全部是向后兼容的加法：
> 工具多了一个可选的 `effects`、配置多了一个可选的 `plugins.chatTools`、
> `PluginContext` 多了 `caller` 与 `chat`。不写这些字段的旧插件行为完全不变，
> 所以不需要"接口不兼容"。反过来，读了本文的插件作者要注意：**这几个字段是宿主判定权限的输入**，
> 不是可选装饰，用到对应能力时必须声明（见 §2.4、§4.2、§5.2、§5.3、§5.4）。

> **有一个变化不是"可选的"**，升级时务必注意：
> 插件工具在**群聊 / 陌生人私聊 / 主动回合**里，现在默认**完全不可见**，
> 必须由管理员在 `plugins.chatTools` 里点名（§2.6）。
> 也就是说，改造前"装上就能在群里用"的插件，升级后需要多一步授权——
> 这是有意的收紧，不是回归。

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
      "effects": ["data.read"],
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

（上面 `effects: ["data.read"]` 是演示写法：它有 R0 下限，不改变这个工具的生效风险。
不声明 `effects` 同样合法——只做纯回显、不碰数据与聊天的工具本来就没有可声明的行为。）

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
| `messagePriority` | 否 | `"normal"`（默认）或 `"low"`。宿主先派发给 `normal` 插件，再派发给 `low`。仅 `in-process` 且 `handleMessage: true` 的插件可声明，否则清单不合法（见 §2.7） |
| `validateConfig` | 否 | `true` 表示保存配置**落盘之前**先调插件的 `validateConfig(config)` 自校验（见 §2.8）。缺省 `false`。仅 `in-process` 且 `trusted: true` 的插件可声明 |
| `notes` | 否 | `[{ title, lines: string[] }]`，插件页「说明」卡片，最多 10 组 |
| `ui` | 否 | 专用页面声明，见 §8。当前宿主保留接口但未开放渲染 |

未知顶层字段会被忽略（向前兼容），但拼错的 `config`/`tools` 不会被猜。
`messagePriority` 与 `validateConfig` 已加入**已识别字段**列表（不再算"未知字段"），
所以写错它们的**值**会直接报 `E4041`，不会像未知字段那样被静默忽略。

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
| `needs: "host"` | 需要动本机：只对「主人私聊」与「桌面端控制台」可见；群里、普通私聊、主动回合都不可见 |
| `needs: "qq"` | 只动 QQ：主人私聊 + 主人所在群 + 桌面端；**群友来源还要额外过 §2.6 的授权** |
| `risk: "R0"` | 只读无副作用，自动执行 |
| `risk: "R1"` | 只读敏感 / 有外部影响，每次调用需人工确认 |
| `risk: "R2"/"R3"` | 写入/执行/不可逆，默认拒绝；需在插件页显式打开「允许高风险工具」 |
| `effects: string[]` | 这个工具**会做什么**（见 §4.2）。它不替代 `risk`，而是给 `risk` 立一个下限 |

`origins` 与 `confirm` **由宿主推导**，插件在清单里写这两个字段会被忽略。

`needs` 与 `risk` 管的是"**最多能去哪**"；能不能真的到达群聊/陌生人私聊/主动回合，
还要看管理员有没有在 `plugins.chatTools` 里点名（§2.6）。两层是**与**的关系：
任何一层不通过，工具就不出现。少了哪一层都不行——
只有 `needs` 等于"作者自己给自己发授权"，只有 `chatTools` 等于"管理员能绕开声明"。

### 2.4.1 为什么 `risk` 不再由插件一个人说了算

原来的模型是「插件自己声明 `risk`，宿主照抄」。这在只有内置工具时没问题，
但插件是第三方写的，而 `risk` 直接决定「要不要弹确认」。于是一个很自然的
退化路径就出现了：**作者希望自己的工具"好用、不用每次点确认"，于是写 `risk: "R0"`。**

单看每个插件都算合理，合起来就是：所有插件都自动执行，确认机制事实上不存在。

所以现在改成两个输入：插件用 `risk` 表达「我打算做多危险的事」，
用 `effects` 表达「我实际会碰哪些东西」；宿主取**两者的较大值**，即

```
最终风险 = max(声明 risk, effects 推导下限)
```

- 只会被抬高，不会被打折。插件写 `risk: "R3"` + `effects: ["data.read"]`，结果仍是 R3。
- 漏写 `effects` 不会让工具"降级成只读"——`risk` 仍然有效；反过来，写全 `effects`
  也不能把 R3 洗成 R0。

注意这条规则只影响**风险档与确认策略**；工具能不能出现在某个来源，还由
`needs` 与 §2.6 的聊天来源授权共同决定。两者是串联的，不是二选一。

### 2.5 `permissions` 能力声明（仅展示）

建议使用以下词汇，宿主原样展示在插件页「权限」一栏：

`host.fs`（读写本机文件）、`host.net`（访问网络）、`host.exec`（执行命令）、
`qq.read`（读取 QQ 消息）、`qq.send`（发送 QQ 消息）、`host.net.loopback`（仅本机回环端口）。

这些字符串不参与授权判定；实际能不能被模型调用，由 §2.4 的 `needs`/`risk`、
§4.2 的 `effects` 与 §2.6 的聊天来源授权共同决定。

### 2.6 聊天来源授权：`config.plugins.chatTools`

§2.4 解决的是「这个工具多危险」，这一节解决另一个问题：**群里的群友，
凭什么能用到插件工具？**

原来的答案是「`needs: "qq"` 就能进群」。但 `needs` 是作者自己写的，
它只说明"这个工具属于 QQ 这一类"，从没表示过"管理员同意让群友用它"。
一个插件只要声明 `needs: "qq"` + `risk: "R0"`，就能在任何一个白名单群里被
任意群友（以及任何一条被模型解读的消息）触发。对 `echo` 这种回显工具无所谓，
但一个"能发图片"的工具会被反复触发成刷屏，一个"会花钱"的生图工具会被陌生人
替管理员烧钱。这个默认太宽了。

所以新增一档**按对话来源的显式授权**，默认全关（fail-closed）：

```json
"chatTools": {
  "group":     { "enabled": false, "tools": [], "allowPaid": false },
  "private":   { "enabled": false, "tools": [], "allowPaid": false },
  "proactive": { "enabled": false, "tools": [], "allowPaid": false }
}
```

| 档位 | 管哪些回合 |
| --- | --- |
| `group` | **群友**在群里发言的回合（`origin === "group"` 且会话是 `group:`） |
| `private` | **非管理员**私聊回合（`origin === "group"` 且会话是 `private:`） |
| `proactive` | 机器人自己发起的主动唤醒回合（`origin === "proactive"`） |

注意 `origin === "group"` 同时表示"普通群聊"和"陌生人私聊"——那是授权层的有意设计
（两者在权限上都不该比群友高）。所以配置层再用**会话 id 的形状**
（`group:` / `private:` 前缀）把它们分成两档。这是结构性事实，不是对话内容。

#### 哪些来源**不受** `chatTools` 约束

`owner-private`（管理员私聊）、`owner-group`（管理员在白名单群里发言）、
`console`（桌面端手动操作）**不受** `chatTools` 约束。

这三个来源背后都是**管理员本人**：他在私聊里、在自己的群里、在桌面端点按钮时，
需要的是一套能干活的手边工具，而不是每次先去安全页勾一遍。它们的可见性仍然受
`needs`（host 类不进群）与 `risk` 约束——`chatTools` 只是在上面**额外**加一道
"群友能不能用"的门，不是取代原有的判定。

这里有个容易写错的直觉：会以为 `owner-group` 应该比 `group` 更宽松、
所以给它单独一档。实际上不需要——它压根不走这套授权；而如果把它也算进 `group` 档，
反而会出现"管理员在自己群里说话，工具突然不见了"的怪异体验。

三档**互相独立**：给群开了不等于给私聊开。`proactive` 单独一档不是凑数——
主动回合没有具体任务、没有人在等你回答，它是最容易被"顺手放行"的一档，
而一旦放行，机器人可以在没人要求的情况下自己调工具、自己发消息。
所以它必须是一个**单独写下**的决定，不能跟着群聊授权一起被带开。

字段规则：

| 字段 | 规则 |
| --- | --- |
| `enabled` | 该档总开关。`false` 时 `tools` 的内容被忽略（不会"存着等以后"） |
| `tools` | **完整工具名**数组，如 `["plugin_echo"]`；也接受 `"*"`，表示放行该档下全部合格工具（合格 = R0/R1 且非写入/执行类） |
| `allowPaid` | 是否允许 `effects` 含 `paid` 的工具进入该档（见下） |

`tools` 里只接受 `plugin_xxx` 或 `"*"`。写内置工具名（`fs_read`）会被**拒绝**（`E40XX`），
不是静默忽略：这张表管的是**插件**工具，允许写内置名会让人误以为"在这里能改内置工具的授权"，
而实际不生效——那种"配了没反应"的假开关比不给还糟。

几条必须写明的边界：

- **只有 `needs: "qq"` 的工具可能进入聊天来源。** `needs: "host"` 的工具永远不进——
  群友、普通私聊、主动回合都拿不到，把它的名字写进 `tools` 也无效。
  这不是新规则，是 I13 的延续：群聊里永远不该出现能动本机的工具。
- **聊天来源最多放到 R1，但 `paid` 是单独一条路**（下面细说）。
  判断依据是**生效风险**（`max(risk, effects 下限)`），所以写了 `effects: ["chat.send"]`
  的工具至少是 R1，不会因为作者写 `risk: "R0"` 就混进"纯只读"那一档。
  执行类与普通写入类（`data.write` / `exec`）的工具，即使管理员点名也不可见；下述插件自审收费R2例外只允许任务持久化写入。
  写着让它可见、实际不生效，比想象中更常见——排查时先看这里。
- **`data.session` 可以被点名进入聊天来源；普通 `data.write` 仍然不可以。** 下述收费R2任务持久化是精确例外。
  两者的区别见 §4.2 那张表：`data.write` 是插件对自己目录的**任意**写
  （可能塞全局配置、写跨用户索引，影响面不止发起调用的人），
  `data.session` 只能落在**当前 `ctx.caller` 的那一份**（归属由宿主给，
  参数里没有用户/会话字段）。把它也拦掉，等于规定"群里的机器人永远不能
  替人记住任何东西"，课程表、提醒、签到这类插件在群聊里就全都用不了。
  注意放行它的不是这条规则，而是**管理员在配置里写下的那个工具名**：
  默认三档全关，点名之后它才出现；它的下限 R1 也仍然落在"最多 R1"之内，
  未授权时照旧逐次确认。
- 没有被授权的聊天来源，**拿不到任何插件工具**（fail-closed，不是"给个默认子集"）。
- `"*"` 也按上面的规则过滤，不是"全放行"；也不建议用，因为它会让以后新加的工具
  **自动**进入群聊，而那正是本节要防的事。

#### 收费插件的精确授权例外

`paid` 的风险下限仍为R2。仅清单已验证为 `trusted: true`、`runtime: "in-process"`、`approval: "plugin"` 的收费工具，且**生效风险严格等于R2**，可在群聊或普通私聊突破R1上限。宿主仍需允许高风险插件，该授权档必须 `enabled: true`、`allowPaid: true`，并点名完整工具名；`*` 不覆盖这个收费例外，主动回合禁止。

这个例外允许收费任务写自己的持久化任务库（`data.write`），不允许 `exec`、`qq.account.write` 或宿主类工具。其他R2/R3工具不变。`approval: "plugin"` 只把通用工具确认交给插件的逐次前置人工审批，不改变风险与副作用；收费之前必须由插件验证真实人的授权，不能使用模型参数冒充。宿主注册工具时保留approval策略，避免通用确认与生图审批重复。

完整实现与配置见 [独立文生图插件](image-generation.md)。

#### 授权会改变确认策略，但不会改变风险

被授权的工具在该来源下，`confirm` 从 `always` 降为 `never`：

> 管理员把这个工具的名字写进 `chatTools.<档>.tools`，本身已经是一次
> **写下来、看得见、可撤回**的授权行为，等价于对它的每一次调用点了确认。
> 再让群友每用一次都弹一次确认，实际结果不是更安全，而是管理员很快会
> 把整个开关关掉——那才是真正的损失。

**但 `paid` 例外，永远逐次确认**（见上）：白名单是一次性决定，
无法覆盖"这一次要不要花这笔钱"。另外 `risk` 本身不变：
快照里这个工具的 `risk` 仍是它的生效风险（可能是 R1），只是 `confirm` 为 `never`。

配置怎么写入见 §10.3 的 `setting` 通道。界面回显走快照里的
`plugins.chatTools`（与配置同形状）。

### 2.7 消息派发优先级：`messagePriority`

§2.4 / §2.6 管的是**工具**。这一节管的是另一件事：**多个插件抢同一条消息时，谁先看。**

#### 为什么需要它

`handleMessage` 是"接管整条消息"的能力：任何一个插件返回 `true`，这条消息就到此为止，
后面的插件与 AI 回合都看不到它。于是"谁先跑"直接等于"谁有权抢走这条消息"。

原来的顺序是 `records` 的 Map 插入顺序，而插入顺序来自磁盘目录的扫描结果。
那不是一个可以推理的规则：装一个新插件、改一次目录名、换一台机器，
都可能让顺序变化。最典型的受害者是审批流——`dsh-bridge` 的确认回复一旦被
某个"关键词自动回答"插件先认领，用户看到的现象是"审批有时候没反应"，
而它只在某些机器上复现（因为那些机器的目录加载顺序不同）。

所以把"我得排后面"从**偶然的加载顺序**变成清单里一个**写下来的决定**：

| 取值 | 含义 | 谁该用 |
| --- | --- | --- |
| `"normal"`（默认） | 第一轮派发 | 归属明确的接管者：审批、确认、指令路由。**不写就是这一档**，旧插件行为完全不变 |
| `"low"` | 第二轮派发，即所有 `normal` 插件都没接管之后 | 兜底类/娱乐类接管者：固定问答、关键词回复、签到、表情 |

规则：

- 两轮之间是**严格顺序**，不是"同一轮里排前面一点"：只有第一轮**全部**返回未接管，
  第二轮才开始。所以一个 `low` 插件永远不可能抢走 `normal` 插件的消息。
- **同一档内保持既有顺序**（`records` 的加载顺序）。这不是"另一条隐含规则"，
  而是"这一档里没有优先级概念"——同档插件之间本来就不该靠顺序互相压制；
  真需要压制时，把其中一方声明成 `low` 是唯一可推理的表达方式。
- 只影响 `handleMessage` 的派发顺序。**工具调用、`init`、`dispose` 都不受影响。**

#### 为什么只给 `in-process` + `handleMessage: true`

`process` 插件根本收不到消息（§5.5 第 1 点），允许它声明这个字段只会让人以为
"我配了优先级"，而实际什么都没发生。那种"配了没反应"的假开关比不给还糟，
所以清单层直接拒绝：

| 写法 | 结果 |
| --- | --- |
| `runtime: "in-process"` + `handleMessage: true` + `messagePriority: "low"` | 合法 |
| `runtime: "process"` + `messagePriority: "low"` | `E4041`（process 插件收不到消息） |
| 没有 `handleMessage: true` 却写 `messagePriority: "low"` | `E4041`（这个字段没有作用对象） |
| 写了 `messagePriority: "high"` / `"LOW"` / `1` | `E4041`（只接受 `"normal"` / `"low"`） |

写 `"normal"`（等于缺省）不受上面两条限制之外的约束：它不改变任何行为，
所以即使写在 `process` 插件上也无害——但没意义，不建议写。

### 2.8 保存前校验：`validateConfig`

#### 为什么需要它

有些配置值**类型上合法、语义上是坏的**：一段规则 JSON、一条正则、一组编号。
`§3` 的类型/范围/`pattern` 校验拦不住它们，只有插件自己知道怎么判断。

原来的结果是两个分开的现象：用户点保存 → "保存成功"；然后插件起不来 →
"初始化失败"。两次操作之间那个因果关系在界面上看不见，用户很容易以为是
"保存把插件弄坏了"，或者干脆没注意到第二条消息。

更糟的是**坏配置已经落盘**了：下一次打开插件页，看到的是那份坏配置，
而它改之前那份好配置已经被覆盖。那不是"保存失败"，是数据丢失。

所以新增一个可选的**落盘前问询**：

1. 用户点保存 → 宿主先做既有的类型/范围校验（`E4062` / `E4063`）；
2. 通过后，若清单声明了 `validateConfig: true`，宿主调用插件入口的
   `validateConfig(config)`，参数是**这次要保存的候选值**；
3. 返回 `{ ok: false, message }` → **整次保存失败，不写盘**，界面显示该 `message`；
4. 只有 `{ ok: true }` 才真正写配置，然后按既有流程重新初始化。

顺序（**先校验、后写盘**）是这条能力的全部价值所在。反过来写就会出现
"配置已经存进去了，然后才告诉你它不能用"。

校验函数自己抛异常也按**失败**处理（`E4062`），不放行：它崩了说明它给不出
"能用"的结论，此时默认放行等于把不确定性当成了许可。

#### 为什么只给 `in-process` + `trusted: true`

保存是一个**同步语义**的操作（用户点一下，要么存了要么没存）。`process` 运行时
要跨进程问一次结论，而为了这一次问询单独起一个子进程，那条路径自己就会因为
超时/崩溃变成新的不确定来源——"保存失败"会开始有第三种原因（子进程没起来），
而这个原因和用户的配置对不对毫无关系，排查成本却全落在用户身上。

所以只对第一方 `in-process` 插件开放。这类插件的校验是纯计算：毫秒级、不联网，
失败模式只有"返回 ok:false"和"抛异常"两种。写了不满足的条件一律 `E4041`：

| 写法 | 结果 |
| --- | --- |
| `in-process` + `trusted: true` + `validateConfig: true` | 合法（入口必须实现 `validateConfig`，否则 `E4041`） |
| `runtime: "process"` + `validateConfig: true` | `E4041` |
| `in-process` 但 `trusted: false` + `validateConfig: true` | `E4041` |
| `validateConfig: "yes"`（非布尔） | `E4041` |

返回值形状与 `testConnection` 一致：`{ ok, message?, details? }`。宿主不解析
`details`，只用于日志与界面展示。有 **5 秒**上限（`VALIDATE_TIMEOUT_MS`，
远小于 `testConnection` 的 15 秒——保存是用户正等着的动作，不该让人盯着转圈）；
超时按失败处理，理由同上——给不出结论就不该当成"能用"。

另外，**声明了就必须实现**：清单校验时会检查入口有没有导出 `validateConfig`，
没有就 `E4041`。静默放行会让用户以为"配置被校验过了"，而实际上什么都没检查。

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
  "effects": ["net"],
  "timeoutMs": 30000,
  "params": {
    "text": { "type": "string", "required": true, "maxLength": 4000, "description": "要交给 DSH 的指令" },
    "sessionId": { "type": "string", "required": false, "description": "投给哪个 DSH 会话" }
  }
}
```

- `params` 与既有工具系统一致：`type` 支持 `string` / `number` / `boolean` / `array` / `object`；
  另有 `required`、`description`、`maxLength`、`maxItems`、`enum`、`items`、`properties`。
- `effects`：可选，见 §4.2。
- `timeoutMs`：单次调用超时，默认 `20000`，上限 `120000`。超时后：`process` 运行时直接杀掉子进程并记为失败；`in-process` 运行时只能中断信号与记失败。
- 返回值必须是 **JSON 可序列化**且 ≤ 256KB 的对象；否则按执行失败处理（`E4066`）。
- 插件返回 `{ ok: false, code, message }` 是合法的**工具结果**（会回灌给模型），不是宿主异常。

#### 参数类型的完整列表

| `type` | 额外字段 | 说明 |
| --- | --- | --- |
| `string` | `maxLength`（1–65535）、`enum`（≤50 项字符串） | |
| `number` | — | 必须有限（不接受 `NaN` / `Infinity`） |
| `boolean` | — | |
| `array` | `maxItems`（1–1000）、`items` | `items` 可以是 `string`/`number`/`boolean`，**也可以是 `object`** |
| `object` | `properties`（≤30 个）、`required` | 属性递归，深度上限 **3 层**（含数组元素里的 object） |

对象参数（以及对象数组）是为这一类工具加的：**一次传一批结构化记录**，
比如课程表插件要一次接收 1–20 条课程：

```json
{
  "name": "course_preview",
  "needs": "qq",
  "risk": "R0",
  "effects": ["data.read"],
  "params": {
    "courses": {
      "type": "array",
      "required": true,
      "maxItems": 20,
      "description": "课程数组，每条至少要有 name、weekday、termStartDate",
      "items": {
        "type": "object",
        "required": ["name", "weekday"],
        "properties": {
          "name": { "type": "string", "maxLength": 60 },
          "weekday": { "type": "number" },
          "periods": { "type": "array", "maxItems": 12, "items": { "type": "number" } },
          "parity": { "type": "string", "enum": ["all", "odd", "even"] }
        }
      }
    },
    "termStartDate": { "type": "string", "maxLength": 10 }
  }
}
```

规则（每一条都对应一个具体的失败方式）：

- **`required` 有两种写法，含义不同。**
  - `"required": true`（布尔）→ **这个参数本身**必填；
  - `"required": ["name", "weekday"]`（字符串数组）→ **对象里的哪几个属性**必填。
  数组里引用了未声明的属性直接 `E4041`：那种"必填一个不存在的字段"永远无法满足，
  工具会稳定失败，而报错看起来像是模型没填。
- **`items.required` 只能是字符串数组。** 元素本身没有"必填/不必填"这个维度
  （有没有元素由调用方与 `maxItems` 决定），写布尔值会被拒绝，不静默忽略。
- **深度上限 3 层**，超了报 `E4041` 并给出字段路径（如
  `工具 x 的参数 patch.l1.l2.l3 的对象嵌套超过 3 层`）。这条不是洁癖：
  schema 是递归结构，一个手写错的自引用清单会让加载器爆栈。
- **多个声明上限**：object 参数最多 30 个属性，数组最多 1000 个元素，
  参数名/属性名都必须是 `^[a-zA-Z][a-zA-Z0-9_]{0,40}$`。
- **对象数组只支持一层**：`array<array>` 与 `items` 为非标量/对象的值一律 `E4041`。

#### 运行时校验语义：白名单过滤，多余键**丢弃不报错**

`validateParams` 对 object 的处理与顶层参数完全一致：

| 情况 | 结果 |
| --- | --- |
| 声明了、类型对 | 保留 |
| 声明了、类型错 | `E4041`，消息里点名字段（如 `参数 courses[0].weekday 必须是数字`） |
| 必填但缺失（`undefined` / `null`） | `E4041`（`缺少必需参数：courses[0].name`） |
| **未声明的键** | **丢弃，不报错** |
| 数组超过 `maxItems` | `E4041` |

"多余键丢弃"是有意的，和 §4.1 那条一致：模型很容易多写一个字段，
让它报错的结果是整次调用失败、而用户真正要的操作根本没发生。
同时它也是安全属性的落点之一——模型塞进 `{"origin": "owner-private"}` 这类字段时
**不会**到插件面前，双层防护中的第二层就在这里生效。

下发模型时，object 属性会输出成标准 JSON Schema
（`{"type":"object","properties":{…},"required":[…],"additionalProperties":false}`），
`additionalProperties: false` 是给模型看的提示，执行层靠上面的白名单过滤，
两层都保留。

> 旧参数（`string` / `number` / `boolean` / 标量数组）的 schema 输出与过滤行为
> **逐字段不变**。标量数组的元素历史上不做逐项校验，现在也不做 ——
> 收紧旧行为会让本来能跑的工具在升级后突然拒绝调用。

### 4.1 参数名有一批保留字

工具 `params` 里**不允许**出现这些参数名，写了会直接 `E4041`：

`origin`、`convKey`、`caller`、`signal`、`invocation`、`ctx`、`plugin`、`args`、`tool`

原因是 §5.2 的 `ctx.caller`：调用上下文由宿主生成，
如果插件能声明一个叫 `caller` 的参数，模型就能在参数里塞一个
`{"caller": {"origin": "owner-private"}}`，而插件代码里 `args.caller ?? ctx.caller`
这种写法极容易顺手写出来——那等于把提权交给一句 JSON。

所以这道限制有两层：清单层直接拒绝这些名字（加载时就报错，不等到运行时），
执行层再把模型给的参数按清单过滤一遍（`validateParams` 只保留清单声明的字段）。
**两道都要有**：只有第一道，插件改天放宽了清单就漏了；
只有第二道，作者在开发期不会发现自己写错了。

顺带一个副作用要知道：模型如果硬塞一个未声明的参数，**不会报错**，也不会到插件面前，
它在 `validateParams` 那一步就被丢掉了。所以"参数怎么没传进来"这类排查，
先看清单里有没有声明它。

### 4.2 `effects`：工具会做什么

`effects` 是**行为分类**，不是权限声明。它回答的是"这个工具执行时会碰哪些东西"，
用途是给 `risk` 立一个宿主这边的下限。

允许的取值只有这十一个（拼错不会静默忽略，见下）：

| effect | 含义 | 推导下限 |
| --- | --- | --- |
| `data.read` | 读插件自己的 `plugin-data/<id>/` | **R0** |
| `data.write` | 写插件自己的 `plugin-data/<id>/`（任意写） | R2 |
| `data.session` | 读写插件 `dataDir` 内、**按宿主 caller 会话/用户隔离**的业务数据 | R1 |
| `chat.read` | 读当前会话的消息/媒体 | R1 |
| `chat.send` | 向当前会话发文本 | R1 |
| `chat.send.media` | 向当前会话发媒体 | R1 |
| `qq.account.read` | 读 **QQ 账号**级的东西（收藏表情列表等），结果跨会话共享 | R1 |
| `qq.account.write` | 写 **QQ 账号**级的东西（收藏表情、改账号备注） | R2 |
| `net` | 普通外部网络访问 | R1 |
| `paid` | 收费的外部操作（如生图） | R2 |
| `exec` | 执行本机命令 | R3 |

`data.read` 给 R0 是刻意的：它只碰插件自己的目录，没有外部影响。
如果给它 R1，那么「读自己缓存的课程表」这种纯本地操作每次都要弹确认，
用户的真实反应不是逐次确认，而是把整个授权关掉——那是净损失。

反过来，`chat.send` 至少是 R1，这一条要单独说明，因为它是最容易被写错的一条：

> **「发消息的工具」不能靠写 `risk: "R0"` 白拿自动执行。**
>
> 发送有外部影响：消息会出现在别人的群里、会被人看见、会引发回复，
> 而且发出去了就收不回来。它不是"读一下"。同理，`paid` 操作真的会花钱。
> 把这类操作写成 R0 换自动执行，本质上是**把外部影响伪装成只读**，
> 换取的是作者自己的方便，代价由管理员承担。
>
> 所以：清单写 `risk: "R0"` + `effects: ["chat.send"]`，最终风险仍是 R1，
> 仍然每次要确认（除非该来源已被 §2.6 的白名单授权）。

规则：

- 风险 = `max(声明 risk, effects 推导下限)`。多个 effect 取最高的一条。
- `effects` 是插件表达"我需要什么"，**宿主决定风险下限**，插件无法用 `effects` 降低风险。
- 未知的 effect 名 → 清单不合法（`E4041`），**不静默忽略**。理由和所有清单校验一致：
  忽略一个拼错的 `chat.sned`，症状会是"工具莫名其妙每次都要确认"或
  "在群里根本看不到"，而报错信息里什么都不显示。
- 不声明 `effects` 是合法的（向后兼容），此时只用 `risk`，没有下限抬升。

#### `data.session` 与 `data.write` 的区别

这两个词都会写盘，区别只有一条，但它决定了**能不能在群里用**：

| | `data.write` | `data.session` |
| --- | --- | --- |
| 写什么 | 插件自己目录的**任意**内容 | 只写**当前 caller 的那一份**业务数据 |
| 影响面 | 可能波及所有用户（全局配置、跨用户索引） | 被 `ctx.caller` 圈在"这个会话里的这个人" |
| 归属来源 | 插件自己决定 | **宿主给**，工具参数里没有用户/会话字段 |
| 下限 | R2 | R1 |
| 能进聊天来源（§2.6） | **永远不能** | 可以，但要管理员点名 |
**归属只能由宿主给**，这是这个 effect 成立的唯一前提。`ctx.caller` 由执行层在
调用时构造（见 §5.2），插件拿不到别的来源；同时 `RESERVED_PARAM_NAMES`（§4.1）
挡掉了 `caller` / `convKey` / `origin` 之类的参数名，所以模型**无法**在参数里
指定"我要读写别人的数据"。课程表插件是第一个使用者：
它的 `course_save` / `course_update` / `course_delete` 声明 `data.session`，
数据文件按 `sha256(convKey + 用户 id)` 命名，工具参数里根本没有"给谁存"这一项。

> **它不是技术沙箱。** `process` 运行时拦不住插件写任意路径；`in-process`
> 插件也没有文件系统隔离。这条 effect 是**授权分类 + 作者声明**：
> 让管理员在插件页看得见"它会写按会话隔离的业务数据"、让宿主能把风险
> 定在一个合理档位。真正的强制点是 `ctx.caller` —— 归属由宿主计算，
> 读取时还要逐字段比对 `owner`，不符就当成身份错误拒绝。

#### `qq.account.read` / `qq.account.write`：账号级，不是会话级

这两个词回答的是「它会碰 **QQ 账号**里的东西吗」。和 `chat.*` 的区别在于
**归属**：`chat.*` 永远只作用于当前会话（`ctx.caller.convKey`），
而收藏表情这类东西**不属于任何一个会话** —— 这个号攒的所有表情都在里面，
在群里和私聊里看到的是同一份。

| | 读的/写的是什么 | 跨会话可见 | 典型用途 |
| --- | --- | --- | --- |
| `chat.read` | 当前会话的消息 | 否 | 读上下文、看引用的图 |
| `qq.account.read` | 账号的收藏表情列表 | 是 | 列出、按备注搜索、挑一张 |
| `qq.account.write` | 往账号里加表情 / 改账号里的备注 | 是，且在 QQ 客户端里也看得见 | 收藏、改官方备注 |

为什么 `qq.account.write` 的下限是 **R2** 而不是 R1：

1. 它写的是**用户的资产**。塞进去一张，用户在 QQ 客户端里能看到，
   得自己去删；而删掉之后通常找不回来。
2. 它跨会话生效。A 群里塞进去的一张图，B 群里也会被模型看到并选中。
3. R2 进不了聊天来源（§2.6 的上限是 R1），于是"群里任何人都能往账号里
   塞表情"在**结构上**就不可能 —— 而 `chat-grant.mjs` 里还有一条独立判断
   拦着它，改了下限也不会无声放开。

`qq.account.read` 定 R1 是另一个取舍：它只读，而"让它在群里看一眼表情库"
正是这个能力的主要价值。定成 R2 会让表情包在群聊里彻底用不了（读都读不到，
谈何选图）。

> 这两个词**不**替代 `data.write`。插件通常两个都要声明：
> 表情库落在插件自己的 `dataDir` 里（`data.write`），收藏动作打的是账号
> （`qq.account.write`）。少写任何一个，风险档都会低一档 —— 而那正是
> 想靠"声明得少"换自动执行的那条路，宿主不接受。

为什么下限取 R1 而不是 R2：R2 的工具进不了聊天来源（§2.6 的上限是 R1），
于是"群里有人让机器人记一条课程"永远做不到——而那正是这个 effect 存在的全部意义。
放在 R1 之后它仍然：① 要管理员在 `chatTools` 里点名才在群里可见；
② 未被授权时每次调用都要人工确认；③ 一旦同时声明 `data.write` / `exec` /
`paid`，就按更严的那条来，`data.session` 不是豁免牌。

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
   * 可选：保存配置前的自校验（清单 `validateConfig: true` 才需要实现）。
   *
   * 注意参数是**配置对象本身**，不是 `ctx`——与上面的 testConnection(ctx) 不同。
   * 原因：调用发生时新配置还没落盘，`ctx.config` 里只有旧值，拿它校验等于
   * 在检查"上一份配置"。所以宿主把候选值直接递进来。
   *
   * 不需要先 init：它可以在「待配置 / 初始化失败」状态下被调用。
   * @param {Record<string, any>} config 候选配置（已按清单声明归一，含默认值，不含密钥）
   * @returns {Promise<{ok: boolean, message?: string, details?: object}>}
   *          返回 {ok:false, message} = 整次保存失败、不写盘、界面显示 message
   */
  async validateConfig(config) {},

  /**
   * 停用 / 重载前释放资源（关端口、清定时器、落盘）。
   * 宿主最多等 3 秒，超时只记日志，不阻塞停用。
   */
  async dispose(ctx) {},

  /**
   * 可选：接管 QQ 消息（返回 true 表示已处理，不再走 AI 回合）。
   * 仅 in-process 运行时支持；process 运行时不会收到消息。
   * @param {{ evt: object, sendText: (convKey: string, text: string) => Promise<any>, ctx: PluginContext }} input
   *        宿主实际还会多传一个 `gate`（见下方「`handleMessage` 的 `gate`」）；它是加法的，
   *        不读它的插件行为不变。
   */
  async handleMessage({ evt, sendText, ctx }) {},
};
```

`validateConfig` 与 `testConnection` 的签名差异是本节唯一容易抄错的地方，单列一下：

| 钩子 | 参数 | 调用时机 | 能不能拿到 `ctx.config` |
| --- | --- | --- | --- |
| `testConnection(ctx)` | `PluginContext` | 初始化前后都能调 | 能，但那是**已保存**的配置 |
| `validateConfig(config)` | **配置对象本身** | 保存前，且**尚未落盘** | 拿不到 `ctx`，也不需要——候选值就是参数 |

`gate` 的字段：宿主传给 `handleMessage` 的一组**结构性事实**（插件读不到那些状态，
也不该自己猜——两套判定各算一次，结果一定会分叉）。

| 字段 | 含义 | 插件该怎么用 |
| --- | --- | --- |
| `whitelisted` | 当前会话是否通过宿主白名单/黑名单检查 | `false` 时不接管：宿主都不参与的会话，插件不该抢在前面说话 |
| `silenced` | 当前会话是否处于静音期 | `true` 时不接管：静音是用户明确要求的"别说话"，插件不该穿透它 |
| `confirmPending` | 当前会话/发送者是否有**待处理的确认** | 为 `true` 时，形似确认回复的文本（`1` / `2` / `同意` / `拒绝`…）不要接管 |
| `isAdmin` | 发送者是否是**核心管理员**（`config.admin.qqIds`；`admin.inheritWhitelist` 打开时并上白名单私聊） | 用于 `scope.adminOnly` 这类"只给主人用"的判断。**不要**改用 `config.silence.adminIds`——那是"谁能让它闭嘴"，权限范围不同 |
| `selfId` | 机器人自己的 QQ 号 | 发送者等于它时不接管（自己回自己会成环） |

- `gate` 为 `null` 表示调用方没有提供（比如单测直接调运行时），此时插件应按
  "没有额外限制"处理，而不是当成"被拒绝"。
- 字段是**加法的**：过去的版本里没有 `isAdmin`，将来的版本也可能再多出别的键。
  插件应该只读自己认识的键，并对未知键保持沉默——反过来（读不到就当拒绝）
  会让每次宿主扩展都变成插件停摆。
- 但**读不到时的默认值要按语义挑**，不能一律"放行"或一律"拒绝"：
  白名单类要偏严（读不到就不接管），静音类要偏松（读不到就当没静音），
  授权类（`isAdmin`）必须**偏严**——判不出来就当不是管理员。方向错了的后果不是"功能差一点"，
  而是"该拦的没拦"。

### 5.1 `PluginContext`

```js
{
  plugin: { id, name, version, dir, dataDir, runtime },
  config: { /* 已校验的配置值（含默认值，不含密钥） */ },
  secrets: { /* 密钥字段的明文，仅在插件进程内可见 */ },
  log: (level: 'debug'|'info'|'warn'|'error', message: string, fields?: object) => void,
  sendText: (convKey: string, text: string) => Promise<{ok: boolean, messageId?: any, message?: string}>,
  dataDir: string,           // 等于 plugin.dataDir，方便直接用
  signal: AbortSignal,       // 本次调用的取消信号（见 §5.4）

  caller: { /* 本次调用的可信上下文，见 §5.2；**只在 callTool 里有** */ },
  chat:   { /* 受控聊天能力，只能操作 caller.convKey，见 §5.3；**只在 callTool 里有** */ },
  gateway: { /* 受控网关能力：账号级动作（收藏表情等），见 §5.3.1；**只在 callTool 里有** */ },
  net:    { /* 受控联网能力：搜索与网页读取，见 §5.3.2；事实同步可用，请求只在 callTool 里有 */ },
}
```

**`caller` / `chat` / `gateway` 只在一次工具调用（`callTool`）期间存在。**
`init` / `testConnection` / `dispose` 拿到的 `ctx` 里没有这三项（为 `undefined` 或 `null`）。

`net` 是例外：它在这些阶段**也存在**，但只有同步事实可用
（`available` / `enabled` / `provider` / `configured`），`search` / `fetch`
会返回 `E4071`。理由见 §5.3.2。
理由很直接：那三个钩子不属于"某一次调用"，没有会话、没有触发者。
如果在这里给一个"不知道是谁"的 `caller`，只会诱导插件把它存到模块变量里——
而并发调用时那个变量必然是错的（A 群的调用存下上下文，B 群发消息时读了它）。

**也不要把 `ctx` 存起来复用。** 每次调用都该用当次传入的 `ctx`；
`caller` 是冻结的，`chat` 的配额也是按次计的。

- `sendText` 仍然走宿主的发送闸门（白名单、频率、审计）；插件拿不到 `client`、`config` 之外的宿主对象。
- 日志会带上插件 id 写进主日志，同时进入插件页的「最近日志」（保留最近 50 条）。
- `process` 运行时下，`log`/`sendText` 由宿主代理实现，行为一致。

#### 为什么上下文必须由宿主生成

这一条值得单独写，因为它是本节所有设计的出发点。

模型能控制的只有**工具参数**。如果调用上下文也能从参数传进来，
那么提权只需要一句 `{"origin": "owner-private"}`：
模型（或任何能影响模型输出的人，比如群里一个会说话的人）写这一句，
插件读到 `args.origin`，工具就从"群里可见"变成"管理员私聊级"。
整个过程没有任何代码被攻破，只是**参数被当成了事实**。

所以有三道互不依赖的保证：

1. 清单层：`origin` / `convKey` / `caller` 等名字不能作为工具参数声明（§4.1）。
2. 执行层：模型给的参数按清单**白名单过滤**，只有清单里声明过的字段能进 `args`；
   任何额外的键（`origin`、`convKey`、`caller`、`invocation`…）在这里就被丢掉，
   不会传到插件面前。
3. 上下文层：`ctx.caller` 由宿主在 executor 里构造并冻结（`Object.freeze`），
   来源只有宿主的回合调度，与工具参数无关。

换句话说：**"我是谁、我在哪个会话、谁触发了我" 这三件事，插件只能从 `ctx` 得知，
不能从 `args` 得知。** 任何插件如果发现自己在读 `args.origin`，那是写错了。

### 5.2 `ctx.caller`：本次调用的可信上下文

```js
caller: {
  pluginId,          // 谁在调用，如 "plugin-template"
  tool,              // 完整工具名，如 "plugin_hello"
  origin,            // owner-private / owner-group / group / proactive / console
  convKey,           // 当前会话，如 "group:123"、"private:456"
  isGroup,           // 由 convKey 推出，省得插件自己 split
  requester: { id, nickname },   // 谁触发了这次调用（主动回合为空串）
  messageId,         // 触发调用的那条消息 id（可为 null）
  replyToMessageId,  // 该消息引用的消息 id（可为 null）
  callId,            // 本次调用 id（取消/追踪用）
  at,                // 毫秒时间戳
}
```

用法上就一条：**插件想知道"现在是谁在让我干活、在哪个会话里"，读这里。**

- `origin` 的取值由宿主的回合判定产生（`src/index.mjs` 的 `resolveOrigin`），
  不是插件声明的，也不能由模型参数影响：
  `owner-private`（管理员私聊）、`owner-group`（管理员在白名单群里发言）、
  `group`（群友私聊/群聊）、`proactive`（主动唤醒）、`console`（桌面端手动操作）。
- `requester` 在 `proactive` 与 `console` 下没有"某个人触发"这件事，
  `id` 与 `nickname` 都是空串。插件不要用 `requester.id` 非空来判断"有没有会话"——
  那是 `convKey` 的事。
- `messageId` / `replyToMessageId` 可能为 `null`：主动回合没有触发消息，
  桌面端手动执行工具也没有。**先判空再用**，这是最容易在测试里漏掉的分支。
- `isGroup` 只是 `convKey.startsWith('group:')` 的便捷写法。别用它替代 `origin` 做权限判断：
  `owner-group`（管理员在群里）也是群，`group:` 形状但不代表"群友来源"——权限已经判过了。
- `caller` 是冻结的（`Object.freeze`）。想"改一下 origin 再调自己"这种写法会失败，
  这是故意的：上下文不是插件的可变状态。同理**不要把它存到模块变量**里跨调用复用，
  并发时会串。要用时从当次 `ctx` 取。

### 5.3 `ctx.chat`：受控聊天能力

```js
chat: {
  recent({ limit }),                    // -> { ok, messages: [...] }  当前会话最近消息
  message({ messageId }),               // -> { ok, message }  校验归属
  mediaList({ messageId }),             // -> { ok, handles: [...] }  媒体句柄
  send({ text, quote? }),               // -> { ok, messageId }  走统一发送闸门
  sendMedia({ handles, quote? }),       // -> { ok, messageId }  走统一发送闸门
  registerMedia({ path, kind, mime? }), // -> { ok, handle }  只允许插件 dataDir 内的文件
}
```

#### 没有"目标会话"参数，这是设计而不是遗漏

`ctx.chat` 的每个方法都**没有** `convKey` / `groupId` / `userId` 这类参数。
它永远只作用于 `ctx.caller.convKey`，也就是"这次调用发生在哪个会话，就只能操作哪个会话"。

这不是"先传参再校验"，而是**压根没有那个参数**：

> 参数存在、只是被校验拦住，和参数不存在，是两种强度完全不同的保证。
> 前者依赖校验写对了、依赖没有一条 `if` 漏掉；后者连"写错的机会"都没有。
> 插件作者想跨会话时，遇到的不是 `E4074`，而是"这个 API 根本没有那个参数"——
> 他会去看文档，而不是去研究怎么绕。

跨会话的尝试（比如把 `quote` 指到别的会话的消息）返回 `E4074`，不会静默改成当前会话。
静默改的话，插件会以为自己发对了地方。

#### 返回值一律是结果对象，不是异常

所有 `ctx.chat.*` 的失败都返回 `{ ok: false, code, message }`，
**不抛异常**。包括发送被闸门拒绝：`E2020`（出站审计拦截）、`E2030`（限流）、
`E20XX`（白名单/黑名单）。这和 §4 的"插件返回 `{ok:false,...}` 是合法工具结果"是同一套口径：

- 插件应该把它当普通结果处理（可以直接 `return` 给模型，让模型知道自己没发出去）；
- 不要在插件里 `try/catch` 后转成一个含糊的 `E4066`，那样会把"限流了，等一下再发"
  这种可恢复信息变成"插件坏了"。

#### 媒体用句柄，不给路径

`mediaList({ messageId })` 返回的是元数据，不是文件：

```js
{ handle: "media_xxx", kind: "image", bytes: 52311, mime: "image/png", name: "a.png", expiresAt: 1730000000000 }
```

插件拿不到本机路径，也拿不到 QQ 的原始 URL。原因有两条：

1. **路径是能力**。给了路径就等于给了"用任意 Node API 读它、传它、拼进别的请求"的能力，
   而插件本来只需要"把这张图发出去"。
2. **URL 会过期、带凭据**。QQ 的媒体链接有时效，有的还带访问令牌；
   把它交给插件，插件缓存下来就是个定时炸弹。

要发就传句柄：`sendMedia({ handles: ["media_xxx"] })`。句柄由宿主解析、宿主负责取字节，
插件从头到尾不知道那东西在磁盘哪里。

句柄本身还有几条约束（插件需要知道，否则会撞上看不懂的 `E4073` / `E4074`）：

- **绑定插件**：A 插件拿不到 B 插件的句柄（`E4074`）。
- **绑定会话**：群 A 的句柄不能在群 B 用（`E4074`）——防止"拿群里的图去别处发"。
- **会过期**：默认 10 分钟。一次对话内的"发这张图"用不着更久；
  存到下次对话必然失效，而且失效时报"句柄不存在或已过期"（`E4073`），不会降级成路径。
- **进程重启即全部失效**：来源只存在宿主内存里。这是刻意的——
  签名 token 虽然能让句柄跨重启有效，但撤销就成了新问题（用户撤回了图、退群了、
  插件被停用了，句柄却还在有效期内）。
- 单个插件同时最多持有 200 个句柄，超过时淘汰它自己最旧的那个（不报错）。

#### `registerMedia`：给"自己生成图片"的插件

生图类插件生成完文件，它确实有一份自己写的文件。这时用：

```js
const r = await ctx.chat.registerMedia({ path: 'out/2026-01-01.png', kind: 'image', mime: 'image/png' });
if (r.ok) await ctx.chat.sendMedia({ handles: [r.handle] });
```

宿主会校验：

- 解析后的**真实路径**（`realpath`）必须落在**该插件自己的 `dataDir`** 里，越界返回 `E4075`。
  校验分三步：`resolve` 后判一次（防 `../../`）、`realpath` 后再判一次（防符号链接跳出去）、
  最后要求是普通文件且体积受限。少一步都能被绕过。
- 单文件 ≤ **10MB**，超过返回 `E4073`。
- `kind` 只接受 `image` / `record` / `video` / `file`；不支持的返回 `E4073`。

为什么不直接允许 `sendMedia({ path })`：那等于给所有插件开一个
"把本机任意文件发到群里"的通道，而"发文件"恰恰是最常见的凭据外泄方式。
分成"句柄"（别人的媒体）与"注册"（自己的产物）两条路，能让越权路径只剩一条，
而那条路上有两个明确检查点。

#### 发送限制

| 限制 | 上限 | 超限 |
| --- | --- | --- |
| 一次工具调用最多发几条消息 | 3 | `E4073` |
| 一条消息最多几个媒体 | 4 | `E4073` |
| 单条文本长度 | 4000 字 | `E4073` |

这些上限不是性能考虑，是**防刷屏**：插件一旦进入聊天来源，它的一句话就是群里的一条消息。
没有上限的话，一个 `for` 循环写错就能把群刷爆，而机器人可能已经被限流/踢出。

配额是**按次**计的：一次工具调用一份计数，用完即弃。
放在插件对象上会让"上一次调用发满了"影响下一次。

发送仍然走**同一道闸门**（白名单、出站审计、限流，见 `src/guard/send-gate.mjs`）：

- 插件不能因为"我是插件"而绕过审计；
- 被拒时返回闸门的 code（`E2020` / `E2030` / `E20XX`），不抛异常；
- 这条通路和 AI 自己发消息走的是同一个实现，所以审计流水里能看到。

`recent({ limit })` 的 `limit` 默认 10，上限 50（超出的会被夹到 50，不报错——
读历史多一点不是危险操作）。返回的每条消息是
`{ messageId, sender: { id, nickname }, text, at, self }`。

#### 能力边界不因插件而放宽

`process` 与 `in-process` 提供**同一组方法**。宿主在父进程侧统一分发：

- `in-process` 插件直接调用父进程里的实现；
- `process` 插件通过 NDJSON 协议转发（`host-call` / `host-call-result`，见 §5.5）。

如果宿主**没有注入聊天桥**（典型场景：单独拿运行时跑插件做单测，
或者工具由脚本直接调、没有会话上下文），调用返回 `E4072`。
不要把它当成"插件写错了"——它是"当前这个环境没有聊天能力"，插件应该降级或跳过该步。

### 5.3.1 `ctx.gateway`：账号级动作（表情包这类）

`ctx.chat` 管的是"当前会话的消息"。有一类能力它管不到，因为它们**不属于
任何会话**：账号里收藏了哪些表情、某个表情的图片字节、往账号里加一张表情。

这些在 OneBot 里是**扩展动作**（`fetch_custom_face_detail`、
`add_custom_face`、`modify_custom_face`），不是标准动作。不同网关支持面不同。

```js
gateway: {
  available: boolean,                        // 宿主是否注入了这个能力
  vision: { enabled: boolean, supported: boolean|null, known: boolean },  // 同步属性
  caps(): GatewayCaps,                       // 同步，纯内存
  probe({ force }): Promise<{ok, caps, message?}>,
  listFaces({ count }): Promise<{ok, complete, items, count} | {ok:false, code, message}>,
  fetchFaceImage({ ref, maxBytes }): Promise<{ok, bytes, sha256, mime, width, height, animated, file, dataUrl, tooLarge} | {ok:false, ...}>,
  collectFace({ messageId, index, desc }): Promise<{ok, emojiId, desc, viaQqAccount, sha256, md5, mime, animated, warning} | {ok:false, ...}>,
  sendFace({ file, replyToMessageId, atUserId }): Promise<{ok, messageId, bubbles} | {ok:false, ...}>,
}
```

四条与 `ctx.chat` 完全相同的纪律：

1. **没有目标会话参数。** `collectFace` 只认当前会话里的消息（宿主用
   `lookupMessage` 校验归属，查不到一律 `E4074`，不区分"不存在"与
   "在别的会话"）。
2. **归属由宿主给。** 插件参数里没有 `convKey`，`RESERVED_PARAM_NAMES` 也挡着。
3. **失败返回结果对象，不抛异常。**
4. **发送仍走统一闸门与队列。** `sendFace` 内部委托 `sendSegments`，
   与 AI 回复共用同一队列 —— 所以"先说一句再补一张表情"不会乱序。

三条这个能力特有的约定：

- **能力三态不是布尔。** `caps()` 里每个动作是
  `'supported' | 'unsupported' | 'unknown'`。`unknown` 表示**没测出来**
  （网关没有 `get_supported_actions`、或探测本身失败），**不等于**不支持。
  把 `unknown` 显示成"你的网关不支持"会让用户去升级一个不需要升级的东西。
- **`vision.known` 是可信位。** `known: false` 表示宿主没给这个事实。
  这时不能说"视觉识别已关闭"（那可能是在撒谎），只能说"我按标签选的"。
- **图片字节由宿主取。** 插件拿到的是已落盘的 `file`（相对自己的
  `dataDir`）与可选的 `dataUrl`。宿主负责 SSRF 校验、逐跳重定向、
  魔数判定、字节与像素上限。**不要把 URL 交给网关去下载** —— 那条路
  绕过了全部防护。

> 完整的形状、错误码与实现约束见 [stickers-contract.md](stickers-contract.md)。
> 表情插件是它目前唯一的使用者。

### 5.3.2 `ctx.net`：受控联网能力

「联网」在 Ling-bot 里是**宿主授权的能力**，不是插件可以自己决定的事。
所以它只暴露一个受控对象，插件拿不到 socket、拿不到密钥、也读不到总闸配置。

这个能力面**只管宿主代发的受控 HTTP(S)**（`search` / `fetch`）。模型服务商侧
的检索、QQ 网关（SnowLuma）自己的网络、视觉取图链路，以及其它插件自己写的
`fetch`，都不在这一条链里 —— 总开关关掉的也只是这一条链。不要把它当成
"所有外网流量"的开关。

```js
net: {
  available: boolean,      // 宿主是否注入了这个能力（占位对象时为 false）
  enabled: boolean,        // 构造这一刻的总闸状态（同步快照，供提前短路）
  provider: string,        // 目前只可能是 'tavily'
  configured: boolean,     // 有地址、解密得到 Key，且 provider 受支持

  async search({ query, maxResults?, topic?, searchDepth? }):
    | { ok: true, provider, query, results: Source[], tookMs, credits?, truncated }
    | { ok: false, code, message, retryAfterMs? },

  async fetch({ url, maxChars? }):
    | { ok: true, url, finalUrl, status, contentType, truncated, text, bytes, redirects }
    | { ok: false, code, message },

  revoke(): void,          // 宿主在调用结束时撤销这份能力
}

// Source
{ title, url, snippet, publishedDate?, score? }
```

**五条硬约束：**

1. **可信 invocation。** 只有 `pluginId === 'web-search'`、来源是
   `owner-private` / `console`、且由对应工具发起（`search` 只认
   `plugin_web_search`，`fetch` 只认 `plugin_web_fetch`）才可能发请求。
   缺失、伪造或已失效的调用上下文一律 `E4071`，且**零请求**。
2. **开关现读。** `search` / `fetch` 进入时会重新读总闸，不缓存构造时的值。
   用户刚关掉总闸，下一个请求立即返回 `E4080`，且**一个字节都不会发出去**。
3. **取消透传。** 宿主把"本次调用取消"与"总闸关闭"合成一个 signal；
   abort 时返回 `{ok:false, code:'E4070'}`，并保证连接被销毁。
4. **按调用发放、用完失效。** 宿主在每次工具调用时生成这个对象，调用结束
   （executor 的 `finally`）调用 `revoke()`；之后任何 `search` / `fetch`
   返回 `E4071`。`init` / `testConnection` 没有调用上下文，同样只能拿到
   `E4071` —— 装配与自检阶段不该联网、也不该花额度。
5. **失败不抛异常。** 与其他受控能力一致：返回结果对象。插件应当把它
   直接交给模型，而不是 try/catch 后包成 `E4066`（那会让模型以为"工具坏了"，
   而真实原因可能是"还没配 Key"或"服务类型不受支持"）。

**为什么不把 Key 给插件：** Key 一旦进了插件，插件就能绕过宿主直接调上游 ——
额度照花，而总闸、统计、取消全部失效。所以 `process` 运行时下，
子进程只拿到 `available / enabled / provider / configured` 四个标量，
真正的请求由父进程发（host-call 转发，见 §5.5）。

**这条 Key 的边界只限 `web-search` 这一把，不是通用 secrets 契约。**
"Key 不下发 / 不回显 / 不进日志"说的是 `web-search` 由宿主托管、代发请求的
`apiKey`；其他插件仍按 §5.1 与 §6 的既有约定，在自己的 `init` 里拿到清单声明的
`secrets`。不要把这个特例推广成"所有插件都拿不到密钥"。

**init / 测试连接阶段只有事实。** 那时没有调用上下文，`search` / `fetch`
会返回 `E4071`。这是有意的：`validateConfig` 是纯计算，`init` 也不该联网。
插件在 `init` 里唯一该做的是读 `ctx.net.configured` 决定提示什么。

**网页读取的限制（`fetch`）：**

| 限制 | 值 |
| --- | --- |
| 协议 | 只允许 `http:` / `https:`（没有 `file://` / 盘符 / UNC 这条分支） |
| URL 长度 | ≤ 2048 字符，首跳与每一跳都查 |
| 端口 | 只允许 80 / 443（否则一个公网域名 + 任意端口就能扫对端服务） |
| 目标 | 每跳都重新做 URL 形状 + DNS 全量解析 + 私网判定（防 SSRF / DNS rebinding） |
| 重定向 | ≤ 4 跳，每跳重新校验；重定向正文直接丢弃 |
| 响应体 | ≤ `maxFetchBytes`（1KB–1MB，默认 200KB）；**wire（压缩前）与 decoded（解压后）都计数**，超出截断并置 `truncated` |
| 内容类型 | 白名单：`text/html`、`application/xhtml+xml`、`text/plain`、`text/markdown`、`application/json`、`application/ld+json`；**缺失 Content-Type 也拒绝**（`E4088`），不猜 HTML |
| 内容编码 | 只接受空 / `identity` / `gzip` / `x-gzip` / `deflate` / `br`；多重与未知编码 → `E4088` |
| 总时限 | `fetchTimeoutMs`（1s–30s），覆盖 DNS + 连接 + 全部跳 + 正文；DNS 也受 deadline/signal 约束 |
| 请求头 | 不带 Cookie / Authorization / Referer —— 我们没有"登录态"可发 |
| 收尾 | 取消或截断后销毁 req/res/decoder 与定时器，不允许继续下载 |

返回的 `text` 已由宿主降级为纯文本（删 script/style/注释、解常见实体、压空白），
但**仍是外部内容**：插件把它交给模型时，必须走工具结果（`wrapToolResult`），
不得拼进系统提示或工具描述。

协议目前只实现 **Tavily Search API**（`POST {baseUrl}/search`、`Authorization: Bearer`）。
`provider` 配成未知值会**明确拒绝**并返回 `E4081`，不会静默按 Tavily 发 ——
"猜一个通用格式"会让协议不符伪装成"没搜到"。

> 协议细节、错误码语义与验收清单见 [web-search-contract.md](web-search-contract.md)。
> 用户向说明见 [web-search.md](web-search.md)。

### 5.4 取消信号

`callTool({ tool, args, ctx, signal })` 里的 `signal` 是**本次调用**的信号，不是插件生命周期的信号。

它会在这些时候 abort：

- 用户在这个回合点了「停止」；
- 宿主判定本次调用超时（超时仍按 `E4065` 报错，但信号会先 abort，插件有机会自己收尾）；
- 插件被停用/重载（这时也是插件整体的信号）。

`ctx.signal` 与入参 `signal` 是**同一个组合信号**，读哪个都行，
推荐统一用 `ctx.signal`（它一定存在，而入参在直接调用运行时的情况下可能没有）。

插件应该把它透传给自己的 `fetch`、子任务、循环：

```js
const r = await fetch(url, { signal: ctx.signal });   // 而不是裸 fetch(url)
```

**不检查就会一直跑到超时。** 症状是"点了停止，插件还在转"，然后用户等 20 秒看到失败。
`process` 运行时下更糟：abort 后宿主**不一定**杀子进程（见下），插件会继续占着 CPU。

取消后：

- 宿主返回 `E4070`（调用已取消），**不再把结果回灌给模型**。
  这一点很重要：模型不该看到"你取消了的那次调用的结果"，否则它会以为操作成功了。
- **`E4070` 不会被当成插件崩溃。** 管理器只对 `E4065` / `E4066` 把状态标成 `crashed` 并撤工具；
  取消不在其列。否则用户点一次「停止」，插件就被标成「已崩溃」、工具从列表里消失——
  看起来像"点了停止把插件点坏了"，而实际上什么都没坏。
- **取消 ≠ 杀进程。** `process` 运行时收到取消只发一条 `{ type: "cancel", id }`
  给子进程（由子进程自己决定怎么停），**不会**像超时那样 `kill`。
  超时仍然 kill —— 超时意味着插件已经不可信（可能卡死），取消只意味着"这一轮不用了"。
  子进程迟到的 `result` 会因为找不到对应请求而被丢弃，无害。
- `in-process` 运行时无法抢占正在执行的 JS 函数，取消只能靠插件自己看信号。
  这就是上面为什么强调"必须透传"。

### 5.5 两种运行时的一致性

| 能力 | `process` | `in-process` | 说明 |
| --- | --- | --- | --- |
| `init` / `dispose` | 支持 | 支持 | 行为一致；`in-process` 的重载只对入口文件生效 |
| `callTool` | 支持 | 支持 | 参数、返回值、超时语义一致 |
| `testConnection` | 支持 | 支持 | 可在未初始化时调用 |
| `validateConfig` | **不支持** | 支持 | 仅 `in-process` + `trusted` 可声明（§2.8）；`process` 拿不到"保存时同步给结论"这件事 |
| `messagePriority` | **不支持** | 支持 | 仅 `in-process` + `handleMessage: true` 可声明（§2.7）；`process` 根本收不到消息 |
| `ctx.caller` | 支持 | 支持 | 由宿主生成，两端同形状；`init` / `testConnection` / `dispose` 里没有 |
| `ctx.chat.*` | 支持 | 支持 | 同一份实现在父进程；`process` 只是转发 |
| `ctx.net.*` | 支持 | 支持 | 请求全部在父进程执行；`process` 只拿到四个同步事实；`web-search` 宿主托管的那把 Key**不下发**（不是通用 secrets 规则，见 §5.3.2） |
| 取消（`ctx.signal`） | 支持 | 支持 | `process` 转发 `cancel`，不 kill |
| 超时后强杀 | 支持 | **不支持** | 同进程无法抢占执行中的函数 |
| `handleMessage` | **不支持** | 支持 | 见下 |

两个容易误解的点，写在这里免得踩：

1. **`handleMessage` 仍然只有 `in-process` 支持。**
   `process` 插件即使在清单里写 `handleMessage: true`，也**不会**收到任何消息。
   清单允许声明它（否则纯通道插件的包形状校验会拒绝），但宿主只向 `in-process` 实例投递。
   所以：
   - `process` 插件别写 `handleMessage`，写了也没有效果；
   - 需要接管消息的插件只能是随包内置的 `trusted: true` + `in-process` 插件；
   - 想"处理消息"的第三方插件请改用工具（由 AI 回合触发），而不是接管消息。

2. **`chat.*` 两端一致，因为实际处理都在父进程。**
   子进程只是通过 NDJSON 协议把请求转给宿主：
   插件进程发 `host-call`（带上"我是哪次调用"的 callId），宿主执行后回 `host-call-result`。
   所以"`process` 插件的聊天能力更弱/更强"这个担心不成立——
   它拿到的 `recent` / `send` 结果与 `in-process` 完全相同，
   区别只是**多了一次跨进程往返**（因此也受协议超时约束）。

   **子进程不能自己填会话**：`host-call` 里的 callId 是宿主发给它的，
   宿主按这个 id 从自己的表里查"本次调用的 convKey"。消息里即使夹带
   `convKey` / `origin` 也不被读取——不是过滤，是压根不看。
   找不到对应调用时返回 `E4074`（无法确认会话归属）。

3. **`ctx.caller` 也不能由子进程构造。** 同一个道理：调用上下文由父进程
   生成并在 `call` 消息里带过去，子进程只是原样转进 `ctx.caller`。

### 5.6 生命周期

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
| `E4070` | 调用已取消（用户停止 / 宿主取消，结果不再回灌模型） |
| `E4071` | 运行时或宿主不支持该能力（宿主能力缺失、读取会话失败、`callId` 对应的调用上下文已结束、内部装配问题） |
| `E4072` | 宿主未提供聊天能力或网关能力（未注入聊天桥，如插件单测环境） |
| `E4073` | 内容或数量不合法/超限（一次调用 >3 条消息、一条 >4 个媒体、文本 >4000 字、文件 >10MB、句柄非法或过期、缺少 messageId） |
| `E4074` | 归属不符或跨会话访问被拒绝（消息/引用不属于当前会话、媒体句柄属于别的插件或会话） |
| `E4075` | 插件私有路径越界（`registerMedia` / `sendFace` 的文件不在该插件 `dataDir` 内，含符号链接跳出去） |
| `E4080` | 联网已关闭（总闸关着，或该插件的能力被配置禁用） |
| `E4081` | 搜索服务未配置（无 Key 或服务地址非法） |
| `E4082` | 上游鉴权失败（Key 失效或被撤销） |
| `E4083` | 配额用尽或限流（带 `retryAfterMs` 时按它退避） |
| `E4084` | 联网请求超时 |
| `E4085` | 上游响应不符合协议（含"200 但不是 JSON / 缺 results"；**不得**当空结果） |
| `E4086` | 上游故障（5xx / 连接失败） |
| `E4087` | 目标地址不被允许（内网 / 本机 / 非 http(s) / URL 内嵌凭据） |
| `E4088` | 内容类型或大小不被允许（不是可读正文） |
| `E4101` | 本机无法使用加密存储（DPAPI 不可用） |

网关侧另有三个**不属于 E40xx** 的码，由 `ctx.gateway` 返回（见
[stickers-contract.md](stickers-contract.md) §9.1）：

| code | 含义 |
| --- | --- |
| `E_GATEWAY_UNAVAILABLE` | 动作调用失败（网络、网关报错）。**不是**"网关不支持" |
| `E_GATEWAY_UNSUPPORTED` | 网关**实测**不支持该扩展动作（探测结论或明确错误） |
| `E_GATEWAY_BAD_PAYLOAD` | 返回结构不符合约定。调用方**不得**把这种情况当成空结果处理 |

> 这三个刻意不复用 `E4071`：`E4071` 是"宿主这边没接好"，
> 而这三个说的是"网关那边"的事。混用会让排查方向跑到宿主代码里去。

补充说明：

- `E4070`–`E4075` 都属于**插件契约层**的错误，插件可以把它们当普通工具结果返回给模型；
  宿主自己产生的同类错误也会用这些 code。
- `E4073` 与 `E4075` 都是"插件想做的事超出了允许范围"，但含义不同：
  前者是量或形状不对（改小、改正参数就能再来），后者是路径越界
  （说明实现有问题，改小也没用）。排查时先分清这两类。
- `E4074` 的两种来源要分开看：**消息/引用不属于当前会话**（模型或插件传了别的会话的 id）、
  **句柄归属不符**（插件 A 用了插件 B 的句柄，或别的群的句柄）。
  统一报"归属不符"是有意的：如果区分"不存在"和"别人的"，
  拿一串 id 试探就能探测别的会话里有没有某条消息。
- **`process` 插件在调用结束后还想用聊天能力，报 `E4071` 或 `E4070`，不是 `E4074`。**
  这是刻意的更正：`callId` 查不到最常见的原因是"这次调用已经结束"
  （取消/超时后父进程删了表项），此时报 `E4070`（若插件正在停用）或
  `E4071`（调用已结束）。把它报成 `E4074` 会让人去查会话归属，
  而真正要查的是调用生命周期 —— 那两者是完全不同的排查方向。
- `E4072` 不是插件的 bug。它表示"当前环境没有聊天桥"，插件应降级而不是报错给用户。
- **`E_GATEWAY_UNAVAILABLE` 与 `E_GATEWAY_UNSUPPORTED` 不要混。**
  前者是"这次没成"（重试可能成功），后者是"这个网关没有这个功能"
  （重试一万次也一样）。把它们显示成同一句话，用户会一直在试一个
  永远不会成功的操作。
- `E4070` 与 `E4065` 不要混：取消是"这一轮不用了"（不杀进程、不标 crashed），
  超时是"它卡住了"（`process` 运行时会被 kill，可能转 `crashed`）。

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
  chatTools: {                // 聊天来源授权，与配置同形状（界面回显用）
    group:     { enabled, tools, allowPaid },
    private:   { enabled, tools, allowPaid },
    proactive: { enabled, tools, allowPaid },
  },
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
    name, fullName, description, needs,
    risk,                       // 生效风险：max(声明 risk, effects 下限)
    declaredRisk,               // 作者在清单里写的那个 risk
    effects,                    // 清单里声明的行为分类（§4.2），空数组表示未声明
    confirm,                    // 由宿主推导，只读展示
    timeoutMs, params,
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

### 10.3 `setting` 通道的新键：`plugins.chatTools`

不新增 RPC 方法，`chatTools` 走既有的 `setting` 通道（界面和脚本都能写）：

| key | 值 | 说明 |
| --- | --- | --- |
| `plugins.chatTools.group` | `{ enabled, tools, allowPaid }` | 群聊档 |
| `plugins.chatTools.private` | `{ enabled, tools, allowPaid }` | 普通私聊档 |
| `plugins.chatTools.proactive` | `{ enabled, tools, allowPaid }` | 主动唤醒档 |
| `plugins.chatTools` | 整块（三个档的对象） | 脚本一次性写入用 |

单档写入示例（界面点一个开关就是这种形状）：

```json
{ "method": "setting", "params": { "key": "plugins.chatTools.group",
  "value": { "enabled": true, "tools": ["plugin_hello"], "allowPaid": false } } }
```

- 校验失败返回 `E40XX`，**不会部分写入**：`tools` 里有一项非法时，整次设置都不生效。
  否则会出现"三个工具写进去两个"，而界面显示已开启。
- 校验内容：`enabled` / `allowPaid` 必须是布尔；`tools` 必须是字符串数组（最多 32 项），
  每项要么是 `"*"`，要么是形如 `plugin_xxx` 的完整工具名。写内置工具名会被拒绝。
- 单个档的写入是**替换**语义，不是合并：传 `tools: []` 就是清空，
  不会保留上一次的名字。这样脚本与界面看到的是同一个状态，不会出现"你以为清空了其实没有"。
- 写入后立即生效（宿主每个回合现读配置），不需要重启；与 `plugins.allowDangerous` 一致。
- 快照里的 `plugins.chatTools` 与配置同形状，界面直接拿来回显，不需要自己拼默认值。
  配置被手改坏（比如写成 `chatTool` 少个 s）时，宿主**退回默认全关**而不是让所有权失效——
  "配置坏了所以全放开"是最糟的一种失败方向。

### 10.4 可信插件的后台媒体投递

宿主仅为trusted同进程插件提供生命周期级 `ctx.deliverMedia({convKey,path,kind,mime,name,signal,auditText})`。目标会话必须来自可信caller并随任务持久化，文件限插件dataDir内普通文件、单张10MiB；返回 `{ok,messageId,handle,bytes}` 或 `{ok:false,code,message}`。process运行时不提供此能力。

投递走宿主统一会话串行器与发送闸门，真正出队时重新检查插件存活与任务signal。工具返回不结束后台能力，插件停用则立即撤销。宿主初始化失败同样dispose已创建runtime；插件应在初始化前挂好中止与状态清理逻辑。媒体句柄会过期，原来源查询可通过 `ctx.chat.registerMedia` 从保存文件重新登记。

## 11. 验收清单（新增一个工具插件，零主程序改动）

1. 把插件包放到 `<userData>/plugins/<id>/`（或调用宿主的安装能力）。
2. 重启后端（或插件页点「重新扫描」）→ 插件出现在列表，状态「已安装未启用」。
3. 在插件页填配置并保存 → 重启后配置仍在；密钥只显示「已设置」。
4. 启用 → 状态「运行中」，工具出现在「工具清单」；AI 能看到并按授权调用。
5. 停用 → 工具立即从 AI 工具列表消失，新的调用被拒绝（`E4067`）。
6. 插件更新（加工具/加配置项/改实现）→ 只需替换插件包，主程序源码与 exe 不变。
7. 插件初始化失败、崩溃或超时 → 插件页显示错误码与日志，主程序继续正常运行。
8. **授权给白名单会话后工具才在群里可见**：`needs: "qq"` 的插件工具装好后，
   群里默认看不到（`chatTools` 默认全关）；把完整工具名写进
   `plugins.chatTools.group.tools` 并 `enabled: true` 之后，群聊来源才拿得到它
   （普通工具仍受R1上限约束；插件自审收费R2仅按§2.6精确例外放行，并由插件逐次审批）。
   反过来，把它从 `tools` 里删掉，群里立即不可见——不需要停用插件。

   顺带验证：`needs: "host"` 的工具**永远**进不了群，把它写进 `tools` 也不行；
   管理员私聊/桌面端**不受** `chatTools` 影响，仍然按 `needs`/`risk` 可见。
9. **主动回合需要单独开 `chatTools.proactive`**：只开 `group` / `private` 时，
   机器人自己发起的主动唤醒回合仍然拿不到任何插件工具；
   要给它工具，必须显式打开 `proactive` 档（这是 §2.6 里的刻意设计，不是漏配）。
10. **`effects` 抬升可见**：给工具加 `"effects": ["chat.send"]` 而 `risk` 仍写 `"R0"`，
    插件页里该工具的生效风险应显示为 `R1`（`declaredRisk` 仍是 `R0`），
    并且它不再自动执行。

可执行验收脚本：`scripts/e2e-plugins.mjs`（真实后端 stdio JSON-RPC）。
