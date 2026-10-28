// Unit evidence for seat c-swe-04: cloud/global-inbox.ts — the root
// GET /api/v1/inbox aggregate over project Durable Objects.
//
// Runs with:
//   node --test tests/c-swe-04.test.ts   (Node >=22.18 type stripping)
//
// Other lanes' modules are genuinely absent in this seat: the tests wire
// fakes at the documented binding seams (DIRECTORY_OBJECT internal
// routes, PROJECT_OBJECT per-project fetch) and run the REAL per-project
// app (createApp + handleInbox + live authenticate) behind each project
// stub, so auth recheck, scope denial, delivery marking and pagination
// are exercised end-to-end rather than mocked.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../cloud/app.ts';
import { globalInboxFetch } from '../cloud/global-inbox.ts';
import { DIRECTORY_OBJECT_NAME, INTERNAL_REQUEST_HEADER, INTERNAL_REQUEST_VALUE } from '../cloud/directory.ts';
import { createState, json } from '../lib/core.ts';
import { authenticate, hashToken } from '../lib/identity.ts';
import { handleInbox } from '../lib/inbox.ts';
import { MemoryStore } from '../lib/store.ts';
import type { CloudEnv, CloudOwner } from '../cloud/phase04-contract.ts';
import type { Message, ProjectState } from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
const OWNER_A = 'user-a';
const OWNER_B = 'user-b';
const TOK_A = 'tok-owner-aaaa';
const TOK_B = 'tok-owner-bbbb';
const TOK_AGENT = 'agent-secret-1';

interface Rig {
  env: CloudEnv;
  stores: Map<string, MemoryStore>;
  fetchedProjects: string[];
  directoryCalls: string[];
}

function seedMessage(
  state: ProjectState,
  m: { id: string; to: string; at: string; body?: string; from?: string },
): void {
  const msg: Message = {
    id: m.id,
    projectId: state.project.id,
    revision: 1,
    createdAt: m.at,
    updatedAt: m.at,
    actorId: m.from ?? 'system',
    recipientId: m.to,
    senderId: m.from ?? 'system',
    type: 'system-notice',
    body: m.body ?? `msg ${m.id}`,
    delivery: 'queued',
  };
  state.messages[m.id] = msg;
}

async function seedAgentCredential(
  state: ProjectState,
  opts: { identityId: string; token: string; ownerId: string },
): Promise<void> {
  const at = T0;
  state.identities[opts.identityId] = {
    id: opts.identityId, projectId: state.project.id, revision: 1,
    createdAt: at, updatedAt: at, actorId: opts.ownerId,
    displayName: opts.identityId, ownerId: opts.ownerId,
    creationSource: 'test', status: 'active',
  };
  state.credentials[`cred-${opts.identityId}`] = {
    id: `cred-${opts.identityId}`, projectId: state.project.id, revision: 1,
    createdAt: at, updatedAt: at, actorId: opts.ownerId,
    identityId: opts.identityId,
    tokenHash: await hashToken(opts.token),
    scopes: ['read'],
    projectIds: [state.project.id],
    status: 'active',
  };
}

/** Real per-project app behind a binding-shaped stub. */
function projectApp(store: MemoryStore, ownerTokens: { ownerId: string; token: string }[]) {
  return createApp({
    store,
    authenticate: async (req: Request) =>
      authenticate(req, await store.read(), { ownerTokens }),
    handlers: [handleInbox],
  });
}

function makeRig(opts: {
  ownerIndex: Record<string, string[]>;
  credentialIndex?: Record<string, string[]>;
  projectIds: string[];
  brokenProjects?: Set<string>;
}): Rig {
  const ownerTokens = [
    { ownerId: OWNER_A, token: TOK_A },
    { ownerId: OWNER_B, token: TOK_B },
  ];
  const stores = new Map<string, MemoryStore>();
  const fetchedProjects: string[] = [];
  const directoryCalls: string[] = [];

  const directoryStub = {
    fetch: async (req: Request): Promise<Response> => {
      const u = new URL(req.url);
      directoryCalls.push(`${u.pathname}${u.search}`);
      assert.equal(req.headers.get(INTERNAL_REQUEST_HEADER), INTERNAL_REQUEST_VALUE);
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[3] === 'owner' && parts[5] === 'projects') {
        const ownerId = parts[4];
        const projects = (opts.ownerIndex[ownerId] ?? []).map((id) => ({
          id, ownerId, goal: id, createdAt: T0, repositoryId: `repo-${id}`,
          remote: `https://artifacts.test/${id}`, canonicalRef: 'refs/heads/together-cloud',
          provisioning: 'ready', operationId: `op-${id}`, digest: `d-${id}`,
        }));
        return json(200, { records: projects });
      }
      if (parts[3] === 'credential' && parts[5] === 'projects') {
        const digest = parts[4];
        return json(200, { projectIds: opts.credentialIndex?.[digest] ?? [] });
      }
      return json(404, { error: 'no such internal route' });
    },
  };

  const projectStubFor = (id: string) => ({
    fetch: async (req: Request): Promise<Response> => {
      fetchedProjects.push(id);
      if (opts.brokenProjects?.has(id)) {
        return json(500, { error: { status: 500, code: 'boom', message: 'store down', retryable: false } });
      }
      const store = stores.get(id);
      if (store === undefined) {
        return json(500, { error: { status: 500, code: 'uninitialized', message: 'no state', retryable: false } });
      }
      return projectApp(store, ownerTokens).fetch(req);
    },
  });

  const env: CloudEnv = {
    OWNER_TOKENS: JSON.stringify(ownerTokens),
    DIRECTORY_OBJECT: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id) => { assert.equal(id.toString(), DIRECTORY_OBJECT_NAME); return directoryStub; },
    },
    PROJECT_OBJECT: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => projectStubFor(id.toString()),
    },
  };

  for (const pid of opts.projectIds) {
    stores.set(pid, new MemoryStore(
      createState({ id: pid, goal: `goal ${pid}`, mode: 'live', now: T0 }),
    ));
  }
  return { env, stores, fetchedProjects, directoryCalls };
}

const owner = (id: string): CloudOwner => ({ id, ownerId: id });

const inboxReq = (path: string, bearer?: string) =>
  new Request(`https://cloud.test/api/v1/inbox${path}`, {
    method: 'GET',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

type InboxBody = {
  messages: (Record<string, unknown> & { id: string; projectId: string })[];
  counts: Record<string, number>;
  nextCursor: string | null;
  resync: boolean;
  projectIds: string[];
  partial?: boolean;
};

test('owner bearer aggregates own mail across projects, foreign project untouched', async () => {
  const rig = makeRig({
    ownerIndex: { [OWNER_A]: ['pa', 'pc'], [OWNER_B]: ['pb'] },
    projectIds: ['pa', 'pb', 'pc'],
  });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(pa, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  seedMessage(pa, { id: 'm-x', to: 'other-agent', at: '2026-10-04T01:30:00.000Z' });
  const pc = await rig.stores.get('pc')!.transact((d) => d);
  seedMessage(pc, { id: 'm2', to: OWNER_A, at: '2026-10-04T02:00:00.000Z' });
  const pb = await rig.stores.get('pb')!.transact((d) => d);
  seedMessage(pb, { id: 'm3', to: OWNER_B, at: '2026-10-04T03:00:00.000Z' });

  const res = await globalInboxFetch(inboxReq('', TOK_A), rig.env, owner(OWNER_A));
  assert.equal(res.status, 200);
  const body = (await res.json()) as InboxBody;
  assert.deepEqual(body.messages.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(body.messages.map((m) => m.projectId), ['pa', 'pc']);
  assert.deepEqual([...body.projectIds].sort(), ['pa', 'pc']);
  assert.equal(body.resync, false);
  assert.equal(body.nextCursor, null);
  assert.equal(body.counts.total, 2);
  // The other owner's project was never queried.
  assert.deepEqual([...rig.fetchedProjects].sort(), ['pa', 'pc']);
});

test('owner session (no bearer) discovers via directory owner index', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa'] }, projectIds: ['pa'] });
  const st = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(st, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  // A cookie-only request still reaches the project object with its
  // cookie header forwarded; per-project session resolution is c-swe-09
  // composition — here the object has no bearer, so it answers 401 and
  // the aggregate honestly returns an empty page for the owner.
  const res = await globalInboxFetch(inboxReq(''), rig.env, owner(OWNER_A));
  assert.equal(res.status, 200);
  const body = (await res.json()) as InboxBody;
  assert.equal(body.messages.length, 0);
  assert.deepEqual(body.projectIds, ['pa']);
});

test('agent credential: hashed index discovers, per-project live auth decides', async () => {
  const digest = await hashToken(TOK_AGENT);
  const rig = makeRig({
    ownerIndex: {},
    credentialIndex: { [digest]: ['pa', 'pb'] },
    projectIds: ['pa', 'pb'],
  });
  // Credential is real in pa only; the stale index also claims pb.
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  await seedAgentCredential(pa, { identityId: 'agent-1', token: TOK_AGENT, ownerId: OWNER_A });
  seedMessage(pa, { id: 'am1', to: 'agent-1', at: '2026-10-04T01:00:00.000Z' });
  const pb = await rig.stores.get('pb')!.transact((d) => d);
  seedMessage(pb, { id: 'bm1', to: 'agent-1', at: '2026-10-04T02:00:00.000Z' });

  const res = await globalInboxFetch(inboxReq('', TOK_AGENT), rig.env, null);
  assert.equal(res.status, 200);
  const body = (await res.json()) as InboxBody;
  // Only the project whose live store holds the credential yields mail;
  // the stale index claim on pb was re-authenticated and denied.
  assert.deepEqual(body.messages.map((m) => m.id), ['am1']);
  assert.deepEqual([...rig.fetchedProjects].sort(), ['pa', 'pb']);
});

test('agent credential revoked in the only indexed project answers 401', async () => {
  const digest = await hashToken(TOK_AGENT);
  const rig = makeRig({
    ownerIndex: {},
    credentialIndex: { [digest]: ['pa'] },
    projectIds: ['pa'],
  });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  await seedAgentCredential(pa, { identityId: 'agent-1', token: TOK_AGENT, ownerId: OWNER_A });
  pa.credentials['cred-agent-1'].status = 'revoked';

  const res = await globalInboxFetch(inboxReq('', TOK_AGENT), rig.env, null);
  assert.equal(res.status, 401);
});

test('valid credential absent from the index cannot discover projects', async () => {
  const rig = makeRig({ ownerIndex: {}, credentialIndex: {}, projectIds: ['pa'] });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  await seedAgentCredential(pa, { identityId: 'agent-1', token: TOK_AGENT, ownerId: OWNER_A });
  const res = await globalInboxFetch(inboxReq('', TOK_AGENT), rig.env, null);
  assert.equal(res.status, 401);
  assert.deepEqual(rig.fetchedProjects, []);
});

test('projectId filter narrows but cannot escape ownership', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa', 'pc'] }, projectIds: ['pa', 'pb', 'pc'] });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(pa, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  const pc = await rig.stores.get('pc')!.transact((d) => d);
  seedMessage(pc, { id: 'm2', to: OWNER_A, at: '2026-10-04T02:00:00.000Z' });

  const res = await globalInboxFetch(inboxReq('?projectId=pc', TOK_A), rig.env, owner(OWNER_A));
  assert.equal(res.status, 200);
  const body = (await res.json()) as InboxBody;
  assert.deepEqual(body.messages.map((m) => m.id), ['m2']);
  assert.deepEqual(rig.fetchedProjects, ['pc']);

  // A project that exists but belongs to another owner is indistinguishable
  // from a nonexistent one.
  const denied = await globalInboxFetch(inboxReq('?projectId=pb', TOK_A), rig.env, owner(OWNER_A));
  assert.equal(denied.status, 404);
  const denied2 = await globalInboxFetch(inboxReq('?projectId=ghost', TOK_A), rig.env, owner(OWNER_A));
  assert.equal(denied2.status, 404);
});

test('bounded stable pagination across projects: no dupes, no loss', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa', 'pc'] }, projectIds: ['pa', 'pc'] });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(pa, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  seedMessage(pa, { id: 'm3', to: OWNER_A, at: '2026-10-04T03:00:00.000Z' });
  const pc = await rig.stores.get('pc')!.transact((d) => d);
  seedMessage(pc, { id: 'm2', to: OWNER_A, at: '2026-10-04T02:00:00.000Z' });
  seedMessage(pc, { id: 'm4', to: OWNER_A, at: '2026-10-04T04:00:00.000Z' });

  const p1 = await globalInboxFetch(inboxReq('?limit=2', TOK_A), rig.env, owner(OWNER_A));
  const b1 = (await p1.json()) as InboxBody;
  assert.deepEqual(b1.messages.map((m) => m.id), ['m1', 'm2']);
  assert.ok(b1.nextCursor);

  const p2 = await globalInboxFetch(
    inboxReq(`?limit=2&after=${encodeURIComponent(b1.nextCursor!)}`, TOK_A),
    rig.env, owner(OWNER_A),
  );
  const b2 = (await p2.json()) as InboxBody;
  assert.deepEqual(b2.messages.map((m) => m.id), ['m3', 'm4']);
  assert.equal(b2.nextCursor, null);
  assert.equal(b2.resync, false);
});

test('pagination depth inside a single project survives the composite cursor', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa'] }, projectIds: ['pa'] });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  for (let i = 1; i <= 3; i++) {
    seedMessage(pa, { id: `m${i}`, to: OWNER_A, at: `2026-10-04T0${i}:00:00.000Z` });
  }
  const p1 = await globalInboxFetch(inboxReq('?limit=2', TOK_A), rig.env, owner(OWNER_A));
  const b1 = (await p1.json()) as InboxBody;
  assert.deepEqual(b1.messages.map((m) => m.id), ['m1', 'm2']);
  assert.ok(b1.nextCursor);
  const p2 = await globalInboxFetch(
    inboxReq(`?limit=2&after=${encodeURIComponent(b1.nextCursor!)}`, TOK_A),
    rig.env, owner(OWNER_A),
  );
  const b2 = (await p2.json()) as InboxBody;
  assert.deepEqual(b2.messages.map((m) => m.id), ['m3']);
  assert.equal(b2.nextCursor, null);
});

test('unknown cursor resyncs from the start with a marker', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa'] }, projectIds: ['pa'] });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(pa, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  const res = await globalInboxFetch(inboxReq('?after=g1.not-a-cursor', TOK_A), rig.env, owner(OWNER_A));
  const body = (await res.json()) as InboxBody;
  assert.equal(body.resync, true);
  assert.deepEqual(body.messages.map((m) => m.id), ['m1']);
});

test('GET records delivery through the real per-project endpoint', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa'] }, projectIds: ['pa'] });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(pa, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  await globalInboxFetch(inboxReq('', TOK_A), rig.env, owner(OWNER_A));
  const after = await rig.stores.get('pa')!.read();
  assert.equal(after.messages['m1'].delivery, 'delivered');
});

test('unauthenticated, wrong-owner-token and non-GET requests', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa'] }, projectIds: ['pa'] });
  // No session owner and no bearer at all.
  const anon = await globalInboxFetch(inboxReq(''), rig.env, null);
  assert.equal(anon.status, 401);
  // A bearer that is neither an owner token nor an indexed credential.
  const foreign = await globalInboxFetch(inboxReq('', 'tok-random'), rig.env, null);
  assert.equal(foreign.status, 401);
  // Owner B's token sees only owner B's projects — none here.
  const bRes = await globalInboxFetch(inboxReq('', TOK_B), rig.env, owner(OWNER_B));
  assert.equal(bRes.status, 200);
  const bBody = (await bRes.json()) as InboxBody;
  assert.equal(bBody.messages.length, 0);
  // POST is not an inbox route.
  const post = await globalInboxFetch(
    new Request('https://cloud.test/api/v1/inbox', { method: 'POST' }),
    rig.env, owner(OWNER_A),
  );
  assert.equal(post.status, 404);
});

test('a failing project object yields partial, never a silent empty page', async () => {
  const rig = makeRig({
    ownerIndex: { [OWNER_A]: ['pa', 'pz'] },
    projectIds: ['pa'],
    brokenProjects: new Set(['pz']),
  });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(pa, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  const res = await globalInboxFetch(inboxReq('', TOK_A), rig.env, owner(OWNER_A));
  assert.equal(res.status, 200);
  const body = (await res.json()) as InboxBody;
  assert.equal(body.partial, true);
  assert.deepEqual(body.messages.map((m) => m.id), ['m1']);
});

test('missing directory binding is an honest 503, not an empty inbox', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa'] }, projectIds: ['pa'] });
  const env = { ...rig.env, DIRECTORY_OBJECT: undefined };
  const res = await globalInboxFetch(inboxReq('', TOK_A), env, owner(OWNER_A));
  assert.equal(res.status, 503);
});

test('a stale per-project cursor position resyncs that project honestly', async () => {
  const rig = makeRig({ ownerIndex: { [OWNER_A]: ['pa'] }, projectIds: ['pa'] });
  const pa = await rig.stores.get('pa')!.transact((d) => d);
  seedMessage(pa, { id: 'm1', to: OWNER_A, at: '2026-10-04T01:00:00.000Z' });
  // Well-formed composite cursor naming a message that was never in pa.
  const cursor = 'g1.' + Buffer.from(JSON.stringify({ v: 1, p: { pa: 'ghost' }, d: [] }))
    .toString('base64url');
  const res = await globalInboxFetch(
    inboxReq(`?after=${encodeURIComponent(cursor)}`, TOK_A), rig.env, owner(OWNER_A),
  );
  const body = (await res.json()) as InboxBody;
  assert.equal(body.resync, true);
  assert.deepEqual(body.messages.map((m) => m.id), ['m1']);
});
