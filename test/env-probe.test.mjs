/**
 * 环境体检：判定逻辑与安全边界
 *
 * 这里只测**纯判定**（版本比较、目录识别、端口探测），不真的去启动
 * 任何程序，也不依赖本机装没装 QQ / SnowLuma —— 测试要能在任何机器上过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkNodeVersion,
  inspectSnowLumaDir,
  findSnowLuma,
  isPortOpen,
  downloadUrls,
  processCount,
  NODE_REQUIRED,
} from '../src/env/probe.mjs';

/* ------------------------------------------------------------ Node 版本 */

test('★ Node 版本按 >=24.22.0 <25 判定', () => {
  assert.equal(checkNodeVersion('v24.22.0').ok, true);
  assert.equal(checkNodeVersion('v24.23.1').ok, true);
  assert.equal(checkNodeVersion('24.22.0').ok, true, '不带 v 也要认');

  // 主版本不对：太低要明确说"版本过低"，太高要说"超出范围"——
  // 这两种情况的处理方式不同（一个该升级，一个是环境不对）
  const low = checkNodeVersion('v22.0.0');
  assert.equal(low.ok, false);
  assert.match(low.reason, /过低/);

  const high = checkNodeVersion('v26.0.0');
  assert.equal(high.ok, false);
  assert.match(high.reason, /主版本/);

  // 同主版本但小版本不够
  assert.equal(checkNodeVersion('v24.21.9').ok, false);
  assert.equal(checkNodeVersion('v24.1.0').ok, false);

  // 解析不了不能当成通过
  assert.equal(checkNodeVersion('').ok, false);
  assert.equal(checkNodeVersion('abc').ok, false);
  assert.equal(checkNodeVersion(null).ok, false);
});

test('基线常量与 .nvmrc 一致', () => {
  const nvmrc = fs
    .readFileSync(path.join(import.meta.dirname, '..', '.nvmrc'), 'utf8')
    .trim();
  const want = `${NODE_REQUIRED.major}.${NODE_REQUIRED.minor}.${NODE_REQUIRED.patch}`;
  assert.equal(nvmrc, want, `.nvmrc 是 ${nvmrc}，但代码里要求 ${want}`);
});

/* ------------------------------------------------------------ SnowLuma 目录 */

test('★ 空目录 / 残留目录不算已安装', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  try {
    // 只有目录、没有文件
    assert.equal(inspectSnowLumaDir(tmp).installed, false);

    // 有 index.mjs 但没有 release.json
    fs.writeFileSync(path.join(tmp, 'index.mjs'), '// x');
    assert.equal(inspectSnowLumaDir(tmp).installed, false);

    // release.json 损坏
    fs.writeFileSync(path.join(tmp, 'release.json'), '{ not json');
    assert.equal(inspectSnowLumaDir(tmp).installed, false);

    // release.json 里没 version
    fs.writeFileSync(path.join(tmp, 'release.json'), '{"target":"win32-x64"}');
    assert.equal(inspectSnowLumaDir(tmp).installed, false);

    // 齐了才算
    fs.writeFileSync(path.join(tmp, 'release.json'), '{"version":"2.0.0"}');
    const ok = inspectSnowLumaDir(tmp);
    assert.equal(ok.installed, true);
    assert.equal(ok.version, '2.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findSnowLuma 能认出显式给的目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl2-'));
  try {
    fs.writeFileSync(path.join(tmp, 'index.mjs'), '// x');
    fs.writeFileSync(path.join(tmp, 'release.json'), '{"version":"9.9.9"}');
    const r = findSnowLuma(tmp);
    assert.equal(r.installed, true);
    assert.equal(r.version, '9.9.9');
    assert.equal(r.dir, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ 端口探测 */

test('★ 端口探测：关着的端口判定为未开放', async () => {
  // 用一个几乎不可能被占用的高位端口
  assert.equal(await isPortOpen(59999, { timeoutMs: 300 }), false);
});

test('端口探测不会因为超时而挂住', async () => {
  const started = Date.now();
  // 未监听 → 立刻 ECONNREFUSED，不该等到超时
  await isPortOpen(59998, { timeoutMs: 500 });
  assert.ok(Date.now() - started < 3000, '不应长时间阻塞');
});

/* ------------------------------------------------------------ 下载直链 */

test('下载地址直达版本目录，不是官网首页', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    const u = downloadUrls(p);
    // 必须是 dist 下的具体平台目录（进去就是安装包），而不是 nodejs.org 根
    assert.match(u.node, /nodejs\.org\/dist\/latest-v24\.x\//, `${p} 的 Node 地址应直达 dist 目录`);
    assert.ok(!/^https:\/\/nodejs\.org\/?$/.test(u.node), '不能只给官网首页');
    // SnowLuma 必须指向 releases，而不是它的主页
    assert.match(u.snowluma, /SnowLuma\/SnowLuma\/releases/);
  }
});

test('未知平台也有可用的兜底地址', () => {
  const u = downloadUrls('sunos');
  assert.match(u.node, /^https:\/\/nodejs\.org\/dist\/latest-v24\.x\//);
  assert.ok(u.snowluma);
});

/* ------------------------------------------------------------ 进程存活判断 */

/*
 * 这一组守的是一个真出现过的 bug：原来用 `tasklist /FI ... /NH` 的输出
 * 去正则匹配 "QQ.exe"，但
 *   1) 中文 Windows 上 tasklist 输出是 GBK，utf8 解码后是乱码；
 *   2) "没有匹配任务" 那句提示语里也含 QQ.exe，会把 0 个进程误判成有。
 * 结果就是启动成功却报失败、状态点乱跳。
 *
 * 现在改成拿结构化计数，这里钉住它的语义。
 */

test('★ 不存在的进程名计数为 0', () => {
  assert.equal(processCount('definitely-not-a-real-process-xyz.exe'), 0);
});

test('计数结果是整数且非负', () => {
  const n = processCount('node.exe');
  assert.ok(Number.isInteger(n), `应返回整数，实际 ${n}`);
  assert.ok(n >= 0);
});

test('进程名不区分大小写也能查（Windows 语义）', () => {
  // 大写的系统进程
  const upper = processCount('EXPLORER.EXE');
  const lower = processCount('explorer.exe');
  assert.equal(upper, lower, '大小写应得到相同结果');
});

test('不解析本地化文本：特殊字符的进程名不会误判', () => {
  // 含正则元字符的进程名不该让函数抛异常或误报
  assert.equal(processCount('.*.exe'), 0);
});
