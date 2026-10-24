/**
 * 课程表插件验收 —— 真实宿主链路上的端到端自检
 *
 * ## 它和 test/course-schedule.test.mjs 的分工
 *
 * 那个文件用**手搓的 ctx** 直调插件入口，验的是插件自己的行为（校验、隔离、
 * 损坏处理…）。这个脚本验的是另一件事：**宿主把它装上之后还能不能用**：
 *
 *   1. `plugin.json` 能过真实 `normalizeManifest`（参数 schema 含对象数组，
 *      这是这次新加的能力，写错了只会表现为"插件页显示清单不合法"）；
 *   2. 真实 `PluginManager` 能扫描、启用、登记全部工具；
 *   3. 工具在**真实工具注册表**里，`run()` 能拿到宿主构造的 `invocation`；
 *   4. `validateParams` 真的把课程对象数组传进插件（这是最容易静默失败的一环：
 *      参数被过滤掉时插件只会看到 `courses: undefined`，报"必须是数组"，
 *      而模型那边完全不知道自己传的东西被丢了）；
 *   5. 授权层：默认群聊看不到，点名后可见，`data.session` 没被判成写入类。
 *
 * ## 为什么不用 `node --test`
 *
 * 它是给 `npm run verify:course` 与 `scripts/check.mjs` 之类的入口调的，
 * 需要一手"看得懂的通过/失败清单"，而不是 test runner 的输出格式。
 *
 * ## 不碰什么
 *
 * 不联网、不调模型、不发 QQ。用临时目录当 userDataRoot，跑完删干净。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginManager } from '../src/plugins/manager.mjs';
import { normalizeManifest } from '../src/plugins/manifest.mjs';
import { makeInvocation } from '../src/tools/executor.mjs';
import { getTool } from '../src/tools/registry.mjs';
import { resolveToolSet, DEFAULT_POLICY } from '../src/guard/tool-gate.mjs';
import { ORIGIN } from '../src/guard/origin.mjs';
import { defaultChatTools } from '../src/plugins/chat-tools.mjs';
import { normalizeEffects, riskFloorOf } from '../src/plugins/effects.mjs';

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const PLUGIN_ID = 'course-schedule';

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` —— ${detail}` : ''}`);
}

/**
 * 造一份最小可用的完整配置。
 *
 * @param {object} [over]
 */
function makeConfig(over = {}) {
  return {
    plugins: {
      enabled: [PLUGIN_ID],
      allowDangerous: false,
      chatTools: defaultChatTools(),
      config: {},
      ...over,
    },
  };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ling-course-verify-'));
  const pluginsDir = path.join(root, 'plugins');

  try {
    /* ---- 1. 清单：真实校验器接受它 ---- */
    const raw = JSON.parse(await fs.readFile(path.join(REPO, 'plugins', PLUGIN_ID, 'plugin.json'), 'utf8'));
    const norm = normalizeManifest(raw, { dirName: PLUGIN_ID });
    check('plugin.json 通过真实清单校验', norm.ok, norm.ok ? `${norm.manifest.tools.length} 个工具` : norm.message);
    if (!norm.ok) return;

    const previewTool = norm.manifest.tools.find((t) => t.name === 'course_preview');
    check(
      'course_preview 的 courses 被归一为对象数组',
      previewTool?.params?.courses?.type === 'array' && previewTool?.params?.courses?.items?.type === 'object',
      JSON.stringify(previewTool?.params?.courses?.items ?? {}).slice(0, 80),
    );
    const updateTool = norm.manifest.tools.find((t) => t.name === 'course_update');
    check(
      'course_update 的 patch 被归一为 object',
      updateTool?.params?.patch?.type === 'object' && Object.keys(updateTool?.params?.patch?.properties ?? {}).length > 0,
      `${Object.keys(updateTool?.params?.patch?.properties ?? {}).length} 个可改字段`,
    );

    /* ---- 2. effects：data.session 合法且下限 R1 ---- */
    const eff = normalizeEffects(['data.session']);
    check('data.session 是合法 effect', eff.ok === true, eff.ok ? '' : eff.message);
    check('data.session 的风险下限是 R1', riskFloorOf(['data.session']) === 'R1', riskFloorOf(['data.session']));

    const saveTool = norm.manifest.tools.find((t) => t.name === 'course_save');
    check(
      'course_save 生效风险为 R1（不是 R2）',
      saveTool?.effectiveRisk === 'R1',
      `declared=${saveTool?.risk} effective=${saveTool?.effectiveRisk}`,
    );

    /* ---- 3. 真实管理器：扫描 → 启用 → 登记 ---- */
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.cp(path.join(REPO, 'plugins', PLUGIN_ID), path.join(pluginsDir, PLUGIN_ID), { recursive: true });

    let cfg = makeConfig();
    const mgr = new PluginManager({
      pluginsDir,
      userDataRoot: root,
      secretsPath: path.join(root, 'secrets.vault'),
      getConfig: () => cfg,
      persistConfig: async (next) => {
        cfg = next;
      },
      log: () => {},
      sendText: async () => ({ ok: true }),
      nodePath: process.execPath,
    });

    await mgr.loadAll();
    const before = await mgr.snapshot();
    const loaded = before.items.find((i) => i.id === PLUGIN_ID);
    check(
      '管理器扫描到并自动启用（配置里已 enabled）',
      Boolean(loaded) && loaded.status === 'ready',
      `状态 ${loaded?.status ?? '?'}`,
    );

    /*
     * 如果配置里没预置启用，这里补一次 enable。
     *
     * 两种路径都要能走通：用户是"装好 → 插件页点启用"的，而不是手改配置。
     * 预置启用时 `loadAll` 已经登记了工具，再调 enable 会撞 E4043
     * （工具名已被占用）—— 这本身是正确行为，所以按状态分支处理。
     */
    if (loaded?.status !== 'ready') {
      const enabled = await mgr.enable(PLUGIN_ID);
      check('启用成功', enabled.ok === true, enabled.ok ? '' : `${enabled.code} ${enabled.message}`);
      if (!enabled.ok) return;
    }

    const snap = await mgr.snapshot();
    const item = snap.items.find((i) => i.id === PLUGIN_ID);
    check('状态为运行中', item?.status === 'ready', item?.statusText ?? '');
    check('8 个工具全部登记', item?.tools.length === 8, String(item?.tools.length));
    const names = (item?.tools ?? []).map((t) => t.fullName);
    const expected = [
      'plugin_course_preview',
      'plugin_course_save',
      'plugin_course_cancel',
      'plugin_course_day',
      'plugin_course_week',
      'plugin_course_list',
      'plugin_course_update',
      'plugin_course_delete',
    ];
    check('工具名齐全', expected.every((n) => names.includes(n)), names.join(', '));

    /* ---- 4. 真实工具注册表 + 参数过滤 ---- */
    const tool = getTool('plugin_course_preview');
    check('工具在真实注册表里', Boolean(tool), tool ? `${tool.risk}/${tool.kind}` : '');

    /** 造一次真实调用（invocation 由宿主构造，模型改不了） */
    const call = async (name, args) => {
      const t = getTool(name);
      if (!t) throw new Error(`工具未登记：${name}`);
      const invocation = makeInvocation({
        toolFullName: name,
        origin: 'owner-private',
        convKey: 'private:1001',
        pluginId: PLUGIN_ID,
        requester: { id: '1001', nickname: '验收' },
        callId: `call_${name}`,
      });
      return t.run({ args, origin: 'owner-private', convKey: 'private:1001', invocation });
    };

    const course = {
      name: '高等数学',
      weekday: 1,
      periods: [1, 2],
      location: '教三楼 301',
      teacher: '张老师',
      termStartDate: '2026-09-07',
      weekStart: 1,
      weekEnd: 16,
    };

    const preview = await call('plugin_course_preview', { courses: [course] });
    check(
      '课程对象数组真的传进了插件（没有被参数过滤丢掉）',
      preview?.ok === true && preview?.count === 1,
      preview?.ok ? `draftId=${preview.draftId}` : `${preview?.code} ${preview?.message}`,
    );
    if (!preview?.ok) return;

    const saved = await call('plugin_course_save', { draftId: preview.draftId });
    check('保存成功', saved?.ok === true, saved?.ok ? `${saved.saved} 条` : `${saved?.code} ${saved?.message}`);
    if (!saved?.ok) return;

    const day = await call('plugin_course_day', { date: '2026-09-07' });
    check('按日期查询命中', day?.ok === true && day?.count === 1, `第 ${day?.week} 周 / ${day?.count} 条`);
    check('文本表格可读', typeof day?.table === 'string' && day.table.includes('高等数学'), (day?.table ?? '').split('\n')[0]);

    /* 补 week / list / update / delete 的连通性（不必逐字段断言，单测已覆盖语义） */
    const week = await call('plugin_course_week', { date: '2026-09-07' });
    check('按周查询可用', week?.ok === true, `第 ${week?.week} 周 / ${week?.count} 条`);

    const list = await call('plugin_course_list', {});
    check('列表可用', list?.ok === true && list?.count === 1, `${list?.count} 条`);

    const courseId = saved.courses?.[0]?.id;
    const updated = await call('plugin_course_update', { courseId, patch: { location: '教三楼 305' } });
    check('修改可用', updated?.ok === true && updated?.course?.location === '教三楼 305', updated?.course?.location ?? '');

    const deleted = await call('plugin_course_delete', { courseId });
    check('删除可用', deleted?.ok === true && deleted?.deleted === 1, String(deleted?.deleted));

    /* ---- 5. 授权：默认群里看不到，点名后可见 ---- */
    const toolDecl = snap.items
      .find((i) => i.id === PLUGIN_ID)
      ?.tools.find((t) => t.fullName === 'plugin_course_save');
    // 用注册表里的真实工具（含 origins/kind/effects）做授权判定
    const registered = getTool('plugin_course_save');
    const chatToolsDefault = defaultChatTools();
    const inGroup = resolveToolSet(ORIGIN.GROUP, [registered], { ...DEFAULT_POLICY, chatTools: chatToolsDefault }, {
      convKey: 'group:123',
    });
    check('默认群聊看不到课程表工具（fail-closed）', inGroup.length === 0, `可见 ${inGroup.length} 个`);

    const granted = resolveToolSet(
      ORIGIN.GROUP,
      [registered],
      {
        ...DEFAULT_POLICY,
        chatTools: {
          ...chatToolsDefault,
          group: { enabled: true, tools: ['plugin_course_save'], allowPaid: false },
        },
      },
      { convKey: 'group:123' },
    );
    check(
      '管理员点名后群聊可见（data.session 没被当成写入类拒掉）',
      granted.length === 1,
      `可见 ${granted.length} 个`,
    );

    // R0 的只读工具在群聊里同样需要点名，这里只验 save 这一条，避免重复
    check('工具声明里 data.session 生效风险仍是 R1', toolDecl?.risk === 'R1', toolDecl?.risk ?? '');

    await mgr.shutdown();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(`\n验收脚本异常：${String(/** @type {any} */ (err)?.stack ?? err)}`);
  process.exitCode = 1;
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length} 项通过 / ${failed.length} 项失败`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  process.exitCode = 1;
}
