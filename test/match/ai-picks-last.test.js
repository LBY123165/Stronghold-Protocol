// The co-op rule 「AI 队友最后选择」 (GitHub #338): in this capacity branch it is FIXED ON for co-op matches — in the
// strategy draft (BAND_DRAFT) and the 机变 draft (SP_DRAFT) every MANUAL human seat (alive, connected, not under AI 托管)
// picks before every automatic seat (AI, 托管, disconnected), each group keeping its drawn order (a stable partition AFTER
// the usual shuffle, server/match/match/phases.js prioritizeDraftOrder); opts.aiPicksLast is ignored, solo is unaffected.
// A departed seat is not in the order at all. A skip passes the turn to the next MANUAL human still to pick [ASSUMED];
// with none behind it the skip is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

const isAi = (pid) => pid.startsWith('ai_');
/** the stable humans-first partition of a drawn order */
const humansFirst = (order) => [...order.filter((p) => !isAi(p)), ...order.filter(isAi)];
/** humans first, then AI seats, each in seat order — 1 host + 3 AI by default */
const seatsOf = (ids) => ids.map((playerId, seat) => ({ seat, playerId, name: playerId, isBot: isAi(playerId), connected: true }));

/** A match driven to BAND_DRAFT (every human confirms the briefing); `before(m)` runs while still in INFO_CHECK. */
function toBandDraft(o, before) {
  const h = makeMatch({ mode: 'coop', ...o }).start();
  if (before) before(h.m);
  for (const ps of h.m.players.values()) if (!ps.isBot && !ps.left) h.m.handle(ps.playerId, { t: 'g.infoReady' });
  h.run(() => h.m.phase !== PHASE.INFO_CHECK);
  assert.equal(h.m.phase, PHASE.BAND_DRAFT);
  return h;
}

/** The band-draft order (taken at its start, before any skip) and the next draws of the random streams after it. */
function bandOrder(o, before) {
  const h = toBandDraft(o, before);
  const order = h.m.draft.order.slice();
  const draws = { draft: h.m.rngDraft(), shop: h.m.rngShop(), bots: h.m.rngBots(), meta: h.m.rngMeta(), waves: h.m.rngWaves() };
  h.m.dispose();
  return { order, draws };
}

test('fixed on (capacity branch): every co-op match orders the manual humans first; opts.aiPicksLast is ignored, never in solo', () => {
  const mk = (o) => { const h = makeMatch(o); const v = h.m.aiPicksLast; h.m.dispose(); return v; };
  assert.equal(mk({ mode: 'coop', humans: 1, bots: 3 }), true);
  assert.equal(mk({ mode: 'coop', humans: 1, bots: 3, aiPicksLast: true }), true);
  assert.equal(mk({ mode: 'coop', humans: 1, bots: 3, aiPicksLast: false }), true, 'the rule is fixed on');
  assert.equal(mk({ mode: 'solo', humans: 1, aiPicksLast: true }), false, 'solo: nothing to order');
});

test('band draft: the default order is the manual-humans-first partition of the shuffle, and opts.aiPicksLast moves nothing', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const o = { seats: seatsOf(['p_0', 'ai_0', 'ai_1', 'ai_2']), seed };
    const def = bandOrder(o);
    const flagged = bandOrder({ ...o, aiPicksLast: true });
    assert.deepEqual(flagged, def, `seed ${seed}: opts.aiPicksLast is ignored`);
    assert.equal(def.order[0], 'p_0', `seed ${seed}: the manual human picks first`);
  }
});

test('band draft, option on, 1 human + 3 AI: the human always picks first; the same shuffle, every random stream unchanged', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const o = { seats: seatsOf(['p_0', 'ai_0', 'ai_1', 'ai_2']), seed };
    const off = bandOrder(o);
    const on = bandOrder({ ...o, aiPicksLast: true });
    assert.equal(on.order[0], 'p_0', `seed ${seed}`);
    assert.deepEqual(on.order, humansFirst(off.order), `seed ${seed}: the AI seats keep their drawn order`);
    assert.deepEqual(on.draws, off.draws, `seed ${seed}: no extra random draw`);
  }
});

test('band draft, option on, 2 humans + 2 AI on interleaved seats: both humans first, in their drawn order', () => {
  const ids = ['p_0', 'ai_0', 'p_1', 'ai_1'];
  const seen = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const o = { seats: seatsOf(ids), seed };
    const off = bandOrder(o);
    const on = bandOrder({ ...o, aiPicksLast: true });
    assert.deepEqual(on.order, humansFirst(off.order), `seed ${seed}`);
    assert.deepEqual(on.order.slice(0, 2).sort(), ['p_0', 'p_1']);
    seen.add(on.order[0]);
  }
  assert.equal(seen.size, 2, 'the humans\' own order is still drawn (either may lead)');
});

test('band draft, option on: all humans, or all AI seats (tools/matchrun), keep today\'s order', () => {
  for (const ids of [['p_0', 'p_1', 'p_2', 'p_3'], ['ai_0', 'ai_1', 'ai_2', 'ai_3']]) {
    for (let seed = 1; seed <= 4; seed++) {
      const o = { seats: seatsOf(ids), seed };
      if (ids[0] === 'ai_0') {
        // no human: INFO_CHECK ends by itself
        const run = (x) => { const h = makeMatch({ mode: 'coop', ...x }).start(); h.run(() => h.m.phase !== PHASE.INFO_CHECK); const r = h.m.draft.order.slice(); h.m.dispose(); return r; };
        assert.deepEqual(run({ ...o, aiPicksLast: true }), run(o), `all AI, seed ${seed}`);
      } else {
        assert.deepEqual(bandOrder({ ...o, aiPicksLast: true }), bandOrder(o), `all humans, seed ${seed}`);
      }
    }
  }
});

test('band draft: only a MANUAL human is ordered ahead of the automatic seats (AI, 托管, disconnected); a departed seat is dropped', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const o = { seats: seatsOf(['p_0', 'p_1', 'p_2', 'p_3', 'ai_0']), seed };
    const before = (m) => {
      m.handle('p_1', { t: 'g.autoplay', on: true });
      m.onDisconnect('p_2');
      m.onLeave('p_3');
    };
    const h = toBandDraft(o, before);
    assert.ok(!h.m.draft.order.includes('p_3'), `seed ${seed}: the departed seat is out of the order (${h.m.draft.order})`);
    assert.equal(h.m.draft.order[0], 'p_0', `seed ${seed}: the manual human picks first (${h.m.draft.order})`);
    assert.deepEqual([...h.m.draft.order.slice(1)].sort(), ['ai_0', 'p_1', 'p_2'], `seed ${seed}: the automatic seats keep their drawn order`);
    h.m.dispose();
  }
});

test('band draft: a skip passes the turn to the next manual human, ahead of the automatic seats; with none behind it is refused [ASSUMED]', () => {
  const h = toBandDraft({ seats: seatsOf(['p_0', 'ai_0', 'p_1', 'ai_1']), seed: 3 });
  const m = h.m;
  const [h1, h2, a1, a2] = m.draft.order;
  assert.ok(!isAi(h1) && !isAi(h2) && isAi(a1) && isAi(a2), String(m.draft.order));
  // the first human passes: behind the other human, still before the AI seats
  assert.deepEqual(m.handle(h1, { t: 'g.bandSkip' }), { ok: true });
  assert.deepEqual(m.draft.order, [h2, h1, a1, a2]);
  assert.equal(m.draftTurn(), h2);
  // the second human passes: behind the first again
  assert.deepEqual(m.handle(h2, { t: 'g.bandSkip' }), { ok: true });
  assert.deepEqual(m.draft.order, [h1, h2, a1, a2]);
  assert.deepEqual(m.handle(h1, { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
  assert.equal(m.draftTurn(), h2);
  m.dispose();

  // a lone manual human (host + AI): no manual teammate to pass to — the skip is refused, the order is untouched
  const h3 = toBandDraft({ seats: seatsOf(['p_0', 'ai_0', 'ai_1', 'ai_2']), seed: 3 });
  const order = h3.m.draft.order.slice();
  assert.equal(order[0], 'p_0');
  const refused = h3.m.handle('p_0', { t: 'g.bandSkip' });
  assert.equal(refused.error, 'BAD_TARGET');
  assert.match(refused.detail || '', /no manual teammate to pass to/);
  assert.deepEqual(h3.m.draft.order, order);
  h3.m.dispose();

  // the other human has picked already: no manual teammate is left to pass to — refused as well
  const h4 = toBandDraft({ seats: seatsOf(['p_0', 'p_1', 'ai_0', 'ai_1']), seed: 3 });
  const [m1, m2] = h4.m.draft.order;
  assert.ok(!isAi(m1) && !isAi(m2), String(h4.m.draft.order));
  assert.deepEqual(h4.m.handle(m1, { t: 'g.band', bandId: 'band_amiya' }), { ok: true });
  const refused2 = h4.m.handle(m2, { t: 'g.bandSkip' });
  assert.equal(refused2.error, 'BAD_TARGET');
  h4.m.dispose();
});

/** Drive a fake-battle match into the SP draft of round `r`; `flip(m)` runs just before it is entered. */
function toSpDraft(o, r, flip) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', fake: true, ...o }).start();
  const m = h.m;
  h.drive(() => m.phase === PHASE.ROUND_START && m.round === r);
  assert.equal(m.round, r);
  if (flip) flip(m);
  h.run(() => m.phase === PHASE.SP_DRAFT);
  assert.equal(m.phase, PHASE.SP_DRAFT);
  return h;
}

test('机变 draft: setting the flag changes nothing (the rule is fixed on); no random stream moves', () => {
  for (const [ids, seed] of [[['p_0', 'ai_0', 'ai_1', 'ai_2'], 14], [['p_0', 'ai_0', 'p_1', 'ai_1'], 5], [['p_0', 'ai_0', 'ai_1', 'ai_2'], 2]]) {
    const o = { seats: seatsOf(ids), seed };
    const off = toSpDraft(o, 3);
    const on = toSpDraft(o, 3, (m) => { m.aiPicksLast = true; });
    assert.deepEqual(on.m.sp.order, humansFirst(off.m.sp.order), `seed ${seed}`);
    assert.deepEqual(on.m.sp.cards, off.m.sp.cards, 'the same cards');
    for (const k of ['rngDraft', 'rngShop', 'rngBots', 'rngMeta', 'rngWaves']) assert.equal(on.m[k](), off.m[k](), `${k} unchanged (seed ${seed})`);
    off.m.dispose();
    on.m.dispose();
  }
});

test('机变 draft, option on, 1 human + 3 AI: the human picks first in every 机变 round of the match', () => {
  for (const seed of [1, 14]) {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', fake: true, seats: seatsOf(['p_0', 'ai_0', 'ai_1', 'ai_2']), seed, aiPicksLast: true }).start();
    const m = h.m;
    const firsts = {};
    const enter = m.enterSpDraft;
    m.enterSpDraft = function () {
      enter.call(this);
      if (this.sp) firsts[this.round] = this.sp.order[0];
    };
    h.drive(() => h.ended != null || m.round > 9);
    const rounds = m.gd.spRounds().filter((r) => r <= 9);
    assert.deepEqual(rounds, [3, 6, 9]);
    for (const r of rounds) if (firsts[r] != null) assert.equal(firsts[r], 'p_0', `seed ${seed} R${r}`);
    assert.ok(firsts[3] === 'p_0', 'round 3 is always reached');
    m.dispose();
  }
});

test('机变 draft, 2 humans + 2 AI interleaved, one under AI 托管: only the manual human is ahead of the automatic seats', () => {
  const o = { seats: seatsOf(['p_0', 'ai_0', 'p_1', 'ai_1']), seed: 5 };
  const h = toSpDraft({ ...o }, 3, (m) => { m.handle('p_1', { t: 'g.autoplay', on: true }); });
  assert.equal(h.m.sp.order[0], 'p_0', 'the manual human picks first');
  assert.deepEqual([...h.m.sp.order.slice(1)].sort(), ['ai_0', 'ai_1', 'p_1'], 'the 托管 human is ordered with the automatic seats');
  h.m.dispose();
});

test('solo: the rule changes nothing (seat order, no skip)', () => {
  const run = (aiPicksLast) => {
    const h = makeMatch({ mode: 'solo', humans: 1, seed: 7, aiPicksLast }).start();
    h.m.handle('p_0', { t: 'g.infoReady' });
    h.run(() => h.m.phase !== PHASE.INFO_CHECK);
    const r = { order: h.m.draft.order.slice(), next: h.m.rngDraft() };
    h.m.dispose();
    return r;
  };
  assert.deepEqual(run(true), run(undefined));
});
