/* Where exchange keys are kept, encrypted.
 *
 * Windows: DPAPI for this Windows user, as before (it opens by itself after a restart).
 * Elsewhere (a Linux server): a passphrase vault. AES-256-GCM, its key derived from the passphrase with scrypt; the
 * passphrase and the derived key live only in memory. After every restart the vault is locked until a person unlocks
 * it, from the dashboard or from their paired Parlons. Locked: the exchange keys cannot be read, so nothing trades on
 * an exchange. Set TRADING_VAULT=1 to use the vault on Windows too (tests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const useDpapi = process.platform === 'win32' && !process.env.TRADING_VAULT;

// The folder for secrets: outside the app's own folder, so a copy or a backup of the app never carries them.
export function secretDir() {
  const sub = process.env.TRADING_SECRET_DIR || 'Trading';
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, sub);
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, sub === 'Trading' ? 'minima-venues' : sub);
}

function powershell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) reject(new Error('Windows could not protect or read the key.')); else resolve(String(out).trim());
    });
    child.stdin.end(input, 'utf8');
  });
}
const dpapi = {
  protect: (text) => powershell('Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,"CurrentUser"); [Console]::Out.Write([Convert]::ToBase64String($b))', text),
  unprotect: (b64) => powershell('Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,"CurrentUser"); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))', b64),
};

// ---- the passphrase vault
const VAULT_FILE = () => path.join(secretDir(), 'vault.json');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
let vaultKey = null;   // the derived key, in memory only while unlocked

const derive = (pass, salt) => new Promise((resolve, reject) => crypto.scrypt(pass, salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
function seal(key, text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function open(key, blob) {
  const b = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
const readVault = () => { try { return JSON.parse(fs.readFileSync(VAULT_FILE(), 'utf8')); } catch { return null; } };

export const secrets = {
  mode: useDpapi ? 'dpapi' : 'vault',
  // Locked: a vault exists and is not open. Unset: no vault yet (a passphrase must be chosen first).
  view: () => (useDpapi ? { mode: 'dpapi', locked: false, set: true } : { mode: 'vault', set: !!readVault(), locked: !!readVault() && !vaultKey }),
  async setup(pass) {
    if (useDpapi) return { error: 'This computer keeps keys with Windows; no passphrase is needed.' };
    if (readVault()) return { error: 'A passphrase is already set. Unlock with it.' };
    if (typeof pass !== 'string' || pass.length < 12) return { error: 'Choose a passphrase of at least 12 characters.', field: 'vPass' };
    const salt = crypto.randomBytes(16), key = await derive(pass, salt);
    fs.mkdirSync(secretDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(VAULT_FILE(), JSON.stringify({ v: 1, salt: salt.toString('base64'), check: seal(key, 'minima-venues') }), { mode: 0o600 });
    vaultKey = key;
    return { ok: true };
  },
  async unlock(pass) {
    if (useDpapi) return { ok: true };
    const v = readVault();
    if (!v) return { error: 'No passphrase is set yet.' };
    let key;
    try { key = await derive(String(pass ?? ''), Buffer.from(v.salt, 'base64')); if (open(key, v.check) !== 'minima-venues') throw new Error('x'); }
    catch { return { error: 'That passphrase is not the right one.', field: 'vPass' }; }
    vaultKey = key;
    return { ok: true };
  },
  lock() { if (!useDpapi) vaultKey = null; return { ok: true }; },
  async protect(text) {
    if (useDpapi) return dpapi.protect(text);
    if (!vaultKey) throw new Error(readVault() ? 'The key store is locked: unlock it first.' : 'Choose a passphrase for the key store first.');
    return seal(vaultKey, text);
  },
  async unprotect(blob) {
    if (useDpapi) return dpapi.unprotect(blob);
    if (!vaultKey) throw Object.assign(new Error('The key store is locked.'), { locked: true });
    return open(vaultKey, blob);
  },
};
