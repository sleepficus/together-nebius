// Lane c-swe-09 unit evidence: cloud worker composition, private companion.
// Runs with: node --test tests/c-swe-09.test.ts (Node >=22.18 type stripping).
//
// Scope honestly covered here:
//   - edge header sanitization, cross-site write gate, route table
//   - truthful 503 dependency_unavailable while sibling lane modules are
//     absent from this packet (pre-merge state)
//   - DO wrapper delegation once lane modules are merged (injected fakes
//     stand for the documented signatures — never production stand-ins)
//   - ProjectObject trusted init + directory-ownership auth boundary
//   - session-gated asset delivery + SPA fallback
//   - outbound-only companion pull/result/heartbeat envelopes, truthful
//     outage handling, secret redaction
//   - wrangler.cloud.jsonc shape
// NOT covered (separate evidence classes, recorded in TEST-EVIDENCE.md):
//   real Cloudflare runtime, real Artifacts namespace, real private host,
//   real Git/Docker, real browser rendering.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import worker, {
  ProjectObject, DirectoryObject, SessionObject, ExecutionObject,
  stripInternalHeaders, laneModuleOverrides,
} from '../cloud/worker.ts';
import { runCompanion } from '../scripts/cloud-companion.ts';
import { fakeObjectState } from './fixtures/c-swe-09-sqlite.ts';
import type { ExecutionJob } from '../cloud/phase04-contract.ts';

// ------------------------------------------------------------------ helpers

const ENV_TOKENS = JSON.stringify([
  { ownerId: 'owner-a', token: 'tok-a' },
  { ownerId: 'owner-b', token: 'tok-b' },
]);

function jsonRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function fakeProjectNamespace(captured?: { requests: Request[] }) {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({
      fetch: async (req: Request) => {
        captured?.requests.push(req.clone());
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    }),
  };
}

test.beforeEach(() => {
  for (const name of ['directory', 'sessions', 'access', 'global-inbox', 'project-artifacts', 'git-service', 'execution', 'check-service']) {
    laneModuleOverrides.set(name, null);
  }
});
test.afterEach(() => laneModuleOverrides.clear());

// ------------------------------------------------------------- wrangler config

test('wrangler.cloud.jsonc: worker name, four sqlite DOs, artifacts test namespace', () => {
  const raw = readFileSync(new URL('../wrangler.cloud.jsonc', import.meta.url), 'utf8');
  const stripped = raw.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  const cfg = JSON.parse(stripped) as Record<string, any>;
  assert.equal(cfg.name, 'together-example');
  assert.equal(cfg.main, 'cloud/worker.ts');
  assert.equal(cfg.assets.binding, 'ASSETS');
  assert.equal(cfg.assets.directory, './dist/client');
  const bindings = cfg.durable_objects.bindings as { name: string; class_name: string }[];
  const names = bindings.map((b) => b.name).sort();
  assert.deepEqual(names, ['DIRECTORY_OBJECT', 'EXECUTION_OBJECT', 'PROJECT_OBJECT', 'SESSION_OBJECT']);
  for (const b of bindings) assert.match(b.class_name, /^(Directory|Session|Project|Execution)Object$/);
  const migrated = cfg.migrations.flatMap((m: { new_sqlite_classes?: string[] }) => m.new_sqlite_classes ?? []);
  assert.deepEqual([...migrated].sort(), ['DirectoryObject', 'ExecutionObject', 'ProjectObject', 'SessionObject']);
  assert.equal(cfg.artifacts[0].binding, 'ARTIFACTS');
  assert.equal(cfg.artifacts[0].namespace, 'your-together-artifacts-namespace');
  assert.equal(cfg.vars.TEST_REPO_PREFIX, 'together-cloud-');
  assert.equal(cfg.vars.TEST_CANONICAL_REF, 'refs/heads/together-cloud');
  // Secrets are never committed to config.
  assert.equal(cfg.vars.OWNER_TOKENS, undefined);
  assert.equal(cfg.vars.GIT_BRIDGE_TOKEN, undefined);
  assert.equal(cfg.vars.CHECK_BRIDGE_TOKEN, undefined);
});

// ------------------------------------------------------------ edge hygiene

test('edge strips forged internal authorization headers before DO routing', async () => {
  const captured = { requests: [] as Request[] };
  const env = { PROJECT_OBJECT: fakeProjectNamespace(captured) } as never;
  const res = await worker.fetch(jsonRequest('https://w.example/api/v1/projects/p1/tasks', {
    method: 'GET',
    headers: {
      authorization: 'Bearer tok-a',
      'x-together-internal-init': 'directory-object',
      'x-authorized-bootstrap': '1',
      'x-together-internal-evil': 'yes',
    },
  }), env);
  assert.equal(res.status, 200);
  assert.equal(captured.requests.length, 1);
  const seen = captured.requests[0];
  assert.equal(seen.headers.get('x-together-internal-init'), null);
  assert.equal(seen.headers.get('x-authorized-bootstrap'), null);
  assert.equal(seen.headers.get('x-together-internal-evil'), null);
  assert.equal(seen.headers.get('authorization'), 'Bearer tok-a');
});

test('cross-site write gate: metadata, Origin, bearer-only CLI', async () => {
  const captured = { requests: [] as Request[] };
  const env = { PROJECT_OBJECT: fakeProjectNamespace(captured) } as never;
  const post = (headers: Record<string, string>) =>
    worker.fetch(jsonRequest('https://w.example/api/v1/projects/p1/tasks', {
      method: 'POST', headers,
    }), env);

  // cross-site browser metadata -> 403
  assert.equal((await post({ 'sec-fetch-site': 'cross-site', cookie: 's=1' })).status, 403);
  // disallowed Origin -> 403
  assert.equal((await post({ origin: 'https://evil.example', cookie: 's=1' })).status, 403);
  // cookie-only mutation with no metadata -> 403 (CSRF guard)
  assert.equal((await post({ cookie: 's=1' })).status, 403);
  // same-origin browser metadata -> forwarded
  assert.equal((await post({ 'sec-fetch-site': 'same-origin', cookie: 's=1' })).status, 200);
  // explicit bearer CLI client with no Origin -> forwarded
  assert.equal((await post({ authorization: 'Bearer tok-a' })).status, 200);
  assert.equal(captured.requests.length, 2);
});

test('GET passes the origin gate (read-only)', async () => {
  const env = { PROJECT_OBJECT: fakeProjectNamespace() } as never;
  const res = await worker.fetch(jsonRequest('https://w.example/api/v1/projects/p1', {
    headers: { 'sec-fetch-site': 'cross-site' },
  }), env);
  assert.equal(res.status, 200);
});

// ------------------------------------------- truthful absent-lane degradation

test('absent lane modules answer 503 dependency_unavailable, never fake', async () => {
  const env = { PROJECT_OBJECT: fakeProjectNamespace() } as never;
  const cases: [string, Request][] = [
    ['login', jsonRequest('https://w.example/login')],
    ['session', jsonRequest('https://w.example/api/v1/session')],
    ['directory', jsonRequest('https://w.example/api/v1/projects', { headers: { authorization: 'Bearer tok-a' } })],
    ['inbox', jsonRequest('https://w.example/api/v1/inbox', { headers: { authorization: 'Bearer tok-a' } })],
    ['bridge', jsonRequest('https://w.example/internal/v1/execution/pull', { method: 'POST', headers: { authorization: 'Bearer git' } })],
  ];
  const env2 = { PROJECT_OBJECT: fakeProjectNamespace(), OWNER_TOKENS: ENV_TOKENS } as never;
  for (const [name, req] of cases) {
    const res = await worker.fetch(req, env2);
    assert.equal(res.status, 503, name);
    assert.equal(await errorCode(res), 'dependency_unavailable', name);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('DO wrappers report dependency_unavailable while lane classes are absent', async () => {
  const env = {} as never;
  for (const [Cls, spec] of [
    [DirectoryObject, 'cloud/directory.ts'],
    [SessionObject, 'cloud/sessions.ts'],
    [ExecutionObject, 'cloud/execution.ts'],
  ] as const) {
    const obj = new Cls(fakeObjectState('p1') as never, env);
    const res = await obj.fetch(jsonRequest('https://w.example/x'));
    assert.equal(res.status, 503);
    const body = await res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'dependency_unavailable');
    assert.ok(body.error.message.includes(spec), body.error.message);
  }
});

test('merged lane modules: wrapper delegates; directoryFetch receives resolved owner', async () => {
  class FakeDir {
    s: unknown;
    e: unknown;
    constructor(s: unknown, e: unknown) { this.s = s; this.e = e; }
    fetch(_r: Request) { return Promise.resolve(new Response('delegated', { status: 209 })); }
  }
  let seenOwner: unknown = 'unset';
  laneModuleOverrides.set('directory', {
    DirectoryObject: FakeDir,
    directoryFetch: async (_req: Request, _env: unknown, owner: unknown) => {
      seenOwner = owner;
      return new Response('dir-root', { status: 207 });
    },
  });
  const obj = new DirectoryObject(fakeObjectState('p1') as never, {} as never);
  const res = await obj.fetch(jsonRequest('https://w.example/x'));
  assert.equal(res.status, 209);
  assert.equal(await res.text(), 'delegated');

  const env = { OWNER_TOKENS: ENV_TOKENS } as never;
  const root = await worker.fetch(jsonRequest('https://w.example/api/v1/projects', {
    headers: { authorization: 'Bearer tok-a' },
  }), env);
  assert.equal(root.status, 207);
  assert.deepEqual(seenOwner, { id: 'owner-a', ownerId: 'owner-a' });
});

// ----------------------------------------------------------------- ProjectObject

const recordA = {
  id: 'p1', ownerId: 'owner-a', goal: 'test project',
  repositoryId: 'repo-1', remote: 'https://artifacts.example/repo-1',
  canonicalRef: 'refs/heads/together-cloud', provisioning: 'ready',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

function projectEnv(records: Record<string, typeof recordA | null>) {
  laneModuleOverrides.set('directory', {
    projectRecord: async (_env: unknown, projectId: string) => records[projectId] ?? null,
  });
  return { OWNER_TOKENS: ENV_TOKENS } as never;
}

function initRequest(projectId: string, marked = true): Request {
  return jsonRequest(`https://w.example/internal/v1/projects/${projectId}/init`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(marked ? { 'x-together-internal-init': 'directory-object' } : {}),
    },
    body: JSON.stringify({
      projectId, goal: 'test project', ownerId: 'owner-a',
      repositoryId: 'repo-1', remote: 'https://artifacts.example/repo-1',
      canonicalRef: 'refs/heads/together-cloud',
    }),
  });
}

test('ProjectObject trusted init is one-shot, idempotent and ownership-bound', async () => {
  const env = projectEnv({ p1: recordA });
  const obj = new ProjectObject(fakeObjectState('p1') as never, env);

  // Unmarked init is refused — the marker only exists on trusted binding calls.
  const unmarked = await obj.fetch(initRequest('p1', false));
  assert.equal(unmarked.status, 403);
  assert.equal(await errorCode(unmarked), 'internal_only');

  const created = await obj.fetch(initRequest('p1'));
  assert.equal(created.status, 201);

  // Replay recovers from actual metadata instead of pretending failure.
  const replay = await obj.fetch(initRequest('p1'));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { alreadyInitialized: boolean }).alreadyInitialized, true);

  // Conflicting owner is a real conflict.
  const other = await obj.fetch(jsonRequest('https://w.example/internal/v1/projects/p1/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-together-internal-init': 'directory-object' },
    body: JSON.stringify({ projectId: 'p1', goal: 'x', ownerId: 'owner-b', repositoryId: 'r', remote: 'r', canonicalRef: 'refs/heads/together-cloud' }),
  }));
  assert.equal(other.status, 409);

  // Owning owner's token reaches the snapshot.
  const got = await obj.fetch(jsonRequest('https://w.example/api/v1/projects/p1', {
    headers: { authorization: 'Bearer tok-a' },
  }));
  assert.equal(got.status, 200);
  const state = await got.json() as { project: { id: string; ownerId?: string; canonicalRef: string; repositories: Record<string, { repositoryId: string }> } };
  assert.equal(state.project.id, 'p1');
  assert.equal(state.project.ownerId, 'owner-a');
  assert.equal(state.project.canonicalRef, 'refs/heads/together-cloud');
  assert.equal(state.project.repositories.artifacts.repositoryId, 'repo-1');
});

test('ProjectObject: unrelated owner token is never authority', async () => {
  const env = projectEnv({ p1: recordA });
  const obj = new ProjectObject(fakeObjectState('p1') as never, env);
  await obj.fetch(initRequest('p1'));
  const res = await obj.fetch(jsonRequest('https://w.example/api/v1/projects/p1', {
    headers: { authorization: 'Bearer tok-b' },
  }));
  assert.equal(res.status, 401);
});

test('ProjectObject: unprovisioned and pending records are truthful', async () => {
  const env = projectEnv({
    p2: null,
    p3: { ...recordA, id: 'p3', provisioning: 'pending' },
  });
  const missing = await new ProjectObject(fakeObjectState('p2') as never, env)
    .fetch(jsonRequest('https://w.example/api/v1/projects/p2', { headers: { authorization: 'Bearer tok-a' } }));
  assert.equal(missing.status, 404);
  const pending = await new ProjectObject(fakeObjectState('p3') as never, env)
    .fetch(jsonRequest('https://w.example/api/v1/projects/p3', { headers: { authorization: 'Bearer tok-a' } }));
  assert.equal(pending.status, 503);
  assert.equal(await errorCode(pending), 'project_provisioning');
});

test('ProjectObject: non-API path and unauthenticated request are denied', async () => {
  const env = projectEnv({ p1: recordA });
  const obj = new ProjectObject(fakeObjectState('p1') as never, env);
  await obj.fetch(initRequest('p1'));
  const notApi = await obj.fetch(jsonRequest('https://w.example/static/app.js'));
  assert.equal(notApi.status, 404);
  const unauth = await obj.fetch(jsonRequest('https://w.example/api/v1/projects/p1'));
  assert.equal(unauth.status, 401);
});

// ------------------------------------------------------------- gated assets

test('static UI is session-gated: redirect to /login or 401', async () => {
  const env = {
    OWNER_TOKENS: ENV_TOKENS,
    ASSETS: { fetch: async () => new Response('<html>app</html>', { status: 200 }) },
  } as never;
  const html = await worker.fetch(jsonRequest('https://w.example/overview', {
    headers: { accept: 'text/html' },
  }), env);
  assert.equal(html.status, 302);
  assert.match(html.headers.get('location') ?? '', /\/login\?next=/);
  const apiLike = await worker.fetch(jsonRequest('https://w.example/assets/app.js'), env);
  assert.equal(apiLike.status, 401);
});

test('gated assets: canonical shell preserves deep links and private cache', async () => {
  const fetched: string[] = [];
  const env = {
    OWNER_TOKENS: ENV_TOKENS,
    ASSETS: {
      fetch: async (r: Request) => {
        const p = new URL(r.url).pathname;
        fetched.push(p);
        // Cloudflare's default HTML handling canonicalizes index.html.
        if (p === '/index.html') return Response.redirect('https://w.example/', 307);
        if (p === '/') return new Response('<html>spa</html>', { status: 200 });
        return new Response('nf', { status: 404 });
      },
    },
  } as never;
  const auth = { headers: { authorization: 'Bearer tok-a', accept: 'text/html' } };
  const res = await worker.fetch(jsonRequest('https://w.example/crew', auth), env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>spa</html>');
  assert.deepEqual(fetched, ['/crew', '/']);
  assert.equal(res.headers.get('location'), null);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('vary'), 'Cookie, Authorization');

  // Non-HTML 404 is not masked by the shell.
  const notFound = await worker.fetch(jsonRequest('https://w.example/favicon.ico', {
    headers: { authorization: 'Bearer tok-a', accept: 'image/png' },
  }), env);
  assert.equal(notFound.status, 404);

  // Mutations never fall through to a successful HTML shell.
  const post = await worker.fetch(jsonRequest('https://w.example/crew', {
    method: 'POST', ...auth,
  }), env);
  assert.equal(post.status, 404);
});

// ------------------------------------------------------------------ companion

function jobFixture(): ExecutionJob & { leaseId?: string } {
  return {
    id: 'j1', projectId: 'p1', role: 'git', action: 'git.readTip',
    payload: {}, digest: 'd', key: 'k', deadlineAt: '2030-01-01T00:00:00.000Z',
    status: 'leased', leaseId: 'L1',
  };
}

function companionEnv(scratch: string) {
  return {
    TOGETHER_CLOUD_API_URL: 'https://w.example',
    TOGETHER_PROJECT_IDS: 'p1,p2',
    TOGETHER_GIT_BRIDGE_TOKEN: 'git-tok-SECRET',
    TOGETHER_COMPANION_SCRATCH: scratch,
    TOGETHER_HEARTBEAT_INTERVAL_MS: '10',
  };
}

test('companion: pull/result envelopes, scoped bearer, redacted output', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'comp-'));
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/pull')) {
      return new Response(JSON.stringify({ jobs: [jobFixture()] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const out: string[] = [];
  let seenOpts: unknown;
  const gitExecutor = async (_job: ExecutionJob, opts: unknown) => {
    seenOpts = opts;
    return { tip: 'abc123' };
  };
  const code = await runCompanion({
    env: companionEnv(scratch), fetchFn, gitExecutor,
    out: (l) => out.push(l), once: true,
  });
  assert.equal(code, 0);
  const pull = calls.find((c) => c.url.endsWith('/pull'));
  assert.ok(pull);
  assert.equal(pull.url, 'https://w.example/internal/v1/execution/pull');
  assert.equal((pull.init.headers as Record<string, string>).authorization, 'Bearer git-tok-SECRET');
  assert.deepEqual(JSON.parse(String(pull.init.body)), { role: 'git', projectIds: ['p1', 'p2'] });
  const result = calls.find((c) => c.url.endsWith('/result'));
  assert.ok(result);
  assert.deepEqual(JSON.parse(String(result.init.body)), {
    projectId: 'p1', jobId: 'j1', leaseId: 'L1', result: { tip: 'abc123' },
  });
  const opts = seenOpts as { root: string; gitBridgeToken: string };
  assert.equal(opts.root, scratch);
  assert.equal(opts.gitBridgeToken, 'git-tok-SECRET');
  for (const line of out) assert.ok(!line.includes('git-tok-SECRET'), `leaked: ${line}`);
});

test('companion: absent executor module disables the role, jobs stay queued', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'comp-'));
  const calls: string[] = [];
  const fetchFn = (async (url: string) => { calls.push(String(url)); return new Response('{}'); }) as typeof fetch;
  const out: string[] = [];
  // No gitExecutor injected and companion/git-executor.ts is absent here.
  const code = await runCompanion({
    env: companionEnv(scratch), fetchFn, gitExecutor: null, out: (l) => out.push(l), once: true,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 0, 'role must never be pulled without an executor');
  assert.ok(out.some((l) => l.includes('executor unavailable')));
});

test('companion: dependency outage is truthful; nothing is consumed', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'comp-'));
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(String(url));
    return new Response('broker down', { status: 503 });
  }) as typeof fetch;
  const out: string[] = [];
  const code = await runCompanion({
    env: companionEnv(scratch), fetchFn,
    gitExecutor: async () => ({ never: 'called' }),
    out: (l) => out.push(l), once: true,
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/pull'));
  assert.ok(out.some((l) => l.includes('pull failed status=503')));
});

test('companion: executor failure reports a bounded error result', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'comp-'));
  const posts: Record<string, unknown>[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/pull')) {
      return new Response(JSON.stringify({ jobs: [jobFixture()] }), { status: 200 });
    }
    posts.push(JSON.parse(String(init.body)));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const code = await runCompanion({
    env: companionEnv(scratch), fetchFn,
    gitExecutor: async () => { throw new Error('snapshot extraction exploded \n\n with details'); },
    out: () => undefined, once: true,
  });
  assert.equal(code, 0);
  const errPost = posts.find((p) => p.error !== undefined) as { jobId: string; error: { code: string; message: string } };
  assert.ok(errPost);
  assert.equal(errPost.error.code, 'executor_error');
  assert.ok(!errPost.error.message.includes('\n'));
  assert.equal(errPost.jobId, 'j1');
});

test('companion: long jobs send lease heartbeats bound to job/lease', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'comp-'));
  const heartbeats: Record<string, unknown>[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith('/pull')) {
      return new Response(JSON.stringify({ jobs: [jobFixture()] }), { status: 200 });
    }
    if (String(url).endsWith('/heartbeat')) heartbeats.push(JSON.parse(String(init.body)));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const code = await runCompanion({
    env: companionEnv(scratch), fetchFn,
    gitExecutor: async () => { await new Promise((r) => setTimeout(r, 40)); return { ok: true }; },
    out: () => undefined, once: true,
  });
  assert.equal(code, 0);
  assert.ok(heartbeats.length >= 1);
  assert.deepEqual(heartbeats[0], { projectId: 'p1', jobId: 'j1', leaseId: 'L1' });
});

test('companion: config errors are usage errors; token files must be 0600', async () => {
  const out: string[] = [];
  const missing = await runCompanion({ env: {}, out: (l) => out.push(l), once: true });
  assert.equal(missing, 2);
  assert.ok(out[0].includes('TOGETHER_CLOUD_API_URL'));

  const dir = mkdtempSync(join(tmpdir(), 'comp-'));
  const file = join(dir, 'token');
  writeFileSync(file, 'file-tok');
  chmodSync(file, 0o644); // too permissive
  const out2: string[] = [];
  const env = { ...companionEnv(dir), TOGETHER_GIT_BRIDGE_TOKEN_FILE: file };
  delete env.TOGETHER_GIT_BRIDGE_TOKEN;
  const code = await runCompanion({ env, out: (l) => out2.push(l), once: true });
  assert.equal(code, 2);
  assert.ok(out2[0].includes('0600'));
});
