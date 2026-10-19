/**
 * 动作：发文本 —— F13
 *
 * 这是"加一个能力"的示范：**声明式**描述，不写业务 if。
 * 后续加 send-voice / send-sticker / group-kick，各写一个同形状的文件。
 */

import { defineAction } from './index.mjs';

export function registerSendTextAction() {
  return defineAction({
    name: 'send-text',
    onebotAction: 'send_msg',
    permission: 'send',
    audit: 'text',
    rateLimit: 'send',
    capability: 'send_msg',
    params: {
      convKey: { type: 'string', required: true },
      text: { type: 'string', required: true, maxLength: 4000 },
    },
  });
}
