// Candidate findings, authorized dispositions and receipt-derived state
// transitions for the Together slice (seat b-swe-05).
//
// Transition contract (spec "Bug Eater checking" + amendment 9):
// - possible-issue     reported by an authorized human/agent (POST /findings)
// - reproduced         derived ONLY from an authenticated collector receipt
//                      with outcome 'fail' (applyReceiptOutcome)
// - repair-in-progress derived from an accepted/active repair assignment
//                      (noteRepairAssignment, also POST /findings/:id/repair)
// - recheck-needed     derived from a repair submission / recheck request
//                      naming the repaired candidate (noteRepairSubmission,
//                      also POST /findings/:id/recheck)
// - verified-fixed     derived ONLY inside collector completion: a passing
//                      receipt on a DIFFERENT (repaired) candidate SHA running
//                      the same reproducer as a linked failing receipt. No
//                      request field, disposition or generic update can set it.
// - not-reproduced / withdrawn are the only API dispositions, each with a
//                      required note; all prior receipt evidence is preserved.
// A failed runner or missing dependency is job status 'blocked', never a
// finding state.

import {
  PAGE_LIMIT, appendEvent, command, entity, fail, json, requireFields,
  requireProse, requireScope, touchEntity,
} from './core.ts';
import type {
  Assignment, Candidate, Context, EvidenceReceipt, Finding,
  FindingState, Id, ProjectState,
} from './types.ts';

export const SCOPES = {
  read: 'read',
  findingsWrite: 'findings:write',
} as const;

/** Dispositions an authorized actor may request directly. */
export const PUBLIC_DISPOSITIONS: readonly FindingState[] = [
  'not-reproduced',
  'withdrawn',
];

/** States that only receipt/assignment-derived writers may produce. */
const DERIVED_STATES: readonly FindingState[] = [
  'reproduced',
  'repair-in-progress',
  'recheck-needed',
  'verified-fixed',
];

export interface FindingWithRepair extends Finding {
  /** Candidate carrying the attempted repair; set on recheck-needed. */
  repairCandidateId?: Id;
}

export function publicFinding(f: Finding): Record<string, unknown> {
  return {
    id: f.id,
    revision: f.revision,
    candidateId: f.candidateId,
    candidateSha: f.candidateSha,
    expected: f.expected,
    observed: f.observed,
    reproducer: f.reproducer,
    severity: f.severity,
    state: f.state,
    originatorId: f.originatorId,
    linkedTaskId: f.linkedTaskId,
    repairAssignmentId: f.repairAssignmentId,
    repairCandidateId: (f as FindingWithRepair).repairCandidateId,
    receiptIds: f.receiptIds,
    note: f.note,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    actorId: f.actorId,
    importedUnverified: f.importedUnverified,
    importedState: f.importedState,
  };
}

export interface FindingInput {
  expected: string;
  observed: string;
  candidateId?: Id;
  candidateSha?: string;
  reproducer?: string;
  severity?: string;
  note?: string;
  /** 'possible-issue' for human/agent reports; 'reproduced' is collector-only. */
  state?: 'possible-issue' | 'reproduced';
  originatorId?: Id;
  receiptIds?: Id[];
}

/**
 * Create a Finding record inside the caller's transaction. The public
 * endpoint only ever requests 'possible-issue'; 'reproduced' is used solely
 * by the collector-completion path, which attaches the observing receipt.
 */
export function reportFinding(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: FindingInput,
): Finding {
  const state = input.state ?? 'possible-issue';
  if (state !== 'possible-issue' && state !== 'reproduced') {
    fail(422, 'invalid_field', `finding state "${state}" cannot be reported directly`);
  }
  const now = ctx.now();
  const finding: Finding = {
    id: ctx.uid(),
    projectId: draft.project.id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    actorId: ctx.principal.id,
    ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
    ...(input.candidateSha !== undefined ? { candidateSha: input.candidateSha } : {}),
    expected: input.expected,
    observed: input.observed,
    ...(input.reproducer !== undefined ? { reproducer: input.reproducer } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    state,
    originatorId: input.originatorId ?? ctx.principal.id,
    receiptIds: [...(input.receiptIds ?? [])],
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  draft.findings[finding.id] = finding;
  appendEvent(draft, ctx, `finding:${state === 'reproduced' ? 'reproduced' : 'reported'}`, finding.id, {
    candidateId: finding.candidateId,
    candidateSha: finding.candidateSha,
    originatorId: finding.originatorId,
    receiptIds: finding.receiptIds,
  });
  return finding;
}

export interface FindingTransition {
  findingId: Id;
  from: FindingState;
  to: FindingState;
  receiptId?: Id;
  originalReceiptId?: Id;
  limitation?: string;
}

/**
 * Receipt-derived finding transitions (amendment 9). Called inside the
 * collector completion transaction in lib/checks.ts; job-scoped provenance
 * is established before this runs. Rules:
 * - outcome 'fail' on a job bound to the finding -> reproduced.
 * - outcome 'pass' -> verified-fixed ONLY when a linked earlier failing
 *   receipt ran the same command (same reproducer) on a DIFFERENT candidate
 *   SHA. Otherwise the pass is inconclusive: the state does not advance and
 *   the limitation is recorded on the finding and in the event log.
 * - 'error'/'blocked' are runner outcomes, never finding transitions.
 */
export function applyReceiptOutcome(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: { jobId: Id; jobKind?: string; findingId?: Id; receipt: EvidenceReceipt },
): FindingTransition[] {
  const transitions: FindingTransition[] = [];
  const { receipt } = input;
  const findingId = input.findingId;
  if (findingId === undefined) return transitions;
  const finding = draft.findings[findingId] as FindingWithRepair | undefined;
  if (finding === undefined) return transitions;
  if (!finding.receiptIds.includes(receipt.id)) {
    finding.receiptIds.push(receipt.id);
  }

  if (receipt.outcome === 'fail') {
    // An authenticated runner observed the reproduction.
    if (finding.state !== 'reproduced') {
      const from = finding.state;
      finding.state = 'reproduced';
      touchEntity(finding, ctx, ctx.principal.id);
      transitions.push({ findingId: finding.id, from, to: 'reproduced', receiptId: receipt.id });
    }
    return transitions;
  }

  if (receipt.outcome === 'pass') {
    const original = findOriginalFailingReceipt(draft, finding, receipt, input.jobId);
    if (original !== undefined) {
      const from = finding.state;
      finding.state = 'verified-fixed';
      touchEntity(finding, ctx, ctx.principal.id);
      appendEvent(draft, ctx, 'finding:verified-fixed', finding.id, {
        originalReceiptId: original.id,
        repairReceiptId: receipt.id,
        originalCandidateSha: original.candidateSha,
        repairedCandidateSha: receipt.candidateSha,
      });
      transitions.push({
        findingId: finding.id,
        from,
        to: 'verified-fixed',
        receiptId: receipt.id,
        originalReceiptId: original.id,
      });
    } else {
      // Passing run without linked original-failure evidence: the fix is not
      // proven. Record the limitation; the state does not advance.
      const limitation =
        'passing recheck could not be linked to an original failing run of the same reproducer';
      finding.note = finding.note === undefined ? limitation : `${finding.note}\n${limitation}`;
      touchEntity(finding, ctx, ctx.principal.id);
      appendEvent(draft, ctx, 'finding:recheck-inconclusive', finding.id, {
        receiptId: receipt.id,
        limitation,
      });
      transitions.push({
        findingId: finding.id,
        from: finding.state,
        to: finding.state,
        receiptId: receipt.id,
        limitation,
      });
    }
    return transitions;
  }

  // 'error'/'blocked': check infrastructure outcome, not code truth.
  appendEvent(draft, ctx, 'finding:recheck-inconclusive', finding.id, {
    receiptId: receipt.id,
    limitation: `runner outcome "${receipt.outcome}" is not reproduction evidence`,
  });
  return transitions;
}

/**
 * Find the earlier receipt proving the same reproducer failed on a
 * different candidate SHA. Prefers the receipt the recheck job named via
 * originalReceiptId; falls back to the finding's linked failing receipts.
 */
function findOriginalFailingReceipt(
  draft: ProjectState,
  finding: Finding,
  passReceipt: EvidenceReceipt,
  jobId: Id,
): EvidenceReceipt | undefined {
  const job = draft.jobs[jobId];
  const namedId = (job as { originalReceiptId?: Id } | undefined)?.originalReceiptId;
  const candidates: EvidenceReceipt[] = [];
  if (namedId !== undefined) {
    const named = draft.receipts[namedId];
    if (named !== undefined) candidates.push(named);
  }
  for (const rid of finding.receiptIds) {
    if (rid === passReceipt.id) continue;
    const r = draft.receipts[rid];
    if (r !== undefined) candidates.push(r);
  }
  return candidates.find(
    (r) =>
      !r.importedUnverified && r.outcome === 'fail' &&
      r.command === passReceipt.command &&
      r.candidateSha !== passReceipt.candidateSha,
  );
}

/**
 * Derives 'repair-in-progress' from an accepted, still-active repair
 * assignment. Exported for the assignments/inbox paths that accept repair
 * work inside their own transactions, and used by POST /findings/:id/repair.
 */
export function noteRepairAssignment(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: { findingId: Id; assignmentId: Id },
): Finding {
  const finding = entity<Finding>(draft, 'findings', input.findingId);
  const assignment = entity<Assignment>(draft, 'assignments', input.assignmentId);
  if (assignment.status !== 'active') {
    fail(409, 'assignment_inactive', `assignment is ${assignment.status}; repair needs an active claim`);
  }
  if (finding.state !== 'reproduced' && finding.state !== 'possible-issue') {
    fail(409, 'invalid_transition', `cannot start repair from ${finding.state}`);
  }
  const from = finding.state;
  finding.repairAssignmentId = assignment.id;
  finding.linkedTaskId = assignment.taskId;
  finding.state = 'repair-in-progress';
  touchEntity(finding, ctx, ctx.principal.id);
  appendEvent(draft, ctx, 'finding:repair-in-progress', finding.id, {
    from,
    assignmentId: assignment.id,
    taskId: assignment.taskId,
    epoch: assignment.epoch,
  });
  return finding;
}

/**
 * Derives 'recheck-needed' from a repair submission: a new candidate
 * carrying the attempted fix. The actual check is a separate request
 * (POST /candidates/:id/checks with findingId) -- rechecking is a new
 * candidate/check, not a backwards dependency edge.
 */
export function noteRepairSubmission(
  draft: ProjectState,
  ctx: Pick<Context, 'principal' | 'now' | 'uid'>,
  input: { findingId: Id; candidateId: Id },
): Finding {
  const finding = entity<Finding>(draft, 'findings', input.findingId) as FindingWithRepair;
  const candidate = entity<Candidate>(draft, 'candidates', input.candidateId);
  if (finding.state !== 'reproduced' && finding.state !== 'repair-in-progress') {
    fail(409, 'invalid_transition', `recheck requires reproduced or repair-in-progress, got ${finding.state}`);
  }
  const from = finding.state;
  finding.repairCandidateId = candidate.id;
  finding.state = 'recheck-needed';
  touchEntity(finding, ctx, ctx.principal.id);
  appendEvent(draft, ctx, 'finding:recheck-needed', finding.id, {
    from,
    repairCandidateId: candidate.id,
    repairCandidateSha: candidate.sha,
    nextAction: `POST /api/v1/projects/${draft.project.id}/candidates/${candidate.id}/checks`,
  });
  return finding;
}

interface JsonObject {
  [key: string]: unknown;
}

async function listFindings(ctx: Context, request: Request): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const url = new URL(request.url);
  const stateFilter = url.searchParams.get('state');
  const candidateFilter = url.searchParams.get('candidateId');
  const cursor = url.searchParams.get('cursor');
  const limitParam = Number(url.searchParams.get('limit') ?? PAGE_LIMIT);
  const limit = Math.min(
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : PAGE_LIMIT,
    PAGE_LIMIT,
  );
  const all = Object.values(state.findings)
    .filter((f) => stateFilter === null || f.state === stateFilter)
    .filter((f) => candidateFilter === null || f.candidateId === candidateFilter)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
    );
  let start = 0;
  if (cursor !== null) {
    const idx = all.findIndex((f) => f.id === cursor);
    if (idx < 0) fail(404, 'not_found', 'cursor finding not found');
    start = idx + 1;
  }
  const page = all.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor = start + limit < all.length && last ? last.id : null;
  return json(200, {
    findings: page.map(publicFinding),
    count: page.length,
    total: all.length,
    nextCursor,
  });
}

function createFinding(ctx: Context, body: JsonObject): Promise<Response> {
  return command(ctx, body, SCOPES.findingsWrite, { collection: 'findings' }, (draft) => {
    requireFields(body, ['expected', 'observed']);
    const expected = requireProse(body.expected, 'expected');
    const observed = requireProse(body.observed, 'observed');
    let candidateId: Id | undefined;
    let candidateSha: string | undefined;
    if (body.candidateId !== undefined) {
      const candidate = entity<Candidate>(draft, 'candidates', String(body.candidateId));
      candidateId = candidate.id;
      candidateSha = candidate.sha;
      if (body.candidateSha !== undefined && body.candidateSha !== candidate.sha) {
        fail(409, 'stale_candidate_sha', `candidate sha is ${candidate.sha}`, {
          nextAction: 're-read the candidate and retry against the current sha',
        });
      }
    }
    const receiptIds=body.receiptIds===undefined?[]:body.receiptIds;
    if(!Array.isArray(receiptIds)||receiptIds.length>20||receiptIds.some(id=>typeof id!=='string'||!draft.receipts[id]||candidateSha&&draft.receipts[id].candidateSha!==candidateSha))fail(422,'evidence_reference','Use existing project receipt IDs matching the selected candidate');
    const finding = reportFinding(draft, ctx, {
      receiptIds:receiptIds as string[],
      expected,
      observed,
      candidateId,
      candidateSha,
      ...(body.reproducer !== undefined
        ? { reproducer: requireProse(body.reproducer, 'reproducer') }
        : {}),
      ...(body.severity !== undefined ? { severity: requireProse(body.severity, 'severity') } : {}),
      ...(body.note !== undefined ? { note: requireProse(body.note, 'note') } : {}),
    });
    return { status: 201, body: { finding: publicFinding(finding) } };
  });
}

function dispositionFinding(ctx: Context, findingId: Id, body: JsonObject): Promise<Response> {
  return command(ctx, body, SCOPES.findingsWrite, { collection: 'findings', id: findingId }, (draft) => {
    const finding = entity<Finding>(draft, 'findings', findingId);
    requireFields(body, ['disposition', 'note']);
    const note = requireProse(body.note, 'note');
    const disposition = body.disposition;
    if (typeof disposition !== 'string') {
      fail(422, 'invalid_field', 'disposition must be a string');
    }
    if ((DERIVED_STATES as readonly string[]).includes(disposition)) {
      fail(422, 'derived_state_only', `"${disposition}" is derived from collector receipts and repair transitions, not set by disposition`, {
        nextAction:
          disposition === 'verified-fixed'
            ? 'link the original failing and repaired passing receipts through the collector completion path'
            : 'use the authenticated transition path for this state',
      });
    }
    if (!(PUBLIC_DISPOSITIONS as readonly string[]).includes(disposition)) {
      fail(422, 'invalid_disposition', `disposition must be one of: ${PUBLIC_DISPOSITIONS.join(', ')}`);
    }
    const from = finding.state;
    finding.state = disposition as FindingState;
    finding.note = finding.note === undefined ? note : `${finding.note}\n${note}`;
    touchEntity(finding, ctx, ctx.principal.id);
    appendEvent(draft, ctx, 'finding:disposition', finding.id, {
      from,
      to: disposition,
      receiptIds: finding.receiptIds,
    });
    return { status: 200, body: { finding: publicFinding(finding) } };
  });
}

function repairFinding(ctx: Context, findingId: Id, body: JsonObject): Promise<Response> {
  return command(ctx, body, SCOPES.findingsWrite, { collection: 'findings', id: findingId }, (draft) => {
    requireFields(body, ['assignmentId']);
    if (typeof body.assignmentId !== 'string') {
      fail(422, 'invalid_field', 'assignmentId must be a string');
    }
    const finding = noteRepairAssignment(draft, ctx, {
      findingId,
      assignmentId: body.assignmentId,
    });
    return { status: 200, body: { finding: publicFinding(finding) } };
  });
}

function recheckFinding(ctx: Context, findingId: Id, body: JsonObject): Promise<Response> {
  return command(ctx, body, SCOPES.findingsWrite, { collection: 'findings', id: findingId }, (draft) => {
    requireFields(body, ['candidateId']);
    if (typeof body.candidateId !== 'string') {
      fail(422, 'invalid_field', 'candidateId must be a string');
    }
    const finding = noteRepairSubmission(draft, ctx, {
      findingId,
      candidateId: body.candidateId,
    });
    return { status: 200, body: { finding: publicFinding(finding) } };
  });
}

/**
 * Module handler for findings endpoints. Segments are the suffix after
 * /api/v1/projects/:projectId. Returns null for unowned routes -- there is
 * deliberately no generic finding PATCH and no public receipt insert.
 */
export async function handleFindings(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (method === 'GET' && segments.length === 1 && segments[0] === 'findings') {
    return listFindings(ctx, request);
  }
  if (method === 'GET' && segments.length === 2 && segments[0] === 'findings') {
    const state = await ctx.store.read();
    requireScope(ctx.principal, SCOPES.read, state);
    const finding = entity<Finding>(state, 'findings', segments[1]);
    return json(200, { finding: publicFinding(finding) });
  }
  if (method === 'POST' && segments.length === 1 && segments[0] === 'findings' && body) {
    return createFinding(ctx, body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'findings' && segments[2] === 'disposition' && body) {
    return dispositionFinding(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'findings' && segments[2] === 'repair' && body) {
    return repairFinding(ctx, segments[1], body);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'findings' && segments[2] === 'recheck' && body) {
    return recheckFinding(ctx, segments[1], body);
  }
  return null;
}
