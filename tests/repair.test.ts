// Integrator regression tests: consolidated controller/MiMo repairs.
// Each test names the original defect it pins.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, createState, safeSnapshot } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { handleChecks, authenticateCollector } from '../lib/checks.ts';
import { handleIntegration } from '../lib/integration.ts';
import { handleInbox } from '../lib/inbox.ts';
import { authenticate, handleIdentity, type EnrollmentPrincipal } from '../lib/identity.ts';
import { renewForJobHeartbeat } from '../lib/assignments.ts';
import { snapshotInputHash } from '../runner/snapshot-runner.ts';
import type {
  Candidate, CheckJob, Context, GitService, Id, Operation, Principal,
  ProjectState, Sha, Task,
} from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let seq = 0;
const uid = () => `id-${++seq}`;
const now = () => T0;
const sha = (c: string) => c.repeat(40);
const BASE = sha('b');
const CAND = sha('d');

const owner: Principal = {
  id: 'user-1', sessionId: 'sess-1', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read'], projectIds: ['p1'],
};
const agent = (id: string, scopes: string[]): Principal => ({
  id, sessionId: `s-${id}`, kind: 'agent', ownerId: 'user-1', scopes, projectIds: ['p1'],
});

function fixture(git?: GitService, runner?: unknown): { ctx: Context; store: MemoryStore } {
  const store = new MemoryStore(createState({ id: 'p1', goal: 'ship', mode: 'live', now: T0 }));
  const ctx = {
    principal: owner, store, now, uid,
    ...(git ? { git } : {}),
    ...(runner ? { runner: runner as Context['runner'] } : {}),
  } as Context;
  return { ctx, store };
}

const meta = (id: string, actorId = 'user-1') =>
  ({ id, projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0, actorId });

function seedCandidate(store: MemoryStore, id: string, csha: string): Promise<void> {
  return store.transact((d) => {
    d.candidates[id] = {
      ...meta(id), base: BASE, proposalIds: [], proposalHeads: {}, sha: csha,
      policyVersion: 1, status: 'prepared', checkJobIds: [], reviewIds: [],
    } as Candidate;
    return true;
  }).then(() => undefined);
}

const req = () => new Request('https://x.test/', { method: 'POST' });

// --- defect: collector token leaked into the member-facing 201 --------------

test('check requester never receives a collector token; dispatch carries it; completes once', async () => {
  const captured: { jobId: string; token?: string }[] = [];
  const runner = {
    dispatch: async (input: { jobId: string; collectorToken?: string }) => {
      captured.push({ jobId: input.jobId, token: input.collectorToken });
      return { accepted: true };
    },
    cancel: async () => ({ accepted: true }),
  };
  const { ctx, store } = fixture(undefined, runner);
  await seedCandidate(store, 'c1', CAND);
  const requester = agent('author-1', ['read', 'checks:write']);
  const res = await handleChecks(
    { ...ctx, principal: requester }, req(),
    ['candidates', 'c1', 'checks'],
    { operationId: 'op-1', expectedRevision: 1, command: 'npm test' },
  );
  assert.equal(res?.status, 201);
  const body = (await res!.json()) as { job: CheckJob; collectorToken?: string };
  assert.equal(body.collectorToken, undefined);
  assert.equal(captured.length, 1);
  assert.ok(captured[0].token?.startsWith('cjob_'));

  // The requester's member credential cannot complete the job.
  await assert.rejects(
    handleChecks({ ...ctx, principal: requester }, req(),
      ['collector', 'jobs', body.job.id, 'complete'],
      { operationId: 'op-forge', outcome: 'pass' }),
    (e: unknown) => (e as ApiError).status === 403,
  );

  // The dispatched token authenticates as collector and completes once.
  const collector = await authenticateCollector(
    new Request('https://x.test/', { headers: { authorization: `Bearer ${captured[0].token}` } }),
    await store.read(),
  );
  assert.ok(collector !== null);
  const done = await handleChecks(
    { ...ctx, principal: collector }, req(),
    ['collector', 'jobs', body.job.id, 'complete'],
    { operationId: 'op-c1', outcome: 'pass', candidateSha: CAND, command: 'npm test' },
  );
  assert.equal(done?.status, 201);
  // The token dies with the job: a second completion cannot authenticate.
  assert.equal(
    await authenticateCollector(
      new Request('https://x.test/', { headers: { authorization: `Bearer ${captured[0].token}` } }),
      await store.read(),
    ),
    null,
  );
});

// --- defect: safe views exposed job credential hashes ------------------------

test('safeSnapshot strips collectorTokenHash from jobs', async () => {
  const { store } = fixture();
  await seedCandidate(store, 'c1', CAND);
  await store.transact((d) => {
    d.jobs['j1'] = {
      ...meta('j1', 'system'), candidateId: 'c1', candidateSha: CAND,
      command: 'npm test', status: 'running', dedupeKey: 'k',
      collectorTokenHash: 'deadbeef',
    } as CheckJob;
    return true;
  });
  const safe = safeSnapshot(await store.read(), owner);
  assert.equal(JSON.stringify(safe.jobs).includes('deadbeef'), false);
  assert.equal((safe.jobs['j1'] as { collectorTokenHash?: string }).collectorTokenHash, undefined);
});

// --- defect: prose cap counted code units, not UTF-8 bytes -------------------

test('prose fields enforce the 16KiB cap in UTF-8 bytes', async () => {
  const { ctx, store } = fixture();
  await store.transact((d) => {
    d.tasks['t1'] = {
      ...meta('t1'), goal: 't', acceptanceCriteria: [], dependencies: [],
      lifecycle: 'open', resultRefs: [],
    } as Task;
    return true;
  });
  // 5462 x '€' (3 bytes each) = 16386 bytes > 16KiB, though only 5462 chars.
  const heavy = '€'.repeat(5462);
  await assert.rejects(
    handleInbox(ctx, req(), ['tasks', 't1', 'help'], {
      operationId: 'op-p', question: heavy,
    }),
    (e: unknown) => (e as ApiError).status === 422 && (e as ApiError).code === 'prose_too_large',
  );
});

// --- defect: crash after push left 'pending'; replay repushed ----------------

test('uncertain dispatch: replay reconciles by read-back and never repushes', async () => {
  let pushes = 0;
  let failReadOnce = true;
  const git: GitService = {
    prepare: async () => ({ sha: CAND, base: BASE, proposalHeads: {}, changedPaths: [] }),
    readTip: async () => {
      if (failReadOnce) { failReadOnce = false; throw new Error('connection dropped'); }
      return CAND;
    },
    isAncestor: async () => true,
    push: async () => { pushes += 1; return { ended: true, effect: 'updated' }; },
  };
  const { ctx, store } = fixture(git);
  await seedCandidate(store, 'c1', CAND);
  // Satisfy readiness: a pass receipt + independent approval on the sha.
  await store.transact((d) => {
    d.jobs['job-1'] = { ...meta('job-1', 'system'), candidateId: 'c1', candidateSha: CAND, command: 'npm test', status: 'completed' } as CheckJob;
    d.receipts['r-1'] = {
      ...meta('r-1', 'collector'), jobId: 'job-1', candidateSha: CAND, collectorId: 'collector:job-1',
      command: 'npm test', outcome: 'pass', artifactRefs: [],
    } as never;
    d.reviews['rv-1'] = {
      ...meta('rv-1'), candidateId: 'c1', candidateSha: CAND, reviewerId: 'peer',
      policyVersion: 1, disposition: 'approve', independent: true, findingIds: [],
    } as never;
    d.candidates['c1'].checkJobIds = ['job-1'];
    return true;
  });
  const body = { operationId: 'op-int', expectedTip: BASE };
  await assert.rejects(handleIntegration(ctx, req(), ['candidates', 'c1', 'integrate'], body));
  assert.equal(pushes, 1);
  const op = (await store.read()).operations['op-int'] as Operation;
  assert.notEqual(op.effect, 'pending');

  // Replay: same operationId, tip now shows the candidate -- attribute, no push.
  const replay = await handleIntegration(ctx, req(), ['candidates', 'c1', 'integrate'], body);
  assert.equal(pushes, 1);
  const rep = (await replay!.json()) as { effect: string };
  assert.equal(rep.effect, 'confirmed');
});

// --- defect: manifest hash followed symlinks outside the snapshot ------------

test('snapshotInputHash never reads through symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'snap-'));
  try {
    writeFileSync(join(root, 'a.txt'), 'inside');
    const outside = join(root, '..', `outside-${Date.now()}.txt`);
    writeFileSync(outside, 'one');
    symlinkSync(outside, join(root, 'link.txt'));
    const h1 = snapshotInputHash(root);
    writeFileSync(outside, 'two-different-content');
    const h2 = snapshotInputHash(root);
    assert.equal(h1, h2);
    writeFileSync(join(root, 'a.txt'), 'changed inside');
    assert.notEqual(snapshotInputHash(root), h1);
    rmSync(outside);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- defect: delegated issuers could re-delegate identity:delegate ----------

test('delegated enrollment cannot grant identity:delegate onward', async () => {
  const { ctx, store } = fixture();
  // Enroll a real delegator: owner-scoped invitation grants identity:delegate.
  const AUTH_OPTS = { ownerTokens: [{ ownerId: 'user-1', token: 'tok_owner' }], now };
  let res = await handleIdentity(ctx, req(), ['identities'],
    { operationId: 'op-id-del', displayName: 'delegator' });
  assert.equal(res?.status, 201);
  const delegatorId = ((await res!.json()) as { identity: { id: string } }).identity.id;
  res = await handleIdentity(ctx, req(), ['identities', delegatorId, 'invitations'],
    { operationId: 'op-inv-del', scopes: ['read', 'identity:delegate'] });
  const invite = ((await res!.json()) as { token: string }).token;
  const enrolled = (await authenticate(
    new Request('https://x.test/enrollment/exchange', { headers: { authorization: `Bearer ${invite}` } }),
    await store.read(), AUTH_OPTS)) as EnrollmentPrincipal;
  assert.ok(enrolled?.enrollment);
  res = await handleIdentity({ ...ctx, principal: enrolled }, req(), ['enrollment', 'exchange'],
    { operationId: 'op-ex-del', adapter: 'cli' });
  const token = ((await res!.json()) as { token: string }).token;
  const delegator = await authenticate(
    new Request('https://x.test/x', { headers: { authorization: `Bearer ${token}` } }),
    await store.read(), AUTH_OPTS);
  assert.ok(delegator);
  // The delegator creates its own child identity.
  const created = await handleIdentity(
    { ...ctx, principal: delegator }, req(), ['identities'],
    { operationId: 'op-i1', displayName: 'child-1', parentId: delegatorId },
  );
  assert.equal(created?.status, 201);
  const child = ((await created!.json()) as { identity: { id: string } }).identity;
  // Delegated invitation requesting identity:delegate is rejected.
  await assert.rejects(
    handleIdentity({ ...ctx, principal: delegator }, req(),
      ['identities', child.id, 'invitations'],
      { operationId: 'op-i2', scopes: ['read', 'identity:delegate'] }),
    (e: unknown) => (e as ApiError).status === 422 && (e as ApiError).code === 'scope_not_grantable',
  );
  // Admin may still grant it.
  const ok = await handleIdentity({ ...ctx, principal: owner }, req(),
    ['identities', child.id, 'invitations'],
    { operationId: 'op-i3', scopes: ['read', 'identity:delegate'] });
  assert.equal(ok?.status, 201);
});

// --- defect: heartbeat renewed the lease for terminal jobs -------------------

test('a heartbeat for a non-active job renews nothing and is recorded late', async () => {
  const { ctx, store } = fixture();
  await store.transact((d) => {
    d.assignments['a1'] = {
      ...meta('a1'), taskId: 't1', identityId: 'agent-x', role: 'builder',
      scopes: ['read'], epoch: 1,
      leaseExpiresAt: '2026-10-04T00:10:00.000Z',
      maxUntil: '2026-10-04T01:00:00.000Z', status: 'active',
    } as never;
    d.jobs['j1'] = {
      ...meta('j1', 'system'), candidateId: 'c1', candidateSha: CAND,
      command: 'npm test', status: 'completed', dedupeKey: 'k',
      ownerAssignmentId: 'a1', ownerEpoch: 1,
      deadlineAt: '2026-10-04T00:30:00.000Z',
    } as CheckJob;
    return true;
  });
  const leaseBefore = (await store.read()).assignments['a1'].leaseExpiresAt;
  const result = await store.transact((d) =>
    renewForJobHeartbeat(d, ctx, { jobId: 'j1', assignmentId: 'a1', epoch: 1 }));
  assert.equal(result.renewed, false);
  assert.equal(result.reason, 'job-not-active');
  const after = await store.read();
  assert.equal(after.assignments['a1'].leaseExpiresAt, leaseBefore);
  assert.ok(after.events.some((e) => e.type === 'assignment:heartbeat-late'));
});

// --- defect: taskless help had no live route and no sample path --------------

test('project-level help works live (POST /help) and without a task', async () => {
  const { ctx, store } = fixture();
  const helper = agent('helper-1', ['read', 'help:write']);
  const res = await handleInbox(
    { ...ctx, principal: helper }, req(), ['help'],
    { operationId: 'op-h1', question: 'Who can review this?' },
  );
  assert.equal(res?.status, 201);
  const body = (await res!.json()) as { help: { id: string; taskId?: string } };
  assert.equal(body.help.taskId, undefined);
  const state: ProjectState = await store.read();
  assert.ok(state.help[body.help.id] !== undefined);
});
