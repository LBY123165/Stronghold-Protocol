// test/lobby-ai-last.test.js — the co-op rule 「AI 队友最后选择」 (GitHub #338; room.setAiPicksLast stays for the protocol):
// in this capacity branch it is FIXED ON for co-op rooms (manual players always pick first — server/lobby.js refuses to
// turn it off) and off in solo; room.state.aiPicksLast shows it to everybody; the match gets it at its start
// (server/match/Match.js orders the drafts with it — test/match/ai-picks-last.test.js).
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect() { const c = await TestClient.connect(getUrl()); open.add(c); return c; },
    async player(name, token) {
      const c = await this.connect();
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
async function createRoom(c, mode = 'coop') {
  await ok(c, { t: 'room.create', mode, difficulty: 'NORMAL' });
  return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
}
async function joinRoom(c, code) {
  await ok(c, { t: 'room.join', code });
  return c.waitFor('room.state', (s) => s.code === code && !!seatOf(s, c.id));
}

/** StubMatch that records the options each match was started with. */
const started = [];
class RecordingMatch extends StubMatch {
  constructor(opts) {
    super(opts);
    started.push(opts);
  }
}

test('protocol: room.setAiPicksLast takes exactly a boolean `on`', () => {
  assert.equal(validateC2S({ t: 'room.setAiPicksLast', on: true }), null);
  assert.equal(validateC2S({ t: 'room.setAiPicksLast', on: false }), null);
  for (const on of [undefined, null, 1, 0, 'true', 'yes', {}, []]) {
    assert.notEqual(validateC2S({ t: 'room.setAiPicksLast', on }), null, JSON.stringify(on));
  }
});

describe('room.setAiPicksLast (lobby)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RecordingMatch, lobbyGraceMs: 60_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  test('fixed on in co-op (capacity branch): host-only; every seat sees it in room.state; turning it off is refused', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    assert.equal(st.aiPicksLast, true);
    const guest = await pool.player('Guest');
    const js = await joinRoom(guest, st.code);
    assert.equal(js.aiPicksLast, true);
    await err(guest, { t: 'room.setAiPicksLast', on: true }, ERR.NOT_HOST);
    await err(host, { t: 'room.setAiPicksLast', on: false }, ERR.BAD_TARGET);
    // asking for the fixed value again is ok (and changes nothing)
    await ok(host, { t: 'room.setAiPicksLast', on: true });
    // a malformed value never reaches the lobby
    await err(host, { t: 'room.setAiPicksLast', on: 'yes' }, ERR.BAD_MSG);
  });

  test('solo rooms have no AI teammates: refused, the state stays off', async () => {
    const host = await pool.player('Solo');
    const st = await createRoom(host, 'solo');
    assert.equal(st.aiPicksLast, false);
    await err(host, { t: 'room.setAiPicksLast', on: true }, ERR.BAD_TARGET);
  });

  test('the match gets it fixed on; it cannot change during the match; the room keeps it for the next match and a new host', async () => {
    const host = await pool.player('Host');
    const st = await createRoom(host);
    const guest = await pool.player('Guest');
    await joinRoom(guest, st.code);
    await ok(host, { t: 'room.addBot' });
    await ok(guest, { t: 'room.ready', ready: true });
    await host.waitFor('room.state', (s) => s.aiPicksLast && seatOf(s, guest.id)?.ready);
    const n = started.length;
    await ok(host, { t: 'room.start' });
    await guest.waitFor('room.state', (s) => s.inMatch && s.aiPicksLast === true);
    assert.equal(started.length, n + 1);
    assert.equal(started[n].aiPicksLast, true, 'opts.aiPicksLast');
    await err(host, { t: 'room.setAiPicksLast', on: false }, ERR.ROOM_STARTED);
    await err(guest, { t: 'room.setAiPicksLast', on: false }, ERR.NOT_HOST);
    // the stub match ends once every human confirmed the briefing → back in the lobby with the rule kept
    guest.clearInbox();
    await ok(host, { t: 'g.infoReady' });
    await ok(guest, { t: 'g.infoReady' });
    const back = await guest.waitFor('room.state', (s) => !s.inMatch);
    assert.equal(back.aiPicksLast, true);
    // host migration keeps the room's settings
    await ok(host, { t: 'room.leave' });
    const migrated = await guest.waitFor('room.state', (s) => s.hostId === guest.id);
    assert.equal(migrated.aiPicksLast, true);
    // the new host cannot turn the fixed rule off either
    await err(guest, { t: 'room.setAiPicksLast', on: false }, ERR.BAD_TARGET);
  });

  test('solo: the match gets aiPicksLast false', async () => {
    const host = await pool.player('Host');
    await createRoom(host, 'solo');
    const n = started.length;
    await ok(host, { t: 'room.start' });
    await host.waitFor('room.state', (s) => s.inMatch);
    assert.equal(started[n].aiPicksLast, false);
  });
});
