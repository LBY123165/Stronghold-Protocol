// Small, single-server account store for cross-device identity and cosmetic preferences.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { accountNameKey, normalizeAccountName } from '../shared/account.js';

const scrypt = promisify(scryptCb);
const PASS_MIN = 8;
const PASS_MAX = 128;
const TOKEN_LIMIT = 12;
const hash = (s) => createHash('sha256').update(s).digest('hex');

export function validAccountName(v) { return normalizeAccountName(v) !== null; }
export function validPassword(v) { return typeof v === 'string' && v.length >= PASS_MIN && v.length <= PASS_MAX; }

export function createAccountStore({ file, legacyFile = null, log = console } = {}) {
  const filePath = file || path.resolve('runtime/accounts.json');
  const legacyPath = legacyFile && path.resolve(legacyFile) !== path.resolve(filePath) ? legacyFile : null;
  const accounts = new Map();
  let writeQueue = Promise.resolve();
  let mutationQueue = Promise.resolve();
  async function load(from) {
    try {
      const raw = JSON.parse(await fs.readFile(from, 'utf8'));
      for (const [key, value] of Object.entries(raw.accounts || {})) accounts.set(key, value);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      log.error?.(`[accounts] cannot read store: ${e.message}`);
      throw e;
    }
  }
  const ready = (async () => {
    if (await load(filePath)) return;
    // One-time move from the 0.3.1 location. `.cache/` is a disposable cache directory: a deploy or a cleanup may
    // remove it, which is why account skins vanished after a server update. `runtime/` is the persistent, writable
    // directory of the systemd unit; the first start copies the old store there and later starts never look back.
    if (!legacyPath || !(await load(legacyPath))) return;
    await persist();
    log.info?.(`[accounts] migrated ${legacyPath} -> ${filePath}`);
  })();
  async function persist() {
    const data = JSON.stringify({ version: 1, accounts: Object.fromEntries(accounts) });
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, filePath);
    });
    return writeQueue;
  }
  function issueToken(rec) {
    const token = randomBytes(32).toString('base64url');
    rec.tokens = [...(rec.tokens || []).filter((x) => x.at > Date.now() - 365 * 86400_000), { hash: hash(token), at: Date.now() }].slice(-TOKEN_LIMIT);
    return token;
  }
  async function create(name, password) {
    const run = mutationQueue.then(async () => {
      await ready;
      const username = normalizeAccountName(name);
      if (!username || !validPassword(password)) return { error: 'INVALID_INPUT' };
      const key = accountNameKey(username);
      if (accounts.has(key)) return { error: 'NAME_TAKEN' };
      const salt = randomBytes(16);
      const digest = await scrypt(password, salt, 64);
      const rec = { username, salt: salt.toString('hex'), passwordHash: digest.toString('hex'), skins: {}, tokens: [], createdAt: Date.now() };
      const token = issueToken(rec);
      accounts.set(key, rec);
      try { await persist(); } catch (e) { accounts.delete(key); throw e; }
      return { token, username: rec.username, skins: rec.skins };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }
  async function login(name, password) {
    await ready;
    const key = accountNameKey(name);
    const rec = key ? accounts.get(key) : null;
    // Keep the cost similar for unknown names to reduce account enumeration timing.
    const salt = rec ? Buffer.from(rec.salt, 'hex') : Buffer.alloc(16);
    const expected = rec ? Buffer.from(rec.passwordHash, 'hex') : Buffer.alloc(64);
    const actual = Buffer.from(await scrypt(typeof password === 'string' ? password.slice(0, PASS_MAX) : '', salt, 64));
    const matches = timingSafeEqual(actual, expected);
    if (!rec || !validPassword(password) || !matches) return { error: 'BAD_CREDENTIALS' };
    // a banned account keeps its data but cannot sign in (the operator may lift the ban)
    if (rec.banned) return { error: 'BANNED' };
    const token = issueToken(rec);
    await persist();
    return { token, username: rec.username, skins: rec.skins || {} };
  }
  async function authenticate(token) {
    await ready;
    if (typeof token !== 'string' || token.length > 128) return null;
    const digest = hash(token);
    for (const [id, rec] of accounts) {
      if (rec.banned) continue;
      if ((rec.tokens || []).some((x) => x.hash === digest && x.at > Date.now() - 365 * 86400_000)) return { id, username: rec.username, skins: rec.skins || {} };
    }
    return null;
  }
  async function setSkins(id, skins) {
    await ready;
    const rec = accounts.get(id);
    if (!rec) return false;
    rec.skins = skins && typeof skins === 'object' && !Array.isArray(skins) ? skins : {};
    await persist();
    return true;
  }

  // ---- operator-side account management (the 运维后台, docs/ADMIN.md) ----------------------------------
  //
  // The console never sees a password hash or a token: only the account's name, when it was created, how many
  // tokens it holds and how many skins it owns. A banned account cannot log in and its tokens stop working.

  /** The operator's view of one account. Never carries the hash, the salt or a token. */
  function accountSummary(rec, id = null) {
    return {
      id: id ?? rec.id ?? null,
      username: rec.username,
      createdAt: rec.createdAt ?? null,
      banned: rec.banned === true,
      bannedAt: rec.bannedAt ?? null,
      bannedReason: rec.bannedReason ?? null,
      skinCount: Object.keys(rec.skins || {}).length,
      tokenCount: (rec.tokens || []).length,
    };
  }

  /**
   * The accounts, newest first, optionally filtered by a substring of the name (case-insensitive).
   * @param {{ query?: string, limit?: number }} [opts]
   */
  async function list({ query = '', limit = 200 } = {}) {
    await ready;
    const needle = String(query || '').trim().toLowerCase();
    const max = Math.min(1000, Math.max(1, Number(limit) || 200));
    const rows = [];
    for (const [id, rec] of accounts) {
      if (needle && !String(rec.username || '').toLowerCase().includes(needle)) continue;
      rows.push(accountSummary(rec, id));
    }
    rows.sort((a, b) => String(a.username).localeCompare(String(b.username)));
    return { accounts: rows.slice(0, max), total: rows.length };
  }

  /**
   * Set a new password for an account and drop its tokens (every logged-in device has to log in again).
   * @param {string} username
   * @param {string} password
   */
  async function setPassword(username, password) {
    const run = mutationQueue.then(async () => {
      await ready;
      const key = accountNameKey(username);
      const rec = key ? accounts.get(key) : null;
      if (!rec) return { ok: false, error: 'NO_SUCH_ACCOUNT' };
      if (!validPassword(password)) return { ok: false, error: 'INVALID_PASSWORD' };
      const salt = randomBytes(16);
      const digest = await scrypt(password, salt, 64);
      rec.salt = salt.toString('hex');
      rec.passwordHash = digest.toString('hex');
      rec.tokens = [];
      rec.passwordChangedAt = Date.now();
      try { await persist(); } catch (e) { log.error?.(`[accounts] cannot persist the new password: ${e.message}`); throw e; }
      return { ok: true, account: accountSummary(rec, key) };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  /**
   * Ban (or unban) an account. A banned account cannot log in and its tokens are refused.
   * @param {string} username
   * @param {{ banned?: boolean, reason?: string }} [opts]
   */
  async function setBanned(username, { banned = true, reason = '' } = {}) {
    const run = mutationQueue.then(async () => {
      await ready;
      const key = accountNameKey(username);
      const rec = key ? accounts.get(key) : null;
      if (!rec) return { ok: false, error: 'NO_SUCH_ACCOUNT' };
      if (banned) {
        rec.banned = true;
        rec.bannedAt = Date.now();
        rec.bannedReason = String(reason || '').slice(0, 200);
        rec.tokens = [];
      } else {
        delete rec.banned;
        delete rec.bannedAt;
        delete rec.bannedReason;
      }
      try { await persist(); } catch (e) { log.error?.(`[accounts] cannot persist the ban: ${e.message}`); throw e; }
      return { ok: true, account: accountSummary(rec, key) };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  /**
   * Delete an account and everything it owns. The name is freed for a new registration.
   * @param {string} username
   */
  async function remove(username) {
    const run = mutationQueue.then(async () => {
      await ready;
      const key = accountNameKey(username);
      const rec = key ? accounts.get(key) : null;
      if (!rec) return { ok: false, error: 'NO_SUCH_ACCOUNT' };
      accounts.delete(key);
      try { await persist(); } catch (e) { accounts.set(key, rec); throw e; }
      return { ok: true, username: rec.username };
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  return { ready, create, login, authenticate, setSkins, list, setPassword, setBanned, remove };
}
