/** Action failures are explicit values; snapshot failures retain their rejection. */
export async function resultOf(operation) {
  try {
    const result = await operation();
    return result && typeof result.ok === 'boolean' ? result : { ok: false, message: '接口未返回有效结果' };
  } catch (error) {
    return { ok: false, code: error?.code, message: String(error?.message ?? error) };
  }
}

export function snapshotQuery({ convKey = null, days = 1, before = null } = {}) {
  return { thinking: { convKey, days, limit: 50, before } };
}

export function usageQuery(range = '24h', now = Date.now()) {
  const hours = { '24h': 24, '3d': 72, '7d': 168, '30d': 720 }[range] ?? 24;
  return { since: now - hours * 3600000, until: now };
}

export function usageAggregate(range) {
  if (!range) return null;
  const number = (n) => Number.isFinite(Number(n)) ? Number(n) : 0;
  const calls = number(range.calls);
  const denominator = number(range.cachePromptTokens);
  const cached = number(range.cachedTokens);
  return {
    calls, prompt: number(range.promptTokens), completion: number(range.completionTokens), total: number(range.totalTokens),
    estimated: number(range.estimatedCalls), cached, cacheReported: number(range.cacheReported),
    hitRate: denominator > 0 && range.cacheReported > 0 ? Math.round(cached / denominator * 100) : null,
    missTokens: Math.max(0, denominator - cached),
  };
}
