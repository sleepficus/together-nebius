// Bounded check jobs, job-scoped collector authentication and receipt
// creation for the Together slice (seat b-swe-05).
//
// Trust model (spec "Bug Eater checking" + amendments 5, 8, 9):
// - POST /candidates/:id/checks registers a deduplicated, deadline-bounded
//   CheckJob and mints a job-scoped collector token. Only its SHA-256 hash
//   is persisted; the plaintext is delivered to trusted runner machinery
//   through the dispatch input -- never in a requester-visible response.
//   Replays return the stored (token-free) result -- a lost token means a
//   new job.
// - The collector endpoints (collector/jobs/:id/heartbeat|complete, under
//   this project's API prefix because the dispatcher is project-scoped)
//   require a CollectorPrincipal produced by authenticateCollector():
//   bearer-token hash match AND job-id binding AND a live job. Regular
//   member/admin principals are rejected (403 collector_only). There is no
//   general receipt-insert route.
// - Receipts bind the registered job id, candidate SHA, command and
//   environment; a completion whose payload disagrees with the registered
//   job fails 409 payload_inconsistent. Verified-fixed and Integrated are
//   never set from request fields -- finding states derive from receipt
//   evidence only, via applyReceiptOutcome (lib/findings.ts).
// - Dispatch is an outbox effect: the job is registered inside the
//   command() transaction, then ctx.runner.dispatch is attempted and the
//   result reconciled in a second transaction. Missing runner -> the job is
//   registered as 'blocked' (Check blocked), never faked.

import {
  MAX_PROSE_CHARS, PAGE_LIMIT, appendEvent, canonicalJSON, command, entity,
  fail, json, requireFields, requireProse, requireScope, touchEntity,
} from './core.ts';
import { assertAssignmentEpoch, renewForJobHeartbeat } from './assignments.ts';
import { applyReceiptOutcome, publicFinding, reportFinding } from './findings.ts';
import type {
  Candidate, CheckJob, CheckJobStatus, Context, EvidenceReceipt,
  Finding, Id, IsoTime, Principal, ProjectState,
} from './types.ts';

export const SCOPES = {
  read: 'read',
  checksWrite: 'checks:write',
  collector: 'collector',
} as const;

const ACTIVE_JOB: ReadonlySet<CheckJobStatus> = new Set(['queued', 'dispatched', 'running']);
const TERMINAL_JOB: ReadonlySet<CheckJobStatus> = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const MAX_COMMAND_CHARS = 4 * 1024;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_PART_CHARS = 256;
const MAX_FINDINGS_PER_COMPLETE = 20;
const MAX_REF_ENTRIES = 64;

/** CheckJob plus the fields this module registers (Entity allows extras). */
export interface RegisteredCheckJob extends CheckJob {
  kind: 'check' | 'recheck';
  collectorTokenHash: string;
  findingId?: Id;
  originalReceiptId?: Id;
  snapshotRef?: string;
  receiptId?: Id;
  blockedReason?: string;
  lastHeartbeatAt?: IsoTime;
}

/** Collector principal: a collector-scoped credential bound to one job. */
export interface CollectorPrincipal extends Principal {
  jobId: Id;
}

export async function hashCollectorToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function newCollectorToken(): string {
  return `cjob_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Resolve `Authorization: Bearer <job token>` to a CollectorPrincipal bound
 * to exactly one registered, non-terminal check job. The integrator chains
 * this AFTER the normal authenticate() so a job token cannot impersonate a
 * user and a user credential cannot mint collector provenance:
 *   deps.authenticate = async (req) =>
 *     (await authenticate(req, state, opts)) ?? (await authenticateCollector(req, state));
 */
export async function authenticateCollector(
  request: Request,
  state: ProjectState,
): Promise<CollectorPrincipal | null> {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!match) return null;
  const tokenHash = await hashCollectorToken(match[1]);
  for (const job of Object.values(state.jobs) as RegisteredCheckJob[]) {
    if (job.collectorTokenHash !== tokenHash) continue;
    if (TERMINAL_JOB.has(job.status)) return null;
    return {
      id: `collector:${job.id}`,
      sessionId: `collector-session:${job.id}`,
      kind: 'collector',
      ownerId: 'system',
      scopes: [SCOPES.collector],
      projectIds: [state.project.id],
      jobId: job.id,
    };
  }
  return null;
}

/** Strip the job's credential hash from every outward view. */
export function publicJob(j: CheckJob): Record<string, unknown> {
  const { collectorTokenHash: _omit, ...rest } = j as RegisteredCheckJob;
  return { ...rest };
}

export function publicReceipt(r: EvidenceReceipt): Record<string, unknown> {
  return {
    id: r.id,
    revision: r.revision,
    jobId: r.jobId,
    candidateSha: r.candidateSha,
    collectorId: r.collectorId,
    command: r.command,
    environment: r.environment,
    outcome: r.outcome,
    inputHash: r.inputHash,
    outputHash: r.outputHash,
    artifactRefs: r.artifactRefs,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    actorId: r.actorId,
  };
}

/**
 * Evidence aggregation for downstream readiness (b-swe-04 reads this shape
 * or the raw collections): independent-check evidence counts receipts bound
 * to the exact candidate SHA. AuthorReport records are author-claimed
 * provenance and NEVER enter the receipt count; non-independent reviews are
 * reported separately from independent approvals.
 */
export function candidateEvidence(
  state: ProjectState,
  candidate: Candidate,
): {
  receipts: EvidenceReceipt[];
  passingReceipts: EvidenceReceipt[];
  authorReports: unknown[];
  independentApprovals: unknown[];
  nonIndependentReviews: unknown[];
} {
  const receipts = Object.values(state.receipts).filter(
    (r) => !r.importedUnverified && r.candidateSha === candidate.sha,
  );
  const proposalIds = new Set(candidate.proposalIds);
  const authorReports = Object.values(state.authorReports).filter((r) =>
    proposalIds.has(r.proposalId),
  );
  const reviews = Object.values(state.reviews).filter(
    (r) => !r.importedUnverified && r.candidateSha === candidate.sha,
  );
  return {
    receipts,
    passingReceipts: receipts.filter((r) => r.outcome === 'pass'),
    authorReports,
    independentApprovals: reviews.filter((r) => r.independent && r.disposition === 'approve'),
    nonIndependentReviews: reviews.filter((r) => !r.independent),
  };
}

function parseEnvironment(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(422, 'invalid_field', 'environment must be an object of string values');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENV_ENTRIES) {
    fail(422, 'invalid_field', `environment allows at most ${MAX_ENV_ENTRIES} entries`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length === 0 || k.length > MAX_ENV_PART_CHARS) {
      fail(422, 'invalid_field', 'environment keys must be 1..256 characters');
    }
    if (typeof v !== 'string' || v.length > MAX_ENV_PART_CHARS) {
      fail(422, 'invalid_field', 'environment values must be strings of at most 256 characters');
    }
    out[k] = v;
  }
  return out;
}

/** UTF-8-aware cap: cuts on a code-point boundary so stored prose never
 * exceeds the documented byte limit, unlike a raw char slice. */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function boundedTimeout(state: ProjectState, value: unknown): number {
  const cap = state.project.resourceLimits.checkTimeoutMs;
  if (value === undefined) return cap;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(422, 'invalid_field', 'timeoutMs must be a positive number of milliseconds');
  }
  // Finite deadline always: clamped to the configured resource budget.
  return Math.min(value, cap);
}

function stringRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(422, 'invalid_field', 'artifactRefs must be an array of strings');
  if (value.length > MAX_REF_ENTRIES) fail(422, 'invalid_field', 'too many artifact references');
  return value.map((v) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ENV_PART_CHARS) {
      fail(422, 'invalid_field', 'artifactRefs entries must be non-empty strings');
    }
    return v;
  });
}

function refreshCandidateStatus(draft: ProjectState, ctx: Pick<Context, 'principal' | 'now'>, candidateId: Id): void {
  const candidate = draft.candidates[candidateId];
  if (candidate === undefined) return;
  if (candidate.status === 'integrated' || candidate.status === 'superseded') return;
  const jobs = candidate.checkJobIds
    .map((id) => draft.jobs[id])
    .filter((j): j is CheckJob => j !== undefined);
  const anyActive = jobs.some((j) => ACTIVE_JOB.has(j.status));
  let next = candidate.status;
  if (anyActive) {
    next = 'checking';
  } else if (
    jobs.some((j) => {
      const rj = j as RegisteredCheckJob;
      return rj.kind !== 'recheck' && rj.receiptId !== undefined && draft.receipts[rj.receiptId]?.outcome === 'fail';
    })
  ) {
    // A required-style check observed a failing run on this exact SHA.
    next = 'failed';
  } else {
    next = 'prepared';
  }
  if (next !== candidate.status) {
    candidate.status = next;
    touchEntity(candidate, ctx, ctx.principal.id);
  }
}

function assertCollectorBinding(ctx: Context, jobId: Id): void {
  const p = ctx.principal as CollectorPrincipal | null | undefined;
  if (p === null || p === undefined || p.kind !== 'collector') {
    fail(403, 'collector_only', 'collector endpoints require a job-scoped collector credential');
  }
  if (p.jobId !== jobId) {
    fail(403, 'job_mismatch', 'collector credential is bound to a different check job');
  }
}

async function requestCheck(ctx: Context, candidateId: Id, body: Record<string, unknown>): Promise<Response> {
  // Minted before the transaction; only its hash enters the durable job
  // record. The operation digest covers the caller's body alone -- folding
  // a freshly-minted hash into the digest would break idempotent replay
  // (every retry would mint a different hash and fail digest equality).
  const collectorToken = newCollectorToken();
  const tokenHash = await hashCollectorToken(collectorToken);
  let created: RegisteredCheckJob | undefined;
  const res = await command(
    ctx,
    body,
    SCOPES.checksWrite,
    { collection: 'candidates', id: candidateId },
    (draft) => {
      if (draft.stopped) {
        fail(409, 'project_stopped', 'project is stopped; new check jobs are blocked');
      }
      const candidate = entity<Candidate>(draft, 'candidates', candidateId);
      requireFields(body, ['command']);
      const commandText = requireProse(body.command, 'command', MAX_COMMAND_CHARS);
      const environment = parseEnvironment(body.environment);
      const timeoutMs = boundedTimeout(draft, body.timeoutMs);
      const now = ctx.now();

      let kind: 'check' | 'recheck' = 'check';
      let findingId: Id | undefined;
      let originalReceiptId: Id | undefined;
      if (body.findingId !== undefined) {
        kind = 'recheck';
        if (typeof body.findingId !== 'string') {
          fail(422, 'invalid_field', 'findingId must be a string');
        }
        const finding = entity<Finding>(draft, 'findings', body.findingId);
        if (finding.state === 'verified-fixed' || finding.state === 'withdrawn') {
          fail(409, 'finding_terminal', `finding is ${finding.state}`);
        }
        findingId = finding.id;
        if (body.originalReceiptId !== undefined) {
          const original = entity<EvidenceReceipt>(draft, 'receipts', String(body.originalReceiptId));
          if (!finding.receiptIds.includes(original.id)) {
            fail(422, 'invalid_field', 'originalReceiptId is not linked to the finding');
          }
          originalReceiptId = original.id;
        }
      }

      // Burst collapse: an identical active job on the same SHA is returned
      // instead of scheduling a duplicate (new SHA => new dedupeKey => rerun).
      const dedupeKey = `${kind}:${findingId ?? ''}:${candidate.sha}:${commandText}:${canonicalJSON(environment ?? {})}`;
      for (const j of Object.values(draft.jobs) as RegisteredCheckJob[]) {
        if (j.dedupeKey === dedupeKey && ACTIVE_JOB.has(j.status)) {
          return { status: 200, body: { job: publicJob(j), deduplicated: true } };
        }
      }
      const active = Object.values(draft.jobs).filter((j) => ACTIVE_JOB.has(j.status)).length;
      const max = draft.project.resourceLimits.maxActiveChecks;
      if (active >= max) {
        fail(429, 'check_limit', `at most ${max} active check job(s) per project`, {
          nextAction: 'wait for the running check to finish',
        });
      }

      let ownerAssignmentId: Id | undefined;
      let ownerEpoch: number | undefined;
      if (body.assignmentId !== undefined) {
        if (typeof body.assignmentId !== 'string') {
          fail(422, 'invalid_field', 'assignmentId must be a string');
        }
        if (typeof body.assignmentEpoch !== 'number') {
          fail(422, 'missing_epoch', 'assignmentEpoch is required with assignmentId');
        }
        const { assignment } = assertAssignmentEpoch(draft, {
          assignmentId: body.assignmentId,
          epoch: body.assignmentEpoch,
          now,
        });
        ownerAssignmentId = assignment.id;
        ownerEpoch = assignment.epoch;
      }

      const blocked = ctx.runner === undefined;
      const job: RegisteredCheckJob = {
        planRevisionId:draft.project.adoptedPlanRevisionId??null,
        id: ctx.uid(),
        projectId: draft.project.id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        actorId: ctx.principal.id,
        kind,
        candidateId: candidate.id,
        candidateSha: candidate.sha,
        command: commandText,
        ...(environment !== undefined ? { environment } : {}),
        status: blocked ? 'blocked' : 'queued',
        ...(blocked ? { blockedReason: 'runner-unavailable' } : {}),
        ...(ownerAssignmentId !== undefined ? { ownerAssignmentId, ownerEpoch } : {}),
        deadlineAt: new Date(Date.parse(now) + timeoutMs).toISOString(),
        dedupeKey,
        collectorTokenHash: tokenHash,
        ...(findingId !== undefined ? { findingId } : {}),
        ...(originalReceiptId !== undefined ? { originalReceiptId } : {}),
        ...(body.snapshotRef !== undefined
          ? { snapshotRef: requireProse(body.snapshotRef, 'snapshotRef', MAX_ENV_PART_CHARS) }
          : {}),
      };
      draft.jobs[job.id] = job;
      candidate.checkJobIds.push(job.id);
      if (!blocked && candidate.status !== 'integrated' && candidate.status !== 'superseded') candidate.status = 'checking';
      appendEvent(draft, ctx, 'check:requested', job.id, {
        candidateId: candidate.id,
        candidateSha: candidate.sha,
        kind,
        deadlineAt: job.deadlineAt,
        status: job.status,
        ownerAssignmentId,
        ownerEpoch,
      });
      created = job;
      return { status: 201, body: { job: publicJob(job) } };
    },
  );

  if (res.status !== 201) return res;
  const payload = (await res.json()) as Record<string, unknown>;

  // Outbox dispatch: external effect, outside the registration transaction.
  if (created !== undefined && created.status === 'queued' && ctx.runner !== undefined) {
    const jobId = created.id;
    let dispatch: { accepted: boolean; reason?: string };
    try {
      dispatch = await ctx.runner.dispatch({
        projectId: created.projectId,
        jobId,
        candidateSha: created.candidateSha,
        ...(created.snapshotRef !== undefined ? { snapshotRef: created.snapshotRef } : {}),
        command: created.command,
        ...(created.environment !== undefined ? { environment: created.environment } : {}),
        timeoutMs: Math.max(0, Date.parse(created.deadlineAt ?? '') - Date.parse(ctx.now())),
        operationId: String(body.operationId ?? ''),
        collectorToken,
      });
    } catch {
      dispatch = { accepted: false, reason: 'dispatch-error' };
    }
    let reconciled: Record<string, unknown> | undefined;
    await ctx.store.transact((draft) => {
      const job = draft.jobs[jobId] as RegisteredCheckJob | undefined;
      if (job === undefined || TERMINAL_JOB.has(job.status)) return true;
      job.status = dispatch.accepted ? 'dispatched' : 'blocked';
      if (!dispatch.accepted) {
        job.blockedReason = dispatch.reason ?? 'dispatch-rejected';
      }
      touchEntity(job, ctx, ctx.principal.id);
      appendEvent(draft, ctx, dispatch.accepted ? 'check:dispatched' : 'check:blocked', job.id, {
        reason: dispatch.reason,
      });
      refreshCandidateStatus(draft, ctx, job.candidateId);
      reconciled = publicJob(job);
      return true;
    });
    // Return the record as persisted: the reconcile transaction bumped the
    // job revision, so echoing the pre-dispatch view reports a stale revision.
    if (reconciled !== undefined) payload.job = reconciled;
  }

  // The requester-visible response carries no credential material: the
  // collector token reached trusted runner machinery via dispatch input.
  return json(201, payload);
}

async function listCandidateChecks(ctx: Context, candidateId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const candidate = entity<Candidate>(state, 'candidates', candidateId);
  const jobs = candidate.checkJobIds
    .map((id) => state.jobs[id])
    .filter((j): j is CheckJob => j !== undefined)
    .map(publicJob);
  return json(200, { jobs, count: jobs.length });
}

async function listCandidateReceipts(ctx: Context, candidateId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const candidate = entity<Candidate>(state, 'candidates', candidateId);
  const receipts = Object.values(state.receipts)
    .filter((r) => !r.importedUnverified && r.candidateSha === candidate.sha)
    .map(publicReceipt);
  return json(200, { receipts, count: receipts.length });
}

async function getJob(ctx: Context, jobId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const job = entity<RegisteredCheckJob>(state, 'jobs', jobId);
  const receipt = job.receiptId !== undefined ? state.receipts[job.receiptId] : undefined;
  return json(200, {
    job: publicJob(job),
    ...(receipt !== undefined ? { receipt: publicReceipt(receipt) } : {}),
  });
}

async function listJobs(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status');
  const jobs = Object.values(state.jobs)
    .filter((j) => statusFilter === null || j.status === statusFilter)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .slice(0, PAGE_LIMIT)
    .map(publicJob);
  return json(200, { jobs, count: jobs.length });
}

/**
 * Collector heartbeat: renews ONLY the job's registered owner assignment at
 * its registered epoch, bounded by the job deadline and the assignment's
 * maxUntil cap (amendment 5). Superseded beats are recorded as late
 * activity and renew nothing -- never the successor assignment.
 */
async function collectorHeartbeat(ctx: Context, jobId: Id, body: Record<string, unknown>): Promise<Response> {
  assertCollectorBinding(ctx, jobId);
  requireFields(body, ['assignmentId', 'epoch']);
  if (typeof body.assignmentId !== 'string' || typeof body.epoch !== 'number') {
    fail(422, 'invalid_field', 'assignmentId must be a string and epoch a number');
  }
  // Captured consts: narrowing does not persist into the transact closure.
  const assignmentId: string = body.assignmentId;
  const epoch: number = body.epoch;
  return command(ctx, body, SCOPES.collector, { collection: 'jobs' }, (draft) => {
    const job = entity<RegisteredCheckJob>(draft, 'jobs', jobId);
    if (TERMINAL_JOB.has(job.status)) {
      fail(409, 'job_terminal', `check job is ${job.status}`, { retryable: false });
    }
    if (job.deadlineAt !== undefined && Date.parse(ctx.now()) > Date.parse(job.deadlineAt)) {
      fail(409, 'job_expired', 'check completion arrived after its deadline', { retryable: false });
    }
    if (job.status === 'queued' || job.status === 'dispatched') {
      job.status = 'running';
    }
    job.lastHeartbeatAt = ctx.now();
    touchEntity(job, ctx, ctx.principal.id);
    const renewal = renewForJobHeartbeat(draft, ctx, {
      jobId: job.id,
      assignmentId,
      epoch,
    });
    return { status: 200, body: { job: publicJob(job), renewal } };
  });
}

/**
 * Collector completion: the ONLY EvidenceReceipt writer. Payload
 * consistency is enforced against the registered job (candidate SHA,
 * command, environment); replay of the same operation returns the stored
 * result without minting a second receipt; a differing payload under a
 * completed job fails 409. Finding transitions derive from the receipt via
 * applyReceiptOutcome -- verified-fixed can only be reached here.
 */
async function collectorComplete(ctx: Context, jobId: Id, body: Record<string, unknown>): Promise<Response> {
  assertCollectorBinding(ctx, jobId);
  requireFields(body, ['outcome']);
  return command(ctx, body, SCOPES.collector, { collection: 'jobs' }, (draft) => {
    const job = entity<RegisteredCheckJob>(draft, 'jobs', jobId);
    if (TERMINAL_JOB.has(job.status)) {
      fail(409, 'job_terminal', `check job is ${job.status}`, { retryable: false });
    }
    if (job.deadlineAt !== undefined && Date.parse(ctx.now()) > Date.parse(job.deadlineAt)) {
      fail(409, 'job_expired', 'check completion arrived after its deadline', { retryable: false });
    }
    if (body.candidateSha !== undefined && body.candidateSha !== job.candidateSha) {
      fail(409, 'payload_inconsistent', 'candidateSha does not match the registered job');
    }
    if (body.command !== undefined && body.command !== job.command) {
      fail(409, 'payload_inconsistent', 'command does not match the registered job');
    }
    if (
      body.environment !== undefined &&
      canonicalJSON(body.environment) !== canonicalJSON(job.environment ?? {})
    ) {
      fail(409, 'payload_inconsistent', 'environment does not match the registered job');
    }
    const outcome = body.outcome;
    if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'error' && outcome !== 'blocked') {
      fail(422, 'invalid_field', 'outcome must be pass, fail, error or blocked');
    }
    const now = ctx.now();
    const receipt: EvidenceReceipt = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      jobId: job.id,
      candidateSha: job.candidateSha,
      collectorId: ctx.principal.id,
      command: job.command,
      ...(job.environment !== undefined ? { environment: job.environment } : {}),
      outcome,
      ...(typeof body.inputHash === 'string'
        ? { inputHash: requireProse(body.inputHash, 'inputHash', MAX_ENV_PART_CHARS) }
        : {}),
      ...(typeof body.outputHash === 'string'
        ? { outputHash: requireProse(body.outputHash, 'outputHash', MAX_ENV_PART_CHARS) }
        : {}),
      artifactRefs: stringRefs(body.artifactRefs),
    };
    draft.receipts[receipt.id] = receipt;
    job.receiptId = receipt.id;
    job.status = outcome === 'error' ? 'failed' : outcome === 'blocked' ? 'blocked' : 'completed';
    touchEntity(job, ctx, ctx.principal.id);

    const transitions = applyReceiptOutcome(draft, ctx, {
      jobId: job.id,
      jobKind: job.kind,
      findingId: job.findingId,
      receipt,
    });

    // Runner-observed findings from a failing check (pipeline's "candidate
    // finding" step): collector provenance, receipt linked at birth.
    const created: Finding[] = [];
    if (outcome === 'fail' && Array.isArray(body.findings)) {
      for (const item of body.findings.slice(0, MAX_FINDINGS_PER_COMPLETE)) {
        if (typeof item !== 'object' || item === null) continue;
        const f = item as Record<string, unknown>;
        if (typeof f.expected !== 'string' || typeof f.observed !== 'string') continue;
        created.push(
          reportFinding(draft, ctx, {
            expected: truncateUtf8(f.expected, MAX_PROSE_CHARS),
            observed: truncateUtf8(f.observed, MAX_PROSE_CHARS),
            candidateId: job.candidateId,
            candidateSha: job.candidateSha,
            ...(typeof f.reproducer === 'string' ? { reproducer: truncateUtf8(f.reproducer, MAX_PROSE_CHARS) } : {}),
            ...(typeof f.severity === 'string' ? { severity: truncateUtf8(f.severity, MAX_ENV_PART_CHARS) } : {}),
            state: 'reproduced',
            receiptIds: [receipt.id],
          }),
        );
      }
    }

    refreshCandidateStatus(draft, ctx, job.candidateId);
    const late = job.deadlineAt !== undefined && now > job.deadlineAt;
    appendEvent(draft, ctx, 'check:completed', job.id, {
      receiptId: receipt.id,
      outcome,
      late,
      transitions,
      findings: created.map((f) => f.id),
    });
    return {
      status: 201,
      body: {
        receipt: publicReceipt(receipt),
        job: publicJob(job),
        findings: created.map(publicFinding),
        transitions,
      },
    };
  });
}

/**
 * Module handler for check-job and collector endpoints. Segments are the
 * suffix after /api/v1/projects/:projectId (the app dispatcher is
 * project-scoped, so the contract's collector routes resolve under it as
 * projects/:id/collector/jobs/:id/{heartbeat,complete}). Returns null for
 * unowned routes -- there is no POST /receipts at all.
 */
export async function handleChecks(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (method === 'GET' && segments.length === 3 && segments[0] === 'candidates' && segments[2] === 'checks') {
    return listCandidateChecks(ctx, segments[1]);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'candidates' && segments[2] === 'checks' && body) {
    return requestCheck(ctx, segments[1], body);
  }
  if (method === 'GET' && segments.length === 3 && segments[0] === 'candidates' && segments[2] === 'receipts') {
    return listCandidateReceipts(ctx, segments[1]);
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'jobs') {
    return listJobs(ctx, request);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'jobs') {
    return getJob(ctx, segments[1]);
  }
  if (method === 'POST' && segments.length === 4 && segments[0] === 'collector' && segments[1] === 'jobs' && segments[3] === 'heartbeat' && body) {
    return collectorHeartbeat(ctx, segments[2], body);
  }
  if (method === 'POST' && segments.length === 4 && segments[0] === 'collector' && segments[1] === 'jobs' && segments[3] === 'complete' && body) {
    return collectorComplete(ctx, segments[2], body);
  }
  return null;
}
