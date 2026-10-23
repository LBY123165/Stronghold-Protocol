// The room screen's 「AI 队友最后选择」 indicator (GitHub #338; the server's room.setAiPicksLast is refused in this
// capacity branch — the rule is fixed on): co-op rooms only, always on and read-only, no request is sent; the texts go
// through t() with English in public/i18n/en.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'public/js/screens/room.js'), 'utf8');
const EN = JSON.parse(readFileSync(path.join(ROOT, 'public/i18n/en.json'), 'utf8'));
const mod = () => import(pathToFileURL(path.join(ROOT, 'public/js/screens/room.js')).href);

const room = (o = {}) => ({
  code: 'ABCD', hostId: 'h', mode: 'coop', difficulty: 'NORMAL', aiPicksLast: false,
  seats: [{ seat: 0, playerId: 'h', name: 'Host', isBot: false, ready: false, connected: true }, { seat: 1, playerId: 'g', name: 'G', isBot: false, ready: false, connected: true }, null, null],
  ...o,
});

test('aiLastOption: hidden in solo, always on and read-only in co-op (the branch fixes the rule)', async () => {
  const { aiLastOption } = await mod();
  assert.equal(aiLastOption(room({ mode: 'solo' })), null, 'solo: no AI teammates');
  assert.deepEqual(aiLastOption(room()), { on: true, editable: false });
  assert.deepEqual(aiLastOption(room({ aiPicksLast: true })), { on: true, editable: false });
  assert.deepEqual(aiLastOption(room({ aiPicksLast: undefined })), { on: true, editable: false }, 'an older server');
  assert.equal(aiLastOption(null), null);
});

test('room.js shows the fixed rule through t() and never asks the server to toggle it; en.json has the English', () => {
  assert.doesNotMatch(SRC, /room\.setAiPicksLast/, 'the rule cannot be turned off in this branch');
  for (const zh of ['AI 队友最后选择', '固定规则', '本分支固定由在线且未托管的博士先选，AI、托管和掉线席位随后选择']) {
    assert.ok(SRC.includes(`t('${zh}')`), zh);
    assert.equal(typeof EN[zh], 'string', `en.json: ${zh}`);
    assert.ok(EN[zh].length > 0 && !/[一-鿿]/.test(EN[zh]), `English for ${zh}`);
  }
});
