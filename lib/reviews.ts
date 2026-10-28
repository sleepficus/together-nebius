// Candidate reviews and independence evaluation for the Together slice
// (seat b-swe-05). Independence policy version 1 (spec amendment 4):
//
// - Every candidate author is excluded -- by stable identity, so a second
//   session or display-name alias of an author fails identically.
// - A descendant of an author fails (recorded parentId ancestry chain).
// - A same-owning-user delegated child created AFTER the earliest proposal
//   in the candidate fails.
// - A pre-existing same-owner peer passes when recorded ancestry shows no
//   author relationship; a pre-existing child of an author still fails.
// - A human reviewer who is not an author is independent (human authors
//   cannot approve their own work).
// - Unknown agent ancestry can never silently certify independence.
// - Externally concealed common control remains a documented assurance
//   limit, not a solved problem.
//
// Non-independent reviews are still stored with their reason and policy
// version: useful evidence, never counted as independent approval.

import {
  PAGE_LIMIT, appendEvent, command, entity, fail, json, requireFields,
  requireProse, requireScope,
} from './core.ts';
import type {
  AgentIdentity, Candidate, Context, Id, ProjectState, Review,
} from './types.ts';

export const SCOPES = {
  read: 'read',
  reviewsWrite: 'reviews:write',
} as const;

export const INDEPENDENCE_POLICY_VERSION = 1;

export const DISPOSITIONS = ['approve', 'request-changes', 'comment'] as const;
export type ReviewDisposition = (typeof DISPOSITIONS)[number];

export interface IndependenceInput {
  candidateId: Id;
  reviewerId: Id;
  /** Principal kind; required to distinguish a human from an unrecorded agent. */
  reviewerKind?: string;
}

export interface IndependenceResult {
  independent: boolean;
  reason: string;
  policyVersion: number;
}

export function publicReview(r: Review): Record<string, unknown> {
  return {
    id: r.id,
    revision: r.revision,
    candidateId: r.candidateId,
    candidateSha: r.candidateSha,
    reviewerId: r.reviewerId,
    policyVersion: r.policyVersion,
    disposition: r.disposition,
    independent: r.independent,
    independenceReason: r.independenceReason,
    findingIds: r.findingIds,
    note: (r as { note?: string }).note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    actorId: r.actorId,
  };
}

/**
 * Evaluate review independence for `reviewerId` against `candidateId`.
 * Pure read over state -- callable inside or outside a transaction.
 */
export function evaluateIndependence(
  state: ProjectState,
  input: IndependenceInput,
): IndependenceResult {
  const candidate = entity<Candidate>(state, 'candidates', input.candidateId);
  const V = INDEPENDENCE_POLICY_VERSION;
  const no = (reason: string): IndependenceResult => ({ independent: false, reason, policyVersion: V });
  const yes = (reason: string): IndependenceResult => ({ independent: true, reason, policyVersion: V });

  const proposals = candidate.proposalIds
    .map((pid) => state.proposals[pid])
    .filter((p): p is NonNullable<typeof p> => p !== undefined);
  const authors = new Set<Id>(proposals.map((p) => p.authorId));

  // Stable-identity exclusion: author, alias and second session share the id.
  if (authors.has(input.reviewerId)) {
    return no('reviewer-authored-candidate');
  }

  const reviewer = state.identities[input.reviewerId];
  if (reviewer !== undefined) {
    // Recorded ancestry: walk the parent chain for an author relationship.
    let current: AgentIdentity | undefined = reviewer;
    const seen = new Set<Id>();
    while (current !== undefined && current.parentId !== undefined && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      if (authors.has(current.parentId)) {
        return no('reviewer-descends-from-author');
      }
      current = state.identities[current.parentId];
    }

    // Same-owning-user delegated child created after the earliest proposal.
    if (reviewer.parentId !== undefined) {
      const earliest = proposals.map((p) => p.createdAt).sort()[0];
      if (earliest !== undefined && reviewer.createdAt >= earliest) {
        const authorOwners = new Set<Id>(
          proposals.map((p) => state.identities[p.authorId]?.ownerId ?? p.authorId),
        );
        if (authorOwners.has(reviewer.ownerId)) {
          return no('same-owner-delegated-child-after-earliest-proposal');
        }
      }
    }
    return yes('independent-identity');
  }

  // Humans are authenticated principals outside the identity collection; a
  // human who did not author the candidate satisfies the review policy.
  if (input.reviewerKind === 'human') {
    return yes('independent-human');
  }

  // Agent/collector reviewer without an identity record: provenance unknown.
  return no('unknown-ancestry');
}

function parseFindingIds(state: ProjectState, value: unknown): Id[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    fail(422, 'invalid_field', 'findingIds must be an array of at most 64 ids');
  }
  return value.map((v) => {
    if (typeof v !== 'string') fail(422, 'invalid_field', 'findingIds entries must be strings');
    entity(state, 'findings', v);
    return v;
  });
}

async function listCandidateReviews(ctx: Context, candidateId: Id): Promise<Response> {
  const state = await ctx.store.read();
  requireScope(ctx.principal, SCOPES.read, state);
  const candidate = entity<Candidate>(state, 'candidates', candidateId);
  const reviews = candidate.reviewIds
    .map((id) => state.reviews[id])
    .filter((r): r is Review => r !== undefined)
    .map(publicReview);
  return json(200, { reviews, count: reviews.length });
}

function createReview(ctx: Context, candidateId: Id, body: Record<string, unknown>): Promise<Response> {
  return command(ctx, body, SCOPES.reviewsWrite, { collection: 'candidates', id: candidateId }, (draft) => {
    // A review is human or agent judgement; system/collector principals have
    // no review authority of their own.
    if (ctx.principal.kind === 'system' || ctx.principal.kind === 'collector') {
      fail(403, 'reviewer_kind', 'reviews must come from an authenticated human or agent');
    }
    const candidate = entity<Candidate>(draft, 'candidates', candidateId);
    requireFields(body, ['disposition', 'candidateSha']);
    const disposition = body.disposition;
    if (typeof disposition !== 'string' || !(DISPOSITIONS as readonly string[]).includes(disposition)) {
      fail(422, 'invalid_field', `disposition must be one of: ${DISPOSITIONS.join(', ')}`);
    }
    // Reviews bind the exact candidate SHA; a stale SHA is a recheck, not a
    // review of the current candidate.
    if (body.candidateSha !== candidate.sha) {
      fail(409, 'stale_candidate_sha', `candidate sha is ${candidate.sha}; reviews bind the exact sha`, {
        nextAction: 're-read the candidate, then review the current sha',
      });
    }
    const findingIds = parseFindingIds(draft, body.findingIds);
    const note = body.note === undefined ? undefined : requireProse(body.note, 'note');
    const independence = evaluateIndependence(draft, {
      candidateId: candidate.id,
      reviewerId: ctx.principal.id,
      reviewerKind: ctx.principal.kind,
    });
    const now = ctx.now();
    const review: Review = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      candidateId: candidate.id,
      candidateSha: candidate.sha,
      reviewerId: ctx.principal.id,
      policyVersion: independence.policyVersion,
      disposition: disposition as ReviewDisposition,
      independent: independence.independent,
      independenceReason: independence.reason,
      findingIds,
      ...(note !== undefined ? { note } : {}),
    };
    draft.reviews[review.id] = review;
    candidate.reviewIds.push(review.id);
    appendEvent(draft, ctx, 'candidate:reviewed', candidate.id, {
      reviewId: review.id,
      candidateSha: candidate.sha,
      disposition: review.disposition,
      independent: review.independent,
      independenceReason: review.independenceReason,
      policyVersion: review.policyVersion,
    });
    return { status: 201, body: { review: publicReview(review) } };
  });
}

/**
 * Module handler for candidate review endpoints. Segments are the suffix
 * after /api/v1/projects/:projectId. Returns null for unowned routes.
 */
export async function handleReviews(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (method === 'GET' && segments.length === 3 && segments[0] === 'candidates' && segments[2] === 'reviews') {
    return listCandidateReviews(ctx, segments[1]);
  }
  if (method === 'POST' && segments.length === 3 && segments[0] === 'candidates' && segments[2] === 'reviews' && body) {
    return createReview(ctx, segments[1], body);
  }
  return null;
}
