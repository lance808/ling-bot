/**
 * 插件管理器 —— 骨架的核心
 *
 * ## 它负责的那件事
 *
 * 需求原话：「日常新增、更新、配置和启停插件都不需要重新编译主程序 exe」。
 *
 * 这意味着插件的**存在、形状、配置项、启用状态**全部来自磁盘，
 * 主程序只提供一套通用的加载/校验/授权/展示流程。
 * 这个文件就是那套流程，`src/index.mjs` 只负责把它的结果接进 RPC 与工具面。
 *
 * ## 一次加载的完整顺序（顺序本身是安全要求）
 *
 * ```
 * 扫描目录 → 读 plugin.json → 校验清单与接口版本
 *          → 读启用状态与配置 → 校验配置（必填/类型/规则）
 *          → 仅对「已启用 + 配置有效」的插件 init
 *          → 全部工具登记成功才算成功（否则回滚，不留半个插件）
 * ```
 *
 * 为什么 init 必须在工具登记**之前**：init 里通常要连服务、开端口。
 * 如果先登记工具再 init，那么 init 失败的窗口期内，模型已经能看到
 * 并调用一个根本跑不起来的工具 —— 用户看到的是"工具报错"，
 * 而真实原因是"插件没起来"。
 *
 * ## 一个插件失败不影响别人
 *
 * 每个插件的加载/初始化/调用都在独立的 try/catch 里，且 `process` 运行时
 * 还隔着进程边界。这条是硬要求：插件是"用户自己装的代码"，
 * 它写错一行不该让整个机器人失联。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { readJson, writeJsonAtomic } from '../config/atomic.mjs';
import { defineTool, getTool, removeToolsOfPlugin } from '../tools/registry.mjs';
import {
  MANIFEST_FILE,
  PLUGIN_TOOL_PREFIX,
  checkRiskAllowed,
  deriveToolPolicy,
  normalizeManifest,
  pluginDataDirOf,
} from './manifest.mjs';
import { PluginConfigStore, resolveConfig } from './store.mjs';
import { InProcessRuntime } from './runtime-inprocess.mjs';
import { ProcessRuntime } from './runtime-process.mjs';

/** 每个插件保留多少条日志给界面看 */
const LOG_RING = 50;

/** 状态 → 中文短语。界面直接显示，不允许"看起来正常其实没跑"。 */
const STATUS_TEXT = Object.freeze({
  disabled: '未启用',
  'needs-config': '待配置',
  starting: '启动中',
  ready: '运行中',
  error: '运行失败',
  crashed: '已崩溃',
  invalid: '清单不合法',
  incompatible: '接口不兼容',
  missing: '目录缺失',
  stale: '有更新待重载',
});

/**
 * 插件管理器。
 */
export class PluginManager {
  /**
   * @param {object} opts
   * @param {string} opts.pluginsDir 插件根目录（磁盘）
   * @param {string} opts.userDataRoot 用户数据根（放 plugin-data）
   * @param {string} opts.secretsPath 插件凭据保险箱
   * @param {() => any} opts.getConfig 读当前完整配置
   * @param {(next: any) => Promise<void>} opts.persistConfig 原子写回配置
   * @param {(level: string, message: string, fields?: object) => void} opts.log 宿主日志
   * @param {(convKey: string, text: string) => Promise<any>} opts.sendText 宿主发送闸门
   * @param {string} [opts.nodePath] 子进程用的 node 可执行文件
   */
  constructor(opts) {
    this.pluginsDir = opts.pluginsDir;
    this.userDataRoot = opts.userDataRoot;
    this.getConfig = opts.getConfig;
    this.persistConfig = opts.persistConfig;
    this.log = opts.log;
    this.sendText = opts.sendText;
    this.nodePath = opts.nodePath;

    this.store = new PluginConfigStore({
      secretsPath: opts.secretsPath,
      readConfigMap: () => this.getConfig()?.plugins?.config ?? {},
      writeConfigMap: async (map) => {
        const next = { ...this.getConfig(), plugins: { ...this.getConfig().plugins, config: map } };
        await this.persistConfig(next);
      },
      log: (msg, meta) => this.log(meta?.level ?? 'info', msg),
    });

    /** @type {Map<string, any>} id → 插件记录 */
    this.records = new Map();
    /** 是否已经完成一次加载（供 snapshot 判断 starting） */
    this.ready = false;
  }

  /* ---------------------------------------------------------------- 扫描 */

  /**
   * 扫描插件目录，列出磁盘上存在的插件。
   *
   * 只读 `plugin.json`，**不 import 任何插件代码** ——
   * 插件页必须能在一个坏插件存在时正常打开，否则用户没有任何办法关掉它。
   *
   * @returns {Promise<Map<string, {id: string, dir: string, raw: any, manifest?: object, mtimeMs: number, error?: {code: string, message: string}}>>}
   */
  async scan() {
    /** @type {Map<string, any>} */
    const found = new Map();

    let entries;
    try {
      entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });
    } catch {
      // 目录不存在是正常情况（还没装任何插件）
      return found;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      // `.staging` / `.backup` / `_template` 这类目录不是插件
      if (id.startsWith('.') || id.startsWith('_')) continue;

      const dir = path.join(this.pluginsDir, id);
      const manifestPath = path.join(dir, MANIFEST_FILE);

      let raw;
      let mtimeMs = 0;
      try {
        const st = await fs.stat(manifestPath);
        mtimeMs = st.mtimeMs;
        raw = await readJson(manifestPath);
      } catch (err) {
        const e = /** @type {any} */ (err);
        found.set(id, {
          id,
          dir,
          raw: null,
          mtimeMs,
          error:
            e?.code === 'ENOENT'
              ? { code: 'E4060', message: `缺少 ${MANIFEST_FILE}` }
              : { code: 'E4041', message: `清单读取失败：${String(e?.message ?? e)}` },
        });
        continue;
      }

      const norm = normalizeManifest(raw, { dirName: id });
      if (!norm.ok) {
        found.set(id, { id, dir, raw, mtimeMs, error: { code: norm.code, message: norm.message } });
        continue;
      }

      found.set(id, { id, dir, raw, mtimeMs, manifest: norm.manifest });
    }

    return found;
  }

  /* ---------------------------------------------------------------- 加载 */

  /**
   * 全量加载：扫描 + 初始化所有「已启用且配置有效」的插件。
   *
   * @returns {Promise<{loaded: string[], failed: string[], skipped: string[]}>}
   */
  async loadAll() {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled : [];
    const allowDangerous = config?.plugins?.allowDangerous === true;

    // 先清掉上一轮登记的插件工具（重载场景）
    for (const id of this.records.keys()) removeToolsOfPlugin(id);
    await this.disposeAll();

    const found = await this.scan();
    /** @type {string[]} */
    const loaded = [];
    /** @type {string[]} */
    const failed = [];
    /** @type {string[]} */
    const skipped = [];

    // 磁盘上有、但没在 enabled 里 → 记成"已安装未启用"
    for (const [id, info] of found) {
      if (!enabled.includes(id)) {
        const record = this.makeRecord(info, { enabled: false });
        /*
         * 未启用的插件也要有配置视图。
         *
         * 否则插件页上它的「配置」区是空的 —— 而刚装好、还没启用的时候
         * 恰恰是最需要填配置的时刻（必填项空着，启用就会被拒）。
         */
        await this.primeConfigView(record);
        this.records.set(id, record);
        skipped.push(id);
      }
    }

    // enabled 里有、磁盘上没有 → 明确报"目录缺失"，而不是静默忽略
    for (const id of enabled) {
      if (!found.has(id)) {
        this.records.set(id, {
          id,
          dir: path.join(this.pluginsDir, id),
          enabled: true,
          installed: false,
          status: 'missing',
          statusText: STATUS_TEXT.missing,
          error: { code: 'E4044', message: '启用列表里有该插件，但磁盘上找不到插件目录' },
          manifest: null,
          tools: [],
          config: [],
          logs: [],
          runtime: null,
          lastErrorAt: new Date().toISOString(),
        });
        failed.push(id);
        this.log('warn', `插件目录缺失：${id}`);
      }
    }

    // 逐个加载（顺序执行：避免多个插件同时抢端口时互相干扰）
    for (const id of enabled) {
      const info = found.get(id);
      if (!info) continue;

      const record = this.makeRecord(info, { enabled: true });
      this.records.set(id, record);

      const result = await this.startOne(record, { allowDangerous });
      if (result.ok) loaded.push(id);
      else failed.push(id);
    }

    this.ready = true;
    return { loaded, failed, skipped };
  }

  /**
   * 从扫描结果造一条记录（不做任何 IO）。
   *
   * @param {any} info
   * @param {{enabled: boolean}} opts
   * @returns {any}
   */
  makeRecord(info, opts) {
    const manifest = info.manifest ?? null;
    const base = {
      id: info.id,
      dir: info.dir,
      installed: true,
      enabled: opts.enabled,
      manifest,
      /** 磁盘上 plugin.json 的 mtime，用来发现"包更新了" */
      mtimeMs: info.mtimeMs ?? 0,
      /** 已加载时对应的 mtime（发现更新靠它对比） */
      loadedMtimeMs: 0,
      runtime: null,
      config: [],
      secrets: {},
      logs: [],
      error: null,
      lastErrorAt: null,
      restartRequired: false,
      tools: [],
    };

    if (info.error) {
      return {
        ...base,
        status: info.error.code === 'E4061' ? 'incompatible' : 'invalid',
        statusText: STATUS_TEXT[info.error.code === 'E4061' ? 'incompatible' : 'invalid'],
        error: info.error,
        lastErrorAt: new Date().toISOString(),
      };
    }

    return {
      ...base,
      status: opts.enabled ? 'starting' : 'disabled',
      statusText: STATUS_TEXT[opts.enabled ? 'starting' : 'disabled'],
    };
  }

  /**
   * 给还没启动过的插件也填一份配置视图。
   *
   * ## 为什么必须有
   *
   * 配置只在 `startOne()` 里才被算出来。于是一个**刚装好、还没启用**的插件
   * 在插件页上配置区是空的 —— 而它恰恰是最需要填配置的时候（必填项没填，
   * 启用就会被拒）。用户看到的是「配置」下面什么都没有，无从下手。
   *
   * ## 为什么不在这里解密
   *
   * `hasSecret` 只需要知道"有没有存过"，不需要知道值。所以这里只读封存文件
   * 的 **键**，不调 `openSecret`（那会为每个字段起一次 PowerShell，
   * 而本函数在扫描时会对每个插件跑一遍）。
   *
   * 失败一律降级成"没有凭据"，绝不让它把扫描搞挂。
   *
   * @param {any} record
   */
  async primeConfigView(record) {
    const manifest = record.manifest;
    if (!manifest) return;

    /*
     * 工具清单也一样：它平时是 startOne() 成功后才填的。
     * 未启用时留空，插件页的「工具清单」就是空的 —— 用户看不到
     * 这个插件到底会提供什么工具，也就没法判断要不要启用它。
     *
     * 注意这里的工具只是**声明**（registered: false），没有真正登记到
     * 工具注册表里，AI 看不到、也调不到。
     */
    if (record.tools.length === 0 && (manifest.tools ?? []).length > 0) {
      record.tools = manifest.tools.map((t) => ({ ...t, registered: false }));
    }

    if (record.config.length > 0) return;

    const stored = this.getConfig()?.plugins?.config?.[record.id] ?? {};
    record.config = PluginConfigStore.toView(manifest.config, stored, {});

    // 只查键在不在，不解密
    try {
      const all = await this.store.readSealedAll();
      const bag = all?.[record.id];
      if (bag && typeof bag === 'object') {
        for (const field of record.config) {
          if (field.secret && typeof bag[field.key] === 'string' && bag[field.key] !== '') {
            field.hasSecret = true;
          }
        }
      }
    } catch {
      /* 保险箱读不出来就当没有凭据；真正启用时 startOne 会报 E4101 */
    }
  }

  /**
   * 启动单个插件：读配置 → init → 登记工具。
   *
   * **工具登记是最后一步，且要么全成要么全不成。**
   *
   * @param {any} record
   * @param {{allowDangerous: boolean}} opts
   * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
   */
  async startOne(record, opts) {
    const manifest = record.manifest;
    if (!manifest) {
      record.status = record.status === 'incompatible' ? 'incompatible' : 'invalid';
      record.statusText = STATUS_TEXT[record.status];
      return { ok: false, code: record.error?.code ?? 'E4041', message: record.error?.message ?? '清单不合法' };
    }

    record.enabled = true;
    record.status = 'starting';
    record.statusText = STATUS_TEXT.starting;
    record.error = null;

    // ---- 1. 配置 ----
    const storedMap = this.getConfig()?.plugins?.config ?? {};
    const stored = storedMap[record.id] ?? {};

    const sec = await this.store.readSecrets(record.id);
    if (!sec.ok) {
      /*
       * 凭据解不开（换机器/换账户）不能当成"空值"往下走：
       * 那会让插件拿着空令牌去连，报出来的错是"认证失败"，
       * 而用户需要知道的其实是"凭据失效了，请重填"。
       */
      return this.fail(record, { code: sec.code ?? 'E4101', message: sec.message ?? '凭据不可用', status: 'error' });
    }
    record.secrets = sec.values;

    const resolved = resolveConfig(manifest.config, stored, sec.values);
    record.config = PluginConfigStore.toView(manifest.config, stored, sec.values);

    if (!resolved.ok) {
      const msg =
        resolved.invalid.length > 0
          ? resolved.invalid.map((i) => i.message).join('；')
          : `缺少必填配置：${resolved.missing.join(', ')}`;
      record.status = 'needs-config';
      record.statusText = STATUS_TEXT['needs-config'];
      record.error = { code: resolved.invalid.length > 0 ? 'E4062' : 'E4063', message: msg };
      record.tools = manifest.tools.map((t) => ({ ...t, registered: false }));
      this.note(record, 'warn', `配置不完整，未启动：${msg}`);
      return { ok: false, code: record.error.code, message: msg };
    }

    // ---- 2. 风险检查 ----
    for (const t of manifest.tools) {
      const r = checkRiskAllowed(t.risk, opts.allowDangerous);
      if (!r.ok) {
        return this.fail(record, { code: r.code, message: r.message, status: 'error' });
      }
    }

    // ---- 3. 工具名冲突检查（在 init 之前，避免白起一个进程） ----
    for (const t of manifest.tools) {
      const existing = getTool(t.fullName);
      if (existing) {
        return this.fail(record, {
          code: 'E4043',
          message: `工具名已被占用：${t.fullName}（已属于 ${existing.plugin ? `插件 ${existing.plugin}` : '内置工具'}）`,
          status: 'error',
        });
      }
    }

    // ---- 4. init ----
    const dataDir = pluginDataDirOf(this.userDataRoot, record.id);
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch {
      /* 建不出数据目录不该阻止插件启动（插件可能根本不用它） */
    }

    const RuntimeCtor = manifest.runtime === 'in-process' ? InProcessRuntime : ProcessRuntime;
    const runtime = new RuntimeCtor({
      manifest,
      dir: record.dir,
      dataDir,
      config: resolved.config,
      secrets: resolved.secrets,
      log: (level, message, fields) => this.note(record, level, message, fields),
      sendText: this.sendText,
      nodePath: this.nodePath,
    });

    record.runtime = runtime;

    let initResult;
    try {
      initResult = await runtime.init();
    } catch (err) {
      const e = /** @type {any} */ (err);
      initResult = { ok: false, code: 'E4064', message: String(e?.message ?? e) };
    }

    if (!initResult.ok) {
      record.runtime = null;
      return this.fail(record, {
        code: initResult.code ?? 'E4064',
        message: initResult.message ?? '初始化失败',
        status: 'error',
      });
    }

    // ---- 5. 登记工具（全部成功才算成功） ----
    /** @type {string[]} */
    const registeredNames = [];
    try {
      for (const t of manifest.tools) {
        const policy = deriveToolPolicy(t);
        defineTool({
          name: t.fullName,
          kind: policy.kind,
          origins: policy.origins,
          risk: policy.risk,
          confirm: policy.confirm,
          description: `${t.description}（来自插件 ${manifest.name}）`,
          params: t.params,
          limits: {},
          pathPolicy: t.needs === 'host' ? 'roots' : 'none',
          plugin: record.id,
          /**
           * 注意：这里**不闭包捕获 runtime**，而是每次调用时从 record 上取。
           * 否则重载后工具还指着旧 runtime，出现"插件页显示已重载、
           * 调用却打到旧实例"的鬼问题。
           */
          run: async ({ args, signal }) => {
            const rt = record.runtime;
            if (!rt) {
              return { ok: false, code: 'E4067', message: `插件 ${manifest.name} 当前未运行` };
            }
            const r = await rt.callTool({ tool: t.name, args: args ?? {}, timeoutMs: t.timeoutMs, signal });
            if (!r.ok) {
              /*
               * 运行期失败也要反映到插件状态上。
               *
               * 否则会出现最误导的一种情况：子进程超时被杀、工具调用全失败，
               * 而插件页仍显示绿色的「运行中」—— 用户会以为是模型不会用这个工具。
               */
              record.lastErrorAt = new Date().toISOString();
              record.error = { code: r.code ?? 'E4066', message: r.message ?? '插件执行失败' };
              this.note(record, 'error', `工具 ${t.name} 失败：${record.error.code} ${record.error.message}`);
              /*
               * 超时/崩溃意味着运行时已经不可用（process 运行时会被 kill）。
               * 这里把状态标成 crashed 并撤掉工具：让模型立刻看不到它，
               * 而不是继续调一个必然失败的工具。用户点「重载」即可恢复。
               */
              if (r.code === 'E4065' || r.code === 'E4066') {
                record.status = 'crashed';
                record.statusText = STATUS_TEXT.crashed;
                removeToolsOfPlugin(record.id);
                record.tools = (record.manifest?.tools ?? []).map((x) => ({ ...x, registered: false }));
              }
              return { ok: false, code: r.code ?? 'E4066', message: r.message ?? '插件执行失败' };
            }
            return r.value;
          },
        });
        registeredNames.push(t.fullName);
      }
    } catch (err) {
      // 中途失败：把已经登记的撤掉，绝不留"半个插件"
      for (const name of registeredNames) removeToolsOfPlugin(record.id);
      const e = /** @type {any} */ (err);
      try {
        await runtime.dispose();
      } catch {
        /* 忽略 */
      }
      record.runtime = null;
      return this.fail(record, {
        code: 'E4041',
        message: `工具登记失败：${String(e?.message ?? e)}`,
        status: 'error',
      });
    }

    record.tools = manifest.tools.map((t) => ({
      ...t,
      registered: registeredNames.includes(t.fullName),
    }));
    record.status = 'ready';
    record.statusText = STATUS_TEXT.ready;
    record.error = null;
    record.lastErrorAt = null;
    record.loadedMtimeMs = record.mtimeMs;
    record.restartRequired = false;

    this.note(record, 'info', `已启动（${manifest.runtime} 运行时，${registeredNames.length} 个工具）`);
    return { ok: true };
  }

  /**
   * 把记录标成失败。
   *
   * @param {any} record
   * @param {{code: string, message: string, status: string}} err
   * @returns {{ok: false, code: string, message: string}}
   */
  fail(record, err) {
    record.status = err.status;
    record.statusText = STATUS_TEXT[err.status] ?? STATUS_TEXT.error;
    record.error = { code: err.code, message: err.message };
    record.lastErrorAt = new Date().toISOString();
    record.tools = (record.manifest?.tools ?? []).map((t) => ({ ...t, registered: false }));
    this.note(record, 'error', `${err.code} ${err.message}`);
    this.log('warn', `插件 ${record.id} 启动失败：${err.code} ${err.message}`);
    return { ok: false, code: err.code, message: err.message };
  }

  /**
   * 记一条插件日志（同时进宿主日志）。
   *
   * @param {any} record
   * @param {string} level
   * @param {string} message
   * @param {object} [fields]
   */
  note(record, level, message, fields) {
    const text = String(message ?? '').slice(0, 2000);
    record.logs.push({ at: new Date().toISOString(), level: String(level ?? 'info'), message: text });
    if (record.logs.length > LOG_RING) record.logs.splice(0, record.logs.length - LOG_RING);
    // 插件日志一律带 id 进主日志，排查时能一眼看出是谁在说话
    this.log(level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', `[插件 ${record.id}] ${text}`, fields);
  }

  /* ---------------------------------------------------------------- 启停 */

  /**
   * 启用插件。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, code?: string, message?: string, status?: string, restartRequired?: boolean}>}
   */
  async enable(id) {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? [...config.plugins.enabled] : [];
    if (!enabled.includes(id)) enabled.push(id);

    let record = this.records.get(id);
    if (!record) {
      // 可能是刚放进磁盘、还没扫描过的插件：现场扫一次
      const found = await this.scan();
      const info = found.get(id);
      if (!info) return { ok: false, code: 'E4044', message: `磁盘上没有插件 ${id}` };
      record = this.makeRecord(info, { enabled: true });
      this.records.set(id, record);
    }

    if (!record.manifest) {
      return {
        ok: false,
        code: record.error?.code ?? 'E4041',
        message: record.error?.message ?? '插件清单不合法，无法启用',
        status: record.status,
      };
    }

    record.enabled = true;
    await this.persistConfig({ ...config, plugins: { ...config.plugins, enabled } });

    const r = await this.startOne(record, { allowDangerous: config?.plugins?.allowDangerous === true });
    return { ...r, status: record.status, restartRequired: record.restartRequired === true };
  }

  /**
   * 停用插件。
   *
   * 顺序很重要：**先注销工具，再释放运行时**。
   * 反过来的话，在 dispose 的这几百毫秒里，模型仍能调用一个正在关闭的插件。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, code?: string, message?: string, cancelled?: number, status?: string}>}
   */
  async disable(id) {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled.filter((x) => x !== id) : [];

    const record = this.records.get(id);

    // 1) 立刻注销工具：新的调用马上就不存在了
    const cancelled = removeToolsOfPlugin(id);

    // 2) 释放运行时（在途调用由运行时中断/杀死）
    if (record?.runtime) {
      const rt = record.runtime;
      record.runtime = null;
      try {
        await rt.dispose();
      } catch (err) {
        this.log('warn', `插件 ${id} 释放时出错：${String(/** @type {any} */ (err)?.message ?? err)}`);
      }
    }

    await this.persistConfig({ ...config, plugins: { ...config.plugins, enabled } });

    if (record) {
      record.enabled = false;
      record.status = 'disabled';
      record.statusText = STATUS_TEXT.disabled;
      record.tools = (record.manifest?.tools ?? []).map((t) => ({ ...t, registered: false }));
      record.error = null;
      this.note(record, 'info', '已停用');
    }

    return { ok: true, cancelled, status: 'disabled' };
  }

  /**
   * 保存配置；已启用且配置有效的插件会**立即重新初始化**。
   *
   * @param {string} id
   * @param {{config?: Record<string, any>, secrets?: Record<string, any>}} input
   * @returns {Promise<{ok: boolean, applied?: boolean, restartRequired?: boolean, message: string, code?: string, status?: string, invalid?: any[]}>}
   */
  async saveConfig(id, input) {
    const record = this.records.get(id);
    if (!record?.manifest) {
      return { ok: false, code: 'E4044', message: `磁盘上没有可配置的插件 ${id}` };
    }

    const saved = await this.store.save(id, record.manifest.config, input ?? {});
    if (!saved.ok) {
      return { ok: false, code: saved.code ?? 'E4062', message: saved.message ?? '配置保存失败', invalid: saved.invalid };
    }

    if (!record.enabled) {
      // 没启用：只存盘，下次启用时才校验生效
      record.config = PluginConfigStore.toView(record.manifest.config, saved.config ?? {}, {});
      return { ok: true, applied: false, message: '配置已保存（插件未启用，启用后生效）', status: record.status };
    }

    /*
     * 已启用 → 重新走一遍 init。
     *
     * 为什么必须重来而不是"改一下内存里的值"：插件的端口、连接、
     * 定时器都是 init 里建的。只改内存里的 config 对象，
     * 插件仍在用旧端口监听 —— 用户以为改了，实际没改。
     */
    const wasReady = record.status === 'ready';
    if (record.runtime) {
      removeToolsOfPlugin(id);
      const rt = record.runtime;
      record.runtime = null;
      try {
        await rt.dispose();
      } catch {
        /* 忽略 */
      }
    }

    const allowDangerous = this.getConfig()?.plugins?.allowDangerous === true;
    const r = await this.startOne(record, { allowDangerous });

    if (r.ok) {
      /*
       * 同进程插件重载后，入口里 import 的 ./lib/* 仍是旧模块（ESM 缓存）。
       * 所以对 in-process 插件，改了配置后"大部分能立即生效"，
       * 但改了 lib 代码必须重启后端。这里如实告诉用户，不假装热更新。
       */
      const restartRequired = record.manifest.runtime === 'in-process';
      record.restartRequired = restartRequired;
      return {
        ok: true,
        applied: true,
        restartRequired,
        message: wasReady
          ? restartRequired
            ? '配置已保存并重新初始化；同进程插件的内部模块改动需重启后端才彻底生效'
            : '配置已保存并生效'
          : '配置已保存并已启动',
        status: record.status,
      };
    }

    return {
      ok: false,
      applied: false,
      code: r.code,
      message: `配置已保存，但插件未能启动：${r.message ?? ''}`,
      status: record.status,
    };
  }

  /**
   * 测试连接。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, message?: string, details?: object, code?: string}>}
   */
  async test(id) {
    const record = this.records.get(id);
    if (!record?.manifest) {
      return { ok: false, code: 'E4044', message: `磁盘上没有插件 ${id}` };
    }
    if (!record.runtime) {
      /*
       * 未启用时也要能测：诊断的价值就在于"启用之前先确认连得上"。
       * 这里临时起一个运行时，测完立刻释放。
       */
      return this.testWithTempRuntime(record);
    }
    return record.runtime.testConnection();
  }

  /**
   * 未启用时临时起运行时做一次测试。
   *
   * @param {any} record
   * @returns {Promise<{ok: boolean, message?: string, details?: object, code?: string}>}
   */
  async testWithTempRuntime(record) {
    const manifest = record.manifest;
    const storedMap = this.getConfig()?.plugins?.config ?? {};
    const stored = storedMap[record.id] ?? {};

    const sec = await this.store.readSecrets(record.id);
    if (!sec.ok) return { ok: false, code: sec.code ?? 'E4101', message: sec.message ?? '凭据不可用' };

    const resolved = resolveConfig(manifest.config, stored, sec.values);
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.invalid.length > 0 ? 'E4062' : 'E4063',
        message:
          resolved.invalid.length > 0
            ? resolved.invalid.map((i) => i.message).join('；')
            : `缺少必填配置：${resolved.missing.join(', ')}`,
      };
    }

    const dataDir = pluginDataDirOf(this.userDataRoot, record.id);
    const RuntimeCtor = manifest.runtime === 'in-process' ? InProcessRuntime : ProcessRuntime;
    const runtime = new RuntimeCtor({
      manifest,
      dir: record.dir,
      dataDir,
      config: resolved.config,
      secrets: resolved.secrets,
      log: (level, message, fields) => this.note(record, level, message, fields),
      sendText: this.sendText,
      nodePath: this.nodePath,
    });

    try {
      const init = await runtime.init();
      if (!init.ok) return { ok: false, code: init.code, message: init.message };
      return await runtime.testConnection();
    } catch (err) {
      return { ok: false, code: 'E4066', message: String(/** @type {any} */ (err)?.message ?? err) };
    } finally {
      try {
        await runtime.dispose();
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 重载单个插件（先停后起）。
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, code?: string, message?: string, status?: string}>}
   */
  async reload(id) {
    const record = this.records.get(id);
    if (!record) return { ok: false, code: 'E4044', message: `未知插件 ${id}` };

    // 重新读磁盘上的清单：重载的意义就是"让磁盘上的改动生效"
    const found = await this.scan();
    const info = found.get(id);
    if (!info) return { ok: false, code: 'E4044', message: `磁盘上已没有插件 ${id}` };

    const wasEnabled = record.enabled;
    const fresh = this.makeRecord(info, { enabled: wasEnabled });
    fresh.logs = record.logs;
    this.records.set(id, fresh);

    removeToolsOfPlugin(id);
    if (record.runtime) {
      try {
        await record.runtime.dispose();
      } catch {
        /* 忽略 */
      }
    }

    if (!wasEnabled) {
      /*
       * 未启用的插件也要把**新声明的**配置项和工具填出来。
       *
       * 否则会出现很难理解的现象：磁盘上的包已经换成 v2（多了配置项、
       * 多了工具），插件页上却还是空的 —— 因为这个分支在
       * `startOne()` 之前就返回了，而配置视图和工具清单只在
       * startOne 里填。用户会以为包没换成功。
       */
      await this.primeConfigView(fresh);
      return {
        ok: true,
        message: '已重新读取插件包（未启用，启用后生效）',
        status: fresh.status,
        version: fresh.manifest?.version ?? '',
      };
    }

    const allowDangerous = this.getConfig()?.plugins?.allowDangerous === true;
    const r = await this.startOne(fresh, { allowDangerous });
    // 带上版本号：界面要告诉用户"更新到了哪个版本"，光说"成功"没有信息量
    return { ...r, status: fresh.status, version: fresh.manifest?.version ?? '' };
  }

  /**
   * 重新扫描目录：发现新放进去的插件、清理已删除的。
   *
   * @returns {Promise<{ok: boolean, added: string[], removed: string[], total: number}>}
   */
  async rescan() {
    const found = await this.scan();
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled : [];

    /** @type {string[]} */
    const added = [];
    /** @type {string[]} */
    const removed = [];

    for (const id of found.keys()) {
      if (!this.records.has(id)) {
        const info = found.get(id);
        const isEnabled = enabled.includes(id);
        const record = this.makeRecord(info, { enabled: isEnabled });
        // 新丢进来的包也要能立刻填配置（见 primeConfigView 的说明）
        if (!isEnabled) await this.primeConfigView(record);
        this.records.set(id, record);
        added.push(id);
      }
    }
    for (const id of [...this.records.keys()]) {
      if (!found.has(id)) {
        const record = this.records.get(id);
        removeToolsOfPlugin(id);
        if (record?.runtime) {
          try {
            await record.runtime.dispose();
          } catch {
            /* 忽略 */
          }
        }
        this.records.delete(id);
        removed.push(id);
      }
    }

    return { ok: true, added, removed, total: this.records.size };
  }

  /* ---------------------------------------------------------------- 消息 */

  /**
   * 把一条 QQ 消息交给所有「已就绪的 in-process 插件」尝试接管。
   *
   * 只有 in-process 运行时能接管：子进程拿不到宿主的发送闸门与事件流。
   *
   * @param {object} evt
   * @returns {Promise<boolean>} true = 已处理，宿主不再走 AI 回合
   */
  async dispatchMessage(evt) {
    for (const record of this.records.values()) {
      if (!record.enabled || record.status !== 'ready') continue;
      if (!record.manifest?.handleMessage) continue;
      if (record.manifest.runtime !== 'in-process') continue;
      const rt = record.runtime;
      if (!rt || typeof rt.handleMessage !== 'function') continue;
      try {
        const handled = await rt.handleMessage({ evt });
        if (handled === true) return true;
      } catch (err) {
        this.note(record, 'error', `消息接管异常：${String(/** @type {any} */ (err)?.message ?? err)}`);
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- 视图 */

  /**
   * 生成界面快照。
   *
   * 注意：这里会 stat 每个 plugin.json 以发现"包被更新了"。
   * 插件数量是个位数，2 秒一次 stat 的成本可以忽略。
   *
   * @returns {Promise<object>}
   */
  async snapshot() {
    const config = this.getConfig();
    const enabled = Array.isArray(config?.plugins?.enabled) ? config.plugins.enabled : [];
    const allowDangerous = config?.plugins?.allowDangerous === true;

    /** @type {any[]} */
    const items = [];

    for (const record of this.records.values()) {
      const m = record.manifest;
      let hasUpdate = false;

      if (m && record.installed) {
        try {
          const st = await fs.stat(path.join(record.dir, MANIFEST_FILE));
          // mtime 变了就说明磁盘上的包被替换过
          hasUpdate = record.loadedMtimeMs > 0 && st.mtimeMs > record.loadedMtimeMs + 1;
        } catch {
          /* stat 失败就当没有更新 */
        }
      }

      let status = record.status;
      let statusText = record.statusText;

      // 已启用但从未成功加载（比如刚放进来还没 reload）
      if (!record.installed) {
        status = 'missing';
        statusText = STATUS_TEXT.missing;
      } else if (hasUpdate && status === 'ready') {
        status = 'stale';
        statusText = STATUS_TEXT.stale;
      }

      items.push({
        id: record.id,
        name: m?.name ?? record.id,
        version: m?.version ?? '',
        description: m?.description ?? '',
        author: m?.author ?? '',
        apiVersion: m?.apiVersion ?? '',
        runtime: m?.runtime ?? '',
        trusted: m?.trusted === true,
        enabled: record.enabled,
        installed: record.installed,
        status,
        statusText,
        error: record.error ?? null,
        lastErrorAt: record.lastErrorAt ?? null,
        restartRequired: record.restartRequired === true,
        hasUpdate,
        tools: (record.tools ?? []).map((t) => ({
          name: t.name,
          fullName: t.fullName ?? PLUGIN_TOOL_PREFIX + t.name,
          description: t.description,
          needs: t.needs,
          risk: t.risk,
          confirm: t.risk === 'R0' ? 'never' : 'always',
          timeoutMs: t.timeoutMs,
          params: t.params ?? {},
          enabled: record.status === 'ready' && t.registered !== false,
        })),
        config: record.config ?? [],
        permissions: m?.permissions ?? [],
        notes: m?.notes ?? [],
        ui: m?.ui ?? null,
        log: record.logs.slice(-LOG_RING),
        dir: record.dir,
        dataDir: pluginDataDirOf(this.userDataRoot, record.id),
      });
    }

    // 稳定排序：启用中的在前，然后按名字。避免每次刷新列表跳动。
    items.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    /*
     * `error` 的口径要和界面上"红条"一致。
     *
     * `missing`（启用列表里有、磁盘上没目录）和 `stale`（包被换掉、
     * 需要重载）都是**需要用户处理**的状态。漏掉它们会出现
     * "概况说异常 0、列表里却有一条红的"——用户只会信概况那张卡。
     */
    const errorStatuses = ['error', 'crashed', 'invalid', 'incompatible', 'missing', 'stale'];
    const stats = {
      total: items.length,
      ready: items.filter((i) => i.status === 'ready').length,
      error: items.filter((i) => errorStatuses.includes(i.status)).length,
      disabled: items.filter((i) => i.status === 'disabled').length,
    };

    return {
      enabled,
      allowDangerous,
      // 兼容旧字段（脚本与旧界面还在用）
      loaded: items
        .filter((i) => i.status === 'ready')
        .map((i) => ({ name: i.id, ok: true, tools: i.tools.map((t) => t.fullName) })),
      skipped: items.filter((i) => !i.enabled).map((i) => i.id),
      items,
      stats,
      dirs: { plugins: this.pluginsDir, data: this.userDataRoot },
    };
  }

  /* ---------------------------------------------------------------- 安装 */

  /**
   * 安装/更新插件包：先完整落到暂存目录并校验，再替换。
   *
   * 为什么不是"直接覆盖"：覆盖到一半失败会留下半个包，
   * 而插件页会显示一个"清单不合法"的插件，用户唯一的出路是手动删目录。
   *
   * @param {string} sourcePath 源目录（插件包根目录）
   * @returns {Promise<{ok: boolean, id?: string, version?: string, backup?: string, code?: string, message?: string}>}
   */
  async install(sourcePath) {
    let st;
    try {
      st = await fs.stat(sourcePath);
    } catch {
      return { ok: false, code: 'E4069', message: `源路径不存在：${sourcePath}` };
    }
    if (!st.isDirectory()) return { ok: false, code: 'E4069', message: '源路径必须是目录' };

    // 先读源清单：id 决定装到哪个目录
    let raw;
    try {
      raw = await readJson(path.join(sourcePath, MANIFEST_FILE));
    } catch (err) {
      return { ok: false, code: 'E4060', message: `源目录缺少可读的 ${MANIFEST_FILE}：${String(/** @type {any} */ (err)?.message ?? err)}` };
    }
    const norm = normalizeManifest(raw, { dirName: raw?.id ?? '' });
    if (!norm.ok) return { ok: false, code: norm.code, message: norm.message };

    const id = norm.manifest.id;
    const target = path.join(this.pluginsDir, id);
    const staging = path.join(this.pluginsDir, `.staging-${id}-${Date.now()}`);
    const backupRoot = path.join(this.pluginsDir, '.backup');
    const backup = path.join(backupRoot, `${id}-${Date.now()}`);

    try {
      await fs.mkdir(this.pluginsDir, { recursive: true });
      await fs.cp(sourcePath, staging, { recursive: true, force: true });

      // 校验暂存副本（防止拷贝过程中丢文件）
      const staged = normalizeManifest(await readJson(path.join(staging, MANIFEST_FILE)), { dirName: id });
      if (!staged.ok) throw Object.assign(new Error(staged.message), { code: staged.code });

      // 旧版本移到备份，失败可回滚
      let hadOld = false;
      try {
        await fs.mkdir(backupRoot, { recursive: true });
        await fs.rename(target, backup);
        hadOld = true;
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'ENOENT') throw err;
      }

      try {
        await fs.rename(staging, target);
      } catch (err) {
        // 替换失败：把备份放回去，别让用户失去原来的插件
        if (hadOld) {
          try {
            await fs.rename(backup, target);
          } catch {
            /* 回滚也失败，只能把错误报出去 */
          }
        }
        throw err;
      }

      return {
        ok: true,
        id,
        version: norm.manifest.version,
        backup: hadOld ? backup : undefined,
        message: hadOld ? `已更新到 ${norm.manifest.version}（旧版本备份在 ${backup}）` : '已安装',
      };
    } catch (err) {
      const e = /** @type {any} */ (err);
      try {
        await fs.rm(staging, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
      return { ok: false, code: 'E4069', message: `安装失败（已回滚）：${String(e?.message ?? e)}` };
    }
  }

  /* ---------------------------------------------------------------- 收尾 */

  /**
   * 停用并释放所有插件（进程退出时调用）。
   *
   * @returns {Promise<void>}
   */
  async disposeAll() {
    for (const record of this.records.values()) {
      if (!record.runtime) continue;
      const rt = record.runtime;
      record.runtime = null;
      try {
        await rt.dispose();
      } catch {
        /* 退出路径上不抛错 */
      }
    }
  }

  /**
   * 进程退出前的清理：注销全部插件工具 + 释放运行时。
   */
  async shutdown() {
    for (const id of this.records.keys()) removeToolsOfPlugin(id);
    await this.disposeAll();
  }
}
