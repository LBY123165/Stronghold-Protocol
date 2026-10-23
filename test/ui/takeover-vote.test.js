// 断线接管投票 (GitHub #338 follow-up), the client side: the overlay renders m.public's prompt and tally, offers
// only the options the server published, and only to a voter. Pure view helpers, no browser and no port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { majorityNeeded, votersOf, takeoverVotersOf, canVoteAs, isInMatchSeats, tallyOf, promptOptions } from '../../public/js/ui/takeover.js';
import { activeSeatId } from '../../public/js/store.js';
import { validateC2S } from '../../shared/protocol.js';

test('activeSeatId: the handed-over seat on screen, else the client\'s own seat', () => {
  assert.equal(activeSeatId({ me: { playerId: 'p_0', control: { active: null, seats: [] } } }), 'p_0');
  assert.equal(activeSeatId({ me: { playerId: 'p_0', control: { active: 'p_1', seats: [{ playerId: 'p_1' }] } } }), 'p_1');
  assert.equal(activeSeatId({ me: { playerId: 'p_0' } }), 'p_0', 'no control state yet');
  assert.equal(activeSeatId({}), null);
});

test('the vote needs more than half of the room\'s online players', () => {
  assert.equal(majorityNeeded(2), 2, 'two voters: one is the majority');
  assert.equal(majorityNeeded(3), 2);
  assert.equal(majorityNeeded(4), 3);
  assert.equal(majorityNeeded(5), 3);
  assert.equal(majorityNeeded(1), 1, 'a lone voter decides alone (the server never opens such a vote)');
});

test('voters: the tally\'s eligible list, the prompt fallback, and never the ballots already cast', () => {
  assert.deepEqual(votersOf(null, ['p_0', 'p_2']), ['p_0', 'p_2'], 'no tally yet: the prompt lists them');
  assert.deepEqual(votersOf({ eligible: ['p_0', 'p_2'], voters: ['p_0'] }, ['p_9']), ['p_0', 'p_2'],
    'the tally\'s electorate wins over its ballots');
  assert.deepEqual(votersOf({ voters: ['p_0'] }, ['p_0', 'p_2']), ['p_0'],
    'an older tally without eligible falls back to its ballots, so the panel still renders');
  assert.deepEqual(votersOf({ eligible: [] }, ['p_0']), [], 'an empty electorate is not the prompt fallback');
});

test('takeoverVotersOf: the prompt is gone once the tally opens, and the panel must not throw', () => {
  const vote = { targetPlayerId: 'p_1', eligible: ['p_0', 'p_2'], voters: ['p_0'], options: [], needed: 2 };
  // the exact state after the first click: takeoverPending is null while takeoverVote is present
  assert.deepEqual(takeoverVotersOf({ takeoverVote: vote }), ['p_0', 'p_2']);
  assert.deepEqual(takeoverVotersOf({ takeoverPending: { voters: ['p_0', 'p_2'] } }), ['p_0', 'p_2']);
  assert.deepEqual(takeoverVotersOf({}), []);
});

test('the ballot of one player does not lock the other voters out', () => {
  const vote = {
    eligible: ['p_0', 'p_2'],
    voters: ['p_0'],
    options: [
      { mode: 'bot', candidatePlayerId: null, candidateName: null, votes: 1, voterIds: ['p_0'] },
      { mode: 'handover', candidatePlayerId: null, candidateName: null, votes: 0, voterIds: [] },
    ],
    needed: 2,
  };
  const voters = takeoverVotersOf({ takeoverVote: vote });
  assert.equal(canVoteAs(voters, 'p_0', true), true);
  assert.equal(canVoteAs(voters, 'p_2', true), true, 'the second voter is still eligible after the first ballot');
});

test('canVoteAs: only a voter, only online, and never without an identity', () => {
  assert.equal(canVoteAs(['p_0', 'p_1'], 'p_0', true), true);
  assert.equal(canVoteAs(['p_0', 'p_1'], 'p_9', true), false, 'an outsider does not vote');
  assert.equal(canVoteAs(['p_0'], 'p_0', false), false, 'offline: the button is disabled');
  assert.equal(canVoteAs(['p_0'], null, true), false, 'no identity yet');
});

test('isInMatchSeats: a seat in this match counts, a spectator seat does not', () => {
  const players = [{ playerId: 'p_0', name: '甲' }, { playerId: 'p_1', name: '乙' }];
  assert.equal(isInMatchSeats(players, 'p_0'), true, 'a player in the match');
  assert.equal(isInMatchSeats(players, 'p_spec'), false, 'a spectator seat that came in from outside');
  assert.equal(isInMatchSeats(players, null), false, 'no identity yet');
  assert.equal(isInMatchSeats(undefined, 'p_0'), false, 'no player list yet');
});

test('tallyOf: each side\'s count, its voters and whether it has won', () => {
  const vote = {
    needed: 2,
    voters: ['p_0', 'p_2'],
    options: [
      { mode: 'bot', candidatePlayerId: null, candidateName: null, votes: 1, voterIds: ['p_0'] },
      { mode: 'handover', candidatePlayerId: 'p_2', candidateName: '博士 B', votes: 0, voterIds: [] },
    ],
  };
  assert.deepEqual(tallyOf(vote, 0, 'p_0'), { votes: 1, needed: 2, voterIds: ['p_0'], done: false, mine: true });
  assert.deepEqual(tallyOf(vote, 0, 'p_2'), { votes: 1, needed: 2, voterIds: ['p_0'], done: false, mine: false },
    'another voter\'s ballot is not the own one');
  assert.deepEqual(tallyOf(vote, 1), { votes: 0, needed: 2, voterIds: [], done: false, mine: false });
  vote.options[1] = { ...vote.options[1], votes: 2, voterIds: ['p_2'] };
  assert.equal(tallyOf(vote, 1).done, true, 'a side at the threshold has won');
  assert.deepEqual(tallyOf({ options: [] }, 1, 'p_0'), { votes: 0, needed: 1, voterIds: [], done: false, mine: false },
    'a partial snapshot renders an empty side instead of throwing');
});

test('promptOptions: the AI side always, a handover side only when a teammate can step in', () => {
  const pending = { candidates: [{ playerId: 'p_0', name: '博士 A' }, { playerId: 'p_2', name: '博士 B' }] };
  const both = promptOptions(pending, 2);
  assert.equal(both.length, 2);
  assert.equal(both[0].mode, 'bot');
  assert.equal(both[0].candidatePlayerId, null);
  assert.equal(both[1].mode, 'handover');
  assert.deepEqual(both[1].candidates.map((c) => c.playerId), ['p_0', 'p_2']);

  // nobody has spare capacity: an AI takeover is the only way
  const alone = promptOptions({ candidates: [] }, 1);
  assert.equal(alone.length, 1);
  assert.equal(alone[0].mode, 'bot');
});

test('the wire form of a ballot is what the protocol accepts', () => {
  // validateC2S returns null for an accepted message and an Error for a refused one
  const ok = (msg) => validateC2S(msg) == null;
  assert.equal(ok({ t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'bot' }), true);
  assert.equal(ok({ t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover', candidatePlayerId: 'p_0' }), true);
  assert.equal(ok({ t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'swap' }), false, 'only bot | handover');
  // the candidate itself is optional on the wire (the lobby's room.join uses the same shape): a handover without one
  // passes the protocol and is refused by the match, which is what test/match/takeover-vote.test.js asserts
  assert.equal(ok({ t: 'g.takeoverVote', targetPlayerId: 'p_1', mode: 'handover' }), true);
  assert.equal(ok({ t: 'g.takeoverVote', targetPlayerId: '', mode: 'bot' }), false, 'the seat id is required');
  // 断线接管 seat switch: own seat (absent) or one controlled seat
  assert.equal(ok({ t: 'g.control' }), true, 'absent playerId = own seat');
  assert.equal(ok({ t: 'g.control', playerId: 'p_1' }), true);
  assert.equal(ok({ t: 'g.control', playerId: '' }), false, 'an empty id is not a seat');
});