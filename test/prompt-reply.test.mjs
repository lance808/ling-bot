/**
 * 引用回复 1/2/3/4 的解析
 *
 * 这一层最危险的错误是**把拒绝当成同意**。所以规则很硬：
 * 只认数字、只认当初发出去的那张表、越界一律拒绝、不猜。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approvalChoices,
  questionChoices,
  renderPrompt,
  parseReply,
  splitRecommended,
  looksRisky,
} from '../plugins/dsh-bridge/lib/prompt.mjs';

/* ------------------------------------------------------------------ 审批 */

test('审批固定两项，key 与 DSH 的 ApprovalOutcome 对齐', () => {
  const s = approvalChoices();
  assert.equal(s.choices.length, 2);
  assert.equal(s.choices[0].key, 'allowed-once');
  assert.equal(s.choices[1].key, 'rejected');
  assert.equal(s.choices[0].label, '允许一次');
  assert.equal(s.choices[1].label, '拒绝');
});

test('审批回 1 = 允许一次', () => {
  const r = parseReply('1', approvalChoices());
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['allowed-once']);
});

test('审批回 2 = 拒绝', () => {
  const r = parseReply('2', approvalChoices());
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['rejected']);
});

test('★ 审批越界不猜（回 3 必须失败，不能当成拒绝）', () => {
  const r = parseReply('3', approvalChoices());
  assert.equal(r.ok, false);
  assert.match(r.reason, /只有 1~2/);
});

/* ------------------------------------------------------------------ 提问 */

const multiQ = {
  questions: [
    {
      id: 'q1',
      question: '要改哪些文件？',
      header: '选择范围',
      options: [
        { label: '只改 README', description: '最小改动' },
        { label: '改源码', description: '会影响行为' },
        { label: '两边都改' },
      ],
    },
  ],
};

test('提问的选项来自实际数据，编号连续', () => {
  const s = questionChoices(multiQ);
  assert.equal(s.choices.length, 3);
  assert.equal(s.choices[0].key, '1');
  assert.equal(s.choices[1].key, '2');
  assert.equal(s.choices[2].key, '3');
});

test('★ 选项文案来自 DSH，不是我写死的', () => {
  const s = questionChoices(multiQ);
  assert.equal(s.choices[0].label, '只改 README');
  assert.equal(s.choices[1].label, '改源码');
  // 如果这里变成"同意/拒绝"，说明又写死了
  assert.notEqual(s.choices[0].label, '同意');
});

test('提问回 2 命中第二项', () => {
  const r = parseReply('2', questionChoices(multiQ));
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['2']);
});

test('多题时编号跨题连续', () => {
  const two = {
    questions: [
      { id: 'a', question: '第一题', options: [{ label: 'A1' }, { label: 'A2' }] },
      { id: 'b', question: '第二题', options: [{ label: 'B1' }, { label: 'B2' }] },
    ],
  };
  const s = questionChoices(two);
  assert.equal(s.choices.length, 4);
  assert.deepEqual(
    s.choices.map((c) => c.key),
    ['1', '2', '3', '4'],
  );
});

test('多选题接受 1,3', () => {
  const q = {
    questions: [
      {
        id: 'm',
        question: '选几个',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
    ],
  };
  const s = questionChoices(q);
  const r = parseReply('1,3', s);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['1', '3']);
});

test('★ 单选时回多个必须拒绝（不能默默取第一个）', () => {
  const r = parseReply('1,2', questionChoices(multiQ));
  assert.equal(r.ok, false);
  assert.match(r.reason, /只能选一个/);
});

/* ------------------------------------------------------- 「4.XXXX」格式 */

test('★ 编号 + 说明：4.补充内容', () => {
  const q = {
    questions: [
      {
        id: 'x',
        question: '怎么做',
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: '其他' }],
      },
    ],
  };
  const r = parseReply('4.先备份再改', questionChoices(q));
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['4']);
  assert.equal(r.note, '先备份再改');
});

test('中文标点也认：4。补充内容', () => {
  const q = { questions: [{ id: 'x', question: 'q', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] }] };
  const r = parseReply('4。先备份', questionChoices(q));
  assert.equal(r.ok, true);
  assert.equal(r.note, '先备份');
});

test('冒号也认：2：理由', () => {
  const r = parseReply('2：不想动源码', approvalChoices());
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['rejected']);
  assert.equal(r.note, '不想动源码');
});

/* ------------------------------------------------------------ 严谨性 */

test('★ 全角数字要认（手机输入法常见）', () => {
  const r = parseReply('１', approvalChoices());
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['allowed-once']);
});

test('★ 非数字内容不猜（回"同意"不该在编号制下生效）', () => {
  const r = parseReply('同意', approvalChoices());
  assert.equal(r.ok, false);
});

test('空消息拒绝', () => {
  assert.equal(parseReply('', approvalChoices()).ok, false);
  assert.equal(parseReply('   ', approvalChoices()).ok, false);
});

test('没有选项时拒绝', () => {
  assert.equal(parseReply('1', { choices: [] }).ok, false);
});

test('重复编号去重', () => {
  const q = {
    questions: [{ id: 'm', question: 'q', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
  };
  const r = parseReply('1,1', questionChoices(q));
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['1']);
});

/* ------------------------------------------------------------ 渲染 */

test('渲染结果包含编号和"引用回复"提示', () => {
  const text = renderPrompt({
    id: '7',
    spec: approvalChoices(),
  });
  assert.match(text, /#7/);
  assert.match(text, /1\. 允许一次/);
  assert.match(text, /2\. 拒绝/);
  assert.match(text, /引用这条消息/);
});

test('★ 渲染的选项数量与实际选项表一致', () => {
  // 这条守的是"用户看到的"和"后端认的"必须同一张表。
  // 对不上就会出现"界面上有 3，回了 3 却说没有"。
  const spec = questionChoices(multiQ);
  const text = renderPrompt({ id: '1', spec });
  assert.equal(spec.choices.length, 3);
  for (let i = 1; i <= 3; i++) {
    assert.ok(text.includes(`${i}.`), `渲染里缺少编号 ${i}`);
  }
  assert.equal(text.includes('4.'), false, '不能渲染出不存在的编号');
});

test('多选题在渲染里提示可多选', () => {
  const q = {
    questions: [{ id: 'm', question: '选几个', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
  };
  const text = renderPrompt({ id: '1', spec: questionChoices(q) });
  assert.match(text, /可多选/);
});

/* -------------------------------------------------------------- 推荐标记 */

test('★ 推荐来自 label 后缀，与 DSH 规则一致', () => {
  // DSH 界面就是这么判断的：label 末尾的 (推荐)/(recommended)
  assert.equal(splitRecommended('只改 README (推荐)').recommended, true);
  assert.equal(splitRecommended('只改 README（推荐）').recommended, true);
  assert.equal(splitRecommended('Only README (recommended)').recommended, true);
  assert.equal(splitRecommended('只改 README').recommended, false);
});

test('拆出来的显示文案不带后缀', () => {
  assert.equal(splitRecommended('只改 README (推荐)').display, '只改 README');
  assert.equal(splitRecommended('只改 README（推荐）').display, '只改 README');
});

test('★ 渲染时标出推荐，且不重复后缀', () => {
  const q = {
    questions: [
      {
        id: 'q',
        question: '怎么改',
        options: [
          { label: '只改 README (推荐)', description: '最小改动' },
          { label: '改源码' },
        ],
      },
    ],
  };
  const spec = questionChoices(q);
  const text = renderPrompt({ id: '1', spec });
  assert.match(text, /只改 README（推荐）/, '要标出推荐');
  assert.equal(
    text.includes('(推荐)（推荐）'),
    false,
    '不能把原后缀和标记叠在一起',
  );
  assert.equal(text.includes('(推荐)'), false, '显示时要去掉原始后缀');
});

test('★ 回传给 DSH 的 label 必须是原始文案（含后缀）', () => {
  // DSH 的答案要和它发出的选项逐字相符，去掉后缀会对不上
  const q = {
    questions: [{ id: 'q', question: 'q', options: [{ label: '只改 README (推荐)' }, { label: '改源码' }] }],
  };
  const spec = questionChoices(q);
  assert.equal(spec.choices[0].label, '只改 README (推荐)', 'key 对应的 label 要原样保留');
  assert.equal(spec.choices[0].recommended, true, '同时要标出推荐，供显示用');
});

test('选择推荐项也能正常解析', () => {
  const q = {
    questions: [{ id: 'q', question: 'q', options: [{ label: 'A (推荐)' }, { label: 'B' }] }],
  };
  const spec = questionChoices(q);
  const r = parseReply('1', spec);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, ['1']);
});

test('没有推荐标记时一切照旧', () => {
  const spec = questionChoices(multiQ);
  assert.equal(spec.choices.every((c) => c.recommended === false), true);
  assert.equal(spec.choices[0].label, '只改 README');
});

/* ------------------------------------------------------ 审批的推荐 */

test('★ 只读工具推荐"允许一次"', () => {
  for (const name of ['fs_read', 'fs_list', 'grep', 'glob', 'search', 'ping']) {
    const s = approvalChoices(name);
    const rec = s.choices.find((c) => c.recommended);
    assert.equal(rec.key, 'allowed-once', `${name} 应推荐允许`);
  }
});

test('★ 写/执行类工具推荐"拒绝"', () => {
  for (const name of ['fs_write', 'shell', 'bash', 'delete_file', 'install_pkg']) {
    const s = approvalChoices(name);
    const rec = s.choices.find((c) => c.recommended);
    assert.equal(rec.key, 'rejected', `${name} 应推荐拒绝`);
  }
});

test('★ 混合命名按危险处理（read_and_delete 不能算只读）', () => {
  // 同时命中"只读"和"危险"两边时，必须先判危险。
  // 判错的代价不对称：该拒却推荐允许，可能执行不可逆操作。
  assert.equal(looksRisky('read_and_delete'), true);
  assert.equal(looksRisky('read_write'), true);
  assert.equal(looksRisky('get_and_remove'), true);
});

test('★ 认不出的工具名推荐拒绝（fail-safe）', () => {
  assert.equal(looksRisky('something_weird'), true);
  assert.equal(looksRisky(''), true, '空工具名按危险处理');
  const s = approvalChoices('');
  assert.equal(s.choices.find((c) => c.recommended).key, 'rejected');
});

test('★ 审批推荐恰好一项（不能两项都推荐，也不能都不推荐）', () => {
  for (const name of ['fs_read', 'fs_write']) {
    const s = approvalChoices(name);
    assert.equal(s.choices.filter((c) => c.recommended).length, 1);
  }
});

test('★ 推荐只是标记，不影响两个选项的 key', () => {
  // 推荐是给人看的提示，不能改变授权语义
  const s = approvalChoices('fs_write');
  assert.deepEqual(
    s.choices.map((c) => c.key),
    ['allowed-once', 'rejected'],
  );
});

test('审批渲染里带上（推荐）', () => {
  const spec = approvalChoices('fs_write');
  const text = renderPrompt({ id: '1', spec });
  assert.match(text, /拒绝（推荐）/);
  assert.match(text, /1\. 允许一次/);
  assert.match(text, /2\. 拒绝/);
});

/* ------------------------------------------- 引用字段名（踩过的坑） */

test('★ 必须从 evt.replyTo.messageId 读引用（不是 replyToMessageId）', async () => {
  // 这是真踩过的坑：normalizeEvent 产出的是 `replyTo = { messageId }`，
  // 而我写了 `evt.replyToMessageId`。字段不存在，读到空串，
  // 于是"引用后回数字"永远走不到解析分支——用户回了三次都没反应。
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../plugins/dsh-bridge/index.mjs', import.meta.url),
    'utf8',
  );
  const i = src.indexOf('const quotedId');
  assert.ok(i > 0, '找不到引用读取');
  const block = src.slice(i, i + 200);
  assert.match(block, /replyTo\?\.messageId/, '要读 replyTo.messageId');
});

test('★ events.mjs 产出的字段名与插件读取的一致', async () => {
  const read = (await import('node:fs/promises')).readFile;
  const evt = await read(new URL('../src/onebot/events.mjs', import.meta.url), 'utf8');
  assert.match(evt, /replyTo,/, 'normalizeEvent 要返回 replyTo');
  assert.match(evt, /replyTo = \{ messageId:/, '形状是 { messageId }');

  const plugin = await read(new URL('../plugins/dsh-bridge/index.mjs', import.meta.url), 'utf8');
  assert.match(plugin, /replyTo\?\.messageId/, '插件要按同样的形状读');
});

/* ------------------------------------ handleMessage 的作用域（踩过的坑） */

test('★ 消息接管路径里不能引用未定义的 log', async () => {
  // 真踩过的坑：在消息处理里写了 `log?.()`，但那个函数的作用域
  // 里没有 log（它只是 startBridge 的参数）。运行时抛 "log is not defined"，
  // 而上层把异常吞掉、消息转给 AI —— 表现是"回复了但没反应"。
  //
  // v1 契约下 `export async function handleMessage` 只是兼容垫片，
  // 真正的实现是 onMessage()。所以断言要落在**实际处理消息的那个函数**上。
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../plugins/dsh-bridge/index.mjs', import.meta.url),
    'utf8',
  );

  // 1) 垫片必须委托给 onMessage，而不是自己另写一套
  const shimStart = src.indexOf('export async function handleMessage');
  assert.ok(shimStart > 0, '兼容垫片应当存在');
  const shimBody = src.slice(shimStart, src.indexOf('\n}', shimStart));
  assert.match(shimBody, /onMessage\(/, '垫片要委托给 onMessage');

  // 2) onMessage 里必须先接住 log 才能用
  const i = src.indexOf('async function onMessage');
  assert.ok(i > 0, 'onMessage 应当存在');
  const end = src.indexOf('\n}', src.indexOf('return false;', i));
  const body = src.slice(i, end > i ? end : i + 6000);
  assert.match(body, /const log = rt\.log/, '要从 rt 取 log，而不是依赖外层参数');

  // 3) 垫片本身不能出现裸的 log 调用（它拿不到 rt 之外的 log）
  assert.ok(!/\blog\?\.\(/.test(shimBody), '垫片里不能直接用 log');
});

test('★ 插件异常要带上位置信息（便于排查）', async () => {
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/index.mjs', import.meta.url),
    'utf8',
  );
  const i = src.indexOf('插件处理消息异常');
  const block = src.slice(Math.max(0, i - 500), i + 300);
  assert.match(block, /stack/, '要记录堆栈位置');
});
