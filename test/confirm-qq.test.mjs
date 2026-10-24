/**
 * QQ 侧确认卡 —— 生成、推送、回复生效
 *
 * 守的是同一个故障族：**确认卡只出现在桌面端**。
 * 用户从 QQ 下指令 → 宿主要求人工点头 → 卡片停在没人看的桌面弹窗 →
 * 60 秒后按拒绝处理 → 用户看到"指令没反应"。
 *
 * 第二条故障：回执发了但被闸门吞掉（sendText resolve {ok:false} 而非 reject），
 * 用户点了确认却什么回信都没有，日志里也查不到。
 *
 * 这个文件只做**结构断言**（函数在、文案对、路径通）。
 * 真正的行为（身份、会话、并发、过期、双端竞争）见 confirm-routing.test.mjs。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** 取一个顶层函数的函数体（到下一个顶格 function / async function 为止） */
function fnBody(src, name, maxLen = 6000) {
  const start = src.indexOf(name);
  assert.ok(start > 0, `找不到 ${name}`);
  const after = src.slice(start + name.length);
  const next = after.search(/\n(?:async )?function |\n\/\*\*/);
  return after.slice(0, next > 0 ? next : maxLen);
}

test('★ QQ 来源的确认要真的推到 QQ，而不是只留在桌面端', () => {
  const src = read('src/index.mjs');

  assert.match(src, /function askHumanConfirm/, '确认入口还在');
  assert.match(src, /sendConfirmToQq/, '要有推 QQ 的路径');
  assert.match(src, /确认卡推送 QQ 失败/, '失败要有日志但不能炸');
});

test('★ 确认卡只投管理员私聊（群里可见就等于谁都能批）', () => {
  const src = read('src/index.mjs');
  const body = fnBody(src, 'function askHumanConfirm');

  // 投递目标必须是"会话本来就是某个管理员的私聊"，不是"形状像 QQ 会话"
  assert.match(body, /isAdminDm/, '要算出这张卡能不能投到 QQ');
  assert.match(body, /kind === 'private'/, '只认私聊');
  assert.match(body, /admins\.includes/, '会话主人必须在管理员名单里');
  assert.match(body, /replyConvKey: isAdminDm \? convKey : ''/, '群聊不设 QQ 投递目标');
});

test('★ 确认卡用 1 / 2 回复，并要求引用定位', () => {
  const src = read('src/index.mjs');
  const body = fnBody(src, 'async function sendConfirmToQq', 2000);

  assert.match(body, /回 1 同意，回 2 拒绝/, '要明确告诉用户回数字');
  // 长编号不能出现在文案里当回复指令 —— 人抄不动
  assert.ok(!/回复「同意 confirm-/.test(body), '不能再让用户抄 confirm-xxx 长编号');
  assert.match(body, /分钟内没回按拒绝处理/, '要说清超时后果');
  // 并发时必须要求引用，否则"回 1"会落到不知道哪一条上
  assert.match(body, /引用这条消息/, '要教用户引用那条卡片');
});

test('★ 卡片上的序号在登记时定下，且推送失败/成功都要记账', () => {
  const src = read('src/index.mjs');
  const body = fnBody(src, 'async function sendConfirmToQq', 2000);

  assert.match(body, /entry\.seq/, '序号来自登记那一刻，不能现数');
  assert.match(body, /confirms\.bindMessage/, '推送成功必须绑定 message_id');
  assert.match(body, /confirms\.markPushFailed/, '推送失败/拿不到 ID 必须留痕');
});

test('★ 绑定失败时不能发明一个假消息 ID', () => {
  const src = read('src/index.mjs');
  const body = fnBody(src, 'async function sendConfirmToQq', 2600);
  // 允许"失败分支记日志"，但不允许出现赋值一个假 id 的写法
  assert.ok(
    !/bindMessage\(id,\s*[`'"]/.test(body),
    '不能把字符串常量当 messageId 绑上去（引用会全部查不到）',
  );
  assert.match(body, /引用定位不可用/, '失败要说清后果');
});

test('★ 回执发送必须检查返回值（闸门会 resolve {ok:false}）', () => {
  const src = read('src/index.mjs');

  assert.match(src, /function sendConfirmReply/, '要有统一的回执发送函数');
  const body = fnBody(src, 'async function sendConfirmReply', 900);
  assert.match(body, /r\.ok === false/, '必须检查 ok，否则被闸门吞掉也不知道');
  assert.match(body, /确认回执未能送达/, '失败要留日志');
});

test('★ 只要认领了就必须回一句（点了头却什么都没收到是最糟的失败）', () => {
  const src = read('src/index.mjs');
  const body = fnBody(src, 'async function reportConfirmResult', 900);
  assert.match(body, /describeOutcome/, '成功要回放行/拒绝');
  assert.match(body, /r\?\.message/, '失败要回原因');
});

test('★ 确认超时仍然是拒绝（fail-closed 不能被破坏）', () => {
  const src = read('src/index.mjs');
  const guard = read('src/guard/confirm.mjs');

  // 超时值仍然落在宿主入口（静态检查 I17 读这里）
  assert.match(src, /CONFIRM_TIMEOUT_MS\s*=\s*60_000/, '缺 60s 确认超时');
  // 真正的超时结算在登记表里，必须落 deny
  assert.match(guard, /this\.#settle\(entry, 'deny', SETTLE_REASON\.TIMEOUT/, '超时默认拒绝');
});

test('★ 退出时必须把在途确认按拒绝结算', () => {
  const src = read('src/index.mjs');
  const start = src.indexOf('async function shutdown(');
  const body = src.slice(start, start + 800);
  assert.match(body, /confirms\.cancelAll/, '否则等待中的工具调用悬在半空');
});

test('★ 确认卡超时要通知桌面端（否则确认条永远挂着）', () => {
  const src = read('src/index.mjs');
  assert.match(src, /onTimeout/, '登记表要支持超时回调');
  assert.match(src, /confirm-timeout/, '要推给界面');
});
