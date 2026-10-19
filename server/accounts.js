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

export function createAccountStore({ file, log = console } = {}) {
  const filePath = file || path.resolve('.cache/accounts.json');
  const accounts = new Map();
  let writeQueue = Promise.resolve();
  let mutationQueue = Promise.resolve();
  const ready = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
      for (const [key, value] of Object.entries(raw.accounts || {})) accounts.set(key, value);
    } catch (e) {
      if (e.code !== 'ENOENT') { log.error?.(`[accounts] cannot read store: ${e.message}`); throw e; }
    }
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
      const rec = { username, salt: salt.toString('hex'), passwordHash: digest.toString('hex'), skins: {}, tokens: [] };
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
    const token = issueToken(rec);
    await persist();
    return { token, username: rec.username, skins: rec.skins || {} };
  }
  async function authenticate(token) {
    await ready;
    if (typeof token !== 'string' || token.length > 128) return null;
    const digest = hash(token);
    for (const [id, rec] of accounts) if ((rec.tokens || []).some((x) => x.hash === digest && x.at > Date.now() - 365 * 86400_000)) return { id, username: rec.username, skins: rec.skins || {} };
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
  return { ready, create, login, authenticate, setSkins };
}
