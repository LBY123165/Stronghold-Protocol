import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Button } from '../../public/js/ui/components.js';
import { roomFacts, SeatCard } from '../../public/js/screens/room.js';

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
  const buttons = [...walk(SeatCard(props))].filter((n) => n.type === Button);
  assert.deepEqual(buttons.map((n) => n.props.icon), ['crown', 'close']);
  assert.equal(buttons[0].props['aria-label'], '转让房主给该博士');
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  assert.deepEqual(calls, [[1, 'Guest', 'guest'], [1, 'Guest', 'guest']]);
  assert.ok([...walk(SeatCard({ ...props, busy: 'transfer1' }))].filter((n) => n.type === Button).every((n) => n.props.disabled));
  const botCard = SeatCard({ ...props, seat: bot, index: 2, onRemoveBot: (...args) => calls.push(args) });
  const botButtons = [...walk(botCard)].filter((n) => n.type === Button);
  assert.equal(botButtons.length, 1);
  botButtons[0].props.onClick();
  assert.deepEqual(calls.at(-1), [2, 'bot']);
  assert.equal([...walk(SeatCard({ ...props, seat: { ...guest, connected: false } }))].filter((n) => n.type === Button).length, 1);
  assert.equal([...walk(SeatCard({ ...props, myId: 'guest', facts: roomFacts(source, 'guest') }))].filter((n) => n.type === Button).length, 0);
});

test('empty seats explain server AI limit and block repeated or conflicting additions', () => {
  const source = room({ maxAiPerRoom: 1 });
  const props = { seat: null, index: 3, room: source, facts: roomFacts(source, 'host'), myId: 'host', busy: null };
  const button = [...walk(SeatCard(props))].find((n) => n.type === Button);
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, '已达到服务器允许的 AI 队友上限');
  const unrestricted = room();
  const busyButton = [...walk(SeatCard({ ...props, room: unrestricted, facts: roomFacts(unrestricted, 'host'), busy: 'transfer1' }))].find((n) => n.type === Button);
  assert.equal(busyButton.props.disabled, true);
});
