// 断线接管投票 (GitHub #338 follow-up): a teammate dropped and is not on AI control, so the room decides how the
// seat is filled — an AI takes it over, or a teammate with spare capacity steps into it. The vote is server-owned:
// m.public carries the prompt (takeoverPending) and the tally (takeoverVote), so a reconnect renders the current
// state. The players seated in this match vote; a spectator seat that came in from outside only watches.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { actions } from './gameActions.js';
import { useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';

// ---- view helpers (pure — the tests drive these without a browser) ----

/** How long the panel stays open before it folds into the side chip; the decision itself stays open. */
export const AUTO_COLLAPSE_MS = 10_000;

/** A vote needs more than half of the room's online players; with one voter, that voter decides. */
export function majorityNeeded(voterCount) {
  return Math.floor(voterCount / 2) + 1;
}

/**
 * Who may vote: the tally's own eligible list, or the prompt's before anyone answered.
 *
 * The tally's `voters` is the list of ballots already cast, never the electorate. Older snapshots did not
 * publish `eligible`; they fall back to `voters` so the panel still renders, but the current server always
 * publishes `eligible` and that list decides `canVote`.
 */
export function votersOf(vote, fallback) {
  if (Array.isArray(vote?.eligible)) return vote.eligible;
  if (Array.isArray(vote?.voters)) return vote.voters;
  return Array.isArray(fallback) ? fallback : [];
}

/**
 * The electorate of the current panel, read from either shape of m.public. `takeoverPending` is cleared the
 * moment the first ballot opens the tally, so `pending` must be read with optional chaining — the old
 * `votersOf(vote, pending.voters)` threw `Cannot read properties of null (reading 'voters')` right after the
 * first click.
 */
export function takeoverVotersOf(pub) {
  return votersOf(pub?.takeoverVote, pub?.takeoverPending?.voters);
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
  // a partial / older snapshot must not crash the tally while the room is deciding
  const option = vote?.options?.[index] ?? { votes: 0, voterIds: [] };
  const voterIds = Array.isArray(option.voterIds) ? option.voterIds : [];
  const votes = Number.isFinite(option.votes) ? option.votes : voterIds.length;
  const needed = Number.isFinite(vote?.needed) ? vote.needed : 1;
  return {
    votes,
    needed,
    voterIds,
    done: votes >= needed,
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
      <i style=${`width:${tally.needed > 0 ? Math.min(100, Math.round((tally.votes / tally.needed) * 100)) : 0}%`}></i>
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
  const pending = pub?.takeoverPending ?? null;
  const vote = pub?.takeoverVote ?? null;
  const targetKey = vote?.targetPlayerId ?? pending?.targetPlayerId ?? null;
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const clock = useRef({ at: 0, serverNow: 0 });
  const autoFolded = useRef(null);

  // the server's clock at the snapshot, so the ceiling counts down even when the browser clock is off
  useEffect(() => {
    const serverNow = Number(pub?.serverNow);
    if (Number.isFinite(serverNow)) clock.current = { at: Date.now(), serverNow };
  }, [pub?.serverNow]);

  // a new seat starts open; folding is a per-decision choice, not a permanent preference
  useEffect(() => {
    setCollapsed(false);
    autoFolded.current = null;
  }, [targetKey]);

  // the panel steps aside after a while instead of covering the board; the vote itself stays open, and the
  // right-edge chip keeps it one click away (user request: 收起，过一段时间再处理)
  useEffect(() => {
    if (!targetKey) return undefined;
    const timer = setTimeout(() => {
      if (autoFolded.current === targetKey) return;
      autoFolded.current = targetKey;
      setCollapsed(true);
    }, AUTO_COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [targetKey]);

  useEffect(() => {
    if (!vote?.endsAt) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [vote?.endsAt]);

  if (!pending && !vote) return null;

  const send = async (fn) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await fn(); } finally { inFlight.current = false; setBusy(false); }
  };

  const targetPlayerId = targetKey;
  const targetName = vote?.targetName ?? pending?.targetName ?? '';
  const voters = takeoverVotersOf(pub);
  const canVote = canVoteAs(voters, myId, online);
  const nameOf = (id) => pub?.players?.find((p) => p.playerId === id)?.name || id;
  // A spectator seat that came in from outside only watches: the decision belongs to the players in this match,
  // so the overlay is not shown to it at all.
  const inMatch = isInMatchSeats(pub?.players, myId);
  if (!inMatch) return null;

  const clockNow = clock.current.at
    ? clock.current.serverNow + (now - clock.current.at)
    : (Number(pub?.serverNow) || now);
  const secondsLeft = vote?.endsAt ? Math.max(0, Math.ceil((vote.endsAt - clockNow) / 1000)) : null;
  const ballots = vote?.voters?.length ?? 0;
  const note = !online ? t('连接断开，暂时无法投票。')
    : !canVote ? t('你不在这局的对局席位里，无法参与该决定。') : null;
  const voterRow = html`<div class="takeover__voters">${voters.map((id) => html`<span key=${id}>${nameOf(id)}<//>`)}<//>`;
  const fold = html`<button type="button" class="takeover__fold" title=${t('收起，稍后处理')}
    aria-label=${t('收起接管面板')} onClick=${() => setCollapsed(true)}>${t('收起')}</button>`;

  // folded: a small right-edge chip keeps the pending decision visible and one click away
  if (collapsed) {
    return html`<button type="button" class="takeover-chip" aria-expanded=${false}
      aria-label=${t('展开接管投票')} onClick=${() => setCollapsed(false)}>
      <span class="takeover-chip__mark" aria-hidden="true">!</span>
      <span class="takeover-chip__name">${targetName}</span>
      <span class="takeover-chip__state">${vote ? t('{votes}/{needed} 票', { votes: ballots, needed: vote.needed }) : t('等待接管决定')}</span>
      ${secondsLeft != null ? html`<span class="takeover-chip__time">${t('剩余 {sec} 秒', { sec: secondsLeft })}</span>` : null}
      <span class="takeover-chip__open">${t('展开')}</span>
    </button>`;
  }

  // the prompt: nobody answered yet, so the room is asked how the seat is filled
  if (!vote) {
    const needed = majorityNeeded(voters.length);
    const blank = { votes: 0, needed, voterIds: [], done: false, mine: false };
    const options = promptOptions(pending);
    return html`<section class="takeover" aria-label=${t('断线接管')} aria-live="polite">
      ${fold}
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
  const handover = vote.options?.[1] ?? null;
  const sides = [
    { key: 'bot', label: t('AI 接管'), mode: 'bot', candidate: null },
    { key: 'handover', label: handover?.candidateName || t('队友接替'), mode: 'handover', candidate: handover?.candidatePlayerId ?? null },
  ];
  return html`<section class="takeover" aria-label=${t('断线接管投票')} aria-live="polite">
    ${fold}
    <div class="takeover__head">
      <strong>${t('{name} 席位接管投票：{votes}/{needed}', { name: vote.targetName, votes: ballots, needed: vote.needed })}<//>
      <span>${t('某一项过半数即生效。')}${secondsLeft != null ? html` · ${t('剩余 {sec} 秒', { sec: secondsLeft })}` : null}<//>
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