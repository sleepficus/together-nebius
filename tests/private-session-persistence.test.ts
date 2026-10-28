import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLocalApi, type LocalApi } from '../cloud/local-server.ts';
import {
  DEFAULT_LOCAL_SESSION_TTL_SECONDS, MAX_LOCAL_SESSION_TTL_SECONDS, LocalSessionStore,
} from '../cloud/local-sessions.ts';

const START = Date.parse('2026-10-07T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const OWNER = { ownerId: 'steve', token: 'private-session-fixture-owner' };
const ORIGIN = 'https://fixture-private.tailnet.example';
const req = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1${path}`, init);

async function login(api: LocalApi): Promise<string> {
  const response = await api.fetch(req('/api/v1/session', {
    method: 'POST', headers: { authorization: `Bearer ${OWNER.token}`, origin: ORIGIN },
  }));
  assert.equal(response.status, 201);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/api/);
  assert.match(setCookie, /; Secure/);
  return setCookie;
}

const cookieRequest = (cookie: string) => req('/api/v1/session', { headers: { cookie: cookie.split(';')[0] } });

test('private 30-day cookie resumes after local restart and expires at day 30', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'together-private-session-'));
  let clock = START;
  const options = {
    ownerTokens: [OWNER], stateDir, seedProjects: [{ id: 'private-p' }],
    allowedOrigins: [ORIGIN], sessionTtlSeconds: MAX_LOCAL_SESSION_TTL_SECONDS,
    now: () => new Date(clock).toISOString(),
  };
  let api = createLocalApi(options);
  try {
    const cookie = await login(api);
    assert.match(cookie, /Max-Age=2592000/);
    const before = await (await api.fetch(cookieRequest(cookie))).json();
    api.close();
    clock = START + 29 * DAY;
    api = createLocalApi(options);
    const recovered = await api.fetch(cookieRequest(cookie));
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), before, 'same human identity and project access after restart');
    clock = START + 30 * DAY;
    assert.equal((await api.fetch(cookieRequest(cookie))).status, 401);
    api.close();
    api = createLocalApi(options);
    assert.equal((await api.fetch(cookieRequest(cookie))).status, 401, 'expiry remains denied after another restart');
  } finally {
    api.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('session file contains only a digest and stays outside ordinary project state', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'together-private-session-'));
  const api = createLocalApi({ ownerTokens: [OWNER], stateDir, allowedOrigins: [ORIGIN] });
  try {
    const cookie = await login(api);
    const token = cookie.split(';')[0].split('=')[1];
    const file = join(stateDir, 'owner-sessions.sqlite');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file).includes(Buffer.from(token)), false);
    assert.equal(readFileSync(file).includes(Buffer.from(OWNER.token)), false);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare('SELECT token_digest, owner_id FROM owner_sessions').all();
      assert.deepEqual(rows.map((row) => ({ ...row })), [{
        token_digest: createHash('sha256').update(token).digest('hex'), owner_id: OWNER.ownerId,
      }]);
    } finally { db.close(); }
    const project = readFileSync(join(stateDir, 'local-live-1.json'), 'utf8');
    assert.equal(project.includes(token), false);
    assert.equal(project.includes('token_digest'), false);
  } finally {
    api.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('logout revokes a recovered cookie durably, including after another restart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'together-private-session-'));
  const options = { ownerTokens: [OWNER], stateDir, allowedOrigins: [ORIGIN], sessionTtlSeconds: MAX_LOCAL_SESSION_TTL_SECONDS };
  let api = createLocalApi(options);
  try {
    const cookie = await login(api);
    api.close();
    api = createLocalApi(options);
    assert.equal((await api.fetch(cookieRequest(cookie))).status, 200);
    const logout = await api.fetch(req('/api/v1/session', {
      method: 'DELETE', headers: { cookie: cookie.split(';')[0], origin: ORIGIN },
    }));
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
    api.close();
    api = createLocalApi(options);
    assert.equal((await api.fetch(cookieRequest(cookie))).status, 401);
  } finally {
    api.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('removing the configured owner revokes their persisted browser session', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'together-private-session-'));
  const options = { ownerTokens: [OWNER], stateDir, allowedOrigins: [ORIGIN] };
  let api = createLocalApi(options);
  try {
    const cookie = await login(api);
    api.close();
    api = createLocalApi({ ...options, ownerTokens: [{ ownerId: 'other-owner', token: 'other-fixture-owner' }] });
    assert.equal((await api.fetch(cookieRequest(cookie))).status, 401);
    api.close();
    api = createLocalApi(options);
    assert.equal((await api.fetch(cookieRequest(cookie))).status, 401, 'adding owner back does not restore a revoked cookie');
  } finally {
    api.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('general local sessions keep the 8-hour default and enforce the 30-day maximum', async () => {
  let clock = START;
  const api = createLocalApi({ ownerTokens: [OWNER], allowedOrigins: [ORIGIN], now: () => new Date(clock).toISOString() });
  try {
    const cookie = await login(api);
    assert.match(cookie, new RegExp(`Max-Age=${DEFAULT_LOCAL_SESSION_TTL_SECONDS}(?:;|$)`));
    clock += DEFAULT_LOCAL_SESSION_TTL_SECONDS * 1000;
    assert.equal((await api.fetch(cookieRequest(cookie))).status, 401);
  } finally { api.close(); }
  for (const sessionTtlSeconds of [0, -1, 0.5, Infinity, MAX_LOCAL_SESSION_TTL_SECONDS + 1]) {
    assert.throws(() => createLocalApi({ ownerTokens: [OWNER], sessionTtlSeconds }), /between 1 second and 30 days/);
  }
});

test('session origin protections and owner-only exchange remain unchanged', async () => {
  const api = createLocalApi({ ownerTokens: [OWNER], sessionTtlSeconds: MAX_LOCAL_SESSION_TTL_SECONDS });
  try {
    const post = (headers: Record<string, string>) => api.fetch(req('/api/v1/session', { method: 'POST', headers }));
    assert.equal((await post({ origin: 'https://foreign.example', authorization: `Bearer ${OWNER.token}` })).status, 403);
    assert.equal((await post({ 'sec-fetch-site': 'cross-site', authorization: `Bearer ${OWNER.token}` })).status, 403);
    assert.equal((await post({ authorization: 'Bearer not-an-owner' })).status, 401);
    assert.equal((await post({ authorization: `Bearer ${OWNER.token}`, origin: 'http://localhost:5173' })).status, 201);
  } finally { api.close(); }
});

test('private session capacity remains bounded and logout releases a slot', async () => {
  const api = createLocalApi({ ownerTokens: [OWNER], allowedOrigins: [ORIGIN] });
  try {
    const first = await login(api);
    for (let index = 1; index < 64; index++) await login(api);
    const full = await api.fetch(req('/api/v1/session', { method: 'POST', headers: { authorization: `Bearer ${OWNER.token}` } }));
    assert.equal(full.status, 429);
    assert.equal((await full.json()).error.code, 'session_limit');
    await api.fetch(req('/api/v1/session', { method: 'DELETE', headers: { cookie: first.split(';')[0] } }));
    await login(api);
  } finally { api.close(); }
});

test('session persistence fails closed for a symbolic-link database', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'together-private-session-'));
  try {
    const realFile = join(stateDir, 'original.sqlite');
    const store = new LocalSessionStore(realFile);
    store.close();
    const linkedFile = join(stateDir, 'linked.sqlite');
    symlinkSync(realFile, linkedFile);
    assert.throws(() => new LocalSessionStore(linkedFile), /must be a regular file/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
