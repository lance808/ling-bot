/**
 * 插件清单（manifest）解析与校验 —— 插件接口 v1
 *
 * ## 为什么清单要和代码分开
 *
 * 需求是「新增、更新、配置、启停插件都不重编 exe」。要做到这点，
 * 主程序必须在**运行时**知道：这个插件叫什么、有哪些配置项、提供哪些工具。
 * 如果这些信息只写在 `index.mjs` 里，界面就得先执行插件代码才能画表单 ——
 * 那意味着一个坏插件能让插件页整个白屏。
 *
 * 所以：**声明放 plugin.json，行为放 index.mjs**。宿主先只读 JSON，
 * 校验通过后才去 import 代码。清单坏了，插件页仍能显示「清单不合法 + 原因」。
 *
 * ## 为什么校验这么啰嗦
 *
 * 这些值最终会变成：AI 的工具 schema、界面的表单控件、权限判定输入。
 * 一个拼错就静默失效（比如 `needs: "Host"`），而症状是"工具就是不出现在群里"，
 * 极难排查。所以宁可在加载时明确拒绝，也不做宽容猜测。
 *
 * ## 契约
 *
 * 见 `docs/plugin-api.md`。本文件只做**纯校验**，不读磁盘、不 import 代码。
 */

import path from 'node:path';

/** 宿主支持的插件接口主版本。只接受这一个。 */
export const PLUGIN_API_VERSION = '1';

/** 工具对 AI 暴露时的统一前缀（与既有约定一致） */
export const PLUGIN_TOOL_PREFIX = 'plugin_';

/** 清单文件名 */
export const MANIFEST_FILE = 'plugin.json';

/** 配置项类型白名单 */
export const CONFIG_TYPES = Object.freeze(['text', 'textarea', 'password', 'number', 'boolean', 'enum']);

/** 运行时类型 */
export const RUNTIMES = Object.freeze(['process', 'in-process']);

/** 权限声明词汇（仅展示，不参与授权） */
export const PERMISSION_VOCAB = Object.freeze([
  'host.fs',
  'host.net',
  'host.net.loopback',
  'host.exec',
  'qq.read',
  'qq.send',
]);

/** 工具可声明的最高风险；R2/R3 需要宿主显式放行 */
export const MAX_PLUGIN_RISK = 'R1';

/** 单插件限制（防止一个插件把界面/工具面撑爆） */
export const LIMITS = Object.freeze({
  tools: 32,
  config: 40,
  notes: 10,
  description: 500,
  name: 60,
  version: 32,
  author: 80,
  help: 300,
  defaultValue: 8192,
  toolDescription: 1000,
  timeoutMsMax: 120_000,
  timeoutMsDefault: 20_000,
});

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,32}$/;
const CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,20})?$/;

/**
 * 一条校验失败。
 *
 * @param {string} code
 * @param {string} message
 * @param {string} [field] 出问题的字段路径（界面能指出是哪一项）
 * @returns {{ok: false, code: string, message: string, field?: string}}
 */
function fail(code, message, field) {
  return field ? { ok: false, code, message, field } : { ok: false, code, message };
}

/**
 * 校验并规范化清单。
 *
 * 返回的 manifest 是**宿主内部使用**的形状：字段齐全、有默认值，
 * 后续所有模块（管理器、界面、工具注册）都只认这个形状。
 *
 * @param {unknown} raw 从 plugin.json 解析出来的对象
 * @param {{dirName: string}} opts 目录名（必须等于 id）
 * @returns {{ok: true, manifest: object} | {ok: false, code: string, message: string, field?: string}}
 */
export function normalizeManifest(raw, opts) {
  const dirName = opts?.dirName ?? '';

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('E4041', 'plugin.json 必须是一个 JSON 对象');
  }

  // ---- id ----
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_RE.test(id)) {
    return fail('E4041', 'id 非法：小写字母开头，只允许 a-z 0-9 -，2–41 字符', 'id');
  }
  if (dirName && id !== dirName) {
    /*
     * 目录名必须等于 id。
     *
     * 否则会出现"启用 echo，实际加载的是另一个插件"这种无法推理的状态 ——
     * 而且更新/回退都按目录操作，名字对不上时回退会覆盖错的东西。
     */
    return fail('E4041', `插件 id「${id}」与目录名「${dirName}」不一致`, 'id');
  }

  // ---- name / version / description ----
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > LIMITS.name) {
    return fail('E4041', `name 必须是 1–${LIMITS.name} 字符的字符串`, 'name');
  }

  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!VERSION_RE.test(version) || version.length > LIMITS.version) {
    return fail('E4041', 'version 必须是 x.y.z 形式的语义化版本', 'version');
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description || description.length > LIMITS.description) {
    return fail('E4041', `description 必须是 1–${LIMITS.description} 字符`, 'description');
  }

  // ---- apiVersion ----
  const apiVersion = typeof raw.apiVersion === 'string' ? raw.apiVersion.trim() : '';
  if (!apiVersion) {
    return fail('E4061', '缺 apiVersion（当前宿主支持 "1"）', 'apiVersion');
  }
  // 只比较主版本：插件写 "1" 或 "1.2" 都算兼容；"2" 一律拒绝
  const major = apiVersion.split('.')[0];
  if (major !== PLUGIN_API_VERSION) {
    return fail(
      'E4061',
      `接口版本不兼容：插件要求 ${apiVersion}，宿主支持 ${PLUGIN_API_VERSION}`,
      'apiVersion',
    );
  }

  // ---- runtime ----
  const runtime = raw.runtime === undefined ? 'process' : String(raw.runtime);
  if (!RUNTIMES.includes(runtime)) {
    return fail('E4041', `runtime 只能是 ${RUNTIMES.join(' / ')}`, 'runtime');
  }
  const trusted = raw.trusted === true;
  if (runtime === 'in-process' && !trusted) {
    /*
     * 同进程插件没有真正的隔离：它死循环会卡住整个后端。
     * 所以必须显式 trusted: true —— 让"这是第一方代码"成为一个
     * 写下来的决定，而不是某天顺手把 runtime 改掉。
     */
    return fail('E4041', 'runtime 为 in-process 时必须显式写 trusted: true（仅限随包内置的第一方插件）', 'trusted');
  }

  // ---- entry ----
  const entry = raw.entry === undefined ? 'index.mjs' : String(raw.entry);
  if (!isSafeRelative(entry)) {
    return fail('E4041', 'entry 必须是插件包内的相对路径，且不能包含 ..', 'entry');
  }

  // ---- permissions ----
  const permissions = [];
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions)) {
      return fail('E4041', 'permissions 必须是字符串数组', 'permissions');
    }
    for (const p of raw.permissions) {
      if (typeof p !== 'string' || p.length > 40) {
        return fail('E4041', 'permissions 里有非字符串项', 'permissions');
      }
      // 不认识的词汇不拒绝：将来宿主扩展词汇表时旧版本仍能加载
      if (!permissions.includes(p)) permissions.push(p);
    }
  }

  // ---- config ----
  const cfg = normalizeConfigDecl(raw.config);
  if (!cfg.ok) return cfg;

  // ---- tools ----
  const tools = normalizeToolDecl(raw.tools);
  if (!tools.ok) return tools;

  // 至少要提供点什么，否则这个插件没有任何可观测的效果
  if (tools.tools.length === 0 && raw.handleMessage !== true) {
    /*
     * 允许「纯通道插件」（只接管消息、不提供工具）—— 但要显式声明。
     * 不声明又没有工具，多半是作者忘了写 tools，早点报出来比静默好。
     */
    return fail('E4041', '插件既没有声明 tools，也没有声明 handleMessage: true（纯通道插件需显式声明）', 'tools');
  }

  // ---- notes ----
  const notes = [];
  if (raw.notes !== undefined) {
    if (!Array.isArray(raw.notes)) return fail('E4041', 'notes 必须是数组', 'notes');
    if (raw.notes.length > LIMITS.notes) return fail('E4041', `notes 最多 ${LIMITS.notes} 组`, 'notes');
    for (const n of raw.notes) {
      if (!n || typeof n !== 'object') return fail('E4041', 'notes 的每一项必须是对象', 'notes');
      const title = typeof n.title === 'string' ? n.title.trim().slice(0, 80) : '';
      const lines = Array.isArray(n.lines) ? n.lines.filter((l) => typeof l === 'string').slice(0, 30) : [];
      if (!title && lines.length === 0) continue;
      notes.push({ title, lines: lines.map((l) => String(l).slice(0, 400)) });
    }
  }

  // ---- ui（预留边界）----
  const ui = normalizeUiDecl(raw.ui);

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      apiVersion,
      description,
      author: typeof raw.author === 'string' ? raw.author.trim().slice(0, LIMITS.author) : '',
      runtime,
      trusted,
      entry,
      permissions,
      config: cfg.config,
      tools: tools.tools,
      /** 是否声明了消息接管（只有 in-process 会真正收到消息） */
      handleMessage: raw.handleMessage === true,
      notes,
      ui,
      /** 清单里未识别的顶层键（向前兼容：只记录，不报错） */
      unknownKeys: Object.keys(raw).filter(
        (k) =>
          ![
            'id', 'name', 'version', 'apiVersion', 'description', 'author', 'runtime', 'trusted',
            'entry', 'permissions', 'config', 'tools', 'handleMessage', 'notes', 'ui',
          ].includes(k),
      ),
    },
  };
}

/**
 * 相对路径安全检查。
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeRelative(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split(/[\\/]+/);
  return parts.every((p) => p !== '..' && p !== '');
}

/**
 * 校验配置项声明。
 *
 * @param {unknown} raw
 * @returns {{ok: true, config: object[]} | {ok: false, code: string, message: string, field?: string}}
 */
export function normalizeConfigDecl(raw) {
  if (raw === undefined) return { ok: true, config: [] };
  if (!Array.isArray(raw)) return fail('E4041', 'config 必须是数组', 'config');
  if (raw.length > LIMITS.config) return fail('E4041', `config 最多 ${LIMITS.config} 项`, 'config');

  /** @type {object[]} */
  const out = [];
  const seen = new Set();

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail('E4041', 'config 的每一项必须是对象', 'config');
    }
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!CONFIG_KEY_RE.test(key)) {
      return fail('E4041', `配置项 key 非法：${String(item.key)}`, 'config');
    }
    if (seen.has(key)) return fail('E4041', `配置项 key 重复：${key}`, `config.${key}`);
    seen.add(key);

    const type = item.type === undefined ? 'text' : String(item.type);
    if (!CONFIG_TYPES.includes(type)) {
      return fail('E4041', `配置项 ${key} 的 type 只能是 ${CONFIG_TYPES.join(' / ')}`, `config.${key}`);
    }

    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : key;
    // password 隐含 secret：不允许"密码框但明文落盘"这种组合
    const secret = type === 'password' ? true : item.secret === true;
    const required = item.required === true;
    const help = typeof item.help === 'string' ? item.help.slice(0, LIMITS.help) : '';
    const placeholder = typeof item.placeholder === 'string' ? item.placeholder.slice(0, 120) : '';

    /** @type {object} */
    const spec = {
      key,
      label,
      type,
      secret,
      required,
      help,
      placeholder,
      default: undefined,
      options: undefined,
      min: undefined,
      max: undefined,
      maxLength: undefined,
      integer: undefined,
      pattern: undefined,
      generate: undefined,
    };

    // ---- 类型专属规则 ----
    if (type === 'text' || type === 'textarea' || type === 'password') {
      const defMax = type === 'textarea' ? 8000 : 512;
      const maxLength = item.maxLength === undefined ? defMax : Number(item.maxLength);
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 65535) {
        return fail('E4041', `配置项 ${key} 的 maxLength 必须是 1–65535 的整数`, `config.${key}`);
      }
      spec.maxLength = maxLength;

      if (item.pattern !== undefined) {
        if (typeof item.pattern !== 'string' || item.pattern.length > 200) {
          return fail('E4041', `配置项 ${key} 的 pattern 必须是字符串`, `config.${key}`);
        }
        try {
          // 锚定：作者写 \d+ 时应校验整个值，而不是"包含数字"
          new RegExp(`^(?:${item.pattern})$`);
        } catch (err) {
          return fail('E4041', `配置项 ${key} 的 pattern 不是合法正则：${String(/** @type {any} */ (err)?.message ?? err)}`, `config.${key}`);
        }
        spec.pattern = item.pattern;
      }

      if (item.generate !== undefined) {
        if (item.generate !== 'token') {
          return fail('E4041', `配置项 ${key} 的 generate 目前只支持 "token"`, `config.${key}`);
        }
        spec.generate = 'token';
      }

      if (item.default !== undefined) {
        if (typeof item.default !== 'string' || item.default.length > maxLength) {
          return fail('E4041', `配置项 ${key} 的默认值必须是长度不超过 ${maxLength} 的字符串`, `config.${key}`);
        }
        // 密钥不设默认值：否则每个用户的令牌都一样，等于没有
        if (secret) return fail('E4041', `配置项 ${key} 是敏感字段，不允许写默认值`, `config.${key}`);
        spec.default = item.default;
      }
    } else if (type === 'number') {
      const min = item.min === undefined ? undefined : Number(item.min);
      const max = item.max === undefined ? undefined : Number(item.max);
      if (min !== undefined && !Number.isFinite(min)) return fail('E4041', `配置项 ${key} 的 min 非法`, `config.${key}`);
      if (max !== undefined && !Number.isFinite(max)) return fail('E4041', `配置项 ${key} 的 max 非法`, `config.${key}`);
      if (min !== undefined && max !== undefined && min > max) {
        return fail('E4041', `配置项 ${key} 的 min 大于 max`, `config.${key}`);
      }
      spec.min = min;
      spec.max = max;
      spec.integer = item.integer === true;
      if (item.default !== undefined) {
        const d = Number(item.default);
        if (!Number.isFinite(d)) return fail('E4041', `配置项 ${key} 的默认值必须是数字`, `config.${key}`);
        if (spec.integer && !Number.isInteger(d)) return fail('E4041', `配置项 ${key} 的默认值必须是整数`, `config.${key}`);
        spec.default = d;
      }
    } else if (type === 'boolean') {
      if (item.default !== undefined && typeof item.default !== 'boolean') {
        return fail('E4041', `配置项 ${key} 的默认值必须是布尔值`, `config.${key}`);
      }
      spec.default = item.default === true;
    } else if (type === 'enum') {
      const opts = normalizeEnumOptions(item.options, key);
      if (!opts.ok) return opts;
      spec.options = opts.options;
      const first = opts.options[0]?.value;
      if (item.default !== undefined) {
        const d = String(item.default);
        if (!opts.options.some((o) => o.value === d)) {
          return fail('E4041', `配置项 ${key} 的默认值不在枚举里`, `config.${key}`);
        }
        spec.default = d;
      } else {
        spec.default = first;
      }
    }

    out.push(spec);
  }

  return { ok: true, config: out };
}

/**
 * 枚举选项规范化：既接受字符串数组，也接受 {value,label} 数组。
 *
 * @param {unknown} raw
 * @param {string} key
 * @returns {{ok: true, options: {value: string, label: string}[]} | {ok: false, code: string, message: string, field?: string}}
 */
function normalizeEnumOptions(raw, key) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    return fail('E4041', `配置项 ${key} 是 enum，必须给 1–50 个 options`, `config.${key}`);
  }
  /** @type {{value: string, label: string}[]} */
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    let value;
    let label;
    if (typeof o === 'string') {
      value = o;
      label = o;
    } else if (o && typeof o === 'object' && typeof (/** @type {any} */ (o).value) === 'string') {
      value = /** @type {any} */ (o).value;
      label = typeof (/** @type {any} */ (o).label) === 'string' ? /** @type {any} */ (o).label : value;
    } else {
      return fail('E4041', `配置项 ${key} 的 options 项必须是字符串或 {value,label}`, `config.${key}`);
    }
    if (value.length === 0 || value.length > 80) {
      return fail('E4041', `配置项 ${key} 的选项值长度非法`, `config.${key}`);
    }
    if (seen.has(value)) return fail('E4041', `配置项 ${key} 的选项值重复：${value}`, `config.${key}`);
    seen.add(value);
    out.push({ value, label: label.slice(0, 80) });
  }
  return { ok: true, options: out };
}

/**
 * 校验工具声明。
 *
 * 注意：这里**不接受** `origins` / `confirm` —— 由宿主按 needs/risk 推导。
 * 也不接受 `run`：执行逻辑在入口模块的 callTool 里，清单只描述形状。
 *
 * @param {unknown} raw
 * @returns {{ok: true, tools: object[]} | {ok: false, code: string, message: string, field?: string}}
 */
export function normalizeToolDecl(raw) {
  if (raw === undefined) return { ok: true, tools: [] };
  if (!Array.isArray(raw)) return fail('E4041', 'tools 必须是数组', 'tools');
  if (raw.length > LIMITS.tools) return fail('E4041', `tools 最多 ${LIMITS.tools} 个`, 'tools');

  /** @type {object[]} */
  const out = [];
  const seen = new Set();

  for (const t of raw) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return fail('E4041', 'tools 的每一项必须是对象', 'tools');
    }
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (!TOOL_NAME_RE.test(name)) {
      return fail('E4041', `工具名非法：${String(t.name)}（小写字母开头，2–33 字符，只允许 a-z 0-9 _）`, 'tools');
    }
    if (seen.has(name)) return fail('E4041', `同一插件里工具名重复：${name}`, `tools.${name}`);
    seen.add(name);

    const description = typeof t.description === 'string' ? t.description.trim() : '';
    if (!description || description.length > LIMITS.toolDescription) {
      // 描述是模型判断"该不该调它"的唯一依据，不能空
      return fail('E4041', `工具 ${name} 的 description 必须是 1–${LIMITS.toolDescription} 字符`, `tools.${name}`);
    }

    const needs = t.needs === undefined ? 'qq' : String(t.needs);
    if (needs !== 'host' && needs !== 'qq') {
      return fail('E4041', `工具 ${name} 的 needs 只能是 host 或 qq`, `tools.${name}`);
    }

    const risk = t.risk === undefined ? 'R0' : String(t.risk);
    if (!['R0', 'R1', 'R2', 'R3'].includes(risk)) {
      return fail('E4041', `工具 ${name} 的 risk 非法：${risk}`, `tools.${name}`);
    }

    const params = normalizeParams(t.params, name);
    if (!params.ok) return params;

    let timeoutMs = t.timeoutMs === undefined ? LIMITS.timeoutMsDefault : Number(t.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > LIMITS.timeoutMsMax) {
      return fail('E4041', `工具 ${name} 的 timeoutMs 必须是 100–${LIMITS.timeoutMsMax} 的毫秒数`, `tools.${name}`);
    }
    timeoutMs = Math.floor(timeoutMs);

    out.push({
      name,
      fullName: PLUGIN_TOOL_PREFIX + name,
      description,
      needs,
      risk,
      timeoutMs,
      params: params.params,
    });
  }

  return { ok: true, tools: out };
}

/**
 * 校验工具参数 schema（与内置工具的 params 形状一致）。
 *
 * @param {unknown} raw
 * @param {string} toolName
 * @returns {{ok: true, params: object} | {ok: false, code: string, message: string, field?: string}}
 */
function normalizeParams(raw, toolName) {
  if (raw === undefined) return { ok: true, params: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('E4041', `工具 ${toolName} 的 params 必须是对象`, `tools.${toolName}`);
  }
  const keys = Object.keys(raw);
  if (keys.length > 30) return fail('E4041', `工具 ${toolName} 的参数最多 30 个`, `tools.${toolName}`);

  /** @type {Record<string, any>} */
  const out = {};
  for (const [pname, spec] of Object.entries(raw)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(pname)) {
      return fail('E4041', `工具 ${toolName} 的参数名非法：${pname}`, `tools.${toolName}`);
    }
    if (!spec || typeof spec !== 'object') {
      return fail('E4041', `工具 ${toolName} 的参数 ${pname} 声明必须是对象`, `tools.${toolName}`);
    }
    const s = /** @type {any} */ (spec);
    const type = String(s.type ?? '');
    if (!['string', 'number', 'boolean', 'array'].includes(type)) {
      return fail('E4041', `工具 ${toolName} 的参数 ${pname} 类型不受支持：${type || '(空)'}`, `tools.${toolName}`);
    }
    /** @type {Record<string, any>} */
    const built = { type };
    if (s.description !== undefined) built.description = String(s.description).slice(0, 300);
    if (s.required === true) built.required = true;
    if (type === 'string') {
      if (s.maxLength !== undefined) {
        const n = Number(s.maxLength);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return fail('E4041', `工具 ${toolName} 的参数 ${pname} 的 maxLength 非法`, `tools.${toolName}`);
        }
        built.maxLength = n;
      }
      if (s.enum !== undefined) {
        if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some((v) => typeof v !== 'string')) {
          return fail('E4041', `工具 ${toolName} 的参数 ${pname} 的 enum 必须是字符串数组`, `tools.${toolName}`);
        }
        built.enum = s.enum.slice(0, 50);
      }
    }
    if (type === 'array') {
      if (s.maxItems !== undefined) {
        const n = Number(s.maxItems);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          return fail('E4041', `工具 ${toolName} 的参数 ${pname} 的 maxItems 非法`, `tools.${toolName}`);
        }
        built.maxItems = n;
      }
      if (s.items !== undefined) {
        if (!s.items || typeof s.items !== 'object' || !['string', 'number', 'boolean'].includes(String(s.items.type))) {
          return fail('E4041', `工具 ${toolName} 的参数 ${pname} 的 items.type 非法`, `tools.${toolName}`);
        }
        built.items = { type: String(s.items.type) };
      }
    }
    out[pname] = built;
  }
  return { ok: true, params: out };
}

/**
 * 校验专用页面声明。
 *
 * 当前宿主**不开放**渲染（见 docs/plugin-api.md §8），但仍然校验形状并
 * 原样带进快照 —— 这样将来开放时，插件包不用改，宿主只需补一条资源通道。
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeUiDecl(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = /** @type {any} */ (raw);
  if (typeof r.page !== 'string' || !isSafeRelative(r.page)) return null;
  return {
    page: r.page,
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 40) : '',
    sidebar: r.sidebar === true,
    /** 固定 false：界面资源随 exe 内嵌，暂不支持从磁盘加载任意 ESM */
    available: false,
    reason: '当前版本不支持从磁盘加载插件页面（界面资源随主程序内嵌），请用自动配置表单管理',
  };
}

/**
 * 由 needs/risk 推导工具在宿主里的权限形状。
 *
 * **这是唯一决定权限的地方**：插件在清单里写 origins/confirm 一律无效。
 *
 * @param {{needs: string, risk: string}} tool
 * @returns {{kind: string, origins: string[], risk: string, confirm: string}}
 */
export function deriveToolPolicy(tool) {
  // needs 决定"这个工具能出现在哪些回合"
  //   host = 需要动本机：只给主人私聊（+ 桌面端本人操作）
  //   qq   = 只动 QQ：主人私聊 + 主人所在群（+ 桌面端）
  //
  // CONSOLE 与内置工具保持一致：桌面端就是用户本人坐在电脑前，
  // 不给它反而会出现"界面里手动试工具却报没权限"的怪事。
  const origins =
    tool.needs === 'host'
      ? ['owner-private', 'console']
      : ['owner-private', 'owner-group', 'console'];

  return {
    kind: tool.needs === 'host' ? 'host' : 'qq',
    origins,
    risk: tool.risk,
    // R0 自动执行，其余一律要人点头（与内置工具同一套规则）
    confirm: tool.risk === 'R0' ? 'never' : 'always',
  };
}

/**
 * 是否允许这个风险档进入工具面。
 *
 * @param {string} risk
 * @param {boolean} allowDangerous
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function checkRiskAllowed(risk, allowDangerous) {
  if (risk === 'R0' || risk === MAX_PLUGIN_RISK) return { ok: true };
  if (allowDangerous === true) return { ok: true };
  return {
    ok: false,
    code: 'E4042',
    message: `工具声明了 ${risk}，但插件高风险未放行（config.plugins.allowDangerous）`,
  };
}

/**
 * 生成一个随机令牌（32 字节 → 43 字符 base64url）。
 *
 * 放在宿主侧而不是只放界面：插件作者不该为了"生成一个令牌"再写一遍代码。
 *
 * @returns {string}
 */
export function mintToken() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 插件目录在磁盘上的路径（纯计算，用于展示与安全检查）。
 *
 * @param {string} pluginsDir
 * @param {string} id
 * @returns {string}
 */
export function pluginDirOf(pluginsDir, id) {
  return path.join(pluginsDir, id);
}

/**
 * 插件运行数据目录。
 *
 * 与插件代码分开：升级插件会整体替换 `plugins/<id>/`，
 * 而运行数据必须活下来，否则每次更新都丢缓存。
 *
 * @param {string} root 用户数据根目录
 * @param {string} id
 * @returns {string}
 */
export function pluginDataDirOf(root, id) {
  return path.join(root, 'plugin-data', id);
}
