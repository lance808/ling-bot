/**
 * 事件归一化 / 客户端 URL 构造 / 上游健康 —— F2、F3、F4
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEvent, segmentsToText, escapeCq, isValidConvKey } from '../src/onebot/events.mjs';
import { OneBotClient } from '../src/onebot/client.mjs';
import { UpstreamHealth } from '../src/onebot/health.mjs';

test('会话键形状：只接受 group:/private: + 数字', () => {
  assert.equal(isValidConvKey('group:123'), true);
  assert.equal(isValidConvKey('private:456'), true);
  assert.equal(isValidConvKey('group:abc'), false);
  assert.equal(isValidConvKey('guild:1'), false);
  assert.equal(isValidConvKey('group:'), false);
});

test('消息段转文本：@自己 / 引用 / 各种占位', () => {
  const { text, atSelf, replyTo } = segmentsToText(
    [
      { type: 'reply', data: { id: '99' } },
      { type: 'at', data: { qq: '1001' } },
      { type: 'text', data: { text: ' 在吗' } },
      { type: 'image', data: {} },
      { type: 'face', data: { id: '14' } },
    ],
    { selfId: '1001' },
  );
  assert.equal(atSelf, true);
  assert.deepEqual(replyTo, { messageId: '99' });
  assert.ok(text.includes('@你'));
  assert.ok(text.includes('[图片]'));
  assert.ok(text.includes('[表情:14]'));
});

test('CQ 码防注入：出站一律转义', () => {
  assert.equal(escapeCq('[CQ:at,qq=all]'), '[CQ：at,qq=all]');
});

test('归一化：群消息 / 私聊 / 拍一拍 / 撤回 / 请求 / 心跳', () => {
  const groupMsg = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: 123,
      user_id: 456,
      message_id: 1,
      time: 100,
      sender: { card: '群名片', nickname: '昵称' },
      message: [{ type: 'text', data: { text: 'hi' } }],
    },
    { selfId: '1' },
  );
  assert.equal(groupMsg?.kind, 'message');
  assert.equal(groupMsg?.convKey, 'group:123');
  assert.equal(groupMsg?.sender.nickname, '群名片');

  const privateMsg = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 456,
    message_id: 2,
    message: [],
  });
  assert.equal(privateMsg?.convKey, 'private:456');

  const poke = normalizeEvent({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: 123,
    user_id: 456,
    target_id: 1,
  });
  assert.equal(poke?.kind, 'poke');
  assert.equal(poke?.convKey, 'group:123');

  const recall = normalizeEvent({ post_type: 'notice', notice_type: 'group_recall', group_id: 123, user_id: 456, message_id: 3 });
  assert.equal(recall?.kind, 'recall');

  const request = normalizeEvent({ post_type: 'request', request_type: 'friend', user_id: 789, comment: '加个好友' });
  assert.equal(request?.kind, 'request');
  assert.equal(request?.comment, '加个好友');

  const meta = normalizeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { good: true, online: true } });
  assert.equal(meta?.kind, 'meta');
  assert.equal(meta?.status.good, true);

  assert.equal(normalizeEvent({ post_type: 'unknown_type' }), null);
  assert.equal(normalizeEvent(null), null);
});

test('客户端 URL：token 走查询参数（兼容内置 WebSocket，验证点 V1）', () => {
  const c = new OneBotClient({ wsUrl: 'ws://127.0.0.1:3001', accessToken: 'abc' });
  const url = c.buildUrl();
  assert.ok(url.startsWith('ws://127.0.0.1:3001/'));
  assert.ok(url.includes('access_token=abc'));

  const noToken = new OneBotClient({ wsUrl: 'ws://127.0.0.1:3001' });
  assert.ok(!noToken.buildUrl().includes('access_token'));
});

test('客户端：未联通时发动作立即失败（不挂起）', async () => {
  const c = new OneBotClient({ wsUrl: 'ws://127.0.0.1:3999' });
  await assert.rejects(() => c.sendAction('get_status'), /尚未联通/);
});

test('上游健康：三态分离，good=false 时给出指向 [Hook] 的提示', () => {
  const h = new UpstreamHealth();
  h.onState('linked');
  h.onEvent({ kind: 'meta', metaType: 'heartbeat', status: { good: true, online: true } });

  let snap = h.snapshot();
  assert.equal(snap.linked, true);
  assert.equal(snap.good, true);
  assert.equal(snap.verdict, 'ok');
  assert.equal(snap.hint, null);

  h.onEvent({ kind: 'meta', metaType: 'heartbeat', status: { good: false } });
  snap = h.snapshot();
  assert.equal(snap.verdict, 'degraded');
  assert.ok(snap.hint.text.includes('[Hook]'), '文案必须直接指向上游的 [Hook]');
  assert.equal(snap.hint.steps.length, 3);
});

test('上游健康：未联通时给出可执行的排查顺序（联调实测补强）', () => {
  const h = new UpstreamHealth();
  const snap = h.snapshot();
  assert.equal(snap.linked, false);
  assert.equal(snap.verdict, 'unknown');
  assert.equal(snap.hint.level, 'info');

  // 这几条是联调时真实踩过的坑，界面必须直接说出来
  const all = snap.hint.steps.join(' ');
  assert.ok(all.includes('3000'), '要说明 3000 是 HTTP');
  assert.ok(all.includes('3001'), '要说明 3001 是 WS');
  assert.ok(all.includes('token'), '要提醒 token');
  assert.ok(all.includes('access_token'), '要说明 token 走查询参数');
  assert.ok(all.includes('两个不同的值'), '要提醒 HTTP/WS token 不同');
});

test('上游健康：端点自愈记录可见（I8：只记 info）', () => {
  const h = new UpstreamHealth();
  h.noteEndpointHealed('token-mismatch');
  assert.equal(h.snapshot().endpointHealed.reason, 'token-mismatch');
});

test('客户端：close() 之后不再自动重连（联调实测修掉的真实缺陷）', async () => {
  /** @type {object[]} 记录状态变化 */
  const states = [];
  let fakeClose = () => {};

  // 假传输层：open 时立刻"连上"，close 时触发 onClose —— 复现真实关闭路径
  const fakeTransport = {
    kind: 'fake',
    open() {
      let onCloseHandler = () => {};
      const handle = {
        readyState: 1,
        onOpen: (fn) => setTimeout(fn, 0),
        onMessage: () => {},
        onClose: (fn) => {
          onCloseHandler = fn;
        },
        send: () => {},
        close: () => {
          handle.readyState = 3;
          onCloseHandler({ code: 1000, reason: 'normal' });
        },
      };
      fakeClose = () => handle.close();
      return handle;
    },
  };

  const c = new OneBotClient({
    wsUrl: 'ws://127.0.0.1:3001',
    transport: fakeTransport,
    onState: (s) => states.push(s),
  });

  c.connect();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.state, 'linked');

  c.close();
  fakeClose();

  // 关闭后不应再进入 backoff
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!states.includes('backoff'), 'close() 后不应排重连');
  assert.equal(c.state, 'idle');
});

test('事件归一化：非数组 message 不抛错（脏事件不打断管线）', () => {
  const evt = normalizeEvent({ post_type: 'message', message_type: 'private', user_id: 1, message: null });
  assert.equal(evt?.kind, 'message');
  assert.equal(evt?.text, '');
});

test('上游健康：get_status 兜底可补上 online/good', () => {
  const h = new UpstreamHealth();
  h.onState('linked');
  h.onStatusPoll({ online: false, good: false });
  const snap = h.snapshot();
  assert.equal(snap.online, false);
  assert.equal(snap.good, false);
  assert.equal(snap.verdict, 'degraded');
});
