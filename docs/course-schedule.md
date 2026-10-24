# 课程表插件（course-schedule）实现契约

本文是 `plugins/course-schedule/` 的**唯一实现基准**。宿主侧扩展（参数 schema、
`data.session` effect、聊天来源授权）与插件侧实现必须一起满足这里的规定；
任何一边想改形状，先改本文。

- 插件目录：`plugins/course-schedule/`（随包内置，默认**不启用**）
- 运行方式：`runtime: "in-process"`、`trusted: true`（与 `dsh-bridge` / `regex-reply` 一致）。
  原先打算用 `process` 来"顺带验证子进程运行时"，但**验收环境禁止创建子进程**
  （`spawn EPERM`），那样插件在本机根本起不来，等于没有可验证的东西。
  运行时差异已由 `test/plugin-runtime-parity.test.mjs` 用"假 child"覆盖，
  不需要拿这个插件再赌一次环境。
- 数据位置：`<userData>/plugin-data/course-schedule/`（宿主注入的 `ctx.dataDir`）
- 接口版本：`apiVersion: "1"`（宿主契约见 [plugin-api.md](plugin-api.md)）

---

## 1. 归属：数据属于谁

**归属键由宿主提供的 `ctx.caller` 计算，工具参数里没有"用户/会话"参数。**

```
owner = {
  convKey:  String(ctx.caller.convKey),      // 如 "private:123" / "group:456"
  userId:   String(ctx.caller.requester.id), // 触发者；console/proactive 为空串
}
```

规则：

1. `convKey` 为空 → 拒绝执行（`E_COURSE_NO_IDENTITY`），**不**回退到任何全局库。
2. `userId` 非空时，同一会话内**按人隔离**（群聊里每个人有自己的课程表）。
3. `userId` 为空（桌面端手动执行、主动回合）时，归属退化到 `convKey` 本身。
4. 文件名 = `sha256(convKey + "\n" + userId)` 的前 32 个十六进制字符 + `.json`。
   不用原串做文件名，避免群号/QQ 号直接散落在目录里，也避免路径注入。
5. 文件里同时保存 `owner` 原文，读取时**必须**与当前归属逐字段相等，否则视为
   身份不符（`E_COURSE_NO_IDENTITY`），不返回内容。
6. 模型无法指定他人身份：清单里没有任何归属参数；`RESERVED_PARAM_NAMES`
   也保证了 `origin` / `convKey` / `caller` 不可能作为参数出现（见 plugin-api §4.1）。

---

## 2. 课程数据结构

一条课程（保存后的完整形状）：

```json
{
  "id": "c_3f8a1c2d",
  "name": "高等数学",
  "weekday": 1,
  "periods": [1, 2],
  "startTime": "08:00",
  "endTime": "09:40",
  "location": "教三楼 301",
  "teacher": "张老师",
  "termStartDate": "2026-09-07",
  "weekStart": 1,
  "weekEnd": 16,
  "parity": "all",
  "note": "",
  "createdAt": "2026-10-23T09:00:00.000Z",
  "updatedAt": "2026-10-23T09:00:00.000Z"
}
```

| 字段 | 必需 | 规则 |
| --- | --- | --- |
| `id` | 保存后 | `^c_[0-9a-f]{8}$`，由插件生成，模型可读不可写 |
| `name` | 是 | 1–60 字，去首尾空白；不能是纯符号 |
| `weekday` | 是 | 整数 1–7（1 = 周一） |
| `periods` | 二选一 | 整数数组，1–20，去重升序，最多 12 项；与 `startTime/endTime` 至少有一组 |
| `startTime` / `endTime` | 二选一 | `HH:MM`（24 小时制），必须成对出现，且 `startTime < endTime` |
| `location` | 否 | 0–80 字。**缺失时不许编造**，见 §4 |
| `teacher` | 否 | 0–40 字。同上 |
| `termStartDate` | 是 | `YYYY-MM-DD`；**归一化到该日期所在周的周一**，并回写 |
| `weekStart` / `weekEnd` | 是 | 整数 1–30，`weekStart <= weekEnd` |
| `parity` | 否 | `all`（默认）/ `odd`（单周）/ `even`（双周） |
| `note` | 否 | 0–200 字 |

`periods` 与时间同时给出时**两者都保留**：`periods` 用于表格与冲突判定的主键，
时间用于展示与"跨节次"冲突的补充判定。

---

## 3. 日期、周次与时区

1. 全部日期计算**只用日历日**，不依赖进程时区：
   - `parseDate('YYYY-MM-DD')` → `{ y, m, d }`，非法（如 `2026-02-30`）直接拒绝；
   - 差分用 `Date.UTC(y, m-1, d)` 的毫秒差除以 86400000，避免夏令时。
2. 周次公式：`week = floor((date - termStartDate) / 7 天) + 1`。
   - `date < termStartDate` → `week <= 0`，表示"学期还没开始"；
   - `week > weekEnd` → 学期已过（或该课已结课）。
3. 单双周：`week % 2 === 1` 为单周，`0` 为双周；`parity` 不匹配即当天无此课。
4. 时区只影响"今天"的判定：插件**不读系统本地时区**，而是用配置项
   `timezone`（默认 `Asia/Shanghai`）通过 `Intl.DateTimeFormat` 取当地
   `YYYY-MM-DD`。宿主机器时区与本插件无关，跨时区部署结果稳定。
5. 跨学期：每条课程自带 `termStartDate`，因此同一归属下**可以同时存在多个学期**的课程。
   - 按日期查询时，候选学期 = `termStartDate <= date` 的记录；
   - 若多个学期同时命中（周次都落在范围内），取 `termStartDate` **最晚**的那个，
     并在结果里给出 `termStartDate`，让模型能说清"这是哪个学期"；
   - `course_list` 支持 `termStartDate` 过滤，不给则按学期分组返回。

---

## 4. 必要信息与"不编造"

| 分类 | 字段 | 缺失时 |
| --- | --- | --- |
| 必要 | `name` / `weekday` / 时间（`periods` 或 `startTime+endTime`）/ `termStartDate` / `weekStart`+`weekEnd` | `preview` 返回 `missing`，`save` 直接拒绝（`E_COURSE_NEEDS_INFO`） |
| 建议 | `location` / `teacher` | `preview` 返回 `optionalMissing`，并给出"先问用户，不要编造"的提示；`save` 需要 `acknowledgeOptionalMissing: true` |

`preview` 的输出里，`optionalMissing` 一定非空的记录会带
`askUser: "地点未提供：请先向用户确认，不要自行编造。"` 这样的句子，
供模型原样转述。**插件不提供任何默认地点/教师/时间**。

---

## 5. 校验与冲突

### 5.1 单条校验

- 字段类型、范围、串长（见 §2）；`startTime`/`endTime` 用 `^([01]\d|2[0-3]):[0-5]\d$`。
- `periods` 越界、重复、空数组（若没有时间则非法）。
- `weekStart > weekEnd`、`weekEnd > 30`、`termStartDate` 非法。
- 单归属课程数上限由配置项 `maxCourses` 决定（默认 60，1–200）。

### 5.2 冲突

两条课程构成冲突，当且仅当**全部**成立：

1. `termStartDate` 相同，且 `weekday` 相同；
2. 周次集合有交集（按 `weekStart..weekEnd` 与 `parity` 展开后求交）；
3. 时段重叠：
   - 两边都有 `periods` → 节次数组有交集；
   - 只有一边有 `periods`、另一边只有时间 → 时间区间与节次**无法比较**，按"潜在冲突"处理
     （标记 `reason: "时间与节次无法比较"`，仍需人工确认）；
   - 两边都只有时间 → 区间相交（端点相接不算冲突）。

冲突不是"静默丢弃"：`preview` 只报告，`save` / `update` 在
`overwriteConflicts: true` 之前**拒绝写入**（`E_COURSE_CONFLICT`），并把冲突对
（课程名 + 星期 + 节次 + 周次）原样返回。

### 5.3 重复课程

同一归属下，`name + weekday + periods + startTime + termStartDate + weekStart + weekEnd + parity`
完全相同的两条记录视为重复。`preview` 标记 `duplicateOf`，`save` 默认拒绝，
`allowDuplicate: true` 时才写入（用户可能真的有两节同名课，但必须显式确认）。

**`termStartDate` 必须参与比较**：2026 秋与 2027 春的同名课是两门不同的课，
不该让用户每个学期都为同一门课点一次「确认重复」。早期版本的字段表漏了它，
结果是跨学期录课每天都要显式允许重复，久了会让这个检查被条件反射地跳过。

---

## 6. 工具

所有工具 `needs: "qq"`。名字对模型是 `plugin_<name>`。

| 工具 | 风险 | effects | 参数 | 作用 |
| --- | --- | --- | --- | --- |
| `course_preview` | R0 | `data.read` | `courses`（对象数组，1–20 条）、`termStartDate?`、`timezone?` | 规范化 + 校验 + 冲突 + 文本表格；生成 `draftId` |
| `course_save` | R1 | `data.session` | `draftId`、`overwriteConflicts?`、`acknowledgeOptionalMissing?`、`allowDuplicate?` | 保存**预览过的那份**草案 |
| `course_cancel` | R0 | `data.read` | `draftId?` | 丢弃草案（不给则丢弃该归属全部草案） |
| `course_day` | R0 | `data.read` | `date?`（默认今天）、`timezone?` | 某天课程 + 第几周 + 单双周 |
| `course_week` | R0 | `data.read` | `date?`（该周任一天，默认今天）、`timezone?` | 周一到周日的表 |
| `course_list` | R0 | `data.read` | `weekday?`、`termStartDate?` | 全部课程（按学期分组） |
| `course_update` | R1 | `data.session` | `courseId`、`patch`（对象）、`overwriteConflicts?` | 局部修改，改后重新校验 |
| `course_delete` | R1 | `data.session` | `courseId?`、`all?` | 删除一条或全部 |

### 6.1 为什么 `save` 不接受课程内容

`course_save` **只有** `draftId`，内容来自 `preview` 时生成的内存草案。
这样"保存的"与"用户看到的表格"是同一份对象，模型无法在两次调用之间
偷改时间/地点。草案绑定 owner（归属不符直接拒绝）、15 分钟过期、保存一次即失效。

### 6.2 草案生命周期

- 位置：插件进程内存（`Map`），最多 20 条/进程，超出淘汰最旧；
- 过期：15 分钟（`createdAt` 起算），过期后 `save` 返回 `E_COURSE_DRAFT_MISSING`；
- 重启即全部失效 —— 草案是"正在确认中的输入"，不是持久数据；
- `cancel` 是显式取消路径；用户说"算了/取消"时模型应调用它（不调用也会自然过期）。

---

## 7. 持久化

文件：`<dataDir>/courses/<ownerHash>.json`，形状：

```json
{
  "schema": 1,
  "owner": { "convKey": "private:123", "userId": "456" },
  "updatedAt": "2026-10-23T09:00:00.000Z",
  "rev": 7,
  "courses": []
}
```

规则：

1. **原子写**：写 `<file>.<uuid>.tmp` → `fsync` → `rename`；rename 在 Windows 上
   对 `EPERM` / `EBUSY` / `EACCES` 退避重试（与宿主 `atomic.mjs` 同一套口径，
   插件不能 import 宿主代码，所以自带一份等价实现）。
2. **并发写**：同一文件的读-改-写在插件内**串行化**（按路径的 promise 链）。
   进程内并发调用不会互相覆盖；`rev` 用于写入后自检，若 rename 前发现磁盘
   `mtime` 的 `rev` 已被改（理论上不会发生），重读后重试一次。
3. **损坏文件**：JSON 解析失败 / 形状不符 / `owner` 不匹配 →
   - 抛出 `StorageCorrupt`，工具返回 `E_COURSE_STORE_CORRUPT` 与文件路径；
   - **绝不**把它当空库，也**绝不**自动覆盖；
   - 写操作同样拒绝（防止用空数据盖掉用户仅有的副本）；
   - 唯一的恢复路径是用户显式 `course_delete({ all: true, forceCorrupt: true })`，
     此时把原文件改名为 `<file>.corrupt-<ts>.bak` 保留证据，再写空库。
4. 目录不存在时按需创建；文件不存在 = 空库（这是唯一允许的"空"）。
5. 读取时做完整形状校验（`schema`、`owner`、`courses` 数组、每条记录合法），
   不合法按损坏处理。

---

## 8. 输出与文本表格

- 所有工具返回 JSON 对象，字段稳定，便于模型二次加工。
- 表格用等宽文本（`lib/format.mjs`），中文按 2 列宽计算，避免群聊里错位：
  - 列：`星期 | 节次 | 课程 | 地点 | 教师 | 周次`
  - 空地点显示 `—`（不写"未知"以外的编造内容）
  - 表头最多 60 字符宽；超长课程名截断加 `…`
- 单次返回文本总长 ≤ 4000 字（宿主单条消息上限），超出时截断并提示"仅显示前 N 条"。

---

## 9. 宿主侧需要的扩展（与插件同时提交）

1. **参数 schema 支持对象**（`plugin-api.md` §4）：
   - `type: "object"` 顶层参数，含 `properties`（递归，深度 ≤ 3）与 `required`；
   - `type: "array"` 的 `items` 允许 `{type:"object", properties}` 或标量；
   - `validateParams` 递归校验 + 按声明白名单过滤（多余键丢弃，不报错）；
   - `toJsonSchema` 递归输出，保持旧工具 schema 完全不变。
2. **新增 effect `data.session`**：
   - 含义：读写**插件自己 dataDir 内、按宿主 caller 会话/用户隔离**的业务数据；
   - 风险下限 **R1**；
   - 允许被 `plugins.chatTools` 点名进入聊天来源（`data.write` / `exec` 仍然禁止）；
   - **为什么是 R1 而不是 R2，这不是随便定的**：聊天来源的风险上限是 R1。若给
     `data.session` 定 R2，它就会被 `chatGrantAllows` 的"风险过高"直接挡掉，
     `plugins.chatTools.group` 里点名也没用 —— 那么"群友在群里查自己的课程表"
     这件事**永远不可能**发生。换句话说，R1 是"这门能力在群里可用"的前提，
     不是宽松。将来若把课程表加进"发图/付费"那类工具，改的应该是那个工具的
     `effects`（加 `chat.send` / `paid`），而不是把 `data.session` 提到 R2。
   - 它**不是**技术性隔离：process 运行时无法阻止插件写任意文件。这条 effect 是
     "授权分类 + 作者声明"，宿主的强制点在 `ctx.caller`（归属只能由宿主给）。
3. **内置清单**：`BUILTIN_PLUGINS` 增加 `course-schedule`，默认不启用。

---

## 10. 模块边界与返回形状

### 10.1 文件划分

```
plugins/course-schedule/
  plugin.json          # 清单：配置项 + 8 个工具
  index.mjs            # 入口：init / callTool / testConnection / dispose
  lib/time.mjs         # 日期、周次、单双周、时区（纯函数）
  lib/model.mjs        # 字段归一化 + 校验 + 冲突 + 重复（纯函数）
  lib/store.mjs        # 归属、原子写、串行化、损坏检测（唯一 IO）
  lib/format.mjs       # 文本表格 / 列表渲染（纯函数）
```

`lib/*.mjs` 只 import `node:` 内置模块与包内相对路径（插件必须自包含）。

### 10.2 返回形状

所有工具返回对象，成功时 `ok: true`（`course_preview` 即使有冲突也返回 `ok: true`
并把问题放进字段，因为"预览"本身就是成功的）；失败时
`{ ok: false, code, message }`。

| 工具 | 成功返回 |
| --- | --- |
| `course_preview` | `{ ok, draftId, count, courses, table, missing, optionalMissing, conflicts, duplicates, warnings, expiresAt }` |
| `course_save` | `{ ok, saved, count, table, courses }` |
| `course_cancel` | `{ ok, cancelled }`（取消的草案数） |
| `course_day` | `{ ok, date, weekday, week, parity, count, courses, table }` |
| `course_week` | `{ ok, week, monday, sunday, count, table }` |
| `course_list` | `{ ok, count, terms: [{ termStartDate, count, table }], table }` |
| `course_update` | `{ ok, course, table }` |
| `course_delete` | `{ ok, deleted }`（删除条数）、`{ ok, reset: true, backup? }` |

错误码（插件自定义，前缀 `E_COURSE_`）：

| code | 含义 |
| --- | --- |
| `E_COURSE_NO_IDENTITY` | 没有可信归属（`ctx.caller` 缺失或 `convKey` 为空） |
| `E_COURSE_BAD_ARG` | 参数不合法（字段级错误在 `message` 里点名） |
| `E_COURSE_NEEDS_INFO` | 缺少必要信息，不能保存 |
| `E_COURSE_CONFLICT` | 时间冲突且未确认覆盖 |
| `E_COURSE_DUPLICATE` | 重复课程且未确认 |
| `E_COURSE_DRAFT_MISSING` | 草案不存在 / 已过期 / 不属于当前归属 |
| `E_COURSE_NOT_FOUND` | 课程 id 不存在 |
| `E_COURSE_STORE_CORRUPT` | 数据文件损坏或归属不符（附路径，绝不覆盖） |
| `E_COURSE_LIMIT` | 超出课程数量上限 |

`course_preview` 的 `courses[i]` 是**归一化后**的课程对象（无 `id`），并带
`issues: [{ field, code, message }]`。`conflicts[i]` 形如
`{ courseIndex, withCourseId, withName, weekday, reason }`。

### 10.3 配置项（`plugin.json` 的 `config`）

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `timezone` | enum（`Asia/Shanghai` / `UTC` / `Asia/Tokyo` / `Europe/London` / `America/New_York`） | `Asia/Shanghai` | 判定"今天"用 |
| `defaultTermStartDate` | text（可为空） | `""` | 用户没给学期开始日期时的**建议值**（仍要求用户确认，不自动填） |
| `maxCourses` | number（1–200，整数） | `60` | 单归属课程上限 |
| `draftTtlMs` | number（60000–3600000，整数） | `900000` | 草案有效期 |

### 10.4 测试入口约定

插件单测直接 `import` 入口的 `default`，构造一个宿主形状的 `ctx`：

```js
const ctx = {
  plugin: { id: 'course-schedule', dataDir },
  config: { timezone: 'Asia/Shanghai', defaultTermStartDate: '', maxCourses: 60, draftTtlMs: 900000 },
  dataDir,
  log: () => {},
  caller: { origin: 'owner-private', convKey: 'private:1', isGroup: false,
            requester: { id: '1', nickname: '主人' }, messageId: null },
  signal: new AbortController().signal,
};
const r = await plugin.callTool({ tool: 'course_preview', args: {...}, ctx });
```

**测试不得依赖模块级状态**（草案表是模块级，但每个用例用不同 `convKey`，
或在用例开头调 `course_cancel`）。重启恢复用"新建 store 实例"表达：
同一 `dataDir` 上重新 `import` 入口并重新 `init` 后 `list` 仍有数据。

---

## 11. 验收场景（测试必须覆盖）

1. 整理后保存：`preview` → 用户确认 → `save` → `list` 能看到。
2. 确认取消：`preview` → `cancel` → `save` 返回 `E_COURSE_DRAFT_MISSING`，库无变化。
3. 周次/单双周查询：第 3 周（单）有课、第 4 周（双）没有；`parity: "even"` 相反。
4. 修改：`update` 改时间/地点后，查询结果随之变化；改后冲突被拦。
5. 重启恢复：同一 dataDir 新建 store 实例，`list` 结果与保存前一致。
6. 数据隔离：`private:1` 与 `private:2`、`group:9#u1` 与 `group:9#u2` 互不可见。
7. 冲突：同学期同星期同节次且周次重叠 → `save` 拒绝；`overwriteConflicts` 后成功。
8. 损坏文件：手写坏 JSON → `list`/`save` 返回 `E_COURSE_STORE_CORRUPT`，
   文件内容保持原样；`forceCorrupt` 重置后留下 `.corrupt-*.bak`。
9. 参数校验：非法 `weekday`（0/8）、非法时间（`25:00`）、`weekStart > weekEnd`、
   非法日期（`2026-02-30`）都要被拒绝，且错误信息指出字段。
10. 授权：默认群里看不到课程表工具；`chatTools.group` 点名后可见；
    `data.write` 类工具仍然进不了群。

---

## 12. 使用示例

### 12.1 首次启用

1. 打开「插件」页，找到「课程表」→ 填配置（时区默认上海即可）→ 保存 → 启用。
   状态应显示「运行中」，「工具清单」里出现 8 个 `plugin_course_*` 工具。
2. **在私聊或自己的群里**直接说：

   > 帮我把课表记一下：周一 1-2 节高数，教三楼 301，张老师，1 到 16 周；
   > 周三 3-4 节大学物理，理科楼 205，李老师，也是 1 到 16 周。这学期 9 月 7 号开学。

3. 模型会先调 `course_preview`，把整理结果以表格回给你（此时**还没有保存**）：

   ```
   星期 | 节次  | 课程     | 地点      | 教师   | 周次
   ==== | ===== | ======== | ========= | ====== | ======
   周一 | 1-2节 | 高等数学 | 教三楼301 | 张老师 | 1-16周
   周三 | 3-4节 | 大学物理 | 理科楼205 | 李老师 | 1-16周
   ```

4. 你回「对，存吧」→ 模型调 `course_save`（只传 `draftId`）→ 保存成功。
   如果它没说全（比如没提地点），会**追问**而不是编一个地点。

### 12.2 查询

| 你说 | 模型调用 | 结果 |
| --- | --- | --- |
| 「今天有什么课？」 | `course_day`（不传日期） | 按配置时区算「今天」，给出第几周、单双周、当天课程 |
| 「周三上什么？」 | `course_day` `{date: 本周三}` | 指定日期 |
| 「这周课表」/「下周呢」 | `course_week` | 周一到周日整张表，没课的日子也列出来 |
| 「第 5 周有课吗」 | `course_day` `{date: 第5周的某天}` | 周次与单双周都会算进去 |
| 「我都有哪些课」 | `course_list` | 按学期分组，每条带 `courseId` |

### 12.3 修改与删除

> 「高数换到 305 了」 → `course_update` `{courseId, patch: {location: "教三楼 305"}}`
>
> 「物理改成周二 3-4 节」 → `course_update` `{courseId, patch: {weekday: 2}}`
> 　（若与已有课冲突，会先被拒并说明和谁冲突；你说「就这样」才加 `overwriteConflicts`）
>
> 「把体育删了」 → `course_delete` `{courseId}`
>
> 「课程表清空吧」 → `course_delete` `{all: true}`

### 12.4 数据在哪、怎么备份

```
<用户数据目录>/plugin-data/course-schedule/courses/<32位哈希>.json
```

一个「会话 + 用户」一个文件，内容里有 `owner`（会话与 QQ 号）与 `courses`。
备份 = 复制这个目录；恢复 = 拷回去（重启后生效）。
**不要手工编辑**：格式错了会被判为损坏，插件会拒绝读写并让你显式重置
（重置会把原文件改名成 `.corrupt-<时间戳>.bak`，不会直接删掉）。

### 12.5 群聊里怎么用

默认**群里看不到**这些工具（`plugins.chatTools` 三档全关）。要开放：

```json
{ "method": "setting", "params": { "key": "plugins.chatTools.group",
  "value": { "enabled": true, "tools": ["plugin_course_preview", "plugin_course_day", "plugin_course_week", "plugin_course_list"], "allowPaid": false } } }
```

放在桌面端「安全」页里点选也可以。注意：

- 只放 R0 的查询工具最省心；`course_save` / `course_update` / `course_delete`
  是 R1，放进群里意味着群友能改自己的数据（归属仍是各自的，互不影响）。
- **每人一份**：同一个群里，A 存的和 B 存的互相看不见。
- 群聊与私聊是两份独立数据 —— 想让「私聊存的课」在群里也能查，需要两边都存
  （或者只在一个地方维护）。

### 12.6 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 模型说「请先告诉我在哪个会话」 | 没有可信归属（主动回合/脚本直调）。在具体会话里再问一次 |
| 保存报「草案不存在或已过期」 | 草案 15 分钟过期，或插件重启过。重新让它预览一次 |
| 报「数据文件损坏」 | 文件被手工改过或磁盘出错。先备份 `courses/` 目录，再让模型调 `course_delete {all:true, forceCorrupt:true}` 重置 |
| 群里看不到课程表工具 | 正常。需要在 `plugins.chatTools.group` 里点名 |
| 周次算出来不对 | 检查「学期开始日期」：它会被归一到那一周的**周一**，周次是 `(日期 - 开学日)/7 + 1` |
