/**
 * 提交前凭据扫描 —— 防止密钥被误传上 Git。
 *
 * 为什么要有这一步：
 * 凭据一旦进了 git 历史，删文件是没用的——历史里还在。
 * 清理历史很麻烦（rewrite + gc），而且如果已经 push 过，等于已经泄露。
 * 所以**在提交前拦住**是唯一成本低的时机。
 *
 * 检查两处：
 *   1. 工作区里**即将被提交的内容**（git 索引）
 *   2. 仓库里所有被跟踪的文件
 *
 * 用法：node scripts/scan-secrets.mjs
 * 退出码：0 干净 / 1 发现疑似凭据
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 判定规则。
 *
 * 刻意不写成"匹配到 sk- 就报错"——文档里出现 `sk-` 字样是正常的，
 * 误报会让人习惯性忽略这个检查，那它就失效了。
 * 这里只抓**像真凭据**的形状：够长的连续随机串。
 */
const RULES = [
  // OpenAI / DeepSeek 风格：sk- 后跟 32 位以上
  { name: 'API Key（sk-…）', re: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  // 其他常见前缀
  { name: 'API Key（ak-/key-…）', re: /\b(?:ak|key)-[A-Za-z0-9]{32,}\b/g },
  // 通用长随机串（32+ 位十六进制），但排除明显是哈希/占位的
  { name: '长十六进制串', re: /\b[0-9a-f]{40,}\b/gi },
  // Authorization 头里带真值
  { name: 'Authorization 头', re: /authorization\s*[:=]\s*["']?(?:Bearer|token)\s+[A-Za-z0-9._-]{20,}/gi },
  /*
   * 长 base64url 串（40+ 位，含大小写字母与数字）。
   *
   * 为什么单独一条：本项目的 OneBot token 就是 43 字符的 base64url，
   * 含 - 和 _。原来的 [0-9a-f]{40,} 只认十六进制，恰好把它漏掉 ——
   * 真实泄露过一次的两个 token 就属于这种形状。
   */
  // 要求同时含大小写和数字，且混入 -/_ —— 纯连字符（CSS 分隔线）和纯小写（单词）都不算
  { name: '长 base64url 串', re: /(?<![\w-])(?=[A-Za-z0-9_-]{40,}(?![\w-]))(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)(?=[^\s]*[-_])[A-Za-z0-9_-]{40,}(?![\w-])/g },
];

/**
 * 中转站 / 第三方 API 域名。
 *
 * 为什么这条重要：一个自建或小众中转站的域名，比 API key 更能定位到具体的人。
 * 公开服务商放行，其余一律报 —— 让用户自己确认"这个域名要不要出现在公开仓库里"。
 */
const PUBLIC_API_HOSTS = [
  'api.deepseek.com',
  'api.openai.com',
  'api.anthropic.com',
  'api.moonshot.cn',
  'api.siliconflow.cn',
  'open.bigmodel.cn',
  'dashscope.aliyuncs.com',
  'generativelanguage.googleapis.com',
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  // GitHub Releases 资产的下载域：SnowLuma 的直链落在这里
  'objects.githubusercontent.com',
  'gitee.com',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'example.com',
  'example.org',
  'schemas.microsoft.com',
  'w3.org',
  'nodejs.org',
  'electronjs.org',
  'npmmirror.com',
  'registry.npmjs.org',
  'npmjs.com',
  'schema.tauri.app',
  // README 中的官方运行环境和构建工具文档
  'microsoft.com',
  'visualstudio.com',
  'rust-lang.org',
  'tauri.app',
];

/**
 * 判断一个主机名是不是"公开服务商或明显占位"。
 *
 * @param {string} host
 * @returns {boolean}
 */
function isPublicHost(host) {
  const h = host.toLowerCase();
  if (PUBLIC_API_HOSTS.some((x) => h === x || h.endsWith('.' + x))) return true;
  /*
   * 明显的占位域名。测试里必须能写"某个奇怪的域名"，否则规则没法测。
   *
   * 判据是"一眼就知道是编的"：单字母、连写 x、常见假名，
   * 以及 x.com / a.com 这类单字母域名（真实服务不会只有一位）。
   */
  if (/^(x|a|b|t|new|old|evil|foo|bar|baz|host)$/.test(h)) return true;
  /*
   * `evil*` 开头的域名视为反例占位。
   *
   * 白名单校验的测试里必须能写一个"后缀相近但不同域"的地址
   * （例如 evilnodejs.org 用来证明 ends_with(".nodejs.org") 不会误放行）。
   * 这类名字一眼就是编的：没有真实服务会把 evil 放在域名开头。
   */
  if (/^evil[a-z0-9-]*\./.test(h)) return true;
  if (/^(?:[a-z]|x{2,}|example|test|foo|bar|baz|s{2,})\.(?:com|cn|net|org|io|dev|local|test)$/.test(h)) return true;
  if (/^(?:api\.)?(?:x{2,}|example|test|foo|bar)\./.test(h)) return true;
  // 内网 / 回环地址：不含身份信息，且测试要用
  if (/^(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(h)) return true;
  /*
   * RFC 2606 / RFC 6761 保留的"永不可解析"顶级域与二级域：
   *   .invalid / .test / .example / .localhost
   * 它们的存在意义就是"保证不是真实主机"，测试里用它最规范，
   * 也该被认成占位 —— 否则 fake.invalid 这种反而过不了检查。
   */
  if (/\.(?:invalid|test|example|localhost)$/.test(h)) return true;
  // 测试用的短主机名（无点）
  if (!h.includes('.')) return true;
  return false;
}

/**
 * QQ 号检测 —— 单独一条，因为它和上面几条的判定逻辑不一样。
 *
 * ## 为什么不能简单地"匹配 5–12 位数字"
 *
 * 那种规则会把版本号、端口、时间戳、行号、哈希全部打上标记，
 * 于是每次提交都有一堆误报 —— 一旦人开始习惯性忽略这个检查，它就废了。
 * 所以这里**只在明确的上下文中**才判为 QQ 号：
 *
 *   · `group:<数字>` / `private:<数字>`  —— 会话 key
 *   · `QQ号` / `qq号` / `ownerQQ` 等字样后面的数字
 *   · `admins` / `管理员` 列表里的数字
 *
 * ## 为什么下限是 6 位
 *
 * 真实 QQ 号最短是 6 位（早期号段）到 11 位。5 位及以下一律是测试占位
 * （10001、12345 这种）——把它们也算进来，只会制造误报。
 *
 * ## 什么号算"真实"
 *
 * 明显的假号放行（`100000001`、全 0、全 1、连号……），因为测试要用。
 * 真号一律拦：它们是**环境数据**，不该出现在仓库里。
 */
const QQ_CONTEXT = [
  // group:123456 / private:123456
  /(?:group|private)\s*:\s*['"`]?(\d{6,12})\b/g,
  // QQ号 / qq号 / QQ 号 / 群号 / ownerQQ / setupQQ / targetQQ
  /(?:QQ|qq)\s*号?\s*[:：=]\s*['"`]?(\d{6,12})\b/g,
  /(?:ownerQQ|setupQQ|targetQQ|adminQQ|botQQ)\s*[:=]\s*['"`]?(\d{6,12})\b/g,
  /(?:群号|群)\s*[:：=]\s*['"`]?(\d{6,12})\b/g,
  // admins: ['123456'] / admins: "123456,234567"
  /(?:admins?)\s*[:=]\s*\[?['"`]?(\d{6,12})\b/gi,
];

/**
 * 明显的假号：测试用的占位数字。命中就放行。
 *
 * 判断依据是"看起来不像真实分配的号"，不是"我知道哪个号是真的"——
 * 后者会让这条规则随环境变化，那就没法进仓库了。
 */
function looksFakeQQ(num) {
  const s = String(num);
  if (/^(.)\1+$/.test(s)) return true; // 111111、000000
  if (/^0+$/.test(s)) return true;
  // 100000000 这类整十整百的占位
  if (/^1(0{6,})1?$/.test(s)) return true;
  /*
   * 100000001 / 100000002 / 100000003 这类"1 后面一串 0 再跟个位"的编号。
   *
   * 它们是测试与文档里最常用的假号形状（好认、好递增），但真实 QQ 号
   * 也存在这个号段 —— 所以不能一概放行。这里的判据是**结构上明显是生成的**：
   * 1 开头、中间至少 6 个连续 0、末尾是 1~9 的个位数。
   * 真实分配的号几乎不可能长这样，而手写的占位符恰恰都长这样。
   */
  if (/^1(0{6,})[1-9]$/.test(s)) return true;
  // 明显递增/递减：123456、1234567、987654
  // 连号只在"短串"时才算假。
  // 理由：123456 是人手打的占位；但 12345678 已经和真实号一样长，
  // 认定成假号就可能放过真号——宁可误报，也不能漏。
  const digits = s.split('').map(Number);
  const asc = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const desc = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if ((asc || desc) && s.length <= 7) return true;
  // 常见的测试占位段：1000x、1234x、66666 等
  if (/^1000\d$/.test(s)) return true;
  if (/^(\d)\1{4,}$/.test(s)) return true;
  return false;
}

/**
 * 白名单：这些文件本来就要讲"密钥长什么样"。
 *
 * 只有扫描器自己 —— 它的正则字面量就是密钥形状。
 *
 * ⚠️ **不要再往里加文档**。早先这里排除了 DECISIONS.md，
 * 理由是"它本来就在讲 token 事件"。那是逻辑倒置：
 * 正因为某个文件在讲密钥，它才最该被扫。
 * 结果就是真号真 token 躺在那份文件里、而检查显示通过。
 */
const ALLOW_FILES = new Set(['scripts/scan-secrets.mjs']);

/** 占位符/示例值不算泄露 */
const PLACEHOLDER = /(x{8,}|0{8,}|\.{3,}|<[^>]+>|YOUR_|EXAMPLE|PLACEHOLDER|已移除|示例)/i;

/**
 * @param {string} text
 * @returns {Array<{rule: string, sample: string, line: number}>}
 */
function scanText(text, opts = {}) {
  // 文件级豁免：只对 QQ 号规则生效，且必须在文件里显式写标记。
  // 用在"测试样例必须长得像真号"的场合。凭据规则不接受豁免。
  const allowQQ = text.includes('scan-secrets:allow-qq');
  /** @type {Array<{rule: string, sample: string, line: number}>} */
  const hits = [];
  const lines = text.split('\n');

  outer: for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(line);
      if (!m) continue;
      if (PLACEHOLDER.test(line)) continue;
      // 包完整性哈希是公开值，不是凭据（sha512-/sha256- 后跟 base64）
      if (/\bsha(?:256|384|512)-/.test(m[0]) || /\bsha(?:256|384|512)-/.test(line)) continue;
      /*
       * Cargo 校验和同样是公开值：Cargo.lock 里每个 crate 一行 `checksum = "<64 hex>"`，
       * 它校验的是 crates.io 上的包内容，泄露了也没有任何权限含义。
       * 不豁免的话会一次报出几百条，把真正的凭据问题淹没掉。
       */
      if (/^\s*checksum\s*=\s*"[0-9a-f]{64}"\s*$/i.test(line)) continue;
      hits.push({
        rule: rule.name,
        // 只显示前 6 位，避免把凭据打印到终端/日志里
        sample: `${m[0].slice(0, 6)}…（长 ${m[0].length}）`,
        line: i + 1,
      });
    }

    /*
     * 域名：中转站规则。
     *
     * 这里**不接受任何文件级豁免** —— 域名恰恰是文档里最容易写出来的东西。
     */
    for (const dm of line.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
      if (!isPublicHost(dm[1])) {
        hits.push({ rule: '疑似中转站/私有域名', sample: dm[1], line: i + 1 });
      }
    }

    /*
     * QQ 号：只在明确上下文里判，避免误报把检查变成噪音。
     *
     * allowQQ 豁免的范围已经收窄：它只跳过"上下文规则"这一段，
     * 上面的域名规则和凭据规则**不受豁免影响**。
     */
    if (allowQQ) continue outer;
    for (const re of QQ_CONTEXT) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const num = m[1];
        if (!num || looksFakeQQ(num)) continue;
        // 注释里"例如 12345678"这种是举例，不算
        if (PLACEHOLDER.test(line)) continue;
        hits.push({
          rule: '疑似真实 QQ 号',
          // 打码：只留前 2 后 2，中间星号
          sample: `${num.slice(0, 2)}****${num.slice(-2)}`,
          line: i + 1,
        });
      }
    }
  }
  return hits;
}

function main() {
  // 必须关掉路径转义：默认 git 会把中文路径输出成 "\345\274\200..."，
  // 那样 `git show :<path>` 会失败 → 中文名的文件被静默跳过 →
  // 检查给出"通过"的假绿灯。文档恰恰是最可能写出密钥的地方，不能漏。
  const GIT = ['-c', 'core.quotePath=false'];

  /** @type {string[]} */
  const files = execFileSync('git', [...GIT, 'ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  let bad = 0;
  let scanned = 0;
  let skipped = 0;

  for (const f of files) {
    if (ALLOW_FILES.has(f)) continue;
    // 二进制文件跳过
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|exe|asar)$/i.test(f)) continue;

    let text;
    try {
      text = execFileSync('git', [...GIT, 'show', `:${f}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // 读不出来必须计数并报错，不能当成"没问题"
      console.error(`⚠ 跳过（读不出内容）：${f}`);
      skipped += 1;
      continue;
    }
    scanned += 1;

    const hits = scanText(text);
    for (const h of hits) {
      console.error(`✖ ${f}:${h.line} 命中「${h.rule}」 ${h.sample}`);
      bad += 1;
    }
  }

  if (bad > 0) {
    console.error(`\n✖ 发现 ${bad} 处疑似凭据。**不要提交**，先移除或改成占位符。`);
    console.error('  如果已经提交过：需要改写历史（git filter-branch / git-filter-repo）后 gc --prune=now。');
    process.exit(1);
  }

  if (skipped > 0) {
    console.error(`\n✖ 有 ${skipped} 个文件没能读取，检查不完整，不能算通过。`);
    process.exit(1);
  }

  console.log(`✓ 凭据扫描通过（检查了 ${scanned} 个文件）`);
}

main();
