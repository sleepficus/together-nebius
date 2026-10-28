// Unit evidence for lane c-swe-08 (isolated checks / trusted collector).
//
// Covers the original-risk surface named in the lane brief:
//   - cloud dispatch enqueues a durable PRIVATE check.run job -- the
//     collector token is in the broker payload only and a caller-supplied
//     snapshotRef is dropped ("exact candidate snapshot, no caller mount");
//   - the companion materializes the exact SHA from an owned mirror
//     (real git fetch of a real commit), runs the pinned network-none
//     snapshot runner (fake docker shim -- no daemon needed), and returns
//     a broker result ONLY after the REAL collector route accepted the
//     completion (real authenticateCollector + handleChecks + command());
//   - forgery/stale/cross-project/missing-token rejection, timeout,
//     cancel, and truthful 'blocked' on unavailable dependencies;
//   - no credential material reaches the docker argv surface.
//
// Runs with: tsx --test tests/c-swe-08.test.ts

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createState } from '../lib/core.ts';
import { authenticateCollector, handleChecks, hashCollectorToken } from '../lib/checks.ts';
import { MemoryStore } from '../lib/store.ts';
import { createCloudRunnerService } from '../cloud/check-service.ts';
import { CheckExecutionError, runCheckExecution } from '../companion/check-executor.ts';
import type { CheckRunPayload } from '../cloud/check-service.ts';
import type { BridgeOptions, ExecutionInput, ExecutionJob } from '../cloud/phase04-contract.ts';
import type { CheckJob, Context, ProjectState } from '../lib/types.ts';
import type { DirectoryProjectRecord } from '../cloud/phase04-contract.ts';

const T0 = '2026-10-04T00:00:00.000Z';
const FAR = '2027-01-01T00:00:00.000Z';
let seq = 0;
const uid = () => `id-${++seq}`;
const shaHex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const record: DirectoryProjectRecord = {
  id: 'p1', ownerId: 'user-1', goal: 'cloud project', createdAt: T0,
  repositoryId: 'repo-1', remote: 'https://artifacts.example/together-cloud-p1.git',
  canonicalRef: 'refs/heads/together-cloud', provisioning: 'ready',
  operationId: 'op-create', digest: 'digest-1',
};

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'c-swe-08-'));
}

/** Minimal docker stand-in: records argv, answers version/run/rm honestly
 * for fixture purposes. Never executes the candidate command. */
function fakeDocker(dir: string): { bin: string; recordFile: string } {
  const recordFile = join(dir, 'docker-argv.log');
  const bin = join(dir, 'fake-docker.sh');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `{ printf '%s ' "$@"; printf '\\n'; } >> "${recordFile}"`,
      'case "$1" in',
      '  version) echo "27.0.0"; exit 0 ;;',
      `  run) if [ -f "${join(dir, 'docker-out.txt')}" ]; then cat "${join(dir, 'docker-out.txt')}"; else echo fixture-output; fi`,
      `       exit "$(cat "${join(dir, 'docker-exit.txt')}" 2>/dev/null || echo 0)" ;;`,
      '  rm) exit 0 ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { bin, recordFile };
}

function gitRepo(dir: string): { repo: string; sha: string } {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--template=', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'value.txt'), 'committed-content');
  git('add', '.');
  git('commit', '-m', 'base');
  return { repo, sha: git('rev-parse', 'HEAD') };
}

interface CollectorFixture {
  store: MemoryStore;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  token: string;
}

/**
 * The REAL collector seam: authenticateCollector + handleChecks + command()
 * over a MemoryStore, exactly as createApp composes them in the worker.
 * The check job is seeded 'dispatched' with the token hash registered.
 */
async function collectorFixture(input: {
  candidateSha: string;
  command?: string;
  jobStatus?: CheckJob['status'];
  token?: string;
  jobId?: string;
  environment?: Record<string, string>;
}): Promise<CollectorFixture> {
  const token = input.token ?? `cjob_${'f'.repeat(32)}`;
  const jobId = input.jobId ?? 'job1';
  const command = input.command ?? 'run-tests';
  const store = new MemoryStore(createState({ id: 'p1', goal: 'cloud project', mode: 'live', now: T0 }));
  const tokenHash = await hashCollectorToken(token);
  await store.transact((draft: ProjectState) => {
    draft.candidates.c1 = {
      id: 'c1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0, actorId: 'seed',
      base: 'b'.repeat(40), proposalIds: [], proposalHeads: {}, sha: input.candidateSha,
      policyVersion: 1, status: 'checking', checkJobIds: [jobId], reviewIds: [],
    };
    draft.jobs[jobId] = {
      id: jobId, projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0, actorId: 'seed',
      kind: 'check', candidateId: 'c1', candidateSha: input.candidateSha, command,
      status: input.jobStatus ?? 'dispatched', deadlineAt: FAR, dedupeKey: `check::${input.candidateSha}:${command}:`,
      collectorTokenHash: tokenHash,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    } as CheckJob;
    return true;
  });
  const fetchImpl = async (input2: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input2, init);
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const state = await store.read();
    const principal = await authenticateCollector(request, state);
    if (principal === null) return new Response('unauthenticated', { status: 401 });
    const projectId = decodeURIComponent(parts[3] ?? '');
    if (!principal.projectIds.includes(projectId)) return new Response('not found', { status: 404 });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ctx: Context = { principal, store, now: () => T0, uid };
    const res = await handleChecks(ctx, request, parts.slice(4), body);
    return res ?? new Response('no handler', { status: 404 });
  };
  return { store, fetchImpl, token };
}

function checkJob(payload: Record<string, unknown>, over: Partial<ExecutionJob> = {}): ExecutionJob {
  return {
    id: 'exec-1', key: 'check.run:job1', projectId: 'p1', role: 'check', action: 'check.run',
    payload, digest: 'dg', status: 'leased', deadlineAt: FAR, ...over,
  };
}

// ---------------------------------------------------------------- dispatch

test('dispatch enqueues a durable private check.run job and drops caller snapshotRef', async () => {
  const enqueued: ExecutionInput[] = [];
  const runner = createCloudRunnerService({
    env: {}, record,
    enqueue: async (_env, input) => {
      enqueued.push(input);
      return { ...input, id: 'exec-1', digest: 'dg', status: 'queued' } as ExecutionJob;
    },
  });
  const res = await runner.dispatch({
    projectId: 'p1', jobId: 'job1', candidateSha: 'a'.repeat(40),
    snapshotRef: '/etc/passwd', command: 'run-tests', timeoutMs: 60_000,
    operationId: 'op-1', collectorToken: 'cjob_secret-token',
    environment: { CHECK_FIXTURE: 'registered-value' },
  });
  assert.deepEqual(res, { accepted: true });
  assert.equal(enqueued.length, 1);
  const job = enqueued[0];
  assert.equal(job.role, 'check');
  assert.equal(job.action, 'check.run');
  assert.equal(job.key, 'check.run:job1');
  assert.equal(job.projectId, 'p1');
  const payload = job.payload as unknown as CheckRunPayload;
  assert.equal(payload.checkJobId, 'job1');
  assert.equal(payload.candidateSha, 'a'.repeat(40));
  assert.equal(payload.command, 'run-tests');
  assert.equal(payload.collectorToken, 'cjob_secret-token');
  assert.deepEqual(payload.environment, { CHECK_FIXTURE: 'registered-value' });
  assert.equal(payload.mirror?.remote, record.remote);
  // The caller-selected mount must not reach the executor at all.
  assert.equal(JSON.stringify(payload).includes('/etc/passwd'), false);
  assert.equal('snapshotRef' in payload, false);
});

test('dispatch rejects mismatched project, bad sha, empty command, bad timeout', async () => {
  const enqueued: ExecutionInput[] = [];
  const runner = createCloudRunnerService({
    env: {}, record,
    enqueue: async (_env, input) => {
      enqueued.push(input);
      return { ...input, id: 'x', digest: 'd', status: 'queued' } as ExecutionJob;
    },
  });
  const base = { projectId: 'p1', jobId: 'job1', candidateSha: 'a'.repeat(40), command: 'c', timeoutMs: 1000, operationId: 'o' };
  assert.equal((await runner.dispatch({ ...base, projectId: 'p2' })).accepted, false);
  assert.equal((await runner.dispatch({ ...base, candidateSha: 'HEAD' })).accepted, false);
  assert.equal((await runner.dispatch({ ...base, command: '   ' })).accepted, false);
  assert.equal((await runner.dispatch({ ...base, timeoutMs: 0 })).accepted, false);
  assert.equal((await runner.dispatch({ ...base, jobId: 'bad id!' })).accepted, false);
  assert.equal(enqueued.length, 0);
});

test('dispatch reports rejected when the broker enqueue fails', async () => {
  const runner = createCloudRunnerService({
    env: {}, record,
    enqueue: async () => { throw new Error('EXECUTION_OBJECT unavailable'); },
  });
  const res = await runner.dispatch({
    projectId: 'p1', jobId: 'job1', candidateSha: 'a'.repeat(40),
    command: 'run-tests', timeoutMs: 60_000, operationId: 'op-1', collectorToken: 't',
  });
  assert.deepEqual(res, { accepted: false, reason: 'enqueue-unavailable' });
});

test('cancel enqueues a private check.cancel job bound to the check job id', async () => {
  const enqueued: ExecutionInput[] = [];
  const runner = createCloudRunnerService({
    env: {}, record,
    enqueue: async (_env, input) => {
      enqueued.push(input);
      return { ...input, id: 'exec-2', digest: 'dg', status: 'queued' } as ExecutionJob;
    },
  });
  assert.deepEqual(await runner.cancel({ projectId: 'p1', jobId: 'job1' }), { accepted: true });
  assert.equal(enqueued[0].action, 'check.cancel');
  assert.equal((enqueued[0].payload as { checkJobId: string }).checkJobId, 'job1');
  assert.equal('collectorToken' in enqueued[0].payload, false);
  assert.equal((await runner.cancel({ projectId: 'p2', jobId: 'job1' })).accepted, false);
});

test('dispatch attaches the read capability when available and degrades without it', async () => {
  const captured: CheckRunPayload[] = [];
  const runner = createCloudRunnerService({
    env: {}, record,
    enqueue: async (_env, input) => {
      captured.push(input.payload as unknown as CheckRunPayload);
      return { ...input, id: 'x', digest: 'd', status: 'queued' } as ExecutionJob;
    },
    readCapability: async () => ({
      repositoryId: 'repo-1', remote: record.remote, plaintext: 'cap-secret', expiresAt: FAR,
    }),
  });
  const dispatchInput = {
    projectId: 'p1', jobId: 'job1', candidateSha: 'a'.repeat(40),
    command: 'run-tests', timeoutMs: 60_000, operationId: 'op', collectorToken: 't',
  };
  assert.equal((await runner.dispatch(dispatchInput)).accepted, true);
  assert.equal(captured[0].mirror?.token, 'cap-secret');

  const runner2 = createCloudRunnerService({
    env: {}, record,
    enqueue: async (_env, input) => {
      captured.push(input.payload as unknown as CheckRunPayload);
      return { ...input, id: 'x', digest: 'd', status: 'queued' } as ExecutionJob;
    },
    readCapability: async () => { throw new Error('artifacts unavailable'); },
  });
  assert.equal((await runner2.dispatch(dispatchInput)).accepted, true);
  assert.equal(captured[1].mirror?.token, undefined);
  assert.equal(captured[1].mirror?.remote, record.remote);
});

// ---------------------------------------------------------------- executor

test('check.run materializes the exact sha, runs isolated, and returns after real collector acceptance', async () => {
  const root = tmpRoot();
  try {
    const { repo, sha } = gitRepo(root);
    const docker = fakeDocker(root);
    const collector = await collectorFixture({ candidateSha: sha });
    const payload: CheckRunPayload = {
      v: 1, checkJobId: 'job1', candidateSha: sha, command: 'run-tests',
      timeoutMs: 60_000, deadlineAt: FAR, collectorToken: collector.token,
      mirror: { remote: pathToFileURL(repo).href },
    };
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'],
      fetch: collector.fetchImpl as typeof fetch, dockerBin: docker.bin,
    };
    const result = await runCheckExecution(checkJob(payload as unknown as Record<string, unknown>), options);
    assert.equal(result.collectorAccepted, true);
    assert.equal(result.jobId, 'job1');
    assert.equal(result.outcome, 'pass');
    assert.equal(typeof result.inputHash, 'string');
    // The shim prints exactly 'fixture-output\n'; output hash binds it.
    assert.equal(result.outputHash, shaHex(Buffer.from('fixture-output\n')));
    assert.equal(typeof result.receiptId, 'string');

    const state = await collector.store.read();
    assert.equal(state.jobs.job1.status, 'completed');
    const receipts = Object.values(state.receipts);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'pass');
    assert.equal(receipts[0].candidateSha, sha);
    assert.equal(receipts[0].collectorId, 'collector:job1');

    // Snapshot came from the owned mirror, not a caller mount.
    const mirrorHead = join(root, 'mirrors', 'p1', 'HEAD');
    assert.equal(existsSync(mirrorHead), true);

    // No credential material reaches the docker argv surface.
    const argvLog = readFileSync(docker.recordFile, 'utf8');
    assert.equal(argvLog.includes(collector.token), false);
    assert.equal(argvLog.includes('mirror-cap-secret'), false);
    assert.match(argvLog, /--network none/);
    assert.match(argvLog, /sh -c run-tests/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale completion on a terminal job is collector-rejected and creates nothing', async () => {
  const root = tmpRoot();
  try {
    const { repo, sha } = gitRepo(root);
    const docker = fakeDocker(root);
    const collector = await collectorFixture({ candidateSha: sha, jobStatus: 'completed' });
    await collector.store.transact((draft: ProjectState) => {
      draft.receipts.old = {
        id: 'old', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0, actorId: 'collector:job1',
        jobId: 'job1', candidateSha: sha, collectorId: 'collector:job1', command: 'run-tests',
        outcome: 'pass', artifactRefs: [],
      };
      return true;
    });
    const payload: CheckRunPayload = {
      v: 1, checkJobId: 'job1', candidateSha: sha, command: 'run-tests',
      timeoutMs: 60_000, deadlineAt: FAR, collectorToken: collector.token,
      mirror: { remote: pathToFileURL(repo).href },
    };
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'],
      fetch: collector.fetchImpl as typeof fetch, dockerBin: docker.bin,
    };
    await assert.rejects(
      runCheckExecution(checkJob(payload as unknown as Record<string, unknown>), options),
      (err: unknown) => err instanceof CheckExecutionError && err.code === 'collector-rejected',
    );
    const state = await collector.store.read();
    assert.equal(Object.keys(state.receipts).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collector forgery without the job token is rejected before any run', async () => {
  const root = tmpRoot();
  try {
    const { repo, sha } = gitRepo(root);
    const docker = fakeDocker(root);
    const collector = await collectorFixture({ candidateSha: sha });
    const payload: CheckRunPayload = {
      v: 1, checkJobId: 'job1', candidateSha: sha, command: 'run-tests',
      timeoutMs: 60_000, deadlineAt: FAR, collectorToken: 'cjob_wrong-token',
      mirror: { remote: pathToFileURL(repo).href },
    };
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'],
      fetch: collector.fetchImpl as typeof fetch, dockerBin: docker.bin,
    };
    await assert.rejects(
      runCheckExecution(checkJob(payload as unknown as Record<string, unknown>), options),
      (err: unknown) => err instanceof CheckExecutionError && err.code === 'collector-rejected',
    );
    assert.equal((await collector.store.read()).jobs.job1.status, 'dispatched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-project jobs are refused before docker or the collector is touched', async () => {
  const root = tmpRoot();
  try {
    const docker = fakeDocker(root);
    let fetchCalls = 0;
    const payload: CheckRunPayload = {
      v: 1, checkJobId: 'job1', candidateSha: 'a'.repeat(40), command: 'run-tests',
      timeoutMs: 60_000, deadlineAt: FAR, collectorToken: 't',
    };
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'],
      fetch: (async () => { fetchCalls += 1; return new Response('ok'); }) as typeof fetch,
      dockerBin: docker.bin,
    };
    await assert.rejects(
      runCheckExecution(checkJob(payload as unknown as Record<string, unknown>, { projectId: 'p2' }), options),
      (err: unknown) => err instanceof CheckExecutionError && err.code === 'project-not-allowed',
    );
    assert.equal(fetchCalls, 0);
    assert.equal(existsSync(docker.recordFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing collector token fails the payload before any external effect', async () => {
  const root = tmpRoot();
  try {
    const docker = fakeDocker(root);
    const payload = {
      v: 1, checkJobId: 'job1', candidateSha: 'a'.repeat(40), command: 'run-tests',
      timeoutMs: 60_000, deadlineAt: FAR,
    };
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'], dockerBin: docker.bin,
    };
    await assert.rejects(
      runCheckExecution(checkJob(payload as Record<string, unknown>), options),
      (err: unknown) => err instanceof CheckExecutionError && err.code === 'invalid-payload',
    );
    assert.equal(existsSync(docker.recordFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unavailable candidate snapshot reports blocked to the real collector', async () => {
  const root = tmpRoot();
  try {
    const sha = 'c'.repeat(40);
    const docker = fakeDocker(root);
    const collector = await collectorFixture({ candidateSha: sha });
    const payload: CheckRunPayload = {
      v: 1, checkJobId: 'job1', candidateSha: sha, command: 'run-tests',
      timeoutMs: 60_000, deadlineAt: FAR, collectorToken: collector.token,
      // no mirror remote: the owned mirror cannot obtain the sha
    };
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'],
      fetch: collector.fetchImpl as typeof fetch, dockerBin: docker.bin,
    };
    const result = await runCheckExecution(checkJob(payload as unknown as Record<string, unknown>), options);
    assert.equal(result.collectorAccepted, true);
    assert.equal(result.outcome, 'blocked');
    assert.equal((await collector.store.read()).jobs.job1.status, 'blocked');
    // Docker was never invoked -- an honest blocked report, not a faked run.
    assert.equal(existsSync(docker.recordFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a deadline already exceeded reports error without running docker', async () => {
  const root = tmpRoot();
  try {
    const sha = 'd'.repeat(40);
    const docker = fakeDocker(root);
    const collector = await collectorFixture({ candidateSha: sha });
    const payload: CheckRunPayload = {
      v: 1, checkJobId: 'job1', candidateSha: sha, command: 'run-tests',
      timeoutMs: 60_000, deadlineAt: '2000-01-01T00:00:00.000Z', collectorToken: collector.token,
    };
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'],
      fetch: collector.fetchImpl as typeof fetch, dockerBin: docker.bin,
    };
    const result = await runCheckExecution(checkJob(payload as unknown as Record<string, unknown>), options);
    assert.equal(result.outcome, 'error');
    assert.equal(result.timedOut, true);
    assert.equal(existsSync(docker.recordFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check.cancel force-removes only the bound check container', async () => {
  const root = tmpRoot();
  try {
    const docker = fakeDocker(root);
    const options: BridgeOptions = {
      root, apiUrl: 'https://cloud.test', projectIds: ['p1'], dockerBin: docker.bin,
    };
    const job = checkJob({ v: 1, checkJobId: 'job1' }, { action: 'check.cancel', key: 'check.cancel:job1' });
    const result = await runCheckExecution(job, options);
    assert.equal(result.removed, true);
    const argvLog = readFileSync(docker.recordFile, 'utf8');
    assert.match(argvLog, /rm -f together-check-job1/);
    assert.equal(argvLog.includes('together-check-job2'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
