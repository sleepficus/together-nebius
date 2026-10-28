// Cross-project inbox aggregate for the phase04 Cloudflare composition
// (seat c-swe-04). GET /api/v1/inbox at the worker root answers the
// caller's own addressed mail merged across every project the caller is
// allowed to see.
//
// Spec (CLOUD-SPEC.md item 4):
// - directory visibility comes from the authenticated owner or a hashed
//   agent-credential index; the index is discovery only, never authority
// - authoritative project authentication is rechecked on every read —
//   each candidate project object runs its own live authenticate over
//   the forwarded caller credentials, so revoke/expiry takes effect
//   immediately and inaccessible ids cannot leak existence
// - never scan every owner's live store for arbitrary tokens
// - scope/project filters and stable bounded pagination cannot escape
//   ownership; reading an inbox never launches models
// - existing client/CLI response conventions are preserved
//
// Discovery uses the Directory module's exported helpers so the singleton,
// internal marker, routes and response shapes have one implementation.
//
// Per-project reads reuse the ordinary safe endpoint
// GET /api/v1/projects/:id/inbox through the PROJECT_OBJECT binding with
// the caller's own Authorization/Cookie headers forwarded unchanged, so
// authentication, scope and delivery marking stay exactly the native
// per-project behavior. Session-cookie resolution inside the project
// object is c-swe-09/c-swe-03 composition work; this module only
// guarantees the credentials arrive.

import { ApiError, PAGE_LIMIT, errorResponse, fail, json } from '../lib/core.ts';
import { hashToken } from '../lib/identity.ts';
import type { OwnerToken } from '../lib/identity.ts';
import type {
  CloudEnv, CloudOwner,
} from './phase04-contract.ts';
import type { Id } from '../lib/types.ts';
import { ownerProjects, credentialProjects } from './directory.ts';

/** Max distinct project objects queried for one request. More candidates
 *  remain reachable through the opaque continuation cursor. */
export const GLOBAL_INBOX_MAX_FANOUT = 64;
/** Hard cap on the opaque pagination token. */
const MAX_CURSOR_BYTES = 8 * 1024;
/** Caller credentials forwarded verbatim into each project object. */
const FORWARD_HEADERS = ['authorization', 'cookie'] as const;
const CURSOR_PREFIX = 'g1.';

interface InboxPageBody {
  messages?: unknown;
  counts?: Record<string, number>;
  nextCursor?: string | null;
  resync?: boolean;
}

interface GlobalCursor {
  v: 1;
  /** Per-project position: last emitted message id for that project. */
  p: Record<string, Id>;
  /** Projects fully drained through earlier pages. */
  d: Id[];
}

const byCreated = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number => {
  const at = String(a.createdAt ?? '');
  const bt = String(b.createdAt ?? '');
  if (at !== bt) return at < bt ? -1 : 1;
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
};

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): string | null {
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Opaque continuation token: per-project positions, never caller data. */
function encodeCursor(cursor: GlobalCursor): string | null {
  const token = CURSOR_PREFIX + b64urlEncode(JSON.stringify(cursor));
  return token.length <= MAX_CURSOR_BYTES ? token : null;
}

function decodeCursor(raw: string): GlobalCursor | null {
  if (!raw.startsWith(CURSOR_PREFIX)) return null;
  const text = b64urlDecode(raw.slice(CURSOR_PREFIX.length));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as GlobalCursor;
    if (
      parsed === null || typeof parsed !== 'object' || parsed.v !== 1 ||
      parsed.p === null || typeof parsed.p !== 'object' ||
      !Array.isArray(parsed.d)
    ) return null;
    for (const [k, v] of Object.entries(parsed.p)) {
      if (typeof k !== 'string' || typeof v !== 'string') return null;
    }
    if (!parsed.d.every((id) => typeof id === 'string')) return null;
    return parsed;
  } catch {
    return null;
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  return match ? match[1] : null;
}

/** env.OWNER_TOKENS parsed defensively; malformed config yields none. */
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

/** Project ids the directory records for one owner; null on failure. */
async function ownerProjectIds(env: CloudEnv, ownerId: Id): Promise<Id[] | null> {
  try {
    return (await ownerProjects(env, ownerId))
      .filter((rec) => typeof rec.id === 'string' && rec.provisioning === 'ready')
      .map((rec) => rec.id);
  } catch {
    return null;
  }
}

/** Project ids the hashed credential index claims; null on failure. The
 *  index is discovery only — each project re-authenticates the token. */
async function credentialProjectIds(env: CloudEnv, digest: string): Promise<Id[] | null> {
  try {
    return (await credentialProjects(env, digest)).filter((id) => typeof id === 'string');
  } catch {
    return null;
  }
}

type ProjectRead =
  | { kind: 'ok'; body: InboxPageBody }
  | { kind: 'denied' }      // 401/403/404 — the caller may not read it
  | { kind: 'error' };      // transport or 5xx — honest partial result

/**
 * Forward the caller's own credentials into one project object's safe
 * per-project inbox endpoint. Authentication, scope and project access
 * are re-checked inside the project against its live state on every
 * read; a denied or missing project is indistinguishable by design.
 */
async function fetchProjectInbox(
  env: CloudEnv,
  request: Request,
  projectId: Id,
  after: Id | null,
  limit: number,
): Promise<ProjectRead> {
  const ns = env.PROJECT_OBJECT;
  if (ns === undefined) return { kind: 'error' };
  try {
    const url = new URL(request.url);
    url.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/inbox`;
    url.search = `?limit=${limit}${after !== null ? `&after=${encodeURIComponent(after)}` : ''}`;
    const headers = new Headers();
    for (const name of FORWARD_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const res = await ns.get(ns.idFromName(projectId)).fetch(
      new Request(url, { method: 'GET', headers }),
    );
    if (res.status === 200) {
      const body = (await res.json()) as InboxPageBody;
      if (!Array.isArray(body.messages)) return { kind: 'error' };
      return { kind: 'ok', body };
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { kind: 'denied' };
    }
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

function mergeCounts(
  counts: Record<string, number>,
  add: Record<string, number> | undefined,
): void {
  if (add === undefined) return;
  for (const [k, v] of Object.entries(add)) {
    if (typeof v === 'number' && Number.isFinite(v)) counts[k] = (counts[k] ?? 0) + v;
  }
}

/**
 * GET /api/v1/inbox over the whole deployment: the caller's own addressed
 * mail merged across the projects the directory says they may see, with
 * every candidate re-authenticated inside its project object.
 *
 * Response matches the native multi-project shape:
 *   { messages, counts, nextCursor, resync, projectIds, partial? }
 * Each message additionally carries its projectId so a client can route
 * ack/accept/reply to the owning project endpoint. `partial: true` is
 * emitted only when a visible project failed with a non-auth error, so
 * a degraded backend never masquerades as an empty inbox.
 */
export async function globalInboxFetch(
  request: Request,
  env: CloudEnv,
  owner: CloudOwner | null,
): Promise<Response> {
  try {
    if (request.method.toUpperCase() !== 'GET') {
      fail(404, 'not_found', 'unknown route');
    }
    const url = new URL(request.url);
    const limitParam = Number(url.searchParams.get('limit') ?? PAGE_LIMIT);
    const limit = Math.min(
      Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : PAGE_LIMIT,
      PAGE_LIMIT,
    );

    if (env.DIRECTORY_OBJECT === undefined) {
      fail(503, 'dependency_unavailable', 'directory binding is not configured', {
        retryable: true,
      });
    }

    // ---- discovery: authenticated owner, then hashed credential index --
    const ownerIds = new Set<Id>();
    if (owner !== null) ownerIds.add(owner.ownerId);
    const bearer = bearerToken(request);
    let bearerIsOwner = false;
    if (bearer !== null) {
      const matched = ownerTokensFromEnv(env).find((t) => t.token === bearer);
      if (matched !== undefined) {
        bearerIsOwner = true;
        ownerIds.add(matched.ownerId);
      }
    }

    const candidates = new Set<Id>();
    let indexedCredential = false;
    for (const ownerId of ownerIds) {
      const ids = await ownerProjectIds(env, ownerId);
      if (ids === null) {
        fail(503, 'dependency_unavailable', 'directory owner lookup failed', {
          retryable: true,
        });
      }
      for (const id of ids) candidates.add(id);
    }
    if (bearer !== null && !bearerIsOwner) {
      const digest = await hashToken(bearer);
      const ids = await credentialProjectIds(env, digest);
      if (ids === null) {
        fail(503, 'dependency_unavailable', 'credential index lookup failed', {
          retryable: true,
        });
      }
      indexedCredential = true;
      for (const id of ids) candidates.add(id);
    }

    // Nothing proves this caller: no session owner, no bearer, or a
    // bearer that is neither an owner token nor an indexed credential.
    const authenticated =
      owner !== null || bearerIsOwner ||
      (indexedCredential && candidates.size > 0);
    if (!authenticated) {
      fail(401, 'unauthenticated', 'authentication required');
    }

    // ---- project filter: it can narrow, never widen -------------------
    const projectFilter = url.searchParams.get('projectId');
    if (projectFilter !== null && !candidates.has(projectFilter)) {
      // Same answer for a guessed id as for a genuinely absent one.
      fail(404, 'not_found', 'unknown or inaccessible project');
    }
    const targets = [...candidates]
      .filter((id) => projectFilter === null || id === projectFilter)
      .sort();

    // ---- cursor: per-project positions survive across pages -----------
    const rawAfter = url.searchParams.get('after');
    let positions: Record<string, Id> = {};
    const drained = new Set<Id>();
    let resync = false;
    if (rawAfter !== null) {
      const decoded = decodeCursor(rawAfter);
      if (decoded === null) {
        // Unknown cursor — same resync convention as the per-project read.
        resync = true;
      } else {
        positions = { ...decoded.p };
        for (const id of decoded.d) drained.add(id);
      }
    }

    // ---- fan-out: bounded count of project reads per request ----------
    const pending = targets.filter((id) => !drained.has(id));
    const queried = pending.slice(0, GLOBAL_INBOX_MAX_FANOUT);
    const overflow = pending.length - queried.length > 0;

    const merged: (Record<string, unknown> & { projectId: Id })[] = [];
    const counts: Record<string, number> = {};
    const lastEmitted: Record<string, Id> = {};
    const pageOf: Record<string, Record<string, unknown>[]> = {};
    const stillHasMore = new Set<Id>();
    let denied = 0;
    let errors = 0;
    let succeeded = 0;

    for (const projectId of queried) {
      const res = await fetchProjectInbox(
        env, request, projectId, positions[projectId] ?? null, limit,
      );
      if (res.kind === 'denied') { denied += 1; continue; }
      if (res.kind === 'error') { errors += 1; continue; }
      succeeded += 1;
      const body = res.body;
      if (body.resync === true) resync = true;
      mergeCounts(counts, body.counts);
      const page = (body.messages ?? []) as Record<string, unknown>[];
      pageOf[projectId] = page;
      for (const m of page) merged.push({ ...m, projectId });
      // The project's own nextCursor is authoritative for "more exists
      // after this page" inside that store.
      if (body.nextCursor !== null && body.nextCursor !== undefined) {
        stillHasMore.add(projectId);
      }
    }

    // When every candidate read failed, report honestly: dependency
    // errors outrank denials so an outage reads as 503, not a forged
    // 401; an indexed credential that authenticates nowhere is not
    // authenticated and gets 401 rather than a misleading empty inbox.
    if (succeeded === 0 && targets.length > 0) {
      if (errors > 0) {
        fail(503, 'dependency_unavailable', 'project reads failed', { retryable: true });
      }
      if (owner === null && !bearerIsOwner && denied > 0) {
        fail(401, 'unauthenticated', 'authentication required');
      }
    }

    // ---- merge, bounded page, next cursor ------------------------------
    merged.sort(byCreated);
    const emitted = merged.slice(0, limit);
    const emittedByProject = new Map<Id, Record<string, unknown>[]>();
    for (const m of emitted) {
      const list = emittedByProject.get(m.projectId) ?? [];
      list.push(m);
      emittedByProject.set(m.projectId, list);
    }
    let hasMore = overflow;
    for (const projectId of queried) {
      const fetched = pageOf[projectId];
      if (fetched === undefined) continue; // denied/errored: keep prior position
      const sent = emittedByProject.get(projectId) ?? [];
      if (sent.length > 0) {
        lastEmitted[projectId] = String(sent[sent.length - 1].id);
      }
      if (sent.length < fetched.length) hasMore = true;
      if (stillHasMore.has(projectId)) hasMore = true;
      if (!stillHasMore.has(projectId) && sent.length === fetched.length) {
        // Drained through this page: remove the position, mark done.
        drained.add(projectId);
        delete lastEmitted[projectId];
      }
    }
    for (const [k, v] of Object.entries(positions)) {
      if (!(k in lastEmitted) && !drained.has(k)) lastEmitted[k] = v;
    }

    const nextCursor = hasMore
      ? encodeCursor({ v: 1, p: lastEmitted, d: [...drained] })
      : null;

    return json(200, {
      messages: emitted,
      counts,
      nextCursor,
      resync,
      projectIds: targets,
      ...(errors > 0 ? { partial: true } : {}),
    });
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    return json(500, {
      error: {
        status: 500, code: 'internal_error',
        message: 'internal error', retryable: false,
      },
    });
  }
}
