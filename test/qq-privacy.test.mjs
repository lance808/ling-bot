/**
 * 凭据扫描里的 QQ 号规则
 *
 * ## 为什么值得单独测
 *
 * 这条规则有两个方向都会坏：
 *
 *   · **太松** → 真号进仓库。这是它存在的唯一理由，松了就白做。
 *   · **太紧** → 版本号、端口、假号全被打上标记。每次提交一堆红字，
 *     人很快就开始习惯性忽略这个检查 —— 那时它比没有更糟，因为
 *     你会以为它是绿的。
 *
 * 所以两侧都要钉住：该抓的抓，该放的放。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 复刻 scan-secrets.mjs 里的规则。
 *
 * 刻意复制而不是 import：那个文件是脚本，import 会直接执行扫描并
 * `process.exit`，没法当库用。代价是规则改了两边要同步——所以
 * 下面另有一条测试检查两边的特征是否一致。
 *
 * ⚠️ 下面的样例号全部是**构造的**，不对应任何真实账号。
 *
 * 这类测试曾经用过真实号并加 `scan-secrets:allow-qq` 豁免整个文件 ——
 * 那是错的：豁免让扫描器把**整个文件**的 QQ 号检测关掉，真号就是这样
 * 混进来的。测规则不需要真号，"看起来像真号"就够：只要是 6~11 位、
 * 不是连号/整十/纯重复的普通数字串，规则分不清真假，测试照样有效。
 */
const QQ_CONTEXT = [
  /(?:group|private)\s*:\s*['"`]?(\d{6,12})\b/g,
  /(?:QQ|qq)\s*号?\s*[:：=]\s*['"`]?(\d{6,12})\b/g,
  /(?:ownerQQ|setupQQ|targetQQ|adminQQ|botQQ)\s*[:=]\s*['"`]?(\d{6,12})\b/g,
  /(?:群号|群)\s*[:：=]\s*['"`]?(\d{6,12})\b/g,
  /(?:admins?)\s*[:=]\s*\[?['"`]?(\d{6,12})\b/gi,
];

/** 与 scan-secrets.mjs 的 looksFakeQQ 保持一致 */
function looksFakeQQ(num) {
  const s = String(num);
  if (/^(.)\1+$/.test(s)) return true;
  if (/^0+$/.test(s)) return true;
  if (/^1(0{6,})1?$/.test(s)) return true;
  const d = s.split('').map(Number);
  // 连号只在短串时算假：长号即便是连号也可能是真号，宁可误报
  const asc = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const desc = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  if ((asc || desc) && s.length <= 7) return true;
  if (/^1000\d$/.test(s)) return true;
  if (/^(\d)\1{4,}$/.test(s)) return true;
  return false;
}

/** @param {string} line */
function findRealQQ(line) {
  const found = [];
  for (const re of QQ_CONTEXT) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (!looksFakeQQ(m[1])) found.push(m[1]);
    }
  }
  return found;
}

/* ---------------------------------------------------------------- 该抓 */

test('★ 会话 key 里的真实号会被抓到', () => {
  assert.ok(findRealQQ("convKey: 'group:369912345'").length > 0);
  assert.ok(findRealQQ('private:12345678').length > 0);
});

test('★ 管理员列表里的真实号会被抓到', () => {
  assert.ok(findRealQQ("const admins = ['155266789'];").length > 0);
  assert.ok(findRealQQ('admins: "139785234,155266789"').length > 0);
});

test('★ ownerQQ 之类的字段名会被抓到', () => {
  assert.ok(findRealQQ("ownerQQ: '139785234'").length > 0);
  assert.ok(findRealQQ("setupQQ: '155266789'").length > 0);
});

test('中文「群号」后面的数字会被抓到', () => {
  assert.ok(findRealQQ('群号：369912345').length > 0);
});

/* ---------------------------------------------------------------- 该放 */

test('★ 明显的假号必须放行（否则测试没法写）', () => {
  assert.equal(findRealQQ("const admins = ['10001']").length, 0, '5 位数一律是占位');
  assert.equal(findRealQQ("groups: ['100000001']").length, 0);
  assert.equal(findRealQQ('group:123456').length, 0, '短连号是假的');
  // 8 位以上的连号当真实号处理：宁可误报也不漏
  assert.ok(findRealQQ('private:12345678').length > 0, '长连号仍要报');
  assert.equal(findRealQQ('group:11111111').length, 0, '全同号是假的');
});

test('★ 版本号/端口不能被当成 QQ 号', () => {
  assert.equal(findRealQQ("version: '0.2.0-r3'").length, 0);
  assert.equal(findRealQQ('port: 3458').length, 0);
  assert.equal(findRealQQ('timeout: 120000').length, 0);
});

test('没有上下文的裸数字不算', () => {
  // 时间戳、行号、哈希都长这样，不能一律报警
  assert.equal(findRealQQ('elapsed: 1729300000').length, 0);
  assert.equal(findRealQQ('sha: a3f9c2d1e8b7').length, 0);
});

/* ---------------------------------------------------------------- 一致性 */

test('★ 这里的规则和 scan-secrets.mjs 的完全一致（改一边必须改另一边）', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../scripts/scan-secrets.mjs', import.meta.url), 'utf8');

  // 抓出脚本里 QQ_CONTEXT 数组的字面量
  const block = src.slice(src.indexOf('const QQ_CONTEXT = ['), src.indexOf('];', src.indexOf('const QQ_CONTEXT = [')));
  // 每个正则里必须都是 {6,12}，不能有 {5,
  assert.equal(/\{5,/.test(block), false, '下限必须是 6 位');

  // 更要紧的是：脚本里的 5 条规则确实都在，且下限是 6 位。
  // 不去数行数（注释里的示例行会把计数搞乱），而是逐条核对特征。
  const markers = [
    'group|private',      // 会话 key
    'QQ|qq',              // QQ 号字样
    'ownerQQ|setupQQ',    // 字段名
    '群号|群',             // 中文
    'admins?',            // 管理员列表
  ];
  for (const marker of markers) {
    assert.ok(block.includes(marker), `scan-secrets.mjs 的 QQ_CONTEXT 少了这条规则：${marker}`);
  }

  // looksFakeQQ 的关键判定要都在
  const fake = src.slice(src.indexOf('function looksFakeQQ'), src.indexOf('function looksFakeQQ') + 800);
  for (const marker of ['(.)\\1+', '0+', 'asc || desc']) {
    assert.ok(fake.includes(marker), `looksFakeQQ 少了判定：${marker}`);
  }
});
