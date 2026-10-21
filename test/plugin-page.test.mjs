/**
 * 插件页的草稿与密钥显示 —— 原来 DSH 专用页上踩过的坑，现在要在通用页上守住
 *
 * 这个 bug 的表现是"点生成拿到新令牌，保存后显示框里又变回旧的"。
 * 根因很典型：页面每次 `pull()` 都整页重渲染，表单值从快照重新初始化，
 * 而快照要等下一次拉取才更新——中间那一刻显示的就是旧值。
 *
 * DSH 现在是普通插件，配置表单由 `item.config` 声明生成（见
 * ui/src/views/plugins.mjs 的 configField/collectForm）。所以这些断言
 * 落在通用实现上：**任何**插件的配置项都应该有同样的保证。
 *
 * 这里不渲染 DOM，只检查结构。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const SRC = new URL('../ui/src/views/plugins.mjs', import.meta.url);

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
  assert.match(src, /const ui = \{/, '页面级状态必须在模块作用域');
  assert.match(src, /draft: Object\.create\(null\)/, '草稿必须在模块作用域，不能在渲染函数内部');
});

test('★ 表单值初始化时草稿优先于快照', async () => {
  const src = codeOnly(await readSource());
  // 关键那一行：有草稿用草稿，没草稿才回落到声明里的值
  assert.match(src, /draftKey in ui\.draft \? ui\.draft\[draftKey\] :/, '必须先读草稿');
});

test('★ 草稿键要带插件 id（否则两个插件的同名字段会串味）', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /const draftKey = `\$\{item\.id\}\.\$\{key\}`/, '草稿键必须是 id.key');
});

test('★ 点「生成」要把新令牌写进草稿', async () => {
  const src = codeOnly(await readSource());
  const i = src.indexOf('const token = mintToken()');
  assert.ok(i > 0, '应存在生成令牌的调用点');
  const block = src.slice(i, i + 500);
  assert.match(block, /ui\.draft\[draftKey\] = token/, '生成后必须记草稿，否则重渲染就丢');
  assert.match(block, /\.value = token/, '生成后输入框要立刻显示出来');
});

test('★ 保存成功后要清草稿', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /clearDraft\(item\.id, item\)/, '保存成功必须清草稿，否则草稿会永久压住快照');
});

test('★ 密钥字段永远不回显，只显示"是否已设置"', async () => {
  const src = codeOnly(await readSource());
  // 快照里密钥的 value 恒为空（后端 toView 保证），前端再兜一层：
  // 显示的是 hasSecret 而非真实值。
  assert.match(src, /isSecret && spec\.hasSecret/, '要用 hasSecret 表达"已设置"');
  assert.match(src, /留空保持不变/, '要告诉用户留空的语义');
});

test('密钥输入框默认是密码类型（不能默认明文）', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /isSecret \? 'password' : 'text'/, '密钥默认必须遮起来');
});

test('★ 高风险开关的确认框跨重绘保留', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /dangerAsk/, '要有确认框状态');
  assert.match(src, /renderConfirm\(ui\.dangerAsk === true\)/, '重绘后要按状态恢复');
});

test('★ 不许把 .spacer-8 叠在 .row 上（会把按钮行压成 8px）', async () => {
  /*
   * base.css 的 .spacer-8 是 height:8px 的**占位块**。
   * 把它和 .row 写在同一个 class 里，整行高度就被锁成 8px，
   * 保存/测试/重载按钮被裁掉一半 —— 表现像"按钮没渲染出来"。
   *
   * 正确写法是单独放一个占位 div。这条测试守的是别改回去。
   */
  const src = codeOnly(await readSource());
  const bad = [...src.matchAll(/class: '([^']*)'/g)]
    .map((m) => m[1])
    .filter((c) => /(^|\s)row(\s|$)/.test(c) && /(^|\s)spacer-/.test(c));
  assert.deepEqual(bad, [], 'row 上不能再叠 spacer-*');
});

test('★ 日志时间按本地时区显示（不是截 ISO 的 UTC）', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /function localStamp/, '要有本地时间格式化函数');
  // 旧写法会把 UTC 直接截出来，东八区差 8 小时
  assert.ok(
    !/replace\('T', ' '\)\.slice\(0, 19\)/.test(src),
    '不能再用 slice 硬截 ISO 串（那是 UTC）',
  );
});

test('★ 声明了专用页面的插件要显式告知「当前不渲染」', async () => {
  const src = codeOnly(await readSource());
  assert.match(src, /item\.ui &&/, '要检查 ui 声明');
  assert.match(src, /声明了专用页面/, '要显示出来');
});

test('★ 数组里出现 null 元素不能把整页渲染搞挂', async () => {
  const src = codeOnly(await readSource());
  /*
   * 契约 §10.1 要求对脏数据容错。`config` / `tools` / `log` 的元素会被
   * 拿去读 `.key` / `.fullName` / `.message`，遇到 null 直接 TypeError，
   * 整页渲染挂掉 —— 用户看到"渲染失败"却不知道是哪个插件的问题。
   *
   * 只点名这三个字段：`p.items` 只做整体遍历，`spec.options` 只是
   * 透传给 <option>，都不需要过滤。
   */
  for (const field of ['config', 'tools', 'log']) {
    const raw = new RegExp(`Array\\.isArray\\([^)]*\\.${field}\\) \\? [^:]+ : \\[\\]`);
    const hit = src.match(raw);
    if (hit) {
      assert.match(hit[0], /filter\(Boolean\)/, `${field} 取值要带 .filter(Boolean)`);
    }
  }
});

test('★ 有更新时给出「更新」按钮（热更新不用重启程序）', async () => {
  /*
   * 磁盘上的插件包被换掉后，界面要能一键让它生效。
   *
   * 这里守的是"别退化成弹窗让用户重启"：plugin.reload 会重新读盘、
   * 重建运行时、重新登记工具，全程不重启后端（e2e 里验过）。
   * 所以正确做法是给按钮，不是给提示。
   */
  const src = codeOnly(await readSource());
  assert.match(src, /item\.hasUpdate/, '要检查"有更新"标记');
  assert.match(src, /ctx\.onReload\?\./, '要调用重载');
  assert.match(src, /'更新'/, '按钮文案是「更新」');
  // 不该出现"请重启程序"这类把活推给用户的文案
  assert.ok(!/请重启(程序|应用|后端)/.test(src), '不要把重启推给用户');
});

test('★ 侧边栏入口叫「插件设置」', async () => {
  const app = await fs.readFile(new URL('../ui/src/app.mjs', import.meta.url), 'utf8');
  const line = app.split('\n').find((l) => l.includes("id: 'plugins'"));
  assert.ok(line, '要能找到插件页注册');
  assert.match(line, /label: '插件设置'/, '导航文案是「插件设置」');
});
