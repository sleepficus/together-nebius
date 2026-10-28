// Unit evidence for seat b-swe-04: proposals, candidates, integration
// operation/reconciler, canonical expected-tip rules.
// node --test tests/integration.test.ts — scripted GitService fixture;
// real local-Git evidence is tests/semantic-merge.test.ts.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createState, errorResponse, json } from '../lib/core.ts';
import { handleChanges } from '../lib/changes.ts';
import { handleIntegration, readiness, reconcileTip } from '../lib/integration.ts';
import { MemoryStore } from '../lib/store.ts';
import type {
  Candidate, Context, EvidenceReceipt, GitService, Id, Operation, Principal,
  Review, Sha, Task,
} from '../lib/types.ts';

let seq = 0;
const uid = () => `id-${++seq}`;
const t0 = '2026-10-04T00:00:00.000Z';
const now = () => t0;
const sha = (ch: string) => ch.repeat(40);
const BASE = sha('b');
const HEAD_A = sha('a');
const HEAD_B = sha('c');
const CAND = sha('d');

const principal: Principal = {
  id: 'user-1', sessionId: 'sess-1', kind: 'human', ownerId: 'user-1',
  scopes: ['admin', 'read', 'changes:write', 'integrate'], projectIds: ['p1'],
};

// Scripted GitService — every call is recorded.
class FakeGit implements GitService {
  tip: Sha = BASE;
  pushes: { ref: string; expectedTip: Sha; candidateTip: Sha; operationId: Id }[] = [];
  prepares: number = 0;
  pushQueue: { ended: boolean; effect: 'updated' | 'no-effect' | 'unknown'; reportStatus?: string }[] = [];
  pushMovesTip = true;
  ancestors = new Set<string>();
  prepareSha: Sha = CAND;
  prepareConflicts?: { path: string; proposalIds: Id[] }[];

  async prepare(input: { base: Sha; proposals: { id: Id; head: Sha }[] }) {
    this.prepares += 1;
    const proposalHeads: Record<Id, Sha> = {};
    for (const p of input.proposals) proposalHeads[p.id] = p.head;
    return {
      sha: this.prepareConflicts ? '' : this.prepareSha,
      base: input.base, proposalHeads, changedPaths: ['x.txt'],
      conflicts: this.prepareConflicts,
    };
  }
  async readTip(_ref: string) { return this.tip; }
  async isAncestor(a: Sha, b: Sha) { return this.ancestors.has(`${a}>${b}`); }
  async push(input: { ref: string; expectedTip: Sha; candidateTip: Sha; operationId: Id }) {
    this.pushes.push({ ...input });
    const scripted = this.pushQueue.shift() ?? { ended: true, effect: 'updated' as const };
    if (scripted.effect === 'updated' && this.pushMovesTip) this.tip = input.candidateTip;
    return scripted;
  }
}

function fixture(git?: FakeGit): { ctx: Context; store: MemoryStore; git?: FakeGit } {
  const store = new MemoryStore(
    createState({ id: 'p1', goal: 'ship the slice', mode: 'live', now: t0 }),
  );
  const ctx: Context = { principal, store, now, uid, git };
  return { ctx, store, git };
}

const meta = (id: string, actorId = 'user-1') =>
  ({ id, projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0, actorId });

const req = () => new Request('https://x.test/', { method: 'POST' });
const get = () => new Request('https://x.test/', { method: 'GET' });

// Mirrors createApp's typed-error boundary around a module handler.
async function call(fn: () => Promise<Response | null>): Promise<Response> {
  try {
    const res = await fn();
    return res ?? json(404, { error: { status: 404, code: 'route_not_found', message: 'unowned', retryable: false } });
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    throw err;
  }
}

async function seedTask(store: MemoryStore, id: string): Promise<void> {
  await store.transact((draft) => {
    draft.tasks[id] = {
      ...meta(id), goal: `task ${id}`, acceptanceCriteria: ['ok'], dependencies: [],
      lifecycle: 'in-progress', resultRefs: [],
    } as Task;
    return true;
  });
}

async function submit(ctx: Context, opId: string, head: Sha, taskIds = ['t1']) {
  const res = await call(() => handleChanges(ctx, req(), ['changes'], {
    operationId: opId, taskIds, base: BASE, head,
    summary: `proposal ${head.slice(0, 4)}`, intendedBehavior: 'behaves',
    changedPaths: ['x.txt'], evidenceRefs: [], unknowns: [],
  }));
  return res;
}

async function proposalId(res: Response): Promise<string> {
  return ((await res.json()) as { proposal: { id: string } }).proposal.id;
}

async function combined(res: Response): Promise<Candidate> {
  return ((await res.json()) as { candidate: Candidate }).candidate;
}

/** Make a candidate satisfy default policy v1 on its exact sha. */
async function satisfy(store: MemoryStore, candidate: Candidate): Promise<void> {
  await store.transact((draft) => {
    draft.jobs['job-1'] = {
      ...meta('job-1', 'system'), candidateId: candidate.id,
      candidateSha: candidate.sha, command: 'node check.mjs', status: 'completed',
    };
    draft.receipts['rc-1'] = {
      ...meta('rc-1', 'collector'), jobId: 'job-1', candidateSha: candidate.sha,
      collectorId: 'collector-1', command: 'node check.mjs', outcome: 'pass', artifactRefs: [],
    } as EvidenceReceipt;
    draft.reviews['rv-1'] = {
      ...meta('rv-1', 'user-2'), candidateId: candidate.id, candidateSha: candidate.sha,
      reviewerId: 'user-2', policyVersion: 1, disposition: 'approve',
      independent: true, independenceReason: 'unrelated peer', findingIds: [],
    } as Review;
    const c = draft.candidates[candidate.id];
    c.checkJobIds = ['job-1'];
    c.reviewIds = ['rv-1'];
    return true;
  });
}

async function combineOp(ctx: Context, opId: string, proposalIds: string[]) {
  return call(() => handleChanges(ctx, req(), ['candidates'], { operationId: opId, proposalIds }));
}

async function integrate(ctx: Context, opId: string, candidateId: string, expectedTip: Sha) {
  return call(() => handleIntegration(ctx, req(), ['candidates', candidateId, 'integrate'], {
    operationId: opId, expectedTip,
  }));
}

// ---------------------------------------------------------------------------

test('submit proposal validates exact SHAs and task links; record is immutable', async () => {
  const { ctx, store } = fixture();
  await seedTask(store, 't1');

  const bad = await call(() => handleChanges(ctx, req(), ['changes'], {
    operationId: 'op-bad', taskIds: ['t1'], base: 'main; rm -rf /', head: HEAD_A,
    summary: 's', intendedBehavior: 'b', changedPaths: [],
  }));
  assert.equal(bad.status, 422);
  assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'invalid_sha');

  const noTask = await call(() => handleChanges(ctx, req(), ['changes'], {
    operationId: 'op-nt', taskIds: ['missing'], base: BASE, head: HEAD_A,
    summary: 's', intendedBehavior: 'b', changedPaths: [],
  }));
  assert.equal(noTask.status, 404);

  const res = await submit(ctx, 'op-p1', HEAD_A);
  assert.equal(res.status, 201);
  const pid = await proposalId(res);
  const state = await store.read();
  const p = state.proposals[pid];
  assert.equal(p.lifecycle, 'submitted');
  assert.equal(p.authorId, 'user-1');
  assert.equal(p.head, HEAD_A);
  assert.equal(p.sessionId, 'sess-1');

  // Same operationId + digest replays the saved result; still one record.
  const replay = await submit(ctx, 'op-p1', HEAD_A);
  assert.equal(replay.status, 201);
  assert.equal(await proposalId(replay), pid);
  assert.equal(Object.keys((await store.read()).proposals).length, 1);

  // Same key, different payload -> 409, no mutation.
  const conflict = await call(() => handleChanges(ctx, req(), ['changes'], {
    operationId: 'op-p1', taskIds: ['t1'], base: BASE, head: HEAD_B,
    summary: 'other', intendedBehavior: 'b', changedPaths: [],
  }));
  assert.equal(conflict.status, 409);
  assert.equal(Object.keys((await store.read()).proposals).length, 1);
});

test('lifecycle transitions are forward-only; integrated is reconciler-reserved', async () => {
  const { ctx, store } = fixture();
  await seedTask(store, 't1');
  const pid = await proposalId(await submit(ctx, 'op-p1', HEAD_A));

  const reserved = await call(() => handleChanges(ctx, req(), ['changes', pid, 'transition'], {
    operationId: 'op-t0', to: 'integrated', expectedRevision: 1,
  }));
  assert.equal(reserved.status, 422);
  assert.equal(((await reserved.json()) as { error: { code: string } }).error.code, 'reserved_state');

  const jump = await call(() => handleChanges(ctx, req(), ['changes', pid, 'transition'], {
    operationId: 'op-t1', to: 'changes-requested', expectedRevision: 1,
  }));
  assert.equal(jump.status, 200);
  const back = await call(() => handleChanges(ctx, req(), ['changes', pid, 'transition'], {
    operationId: 'op-t2', to: 'ready-to-combine', expectedRevision: 2,
  }));
  assert.equal(back.status, 409); // changes-requested cannot jump to ready
  const state = await store.read();
  assert.equal(state.proposals[pid].lifecycle, 'changes-requested');
});

test('combine stores an immutable candidate with all heads and fresh checks', async () => {
  const { ctx, store, git } = fixture(new FakeGit());
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const pb = await proposalId(await submit(ctx, 'op-b', HEAD_B));

  const res = await combineOp(ctx, 'op-c1', [pa, pb]);
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    candidate: Candidate & { readiness: { ready: boolean; reasons: string[] } };
    deduplicated: boolean;
  };
  const c = body.candidate;
  assert.equal(c.sha, CAND);
  assert.equal(c.base, BASE);
  assert.deepEqual(c.proposalIds, [pa, pb]);
  assert.deepEqual(c.proposalHeads, { [pa]: HEAD_A, [pb]: HEAD_B });
  assert.equal(c.status, 'prepared');
  assert.equal(body.candidate.readiness.ready, false);
  assert.ok(body.candidate.readiness.reasons.length >= 2); // no checks, no review

  // Replaying the same combine returns the saved result; no 2nd prepare.
  const replay = await combineOp(ctx, 'op-c1', [pa, pb]);
  assert.equal(replay.status, 201);
  assert.equal(git!.prepares, 1);

  // A different operation over identical content resolves to the same
  // candidate — repeated operations never double-count.
  const again = await combineOp(ctx, 'op-c2', [pa, pb]);
  const againBody = (await again.json()) as { candidate: Candidate; deduplicated: boolean };
  assert.equal(againBody.candidate.id, c.id);
  assert.equal(againBody.deduplicated, true);
  assert.equal(Object.keys((await store.read()).candidates).length, 1);
});

test('canonical head-map equality is independent of key insertion order', async () => {
  const { ctx, store, git } = fixture(new FakeGit());
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const pb = await proposalId(await submit(ctx, 'op-b', HEAD_B));
  await combineOp(ctx, 'op-c1', [pa, pb]);
  // Same proposals, reversed order -> canonically equal heads object ->
  // still the same candidate.
  const res = await combineOp(ctx, 'op-c3', [pb, pa]);
  const body = (await res.json()) as { deduplicated: boolean };
  assert.equal(body.deduplicated, true);
  assert.equal(Object.keys((await store.read()).candidates).length, 1);
  void git;
});

test('merge conflict is reported, recorded and never fabricates a SHA', async () => {
  const git = new FakeGit();
  git.prepareConflicts = [{ path: 'x.txt', proposalIds: ['p'] }];
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const res = await combineOp(ctx, 'op-cx', [pa]);
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error: { code: string; conflicts: { path: string }[] } };
  assert.equal(body.error.code, 'merge_conflict');
  const state = await store.read();
  assert.equal(Object.keys(state.candidates).length, 0);
  assert.equal(state.operations['op-cx'].effect, 'failed-no-effect');
});

test('combine without a Git service is 503, not a fake SHA', async () => {
  const { ctx, store } = fixture();
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const res = await combineOp(ctx, 'op-cg', [pa]);
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'git_unavailable');
  assert.equal(Object.keys((await store.read()).candidates).length, 0);
});

test('readiness binds the exact candidate sha: checks, independent review, findings', async () => {
  const { ctx, store } = fixture(new FakeGit());
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  let state = await store.read();

  // Evidence on a DIFFERENT sha never counts (fresh checks per SHA).
  await store.transact((draft) => {
    draft.jobs['job-1'] = {
      ...meta('job-1', 'system'), candidateId: candidate.id,
      candidateSha: sha('9'), command: 'check', status: 'completed',
    };
    draft.receipts['old'] = {
      ...meta('old', 'c'), jobId: 'job-1', candidateSha: sha('9'), collectorId: 'c',
      command: 'check', outcome: 'pass', artifactRefs: [],
    } as EvidenceReceipt;
    draft.candidates[candidate.id].checkJobIds = ['job-1'];
    return true;
  });
  state = await store.read();
  assert.equal(readiness(state, state.candidates[candidate.id]).ready, false);

  await satisfy(store, candidate);
  state = await store.read();
  assert.equal(readiness(state, state.candidates[candidate.id]).ready, true);

  // A non-independent approval does not satisfy policy.
  await store.transact((draft) => {
    draft.reviews['rv-1'].independent = false;
    return true;
  });
  state = await store.read();
  assert.equal(readiness(state, state.candidates[candidate.id]).ready, false);
  await store.transact((draft) => {
    draft.reviews['rv-1'].independent = true;
    draft.findings['f-1'] = {
      ...meta('f-1', 'c'), candidateId: candidate.id, candidateSha: candidate.sha,
      expected: 'sum <= 10', observed: 'sum = 13', state: 'reproduced',
      originatorId: 'checker', receiptIds: [],
    } as never;
    return true;
  });
  state = await store.read();
  const r = readiness(state, state.candidates[candidate.id]);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => x.includes('f-1')));
});

test('integrate confirms on read-back, sets Integrated once, marks proposals', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const pb = await proposalId(await submit(ctx, 'op-b', HEAD_B));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa, pb]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);

  const res = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { effect: string; candidate: Candidate };
  assert.equal(body.effect, 'confirmed');
  assert.equal(body.candidate.status, 'integrated');
  assert.equal(git.pushes.length, 1);
  assert.deepEqual(git.pushes[0], {
    ref: 'refs/heads/main', expectedTip: BASE, candidateTip: CAND, operationId: 'op-i1',
  });

  const state = await store.read();
  assert.equal(state.candidates[candidate.id].status, 'integrated');
  assert.equal(state.candidates[candidate.id].integrateOperationId, 'op-i1');
  assert.equal(state.proposals[pa].lifecycle, 'integrated');
  const integratedEvents = state.events.filter((e) => e.type === 'candidate:integrated');
  assert.equal(integratedEvents.length, 1);

  // Replay: saved result, no second push, still one Integrated event.
  const replay = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(replay.status, 200);
  assert.equal(git.pushes.length, 1);
  assert.equal(
    (await store.read()).events.filter((e) => e.type === 'candidate:integrated').length, 1,
  );
});

test('not-ready candidate cannot integrate; missing service is 503', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  git.ancestors.add(`${BASE}>${CAND}`);
  const res = await integrate(ctx, 'op-i0', candidate.id, BASE);
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_ready');
  assert.equal(git.pushes.length, 0);
  assert.equal((await store.read()).operations['op-i0'], undefined);
});

test('expected tip that is not an ancestor of the candidate fails without push', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  // No ancestor entry registered -> the expected tip moved sideways.
  const res = await integrate(ctx, 'op-i1', candidate.id, sha('e'));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'stale_tip');
  assert.equal(git.pushes.length, 0);
  assert.equal((await store.read()).operations['op-i1'].effect, 'failed-no-effect');
});

test('ended/no-effect push is retryable on the same durable operation', async () => {
  const git = new FakeGit();
  git.pushQueue.push({ ended: true, effect: 'no-effect', reportStatus: 'expected-tip-mismatch' });
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);

  const first = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { effect: string }).effect, 'failed-no-effect');
  assert.equal((await store.read()).candidates[candidate.id].status, 'prepared');

  // Retry the SAME operation -> repush allowed: the prior attempt is known
  // to have ended without effect.
  const second = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as { effect: string }).effect, 'confirmed');
  assert.equal(git.pushes.length, 2);
  assert.equal(
    (await store.read()).events.filter((e) => e.type === 'candidate:integrated').length, 1,
  );
});

test('in-flight old-tip ambiguity is effect-unconfirmed, never repushed', async () => {
  const git = new FakeGit();
  git.pushMovesTip = false;
  git.pushQueue.push({ ended: false, effect: 'unknown' });
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);

  const res = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(res.status, 202);
  const body = (await res.json()) as { effect: string; nextAction: string };
  assert.equal(body.effect, 'effect-unconfirmed');
  assert.match(body.nextAction, /operations\/op-i1/);
  assert.equal(git.pushes.length, 1);

  // Retry reconciles by read-back only — no repush while ambiguous.
  const again = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(again.status, 202);
  assert.equal(git.pushes.length, 1);

  // The lost push lands later: read-back attributes it, confirms once.
  git.tip = CAND;
  const settled = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(settled.status, 200);
  assert.equal(git.pushes.length, 1);
  const state = await store.read();
  assert.equal(state.candidates[candidate.id].status, 'integrated');
  assert.equal(state.events.filter((e) => e.type === 'candidate:integrated').length, 1);
});

test('unresolved other-tip stays unknown and is never repushed', async () => {
  const git = new FakeGit();
  git.pushQueue.push({ ended: false, effect: 'unknown' });
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);
  git.tip = sha('f'); // somebody else's work

  const res = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(res.status, 202);
  assert.equal(((await res.json()) as { effect: string }).effect, 'unknown');
  const again = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(again.status, 202);
  assert.equal(git.pushes.length, 1);
  assert.equal((await store.read()).candidates[candidate.id].status, 'prepared');
});

test('candidate landed under an advanced tip reconciles confirmed', async () => {
  const git = new FakeGit();
  git.pushMovesTip = false;
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);
  const landing = sha('7');
  git.tip = landing;
  git.ancestors.add(`${CAND}>${landing}`); // candidate is behind the new tip

  const res = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { effect: string }).effect, 'confirmed');
  assert.equal((await store.read()).candidates[candidate.id].status, 'integrated');
});

test('an unresolved canonical operation blocks a new operationId from bypassing it', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);

  // op-i2 dispatches first and loses its ack: possibly in flight.
  git.pushMovesTip = false;
  git.pushQueue.push({ ended: false, effect: 'unknown' });
  const pending = await integrate(ctx, 'op-i2', candidate.id, BASE);
  assert.equal(pending.status, 202);

  // A NEW operationId cannot bypass the unresolved dispatch — no second
  // push while op-i2 may still be in flight.
  const blocked = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(blocked.status, 409);
  assert.equal(
    ((await blocked.json()) as { error: { code: string } }).error.code,
    'operation_in_flight',
  );
  assert.equal(git.pushes.length, 1);

  // The uncertain push landed late; the PRIOR operation's own retry
  // reconciles by read-back only and confirms exactly once.
  git.tip = CAND;
  const settled = await integrate(ctx, 'op-i2', candidate.id, BASE);
  assert.equal(settled.status, 200);
  assert.equal(git.pushes.length, 1);

  const state = await store.read();
  const op2 = state.operations['op-i2'] as Operation;
  assert.equal(op2.effect, 'confirmed');
  assert.equal(state.candidates[candidate.id].status, 'integrated');
  assert.equal(state.events.filter((e) => e.type === 'candidate:integrated').length, 1);

  // A new integrate call on an integrated candidate is deduplicated —
  // it never pushes.
  const again = await integrate(ctx, 'op-i9', candidate.id, BASE);
  assert.equal(again.status, 200);
  const againBody = (await again.json()) as { deduplicated: boolean };
  assert.equal(againBody.deduplicated, true);
  assert.equal(git.pushes.length, 1); // only op-i2's original dispatch
});

test('GET /operations/:id returns the durable record', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  await combineOp(ctx, 'op-c1', [pa]);
  const res = await call(() => handleIntegration(ctx, get(), ['operations', 'op-c1']));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { operation: Operation };
  assert.equal(body.operation.id, 'op-c1');
  assert.equal(body.operation.intent, 'combine');
  assert.equal(body.operation.effect, 'confirmed');
  const missing = await call(() => handleIntegration(ctx, get(), ['operations', 'nope']));
  assert.equal(missing.status, 404);
  void store;
});

test('reconcileTip truth table: old tip in flight, matched landing, third tip', () => {
  const F = sha('f');
  const cases: [Partial<Parameters<typeof reconcileTip>[0]>, string][] = [
    [{ observedTip: CAND }, 'confirmed'],
    [{ observedTip: BASE, push: { ended: true, effect: 'no-effect' } }, 'failed-no-effect'],
    [{ observedTip: BASE, push: { ended: false, effect: 'unknown' } }, 'effect-unconfirmed'],
    [{ observedTip: F, candidateIsAncestor: true }, 'confirmed'],
    [{ observedTip: F, candidateIsAncestor: false, push: { ended: false, effect: 'unknown' } }, 'unknown'],
    [{ observedTip: F, candidateIsAncestor: false, push: { ended: true, effect: 'no-effect' } }, 'failed-no-effect'],
  ];
  for (const [over, want] of cases) {
    const out = reconcileTip({ observedTip: F, expectedTip: BASE, candidateTip: CAND, ...over });
    assert.equal(out.effect, want, JSON.stringify(over));
  }
});
