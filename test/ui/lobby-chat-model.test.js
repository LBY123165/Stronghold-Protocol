// RAM-only waiting-room chat: the room's own channel before a match runs. It shares the wire types with the
// match chat, so the tests pin that the two channels never show each other's messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import { createMatchChatModel, emptyLobbyChat, installLobbyChat, selectChatUnread } from '../../public/js/matchChat.js';

const waitingRoom = (chatId = 'chat_lobby') => ({ code: 'ABCDEF', inMatch: false, lobbyChatId: chatId });
const entry = (seq, patch = {}) => ({
  seq, playerId: 'p1', name: '龙千尘', seat: 0, spectator: false, text: `消息 ${seq}`, at: 1000 + seq, ...patch,
});
const push = (seq, chatId = 'chat_lobby', patch = {}) => ({ t: 'm.chat', matchId: chatId, ...entry(seq, patch) });
const history = (seq, messages, chatId = 'chat_lobby') => ({ t: 'm.chatState', matchId: chatId, seq, messages });
const seqs = (model) => model.target.get().messages.map((message) => message.seq);

function readyModel(opts) {
  const model = createMatchChatModel({ idField: 'chatId', requestType: 'room.lobbyChat', ...opts });
  model.syncRoom(waitingRoom());
  return model;
}

function fakeNet() {
  const listeners = new Map();
  const calls = [];
  return {
    status: 'online', calls,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type).delete(listener);
    },
    emit(type, message) { for (const listener of listeners.get(type) || []) listener(message); },
    listenerCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    request(type, payload) { return new Promise((resolve, reject) => calls.push({ type, payload, resolve, reject })); },
  };
}

test('the waiting room follows the room while no match runs, and only then', () => {
  const model = createMatchChatModel({ idField: 'chatId', requestType: 'room.lobbyChat' });
  model.syncRoom(waitingRoom());
  assert.equal(model.target.get().chatId, 'chat_lobby');

  // a room with a running match has no waiting-room channel
  model.syncRoom({ code: 'ABCDEF', inMatch: true, chatMatchId: 'chat_match', lobbyChatId: null });
  assert.equal(model.target.get().chatId, null);

  // the same room without a match gets its channel back
  model.syncRoom(waitingRoom('chat_lobby_2'));
  assert.equal(model.target.get().chatId, 'chat_lobby_2');
  assert.deepEqual(model.target.get().messages, [], 'the new channel starts empty');
});

test('a frame of the other channel is never shown in the waiting room', () => {
  const model = readyModel();
  // a match-chat frame (a different id) must be ignored
  assert.equal(model.receive(push(1, 'chat_match')), false);
  assert.deepEqual(seqs(model), []);
  // the waiting room's own frame is taken
  assert.equal(model.receive(push(1)), true);
  assert.deepEqual(seqs(model), [1]);
});

test('the waiting-room history fills a gap but never erases a later push', () => {
  const model = readyModel();
  model.receive(push(2));
  assert.equal(model.receiveState(history(3, [entry(1), entry(2), entry(3)])), true);
  assert.deepEqual(seqs(model), [1, 2, 3]);
  // a stale snapshot (an older seq) does not drop the messages already received
  model.receiveState(history(1, [entry(1)]));
  assert.deepEqual(seqs(model), [1, 2, 3]);
});

test('sending uses the waiting-room request and the room chat id', async () => {
  const model = readyModel();
  const net = fakeNet();
  const pending = model.send('  大家好  ', net);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].type, 'room.lobbyChat');
  assert.equal(net.calls[0].payload.matchId, 'chat_lobby');
  assert.equal(net.calls[0].payload.text, '大家好');
  net.calls[0].resolve({ ok: true });
  await pending;
  // a successful send clears the draft it typed
  assert.equal(model.target.get().draft, '');
});

test('the waiting room refuses to send without a channel or while offline', async () => {
  const model = createMatchChatModel({ idField: 'chatId', requestType: 'room.lobbyChat' });
  await assert.rejects(() => model.send('hi', fakeNet()), /WRONG_PHASE/);
  const ready = readyModel();
  const net = fakeNet();
  net.status = 'offline';
  await assert.rejects(() => ready.send('hi', net), /OFFLINE/);
});

test('the waiting room keeps the unread count and the read marker', () => {
  const model = readyModel();
  model.receive(push(1));
  model.receive(push(2));
  assert.equal(selectChatUnread(model.target.get()), 2);
  model.markRead(2);
  assert.equal(selectChatUnread(model.target.get()), 0);
  model.markRead(1); // an older marker never lowers the count
  assert.equal(model.target.get().lastReadSeq, 2);
});

test('the waiting-room controller listens for the shared wire types and resets with the room', () => {
  const net = fakeNet();
  const appStore = createStore({ me: { playerId: 'p1' }, room: waitingRoom() });
  const model = createMatchChatModel({ idField: 'chatId', requestType: 'room.lobbyChat' });
  const stop = installLobbyChat({ net, appStore, model });

  assert.equal(model.target.get().chatId, 'chat_lobby');
  net.emit('m.chat', push(1));
  assert.deepEqual(seqs(model), [1]);

  // leaving the room clears the channel
  appStore.set({ me: { playerId: 'p1' }, room: null });
  assert.equal(model.target.get().chatId, null);

  stop();
  assert.equal(net.listenerCount(), 0);
});
