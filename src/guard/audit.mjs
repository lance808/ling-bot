/**
 * 出站审计（L4 兜底）—— F9
 *
 * 注意定位：引入工具之后，出站审计**不再是最重要的那道防线**。
 * 它拦不住 `rm -rf D:/work`（正文里没有任何敏感特征），
 * 真正的重心在 L2 授权（guard/tool-gate.mjs）。
 *
 * 它仍然有用：防止模型把本机路径、凭据、令牌念到 QQ 群里。
 * 命中即**整条不发**，不做"打码后照发"。
 */

/** 本机路径特征：盘符路径 / UNC / 常见 Unix home */
const PATH_PATTERNS = [
  /[A-Za-z]:\\[^\s"'`]{2,}/g,
  /\\\\[^\s"'`\\]+\\[^\s"'`]{1,}/g,
  /\/(?:home|Users)\/[^\s"'`/]{1,}/g,
];

/** 凭据特征：赋值形态、私钥头、带凭据 URL */
const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|clientkey)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/g,
];

/**
 * @param {string} text
 * @returns {{ok: boolean, code?: string, message?: string, hits?: string[]}}
 */
export function auditOutbound(text) {
  const value = String(text ?? '');
  /** @type {string[]} */
  const hits = [];

  for (const re of PATH_PATTERNS) {
    re.lastIndex = 0;
    const m = value.match(re);
    if (m) hits.push(...m.slice(0, 3));
  }
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const m = value.match(re);
    if (m) hits.push(...m.slice(0, 3));
  }

  if (hits.length > 0) {
    return {
      ok: false,
      code: 'E2020',
      message: '消息含本机路径或凭据特征，已拦截不发',
      hits,
    };
  }
  return { ok: true };
}

/**
 * 脱敏（用于日志、错误信息、诊断包、工具结果回灌）。
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => (m.startsWith('-----') ? '-----BEGIN PRIVATE KEY-----<已脱敏>' : '<已脱敏>'));
  }
  // 令牌只留前 4 位
  out = out.replace(/\b([A-Za-z0-9]{4})[A-Za-z0-9_\-]{20,}\b/g, '$1<已脱敏>');
  return out;
}

/**
 * 掩码显示（界面用）。
 *
 * @param {string} secret
 * @returns {string}
 */
export function maskSecret(secret) {
  const s = String(secret ?? '');
  if (s.length === 0) return '（未设置）';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, s.length - 4))}（${s.length} 位）`;
}
