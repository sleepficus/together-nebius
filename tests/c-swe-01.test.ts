// Lane c-swe-01 regression tests — durable root directory/provisioning.
// Runs with: node --test tests/c-swe-01.test.ts (Node >=22.18 type stripping)
//
// Exercises the original-risk surface offline: idempotent create and
// lost-acknowledgment recovery, competing duplicate convergence, owner
// isolation, disposable repository naming/branch discipline, plaintext
// capability hygiene and the hashed credential discovery index. All
// bindings are structural fakes — no real cloud, Git or Docker evidence
// is claimed.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DirectoryObject, directoryFetch, projectRecord, ownerProjects,
  credentialProjects, indexCredential,
  DIRECTORY_OBJECT_NAME, PROJECT_INIT_PATH, INTERNAL_REQUEST_HEADER,
} from '../cloud/directory.ts';
import { createEnvelope, digestOf } from '../lib/core.ts';
import type { CloudEnv, CloudObjectState, CloudOwner, CloudStorage } from '../cloud/phase04-contract.ts';
import type { ArtifactsNamespaceLike, ArtifactsRepoLike } from '../lib/artifacts.ts';
import type { DirectoryProjectRecord } from '../cloud/phase04-contract.ts';

const t0 = '2026-10-04T00:00:00.000Z';
const owner: CloudOwner = { id: 'steve', ownerId: 'steve' };
const other: CloudOwner = { id: 'faye', ownerId: 'faye' };

/** Serialized transactional KV fake matching the CloudStorage contract. */
class FakeStorage implements CloudStorage {
  private map = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  orderLog?: string[];
  async put<T>(key: string, value: T): Promise<void> {
    this.orderLog?.push(`put:${key}`);
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return this.listFrom(this.map, options);
  }
  private listFrom<T>(map: Map<string, unknown>, options?: { prefix?: string }): Map<string, T> {
    const out = new Map<string, T>();
    for (const key of [...map.keys()].sort()) {
      if (options?.prefix === undefined || key.startsWith(options.prefix)) {
        out.set(key, structuredClone(map.get(key)) as T);
      }
    }
    return out;
  }
  transaction<T>(fn: (tx: CloudStorage) => Promise<T>): Promise<T> {
    // Serialize like a real object transaction; discard the draft on throw.
    const run = this.tail.then(async () => {
      const draft = new Map(this.map);
      const self = this;
      const tx: CloudStorage = {
        get: async <T>(k: string) => {
          const v = draft.get(k);
          return v === undefined ? undefined : (structuredClone(v) as T);
        },
        put: async <T>(k: string, v: T) => {
          self.orderLog?.push(`put:${k}`);
          draft.set(k, structuredClone(v));
        },
        delete: async (k: string) => draft.delete(k),
        list: async <T>(o?: { prefix?: string }) => self.listFrom<T>(draft, o),
        transaction: <T>(inner: (t: CloudStorage) => Promise<T>) => inner(tx),
      };
      const result = await fn(tx);
      this.map = draft;
      return result;
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  dump(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}

interface FakeRepo {
  id: string; name: string; remote: string; defaultBranch: string; status: string;
}

function fakeArtifacts(opts: { status?: string; failCreate?: boolean } = {}, order?: string[]) {
  const calls: string[] = [];
  const repos = new Map<string, FakeRepo>();
  const capFor = (repo: FakeRepo): ArtifactsRepoLike => ({
    async info() { calls.push(`info:${repo.name}`); return { ...repo }; },
    async createToken() {
      return { plaintext: `CAPPLAINTEXT-${repo.name}`, expiresAt: '2026-10-05T00:00:00.000Z' };
    },
    async fork(name: string) { return { name }; },
    async log() { return [{ sha: 'a'.repeat(40) }]; },
    async readFile() { return null; },
    [Symbol.dispose]() { calls.push(`dispose:${repo.name}`); },
  });
  const namespace: ArtifactsNamespaceLike = {
    async get(name: string) {
      calls.push(`get:${name}`);
      const repo = repos.get(name);
      if (repo === undefined) {
        throw Object.assign(new Error('repository not found'), { code: 'NOT_FOUND' });
      }
      return capFor(repo);
    },
    async create(name: string, createOpts?: { setDefaultBranch?: string }) {
      calls.push(`create:${name}`);
      order?.push(`create:${name}`);
      if (opts.failCreate) {
        throw Object.assign(new Error('binding unavailable'), { code: 'UNAVAILABLE' });
      }
      if (repos.has(name)) {
        throw Object.assign(new Error('repository already exists'), { code: 'ALREADY_EXISTS' });
      }
      const repo: FakeRepo = {
        id: `repo-id-${name}`, name,
        remote: `https://artifacts.invalid/${name}.git`,
        defaultBranch: createOpts?.setDefaultBranch ?? 'main',
        status: opts.status ?? 'ready',
      };
      repos.set(name, repo);
      return { ...repo, plaintext: `PLAINTEXT-${name}`, expiresAt: '2026-10-05T00:00:00.000Z' };
    },
  };
  return { namespace, repos, calls };
}

function fakeProjectObjects(log: string[], opts: { failInit?: boolean } = {}) {
  const inited = new Map<string, Record<string, unknown>>();
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => ({
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (
          request.method === 'POST' && url.pathname === `${PROJECT_INIT_PATH}/${id.toString()}/init` &&
          request.headers.get(INTERNAL_REQUEST_HEADER) === 'directory-object'
        ) {
          const name = id.toString();
          log.push(`project-init:${name}`);
          if (opts.failInit) {
            return new Response(JSON.stringify({ error: { code: 'init_failed' } }), { status: 500 });
          }
          const body = (await request.json()) as Record<string, unknown>;
          if (inited.has(name)) {
            if (JSON.stringify(inited.get(name)) === JSON.stringify(body)) {
              return Response.json({ alreadyInitialized: true }, { status: 200 });
            }
            return new Response(JSON.stringify({ error: { code: 'exists' } }), { status: 409 });
          }
          inited.set(name, body);
          return new Response(JSON.stringify({ initialized: true }), { status: 201 });
        }
        return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
      },
    }),
  };
  return { namespace, inited };
}

interface Harness {
  env: CloudEnv;
  storage: FakeStorage;
  artifacts: ReturnType<typeof fakeArtifacts> | undefined;
  projects: ReturnType<typeof fakeProjectObjects>;
  object: DirectoryObject;
  log: string[];
}

function harness(opts: {
  artifacts?: { status?: string; failCreate?: boolean };
  noArtifacts?: boolean;
  projects?: { failInit?: boolean };
  deps?: ConstructorParameters<typeof DirectoryObject>[2];
} = {}): Harness {
  const log: string[] = [];
  const storage = new FakeStorage();
  const artifacts = opts.noArtifacts ? undefined : fakeArtifacts(opts.artifacts, log);
  const projects = fakeProjectObjects(log, opts.projects);
  const env: CloudEnv = { PROJECT_OBJECT: projects.namespace };
  if (artifacts !== undefined) env.ARTIFACTS = artifacts.namespace;
  storage.orderLog = log;
  const state: CloudObjectState = {
    id: { name: DIRECTORY_OBJECT_NAME, toString: () => DIRECTORY_OBJECT_NAME },
    storage,
  };
  const object = new DirectoryObject(state, env, opts.deps);
  env.DIRECTORY_OBJECT = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({ fetch: (r: Request) => object.fetch(r) }),
  };
  return { env, storage, artifacts, projects, object, log };
}

function createReq(body: Record<string, unknown> | string): Request {
  return new Request('https://app.test/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function seedPendingOp(
  h: Harness, opId: string, goal: string, projectId: string,
): Promise<void> {
  // Mirrors the edge-forwarded payload: caller body plus injected ownerId.
  const digest = await digestOf({
    scope: 'projects:create', ownerId: owner.ownerId,
    body: createEnvelope({ operationId: opId, goal, ownerId: owner.ownerId }),
  });
  const record: DirectoryProjectRecord = {
    id: projectId, ownerId: owner.ownerId, goal, createdAt: t0,
    repositoryId: '', remote: '', canonicalRef: 'refs/heads/together-cloud',
    provisioning: 'pending', operationId: opId, digest,
  };
  await h.storage.transaction(async (tx) => {
    await tx.put(`project/${projectId}`, record);
    await tx.put(`idx/owner/${owner.ownerId}/${projectId}`, t0);
    await tx.put(`op/${owner.ownerId}/${opId}`, {
      operationId: opId, ownerId: owner.ownerId, digest, projectId,
      status: 'pending', createdAt: t0, updatedAt: t0,
    });
  });
}

test('create: reserves directory entry before repo effect, then inits store, then commits', async () => {
  const h = harness();
  const res = await directoryFetch(createReq({ operationId: 'op-1', goal: 'first project' }), h.env, owner);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { project: Record<string, unknown>; seeded: boolean };
  const p = body.project;
  assert.match(String(p.id), /^proj-/);
  assert.equal(p.ownerId, 'steve');
  assert.equal(p.goal, 'first project');
  assert.equal(p.mode, 'live');
  assert.equal(p.canonicalRef, 'refs/heads/together-cloud');
  assert.equal(p.provisioning, 'ready');
  assert.equal(body.seeded, false);

  const repoName = `together-cloud-${String(p.id)}`;
  assert.equal(p.repositoryId, `repo-id-${repoName}`);
  assert.equal(p.remote, `https://artifacts.invalid/${repoName}.git`);
  assert.deepEqual(h.artifacts!.calls, [`create:${repoName}`]);
  // Disposable repository only: prefixed fresh name, default branch
  // together-cloud — never template/production/main.
  const repo = h.artifacts!.repos.get(repoName)!;
  assert.equal(repo.defaultBranch, 'together-cloud');
  // Per-project store init happened on the binding with the trusted header.
  assert.deepEqual(h.log.filter((l) => l.startsWith('project-init:')),
    [`project-init:${String(p.id)}`]);
  const initBody = h.projects.inited.get(String(p.id))!;
  assert.equal(initBody.goal, 'first project');
  assert.equal(initBody.projectId, p.id);
  assert.equal(initBody.canonicalRef, 'refs/heads/together-cloud');
  assert.equal(initBody.ownerId, 'steve');
  assert.equal(initBody.repositoryId, `repo-id-${repoName}`);
  assert.equal(initBody.remote, `https://artifacts.invalid/${repoName}.git`);
  // Ordering: reservation (project/ + op/ puts) committed before create;
  // the per-project store init follows repository creation.
  const opPut = h.log.findIndex((l) => l.startsWith('put:op/'));
  const projPut = h.log.findIndex((l) => l.startsWith('put:project/'));
  const create = h.log.findIndex((l) => l.startsWith('create:'));
  const init = h.log.findIndex((l) => l.startsWith('project-init:'));
  assert.ok(opPut >= 0 && projPut >= 0 && create > opPut && create > projPut && init > create,
    `reservation before repo effect before store init: ${h.log.join(',')}`);

  const dump = h.storage.dump();
  const record = dump[`project/${String(p.id)}`] as DirectoryProjectRecord;
  assert.equal(record.operationId, 'op-1');
  // Plaintext repo capability never persisted anywhere.
  assert.equal(JSON.stringify(dump).includes(`PLAINTEXT-${repoName}`), false);
  assert.equal(JSON.stringify(body).includes('PLAINTEXT'), false);
});

test('idempotent replay: same operationId + same payload returns stored result', async () => {
  const h = harness();
  const first = await directoryFetch(createReq({ operationId: 'op-r', goal: 'g' }), h.env, owner);
  const again = await directoryFetch(createReq({ operationId: 'op-r', goal: 'g' }), h.env, owner);
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  const a = (await first.json()) as { project: { id: string } };
  const b = (await again.json()) as { project: { id: string } };
  assert.equal(a.project.id, b.project.id);
  assert.equal(h.artifacts!.calls.filter((c) => c.startsWith('create:')).length, 1);
  assert.equal(h.log.filter((l) => l.startsWith('project-init:')).length, 1);
});

test('conflict: same operationId with different payload is 409 without mutation', async () => {
  const h = harness();
  await directoryFetch(createReq({ operationId: 'op-c', goal: 'g1' }), h.env, owner);
  const res = await directoryFetch(createReq({ operationId: 'op-c', goal: 'g2' }), h.env, owner);
  assert.equal(res.status, 409);
  const err = (await res.json()) as { error: { code: string } };
  assert.equal(err.error.code, 'conflicting_operation');
  const list = await ownerProjects(h.env, 'steve');
  assert.equal(list.length, 1);
});

test('competing duplicate creates converge on one project and one repository', async () => {
  const h = harness();
  const [a, b] = await Promise.all([
    directoryFetch(createReq({ operationId: 'op-par', goal: 'same' }), h.env, owner),
    directoryFetch(createReq({ operationId: 'op-par', goal: 'same' }), h.env, owner),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const pa = (await a.json()) as { project: { id: string } };
  const pb = (await b.json()) as { project: { id: string } };
  assert.equal(pa.project.id, pb.project.id);
  assert.equal(h.artifacts!.calls.filter((c) => c.startsWith('create:')).length, 1);
  assert.equal((await ownerProjects(h.env, 'steve')).length, 1);
});

test('lost acknowledgment: prior create is recovered via real metadata, not reported failed', async () => {
  const h = harness();
  // Simulate a create that landed remotely but whose commit was lost:
  // reserved op/record with no repositoryId, while the repo actually exists.
  const projectId = 'proj-lostack';
  await seedPendingOp(h, 'op-lost', 'goal', projectId);
  const repoName = `together-cloud-${projectId}`;
  h.artifacts!.repos.set(repoName, {
    id: `repo-id-${repoName}`, name: repoName,
    remote: `https://artifacts.invalid/${repoName}.git`,
    defaultBranch: 'together-cloud', status: 'ready',
  });
  const res = await directoryFetch(createReq({ operationId: 'op-lost', goal: 'goal' }), h.env, owner);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { project: { id: string; repositoryId: string; provisioning: string } };
  assert.equal(body.project.id, projectId);
  assert.equal(body.project.provisioning, 'ready');
  assert.equal(body.project.repositoryId, `repo-id-${repoName}`);
  // The 'exists' error was reconciled through info(), not a second repo;
  // the binding capability was disposed exactly once on the way out.
  assert.deepEqual(h.artifacts!.calls,
    [`create:${repoName}`, `get:${repoName}`, `info:${repoName}`, `dispose:${repoName}`]);
});

test('retry after project-init failure recovers via stored repositoryId without recreating', async () => {
  const log: string[] = [];
  const storage = new FakeStorage();
  const artifacts = fakeArtifacts();
  const failProjects = fakeProjectObjects(log, { failInit: true });
  const env: CloudEnv = { PROJECT_OBJECT: failProjects.namespace, ARTIFACTS: artifacts.namespace };
  const state: CloudObjectState = {
    id: { name: DIRECTORY_OBJECT_NAME, toString: () => DIRECTORY_OBJECT_NAME },
    storage,
  };
  const object = new DirectoryObject(state, env);
  env.DIRECTORY_OBJECT = {
    idFromName: (n: string) => ({ toString: () => n }),
    get: () => ({ fetch: (r: Request) => object.fetch(r) }),
  };
  const first = await directoryFetch(createReq({ operationId: 'op-init', goal: 'g' }), env, owner);
  assert.equal(first.status, 503);
  const err = (await first.json()) as { error: { code: string } };
  assert.equal(err.error.code, 'project_init_failed');
  const dump = storage.dump();
  const record = Object.values(dump).find(
    (v) => typeof v === 'object' && v !== null && 'provisioning' in (v as Record<string, unknown>),
  ) as DirectoryProjectRecord;
  assert.equal(record.provisioning, 'failed');
  assert.notEqual(record.repositoryId, '');

  // Repair the binding: the retry must verify real metadata, not recreate.
  const okProjects = fakeProjectObjects(log);
  env.PROJECT_OBJECT = okProjects.namespace;
  const second = await directoryFetch(createReq({ operationId: 'op-init', goal: 'g' }), env, owner);
  assert.equal(second.status, 201);
  const body = (await second.json()) as { project: { id: string; provisioning: string } };
  assert.equal(body.project.id, record.id);
  assert.equal(body.project.provisioning, 'ready');
  assert.equal(artifacts.calls.filter((c) => c.startsWith('create:')).length, 1);
  assert.ok(artifacts.calls.some((c) => c.startsWith('info:')), 'metadata verified via info()');
});

test('repository not ready: 202 keeps provisioning pending and a later retry converges', async () => {
  const h = harness({ artifacts: { status: 'importing' } });
  const first = await directoryFetch(createReq({ operationId: 'op-imp', goal: 'g' }), h.env, owner);
  assert.equal(first.status, 202);
  const body1 = (await first.json()) as { project: { id: string; provisioning: string }; pendingReason: string };
  assert.equal(body1.project.provisioning, 'pending');
  assert.match(body1.pendingReason, /importing/);

  const repoName = `together-cloud-${body1.project.id}`;
  h.artifacts!.repos.get(repoName)!.status = 'ready';
  const second = await directoryFetch(createReq({ operationId: 'op-imp', goal: 'g' }), h.env, owner);
  assert.equal(second.status, 201);
  const body2 = (await second.json()) as { project: { id: string; provisioning: string } };
  assert.equal(body2.project.id, body1.project.id);
  assert.equal(body2.project.provisioning, 'ready');
  assert.equal(h.artifacts!.calls.filter((c) => c.startsWith('create:')).length, 1);
});

test('missing artifacts binding: 503 honestly, record failed, retryable once bound', async () => {
  const h = harness({ noArtifacts: true });
  const res = await directoryFetch(createReq({ operationId: 'op-na', goal: 'g' }), h.env, owner);
  assert.equal(res.status, 503);
  const err = (await res.json()) as { error: { code: string; retryable: boolean } };
  assert.equal(err.error.code, 'artifacts_not_ready');
  assert.equal(err.error.retryable, true);
  const list = await ownerProjects(h.env, 'steve');
  assert.equal(list.length, 1);
  assert.equal(list[0].provisioning, 'failed');

  h.env.ARTIFACTS = fakeArtifacts().namespace;
  const retry = await directoryFetch(createReq({ operationId: 'op-na', goal: 'g' }), h.env, owner);
  assert.equal(retry.status, 201);
});

test('auth and validation: null owner 401; bad payloads 422; caller ownerId ignored', async () => {
  const h = harness();
  const unauth = await directoryFetch(createReq({ operationId: 'o', goal: 'g' }), h.env, null);
  assert.equal(unauth.status, 401);

  for (const [name, body] of [
    ['missing operationId', { goal: 'g' }],
    ['missing goal', { operationId: 'o2' }],
    ['empty goal', { operationId: 'o3', goal: '   ' }],
    ['bad id', { operationId: 'o4', goal: 'g', id: '../escape' }],
    ['bad expectedRevision type', { operationId: 'o5', goal: 'g', expectedRevision: 'seven' }],
  ] as const) {
    const res = await directoryFetch(createReq(body), h.env, owner);
    assert.equal(res.status, 422, name);
  }
  // A well-formed stale creation revision is 409, matching command() semantics.
  const stale = await directoryFetch(
    createReq({ operationId: 'o5b', goal: 'g', expectedRevision: 7 }), h.env, owner);
  assert.equal(stale.status, 409);
  const notJson = await directoryFetch(createReq('{oops'), h.env, owner);
  assert.equal(notJson.status, 422);

  const res = await directoryFetch(
    createReq({ operationId: 'o6', goal: 'g', ownerId: 'mallory' }), h.env, owner);
  assert.equal(res.status, 201);
  const created = (await res.json()) as { project: { ownerId: string } };
  assert.equal(created.project.ownerId, 'steve');
});

test('owner isolation: lists are scoped; the same operationId never collides across owners', async () => {
  const h = harness();
  const a = await directoryFetch(createReq({ operationId: 'op-shared', goal: 'g' }), h.env, owner);
  const b = await directoryFetch(createReq({ operationId: 'op-shared', goal: 'g' }), h.env, other);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const idA = ((await a.json()) as { project: { id: string } }).project.id;
  const idB = ((await b.json()) as { project: { id: string } }).project.id;
  assert.notEqual(idA, idB);

  const listA = await directoryFetch(new Request('https://app.test/api/v1/projects'), h.env, owner);
  const mine = ((await listA.json()) as { projects: { id: string; ownerId: string }[] }).projects;
  assert.deepEqual(mine.map((p) => p.id), [idA]);
  const listB = await directoryFetch(new Request('https://app.test/api/v1/projects'), h.env, other);
  const theirs = ((await listB.json()) as { projects: { id: string; ownerId: string }[] }).projects;
  assert.deepEqual(theirs.map((p) => p.id), [idB]);
});

test('caller-chosen id: accepted when free + patterned, 409 when taken', async () => {
  const h = harness();
  const a = await directoryFetch(createReq({ operationId: 'o-a', goal: 'g', id: 'proj-named' }), h.env, owner);
  assert.equal(a.status, 201);
  assert.equal(((await a.json()) as { project: { id: string } }).project.id, 'proj-named');
  assert.ok(h.artifacts!.repos.has('together-cloud-proj-named'));
  const b = await directoryFetch(createReq({ operationId: 'o-b', goal: 'g', id: 'proj-named' }), h.env, owner);
  assert.equal(b.status, 409);
  const err = (await b.json()) as { error: { code: string } };
  assert.equal(err.error.code, 'project_exists');
});

test('credential index: hashed digest + project ids only, never plaintext', async () => {
  const h = harness();
  const digest = 'a'.repeat(64);
  await indexCredential(h.env, digest, ['proj-2', 'proj-1']);
  await indexCredential(h.env, digest, ['proj-3']);
  assert.deepEqual(await credentialProjects(h.env, digest), ['proj-1', 'proj-2', 'proj-3']);
  assert.deepEqual(await credentialProjects(h.env, 'b'.repeat(64)), []);

  // Plaintext is rejected at both helper and object layers.
  const is422 = (e: { status?: number; code?: string }) =>
    e.status === 422 && e.code === 'invalid_field';
  await assert.rejects(indexCredential(h.env, 'tok_secretvalue', ['proj-1']), is422);
  await assert.rejects(indexCredential(h.env, 'c'.repeat(64), ['bad id!']), is422);

  const dump = JSON.stringify(h.storage.dump());
  assert.equal(dump.includes('tok_secretvalue'), false);
});

test('projectRecord / ownerProjects helpers go through the internal binding routes', async () => {
  const h = harness();
  await directoryFetch(createReq({ operationId: 'o-h', goal: 'g' }), h.env, owner);
  const [record] = await ownerProjects(h.env, 'steve');
  const found = await projectRecord(h.env, record.id);
  assert.equal(found?.id, record.id);
  assert.equal(found?.digest.length, 64);
  assert.equal(await projectRecord(h.env, 'proj-missing'), null);
});

test('conflicting init 409 leaves directory provisioning unavailable', async () => {
  const h = harness();
  h.projects.inited.set('reserved', { goal: 'earlier' });
  // Force the created projectId by pre-seeding the op with a pending record.
  await seedPendingOp(h, 'op-pre', 'goal', 'reserved');
  const res = await directoryFetch(createReq({ operationId: 'op-pre', goal: 'goal' }), h.env, owner);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'project_init_failed');
});

test('provisionSource hook runs once repo + store are real; failure is honest, not fatal', async () => {
  const seen: string[] = [];
  const h = harness({
    deps: {
      provisionSource: async ({ record }) => {
        seen.push(record.repositoryId);
        return { seeded: true };
      },
    },
  });
  const res = await directoryFetch(createReq({ operationId: 'op-seed', goal: 'g' }), h.env, owner);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { project: { repositoryId: string }; seeded: boolean };
  assert.equal(body.seeded, true);
  assert.deepEqual(seen, [body.project.repositoryId]);

  const throwing = harness({
    deps: { provisionSource: async () => { throw new Error('seed backend down'); } },
  });
  const res2 = await directoryFetch(createReq({ operationId: 'op-seed2', goal: 'g' }), throwing.env, owner);
  assert.equal(res2.status, 201);
  const body2 = (await res2.json()) as { seeded: boolean; seedError: string; project: { provisioning: string } };
  assert.equal(body2.seeded, false);
  assert.equal(body2.seedError, 'seed backend down');
  assert.equal(body2.project.provisioning, 'ready');
});

test('internal routes refuse requests without the trusted internal header', async () => {
  const h = harness();
  const res = await h.object.fetch(
    new Request(`https://directory.internal/internal/v1/directory/project/x`),
  );
  assert.equal(res.status, 404);
});

test('unconfigured bindings fail closed: helpers 503, edge 503', async () => {
  const env: CloudEnv = {};
  assert.equal((await directoryFetch(new Request('https://app.test/api/v1/projects'), env, owner)).status, 503);
  assert.equal(await projectRecord(env, 'proj-1').then(() => 'ok', (e: { status: number }) => e.status), 503);
  assert.equal(await ownerProjects(env, 'steve').then(() => 'ok', (e: { status: number }) => e.status), 503);
  assert.equal(await credentialProjects(env, 'a'.repeat(64)).then(() => 'ok', (e: { status: number }) => e.status), 503);
  assert.equal(await indexCredential(env, 'a'.repeat(64), ['proj-1']).then(() => 'ok', (e: { status: number }) => e.status), 503);
});
