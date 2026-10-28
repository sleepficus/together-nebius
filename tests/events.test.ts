// Unit evidence for the b-swe-09 module: event cursor/reconnect, dedupe
// metrics with human-intervention categories, deterministic bounded Bug
// Eater planning, export/restore credential exclusion, and sample/live
// store isolation in the frontend controller.
// Runs with: node --test tests/events.test.ts (Node >=22.18 type stripping)

import assert from 'node:assert/strict';
import test from 'node:test';
import { appendEvent, createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import {
  dedupeEvents, exportProject, handleEvents, metrics, planBugEaterChecks,
  validateExportDocument,
} from '../lib/events.ts';
import { makeSampleState, SAMPLE_STORAGE_KEY } from '../src/data/sample.ts';
import { ACTION_TYPES, createProjectController } from '../src/data/useProject.ts';
import type {
  Assignment, Candidate, CheckJob, Context, Event, EvidenceReceipt,
  Principal, ProjectState,
} from '../lib/types.ts';

let seq = 0;
const uid = () => `id-${++seq}`;
const T0 = '2026-10-04T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

const owner: Principal = {
  id: 'user-1', sessionId: 'sess-owner', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read', 'export', 'restore'], projectIds: ['p1'],
};

type Handler = (
  ctx: Context, request: Request, segments: string[], body?: Record<string, unknown>,
) => Promise<Response | null>;
function call(handler: Handler, ctx: Context, method: string, path: string, body?: Record<string, unknown>) {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const request = new Request(`https://x.test/api/v1/projects/p1${path}`, { method });
  return handler(ctx, request, segments, body) as Promise<Response>;
}
const errIs = (status: number, code?: string) => (err: { status: number; code: string }) =>
  err.status === status && (code === undefined || err.code === code);

function fixture(now: () => string = () => T0) {
  const store = new MemoryStore(createState({ id: 'p1', goal: 'ship', mode: 'live', now: T0 }));
  const ctx: Context = { principal: owner, store, now, uid };
  return { ctx, store };
}

function pushEvent(
  state: ProjectState, minutes: number, type: string,
  detail?: unknown, opts: Partial<Event> = {},
): Event {
  const ev: Event = {
    id: opts.id ?? `ev-${state.events.length + 1}-${type}`, projectId: 'p1',
    seq: state.events.length + 1, createdAt: at(minutes),
    actorId: opts.actorId ?? 'agent-1', actorKind: opts.actorKind ?? 'agent',
    type, ...(detail !== undefined ? { detail } : {}),
    ...(opts.humanCategory !== undefined ? { humanCategory: opts.humanCategory } : {}),
  };
  state.events.push(ev);
  return ev;
}

// --- event cursor / reconnect ----------------------------------------------

test('GET /events replays seq > after with nextCursor; empty log behaves', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    for (let i = 0; i < 5; i++) pushEvent(draft, i, 'tick', { i });
    return true;
  });
  const res = await call(handleEvents, ctx, 'GET', '/events?after=2');
  assert.equal(res.status, 200);
  const body = await res.json() as { events: Event[]; nextCursor: number; resync: boolean; latestSeq: number };
  assert.deepEqual(body.events.map((e) => e.seq), [3, 4, 5]);
  assert.equal(body.nextCursor, 5);
  assert.equal(body.latestSeq, 5);
  assert.equal(body.resync, false);

  const none = await call(handleEvents, ctx, 'GET', '/events?after=5');
  const noneBody = await none.json() as { events: Event[]; nextCursor: number };
  assert.equal(noneBody.events.length, 0);
  assert.equal(noneBody.nextCursor, 5);

  const typed = await call(handleEvents, ctx, 'GET', '/events?after=0&type=tick');
  assert.equal(((await typed.json()) as { count: number }).count, 5);
  const filtered = await call(handleEvents, ctx, 'GET', '/events?after=0&type=nope');
  assert.equal(((await filtered.json()) as { count: number }).count, 0);
});

test('cursor ahead of log and missing seq both return resync markers', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    for (let i = 0; i < 3; i++) pushEvent(draft, i, 'tick');
    // Simulate a dropped sequence point (restore/edit artefact).
    draft.events.splice(1, 1);
    draft.events.forEach((ev, i) => { ev.seq = i === 0 ? 1 : i + 2; }); // seqs 1,3
    return true;
  });
  const ahead = await call(handleEvents, ctx, 'GET', '/events?after=99');
  const aheadBody = await ahead.json() as { resync: boolean; reason: string };
  assert.equal(aheadBody.resync, true);
  assert.equal(aheadBody.reason, 'cursor-ahead-of-log');

  const gap = await call(handleEvents, ctx, 'GET', '/events?after=2');
  const gapBody = await gap.json() as { resync: boolean; reason: string };
  assert.equal(gapBody.resync, true);
  assert.equal(gapBody.reason, 'cursor-gap');

  await assert.rejects(
    call(handleEvents, ctx, 'GET', '/events?after=abc'),
    errIs(422, 'invalid_cursor'),
  );
});

test('duplicate event ids are deduplicated on read and in metrics', async () => {
  const { ctx, store } = fixture();
  await store.transact((draft) => {
    pushEvent(draft, 1, 'tick', {}, { id: 'dup-1' });
    pushEvent(draft, 2, 'tick', {}, { id: 'dup-1' }); // same id re-delivered
    pushEvent(draft, 3, 'tick', {}, { id: 'dup-2' });
    return true;
  });
  const res = await call(handleEvents, ctx, 'GET', '/events?after=0');
  const body = await res.json() as { events: Event[] };
  assert.equal(body.events.length, 2);
  assert.equal(dedupeEvents((await store.read()).events).length, 2);
});

// --- metrics ------------------------------------------------------------------

test('commits received excludes baseline; integrated is the reachable subset', async () => {
  const { store } = fixture();
  const state = await store.transact((draft) => {
    pushEvent(draft, 1, 'commit:observed', { sha: 'sha-f1', role: 'fork' });
    pushEvent(draft, 2, 'commit:observed', { sha: 'sha-f2', role: 'fork' });
    pushEvent(draft, 3, 'commit:observed', { sha: 'sha-base', role: 'canonical', baseline: true });
    pushEvent(draft, 4, 'commit:observed', { sha: 'sha-c1', role: 'canonical', reachable: true });
    pushEvent(draft, 4, 'commit:observed', { sha: 'sha-c1', role: 'canonical' }, { id: 'dup-obs' });
    // duplicate observation of the same sha must not inflate
    pushEvent(draft, 4, 'commit:observed', { sha: 'sha-c1', role: 'canonical' }, { id: 'dup-obs2' });
    pushEvent(draft, 30, 'commit:observed', { sha: 'sha-old', role: 'fork' }); // outside window
    return draft;
  });
  const m = metrics(state, { windowMinutes: 10, now: at(10) });
  assert.equal(m.commits.received, 3); // sha-f1, sha-f2, sha-c1 (sha-old outside window)
  assert.equal(m.commits.integrated, 1); // only sha-c1 reachable on canonical
  assert.equal(m.commits.baselineExcluded, 1);
  assert.equal(m.commits.unknown, false);
  assert.equal(m.scope.mode, 'live');
});

test('no commit-observation source reports unknown, not zero', async () => {
  const { store } = fixture();
  const m = metrics(await store.read(), { now: at(10) });
  assert.equal(m.commits.received, null);
  assert.equal(m.commits.integrated, null);
  assert.equal(m.commits.unknown, true);
  assert.match(m.commits.note ?? '', /not the same as zero/);
});

test('integration dedupe: newLanding only, by sha and operation', async () => {
  const { store } = fixture();
  const state = await store.transact((draft) => {
    pushEvent(draft, 1, 'integration:confirmed', { operationId: 'op-1', candidateSha: 'sha-a', newLanding: true });
    pushEvent(draft, 2, 'integration:confirmed', { operationId: 'op-1', candidateSha: 'sha-a', newLanding: true }, { id: 'dup-int' });
    pushEvent(draft, 3, 'integration:confirmed', { operationId: 'op-2', candidateSha: 'sha-b', newLanding: false });
    draft.operations['op-9'] = {
      id: 'op-9', projectId: 'p1', revision: 1, createdAt: at(4), updatedAt: at(4),
      actorId: 'user-1', scope: 'integrate', target: { collection: 'project' },
      digest: 'd', intent: 'integrate candidate', effect: 'confirmed',
      result: { status: 200, body: { candidateSha: 'sha-c' } },
    };
    return draft;
  });
  const m = metrics(state, { now: at(10) });
  assert.equal(m.changesCombined.value, 2); // sha-a (deduped) + sha-c via op
  assert.deepEqual(m.changesCombined.shas.sort(), ['sha-a', 'sha-c']);
});

test('human actions group by intervention category with click-through ids', async () => {
  const { store } = fixture();
  const state = await store.transact((draft) => {
    pushEvent(draft, 1, 'help:answered', {}, { actorKind: 'human', actorId: 'steve', humanCategory: 'relay' });
    pushEvent(draft, 2, 'candidate:reviewed', {}, { actorKind: 'human', actorId: 'steve', humanCategory: 'approve' });
    pushEvent(draft, 3, 'project:stopped', {}, { actorKind: 'human', actorId: 'steve', humanCategory: 'other' });
    pushEvent(draft, 4, 'task:layout-saved', {}, { actorKind: 'human', actorId: 'steve' }); // uncategorized
    pushEvent(draft, 5, 'task:created', {}, { actorKind: 'agent', actorId: 'a1' });
    pushEvent(draft, 40, 'help:answered', {}, { actorKind: 'human', actorId: 'steve', humanCategory: 'relay' }); // outside window
    return draft;
  });
  const m = metrics(state, { windowMinutes: 10, now: at(10) });
  assert.equal(m.humanActions.total, 3);
  assert.equal(m.humanActions.byCategory.relay, 1);
  assert.equal(m.humanActions.byCategory.approve, 1);
  assert.equal(m.humanActions.byCategory.other, 1);
  assert.equal(m.humanActions.byCategory['tie-break'], 0);
  assert.equal(m.humanActions.uncategorizedHumanEvents, 1);
  assert.equal(m.humanActions.eventIds.length, 3);
});

test('tasks finished is accepted/non-cancelled; needs help dedupes by id', async () => {
  const { store } = fixture();
  const state = await store.transact((draft) => {
    const mkTask = (id: string, lifecycle: 'done' | 'open' | 'cancelled') => {
      draft.tasks[id] = {
        id, projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
        actorId: 'user-1', goal: id, acceptanceCriteria: [], dependencies: [],
        lifecycle, resultRefs: [],
      };
    };
    mkTask('t1', 'done'); mkTask('t2', 'open'); mkTask('t3', 'cancelled');
    draft.help['h1'] = {
      id: 'h1', projectId: 'p1', revision: 1, createdAt: at(1), updatedAt: at(1),
      actorId: 'a', question: 'q', offeredById: 'a', state: 'offered',
    };
    draft.help['h2'] = {
      id: 'h2', projectId: 'p1', revision: 1, createdAt: at(1), updatedAt: at(1),
      actorId: 'a', question: 'q', offeredById: 'a', state: 'answered',
    };
    draft.findings['f1'] = {
      id: 'f1', projectId: 'p1', revision: 1, createdAt: at(1), updatedAt: at(1),
      actorId: 'a', expected: 'e', observed: 'o', state: 'reproduced',
      originatorId: 'a', receiptIds: [],
    };
    draft.findings['f2'] = {
      id: 'f2', projectId: 'p1', revision: 1, createdAt: at(1), updatedAt: at(1),
      actorId: 'a', expected: 'e', observed: 'o', state: 'possible-issue',
      originatorId: 'a', receiptIds: [],
    };
    return draft;
  });
  const m = metrics(state, { now: at(10) });
  assert.equal(m.tasksFinished.accepted, 1);
  assert.equal(m.tasksFinished.denominator, 2);
  assert.equal(m.tasksFinished.ratio, 0.5);
  assert.equal(m.needsHelp.value, 2); // h1 + f1; f2 reported separately
  assert.deepEqual(m.needsHelp.helpIds, ['h1']);
  assert.deepEqual(m.needsHelp.blockerIds, ['f1']);
  assert.deepEqual(m.needsHelp.possibleIssueIds, ['f2']);
});

test('working now: heartbeat inside freshness vs Assigned fallback', async () => {
  const { store } = fixture();
  const seed = (beat?: string) => store.transact((draft) => {
    draft.assignments['a1'] = {
      id: 'a1', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'ag', taskId: 't1', identityId: 'agent-1', sessionId: 'sess-1',
      role: 'builder', scopes: [], epoch: 1, leaseExpiresAt: at(20),
      maxUntil: at(60), status: 'active',
    } as Assignment;
    draft.jobs['j1'] = {
      id: 'j1', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'ag', candidateId: 'c1', candidateSha: 'sha', command: 'npm test',
      status: 'running', ownerAssignmentId: 'a1',
      ...(beat !== undefined ? { lastHeartbeatAt: beat } : {}),
    } as CheckJob;
    return draft;
  });
  let m = metrics(await seed(at(9)), { now: at(10) });
  assert.equal(m.workingNow.label, 'Working now');
  assert.equal(m.workingNow.value, 1);
  assert.equal(m.workingNow.basis, 'heartbeat');

  const { store: store2 } = fixture();
  const s2 = await store2.transact((draft) => {
    draft.assignments['a1'] = {
      id: 'a1', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'ag', taskId: 't1', identityId: 'agent-1', sessionId: 'sess-1',
      role: 'builder', scopes: [], epoch: 1, leaseExpiresAt: at(20),
      maxUntil: at(60), status: 'active',
    } as Assignment;
    return draft;
  });
  m = metrics(s2, { now: at(10) });
  assert.equal(m.workingNow.label, 'Assigned');
  assert.equal(m.workingNow.basis, 'assigned-only');
  assert.equal(m.workingNow.value, 1);
});

// --- Bug Eater planner ---------------------------------------------------------

function seedCandidateRecord(draft: ProjectState, id: string, sha: string, min: number, status = 'prepared') {
  draft.candidates[id] = {
    id, projectId: 'p1', revision: 1, createdAt: at(min), updatedAt: at(min),
    actorId: 'sys', base: 'base', proposalIds: [], proposalHeads: {}, sha,
    policyVersion: 1, status: status as Candidate['status'], checkJobIds: [], reviewIds: [],
  };
}

test('bug eater plan: newest eligible wins capacity; skips are recorded', () => {
  const { store } = fixture();
  const state = createState({ id: 'p1', goal: 'g', mode: 'live', now: T0 });
  void store;
  seedCandidateRecord(state, 'c-old', 'sha-old', 1);
  seedCandidateRecord(state, 'c-new', 'sha-new', 5);
  seedCandidateRecord(state, 'c-int', 'sha-int', 6, 'integrated');
  const plan = planBugEaterChecks(state, { now: at(10) });
  assert.equal(plan.jobs.length, 1); // maxActiveChecks default 1
  assert.equal(plan.jobs[0].candidateId, 'c-new'); // newest eligible
  assert.equal(plan.jobs[0].command, 'npm test');
  const skippedReasons = Object.fromEntries(plan.skipped.map((s) => [s.candidateId, s.reason]));
  assert.equal(skippedReasons['c-old'], 'superseded-by-newer-eligible-revision');
  assert.equal(skippedReasons['c-int'], 'candidate-integrated');
  assert.ok(Date.parse(plan.jobs[0].deadlineAt ?? '') > Date.parse(at(10)));
});

test('bug eater plan: stopped project and covered candidates produce no jobs', () => {
  const state = createState({ id: 'p1', goal: 'g', mode: 'live', now: T0 });
  seedCandidateRecord(state, 'c1', 'sha-1', 1);
  state.stopped = true;
  let plan = planBugEaterChecks(state, { now: at(10) });
  assert.equal(plan.jobs.length, 0);
  assert.equal(plan.stopped, true);
  assert.equal(plan.skipped.find((s) => s.candidateId === 'c1')?.reason, 'project-stopped');

  state.stopped = false;
  const cand = state.candidates['c1'];
  cand.checkJobIds.push('j-done');
  state.jobs['j-done'] = {
    id: 'j-done', projectId: 'p1', revision: 1, createdAt: at(2), updatedAt: at(2),
    actorId: 'sys', candidateId: 'c1', candidateSha: 'sha-1', command: 'npm test',
    status: 'completed', receiptId: 'r1',
  } as CheckJob;
  state.receipts['r1'] = {
    id: 'r1', projectId: 'p1', revision: 1, createdAt: at(2), updatedAt: at(2),
    actorId: 'sys', jobId: 'j-done', candidateSha: 'sha-1', collectorId: 'col',
    command: 'npm test', outcome: 'pass', artifactRefs: [],
  } as EvidenceReceipt;
  plan = planBugEaterChecks(state, { now: at(10) });
  assert.equal(plan.jobs.length, 0);
  assert.equal(plan.skipped.find((s) => s.candidateId === 'c1')?.reason, 'required-checks-covered');
});

// --- export / restore ------------------------------------------------------------

test('export removes credentials, invitations and every credential hash', async () => {
  const { store } = fixture();
  const state = await store.transact((draft) => {
    draft.credentials['c1'] = {
      id: 'c1', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'u', identityId: 'a1', tokenHash: 'hash', scopes: [], projectIds: ['p1'], status: 'active',
    };
    draft.invitations['i1'] = {
      id: 'i1', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'u', tokenHash: 'hash', scopes: [], projectIds: ['p1'],
      expiresAt: at(1), status: 'pending',
    };
    draft.jobs['j1'] = {
      id: 'j1', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'u', candidateId: 'c1', candidateSha: 's', command: 'npm test',
      status: 'queued', collectorTokenHash: 'secret-hash',
    } as CheckJob;
    draft.tasks['t1'] = {
      id: 't1', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'u', goal: 'g', acceptanceCriteria: [], dependencies: [],
      lifecycle: 'open', resultRefs: [],
    };
    return draft;
  });
  const doc = exportProject(state, { now: at(5), exportedBy: 'user-1' });
  const text = JSON.stringify(doc);
  assert.equal(doc.format, 'together-project-export');
  assert.deepEqual(doc.state.credentials, {});
  assert.deepEqual(doc.state.invitations, {});
  assert.ok(!text.includes('tokenHash'));
  assert.ok(!text.includes('collectorTokenHash'));
  assert.ok(!text.includes('secret-hash'));
  assert.equal(doc.state.tasks['t1'].goal, 'g');
});

test('restore validates, preserves live auth records, rejects private fields', async () => {
  const { ctx, store } = fixture();
  // Build a source doc from the current state.
  const doc = exportProject(await store.read(), { now: at(5) });
  // Mutate live state: private auth + a task the doc lacks.
  await store.transact((draft) => {
    draft.credentials['live-cred'] = {
      id: 'live-cred', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'u', identityId: 'a', tokenHash: 'x', scopes: [], projectIds: ['p1'], status: 'active',
    };
    draft.tasks['extra'] = {
      id: 'extra', projectId: 'p1', revision: 1, createdAt: at(0), updatedAt: at(0),
      actorId: 'u', goal: 'removed by restore', acceptanceCriteria: [], dependencies: [],
      lifecycle: 'open', resultRefs: [],
    };
    return true;
  });
  const restoreBody = {
    operationId: 'op-restore-1',
    expectedRevision: (await store.read()).project.revision,
    document: doc,
  };
  const res = await call(handleEvents, ctx, 'POST', '/restore', restoreBody);
  assert.equal(res.status, 200);
  const after = await store.read();
  assert.equal(after.credentials['live-cred']?.tokenHash, 'x'); // live auth preserved
  assert.equal(after.tasks['extra'], undefined);
  assert.ok(after.events.some((e) => e.type === 'project:restored'));
  const restoredEv = after.events.find((e) => e.type === 'project:restored');
  assert.equal(restoredEv?.humanCategory, 'correction');

  // Replay of the identical payload returns the saved result even though
  // the project revision moved on.
  const replay = await call(handleEvents, ctx, 'POST', '/restore', restoreBody);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { restored: true, projectId: 'p1' });

  // Private material in a document is refused.
  await assert.rejects(
    call(handleEvents, ctx, 'POST', '/restore', {
      operationId: 'op-restore-2', expectedRevision: (await store.read()).project.revision,
      document: { ...doc, state: { ...doc.state, jobs: { j: { tokenHash: 'no' } } } },
    }),
    errIs(422, 'restore_private_fields'),
  );

  // Cross-project documents are refused.
  await assert.rejects(
    call(handleEvents, ctx, 'POST', '/restore', {
      operationId: 'op-restore-3', expectedRevision: (await store.read()).project.revision,
      document: { ...doc, projectId: 'other', state: { ...doc.state, project: { ...doc.state.project, id: 'other' } } },
    }),
    errIs(422, 'invalid_export'),
  );
});

test('validateExportDocument dedupes/resequences events', () => {
  const { store } = fixture();
  void store;
  const base = exportProject(createState({ id: 'p1', goal: 'g', mode: 'live', now: T0 }), { now: at(1) });
  const doc = structuredClone(base);
  doc.state.events = [
    { id: 'e2', projectId: 'p1', seq: 5, createdAt: at(2), actorId: 'a', actorKind: 'agent', type: 'x' },
    { id: 'e1', projectId: 'p1', seq: 2, createdAt: at(1), actorId: 'a', actorKind: 'agent', type: 'x' },
    { id: 'e1', projectId: 'p1', seq: 9, createdAt: at(3), actorId: 'a', actorKind: 'agent', type: 'x' },
  ];
  const restored = validateExportDocument(doc, 'p1');
  assert.equal(restored.events.length, 2);
  assert.deepEqual(restored.events.map((e) => e.seq), [1, 2]);
  assert.deepEqual(restored.events.map((e) => e.id), ['e1', 'e2']);
});

// --- sample state -----------------------------------------------------------------

test('makeSampleState is truthful: labeled sample, no verified/integrated claims', () => {
  const s = makeSampleState();
  assert.equal(s.project.mode, 'sample');
  assert.equal(s.project.goal, 'Make editing feel effortless');
  assert.ok(Object.keys(s.tasks).length >= 3);
  assert.ok(Object.values(s.assignments).some((a) => a.status === 'active'));
  // Two builder agents plus one test helper.
  const agentIds = Object.keys(s.identities).filter((i) => i.startsWith('agent-'));
  assert.equal(agentIds.length, 3);
  assert.ok(Object.values(s.assignments).some((a) => a.role === 'test-helper'));
  // Combined candidate + check evidence exist, all clearly sample.
  const cand = Object.values(s.candidates)[0];
  assert.match(cand.sha, /^sample-/);
  assert.notEqual(cand.status, 'integrated');
  for (const r of Object.values(s.receipts)) {
    assert.equal((r as unknown as { provenance: string }).provenance, 'sample');
    assert.equal(r.collectorId, 'sample-checker');
  }
  for (const f of Object.values(s.findings)) {
    assert.notEqual(f.state, 'verified-fixed');
    assert.equal((f as unknown as { provenance: string }).provenance, 'sample');
  }
  // No fabricated agent banter: the only message is a labeled system notice.
  assert.equal(Object.keys(s.messages).length, 1);
  assert.equal(Object.values(s.messages)[0].type, 'system-notice');
  assert.match(Object.values(s.messages)[0].body, /[Ss]ample/);
  // Event seq is monotonic and metrics run on the sample too.
  s.events.forEach((e, i) => assert.equal(e.seq, i + 1));
  const m = metrics(s, { now: at(70) });
  assert.equal(m.scope.mode, 'sample');
});

// --- controller: sample/live isolation --------------------------------------------

function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test('controller: sample actions mutate sample records and persist under sample key only', async () => {
  const storage = memStorage();
  const c = createProjectController({ storage, now: () => T0, uid });
  assert.equal(c.mode, 'sample');
  assert.equal(c.projects.length, 1);

  const created = await c.action('create-task', { goal: 'new sample task' }) as { ok: boolean; taskId: string };
  assert.equal(created.ok, true);
  assert.equal(c.state.tasks[created.taskId].lifecycle, 'open');

  const claimed = await c.action('claim-task', { taskId: created.taskId }) as { ok: boolean; epoch: number };
  assert.equal(claimed.ok, true);
  assert.equal(claimed.epoch, 1);
  assert.equal(c.state.tasks[created.taskId].lifecycle, 'claimed');

  // Candidate ids can never be claimed (they are not tasks).
  const badClaim = await c.action('claim-task', { taskId: 'cand-1' }) as { ok: boolean };
  assert.equal(badClaim.ok, false);

  // Persisted ONLY under the sample key.
  assert.equal(storage.map.size, 1);
  assert.ok(storage.map.has(SAMPLE_STORAGE_KEY));
  const persisted = JSON.parse(storage.map.get(SAMPLE_STORAGE_KEY)!) as { projects: ProjectState[] };
  assert.ok(persisted.projects[0].tasks[created.taskId] !== undefined);
});

test('controller: sample check/review are simulated; verified-fixed cannot be set', async () => {
  const c = createProjectController({ storage: memStorage(), now: () => T0, uid });
  const candId = Object.keys(c.state.candidates)[0];
  const res = await c.action('request-check', { candidateId: candId, outcome: 'pass' }) as {
    ok: boolean; receiptId: string;
  };
  assert.equal(res.ok, true);
  const receipt = c.state.receipts[res.receiptId];
  assert.equal((receipt as unknown as { provenance: string }).provenance, 'sample');
  assert.equal(receipt.collectorId, 'sample-checker');

  const findingId = Object.keys(c.state.findings)[0];
  const badDisposition = await c.action('disposition-finding', {
    findingId, disposition: 'verified-fixed', note: 'try it',
  }) as { ok: boolean };
  assert.equal(badDisposition.ok, false);
  assert.equal(c.state.findings[findingId].state, 'reproduced');

  const good = await c.action('disposition-finding', {
    findingId, disposition: 'withdrawn', note: 'sample withdrawal',
  }) as { ok: boolean };
  assert.equal(good.ok, true);
  assert.equal(c.state.findings[findingId].state, 'withdrawn');

  const review = await c.action('review-candidate', {
    candidateId: candId, disposition: 'comment', note: 'sample note',
  }) as { ok: boolean; reviewId: string };
  assert.equal(review.ok, true);
  assert.equal(c.state.reviews[review.reviewId].independent, false);
});

test('controller: live mode uses same-origin fetch and never touches sample storage', async () => {
  const storage = memStorage();
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const liveState = createState({ id: 'live-1', goal: 'real', mode: 'live', now: T0 });
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/projects/live-1') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify(liveState), { status: 200 });
    }
    if (url.endsWith('/tasks') && init?.method === 'POST') {
      return new Response(JSON.stringify({ task: { id: 't-live' } }), { status: 201 });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), { status: 404 });
  };
  const c = createProjectController({ storage, fetcher, now: () => T0, uid });
  assert.equal(c.mode, 'sample');
  const sampleTaskCount = Object.keys(c.state.tasks).length;

  c.selectProject('live-1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.mode, 'live');
  assert.equal(c.state.project.id, 'live-1');
  assert.ok(calls.some((x) => x.url === '/api/v1/projects/live-1' && x.method === 'GET'));

  const res = await c.action('create-task', { goal: 'live task' }) as { ok: boolean };
  assert.equal(res.ok, true);
  const post = calls.find((x) => x.url.endsWith('/tasks') && x.method === 'POST');
  assert.ok(post !== undefined);
  assert.equal(typeof (post.body as { operationId?: string }).operationId, 'string');

  // No implicit migration: sample records were never POSTed and the sample
  // key gained no live data (it only holds the initial sample snapshot).
  assert.equal(storage.map.size, 1);
  const stored = JSON.parse(storage.map.get(SAMPLE_STORAGE_KEY)!) as { projects: ProjectState[] };
  assert.ok(stored.projects.every((s) => s.project.mode === 'sample'));
  assert.ok(stored.projects[0].project.id !== 'live-1');
  assert.equal(Object.keys(c.state.tasks).length, Object.keys(liveState.tasks).length);
  void sampleTaskCount;
});

test('controller: unknown action and missing fields surface errors, not fake success', async () => {
  const c = createProjectController({ storage: memStorage(), now: () => T0, uid });
  const bad = await c.action('launch-the-fleet') as { ok: boolean };
  assert.equal(bad.ok, false);
  assert.match(c.error ?? '', /unknown action/);
  c.clearError();
  assert.equal(c.error, null);
  const missing = await c.action('create-task', {}) as { ok: boolean };
  assert.equal(missing.ok, false);
  assert.ok(ACTION_TYPES.includes('create-task'));
});
