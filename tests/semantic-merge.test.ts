// Real local-Git evidence for seat b-swe-04 (receipt class: real local Git).
// A disposable repo is built under the scratch workspace; two proposal
// branches each pass the frozen check alone, their clean merge fails it —
// Ready stays false. No cloud, no remote, no shell strings.
// node --test tests/semantic-merge.test.ts

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { handleChanges } from '../lib/changes.ts';
import { handleIntegration, readiness } from '../lib/integration.ts';
import { ApiError, createState, errorResponse, json } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { LocalGitService, runGit } from '../adapters/local-git.ts';
import type { Candidate, Context, Principal } from '../lib/types.ts';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' });
} catch {
  hasGit = false;
}

const t0 = '2026-10-04T00:00:00.000Z';
const now = () => t0;
let seq = 0;
const uid = () => `id-${++seq}`;
const principal: Principal = {
  id: 'user-1', sessionId: 'sess-1', kind: 'human', ownerId: 'user-1',
  scopes: ['admin', 'read', 'changes:write', 'integrate'], projectIds: ['p1'],
};

const GIT_ENV = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid'];

const CHECK_MJS = `import { readFileSync } from 'node:fs';
const a = Number(readFileSync('a.txt', 'utf8').trim());
const b = Number(readFileSync('b.txt', 'utf8').trim());
if (a + b > 10) { console.error('sum ' + (a + b) + ' exceeds limit 10'); process.exit(1); }
console.log('sum ' + (a + b) + ' within limit');
`;

interface Fixture {
  root: string;
  repo: string;
  base: string;
  headA: string;
  headB: string;
  headC: string;
}

async function git(repo: string, args: string[]): Promise<string> {
  const res = await runGit(repo, args);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function commitFile(repo: string, file: string, content: string, message: string) {
  writeFileSync(join(repo, file), content);
  await git(repo, ['add', file]);
  await git(repo, [...GIT_ENV, 'commit', '-m', message]);
}

async function buildFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(process.cwd(), '.gitfixture-'));
  const repo = join(root, 'repo');
  // --template= avoids copying host template hooks into the sandbox.
  await runGit(root, ['init', '--template=', '-b', 'main', 'repo']).then((r) => {
    if (r.code !== 0) throw new Error(r.stderr);
  });
  writeFileSync(join(repo, 'check.mjs'), CHECK_MJS);
  writeFileSync(join(repo, 'a.txt'), '0\n');
  writeFileSync(join(repo, 'b.txt'), '0\n');
  await git(repo, ['add', '.']);
  await git(repo, [...GIT_ENV, 'commit', '-m', 'base']);
  const base = await git(repo, ['rev-parse', 'HEAD']);

  // proposal-a: a.txt = 7 (7 + 0 <= 10 passes alone).
  await git(repo, ['checkout', '-b', 'proposal-a']);
  await commitFile(repo, 'a.txt', '7\n', 'proposal a');
  const headA = await git(repo, ['rev-parse', 'HEAD']);

  // proposal-b: b.txt = 6 (0 + 6 <= 10 passes alone).
  await git(repo, ['checkout', 'main']);
  await git(repo, ['checkout', '-b', 'proposal-b']);
  await commitFile(repo, 'b.txt', '6\n', 'proposal b');
  const headB = await git(repo, ['rev-parse', 'HEAD']);

  // proposal-c: conflicts with A on a.txt (9 vs 7).
  await git(repo, ['checkout', 'main']);
  await git(repo, ['checkout', '-b', 'proposal-c']);
  await commitFile(repo, 'a.txt', '9\n', 'proposal c');
  const headC = await git(repo, ['rev-parse', 'HEAD']);

  await git(repo, ['checkout', 'main']);
  return { root, repo, base, headA, headB, headC };
}

function runCheck(dir: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('node', ['check.mjs'], { cwd: dir }, (err) => {
      resolve(typeof err?.code === 'number' ? err.code : 0);
    });
  });
}

async function checkAt(repo: string, sha: string, dir: string): Promise<number> {
  await git(repo, ['worktree', 'add', '--detach', dir, sha]);
  try {
    return await runCheck(dir);
  } finally {
    await git(repo, ['worktree', 'remove', '--force', dir]);
  }
}

const fixtureTest = hasGit ? test : test.skip;

fixtureTest('clean merge of two individually-passing branches fails the combined check', async (t) => {
  const f = await buildFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const work = join(f.root, 'work');
  const git = new LocalGitService({ repo: f.repo, workRoot: work });
  t.after(() => git.dispose());

  // Each head passes the frozen check alone — real execution.
  assert.equal(await checkAt(f.repo, f.headA, join(work, 'wa')), 0);
  assert.equal(await checkAt(f.repo, f.headB, join(work, 'wb')), 0);

  const prepared = await git.prepare({
    projectId: 'p1', base: f.base,
    proposals: [
      { id: 'pa', head: f.headA },
      { id: 'pb', head: f.headB },
    ],
    operationId: 'op-merge-1',
  });
  assert.match(prepared.sha, /^[0-9a-f]{40}$/);
  assert.equal(prepared.conflicts, undefined);
  assert.deepEqual([...prepared.changedPaths].sort(), ['a.txt', 'b.txt']);
  assert.equal(await git.isAncestor(f.base, prepared.sha), true);
  assert.equal(await git.isAncestor(f.headA, prepared.sha), true);
  assert.equal(await git.isAncestor(f.headB, prepared.sha), true);

  // The clean merge FAILS the frozen check (7 + 6 = 13 > 10).
  assert.equal(await checkAt(f.repo, prepared.sha, join(work, 'wc')), 1);
});

fixtureTest('end-to-end: combined failure keeps Ready false through the API', async (t) => {
  const f = await buildFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const git = new LocalGitService({ repo: f.repo, workRoot: join(f.root, 'work') });
  t.after(() => git.dispose());

  const store = new MemoryStore(createState({ id: 'p1', goal: 'g', mode: 'live', now: t0 }));
  const ctx: Context = { principal, store, now, uid, git };
  const meta = (id: string, actorId = 'user-1') =>
    ({ id, projectId: 'p1', revision: 1, createdAt: t0, updatedAt: t0, actorId });
  await store.transact((draft) => {
    draft.tasks['t1'] = {
      ...meta('t1'), goal: 'feature', acceptanceCriteria: ['sum <= 10'],
      dependencies: [], lifecycle: 'in-progress', resultRefs: [],
    } as never;
    return true;
  });
  const post = () => new Request('https://x.test/', { method: 'POST' });
  const call = async (fn: () => Promise<Response | null>): Promise<Response> => {
    try {
      const res = await fn();
      return res ?? json(404, { error: { code: 'route_not_found' } });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      throw err;
    }
  };

  const paBody = (await (await call(() => handleChanges(ctx, post(), ['changes'], {
    operationId: 'op-pa', taskIds: ['t1'], base: f.base, head: f.headA,
    summary: 'set a=7', intendedBehavior: 'a contribution', changedPaths: ['a.txt'],
  }))).json()) as { proposal: { id: string } };
  const pbBody = (await (await call(() => handleChanges(ctx, post(), ['changes'], {
    operationId: 'op-pb', taskIds: ['t1'], base: f.base, head: f.headB,
    summary: 'set b=6', intendedBehavior: 'b contribution', changedPaths: ['b.txt'],
  }))).json()) as { proposal: { id: string } };

  const res = await call(() => handleChanges(ctx, post(), ['candidates'], {
    operationId: 'op-c1', proposalIds: [paBody.proposal.id, pbBody.proposal.id],
  }));
  assert.equal(res.status, 201);
  const { candidate } = (await res.json()) as { candidate: Candidate };
  assert.match(candidate.sha, /^[0-9a-f]{40}$/);
  assert.equal(candidate.base, f.base);

  // Individually passing evidence never transfers to the combined SHA.
  await store.transact((draft) => {
    draft.jobs['job-a'] = {
      ...meta('job-a', 'system'), candidateId: candidate.id, candidateSha: f.headA,
      command: 'node check.mjs', status: 'completed',
    } as never;
    draft.receipts['rc-a'] = {
      ...meta('rc-a', 'col'), jobId: 'job-a', candidateSha: f.headA, collectorId: 'col',
      command: 'node check.mjs', outcome: 'pass', artifactRefs: [],
    } as never;
    draft.candidates[candidate.id].checkJobIds = ['job-a'];
    return true;
  });
  let state = await store.read();
  assert.equal(readiness(state, state.candidates[candidate.id]).ready, false);

  // The real combined run FAILS: collector records a fail receipt on the
  // exact candidate SHA. Ready remains false and integrate is denied.
  const failCode = await checkAt(f.repo, candidate.sha, join(f.root, 'work', 'wc2'));
  assert.equal(failCode, 1);
  await store.transact((draft) => {
    draft.receipts['rc-fail'] = {
      ...meta('rc-fail', 'col'), jobId: 'job-a', candidateSha: candidate.sha,
      collectorId: 'col', command: 'node check.mjs', outcome: 'fail', artifactRefs: [],
    } as never;
    return true;
  });
  state = await store.read();
  assert.equal(readiness(state, state.candidates[candidate.id]).ready, false);
  const denied = await call(() => handleIntegration(ctx, post(), ['candidates', candidate.id, 'integrate'], {
    operationId: 'op-i1', expectedTip: f.base,
  }));
  assert.equal(denied.status, 422);
});

fixtureTest('conflicting heads report conflicts and produce no SHA', async (t) => {
  const f = await buildFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const git = new LocalGitService({ repo: f.repo, workRoot: join(f.root, 'work') });
  t.after(() => git.dispose());
  const prepared = await git.prepare({
    projectId: 'p1', base: f.base,
    proposals: [{ id: 'pa', head: f.headA }, { id: 'pc', head: f.headC }],
    operationId: 'op-conflict',
  });
  assert.equal(prepared.sha, '');
  assert.ok(prepared.conflicts && prepared.conflicts.length > 0);
  assert.deepEqual(prepared.conflicts![0].path, 'a.txt');
  assert.deepEqual(prepared.conflicts![0].proposalIds, ['pc']);
});

fixtureTest('push enforces the expected tip and ancestor precondition', async (t) => {
  const f = await buildFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const git = new LocalGitService({ repo: f.repo, workRoot: join(f.root, 'work') });
  t.after(() => git.dispose());
  const prepared = await git.prepare({
    projectId: 'p1', base: f.base,
    proposals: [{ id: 'pa', head: f.headA }], operationId: 'op-p',
  });

  // Stale lease: ref is at base, caller expects an unrelated tip.
  const stale = await git.push({
    ref: 'refs/heads/main', expectedTip: f.headC, candidateTip: prepared.sha,
    operationId: 'op-stale',
  });
  assert.equal(stale.effect, 'no-effect');
  assert.equal(await git.readTip('refs/heads/main'), f.base);

  // Expected tip that is not an ancestor of the candidate.
  const notAncestor = await git.push({
    ref: 'refs/heads/main', expectedTip: f.headB, candidateTip: prepared.sha,
    operationId: 'op-na',
  });
  assert.equal(notAncestor.effect, 'no-effect');
  assert.equal(notAncestor.reportStatus, 'expected-tip-not-ancestor');
  assert.equal(await git.readTip('refs/heads/main'), f.base);

  // Correct lease updates exactly once.
  const ok = await git.push({
    ref: 'refs/heads/main', expectedTip: f.base, candidateTip: prepared.sha,
    operationId: 'op-ok',
  });
  assert.equal(ok.effect, 'updated');
  assert.equal(await git.readTip('refs/heads/main'), prepared.sha);

  // The same push again reports no-effect, not "updated".
  const again = await git.push({
    ref: 'refs/heads/main', expectedTip: f.base, candidateTip: prepared.sha,
    operationId: 'op-ok',
  });
  assert.equal(again.effect, 'no-effect');
});

fixtureTest('SHA/ref validation rejects garbage before any subprocess runs', async (t) => {
  const f = await buildFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const git = new LocalGitService({ repo: f.repo, workRoot: join(f.root, 'work') });
  t.after(() => git.dispose());
  const marker = join(f.root, 'PWNED');

  await assert.rejects(
    git.prepare({
      projectId: 'p1', base: 'main; touch PWNED',
      proposals: [{ id: 'pa', head: f.headA }], operationId: 'op-x',
    }),
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'invalid_sha',
  );
  await assert.rejects(
    git.readTip('main'), // not a refs/ name
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'invalid_ref',
  );
  await assert.rejects(
    git.push({
      ref: 'refs/heads/../escape', expectedTip: f.base, candidateTip: f.headA,
      operationId: 'op-x',
    }),
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'invalid_ref',
  );
  await assert.rejects(
    git.prepare({
      projectId: 'p1', base: f.base,
      proposals: [{ id: 'p a;id', head: f.headA }], operationId: 'op-x',
    }),
    (err: { status: number; code: string }) => err.status === 422 && err.code === 'invalid_id',
  );
  // No shell was involved; the injection string executed nothing.
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(marker), false);
});
