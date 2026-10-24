/**
 * `ctx.caller` 的形状 —— 两端（in-process / process）共用同一份构造
 *
 * ## 为什么需要一个单独的小模块
 *
 * `ctx.caller` 必须在两种运行时下**逐字段相同**（docs/plugin-api.md §5.5）。
 * 原来的实现是两处各写一段：in-process 用 `{...invocation}` 展开，
 * `child-runner` 直接把父进程下发的对象挂上去。两段代码看起来"一样"，
 * 但有一个关键差异：
 *
 *   · executor 里 `makeInvocation` 产出的是 `Object.freeze` 过的对象；
 *   · in-process 的 `{...invocation}` **展开出一个新的、未冻结的对象** ——
 *     冻结属性在这一步被丢掉了；
 *   · `process` 侧收到的是 JSON 反序列化出来的普通对象，本来就没冻结。
 *
 * 于是文档许诺的"`caller` 是冻结的，想改一下 origin 再调自己会失败"
 * 在两种运行时里**都不成立**。它不是提权（真正的判定用的是宿主闭包里的
 * invocation），但它让"上下文不可变"这条纪律变成了一句空话：插件把
 * `ctx.caller.origin` 改掉之后，自己后续的日志、审计、甚至别的分支判断
 * 都会读到假值，而宿主那边什么都没变 —— 排查时看到的是自相矛盾的两份事实。
 *
 * 所以把"按契约形状归一 + 冻结"收在一处，两端都调它：一份实现，
 * 就不会再出现"某天只改了其中一边"的漂移。
 *
 * ## 为什么不直接 `Object.freeze(invocation)`
 *
 * 因为 `requester` 是嵌套对象：只冻结外层，`ctx.caller.requester.id = 'x'`
 * 仍然能改。冻结必须递归到这一层 —— 而这正是插件最容易顺手写的地方
 * （把 requester 记下来、改个昵称再发）。
 */

/**
 * 把一份调用上下文归一成契约形状并**递归冻结**。
 *
 * 输入允许是 `undefined` / `null`（宿主没给可信上下文时），此时返回 `null`：
 * 不能编一个 `convKey: ''` 的假上下文 —— 插件会拿它去读一个不存在的会话，
 * 而错误信息会指向"会话读不到"，不是"这次调用没有上下文"。
 *
 * @param {any} invocation 宿主构造的调用上下文（executor 的 makeInvocation）
 * @returns {Readonly<object> | null}
 */
export function freezeCaller(invocation) {
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) return null;

  const convKey = String(invocation.convKey ?? '');
  const requester = invocation.requester && typeof invocation.requester === 'object' ? invocation.requester : {};

  /*
   * 字段逐个挑出来，而不是 `{...invocation}`：
   *
   * 展开会把宿主动态加进 invocation 的任何内部字段一起交给插件。
   * 契约里的 caller 是**确定的 10 个键**，多出来的东西迟早会被某位
   * 插件作者当成稳定接口用 —— 那时它就再也不能删了。
   */
  return Object.freeze({
    pluginId: String(invocation.pluginId ?? ''),
    tool: String(invocation.tool ?? ''),
    origin: invocation.origin,
    convKey,
    isGroup: invocation.isGroup === undefined ? convKey.startsWith('group:') : invocation.isGroup === true,
    requester: Object.freeze({
      id: String(requester.id ?? ''),
      nickname: String(requester.nickname ?? ''),
    }),
    messageId: invocation.messageId === undefined ? null : invocation.messageId,
    replyToMessageId: invocation.replyToMessageId === undefined ? null : invocation.replyToMessageId,
    callId: String(invocation.callId ?? ''),
    at: Number.isFinite(invocation.at) ? Number(invocation.at) : 0,
  });
}
