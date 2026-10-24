/**
 * 会话历史的媒体持久化 —— docs/vision-contract.md §2 / §5
 *
 * 这个文件守的是三件**没有报错、事后无法补救**的事：
 *
 *   1. **绝不落盘 URL 与 base64**。QQ 图片 URL 带临时鉴权参数，
 *      写进 sessions.json 等于把用户聊天里的图片长期挂在明文文件里；
 *      base64 则会把会话文件撑到不可用（且每次落盘都重写全量 JSON）。
 *
 *   2. **老文件照常能读**。视觉链路是后加的字段，升级后如果旧 sessions.json
 *      读不出来，用户会看到"会话历史整个消失"。
 *
 *   3. **图片已提交状态必须持久化**。只放内存的话重启后历史图会被重新
 *      提交一遍，token 账单凭空翻倍，而且界面无从解释。
 *
 * 另一个容易搞错的点也在这里钉住：imagesSeenFloors 与 modelSeenFloors
 * 是两套语义，前者**绝不能**参与 readThroughFloor —— 混进去会让读楼层
 * 提前跨过还没喂过的消息，那些消息永远不会被处理。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  SessionStore,
  normalizeMediaList,
  MEDIA_PERSIST_KEYS,
  MAX_IMAGES_SEEN_FLOORS,
} from '../src/session/store.mjs';

/* ------------------------------------------------------------------ 工具 */

async function makeStore(over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-'));
  const filePath = path.join(dir, 'sessions.json');
  const store = new SessionStore({ filePath, ...over });
  return { store, dir, filePath };
}

/** 造一条归一化后的事件；media 可选 */
function evt(uid, text, extra = {}) {
  return {
    messageId: 1000 + Number(uid),
    sender: { userId: String(uid), nickname: `u${uid}` },
    text,
    time: 1_700_000_000,
    ...extra,
  };
}

/** 一个"上游真实形状"的媒体引用（含 url —— 它**不应该**被落盘） */
function mediaRef(over = {}) {
  return {
    kind: 'image',
    file: 'ABCDEF.png',
    url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=xyz&rkey=SECRET',
    mime: 'image/png',
    bytes: 12345,
    width: 640,
    height: 480,
    name: 'photo.png',
    ...over,
  };
}

const CONV = 'group:123456';

/* ------------------------------------------------------- 白名单（硬要求） */

test('★ media 落盘只保留六个键：url 与任何多余字段都必须消失', async () => {
  const { store, filePath } = await makeStore();
  store.append(
    CONV,
    evt(1, '看这个', {
      media: [
        mediaRef({
          // 上游可能塞进来的私有字段，一个都不许进磁盘
          base64: 'iVBORw0KGgo=',
          dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          raw: { nested: true },
          messageId: '999',
        }),
      ],
    }),
  );
  await store.close();

  const text = await fs.readFile(filePath, 'utf8');
  assert.ok(!text.includes('SECRET'), 'URL 的鉴权参数绝不能落盘');
  assert.ok(!text.includes('multimedia.nt.qq.com.cn'), 'URL 本身也不能落盘');
  assert.ok(!text.includes('base64,'), '任何 base64 都不能落盘');
  assert.ok(!text.includes('iVBORw0KGgo'), 'base64 载荷不能落盘');
  assert.ok(!text.includes('"url"'), '不能有 url 键');
  assert.ok(!text.includes('"raw"'), '未列出的字段不能透传');

  const parsed = JSON.parse(text);
  const m = parsed.conversations[CONV].messages[0];
  assert.ok(m.media, '要保留 media 数组');
  assert.deepEqual(
    Object.keys(m.media[0]).sort(),
    [...MEDIA_PERSIST_KEYS].sort(),
    '键集合必须恰好是允许的六个',
  );
  assert.deepEqual(m.media[0], {
    kind: 'image',
    file: 'ABCDEF.png',
    mime: 'image/png',
    bytes: 12345,
    width: 640,
    height: 480,
    name: 'photo.png',
  });
});

test('MEDIA_PERSIST_KEYS 就是契约里那六个，多一个少一个都不行', () => {
  assert.deepEqual([...MEDIA_PERSIST_KEYS].sort(), [
    'bytes',
    'file',
    'height',
    'kind',
    'mime',
    'name',
    'width',
  ]);
});

test('★ 序列化前再兜一道：运行时被塞进 url 的消息也不会写进磁盘', async () => {
  /*
   * append 与 load 都归一化过，但消息对象是活的：插件、界面、未来的
   * 视觉链路都可能往活对象上挂字段。序列化是最后一道关。
   */
  const { store, filePath } = await makeStore();
  const r = store.append(CONV, evt(1, 'x', { media: [mediaRef()] }));
  assert.equal(r.ok, true);

  // 模拟"别处手滑改到仓库里的活对象"
  const page = store.page(CONV, { limit: 5 });
  page.messages[0].media[0].url = 'https://evil.example.com/SECRET';
  page.messages[0].media[0].dataUrl = 'data:image/png;base64,AAAA';

  await store.close();
  const text = await fs.readFile(filePath, 'utf8');
  assert.ok(!text.includes('SECRET'), '即使是活对象上的 url 也不能落盘');
  assert.ok(!text.includes('evil.example.com'));
  assert.ok(!text.includes('data:image'));
});

test('★ 返回的副本是深拷贝：改 media 条目不影响仓库', async () => {
  /*
   * 浅拷贝（{...m}）只复制数组引用，调用方改 media[0].file 就改到了
   * 仓库里的持久数据，而且不会标脏 —— 下次落盘写的是被改坏的值。
   */
  const { store, filePath } = await makeStore();
  store.append(CONV, evt(1, 'x', { media: [mediaRef()] }));

  const page = store.page(CONV, { limit: 5 });
  page.messages[0].media[0].file = '被改坏了.png';
  assert.equal(store.page(CONV, { limit: 5 }).messages[0].media[0].file, 'ABCDEF.png');

  const unread = store.unreadMessages(CONV);
  unread[0].media[0].name = '也改坏了';
  assert.equal(store.page(CONV, { limit: 5 }).messages[0].media[0].name, 'photo.png');

  await store.close();
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(parsed.conversations[CONV].messages[0].media[0].file, 'ABCDEF.png');
});

/* ------------------------------------------------------------ 归一化 */

test('★ file 字段里藏了 URL / data: / 路径时被清空（键名白名单管不住值）', async () => {
  /*
   * 契约 §2 说 `file` 可能是缓存名，但上游完全可能把 URL 塞进 file 字段
   * （media-refs.mjs 里就专门处理过这种分流）。只留六个**键名**是拦不住
   * "URL 换了个键名叫 file"的 —— 所以值也要按缓存名形状再筛一次。
   */
  const dirtyFiles = [
    'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=SECRET',
    'http://x/a.png?token=SECRET',
    'base64://iVBORw0KGgo=',
    'data:image/png;base64,iVBORw0KGgo=',
    '../outside/a.png',
    'C:\\Users\\me\\a.png',
    'a/b.png',
    '..',
  ];
  for (const file of dirtyFiles) {
    const [item] = normalizeMediaList([{ kind: 'image', file }]);
    assert.equal(item.file, '', `应清空：${file.slice(0, 40)}`);
  }
  // 正常缓存名保留
  for (const file of ['ABCDEF.png', 'a_b-c.0123456789', 'x@y+z=m']) {
    assert.equal(normalizeMediaList([{ kind: 'image', file }])[0].file, file, file);
  }
});

test('★ 落盘里绝不出现藏在 file 里的鉴权 URL', async () => {
  const { store, filePath } = await makeStore();
  store.append(
    CONV,
    evt(1, 'x', {
      media: [mediaRef({ file: 'https://multimedia.nt.qq.com.cn/download?rkey=SECRET' })],
    }),
  );
  await store.close();
  const text = await fs.readFile(filePath, 'utf8');
  assert.ok(!text.includes('SECRET'), 'file 里的 URL 也不能落盘');
  assert.ok(!text.includes('rkey='));
});

test('normalizeMediaList：脏项丢弃，合法项收敛到六个键', () => {
  const out = normalizeMediaList([
    mediaRef(),
    { kind: 'face', file: 'x' }, // 本轮只处理 image
    { kind: 'image' }, // 缺字段但是合法的 image
    null,
    'x',
    42,
    { file: 'no-kind.png' }, // 没有 kind：丢弃
    { kind: 'image', bytes: -5, width: 'wide', height: NaN, name: 99, mime: null },
  ]);
  assert.equal(out.length, 3, '三张合法 image（face / 无 kind / 非对象都被丢掉）');

  // 缺字段的合法项：字符串给空串、数值给 0（不是 undefined）
  assert.deepEqual(out[1], {
    kind: 'image',
    file: '',
    mime: '',
    bytes: 0,
    width: 0,
    height: 0,
    name: '',
  });

  // 类型不对的字段一律收敛，不是"原样保留 -5 之类"
  assert.deepEqual(out[2], {
    kind: 'image',
    file: '',
    mime: '',
    bytes: 0,
    width: 0,
    height: 0,
    name: '',
  });

  // 每一项的键集合都必须恰好是六个
  for (const item of out) {
    assert.deepEqual(Object.keys(item).sort(), [...MEDIA_PERSIST_KEYS].sort());
  }
});

test('normalizeMediaList：非数组给空数组，不抛', () => {
  for (const bad of [undefined, null, 'x', 42, {}, true]) {
    assert.deepEqual(normalizeMediaList(bad), []);
  }
});

test('没有 media 的消息对象上**不会**多出 media 键（形状与老版本一致）', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, '纯文本'));
  const m = store.page(CONV, {}).messages[0];
  assert.ok(!Object.hasOwn(m, 'media'), '没图就不该有 media 字段');
});

test('media 全是脏项时等价于没有 media', async () => {
  const { store, filePath } = await makeStore();
  store.append(CONV, evt(1, 'x', { media: [{ url: 'https://x/SECRET' }, { kind: 'record' }] }));
  assert.ok(!Object.hasOwn(store.page(CONV, {}).messages[0], 'media'));
  await store.close();
  const text = await fs.readFile(filePath, 'utf8');
  assert.ok(!text.includes('SECRET'));
});

/* ------------------------------------------------- 老数据兼容（升级路径） */

test('★ 老文件（没有 media 字段）照常读，消息逐字段还原', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-'));
  const filePath = path.join(dir, 'sessions.json');
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      conversations: {
        'group:1': {
          convKey: 'group:1',
          lastFloor: 2,
          readThroughFloor: 1,
          messages: [
            { floor: 1, messageId: 11, userId: '7', nickname: 'u7', text: 'a', time: 100, receivedAt: 100000 },
            { floor: 2, messageId: 12, userId: '8', nickname: 'u8', text: 'b', time: 200, receivedAt: 200000 },
          ],
          modelSeenFloors: [1],
        },
      },
    }),
    'utf8',
  );

  const store = new SessionStore({ filePath });
  const r = await store.load();
  assert.equal(r.ok, true);
  assert.equal(store.conversationCount, 1);

  const page = store.page('group:1', { limit: 10 });
  assert.deepEqual(page.messages.map((m) => m.text), ['a', 'b']);
  assert.deepEqual(page.messages[0], {
    floor: 1,
    messageId: 11,
    userId: '7',
    nickname: 'u7',
    text: 'a',
    atSelf: false,
    replyTo: null,
    isGroup: false,
    time: 100,
    receivedAt: 100000,
  });
  assert.equal(store.readThroughFloor('group:1'), 1, '读楼层语义不变');
  assert.deepEqual(store.imagesSeenFor('group:1'), new Set(), '老文件没有图片已提交记录');
});

test('★ 旧数据里的脏 media 在 load 时被清洗，不是原样带进内存', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-'));
  const filePath = path.join(dir, 'sessions.json');
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      conversations: {
        'group:1': {
          lastFloor: 3,
          messages: [
            {
              floor: 1,
              text: '带 url 的脏数据',
              media: [
                { kind: 'image', file: 'a.png', url: 'https://x?rkey=SECRET', mime: 'image/png', bytes: 1, width: 1, height: 1, name: 'a' },
              ],
            },
            { floor: 2, text: 'media 不是数组', media: 'nope' },
            { floor: 3, text: 'media 里混了非对象', media: [null, 3, { kind: 'video' }] },
          ],
        },
      },
    }),
    'utf8',
  );

  const store = new SessionStore({ filePath });
  await store.load();
  const page = store.page('group:1', { limit: 10 });

  assert.deepEqual(Object.keys(page.messages[0].media[0]).sort(), [...MEDIA_PERSIST_KEYS].sort());
  assert.ok(!JSON.stringify(page.messages).includes('SECRET'));
  assert.ok(!Object.hasOwn(page.messages[1], 'media'), '非数组 → 当作没有');
  assert.ok(!Object.hasOwn(page.messages[2], 'media'), '全部脏项 → 当作没有');
});

test('老文件重启后再落盘：媒体键集合仍然是六个', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-'));
  const filePath = path.join(dir, 'sessions.json');
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      conversations: {
        'group:1': {
          lastFloor: 1,
          messages: [
            { floor: 1, text: 'x', media: [{ kind: 'image', url: 'https://x/SECRET', file: 'a.png' }] },
          ],
        },
      },
    }),
    'utf8',
  );

  const store = new SessionStore({ filePath });
  await store.load();
  store.markImagesSeen('group:1', [1]); // 逼一次落盘
  await store.close();

  const text = await fs.readFile(filePath, 'utf8');
  assert.ok(!text.includes('SECRET'));
  const parsed = JSON.parse(text);
  assert.deepEqual(
    Object.keys(parsed.conversations['group:1'].messages[0].media[0]).sort(),
    [...MEDIA_PERSIST_KEYS].sort(),
  );
});

/* ------------------------------------------------- imagesSeenFloors 语义 */

test('★ imagesSeenFloors 不参与 readThroughFloor（读楼层语义不能变）', async () => {
  /*
   * 这条是整个改动最隐蔽的风险点：如果把图片已见混进读楼层算法，
   * 一条"文本没喂过、图片提交过"的消息会被读楼层跨过，
   * 它的文本永远不会被处理 —— 静默丢消息。
   */
  const { store } = await makeStore();
  for (let i = 1; i <= 3; i++) store.append(CONV, evt(1, `m${i}`, { media: [mediaRef()] }));

  store.markImagesSeen(CONV, [1, 2, 3]);
  assert.equal(store.readThroughFloor(CONV), 0, '图片提交过不代表文本喂过模型');

  store.markModelSeen(CONV, [1]);
  assert.equal(store.readThroughFloor(CONV), 1, '仍然只按 modelSeenFloors 前进');
});

test('markImagesSeen 只登记真实存在的楼层（与 markModelSeen 同口径）', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  store.append(CONV, evt(1, 'b'));

  assert.equal(store.markImagesSeen(CONV, [99]), 0, '不存在的楼层不登记');
  assert.equal(store.markImagesSeen(CONV, [1]), 1);
  assert.equal(store.markImagesSeen(CONV, [1]), 0, '重复登记返回 0');
  assert.deepEqual(store.imagesSeenFor(CONV), new Set([1]));
});

test('markImagesSeen 忽略非法入参', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  for (const bad of [null, undefined, 'x', {}, 3.5, -1]) {
    assert.equal(store.markImagesSeen(CONV, /** @type {any} */ (bad)), 0);
  }
  assert.equal(store.markImagesSeen('group:none', [1]), 0, '不存在的会话返回 0');
});

test('imagesSeenFor 返回副本：改它不影响仓库', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a'));
  store.markImagesSeen(CONV, [1]);

  const snap = store.imagesSeenFor(CONV);
  snap.add(999);
  snap.delete(1);
  assert.deepEqual(store.imagesSeenFor(CONV), new Set([1]));
});

test('imagesSeenFor 对不存在的会话返回空 Set（不建会话）', async () => {
  const { store } = await makeStore();
  assert.deepEqual(store.imagesSeenFor('group:404'), new Set());
  assert.equal(store.conversationCount, 0, '查询不该顺手建出一个空会话');
});

/* ------------------------------------------------------- 持久化与恢复 */

test('★ imagesSeenFloors 落盘并在重启后恢复（否则历史图会被重复提交）', async () => {
  const { store, filePath } = await makeStore();
  for (let i = 1; i <= 3; i++) store.append(CONV, evt(1, `m${i}`, { media: [mediaRef()] }));
  store.markImagesSeen(CONV, [1, 3]);
  await store.close();

  const reopened = new SessionStore({ filePath });
  await reopened.load();
  assert.deepEqual(reopened.imagesSeenFor(CONV), new Set([1, 3]), '重启后必须还记得哪些图提交过');
});

test('★ 恢复时丢掉不存在楼层的图片已提交记录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-'));
  const filePath = path.join(dir, 'sessions.json');
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      conversations: {
        'group:1': {
          lastFloor: 2,
          messages: [{ floor: 1, text: 'a' }, { floor: 2, text: 'b' }],
          imagesSeenFloors: [1, 2, 77, -3, 'x', 1.5],
        },
      },
    }),
    'utf8',
  );

  const store = new SessionStore({ filePath });
  await store.load();
  assert.deepEqual(store.imagesSeenFor('group:1'), new Set([1, 2]), '只保留仍存在且合法的楼层');
});

test('imagesSeenFloors 非数组（脏文件）时退化为空集合', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-vision-'));
  const filePath = path.join(dir, 'sessions.json');
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      conversations: { 'group:1': { lastFloor: 1, messages: [{ floor: 1, text: 'x' }], imagesSeenFloors: 'oops' } },
    }),
    'utf8',
  );
  const store = new SessionStore({ filePath });
  assert.equal((await store.load()).ok, true);
  assert.deepEqual(store.imagesSeenFor('group:1'), new Set());
});

/* --------------------------------------------------------- 淘汰与上限 */

test('★ 楼层被淘汰时修剪 imagesSeenFloors（否则幽灵楼层号会撞上新消息）', async () => {
  const { store } = await makeStore({ maxMessages: 3 });
  for (let i = 1; i <= 5; i++) store.append(CONV, evt(1, `m${i}`, { media: [mediaRef()] }));
  store.markImagesSeen(CONV, [1, 2, 3, 4, 5]);
  // 1、2 已被淘汰
  assert.deepEqual(store.imagesSeenFor(CONV), new Set([3, 4, 5]));

  // 再塞一条：3 也被淘汰
  store.append(CONV, evt(1, 'm6', { media: [mediaRef()] }));
  assert.deepEqual(store.imagesSeenFor(CONV), new Set([4, 5]));
});

test(`★ imagesSeenFloors 总量上限 ${MAX_IMAGES_SEEN_FLOORS}：超限保留较新的楼层`, async () => {
  const { store } = await makeStore({ maxMessages: 1200 });
  const total = MAX_IMAGES_SEEN_FLOORS + 50;
  for (let i = 1; i <= total; i++) store.append(CONV, evt(1, `m${i}`));
  store.markImagesSeen(
    CONV,
    Array.from({ length: total }, (_, i) => i + 1),
  );

  const seen = store.imagesSeenFor(CONV);
  assert.equal(seen.size, MAX_IMAGES_SEEN_FLOORS, '不能无限增长');
  assert.equal(seen.has(total), true, '最新的必须保留');
  assert.equal(seen.has(1), false, '最旧的被丢弃');
  assert.equal(seen.has(total - MAX_IMAGES_SEEN_FLOORS + 1), true, '保留的是尾部一段');
});

test('超限落盘后重启仍然 <= 上限（不会因为读回又涨回去）', async () => {
  const { store, filePath } = await makeStore({ maxMessages: 1200 });
  const total = MAX_IMAGES_SEEN_FLOORS + 10;
  for (let i = 1; i <= total; i++) store.append(CONV, evt(1, `m${i}`));
  store.markImagesSeen(
    CONV,
    Array.from({ length: total }, (_, i) => i + 1),
  );
  await store.close();

  const reopened = new SessionStore({ filePath });
  await reopened.load();
  assert.ok(reopened.imagesSeenFor(CONV).size <= MAX_IMAGES_SEEN_FLOORS);
});

test('media 不影响楼层号、分页、未读数（媒体是展示信息，不是处理记号）', async () => {
  const { store } = await makeStore();
  store.append(CONV, evt(1, 'a', { media: [mediaRef(), mediaRef({ file: 'b.png' })] }));
  store.append(CONV, evt(1, 'b'));
  store.markModelSeen(CONV, [1]);

  assert.equal(store.page(CONV, { limit: 5 }).lastFloor, 2);
  assert.equal(store.unreadCount(CONV), 1);
  assert.equal(store.page(CONV, { limit: 5 }).messages[0].media.length, 2);
});
