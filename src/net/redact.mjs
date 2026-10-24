/** 移除上游回显的敏感值；同时覆盖 URL 编码和 JSON 转义写法。 */
export function redactText(value, secret) {
  let text = String(value ?? '');
  if (!secret) return text;
  const forms = new Set([
    secret, encodeURIComponent(secret), encodeURI(secret),
    JSON.stringify(secret).slice(1, -1),
  ]);
  for (const form of forms) {
    if (form) text = text.split(form).join('[REDACTED]');
  }
  return text;
}

/** 只遍历可序列化值；密钥不能通过标题、摘要、查询回显或错误体返回模型。 */
export function redactValue(value, secret) {
  if (typeof value === 'string') return redactText(value, secret);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secret)]));
  }
  return value;
}
