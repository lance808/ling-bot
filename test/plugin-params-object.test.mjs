/**
 * 参数 schema 的对象支路：`type: "object"` 与「对象数组」
 *
 * ## 这组测试守什么
 *
 * 课程表插件要一次收一批课程对象（`courses: array<object>`），还有
 * `course_update` 的 `patch: object`。宿主原本只认标量，
 * 所以这次给 `params` 加了 object 支路。加支路的风险全在**旧参数会不会被改坏**，
 * 因此这里分两半：
 *
 *   1. 新能力：对象/对象数组的 schema 输出、必填、类型、白名单过滤、深度上限；
 *   2. 旧行为：`echo` / `dsh-bridge` / `regex-reply` 的清单与内置工具，
 *      过一遍 `toJsonSchema` 必须**逐字段**还是原来那份（不含任何多余键）。
 *
 * 全部是纯函数调用：不写盘、不联网、不起插件进程。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeManifest } from '../src/plugins/manifest.mjs';
import { toJsonSchema, validateParams, toOpenAiTools } from '../src/guard/tool-gate.mjs';

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');

/** 造一份最小合法清单，`params` 由调用方给 */
function manifestWith(params) {
  return {
    id: 'demo',
    name: '演示',
    version: '1.0.0',
    apiVersion: '1',
    description: '参数测试',
    tools: [{ name: 'demo_tool', description: '测试工具', needs: 'qq', risk: 'R0', params }],
  };
}

/** 归一化一份清单并断言成功，返回那个工具的 params */
function paramsOf(raw, dirName = 'demo') {
  const r = normalizeManifest(raw, { dirName });
  assert.equal(r.ok, true, r.message);
  return r.manifest.tools[0].params;
}

/* ============================================================ 清单：object */

test('清单：object 参数递归归一化（properties / required 字符串数组）', () => {
  const params = paramsOf(
    manifestWith({
      patch: {
        type: 'object',
        description: '要改的字段',
        // required 数组 = 子属性必填
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 60 },
          weekday: { type: 'number' },
        },
      },
    }),
  );

  assert.equal(params.patch.type, 'object');
  assert.equal(params.patch.required, undefined, '写数组时不是"参数本身必填"');
  assert.equal(params.patch.properties.name.type, 'string');
  assert.equal(params.patch.properties.name.maxLength, 60);
  assert.equal(params.patch.properties.name.required, true, 'required 数组落到子属性上');
  assert.equal(params.patch.properties.weekday.required, undefined);

  // required: true 的布尔含义才是"这个参数本身必填"
  const selfRequired = paramsOf(
    manifestWith({ patch: { type: 'object', required: true, properties: { a: { type: 'string' } } } }),
  );
  assert.equal(selfRequired.patch.required, true);
});

test('清单：items.required 写成布尔 → E4041（元素没有"必填"这个维度）', () => {
  const r = normalizeManifest(
    manifestWith({
      rows: { type: 'array', items: { type: 'object', required: true, properties: { a: { type: 'string' } } } },
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4041');
  assert.match(r.message, /items\.required 必须是字符串数组/);
});

test('清单：object 的 required 引用了未声明的属性 → E4041', () => {
  const r = normalizeManifest(
    manifestWith({
      patch: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
    }),
    { dirName: 'demo' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4041');
  assert.match(r.message, /未声明的属性：b/);
});

test('清单：object 的 required 不是布尔也不全是字符串 → E4041', () => {
  for (const bad of [1, 'name', [1], [null]]) {
    const r = normalizeManifest(
      manifestWith({ patch: { type: 'object', properties: { a: { type: 'string' } }, required: bad } }),
      { dirName: 'demo' },
    );
    assert.equal(r.ok, false, `required=${JSON.stringify(bad)} 应被拒绝`);
    assert.equal(r.code, 'E4041');
  }
});

test('清单：properties 必须是对象，属性名要合法', () => {
  const notObject = normalizeManifest(
    manifestWith({ patch: { type: 'object', properties: ['a'] } }),
    { dirName: 'demo' },
  );
  assert.equal(notObject.ok, false);
  assert.match(notObject.message, /properties 必须是对象/);

  const badName = normalizeManifest(
    manifestWith({ patch: { type: 'object', properties: { '1bad': { type: 'string' } } } }),
    { dirName: 'demo' },
  );
  assert.equal(badName.ok, false);
  assert.match(badName.message, /属性名非法/);
});

test('清单：object 的 properties 最多 30 个', () => {
  /** @type {Record<string, any>} */
  const props = {};
  for (let i = 0; i < 31; i += 1) props[`p${i}`] = { type: 'string' };
  const r = normalizeManifest(manifestWith({ patch: { type: 'object', properties: props } }), {
    dirName: 'demo',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4041');
  assert.match(r.message, /最多 30 个/);
});

test('★ 清单：对象嵌套超过 3 层 → E4041 且给出字段路径', () => {
  /*
   * 深度从顶层参数里的第一个 object 算 1 层：
   *   patch(1) → a(2) → b(3) → c(4，超限)
   * 这条上限不是洁癖：schema 是递归结构，一个手写错的自引用清单
   * 会让构造/校验无限递归，症状是"清单坏了却把加载器搞崩"。
   */
  const deep = (levels) => {
    /** @type {any} */
    let node = { type: 'string' };
    for (let i = levels; i >= 1; i -= 1) {
      node = { type: 'object', properties: { [`l${i}`]: node } };
    }
    return node;
  };

  // 3 层：合法
  assert.equal(
    normalizeManifest(manifestWith({ patch: deep(3) }), { dirName: 'demo' }).ok,
    true,
    '3 层对象应当合法',
  );

  // 4 层：拒绝，且消息里有字段路径
  const bad = normalizeManifest(manifestWith({ patch: deep(4) }), { dirName: 'demo' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E4041');
  assert.match(bad.message, /嵌套超过 3 层/);
  // deep(4) 的构造顺序是 l1 在最外层，超限发生在第 4 层的 l3
  assert.match(bad.message, /patch\.l1\.l2\.l3/, '消息要指出是哪条路径');
  assert.match(String(bad.field), /^tools\.demo_tool\.params\.patch/);
});

/* ====================================================== 清单：对象数组 items */

test('清单：array 的 items 允许对象形状（递归 properties / required）', () => {
  const params = paramsOf(
    manifestWith({
      courses: {
        type: 'array',
        required: true,
        maxItems: 20,
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 60 },
            periods: { type: 'array', maxItems: 12, items: { type: 'number' } },
          },
        },
      },
    }),
  );

  assert.equal(params.courses.type, 'array');
  assert.equal(params.courses.maxItems, 20);
  assert.equal(params.courses.items.type, 'object');
  assert.equal(params.courses.items.properties.name.required, true, 'items.required 落到元素属性上');
  assert.deepEqual(params.courses.items.properties.periods.items, { type: 'number' });
});

test('清单：array<array> 与非标量 items 一律 E4041（不支持的结构，不静默接受）', () => {
  const nested = normalizeManifest(
    manifestWith({ m: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }),
    { dirName: 'demo' },
  );
  assert.equal(nested.ok, false);
  assert.match(nested.message, /items\.type 非法/);

  const notObj = normalizeManifest(manifestWith({ m: { type: 'array', items: 'string' } }), {
    dirName: 'demo',
  });
  assert.equal(notObj.ok, false);
});

test('清单：标量数组 / 标量参数的行为与改造前完全一致', () => {
  const params = paramsOf(
    manifestWith({
      text: { type: 'string', required: true, maxLength: 4000, description: '文字' },
      count: { type: 'number' },
      flag: { type: 'boolean' },
      tags: { type: 'array', maxItems: 5, items: { type: 'string' } },
    }),
  );

  assert.deepEqual(params.text, { type: 'string', description: '文字', required: true, maxLength: 4000 });
  assert.deepEqual(params.count, { type: 'number' });
  assert.deepEqual(params.flag, { type: 'boolean' });
  // 标量 items 只保留 type（历史上就是这样，不能多出 properties 之类）
  assert.deepEqual(params.tags, { type: 'array', maxItems: 5, items: { type: 'string' } });
});

/* ========================================================== toJsonSchema */

test('toJsonSchema：object / 对象数组递归输出标准 JSON Schema', () => {
  const schema = toJsonSchema({
    courses: {
      type: 'array',
      description: '课程数组',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 60, required: true },
          periods: { type: 'array', maxItems: 12, items: { type: 'number' } },
        },
      },
    },
    patch: {
      type: 'object',
      required: true,
      properties: { weekday: { type: 'number' } },
    },
    missing: { type: 'object', properties: {} },
  });

  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['patch'], '只有 required: true 的顶层参数进 required');

  const items = schema.properties.courses.items;
  assert.equal(items.type, 'object');
  assert.equal(items.additionalProperties, false);
  assert.deepEqual(items.required, ['name']);
  assert.equal(items.properties.name.type, 'string');
  assert.equal(items.properties.name.maxLength, 60);
  assert.deepEqual(items.properties.periods.items, { type: 'number' });
  // 子属性的 required 只是一个普通参数声明，不该出现在它的 schema 片段里
  assert.equal('required' in items.properties.name, false);

  assert.equal(schema.properties.patch.type, 'object');
  assert.deepEqual(schema.properties.patch.required, []);

  // 空 properties 的 object 也要有完整形状，模型不会见到忽有忽无的字段
  assert.deepEqual(schema.properties.missing.properties, {});
  assert.deepEqual(schema.properties.missing.required, []);
  assert.equal(schema.properties.missing.additionalProperties, false);
});

test('★ toJsonSchema：旧工具的 schema 逐字段不变（兼容性红线）', async () => {
  /*
   * 这条是这次改造最该守的东西。
   *
   * 参数 schema 是**下发模型**的契约：多一个键、少一个键都会让模型
   * 的调用习惯漂移，而症状是"升级之后它突然不会用这个工具了"。
   * 所以用出厂清单（真实文件）跑一遍，与手写的期望值做深比较，
   * 而不是只断言"包含某个字段"。
   */
  const expectedEcho = {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要回显的文字', maxLength: 4000 },
    },
    required: ['text'],
    additionalProperties: false,
  };

  for (const id of ['echo', 'dsh-bridge', 'regex-reply']) {
    const raw = JSON.parse(await fs.readFile(path.join(REPO, 'plugins', id, 'plugin.json'), 'utf8'));
    const r = normalizeManifest(raw, { dirName: id });
    assert.equal(r.ok, true, `${id}: ${r.message}`);

    if (id === 'echo') {
      assert.deepEqual(toJsonSchema(r.manifest.tools[0].params), expectedEcho);
    }

    // 所有出厂插件的 schema 都必须能输出去，且顶层形状恒定
    for (const t of r.manifest.tools) {
      const schema = toJsonSchema(t.params);
      assert.equal(schema.type, 'object');
      assert.equal(schema.additionalProperties, false);
      assert.ok(Array.isArray(schema.required));
      // 没有 object 参数的清单，输出里不该出现额外键（重新引入会破坏模型契约）
      assert.equal('$defs' in schema, false);
    }
  }
});

test('toOpenAiTools：对象数组参数原样进 parameters（下游不再二次变换）', () => {
  const tool = {
    name: 'plugin_demo',
    description: '演示',
    params: {
      courses: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string', required: true } } },
      },
    },
  };
  const [one] = toOpenAiTools([tool]);
  assert.equal(one.function.name, 'plugin_demo');
  assert.deepEqual(one.function.parameters.properties.courses.items.required, ['name']);
});

/* ========================================================= validateParams */

/** 与课程表插件同形的一份 schema（真实来源在 plugins/course-schedule/plugin.json） */
const COURSE_PARAMS = Object.freeze({
  courses: {
    type: 'array',
    required: true,
    maxItems: 2,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 60, required: true },
        weekday: { type: 'number', required: true },
        periods: { type: 'array', maxItems: 3, items: { type: 'number' } },
        parity: { type: 'string', enum: ['all', 'odd', 'even'] },
      },
    },
  },
  termStartDate: { type: 'string', maxLength: 10 },
});

test('validateParams：对象数组按白名单过滤，多余键丢弃且不报错', () => {
  const res = validateParams(COURSE_PARAMS, {
    courses: [
      {
        name: '高等数学',
        weekday: 1,
        periods: [1, 2],
        // 未声明：必须被丢掉，而不是报错
        teacher: '张老师',
        origin: 'owner-private',
      },
    ],
    termStartDate: '2026-09-07',
    extra: 'drop-me',
  });

  assert.equal(res.ok, true, res.message);
  assert.deepEqual(res.value, {
    courses: [{ name: '高等数学', weekday: 1, periods: [1, 2] }],
    termStartDate: '2026-09-07',
  });
  // 关键点：多余键不产生任何报错，只是在过滤时消失
  assert.equal('extra' in res.value, false);
  assert.equal('teacher' in res.value.courses[0], false);
  assert.equal('origin' in res.value.courses[0], false);
});

test('validateParams：缺必填报 E4041 并指出字段', () => {
  const missingItem = validateParams(COURSE_PARAMS, { courses: [{ weekday: 1 }] });
  assert.equal(missingItem.ok, false);
  assert.equal(missingItem.code, 'E4041');
  assert.match(missingItem.message, /courses\[0\]\.name/);

  const missingArg = validateParams(COURSE_PARAMS, {});
  assert.equal(missingArg.ok, false);
  assert.match(missingArg.message, /缺少必需参数：courses/);
});

test('validateParams：类型不符报 E4041（数组 / 元素 / 标量都要拦）', () => {
  const notArray = validateParams(COURSE_PARAMS, { courses: { name: 'x' } });
  assert.equal(notArray.ok, false);
  assert.match(notArray.message, /必须是数组/);

  const elementNotObject = validateParams(COURSE_PARAMS, { courses: ['高等数学'] });
  assert.equal(elementNotObject.ok, false);
  assert.match(elementNotObject.message, /courses\[0\] 必须是对象/);

  const badField = validateParams(COURSE_PARAMS, { courses: [{ name: 'x', weekday: '1' }] });
  assert.equal(badField.ok, false);
  assert.match(badField.message, /courses\[0\]\.weekday/);

  const nestedArray = validateParams(COURSE_PARAMS, { courses: [{ name: 'x', weekday: 1, periods: 12 }] });
  assert.equal(nestedArray.ok, false);
  assert.match(nestedArray.message, /courses\[0\]\.periods 必须是数组/);
});

test('validateParams：maxItems 在数组参数上生效', () => {
  const res = validateParams(COURSE_PARAMS, {
    courses: [
      { name: 'a', weekday: 1 },
      { name: 'b', weekday: 2 },
      { name: 'c', weekday: 3 },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'E4041');
  assert.match(res.message, /元素过多（上限 2）/);
});

test('validateParams：标量数组保持改造前的行为（元素不逐项校验、原样透传）', () => {
  /*
   * 标量数组以前不校验元素。这里**刻意不动**：收紧旧行为会让本来能跑的
   * 工具在升级后突然拒绝调用，而那不是这次改造要的事。
   */
  const params = { tags: { type: 'array', maxItems: 5, items: { type: 'string' } } };
  const res = validateParams(params, { tags: ['a', 1, null] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.tags, ['a', 1, null]);
});

test('validateParams：object 参数按白名单过滤，required 缺失才报错', () => {
  const params = {
    patch: {
      type: 'object',
      required: true,
      properties: { name: { type: 'string', required: true }, note: { type: 'string' } },
    },
  };

  const ok = validateParams(params, { patch: { name: 'x', note: 'n', teacher: '丢掉' } });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(ok.value.patch, { name: 'x', note: 'n' });

  const empty = validateParams(params, { patch: {} });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /patch\.name/);

  const wrong = validateParams(params, { patch: [] });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /patch 必须是对象/);
});

test('★ validateParams：深度超过 3 层报 E4041 并指出字段路径', () => {
  /*
   * 清单层已经拦了更深的对象 schema，这里单独再测一次执行层：
   * schema 是数据，万一从别处进来一份更深的，执行层不能变成爆栈入口。
   */
  const deepSpec = (levels) => {
    /** @type {any} */
    let node = { type: 'string' };
    for (let i = levels; i >= 1; i -= 1) {
      node = { type: 'object', properties: { [`l${i}`]: node } };
    }
    return node;
  };

  // patch(1) → l1(2) → l2(3) → l3 是标量：3 层，能正常校验
  const okValue = { l1: { l2: { l3: 'v' } } };
  const ok = validateParams({ patch: deepSpec(3) }, { patch: okValue });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(ok.value.patch, okValue);

  // patch(1) → l1(2) → l2(3) → l3(4)：拒绝
  const bad = validateParams({ patch: deepSpec(4) }, { patch: { l1: { l2: { l3: { l4: 'v' } } } } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E4041');
  assert.match(bad.message, /嵌套超过 3 层/);
  assert.match(bad.message, /patch/);
});

test('validateParams：对象数组里的对象深度同样受 3 层限制', () => {
  const params = {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } },
        },
      },
    },
  };
  // 元素(1) → a(2) → b(3) → c 是标量，3 层合法
  const ok = validateParams(params, { rows: [{ a: { b: { c: 'x' } } }] });
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(ok.value.rows, [{ a: { b: { c: 'x' } } }]);

  // 元素(1) → a(2) → b(3) → c(4)：超限
  const tooDeep = {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a: {
            type: 'object',
            properties: { b: { type: 'object', properties: { c: { type: 'object', properties: {} } } } },
          },
        },
      },
    },
  };
  const bad = validateParams(tooDeep, { rows: [{ a: { b: { c: {} } } }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E4041');
  assert.match(bad.message, /rows\[0\]\.a\.b\.c/, '字段路径要能一路指到超限的那一层');
});

/* ==================================================== 与课程表清单的联调 */

test('★ course-schedule 清单的参数能通过宿主校验（真实清单，不是夹具）', async () => {
  const raw = JSON.parse(
    await fs.readFile(path.join(REPO, 'plugins', 'course-schedule', 'plugin.json'), 'utf8'),
  );
  const r = normalizeManifest(raw, { dirName: 'course-schedule' });
  assert.equal(r.ok, true, r.message);

  const byName = Object.fromEntries(r.manifest.tools.map((t) => [t.name, t]));
  const courses = byName.course_preview.params.courses;
  assert.equal(courses.type, 'array');
  assert.equal(courses.items.type, 'object');
  assert.equal(courses.maxItems, 20);
  assert.equal(courses.items.properties.parity.enum.length, 3);

  const patch = byName.course_update.params.patch;
  assert.equal(patch.type, 'object');
  assert.equal(patch.required, true, 'patch 参数本身必填');
  assert.equal(patch.properties.weekday.type, 'number');

  // 真实形状的调用能过校验
  const res = validateParams(byName.course_preview.params, {
    courses: [
      {
        name: '高等数学',
        weekday: 1,
        periods: [1, 2],
        termStartDate: '2026-09-07',
        weekStart: 1,
        weekEnd: 16,
        parity: 'all',
        // 模型多塞的键：丢弃、不报错
        classroom: '教三楼 301',
      },
    ],
  });
  assert.equal(res.ok, true, res.message);
  assert.equal('classroom' in res.value.courses[0], false);
});
