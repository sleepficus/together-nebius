// Lane r-swe-10 unit evidence: local composition (owner bootstrap, session
// cookie + origin checks, loopback binding, durable state) and trusted
// runner dispatch/collector wiring. Docker itself is replaced by a clearly
// labeled executable fixture: these tests prove wiring and the isolation
// argv handed to Docker, not actual container isolation.
// Runs with: node --import tsx --test tests/r-swe-10.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../cloud/app.ts';
import { createLocalApi, startLocalServer } from '../cloud/local-server.ts';
import { JsonFileStore } from '../cloud/local-store.ts';
import { createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { authenticate, handleIdentity } from '../lib/identity.ts';
import { handleChecks } from '../lib/checks.ts';
import { handleAssignments } from '../lib/assignments.ts';
import { handleChanges } from '../lib/changes.ts';
import { handleIntegration } from '../lib/integration.ts';
import { handleFindings } from '../lib/findings.ts';
import { handleReviews } from '../lib/reviews.ts';
import { handleInbox } from '../lib/inbox.ts';
import { handleEvents } from '../lib/events.ts';
import { snapshotInputHash } from '../runner/snapshot-runner.ts';
import type { Candidate, Principal, ProjectState } from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let seq = 0;
const uid = () => `u-${++seq}`;
const now = () => new Date().toISOString();
const OWNER = { ownerId: 'steve', token: 'test-owner-token' };
const bearer = { authorization: `Bearer ${OWNER.token}` };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const HANDLERS = [
  handleIdentity, handleAssignments, handleChanges, handleIntegration,
  handleChecks, handleFindings, handleReviews, handleInbox, handleEvents,
];

const tmp = (label: string) => mkdtempSync(join(process.cwd(), `.lane10-${label}-`));

function seedState(projectId: string, goal = 'fixture'): ProjectState {
  const t = T0;
  const state = createState({ id: projectId, goal, mode: 'live', actorId: 'steve', now: t });
  state.identities.steve = {
    id: 'steve', projectId, revision: 1, createdAt: t, updatedAt: t, actorId: 'steve',
    displayName: 'Local owner', ownerId: 'steve', creationSource: 'owner', status: 'active',
  };
  state.members['mem-steve'] = {
    id: 'mem-steve', projectId, revision: 1, createdAt: t, updatedAt: t, actorId: 'steve',
    identityId: 'steve', kind: 'core', scopes: ['owner', 'admin', 'read'],
  };
  return state;
}

const api = (extra: Record<string, unknown> = {}) =>
  createLocalApi({
    ownerTokens: [OWNER],
    seedProjects: [{ id: 'p1', goal: 'seeded' }],
    now, uid,
    ...extra,
    ...(extra.snapshotDir ? { snapshotProvider: () => ({ dir: String(extra.snapshotDir), cleanup() {} }) } : {}),
  } as Parameters<typeof createLocalApi>[0]);

const req = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1${path}`, init);
const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// --- owner bootstrap: original 404 vs repaired 201 -------------------------

test('owner project bootstrap: original composition 404s POST /projects; repaired creates + lists', async () => {
  // Original composition: one createApp over a single store, exactly what
  // the shipped local server wired -- POST /api/v1/projects has no owner.
  const state = seedState('p1');
  const original = createApp({
    store: new MemoryStore(state),
    authenticate: (r: Request) => authenticate(r, state, { ownerTokens: [OWNER] }),
    handlers: HANDLERS,
  });
  const before = await original.fetch(
    jsonPost('/api/v1/projects', { goal: 'new live project' }, bearer),
  );
  assert.equal(before.status, 404, 'original composition answered 404 (reported defect)');

  const repaired = api();
  const created = await repaired.fetch(
    jsonPost('/api/v1/projects', { goal: 'new live project' }, bearer),
  );
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { project: { id: string; goal: string } };
  assert.equal(createdBody.project.goal, 'new live project');
  const newId = createdBody.project.id;

  const list = await repaired.fetch(req('/api/v1/projects', { headers: bearer }));
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { projects: { id: string }[] };
  assert.deepEqual(
    listBody.projects.map((p) => p.id).sort(),
    ['p1', newId].sort(),
  );

  const read = await repaired.fetch(
    req(`/api/v1/projects/${newId}`, { headers: bearer }),
  );
  assert.equal(read.status, 200);
  const readBody = (await read.json()) as ProjectState;
  assert.equal(readBody.project.id, newId);
  assert.equal(readBody.project.mode, 'live');

  // Non-owner principals and unauthenticated callers cannot bootstrap.
  const unauth = await repaired.fetch(jsonPost('/api/v1/projects', { goal: 'x' }));
  assert.equal(unauth.status, 401);
  // Explicit id collision is reported, not silently reused.
  const dupe = await repaired.fetch(
    jsonPost('/api/v1/projects', { id: newId, goal: 'again' }, bearer),
  );
  assert.equal(dupe.status, 409);
  const badId = await repaired.fetch(
    jsonPost('/api/v1/projects', { id: '../escape', goal: 'x' }, bearer),
  );
  assert.equal(badId.status, 422);
});

test('unknown project ids are authentication-gated before 404', async () => {
  const a = api();
  assert.equal((await a.fetch(req('/api/v1/projects/nope'))).status, 401);
  const res = await a.fetch(req('/api/v1/projects/nope', { headers: bearer }));
  assert.equal(res.status, 404);
});

// --- session cookie + origin checks ---------------------------------------

test('owner session: bearer exchanges for HttpOnly cookie; cookie authorizes reads', async () => {
  const a = api();
  const noAuth = await a.fetch(jsonPost('/api/v1/session', {}));
  assert.equal(noAuth.status, 401);

  const login = await a.fetch(jsonPost('/api/v1/session', {}, bearer));
  assert.equal(login.status, 201);
  const cookie = login.headers.get('set-cookie') ?? '';
  assert.match(cookie, /together_session=sess_[a-f0-9]+/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/api/);
  const sessionCookie = cookie.split(';')[0];

  const whoami = await a.fetch(req('/api/v1/session', { headers: { cookie: sessionCookie } }));
  assert.equal(whoami.status, 200);
  const who = (await whoami.json()) as { authenticated: boolean; principal: Principal };
  assert.equal(who.authenticated, true);
  assert.equal(who.principal.kind, 'human');
  assert.ok(who.principal.scopes.includes('owner'));

  const list = await a.fetch(req('/api/v1/projects', { headers: { cookie: sessionCookie } }));
  assert.equal(list.status, 200);

  // Logout ends the session; the cookie no longer authorizes.
  const end = await a.fetch(req('/api/v1/session', { method: 'DELETE', headers: { cookie: sessionCookie } }));
  assert.equal(end.status, 200);
  const after = await a.fetch(req('/api/v1/projects', { headers: { cookie: sessionCookie } }));
  assert.equal(after.status, 401);
});

test('mutating requests enforce loopback origin and refuse cross-site fetches', async () => {
  const a = api();
  const foreign = await a.fetch(
    jsonPost('/api/v1/projects', { goal: 'x' }, { ...bearer, origin: 'https://evil.example' }),
  );
  assert.equal(foreign.status, 403);
  const crossSite = await a.fetch(
    jsonPost('/api/v1/projects', { goal: 'x' }, { ...bearer, 'sec-fetch-site': 'cross-site' }),
  );
  assert.equal(crossSite.status, 403);
  // Loopback browser origin (the vite dev server) is accepted.
  const local = await a.fetch(
    jsonPost('/api/v1/projects', { goal: 'from browser' }, { ...bearer, origin: 'http://localhost:5173' }),
  );
  assert.equal(local.status, 201);
  // Reads are not gated by origin.
  const read = await a.fetch(req('/api/v1/projects', { headers: { ...bearer, origin: 'https://evil.example' } }));
  assert.equal(read.status, 200);
});

// --- durable local state ---------------------------------------------------

test('JsonFileStore persists committed state and restores it on reopen', async () => {
  const dir = tmp('state');
  try {
    const file = join(dir, 'p1.json');
    const seed = () => seedState('p1');
    const first = new JsonFileStore(file, seed);
    await first.transact((d) => {
      d.project.revision = 7;
      return true;
    });
    const reopened = new JsonFileStore(file, seed);
    const restored = await reopened.read();
    assert.equal(restored.project.revision, 7);
    assert.equal(restored.project.id, 'p1');

    // A corrupt state file fails closed -- never silently reseeded over.
    writeFileSync(join(dir, 'bad.json'), '{not json');
    assert.throws(() => new JsonFileStore(join(dir, 'bad.json'), seed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createLocalApi restores persisted projects from a state directory', async () => {
  const dir = tmp('restore');
  try {
    const first = api({ stateDir: dir });
    const created = await first.fetch(
      jsonPost('/api/v1/projects', { id: 'persisted-p', goal: 'survives restart' }, bearer),
    );
    assert.equal(created.status, 201);
    // Give the file store a moment to finish its write tail.
    await first.storeFor('persisted-p')!.read();

    const second = api({ stateDir: dir });
    const list = await second.fetch(req('/api/v1/projects', { headers: bearer }));
    const body = (await list.json()) as { projects: { id: string; goal: string }[] };
    const found = body.projects.find((p) => p.id === 'persisted-p');
    assert.ok(found !== undefined, 'persisted project restored after restart');
    assert.equal(found!.goal, 'survives restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- loopback binding -------------------------------------------------------

test('startLocalServer binds 127.0.0.1 only and serves the real API', async () => {
  const { server, listening } = startLocalServer({ ownerTokens: [OWNER], port: 0 });
  try {
    const port = await listening;
    const address = server.address() as { address: string } | null;
    assert.equal(address?.address, '127.0.0.1');
    const unauth = await fetch(`http://127.0.0.1:${port}/api/v1/projects`);
    assert.equal(unauth.status, 401);
    const authed = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, { headers: bearer });
    assert.equal(authed.status, 200);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

// --- snapshot manifest: symlink name-only (controller regression) ----------

test('snapshotInputHash records symlinks by name+target and never reads through', () => {
  const dir = tmp('link');
  try {
    const snapshot = join(dir, 'snapshot');
    mkdirSync(snapshot);
    writeFileSync(join(dir, 'outside.txt'), 'harmless fixture alpha');
    symlinkSync('../outside.txt', join(snapshot, 'link.txt'));
    writeFileSync(join(snapshot, 'real.txt'), 'snapshot file');

    const before = snapshotInputHash(snapshot);
    writeFileSync(join(dir, 'outside.txt'), 'harmless fixture beta');
    const after = snapshotInputHash(snapshot);
    assert.equal(before, after, 'outside target content must not reach the manifest hash');

    writeFileSync(join(snapshot, 'real.txt'), 'changed snapshot file');
    assert.notEqual(snapshotInputHash(snapshot), before, 'in-snapshot edits still change the hash');

    // A symlinked directory is recorded, never traversed into.
    mkdirSync(join(dir, 'outside-dir'));
    writeFileSync(join(dir, 'outside-dir', 'inner.txt'), 'v1');
    symlinkSync('../outside-dir', join(snapshot, 'dir-link'));
    const withLink = snapshotInputHash(snapshot);
    writeFileSync(join(dir, 'outside-dir', 'inner.txt'), 'v2');
    assert.equal(snapshotInputHash(snapshot), withLink);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- trusted runner dispatch -> collector ----------------------------------

/** Labeled executable fixture standing in for the docker CLI: records argv
 * and emulates `docker run` by executing the command in the mounted
 * directory. NOT an isolation boundary -- wiring evidence only. */
function fakeDocker(dir: string): { bin: string; log: string } {
  const log = join(dir, 'docker-argv.log');
  const bin = join(dir, 'fake-docker.mjs');
  writeFileSync(
    bin,
    [
      "import {appendFileSync} from 'node:fs';",
      "import {spawnSync} from 'node:child_process';",
      'const args = process.argv.slice(2);',
      "if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args)+'\\n');",
      "if (args[0] === 'version') { console.log('25.0.0-fixture'); process.exit(0); }",
      "if (args[0] === 'rm') { process.exit(0); }",
      "if (args[0] === 'run') {",
      "  const vi = args.indexOf('--volume');",
      "  const dir = args[vi + 1].split(':')[0];",
      '  const cmd = args[args.length - 1];',
      "  const r = spawnSync('sh', ['-c', cmd], { cwd: dir });",
      "  process.stdout.write(r.stdout ?? '');",
      "  process.stderr.write(r.stderr ?? '');",
      '  process.exit(r.status ?? 1);',
      '}',
      'process.exit(1);',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const waitFor = async (fn: () => Promise<boolean>, ms = 15000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('timed out waiting for condition');
};

test('dispatch runs the trusted collector end-to-end: request -> job -> real receipt', async () => {
  const dir = tmp('runner');
  try {
    const snapshotDir = join(dir, 'snap');
    mkdirSync(snapshotDir);
    writeFileSync(join(snapshotDir, 'marker.txt'), 'snapshot-marker');
    const docker = fakeDocker(dir);
    process.env.FAKE_DOCKER_LOG = docker.log;

    // createSnapshotRunner spawns dockerBin as a single argv0; a shell shim
    // fronts the node fixture.
    const shim = join(dir, 'docker');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${docker.bin}" "$@"\n`);
    chmodSync(shim, 0o755);
    const api2 = api({ dockerBin: shim, snapshotDir });

    // Seed a prepared candidate directly (store seam; real API checks come next).
    const store = api2.storeFor('p1');
    assert.ok(store !== undefined);
    await store!.transact((d) => {
      const c: Candidate = {
        id: 'c1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
        actorId: 'steve', base: SHA_B, proposalIds: [], proposalHeads: {},
        sha: SHA_A, policyVersion: 1, status: 'prepared', checkJobIds: [], reviewIds: [],
      };
      d.candidates.c1 = c;
      return true;
    });

    const res = await api2.fetch(
      jsonPost('/api/v1/projects/p1/candidates/c1/checks', {
        operationId: 'check-op-1',
        expectedRevision: 1,
        command: 'cat marker.txt',
        timeoutMs: 4000,
      }, bearer),
    );
    assert.equal(res.status, 201);
    const payload = (await res.json()) as { job: { id: string; status: string }; collectorToken?: string };
    assert.equal(payload.job.status, 'dispatched');
    assert.equal(payload.collectorToken, undefined, 'collector token stays server-side');

    await waitFor(async () => {
      const s = await store!.read();
      return s.jobs[payload.job.id]?.status === 'completed';
    });

    const state = await store!.read();
    const job = state.jobs[payload.job.id]!;
    assert.equal(job.status, 'completed');
    const receipt = Object.values(state.receipts).find((r) => r.jobId === job.id)!;
    assert.ok(receipt !== undefined, 'collector completion wrote the only receipt');
    assert.equal(receipt.outcome, 'pass');
    assert.equal(receipt.candidateSha, SHA_A);
    assert.equal(receipt.command, 'cat marker.txt');
    assert.equal(receipt.inputHash, snapshotInputHash(snapshotDir));
    assert.ok(typeof receipt.outputHash === 'string' && receipt.outputHash.length === 64);
    assert.match(String(receipt.collectorId), /^collector:/);

    // Isolation argv handed to docker (fixture captured; no claim of real
    // container isolation): network none, read-only, nonroot, tmpfs, ro src.
    const runs = readFileSync(docker.log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[])
      .filter((a) => a[0] === 'run');
    assert.equal(runs.length, 1);
    const argv = runs[0];
    const flag = (f: string) => argv.includes(f);
    const value = (f: string) => argv[argv.indexOf(f) + 1];
    assert.ok(flag('--network') && value('--network') === 'none');
    assert.ok(flag('--read-only'));
    assert.ok(flag('--user') && value('--user') === '65534:65534');
    assert.ok(flag('--tmpfs'));
    assert.ok(flag('--env') && argv.includes('HOME=/nonexistent'));
    const vol = value('--volume');
    assert.ok(vol.endsWith(':/src:ro'), `snapshot mounted read-only: ${vol}`);
    // Inspect environment arguments, not the snapshot mount path (which may
    // legitimately sit inside a directory named TOGETHER on the review host).
    const containerEnv = argv.flatMap((a, i) => a === '--env' || a === '-e' ? [argv[i + 1]] : a.startsWith('--env=') ? [a.slice(6)] : []);
    assert.ok(!containerEnv.some((a) => a.includes('TOGETHER') || a.includes('HOME=/Users')),
      'no host/account environment leaks into the container');
  } finally {
    delete process.env.FAKE_DOCKER_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch without docker answers docker-unavailable; missing snapshot is honest', async () => {
  const a = createLocalApi({
    ownerTokens: [OWNER],
    seedProjects: [{ id: 'p1' }],
    dockerBin: '/nonexistent/docker',
    now, uid,
  });
  const store = a.storeFor('p1')!;
  await store.transact((d) => {
    d.candidates.c1 = {
      id: 'c1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
      actorId: 'steve', base: SHA_B, proposalIds: [], proposalHeads: {},
      sha: SHA_A, policyVersion: 1, status: 'prepared', checkJobIds: [], reviewIds: [],
    };
    return true;
  });
  const res = await a.fetch(
    jsonPost('/api/v1/projects/p1/candidates/c1/checks', {
      operationId: 'check-op-2', expectedRevision: 1, command: 'true', timeoutMs: 1000,
    }, bearer),
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { job: { status: string; blockedReason?: string } };
  assert.equal(body.job.status, 'blocked');
  assert.match(String(body.job.blockedReason), /docker|dispatch|runner-unavailable/);
});
