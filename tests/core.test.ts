// Unit evidence for the b-swe-01 shared contract.
// Runs with: node --test tests/core.test.ts (Node >=22.18 type stripping)
// or the root script: tsx --test tests/*.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_BODY_BYTES, MAX_PROSE_CHARS, appendEvent, assertRevision, canonicalJSON,
  command, createState, digestOf, entity, exportSnapshot, fail, readJsonBody,
  requireFields, requireProse, requireScope, safeSnapshot, touchEntity,
} from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import type { Assignment, Context, Principal, ProjectState, Task } from '../lib/types.ts';

let seq = 0;
const uid = () => `id-${++seq}`;
const t0 = '2026-10-04T00:00:00.000Z';
const now = () => t0;

const principal: Principal = {
  id: 'user-1',
  sessionId: 'sess-1',
  kind: 'human',
  ownerId: 'user-1',
  scopes: ['admin', 'read', 'tasks:write'],
  projectIds: ['p1'],
};

function fixture(): { ctx: Context; store: MemoryStore } {
  const store = new MemoryStore(
    createState({ id: 'p1', goal: 'ship the slice', mode: 'live', now: t0 }),
  );
  const ctx: Context = { principal, store, now, uid };
  return { ctx, store };
}

const touchProject = { collection: 'project' } as const;

test('createState produces the fixed collection contract', () => {
  const state = createState({ id: 'p1', goal: 'g', mode: 'sample', now: t0 });
  assert.equal(state.project.id, 'p1');
  assert.equal(state.project.mode, 'sample');
  assert.equal(state.stopped, false);
  for (const name of [
    'members', 'sessions', 'identities', 'invitations', 'credentials', 'tasks',
    'assignments', 'help', 'messages', 'handoffs', 'proposals', 'candidates',
    'jobs', 'receipts', 'authorReports', 'reviews', 'findings', 'operations',
  ]) {
    assert.deepEqual(state[name as keyof ProjectState], {});
  }
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.lateOutputs, []);
});

test('command applies, bumps target revision, stores operation and event', async () => {
  const { ctx, store } = fixture();
  const res = await command(ctx, { operationId: 'op-1', expectedRevision: 1 }, 'tasks:write', touchProject, (draft) => {
    draft.tasks['t1'] = {
      id: 't1', projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0,
      actorId: 'user-1', goal: 'do a thing', acceptanceCriteria: ['it works'],
      dependencies: [], lifecycle: 'open', resultRefs: [],
    } as Task;
    return { status: 201, body: { ok: true } };
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
  const state = await store.read();
  assert.equal(state.project.revision, 2);
  assert.equal(state.operations['op-1'].digest.length, 64);
  assert.equal(state.operations['op-1'].effect, 'confirmed');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].seq, 1);
  assert.equal(state.tasks['t1'].goal, 'do a thing');
});

test('digest dedupe resolves before stale revision checks', async () => {
  const { ctx, store } = fixture();
  const body = { operationId: 'op-1', expectedRevision: 1, note: 'same' };
  const first = await command(ctx, body, 'tasks:write', touchProject, () => ({ status: 200, body: { n: 1 } }));
  assert.equal(first.status, 200);
  assert.equal((await store.read()).project.revision, 2);

  // Replay with the identical payload: expectedRevision 1 is now stale, but
  // the digest match must return the saved result without re-checking it.
  const replay = await command(ctx, body, 'tasks:write', touchProject, () => ({ status: 500, body: {} }));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { n: 1 });
  assert.equal((await store.read()).project.revision, 2);
  assert.equal((await store.read()).events.length, 1);

  // Same operationId with a different payload is a conflict, not a replay.
  await assert.rejects(
    command(ctx, { ...body, note: 'different' }, 'tasks:write', touchProject, () => ({ status: 200, body: {} })),
    (err: { status: number; code: string }) => err.status === 409 && err.code === 'conflicting_operation',
  );
});

test('stale expectedRevision is rejected with 409 after dedupe misses', async () => {
  const { ctx, store } = fixture();
  await command(ctx, { operationId: 'op-1', expectedRevision: 1 }, 'tasks:write', touchProject, () => ({ status: 200, body: {} }));
  await assert.rejects(
    command(ctx, { operationId: 'op-2', expectedRevision: 1 }, 'tasks:write', touchProject, () => ({ status: 200, body: {} })),
    (err: { status: number; code: string }) => err.status === 409 && err.code === 'stale_revision',
  );
  assert.equal((await store.read()).project.revision, 2);
});

test('a prior operation without a result replays as 202, not a duplicate', async () => {
  const { ctx, store } = fixture();
  const body = { operationId: 'op-ext', expectedRevision: 1 };
  const digest = await digestOf({ scope: 'integrate', target: touchProject, body });
  await store.transact((draft) => {
    draft.operations['op-ext'] = {
      id: 'op-ext', projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0,
      actorId: 'user-1', scope: 'integrate', target: touchProject, digest,
      intent: 'integrate', effect: 'unknown',
    };
    return true;
  });
  const res = await command(ctx, body, 'integrate', touchProject, () => ({ status: 200, body: {} }));
  assert.equal(res.status, 202);
  const payload = (await res.json()) as { effect: string; nextAction: string };
  assert.equal(payload.effect, 'unknown');
  assert.match(payload.nextAction, /operations\/op-ext/);
});

test('MemoryStore rolls back state, operation record and event on throw', async () => {
  const { ctx, store } = fixture();
  const before = await store.read();
  await assert.rejects(
    command(ctx, { operationId: 'op-bad', expectedRevision: 1 }, 'tasks:write', touchProject, (draft) => {
      draft.tasks['t-x'] = { id: 't-x' } as Task;
      draft.operations['op-bad'] = { id: 'op-bad' } as never;
      fail(422, 'invalid_dependency', 'cycle rejected');
    }),
    (err: { status: number }) => err.status === 422,
  );
  const after = await store.read();
  assert.equal(after.project.revision, before.project.revision);
  assert.equal(after.tasks['t-x'], undefined);
  assert.equal(after.operations['op-bad'], undefined);
  assert.equal(after.events.length, 0);
});

test('transact serializes concurrent writes without lost updates', async () => {
  const { store } = fixture();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.transact((draft) => {
        draft.project.revision += 1;
        draft.events.push({
          id: `e${i}`, projectId: 'p1', seq: draft.events.length + 1,
          createdAt: t0, actorId: 'user-1', actorKind: 'human', type: 'tick',
        });
        return draft.project.revision;
      }),
    ),
  );
  const state = await store.read();
  assert.equal(state.project.revision, 9);
  assert.equal(state.events.length, 8);
  assert.deepEqual(state.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('readJsonBody enforces the 256KiB body cap and JSON shape', async () => {
  const big = new Request('https://x.test/', {
    method: 'POST',
    body: JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) }),
  });
  await assert.rejects(readJsonBody(big), (err: { status: number; code: string }) => err.status === 429 && err.code === 'request_too_large');

  await assert.rejects(
    readJsonBody(new Request('https://x.test/', { method: 'POST', body: '{not json' })),
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'invalid_body',
  );
  await assert.rejects(
    readJsonBody(new Request('https://x.test/', { method: 'POST', body: '[1,2]' })),
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'invalid_body',
  );
  assert.deepEqual(await readJsonBody(new Request('https://x.test/', { method: 'POST', body: '' })), {});
  assert.deepEqual(
    await readJsonBody(new Request('https://x.test/', { method: 'POST', body: '{"a":1}' })),
    { a: 1 },
  );
});

test('schema helpers: requireFields, requireProse, missing operationId', async () => {
  assert.throws(() => requireFields({ a: 1 }, ['a', 'b']), (err: { code: string }) => err.code === 'missing_field');
  assert.throws(
    () => requireProse('x'.repeat(MAX_PROSE_CHARS + 1), 'goal'),
    (err: { code: string }) => err.code === 'prose_too_large',
  );
  assert.throws(() => requireProse(42, 'goal'), (err: { code: string }) => err.code === 'invalid_field');
  const { ctx } = fixture();
  await assert.rejects(
    command(ctx, {}, 'tasks:write', touchProject, () => ({ status: 200, body: {} })),
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'missing_operation',
  );
  // Entity-targeted writes must carry expectedRevision.
  await assert.rejects(
    command(ctx, { operationId: 'op-nr' }, 'tasks:write', touchProject, () => ({ status: 200, body: {} })),
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'missing_revision',
  );
});

test('requireScope: scope denied 403, foreign project 404, system bypass', () => {
  const { store } = fixture();
  void store;
  const state = createState({ id: 'p1', goal: 'g', mode: 'live' });
  assert.throws(
    () => requireScope({ ...principal, scopes: ['read'] }, 'tasks:write', state),
    (err: { status: number; code: string }) => err.status === 403 && err.code === 'scope_denied',
  );
  assert.throws(
    () => requireScope({ ...principal, projectIds: ['other'] }, 'tasks:write', state),
    (err: { status: number; code: string }) => err.status === 404 && err.code === 'not_found',
  );
  const sys: Principal = { id: 'sys', sessionId: 's', kind: 'system', ownerId: 'sys', scopes: [], projectIds: ['p1'] };
  requireScope(sys, 'anything', state);
});

test('module apply validates assignmentEpoch inside apply (not in core)', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    draft.assignments['a1'] = {
      id: 'a1', projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0,
      actorId: 'user-1', taskId: 't1', identityId: 'agent-1', role: 'builder',
      scopes: [], epoch: 2, leaseExpiresAt: t0, maxUntil: t0, status: 'active',
    } as Assignment;
    return true;
  });
  const applyEpoch = (draft: ProjectState) => {
    const a = entity<Assignment>(draft, 'assignments', 'a1');
    if (a.epoch !== 2) fail(409, 'stale_epoch', 'epoch moved');
    return { status: 200, body: { epoch: a.epoch } };
  };
  const res = await command(
    ctx, { operationId: 'op-e', expectedRevision: 1, assignmentEpoch: 2 },
    'tasks:write', { collection: 'assignments', id: 'a1' }, applyEpoch,
  );
  assert.equal(res.status, 200);
  assert.equal((await store.read()).assignments['a1'].revision, 2);
});

test('canonical digest is independent of object key insertion order', async () => {
  const a = { x: 1, nested: { b: 2, a: 1 }, list: [{ y: 1, z: 2 }] };
  const b = { list: [{ z: 2, y: 1 }], nested: { a: 1, b: 2 }, x: 1 };
  assert.equal(canonicalJSON(a), canonicalJSON(b));
  assert.equal(await digestOf(a), await digestOf(b));
  assert.notEqual(canonicalJSON({ a: [1, 2] }), canonicalJSON({ a: [2, 1] }));
});

test('safeSnapshot strips auth records and other inboxes; export strips all credentials', () => {
  const state = createState({ id: 'p1', goal: 'g', mode: 'live' });
  state.credentials['c1'] = { id: 'c1' } as never;
  state.invitations['i1'] = { id: 'i1' } as never;
  state.messages['m1'] = { id: 'm1', recipientId: 'user-1', senderId: 'a' } as never;
  state.messages['m2'] = { id: 'm2', recipientId: 'agent-2', senderId: 'b' } as never;
  const safe = safeSnapshot(state, principal);
  assert.deepEqual(safe.credentials, {});
  assert.deepEqual(safe.invitations, {});
  assert.deepEqual(Object.keys(safe.messages), ['m1']);
  const exported = exportSnapshot(state);
  assert.deepEqual(exported.credentials, {});
  assert.deepEqual(exported.invitations, {});
  assert.deepEqual(Object.keys(exported.messages).sort(), ['m1', 'm2']);
});

test('appendEvent assigns monotonic seq; touchEntity bumps independent revisions', () => {
  const state = createState({ id: 'p1', goal: 'g', mode: 'live' });
  const ctx = { principal, now, uid };
  const e1 = appendEvent(state, ctx, 'a');
  const e2 = appendEvent(state, ctx, 'b');
  assert.equal(e2.seq, e1.seq + 1);
  const task = { id: 't', projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0, actorId: 'u' } as Task;
  touchEntity(task, ctx, 'user-1');
  assert.equal(task.revision, 2);
  assert.equal(state.project.revision, 1);
  assert.throws(() => assertRevision(task, 1), (err: { code: string }) => err.code === 'stale_revision');
});
