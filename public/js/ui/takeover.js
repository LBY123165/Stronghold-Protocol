// 断线接管投票 (GitHub #338 follow-up): a teammate dropped and is not on AI control, so the room decides how the
// seat is filled — an AI takes it over, or a teammate with spare capacity steps into it. The vote is server-owned:
// m.public carries the prompt (takeoverPending) and the tally (takeoverVote), so a reconnect renders the current
// state, and a spectator's seat votes too.
import { useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { actions } from './gameActions.js';
import { useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';

// ---- view helpers (pure — the tests drive these without a browser) ----

/** A vote needs more than half of the room's online players; with one voter, that voter decides. */
export function majorityNeeded(voterCount) {
  return Math.floor(voterCount / 2) + 1;
}

/** Who may vote: the tally's own list, or the prompt's before anyone answered. */
export function votersOf(vote, fallback) {
  if (vote?.voters?.length) return vote.voters;
  return fallback ?? [];
}

/** Only a voter may vote, and only while the connection is up. */
export function canVoteAs(voters, myId, online) {
  return !!myId && !!online && voters.includes(myId);
}

/**
 * Whether this player holds a seat in the match. A spectator seat that came in from outside does not: the
 * decision belongs to the players taking part, so the overlay is not shown to it at all.
 */
export function isInMatchSeats(players, myId) {
  if (!myId) return false;
  return (players || []).some((p) => p.playerId === myId);
}

/** One side of the tally: its count, who is on it, whether it has won, and whether it is the own ballot. */
export function tallyOf(vote, index, myId = null) {
  const option = vote.options[index];
  const voterIds = option.voterIds ?? [];
  return {
    votes: option.votes ?? voterIds.length,
    needed: vote.needed,
    voterIds,
    done: (option.votes ?? voterIds.length) >= vote.needed,
    mine: !!myId && voterIds.includes(myId),
  };
}

/** The prompt's two options: an AI takeover always, a handover only when a teammate can step in. */
export function promptOptions(pending) {
  const options = [{ mode: 'bot', label: t('AI 接管'), candidatePlayerId: null, candidates: [] }];
  const candidates = pending?.candidates ?? [];
  if (candidates.length) options.push({ mode: 'handover', label: t('队友接替'), candidatePlayerId: candidates[0].playerId, candidates });
  return options;
}

// ---- the overlay ----

/** One side of the vote: its label, its tally, its bar and the pick button. */
function OptionRow({ label, tally, disabled, onPick, children }) {
  return html`<div class=${'takeover-opt' + (tally.mine ? ' is-mine' : '') + (tally.done ? ' is-done' : '')}>
    <div class="takeover-opt__head">
      <strong>${label}</strong>
      <span class="takeover-opt__tally">${t('{votes}/{needed} 票', { votes: tally.votes, needed: tally.needed })}</span>
    </div>
    <div class="takeover-opt__bar" role="progressbar" aria-valuenow=${tally.votes} aria-valuemin=${0} aria-valuemax=${tally.needed}>
      <i style=${`width:${Math.min(100, Math.round((tally.votes / tally.needed) * 100))}%`}></i>
    </div>
    ${children ? html`<div class="takeover-opt__body">${children}<//>` : null}
    <${Button} size="sm" disabled=${disabled || tally.done} onClick=${onPick}>${tally.mine ? t('已选择') : t('投此选项')}<//>
  </div>`;
}

/** Nothing rendered while no seat waits for a decision. */
export function TakeoverHost() {
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const online = useStore((s) => s.connection.status === 'online');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const pending = pub?.takeoverPending ?? null;
  const vote = pub?.takeoverVote ?? null;
  if (!pending && !vote) return null;

  const send = async (fn) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await fn(); } finally { inFlight.current = false; setBusy(false); }
  };

  const targetPlayerId = vote?.targetPlayerId ?? pending.targetPlayerId;
  const targetName = vote?.targetName ?? pending.targetName;
  const voters = votersOf(vote, pending.voters);
  const canVote = canVoteAs(voters, myId, online);
  const nameOf = (id) => pub?.players?.find((p) => p.playerId === id)?.name || id;
  // A spectator seat that came in from outside only watches: the decision belongs to the players in this match,
  // so the overlay is not shown to it at all.
  const inMatch = isInMatchSeats(pub?.players, myId);
  if (!inMatch) return null;
  const note = !online ? t('连接断开，暂时无法投票。')
    : !canVote ? t('你不在这局的对局席位里，无法参与该决定。') : null;
  const voterRow = html`<div class="takeover__voters">${voters.map((id) => html`<span key=${id}>${nameOf(id)}<//>`)}<//>`;

  // the prompt: nobody answered yet, so the room is asked how the seat is filled
  if (!vote) {
    const needed = majorityNeeded(voters.length);
    const blank = { votes: 0, needed, voterIds: [], done: false, mine: false };
    const options = promptOptions(pending);
    return html`<section class="takeover" aria-label=${t('断线接管')} aria-live="polite">
      <div class="takeover__head">
        <strong>${t('{name} 掉线了', { name: targetName })}<//>
        <span>${t('未开启 AI 托管，房间需要决定这个席位由谁接管。')}<//>
      </div>
      <div class="takeover__opts">
        ${options.map((option) => html`<${OptionRow} key=${option.mode} label=${option.label} tally=${blank}
          disabled=${!canVote || busy}
          onPick=${() => send(() => actions.takeoverVote(targetPlayerId, option.mode, option.candidatePlayerId))}>
          ${option.mode === 'handover' && option.candidates.length > 1
            ? html`<ul class="takeover-cands">${option.candidates.map((c) => html`<li key=${c.playerId}>${c.name}<//>`)}<//>` : null}
        <//>`)}
      </div>
      ${options.length === 1 ? html`<p class="takeover__note">${t('没有有余力的队友可接替，只能由 AI 接管。')}<//>` : null}
      ${note ? html`<p class="takeover__note">${note}<//>` : null}
      ${voterRow}
    <//>`;
  }

  // the tally: the first vote opened it and the room is counting
  const handover = vote.options[1];
  const sides = [
    { key: 'bot', label: t('AI 接管'), mode: 'bot', candidate: null },
    { key: 'handover', label: handover.candidateName || t('队友接替'), mode: 'handover', candidate: handover.candidatePlayerId },
  ];
  return html`<section class="takeover" aria-label=${t('断线接管投票')} aria-live="polite">
    <div class="takeover__head">
      <strong>${t('{name} 席位接管投票：{votes}/{needed}', { name: vote.targetName, votes: vote.voters.length, needed: vote.needed })}<//>
      <span>${t('某一项过半数即生效。')}<//>
    </div>
    <div class="takeover__opts">
      ${sides.map((side, index) => html`<${OptionRow} key=${side.key} label=${side.label}
        tally=${tallyOf(vote, index, myId)} disabled=${!canVote || busy || !side.candidate && side.mode === 'handover'}
        onPick=${() => send(() => actions.takeoverVote(targetPlayerId, side.mode, side.candidate))}><//>`)}
    </div>
    ${note ? html`<p class="takeover__note">${note}<//>` : null}
    ${voterRow}
  <//>`;
}