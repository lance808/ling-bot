/**
 * QQ 侧确认卡 —— 生成、推送、回复生效
 *
 * 守的是同一个故障族：**确认卡只出现在桌面端**。
 * 用户从 QQ 下指令 → 宿主要求人工点头 → 卡片停在没人看的桌面弹窗 →
 * 60 秒后按拒绝处理 → 用户看到"指令没反应"。
 *
 * 第二条故障：回执发了但被闸门吞掉（sendText resolve {ok:false} 而非 reject），
 * 用户点了确认却什么回信都没有，日志里也查不到。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('★ QQ 来源的确认要真的推到 QQ，而不是只留在桌面端', () => {
  const src = read('src/index.mjs');

  assert.match(src, /function askHumanConfirm/, '确认入口还在');
  assert.match(src, /sendConfirmToQq/, '要有推 QQ 的路径');
  assert.match(src, /\(private\|group\):/, '只对 QQ 会话形状的 convKey 推');
  assert.match(src, /确认卡推送 QQ 失败/, '失败要有日志但不能炸');
});

test('★ 确认卡用 1 / 2 回复，与审批卡一致', () => {
  const src = read('src/index.mjs');
  const i = src.indexOf('async function sendConfirmToQq');
  const block = src.slice(i, i + 1500);

  assert.match(block, /回 1 同意，回 2 拒绝/, '要明确告诉用户回数字');
  // 长编号不能出现在文案里当回复指令 —— 人抄不动
  assert.ok(
    !/回复「同意 confirm-/.test(block),
    '不能再让用户抄 confirm-xxx 长编号',
  );
  assert.match(block, /分钟内没回按拒绝处理/, '要说清超时后果');
});

test('★ 裸数字 1 / 2 必须被认成同意 / 拒绝', () => {
  const src = read('src/index.mjs');
  const i = src.indexOf('async function tryHandleConfirmReply');
  const block = src.slice(i, i + 3000);

  assert.match(block, /text === '1' \|\| text === '2'/, '要识别裸数字');
  assert.match(block, /allow = text === '1'/, '1 = 同意');
  // 带序号的写法也要认
  assert.match(block, /同意\|拒绝\|允许\|取消/, '文字写法仍要认');
});

test('★ 没有待确认时，裸数字不能被抢走', () => {
  const src = read('src/index.mjs');
  const i = src.indexOf('async function tryHandleConfirmReply');
  const block = src.slice(i, i + 3000);

  // "2 点了" 这种闲聊不该被当成"拒绝"
  assert.match(block, /if \(text === '1' \|\| text === '2'\) return false/);
});

test('★ 多条待确认时，不带序号的回复必须被拒绝而不是猜', () => {
  const src = read('src/index.mjs');
  const i = src.indexOf('async function tryHandleConfirmReply');
  const block = src.slice(i, i + 3000);

  assert.match(block, /all\.length > 1/);
  assert.match(block, /请带上序号回复/, '要明确要求带序号');
  const multiIdx = block.indexOf('all.length > 1');
  const resolveIdx = block.indexOf('resolveConfirm(id, allow)');
  assert.ok(resolveIdx > multiIdx, '拒绝多条猜测的分支要先于结算');
});

test('★ 回执发送必须检查返回值（闸门会 resolve {ok:false}）', () => {
  const src = read('src/index.mjs');

  assert.match(src, /function sendConfirmReply/, '要有统一的回执发送函数');
  const i = src.indexOf('async function sendConfirmReply');
  const block = src.slice(i, i + 700);
  assert.match(block, /r\.ok === false/, '必须检查 ok，否则被闸门吞掉也不知道');
  assert.match(block, /确认回执未能送达/, '失败要留日志');
});

test('★ 序号必须在登记时定下，并在结算/超时时释放', () => {
  const src = read('src/index.mjs');

  assert.match(src, /function allocConfirmSeq/, '要有序号分配');
  assert.match(src, /function releaseConfirmSeq/, '要有序号释放');

  // 登记时分配
  const ask = src.indexOf('function askHumanConfirm');
  const askBlock = src.slice(ask, ask + 700);
  assert.match(askBlock, /allocConfirmSeq\(id\)/, '登记时就要定下序号');

  // 超时分支要释放
  assert.match(askBlock, /releaseConfirmSeq\(seq\)/, '超时也要释放，否则泄漏');

  // 结算分支要释放
  const rc = src.indexOf('function resolveConfirm');
  const rcBlock = src.slice(rc, rc + 600);
  assert.match(rcBlock, /releaseConfirmSeq\(pending\.seq\)/, '结算要释放');
});

test('★ 确认超时仍然是拒绝（fail-closed 不能被破坏）', () => {
  const src = read('src/index.mjs');
  const i = src.indexOf('function askHumanConfirm');
  const block = src.slice(i, i + 900);
  assert.match(block, /resolve\('deny'\)/, '超时默认拒绝');
});
