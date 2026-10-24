/**
 * 工具授权闸门 —— F14.1 / F14.2 / 不变量 I13、I14
 *
 * ## 这个文件为什么存在，以及为什么它必须这么"笨"
 *
 * 引入了工具之后，最坏结果从「说错话」变成「做错事」，而后者不可逆。
 * 出站审计拦不住 `rm -rf D:/work`——那条命令的正文里没有任何可疑字符串。
 * 所以防线必须前移到"这个回合能调用什么"，而这个判断**只能**依赖结构性事实。
 *
 * ## 硬性纪律（I14）
 *
 * 本文件是**纯函数**，入参只有 `origin` 与配置。它：
 *   - 不 import 任何消息 / 会话 / 人格卡 / LLM 模块
 *   - 不读文件、不读网络
 *   - 不接受调用方传进来的"理由"或"上下文"
 *
 * 换句话说：**模型被说服了，也改变不了这里返回什么。**
 * 想加权限只有一条路——管理员改配置，或管理员自己去私聊（改 origin）。
 */

import { ORIGIN, assertOrigin } from './origin.mjs';
import { chatGrantAllows, resolveChatGrant } from './chat-grant.mjs';

/** 风险档：R0 只读无害 / R1 只读敏感 / R2 写入或执行 / R3 不可逆 */
export const RISK = Object.freeze({
  R0: 'R0',
  R1: 'R1',
  R2: 'R2',
  R3: 'R3',
});

const RISK_ORDER = [RISK.R0, RISK.R1, RISK.R2, RISK.R3];

/**
 * 默认策略：**写成数据，不写成散落的 if**。
 * 新增工具只需在工具声明里写 `origins`；这里不需要改。
 */
export const DEFAULT_POLICY = Object.freeze({
  /** 群聊来源永远拿不到宿主机工具（I13） */
  groupHostToolsForbidden: true,
  /** 主动唤醒回合不给宿主机工具（它没有具体任务，给工具等于给风险） */
  proactiveHostToolsForbidden: true,
  /** R3 默认不向任何来源开放，除非配置显式打开 */
  allowR3Default: false,
  /**
   * 聊天来源的工具授权（见 plugins/chat-tools.mjs 的归一化形状）。
   *
   * 缺省 `null` = 聊天来源拿不到任何**插件**工具，行为与改造前等价
   * （那时插件工具在群里其实是由 origins 直接放行的；现在默认收紧，
   * 需要管理员显式点名 —— 这是这次改造的意图，不是回归）。
   */
  chatTools: null,
  /**
   * 本轮**结构性地**不可见的工具（完整工具名，如 `plugin_sticker_send`）。
   *
   * ## 为什么这个输入是合法的（没有破 I14）
   *
   * I14 禁的是"让对话内容影响授权"—— 也就是不要把 messages / persona 文本
   * 递给判定层，否则群里有人发一句"忽略之前的指令"就能改权限。
   *
   * 这里传的是**管理员侧的事实**：例如"这个人格卡明确写了不用表情包"。
   * 它和 `admin.qqIds`、`plugins.chatTools` 是同一类东西 —— 由用户/管理员
   * 设定，不来自聊天内容。判定层依然只做 `includes` 这种纯比较。
   *
   * ## 为什么需要它，而不是只在提示词里写"别用"
   *
   * 提示词是软约束。人格写着"不用表情包"、工具却摆在模型手边时，它有一定
   * 概率还是会调 —— 而那种调用**看起来完全合理**（备注写着"笑哭"、语境
   * 也合适），用户只会觉得"我不是说了别用吗"。把工具拿掉才是确定的。
   *
   * @type {ReadonlyArray<string> | null}
   */
  disabledTools: null,
});

/**
 * 判断某个工具是否对某来源可见。
 *
 * `convKey` 只在**聊天来源的插件工具授权**这一步用到，而且只取它的形状
 * （`group:` / `private:` 前缀）。它是结构性事实，不是对话内容 ——
 * 这点必须在签名处就写明，否则下一个改动者会顺手把 messages 传进来（I14）。
 *
 * @param {object} tool 工具声明
 * @param {import('./origin.mjs').Origin} origin
 * @param {object} [policy]
 * @param {{convKey?: string}} [where] 仅用于区分群聊/私聊授权档
 * @returns {boolean}
 */
export function isToolGranted(tool, origin, policy = DEFAULT_POLICY, where = {}) {
  assertOrigin(origin);

  // 1) 工具自己必须声明 origins；未声明 = 谁都看不到（fail-closed）
  if (!Array.isArray(tool?.origins) || tool.origins.length === 0) return false;
  if (!tool.origins.includes(origin)) return false;

  // 1.5) 本轮被结构性禁用（管理员侧设定，与对话内容无关，见 disabledTools）
  if (isToolDisabled(tool, policy)) return false;

  // 2) 风险档必须合法；非法档一律拒绝
  if (!RISK_ORDER.includes(tool?.risk)) return false;

  // 3) R3 默认关闭，必须由配置显式开启
  if (tool.risk === RISK.R3 && !policy.allowR3Default) return false;

  // 4) 宿主机工具与 QQ 工具的隔离：
  //    群聊/主动唤醒来源，永远不出现 host 类工具
  if (tool.kind === 'host') {
    if (policy.groupHostToolsForbidden && origin === ORIGIN.GROUP) return false;
    if (policy.proactiveHostToolsForbidden && origin === ORIGIN.PROACTIVE) return false;
  }

  // 5) 插件工具在聊天来源下还要过管理员授权（点名的工具才出现）
  const gate = pluginChatAccess(tool, origin, policy, where);
  if (!gate.allowed) return false;

  return true;
}

/**
 * 这个工具在**本轮**是否被结构性禁用。
 *
 * 输入是完整工具名（`plugin_sticker_send`）的列表，判定就是一次 `includes`。
 * 不做前缀/通配匹配 —— 那会让"禁用表情工具"变成"禁用所有 plugin_ 开头的工具"，
 * 而后者是一个谁都不想要、也很难在日志里看出来的效果。
 *
 * @param {object} tool
 * @param {object} policy
 * @returns {boolean}
 */
export function isToolDisabled(tool, policy = DEFAULT_POLICY) {
  const list = policy?.disabledTools;
  if (!Array.isArray(list) || list.length === 0) return false;
  const name = String(tool?.name ?? '');
  if (!name) return false;
  return list.includes(name);
}

/**
 * 插件工具在某个来源下的授权判定。
 *
 * 非插件工具一律 `allowed: true`（内置工具的可见性完全由 origins/risk 决定，
 * 这次改造不动它们）。
 *
 * @param {object} tool
 * @param {import('./origin.mjs').Origin} origin
 * @param {object} policy
 * @param {{convKey?: string}} where
 * @returns {{allowed: boolean, granted: boolean, channel: string, reason?: string}}
 */
export function pluginChatAccess(tool, origin, policy = DEFAULT_POLICY, where = {}) {
  if (!tool?.plugin) {
    return { allowed: true, granted: false, channel: '' };
  }

  const grant = resolveChatGrant({ chatTools: policy?.chatTools, origin, convKey: where?.convKey });
  if (!grant) {
    /*
     * 这个来源不受 chatTools 约束（管理员私聊 / 桌面端 / 管理员所在群的
     * owner-group）。它们的插件工具可见性与改造前一致。
     *
     * 注意 owner-group **不**受约束：管理员在群里发言时，工具能用到
     * 他自己也需要的那一套。群里其他人是 `group` 来源，走下面那条路。
     */
    const channel = (() => {
      if (origin === ORIGIN.PROACTIVE) return 'proactive';
      if (origin === ORIGIN.GROUP) return String(where?.convKey ?? '').startsWith('group:') ? 'group' : 'private';
      return '';
    })();
    if (!channel) return { allowed: true, granted: false, channel: '' };
    // 受约束但未启用 → 不出现
    return { allowed: false, granted: false, channel, reason: 'chat-not-enabled' };
  }

  const one = chatGrantAllows(tool, grant);
  if (!one.ok) return { allowed: false, granted: false, channel: grant.channel, reason: one.reason };
  return { allowed: true, granted: true, channel: grant.channel };
}

/**
 * 解析某来源可用的工具集合。
 *
 * **这是本项目的安全核心**：它只接收 origin + 工具清单 + 配置。
 * 任何时候都不要给它加"context"、"messages"、"persona" 之类的参数（I14）。
 *
 * @param {import('./origin.mjs').Origin} origin
 * @param {ReadonlyArray<object>} allTools
 * @param {object} [policy]
 * @param {{convKey?: string}} [where]
 * @returns {object[]}
 */
export function resolveToolSet(origin, allTools, policy = DEFAULT_POLICY, where = {}) {
  assertOrigin(origin);
  if (!Array.isArray(allTools)) return [];
  return allTools.filter((tool) => isToolGranted(tool, origin, policy, where));
}

/**
 * 把工具集合转成 OpenAI 兼容的 `tools` 数组（下发模型用）。
 *
 * @param {ReadonlyArray<object>} tools
 * @returns {object[]}
 */
export function toOpenAiTools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.params ?? {}),
    },
  }));
}

/**
 * 极简参数 schema → JSON Schema。
 * 不引第三方校验库：参数类型就这几种，手写足够，且少一个会被主版本拖拽的依赖。
 *
 * ## 递归部分（object / 对象数组）
 *
 * 参数声明里出现 `object` 时，输出标准的 `{type:"object", properties, required,
 * additionalProperties:false}`；`array` 的 `items` 是 object 时同样递归。
 * 旧参数（string/number/boolean/array-of-scalar）的输出**逐字段不变**：
 * 没有 object 时这条路径产出的字节与改造前完全一致。
 *
 * `additionalProperties: false` 是给模型看的**提示**，不是执行层的约束
 * （执行层由 `validateParams` 做白名单过滤，多余键静默丢弃）。
 * 两者都保留：模型看得见"别塞多余字段"，宿主也不依赖模型守规矩。
 *
 * @param {Record<string, {type: string, required?: boolean|string[], description?: string, enum?: string[], maxLength?: number}>} params
 */
export function toJsonSchema(params) {
  return objectSchemaOf(params);
}

/**
 * 一组「名字 → 参数声明」→ JSON Schema 的 object 形状。
 *
 * @param {Record<string, any>} params
 * @returns {Record<string, any>}
 */
function objectSchemaOf(params) {
  /** @type {Record<string, any>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];

  for (const [name, spec] of Object.entries(params)) {
    properties[name] = propertySchemaOf(spec);
    // 注意：object 参数的 `required` 可能是字符串数组（指子属性），
    // 只有布尔 true 才表示"这个参数本身必填"。
    if (spec.required === true) required.push(name);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * 单个参数声明 → JSON Schema 片段。
 *
 * @param {any} spec
 * @returns {Record<string, any>}
 */
function propertySchemaOf(spec) {
  /** @type {Record<string, any>} */
  const prop = { type: spec.type };
  if (spec.description) prop.description = spec.description;
  if (spec.enum) prop.enum = spec.enum;
  if (spec.maxLength) prop.maxLength = spec.maxLength;
  if (spec.type === 'array' && spec.items) {
    prop.items = spec.items.type === 'object' ? objectSchemaOf(spec.items.properties ?? {}) : spec.items;
  }
  if (spec.type === 'object') {
    const nested = objectSchemaOf(spec.properties ?? {});
    prop.properties = nested.properties;
    // 子属性的必填来自它们各自的 `required: true`（清单里 `required: ["a"]`
    // 在归一化阶段就落成了这个布尔值），所以这里直接用递归结果。
    prop.required = nested.required;
    prop.additionalProperties = false;
  }
  return prop;
}

/**
 * 运行时参数校验（不信任模型给的任何值）。
 *
 * ## object 的语义：按声明白名单过滤，多余键**丢弃且不报错**
 *
 * 这和顶层参数完全一致（顶层多余键本来就静默丢弃，见 §4.1 的说明）：
 * 模型多塞一个 `{"origin":"owner-private"}` 不会被当成错误处理、也不会
 * 透传到插件面前，它只是在过滤时消失。让多余键报错反而会带来一个新问题——
 * 模型很容易多写一个字段，整次调用就失败，用户看到的是一句"参数非法"，
 * 而真正需要的操作根本没发生。
 *
 * required 缺失、类型不符仍然是 `E4041`：那是"这次调用根本没法正确执行"，
 * 静默放过只会让插件收到半成品数据。
 *
 * ## 深度
 *
 * 递归来自 schema（清单层已经限制 ≤3 层），但这里仍然带 `depth` 参数：
 * schema 是数据，将来若从别处（比如内置工具的运行时构造）进来一份更深的，
 * 这里不能变成爆栈的入口。超限报 `E4041` 并给出字段路径。
 *
 * @param {Record<string, any>} params schema
 * @param {unknown} value 模型传进来的参数
 * @returns {{ok: true, value: Record<string, any>} | {ok: false, code: string, message: string}}
 */
export function validateParams(params, value) {
  const one = validateObjectParams(params, value, '', 0);
  if (!one.ok) return one;
  return { ok: true, value: /** @type {Record<string, any>} */ (one.value) };
}

/** object/array 递归的最深层数（与 manifest 的 MAX_PARAM_OBJECT_DEPTH 同一口径） */
const MAX_VALUE_DEPTH = 3;

/**
 * 校验一个「名字 → 参数声明」的 object。
 *
 * @param {Record<string, any>} params
 * @param {unknown} value
 * @param {string} prefix 字段路径前缀（空 = 顶层，`courses[]` 这种）
 * @param {number} depth
 * @returns {{ok: true, value: Record<string, any>} | {ok: false, code: string, message: string}}
 */
function validateObjectParams(params, value, prefix, depth) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  /** @type {Record<string, any>} */
  const out = {};

  for (const [name, spec] of Object.entries(params)) {
    const where = prefix ? `${prefix}.${name}` : name;
    const raw = input[name];
    if (raw === undefined || raw === null) {
      /*
       * 缺必填。注意 `spec.required` 只可能是 `true`（子属性的必填在清单
       * 归一化时就落成了这个布尔值），所以这里不需要再判数组。
       */
      if (spec.required === true) {
        return { ok: false, code: 'E4041', message: `缺少必需参数：${where}` };
      }
      continue;
    }
    const one = validateOneValue(spec, raw, where, depth);
    if (!one.ok) return one;
    out[name] = one.value;
  }

  return { ok: true, value: out };
}

/**
 * 校验单个值。
 *
 * @param {any} spec
 * @param {any} raw
 * @param {string} where 字段路径（报错时点名）
 * @param {number} depth 当前 object 层数
 * @returns {{ok: true, value: any} | {ok: false, code: string, message: string}}
 */
function validateOneValue(spec, raw, where, depth) {
  if (spec.type === 'string') {
    if (typeof raw !== 'string') return { ok: false, code: 'E4041', message: `参数 ${where} 必须是字符串` };
    if (spec.maxLength && raw.length > spec.maxLength) {
      return { ok: false, code: 'E4041', message: `参数 ${where} 超长（上限 ${spec.maxLength}）` };
    }
    return { ok: true, value: raw };
  }

  if (spec.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, code: 'E4041', message: `参数 ${where} 必须是数字` };
    }
    return { ok: true, value: raw };
  }

  if (spec.type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, code: 'E4041', message: `参数 ${where} 必须是布尔值` };
    return { ok: true, value: raw };
  }

  if (spec.type === 'array') {
    if (!Array.isArray(raw)) return { ok: false, code: 'E4041', message: `参数 ${where} 必须是数组` };
    if (spec.maxItems && raw.length > spec.maxItems) {
      return { ok: false, code: 'E4041', message: `参数 ${where} 元素过多（上限 ${spec.maxItems}）` };
    }
    /*
     * 只有声明了 object 元素才逐项校验。
     *
     * 标量数组保持原样透传（与改造前一致）：`items: {type:'string'}` 这类
     * 声明以前不校验元素，现在也不校验 —— 收紧旧行为会让本来能跑的工具
     * 在升级后突然拒绝调用，而那不是这次改造要的事。
     */
    if (spec.items && spec.items.type === 'object') {
      const itemDepth = depth + 1;
      if (itemDepth > MAX_VALUE_DEPTH) {
        return {
          ok: false,
          code: 'E4041',
          message: `参数 ${where} 的对象嵌套超过 ${MAX_VALUE_DEPTH} 层（字段路径：${where}）`,
        };
      }
      /** @type {any[]} */
      const arr = [];
      for (let i = 0; i < raw.length; i += 1) {
        const itemPath = `${where}[${i}]`;
        const el = raw[i];
        if (!el || typeof el !== 'object' || Array.isArray(el)) {
          return { ok: false, code: 'E4041', message: `参数 ${itemPath} 必须是对象` };
        }
        const one = validateObjectParams(spec.items.properties ?? {}, el, itemPath, itemDepth);
        if (!one.ok) return one;
        arr.push(one.value);
      }
      return { ok: true, value: arr };
    }
    return { ok: true, value: raw };
  }

  if (spec.type === 'object') {
    const nestedDepth = depth + 1;
    if (nestedDepth > MAX_VALUE_DEPTH) {
      return {
        ok: false,
        code: 'E4041',
        message: `参数 ${where} 的对象嵌套超过 ${MAX_VALUE_DEPTH} 层（字段路径：${where}）`,
      };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'E4041', message: `参数 ${where} 必须是对象` };
    }
    /* 子属性必填来自它们各自的 `required: true`（清单里 `required: [...]` 已落成它） */
    return validateObjectParams(spec.properties ?? {}, raw, where, nestedDepth);
  }

  return { ok: false, code: 'E4041', message: `参数 ${where} 的类型不受支持` };
}

/**
 * 这个工具的"这一次要不要花钱"是否由**插件自己的审批链路**负责。
 *
 * ## 为什么需要它，以及为什么它不降低风险
 *
 * 收费工具（`effects: ["paid"]`）如果既要宿主弹通用确认卡、又要插件再私信
 * 管理员审批，用户会连续看到两次确认：第一次问"是否调用工具"，第二次问
 * "是否同意这次生图"。两次确认里只要有一次被无脑点掉，真正的审批就失效了 ——
 * 而"多点一次总更安全"是错的，过度确认的结果通常是用户把整个功能关掉。
 *
 * 所以 `approval: "plugin"` 把**通用卡**让给插件更具体的审批链路。它没有
 * 降低风险档（仍按 paid 推导为 R2），也没有让工具变成"无副作用"：
 * risk / effects 照旧生效、照旧展示；只是"谁问这一句"换了人。
 *
 * 合法性（仅 in-process + trusted + paid）在清单层校验，执行器这里只读结论。
 *
 * @param {object} tool
 * @returns {boolean}
 */
export function isApprovalDelegated(tool) {
  return tool?.approval === 'plugin';
}

/**
 * 是否需要人工确认（F14.3 / I16）。
 *
 * 规则刻意保守：**不可逆操作必须有人点头**，且不提供"本会话内总是允许"。
 *
 * @param {object} tool
 * @returns {boolean}
 */
export function needsConfirm(tool) {
  if (!tool) return true;
  if (tool.confirm === 'never') return false;
  if (tool.confirm === 'always') return true;
  return tool.risk === RISK.R2 || tool.risk === RISK.R3;
}

/**
 * 本次调用是否需要人工确认 —— needsConfirm 的**按调用**版本。
 *
 * ## 为什么需要第二个函数
 *
 * `needsConfirm(tool)` 只看工具声明，这在"工具永远是同一批来源"的前提下够用。
 * 但插件工具落进聊天来源之后，同一个工具在不同来源下的确认要求是不同的：
 *
 *   · 群友触发一个已授权发消息的工具 → 管理员已经在配置里点过名，
 *     不该每句都弹卡（群里一句一问一张卡，用户会直接关掉整个功能）；
 *   · 同一个工具如果声明了 `paid`（会花钱）→ **仍然每次都要确认**，
 *     因为授权说明的是"允许它出现在这里"，不是"允许它现在花这笔钱"。
 *
 * 所以这里多接一个 `chatGranted`：只有"被授权进聊天来源 **且** 不收费"时，
 * 才把 always 降成 never。其余情况完全等价于 needsConfirm。
 *
 * 注意这个降级**不适用于 R2/R3** —— 那些工具根本进不了聊天来源
 * （见 chat-grant.mjs 的 chatGrantAllows），所以这里也不会遇到。
 *
 * @param {object} tool
 * @param {{chatGranted?: boolean}} [input]
 * @returns {boolean}
 */
export function needsConfirmFor(tool, input = {}) {
  if (!input?.chatGranted) return needsConfirm(tool);
  const effects = Array.isArray(tool?.effects) ? tool.effects : [];
  // 收费操作永远确认：授权≠替管理员花钱
  if (effects.includes('paid')) return true;
  return false;
}
