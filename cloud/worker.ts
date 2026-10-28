import {consentPrincipal} from './remote-principal.ts';
import {PROJECT_HANDLERS} from './handlers.ts';
import {ConversationStore} from '../lib/conversation-store.ts';
// Cloudflare Worker composition for the Together slice, phase 04
// (lane c-swe-09).
//
// One worker owns authenticated HTTP/browser delivery in front of four
// SQLite Durable Objects: one durable directory (c-swe-01), one durable
// session store (c-swe-02), one ProjectObject per project (this file) and
// one ExecutionObject per project (c-swe-07). The private companion on
// Steve's host pulls scoped Git/check jobs OUTBOUND through
// /internal/v1/execution/* (c-swe-07); the worker never runs local Git or
// Docker, so missing bridge plumbing degrades to honest 503/
// git_unavailable/blocked-check answers -- never fabricated effects.
//
// Sibling lane modules are composed through the phase04-contract seam:
// each is resolved lazily via dynamic import so an absent merge artifact
// answers a truthful 503 dependency_unavailable instead of crashing or
// faking behavior. Once the controller merges all ten lanes, the same
// imports resolve statically inside the worker bundle and every route
// reaches its owned module.
//
// Header hygiene: markers that only trusted binding calls may set
// (x-together-internal-*, x-authorized-*) are stripped at the edge, so a
// public request can never forge an internal call.
//
// Trusted binding path documented for c-swe-01 (root create):
//   POST /internal/v1/projects/:id/init
//     headers: x-together-internal-init: directory-object
//     body: { projectId?, goal, ownerId, repositoryId, remote,
//             canonicalRef, operationId?, digest? }
//   The DO initializes its SQLite projection exactly once and reports the
//   stored record on replay (200 alreadyInitialized) so a lost ack can be
//   recovered from actual metadata; a conflicting owner is 409.

import { createApp } from './app.ts';
import type { ModuleHandler } from './app.ts';
import probeWorker from './artifacts-probe.ts';
import { authenticate, handleIdentity } from '../lib/identity.ts';
import type { OwnerToken } from '../lib/identity.ts';
import { authenticateCollector, handleChecks } from '../lib/checks.ts';
import { handleAssignments } from '../lib/assignments.ts';
import { handleChanges } from '../lib/changes.ts';
import { handleIntegration } from '../lib/integration.ts';
import { handleFindings } from '../lib/findings.ts';
import { handleReviews } from '../lib/reviews.ts';
import { handleInbox } from '../lib/inbox.ts';
import { handleEvents } from '../lib/events.ts';
import {
  ApiError, createState, errorResponse, fail, json, readJsonBody,
  requireProse,
} from '../lib/core.ts';
import { SQLiteStore } from '../lib/store.ts';
import type { DurableObjectStorageLike } from '../lib/store.ts';
import type {
  ArtifactsAdapter, GitService, Principal, ProjectState, RunnerService,
} from '../lib/types.ts';
import type {
  CloudEnv, CloudObjectState, CloudOwner, DirectoryProjectRecord,
} from './phase04-contract.ts';

// ---------------------------------------------------------------------------
// Cloud env: phase04 contract plus the pre-existing probe secret vars.
// ---------------------------------------------------------------------------
export interface TogetherCloudEnv extends CloudEnv {
  PROBE_TOKEN?: string;
  PROBE_REPO?: string;
}

// ---------------------------------------------------------------------------
// Lane-module seam. Importers use literal specifiers (bundlers resolve them
// into the worker at merge time); the `as string` cast keeps pre-merge
// typecheck/test honest about the files being absent from THIS packet.
// ---------------------------------------------------------------------------
type LaneModule = Record<string, unknown>;

const laneImporters: Record<string, () => Promise<LaneModule>> = {
  directory: () => import('./directory.ts' as string) as Promise<LaneModule>,
  sessions: () => import('./sessions.ts' as string) as Promise<LaneModule>,
  access: () => import('./access.ts' as string) as Promise<LaneModule>,
  'global-inbox': () => import('./global-inbox.ts' as string) as Promise<LaneModule>,
  'project-artifacts': () => import('./project-artifacts.ts' as string) as Promise<LaneModule>,
  'git-service': () => import('./git-service.ts' as string) as Promise<LaneModule>,
  execution: () => import('./execution.ts' as string) as Promise<LaneModule>,
  'check-service': () => import('./check-service.ts' as string) as Promise<LaneModule>,
};

const laneCache = new Map<string, Promise<LaneModule | null>>();

/**
 * Test-only seam: unit tests inject documented lane signatures here so the
 * composition contract is exercised without fabricating production modules.
 * Production code never populates this map.
 */
export const laneModuleOverrides = new Map<string, LaneModule | null>();

/** Resolve one sibling lane module; null means the merge artifact is absent. */
export function laneModule<T>(name: string): Promise<T | null> {
  const override = laneModuleOverrides.get(name);
  if (override !== undefined) return Promise.resolve(override as T | null);
  let cached = laneCache.get(name);
  if (cached === undefined) {
    const importer = laneImporters[name];
    cached = importer === undefined
      ? Promise.resolve(null)
      : importer().then((m) => m as LaneModule, () => null);
    laneCache.set(name, cached);
  }
  return cached as Promise<T | null>;
}

// Documented per-lane signatures (CLOUD-SPEC "Shared module exports").
interface DirectoryLane {
  DirectoryObject?: new (state: CloudObjectState, env: CloudEnv) => { fetch(request: Request): Promise<Response> };
  directoryFetch?(request: Request, env: CloudEnv, owner: CloudOwner | null): Promise<Response>;
  projectRecord?(env: CloudEnv, projectId: string): Promise<DirectoryProjectRecord | null>;
  ownerProjects?(env: CloudEnv, ownerId: string): Promise<DirectoryProjectRecord[]>;
  credentialProjects?(env: CloudEnv, digest: string): Promise<string[]>;
  indexCredential?(env: CloudEnv, digest: string, projectIds: string[]): Promise<void>;
}
interface SessionsLane {
  SessionObject?: new (state: CloudObjectState, env: CloudEnv) => { fetch(request: Request): Promise<Response> };
  resolveOwner?(request: Request, env: CloudEnv): Promise<CloudOwner | null>;
  sessionFetch?(request: Request, env: CloudEnv): Promise<Response>;
  loginFetch?(request: Request, env: CloudEnv): Promise<Response>;
  assertCloudOrigin?(request: Request, env: CloudEnv): void;
}
interface AccessLane {
  authenticateCloudRequest?(request: Request, env: CloudEnv, state: ProjectState): Promise<Principal | null>;
  discoverCredentialProjects?(request: Request, env: CloudEnv): Promise<string[]>;
  indexIssuedCredentials?(response: Response, env: CloudEnv, projectId: string): Promise<Response>;
}
interface GlobalInboxLane {
  globalInboxFetch?(request: Request, env: CloudEnv, owner: CloudOwner | null): Promise<Response>;
}
interface ArtifactsLane {
  createCloudArtifactsAdapter?(env: CloudEnv, record: DirectoryProjectRecord): ArtifactsAdapter;
  repositoryCapability?(env: CloudEnv, record: DirectoryProjectRecord, repositoryId: string, scope: 'read' | 'write'):
    Promise<{ repositoryId: string; remote: string; plaintext: string; expiresAt: string }>;
}
interface GitLane {
  createCloudGitService?(deps: {
    env: CloudEnv; record: DirectoryProjectRecord; state: () => Promise<ProjectState>;
  }): GitService;
}
interface ExecutionLane {
  ExecutionObject?: new (state: CloudObjectState, env: CloudEnv) => { fetch(request: Request): Promise<Response> };
  bridgeFetch?(request: Request, env: CloudEnv): Promise<Response>;
}
interface CheckLane {
  createCloudRunnerService?(deps: { env: CloudEnv; record: DirectoryProjectRecord }): RunnerService;
}

// ---------------------------------------------------------------------------
// Edge helpers.
// ---------------------------------------------------------------------------
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const INTERNAL_HEADER_RE = /^(x-together-internal(?:-|$)|x-authorized(?:-|$)|x-internal(?:-|$)|x-bootstrap(?:-|$)|x-bridge(?:-|$)|x-git(?:-|$)|x-check(?:-|$)|x-collector(?:-|$))/i;
const INTERNAL_INIT_HEADER = 'x-together-internal-init';
const INTERNAL_INIT_MARKER = 'directory-object';
const SAME_ORIGIN_SITES = new Set(['same-origin', 'same-site']);

/** Truthful absence: a composed seam is missing from this build. */
function dependencyUnavailable(detail: string): Response {
  const response = json(503, {
    error: {
      status: 503,
      code: 'dependency_unavailable',
      message: `cloud composition dependency unavailable: ${detail}`,
      retryable: true,
      nextAction: 'controller merges the owning lane module before deployment',
    },
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}

function mapThrown(err: unknown): Response {
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

/** Strip caller-forged internal markers; trusted binding calls set them server-side only. */
export function stripInternalHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  let removed = false;
  for (const name of [...headers.keys()]) {
    if (INTERNAL_HEADER_RE.test(name)) {
      headers.delete(name);
      removed = true;
    }
  }
  return removed ? new Request(request, { headers }) : request;
}

function allowedOrigins(env: CloudEnv): string[] {
  return String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Cross-site write gate. Browser mutating requests need an allowed Origin
 * or same-origin Fetch Metadata; explicit bearer CLI clients may omit
 * Origin. Delegates to c-swe-02's assertCloudOrigin once that module is
 * merged; until then the same policy is enforced here.
 */
async function assertEdgeOrigin(request: Request, env: CloudEnv): Promise<void> {
  if (!MUTATING.has(request.method.toUpperCase())) return;
  const sessions = await laneModule<SessionsLane>('sessions');
  if (sessions?.assertCloudOrigin !== undefined) {
    sessions.assertCloudOrigin(request, env);
    return;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  const site = fetchSite === null ? null : fetchSite.toLowerCase();
  if (site !== null && SAME_ORIGIN_SITES.has(site)) return;
  if (site !== null && site !== 'none') {
    fail(403, 'origin_denied', 'cross-site requests are not accepted');
  }
  const origin = request.headers.get('origin');
  if (origin !== null) {
    const own = new URL(request.url).origin;
    if (origin === own || allowedOrigins(env).includes(origin)) return;
    fail(403, 'origin_denied', `origin ${origin} is not allowed`);
  }
  // No browser metadata to trust: only an explicit bearer credential may
  // drive a mutation (cookie-only posts never authorize this way).
  if (request.headers.get('authorization') === null) {
    fail(403, 'origin_denied', 'mutating requests need an allowed Origin, same-origin fetch metadata, or a bearer credential');
  }
}

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

/**
 * Edge owner resolution for root/asset surfaces. c-swe-02 resolveOwner
 * covers durable cookie sessions once merged; until then env-only owner
 * bearer tokens still authenticate (cookie sessions stay unavailable
 * rather than faked).
 */
async function resolveOwnerEdge(request: Request, env: CloudEnv): Promise<CloudOwner | null> {
  const sessions = await laneModule<SessionsLane>('sessions');
  if (sessions?.resolveOwner !== undefined) {
    try {
      return await sessions.resolveOwner(request, env);
    } catch {
      return null;
    }
  }
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!match) return null;
  for (const token of ownerTokensFromEnv(env)) {
    if (token.token === match[1]) return { id: token.ownerId, ownerId: token.ownerId };
  }
  return null;
}

function withCacheControl(response: Response, value: string): Response {
  const out = new Response(response.body, response);
  out.headers.set('cache-control', value);
  return out;
}

const noStore = (response: Response): Response => withCacheControl(response, 'no-store');
const privately = (response: Response): Response => {
  const out = withCacheControl(response, 'private, no-store');
  out.headers.set('vary', 'Cookie, Authorization');
  return out;
};

/** Session-gated static delivery; /login is the only anonymous surface. */
async function gatedAssets(request: Request, env: TogetherCloudEnv): Promise<Response> {
  const owner = await resolveOwnerEdge(request, env);
  if (owner === null) {
    const acceptsHtml = request.headers.get('accept')?.includes('text/html') ?? false;
    if ((request.method === 'GET' || request.method === 'HEAD') && acceptsHtml) {
      const url = new URL(request.url);
      const next = encodeURIComponent(url.pathname + url.search);
      return Response.redirect(`${url.origin}/login?next=${next}`, 302);
    }
    return json(401, {
      error: { status: 401, code: 'unauthenticated', message: 'owner session required', retryable: false },
    });
  }
  if (env.ASSETS === undefined) return dependencyUnavailable('ASSETS binding');
  const response = await env.ASSETS.fetch(request);
  const acceptsHtml = request.headers.get('accept')?.includes('text/html') ?? false;
  if (response.status === 404 && acceptsHtml && (request.method === 'GET' || request.method === 'HEAD')) {
    const indexUrl = new URL(request.url);
    // The asset service redirects /index.html to /. Fetch its canonical
    // root internally so the browser keeps the requested SPA deep link.
    indexUrl.pathname = '/';
    indexUrl.search = '';
    return privately(await env.ASSETS.fetch(new Request(indexUrl, request)));
  }
  return privately(response);
}

// ---------------------------------------------------------------------------
// Durable Object exports. c-swe-01/02/07 own the real classes; wrangler
// needs concrete exported classes, so these thin delegators construct the
// merged lane class on first use and answer 503 while it is absent.
// ---------------------------------------------------------------------------
abstract class DelegatingObject {
  private inner: { fetch(request: Request): Promise<Response> } | null = null;
  private state: CloudObjectState;
  private env: CloudEnv;
  private laneName: string;
  private exportName: string;
  private specifier: string;
  constructor(
    state: CloudObjectState,
    env: CloudEnv,
    laneName: string,
    exportName: string,
    specifier: string,
  ) {
    this.state = state;
    this.env = env;
    this.laneName = laneName;
    this.exportName = exportName;
    this.specifier = specifier;
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (this.inner === null) {
        const mod = await laneModule<LaneModule>(this.laneName);
        const Ctor = mod?.[this.exportName] as
          (new (state: CloudObjectState, env: CloudEnv) => { fetch(request: Request): Promise<Response> }) | undefined;
        if (Ctor === undefined) return dependencyUnavailable(`${this.specifier}:${this.exportName}`);
        this.inner = new Ctor(this.state, this.env);
      }
      return await this.inner.fetch(request);
    } catch (err) {
      return mapThrown(err);
    }
  }
}

export class DirectoryObject extends DelegatingObject {
  constructor(state: CloudObjectState, env: CloudEnv) {
    super(state, env, 'directory', 'DirectoryObject', 'cloud/directory.ts');
  }
}
export class SessionObject extends DelegatingObject {
  constructor(state: CloudObjectState, env: CloudEnv) {
    super(state, env, 'sessions', 'SessionObject', 'cloud/sessions.ts');
  }
}
export class ExecutionObject extends DelegatingObject {
  constructor(state: CloudObjectState, env: CloudEnv) {
    super(state, env, 'execution', 'ExecutionObject', 'cloud/execution.ts');
  }
}

// ---------------------------------------------------------------------------
// ProjectObject — one per project, owned by this lane.
// ---------------------------------------------------------------------------


export class ProjectObject {
  private store: SQLiteStore;
  private conversation: ConversationStore;
  private projectId: string;
  private recordPromise: Promise<DirectoryProjectRecord | null> | null = null;
  private objectState: CloudObjectState;
  private env: TogetherCloudEnv;

  constructor(objectState: CloudObjectState, env: TogetherCloudEnv) {
    this.objectState = objectState;
    this.env = env;
    this.projectId = objectState.id.name ?? objectState.id.toString();
    this.conversation = new ConversationStore(objectState.storage as unknown as DurableObjectStorageLike);
    this.store = new SQLiteStore({
      storage: objectState.storage as unknown as DurableObjectStorageLike,
      projectId: this.projectId,
    });
    objectState.blockConcurrencyWhile?.(async () => this.store.init());
  }

  /** Trusted directory data; cached only once real, retried while absent. */
  private directoryRecord(): Promise<DirectoryProjectRecord | null> {
    if (this.recordPromise === null) {
      this.recordPromise = (async () => {
        const directory = await laneModule<DirectoryLane>('directory');
        if (directory?.projectRecord === undefined) return null;
        try {
          return await directory.projectRecord(this.env, this.projectId);
        } catch {
          return null;
        }
      })();
    }
    const pending = this.recordPromise;
    return pending.then((record) => {
      if (record === null && this.recordPromise === pending) this.recordPromise = null;
      return record;
    });
  }

  /** Internal one-shot initialization invoked only by the directory binding. */
  private async initProject(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_INIT_HEADER) !== INTERNAL_INIT_MARKER) {
      fail(403, 'internal_only', 'project initialization is a trusted binding call');
    }
    const body = await readJsonBody(request);
    if (body.projectId !== undefined && body.projectId !== this.projectId) {
      fail(422, 'project_mismatch', 'init body does not match this object');
    }
    const goal = requireProse(body.goal, 'goal').trim();
    if (goal === '') fail(422, 'invalid_field', '"goal" must be non-empty');
    const ownerId = requireProse(body.ownerId, 'ownerId');
    const repositoryId = requireProse(body.repositoryId, 'repositoryId');
    const remote = requireProse(body.remote, 'remote');
    const canonicalRef = requireProse(
      body.canonicalRef ?? this.env.TEST_CANONICAL_REF ?? 'refs/heads/together-cloud',
      'canonicalRef',
    );
    try {
      const now = new Date().toISOString();
      const initial = createState({
        id: this.projectId, goal, mode: 'live', actorId: `owner:${ownerId}`, canonicalRef,
      });
      initial.project.repositories.artifacts = {
        role: 'canonical', repositoryId, remote,
      };
      initial.project.ownerId = ownerId;
      initial.project.bootstrapOperation = {
        operationId: typeof body.operationId === 'string' ? body.operationId : null,
        digest: typeof body.digest === 'string' ? body.digest : null,
        provisionedAt: now,
      };
      initial.identities[ownerId] = {
        id: ownerId, projectId: this.projectId, revision: 1,
        createdAt: now, updatedAt: now, actorId: `owner:${ownerId}`,
        displayName: 'Project owner', ownerId, creationSource: 'owner', status: 'active',
      };
      initial.members[`mem-${ownerId}`] = {
        id: `mem-${ownerId}`, projectId: this.projectId, revision: 1,
        createdAt: now, updatedAt: now, actorId: `owner:${ownerId}`,
        identityId: ownerId, kind: 'core', scopes: ['owner', 'admin', 'read'],
      };
      this.store.initialize(initial);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 409) throw err;
      // Recovery over actual metadata: replaying the same init reports the
      // stored projection; a conflicting owner is a real conflict.
      const stored = await this.store.read();
      const repo = stored.project.repositories.artifacts;
      const bootstrap = stored.project.bootstrapOperation as { operationId?: unknown; digest?: unknown } | undefined;
      if (stored.project.ownerId !== ownerId || repo?.repositoryId !== repositoryId ||
          repo?.remote !== remote || stored.project.canonicalRef !== canonicalRef ||
          stored.project.goal !== goal ||
          (body.operationId !== undefined && bootstrap?.operationId !== body.operationId) ||
          (body.digest !== undefined && bootstrap?.digest !== body.digest)) {
        fail(409, 'conflicting_init', 'project initialization conflicts with stored provenance');
      }
      const { id, goal: g, mode, canonicalRef: ref, revision } = stored.project;
      return json(200, {
        projectId: this.projectId,
        alreadyInitialized: true,
        project: { id, goal: g, mode, canonicalRef: ref, revision },
      });
    }
    return json(201, { projectId: this.projectId, initialized: true });
  }

  private async authenticateRequest(request: Request, record: DirectoryProjectRecord): Promise<Principal | null> {
    const state = await this.store.read();
    const access = await laneModule<AccessLane>('access');
    if (access?.authenticateCloudRequest !== undefined) {
      return access.authenticateCloudRequest(request, this.env, state);
    }
    let principal =
      (await authenticate(request, state, { ownerTokens: ownerTokensFromEnv(this.env) })) ??
      (await authenticateCollector(request, state));
    if (principal === null) {
      // Durable owner browser session via c-swe-02 once merged.
      const sessions = await laneModule<SessionsLane>('sessions');
      if (sessions?.resolveOwner !== undefined) {
        const owner = await sessions.resolveOwner(request, this.env);
        if (owner !== null && owner.ownerId === record.ownerId) {
          principal = {
            id: owner.id,
            sessionId: `cloud-session:${owner.id}`,
            kind: 'human',
            ownerId: owner.ownerId,
            scopes: ['owner', 'admin', 'read'],
            projectIds: [record.id],
          };
        }
      }
    }
    // Directory ownership is authoritative: an unrelated owner's token is
    // never authority on this project.
    if (principal !== null && principal.kind === 'human' && principal.ownerId !== record.ownerId) {
      return null;
    }
    return principal;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if(url.pathname.startsWith(`/internal/v1/mcp/${encodeURIComponent(this.projectId)}`)){
        // This route is reachable only through the private DO binding. The public edge strips all internal headers.
        if((this.env as any).TOGETHER_REMOTE_MCP_ENABLED!=='true')return json(503,{error:{code:'remote_disabled'}});
        let consent:any;try{consent=JSON.parse(request.headers.get('x-together-internal-oauth')??'null')}catch{return json(401,{error:{code:'invalid_consent'}})}
        const current=await this.store.read();const principal=consentPrincipal(current,consent,new Date().toISOString());
        const prefix=`/internal/v1/mcp/${encodeURIComponent(this.projectId)}`;const suffix=url.pathname.slice(prefix.length);
        if(suffix&&!suffix.startsWith('/'))return json(404,{error:{code:'not_found'}});
        url.pathname=`/api/v1/projects/${encodeURIComponent(this.projectId)}`+suffix;
        const key=principal.id+':'+principal.sessionId;const counts=((this as any).mcpInflight??=new Map<string,number>());
        if((counts.get(key)??0)>=2)return json(429,{error:{code:'concurrency_limit'}});counts.set(key,(counts.get(key)??0)+1);
        const app=createApp({store:this.store,conversation:this.conversation,handlers:PROJECT_HANDLERS,authenticate:async()=>consentPrincipal(await this.store.read(),consent,new Date().toISOString())});
        const headers=new Headers(request.headers);headers.delete('x-together-internal-oauth');
        const work=app.fetch(new Request(url,{method:request.method,headers,...(request.method==='GET'?{}:{body:await request.text()})})).finally(()=>counts.set(key,Math.max(0,(counts.get(key)??1)-1)));
        let timer:ReturnType<typeof setTimeout>;
        try{return await Promise.race([work,new Promise<Response>(resolve=>{timer=setTimeout(()=>resolve(json(504,{error:{code:'outcome_unconfirmed',message:'Deadline exceeded; reconcile the same request ID before retrying.'}})),15000)})]);}finally{clearTimeout(timer!);}
      }
      if (request.method === 'POST' && url.pathname === `/internal/v1/projects/${this.projectId}/init`) {
        return await this.initProject(request);
      }
      if (!url.pathname.startsWith('/api/')) {
        return json(404, {
          error: { status: 404, code: 'not_found', message: 'not an API route', retryable: false },
        });
      }

      const directory = await laneModule<DirectoryLane>('directory');
      if (directory?.projectRecord === undefined) {
        return dependencyUnavailable('cloud/directory.ts:projectRecord');
      }
      const record = await this.directoryRecord();
      if (record === null) {
        return json(404, {
          error: { status: 404, code: 'not_found', message: 'unknown or inaccessible project', retryable: false },
        });
      }
      if (record.provisioning !== 'ready') {
        return json(503, {
          error: {
            status: 503, code: 'project_provisioning',
            message: `project provisioning is ${record.provisioning}`, retryable: true,
          },
        });
      }

      const [access, gitLane, checkLane, artifactsLane] = await Promise.all([
        laneModule<AccessLane>('access'),
        laneModule<GitLane>('git-service'),
        laneModule<CheckLane>('check-service'),
        laneModule<ArtifactsLane>('project-artifacts'),
      ]);
      // Per-project Git/runner/artifacts capabilities bound to the trusted
      // directory record — absent lanes leave honest 503/blocked handlers.
      const git = gitLane?.createCloudGitService !== undefined
        ? gitLane.createCloudGitService({ env: this.env, record, state: () => this.store.read() })
        : undefined;
      const runner = checkLane?.createCloudRunnerService !== undefined
        ? checkLane.createCloudRunnerService({ env: this.env, record })
        : undefined;
      const artifacts = artifactsLane?.createCloudArtifactsAdapter !== undefined
        ? artifactsLane.createCloudArtifactsAdapter(this.env, record)
        : undefined;
      const app = createApp({
        store: this.store,
        authenticate: (req: Request) => this.authenticateRequest(req, record),
        handlers: PROJECT_HANDLERS,
        conversation: this.conversation,
        ...(git !== undefined ? { git } : {}),
        ...(runner !== undefined ? { runner } : {}),
        ...(artifacts !== undefined ? { artifacts } : {}),
      });
      try {
        let response = await app.fetch(request);
        if (access?.indexIssuedCredentials !== undefined) {
          response = await access.indexIssuedCredentials(response, this.env, this.projectId);
        }
        return response;
      } finally {
        artifacts?.[Symbol.dispose]?.();
      }
    } catch (err) {
      return mapThrown(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entry: sanitized routing over the four DOs, the execution bridge,
// root API surfaces, the arrival probe and session-gated assets.
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: TogetherCloudEnv): Promise<Response> {
    const sanitized = stripInternalHeaders(request);
    try {
      const url = new URL(sanitized.url);
      const path = url.pathname;
      const parts = path.split('/').filter(Boolean);

      // Existing independently-authenticated arrival probe (unchanged).
      if (path === '/probe/health' || path.startsWith('/probe/')) {
        return noStore(await probeWorker.fetch(sanitized, env));
      }

      // Anonymous auth surface only; everything else requires access.
      if (path === '/login' || path === '/logout') {
        const sessions = await laneModule<SessionsLane>('sessions');
        if (sessions?.loginFetch === undefined) {
          return dependencyUnavailable('cloud/sessions.ts:loginFetch');
        }
        return noStore(await sessions.loginFetch(sanitized, env));
      }

      // Private execution bridge: purpose-scoped bearer tokens are checked
      // inside c-swe-07's bridgeFetch; only the route is composed here.
      if (path.startsWith('/internal/v1/execution/')) {
        const execution = await laneModule<ExecutionLane>('execution');
        if (execution?.bridgeFetch === undefined) {
          return dependencyUnavailable('cloud/execution.ts:bridgeFetch');
        }
        return noStore(await execution.bridgeFetch(sanitized, env));
      }

      if (parts[0] === 'api' && parts[1] === 'v1') {
        await assertEdgeOrigin(sanitized, env);

        if (parts[2] === 'session' && parts.length === 3) {
          const sessions = await laneModule<SessionsLane>('sessions');
          if (sessions?.sessionFetch === undefined) {
            return dependencyUnavailable('cloud/sessions.ts:sessionFetch');
          }
          return noStore(await sessions.sessionFetch(sanitized, env));
        }

        if (parts[2] === 'projects' && parts.length === 3) {
          const directory = await laneModule<DirectoryLane>('directory');
          if (directory?.directoryFetch === undefined) {
            return dependencyUnavailable('cloud/directory.ts:directoryFetch');
          }
          const owner = await resolveOwnerEdge(sanitized, env);
          if (owner === null && sanitized.method === 'GET') {
            const access = await laneModule<AccessLane>('access');
            const ids = await access?.discoverCredentialProjects?.(sanitized, env) ?? [];
            const projects: Record<string, unknown>[] = [];
            // The hash index discovers candidates only. Every entry must
            // authenticate again against the current project's live state.
            for (const id of ids.slice(0, 64)) {
              if (env.PROJECT_OBJECT === undefined) return dependencyUnavailable('PROJECT_OBJECT binding');
              const target = new URL(sanitized.url);
              target.pathname = `/api/v1/projects/${encodeURIComponent(id)}`;
              target.search = '';
              const response = await env.PROJECT_OBJECT.get(env.PROJECT_OBJECT.idFromName(id)).fetch(new Request(target, sanitized));
              if (!response.ok) continue;
              const state = await response.json() as { project?: Record<string, unknown> };
              if (state.project?.id === id) projects.push(state.project);
            }
            if (projects.length > 0) return noStore(json(200, { projects }));
          }
          return noStore(await directory.directoryFetch(sanitized, env, owner));
        }

        if (parts[2] === 'inbox' && parts.length === 3 && sanitized.method === 'GET') {
          const inbox = await laneModule<GlobalInboxLane>('global-inbox');
          if (inbox?.globalInboxFetch === undefined) {
            return dependencyUnavailable('cloud/global-inbox.ts:globalInboxFetch');
          }
          const owner = await resolveOwnerEdge(sanitized, env);
          return noStore(await inbox.globalInboxFetch(sanitized, env, owner));
        }

        if (parts[2] === 'projects' && parts.length >= 4) {
          if (env.PROJECT_OBJECT === undefined) {
            return dependencyUnavailable('PROJECT_OBJECT binding');
          }
          const projectId = decodeURIComponent(parts[3]);
          const stub = env.PROJECT_OBJECT.get(env.PROJECT_OBJECT.idFromName(projectId));
          return noStore(await stub.fetch(sanitized));
        }

        return json(404, {
          error: { status: 404, code: 'not_found', message: 'unknown route', retryable: false },
        });
      }

      // All remaining paths are the hosted UI: owner-session gated assets
      // with the SPA index fallback for app routes.
      return await gatedAssets(sanitized, env);
    } catch (err) {
      return mapThrown(err);
    }
  },
};
