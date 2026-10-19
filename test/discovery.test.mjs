/**
 * 端口自动发现
 *
 * 这一层的价值是把"两侧要填同一个端口"这件事去掉。它一旦静默坏掉，
 * 表现是 DSH 连不上桥，而界面上一切正常——所以每条规则都要钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  writeDiscovery,
  readDiscovery,
  clearDiscovery,
  isDiscoveryAlive,
  resolveBridgeUrl,
  DISCOVERY_FILE,
  DISCOVERY_DIR,
} from '../plugins/dsh-bridge/lib/discovery.mjs';

/** 备份并恢复真实的发现文件，避免测试污染本机状态 */
async function withCleanDiscovery(fn) {
  const backup = fss.existsSync(DISCOVERY_FILE)
    ? await fs.readFile(DISCOVERY_FILE, 'utf8')
    : null;
  try {
    await fs.rm(DISCOVERY_FILE, { force: true });
    return await fn();
  } finally {
    if (backup !== null) {
      await fs.mkdir(DISCOVERY_DIR, { recursive: true });
      await fs.writeFile(DISCOVERY_FILE, backup, 'utf8');
    } else {
      await fs.rm(DISCOVERY_FILE, { force: true });
    }
  }
}

test('写进去能读出来', async () => {
  await withCleanDiscovery(async () => {
    const ok = await writeDiscovery({ port: 12345 });
    assert.equal(ok, true);
    const got = readDiscovery();
    assert.equal(got.port, 12345);
    assert.ok(got.updatedAt > 0);
  });
});

test('★ 发现文件里不放令牌（令牌是密码，不该多一处泄露面）', async () => {
  await withCleanDiscovery(async () => {
    await writeDiscovery({ port: 3458 });
    const raw = await fs.readFile(DISCOVERY_FILE, 'utf8');
    const body = JSON.parse(raw);
    assert.deepEqual(Object.keys(body).sort(), ['pid', 'port', 'updatedAt']);
    assert.equal(raw.includes('token'), false);
  });
});

test('没写过时读出来是 null，不抛错', async () => {
  await withCleanDiscovery(async () => {
    assert.equal(readDiscovery(), null);
  });
});

test('内容坏了当作没有，不抛错', async () => {
  await withCleanDiscovery(async () => {
    await fs.mkdir(DISCOVERY_DIR, { recursive: true });
    await fs.writeFile(DISCOVERY_FILE, 'not json', 'utf8');
    assert.equal(readDiscovery(), null);
  });
});

test('端口越界也当作没有', async () => {
  await withCleanDiscovery(async () => {
    await fs.mkdir(DISCOVERY_DIR, { recursive: true });
    await fs.writeFile(DISCOVERY_FILE, JSON.stringify({ port: 99999 }), 'utf8');
    assert.equal(readDiscovery(), null);
  });
});

test('清除后读不到', async () => {
  await withCleanDiscovery(async () => {
    await writeDiscovery({ port: 3458 });
    await clearDiscovery();
    assert.equal(readDiscovery(), null);
  });
});

test('当前进程的 pid 算活着', () => {
  assert.equal(isDiscoveryAlive({ pid: process.pid }), true);
});

test('不存在的 pid 算死了（残留文件）', () => {
  // 挑一个几乎不可能存在的 pid
  assert.equal(isDiscoveryAlive({ pid: 999_999 }), false);
});

test('★ 用户显式填的地址优先于自动发现', async () => {
  await withCleanDiscovery(async () => {
    await writeDiscovery({ port: 3458 });
    // 显式填的必须原样返回，不能被发现文件覆盖
    assert.equal(resolveBridgeUrl('http://10.0.0.5:8080'), 'http://10.0.0.5:8080');
  });
});

test('没填时用自动发现的地址', async () => {
  await withCleanDiscovery(async () => {
    await writeDiscovery({ port: 4567 });
    assert.equal(resolveBridgeUrl(''), 'http://127.0.0.1:4567');
    assert.equal(resolveBridgeUrl('   '), 'http://127.0.0.1:4567');
  });
});

test('既没填也没发现文件时返回 null', async () => {
  await withCleanDiscovery(async () => {
    assert.equal(resolveBridgeUrl(''), null);
  });
});

test('发现文件指向死进程时不采用', async () => {
  await withCleanDiscovery(async () => {
    await fs.mkdir(DISCOVERY_DIR, { recursive: true });
    await fs.writeFile(
      DISCOVERY_FILE,
      JSON.stringify({ port: 3458, pid: 999_999, updatedAt: Date.now() }),
      'utf8',
    );
    assert.equal(resolveBridgeUrl(''), null, '残留文件不该被当成活的');
  });
});

test('写入是原子的：并发写不会留下半个 JSON', async () => {
  await withCleanDiscovery(async () => {
    await Promise.all([
      writeDiscovery({ port: 1111 }),
      writeDiscovery({ port: 2222 }),
      writeDiscovery({ port: 3333 }),
    ]);
    // 无论最后是哪个，读出来必须是合法的
    const got = readDiscovery();
    assert.ok(got !== null, '并发写之后必须还能读出合法内容');
    assert.ok([1111, 2222, 3333].includes(got.port));
    // 不该留下临时文件
    const leftovers = (await fs.readdir(DISCOVERY_DIR)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('目录不存在时会自己建', async () => {
  await withCleanDiscovery(async () => {
    await fs.rm(DISCOVERY_DIR, { recursive: true, force: true });
    assert.equal(await writeDiscovery({ port: 3458 }), true);
    assert.equal(readDiscovery().port, 3458);
  });
});
