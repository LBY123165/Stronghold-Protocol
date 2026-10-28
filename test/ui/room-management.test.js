import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Button } from '../../public/js/ui/components.js';
import { roomFacts, seatCardView } from '../../public/js/screens/room.js';

// The seat card's markup is a plain function of its props (public/js/screens/room.js seatCardView), so the walk
// only follows the markup it produces. A function component in the tree is left alone: rendering it needs a
// component context (the preact hooks), and the walk is after the card's own controls.
function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  yield* walk(node.props?.children);
}

const host = { seat: 0, playerId: 'host', name: 'Host', connected: true, ready: false, isBot: false };
const guest = { seat: 1, playerId: 'guest', name: 'Guest', connected: true, ready: true, isBot: false };
const bot = { seat: 2, playerId: 'bot', name: 'AI', connected: true, ready: true, isBot: true };
const room = (changes = {}) => ({ hostId: host.playerId, mode: 'coop', capacity: 4, inMatch: false, seats: [host, guest, bot, null], ...changes });

test('AI room limit counts only AI, supports zero and unrestricted old frames, and never expands capacity', () => {
  for (const capacity of [4, 8, 20]) {
    const source = room({ capacity });
    assert.equal(roomFacts(source, 'host').canAddBot, true);
    assert.equal(roomFacts({ ...source, maxAiPerRoom: null }, 'host').maxAiPerRoom, null);
    const atLimit = roomFacts({ ...source, maxAiPerRoom: 1 }, 'host');
    assert.equal(atLimit.botCount, 1);
    assert.equal(atLimit.aiLimitReached, true);
    assert.equal(atLimit.aiLimitExceeded, false);
    assert.equal(atLimit.canAddBot, false);
    assert.equal(atLimit.canStart, true);
    const overLimit = roomFacts({ ...source, maxAiPerRoom: 0 }, 'host');
    assert.equal(overLimit.aiLimitExceeded, true);
    assert.equal(overLimit.canStart, false);
  }
  assert.equal(roomFacts(room({ maxAiPerRoom: 19, seats: [host, guest, bot, { ...bot, seat: 3, playerId: 'bot2' }] }), 'host').canAddBot, false);
  assert.equal(roomFacts(room(), 'guest').canAddBot, false);
  assert.equal(roomFacts(room({ inMatch: true }), 'host').canAddBot, false);
  assert.equal(roomFacts(room({ mode: 'solo', capacity: 1, seats: [host] }), 'host').canAddBot, false);
});

test('room transfer eligibility contains only online other humans and never observers or playing matches', () => {
  const offline = { ...guest, seat: 3, playerId: 'offline', connected: false };
  const source = room({ seats: [host, guest, bot, offline], spectators: [{ playerId: 'spectator', connected: true }] });
  assert.deepEqual(roomFacts(source, 'host').transferableHumans.map((s) => s.playerId), ['guest']);
  for (const playerId of ['guest', 'bot', 'spectator', 'missing']) {
    assert.deepEqual(roomFacts(source, playerId).transferableHumans, []);
  }
  assert.deepEqual(roomFacts({ ...source, inMatch: true }, 'host').transferableHumans, []);
});

test('member controls render transfer beside kick, preserve confirmed identities, and disable while busy', () => {
  const source = room();
  const calls = [];
  const props = { seat: guest, index: 1, room: source, facts: roomFacts(source, 'host'), myId: 'host', busy: null,
    onTransferHost: (...args) => calls.push(args), onKick: (...args) => calls.push(args) };
  // the host's 移出 is the upstream corner badge (a plain `.rseat__kick` button — the form the v0.3.3 merge brought
  // back), not a Button component; the branch's 转让房主 stays a Button in the seat foot
  const kickOf = (view) => [...walk(view)].find((n) => n.props?.class === 'rseat__kick');
  const view = seatCardView(props);
  const buttons = [...walk(view)].filter((n) => n.type === Button);
  assert.deepEqual(buttons.map((n) => n.props.icon), ['crown']);
  assert.equal(buttons[0].props['aria-label'], '转让房主给该博士');
  buttons[0].props.onClick();
  const kick = kickOf(view);
  assert.equal(kick.props.title, '将该博士移出同盟');
  kick.props.onClick();
  assert.deepEqual(calls, [[1, 'Guest', 'guest'], [1, 'Guest', 'guest']]);
  // upstream behaviour: a busy lock disables only its own action — the transfer spinner leaves the 移出 badge live,
  // and a pending kick disables the badge but not the transfer button
  const busyView = seatCardView({ ...props, busy: 'transfer1' });
  assert.ok([...walk(busyView)].filter((n) => n.type === Button).every((n) => n.props.disabled));
  assert.equal(kickOf(busyView).props.disabled, false);
  assert.equal(kickOf(seatCardView({ ...props, busy: 'kick1' })).props.disabled, true);
  const botCard = seatCardView({ ...props, seat: bot, index: 2, onRemoveBot: (...args) => calls.push(args) });
  const botKick = kickOf(botCard);
  assert.ok(botKick);
  assert.equal([...walk(botCard)].filter((n) => n.type === Button).length, 0);
  botKick.props.onClick();
  // upstream's 移除 AI 队友 passes the seat alone (the action resolves the player server-side)
  assert.deepEqual(calls.at(-1), [2]);
  // an offline doctor keeps the 移出 badge (upstream draws no online gate on it); a non-host sees no member controls
  assert.ok(kickOf(seatCardView({ ...props, seat: { ...guest, connected: false } })));
  const guestView = seatCardView({ ...props, myId: 'guest', facts: roomFacts(source, 'guest') });
  assert.equal([...walk(guestView)].filter((n) => n.type === Button).length, 0);
  assert.equal(kickOf(guestView), undefined);
});

test('empty seats explain server AI limit and block repeated or conflicting additions', () => {
  const source = room({ maxAiPerRoom: 1 });
  const props = { seat: null, index: 3, room: source, facts: roomFacts(source, 'host'), myId: 'host', busy: null };
  const button = [...walk(seatCardView(props))].find((n) => n.type === Button);
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, '已达到服务器允许的 AI 队友上限');
  const unrestricted = room();
  const busyButton = [...walk(seatCardView({ ...props, room: unrestricted, facts: roomFacts(unrestricted, 'host'), busy: 'transfer1' }))].find((n) => n.type === Button);
  assert.equal(busyButton.props.disabled, true);
});
