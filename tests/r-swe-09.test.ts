// Unit evidence for lane r-swe-09 repair pass: secure export/restore trust
// boundary, event cursor resync convergence, and sample/live mode pinning
// in the shared controller.
// Runs with: node --test tests/r-swe-09.test.ts (Node >=22.18 type stripping)

import assert from 'node:assert/strict';
import test from 'node:test';
import { createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { exportProject, handleEvents, metrics, validateExportDocument } from '../lib/events.ts';
import { makeSampleState, SAMPLE_STORAGE_KEY } from '../src/data/sample.ts';
import { createProjectController } from '../src/data/useProject.ts';
import type {
  Context, Event, Principal, ProjectState,
} from '../lib/types.ts';

let seq = 0;
const uid = () => `id-${++seq}`;
const T0 = '2026-10-04T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const restorer: Principal = {
  id: 'restore-author', sessionId: 'restore-session', kind: 'human',
  ownerId: 'restore-author', scopes: ['read', 'restore'], projectIds: ['owned-restore-fixture'],
};

type Handler = (
  ctx: Context, request: Request, segments: string[], body?: Record<string, unknown>,
) => Promise<Response | null>;
function call(handler: Handler, ctx: Context, method: string, path: string, body?: Record<string, unknown>) {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const request = new Request(`https://fixture.test/api/v1/projects/owned-restore-fixture${path}`, { method });
  return handler(ctx, request, segments, body) as Promise<Response>;
}
const errIs = (status: number, code?: string) => (err: { status: number; code: string }) =>
  err.status === status && (code === undefined || err.code === code);

function fixture() {
  const store = new MemoryStore(createState({
    id: 'owned-restore-fixture', goal: 'restore truth fixture', mode: 'live', now: T0,
  }));
  const ctx: Context = { principal: restorer, store, now: () => T0, uid };
  return { ctx, store };
}

const common = () => ({
  projectId: 'owned-restore-fixture', revision: 1, createdAt: T0, updatedAt: T0,
  actorId: 'restore-author',
});

function baseDoc(state: ProjectState) {
  return exportProject(state, { now: T0 });
}

async function postRestore(ctx: Context, store: MemoryStore, document: unknown) {
  const res = await call(handleEvents, ctx, 'POST', '/restore', {
    operationId: `restore-${++seq}`,
    expectedRevision: (await store.read()).project.revision,
    document,
  });
  return res;
}

// --- restore trust boundary ---------------------------------------------------

test('restore: forged verified-fixed + integrated without evidence is rejected, no mutation', async () => {
  const { ctx, store } = fixture();
  // Mirrors RESTORE-TRUST-REPRODUCER.json: labels only, zero receipts/ops.
  const doc = baseDoc(await store.read()) as ReturnType<typeof baseDoc>;
  (doc.state.findings as Record<string, unknown>).f = {
    ...common(), id: 'f', candidateId: 'c', candidateSha: SHA_A,
    state: 'verified-fixed', expected: 'owned fixture', observed: 'owned fixture',
    receiptIds: [], evidenceRefs: [],
  };
  (doc.state.candidates as Record<string, unknown>).c = {
    ...common(), id: 'c', sha: SHA_A, base: SHA_B, proposalIds: [], proposalHeads: {},
    policyVersion: 1, status: 'integrated', checkJobIds: [], reviewIds: [],
  };
  await assert.rejects(
    postRestore(ctx, store, doc),
    errIs(422, 'restore_unsupported_trust'),
  );
  const after = await store.read();
  assert.equal(after.findings.f, undefined);
  assert.equal(after.candidates.c, undefined);
});

test('restore: forged reproduced finding without a failing receipt is rejected', async () => {
  const { ctx, store } = fixture();
  const doc = baseDoc(await store.read());
  (doc.state.findings as Record<string, unknown>).f = {
    ...common(), id: 'f', expected: 'e', observed: 'o',
    state: 'reproduced', originatorId: 'agent-x', receiptIds: [],
  };
  await assert.rejects(
    postRestore(ctx, store, doc),
    errIs(422, 'restore_unsupported_trust'),
  );
});

test('restore: forged integration:confirmed event without confirmed op is rejected', async () => {
  const { ctx, store } = fixture();
  const doc = baseDoc(await store.read());
  doc.state.events.push({
    id: 'ev-forged', projectId: 'owned-restore-fixture', seq: 1, createdAt: T0,
    actorId: 'restore-author', actorKind: 'system', type: 'integration:confirmed',
    detail: { operationId: 'op-ghost', candidateSha: SHA_C, newLanding: true },
  } as Event);
  await assert.rejects(
    postRestore(ctx, store, doc),
    errIs(422, 'restore_unsupported_trust'),
  );
});

test('restore: forged integrated proposal without evidence-backed candidate is rejected', async () => {
  const { ctx, store } = fixture();
  const doc = baseDoc(await store.read());
  (doc.state.proposals as Record<string, unknown>).p = {
    ...common(), id: 'p', taskIds: [], authorId: 'a', base: SHA_A, head: SHA_B,
    summary: 's', intendedBehavior: 'b', changedPaths: [], evidenceRefs: [],
    unknowns: [], lifecycle: 'integrated',
  };
  await assert.rejects(
    postRestore(ctx, store, doc),
    errIs(422, 'restore_unsupported_trust'),
  );
});

test('restore: unknown enum status values are rejected', async () => {
  const { ctx, store } = fixture();
  const doc = baseDoc(await store.read());
  (doc.state.candidates as Record<string, unknown>).c = {
    ...common(), id: 'c', sha: SHA_A, base: SHA_B, proposalIds: [], proposalHeads: {},
    policyVersion: 1, status: 'legendary', checkJobIds: [], reviewIds: [],
  };
  await assert.rejects(
    postRestore(ctx, store, doc),
    errIs(422, 'restore_unsupported_trust'),
  );
});

test('restore: unvalidated evidence-backed archive preserves history without minting current trust', async () => {
  const { ctx, store } = fixture();
  const doc = baseDoc(await store.read());
  const s = doc.state as ProjectState;
  // A real verified-fixed finding: original failing receipt (sha A) and the
  // repaired passing receipt (sha B) on the same command, both linked.
  s.jobs.j1 = {
    ...common(), id: 'j1', candidateId: 'c0', candidateSha: SHA_A,
    command: 'npm test', status: 'completed', deadlineAt: at(5),
  };
  s.jobs.j2 = {
    ...common(), id: 'j2', candidateId: 'c1', candidateSha: SHA_B,
    command: 'npm test', status: 'completed', deadlineAt: at(5),
  };
  s.receipts['r-fail'] = {
    ...common(), id: 'r-fail', jobId: 'j1', candidateSha: SHA_A,
    collectorId: 'col', command: 'npm test', outcome: 'fail', artifactRefs: [],
  };
  s.receipts['r-pass'] = {
    ...common(), id: 'r-pass', jobId: 'j2', candidateSha: SHA_B,
    collectorId: 'col', command: 'npm test', outcome: 'pass', artifactRefs: [],
  };
  s.findings.f = {
    ...common(), id: 'f', candidateId: 'c0', candidateSha: SHA_A,
    expected: 'e', observed: 'o', state: 'verified-fixed',
    originatorId: 'a', receiptIds: ['r-fail', 'r-pass'],
  };
  // A real integrated candidate: confirmed canonical-write operation.
  s.proposals.p = {
    ...common(), id: 'p', taskIds: [], authorId: 'a', base: SHA_A, head: SHA_B,
    summary: 's', intendedBehavior: 'b', changedPaths: [], evidenceRefs: [],
    unknowns: [], lifecycle: 'integrated',
  };
  s.candidates.c = {
    ...common(), id: 'c', sha: SHA_C, base: SHA_A, proposalIds: ['p'],
    proposalHeads: { p: SHA_B }, policyVersion: 1, status: 'integrated',
    checkJobIds: [], reviewIds: [], integrateOperationId: 'op-int',
  };
  s.operations['op-int'] = {
    ...common(), id: 'op-int', scope: 'integrate',
    target: { collection: 'candidates', id: 'c' }, digest: 'd',
    intent: 'integrate', effect: 'confirmed',
    candidateId: 'c', candidateTip: SHA_C,
    result: { status: 200, body: { candidateSha: SHA_C } },
  } as never;
  const res = await postRestore(ctx, store, doc);
  assert.equal(res.status, 200);
  const after = await store.read();
  assert.equal(after.findings.f.state, 'possible-issue');
  assert.equal(after.findings.f.importedState, 'verified-fixed');
  assert.equal(after.candidates.c.status, 'prepared');
  assert.equal(after.candidates.c.importedStatus, 'integrated');
  assert.equal(after.proposals.p.lifecycle, 'submitted');
  assert.equal(after.proposals.p.importedLifecycle, 'integrated');
  assert.equal(metrics(after, { now: at(10) }).changesCombined.value, 0);
});

test('restore: imported text cannot retarget server-managed project config', async () => {
  const { ctx, store } = fixture();
  const doc = baseDoc(await store.read());
  doc.state.project.mode = 'sample';
  doc.state.project.canonicalRef = 'refs/heads/forged';
  doc.state.project.resourceLimits = {
    maxActiveWorkers: 9999, maxActiveChecks: 9999,
    checkTimeoutMs: 999999999, maxSourceBytes: 999999999,
  };
  doc.state.project.repositories = {
    canon: { role: 'canonical', remote: 'https://evil.example/repo.git' },
  };
  const res = await postRestore(ctx, store, doc);
  assert.equal(res.status, 200);
  const after = await store.read();
  assert.equal(after.project.mode, 'live');
  assert.equal(after.project.canonicalRef, 'refs/heads/main');
  assert.equal(after.project.resourceLimits.maxActiveChecks, 1);
  assert.deepEqual(after.project.repositories, {});
});

test('restore: sample export round-trips validation (labeled sample evidence intact)', () => {
  const sample = makeSampleState();
  const doc = exportProject(sample, { now: at(70) });
  const restored = validateExportDocument(doc, sample.project.id);
  assert.equal(restored.findings['find-1'].state, 'reproduced');
  assert.equal(restored.candidates['cand-1'].status, 'checking');
});

// --- event cursor / reconnect -------------------------------------------------

test('events: ahead-of-log cursor returns resync with a reset nextCursor', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    draft.events.push(
      { id: 'e1', projectId: draft.project.id, seq: 1, createdAt: at(1), actorId: 'a', actorKind: 'agent', type: 'x' },
      { id: 'e2', projectId: draft.project.id, seq: 2, createdAt: at(2), actorId: 'a', actorKind: 'agent', type: 'x' },
    );
    return true;
  });
  const res = await call(handleEvents, ctx, 'GET', '/events?after=99');
  const body = await res.json() as { resync: boolean; reason: string; nextCursor: number; latestSeq: number };
  assert.equal(body.resync, true);
  assert.equal(body.reason, 'cursor-ahead-of-log');
  // A naive client that trusts nextCursor must converge in one step, not
  // resync forever on a cursor the durable log cannot honour.
  assert.equal(body.nextCursor, body.latestSeq);
  const follow = await call(handleEvents, ctx, 'GET', `/events?after=${body.nextCursor}`);
  const followBody = await follow.json() as { resync: boolean };
  assert.equal(followBody.resync, false);
});

// --- controller: resync convergence, mode pin, no remote writes ----------------

function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('controller: resync resets the events cursor so the next poll does not resync again', async () => {
  const calls: string[] = [];
  let eventsCalls = 0;
  const liveState = createState({ id: 'live-1', goal: 'real', mode: 'live', now: T0 });
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes('/events')) {
      eventsCalls += 1;
      if (eventsCalls === 1) {
        return new Response(JSON.stringify({
          events: [], count: 0, nextCursor: 0, latestSeq: 5,
          resync: true, reason: 'cursor-ahead-of-log',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        events: [], count: 0, nextCursor: 5, latestSeq: 5, resync: false,
      }), { status: 200 });
    }
    if (url.endsWith('/projects/live-1')) {
      return new Response(JSON.stringify(liveState), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  };
  const c = createProjectController({ storage: memStorage(), fetcher, now: () => T0, uid }) as
    ReturnType<typeof createProjectController> & { pollEvents(): Promise<{ resync: boolean; newEvents: number }> };
  c.selectProject('live-1');
  await tick();
  const first = await c.pollEvents();
  assert.equal(first.resync, true);
  const second = await c.pollEvents();
  assert.equal(second.resync, false);
  const secondEventsCall = calls.filter((u) => u.includes('/events'))[1];
  assert.ok(secondEventsCall.includes('after=5'), `expected reset cursor, got ${secondEventsCall}`);
});

test('controller: live select pins live mode; a non-live response is rejected', async () => {
  const storage = memStorage();
  const calls: string[] = [];
  const mismatched = createState({ id: 'live-x', goal: 'sneaky', mode: 'sample', now: T0 });
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.endsWith('/projects/live-x')) {
      return new Response(JSON.stringify(mismatched), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  };
  const c = createProjectController({ storage, fetcher, now: () => T0, uid });
  const before = c.activeProjectId;
  c.selectProject('live:live-x');
  await tick();
  assert.equal(c.mode, 'sample');
  assert.equal(c.activeProjectId, before);
  assert.match(c.error ?? '', /live mode|not live/i);
  assert.ok(c.projects.every((p) => p.project.mode === 'sample'));
});

test('controller: live refresh pins live mode; a non-live snapshot is not adopted', async () => {
  let liveReads = 0;
  const good = createState({ id: 'live-1', goal: 'real', mode: 'live', now: T0 });
  const sneaky = structuredClone(good);
  (sneaky.project as { mode: string }).mode = 'sample';
  const fetcher = async (url: string): Promise<Response> => {
    if (url.endsWith('/projects/live-1')) {
      liveReads += 1;
      return new Response(JSON.stringify(liveReads === 1 ? good : sneaky), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
  };
  const c = createProjectController({ storage: memStorage(), fetcher, now: () => T0, uid }) as
    ReturnType<typeof createProjectController> & { refresh(): Promise<void> };
  c.selectProject('live-1');
  await tick();
  assert.equal(c.mode, 'live');
  await c.refresh();
  assert.equal(c.mode, 'live');
  assert.equal(c.state.project.mode, 'live');
  assert.match(c.error ?? '', /live mode|not live/i);
});

test('controller: sample mode performs no remote writes', async () => {
  let fetchCalls = 0;
  const fetcher = async (): Promise<Response> => {
    fetchCalls += 1;
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const c = createProjectController({ storage: memStorage(), fetcher, now: () => T0, uid });
  const created = await c.action('create-task', { goal: 'sample only' }) as { ok: boolean; taskId: string };
  assert.equal(created.ok, true);
  await c.action('claim-task', { taskId: created.taskId });
  await c.action('ask-help', { taskId: created.taskId, question: 'q' });
  await c.action('submit-change', { summary: 's', taskIds: [created.taskId] });
  await c.action('prepare-candidate', {});
  await c.action('save-layout', { taskId: created.taskId, x: 1, y: 2 });
  await c.action('stop', {});
  assert.equal(fetchCalls, 0);
});
