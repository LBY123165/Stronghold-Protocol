// 干员皮肤：客户端状态与同步 (docs/SKINS.md).
//
// Two different things live here, and keeping them apart is what makes 「按需安装」 work:
//
//   * the CATALOGUE (data/skins.json, DATA_FILES `skins`) — every skin the project knows about, installed or not: ids,
//     names, series. It carries no URLs, because a skin that is not installed has no files to point at.
//   * what is INSTALLED (data/assets.json → chars[charId].skins) — the skins whose art is actually on this server.
//     `availableSkins()` marks which is which, and the picker greys the rest out.
//
// The choice itself is a plain `{ [baseChessId]: skinId }` map, persisted per browser (store.js loadPref/savePref) and
// mirrored to the server through `room.skins` — the same shape and the same wiring as the operator loadout
// (ui/loadoutSync.js), except that this one is PUBLIC: the server puts it in `Match.publicView().players[].skins`, which
// is how a teammate sees your skin. Unlike the loadout it is accepted in ANY room phase, so a running match takes a
// change at once (Match.setSkins).

import { createStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';

export const SKINS_PREF = 'skins';
export const SYNC_DEBOUNCE_MS = 500;
export const RETRY_MS = 1500;

function readStored() {
  let raw;
  try { raw = loadPref(SKINS_PREF, null); } catch { return {}; }
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [chessId, skinId] of Object.entries(raw)) {
      if (typeof chessId === 'string' && typeof skinId === 'string' && skinId) out[chessId] = skinId;
    }
  }
  return out;
}

/**
 * The chosen skins (per browser) plus the sync state, kept apart from the app store for the same reason the loadout is
 * (it must survive room / match resets).
 */
export const skinsStore = createStore({ entries: readStored(), sync: 'idle' });

/** Replace the whole selection (persisted at once; the sync picks the change up). */
export function setSkins(entries) {
  const next = {};
  for (const [chessId, skinId] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (typeof skinId === 'string' && skinId) next[chessId] = skinId;
  }
  try { savePref(SKINS_PREF, next); } catch { /* private mode: the session keeps it */ }
  skinsStore.set({ entries: next });
}

/** Choose a skin for one operator (keyed by BASE chess id — the server indexes its pieces by it). */
export function setSkin(chessId, skinId) {
  setSkins({ ...skinsStore.get().entries, [chessId]: skinId });
}

/** Drop one operator's choice (it goes back to its default model). */
export function clearSkin(chessId) {
  const next = { ...skinsStore.get().entries };
  delete next[chessId];
  setSkins(next);
}

/** The skin this browser picked for a chess, or null. */
export const skinFor = (chessId) => skinsStore.get().entries[chessId] || null;

/** Load what the picker needs (the catalogue, and the manifest that says which skins are installed). */
export function loadSkinData() {
  data.load('skins').catch(() => {});
  data.load('assets').catch(() => {});
}

/**
 * Every skin of one operator, with the installed flag and its own battle-model flag.
 *
 * Takes the OPERATOR id (`char_498_inside`), not the chess id (`chess_char_1_01_a`): both data/skins.json and
 * data/assets.json group per operator, while a skin *choice* is stored per chess — see ui/skinPicker.js.
 *
 * `installed` — the art data/assets.json carries for it (its 180×180 avatar: the picker and the detail card show it).
 * `battle`    — the skin ALSO brings its own Spine model, so the board and the battle draw it (`assets.js spineEntry`
 *               with `opts.skin`). Most skins DO NOT: this build has models for 172 of the 271 catalogue skins, so 99 are
 *               avatar-only — they change the portrait while the battlefield keeps the operator's own model. Picking one
 *               of those and then seeing the operator unchanged in battle is expected, not a lost setting, so the picker
 *               marks them (player report: "the skin disappears in battle").
 * @param {string} charId
 * @returns {{ id: string, name: string, group: string, installed: boolean, battle: boolean }[]}
 */
export function availableSkins(charId) {
  const list = data.get('skins')?.chars?.[charId];
  if (!Array.isArray(list)) return [];
  const installed = data.get('assets')?.chars?.[charId]?.skins || null;
  return list.map((s) => ({ id: s.id, name: s.name, group: s.group || '',
    installed: !!(installed && installed[s.id]), battle: hasBattleModel(charId, s.id) }));
}

/** Whether this install has the art for a skin (data/assets.json → chars[charId].skins). @param {string} charId */
export function isInstalled(charId, skinId) {
  return !!data.get('assets')?.chars?.[charId]?.skins?.[skinId];
}

/**
 * Whether a skin brings its OWN battle model — the same lookup render/units.js makes through `spineEntry`, which falls
 * back to the operator's model when a skin has none.
 * @param {string} charId @param {string} skinId
 */
export function hasBattleModel(charId, skinId) {
  return !!data.get('assets')?.chars?.[charId]?.skins?.[skinId]?.spine;
}

/** The installed skin's 180×180 avatar URL (its own art), or null. @param {string} charId @param {string} skinId */
export function skinAvatarUrl(charId, skinId) {
  return data.get('assets')?.chars?.[charId]?.skins?.[skinId]?.avatar || null;
}

/**
 * Keep the server's copy of this browser's skins current.
 *
 * Mirrors installLoadoutSync's engine, minus the sanitising: the loadout has to be checked against data/chess.json
 * before it is sent (a stale entry would be dropped), whereas a skinId needs no lookup to send — the server keeps the
 * entries whose chess it recognises and drops the rest (server/lobby.js freezeSkins), and an unknown skinId is
 * harmless. Replies: RATE → retried later; anything else is logged (a running match never refuses this one).
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 * @returns {{ flush: () => Promise<void>, dispose: () => void }}
 */
export function installSkinsSync({ net, timers } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  let timer = null;
  let seq = 0;
  let pendingJson = null;
  let lastSent = null;
  let disposed = false;

  const setState = (sync) => { if (skinsStore.get().sync !== sync) skinsStore.set({ sync }); };
  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed) return;
    if (net.status !== 'online') { setState('idle'); return; } // the next welcome resends
    try {
      const skins = skinsStore.get().entries;
      const json = JSON.stringify(skins);
      if (json === pendingJson) return;
      if (json === lastSent && pendingJson == null) { setState('synced'); return; }
      const my = ++seq;
      pendingJson = json;
      setState('sending');
      try {
        await net.request('room.skins', { skins });
        if (my !== seq) return;
        pendingJson = null;
        lastSent = json;
        setState('synced');
      } catch (err) {
        if (my !== seq) return;
        pendingJson = null;
        const code = err && err.code;
        if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') { schedule(RETRY_MS); return; }
        console.warn('[skins] room.skins refused', code, err && err.detail);
        setState('error');
      }
    } catch (e) {
      console.warn('[skins] sync failed', e);
      setState('error');
    }
  }

  const offWelcome = net.on('welcome', () => { lastSent = null; pendingJson = null; seq++; schedule(50); });
  const offStore = skinsStore.subscribe((s, prev) => { if (s.entries !== prev.entries) schedule(); });

  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStore?.();
    },
  };
}
