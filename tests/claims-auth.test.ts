// Unit evidence for seat b-swe-03: scoped identity/enrollment with
// revocation, atomic task claims, epochs, lease renewal, job heartbeats and
// late-output preservation. Runs with:
//   node --test tests/claims-auth.test.ts   (Node >=22.18 type stripping)
// or the root script: tsx --test tests/*.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { createState, safeSnapshot } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import {
  authenticate, handleIdentity, type EnrollmentPrincipal,
} from '../lib/identity.ts';
import {
  assertAssignmentEpoch, handleAssignments, preserveLateOutput,
  renewForJobHeartbeat,
} from '../lib/assignments.ts';
import type {
  Assignment, CheckJob, Context, Principal, Task,
} from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let clock = T0;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(Date.parse(clock) + ms).toISOString();
};
let seq = 0;
const uid = () => `id-${++seq}`;

const OWNER_TOKEN = 'owner-secret-fixed';
const owner: Principal = {
  id: 'user-1', sessionId: 'sess-owner', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read'], projectIds: ['p1'],
};
const AUTH_OPTS = { ownerTokens: [{ ownerId: 'user-1', token: OWNER_TOKEN }], now };

function agent(id: string, scopes: string[]): Principal {
  return { id, sessionId: `sess-${id}`, kind: 'agent', ownerId: 'user-1', scopes, projectIds: ['p1'] };
}

function fixture(): { ctx: Context; store: MemoryStore } {
  const store = new MemoryStore(createState({ id: 'p1', goal: 'ship', mode: 'live', now: clock }));
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

async function makeTask(ctx: Context, goal = 'do work'): Promise<Task> {
  const res = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: `op-task-${goal}`, goal, acceptanceCriteria: ['done'],
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
  assert.ok(enrolled?.enrollment);
  const ectx: Context = { principal: enrolled, store, now, uid };
  res = await call(handleIdentity, ectx, 'POST', '/enrollment/exchange', {
    operationId: `op-ex-${displayName}-${seq}`, adapter: 'cli',
  });
  assert.equal(res.status, 201);
  const token = ((await res.json()) as { token: string }).token;
  const principal = await authenticate(
    req('/x', { headers: { authorization: `Bearer ${token}` } }), await store.read(), AUTH_OPTS,
  );
  assert.ok(principal);
  return { identityId, token, principal };
}

test('authenticate: owner credential comes from server config only; bearer-less and unknown tokens fail', async () => {
  const { store } = fixture();
  const state = await store.read();
  const p = await authenticate(req('/x', { headers: { authorization: `Bearer ${OWNER_TOKEN}` } }), state, AUTH_OPTS);
  assert.equal(p?.kind, 'human');
  assert.equal(p?.id, 'user-1');
  assert.ok(p?.scopes.includes('admin'));
  assert.equal(await authenticate(req('/x'), state, AUTH_OPTS), null);
  assert.equal(await authenticate(req('/x', { headers: { authorization: 'Bearer wrong' } }), state, AUTH_OPTS), null);
  assert.equal(await authenticate(req('/x', { headers: { authorization: `Bearer ${OWNER_TOKEN}` } }), state), null);
});

test('enrollment: invite returns the secret once, exchange mints a hashed credential, duplicate exchange fails', async () => {
  const { ctx, store } = fixture();
  const res = await call(handleIdentity, ctx, 'POST', '/identities', {
    operationId: 'op-id-a', displayName: 'Builder',
  });
  assert.equal(res.status, 201);
  const identityId = ((await res.json()) as { identity: { id: string } }).identity.id;

  const inv = await call(handleIdentity, ctx, 'POST', `/identities/${identityId}/invitations`, {
    operationId: 'op-inv-a',
  });
  assert.equal(inv.status, 201);
  const invBody = (await inv.json()) as { token: string; invitationId: string; tokenRedacted: boolean };
  assert.ok(invBody.token.startsWith('inv_'));
  const storedOp = (await store.read()).operations['op-inv-a'];
  assert.equal(storedOp.result?.status, 201);
  assert.equal((storedOp.result?.body as Record<string, unknown>).token, undefined);
  assert.equal((storedOp.result?.body as Record<string, unknown>).tokenRedacted, true);

  const enrolled = (await authenticate(
    req('/enrollment/exchange', { headers: { authorization: `Bearer ${invBody.token}` } }),
    await store.read(), AUTH_OPTS,
  )) as EnrollmentPrincipal;
  assert.deepEqual(enrolled.scopes, ['enroll']);
  assert.equal(enrolled.id, identityId);

  const ectx: Context = { principal: enrolled, store, now, uid };
  await assert.rejects(
    call(handleIdentity, ectx, 'POST', '/identities', { operationId: 'op-nope', displayName: 'x' }),
    errIs(403, 'scope_denied'),
  );

  const ex = await call(handleIdentity, ectx, 'POST', '/enrollment/exchange', {
    operationId: 'op-ex-a', adapter: 'cli', model: 'test-model',
  });
  assert.equal(ex.status, 201);
  const exBody = (await ex.json()) as { token: string; credentialId: string; sessionId: string };
  assert.ok(exBody.token.startsWith('cred_'));
  const exOp = (await store.read()).operations['op-ex-a'];
  assert.equal((exOp.result?.body as Record<string, unknown>).token, undefined);
  const cred = Object.values((await store.read()).credentials).find((c) => c.id === exBody.credentialId);
  assert.equal(cred?.tokenHash.length, 64);
  assert.notEqual(cred?.tokenHash, exBody.token);

  const principal = await authenticate(
    req('/x', { headers: { authorization: `Bearer ${exBody.token}` } }), await store.read(), AUTH_OPTS,
  );
  assert.equal(principal?.kind, 'agent');
  assert.equal(principal?.id, identityId);
  assert.deepEqual([...(principal?.scopes ?? [])].sort(),
    ['assignments:write', 'read', 'tasks:claim', 'tasks:write'].sort());
  assert.deepEqual(principal?.projectIds, ['p1']);

  assert.equal(await authenticate(
    req('/enrollment/exchange', { headers: { authorization: `Bearer ${invBody.token}` } }),
    await store.read(), AUTH_OPTS,
  ), null);
});

test('expired invitations never authenticate', async () => {
  const { ctx, store } = fixture();
  let res = await call(handleIdentity, ctx, 'POST', '/identities', { operationId: 'op-id-e', displayName: 'E' });
  const identityId = ((await res.json()) as { identity: { id: string } }).identity.id;
  res = await call(handleIdentity, ctx, 'POST', `/identities/${identityId}/invitations`, {
    operationId: 'op-inv-e', ttlMs: 1000,
  });
  const token = ((await res.json()) as { token: string }).token;
  advance(2000);
  assert.equal(await authenticate(
    req('/x', { headers: { authorization: `Bearer ${token}` } }), await store.read(), AUTH_OPTS,
  ), null);
});

test('revocation blocks new reads/writes: credential, session and identity', async () => {
  const { ctx, store } = fixture();
  const { identityId, token } = await enrollAgent(ctx, store, undefined, 'revokee');
  const p1 = await authenticate(req('/x', { headers: { authorization: `Bearer ${token}` } }), await store.read(), AUTH_OPTS);
  assert.ok(p1);

  const res = await call(handleIdentity, ctx, 'POST', `/identities/${identityId}/revoke`, {
    operationId: 'op-rev-1', expectedRevision: 1,
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { revokedRecords: number }).revokedRecords >= 2, true);
  assert.equal(await authenticate(req('/x', { headers: { authorization: `Bearer ${token}` } }), await store.read(), AUTH_OPTS), null);

  const second = await enrollAgent(ctx, store, undefined, 'second');
  const cred = Object.values((await store.read()).credentials).find((c) => c.identityId === second.identityId);
  assert.ok(cred);
  const rr = await call(handleIdentity, ctx, 'POST', `/credentials/${cred.id}/revoke`, {
    operationId: 'op-rev-2', expectedRevision: cred.revision,
  });
  assert.equal(rr.status, 200);
  assert.equal(await authenticate(req('/x', { headers: { authorization: `Bearer ${second.token}` } }), await store.read(), AUTH_OPTS), null);
});

test('delegated enrollment: child identity, narrowed invite scopes, parent inbox stays private', async () => {
  const { ctx, store } = fixture();
  const parent = await enrollAgent(ctx, store, ['read', 'identity:delegate', 'tasks:claim'], 'parent');

  const pctx: Context = { principal: parent.principal, store, now, uid };
  let res = await call(handleIdentity, pctx, 'POST', '/identities', {
    operationId: 'op-child-1', displayName: 'helper', parentId: parent.identityId,
  });
  assert.equal(res.status, 201);
  const childId = ((await res.json()) as { identity: { id: string; parentId?: string; creationSource: string } }).identity;
  assert.equal(childId.parentId, parent.identityId);
  assert.equal(childId.creationSource, 'delegated');

  const other = await enrollAgent(ctx, store, undefined, 'other');
  await assert.rejects(
    call(handleIdentity, pctx, 'POST', '/identities', {
      operationId: 'op-child-x', displayName: 'intruder', parentId: other.identityId,
    }),
    errIs(403, 'scope_denied'),
  );

  await assert.rejects(
    call(handleIdentity, pctx, 'POST', `/identities/${childId.id}/invitations`, {
      operationId: 'op-cinv-wide', scopes: ['read', 'assignments:write'],
    }),
    errIs(422, 'scope_not_delegable'),
  );
  res = await call(handleIdentity, pctx, 'POST', `/identities/${childId.id}/invitations`, {
    operationId: 'op-cinv-1', scopes: ['read'],
  });
  assert.equal(res.status, 201);
  const childInvite = ((await res.json()) as { token: string }).token;
  const enrolled = (await authenticate(
    req('/x', { headers: { authorization: `Bearer ${childInvite}` } }), await store.read(), AUTH_OPTS,
  )) as EnrollmentPrincipal;
  const ex = await call(handleIdentity, { principal: enrolled, store, now, uid }, 'POST', '/enrollment/exchange', {
    operationId: 'op-cex-1',
  });
  const childToken = ((await ex.json()) as { token: string }).token;
  const child = await authenticate(
    req('/x', { headers: { authorization: `Bearer ${childToken}` } }), await store.read(), AUTH_OPTS,
  );
  assert.deepEqual(child?.scopes, ['read']);

  await assert.rejects(
    call(handleIdentity, { principal: child as Principal, store, now, uid }, 'POST', '/identities', {
      operationId: 'op-grandchild', displayName: 'gc', parentId: childId.id,
    }),
    errIs(403, 'scope_denied'),
  );

  await store.transact((draft) => {
    draft.messages['m-parent'] = {
      id: 'm-parent', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'user-1', recipientId: parent.identityId, senderId: 'user-1',
      type: 'system-notice', body: 'for parent only', delivery: 'queued',
    };
    return true;
  });
  const state = await store.read();
  assert.equal(Object.keys(safeSnapshot(state, child as Principal).messages).length, 0);
  assert.deepEqual(Object.keys(safeSnapshot(state, parent.principal).messages), ['m-parent']);
});

test('delegated child count is an explicit limit, not silent permission', async () => {
  const { ctx, store } = fixture();
  const parent = await enrollAgent(ctx, store, ['read', 'identity:delegate'], 'delegator');
  const pctx: Context = { principal: parent.principal, store, now, uid };
  for (let i = 0; i < 4; i++) {
    const res = await call(handleIdentity, pctx, 'POST', '/identities', {
      operationId: `op-dc-${i}`, displayName: `c${i}`, parentId: parent.identityId,
    });
    assert.equal(res.status, 201);
  }
  await assert.rejects(
    call(handleIdentity, pctx, 'POST', '/identities', {
      operationId: 'op-dc-5', displayName: 'c5', parentId: parent.identityId,
    }),
    errIs(429, 'limit_exceeded'),
  );
});

test('task create validates fields, dependency kinds, unknowns, candidate IDs and cycles', async () => {
  const { ctx, store } = fixture();
  const mk = (body: Record<string, unknown>) =>
    call(handleAssignments, ctx, 'POST', '/tasks', body);

  await assert.rejects(mk({ operationId: 't-bad-1', acceptanceCriteria: ['x'] }), errIs(422, 'missing_field'));
  await assert.rejects(mk({ operationId: 't-bad-2', goal: 'g', acceptanceCriteria: [] }), errIs(422, 'invalid_field'));
  const t1 = await makeTask(ctx, 't1');
  await assert.rejects(
    mk({ operationId: 't-bad-3', goal: 'g', acceptanceCriteria: ['x'], dependencies: [{ taskId: t1.id, kind: 'help' }] }),
    errIs(422, 'invalid_dependency_kind'),
  );
  await assert.rejects(
    mk({ operationId: 't-bad-4', goal: 'g', acceptanceCriteria: ['x'], dependencies: [{ taskId: 'ghost', kind: 'prerequisite' }] }),
    errIs(422, 'invalid_dependency'),
  );
  await assert.rejects(
    mk({ operationId: 't-bad-5', goal: 'g', acceptanceCriteria: ['x'], dependencies: [{ taskId: t1.id, kind: 'prerequisite' }, { taskId: t1.id, kind: 'prerequisite' }] }),
    errIs(422, 'invalid_dependency'),
  );

  const dep = await makeTask(ctx, 'dep');
  const dependent = ((await (await mk({
    operationId: 't-dep', goal: 'g', acceptanceCriteria: ['x'],
    dependencies: [{ taskId: dep.id, kind: 'prerequisite' }],
  })).json()) as { task: Task }).task;
  const lay = await call(handleAssignments, ctx, 'POST', `/tasks/${dependent.id}/layout`, {
    operationId: 'op-lay-1', expectedRevision: 1, layout: { x: 10, y: 20 },
  });
  assert.equal(lay.status, 200);
  const laid = ((await lay.json()) as { task: Task }).task;
  assert.deepEqual(laid.layout, { x: 10, y: 20 });
  assert.equal(laid.dependencies.length, 1);

  await store.transact((draft) => {
    draft.candidates['cand-1'] = { id: 'cand-1', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock, actorId: 'sys' } as never;
    draft.tasks['ca'] = { id: 'ca', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock, actorId: 'u', goal: 'a', acceptanceCriteria: ['x'], dependencies: [{ taskId: 'cb', kind: 'prerequisite' }], lifecycle: 'open', resultRefs: [] };
    draft.tasks['cb'] = { id: 'cb', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock, actorId: 'u', goal: 'b', acceptanceCriteria: ['x'], dependencies: [{ taskId: 'ca', kind: 'prerequisite' }], lifecycle: 'open', resultRefs: [] };
    return true;
  });
  await assert.rejects(
    mk({ operationId: 't-bad-6', goal: 'g', acceptanceCriteria: ['x'], dependencies: [{ taskId: 'cand-1', kind: 'prerequisite' }] }),
    errIs(422, 'candidate_not_task'),
  );
  await assert.rejects(
    mk({ operationId: 't-bad-7', goal: 'g', acceptanceCriteria: ['x'], dependencies: [{ taskId: 'ca', kind: 'contributes-changes' }] }),
    errIs(422, 'dependency_cycle'),
  );
});

test('two simultaneous claims produce exactly one owner; helper roles are separate assignments', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'contested');
  const a = agent('agent-a', ['read', 'tasks:claim']);
  const b = agent('agent-b', ['read', 'tasks:claim']);
  const results = await Promise.allSettled([
    call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
      operationId: 'op-claim-a', expectedRevision: 1,
    }),
    call(handleAssignments, { ...ctx, principal: b }, 'POST', `/tasks/${task.id}/assignments`, {
      operationId: 'op-claim-b', expectedRevision: 1,
    }),
  ]);
  const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : (r.reason as { status: number }).status));
  assert.deepEqual(statuses.sort(), [201, 409]);

  let state = await store.read();
  const winners = Object.values(state.assignments).filter((x) => x.taskId === task.id && x.role === 'owner' && x.status === 'active');
  assert.equal(winners.length, 1);
  assert.equal(state.tasks[task.id].currentAssignmentId, winners[0].id);
  assert.equal(state.tasks[task.id].lifecycle, 'claimed');

  const taskNow = state.tasks[task.id];
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: b }, 'POST', `/tasks/${task.id}/assignments`, {
      operationId: 'op-claim-b2', expectedRevision: taskNow.revision,
    }),
    errIs(409, 'already_claimed'),
  );

  const help = await call(handleAssignments, { ...ctx, principal: b }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-helper', expectedRevision: taskNow.revision, role: 'helper',
  });
  assert.equal(help.status, 201);
  const helperA = ((await help.json()) as { assignment: Assignment }).assignment;
  assert.equal(helperA.role, 'helper');
  assert.equal(helperA.epoch, 1);
  state = await store.read();
  assert.equal(state.tasks[task.id].currentAssignmentId, winners[0].id);
  assert.equal(Object.values(state.assignments).filter((x) => x.taskId === task.id && x.status === 'active').length, 2);

  const t2 = (await store.read()).tasks[task.id];
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: b }, 'POST', `/tasks/${task.id}/assignments`, {
      operationId: 'op-claim-helper2', expectedRevision: t2.revision, role: 'helper',
    }),
    errIs(409, 'already_assigned'),
  );
});

test('candidate IDs are rejected by claim endpoints', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    draft.candidates['cand-9'] = { id: 'cand-9', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock, actorId: 'sys' } as never;
    return true;
  });
  const a = agent('agent-c', ['read', 'tasks:claim']);
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: a }, 'POST', '/tasks/cand-9/assignments', {
      operationId: 'op-cc-1', expectedRevision: 1,
    }),
    (err: { status: number }) => err.status === 404 || err.status === 422,
  );
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: a }, 'POST', '/candidates/cand-9/assignments', {
      operationId: 'op-cc-2',
    }),
    errIs(422, 'candidate_not_claimable'),
  );
});

test('expired-unreclaimed epoch submits; reclaim advances the epoch; late output is preserved separately', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'lease-me');
  const a = agent('agent-d', ['read', 'tasks:claim']);
  const res = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-d', expectedRevision: 1, leaseMs: 1000, maxMs: 60_000,
  });
  const first = ((await res.json()) as { assignment: Assignment }).assignment;
  assert.equal(first.epoch, 1);

  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: agent('agent-e', ['read', 'tasks:claim']) }, 'POST', `/tasks/${task.id}/reclaim`, {
      operationId: 'op-rec-early', expectedRevision: 2,
    }),
    errIs(409, 'claim_active'),
  );

  advance(1500); // lease expired, epoch unreclaimed: still writable
  const state = await store.read();
  const check = assertAssignmentEpoch(state, { assignmentId: first.id, epoch: 1, now: clock });
  assert.equal(check.epochState, 'expired-unreclaimed');

  const taskRev = state.tasks[task.id].revision;
  const rec = await call(handleAssignments, { ...ctx, principal: agent('agent-e', ['read', 'tasks:claim']) }, 'POST', `/tasks/${task.id}/reclaim`, {
    operationId: 'op-rec-1', expectedRevision: taskRev,
  });
  assert.equal(rec.status, 201);
  const recBody = (await rec.json()) as { assignment: Assignment; reclaimedFrom: { epoch: number } };
  assert.equal(recBody.assignment.epoch, 2);
  assert.equal(recBody.reclaimedFrom.epoch, 1);
  const after = await store.read();
  assert.equal(after.assignments[first.id].status, 'reclaimed');
  assert.equal(after.tasks[task.id].currentAssignmentId, recBody.assignment.id);

  assert.throws(() => assertAssignmentEpoch(after, { assignmentId: first.id, epoch: 1, now: clock }), errIs(409, 'epoch_reclaimed'));
  await store.transact((draft) => {
    const lo = preserveLateOutput(draft, ctx, {
      assignmentId: first.id, taskId: task.id, epoch: 1, kind: 'proposal', ref: 'sha-old',
    });
    assert.equal(lo.epoch, 1);
    return true;
  });
  const final = await store.read();
  assert.equal(final.lateOutputs.length, 1);
  assert.equal(final.lateOutputs[0].assignmentId, first.id);
  assert.equal(final.tasks[task.id].currentAssignmentId, recBody.assignment.id);
});

test('renew extends within maxUntil; stale epoch, missing epoch, non-holder and post-cap rejected', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'renew-me');
  const a = agent('agent-f', ['read', 'tasks:claim']);
  const res = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-f', expectedRevision: 1, leaseMs: 1000, maxMs: 3000,
  });
  const asg = ((await res.json()) as { assignment: Assignment }).assignment;
  assert.equal(asg.leaseExpiresAt, new Date(Date.parse(clock) + 1000).toISOString());
  assert.equal(asg.maxUntil, new Date(Date.parse(clock) + 3000).toISOString());

  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/renew`, {
      operationId: 'op-rn-noepoch', expectedRevision: 1,
    }),
    errIs(422, 'missing_epoch'),
  );
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/renew`, {
      operationId: 'op-rn-stale', expectedRevision: 1, assignmentEpoch: 9,
    }),
    errIs(409, 'stale_epoch'),
  );
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: agent('agent-g', ['read']) }, 'POST', `/assignments/${asg.id}/renew`, {
      operationId: 'op-rn-other', expectedRevision: 1, assignmentEpoch: 1,
    }),
    errIs(403, 'scope_denied'),
  );

  advance(500);
  const renewed = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/renew`, {
    operationId: 'op-rn-1', expectedRevision: 1, assignmentEpoch: 1, leaseMs: 60_000,
  });
  assert.equal(renewed.status, 200);
  const r2 = ((await renewed.json()) as { assignment: Assignment }).assignment;
  assert.equal(r2.leaseExpiresAt, asg.maxUntil);

  advance(3000); // past maxUntil
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/renew`, {
      operationId: 'op-rn-2', expectedRevision: 2, assignmentEpoch: 1,
    }),
    errIs(409, 'beyond_max'),
  );
});

test('job heartbeat renews only the registered owner and epoch, bounded by the job deadline', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'heartbeat-me');
  const a = agent('agent-h', ['read', 'tasks:claim']);
  const res = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-h', expectedRevision: 1, leaseMs: 1000, maxMs: 3_600_000,
  });
  const asg = ((await res.json()) as { assignment: Assignment }).assignment;
  const deadline = new Date(Date.parse(clock) + 30 * 60 * 1000).toISOString();
  const other = agent('agent-i', ['read', 'tasks:claim']);
  const res2 = await call(handleAssignments, { ...ctx, principal: other }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-i', expectedRevision: 2, role: 'helper',
  });
  const helperAsg = ((await res2.json()) as { assignment: Assignment }).assignment;

  await store.transact((draft) => {
    draft.jobs['job-1'] = {
      id: 'job-1', projectId: 'p1', revision: 1, createdAt: clock, updatedAt: clock,
      actorId: 'sys', candidateId: 'cand-x', candidateSha: 'sha1', command: 'npm test',
      status: 'running', ownerAssignmentId: asg.id, ownerEpoch: 1, deadlineAt: deadline,
    } as CheckJob;
    return true;
  });

  const hb = await store.transact((draft) =>
    renewForJobHeartbeat(draft, ctx, { jobId: 'job-1', assignmentId: asg.id, epoch: 1 }));
  assert.equal(hb.renewed, true);
  assert.equal(hb.leaseExpiresAt, deadline);
  assert.equal((await store.read()).assignments[asg.id].leaseExpiresAt, deadline);

  const late = await store.transact((draft) =>
    renewForJobHeartbeat(draft, ctx, { jobId: 'job-1', assignmentId: asg.id, epoch: 2 }));
  assert.equal(late.renewed, false);
  assert.equal(late.reason, 'superseded-epoch');

  const notOwner = await store.transact((draft) =>
    renewForJobHeartbeat(draft, ctx, { jobId: 'job-1', assignmentId: helperAsg.id, epoch: 1 }));
  assert.equal(notOwner.renewed, false);
  assert.equal(notOwner.reason, 'not-job-owner');
  assert.equal((await store.read()).assignments[helperAsg.id].leaseExpiresAt, helperAsg.leaseExpiresAt);
});

test('stop releases ownership atomically; project stop blocks new claims and resume restores them', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'stoppable');
  const a = agent('agent-j', ['read', 'tasks:claim']);
  const res = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-j', expectedRevision: 1,
  });
  const asg = ((await res.json()) as { assignment: Assignment }).assignment;

  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: agent('agent-k', ['read']) }, 'POST', `/assignments/${asg.id}/stop`, {
      operationId: 'op-stop-k', expectedRevision: 1,
    }),
    errIs(403, 'scope_denied'),
  );

  const stopped = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/stop`, {
    operationId: 'op-stop-j', expectedRevision: 1,
  });
  assert.equal(stopped.status, 200);
  let state = await store.read();
  assert.equal(state.assignments[asg.id].status, 'stopped');
  assert.equal(state.tasks[task.id].currentAssignmentId, undefined);
  assert.equal(state.tasks[task.id].lifecycle, 'open');

  const projRev = state.project.revision;
  const stop = await call(handleAssignments, ctx, 'POST', '/stop', {
    operationId: 'op-pstop', expectedRevision: projRev,
  });
  assert.equal(stop.status, 200);
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
      operationId: 'op-claim-blocked', expectedRevision: state.tasks[task.id].revision,
    }),
    errIs(409, 'project_stopped'),
  );
  state = await store.read();
  assert.equal(state.stopped, true);

  await call(handleAssignments, ctx, 'POST', '/resume', {
    operationId: 'op-pres', expectedRevision: state.project.revision,
  });
  const reclaimable = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${task.id}/assignments`, {
    operationId: 'op-claim-again', expectedRevision: (await store.read()).tasks[task.id].revision,
  });
  assert.equal(reclaimable.status, 201);
});

test('independent task revisions proceed concurrently; a claim on A never bumps B', async () => {
  const { ctx, store } = fixture();
  const t1 = await makeTask(ctx, 'task-a');
  const t2 = await makeTask(ctx, 'task-b');
  const a = agent('agent-l', ['read', 'tasks:claim']);
  const res = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${t1.id}/assignments`, {
    operationId: 'op-claim-l', expectedRevision: 1,
  });
  assert.equal(res.status, 201);
  const state = await store.read();
  assert.equal(state.tasks[t1.id].revision, 2);
  assert.equal(state.tasks[t2.id].revision, 1);
  const res2 = await call(handleAssignments, { ...ctx, principal: a }, 'POST', `/tasks/${t2.id}/assignments`, {
    operationId: 'op-claim-m', expectedRevision: 1, role: 'helper',
  });
  assert.equal(res2.status, 201);
});

test('task listing is bounded, state-filtered and cursor-paginated', async () => {
  const { ctx } = fixture();
  await makeTask(ctx, 'page-1');
  await makeTask(ctx, 'page-2');
  const a = agent('agent-n', ['read']);
  const page1 = await call(handleAssignments, { ...ctx, principal: a }, 'GET', '/tasks?state=open&limit=1');
  const p1 = (await page1.json()) as { tasks: Task[]; nextCursor: string | null; total: number };
  assert.equal(p1.tasks.length, 1);
  assert.equal(p1.total, 2);
  assert.ok(p1.nextCursor);
  const page2 = await call(handleAssignments, { ...ctx, principal: a }, 'GET', `/tasks?state=open&limit=1&cursor=${p1.nextCursor}`);
  const p2 = (await page2.json()) as { tasks: Task[]; nextCursor: string | null };
  assert.equal(p2.tasks.length, 1);
  assert.equal(p2.nextCursor, null);
  const denied = agent('agent-o', []);
  await assert.rejects(
    call(handleAssignments, { ...ctx, principal: denied }, 'GET', '/tasks'),
    errIs(403, 'scope_denied'),
  );
});
