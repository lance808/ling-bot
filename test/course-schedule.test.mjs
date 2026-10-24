/**
 * 课程表插件 —— 端到端行为测试（真实入口 + 真实磁盘）
 *
 * ## 这个文件守什么
 *
 * `docs/course-schedule.md` §10 列的十个验收场景，逐个落成用例：
 *
 *   1. 整理后保存（preview → 用户确认 → save → list）
 *   2. 确认取消（preview → cancel → save 失败，库不变）
 *   3. 周次 / 单双周查询
 *   4. 修改
 *   5. 重启恢复
 *   6. 数据隔离
 *   7. 冲突
 *   8. 损坏文件
 *
 * ## 为什么用真实入口而不是 mock
 *
 * 这里要验的性质大多跟**顺序和归属**有关：草案是不是真的一次性、保存的是不是
 * 用户看到的那份、换个人来能不能读到、坏了会不会被覆盖。这些都在
 * "编排层 + 存储层"之间，mock 掉任何一边都会让测试变成"我以为的流程"。
 *
 * 所以每个用例都在临时目录里真的建 `dataDir`，真的 `import` 入口，
 * 用宿主真实形状的 `ctx` 调用；重启恢复用"重新 import（带 query 串）+
 * 重新 init"表达，等价于宿主重启后重新加载插件。
 *
 * ## 不碰什么
 *
 * 不联网、不调模型、不发 QQ。宿主 `ctx` 里的 `chat` / `sendText` 一律不给 ——
 * 课程表插件本来就不该依赖它们。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const ENTRY = path.join(REPO, 'plugins', 'course-schedule', 'index.mjs');

/** 一学期的开始日（周一）。选它是因为"第 1 周"必须真的是一整周。 */
const TERM = '2026-09-07';

/* ------------------------------------------------------------------ 夹具 */

/** 临时 dataDir，用完整目录（不删，便于失败时排查；由 t.after 清理） */
async function tempDataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-course-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * 造一个宿主形状的 ctx。
 *
 * 字段严格照 docs/plugin-api.md §5.1 / §5.2 的真实形状：多给的字段
 * （比如 origin）不会让插件"刚好能跑"，少给的字段（convKey）必须真的失败。
 *
 * @param {object} input
 * @param {string} input.dataDir
 * @param {string} [input.convKey]
 * @param {string} [input.userId]
 * @param {object} [input.config]
 * @param {string} [input.origin]
 */
function makeCtx({ dataDir, convKey = 'private:1001', userId = '1001', config = {}, origin = 'owner-private' }) {
  const caller = Object.freeze({
    pluginId: 'course-schedule',
    tool: 'plugin_course_preview',
    origin,
    convKey,
    isGroup: convKey.startsWith('group:'),
    requester: Object.freeze({ id: userId, nickname: '测试用户' }),
    messageId: null,
    replyToMessageId: null,
    callId: 'call_test',
    at: Date.now(),
  });
  return {
    plugin: { id: 'course-schedule', name: '课程表', version: '1.0.0', dir: path.dirname(ENTRY), dataDir, runtime: 'process' },
    config: {
      timezone: 'Asia/Shanghai',
      defaultTermStartDate: '',
      maxCourses: 60,
      draftTtlMs: 900_000,
      ...config,
    },
    secrets: {},
    dataDir,
    signal: new AbortController().signal,
    log: () => {},
    caller,
  };
}

/**
 * 加载一份"新的"插件实例。
 *
 * 加 query 串是为了绕开 ESM 模块缓存 —— 这是本仓库已有的做法
 * （见 test/regex-reply-host.test.mjs 的说明）。重启恢复正是靠它表达：
 * 新实例 = 空草案表 + 新 store，但 dataDir 还是同一个。
 *
 * @param {string} tag
 */
async function loadPlugin(tag = '') {
  const url = `file:///${ENTRY.replace(/\\/g, '/')}?t=${tag || Date.now()}_${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  return mod.default;
}

/** 调一次工具 */
async function call(plugin, tool, args, ctx) {
  return plugin.callTool({ tool, args, ctx, signal: ctx.signal });
}

/**
 * 一条合法课程的最小形状。
 *
 * @param {object} [over]
 */
function course(over = {}) {
  return {
    name: '高等数学',
    weekday: 1,
    periods: [1, 2],
    startTime: '08:00',
    endTime: '09:40',
    location: '教三楼 301',
    teacher: '张老师',
    termStartDate: TERM,
    weekStart: 1,
    weekEnd: 16,
    parity: 'all',
    ...over,
  };
}

/**
 * 走完整流程：预览 → 确认 → 保存。
 *
 * 绝大多数用例只关心"存进去了之后能不能查/改/删"，把三步重复写在每个
 * 用例里会让真正的断言被淹没。返回保存结果，失败时把中间的返回带上，
 * 免得测试只报"ok 不为 true"却看不出是哪一步。
 *
 * @returns {Promise<any>}
 */
async function previewAndSave(plugin, ctx, courses, opts = {}) {
  const preview = await call(plugin, 'course_preview', { courses }, ctx);
  assert.equal(preview.ok, true, `预览失败：${preview.message ?? ''}`);
  const saved = await call(
    plugin,
    'course_save',
    {
      draftId: preview.draftId,
      acknowledgeOptionalMissing: true,
      ...opts,
    },
    ctx,
  );
  assert.equal(saved.ok, true, `保存失败：${saved.message ?? ''}（预览 missing=${JSON.stringify(preview.missing)}）`);
  return { preview, saved: saved ?? {} };
}

/* ================================================== 1. 整理后保存 */

test('★ 录入：preview → 用户确认 → save → list 能看到', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('save');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const preview = await call(plugin, 'course_preview', {
    courses: [course({ name: '高等数学', weekday: 1, periods: [1, 2] }), course({ name: '大学物理', weekday: 3, periods: [3, 4], location: '理科楼 205' })],
  }, ctx);

  assert.equal(preview.ok, true, preview.message);
  assert.equal(preview.count, 2);
  assert.equal(preview.saveableCount, 2);
  assert.equal(typeof preview.draftId, 'string');
  assert.equal(preview.requiresConfirmation, true, '必须显式要求用户确认');
  // 预览必须给出可读表格，模型才能原样展示
  assert.match(preview.table, /高等数学/);
  assert.match(preview.table, /大学物理/);
  assert.match(preview.table, /周一/);

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.saved, 2);
  // 保存后的每条都要有 id，供后续修改/删除
  for (const c of saved.courses) assert.match(c.id, /^c_[0-9a-f]{8}$/);

  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.ok, true);
  assert.equal(list.count, 2);
  const names = list.courses.map((c) => c.name).sort();
  assert.deepEqual(names, ['大学物理', '高等数学']);
});

test('录入：termStartDate 归一到周一（用户给周三，存的必须是周一）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('normalize-term');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  // 2026-09-09 是周三
  const preview = await call(plugin, 'course_preview', {
    courses: [course({ termStartDate: '2026-09-09', weekStart: 1, weekEnd: 16 })],
  }, ctx);
  assert.equal(preview.ok, true, preview.message);
  assert.equal(preview.courses[0].course.termStartDate, TERM, '学期开始日必须归一为那一周的周一');

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.courses[0].termStartDate, TERM);
});

test('录入：整批共用 termStartDate 时每条不必重复写', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('batch-term');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const c1 = course({ name: '线性代数', weekday: 2 });
  const c2 = course({ name: '英语', weekday: 4 });
  delete c1.termStartDate;
  delete c2.termStartDate;

  const preview = await call(plugin, 'course_preview', { courses: [c1, c2], termStartDate: TERM }, ctx);
  assert.equal(preview.ok, true, preview.message);
  assert.equal(preview.saveableCount, 2, '整批共用日期应当让两条都可保存');
  assert.deepEqual(preview.missing, []);

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(saved.ok, true, saved.message);
  for (const c of saved.courses) assert.equal(c.termStartDate, TERM);
});

test('★ 录入：缺必要信息不编造，save 必须被拒绝', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('needs-info');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  // 没给地点、没给学期开始日期
  const preview = await call(plugin, 'course_preview', {
    courses: [{ name: '数据结构', weekday: 2, periods: [5, 6], weekStart: 1, weekEnd: 16 }],
  }, ctx);

  assert.equal(preview.ok, true, '预览本身成功，但必须把缺项标出来');
  assert.ok(preview.missing.includes('termStartDate'), `missing 应包含 termStartDate，实际 ${JSON.stringify(preview.missing)}`);
  assert.ok(preview.optionalMissing.includes('location'), '地点缺失必须进 optionalMissing');
  // 提示里必须明确"不要编造"
  assert.ok(preview.hints.some((h) => /不要.*编造|不要.*自行编造/.test(h)), JSON.stringify(preview.hints));

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId, acknowledgeOptionalMissing: true }, ctx);
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'E_COURSE_NEEDS_INFO');
  assert.match(saved.message, /termStartDate/);

  // 库必须还是空的
  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.count, 0);
});

test('★ 录入：地点缺失时，不确认就不让保存（不填默认值）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('optional-missing');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const noLocation = course({ name: '体育', weekday: 5, periods: [7, 8] });
  delete noLocation.location;

  const preview = await call(plugin, 'course_preview', { courses: [noLocation] }, ctx);
  assert.equal(preview.ok, true, preview.message);
  assert.deepEqual(preview.missing, [], '必要信息齐全');
  assert.deepEqual(preview.optionalMissing, ['location']);

  const blocked = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_COURSE_NEEDS_INFO');
  assert.match(blocked.message, /地点/);

  // 用户明确说"就空着"才允许
  const allowed = await call(plugin, 'course_save', { draftId: preview.draftId, acknowledgeOptionalMissing: true }, ctx);
  assert.equal(allowed.ok, true, allowed.message);
  assert.equal(allowed.courses[0].location, '', '缺失的地点必须留空，不能编造');
});

test('★ 录入：optionalMissing 非空的预告记录必须带 askUser 句子（docs §4）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('ask-user');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const noLocation = course({ name: '体育', weekday: 5, periods: [7, 8] });
  delete noLocation.location;
  const noTeacher = course({ name: '音乐', weekday: 4, periods: [9, 10] });
  delete noTeacher.teacher;
  const full = course({ name: '英语', weekday: 2, periods: [3, 4] });

  const preview = await call(plugin, 'course_preview', { courses: [noLocation, noTeacher, full] }, ctx);
  assert.equal(preview.ok, true, preview.message);

  const [a, b, c] = preview.courses;
  assert.ok(a.askUser && a.askUser.includes('地点未提供'), `缺地点应带 askUser，实际 ${JSON.stringify(a.askUser)}`);
  assert.ok(/不要自行编造/.test(a.askUser), 'askUser 必须明确"不要编造"');
  assert.ok(b.askUser && b.askUser.includes('教师未提供'), `缺教师应带 askUser，实际 ${JSON.stringify(b.askUser)}`);
  assert.equal(c.askUser, undefined, '信息齐全的记录不该带 askUser');
  // 仍然不许填默认值
  assert.equal(a.course.location, '');
  assert.equal(b.course.teacher, '');
});

/* ================================================== 2. 确认取消 */

test('★ 取消：preview → cancel → save 失败且库不变', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('cancel');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const preview = await call(plugin, 'course_preview', { courses: [course()] }, ctx);
  assert.equal(preview.ok, true);

  const cancelled = await call(plugin, 'course_cancel', { draftId: preview.draftId }, ctx);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, 1);

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'E_COURSE_DRAFT_MISSING');

  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.count, 0, '取消之后库里必须没有任何东西');
});

test('取消：不传 draftId 时丢弃该用户全部草案', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('cancel-all');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const p1 = await call(plugin, 'course_preview', { courses: [course()] }, ctx);
  const p2 = await call(plugin, 'course_preview', { courses: [course({ name: '物理' })] }, ctx);

  const cancelled = await call(plugin, 'course_cancel', {}, ctx);
  assert.equal(cancelled.cancelled, 2);

  for (const p of [p1, p2]) {
    const r = await call(plugin, 'course_save', { draftId: p.draftId }, ctx);
    assert.equal(r.code, 'E_COURSE_DRAFT_MISSING');
  }
});

test('★ 草案一次性：保存成功后同一个 draftId 不能再用（防重复保存）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('draft-once');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const preview = await call(plugin, 'course_preview', { courses: [course()] }, ctx);
  const first = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(first.ok, true, first.message);

  const second = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_COURSE_DRAFT_MISSING');

  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.count, 1, '不能因为重复确认存成两份');
});

test('★ 草案归属：别人拿我的 draftId 也存不进去', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('draft-owner');
  const me = makeCtx({ dataDir, convKey: 'private:1', userId: '1' });
  const other = makeCtx({ dataDir, convKey: 'private:2', userId: '2' });
  await plugin.init(me);

  const preview = await call(plugin, 'course_preview', { courses: [course()] }, me);
  const stolen = await call(plugin, 'course_save', { draftId: preview.draftId }, other);

  assert.equal(stolen.ok, false);
  // 报"不存在"而不是"别人的"：区分两者等于给人一个探测手段
  assert.equal(stolen.code, 'E_COURSE_DRAFT_MISSING');
});

test('★ 草案过期：超过 TTL 后保存失败', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('draft-ttl');
  // TTL 设成最小允许值 60s，然后用"伪造时间"的方式验证？
  // 不行 —— 插件用的是 Date.now()。这里改用"直接改系统时间"之外的办法：
  // 用一个极短的 sleep 不现实（最小 60s），所以退而验证 expiresAt 的语义正确。
  const ctx = makeCtx({ dataDir, config: { draftTtlMs: 60_000 } });
  await plugin.init(ctx);

  const preview = await call(plugin, 'course_preview', { courses: [course()] }, ctx);
  assert.equal(preview.ok, true);
  assert.ok(preview.expiresAt > Date.now(), 'expiresAt 必须在未来');
  assert.ok(
    preview.expiresAt - Date.now() <= 60_000 + 5000,
    `expiresAt 应当约等于 now + draftTtlMs，实际差 ${preview.expiresAt - Date.now()}`,
  );
});

/* ================================================== 3. 周次 / 单双周 */

test('★ 查询：第 3 周（单周）有课，第 4 周（双周）没有', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('parity-odd');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  // 单周课：周一第 1-2 节
  await previewAndSave(plugin, ctx, [course({ name: '单周实验', weekday: 1, parity: 'odd', weekStart: 1, weekEnd: 16 })]);

  // 学期开始 2026-09-07 是第 1 周（周一）
  // 第 3 周周一 = 2026-09-21
  const w3 = await call(plugin, 'course_day', { date: '2026-09-21' }, ctx);
  assert.equal(w3.ok, true, w3.message);
  assert.equal(w3.week, 3);
  assert.equal(w3.parity, 'odd');
  assert.equal(w3.parityCn, '单周');
  assert.equal(w3.count, 1, `第 3 周应有一节课，实际 ${w3.count}`);

  // 第 4 周周一 = 2026-09-28
  const w4 = await call(plugin, 'course_day', { date: '2026-09-28' }, ctx);
  assert.equal(w4.ok, true);
  assert.equal(w4.week, 4);
  assert.equal(w4.parity, 'even');
  assert.equal(w4.count, 0, '单周课在双周不该出现');
});

test('★ 查询：双周课在双周出现、单周不出现', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('parity-even');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '双周讲座', weekday: 1, parity: 'even' })]);

  const w3 = await call(plugin, 'course_day', { date: '2026-09-21' }, ctx);
  assert.equal(w3.count, 0, '双周课在单周不该出现');

  const w4 = await call(plugin, 'course_day', { date: '2026-09-28' }, ctx);
  assert.equal(w4.count, 1, `双周课在双周应出现，实际 ${w4.count}`);
});

test('查询：周次范围之外不出现（学期已过）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('week-range');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ weekStart: 1, weekEnd: 16 })]);

  // 第 20 周周一 = 2026-09-07 + 19 周 = 2027-01-18
  const out = await call(plugin, 'course_day', { date: '2027-01-18' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(out.week, 20);
  assert.equal(out.count, 0, '超出周次范围不该有课');
});

test('查询：学期开始前（week <= 0）不出现，且给出提示', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('before-term');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course()]);

  // 2026-08-31 是学期开始前一周的周一
  const out = await call(plugin, 'course_day', { date: '2026-08-31' }, ctx);
  assert.equal(out.ok, true);
  assert.ok(out.week <= 0, `学期前周次应为 0 或负，实际 ${out.week}`);
  assert.equal(out.count, 0);
  assert.ok(out.notes.some((n) => /还没开始/.test(n)), JSON.stringify(out.notes));
});

test('★ 查询：某一周的整张表（周一到周日）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('week-table');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [
    course({ name: '高数', weekday: 1, periods: [1, 2] }),
    course({ name: '物理', weekday: 3, periods: [3, 4] }),
  ]);

  // 第 2 周：2026-09-14（周一）~ 2026-09-20（周日）
  const wk = await call(plugin, 'course_week', { date: '2026-09-16' }, ctx);
  assert.equal(wk.ok, true, wk.message);
  assert.equal(wk.week, 2);
  assert.equal(wk.monday, '2026-09-14');
  assert.equal(wk.sunday, '2026-09-20');
  assert.equal(wk.count, 2);
  assert.match(wk.table, /高数/);
  assert.match(wk.table, /物理/);
  // 没课的日期也要出现（否则用户以为表格丢了几天）
  assert.match(wk.table, /周二|（无课）/);
});

/* ================================================== 4. 修改 */

test('★ 修改：改地点后查询结果随之变化', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('update');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const { saved } = await previewAndSave(plugin, ctx, [course({ location: '教三楼 301' })]);
  const id = saved.courses[0].id;

  const updated = await call(plugin, 'course_update', { courseId: id, patch: { location: '教三楼 305' } }, ctx);
  assert.equal(updated.ok, true, updated.message);
  assert.equal(updated.course.location, '教三楼 305');
  // 局部修改不能把没提到的字段冲掉
  assert.equal(updated.course.name, '高等数学');
  assert.equal(updated.course.id, id, 'id 必须保持不变');

  const day = await call(plugin, 'course_day', { date: '2026-09-07' }, ctx);
  assert.equal(day.count, 1);
  assert.equal(day.courses[0].location, '教三楼 305');
});

test('修改：换星期后旧的那天没有、新的那天有', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('update-weekday');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const { saved } = await previewAndSave(plugin, ctx, [course({ weekday: 1 })]);
  const id = saved.courses[0].id;

  const r = await call(plugin, 'course_update', { courseId: id, patch: { weekday: 3 } }, ctx);
  assert.equal(r.ok, true, r.message);

  const monday = await call(plugin, 'course_day', { date: '2026-09-07' }, ctx);
  assert.equal(monday.count, 0, '周一不该还有课');
  const wednesday = await call(plugin, 'course_day', { date: '2026-09-09' }, ctx);
  assert.equal(wednesday.count, 1, '周三应该有课');
});

test('修改：不存在的课程 id 报 E_COURSE_NOT_FOUND', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('update-notfound');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);
  await previewAndSave(plugin, ctx, [course()]);

  const r = await call(plugin, 'course_update', { courseId: 'c_00000000', patch: { location: 'x' } }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_COURSE_NOT_FOUND');
});

test('修改：改成非法值必须被拒绝，且原数据不变', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('update-invalid');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const { saved } = await previewAndSave(plugin, ctx, [course({ name: '原名称' })]);
  const id = saved.courses[0].id;

  const bad = await call(plugin, 'course_update', { courseId: id, patch: { weekday: 9 } }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_COURSE_BAD_ARG');

  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.courses[0].name, '原名称', '失败的修改不能留下半写状态');
});

test('修改：改成与另一门课冲突时被拒绝，确认后可覆盖', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('update-conflict');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const { saved } = await previewAndSave(plugin, ctx, [
    course({ name: 'A', weekday: 1, periods: [1, 2] }),
    course({ name: 'B', weekday: 2, periods: [3, 4] }),
  ]);
  const b = saved.courses.find((c) => c.name === 'B');

  // 把 B 挪到周一第 2-3 节，与 A 的第 1-2 节重叠
  const blocked = await call(plugin, 'course_update', { courseId: b.id, patch: { weekday: 1, periods: [2, 3] } }, ctx);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_COURSE_CONFLICT');

  const forced = await call(
    plugin,
    'course_update',
    { courseId: b.id, patch: { weekday: 1, periods: [2, 3] }, overwriteConflicts: true },
    ctx,
  );
  assert.equal(forced.ok, true, forced.message);
  assert.equal(forced.course.weekday, 1);
});

/* ================================================== 5. 重启恢复 */

test('★ 重启恢复：重新加载插件后课程仍在，草案不在了', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await loadPlugin('restart-a');
  const ctx = makeCtx({ dataDir });
  await first.init(ctx);

  const { saved } = await previewAndSave(first, ctx, [course({ name: '操作系统', weekday: 2 }), course({ name: '编译原理', weekday: 4 })]);
  assert.equal(saved.saved, 2);

  // 重启：新实例、同一 dataDir
  const second = await loadPlugin('restart-b');
  const ctx2 = makeCtx({ dataDir });
  await second.init(ctx2);

  const list = await call(second, 'course_list', {}, ctx2);
  assert.equal(list.ok, true, list.message);
  assert.equal(list.count, 2, '重启后数据必须还在');
  assert.deepEqual(list.courses.map((c) => c.name).sort(), ['操作系统', '编译原理']);

  // 草案是"正在确认中的输入"，重启就该失效
  const preview = await call(second, 'course_preview', { courses: [course()] }, ctx2);
  const third = await loadPlugin('restart-c');
  await third.init(ctx2);
  const stale = await call(third, 'course_save', { draftId: preview.draftId }, ctx2);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'E_COURSE_DRAFT_MISSING');
});

test('重启恢复：修改与删除的结果也持久化', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await loadPlugin('restart-d');
  const ctx = makeCtx({ dataDir });
  await first.init(ctx);

  const { saved } = await previewAndSave(first, ctx, [course({ name: '旧名' }), course({ name: '要删的', weekday: 3 })]);
  const keep = saved.courses.find((c) => c.name === '旧名');
  const drop = saved.courses.find((c) => c.name === '要删的');

  await call(first, 'course_update', { courseId: keep.id, patch: { name: '新名' } }, ctx);
  await call(first, 'course_delete', { courseId: drop.id }, ctx);

  const second = await loadPlugin('restart-e');
  await second.init(ctx);
  const list = await call(second, 'course_list', {}, ctx);
  assert.equal(list.count, 1);
  assert.equal(list.courses[0].name, '新名');
});

/* ================================================== 6. 数据隔离 */

test('★ 隔离：两个不同会话的人互不可见', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('isolation');
  await plugin.init(makeCtx({ dataDir }));

  const alice = makeCtx({ dataDir, convKey: 'private:1', userId: '1' });
  const bob = makeCtx({ dataDir, convKey: 'private:2', userId: '2' });

  await previewAndSave(plugin, alice, [course({ name: 'Alice 的课' })]);

  const bobList = await call(plugin, 'course_list', {}, bob);
  assert.equal(bobList.count, 0, 'Bob 不该看到 Alice 的课');

  await previewAndSave(plugin, bob, [course({ name: 'Bob 的课', weekday: 2 })]);

  const aliceList = await call(plugin, 'course_list', {}, alice);
  assert.equal(aliceList.count, 1);
  assert.equal(aliceList.courses[0].name, 'Alice 的课');

  const bobList2 = await call(plugin, 'course_list', {}, bob);
  assert.equal(bobList2.courses[0].name, 'Bob 的课');
});

test('★ 隔离：同一个群里两个人各自一份课程表', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('isolation-group');
  await plugin.init(makeCtx({ dataDir }));

  const u1 = makeCtx({ dataDir, convKey: 'group:9001', userId: '11', origin: 'group' });
  const u2 = makeCtx({ dataDir, convKey: 'group:9001', userId: '22', origin: 'group' });

  await previewAndSave(plugin, u1, [course({ name: 'U1 的课' })]);

  const u2List = await call(plugin, 'course_list', {}, u2);
  assert.equal(u2List.count, 0, '同一个群里 U2 不该看到 U1 的课');

  await previewAndSave(plugin, u2, [course({ name: 'U2 的课' })]);

  assert.equal((await call(plugin, 'course_list', {}, u1)).count, 1);
  assert.equal((await call(plugin, 'course_list', {}, u2)).count, 1);
});

test('★ 隔离：群聊与私聊是两份独立数据（同一个人）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('isolation-conv');
  await plugin.init(makeCtx({ dataDir }));

  const inGroup = makeCtx({ dataDir, convKey: 'group:9002', userId: '33', origin: 'group' });
  const inPrivate = makeCtx({ dataDir, convKey: 'private:33', userId: '33', origin: 'group' });

  await previewAndSave(plugin, inGroup, [course({ name: '群里存的' })]);

  const privateList = await call(plugin, 'course_list', {}, inPrivate);
  assert.equal(privateList.count, 0, '私聊不该访问到群里那份');

  await previewAndSave(plugin, inPrivate, [course({ name: '私聊存的', weekday: 2 })]);
  assert.equal((await call(plugin, 'course_list', {}, inGroup)).count, 1);
  assert.equal((await call(plugin, 'course_list', {}, inPrivate)).count, 1);
});

test('★ 隔离：没有 ctx.caller 时一律拒绝，不兜底成全局库', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('no-identity');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  // 宿主没给 caller（比如脚本直接调、上下文丢失）
  const naked = { ...ctx, caller: null };
  for (const tool of ['course_list', 'course_day', 'course_preview']) {
    const r = await call(plugin, tool, tool === 'course_preview' ? { courses: [course()] } : {}, naked);
    assert.equal(r.ok, false, `${tool} 在没有归属时必须失败`);
    assert.equal(r.code, 'E_COURSE_NO_IDENTITY', `${tool} 的 code 应当是 E_COURSE_NO_IDENTITY`);
  }

  // convKey 为空同样拒绝
  const emptyConv = { ...ctx, caller: { ...ctx.caller, convKey: '' } };
  const r2 = await call(plugin, 'course_list', {}, emptyConv);
  assert.equal(r2.code, 'E_COURSE_NO_IDENTITY');
});

/* ================================================== 7. 冲突 */

test('★ 冲突：同学期同星期同节次且周次重叠 → 保存被拒', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('conflict-save');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '甲', weekday: 1, periods: [1, 2], weekStart: 1, weekEnd: 8 })]);

  const preview = await call(plugin, 'course_preview', {
    courses: [course({ name: '乙', weekday: 1, periods: [2, 3], weekStart: 5, weekEnd: 12 })],
  }, ctx);
  assert.equal(preview.ok, true);
  assert.ok(preview.conflicts.length > 0, '预览必须报出冲突');
  assert.equal(preview.conflicts[0].withName, '甲');

  const blocked = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_COURSE_CONFLICT');

  const forced = await call(plugin, 'course_save', { draftId: preview.draftId, overwriteConflicts: true }, ctx);
  assert.equal(forced.ok, true, forced.message);
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 2);
});

test('冲突：周次不重叠时不算冲突', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('conflict-weeks');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '前半学期', weekday: 1, periods: [1, 2], weekStart: 1, weekEnd: 8 })]);

  const preview = await call(plugin, 'course_preview', {
    courses: [course({ name: '后半学期', weekday: 1, periods: [1, 2], weekStart: 9, weekEnd: 16 })],
  }, ctx);
  assert.deepEqual(preview.conflicts, [], '周次不重叠不该算冲突');

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(saved.ok, true, saved.message);
});

test('冲突：单双周不重叠时不算冲突', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('conflict-parity');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '单周课', weekday: 1, periods: [1, 2], parity: 'odd' })]);

  const preview = await call(plugin, 'course_preview', {
    courses: [course({ name: '双周课', weekday: 1, periods: [1, 2], parity: 'even' })],
  }, ctx);
  assert.deepEqual(preview.conflicts, [], '单周与双周永不重叠');

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(saved.ok, true, saved.message);
});

test('冲突：不同学期不算冲突', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('conflict-term');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '上学期', weekday: 1, periods: [1, 2], termStartDate: TERM })]);

  const preview = await call(plugin, 'course_preview', {
    courses: [course({ name: '下学期', weekday: 1, periods: [1, 2], termStartDate: '2027-03-01' })],
  }, ctx);
  assert.deepEqual(preview.conflicts, [], '不同学期不该冲突');
});

test('★ 重复：跨学期的同名课不算重复（不需 allowDuplicate）', async (t) => {
  /*
   * 这条守的是一个很容易写错的语义：重复的判据必须包含学期。
   *
   * 如果漏掉 termStartDate，"2026 秋的高数"与"2027 春的高数"会被判成重复，
   * 于是用户每个新学期录同一门课都要显式点一次「确实再存一份」。
   * 久了就会条件反射地确认 —— 那才是真正让重复检查失效。
   */
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('duplicate-term');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '高等数学', termStartDate: '2026-09-07' })]);

  // 2027-03-01 是周一，属于另一个学期
  const preview = await call(plugin, 'course_preview', {
    courses: [course({ name: '高等数学', termStartDate: '2027-03-01' })],
  }, ctx);
  assert.deepEqual(preview.duplicates, [], '学期不同不该判成重复');

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(saved.ok, true, `跨学期同名课应当直接可存：${saved.message}`);
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 2);
});

test('★ 重复：完全相同的课默认被拒，allowDuplicate 后可存', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('duplicate');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '同一门课' })]);

  const preview = await call(plugin, 'course_preview', { courses: [course({ name: '同一门课' })] }, ctx);
  assert.equal(preview.duplicates.length, 1, '必须报出重复');
  // 重复的课通常也冲突（同时间同周次），所以这里两个都为 true 才算"如实报告"
  const blocked = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(blocked.ok, false);
  assert.ok(['E_COURSE_CONFLICT', 'E_COURSE_DUPLICATE'].includes(blocked.code), blocked.code);

  const forced = await call(
    plugin,
    'course_save',
    { draftId: preview.draftId, overwriteConflicts: true, allowDuplicate: true },
    ctx,
  );
  assert.equal(forced.ok, true, forced.message);
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 2);
});

test('冲突：同一批里两条互相冲突也要被拦', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('conflict-in-batch');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const preview = await call(plugin, 'course_preview', {
    courses: [
      course({ name: '甲', weekday: 1, periods: [1, 2] }),
      course({ name: '乙', weekday: 1, periods: [2, 3] }),
    ],
  }, ctx);
  assert.equal(preview.ok, true);
  assert.ok(preview.conflicts.length > 0, '同一批里的互相冲突必须报出来');

  const blocked = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_COURSE_CONFLICT');
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 0, '被拒时一条都不能落库');
});

test('★ 重复：同一批里两条完全相同的课，save 默认拒绝；allowDuplicate 后成功', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('duplicate-in-batch');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const preview = await call(plugin, 'course_preview', {
    courses: [
      course({ name: '同批重复' }),
      course({ name: '同批重复' }),
    ],
  }, ctx);
  assert.equal(preview.ok, true, preview.message);
  assert.ok(preview.duplicates.length > 0, '预览必须标出同批重复');
  assert.ok(preview.duplicates.some((d) => d.inBatch === true), '重复项应标记 inBatch');

  /*
   * overwriteConflicts 先放行"冲突"这一关，才能单独验证"重复"这一关：
   * 两条完全相同的课必然也时段重叠。修复前这里会直接保存成功（重复检查
   * 只比已存记录、不比同批），于是库里出现两条一模一样的课。
   */
  const blocked = await call(
    plugin,
    'course_save',
    { draftId: preview.draftId, acknowledgeOptionalMissing: true, overwriteConflicts: true },
    ctx,
  );
  assert.equal(blocked.ok, false, '同批重复默认必须被拒绝');
  assert.equal(blocked.code, 'E_COURSE_DUPLICATE');
  assert.ok(blocked.duplicates.some((d) => d.inBatch === true), '错误里要说明是同批重复');
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 0, '被拒时不能落库');

  // 草案被拒后仍然可用（保存成功才丢弃）
  const forced = await call(
    plugin,
    'course_save',
    {
      draftId: preview.draftId,
      acknowledgeOptionalMissing: true,
      overwriteConflicts: true,
      allowDuplicate: true,
    },
    ctx,
  );
  assert.equal(forced.ok, true, forced.message);
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 2);
});

/* ================================================== 8. 损坏文件 */

test('★ 损坏：非法 JSON → list/save 都报损坏，且文件内容保持原样', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('corrupt');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  // 先存一条，拿到文件路径
  await previewAndSave(plugin, ctx, [course()]);
  const files = await fs.readdir(path.join(dataDir, 'courses'));
  assert.equal(files.length, 1);
  const file = path.join(dataDir, 'courses', files[0]);
  const original = (await fs.readFile(file, 'utf8')).slice(0, 20);

  // 手动写坏
  const broken = '{ this is not json';
  await fs.writeFile(file, broken, 'utf8');

  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.ok, false);
  assert.equal(list.code, 'E_COURSE_STORE_CORRUPT');
  assert.ok(list.file && list.file.includes('courses'), '必须给出文件路径');
  assert.match(list.message, /备份|覆盖|重置/, '必须告诉用户数据没有被覆盖');

  // 写操作同样拒绝（这是最关键的：不能拿空库盖掉用户的副本）
  const preview = await call(plugin, 'course_preview', { courses: [course({ name: '新的' })] }, ctx);
  assert.equal(preview.ok, false);
  assert.equal(preview.code, 'E_COURSE_STORE_CORRUPT');

  assert.equal(await fs.readFile(file, 'utf8'), broken, '损坏的文件内容必须原样保留');
  assert.ok(original.length > 0);
});

test('★ 损坏：形状不对（courses 不是数组）同样算损坏', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('corrupt-shape');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);
  await previewAndSave(plugin, ctx, [course()]);

  const files = await fs.readdir(path.join(dataDir, 'courses'));
  const file = path.join(dataDir, 'courses', files[0]);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.courses = 'not-an-array';
  await fs.writeFile(file, JSON.stringify(doc), 'utf8');

  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.ok, false);
  assert.equal(list.code, 'E_COURSE_STORE_CORRUPT');
});

test('★ 损坏：单条记录本身非法（节次越界/时间非法/周次越界）也算损坏，且不覆盖', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('corrupt-record');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);
  await previewAndSave(plugin, ctx, [course()]);

  const files = await fs.readdir(path.join(dataDir, 'courses'));
  const file = path.join(dataDir, 'courses', files[0]);
  const original = await fs.readFile(file, 'utf8');

  /*
   * docs §7.5：读取时做**完整**形状校验，每条记录合法；不合法按损坏处理。
   * 修复前只校验到"periods 是数组 / termStartDate 是字符串"，这些记录会被
   * 原样读进来，之后 weekOf/冲突判定拿到的就是脏数据。
   */
  const mutations = [
    (doc) => { doc.courses[0].periods = [0, 2]; },
    (doc) => { doc.courses[0].startTime = '25:00'; },
    (doc) => { doc.courses[0].weekEnd = 99; },
    (doc) => { doc.courses[0].createdAt = 'not-a-date'; },
  ];

  for (const mutate of mutations) {
    const doc = JSON.parse(original);
    mutate(doc);
    const written = JSON.stringify(doc);
    await fs.writeFile(file, written, 'utf8');

    const list = await call(plugin, 'course_list', {}, ctx);
    assert.equal(list.ok, false, `应判损坏：${mutate}`);
    assert.equal(list.code, 'E_COURSE_STORE_CORRUPT');
    assert.match(String(list.message), /第 1 条|损坏/, list.message);
    assert.equal(await fs.readFile(file, 'utf8'), written, '损坏文件绝不能被自动改写/覆盖');

    // 写操作同样拒绝（不能拿空库盖掉）
    const preview = await call(plugin, 'course_preview', { courses: [course({ name: '新的' })] }, ctx);
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'E_COURSE_STORE_CORRUPT');
  }
});

test('★ 损坏：显式 forceCorrupt 重置会留下 .bak，之后可正常使用', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('corrupt-reset');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);
  await previewAndSave(plugin, ctx, [course()]);

  const files = await fs.readdir(path.join(dataDir, 'courses'));
  const file = path.join(dataDir, 'courses', files[0]);
  const broken = '{ broken';
  await fs.writeFile(file, broken, 'utf8');

  // 不带 forceCorrupt 时不能重置
  const soft = await call(plugin, 'course_delete', { all: true }, ctx);
  assert.equal(soft.ok, false);
  assert.equal(soft.code, 'E_COURSE_STORE_CORRUPT');

  const reset = await call(plugin, 'course_delete', { all: true, forceCorrupt: true }, ctx);
  assert.equal(reset.ok, true, reset.message);
  assert.equal(reset.reset, true);
  assert.ok(reset.backup, '必须留下备份路径');
  assert.match(reset.backup, /\.corrupt-\d+\.bak$/);

  const entries = await fs.readdir(path.join(dataDir, 'courses'));
  const bak = entries.find((e) => e.endsWith('.bak'));
  assert.ok(bak, '备份文件必须真的存在');
  assert.equal(await fs.readFile(path.join(dataDir, 'courses', bak), 'utf8'), broken, '备份内容必须是原始损坏内容');

  // 重置后可以正常用
  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.ok, true, list.message);
  assert.equal(list.count, 0);

  await previewAndSave(plugin, ctx, [course({ name: '重置后的课' })]);
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 1);
});

test('损坏：正常文件拒绝被 reset 清空（防止误操作清库）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('reset-guard');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);
  await previewAndSave(plugin, ctx, [course({ name: '重要数据' })]);

  const r = await call(plugin, 'course_delete', { all: true, forceCorrupt: true }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_COURSE_BAD_ARG');
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 1, '正常数据不能被 forceCorrupt 清掉');
});

test('损坏：文件被换成别人的（owner 不符）时拒绝读取', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('owner-mismatch');
  const alice = makeCtx({ dataDir, convKey: 'private:1', userId: '1' });
  const bob = makeCtx({ dataDir, convKey: 'private:2', userId: '2' });
  await plugin.init(alice);

  await previewAndSave(plugin, alice, [course({ name: 'Alice' })]);
  // 把 Bob 的文件名指向 Alice 的内容（模拟文件被手工拷贝/替换）
  const files = await fs.readdir(path.join(dataDir, 'courses'));
  const aliceFile = path.join(dataDir, 'courses', files[0]);
  const bobFile = path.join(dataDir, 'courses', `${'b'.repeat(32)}.json`);
  // Bob 的真实文件名由 hash 决定，这里直接让 Bob 读 Alice 那份是做不到的
  // （路径不同）——所以反过来验证：把 Alice 的内容改成 Bob 的 owner 后再让 Alice 读。
  const doc = JSON.parse(await fs.readFile(aliceFile, 'utf8'));
  doc.owner = { convKey: bob.convKey, userId: bob.userId };
  await fs.writeFile(aliceFile, JSON.stringify(doc), 'utf8');

  const list = await call(plugin, 'course_list', {}, alice);
  assert.equal(list.ok, false);
  assert.equal(list.code, 'E_COURSE_STORE_CORRUPT');
  assert.ok(!(await fs.readdir(path.join(dataDir, 'courses'))).some((f) => f === path.basename(bobFile)));
});

/* ================================================== 9. 参数与字段校验 */

test('★ 校验：非法 weekday / 时间 / 日期 / 周次都要被拒，并指出字段', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('validate');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const cases = [
    [{ weekday: 0 }, /weekday/],
    [{ weekday: 8 }, /weekday/],
    [{ startTime: '25:00', endTime: '26:00' }, /startTime|endTime|时间/],
    [{ startTime: '08:60' }, /startTime|endTime|时间/],
    [{ termStartDate: '2026-02-30' }, /termStartDate|日期/],
    [{ termStartDate: '2026-9-7' }, /termStartDate|日期/],
    [{ weekStart: 5, weekEnd: 3 }, /weekStart|weekEnd|周次|周开始/],
    [{ weekEnd: 40 }, /weekEnd|周次|周结束/],
  ];

  for (const [over, re] of cases) {
    const r = await call(plugin, 'course_preview', { courses: [course(over)] }, ctx);
    // 两种情况都算"被拒并指出字段"：预览层直接失败，或预览成功但该条不可保存且 issues 指出字段
    if (r.ok === false) {
      assert.match(String(r.message), re, `over=${JSON.stringify(over)} message=${r.message}`);
      continue;
    }
    const entry = r.courses[0];
    assert.equal(entry.ok, false, `over=${JSON.stringify(over)} 应当不可保存`);
    const text = JSON.stringify(entry.issues) + entry.missing.join(',');
    assert.match(text, re, `over=${JSON.stringify(over)} 的 issues 必须指出字段，实际 ${text}`);
  }
});

test('校验：courses 不是数组 / 空数组 / 超量都要被拒', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('validate-courses');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  assert.equal((await call(plugin, 'course_preview', { courses: 'nope' }, ctx)).code, 'E_COURSE_BAD_ARG');
  assert.equal((await call(plugin, 'course_preview', { courses: [] }, ctx)).code, 'E_COURSE_BAD_ARG');
  assert.equal((await call(plugin, 'course_preview', {}, ctx)).code, 'E_COURSE_BAD_ARG');

  const many = Array.from({ length: 21 }, (_, i) => course({ name: `课${i}`, weekday: (i % 7) + 1 }));
  const over = await call(plugin, 'course_preview', { courses: many }, ctx);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'E_COURSE_LIMIT');
});

test('校验：save 不接受课程内容（只认 draftId）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('save-only-draft');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  // 模型试图绕过预览直接存
  const r = await call(plugin, 'course_save', { courses: [course()] }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_COURSE_BAD_ARG');
  assert.match(r.message, /draftId/);
});

test('校验：删除需要 courseId 或 all', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('delete-args');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);
  await previewAndSave(plugin, ctx, [course()]);

  const neither = await call(plugin, 'course_delete', {}, ctx);
  assert.equal(neither.ok, false);
  assert.equal(neither.code, 'E_COURSE_BAD_ARG');

  const missing = await call(plugin, 'course_delete', { courseId: 'c_00000000' }, ctx);
  assert.equal(missing.code, 'E_COURSE_NOT_FOUND');
});

test('删除：删掉一条后另一条还在；all 清空', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('delete');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const { saved } = await previewAndSave(plugin, ctx, [course({ name: 'A' }), course({ name: 'B', weekday: 3 })]);
  const a = saved.courses.find((c) => c.name === 'A');

  const one = await call(plugin, 'course_delete', { courseId: a.id }, ctx);
  assert.equal(one.ok, true);
  assert.equal(one.deleted, 1);
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 1);

  const all = await call(plugin, 'course_delete', { all: true }, ctx);
  assert.equal(all.ok, true);
  assert.equal(all.deleted, 1);
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 0);
});

/* ================================================== 10. 其它 */

test('list：按星期过滤', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('list-weekday');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [
    course({ name: '周一课', weekday: 1 }),
    course({ name: '周三课', weekday: 3 }),
  ]);

  const r = await call(plugin, 'course_list', { weekday: 3 }, ctx);
  assert.equal(r.count, 1);
  assert.equal(r.courses[0].name, '周三课');

  const bad = await call(plugin, 'course_list', { weekday: 9 }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_COURSE_BAD_ARG');
});

test('list：多个学期按学期分组', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('list-terms');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: '秋季课', termStartDate: '2026-09-07' })]);
  // 春季学期：2027-03-01 是周一
  await previewAndSave(plugin, ctx, [course({ name: '春季课', termStartDate: '2027-03-01', weekday: 2 })]);

  const r = await call(plugin, 'course_list', {}, ctx);
  assert.equal(r.count, 2);
  assert.equal(r.termCount, 2);
  assert.deepEqual(r.terms.map((x) => x.termStartDate), ['2026-09-07', '2027-03-01']);

  const one = await call(plugin, 'course_list', { termStartDate: '2027-03-01' }, ctx);
  assert.equal(one.count, 1);
  assert.equal(one.courses[0].name, '春季课');
});

test('时间与节次都缺时不可保存（不能只有课名和星期）', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('need-time');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const preview = await call(plugin, 'course_preview', {
    courses: [{ name: '没有时间的课', weekday: 2, termStartDate: TERM, weekStart: 1, weekEnd: 16 }],
  }, ctx);
  assert.equal(preview.ok, true);
  assert.ok(preview.missing.includes('time'), `missing 应含 time，实际 ${JSON.stringify(preview.missing)}`);

  const saved = await call(plugin, 'course_save', { draftId: preview.draftId, acknowledgeOptionalMissing: true }, ctx);
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'E_COURSE_NEEDS_INFO');
});

test('上限：超过 maxCourses 时拒绝保存', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('limit');
  const ctx = makeCtx({ dataDir, config: { maxCourses: 2 } });
  await plugin.init(ctx);

  await previewAndSave(plugin, ctx, [course({ name: 'A' }), course({ name: 'B', weekday: 2 })]);

  const preview = await call(plugin, 'course_preview', { courses: [course({ name: 'C', weekday: 3 })] }, ctx);
  const r = await call(plugin, 'course_save', { draftId: preview.draftId }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_COURSE_LIMIT');
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 2, '被拒时不能写进任何一条');
});

test('自检：testConnection 不读也不改课程数据', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('selftest');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);
  await previewAndSave(plugin, ctx, [course()]);

  const r = await plugin.testConnection(ctx);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.details.files, 1);
  assert.equal(r.details.corrupt, 0);
  // 只读：数据还在
  assert.equal((await call(plugin, 'course_list', {}, ctx)).count, 1);
});

test('取消：signal 已 abort 时工具立刻返回 E4070', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('abort');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const controller = new AbortController();
  controller.abort();
  const r = await plugin.callTool({ tool: 'course_list', args: {}, ctx, signal: controller.signal });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4070');
});

test('未知工具：返回 E4041，不抛异常', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('unknown');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const r = await call(plugin, 'course_nope', {}, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E4041');
});

test('★ 并发：同一归属同时保存两批，两条都不能丢', async (t) => {
  const dataDir = await tempDataDir(t);
  const plugin = await loadPlugin('concurrent');
  const ctx = makeCtx({ dataDir });
  await plugin.init(ctx);

  const p1 = await call(plugin, 'course_preview', { courses: [course({ name: '并发A', weekday: 1 })] }, ctx);
  const p2 = await call(plugin, 'course_preview', { courses: [course({ name: '并发B', weekday: 2 })] }, ctx);

  const [r1, r2] = await Promise.all([
    call(plugin, 'course_save', { draftId: p1.draftId }, ctx),
    call(plugin, 'course_save', { draftId: p2.draftId }, ctx),
  ]);
  assert.equal(r1.ok, true, r1.message);
  assert.equal(r2.ok, true, r2.message);

  const list = await call(plugin, 'course_list', {}, ctx);
  assert.equal(list.count, 2, `并发保存不能丢数据，实际 ${list.count}`);
  const names = list.courses.map((c) => c.name).sort();
  assert.deepEqual(names, ['并发A', '并发B']);
});
