/**
 * 管理员身份 —— 「谁是管理员」只在**这一处**回答
 *
 * ## 为什么必须从白名单里拆出来
 *
 * 修这个问题之前，`resolveOrigin()` 判断 `owner-private` 用的是
 * `config.allow.private`。这等于把两件不同的事合成了一件：
 *
 *   | 清单 | 回答的问题 | 用在哪 |
 *   | --- | --- | --- |
 *   | `allow.private` | **谁能跟它说话**（L1 准入） | `checkWhitelist` |
 *   | 管理员 | **谁能让它动本机**（L2 授权） | `owner-private` / 确认请求 |
 *
 * 合并之后的后果是具体的：为了让机器人能回某人的私聊，把他加进白名单
 * （那本来只是"允许他发消息"），他就**同时**获得了宿主机工具与
 * 高风险操作的确认权 —— 而用户完全不知道加白名单还顺带授了权。
 *
 * 所以核心管理员单独一份 `config.admin.qqIds`，**默认空**。
 * 空 = 没有管理员 = 没人能拿到宿主机工具，这是 fail-closed 的正确方向。
 *
 * ## 为什么还要 `inheritWhitelist`
 *
 * 老用户的白名单里可能确实填的是自己的号，升级后如果一声不响地
 * 全部失去权限，表现是"以前能读文件现在报没权限"，而且用户不知道
 * 该去哪补 —— 那是一种很糟的升级体验。
 *
 * 但它**不能默认打开**：默认打开就等于没改。所以它是一个显式开关，
 * 由用户自己勾（界面上写明风险），并且每次启动都会在日志里留一行。
 *
 * ## 投递豁免为什么是并集
 *
 * 发送闸门的 `admins` 只回答"这条消息要不要绕过限流 / 白名单送到他私聊"，
 * 是**投递通道**，不是授权。所以它是核心管理员 + DSH 插件管理员的并集：
 * 既有的 DSH 审批推送不会因为这次拆分而送不出去，而"谁能批准宿主机操作"
 * 仍然只看 `coreAdminIds()`。两件事分开，才不会改一个坏另一个。
 */

/** QQ 号形状：真实号 5–11 位，留一点余量，但不接受空串与说明文字 */
export const ADMIN_QQ_RE = /^\d{4,15}$/;

/**
 * 把一个"可能是数组也可能是逗号分隔字符串"的值收成干净的号码数组。
 *
 * 插件清单里 admins 是 text（逗号分隔字符串），核心配置里是数组，
 * 两处形状不同。统一在这里收口，避免每个调用方各写一遍 split 然后
 * 某一处忘了 trim —— 那会让闸门里的字符串比较永远不成立（静默失效）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeAdminIds(raw) {
  /** @type {unknown[]} */
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，、\s]+/)
      : [];

  /** @type {string[]} */
  const out = [];
  for (const v of list) {
    const id = String(v ?? '').trim();
    if (!ADMIN_QQ_RE.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 核心管理员：唯一决定「谁拥有管理员权限」的清单。
 *
 * `inheritWhitelist` 打开时把白名单私聊并进来 —— 这是**用户显式选择的**
 * 兼容行为，不是默认。默认 false，所以白名单不再自动等于管理员。
 *
 * @param {any} cfg 完整配置对象
 * @returns {string[]}
 */
export function coreAdminIds(cfg) {
  const out = normalizeAdminIds(cfg?.admin?.qqIds);
  if (cfg?.admin?.inheritWhitelist === true) {
    for (const id of normalizeAdminIds(cfg?.allow?.private)) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * 某个 QQ 号是不是核心管理员。
 *
 * @param {any} cfg
 * @param {unknown} qq
 * @returns {boolean}
 */
export function isCoreAdmin(cfg, qq) {
  const id = String(qq ?? '').trim();
  if (!id) return false;
  return coreAdminIds(cfg).includes(id);
}

/**
 * 投递豁免用的管理员并集。
 *
 * 只用于发送闸门（白名单豁免 + 限流豁免），**不参与授权判定**。
 * 引用的来源都是有意的：
 *   1. 核心管理员 —— 确认卡要能送到；
 *   2. DSH 插件配置里的 admins —— 既有审批推送到他们；
 *   3. 生图插件配置里的 admins —— 收费前置审批卡也要送到；
 *   4. 旧 `config.dsh.admins` —— 迁移没跑到时的兜底（冷启动第一轮）。
 *
 * 生图管理员可能不在私聊白名单里；审批卡送不到时任务会安全失败，
 * 但用户会看到“审批卡发送失败”。把这里补全只放宽**投递**，不改变
 * 谁有权批准、也不把插件管理员变成宿主机管理员。
 *
 * @param {any} cfg
 * @returns {string[]}
 */
export function deliverableAdminIds(cfg) {
  const out = coreAdminIds(cfg);

  /** @param {unknown} raw */
  const merge = (raw) => {
    for (const id of normalizeAdminIds(raw)) {
      if (!out.includes(id)) out.push(id);
    }
  };

  merge(cfg?.plugins?.config?.['dsh-bridge']?.admins);
  merge(cfg?.plugins?.config?.['image-generation']?.admins);
  merge(cfg?.dsh?.admins);
  return out;
}
