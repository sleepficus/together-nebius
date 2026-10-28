// Unit evidence for seat c-swe-02: durable owner browser sessions.
// Opaque hashed sessions with expiry/revocation surviving object
// recreation, same-origin cookie/login/logout CSRF gating, and the
// protected-UI cookie shape. Runs with:
//   node --test tests/c-swe-02.test.ts   (Node >=22.18 type stripping)
// or the root script: tsx --test tests/*.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCloudOrigin, loginFetch, resolveOwner, sessionFetch,
  SessionObject, SESSION_COOKIE, SESSION_DO_NAME,
} from '../cloud/sessions.ts';
import { hashToken } from '../lib/identity.ts';
import type {
  CloudEnv, CloudNamespace, CloudObjectState, CloudStorage,
} from '../cloud/phase04-contract.ts';

const BASE = 'https://together-test.example';
const OWNER = { ownerId: 'steve', token: 'owner-token-1' };

/** In-memory CloudStorage stub — durable backing shared across DO instances. */
class MemoryStorage implements CloudStorage {
  readonly map = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.map.get(key) as T | undefined);
  }
  put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) {
      if (options?.prefix === undefined || k.startsWith(options.prefix)) out.set(k, v as T);
    }
    return Promise.resolve(out);
  }
  transaction<T>(fn: (tx: CloudStorage) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function fakeState(storage: MemoryStorage): CloudObjectState {
  return {
    id: { name: SESSION_DO_NAME, toString: () => SESSION_DO_NAME },
    storage,
  };
}

/** Each stub fetch constructs a FRESH SessionObject — DO recreation is normal. */
function fakeNamespace(storage: MemoryStorage, env: CloudEnv, seen?: string[]): CloudNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => `do:${name}` }),
    get: () => ({
      fetch: async (request: Request) => {
        seen?.push(await request.clone().text());
        return new SessionObject(fakeState(storage), env).fetch(request);
      },
    }),
  };
}

function fakeEnv(storage = new MemoryStorage(), seen?: string[]): { env: CloudEnv; storage: MemoryStorage } {
  const env: CloudEnv = {
    OWNER_TOKENS: JSON.stringify([OWNER]),
    ALLOWED_ORIGINS: 'https://private-preview.example',
  };
  env.SESSION_OBJECT = fakeNamespace(storage, env, seen);
  return { env, storage };
}

const sessionReq = (init?: RequestInit) => new Request(`${BASE}/api/v1/session`, init);
const loginReq = (path = '/login', init?: RequestInit) => new Request(`${BASE}${path}`, init);
const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  // Same-origin browser fetch metadata — a real same-origin POST always sends it.
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify(body),
});
const internal = (action: string, body: unknown) =>
  new Request(`https://session.internal/internal/session/${action}`, jsonPost(body));

test('owner token exchange mints an HttpOnly SameSite=Strict Path=/ cookie; only the digest persists', async () => {
  const { env, storage } = fakeEnv();
  const res = await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), env);
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie')!;
  assert.match(cookie, /together_session=sess_[0-9a-f]{32}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=28800/);
  assert.match(cookie, /Secure/); // hosted HTTPS request
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = (await res.json()) as { session: { ownerId: string; expiresAt: string } };
  assert.equal(body.session.ownerId, 'steve');
  assert.equal(JSON.stringify(body).includes('sess_'), false);
  // The plaintext cookie value is never what is stored.
  const raw = cookie.split(';')[0].split('=')[1];
  const records = [...storage.map.values()] as { digest: string; ownerId: string; status: string }[];
  assert.equal(records.length, 1);
  assert.equal(records[0].ownerId, 'steve');
  assert.equal(records[0].status, 'active');
  assert.notEqual(records[0].digest, raw);
  assert.equal(records[0].digest, await hashToken(raw));
  assert.equal(JSON.stringify([...storage.map.entries()]).includes(raw), false);
});

test('invalid, missing and non-owner tokens cannot mint sessions; malformed config fails closed', async () => {
  const { env } = fakeEnv();
  for (const body of [{ token: 'nope' }, {}]) {
    const res = await sessionFetch(sessionReq(jsonPost(body)), env);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  const bad = fakeEnv();
  bad.env.OWNER_TOKENS = '{not json';
  assert.equal((await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), bad.env)).status, 401);
  const notArray = fakeEnv();
  notArray.env.OWNER_TOKENS = JSON.stringify({ ownerId: 'steve', token: OWNER.token });
  assert.equal((await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), notArray.env)).status, 401);
  // Explicit bearer owner tokens also mint sessions (CLI clients).
  const ok = await sessionFetch(sessionReq({
    method: 'POST',
    headers: { authorization: `Bearer ${OWNER.token}`, 'content-type': 'application/json' },
    body: '{}',
  }), env);
  assert.equal(ok.status, 201);
});

test('cookie session resolves across DO recreation; DELETE revokes durably', async () => {
  const { env, storage } = fakeEnv();
  const login = await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), env);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  // Fresh objects over the same storage: simulates DO eviction/recreation.
  env.SESSION_OBJECT = fakeNamespace(storage, env);
  const owner = await resolveOwner(new Request(`${BASE}/x`, { headers: { cookie } }), env);
  assert.deepEqual(owner, { id: 'steve', ownerId: 'steve' });
  const get = await sessionFetch(new Request(`${BASE}/api/v1/session`, { headers: { cookie } }), env);
  assert.equal(get.status, 200);
  const report = (await get.json()) as { authenticated: boolean; principal: { id: string; kind: string } };
  assert.equal(report.authenticated, true);
  assert.equal(report.principal.id, 'steve');
  assert.equal(report.principal.kind, 'human');
  // Revoke, then recreate again: the record stays revoked.
  env.SESSION_OBJECT = fakeNamespace(storage, env);
  const end = await sessionFetch(new Request(`${BASE}/api/v1/session`, {
    method: 'DELETE', headers: { cookie, origin: BASE },
  }), env);
  assert.equal(end.status, 200);
  assert.match(end.headers.get('set-cookie')!, /Max-Age=0/);
  const rec = [...storage.map.values()][0] as { status: string };
  assert.equal(rec.status, 'revoked');
  env.SESSION_OBJECT = fakeNamespace(storage, env);
  assert.equal(await resolveOwner(new Request(`${BASE}/x`, { headers: { cookie } }), env), null);
  assert.equal((await sessionFetch(new Request(`${BASE}/api/v1/session`, { headers: { cookie } }), env)).status, 401);
});

test('expired sessions stop resolving and are marked expired lazily', async () => {
  const { env, storage } = fakeEnv();
  const ns = env.SESSION_OBJECT!;
  const stub = ns.get(ns.idFromName(SESSION_DO_NAME));
  const token = 'sess_expiredfixture';
  const digest = await hashToken(token);
  const created = await stub.fetch(internal('create', {
    sessionId: 's1', digest, ownerId: 'steve',
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z',
  }));
  assert.equal(created.status, 201);
  const owner = await resolveOwner(new Request(`${BASE}/x`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), env);
  assert.equal(owner, null);
  assert.equal((storage.map.get(`session/${digest}`) as { status: string }).status, 'expired');
});

test('sessions for a removed owner stop resolving after OWNER_TOKENS rotation', async () => {
  const { env } = fakeEnv();
  const login = await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), env);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  env.OWNER_TOKENS = JSON.stringify([{ ownerId: 'carol', token: 'other-token' }]);
  assert.equal(await resolveOwner(new Request(`${BASE}/x`, { headers: { cookie } }), env), null);
});

test('mutating browser requests need same-origin metadata or an exact allowed origin', async () => {
  const { env } = fakeEnv();
  const mut = (headers: Record<string, string>) =>
    sessionFetch(new Request(`${BASE}/api/v1/session`, { method: 'DELETE', headers }), env);
  assert.equal((await mut({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).status, 403);
  assert.equal((await mut({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await mut({ 'sec-fetch-site': 'same-site' })).status, 403);
  // Exact allowlisted and same-origin Origins pass; same-origin metadata passes.
  assert.equal((await mut({ origin: 'https://private-preview.example' })).status, 200);
  assert.equal((await mut({ origin: BASE })).status, 200);
  assert.equal((await mut({ 'sec-fetch-site': 'same-origin' })).status, 200);
  // Ambient-cookie mutations without origin evidence refused; explicit bearer may omit Origin.
  assert.equal((await mut({ cookie: `${SESSION_COOKIE}=sess_x` })).status, 403);
  assert.equal((await mut({ authorization: `Bearer ${OWNER.token}` })).status, 200);
  // GET is not a mutation — it reaches authentication (401), not the origin gate.
  assert.equal((await sessionFetch(new Request(`${BASE}/api/v1/session`, {
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
  }), env)).status, 401);
});

test('assertCloudOrigin edge cases throw only for missing origin evidence', () => {
  const { env } = fakeEnv();
  const req = (headers: Record<string, string>, method = 'POST') =>
    new Request(`${BASE}/api/v1/session`, { method, headers });
  const denied = (e: { status: number; code: string }) => e.status === 403 && e.code === 'origin_denied';
  assert.throws(() => assertCloudOrigin(req({ 'sec-fetch-site': 'none' }), env), denied);
  assert.doesNotThrow(() => assertCloudOrigin(req({ 'sec-fetch-site': 'same-origin' }), env));
  assert.doesNotThrow(() => assertCloudOrigin(req({ authorization: 'Bearer anything' }), env));
  assert.throws(() => assertCloudOrigin(req({}), env), denied);
  assert.throws(() => assertCloudOrigin(req({ cookie: `${SESSION_COOKIE}=sess_x` }), env), denied);
  assert.throws(() => assertCloudOrigin(req({ origin: 'https://evil.example' }), env), denied);
  assert.doesNotThrow(() => assertCloudOrigin(req({}, 'GET'), env));
});

test('/login serves a token-free no-store form; the form post sets the cookie and redirects', async () => {
  const { env } = fakeEnv();
  const page = await loginFetch(loginReq('/login'), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const html = await page.text();
  assert.match(html, /<form method="post" action="\/login"/);
  assert.equal(html.includes(OWNER.token), false);

  const res = await loginFetch(loginReq('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', origin: BASE },
    body: `token=${encodeURIComponent(OWNER.token)}`,
  }), env);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  assert.match(res.headers.get('set-cookie')!, /together_session=sess_[0-9a-f]{32}/);
  assert.match(res.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict; Path=\//);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const wrong = await loginFetch(loginReq('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: 'token=wrong',
  }), env);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);

  // A cross-site form post cannot mint a session into the victim browser.
  const xs = await loginFetch(loginReq('/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site', origin: 'https://evil.example',
    },
    body: `token=${encodeURIComponent(OWNER.token)}`,
  }), env);
  assert.equal(xs.status, 403);
  assert.equal(xs.headers.get('set-cookie'), null);
});

test('/login still rejects opaque or foreign origins even with same-origin fetch metadata', async () => {
  const { env, storage } = fakeEnv();
  for (const origin of ['null', 'https://evil.example']) {
    const response = await loginFetch(loginReq('/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin', origin,
      },
      body: `token=${encodeURIComponent(OWNER.token)}`,
    }), env);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'origin_denied');
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(storage.map.size, 0);
});

test('POST /logout revokes the durable record and clears the cookie', async () => {
  const { env, storage } = fakeEnv();
  const login = await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), env);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const out = await loginFetch(loginReq('/logout', {
    method: 'POST', headers: { cookie, origin: BASE },
  }), env);
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), '/login');
  assert.match(out.headers.get('set-cookie')!, /Max-Age=0/);
  const rec = [...storage.map.values()][0] as { status: string };
  assert.equal(rec.status, 'revoked');
  assert.equal(await resolveOwner(new Request(`${BASE}/x`, { headers: { cookie } }), env), null);
});

test('the plaintext session token never crosses the SESSION_OBJECT seam', async () => {
  const seen: string[] = [];
  const { env } = fakeEnv(new MemoryStorage(), seen);
  const res = await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), env);
  const raw = res.headers.get('set-cookie')!.split(';')[0].split('=')[1];
  assert.ok(seen.length >= 1);
  for (const body of seen) {
    assert.equal(body.includes(raw), false);
    assert.equal(body.includes(OWNER.token), false);
  }
});

test('active-session cap per owner is an explicit limit, not silent growth', async () => {
  const { env } = fakeEnv();
  for (let i = 0; i < 64; i++) {
    const res = await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), env);
    assert.equal(res.status, 201);
  }
  const res = await sessionFetch(sessionReq(jsonPost({ token: OWNER.token })), env);
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'session_limit');
});

test('routing shape: unknown paths and methods fail with API error codes', async () => {
  const { env } = fakeEnv();
  assert.equal((await sessionFetch(new Request(`${BASE}/api/v1/other`), env)).status, 404);
  assert.equal((await sessionFetch(new Request(`${BASE}/api/v1/session`, {
    method: 'PUT', headers: { origin: BASE },
  }), env)).status, 405);
  assert.equal((await loginFetch(new Request(`${BASE}/other`), env)).status, 404);
  assert.equal((await loginFetch(loginReq('/login', { method: 'DELETE', headers: { origin: BASE } }), env)).status, 404);
  // The DO refuses non-internal routes outright.
  const ns = env.SESSION_OBJECT!;
  const stub = ns.get(ns.idFromName(SESSION_DO_NAME));
  assert.equal((await stub.fetch(new Request('https://session.internal/public'))).status, 404);
  assert.equal((await stub.fetch(internal('bogus', {}))).status, 404);
});

test('http requests omit Secure; https origins behind a proxy still set it', async () => {
  const { env } = fakeEnv();
  const plain = await sessionFetch(new Request('http://localhost/api/v1/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER.token}` },
    body: '{}',
  }), env);
  assert.doesNotMatch(plain.headers.get('set-cookie')!, /; Secure/);
  const proxied = await sessionFetch(new Request('http://localhost/api/v1/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', authorization: `Bearer ${OWNER.token}`,
      origin: 'https://private-preview.example',
    },
    body: '{}',
  }), env);
  assert.match(proxied.headers.get('set-cookie')!, /; Secure/);
});
