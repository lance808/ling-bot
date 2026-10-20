/** Validate a complete DSH transaction without mutating the current configuration. */
export function normalizeDsh(value, previous = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH配置必须是对象');
  if (Object.keys(value).some(k => !['enabled', 'port', 'token', 'admins', 'sessionId', 'clearToken'].includes(k))) throw new Error('DSH配置包含未知字段');
  if (typeof value.enabled !== 'boolean') throw new Error('enabled必须是布尔值');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('port必须为1–65535的整数');
  if (typeof value.token !== 'string' || typeof value.sessionId !== 'string' || !Array.isArray(value.admins)) throw new Error('DSH字段类型不正确');
  const admins = [...new Set(value.admins.map(v => String(v).trim()))];
  if (admins.some(v => !/^\d{4,15}$/.test(v))) throw new Error('管理员号码应为4–15位数字');
  const token = value.clearToken === true ? '' : value.token.trim() || previous.token || '';
  if (value.enabled && (!token || !admins.length)) throw new Error('启用DSH需要令牌和管理员');
  if (value.sessionId.length > 512 || token.length > 4096) throw new Error('DSH字段过长');
  return { enabled: value.enabled, port: value.port, token, admins, sessionId: value.sessionId.trim() };
}
