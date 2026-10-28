// Lane c-swe-06 evidence: real local Git execution of the companion
// bridge executor plus the cloud git-service's broker-absent and
// result-mapping behavior.
//   node --test tests/c-swe-06.test.ts   (Node >=22.18 type stripping)
//
// Receipt class: REAL LOCAL GIT (bare file-path remotes confined to the
// test root; no network, cloud runtime, Docker or provider calls). The
// c-swe-07 broker and c-swe-05 capability helper are absent seams —
// asserted honestly, not faked.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ApiError, createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { runGit } from '../adapters/local-git.ts';
import {
  CANDIDATE_REF_PREFIX, runGitExecution,
} from '../companion/git-executor.ts';
import type { GitExecutorOptions } from '../companion/git-executor.ts';
import {
  buildGitJobPayload, createCloudGitService, mapGitBrokerResult,
} from '../cloud/git-service.ts';
import type { ExecutionJob } from '../cloud/phase04-contract.ts';
import type { DirectoryProjectRecord } from '../cloud/phase04-contract.ts';
import type { ProjectState } from '../lib/types.ts';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' });
} catch {
  hasGit = false;
}
const it = hasGit ? test : test.skip;

const T0 = '2026-10-04T00:00:00.000Z';
let seq = 0;
const SENTINEL = 'c6-sentinel-capability-plaintext';

async function git(repo: string, args: string[]): Promise<string> {
  const res = await runGit(repo, args);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

const IDENT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid'];

interface Fx {
  root: string;
  canonical: string;
  forkA: string;
  forkB: string;
  base: string;
  headA: string;
  headB: string;
  headC: string;
  headO: string;
}

async function buildFixture(): Promise<Fx> {
  const root = mkdtempSync(join(process.cwd(), '.c6fx-'));
  const remotes = join(root, 'remotes');
  mkdirSync(remotes, { recursive: true });
  const canonical = join(remotes, 'canonical.git');
  const forkA = join(remotes, 'fork-a.git');
  const forkB = join(remotes, 'fork-b.git');
  for (const r of [canonical, forkA, forkB]) {
    await git(root, ['init', '--bare', '--template=', r]);
    // Mirror what permissive servers do for direct-SHA fallback fetches.
    await git(r, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  }
  const seed = join(root, 'seed');
  await git(root, ['init', '--template=', '-b', 'together-cloud', seed]);
  writeFileSync(join(seed, 'a.txt'), '0\n');
  writeFileSync(join(seed, 'b.txt'), '0\n');
  await git(seed, ['add', '.']);
  await git(seed, [...IDENT, 'commit', '-m', 'base']);
  const base = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', canonical, 'HEAD:refs/heads/together-cloud']);

  await git(seed, ['checkout', '-b', 'pa']);
  writeFileSync(join(seed, 'a.txt'), '7\n');
  await git(seed, ['add', '.']);
  await git(seed, [...IDENT, 'commit', '-m', 'a']);
  const headA = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', forkA, 'HEAD:refs/heads/proposal-a']);

  await git(seed, ['checkout', 'together-cloud']);
  await git(seed, ['checkout', '-b', 'pb']);
  writeFileSync(join(seed, 'b.txt'), '6\n');
  await git(seed, ['add', '.']);
  await git(seed, [...IDENT, 'commit', '-m', 'b']);
  const headB = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', forkB, 'HEAD:refs/heads/proposal-b']);

  await git(seed, ['checkout', 'together-cloud']);
  await git(seed, ['checkout', '-b', 'pc']);
  writeFileSync(join(seed, 'a.txt'), '9\n');
  await git(seed, ['add', '.']);
  await git(seed, [...IDENT, 'commit', '-m', 'c']);
  const headC = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', forkA, 'HEAD:refs/heads/proposal-c']);

  // Orphan head: does NOT descend from the recorded base.
  await git(seed, ['checkout', '--orphan', 'orphan']);
  await git(seed, ['rm', '-rf', '--quiet', '.']);
  writeFileSync(join(seed, 'x.txt'), 'x\n');
  await git(seed, ['add', '.']);
  await git(seed, [...IDENT, 'commit', '-m', 'orphan']);
  const headO = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', forkB, 'HEAD:refs/heads/orphan']);

  return { root, canonical, forkA, forkB, base, headA, headB, headC, headO };
}

function recordFor(fx: Fx): DirectoryProjectRecord {
  return {
    id: 'p1', ownerId: 'owner-1', goal: 'g', createdAt: T0,
    repositoryId: 'canonical', remote: fx.canonical,
    canonicalRef: 'refs/heads/together-cloud',
    provisioning: 'ready', operationId: 'op-0', digest: 'd',
  };
}

function optionsFor(fx: Fx): GitExecutorOptions {
  return {
    root: fx.root,
    apiUrl: 'https://worker.test',
    projectIds: ['p1'],
    allowFileTransport: true, // TEST-ONLY: file remotes confined to fx.root.
  };
}

function cap(repositoryId: string, remote: string, secret = SENTINEL) {
  return { repositoryId, remote, plaintext: `${secret}-${repositoryId}`, expiresAt: '2099-01-01T00:00:00.000Z' };
}

function capsFor(fx: Fx) {
  return {
    canonical: cap('canonical', fx.canonical),
    forks: {
      'fork-a': cap('fork-a', fx.forkA),
      'fork-b': cap('fork-b', fx.forkB),
    },
  };
}

function jobFor(action: ExecutionJob['action'], payload: Record<string, unknown>, extra: Partial<ExecutionJob> = {}): ExecutionJob {
  return {
    id: `job-${++seq}`, key: `key-${seq}`, projectId: 'p1', role: 'git',
    action, payload, deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    digest: 'd', status: 'leased', ...extra,
  };
}

const errIs = (status: number, code?: string) => (err: unknown) => {
  const e = err as { status?: number; code?: string };
  return e.status === status && (code === undefined || e.code === code);
};

const proposalsPayload = (fx: Fx, list: { id: string; head: string; base?: string; repo?: string }[]) =>
  list.map((p) => ({ id: p.id, head: p.head, base: p.base ?? fx.base, authorId: 'agent-x', repositoryId: p.repo }));

// ---------------------------------------------------------------------------

it('git.prepare merges real fork heads, pins refs/candidates/<op> locally and remotely, deterministically', async (t) => {
  const fx = await buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const opts = optionsFor(fx);
  const fields = {
    operationId: 'op-merge-1', base: fx.base,
    proposals: proposalsPayload(fx, [
      { id: 'pa', head: fx.headA, repo: 'fork-a' },
      { id: 'pb', head: fx.headB, repo: 'fork-b' },
    ]),
  };
  const payload = buildGitJobPayload({ record: recordFor(fx), fields, ...capsFor(fx) });
  const res = await runGitExecution(jobFor('git.prepare', payload), opts);
  const sha = String(res.sha);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.deepEqual([...(res.changedPaths as string[])].sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(res.proposalHeads, { pa: fx.headA, pb: fx.headB });
  assert.equal(res.candidateRef, `${CANDIDATE_REF_PREFIX}op-merge-1`);
  assert.equal(res.remoteCandidatePushed, true);

  // Reachable on BOTH the mirror and the canonical remote.
  const mirror = join(fx.root, 'git-mirror', 'p1');
  assert.equal(await git(mirror, ['rev-parse', `${CANDIDATE_REF_PREFIX}op-merge-1`]), sha);
  assert.equal(await git(fx.canonical, ['rev-parse', `refs/candidates/op-merge-1^{commit}`]), sha);
  // Canonical tip itself untouched.
  assert.equal(await git(fx.canonical, ['rev-parse', 'refs/heads/together-cloud']), fx.base);

  // Deterministic: identical inputs -> identical SHA (real dedupe).
  const again = await runGitExecution(jobFor('git.prepare', buildGitJobPayload({
    record: recordFor(fx),
    fields: { ...fields, operationId: 'op-merge-2' },
    ...capsFor(fx),
  })), opts);
  assert.equal(again.sha, sha);
});

it('git.prepare reports real conflicts and produces no SHA/ref', async (t) => {
  const fx = await buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const payload = buildGitJobPayload({
    record: recordFor(fx),
    fields: {
      operationId: 'op-conflict', base: fx.base,
      proposals: proposalsPayload(fx, [
        { id: 'pa', head: fx.headA, repo: 'fork-a' },
        { id: 'pc', head: fx.headC, repo: 'fork-a' },
      ]),
    },
    ...capsFor(fx),
  });
  const res = await runGitExecution(jobFor('git.prepare', payload), optionsFor(fx));
  assert.equal(res.sha, '');
  const conflicts = res.conflicts as { path: string; proposalIds: string[] }[];
  assert.equal(conflicts[0].path, 'a.txt');
  assert.deepEqual(conflicts[0].proposalIds, ['pc']);
  // No candidate ref leaked onto the remote.
  const ls = await runGit(fx.canonical, ['ls-remote', fx.canonical, 'refs/candidates/op-conflict']);
  assert.equal(ls.stdout.trim(), '');
});

it('git.prepare rejects a head that does not descend from its recorded base', async (t) => {
  const fx = await buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const payload = buildGitJobPayload({
    record: recordFor(fx),
    fields: {
      operationId: 'op-orphan', base: fx.base,
      proposals: proposalsPayload(fx, [{ id: 'po', head: fx.headO, repo: 'fork-b' }]),
    },
    ...capsFor(fx),
  });
  await assert.rejects(
    runGitExecution(jobFor('git.prepare', payload), optionsFor(fx)),
    errIs(422, 'invalid_base'),
  );
});

it('git.push lands only behind the expected-tip lease, journals pre+post, remote readback verified', async (t) => {
  const fx = await buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const opts = optionsFor(fx);
  const prep = await runGitExecution(jobFor('git.prepare', buildGitJobPayload({
    record: recordFor(fx),
    fields: {
      operationId: 'op-p1', base: fx.base,
      proposals: proposalsPayload(fx, [{ id: 'pa', head: fx.headA, repo: 'fork-a' }]),
    },
    ...capsFor(fx),
  })), opts);
  const candidate = String(prep.sha);

  const pushPayload = (expectedTip: string, op: string) => buildGitJobPayload({
    record: recordFor(fx),
    fields: { operationId: op, ref: 'refs/heads/together-cloud', expectedTip, candidateTip: candidate },
    ...capsFor(fx),
  });

  // Stale lease: remote stays at base.
  const stale = await runGitExecution(jobFor('git.push', pushPayload(fx.headB, 'op-stale')), opts);
  assert.equal(stale.effect, 'no-effect');
  assert.equal(await git(fx.canonical, ['rev-parse', 'refs/heads/together-cloud']), fx.base);

  // Correct lease: the ref moves exactly to the candidate.
  const ok = await runGitExecution(jobFor('git.push', pushPayload(fx.base, 'op-ok')), opts);
  assert.equal(ok.effect, 'updated');
  assert.equal(ok.reportStatus, 'expected-tip-lease-held');
  assert.equal(await git(fx.canonical, ['rev-parse', 'refs/heads/together-cloud']), candidate);

  // Same push again: no-effect, not "updated".
  const again = await runGitExecution(jobFor('git.push', pushPayload(fx.base, 'op-ok2')), opts);
  assert.equal(again.effect, 'no-effect');
  assert.equal(again.reportStatus, 'already-at-candidate-tip');

  // Journal: intent persisted BEFORE the push and outcome after; no secrets.
  const journal = readFileSync(join(fx.root, 'journal', 'p1.ndjson'), 'utf8');
  const entries = journal.trim().split('\n').map((l) => JSON.parse(l) as { phase: string; effect?: string });
  const pre = entries.findIndex((e) => e.phase === 'pre' );
  const post = entries.findIndex((e) => e.phase === 'post' && e.effect === 'updated');
  assert.ok(pre >= 0 && post > pre, 'journal lacks ordered pre/post push entries');
  assert.equal(journal.includes(SENTINEL), false);

  // A push to a non-canonical ref is refused outright.
  await assert.rejects(
    runGitExecution(jobFor('git.push', buildGitJobPayload({
      record: recordFor(fx),
      fields: { operationId: 'op-evil', ref: 'refs/heads/main', expectedTip: fx.base, candidateTip: candidate },
      ...capsFor(fx),
    })), opts),
    errIs(422, 'ref_not_canonical'),
  );
});

it('git.readTip and git.isAncestor answer from the real remote/mirror', async (t) => {
  const fx = await buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const opts = optionsFor(fx);
  const base = { record: recordFor(fx), ...capsFor(fx) };

  const tip = await runGitExecution(jobFor('git.readTip', buildGitJobPayload({
    ...base, fields: { ref: 'refs/heads/together-cloud' },
  })), opts);
  assert.equal(tip.tip, fx.base);

  await assert.rejects(
    runGitExecution(jobFor('git.readTip', buildGitJobPayload({
      ...base, fields: { ref: 'refs/heads/other' },
    })), opts),
    errIs(422, 'ref_not_canonical'),
  );

  const anc = await runGitExecution(jobFor('git.isAncestor', buildGitJobPayload({
    ...base, fields: { oldTip: fx.base, newTip: fx.headA },
  })), opts);
  assert.equal(anc.isAncestor, true);
  const notAnc = await runGitExecution(jobFor('git.isAncestor', buildGitJobPayload({
    ...base, fields: { oldTip: fx.headA, newTip: fx.base },
  })), opts);
  assert.equal(notAnc.isAncestor, false);
});

it('executor validates payload/project/remote before any effect', async (t) => {
  const fx = await buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const opts = optionsFor(fx);
  const good = buildGitJobPayload({
    record: recordFor(fx), fields: { ref: 'refs/heads/together-cloud' }, ...capsFor(fx),
  });

  // Project allowlist and payload/job agreement.
  await assert.rejects(runGitExecution(
    jobFor('git.readTip', good, { projectId: 'p2' }), opts), errIs(403, 'project_not_allowed'));
  await assert.rejects(runGitExecution(
    jobFor('git.readTip', { ...good, projectId: 'p9' }), opts), errIs(422, 'project_mismatch'));

  // Bad SHA in payload fails before any subprocess outcome.
  await assert.rejects(runGitExecution(jobFor('git.isAncestor', buildGitJobPayload({
    record: recordFor(fx), fields: { oldTip: 'abc', newTip: 'b'.repeat(40) }, ...capsFor(fx),
  })), opts), errIs(422));

  // Non-https remote is rejected without the test-only escape hatch.
  const prodOpts = { ...opts, allowFileTransport: false };
  await assert.rejects(runGitExecution(jobFor('git.readTip', good), prodOpts),
    errIs(422, 'remote_not_allowed'));
  const sshPayload = buildGitJobPayload({
    record: { ...recordFor(fx), remote: 'ssh://git@x/y' },
    fields: { ref: 'refs/heads/together-cloud' },
    canonical: cap('canonical', 'ssh://git@x/y'),
  });
  await assert.rejects(runGitExecution(jobFor('git.readTip', sshPayload), opts),
    errIs(422, 'remote_not_allowed'));

  // Traversal project id cannot escape the mirror root.
  await assert.rejects(runGitExecution(
    jobFor('git.readTip', { ...good, projectId: '../evil' }, { projectId: '../evil' }),
    { ...opts, projectIds: ['../evil', 'p1'] }), errIs(422));

  // An expired push deadline never dispatches.
  const expired = await runGitExecution(jobFor('git.push', buildGitJobPayload({
    record: recordFor(fx),
    fields: {
      operationId: 'op-exp', ref: 'refs/heads/together-cloud',
      expectedTip: fx.base, candidateTip: 'f'.repeat(40),
    },
    ...capsFor(fx),
  }), { deadlineAt: '2020-01-01T00:00:00.000Z' }), opts);
  assert.equal(expired.effect, 'no-effect');
  assert.equal(expired.reportStatus, 'expired-before-dispatch');
});

it('capability plaintext never reaches results, journal, or mirror config', async (t) => {
  const fx = await buildFixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const opts = optionsFor(fx);
  const res = await runGitExecution(jobFor('git.prepare', buildGitJobPayload({
    record: recordFor(fx),
    fields: {
      operationId: 'op-hyg', base: fx.base,
      proposals: proposalsPayload(fx, [{ id: 'pa', head: fx.headA, repo: 'fork-a' }]),
    },
    ...capsFor(fx),
  })), opts);
  assert.equal(JSON.stringify(res).includes(SENTINEL), false);
  const journalFile = join(fx.root, 'journal', 'p1.ndjson');
  if (existsSync(journalFile)) {
    assert.equal(readFileSync(journalFile, 'utf8').includes(SENTINEL), false);
  }
  const mirrorConfig = readFileSync(join(fx.root, 'git-mirror', 'p1', 'config'), 'utf8');
  assert.equal(mirrorConfig.includes(SENTINEL), false);
  // Remotes are never persisted into mirror config — URLs + tokens stay out.
  const cfg = await runGit(join(fx.root, 'git-mirror', 'p1'), ['config', '--local', '--list']);
  assert.equal(/^remote\./m.test(cfg.stdout), false);
});

// ---------------------------------------------------------------------------
// broker mapping + cloud-side seams (no c-swe-05/07 modules in this seat)
// ---------------------------------------------------------------------------

test('mapGitBrokerResult: push ambiguity is reconcile-only, never a silent retry signal', () => {
  const job = (over: Partial<ExecutionJob>): ExecutionJob => ({
    id: 'j', key: 'k', projectId: 'p1', role: 'git', action: 'git.push',
    payload: {}, deadlineAt: T0, digest: 'd', status: 'completed', ...over,
  });
  assert.deepEqual(mapGitBrokerResult('git.push', job({ result: { ended: true, effect: 'updated' } })),
    { ended: true, effect: 'updated' });
  // Pre-effect rejection -> provably no effect.
  assert.deepEqual(
    mapGitBrokerResult('git.push', job({ status: 'failed', error: { code: 'invalid_ref', message: 'x' } })),
    { ended: true, effect: 'no-effect', reportStatus: 'rejected:invalid_ref' });
  // Timeout/ambiguous failure -> unknown, ended false.
  const unknown = mapGitBrokerResult('git.push', job({ status: 'failed', error: { code: 'git_timeout', message: 'x' } })) as { ended: boolean; effect: string };
  assert.equal(unknown.ended, false);
  assert.equal(unknown.effect, 'unknown');
  const leased = mapGitBrokerResult('git.push', job({ status: 'leased' })) as { ended: boolean; effect: string };
  assert.equal(leased.ended, false);
  assert.equal(leased.effect, 'unknown');
  // Non-push failures map to honest typed errors.
  assert.throws(
    () => mapGitBrokerResult('git.readTip', job({ action: 'git.readTip', status: 'failed', error: { code: 'ref_not_found', message: 'gone' } })),
    errIs(404, 'ref_not_found'));
  assert.throws(
    () => mapGitBrokerResult('git.prepare', job({ action: 'git.prepare', status: 'leased' })),
    errIs(503, 'git_unavailable'));
});

test('payload builder keeps transport secrets under transport and binds the project', () => {
  const payload = buildGitJobPayload({
    record: {
      id: 'p1', ownerId: 'o', goal: 'g', createdAt: T0,
      repositoryId: 'repo-1', remote: 'https://artifacts.test/repo-1',
      canonicalRef: 'refs/heads/together-cloud',
      provisioning: 'ready', operationId: 'op0', digest: 'd',
    },
    fields: { ref: 'refs/heads/together-cloud', operationId: 'op-x' },
    canonical: { repositoryId: 'repo-1', remote: 'https://artifacts.test/repo-1', plaintext: SENTINEL, expiresAt: T0 },
    forks: { 'fork-9': { repositoryId: 'fork-9', remote: 'https://artifacts.test/fork-9', plaintext: `${SENTINEL}-f`, expiresAt: T0 } },
  });
  assert.equal(payload.projectId, 'p1');
  assert.equal(payload.repositoryId, 'repo-1');
  assert.equal(payload.canonicalRef, 'refs/heads/together-cloud');
  const transport = payload.transport as { canonical: { plaintext: string }; forks: Record<string, { plaintext: string; repositoryId: string }> };
  assert.equal(transport.canonical.plaintext, SENTINEL);
  assert.equal(transport.forks['fork-9'].repositoryId, 'fork-9');
  // Secret material exists ONLY inside payload.transport.
  const publicPart = { ...payload, transport: undefined };
  assert.equal(JSON.stringify(publicPart).includes(SENTINEL), false);
});

test('createCloudGitService reports honest git_unavailable when the broker seam is absent', async () => {
  const store = new MemoryStore(createState({ id: 'p1', goal: 'g', mode: 'live', now: T0 }));
  const git = createCloudGitService({
    env: {}, // no EXECUTION_OBJECT; lane c-swe-07 module absent in this seat
    record: {
      id: 'p1', ownerId: 'o', goal: 'g', createdAt: T0,
      repositoryId: 'repo-1', remote: 'https://artifacts.test/repo-1',
      canonicalRef: 'refs/heads/together-cloud',
      provisioning: 'ready', operationId: 'op0', digest: 'd',
    },
    state: () => store.read(),
  });
  await assert.rejects(git.readTip('refs/heads/together-cloud'), errIs(503, 'git_unavailable'));
  await assert.rejects(
    git.isAncestor('a'.repeat(40), 'b'.repeat(40)), errIs(503, 'git_unavailable'));
  // A push cannot fabricate success either.
  const push = await git.push({
    ref: 'refs/heads/together-cloud',
    expectedTip: 'a'.repeat(40), candidateTip: 'b'.repeat(40), operationId: 'op-nope',
  }).then(
    (r) => r,
    (e) => e as ApiError,
  );
  assert.ok(
    (push instanceof ApiError && push.status === 503) ||
    (typeof push === 'object' && (push as { effect?: string }).effect === 'unknown'),
  );
});
