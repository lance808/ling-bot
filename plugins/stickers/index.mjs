/**
 * 表情包插件入口 —— 看 / 记 / 选 / 收 / 发
 *
 * ## 这个插件在解决什么
 *
 * QQ 账号的收藏表情对机器人来说是"一堆不知道什么意思的图"。人看得出哪张适合
 * 接梗、哪张适合怼人，模型看不出。所以它需要三件配套的东西：
 *
 *   1. 能把账号收藏**拉下来**并保留它的认知（备注、标签、用过几次）；
 *   2. 能把一张图**提交到视觉通道**真的看一眼（不是猜）；
 *   3. 能在合适的时机**发出去**。
 *
 * `sticker_*` 六个工具就是这三件事的入口。它们不自己调模型、不自己下载图片、
 * 也不自己发消息 —— 那三件事分别属于宿主的视觉链路、受控取图链路与发送闸门。
 *
 * ## 五条贯穿全文的硬约束
 *
 * 1. **归属只从 `ctx.caller` 取。** 任何工具参数里都没有 `convKey` / `origin` /
 *    `user`，宿主也把那些名字列为保留参数。于是"把这个表情发到别的群"在
 *    能力层面写不出来 —— 不是"校验拦住了"，是压根没有那个参数。
 * 2. **库损坏 → 只读降级。** init 读库抛错时置 `writable=false`，此后所有写工具
 *    返回 `E_STICKER_STORE_READONLY`，**一个字都不回写**。理由见 lib/store.mjs 文件头。
 * 3. **不落盘 URL。** 条目里没有 `url` 键。QQ 图片地址带临时鉴权参数，落盘等于
 *    把私有图片的长期入口写进明文文件。
 * 4. **不确定就别说确定的话。** 视觉状态未知时不能说"已关闭"，视觉关着时不能说
 *    "我看过了"，动图只能描述第一帧。这三条都是"模型照着返回文本说话"的直接后果 ——
 *    说错一句，它就会开始编造。
 * 5. **失败原样透传。** 网关与闸门的错误码（`E2030` / `E4074` / `E_GATEWAY_*` …）
 *    一律不改写。把它们包成"插件内部错误"会让"等会儿再发"这种可恢复信息消失。
 *
 * ## 模块分工
 *
 *   lib/model.mjs   条目归一化 / 合并 / 查找 / 记账 / 渲染（纯函数，零 IO）
 *   lib/policy.mjs  配置夹取 / 频次闸门 / 视觉三态 / 话术（纯函数，无 IO）
 *   lib/store.mjs   library.json 读写 / 损坏检测 / 缓存回收（唯一 IO）
 *   index.mjs       编排：取身份 → 查库 → 调网关 → 写库 → 回话
 */

import {
  entryKeys,
  findEntry,
  formatList,
  mergeLibrary,
  applyNote,
  markUsed,
  normalizeEntries,
  normalizeEntry,
  sanitizeText,
  toItemView,
  nowIso,
} from './lib/model.mjs';
import {
  DEFAULT_CONFIG,
  StickerRateLimiter,
  normalizeConfig,
  resolveVisionState,
  noVisionNotice,
  visionOffSelection,
  ANIMATED_NOTICE,
  tooLargeNotice,
  toMessageId,
  clampInt,
} from './lib/policy.mjs';
import { StickerStore, StorageCorrupt } from './lib/store.mjs';

/** 一次 `listFaces` 向网关要多少条。取 500 是宿主允许的上限：越多越接近"全量"。 */
const SYNC_COUNT = 500;

/** 同步失败后多久内不再重试（避免每次调用都打一次失败网关） */
const SYNC_FAIL_COOLDOWN_MS = 30_000;

/**
 * 运行期状态（`init` 时重建）。
 *
 * @type {{
 *   store: StickerStore | null,
 *   config: typeof DEFAULT_CONFIG,
 *   limiter: StickerRateLimiter,
 *   writable: boolean,
 *   corruptMessage: string,
 *   syncedAt: number,
 *   syncComplete: boolean,
 *   lastError: {code: string, message: string, at: number} | null,
 *   lastSyncAttemptAt: number,
 *   initAt: number,
 *   urlById: Map<string, string>,
 * }}
 */
let runtime = freshRuntime();

/**
 * 一份干净的运行期状态。
 *
 * `writable: true` 是"还没读库"的初始状态 —— 真正判定发生在 `loadLibrary` 的
 * 第一次读取。这里不预设"能写"或"不能写"，因为两者都会在 init 之后被覆盖。
 *
 * @returns {any}
 */
function freshRuntime() {
  return {
    store: null,
    config: { ...DEFAULT_CONFIG },
    limiter: new StickerRateLimiter(),
    writable: true,
    corruptMessage: '',
    syncedAt: 0,
    syncComplete: false,
    lastError: null,
    lastSyncAttemptAt: 0,
    initAt: 0,
    /**
     * 表情 id → 图片 URL，**只在内存里**。
     *
     * ## 为什么必须有这么一张表
     *
     * 宿主的 `fetchFaceImage({ref})` 只认 `ref.url`（它不做"按 id 再查一次"），
     * 而本插件按契约**不落盘 URL**。所以 URL 的唯一合法来源是最近一次
     * `listFaces` 的返回：那一次把 `{id, resId, md5, desc, url}` 都给了我们。
     *
     * 于是"取图"这件事在结构上依赖"刚同步过"：表里有 id 才有地址。
     * 进程重启后这张表是空的 —— 那时能做的只有"用本地缓存的那份文件发送"
     * （`file`），而"看图"需要先同步一次。这不是缺陷，是"URL 不落盘"的代价，
     * 也是它换来的东西：磁盘上永远不会存在一个带鉴权参数的地址。
     *
     * 上限是刻意加的：网关可能返回几千条，而这是个纯内存结构，
     * 子进程又是长跑的。超了丢最旧的（Map 的插入序）。
     *
     * @type {Map<string, string>}
     */
    urlById: new Map(),
  };
}

/** 内存里最多记多少个 id→URL（超出丢最旧的） */
const MAX_URL_MEMORY = 1000;

/* ==================================================================== 结果 */

/**
 * 统一失败结果。
 *
 * 插件返回 `{ok:false, code, message}` 是**合法的工具结果**，不是宿主异常。
 * 这样模型能看到"哪一步没过、下一步该怎么办"，而不是整轮失败。
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {object}
 */
function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * 把存储异常翻译成工具结果。
 *
 * `StorageCorrupt` 必须原样报给模型（带文件路径与"不会覆盖"的说明）：
 * 用户在群里看到的应该是"数据文件坏了，需要你确认"，而不是一句含糊的"工具失败"。
 *
 * @param {unknown} err
 * @returns {object}
 */
function storeFail(err) {
  const e = /** @type {any} */ (err);
  if (e instanceof StorageCorrupt || e?.code === 'E_STICKER_STORE_READONLY') {
    return fail('E_STICKER_STORE_READONLY', String(e?.message ?? '表情库损坏或读不动'), {
      file: e?.file ?? '',
      hint: '表情库没有被当成空库，也没有被覆盖。读取类工具仍可用；修复或删除该文件后重新启用插件即可恢复写入。',
    });
  }
  return fail('E_STICKER_STORE_READONLY', `表情库读写失败：${String(e?.message ?? e)}`);
}

/**
 * 网关结果原样透传，只补一句"这句码是什么意思"。
 *
 * 为什么不整形成插件的码：`E2030`（限流）与 `E_GATEWAY_UNSUPPORTED`（网关没这功能）
 * 对用户意味着完全相反的两件事 —— 一个是等一会儿再试，一个是去升级网关。
 * 包成同一个码，等于把两种排查方向合并成一条。
 *
 * @param {any} result
 * @returns {object}
 */
function gatewayFail(result) {
  const code = String(result?.code ?? 'E_GATEWAY_UNAVAILABLE');
  const message = String(result?.message ?? '网关调用失败');
  return { ok: false, code, message, ...(result?.warning ? { warning: String(result.warning) } : {}) };
}

/* ==================================================================== 上下文 */

/**
 * 当前生效配置。
 *
 * 每次都从 `ctx.config` 现读：宿主保存配置后会 dispose → init，但工具也可能
 * 在 init 之前被直接调用（单测、脚本）。现读是最不容易错的做法。
 *
 * @param {any} ctx
 * @returns {typeof DEFAULT_CONFIG}
 */
function configOf(ctx) {
  return normalizeConfig(ctx?.config ?? runtime.config);
}

/**
 * 取本次调用的可信会话。
 *
 * 刻意**不**兜底成某个默认会话：那等于让所有拿不到上下文的调用共用一个身份，
 * 而收藏与发送都依赖这个身份做归属判定。
 *
 * @param {any} ctx
 * @returns {{ok: true, convKey: string, isGroup: boolean} | {ok: false, code: string, message: string}}
 */
function requireIdentity(ctx) {
  const convKey = String(ctx?.caller?.convKey ?? '').trim();
  // 形状校验与宿主一致：`group:` / `private:` 后面必须还有内容
  if (!convKey || !/^(group|private):\S+$/.test(convKey)) {
    return {
      ok: false,
      code: 'E_STICKER_NO_IDENTITY',
      message: '这次调用没有可信的会话上下文（ctx.caller.convKey），没法知道该往哪个会话收/发。请让用户在具体会话里再试。',
    };
  }
  return { ok: true, convKey, isGroup: convKey.startsWith('group:') };
}

/**
 * 取网关；不可用时给出明确的码。
 *
 * ## 两个失败必须分开报
 *
 *   · `available === false` → **宿主根本没注入这个能力**（`E4072`）。
 *     这和"宿主没提供聊天桥"是同一类事实：当前这个运行环境没有它，
 *     插件该降级（比如"本地库还能读"），而不是让用户去查网关。
 *   · 网关注入了、但动作调不通 → `E_GATEWAY_UNAVAILABLE`（由 bridge 返回）。
 *     那是"这次没连上"，重试可能成功。
 *
 * 混成一个码的后果很具体：单测环境或桌面端手动试工具时，用户会看到
 * "网关不可用"然后跑去检查 OneBot 配置 —— 而那个环境里压根没有网关。
 *
 * @param {any} ctx
 * @returns {{ok: true, gateway: any} | {ok: false, code: string, message: string}}
 */
function requireGateway(ctx) {
  const gw = ctx?.gateway ?? null;
  if (!gw) {
    return {
      ok: false,
      code: 'E4072',
      message: '宿主没有提供网关能力（ctx.gateway），当前环境无法操作 QQ 收藏表情。',
    };
  }
  if (gw.available === false) {
    return {
      ok: false,
      code: 'E4072',
      message: '宿主没有提供网关能力（ctx.gateway.available=false），当前环境无法操作 QQ 收藏表情。',
    };
  }
  return { ok: true, gateway: gw };
}

/**
 * 取存储实例。
 *
 * init 没跑过（宿主直接调工具、或单测跳过 init）时按 `ctx.dataDir` 懒建，
 * 免得因为生命周期顺序的细节报一个看不懂的错。
 *
 * @param {any} ctx
 * @returns {{ok: true, store: StickerStore} | {ok: false, code: string, message: string}}
 */
function storeOf(ctx) {
  const dataDir = String(ctx?.dataDir ?? ctx?.plugin?.dataDir ?? '');
  if (!dataDir) {
    return {
      ok: false,
      code: 'E4071',
      message: '宿主没有给这个插件分配数据目录（ctx.dataDir），表情库无处存放。',
    };
  }
  if (!runtime.store || runtime.store.dataDir !== dataDir) {
    runtime.store = new StickerStore({ dataDir, log: (l, m, f) => ctx?.log?.(l, m, f) });
  }
  return { ok: true, store: runtime.store };
}

/**
 * 读库；损坏时把运行期状态切成只读并返回失败。
 *
 * ## 为什么这里要把 `writable` 置 false
 *
 * 读失败是"这份文件现在不可信"的唯一证据。此刻任何写操作都可能把用户的
 * `localNote` 覆盖成空 —— 而界面一切正常。所以一次读失败就把整个插件切成
 * **只读**，直到重新 init（用户修好文件后重载插件）。
 *
 * 注意"文件不存在"不会走到这里：那是空库，不是损坏。
 *
 * @param {StickerStore} store
 * @param {any} ctx
 * @returns {Promise<{ok: true, doc: any} | {ok: false, code: string, message: string}>}
 */
async function loadLibrary(store, ctx) {
  try {
    const doc = await store.load();
    // 读成功不自动恢复 writable：一旦判定损坏，本次生命周期内不再回写。
    // 恢复需要一次显式的 init（用户修好文件后重载插件），那是他自己的决定。
    return { ok: true, doc };
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e instanceof StorageCorrupt || e?.code === 'E_STICKER_STORE_READONLY') {
      runtime.writable = false;
      runtime.corruptMessage = String(e?.message ?? '表情库损坏');
      /*
       * warning 级别，不是 debug。
       *
       * 这一行是"插件从此不再写库"的唯一提示。写成 debug 的话，
       * 用户看到的只是"记不住含义了"，而日志里什么都没有。
       */
      ctx?.log?.('warn', '表情库读取失败，已降级为只读（本次生命周期内不再写入）', {
        file: e?.file ?? '',
        message: runtime.corruptMessage,
      });
      return { ok: false, code: 'E_STICKER_STORE_READONLY', message: runtime.corruptMessage };
    }
    ctx?.log?.('error', '表情库读取异常', { message: String(e?.message ?? e) });
    return { ok: false, code: 'E_STICKER_STORE_READONLY', message: `表情库读取失败：${String(e?.message ?? e)}` };
  }
}

/**
 * 写工具的统一前置：只读降级时一律拒绝。
 *
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
function requireWritable() {
  if (runtime.writable) return { ok: true };
  return fail('E_STICKER_STORE_READONLY', runtime.corruptMessage || '表情库处于只读状态（数据文件损坏或读不动），拒绝写入。', {
    hint: '读取类工具（sticker_list / sticker_search / sticker_image / sticker_send）仍然可用；写库或修改 QQ 收藏都会被拒绝，直到文件被修复并重新启用插件。',
  });
}

/* ==================================================================== 同步 */

/**
 * 把 QQ 账号的收藏表情并进本地库（带 TTL 缓存）。
 *
 * ## 为什么同步失败时库必须一个字节都不变
 *
 * "这次没拉到"不等于"QQ 侧都删了"。合并只在拿到**合法数组**之后发生；
 * 失败时只更新内存里的 `lastError`，不写盘。否则一次网络抖动就能把
 * `entries` 清空，而那正是这个插件最贵的数据。
 *
 * ## 为什么要有失败冷却
 *
 * 网关没实现扩展动作时，每次工具调用都去打一次、每次都失败、每次都要等超时。
 * 用户在群里看到的是"每次发表情都卡几秒"。冷却期内直接跳过同步、用本地库回答。
 *
 * @param {object} opts
 * @param {any} opts.ctx
 * @param {any} opts.gateway
 * @param {StickerStore} opts.store
 * @param {typeof DEFAULT_CONFIG} opts.cfg
 * @param {boolean} [opts.force]
 * @returns {Promise<{ok: boolean, entries: any[], synced: boolean, warning?: string, code?: string, message?: string}>}
 */
async function syncLibrary({ ctx, gateway, store, cfg, force = false }) {
  const now = Date.now();

  /*
   * 缓存命中：`syncTtlMs` 内不重复打网关。
   *
   * 注意 TTL 用的是**上次成功同步**的时间，不是上次尝试的时间 ——
   * 用尝试时间的话，一个持续失败的网关会让"上次成功"永远停留在很久以前，
   * 于是每次调用都重试（正是下面那条失败冷却要防的）。
   */
  if (!force && runtime.syncedAt > 0 && now - runtime.syncedAt < cfg.syncTtlMs) {
    const got = await loadLibrary(store, ctx);
    if (!got.ok) return { ok: false, entries: [], ...got };
    return { ok: true, entries: got.doc.entries, synced: false };
  }
  if (!force && runtime.lastError && now - runtime.lastSyncAttemptAt < SYNC_FAIL_COOLDOWN_MS) {
    const got = await loadLibrary(store, ctx);
    if (!got.ok) return { ok: false, entries: [], ...got };
    // 本地库仍然能回答列表/搜索：故障只影响"账号侧的新变化"，不影响已有认知
    return { ok: true, entries: got.doc.entries, synced: false, warning: runtime.lastError.message, code: runtime.lastError.code };
  }

  runtime.lastSyncAttemptAt = now;

  const listed = await gateway.listFaces?.({ count: SYNC_COUNT });
  if (!listed || listed.ok !== true) {
    const code = String(listed?.code ?? 'E_GATEWAY_UNAVAILABLE');
    const message = String(listed?.message ?? '拉取账号收藏表情失败');
    runtime.lastError = { code, message, at: now };
    ctx?.log?.('warn', '同步账号收藏表情失败（本地库未被修改）', { code, message });

    const got = await loadLibrary(store, ctx);
    if (!got.ok) return { ok: false, entries: [], ...got };
    return { ok: true, entries: got.doc.entries, synced: false, warning: `${code}：${message}`, code };
  }

  /*
   * 只读降级时**连同步都不做**。
   *
   * 同步本身是"读 + 合并 + 写回"。只读状态下写回会被拦，但如果先合并再失败，
   * 调用方拿到的 entries 就是"看起来已经同步过"的一份，而实际并没有落盘 ——
   * 下一次读又是旧的。所以干脆不合并，直接用库里的原样回答。
   */
  if (!runtime.writable) {
    const got = await loadLibrary(store, ctx);
    if (!got.ok) return { ok: false, entries: [], ...got };
    return { ok: true, entries: got.doc.entries, synced: false, code: 'E_STICKER_STORE_READONLY', warning: runtime.corruptMessage };
  }

  const complete = listed.complete === true;
  const fetchedItems = Array.isArray(listed.items) ? listed.items : [];

  /*
   * 把这次的 URL 记进内存表。
   *
   * 这是整个插件里 URL 唯一的落脚点：`listFaces` 刚给我们的、只活在这个进程里、
   * 重启即消失。库里的条目一个字节都不会拿到它。
   */
  rememberUrls(fetchedItems);

  const got = await loadLibrary(store, ctx);
  if (!got.ok) return { ok: false, entries: [], ...got };

  const before = got.doc.entries;

  /*
   * ⚠️ 空列表不能当成"账号收藏被清空"。
   *
   * ## 这是本文件里最危险的一条判断
   *
   * `complete: true` 的语义是"这次拿到了全量"，于是合并逻辑会把
   * "不在列表里"的条目当成"QQ 侧已删"删掉。但有一个场景它不是那个意思：
   *
   *   **网关在"读取失败但没报错"时返回空数组。**
   *
   * 这不是假想。有的实现在未登录、数据还没加载完、或权限不足时
   * 回一个 `status: ok` + 空 `data`。于是 `complete` 为真、列表为空、
   * 本地几十条 `localNote` 一条不剩 —— 而用户看到的只是"表情好像没了"。
   *
   * 所以这里加一条**不对称**的保护：库里有东西、而这次拿到空列表时，
   * 一律按"部分结果"处理（一条都不删），并留一条警告。
   *
   * 代价是"用户真的在 QQ 里删光了所有收藏"时本地条目不会自动消失。
   * 那个代价是可控的（还能手动清理、也不影响使用），而反过来的代价是
   * **静默丢失全部认知**，不可恢复。两个方向不对称，所以选择也就没有悬念。
   */
  const looksEmpty = complete && fetchedItems.length === 0 && before.length > 0;
  if (looksEmpty) {
    const message = '网关返回了空的收藏列表，但本地库里有条目。已按"结果不完整"处理，没有删除任何本地条目。';
    runtime.lastError = { code: 'E_GATEWAY_EMPTY_LIST', message, at: now };
    ctx?.log?.('warn', message, { localEntries: before.length });
    // 记一次失败留痕，但**不**写 syncedAt —— 否则 TTL 内不会再试
    try {
      await store.update((doc) => ({ ...doc, lastError: runtime.lastError }));
    } catch {
      /* 留痕失败不影响"不删条目"这件事本身 */
    }
    return {
      ok: true,
      entries: before,
      synced: false,
      warning: `E_GATEWAY_EMPTY_LIST：${message}`,
      code: 'E_GATEWAY_EMPTY_LIST',
    };
  }

  /*
   * `since` = 上一次**成功**同步的时刻。
   *
   * 传给 `mergeLibrary` 用来豁免"在这次列表快照之后才收进来的条目"——
   * 否则一次紧跟在收藏之后的完整同步会把刚收的那张当成"QQ 侧已删"清掉。
   * 详见 lib/model.mjs 里 mergeLibrary 文件头那段。
   */
  const merged = mergeLibrary(before, fetchedItems, { complete, since: runtime.syncedAt });

  /*
   * 找出被"同步逻辑删除"的条目，回收它们独占的缓存文件（契约 §6.2）。
   *
   * 先判"没有别的条目引用同一 sha256"：同一张图可能既有一条 QQ 条目、
   * 又有一条本地条目（不同 origin 同 sha），删文件会让剩下那条发不出去。
   */
  const droppedFiles = collectDroppedFiles(before, merged);

  try {
    await store.update((doc) => ({
      ...doc,
      account: String(doc.account ?? ''),
      entries: merged,
      syncedAt: now,
      lastSyncComplete: complete,
      lastError: null,
    }));
    runtime.syncedAt = now;
    runtime.syncComplete = complete;
    runtime.lastError = null;
  } catch (err) {
    // 写回失败不能让"看列表"也失败：entries 已经在内存里，本次调用照常用
    ctx?.log?.('warn', '同步结果写回失败（本次仍按合并结果回答，但下次要重新同步）', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  if (droppedFiles.length > 0) {
    const removed = await store.removeFiles(droppedFiles);
    if (removed > 0) ctx?.log?.('info', `同步时删除了 ${removed} 个不再被引用的表情缓存文件`);
  }
  if (fetchedItems.length === 0) {
    ctx?.log?.('info', '账号收藏表情列表为空（这可能是真的没有收藏，也可能是网关返回了空数组）');
  }

  return { ok: true, entries: merged, synced: true };
}

/**
 * 计算"同步后不再被任何条目引用"的缓存文件。
 *
 * @param {any[]} before
 * @param {any[]} after
 * @returns {string[]}
 */
function collectDroppedFiles(before, after) {
  const afterFiles = new Set(after.map((e) => String(e?.file ?? '')).filter(Boolean));
  const afterShas = new Set(after.map((e) => String(e?.sha256 ?? '')).filter(Boolean));
  /** @type {string[]} */
  const out = [];
  for (const e of before) {
    const file = String(e?.file ?? '');
    if (!file) continue;
    if (afterFiles.has(file)) continue;
    // 还有别的条目用着同一份字节（同 sha256）时不能删：那条还剩着
    if (e?.sha256 && afterShas.has(String(e.sha256))) continue;
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

/**
 * 工具用的"取当前条目集合"：优先按 TTL 同步，失败则用本地库。
 *
 * @param {any} ctx
 * @param {boolean} [force]
 * @returns {Promise<{ok: true, entries: any[], warning?: string, readonly: boolean} | {ok: false, code: string, message: string}>}
 */
async function entriesOf(ctx, force = false) {
  const cfg = configOf(ctx);
  const s = storeOf(ctx);
  if (!s.ok) return s;

  const id = requireIdentity(ctx);
  if (!id.ok) return id;

  const gw = requireGateway(ctx);
  if (gw.ok) {
    const r = await syncLibrary({ ctx, gateway: gw.gateway, store: s.store, cfg, force: force === true });
    if (r.ok) {
      /*
       * `code` 必须一起往回带。
       *
       * 同步失败**不是**本次工具调用的失败（本地库还能回答），但它是一个
       * 模型与用户都该知道的事实："这次看到的是旧数据，账号侧没拉到"。
       * 丢掉它就等于把"数据可能不完整"变成一个不可见的差异 ——
       * 模型会以为列表是完整的，然后说"你没有这个表情"。
       */
      return {
        ok: true,
        entries: r.entries,
        warning: r.warning,
        code: r.code,
        readonly: !runtime.writable,
      };
    }
    // 同步返回的是"库坏了"：仍然允许降级空集合吗？不行 —— 那会让模型以为没有表情。
    if (r.code === 'E_STICKER_STORE_READONLY') return { ok: false, code: r.code, message: r.message };
  }

  // 网关不可用：本地库照常可用（选图、看缓存都能做，只是不知道账号侧的新变化）
  const got = await loadLibrary(s.store, ctx);
  if (!got.ok) return { ok: false, code: got.code, message: got.message };
  return {
    ok: true,
    entries: got.doc.entries,
    warning: gw.ok ? undefined : gw.message,
    readonly: !runtime.writable,
  };
}

/**
 * 确保能拿到一张表情的图片字节。
 *
 * 有两种调用意图，所以有 `alwaysFetch` 这个开关：
 *
 *   · **发送**：只要本地有 `file` 就够了（QQ 客户端负责播，宿主的 `sendFace`
 *     读的是磁盘上的那份）—— 这种情况不该为一个已经缓存的图再下一次网络。
 *   · **看图**：必须有 `dataUrl`，而它只来自这一次的取图结果（base64 不落盘、
 *     也不从磁盘读回来拼）。所以哪怕本地有缓存文件，也得重新取一次。
 *
 * ## URL 从哪来（这是本插件最拧巴的一处约束）
 *
 * 宿主 `fetchFaceImage` 只认 `ref.url`，而 URL 按契约**不落盘**。于是唯一合法的
 * 来源是最近一次 `listFaces` 留在内存里的映射。进程刚起来、或者图片是上一次会话
 * 收进库的，这张表里就没有它 —— 此时先强制同步一次再取；还是没有，就只能
 * 把宿主给的 `E_STICKER_NO_IMAGE_URL` 翻成"账号侧没有这张图的地址"交回去。
 * 这个代价是"URL 不落盘"换来的，不是实现疏忽。
 *
 * @param {object} opts
 * @param {any} opts.ctx
 * @param {any} opts.gateway
 * @param {StickerStore} opts.store
 * @param {any} opts.entry
 * @param {typeof DEFAULT_CONFIG} opts.cfg
 * @param {boolean} [opts.alwaysFetch] 有本地文件也重新取一次（为了拿 dataUrl）
 * @returns {Promise<{ok: true, entry: any, fetched: any} | {ok: false, code: string, message: string}>}
 */
async function ensureFile({ ctx, gateway, store, entry, cfg, alwaysFetch = false }) {
  if (!alwaysFetch && entry.file) return { ok: true, entry, fetched: null };

  const fetchOnce = async (target) =>
    gateway.fetchFaceImage?.({ ref: refOf(target), maxBytes: cfg.maxImageBytes });

  let target = entry;
  let fetched = await fetchOnce(target);

  /*
   * 内存里没有这张图的地址 → 先同步一次再试。
   *
   * 只在"确实没地址"时才多打一次网关：同步会拿回全量列表（含 url），
   * 顺便把账号侧的变动也并进来。其他失败（网络、魔数不对、超 4MB）重试没有意义，
   * 原样透传。
   */
  if (fetched && fetched.ok !== true && fetched.code === 'E_STICKER_NO_IMAGE_URL' && !runtime.urlById.has(entry.id)) {
    const s = storeOf(ctx);
    if (s.ok) {
      const synced = await syncLibrary({ ctx, gateway, store: s.store, cfg, force: true });
      if (synced.ok) {
        const fresh = findEntry(synced.entries, entry.id);
        if (fresh) target = fresh;
        fetched = await fetchOnce(target);
      }
    }
  }

  if (!fetched || fetched.ok !== true) {
    const e = gatewayFail(fetched);
    if (e.code === 'E_STICKER_NO_IMAGE_URL') {
      return {
        ok: false,
        code: 'E_STICKER_NO_IMAGE_URL',
        message:
          '账号侧没有这张表情的图片地址（本地库不保存图片 URL，只在同步时临时持有）。' +
          '可能是这张图已经从 QQ 收藏里删掉了，或者网关这次没给地址；重新同步一次再试。',
      };
    }
    return e;
  }

  const patched = normalizeEntry({
    ...target,
    sha256: fetched.sha256 || target.sha256,
    file: fetched.file || target.file,
    mime: fetched.mime || target.mime,
    bytes: fetched.bytes || target.bytes,
    width: fetched.width || target.width,
    height: fetched.height || target.height,
    animated: fetched.animated === true || target.animated,
    updatedAt: nowIso(),
  });
  if (!patched) return fail('E_STICKER_FETCH_FAILED', '取到的图片信息无法归一化，放弃缓存这次结果');

  /*
   * 缓存信息写回库。
   *
   * 只读状态下跳过：缓存元数据不是必须落盘的（下一次现取就好），
   * 而"只读"这个承诺必须是绝对的 —— 一旦有例外，审查时就很难相信它了。
   */
  if (runtime.writable) {
    try {
      await store.update((doc) => {
        const idx = doc.entries.findIndex((e) => e.id === patched.id);
        if (idx < 0) return doc;
        doc.entries[idx] = patched;
        return doc;
      });
    } catch (error) {
      ctx?.log?.('warn', '表情缓存元数据写回失败（不影响本次使用）', {
        message: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }
  return { ok: true, entry: patched, fetched };
}

/**
 * 把一次 `listFaces` 返回的 id→URL 记进内存。
 *
 * 只记 http(s) 的地址：`fetchFaceImage` 面对非 http(s) 会直接拒（契约 §1.3），
 * 记进来也没用，反而让"明明有地址却取不到图"的错误更难看懂。
 *
 * @param {any[]} items
 */
function rememberUrls(items) {
  const memory = runtime.urlById;
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id ?? '').trim();
    const url = String(item?.url ?? '').trim();
    if (!id || !/^https?:\/\//i.test(url)) continue;
    // 重新插入以把它挪到 Map 的尾部（= 最近一次见到），淘汰时才不会先丢它
    memory.delete(id);
    memory.set(id, url);
    while (memory.size > MAX_URL_MEMORY) {
      const oldest = memory.keys().next();
      if (oldest.done) break;
      memory.delete(oldest.value);
    }
  }
}

/**
 * 构造给 `fetchFaceImage` 的引用对象。
 *
 * ## 为什么这里必须自己带 url
 *
 * 宿主的 `fetchFaceImage` 只读 `ref.url` —— 它**不会**自己按 id 去账号列表里
 * 再查一次（那是网关的额外一次动作，宿主明确不做）。而本插件按契约不落盘 URL，
 * 所以唯一合法的来源就是最近一次 `listFaces` 留在内存里的那张表。
 *
 * 表里没有就是没有：返回空的 `url` 让宿主给出 `E_STICKER_NO_IMAGE_URL`，
 * 由本插件把它翻成"先同步一次再取图"的提示 —— 而不是在这里猜一个地址。
 *
 * `id` / `resId` / `md5` 仍然一起给上：宿主把它们用于日志与错误信息，
 * 而排查"为什么这张取不到"时需要知道当时按哪个键去找的。
 *
 * @param {any} entry
 * @returns {{id: string, resId: string, md5: string, url: string}}
 */
function refOf(entry) {
  const id = String(entry?.id ?? '');
  return {
    id,
    resId: String(entry?.resId ?? ''),
    md5: String(entry?.md5 ?? ''),
    url: runtime.urlById.get(id) ?? '',
  };
}

/* ============================================================== 工具：list */

/**
 * 列出表情库。
 *
 * `query` 与 `sticker_search` 的区别只在于"必填/可选"：
 * 列表是"让我看看有什么"，搜索是"找那种能怼人的"。两者共用同一份渲染。
 *
 * @param {any} ctx
 * @param {any} args
 * @returns {Promise<object>}
 */
async function toolList(ctx, args) {
  const cfg = configOf(ctx);
  if (!cfg.listEnabled) return fail('E_STICKER_DISABLED', '列表工具被管理员关掉了（listEnabled=false）');

  const got = await entriesOf(ctx, args?.refresh === true);
  if (!got.ok) return got;

  const count = clampInt(args?.count, 1, 200, cfg.maxListCount);
  const vision = resolveVisionState(ctx?.gateway);
  const rendered = formatList(got.entries, {
    query: String(args?.query ?? ''),
    limit: count,
    title: '本地表情库',
    // 列表本身不提交图片，所以这里只需要说明"这次没有看图"，而不是"视觉关着"
    notice: got.readonly
      ? `注意：表情库文件损坏或读不动，当前处于只读模式（${runtime.corruptMessage}）。列表仍可读，但记录与收藏会被拒绝。`
      : '',
  });

  const out = {
    ok: true,
    text: rendered.text,
    total: rendered.total,
    matched: rendered.matched,
    truncated: rendered.truncated,
    stickers: rendered.items.map(presentItem),
  };
  if (got.warning) out.warning = got.warning;
  // 同步失败/空列表的码也回给模型：它据此知道"这次看到的不一定是全量"
  if (got.code) out.code = got.code;
  out.vision = describeVision(vision);
  return out;
}

/* ============================================================ 工具：search */

/**
 * 按关键词搜索。
 *
 * 无命中返回 `matched: 0` 而不是错误：模型问"有没有能表达无语的表情"，
 * 答案是"没有"是一条有效信息；报错会让它以为工具坏了、反复重试。
 *
 * @param {any} ctx
 * @param {any} args
 * @returns {Promise<object>}
 */
async function toolSearch(ctx, args) {
  const cfg = configOf(ctx);
  if (!cfg.listEnabled) return fail('E_STICKER_DISABLED', '搜索工具被管理员关掉了（listEnabled=false）');

  const query = sanitizeText(args?.query, 60);
  if (!query) return fail('E_STICKER_NOT_FOUND', 'query 不能为空：想找什么样的表情？（比如「无语」「笑」「晚安」）');

  const got = await entriesOf(ctx, false);
  if (!got.ok) return got;

  const count = clampInt(args?.count, 1, 100, cfg.maxListCount);
  const rendered = formatList(got.entries, {
    query,
    limit: count,
    title: `搜索「${query}」`,
    notice: renderedNoticeForSearch(got),
  });

  const out = {
    ok: true,
    text: rendered.text,
    query,
    total: rendered.total,
    matched: rendered.matched,
    truncated: rendered.truncated,
    stickers: rendered.items.map(presentItem),
  };
  if (got.warning) out.warning = got.warning;
  // 同 list：同步失败要说出来，否则模型会以为"没有匹配"就是全部事实
  if (got.code) out.code = got.code;
  out.vision = describeVision(resolveVisionState(ctx?.gateway));
  return out;
}

/**
 * 搜索结果的补充说明。
 *
 * 搜索只匹配文字，**不涉及任何图片**。所以这里必须强调"按已有标签选的，
 * 没有看图" —— 否则模型会把"搜到了"理解成"我确认过那张图"。
 *
 * @param {any} got
 * @returns {string}
 */
function renderedNoticeForSearch(got) {
  const parts = ['以上是按已有备注/标签匹配的，没有看图。'];
  if (got?.readonly) parts.push('表情库当前只读（文件损坏或读不动），记录与收藏会被拒绝。');
  return parts.join('');
}

/* ============================================================= 工具：image */

/**
 * 取一张表情的图片给模型看。
 *
 * ## 三条诚实的边界
 *
 * 1. 视觉关着 / 状态未知 → **不返回 `images`**，并在文本里说清楚为什么。
 *    模型看不到图时，最危险的不是"没法判断"，而是"以为自己看到了"并开始描述。
 * 2. 超预算 → 只落盘、不返回 dataUrl。`tooLarge` 是一个**正常结果**，
 *    不是错误：发送仍然可以做，只是这次没法看。
 * 3. 动图 → 必须写明"这是动图，你看到的是第一帧"。GIF 的首帧常常是
 *    一个与整体动作无关的静止画面，模型据此推断"它会左右横跳"就是在编。
 *
 * @param {any} ctx
 * @param {any} args
 * @returns {Promise<object>}
 */
async function toolImage(ctx, args) {
  const cfg = configOf(ctx);
  if (!cfg.imageEnabled) return fail('E_STICKER_DISABLED', '看图工具被管理员关掉了（imageEnabled=false）');

  const id = requireIdentity(ctx);
  if (!id.ok) return id;

  const ref = String(args?.ref ?? '').trim();
  if (!ref) return fail('E_STICKER_NOT_FOUND', '缺少 ref：要指定哪一张表情（id / md5 都行）');

  const got = await entriesOf(ctx, false);
  if (!got.ok) return got;
  const entry = findEntry(got.entries, ref);
  if (!entry) {
    return fail('E_STICKER_NOT_FOUND', `表情库里没有「${ref}」这一条。可以先用 sticker_list 或 sticker_search 找它的 id。`, {
      ref,
      total: got.entries.length,
    });
  }

  const vision = resolveVisionState(ctx?.gateway);
  const notice = noVisionNotice(vision);

  /*
   * 视觉不可用时**根本不取图**。
   *
   * 不是为了省一次下载，而是为了不让"我这次取到了图"这种状态泄漏到返回结构里：
   * 一旦返回了 `file` / `bytes`，模型很容易顺着写"图我看到了"。
   * 只给文字资料，并把"没看图"写在最前面。
   */
  if (notice) {
    const sel = visionOffSelection(entry, {
      fallbackToTags: cfg.fallbackToTagsWhenVisionOff,
      notice,
    });
    if (!sel.ok) {
      return fail(sel.code, sel.message, { ...describeVision(vision), sticker: stickerBrief(entry) });
    }
    return {
      ok: true,
      text: `${sel.text}${entry.animated ? `\n${ANIMATED_NOTICE}` : ''}`,
      images: [],
      sticker: { ...stickerBrief(entry), tooLarge: false },
      vision: describeVision(vision),
    };
  }

  // 视觉可用：走宿主受控链路取图
  const gw = requireGateway(ctx);
  if (!gw.ok) return gw;
  const s = storeOf(ctx);
  if (!s.ok) return s;

  const ensured = await ensureFile({ ctx, gateway: gw.gateway, store: s.store, entry, cfg, alwaysFetch: true });
  if (!ensured.ok) {
    const e = /** @type {any} */ (ensured);
    return { ...fail(e.code, e.message), sticker: stickerBrief(entry), vision: describeVision(vision) };
  }
  const cur = ensured.entry;
  const fetched = ensured.fetched;

  /*
   * `dataUrl` 只从这一次的取图结果里来。
   *
   * 这里刻意不像某些实现那样"从磁盘把缓存文件读回来再 base64 一次"：
   * 那会让"库里有缓存"变成"我随时能看图"的第二个来源，而两个来源迟早不一致
   * （缓存被清、图被换）。只认宿主这一次给的，语义才是单一的。
   */
  const dataUrl = String(fetched?.dataUrl ?? '');
  const tooLarge = fetched ? fetched.tooLarge === true : false;

  /** @type {string[]} */
  const lines = [];
  const label = cur.desc || cur.localNote || `表情 ${cur.id}`;
  lines.push(`这张表情：${label}。`);

  if (cur.animated) lines.push(ANIMATED_NOTICE);

  if (tooLarge) {
    lines.push(tooLargeNotice(fetched?.bytes ?? cur.bytes, cfg.maxImageBytes));
    lines.push('（发送不受这个预算影响，仍然可以直接 sticker_send。）');
  } else if (!dataUrl) {
    lines.push('这次没有拿到可提交的图片数据，所以我看不到它；下面只有文字资料。');
  }

  if (!dataUrl && (cur.localNote || cur.tags.length || cur.usage)) {
    if (cur.localNote) lines.push(`我记的含义：「${cur.localNote}」。`);
    if (cur.tags.length) lines.push(`标签：${cur.tags.join('、')}。`);
    if (cur.usage) lines.push(`用法：「${cur.usage}」。`);
    lines.push('这些是文字资料，不是这张图长什么样。');
  }

  if (dataUrl) lines.push('下面是这张表情的图片。请只描述你真正看到的内容；不要补充看不到的部分。');

  const images = dataUrl
    ? [
        {
          dataUrl,
          mime: String(fetched?.mime ?? cur.mime ?? 'image/png'),
          label: sanitizeText(label, 60),
        },
      ]
    : [];

  return {
    ok: true,
    text: lines.filter(Boolean).join('\n'),
    images,
    sticker: {
      ...stickerBrief(cur),
      tooLarge,
    },
    vision: describeVision(vision),
  };
}

/* ============================================================== 工具：note */

/**
 * 记录一张表情的含义（只写本地库）。
 *
 * ## 为什么它不是"收藏"
 *
 * 收藏是往 **QQ 账号**里加一张图（`sticker_collect`），记录含义只写本地
 * `library.json`。两者在界面上、返回文本里都不许混 —— 混了之后用户会以为
 * 账号里多了一张图，其实只在自己的插件目录里多了一条记录，换台机器就没了。
 *
 * @param {any} ctx
 * @param {any} args
 * @returns {Promise<object>}
 */
async function toolNote(ctx, args) {
  const cfg = configOf(ctx);
  if (!cfg.noteEnabled) return fail('E_STICKER_DISABLED', '记录工具被管理员关掉了（noteEnabled=false）');

  // 归属仍然要校验：这个库是账号级的，但"谁在写"要能进日志
  const id = requireIdentity(ctx);
  if (!id.ok) return id;

  const ro = requireWritable();
  if (!ro.ok) return ro;

  const ref = String(args?.ref ?? '').trim();
  if (!ref) return fail('E_STICKER_NOT_FOUND', '缺少 ref：要记录哪一张表情的含义？');

  const hasNote = args?.note !== undefined && args?.note !== null;
  const hasTags = args?.tags !== undefined && args?.tags !== null;
  const hasUsage = args?.usage !== undefined && args?.usage !== null;
  /*
   * 三个内容参数至少给一个。
   *
   * 全空时如果照常"更新"一次，语义是"把这些字段都清空"—— 那几乎从来不是
   * 调用方的意思（多半是参数丢了），而它会静默抹掉 AI 之前记下的认知。
   * 所以宁可直接拒绝，让模型发现自己少传了东西。
   */
  if (!hasNote && !hasTags && !hasUsage) {
    return fail('E_STICKER_EMPTY_PATCH', 'note / tags / usage 至少要给一个；一个都不给就不算"记录了什么"。', {
      ref,
      hint: '例如：{"note": "无语时用", "tags": ["无语"]}',
    });
  }

  const s = storeOf(ctx);
  if (!s.ok) return s;

  /** @type {any} */
  let updated = null;
  /** @type {any} */
  let notFound = false;
  try {
    await s.store.update((doc) => {
      const r = applyNote(doc.entries, ref, {
        note: hasNote ? args.note : undefined,
        tags: hasTags ? args.tags : undefined,
        usage: hasUsage ? args.usage : undefined,
      });
      if (!r.entry) {
        notFound = true;
        throw Object.assign(new Error('没找到这条表情'), { code: 'E_STICKER_NOT_FOUND' });
      }
      doc.entries = r.entries;
      updated = r.entry;
      return doc;
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.code === 'E_STICKER_NOT_FOUND' || notFound) {
      return fail('E_STICKER_NOT_FOUND', `表情库里没有「${ref}」这一条，先确认 id 再记录。`, { ref });
    }
    return storeFail(e);
  }

  /** @type {string[]} */
  const lines = [`已记录到本地库（不是 QQ 收藏）：${updated.desc || updated.localNote || updated.id}。`];
  if (updated.localNote) lines.push(`含义：「${updated.localNote}」`);
  if (updated.tags.length) lines.push(`标签：${updated.tags.join('、')}`);
  if (updated.usage) lines.push(`用法：「${updated.usage}」`);
  lines.push('这份记录只在这个机器人里生效，QQ 客户端的备注没有变。');

  return {
    ok: true,
    text: lines.join('\n'),
    id: updated.id,
    entry: toItemView(updated),
  };
}

/* =========================================================== 工具：collect */

/**
 * 把当前会话里的一张图收藏进 QQ 账号。
 *
 * ## 顺序是刻意排的
 *
 *   1. 归属（`ctx.caller.convKey`）—— 没有身份就没有"当前会话"；
 *   2. 频次闸门 —— **在调网关之前**判定。放在后面等于"拒绝了但已经花掉一次动作"；
 *   3. 本地 sha256 / 账号侧 md5 去重 —— 都要在写账号之前；
 *   4. `gateway.collectFace` —— 只有它返回 `emojiId` 才算成功。
 *
 * 第 4 步之后才写 `origin:'qq'` 条目。网关不支持时原样报
 * `E_GATEWAY_UNSUPPORTED`，**绝不**写一条本地条目然后说"收藏好了"：
 * 那会让用户以为账号里多了一张图，实际只在自己的插件目录里多了一行记录。
 *
 * ## 去重为什么需要先同步一次
 *
 * 本地库只知道自己见过的图；账号侧的 md5 列表才是"这张图已经在收藏里了"的
 * 第二道证据。所以收藏前强制同步一次（force），哪怕 TTL 还没过 ——
 * 重复收藏在 QQ 那边会得到一张重复的表情，删起来要人手动去点。
 *
 * @param {any} ctx
 * @param {any} args
 * @returns {Promise<object>}
 */
async function toolCollect(ctx, args) {
  const cfg = configOf(ctx);
  if (!cfg.collectEnabled) return fail('E_STICKER_DISABLED', '收藏功能被管理员关掉了（collectEnabled=false）');

  const id = requireIdentity(ctx);
  if (!id.ok) return id;

  const ro = requireWritable();
  if (!ro.ok) return ro;

  const messageId = toMessageId(args?.messageId);
  if (messageId === '' || messageId === null || messageId === undefined) {
    return fail('E4073', '缺少 messageId：要收藏当前会话里哪一条消息里的图？');
  }
  const index = clampInt(args?.index, 0, 3, 0);
  const remark = clampInt(cfg.maxRemarkChars, 0, 50, 20);

  /*
   * 频次闸门放在最早的可用位置（身份之后）。
   *
   * 它必须在**任何会碰网关的动作之前**：收藏是账号级写操作，
   * 一次被限流的调用如果已经打到网关，那就已经花了钱/时间，而且还可能
   * 真的收进去（只是我们这边判失败），用户看到的是"说被限流了，但收藏里多了一张"。
   */
  const quota = runtime.limiter.checkCollect({ perHour: cfg.collectPerHour });
  if (!quota.ok) {
    return fail(quota.code, quota.message, quota.retryAfterMs ? { retryAfterMs: quota.retryAfterMs } : {});
  }

  const gw = requireGateway(ctx);
  if (!gw.ok) return gw;
  const s = storeOf(ctx);
  if (!s.ok) return s;

  /*
   * 先同步一次再判断重复。
   *
   * 同步失败**不阻断收藏**：可能只是列表拉不动，而收藏本身是另一个动作。
   * 但要在返回里带上 warning，让用户知道"这次没比对账号侧的重复"。
   */
  const sync = await syncLibrary({ ctx, gateway: gw.gateway, store: s.store, cfg, force: true });
  const knownEntries = sync.ok ? sync.entries : [];

  /*
   * ## 收藏前唯一能做的去重：来源消息 + 下标
   *
   * 契约 §5 把"同 sha256 / 同 md5 → 拒绝"排在"调 add_custom_face"之前，
   * 但这两条判据都需要**这张图的字节**，而字节要等 `collectFace` 取回来才拿得到
   * （`collectFace` 的返回里才有 `sha256` / `md5`）。也就是说那一节给出的顺序
   * 在实现上无法严格执行 —— 这是契约里的一处自相矛盾，已在交付报告里提出。
   *
   * 能严格前置的只有一条，而它恰好覆盖了最常见的那种重复：**模型重试同一次收藏**。
   * 同一张图来自同一条消息的同一个图片段，这条事实在调用网关之前就是已知的。
   * 所以先按它拦一次，真正花掉 `add_custom_face` 的情况就只剩"这张图在别处出现过"。
   */
  const sameSource = knownEntries.find(
    (e) => String(e.sourceMessageId ?? '') === String(messageId) && Number(e.sourceIndex ?? 0) === Number(index),
  );
  if (sameSource) {
    return fail(
      'E_STICKER_DUPLICATE',
      `这条消息里的第 ${index + 1} 张图已经收藏过了：id=${sameSource.id}。不用再收一次，直接用这个 id 就行。`,
      { existingId: sameSource.id, existing: toItemView(sameSource) },
    );
  }

  // QQ 侧备注：只取调用方显式给的 desc，按 maxRemarkChars 截断
  const desc = remark > 0 ? sanitizeText(args?.desc, remark) : '';

  const collected = await gw.gateway.collectFace?.({ messageId, index, desc });
  if (!collected || collected.ok !== true) {
    /*
     * 原样透传。
     *
     * 这一条尤其重要：`E4074`（不属于当前会话）、`E_STICKER_SELF_COLLECT`、
     * `E_STICKER_NO_IMAGE`、`E_GATEWAY_UNSUPPORTED` 是四件完全不同的事，
     * 包成同一个"收藏失败"会让用户无从下手。
     */
    return { ...gatewayFail(collected), warning: sync.warning ?? '' };
  }

  const emojiId = String(collected.emojiId ?? '').trim();
  if (!emojiId) {
    /*
     * 网关报成功但没给 id —— 不能当成功（契约 §9.1 的 E_STICKER_COLLECT_NO_ID）。
     *
     * 宿主这一层已经拦了同样的情形，这里再判一次是因为"收藏成功"是这个插件里
     * 唯一不可撤销的动作：写成成功却对不上账号里的任何一条，用户永远查不明白。
     */
    return fail('E_STICKER_COLLECT_NO_ID', '网关收藏成功但没返回 emoji_id，无法确认收藏结果，因此没有写进本地库。', {
      warning: String(collected.warning ?? ''),
    });
  }

  const sha256 = String(collected.sha256 ?? '').trim();
  const md5 = String(collected.md5 ?? '').trim().toUpperCase();

  /*
   * 去重（契约 §5 第 4 步）。
   *
   * 顺序是"先本地 sha256，再账号侧 md5"：前者是"我本来就有这张图"（确定），
   * 后者是"账号列表里有一张同样 md5 的"（稍弱，但同一张图的 md5 必然相同）。
   *
   * 注意这里在**收藏之后**判：字节是网关取回来的，在此之前我们算不出 sha256。
   * 所以真正的防重复闸门是下面这两条 —— 一旦命中，就说明这次收藏是多余的，
   * 返回 `E_STICKER_DUPLICATE` 并带上已有条目 id，让模型直接引用那一条。
   */
  const dupBySha = sha256 ? knownEntries.find((e) => e.sha256 && e.sha256 === sha256) : null;
  const dupByMd5 = md5 ? knownEntries.find((e) => e.md5 && e.md5 === md5 && e.id !== emojiId) : null;
  const dup = dupBySha || dupByMd5;
  if (dup) {
    const which = dupBySha ? '同一张图（sha256 相同）' : '同一张图（md5 相同）';
    return fail(
      'E_STICKER_DUPLICATE',
      `${which}已经在表情库里了：id=${dup.id}${dup.desc || dup.localNote ? `（${dup.desc || dup.localNote}）` : ''}。` +
        '不用再收一次，直接用它就行。QQ 账号那边这次可能多了一张重复的表情，需要的话请到 QQ 里删掉。',
      {
        existingId: dup.id,
        existing: toItemView(dup),
        emojiId,
        warning: String(collected.warning ?? ''),
      },
    );
  }

  const stamp = nowIso();
  const entry = normalizeEntry({
    id: emojiId,
    resId: emojiId,
    md5,
    sha256,
    mime: String(collected.mime ?? ''),
    animated: collected.animated === true,
    origin: 'qq',
    /*
     * ## `desc` 与 `note` 是两个不同的地方（契约 §3.1）
     *
     * `desc` 写进 **QQ 账号**的表情备注 —— 在 QQ 客户端里也看得见；
     * `note` 只写进**本地库**的 `localNote` —— 只有这个插件/模型看得到。
     *
     * 所以：只给 `desc` 时本地 `localNote` 留空，**不复制** `desc`。
     * 复制之后两处会开始漂移：用户下次在 QQ 里改了备注，本地那份还是旧的，
     * 而模型会拿旧的去选图。宁可让本地空着（它会显示"还没备注"），
     * 也不要留一份会过期的副本。
     */
    desc: String(collected.desc ?? desc ?? ''),
    localNote: args?.note !== undefined && args?.note !== null ? args.note : '',
    tags: Array.isArray(args?.tags) ? args.tags : [],
    sourceMessageId: String(messageId),
    sourceIndex: index,
    sourceConvKey: id.convKey,
    createdAt: stamp,
    updatedAt: stamp,
  });

  if (!entry) {
    return fail('E_STICKER_STORE_READONLY', '收藏成功了，但生成的条目形状不合法（id 为空），没有写进本地库。');
  }

  /** @type {any} */
  let saved = entry;
  try {
    await s.store.update((doc) => {
      const exists = doc.entries.findIndex((e) => e.id === entry.id);
      if (exists >= 0) {
        // 同一个 emojiId 已经在库里（可能刚刚被同步拉进来）：合并而不是重复插入
        doc.entries[exists] = normalizeEntry({ ...doc.entries[exists], ...entry, localNote: doc.entries[exists].localNote || entry.localNote }) ?? entry;
        saved = doc.entries[exists];
        return doc;
      }
      doc.entries.push(entry);
      return doc;
    });
  } catch (err) {
    /*
     * 账号侧已经收进去了，但本地没记住。
     *
     * 这不该报成"收藏失败"（那会让用户重试、再收一张重复的），
     * 而是明说"QQ 里有了、本地没记上"，并在 warning 里给出 emojiId。
     */
    return {
      ok: true,
      text: `QQ 收藏成功了（emojiId=${emojiId}），但写本地库失败：${String(/** @type {any} */ (err)?.message ?? err)}。下次同步会把它拉回来。`,
      emojiId,
      entry: null,
      warning: `本地库写入失败：${String(/** @type {any} */ (err)?.message ?? err)}`,
    };
  }

  // 真的收藏成功才占频次
  runtime.limiter.takeCollect();

  const warning = String(collected.warning ?? '');
  /** @type {string[]} */
  const lines = [`已经把这张图收藏进你的 QQ 账号（emojiId=${emojiId}）。`];
  if (warning) lines.push(`注意：${warning}（收藏本身成功了。）`);
  if (saved.desc) lines.push(`QQ 备注：「${saved.desc}」`);
  if (saved.localNote) lines.push(`本地含义：「${saved.localNote}」`);
  lines.push('引用它时用 id=' + saved.id + '。收藏只影响 QQ 账号，别的会话也能看到。');

  return {
    ok: true,
    text: lines.join('\n'),
    emojiId,
    entry: toItemView(saved),
    warning,
    syncWarning: sync.warning ?? '',
  };
}

/* ============================================================== 工具：send */

/**
 * 往当前会话发一张表情。
 *
 * ## 一个气泡一张表情
 *
 * `gateway.sendFace` 内部组装的是 `reply? → at? → image`，**没有文字段**。
 * 想说话请另外发一条文本 —— 把文字塞进表情气泡会让一件事看起来像两件。
 *
 * ## 先过插件层闸门，再调网关
 *
 * 频次判定必须在 `sendFace` **之前**：放在后面的话，被拒的那次其实已经发出去了，
 * 而返回是"失败"，模型会重试 —— 于是真的刷屏。
 *
 * ## 发送成功才记账
 *
 * `markUsed` 只在 `sendFace` 返回 ok 之后调用。失败的发送什么都没发生，
 * 却让 `useCount` +1，会让"常用表情"变成一个随机数。
 *
 * @param {any} ctx
 * @param {any} args
 * @returns {Promise<object>}
 */
async function toolSend(ctx, args) {
  const cfg = configOf(ctx);
  if (!cfg.sendEnabled) return fail('E_STICKER_DISABLED', '发送表情被管理员关掉了（sendEnabled=false）');

  const id = requireIdentity(ctx);
  if (!id.ok) return id;

  const ref = String(args?.ref ?? '').trim();
  if (!ref) return fail('E_STICKER_NOT_FOUND', '缺少 ref：要发哪一张表情？');

  /*
   * `atUserId` 只在群聊可用。
   *
   * 这一条在插件侧先判一次（宿主 `sendFace` 也会判）：私聊里 @ 人不是错误配置，
   * 而是模型理解错了场景，早一点把话说清楚，它下一步就能改对。
   */
  const atRaw = String(args?.atUserId ?? '').trim();
  if (atRaw && !id.isGroup) {
    return fail('E_STICKER_TARGET_NOT_GROUP', '这是私聊，不能 @ 人（atUserId 只在群聊里有效）。去掉它再发。');
  }
  if (atRaw && !/^\d{1,20}$/.test(atRaw)) {
    return fail('E4073', 'atUserId 必须是 QQ 号（纯数字）。');
  }

  const replyTo = toMessageId(args?.replyToMessageId);

  const quota = runtime.limiter.checkSend({ perHour: cfg.sendPerHour, minIntervalMs: cfg.sendMinIntervalMs });
  if (!quota.ok) {
    return fail(quota.code, quota.message, quota.retryAfterMs ? { retryAfterMs: quota.retryAfterMs } : {});
  }

  const got = await entriesOf(ctx, false);
  if (!got.ok) return got;
  const entry = findEntry(got.entries, ref);
  if (!entry) {
    return fail('E_STICKER_NOT_FOUND', `表情库里没有「${ref}」这一条。先用 sticker_list / sticker_search 找到它的 id。`, {
      ref,
      total: got.entries.length,
    });
  }

  const gw = requireGateway(ctx);
  if (!gw.ok) return gw;
  const s = storeOf(ctx);
  if (!s.ok) return s;

  // 发送需要本地缓存文件；没有就现取一次（原样落盘，不转码、不抽帧）
  const ensured = await ensureFile({ ctx, gateway: gw.gateway, store: s.store, entry, cfg });
  if (!ensured.ok) {
    const e = /** @type {any} */ (ensured);
    return { ...fail(e.code, e.message), sticker: stickerBrief(entry) };
  }
  const cur = ensured.entry;

  const sendArgs = {
    file: cur.file,
    // 审计文本（不含路径）：让出站流水里能看出"这是哪张表情"
    label: sanitizeText(cur.desc || cur.localNote || cur.id, 60),
  };
  if (replyTo !== '' && replyTo !== null && replyTo !== undefined) sendArgs.replyToMessageId = replyTo;
  if (atRaw) sendArgs.atUserId = atRaw;

  const sent = await gw.gateway.sendFace?.(sendArgs);
  if (!sent || sent.ok !== true) {
    /*
     * 原样透传闸门/网关的码（`E2020` / `E2030` / `E20XX` / `E4074` / …）。
     *
     * 特别地：**不增加 useCount**。这次什么都没发出去，记账会让
     * "常用表情"排序变成噪声。
     */
    return { ...gatewayFail(sent), sticker: stickerBrief(cur) };
  }

  // 只有真的发出去了才记账
  runtime.limiter.takeSend();

  /** @type {any} */
  let used = cur;
  try {
    await s.store.update((doc) => {
      const r = markUsed(doc.entries, cur.id, { convKey: id.convKey });
      if (!r.entry) return doc;
      doc.entries = r.entries;
      used = r.entry;
      return doc;
    });
  } catch (err) {
    // 记账失败不影响"已经发出去了"这件事实，也不该让工具报失败
    ctx?.log?.('warn', '表情发送成功但使用次数写回失败', {
      message: String(/** @type {any} */ (err)?.message ?? err),
    });
  }

  /*
   * 返回文本刻意很短。
   *
   * 宿主已经在发送成功后 `pushRecent(convKey, {role:'assistant', text:'[表情]'})`，
   * 模型下一轮看得见这件事。返回里再堆一句"我发了个表情"，它会顺手在最终回答里
   * 复述一遍 —— 用户就会看到一条多余的话。
   */
  return {
    ok: true,
    text: `已发送表情 ${used.id}${used.animated ? '（动图原样发送，没有转码）' : ''}。不用再复述"我发了个表情"。`,
    messageId: sent.messageId ?? null,
    sticker: { id: used.id, useCount: used.useCount },
  };
}

/* ================================================================== 视图 */

/**
 * 条目对外视图（对齐契约 §3.1 的字段表）。
 *
 * `hasImage` 是"本地有没有缓存文件"，而不是"能不能取到图"：
 * 前者是本地事实，后者要打一次网络才知道，不该让列表工具变慢。
 *
 * @param {any} entry
 * @returns {object}
 */
function presentItem(entry) {
  const v = toItemView(entry);
  if (!v) return null;
  return {
    id: v.id,
    desc: v.desc,
    localNote: v.localNote,
    tags: v.tags,
    usage: v.usage,
    useCount: v.useCount,
    animated: v.animated,
    hasImage: Boolean(v.file),
  };
}

/**
 * `sticker_image` / `sticker_send` 里附带的最小条目摘要。
 *
 * 不返回 `dataUrl`（那在 `images` 里）也不返回 `file` 之外的路径：
 * 模型用不到本机路径，而日志里出现它只会让人误以为能用。
 *
 * @param {any} entry
 * @returns {object}
 */
function stickerBrief(entry) {
  return {
    id: String(entry?.id ?? ''),
    desc: String(entry?.desc ?? ''),
    localNote: String(entry?.localNote ?? ''),
    tags: Array.isArray(entry?.tags) ? entry.tags.slice() : [],
    animated: entry?.animated === true,
  };
}

/**
 * 视觉状态的结构化回显。
 *
 * 为什么要把"插件看到的是什么"也返回：排查"为什么它说不认识这张图"时，
 * 第一个要确认的就是插件当时拿到的 `enabled` / `known`。
 *
 * @param {{enabled: boolean, known: boolean, supported: boolean | null}} vision
 * @returns {object}
 */
function describeVision(vision) {
  return {
    enabled: vision.enabled === true,
    known: vision.known === true,
    supported: vision.supported === null ? null : vision.supported === true,
  };
}

/* ================================================================== 生命周期 */

export default {
  /**
   * 初始化。
   *
   * 这里做三件事：
   *   1. 建存储实例、读一次库（**这是只读降级的判定点**）；
   *   2. 清掉没有任何条目引用的孤儿缓存（上次崩溃留下的半成品）；
   *   3. `syncOnInit` 时预热一次同步。
   *
   * ## 为什么"库坏了"不让 init 失败
   *
   * 一个损坏的 `library.json` 不该让整个插件起不来 —— 那会把"读不了也发不了"
   * 变成"连数据库都进不去"。正确的行为是：插件正常启动，读取类工具照常可用，
   * 写工具明确拒绝。所以这里**不抛**，只把 `writable` 置 false 并 warning。
   *
   * @param {any} ctx
   */
  async init(ctx) {
    const dataDir = String(ctx?.dataDir ?? ctx?.plugin?.dataDir ?? '');
    const cfg = normalizeConfig(ctx?.config);

    runtime = freshRuntime();
    runtime.config = cfg;
    runtime.initAt = Date.now();

    if (!dataDir) {
      ctx?.log?.('warn', '宿主没有提供 dataDir，表情库无法读写');
      return { ok: true };
    }

    const store = new StickerStore({ dataDir, log: (l, m, f) => ctx?.log?.(l, m, f) });
    runtime.store = store;

    // 读一次库：这一步决定 writable。读成功不代表马上要写，但"读得动"是能写的前提。
    const loaded = await loadLibrary(store, ctx);
    if (loaded.ok) {
      runtime.syncedAt = Number(loaded.doc.syncedAt) || 0;
      runtime.syncComplete = loaded.doc.lastSyncComplete === true;
      runtime.lastError = loaded.doc.lastError ?? null;

      // 孤儿缓存回收：只在读库成功时做（读不到条目就分不清谁是孤儿，
      // 那时候删文件等于把还能用的缓存一起删了）
      try {
        await store.pruneOrphans(loaded.doc.entries);
      } catch (err) {
        ctx?.log?.('warn', '清理孤儿表情缓存失败（不影响使用）', {
          message: String(/** @type {any} */ (err)?.message ?? err),
        });
      }
    }

    ctx?.log?.('info', '表情包插件已初始化', {
      dataDir,
      writable: runtime.writable,
      entries: loaded.ok ? loaded.doc.entries.length : 0,
      syncOnInit: cfg.syncOnInit,
    });
    return { ok: true };
  },

  /**
   * 执行工具。
   *
   * @param {{tool: string, args: object, ctx: any, signal?: AbortSignal}} input
   */
  async callTool({ tool, args, ctx, signal }) {
    // 取消：宿主点了「停止」/ 回合超时 / 插件被停用
    if (signal?.aborted || ctx?.signal?.aborted) {
      return { ok: false, code: 'E4070', message: '调用已取消' };
    }

    const name = String(tool ?? '');
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

    try {
      switch (name) {
        case 'sticker_list':
          return await toolList(ctx, a);
        case 'sticker_search':
          return await toolSearch(ctx, a);
        case 'sticker_image':
          return await toolImage(ctx, a);
        case 'sticker_note':
          return await toolNote(ctx, a);
        case 'sticker_collect':
          return await toolCollect(ctx, a);
        case 'sticker_send':
          return await toolSend(ctx, a);
        default:
          return fail('E4041', `未知工具：${name}`);
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.code === 'E4070' || e?.name === 'AbortError') {
        return { ok: false, code: 'E4070', message: '调用已取消' };
      }
      ctx?.log?.('error', '表情包工具执行异常', { tool: name, message: String(e?.message ?? e) });
      // 兜底：仍然返回结构化结果，让模型知道失败了，而不是让整个回合炸掉
      return fail('E_STICKER_INTERNAL', `表情包插件内部错误：${String(e?.message ?? e)}`);
    }
  },

  /**
   * 自检。
   *
   * ## 为什么这里不做同步
   *
   * `ctx.gateway` 在 `testConnection` 里**不存在**（契约 §1：它只在 callTool
   * 期间存在）。所以自检只能看本地：配置是否合理、库能不能读、缓存有几个。
   * 点一下"测试连接"就打一次网关、还可能因为限流让用户白等 8 秒，是最讨厌的自检。
   *
   * 这里也**不写**任何东西 —— 包括不建目录、不清缓存。
   *
   * @param {any} ctx
   */
  async testConnection(ctx) {
    const cfg = normalizeConfig(ctx?.config);
    const dataDir = String(ctx?.dataDir ?? ctx?.plugin?.dataDir ?? '');
    if (!dataDir) {
      return { ok: false, message: '宿主没有提供插件数据目录，表情库无处存放' };
    }

    // 注意：ctx.gateway 在这里是 undefined，一切与网关相关的判断都必须判空
    const gw = ctx?.gateway ?? null;
    const gatewayNote = gw ? `网关已注入（available=${gw.available === true}）` : '网关未注入（自检期间不存在，正常）';

    try {
      const store = new StickerStore({ dataDir });
      const stat = await store.stat();
      if (stat.corrupt) {
        return {
          ok: false,
          message: `表情库不可读，插件当前只读：${stat.message}`,
          details: { dataDir, file: stat.file, bytes: stat.bytes, faces: stat.faces, writable: false, gateway: gatewayNote },
        };
      }
      return {
        ok: true,
        message: `就绪（本地 ${stat.exists ? `已有库文件 ${Math.round(stat.bytes / 1024)}KB` : '还没有库文件，首次使用'}；缓存 ${stat.faces} 张；${gatewayNote}）`,
        details: {
          dataDir,
          file: stat.file,
          exists: stat.exists,
          bytes: stat.bytes,
          faces: stat.faces,
          writable: stat.ok,
          gateway: gatewayNote,
          config: {
            maxListCount: cfg.maxListCount,
            maxImageBytes: cfg.maxImageBytes,
            collectPerHour: cfg.collectPerHour,
            sendPerHour: cfg.sendPerHour,
            sendMinIntervalMs: cfg.sendMinIntervalMs,
            syncTtlMs: cfg.syncTtlMs,
          },
        },
      };
    } catch (err) {
      return { ok: false, message: `数据目录不可用：${String(/** @type {any} */ (err)?.message ?? err)}` };
    }
  },

  /**
   * 停用 / 重载前释放。
   *
   * 不落盘：所有写操作都是"写完才返回"，没有待刷新的缓冲。
   * 限频计数随实例一起丢掉 —— 它本来就是进程内存的（契约 §6.1：
   * 重启清零，那是节流而不是安全边界）。
   *
   * @param {any} ctx
   */
  async dispose(ctx) {
    runtime.limiter.reset();
    runtime = freshRuntime();
    ctx?.log?.('debug', '表情包插件已释放');
  },
};
