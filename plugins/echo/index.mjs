/**
 * 示例插件：echo
 *
 * 这个插件演示插件通道的正确写法，同时也是"能不能加功能"的验收物。
 *
 * ## 起用步骤
 *
 *   1. 把 `plugins/` 整个目录（或只这一个子目录）放到 userData 下
 *   2. 在 config.json 里加：`"plugins": { "enabled": ["echo"] }`
 *   3. 重启，日志里会出现「插件已加载：echo」
 *
 * ## 注意它的"不做"
 *
 * 它**没有**声明 origins，也**没有**声明 confirm —— 因为插件无权决定这两件事。
 * 宿主会按 `needs: 'qq'` 推导成「主人私聊 + 主人所在群」，
 * 按 `risk: 'R0'` 推导成「自动执行，不用确认」。
 *
 * 这就是插件通道的安全模型：插件说"我需要什么"，宿主决定"给你什么"。
 */

export default {
  name: 'echo',

  tools: [
    {
      name: 'echo',
      // needs: 'qq' 表示这个工具只动 QQ 侧，不该去读本机文件
      needs: 'qq',
      // R0 = 只读且无副作用，可自动执行
      risk: 'R0',
      description: '把传入的文字原样回显。用于验证插件通道是否工作。',
      params: {
        text: { type: 'string', required: true, description: '要回显的文字' },
      },
      /**
       * @param {{text: string}} args
       * @returns {Promise<object>}
       */
      async run(args) {
        return { echoed: String(args.text ?? '') };
      },
    },
  ],
};
