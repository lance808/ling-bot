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
 * @property {string[]} pages
 * @property {string[]} timers
 */

/**
 * 生成注册表快照（给界面「安全」页与诊断用）。
 *
 * @returns {RegistrySnapshot}
 */
export function snapshotRegistry() {
  return {
    actions: listActions(),
    tools: listTools(),
    pages: ['overview', 'sessions', 'persona', 'security', 'logs'],
    timers: [],
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
