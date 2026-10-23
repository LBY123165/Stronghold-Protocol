import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAccountStores } from '../tools/accounts-import.mjs';

test('merging an old account store restores skins and adds missing accounts without replacing current credentials', () => {
  const oldStore = {
    version: 1,
    accounts: {
      a: { username: 'A', passwordHash: 'old', skins: { c1: 'old-c1', c2: 'old-c2' }, tokens: [{ hash: 'old-token' }] },
      b: { username: 'B', passwordHash: 'b', skins: { c3: 'b-c3' }, tokens: [{ hash: 'b-token' }] },
    },
  };
  const currentStore = {
    version: 1,
    accounts: {
      a: { username: 'A', passwordHash: 'new', banned: true, skins: { c1: 'new-c1' }, tokens: [{ hash: 'new-token' }] },
    },
  };
  const { store, stats } = mergeAccountStores(oldStore, currentStore);
  assert.equal(stats.added, 1);
  assert.equal(stats.kept, 1);
  assert.equal(stats.skinsRestored, 1);
  assert.equal(store.accounts.a.passwordHash, 'new', 'the current password wins');
  assert.equal(store.accounts.a.banned, true, 'the current ban wins');
  assert.deepEqual(store.accounts.a.skins, { c1: 'new-c1', c2: 'old-c2' });
  assert.deepEqual(store.accounts.a.tokens, [{ hash: 'new-token' }], 'old tokens are not resurrected on an existing account');
  assert.equal(store.accounts.b.username, 'B', 'an account only in the old store is added');
  assert.deepEqual(store.accounts.b.skins, { c3: 'b-c3' });
  assert.deepEqual(store.accounts.b.tokens, [{ hash: 'b-token' }]);
});
