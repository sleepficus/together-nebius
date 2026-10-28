// Lane r-swe-01 regression tests — record transaction, operation
// idempotency, byte limits, safe projection and rollback.
// Runs with: node --test tests/r-swe-01.test.ts (Node >=22.18 type stripping)

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PROSE_CHARS, command, createState, exportSnapshot, requireProse,
  safeSnapshot,
} from '../lib/core.ts';
import { MemoryStore, SQLiteStore } from '../lib/store.ts';
import { handleInbox } from '../lib/inbox.ts';
import type { AgentIdentity, CheckJob, Context, Entity, Message, Principal, ProjectState, Task } from '../lib/types.ts';

let seq = 0;
const uid = () => `id-${++seq}`;
const t0 = '2026-10-04T00:00:00.000Z';
const now = () => t0;

const writer: Principal = {
  id: 'agent-a', sessionId: 'sess-a', kind: 'agent', ownerId: 'steve',
  scopes: ['read', 'offers:write', 'tasks:write'], projectIds: ['p1'],
};
const reader: Principal = {
  id: 'agent-c', sessionId: 'sess-c', kind: 'agent', ownerId: 'steve',
  scopes: ['read'], projectIds: ['p1'],
};

function fixture(principal: Principal = writer): { ctx: Context; store: MemoryStore } {
  const store = new MemoryStore(
    createState({ id: 'p1', goal: 'lane fixture', mode: 'live', now: t0 }),
  );
  return { ctx: { principal, store, now, uid }, store };
}

function seedIdentities(store: MemoryStore): Promise<unknown> {
  return store.transact((draft) => {
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      draft.identities[id] = {
        id, projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0,
        actorId: 'steve', displayName: id, ownerId: 'steve',
        creationSource: 'owner', status: 'active',
      } as AgentIdentity;
    }
    draft.tasks['t1'] = {
      id: 't1', projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0,
      actorId: 'steve', goal: 'lane task', acceptanceCriteria: [],
      dependencies: [], lifecycle: 'open', resultRefs: [],
    } as Task;
    return true;
  });
}

test('idempotency: same id+digest replays result, different digest 409s without mutation', async () => {
  const { ctx, store } = fixture();
  const body = { operationId: 'op-1', expectedRevision: 1, payload: { note: 'same' } };
  const target = { collection: 'project' } as const;
  const first = await command(ctx, body, 'tasks:write', target, () => ({ status: 200, body: { n: 1 } }));
  assert.equal(first.status, 200);

  const replay = await command(ctx, body, 'tasks:write', target, () => ({ status: 500, body: {} }));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { n: 1 });
  assert.equal((await store.read()).events.length, 1);

  await assert.rejects(
    command(ctx, { ...body, payload: { note: 'different' } }, 'tasks:write', target, () => ({ status: 200, body: {} })),
    (err: { status: number; code: string }) => err.status === 409 && err.code === 'conflicting_operation',
  );
  const state = await store.read();
  assert.equal(state.project.revision, 2);
  assert.equal(state.events.length, 1);
});

test('stale after prior lookup: read-then-write with old revision fails 409', async () => {
  const { ctx, store } = fixture();
  await command(ctx, { operationId: 'op-a', expectedRevision: 1 }, 'tasks:write',
    { collection: 'project' }, () => ({ status: 200, body: {} }));
  // A client looked up revision 1, then another write landed.
  const lookedUp = await store.read();
  assert.equal(lookedUp.project.revision, 2);
  await assert.rejects(
    command(ctx, { operationId: 'op-b', expectedRevision: 1 }, 'tasks:write',
      { collection: 'project' }, () => ({ status: 200, body: {} })),
    (err: { status: number; code: string }) => err.status === 409 && err.code === 'stale_revision',
  );
  assert.equal((await store.read()).project.revision, 2);
});

test('malformed expectedRevision is 422 invalid_field, not 409 stale', async () => {
  const { ctx } = fixture();
  for (const bad of ['1', 1.5, 0, -2, true]) {
    await assert.rejects(
      command(ctx, { operationId: `op-${String(bad)}`, expectedRevision: bad as never }, 'tasks:write',
        { collection: 'project' }, () => ({ status: 200, body: {} })),
      (err: { status: number; code: string }) => err.status === 422 && err.code === 'invalid_field',
      `expectedRevision=${String(bad)}`,
    );
  }
});

test('16KiB prose cap is measured in UTF-8 bytes, not code units', () => {
  // 4096 four-byte emoji = exactly 16384 bytes: allowed.
  assert.doesNotThrow(() => requireProse('\u{1F525}'.repeat(4096), 'goal'));
  // One more char crosses the byte cap even though length is 4097 code units.
  assert.throws(
    () => requireProse('\u{1F525}'.repeat(4097), 'goal'),
    (err: { code: string }) => err.code === 'prose_too_large',
  );
  // A BMP string of 16385 chars (>16KiB UTF-8) is rejected too.
  assert.throws(
    () => requireProse('x'.repeat(MAX_PROSE_CHARS + 1), 'goal'),
    (err: { code: string }) => err.code === 'prose_too_large',
  );
});

test('safe projection: third party cannot read another inbox body via operations result', async () => {
  const { ctx, store } = fixture(writer);
  await seedIdentities(store);
  const secret = 'PRIVATE-OFFER-NOTE-9f3k';
  const res = await handleInbox(
    ctx,
    new Request('https://x.test/', { method: 'POST' }),
    ['tasks', 't1', 'offers'],
    { operationId: 'op-offer-1', toId: 'agent-b', note: secret },
  );
  assert.equal(res?.status, 201);

  const state = await store.read();
  // The durable record keeps the exact result for idempotent replay.
  const persisted = (state.operations['op-offer-1'].result?.body as Record<string, { body?: string }>).message;
  assert.equal(persisted.body, secret);

  const thirdParty = safeSnapshot(state, reader);
  const projected = (thirdParty.operations['op-offer-1'].result?.body as Record<string, { body?: string; redacted?: string }>).message;
  assert.notEqual(projected.body, secret);
  assert.equal(projected.redacted, 'private message');
  assert.deepEqual(Object.keys(thirdParty.messages), []);

  // The sender and the recipient still see the full content.
  for (const party of [
    { ...writer },
    { id: 'agent-b', sessionId: 's-b', kind: 'agent', ownerId: 'steve', scopes: ['read'], projectIds: ['p1'] } as Principal,
  ]) {
    const view = safeSnapshot(state, party);
    const visible = (view.operations['op-offer-1'].result?.body as Record<string, { body?: string }>).message;
    assert.equal(visible.body, secret);
  }
});

test('private verifier redaction: collectorTokenHash never crosses safe/export views', () => {
  const state = createState({ id: 'p1', goal: 'g', mode: 'live', now: t0 });
  state.jobs['j1'] = {
    id: 'j1', projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0,
    actorId: 'checker', candidateId: 'c1', candidateSha: 'a'.repeat(40),
    command: 'npm test', status: 'queued', collectorTokenHash: 'deadbeef',
  } as CheckJob;
  for (const view of [safeSnapshot(state, reader), exportSnapshot(state)]) {
    const job = view.jobs['j1'] as Record<string, unknown>;
    assert.equal('collectorTokenHash' in job, false);
    assert.equal(job.command, 'npm test');
  }
});

test('MemoryStore rollback: a failing apply persists no mutation, op or event', async () => {
  const { ctx, store } = fixture();
  const before = await store.read();
  await assert.rejects(
    command(ctx, { operationId: 'op-bad', expectedRevision: 1 }, 'tasks:write',
      { collection: 'project' }, (draft) => {
        draft.tasks['ghost'] = { id: 'ghost' } as Task;
        draft.operations['op-bad'] = { id: 'op-bad' } as never;
        throw new Error('domain failure mid-apply');
      }),
    /domain failure/,
  );
  const after = await store.read();
  assert.equal(after.project.revision, before.project.revision);
  assert.equal(after.tasks['ghost'], undefined);
  assert.equal(after.operations['op-bad'], undefined);
  assert.equal(after.events.length, 0);
});

test('SQLiteStore rolls the SQL transaction back when writeAll fails mid-commit', async () => {
  const calls: string[] = [];
  const project = createState({ id: 'p1', goal: 'g', mode: 'live', now: t0 }).project;
  const sql = {
    exec(query: string) {
      calls.push(query.trim().split(/\s+/)[0].toUpperCase());
      if (query.startsWith('DELETE FROM entities')) throw new Error('disk full');
      const q = query.trim();
      if (q.startsWith('SELECT body FROM project')) return { toArray: () => [{ body: JSON.stringify(project) }] };
      return { toArray: () => [] as Record<string, unknown>[] };
    },
  };
  const store = new SQLiteStore({ storage: { sql }, projectId: 'p1' });
  await assert.rejects(store.transact((draft: ProjectState) => {
    draft.tasks['t'] = { id: 't' } as Task;
    return true;
  }), /disk full/);
  const beginIdx = calls.indexOf('BEGIN');
  const rollbackIdx = calls.indexOf('ROLLBACK');
  assert.ok(beginIdx >= 0, 'BEGIN issued');
  assert.ok(rollbackIdx > beginIdx, 'ROLLBACK issued after the failing write');
  assert.equal(calls.includes('COMMIT'), false, 'no COMMIT after failure');
});
