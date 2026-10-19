/**
 * 工具执行器 —— F14
 *
 * 一次工具调用的完整生命周期：
 *   1. 查注册表（不存在 → E4032）
 *   2. 授权（origin + 声明 → isToolGranted；拒绝 → E4032）
 *   3. 参数校验（不信任模型给的任何值 → E4041）
 *   4. 需要确认的挂起等人工点头（超时按拒绝 → E4034）
 *   5. 执行（捕获异常，绝不让一个工具炸掉整个回合）
 *   6. 记录调用流水（成功与拒绝都记）
 *
 * 注意：本文件**不是**授权判定的地方，判定在 guard/tool-gate.mjs（纯函数）。
 * 这里只做编排，避免把安全逻辑摊在流程里。
 */

import { listTools, getTool } from './registry.mjs';
import { resolveToolSet, validateParams, needsConfirm, RISK } from '../guard/tool-gate.mjs';
import { assertOrigin } from '../guard/origin.mjs';

/**
 * @typedef {object} ToolRunContext
 * @property {import('../guard/origin.mjs').Origin} origin
 * @property {string} convKey
 * @property {(rec: object) => void} [onRecord] 调用流水回调
 * @property {(req: {tool: string, risk: string, args: object, convKey: string}) => Promise<'allow'|'deny'>} [askConfirm]
 */

/**
 * @param {object} opts
 * @param {ReadonlyArray<object>} [opts.tools]
 * @param {object} [opts.policy]
 * @param {ToolRunContext} opts.context
 */
export function createToolRunner(opts) {
  const tools = opts.tools ?? listTools();
  const policy = opts.policy;
  const ctx = opts.context;

  /**
   * 当前来源可见的工具（下发给模型的那份）。
   * 群聊来源在这里就已经是空集了——不是执行时才拒，是模型看不到。
   */
  function availableTools() {
    return resolveToolSet(ctx.origin, tools, policy);
  }

  /**
   * @param {string} name
   * @param {unknown} rawArgs
   * @returns {Promise<{ok: true, result: any} | {ok: false, code: string, message: string}>}
   */
  async function run(name, rawArgs) {
    const tool = getTool(name) ?? tools.find((t) => t.name === name);

    // 1) 不存在
    if (!tool) {
      record({ tool: name, denied: true, reason: 'unknown-tool', code: 'E4032' });
      return { ok: false, code: 'E4032', message: `工具不存在：${name}` };
    }

    // 2) 授权（唯一依据是 origin，不看对话内容）
    const granted = resolveToolSet(ctx.origin, [tool], policy).length > 0;
    if (!granted) {
      record({ tool: name, denied: true, reason: 'not-granted', code: 'E4032' });
      return { ok: false, code: 'E4032', message: `当前来源（${ctx.origin}）没有 ${name} 权限` };
    }

    // 3) 参数
    const parsed = validateParams(tool.params ?? {}, rawArgs);
    if (!parsed.ok) {
      record({ tool: name, denied: true, reason: 'bad-params', code: parsed.code });
      return { ok: false, code: parsed.code, message: parsed.message };
    }

    // 4) 人工确认
    if (needsConfirm(tool)) {
      const verdict = ctx.askConfirm
        ? await ctx.askConfirm({ tool: name, risk: tool.risk, args: parsed.value, convKey: ctx.convKey })
        : 'deny';
      if (verdict !== 'allow') {
        record({ tool: name, denied: true, reason: 'not-confirmed', code: 'E4034', risk: tool.risk });
        return { ok: false, code: 'E4034', message: '操作未获批准，已取消' };
      }
    }

    // 5) 执行
    const startedAt = Date.now();
    try {
      const result = await tool.run({ args: parsed.value, origin: ctx.origin, convKey: ctx.convKey });
      record({
        tool: name,
        denied: false,
        risk: tool.risk,
        ms: Date.now() - startedAt,
        argsDigest: digest(parsed.value),
      });
      return { ok: true, result };
    } catch (err) {
      const e = /** @type {any} */ (err);
      record({
        tool: name,
        denied: false,
        failed: true,
        code: e?.code ?? 'E50XX',
        ms: Date.now() - startedAt,
        argsDigest: digest(parsed.value),
      });
      return { ok: false, code: e?.code ?? 'E50XX', message: String(e?.message ?? e) };
    }
  }

  /** @param {object} rec */
  function record(rec) {
    ctx.onRecord?.({ at: Date.now(), convKey: ctx.convKey, origin: ctx.origin, ...rec });
  }

  return { availableTools, run, tools };
}

/**
 * 参数摘要：日志里不落完整参数（可能含长文本或路径）。
 *
 * @param {Record<string, any>} args
 */
function digest(args) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = v.length > 60 ? `${v.slice(0, 60)}…(${v.length})` : v;
    else out[k] = v;
  }
  return out;
}

/** 供提示层描述可用工具（不暴露 R3 细节给模型） */
export function describeForModel(tools) {
  return tools.map((t) => `- ${t.name}（${t.risk}）：${t.description}`).join('\n');
}

export { RISK, assertOrigin };
