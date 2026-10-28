// Lane c-swe-10 unit evidence: the cloud acceptance driver
// (scripts/cloud-acceptance.ts) plus the original-risk adversarial and
// recovery cases from the phase04 spec, exercised against the frozen local
// seams.
//
//   - runAcceptance is driven against the REAL createLocalApi composition
//     through an injected fetch: the HTTP protocol, auth, idempotency and
//     adversarial denials are exercised end to end without a network.
//   - The git scenario wires a real local repository; Docker is replaced
//     by a clearly labeled executable fixture that records argv and runs
//     the command in the mounted dir. That proves wiring + real git
//     effects, never container isolation.
//   - Other-lane cloud seams (cloud/directory.ts, sessions.ts,
//     execution.ts, companion/*, wrangler.cloud.jsonc) do not exist in
//     this packet; the driver records them 'unavailable', never 'pass'.
//
// Runs with: node --experimental-strip-types --test tests/c-swe-10.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../cloud/app.ts';
import { createLocalApi } from '../cloud/local-server.ts';
import { createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { authenticate, handleIdentity, hashToken } from '../lib/identity.ts';
import { authenticateCollector, handleChecks } from '../lib/checks.ts';
import { handleAssignments } from '../lib/assignments.ts';
import { handleChanges } from '../lib/changes.ts';
import { handleIntegration, reconcileTip } from '../lib/integration.ts';
import { handleFindings } from '../lib/findings.ts';
import { handleReviews } from '../lib/reviews.ts';
import { handleInbox } from '../lib/inbox.ts';
import { handleEvents } from '../lib/events.ts';
import { LocalGitService } from '../adapters/local-git.ts';
import {
  ConfigError, assertSafeProjectId, exitCodeFor, loadConfig, redactDeep,
  runAcceptance, validateApiUrl,
} from '../scripts/cloud-acceptance.ts';
import type { AcceptanceConfig } from '../scripts/cloud-acceptance.ts';
import type { Candidate, Principal, ProjectState, RunnerService } from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let seq = 0;
const uid = () => `u-${++seq}`;
const now = () => new Date().toISOString();
const OWNER = { ownerId: 'steve', token: 'fixture-owner-token' };
const bearer = { authorization: `Bearer ${OWNER.token}` };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const HANDLERS = [
  handleIdentity, handleAssignments, handleChanges, handleIntegration,
  handleChecks, handleFindings, handleReviews, handleInbox, handleEvents,
];

const tmp = (label: string) => mkdtempSync(join(process.cwd(), `.c-swe-10-${label}-`));

let hasGit = true;
try {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  hasGit = r.status === 0;
} catch {
  hasGit = false;
}
const gitTest = hasGit ? test : test.skip;

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/c-swe-10-adversarial.json', import.meta.url), 'utf8'),
) as {
  badProjectIds: string[];
  overlongProjectId: string;
  goodProjectIds: string[];
  badRefs: string[];
  badShas: string[];
  foreignOrigins: string[];
};

function seedState(projectId: string, goal = 'fixture'): ProjectState {
  const state = createState({ id: projectId, goal, mode: 'live', actorId: 'steve', now: T0 });
  state.identities.steve = {
    id: 'steve', projectId, revision: 1, createdAt: T0, updatedAt: T0, actorId: 'steve',
    displayName: 'Local owner', ownerId: 'steve', creationSource: 'owner', status: 'active',
  };
  state.members['mem-steve'] = {
    id: 'mem-steve', projectId, revision: 1, createdAt: T0, updatedAt: T0, actorId: 'steve',
    identityId: 'steve', kind: 'core', scopes: ['owner', 'admin', 'read'],
  };
  return state;
}

const req = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1${path}`, init);
const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const api = (extra: Record<string, unknown> = {}) =>
  createLocalApi({
    ownerTokens: [OWNER],
    seedProjects: [{ id: 'p1', goal: 'seeded' }],
    now, uid,
    ...extra,
  } as Parameters<typeof createLocalApi>[0]);

const cfg = (over: Partial<AcceptanceConfig> = {}): AcceptanceConfig => ({
  apiUrl: 'http://127.0.0.1',
  ownerToken: OWNER.token,
  projectPrefix: 'acc',
  timeoutMs: 15_000,
  requireHosted: false,
  ...over,
});

const localFetch = (a: { fetch(r: Request): Promise<Response> }) =>
  ((request: Request) => a.fetch(request)) as typeof fetch;

const stepStatus = (report: Awaited<ReturnType<typeof runAcceptance>>, id: string) =>
  report.steps.find((s) => s.id === id)?.status;

// --- acceptance driver: config hygiene -----------------------------------

test('config: refuses secret material on argv, unsafe URLs and loose files', () => {
  const fileOk = { fileMode: () => 0o600, readFile: () => '{}' };
  assert.throws(
    () => loadConfig({ argv: ['--token=abc123'], env: {}, ...fileOk }),
    ConfigError,
    'token-looking flag refused',
  );
  assert.throws(
    () => loadConfig({ argv: ['--config', 'c.json', 'sess_0123456789abcdef'], env: {}, ...fileOk }),
    ConfigError,
    'token-looking positional value refused',
  );
  assert.throws(
    () =>
      loadConfig({
        argv: ['--config', 'c.json'],
        env: {},
        fileMode: () => 0o644,
        readFile: () => '{}',
      }),
    ConfigError,
    'group-readable config file refused',
  );
  assert.throws(
    () => loadConfig({ argv: [], env: { TOGETHER_ACCEPT_API_URL: 'https://w.example' }, ...fileOk }),
    ConfigError,
    'missing owner token refused',
  );
  assert.throws(
    () =>
      loadConfig({
        argv: [],
        env: {
          TOGETHER_ACCEPT_API_URL: 'http://remote.example',
          TOGETHER_ACCEPT_OWNER_TOKEN: 'owner-tok-123',
        },
        ...fileOk,
      }),
    ConfigError,
    'plain http off loopback refused',
  );
  assert.throws(
    () => validateApiUrl('https://user:pass@host.example'),
    ConfigError,
    'credentials embedded in URL refused',
  );
  assert.equal(validateApiUrl('https://worker.example/'), 'https://worker.example');
  assert.equal(validateApiUrl('http://127.0.0.1:8937'), 'http://127.0.0.1:8937');

  const loaded = loadConfig({
    argv: [],
    env: {
      TOGETHER_ACCEPT_API_URL: 'http://127.0.0.1:8937/',
      TOGETHER_ACCEPT_OWNER_TOKEN: 'owner-tok-123',
    },
    ...fileOk,
  });
  assert.equal(loaded.apiUrl, 'http://127.0.0.1:8937');
  assert.equal(loaded.projectPrefix, 'acc');
});

test('project ids: the fixture corpus is enforced exactly', () => {
  for (const id of corpus.badProjectIds) {
    assert.throws(() => assertSafeProjectId(id), ConfigError, `bad id accepted: ${id}`);
  }
  assert.throws(() => assertSafeProjectId(corpus.overlongProjectId), ConfigError);
  for (const id of corpus.goodProjectIds) {
    assertSafeProjectId(id);
  }
});

test('redactDeep masks issued secrets anywhere and secret-named keys', () => {
  const secrets = new Set(['sess_0123456789abcdef0123', 'cjob_ffffffffffffffffffffffffffffffff']);
  const doc = {
    nested: { token: 'sess_0123456789abcdef0123', note: 'issued sess_0123456789abcdef0123 once' },
    list: ['ok', 'sess_0123456789abcdef0123'],
    headers: { authorization: 'Bearer cjob_ffffffffffffffffffffffffffffffff' },
    keep: 'value',
  };
  const out = redactDeep(doc, secrets);
  const text = JSON.stringify(out);
  for (const s of secrets) assert.ok(!text.includes(s), `secret leaked: ${s}`);
  assert.equal((out as { keep: string }).keep, 'value');
  assert.equal(
    (out as { nested: { note: string } }).nested.note,
    'issued ***REDACTED*** once',
  );
});

// --- driver against the real local composition ----------------------------

test('driver: control-plane passes; absent git/docker/native seams stay unavailable', async () => {
  const a = api();
  const report = await runAcceptance(cfg(), { fetch: localFetch(a) });

  assert.equal(report.summary.fail, 0, JSON.stringify(
    report.steps.filter((s) => s.status === 'fail'), null, 2,
  ));
  const expectedPass = [
    'preflight.unauthenticated', 'auth.session', 'auth.whoami', 'project.create',
    'project.create.idempotent', 'adversarial.malicious-project-id',
    'adversarial.encoded-traversal', 'adversarial.foreign-origin',
    'adversarial.unauth-existence', 'adversarial.internal-headers',
    'identity.mint-agents', 'task.create-and-claim', 'adversarial.cross-project',
    'adversarial.collector-forgery', 'adversarial.body-limit', 'privacy.export',
    'flow.reconnect', 'adversarial.revoked-identity',
  ];
  for (const id of expectedPass) {
    assert.equal(stepStatus(report, id), 'pass', `${id} should pass`);
  }
  for (const id of [
    'flow.proposals', 'flow.combine-conflict', 'flow.combine',
    'flow.check', 'flow.review', 'flow.integrate',
  ]) {
    assert.equal(stepStatus(report, id), 'skipped', `${id} should be skipped without flow config`);
  }
  assert.equal(stepStatus(report, 'native.followup'), 'unavailable');
  assert.equal(report.verdict, 'incomplete');
  assert.equal(exitCodeFor(report), 0);
  const serialized = JSON.stringify(report);
  assert.ok(
    !/(sess|cjob|cred|inv)_[0-9a-f]{8,}/.test(serialized),
    'issued credential material leaked into the report',
  );
  assert.ok(!serialized.includes(OWNER.token), 'owner token leaked into the report');
});

gitTest('driver: real git + fixture runner run the whole remote flow honestly', async () => {
  const dir = tmp('gitflow');
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]): string => {
      const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    assert.equal(spawnSync('git', ['init', '--template=', '-b', 'main', repo]).status, 0);
    const ident = ['-c', 'user.name=acc', '-c', 'user.email=acc@invalid'];
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    git(['add', '-A']);
    git([...ident, 'commit', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);

    git(['checkout', '-b', 'workA']);
    writeFileSync(join(repo, 'marker.txt'), 'acceptance-marker\n');
    writeFileSync(join(repo, 'a.txt'), 'agent-a work\n');
    git(['add', '-A']);
    git([...ident, 'commit', '-m', 'agent a']);
    const headA = git(['rev-parse', 'HEAD']);

    git(['checkout', 'main']);
    git(['checkout', '-b', 'workB']);
    writeFileSync(join(repo, 'shared.txt'), 'agent-b change\n');
    git(['add', '-A']);
    git([...ident, 'commit', '-m', 'agent b']);
    const headB = git(['rev-parse', 'HEAD']);

    git(['checkout', 'main']);
    git(['checkout', '-b', 'confA']);
    writeFileSync(join(repo, 'shared.txt'), 'conflicting change\n');
    git(['add', '-A']);
    git([...ident, 'commit', '-m', 'conflict']);
    const conflictHeadA = git(['rev-parse', 'HEAD']);
    git(['checkout', 'main']);

    // Labeled executable fixture in place of the docker CLI: it logs argv
    // and runs the command inside the mounted dir. Wiring evidence only --
    // NOT an isolation boundary.
    const shim = join(dir, 'docker-fixture');
    const argvLog = join(dir, 'docker-argv.log');
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" >> "${argvLog}"`,
        'case "$1" in',
        '  version) echo fixture; exit 0;;',
        '  rm) exit 0;;',
        '  run) dir=""; prev=""; cmd=""',
        '    for a in "$@"; do',
        '      [ "$prev" = "--volume" ] && dir="${a%%:*}"',
        '      prev="$a"; cmd="$a"',
        '    done',
        '    ( cd "$dir" && sh -c "$cmd" );;',
        '  *) exit 1;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(shim, 0o755);

    const a = createLocalApi({
      ownerTokens: [OWNER],
      seedProjects: [{ id: 'acc-seed', goal: 'seeded' }],
      gitRepo: repo,
      gitProjectId: 'acc-gitflow',
      dockerBin: shim,
      now, uid,
    });
    const report = await runAcceptance(
      cfg({
        projectId: 'acc-gitflow',
        flow: { baseSha: base, headA, headB, conflictHeadA, checkCommand: 'test -f marker.txt' },
      }),
      { fetch: localFetch(a) },
    );

    assert.equal(report.summary.fail, 0, JSON.stringify(
      report.steps.filter((s) => s.status === 'fail'), null, 2,
    ));
    assert.equal(stepStatus(report, 'flow.proposals'), 'pass');
    assert.equal(stepStatus(report, 'flow.combine-conflict'), 'pass');
    assert.equal(stepStatus(report, 'flow.combine'), 'pass');
    assert.equal(stepStatus(report, 'flow.check'), 'pass');
    assert.equal(stepStatus(report, 'flow.review'), 'pass');
    assert.equal(stepStatus(report, 'flow.integrate'), 'pass');
    assert.equal(stepStatus(report, 'flow.reconnect'), 'pass');
    assert.equal(stepStatus(report, 'native.followup'), 'unavailable');
    assert.equal(report.summary.unavailable, 1, 'only native-session stays unavailable');
    assert.equal(report.verdict, 'incomplete');

    // The landing is a REAL git effect: canonical advanced to the candidate.
    const tip = git(['rev-parse', 'refs/heads/main']);
    assert.notEqual(tip, base, 'canonical ref must have advanced');
    const mergeBase = git(['merge-base', 'refs/heads/main', headA]);
    assert.equal(mergeBase, headA, 'agent A head must be an ancestor of the landed tip');

    const serialized = JSON.stringify(report);
    assert.ok(!/(sess|cjob|cred|inv)_[0-9a-f]{8,}/.test(serialized));
    assert.ok(!serialized.includes(OWNER.token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('driver: transport failure fails honestly and stops the plan', async () => {
  const report = await runAcceptance(cfg(), {
    fetch: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
  });
  assert.equal(report.summary.fail, 1);
  assert.equal(stepStatus(report, 'preflight.unauthenticated'), 'fail');
  assert.ok(report.summary.skipped > 10, 'remaining steps skipped after transport failure');
  assert.equal(report.verdict, 'fail');
  assert.equal(exitCodeFor(report), 1);
});

// --- original-risk evidence on frozen seams -------------------------------

test('revoked/expired credentials and sessions lose access immediately', async () => {
  const state = seedState('p1');
  const token = 'cred_0123456789abcdef0123456789abcdef';
  state.credentials.c1 = {
    id: 'c1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0, actorId: 'steve',
    identityId: 'i1', tokenHash: await hashToken(token), scopes: ['read'],
    projectIds: ['p1'], expiresAt: '2026-10-04T00:00:10.000Z', status: 'active',
  };
  state.identities.i1 = {
    id: 'i1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0, actorId: 'steve',
    displayName: 'agent', ownerId: 'steve', creationSource: 'manual', status: 'active',
  };
  const r = req('/api/v1/projects/p1', { headers: { authorization: `Bearer ${token}` } });
  const live = await authenticate(r, state, { now: () => '2026-10-04T00:00:05.000Z' });
  assert.ok(live !== null, 'unexpired credential resolves');
  const expired = await authenticate(r, state, { now: () => '2026-10-04T00:00:11.000Z' });
  assert.equal(expired, null, 'expired credential resolves to null');

  state.credentials.c1.expiresAt = undefined;
  state.credentials.c1.status = 'revoked';
  assert.equal(await authenticate(r, state), null, 'revoked credential resolves to null');
  state.credentials.c1.status = 'active';
  state.identities.i1.status = 'revoked';
  assert.equal(await authenticate(r, state), null, 'credential on revoked identity resolves to null');
  state.identities.i1.status = 'active';

  // Session-bound credential: revoked session kills the credential too.
  state.credentials.c1.sessionId = 's1';
  state.sessions.s1 = {
    id: 's1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0, actorId: 'i1',
    identityId: 'i1', advertisedCapabilities: [], observedCapabilities: [], status: 'revoked',
  };
  assert.equal(await authenticate(r, state), null, 'credential bound to revoked session resolves to null');
});

test('collector forgery matrix: member denied, wrong-job denied, payload bound, replay single', async () => {
  const store = new MemoryStore(seedState('p1'));
  await store.transact((d) => {
    d.candidates.c1 = {
      id: 'c1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
      actorId: 'steve', base: SHA_B, proposalIds: [], proposalHeads: {},
      sha: SHA_A, policyVersion: 1, status: 'prepared', checkJobIds: [], reviewIds: [],
    };
    return true;
  });
  // Labeled test double: captures the dispatch input so the test holds the
  // real job-scoped collector token. Not a production stand-in.
  const captured: { jobId: string; token: string }[] = [];
  const runner: RunnerService = {
    async dispatch(input) {
      captured.push({ jobId: input.jobId, token: input.collectorToken! });
      return { accepted: true };
    },
    async cancel() {
      return { accepted: true };
    },
  };
  const app = createApp({
    store,
    authenticate: async (r: Request): Promise<Principal | null> => {
      const s = await store.read();
      return (
        (await authenticate(r, s, { ownerTokens: [OWNER] })) ??
        (await authenticateCollector(r, s))
      );
    },
    handlers: HANDLERS,
    runner,
    now: () => T0,
    uid,
  });

  const task = await app.fetch(
    jsonPost('/api/v1/projects/p1/tasks', {
      operationId: 'op-task-1', goal: 'forgery probe', acceptanceCriteria: ['x'],
    }, bearer),
  );
  assert.equal(task.status, 201);
  const taskId = ((await task.json()) as { task: { id: string } }).task.id;
  const claim = await app.fetch(
    jsonPost(`/api/v1/projects/p1/tasks/${taskId}/assignments`, {
      operationId: 'op-claim-1', expectedRevision: 1, leaseMs: 60_000,
    }, bearer),
  );
  assert.equal(claim.status, 201);
  const asn = ((await claim.json()) as { assignment: { id: string; epoch: number } }).assignment;

  const registered = await app.fetch(
    jsonPost('/api/v1/projects/p1/candidates/c1/checks', {
      operationId: 'op-check-1', expectedRevision: 1, command: 'true', timeoutMs: 60_000,
      assignmentId: asn.id, assignmentEpoch: asn.epoch,
    }, bearer),
  );
  assert.equal(registered.status, 201);
  assert.equal(captured.length, 1, 'runner received exactly one dispatch');
  const jobId = captured[0].jobId;
  const jobToken = captured[0].token;

  // A member/owner principal is not a collector.
  const asOwner = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/complete`, {
      operationId: 'op-forge-1', outcome: 'pass', candidateSha: SHA_A, command: 'true',
    }, bearer),
  );
  assert.equal(asOwner.status, 403);
  // A garbage bearer cannot authenticate at all.
  const garbage = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/complete`, {
      operationId: 'op-forge-2', outcome: 'pass', candidateSha: SHA_A, command: 'true',
    }, { authorization: 'Bearer cjob_forged000000000000000000000000' }),
  );
  assert.equal(garbage.status, 401);
  // The real token is bound to its own job id only.
  const wrongJob = await app.fetch(
    jsonPost('/api/v1/projects/p1/collector/jobs/other-job/complete', {
      operationId: 'op-forge-3', outcome: 'pass', candidateSha: SHA_A, command: 'true',
    }, { authorization: `Bearer ${jobToken}` }),
  );
  assert.equal(wrongJob.status, 403);
  // A completion that disagrees with the registered job is rejected.
  const mismatch = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/complete`, {
      operationId: 'op-forge-4', outcome: 'pass', candidateSha: SHA_C, command: 'true',
    }, { authorization: `Bearer ${jobToken}` }),
  );
  assert.equal(mismatch.status, 409);
  // There is no public receipt-insert route.
  const receipts = await app.fetch(
    jsonPost('/api/v1/projects/p1/receipts', {
      operationId: 'op-forge-5', outcome: 'pass', candidateSha: SHA_A,
    }, { authorization: `Bearer ${jobToken}` }),
  );
  assert.equal(receipts.status, 404);

  // Replay dedupe is observable while the job is live: the same heartbeat
  // operationId returns the stored result without re-applying.
  const hb1 = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/heartbeat`, {
      operationId: 'op-hb-1', assignmentId: asn.id, epoch: asn.epoch,
    }, { authorization: `Bearer ${jobToken}` }),
  );
  const hb2 = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/heartbeat`, {
      operationId: 'op-hb-1', assignmentId: asn.id, epoch: asn.epoch,
    }, { authorization: `Bearer ${jobToken}` }),
  );
  assert.equal(hb1.status, 200);
  assert.equal(hb2.status, 200);
  assert.deepEqual(await hb2.json(), await hb1.json(), 'replayed heartbeat returns the stored result');

  const done = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/complete`, {
      operationId: 'op-done-1', outcome: 'pass', candidateSha: SHA_A, command: 'true',
    }, { authorization: `Bearer ${jobToken}` }),
  );
  assert.equal(done.status, 201);
  // Once the job completes its token is dead: a replayed completion is
  // denied at authentication and cannot mint a second receipt.
  const replay = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/complete`, {
      operationId: 'op-done-1', outcome: 'pass', candidateSha: SHA_A, command: 'true',
    }, { authorization: `Bearer ${jobToken}` }),
  );
  assert.equal(replay.status, 401);
  const state = await store.read();
  const jobReceipts = Object.values(state.receipts).filter((x) => x.jobId === jobId);
  assert.equal(jobReceipts.length, 1, 'replay minted no second receipt');
});

test('uncertain push: reconciliation truth table never mislabels effects', () => {
  const landed = reconcileTip({ observedTip: SHA_C, expectedTip: SHA_B, candidateTip: SHA_C });
  assert.equal(landed.effect, 'confirmed');
  const inflight = reconcileTip({
    observedTip: SHA_B, expectedTip: SHA_B, candidateTip: SHA_C,
  });
  assert.equal(inflight.effect, 'effect-unconfirmed');
  const ended = reconcileTip({
    observedTip: SHA_B, expectedTip: SHA_B, candidateTip: SHA_C,
    push: { ended: true, effect: 'no-effect' },
  });
  assert.equal(ended.effect, 'failed-no-effect');
  const lied = reconcileTip({
    observedTip: SHA_B, expectedTip: SHA_B, candidateTip: SHA_C,
    push: { ended: true, effect: 'updated' },
  });
  assert.equal(lied.effect, 'unknown');
  const third = reconcileTip({
    observedTip: SHA_A, expectedTip: SHA_B, candidateTip: SHA_C,
    candidateIsAncestor: false, push: { ended: true, effect: 'no-effect' },
  });
  assert.equal(third.effect, 'failed-no-effect');
  const thirdUnknown = reconcileTip({
    observedTip: SHA_A, expectedTip: SHA_B, candidateTip: SHA_C, candidateIsAncestor: false,
  });
  assert.equal(thirdUnknown.effect, 'unknown');
  const ancestorLanded = reconcileTip({
    observedTip: SHA_A, expectedTip: SHA_B, candidateTip: SHA_C, candidateIsAncestor: true,
  });
  assert.equal(ancestorLanded.effect, 'confirmed');
});

gitTest('real git: expected-tip CAS and adversarial ref/sha rejection', async () => {
  const dir = tmp('gitcas');
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]): string => {
      const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    assert.equal(spawnSync('git', ['init', '--template=', '-b', 'main', repo]).status, 0);
    const ident = ['-c', 'user.name=acc', '-c', 'user.email=acc@invalid'];
    writeFileSync(join(repo, 'f.txt'), 'v1\n');
    git(['add', '-A']);
    git([...ident, 'commit', '-m', 'base']);
    const tip0 = git(['rev-parse', 'HEAD']);
    git(['checkout', '-b', 'cand']);
    writeFileSync(join(repo, 'f.txt'), 'v2\n');
    git(['add', '-A']);
    git([...ident, 'commit', '-m', 'candidate']);
    const tip1 = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/heads/main', tip0]);

    const svc = new LocalGitService({ repo });
    try {
      const pushed = await svc.push({
        ref: 'refs/heads/main', expectedTip: tip0, candidateTip: tip1, operationId: 'op1',
      });
      assert.equal(pushed.effect, 'updated');
      assert.equal(await svc.readTip('refs/heads/main'), tip1);
      const again = await svc.push({
        ref: 'refs/heads/main', expectedTip: tip0, candidateTip: tip1, operationId: 'op2',
      });
      assert.equal(again.effect, 'no-effect');
      // A moved tip never lands under a stale lease and is reported honestly.
      git(['checkout', 'main']);
      writeFileSync(join(repo, 'f.txt'), 'v3\n');
      git(['add', '-A']);
      git([...ident, 'commit', '-m', 'other']);
      const tip2 = git(['rev-parse', 'HEAD']);
      const stale = await svc.push({
        ref: 'refs/heads/main', expectedTip: tip1, candidateTip: tip0, operationId: 'op3',
      });
      assert.equal(stale.effect, 'no-effect');
      assert.match(String(stale.reportStatus), /not-ancestor|tip-moved|already-at/);
      assert.equal(git(['rev-parse', 'refs/heads/main']), tip2, 'stale push must not move the ref');

      for (const ref of corpus.badRefs) {
        await assert.rejects(() => svc.readTip(ref), { status: 422 }, `bad ref read: ${ref}`);
        await assert.rejects(
          () => svc.push({ ref, expectedTip: tip1, candidateTip: tip1, operationId: 'opx' }),
          { status: 422 },
          `bad ref push: ${ref}`,
        );
      }
      for (const sha of corpus.badShas) {
        await assert.rejects(
          () => svc.isAncestor(sha, tip1),
          { status: 422 },
          `bad sha: ${sha}`,
        );
      }
      await assert.rejects(
        () => svc.prepare({
          projectId: 'p1', base: 'f'.repeat(40),
          proposals: [{ id: 'p-1', head: tip1 }], operationId: 'op4',
        }),
        { status: 422 },
        'nonexistent base commit must fail, never resolve arbitrary refs',
      );
    } finally {
      await svc.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late result: reclaimed epoch heartbeat renews nothing and records late activity', async () => {
  let T = '2026-10-04T00:00:00.000Z';
  const clock = () => T;
  const store = new MemoryStore(seedState('p1'));
  const captured: { jobId: string; token: string }[] = [];
  const runner: RunnerService = {
    async dispatch(input) {
      captured.push({ jobId: input.jobId, token: input.collectorToken! });
      return { accepted: true };
    },
    async cancel() {
      return { accepted: true };
    },
  };
  const app = createApp({
    store,
    authenticate: async (r: Request): Promise<Principal | null> => {
      const s = await store.read();
      return (
        (await authenticate(r, s, { ownerTokens: [OWNER] })) ??
        (await authenticateCollector(r, s))
      );
    },
    handlers: HANDLERS,
    runner,
    now: clock,
    uid,
  });

  const task = await app.fetch(
    jsonPost('/api/v1/projects/p1/tasks', {
      operationId: 'op-task', goal: 'late-output probe', acceptanceCriteria: ['x'],
    }, bearer),
  );
  assert.equal(task.status, 201);
  const taskId = ((await task.json()) as { task: { id: string } }).task.id;
  const claim = await app.fetch(
    jsonPost(`/api/v1/projects/p1/tasks/${taskId}/assignments`, {
      operationId: 'op-claim', expectedRevision: 1, leaseMs: 1000,
    }, bearer),
  );
  assert.equal(claim.status, 201);
  const assignment = ((await claim.json()) as { assignment: { id: string; epoch: number } }).assignment;

  await store.transact((d) => {
    d.candidates.c1 = {
      id: 'c1', projectId: 'p1', revision: 1, createdAt: T, updatedAt: T,
      actorId: 'steve', base: SHA_B, proposalIds: [], proposalHeads: {},
      sha: SHA_A, policyVersion: 1, status: 'prepared', checkJobIds: [], reviewIds: [],
    };
    return true;
  });
  const check = await app.fetch(
    jsonPost('/api/v1/projects/p1/candidates/c1/checks', {
      operationId: 'op-check', expectedRevision: 1, command: 'true',
      assignmentId: assignment.id, assignmentEpoch: assignment.epoch,
    }, bearer),
  );
  assert.equal(check.status, 201);
  const jobId = captured[0].jobId;
  const jobToken = captured[0].token;

  // Lease expires, task reclaimed -> new epoch seats a new owner assignment.
  T = '2026-10-04T00:00:05.000Z';
  const reclaim = await app.fetch(
    jsonPost(`/api/v1/projects/p1/tasks/${taskId}/reclaim`, {
      operationId: 'op-reclaim', expectedRevision: 2,
    }, bearer),
  );
  assert.equal(reclaim.status, 201);
  const next = ((await reclaim.json()) as { assignment: { id: string; epoch: number; leaseExpiresAt: string } }).assignment;
  assert.equal(next.epoch, assignment.epoch + 1);

  const heartbeat = await app.fetch(
    jsonPost(`/api/v1/projects/p1/collector/jobs/${jobId}/heartbeat`, {
      operationId: 'op-hb', assignmentId: assignment.id, epoch: assignment.epoch,
    }, { authorization: `Bearer ${jobToken}` }),
  );
  assert.equal(heartbeat.status, 200);
  const hb = (await heartbeat.json()) as { renewal: { renewed: boolean; reason?: string } };
  assert.equal(hb.renewal.renewed, false);
  assert.equal(hb.renewal.reason, 'superseded-epoch');

  const state = await store.read();
  assert.equal(
    state.assignments[next.id]!.leaseExpiresAt,
    next.leaseExpiresAt,
    'late heartbeat must not renew the successor',
  );
  assert.ok(
    state.events.some((e) => e.type === 'assignment:heartbeat-late'),
    'late heartbeat is recorded, not applied',
  );
});

test('durable reconnect: bootstrap idempotency survives restart; corrupt state fails closed', async () => {
  const dir = tmp('persist');
  try {
    const first = createLocalApi({
      ownerTokens: [OWNER], seedProjects: [{ id: 'seed-1', goal: 'seed' }], stateDir: dir, now, uid,
    });
    const created = await first.fetch(
      jsonPost('/api/v1/projects', { id: 'durable-p', goal: 'survives', operationId: 'opd-1' }, bearer),
    );
    assert.equal(created.status, 201);
    await first.storeFor('durable-p')!.read();

    const second = createLocalApi({
      ownerTokens: [OWNER], seedProjects: [{ id: 'seed-1', goal: 'seed' }], stateDir: dir, now, uid,
    });
    const list = await second.fetch(req('/api/v1/projects', { headers: bearer }));
    const body = (await list.json()) as { projects: { id: string }[] };
    assert.deepEqual(
      body.projects.map((p) => p.id).sort(),
      ['durable-p', 'seed-1'],
      'both persisted projects survive the restart',
    );

    const replay = await second.fetch(
      jsonPost('/api/v1/projects', { id: 'durable-p', goal: 'survives', operationId: 'opd-1' }, bearer),
    );
    assert.equal(replay.status, 201, 'bootstrap operation replays durably across restart');
    const conflict = await second.fetch(
      jsonPost('/api/v1/projects', { id: 'durable-q', goal: 'different', operationId: 'opd-1' }, bearer),
    );
    assert.equal(conflict.status, 409);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const bad = tmp('corrupt');
  try {
    writeFileSync(join(bad, 'corrupt.json'), '{not json');
    assert.throws(
      () => createLocalApi({ ownerTokens: [OWNER], seedProjects: [{ id: 'x' }], stateDir: bad, now, uid }),
      /unreadable|unsupported|json/i,
      'corrupt persisted state must fail closed, not silently reseed',
    );
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});
