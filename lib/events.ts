// Event cursor, scoped metrics, bounded Bug Eater planning and
// export/restore for the Together slice (seat b-swe-09).
//
// Owned endpoints (segments after /api/v1/projects/:projectId):
//   GET  events?after=<seq>&limit=<n>&type=<t>   cursor replay + resync marker
//   GET  operations/:id                        durable operation lookup
//   GET  metrics?window=<minutes>              scoped stat strip
//   GET  export                                credential-free export document
//   POST restore                               validated restore via command()
//
// Event/cursor contract (spec "Cursor-based events", amendment 7):
// - Events carry a monotonic per-project seq assigned by appendEvent();
//   `after` is the last seq the caller saw. Reconnect replays seq > after.
// - A cursor ahead of the durable log (restored/rebuilt store) or one that
//   names a missing seq returns {resync:true, reason} -- the caller must
//   re-read the full projection instead of trusting incremental replay.
// - Delivery is at-least-once: ids are deduplicated defensively and a
//   duplicate/out-of-order log entry can never inflate metrics.
//
// Metric conventions (spec "Statistics and personality", amendment 11):
// - 'commit:observed' events record {sha, role:'canonical'|'fork',
//   baseline?, reachable?} with the SERVER observation time on the event;
//   source timestamps inside detail are data, never the ordering key.
//   Baseline/imported observations are excluded from "Commits received".
// - 'integration:confirmed' events record {operationId, candidateSha,
//   newLanding}. Only newLanding===true counts; dedupe is by sha AND
//   operationId so a retried or reconciled push cannot double-count.
// - Human interventions are events with actorKind 'human' and a
//   humanCategory (approve/relay/tie-break/correction/other).
// - Zero and unknown stay distinct: a metric with no observation source
//   reports value null + unknown:true, not 0.
//
// Export/restore: exports strip all credentials, invitations and every
// credential hash (tokenHash/collectorTokenHash) recursively. Restore
// preserves the live object's private auth records, keeps server-managed
// project configuration (mode, canonicalRef, resourceLimits, repositories,
// acceptancePolicyRevision) from the live record rather than imported
// text, and refuses any document that carries private fields or a foreign
// project id. Derived records are also gated at the boundary: a document
// asserting 'verified-fixed', 'reproduced', 'repair-in-progress',
// 'recheck-needed', 'integrated' or a confirmed-integration metric event
// must carry the evidence chain those states derive from (collector
// receipts, repair records, confirmed canonical-write operations) inside
// the document itself, exactly as a genuine export preserves it.

import {
  PAGE_LIMIT, canonicalJSON, redactForeignMessageFields, appendEvent, command, entity, exportSnapshot, fail, json,
  requireFields, requireScope,
} from './core.ts';
import type {
  Candidate, CheckJobStatus, Context, Entity, Event,
  EvidenceReceipt, Finding, HelpRequest, HumanCategory, Id, IsoTime,
  Operation, ProjectState, Sha,
} from './types.ts';

export const SCOPES = {
  read: 'read',
  exportScope: 'export',
  restore: 'restore',
} as const;

export const EXPORT_FORMAT = 'together-project-export';
export const EXPORT_VERSION = 1;

/** Fields that may never cross an export/restore boundary. */
const PRIVATE_KEYS: ReadonlySet<string> = new Set([
  'tokenHash', 'collectorTokenHash', 'token', 'plaintext', 'secret', 'secretPlaintext',
]);

export const HUMAN_CATEGORIES: readonly HumanCategory[] = [
  'approve', 'relay', 'tie-break', 'correction', 'other',
];

const ACTIVE_JOB: ReadonlySet<CheckJobStatus> = new Set(['queued', 'dispatched', 'running']);
const DEFAULT_WINDOW_MINUTES = 10;
const DEFAULT_HEARTBEAT_FRESHNESS_MS = 2 * 60 * 1000;
const MAX_PLAN_SCAN = 256;

// ---------------------------------------------------------------------------
// Event log helpers
// ---------------------------------------------------------------------------

/** Defensive id dedupe: the durable log is authoritative; first wins. */
export function dedupeEvents(events: Event[]): Event[] {
  const seen = new Set<Id>();
  const out: Event[] = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metrics -- every number carries scope, window, freshness and record ids.
// ---------------------------------------------------------------------------

export interface MetricWindow {
  from: IsoTime;
  to: IsoTime;
  minutes: number;
}

export interface ProjectMetrics {
  scope: { projectId: Id; mode: string; generatedAt: IsoTime };
  window: MetricWindow;
  heartbeatFreshnessMs: number;
  workingNow: {
    label: 'Working now' | 'Working now (sample)' | 'Assigned';
    value: number;
    sessionIds: Id[];
    assignedCount: number;
    basis: 'heartbeat' | 'sample-heartbeat' | 'assigned-only';
  };
  tasksFinished: {
    label: 'Tasks finished';
    accepted: number;
    denominator: number;
    ratio: number | null;
    acceptedTaskIds: Id[];
  };
  changesCombined: {
    label: 'Changes combined';
    value: number;
    operationIds: Id[];
    shas: Sha[];
  };
  commits: {
    label: 'Commits received';
    received: number | null;
    integrated: number | null;
    receivedShas: Sha[];
    integratedShas: Sha[];
    baselineExcluded: number;
    unknown: boolean;
    note?: string;
  };
  humanActions: {
    label: 'Human actions';
    total: number;
    byCategory: Record<HumanCategory, number>;
    eventIds: Id[];
    uncategorizedHumanEvents: number;
  };
  needsHelp: {
    label: 'Needs help';
    value: number;
    helpIds: Id[];
    blockerIds: Id[];
    possibleIssueIds: Id[];
  };
}

export interface MetricsOptions {
  /** Window length in minutes; default 10. */
  windowMinutes?: number;
  /** Server 'now' closing the window. */
  now?: IsoTime;
  /** Working-now heartbeat freshness; default 120000, configurable. */
  heartbeatFreshnessMs?: number;
}

function inWindow(iso: IsoTime, from: IsoTime, to: IsoTime): boolean {
  return iso >= from && iso <= to;
}

export function metrics(state: ProjectState, opts: MetricsOptions = {}): ProjectMetrics {
  const to = opts.now ?? new Date().toISOString();
  const minutes =
    opts.windowMinutes !== undefined && Number.isFinite(opts.windowMinutes) && opts.windowMinutes > 0
      ? opts.windowMinutes
      : DEFAULT_WINDOW_MINUTES;
  const from = new Date(Date.parse(to) - minutes * 60 * 1000).toISOString();
  const heartbeatFreshnessMs = opts.heartbeatFreshnessMs ?? DEFAULT_HEARTBEAT_FRESHNESS_MS;
  const heartbeatFrom = new Date(Date.parse(to) - heartbeatFreshnessMs).toISOString();
  const events = dedupeEvents(state.events).filter(ev => !(ev as Event & { importedUnverified?: boolean }).importedUnverified);

  // -- Working now / Assigned ---------------------------------------------
  const activeAssignments = Object.values(state.assignments).filter((a) => a.status === 'active');
  const sessionOf = new Map<Id, Id>();
  for (const a of activeAssignments) {
    sessionOf.set(a.id, a.sessionId ?? `identity:${a.identityId}`);
  }
  const heartbeatAssignments = new Set<Id>();
  const jobsList = Object.values(state.jobs);
  for (const a of activeAssignments) {
    const session = a.sessionId !== undefined ? state.sessions[a.sessionId] : undefined;
    const sessionBeat =
      session?.lastActivityAt !== undefined && !session.importedUnverified &&
      session.lastActivityAt >= heartbeatFrom &&
      typeof session.lastActivitySource === 'string' &&
      /heartbeat|runner/i.test(session.lastActivitySource);
    const jobBeat = jobsList.some((j) => {
      const beat = (j as { lastHeartbeatAt?: IsoTime }).lastHeartbeatAt;
      return !j.importedUnverified && j.ownerAssignmentId === a.id && beat !== undefined && beat >= heartbeatFrom;
    });
    const eventBeat = events.some(
      (ev) =>
        (ev.type === 'check:heartbeat' || ev.type === 'assignment:heartbeat' || ev.type === 'heartbeat') &&
        ev.createdAt >= heartbeatFrom &&
        (ev.detail as Record<string, unknown> | undefined)?.assignmentId === a.id,
    );
    if (sessionBeat || jobBeat || eventBeat) heartbeatAssignments.add(a.id);
  }
  const assignedIds = new Set(sessionOf.values());
  const workingIds = new Set([...heartbeatAssignments].map((a) => sessionOf.get(a)!));
  const sample = state.project.mode === 'sample';
  const workingNow: ProjectMetrics['workingNow'] =
    heartbeatAssignments.size > 0
      ? {
          label: sample ? 'Working now (sample)' : 'Working now',
          value: workingIds.size,
          sessionIds: [...workingIds],
          assignedCount: assignedIds.size,
          basis: sample ? 'sample-heartbeat' : 'heartbeat',
        }
      : {
          label: 'Assigned',
          value: assignedIds.size,
          sessionIds: [...assignedIds],
          assignedCount: assignedIds.size,
          basis: 'assigned-only',
        };

  // -- Tasks finished ------------------------------------------------------
  const tasks = Object.values(state.tasks);
  const nonCancelled = tasks.filter((t) => t.lifecycle !== 'cancelled');
  const accepted = nonCancelled.filter((t) => t.lifecycle === 'done' && !t.importedUnverified);
  const tasksFinished: ProjectMetrics['tasksFinished'] = {
    label: 'Tasks finished',
    accepted: accepted.length,
    denominator: nonCancelled.length,
    ratio: nonCancelled.length === 0 ? null : accepted.length / nonCancelled.length,
    acceptedTaskIds: accepted.map((t) => t.id),
  };

  // -- Changes combined (distinct new confirmed landings) ------------------
  const integratedShas = new Set<Sha>();
  const integrateOps = new Set<Id>();
  for (const ev of events) {
    if (ev.type !== 'integration:confirmed' && ev.type !== 'integrate:confirmed') continue;
    const d = (ev.detail ?? {}) as Record<string, unknown>;
    // A prior already-landed candidate never counts as a new integration.
    if (d.newLanding === false) continue;
    const sha =
      typeof d.candidateSha === 'string' ? d.candidateSha : typeof d.sha === 'string' ? d.sha : undefined;
    if (sha !== undefined) integratedShas.add(sha);
    if (typeof d.operationId === 'string') integrateOps.add(d.operationId);
  }
  // Confirmed integration operations without their own event still count,
  // deduplicated by sha so reconcile/retry cannot inflate the number.
  for (const op of Object.values(state.operations)) {
    if (op.effect !== 'confirmed' || op.importedUnverified) continue;
    if (!/integrat/i.test(`${op.scope} ${op.intent}`)) continue;
    const result = (op.result?.body ?? {}) as Record<string, unknown>;
    if (result.newLanding === false) continue;
    const sha =
      typeof result.candidateSha === 'string'
        ? result.candidateSha
        : typeof result.sha === 'string'
          ? result.sha
          : undefined;
    if (sha === undefined) continue;
    integratedShas.add(sha);
    integrateOps.add(op.id);
  }
  const changesCombined: ProjectMetrics['changesCombined'] = {
    label: 'Changes combined',
    value: integratedShas.size,
    operationIds: [...integrateOps],
    shas: [...integratedShas],
  };

  // -- Commits received / of those integrated ------------------------------
  let observedAny = false;
  let baselineExcluded = 0;
  const receivedShas = new Set<Sha>();
  const reachableShas = new Set<Sha>();
  for (const ev of events) {
    if (ev.type !== 'commit:observed' && ev.type !== 'commit:received') continue;
    const d = (ev.detail ?? {}) as Record<string, unknown>;
    const sha = typeof d.sha === 'string' ? d.sha : undefined;
    if (sha === undefined) continue;
    observedAny = true;
    if (d.baseline === true || d.imported === true) {
      baselineExcluded += 1;
      continue;
    }
    if (!inWindow(ev.createdAt, from, to)) continue;
    receivedShas.add(sha);
    const role = typeof d.role === 'string' ? d.role : 'canonical';
    if (role === 'canonical' && d.reachable !== false) reachableShas.add(sha);
  }
  // Confirmed-integrated candidate shas (and their proposal heads, which are
  // ancestors of the landed tip) are reachable by definition.
  for (const c of Object.values(state.candidates)) {
    if (c.status !== 'integrated' && !integratedShas.has(c.sha)) continue;
    reachableShas.add(c.sha);
    for (const head of Object.values(c.proposalHeads)) {
      if (receivedShas.has(head)) reachableShas.add(head);
    }
  }
  const integratedSubset = [...receivedShas].filter((s) => reachableShas.has(s));
  const commits: ProjectMetrics['commits'] = observedAny
    ? {
        label: 'Commits received',
        received: receivedShas.size,
        integrated: integratedSubset.length,
        receivedShas: [...receivedShas],
        integratedShas: integratedSubset,
        baselineExcluded,
        unknown: false,
      }
    : {
        label: 'Commits received',
        received: null,
        integrated: null,
        receivedShas: [],
        integratedShas: [],
        baselineExcluded: 0,
        unknown: true,
        note: 'no commit-observation events recorded; not the same as zero',
      };

  // -- Human actions ---------------------------------------------------------
  const byCategory: Record<HumanCategory, number> = {
    approve: 0, relay: 0, 'tie-break': 0, correction: 0, other: 0,
  };
  const humanEventIds: Id[] = [];
  let uncategorizedHumanEvents = 0;
  for (const ev of events) {
    if (ev.actorKind !== 'human' || !inWindow(ev.createdAt, from, to)) continue;
    if (ev.humanCategory === undefined) {
      uncategorizedHumanEvents += 1;
      continue;
    }
    const category = HUMAN_CATEGORIES.includes(ev.humanCategory) ? ev.humanCategory : 'other';
    byCategory[category] += 1;
    humanEventIds.push(ev.id);
  }
  const humanActions: ProjectMetrics['humanActions'] = {
    label: 'Human actions',
    total: humanEventIds.length,
    byCategory,
    eventIds: humanEventIds,
    uncategorizedHumanEvents,
  };

  // -- Needs help --------------------------------------------------------------
  const helpIds: Id[] = [];
  for (const h of Object.values(state.help) as HelpRequest[]) {
    if (h.state === 'offered' || h.state === 'accepted') helpIds.push(h.id);
  }
  const blockerIds: Id[] = [];
  const possibleIssueIds: Id[] = [];
  for (const f of Object.values(state.findings) as Finding[]) {
    if (f.state === 'reproduced' || f.state === 'recheck-needed') blockerIds.push(f.id);
    else if (f.state === 'possible-issue') possibleIssueIds.push(f.id);
  }
  const needsHelp: ProjectMetrics['needsHelp'] = {
    label: 'Needs help',
    value: new Set([...helpIds, ...blockerIds]).size,
    helpIds,
    blockerIds,
    possibleIssueIds,
  };

  return {
    scope: { projectId: state.project.id, mode: state.project.mode, generatedAt: to },
    window: { from, to, minutes },
    heartbeatFreshnessMs,
    workingNow,
    tasksFinished,
    changesCombined,
    commits,
    humanActions,
    needsHelp,
  };
}

// ---------------------------------------------------------------------------
// Deterministic bounded Bug Eater planner.
// Pure read: given a state it returns the (capacity-bounded) check jobs a
// dispatcher should register, newest eligible revision first, and every
// eligible-but-skipped revision with its reason. A burst collapses to the
// newest eligible candidate; nothing is launched here.
// ---------------------------------------------------------------------------

export interface BugEaterPlanEntry {
  candidateId: Id;
  candidateSha: Sha;
  command: string;
  timeoutMs: number;
  deadlineAt?: IsoTime;
  reason: string;
}

export interface BugEaterPlan {
  jobs: BugEaterPlanEntry[];
  skipped: { candidateId: Id; candidateSha: Sha; reason: string }[];
  capacity: { maxActiveChecks: number; activeJobs: number; remaining: number };
  stopped: boolean;
}

export interface BugEaterOptions {
  /** Required check commands; default reads project.requiredCheckCommands else ['npm test']. */
  commands?: string[];
  now?: IsoTime;
}

function requiredCommands(state: ProjectState, opts: BugEaterOptions): string[] {
  if (opts.commands !== undefined && opts.commands.length > 0) return opts.commands;
  const configured = (state.project as { requiredCheckCommands?: unknown }).requiredCheckCommands;
  if (
    Array.isArray(configured) &&
    configured.length > 0 &&
    configured.every((c) => typeof c === 'string')
  ) {
    return configured as string[];
  }
  return ['npm test'];
}

export function planBugEaterChecks(state: ProjectState, opts: BugEaterOptions = {}): BugEaterPlan {
  const commands = requiredCommands(state, opts);
  const maxActive = Math.max(0, state.project.resourceLimits.maxActiveChecks || 1);
  const jobs = Object.values(state.jobs);
  const activeJobs = jobs.filter((j) => ACTIVE_JOB.has(j.status)).length;
  const remaining = Math.max(0, maxActive - activeJobs);
  const stopped = state.stopped === true;

  const activeOrPassing = (candidate: Candidate, commandText: string): string | undefined => {
    for (const jobId of candidate.checkJobIds) {
      const job = state.jobs[jobId];
      if (job === undefined || job.candidateSha !== candidate.sha) continue;
      if (job.command !== commandText) continue;
      if (ACTIVE_JOB.has(job.status)) return 'active-job';
      const receiptId = (job as { receiptId?: Id }).receiptId;
      const receipt =
        receiptId !== undefined ? (state.receipts[receiptId] as EvidenceReceipt | undefined) : undefined;
      if (receipt?.outcome === 'pass') return 'already-passed';
    }
    return undefined;
  };

  interface Eligible {
    candidate: Candidate;
    pending: string[];
  }
  const eligible: Eligible[] = [];
  const skipped: BugEaterPlan['skipped'] = [];
  const ordered = Object.values(state.candidates)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
    )
    .slice(-MAX_PLAN_SCAN);
  for (const candidate of ordered) {
    if (candidate.status === 'integrated' || candidate.status === 'superseded') {
      skipped.push({
        candidateId: candidate.id,
        candidateSha: candidate.sha,
        reason: `candidate-${candidate.status}`,
      });
      continue;
    }
    const pending = commands.filter((c) => activeOrPassing(candidate, c) === undefined);
    if (pending.length === 0) {
      skipped.push({
        candidateId: candidate.id,
        candidateSha: candidate.sha,
        reason: 'required-checks-covered',
      });
      continue;
    }
    eligible.push({ candidate, pending });
  }

  const timeoutMs = state.project.resourceLimits.checkTimeoutMs;
  const now = opts.now ?? new Date().toISOString();
  const plan: BugEaterPlan = {
    jobs: [],
    skipped,
    capacity: { maxActiveChecks: maxActive, activeJobs, remaining },
    stopped,
  };
  // Newest eligible revision first; bursts collapse upward.
  const newestFirst = [...eligible].sort((a, b) =>
    a.candidate.createdAt === b.candidate.createdAt
      ? b.candidate.id.localeCompare(a.candidate.id)
      : a.candidate.createdAt < b.candidate.createdAt
        ? 1
        : -1,
  );
  let slots = stopped ? 0 : remaining;
  for (const { candidate, pending } of newestFirst) {
    if (slots <= 0) {
      plan.skipped.push({
        candidateId: candidate.id,
        candidateSha: candidate.sha,
        reason: stopped ? 'project-stopped' : 'superseded-by-newer-eligible-revision',
      });
      continue;
    }
    plan.jobs.push({
      candidateId: candidate.id,
      candidateSha: candidate.sha,
      command: pending.join(' && '),
      timeoutMs,
      deadlineAt: new Date(Date.parse(now) + timeoutMs).toISOString(),
      reason: 'newest-eligible-revision',
    });
    slots -= 1;
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Export / restore
// ---------------------------------------------------------------------------

function stripPrivate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_KEYS.has(k)) continue;
      out[k] = stripPrivate(v);
    }
    return out;
  }
  return value;
}

function containsPrivate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivate);
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_KEYS.has(k)) return true;
      if (containsPrivate(v)) return true;
    }
  }
  return false;
}

export interface ProjectExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  projectId: Id;
  exportedAt: IsoTime;
  exportedBy?: Id;
  state: ProjectState;
}

/**
 * Full coordination-record export with every credential removed: the
 * credentials/invitations collections are emptied and credential hashes are
 * stripped recursively (jobs carry collectorTokenHash). No other project's
 * data can appear -- the state argument is already project-scoped.
 */
export function exportProject(
  state: ProjectState,
  opts: { now?: IsoTime; exportedBy?: Id } = {},
): ProjectExport {
  const stripped = stripPrivate(exportSnapshot(state)) as ProjectState;
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    projectId: state.project.id,
    exportedAt: opts.now ?? new Date().toISOString(),
    ...(opts.exportedBy !== undefined ? { exportedBy: opts.exportedBy } : {}),
    state: stripped,
  };
}

const ENTITY_COLLECTIONS = [
  'members', 'sessions', 'identities', 'credentials', 'invitations', 'tasks',
  'assignments', 'help', 'messages', 'handoffs', 'proposals', 'candidates',
  'jobs', 'receipts', 'authorReports', 'reviews', 'findings', 'operations',
] as const;

const FINDING_STATES: ReadonlySet<string> = new Set([
  'possible-issue', 'reproduced', 'repair-in-progress', 'recheck-needed',
  'verified-fixed', 'not-reproduced', 'withdrawn',
]);
const CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  'prepared', 'checking', 'ready', 'integrated', 'failed', 'superseded',
]);
const PROPOSAL_LIFECYCLES: ReadonlySet<string> = new Set([
  'draft', 'submitted', 'changes-requested', 'ready-to-combine', 'integrated', 'withdrawn',
]);
const INTEGRATE_INTENT = /integrat/i;

function unsupportedTrust(message: string): never {
  fail(422, 'restore_unsupported_trust', message, { retryable: false });
}

type IntegrateOp = Operation & { candidateId?: Id; candidateTip?: Sha };

function opResultSha(op: IntegrateOp): Sha | undefined {
  const body = op.result?.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  return typeof b.candidateSha === 'string'
    ? b.candidateSha
    : typeof b.sha === 'string'
      ? b.sha
      : undefined;
}

/**
 * Restore trust boundary (amendments 6/9). Derived states are produced
 * ONLY by their evidence records: collector receipts, repair records and
 * confirmed canonical-write operations. A genuine export of this project
 * carries that evidence inside the document; a document asserting a
 * trusted label without it is rejected so imported text cannot masquerade
 * as current verified/integrated truth. The checks mirror the live
 * derivations -- applyReceiptOutcome's pass+fail pair for verified-fixed,
 * an attached failing receipt for reproduced, and the confirmed integrate
 * operation (candidateId/candidateTip/result sha) for integrated.
 */
function assertSupportedTrust(s: ProjectState, events: Event[]): void {
  const receipts = s.receipts ?? {};
  const findings = s.findings ?? {};
  const candidates = s.candidates ?? {};
  const proposals = s.proposals ?? {};
  const operations = s.operations ?? {};
  const assignments = s.assignments ?? {};

  const linkedReceipts = (f: Finding): EvidenceReceipt[] => {
    const ids = Array.isArray(f.receiptIds) ? f.receiptIds : [];
    return ids
      .map((id) => receipts[id] as EvidenceReceipt | undefined)
      .filter((r): r is EvidenceReceipt => r !== undefined);
  };

  for (const [id, f] of Object.entries(findings)) {
    if (typeof f.state !== 'string' || !FINDING_STATES.has(f.state)) {
      unsupportedTrust(`findings/${id} carries unknown state "${String(f.state)}"`);
    }
    const linked = linkedReceipts(f);
    if (f.state === 'reproduced') {
      if (!linked.some((r) => r.outcome === 'fail')) {
        unsupportedTrust(
          `findings/${id} claims reproduced without a linked failing receipt`,
        );
      }
    } else if (f.state === 'verified-fixed') {
      const proven = linked.some(
        (pass) =>
          pass.outcome === 'pass' &&
          linked.some(
            (original) =>
              original.outcome === 'fail' &&
              original.command === pass.command &&
              original.candidateSha !== pass.candidateSha,
          ),
      );
      if (!proven) {
        unsupportedTrust(
          `findings/${id} claims verified-fixed without the original-failing and repaired-passing receipt pair`,
        );
      }
    } else if (f.state === 'repair-in-progress') {
      const aid = (f as Finding & { repairAssignmentId?: Id }).repairAssignmentId;
      if (aid === undefined || assignments[aid] === undefined) {
        unsupportedTrust(
          `findings/${id} claims repair-in-progress without its repair assignment`,
        );
      }
    } else if (f.state === 'recheck-needed') {
      const cid = (f as Finding & { repairCandidateId?: Id }).repairCandidateId;
      if (cid === undefined || candidates[cid] === undefined) {
        unsupportedTrust(
          `findings/${id} claims recheck-needed without its repair candidate`,
        );
      }
    }
  }

  const integrateOps = Object.values(operations).filter((o): o is IntegrateOp => {
    const op = o as IntegrateOp;
    return (
      op.effect === 'confirmed' && INTEGRATE_INTENT.test(`${op.scope} ${op.intent}`)
    );
  });
  const opConfirms = (op: IntegrateOp, c: Candidate): boolean =>
    op.candidateId === c.id || op.candidateTip === c.sha || opResultSha(op) === c.sha;

  const provenIntegrated = new Set<Id>();
  for (const [id, c] of Object.entries(candidates)) {
    if (typeof c.status !== 'string' || !CANDIDATE_STATUSES.has(c.status)) {
      unsupportedTrust(`candidates/${id} carries unknown status "${String(c.status)}"`);
    }
    if (c.status !== 'integrated') continue;
    const proven = integrateOps.some(
      (op) =>
        opConfirms(op, c) ||
        (c.integrateOperationId !== undefined && op.id === c.integrateOperationId),
    );
    if (!proven) {
      unsupportedTrust(
        `candidates/${id} claims integrated without a confirmed canonical-write operation`,
      );
    }
    provenIntegrated.add(id);
  }

  for (const [id, p] of Object.entries(proposals)) {
    if (typeof p.lifecycle !== 'string' || !PROPOSAL_LIFECYCLES.has(p.lifecycle)) {
      unsupportedTrust(`proposals/${id} carries unknown lifecycle "${String(p.lifecycle)}"`);
    }
    if (p.lifecycle !== 'integrated') continue;
    const combined = [...provenIntegrated].some((cid) => {
      const cand = candidates[cid];
      return Array.isArray(cand.proposalIds) && cand.proposalIds.includes(id);
    });
    if (!combined) {
      unsupportedTrust(
        `proposals/${id} claims integrated but no evidence-backed integrated candidate combines it`,
      );
    }
  }

  // Metric-counted landing events must trace to a confirmed canonical-write
  // operation in the same document, or they inflate "Changes combined".
  for (const ev of events) {
    if (ev.type !== 'integration:confirmed' && ev.type !== 'integrate:confirmed') continue;
    const d = (ev.detail ?? {}) as Record<string, unknown>;
    if (d.newLanding === false) continue;
    const opId = typeof d.operationId === 'string' ? d.operationId : undefined;
    const sha =
      typeof d.candidateSha === 'string'
        ? d.candidateSha
        : typeof d.sha === 'string'
          ? d.sha
          : undefined;
    const proven = integrateOps.some((op) => {
      const shaMatch =
        sha !== undefined &&
        (op.candidateTip === sha ||
          opResultSha(op) === sha ||
          (typeof op.candidateId === 'string' && candidates[op.candidateId]?.sha === sha));
      if (opId !== undefined) return op.id === opId && (sha === undefined || shaMatch);
      return shaMatch;
    });
    if (!proven) {
      unsupportedTrust(
        `event ${ev.id} claims a confirmed integration without a confirmed canonical-write operation`,
      );
    }
  }
}

function assertEntityShape(rec: unknown, collection: string, projectId: Id): Entity {
  if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
    fail(422, 'invalid_export', `${collection} entry is not an object`);
  }
  const e = rec as Entity;
  for (const f of ['id', 'projectId', 'createdAt', 'updatedAt', 'actorId'] as const) {
    if (typeof e[f] !== 'string') fail(422, 'invalid_export', `${collection}.${f} must be a string`);
  }
  if (typeof e.revision !== 'number' || !Number.isInteger(e.revision) || e.revision < 1) {
    fail(422, 'invalid_export', `${collection}.revision must be a positive integer`);
  }
  if (e.projectId !== projectId) {
    fail(422, 'invalid_export', `${collection}/${e.id} belongs to a different project`, {
      retryable: false,
    });
  }
  return e;
}

/**
 * Validate an export document and return the state projection to write.
 * Pure validation -- the caller applies it inside a transaction.
 */
export function validateExportDocument(doc: unknown, projectId: Id): ProjectState {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    fail(422, 'invalid_export', 'restore document must be an object');
  }
  const d = doc as Partial<ProjectExport>;
  if (d.format !== EXPORT_FORMAT) fail(422, 'invalid_export', `format must be ${EXPORT_FORMAT}`);
  if (d.version !== EXPORT_VERSION) fail(422, 'invalid_export', `version must be ${EXPORT_VERSION}`);
  if (d.projectId !== projectId || d.state?.project?.id !== projectId) {
    fail(422, 'invalid_export', 'document belongs to a different project', { retryable: false });
  }
  if (containsPrivate(doc)) {
    fail(422, 'restore_private_fields', 'restore documents must not contain credential material', {
      retryable: false,
    });
  }
  const s = d.state as ProjectState;
  if (typeof s !== 'object' || s === null) fail(422, 'invalid_export', 'state must be an object');
  for (const name of ENTITY_COLLECTIONS) {
    const bucket = s[name];
    if (bucket === undefined) continue;
    if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
      fail(422, 'invalid_export', `${name} must be an id-keyed object`);
    }
    if ((name === 'credentials' || name === 'invitations') && Object.keys(bucket).length > 0) {
      fail(422, 'restore_private_fields', `${name} must be empty in an export document`, {
        retryable: false,
      });
    }
    for (const [key, rec] of Object.entries(bucket as Record<string, unknown>)) {
      const e = assertEntityShape(rec, name, projectId);
      if (e.id !== key) fail(422, 'invalid_export', `${name}/${key} id does not match its key`);
    }
  }
  if (!Array.isArray(s.events)) fail(422, 'invalid_export', 'events must be an array');
  const seenIds = new Set<Id>();
  const events: Event[] = [];
  for (const raw of s.events) {
    if (typeof raw !== 'object' || raw === null) {
      fail(422, 'invalid_export', 'event entries must be objects');
    }
    const ev = raw as Event;
    if (typeof ev.id !== 'string' || typeof ev.seq !== 'number' || typeof ev.createdAt !== 'string') {
      fail(422, 'invalid_export', 'event entries need id, seq and createdAt');
    }
    if (ev.projectId !== projectId) {
      fail(422, 'invalid_export', 'event belongs to a different project');
    }
    if (seenIds.has(ev.id)) continue; // dedupe on restore, same as on read
    seenIds.add(ev.id);
    events.push({ ...ev });
  }
  // Re-sequence monotonically so a hand-edited export cannot fake gaps.
  // Copies are resequenced -- the caller's document is never mutated.
  events.sort((a, b) => a.seq - b.seq).forEach((ev, i) => {
    ev.seq = i + 1;
  });
  const project = s.project;
  for (const f of ['id', 'projectId', 'createdAt', 'updatedAt', 'actorId', 'goal', 'mode', 'canonicalRef'] as const) {
    if (typeof (project as Record<string, unknown>)[f] !== 'string') {
      fail(422, 'invalid_export', `project.${f} must be a string`);
    }
  }
  // Trust boundary: imported text cannot assert verified/integrated truth
  // without the evidence chain those states derive from.
  assertSupportedTrust(s, events);
  return {
    project,
    members: s.members ?? {},
    sessions: s.sessions ?? {},
    identities: s.identities ?? {},
    invitations: {},
    credentials: {},
    tasks: s.tasks ?? {},
    assignments: s.assignments ?? {},
    help: s.help ?? {},
    messages: s.messages ?? {},
    handoffs: s.handoffs ?? {},
    proposals: s.proposals ?? {},
    candidates: s.candidates ?? {},
    jobs: s.jobs ?? {},
    receipts: s.receipts ?? {},
    authorReports: s.authorReports ?? {},
    reviews: s.reviews ?? {},
    findings: s.findings ?? {},
    operations: s.operations ?? {},
    events,
    lateOutputs: Array.isArray(s.lateOutputs) ? s.lateOutputs : [],
    stopped: s.stopped === true,
  };
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function listEvents(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const types = new Set(url.searchParams.getAll('type'));
  const limitParam = Number(url.searchParams.get('limit') ?? PAGE_LIMIT);
  const limit = Math.min(
    Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : PAGE_LIMIT,
    PAGE_LIMIT,
  );
  const events = dedupeEvents(state.events);
  const latestSeq = events.length > 0 ? events[events.length - 1].seq : 0;

  let after = 0;
  const afterParam = url.searchParams.get('after');
  if (afterParam !== null && afterParam !== '') {
    if (!/^\d+$/.test(afterParam)) {
      fail(422, 'invalid_cursor', 'after must be a non-negative event sequence number', {
        retryable: false,
      });
    }
    after = Number(afterParam);
  }

  // Cursor gap: the client's cursor references a point the durable log cannot
  // honour (ahead of the log after a restore, or a dropped seq). The marker
  // tells the caller to re-read the full projection -- never silently replay.
  let resync = false;
  let reason: string | undefined;
  if (after > latestSeq) {
    resync = true;
    reason = 'cursor-ahead-of-log';
  } else if (after > 0 && !events.some((ev) => ev.seq === after)) {
    resync = true;
    reason = 'cursor-gap';
  }

  const page = events
    .filter((ev) => ev.seq > after)
    .filter((ev) => types.size === 0 || types.has(ev.type))
    .slice(0, limit);
  // On resync the caller's cursor is unusable: hand back the log tip so a
  // naive client converges in one step instead of resyncing forever.
  const nextCursor = resync ? latestSeq : page.length > 0 ? page[page.length - 1].seq : after;
  return json(200, {
    events: page,
    count: page.length,
    nextCursor,
    latestSeq,
    resync,
    ...(reason !== undefined ? { reason } : {}),
  });
}

async function getOperation(ctx: Context, operationId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const op = entity<Operation>(state, 'operations', operationId);
  // Operation results never contain token material by construction (minted
  // tokens are returned once and never persisted); strip defensively anyway.
  return json(200, { operation: redactForeignMessageFields(stripPrivate(op), ctx.principal) });
}

async function getMetrics(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const windowParam = Number(url.searchParams.get('window') ?? DEFAULT_WINDOW_MINUTES);
  return json(200, {
    metrics: metrics(state, {
      windowMinutes:
        Number.isFinite(windowParam) && windowParam > 0 ? windowParam : DEFAULT_WINDOW_MINUTES,
      now: ctx.now(),
    }),
  });
}

async function getExport(ctx: Context): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.exportScope, state);
  return json(200, exportProject(state, { now: ctx.now(), exportedBy: ctx.principal.id }));
}

/** An unsigned archive is history, not collector or canonical-write authority. */
function markUnverifiedImports(restored: ProjectState, current: ProjectState): void {
  const same = (a: unknown, b: unknown) => b !== undefined && canonicalJSON(stripPrivate(a)) === canonicalJSON(stripPrivate(b));
  for (const collection of ['receipts','reviews','operations','sessions','tasks','assignments'] as const) {
    for (const [id, record] of Object.entries(restored[collection])) {
      if (!same(record, current[collection][id])) {
        record.importedUnverified = true;
        if (collection === 'reviews') {
          record.importedIndependent = record.independent;
          record.independent = false;
        }
      }
    }
  }
  for (const [id, job] of Object.entries(restored.jobs)) if (!same(job, current.jobs[id])) {
    job.importedStatus = job.status; job.importedUnverified = true;
    job.status = 'blocked'; job.blockedReason = 'imported evidence has not been verified by this controller';
  } else if (current.jobs[id].collectorTokenHash) { job.collectorTokenHash = current.jobs[id].collectorTokenHash; }
  for (const [id, finding] of Object.entries(restored.findings)) if (!same(finding, current.findings[id])) {
    finding.importedUnverified = true;
    if (['reproduced','repair-in-progress','recheck-needed','verified-fixed'].includes(finding.state)) {
      finding.importedState = finding.state; finding.state = 'possible-issue';
    }
  }
  for (const [id, candidate] of Object.entries(restored.candidates)) if (!same(candidate, current.candidates[id])) {
    candidate.importedUnverified = true; candidate.importedStatus = candidate.status;
    candidate.status = 'prepared';
  }
  for (const [id, proposal] of Object.entries(restored.proposals)) if (!same(proposal, current.proposals[id]) && proposal.lifecycle === 'integrated') {
    proposal.importedLifecycle = proposal.lifecycle; proposal.importedUnverified = true; proposal.lifecycle = 'submitted';
  }
  restored.events = restored.events.map(ev => same(ev, current.events.find(e => e.id === ev.id)) ? ev : {...ev, importedUnverified:true});
}

function postRestore(ctx: Context, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.restore, { collection: 'project' }, (draft) => {
    requireFields(body, ['document']);
    // Clone so apply can graft/mutate freely without touching the request
    // document (a mutated body would change the stored operation digest).
    const restored = structuredClone(validateExportDocument(body.document, draft.project.id));
    const previousRevision = draft.project.revision;
    if (draft.project.mode === 'live') markUnverifiedImports(restored, draft);
    // Live private auth records are never part of an export: keep them.
    const { credentials, invitations } = draft;
    for (const name of ENTITY_COLLECTIONS) {
      if (name === 'credentials' || name === 'invitations') continue;
      (draft as unknown as Record<string, unknown>)[name] = restored[name];
    }
    draft.credentials = credentials;
    draft.invitations = invitations;
    draft.events = restored.events;
    draft.lateOutputs = restored.lateOutputs;
    draft.stopped = restored.stopped;
    // Server-managed configuration is not archive data: imported text
    // must not flip the identity mode, retarget the canonical branch or
    // relax resource/acceptance bounds.
    draft.project = {
      ...restored.project,
      mode: draft.project.mode,
      canonicalRef: draft.project.canonicalRef,
      resourceLimits: draft.project.resourceLimits,
      repositories: draft.project.repositories,
      acceptancePolicyRevision: draft.project.acceptancePolicyRevision,
      revision: previousRevision,
      updatedAt: draft.project.updatedAt,
    };
    appendEvent(
      draft,
      ctx,
      'project:restored',
      draft.project.id,
      {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        counts: {
          tasks: Object.keys(restored.tasks).length,
          events: restored.events.length,
        },
      },
      ctx.principal.kind === 'human' ? 'correction' : undefined,
    );
    return { status: 200, body: { restored: true, projectId: draft.project.id } };
  });
}

/**
 * Module handler for event/operation/metrics/export endpoints. Segments are
 * the suffix after /api/v1/projects/:projectId. Returns null for unowned
 * routes.
 */
export async function handleEvents(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (method === 'GET' && segments.length === 1 && segments[0] === 'events') {
    return listEvents(ctx, request);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'operations') {
    return getOperation(ctx, segments[1]);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'metrics') {
    return getMetrics(ctx, request);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'export') {
    return getExport(ctx);
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'restore' && body) {
    return postRestore(ctx, body);
  }
  return null;
}
