// Durable work inbox, help, offers, handoffs and claimed-fork workspaces
// for the Together slice (seat b-swe-06).
//
// Model (spec + amendment 7):
// - every identity has a durable per-project inbox projection; a message is
//   addressed to exactly one recipient and stays private to them
//   (safeSnapshot hides other inboxes; GET /inbox returns only the caller's
//   own addressed mail),
// - GET records delivery (queued -> delivered) and labels expired mail; it
//   never launches adapters, sessions or retries,
// - POST /inbox/:id/ack records a read receipt only,
// - acceptance/answer are task-specific actions: accepting an
//   assignment-offer message validates recipient, expiry, task revision and
//   current assignment inside ONE transaction, so two sessions of one
//   identity cannot accept the same offer as separate work and a stale or
//   expired offer returns 409,
// - handoffs record done/next/uncertain/verify-first/do-not-repeat under a
//   live claim; accepting a handoff message never transfers the assignment.
//   Handoffs arriving on a reclaimed epoch are preserved in lateOutputs and
//   never applied to current ownership,
// - opening a workspace calls the injected Artifacts service only under a
//   current claim plus the explicit workspace scope; the token envelope is
//   a separate response field, returned once and never stored in state,
//   operation results, exports or logs,
// - the brief returns the latest handoff verbatim with its epoch label so a
//   newcomer can recover context without the UI,
// - no global agent-to-agent social messaging: replies thread to the
//   original sender inside the same task, offers/help are task-linked.
//
// Scope contract (enumerated; denials are explicit, never silent):
//   read             brief, inbox GET, help/handoff GET, own ack + accept
//   inbox:write      task-linked replies
//   offers:write     create assignment-offer messages
//   help:write       ask / accept / answer / withdraw help
//   tasks:claim      required to ACCEPT an assignment-offer (same as claim)
//   workspace:write  open a claimed-fork workspace (plus holder check)
// Holder-only actions (handoff, workspace) additionally require the caller
// to own the assignment or hold assignments:write/admin.

import {
  ApiError, PAGE_LIMIT, appendEvent, assertRevision, command, digestOf,
  entity, fail, json, requireFields, requireProse, requireScope,
  touchEntity,
} from './core.ts';
import {
  OWNER_ROLE, assertAssignmentEpoch, createAssignment,
  preserveLateOutput, publicAssignment,
} from './assignments.ts';
import type {
  Assignment, Context, Handoff, HelpRequest, Id, IsoTime, Message,
  Operation, Principal, ProjectState, RepositoryMapping, Task,
} from './types.ts';

export const SCOPES = {
  read: 'read',
  inboxWrite: 'inbox:write',
  offersWrite: 'offers:write',
  helpWrite: 'help:write',
  tasksClaim: 'tasks:claim',
  workspaceWrite: 'workspace:write',
} as const;

/** Undelivered/unread mail cap per recipient; beyond it senders get 429. */
export const MAX_INBOX_PER_RECIPIENT = 200;
export const DEFAULT_OFFER_TTL_MS = 60 * 60 * 1000;
export const MAX_OFFER_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_HELP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WORKSPACE_TOKEN_TTL_SECONDS = 900;
const MAX_ROLE_CHARS = 64;

interface MessageExtras {
  helpId?: Id;
  handoffId?: Id;
  role?: string;
  scopes?: string[];
  threadId?: Id;
}

const byCreated = <T extends { createdAt: IsoTime; id: Id }>(a: T, b: T): number =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1;

export function publicMessage(m: Message): Record<string, unknown> {
  const extra = m as Message & MessageExtras;
  return {
    id: m.id,
    revision: m.revision,
    type: m.type,
    senderId: m.senderId,
    recipientId: m.recipientId,
    taskId: m.taskId,
    candidateId: m.candidateId,
    helpId: extra.helpId,
    handoffId: extra.handoffId,
    role: extra.role,
    scopes: extra.scopes,
    threadId: extra.threadId,
    body: m.body,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    expiresAt: m.expiresAt,
    delivery: m.delivery,
    readAt: m.readAt,
    acceptedAt: m.acceptedAt,
    answeredAt: m.answeredAt,
    dedupeKey: m.dedupeKey,
  };
}

export function publicHelp(h: HelpRequest): Record<string, unknown> {
  return {
    id: h.id,
    revision: h.revision,
    taskId: h.taskId,
    candidateId: h.candidateId,
    question: h.question,
    expectedContribution: h.expectedContribution,
    offeredById: h.offeredById,
    acceptedById: h.acceptedById,
    answer: h.answer,
    state: h.state,
    expiresAt: h.expiresAt,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
    actorId: h.actorId,
  };
}

export function publicHandoff(h: Handoff): Record<string, unknown> {
  return {
    id: h.id,
    revision: h.revision,
    taskId: h.taskId,
    assignmentId: h.assignmentId,
    fromId: h.fromId,
    toId: h.toId,
    done: h.done,
    next: h.next,
    uncertain: h.uncertain,
    verifyFirst: h.verifyFirst,
    doNotRepeat: h.doNotRepeat,
    epoch: h.epoch,
    planRevisionId: h.planRevisionId??null,
    acceptedById: h.acceptedById,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

export type HandoffEpochLabel =
  'current' | 'expired-unreclaimed' | 'reclaimed' | 'ended' | 'unknown';

/**
 * Latest handoff for a task (or a specific assignment) with its epoch
 * provenance label, evaluated at read time: a handoff written under an
 * epoch that was later reclaimed stays verbatim but is labeled 'reclaimed'.
 */
/** Epoch provenance of one recorded handoff, evaluated at read time. */
export function handoffEpochLabel(
  state: ProjectState,
  handoff: Handoff,
  now?: IsoTime,
): HandoffEpochLabel {
  const a = handoff.assignmentId !== undefined
    ? state.assignments[handoff.assignmentId]
    : undefined;
  if (!a) return 'unknown';
  if (handoff.epoch !== undefined && handoff.epoch !== a.epoch) return 'reclaimed';
  if (a.status === 'reclaimed') return 'reclaimed';
  if (a.status !== 'active') return 'ended';
  const at = now ?? new Date().toISOString();
  if (a.leaseExpiresAt <= at) return 'expired-unreclaimed';
  return 'current';
}

/** Epoch state of an assignment itself (independent of any handoff). */
export function assignmentEpochState(
  a: Assignment,
  now?: IsoTime,
): 'current' | 'expired-unreclaimed' | 'reclaimed' | 'ended' {
  if (a.status === 'reclaimed') return 'reclaimed';
  if (a.status !== 'active') return 'ended';
  const at = now ?? new Date().toISOString();
  if (a.leaseExpiresAt <= at) return 'expired-unreclaimed';
  return 'current';
}

export function latestHandoff(
  state: ProjectState,
  filter: { taskId?: Id; assignmentId?: Id },
  now?: IsoTime,
): { handoff?: Handoff; epochLabel: HandoffEpochLabel } {
  const list = Object.values(state.handoffs)
    .filter((h) =>
      (filter.taskId === undefined || h.taskId === filter.taskId) &&
      (filter.assignmentId === undefined || h.assignmentId === filter.assignmentId))
    .sort(byCreated);
  const handoff = list[list.length - 1];
  if (!handoff) return { epochLabel: 'unknown' };
  return { handoff, epochLabel: handoffEpochLabel(state, handoff, now) };
}

/**
 * Generated HANDOFF.md snapshot supplied beside a claimed fork (or ignored
 * within it). It is derived checkout context, never committed product
 * source, and carries epoch provenance so a stale handoff stays labeled.
 */
export function renderHandoffMarkdown(
  handoff: Handoff,
  opts: { projectId: Id; epochLabel: HandoffEpochLabel; taskGoal?: string },
): string {
  const lines = [
    '<!-- Generated by Together from the recorded handoff. Ignored beside',
    '     the checkout; do not commit this file as product source. -->',
    '# HANDOFF',
    '',
    `- project: ${opts.projectId}`,
    `- task: ${handoff.taskId ?? 'unlinked'}${opts.taskGoal ? ` — ${opts.taskGoal}` : ''}`,
    `- assignment: ${handoff.assignmentId ?? 'none'}`,
    `- epoch: ${handoff.epoch ?? 'n/a'} (${opts.epochLabel})`,
    `- from: ${handoff.fromId}${handoff.toId ? ` -> to: ${handoff.toId}` : ''}`,
    `- recorded: ${handoff.createdAt}`,
    '',
    '## Done',
    handoff.done || '(none recorded)',
    '',
    '## Next',
    handoff.next || '(none recorded)',
    '',
    '## Uncertain',
    handoff.uncertain || '(none recorded)',
    '',
    '## Verify first',
    handoff.verifyFirst || '(none recorded)',
    '',
    '## Do not repeat',
    handoff.doNotRepeat || '(none recorded)',
    '',
  ];
  return lines.join('\n');
}

interface InboxPage {
  page: Message[];
  nextCursor: Id | null;
  resync: boolean;
}

function pageInbox(mine: Message[], after: string | null, limit: number): InboxPage {
  let start = 0;
  let resync = false;
  if (after !== null) {
    const idx = mine.findIndex((m) => m.id === after);
    if (idx < 0) {
      // Cursor gap: return the first page with a resync marker so the
      // client restarts replay instead of silently missing mail.
      resync = true;
    } else {
      start = idx + 1;
    }
  }
  const page = mine.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor = start + limit < mine.length && last ? last.id : null;
  return { page, nextCursor, resync };
}

function inboxCounts(mine: Message[], now: IsoTime): Record<string, number> {
  const counts: Record<string, number> = {
    total: mine.length, queued: 0, delivered: 0, expired: 0,
    read: 0, accepted: 0, answered: 0,
  };
  for (const m of mine) {
    if (m.delivery === 'queued' && m.expiresAt !== undefined && m.expiresAt <= now) {
      counts.expired += 1;
    } else {
      counts[m.delivery] = (counts[m.delivery] ?? 0) + 1;
    }
    if (m.readAt !== undefined) counts.read += 1;
    if (m.acceptedAt !== undefined) counts.accepted += 1;
    if (m.answeredAt !== undefined) counts.answered += 1;
  }
  return counts;
}

/**
 * API helper for the caller's own addressed messages only (spec: "Agents
 * read through GET /api/v1/inbox?after=cursor"). This is a pure read
 * projection: it never mutates state and never reveals another
 * recipient's mail. The project-scoped endpoint adds delivery marking;
 * the integrator can call this per project store to aggregate a global
 * inbox across the caller's accessible projects.
 */
export function globalInbox(
  state: ProjectState,
  principal: Principal,
  opts?: { after?: string; limit?: number; now?: IsoTime },
): {
  messages: Record<string, unknown>[];
  counts: Record<string, number>;
  nextCursor: Id | null;
  resync: boolean;
  projectId: Id;
} {
  const now = opts?.now ?? new Date().toISOString();
  const limit = Math.min(
    opts?.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : PAGE_LIMIT,
    PAGE_LIMIT,
  );
  const mine = Object.values(state.messages)
    .filter((m) => m.recipientId === principal.id)
    .sort(byCreated);
  const { page, nextCursor, resync } = pageInbox(mine, opts?.after ?? null, limit);
  const view = page.map((m) => {
    const pub = publicMessage(m);
    if (m.delivery === 'queued' && m.expiresAt !== undefined && m.expiresAt <= now) {
      pub.delivery = 'expired';
    }
    return pub;
  });
  return {
    messages: view,
    counts: inboxCounts(mine, now),
    nextCursor,
    resync,
    projectId: state.project.id,
  };
}

/** An addressable recipient: project member, active identity or holder of
 *  a credential scoped to this project. Anything else is unavailable. */
function recipientOk(draft: ProjectState, toId: Id): boolean {
  if (draft.identities[toId]?.status === 'active') return true;
  if (Object.values(draft.members).some((m) => m.identityId === toId)) return true;
  return Object.values(draft.credentials).some(
    (c) => c.identityId === toId && c.status === 'active' &&
      c.projectIds.includes(draft.project.id),
  );
}

function assertAddressable(draft: ProjectState, toId: unknown): Id {
  if (typeof toId !== 'string' || toId.length === 0) {
    fail(422, 'invalid_field', 'toId is required');
  }
  if (!recipientOk(draft, toId)) {
    fail(404, 'recipient_unavailable', 'recipient is not addressable in this project');
  }
  return toId;
}

function checkRecipientQuota(draft: ProjectState, toId: Id, now: IsoTime): void {
  const pending = Object.values(draft.messages).filter(
    (m) => m.recipientId === toId && m.delivery !== 'expired' &&
      m.readAt === undefined &&
      (m.expiresAt === undefined || m.expiresAt > now),
  );
  if (pending.length >= MAX_INBOX_PER_RECIPIENT) {
    fail(429, 'recipient_quota', `recipient inbox quota ${MAX_INBOX_PER_RECIPIENT} reached`, {
      retryable: false,
      nextAction: 'wait for the recipient to process or expire queued mail',
    });
  }
}

function newMessage(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: {
    recipientId: Id;
    type: Message['type'];
    body: string;
    taskId?: Id;
    candidateId?: Id;
    expiresAt?: IsoTime;
    dedupeKey?: string;
    extras?: MessageExtras;
  },
): Message {
  const now = ctx.now();
  const msg: Message & MessageExtras = {
    id: ctx.uid(),
    projectId: draft.project.id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    actorId: ctx.principal.id,
    recipientId: input.recipientId,
    senderId: ctx.principal.id,
    type: input.type,
    body: input.body,
    delivery: 'queued',
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.extras ?? {}),
  };
  draft.messages[msg.id] = msg;
  return msg;
}

/** Same dedupe rule for any send path: same recipient + dedupeKey replays
 *  the existing message rather than queueing a twin. */
function findDeduped(draft: ProjectState, toId: Id, dedupeKey: unknown): Message | undefined {
  if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) return undefined;
  return Object.values(draft.messages).find(
    (m) => m.recipientId === toId && m.dedupeKey === dedupeKey,
  );
}

function optionalExpiry(
  draft: ProjectState, ctx: Context, body: Record<string, unknown>, capMs: number,
): IsoTime | undefined {
  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) {
      fail(422, 'invalid_field', 'expiresAt must be an ISO timestamp');
    }
    if (Date.parse(body.expiresAt) - Date.parse(ctx.now()) > capMs) {
      fail(422, 'ttl_exceeds_limit', `expiresAt exceeds the ${capMs}ms cap`);
    }
    return body.expiresAt;
  }
  if (body.ttlMs === undefined) return undefined;
  if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
    fail(422, 'invalid_field', 'ttlMs must be a positive number of milliseconds');
  }
  if (body.ttlMs > capMs) {
    fail(422, 'ttl_exceeds_limit', `ttlMs exceeds the ${capMs}ms cap`);
  }
  return new Date(Date.parse(ctx.now()) + body.ttlMs).toISOString();
}

function assertHolder(ctx: Context, a: Assignment, action: string): void {
  const p = ctx.principal;
  const admin =
    p.kind === 'system' ||
    p.scopes.includes('admin') ||
    p.scopes.includes('assignments:write');
  if (a.identityId !== p.id && !admin) {
    fail(403, 'scope_denied', `only the assignment holder or an assignments admin may ${action}`);
  }
}

/** Accepting an offer grants only scopes the accepting principal holds. */
function narrowToHeld(held: readonly string[], requested: unknown): string[] {
  const want = requested === undefined ? ['read', 'tasks:write'] : requested;
  if (!Array.isArray(want)) fail(422, 'invalid_field', 'scopes must be an array');
  const isAdmin = held.includes('admin');
  const out: string[] = [];
  for (const s of want) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 128) {
      fail(422, 'invalid_field', 'invalid scope entry');
    }
    if (isAdmin || held.includes(s)) out.push(s);
  }
  return out;
}

function findLinkedMessage(draft: ProjectState, helpId: Id, recipientId: Id): (Message & MessageExtras) | undefined {
  return Object.values(draft.messages).find(
    (m) => (m as Message & MessageExtras).helpId === helpId && m.recipientId === recipientId,
  ) as (Message & MessageExtras) | undefined;
}

// ---------------------------------------------------------------- GETs --

async function getBrief(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const taskId = url.searchParams.get('taskId') ?? undefined;
  const now = ctx.now();

  const body: Record<string, unknown> = {
    project: {
      id: state.project.id,
      revision: state.project.revision,
      goal: state.project.mode === 'sample' ? `[sample] ${state.project.goal}` : state.project.goal,
      mode: state.project.mode,
      canonicalRef: state.project.canonicalRef,
      stopped: state.stopped,
    },
    permissions: [...ctx.principal.scopes],
    // Brief/handoff/message content is untrusted source material; it never
    // expands the reader's authority.
    trust: 'untrusted-source-material',
    planRevisionId: state.project.adoptedPlanRevisionId??null,
  };

  if (taskId !== undefined) {
    const task = entity<Task>(state, 'tasks', taskId);
    const assignment = task.currentAssignmentId !== undefined
      ? state.assignments[task.currentAssignmentId]
      : undefined;
    const { handoff, epochLabel } = latestHandoff(state, { taskId: task.id }, now);
    const openHelp = Object.values(state.help)
      .filter((h) => h.taskId === task.id && (h.state === 'offered' || h.state === 'accepted'))
      .map(publicHelp);
    const proposals = Object.values(state.proposals)
      .filter((p) => p.taskIds.includes(task.id))
      .map((p) => ({ id: p.id, revision: p.revision, lifecycle: p.lifecycle, head: p.head }));
    const expiredLease =
      assignment !== undefined && assignment.status === 'active' && assignment.leaseExpiresAt <= now;
    body.task = {
      id: task.id,
      revision: task.revision,
      goal: task.goal,
      acceptanceCriteria: task.acceptanceCriteria,
      lifecycle: task.lifecycle,
      currentAssignmentId: task.currentAssignmentId,
      resultRefs: task.resultRefs,
      nextAction: task.nextAction,
      dependencies: task.dependencies.map((d) => ({
        taskId: d.taskId,
        kind: d.kind,
        goal: state.tasks[d.taskId]?.goal,
        lifecycle: state.tasks[d.taskId]?.lifecycle,
      })),
    };
    body.assignment = assignment
      ? { ...publicAssignment(assignment), epochState: assignmentEpochState(assignment, now) }
      : null;
    body.handoff = handoff
      ? {
          ...publicHandoff(handoff),
          epochLabel,
          markdown: renderHandoffMarkdown(handoff, {
            projectId: state.project.id,
            epochLabel,
            taskGoal: task.goal,
          }),
        }
      : null;
    body.openHelp = openHelp;
    body.proposals = proposals;
    body.uncertainty = expiredLease
      ? 'assignment lease expired without reclaim; ownership freshness is uncertain'
      : assignment === undefined
        ? 'task has no current assignment'
        : null;
    body.sourceRefs = [
      `tasks/${task.id}`,
      ...(handoff ? [`handoffs/${handoff.id}`] : []),
      ...proposals.map((p) => `proposals/${p.id}`),
    ];
  } else {
    const open = Object.values(state.tasks).filter((t) => t.lifecycle !== 'done' && t.lifecycle !== 'cancelled');
    const openHelp = Object.values(state.help).filter((h) => h.state === 'offered' || h.state === 'accepted');
    body.summary = {
      tasks: { total: Object.keys(state.tasks).length, open: open.length },
      openHelp: openHelp.length,
      assignments: Object.values(state.assignments).filter((a) => a.status === 'active').length,
    };
    body.nextActions = open
      .filter((t) => t.nextAction !== undefined)
      .map((t) => ({ taskId: t.id, nextAction: t.nextAction }));
    body.sourceRefs = ['project', 'tasks', 'help'];
  }
  return json(200, body);
}

/**
 * Shared own-addressed inbox read: scope/access re-checked, expired mail
 * labeled, delivery recorded for the returned page, resync marker on a
 * cursor gap. Used by the project-scoped GET /inbox and by the documented
 * global route handler below.
 */
async function readOwnInbox(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const after = url.searchParams.get('after');
  const limitParam = Number(url.searchParams.get('limit') ?? PAGE_LIMIT);
  const limit = Math.min(
    Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : PAGE_LIMIT,
    PAGE_LIMIT,
  );
  const result = await ctx.store.transact((draft) => {
    requireScope(ctx.principal, SCOPES.read, draft);
    const now = ctx.now();
    const mine = Object.values(draft.messages)
      .filter((m) => m.recipientId === ctx.principal.id)
      .sort(byCreated);
    // Expired queued mail is labeled expired and kept, never deleted.
    for (const m of mine) {
      if (m.delivery === 'queued' && m.expiresAt !== undefined && m.expiresAt <= now) {
        m.delivery = 'expired';
        touchEntity(m, ctx, ctx.principal.id);
      }
    }
    const { page, nextCursor, resync } = pageInbox(mine, after, limit);
    // GET records delivery for the returned page only. No launches.
    for (const m of page) {
      if (m.delivery === 'queued') {
        m.delivery = 'delivered';
        touchEntity(m, ctx, ctx.principal.id);
      }
    }
    return {
      messages: page.map(publicMessage),
      counts: inboxCounts(mine, now),
      nextCursor,
      resync,
      projectId: draft.project.id,
    };
  });
  return json(200, result);
}

/**
 * Documented global route handler for GET /api/v1/inbox?after=cursor —
 * the caller's own addressed projection over this store's project.
 * Semantics match the project-scoped GET: scope and project access are
 * re-checked (a principal without access gets the same 404 as an
 * unknown project, so mail is never revealed across project boundaries),
 * expired mail is labeled, page delivery is recorded, and nothing is
 * launched. Aggregation across multiple project stores stays with the
 * integrator, which routes this endpoint to this function per store.
 */
export function handleGlobalInbox(ctx: Context, request: Request): Promise<Response> {
  if (request.method.toUpperCase() !== 'GET') {
    fail(404, 'not_found', 'unknown route');
  }
  return readOwnInbox(ctx, request);
}

/** Root inbox across independently authorized project stores. */
export async function handleMultiProjectInbox(contexts: Context[], request: Request): Promise<Response> {
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit') ?? PAGE_LIMIT);
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : PAGE_LIMIT, PAGE_LIMIT);
  const mine: Message[] = [];
  for (const ctx of contexts) {
    const items = await ctx.store.transact(draft => {
      requireScope(ctx.principal, SCOPES.read, draft);
      const own = Object.values(draft.messages).filter(m => m.recipientId === ctx.principal.id);
      for (const m of own) if (m.delivery === 'queued' && m.expiresAt && m.expiresAt <= ctx.now()) {
        m.delivery = 'expired'; touchEntity(m, ctx, ctx.principal.id);
      }
      return own;
    });
    mine.push(...items);
  }
  mine.sort(byCreated);
  const { page, nextCursor, resync } = pageInbox(mine, url.searchParams.get('after'), limit);
  for (const ctx of contexts) await ctx.store.transact(draft => {
    requireScope(ctx.principal, SCOPES.read, draft);
    for (const selected of page) {
      const m = draft.messages[selected.id];
      if (m?.recipientId === ctx.principal.id && m.delivery === 'queued') {
        m.delivery = 'delivered'; touchEntity(m, ctx, ctx.principal.id);
        selected.delivery = m.delivery;
      }
    }
    return true;
  });
  return json(200, { messages: page.map(publicMessage), counts: inboxCounts(mine, contexts[0]?.now() ?? new Date().toISOString()), nextCursor, resync, projectIds: contexts.map(c => c.principal.projectIds).flat() });
}

async function listHelp(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const stateFilter = url.searchParams.get('state');
  const cursor = url.searchParams.get('cursor');
  const all = Object.values(state.help)
    .filter((h) => stateFilter === null || h.state === stateFilter)
    .sort(byCreated);
  let start = 0;
  let resync = false;
  if (cursor !== null) {
    const idx = all.findIndex((h) => h.id === cursor);
    if (idx < 0) resync = true;
    else start = idx + 1;
  }
  const page = all.slice(start, start + PAGE_LIMIT);
  return json(200, {
    help: page.map(publicHelp),
    count: page.length,
    total: all.length,
    nextCursor: start + PAGE_LIMIT < all.length && page.length > 0 ? page[page.length - 1].id : null,
    resync,
  });
}

async function getHelp(ctx: Context, helpId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const help = entity<HelpRequest>(state, 'help', helpId);
  return json(200, { help: publicHelp(help) });
}

async function listHandoffs(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const taskId = url.searchParams.get('taskId') ?? undefined;
  const assignmentId = url.searchParams.get('assignmentId') ?? undefined;
  const now = ctx.now();
  const all = Object.values(state.handoffs)
    .filter((h) =>
      (taskId === undefined || h.taskId === taskId) &&
      (assignmentId === undefined || h.assignmentId === assignmentId))
    .sort(byCreated);
  const page = all.slice(0, PAGE_LIMIT).map((h) => ({
    ...publicHandoff(h),
    epochLabel: handoffEpochLabel(state, h, now),
  }));
  return json(200, { handoffs: page, count: page.length });
}

// -------------------------------------------------------------- writes --

async function ownMessageOr404(ctx: Context, messageId: Id): Promise<void> {
  // Cheap pre-read: recipientId is immutable, so a miss here means the
  // caller gets the same 404 whether or not the message exists — other
  // inboxes are never revealed, whatever revision was guessed.
  const state = await ctx.store.read();
  const m = state.messages[messageId];
  if (!m || m.recipientId !== ctx.principal.id) {
    fail(404, 'not_found', `messages/${messageId} does not exist`);
  }
}

async function ackMessage(ctx: Context, messageId: Id, body: Record<string, unknown>): Promise<Response> {
  await ownMessageOr404(ctx, messageId);
  return command(ctx, body, SCOPES.read, { collection: 'messages', id: messageId }, (draft) => {
    const msg = entity<Message>(draft, 'messages', messageId);
    if (msg.recipientId !== ctx.principal.id) {
      fail(404, 'not_found', `messages/${messageId} does not exist`);
    }
    if (msg.delivery === 'queued') msg.delivery = 'delivered';
    if (msg.readAt === undefined) msg.readAt = ctx.now();
    appendEvent(draft, ctx, 'message:ack', msg.id, { type: msg.type });
    return { status: 200, body: { message: publicMessage(msg) } };
  });
}

async function acceptMessage(ctx: Context, messageId: Id, body: Record<string, unknown>): Promise<Response> {
  // 'read' is the outer scope; per-type acceptance checks its own scope
  // inside apply so denials stay enumerated. A cheap pre-read keeps the
  // recipient check non-leaking; inside the transaction, dedupe resolves
  // before the message revision check, then expiry/recipient/assignment
  // are validated atomically.
  await ownMessageOr404(ctx, messageId);
  try {
    return await command(ctx, body, SCOPES.read, { collection: 'messages', id: messageId }, (draft) => {
    const msg = entity<Message & MessageExtras>(draft, 'messages', messageId);
    if (msg.recipientId !== ctx.principal.id) {
      fail(404, 'not_found', `messages/${messageId} does not exist`);
    }
    const now = ctx.now();
    if (msg.expiresAt !== undefined && msg.expiresAt <= now) {
      if (msg.delivery !== 'expired') {
        msg.delivery = 'expired';
        touchEntity(msg, ctx, ctx.principal.id);
      }
      fail(409, 'offer_expired', 'message has expired', {
        nextAction: 're-read the inbox and task for current state',
      });
    }
    if (msg.acceptedAt !== undefined) {
      fail(409, 'already_accepted', 'message was already accepted', {
        nextAction: 're-read the task and assignments for current state',
      });
    }

    if (msg.type === 'assignment-offer') {
      requireScope(ctx.principal, SCOPES.tasksClaim, draft);
      if (msg.taskId === undefined) fail(422, 'invalid_offer', 'offer is not task-linked');
      const task = entity<Task>(draft, 'tasks', msg.taskId);
      if (typeof body.taskRevision !== 'number') {
        fail(422, 'missing_field', 'taskRevision is required to accept an offer');
      }
      if (task.revision !== body.taskRevision) {
        fail(409, 'stale_task_revision',
          `task revision is ${task.revision}, expected ${body.taskRevision}`, {
            nextAction: 're-read the task and retry with the current revision',
          });
      }
      if (task.lifecycle === 'done' || task.lifecycle === 'cancelled') {
        fail(409, 'task_closed', `task is ${task.lifecycle}`);
      }
      const role = typeof msg.role === 'string' && msg.role.length > 0 ? msg.role : OWNER_ROLE;
      const active = Object.values(draft.assignments).filter(
        (a) => a.taskId === task.id && a.status === 'active',
      );
      if (role === OWNER_ROLE) {
        if (active.some((a) => a.role === OWNER_ROLE)) {
          fail(409, 'already_claimed', 'task already has an active owner', {
            nextAction: 'reclaim after lease expiry or accept a helper role',
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
        scopes: narrowToHeld(ctx.principal.scopes, msg.scopes),
      });
      if (role === OWNER_ROLE) {
        task.currentAssignmentId = assignment.id;
        task.lifecycle = 'claimed';
        task.nextAction = 'assignment accepted; submit changes through the assigned fork';
        touchEntity(task, ctx, ctx.principal.id);
      }
      msg.acceptedAt = now;
      appendEvent(draft, ctx, 'offer:accepted', msg.id, {
        taskId: task.id,
        assignmentId: assignment.id,
        role,
        epoch: assignment.epoch,
      });
      appendEvent(draft, ctx, 'task:claimed', task.id, {
        assignmentId: assignment.id,
        role,
        epoch: assignment.epoch,
        via: 'assignment-offer',
      });
      return {
        status: 201,
        body: {
          assignment: publicAssignment(assignment),
          task: {
            id: task.id, revision: task.revision, lifecycle: task.lifecycle,
            currentAssignmentId: task.currentAssignmentId,
          },
          message: publicMessage(msg),
        },
      };
    }

    if (msg.type === 'help-request') {
      if (msg.helpId === undefined) fail(422, 'invalid_message', 'help message has no linked request');
      const help = acceptHelpRecord(draft, ctx, msg.helpId);
      touchEntity(help, ctx, ctx.principal.id);
      msg.acceptedAt = now;
      return { status: 200, body: { help: publicHelp(help), message: publicMessage(msg) } };
    }

    if (msg.type === 'handoff' || msg.type === 'review-request' || msg.type === 'reply') {
      // Acknowledgment only. A handoff never transfers the assignment and a
      // review acceptance does not create the review itself.
      msg.acceptedAt = now;
      if (msg.type === 'handoff' && msg.handoffId !== undefined) {
        // Receiver acceptance is recorded on the handoff record itself, so
        // briefs and handoff lists can tell a merely delivered handoff from
        // an acknowledged one. The assignment is still untouched.
        const handoff = draft.handoffs[msg.handoffId];
        if (handoff !== undefined && handoff.acceptedById === undefined) {
          handoff.acceptedById = ctx.principal.id;
          touchEntity(handoff, ctx, ctx.principal.id);
        }
      }
      appendEvent(draft, ctx, `message:${msg.type}-acknowledged`, msg.id, {
        taskId: msg.taskId,
        ...(msg.handoffId !== undefined ? { handoffId: msg.handoffId } : {}),
      });
      return {
        status: 200,
        body: {
          message: publicMessage(msg),
          outcome: 'acknowledged',
          note: 'no assignment or ownership changed by accepting this message',
        },
      };
    }

    fail(422, 'not_acceptable', `message type "${msg.type}" cannot be accepted`);
  });
  } catch (err) {
    // An expired message keeps its expired label even though the rejecting
    // command rolled back: delivery is a projection, so we mark it in a
    // separate small transaction after the failure.
    if (err instanceof ApiError && err.code === 'offer_expired') {
      await ctx.store.transact((draft) => {
        const m = draft.messages[messageId];
        if (m && m.recipientId === ctx.principal.id && m.delivery !== 'expired') {
          m.delivery = 'expired';
          touchEntity(m, ctx, ctx.principal.id);
        }
        return true;
      });
    }
    throw err;
  }
}

async function replyMessage(ctx: Context, messageId: Id, body: Record<string, unknown>): Promise<Response> {
  await ownMessageOr404(ctx, messageId);
  return command(ctx, body, SCOPES.inboxWrite, { collection: 'messages' }, (draft) => {
    const orig = entity<Message & MessageExtras>(draft, 'messages', messageId);
    if (orig.recipientId !== ctx.principal.id) {
      fail(404, 'not_found', `messages/${messageId} does not exist`);
    }
    requireFields(body, ['text']);
    const text = requireProse(body.text, 'text');
    const toId = assertAddressable(draft, orig.senderId);
    if (toId === ctx.principal.id) {
      fail(422, 'invalid_field', 'cannot reply to a message from yourself');
    }
    const dup = findDeduped(draft, toId, body.dedupeKey);
    if (dup) return { status: 200, body: { message: publicMessage(dup), deduplicated: true } };
    checkRecipientQuota(draft, toId, ctx.now());
    // Task-linked threading only: the reply keeps the original task/candidate
    // and help linkage. There is no open social send in this slice.
    const reply = newMessage(draft, ctx, {
      recipientId: toId,
      type: 'reply',
      body: text,
      taskId: orig.taskId,
      candidateId: orig.candidateId,
      dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : undefined,
      extras: {
        helpId: orig.helpId,
        threadId: orig.threadId ?? orig.id,
      },
    });
    appendEvent(draft, ctx, 'message:reply', reply.id, {
      inReplyTo: orig.id,
      taskId: reply.taskId,
      recipientId: toId,
    });
    return { status: 201, body: { message: publicMessage(reply) } };
  });
}

function offerAssignment(ctx: Context, taskId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.offersWrite, { collection: 'messages' }, (draft) => {
    const task = entity<Task>(draft, 'tasks', taskId);
    if (task.lifecycle === 'done' || task.lifecycle === 'cancelled') {
      fail(409, 'task_closed', `task is ${task.lifecycle}`);
    }
    const toId = assertAddressable(draft, body.toId);
    if (toId === ctx.principal.id) {
      fail(422, 'invalid_field', 'cannot send an assignment offer to yourself');
    }
    const role =
      body.role === undefined ? OWNER_ROLE : requireProse(body.role, 'role', MAX_ROLE_CHARS);
    let scopes: string[] | undefined;
    if (body.scopes !== undefined) {
      if (!Array.isArray(body.scopes)) fail(422, 'invalid_field', 'scopes must be an array');
      scopes = body.scopes.map((s) => {
        if (typeof s !== 'string' || s.length === 0 || s.length > 128) {
          fail(422, 'invalid_field', 'invalid scope entry');
        }
        return s;
      });
    }
    const dup = findDeduped(draft, toId, body.dedupeKey);
    if (dup) return { status: 200, body: { message: publicMessage(dup), deduplicated: true } };
    checkRecipientQuota(draft, toId, ctx.now());
    const expiresAt =
      optionalExpiry(draft, ctx, body, MAX_OFFER_TTL_MS) ??
      new Date(Date.parse(ctx.now()) + DEFAULT_OFFER_TTL_MS).toISOString();
    const note = body.note === undefined ? `assignment offer for task ${task.id}` : requireProse(body.note, 'note');
    const msg = newMessage(draft, ctx, {
      recipientId: toId,
      type: 'assignment-offer',
      body: note,
      taskId: task.id,
      expiresAt,
      dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : undefined,
      extras: { role, scopes },
    });
    appendEvent(draft, ctx, 'offer:sent', msg.id, {
      taskId: task.id,
      recipientId: toId,
      role,
      expiresAt,
    });
    return { status: 201, body: { message: publicMessage(msg), taskId: task.id } };
  });
}

function askHelp(ctx: Context, taskId: Id | undefined, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.helpWrite, { collection: 'help' }, (draft) => {
    // A project-level help request (no taskId) is a general question to the
    // crew; a task-bound request also names its task.
    const task = taskId === undefined ? undefined : entity<Task>(draft, 'tasks', taskId);
    requireFields(body, ['question']);
    const question = requireProse(body.question, 'question');
    const expectedContribution =
      body.expectedContribution === undefined
        ? undefined
        : requireProse(body.expectedContribution, 'expectedContribution');
    let candidateId: Id | undefined;
    if (body.candidateId !== undefined) {
      if (typeof body.candidateId !== 'string') fail(422, 'invalid_field', 'candidateId must be a string');
      entity(draft, 'candidates', body.candidateId);
      candidateId = body.candidateId;
    }
    const toId = body.toId === undefined ? undefined : assertAddressable(draft, body.toId);
    if (toId !== undefined) checkRecipientQuota(draft, toId, ctx.now());
    const expiresAt = optionalExpiry(draft, ctx, body, MAX_HELP_TTL_MS);
    const now = ctx.now();
    const help: HelpRequest = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      ...(task !== undefined ? { taskId: task.id } : {}),
      ...(candidateId !== undefined ? { candidateId } : {}),
      question,
      ...(expectedContribution !== undefined ? { expectedContribution } : {}),
      offeredById: ctx.principal.id,
      state: 'offered',
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    draft.help[help.id] = help;
    let msg: Message | undefined;
    if (toId !== undefined) {
      // Help delivery is a notification, not a launch or an acceptance.
      msg = newMessage(draft, ctx, {
        recipientId: toId,
        type: 'help-request',
        body: question,
        ...(task !== undefined ? { taskId: task.id } : {}),
        candidateId,
        expiresAt,
        dedupeKey: typeof body.dedupeKey === 'string' ? body.dedupeKey : undefined,
        extras: { helpId: help.id },
      });
    }
    appendEvent(draft, ctx, 'help:offered', help.id, {
      ...(task !== undefined ? { taskId: task.id } : {}),
      toId,
      messageId: msg?.id,
    });
    return {
      status: 201,
      body: { help: publicHelp(help), ...(msg ? { message: publicMessage(msg) } : {}) },
    };
  });
}

/**
 * A help request delivered to named recipients through the inbox can only
 * be accepted by an addressed recipient (or an admin). Broadcast requests
 * — no linked help-request message — stay open to any helper.
 */
function assertHelpAddressedToCaller(draft: ProjectState, ctx: Context, help: HelpRequest): void {
  const directedTo = new Set(
    Object.values(draft.messages)
      .filter((m) => (m as Message & MessageExtras).helpId === help.id && m.type === 'help-request')
      .map((m) => m.recipientId),
  );
  if (
    directedTo.size > 0 &&
    !directedTo.has(ctx.principal.id) &&
    ctx.principal.kind !== 'system' &&
    !ctx.principal.scopes.includes('admin')
  ) {
    fail(403, 'scope_denied', 'this help request was directed to another recipient', {
      nextAction: 'let the addressed recipient respond, or ask the requester to broadcast it',
    });
  }
}

/** Shared accept logic for /help/:id/accept and help-request inbox accepts. */
function acceptHelpRecord(draft: ProjectState, ctx: Context, helpId: Id): HelpRequest {
  requireScope(ctx.principal, SCOPES.helpWrite, draft);
  const help = entity<HelpRequest>(draft, 'help', helpId);
  assertHelpAddressedToCaller(draft, ctx, help);
  const now = ctx.now();
  if (help.expiresAt !== undefined && help.expiresAt <= now) {
    help.state = 'expired';
    fail(409, 'help_expired', 'help request has expired');
  }
  if (help.state !== 'offered') {
    fail(409, 'help_not_open', `help request is ${help.state}`);
  }
  help.acceptedById = ctx.principal.id;
  help.state = 'accepted';
  // No touchEntity here: the caller bumps appropriately (command() bumps
  // the help target; the inbox path touches explicitly since help is not
  // the command target there).
  appendEvent(draft, ctx, 'help:accepted', help.id, { acceptedById: ctx.principal.id });
  return help;
}

function acceptHelp(ctx: Context, helpId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.read, { collection: 'help', id: helpId }, (draft) => {
    const help = acceptHelpRecord(draft, ctx, helpId);
    // Mark the linked inbox copy accepted in the same transaction.
    const msg = findLinkedMessage(draft, help.id, ctx.principal.id);
    if (msg && msg.acceptedAt === undefined) {
      msg.acceptedAt = ctx.now();
      touchEntity(msg, ctx, ctx.principal.id);
    }
    return {
      status: 200,
      body: {
        help: publicHelp(help),
        ...(msg ? { message: publicMessage(msg) } : {}),
        note: 'acceptance does not launch the helper; work starts by explicit pickup',
      },
    };
  });
}

function answerHelp(ctx: Context, helpId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.helpWrite, { collection: 'help', id: helpId }, (draft) => {
    const help = entity<HelpRequest>(draft, 'help', helpId);
    requireFields(body, ['answer']);
    const answer = requireProse(body.answer, 'answer');
    const now = ctx.now();
    if (help.state === 'offered') {
      assertHelpAddressedToCaller(draft, ctx, help);
      if (help.expiresAt !== undefined && help.expiresAt <= now) {
        help.state = 'expired';
        fail(409, 'help_expired', 'help request has expired');
      }
      // Answering an open request implies accepting it, in one transaction.
      help.acceptedById = ctx.principal.id;
      appendEvent(draft, ctx, 'help:accepted', help.id, { acceptedById: ctx.principal.id, via: 'answer' });
    } else if (help.state !== 'accepted') {
      fail(409, 'help_not_open', `help request is ${help.state}`);
    } else if (
      help.acceptedById !== ctx.principal.id &&
      ctx.principal.kind !== 'system' &&
      !ctx.principal.scopes.includes('admin')
    ) {
      fail(403, 'scope_denied', 'only the accepter may answer this request');
    }
    help.answer = answer;
    help.state = 'answered';
    // command() bumps the help target revision.
    // Notify the asker through their inbox; failure to read later leaves the
    // durable help record answered regardless.
    let reply: Message | undefined;
    if (help.offeredById !== ctx.principal.id && recipientOk(draft, help.offeredById)) {
      checkRecipientQuota(draft, help.offeredById, now);
      reply = newMessage(draft, ctx, {
        recipientId: help.offeredById,
        type: 'reply',
        body: answer,
        taskId: help.taskId,
        candidateId: help.candidateId,
        extras: { helpId: help.id },
      });
    }
    const linked = Object.values(draft.messages).filter(
      (m) => (m as Message & MessageExtras).helpId === help.id && m.type === 'help-request',
    );
    for (const m of linked) {
      if (m.answeredAt === undefined) {
        m.answeredAt = now;
        touchEntity(m, ctx, ctx.principal.id);
      }
    }
    appendEvent(draft, ctx, 'help:answered', help.id, {
      answeredById: ctx.principal.id,
      replyMessageId: reply?.id,
    });
    return {
      status: 200,
      body: {
        help: publicHelp(help),
        ...(reply ? { reply: publicMessage(reply) } : {}),
      },
    };
  });
}

function withdrawHelp(ctx: Context, helpId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.helpWrite, { collection: 'help', id: helpId }, (draft) => {
    const help = entity<HelpRequest>(draft, 'help', helpId);
    const isAdmin =
      ctx.principal.kind === 'system' || ctx.principal.scopes.includes('admin');
    if (help.offeredById !== ctx.principal.id && !isAdmin) {
      fail(403, 'scope_denied', 'only the asker or an admin may withdraw');
    }
    if (help.state === 'answered' || help.state === 'withdrawn') {
      fail(409, 'help_closed', `help request is ${help.state}`);
    }
    help.state = 'withdrawn';
    appendEvent(draft, ctx, 'help:withdrawn', help.id, {});
    return { status: 200, body: { help: publicHelp(help) } };
  });
}

function recordHandoff(
  ctx: Context,
  assignmentId: Id,
  body: Record<string, unknown>,
): Promise<Response> {
  return command(ctx, body, SCOPES.read, { collection: 'assignments', id: assignmentId }, (draft) => {
    const a = entity<Assignment>(draft, 'assignments', assignmentId);
    assertHolder(ctx, a, 'record a handoff');
    if(ctx.principal.kind==='agent' && !ctx.principal.scopes.includes('admin') && !ctx.principal.scopes.includes('assignments:write') && a.sessionId && a.sessionId!==ctx.principal.sessionId) {
      fail(403,'session_mismatch','Only the session holding this assignment may record its handoff');
    }
    if(draft.project.adoptedPlanRevisionId && body.planRevisionId!==draft.project.adoptedPlanRevisionId)fail(409,'stale_plan','Re-read the current context brief before handing off');
    if (typeof body.assignmentEpoch !== 'number') {
      fail(422, 'missing_epoch', 'assignmentEpoch is required when acting under a claim');
    }
    requireFields(body, ['done', 'next']);
    const fields = {
      done: requireProse(body.done, 'done'),
      next: requireProse(body.next, 'next'),
      uncertain: body.uncertain === undefined ? '' : requireProse(body.uncertain, 'uncertain'),
      verifyFirst: body.verifyFirst === undefined ? '' : requireProse(body.verifyFirst, 'verifyFirst'),
      doNotRepeat: body.doNotRepeat === undefined ? '' : requireProse(body.doNotRepeat, 'doNotRepeat'),
    };
    let epochState: 'current' | 'expired-unreclaimed';
    try {
      ({ epochState } = assertAssignmentEpoch(draft, {
        assignmentId: a.id,
        epoch: body.assignmentEpoch,
        now: ctx.now(),
      }));
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'epoch_reclaimed' || err.code === 'stale_epoch')
      ) {
        // The epoch ended before this handoff landed: preserve it as late
        // output in the SAME transaction so it is neither applied to the
        // current owner nor lost.
        const lo = preserveLateOutput(draft, ctx, {
          assignmentId: a.id,
          taskId: a.taskId,
          epoch: body.assignmentEpoch,
          kind: 'handoff',
          note: `handoff rejected: ${err.code}`,
        });
        return {
          status: 200,
          body: {
            outcome: 'late-output',
            reason: err.code,
            lateOutputId: lo.id,
            note: 'handoff was not recorded against the current assignment epoch',
          },
        };
      }
      throw err;
    }
    const toId = body.toId === undefined ? undefined : assertAddressable(draft, body.toId);
    if (toId !== undefined) checkRecipientQuota(draft, toId, ctx.now());
    const now = ctx.now();
    const handoff: Handoff = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      taskId: a.taskId,
      assignmentId: a.id,
      fromId: ctx.principal.id,
      ...(toId !== undefined ? { toId } : {}),
      ...fields,
      planRevisionId: draft.project.adoptedPlanRevisionId??null,
      epoch: a.epoch,
    };
    draft.handoffs[handoff.id] = handoff;
    let msg: Message | undefined;
    if (toId !== undefined) {
      // Handoff delivery never transfers the assignment; the receiver's
      // acceptance is a separate acknowledgment.
      msg = newMessage(draft, ctx, {
        recipientId: toId,
        type: 'handoff',
        body: `handoff on ${a.taskId}: ${fields.next}`.slice(0, 1000),
        taskId: a.taskId,
        extras: { handoffId: handoff.id },
      });
    }
    appendEvent(draft, ctx, 'handoff:recorded', handoff.id, {
      assignmentId: a.id,
      taskId: a.taskId,
      epoch: a.epoch,
      epochState,
      toId,
      messageId: msg?.id,
    });
    return {
      status: 201,
      body: {
        handoff: publicHandoff(handoff),
        epochState,
        ...(msg ? { message: publicMessage(msg) } : {}),
      },
    };
  });
}

// ------------------------------------------------------------ workspace --

interface WorkspacePhaseOne {
  kind: 'fresh' | 'resume' | 'done';
  result?: { status: number; body: unknown };
  repository?: RepositoryMapping;
  repoKey?: string;
}

const SECRETISH = /token|secret|credential|password|private[-_]?key/i;

/** Flat fork metadata minus anything that smells like a credential. */
function cleanMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRETISH.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

/**
 * POST /assignments/:id/workspace — open (or recover) the claimed fork.
 *
 * Two-phase durable operation: phase one validates scope/holder/current
 * epoch and reserves the operation intent (effect 'dispatching'); the
 * Artifacts fork/token calls run OUTSIDE any transaction; phase two stores
 * the credential-free result. A replay with the same operationId+digest
 * returns the stored result, a stored 'dispatching'/'failed-no-effect'
 * operation resumes the exact operation instead of duplicating it. The
 * token plaintext leaves only in the fresh response envelope — the stored
 * result records tokenIssued and never the secret.
 */
async function openWorkspace(
  ctx: Context,
  assignmentId: Id,
  body: Record<string, unknown>,
): Promise<Response> {
  if (typeof body.operationId !== 'string' || body.operationId.length === 0) {
    fail(422, 'missing_operation', 'operationId is required for write operations');
  }
  const operationId = body.operationId;
  const scope = SCOPES.workspaceWrite;
  const target = { collection: 'assignments' as const, id: assignmentId };
  const digest = await digestOf({ scope, target, body });

  if (!ctx.artifacts || typeof ctx.artifacts.fork !== 'function') {
    fail(503, 'dependency_unavailable', 'artifacts service is not available', {
      nextAction: 'retry when the artifacts binding is configured',
    });
  }
  const artifacts = ctx.artifacts;

  const phase1 = await ctx.store.transact((draft): WorkspacePhaseOne => {
    requireScope(ctx.principal, scope, draft);
    const prior = draft.operations[operationId] as Operation | undefined;
    if (prior) {
      if (prior.importedUnverified) fail(409, 'imported_operation', 'archived operations cannot be replayed or resumed; use a new operationId for current work');
      if (prior.digest !== digest) {
        fail(409, 'conflicting_operation', 'operationId reused with a different payload', {
          nextAction: 'use a new operationId',
        });
      }
      if (prior.result) {
        return { kind: 'done', result: prior.result as { status: number; body: unknown } };
      }
      // Resume the exact recorded operation — but only for the assignment
      // holder (or admin). The response mints a fresh scoped token, so the
      // same holder gate as a fresh open must pass again before any
      // external effect is attempted.
      const held = entity<Assignment>(draft, 'assignments', assignmentId);
      assertHolder(ctx, held, 'resume a workspace operation');
      if (typeof body.expectedRevision !== 'number') {
        fail(422, 'missing_revision', 'expectedRevision is required for entity-targeted writes');
      }
      if (typeof body.assignmentEpoch !== 'number') {
        fail(422, 'missing_epoch', 'assignmentEpoch is required when acting under a claim');
      }
      // The claim must still be live: minting a token on a reclaimed or
      // expired assignment would bypass the same gates a fresh open has.
      const { epochState } = assertAssignmentEpoch(draft, {
        assignmentId: held.id,
        epoch: body.assignmentEpoch,
        now: ctx.now(),
      });
      if (epochState !== 'current') {
        fail(409, 'lease_expired', 'assignment lease expired; a new fork needs a live claim', {
          nextAction: 'renew or reclaim the assignment, then retry with the current epoch',
        });
      }
      assertRevision(held, body.expectedRevision);
      // Recover its repository from the persisted intent (or the current
      // canonical mapping) so a replay never retargets a different repo
      // silently.
      const savedKey = (prior as Operation & { repoKey?: string }).repoKey;
      const repos = draft.project.repositories;
      const key =
        savedKey !== undefined && repos[savedKey] !== undefined
          ? savedKey
          : Object.keys(repos).find((k) => repos[k].role === 'canonical') ?? Object.keys(repos)[0];
      return {
        kind: 'resume',
        repository: key !== undefined ? repos[key] : undefined,
        repoKey: key,
      };
    }
    const a = entity<Assignment>(draft, 'assignments', assignmentId);
    assertHolder(ctx, a, 'open a workspace');
    if (typeof body.expectedRevision !== 'number') {
      fail(422, 'missing_revision', 'expectedRevision is required for entity-targeted writes');
    }
    const expectedRevision = body.expectedRevision;
    if (typeof body.assignmentEpoch !== 'number') {
      fail(422, 'missing_epoch', 'assignmentEpoch is required when acting under a claim');
    }
    const { epochState } = assertAssignmentEpoch(draft, {
      assignmentId: a.id,
      epoch: body.assignmentEpoch,
      now: ctx.now(),
    });
    if (epochState !== 'current') {
      fail(409, 'lease_expired', 'assignment lease expired; a new fork needs a live claim', {
        nextAction: 'renew or reclaim the assignment, then retry with the current epoch',
      });
    }
    assertRevision(a, expectedRevision);
    const repos = draft.project.repositories;
    const repoKey =
      typeof body.repository === 'string'
        ? body.repository
        : Object.keys(repos).find((k) => repos[k].role === 'canonical') ?? Object.keys(repos)[0];
    if (repoKey === undefined || repos[repoKey] === undefined) {
      fail(422, 'no_repository', 'project has no repository mapping to fork');
    }
    const now = ctx.now();
    draft.operations[operationId] = {
      id: operationId,
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      scope,
      target,
      digest,
      expectedRevision: body.expectedRevision as number,
      intent: 'open-workspace-fork',
      effect: 'dispatching',
      repoKey,
    } as Operation & { repoKey: string };
    appendEvent(draft, ctx, 'workspace:dispatching', assignmentId, { operationId, repoKey });
    return { kind: 'fresh', repository: repos[repoKey], repoKey };
  });

  if (phase1.kind === 'done' && phase1.result) {
    return json(phase1.result.status, phase1.result.body);
  }

  // External work happens here, outside any transaction.
  if (phase1.repository === undefined) {
    // Repository mapping disappeared before dispatch.
    await ctx.store.transact((draft) => {
      const prior = draft.operations[operationId];
      if (prior && !prior.result) {
        prior.effect = 'failed-no-effect';
        prior.reconciliation = 'repository mapping unavailable';
        touchEntity(prior, ctx, ctx.principal.id);
        appendEvent(draft, ctx, 'workspace:failed', assignmentId, {
          operationId,
          reason: 'repository mapping unavailable',
        });
      }
      return true;
    });
    fail(503, 'dependency_unavailable', 'repository mapping unavailable for workspace fork');
  }
  const repo = phase1.repository as RepositoryMapping;
  const repoId =
    typeof (repo as unknown as Record<string, unknown>).repositoryId === 'string'
      ? String((repo as unknown as Record<string, unknown>).repositoryId)
      : repo.remote;
  let fork: Record<string, unknown> | undefined;
  let token: { plaintext: string; expiresAt: IsoTime } | undefined;
  let extError: string | undefined;
  try {
    fork = await artifacts.fork(repoId, `assignment-${assignmentId}`);
    const forkMeta = (typeof fork.repo === 'object' && fork.repo !== null ? fork.repo : fork) as Record<string, unknown>;
    const forkId = String(forkMeta.repositoryId ?? forkMeta.id ?? forkMeta.name ?? assignmentId);
    const forkToken = fork.token as { plaintext?: unknown; expiresAt?: unknown } | null | undefined;
    if (typeof forkToken?.plaintext === 'string' && typeof forkToken.expiresAt === 'string') {
      token = { plaintext: forkToken.plaintext, expiresAt: forkToken.expiresAt };
    }
    if (token === undefined && typeof artifacts.createToken === 'function') {
      const ttlParam = body.tokenTtlSeconds;
      const ttl =
        typeof ttlParam === 'number' && Number.isFinite(ttlParam) && ttlParam > 0
          ? Math.min(Math.floor(ttlParam), 3600)
          : WORKSPACE_TOKEN_TTL_SECONDS;
      token = await artifacts.createToken({
        repositoryId: forkId,
        permissions: ['fork:read', 'fork:write'],
        expiresInSeconds: ttl,
      });
    }
  } catch (err) {
    extError = err instanceof Error ? err.message : 'artifacts call failed';
  }

  const final = await ctx.store.transact((draft): { status: number; body: Record<string, unknown> } => {
    const prior = draft.operations[operationId] as Operation | undefined;
    if (!prior || prior.digest !== digest) {
      fail(409, 'conflicting_operation', 'operation record changed during dispatch');
    }
    if (prior.result) {
      return prior.result as { status: number; body: Record<string, unknown> };
    }
    const now = ctx.now();
    if (extError !== undefined) {
      prior.effect = 'failed-no-effect';
      prior.reconciliation = extError.slice(0, 500);
      touchEntity(prior, ctx, ctx.principal.id);
      appendEvent(draft, ctx, 'workspace:failed', assignmentId, {
        operationId,
        reason: extError.slice(0, 200),
      });
      return {
        status: 503,
        body: {
          error: {
            status: 503,
            code: 'dependency_unavailable',
            message: 'workspace fork could not be created',
            retryable: true,
            nextAction: `operation ${operationId} recorded failed-no-effect; retry the same operationId to resume`,
          },
          operationId,
        },
      };
    }
    const a = entity<Assignment>(draft, 'assignments', assignmentId);
    if (
      a.status !== 'active' ||
      a.epoch !== (body.assignmentEpoch as number)
    ) {
      // The claim moved while the fork was being created: do not attach the
      // new fork to a dead epoch. The created remote fork is left to the
      // fork provider's own cleanup; nothing about it is stored as ours.
      prior.effect = 'failed-no-effect';
      prior.reconciliation = 'assignment epoch moved during dispatch';
      touchEntity(prior, ctx, ctx.principal.id);
      appendEvent(draft, ctx, 'workspace:epoch-moved', assignmentId, { operationId });
      return {
        status: 409,
        body: {
          error: {
            status: 409,
            code: 'epoch_moved',
            message: 'assignment epoch moved while the fork was being created',
            retryable: false,
            nextAction: 're-read the assignment and open the workspace under the current epoch',
          },
          operationId,
        },
      };
    }
    const rawMeta = (typeof fork?.repo === 'object' && fork.repo !== null ? fork.repo : fork) as Record<string, unknown>;
    const meta = cleanMetadata(rawMeta);
    const forkId = String(
      rawMeta.repositoryId ?? rawMeta.id ?? rawMeta.name ??
        a.forkRef ??
        ctx.uid(),
    );
    a.forkRef = forkId;
    touchEntity(a, ctx, ctx.principal.id);
    const { handoff, epochLabel } = latestHandoff(draft, { assignmentId: a.id }, now);
    const task = a.taskId !== undefined ? draft.tasks[a.taskId] : undefined;
    const workspace: Record<string, unknown> = {
      assignmentId: a.id,
      epoch: a.epoch,
      forkRef: forkId,
      repositoryKey: phase1.repoKey,
      remote: typeof meta.remote === 'string' ? meta.remote : undefined,
      metadata: meta,
      // Generated HANDOFF.md content for the checkout; ignored, never
      // committed as product source.
      handoffMarkdown: handoff
        ? renderHandoffMarkdown(handoff, {
            projectId: draft.project.id,
            epochLabel,
            taskGoal: task?.goal,
          })
        : undefined,
      tokenIssued: token !== undefined,
    };
    prior.effect = 'confirmed';
    prior.result = { status: 200, body: { workspace } };
    touchEntity(prior, ctx, ctx.principal.id);
    appendEvent(draft, ctx, 'workspace:opened', a.id, {
      operationId,
      forkRef: forkId,
      repositoryKey: phase1.repoKey,
      epoch: a.epoch,
    });
    return prior.result as { status: number; body: Record<string, unknown> };
  });

  const responseBody = { ...(final.body as Record<string, unknown>) };
  if (final.status === 200 && token !== undefined) {
    // Separate short-lived scoped authentication envelope: returned once to
    // the owning client, never persisted in state/results/exports/logs.
    responseBody.token = { plaintext: token.plaintext, expiresAt: token.expiresAt };
  }
  return json(final.status, responseBody);
}

// ------------------------------------------------------------- dispatch --

/**
 * Module handler for inbox/help/handoff/workspace endpoints. Segments are
 * the suffix after /api/v1/projects/:projectId. Returns null only for
 * routes this module does not own.
 */
export async function handleInbox(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (method === 'GET' && segments.length === 1 && segments[0] === 'brief') {
    return getBrief(ctx, request);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'inbox') {
    return readOwnInbox(ctx, request);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'inbox' && segments[2] === 'ack' && body) {
    return ackMessage(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'inbox' && segments[2] === 'accept' && body) {
    return acceptMessage(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'inbox' && segments[2] === 'reply' && body) {
    return replyMessage(ctx, segments[1], body);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'help') {
    return listHelp(ctx, request);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'help') {
    return getHelp(ctx, segments[1]);
  }
  // Project-level help: the toolbar asks the crew without naming a task.
  if (method === 'POST' && segments.length === 1 && segments[0] === 'help' && body) {
    return askHelp(ctx, undefined, body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'help' && segments[2] === 'accept' && body) {
    return acceptHelp(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'help' && segments[2] === 'answer' && body) {
    return answerHelp(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'help' && segments[2] === 'withdraw' && body) {
    return withdrawHelp(ctx, segments[1], body);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'handoffs') {
    return listHandoffs(ctx, request);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'help' && body) {
    return askHelp(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'tasks' && segments[2] === 'offers' && body) {
    return offerAssignment(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'assignments' && segments[2] === 'handoff' && body) {
    return recordHandoff(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'assignments' && segments[2] === 'workspace' && body) {
    return openWorkspace(ctx, segments[1], body);
  }
  return null;
}

/** At most one body-free notice for a conversation/member; a full inbox never blocks chat. */
export function conversationNotice(draft:ProjectState,ctx:Pick<Context,'principal'|'now'|'uid'>,conversationId:string,recipientId:string,messageRef:{id:string;digest:string}){
 const key='conversation:'+conversationId+':'+recipientId;
 if(findDeduped(draft,recipientId,key)||!recipientOk(draft,recipientId))return;
 try{checkRecipientQuota(draft,recipientId,ctx.now());}catch{return;}
 const notice=newMessage(draft,ctx,{recipientId,type:'system-notice',body:'You were mentioned in a project conversation. Open the authorized thread to read it.',dedupeKey:key});
 notice.conversationId=conversationId;notice.messageRef=messageRef;
}
