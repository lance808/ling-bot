/**
 * 旧配置迁移 —— 把 `config.dsh` 搬到 `plugins.config['dsh-bridge']`
 *
 * ## 为什么要这一步
 *
 * 骨架改造后，DSH 接入不再是主程序里写死的一段逻辑，而是 `dsh-bridge`
 * 这个普通插件。它的配置自然应该在插件的配置区里（`plugins.config`），
 * 启用状态在 `plugins.enabled`。
 *
 * 但老用户的 `config.json` 里还是老的 `dsh: { enabled, port, token, admins, sessionId }`。
 * 直接不认这段配置，用户的 DSH 会在升级后**静默失效** ——
 * 端口不开了、指令没人应，而界面上一切"正常"。这是最糟的一种升级体验。
 *
 * ## 迁移规则
 *
 * | 旧字段 | 新位置 |
 * | --- | --- |
 * | `dsh.enabled` | `plugins.enabled` 里是否含 `dsh-bridge` |
 * | `dsh.port` | `plugins.config['dsh-bridge'].port` |
 * | `dsh.admins` | `plugins.config['dsh-bridge'].admins`（逗号分隔字符串） |
 * | `dsh.sessionId` | `plugins.config['dsh-bridge'].sessionId` |
 * | `dsh.token` | 插件凭据保险箱（敏感，**不进明文配置**） |
 *
 * ## 为什么令牌要单独处理
 *
 * 旧位置 `config.dsh.token` 是**明文**。迁移正是把它搬到加密存储的好机会 ——
 * 如果只是原样搬进 `plugins.config`，等于把明文问题带进了新结构。
 *
 * ## 幂等
 *
 * 迁移只做一次：成功后把 `dsh` 块清空（保留空对象以满足 schema 的未知键校验）。
 * 重复运行没有副作用。
 */

import { sealSecret, isVaultAvailable } from '../config/vault.mjs';
import { readJson, writeJsonAtomic } from '../config/atomic.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 内置 DSH 插件的 id（与 plugins/dsh-bridge/plugin.json 一致） */
export const DSH_PLUGIN_ID = 'dsh-bridge';

/**
 * 判断是否还有需要迁移的旧 DSH 配置。
 *
 * @param {any} config
 * @returns {boolean}
 */
export function hasLegacyDsh(config) {
  const d = config?.dsh;
  if (!d || typeof d !== 'object') return false;
  // 任一实质字段非空就认为需要迁移
  if (d.enabled === true) return true;
  if (typeof d.token === 'string' && d.token !== '') return true;
  if (Array.isArray(d.admins) && d.admins.length > 0) return true;
  if (typeof d.sessionId === 'string' && d.sessionId !== '') return true;
  // 端口从默认值改过也算（用户动过这项就说明在用）
  if (Number.isInteger(d.port) && d.port !== 3458) return true;
  return false;
}

/**
 * 执行迁移。
 *
 * @param {object} opts
 * @param {any} opts.config 当前完整配置（会被就地修改）
 * @param {string} opts.secretsPath 插件凭据保险箱路径
 * @param {(msg: string, meta?: object) => void} [opts.log]
 * @returns {Promise<{migrated: boolean, message: string, config: any}>}
 */
export async function migrateLegacyDsh(opts) {
  const log = opts.log ?? (() => {});
  const config = opts.config;

  if (!hasLegacyDsh(config)) {
    return { migrated: false, message: '', config };
  }

  const d = config.dsh ?? {};
  const next = {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: Array.isArray(config.plugins?.enabled) ? [...config.plugins.enabled] : [],
      config: { ...(config.plugins?.config ?? {}) },
    },
  };

  // 旧配置里"启用了 DSH" → 新结构里"启用 dsh-bridge 插件"
  if (d.enabled === true && !next.plugins.enabled.includes(DSH_PLUGIN_ID)) {
    next.plugins.enabled.push(DSH_PLUGIN_ID);
  }

  /** @type {Record<string, any>} */
  const pluginCfg = { ...(next.plugins.config[DSH_PLUGIN_ID] ?? {}) };

  if (Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535) {
    pluginCfg.port = d.port;
  }
  if (Array.isArray(d.admins) && d.admins.length > 0) {
    // 插件清单里 admins 是 text 类型（逗号分隔）：数组在表单里没法自然表达，
    // 而管理员列表本质上就是"一串号"，用逗号分隔最直观。
    pluginCfg.admins = d.admins.map((x) => String(x).trim()).filter(Boolean).join(',');
  }
  if (typeof d.sessionId === 'string' && d.sessionId.trim() !== '') {
    pluginCfg.sessionId = d.sessionId.trim();
  }

  next.plugins.config[DSH_PLUGIN_ID] = pluginCfg;

  // ---- 令牌进保险箱 ----
  let tokenNote = '';
  const token = typeof d.token === 'string' ? d.token.trim() : '';
  if (token !== '') {
    try {
      const vaultOk = await isVaultAvailable();
      if (!vaultOk) {
        // 加密存储不可用：**不把明文搬进新结构**，而是明确告诉用户要重填。
        // 悄悄搬过去会把"令牌是加密存的"这个承诺破坏掉。
        tokenNote = '；DSH 令牌未迁移（本机无法使用加密存储），请在插件页重新填写';
        log('插件配置迁移：DSH 令牌未迁移，需重新填写', { level: 'warn' });
      } else {
        const all = (await readJson(opts.secretsPath)) ?? {};
        const bag = { ...(all[DSH_PLUGIN_ID] ?? {}) };
        bag.token = await sealSecret(token);
        all[DSH_PLUGIN_ID] = bag;
        await fs.mkdir(path.dirname(opts.secretsPath), { recursive: true });
        await writeJsonAtomic(opts.secretsPath, all);
        tokenNote = '；DSH 令牌已迁移到加密存储';
      }
    } catch (err) {
      tokenNote = '；DSH 令牌迁移失败，请在插件页重新填写';
      log(`插件配置迁移：令牌写入失败 ${String(/** @type {any} */ (err)?.message ?? err)}`, { level: 'warn' });
    }
  }

  /*
   * 清空旧块。
   *
   * **保留空对象而不是删除**：schema 的未知键校验是按"默认值里有没有这个键"
   * 判断的，删掉键会让下一次启动因为"未知配置项 dsh"而直接起不来。
   */
  next.dsh = { enabled: false, port: 3458, token: '', admins: [], sessionId: '' };

  log(`插件配置迁移完成：DSH 已迁移为插件${tokenNote}`);

  return {
    migrated: true,
    message: `DSH 接入已迁移为插件${tokenNote}`,
    config: next,
  };
}
