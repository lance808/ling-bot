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
});

/**
 * 判断某个工具是否对某来源可见。
 *
 * @param {object} tool 工具声明
 * @param {import('./origin.mjs').Origin} origin
 * @param {object} [policy]
 * @returns {boolean}
 */
export function isToolGranted(tool, origin, policy = DEFAULT_POLICY) {
  assertOrigin(origin);

  // 1) 工具自己必须声明 origins；未声明 = 谁都看不到（fail-closed）
  if (!Array.isArray(tool?.origins) || tool.origins.length === 0) return false;
  if (!tool.origins.includes(origin)) return false;

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

  return true;
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
 * @returns {object[]}
 */
export function resolveToolSet(origin, allTools, policy = DEFAULT_POLICY) {
  assertOrigin(origin);
  if (!Array.isArray(allTools)) return [];
  return allTools.filter((tool) => isToolGranted(tool, origin, policy));
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
 * @param {Record<string, {type: string, required?: boolean, description?: string, enum?: string[], maxLength?: number}>} params
 */
export function toJsonSchema(params) {
  /** @type {Record<string, any>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];

  for (const [name, spec] of Object.entries(params)) {
    /** @type {Record<string, any>} */
    const prop = { type: spec.type };
    if (spec.description) prop.description = spec.description;
    if (spec.enum) prop.enum = spec.enum;
    if (spec.maxLength) prop.maxLength = spec.maxLength;
    if (spec.type === 'array' && spec.items) prop.items = spec.items;
    properties[name] = prop;
    if (spec.required) required.push(name);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * 运行时参数校验（不信任模型给的任何值）。
 *
 * @param {Record<string, any>} params schema
 * @param {unknown} value 模型传进来的参数
 * @returns {{ok: true, value: Record<string, any>} | {ok: false, code: string, message: string}}
 */
export function validateParams(params, value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  /** @type {Record<string, any>} */
  const out = {};

  for (const [name, spec] of Object.entries(params)) {
    const raw = input[name];
    if (raw === undefined || raw === null) {
      if (spec.required) {
        return { ok: false, code: 'E4041', message: `缺少必需参数：${name}` };
      }
      continue;
    }
    if (spec.type === 'string') {
      if (typeof raw !== 'string') return { ok: false, code: 'E4041', message: `参数 ${name} 必须是字符串` };
      if (spec.maxLength && raw.length > spec.maxLength) {
        return { ok: false, code: 'E4041', message: `参数 ${name} 超长（上限 ${spec.maxLength}）` };
      }
      out[name] = raw;
    } else if (spec.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, code: 'E4041', message: `参数 ${name} 必须是数字` };
      }
      out[name] = raw;
    } else if (spec.type === 'boolean') {
      if (typeof raw !== 'boolean') return { ok: false, code: 'E4041', message: `参数 ${name} 必须是布尔值` };
      out[name] = raw;
    } else if (spec.type === 'array') {
      if (!Array.isArray(raw)) return { ok: false, code: 'E4041', message: `参数 ${name} 必须是数组` };
      if (spec.maxItems && raw.length > spec.maxItems) {
        return { ok: false, code: 'E4041', message: `参数 ${name} 元素过多（上限 ${spec.maxItems}）` };
      }
      out[name] = raw;
    } else {
      return { ok: false, code: 'E4041', message: `参数 ${name} 的类型不受支持` };
    }
  }

  return { ok: true, value: out };
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
