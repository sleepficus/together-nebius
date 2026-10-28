import {reviewOutcome} from './review-outcome.ts';
// Integration operation and reconciler (seat b-swe-04).
//
// An operation records intent (expected old canonical tip, candidate tip,
// scope, operation ID), drives the injected GitService push enforcing the
// expected tip, then reconciles by read-back:
//   pending -> dispatching -> confirmed | failed-no-effect |
//             effect-unconfirmed | unknown
// Rules (SPEC-AMENDMENT 3):
//   - the expected tip must be an ancestor of the candidate tip;
//   - an old-tip read while a dispatch may be in flight NEVER proves
//     failed-no-effect (only an ended/no-effect push report does);
//   - unknown/effect-unconfirmed operations are never repushed — retries
//     reconcile via read-back only; only a known ended/no-effect attempt
//     may repush, on the same durable operation;
//   - 'dispatching' is committed BEFORE the external push, so a crash can
//     never leave a possibly-landed push looking un-attempted ('pending');
//   - concurrent sibling pushes stay safe through the push expectedTip
//     precondition, then reconcile by attribution (never double-counted);
//   - sibling operations reconcile on matching AND different tips; a
//     confirmed effect may be attributed to an earlier operation and
//     Integrated events/status are never duplicated;
//   - only confirmed reconciliation writes Integrated — no UI or generic
//     update path can set it;
//   - a NEW operationId cannot bypass an unresolved canonical operation:
//     while any integrate operation on the same ref is non-terminal, a
//     fresh operation or a repush is rejected instead of dispatching a
//     second possibly-in-flight write;
//   - a stopped project blocks new dispatches (fresh push or repush);
//     read-only reconciliation and saved-result replays still proceed.

import {
  appendEvent, digestOf, entity, fail, json, requireScope, redactForeignMessageFields,
} from './core.ts';
import type {
  Candidate, Context, Id, Operation, OperationEffect, ProjectState, Sha,
} from './types.ts';

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

// Finding states that block a candidate from being Ready.
const BLOCKING_FINDINGS = new Set(['reproduced', 'repair-in-progress', 'recheck-needed']);

/**
 * Default acceptance policy v1: every registered check job has a pass
 * receipt on the EXACT candidate SHA, one independent approving review
 * exists on the exact SHA, and no confirmed-unresolved finding targets it.
 * Receipts/reviews bind candidateSha so a new SHA starts with no passing
 * evidence by construction. Reads receipts/reviews state only — no import
 * dependency on the checks/reviews module.
 */
export function readiness(state: ProjectState, candidate: Candidate): Readiness {
  const reasons: string[] = [];
  for(const proposalId of candidate.proposalIds){const proposal=state.proposals[proposalId];if(!proposal){reasons.push(`proposal ${proposalId} is missing`);continue;}for(const taskId of proposal.taskIds){const task=state.tasks[taskId];if(task?.requiredPlanRevisionId&&proposal.planRevisionId!==task.requiredPlanRevisionId)reasons.push(`proposal ${proposalId} targets plan ${proposal.planRevisionId??'none'}, task ${taskId} requires ${task.requiredPlanRevisionId}`);}}
  const passJobs = new Set<string>();
  for (const r of Object.values(state.receipts)) {
    if (!r.importedUnverified && r.candidateSha === candidate.sha && r.outcome === 'pass') passJobs.add(r.jobId);
  }
  if (candidate.checkJobIds.length === 0) {
    reasons.push('no required check jobs recorded for this candidate');
  }
  for (const jobId of candidate.checkJobIds) {
    if (!state.jobs[jobId]) {
      reasons.push(`check job ${jobId} is missing`);
    } else if (!passJobs.has(jobId)) {
      reasons.push(`check job ${jobId} has no pass receipt on sha ${candidate.sha}`);
    }
  }
  const outcome=reviewOutcome(state,candidate.sha);
  for(const r of outcome.requested)reasons.push(`review ${r.id} requests changes on this SHA`);
  const approved=outcome.approved.length>0;
  if (!approved) {
    reasons.push(`no independent approval on sha ${candidate.sha}`);
  }
  for (const f of Object.values(state.findings)) {
    if (f.candidateSha === candidate.sha && BLOCKING_FINDINGS.has(f.state)) {
      reasons.push(`unresolved finding ${f.id} in state ${f.state}`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface PushReport {
  ended: boolean;
  effect: 'updated' | 'no-effect' | 'unknown';
  reportStatus?: string;
}

export interface ReconcileInput {
  observedTip: Sha;
  expectedTip: Sha;
  candidateTip: Sha;
  push?: PushReport;
  /** isAncestor(candidateTip, observedTip) — only consulted on a third tip. */
  candidateIsAncestor?: boolean;
}

/**
 * Pure tip reconciliation. Read-back alone never attributes a landing:
 * "landed", "provably no effect" and "possibly in flight" stay distinct.
 */
export function reconcileTip(input: ReconcileInput): { effect: OperationEffect; note: string } {
  const { observedTip, expectedTip, candidateTip, push } = input;
  if (observedTip === candidateTip) {
    return { effect: 'confirmed', note: 'canonical tip matches the candidate SHA' };
  }
  if (observedTip === expectedTip) {
    if (push?.ended && push.effect === 'no-effect') {
      return {
        effect: 'failed-no-effect',
        note: `push ended without effect (${push.reportStatus ?? 'lease rejected'})`,
      };
    }
    if (push?.ended && push.effect === 'updated') {
      return {
        effect: 'unknown',
        note: 'push reported updated but read-back still shows the expected tip',
      };
    }
    return {
      effect: 'effect-unconfirmed',
      note: 'old tip observed while a dispatch may be in flight; retry only via read-back',
    };
  }
  if (input.candidateIsAncestor === true) {
    return {
      effect: 'confirmed',
      note: 'candidate is an ancestor of the observed tip (landed; ref advanced past it)',
    };
  }
  if (push?.ended && push.effect === 'no-effect') {
    return {
      effect: 'failed-no-effect',
      note: 'ref advanced to an unrelated tip; prepare a rebased candidate before retrying',
    };
  }
  return {
    effect: 'unknown',
    note: 'unrecognized tip and unresolved attribution; reconcile manually, never repush',
  };
}

// ---------------------------------------------------------------------------
// Endpoint handler
// ---------------------------------------------------------------------------

const INTEGRATE_SCOPE = 'integrate';
const TERMINAL = new Set<OperationEffect>(['confirmed', 'failed-no-effect']);

/**
 * Another non-terminal integrate operation on the same canonical ref.
 * While one exists, its push may still be in flight, so no other
 * operation may dispatch a second canonical write.
 */
function unresolvedCanonicalOp(
  draft: ProjectState,
  ref: string,
  excludeId: Id,
): Operation | undefined {
  return Object.values(draft.operations).find(
    (o) => o.id !== excludeId && o.intent === 'integrate' &&
      o.ref === ref && !TERMINAL.has(o.effect),
  ) as Operation | undefined;
}

/**
 * Dispatch gate shared by every 'push' decision (fresh intent, pending
 * resume and known-ended repush). A stopped project blocks new dispatch
 * and an unresolved canonical sibling blocks a bypass — the caller must
 * reconcile the named operation before any new write may be attempted.
 */
function gateCanonicalDispatch(draft: ProjectState, operationId: Id): void {
  if (draft.stopped) {
    fail(409, 'project_stopped', 'project is stopped; new integration dispatches are blocked');
  }
  const ref = draft.project.canonicalRef;
  const blocker = unresolvedCanonicalOp(draft, ref, operationId);
  if (blocker) {
    fail(409, 'operation_in_flight',
      `integration operation ${blocker.id} is unresolved on ${ref} (${blocker.effect}); ` +
      'reconcile it before dispatching a new canonical write', {
        nextAction: `GET /api/v1/projects/${draft.project.id}/operations/${blocker.id}`,
      });
  }
}

interface IntegrateDecision {
  mode: 'final' | 'push' | 'reconcile';
  final?: { status: number; body: unknown };
  ref?: string;
  expectedTip?: Sha;
  candidateTip?: Sha;
}


export async function handleIntegration(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  if (request.method === 'GET' && segments.length === 2 && segments[0] === 'operations') {
    return getOperation(ctx, segments[1]);
  }
  if (
    request.method === 'POST' &&
    segments.length === 3 &&
    segments[0] === 'candidates' &&
    segments[2] === 'integrate'
  ) {
    return integrate(ctx, segments[1], body ?? {});
  }
  return null;
}

async function getOperation(ctx: Context, id: string): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, 'read', state);
  const op = state.operations[id] as Operation | undefined;
  if (!op) fail(404, 'not_found', `operations/${id} does not exist`);
  return json(200, { operation: redactForeignMessageFields(op, ctx.principal) });
}

async function integrate(
  ctx: Context,
  candidateId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (typeof body.operationId !== 'string' || body.operationId.length === 0) {
    fail(422, 'missing_operation', 'operationId is required for write operations');
  }
  const operationId = body.operationId;
  const expectedTip = body.expectedTip;
  if (typeof expectedTip !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expectedTip)) {
    fail(422, 'invalid_sha', 'expectedTip must be the 40- or 64-hex canonical tip the caller expects');
  }
  if (!ctx.git) {
    fail(503, 'git_unavailable', 'integration requires the bounded Git service', {
      nextAction: 'configure a GitService before requesting integration',
    });
  }
  const git = ctx.git;
  const target = { collection: 'candidates' as const, id: candidateId };
  const digest = await digestOf({ scope: INTEGRATE_SCOPE, target, body });

  // Phase A — resolve operation id/digest BEFORE stale checks, then decide
  // whether this request pushes, reconciles or replays.
  const decision = await ctx.store.transact((draft): IntegrateDecision => {
    requireScope(ctx.principal, INTEGRATE_SCOPE, draft);
    const candidate = entity<Candidate>(draft, 'candidates', candidateId);
    const prior = draft.operations[operationId] as Operation | undefined;

    if (prior) {
      if (prior.importedUnverified) fail(409, 'imported_operation', 'archived operations cannot be replayed or resumed; use a new operationId for current work');
      if (prior.digest !== digest) {
        fail(409, 'conflicting_operation', 'operationId reused with a different payload', {
          nextAction: 'use a new operationId',
        });
      }
      if (prior.result && prior.effect === 'confirmed') {
        // Repair a historical projection reset by a later check. The durable
        // confirmed operation already proves this exact landing; no Git call.
        if (!candidate.importedUnverified && candidate.sha === prior.candidateTip &&
            prior.candidateId === candidate.id && candidate.status !== 'superseded') {
          candidate.status = 'integrated'; candidate.integrateOperationId = operationId;
        }
        return { mode: 'final', final: prior.result as { status: number; body: unknown } };
      }
      if (prior.effect === 'failed-no-effect' || prior.effect === 'pending') {
        // 'failed-no-effect' is the only retryable state: the earlier
        // attempt is KNOWN to have ended without effect; 'pending' means
        // the push was never attempted (dispatching is committed before
        // any external effect). Either may repush on the same durable
        // operation — but never while the project is stopped or another
        // canonical dispatch is unresolved.
        gateCanonicalDispatch(draft, operationId);
        return {
          mode: 'push',
          ref: String(prior.ref),
          expectedTip: String(prior.expectedTip) as Sha,
          candidateTip: String(prior.candidateTip) as Sha,
        };
      }
      // Anything else may be in flight — only read-back reconciliation
      // is safe, NEVER repush.
      return {
        mode: 'reconcile',
        ref: String(prior.ref),
        expectedTip: String(prior.expectedTip) as Sha,
        candidateTip: String(prior.candidateTip) as Sha,
      };
    }

    if (body.expectedRevision !== undefined) {
      if (candidate.revision !== body.expectedRevision) {
        fail(409, 'stale_revision',
          `expected revision ${body.expectedRevision}, current revision ${candidate.revision}`,
          { nextAction: 're-read the candidate and retry with the current revision' });
      }
    }
    if (candidate.status === 'integrated') {
      const result = {
        status: 200,
        body: {
          operationId,
          effect: 'confirmed',
          deduplicated: true,
          candidate,
          reconciliation: 'candidate already integrated; duplicate Integrated suppressed',
        },
      };
      const now = ctx.now();
      draft.operations[operationId] = {
        id: operationId, projectId: draft.project.id, revision: 1,
        createdAt: now, updatedAt: now, actorId: ctx.principal.id,
        scope: INTEGRATE_SCOPE, target, digest,
        expectedRevision: body.expectedRevision as number | undefined,
        intent: 'integrate', effect: 'confirmed', result,
        ref: draft.project.canonicalRef, expectedTip, candidateTip: candidate.sha,
        candidateId: candidate.id, pushAttempts: 0,
        reconciliation: 'candidate already integrated at request time',
      } as Operation;
      return { mode: 'final', final: result };
    }
    const r = readiness(draft, candidate);
    if (!r.ready) {
      fail(422, 'not_ready', 'candidate does not satisfy the acceptance policy', {
        nextAction: 'resolve the readiness reasons and retry',
      });
    }

    gateCanonicalDispatch(draft, operationId);

    const now = ctx.now();
    draft.operations[operationId] = {
      id: operationId, projectId: draft.project.id, revision: 1,
      createdAt: now, updatedAt: now, actorId: ctx.principal.id,
      scope: INTEGRATE_SCOPE, target, digest,
      expectedRevision: body.expectedRevision as number | undefined,
      intent: 'integrate', effect: 'pending',
      ref: draft.project.canonicalRef, expectedTip, candidateTip: candidate.sha,
      candidateId: candidate.id, pushAttempts: 0,
    } as Operation;
    appendEvent(draft, ctx, 'operation:intent', candidate.id, {
      operationId, intent: 'integrate', expectedTip, candidateTip: candidate.sha,
      ref: draft.project.canonicalRef,
    });
    return {
      mode: 'push',
      ref: draft.project.canonicalRef,
      expectedTip,
      candidateTip: candidate.sha,
    };
  });

  if (decision.mode === 'final' && decision.final) {
    return json(decision.final.status, decision.final.body);
  }

  // Phase B — external effects happen OUTSIDE the transaction.
  let pushReport: PushReport | undefined;
  if (decision.mode === 'push') {
    // Commit 'dispatching' BEFORE the push: if the process dies after the
    // push lands but before Phase C persists, the stored effect is not
    // 'pending', so a retry reconciles by read-back instead of repushing a
    // possibly-landed dispatch.
    await ctx.store.transact((draft) => {
      const op = draft.operations[operationId] as Operation | undefined;
      if (op !== undefined) op.effect = 'dispatching';
      return true;
    });
    if (!(await git.isAncestor(decision.expectedTip!, decision.candidateTip!))) {
      const result = {
        status: 409,
        body: {
          error: {
            status: 409, code: 'stale_tip', retryable: false,
            message: 'expected canonical tip is not an ancestor of the candidate; the base moved',
            nextAction: 'prepare a new candidate on the current canonical tip',
          },
        },
      };
      await finalizeOperation(ctx, operationId, 'failed-no-effect', result,
        'expected tip is not an ancestor of the candidate', undefined);
      return json(result.status, result.body);
    }
    const pushed = await git.push({
      ref: decision.ref!,
      expectedTip: decision.expectedTip!,
      candidateTip: decision.candidateTip!,
      operationId,
    });
    pushReport = pushed;
  }
  const observedTip = await git.readTip(decision.ref!);
  let candidateIsAncestor: boolean | undefined;
  if (observedTip !== decision.expectedTip && observedTip !== decision.candidateTip) {
    candidateIsAncestor = await git.isAncestor(decision.candidateTip!, observedTip);
  }
  const outcome = reconcileTip({
    observedTip, expectedTip: decision.expectedTip!,
    candidateTip: decision.candidateTip!, push: pushReport, candidateIsAncestor,
  });

  // Phase C — persist per-ref push status, effect and the reconciled
  // candidate transition in one transaction.
  const result = await ctx.store.transact((draft) => {
    const op = draft.operations[operationId] as Operation;
    op.effect = outcome.effect;
    op.reconciliation = outcome.note;
    op.pushAttempts = ((op.pushAttempts as number | undefined) ?? 0) + (pushReport ? 1 : 0);
    op.pushStatus = {
      ref: decision.ref,
      expectedTip: decision.expectedTip,
      candidateTip: decision.candidateTip,
      observedTip,
      reportStatus: pushReport?.reportStatus,
      attempts: op.pushAttempts,
    };

    const candidate = entity<Candidate>(draft, 'candidates', candidateId);
    let httpStatus: number;
    let responseBody: Record<string, unknown>;

    if (outcome.effect === 'confirmed') {
      let attribution = 'this operation';
      if (candidate.status !== 'integrated') {
        candidate.status = 'integrated';
        candidate.integrateOperationId = operationId;
        candidate.revision += 1;
        candidate.updatedAt = ctx.now();
        for (const pid of candidate.proposalIds) {
          const proposal = draft.proposals[pid];
          if (proposal && proposal.lifecycle !== 'integrated') {
            proposal.lifecycle = 'integrated';
            proposal.revision += 1;
            proposal.updatedAt = ctx.now();
          }
        }
        appendEvent(draft, ctx, 'candidate:integrated', candidate.id, {
          operationId, sha: candidate.sha, ref: decision.ref, observedTip,
        });
      } else {
        attribution = 'an earlier operation';
      }
      // Reconcile sibling operations on the same candidate: attribute the
      // landing on a tip match, never emit a second Integrated event.
      for (const other of Object.values(draft.operations)) {
        if (other.id === operationId || other.intent !== 'integrate') continue;
        if ((other.candidateId as string | undefined) !== candidate.id) continue;
        if (TERMINAL.has(other.effect)) continue;
        if (other.candidateTip === observedTip) {
          other.effect = 'confirmed';
          other.reconciliation =
            `attributed to operation ${operationId}; duplicate Integrated suppressed`;
        } else {
          other.reconciliation =
            `observed tip ${observedTip} differs from candidate tip ${other.candidateTip}`;
        }
      }
      httpStatus = 200;
      responseBody = {
        operationId, effect: 'confirmed', attribution,
        reconciliation: outcome.note, candidate,
      };
    } else if (outcome.effect === 'failed-no-effect') {
      httpStatus = 200;
      responseBody = {
        operationId, effect: 'failed-no-effect', retryable: true,
        reconciliation: outcome.note, candidate,
        nextAction: 'retry with the same operationId, or prepare a new candidate if the tip moved',
      };
    } else {
      httpStatus = 202;
      responseBody = {
        operationId, effect: outcome.effect,
        reconciliation: outcome.note, candidate,
        nextAction: `GET /api/v1/projects/${draft.project.id}/operations/${operationId}`,
      };
    }
    op.result = { status: httpStatus, body: responseBody };
    return { status: httpStatus, body: responseBody };
  });

  return json(result.status, result.body);
}

async function finalizeOperation(
  ctx: Context,
  operationId: string,
  effect: OperationEffect,
  result: { status: number; body: unknown },
  reconciliation: string,
  pushStatus: unknown,
): Promise<void> {
  await ctx.store.transact((draft) => {
    const op = draft.operations[operationId] as Operation | undefined;
    if (!op) return false;
    op.effect = effect;
    op.result = result;
    op.reconciliation = reconciliation;
    if (pushStatus !== undefined) op.pushStatus = pushStatus;
    return true;
  });
}
