// Lane r-swe-04 regressions: external integration uncertainty, new-op
// bypass, stopped dispatch gating and fresh-SHA evidence clearing.
// Scripted GitService fixture — same provenance as tests/integration.test.ts;
// no real Git, Cloudflare, runner or agent execution is claimed here.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createState, digestOf, errorResponse, json } from '../lib/core.ts';
import { handleChanges } from '../lib/changes.ts';
import { handleIntegration, readiness } from '../lib/integration.ts';
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
const CAND2 = sha('e');

const principal: Principal = {
  id: 'user-1', sessionId: 'sess-1', kind: 'human', ownerId: 'user-1',
  scopes: ['admin', 'read', 'changes:write', 'integrate'], projectIds: ['p1'],
};

class FakeGit implements GitService {
  tip: Sha = BASE;
  pushes: { ref: string; expectedTip: Sha; candidateTip: Sha; operationId: Id }[] = [];
  prepares = 0;
  pushQueue: { ended: boolean; effect: 'updated' | 'no-effect' | 'unknown'; reportStatus?: string }[] = [];
  pushMovesTip = true;
  ancestors = new Set<string>();
  prepareSha: Sha = CAND;
  failNextRead = false;

  async prepare(input: { base: Sha; proposals: { id: Id; head: Sha }[] }) {
    this.prepares += 1;
    const proposalHeads: Record<Id, Sha> = {};
    for (const p of input.proposals) proposalHeads[p.id] = p.head;
    return { sha: this.prepareSha, base: input.base, proposalHeads, changedPaths: ['x.txt'] };
  }
  async readTip(_ref: string) {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('interruption after push before reconciliation');
    }
    return this.tip;
  }
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
  return call(() => handleChanges(ctx, req(), ['changes'], {
    operationId: opId, taskIds, base: BASE, head,
    summary: `proposal ${head.slice(0, 4)}`, intendedBehavior: 'behaves',
    changedPaths: ['x.txt'], evidenceRefs: [], unknowns: [],
  }));
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
    draft.jobs[`job-${candidate.sha.slice(0, 4)}`] = {
      ...meta(`job-${candidate.sha.slice(0, 4)}`, 'system'), candidateId: candidate.id,
      candidateSha: candidate.sha, command: 'node check.mjs', status: 'completed',
    };
    draft.receipts[`rc-${candidate.sha.slice(0, 4)}`] = {
      ...meta(`rc-${candidate.sha.slice(0, 4)}`, 'collector'), jobId: `job-${candidate.sha.slice(0, 4)}`,
      candidateSha: candidate.sha, collectorId: 'collector-1', command: 'node check.mjs',
      outcome: 'pass', artifactRefs: [],
    } as EvidenceReceipt;
    draft.reviews[`rv-${candidate.sha.slice(0, 4)}`] = {
      ...meta(`rv-${candidate.sha.slice(0, 4)}`, 'user-2'), candidateId: candidate.id,
      candidateSha: candidate.sha, reviewerId: 'user-2', policyVersion: 1,
      disposition: 'approve', independent: true, independenceReason: 'unrelated peer',
      findingIds: [],
    } as Review;
    const c = draft.candidates[candidate.id];
    c.checkJobIds = [`job-${candidate.sha.slice(0, 4)}`];
    c.reviewIds = [`rv-${candidate.sha.slice(0, 4)}`];
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

/** Digest the integrate pipeline computes for a given durable op. */
async function integrateDigest(opId: string, candidateId: string, expectedTip: Sha) {
  return digestOf({
    scope: 'integrate', target: { collection: 'candidates' as const, id: candidateId },
    body: { operationId: opId, expectedTip },
  });
}

async function stop(store: MemoryStore, stopped = true): Promise<void> {
  await store.transact((draft) => { draft.stopped = stopped; return true; });
}

// ---------------------------------------------------------------------------

test('interrupted uncertain dispatch stays non-pending; same-op replay reconciles without repush', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);

  // Push reports ended:false/unknown, then read-back dies: mirrors the
  // controller uncertain-first-dispatch reproducer.
  git.pushMovesTip = false;
  git.pushQueue.push({ ended: false, effect: 'unknown' });
  git.failNextRead = true;
  let firstError = '';
  try {
    await integrate(ctx, 'op-i1', candidate.id, BASE);
  } catch (e) {
    firstError = String(e);
  }
  assert.match(firstError, /interruption after push/);
  const interrupted = (await store.read()).operations['op-i1'] as Operation;
  assert.notEqual(interrupted.effect, 'pending'); // never left looking un-attempted
  assert.equal(interrupted.effect, 'dispatching');
  assert.equal(git.pushes.length, 1);

  // Same operation replays by read-back only — never a second push.
  const replay = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(replay.status, 202);
  assert.equal(((await replay.json()) as { effect: string }).effect, 'effect-unconfirmed');
  assert.equal(git.pushes.length, 1);

  // The lost push lands; the same op settles confirmed exactly once.
  git.tip = CAND;
  const settled = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(settled.status, 200);
  assert.equal(git.pushes.length, 1);
  const state = await store.read();
  assert.equal(state.candidates[candidate.id].status, 'integrated');
  assert.equal(state.events.filter((e) => e.type === 'candidate:integrated').length, 1);
});

test('a new operationId cannot bypass an unresolved canonical dispatch', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);

  // 'dispatching' sibling (interrupted before Phase C): new opId blocked.
  git.pushMovesTip = false;
  git.pushQueue.push({ ended: false, effect: 'unknown' });
  git.failNextRead = true;
  await integrate(ctx, 'op-i1', candidate.id, BASE).catch(() => undefined);
  assert.equal(((await store.read()).operations['op-i1'] as Operation).effect, 'dispatching');

  const blocked = await integrate(ctx, 'op-i2', candidate.id, BASE);
  assert.equal(blocked.status, 409);
  const blockedBody = (await blocked.json()) as { error: { code: string; nextAction: string } };
  assert.equal(blockedBody.error.code, 'operation_in_flight');
  assert.match(blockedBody.error.nextAction, /operations\/op-i1/);
  assert.equal(git.pushes.length, 1);
  // The rejected op records nothing — its id stays free for later use.
  assert.equal((await store.read()).operations['op-i2'], undefined);

  // 'effect-unconfirmed' sibling blocks a repush of a third durable op too.
  const again = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(again.status, 202);
  git.pushQueue.push({ ended: true, effect: 'no-effect' });
  const digestI9 = await integrateDigest('op-i9', candidate.id, BASE);
  await store.transact((draft) => {
    draft.operations['op-i9'] = {
      ...meta('op-i9'), scope: 'integrate', target: { collection: 'candidates', id: candidate.id },
      digest: digestI9,
      intent: 'integrate', effect: 'failed-no-effect',
      ref: 'refs/heads/main', expectedTip: BASE, candidateTip: CAND, candidateId: candidate.id,
    } as Operation;
    return true;
  });
  const repushBlocked = await call(() => handleIntegration(ctx, req(),
    ['candidates', candidate.id, 'integrate'], { operationId: 'op-i9', expectedTip: BASE }));
  assert.equal(repushBlocked.status, 409);
  assert.equal(((await repushBlocked.json()) as { error: { code: string } }).error.code,
    'operation_in_flight');
  assert.equal(git.pushes.length, 1);

  // Once op-i1 settles, dispatch frees up and the same id can proceed.
  git.tip = CAND;
  const settled = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(settled.status, 200);
  const deduped = await integrate(ctx, 'op-i2', candidate.id, BASE);
  assert.equal(deduped.status, 200);
  assert.equal(((await deduped.json()) as { deduplicated: boolean }).deduplicated, true);
  assert.equal(git.pushes.length, 1);
});

test('stop blocks new combine and integration dispatches; reconcile and replay stay read-only', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  git.ancestors.add(`${BASE}>${CAND}`);

  // Park an unresolved dispatch first so reconcile can be checked too.
  git.pushMovesTip = false;
  git.pushQueue.push({ ended: false, effect: 'unknown' });
  const first = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(first.status, 202);
  assert.equal(git.pushes.length, 1);

  await stop(store);

  // Fresh combine + fresh integrate are dispatches: both blocked.
  const stoppedCombine = await combineOp(ctx, 'op-c2', [pa]);
  assert.equal(stoppedCombine.status, 409);
  assert.equal(((await stoppedCombine.json()) as { error: { code: string } }).error.code,
    'project_stopped');
  assert.equal(git.prepares, 1);

  const pb = await proposalId(await submit(ctx, 'op-b', HEAD_B));
  const stoppedCombine2 = await combineOp(ctx, 'op-c3', [pb]);
  assert.equal(stoppedCombine2.status, 409);
  assert.equal(git.prepares, 1);

  const stoppedIntegrate = await integrate(ctx, 'op-i2', candidate.id, BASE);
  assert.equal(stoppedIntegrate.status, 409);
  assert.equal(((await stoppedIntegrate.json()) as { error: { code: string } }).error.code,
    'project_stopped');
  assert.equal(git.pushes.length, 1);
  assert.equal((await store.read()).operations['op-i2'], undefined);

  // A known-ended repush is still a new dispatch — blocked too.
  git.pushQueue.push({ ended: true, effect: 'no-effect' });
  const digestI8 = await integrateDigest('op-i8', candidate.id, BASE);
  await store.transact((draft) => {
    draft.operations['op-i8'] = {
      ...meta('op-i8'), scope: 'integrate', target: { collection: 'candidates', id: candidate.id },
      digest: digestI8,
      intent: 'integrate', effect: 'failed-no-effect',
      ref: 'refs/heads/main', expectedTip: BASE, candidateTip: CAND, candidateId: candidate.id,
    } as Operation;
    return true;
  });
  const stoppedRepush = await call(() => handleIntegration(ctx, req(),
    ['candidates', candidate.id, 'integrate'], { operationId: 'op-i8', expectedTip: BASE }));
  assert.equal(stoppedRepush.status, 409);
  assert.equal(((await stoppedRepush.json()) as { error: { code: string } }).error.code,
    'project_stopped');
  assert.equal(git.pushes.length, 1);

  // Read-only reconciliation of the in-flight op still runs under stop.
  const reconcile = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(reconcile.status, 202);
  assert.equal(git.pushes.length, 1);

  // Saved results replay as pure reads.
  const replayedCombine = await combineOp(ctx, 'op-c1', [pa]);
  assert.equal(replayedCombine.status, 201);
  assert.equal(git.prepares, 1);

  // After resume the in-flight op settles and a fresh dispatch proceeds.
  await stop(store, false);
  git.tip = CAND;
  const settled = await integrate(ctx, 'op-i1', candidate.id, BASE);
  assert.equal(settled.status, 200);
  assert.equal((await store.read()).candidates[candidate.id].status, 'integrated');
});

test('a new resulting SHA starts with no passing evidence (fresh checks per candidate)', async () => {
  const git = new FakeGit();
  const { ctx, store } = fixture(git);
  await seedTask(store, 't1');
  const pa = await proposalId(await submit(ctx, 'op-a', HEAD_A));
  const candidate = await combined(await combineOp(ctx, 'op-c1', [pa]));
  await satisfy(store, candidate);
  let state = await store.read();
  assert.equal(readiness(state, state.candidates[candidate.id]).ready, true);

  // A superseding revision merges to a new SHA — a NEW immutable
  // candidate whose required receipts/reviews are all bound to the old
  // sha and therefore do not count.
  const pb = await proposalId(await submit(ctx, 'op-b', HEAD_B));
  git.prepareSha = CAND2;
  const res2 = await combineOp(ctx, 'op-c2', [pa, pb]);
  const candidate2 = await combined(res2);
  assert.notEqual(candidate2.id, candidate.id);
  assert.equal(candidate2.sha, CAND2);
  state = await store.read();
  const r = readiness(state, state.candidates[candidate2.id]);
  assert.equal(r.ready, false);
  assert.ok(r.reasons.some((x) => x.includes('no required check jobs')) ||
    r.reasons.some((x) => x.includes('no pass receipt')));
  assert.ok(r.reasons.some((x) => x.includes('no independent approval')));

  // The old candidate's evidence stays bound to the old sha.
  assert.equal(
    Object.values(state.receipts).every((x) => x.candidateSha !== CAND2 ||
      x.candidateSha === candidate2.sha),
    true,
  );
  // Old-sha evidence can never satisfy the new candidate's integrate gate.
  const notReady = await integrate(ctx, 'op-i1', candidate2.id, BASE);
  assert.equal(notReady.status, 422);
  assert.equal(((await notReady.json()) as { error: { code: string } }).error.code, 'not_ready');
  assert.equal(git.pushes.length, 0);
});
