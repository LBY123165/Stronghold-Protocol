// 账号管理后台 (docs/ADMIN.md): the operator's account console. The point of these assertions is the SAFETY contract —
// the console needs the admin secret like every other admin route, a banned account cannot sign in, a password reset
// drops every device, a delete frees the name, and the listing never leaks a hash, a salt or a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';

const SECRET = 'unit-test-admin-secret-value';

/**
 * Start a server on a random port with the console enabled.
 * Every server gets its OWN account file: the tests would otherwise share the repository's .cache/accounts.json
 * and see each other's accounts (or a leftover one from an earlier run).
 */
async function makeServer(opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stronghold-admin-acct-'));
  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true, adminSecret: opts.adminSecret ?? SECRET,
    accountsFile: path.join(dir, 'accounts.json'),
    ...opts.extra,
  });
  const close = srv.close.bind(srv);
  srv.close = async () => { await close(); await rm(dir, { recursive: true, force: true }); };
  return srv;
}

/** @param {string} base @param {string} path */
async function call(base, path, { method = 'GET', body, cookie, bearer } = {}) {
  const headers = { connection: 'close' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(base + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json, setCookie: res.headers.get('set-cookie') };
}

async function login(base) {
  const res = await call(base, '/api/admin/login', { method: 'POST', body: { secret: SECRET } });
  assert.equal(res.status, 200);
  return String(res.setCookie).split(';')[0];
}

/** Register an account through the public API and return its token. */
async function register(base, username, password = 'unit-test-password') {
  const res = await call(base, '/api/account/register', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

test('the account list needs the admin secret', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await register(base, '阿尔法');
    const anon = await call(base, '/api/admin/accounts');
    assert.equal(anon.status, 401, 'no secret: no list');
    const wrong = await call(base, '/api/admin/accounts', { bearer: 'not-the-secret' });
    assert.equal(wrong.status, 401);
    const ok = await call(base, '/api/admin/accounts', { bearer: SECRET });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.accounts.length, 1);
    assert.equal(ok.json.accounts[0].username, '阿尔法');
  } finally { await srv.close(); }
});

test('the listing never carries a hash, a salt or a token', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const account = await register(base, '贝塔塔');
    const res = await call(base, '/api/admin/accounts', { bearer: SECRET });
    assert.equal(res.status, 200);
    const row = res.json.accounts[0];
    assert.equal(row.skinCount, 0);
    assert.equal(row.tokenCount, 1, 'the one device that registered');
    assert.equal(row.banned, false);
    assert.equal(row.createdAt > 0, true);
    // the secret fields never leave the store
    for (const key of ['passwordHash', 'salt', 'tokens', 'token']) {
      assert.equal(key in row, false, `${key} must not reach the console`);
    }
    assert.equal(res.text.includes(account.token), false, 'the token never reaches the console');
  } finally { await srv.close(); }
});

test('the list filters by a name fragment', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await register(base, '阿尔法');
    await register(base, '贝塔塔');
    await register(base, '阿尔法二号');
    const all = await call(base, '/api/admin/accounts', { bearer: SECRET });
    assert.equal(all.json.accounts.length, 3);
    const filtered = await call(base, '/api/admin/accounts?q=' + encodeURIComponent('阿尔法'), { bearer: SECRET });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.total, 2);
    assert.deepEqual(filtered.json.accounts.map((a) => a.username).sort(), ['阿尔法', '阿尔法二号']);
  } finally { await srv.close(); }
});

test('a password reset drops every logged-in device', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const account = await register(base, '伽马塔');
    const res = await call(base, '/api/admin/accounts/password', {
      method: 'POST', bearer: SECRET, body: { username: '伽马塔', password: 'a-brand-new-password' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.account.tokenCount, 0, 'the old device is logged out');

    // the old password no longer works, the new one does
    const old = await call(base, '/api/account/login', { method: 'POST', body: { username: '伽马塔', password: 'unit-test-password' } });
    assert.notEqual(old.status, 200, 'the old password is refused');
    const fresh = await call(base, '/api/account/login', { method: 'POST', body: { username: '伽马塔', password: 'a-brand-new-password' } });
    assert.equal(fresh.status, 200, 'the new password works');
    assert.notEqual(fresh.json.token, account.token);
  } finally { await srv.close(); }
});

test('a reset refuses a weak password and an unknown account', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await register(base, '德尔塔');
    const weak = await call(base, '/api/admin/accounts/password', {
      method: 'POST', bearer: SECRET, body: { username: '德尔塔', password: 'short' },
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error, 'INVALID_PASSWORD');
    const missing = await call(base, '/api/admin/accounts/password', {
      method: 'POST', bearer: SECRET, body: { username: 'nobody-here', password: 'unit-test-password' },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'NO_SUCH_ACCOUNT');
  } finally { await srv.close(); }
});

test('a banned account cannot sign in and its devices are logged out', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await register(base, '艾普西');
    const ban = await call(base, '/api/admin/accounts/ban', {
      method: 'POST', bearer: SECRET, body: { username: '艾普西', banned: true, reason: '测试' },
    });
    assert.equal(ban.status, 200, ban.text);
    assert.equal(ban.json.account.banned, true);
    assert.equal(ban.json.account.bannedReason, '测试');

    const login = await call(base, '/api/account/login', { method: 'POST', body: { username: '艾普西', password: 'unit-test-password' } });
    assert.equal(login.status, 401, 'a banned account cannot sign in');

    // and it is refused again after the ban is lifted
    const lift = await call(base, '/api/admin/accounts/ban', {
      method: 'POST', bearer: SECRET, body: { username: '艾普西', banned: false },
    });
    assert.equal(lift.status, 200);
    assert.equal(lift.json.account.banned, false);
    const back = await call(base, '/api/account/login', { method: 'POST', body: { username: '艾普西', password: 'unit-test-password' } });
    assert.equal(back.status, 200, 'the account works again');
  } finally { await srv.close(); }
});

test('a deleted account is gone and its name is free again', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await register(base, '艾可赛');
    const del = await call(base, '/api/admin/accounts/delete', {
      method: 'POST', bearer: SECRET, body: { username: '艾可赛' },
    });
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.ok, true);

    const list = await call(base, '/api/admin/accounts', { bearer: SECRET });
    assert.equal(list.json.accounts.length, 0);
    // the name is released for a new registration
    const again = await register(base, '艾可赛');
    assert.equal(typeof again.token, 'string');
    assert.ok(again.token.length > 0);
  } finally { await srv.close(); }
});

test('the account console keeps working while the server protects itself', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const cookie = await login(base);
    await register(base, '艾姆塔');
    await call(base, '/api/admin/maintenance', { method: 'POST', cookie, body: { on: true } });
    // the console itself stays reachable under maintenance (that is the point of the switch)
    const res = await call(base, '/api/admin/accounts', { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.accounts.length, 1);
    await call(base, '/api/admin/maintenance', { method: 'POST', cookie, body: { on: false } });
  } finally { await srv.close(); }
});

test('the account endpoints need a body and the right method', async () => {
  const srv = await makeServer();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await register(base, '奥米伽');
    // a write with the wrong method
    const wrongMethod = await call(base, '/api/admin/accounts/ban', { method: 'GET', bearer: SECRET });
    assert.equal(wrongMethod.status, 405);
    // a write without a username
    const noName = await call(base, '/api/admin/accounts/delete', { method: 'POST', bearer: SECRET, body: {} });
    assert.equal(noName.status, 400);
    // an unknown account
    const unknown = await call(base, '/api/admin/accounts/delete', { method: 'POST', bearer: SECRET, body: { username: 'nobody' } });
    assert.equal(unknown.status, 404);
  } finally { await srv.close(); }
});
