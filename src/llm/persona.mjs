/**
 * 卡片仓库 —— 人格卡与角色卡共用一套实现（F8）
 *
 * ## 为什么人格和角色是两张表、两套卡
 *
 *   **人格** = 它是谁（性格、说话风格）
 *   **角色** = 它在什么场景扮演什么（群里的聊天参与者 / 私聊助手 / 客服）
 *
 * 这两件事正交：同一个「私聊助手」角色，可以配正经人格，也可以配话痨人格；
 * 同一个人格，在群里和私聊里可以扮演不同角色。
 *
 * 所以不能塞进一张卡里 —— 那就变成了「角色 + 人格」绑死，
 * 想换其中一个必须新建整张卡。它们各自独立切换。
 *
 * ## 为什么两个用同一份实现
 *
 * 除了名字和提示文案，两者的行为完全一致：多卡、作用范围、越具体越优先、
 * 超限拒绝、旧格式迁移。写两份会立刻开始漂移 —— 改了一个忘另一个，
 * 而这类不一致只有在用户实际遇到时才暴露。
 *
 * ## 兼容旧格式
 *
 * 早期版本写的是 `{ text, updatedAt }`（单卡）。这里读到时**自动迁移**成
 * `{ cards: [...], activeId }` 并回写一次。
 * 迁移必须自动完成——用户不该因为升级而丢掉写了好久的人格。
 *
 * ## 为什么不用文件名当 id
 *
 * 重命名要"同步改文件名"，而 Windows 上文件重命名会遇到占用/权限问题，
 * 一旦失败就会出现"名字改了但文件没改"的半状态。用稳定 id + 存名字，
 * 重命名只是改一个字段。
 */

import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from '../config/atomic.mjs';

/** 注入上限（可配 1000–20000，默认 6000） */
export const DEFAULT_PERSONA_LIMIT = 6000;
export const MIN_PERSONA_LIMIT = 1000;
export const MAX_PERSONA_LIMIT = 20_000;

/**
 * 一张卡的作用范围。
 *
 *   global  —— 全局默认，任何没被更具体的卡覆盖的会话都用这张
 *   group   —— 只对这个群生效（scopeId 是群号）
 *   private —— 只对这个私聊对象生效（scopeId 是 QQ 号）
 *
 * 匹配规则是"越具体越优先"：private > group > global（见 resolveFor）。
 * 这样用户可以只写一个全局人格，再给某个群单独写一张，不用把内容复制一遍。
 *
 * @typedef {"global" | "group" | "private"} PersonaScope
 */

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {string} name
 * @property {string} text
 * @property {PersonaScope} scope
 * @property {string} scopeId global 时为空串；group 时是群号；private 时是 QQ 号
 * @property {string} updatedAt
 */

/**
 * 卡片仓库。人格和角色各持一个实例，只是 label 与 id 前缀不同。
 */
export class CardStore {
  /**
   * @param {object} opts
   * @param {string} opts.filePath
   * @param {number} [opts.limit]
   * @param {string} [opts.label]        用在提示文案里的名字（"人格" / "角色"）
   * @param {string} [opts.idPrefix]     新卡 id 前缀（p_ / r_），便于看日志时区分
   * @param {string} [opts.defaultName]  首次运行自动建的那张卡叫什么
   * @param {number} [opts.version]      落盘格式版本
   */
  constructor(opts) {
    this.filePath = opts.filePath;
    this.limit = clampLimit(opts.limit ?? DEFAULT_PERSONA_LIMIT);
    /** 文案里用的名字：人格 / 角色 */
    this.label = opts.label ?? '人格';
    this.idPrefix = opts.idPrefix ?? 'p_';
    this.defaultName = opts.defaultName ?? `默认${this.label}`;
    this.version = opts.version ?? 2;
    /** @type {Card[]} */
    this.cards = [];
    this.activeId = null;
    this.defaultId = null;
  }

  /** 读盘（含旧格式迁移） */
  async load() {
    const raw = await readJson(this.filePath);
    if (!raw) {
      return this;
    }

    // 新格式
    if (Array.isArray(raw.cards)) {
      /*
       * 旧卡（v2 及更早）没有 scope 字段。这里补成 global 而不是丢掉：
       * 丢掉等于用户写的东西全没了 —— 升级不该有这种代价。
       */
      this.cards = raw.cards.filter(isCard).map((c) => ({
        ...c,
        scope: normalizeScope(c.scope),
        scopeId: normalizeScope(c.scope) === 'global' ? '' : String(c.scopeId ?? ''),
      }));
      this.activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
      this.defaultId = typeof raw.defaultId === 'string' ? raw.defaultId : null;
      if (!this.activeId || !this.cards.some((c) => c.id === this.activeId)) this.activeId = this.cards[0]?.id ?? null;
      if (!this.defaultId || !this.cards.some((c) => c.id === this.defaultId && c.scope === 'global')) this.defaultId = this.cards.find(c => c.scope === 'global')?.id ?? null;
      return this;
    }

    // 旧格式 { text, updatedAt } → 迁移
    if (typeof raw.text === 'string') {
      const card = makeCard(this.idPrefix, this.defaultName, raw.text);
      this.cards = [card];
      this.activeId = card.id;
      this.defaultId = card.id;
      await this.#persist();
      return this;
    }

    return this;
  }

  /**
   * 当前"选中的那张卡"的文本。
   *
   * 注意它**不是**某个会话该用的那张 —— 会话用哪张由 resolveFor 决定。
   * 这个方法只用于界面显示"你现在在编辑哪张卡"。
   */
  activeText() {
    const card = this.cards.find((c) => c.id === this.activeId);
    return card?.text ?? '';
  }

  /**
   * 决定某个会话该用哪张卡。
   *
   * 匹配规则（越具体越优先）：
   *   1. private:<QQ> → scope=private 且 scopeId 匹配的卡
   *   2. group:<群号> → scope=group 且 scopeId 匹配的卡
   *   3. 回退 global  → 第一张 global 卡
   *   4. 都没有        → null（调用方用内置默认值）
   *
   * 为什么不"按添加顺序取第一个匹配"：那样结果取决于用户添加顺序，
   * 看不出规律。按具体程度分层，行为可预测。
   *
   * @param {string} convKey 形如 'group:123' 或 'private:456'
   * @returns {Card | null}
   */
  resolveFor(convKey) {
    const key = String(convKey ?? '');
    const sep = key.indexOf(':');
    if (sep < 0) return this.#globalCard();
    const kind = key.slice(0, sep);
    const id = key.slice(sep + 1);

    if (kind === 'private') {
      const hit = this.cards.find((c) => c.scope === 'private' && c.scopeId === id);
      if (hit) return hit;
    }
    if (kind === 'group') {
      const hit = this.cards.find((c) => c.scope === 'group' && c.scopeId === id);
      if (hit) return hit;
    }
    return this.#globalCard();
  }

  /** @returns {Card | null} */
  #globalCard() {
    return this.cards.find((c) => c.id === this.defaultId && c.scope === 'global') ?? this.cards.find((c) => c.scope === 'global') ?? null;
  }

  /**
   * 新建一张卡。
   *
   * @param {string} name
   * @param {string} [text]
   * @param {PersonaScope} [scope]
   * @param {string} [scopeId]
   * @returns {Promise<{ok: true, card: Card} | {ok: false, code: string, message: string}>}
   */
  async create(name, text = '', scope = 'global', scopeId = '') {
    const trimmedName = String(name ?? '').trim();
    if (!trimmedName) return { ok: false, code: 'E4041', message: `${this.label}名不能为空` };

    const s = normalizeScope(scope);
    const sid = s === 'global' ? '' : String(scopeId ?? '').trim();
    const invalid = validateScopeTarget(s, sid);
    if (invalid) return { ok: false, code: 'E4041', message: invalid };

    /*
     * 重名只在**同一个作用范围内**才算冲突。
     *
     * 理由：用户会自然地给不同群各写一张同名的"群规"。
     * 全局唯一会让这变成反直觉的限制。
     */
    if (this.cards.some((c) => c.name === trimmedName && c.scope === s && c.scopeId === sid)) {
      return { ok: false, code: 'E4041', message: `这个范围里已经有同名${this.label}：${trimmedName}` };
    }

    /*
     * 同一个具体范围只允许一张卡。
     *
     * 两张都匹配 group:123 时该用哪张？没有合理答案，规则会变成
     * "取决于添加顺序"——那种不确定性应该在写入时就挡掉。
     */
    if (s !== 'global' && this.cards.some((c) => c.scope === s && c.scopeId === sid)) {
      return {
        ok: false,
        code: 'E4041',
        message: `${s === 'group' ? '群' : '私聊'} ${sid} 已经有一张专属${this.label}了，直接编辑那张即可`,
      };
    }

    const card = makeCard(this.idPrefix, trimmedName, String(text ?? ''), s, sid);
    this.cards.push(card);
    if (!this.activeId) this.activeId = card.id;
    if (!this.defaultId && s === 'global') this.defaultId = card.id;
    await this.#persist();
    return { ok: true, card };
  }

  /**
   * 改内容 / 改名 / 改作用范围。超限拒绝，不静默截断。
   *
   * @param {string} id
   * @param {{name?: string, text?: string, scope?: PersonaScope, scopeId?: string}} patch
   */
  async update(id, patch) {
    const card = this.cards.find((c) => c.id === id);
    if (!card) return { ok: false, code: 'E4041', message: `${this.label}不存在` };

    if (patch.name !== undefined) {
      const next = String(patch.name).trim();
      if (!next) return { ok: false, code: 'E4041', message: `${this.label}名不能为空` };
      if (
        this.cards.some((c) => c.id !== id && c.name === next && c.scope === card.scope && c.scopeId === card.scopeId)
      ) {
        return { ok: false, code: 'E4041', message: `这个范围里已有同名${this.label}：${next}` };
      }
      card.name = next;
    }

    if (patch.scope !== undefined || patch.scopeId !== undefined) {
      const s = normalizeScope(patch.scope ?? card.scope);
      const sid = s === 'global' ? '' : String(patch.scopeId ?? card.scopeId ?? '').trim();
      const invalid = validateScopeTarget(s, sid);
      if (invalid) return { ok: false, code: 'E4041', message: invalid };
      // 换到别人已占用的具体范围要拒绝，理由同 create
      if (s !== 'global' && this.cards.some((c) => c.id !== id && c.scope === s && c.scopeId === sid)) {
        return {
          ok: false,
          code: 'E4041',
          message: `${s === 'group' ? '群' : '私聊'} ${sid} 已经有一张专属${this.label}了`,
        };
      }
      card.scope = s;
      card.scopeId = sid;
    }

    if (patch.text !== undefined) {
      const nextText = String(patch.text);
      if (nextText.length > this.limit) {
        return {
          ok: false,
          code: 'E4041',
          message: `${this.label}注入超限：${nextText.length} / ${this.limit} 字符`,
        };
      }
      card.text = nextText;
    }

    card.updatedAt = new Date().toISOString();
    await this.#persist();
    return { ok: true, card };
  }

  /** 另存为副本 */
  async duplicate(id, newName) {
    const src = this.cards.find((c) => c.id === id);
    if (!src) return { ok: false, code: 'E4041', message: `${this.label}不存在` };
    const name = String(newName ?? `${src.name} 副本`).trim();
    /*
     * 副本默认不继承作用范围：原卡占着 group:123，副本也占会冲突。
     * 所以副本是 global 的，用户再自己指定范围。
     */
    return this.create(name, src.text);
  }

  /** @param {string} id */
  async remove(id) {
    const idx = this.cards.findIndex((c) => c.id === id);
    if (idx < 0) return { ok: false, code: 'E4041', message: `${this.label}不存在` };
    if (this.cards.length === 1) {
      // 删掉最后一张会让它没有可用的这张卡，这是产品上不该允许的
      return { ok: false, code: 'E4041', message: `至少要保留一张${this.label}` };
    }
    this.cards.splice(idx, 1);
    if (this.activeId === id) this.activeId = this.cards[0].id;
    await this.#persist();
    return { ok: true, activeId: this.activeId };
  }

  async setDefault(id) {
    if (!this.cards.some(c => c.id === id && c.scope === 'global')) return { ok: false, code: 'E4041', message: '全局默认必须选择一张全局卡' };
    const old = this.defaultId;
    this.defaultId = id;
    try { await this.#persist(); } catch (e) { this.defaultId = old; throw e; }
    return { ok: true, defaultId: id };
  }

  /** @param {string} id */
  async activate(id) {
    if (!this.cards.some((c) => c.id === id)) {
      return { ok: false, code: 'E4041', message: `${this.label}不存在` };
    }
    this.activeId = id;
    await this.#persist();
    return { ok: true, activeId: id };
  }

  /**
   * 给界面看的视图（含字数与作用范围）。
   *
   * @param {string[]} [convKeys] 已知会话键，用来标"这张卡现在命中谁"
   */
  view(convKeys = []) {
    return {
      limit: this.limit,
      label: this.label,
      defaultId: this.#globalCard()?.id ?? null,
      activeId: this.activeId,
      cards: this.cards.map((c) => ({
        id: c.id,
        name: c.name,
        text: c.text,
        length: c.text.length,
        scope: c.scope,
        scopeId: c.scopeId,
        updatedAt: c.updatedAt,
      })),
      /** 每个会话当前命中哪张卡：{ 'group:123': 'p_xxx' } */
      resolved: Object.fromEntries(
        convKeys.map((k) => [k, this.resolveFor(k)?.id ?? null]).filter(([, v]) => v),
      ),
    };
  }

  async #persist() {
    if (!this.cards.some(c => c.id === this.defaultId && c.scope === 'global')) this.defaultId = this.cards.find(c => c.scope === 'global')?.id ?? null;
    await writeJsonAtomic(this.filePath, {
      version: this.version,
      defaultId: this.defaultId,
      activeId: this.activeId,
      cards: this.cards,
    });
  }
}

/**
 * @param {string} prefix
 * @param {string} name
 * @param {string} text
 * @returns {Card}
 */
function makeCard(prefix, name, text, scope = 'global', scopeId = '') {
  const s = normalizeScope(scope);
  return {
    id: `${prefix}${crypto.randomUUID().slice(0, 8)}`,
    name,
    text,
    scope: s,
    scopeId: s === 'global' ? '' : String(scopeId ?? '').trim(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 把任意输入收成一个合法 scope。
 *
 * 不认识的一律退回 global：宁可"这张卡是全局的"，也不要因为一个拼错的
 * 字段让卡谁都匹配不上 —— 那会让设定静默失效。
 *
 * @param {any} v
 * @returns {PersonaScope}
 */
export function normalizeScope(v) {
  if (v === 'group' || v === 'private') return v;
  return 'global';
}

/** @param {any} v */
function isCard(v) {
  return v && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.text === 'string';
}

/**
 * 校验作用范围的目标是否合法。
 *
 * @param {PersonaScope} scope
 * @param {string} scopeId
 * @returns {string | null} 错误信息，合法时返回 null
 */
export function validateScopeTarget(scope, scopeId) {
  if (scope === 'global') return null;
  if (!scopeId) {
    return scope === 'group' ? '要填群号' : '要填 QQ 号';
  }
  if (!/^\d{5,12}$/.test(scopeId)) {
    return `不是有效的号码：${scopeId}（5–12 位数字）`;
  }
  return null;
}

/** @param {number} n */
export function clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_PERSONA_LIMIT;
  return Math.min(MAX_PERSONA_LIMIT, Math.max(MIN_PERSONA_LIMIT, Math.round(v)));
}

/**
 * 人格卡仓库。
 *
 * 现在它只是 CardStore 的人格形态 —— 单独留一个名字是因为
 * "人格"是这个产品里最核心的概念，代码里到处在用 PersonaStore 这个名字。
 */
export class PersonaStore extends CardStore {
  /** @param {{filePath: string, limit?: number}} opts */
  constructor(opts) {
    super({
      ...opts,
      label: '人格',
      idPrefix: 'p_',
      defaultName: '默认人格',
      version: 2,
    });
  }
}


/**
 * 角色卡仓库。
 *
 * 和人格卡共用一套实现，但**存在另一个文件里**、有**自己的 activeId**。
 * 这是两者能独立切换的前提：换角色不动人格，换人格不动角色。
 */
export class RoleStore extends CardStore {
  /** @param {{filePath: string, limit?: number}} opts */
  constructor(opts) {
    super({
      ...opts,
      label: '角色',
      idPrefix: 'r_',
      defaultName: '默认角色',
      version: 1,
    });
  }
}
