// Unit evidence for lane c-swe-07: private durable execution broker.
// Exercises ExecutionObject, enqueueExecution, waitExecution and bridgeFetch
// against an in-memory CloudStorage/namespace stand-in — no Cloudflare
// runtime, network, Git, Docker or provider is used or claimed. Original
// risks asserted: cross-purpose credential confusion, idempotent enqueue
// replay/conflict, stale/expired lease, conflicting duplicate result,
// uncertain-push redispatch, late result lineage, payload projection
// privacy, deadline expiry and durable results across object recreation.
// Runs with: node --test tests/c-swe-07.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionObject, bridgeFetch, enqueueExecution, waitExecution,
} from '../cloud/execution.ts';
import type {
  CloudEnv, CloudObjectState, CloudStorage, ExecutionInput,
} from '../cloud/phase04-contract.ts';

const GIT_TOKEN = 'fixture-git-bridge-token';
const CHECK_TOKEN = 'fixture-check-bridge-token';
const FUTURE = () => new Date(Date.now() + 60_000).toISOString();
const PAST = () => new Date(Date.now() - 1_000).toISOString();

/** In-memory CloudStorage with serialized transactions (test stand-in). */
class MemStorage implements CloudStorage {
  map = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return Promise.resolve(v === undefined ? undefined : structuredClone(v) as T);
  }
  put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) {
      if (options?.prefix === undefined || k.startsWith(options.prefix)) {
        out.set(k, structuredClone(v) as T);
      }
    }
    return Promise.resolve(out);
  }
  transaction<T>(fn: (tx: CloudStorage) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(this));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

interface Harness {
  env: CloudEnv;
  storages: Map<string, MemStorage>;
  objects: Map<string, ExecutionObject>;
}

/** Fake EXECUTION_OBJECT namespace: one object instance per project name. */
function makeHarness(): Harness {
  const storages = new Map<string, MemStorage>();
  const objects = new Map<string, ExecutionObject>();
  const env = {
    GIT_BRIDGE_TOKEN: GIT_TOKEN,
    CHECK_BRIDGE_TOKEN: CHECK_TOKEN,
    GIT_BRIDGE_PROJECT_IDS: 'p1',
    CHECK_BRIDGE_PROJECT_IDS: 'p1',
    EXECUTION_OBJECT: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => {
        const name = id.toString();
        if (!storages.has(name)) storages.set(name, new MemStorage());
        if (!objects.has(name)) {
          const state: CloudObjectState = {
            id: { name, toString: () => name },
            storage: storages.get(name)!,
          };
          objects.set(name, new ExecutionObject(state, env));
        }
        return { fetch: (r: Request) => objects.get(name)!.fetch(r) };
      },
    },
  } as unknown as CloudEnv;
  return { env, storages, objects };
}

const bridge = (env: CloudEnv, op: string, token: string | undefined, body: unknown) =>
  bridgeFetch(new Request(`https://edge.internal/internal/v1/execution/${op}`, {
    method: 'POST',
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }), env);

const jobInput = (over: Partial<ExecutionInput> = {}): ExecutionInput => ({
  key: 'op-1',
  projectId: 'p1',
  role: 'git',
  action: 'git.readTip',
  payload: { ref: 'refs/heads/together-cloud' },
  deadlineAt: FUTURE(),
  ...over,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('enqueue is validated, digest-keyed and idempotent; conflict is 409', async () => {
  const { env } = makeHarness();
  const job = await enqueueExecution(env, jobInput());
  assert.equal(job.status, 'queued');
  assert.ok(job.digest.length === 64);
  // Public projections never carry the private payload.
  assert.deepEqual(job.payload, {});

  const replay = await enqueueExecution(env, jobInput());
  assert.equal(replay.id, job.id, 'same key + same digest replays the stored job');

  await assert.rejects(
    enqueueExecution(env, jobInput({ payload: { ref: 'refs/heads/other' } })),
    (e: { code?: string }) => e.code === 'execution_key_conflict',
  );
  await assert.rejects(
    enqueueExecution(env, jobInput({ key: 'k2', role: 'check', action: 'git.push' })),
    (e: { code?: string }) => e.code === 'invalid_action',
  );
  await assert.rejects(
    enqueueExecution(env, jobInput({ key: 'k3', payload: { blob: 'x'.repeat(70 * 1024) } })),
    (e: { code?: string }) => e.code === 'payload_too_large',
  );
  await assert.rejects(
    enqueueExecution(env, jobInput({ key: 'k4', deadlineAt: 'not-a-date' })),
    (e: { code?: string }) => e.code === 'invalid_field',
  );
});

test('bridge routes require the matching purpose token, never body-asserted', async () => {
  const { env } = makeHarness();
  await enqueueExecution(env, jobInput());
  await enqueueExecution(env, jobInput({
    key: 'check-1', role: 'check', action: 'check.run', payload: { jobId: 'j9' },
  }));

  assert.equal((await bridge(env, 'pull', undefined, { projectIds: ['p1'] })).status, 401);
  assert.equal((await bridge(env, 'pull', 'wrong-token', { projectIds: ['p1'] })).status, 401);
  // Body role cannot override the purpose inferred from the bearer.
  assert.equal(
    (await bridge(env, 'pull', GIT_TOKEN, { role: 'check', projectIds: ['p1'] })).status,
    403,
  );
  // A git credential only leases git jobs.
  const gitPull = await bridge(env, 'pull', GIT_TOKEN, { role: 'git', projectIds: ['p1'] });
  assert.equal(gitPull.status, 200);
  const gitJobs = (await gitPull.json()).jobs;
  assert.equal(gitJobs.length, 1);
  assert.equal(gitJobs[0].action, 'git.readTip');
  assert.equal(gitJobs[0].payload.ref, 'refs/heads/together-cloud');
  assert.ok(typeof gitJobs[0].leaseId === 'string' && gitJobs[0].leaseId.length > 0);

  // The check job is still queued for the check credential only.
  const checkPull = await bridge(env, 'pull', CHECK_TOKEN, { role: 'check', projectIds: ['p1'] });
  const checkJobs = (await checkPull.json()).jobs;
  assert.equal(checkJobs.length, 1);
  assert.equal(checkJobs[0].action, 'check.run');

  // pull requires an explicit project allowlist.
  assert.equal((await bridge(env, 'pull', GIT_TOKEN, { role: 'git' })).status, 422);

  // Unrelated bridge/other paths are not owned here.
  assert.equal(
    (await bridgeFetch(new Request('https://edge.internal/api/v1/projects', { method: 'POST' }), env)).status,
    404,
  );
});

test('a git token cannot complete a check job (cross-purpose rejected)', async () => {
  const { env } = makeHarness();
  await enqueueExecution(env, jobInput({
    key: 'c1', role: 'check', action: 'check.run', payload: { jobId: 'job-7' },
  }));
  const pulled = (await (await bridge(env, 'pull', CHECK_TOKEN, {
    role: 'check', projectIds: ['p1'],
  })).json()).jobs[0];
  const res = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: pulled.id, leaseId: pulled.leaseId, result: { outcome: 'pass' },
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'purpose_mismatch');
});

test('completion is bound to job/lease lineage; conflicting duplicates are rejected', async () => {
  const { env } = makeHarness();
  const job = await enqueueExecution(env, jobInput());
  const pulled = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'],
  })).json()).jobs[0];
  assert.equal(pulled.id, job.id);

  // Wrong lease id never completes the job.
  const bad = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: 'lease-forgery', result: { tip: 'a'.repeat(40) },
  });
  assert.equal(bad.status, 409);

  const tip = 'b'.repeat(40);
  const ok = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: pulled.leaseId, result: { tip },
  });
  assert.equal(ok.status, 200);
  const done = (await ok.json()).job;
  assert.equal(done.status, 'completed');
  assert.equal(done.result.tip, tip);
  assert.deepEqual(done.payload, {}, 'payload is purged from the terminal job');

  // Identical replay reconciles; a conflicting second result is rejected.
  const same = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: pulled.leaseId, result: { tip },
  });
  assert.equal(same.status, 200);
  const conflict = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: pulled.leaseId, result: { tip: 'c'.repeat(40) },
  });
  assert.equal(conflict.status, 409);

  const waited = await waitExecution(env, 'p1', job.id, 500);
  assert.equal(waited.status, 'completed');
});

for (const outcome of [
  { result: { tip: 'd'.repeat(40) } },
  { error: { code: 'fixture_failure', message: 'exact failure message' } },
]) {
  test(`terminal ${'error' in outcome ? 'error' : 'success'} replay retains private lease and exact outcome across recreation`, async () => {
    const { env, objects, storages } = makeHarness();
    const job = await enqueueExecution(env, jobInput({ payload: { token: 'private-payload' } }));
    const leased = (await (await bridge(env, 'pull', GIT_TOKEN, { projectIds: ['p1'] })).json()).jobs[0];
    const body = { projectId: 'p1', jobId: job.id, leaseId: leased.leaseId, ...outcome };
    const completed = await bridge(env, 'result', GIT_TOKEN, body);
    assert.equal(completed.status, 200);
    const publicView = (await completed.json()).job;
    assert.equal(publicView.leaseId, undefined);
    assert.equal(publicView.terminalLeaseDigest, undefined);
    assert.equal(publicView.terminalOutcomeDigest, undefined);
    assert.deepEqual(publicView.payload, {});
    const stored = storages.get('p1')!.map.get(`job/${job.id}`) as Record<string, unknown>;
    assert.deepEqual(stored.payload, {});
    assert.equal(typeof stored.terminalLeaseDigest, 'string');
    assert.notEqual(stored.terminalLeaseDigest, leased.leaseId);
    objects.delete('p1');
    assert.equal((await bridge(env, 'result', GIT_TOKEN, body)).status, 200);
    assert.equal((await bridge(env, 'result', GIT_TOKEN, { ...body, leaseId: 'foreign-lease' })).status, 409);
    const conflict = 'error' in outcome ?
      { ...body, error: { ...outcome.error, message: 'different message, same code' } } :
      { ...body, result: { tip: 'e'.repeat(40) } };
    assert.equal((await bridge(env, 'result', GIT_TOKEN, conflict)).status, 409);
    if ('error' in outcome) {
      assert.equal((await bridge(env, 'result', GIT_TOKEN, { ...body, error: { ...outcome.error, code: 'different_code' } })).status, 409);
    }
  });
}

test('expiry terminal without accepted outcome cannot reconcile a late same-lease error', async () => {
  const { env, storages } = makeHarness();
  const job = await enqueueExecution(env, jobInput({ action: 'git.push' }));
  const leased = (await (await bridge(env, 'pull', GIT_TOKEN, { projectIds: ['p1'] })).json()).jobs[0];
  const stored = storages.get('p1')!.map.get(`job/${job.id}`) as Record<string, unknown>;
  stored.leasedUntil = PAST();
  const late = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: leased.leaseId,
    error: { code: 'lease_expired', message: 'consequential dispatch did not complete inside its lease; effect is unconfirmed' },
  });
  assert.equal(late.status, 409);
  assert.equal((await waitExecution(env, 'p1', job.id, 0)).status, 'effect-unconfirmed');
});

test('expired lease on a safe job requeues with fresh lineage; late result rejected', async () => {
  const { env } = makeHarness();
  const job = await enqueueExecution(env, jobInput({ action: 'git.isAncestor' }));
  const first = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'], leaseMs: 1000,
  })).json()).jobs[0];
  assert.equal(first.id, job.id);
  await sleep(1100);

  const second = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'], leaseMs: 1000,
  })).json()).jobs[0];
  assert.equal(second.id, job.id, 'safe job is redispatched');
  assert.notEqual(second.leaseId, first.leaseId, 'redispatch uses a fresh lease');
  assert.equal(second.attempts, 2);

  const stale = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: first.leaseId, result: { isAncestor: true },
  });
  assert.equal(stale.status, 409, 'late result from the lost delivery fails lineage');
  const current = await waitExecution(env, 'p1', job.id, 500);
  assert.equal(current.status, 'leased');
});

test('expired lease on consequential git.push is effect-unconfirmed, never redispatched', async () => {
  const { env } = makeHarness();
  const job = await enqueueExecution(env, jobInput({ action: 'git.push' }));
  const pulled = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'], leaseMs: 1000,
  })).json()).jobs[0];
  assert.equal(pulled.id, job.id);
  await sleep(1100);

  const again = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'],
  })).json()).jobs;
  assert.equal(again.length, 0, 'uncertain push is never redispatched');
  const final = await waitExecution(env, 'p1', job.id, 500);
  assert.equal(final.status, 'effect-unconfirmed');
  assert.equal(final.error?.code, 'lease_expired');

  // Even the original lease cannot complete after expiry.
  const late = await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: pulled.leaseId, result: { effect: 'updated' },
  });
  assert.equal(late.status, 409);
});

test('heartbeat extends the lease only for the bound lineage', async () => {
  const { env } = makeHarness();
  const job = await enqueueExecution(env, jobInput());
  const pulled = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'], leaseMs: 5000,
  })).json()).jobs[0];
  const hb = await bridge(env, 'heartbeat', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: pulled.leaseId,
  });
  assert.equal(hb.status, 200);
  const hbJob = (await hb.json()).job;
  assert.ok(Date.parse(hbJob.leasedUntil) > Date.parse(pulled.leasedUntil));
  const wrong = await bridge(env, 'heartbeat', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: 'nope',
  });
  assert.equal(wrong.status, 409);
});

test('job deadline expiry is honest: failed for safe jobs, unconfirmed for push', async () => {
  const { env } = makeHarness();
  const safe = await enqueueExecution(env, jobInput({ key: 'd1', deadlineAt: PAST() }));
  const risky = await enqueueExecution(env, jobInput({ key: 'd2', action: 'git.push', deadlineAt: PAST() }));
  const pulled = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'],
  })).json()).jobs;
  assert.equal(pulled.length, 0, 'past-deadline jobs are never dispatched');
  assert.equal((await waitExecution(env, 'p1', safe.id, 300)).status, 'failed');
  assert.equal((await waitExecution(env, 'p1', risky.id, 300)).status, 'effect-unconfirmed');
});

test('durable results survive ExecutionObject recreation', async () => {
  const { env, objects } = makeHarness();
  const job = await enqueueExecution(env, jobInput());
  const pulled = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'],
  })).json()).jobs[0];
  await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: pulled.leaseId, result: { tip: 'd'.repeat(40) },
  });
  objects.clear(); // simulate Durable Object eviction/recreation
  const reread = await waitExecution(env, 'p1', job.id, 500);
  assert.equal(reread.status, 'completed');
  assert.equal(reread.result?.tip, 'd'.repeat(40));
  assert.deepEqual(reread.payload, {});
});

test('result credential material is scrubbed from the durable record', async () => {
  const { env } = makeHarness();
  const job = await enqueueExecution(env, jobInput());
  const pulled = (await (await bridge(env, 'pull', GIT_TOKEN, {
    role: 'git', projectIds: ['p1'],
  })).json()).jobs[0];
  await bridge(env, 'result', GIT_TOKEN, {
    projectId: 'p1', jobId: job.id, leaseId: pulled.leaseId,
    result: { tip: 'e'.repeat(40), token: 'secret-cap', nested: { plaintext: 'x' } },
  });
  const stored = await waitExecution(env, 'p1', job.id, 300);
  const text = JSON.stringify(stored.result);
  assert.ok(!text.includes('secret-cap') && !text.includes('"x"'), 'no capability material stored');
  assert.equal(stored.result?.tip, 'e'.repeat(40));
});

test('outstanding-job bound and wait timeout leave honest state', async () => {
  const { env } = makeHarness();
  for (let i = 0; i < 128; i += 1) {
    await enqueueExecution(env, jobInput({ key: `bulk-${i}` }));
  }
  await assert.rejects(
    enqueueExecution(env, jobInput({ key: 'bulk-129' })),
    (e: { code?: string }) => e.code === 'execution_queue_full',
  );
  // A bounded wait on a live job returns its real status, never a fake result.
  const pending = await waitExecution(env, 'p1', 'exec-missing', 200).then(
    () => 'resolved', (e: { code?: string }) => e.code,
  );
  assert.equal(pending, 'job_not_found');
  const live = await enqueueExecution(env, jobInput({ key: 'live-1', projectId: 'p2' }));
  const waited = await waitExecution(env, 'p2', live.id, 250);
  assert.equal(waited.status, 'queued');
});

test('phase05 runtime purpose cannot lease Git/check; distinct credentials and project allowlist',async()=>{
 const {env}=makeHarness();env.RUNTIME_BRIDGE_TOKEN='fixture-runtime';env.RUNTIME_BRIDGE_PROJECT_IDS='p1';
 const job=await enqueueExecution(env,jobInput({key:'runtime-start',role:'runtime',action:'runtime.start',payload:{runId:'run-1',epoch:1},consequential:false}));
 assert.equal(job.consequential,true);
 assert.equal((await bridge(env,'pull',GIT_TOKEN,{role:'runtime',projectIds:['p1']})).status,403);
 assert.equal((await bridge(env,'pull','fixture-runtime',{role:'runtime',projectIds:['other']})).status,403);
 const pulled=(await (await bridge(env,'pull','fixture-runtime',{role:'runtime',projectIds:['p1'],leaseMs:1000})).json()).jobs[0];assert.equal(pulled.id,job.id);
 await new Promise(r=>setTimeout(r,1050));
 const next=await (await bridge(env,'pull','fixture-runtime',{role:'runtime',projectIds:['p1']})).json();assert.equal(next.jobs.length,0);assert.equal((await waitExecution(env,'p1',job.id,1)).status,'effect-unconfirmed');
 env.RUNTIME_BRIDGE_TOKEN=GIT_TOKEN;assert.equal((await bridge(env,'pull',GIT_TOKEN,{role:'git',projectIds:['p1']})).status,503);
});
test('phase05 exclusive runtime session slots and no chat bodies in broker records',async()=>{
 const {env}=makeHarness();env.RUNTIME_BRIDGE_TOKEN='fixture-runtime';env.RUNTIME_BRIDGE_PROJECT_IDS='p1';
 for(const key of ['turn-a','turn-b'])await enqueueExecution(env,jobInput({key,role:'runtime',action:'runtime.deliver',payload:{sessionId:'native-session',runId:'run',epoch:1,messageIds:['m1'],inputDigest:'digest'}}));
 const pull=async()=>await(await bridge(env,'pull','fixture-runtime',{role:'runtime',projectIds:['p1']})).json();const first=await pull();assert.equal(first.jobs.length,1);assert.equal((await pull()).jobs.length,0);
 assert.equal((await bridge(env,'result','fixture-runtime',{projectId:'p1',jobId:first.jobs[0].id,leaseId:first.jobs[0].leaseId,result:{body:'PRIVATE_CANARY'}})).status,422);
 await bridge(env,'result','fixture-runtime',{projectId:'p1',jobId:first.jobs[0].id,leaseId:first.jobs[0].leaseId,result:{status:'completed',sessionId:'native-session'}});assert.equal((await pull()).jobs.length,1);
 await assert.rejects(enqueueExecution(env,jobInput({key:'bad',role:'runtime',action:'runtime.start',payload:{command:'arbitrary shell'}})),(e:any)=>e.code==='runtime_payload');
});
