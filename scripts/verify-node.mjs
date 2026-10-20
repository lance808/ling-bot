/**
 * Node 版本校验 —— DECISIONS §1.1
 *
 * `engines` 不匹配时 npm 只警告不阻断，会埋下「构建过、运行炸」的隐患。
 * 所以这里**主动失败**：主版本不是 24 就直接退出非零。
 */

const REQUIRED_MAJOR = 24;
const REQUIRED_MINOR = 22;
const REQUIRED_PATCH = 0;

const [major, minor, patch] = process.versions.node.split('.').map(Number);

const ok = major === REQUIRED_MAJOR && (minor > REQUIRED_MINOR || (minor === REQUIRED_MINOR && patch >= REQUIRED_PATCH));

if (!ok) {
  console.error(
    [
      '',
      '✖ Node 版本不符合项目基线',
      `  当前：v${process.versions.node}`,
      `  要求：>= v${REQUIRED_MAJOR}.${REQUIRED_MINOR}.${REQUIRED_PATCH} < v25（SnowLuma 2.0 要求 >= 24）`,
      '',
      '  engines 不匹配时 npm 只警告不阻断，这正是「构建过、运行炸」的来源。',
      '  请用版本管理器切到 24.22.x（见 .nvmrc）。',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`✓ Node v${process.versions.node} 符合基线（>= v${REQUIRED_MAJOR}.${REQUIRED_MINOR}.${REQUIRED_PATCH} < v25）`);
