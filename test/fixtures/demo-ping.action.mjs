/**
 * 扩展性演练用的假动作 —— 记录在案，作为 I11 的活体证据。
 *
 * 它模拟"以后加发语音"时要写的那个文件：**只有声明，没有业务 if**。
 * 真实功能加进来时，把 onebotAction 换掉、params 换掉即可。
 *
 * 注意：这个文件不参与生产注册，只在 `test/extension-drill.test.mjs` 里注册，
 * 以免给生产环境留一个无用的动作。
 */

import { defineAction } from '../../src/onebot/actions/index.mjs';

export function registerDemoPingAction() {
  return defineAction({
    name: '__demo_ping',
    onebotAction: 'get_status',
    permission: 'read',
    audit: 'none',
    rateLimit: 'read',
    capability: 'get_status',
    params: {
      note: { type: 'string', required: false, maxLength: 64 },
    },
  });
}
