// Scoped cloud access for the phase04 Cloudflare deployment (seat c-swe-03).
//
// authenticateCloudRequest is the per-project authority gate the worker
// composition (c-swe-09) installs as the ProjectObject authenticate hook.
// It refuses requests carrying internal-authorization-shaped headers and
// /internal/* paths, resolves a principal from the LIVE durable
// ProjectState (owner tokens, agent credentials with bound sessions, and
// job-scoped collector tokens are re-validated every request so
// revoke/expiry takes effect immediately), then checks the trusted
// directory record so one owner's authority can never reach another
// owner's project.
//
// Directory and browser-session lookups go through the other lanes'
// required named exports -- projectRecord/credentialProjects/
// indexCredential from cloud/directory.ts (c-swe-01) and resolveOwner from
// cloud/sessions.ts (c-swe-02). The optional env.ACCESS_SEAMS injection
// point exists so tests can substitute those seams without depending on
// another lane's internal durable-object route conventions; production
// bindings never set it.
//
// discoverCredentialProjects supports root project discovery/global inbox
// (spec item 4): an agent's bearer token is hashed locally and only the
// SHA-256 digest crosses the credential index. The index is discovery
// only -- authenticateCloudRequest re-derives authority from live state on
// every read.
//
// indexIssuedCredentials runs after a credential-minting response: it
// clones the response, indexes ONLY genuinely new credential token hashes
// under the issuing project, and returns the original one-time response
// object untouched so the plaintext still reaches its recipient exactly
// once and is never stored or logged here.

import { ApiError } from '../lib/core.ts';
import { authenticate, hashToken, OWNER_SCOPES } from '../lib/identity.ts';
import type { OwnerToken } from '../lib/identity.ts';
import { authenticateCollector } from '../lib/checks.ts';
import type { Principal, ProjectState } from '../lib/types.ts';
import type { CloudEnv, CloudOwner, DirectoryProjectRecord } from './phase04-contract.ts';
import {
  credentialProjects as directoryCredentialProjects,
  indexCredential as directoryIndexCredential,
  projectRecord as directoryProjectRecord,
} from './directory.ts';
import { resolveOwner as sessionResolveOwner } from './sessions.ts';

/** Cross-lane seams this module consumes (production = c-swe-01/c-swe-02 exports). */
export interface AccessSeams {
  projectRecord(env: CloudEnv, projectId: string): Promise<DirectoryProjectRecord | null>;
  credentialProjects(env: CloudEnv, digest: string): Promise<string[]>;
  indexCredential(env: CloudEnv, digest: string, projectIds: string[]): Promise<void>;
  resolveOwner(request: Request, env: CloudEnv): Promise<CloudOwner | null>;
}

const DEFAULT_SEAMS: AccessSeams = {
  projectRecord: directoryProjectRecord,
  credentialProjects: directoryCredentialProjects,
  indexCredential: directoryIndexCredential,
  resolveOwner: sessionResolveOwner,
};

const MAX_TOKEN_CHARS = 1024;
const MAX_DISCOVERY_PROJECTS = 256;
const MAX_PROJECT_ID_CHARS = 256;
const MAX_ISSUED_TOKENS_PER_RESPONSE = 4;

/**
 * Header names that resemble internal authorization. They are minted only
 * by trusted edge/binding code (bootstrap proof, execution-bridge
 * purposes, collector delivery); a public request presenting one is
 * refused rather than stripped so a spoofed mark cannot leak past a
 * misordered edge.
 */
const INTERNAL_AUTH_HEADER_NAMES: ReadonlySet<string> = new Set([
  'x-bootstrap-token',
  'x-authorized-bootstrap',
  'x-bridge-token',
  'x-git-bridge-token',
  'x-check-bridge-token',
  'x-collector-token',
  'x-internal-auth',
]);
const INTERNAL_AUTH_HEADER_PREFIXES: readonly string[] = [
  'x-internal-',
  'x-authorized-',
  'x-together-internal',
];

function carriesInternalAuthorization(request: Request): boolean {
  for (const rawName of request.headers.keys()) {
    const name = rawName.toLowerCase();
    if (INTERNAL_AUTH_HEADER_NAMES.has(name)) return true;
    if (INTERNAL_AUTH_HEADER_PREFIXES.some((p) => name.startsWith(p))) return true;
  }
  return false;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!match) return null;
  const token = match[1];
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  return token;
}

/** env-only owner authority, parsed defensively (mirrors worker.ts). */
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

/** The project id this request addresses, or null when the path names none. */
function requestedProjectId(request: Request): string | null {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'projects' && segments[3] !== undefined) {
    const id = decodeURIComponent(segments[3]);
    return id.length <= MAX_PROJECT_ID_CHARS ? id : null;
  }
  return null;
}

function injectedSeams(env: CloudEnv): Partial<AccessSeams> {
  const raw = env.ACCESS_SEAMS;
  return raw !== null && typeof raw === 'object' ? (raw as Partial<AccessSeams>) : {};
}

function seams(env: CloudEnv): AccessSeams {
  const injected = injectedSeams(env);
  const pick = <K extends keyof AccessSeams>(name: K): AccessSeams[K] =>
    typeof injected[name] === 'function' ? (injected[name] as AccessSeams[K]) : DEFAULT_SEAMS[name];
  return {
    projectRecord: pick('projectRecord'),
    credentialProjects: pick('credentialProjects'),
    indexCredential: pick('indexCredential'),
    resolveOwner: pick('resolveOwner'),
  };
}

function seamAvailable(env: CloudEnv, name: keyof AccessSeams): boolean {
  return typeof injectedSeams(env)[name] === 'function';
}

/**
 * Directory ownership gate: the durable record is authoritative for who
 * owns this project. Owners (token or browser session) must match
 * record.ownerId exactly; agents must resolve to a live identity owned by
 * that owner AND hold a credential scoped to this project; collectors are
 * already bound to a live job in this project's durable state and may
 * only exercise their job-scoped route.
 */
function principalMatchesRecord(
  principal: Principal,
  record: DirectoryProjectRecord,
  state: ProjectState,
): boolean {
  if (principal.kind === 'collector') {
    return principal.projectIds.includes(state.project.id);
  }
  if (principal.kind === 'human' || principal.kind === 'system') {
    return principal.ownerId === record.ownerId;
  }
  const identity = state.identities[principal.id];
  if (identity === undefined || identity.status !== 'active') return false;
  if (identity.ownerId !== record.ownerId) return false;
  return principal.projectIds.includes(state.project.id);
}

/**
 * Resolve a request to a server-side Principal for this project object.
 *
 * Returns null (caller answers 401) for: internal-authorization-shaped
 * headers, /internal/* paths, a path project id that is not this object's
 * project, unresolvable credentials, an owner whose id is not the
 * directory record's ownerId, a directory lookup that fails or names a
 * different project, and revoked/expired/missing auth records. A missing
 * DIRECTORY_OBJECT binding fails closed; local development uses its
 * separate local-server authentication implementation.
 */
export async function authenticateCloudRequest(
  request: Request,
  env: CloudEnv,
  state: ProjectState,
): Promise<Principal | null> {
  if (carriesInternalAuthorization(request)) return null;
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  if (segments[0] === 'internal') return null;
  const projectId = requestedProjectId(request) ?? state.project.id;
  if (projectId !== state.project.id) return null;

  let principal =
    (await authenticate(request, state, { ownerTokens: ownerTokensFromEnv(env) })) ??
    (await authenticateCollector(request, state));

  // An explicit bearer that fails to resolve never falls through to a
  // cookie session: ambiguous credentials are denied, not downgraded.
  if (principal === null && !request.headers.has('authorization')) {
    let owner: CloudOwner | null = null;
    try {
      owner = await seams(env).resolveOwner(request, env);
    } catch {
      owner = null;
    }
    if (owner !== null) {
      principal = {
        id: owner.ownerId,
        sessionId: owner.id,
        kind: 'human',
        ownerId: owner.ownerId,
        scopes: [...OWNER_SCOPES],
        projectIds: [state.project.id],
      };
    }
  }
  if (principal === null) return null;

  const directoryBound = env.DIRECTORY_OBJECT !== undefined || seamAvailable(env, 'projectRecord');
  if (!directoryBound) return null;
  if (directoryBound) {
    let record: DirectoryProjectRecord | null;
    try {
      record = await seams(env).projectRecord(env, projectId);
    } catch {
      // Fail closed: ownership cannot be verified, so nothing is authority.
      return null;
    }
    if (record === null || record.id !== projectId) return null;
    if (!principalMatchesRecord(principal, record, state)) return null;
  }
  return principal;
}

/**
 * Discovery-only credential index lookup for root project listing/global
 * inbox. The bearer token is hashed locally; ONLY the digest is sent to
 * the directory index, which is never consulted for authentication --
 * per-project authority is always re-derived from live state. Owner
 * discovery is a separate owner-scoped helper; collector tokens are never
 * indexed so their hashes answer empty by construction.
 */
export async function discoverCredentialProjects(
  request: Request,
  env: CloudEnv,
): Promise<string[]> {
  if (carriesInternalAuthorization(request)) return [];
  const token = bearerToken(request);
  if (token === null) return [];
  const directoryBound = env.DIRECTORY_OBJECT !== undefined || seamAvailable(env, 'credentialProjects');
  if (!directoryBound) return [];
  const digest = await hashToken(token);
  let projectIds: string[];
  try {
    projectIds = await seams(env).credentialProjects(env, digest);
  } catch {
    // The index is an availability-limited dependency: report it honestly
    // rather than silently claiming the credential sees no projects.
    throw new ApiError(503, 'credential_index_unavailable', 'credential discovery index unavailable');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of projectIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PROJECT_ID_CHARS) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_DISCOVERY_PROJECTS) break;
  }
  return out;
}

/**
 * Post-issuance index hook for one-time credential responses (spec item
 * 4: "Index newly issued agent credentials by hash/project only, never
 * plaintext"). The composition wraps the enrollment-exchange response
 * with this; the clone is inspected, the ORIGINAL response is returned
 * unchanged so the plaintext reaches its recipient exactly once.
 *
 * Only a response that actually minted an agent credential is indexed --
 * the exchange shape carries a credentialId alongside the one-time token.
 * Invitation mints, deduplicated/replayed bodies and unrelated
 * token-shaped fields are never indexed. Indexing is best-effort: the
 * credential is already issued, so an index failure degrades discovery
 * only and must not destroy the one-time response.
 */
export async function indexIssuedCredentials(
  response: Response,
  env: CloudEnv,
  projectId: string,
): Promise<Response> {
  if (!response.ok) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (body === null || typeof body !== 'object') return response;
  const rec = body as Record<string, unknown>;
  if (typeof rec.credentialId !== 'string') return response;
  if (typeof rec.token !== 'string' || rec.token.length === 0 || rec.token.length > MAX_TOKEN_CHARS) {
    return response;
  }
  const directoryBound = env.DIRECTORY_OBJECT !== undefined || seamAvailable(env, 'indexCredential');
  if (!directoryBound) return response;
  const tokens = [rec.token].slice(0, MAX_ISSUED_TOKENS_PER_RESPONSE);
  for (const token of tokens) {
    try {
      await seams(env).indexCredential(env, await hashToken(token), [projectId]);
    } catch {
      // Best-effort discovery index: never lose or mutate the issued
      // response because a non-authoritative index is down.
    }
  }
  return response;
}
