import {openConversationStore} from './local-conversation.ts';
import { LocalSessionStore, localSessionTtlSeconds } from './local-sessions.ts';
import type {RuntimeBinding} from '../lib/run-state.ts';
import {PROJECT_HANDLERS} from './handlers.ts';
import {ConversationStore} from '../lib/conversation-store.ts';
// Local development API server for the Together slice (integrator wiring).
//
// Composes the same module handlers used by the Cloudflare worker so
// `npm run dev:api` + `npm run dev` exercise the real API surface (auth,
// idempotent operations, safe views) without wrangler.
//
// Owner authentication, three separate facts:
//   - Bearer tokens (env-configured owner tokens and issued agent
//     credentials) authenticate CLI/MCP clients exactly like the worker.
//   - POST /api/v1/session exchanges a valid owner bearer token for an
//     HttpOnly SameSite=Strict cookie scoped to /api, so the browser UI can
//     run live mode without storing a long-lived token in script-readable
//     storage. DELETE ends the session, GET reports who is authenticated.
//   - Mutating requests pass an origin check: a present Origin header must
//     be a loopback origin and Sec-Fetch-Site: cross-site is refused, so
//     cookie-authenticated writes cannot be driven cross-site.
//
// Projects: the owner lists (GET /api/v1/projects) and creates
// (POST /api/v1/projects) live projects; each gets its own store and
// module-handler app, the same composition one Durable Object serves.
//
// Environment:
//   TOGETHER_OWNER_TOKEN   required operator-configured owner bearer token;
//                          the server never prints it.
//   TOGETHER_OWNER_ID      owner identity id (default 'steve').
//   TOGETHER_PROJECT_ID    id of the seeded project (default 'local-live-1');
//                          ignored when a state dir already holds projects.
//   TOGETHER_STATE_DIR     directory for durable per-project state
//                          (JsonFileStore). Unset means in-memory only;
//                          restart resets state. Corrupt files fail closed.
//   TOGETHER_GIT_REPO      path to a real local git repository; when set the
//                          bounded LocalGitService is wired and combine /
//                          integrate run real git operations. When unset,
//                          those routes answer 503 git_unavailable honestly.
//   TOGETHER_RUNNER        'docker' wires the snapshot check runner (real
//                          Docker required); otherwise absent and checks
//                          register 'blocked'.
//   Checks materialize the exact candidate Git SHA in an owned snapshot.
//   PORT                   listen port (default 8937; vite proxies /api here).
//                          The server binds 127.0.0.1 only -- it holds owner
//                          authority and is never a LAN-facing service.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.ts';
import type { ModuleHandler } from './app.ts';
import { JsonFileStore, readPersistedState, stateFileName } from './local-store.ts';
import {
  ApiError, assertCreationRevision, createEnvelope, createState, digestOf, errorResponse, fail, json, readJsonBody, requireProse,
} from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { authenticate, handleIdentity } from '../lib/identity.ts';
import type { OwnerToken } from '../lib/identity.ts';
import { authenticateCollector, handleChecks } from '../lib/checks.ts';
import { handleAssignments } from '../lib/assignments.ts';
import { handleChanges } from '../lib/changes.ts';
import { handleIntegration } from '../lib/integration.ts';
import { handleFindings } from '../lib/findings.ts';
import { handleReviews } from '../lib/reviews.ts';
import { handleInbox, handleGlobalInbox, handleMultiProjectInbox } from '../lib/inbox.ts';
import { handleEvents } from '../lib/events.ts';
import { createLocalWorkspaceAdapter } from '../adapters/local-workspace.ts';
import { createLocalGitService } from '../adapters/local-git.ts';
import { materializeGitSnapshot } from '../runner/git-snapshot.ts';
import { createSnapshotRunner } from '../runner/snapshot-runner.ts';
import type { SnapshotRunnerOptions, CollectorTransport } from '../runner/snapshot-runner.ts';
import type {
  GitService, Principal, ProjectState, RunnerService, Store,
} from '../lib/types.ts';

const SESSION_COOKIE = 'together_session';
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);



export interface LocalApiOptions {
  /** Optional local-only agent surface; owner authentication/origin checks still apply. */
  localAgent?: {fetch(request:Request,projectId:string):Promise<Response>};
  /** Explicit local runner injection. Does not change the Docker runner's guarantees. */
  runnerFactory?: (collector:CollectorTransport)=>RunnerService;
  attentionEnabled?: boolean;
  /** Server-configured owner tokens; at least one is required to log in. */
  ownerTokens: OwnerToken[];
  runtime?: RuntimeBinding;
  /** Project seeds used when no persisted state exists. */
  seedProjects?: { id: string; goal?: string }[];
  /** Durable per-project state directory; absent means memory-only. */
  stateDir?: string;
  /** Browser session duration: 8 hours by default, up to the approved 30 days. */
  sessionTtlSeconds?: number;
  gitRepo?: string;
  /** Set (e.g. to a fake docker path in tests) to wire the runner. */
  dockerBin?: string;
  snapshotDir?: string;
  snapshotProvider?: SnapshotRunnerOptions['snapshotProvider'];
  workspaceDir?: string;
  gitProjectId?: string;
  /** Optional default command for the explicitly configured local check runner. */
  defaultCheckCommand?: string;
  allowedOrigins?: string[];
  now?: () => string;
  uid?: () => string;
}

interface ProjectRuntime {
  store: Store;
  app: { fetch(request: Request): Promise<Response> };
}

function seedState(projectId: string, goal: string, ownerId: string, now: string): ProjectState {
  const state = createState({ id: projectId, goal, mode: 'live', actorId: ownerId });
  state.identities[ownerId] = {
    id: ownerId, projectId, revision: 1, createdAt: now, updatedAt: now,
    actorId: ownerId, displayName: 'Local owner', ownerId,
    creationSource: 'owner', status: 'active',
  };
  state.members[`mem-${ownerId}`] = {
    id: `mem-${ownerId}`, projectId, revision: 1, createdAt: now, updatedAt: now,
    actorId: ownerId, identityId: ownerId, kind: 'core',
    scopes: ['owner', 'admin', 'read'],
  };
  return state;
}

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

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' || url.hostname.endsWith('.localhost'))
    );
  } catch {
    return false;
  }
}

/**
 * Cross-site write gate for the local server. A missing Origin (non-browser
 * clients such as the CLI) is allowed; a present Origin must be a loopback
 * origin. Sec-Fetch-Site: cross-site is refused outright. Combined with
 * SameSite=Strict cookies this keeps browser-driven cross-site writes out.
 */
export function assertWriteOrigin(request: Request, allowedOrigins: string[] = []): void {
  if (!MUTATING.has(request.method.toUpperCase())) return;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite.toLowerCase() === 'cross-site') {
    fail(403, 'origin_denied', 'cross-site requests are not accepted');
  }
  const origin = request.headers.get('origin');
  if (origin !== null && !isLoopbackOrigin(origin) && !allowedOrigins.includes(origin)) {
    fail(403, 'origin_denied', `origin ${origin} is not a loopback origin`);
  }
}

export interface LocalApi {
  fetch(request: Request): Promise<Response>;
  /** Test/bootstrap seam: the live Store behind a hosted project id. */
  storeFor(projectId: string): Store | undefined;
  projectIds(): string[];
  /** Release the separate local browser-session database on server shutdown. */
  close(): void;
}

export function createLocalApi(opts: LocalApiOptions): LocalApi {
  const now = opts.now ?? (() => new Date().toISOString());
  const uid = opts.uid ?? (() => randomUUID());
  const ownerTokens = opts.ownerTokens;
  const sessionTtlSeconds = localSessionTtlSeconds(opts.sessionTtlSeconds);
  const projects = new Map<string, ProjectRuntime>();
  const conversationClosers:Array<()=>void>=[];
  let projectCreateTail: Promise<unknown> = Promise.resolve();
  const sessions = new LocalSessionStore(opts.stateDir === undefined ? undefined : join(opts.stateDir, 'owner-sessions.sqlite'));

  const makeStore = (state: ProjectState): Store =>
    opts.stateDir !== undefined
      ? new JsonFileStore(join(opts.stateDir, stateFileName(state.project.id)), () => state)
      : new MemoryStore(state);

  // The completion channel handed to the trusted runner: it loops the
  // job-scoped collector token through the project's real app (real
  // collector auth + completion route) -- never a requester response.
  const collector: CollectorTransport = async (report) => {
    const runtime = projects.get(report.projectId);
    if (runtime === undefined) return;
    await runtime.app.fetch(
      new Request(
        `http://127.0.0.1/api/v1/projects/${encodeURIComponent(report.projectId)}` +
          `/collector/jobs/${encodeURIComponent(report.jobId)}/complete`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${report.collectorToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            operationId: report.operationId,
            outcome: report.outcome,
            candidateSha: report.candidateSha,
            command: report.command,
            ...(report.inputHash !== undefined ? { inputHash: report.inputHash } : {}),
            outputHash: report.outputHash,
            artifactRefs: [],
          }),
        },
      ),
    );
  };

  const git: GitService | undefined =
    typeof opts.gitRepo === 'string' && opts.gitRepo !== ''
      ? createLocalGitService({ repo: opts.gitRepo })
      : undefined;
  const runner: RunnerService | undefined =
    opts.runnerFactory ? opts.runnerFactory(collector) : typeof opts.dockerBin === 'string' && opts.dockerBin !== ''
      ? createSnapshotRunner({
          dockerBin: opts.dockerBin,
          ...(opts.snapshotDir !== undefined ? { defaultSnapshotDir: opts.snapshotDir } : {}),
          collector,
          ...(opts.gitRepo ? { snapshotProvider: (sha: string) => materializeGitSnapshot(opts.gitRepo!, sha) } : opts.snapshotProvider ? { snapshotProvider: opts.snapshotProvider } : {}),
        })
      : undefined;

  const cookiePrincipal = (request: Request): Principal | null => {
    const token = parseCookies(request).get(SESSION_COOKIE);
    if (token === undefined) return null;
    const session = sessions.resolve(token, now());
    if (session === undefined) return null;
    if (!ownerTokens.some((owner) => owner.ownerId === session.ownerId)) {
      sessions.revoke(token); return null;
    }
    return {
      id: session.ownerId,
      sessionId: `local-session:${session.sessionId}`,
      kind: 'human',
      ownerId: session.ownerId,
      scopes: ['owner', 'admin', 'read'],
      projectIds: [...projects.keys()],
    };
  };

  const authenticateFor =
    (store: Store) =>
    async (request: Request): Promise<Principal | null> => {
      const state = await store.read();
      return (
        (await authenticate(request, state, { ownerTokens })) ??
        (await authenticateCollector(request, state)) ??
        cookiePrincipal(request)
      );
    };

  const addProject = (state: ProjectState): ProjectRuntime => {
    const ownsGit = Boolean(opts.gitRepo) && state.project.id === (opts.gitProjectId ?? opts.seedProjects?.[0]?.id ?? 'local-live-1');
    if (ownsGit && opts.gitRepo) state.project.repositories.local = { role:'canonical', repositoryId:'local', remote:pathToFileURL(resolve(opts.gitRepo)).href };
    if (ownsGit && opts.defaultCheckCommand) state.project.defaultCheckCommand = opts.defaultCheckCommand;
    const store = makeStore(state);
    const openedConversation = openConversationStore(opts.stateDir ? join(opts.stateDir, `conversation-${state.project.id}.sqlite`) : ":memory:");
    const conversation=openedConversation.store;conversationClosers.push(openedConversation.close);
    const runtime: ProjectRuntime = {
      store,
      app: createApp({
        store,
        authenticate: authenticateFor(store),
        handlers: PROJECT_HANDLERS, attentionEnabled:opts.attentionEnabled===true,
        conversation, runtime: opts.runtime,
        now,
        uid,
        ...(ownsGit && git !== undefined ? { git } : {}),
        ...((ownsGit || Boolean(opts.snapshotProvider)) && runner !== undefined ? { runner } : {}),
        ...(ownsGit && opts.gitRepo ? { artifacts:createLocalWorkspaceAdapter(resolve(opts.gitRepo), opts.workspaceDir ?? join(opts.stateDir ?? process.cwd(), "workspaces")) } : {}),
      }),
    };
    projects.set(state.project.id, runtime);
    return runtime;
  };

  const projectSummary = async (runtime: ProjectRuntime) => {
    const { id, goal, mode, canonicalRef, revision } = (await runtime.store.read()).project;
    return { id, goal, mode, canonicalRef, revision };
  };

  const requireOwner = (principal: Principal): void => {
    if (!principal.scopes.includes('owner') && !principal.scopes.includes('admin')) {
      fail(403, 'scope_denied', 'project bootstrap is owner-only');
    }
  };

  /** Any hosted store works for owner-token/cookie auth and collector auth
   * is project-bound; root routes only ever exercise owner principals. */
  const fallbackStore = (): Store => {
    const first = projects.values().next().value as ProjectRuntime | undefined;
    if (first === undefined) fail(503, 'unavailable', 'no projects hosted');
    return first.store;
  };

  async function handleSession(request: Request, parts: string[]): Promise<Response> {
    if (parts.length !== 3) fail(404, 'not_found', 'unknown route');
    const method = request.method.toUpperCase();
    // The API can sit behind the explicitly allowed private HTTPS preview.
    // Origin has already passed assertWriteOrigin; do not trust proxy headers.
    const secureCookie = new URL(request.url).protocol === 'https:' || (request.headers.get('origin') ?? '').startsWith('https://') ? '; Secure' : '';
    if (method === 'POST') {
      // Login: a valid owner bearer token mints an HttpOnly session cookie.
      // Agent/enrollment credentials cannot mint owner browser sessions.
      const principal = await authenticate(request, await fallbackStore().read(), {
        ownerTokens,
      });
      if (principal === null || !principal.scopes.includes('owner')) {
        fail(401, 'unauthenticated', 'a valid owner token is required');
      }
      const token = `sess_${randomUUID().replace(/-/g, '')}`;
      const session = sessions.create(token, principal.ownerId, now(), sessionTtlSeconds);
      const response = json(201, {
        session: { ownerId: principal.ownerId, principal: principal.id, expiresAt: session.expiresAt },
      });
      response.headers.set(
        'set-cookie',
        `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${sessionTtlSeconds}${secureCookie}`,
      );
      return response;
    }
    if (method === 'DELETE') {
      const token = parseCookies(request).get(SESSION_COOKIE);
      if (token !== undefined) sessions.revoke(token);
      const response = json(200, { ended: true });
      response.headers.set(
        'set-cookie',
        `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${secureCookie}`,
      );
      return response;
    }
    if (method === 'GET') {
      const principal =
        (await authenticate(request, await fallbackStore().read(), { ownerTokens })) ??
        (await authenticateCollector(request, await fallbackStore().read())) ??
        cookiePrincipal(request);
      if (principal === null) {
        fail(401, 'unauthenticated', 'authentication required');
      }
      return json(200, {
        authenticated: true,
        principal: {
          id: principal.id,
          kind: principal.kind,
          scopes: principal.scopes,
          projectIds: principal.projectIds,
        },
      });
    }
    fail(405, 'method_not_allowed', 'session supports GET, POST and DELETE');
  }

  async function handleProjects(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    const principal = await authenticateFor(fallbackStore())(request);
    if (principal === null) fail(401, 'unauthenticated', 'authentication required');
    requireOwner(principal);
    if (method === 'GET') {
      const list = await Promise.all([...projects.values()].map(projectSummary));
      return json(200, { projects: list });
    }
    if (method === 'POST') {
      const body = await readJsonBody(request);
      const operationId = typeof body.operationId === 'string' && body.operationId ? body.operationId : undefined;
      const digest = operationId ? await digestOf({ scope:'projects:create', ownerId:principal.ownerId, body:createEnvelope(body) }) : undefined;
      // Persist bootstrap idempotency with the project, including across restart.
      if (operationId) for (const runtime of projects.values()) {
        const creation = (await runtime.store.read()).project.bootstrapOperation as {id:string; digest:string; ownerId:string; result:unknown} | undefined;
        if (creation?.id !== operationId || creation.ownerId !== principal.ownerId) continue;
        if (creation.digest !== digest) fail(409, 'conflicting_operation', 'operationId already used with another payload');
        return json(201, creation.result);
      }
      assertCreationRevision(body);
      const goal = requireProse(body.goal, 'goal').trim();
      if (goal === '') fail(422, 'invalid_field', '"goal" must be non-empty');
      const requestedId = typeof body.id === 'string' ? body.id : undefined;
      if (requestedId !== undefined && !PROJECT_ID_PATTERN.test(requestedId)) {
        fail(422, 'invalid_field', 'id must start alphanumeric and use [a-zA-Z0-9_.-]');
      }
      const id = requestedId ?? `proj-${uid().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 24)}`;
      if (projects.has(id)) fail(409, 'project_exists', `project ${id} already exists`);
      const state = seedState(id, goal, principal.ownerId, now());
      const result = { project: { id:state.project.id, goal:state.project.goal, mode:state.project.mode, canonicalRef:state.project.canonicalRef, revision:state.project.revision } };
      if (operationId) state.project.bootstrapOperation = { id:operationId, digest, ownerId:principal.ownerId, result };
      addProject(state);
      return json(201, result);
    }
    fail(405, 'method_not_allowed', 'projects supports GET and POST');
  }

  async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v1') {
        return json(404, {
          error: { status: 404, code: 'not_found', message: 'not an API route', retryable: false },
        });
      }
      assertWriteOrigin(request, opts.allowedOrigins);
      if (parts[2] === 'session') return await handleSession(request, parts);
      if (parts[2] === 'projects' && parts.length === 3) {
        if (request.method === 'POST') {
          const creation = projectCreateTail.then(() => handleProjects(request));
          projectCreateTail = creation.catch(() => undefined);
          return await creation;
        }
        return await handleProjects(request);
      }
      if (request.method === 'GET' && parts[2] === 'inbox' && parts.length === 3) {
        const requested = url.searchParams.get('projectId');
        const allowed: { id: string; runtime: ProjectRuntime; principal: Principal }[] = [];
        for (const [id, runtime] of projects) {
          if (requested && id !== requested) continue;
          const principal = await authenticateFor(runtime.store)(request);
          if (principal && principal.projectIds.includes(id)) allowed.push({ id, runtime, principal });
        }
        if (!allowed.length) fail(401, 'unauthenticated', 'authentication required');
        return await handleMultiProjectInbox(allowed.map(({runtime, principal}) => ({ principal, store: runtime.store, now, uid })), request);
      }
      if (parts[2] !== 'projects' || parts.length < 4) {
        fail(404, 'not_found', 'unknown route');
      }
      const projectId = decodeURIComponent(parts[3]);
      const runtime = projects.get(projectId);
      if (runtime === undefined) {
        // Authenticate before 404 so unauthenticated scans learn nothing.
        const principal = await authenticateFor(fallbackStore())(request);
        if (principal === null) fail(401, 'unauthenticated', 'authentication required');
        fail(404, 'not_found', 'unknown or inaccessible project');
      }
      if(parts[4]==='nemo'){
        const principal=await authenticateFor(runtime.store)(request);
        if(!principal)fail(401,'unauthenticated','Owner login required');requireOwner(principal);
        if(!opts.localAgent)fail(404,'not_available','No local agent is configured');
        return await opts.localAgent.fetch(request,projectId);
      }
      return await runtime.app.fetch(request);
    } catch (err) {
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
  }

  // -- bootstrap hosted projects ------------------------------------------
  const restored = new Set<string>();
  if (opts.stateDir !== undefined) {
    let files: string[] = [];
    try {
      files = readdirSync(opts.stateDir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    for (const file of files) {
      const state = readPersistedState(join(opts.stateDir, file));
      if (state !== undefined && !projects.has(state.project.id)) {
        addProject(state);
        restored.add(state.project.id);
      }
    }
  }
  const ownerId = ownerTokens[0]?.ownerId ?? 'steve';
  for (const seed of opts.seedProjects ?? [{ id: 'local-live-1' }]) {
    if (!projects.has(seed.id)) {
      addProject(seedState(seed.id, seed.goal ?? 'Local Together workspace', ownerId, now()));
    }
  }

  return {
    fetch,
    storeFor: (projectId) => projects.get(projectId)?.store,
    projectIds: () => [...projects.keys()],
    close: () => {sessions.close();for(const close of conversationClosers)close();},
  };
}

export interface LocalServerOptions extends LocalApiOptions {
  port?: number;
}

/** Bind the composed API to 127.0.0.1 only: it holds owner authority. */
export function startLocalServer(opts: LocalServerOptions): {
  server: Server;
  api: LocalApi;
  listening: Promise<number>;
} {
  const api = createLocalApi(opts);
  const port = opts.port ?? 8937;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
      }
      const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        body:
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : Buffer.concat(chunks),
      });
      api.fetch(request).then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      }, (err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: { status: 500, code: 'internal_error', message: String(err), retryable: false },
        }));
      });
    });
  });
  server.once('close', () => api.close());
  const listening = new Promise<number>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
  return { server, api, listening };
}

const isMain = (() => {
  const entry = process.argv[1];
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href;
})();

if (isMain) {
  if (!process.env.TOGETHER_OWNER_TOKEN) throw new Error('Set TOGETHER_OWNER_TOKEN before starting the local API');
  const OWNER_TOKEN =
    process.env.TOGETHER_OWNER_TOKEN ?? `owner_${randomUUID().replace(/-/g, '')}`;
  const OWNER_ID = process.env.TOGETHER_OWNER_ID ?? 'steve';
  const PROJECT_ID = process.env.TOGETHER_PROJECT_ID ?? 'local-live-1';
  const PORT = Number(process.env.PORT ?? 8937);

  const { listening } = startLocalServer({
    ownerTokens: [{ ownerId: OWNER_ID, token: OWNER_TOKEN }],
    seedProjects: [{ id: PROJECT_ID, goal: 'Local Together workspace' }],
    ...(process.env.TOGETHER_STATE_DIR !== undefined
      ? { stateDir: process.env.TOGETHER_STATE_DIR }
      : {}),
    ...(process.env.TOGETHER_GIT_REPO !== undefined && process.env.TOGETHER_GIT_REPO !== ''
      ? { gitRepo: process.env.TOGETHER_GIT_REPO }
      : {}),
    ...(process.env.TOGETHER_RUNNER === 'docker'
      ? { dockerBin: process.env.TOGETHER_DOCKER_BIN ?? 'docker' }
      : {}),
    snapshotDir: process.env.TOGETHER_SNAPSHOT_DIR,
    allowedOrigins: (process.env.TOGETHER_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    port: PORT,
  });

  void listening.then((port) => {
    // eslint-disable-next-line no-console
    console.log(
      `together local api: http://127.0.0.1:${port}/api/v1` +
        ` (owner authentication configured; use POST /api/v1/session to sign in)`,
    );
  });
}
