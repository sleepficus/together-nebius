// Repair-regression evidence for lane r-swe-06: inbox offer
// delivery/ack/acceptance, handoff recovery, CLI/MCP same-API plumbing and
// workspace uncertainty.
//
// Each test names the defect it pins. Runs with:
//   node --test tests/r-swe-06.test.ts   (Node >=22.18 type stripping)
// In-process fixtures only: MemoryStore, scripted Artifacts adapter, and an
// injected fetch — no network, Git, Docker, provider or cloud execution.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createState, errorResponse, safeSnapshot } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { handleAssignments } from '../lib/assignments.ts';
import { handleInbox } from '../lib/inbox.ts';
import * as inboxModule from '../lib/inbox.ts';
import { clientFromEnv } from '../adapters/client.ts';
import { main as cliMain } from '../adapters/cli.ts';
import { handleRpc } from '../adapters/mcp.ts';
import type {
  Assignment, Context, Handoff, Message, Principal, ProjectState, Task,
} from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let clock = T0;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(Date.parse(clock) + ms).toISOString();
};
let seq = 0;
const uid = () => `r6-${++seq}`;

const owner: Principal = {
  id: 'user-1', sessionId: 'sess-owner', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read'], projectIds: ['p1'],
};
const agent = (id: string, scopes: string[], projectIds = ['p1']): Principal => ({
  id, sessionId: `sess-${id}-${++seq}`, kind: 'agent', ownerId: 'user-1',
  scopes, projectIds,
});

function fixture(): { ctx: Context; store: MemoryStore } {
  const store = new MemoryStore(
    createState({ id: 'p1', goal: 'ship', mode: 'live', now: clock }),
  );
  return { ctx: { principal: owner, store, now, uid }, store };
}

function seedMember(state: ProjectState, identityId: string): void {
  state.members[`m-${identityId}`] = {
    id: `m-${identityId}`, projectId: 'p1', revision: 1,
    createdAt: clock, updatedAt: clock, actorId: 'user-1',
    identityId, kind: 'collaborator', scopes: [],
  };
  state.identities[identityId] = {
    id: identityId, projectId: 'p1', revision: 1,
    createdAt: clock, updatedAt: clock, actorId: 'user-1',
    displayName: identityId, ownerId: 'user-1', creationSource: 'test',
    status: 'active',
  };
}

const req = (path: string, init?: RequestInit) =>
  new Request(`https://x.test/api/v1/projects/p1${path}`, init);

type Handler = (
  ctx: Context, request: Request, segments: string[], body?: Record<string, unknown>,
) => Promise<Response | null>;

function call(handler: Handler, ctx: Context, method: string, path: string, body?: Record<string, unknown>) {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  return handler(ctx, req(path, { method }), segments, body) as Promise<Response>;
}

const errIs = (status: number, code?: string) => (err: { status: number; code: string }) =>
  err.status === status && (code === undefined || err.code === code);

async function makeTask(ctx: Context, goal = 'do work'): Promise<Task> {
  const res = await call(handleAssignments, ctx, 'POST', '/tasks', {
    operationId: `r6-task-${goal}-${seq}`, goal, acceptanceCriteria: ['done'],
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { task: Task }).task;
}

async function sendOffer(
  ctx: Context, taskId: string, toId: string, extra: Record<string, unknown> = {},
): Promise<Message> {
  const res = await call(handleInbox, ctx, 'POST', `/tasks/${taskId}/offers`, {
    operationId: `r6-offer-${toId}-${seq}`, toId, ...extra,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { message: Message }).message;
}

async function claimFor(
  ctx: Context, store: MemoryStore, taskId: string, p: Principal, extra: Record<string, unknown> = {},
): Promise<Assignment> {
  const task = (await store.read()).tasks[taskId];
  const res = await call(handleAssignments, { ...ctx, principal: p }, 'POST', `/tasks/${taskId}/assignments`, {
    operationId: `r6-claim-${p.id}-${seq}`, expectedRevision: task.revision, ...extra,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { assignment: Assignment }).assignment;
}

function fakeArtifacts(opts?: { failFork?: boolean }): {
  calls: { fork: number; token: number };
  adapter: NonNullable<Context['artifacts']>;
  plaintext: string;
} {
  const calls = { fork: 0, token: 0 };
  const plaintext = 'tok-r6-secret';
  return {
    calls,
    plaintext,
    adapter: {
      async readFile() { return null; },
      async fork(repositoryId: string, name?: string) {
        calls.fork += 1;
        if (opts?.failFork) throw new Error('fork backend down');
        return {
          repositoryId: `fork-${repositoryId}-${calls.fork}`,
          name: name ?? 'fork',
          remote: 'https://artifacts.example/fork.git',
        };
      },
      async createToken() {
        calls.token += 1;
        return { plaintext, expiresAt: '2026-10-04T00:15:00.000Z' };
      },
    },
  };
}

const CLI_ENV = {
  TOGETHER_BASE_URL: 'https://local.test',
  TOGETHER_TOKEN: 'cred_test',
  TOGETHER_PROJECT_ID: 'p1',
};

/**
 * In-process transport mirroring cloud/app.ts project dispatch: project
 * segments are routed to the real module handlers; the documented global
 * route GET /api/v1/inbox is routed to inboxModule.handleGlobalInbox —
 * the exact wiring the integrator adds in cloud/app.ts.
 */
function localFetch(store: MemoryStore, principal: Principal, log: { method: string; path: string }[]): typeof fetch {
  const ctx: Context = { principal, store, now, uid };
  return (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    log.push({ method: init?.method ?? 'GET', path });
    const parts = url.pathname.split('/').filter(Boolean);
    const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    try {
      // Documented global route: /api/v1/inbox (no project segment).
      if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'inbox' && parts.length === 3) {
        return await inboxModule.handleGlobalInbox(ctx, new Request(url, { method: init?.method ?? 'GET' }));
      }
      const segments = parts.slice(4);
      if ((init?.method ?? 'GET') === 'GET' && segments.length === 0) {
        const state = await store.read();
        return new Response(JSON.stringify(safeSnapshot(state, principal)), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      for (const h of [handleInbox, handleAssignments]) {
        const res = await h(ctx, new Request(url, { method: init?.method ?? 'GET', body: init?.body }), segments, body);
        if (res !== null) return res;
      }
      return new Response(JSON.stringify({ error: { code: 'route_not_found' } }), { status: 404 });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      throw err;
    }
  }) as unknown as typeof fetch;
}

// -- defect: GET /api/v1/inbox had no handler (controller HTTP 404 receipt) --

test('global inbox handler serves the documented route with own-mail scoping', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'r6-global');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); seedMember(d, 'agent-c'); return true; });
  const a = agent('agent-a', ['read']);
  const b = agent('agent-b', ['read']);
  const c = agent('agent-c', ['read']);
  await sendOffer(ctx, task.id, 'agent-a', { ttlMs: 60_000 });
  await sendOffer(ctx, task.id, 'agent-a', { ttlMs: 60_000, note: 'second' });
  await sendOffer(ctx, task.id, 'agent-b');
  // C never reads its inbox; after TTL this mail must be labeled expired.
  await sendOffer(ctx, task.id, 'agent-c', { ttlMs: 60_000 });

  const globalReq = (p: Principal, q = '') =>
    inboxModule.handleGlobalInbox(
      { ...ctx, principal: p },
      new Request(`https://x.test/api/v1/inbox${q}`, { method: 'GET' }),
    );

  // A caller without access to this project store gets the same 404 shape
  // as any other inaccessible project — nothing is leaked.
  const outsider = agent('agent-x', ['read'], []);
  await assert.rejects(globalReq(outsider), errIs(404, 'not_found'));

  // B's projection contains only B's mail.
  const bRes = await globalReq(b);
  const bBody = (await bRes.json()) as { messages: Message[] };
  assert.equal(bBody.messages.length, 1);
  assert.equal(bBody.messages[0].recipientId, 'agent-b');

  // A's read records delivery exactly like the project-scoped endpoint.
  const aRes = await globalReq(a);
  const aBody = (await aRes.json()) as {
    messages: Message[]; counts: Record<string, number>; resync: boolean;
  };
  assert.equal(aBody.messages.length, 2);
  assert.equal(aBody.messages.every((m) => m.delivery === 'delivered'), true);
  assert.equal(aBody.counts.delivered, 2);
  assert.equal(aBody.resync, false);
  const stored = (await store.read()).messages;
  assert.ok(
    Object.values(stored)
      .filter((m) => m.recipientId === 'agent-a')
      .every((m) => m.delivery === 'delivered'),
  );

  // Cursor gap returns the resync marker, same as the scoped read.
  const gapRes = await globalReq(a, '?after=ghost-id');
  const gapBody = (await gapRes.json()) as { resync: boolean; messages: Message[] };
  assert.equal(gapBody.resync, true);
  assert.ok(gapBody.messages.length >= 1);

  // Mail that expired while still queued is labeled expired, never deleted.
  advance(120_000);
  const later = await globalReq(c);
  const laterBody = (await later.json()) as {
    messages: Message[]; counts: Record<string, number>;
  };
  assert.equal(laterBody.counts.expired, 1);
  assert.equal(laterBody.messages[0].delivery, 'expired');
  assert.equal(Object.keys((await store.read()).messages).length, 4); // kept, not deleted

  // A delivered-but-past-TTL offer can no longer be accepted: explicit 409.
  const msgA = Object.values((await store.read()).messages)
    .find((m) => m.recipientId === 'agent-a') as Message;
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: a }, 'POST', `/inbox/${msgA.id}/accept`, {
      operationId: 'r6-acc-expired', expectedRevision: msgA.revision,
    }),
    errIs(409, 'offer_expired'),
  );

  // Through the transport the CLI/MCP client uses the same endpoint.
  const log: { method: string; path: string }[] = [];
  const client = clientFromEnv(CLI_ENV, localFetch(store, agent('agent-a', ['read']), log));
  const inbox = await client.inbox({ after: 'ghost-cursor' });
  assert.equal(inbox.ok, true);
});

// -- defect: workspace resume skipped the holder check; a non-holder could --
// -- replay a dispatching operation and harvest the one-time token ---------

test('workspace resume re-checks the holder; non-holder cannot harvest the token', async () => {
  const { ctx, store } = fixture();
  await store.transact((d) => {
    d.project.repositories['main'] = { role: 'canonical', remote: 'https://artifacts.example/main' };
    seedMember(d, 'agent-a');
    seedMember(d, 'agent-b');
    return true;
  });
  const task = await makeTask(ctx, 'r6-ws');
  const a = agent('agent-a', ['read', 'tasks:claim', 'workspace:write']);
  // B holds workspace:write for its own assignments but is NOT this
  // assignment's holder and holds no admin/assignments:write.
  const b = agent('agent-b', ['read', 'workspace:write']);
  const asg = await claimFor(ctx, store, task.id, a);

  // A's open hits an artifacts outage: the operation is durably recorded
  // (failed-no-effect, resumable) and the requester got an honest 503.
  const failing = fakeArtifacts({ failFork: true });
  const first = await call(
    handleInbox, { ...ctx, principal: a, artifacts: failing.adapter },
    'POST', `/assignments/${asg.id}/workspace`,
    { operationId: 'r6-ws-op', expectedRevision: 1, assignmentEpoch: 1 },
  );
  assert.equal(first.status, 503);
  assert.equal((await store.read()).operations['r6-ws-op'].effect, 'failed-no-effect');

  // B replays the exact recorded operation — the digest matches because
  // the operation record exposes everything needed to rebuild the body.
  const sneaky = fakeArtifacts();
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: b, artifacts: sneaky.adapter },
      'POST', `/assignments/${asg.id}/workspace`,
      { operationId: 'r6-ws-op', expectedRevision: 1, assignmentEpoch: 1 }),
    errIs(403, 'scope_denied'),
  );
  // Denied before any external effect: no fork, no token minted for B.
  assert.equal(sneaky.calls.fork, 0);
  assert.equal(sneaky.calls.token, 0);

  // The real holder still resumes the exact operation and gets the token once.
  const healthy = fakeArtifacts();
  const resumed = await call(
    handleInbox, { ...ctx, principal: a, artifacts: healthy.adapter },
    'POST', `/assignments/${asg.id}/workspace`,
    { operationId: 'r6-ws-op', expectedRevision: 1, assignmentEpoch: 1 },
  );
  assert.equal(resumed.status, 200);
  const body = (await resumed.json()) as { token?: { plaintext: string }; workspace: { tokenIssued: boolean } };
  assert.equal(body.token?.plaintext, healthy.plaintext);
  assert.equal(body.workspace.tokenIssued, true);
  // The stored result carries no secret; replay returns it token-free.
  const op = (await store.read()).operations['r6-ws-op'];
  assert.equal(JSON.stringify(op.result).includes(healthy.plaintext), false);
});

// -- defect: accepting a handoff message never marked the handoff accepted --

test('accepting a handoff message marks the handoff acceptedById; assignment never moves', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'r6-hand');
  const a = agent('agent-a', ['read', 'tasks:claim']);
  const b = agent('agent-b', ['read']);
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  const asg = await claimFor(ctx, store, task.id, a);

  const res = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/handoff`, {
    operationId: 'r6-ho-1', expectedRevision: 1, assignmentEpoch: asg.epoch,
    done: 'mapped the routes', next: 'wire the handler', toId: 'agent-b',
  });
  assert.equal(res.status, 201);
  const { handoff, message } = (await res.json()) as { handoff: Handoff; message: Message };

  const msg = (await store.read()).messages[message.id];
  const acc = await call(handleInbox, { ...ctx, principal: b }, 'POST', `/inbox/${message.id}/accept`, {
    operationId: 'r6-ho-acc', expectedRevision: msg.revision,
  });
  assert.equal(acc.status, 200);

  const stored = (await store.read()).handoffs[handoff.id];
  assert.equal(stored.acceptedById, 'agent-b');
  // Ownership is untouched and no new assignment appeared for B.
  assert.equal((await store.read()).tasks[task.id].currentAssignmentId, asg.id);
  assert.equal(
    Object.values((await store.read()).assignments).filter((x) => x.identityId === 'agent-b').length,
    0,
  );
});

// -- defect: a directed help request could be accepted/answered by anyone ---

test('directed help is acceptable only by the addressed recipient or an admin', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'r6-help');
  await store.transact((d) => {
    seedMember(d, 'asker'); seedMember(d, 'helper'); seedMember(d, 'rando'); return true;
  });
  const asker = agent('asker', ['read', 'help:write']);
  const helper = agent('helper', ['read', 'help:write']);
  const rando = agent('rando', ['read', 'help:write']);

  const created = await call(handleInbox, { ...ctx, principal: asker }, 'POST', `/tasks/${task.id}/help`, {
    operationId: 'r6-hp-1', question: 'directed question', toId: 'helper',
  });
  assert.equal(created.status, 201);
  const { help } = (await created.json()) as { help: { id: string } };

  // A third party cannot accept a request directed at someone else.
  let rev = (await store.read()).help[help.id].revision;
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: rando }, 'POST', `/help/${help.id}/accept`, {
      operationId: 'r6-hp-acc-x', expectedRevision: rev,
    }),
    errIs(403, 'scope_denied'),
  );
  // Nor answer it (answer on an open request implies accepting).
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: rando }, 'POST', `/help/${help.id}/answer`, {
      operationId: 'r6-hp-ans-x', expectedRevision: rev, answer: 'unsolicited',
    }),
    errIs(403, 'scope_denied'),
  );

  // The addressed helper accepts normally; the linked message is marked too.
  rev = (await store.read()).help[help.id].revision;
  const ok = await call(handleInbox, { ...ctx, principal: helper }, 'POST', `/help/${help.id}/accept`, {
    operationId: 'r6-hp-acc', expectedRevision: rev,
  });
  assert.equal(ok.status, 200);
  assert.equal((await store.read()).help[help.id].acceptedById, 'helper');

  // Broadcast help (no toId) stays open to any helper.
  const open = await call(handleInbox, { ...ctx, principal: asker }, 'POST', `/tasks/${task.id}/help`, {
    operationId: 'r6-hp-2', question: 'broadcast question',
  });
  const { help: openHelp } = (await open.json()) as { help: { id: string } };
  const openRev = (await store.read()).help[openHelp.id].revision;
  const acc2 = await call(handleInbox, { ...ctx, principal: rando }, 'POST', `/help/${openHelp.id}/accept`, {
    operationId: 'r6-hp-acc2', expectedRevision: openRev,
  });
  assert.equal(acc2.status, 200);
});

// -- defect: MCP answered request-shaped notifications (missing id member) --

test('mcp: a request without an id member is a notification and gets no response', async () => {
  const { store } = fixture();
  const client = clientFromEnv(CLI_ENV, localFetch(store, agent('agent-a', ['read']), []));

  // Valid JSON-RPC request shape, but no "id": this is a notification.
  const silent = await handleRpc(client, { jsonrpc: '2.0', method: 'ping' });
  assert.equal(silent, null);
  const silentTool = await handleRpc(client, {
    jsonrpc: '2.0', method: 'tools/call', params: { name: 'together_status', arguments: {} },
  });
  assert.equal(silentTool, null);

  // Identified requests still answer normally.
  const pong = await handleRpc(client, { jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.equal((pong as { id: number }).id, 7);
});

// -- defect: CLI dropped --flag=value forms and sent NaN for bad numbers ----

test('cli: --name=value parses, non-numeric flags are usage errors, missing positional is usage', async () => {
  const { store } = fixture();
  const log: { method: string; path: string }[] = [];
  const fetchFn = localFetch(store, agent('agent-a', ['read', 'inbox:write']), log);
  const out: string[] = [];
  const err: string[] = [];
  const io = { env: CLI_ENV, out: (s: string) => out.push(s), err: (s: string) => err.push(s), fetchFn };

  // --text=... must reach the API (the old parser dropped the value).
  await cliMain(['reply', 'm-1', '--text=hi there'], io);
  const replyCall = log.find((l) => l.path.includes('/reply'));
  assert.ok(replyCall, 'reply request was never sent — the flag value was dropped');

  // A non-numeric --task-revision is a usage error, not a 409 on NaN.
  const before = log.length;
  const code2 = await cliMain(['accept', 'm-1', '--task-revision=abc'], io);
  assert.equal(code2, 2);
  assert.equal(log.length, before); // no request was made
  assert.match(err.join('\n'), /--task-revision/);

  // A missing positional is a usage error without touching the API.
  const code3 = await cliMain(['ack'], io);
  assert.equal(code3, 2);
  assert.equal(log.length, before);
  assert.match(err.join('\n'), /MESSAGE_ID/);
});
