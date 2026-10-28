// Lane r-swe-02 regression tests (worker seat-01): artifacts adapter disposal
// boundaries and local-Git concurrent expected-tip CAS reporting.
// Real local Git evidence only; the artifacts side uses doc-shaped fixtures —
// no cloud calls, no provider, no deployment.
//
// node --test tests/r-swe-02.test.ts

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LocalGitService, runGit } from '../adapters/local-git.ts';
import { createArtifactsAdapter } from '../lib/artifacts.ts';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' });
} catch {
  hasGit = false;
}
const fixtureTest = hasGit ? test : test.skip;

const GIT_ENV = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid'];

async function g(repo: string, args: string[]): Promise<string> {
  const res = await runGit(repo, args);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
  return res.stdout.trim();
}

interface Fixture { root: string; repo: string; base: string; moved: string }

async function buildRepo(root: string): Promise<{ repo: string; base: string; moved: string }> {
  const repo = join(root, 'repo');
  await runGit(root, ['init', '--template=', '-b', 'main', 'repo']).then((r) => {
    if (r.code !== 0) throw new Error(r.stderr);
  });
  writeFileSync(join(repo, 'f.txt'), 'base\n');
  await g(repo, ['add', '.']);
  await g(repo, [...GIT_ENV, 'commit', '-m', 'base']);
  const base = await g(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'f.txt'), 'moved\n');
  await g(repo, ['add', '.']);
  await g(repo, [...GIT_ENV, 'commit', '-m', 'sibling move']);
  const moved = await g(repo, ['rev-parse', 'HEAD']);
  // Park the sibling tip on a side ref, leave main at base.
  await g(repo, ['update-ref', 'refs/heads/sibling', moved]);
  await g(repo, ['update-ref', 'refs/heads/main', base]);
  return { repo, base, moved };
}

/**
 * A gitBin wrapper that delegates everything to real git except update-ref,
 * which fails deterministically (a transient lock-failure stand-in). This is
 * the only way to observe the CAS-failure/read-back branch where the ref is
 * still at the expected tip.
 */
function failUpdateRefGit(root: string): string {
  const script = join(root, 'gitwrap.sh');
  writeFileSync(script, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "update-ref" ]; then
    echo "fatal: simulated transient update-ref failure" >&2
    exit 1
  fi
done
exec git "$@"
`);
  chmodSync(script, 0o755);
  return script;
}

// --- r-swe-02 F1: concurrent expected-tip CAS reporting --------------------

fixtureTest('push CAS conflict: moved tip reported tip-moved, unchanged tip not mislabeled', async (t) => {
  const root = mkdtempSync(join(process.cwd(), '.rswe02-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base, moved } = await buildRepo(root);
  const svc = new LocalGitService({ repo, workRoot: join(root, 'work') });
  t.after(() => svc.dispose());

  // Candidate: a commit descending from the expected tip.
  await g(repo, ['update-ref', 'refs/heads/cand', base]);
  writeFileSync(join(repo, 'c.txt'), 'cand\n');
  await g(repo, ['checkout', '-q', '-b', 'candwork', base]);
  await g(repo, ['add', '.']);
  await g(repo, [...GIT_ENV, 'commit', '-m', 'candidate']);
  const candidate = await g(repo, ['rev-parse', 'HEAD']);

  // Concurrent actor moved the canonical ref between read and CAS: the
  // expectedTip lease is stale, and the report must say so honestly.
  await g(repo, ['update-ref', 'refs/heads/main', moved]);
  const stale = await svc.push({
    ref: 'refs/heads/main', expectedTip: base, candidateTip: candidate, operationId: 'op-stale',
  });
  assert.equal(stale.ended, true);
  assert.equal(stale.effect, 'no-effect');
  assert.equal(stale.reportStatus, `tip-moved:${moved}`);
  assert.equal(await svc.readTip('refs/heads/main'), moved);

  // update-ref fails transiently while the ref still holds the expected tip:
  // the report must NOT claim an expected-tip mismatch (the lease holds; a
  // retry with the same expectedTip can still succeed).
  // Restore the canonical ref to the expected tip so the CAS precondition
  // holds at read-back; only the update itself fails.
  await g(repo, ['update-ref', 'refs/heads/main', base]);
  const flaky = new LocalGitService({
    repo, workRoot: join(root, 'work2'), gitBin: failUpdateRefGit(root),
  });
  t.after(() => flaky.dispose());
  const transient = await flaky.push({
    ref: 'refs/heads/main', expectedTip: base, candidateTip: candidate, operationId: 'op-tr',
  });
  assert.equal(transient.ended, true);
  assert.equal(transient.effect, 'no-effect');
  assert.equal(transient.reportStatus, 'update-failed-tip-unchanged');
  assert.equal(await svc.readTip('refs/heads/main'), base);
});

// --- r-swe-02 F2: adapter disposal boundary (fixture) ----------------------

test('artifacts: disposing while get() is in flight still releases the capability once', async () => {
  let disposeCount = 0;
  let releaseGet: ((cap: unknown) => void) | undefined;
  const cap = {
    async info() { return { id: 'r', name: 'demo', status: 'ready' }; },
    async readFile() { return null; },
    async log() { return []; },
    [Symbol.dispose]() { disposeCount += 1; },
  };
  const ns = {
    get(): Promise<unknown> {
      return new Promise((resolve) => { releaseGet = resolve; });
    },
  };
  const adapter = createArtifactsAdapter({ namespace: ns as never, repo: 'demo' });
  const inflight = adapter.info(); // get() is pending
  await Promise.resolve(); // let capability() invoke ns.get so releaseGet is bound
  adapter[Symbol.dispose]();
  releaseGet!(cap); // late-arriving capability
  // The in-flight call may complete (it raced disposal); what matters is the
  // late-arriving capability is still released exactly once.
  await inflight;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(disposeCount, 1);
});
