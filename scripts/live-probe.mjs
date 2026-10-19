/**
 * 真实端点联调 —— P1 验证
 *
 * 用法：
 *   node scripts/live-probe.mjs [wsUrl] [token]
 *   默认 ws://127.0.0.1:3001
 *
 * 它只做只读探测：连上、取账号信息、取状态、听 15 秒事件。
 * 不发任何消息，不改任何状态。
 */

import { OneBotClient, CLIENT_STATE } from '../src/onebot/client.mjs';
import { normalizeEvent } from '../src/onebot/events.mjs';
import { UpstreamHealth } from '../src/onebot/health.mjs';

const wsUrl = process.argv[2] ?? 'ws://127.0.0.1:3001';
const token = process.argv[3] ?? '';

console.log(`Ling-bot 端点联调`);
console.log(`  端点：${wsUrl}`);
console.log(`  token：${token ? `${token.slice(0, 4)}***（${token.length} 位）` : '（未提供）'}\n`);

const health = new UpstreamHealth();
/** @type {object[]} */
const events = [];

const client = new OneBotClient({
  wsUrl,
  accessToken: token,
  onState: (state, detail) => {
    health.onState(state, detail);
    if (state === CLIENT_STATE.LINKED) console.log('  ✓ WS 已联通');
    else if (state === CLIENT_STATE.BACKOFF) console.log(`  · 断开，${detail?.delayMs}ms 后重连`);
    else if (state === CLIENT_STATE.CONNECTING) console.log('  · 正在连接…');
  },
  onEvent: (raw) => {
    const evt = normalizeEvent(raw, { selfId });
    if (evt) {
      events.push(evt);
      health.onEvent(evt);
    }
  },
});

let selfId = '';

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} label @param {() => Promise<any>} fn */
async function probe(label, fn) {
  try {
    const value = await fn();
    console.log(`  ✓ ${label}：${JSON.stringify(value)?.slice(0, 160)}`);
    return { ok: true, value };
  } catch (err) {
    const e = /** @type {any} */ (err);
    console.log(`  ✖ ${label} 失败：[${e?.code ?? '?'}] ${e?.message ?? e}`);
    return { ok: false, error: e };
  }
}

async function main() {
  client.connect();

  // 等联通（最多 10 秒）
  for (let i = 0; i < 40 && client.state !== CLIENT_STATE.LINKED; i++) await sleep(250);

  if (client.state !== CLIENT_STATE.LINKED) {
    console.log('\n✖ 未能联通。排查顺序：');
    console.log('  1. SnowLuma 的 OneBot 服务是否启用');
    console.log('  2. 端口是不是 3001（HTTP 与 WS token 是两个不同的值）');
    console.log('  3. token 是否正确（走 ?access_token=）');
    console.log(`  当前状态：${client.state}`);
    client.close();
    process.exit(1);
  }

  console.log('\n只读探测：');
  const login = await probe('get_login_info', () => client.getLoginInfo());
  if (login.ok) selfId = String(login.value?.user_id ?? '');

  await probe('get_status', async () => {
    const s = await client.getStatus();
    health.onStatusPoll(s);
    return s;
  });

  await probe('get_version_info', () => client.sendAction('get_version_info'));
  await probe('get_friend_list（只数条数）', async () => {
    const list = await client.sendAction('get_friend_list');
    return { count: Array.isArray(list) ? list.length : '非数组' };
  });
  await probe('get_group_list（只数条数）', async () => {
    const list = await client.sendAction('get_group_list');
    return { count: Array.isArray(list) ? list.length : '非数组', sample: Array.isArray(list) ? list.slice(0, 2) : null };
  });

  console.log('\n监听事件 15 秒（请让人在群里发条消息、或拍一拍）…');
  await sleep(15_000);

  const kinds = {};
  for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;

  console.log(`\n收到事件 ${events.length} 条：${JSON.stringify(kinds)}`);
  for (const e of events.slice(0, 6)) {
    if (e.kind === 'message') console.log(`  · [${e.convKey}] ${e.sender?.nickname}: ${e.text?.slice(0, 50)}`);
    else if (e.kind === 'meta') console.log(`  · [meta/${e.metaType}] status=${JSON.stringify(e.status)}`);
    else console.log(`  · [${e.kind}]`);
  }

  const snap = health.snapshot();
  console.log('\n上游健康快照：');
  console.log(`  linked=${snap.linked}  good=${snap.good}  goodFresh=${snap.goodFresh}`);
  console.log(`  online=${snap.online}  receiving=${snap.receiving}  verdict=${snap.verdict}`);
  if (snap.hint) console.log(`  提示：${snap.hint.title} — ${snap.hint.text}`);

  client.close();
  console.log('\n联调结束。');
}

main().catch((err) => {
  console.error(`\n✖ 联调异常：${err?.message ?? err}`);
  process.exit(1);
});
