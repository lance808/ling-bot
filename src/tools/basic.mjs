/**
 * 首批工具（P4 落地，先给只读）
 *
 * 决策依据（FUNCTIONS §12.3 Q4/Q5）：先只给只读工具跑一周，
 * 再开 fs_write / shell_exec。写与执行类工具默认不注册——
 * "不给"比"给了再拦"更可靠。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { defineTool } from './registry.mjs';
import { RISK } from '../guard/tool-gate.mjs';
import { ORIGIN } from '../guard/origin.mjs';
import { resolveGuardedPath } from '../guard/path-policy.mjs';

/**
 * 登记只读文件工具。
 *
 * @param {{roots: string[], userDataDir: string}} opts
 */
export async function registerReadonlyTools(opts) {
  // 允许的根目录在启动时就建好：否则第一次调用会因 ENOENT 失败，
  // 而用户看到的是"工具坏了"而不是"目录还没建"。
  for (const root of opts.roots) {
    await fs.mkdir(root, { recursive: true });
  }
  defineTool({
    name: 'fs_list',
    description: '列出允许目录下的文件（只读）',
    kind: 'host',
    risk: RISK.R0,
    confirm: 'never',
    origins: [ORIGIN.OWNER_PRIVATE, ORIGIN.CONSOLE],
    pathPolicy: 'workspace',
    params: {
      path: { type: 'string', required: false, description: '相对路径，留空表示根目录', maxLength: 512 },
    },
    async run({ args }) {
      const target = await resolveGuardedPath(args.path || '.', {
        roots: opts.roots,
        userDataDir: opts.userDataDir,
        mode: 'read',
      });
      if (!target.ok) {
        const err = new Error(target.message);
        /** @type {any} */ (err).code = target.code;
        throw err;
      }
      const entries = await fs.readdir(/** @type {string} */ (target.resolved), { withFileTypes: true });
      return entries
        .slice(0, 200)
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    },
  });

  defineTool({
    name: 'fs_read',
    description: '读取允许目录下某个文本文件的内容（只读，最多 256KB）',
    kind: 'host',
    risk: RISK.R0,
    confirm: 'never',
    origins: [ORIGIN.OWNER_PRIVATE, ORIGIN.CONSOLE],
    pathPolicy: 'workspace',
    limits: { maxBytes: 256 * 1024 },
    params: {
      path: { type: 'string', required: true, description: '相对路径', maxLength: 512 },
    },
    async run({ args }) {
      const target = await resolveGuardedPath(args.path, {
        roots: opts.roots,
        userDataDir: opts.userDataDir,
        mode: 'read',
      });
      if (!target.ok) {
        const err = new Error(target.message);
        /** @type {any} */ (err).code = target.code;
        throw err;
      }
      const stat = await fs.stat(/** @type {string} */ (target.resolved));
      if (stat.size > 256 * 1024) {
        const err = new Error('文件超过 256KB 上限');
        /** @type {any} */ (err).code = 'E4033';
        throw err;
      }
      const content = await fs.readFile(/** @type {string} */ (target.resolved), 'utf8');
      return { path: path.basename(/** @type {string} */ (target.resolved)), bytes: stat.size, content };
    },
  });
}
