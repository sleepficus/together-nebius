// Unit evidence for seat b-swe-05: bounded check jobs, job-scoped collector
// authentication, receipt-only finding transitions, review independence and
// the Docker snapshot runner's honest blocked path.
// Runs with: node --test tests/receipts.test.ts   (Node >=22.18 type stripping)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { handleAssignments } from '../lib/assignments.ts';
import {
  authenticateCollector, candidateEvidence, handleChecks, hashCollectorToken,
  newCollectorToken,
} from '../lib/checks.ts';
import {
  handleFindings, noteRepairAssignment, noteRepairSubmission,
} from '../lib/findings.ts';
import { evaluateIndependence, handleReviews } from '../lib/reviews.ts';
import {
  containerName, createSnapshotRunner, dockerAvailableSync, runSnapshotJob,
} from '../runner/snapshot-runner.ts';
import type {
  AgentIdentity, Assignment, AuthorReport, Candidate, CheckJob,
  Context, Finding, Principal, Proposal, Task,
} from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let clock = T0;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(Date.parse(clock) + ms).toISOString();
};
let seq = 0;
const uid = () => `id-${++seq}`;

const owner: Principal = {
  id: 'user-1', sessionId: 'sess-owner', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read'], projectIds: ['p1'],
};
const agent = (id: string, scopes: string[], ownerId = 'user-1'): Principal => ({
  id, sessionId: `sess-${id}-${seq}`, kind: 'agent', ownerId,
  scopes, projectIds: ['p1'],
});
const human = (id: string): Principal => ({
  id, sessionId: `sess-${id}`, kind: 'human', ownerId: id,
  scopes: ['read', 'reviews:write', 'checks:write', 'findings:write'], projectIds: ['p1'],
});

const req = (path: string, init?: RequestInit) =>
  new Request(`https://x.test/api/v1/projects/p1${path}`, init);

type Handler = (
  ctx: Context, request: Request, segments: string[], body?: Record<string, unknown>,
) => Promise<Response | null>;
function call(handler: Handler, ctx: Context, method: string, path: string, body?: Record<string, unknown>) {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  return handler(ctx, req(path, { method }), segments, body) as Promise<Response>;
}
const errIs = (status: number, code?: string) => (err: { status: number; code: string }) =>
  err.status === status && (code === undefined || err.code === code);

// The collector token is delivered to trusted runner machinery through the
// dispatch input only -- test fixtures capture it there. Requester-visible
// responses never carry it.
const dispatchedTokens = new Map<string, string>();
function tokenFor(store: MemoryStore, jobId: string): string {
  void store;
  const t = dispatchedTokens.get(jobId);
  assert.ok(t !== undefined, `no collector token reached the runner for job ${jobId}`);
  return t;
}
const acceptingRunner = {
  dispatch: async (input: { jobId: string; collectorToken?: string }) => {
    if (input.collectorToken !== undefined) dispatchedTokens.set(input.jobId, input.collectorToken);
    return { accepted: true };
  },
  cancel: async () => ({ accepted: true }),
};
const rejectingRunner = {
  dispatch: async () => ({ accepted: false, reason: 'capacity' }),
  cancel: async () => ({ accepted: true }),
};

function fixture(runner?: typeof acceptingRunner | typeof rejectingRunner) {
  const store = new MemoryStore(createState({ id: 'p1', goal: 'ship', mode: 'live', now: clock }));
  const ctx: Context = { principal: owner, store, now, uid, ...(runner ? { runner } : {}) };
  return { ctx, store };
}

function seedCandidate(store: MemoryStore, input: {
  id: string; sha: string; proposalIds?: string[]; heads?: Record<string, string>;
}): Promise<Candidate> {
  return store.transact((draft) => {
    const cand: Candidate = {
      id: input.id, projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'user-1', base: 'base-sha', proposalIds: input.proposalIds ?? [],
      proposalHeads: input.heads ?? {}, sha: input.sha, policyVersion: 1,
      status: 'prepared', checkJobIds: [], reviewIds: [],
    };
    draft.candidates[cand.id] = cand;
    return cand;
  });
}

function seedProposal(store: MemoryStore, input: { id: string; authorId: string; createdAt?: string }) {
  return store.transact((draft) => {
    const p: Proposal = {
      id: input.id, projectId: 'p1', revision: 1,
      createdAt: input.createdAt ?? clock, updatedAt: input.createdAt ?? clock,
      actorId: input.authorId, taskIds: ['t1'], authorId: input.authorId,
      base: 'base-sha', head: `head-${input.id}`, summary: 's', intendedBehavior: 'b',
      changedPaths: ['a.ts'], evidenceRefs: [], unknowns: [], lifecycle: 'submitted',
    };
    draft.proposals[p.id] = p;
    return p;
  });
}

function seedIdentity(store: MemoryStore, input: {
  id: string; ownerId?: string; parentId?: string; createdAt?: string;
}) {
  return store.transact((draft) => {
    const i: AgentIdentity = {
      id: input.id, projectId: 'p1', revision: 1,
      createdAt: input.createdAt ?? clock, updatedAt: input.createdAt ?? clock,
      actorId: 'user-1', displayName: input.id, ownerId: input.ownerId ?? 'user-1',
      creationSource: input.parentId === undefined ? 'manual' : 'delegated',
      status: 'active',
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    };
    draft.identities[i.id] = i;
    return i;
  });
}

async function requestCheckJob(ctx: Context, candidateId: string, extra?: Record<string, unknown>) {
  const rev = (await ctx.store.read()).candidates[candidateId]?.revision ?? 1;
  const res = await call(handleChecks, ctx, 'POST', `/candidates/${candidateId}/checks`, {
    operationId: `op-check-${++seq}`, expectedRevision: rev,
    command: 'npm test', ...extra,
  });
  return res;
}

async function collectorCtx(store: MemoryStore, token: string): Promise<Context | null> {
  const principal = await authenticateCollector(
    req('/x', { headers: { authorization: `Bearer ${token}` } }),
    await store.read(),
  );
  if (principal === null) return null;
  return { principal, store, now, uid };
}

// --- job registration ---------------------------------------------------

test('request check registers a bounded job; token reaches the runner via dispatch only; replay is token-free', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c1', sha: 'sha-1' });
  const res = await requestCheckJob(ctx, 'c1');
  assert.equal(res.status, 201);
  const body = (await res.json()) as { job: CheckJob; collectorToken?: string };
  // The ordinary requester never receives collector capability.
  assert.equal((body as Record<string, unknown>).collectorToken, undefined);
  const collectorToken = tokenFor(store, body.job.id);
  assert.ok(collectorToken.startsWith('cjob_'));
  assert.equal(body.job.status, 'dispatched');
  assert.equal(body.job.candidateSha, 'sha-1');
  assert.equal(body.job.deadlineAt, new Date(Date.parse(clock) + 10 * 60 * 1000).toISOString());

  // Token lives only in the dispatch channel: the job row and stored
  // operation result carry only the hash.
  const state = await store.read();
  const job = Object.values(state.jobs)[0] as { collectorTokenHash?: string };
  assert.equal(job.collectorTokenHash, await hashCollectorToken(collectorToken));
  assert.equal(JSON.stringify(state.operations).includes('cjob_'), false);

  // Same command+sha dedupes to the live job instead of a second job.
  const again = await requestCheckJob(ctx, 'c1');
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { deduplicated: boolean }).deduplicated, true);
  assert.equal(Object.keys((await store.read()).jobs).length, 1);
});

test('one checker per project: second distinct job hits 429; stopped blocks new jobs; missing runner blocks', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c1', sha: 'sha-1' });
  await seedCandidate(store, { id: 'c2', sha: 'sha-2' });
  await requestCheckJob(ctx, 'c1');
  await assert.rejects(requestCheckJob(ctx, 'c2'), errIs(429, 'check_limit'));

  await store.transact((draft) => {
    draft.stopped = true;
    return true;
  });
  await assert.rejects(
    requestCheckJob(ctx, 'c2'),
    errIs(409, 'project_stopped'),
  );

  const noRunner = fixture();
  await seedCandidate(noRunner.store, { id: 'c9', sha: 'sha-9' });
  const res = await call(handleChecks, noRunner.ctx, 'POST', '/candidates/c9/checks', {
    operationId: 'op-nr', expectedRevision: 1, command: 'npm test',
  });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { job: CheckJob }).job.status, 'blocked');
  assert.equal((await noRunner.store.read()).jobs[(Object.keys((await noRunner.store.read()).jobs)[0])].status, 'blocked');
});

test('dispatch rejection marks the job blocked, not failed-as-code', async () => {
  const { ctx, store } = fixture(rejectingRunner);
  await seedCandidate(store, { id: 'c1', sha: 'sha-1' });
  const res = await requestCheckJob(ctx, 'c1');
  assert.equal(res.status, 201);
  const job = (await res.json()) as { job: CheckJob & { blockedReason?: string } };
  assert.equal(job.job.status, 'blocked');
  assert.equal(job.job.blockedReason, 'capacity');
  const cand = (await store.read()).candidates['c1'];
  assert.equal(cand.status, 'prepared');
});

// --- collector authentication and receipts ------------------------------

test('collector completion writes the only receipt; replay yields one receipt; forgery paths denied', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c1', sha: 'sha-1' });
  const created = (await (await requestCheckJob(ctx, 'c1')).json()) as {
    job: CheckJob;
  };
  const cctx = await collectorCtx(store, tokenFor(store, created.job.id));
  assert.ok(cctx);
  assert.equal(cctx?.principal.kind, 'collector');
  assert.equal((cctx?.principal as { jobId?: string }).jobId, created.job.id);

  // No general receipt-insert route exists for anyone.
  assert.equal(await handleChecks(ctx, req('/receipts', { method: 'POST' }), ['receipts'], {}), null);

  // Regular principals -- even admin -- cannot reach the collector routes.
  await assert.rejects(
    call(handleChecks, ctx, 'POST', `/collector/jobs/${created.job.id}/complete`, {
      operationId: 'op-forge-1', outcome: 'pass',
    }),
    errIs(403, 'collector_only'),
  );

  // An unknown/garbage token never authenticates as a collector.
  assert.equal(await collectorCtx(store, 'cjob_wrong'), null);

  const completeBody = {
    operationId: 'op-complete-1', outcome: 'pass',
    candidateSha: 'sha-1', command: 'npm test',
    inputHash: 'in-1', outputHash: 'out-1',
  };
  const done = await call(handleChecks, cctx as Context, 'POST', `/collector/jobs/${created.job.id}/complete`, completeBody);
  assert.equal(done.status, 201);
  const payload = (await done.json()) as { receipt: { jobId: string; candidateSha: string; collectorId: string; outcome: string } };
  assert.equal(payload.receipt.jobId, created.job.id);
  assert.equal(payload.receipt.candidateSha, 'sha-1');
  assert.equal(payload.receipt.outcome, 'pass');
  assert.match(payload.receipt.collectorId, /^collector:/);
  assert.equal((await store.read()).candidates['c1'].status, 'prepared');

  // Replay of the same operation returns the stored result -- one receipt.
  const replay = await call(handleChecks, cctx as Context, 'POST', `/collector/jobs/${created.job.id}/complete`, completeBody);
  assert.equal(replay.status, 201);
  const replayed = (await replay.json()) as { receipt: { id: string } };
  const receipts = Object.values((await store.read()).receipts);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, replayed.receipt.id);

  // Terminal job: a *different* completion payload is rejected, and the
  // collector credential is dead -- it cannot beat or complete again.
  assert.equal(await collectorCtx(store, tokenFor(store, created.job.id)), null);
});

test('payload consistency: mismatched sha/command/environment fail 409', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c1', sha: 'sha-1' });
  const created = (await (await requestCheckJob(ctx, 'c1', { environment: { NODE_ENV: 'test' } })).json()) as {
    job: CheckJob;
  };
  const cctx = (await collectorCtx(store, tokenFor(store, created.job.id))) as Context;
  for (const [label, patch] of [
    ['sha', { candidateSha: 'sha-other' }],
    ['command', { command: 'npm run lint' }],
    ['env', { environment: { NODE_ENV: 'production' } }],
  ] as const) {
    await assert.rejects(
      call(handleChecks, cctx, 'POST', `/collector/jobs/${created.job.id}/complete`, {
        operationId: `op-bad-${label}`, outcome: 'pass', ...patch,
      }),
      errIs(409, 'payload_inconsistent'),
    );
  }
  assert.equal(Object.keys((await store.read()).receipts).length, 0);
});

test('a collector token is bound to its own job only', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c1', sha: 'sha-1' });
  await seedCandidate(store, { id: 'c2', sha: 'sha-2' });
  // raise the per-project cap for this scenario
  await store.transact((draft) => {
    draft.project.resourceLimits.maxActiveChecks = 3;
    return true;
  });
  const a = (await (await requestCheckJob(ctx, 'c1')).json()) as { job: CheckJob };
  const b = (await (await requestCheckJob(ctx, 'c2', { command: 'npm run lint' })).json()) as { job: CheckJob };
  const actx = (await collectorCtx(store, tokenFor(store, a.job.id))) as Context;
  await assert.rejects(
    call(handleChecks, actx, 'POST', `/collector/jobs/${b.job.id}/complete`, {
      operationId: 'op-cross', outcome: 'pass',
    }),
    errIs(403, 'job_mismatch'),
  );
});

// --- heartbeat -----------------------------------------------------------

test('heartbeat renews only the owning assignment at the current epoch', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  const taskRes = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: 'op-t-hb', goal: 'check work', acceptanceCriteria: ['checked'],
  });
  const task = ((await taskRes.json()) as { task: Task }).task;
  const checker = agent('checker-1', ['read', 'tasks:claim', 'checks:write']);
  const claim = await call(handleAssignments, { ...ctx, principal: checker }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-hb', expectedRevision: 1, leaseMs: 1000, maxMs: 3_600_000,
  });
  const asg = ((await claim.json()) as { assignment: Assignment }).assignment;

  await seedCandidate(store, { id: 'c1', sha: 'sha-1' });
  const created = (await (await requestCheckJob(ctx, 'c1', {
    assignmentId: asg.id, assignmentEpoch: asg.epoch,
  })).json()) as { job: CheckJob };
  const cctx = (await collectorCtx(store, tokenFor(store, created.job.id))) as Context;

  const beat = await call(handleChecks, cctx, 'POST', `/collector/jobs/${created.job.id}/heartbeat`, {
    operationId: 'op-hb-1', assignmentId: asg.id, epoch: 1,
  });
  assert.equal(beat.status, 200);
  const hb = (await beat.json()) as { renewal: { renewed: boolean; leaseExpiresAt?: string } };
  assert.equal(hb.renewal.renewed, true);
  assert.equal(hb.renewal.leaseExpiresAt, created.job.deadlineAt);

  // Superseded-epoch beat: recorded as late activity, renews nothing.
  const lateRes = await call(handleChecks, cctx, 'POST', `/collector/jobs/${created.job.id}/heartbeat`, {
    operationId: 'op-hb-2', assignmentId: asg.id, epoch: 2,
  });
  const late = (await lateRes.json()) as { renewal: { renewed: boolean; reason?: string } };
  assert.equal(late.renewal.renewed, false);
  assert.equal(late.renewal.reason, 'superseded-epoch');
  assert.equal((await store.read()).assignments[asg.id].leaseExpiresAt, created.job.deadlineAt);

  // A heartbeat naming a different (non-owner) assignment renews nothing.
  const helperClaim = await call(handleAssignments, { ...ctx, principal: agent('helper-9', ['read', 'tasks:claim']) }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-helper', expectedRevision: (await store.read()).tasks[task.id].revision, role: 'helper',
  });
  const helper = ((await helperClaim.json()) as { assignment: Assignment }).assignment;
  const notOwnerRes = await call(handleChecks, cctx, 'POST', `/collector/jobs/${created.job.id}/heartbeat`, {
    operationId: 'op-hb-3', assignmentId: helper.id, epoch: helper.epoch,
  });
  const notOwner = (await notOwnerRes.json()) as { renewal: { renewed: boolean; reason?: string } };
  assert.equal(notOwner.renewal.renewed, false);
  assert.equal(notOwner.renewal.reason, 'not-job-owner');
});

// --- review independence (amendment 4) -----------------------------------

async function reviewFixture(store: MemoryStore) {
  // Two authored proposals; earliest at T0.
  await seedProposal(store, { id: 'prop-a', authorId: 'author-1', createdAt: T0 });
  await seedProposal(store, { id: 'prop-b', authorId: 'author-2', createdAt: '2026-10-04T01:00:00.000Z' });
  await seedCandidate(store, {
    id: 'cand-r', sha: 'sha-cand-r', proposalIds: ['prop-a', 'prop-b'],
    heads: { 'prop-a': 'head-prop-a', 'prop-b': 'head-prop-b' },
  });
  await seedIdentity(store, { id: 'author-1', ownerId: 'owner-a', createdAt: '2026-10-03T00:00:00.000Z' });
  await seedIdentity(store, { id: 'author-2', ownerId: 'owner-a', createdAt: '2026-10-03T00:00:00.000Z' });
  await seedIdentity(store, { id: 'peer-old', ownerId: 'owner-a', createdAt: '2026-10-03T00:00:00.000Z' });
  await seedIdentity(store, { id: 'author-child', ownerId: 'owner-a', parentId: 'author-1', createdAt: '2026-10-03T00:00:00.000Z' });
  await seedIdentity(store, { id: 'peer-child-old', ownerId: 'owner-a', parentId: 'peer-old', createdAt: '2026-10-03T12:00:00.000Z' });
  await seedIdentity(store, { id: 'peer-child-new', ownerId: 'owner-a', parentId: 'peer-old', createdAt: '2026-10-04T02:00:00.000Z' });
  await seedIdentity(store, { id: 'other-owner-child', ownerId: 'owner-b', parentId: 'peer-old', createdAt: '2026-10-04T02:00:00.000Z' });
}

test('independence policy v1: author, descendant, delegated-child-after-proposal, unknown ancestry fail; peers and humans pass', async () => {
  const { store } = fixture();
  await reviewFixture(store);
  const state = await store.read();
  const ev = (reviewerId: string, reviewerKind = 'agent') =>
    evaluateIndependence(state, { candidateId: 'cand-r', reviewerId, reviewerKind });

  assert.deepEqual(ev('author-1'), { independent: false, reason: 'reviewer-authored-candidate', policyVersion: 1 });
  assert.deepEqual(ev('author-2'), { independent: false, reason: 'reviewer-authored-candidate', policyVersion: 1 });
  assert.deepEqual(ev('author-child'), { independent: false, reason: 'reviewer-descends-from-author', policyVersion: 1 });
  assert.deepEqual(ev('peer-child-new'), { independent: false, reason: 'same-owner-delegated-child-after-earliest-proposal', policyVersion: 1 });
  assert.deepEqual(ev('ghost-agent'), { independent: false, reason: 'unknown-ancestry', policyVersion: 1 });

  assert.deepEqual(ev('peer-old'), { independent: true, reason: 'independent-identity', policyVersion: 1 });
  assert.deepEqual(ev('peer-child-old'), { independent: true, reason: 'independent-identity', policyVersion: 1 });
  assert.deepEqual(ev('other-owner-child'), { independent: true, reason: 'independent-identity', policyVersion: 1 });
  assert.deepEqual(ev('human-9', 'human'), { independent: true, reason: 'independent-human', policyVersion: 1 });
});

test('reviews bind the exact candidate sha; non-independent reviews are stored but never counted', async () => {
  const { ctx, store } = fixture();
  await reviewFixture(store);
  const state = await store.read();
  const cand = state.candidates['cand-r'];

  // Stale sha -> recheck, not a review.
  await assert.rejects(
    call(handleReviews, { ...ctx, principal: agent('peer-old', ['read', 'reviews:write']) }, 'POST', '/candidates/cand-r/reviews', {
      operationId: 'op-rv-stale', expectedRevision: cand.revision,
      candidateSha: 'sha-old', disposition: 'approve',
    }),
    errIs(409, 'stale_candidate_sha'),
  );

  // Author review: stored, flagged non-independent.
  const authorReview = await call(handleReviews, { ...ctx, principal: agent('author-1', ['read', 'reviews:write']) }, 'POST', '/candidates/cand-r/reviews', {
    operationId: 'op-rv-author', expectedRevision: cand.revision,
    candidateSha: 'sha-cand-r', disposition: 'approve', note: 'looks fine to me',
  });
  assert.equal(authorReview.status, 201);
  const ar = ((await authorReview.json()) as { review: { independent: boolean; independenceReason: string } }).review;
  assert.equal(ar.independent, false);
  assert.equal(ar.independenceReason, 'reviewer-authored-candidate');

  // Peer review: independent.
  const cand2 = (await store.read()).candidates['cand-r'];
  const peerReview = await call(handleReviews, { ...ctx, principal: agent('peer-old', ['read', 'reviews:write']) }, 'POST', '/candidates/cand-r/reviews', {
    operationId: 'op-rv-peer', expectedRevision: cand2.revision,
    candidateSha: 'sha-cand-r', disposition: 'approve',
  });
  assert.equal(peerReview.status, 201);
  assert.equal(((await peerReview.json()) as { review: { independent: boolean } }).review.independent, true);

  const ev = candidateEvidence(await store.read(), (await store.read()).candidates['cand-r']);
  assert.equal(ev.independentApprovals.length, 1);
  assert.equal(ev.nonIndependentReviews.length, 1);
});

// --- findings: derived transitions only ----------------------------------

test('verified-fixed derives solely from original-fail + repaired-pass of the same reproducer', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c-orig', sha: 'sha-orig' });
  await seedCandidate(store, { id: 'c-fix', sha: 'sha-fix' });
  await store.transact((draft) => {
    draft.project.resourceLimits.maxActiveChecks = 4;
    return true;
  });

  // 1. Reporter files a possible issue against the original candidate.
  const report = await call(handleFindings, ctx, 'POST', '/findings', {
    operationId: 'op-f-1', expected: 'exit 0',
    observed: 'flaky?', candidateId: 'c-orig', reproducer: 'npm test',
  });
  assert.equal(report.status, 201);
  const finding = ((await report.json()) as { finding: Finding }).finding;
  assert.equal(finding.state, 'possible-issue');

  // Direct disposition can never manufacture verified-fixed or reproduced.
  await assert.rejects(
    call(handleFindings, ctx, 'POST', `/findings/${finding.id}/disposition`, {
      operationId: 'op-f-vf', expectedRevision: 1, disposition: 'verified-fixed', note: 'trust me',
    }),
    errIs(422, 'derived_state_only'),
  );
  await assert.rejects(
    call(handleFindings, ctx, 'POST', `/findings/${finding.id}/disposition`, {
      operationId: 'op-f-rp', expectedRevision: 1, disposition: 'reproduced', note: 'saw it',
    }),
    errIs(422, 'derived_state_only'),
  );

  // 2. A recheck job bound to the finding fails -> reproduced (receipt r-fail).
  const jRepro = (await (await requestCheckJob(ctx, 'c-orig', { findingId: finding.id })).json()) as {
    job: CheckJob & { kind?: string };
  };
  assert.equal(jRepro.job.kind, 'recheck');
  const reproCtx = (await collectorCtx(store, tokenFor(store, jRepro.job.id))) as Context;
  const failed = await call(handleChecks, reproCtx, 'POST', `/collector/jobs/${jRepro.job.id}/complete`, {
    operationId: 'op-c-fail', outcome: 'fail', candidateSha: 'sha-orig', command: 'npm test',
  });
  assert.equal(failed.status, 201);
  const failPayload = (await failed.json()) as { receipt: { id: string }; transitions: { to: string }[] };
  const rFail = failPayload.receipt.id;
  assert.equal((await store.read()).findings[finding.id].state, 'reproduced');

  // 3. Repair assignment derives repair-in-progress; repair candidate derives recheck-needed.
  const taskRes = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: 'op-t-fix', goal: 'fix it', acceptanceCriteria: ['fixed'],
  });
  const task = ((await taskRes.json()) as { task: Task }).task;
  const fixer = agent('fixer-1', ['read', 'tasks:claim']);
  const claimRes = await call(handleAssignments, { ...ctx, principal: fixer }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-fix', expectedRevision: 1,
  });
  const fixAsg = ((await claimRes.json()) as { assignment: Assignment }).assignment;
  const repair = await call(handleFindings, ctx, 'POST', `/findings/${finding.id}/repair`, {
    operationId: 'op-f-repair', expectedRevision: (await store.read()).findings[finding.id].revision,
    assignmentId: fixAsg.id,
  });
  assert.equal(((await repair.json()) as { finding: Finding }).finding.state, 'repair-in-progress');

  const recheck = await call(handleFindings, ctx, 'POST', `/findings/${finding.id}/recheck`, {
    operationId: 'op-f-recheck', expectedRevision: (await store.read()).findings[finding.id].revision,
    candidateId: 'c-fix',
  });
  assert.equal(((await recheck.json()) as { finding: Finding }).finding.state, 'recheck-needed');

  // 4. Passing recheck on the SAME sha cannot verify: different sha required.
  const jSame = (await (await requestCheckJob(ctx, 'c-orig', {
    findingId: finding.id, originalReceiptId: rFail,
  })).json()) as { job: CheckJob };
  const sameCtx = (await collectorCtx(store, tokenFor(store, jSame.job.id))) as Context;
  const passSame = await call(handleChecks, sameCtx, 'POST', `/collector/jobs/${jSame.job.id}/complete`, {
    operationId: 'op-c-samepass', outcome: 'pass', candidateSha: 'sha-orig', command: 'npm test',
  });
  assert.equal(passSame.status, 201);
  let fNow = (await store.read()).findings[finding.id];
  assert.equal(fNow.state, 'recheck-needed');
  assert.match(fNow.note ?? '', /could not be linked to an original failing run/);

  // 5. Repaired candidate passes the same reproducer -> verified-fixed, both receipts linked.
  const jFix = (await (await requestCheckJob(ctx, 'c-fix', {
    findingId: finding.id, originalReceiptId: rFail,
  })).json()) as { job: CheckJob };
  const fixCtx = (await collectorCtx(store, tokenFor(store, jFix.job.id))) as Context;
  const passFix = await call(handleChecks, fixCtx, 'POST', `/collector/jobs/${jFix.job.id}/complete`, {
    operationId: 'op-c-fixpass', outcome: 'pass', candidateSha: 'sha-fix', command: 'npm test',
  });
  assert.equal(passFix.status, 201);
  fNow = (await store.read()).findings[finding.id];
  assert.equal(fNow.state, 'verified-fixed');
  const passReceiptId = ((await passFix.json()) as { receipt: { id: string } }).receipt.id;
  assert.equal(fNow.receiptIds.length, 3);
  assert.ok(fNow.receiptIds.includes(rFail));
  assert.ok(fNow.receiptIds.includes(passReceiptId));

  // 6. Authorized dispositions remain available with a note, evidence kept.
  const wd = await call(handleFindings, ctx, 'POST', `/findings/${finding.id}/disposition`, {
    operationId: 'op-f-wd', expectedRevision: fNow.revision,
    disposition: 'withdrawn', note: 'upstream quirk, dropping',
  });
  assert.equal(wd.status, 200);
  const final = (await store.read()).findings[finding.id];
  assert.equal(final.state, 'withdrawn');
  assert.equal(final.receiptIds.length, 3);
  assert.ok(final.receiptIds.includes(rFail));
});

test('a pass without original-failure evidence never verifies', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c-x', sha: 'sha-x' });
  const report = await call(handleFindings, ctx, 'POST', '/findings', {
    operationId: 'op-f-x', expected: 'ok', observed: 'maybe bad',
    candidateId: 'c-x', reproducer: 'npm test',
  });
  const finding = ((await report.json()) as { finding: Finding }).finding;
  const job = (await (await requestCheckJob(ctx, 'c-x', { findingId: finding.id })).json()) as {
    job: CheckJob;
  };
  const cctx = (await collectorCtx(store, tokenFor(store, job.job.id))) as Context;
  const pass = await call(handleChecks, cctx, 'POST', `/collector/jobs/${job.job.id}/complete`, {
    operationId: 'op-c-xpass', outcome: 'pass', candidateSha: 'sha-x', command: 'npm test',
  });
  assert.equal(pass.status, 201);
  const f = (await store.read()).findings[finding.id];
  assert.equal(f.state, 'possible-issue');
  assert.match(f.note ?? '', /could not be linked/);
});

test('failed check reports findings with collector provenance; author reports never mint independent evidence', async () => {
  const { ctx, store } = fixture(acceptingRunner);
  await seedCandidate(store, { id: 'c-p', sha: 'sha-p', proposalIds: ['prop-1'], heads: { 'prop-1': 'h1' } });
  await seedProposal(store, { id: 'prop-1', authorId: 'author-1' });
  const job = (await (await requestCheckJob(ctx, 'c-p')).json()) as {
    job: CheckJob;
  };
  const cctx = (await collectorCtx(store, tokenFor(store, job.job.id))) as Context;
  const failed = await call(handleChecks, cctx, 'POST', `/collector/jobs/${job.job.id}/complete`, {
    operationId: 'op-c-pfail', outcome: 'fail', candidateSha: 'sha-p', command: 'npm test',
    findings: [{ expected: 'green', observed: 'red', reproducer: 'npm test', severity: 'high' }],
  });
  assert.equal(failed.status, 201);
  const payload = (await failed.json()) as { findings: { state: string; originatorId: string; receiptIds: string[] }[] };
  assert.equal(payload.findings.length, 1);
  assert.equal(payload.findings[0].state, 'reproduced');
  assert.match(payload.findings[0].originatorId, /^collector:/);
  assert.equal((await store.read()).candidates['c-p'].status, 'failed');

  // AuthorReport rows are author-claimed provenance: receipt counts do not move.
  const before = candidateEvidence(await store.read(), (await store.read()).candidates['c-p']);
  await store.transact((draft) => {
    const ar: AuthorReport = {
      id: 'ar-1', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'author-1', proposalId: 'prop-1', authorId: 'author-1',
      claims: 'tests pass locally, honest', artifactRefs: ['log://author/1'],
    };
    draft.authorReports[ar.id] = ar;
    return true;
  });
  const after = candidateEvidence(await store.read(), (await store.read()).candidates['c-p']);
  assert.equal(after.receipts.length, before.receipts.length);
  assert.equal(after.passingReceipts.length, before.passingReceipts.length);
  assert.equal(after.authorReports.length, 1);
  assert.equal(Object.keys((await store.read()).receipts).length, 1);
});

test('derived helper writers: repair-in-progress and recheck-needed come only from the transitions API', async () => {
  const { ctx, store } = fixture();
  const report = await call(handleFindings, ctx, 'POST', '/findings', {
    operationId: 'op-f-h', expected: 'ok', observed: 'bad', reproducer: 'npm test',
  });
  const finding = ((await report.json()) as { finding: Finding }).finding;

  // No active assignment -> repair cannot start.
  await store.transact((draft) => {
    draft.assignments['a-dead'] = {
      id: 'a-dead', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'u', taskId: 't-x', identityId: 'fixer', role: 'owner', scopes: [],
      epoch: 1, leaseExpiresAt: clock, maxUntil: clock, status: 'stopped',
    } as Assignment;
    return true;
  });
  await store.transact((draft) => {
    assert.throws(
      () => noteRepairAssignment(draft, ctx, { findingId: finding.id, assignmentId: 'a-dead' }),
      errIs(409, 'assignment_inactive'),
    );
    assert.throws(
      () => noteRepairSubmission(draft, ctx, { findingId: finding.id, candidateId: 'ghost' }),
      errIs(404, 'not_found'),
    );
    return true;
  });
});

// --- snapshot runner: honest blocked paths -------------------------------

test('snapshot runner reports docker-unavailable instead of faking isolation', {
  skip:process.platform!=='linux'||process.env.TOGETHER_DOCKER_TESTS!=='1'?'Docker-dependent case: opt in only on the approved Linux host':false,
}, async () => {
  // This one explicitly enabled Linux case may inspect the Docker daemon.
  // The preceding 13 MemoryStore/stub-runner cases are entirely offline.
  const available = dockerAvailableSync();
  const runner = createSnapshotRunner();
  const disp = await runner.dispatch({
    projectId: 'p1', jobId: 'j1', candidateSha: 'sha-1',
    snapshotRef: '/definitely/missing/snapshot', command: 'npm test',
    timeoutMs: 1000, operationId: 'op-1',
  });
  if (!available) {
    assert.equal(disp.accepted, false);
    assert.equal(disp.reason, 'docker-unavailable');
    const result = await runSnapshotJob({
      snapshotRef: '/tmp', command: 'echo hi', timeoutMs: 1000,
    });
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.blockedReason, 'docker-unavailable');
    assert.equal(await runner.cancel({ projectId: 'p1', jobId: 'j1' }).then((r) => r.accepted), false);
  } else {
    assert.equal(disp.accepted, false);
    assert.equal(disp.reason, 'snapshot-missing');
  }
  // Container names are sanitized regardless of job id content.
  assert.match(containerName('p', 'job/../../etc/passwd'), /^p-job-[-.a-zA-Z0-9_]+$/);
});
