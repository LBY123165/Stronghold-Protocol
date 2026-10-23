import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore, validAccountName } from '../server/accounts.js';

test('account usernames accept CJK letters as well as ASCII names', () => {
  assert.equal(validAccountName('清歌梶耳'), true);
  assert.equal(validAccountName('玩家𠮷'), true);
  assert.equal(validAccountName('Doctor_01'), true);
  assert.equal(validAccountName('...'), false);
  assert.equal(validAccountName('博士 01'), false);
});

test('account credentials, session token, and skins persist across store reloads', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stronghold-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'accounts.json');
  const first = createAccountStore({ file });
  await first.ready;

  const created = await first.create('清歌梶耳', 'password-123');
  assert.equal(created.error, undefined);
  assert.ok(await first.authenticate(created.token));
  assert.equal((await first.create('清歌梶耳', 'another-password')).error, 'NAME_TAKEN');
  assert.equal((await first.login('清歌梶耳', 'wrong-password')).error, 'BAD_CREDENTIALS');

  const account = await first.authenticate(created.token);
  const skins = { chess_char_1_01_a: 'char_1_skin_2' };
  assert.equal(await first.setSkins(account.id, skins), true);

  const second = createAccountStore({ file });
  await second.ready;
  const login = await second.login('清歌梶耳', 'password-123');
  assert.equal(login.username, '清歌梶耳');
  assert.deepEqual(login.skins, skins);
  assert.equal((await second.authenticate(created.token)).username, '清歌梶耳');
  assert.equal((await second.authenticate(login.token)).username, '清歌梶耳');
});
