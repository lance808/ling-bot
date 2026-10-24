import { createHash } from 'node:crypto';

export const DEFAULTS = Object.freeze({
  apiUrl: '', model: '', size: '1024x1024', count: 1, timeoutMs: 180000,
  approvalTtlMs: 600000, concurrency: 1, maxPending: 20, maxPerRequester: 3,
  requestsPerHour: 10, imagesPerDay: 30, maxImageBytes: 10485760,
  maxStorageBytes: 524288000, retentionDays: 7, maxTasks: 1000,
  deliveryAttempts: 3, deliveryRetryMs: 30000,
});
export function parseAdmins(raw) {
  return [...new Set(String(raw ?? '').split(/[,，、\s]+/).filter((s) => /^\d{4,15}$/.test(s)))];
}
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS, ...raw };
  c.admins = parseAdmins(raw.admins);
  for (const [key, min, max] of [
    ['count',1,8], ['timeoutMs',100,600000], ['approvalTtlMs',1000,86400000],
    ['concurrency',1,4], ['maxPending',1,100], ['maxPerRequester',1,20],
    ['requestsPerHour',1,100], ['imagesPerDay',1,1000], ['maxImageBytes',1024,10485760],
    ['maxStorageBytes',1048576,2147483648], ['retentionDays',1,90], ['maxTasks',20,10000],
    ['deliveryAttempts',1,10], ['deliveryRetryMs',100,3600000],
  ]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数`);
  }
  c.apiUrl = String(c.apiUrl ?? '').trim().replace(/\/+$/, '');
  if (c.apiUrl) {
    const u = new URL(c.apiUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('API 地址只接受无凭据、查询与片段的 HTTP(S) URL');
  }
  c.model = String(c.model ?? '').trim();
  c.size = String(c.size ?? '').trim();
  if (c.model.length > 120 || !/^(?:auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(c.size)) throw new Error('模型最长120字符，尺寸须为 auto 或 1024x1024 形式');
  return c;
}
export function parameterSnapshot(c, args) {
  const prompt = String(args?.prompt ?? '').trim();
  if (!prompt || prompt.length > 4000) throw new Error('prompt 必须为1–4000字符');
  const count = args?.count ?? c.count;
  if (!Number.isInteger(count) || count < 1 || count > c.count) throw new Error(`张数必须为1–${c.count}（管理员配置上限）`);
  // 模型与尺寸仅管理员配置；模型不能把本次审批变成任意提供商调用。
  return { apiUrl: c.apiUrl, model: c.model, size: c.size, count, prompt,
    timeoutMs: c.timeoutMs, maxImageBytes: c.maxImageBytes };
}
export const snapshotDigest = (s) => createHash('sha256').update(JSON.stringify(s)).digest('hex');
