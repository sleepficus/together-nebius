// Lane c-swe-03 unit evidence: scoped cloud access.
//   node --test tests/c-swe-03.test.ts   (Node >=22.18 type stripping)
// or the root script: tsx --test tests/*.test.ts
//
// Cross-lane seams (cloud/directory.ts c-swe-01, cloud/sessions.ts
// c-swe-02) are substituted through the env.ACCESS_SEAMS injection point
// so these tests verify THIS lane's logic in both this scratch tree and
// the merged tree regardless of the other lanes' internal DO routes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createState } from '../lib/core.ts';
import { hashToken } from '../lib/identity.ts';
import {
  authenticateCloudRequest,
  discoverCredentialProjects,
  indexIssuedCredentials,
  type AccessSeams,
} from '../cloud/access.ts';
import type { CloudEnv, DirectoryProjectRecord } from '../cloud/phase04-contract.ts';
import type { Credential, ProjectState } from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
const OWNER_TOKEN = 'owner-secret-cswe03';
const OTHER_OWNER_TOKEN = 'other-owner-secret-cswe03';
const AGENT_TOKEN = 'cred_cswe03agent';
const COLLECTOR_TOKEN = 'cjob_cswe03collector';

const ownerTokensEnv = JSON.stringify([
  { ownerId: 'user-1', token: OWNER_TOKEN },
  { ownerId: 'user-2', token: OTHER_OWNER_TOKEN },
]);

// Presence of the binding is what flips the directory gate on; the seam
// functions are injected so the stub never receives traffic.
const DIRECTORY_OBJECT: NonNullable<CloudEnv['DIRECTORY_OBJECT']> = {
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({ fetch: async () => new Response('{}') }),
};

const record = (ownerId = 'user-1', id = 'p1'): DirectoryProjectRecord => ({
  id, ownerId, goal: 'lane03', createdAt: T0,
  repositoryId: 'repo-1', remote: 'https://artifacts.example/repo-1',
  canonicalRef: 'refs/heads/together-cloud',
  provisioning: 'ready', operationId: 'op-1', digest: 'd1',
});

function envWith(seams: Partial<AccessSeams>, extra: Partial<CloudEnv> = {}): CloudEnv {
  return {
    OWNER_TOKENS: ownerTokensEnv,
    DIRECTORY_OBJECT: DIRECTORY_OBJECT,
    ACCESS_SEAMS: seams,
    ...extra,
  };
}

const req = (path: string, init?: RequestInit) => new Request(`https://x.test${path}`, init);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function baseState(): ProjectState {
  return createState({ id: 'p1', goal: 'lane03', mode: 'live', now: T0 });
}

interface AgentFixtureOpts {
  identityOwner?: string;
  identityStatus?: 'active' | 'revoked';
  credStatus?: 'active' | 'revoked';
  credExpiresAt?: string;
  sessionId?: string;
  sessionStatus?: 'active' | 'revoked';
}

async function agentState(opts: AgentFixtureOpts = {}): Promise<ProjectState> {
  const state = baseState();
  state.identities['id-agent'] = {
    id: 'id-agent', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
    actorId: 'user-1', displayName: 'bot', ownerId: opts.identityOwner ?? 'user-1',
    creationSource: 'manual', status: opts.identityStatus ?? 'active',
  };
  if (opts.sessionId !== undefined && opts.sessionStatus !== undefined) {
    state.sessions[opts.sessionId] = {
      id: opts.sessionId, projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
      actorId: 'id-agent', identityId: 'id-agent',
      advertisedCapabilities: [], observedCapabilities: [], status: opts.sessionStatus,
    };
  }
  const cred: Credential = {
    id: 'cred-1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
    actorId: 'id-agent', identityId: 'id-agent',
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    tokenHash: await hashToken(AGENT_TOKEN),
    scopes: ['read'], projectIds: ['p1'],
    ...(opts.credExpiresAt !== undefined ? { expiresAt: opts.credExpiresAt } : {}),
    status: opts.credStatus ?? 'active',
  };
  state.credentials['cred-1'] = cred;
  return state;
}

async function collectorState(jobStatus: string): Promise<ProjectState> {
  const state = baseState();
  state.jobs['job-1'] = {
    id: 'job-1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
    actorId: 'sys', candidateId: 'cand-1', candidateSha: 'd'.repeat(40),
    command: 'npm test', status: jobStatus,
  } as ProjectState['jobs'][string];
  (state.jobs['job-1'] as { collectorTokenHash?: string }).collectorTokenHash =
    await hashToken(COLLECTOR_TOKEN);
  return state;
}

const cloudReq = (state: ProjectState, env: CloudEnv, path = '/api/v1/projects/p1', init?: RequestInit) =>
  authenticateCloudRequest(req(path, init), env, state);

test('owner token authenticates when the directory record owner matches', async () => {
  const env = envWith({ projectRecord: async () => record('user-1') });
  const p = await cloudReq(baseState(), env, '/api/v1/projects/p1', { headers: bearer(OWNER_TOKEN) });
  assert.ok(p);
  assert.equal(p.kind, 'human');
  assert.equal(p.ownerId, 'user-1');
  assert.deepEqual(p.projectIds, ['p1']);
});

test('an unrelated owner token is never authority on the project', async () => {
  const env = envWith({ projectRecord: async () => record('user-1') });
  // user-2 holds a valid configured owner token -- just not for p1.
  assert.equal(
    await cloudReq(baseState(), env, '/api/v1/projects/p1', { headers: bearer(OTHER_OWNER_TOKEN) }),
    null,
  );
});

test('a directory-bound project with no record denies every principal', async () => {
  const env = envWith({ projectRecord: async () => null });
  assert.equal(
    await cloudReq(baseState(), env, '/api/v1/projects/p1', { headers: bearer(OWNER_TOKEN) }),
    null,
  );
  const agented = await agentState({ sessionId: 'sess-1', sessionStatus: 'active' });
  assert.equal(
    await cloudReq(agented, env, '/api/v1/projects/p1', { headers: bearer(AGENT_TOKEN) }),
    null,
  );
});

test('a record naming a different project id denies', async () => {
  const env = envWith({ projectRecord: async () => record('user-1', 'p9') });
  assert.equal(
    await cloudReq(baseState(), env, '/api/v1/projects/p1', { headers: bearer(OWNER_TOKEN) }),
    null,
  );
});

test('an unreachable directory fails closed', async () => {
  const env = envWith({
    projectRecord: async () => {
      throw new Error('directory durable object unreachable');
    },
  });
  assert.equal(
    await cloudReq(baseState(), env, '/api/v1/projects/p1', { headers: bearer(OWNER_TOKEN) }),
    null,
  );
});

test('cloud authentication fails closed without a directory binding', async () => {
  const env: CloudEnv = { OWNER_TOKENS: ownerTokensEnv };
  const p = await cloudReq(baseState(), env, '/api/v1/projects/p1', { headers: bearer(OWNER_TOKEN) });
  assert.equal(p, null);
  const agented = await agentState({ sessionId: 'sess-1', sessionStatus: 'active' });
  const ap = await cloudReq(agented, env, '/api/v1/projects/p1', { headers: bearer(AGENT_TOKEN) });
  assert.equal(ap, null);
});

test('agent credential resolves live; revocation, expiry and foreign ownership deny', async () => {
  const env = envWith({ projectRecord: async () => record('user-1') });
  const live = await agentState({ sessionId: 'sess-1', sessionStatus: 'active' });
  const p = await cloudReq(live, env, '/api/v1/projects/p1', { headers: bearer(AGENT_TOKEN) });
  assert.ok(p);
  assert.equal(p.kind, 'agent');
  assert.equal(p.id, 'id-agent');

  for (const opts of [
    { sessionId: 'sess-1', sessionStatus: 'active', credStatus: 'revoked' },
    { sessionId: 'sess-1', sessionStatus: 'revoked' },
    { sessionId: 'sess-1', sessionStatus: 'active', credExpiresAt: '2020-01-01T00:00:00.000Z' },
    { sessionId: 'sess-1', sessionStatus: 'active', identityStatus: 'revoked' },
    { sessionId: 'sess-1', sessionStatus: 'active', identityOwner: 'user-2' },
  ] as AgentFixtureOpts[]) {
    assert.equal(
      await cloudReq(await agentState(opts), env, '/api/v1/projects/p1', { headers: bearer(AGENT_TOKEN) }),
      null,
      JSON.stringify(opts),
    );
  }
});

test('a credential bound to a session record that does not exist is not authenticated', async () => {
  // Regression: authenticate() previously fell through when the bound
  // sessionId pointed at an absent session record, so a credential could
  // outlive the session it was bound to.
  const env = envWith({ projectRecord: async () => record('user-1') });
  const dangling = await agentState({ sessionId: 'sess-gone' });
  assert.equal(
    await cloudReq(dangling, env, '/api/v1/projects/p1', { headers: bearer(AGENT_TOKEN) }),
    null,
  );
  // Same shape without the directory gate: still denied on live state alone.
  const local: CloudEnv = { OWNER_TOKENS: ownerTokensEnv };
  assert.equal(
    await cloudReq(dangling, local, '/api/v1/projects/p1', { headers: bearer(AGENT_TOKEN) }),
    null,
  );
});

test('collector token resolves job-scoped only; a terminal job denies', async () => {
  const env = envWith({ projectRecord: async () => record('user-1') });
  const p = await cloudReq(
    await collectorState('queued'), env,
    '/api/v1/projects/p1/collector/jobs/job-1/complete',
    { headers: bearer(COLLECTOR_TOKEN) },
  );
  assert.ok(p);
  assert.equal(p.kind, 'collector');
  assert.equal((p as { jobId?: string }).jobId, 'job-1');
  assert.deepEqual(p.scopes, ['collector']);
  assert.equal(
    await cloudReq(
      await collectorState('completed'), env,
      '/api/v1/projects/p1/collector/jobs/job-1/complete',
      { headers: bearer(COLLECTOR_TOKEN) },
    ),
    null,
  );
});

test('internal authorization-shaped headers are refused even with a valid token', async () => {
  const env = envWith({ projectRecord: async () => record('user-1') });
  for (const name of [
    'x-authorized-bootstrap', 'x-bootstrap-token', 'x-internal-auth',
    'x-internal-binding', 'x-git-bridge-token', 'x-check-bridge-token', 'x-collector-token',
  ]) {
    assert.equal(
      await cloudReq(baseState(), env, '/api/v1/projects/p1', {
        headers: { ...bearer(OWNER_TOKEN), [name]: '1' },
      }),
      null,
      name,
    );
  }
});

test('requests naming another project id, and /internal paths, are not authenticated here', async () => {
  const env = envWith({ projectRecord: async () => record('user-1') });
  assert.equal(
    await cloudReq(baseState(), env, '/api/v1/projects/p2', { headers: bearer(OWNER_TOKEN) }),
    null,
  );
  assert.equal(
    await cloudReq(baseState(), env, '/internal/v1/execution/pull', { headers: bearer(OWNER_TOKEN) }),
    null,
  );
});

test('owner browser session resolves through the session seam and is owner-checked', async () => {
  const state = baseState();
  const env = envWith({
    projectRecord: async () => record('user-1'),
    resolveOwner: async () => ({ id: 'sess-9', ownerId: 'user-1' }),
  });
  const p = await cloudReq(state, env, '/api/v1/projects/p1', { headers: { cookie: 's=abc' } });
  assert.ok(p);
  assert.equal(p.kind, 'human');
  assert.equal(p.ownerId, 'user-1');
  assert.equal(p.sessionId, 'sess-9');

  const foreign = envWith({
    projectRecord: async () => record('user-1'),
    resolveOwner: async () => ({ id: 'sess-9', ownerId: 'user-2' }),
  });
  assert.equal(await cloudReq(state, foreign, '/api/v1/projects/p1'), null);
});

test('a failed bearer never downgrades to the cookie session', async () => {
  const env = envWith({
    projectRecord: async () => record('user-1'),
    resolveOwner: async () => ({ id: 'sess-9', ownerId: 'user-1' }),
  });
  assert.equal(
    await cloudReq(baseState(), env, '/api/v1/projects/p1', { headers: bearer('not-a-real-token') }),
    null,
  );
});

test('discoverCredentialProjects hashes the bearer and returns bounded deduped ids', async () => {
  let seenDigest: string | undefined;
  let calls = 0;
  const env = envWith({
    credentialProjects: async (_env, digest) => {
      calls += 1;
      seenDigest = digest;
      return ['p1', 'p2', 'p1', '', 'x'.repeat(300)];
    },
  });
  const out = await discoverCredentialProjects(req('/api/v1/inbox', { headers: bearer(AGENT_TOKEN) }), env);
  assert.equal(calls, 1);
  assert.equal(seenDigest, await hashToken(AGENT_TOKEN));
  assert.notEqual(seenDigest, AGENT_TOKEN); // digest only, never plaintext
  assert.deepEqual(out, ['p1', 'p2']);
});

test('discoverCredentialProjects: no bearer or internal header queries nothing', async () => {
  let calls = 0;
  const env = envWith({
    credentialProjects: async () => {
      calls += 1;
      return ['p1'];
    },
  });
  assert.deepEqual(await discoverCredentialProjects(req('/api/v1/inbox'), env), []);
  assert.deepEqual(
    await discoverCredentialProjects(
      req('/api/v1/inbox', { headers: { ...bearer(AGENT_TOKEN), 'x-internal-auth': '1' } }),
      env,
    ),
    [],
  );
  assert.equal(calls, 0);
  // Unbound directory (local dev): nothing indexed, still empty not error.
  assert.deepEqual(
    await discoverCredentialProjects(req('/api/v1/inbox', { headers: bearer(AGENT_TOKEN) }), {}),
    [],
  );
});

test('discoverCredentialProjects reports index failure rather than silent emptiness', async () => {
  const env = envWith({
    credentialProjects: async () => {
      throw new Error('index durable object unreachable');
    },
  });
  await assert.rejects(
    discoverCredentialProjects(req('/api/v1/inbox', { headers: bearer(AGENT_TOKEN) }), env),
    (err: { status: number; code: string }) =>
      err.status === 503 && err.code === 'credential_index_unavailable',
  );
});

test('indexIssuedCredentials indexes only the new credential hash and returns the one-time response', async () => {
  const captured: { digest?: string; projectIds?: string[] } = {};
  const env = envWith({
    indexCredential: async (_env, digest, projectIds) => {
      captured.digest = digest;
      captured.projectIds = projectIds;
    },
  });
  const token = 'cred_onetime_value';
  const res = new Response(
    JSON.stringify({
      credentialId: 'c1', sessionId: 's1', identityId: 'id-agent',
      scopes: ['read'], projectIds: ['p1'], token,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
  const out = await indexIssuedCredentials(res, env, 'p1');
  assert.equal(out, res); // original one-time response object returned
  assert.equal(captured.digest, await hashToken(token));
  assert.notEqual(captured.digest, token);
  assert.deepEqual(captured.projectIds, ['p1']);
  const body = (await out.json()) as { token: string; credentialId: string };
  assert.equal(body.token, token); // plaintext still reaches the recipient once
});

test('indexIssuedCredentials never indexes invitations, failures or non-token bodies', async () => {
  let calls = 0;
  const env = envWith({
    indexCredential: async () => {
      calls += 1;
    },
  });
  // An invitation mint is not a credential: never indexed.
  const invite = new Response(
    JSON.stringify({ invitationId: 'i1', identityId: 'id-agent', token: 'inv_onetime', expiresAt: T0 }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
  assert.equal(await indexIssuedCredentials(invite, env, 'p1'), invite);
  // Non-success and non-JSON responses pass through untouched.
  const err = new Response(JSON.stringify({ error: {} }), { status: 409 });
  assert.equal(await indexIssuedCredentials(err, env, 'p1'), err);
  const text = new Response('not json', { status: 200 });
  assert.equal(await indexIssuedCredentials(text, env, 'p1'), text);
  assert.equal(calls, 0);
});

test('indexIssuedCredentials is best-effort: index failure still returns the issued response', async () => {
  const env = envWith({
    indexCredential: async () => {
      throw new Error('index durable object unreachable');
    },
  });
  const res = new Response(JSON.stringify({ credentialId: 'c1', token: 'cred_x' }), { status: 201 });
  const out = await indexIssuedCredentials(res, env, 'p1');
  assert.equal(out, res);
  assert.equal(((await out.json()) as { token: string }).token, 'cred_x');
});
