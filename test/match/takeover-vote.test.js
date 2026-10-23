// 断线接管投票 (GitHub #338 follow-up): a disconnected teammate's seat is decided by the room's other players —
// an AI takes it over, or a teammate with spare capacity steps into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { ERR } from '../../shared/constants.js';
import { TAKEOVER_VOTE_MS } from '../../server/match/match/takeover.js';

const setup = (t, opts = {}) => {
  const h = makeMatch({ humans: 3, fake: true, ...opts }).start();
  t.after(() => h.m.dispose());
  return h;
};

/** The seat of p_1 drops (its socket is gone) and it is not on AI control. */
function dropOut(h, playerId = 'p_1') {
  const ps = h.m.players.get(playerId);
  ps.connected = false;
  return ps;
}

test('a disconnected seat without AI control is the one that needs a decision', (t) => {
  const h = setup(t);
  const m = h.m;
  assert.equal(m.takeoverCandidate(), null, 'a fully connected match needs no decision');

  const dropped = dropOut(h);
  assert.equal(m.takeoverCandidate(), dropped);

  // a seat on AI control needs no vote
  dropped.autoplay = true;
  assert.equal(m.takeoverCandidate(), null);
});

test('the room votes: an AI takeover needs a majority of the online players', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);

  // three humans, one is offline: two voters, one vote is the majority
  assert.deepEqual(m.takeoverVoters(), ['p_0', 'p_2']);
  const vote = { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' };
  assert.equal(m.handle('p_0', vote).ok, true);
  assert.ok(m.takeoverVote, 'the vote is open');
  assert.equal(m.publicView().takeoverVote.options[0].votes, 1);

  // the second vote reaches the majority: the seat is handed to an AI
  assert.equal(m.handle('p_2', vote).ok, true);
  assert.equal(m.takeoverVote, null, 'the vote closed');
  assert.equal(m.players.get('p_1').autoplay, true, 'the disconnected seat is on AI control');
  assert.equal(m.publicView().takeoverVote, undefined, 'a closed vote is not published');
});

test('the first ballot keeps every other voter eligible and clears the prompt', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);
  assert.equal(m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  const view = m.publicView().takeoverVote;
  assert.equal(view.voters.length, 1, 'one ballot has been cast');
  assert.deepEqual(view.eligible, ['p_0', 'p_2'], 'the other voter is still eligible (the client reads this list)');
  assert.equal(m.publicView().takeoverPending, undefined, 'the tally replaced the prompt');
  // the crash state on the client: vote present, prompt absent
  assert.ok(view);
  assert.equal(m.handle('p_2', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  assert.equal(m.players.get('p_1').autoplay, true);
});

test('the vote ceiling fills the seat instead of leaving the decision open forever', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);
  assert.equal(m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  assert.ok(m.takeoverVote, 'the vote is open with one of two ballots');
  h.sched.advance(TAKEOVER_VOTE_MS + 1_000);
  assert.equal(m.takeoverVote, null, 'the ceiling closed the vote');
  assert.equal(m.players.get('p_1').autoplay, true, 'the leading side (AI) filled the seat');
  assert.equal(m.publicView().takeoverVote, undefined);
});

test('a vote that lost its electors cannot be decided by one player; the ceiling still fills the seat', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);
  assert.equal(m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  m.players.get('p_2').connected = false; // the second voter drops while the vote is open
  assert.deepEqual(m.takeoverVoters(), ['p_0']);
  const res = m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' });
  assert.equal(res.error, ERR.BAD_TARGET, 'a room with one online player has nobody to decide');
  h.sched.advance(TAKEOVER_VOTE_MS + 1_000);
  assert.equal(m.takeoverVote, null);
  assert.equal(m.players.get('p_1').autoplay, true, 'the ceiling still fills the seat');
});

test('the disconnected player cannot decide their own seat', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);
  // the offline player is not a voter
  const res = m.handle('p_1', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' });
  assert.equal(res.error, ERR.NOT_IN_ROOM);
});

test('a spectator seat does not vote: the decision belongs to the players in this match', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);
  // a spectator joined the room (the lobby registers it on the match)
  m.spectators.set('p_spec', Object.freeze({ playerId: 'p_spec', isBot: false, left: false, alive: false, connected: true, spectator: true }));
  assert.deepEqual(m.takeoverVoters(), ['p_0', 'p_2'], 'a spectator is not a voter');

  // the spectator's own ballot is refused (the platform turns a spectator's non-watch intent away)
  const refused = m.handle('p_spec', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' });
  assert.equal(refused.error, ERR.SPECTATOR);
  assert.equal(m.takeoverVote, null, 'no tally was opened');

  // the two players in the match decide it
  assert.equal(m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  assert.equal(m.publicView().takeoverVote.needed, 2, 'two of the two voters decide');
  assert.equal(m.handle('p_2', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  assert.equal(m.takeoverVote, null, 'the second vote is the majority');
  assert.equal(m.players.get('p_1').autoplay, true);
});

test('an eliminated player still votes: it is still a seat in this match', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);
  // p_2 was eliminated in the fight but is still seated and connected
  m.players.get('p_2').alive = false;
  assert.deepEqual(m.takeoverVoters(), ['p_0', 'p_2'], 'an eliminated player keeps its say');

  // an eliminated player cannot step into another seat (it has no board to take over with)
  assert.deepEqual(m.takeoverCandidates('p_1').map((p) => p.playerId), ['p_0']);

  assert.equal(m.handle('p_2', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  assert.equal(m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  assert.equal(m.players.get('p_1').autoplay, true);
});

test('a teammate can step into the seat, and the vote names them', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);

  // p_0 votes that p_2 steps in; p_2 agrees: the majority is reached
  const first = m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover', candidatePlayerId: 'p_2' });
  assert.equal(first.ok, true);
  const view = m.publicView().takeoverVote;
  assert.equal(view.options[1].mode, 'handover');
  assert.equal(view.options[1].candidatePlayerId, 'p_2');
  assert.equal(view.options[1].candidateName, 'P2', 'the vote names the teammate who steps in');
  assert.equal(view.targetName, 'P1', 'the vote names the seat that is filled');

  assert.equal(m.handle('p_2', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover', candidatePlayerId: 'p_2' }).ok, true);
  assert.equal(m.takeoverVote, null, 'the vote closed');
  // the seat's owner is not on AI control: a teammate took over
  assert.equal(m.players.get('p_1').autoplay, false);
});

test('the two options are exclusive: a voter may change their mind', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);

  assert.equal(m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }).ok, true);
  // p_0 changes to the handover option: the bot side loses its vote
  assert.equal(m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover', candidatePlayerId: 'p_2' }).ok, true);
  const view = m.publicView().takeoverVote;
  assert.equal(view.options[0].votes, 0, 'the earlier vote is withdrawn');
  assert.equal(view.options[1].votes, 1);
  assert.equal(view.voters.length, 1, 'a player votes once');
});

test('only a connected teammate with spare capacity may step in', (t) => {
  const h = setup(t);
  const m = h.m;
  dropOut(h);

  // the seat's owner cannot step into their own seat
  const own = m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover', candidatePlayerId: 'p_1' });
  assert.equal(own.error, ERR.BAD_TARGET);

  // an unknown player cannot step in
  const unknown = m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover', candidatePlayerId: 'p_nobody' });
  assert.equal(unknown.error, ERR.BAD_TARGET);

  // a teammate on AI control (托管) has no spare capacity
  m.players.get('p_2').autoplay = true;
  const busy = m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover', candidatePlayerId: 'p_2' });
  assert.equal(busy.error, ERR.BAD_TARGET);
});

test('a vote for a connected seat or a seat on AI control is refused', (t) => {
  const h = setup(t);
  const m = h.m;

  // p_0 is connected: its seat needs no decision
  const connected = m.handle('p_2', { t: 'g.takeoverVote', targetPlayerId: 'p_0', mode: 'bot' });
  assert.equal(connected.error, ERR.BAD_TARGET);

  // a seat on AI control needs no decision
  const dropped = dropOut(h);
  dropped.autoplay = true;
  const botSeat = m.handle('p_2', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' });
  assert.equal(botSeat.error, ERR.BAD_TARGET);
});

test('a room of one online player has nobody to decide the seat', (t) => {
  const h = setup(t);
  const m = h.m;
  // three humans, two of them drop
  dropOut(h, 'p_1');
  dropOut(h, 'p_2');
  const res = m.handle('p_0', { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' });
  assert.equal(res.error, ERR.BAD_TARGET);
});

test('a dropped socket asks the room to decide once the grace has passed', (t) => {
  const h = setup(t);
  const m = h.m;

  m.onDisconnect('p_1');
  assert.equal(m.publicView().takeoverPending, undefined, 'the room is not asked while the player may return');

  h.sched.advance(30_000);
  const pending = m.publicView().takeoverPending;
  assert.equal(pending.targetPlayerId, 'p_1');
  assert.deepEqual(pending.candidates.map((c) => c.playerId), ['p_0', 'p_2'], 'the online teammates can step in');
  assert.deepEqual(pending.voters, ['p_0', 'p_2']);

  // the prompt opens a tally: the first vote counts
  const vote = { t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' };
  assert.equal(m.handle('p_0', vote).ok, true);
  assert.equal(m.publicView().takeoverPending, undefined, 'the tally replaced the prompt');
});

test('a player who comes back in time needs no decision', (t) => {
  const h = setup(t);
  const m = h.m;

  m.onDisconnect('p_1');
  h.sched.advance(10_000);
  m.onReconnect('p_1');
  h.sched.advance(30_000);
  assert.equal(m.publicView().takeoverPending, undefined, 'the reconnect cancelled the pending decision');
  assert.equal(m.takeoverPending, null);
});

test('a room of one online player is never asked', (t) => {
  const h = setup(t);
  const m = h.m;
  // everybody but p_0 drops: nobody is left to decide
  for (const id of ['p_1', 'p_2']) {
    m.players.get(id).connected = false;
    m.scheduleTakeover(id);
  }
  h.sched.advance(30_000);
  assert.equal(m.takeoverPending, null, 'a single online player has nobody to ask');
});

test('a seat on AI control and a departed seat need no decision', (t) => {
  const h = setup(t);
  const m = h.m;
  m.players.get('p_1').autoplay = true;
  m.players.get('p_2').left = true;
  m.scheduleTakeover('p_1');
  m.scheduleTakeover('p_2');
  h.sched.advance(30_000);
  assert.equal(m.takeoverPending, null);
});
