/**
 * 端口发现 —— 两侧不用各填一次端口
 *
 * ## 要解决的问题
 *
 * 桥的端口可能不是 3458（被占用、用户改过、多实例）。如果只让 DSH 侧填
 * `bridgeUrl`，用户根本不知道该填几号——填错的表现是"保存成功但什么也不发生"，
 * 极难排查。
 *
 * ## 做法
 *
 * Ling-bot 启动桥之后，把**实际监听到的端口**写进一个两边都算得出来的位置：
 *
 *   `<用户主目录>/.ling-bot/bridge.json`
 *
 * 内容是 `{ port, token?, pid, updatedAt }`。
 * DSH 侧插件的 `bridgeUrl` 留空时，就去读这个文件。
 *
 * ## 为什么放在用户主目录，而不是各自的 userData
 *
 * 两个程序的 userData 不一样（`ling-bot` 与 `@deepseek-ai/dsh-desktop`），
 * 而它们跑在同一个 Windows 账户下。主目录是唯一"两边天然共享"的位置，
 * 不需要用户去指定路径。
 *
 * ## 三条规则
 *
 * 1. **只放端口和 pid，不放令牌。** 令牌是密码，落盘就多一处泄露面；
 *    端口是路由信息，被人知道也没用（还有 Bearer 鉴权）。
 * 2. **写入是原子的**（先写临时文件再 rename），
 *    避免 DSH 读到写了一半的文件。
 * 3. **读失败一律当作"没有"**，不抛错——发现机制不能成为新的故障点。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 发现文件的固定位置（两侧都必须算出同一个路径） */
export const DISCOVERY_DIR = path.join(os.homedir(), '.ling-bot');
export const DISCOVERY_FILE = path.join(DISCOVERY_DIR, 'bridge.json');

/**
 * 写入发现信息。失败不抛错（返回 false），因为这只是"方便"，
 * 不该让桥起不来。
 *
 * @param {{port: number, pid?: number}} info
 * @returns {Promise<boolean>}
 */
export async function writeDiscovery(info) {
  try {
    await fsp.mkdir(DISCOVERY_DIR, { recursive: true });
    const body = JSON.stringify(
      {
        port: info.port,
        pid: info.pid ?? process.pid,
        updatedAt: Date.now(),
      },
      null,
      2,
    );
    // 原子替换：先写 .tmp 再 rename。
    // 直接覆写的话，DSH 可能读到空文件或半个 JSON。
    const tmp = `${DISCOVERY_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, DISCOVERY_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删掉发现文件（桥正常关闭时调用）。
 *
 * 进程被强杀时删不掉，那没关系：读取方会校验 pid 还活着。
 *
 * @returns {Promise<void>}
 */
export async function clearDiscovery() {
  try {
    await fsp.unlink(DISCOVERY_FILE);
  } catch {
    /* 本来就没有，或者删不掉：都不影响 */
  }
}

/**
 * 读发现信息。
 *
 * @returns {{port: number, pid: number, updatedAt: number} | null}
 */
export function readDiscovery() {
  try {
    const raw = fs.readFileSync(DISCOVERY_FILE, 'utf8');
    const v = JSON.parse(raw);
    const port = Number(v?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      port,
      pid: Number(v?.pid) || 0,
      updatedAt: Number(v?.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * 判断发现信息是不是**活的**。
 *
 * 文件可能是上次异常退出的残留。判断依据是那个 pid 还在不在跑。
 * 拿不到进程信息时**假定还活着**——宁可多试一次连接，
 * 也不要因为查不到进程就误判成"没在跑"。
 *
 * @param {{pid: number}} info
 * @returns {boolean}
 */
export function isDiscoveryAlive(info) {
  if (!info?.pid) return true;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 进程不存在；EPERM = 存在但没权限发信号（也算活着）
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * 算出要连的地址。优先用显式配置的 URL，其次读发现文件。
 *
 * 这个函数的顺序很重要：**用户显式填的永远优先**。
 * 自动发现只是"没填时"的兜底，不能反过来覆盖用户的选择。
 *
 * @param {string} configuredUrl 用户填的地址（可为空）
 * @returns {string | null} 形如 http://127.0.0.1:3458，拿不到返回 null
 */
export function resolveBridgeUrl(configuredUrl) {
  const explicit = String(configuredUrl ?? '').trim();
  if (explicit) return explicit;

  const found = readDiscovery();
  if (!found) return null;
  if (!isDiscoveryAlive(found)) return null;
  return `http://127.0.0.1:${found.port}`;
}
