// One match's text chat, kept only in RAM. Nothing here writes preferences, diagnostics or match statistics.
import { createStore } from './store.js';
import { MAX_SEATS, PHASE } from '../../shared/constants.js';
import { CHAT_LIMITS, normalizeChatText } from '../../shared/matchChat.js';

/** @typedef {{ seq: number, playerId: string, name: string, seat: number|null, spectator: boolean, text: string, at: number }} ChatEntry */

/** Fresh arrays for every match and every explicit reset. */
export const emptyMatchChat = () => ({
  matchId: null, messages: [], seq: 0, open: false, lastReadSeq: 0, draft: '',
});

/**
 * The waiting-room channel: a room's own chat while no match runs. It is a separate store from the match chat,
 * so the two histories never mix on screen and a stale id from one is never shown in the other.
 */
export const emptyLobbyChat = () => ({
  chatId: null, messages: [], seq: 0, open: false, lastReadSeq: 0, draft: '',
});

/** Count retained messages the player has not read, rather than guessing from sequence gaps. */
export function selectChatUnread(state) {
  return state.messages.reduce((count, message) => count + (message.seq > state.lastReadSeq ? 1 : 0), 0);
}

function chatError(code) {
  // Only static codes enter UI error reporting; the draft and received text never become error details.
  return Object.assign(new Error(code), { code });
}

/** Copy the wire fields needed by the panel; no transport fields or mutable foreign objects are retained. */
function copyEntry(message) {
  if (!message || !Number.isSafeInteger(message.seq) || message.seq <= 0
    || typeof message.playerId !== 'string' || !message.playerId.length || message.playerId.length > 64
    || typeof message.name !== 'string' || !message.name.length || message.name.length > 128
    || typeof message.spectator !== 'boolean'
    || (message.spectator ? message.seat !== null : !Number.isInteger(message.seat) || message.seat < 0 || message.seat >= MAX_SEATS)
    || !Number.isFinite(message.at) || message.at < 0 || normalizeChatText(message.text) == null) return null;
  return Object.freeze({
    seq: message.seq, playerId: message.playerId, name: message.name, seat: message.seat,
    spectator: message.spectator, text: message.text, at: message.at,
  });
}

/**
 * Injectable RAM model: scopes every frame to a server-issued channel id and never persists a body.
 *
 * The same model drives both channels; only the id field, the wire type and the request type differ:
 *   - the match chat:   request `room.chat`,       id from `room.chatMatchId`
 *   - the waiting room: request `room.lobbyChat`,  id from `room.lobbyChatId`
 * The wire frames (`m.chat` / `m.chatState`) always carry the id in `matchId` — that type is part of the
 * existing protocol, so neither channel adds a field to it.
 * @param {{ historyLimit?: number, target?: object, idField?: 'matchId'|'chatId', requestType?: string }} [opts]
 */
export function createMatchChatModel({ historyLimit = CHAT_LIMITS.history, target = createStore(emptyMatchChat()),
  idField = 'matchId', requestType = 'room.chat' } = {}) {
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > CHAT_LIMITS.history) {
    throw new RangeError('invalid chat history limit');
  }
  const empty = idField === 'chatId' ? emptyLobbyChat : emptyMatchChat;
  /** The wire field name: the id always travels in `matchId`, whatever the channel calls it locally. */
  const wireField = 'matchId';

  function reset() { target.set(empty()); }

  function syncRoom(room) {
    const channelId = idField === 'chatId'
      ? (!room?.inMatch && typeof room?.lobbyChatId === 'string' && room.lobbyChatId.length ? room.lobbyChatId : null)
      : (room?.inMatch && typeof room.chatMatchId === 'string' && room.chatMatchId.length ? room.chatMatchId : null);
    if (target.get()[idField] === channelId) return;
    target.set({ ...empty(), [idField]: channelId });
  }

  function merge(incoming, seq) {
    const current = target.get();
    const entries = new Map(current.messages.map((entry) => [entry.seq, entry]));
    for (const entry of incoming) if (!entries.has(entry.seq)) entries.set(entry.seq, entry);
    const messages = [...entries.values()].sort((a, b) => a.seq - b.seq).slice(-historyLimit);
    target.set({ messages, seq: Math.max(current.seq, seq, messages.at(-1)?.seq || 0) });
  }

  function receiveState(message) {
    const current = target.get();
    if (!current[idField] || message?.[wireField] !== current[idField]
      || !Number.isSafeInteger(message.seq) || message.seq < 0 || !Array.isArray(message.messages)
      || message.messages.length > CHAT_LIMITS.history) return false;
    const incoming = [];
    for (const raw of message.messages) {
      const entry = copyEntry(raw);
      if (entry && entry.seq <= message.seq) incoming.push(entry);
    }
    // A late reconnect snapshot can fill a gap, but must not erase later single-message pushes.
    merge(incoming, message.seq);
    return true;
  }

  function receive(message) {
    if (!target.get()[idField] || message?.[wireField] !== target.get()[idField]) return false;
    const entry = copyEntry(message);
    if (!entry) return false;
    merge([entry], entry.seq);
    return true;
  }

  function setOpen(on) {
    const current = target.get();
    if (!current[idField]) return;
    target.set({ open: !!on });
  }

  function setDraft(text) {
    // Preserve the raw composition until Send. NFC/control normalization while an IME is composing corrupts input.
    if (target.get()[idField] && typeof text === 'string') target.set({ draft: text });
  }

  function markRead(seq = target.get().seq) {
    const current = target.get();
    if (!current[idField] || !Number.isSafeInteger(seq) || seq < 0) return;
    const lastReadSeq = Math.max(current.lastReadSeq, Math.min(seq, current.seq));
    if (lastReadSeq !== current.lastReadSeq) target.set({ lastReadSeq });
  }

  async function send(text, net) {
    const current = target.get();
    const channelId = current[idField];
    if (!channelId) throw chatError('WRONG_PHASE');
    if (net?.status !== 'online') throw chatError('OFFLINE');
    const normalized = normalizeChatText(text);
    if (normalized == null) throw chatError('BAD_MSG');
    await net.request(requestType, { [wireField]: channelId, text: normalized });
    // The push is authoritative: no optimistic row or acknowledgement can duplicate a message.
    if (target.get()[idField] !== channelId) return false;
    // A successful send must not erase a new draft typed while the acknowledgement was pending.
    if (target.get().draft === text) target.set({ draft: '' });
    return true;
  }

  return { target, reset, syncRoom, receiveState, receive, setOpen, setDraft, markRead, send };
}

const matchChat = createMatchChatModel();
export const chatStore = matchChat.target;
let installedNet = null;
export const chatActions = {
  setOpen: matchChat.setOpen, setDraft: matchChat.setDraft, markRead: matchChat.markRead,
  reset: matchChat.reset, send: (text) => matchChat.send(text, installedNet),
};

// the waiting-room channel: its own store, its own id and its own request type
const lobbyChat = createMatchChatModel({ target: createStore(emptyLobbyChat()), idField: 'chatId', requestType: 'room.lobbyChat' });
export const lobbyChatStore = lobbyChat.target;
export const lobbyChatActions = {
  setOpen: lobbyChat.setOpen, setDraft: lobbyChat.setDraft, markRead: lobbyChat.markRead,
  reset: lobbyChat.reset, send: (text) => lobbyChat.send(text, installedNet),
};

/** Follow authoritative room/result/identity state; a temporary socket loss keeps this match's history. */
export function installMatchChat({ net, appStore, model = matchChat }) {
  const isActive = (state) => !!state.room?.inMatch && state.match?.public?.phase !== PHASE.RESULT && !state.match?.result;
  const sync = (state) => model.syncRoom(isActive(state) ? state.room : null);
  let awaitingRoom = false;
  sync(appStore.get());
  if (model === matchChat) installedNet = net;
  const unsubscribe = [
    appStore.subscribe((state, previous) => {
      if (state.me?.playerId !== previous.me?.playerId) { model.reset(); awaitingRoom = true; }
      // Do not adopt the old room again during welcome's identity update; main.js subsequently replaces/clears it.
      if (state.room !== previous.room) { awaitingRoom = false; sync(state); }
      else if (!awaitingRoom && state.match !== previous.match) sync(state);
    }),
    net.on('m.chatState', model.receiveState),
    net.on('m.chat', model.receive),
    net.on('m.result', model.reset),
    net.on('room.closed', model.reset),
  ];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const stop of unsubscribe) stop();
    model.reset();
    if (model === matchChat && installedNet === net) installedNet = null;
  };
}

/**
 * The waiting-room channel: it follows the room while no match runs, so the players can talk in the room screen
 * before the first round. It is installed next to the match chat and shares the wire types, but its own store,
 * so the two histories never mix.
 */
export function installLobbyChat({ net, appStore, model = lobbyChat }) {
  const sync = (state) => model.syncRoom(state.room && !state.room.inMatch ? state.room : null);
  let awaitingRoom = false;
  sync(appStore.get());
  const unsubscribe = [
    appStore.subscribe((state, previous) => {
      if (state.me?.playerId !== previous.me?.playerId) { model.reset(); awaitingRoom = true; }
      // Do not adopt the old room again during welcome's identity update; main.js subsequently replaces/clears it.
      if (state.room !== previous.room) { awaitingRoom = false; sync(state); }
      else if (!awaitingRoom && state.match !== previous.match) sync(state);
    }),
    net.on('m.chatState', model.receiveState),
    net.on('m.chat', model.receive),
    net.on('m.result', model.reset),
    net.on('room.closed', model.reset),
  ];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const stop of unsubscribe) stop();
    model.reset();
  };
}
