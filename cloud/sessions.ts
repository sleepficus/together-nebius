// Durable owner browser sessions for the phase04 cloud composition (seat
// c-swe-02). One SessionObject Durable Object stores hashed session records;
// the plaintext session token lives only in the HttpOnly cookie and never
// crosses the binding -- the DO sees the SHA-256 digest only.
//
//   POST   /api/v1/session   JSON {token} (or Authorization: Bearer) exchanges
//                            a configured owner token for an opaque cookie.
//   GET    /api/v1/session   reports the authenticated owner (cookie or bearer).
//   DELETE /api/v1/session   revokes the presented cookie session.
//   GET    /login            small same-origin sign-in form (anonymous).
//   POST   /login            form exchange, 303 redirect to / with Set-Cookie.
//   POST   /logout           revokes and clears, 303 redirect to /login.
//
// Only the digest, owner identity, expiry and revocation are stored, so
// resolve and revoke keep working after Durable Object recreation without
// durable secrets. The cookie is HttpOnly, SameSite=Strict, Path=/ (so the
// protected static UI can use it) and Secure on hosted HTTPS.
//
// Browser mutations pass assertCloudOrigin: an exact allowed Origin or
// same-origin Fetch Metadata is required; explicit bearer CLI clients may
// omit Origin. Session/login responses are no-store -- private
// authentication material must never be cached publicly, and no token ever
// appears in HTML, URLs, logs or response bodies.

import {
  ApiError, errorResponse, fail, json, MAX_BODY_BYTES, readJsonBody,
} from '../lib/core.ts';
import { hashToken, OWNER_SCOPES } from '../lib/identity.ts';
import type { OwnerToken } from '../lib/identity.ts';
import type {
  CloudEnv, CloudNamespace, CloudObjectState, CloudOwner, CloudStub,
} from './phase04-contract.ts';

export const SESSION_COOKIE = 'together_session';
/** Fixed Durable Object id name for the singleton session object. */
export const SESSION_DO_NAME = 'together-owner-sessions';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

const MAX_ACTIVE_SESSIONS_PER_OWNER = 64;
const MAX_SESSION_RECORDS = 256;
const SESSION_KEY_PREFIX = 'session/';
const INTERNAL_PREFIX = '/internal/session/';
const INTERNAL_ORIGIN = 'https://session.internal';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Durable record: digest + owner identity + expiry/revocation, nothing else. */
export interface SessionRecord {
  sessionId: string;
  /** SHA-256 hex of the opaque cookie token — the plaintext never persists. */
  digest: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
  status: 'active' | 'revoked' | 'expired';
}

const isoNow = () => new Date().toISOString();

function parseCookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  const raw = request.headers.get('cookie');
  if (raw === null) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/**
 * env-only owner authority. OWNER_TOKENS is a JSON array of {ownerId, token};
 * anything malformed or non-conforming parses to an empty list (fail closed —
 * no owner token means no session can ever be minted).
 */
function ownerTokensFromEnv(env: CloudEnv): OwnerToken[] {
  const raw = env.OWNER_TOKENS;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is OwnerToken =>
        typeof t === 'object' && t !== null &&
        typeof (t as OwnerToken).ownerId === 'string' &&
        typeof (t as OwnerToken).token === 'string',
    );
  } catch {
    return [];
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  return match ? match[1] : null;
}

/** Exact-match origin allowlist from env (comma-separated). No wildcards. */
function allowedOrigins(env: CloudEnv): string[] {
  const raw = env.ALLOWED_ORIGINS;
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Cross-site write gate for cookie-authenticated cloud traffic.
 * Non-mutating methods pass. For mutations: browser-attested same-origin (or
 * user-driven 'none') Fetch Metadata passes; otherwise a present Origin must
 * equal the request origin or an exact ALLOWED_ORIGINS entry. With no usable
 * origin evidence, only an explicit bearer client may proceed — ambient
 * cookie-auth mutations without origin evidence are refused.
 */
export function assertCloudOrigin(request: Request, env: CloudEnv): void {
  if (!MUTATING.has(request.method.toUpperCase())) return;
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin === new URL(request.url).origin) return;
    if (allowedOrigins(env).includes(origin)) return;
    fail(403, 'origin_denied', `origin ${origin} is not allowed`);
  }
  if (fetchSite === 'same-origin') return;
  if (fetchSite === undefined && bearerToken(request) !== null) return;
  fail(403, 'origin_denied',
    'mutating requests require an allowed Origin or same-origin fetch metadata');
}

function sessionNamespace(env: CloudEnv): CloudNamespace {
  const ns = env.SESSION_OBJECT;
  if (ns === undefined || ns === null) {
    fail(503, 'session_unavailable', 'SESSION_OBJECT binding is not configured', { retryable: true });
  }
  return ns;
}

function sessionStub(env: CloudEnv): CloudStub {
  const ns = sessionNamespace(env);
  return ns.get(ns.idFromName(SESSION_DO_NAME));
}

function internalRequest(action: string, body: Record<string, unknown>): Request {
  return new Request(`${INTERNAL_ORIGIN}${INTERNAL_PREFIX}${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callSession(
  env: CloudEnv,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await sessionStub(env).fetch(internalRequest(action, body));
  if (!res.ok) {
    let code = 'session_error';
    try {
      const parsed = (await res.json()) as { error?: { code?: string } };
      if (typeof parsed.error?.code === 'string') code = parsed.error.code;
    } catch {
      // Keep the generic code; the status is still authoritative.
    }
    fail(res.status, code, `session service rejected ${action}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Resolve a request to a configured owner. Explicit bearer owner tokens work
 * for CLI clients; otherwise the opaque session cookie is resolved through
 * the SessionObject (digest only). A session resolves only while its owner
 * still appears in OWNER_TOKENS — rotating an owner out ends their sessions.
 */
export async function resolveOwner(request: Request, env: CloudEnv): Promise<CloudOwner | null> {
  const owners = ownerTokensFromEnv(env);
  const bearer = bearerToken(request);
  if (request.headers.has('authorization')) {
    const owner = bearer === null ? undefined : owners.find((t) => t.token === bearer);
    if (owner !== undefined) return { id: owner.ownerId, ownerId: owner.ownerId };
    return null;
  }
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token === undefined) return null;
  if (env.SESSION_OBJECT === undefined || env.SESSION_OBJECT === null) return null;
  const digest = await hashToken(token);
  const body = await callSession(env, 'resolve', { digest });
  const session = body.session as SessionRecord | null | undefined;
  if (session === null || session === undefined) return null;
  if (!owners.some((t) => t.ownerId === session.ownerId)) return null;
  return { id: session.ownerId, ownerId: session.ownerId };
}

function isHttpsRequest(request: Request): boolean {
  if (new URL(request.url).protocol === 'https:') return true;
  return (request.headers.get('origin') ?? '').startsWith('https://');
}

function sessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = isHttpsRequest(request) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

/** Mint a fresh opaque cookie token; only its digest reaches the DO. */
async function issueSession(env: CloudEnv, ownerId: string): Promise<{ token: string; session: SessionRecord }> {
  const token = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
  const digest = await hashToken(token);
  const now = isoNow();
  const session: SessionRecord = {
    sessionId: crypto.randomUUID(),
    digest,
    ownerId,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + SESSION_TTL_SECONDS * 1000).toISOString(),
    status: 'active',
  };
  await callSession(env, 'create', { ...session });
  return { token, session };
}

async function presentedToken(request: Request): Promise<string | null> {
  const bearer = bearerToken(request);
  if (bearer !== null) return bearer;
  const body = await readJsonBody(request);
  const token = body.token;
  return typeof token === 'string' && token !== '' ? token : null;
}

async function createSession(request: Request, env: CloudEnv): Promise<Response> {
  const token = await presentedToken(request);
  const owner = token === null ? undefined : ownerTokensFromEnv(env).find((t) => t.token === token);
  if (owner === undefined) {
    fail(401, 'unauthenticated', 'a valid owner token is required');
  }
  const { token: sessionToken, session } = await issueSession(env, owner.ownerId);
  const response = json(201, {
    session: { ownerId: session.ownerId, principal: session.ownerId, expiresAt: session.expiresAt },
  });
  response.headers.set('set-cookie', sessionCookie(request, sessionToken, SESSION_TTL_SECONDS));
  return response;
}

async function getSession(request: Request, env: CloudEnv): Promise<Response> {
  const owner = await resolveOwner(request, env);
  if (owner === null) fail(401, 'unauthenticated', 'authentication required');
  return json(200, {
    authenticated: true,
    principal: {
      id: owner.id,
      kind: 'human',
      ownerId: owner.ownerId,
      scopes: [...OWNER_SCOPES],
    },
  });
}

async function endSession(request: Request, env: CloudEnv): Promise<Response> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token !== undefined && env.SESSION_OBJECT !== undefined && env.SESSION_OBJECT !== null) {
    const digest = await hashToken(token);
    await callSession(env, 'revoke', { digest });
  }
  const response = json(200, { ended: true });
  response.headers.set('set-cookie', sessionCookie(request, '', 0));
  return response;
}

/** Public router for /api/v1/session. Lane09 mounts it at the root app. */
export async function sessionFetch(request: Request, env: CloudEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname !== '/api/v1/session') {
      fail(404, 'not_found', 'unknown route');
    }
    const method = request.method.toUpperCase();
    if (MUTATING.has(method)) assertCloudOrigin(request, env);
    let response: Response;
    if (method === 'POST') response = await createSession(request, env);
    else if (method === 'GET') response = await getSession(request, env);
    else if (method === 'DELETE') response = await endSession(request, env);
    else fail(405, 'method_not_allowed', 'session supports GET, POST and DELETE');
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (err) {
    return sessionError(err);
  }
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Together sign in</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><form method="post" action="/login" autocomplete="off">
<label for="token">Owner token</label>
<input id="token" name="token" type="password" required autocomplete="off">
<button type="submit">Sign in</button>
</form></body></html>`;

function loginPage(): Response {
  return new Response(LOGIN_PAGE, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Preserve the same-origin form POST's Origin; no-referrer can make it null.
      'referrer-policy': 'same-origin',
    },
  });
}

async function formToken(request: Request): Promise<string | null> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    fail(429, 'request_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`, { retryable: false });
  }
  const token = new URLSearchParams(text).get('token');
  return token !== null && token !== '' ? token : null;
}

async function loginPost(request: Request, env: CloudEnv): Promise<Response> {
  const token = await formToken(request);
  const owner = token === null ? undefined : ownerTokensFromEnv(env).find((t) => t.token === token);
  if (owner === undefined) {
    fail(401, 'unauthenticated', 'a valid owner token is required');
  }
  const { token: sessionToken } = await issueSession(env, owner.ownerId);
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': sessionCookie(request, sessionToken, SESSION_TTL_SECONDS),
    },
  });
}

async function logoutPost(request: Request, env: CloudEnv): Promise<Response> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token !== undefined && env.SESSION_OBJECT !== undefined && env.SESSION_OBJECT !== null) {
    const digest = await hashToken(token);
    await callSession(env, 'revoke', { digest });
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: '/login',
      'set-cookie': sessionCookie(request, '', 0),
    },
  });
}

/** Public router for the small same-origin /login and /logout forms. */
export async function loginFetch(request: Request, env: CloudEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    let response: Response;
    if (url.pathname === '/login' && method === 'GET') {
      response = loginPage();
    } else if (url.pathname === '/login' && method === 'POST') {
      assertCloudOrigin(request, env);
      response = await loginPost(request, env);
    } else if (url.pathname === '/logout' && method === 'POST') {
      assertCloudOrigin(request, env);
      response = await logoutPost(request, env);
    } else {
      fail(404, 'not_found', 'unknown route');
    }
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (err) {
    return sessionError(err);
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    fail(422, 'missing_field', `missing required field "${field}"`);
  }
  return value;
}

function sessionError(err: unknown): Response {
  if (err instanceof ApiError) return errorResponse(err);
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return json(status, {
      error: {
        status,
        code: (err as { code?: string }).code ?? 'error',
        message: err instanceof Error ? err.message : 'request failed',
        retryable: status === 429 || status === 503,
      },
    });
  }
  return json(500, {
    error: { status: 500, code: 'internal_error', message: 'internal error', retryable: false },
  });
}

/**
 * Singleton Durable Object holding hashed session records. Reachable only
 * through the SESSION_OBJECT binding: its private fetch accepts exactly
 * create/resolve/revoke under /internal/session/, each POST with a small
 * JSON body carrying digests — never cookie plaintext. Records are durable
 * in DO storage so resolution and revocation survive object recreation.
 */
export class SessionObject {
  private state: CloudObjectState;

  constructor(state: CloudObjectState, _env: CloudEnv) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || !url.pathname.startsWith(INTERNAL_PREFIX)) {
        fail(404, 'not_found', 'not an internal session route');
      }
      const action = url.pathname.slice(INTERNAL_PREFIX.length);
      const body = await readJsonBody(request);
      if (action === 'create') return await this.create(body);
      if (action === 'resolve') return await this.resolve(body);
      if (action === 'revoke') return await this.revoke(body);
      fail(404, 'not_found', 'unknown internal session route');
    } catch (err) {
      return sessionError(err);
    }
  }

  /** Idempotent by digest: a repeated create returns the stored record. */
  private async create(body: Record<string, unknown>): Promise<Response> {
    const digest = requireString(body, 'digest');
    const ownerId = requireString(body, 'ownerId');
    const sessionId = requireString(body, 'sessionId');
    const createdAt = requireString(body, 'createdAt');
    const expiresAt = requireString(body, 'expiresAt');
    if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(expiresAt))) {
      fail(422, 'invalid_field', 'createdAt and expiresAt must be ISO timestamps');
    }
    const key = SESSION_KEY_PREFIX + digest;
    return this.state.storage.transaction(async (tx) => {
      const now = isoNow();
      const existing = await tx.get<SessionRecord>(key);
      if (existing !== undefined) return json(200, { session: existing });
      let total = 0;
      let activeForOwner = 0;
      for (const [k, rec] of await tx.list<SessionRecord>({ prefix: SESSION_KEY_PREFIX })) {
        if (rec.status !== 'active' || rec.expiresAt <= now) {
          await tx.delete(k); // prune dead records before enforcing caps
        } else {
          total += 1;
          if (rec.ownerId === ownerId) activeForOwner += 1;
        }
      }
      if (activeForOwner >= MAX_ACTIVE_SESSIONS_PER_OWNER) {
        fail(429, 'session_limit', 'too many active sessions for this owner', { retryable: false });
      }
      if (total >= MAX_SESSION_RECORDS) {
        fail(429, 'session_limit', 'session store is full', { retryable: false });
      }
      const record: SessionRecord = { sessionId, digest, ownerId, createdAt, expiresAt, status: 'active' };
      await tx.put(key, record);
      return json(201, { session: record });
    });
  }

  private async resolve(body: Record<string, unknown>): Promise<Response> {
    const digest = requireString(body, 'digest');
    const key = SESSION_KEY_PREFIX + digest;
    const record = await this.state.storage.get<SessionRecord>(key);
    if (record === undefined || record.status !== 'active') {
      return json(200, { session: null });
    }
    if (record.expiresAt <= isoNow()) {
      record.status = 'expired';
      await this.state.storage.put(key, record);
      return json(200, { session: null });
    }
    return json(200, { session: record });
  }

  private async revoke(body: Record<string, unknown>): Promise<Response> {
    const digest = requireString(body, 'digest');
    const key = SESSION_KEY_PREFIX + digest;
    const record = await this.state.storage.get<SessionRecord>(key);
    if (record === undefined) return json(200, { revoked: false });
    if (record.status === 'active') {
      record.status = 'revoked';
      await this.state.storage.put(key, record);
    }
    return json(200, { revoked: true });
  }
}
