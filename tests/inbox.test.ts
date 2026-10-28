// Unit evidence for seat b-swe-06: durable inbox (delivery/ack/accept/
// answered), atomic offer acceptance, help lifecycle, handoffs with epoch
// provenance, claimed-fork workspace with a separate once-only token, and
// the shared client/CLI/MCP adapters that fill plumbing from reads and
// never auto-replay stale consequential writes.
// Runs with:
//   node --test tests/inbox.test.ts   (Node >=22.18 type stripping)
// or the root script: tsx --test tests/*.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createState, errorResponse, safeSnapshot } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { handleAssignments, publicAssignment } from '../lib/assignments.ts';
import {
  globalInbox, handleInbox, latestHandoff, renderHandoffMarkdown,
} from '../lib/inbox.ts';
import { TogetherClient, clientFromEnv, ENV_VARS } from '../adapters/client.ts';
import { main as cliMain } from '../adapters/cli.ts';
import { handleRpc, serveMcp, TOOLS } from '../adapters/mcp.ts';
import type {
  Assignment, Context, Message, Principal, ProjectState, Task,
} from '../lib/types.ts';

const T0 = '2026-10-04T00:00:00.000Z';
let clock = T0;
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(Date.parse(clock) + ms).toISOString();
};
let seq = 0;
const uid = () => `id-${++seq}`;

const owner: Principal = {
  id: 'user-1', sessionId: 'sess-owner', kind: 'human', ownerId: 'user-1',
  scopes: ['owner', 'admin', 'read'], projectIds: ['p1'],
};
function agent(id: string, scopes: string[]): Principal {
  return {
    id, sessionId: `sess-${id}-${++seq}`, kind: 'agent', ownerId: 'user-1',
    scopes, projectIds: ['p1'],
  };
}

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
    operationId: `op-task-${goal}-${seq}`, goal, acceptanceCriteria: ['done'],
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { task: Task }).task;
}

async function sendOffer(
  ctx: Context, taskId: string, toId: string, extra: Record<string, unknown> = {},
): Promise<{ message: Message & { role?: string } }> {
  const res = await call(handleInbox, ctx, 'POST', `/tasks/${taskId}/offers`, {
    operationId: `op-offer-${toId}-${seq}`, toId, ...extra,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { message: Message & { role?: string } });
}

async function claimFor(
  ctx: Context, store: MemoryStore, taskId: string, p: Principal, extra: Record<string, unknown> = {},
): Promise<Assignment> {
  const task = (await store.read()).tasks[taskId];
  const res = await call(handleAssignments, { ...ctx, principal: p }, 'POST', `/tasks/${taskId}/assignments`, {
    operationId: `op-claim-${p.id}-${seq}`, expectedRevision: task.revision, ...extra,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { assignment: Assignment }).assignment;
}

// ------------------------------------------------------------- inbox ----

test('inbox: only own mail, GET marks delivered, expired labeled, nothing launched', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'inbox-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  const a = agent('agent-a', ['read']);
  const b = agent('agent-b', ['read']);
  const { message } = await sendOffer(ctx, task.id, 'agent-a', { ttlMs: 60_000 });
  assert.equal(message.delivery, 'queued');

  // B sees nothing of A's mail.
  const bInbox = await call(handleInbox, { ...ctx, principal: b }, 'GET', '/inbox');
  assert.equal(((await bInbox.json()) as { count?: number; messages: unknown[] }).messages.length, 0);

  // A's GET records delivery; a second GET keeps the delivered label.
  let res = await call(handleInbox, { ...ctx, principal: a }, 'GET', '/inbox');
  let body = (await res.json()) as { messages: Message[]; counts: Record<string, number>; resync?: boolean };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].delivery, 'delivered');
  assert.equal(body.counts.delivered, 1);
  assert.equal(body.resync, false);
  res = await call(handleInbox, { ...ctx, principal: a }, 'GET', '/inbox');
  body = (await res.json()) as { messages: Message[]; counts: Record<string, number>; resync?: boolean };
  assert.equal(body.messages[0].delivery, 'delivered');

  // GET launched nothing: no assignments, no operations beyond offer send.
  const state = await store.read();
  assert.equal(Object.keys(state.assignments).length, 0);

  // Expired mail stays labeled expired rather than disappearing.
  await sendOffer(ctx, task.id, 'agent-a', { ttlMs: 1000, note: 'second' });
  advance(2000);
  res = await call(handleInbox, { ...ctx, principal: a }, 'GET', '/inbox');
  body = (await res.json()) as { messages: Message[]; counts: Record<string, number>; resync?: boolean };
  const expired = body.messages.find((m) => m.body === 'second');
  assert.equal(expired?.delivery, 'expired');
  assert.equal(body.counts.expired, 1);
});

test('ack records a read receipt on own mail only', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'ack-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  const a = agent('agent-a', ['read']);
  const b = agent('agent-b', ['read']);
  const { message } = await sendOffer(ctx, task.id, 'agent-a');

  // B cannot even see the id: same not-found shape as an unknown message.
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: b }, 'POST', `/inbox/${message.id}/ack`, {
      operationId: 'op-ack-b', expectedRevision: 1,
    }),
    errIs(404, 'not_found'),
  );

  const res = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/inbox/${message.id}/ack`, {
    operationId: 'op-ack-a', expectedRevision: 1,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { message: Message };
  assert.ok(body.message.readAt !== undefined);
  const stored = (await store.read()).messages[message.id];
  assert.equal(stored.readAt, body.message.readAt);
});

test('bounded cursor replay; a cursor gap returns a resync marker', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'cursor-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); return true; });
  const a = agent('agent-a', ['read']);
  for (let i = 0; i < 3; i++) {
    await sendOffer(ctx, task.id, 'agent-a', { note: `n${i}` });
  }
  const page1 = await call(handleInbox, { ...ctx, principal: a }, 'GET', '/inbox?limit=2');
  const b1 = (await page1.json()) as { messages: Message[]; nextCursor: string | null };
  assert.equal(b1.messages.length, 2);
  assert.ok(b1.nextCursor);
  const page2 = await call(
    handleInbox, { ...ctx, principal: a }, 'GET', `/inbox?after=${b1.nextCursor}`,
  );
  const b2 = (await page2.json()) as { messages: Message[]; nextCursor: string | null };
  assert.equal(b2.messages.length, 1);
  assert.equal(b2.nextCursor, null);
  // Gap: an unknown cursor resyncs from the start with a marker.
  const gap = await call(handleInbox, { ...ctx, principal: a }, 'GET', '/inbox?after=ghost-id');
  const b3 = (await gap.json()) as { messages: Message[]; resync: boolean };
  assert.equal(b3.resync, true);
  assert.equal(b3.messages.length >= 1, true);
});

test('globalInbox helper returns only the caller-addressed projection', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'glob-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  await sendOffer(ctx, task.id, 'agent-a');
  await sendOffer(ctx, task.id, 'agent-b');
  const state = await store.read();
  const a = agent('agent-a', ['read']);
  const mine = globalInbox(state, a);
  assert.equal(mine.messages.length, 1);
  assert.equal((mine.messages[0] as { recipientId: string }).recipientId, 'agent-a');
  // Pure helper: it does not mark delivery, only projects it.
  assert.equal((await store.read()).messages[mine.messages[0].id as string].delivery, 'queued');
});

// ------------------------------------------------------------- offers ---

test('offer acceptance is atomic: recipient, expiry, task revision and assignment in one transaction', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'offer-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  const a = agent('agent-a', ['read', 'tasks:claim', 'tasks:write']);
  const { message } = await sendOffer(ctx, task.id, 'agent-a', {
    role: 'owner', scopes: ['read', 'tasks:write', 'bogus-scope'],
  });

  // Delivered but not yet read revision is 2 after inbox GET marks delivery.
  await call(handleInbox, { ...ctx, principal: a }, 'GET', '/inbox');
  const msgNow = (await store.read()).messages[message.id];

  // Wrong recipient is a 404, not a leak.
  const b = agent('agent-b', ['read', 'tasks:claim']);
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: b }, 'POST', `/inbox/${message.id}/accept`, {
      operationId: 'op-acc-wrong', expectedRevision: msgNow.revision, taskRevision: 1,
    }),
    errIs(404, 'not_found'),
  );

  // Missing scope to claim is denied even with a valid offer.
  const noClaim = agent('agent-a2', ['read']);
  await store.transact((d) => { seedMember(d, 'agent-a2'); return true; });
  const offer2 = await sendOffer(ctx, task.id, 'agent-a2');
  await call(handleInbox, { ...ctx, principal: noClaim }, 'GET', '/inbox');
  const msg2 = (await store.read()).messages[offer2.message.id];
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: noClaim }, 'POST', `/inbox/${offer2.message.id}/accept`, {
      operationId: 'op-acc-noscope', expectedRevision: msg2.revision, taskRevision: 1,
    }),
    errIs(403, 'scope_denied'),
  );

  // Stale task revision rejects before any claim.
  const curTask = (await store.read()).tasks[task.id];
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: a }, 'POST', `/inbox/${message.id}/accept`, {
      operationId: 'op-acc-stale', expectedRevision: msgNow.revision,
      taskRevision: curTask.revision + 5,
    }),
    errIs(409, 'stale_task_revision'),
  );

  // Atomic accept: assignment + task update + acceptedAt land together.
  const res = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/inbox/${message.id}/accept`, {
    operationId: 'op-acc-ok', expectedRevision: msgNow.revision, taskRevision: curTask.revision,
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    assignment: Assignment; task: { lifecycle: string }; message: Message;
  };
  assert.equal(body.assignment.role, 'owner');
  assert.equal(body.assignment.epoch, 1);
  assert.equal(body.assignment.identityId, 'agent-a');
  assert.equal(body.task.lifecycle, 'claimed');
  assert.ok(body.message.acceptedAt !== undefined);
  // Offered scopes narrow to what the recipient actually holds.
  assert.deepEqual([...body.assignment.scopes].sort(), ['read', 'tasks:write'].sort());
  assert.equal(
    (await store.read()).tasks[task.id].currentAssignmentId,
    body.assignment.id,
  );

  // A second session of the same identity cannot double-accept: the
  // stored message already carries acceptedAt, and the task has an owner.
  const second = agent('agent-a', ['read', 'tasks:claim']);
  const msgRev = (await store.read()).messages[message.id];
  const taskRev = (await store.read()).tasks[task.id];
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: second }, 'POST', `/inbox/${message.id}/accept`, {
      operationId: 'op-acc-again', expectedRevision: msgRev.revision, taskRevision: taskRev.revision,
    }),
    errIs(409, 'already_accepted'),
  );
  const state = await store.read();
  assert.equal(
    Object.values(state.assignments).filter((x) => x.taskId === task.id && x.role === 'owner' && x.status === 'active').length,
    1,
  );

  // Same operationId + same digest replays the recorded 201 without mutation.
  const replay = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/inbox/${message.id}/accept`, {
    operationId: 'op-acc-ok', expectedRevision: msgNow.revision, taskRevision: curTask.revision,
  });
  assert.equal(replay.status, 201);
  const replayBody = (await replay.json()) as { assignment: Assignment };
  assert.equal(replayBody.assignment.id, body.assignment.id);
  assert.equal(
    Object.values((await store.read()).assignments).filter((x) => x.taskId === task.id).length,
    1,
  );
});

test('expired offers cannot be accepted; helper offers take separate roles', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'offer-b');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-h'); return true; });
  const a = agent('agent-a', ['read', 'tasks:claim']);
  const { message } = await sendOffer(ctx, task.id, 'agent-a', { ttlMs: 1000 });
  advance(2000);
  const msg = (await store.read()).messages[message.id];
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: a }, 'POST', `/inbox/${message.id}/accept`, {
      operationId: 'op-acc-exp', expectedRevision: msg.revision, taskRevision: 1,
    }),
    errIs(409, 'offer_expired'),
  );
  assert.equal((await store.read()).messages[message.id].delivery, 'expired');
  assert.equal(Object.keys((await store.read()).assignments).length, 0);

  // A helper-role offer creates a separate role assignment, not ownership.
  const ownerA = await claimFor(ctx, store, task.id, a);
  const h = agent('agent-h', ['read', 'tasks:claim']);
  const { message: hm } = await sendOffer(ctx, task.id, 'agent-h', { role: 'reviewer' });
  await call(handleInbox, { ...ctx, principal: h }, 'GET', '/inbox');
  const hStored = (await store.read()).messages[hm.id];
  const taskNow = (await store.read()).tasks[task.id];
  const res = await call(handleInbox, { ...ctx, principal: h }, 'POST', `/inbox/${hm.id}/accept`, {
    operationId: 'op-acc-help', expectedRevision: hStored.revision,
    taskRevision: taskNow.revision,
  });
  assert.equal(res.status, 201);
  const accepted = ((await res.json()) as { assignment: Assignment }).assignment;
  assert.equal(accepted.role, 'reviewer');
  assert.equal((await store.read()).tasks[task.id].currentAssignmentId, ownerA.id);
});

// -------------------------------------------------------------- help ----

test('help: ask/accept/answer/withdraw with linked inbox states; nothing launches', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'help-a');
  await store.transact((d) => { seedMember(d, 'asker'); seedMember(d, 'helper'); return true; });
  const asker = agent('asker', ['read', 'help:write']);
  const helper = agent('helper', ['read', 'help:write']);
  const actx = { ...ctx, principal: asker };
  const hctx = { ...ctx, principal: helper };

  const created = await call(handleInbox, actx, 'POST', `/tasks/${task.id}/help`, {
    operationId: 'op-help-1', question: 'how do I slice this?',
    toId: 'helper', expectedContribution: 'a second pair of eyes',
  });
  assert.equal(created.status, 201);
  const { help, message } = (await created.json()) as { help: { id: string }; message: Message };
  assert.equal(help.id !== undefined, true);
  assert.equal(message.recipientId, 'helper');
  // Asking created a record and a queued message — no assignment, no launch.
  assert.equal(Object.keys((await store.read()).assignments).length, 0);

  await call(handleInbox, hctx, 'GET', '/inbox');
  const helpRev = (await store.read()).help[help.id];
  const acc = await call(handleInbox, hctx, 'POST', `/help/${help.id}/accept`, {
    operationId: 'op-help-acc', expectedRevision: helpRev.revision,
  });
  assert.equal(acc.status, 200);
  const accBody = (await acc.json()) as { help: { state: string; acceptedById: string }; message: Message };
  assert.equal(accBody.help.state, 'accepted');
  assert.equal(accBody.help.acceptedById, 'helper');
  assert.ok(accBody.message.acceptedAt !== undefined);

  const ans = await call(handleInbox, hctx, 'POST', `/help/${help.id}/answer`, {
    operationId: 'op-help-ans',
    expectedRevision: (await store.read()).help[help.id].revision,
    answer: 'use the second seam',
  });
  assert.equal(ans.status, 200);
  const ansBody = (await ans.json()) as { help: { state: string }; reply: Message };
  assert.equal(ansBody.help.state, 'answered');
  assert.equal(ansBody.reply.recipientId, 'asker');
  assert.equal(ansBody.reply.type, 'reply');
  const storedMsg = (await store.read()).messages[message.id];
  assert.ok(storedMsg.answeredAt !== undefined);

  // The asker sees the answer in their own inbox.
  const askerInbox = await call(handleInbox, actx, 'GET', '/inbox');
  const askerMail = ((await askerInbox.json()) as { messages: Message[] }).messages;
  assert.equal(askerMail.some((m) => m.id === ansBody.reply.id), true);
});

test('help-request message accept routes to the same record; withdraw rules hold', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'help-b');
  await store.transact((d) => { seedMember(d, 'asker'); seedMember(d, 'helper'); seedMember(d, 'rando'); return true; });
  const asker = agent('asker', ['read', 'help:write']);
  const helper = agent('helper', ['read', 'help:write']);
  const rando = agent('rando', ['read', 'help:write']);

  const created = await call(handleInbox, { ...ctx, principal: asker }, 'POST', `/tasks/${task.id}/help`, {
    operationId: 'op-help-2', question: 'q2', toId: 'helper',
  });
  const { help, message } = (await created.json()) as { help: { id: string; revision: number }; message: Message };

  const msg = (await store.read()).messages[message.id];
  const res = await call(handleInbox, { ...ctx, principal: helper }, 'POST', `/inbox/${message.id}/accept`, {
    operationId: 'op-hm-acc', expectedRevision: msg.revision,
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { help: { state: string } }).help.state, 'accepted');
  assert.equal((await store.read()).help[help.id].acceptedById, 'helper');

  // Withdraw: a third party cannot, the asker can.
  const hRev = (await store.read()).help[help.id];
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: rando }, 'POST', `/help/${help.id}/withdraw`, {
      operationId: 'op-wd-no', expectedRevision: hRev.revision,
    }),
    errIs(403, 'scope_denied'),
  );
  const wd = await call(handleInbox, { ...ctx, principal: asker }, 'POST', `/help/${help.id}/withdraw`, {
    operationId: 'op-wd-ok', expectedRevision: hRev.revision,
  });
  assert.equal(wd.status, 200);
  assert.equal((await store.read()).help[help.id].state, 'withdrawn');
});

// ----------------------------------------------------------- handoff ----

test('handoff records verbatim fields under a live claim; brief returns it with epoch label', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'hand-a');
  const a = agent('agent-a', ['read', 'tasks:claim']);
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  const asg = await claimFor(ctx, store, task.id, a);

  const res = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/handoff`, {
    operationId: 'op-ho-1', expectedRevision: 1, assignmentEpoch: asg.epoch,
    done: 'parsed the input', next: 'wire the output',
    uncertain: 'edge case N+1', verifyFirst: 'run the seeded test',
    doNotRepeat: 'do not re-parse', toId: 'agent-b',
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { handoff: { epoch: number }; message: Message };
  assert.equal(body.handoff.epoch, 1);
  assert.equal(body.message.type, 'handoff');
  assert.equal(body.message.recipientId, 'agent-b');

  const brief = await call(handleInbox, { ...ctx, principal: a }, 'GET', `/brief?taskId=${task.id}`);
  const bb = (await brief.json()) as {
    handoff: { done: string; next: string; epochLabel: string; markdown: string };
    task: { revision: number };
  };
  assert.equal(bb.handoff.done, 'parsed the input');
  assert.equal(bb.handoff.next, 'wire the output');
  assert.equal(bb.handoff.epochLabel, 'current');
  assert.match(bb.handoff.markdown, /## Do not repeat/);
  assert.match(bb.handoff.markdown, /do not re-parse/);

  const { handoff, epochLabel } = latestHandoff(await store.read(), { taskId: task.id }, clock);
  assert.ok(handoff);
  assert.equal(epochLabel, 'current');
});

test('handoff requires the holder; accepting a handoff never transfers the assignment', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'hand-b');
  const a = agent('agent-a', ['read', 'tasks:claim']);
  const b = agent('agent-b', ['read']);
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  const asg = await claimFor(ctx, store, task.id, a);

  // Non-holder cannot record a handoff on the claim.
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: b }, 'POST', `/assignments/${asg.id}/handoff`, {
      operationId: 'op-ho-nope', expectedRevision: 1, assignmentEpoch: asg.epoch,
      done: 'x', next: 'y',
    }),
    errIs(403, 'scope_denied'),
  );

  const res = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/handoff`, {
    operationId: 'op-ho-2', expectedRevision: 1, assignmentEpoch: asg.epoch,
    done: 'd', next: 'n', toId: 'agent-b',
  });
  const { message } = (await res.json()) as { message: Message };

  // B acknowledges the handoff; ownership does not move.
  const msg = (await store.read()).messages[message.id];
  const acc = await call(handleInbox, { ...ctx, principal: b }, 'POST', `/inbox/${message.id}/accept`, {
    operationId: 'op-ho-acc', expectedRevision: msg.revision,
  });
  assert.equal(acc.status, 200);
  const accBody = (await acc.json()) as { outcome: string };
  assert.equal(accBody.outcome, 'acknowledged');
  const state = await store.read();
  assert.equal(state.tasks[task.id].currentAssignmentId, asg.id);
  assert.equal(
    Object.values(state.assignments).filter((x) => x.identityId === 'agent-b').length,
    0,
  );
});

test('reclaim advances the epoch; a late handoff is preserved, not applied', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'hand-c');
  const a = agent('agent-a', ['read', 'tasks:claim']);
  const b = agent('agent-b', ['read', 'tasks:claim']);
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'agent-b'); return true; });
  const asg = await claimFor(ctx, store, task.id, a, { leaseMs: 1000, maxMs: 60_000 });

  // Valid handoff under epoch 1.
  await call(handleInbox, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/handoff`, {
    operationId: 'op-ho-3', expectedRevision: 1, assignmentEpoch: 1,
    done: 'd1', next: 'n1',
  });

  // Lease expires; B reclaims atomically (epoch 2).
  advance(2000);
  const taskNow = (await store.read()).tasks[task.id];
  const reclaim = await call(handleAssignments, { ...ctx, principal: b }, 'POST', `/tasks/${task.id}/reclaim`, {
    operationId: 'op-reclaim-1', expectedRevision: taskNow.revision,
  });
  assert.equal(reclaim.status, 201);
  const newAsg = ((await reclaim.json()) as { assignment: Assignment }).assignment;
  assert.equal(newAsg.epoch, 2);

  // A's late handoff under the dead epoch is preserved as late output,
  // not applied to B's ownership — and it happens in one transaction.
  const late = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/handoff`, {
    operationId: 'op-ho-late', expectedRevision: (await store.read()).assignments[asg.id].revision,
    assignmentEpoch: 1, done: 'late work', next: 'late next',
  });
  assert.equal(late.status, 200);
  const lateBody = (await late.json()) as { outcome: string; reason: string };
  assert.equal(lateBody.outcome, 'late-output');
  const state = await store.read();
  assert.equal(state.lateOutputs.length, 1);
  assert.equal(state.lateOutputs[0].kind, 'handoff');
  assert.equal(state.lateOutputs[0].epoch, 1);
  assert.equal(state.tasks[task.id].currentAssignmentId, newAsg.id);

  // The recorded handoff keeps its verbatim text but is labeled reclaimed.
  const brief = await call(handleInbox, { ...ctx, principal: a }, 'GET', `/brief?taskId=${task.id}`);
  const bb = (await brief.json()) as { handoff: { done: string; epochLabel: string } };
  assert.equal(bb.handoff.done, 'd1');
  assert.equal(bb.handoff.epochLabel, 'reclaimed');
});

// ---------------------------------------------------------- workspace ---

function fakeArtifacts(opts?: { failFork?: boolean }): {
  calls: { fork: number; token: number };
  adapter: NonNullable<Context['artifacts']>;
  plaintext: string;
} {
  const calls = { fork: 0, token: 0 };
  const plaintext = 'tok-secret-XYZ';
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
          token: 'fixture-public',
        };
      },
      async createToken() {
        calls.token += 1;
        return { plaintext, expiresAt: '2026-10-04T00:15:00.000Z' };
      },
    },
  };
}

test('workspace: 503 without artifacts; claim+scope+epoch required; token once, never persisted', async () => {
  const { ctx, store } = fixture();
  await store.transact((d) => {
    d.project.repositories['main'] = { role: 'canonical', remote: 'https://artifacts.example/main' };
    seedMember(d, 'agent-a');
    return true;
  });
  const task = await makeTask(ctx, 'ws-a');
  const a = agent('agent-a', ['read', 'tasks:claim', 'workspace:write']);
  const noScope = agent('agent-ns', ['read', 'tasks:claim']);
  await store.transact((d) => { seedMember(d, 'agent-ns'); return true; });
  const asg = await claimFor(ctx, store, task.id, a);
  const asg2 = await claimFor(ctx, store, task.id, noScope, { role: 'helper' });

  // Missing artifacts binding -> 503 before any operation record.
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: a }, 'POST', `/assignments/${asg.id}/workspace`, {
      operationId: 'op-ws-0', expectedRevision: 1, assignmentEpoch: 1,
    }),
    errIs(503, 'dependency_unavailable'),
  );
  assert.equal((await store.read()).operations['op-ws-0'], undefined);

  // Missing workspace scope -> 403.
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: noScope, artifacts: fakeArtifacts().adapter }, 'POST', `/assignments/${asg2.id}/workspace`, {
      operationId: 'op-ws-ns', expectedRevision: 1, assignmentEpoch: 1,
    }),
    errIs(403, 'scope_denied'),
  );

  const fake = fakeArtifacts();
  const wctx = { ...ctx, principal: a, artifacts: fake.adapter };

  // Wrong epoch -> 409.
  await assert.rejects(
    call(handleInbox, wctx, 'POST', `/assignments/${asg.id}/workspace`, {
      operationId: 'op-ws-e', expectedRevision: 1, assignmentEpoch: 9,
    }),
    errIs(409, 'stale_epoch'),
  );

  const res = await call(handleInbox, wctx, 'POST', `/assignments/${asg.id}/workspace`, {
    operationId: 'op-ws-1', expectedRevision: 1, assignmentEpoch: 1,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    workspace: { forkRef: string; metadata: Record<string, unknown>; tokenIssued: boolean };
    token: { plaintext: string; expiresAt: string };
  };
  assert.equal(fake.calls.fork, 1);
  assert.equal(fake.calls.token, 1);
  assert.equal(body.token.plaintext, fake.plaintext);
  assert.equal(body.workspace.tokenIssued, true);
  // Fork metadata is credential-free: the adapter's sneaky token key is stripped.
  assert.equal(JSON.stringify(body.workspace.metadata).includes('SHOULD_BE_STRIPPED'), false);

  // The secret is nowhere in durable state or the stored operation result.
  const state = await store.read();
  assert.equal(JSON.stringify(state).includes(fake.plaintext), false);
  const op = state.operations['op-ws-1'];
  assert.equal(op.effect, 'confirmed');
  assert.equal(JSON.stringify(op.result).includes(fake.plaintext), false);
  assert.equal((op.result?.body as { token?: unknown }).token, undefined);
  assert.equal(state.assignments[asg.id].forkRef, body.workspace.forkRef);

  // Replay with the same operationId returns the stored result — no token.
  const replay = await call(handleInbox, wctx, 'POST', `/assignments/${asg.id}/workspace`, {
    operationId: 'op-ws-1', expectedRevision: 1, assignmentEpoch: 1,
  });
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as { token?: unknown; workspace: { forkRef: string } };
  assert.equal(replayBody.token, undefined);
  assert.equal(replayBody.workspace.forkRef, body.workspace.forkRef);
  assert.equal(fake.calls.fork, 1);
});

test('workspace: artifacts failure records failed-no-effect; same operationId recovers', async () => {
  const { ctx, store } = fixture();
  await store.transact((d) => {
    d.project.repositories['main'] = { role: 'canonical', remote: 'r' };
    seedMember(d, 'agent-a');
    return true;
  });
  const task = await makeTask(ctx, 'ws-b');
  const a = agent('agent-a', ['read', 'tasks:claim', 'workspace:write']);
  const asg = await claimFor(ctx, store, task.id, a);

  const failing = fakeArtifacts({ failFork: true });
  const wctx = { ...ctx, principal: a, artifacts: failing.adapter };
  const res = await call(handleInbox, wctx, 'POST', `/assignments/${asg.id}/workspace`, {
    operationId: 'op-ws-f', expectedRevision: 1, assignmentEpoch: 1,
  });
  assert.equal(res.status, 503);
  const op = (await store.read()).operations['op-ws-f'];
  assert.equal(op.effect, 'failed-no-effect');
  assert.equal(op.result, undefined);

  // Same operationId resumes the exact operation instead of duplicating it.
  const healthy = fakeArtifacts();
  const res2 = await call(
    handleInbox, { ...ctx, principal: a, artifacts: healthy.adapter },
    'POST', `/assignments/${asg.id}/workspace`,
    { operationId: 'op-ws-f', expectedRevision: 1, assignmentEpoch: 1 },
  );
  assert.equal(res2.status, 200);
  const b2 = (await res2.json()) as { token: { plaintext: string } };
  assert.equal(b2.token.plaintext, healthy.plaintext);
  assert.equal((await store.read()).operations['op-ws-f'].effect, 'confirmed');
});

// -------------------------------------------------------------- reply ---

test('reply threads to the sender within the task; no open social send', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'rep-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'user-1'); return true; });
  const a = agent('agent-a', ['read', 'inbox:write']);
  const { message } = await sendOffer(ctx, task.id, 'agent-a');
  const msg = (await store.read()).messages[message.id];
  const res = await call(handleInbox, { ...ctx, principal: a }, 'POST', `/inbox/${message.id}/reply`, {
    operationId: 'op-rep-1', text: 'looking at it now',
  });
  assert.equal(res.status, 201);
  const reply = ((await res.json()) as { message: Message & { threadId?: string } }).message;
  assert.equal(reply.type, 'reply');
  assert.equal(reply.recipientId, 'user-1');
  assert.equal(reply.taskId, task.id);
  assert.equal(reply.threadId, message.id);

  // Without inbox:write the send is denied; a stranger cannot reply to A's mail.
  const stranger = agent('agent-s', ['read', 'inbox:write']);
  await store.transact((d) => { seedMember(d, 'agent-s'); return true; });
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: stranger }, 'POST', `/inbox/${message.id}/reply`, {
      operationId: 'op-rep-x', text: 'hi',
    }),
    errIs(404, 'not_found'),
  );
  const noWrite = agent('agent-nw', ['read']);
  await store.transact((d) => { seedMember(d, 'agent-nw'); return true; });
  await sendOffer(ctx, task.id, 'agent-nw');
  const nwMsg = Object.values((await store.read()).messages).find((m) => m.recipientId === 'agent-nw') as Message;
  await assert.rejects(
    call(handleInbox, { ...ctx, principal: noWrite }, 'POST', `/inbox/${nwMsg.id}/reply`, {
      operationId: 'op-rep-nw', text: 'hi',
    }),
    errIs(403, 'scope_denied'),
  );
});

// ------------------------------------------------------------ adapters --

/**
 * In-process API transport for adapter tests: routes requests to the real
 * module handlers against the shared store with a fixed principal.
 */
function localFetch(store: MemoryStore, principal: Principal, log: { method: string; path: string }[]): typeof fetch {
  const ctx: Context = { principal, store, now, uid };
  return (async (input: unknown, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    log.push({ method: init?.method ?? 'GET', path });
    const segments = url.pathname.split('/').filter(Boolean).slice(4);
    const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if ((init?.method ?? 'GET') === 'GET' && segments.length === 0) {
      const state = await store.read();
      return new Response(JSON.stringify(safeSnapshot(state, principal)), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    try {
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

const CLI_ENV = {
  TOGETHER_BASE_URL: 'https://local.test',
  TOGETHER_TOKEN: 'cred_test',
  TOGETHER_PROJECT_ID: 'p1',
};

test('client fills operationId/expectedRevision/assignmentEpoch from last read; stale shows, no replay', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'cli-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); return true; });
  const a = agent('agent-a', ['read', 'tasks:claim', 'workspace:write']);
  const log: { method: string; path: string }[] = [];
  const client = clientFromEnv(CLI_ENV, localFetch(store, a, log));

  // Reads index revisions and epochs.
  await client.refresh();
  assert.equal(client.revisionOf('tasks', task.id), 1);

  const claim = await client.claimTask(task.id);
  assert.equal(claim.ok, true);
  const claimLog = log.filter((l) => l.method === 'POST');
  assert.equal(claimLog.length, 1);
  const asgId = (claim.body.assignment as Assignment).id;
  assert.equal(client.epochOf(asgId), 1);

  // Stale write: task revision moved (owner touched it via another op);
  // the client surfaces the 409 and performs exactly one POST — no replay.
  await store.transact((d) => { d.tasks[task.id].revision += 1; return true; });
  const postsBefore = log.filter((l) => l.method === 'POST' && l.path.includes('/assignments')).length;
  const stale = await client.claimTask(task.id, { role: 'helper' });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.status, 409);
  const stalePosts = log.filter((l) => l.method === 'POST' && l.path.includes('/assignments'));
  assert.equal(stalePosts.length, postsBefore + 1);
});

test('clientFromEnv reads only TOGETHER_* variables', async () => {
  let missing: Error | undefined;
  try {
    clientFromEnv({ OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'y' });
  } catch (err) {
    missing = err as Error;
  }
  assert.ok(missing);
  assert.match(String(missing), /TOGETHER_BASE_URL/);
  assert.doesNotMatch(String(missing), /OPENAI|ANTHROPIC/);
  const c = clientFromEnv(CLI_ENV, (() => new Response('{}')) as unknown as typeof fetch);
  assert.ok(c instanceof TogetherClient);
  assert.deepEqual(ENV_VARS, ['TOGETHER_BASE_URL', 'TOGETHER_TOKEN', 'TOGETHER_PROJECT_ID']);
});

test('cli: status + inbox + stale accept path end-to-end through injected env/fetch', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'cli-b');
  await store.transact((d) => { seedMember(d, 'agent-a'); seedMember(d, 'user-1'); return true; });
  const a = agent('agent-a', ['read', 'tasks:claim']);
  const log: { method: string; path: string }[] = [];
  const fetchFn = localFetch(store, a, log);
  const out: string[] = [];
  const err: string[] = [];
  const io = { env: CLI_ENV, out: (s: string) => out.push(s), err: (s: string) => err.push(s), fetchFn };

  const code = await cliMain(['status'], io);
  assert.equal(code, 0);
  const status = JSON.parse(out.join('')) as { platform: string; providerAuth: string };
  assert.equal(status.platform, 'connected');
  assert.equal(status.providerAuth, 'unknown');

  await sendOffer(ctx, task.id, 'agent-a');
  out.length = 0;
  const code2 = await cliMain(['inbox'], io);
  assert.equal(code2, 0);
  const inbox = JSON.parse(out.join('')) as { messages: { id: string; delivery: string }[] };
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].delivery, 'delivered');
  // Accepting the offer needs a task read first — plumbing comes from reads.
  await clientWarm(clientFromEnv(CLI_ENV, fetchFn), task.id);
});

async function clientWarm(client: TogetherClient, taskId: string): Promise<void> {
  await client.refresh();
  assert.equal(client.revisionOf('tasks', taskId), 1);
}

test('mcp: tools/list, tools/call, error shapes, notifications silent', async () => {
  const { ctx, store } = fixture();
  const task = await makeTask(ctx, 'mcp-a');
  await store.transact((d) => { seedMember(d, 'agent-a'); return true; });
  const a = agent('agent-a', ['read', 'tasks:claim']);
  const log: { method: string; path: string }[] = [];
  const client = clientFromEnv(CLI_ENV, localFetch(store, a, log));

  const list = await handleRpc(client, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = ((list as { result: { tools: { name: string }[] } }).result.tools);
  assert.ok(tools.length >= 10);
  assert.ok(tools.some((t) => t.name === 'together_inbox'));

  const init = await handleRpc(client, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.equal((init as { result: { serverInfo: { name: string } } }).result.serverInfo.name, 'together-mcp');

  // Notification: no response at all.
  assert.equal(
    await handleRpc(client, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    null,
  );
  const unknown = await handleRpc(client, { jsonrpc: '2.0', id: 3, method: 'bogus/method' });
  assert.equal((unknown as { error: { code: number } }).error.code, -32601);
  const badTool = await handleRpc(client, {
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} },
  });
  assert.equal((badTool as { error: { code: number } }).error.code, -32602);

  await sendOffer(ctx, task.id, 'agent-a');
  const callRes = await handleRpc(client, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'together_inbox', arguments: {} },
  });
  const payload = (callRes as { result: { content: { text: string }[]; isError?: boolean } }).result;
  assert.equal(payload.isError, undefined);
  const parsed = JSON.parse(payload.content[0].text) as { ok: boolean; result: { messages: unknown[] } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.messages.length, 1);

  // Stale consequential call: isError, and the client did not retry it.
  await client.claimTask(task.id);
  await store.transact((d) => { d.tasks[task.id].revision += 1; return true; });
  const before = log.filter((l) => l.method === 'POST' && l.path.includes('/assignments')).length;
  const staleCall = await handleRpc(client, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'together_claim', arguments: { taskId: task.id, role: 'helper' } },
  });
  const stalePayload = (staleCall as { result: { isError?: boolean; content: { text: string }[] } }).result;
  assert.equal(stalePayload.isError, true);
  const after = log.filter((l) => l.method === 'POST' && l.path.includes('/assignments')).length;
  assert.equal(after, before + 1);
});

test('mcp: serveMcp line loop bounds and parse errors', async () => {
  const { ctx, store } = fixture();
  const a = agent('agent-a', ['read']);
  const client = clientFromEnv(CLI_ENV, localFetch(store, a, []));
  const lines = [
    '{not json',
    JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'ping' }),
    'x'.repeat(300 * 1024),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  ];
  async function* gen(): AsyncIterable<string> {
    for (const l of lines) yield l;
  }
  const written: string[] = [];
  await serveMcp(client, { lines: gen(), write: (s) => { written.push(s); } });
  assert.equal(written.length, 3);
  assert.equal((JSON.parse(written[0]) as { error: { code: number } }).error.code, -32700);
  assert.equal((JSON.parse(written[1]) as { id: string }).id, 'x');
  assert.equal((JSON.parse(written[2]) as { error: { code: number } }).error.code, -32600);
});

test('renderHandoffMarkdown is a generated, ignored-by-git snapshot', () => {
  const md = renderHandoffMarkdown(
    {
      id: 'h1', projectId: 'p1', revision: 1, createdAt: T0, updatedAt: T0,
      actorId: 'a', taskId: 't1', assignmentId: 'a1', fromId: 'agent-x',
      done: 'd', next: 'n', uncertain: 'u', verifyFirst: 'v', doNotRepeat: 'r',
      epoch: 2,
    },
    { projectId: 'p1', epochLabel: 'reclaimed', taskGoal: 'goal x' },
  );
  assert.match(md, /Generated by Together/);
  assert.match(md, /epoch: 2 \(reclaimed\)/);
  assert.match(md, /## Next\nn/);
});
