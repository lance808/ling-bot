/**
 * 前端外壳与新增页面的静态断言
 *
 * 这些是「跑起来才能发现」的东西的廉价替身：
 * 页面文件存在、导出名对得上、主题有两条主题令牌、
 * send-media 的四类校验都在。
 *
 * 真正的渲染由 scripts/ui-e2e.mjs 覆盖（它要跑 Electron），
 * 这里只做能静态确定的部分，避免每次改文案都要开窗口。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);

/** @param {string} rel */
function read(rel) {
  return readFileSync(new URL(rel, ROOT), 'utf8');
}

/** @param {string} rel */
function exists(rel) {
  return existsSync(new URL(rel, ROOT));
}

/* --------------------------------------------------- 页面文件齐备 */

test('九个页面视图文件都存在', () => {
  const pages = ['overview', 'sessions', 'model', 'persona', 'tools', 'plugins', 'security', 'dsh', 'usage', 'logs'];
  for (const p of pages) {
    assert.ok(exists(`ui/src/views/${p}.mjs`), `缺 ${p}.mjs`);
  }
});

test('app.mjs 注册了十一个页面且都 import 了渲染函数', () => {
  const src = read('ui/src/app.mjs');
  for (const f of ['usage', 'tools', 'plugins']) {
    assert.match(src, new RegExp(`import \\{ render\\w+ \\} from './views/${f}\\.mjs'`), `没 import ${f}`);
  }
  // 数一下 PAGES 里的 id 个数
  const pagesBlock = src.slice(src.indexOf('const PAGES'), src.indexOf('];', src.indexOf('const PAGES')));
  const ids = [...pagesBlock.matchAll(/id: '(\w+)'/g)].map((m) => m[1]);
  assert.equal(ids.length, 11, `页面数应为 11，实际 ${ids.length}`);
  assert.ok(ids.includes('tools') && ids.includes('plugins') && ids.includes('usage'));
  // 思考链路属于「概览」组，且排在会话总览之后
  assert.ok(ids.includes('thinking'), '缺思考链路页');
  assert.ok(ids.indexOf('thinking') > ids.indexOf('sessions'), '思考链路应在会话总览之后');
});

/* --------------------------------------------------- 主题 */

test('亮/暗两套主题令牌都在', () => {
  const css = read('ui/styles/base.css');
  // 亮色在 :root，暗色在 [data-theme=dark]
  assert.match(css, /:root\s*\{[^}]*--bg:/s, '缺亮色令牌');
  assert.match(css, /:root\[data-theme='dark'\]/, '缺暗色选择器');
  // 关键语义令牌两套都要有
  for (const token of ['--bg', '--bg-elev', '--fg', '--border', '--accent', '--ok', '--err']) {
    const count = (css.match(new RegExp(`${token}:`, 'g')) ?? []).length;
    assert.ok(count >= 2, `${token} 只出现 ${count} 次，两套主题都要有`);
  }
});

test('主题切换用 data-theme，不用 media query 覆盖用户选择', () => {
  const css = read('ui/styles/base.css');
  // 跟随系统只能是兜底：必须排除已设 data-theme 的情况
  assert.match(css, /:root:not\(\[data-theme\]\)/, '跟随系统要排除已选主题');
});

test('theme-boot 是同步脚本，且在 head 里先于模块执行', () => {
  const html = read('ui/index.html');
  // 不能是 type="module"：那会延迟执行，导致闪白
  const tag = html.match(/<script src="\.\/src\/theme-boot\.js"><\/script>/);
  assert.ok(tag, 'theme-boot.js 必须是普通 script');
  // 要在 app.mjs 之前
  assert.ok(html.indexOf('theme-boot.js') < html.indexOf('app.mjs'), 'theme-boot 要先加载');
  // 必须在 head 里
  const headEnd = html.indexOf('</head>');
  assert.ok(html.indexOf('theme-boot.js') < headEnd, 'theme-boot 要在 head 里');
});

test('主题只有一个存储键，读写都用它', () => {
  const src = read('ui/src/theme-boot.js');
  // 键必须收敛到一个常量，而不是散在各处写字符串字面量
  assert.match(src, /var KEY = '([^']+)'/, '要有一个 KEY 常量');
  const key = src.match(/var KEY = '([^']+)'/)[1];
  assert.equal(key, 'ling-bot:theme', `存储键是 ${key}`);
  // setItem / getItem 都必须用这个常量
  assert.match(src, /localStorage\.setItem\(KEY,/, '写要用 KEY');
  assert.match(src, /localStorage\.getItem\(KEY\)/, '读要用 KEY');
  // 不能有别处硬编码这个键
  const literals = (src.match(/['"]ling-bot:theme['"]/g) ?? []).length;
  assert.equal(literals, 1, '键只应出现在常量定义处');
});

test('主题切换按钮有两个，且绑定 aria-pressed', () => {
  const html = read('ui/index.html');
  const btns = [...html.matchAll(/data-theme-set="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(btns, ['light', 'dark']);
  const app = read('ui/src/app.mjs');
  assert.match(app, /setAttribute\('aria-pressed'/, '要同步按下状态');
});

/* --------------------------------------------------- send-media */

test('后端有 send-media 动作且只接受本机绝对路径', () => {
  const src = read('src/index.mjs');
  assert.match(src, /name === 'send-media'/, '没有 send-media 分支');
  // 拒绝 URL
  assert.match(src, /只支持本机文件路径，不支持网址/);
  // 拒绝相对路径
  assert.match(src, /path\.isAbsolute/);
  // 大小上限
  assert.match(src, /MAX_MEDIA_BYTES/);
  // 存在性检查
  assert.match(src, /fsp\.stat/);
});

test('四种媒体类型都被接受', () => {
  const src = read('src/index.mjs');
  const m = src.match(/const MEDIA_KINDS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, '找不到 MEDIA_KINDS');
  for (const k of ['image', 'video', 'record', 'file']) {
    assert.ok(m[1].includes(`'${k}'`), `缺类型 ${k}`);
  }
});

test('sendText 和 sendMedia 走同一个闸门（不能有旁路）', () => {
  const src = read('src/index.mjs');
  // sendText 必须委托给 sendSegments
  assert.match(src, /async function sendText[\s\S]{0,220}return sendSegments\(/, 'sendText 要委托');
  // 闸门只在一处调用
  const gateCalls = (src.match(/passSendGate\(/g) ?? []).length;
  assert.equal(gateCalls, 1, `passSendGate 应只被调用一次，实际 ${gateCalls} 次`);
  // sendAction 也只在一处
  const sendCalls = (src.match(/client\.sendAction\(/g) ?? []).length;
  assert.equal(sendCalls, 1, `sendAction 应只被调用一次，实际 ${sendCalls} 次`);
});

test('选文件走独立 IPC 通道，不是 QQ 能力的 action', () => {
  const preload = read('electron/preload.cjs');
  assert.match(preload, /ling:pick-file/, 'preload 要暴露 pickFile');
  const main = read('electron/main.mjs');
  assert.match(main, /ipcMain\.handle\('ling:pick-file'/, '主进程要处理 pick-file');
  // 只返回路径，不读内容
  assert.match(main, /return \{ ok: true, path: res\.filePaths\[0\] \}/);
});

/* --------------------------------------------------- 会话页 */

test('会话页区分群聊与私聊，且支持四类手动发送', () => {
  const src = read('ui/src/views/sessions.mjs');
  assert.match(src, /groupKeys/, '要有群聊分组');
  assert.match(src, /privateKeys/, '要有私聊分组');
  for (const k of ['image', 'video', 'record', 'file']) {
    assert.ok(src.includes(`kind: '${k}'`), `缺发送类型 ${k}`);
  }
  // 拒因必须显示码和原因
  assert.match(src, /被拒：/, '要显示拒因');
});

test('会话页的发送不自己做授权判定', () => {
  const src = read('ui/src/views/sessions.mjs');
  // 前端不该出现白名单判断逻辑——那是后端的职责
  assert.ok(!/allow\.|whitelist|白名单.*includes/i.test(src), '前端不应自行判定白名单');
});

/* --------------------------------------------------- 词元页 */

test('词元页不折算金额（文档明确不支持计算花费）', () => {
  const src = read('ui/src/views/usage.mjs');
  // 不能出现货币符号。注意不能把 $ 写进字符类——
  // JS 模板字符串里的 \${ 会让它误报。
  for (const sym of ['¥', '€', '£']) {
    assert.ok(!src.includes(sym), `不应出现货币符号 ${sym}`);
  }
  // $ 只在"后面跟数字"时才算货币用法（排除 \${ 模板占位）
  assert.ok(!/\$\s*\d/.test(src), '不应出现 $ 金额写法');
  assert.match(src, /不折算金额|不支持/, '要说明为什么不算钱');
});

test('词元页的缓存命中率区分「没有数据」和「0%」', () => {
  const src = read('ui/src/views/usage.mjs');
  assert.match(src, /hitRate === null/, '要区分 null 与 0');
  assert.match(src, /上游未返回缓存细节/, '要解释为什么没有');
});

test('四个时间范围都在', () => {
  const src = read('ui/src/views/usage.mjs');
  for (const k of ['24h', '3d', '7d', '30d']) {
    assert.ok(src.includes(`key: '${k}'`), `缺范围 ${k}`);
  }
});

/* --------------------------------------------------- 总览页 */

test('总览保留三态分离（联通/接收/在线）', () => {
  const src = read('ui/src/views/overview.mjs');
  assert.match(src, /已联通|未联通/, '缺联通态');
  assert.match(src, /接收正常|接收异常|接收未知/, '缺接收态');
  assert.match(src, /QQ 在线|QQ 离线|在线未知/, '缺在线态');
});

test('能力三态区分 true / false / 未探测', () => {
  const src = read('ui/src/views/overview.mjs');
  assert.match(src, /v === true/, '要处理 true');
  assert.match(src, /v === false/, '要处理 false');
  // 兜底是"未知"而不是 false
  assert.match(src, /\?\s*'dim'|\?\s*`/, '未探测要单独显示');
});

/* --------------------------------------------------- 插件页 */

test('插件页把「已加载」和「已启用」分开显示', () => {
  const src = read('ui/src/views/plugins.mjs');
  assert.match(src, /已加载/, '缺已加载');
  assert.match(src, /已启用/, '缺已启用');
  assert.match(src, /已跳过/, '缺已跳过');
  // 启用但没加载是明确的异常态，不能显示成"已禁用"
  assert.match(src, /启用但未加载/);
});

test('禁用插件不改文件，只改配置', () => {
  const src = read('ui/src/views/plugins.mjs');
  assert.ok(!/rmSync|unlink|removeSync/.test(src), '禁用不该删文件');
  const app = read('ui/src/app.mjs');
  assert.match(app, /setting\('plugins\.enabled'/, '要通过配置启停');
});

/* ------------------------------------------- 输入不被重绘冲掉（踩过的坑） */

test('★ 正在输入时跳过整页重绘', async () => {
  // 真踩过的坑：快照每 2 秒轮询一次，每次 clear(view) 重建 DOM。
  // 重建会销毁输入框节点，用户刚敲的字跟着没了 ——
  // 表现成"点进去准备输入，它自己恢复了"。
  const app = read('ui/src/app.mjs');
  assert.match(app, /function isEditing\(\)/, '要有输入态判断');
  assert.match(app, /lastRenderedPage/, '要记住上次渲染的页面');
  // 同一页 + 正在输入 → 直接返回，不重建
  // 条件里同时要有输入态和「操作进行中」，后者见下一个测试
  assert.match(app, /if \(!pageChanged && \(isEditing\(\) \|\| activeOps > 0\)\)/);
});

test('★ 换页面时即使正在输入也要重绘', async () => {
  // 用户点导航就是要走，此时保留输入反而是 bug
  const app = read('ui/src/app.mjs');
  assert.match(app, /const pageChanged = lastRenderedPage !== page\.id/, '要区分换页与轮询');
});

test('★ isEditing 认 input / textarea / select / contentEditable', () => {
  const app = read('ui/src/app.mjs');
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.ok(app.includes(tag), `要认 ${tag}`);
  }
  assert.match(app, /isContentEditable/);
});

test('★ 模型页的状态必须活在模块作用域', async () => {
  // 写在 render 里的话，每次渲染都是新对象，草稿全丢
  const src = read('ui/src/views/model.mjs');
  const fnStart = src.indexOf('export function renderModelSettings');
  assert.ok(fnStart > 0);
  // 模块作用域要有 const state = {
  const beforeFn = src.slice(0, fnStart);
  assert.match(beforeFn, /const state = \{/, 'state 要在函数外定义');
  // 函数内必须是引用它，而不是重新定义
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
  assert.match(fnBody, /const local = state/, '函数内要引用同一个 state');
  assert.ok(!/const local = \{/.test(fnBody), '不能在函数内新建 local 对象');
});

test('★ 模型页三种草稿都有地方存', () => {
  const src = read('ui/src/views/model.mjs');
  for (const k of ['keyDraft', 'timeoutDraft', 'dirty']) {
    assert.ok(src.includes(k), `缺草稿字段 ${k}`);
  }
});

test('★ Key 草稿只存内存，不落盘不进日志', () => {
  const src = read('ui/src/views/model.mjs');
  // state 里不该出现 localStorage / sessionStorage / 文件写入
  assert.ok(!/localStorage|sessionStorage/.test(src), 'Key 草稿不能进持久存储');
  // 保存成功后必须清掉
  assert.match(src, /state\.keyDraft = ''/, '保存后要清草稿');
});

test('★ 操作进行中也要暂停重绘（否则结果刚写就被抹掉）', async () => {
  // 真踩过的坑：点「测试连接」时焦点在按钮上，isEditing() 为 false，
  // 于是 2 秒后重绘把 testHost 里的结果抹掉 —— 表现成"点了没反应"。
  const app = read('ui/src/app.mjs');
  assert.match(app, /let activeOps = 0/, '要有操作计数');
  assert.match(app, /async function withPaintLock/, '要有暂停重绘的包装');
  // 计数必须能回去
  assert.match(app, /activeOps -= 1/, '要能减回去');
  // 关键操作都要包起来
  for (const op of ["llm.test", "llm.models", "llm.probe"]) {
    assert.ok(
      app.includes(`withPaintLock(() => action('${op}'`) || app.includes(`withPaintLock(async () =>`),
      `${op} 要包在 withPaintLock 里`,
    );
  }
});

test('★ 测试连接在请求期间就要显示状态', () => {
  // 原来是 await 之后才写 DOM，请求期间那一片是空的
  const src = read('ui/src/views/model.mjs');
  const i = src.indexOf("text: '测试连接'");
  const block = src.slice(i, i + 1400);
  assert.match(block, /请求中/, '要先显示请求中');
  assert.match(block, /testBtn\.disabled = true/, '要禁用按钮防重复点');
});

test('★ brain.keySource 必须由快照提供', () => {
  // 界面读 brain.keySource，后端原来只放在 config.llm.keySource 里，
  // 于是 Key 永远显示「未设置」，同时「可否对话」又是绿的 —— 自相矛盾
  const src = read('src/index.mjs');
  const i = src.indexOf('brain: {');
  const block = src.slice(i, i + 900);
  assert.match(block, /keySource/, 'brain 里要有 keySource');
});

test('★ withPaintLock 解锁时不能主动重绘', () => {
  // 真踩到的坑：finally 里 render() 会在调用方写结果之前清空 testHost，
  // 于是「测试连接」永远显示不出结果。
  const app = read('ui/src/app.mjs');
  const i = app.indexOf('async function withPaintLock');
  assert.ok(i > 0);
  const body = app.slice(i, app.indexOf('\n}', i) + 2);
  // 剥掉注释再断言，否则注释里的 render() 会让测试假通过
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/render\(\)/.test(code), 'finally 里不能调用 render()');
  assert.match(code, /activeOps -= 1/, '必须解锁');
});

test('★ 测试结果要常驻，不能闪一下就没', () => {
  // 真踩到的坑：结果原来只写进按钮下方的临时区域，
  // 每 2 秒整页重绘就把它抹掉，用户只看到一闪。
  const src = read('ui/src/views/model.mjs');
  assert.match(src, /lastTest/, '结果要存在模块级 state');
  assert.match(src, /kv\('测试结果'/, '当前状态卡片里要有这一行');
  assert.match(src, /id: 'test-result'/, '这一行要能原地更新');
  assert.match(src, /row\?\.replaceWith\(fresh\)/, '拿到结果后要原地刷新');
  // 必须是第一行（在「可否对话」之前）
  const iTest = src.indexOf("kv('测试结果'");
  const iDialogue = src.indexOf("kv('可否对话'");
  assert.ok(iTest > 0 && iDialogue > 0 && iTest < iDialogue, '「测试结果」要排在「可否对话」上面');
});

test('★ 常驻结果只放结论，长句留在临时区', () => {
  // 状态行要一眼扫完；「通了：通了（2134ms，deepseek-v4.1-flash）」
  // 那种长句会把它撑宽，不该进常驻状态。
  const src = read('ui/src/views/model.mjs');
  const i = src.indexOf('function testResultCell');
  const block = src.slice(i, src.indexOf('\n  }', i));
  assert.match(block, /通过/, '要有通过');
  assert.match(block, /失败/, '要有失败');
  assert.ok(!/text: r\.text/.test(block), '常驻行不放原文');
  // 但临时区仍要能看到明细
  assert.match(src, /通了：/, '临时区要显示明细');
});

/* ------------------------------------------- 顶栏与左下角的分工 */

test('★ 救场按钮在左下角，主题切换在顶栏', () => {
  // 互换过：出问题才点的按钮属于全局操作，放侧栏底部；主题随时切，放顶栏
  const html = read('ui/index.html');
  // 侧栏底部的范围要截止到 </aside>，否则会把后面的顶栏也算进来
  const footStart = html.indexOf('class="sidebar-foot"');
  const sideFoot = html.slice(footStart, html.indexOf('</aside>', footStart));
  const topbar = html.slice(html.indexOf('class="topbar"'), html.indexOf('id="view"'));

  assert.ok(sideFoot.includes('id="btn-reconnect"'), '重连 QQ 要在左下角');
  assert.ok(sideFoot.includes('id="btn-restart"'), '重启后端要在左下角');
  assert.ok(!sideFoot.includes('theme-switch'), '主题切换不该在左下角');

  assert.ok(topbar.includes('id="theme-switch"'), '主题切换要在顶栏');
  assert.ok(!topbar.includes('id="btn-reconnect"'), '重连 QQ 不该在顶栏');
});

test('★ 主题切换在顶栏要锁宽', () => {
  // 它原来是侧栏里的 grid 1fr 1fr 会跟着容器撑开，进顶栏后需要固定宽度
  const css = read('ui/styles/base.css');
  const i = css.indexOf('.theme-switch {');
  const block = css.slice(i, css.indexOf('}', i));
  assert.match(block, /width:\s*\d+px/, '主题切换要固定宽度');
  assert.match(block, /flex:\s*none/, '不能被 flex 拉伸');
});

test('★ 左下角两个按钮不换行', () => {
  const css = read('ui/styles/base.css');
  const i = css.indexOf('.sidebar-actions');
  assert.ok(i > 0, '要有 sidebar-actions 样式');
  const block = css.slice(i, i + 400);
  assert.match(block, /white-space:\s*nowrap/);
});

test('★ 默认菜单栏必须去掉', () => {
  // Electron 在 Windows 上默认挂 File/Edit/View/Window，本项目一项都用不上
  const src = read('electron/main.mjs');
  assert.match(src, /win\.setMenu\(null\)/, '窗口要移除菜单');
  assert.match(src, /Menu\.setApplicationMenu\(null\)/, '全局也要移除');
  assert.match(src, /autoHideMenuBar:\s*true/, '顺手禁掉 Alt 唤起');
});

test('★ 总览的能力要按当前模型去取', () => {
  // 真踩到的坑：能力表是 { [模型名]: {...} }，总览把整张表当能力对象，
  // 于是 caps.vision 永远 undefined —— 明明测出 vision:true 却显示"识图 ?"
  const src = read('ui/src/views/overview.mjs');
  assert.match(src, /function currentCaps/, '要按模型名取');
  assert.match(src, /table\[key\]/, '要用模型名做键');
  // 不能再把整张表直接传进去
  assert.ok(
    !/visionMetric\(cfg\.llm\?\.modelCapabilities \?\? \{\}\)/.test(src),
    '不能把整张能力表当能力对象传',
  );
});

test('★ 能力字段名必须是 vision / image', () => {
  // 探测结果写的是 image，总览读的是 imageGen，差一个词就永远显示 ?
  const src = read('ui/src/views/overview.mjs');
  assert.match(src, /caps\.vision/, '要读 vision');
  assert.match(src, /caps\.image\b/, '要读 image');
  assert.ok(!/caps\.imageGen/.test(src), '不能读 imageGen');
});

test('★ 插件危险权限必须有开关，不能只是药丸', () => {
  // 真踩到的坑：这一块只显示「已关闭（推荐）」，没有任何可点的东西，
  // 看起来像写死的状态，用户想开也开不了。
  const src = read('ui/src/views/plugins.mjs');
  const i = src.indexOf('插件权限');
  const block = src.slice(i, i + 3000);
  assert.match(block, /el\('button'/, '要有按钮');
  assert.match(block, /onDangerous/, '要能提交');
  // 开启是危险操作，必须有二次确认（文案在 setAsk 里）
  assert.match(src, /确认开启/, '开启前要确认');
});

test('★ 后端要支持写 allowDangerous 与 enabled', () => {
  const src = read('src/index.mjs');
  assert.match(src, /key === 'plugins\.allowDangerous'/, '要有 allowDangerous 分支');
  assert.match(src, /key === 'plugins\.enabled'/, '要有 enabled 分支');
  // 必须是布尔，不能收 "yes" 这种
  assert.match(src, /typeof value !== 'boolean'/, '要校验类型');
  // 改完要重新加载，否则要等重启
  assert.match(src, /async function reloadPlugins/, '要能重载插件');
  assert.match(src, /await reloadPlugins\(\)/, '改设置后要调用');
});

test('★ 插件名不能带路径穿越', () => {
  const src = read('src/index.mjs');
  const i = src.indexOf("key === 'plugins.enabled'");
  const block = src.slice(i, i + 1200);
  assert.match(block, /\[\\\\\/\]/, '要挡住路径分隔符');
  assert.match(block, /不合法/, '要给出错误');
});

test('★ 视图收到的是子对象，不能再用 ctx.plugins 往下钻', () => {
  // 真踩到的坑：renderPlugins(s, ctx.plugins) 传的已经是 plugins 子对象，
  // 函数里写 ctx.plugins.onToggle 就是取 undefined，
  // 而 `?.` 会把它静默吞掉 —— 按钮点了什么都不发生，没有任何报错。
  //
  // 这个 bug 同时让「禁用插件」失效了很久。
  const src = read('ui/src/views/plugins.mjs');
  assert.ok(!/ctx\.plugins\?\./.test(src), '不能用 ctx.plugins.');
  assert.match(src, /ctx\.onToggle\?\./, '要用 ctx.onToggle');
  assert.match(src, /ctx\.onDangerous\?\./, '要用 ctx.onDangerous');
});

test('★ 确认框跨重绘要保留，不能闪一下就消失', () => {
  // 真踩到的坑：确认框用渲染函数里的局部变量控制，
  // 快照每 2 秒整页重建，变量和 DOM 一起没了 —— 弹窗一闪即逝。
  const src = read('ui/src/views/plugins.mjs');
  assert.match(src, /const ui = \{/, '要有模块级状态');
  assert.match(src, /dangerAsk/, '要有确认框开关');
  // 重绘后必须按状态恢复
  assert.match(src, /setAsk\(ui\.dangerAsk === true\)/, '重绘后要恢复确认框');
  // 不能又把状态重置掉
  assert.ok(!/ui\.dangerAsk = false;\s*\n\s*\}\s*;?\s*\n/.test(src.split('setAsk(ui.dangerAsk')[1] ?? ''), '重绘后不能强行关掉');
});

/* ------------------------------------------- 白名单编辑卡片 */

test('★ 安全页要有白名单编辑卡片', () => {
  const src = read('ui/src/views/security.mjs');
  assert.match(src, /白名单（L1 准入）/, '要有白名单卡片');
  // 通过 setting 通道保存，key 是参数化的（allow / deny 共用一套组件）
  assert.match(src, /onSaveSetting\?\.\(which,/, '要通过 setting 保存');
  // 群和私聊两个列表都要能编辑
  assert.match(src, /adder\('groups'/, '群列表可加');
  assert.match(src, /adder\('private'/, '私聊列表可加');
});

test('★ 白名单草稿要活在模块作用域', () => {
  // 局部变量会被 2 秒轮询的重绘冲掉，用户刚加的号就没了
  const src = read('ui/src/views/security.mjs');
  const fnStart = src.indexOf('export function renderSecurity');
  assert.ok(fnStart > 0);
  const before = src.slice(0, fnStart);
  assert.match(before, /const ui = \{/, 'state 要在函数外');
  assert.match(before, /draft: \{ allow: null, deny: null \}/, '白/黑名单各一份草稿');
  assert.ok(!/^const ui = \{/m.test(src.slice(fnStart)), '不能在函数内重新定义');
});

test('★ 加号时的提示也要跨重绘', () => {
  // 提示原来写进局部节点，紧接着 rerender() 就把它冲掉了
  const src = read('ui/src/views/security.mjs');
  assert.match(src, /hint: \{\}/, '提示要存状态');
  assert.match(src, /ui\.hint\[key\] = \{ tone/, '写入状态');
  assert.match(src, /const prev = ui\.hint\[key\]/, '渲染时读状态');
});

test('★ 非法号码必须在界面层就挡住', () => {
  const src = read('ui/src/views/security.mjs');
  assert.match(src, /\^\\d\{5,12\}\$/, '要校验格式');
  assert.match(src, /不是有效的号码/, '要给出提示');
});

test('★ 一次可以粘贴多个号码', () => {
  const src = read('ui/src/views/security.mjs');
  assert.match(src, /split\(\/\[\\s,，;；\]\+\//, '要支持逗号空格分隔');
});

test('★ 空白名单要有警告', () => {
  // allowAllWhenEmpty 为 false 时，名单空了就等于谁都进不来，
  // 用户会以为机器人坏了
  const src = read('ui/src/views/security.mjs');
  assert.match(src, /allowAllWhenEmpty/, '要读这个开关');
  assert.match(src, /谁的消息都进不来/, '要给警告');
});

test('★ 安全页的 ctx 要有 rerender', () => {
  const src = read('ui/src/app.mjs');
  const i = src.indexOf('security: {');
  const block = src.slice(i, i + 500);
  assert.match(block, /rerender:/, '加号/删号后要立刻重绘');
});

test('★ 安全页要有黑名单卡片，且能编辑', () => {
  const src = read('ui/src/views/security.mjs');
  assert.match(src, /黑名单（优先于白名单）/, '要有黑名单卡片');
  assert.match(src, /listCard\('deny'/, '黑名单走同一个编辑组件');
  // 白名单和黑名单必须共用一套组件，否则两处会渐渐走样
  assert.match(src, /listCard\('allow'/, '白名单也用同一组件');
  const fnStart = src.indexOf('const listCard = ');
  assert.ok(fnStart > 0, '要抽成参数化组件');
});

test('★ 黑名单的状态要和白名单分开存', () => {
  // 共用一个 draft 会让两张卡片互相覆盖
  const src = read('ui/src/views/security.mjs');
  assert.match(src, /draft: \{ allow: null, deny: null \}/, '两套草稿');
  assert.match(src, /hint: \{\}/, '提示按 key 分开');
  assert.match(src, /lastSave: \{\}/, '保存结果按 key 分开');
});

test('★ 界面要说清楚黑名单优先于管理员身份', () => {
  // 不说清楚，管理员会发现自己的私聊也收不到审批，以为坏了
  const src = read('ui/src/views/security.mjs');
  const i = src.indexOf("listCard('deny'");
  const block = src.slice(i, i + 900);
  assert.match(block, /优先级高于白名单/, '要写明优先级');
  assert.match(block, /管理员身份/, '要写明也高于管理员');
});

test('★ 后端要支持写 deny', () => {
  const src = read('src/index.mjs');
  assert.match(src, /key === 'deny'/, '要有 deny 分支');
  const i = src.indexOf("key === 'deny'");
  const block = src.slice(i, i + 700);
  assert.match(block, /normalizeIdLists/, '要复用形状校验');
  assert.match(block, /persistConfig/, '要落盘');
});


/* ------------------------------------------- 人格卡 */

test('★ 人格页不能用 prompt / confirm / alert', () => {
  // 真踩到的坑：新建用的是 window.prompt()，Electron 里它会阻塞/返回 null，
  // 表现就是"点新建没反应"，严重时界面卡死。
  const src = read('ui/src/views/persona.mjs');
  // 去掉注释再检查，避免文档里提到 prompt 就误报
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bwindow\.prompt\s*\(/.test(code), '不能调 window.prompt');
  assert.ok(!/(^|[^.\w])prompt\s*\(/.test(code), '不能调 prompt()');
  assert.ok(!/(^|[^.\w])confirm\s*\(/.test(code), '不能调 confirm()');
  assert.ok(!/(^|[^.\w])alert\s*\(/.test(code), '不能调 alert()');
});

test('★ 新建人格必须走页面内输入框', () => {
  const src = read('ui/src/views/persona.mjs');
  assert.match(src, /creating/, '要有展开状态');
  assert.match(src, /newName/, '要有名字草稿');
  assert.match(src, /给这张卡起个名字/, '要有名称输入框');
  // 状态改成按 kind 分（人格/角色两套），所以这里只断言"调 onCreate 时带了范围"
  assert.match(src, /ctx\.onCreate\?\.\(name, ns\.scope, ns\.scopeId\)/, '要带上作用范围调 onCreate');
});

test('★ 人格卡要支持改名', () => {
  const src = read('ui/src/views/persona.mjs');
  assert.match(src, /nameDraft/, '要有名字草稿');
  assert.match(src, /text: '改名'/, '要有改名按钮');
  assert.match(src, /onSave\?\.\(\{ name: next \}\)/, '改名要带上 name');
  // 切卡后草稿必须清掉，否则会改到上一张（现在按 kind 分开存）
  assert.match(src, /setField\('nameDraft', null\)/, '切卡要清草稿');
});

test('★ 删除要两段式确认，不能直接删', () => {
  const src = read('ui/src/views/persona.mjs');
  assert.match(src, /confirmDelete/, '要有待确认状态');
  assert.match(src, /再点一次/, '要提示再点一次');
});

test('★ 人格页的状态要活在模块作用域', () => {
  const src = read('ui/src/views/persona.mjs');
  const fnStart = src.indexOf('export function renderPersona');
  const before = src.slice(0, fnStart);
  assert.match(before, /const ui = \{/, 'state 在函数外');
  for (const k of ['creating', 'newName', 'nameDraft', 'notice', 'confirmDelete']) {
    assert.ok(before.includes(k), '要有 ' + k + ' 字段');
  }
});

test('★ persona.onSave 要能改名，也要能只存内容', () => {
  const src = read('ui/src/app.mjs');
  const i = src.indexOf('onSave: async (patch = {})');
  assert.ok(i > 0, 'onSave 要接受 patch');
  const block = src.slice(i, i + 1600);
  assert.match(block, /if \(typeof patch\.name === 'string'\) args\.name = patch\.name/, '只在传了名字时才带 name');
  // 草稿现在按 kind 分开存，人格与角色的未保存内容不会互相污染
  assert.match(block, /args\.text = local\.cardDirty\[kind\]/, '内容用草稿');
  assert.match(block, /rerender: \(\) => render\(\)/, '要有 rerender');
});


/* ------------------------------------------- 作用范围 */

test('★ 人格卡要支持三种作用范围', () => {
  const src = read('ui/src/views/security.mjs') + read('ui/src/views/persona.mjs');
  assert.match(src, /global/, '要有全局');
  assert.match(src, /只对这个群/, '要有群范围');
  assert.match(src, /只对这个私聊/, '要有私聊范围');
});

test('★ 人格页里用到的常量必须真的定义过', () => {
  /*
   * 真踩到的坑：SCOPE_LABEL 和 describeScope 只写了使用处，
   * 定义整段被补丁漏掉。页面渲染直接抛 ReferenceError，
   * 而 app 的 catch 把它显示成一张"渲染失败"卡片 ——
   * 表现是"点新建后页面变空白"，跟人格卡逻辑毫无关系。
   *
   * 这里静态扫一遍：凡是用了 SCOPE_LABEL / describeScope 的地方，
   * 文件里必须有对应定义。
   */
  const src = read('ui/src/views/persona.mjs');
  if (src.includes('SCOPE_LABEL')) {
    assert.match(src, /const SCOPE_LABEL = \{/, 'SCOPE_LABEL 必须有定义');
  }
  if (src.includes('describeScope')) {
    assert.match(src, /function describeScope\(/, 'describeScope 必须有定义');
  }
  if (src.includes('ui.scopeDraft')) {
    assert.match(src, /scopeDraft: null/, 'ui.scopeDraft 必须在 ui 里声明');
  }
  if (src.includes('ui.newScope')) {
    assert.match(src, /newScope: \{/, 'ui.newScope 必须在 ui 里声明');
  }
});

test('★ 范围选择器必须是函数声明，不能被提前调用炸掉', () => {
  /*
   * const 箭头函数不提升。scopePicker 被 createForm 和编辑器两处调用，
   * 两处都在它上面，用 const 会撞 TDZ —— 报错信息是
   * "Cannot read properties of undefined"，完全看不出跟顺序有关。
   */
  const src = read('ui/src/views/persona.mjs');
  assert.match(src, /function scopePicker\(opts\) \{/, '要用函数声明（会提升）');
  assert.ok(!/const scopePicker = /.test(src), '不能用 const 箭头函数');
});

test('★ 后端要按会话解析人格卡', () => {
  const src = read('src/llm/persona.mjs');
  assert.match(src, /resolveFor\(convKey\)/, '要有 resolveFor');
  const i = src.indexOf('resolveFor(convKey)');
  const block = src.slice(i, i + 1200);
  // 越具体越优先
  assert.match(block, /private/, '要匹配 private');
  assert.match(block, /group/, '要匹配 group');
  assert.match(block, /#globalCard/, '要回退全局');
});

test('★ 注入点必须按会话取人格，不能再用全局变量', () => {
  // 用全局 persona 等于所有会话共用一张卡 —— 那样"给某个群单独写"不可能实现
  const src = read('src/index.mjs');
  const i = src.indexOf('buildMessages({');
  const block = src.slice(i, i + 500);
  assert.match(block, /personaForConv/, '要传按会话解析出来的文本');
  assert.ok(!/^\s+persona,\s*$/m.test(block), '不能再直接传全局 persona');
});

test('★ 旧人格卡升级后不能丢', () => {
  // 旧卡没有 scope 字段，直接过滤会让用户写的人格全没了
  const src = read('src/llm/persona.mjs');
  const i = src.indexOf('Array.isArray(raw.cards)');
  const block = src.slice(i, i + 700);
  assert.match(block, /normalizeScope\(c\.scope\)/, '要补 scope');
  assert.match(block, /scopeId/, '要补 scopeId');
});

test('★ 同一个群不能有两张专属人格', () => {
  // 两张都匹配 group:123 时该用哪张没有合理答案，
  // 变成"取决于添加顺序"就是不确定性，应该在写入时挡掉
  const src = read('src/llm/persona.mjs');
  const i = src.indexOf('async create(');
  const block = src.slice(i, i + 1800);
  // 文案现在由 CardStore 的 label 拼出来（人格 / 角色 共用），所以匹配到 label 之前就行
  assert.match(block, /已经有一张专属/, '要拒绝重复占用');
  assert.match(block, /\$\{this\.label\}/, '文案要跟着 label 走，不能写死「人格」');
});


/* ------------------------------------------- 人格与角色分开 */

test('★ 人格和角色必须各自独立存储', () => {
  /*
   * 「人格」= 它是谁（性格、说话风格）
   * 「角色」= 它在什么场景扮演什么（群聊参与者 / 私聊助手 / 客服）
   *
   * 两者正交。如果塞进同一张卡，"换人格"就会把角色一起换掉，
   * 用户会觉得别扭但说不清哪里不对。
   *
   * 独立存储的最低要求：两个不同的文件 + 两个独立的 activeId。
   */
  const paths = read('src/config/paths.mjs');
  assert.match(paths, /personaPath/, '要有人格文件');
  assert.match(paths, /rolePath/, '要有角色文件');

  const store = read('src/llm/persona.mjs');
  assert.match(store, /export class CardStore/, '要抽出通用卡仓库');
  assert.match(store, /export class PersonaStore extends CardStore/, '人格是一份');
  assert.match(store, /export class RoleStore extends CardStore/, '角色是一份');

  // 两套卡在 id 前缀上要能区分，看日志时不用猜
  assert.match(store, /idPrefix: 'p_'/, '人格用 p_ 前缀');
  assert.match(store, /idPrefix: 'r_'/, '角色用 r_ 前缀');
});

test('★ 角色卡要能独立切换，且动作前缀是 role.', () => {
  const src = read('src/index.mjs');
  for (const act of ['role.create', 'role.update', 'role.activate', 'role.delete', 'role.duplicate']) {
    assert.ok(src.includes(`'${act}'`), '后端要有 ' + act);
  }
  assert.match(src, /roleCards: roleStore\.view/, '快照要带 roleCards');
});

test('★ 角色必须按会话注入，和人格各解析各的', () => {
  const src = read('src/index.mjs');
  const i = src.indexOf('const roleForConv');
  assert.ok(i > 0, '要有 roleForConv');
  assert.match(src.slice(i, i + 400), /roleStore\.resolveFor\(convKey\)/, '角色也要按会话解析');
  // 注入点要同时传两个
  const j = src.indexOf('buildMessages({');
  const block = src.slice(j, j + 500);
  assert.match(block, /persona: personaForConv/, '要传人格');
  assert.match(block, /role: roleForConv/, '要传角色');
});

test('★ 提示里人格与角色要分成两段', () => {
  const src = read('src/llm/prompt.mjs');
  assert.match(src, /# 你的人格（用户可编辑）/, '要有人格段');
  assert.match(src, /# 你的角色（用户可编辑）/, '要有角色段');
  // 人格在前、角色在后：先建立人物形象，再说这一场该干什么
  assert.ok(
    src.indexOf('# 你的人格') < src.indexOf('# 你的角色'),
    '人格段要在角色段之前',
  );
  // 默认角色要分群聊/私聊两套 —— 这正是角色层存在的理由
  assert.match(src, /DEFAULT_ROLE_GROUP/, '要有群聊默认角色');
  assert.match(src, /DEFAULT_ROLE_PRIVATE/, '要有私聊默认角色');
});

test('★ 人格与角色的编辑草稿不能共用', () => {
  // 共用一份草稿的话，"改了人格没保存就切到角色"会把人格内容写进角色卡
  const src = read('ui/src/app.mjs');
  assert.match(src, /cardDraft: \{\}/, '草稿要按 kind 分开');
  assert.match(src, /cardDirty: \{\}/, '脏标记要按 kind 分开');
  assert.match(src, /local\.cardDraft\[kind\]/, '要按 kind 取草稿');
  assert.ok(!/local\.personaDirty/.test(src), '不能再有全局共用的 personaDirty');
});

test('★ 人物页用顶部标签切换，不用左右分栏', () => {
  const src = read('ui/src/views/persona.mjs');
  assert.match(src, /seg-btn/, '要有分段控件');
  assert.match(src, /ctx\.onTab\?\.\('persona'\)/, '要能切到人格');
  assert.match(src, /ctx\.onTab\?\.\('role'\)/, '要能切到角色');
  // 用户的诉求是"从上到下"，所以不能再用两栏布局
  assert.ok(!/class: 'persona-cols'/.test(src), '不能再用左右两栏');
});


/* ------------------------------------------- 图标设置 */

test('★ 图标设置要在系统安全页里，能上传也能恢复默认', () => {
  const sec = read('ui/src/views/security.mjs');
  const icons = read('ui/src/views/icons.mjs');

  // 入口在系统安全页：用户在自己的配置里就能找到，不用多记一个页面
  assert.match(sec, /renderIconCards/, '系统安全页要挂图标卡片');

  // 上传 / 恢复默认 / 当前状态，三个能力都要有
  assert.match(icons, /uploadIcon/, '要能上传');
  assert.match(icons, /resetIcon/, '要能恢复默认');
  assert.match(icons, /iconStatus/, '要知道当前是不是自定义的');

  // 尺寸要求写在界面上：用户想自己准备图时不用翻源码
  assert.match(icons, /256×256/, '要写窗口图标尺寸');
  assert.match(icons, /32×32/, '要写托盘图标尺寸');
  assert.match(icons, /512×512/, '要写打包用尺寸');
});

test('★ 图标状态要活在模块作用域', () => {
  // 快照每 2 秒重绘，局部变量会跟着 DOM 一起消失
  const src = read('ui/src/views/icons.mjs');
  const fnStart = src.indexOf('export function renderIconCards');
  const before = src.slice(0, fnStart);
  assert.match(before, /const ui = \{/, 'state 在函数外');
  for (const k of ['status', 'notice', 'busy']) {
    assert.ok(before.includes(k), '要有 ' + k + ' 字段');
  }
});

test('★ 自定义图标必须能回落到内置图标', () => {
  const icons = read('electron/icons.mjs');
  assert.match(icons, /export function pickIconPath/, '要有回落逻辑');
  assert.match(icons, /customPath/, '要区分自定义');
  assert.match(icons, /builtinPath/, '要区分内置默认');
  // 校验函数自己抛错时也不能把异常冒出去 —— 否则图标坏掉会连带启动失败
  assert.match(icons, /catch \{[\s\S]{0,120}return builtinPath/, '校验出错也要回落');

  const main = read('electron/main.mjs');
  assert.match(main, /customIconPath\(resolvePaths\(\)\.root/, '自定义图标放数据目录');
  assert.ok(!/customIconPath\(process\.cwd\(\)/.test(main), '不能用 cwd 算路径');
});

test('★ 启动器 exe 要嵌入图标，否则任务栏换不掉', () => {
  /*
   * 实际踩到的坑：只改 BrowserWindow({icon}) 之后，窗口图标变了，
   * 但任务栏上"固定的那一项"还是旧图标 —— 因为那用的是 exe 里嵌的资源。
   */
  const build = read('scripts/build-launcher.mjs');
  assert.match(build, /win32icon/, '要嵌 exe 图标');
  assert.match(build, /assets', 'icon\.ico'/, '用 assets/icon.ico');
  // ico 不存在时不能阻断构建
  assert.match(build, /existsSync\(icoPath\)/, '图标缺失不能让编译失败');
});
