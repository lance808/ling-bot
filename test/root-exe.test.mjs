/**
 * 根目录启动器的约定
 *
 * 根目录那个 Ling-bot.exe 是仓库里唯一的二进制，也是最容易出问题的地方：
 * 它可能是旧版本、可能被 .gitignore 顺手挡掉、也可能和 desktop/ 源码对不上。
 * 这些断言都不启动程序，只检查"它还在、没被忽略、有来源"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeName = process.platform === 'win32' ? 'Ling-bot.exe' : 'Ling-bot';
const exePath = path.join(repoRoot, exeName);

test('★ 根目录要有可双击的启动器', () => {
  assert.ok(fs.existsSync(exePath), `缺少 ${exeName}（用 npm run build:root-exe 生成）`);
  const size = fs.statSync(exePath).size;
  // 太小说明是个占位文件或脚本，不是真正的桌面端
  assert.ok(size > 1024 * 1024, `${exeName} 只有 ${size} 字节，不像真正的构建产物`);
});

test('★ 根目录启动器不能被 .gitignore 挡掉', () => {
  /*
   * .gitignore 里有 `*.exe`（历史上漏提交过产物，所以用通配挡）。
   * 根目录这个 exe 故意例外：它是"clone 完直接双击"的入口。
   * 一旦那条 `!/Ling-bot.exe` 被删或写错，文件会静默不入库 ——
   * 而本机看起来一切正常，只有别人 clone 后才发现没有。
   */
  const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  assert.match(ignore, /^\*\.exe$/m, '仍要有 *.exe 通配兜底');
  assert.match(ignore, /^!\/Ling-bot\.exe$/m, '必须显式放行根目录的 Ling-bot.exe');
});

test('★ 启动器有可复现的构建来源', () => {
  // 二进制入库可以，但不能是"某次手工复制、没人知道怎么来的"
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-root-exe.mjs'), 'utf8');
  assert.match(script, /cargo/, '脚本要真的调用 cargo 构建');
  assert.match(script, /copyFileSync/, '要把构建产物复制到根目录');

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['build:root-exe'], 'package.json 要有 build:root-exe 命令');
});

test('★ 启动器不是自包含的，README 必须说清前置 Node', () => {
  /*
   * 这个 exe 只承担窗口与后端进程管理；后端本身是 Node 脚本。
   * 在没有 node 的机器上双击能开窗，但后端起不来、界面显示"后端未运行"。
   * 这是真实踩到的状态，所以文档必须写明，不能让人以为双击就完事。
   */
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /Node/, 'README 要提到 Node');
  assert.match(readme, /24\.22/, '要写明 Node 版本基线');

  // 后端定位逻辑里必须仍有 PATH 上的 node 作为兜底
  const backend = fs.readFileSync(path.join(repoRoot, 'desktop', 'src', 'backend.rs'), 'utf8');
  assert.match(backend, /LING_NODE/, '要支持用 LING_NODE 显式指定 node');
  assert.match(backend, /"node"\.to_string\(\)/, '要保留 PATH 上的 node 兜底');
});
