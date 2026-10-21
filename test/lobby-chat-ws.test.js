// The waiting-room chat over a real WebSocket: the room's own channel before a match runs, its permissions and
// its lifecycle (the match starts → the channel closes; the room plays again → a new one opens).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

/** Real WS/session/lobby plumbing without battle simulation or match timers. */
class HeldChatMatch extends StubMatch {
  start() { this.phase = 'INFO_CHECK'; this.broadcastFn(this.publicView()); }
  addSpectator(playerId) { this.sendFn(playerId, this.publicView()); }
  removeSpectator() {}
}

async function fixture(t) {
  const logs = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
    .map((kind) => [kind, (...args) => logs.push(args.map(String).join(' '))]));
  const srv = await startServer({ port: 0, host: '127.0.0.1', MatchClass: HeldChatMatch, log,
    serverSettingsDir: path.resolve('.cache', `lobby-chat-settings-${process.pid}-${Date.now()}`) });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate().catch(() => {}))); await srv.close(); });
  srv.lobby.setAiLimit(null);
  srv.lobby.setAssetCachePolicy({ required: false, getSummary: () => null });
  const connect = async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wire: false });
    clients.push(c);
    const welcome = await c.hello(name);
    c.id = welcome.playerId; c.token = welcome.token;
    return c;
  };
  return { srv, connect };
}

test('the waiting room has its own chat id, and a member can talk before the match starts', async (t) => {
  const { srv, connect } = await fixture(t);
  const host = await connect('Host');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 })).t, 'ok');
  const state = await host.waitFor('room.state');
  const room = srv.lobby.getRoom(state.code);
  const lobbyChatId = state.lobbyChatId;
  assert.equal(typeof lobbyChatId, 'string');
  assert.ok(lobbyChatId.length);
  assert.equal(room.toState().lobbyChatId, lobbyChatId, 'the room advertises its waiting-room chat id');

  const guest = await connect('Guest');
  assert.equal((await guest.request({ t: 'room.join', code: room.code })).t, 'ok');
  const guestState = await guest.waitFor('room.state');
  assert.equal(guestState.lobbyChatId, lobbyChatId, 'every member sees the same waiting-room chat id');

  // the host sends: the message reaches the guest
  const sent = await host.request({ t: 'room.lobbyChat', chatId: lobbyChatId, text: '大家准备好了吗' });
  assert.equal(sent.t, 'ok');
  const pushed = await guest.waitFor('m.chat');
  assert.equal(pushed.text, '大家准备好了吗');
  assert.equal(pushed.matchId, lobbyChatId);
});

test('the waiting-room chat rejects a stale id, an outsider and a departed member', async (t) => {
  const { srv, connect } = await fixture(t);
  const host = await connect('Host');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 })).t, 'ok');
  const state = await host.waitFor('room.state');
  const lobbyChatId = state.lobbyChatId;

  // a stale id (a room that never had one) is refused
  const stale = await host.request({ t: 'room.lobbyChat', chatId: 'chat_not_this_room', text: 'hi' });
  assert.equal(stale.t, 'error');
  assert.equal(stale.code, ERR.BAD_TARGET);

  // a player outside the room is refused
  const outsider = await connect('Outsider');
  const out = await outsider.request({ t: 'room.lobbyChat', chatId: lobbyChatId, text: 'hi' });
  assert.equal(out.t, 'error');
  assert.equal(out.code, ERR.NOT_IN_ROOM);

  // a member who left is refused
  const guest = await connect('Guest');
  assert.equal((await guest.request({ t: 'room.join', code: state.code })).t, 'ok');
  assert.equal((await guest.request({ t: 'room.leave' })).t, 'ok');
  const left = await guest.request({ t: 'room.lobbyChat', chatId: lobbyChatId, text: 'hi' });
  assert.equal(left.t, 'error');
});

test('the waiting-room chat closes when the match starts and the match chat takes over', async (t) => {
  const { srv, connect } = await fixture(t);
  const host = await connect('Host');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 })).t, 'ok');
  const state = await host.waitFor('room.state');
  const lobbyChatId = state.lobbyChatId;

  assert.equal((await host.request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
  await host.waitFor('m.chatState');

  // the waiting-room channel is closed: the same id no longer works
  const after = await host.request({ t: 'room.lobbyChat', chatId: lobbyChatId, text: '还在吗' });
  assert.equal(after.t, 'error');
  assert.equal(after.code, ERR.WRONG_PHASE);

  // the room state no longer advertises a waiting-room chat
  const running = srv.lobby.getRoom(state.code);
  assert.equal(running.toState().lobbyChatId, null);
});

test('the waiting-room chat rate-limits a flood and keeps the text rules', async (t) => {
  const { srv, connect } = await fixture(t);
  const host = await connect('Host');
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 8 })).t, 'ok');
  const state = await host.waitFor('room.state');
  const lobbyChatId = state.lobbyChatId;

  // an overlong text is refused by the protocol
  const tooLong = await host.request({ t: 'room.lobbyChat', chatId: lobbyChatId, text: '字'.repeat(300) });
  assert.equal(tooLong.t, 'error');

  // a flood is rate-limited (the room bucket allows a few, then refuses)
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const res = await host.request({ t: 'room.lobbyChat', chatId: lobbyChatId, text: `消息 ${i}` });
    if (res.t === 'error') refused++;
  }
  assert.ok(refused > 0, 'a flood of messages is rate-limited');
});
