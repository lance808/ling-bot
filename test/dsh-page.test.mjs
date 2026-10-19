/**
 * DSH 接入页 —— 未保存的编辑不能被子重渲染冲掉
 *
 * 这个 bug 的表现是"点生成拿到新令牌，保存后显示框里又变回旧的"。
 * 根因很典型：页面每次 `pull()` 都整页重渲染，`local` 从快照重新初始化，
 * 而快照要等下一次拉取才更新——中间那一刻显示的就是旧值。
 *
 * 这里不渲染 DOM，只检查结构：草稿必须存在、必须被读取、必须被清掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const SRC = new URL('../ui/src/views/dsh.mjs', import.meta.url);

async function readSource() {
  return await fs.readFile(SRC, 'utf8');
}

/** 去掉注释行，只看真正执行的代码 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n');
}

test('★ 有模块级草稿对象（跨重渲染保留）', async () => {
  const src = await readSource();
  assert.match(src, /const draft = \{/, '草稿必须在模块作用域，不能在 renderDsh 内部');
});

test('★ local 初始化时草稿优先于快照', async () => {
  const src = codeOnly(await readSource());
  // token 那一行必须写成 draft.token ?? 快照值
  assert.match(src, /token:\s*draft\.token\s*\?\?/, 'token 必须先读草稿');
  assert.match(src, /admins:\s*draft\.admins\s*\?\?/, 'admins 必须先读草稿');
  assert.match(src, /port:\s*draft\.port\s*\?\?/, 'port 必须先读草稿');
  assert.match(src, /sessionId:\s*draft\.sessionId\s*\?\?/, 'sessionId 必须先读草稿');
});

test('★ 点「生成」要把新令牌写进草稿', async () => {
  const src = codeOnly(await readSource());
  // 注意要跳过函数定义那一处，找真正的调用点
  const i = src.indexOf('local.token = mintToken()');
  assert.ok(i > 0, '应存在生成逻辑的调用点');
  const block = src.slice(i, i + 400);
  assert.match(block, /draft\.token\s*=/, '生成后必须记草稿，否则重渲染就丢');
});

test('★ 保存成功后要清草稿', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /clearDraft\(\)/, '保存成功必须清草稿，否则草稿会永久压住快照');
});

test('★ 显示/隐藏状态也要跨重渲染保持', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /draft\.revealed\s*=/, '展开状态要记住，否则一重渲染又遮回去');
  assert.match(src, /revealed:\s*draft\.revealed\s*===?\s*true/, '初始化要读回展开状态');
});

test('令牌输入框默认是密码类型（不能默认明文）', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /type:\s*'password'/, '令牌默认必须遮起来');
});
