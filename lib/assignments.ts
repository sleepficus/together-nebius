import {stopAllRuns} from './run-state.ts';
// Atomic task assignments, epochs and lease management for the Together
// slice (seat b-swe-03). One 'owner'-role assignment per task; helper roles
// are separate assignment records. Claim/reclaim/stop run inside the shared
// command() transaction on the task or assignment target, so ownership
// changes are atomic with expectedRevision + operationId dedupe.
//
// Epoch rules (spec + amendment 5): reclaim advances the epoch atomically;
// an expired-but-unreclaimed current epoch may still submit through
// assertAssignmentEpoch; after reclaim, old-epoch output is preserved via
// preserveLateOutput and never changes current ownership. renewForJobHeartbeat
// is the downstream helper for the check runner's heartbeat route: it renews
// only the registered owner assignment and current epoch, bounded by the
// job deadline and the assignment's claim-time maxUntil cap.
//
// Scope contract: read (lists/detail), tasks:write (create task, saved
// layout), tasks:claim (claim/reclaim), assignments:write (project stop and
// non-holder renew/stop). Holders renew/stop their own assignment as
// authenticated assignment activity without an extra scope.

import {
  ADMIN_SCOPE, PAGE_LIMIT, appendEvent, createEnvelope, assertCreationRevision, command, entity, fail, json,
  requireFields, requireProse, requireScope, touchEntity,
} from './core.ts';
import type {
  Assignment, Context, Id, IsoTime, LateOutput, ProjectState, Task,
  TaskDependency,
} from './types.ts';

export const SCOPES = {
  read: 'read',
  tasksWrite: 'tasks:write',
  tasksClaim: 'tasks:claim',
  assignmentsWrite: 'assignments:write',
} as const;

/** The one-per-task role; every other role is a separate helper assignment. */
export const OWNER_ROLE = 'owner';
/** Default lease = configured check timeout plus this safety margin. */
export const LEASE_MARGIN_MS = 5 * 60 * 1000;
/** Renewal cap when the caller does not configure maxMs at claim time. */
export const DEFAULT_MAX_MS = 24 * 60 * 60 * 1000;
export const MAX_ROLE_CHARS = 64;

export function defaultLeaseMs(state: ProjectState): number {
  return state.project.resourceLimits.checkTimeoutMs + LEASE_MARGIN_MS;
}

function validMs(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(422, 'invalid_field', `${field} must be a positive number of milliseconds`);
  }
  return value;
}

export function publicAssignment(a: Assignment): Record<string, unknown> {
  return {
    id: a.id,
    revision: a.revision,
    taskId: a.taskId,
    identityId: a.identityId,
    sessionId: a.sessionId,
    role: a.role,
    scopes: a.scopes,
    epoch: a.epoch,
    leaseExpiresAt: a.leaseExpiresAt,
    maxUntil: a.maxUntil,
    status: a.status,
    forkRef: a.forkRef,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    actorId: a.actorId,
  };
}

function publicTask(t: Task): Record<string, unknown> {
  return {
    id: t.id,
    revision: t.revision,
    goal: t.goal,
    acceptanceCriteria: t.acceptanceCriteria,
    dependencies: t.dependencies,
    lifecycle: t.lifecycle,
    currentAssignmentId: t.currentAssignmentId,
    resultRefs: t.resultRefs,
    nextAction: t.nextAction,
    progressSummary:t.progressSummary,blocker:t.blocker,completion:t.completion,
    layout: t.layout,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    actorId: t.actorId,
  };
}

/**
 * Create an assignment record inside the caller's transaction. Shared by
 * claim, reclaim and downstream offer-acceptance paths so every assignment
 * gets the same lease/maxUntil math and epoch semantics. `epoch` is
 * supplied only by reclaim (previous epoch + 1); fresh claims start at 1.
 */
export function createAssignment(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: {
    taskId: Id;
    identityId: Id;
    sessionId?: Id;
    role: string;
    scopes?: string[];
    epoch?: number;
    leaseMs?: unknown;
    maxMs?: unknown;
  },
): Assignment {
  const now = ctx.now();
  const leaseMs = validMs(input.leaseMs, 'leaseMs') ?? defaultLeaseMs(draft);
  const maxMs = validMs(input.maxMs, 'maxMs') ?? DEFAULT_MAX_MS;
  const maxUntil = new Date(Date.parse(now) + maxMs).toISOString();
  const leaseExpiresAt = new Date(
    Math.min(Date.parse(now) + leaseMs, Date.parse(maxUntil)),
  ).toISOString();
  const assignment: Assignment = {
    id: ctx.uid(),
    projectId: draft.project.id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    actorId: ctx.principal.id,
    taskId: input.taskId,
    identityId: input.identityId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    role: input.role,
    scopes: input.scopes ?? [],
    epoch: input.epoch ?? 1,
    leaseExpiresAt,
    maxUntil,
    status: 'active',
  };
  draft.assignments[assignment.id] = assignment;
  return assignment;
}

/**
 * Epoch gate for downstream writes made under a claim (proposal submit,
 * handoff, result attach). Returns the assignment and whether its lease is
 * live or expired-but-unreclaimed -- both may submit. Throws 409
 * epoch_reclaimed/stale_epoch/assignment_inactive once the epoch has moved;
 * callers catch that and route the output through preserveLateOutput
 * instead of mutating current ownership.
 */
export function assertAssignmentEpoch(
  draft: ProjectState,
  input: { assignmentId: Id; epoch: number; now?: IsoTime },
): { assignment: Assignment; epochState: 'current' | 'expired-unreclaimed' } {
  const a = draft.assignments[input.assignmentId];
  if (!a) fail(404, 'not_found', `assignments/${input.assignmentId} does not exist`);
  if (a.status === 'reclaimed') {
    fail(409, 'epoch_reclaimed', 'assignment epoch was reclaimed; preserve late output separately');
  }
  if (a.status !== 'active') {
    fail(409, 'assignment_inactive', `assignment is ${a.status}`);
  }
  if (a.epoch !== input.epoch) {
    fail(409, 'stale_epoch', `assignment epoch is ${a.epoch}`, {
      nextAction: 're-read the assignment and retry with the current epoch',
    });
  }
  const now = input.now ?? new Date().toISOString();
  if (a.leaseExpiresAt <= now) {
    return { assignment: a, epochState: 'expired-unreclaimed' };
  }
  return { assignment: a, epochState: 'current' };
}

/**
 * Preserve output that arrived after its assignment epoch ended. Appends a
 * LateOutput record plus an event; never touches the task's current owner.
 */
export function preserveLateOutput(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: {
    assignmentId: Id;
    taskId?: Id;
    epoch: number;
    kind: string;
    ref?: string;
    note?: string;
  },
): LateOutput {
  const lo: LateOutput = {
    id: ctx.uid(),
    projectId: draft.project.id,
    createdAt: ctx.now(),
    assignmentId: input.assignmentId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    epoch: input.epoch,
    kind: input.kind,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  draft.lateOutputs.push(lo);
  appendEvent(draft, ctx, 'late-output:preserved', input.assignmentId, {
    lateOutputId: lo.id,
    kind: input.kind,
    epoch: input.epoch,
  });
  return lo;
}

/**
 * Lease renewal driven by a check runner's job heartbeat (amendment 5).
 * Renews ONLY the registered owner assignment at its registered epoch, and
 * at most through the job deadline and the assignment's maxUntil cap. A
 * beat for a superseded epoch or a different assignment is late activity:
 * it is recorded as an event and renews nothing -- never the successor.
 * Callable inside any module's transaction (e.g. the collector route).
 */
export function renewForJobHeartbeat(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: { jobId: Id; assignmentId: Id; epoch: number },
): { renewed: boolean; leaseExpiresAt?: IsoTime; reason?: string } {
  const job = draft.jobs[input.jobId];
  if (!job) fail(404, 'not_found', `jobs/${input.jobId} does not exist`);
  const a = draft.assignments[input.assignmentId];
  if (!a) fail(404, 'not_found', `assignments/${input.assignmentId} does not exist`);

  if (a.status !== 'active' || a.epoch !== input.epoch) {
    appendEvent(draft, ctx, 'assignment:heartbeat-late', input.assignmentId, {
      jobId: input.jobId,
      epoch: input.epoch,
      currentEpoch: a.epoch,
      status: a.status,
    });
    return { renewed: false, reason: 'superseded-epoch' };
  }
  if (job.ownerAssignmentId !== input.assignmentId || job.ownerEpoch !== input.epoch) {
    appendEvent(draft, ctx, 'assignment:heartbeat-late', input.assignmentId, {
      jobId: input.jobId,
      epoch: input.epoch,
      ownerAssignmentId: job.ownerAssignmentId,
      ownerEpoch: job.ownerEpoch,
    });
    return { renewed: false, reason: 'not-job-owner' };
  }
  // A beat for a job that is no longer active (completed/failed/cancelled/
  // blocked) is late activity: recorded, but it renews nothing.
  const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set(['queued', 'dispatched', 'running']);
  if (!ACTIVE_JOB_STATUSES.has(job.status)) {
    appendEvent(draft, ctx, 'assignment:heartbeat-late', input.assignmentId, {
      jobId: input.jobId,
      epoch: input.epoch,
      jobStatus: job.status,
    });
    return { renewed: false, reason: 'job-not-active' };
  }
  const nowMs = Date.parse(ctx.now());
  const maxUntil = Date.parse(a.maxUntil);
  // Jobs without a registered deadline fall back to the assignment's own
  // maxUntil cap; the renewal is still bounded and the absence is recorded.
  const deadlineUnbounded = job.deadlineAt === undefined;
  const deadline = deadlineUnbounded ? maxUntil : Date.parse(job.deadlineAt as string);
  const cap = Math.min(deadline, maxUntil);
  if (cap <= nowMs) {
    return { renewed: false, reason: 'deadline-passed' };
  }
  const next = Math.max(Date.parse(a.leaseExpiresAt), cap);
  a.leaseExpiresAt = new Date(next).toISOString();
  touchEntity(a, ctx, ctx.principal.id);
  appendEvent(draft, ctx, 'assignment:heartbeat', a.id, {
    jobId: input.jobId,
    epoch: a.epoch,
    leaseExpiresAt: a.leaseExpiresAt,
    maxUntil: a.maxUntil,
    ...(deadlineUnbounded ? { deadlineUnbounded: true } : {}),
  });
  return { renewed: true, leaseExpiresAt: a.leaseExpiresAt };
}

function claimableTask(draft: ProjectState, taskId: Id): Task {
  const task = draft.tasks[taskId];
  if (task) return task;
  if (draft.candidates[taskId]) {
    fail(422, 'candidate_not_claimable', 'candidates are system-derived records and cannot be claimed');
  }
  fail(404, 'not_found', `tasks/${taskId} does not exist`);
}

/** Requested assignment scopes are narrowed to what the principal holds. */
function grantScopes(ctx: Context, requested: unknown): string[] {
  const want = requested === undefined ? ['read', 'tasks:write'] : requested;
  if (!Array.isArray(want)) fail(422, 'invalid_field', 'scopes must be an array');
  const held = ctx.principal.scopes;
  const isAdmin = ctx.principal.kind === 'system' || held.includes(ADMIN_SCOPE);
  const granted: string[] = [];
  for (const s of want) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 128) {
      fail(422, 'invalid_field', 'invalid scope entry');
    }
    if (isAdmin || held.includes(s)) granted.push(s);
  }
  return granted;
}


/**
 * Validate task dependencies at create time. Only 'prerequisite' and
 * 'contributes-changes' edges participate in the dependency graph; they are
 * checked for self-links, unknown targets, candidate IDs and cycles across
 * the whole graph including the new node's edges.
 */
function validateDependencies(
  draft: ProjectState,
  newTaskId: Id,
  deps: unknown,
): TaskDependency[] {
  if (deps === undefined) return [];
  if (!Array.isArray(deps)) fail(422, 'invalid_field', 'dependencies must be an array');
  const out: TaskDependency[] = [];
  const seen = new Set<string>();
  for (const d of deps) {
    if (typeof d !== 'object' || d === null) {
      fail(422, 'invalid_dependency', 'dependency entries must be objects');
    }
    const taskId = (d as Record<string, unknown>).taskId;
    const kind = (d as Record<string, unknown>).kind;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      fail(422, 'invalid_dependency', 'dependency.taskId is required');
    }
    if (kind !== 'prerequisite' && kind !== 'contributes-changes') {
      fail(422, 'invalid_dependency_kind', 'kind must be prerequisite or contributes-changes');
    }
    if (taskId === newTaskId) {
      fail(422, 'dependency_self', 'a task cannot depend on itself');
    }
    if (!draft.tasks[taskId]) {
      if (draft.candidates[taskId]) {
        fail(422, 'candidate_not_task', 'candidates are system records, not dependency targets');
      }
      fail(422, 'invalid_dependency', `unknown task ${taskId}`);
    }
    const key = `${kind}:${taskId}`;
    if (seen.has(key)) fail(422, 'invalid_dependency', 'duplicate dependency');
    seen.add(key);
    out.push({ taskId, kind });
  }
  const edges = new Map<Id, Id[]>();
  const addEdge = (from: Id, to: Id): void => {
    const list = edges.get(from) ?? [];
    list.push(to);
    edges.set(from, list);
  };
  for (const t of Object.values(draft.tasks)) {
    for (const dep of t.dependencies) addEdge(t.id, dep.taskId);
  }
  for (const dep of out) addEdge(newTaskId, dep.taskId);
  const color = new Map<Id, number>();
  const visit = (node: Id): boolean => {
    const c = color.get(node);
    if (c === 0) return true;
    if (c === 1) return false;
    color.set(node, 0);
    for (const next of edges.get(node) ?? []) {
      if (visit(next)) return true;
    }
    color.set(node, 1);
    return false;
  };
  for (const id of edges.keys()) {
    if (!color.has(id) && visit(id)) {
      fail(422, 'dependency_cycle', 'dependency graph contains a cycle');
    }
  }
  return out;
}

function parseLayout(value: unknown): { x: number; y: number } {
  if (typeof value !== 'object' || value === null) {
    fail(422, 'invalid_field', 'layout must be an object with numeric x and y');
  }
  const x = (value as Record<string, unknown>).x;
  const y = (value as Record<string, unknown>).y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    fail(422, 'invalid_field', 'layout x/y must be finite numbers');
  }
  return { x, y };
}

async function listTasks(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const stateFilter = url.searchParams.get('state');
  const cursor = url.searchParams.get('cursor');
  const limitParam = Number(url.searchParams.get('limit') ?? PAGE_LIMIT);
  const limit = Math.min(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : PAGE_LIMIT, PAGE_LIMIT);
  const all = Object.values(state.tasks)
    .filter((t) => (stateFilter === null ? true : t.lifecycle === stateFilter))
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1));
  let start = 0;
  if (cursor !== null) {
    const idx = all.findIndex((t) => t.id === cursor);
    if (idx < 0) fail(404, 'not_found', 'cursor task not found');
    start = idx + 1;
  }
  const page = all.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor = start + limit < all.length && last ? last.id : null;
  return json(200, {
    tasks: page.map(publicTask),
    count: page.length,
    total: all.length,
    nextCursor,
  });
}

async function getTask(ctx: Context, taskId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const task = claimableTask(state, taskId);
  return json(200, { task: publicTask(task) });
}

async function listTaskAssignments(ctx: Context, taskId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  claimableTask(state, taskId);
  const assignments = Object.values(state.assignments)
    .filter((a) => a.taskId === taskId)
    .map(publicAssignment);
  return json(200, { assignments });
}

async function getAssignment(ctx: Context, assignmentId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const a = entity<Assignment>(state, 'assignments', assignmentId);
  return json(200, { assignment: publicAssignment(a) });
}

function createTask(ctx: Context, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.tasksWrite, { collection: 'tasks' }, (draft) => {
    requireFields(body, ['goal', 'acceptanceCriteria']);
    const goal = requireProse(body.goal, 'goal');
    if (!Array.isArray(body.acceptanceCriteria)) {
      fail(422, 'invalid_field', 'acceptanceCriteria must be an array');
    }
    const acceptanceCriteria = body.acceptanceCriteria.map((c, i) =>
      requireProse(c, `acceptanceCriteria[${i}]`),
    );
    if (acceptanceCriteria.length === 0) {
      fail(422, 'invalid_field', 'acceptanceCriteria must not be empty');
    }
    const lifecycle = body.lifecycle === undefined ? 'open' : body.lifecycle;
    if (lifecycle !== 'open' && lifecycle !== 'draft') {
      fail(422, 'invalid_field', 'lifecycle must be draft or open at creation');
    }
    const id = ctx.uid();
    const dependencies = validateDependencies(draft, id, body.dependencies);
    const now = ctx.now();
    const task: Task = {
      id,
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      goal,
      acceptanceCriteria,
      dependencies,
      lifecycle,
      resultRefs: [],
      ...(body.nextAction !== undefined
        ? { nextAction: requireProse(body.nextAction, 'nextAction') }
        : {}),
      ...(body.layout !== undefined ? { layout: parseLayout(body.layout) } : {}),
    };
    draft.tasks[id] = task;
    appendEvent(draft, ctx, 'task:created', id, {
      goal: goal.slice(0, 200),
      dependencies: dependencies.length,
    });
    return { status: 201, body: { task: publicTask(task) } };
  });
}

function saveLayout(ctx: Context, taskId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.tasksWrite, { collection: 'tasks', id: taskId }, (draft) => {
    const task = claimableTask(draft, taskId);
    // Dragging a box updates saved layout only -- dependencies never change.
    task.layout = parseLayout(body.layout ?? body);
    appendEvent(draft, ctx, 'task:layout', task.id, task.layout);
    return { status: 200, body: { task: publicTask(task) } };
  });
}

function claimTask(ctx: Context, taskId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.tasksClaim, { collection: 'tasks', id: taskId }, (draft) => {
    if (draft.stopped) {
      fail(409, 'project_stopped', 'project is stopped; new claims are blocked');
    }
    const task = claimableTask(draft, taskId);
    if (task.lifecycle === 'done' || task.lifecycle === 'cancelled') {
      fail(409, 'task_closed', `task is ${task.lifecycle}`);
    }
    const role =
      body.role === undefined ? OWNER_ROLE : requireProse(body.role, 'role', MAX_ROLE_CHARS);
    const active = Object.values(draft.assignments).filter(
      (a) => a.taskId === task.id && a.status === 'active',
    );
    if (role === OWNER_ROLE) {
      if (active.some((a) => a.role === OWNER_ROLE)) {
        fail(409, 'already_claimed', 'task already has an active owner', {
          nextAction: 'reclaim after lease expiry or claim a helper role',
        });
      }
    } else if (active.some((a) => a.identityId === ctx.principal.id && a.role === role)) {
      fail(409, 'already_assigned', 'identity already holds this role on the task');
    }
    const assignment = createAssignment(draft, ctx, {
      taskId: task.id,
      identityId: ctx.principal.id,
      sessionId: ctx.principal.sessionId,
      role,
      scopes: grantScopes(ctx, body.scopes),
      leaseMs: body.leaseMs,
      maxMs: body.maxMs,
    });
    if (role === OWNER_ROLE) {
      task.currentAssignmentId = assignment.id;
      task.lifecycle = 'claimed';
      task.nextAction = 'assignment active; submit changes through the assigned fork';
    }
    appendEvent(draft, ctx, 'task:claimed', task.id, {
      assignmentId: assignment.id,
      role,
      epoch: assignment.epoch,
      leaseExpiresAt: assignment.leaseExpiresAt,
      maxUntil: assignment.maxUntil,
    });
    return { status: 201, body: { assignment: publicAssignment(assignment), task: publicTask(task) } };
  });
}

function reclaimTask(ctx: Context, taskId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.tasksClaim, { collection: 'tasks', id: taskId }, (draft) => {
    if (draft.stopped) {
      fail(409, 'project_stopped', 'project is stopped; reclaims are blocked');
    }
    const task = claimableTask(draft, taskId);
    if (task.lifecycle === 'done' || task.lifecycle === 'cancelled') {
      fail(409, 'task_closed', `task is ${task.lifecycle}`);
    }
    const current =
      task.currentAssignmentId !== undefined
        ? draft.assignments[task.currentAssignmentId]
        : undefined;
    if (!current || current.role !== OWNER_ROLE || current.status !== 'active') {
      fail(409, 'no_claim', 'task has no active owner claim to reclaim');
    }
    if (current.leaseExpiresAt > ctx.now()) {
      fail(409, 'claim_active', 'lease has not expired', {
        nextAction: `retry after ${current.leaseExpiresAt}`,
      });
    }
    // Atomic: mark the old epoch reclaimed and seat the new owner epoch in
    // one transaction. Old-epoch writes now fail; late output is preserved
    // separately via preserveLateOutput and never displaces the new owner.
    current.status = 'reclaimed';
    touchEntity(current, ctx, ctx.principal.id);
    const next = createAssignment(draft, ctx, {
      taskId: task.id,
      identityId: ctx.principal.id,
      sessionId: ctx.principal.sessionId,
      role: OWNER_ROLE,
      scopes: grantScopes(ctx, body.scopes),
      epoch: current.epoch + 1,
      leaseMs: body.leaseMs,
      maxMs: body.maxMs,
    });
    task.currentAssignmentId = next.id;
    task.lifecycle = 'claimed';
    appendEvent(draft, ctx, 'task:reclaimed', task.id, {
      fromAssignmentId: current.id,
      fromEpoch: current.epoch,
      toAssignmentId: next.id,
      toEpoch: next.epoch,
    });
    return {
      status: 201,
      body: {
        assignment: publicAssignment(next),
        reclaimedFrom: { assignmentId: current.id, epoch: current.epoch },
        task: publicTask(task),
      },
    };
  });
}

/** Holder renewal is authenticated assignment activity; others need the scope. */
function assertHolderOrAdmin(ctx: Context, a: Assignment, action: string): void {
  const p = ctx.principal;
  const isAdmin =
    p.kind === 'system' ||
    p.scopes.includes(ADMIN_SCOPE) ||
    p.scopes.includes(SCOPES.assignmentsWrite);
  if (a.identityId !== p.id && !isAdmin) {
    fail(403, 'scope_denied', `only the assignment holder or an assignments admin may ${action}`);
  }
}

function renewAssignment(ctx: Context, assignmentId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.read, { collection: 'assignments', id: assignmentId }, (draft) => {
    const a = entity<Assignment>(draft, 'assignments', assignmentId);
    assertHolderOrAdmin(ctx, a, 'renew');
    if (typeof body.assignmentEpoch !== 'number') {
      fail(422, 'missing_epoch', 'assignmentEpoch is required when acting under a claim');
    }
    if (a.status !== 'active') fail(409, 'assignment_inactive', `assignment is ${a.status}`);
    if (a.epoch !== body.assignmentEpoch) {
      fail(409, 'stale_epoch', `assignment epoch is ${a.epoch}`);
    }
    const nowMs = Date.parse(ctx.now());
    if (nowMs >= Date.parse(a.maxUntil)) {
      fail(409, 'beyond_max', 'renewal cap maxUntil reached; the assignment cannot be renewed further');
    }
    const leaseMs = validMs(body.leaseMs, 'leaseMs') ?? defaultLeaseMs(draft);
    const capped = Math.min(nowMs + leaseMs, Date.parse(a.maxUntil));
    a.leaseExpiresAt = new Date(Math.max(capped, Date.parse(a.leaseExpiresAt))).toISOString();
    appendEvent(draft, ctx, 'assignment:renewed', a.id, {
      epoch: a.epoch,
      leaseExpiresAt: a.leaseExpiresAt,
      maxUntil: a.maxUntil,
    });
    return { status: 200, body: { assignment: publicAssignment(a) } };
  });
}

function stopAssignment(ctx: Context, assignmentId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.read, { collection: 'assignments', id: assignmentId }, (draft) => {
    const a = entity<Assignment>(draft, 'assignments', assignmentId);
    assertHolderOrAdmin(ctx, a, 'stop');
    if (a.status !== 'active') fail(409, 'assignment_inactive', `assignment is ${a.status}`);
    a.status = 'stopped';
    const task = draft.tasks[a.taskId];
    if (task && a.role === OWNER_ROLE && task.currentAssignmentId === a.id) {
      task.currentAssignmentId = undefined;
      if (task.lifecycle === 'claimed' || task.lifecycle === 'in-progress') {
        task.lifecycle = 'open';
      }
      touchEntity(task, ctx, ctx.principal.id);
    }
    appendEvent(draft, ctx, 'assignment:stopped', a.id, { taskId: a.taskId, epoch: a.epoch });
    return { status: 200, body: { assignment: publicAssignment(a) } };
  });
}

function setStopped(ctx: Context, body: Record<string, unknown>, stopped: boolean): Promise<Response> {
  return command(ctx, body, SCOPES.assignmentsWrite, { collection: 'project' }, (draft) => {
    if (draft.stopped !== stopped) {
      draft.stopped = stopped;
      if(stopped)stopAllRuns(draft,ctx.now());
      appendEvent(draft, ctx, stopped ? 'project:stopped' : 'project:resumed', draft.project.id, {});
    }
    return { status: 200, body: { stopped } };
  });
}

/**
 * Module handler for task/assignment endpoints. Segments are the suffix
 * after /api/v1/projects/:projectId. Returns null for unowned routes.
 * Candidate assignment attempts are rejected explicitly: candidates are
 * system-derived records, never claimable tasks.
 */
export async function handleAssignments(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (segments[0] === 'candidates' && segments.length === 3 && segments[2] === 'assignments') {
    fail(422, 'candidate_not_claimable', 'candidates are system-derived records and cannot be claimed');
  }

  if (method === 'GET' && segments.length === 1 && segments[0] === 'tasks') {
    return listTasks(ctx, request);
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'tasks' && body) {
    return createTask(ctx, body);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'tasks') {
    return getTask(ctx, segments[1]);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'layout' && body) {
    return saveLayout(ctx, segments[1], body);
  }
  if (method === 'GET' && segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'assignments') {
    return listTaskAssignments(ctx, segments[1]);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'assignments' && body) {
    return claimTask(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'reclaim' && body) {
    return reclaimTask(ctx, segments[1], body);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'assignments') {
    return getAssignment(ctx, segments[1]);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'assignments' && segments[2] === 'renew' && body) {
    return renewAssignment(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'assignments' && segments[2] === 'stop' && body) {
    return stopAssignment(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'stop' && body) {
    const response=await setStopped(ctx,body,true);if(ctx.conversation)for(const status of ['open','waiting','unconfirmed'])for(const invite of ctx.conversation.records<any>('chat_invitations',status))ctx.conversation.putRecord('chat_invitations',{...invite,status:'stopped',reason:'Project stopped; no new dispatch'});return response;
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'resume' && body) {
    return setStopped(ctx, body, false);
  }
  return null;
}

export { createEnvelope } from "./core.ts";
