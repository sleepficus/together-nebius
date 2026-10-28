// Shared API core for the Together slice (seat b-swe-01).
// Freezes error shapes, per-entity revision/idempotency semantics, body
// limits and safe-view rules. Modules compose handleX(ctx, request,
// segments, body) over command(); they never bypass it for writes.

import type {
  CheckJob, CollectionName, CommandTarget, Context, Entity, Event,
  HumanCategory, Id, IsoTime, Message, Operation, Principal, Project,
  ProjectMode, ProjectState,
} from './types.ts';

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_PROSE_CHARS = 16 * 1024;
export const PAGE_LIMIT = 100;

/** Reserved scope that satisfies any requireScope check. */
export const ADMIN_SCOPE = 'admin';

/** Typed API error — the only error shape handlers should produce. */
export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  nextAction?: string;
  constructor(
    status: number,
    code: string,
    message: string,
    opts?: { retryable?: boolean; nextAction?: string },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = opts?.retryable ?? (status === 429 || status === 503);
    this.nextAction = opts?.nextAction;
  }
}

export function fail(
  status: number,
  code: string,
  message: string,
  opts?: { retryable?: boolean; nextAction?: string },
): never {
  throw new ApiError(status, code, message, opts);
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(err: ApiError): Response {
  return json(err.status, {
    error: {
      status: err.status,
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      ...(err.nextAction !== undefined ? { nextAction: err.nextAction } : {}),
    },
  });
}

export function createState(init: {
  id: Id;
  goal: string;
  mode: ProjectMode;
  actorId?: Id;
  now?: IsoTime;
  canonicalRef?: string;
}): ProjectState {
  const now = init.now ?? new Date().toISOString();
  const project: Project = {
    id: init.id,
    projectId: init.id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    actorId: init.actorId ?? 'system',
    goal: init.goal,
    mode: init.mode,
    canonicalRef: init.canonicalRef ?? 'refs/heads/main',
    acceptancePolicyRevision: 1,
    resourceLimits: {
      maxActiveWorkers: 3,
      maxActiveChecks: 1,
      checkTimeoutMs: 10 * 60 * 1000,
      maxSourceBytes: 32 * 1024 * 1024,
    },
    repositories: {},
  };
  return {
    project,
    members: {},
    sessions: {},
    identities: {},
    invitations: {},
    credentials: {},
    tasks: {},
    assignments: {},
    help: {},
    messages: {},
    handoffs: {},
    proposals: {},
    candidates: {},
    jobs: {},
    receipts: {},
    authorReports: {},
    reviews: {},
    findings: {},
    operations: {},
    planRevisions: {},
    runs: {},
    events: [],
    lateOutputs: [],
    stopped: false,
  };
}

/** Fetch a record or 404. Unknown and inaccessible share this shape. */
export function entity<T extends Entity = Entity>(
  state: ProjectState,
  collection: CollectionName,
  id: Id,
): T {
  const rec = (state[collection] as Record<Id, Entity>)[id];
  if (!rec) {
    fail(404, 'not_found', `${collection}/${id} does not exist`);
  }
  return rec as T;
}

/**
 * Scope check. Holding a scope never grants cross-project access: when
 * state is supplied the principal must list the project first (404 rather
 * than 403, so existence is not leaked). kind 'system' bypasses scope
 * checks for internal bookkeeping; 'admin' is the enumerated wildcard.
 */
export function requireScope(principal: Principal, scope: string, state?: ProjectState): void {
  if (state && !principal.projectIds.includes(state.project.id)) {
    fail(404, 'not_found', 'unknown or inaccessible project');
  }
  if (principal.kind === 'system') return;
  if (!principal.scopes.includes(scope) && !principal.scopes.includes(ADMIN_SCOPE)) {
    fail(403, 'scope_denied', `missing scope "${scope}"`, {
      nextAction: 'request the scope from a project owner',
    });
  }
}

/** Bump an entity revision — per-entity, never a global edit lock. */
export function touchEntity<T extends Entity>(
  rec: T,
  ctx: Pick<Context, 'now'>,
  actorId?: Id,
): T {
  rec.revision += 1;
  rec.updatedAt = ctx.now();
  if (actorId !== undefined) rec.actorId = actorId;
  return rec;
}

export function assertRevision(rec: Pick<Entity, 'revision'>, expected?: number): void {
  if (expected !== undefined && rec.revision !== expected) {
    fail(
      409,
      'stale_revision',
      `expected revision ${expected}, current revision ${rec.revision}`,
      { nextAction: 're-read the entity and retry with the current revision' },
    );
  }
}

export function appendEvent(
  state: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  type: string,
  entityId?: Id,
  detail?: unknown,
  humanCategory?: HumanCategory,
): Event {
  const last = state.events[state.events.length - 1];
  const ev: Event = {
    id: ctx.uid(),
    projectId: state.project.id,
    seq: (last?.seq ?? 0) + 1,
    createdAt: ctx.now(),
    actorId: ctx.principal.id,
    actorKind: ctx.principal.kind,
    type,
    entityId,
    detail,
    humanCategory,
  };
  state.events.push(ev);
  return ev;
}

/** Canonical JSON: object keys sorted recursively, array order preserved. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortDeep(item);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex of the canonical payload — order-independent by construction. */
export async function digestOf(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonicalJSON(value));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function requireFields(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null) {
      fail(422, 'missing_field', `missing required field "${field}"`);
    }
  }
}

/** 16KiB prose-field cap shared by goal/summary/body text inputs.
 * The limit is measured in UTF-8 bytes, not code units, so multibyte
 * input cannot slip past the documented 16KiB bound. */
export function requireProse(value: unknown, field: string, max = MAX_PROSE_CHARS): string {
  if (typeof value !== 'string') {
    fail(422, 'invalid_field', `"${field}" must be a string`);
  }
  if (new TextEncoder().encode(value).length > max) {
    fail(422, 'prose_too_large', `"${field}" exceeds ${max} bytes`);
  }
  return value;
}

/** 256KiB request-body cap, applied before JSON parsing semantics matter. */
export async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    fail(429, 'request_too_large', `request body exceeds ${maxBytes} bytes`, {
      retryable: false,
      nextAction: 'move large payloads to an artifact reference',
    });
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(422, 'invalid_body', 'request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(422, 'invalid_body', 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export interface CommandBody {
  operationId?: string;
  expectedRevision?: number;
  assignmentEpoch?: number;
  [key: string]: unknown;
}

export type CommandApply = (draft: ProjectState) => { status: number; body: unknown };

/**
 * Atomic write pipeline shared by every module endpoint.
 *
 * Order is contract-fixed (spec amendment 6):
 *   1. validate current access against live state,
 *   2. resolve operationId + canonical payload digest against the prior
 *      operation — BEFORE stale revision checks,
 *   3. expectedRevision check on the target entity,
 *   4. module apply() — validates assignmentEpoch and cross-entity
 *      invariants itself and throws fail() for domain rejections,
 *   5. bump the target entity revision,
 *   6. persist the immutable operation record + result + event together.
 *
 * Same operationId + same digest replays the saved result even after the
 * revision moved; same id + different digest is 409 with no mutation. A
 * prior operation without a result (external effect in flight) returns 202
 * with a lookup pointer — never an invitation to duplicate it.
 * Actor/display-name fields inside body never authorize anything; only
 * ctx.principal does.
 */
/** Initial-revision assertions on a create are not collection locks. */
export function createEnvelope(body: CommandBody): CommandBody {
  if (body.expectedRevision !== 1) return body;
  const { expectedRevision: _omit, ...rest } = body;
  return rest;
}
export function assertCreationRevision(body: CommandBody): void {
  if (body.expectedRevision === undefined || body.expectedRevision === 1) return;
  if (typeof body.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
    fail(422, 'invalid_field', 'expectedRevision must be a positive integer');
  }
  fail(409, 'stale_revision', 'created records start at revision 1', {
    nextAction: 'omit expectedRevision or send 1 for a new record',
  });
}

export async function command(
  ctx: Context,
  body: CommandBody,
  scope: string,
  target: CommandTarget,
  apply: CommandApply,
): Promise<Response> {
  if (typeof body?.operationId !== 'string' || body.operationId.length === 0) {
    fail(422, 'missing_operation', 'operationId is required for write operations');
  }
  const operationId = body.operationId;
  const creation = target.collection !== 'project' && target.id === undefined;
  const digest = await digestOf({ scope, target, body: creation ? createEnvelope(body) : body });

  const result = await ctx.store.transact((draft) => {
    requireScope(ctx.principal, scope, draft);

    const prior = draft.operations[operationId] as Operation | undefined;
    if (prior) {
      if (prior.importedUnverified) fail(409, 'imported_operation', 'archived operations cannot be replayed or resumed; use a new operationId for current work');
      if(prior.actorId!==ctx.principal.id)fail(403,'operation_owner','Operation belongs to another actor');
      if (prior.digest !== digest) {
        fail(409, 'conflicting_operation', 'operationId reused with a different payload', {
          nextAction: 'use a new operationId',
        });
      }
      if (prior.result) return prior.result;
      return {
        status: 202,
        body: {
          operationId,
          effect: prior.effect,
          nextAction: `GET /api/v1/projects/${draft.project.id}/operations/${operationId}`,
        },
      };
    }

    if (
      body.expectedRevision !== undefined &&
      (typeof body.expectedRevision !== 'number' ||
        !Number.isInteger(body.expectedRevision) ||
        body.expectedRevision < 1)
    ) {
      fail(422, 'invalid_field', 'expectedRevision must be a positive integer', {
        retryable: false,
      });
    }
    if (target.collection === 'project' || target.id !== undefined) {
      // Protocol: every write on a changed entity carries expectedRevision.
      if (body.expectedRevision === undefined) {
        fail(422, 'missing_revision', 'expectedRevision is required for entity-targeted writes');
      }
    }
    if (target.collection === 'project') {
      assertRevision(draft.project, body.expectedRevision);
    } else if (target.id !== undefined) {
      assertRevision(entity(draft, target.collection, target.id), body.expectedRevision);
    } else {
      assertCreationRevision(body);
    }

    const applied = apply(draft);
    if (applied.status >= 400) {
      const message =
        typeof applied.body === 'object' && applied.body !== null
          ? String((applied.body as Record<string, unknown>).message ?? 'operation rejected')
          : 'operation rejected';
      fail(applied.status, 'domain_rejected', message);
    }

    if (target.collection === 'project') {
      touchEntity(draft.project, ctx, ctx.principal.id);
    } else if (target.id !== undefined) {
      touchEntity(entity(draft, target.collection, target.id), ctx, ctx.principal.id);
    }

    const now = ctx.now();
    const op: Operation = {
      id: operationId,
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      scope,
      target,
      digest,
      expectedRevision: body.expectedRevision,
      intent: typeof body.intent === 'string' ? body.intent : scope,
      effect: 'confirmed',
      result: applied,
    };
    draft.operations[operationId] = op;
    appendEvent(draft, ctx, `operation:${scope}`, target.id ?? draft.project.id, {
      operationId,
      collection: target.collection,
      status: applied.status,
    });
    return applied;
  });

  return json(result.status, result.body);
}

/**
 * Member-safe view: strips all private auth records and every message not
 * addressed to (or sent by) this principal. Never hand raw state to a
 * scoped client.
 */
/**
 * Jobs carry a `collectorTokenHash` when they are check jobs -- a hash of a
 * job-scoped bearer credential is still auth material and never crosses a
 * safe-view or export boundary.
 */
function publicJobs(state: ProjectState): Record<Id, CheckJob> {
  const jobs: Record<Id, CheckJob> = {};
  for (const [id, job] of Object.entries(state.jobs)) {
    const { collectorTokenHash: _omit, ...rest } = job as CheckJob & { collectorTokenHash?: string };
    jobs[id] = rest as CheckJob;
  }
  return jobs;
}

/**
 * A stored operation result can embed a message projection (offer, reply,
 * help and handoff applies return publicMessage payloads, body included).
 * The durable record keeps it verbatim -- idempotent replay depends on the
 * exact stored result -- but a member projection must not hand another
 * inbox's content to a third party. Any object shaped like a message
 * (senderId + recipientId + body) that is not addressed to or sent by the
 * principal is replaced by an opaque marker.
 */
export function redactForeignMessageFields(value: unknown, principal: Principal): unknown {
  if (Array.isArray(value)) return value.map((v) => redactForeignMessageFields(v, principal));
  if (value === null || typeof value !== 'object') return value;
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.recipientId === 'string' &&
    typeof rec.senderId === 'string' &&
    typeof rec.body === 'string' &&
    rec.recipientId !== principal.id &&
    rec.senderId !== principal.id
  ) {
    return { id: rec.id, redacted: 'private message' };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) {
    out[key] = redactForeignMessageFields(item, principal);
  }
  return out;
}

function safeOperations(state: ProjectState, principal: Principal): Record<Id, Operation> {
  const operations: Record<Id, Operation> = {};
  for (const [id, op] of Object.entries(state.operations)) {
    operations[id] =
      op.result === undefined
        ? op
        : { ...op, result: { ...op.result, body: redactForeignMessageFields(op.result.body, principal) } };
  }
  return operations;
}

export function safeSnapshot(state: ProjectState, principal: Principal): ProjectState {
  const messages: Record<Id, Message> = {};
  for (const [id, msg] of Object.entries(state.messages)) {
    if (msg.recipientId === principal.id || msg.senderId === principal.id) {
      messages[id] = msg;
    }
  }
  return {
    ...state,
    credentials: {},
    invitations: {},
    jobs: publicJobs(state),
    messages,
    operations: safeOperations(state, principal),
  };
}

/** Full-project export: all credentials and invitation token hashes removed. */
export function exportSnapshot(state: ProjectState): ProjectState {
  return { ...state, credentials: {}, invitations: {}, jobs: publicJobs(state) };
}
