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

import { EFFECTS, normalizeEffects, riskFloorOf, maxRisk } from './effects.mjs';

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

/**
 * 保留参数名：插件不得在 `params` 里声明这些。
 *
 * ## 为什么必须是硬拒绝
 *
 * 这些名字是宿主传给插件的**上下文**字段（caller / convKey / origin / signal…）。
 * 如果清单能声明一个 `origin` 参数，就会出现两种坏情况：
 *
 *   1. 模型看得见一个叫 origin 的参数，会试图填它（"帮我把 origin 设成
 *      owner-private"）—— 而它其实不生效，模型会反复试；
 *   2. 将来有人"顺手"把它接进 ctx，提权就完成了，而且代码看起来完全正常。
 *
 * 所以在最前面（清单校验）就拒绝，比事后靠"记得别接"可靠得多。
 */
export const RESERVED_PARAM_NAMES = Object.freeze([
  'origin',
  'convKey',
  'caller',
  'signal',
  'invocation',
  'ctx',
  'plugin',
  'args',
  'tool',
]);

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

  /*
   * 插件自审（approval: "plugin"）的准入条件。
   *
   * 为什么必须在这里校验而不是插件自己说了算：
   * 跳过宿主通用确认是一个**减档**动作。允许任意插件声明它，等于把
   * "先弹确认"这条防线交给插件作者的选择。所以限定第一方 in-process
   * 插件，并且要求它确实声明了收费行为（paid）—— 一个不收费的工具
   * 根本没有"这次要不要花钱"这种需要专门审批的东西。
   */
  for (const t of tools.tools) {
    if (t.approval !== 'plugin') continue;
    if (runtime !== 'in-process' || !trusted) {
      return fail(
        'E4041',
        `工具 ${t.name} 声明了 approval: "plugin"，但只有 in-process + trusted: true 的第一方插件可以自行审批`,
        `tools.${t.name}`,
      );
    }
    if (!t.effects.includes('paid')) {
      return fail(
        'E4041',
        `工具 ${t.name} 声明了 approval: "plugin"，但没有 effects: ["paid"]；插件自审只用于收费操作`,
        `tools.${t.name}`,
      );
    }
  }

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

  /*
   * ---- messagePriority（可选，默认 normal）----
   *
   * ## 它解决的是"两个插件抢同一条消息"
   *
   * 原来 `dispatchMessage` 按 `records` 的插入顺序遍历 —— 而插入顺序
   * 来自磁盘目录扫描顺序。于是"谁先拿到消息"取决于文件名排序，
   * 那不是一条可以推理的规则：装了一个新插件，可能把 dsh-bridge 的
   * 审批回复抢走，而症状是"审批有时候没反应"，且换台机器就不复现。
   *
   * 所以把"我得在这条消息上排后面"变成清单里的一个**写下来的决定**：
   * 归属明确的接管者（审批、确认）用默认的 normal；
   * 兜底类/娱乐类接管者（自动回答、关键词、签到）声明 low。
   *
   * ## 为什么只给 in-process 插件
   *
   * `process` 插件根本收不到消息（见 docs/plugin-api.md §5.5）。
   * 允许它声明这个字段，只会让人以为自己配了优先级、实际什么都没发生 ——
   * 那种"配了没反应"的假开关比不给还糟。所以直接 E4041。
   */
  const messagePriority = raw.messagePriority === undefined ? 'normal' : String(raw.messagePriority);
  if (messagePriority !== 'normal' && messagePriority !== 'low') {
    return fail('E4041', 'messagePriority 只能是 "normal" 或 "low"', 'messagePriority');
  }
  if (messagePriority === 'low') {
    if (runtime !== 'in-process') {
      return fail(
        'E4041',
        'messagePriority: "low" 只对 in-process 插件有效：process 插件收不到消息，声明它不会有任何效果',
        'messagePriority',
      );
    }
    if (raw.handleMessage !== true) {
      return fail(
        'E4041',
        '声明 messagePriority: "low" 前必须先声明 handleMessage: true（否则这个字段没有作用对象）',
        'messagePriority',
      );
    }
  }

  /*
   * ---- validateConfig（可选，默认 false）----
   *
   * ## 它解决的是"保存成功但跑不起来"
   *
   * 配置里可以放一段 JSON、一段正则、一组编号。这些值能通过
   * 类型校验（都是字符串），但语义上可能是坏的。等 init 才报错时，
   * 用户看到的是两件事：刚才"保存成功"，现在"初始化失败" ——
   * 中间那层因果关系在界面上看不见。
   *
   * 声明它之后，宿主在**写盘之前**问插件"这套配置能用吗"。
   * 失败就不落盘，用户改的还是改之前那份好配置。
   *
   * ## 为什么只给 in-process + trusted
   *
   * `process` 运行时要跨进程问一次结论，而保存是个同步语义的操作
   * （用户点保存，要么存了要么没存）。如果为了保存单独起一个子进程，
   * 那条路径自己就会因为超时/崩溃变成新的不确定来源。
   *
   * 所以只对第一方 in-process 插件开放 —— 这类插件的校验是纯计算，
   * 毫秒级、不联网，失败模式也只有"抛异常"一种。
   */
  const validateConfig = raw.validateConfig === true;
  if (raw.validateConfig !== undefined && typeof raw.validateConfig !== 'boolean') {
    return fail('E4041', 'validateConfig 必须是布尔值', 'validateConfig');
  }
  if (validateConfig) {
    if (runtime !== 'in-process') {
      return fail(
        'E4041',
        'validateConfig: true 只对 in-process 插件有效：process 运行时无法在保存时同步给出结论',
        'validateConfig',
      );
    }
    if (!trusted) {
      return fail('E4041', 'validateConfig: true 要求 trusted: true（仅限随包内置的第一方插件）', 'validateConfig');
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
      /** 消息派发优先级：normal（默认，先跑）/ low（后跑）。见 docs/plugin-api.md §2.7 */
      messagePriority,
      /**
       * 是否在保存配置前请求插件自校验。
       * 为 true 时宿主会调用入口的 `validateConfig(config)`。见 §2.8
       */
      validateConfig,
      notes,
      ui,
      /** 清单里未识别的顶层键（向前兼容：只记录，不报错） */
      unknownKeys: Object.keys(raw).filter(
        (k) =>
          ![
            'id', 'name', 'version', 'apiVersion', 'description', 'author', 'runtime', 'trusted',
            'entry', 'permissions', 'config', 'tools', 'handleMessage', 'notes', 'ui',
            'messagePriority', 'validateConfig',
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

    /*
     * effects：行为分类（见 effects.mjs 的文件头）。
     *
     * 作者声明的是"我需要做什么"，宿主据此推导**风险下限**：
     *   effects: ['chat.send'] + risk: 'R0'  →  实际按 R1 处理
     *
     * 这一条是这次改造的重点之一：不能让"我想自动执行"变成
     * "把发消息声明成只读无害"。
     */
    const eff = normalizeEffects(t.effects);
    if (!eff.ok) {
      return fail(eff.code, `工具 ${name} 的 ${eff.message}`, `tools.${name}`);
    }
    const floor = riskFloorOf(eff.effects);
    const effectiveRisk = maxRisk(risk, floor);

    /*
     * approval：谁来做"这一次要不要花钱"的人工确认。
     *
     * 默认（缺省）由宿主弹通用确认卡。`"plugin"` 表示**插件自己**已经有一条
     * 比通用卡片更具体的审批链路（例如：私信管理员、引用回复 1/2）。
     * 声明它之后宿主不再弹通用卡 —— 否则一次生图会先出现"是否调用工具"，
     * 管理员点同意之后又出现"是否同意生图"，两次确认里只要有一次被无脑点掉，
     * 就等于没有确认。
     *
     * 条件在 normalizeManifest 里校验（那里才知道 runtime/trusted）：
     *   · 仅 in-process + trusted 的第一方插件可用；
     *   · 工具必须声明 effects: ["paid"]（收费）；
     *   · 插件仍要自己保证审批不通过就不执行收费请求。
     * 这**不是**把工具伪装成无副作用：risk/effects 照旧生效、照旧展示。
     */
    const approval = t.approval === undefined ? 'host' : String(t.approval);
    if (approval !== 'host' && approval !== 'plugin') {
      return fail('E4041', `工具 ${name} 的 approval 只能是 "host" 或 "plugin"`, `tools.${name}`);
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
      /** effects 推导后的**生效风险**（授权与确认都按它走） */
      effectiveRisk,
      effects: eff.effects,
      /** "host"（默认）或 "plugin"（插件自行审批，见上方说明） */
      approval,
      timeoutMs,
      params: params.params,
    });
  }

  return { ok: true, tools: out };
}

/**
 * 工具参数的标量/容器类型。
 *
 * `object` 与「array 的 items 是 object」是给这类工具用的：一次传一批结构化
 * 记录（课程表、待办、账单），每个元素有固定的几个字段。没有它，插件只能
 * 收一个 JSON 字符串（模型经常转义错、也拿不到字段级校验），或者为每个字段
 * 声明一个顶层参数（`name1` / `name2` …那种谁都不想维护的东西）。
 */
const PARAM_TYPES = Object.freeze(['string', 'number', 'boolean', 'array', 'object']);

/**
 * 参数的 object 嵌套深度上限（含 array 元素里的 object）。
 *
 * 为什么要有：schema 是**递归**的，一个手写错的清单（A.properties.b 是 A）
 * 会让构造 / 校验无限递归，直接爆栈——那属于"清单坏了却把加载器搞崩"。
 * 深度从顶层参数里的第一个 object 算 1 层，最多 3 层。
 * course-schedule 的 `courses: array<object>` 是 1 层，patch 也是 1 层。
 */
const MAX_PARAM_OBJECT_DEPTH = 3;

/** 单个 object 参数最多声明多少个属性（与顶层参数上限一致） */
const MAX_PARAM_PROPERTIES = 30;

/** 参数名 / 对象属性名的形状（顶层与嵌套同一口径） */
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

/**
 * 递归校验并规范化**一个**参数声明。
 *
 * 返回的 `built` 是宿主内部使用的形状，`tool-gate.toJsonSchema` 与
 * `validateParams` 都只认它。已有的标量分支必须与改造前逐字段一致：
 * 旧清单（没有 object/对象数组）经过这里必须得到完全相同的输出。
 *
 * @param {any} s 清单里的参数声明
 * @param {string} path 字段路径（出错时点名用，如 `courses[].weekday`）
 * @param {number} objectDepth 已经进入的 object 层数
 * @returns {{ok: true, spec: Record<string, any>} | {ok: false, code: string, message: string, field?: string}}
 */
function normalizeParamSpec(s, path, objectDepth) {
  if (!s || typeof s !== 'object') {
    return fail('E4041', `${path} 声明必须是对象`, path);
  }
  const type = String(s.type ?? '');
  if (!PARAM_TYPES.includes(type)) {
    return fail('E4041', `${path} 类型不受支持：${type || '(空)'}`, path);
  }

  /** @type {Record<string, any>} */
  const built = { type };
  if (s.description !== undefined) built.description = String(s.description).slice(0, 300);
  if (s.required === true) built.required = true;

  if (type === 'string') {
    if (s.maxLength !== undefined) {
      const n = Number(s.maxLength);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return fail('E4041', `${path} 的 maxLength 非法`, path);
      }
      built.maxLength = n;
    }
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some((v) => typeof v !== 'string')) {
        return fail('E4041', `${path} 的 enum 必须是字符串数组`, path);
      }
      built.enum = s.enum.slice(0, 50);
    }
  }

  if (type === 'array') {
    if (s.maxItems !== undefined) {
      const n = Number(s.maxItems);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        return fail('E4041', `${path} 的 maxItems 非法`, path);
      }
      built.maxItems = n;
    }
    if (s.items !== undefined) {
      if (!s.items || typeof s.items !== 'object' || Array.isArray(s.items)) {
        return fail('E4041', `${path} 的 items 声明必须是对象`, path);
      }
      const itemType = String(s.items.type ?? '');
      if (itemType === 'object') {
        /*
         * 对象元素。`items.required` 只能是**子属性必填数组**：元素本身没有
         * "必填/不必填"这个维度（有没有元素由调用方决定、由长度上限兜住）。
         * 写成布尔值直接拒绝 —— 静默忽略会让作者以为"哦，元素是必填的"，
         * 而实际什么都没发生。
         */
        const itemSpec = { ...s.items };
        if (typeof itemSpec.required === 'boolean') {
          return fail('E4041', `${path} 的 items.required 必须是字符串数组（子属性必填）`, `${path}[]`);
        }
        const one = normalizeParamSpec(itemSpec, `${path}[]`, objectDepth);
        if (!one.ok) return one;
        built.items = one.spec;
      } else if (['string', 'number', 'boolean'].includes(itemType)) {
        // 标量元素：与改造前完全一致（只保留 type）
        built.items = { type: itemType };
      } else {
        return fail('E4041', `${path} 的 items.type 非法`, path);
      }
    }
  }

  if (type === 'object') {
    const depth = objectDepth + 1;
    if (depth > MAX_PARAM_OBJECT_DEPTH) {
      return fail(
        'E4041',
        `${path} 的对象嵌套超过 ${MAX_PARAM_OBJECT_DEPTH} 层（字段路径：${path}）`,
        path,
      );
    }
    const subs = s.properties === undefined ? {} : s.properties;
    if (!subs || typeof subs !== 'object' || Array.isArray(subs)) {
      return fail('E4041', `${path} 的 properties 必须是对象`, path);
    }
    const keys = Object.keys(subs);
    if (keys.length > MAX_PARAM_PROPERTIES) {
      return fail('E4041', `${path} 的 properties 最多 ${MAX_PARAM_PROPERTIES} 个`, path);
    }

    /** @type {Record<string, any>} */
    const props = {};
    for (const [pname, sub] of Object.entries(subs)) {
      if (!PARAM_NAME_RE.test(pname)) {
        return fail('E4041', `${path} 的属性名非法：${pname}`, `${path}.${pname}`);
      }
      /*
       * 嵌套属性**不做**保留字检查：RESERVED_PARAM_NAMES 防的是"宿主上下文
       * 被模型从参数里塞进来"，而那只有顶层参数会进入 ctx。嵌套属性只是
       * 塞进插件自己的对象里，没有那条注入路径。但名字格式仍然校验，
       * 否则界面和日志里会出现没法引用的键。
       */
      const one = normalizeParamSpec(sub, `${path}.${pname}`, depth);
      if (!one.ok) return one;
      props[pname] = one.spec;
    }
    built.properties = props;

    /*
     * `required` 在这里有两种含义，必须区分开：
     *   · `required: true`（布尔）→ 这个参数**本身**必填（上面已处理，
     *     存放在 `built.required`）；
     *   · `required: ["a","b"]`（字符串数组）→ 对象里哪几个**属性**必填。
     *
     * 数组形式在归一化阶段就**落到子属性的 `required: true` 上**，而不是
     * 另存一份"父对象上的必填名单"。两份数据会漂移：只更新一份之后，
     * 模型看到的 schema 与执行层的校验就会给出不同结论，而这种 bug
     * 只会在"必填字段恰好缺失"时暴露。落下之后，`toJsonSchema` 与
     * `validateParams` 都只认子属性自己的 required，跟普通参数一条路径。
     *
     * 写了数组却引用未声明的属性 = 清单错误：那种"必填一个不存在的字段"
     * 永远无法满足，工具会稳定失败，而报错信息看起来像是模型没填。
     */
    if (Array.isArray(s.required)) {
      for (const name of s.required) {
        if (typeof name !== 'string') {
          return fail('E4041', `${path} 的 required 必须是字符串数组`, path);
        }
        if (!Object.prototype.hasOwnProperty.call(props, name)) {
          return fail('E4041', `${path} 的 required 里有未声明的属性：${name}`, `${path}.${name}`);
        }
        props[name].required = true;
      }
    } else if (s.required !== undefined && typeof s.required !== 'boolean') {
      return fail('E4041', `${path} 的 required 必须是布尔值或字符串数组`, path);
    }
  }

  return { ok: true, spec: built };
}

/**
 * 校验工具参数 schema（与内置工具的 params 形状一致）。
 *
 * 支持 `string` / `number` / `boolean` / `array` / `object`，其中
 * `object` 的 `properties` 递归、`array` 的 `items` 可以是标量或对象。
 * 原有的标量行为逐字段不变。
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
    if (!PARAM_NAME_RE.test(pname)) {
      return fail('E4041', `工具 ${toolName} 的参数名非法：${pname}`, `tools.${toolName}`);
    }
    if (RESERVED_PARAM_NAMES.includes(pname)) {
      /*
       * 保留名硬拒。理由见 RESERVED_PARAM_NAMES 的注释：
       * 这些是宿主注入的上下文，模型绝不能看到、更不能填。
       */
      return fail(
        'E4041',
        `工具 ${toolName} 的参数名 ${pname} 是保留字（${RESERVED_PARAM_NAMES.join(' / ')}），宿主会把上下文直接交给插件，不需要也不允许通过参数传递`,
        `tools.${toolName}`,
      );
    }
    if (!spec || typeof spec !== 'object') {
      return fail('E4041', `工具 ${toolName} 的参数 ${pname} 声明必须是对象`, `tools.${toolName}`);
    }
    const one = normalizeParamSpec(spec, `工具 ${toolName} 的参数 ${pname}`, 0);
    if (!one.ok) {
      return { ...one, field: `tools.${toolName}.params.${pname}` };
    }
    out[pname] = one.spec;
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
 * 由 needs/risk/effects 推导工具在宿主里的权限形状。
 *
 * **这是唯一决定权限的地方**：插件在清单里写 origins/confirm 一律无效。
 *
 * ## 为什么 qq 类工具的 origins 里现在有 group / proactive
 *
 * 改造前这里写的是 `['owner-private','owner-group','console']` ——
 * 也就是说**普通群友和主动回合根本不在候选集里**，"授权给群"这件事
 * 无论怎么配都不可能生效。
 *
 * 现在改成"候选集放宽、实际可见性由管理员配置决定"：
 *
 *   · origins 回答「这个工具**最多**能去哪」（qq 类含 group/proactive，
 *     host 类不含 —— 有宿主机能力的工具永远不进群）；
 *   · `plugins.chatTools` 回答「管理员**实际**放开了哪一档」。
 *
 * 两者是**与**，所以默认（chatTools 全关）等价于改造前的行为，
 * 而管理员点名之后 group / proactive 才真正生效。
 *
 * 为什么不能只靠 chatTools 而不动 origins：`isToolGranted` 的第一步就是
 * "origin 在不在 origins 里"。少了这一环，后面的授权判定根本走不到。
 *
 * @param {{needs: string, risk: string, effectiveRisk?: string, effects?: string[], approval?: string}} tool
 * @returns {{kind: string, origins: string[], risk: string, confirm: string, approval: string}}
 */
export function deriveToolPolicy(tool) {
  // needs 决定"这个工具能出现在哪些回合"
  //   host = 需要动本机：只给主人私聊（+ 桌面端本人操作）
  //   qq   = 只动 QQ：主人私聊 + 主人所在群 + **普通群聊/陌生人私聊/主动回合**
  //          （后三者还要过 plugins.chatTools 这一关，默认关闭）
  //
  // CONSOLE 与内置工具保持一致：桌面端就是用户本人坐在电脑前，
  // 不给它反而会出现"界面里手动试工具却报没权限"的怪事。
  const origins =
    tool.needs === 'host'
      ? ['owner-private', 'console']
      : ['owner-private', 'owner-group', 'group', 'proactive', 'console'];

  /*
   * 风险取 effects 推导后的生效值。
   *
   * 注意这里**不能**回落到声明值：`effects: ['exec']` 而 risk 写 R0 时，
   * 按声明走会让一个能执行命令的工具被当成"只读无害"自动执行。
   */
  const risk = tool.effectiveRisk ?? tool.risk;

  return {
    kind: tool.needs === 'host' ? 'host' : 'qq',
    origins,
    risk,
    // R0 自动执行，其余一律要人点头（与内置工具同一套规则）。
    // 聊天来源的"已授权免确认"在 executor 里按调用再算一次。
    confirm: risk === 'R0' ? 'never' : 'always',
    /*
     * approval 不改风险、不改可见性，只说明"这次点头由谁问"。
     * "plugin" 的合法性已在 normalizeManifest 里按 runtime/trusted/paid 校验过；
     * 这里原样带出去，执行器据此跳过宿主的通用确认卡。
     */
    approval: tool.approval === 'plugin' ? 'plugin' : 'host',
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
