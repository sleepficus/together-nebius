// Lane c-swe-05 regression tests: project-bound Artifacts transport.
// Runs with: node --test tests/c-swe-05.test.ts (Node >=22.18 type stripping).
//
// Offline fixtures only — they reproduce the documented Artifacts Workers
// binding shapes (namespace get() + disposable repo capability with
// info/createToken/fork/log/readFile) with no cloud calls. They assert this
// lane's contract: record-bound adapter, project-prefixed fork provenance,
// canonical-only write capabilities, bounded token TTLs, typed error
// mapping and exactly-once disposal on all paths.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiError } from '../lib/core.ts';
import {
  CloudProjectArtifactsAdapter,
  TRANSPORT_TOKEN_TTL_SECONDS,
  createCloudArtifactsAdapter,
  isProjectForkRepository,
  projectForkPrefix,
  repositoryCapability,
} from '../cloud/project-artifacts.ts';
import type { CloudEnv, DirectoryProjectRecord } from '../cloud/phase04-contract.ts';
import type { ArtifactRepoMetadata } from '../lib/artifacts.ts';

// ---------------------------------------------------------------------------
// Doc-shaped fixtures (no cloud calls)
// ---------------------------------------------------------------------------

class FakeRepo {
  disposeCount = 0;
  status = 'ready';
  tokenCalls: { scope?: string; ttl?: number }[] = [];
  forkCalls: { name: string; opts?: unknown }[] = [];
  files = new Map<string, Blob>();
  commits = new Map<string, { sha?: string; hash?: string; id?: string }[]>();
  throwToken?: Error;
  meta: Record<string, unknown>;
  ns: FakeNamespace;

  constructor(ns: FakeNamespace, name: string, extra: Record<string, unknown> = {}) {
    this.ns = ns;
    this.meta = {
      id: `id-${name}`,
      name,
      remote: `https://acct.artifacts.cloudflare.net/git/default/${name}.git`,
      defaultBranch: 'together-cloud',
      ...extra,
    };
  }

  [Symbol.dispose](): void {
    this.disposeCount += 1;
  }

  async info(): Promise<Record<string, unknown>> {
    return { ...this.meta, status: this.status };
  }

  async readFile(args: { ref: string; path: string }): Promise<Blob | null> {
    if (args.ref === '' || args.path === '') {
      const e = new Error('INVALID_INPUT: ref and path must be non-empty') as Error & { code?: string };
      e.code = 'INVALID_INPUT';
      throw e;
    }
    return this.files.get(`${args.ref}:${args.path}`) ?? null;
  }

  async createToken(scope = 'write', ttl = 3600): Promise<Record<string, unknown>> {
    if (this.throwToken) throw this.throwToken;
    this.tokenCalls.push({ scope, ttl });
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    return {
      plaintext: `tok_${this.meta.name}_${scope}?expires=${expiry}`,
      expiresAt: new Date(expiry * 1000).toISOString(),
    };
  }

  async fork(name: string, opts?: unknown): Promise<Record<string, unknown>> {
    this.forkCalls.push({ name, opts });
    const repo = new FakeRepo(this.ns, name);
    this.ns.repos.set(name, repo);
    return { ...repo.meta, status: 'ready' };
  }

  async log(opts?: { ref?: string; limit?: number }): Promise<{ sha?: string; hash?: string; id?: string }[]> {
    return (this.commits.get(opts?.ref ?? 'HEAD') ?? []).slice(0, opts?.limit ?? 50);
  }
}

class FakeNamespace {
  repos = new Map<string, FakeRepo>();
  getCalls: string[] = [];

  async get(name: string): Promise<FakeRepo> {
    this.getCalls.push(name);
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
}

function makeRecord(overrides: Partial<DirectoryProjectRecord> = {}): DirectoryProjectRecord {
  return {
    id: 'proj-1',
    ownerId: 'owner-1',
    goal: 'lane05',
    createdAt: '2026-10-04T00:00:00.000Z',
    repositoryId: 'together-cloud-proj-1',
    remote: 'https://acct.artifacts.cloudflare.net/git/default/together-cloud-proj-1.git',
    canonicalRef: 'refs/heads/together-cloud',
    provisioning: 'ready',
    operationId: 'op-1',
    digest: 'd',
    ...overrides,
  };
}

function fixture() {
  const ns = new FakeNamespace();
  const record = makeRecord();
  const canonical = new FakeRepo(ns, record.repositoryId);
  ns.repos.set(record.repositoryId, canonical);
  const env = { ARTIFACTS: ns } as unknown as CloudEnv;
  const adapter = createCloudArtifactsAdapter(env, record) as CloudProjectArtifactsAdapter;
  return { ns, canonical, record, env, adapter };
}

const errIs = (status: number, code: string) => (err: ApiError) =>
  err.status === status && err.code === code;

// ---------------------------------------------------------------------------
// Record-bound adapter and provenance
// ---------------------------------------------------------------------------

test('adapter binds to the directory record repository and verifies provenance', async () => {
  const { ns, canonical, record, env, adapter } = fixture();
  canonical.files.set('together-cloud:BRIEF.md', new Blob(['brief body'], { type: 'text/plain;charset=utf-8' }));
  canonical.commits.set('together-cloud', [{ sha: 'a'.repeat(40) }]);
  try {
    const meta = await adapter.info();
    assert.equal(meta.name, record.repositoryId);
    assert.equal(meta.remote, record.remote);
    assert.equal(meta.ready, true);
    // Only the record's repository is ever resolved — no caller input here.
    assert.deepEqual(ns.getCalls, [record.repositoryId]);
    // refs/heads/ is normalized for the binding; the file is a real Blob.
    const blob = await adapter.readFile('BRIEF.md', 'refs/heads/together-cloud');
    assert.ok(blob instanceof Blob);
    assert.equal(await adapter.readFileText('BRIEF.md', 'refs/heads/together-cloud'), 'brief body');
    // Exact-tip read against the canonical ref.
    assert.equal(await adapter.tip('refs/heads/together-cloud'), 'a'.repeat(40));
  } finally {
    adapter[Symbol.dispose]();
  }
  assert.equal(canonical.disposeCount, 1);
});

test('real create-shaped opaque canonical ID resolves by trusted name and rechecks ID/remote', async () => {
  const ns = new FakeNamespace();
  const name = 'together-cloud-proj-1';
  const record = makeRecord({ repositoryId: 'opaque-created-repo-id' });
  const canonical = new FakeRepo(ns, name, { id: record.repositoryId });
  ns.repos.set(name, canonical);
  const env = { ARTIFACTS: ns } as unknown as CloudEnv;
  const adapter = createCloudArtifactsAdapter(env, record) as CloudProjectArtifactsAdapter;
  try {
    assert.equal((await adapter.info()).id, record.repositoryId);
    const fork = await adapter.fork(record.repositoryId, 'opaque-fixture');
    assert.equal(fork.repo.repositoryId, projectForkPrefix(record) + 'opaque-fixture');
    const cap = await repositoryCapability(env, record, record.repositoryId, 'read');
    assert.equal(cap.repositoryId, record.repositoryId);
    assert.equal(cap.remote, record.remote);
    assert.ok(ns.getCalls.every((n) => n === name));
    canonical.meta.id = 'different-id';
    await assert.rejects(repositoryCapability(env, record, record.repositoryId, 'write'), (e: {code:string}) => e.code === 'repo_provenance_mismatch');
  } finally { adapter[Symbol.dispose](); }
});

test('opaque name resolution denies incomplete or mismatched metadata before minting', async () => {
  for (const extra of [{ id: '' }, { id: 'wrong-id' }, { remote: '' }, { remote: 'https://acct.artifacts.cloudflare.net/git/default/foreign.git' }]) {
    const ns = new FakeNamespace();
    const record = makeRecord({ repositoryId: 'opaque-created-repo-id' });
    const cap = new FakeRepo(ns, 'together-cloud-proj-1', { id: record.repositoryId, ...extra });
    ns.repos.set('together-cloud-proj-1', cap);
    const env = { ARTIFACTS: ns } as unknown as CloudEnv;
    await assert.rejects(repositoryCapability(env, record, record.repositoryId, 'write'), (e: {code:string}) => e.code === 'repo_provenance_mismatch');
    const adapter = createCloudArtifactsAdapter(env, record) as CloudProjectArtifactsAdapter;
    try { await assert.rejects(adapter.info(), (e: {code:string}) => e.code === 'repo_provenance_mismatch'); }
    finally { adapter[Symbol.dispose](); }
    assert.equal(cap.tokenCalls.length, 0);
  }
});

test('opaque name resolution denies malformed, foreign, credentialed or retargeted trusted remotes', async () => {
  for (const remote of ['not-a-url', 'https://foreign.invalid/git/default/together-cloud-proj-1.git',
    'https://user:password@acct.artifacts.cloudflare.net/git/default/together-cloud-proj-1.git',
    'https://acct.artifacts.cloudflare.net/git/default/together-cloud-other.git']) {
    const ns = new FakeNamespace();
    const record = makeRecord({ repositoryId: 'opaque-created-repo-id', remote });
    await assert.rejects(repositoryCapability({ARTIFACTS:ns} as unknown as CloudEnv, record, record.repositoryId, 'write'), (e: {code:string}) => e.code === 'repo_provenance_mismatch');
    assert.equal(ns.getCalls.length, 0);
  }
});

test('provenance mismatch between record and binding metadata is a hard 409', async () => {
  const { ns, env } = fixture();
  await assert.rejects(
    (createCloudArtifactsAdapter(env, makeRecord({ remote: 'https://evil.example/repo.git' })) as CloudProjectArtifactsAdapter).info(),
    errIs(409, 'repo_provenance_mismatch'),
  );
  // get() resolved 'alias-name' but the binding reports a different repo name/id.
  const aliased = new FakeRepo(ns, 'real-name');
  ns.repos.set('alias-name', aliased);
  aliased.meta.id = 'id-real-name';
  await assert.rejects(async () => {
    const a2 = createCloudArtifactsAdapter(env, makeRecord({ repositoryId: 'alias-name', remote: 'https://acct.artifacts.cloudflare.net/git/default/real-name.git' })) as CloudProjectArtifactsAdapter;
    try { await a2.info(); } finally { a2[Symbol.dispose](); }
  }, errIs(409, 'repo_provenance_mismatch'));
});

test('unready provisioning and missing binding are honest 503s', async () => {
  const { record, env } = fixture();
  const pending = createCloudArtifactsAdapter(env, makeRecord({ provisioning: 'pending' })) as CloudProjectArtifactsAdapter;
  await assert.rejects(pending.info(), errIs(503, 'artifacts_not_ready'));
  const noBinding = createCloudArtifactsAdapter({} as CloudEnv, record) as CloudProjectArtifactsAdapter;
  await assert.rejects(noBinding.readFile('x.md'), errIs(503, 'artifacts_not_ready'));
  await assert.rejects(
    repositoryCapability({} as CloudEnv, record, record.repositoryId, 'read'),
    errIs(503, 'artifacts_not_ready'),
  );
  await assert.rejects(
    repositoryCapability(env, makeRecord({ provisioning: 'failed' }), record.repositoryId, 'read'),
    errIs(503, 'artifacts_not_ready'),
  );
});

// ---------------------------------------------------------------------------
// Fork provenance
// ---------------------------------------------------------------------------

test('forks are minted under the project prefix and stay get()-resolvable', async () => {
  const { ns, canonical, record, adapter } = fixture();
  try {
    const result = await adapter.fork(record.repositoryId, 'assignment-asg-1');
    const expected = `${projectForkPrefix(record)}assignment-asg-1`;
    assert.deepEqual(canonical.forkCalls, [{ name: expected, opts: undefined }]);
    assert.equal(result.repo.name, expected);
    // repositoryId is normalized to the binding name so a persisted fork
    // ref resolves through env.ARTIFACTS.get() after recreation.
    assert.equal(result.repo.repositoryId, expected);
    assert.ok(ns.repos.has(expected));
    // Double-prefixing a caller that already sent the project prefix is a no-op.
    const again = await adapter.fork(record.repositoryId, expected);
    assert.equal(again.repo.name, expected);
    // No token material leaks inside flat repo metadata.
    assert.equal(JSON.stringify(result.repo).includes('tok_'), false);
    // Forks of anything other than the bound repo are still refused.
    await assert.rejects(
      adapter.fork('somebody-else', 'assignment-x'),
      errIs(422, 'artifact_repo_mismatch'),
    );
  } finally {
    adapter[Symbol.dispose]();
  }
});

test('isProjectForkRepository attests prefix names and metadata lineage only', async () => {
  const record = makeRecord();
  assert.equal(isProjectForkRepository(record, `${projectForkPrefix(record)}anything`), true);
  assert.equal(isProjectForkRepository(record, 'foreign-repo'), false);
  assert.equal(
    isProjectForkRepository(record, 'other', { name: 'other', forkOf: record.repositoryId } as unknown as ArtifactRepoMetadata),
    true,
  );
  assert.equal(
    isProjectForkRepository(record, 'other', { name: 'other', forkOf: 'somebody-else' } as unknown as ArtifactRepoMetadata),
    false,
  );
  // A canonical-style name must not be mistaken for this project's fork.
  assert.equal(isProjectForkRepository(record, 'together-cloud-proj-2'), false);
});

// ---------------------------------------------------------------------------
// Token scope rules
// ---------------------------------------------------------------------------

test('handler-visible createToken never mints canonical write; fork write stays repo-scoped', async () => {
  const { ns, canonical, record, adapter } = fixture();
  try {
    await assert.rejects(
      adapter.createToken({ permissions: ['write'] }),
      errIs(403, 'capability_scope_denied'),
    );
    await assert.rejects(
      adapter.createToken({ permissions: ['write'], repositoryId: record.repositoryId }),
      errIs(403, 'capability_scope_denied'),
    );
    // Canonical read is fine and least-privilege by default.
    const read = await adapter.createToken({ permissions: ['read'], expiresInSeconds: 300 });
    assert.match(read.plaintext, /^tok_together-cloud-proj-1_read\?/);
    assert.deepEqual(canonical.tokenCalls[0], { scope: 'read', ttl: 300 });
    // The fork write token is minted on the fork capability only — the
    // canonical repo never sees a write mint through this surface.
    const fork = await adapter.fork(record.repositoryId, 'assignment-w');
    const forkRepo = ns.repos.get(fork.repo.name)!;
    const forkTok = await adapter.createToken({ repositoryId: fork.repo.name, permissions: ['fork:read', 'fork:write'], expiresInSeconds: 120 });
    assert.match(forkTok.plaintext, /^tok_together-cloud-fork-proj-1-assignment-w_write\?/);
    assert.deepEqual(forkRepo.tokenCalls[0], { scope: 'write', ttl: 120 });
    assert.equal(forkRepo.disposeCount, 1);
    assert.equal(canonical.tokenCalls.length, 1);
  } finally {
    adapter[Symbol.dispose]();
  }
});

test('issued-fork tokens survive adapter recreation; foreign/missing ids are denied', async () => {
  const { ns, record, env } = fixture();
  const first = createCloudArtifactsAdapter(env, record) as CloudProjectArtifactsAdapter;
  const fork = await first.fork(record.repositoryId, 'assignment-a2');
  first[Symbol.dispose]();

  // A fresh adapter has no in-memory fork set: the project prefix attests.
  const second = createCloudArtifactsAdapter(env, record) as CloudProjectArtifactsAdapter;
  const tok = await second.createToken({ repositoryId: fork.repo.repositoryId as string, permissions: ['fork:read', 'fork:write'] });
  assert.match(tok.plaintext, /_write\?/);

  // An existing repo that is not this project's fork is denied.
  ns.repos.set('foreign-repo', new FakeRepo(ns, 'foreign-repo'));
  await assert.rejects(
    second.createToken({ repositoryId: 'foreign-repo', permissions: ['read'] }),
    errIs(422, 'artifact_repo_mismatch'),
  );
  await assert.rejects(
    second.createToken({ repositoryId: 'foreign-repo', permissions: ['write'] }),
    errIs(403, 'capability_scope_denied'),
  );
  // A project-prefixed name that no longer resolves fails with typed 404.
  await assert.rejects(
    second.createToken({ repositoryId: `${projectForkPrefix(record)}gone`, permissions: ['read'] }),
    errIs(404, 'artifact_not_found'),
  );
  // An unknown name with no provenance is a mismatch, not a mint.
  await assert.rejects(
    second.createToken({ repositoryId: 'missing-repo', permissions: ['read'] }),
    errIs(422, 'artifact_repo_mismatch'),
  );
  second[Symbol.dispose]();
});

test('project adapters never create repositories', async () => {
  const { adapter } = fixture();
  await assert.rejects(
    adapter.createRepository!('together-cloud-anything'),
    errIs(403, 'capability_scope_denied'),
  );
  adapter[Symbol.dispose]();
});

// ---------------------------------------------------------------------------
// repositoryCapability — trusted internal helper
// ---------------------------------------------------------------------------

test('repositoryCapability mints bounded canonical read and write capabilities', async () => {
  const { canonical, record, env } = fixture();
  const read = await repositoryCapability(env, record, record.repositoryId, 'read');
  assert.deepEqual(Object.keys(read).sort(), ['expiresAt', 'plaintext', 'remote', 'repositoryId']);
  assert.equal(read.repositoryId, record.repositoryId);
  assert.equal(read.remote, record.remote);
  assert.match(read.plaintext, /^tok_together-cloud-proj-1_read\?expires=\d+$/);
  assert.ok(Date.parse(read.expiresAt) > Date.now());
  assert.deepEqual(canonical.tokenCalls[0], { scope: 'read', ttl: TRANSPORT_TOKEN_TTL_SECONDS });
  assert.equal(canonical.disposeCount, 1); // helper releases its own handle

  const write = await repositoryCapability(env, record, record.repositoryId, 'write');
  assert.match(write.plaintext, /^tok_together-cloud-proj-1_write\?/);
  assert.deepEqual(canonical.tokenCalls[1], { scope: 'write', ttl: TRANSPORT_TOKEN_TTL_SECONDS });
  assert.equal(canonical.disposeCount, 2);
});

test('repositoryCapability: fork read allowed; write denied before any binding call', async () => {
  const { ns, record, env } = fixture();
  const adapter = createCloudArtifactsAdapter(env, record) as CloudProjectArtifactsAdapter;
  const fork = await adapter.fork(record.repositoryId, 'assignment-a1');
  adapter[Symbol.dispose]();
  const forkName = fork.repo.name;

  const cap = await repositoryCapability(env, record, forkName, 'read');
  assert.equal(cap.repositoryId, forkName);
  assert.equal(cap.remote, `https://acct.artifacts.cloudflare.net/git/default/${forkName}.git`);
  const forkRepo = ns.repos.get(forkName)!;
  assert.deepEqual(forkRepo.tokenCalls[0], { scope: 'read', ttl: TRANSPORT_TOKEN_TTL_SECONDS });
  assert.equal(forkRepo.disposeCount, 1);

  // Write on anything but canonical is denied before resolving the repo.
  const callsBefore = ns.getCalls.length;
  await assert.rejects(
    repositoryCapability(env, record, forkName, 'write'),
    errIs(403, 'capability_scope_denied'),
  );
  await assert.rejects(
    repositoryCapability(env, record, 'anything', 'write'),
    errIs(403, 'capability_scope_denied'),
  );
  assert.equal(ns.getCalls.length, callsBefore);
});

test('repositoryCapability: metadata lineage attests a fork whose name lacks the prefix', async () => {
  const { ns, record, env } = fixture();
  ns.repos.set('legacy-fork', new FakeRepo(ns, 'legacy-fork', { forkOf: record.repositoryId }));
  const cap = await repositoryCapability(env, record, 'legacy-fork', 'read');
  assert.equal(cap.repositoryId, 'legacy-fork');
  assert.equal(ns.repos.get('legacy-fork')!.tokenCalls[0].scope, 'read');
  await assert.rejects(
    repositoryCapability(env, record, 'legacy-fork', 'write'),
    errIs(403, 'capability_scope_denied'),
  );
});

test('repositoryCapability: foreign repo, missing repo and binding failures stay typed', async () => {
  const { ns, canonical, record, env } = fixture();
  ns.repos.set('foreign-repo', new FakeRepo(ns, 'foreign-repo'));
  await assert.rejects(
    repositoryCapability(env, record, 'foreign-repo', 'read'),
    errIs(403, 'capability_scope_denied'),
  );
  await assert.rejects(
    repositoryCapability(env, record, 'missing-repo', 'read'),
    errIs(404, 'artifact_not_found'),
  );
  // Binding failure mid-call: typed 503 and the handle is still disposed.
  canonical.throwToken = new Error('rpc transport exploded');
  await assert.rejects(
    repositoryCapability(env, record, record.repositoryId, 'read'),
    errIs(503, 'artifacts_not_ready'),
  );
  assert.equal(canonical.disposeCount, 1);
  // Invalid scope rejected.
  await assert.rejects(
    repositoryCapability(env, record, record.repositoryId, 'admin' as 'read'),
    errIs(422, 'artifact_invalid_input'),
  );
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('exact-tip CAS enforces full-string equality on the bound repository', async () => {
  const { canonical, adapter } = fixture();
  const SHA = 'a'.repeat(40);
  canonical.commits.set('together-cloud', [{ sha: SHA }]);
  try {
    assert.equal(await adapter.requireTip('refs/heads/together-cloud', SHA), SHA);
    await assert.rejects(
      adapter.requireTip('together-cloud', SHA.slice(0, 7)),
      errIs(409, 'tip_mismatch'),
    );
    await assert.rejects(adapter.tip('no-such-ref'), errIs(404, 'ref_not_found'));
  } finally {
    adapter[Symbol.dispose]();
  }
  // Disposed adapter refuses further calls — a new adapter must be created.
  await assert.rejects(adapter.info(), errIs(409, 'artifacts_disposed'));
});
