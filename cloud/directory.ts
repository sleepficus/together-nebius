// Root directory Durable Object + public edge handler (seat c-swe-01).
//
// One SQLite-backed DirectoryObject owns the durable root project
// directory: owner-scoped project records, idempotent create operations
// and the hashed agent-credential discovery index. All state lives behind
// the CloudStorage contract (get/put/list/transaction); nothing authorizes
// from memory, so records survive object recreation.
//
// Public surface (edge): directoryFetch owns exactly
//   GET  /api/v1/projects   owner-scoped listing
//   POST /api/v1/projects   idempotent create
// and forwards to the object over the DIRECTORY_OBJECT binding. Internal
// object routes under /internal/v1/directory/* back the module helpers
// projectRecord/ownerProjects/credentialProjects/indexCredential. They are
// reachable only through the binding and must never be exposed on the
// public router (spec: no wildcard forwarding to internal paths). Every
// internal call carries x-together-internal: directory; the public edge
// must strip that header from inbound requests.
//
// Create order (spec item 1) is fixed:
//   1. The operation + reserved project record commit in one transaction
//      BEFORE any repository effect. Same operationId + same canonical
//      payload digest replays the stored result; same id + different
//      digest is 409 -- reconciled before any staleness concern, and
//      competing duplicate creates converge on the single reservation.
//   2. Only a fresh prefixed disposable Artifacts repository is created
//      (<prefix><projectId>, default branch together-cloud). The name is
//      deterministic, so a lost create acknowledgment -- or a competing
//      duplicate create -- is recovered through real binding metadata via
//      get()/info(), never reported failed merely because the reply was
//      dropped and never duplicated. No writes to template/production/
//      main: the canonical ref is always the disposable configured ref.
//   3. Once repository metadata is real, the per-project store is
//      initialized over the trusted PROJECT_OBJECT binding route
//      documented below; matching replay (200) is idempotent success.
//   4. Only then does the directory result commit. Repository plaintext
//      capabilities are dropped immediately -- never persisted in
//      records, operations or responses.
//
// Trusted PROJECT_OBJECT seam used by step 3 -- implemented on the
// ProjectObject binding by lane09, binding-only, never public:
//   POST /internal/v1/projects/:id/init      stub id = idFromName(projectId)
//   header x-together-internal-init: directory-object
//   body   { projectId, goal, ownerId, repositoryId, remote,
//            canonicalRef, operationId, digest }
//   2xx = initialized or matching replay; 409 = conflicting provenance;
//   anything else leaves the directory operation retryable.

import {
  ApiError, assertCreationRevision, createEnvelope, digestOf,
  errorResponse, fail, json, readJsonBody, requireProse,
} from '../lib/core.ts';
import { createArtifactsAdapter } from '../lib/artifacts.ts';
import type { ArtifactRepoMetadata } from '../lib/artifacts.ts';
import type { IsoTime } from '../lib/types.ts';
import type {
  CloudEnv, CloudObjectState, CloudOwner, CloudStub,
  DirectoryProjectRecord,
} from './phase04-contract.ts';

/** Single root object name -- one SQLite-backed directory per deployment. */
export const DIRECTORY_OBJECT_NAME = 'together-directory';
/** Binding-internal route prefix served only by the object. */
export const DIRECTORY_INTERNAL_PREFIX = '/internal/v1/directory';
/**
 * Trusted per-project store initialization route -- implemented on the
 * ProjectObject binding by lane09; binding-only, never public.
 */
export const PROJECT_INIT_PATH = '/internal/v1/projects';
/** Header marking trusted binding-internal calls; the public edge strips it. */
export const INTERNAL_REQUEST_HEADER = 'x-together-internal-init';
export const INTERNAL_REQUEST_VALUE = 'directory-object';
const INTERNAL_ORIGIN = 'https://directory.internal';
const DEFAULT_REPO_PREFIX = 'together-cloud-';
const DEFAULT_BRANCH = 'together-cloud';
const DEFAULT_CANONICAL_REF = 'refs/heads/together-cloud';
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
/** Credential indexes are keyed by hash only -- hex digests, never plaintext. */
const CREDENTIAL_DIGEST_PATTERN = /^[0-9a-f]{32,128}$/i;
const MAX_INDEX_PROJECT_IDS = 256;

/** Optional dependencies injectable for tests and composition. */
export interface SourceProvisionContext {
  env: CloudEnv;
  /** Record with the real repositoryId/remote that was just provisioned. */
  record: DirectoryProjectRecord;
  ownerId: string;
}
/**
 * Optional initial-source seeding hook. Runs after repository metadata is
 * real and the per-project store is initialized, before the directory
 * result commits. Its outcome is reported honestly in the create result;
 * it is never required for the record to report real readiness.
 */
export type SourceProvisioner = (
  ctx: SourceProvisionContext,
) => Promise<{ seeded: boolean; detail?: string } | void>;

export interface DirectoryDeps {
  now?: () => IsoTime;
  uid?: () => string;
  provisionSource?: SourceProvisioner;
}

interface DirectoryOperation {
  operationId: string;
  ownerId: string;
  digest: string;
  projectId: string;
  status: 'pending' | 'completed' | 'failed';
  result?: { status: number; body: unknown };
  error?: { status: number; code: string; message: string };
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

const opKey = (ownerId: string, operationId: string): string =>
  `op/${ownerId}/${operationId}`;
const projectKey = (projectId: string): string => `project/${projectId}`;
const ownerIndexKey = (ownerId: string, projectId: string): string =>
  `idx/owner/${ownerId}/${projectId}`;
const ownerIndexPrefix = (ownerId: string): string => `idx/owner/${ownerId}/`;
const credIndexKey = (digest: string, projectId: string): string =>
  `idx/cred/${digest}/${projectId}`;
const credIndexPrefix = (digest: string): string => `idx/cred/${digest}/`;

function requireBoundedString(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(422, 'invalid_field', `"${field}" must be a string of 1..${max} characters`);
  }
  return value;
}

function requireProjectId(value: unknown, field = 'projectId'): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    fail(422, 'invalid_field', `${field} must start alphanumeric and use [a-zA-Z0-9_.-]`);
  }
  return value;
}

function requireCredentialDigest(value: unknown): string {
  if (typeof value !== 'string' || !CREDENTIAL_DIGEST_PATTERN.test(value)) {
    fail(422, 'invalid_field', 'credential digest must be a hex hash (32..128 chars); plaintext is never indexed');
  }
  return value;
}

function directoryError(err: unknown): Response {
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

/** Public record view -- no operation digest or other reconciliation internals. */
function publicRecord(record: DirectoryProjectRecord): Record<string, unknown> {
  return {
    id: record.id,
    ownerId: record.ownerId,
    goal: record.goal,
    mode: 'live',
    canonicalRef: record.canonicalRef,
    provisioning: record.provisioning,
    repositoryId: record.repositoryId,
    remote: record.remote,
    createdAt: record.createdAt,
  };
}

interface RepoMeta {
  repositoryId: string;
  remote: string;
  ready: boolean;
  pendingReason?: string;
}

export class DirectoryObject {
  private readonly storage: CloudObjectState['storage'];
  private readonly env: CloudEnv;
  private readonly deps: DirectoryDeps;
  /** In-flight provisioning shared by competing duplicate creates. */
  private readonly inflight = new Map<string, Promise<Response>>();

  constructor(state: CloudObjectState, env: CloudEnv, deps: DirectoryDeps = {}) {
    this.storage = state.storage;
    this.env = env;
    this.deps = deps;
  }

  private now(): IsoTime {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private uid(): string {
    return this.deps.uid?.() ?? crypto.randomUUID();
  }

  private repoPrefix(): string {
    const prefix = this.env.TEST_REPO_PREFIX;
    return typeof prefix === 'string' && prefix !== '' ? prefix : DEFAULT_REPO_PREFIX;
  }

  private canonicalRef(): string {
    const ref = this.env.TEST_CANONICAL_REF;
    return typeof ref === 'string' && ref !== '' ? ref : DEFAULT_CANONICAL_REF;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const parts = new URL(request.url).pathname.split('/').filter(Boolean);
      const internal = request.headers.get(INTERNAL_REQUEST_HEADER) === INTERNAL_REQUEST_VALUE;
      if (parts[0] !== 'internal' || parts[1] !== 'v1' || parts[2] !== 'directory' || !internal) {
        return json(404, {
          error: { status: 404, code: 'not_found', message: 'not a directory route', retryable: false },
        });
      }
      const rest = parts.slice(3).map((p) => decodeURIComponent(p));
      if (request.method === 'GET' && rest.length === 2 && rest[0] === 'project') {
        return await this.getProject(rest[1]);
      }
      if (request.method === 'GET' && rest.length === 3 && rest[0] === 'owner' && rest[2] === 'projects') {
        return await this.getOwnerProjects(rest[1]);
      }
      if (request.method === 'GET' && rest.length === 3 && rest[0] === 'credential' && rest[2] === 'projects') {
        return await this.getCredentialProjects(rest[1]);
      }
      if (request.method === 'POST' && rest.length === 2 && rest[0] === 'credential' && rest[1] === 'index') {
        return await this.postCredentialIndex(request);
      }
      if (request.method === 'POST' && rest.length === 1 && rest[0] === 'projects') {
        return await this.postProject(request);
      }
      return json(404, {
        error: { status: 404, code: 'not_found', message: 'unknown directory route', retryable: false },
      });
    } catch (err) {
      return directoryError(err);
    }
  }

  private async getProject(projectId: string): Promise<Response> {
    requireProjectId(projectId);
    const record = await this.storage.get<DirectoryProjectRecord>(projectKey(projectId));
    if (record === undefined) {
      return json(404, {
        error: { status: 404, code: 'not_found', message: 'unknown project', retryable: false },
      });
    }
    return json(200, { record });
  }

  private async getOwnerProjects(ownerId: string): Promise<Response> {
    requireBoundedString(ownerId, 'ownerId');
    const index = await this.storage.list<IsoTime>({ prefix: ownerIndexPrefix(ownerId) });
    const prefix = ownerIndexPrefix(ownerId);
    const records: DirectoryProjectRecord[] = [];
    for (const key of index.keys()) {
      const record = await this.storage.get<DirectoryProjectRecord>(
        projectKey(key.slice(prefix.length)),
      );
      if (record !== undefined) records.push(record);
    }
    records.sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt));
    return json(200, { records });
  }

  private async getCredentialProjects(digest: string): Promise<Response> {
    requireCredentialDigest(digest);
    const index = await this.storage.list<unknown>({ prefix: credIndexPrefix(digest) });
    const prefix = credIndexPrefix(digest);
    const projectIds = [...index.keys()].map((k) => k.slice(prefix.length)).sort();
    return json(200, { projectIds });
  }

  private async postCredentialIndex(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const digest = requireCredentialDigest(body.digest);
    const ids = body.projectIds;
    if (!Array.isArray(ids) || ids.length > MAX_INDEX_PROJECT_IDS) {
      fail(422, 'invalid_field', `projectIds must be an array of at most ${MAX_INDEX_PROJECT_IDS} ids`);
    }
    const projectIds = ids.map((id) => requireProjectId(id, 'projectIds[]'));
    await this.storage.transaction(async (tx) => {
      for (const projectId of projectIds) {
        await tx.put(credIndexKey(digest, projectId), '1');
      }
    });
    return json(200, { indexed: projectIds.length });
  }

  /**
   * Idempotent create: reserve in one transaction, then provision outside
   * it (no remote effects inside a transaction). Replays with the same
   * operationId + payload digest return the stored result; a prior
   * interrupted attempt is reconciled against real metadata, never
   * reported failed just because its acknowledgment was lost.
   */
  private async postProject(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const ownerId = requireBoundedString(body.ownerId, 'ownerId');
    const operationId = requireBoundedString(body.operationId, 'operationId');
    const digest = await digestOf({ scope: 'projects:create', ownerId, body: createEnvelope(body) });
    const key = opKey(ownerId, operationId);

    const op = await this.storage.transaction(async (tx): Promise<DirectoryOperation> => {
      const existing = await tx.get<DirectoryOperation>(key);
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          fail(409, 'conflicting_operation', 'operationId reused with a different payload', {
            nextAction: 'use a new operationId',
          });
        }
        return existing;
      }
      // Fresh create -- validate the canonical payload before reserving.
      assertCreationRevision(body);
      const goal = requireProse(body.goal, 'goal').trim();
      if (goal === '') fail(422, 'invalid_field', '"goal" must be non-empty');
      const requestedId = body.id === undefined ? undefined : requireProjectId(body.id, 'id');
      const projectId = requestedId ?? `proj-${this.uid().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 24)}`;
      if (requestedId !== undefined && (await tx.get(projectKey(projectId))) !== undefined) {
        fail(409, 'project_exists', `project ${projectId} already exists`);
      }
      const createdAt = this.now();
      const record: DirectoryProjectRecord = {
        id: projectId,
        ownerId,
        goal,
        createdAt,
        repositoryId: '',
        remote: '',
        canonicalRef: this.canonicalRef(),
        provisioning: 'pending',
        operationId,
        digest,
      };
      const created: DirectoryOperation = {
        operationId,
        ownerId,
        digest,
        projectId,
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      };
      await tx.put(projectKey(projectId), record);
      await tx.put(ownerIndexKey(ownerId, projectId), createdAt);
      await tx.put(key, created);
      return created;
    });

    if (op.status === 'completed' && op.result !== undefined) {
      return json(op.result.status, op.result.body);
    }
    // Competing duplicate creates converge on the one provisioning task.
    let task = this.inflight.get(key);
    if (task === undefined) {
      task = this.runProvisioning(ownerId, operationId)
        .finally(() => { this.inflight.delete(key); });
      this.inflight.set(key, task);
    }
    return task;
  }

  private async runProvisioning(ownerId: string, operationId: string): Promise<Response> {
    const op = await this.storage.get<DirectoryOperation>(opKey(ownerId, operationId));
    if (op === undefined) {
      fail(500, 'directory_inconsistent', 'operation record missing during provisioning');
    }
    const record = await this.storage.get<DirectoryProjectRecord>(projectKey(op.projectId));
    if (record === undefined) {
      fail(500, 'directory_inconsistent', 'project record missing for reserved operation');
    }
    let repo: { repositoryId: string; remote: string } | undefined;
    try {
      const meta = await this.ensureRepository(record);
      repo = { repositoryId: meta.repositoryId, remote: meta.remote };
      // Repository metadata is real here; the per-project store follows it.
      await this.initializeProjectStore(record, meta);
      let seeded = false;
      let seedError: string | undefined;
      if (meta.ready && this.deps.provisionSource !== undefined) {
        try {
          const outcome = await this.deps.provisionSource({
            env: this.env,
            record: { ...record, repositoryId: meta.repositoryId, remote: meta.remote },
            ownerId,
          });
          seeded = typeof outcome === 'object' && outcome !== null && outcome.seeded === true;
        } catch (err) {
          seedError = err instanceof Error ? err.message : 'source provisioning failed';
        }
      }
      const final = await this.commitOutcome(op, {
        repositoryId: meta.repositoryId,
        remote: meta.remote,
        ready: meta.ready,
        seeded,
        seedError,
      });
      if (final.op.status === 'completed' && final.op.result !== undefined) {
        return json(final.op.result.status, final.op.result.body);
      }
      return json(202, {
        project: publicRecord(final.record),
        status: 'provisioning',
        ...(meta.pendingReason !== undefined ? { pendingReason: meta.pendingReason } : {}),
        nextAction: 'retry this request with the same operationId once the repository reports ready',
      });
    } catch (err) {
      const apiErr = err instanceof ApiError
        ? err
        : new ApiError(503, 'provisioning_failed', 'project provisioning failed', { retryable: true });
      await this.commitFailure(op, apiErr, repo).catch(() => undefined);
      throw apiErr;
    }
  }

  /**
   * Create the deterministic disposable repository for a record, or
   * recover it. A failed create is reconciled through real metadata via
   * info() before being reported -- an acknowledgment lost after a
   * successful create (or a competing duplicate create) converges on the
   * repository that actually exists.
   */
  private async createOrRecover(
    adapter: ReturnType<typeof createArtifactsAdapter>,
    repoName: string,
    projectId: string,
  ): Promise<ArtifactRepoMetadata> {
    try {
      const created = await adapter.createRepository(repoName, {
        setDefaultBranch: DEFAULT_BRANCH,
        description: `disposable repository for ${projectId}`,
      });
      // created.token (if any) is dropped here: plaintext capabilities are
      // never persisted in records, operations or responses.
      return created.repo;
    } catch (createErr) {
      try {
        return await adapter.info();
      } catch {
        throw createErr;
      }
    }
  }

  private async ensureRepository(record: DirectoryProjectRecord): Promise<RepoMeta> {
    const ns = this.env.ARTIFACTS;
    if (ns === undefined || typeof ns.get !== 'function') {
      fail(503, 'artifacts_not_ready', 'artifacts binding is not configured', {
        nextAction: 'configure the ARTIFACTS binding and retry with the same operationId',
      });
    }
    const repoName = `${this.repoPrefix()}${record.id}`;
    const adapter = createArtifactsAdapter({ namespace: ns, repo: repoName });
    try {
      let meta: ArtifactRepoMetadata;
      if (record.repositoryId === '') {
        meta = await this.createOrRecover(adapter, repoName, record.id);
      } else {
        try {
          // A prior reservation recorded a repository -- verify the actual
          // metadata instead of trusting the stored claim.
          meta = await adapter.info();
        } catch (err) {
          // Only a confirmed-missing repository is recreated under the same
          // deterministic disposable name; other failures stay honest.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
          meta = await this.createOrRecover(adapter, repoName, record.id);
        }
      }
      const repositoryId = meta.id !== '' ? meta.id : meta.name !== '' ? meta.name : repoName;
      return {
        repositoryId,
        remote: meta.remote,
        ready: meta.ready === true,
        ...(meta.ready === true ? {} : { pendingReason: `repository status "${meta.status}"` }),
      };
    } finally {
      adapter[Symbol.dispose]();
    }
  }

  /**
   * Initialize the per-project store over the trusted PROJECT_OBJECT
   * binding route (see the module header; lane09 implements the object
   * side). Only 2xx initialized/matching replay is success; anything else
   * leaves the operation retryable.
   */
  private async initializeProjectStore(
    record: DirectoryProjectRecord,
    meta: RepoMeta,
  ): Promise<void> {
    const ns = this.env.PROJECT_OBJECT;
    if (ns === undefined || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function') {
      fail(503, 'project_store_unavailable', 'PROJECT_OBJECT binding is not configured', {
        nextAction: 'configure the binding and retry with the same operationId',
      });
    }
    const stub = ns.get(ns.idFromName(record.id));
    let res: Response;
    try {
      res = await stub.fetch(new Request(`${INTERNAL_ORIGIN}${PROJECT_INIT_PATH}/${encodeURIComponent(record.id)}/init`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_REQUEST_HEADER]: INTERNAL_REQUEST_VALUE,
        },
        body: JSON.stringify({
          projectId: record.id,
          goal: record.goal,
          ownerId: record.ownerId,
          repositoryId: meta.repositoryId,
          remote: meta.remote,
          canonicalRef: record.canonicalRef,
          operationId: record.operationId,
          digest: record.digest,
        }),
      }));
    } catch {
      fail(503, 'project_store_unavailable', 'project object fetch failed', { retryable: true });
    }
    if (!res.ok) {
      fail(503, 'project_init_failed', `project store initialization returned ${res.status}`, {
        retryable: true,
      });
    }
  }

  private async commitOutcome(
    op: DirectoryOperation,
    outcome: {
      repositoryId: string;
      remote: string;
      ready: boolean;
      seeded: boolean;
      seedError?: string;
    },
  ): Promise<{ op: DirectoryOperation; record: DirectoryProjectRecord }> {
    return this.storage.transaction(async (tx) => {
      const curOp = await tx.get<DirectoryOperation>(opKey(op.ownerId, op.operationId));
      const curRec = await tx.get<DirectoryProjectRecord>(projectKey(op.projectId));
      if (curOp === undefined || curRec === undefined) {
        fail(500, 'directory_inconsistent', 'reservation lost during commit');
      }
      // A competing reconcile may have committed first -- converge on it.
      if (curOp.status === 'completed' && curOp.result !== undefined) {
        return { op: curOp, record: curRec };
      }
      if (outcome.repositoryId !== '') {
        curRec.repositoryId = outcome.repositoryId;
        curRec.remote = outcome.remote;
      }
      curRec.provisioning = outcome.ready ? 'ready' : 'pending';
      // A pending outcome also clears a stale 'failed' attempt marker/error.
      curOp.status = outcome.ready ? 'completed' : 'pending';
      delete curOp.error;
      if (outcome.ready) {
        curOp.result = {
          status: 201,
          body: {
            project: publicRecord(curRec),
            seeded: outcome.seeded,
            ...(outcome.seedError !== undefined ? { seedError: outcome.seedError } : {}),
          },
        };
      }
      curOp.updatedAt = this.now();
      await tx.put(projectKey(curRec.id), curRec);
      await tx.put(opKey(curOp.ownerId, curOp.operationId), curOp);
      return { op: curOp, record: curRec };
    });
  }

  private async commitFailure(
    op: DirectoryOperation,
    err: ApiError,
    repo?: { repositoryId: string; remote: string },
  ): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const curOp = await tx.get<DirectoryOperation>(opKey(op.ownerId, op.operationId));
      const curRec = await tx.get<DirectoryProjectRecord>(projectKey(op.projectId));
      if (curOp === undefined || curRec === undefined) return;
      if (curOp.status === 'completed') return; // a competing reconcile finished first
      if (repo !== undefined && repo.repositoryId !== '') {
        curRec.repositoryId = repo.repositoryId;
        curRec.remote = repo.remote;
      }
      curRec.provisioning = 'failed';
      curOp.status = 'failed';
      curOp.error = { status: err.status, code: err.code, message: err.message };
      curOp.updatedAt = this.now();
      await tx.put(projectKey(curRec.id), curRec);
      await tx.put(opKey(curOp.ownerId, curOp.operationId), curOp);
    });
  }
}

/**
 * Factory for wrangler-style `export class` wiring: deps live in module
 * scope because real env bindings cannot carry functions.
 */
export function createDirectoryObjectClass(deps: DirectoryDeps) {
  return class BoundDirectoryObject extends DirectoryObject {
    constructor(state: CloudObjectState, env: CloudEnv) {
      super(state, env, deps);
    }
  };
}

function directoryStub(env: CloudEnv): CloudStub {
  const ns = env.DIRECTORY_OBJECT;
  if (ns === undefined || typeof ns.get !== 'function' || typeof ns.idFromName !== 'function') {
    fail(503, 'directory_unavailable', 'DIRECTORY_OBJECT binding is not configured', {
      nextAction: 'configure the directory object binding and retry',
    });
  }
  return ns.get(ns.idFromName(DIRECTORY_OBJECT_NAME));
}

async function stubCall(env: CloudEnv, path: string, init?: RequestInit): Promise<Response> {
  const stub = directoryStub(env);
  try {
    return await stub.fetch(new Request(`${INTERNAL_ORIGIN}${path}`, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        [INTERNAL_REQUEST_HEADER]: INTERNAL_REQUEST_VALUE,
      },
    }));
  } catch {
    fail(503, 'directory_unavailable', 'directory object fetch failed', { retryable: true });
  }
}

async function assertStubOk(res: Response): Promise<void> {
  if (res.ok) return;
  let code = 'directory_error';
  let message = `directory request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Keep the sanitized defaults when the stub body is not an error shape.
  }
  fail(res.status, code, message, { retryable: res.status === 503 || res.status === 429 });
}

/**
 * Durable project record lookup. Returns null for unknown ids -- internal
 * callers re-check ownership against DirectoryProjectRecord.ownerId.
 */
export async function projectRecord(
  env: CloudEnv,
  projectId: string,
): Promise<DirectoryProjectRecord | null> {
  requireProjectId(projectId);
  const res = await stubCall(
    env,
    `${DIRECTORY_INTERNAL_PREFIX}/project/${encodeURIComponent(projectId)}`,
  );
  if (res.status === 404) return null;
  await assertStubOk(res);
  const body = (await res.json()) as { record?: DirectoryProjectRecord };
  return body.record ?? null;
}

/** Owner-scoped project listing, sorted by createdAt then id. */
export async function ownerProjects(
  env: CloudEnv,
  ownerId: string,
): Promise<DirectoryProjectRecord[]> {
  requireBoundedString(ownerId, 'ownerId');
  const res = await stubCall(
    env,
    `${DIRECTORY_INTERNAL_PREFIX}/owner/${encodeURIComponent(ownerId)}/projects`,
  );
  await assertStubOk(res);
  const body = (await res.json()) as { records?: DirectoryProjectRecord[] };
  return Array.isArray(body.records) ? body.records : [];
}

/**
 * Discovery-only lookup: hashed agent credential -> project ids. The index
 * never authorizes anything; authoritative project authentication is
 * rechecked on every read by the access lane.
 */
export async function credentialProjects(env: CloudEnv, digest: string): Promise<string[]> {
  requireCredentialDigest(digest);
  const res = await stubCall(
    env,
    `${DIRECTORY_INTERNAL_PREFIX}/credential/${encodeURIComponent(digest)}/projects`,
  );
  await assertStubOk(res);
  const body = (await res.json()) as { projectIds?: string[] };
  return Array.isArray(body.projectIds) ? body.projectIds : [];
}

/**
 * Index a newly issued agent credential by hash + project only -- never
 * plaintext. Merges into the existing set; stale entries are harmless
 * because the index is discovery-only and real auth is rechecked live.
 */
export async function indexCredential(
  env: CloudEnv,
  digest: string,
  projectIds: string[],
): Promise<void> {
  requireCredentialDigest(digest);
  if (!Array.isArray(projectIds) || projectIds.length > MAX_INDEX_PROJECT_IDS) {
    fail(422, 'invalid_field', `projectIds must be an array of at most ${MAX_INDEX_PROJECT_IDS} ids`);
  }
  const ids = projectIds.map((id) => requireProjectId(id, 'projectIds[]'));
  const res = await stubCall(env, `${DIRECTORY_INTERNAL_PREFIX}/credential/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ digest, projectIds: ids }),
  });
  await assertStubOk(res);
}

/**
 * Public edge handler for the durable root directory. Owns exactly
 * GET/POST /api/v1/projects; the caller (worker composition, lane09) must
 * have already resolved the owner -- a null owner is 401. The
 * caller-supplied body is forwarded with the authenticated ownerId
 * overwriting any ownerId field; the object re-validates authoritatively.
 */
export async function directoryFetch(
  request: Request,
  env: CloudEnv,
  owner: CloudOwner | null,
): Promise<Response> {
  try {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'projects') {
      return json(404, {
        error: { status: 404, code: 'not_found', message: 'not a directory route', retryable: false },
      });
    }
    if (owner === null || typeof owner.ownerId !== 'string' || owner.ownerId === '') {
      fail(401, 'unauthenticated', 'owner session required');
    }
    if (request.method === 'GET') {
      const records = await ownerProjects(env, owner.ownerId);
      return json(200, { projects: records.map(publicRecord) });
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const res = await stubCall(env, `${DIRECTORY_INTERNAL_PREFIX}/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, ownerId: owner.ownerId }),
      });
      return res;
    }
    return json(405, {
      error: { status: 405, code: 'method_not_allowed', message: 'projects supports GET and POST', retryable: false },
    });
  } catch (err) {
    return directoryError(err);
  }
}
