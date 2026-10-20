/** Persistent usage ledger. Recent detail is bounded; range totals scan the complete journal on demand. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { estimateTokens } from './client.mjs';

const count = (v) => Number.isFinite(v) && v >= 0 ? v : 0;
function bucket() { return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCalls: 0, cachedTokens: 0, cacheReported: 0, cachePromptTokens: 0 }; }
function add(b, r) {
  b.calls++; b.promptTokens += count(r.promptTokens); b.completionTokens += count(r.completionTokens); b.totalTokens += count(r.totalTokens);
  if (r.estimated) b.estimatedCalls++;
  if (Number.isFinite(r.cachedTokens) && r.cachedTokens >= 0) { b.cachedTokens += r.cachedTokens; b.cacheReported++; b.cachePromptTokens += count(r.promptTokens); }
}
function dayKey(at) { return new Date(at).toLocaleDateString('en-CA'); }
export class UsageLedger {
  constructor({ filePath }) { this.filePath = filePath; this.recent = []; this.limit = 500; this.today = bucket(); this.todayProactive = bucket(); this.day = dayKey(Date.now()); this.lastError = null; this.pending = Promise.resolve(); this.unpersisted = []; }
  async scan(visit) {
    let invalid = 0;
    try {
      const lines = readline.createInterface({ input: createReadStream(this.filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line.replace(/^\uFEFF/, '')); if (!Number.isFinite(r?.at)) throw new Error(); visit(r); } catch { invalid++; }
      }
      return { covered: invalid === 0, invalidRecords: invalid, lastError: invalid ? '部分账本记录不可读' : null };
    } catch (e) {
      if (e.code === 'ENOENT') return { covered: true, invalidRecords: 0, lastError: null };
      return { covered: false, invalidRecords: invalid, lastError: `账本读取失败（${e.code ?? 'IO'}）` };
    }
  }
  async load() {
    this.recent = []; this.today = bucket(); this.todayProactive = bucket(); this.day = dayKey(Date.now());
    const status = await this.scan(r => { this.recent.push(r); if (this.recent.length > this.limit) this.recent.shift(); if (dayKey(r.at) === this.day) { add(this.today, r); if (r.proactive) add(this.todayProactive, r); } });
    this.lastError = status.lastError;
    return { loaded: this.recent.length, today: this.today.calls };
  }
  async record(input) {
    const now = Date.now(); this.rollDay(now);
    let u = input.usage;
    if (!u || (!u.totalTokens && !u.promptTokens)) { const p = estimateTokens(input.promptText ?? ''); const c = estimateTokens(input.completionText ?? ''); u = { promptTokens: p, completionTokens: c, totalTokens: p + c, estimated: true }; }
    const r = { at: now, convKey: input.convKey, model: input.model, proactive: input.proactive === true, promptTokens: count(u.promptTokens), completionTokens: count(u.completionTokens), totalTokens: count(u.totalTokens), estimated: u.estimated === true,
      ...(Number.isFinite(u.cachedTokens) && u.cachedTokens >= 0 ? { cachedTokens: u.cachedTokens } : {}) };
    this.recent.push(r); if (this.recent.length > this.limit) this.recent.shift(); add(this.today, r); if (r.proactive) add(this.todayProactive, r);
    const write = this.pending.then(async () => { try { await fs.mkdir(path.dirname(this.filePath), { recursive: true }); await fs.appendFile(this.filePath, `${JSON.stringify(r)}\n`, 'utf8'); } catch (e) { this.lastError = `账本未持久化（${e.code ?? 'IO'}）`; this.unpersisted.push(r); } });
    this.pending = write; await write; return r;
  }
  async range({ since = Date.now() - 86400000, until = Date.now() } = {}) {
    const start = typeof since === 'number' ? since : Date.parse(since); const end = typeof until === 'number' ? until : Date.parse(until);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw Object.assign(new Error('用量时间范围非法'), { code: 'E4041' });
    await this.pending;
    const total = bucket(); const include = r => { if (r.at >= start && r.at <= end) add(total, r); };
    const status = await this.scan(include); this.unpersisted.forEach(include);
    return { ...total, records: total.calls, inputTokens: total.promptTokens, outputTokens: total.completionTokens, since: start, until: end, ...status, covered: status.covered && !this.unpersisted.length, lastError: status.lastError ?? this.lastError };
  }
  summary() { this.rollDay(Date.now()); return { today: { ...this.today }, todayProactive: { ...this.todayProactive }, proactiveRatio: this.today.totalTokens ? Math.round(this.todayProactive.totalTokens / this.today.totalTokens * 100) : 0, recent: this.recent.slice(-50), lastError: this.lastError, unpersisted: this.unpersisted.length }; }
  rollDay(now) { const d = dayKey(now); if (d !== this.day) { this.day = d; this.today = bucket(); this.todayProactive = bucket(); } }
}
