/** Clear persisted sources; never turn a failed deletion into a success. */
export async function clearApiKey({ config, vaultPath, unlink, persist, envKey = '' }) {
  try { await unlink(vaultPath); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, source: 'unchanged', code: 'E4102', message: '凭据文件删除失败，凭据尚未清除' }; }
  const next = { ...config, llm: { ...config.llm, apiKey: '' } };
  try { await persist(next); } catch { return { ok: false, source: config.llm.apiKey ? 'config' : 'none', code: 'E4102', message: '兼容配置清除失败，重启后可能仍使用旧凭据' }; }
  return { ok: !envKey, source: envKey ? 'env' : 'none', config: next, cleared: true, message: envKey ? '本地凭据已删除；环境变量来源仍有效，需在启动环境移除后重启' : '本地凭据已清除' };
}
