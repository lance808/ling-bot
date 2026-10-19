/**
 * 结构化日志 —— F10
 *
 * 手写 30 行，不引第三方库：格式稳定、可轮转、可被「日志」页尾随读。
 * 纪律：**凭据永不进日志**（统一过 redact，见 guard/audit.mjs）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../guard/audit.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  /**
   * @param {{dir: string, level?: keyof typeof LEVELS, fileBase?: string}} opts
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.level = opts.level ?? 'info';
    this.fileBase = opts.fileBase ?? 'app';
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** @returns {string} 当天日志文件路径 */
  currentFile() {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.dir, `${this.fileBase}-${stamp}.log`);
  }

  /**
   * @param {keyof typeof LEVELS} level
   * @param {string} message
   * @param {object} [fields]
   */
  log(level, message, fields) {
    if (LEVELS[level] < LEVELS[/** @type {keyof typeof LEVELS} */ (this.level)]) return;

    const time = new Date().toISOString().slice(11, 19);
    const tail = fields ? ` ${redact(JSON.stringify(fields))}` : '';
    const line = `${time} [${level.toUpperCase()}] ${redact(message)}${tail}\n`;

    // stderr 给人看；文件给「日志」页看
    if (level === 'error' || level === 'warn') process.stderr.write(line);
    else process.stdout.write(line);

    try {
      fs.appendFileSync(this.currentFile(), line, 'utf8');
      this.#rotateIfNeeded();
    } catch {
      /* 日志写失败不能反过来影响主流程 */
    }
  }

  /** 单文件 10MB 轮转，保留 5 份（F10） */
  #rotateIfNeeded() {
    const file = this.currentFile();
    try {
      const stat = fs.statSync(file);
      if (stat.size < 10 * 1024 * 1024) return;
      for (let i = 4; i >= 1; i--) {
        const from = `${file}.${i}`;
        const to = `${file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* 忽略 */
    }
  }

  debug(msg, fields) {
    this.log('debug', msg, fields);
  }
  info(msg, fields) {
    this.log('info', msg, fields);
  }
  warn(msg, fields) {
    this.log('warn', msg, fields);
  }
  error(msg, fields) {
    this.log('error', msg, fields);
  }
}
