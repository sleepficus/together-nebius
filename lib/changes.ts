// Change proposals and combination candidates (seat b-swe-04).
//
// A proposal is an IMMUTABLE revision binding task IDs, author/session,
// base+head commits, summary, intended behavior, changed paths, evidence
// refs and unknowns. New code means a new proposal (`supersedes` link); a
// new revision never inherits the old review.
//
// A candidate is an immutable system record: canonical base + ordered
// proposal revisions + exact heads + resulting SHA + policy revision. Never
// a claimable task, no portrait slot. Identity is content-based: same
// SHA/base/canonically-equal heads returns the existing record instead of
// double-counting. `proposalHeads` compares by canonical key/value
// equality, independent of key insertion order.
//
// Owned endpoints (after /api/v1/projects/:projectId):
//   GET  /changes                list proposals   POST /changes   submit
//   GET  /changes/:id            one proposal
//   POST /changes/:id/transition lifecycle (Integrated is reserved)
//   GET  /candidates             list w/ readiness
//   POST /candidates             prepare a combination candidate only
//   GET  /candidates/:id         one candidate w/ readiness
//
// Combine persists durable intent first, runs the real Git merge through
// the injected GitService OUTSIDE the transaction, then persists candidate
// + operation result + event atomically. Missing service -> 503, never a
// fabricated SHA.

import {
  appendEvent, canonicalJSON, command, digestOf, entity, fail, json,
  requireFields, requireProse, requireScope,
} from './core.ts';
import { readiness } from './integration.ts';
import type {
  Candidate, Context, Id, Operation, Proposal, ProposalLifecycle, ProjectState, Sha,
} from './types.ts';

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const WRITE_SCOPE = 'changes:write';

const LIFECYCLES: ProposalLifecycle[] = [
  'draft', 'submitted', 'changes-requested', 'ready-to-combine', 'integrated', 'withdrawn',
];

// Forward-only transitions; `integrated` is reconciler-only.
const TRANSITIONS: Record<ProposalLifecycle, ProposalLifecycle[]> = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['changes-requested', 'ready-to-combine', 'withdrawn'],
  'changes-requested': ['submitted', 'withdrawn'],
  'ready-to-combine': ['submitted', 'changes-requested', 'withdrawn'],
  integrated: [],
  withdrawn: [],
};

function shaField(value: unknown, field: string): Sha {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    fail(422, 'invalid_sha', `"${field}" must be a 40- or 64-hex commit SHA`);
  }
  return value;
}

function stringArray(value: unknown, field: string, maxItems = 512, maxLen = 512): string[] {
  if (!Array.isArray(value)) {
    fail(422, 'invalid_field', `"${field}" must be an array of strings`);
  }
  if (value.length > maxItems) {
    fail(422, 'invalid_field', `"${field}" exceeds ${maxItems} items`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > maxLen) {
      fail(422, 'invalid_field', `"${field}" entries must be strings up to ${maxLen} chars`);
    }
    out.push(item);
  }
  return out;
}

function optStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  return stringArray(value, field);
}

function proposalView(p: Proposal): Record<string, unknown> {
  const { projectId: _drop, ...rest } = p;
  return rest;
}

function candidateView(state: ProjectState, c: Candidate): Record<string, unknown> {
  return { ...c, readiness: readiness(state, c) };
}

export async function handleChanges(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const [head, id, sub] = segments;

  if (head === 'changes' && segments.length === 3 && id && sub === 'reports') {
    if (request.method === 'GET') {
      const state = await ctx.store.read(); requireScope(ctx.principal, 'read', state);
      entity<Proposal>(state, 'proposals', id);
      return json(200, { authorReports:Object.values(state.authorReports).filter(r=>r.proposalId===id), provenance:'author-claimed' });
    }
    if (request.method === 'POST') return command(ctx, body ?? {}, WRITE_SCOPE, { collection:'authorReports' }, draft => {
      const proposal = entity<Proposal>(draft, 'proposals', id);
      if (proposal.authorId !== ctx.principal.id) fail(403, 'author_required', 'only this proposal author can attach an author report');
      const claims = requireProse(body?.claims, 'claims');
      const now = ctx.now(); const report = { id:ctx.uid(), projectId:draft.project.id, revision:1, createdAt:now, updatedAt:now, actorId:ctx.principal.id, proposalId:id, authorId:ctx.principal.id, claims, artifactRefs:optStringArray(body?.artifactRefs,'artifactRefs') };
      draft.authorReports[report.id] = report;
      appendEvent(draft,ctx,'author-report:submitted',report.id,{proposalId:id,provenance:'author-claimed'});
      return { status:201, body:{authorReport:report,provenance:'author-claimed'} };
    });
  }

  if (head === 'changes') {
    if (segments.length === 1 && request.method === 'GET') {
      return listProposals(ctx);
    }
    if (segments.length === 1 && request.method === 'POST') {
      return submitProposal(ctx, body ?? {});
    }
    if (segments.length === 2 && request.method === 'GET' && id) {
      return getProposal(ctx, id);
    }
    if (segments.length === 3 && request.method === 'POST' && sub === 'transition' && id) {
      return transitionProposal(ctx, id, body ?? {});
    }
    return null;
  }

  if (head === 'candidates') {
    if (segments.length === 1 && request.method === 'GET') {
      return listCandidates(ctx);
    }
    if (segments.length === 1 && request.method === 'POST') {
      return combine(ctx, body ?? {});
    }
    if (segments.length === 2 && request.method === 'GET' && id) {
      return getCandidate(ctx, id);
    }
    // POST /candidates/:id/integrate is owned by lib/integration.ts.
    return null;
  }

  return null;
}

async function listProposals(ctx: Context): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, 'read', state);
  const proposals = Object.values(state.proposals)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(proposalView);
  return json(200, { proposals });
}

async function getProposal(ctx: Context, id: string): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, 'read', state);
  return json(200, { proposal: proposalView(entity<Proposal>(state, 'proposals', id)) });
}

async function submitProposal(ctx: Context, body: Record<string, unknown>): Promise<Response> {
  requireFields(body, ['taskIds', 'base', 'head', 'summary', 'intendedBehavior', 'changedPaths']);
  return command(ctx, body, WRITE_SCOPE, { collection: 'proposals' }, (draft) => {
    const taskIds = stringArray(body.taskIds, 'taskIds', 64);
    for (const taskId of taskIds) {const task=entity(draft, 'tasks', taskId);if(task.requiredPlanRevisionId&&typeof body.planRevisionId!=='string')fail(422,'plan_revision_required','Declare the plan revision used by this proposal');}
    if(body.planRevisionId&&!draft.planRevisions?.[String(body.planRevisionId)])fail(404,'plan_not_found','Unknown plan revision');
    const base = shaField(body.base, 'base');
    const head = shaField(body.head, 'head');
    const summary = requireProse(body.summary, 'summary');
    const intendedBehavior = requireProse(body.intendedBehavior, 'intendedBehavior');
    const changedPaths = stringArray(body.changedPaths, 'changedPaths');
    const evidenceRefs = optStringArray(body.evidenceRefs, 'evidenceRefs');
    const unknowns = optStringArray(body.unknowns, 'unknowns');
    let supersedes: Id | undefined;
    if (body.supersedes !== undefined && body.supersedes !== null) {
      supersedes = entity<Proposal>(draft, 'proposals', String(body.supersedes)).id;
    }
    const now = ctx.now();
    const proposal: Proposal = {
      id: ctx.uid(), projectId: draft.project.id, revision: 1,
      createdAt: now, updatedAt: now, actorId: ctx.principal.id,
      taskIds, authorId: ctx.principal.id, sessionId: ctx.principal.sessionId,
      base, head, summary, intendedBehavior, changedPaths, evidenceRefs, unknowns,
      lifecycle: 'submitted', supersedes, ...(body.planRevisionId?{planRevisionId:String(body.planRevisionId)}:{}),
    };
    draft.proposals[proposal.id] = proposal;
    appendEvent(draft, ctx, 'proposal:submitted', proposal.id, { taskIds, base, head });
    return { status: 201, body: { proposal: proposalView(proposal) } };
  });
}

async function transitionProposal(
  ctx: Context,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  requireFields(body, ['to']);
  const to = body.to;
  if (to === 'integrated') {
    // Written only by the reconciler on a confirmed effect.
    fail(422, 'reserved_state', 'integrated is set only by confirmed integration reconciliation');
  }
  if (typeof to !== 'string' || !LIFECYCLES.includes(to as ProposalLifecycle)) {
    fail(422, 'invalid_field', `"to" must be one of ${LIFECYCLES.join(', ')}`);
  }
  return command(
    ctx, body, WRITE_SCOPE, { collection: 'proposals', id },
    (draft) => {
      const proposal = entity<Proposal>(draft, 'proposals', id);
      const allowed = TRANSITIONS[proposal.lifecycle];
      if (!allowed.includes(to as ProposalLifecycle)) {
        fail(409, 'invalid_transition',
          `proposal ${id} cannot transition ${proposal.lifecycle} -> ${to}`);
      }
      const from = proposal.lifecycle;
      proposal.lifecycle = to as ProposalLifecycle;
      appendEvent(draft, ctx, 'proposal:transition', id, { from, to });
      return { status: 200, body: { proposal: proposalView(proposal) } };
    },
  );
}

async function listCandidates(ctx: Context): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, 'read', state);
  const candidates = Object.values(state.candidates)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => candidateView(state, c));
  return json(200, { candidates });
}

async function getCandidate(ctx: Context, id: string): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, 'read', state);
  const candidate = entity<Candidate>(state, 'candidates', id);
  return json(200, { candidate: candidateView(state, candidate) });
}

interface CombinePlan {
  kind: 'replay' | 'proceed';
  result?: { status: number; body: unknown };
  proposalIds?: Id[];
  heads?: Record<Id, Sha>;
}

/**
 * POST /candidates — prepare ONLY; never writes the canonical ref. Phases:
 * A. validate + dedupe + persist durable intent; B. resolve the canonical
 * base and run the real merge via GitService (outside the transaction);
 * C. persist the immutable candidate, operation result and event.
 */
async function combine(ctx: Context, body: Record<string, unknown>): Promise<Response> {
  if (typeof body.operationId !== 'string' || body.operationId.length === 0) {
    fail(422, 'missing_operation', 'operationId is required for write operations');
  }
  const operationId = body.operationId;
  const target = { collection: 'candidates' as const };
  const digest = await digestOf({ scope: 'changes:combine', target, body });

  const plan = await ctx.store.transact((draft): CombinePlan => {
    requireScope(ctx.principal, WRITE_SCOPE, draft);
    const prior = draft.operations[operationId] as Operation | undefined;
    if (prior) {
      if (prior.importedUnverified) fail(409, 'imported_operation', 'archived operations cannot be replayed or resumed; use a new operationId for current work');
      if (prior.digest !== digest) {
        fail(409, 'conflicting_operation', 'operationId reused with a different payload', {
          nextAction: 'use a new operationId',
        });
      }
      if (prior.result) {
        return { kind: 'replay', result: prior.result as { status: number; body: unknown } };
      }
      // Resumed after an interrupted prepare; the merge is content-
      // deterministic, so re-driving cannot double-count.
    }
    const proposalIds = [...new Set(stringArray(body.proposalIds, 'proposalIds', 64))];
    if (proposalIds.length === 0) {
      fail(422, 'missing_field', 'proposalIds must name at least one proposal');
    }
    const heads: Record<Id, Sha> = {};
    for (const pid of proposalIds) {
      const proposal = entity<Proposal>(draft, 'proposals', pid);
      if (proposal.lifecycle !== 'submitted' && proposal.lifecycle !== 'ready-to-combine') {
        fail(409, 'invalid_state',
          `proposal ${pid} is ${proposal.lifecycle}; only submitted or ready-to-combine proposals combine`);
      }
      heads[pid] = proposal.head;
    }
    if (!prior) {
      const now = ctx.now();
      draft.operations[operationId] = {
        id: operationId, projectId: draft.project.id, revision: 1,
        createdAt: now, updatedAt: now, actorId: ctx.principal.id,
        scope: 'changes:combine', target, digest,
        intent: 'combine', effect: 'pending',
        proposalIds, proposalHeads: heads,
      } as Operation;
      appendEvent(draft, ctx, 'operation:intent', undefined, {
        operationId, intent: 'combine', proposalIds,
      });
    }
    if (draft.stopped) {
      fail(409, 'project_stopped', 'project is stopped; new combine dispatches are blocked');
    }
    return { kind: 'proceed', proposalIds, heads };
  });

  if (plan.kind === 'replay' && plan.result) {
    return json(plan.result.status, plan.result.body);
  }
  if (!ctx.git) {
    fail(503, 'git_unavailable', 'combination requires the bounded Git service', {
      nextAction: 'configure a GitService before combining proposals',
    });
  }

  const base = await ctx.git.readTip((await ctx.store.read()).project.canonicalRef);
  const prepared = await ctx.git.prepare({
    projectId: (await ctx.store.read()).project.id,
    base,
    proposals: plan.proposalIds!.map((pid) => ({ id: pid, head: plan.heads![pid] })),
    operationId,
  });

  const final = await ctx.store.transact((draft) => {
    const op = draft.operations[operationId] as Operation;
    if (prepared.conflicts && prepared.conflicts.length > 0) {
      const result = {
        status: 422,
        body: {
          error: {
            status: 422, code: 'merge_conflict', retryable: false,
            message: 'proposal heads conflict in the combined worktree',
            conflicts: prepared.conflicts,
            nextAction: 'resolve the conflicted paths and submit a new proposal revision',
          },
        },
      };
      op.effect = 'failed-no-effect';
      op.reconciliation = 'merge conflict; no candidate produced';
      op.result = result;
      appendEvent(draft, ctx, 'candidate:conflict', undefined, {
        operationId, proposalIds: plan.proposalIds, conflicts: prepared.conflicts,
      });
      return result;
    }

    // Content dedupe: same SHA + base + canonically equal heads is the
    // SAME candidate — repeated operations never double-count.
    const headsCanonical = canonicalJSON(prepared.proposalHeads);
    let candidate = Object.values(draft.candidates).find(
      (c) => c.sha === prepared.sha && c.base === prepared.base &&
        canonicalJSON(c.proposalHeads) === headsCanonical,
    );
    const created = candidate === undefined;
    if (!candidate) {
      const now = ctx.now();
      candidate = {
        id: ctx.uid(), projectId: draft.project.id, revision: 1,
        createdAt: now, updatedAt: now, actorId: ctx.principal.id,
        base: prepared.base,
        proposalIds: plan.proposalIds!,
        proposalHeads: prepared.proposalHeads,
        sha: prepared.sha,
        changedPaths:prepared.changedPaths,
        ...(prepared.diffPreview?{diffPreview:prepared.diffPreview}:{}),
        policyVersion: draft.project.acceptancePolicyRevision,
        status: 'prepared',
        checkJobIds: [],
        reviewIds: [],
      };
      draft.candidates[candidate.id] = candidate;
      appendEvent(draft, ctx, 'candidate:prepared', candidate.id, {
        operationId, sha: candidate.sha, base: candidate.base,
        proposalIds: candidate.proposalIds, changedPaths: prepared.changedPaths,
      });
    }
    op.effect = 'confirmed';
    op.candidateId = candidate.id;
    const result = {
      status: created ? 201 : 200,
      body: {
        candidate: candidateView(draft, candidate),
        deduplicated: !created,
      },
    };
    op.result = result;
    return result;
  });

  return json(final.status, final.body);
}
