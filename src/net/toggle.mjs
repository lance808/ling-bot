/**
 * 联网总闸的切换语义 —— 可测试的纯编排
 *
 * ## 为什么单独一个文件
 *
 * 「关闭联网」不是一次普通的配置写入，它有两个**顺序要求**：
 *
 *   1. **先生效、后落盘**：用户点关闭的那一刻，在途搜索必须立刻停。
 *      如果先 `await persistConfig()`（磁盘慢、杀毒软件扫描、网络盘），
 *      这几百毫秒里请求仍在跑 —— 用户看到的是"我关了它还在联网"。
 *   2. **落盘失败保持关闭**：写配置失败时绝不能把内存里的开关反弹回 true。
 *      那会让界面显示"开"，而用户以为已经关了。
 *
 * 打开则是反过来：先确认保存成功再生效。保存失败时保持关闭是安全方向。
 *
 * 把这些顺序写进 `index.mjs` 的 RPC 分支里，就只能靠集成测试去验证；
 * 抽成这个文件之后，顺序与失败路径都能用假 `commit/save/abortInflight`
 * 直接钉住。
 *
 * ## 返回形状
 *
 * 所有路径都返回对象、不抛异常：设置通道要把结果翻译成一个错误码给界面。
 * `ok:false` 不代表"没做任何事"—— 关闭失败时 `closed:true` 说明
 * **安全方向已经生效**，只是没保存成功。界面必须把这句话读给用户。
 */

/** 配置保存失败（联网状态已按安全方向生效，但下次启动可能不同） */
export const NET_TOGGLE_SAVE_FAILED = 'E4089';

/**
 * 切换联网总闸。
 *
 * @param {object} input
 * @param {boolean} input.value 目标值（只认真正的布尔）
 * @param {() => void} [input.commit] 同步改内存中的配置
 * @param {(value: boolean) => Promise<void>} [input.save] 持久化（写盘）
 * @param {() => number} [input.abortInflight] 中止在途请求，返回中止数量
 * @returns {Promise<{
 *   ok: boolean,
 *   value: boolean,
 *   persisted: boolean,
 *   closed: boolean,
 *   aborted: number,
 *   abortError?: string,
 *   code?: string,
 *   message?: string,
 * }>}
 */
export async function applyNetworkToggle(input = {}) {
  const value = input?.value;
  if (typeof value !== 'boolean') {
    return {
      ok: false,
      value: false,
      persisted: false,
      closed: true,
      aborted: 0,
      code: 'E40XX',
      message: 'network.enabled 必须是布尔值（true / false，不要写成字符串）',
    };
  }

  const commit = typeof input?.commit === 'function' ? input.commit : () => {};
  const save = typeof input?.save === 'function' ? input.save : async () => {};
  const abortInflight = typeof input?.abortInflight === 'function' ? input.abortInflight : () => 0;

  /* -------------------------------------------------- 打开 */
  if (value === true) {
    /*
     * 打开先保存：保存失败时开关仍是关着的，用户不会以为"已经开了"。
     * 这里没有"在途请求"要中止 —— 关着的时候本来就不该有。
     */
    try {
      await save(true);
    } catch (error) {
      return {
        ok: false,
        value: false,
        persisted: false,
        closed: true,
        aborted: 0,
        code: NET_TOGGLE_SAVE_FAILED,
        message: `没有打开联网：保存配置失败（${messageOf(error)}）。联网仍保持关闭。`,
      };
    }
    commit(true);
    return { ok: true, value: true, persisted: true, closed: false, aborted: 0 };
  }

  /* -------------------------------------------------- 关闭 */
  // 1) 同步生效：从这一刻起新的 search/fetch 会被总闸拒绝
  commit(false);

  // 2) 中止在途请求：失败不能阻止关闭（关闭已经生效），但必须报告
  let aborted = 0;
  let abortError = '';
  try {
    const raw = abortInflight();
    /*
     * 只接受真正的数字：字符串 `'3'`、null、NaN 一律归一成 0。
     * 这里不是"容错"而是口径问题 —— 统计里的"中止了几个"必须是
     * 宿主自己数出来的整数，而不是某个实现顺手返回的字符串。
     */
    const n = typeof raw === 'number' ? raw : Number.NaN;
    aborted = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  } catch (error) {
    abortError = messageOf(error);
  }

  // 3) 最后落盘
  try {
    await save(false);
  } catch (error) {
    return {
      ok: false,
      value: false,
      persisted: false,
      closed: true,
      aborted,
      abortError,
      code: NET_TOGGLE_SAVE_FAILED,
      message:
        `联网已经关闭${aborted > 0 ? `（中止了 ${aborted} 个在途请求）` : ''}，但保存配置失败：`
        + `${messageOf(error)}。本次运行仍是关闭状态；下次启动可能恢复成开启，请检查配置文件权限。`,
    };
  }

  return {
    ok: true,
    value: false,
    persisted: true,
    closed: true,
    aborted,
    ...(abortError ? { abortError } : {}),
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}
