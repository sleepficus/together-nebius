// Controller seam regressions over the actual merged modules. Structural
// storage/Artifacts fixtures below are unit evidence, not a hosted claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { DirectoryObject, SessionObject, ProjectObject } from '../cloud/worker.ts';
import { bridgeFetch } from '../cloud/execution.ts';
import { createFakeSqlStorage } from './fixtures/c-swe-09-sqlite.ts';
import { createState } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { handleChecks } from '../lib/checks.ts';
import type { CloudEnv, CloudNamespace, CloudStorage } from '../cloud/phase04-contract.ts';
import type { Context, CheckJob } from '../lib/types.ts';
import { createProjectController } from '../src/data/useProject.ts';

const owner = { ownerId: 'fixture-owner', token: 'fixture-owner-credential' };
const otherOwner = { ownerId: 'fixture-other-owner', token: 'fixture-other-credential' };
function memory(): CloudStorage {
  const map = new Map<string, unknown>();
  const storage: CloudStorage = {
    get: async <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => { map.set(key, structuredClone(value)); },
    delete: async (key: string) => map.delete(key),
    list: async <T>(opts?: { prefix?: string }) => new Map([...map].filter(([k]) => k.startsWith(opts?.prefix ?? '')).map(([k,v]) => [k, structuredClone(v) as T])),
    transaction: async <T>(fn: (tx: CloudStorage) => Promise<T>) => fn(storage),
  };
  return storage;
}
function mergedEnv() {
  const env: CloudEnv = { OWNER_TOKENS: JSON.stringify([owner, otherOwner]), TEST_REPO_PREFIX: 'together-cloud-', TEST_CANONICAL_REF: 'refs/heads/together-cloud' };
  const namespace = (Ctor: typeof DirectoryObject | typeof SessionObject | typeof ProjectObject, sql = false): CloudNamespace => {
    const objects = new Map<string, InstanceType<typeof Ctor>>();
    return {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (id) => ({ fetch: async (req) => {
        const name = id.toString();
        if (!objects.has(name)) {
          const state = { id: { name, toString: () => name }, storage: sql ? createFakeSqlStorage().storage : memory(), blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn() };
          objects.set(name, new Ctor(state as never, env));
        }
        return objects.get(name)!.fetch(req);
      } }),
    };
  };
  env.DIRECTORY_OBJECT = namespace(DirectoryObject);
  env.SESSION_OBJECT = namespace(SessionObject);
  env.PROJECT_OBJECT = namespace(ProjectObject, true);
  let assetsFetched = 0;
  env.ASSETS = { fetch: async () => { assetsFetched++; return new Response('fixture workspace bytes', { headers: { 'cache-control': 'public, max-age=86400' } }); } };
  const repos = new Map<string, Record<string, unknown>>();
  env.ARTIFACTS = {
    create: async (name: string) => {
      const repo = { id: name, name, remote: `https://artifacts.invalid/${name}.git`, status: 'ready', defaultBranch: 'together-cloud' };
      repos.set(name, repo); return repo;
    },
    get: (name: string) => ({ info: async () => repos.get(name), [Symbol.dispose]: () => {} }),
  } as never;
  return { env, assetsFetched: () => assetsFetched };
}
const request = (path: string, init?: RequestInit) => new Request(`https://unit.invalid${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('merged Directory initializes the real ProjectObject contract and verifies ownership', async () => {
  const { env } = mergedEnv();
  const body = { operationId: 'create-fixture', expectedRevision: 1, goal: 'merged fixture', id: 'fixture-project' };
  const created = await worker.fetch(post('/api/v1/projects', body, { authorization: `Bearer ${owner.token}` }), env);
  assert.equal(created.status, 201, await created.clone().text());
  const replay = await worker.fetch(post('/api/v1/projects', body, { authorization: `Bearer ${owner.token}` }), env);
  assert.equal(replay.status, 201);
  const state = await worker.fetch(request('/api/v1/projects/fixture-project', { headers: { authorization: `Bearer ${owner.token}` } }), env);
  assert.equal(state.status, 200, await state.clone().text());
  assert.equal((await state.json() as { project: { ownerId: string } }).project.ownerId, owner.ownerId);
  const forged = await worker.fetch(post('/internal/v1/projects/fixture-project/init', {}, { 'x-together-internal-init': 'directory-object' }), env);
  assert.equal(forged.status, 401);
});

test('invalid or malformed explicit bearer never inherits a valid owner cookie', async () => {
  const { env } = mergedEnv();
  const login = await worker.fetch(post('/api/v1/session', { token: owner.token }, { origin: 'https://unit.invalid' }), env);
  assert.equal(login.status, 201);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  for (const authorization of ['Bearer unrecognized', 'Basic malformed', 'Bearer']) {
    for (const path of ['/api/v1/projects', '/api/v1/session', '/index.html']) {
      const res = await worker.fetch(request(path, { headers: { cookie, authorization } }), env);
      assert.equal(res.status, 401, `${authorization} ${path}`);
    }
  }
  assert.equal((await worker.fetch(request('/index.html', { headers: { cookie } }), env)).status, 200);
});

test('assets route through Worker authentication and replace public cache headers', async () => {
  const { env, assetsFetched } = mergedEnv();
  for (const path of ['/', '/index.html', '/assets/main.js', '/icon.png']) {
    const denied = await worker.fetch(request(path), env);
    assert.equal(denied.status, 401);
  }
  assert.equal(assetsFetched(), 0);
  const ok = await worker.fetch(request('/assets/main.js', { headers: { authorization: `Bearer ${owner.token}` } }), env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  const cfg = JSON.parse(readFileSync(new URL('../wrangler.cloud.jsonc', import.meta.url), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n'));
  assert.equal(cfg.assets.run_worker_first, true);
});

test('bridge rejects unlisted projects before any private object lookup for each purpose', async () => {
  let routed = 0;
  const env: CloudEnv = { GIT_BRIDGE_TOKEN: 'fixture-git', CHECK_BRIDGE_TOKEN: 'fixture-check', GIT_BRIDGE_PROJECT_IDS: 'owned', CHECK_BRIDGE_PROJECT_IDS: 'owned', EXECUTION_OBJECT: { idFromName: (name) => ({ toString: () => name }), get: () => ({ fetch: async () => { routed++; return Response.json({ jobs: [] }); } }) } };
  for (const [role, token] of [['git', 'fixture-git'], ['check', 'fixture-check']]) {
    for (const op of ['pull', 'result', 'heartbeat']) {
      const body = op === 'pull' ? { role, projectIds: ['owned', 'foreign'] } : { projectId: 'foreign', jobId: 'job', leaseId: 'lease', result: { tip: 'a'.repeat(40) } };
      assert.equal((await bridgeFetch(post(`/internal/v1/execution/${op}`, body, { authorization: `Bearer ${token}` }), env)).status, 403);
    }
  }
  assert.equal(routed, 0);
  const missing = { ...env, GIT_BRIDGE_PROJECT_IDS: undefined };
  assert.equal((await bridgeFetch(post('/internal/v1/execution/pull', { projectIds: ['owned'] }, { authorization: 'Bearer fixture-git' }), missing)).status, 503);
  assert.equal(routed, 0);
});

test('late collector completion creates no receipt, readiness or job mutation', async () => {
  const state = createState({ id: 'p', mode: 'live', goal: 'deadline fixture' });
  state.jobs.j = { id: 'j', projectId: 'p', revision: 1, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', actorId: 'owner', candidateId: 'c', candidateSha: 'a'.repeat(40), command: 'check', status: 'dispatched', deadlineAt: '2026-10-04T00:00:01Z' } as CheckJob;
  const store = new MemoryStore(state);
  const ctx: Context = { store, principal: { id: 'collector:j', sessionId: 'collector:j', kind: 'collector', scopes: ['collector'], projectIds: ['p'], jobId: 'j' } as never, now: () => '2026-10-04T00:00:02Z', uid: () => 'receipt-fixture' };
  const module = process.env.CLOUD_CHECKS_BASELINE ? await import(process.env.CLOUD_CHECKS_BASELINE) : { handleChecks };
  await assert.rejects(module.handleChecks(ctx, request('/collector/jobs/j/complete', { method: 'POST' }), ['collector', 'jobs', 'j', 'complete'], { operationId: 'late-complete', expectedRevision: 1, outcome: 'pass' }), (err: { code: string }) => err.code === 'job_expired');
  const after = await store.read();
  assert.equal(Object.keys(after.receipts).length, 0);
  assert.equal(after.jobs.j.status, 'dispatched');
});

test('an authenticated empty workspace creates its first real project through the merged API', async () => {
  const { env } = mergedEnv();
  const controller = createProjectController({ storage: null, fetcher: (url, init) => {
    const req = request(url, init);
    req.headers.set('authorization', `Bearer ${owner.token}`);
    return worker.fetch(req, env);
  } });
  await controller.action('connect-live');
  const result = await controller.action('create-project', { goal: 'first real project' }) as { ok: boolean; projectId: string };
  assert.equal(result.ok, true, controller.error ?? '');
  assert.equal(controller.mode, 'live');
  assert.equal(controller.state.project.mode, 'live');
  assert.equal(controller.activeProjectId, result.projectId);
});

test('root agent discovery rechecks indexed projects and denies a stale index', async () => {
  let active = true;
  let reads = 0;
  const { env } = mergedEnv();
  env.ACCESS_SEAMS = { credentialProjects: async () => ['scoped-project'] };
  env.PROJECT_OBJECT = {
    idFromName: (name) => ({ toString: () => name }),
    get: () => ({ fetch: async (req) => {
      reads++;
      assert.equal(req.headers.get('authorization'), 'Bearer fixture-agent');
      return active ? Response.json({ project: { id: 'scoped-project', goal: 'allowed' } }) : Response.json({}, { status: 401 });
    } }),
  };
  const req = () => request('/api/v1/projects', { headers: { authorization: 'Bearer fixture-agent' } });
  const ok = await worker.fetch(req(), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { projects: {id: string}[] }).projects[0].id, 'scoped-project');
  active = false;
  assert.equal((await worker.fetch(req(), env)).status, 401);
  assert.equal(reads, 2);
});

test('merged root inbox uses real Directory discovery, addressed mail and live revocation', async () => {
  const { env } = mergedEnv();
  const fetchAs = (token: string, path: string, body?: Record<string, unknown>) =>
    worker.fetch(body ? post(path, body, { authorization: `Bearer ${token}` }) :
      request(path, { headers: { authorization: `Bearer ${token}` } }), env);
  const empty = await fetchAs(owner.token, '/api/v1/inbox');
  assert.equal(empty.status, 200, await empty.clone().text());
  assert.deepEqual((await empty.json() as { messages: unknown[] }).messages, []);
  const base = '/api/v1/projects/inbox-fixture';
  let res = await fetchAs(owner.token, '/api/v1/projects', {
    operationId: 'inbox-project', expectedRevision: 1, goal: 'inbox closure', id: 'inbox-fixture',
  });
  assert.equal(res.status, 201, await res.clone().text());
  res = await fetchAs(owner.token, `${base}/identities`, { operationId: 'inbox-identity', displayName: 'Inbox agent' });
  assert.equal(res.status, 201, await res.clone().text());
  const identityId = (await res.json() as { identity: { id: string } }).identity.id;
  res = await fetchAs(owner.token, `${base}/identities/${identityId}/invitations`, { operationId: 'inbox-invite', scopes: ['read'] });
  assert.equal(res.status, 201, await res.clone().text());
  const invite = (await res.json() as { token: string }).token;
  res = await fetchAs(invite, `${base}/enrollment/exchange`, { operationId: 'inbox-exchange' });
  assert.equal(res.status, 201, await res.clone().text());
  const token = (await res.json() as { token: string }).token;
  res = await fetchAs(owner.token, `${base}/tasks`, { operationId: 'inbox-task', goal: 'addressed offer', acceptanceCriteria: ['done'] });
  assert.equal(res.status, 201, await res.clone().text());
  const taskId = (await res.json() as { task: { id: string } }).task.id;
  res = await fetchAs(owner.token, `${base}/tasks/${taskId}/offers`, { operationId: 'inbox-offer', toId: identityId });
  assert.equal(res.status, 201, await res.clone().text());
  const messageId = (await res.json() as { message: { id: string } }).message.id;
  const addressed = await fetchAs(token, '/api/v1/inbox');
  assert.equal(addressed.status, 200, await addressed.clone().text());
  assert.deepEqual((await addressed.json() as { messages: {id: string}[] }).messages.map((m) => m.id), [messageId]);
  const foreign = await fetchAs(otherOwner.token, '/api/v1/inbox');
  assert.equal(foreign.status, 200);
  assert.deepEqual((await foreign.json() as { messages: unknown[] }).messages, []);
  assert.equal((await fetchAs(otherOwner.token, '/api/v1/inbox?projectId=inbox-fixture')).status, 404);
  res = await fetchAs(owner.token, `${base}/identities/${identityId}/revoke`, { operationId: 'inbox-revoke', expectedRevision: 1 });
  assert.equal(res.status, 200, await res.clone().text());
  const revoked = await fetchAs(token, '/api/v1/inbox');
  assert.equal(revoked.status, 401, await revoked.clone().text());
  assert.equal((await revoked.text()).includes(messageId), false);
});
