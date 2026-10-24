/**
 * 图片读取工具 —— 把「这条消息里的图」变成模型**真的能看**的内容
 *
 * ## 为什么必须做成"结构化结果"而不是把 base64 塞进 JSON 文本
 *
 * 这是本需求点名的一条硬要求（要求 10）。如果工具返回：
 *
 *   ```json
 *   { "ok": true, "result": { "note": "图片", "data": "iVBORw0KGgoAAAANSUhEUg..." } }
 *   ```
 *
 * 那么 base64 会顺着 `wrapToolResult` 进入 tool 角色消息，然后在 8000 字符处
 * 被截断 —— 模型拿到的是一段**残缺的 base64 文本**。它看不懂，也不会有任何
 * 报错：工具"成功"了，图却从来没进过上下文。用户只看到模型说"图里好像…"。
 *
 * 所以工具返回的是 `{ text, images: [{dataUrl, ...}] }`：`agent-loop` 会把
 * 文本放进 tool 消息、把图片作为紧随其后的一条 user 消息（带真正的
 * `image_url` 段）。那样图片走的是模型的视觉通道，不是文本通道。
 *
 * ## 为什么工具总是注册，而不是"开着才注册"
 *
 * 工具注册发生在启动那一刻，而 `defineTool` 是静态的（I14 的静态审计口径）。
 * 想在配置变化时增删工具，就得在运行期操作工具表 —— 那会让"工具面"
 * 变成可变量，静态审计（`describeTools` 打印的那份清单）就失去意义了。
 *
 * 所以这里的选择是：**工具一直在清单里，开关在调用时判定**。
 * 关着的时候调用会立刻返回一句明确说明，模型据此就知道该停手 ——
 * 这比"工具时有时无"更可预测（模型不会因为上一轮见过它就反复试探）。
 *
 * 代价是模型可能多问一次，但那一次不花取图成本、不花图片 token，
 * 只花几十个 token 的文本往返，远小于运行期改工具表的复杂度。
 *
 * ## 边界
 *
 *   · 只看**当前会话**里的消息（convKey 由执行器注入，模型给不了）；
 *   · 走的是与自动读图完全相同的受控取图链路（SSRF / 越界 / 类型 / 字节 / 像素）；
 *   · 张数、字节受同一份预算约束，不另开一套上限。
 */

import { RISK } from '../guard/tool-gate.mjs';
import { ORIGIN } from '../guard/origin.mjs';
import { defineTool } from './registry.mjs';

/**
 * 注册图片读取工具。
 *
 * 依赖全部注入，所以它能在纯 Node 下被测：不需要 OneBot、不需要网络。
 *
 * @param {object} opts
 * @param {() => object} opts.getConfig 返回当前 vision 配置（每次现读，热更新生效）
 * @param {(input: {convKey: string, messageId: unknown}) => {ok: boolean, event?: any, code?: string, message?: string}} opts.lookupMessage
 *   按 id 在**指定会话**里找消息（找不到即"不属于当前会话"）
 * @param {(refs: object[], opts: object) => Promise<Array<{ok: boolean, dataUrl?: string, mime?: string, width?: number, height?: number, code?: string, reason?: string}>>} opts.fetchImages
 *   受控取图（与自动读图同一条链路）
 * @param {(refs: unknown[]) => object[]} opts.extractRefs 段 → MediaRef
 * @returns {object | null} 注册成功返回工具声明；配置里没开视觉时返回 null
 */
export function registerChatImageTools(opts) {
  const getConfig = typeof opts?.getConfig === 'function' ? opts.getConfig : () => ({});
  const lookupMessage = typeof opts?.lookupMessage === 'function' ? opts.lookupMessage : () => ({ ok: false });
  const fetchImages = typeof opts?.fetchImages === 'function' ? opts.fetchImages : async () => [];
  const extractRefs = typeof opts?.extractRefs === 'function' ? opts.extractRefs : () => [];

  defineTool({
    name: 'qq_message_images',
    description:
      '读取当前会话里某条消息附带的图片，并直接以图像内容返回给你（你可以"看懂"图片）。'
      + '当消息文本里出现 [图片] 占位、或你想确认对方发的图是什么时才调用。'
      + '只能读当前会话的消息，不能读别的群或私聊。',
    kind: 'qq',
    risk: RISK.R0,
    confirm: 'never',
    // 三个来源都可能需要它：管理员私聊、群聊、桌面端。
    // 主动回合不给：没有人提问时自己去翻图没有意义，还白花 token。
    origins: [ORIGIN.OWNER_PRIVATE, ORIGIN.OWNER_GROUP, ORIGIN.GROUP, ORIGIN.CONSOLE],
    params: {
      messageId: {
        type: 'string',
        required: true,
        description: '要读哪条消息的图片（消息 id）',
        maxLength: 64,
      },
    },
    /**
     * @param {{args: {messageId: string}, convKey: string, signal?: AbortSignal}} input
     */
    async run({ args, convKey, signal }) {
      /*
       * 开关是**每次调用时现读**的，不是注册时快照。
       *
       * 注册发生在启动那一刻，而用户完全可能在使用中途关掉视觉。
       * 快照一份配置会让"关掉之后工具照样取图"——那正是需求要求
       * 不能出现的情况（关闭必须真的停止取图）。
       */
      const cfg = getConfig() ?? {};
      if (cfg.enabled !== true) {
        return {
          text: '视觉已关闭，无法读取图片。如果需要，请让管理员在「视觉」页打开它。',
          images: [],
        };
      }

      const messageId = String(args?.messageId ?? '').trim();
      if (!messageId) {
        return { text: '请提供要读取的消息 id。', images: [] };
      }

      // 归属校验：convKey 来自执行器注入的可信上下文，模型无法伪造
      const hit = lookupMessage({ convKey, messageId });
      if (!hit?.ok) {
        /*
         * 统一口径：不区分"不存在"与"在别的会话"。
         * 区分了就等于给了一个跨会话探测原语 —— 拿一串 id 试探就能知道
         * 别的群里有没有某条消息。
         */
        return { text: '这条消息不存在，或不属于当前会话。', images: [] };
      }

      const evt = hit.event ?? {};
      const refs = extractRefs(evt.segments ?? []);
      if (!Array.isArray(refs) || refs.length === 0) {
        return { text: '这条消息里没有图片。', images: [] };
      }

      if (signal?.aborted) {
        const err = new Error('调用已取消');
        /** @type {any} */ (err).code = 'E4070';
        throw err;
      }

      const fetched = await fetchImages(refs, { convKey });
      /** @type {Array<{dataUrl: string, mime: string, label: string}>} */
      const images = [];
      /** @type {string[]} */
      const failed = [];

      for (let i = 0; i < fetched.length; i++) {
        const one = fetched[i] ?? {};
        if (one.ok && typeof one.dataUrl === 'string' && one.dataUrl.startsWith('data:image/')) {
          images.push({ dataUrl: one.dataUrl, mime: String(one.mime ?? ''), label: `图片${i + 1}` });
        } else {
          // 失败原因按码分类，不要笼统说"读不到"——用户与模型都需要能区分
          failed.push(`图片${i + 1}（${one.code ?? 'E3101'}${one.reason ? `：${one.reason}` : ''}）`);
        }
      }

      /** @type {string[]} */
      const lines = [`消息 ${messageId} 的图片：${images.length} 张可读`];
      if (failed.length > 0) {
        lines.push(`读不到：${failed.join('；')}`);
      }

      return {
        text: lines.join('\n'),
        images,
      };
    },
  });

  return { name: 'qq_message_images' };
}
