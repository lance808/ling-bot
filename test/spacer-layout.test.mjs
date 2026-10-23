/**
 * 间距占位块被当成容器 —— 静音页输入框与「移出」按钮重叠
 *
 * ## 这个 bug 的形态很特别
 *
 * `.spacer-8` 的定义是 `height: 8px`，语义是"留 8 像素空白"。
 * 但它被写成了容器：
 *
 *   el('div', { class: 'spacer-8' }, [ ...管理员列表... ])
 *
 * 盒子只有 8px 高，列表内容按自己的高度渲染并**溢出到盒子外**，
 * 压住下面的输入行 —— 截图里「移出」按钮和输入框叠在一起。
 *
 * 它不报错、不崩溃、DOM 结构完全合法，浏览器也照常渲染。
 * 唯一的证据是"看起来坏了"，所以必须用测试钉住。
 *
 * 正确写法：容器不带 spacer，间距作为第一个子元素。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const VIEWS_DIR = path.join(ROOT, 'ui', 'src', 'views');
const viewFiles = readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.mjs'));

/* ------------------------------------------------------------ 核心回归 */

test('★ 没有把 .spacer-* 当成容器用的地方', () => {
  /*
   * 这是本 bug 的直接形态：spacer 类后面紧跟子元素数组。
   * 全量扫，防止别处还有同样写法。
   */
  const offenders = [];
  for (const f of viewFiles) {
    read(path.join('ui/src/views', f))
      .split('\n')
      .forEach((line, i) => {
        if (/class:\s*['"`]spacer-\d+['"`]\s*\}\s*,\s*\[/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方把固定高度的占位块当容器了（子内容会溢出压住后面的元素）：\n${offenders.join('\n')}`,
  );
});

test('★ .row 上没有叠加 .spacer-*', () => {
  /*
   * 同一个坑的另一种写法：`.row` 是 flex 行，叠上 height:8px
   * 会把整行压成 8 像素高，行内元素全部溢出。
   */
  const offenders = [];
  for (const f of viewFiles) {
    read(path.join('ui/src/views', f))
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/class:\s*['"`]([^'"`]*)['"`]/g)) {
          if (/\brow\b/.test(m[1]) && /\bspacer-\d+\b/.test(m[1])) {
            offenders.push(`${f}:${i + 1} → "${m[1]}"`);
          }
        }
      });
  }
  assert.deepEqual(offenders, [], `这些 .row 叠加了 .spacer-*：\n${offenders.join('\n')}`);
});

/* ------------------------------------------------------------ CSS 事实 */

test('★ .spacer-* 确实是固定高度（这就是不能当容器的原因）', () => {
  /*
   * 如果哪天 spacer 改成 margin 或者 min-height，这条规则的前提就变了，
   * 对应的检查也该跟着调整。所以把前提本身也钉住。
   */
  const base = read('ui/styles/base.css');
  const pages = read('ui/styles/pages.css');
  const all = base + pages;

  for (const cls of ['spacer-8', 'spacer-10', 'spacer-12', 'spacer-16']) {
    // 找到该类的规则体
    const re = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`);
    const m = all.match(re);
    assert.ok(m, `应有 .${cls} 的定义`);
    assert.match(
      m[1],
      /height:\s*\d+px/,
      `.${cls} 应该是固定 height（当前：${m[1].trim()}）—— 若改成 min-height 或 margin，请同步调整本文件的检查`,
    );
    assert.ok(
      !/min-height|margin/.test(m[1]),
      `.${cls} 不该用 min-height/margin，否则"不能当容器"的前提不成立`,
    );
  }
});

/* ------------------------------------------------------------ 具体修复点 */

test('★ 静音页管理员列表不再压住输入框', () => {
  /*
   * 截图里出问题的就是这一处：adminIds 列表溢出后盖住了
   * 「QQ 号，例如 10001」输入框和「填好按回车加入」提示。
   */
  const src = read('ui/src/views/silence.mjs');

  // 容器必须是普通 div（不带 spacer）
  assert.ok(
    !/adminIds\.length\s*>\s*0\s*\n\s*\?\s*el\('div',\s*\{\s*class:\s*'spacer-/.test(src),
    'adminIds 列表的容器不能再是 spacer',
  );
  // 间距仍要保留，作为第一个子元素
  assert.match(
    src,
    /adminIds\.length\s*>\s*0[\s\S]{0,120}?el\('div',\s*\{\s*class:\s*'spacer-8'\s*\}\)/,
    '间距应作为第一个子元素单独放，别把间距一起删掉',
  );
});

test('★ 静音页其余三处列表也一并修了', () => {
  /*
   * 同一个文件里 temp / convKeys / windows 三个列表是同样的写法。
   * 只修截图里看得见的那一处，另外三处会以同样方式坏掉 ——
   * 只是当时没数据、没显示出来而已。
   *
   * 注意只看**容器本身**的属性：正确的写法里，容器之后第一个子元素
   * 就是 spacer，用大范围匹配会把那个合法的 spacer 也算进来。
   */
  const src = read('ui/src/views/silence.mjs');
  for (const list of ['temp', 'convKeys', 'windows']) {
    const re = new RegExp(`${list}\\.length\\s*>\\s*0\\s*\\?\\s*el\\('div',\\s*\\{([^}]*)\\}`);
    const m = src.match(re);
    assert.ok(m, `应能找到 ${list} 的渲染分支`);
    assert.ok(!/spacer-/.test(m[1]), `${list} 的容器不能再是 spacer（当前：{${m[1].trim()}}）`);
  }
});

test('★ 日记要点区块也修了（同一个坑）', () => {
  const src = read('ui/src/views/diary.mjs');
  assert.ok(
    !/highlights[\s\S]{0,40}?\?\s*el\('div',\s*\{\s*class:\s*'spacer-/.test(src),
    '日记要点的容器不能再是 spacer',
  );
});

/* ------------------------------------------------------------ 文案 */

test('★ 指令权限说明前后一致（不能既说谁都不能用、又说谁都能用）', () => {
  /*
   * 原文案：「留空 = 谁都不能用指令」+「不填的话，群里任何人都能让它闭嘴」。
   * 这两句互相矛盾 —— 留空意味着没人能用指令，那也就不可能有人让它闭嘴。
   *
   * 改成：「不填的话，没人能让他闭嘴。」
   */
  const src = read('ui/src/views/silence.mjs');

  assert.match(src, /不填的话，没人能让他闭嘴/, '应说明不填就没人能操作');
  assert.ok(
    !/群里任何人都能让它闭嘴/.test(src),
    '不该再有"群里任何人都能让它闭嘴"——它与"留空 = 谁都不能用指令"矛盾',
  );
  assert.ok(!/可以拿来骚扰/.test(src), '这句也随之删除（前提不成立了）');
});
