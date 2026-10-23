/**
 * 扩展点总登记 —— F13 / F14
 *
 * 统一登记「动作 / 工具 / 页面 / 配置段 / 定时任务」五类扩展点，
 * 并在启动时打印一份清单：让人一眼看到这个机器人现在能做什么，
 * 而不是去翻代码（参考项目 11082 行单文件的反面教材）。
 */

import { listActions } from './onebot/actions/index.mjs';
import { listTools, describeTools } from './tools/registry.mjs';
import { registerSendTextAction } from './onebot/actions/send-text.mjs';

/**
 * 注册首版全部动作。
 * 新增能力 = 这里多加一行 import + 一次 register 调用。
 */
export function registerAllActions() {
  registerSendTextAction();
}

/**
 * @typedef {object} RegistrySnapshot
 * @property {object[]} actions
 * @property {object[]} tools
 */

/**
 * 生成注册表快照（给界面「工具调用」页与诊断用）。
 *
 * ## 为什么删掉了 `pages` 和 `timers`
 *
 * 这两个字段从来没有被真正使用过：
 *
 *   · `pages` 是硬编码的 `['overview','sessions','persona','security','logs']`，
 *     是**旧版页面列表**，和实际侧栏（13 页，由 `ui/src/app.mjs` 的 PAGES 决定）
 *     完全不符。界面也没读它 —— 谁读谁就会得到一份过时且错误的清单。
 *   · `timers` 恒为 `[]`，全仓没有任何代码往里加东西。
 *
 * 它们看起来像"插件可以注册页面/定时器"的机制，但那套机制从没实现。
 * 留着比删掉更危险：后来的人会以为这里有扩展点，往一个死数组里写数据，
 * 然后困惑于"为什么没生效"。
 *
 * 真正的事实来源是：
 *   页面 → `ui/src/app.mjs` 的 PAGES（前端自己知道有哪些页）
 *   工具 → `src/tools/registry.mjs` 的 listTools()
 *   动作 → `src/onebot/actions/`
 *
 * @returns {RegistrySnapshot}
 */
export function snapshotRegistry() {
  return {
    actions: listActions(),
    tools: listTools(),
  };
}

/**
 * 启动时打印的工具面清单。
 *
 * @returns {string}
 */
export function renderRegistryBanner() {
  const acts = listActions();
  return [
    `动作：${acts.map((a) => a.name).join(', ') || '（无）'}`,
    '工具：',
    describeTools(),
  ].join('\n');
}
