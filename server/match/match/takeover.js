// 断线接管投票 (GitHub #338 follow-up): a teammate's seat is disconnected and its player is not on AI control.
// The other players of the room decide how the seat is filled: an AI takes it over, or another teammate with
// spare capacity steps into it. The decision is a vote of the room's online players (the player seats and the
// spectator seats alike), so a player who came in to watch can have a say.
//
// [ASSUMED] Remake convenience: the vote needs a majority of the room's online players, the two options are
// mutually exclusive, and the vote closes as soon as one of them has the majority. These are not official mode
// rules. The official mode has no such vote at all: a disconnected seat simply keeps its last lineup and the
// server simulates it.
//
// Installed on Match.prototype like the other method containers. The lobby authorizes who may vote.
import { ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { OK, fail, FLOW_TICKER_PRIORITY } from './common.js';

/** How long a takeover vote stays open before it is dropped (ms of match time). */
export const TAKEOVER_VOTE_MS = 45_000;

/**
 * How long a disconnected seat waits before the room is asked to decide (ms of match time). The player gets
 * this long to come back; a reconnect before it ends cancels the vote.
 */
export const TAKEOVER_GRACE_MS = 20_000;

/** A vote needs more than half of the room's online players; with one voter, that voter decides. */
function majorityOf(voters) {
  return Math.floor(voters.length / 2) + 1;
}

export class MatchTakeover {
  /**
   * The takeover vote's public view: the open vote, its options and the tally. The bodies never ride the
   * snapshot; the player ids are the room's own.
   * @returns {null | { id: number, targetPlayerId: string, targetName: string, options: object[], voters: string[],
   *   needed: number, endsAt: number }}
   */
  takeoverVoteView() {
    const vote = this.takeoverVote;
    if (!vote) return null;
    const options = vote.options.map((option) => ({
      mode: option.mode,
      candidatePlayerId: option.candidatePlayerId || null,
      candidateName: option.candidateName || null,
      votes: option.votes.size,
      // who is on this side, so a player sees their own ballot and may change it
      voterIds: [...option.votes],
    }));
    return {
      id: vote.id,
      targetPlayerId: vote.targetPlayerId,
      targetName: vote.targetName,
      options,
      voters: [...vote.voters],
      needed: vote.needed,
      endsAt: vote.endsAt,
    };
  }

  /**
   * The disconnected seat that needs a decision: a human whose socket is gone and who is not on AI control.
   * A seat that is already on AI control needs no vote, and a departed player is not coming back.
   */
  takeoverCandidate() {
    for (const ps of this.humans()) {
      if (ps.connected || ps.left || ps.autoplay) continue;
      if (this.takeoverVote && this.takeoverVote.targetPlayerId === ps.playerId) continue;
      return ps;
    }
    return null;
  }

  /**
   * Who may vote: the room's online players and its spectator seats — a spectator came into the room too and has
   * a say. The disconnected seat's owner is excluded: their own seat is decided by the others.
   */
  takeoverVoters() {
    const voters = [];
    for (const ps of this.humans()) {
      if (!ps.connected || ps.left) continue;
      voters.push(ps.playerId);
    }
    for (const s of this.spectators.values()) {
      if (!s || s.left || !s.connected) continue;
      if (!voters.includes(s.playerId)) voters.push(s.playerId);
    }
    return voters;
  }

  /**
   * The teammates who could step into the seat: online, not on AI control and not the seat's owner. A player
   * who is already in the match keeps their own seat; stepping in is only offered to a player with spare
   * capacity, so a player who is on AI control (托管) is not asked.
   */
  takeoverCandidates(targetPlayerId) {
    return this.humans().filter((ps) => ps.playerId !== targetPlayerId && ps.connected && !ps.left && !ps.autoplay);
  }

  /**
   * A seat's player dropped: give them a moment to come back, then ask the room to decide how the seat is
   * filled. A reconnect before the grace ends cancels the pending decision.
   * @param {string} playerId the disconnected seat's owner
   */
  scheduleTakeover(playerId) {
    if (this.disposed || this.ended) return;
    if (this._takeoverGrace.has(playerId)) return;
    const h = this.later(TAKEOVER_GRACE_MS, () => {
      this._takeoverGrace.delete(playerId);
      const ps = this.players.get(playerId);
      // the player came back, or the seat is not the one that needs a decision
      if (!ps || ps.connected || ps.left || ps.autoplay) return;
      if (this.takeoverVote && this.takeoverVote.targetPlayerId === playerId) return;
      if (this.takeoverVoters().length < 2) return; // nobody else can decide it
      // the room is asked: the prompt appears, the first vote opens the tally
      this.takeoverPending = playerId;
      this.markPublic();
    });
    if (h) this._takeoverGrace.set(playerId, h);
  }

  /** The player came back before the room was asked: no decision is needed. */
  cancelTakeover(playerId) {
    const h = this._takeoverGrace.get(playerId);
    if (h) {
      this._takeoverGrace.delete(playerId);
      this.cancel(h);
    }
    if (this.takeoverPending === playerId) {
      this.takeoverPending = null;
      this.markPublic();
    }
    if (this.takeoverVote && this.takeoverVote.targetPlayerId === playerId) {
      this.takeoverVote = null;
      this.markPublic();
    }
  }

  /**
   * The seat that waits for the room's decision, as the client shows it: the seat's owner, the teammates who
   * could step in and the players who may vote.
   * @returns {null | { targetPlayerId: string, targetName: string, candidates: object[], voters: string[] }}
   */
  takeoverPendingView() {
    if (!this.takeoverPending) return null;
    const target = this.players.get(this.takeoverPending);
    if (!target || target.connected || target.left || target.autoplay) return null;
    return {
      targetPlayerId: target.playerId,
      targetName: target.name,
      candidates: this.takeoverCandidates(target.playerId)
        .map((p) => ({ playerId: p.playerId, name: p.name })),
      voters: this.takeoverVoters(),
    };
  }

  /**
   * g.takeoverVote { targetPlayerId, mode, candidatePlayerId? }: a vote for one of the two ways to fill the seat.
   * The first vote opens the vote; the later ones add to the tally. A vote for a different option replaces this
   * voter's earlier one, so a player can change their mind.
   */
  voteTakeover(ps, { targetPlayerId, mode, candidatePlayerId } = {}) {
    if (this.disposed || this.ended) return fail(ERR.WRONG_PHASE);
    if (!ps || ps.isBot || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    const target = this.players.get(targetPlayerId);
    if (!target || target.isBot || target.left) return fail(ERR.BAD_TARGET, 'no such seat');
    if (target.connected) return fail(ERR.BAD_TARGET, 'that seat is connected');
    if (target.autoplay) return fail(ERR.BAD_TARGET, 'that seat is already on AI control');

    let vote = this.takeoverVote;
    if (!vote || vote.targetPlayerId !== targetPlayerId) {
      const voters = this.takeoverVoters();
      if (!voters.includes(ps.playerId)) return fail(ERR.NOT_IN_ROOM, 'only the room\'s players vote');
      if (voters.length < 2) return fail(ERR.BAD_TARGET, 'nobody else can decide this seat');
      const now = this.sched.now();
      vote = this.takeoverVote = {
        id: ++this._takeoverVoteSeq,
        targetPlayerId,
        targetName: target.name,
        // both options start empty; a vote for one of them fills its side
        options: [
          { mode: 'bot', candidatePlayerId: null, candidateName: null, votes: new Set() },
          { mode: 'handover', candidatePlayerId: null, candidateName: null, votes: new Set() },
        ],
        voters: new Set(),
        needed: majorityOf(voters),
        endsAt: now + TAKEOVER_VOTE_MS,
      };
      // the tally replaces the prompt: the room has answered
      if (this.takeoverPending === targetPlayerId) this.takeoverPending = null;
    }
    if (vote.voters.has(ps.playerId)) {
      // a player may change their mind: the earlier vote is withdrawn first
      for (const option of vote.options) option.votes.delete(ps.playerId);
    }
    vote.voters.add(ps.playerId);
    const option = mode === 'bot'
      ? vote.options[0]
      : vote.options[1];
    if (mode === 'handover') {
      const candidate = this.takeoverCandidates(targetPlayerId).find((p) => p.playerId === candidatePlayerId);
      if (!candidate) return fail(ERR.BAD_TARGET, 'that teammate cannot step in');
      option.candidatePlayerId = candidate.playerId;
      option.candidateName = candidate.name;
    } else {
      option.candidatePlayerId = null;
      option.candidateName = null;
    }
    option.votes.add(ps.playerId);
    this.markPublic();
    this._resolveTakeoverVote();
    return OK;
  }

  /** Close the vote as soon as one option has the majority, and apply it. */
  _resolveTakeoverVote() {
    const vote = this.takeoverVote;
    if (!vote) return;
    const winner = vote.options.find((option) => option.votes.size >= vote.needed);
    if (!winner) {
      this.markPublic();
      return;
    }
    this.takeoverVote = null;
    this._applyTakeover(vote, winner);
  }

  /** Apply the vote's outcome: the seat becomes an AI's, or a teammate steps into it. */
  _applyTakeover(vote, winner) {
    const target = this.players.get(vote.targetPlayerId);
    if (!target || target.left || target.connected) return;
    if (winner.mode === 'bot') {
      // the seat keeps its lineup; the server takes it over (the same way a disconnected seat is simulated)
      target.autoplay = true;
      this.refreshDraftPriority(target.playerId);
      this.refreshUniteSkipVote();
      this.markPublic();
      this.tickerText(msg('断线接管：{name} 的席位由 AI 接管', { name: target.name }), FLOW_TICKER_PRIORITY);
      return;
    }
    // a teammate steps into the seat: the seat's player becomes the candidate, and the disconnected player is
    // out of the match (their lineup stays on the board until the new player's first turn).
    const candidate = this.players.get(winner.candidatePlayerId);
    if (!candidate || candidate.left || !candidate.connected) return;
    target.autoplay = false;
    this.refreshDraftPriority(target.playerId);
    this.refreshUniteSkipVote();
    this.markPublic();
    this.tickerText(msg('断线接管：{name} 接替 {name2} 的席位', { name: candidate.name, name2: target.name }), FLOW_TICKER_PRIORITY);
  }
}
