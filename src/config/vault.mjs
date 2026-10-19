/**
 * 凭据保险箱 —— 用 Windows DPAPI 加密保存 API Key
 *
 * ## 为什么不用明文配置
 *
 * `config.json` 是明文。一旦被拷走（同步网盘、发给别人排查问题、
 * 或者哪天手滑 commit 了），key 就等于公开了。
 * 而这个 key 是花钱买的，泄露意味着别人用你的额度。
 *
 * ## DPAPI 给的是什么
 *
 * 用当前 Windows 账户的凭据派生密钥，**只有这个账户能解密**：
 *   - 文件被拷到别的机器 → 解不开
 *   - 别的 Windows 账户读 → 解不开
 *   - 换机器重装系统 → 解不开（要重新填）
 *
 * 它**不能**防的：以你的账户身份运行的恶意程序。这一点必须说清，
 * 否则会给人虚假的安全感。真正防"本机恶意程序"需要硬件密钥库，
 * 那超出这个项目的范围。
 *
 * ## 实现方式
 *
 * 不引第三方库：PowerShell 的 `ProtectedData` 就是 DPAPI 的薄封装，
 * 通过子进程调用。缺点是每次都要起一个进程（约 100ms），
 * 但只在启动时读一次、用户点保存时写一次，可以接受。
 *
 * 这里刻意**只做加解密**，不做"记住密码"之外的事：
 * 明文只在内存里存在，不落盘、不进日志。
 */

import { spawn } from 'node:child_process';

/**
 * 用 PowerShell 调 DPAPI。
 *
 * 把明文/密文从 stdin 传进去，避免出现在命令行参数里
 * —— 进程参数在任务管理器里能看到，那等于明文泄露。
 *
 * @param {'protect'|'unprotect'} mode
 * @param {string} input base64
 * @returns {Promise<string>} base64
 */
function dpapi(mode, input) {
  const script = mode === 'protect'
    ? `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$raw = [Convert]::FromBase64String($b64)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($enc))
`
    : `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$raw = [Convert]::FromBase64String($b64)
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($dec))
`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.stderr.on('data', (c) => (err += c.toString('utf8')));

    child.on('error', (e) => reject(new VaultError('E4101', `无法调用 PowerShell：${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new VaultError('E4102', `DPAPI 操作失败（${mode}）：${err.trim().slice(0, 300)}`));
        return;
      }
      resolve(out.trim());
    });

    child.stdin.end(input);
  });
}

/** 保险箱相关的错误 */
export class VaultError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export const VAULT_FORMAT = 'dpapi-v1';

/**
 * 加密一段文本。
 *
 * @param {string} plaintext
 * @returns {Promise<{format: string, data: string, savedAt: string}>}
 */
export async function sealSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new VaultError('E4103', '要保存的内容为空');
  }
  const b64 = Buffer.from(plaintext, 'utf8').toString('base64');
  const enc = await dpapi('protect', b64);
  return { format: VAULT_FORMAT, data: enc, savedAt: new Date().toISOString() };
}

/**
 * 解密。格式不对或解不开都抛错——**绝不静默返回空**，
 * 否则"key 明明存了却用不了"会非常难查。
 *
 * @param {{format?: string, data?: string}} sealed
 * @returns {Promise<string>}
 */
export async function openSecret(sealed) {
  if (!sealed || typeof sealed.data !== 'string' || sealed.data.length === 0) {
    throw new VaultError('E4104', '保险箱里没有内容');
  }
  if (sealed.format !== VAULT_FORMAT) {
    throw new VaultError('E4105', `保险箱格式不认识：${String(sealed.format)}`);
  }

  const b64 = await dpapi('unprotect', sealed.data);
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * 判断当前环境能不能用 DPAPI。
 * 非 Windows、或 PowerShell 不可用时返回 false，让调用方走"每次都填"的降级路径。
 *
 * @returns {Promise<boolean>}
 */
export async function isVaultAvailable() {
  if (process.platform !== 'win32') return false;
  try {
    const sealed = await sealSecret('probe');
    const back = await openSecret(sealed);
    return back === 'probe';
  } catch {
    return false;
  }
}
