// Lane r-swe-05 distinct regression tests: check/collector authority,
// finding lifecycle and exact receipt binding on the actual assembled
// source. Runs with: node --test tests/r-swe-05.test.ts
// (Node >=22.18 type stripping; tsx --test works identically.)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import {
  authenticateCollector, handleChecks, hashCollectorToken,
} from '../lib/checks.ts';
import { handleFindings } from '../lib/findings.ts';
import { evaluateIndependence, handleReviews } from '../lib/reviews.ts';
import type {
  AgentIdentity, Assignment, Candidate, CheckJob, Context, Finding,
  Principal,
} from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let clock = T0;
const now = () => clock;
let seq = 0;
const uid = () => `r05-${++seq}`;

const owner: Principal = {
  id: 'user-1', sessionId: 'sess-owner', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read', 'checks:write', 'findings:write', 'reviews:write'],
  projectIds: ['p1'],
};
const agent = (id: string, scopes: string[], ownerId = 'user-1'): Principal => ({
  id, sessionId: `sess-${id}`, kind: 'agent', ownerId, scopes, projectIds: ['p1'],
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

// Trusted-runner channel: the only place a collector token may appear.
const dispatchedTokens = new Map<string, string>();
const dispatchedInputs: Record<string, unknown>[] = [];
const acceptingRunner = {
  dispatch: async (input: Record<string, unknown>) => {
    dispatchedInputs.push(input);
    if (typeof input.collectorToken === 'string') {
      dispatchedTokens.set(input.jobId as string, input.collectorToken);
    }
    return { accepted: true };
  },
  cancel: async () => ({ accepted: true }),
};

function fixture() {
  const store = new MemoryStore(createState({ id: 'p1', goal: 'lane05', mode: 'live', now: clock }));
  const ctx: Context = { principal: owner, store, now, uid, runner: acceptingRunner };
  return { ctx, store };
}

function seedCandidate(store: MemoryStore, id: string, sha: string, extra?: Partial<Candidate>) {
  return store.transact((draft) => {
    const cand: Candidate = {
      id, projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'user-1', base: 'base-sha', proposalIds: [], proposalHeads: {},
      sha, policyVersion: 1, status: 'prepared', checkJobIds: [], reviewIds: [],
      ...extra,
    };
    draft.candidates[cand.id] = cand;
    return cand;
  });
}

function seedFinding(store: MemoryStore, input: { id: string; state: Finding['state']; candidateId?: string; receiptIds?: string[] }) {
  return store.transact((draft) => {
    const f: Finding = {
      id: input.id, projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'user-1', expected: 'e', observed: 'o', state: input.state,
      originatorId: 'user-1', receiptIds: input.receiptIds ?? [],
      ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
    };
    draft.findings[f.id] = f;
    return f;
  });
}

async function requestCheck(ctx: Context, candidateId: string, extra?: Record<string, unknown>) {
  const rev = (await ctx.store.read()).candidates[candidateId]?.revision ?? 1;
  return call(handleChecks, ctx, 'POST', `/candidates/${candidateId}/checks`, {
    operationId: `op-r05-${++seq}`, expectedRevision: rev,
    command: 'npm test', ...extra,
  });
}

async function collectorCtx(store: MemoryStore, token: string): Promise<Context | null> {
  const principal = await authenticateCollector(
    req('/x', { headers: { authorization: `Bearer ${token}` } }),
    await store.read(),
  );
  return principal === null ? null : { principal, store, now, uid };
}

const deepHasTokenMaterial = (v: unknown): boolean =>
  JSON.stringify(v).includes('cjob_') || JSON.stringify(v).includes('collectorTokenHash');

// --- controller ordinary-author forgery regression ------------------------

test('ordinary author never receives collector capability; forged completion denied', async () => {
  dispatchedTokens.clear(); dispatchedInputs.length = 0;
  const { store } = fixture();
  const author = agent('author', ['read', 'checks:write'], 'owned-owner');
  const ctx: Context = { principal: author, store, now, uid, runner: acceptingRunner };
  await seedCandidate(store, 'c', 'a'.repeat(40));

  const res = await requestCheck(ctx, 'c');
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, unknown>;
  // No field anywhere in the requester-visible response carries capability.
  assert.equal(deepHasTokenMaterial(body), false);
  // The token reached trusted runner machinery through dispatch input only.
  assert.equal(dispatchedInputs.length, 1);
  const token = dispatchedTokens.get((body.job as CheckJob).id) as string;
  assert.match(token, /^cjob_/);

  // Replaying the controller reproducer's forge step: 'Bearer undefined'
  // resolves to nothing, and the completion is a typed denial -- not a crash.
  const forged = await authenticateCollector(
    req('/x', { headers: { authorization: `Bearer ${body.collectorToken}` } }),
    await store.read(),
  );
  assert.equal(forged, null);
  await assert.rejects(
    call(handleChecks, { ...ctx, principal: forged as unknown as Principal }, 'POST',
      `/collector/jobs/${(body.job as CheckJob).id}/complete`,
      { operationId: 'op-r05-forge', outcome: 'pass' }),
    (err: { status?: number; code?: string; name?: string }) =>
      err.status === 403 && err.code === 'collector_only' && err.name === 'ApiError',
  );

  // Member/agent credentials, even admin, cannot mint receipts either.
  await assert.rejects(
    call(handleChecks, ctx, 'POST', `/collector/jobs/${(body.job as CheckJob).id}/complete`, {
      operationId: 'op-r05-forge2', outcome: 'pass',
    }),
    errIs(403, 'collector_only'),
  );
  assert.equal(Object.keys((await store.read()).receipts).length, 0);
});

test('check response reports the persisted job revision after dispatch reconcile', async () => {
  const { ctx, store } = fixture();
  await seedCandidate(store, 'c1', 'sha-1');
  const body = (await (await requestCheck(ctx, 'c1')).json()) as { job: CheckJob };
  const stored = (await store.read()).jobs[body.job.id];
  assert.equal(body.job.status, stored.status);
  assert.equal(body.job.revision, stored.revision);
  assert.equal(body.job.blockedReason, (stored as { blockedReason?: string }).blockedReason);
});

// --- stale / foreign receipt denial ---------------------------------------

test('stale collector credentials and foreign job binding are denied', async () => {
  const { ctx, store } = fixture();
  await seedCandidate(store, 'c1', 'sha-1');
  await seedCandidate(store, 'c2', 'sha-2');
  await store.transact((draft) => { draft.project.resourceLimits.maxActiveChecks = 3; return true; });

  const a = (await (await requestCheck(ctx, 'c1')).json()) as { job: CheckJob };
  const b = (await (await requestCheck(ctx, 'c2', { command: 'npm run lint' })).json()) as { job: CheckJob };
  const tokenA = dispatchedTokens.get(a.job.id) as string;

  // Foreign binding: job A's credential cannot complete or beat for job B.
  const actx = (await collectorCtx(store, tokenA)) as Context;
  await assert.rejects(
    call(handleChecks, actx, 'POST', `/collector/jobs/${b.job.id}/complete`, {
      operationId: 'op-r05-cross', outcome: 'pass',
    }),
    errIs(403, 'job_mismatch'),
  );
  await assert.rejects(
    call(handleChecks, actx, 'POST', `/collector/jobs/${b.job.id}/heartbeat`, {
      operationId: 'op-r05-crosshb', assignmentId: 'none', epoch: 1,
    }),
    errIs(403, 'job_mismatch'),
  );

  // Complete job A, then its credential is stale: auth fails and a fabricated
  // principal still hits the terminal-job guard.
  const done = await call(handleChecks, actx, 'POST', `/collector/jobs/${a.job.id}/complete`, {
    operationId: 'op-r05-done', outcome: 'pass', candidateSha: 'sha-1', command: 'npm test',
  });
  assert.equal(done.status, 201);
  assert.equal(await collectorCtx(store, tokenA), null);
  const fabricated: Context = {
    principal: {
      id: `collector:${a.job.id}`, sessionId: 'x', kind: 'collector', ownerId: 'system',
      scopes: ['collector'], projectIds: ['p1'], jobId: a.job.id,
    } as Principal,
    store, now, uid,
  };
  await assert.rejects(
    call(handleChecks, fabricated, 'POST', `/collector/jobs/${a.job.id}/complete`, {
      operationId: 'op-r05-stale', outcome: 'fail',
    }),
    errIs(409, 'job_terminal'),
  );
  assert.equal(Object.keys((await store.read()).receipts).length, 1);
});

test('no outward read leaks collector credential material', async () => {
  const { ctx, store } = fixture();
  await seedCandidate(store, 'c1', 'sha-1');
  await requestCheck(ctx, 'c1');
  for (const path of ['/jobs', '/jobs/' + Object.keys((await store.read()).jobs)[0], '/candidates/c1/checks']) {
    const res = await call(handleChecks, ctx, 'GET', path);
    assert.equal(deepHasTokenMaterial(await res.json()), false, path);
  }
  // Deduped requests are token-free as well.
  const again = await requestCheck(ctx, 'c1');
  assert.equal(deepHasTokenMaterial(await again.json()), false);
  assert.equal(deepHasTokenMaterial(await store.read().then((s) => s.operations)), false);
});

// --- bounded fields --------------------------------------------------------

test('snapshotRef, inputHash and outputHash are bounded like other stored fields', async () => {
  const { ctx, store } = fixture();
  await seedCandidate(store, 'c1', 'sha-1');
  const big = 'x'.repeat(300);
  await assert.rejects(
    requestCheck(ctx, 'c1', { snapshotRef: big }),
    errIs(422, 'prose_too_large'),
  );

  const job = (await (await requestCheck(ctx, 'c1')).json()) as { job: CheckJob };
  const cctx = (await collectorCtx(store, dispatchedTokens.get(job.job.id) as string)) as Context;
  await assert.rejects(
    call(handleChecks, cctx, 'POST', `/collector/jobs/${job.job.id}/complete`, {
      operationId: 'op-r05-ih', outcome: 'pass', inputHash: big,
    }),
    errIs(422, 'prose_too_large'),
  );
  await assert.rejects(
    call(handleChecks, cctx, 'POST', `/collector/jobs/${job.job.id}/complete`, {
      operationId: 'op-r05-oh', outcome: 'pass', outputHash: big,
    }),
    errIs(422, 'prose_too_large'),
  );
  assert.equal(Object.keys((await store.read()).receipts).length, 0);
});

test('collector-reported finding text respects the 16KiB prose bound in bytes', async () => {
  const { ctx, store } = fixture();
  await seedCandidate(store, 'c1', 'sha-1');
  const job = (await (await requestCheck(ctx, 'c1')).json()) as { job: CheckJob };
  const cctx = (await collectorCtx(store, dispatchedTokens.get(job.job.id) as string)) as Context;
  // 9000 two-byte code points: 9000 chars but 18000 bytes > 16KiB.
  const big = 'é'.repeat(9000);
  const done = await call(handleChecks, cctx, 'POST', `/collector/jobs/${job.job.id}/complete`, {
    operationId: 'op-r05-bigf', outcome: 'fail', candidateSha: 'sha-1', command: 'npm test',
    findings: [{ expected: big, observed: 'o', reproducer: big, severity: 's'.repeat(300) }],
  });
  assert.equal(done.status, 201);
  const created = ((await done.json()) as { findings: Finding[] }).findings;
  assert.equal(created.length, 1);
  const enc = new TextEncoder();
  assert.ok(enc.encode(created[0].expected).length <= 16 * 1024);
  assert.ok(enc.encode(created[0].reproducer ?? '').length <= 16 * 1024);
  assert.ok(enc.encode(created[0].severity ?? '').length <= 256);
});

// --- finding lifecycle -----------------------------------------------------

test('verified-fixed still requires the same reproducer; different command or terminal finding cannot verify', async () => {
  const { ctx, store } = fixture();
  await seedCandidate(store, 'c-orig', 'sha-orig');
  await seedCandidate(store, 'c-fix', 'sha-fix');
  await store.transact((draft) => { draft.project.resourceLimits.maxActiveChecks = 5; return true; });

  const report = await call(handleFindings, ctx, 'POST', '/findings', {
    operationId: 'op-r05-f1', expected: 'ok', observed: 'bad',
    candidateId: 'c-orig', reproducer: 'npm test',
  });
  const finding = ((await report.json()) as { finding: Finding }).finding;

  // Original failing run of 'npm test' on sha-orig -> reproduced.
  const j1 = (await (await requestCheck(ctx, 'c-orig', { findingId: finding.id })).json()) as { job: CheckJob };
  const c1 = (await collectorCtx(store, dispatchedTokens.get(j1.job.id) as string)) as Context;
  await call(handleChecks, c1, 'POST', `/collector/jobs/${j1.job.id}/complete`, {
    operationId: 'op-r05-cfail', outcome: 'fail', candidateSha: 'sha-orig', command: 'npm test',
  });
  assert.equal((await store.read()).findings[finding.id].state, 'reproduced');

  // A passing run of a DIFFERENT command on the repaired sha is not the same
  // reproducer: state stays recheck-needed-equivalent (reproduced here).
  const j2 = (await (await requestCheck(ctx, 'c-fix', { findingId: finding.id, command: 'npm run lint' })).json()) as { job: CheckJob };
  const c2 = (await collectorCtx(store, dispatchedTokens.get(j2.job.id) as string)) as Context;
  const p2 = await call(handleChecks, c2, 'POST', `/collector/jobs/${j2.job.id}/complete`, {
    operationId: 'op-r05-cpass-other', outcome: 'pass', candidateSha: 'sha-fix', command: 'npm run lint',
  });
  assert.equal(p2.status, 201);
  const mid = (await store.read()).findings[finding.id];
  assert.equal(mid.state, 'reproduced');
  assert.match(mid.note ?? '', /could not be linked/);

  // Withdraw the finding; a new recheck job is terminal-denied.
  const wd = await call(handleFindings, ctx, 'POST', `/findings/${finding.id}/disposition`, {
    operationId: 'op-r05-wd', expectedRevision: mid.revision, disposition: 'withdrawn', note: 'done',
  });
  assert.equal(wd.status, 200);
  await assert.rejects(
    requestCheck(ctx, 'c-fix', { findingId: finding.id }),
    errIs(409, 'finding_terminal'),
  );
});

// --- review independence ---------------------------------------------------

test('collector principals cannot review; transitive descendants of an author are non-independent', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    const mk = (id: string, parentId?: string): AgentIdentity => ({
      id, projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'user-1', displayName: id, ownerId: 'o1',
      creationSource: parentId === undefined ? 'manual' : 'delegated',
      status: 'active', ...(parentId !== undefined ? { parentId } : {}),
    });
    draft.identities['author-1'] = mk('author-1');
    draft.identities['child-1'] = mk('child-1', 'author-1');
    draft.identities['grandchild-1'] = mk('grandchild-1', 'child-1');
    draft.proposals['prop-1'] = {
      id: 'prop-1', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'author-1', taskIds: ['t1'], authorId: 'author-1', base: 'b',
      head: 'h', summary: 's', intendedBehavior: 'i', changedPaths: [],
      evidenceRefs: [], unknowns: [], lifecycle: 'submitted',
    };
    return true;
  });
  await seedCandidate(store, 'cand-r', 'sha-r', { proposalIds: ['prop-1'], proposalHeads: { 'prop-1': 'h' } });

  const state = await store.read();
  assert.equal(
    evaluateIndependence(state, { candidateId: 'cand-r', reviewerId: 'grandchild-1', reviewerKind: 'agent' }).independent,
    false,
  );
  assert.equal(
    evaluateIndependence(state, { candidateId: 'cand-r', reviewerId: 'grandchild-1', reviewerKind: 'agent' }).reason,
    'reviewer-descends-from-author',
  );

  // Collector/system principal kind has no review authority.
  const collCtx: Context = {
    principal: {
      id: 'collector:j', sessionId: 'x', kind: 'collector', ownerId: 'system',
      scopes: ['collector', 'reviews:write'], projectIds: ['p1'], jobId: 'j',
    } as Principal,
    store, now, uid,
  };
  await assert.rejects(
    call(handleReviews, collCtx, 'POST', '/candidates/cand-r/reviews', {
      operationId: 'op-r05-crev', expectedRevision: 1, candidateSha: 'sha-r', disposition: 'approve',
    }),
    errIs(403, 'reviewer_kind'),
  );
});
