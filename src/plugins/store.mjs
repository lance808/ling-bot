/**
 * 插件配置存储 —— 值的校验、归一、持久化
 *
 * ## 分三层，各有各的归属
 *
 * | 层 | 存哪 | 谁能改 |
 * | --- | --- | --- |
 * | 声明（有哪些字段、什么类型） | `plugin.json`（插件作者写） | 插件 |
 * | 普通值 | `config.json` → `plugins.config.<id>` | 只有宿主 |
 * | 敏感值 | `plugin-secrets.vault`（DPAPI 加密） | 只有宿主 |
 *
 * **插件不许自己写配置**。它只能通过 `ctx.config` / `ctx.secrets` 读宿主交给它的值。
 * 否则"谁写谁对"就说不清了 —— 插件绕过界面把配置改掉，
 * 用户看到的是表单里没变、实际行为变了。
 *
 * ## 为什么保存时要"按声明重新归一"
 *
 * 表单提交的是字符串（HTML 输入框天然如此），而插件要的是 number / boolean。
 * 转换放在**这里**而不是插件里：让每个插件各写一遍 parseInt，
 * 一定会有人忘了处理 `''`（空输入框）和 `'false'`（真值字符串）。
 *
 * 同时这里也是**丢弃未声明键**的地方：插件删掉一个配置项后，
 * 旧值不该继续留在 config.json 里（它会出现在用户眼前，却已经没有任何作用）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { readJson, writeJsonAtomic } from '../config/atomic.mjs';
import { openSecret, sealSecret, isVaultAvailable } from '../config/vault.mjs';

/**
 * @typedef {object} PluginConfigView
 * @property {Record<string, any>} config 已归一的普通值（含默认值）
 * @property {Record<string, string>} secrets 解密后的敏感值（仅宿主与插件进程可见）
 * @property {string[]} missing 缺失的必填项 key
 * @property {{key: string, message: string}[]} invalid 不合法的项
 * @property {boolean} ok 是否可用于初始化
 */

/**
 * 把一个原始值按声明归一。
 *
 * @param {object} spec 声明（来自 manifest.mjs 的 normalizeConfigDecl）
 * @param {unknown} raw 用户提交或磁盘上读到的值
 * @returns {{ok: true, value: any} | {ok: false, message: string}}
 */
export function coerceValue(spec, raw) {
  const type = spec.type;

  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    // 表单里的 checkbox 会以字符串形式回来，这里统一收口
    if (raw === 'true' || raw === 1 || raw === '1' || raw === 'on') return { ok: true, value: true };
    if (raw === 'false' || raw === 0 || raw === '0' || raw === '' || raw === 'off' || raw === undefined) {
      return { ok: true, value: spec.default === true };
    }
    return { ok: false, message: `${spec.label} 必须是布尔值` };
  }

  if (type === 'number') {
    // 空字符串 = 没填。有默认值就用默认值，没有就报"必填"
    if (raw === '' || raw === undefined || raw === null) {
      if (spec.required) return { ok: false, message: `${spec.label} 是必填项` };
      return { ok: true, value: spec.default };
    }
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return { ok: false, message: `${spec.label} 必须是数字` };
    if (spec.integer === true && !Number.isInteger(n)) {
      return { ok: false, message: `${spec.label} 必须是整数` };
    }
    if (spec.min !== undefined && n < spec.min) {
      return { ok: false, message: `${spec.label} 不能小于 ${spec.min}` };
    }
    if (spec.max !== undefined && n > spec.max) {
      return { ok: false, message: `${spec.label} 不能大于 ${spec.max}` };
    }
    return { ok: true, value: n };
  }

  if (type === 'enum') {
    const values = (spec.options ?? []).map((o) => o.value);
    if (raw === '' || raw === undefined || raw === null) {
      if (spec.required && values.length > 0) return { ok: false, message: `${spec.label} 是必填项` };
      return { ok: true, value: spec.default };
    }
    const s = String(raw);
    if (!values.includes(s)) return { ok: false, message: `${spec.label} 只能是 ${values.join(' / ')}` };
    return { ok: true, value: s };
  }

  // text / textarea / password
  if (raw === undefined || raw === null) {
    if (spec.required) return { ok: false, message: `${spec.label} 是必填项` };
    return { ok: true, value: spec.default ?? '' };
  }
  const s = typeof raw === 'string' ? raw : String(raw);
  const trimmed = spec.type === 'textarea' ? s : s.trim();

  // 空字符串 = 没填。必填项报错；否则用默认值（而不是空串）
  if (trimmed === '') {
    if (spec.required) return { ok: false, message: `${spec.label} 是必填项` };
    return { ok: true, value: spec.default ?? '' };
  }
  if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
    return { ok: false, message: `${spec.label} 最多 ${spec.maxLength} 个字符` };
  }
  if (spec.pattern !== undefined) {
    let re;
    try {
      re = new RegExp(`^(?:${spec.pattern})$`);
    } catch {
      // 声明期已经校验过；真到这里说明声明被绕过，当作不校验更安全（不阻塞保存）
      re = null;
    }
    if (re && !re.test(trimmed)) {
      return { ok: false, message: `${spec.label} 格式不正确` };
    }
  }
  return { ok: true, value: trimmed };
}

/**
 * 把声明 + 已存的值 + 密钥状态组装成可用的配置视图。
 *
 * @param {object[]} decls 配置项声明
 * @param {Record<string, any>} stored 已存的普通值
 * @param {Record<string, string>} secrets 已解密的敏感值
 * @returns {PluginConfigView}
 */
export function resolveConfig(decls, stored, secrets) {
  /** @type {Record<string, any>} */
  const config = {};
  /** @type {string[]} */
  const missing = [];
  /** @type {{key: string, message: string}[]} */
  const invalid = [];
  /** @type {Record<string, string>} */
  const secretValues = {};

  for (const spec of decls) {
    if (spec.secret) {
      const v = secrets?.[spec.key];
      if (typeof v === 'string' && v !== '') {
        secretValues[spec.key] = v;
        // 敏感值不回填进 config：插件通过 ctx.secrets 取，
        // 这样日志/快照里都不可能意外带出明文
        config[spec.key] = '';
      } else {
        config[spec.key] = '';
        if (spec.required) missing.push(spec.key);
      }
      continue;
    }

    const raw = stored?.[spec.key];
    const r = coerceValue(spec, raw);
    if (r.ok) {
      config[spec.key] = r.value;
      // number/boolean/enum 有默认值，缺失不算"没配"；文本类必填才可能缺失
      if (spec.required && (r.value === '' || r.value === undefined || r.value === null)) {
        missing.push(spec.key);
      }
    } else {
      invalid.push({ key: spec.key, message: r.message });
      // 保留原值，让界面能显示"填错了什么"而不是一片空白
      config[spec.key] = raw ?? spec.default ?? '';
      if (spec.required) missing.push(spec.key);
    }
  }

  return {
    config,
    secrets: secretValues,
    missing,
    invalid,
    ok: missing.length === 0 && invalid.length === 0,
  };
}

/**
 * 插件配置存储。
 *
 * 刻意做成"每次操作都读一次磁盘上的真值"的对象而不是长期缓存：
 * 配置只在用户点保存 / 启动时读写，量极小；而缓存会带来
 * "界面上保存了、插件用的是旧值"这类最难查的问题。
 */
export class PluginConfigStore {
  /**
   * @param {object} opts
   * @param {string} opts.secretsPath 插件凭据保险箱路径
   * @param {() => Record<string, Record<string, any>>} opts.readConfigMap 读当前 plugins.config
   * @param {(next: Record<string, Record<string, any>>) => Promise<void>} opts.writeConfigMap 原子写回
   * @param {(msg: string, meta?: object) => void} [opts.log]
   */
  constructor(opts) {
    this.secretsPath = opts.secretsPath;
    this.readConfigMap = opts.readConfigMap;
    this.writeConfigMap = opts.writeConfigMap;
    this.log = opts.log ?? (() => {});
    /** 保险箱是否可用（非 Windows / PowerShell 缺失时为 false） */
    this.vaultOk = null;
  }

  /**
   * 探测加密存储是否可用（只探一次）。
   *
   * @returns {Promise<boolean>}
   */
  async ensureVaultProbe() {
    if (this.vaultOk !== null) return this.vaultOk;
    try {
      this.vaultOk = await isVaultAvailable();
    } catch {
      this.vaultOk = false;
    }
    if (!this.vaultOk) {
      this.log('插件凭据加密存储不可用：敏感配置将无法保存', { level: 'warn' });
    }
    return this.vaultOk;
  }

  /**
   * 读整个保险箱（`{ [pluginId]: { [key]: sealed } }`）。
   *
   * 文件不存在是正常情况（还没存过任何敏感配置）。
   *
   * @returns {Promise<Record<string, Record<string, any>>>}
   */
  async readSealedAll() {
    try {
      const raw = await readJson(this.secretsPath);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    } catch (err) {
      // 保险箱坏了不能当成"空"：那会让用户以为凭据丢了却没有任何提示。
      // 报出来，由调用方决定降级（插件状态显示"凭据不可用"）。
      this.log(`插件凭据文件读取失败：${String(/** @type {any} */ (err)?.message ?? err)}`, { level: 'error' });
      throw err;
    }
  }

  /**
   * 读某个插件的已解密敏感值。
   *
   * 解密失败**不静默返回空**：那会让插件拿着空令牌去连，
   * 报出来的错是"认证失败"，而真正的原因是"换了 Windows 账户"。
   *
   * @param {string} pluginId
   * @returns {Promise<{ok: boolean, values: Record<string, string>, code?: string, message?: string}>}
   */
  async readSecrets(pluginId) {
    let all;
    try {
      all = await this.readSealedAll();
    } catch (err) {
      return {
        ok: false,
        values: {},
        code: 'E4101',
        message: `凭据文件不可读：${String(/** @type {any} */ (err)?.message ?? err)}`,
      };
    }
    const bag = all[pluginId];
    if (!bag || typeof bag !== 'object') return { ok: true, values: {} };

    /** @type {Record<string, string>} */
    const values = {};
    for (const [key, sealed] of Object.entries(bag)) {
      try {
        values[key] = await openSecret(/** @type {any} */ (sealed));
      } catch (err) {
        const e = /** @type {any} */ (err);
        return {
          ok: false,
          values: {},
          code: e?.code ?? 'E4101',
          message: `凭据「${key}」无法解密（可能换了 Windows 账户或换了机器）：${String(e?.message ?? e)}`,
        };
      }
    }
    return { ok: true, values };
  }

  /**
   * 保存一个插件的配置。
   *
   * ## `opts.validate` 是"落盘前的一道问询"
   *
   * 有些配置值在**类型上**合法、在**语义上**是坏的：一段 JSON 规则、
   * 一条正则、一组编号。类型校验（`coerceValue`）拦不住它们，
   * 只有插件自己知道怎么判断。
   *
   * 所以这里留一个钩子：宿主在**写盘之前**调用它，失败则整次保存作废。
   * 顺序（先校验、后写盘）是这条钩子的全部价值所在 —— 反过来写，
   * 就会出现"配置已经存进去了，然后告诉你它不能用"：
   * 用户下一次打开插件页，看到的是那份坏配置，而他改之前那份好配置
   * 已经没了。那不是"保存失败"，那是数据丢失。
   *
   * 钩子抛异常也按失败处理（不放行）：校验函数自己崩了，说明它
   * 没法给出"能用"的结论，此时默认放行等于把不确定性当成了许可。
   *
   * @param {string} pluginId
   * @param {object[]} decls 配置项声明
   * @param {{config?: Record<string, any>, secrets?: Record<string, any>}} input
   * @param {{validate?: (values: Record<string, any>) => Promise<{ok: boolean, message?: string}>}} [opts]
   * @returns {Promise<{ok: boolean, code?: string, message?: string, config?: Record<string, any>, invalid?: {key: string, message: string}[]}>}
   */
  async save(pluginId, decls, input, opts) {
    const inConfig = input?.config && typeof input.config === 'object' ? input.config : {};
    const inSecrets = input?.secrets && typeof input.secrets === 'object' ? input.secrets : {};

    /** @type {Record<string, any>} */
    const nextValues = {};
    /** @type {{key: string, message: string}[]} */
    const invalid = [];

    for (const spec of decls) {
      if (spec.secret) continue; // 敏感项单独处理
      const r = coerceValue(spec, inConfig[spec.key]);
      if (!r.ok) {
        invalid.push({ key: spec.key, message: r.message });
        continue;
      }
      nextValues[spec.key] = r.value;
    }

    if (invalid.length > 0) {
      return { ok: false, code: 'E4062', message: invalid.map((i) => i.message).join('；'), invalid };
    }

    // ---- 敏感项 ----
    const secretDecls = decls.filter((d) => d.secret);
    /** @type {Record<string, string>} */
    const plaintext = {};
    for (const spec of secretDecls) {
      const raw = inSecrets[spec.key];
      const v = typeof raw === 'string' ? raw.trim() : '';
      /*
       * 留空 = 保持原值。
       *
       * 这是必须的：表单不回显密钥，用户"只想改端口"时密码框天然是空的。
       * 如果空值被当成"清空"，每改一次别的字段就要重新粘贴一遍令牌 ——
       * 而用户会以为"我明明填过"。
       */
      if (v === '') continue;
      if (spec.maxLength !== undefined && v.length > spec.maxLength) {
        return { ok: false, code: 'E4062', message: `${spec.label} 最多 ${spec.maxLength} 个字符` };
      }
      if (spec.pattern !== undefined) {
        try {
          if (!new RegExp(`^(?:${spec.pattern})$`).test(v)) {
            return { ok: false, code: 'E4062', message: `${spec.label} 格式不正确` };
          }
        } catch {
          /* 声明期已校验 */
        }
      }
      plaintext[spec.key] = v;
    }

    /*
     * ---- 插件自校验（**落盘之前**）----
     *
     * 位置是这条钩子的全部价值：写在 `writeConfigMap` 之后，就会变成
     * "配置已经存进去了，然后才告诉你它不能用"。用户下一次打开插件页
     * 看到的是那份坏配置，而他改之前那份好配置已经被覆盖 ——
     * 那不是"保存失败"，那是数据丢失。
     *
     * 校验函数抛异常也按失败处理，不放行：它自己崩了，说明它给不出
     * "能用"的结论；此时默认放行等于把不确定性当成了许可。
     */
    if (typeof opts?.validate === 'function') {
      let v;
      try {
        v = await opts.validate(nextValues);
      } catch (err) {
        return {
          ok: false,
          code: 'E4062',
          message: `配置校验时出错（未保存）：${String(/** @type {any} */ (err)?.message ?? err)}`,
        };
      }
      if (!v || v.ok !== true) {
        return {
          ok: false,
          code: 'E4062',
          message: String(v?.message ?? '配置未通过插件自校验（未保存）'),
        };
      }
    }

    // ---- 写普通配置 ----
    const map = { ...this.readConfigMap() };
    map[pluginId] = nextValues;
    await this.writeConfigMap(map);

    // ---- 写敏感配置 ----
    if (Object.keys(plaintext).length > 0) {
      const ok = await this.ensureVaultProbe();
      if (!ok) {
        return {
          ok: false,
          code: 'E4101',
          message: '本机无法使用加密存储（DPAPI 不可用），敏感配置未保存；普通配置已保存',
        };
      }
      let all;
      try {
        all = await this.readSealedAll();
      } catch {
        all = {};
      }
      const bag = { ...(all[pluginId] ?? {}) };
      for (const [key, v] of Object.entries(plaintext)) {
        bag[key] = await sealSecret(v);
      }
      all[pluginId] = bag;
      await fs.mkdir(path.dirname(this.secretsPath), { recursive: true });
      await writeJsonAtomic(this.secretsPath, all);
    }

    return { ok: true, config: nextValues };
  }

  /**
   * 删除某个插件的全部配置（卸载时用）。
   *
   * @param {string} pluginId
   */
  async forget(pluginId) {
    const map = { ...this.readConfigMap() };
    if (pluginId in map) {
      delete map[pluginId];
      await this.writeConfigMap(map);
    }
    try {
      const all = await this.readSealedAll();
      if (pluginId in all) {
        delete all[pluginId];
        await writeJsonAtomic(this.secretsPath, all);
      }
    } catch {
      /* 凭据文件本来就坏的时候，删除失败不影响卸载 */
    }
  }

  /**
   * 给界面用的配置视图：**密钥字段一律空值 + hasSecret 标记**。
   *
   * @param {object[]} decls
   * @param {Record<string, any>} stored
   * @param {Record<string, string>} secrets
   * @returns {object[]}
   */
  static toView(decls, stored, secrets) {
    const resolved = resolveConfig(decls, stored, secrets);
    return decls.map((spec) => {
      const value = spec.secret ? '' : resolved.config[spec.key];
      return {
        key: spec.key,
        label: spec.label,
        type: spec.type,
        secret: spec.secret,
        required: spec.required,
        help: spec.help,
        placeholder: spec.placeholder,
        default: spec.secret ? '' : spec.default,
        options: spec.options ?? null,
        min: spec.min ?? null,
        max: spec.max ?? null,
        maxLength: spec.maxLength ?? null,
        integer: spec.integer === true,
        pattern: spec.pattern ?? null,
        generate: spec.generate ?? null,
        value: value === undefined ? '' : value,
        hasSecret: spec.secret ? typeof secrets?.[spec.key] === 'string' && secrets[spec.key] !== '' : false,
        missing: resolved.missing.includes(spec.key),
      };
    });
  }
}
