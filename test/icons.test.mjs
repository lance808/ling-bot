/**
 * 图标路径解析的单测（纯 Node，不需要 Electron）。
 *
 * 覆盖的是"用户自定义不存在/损坏时回落到内置"这条最要紧的规则 ——
 * 它一旦出错，表现是托盘空白或启动崩溃，属于最难排查的那类。
 *
 * 真正的解码校验（nativeImage.isEmpty）在主进程里还有一层，
 * 这里只测文件系统层面的那部分。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ICON_SIZES,
  PNG_SIGNATURE,
  assertIconKind,
  builtinIconPaths,
  customIconDir,
  customIconPath,
  fitToSquare,
  looksLikePngFile,
  pickIconPath,
} from '../electron/icons.mjs';

/** 建一个临时目录，测完删掉 */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ling-icon-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('内置图标路径指向 assets 下的 icon.png / tray.png', () => {
  const paths = builtinIconPaths('/repo/assets');
  assert.equal(paths.app, path.join('/repo/assets', 'icon.png'));
  assert.equal(paths.tray, path.join('/repo/assets', 'tray.png'));
});

test('自定义图标落在 <数据根目录>/icons/<kind>.png', () => {
  const root = path.join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'Ling-bot');
  assert.equal(customIconDir(root), path.join(root, 'icons'));
  assert.equal(customIconPath(root, 'app'), path.join(root, 'icons', 'app.png'));
  assert.equal(customIconPath(root, 'tray'), path.join(root, 'icons', 'tray.png'));
});

test('自定义图标不存在时回落到内置默认', (t) => {
  const dir = tmpDir(t);
  const builtinPath = path.join(dir, 'icon.png');
  fs.writeFileSync(builtinPath, treePng());

  const picked = pickIconPath({
    customPath: path.join(dir, 'icons', 'app.png'), // 不存在
    builtinPath,
  });

  assert.equal(picked, builtinPath, '自定义不存在时必须回落到内置');
});

test('自定义图标存在且是合法 PNG 时优先生效', (t) => {
  const dir = tmpDir(t);
  const builtinPath = path.join(dir, 'icon.png');
  const customPath = path.join(dir, 'icons', 'app.png');
  fs.writeFileSync(builtinPath, treePng());
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.writeFileSync(customPath, treePng());

  assert.equal(pickIconPath({ customPath, builtinPath }), customPath);
});

test('自定义文件损坏（不是 PNG）时回落到内置，而不是硬用坏文件', (t) => {
  const dir = tmpDir(t);
  const builtinPath = path.join(dir, 'icon.png');
  const customPath = path.join(dir, 'icons', 'tray.png');
  fs.writeFileSync(builtinPath, treePng());
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.writeFileSync(customPath, Buffer.from('这不是 PNG 内容'));

  assert.equal(looksLikePngFile(customPath), false);
  assert.equal(pickIconPath({ customPath, builtinPath }), builtinPath);
});

test('自定义文件是空文件时回落到内置', (t) => {
  const dir = tmpDir(t);
  const builtinPath = path.join(dir, 'icon.png');
  const customPath = path.join(dir, 'icons', 'tray.png');
  fs.writeFileSync(builtinPath, treePng());
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.writeFileSync(customPath, Buffer.alloc(0));

  assert.equal(pickIconPath({ customPath, builtinPath }), builtinPath);
});

test('校验函数本身抛错时也要回落到内置（不能把异常冒出去）', (t) => {
  const dir = tmpDir(t);
  const builtinPath = path.join(dir, 'icon.png');
  const customPath = path.join(dir, 'icons', 'app.png');
  fs.writeFileSync(builtinPath, treePng());
  fs.mkdirSync(path.dirname(customPath), { recursive: true });
  fs.writeFileSync(customPath, treePng());

  const picked = pickIconPath({
    customPath,
    builtinPath,
    isUsable: () => {
      throw new Error('模拟解码失败');
    },
  });

  assert.equal(picked, builtinPath);
});

test('looksLikePngFile 只认真正的 PNG 魔数', (t) => {
  const dir = tmpDir(t);
  const good = path.join(dir, 'good.png');
  const jpeg = path.join(dir, 'actually-jpeg.png');
  fs.writeFileSync(good, treePng());
  // JPEG 头被改名为 .png —— 只看扩展名会误判
  fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));

  assert.equal(looksLikePngFile(good), true);
  assert.equal(looksLikePngFile(jpeg), false);
  assert.equal(looksLikePngFile(path.join(dir, 'missing.png')), false);
});

test('fitToSquare 等比缩放：正方形源图结果仍是正方形', () => {
  assert.deepEqual(fitToSquare(2048, 2048, 256), { width: 256, height: 256 });
  assert.deepEqual(fitToSquare(2048, 2048, 32), { width: 32, height: 32 });
  // 512 已经小于 tray 的 32？不会：一律缩到目标尺寸，不放大也不留原尺寸
  assert.deepEqual(fitToSquare(64, 64, 32), { width: 32, height: 32 });
});

test('fitToSquare 对非正方形按长边适配，不裁切也不拉伸', () => {
  assert.deepEqual(fitToSquare(400, 200, 256), { width: 256, height: 128 });
  assert.deepEqual(fitToSquare(200, 400, 256), { width: 128, height: 256 });
});

test('assertIconKind 对非法种类直接抛错（fail-closed）', () => {
  assert.equal(assertIconKind('app'), 'app');
  assert.equal(assertIconKind('tray'), 'tray');
  assert.throws(() => assertIconKind('window'), /未知的图标种类/);
  assert.throws(() => assertIconKind(''), /未知的图标种类/);
});

test('目标尺寸符合交付要求：窗口 256、托盘 32', () => {
  assert.equal(ICON_SIZES.app, 256);
  assert.equal(ICON_SIZES.tray, 32);
});

/** 造一个最小但合法的 1x1 PNG（不依赖任何图像库） */
function treePng() {
  // 手写的 1x1 透明 PNG：IHDR + IDAT + IEND
  return Buffer.concat([
    PNG_SIGNATURE,
    Buffer.from([
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR 长度与类型
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 宽 1 高 1
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
      0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, // IDAT
      0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
      0x0d, 0x0a, 0x2d, 0xb4,
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]),
  ]);
}
