// Unit evidence for the b-swe-02 Artifacts repair.
// Runs with: node --test tests/artifacts.test.ts (Node >=22.18 type stripping)
// or the root script: tsx --test tests/*.test.ts
//
// Offline fixtures only — they reproduce the documented Artifacts Workers
// binding shapes (namespace get/create + disposable repo capability) with no
// cloud calls. The first two tests demonstrate the original Blob/disposal
// defects; the rest verify the repaired adapter and probe contracts.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../lib/core.ts';
import {
  ArtifactsBindingAdapter, createArtifactsAdapter, flatRepoMetadata,
} from '../lib/artifacts.ts';
import type { ArtifactsCommitMetadata } from '../lib/artifacts.ts';
import { createArtifactsProbe } from '../cloud/artifacts-probe.ts';

// ---------------------------------------------------------------------------
// Doc-shaped fixtures (no cloud calls)
// ---------------------------------------------------------------------------

class FakeArtifactsRepo {
  disposeCount = 0;
  status = 'ready';
  meta: Record<string, unknown> = {
    id: 'repo-demo',
    name: 'demo',
    remote: 'https://acct.artifacts.cloudflare.net/git/default/demo.git',
    defaultBranch: 'main',
    createdAt: '2026-10-04T00:00:00.000Z',
  };
  files = new Map<string, Blob>();
  commits = new Map<string, ArtifactsCommitMetadata[]>();
  tokenCalls: { scope?: string; ttl?: number }[] = [];
  forkCalls: { name: string; opts?: unknown }[] = [];
  throwOn: { readFile?: Error; info?: Error; log?: Error } = {};

  [Symbol.dispose](): void {
    this.disposeCount += 1;
  }

  async info(): Promise<Record<string, unknown>> {
    if (this.throwOn.info) throw this.throwOn.info;
    return { ...this.meta, status: this.status };
  }

  async readFile(args: { ref: string; path: string }): Promise<Blob | null> {
    if (this.throwOn.readFile) throw this.throwOn.readFile;
    if (args.ref === '' || args.path === '') {
      const e = new Error('INVALID_INPUT: ref and path must be non-empty') as Error & { code?: string };
      e.code = 'INVALID_INPUT';
      throw e;
    }
    return this.files.get(`${args.ref}${args.path}`) ?? null;
  }

  async createToken(scope = 'write', ttl = 3600): Promise<Record<string, unknown>> {
    this.tokenCalls.push({ scope, ttl });
    return {
      plaintext: `art_v1_fixture_${scope}?expires=1759700400`,
      expiresAt: '2026-10-04T01:00:00.000Z',
    };
  }

  async fork(name: string, opts?: unknown): Promise<Record<string, unknown>> {
    this.forkCalls.push({ name, opts });
    return {
      id: 'repo-fork',
      name,
      remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git`,
      defaultBranch: 'main',
      status: 'ready',
      token: 'art_v1_fork_plaintext?expires=1759704000',
    };
  }

  async log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]> {
    if (this.throwOn.log) throw this.throwOn.log;
    const ref = opts?.ref ?? 'HEAD';
    const history = this.commits.get(ref) ?? [];
    const offset = opts?.offset ?? 0;
    return history.slice(offset, offset + (opts?.limit ?? 50));
  }
}

class FakeArtifactsNamespace {
  repos = new Map<string, FakeArtifactsRepo>();
  getCalls = 0;
  createCalls: { name: string; opts?: unknown }[] = [];

  async get(name: string): Promise<FakeArtifactsRepo> {
    this.getCalls += 1;
    const repo = this.repos.get(name);
    if (!repo) {
      const e = new Error(`NOT_FOUND: repo ${name}`) as Error & { code?: string };
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (repo.status !== 'ready') {
      const e = new Error(`NOT_READY: repo ${name} is ${repo.status}`) as Error & { code?: string };
      e.code = 'NOT_READY';
      throw e;
    }
    return repo;
  }

  async create(name: string, opts?: unknown): Promise<Record<string, unknown>> {
    this.createCalls.push({ name, opts });
    const repo = new FakeArtifactsRepo();
    repo.meta = { ...repo.meta, id: `repo-${name}`, name, remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git` };
    this.repos.set(name, repo);
    return { ...repo.meta, status: 'ready', token: 'art_v1_created?expires=1759700000' };
  }
}

function fixture(): { ns: FakeArtifactsNamespace; repo: FakeArtifactsRepo; adapter: ArtifactsBindingAdapter } {
  const ns = new FakeArtifactsNamespace();
  const repo = new FakeArtifactsRepo();
  ns.repos.set('demo', repo);
  const adapter = createArtifactsAdapter({ namespace: ns, repo: 'demo' });
  return { ns, repo, adapter };
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// ---------------------------------------------------------------------------
// Original defects, demonstrated (SPEC-V2: "Blob serialization and
// disposable-handle defects" found by the doc-shaped adapter probe)
// ---------------------------------------------------------------------------

test('original defect: serializing the readFile Blob loses all content', async () => {
  // The original adapter treated the doc-shaped `Blob | null` result as a
  // serializable object. JSON.stringify(Blob) is "{}", String(Blob) is
  // "[object Blob]" — the file content never reaches the caller.
  const blob = new Blob(['brief text body'], { type: 'text/plain;charset=utf-8' });
  assert.equal(JSON.stringify(blob), '{}');
  assert.equal(String(blob), '[object Blob]');
  // The repair decodes the Blob explicitly.
  assert.equal(await blob.text(), 'brief text body');
});

test('original defect: optional release() is not the Disposable contract', async () => {
  const cap = new FakeArtifactsRepo();
  // The original release path invoked `cap.release?.()` — the doc-shaped
  // capability implements Symbol.dispose, so this threw or no-opped, and on
  // an exception path it was skipped entirely.
  const legacyRelease = (c: object): void => {
    (c as { release?: () => void }).release?.();
  };
  legacyRelease(cap);
  assert.equal(cap.disposeCount, 0); // leaked: handle never released

  const legacySuccessOnlyRelease = async (c: FakeArtifactsRepo): Promise<void> => {
    const file = await c.readFile({ ref: 'main', path: 'missing' });
    void file;
    c[Symbol.dispose](); // only reached when nothing throws
  };
  cap.throwOn.readFile = new Error('boom');
  await assert.rejects(legacySuccessOnlyRelease(cap));
  assert.equal(cap.disposeCount, 0); // exception path leaked too

  cap[Symbol.dispose]();
  assert.equal(cap.disposeCount, 1); // repaired: Symbol.dispose is the contract
});

// ---------------------------------------------------------------------------
// Repaired adapter: Blob|null read + text decode with status distinctions
// ---------------------------------------------------------------------------

test('readFile returns Blob|null and readFileText decodes text', async () => {
  const { repo, adapter } = fixture();
  repo.files.set('mainREADME.md', new Blob(['# demo'], { type: 'text/plain;charset=utf-8' }));
  try {
    const blob = await adapter.readFile('README.md', 'main');
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'text/plain;charset=utf-8');
    assert.equal(await adapter.readFile('nope.md', 'main'), null);
    assert.equal(await adapter.readFileText('README.md', 'main'), '# demo');
  } finally {
    adapter[Symbol.dispose]();
  }
  assert.equal(repo.disposeCount, 1);
});

test('readFileText distinguishes 422 invalid input, 404 missing, empty file ok', async () => {
  const { repo, adapter } = fixture();
  repo.files.set('mainempty.txt', new Blob([]));
  try {
    await assert.rejects(
      adapter.readFileText('', 'main'),
      (err: ApiError) => err.status === 422 && err.code === 'artifact_invalid_input',
    );
    await assert.rejects(
      adapter.readFileText('x.md', '  '),
      (err: ApiError) => err.status === 422 && err.code === 'artifact_invalid_input',
    );
    await assert.rejects(
      adapter.readFileText('missing.md', 'main'),
      (err: ApiError) => err.status === 404 && err.code === 'artifact_not_found',
    );
    // Binding-side INVALID_INPUT maps to the same 422.
    repo.throwOn.readFile = Object.assign(new Error('INVALID_INPUT: bad ref'), { code: 'INVALID_INPUT' });
    await assert.rejects(
      adapter.readFileText('x.md', 'main'),
      (err: ApiError) => err.status === 422 && err.code === 'artifact_invalid_input',
    );
    repo.throwOn.readFile = undefined;
    // An existing zero-byte file decodes to '' rather than failing.
    assert.equal(await adapter.readFileText('empty.txt', 'main'), '');
  } finally {
    adapter[Symbol.dispose]();
  }
});

test('dependency not ready or missing binding maps to retryable 503', async () => {
  const { ns, repo, adapter } = fixture();
  repo.status = 'forking';
  await assert.rejects(
    adapter.info(),
    (err: ApiError) => err.status === 503 && err.code === 'artifacts_not_ready' && err.retryable,
  );
  repo.status = 'ready';

  const noBinding = createArtifactsAdapter({ namespace: undefined, repo: 'demo' });
  await assert.rejects(
    noBinding.readFile('x.md'),
    (err: ApiError) => err.status === 503 && err.code === 'artifacts_not_ready',
  );

  const missing = createArtifactsAdapter({ namespace: ns, repo: 'ghost' });
  await assert.rejects(
    missing.info(),
    (err: ApiError) => err.status === 404 && err.code === 'artifact_not_found',
  );
});

test('unexpected binding failure maps to 503, never a raw throw', async () => {
  const { repo, adapter } = fixture();
  repo.throwOn.readFile = new Error('rpc transport exploded');
  try {
    await assert.rejects(
      adapter.readFile('x.md'),
      (err: ApiError) => err.status === 503 && err.retryable,
    );
  } finally {
    adapter[Symbol.dispose]();
  }
});

// ---------------------------------------------------------------------------
// Flat metadata / readiness, fork + token contracts
// ---------------------------------------------------------------------------

test('info returns flat metadata + readiness and drops capability/token fields', async () => {
  const { repo, adapter } = fixture();
  repo.meta = {
    ...repo.meta,
    status: 'ready',
    nestedCapability: { rpc: 'handle' }, // not metadata
    token: 'art_v1_leak',
    plaintext: 'art_v1_leak',
  };
  try {
    const meta = await adapter.info();
    assert.equal(meta.id, 'repo-demo');
    assert.equal(meta.name, 'demo');
    assert.equal(meta.remote, 'https://acct.artifacts.cloudflare.net/git/default/demo.git');
    assert.equal(meta.defaultBranch, 'main');
    assert.equal(meta.status, 'ready');
    assert.equal(meta.ready, true);
    assert.equal(meta.nestedCapability, undefined);
    assert.equal(meta.token, undefined);
    assert.equal(meta.plaintext, undefined);
    assert.equal(JSON.stringify(meta).includes('art_v1'), false);
  } finally {
    adapter[Symbol.dispose]();
  }
});

test('createRepository and fork return flat metadata with a separate token', async () => {
  const { ns, adapter } = fixture();
  try {
    const created = await adapter.createRepository('new-repo', { description: 'd' });
    assert.deepEqual(ns.createCalls[0].name, 'new-repo');
    assert.equal(created.repo.name, 'new-repo');
    assert.equal(created.repo.ready, true);
    assert.equal(created.token?.plaintext, 'art_v1_created?expires=1759700000');
    // Expiry is derived separately; plaintext is not inside repo metadata.
    assert.equal(created.token?.expiresAt, '2025-10-05T21:33:20.000Z');
    assert.equal(JSON.stringify(created.repo).includes('art_v1'), false);

    const forked = await adapter.fork('demo', 'demo-ws', { readOnly: false });
    assert.equal(forked.repo.name, 'demo-ws');
    assert.equal(forked.repo.remote, 'https://acct.artifacts.cloudflare.net/git/default/demo-ws.git');
    assert.equal(forked.token?.plaintext, 'art_v1_fork_plaintext?expires=1759704000');
    assert.equal(forked.token?.expiresAt, '2025-10-05T22:40:00.000Z');
    assert.equal(JSON.stringify(forked.repo).includes('art_v1'), false);

    await assert.rejects(
      adapter.fork('somebody-else', 'nope'),
      (err: ApiError) => err.status === 422 && err.code === 'artifact_repo_mismatch',
    );
  } finally {
    adapter[Symbol.dispose]();
  }
});

test('createToken returns {plaintext, expiresAt}; plaintext stays out of metadata', async () => {
  const { repo, adapter } = fixture();
  try {
    const read = await adapter.createToken({ permissions: ['read'], expiresInSeconds: 300 });
    assert.equal(read.plaintext, 'art_v1_fixture_read?expires=1759700400');
    assert.equal(read.expiresAt, '2026-10-04T01:00:00.000Z');
    assert.deepEqual(repo.tokenCalls[0], { scope: 'read', ttl: 300 });

    const noPerms = await adapter.createToken();
    assert.equal(repo.tokenCalls[1].scope, 'read'); // least-privilege default
    assert.equal(repo.tokenCalls[1].ttl, 3600);

    await adapter.createToken({ permissions: ['write'], repositoryId: 'demo' });
    assert.equal(repo.tokenCalls[2].scope, 'write');
    void noPerms;

    await assert.rejects(
      adapter.createToken({ repositoryId: 'other-repo' }),
      (err: ApiError) => err.status === 422 && err.code === 'artifact_repo_mismatch',
    );

    // Minted plaintext never lands in metadata returned to callers.
    const meta = await adapter.info();
    assert.equal(JSON.stringify(meta).includes('art_v1'), false);
  } finally {
    adapter[Symbol.dispose]();
  }
});

// ---------------------------------------------------------------------------
// Exact-tip contract
// ---------------------------------------------------------------------------

test('tip resolves exact commit; requireTip enforces full-string equality', async () => {
  const { repo, adapter } = fixture();
  repo.commits.set('main', [{ sha: SHA_A, message: 'tip' }, { sha: SHA_B, message: 'older' }]);
  repo.commits.set('HEAD', [{ sha: SHA_A }]);
  try {
    assert.equal(await adapter.tip('main'), SHA_A);
    assert.equal(await adapter.requireTip('main', SHA_A), SHA_A);
    await assert.rejects(
      adapter.requireTip('main', SHA_B),
      (err: ApiError) => err.status === 409 && err.code === 'tip_mismatch' && err.message.includes(SHA_A),
    );
    // Prefix similarity is not equality.
    await assert.rejects(
      adapter.requireTip('main', SHA_A.slice(0, 7)),
      (err: ApiError) => err.status === 409 && err.code === 'tip_mismatch',
    );
    await assert.rejects(
      adapter.tip('no-such-ref'),
      (err: ApiError) => err.status === 404 && err.code === 'ref_not_found',
    );
  } finally {
    adapter[Symbol.dispose]();
  }
});

// ---------------------------------------------------------------------------
// Deterministic disposal: exactly once, including exception paths
// ---------------------------------------------------------------------------

test('dispose releases the capability exactly once, even after errors', async () => {
  const { repo, adapter } = fixture();
  repo.throwOn.readFile = new Error('mid-request failure');
  await assert.rejects(adapter.readFile('x.md'));
  adapter[Symbol.dispose]();
  adapter[Symbol.dispose](); // idempotent
  assert.equal(repo.disposeCount, 1);
});

test('capability is acquired lazily once and disposed adapter rejects calls', async () => {
  const { ns, repo, adapter } = fixture();
  assert.equal(ns.getCalls, 0); // nothing acquired yet
  await adapter.info();
  await adapter.info();
  assert.equal(ns.getCalls, 1); // capability shared across calls
  assert.equal(repo.disposeCount, 0);
  adapter[Symbol.dispose]();
  assert.equal(repo.disposeCount, 1);
  await assert.rejects(
    adapter.info(),
    (err: ApiError) => err.status === 409 && err.code === 'artifacts_disposed',
  );
});

test('disposing an unused adapter is a no-op; concurrent acquire shares one handle', async () => {
  const { ns, repo, adapter } = fixture();
  adapter[Symbol.dispose]();
  assert.equal(repo.disposeCount, 0);

  const shared = createArtifactsAdapter({ namespace: ns, repo: 'demo' });
  const [a, b] = await Promise.all([shared.info(), shared.info()]);
  assert.equal(a.id, b.id);
  assert.equal(ns.getCalls, 1);
  shared[Symbol.dispose]();
  assert.equal(repo.disposeCount, 1);
});

// ---------------------------------------------------------------------------
// Probe worker: separate auth, bounded read-only surface
// ---------------------------------------------------------------------------

function probeFixture(): { probe: { fetch(r: Request): Promise<Response> }; ns: FakeArtifactsNamespace; repo: FakeArtifactsRepo } {
  const ns = new FakeArtifactsNamespace();
  const repo = new FakeArtifactsRepo();
  ns.repos.set('demo', repo);
  const probe = createArtifactsProbe({ ARTIFACTS: ns, PROBE_TOKEN: 'probe-secret', PROBE_REPO: 'demo' });
  return { probe, ns, repo };
}

const authed = (path: string): Request =>
  new Request(`https://probe.test${path}`, { headers: { 'x-probe-token': 'probe-secret' } });

test('probe: health is unauthenticated; repo routes require X-Probe-Token', async () => {
  const { probe } = probeFixture();
  const health = await probe.fetch(new Request('https://probe.test/probe/health'));
  assert.equal(health.status, 200);

  const noAuth = await probe.fetch(new Request('https://probe.test/probe/readiness'));
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json() as { error: { code: string } }).error.code, 'probe_unauthenticated');

  const wrongAuth = await probe.fetch(
    new Request('https://probe.test/probe/readiness', { headers: { 'x-probe-token': 'nope' } }),
  );
  assert.equal(wrongAuth.status, 401);

  const unconfigured = createArtifactsProbe({ ARTIFACTS: ns0(), PROBE_REPO: 'demo' });
  const misconfig = await unconfigured.fetch(authed('/probe/readiness'));
  assert.equal(misconfig.status, 503);
  assert.equal((await misconfig.json() as { error: { code: string } }).error.code, 'probe_not_configured');
});

function ns0(): FakeArtifactsNamespace {
  const ns = new FakeArtifactsNamespace();
  ns.repos.set('demo', new FakeArtifactsRepo());
  return ns;
}

test('probe: readiness/info/tip/head return flat results and dispose the capability', async () => {
  const { probe, repo } = probeFixture();
  repo.commits.set('main', [{ sha: SHA_A }]);
  repo.files.set('mainbriefs/b1.md', new Blob(['brief body'], { type: 'text/plain;charset=utf-8' }));

  const readiness = await probe.fetch(authed('/probe/readiness'));
  assert.equal(readiness.status, 200);
  const readyBody = await readiness.json() as { ready: boolean; status: string; repo: Record<string, unknown> };
  assert.equal(readyBody.ready, true);
  assert.equal(readyBody.status, 'ready');
  assert.equal(readyBody.repo.name, 'demo');
  assert.equal(JSON.stringify(readyBody).includes('art_v1'), false);

  const info = await probe.fetch(authed('/probe/info'));
  assert.equal((await info.json() as { repo: { remote: string } }).repo.remote.includes('demo.git'), true);

  const tip = await probe.fetch(authed('/probe/tip?ref=main'));
  assert.deepEqual(await tip.json(), { ref: 'main', tip: SHA_A });

  const head = await probe.fetch(authed('/probe/head?path=briefs/b1.md&ref=main'));
  const headBody = await head.json() as { exists: boolean; size: number; type: string; sha256: string };
  assert.equal(headBody.exists, true);
  assert.equal(headBody.size, 'brief body'.length);
  assert.equal(headBody.type, 'text/plain;charset=utf-8');
  assert.match(headBody.sha256, /^[0-9a-f]{64}$/);
  // The probe proves the read without leaking file content.
  assert.equal(JSON.stringify(headBody).includes('brief body'), false);

  const missing = await probe.fetch(authed('/probe/head?path=none.md'));
  assert.equal((await missing.json() as { exists: boolean }).exists, false);

  // Every request released its capability exactly once (5 authed repo calls).
  assert.equal(repo.disposeCount, 5);
});

test('probe: broad namespace operations are not exposed', async () => {
  const { probe } = probeFixture();
  for (const route of ['/probe/repos', '/probe/create', '/probe/fork', '/probe/token', '/probe/list', '/probe/delete']) {
    const res = await probe.fetch(authed(route));
    assert.equal(res.status, 404, route);
  }
  const post = await probe.fetch(
    new Request('https://probe.test/probe/readiness', {
      method: 'POST',
      headers: { 'x-probe-token': 'probe-secret' },
      body: '{}',
    }),
  );
  assert.equal(post.status, 404);
});

test('probe: not-ready repo surfaces 503 and still disposes nothing twice', async () => {
  const { probe, repo } = probeFixture();
  repo.status = 'importing';
  const res = await probe.fetch(authed('/probe/readiness'));
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { error: { code: string; retryable: boolean } }).error.code, 'artifacts_not_ready');
  assert.equal(repo.disposeCount, 0); // get() threw; no capability was ever held
});

// Narrow regression from the actual remote-binding read-back diagnosis.
test('binding branch ref normalization preserves exact SHA and HEAD', async () => {
  const {adapter, repo}=fixture();
  repo.files.set('fieldathon-probeprobe.txt',new Blob(['owned fixture']));
  repo.commits.set('fieldathon-probe',[{hash:SHA_A}]);
  repo.commits.set(SHA_B,[{hash:SHA_B}]);
  repo.commits.set('HEAD',[{hash:SHA_B}]);
  assert.equal(await adapter.readFileText('probe.txt','refs/heads/fieldathon-probe'),'owned fixture');
  assert.equal(await adapter.tip('refs/heads/fieldathon-probe'),SHA_A);
  assert.equal(await adapter.tip(SHA_B),SHA_B);
  assert.equal(await adapter.tip('HEAD'),SHA_B);
  adapter[Symbol.dispose]();
  assert.equal(repo.disposeCount,1);
});
