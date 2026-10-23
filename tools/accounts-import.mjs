// tools/accounts-import.mjs — merge an old server account store into the persistent one.
//
// Usage (stop the service first; it rewrites the store on login / skin changes):
//   sudo systemctl stop stronghold
//   sudo node tools/accounts-import.mjs /opt/stronghold-qb/.cache/accounts.json
//   sudo systemctl start stronghold
//
// The target defaults to runtime/accounts.json (the current location). Existing accounts keep their password,
// tokens and current skin choices; skins only present in the old store are restored, and accounts only in the old
// store are added. Old bearer tokens are not re-added to an existing account (a password reset / ban cleared them).
// The target is backed up next to itself before the atomic replace.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const object = (v) => (isObject(v) ? v : {});

/**
 * Pure merge of two `{ version: 1, accounts: { [key]: account } }` stores.
 * @param {object} oldStore
 * @param {object} currentStore
 */
export function mergeAccountStores(oldStore, currentStore = { accounts: {} }) {
  if (!isObject(oldStore?.accounts)) throw new Error('old store has no accounts object');
  if (!isObject(currentStore?.accounts)) throw new Error('current store has no accounts object');
  const accounts = { ...currentStore.accounts };
  const stats = { added: 0, kept: 0, skinsRestored: 0, oldAccounts: 0 };
  for (const [key, oldRec] of Object.entries(oldStore.accounts)) {
    if (!isObject(oldRec)) continue;
    stats.oldAccounts++;
    const currentRec = accounts[key];
    if (!isObject(currentRec)) {
      accounts[key] = {
        ...oldRec,
        skins: { ...object(oldRec.skins) },
        tokens: Array.isArray(oldRec.tokens) ? [...oldRec.tokens] : [],
      };
      stats.added++;
      continue;
    }
    // The current record stays authoritative for identity, password, ban state and tokens. Only appearances are
    // unioned: a skin chosen on this server wins, an appearance that exists only in the backup comes back.
    const oldSkins = object(oldRec.skins);
    const currentSkins = object(currentRec.skins);
    const skins = { ...oldSkins, ...currentSkins };
    stats.skinsRestored += Object.keys(oldSkins).filter((charId) => !(charId in currentSkins)).length;
    accounts[key] = { ...currentRec, skins };
    stats.kept++;
  }
  return { store: { version: 1, accounts }, stats };
}

function readStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(parsed?.accounts)) throw new Error('not an account store (missing accounts object)');
    return parsed;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`account store not found: ${file}`, { cause: e });
    throw e;
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((arg) => !arg.startsWith('--'));
  const source = files[0];
  const target = path.resolve(files[1] || 'runtime/accounts.json');
  if (!source) {
    console.error('用法: node tools/accounts-import.mjs <旧 accounts.json> [目标 accounts.json] [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const from = path.resolve(source);
  if (from === target) throw new Error('source and target are the same file');

  const oldStore = readStore(from);
  const currentStore = fs.existsSync(target) ? readStore(target) : { version: 1, accounts: {} };
  const { store, stats } = mergeAccountStores(oldStore, currentStore);
  console.log(`旧库: ${from}`);
  console.log(`目标: ${target}`);
  console.log(`旧账号 ${stats.oldAccounts} 个；新增 ${stats.added}，已存在 ${stats.kept}，恢复皮肤选择 ${stats.skinsRestored} 项。`);
  if (dryRun) {
    console.log('--dry-run：没有写入。');
    return;
  }
  if (fs.existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${target}.bak-${stamp}`;
    fs.copyFileSync(target, backup);
    console.log(`目标已备份: ${backup}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, target);
  console.log(`完成：${target}（账号 ${Object.keys(store.accounts).length} 个）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`错误：${e.message}`);
    process.exitCode = 1;
  }
}
