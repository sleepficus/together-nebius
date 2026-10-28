// Lane r-swe-03 regression tests: creation revision contract (controller
// finding final-create-revision), reclaim on closed tasks, and lane checks
// not already covered by tests/claims-auth.test.ts.
// Runs with: node --test tests/r-swe-03.test.ts   (Node >=22.18 type stripping)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import {
  authenticate, handleIdentity, type EnrollmentPrincipal,
} from '../lib/identity.ts';
import {
  assertAssignmentEpoch, handleAssignments,
} from '../lib/assignments.ts';
import type { Assignment, Context, Principal, Task } from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let clock = T0;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(Date.parse(clock) + ms).toISOString();
};
let seq = 0;
const uid = () => `rswe03-${++seq}`;

const OWNER_TOKEN = 'owner-secret-rswe03';
const owner: Principal = {
  id: 'user-1', sessionId: 'sess-owner', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read'], projectIds: ['p1'],
};
const AUTH_OPTS = { ownerTokens: [{ ownerId: 'user-1', token: OWNER_TOKEN }], now };

function agent(id: string, scopes: string[], sessionId?: string): Principal {
  return {
    id, sessionId: sessionId ?? `sess-${id}`, kind: 'agent',
    ownerId: 'user-1', scopes, projectIds: ['p1'],
  };
}

function fixture(): { ctx: Context; store: MemoryStore } {
  const store = new MemoryStore(createState({ id: 'p1', goal: 'lane03', mode: 'live', now: clock }));
  return { ctx: { principal: owner, store, now, uid }, store };
}

const req = (path: string, init?: RequestInit) =>
  new Request(`https://x.test/api/v1/projects/p1${path}`, init);

type Handler = (
  ctx: Context, request: Request, segments: string[], body?: Record<string, unknown>,
) => Promise<Response | null>;

function call(handler: Handler, ctx: Context, method: string, path: string, body?: Record<string, unknown>) {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const r = handler(ctx, req(path, { method }), segments, body);
  return r as Promise<Response>;
}

const errIs = (status: number, code?: string) => (err: { status: number; code: string }) =>
  err.status === status && (code === undefined || err.code === code);

async function makeTask(ctx: Context, goal = 'lane03 work'): Promise<Task> {
  const res = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: `op-task-${goal}-${seq}`, goal, acceptanceCriteria: ['done'],
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { task: Task }).task;
}

async function enrollAgent(
  ctx: Context, store: MemoryStore, scopes?: string[], displayName = 'bot',
): Promise<{ identityId: string; token: string; principal: Principal }> {
  let res = await call(handleIdentity, ctx, 'POST', '/identities', {
    operationId: `op-id-${displayName}-${seq}`, displayName,
  });
  assert.equal(res.status, 201);
  const identityId = ((await res.json()) as { identity: { id: string } }).identity.id;
  res = await call(handleIdentity, ctx, 'POST', `/identities/${identityId}/invitations`, {
    operationId: `op-inv-${displayName}-${seq}`, ...(scopes ? { scopes } : {}),
  });
  assert.equal(res.status, 201);
  const inviteToken = ((await res.json()) as { token: string }).token;
  const enrolled = (await authenticate(
    req('/enrollment/exchange', { headers: { authorization: `Bearer ${inviteToken}` } }),
    await store.read(), AUTH_OPTS,
  )) as EnrollmentPrincipal;
  const ectx: Context = { principal: enrolled, store, now, uid };
  res = await call(handleIdentity, ectx, 'POST', '/enrollment/exchange', {
    operationId: `op-ex-${displayName}-${seq}`,
  });
  assert.equal(res.status, 201);
  const token = ((await res.json()) as { token: string }).token;
  const principal = await authenticate(
    req('/x', { headers: { authorization: `Bearer ${token}` } }), await store.read(), AUTH_OPTS,
  );
  assert.ok(principal);
  return { identityId, token, principal: principal as Principal };
}

test('creation revision contract: expectedRevision 1 allowed, other values 409, no collection lock', async () => {
  const { ctx } = fixture();
  // Controller reproducer (HTTP-CLI-FINAL-PREFLIGHT): expectedRevision 1 on
  // POST /tasks was 422 invalid_target. It now asserts the fresh record's
  // initial revision -- always 1 -- and is accepted.
  const created = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: 'op-crev-1', expectedRevision: 1,
    goal: 'documented envelope create', acceptanceCriteria: ['ok'],
  });
  assert.equal(created.status, 201);
  const task = ((await created.json()) as { task: Task }).task;
  assert.equal(task.revision, 1);

  // Same operationId replays the stored result -- including when the replay
  // omits the (semantically identical) fresh-revision assertion.
  const replay = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: 'op-crev-1', goal: 'documented envelope create', acceptanceCriteria: ['ok'],
  });
  assert.equal(replay.status, 201);
  assert.equal(((await replay.json()) as { task: Task }).task.id, task.id);

  // Any other value is a stale caller model, not a create.
  await assert.rejects(
    call(handleAssignments, ctx, 'POST', '/tasks', {
      operationId: 'op-crev-2', expectedRevision: 3,
      goal: 'stale model', acceptanceCriteria: ['ok'],
    }),
    errIs(409, 'stale_revision'),
  );

  // No global/collection lock: another create with the same assertion still
  // proceeds concurrently; unrelated revisions are untouched.
  const second = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: 'op-crev-3', expectedRevision: 1,
    goal: 'second create', acceptanceCriteria: ['ok'],
  });
  assert.equal(second.status, 201);
  const state = await ctx.store.read();
  assert.equal(state.tasks[task.id].revision, 1);
  assert.equal(state.project.revision, 1);
});

test('creation revision contract also holds on owned identity creates', async () => {
  const { ctx, store } = fixture();
  const created = await call(handleIdentity, ctx, 'POST', '/identities', {
    operationId: 'op-crev-id', expectedRevision: 1, displayName: 'envelope-agent',
  });
  assert.equal(created.status, 201);
  const identityId = ((await created.json()) as { identity: { id: string } }).identity.id;

  await assert.rejects(
    call(handleIdentity, ctx, 'POST', '/identities', {
      operationId: 'op-crev-id2', expectedRevision: 5, displayName: 'stale',
    }),
    errIs(409, 'stale_revision'),
  );

  // Invitation mint is a secret-returning create: the same contract applies
  // (previously the field was silently ignored, now validated).
  const inv = await call(handleIdentity, ctx, 'POST', `/identities/${identityId}/invitations`, {
    operationId: 'op-crev-inv', expectedRevision: 1,
  });
  assert.equal(inv.status, 201);
  const inviteToken = ((await inv.json()) as { token: string }).token;
  await assert.rejects(
    call(handleIdentity, ctx, 'POST', `/identities/${identityId}/invitations`, {
      operationId: 'op-crev-inv2', expectedRevision: 4,
    }),
    errIs(409, 'stale_revision'),
  );

  // Exchange is the credential mint: expectedRevision 1 accepted.
  const enrolled = (await authenticate(
    req('/enrollment/exchange', { headers: { authorization: `Bearer ${inviteToken}` } }),
    await store.read(), AUTH_OPTS,
  )) as EnrollmentPrincipal;
  const ex = await call(handleIdentity, { principal: enrolled, store, now, uid }, 'POST', '/enrollment/exchange', {
    operationId: 'op-crev-ex', expectedRevision: 1,
  });
  assert.equal(ex.status, 201);
  const body = (await ex.json()) as { credentialId: string };
  assert.equal((await store.read()).credentials[body.credentialId].revision, 1);
});

test('reclaim on a done or cancelled task is rejected; closed work is not resurrected', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'closed-work');
  const a = agent('agent-reclaim', ['read', 'tasks:claim']);
  const res = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-closed', expectedRevision: 1, leaseMs: 1000, maxMs: 60_000,
  });
  const asg = ((await res.json()) as { assignment: Assignment }).assignment;

  await store.transact((draft) => {
    draft.tasks[task.id].lifecycle = 'done';
    return true;
  });
  advance(2000); // lease expired: reclaimable in principle -- but the task is closed
  const rev = (await store.read()).tasks[task.id].revision;
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: agent('agent-b', ['read', 'tasks:claim']) }, 'POST', `/tasks/${task.id}/reclaim`, {
      operationId: 'op-rec-done', expectedRevision: rev,
    }),
    errIs(409, 'task_closed'),
  );
  const after = await store.read();
  assert.equal(after.tasks[task.id].lifecycle, 'done');
  assert.equal(after.tasks[task.id].currentAssignmentId, asg.id);
  assert.equal(after.assignments[asg.id].status, 'active');
  assert.equal(after.assignments[asg.id].epoch, 1);
});

test('system records cannot be claimed: candidates 422, jobs/receipts/findings 404', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    draft.candidates['cand-sys'] = {
      id: 'cand-sys', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'sys', base: 'b'.repeat(40), proposalIds: [], proposalHeads: {},
      sha: 'd'.repeat(40), policyVersion: 1, status: 'prepared', checkJobIds: [], reviewIds: [],
    };
    draft.jobs['job-sys'] = {
      id: 'job-sys', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'sys', candidateId: 'cand-sys', candidateSha: 'd'.repeat(40),
      command: 'npm test', status: 'queued',
    };
    draft.receipts['rcpt-sys'] = {
      id: 'rcpt-sys', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'sys', jobId: 'job-sys', candidateSha: 'd'.repeat(40), collectorId: 'c1',
      command: 'npm test', outcome: 'pass', artifactRefs: [],
    };
    draft.findings['find-sys'] = {
      id: 'find-sys', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'sys', expected: 'e', observed: 'o', state: 'possible-issue',
      originatorId: 'u1', receiptIds: [],
    };
    return true;
  });
  const a = agent('agent-sys', ['read', 'tasks:claim']);
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: a }, 'POST', '/candidates/cand-sys/assignments', {
      operationId: 'op-sys-cand',
    }),
    errIs(422, 'candidate_not_claimable'),
  );
  for (const id of ['job-sys', 'rcpt-sys', 'find-sys']) {
    await assert.rejects(
      call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${id}/assignments`, {
        operationId: `op-sys-${id}`, expectedRevision: 1,
      }),
      errIs(404, 'not_found'),
    );
  }
  // Nothing was mutated: no assignment references the system records.
  const state = await store.read();
  assert.equal(Object.keys(state.assignments).length, 0);
});

test('alias and child identities: same identity new session shares ownership; child is a distinct identity', async () => {
  const { ctx, store } = fixture();
  const parent = await enrollAgent(ctx, store, ['read', 'identity:delegate', 'tasks:claim'], 'parent03');
  const pctx: Context = { principal: parent.principal, store, now, uid };
  const res = await call(handleIdentity, pctx, 'POST', '/identities', {
    operationId: 'op-child03', displayName: 'helper', parentId: parent.identityId,
  });
  const childId = ((await res.json()) as { identity: { id: string } }).identity.id;
  assert.notEqual(childId, parent.identityId);

  // Same stable identity authenticating on a second session is still the
  // same principal.id -- aliases never mint a separate identity.
  const alias = agent(parent.identityId, parent.principal.scopes, 'sess-second');
  const task = await makeTask(ctx, 'alias-task');
  const claim = await call(handleAssignments, { ...ctx, principal: parent.principal }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-alias-1', expectedRevision: 1,
  });
  assert.equal(claim.status, 201);
  const asg = ((await claim.json()) as { assignment: Assignment }).assignment;
  // The second session of the same identity holds the same assignment and
  // cannot double-claim the owner role.
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: alias }, 'POST', `/tasks/${task.id}/assignments`, {
      operationId: 'op-alias-2', expectedRevision: (await store.read()).tasks[task.id].revision,
    }),
    errIs(409, 'already_claimed'),
  );
  const state = await store.read();
  assert.equal(state.assignments[asg.id].identityId, parent.identityId);
  assert.equal(state.identities[childId].parentId, parent.identityId);
  assert.equal(state.identities[childId].ownerId, state.identities[parent.identityId].ownerId);
});

test('revocation denial: pending invitation of a revoked identity can never exchange', async () => {
  const { ctx, store } = fixture();
  let res = await call(handleIdentity, ctx, 'POST', '/identities', {
    operationId: 'op-rv-id', displayName: 'soon-revoked',
  });
  const identityId = ((await res.json()) as { identity: { id: string } }).identity.id;
  res = await call(handleIdentity, ctx, 'POST', `/identities/${identityId}/invitations`, {
    operationId: 'op-rv-inv',
  });
  const inviteToken = ((await res.json()) as { token: string }).token;

  res = await call(handleIdentity, ctx, 'POST', `/identities/${identityId}/revoke`, {
    operationId: 'op-rv-rev', expectedRevision: 1,
  });
  assert.equal(res.status, 200);
  // The still-pending invitation token no longer resolves to a principal.
  assert.equal(await authenticate(
    req('/enrollment/exchange', { headers: { authorization: `Bearer ${inviteToken}` } }),
    await store.read(), AUTH_OPTS,
  ), null);
});

test('epoch gate: stale and reclaimed epochs cannot submit; expired-unreclaimed can', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'epoch-gate');
  const a = agent('agent-epoch', ['read', 'tasks:claim']);
  const res = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-epoch-claim', expectedRevision: 1, leaseMs: 1000, maxMs: 60_000,
  });
  const asg = ((await res.json()) as { assignment: Assignment }).assignment;

  // Wrong epoch number while lease is live: stale_epoch, not a submit.
  let state = await store.read();
  assert.throws(() => assertAssignmentEpoch(state, { assignmentId: asg.id, epoch: 9, now: clock }), errIs(409, 'stale_epoch'));

  advance(1500); // lease expired, nobody reclaimed: the holder may still submit
  state = await store.read();
  assert.equal(assertAssignmentEpoch(state, { assignmentId: asg.id, epoch: 1, now: clock }).epochState, 'expired-unreclaimed');

  // Reclaim seats epoch 2; the epoch-1 write path is closed for submission
  // and routes to preserved late output instead.
  const rev = state.tasks[task.id].revision;
  const rec = await call(handleAssignments, { ...ctx, principal: agent('agent-epoch2', ['read', 'tasks:claim']) }, 'POST', `/tasks/${task.id}/reclaim`, {
    operationId: 'op-epoch-reclaim', expectedRevision: rev,
  });
  assert.equal(rec.status, 201);
  state = await store.read();
  assert.throws(() => assertAssignmentEpoch(state, { assignmentId: asg.id, epoch: 1, now: clock }), errIs(409, 'epoch_reclaimed'));
  assert.equal(state.lateOutputs.length, 0);
});
