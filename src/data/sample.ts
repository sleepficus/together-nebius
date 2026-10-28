// Truthful sample project for the Together slice frontend (seat b-swe-09).
//
// Everything makeSampleState() returns is sample activity: the project mode
// is 'sample', check jobs/receipts/reviews/findings carry provenance:
// 'sample', and shas use the visible 'sample-' prefix so they can never be
// mistaken for real Git output. There is no fabricated agent banter -- the
// single comment is a system notice labeled as sample. No record here can
// mint real runner provenance, a real Verified fix or a real integration:
// sample actions in useProject simulate clearly and never call remotes.

import { createState } from '../../lib/core.ts';
import type {
  AgentIdentity, Assignment, Candidate, CheckJob, EvidenceReceipt,
  Finding, Handoff, HelpRequest, Member, Message, ProjectState, Proposal,
  Review, Session, Task,
} from '../../lib/types.ts';

export const SAMPLE_PROJECT_ID = 'sample-project-1';
/** localStorage key used ONLY by sample mode; live state never touches it. */
export const SAMPLE_STORAGE_KEY = 'together.sample.projects.v1';

const T0 = '2026-10-04T08:50:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60 * 1000).toISOString();

function base(id: string, minutes: number, actorId: string) {
  return { id, projectId: SAMPLE_PROJECT_ID, revision: 1, createdAt: at(minutes), updatedAt: at(minutes), actorId };
}

export function makeSampleState(): ProjectState {
  const state = createState({
    id: SAMPLE_PROJECT_ID,
    goal: 'Make editing feel effortless',
    mode: 'sample',
    actorId: 'sample-system',
    now: at(0),
  });
  state.project.acceptancePolicyRevision = 1;

  const identities: AgentIdentity[] = [
    { ...base('steve', 0, 'steve'), displayName: 'Steve', ownerId: 'steve', creationSource: 'owner', status: 'active' },
    { ...base('agent-wren', 1, 'steve'), displayName: 'Wren', ownerId: 'steve', creationSource: 'sample', status: 'active' },
    { ...base('agent-fern', 1, 'steve'), displayName: 'Fern', ownerId: 'steve', creationSource: 'sample', status: 'active' },
    { ...base('agent-tess', 1, 'steve'), displayName: 'Tess', ownerId: 'steve', creationSource: 'sample', status: 'active' },
  ];
  for (const i of identities) state.identities[i.id] = i;

  const members: Member[] = [
    { ...base('mem-steve', 0, 'steve'), identityId: 'steve', kind: 'core', scopes: ['owner', 'admin', 'read'] },
    { ...base('mem-wren', 1, 'steve'), identityId: 'agent-wren', kind: 'core', scopes: ['read', 'tasks:write', 'changes:write'] },
    { ...base('mem-fern', 1, 'steve'), identityId: 'agent-fern', kind: 'core', scopes: ['read', 'tasks:write', 'changes:write'] },
    { ...base('mem-tess', 1, 'steve'), identityId: 'agent-tess', kind: 'collaborator', scopes: ['read', 'checks:write', 'reviews:write', 'findings:write'] },
  ];
  for (const m of members) state.members[m.id] = m;

  const sessions: Session[] = [
    {
      ...base('sess-wren', 2, 'agent-wren'), identityId: 'agent-wren', adapter: 'sample-cli',
      model: 'sample-model-a', provider: 'sample-provider', host: 'sample-host',
      advertisedCapabilities: ['edit', 'test'], observedCapabilities: ['edit'],
      lastActivityAt: at(58), lastActivitySource: 'sample-heartbeat', status: 'active',
    },
    {
      ...base('sess-fern', 3, 'agent-fern'), identityId: 'agent-fern', adapter: 'sample-cli',
      model: 'sample-model-b', provider: 'sample-provider', host: 'sample-host',
      advertisedCapabilities: ['edit'], observedCapabilities: [],
      lastActivityAt: at(20), lastActivitySource: 'sample-assignment', status: 'active',
    },
    {
      ...base('sess-tess', 4, 'agent-tess'), identityId: 'agent-tess', adapter: 'sample-cli',
      model: 'sample-model-c', provider: 'sample-provider', host: 'sample-host',
      advertisedCapabilities: ['test', 'review'], observedCapabilities: ['test', 'review'],
      lastActivityAt: at(45), lastActivitySource: 'sample-review', status: 'active',
    },
  ];
  for (const s of sessions) state.sessions[s.id] = s;

  const tasks: Task[] = [
    {
      ...base('task-select-persist', 5, 'steve'),
      goal: 'Preserve the selected item across refresh',
      acceptanceCriteria: ['Reloading the page keeps the same item selected'],
      dependencies: [], lifecycle: 'in-progress', currentAssignmentId: 'as-wren-1',
      resultRefs: [], nextAction: 'Wren is implementing; review prop-1 when submitted',
      // Real CSS-pixel positions matching layoutGraph's 345x250 grid.
      layout: { x: 0, y: 0 },
    },
    {
      ...base('task-focus-restore', 6, 'steve'),
      goal: 'Restore keyboard focus across refresh',
      acceptanceCriteria: ['Focus returns to the previously focused control', 'Focus ring is visible'],
      dependencies: [{ taskId: 'task-select-persist', kind: 'prerequisite' }],
      lifecycle: 'claimed', currentAssignmentId: 'as-fern-1',
      resultRefs: [], nextAction: 'Fern claimed; waiting for a proposal',
      layout: { x: 345, y: 0 },
    },
    {
      ...base('task-checks', 7, 'steve'),
      goal: 'Add acceptance checks for selection and focus restore',
      acceptanceCriteria: ['Check covers both acceptance criteria', 'Check runs on the combined candidate'],
      dependencies: [], lifecycle: 'claimed', currentAssignmentId: 'as-tess-1',
      resultRefs: [], nextAction: 'Tess is writing the check',
      layout: { x: 0, y: 250 },
    },
    {
      ...base('task-shortcut-docs', 8, 'steve'),
      goal: 'Document keyboard shortcuts in the editor help',
      acceptanceCriteria: ['Every shortcut listed in help matches the implementation'],
      dependencies: [], lifecycle: 'open', resultRefs: [],
      nextAction: 'Unclaimed -- available work',
      layout: { x: 0, y: 500 },
    },
  ];
  for (const t of tasks) state.tasks[t.id] = t;

  const assignments: Assignment[] = [
    {
      ...base('as-wren-1', 10, 'agent-wren'), taskId: 'task-select-persist', identityId: 'agent-wren',
      sessionId: 'sess-wren', role: 'builder', scopes: ['read', 'tasks:write', 'changes:write'],
      epoch: 1, leaseExpiresAt: at(75), maxUntil: at(130), status: 'active', forkRef: 'sample-fork-wren',
    },
    {
      ...base('as-fern-1', 12, 'agent-fern'), taskId: 'task-focus-restore', identityId: 'agent-fern',
      sessionId: 'sess-fern', role: 'builder', scopes: ['read', 'tasks:write', 'changes:write'],
      epoch: 1, leaseExpiresAt: at(72), maxUntil: at(132), status: 'active', forkRef: 'sample-fork-fern',
    },
    {
      ...base('as-tess-1', 14, 'agent-tess'), taskId: 'task-checks', identityId: 'agent-tess',
      sessionId: 'sess-tess', role: 'test-helper', scopes: ['read', 'checks:write', 'reviews:write'],
      epoch: 1, leaseExpiresAt: at(74), maxUntil: at(134), status: 'active',
    },
  ];
  for (const a of assignments) state.assignments[a.id] = a;

  const proposals: Proposal[] = [
    {
      ...base('prop-1', 30, 'agent-wren'), taskIds: ['task-select-persist'], authorId: 'agent-wren',
      sessionId: 'sess-wren', base: 'sample-base-aaaa', head: 'sample-head-wren1',
      summary: 'Persist selection id in the URL hash and restore on load (sample)',
      intendedBehavior: 'Selected item survives a refresh',
      changedPaths: ['src/state/selection.ts'], evidenceRefs: ['sample-report-1'],
      unknowns: ['Hash sync while dragging is untested'], lifecycle: 'submitted',
    },
    {
      ...base('prop-2', 36, 'agent-fern'), taskIds: ['task-focus-restore'], authorId: 'agent-fern',
      sessionId: 'sess-fern', base: 'sample-base-aaaa', head: 'sample-head-fern1',
      summary: 'Save the focused control id beside the selection and refocus on load (sample)',
      intendedBehavior: 'Keyboard focus returns after refresh',
      changedPaths: ['src/state/focus.ts'], evidenceRefs: [],
      unknowns: ['Focus ring styling not verified'], lifecycle: 'submitted',
    },
  ];
  for (const p of proposals) state.proposals[p.id] = p;

  const candidate: Candidate = {
    ...base('cand-1', 44, 'sample-system'), base: 'sample-base-aaaa',
    proposalIds: ['prop-1', 'prop-2'],
    proposalHeads: { 'prop-1': 'sample-head-wren1', 'prop-2': 'sample-head-fern1' },
    sha: 'sample-cand-0001', policyVersion: 1, status: 'checking',
    checkJobIds: ['job-1', 'job-2'], reviewIds: ['rev-1'],
  };
  state.candidates[candidate.id] = candidate;

  const jobs: CheckJob[] = [
    {
      ...base('job-1', 46, 'sample-system'), candidateId: 'cand-1', candidateSha: 'sample-cand-0001',
      command: 'npm test', status: 'completed', deadlineAt: at(56), dedupeKey: 'sample:check:job-1',
      provenance: 'sample', receiptId: 'rcpt-1',
    } as CheckJob,
    {
      ...base('job-2', 50, 'sample-system'), candidateId: 'cand-1', candidateSha: 'sample-cand-0001',
      command: 'npm run check:focus', status: 'completed', deadlineAt: at(60),
      dedupeKey: 'sample:check:job-2', provenance: 'sample', receiptId: 'rcpt-2',
    } as CheckJob,
  ];
  for (const j of jobs) state.jobs[j.id] = j;

  const receipts: EvidenceReceipt[] = [
    {
      ...base('rcpt-1', 56, 'sample-checker'), jobId: 'job-1', candidateSha: 'sample-cand-0001',
      collectorId: 'sample-checker', command: 'npm test', outcome: 'pass',
      artifactRefs: [], provenance: 'sample',
    } as EvidenceReceipt,
    {
      ...base('rcpt-2', 60, 'sample-checker'), jobId: 'job-2', candidateSha: 'sample-cand-0001',
      collectorId: 'sample-checker', command: 'npm run check:focus', outcome: 'fail',
      artifactRefs: [], provenance: 'sample',
    } as EvidenceReceipt,
  ];
  for (const r of receipts) state.receipts[r.id] = r;

  const reviews: Review[] = [
    {
      ...base('rev-1', 62, 'agent-tess'), candidateId: 'cand-1', candidateSha: 'sample-cand-0001',
      reviewerId: 'agent-tess', policyVersion: 1, disposition: 'comment',
      independent: false, independenceReason: 'sample-review-not-evaluated',
      findingIds: ['find-1'], provenance: 'sample',
    } as Review,
  ];
  for (const r of reviews) state.reviews[r.id] = r;

  const findings: Finding[] = [
    {
      ...base('find-1', 61, 'agent-tess'), candidateId: 'cand-1', candidateSha: 'sample-cand-0001',
      expected: 'Focus returns to the previously focused control after refresh',
      observed: 'Focus falls back to the document body when the selection hash changes (sample reproduction)',
      reproducer: 'Select an item, focus the rename field, refresh (sample steps)',
      severity: 'medium', state: 'reproduced', originatorId: 'agent-tess',
      linkedTaskId: 'task-focus-restore', receiptIds: ['rcpt-2'], provenance: 'sample',
    } as Finding,
  ];
  for (const f of findings) state.findings[f.id] = f;

  const help: HelpRequest[] = [
    {
      ...base('help-1', 26, 'agent-wren'), taskId: 'task-select-persist',
      question: 'Should selection restore from the URL hash or from local storage? (sample question)',
      expectedContribution: 'Pick one and note the trade-off',
      offeredById: 'agent-wren', acceptedById: 'steve',
      answer: 'Use the URL hash so a shared link opens the same item. (sample answer)',
      state: 'answered', expiresAt: at(90),
    },
  ];
  for (const h of help) state.help[h.id] = h;

  const handoffs: Handoff[] = [];
  for (const h of handoffs) state.handoffs[h.id] = h;

  // The only comment-like record is a system notice explicitly labeled
  // sample -- no invented agent chatter, no fake real-agent attribution.
  const messages: Message[] = [
    {
      ...base('msg-1', 63, 'sample-system'), recipientId: 'steve', senderId: 'sample-system',
      type: 'system-notice', taskId: 'task-focus-restore', candidateId: 'cand-1',
      body: 'Sample activity: the combined candidate has one failing sample check and one open finding.',
      delivery: 'delivered', dedupeKey: 'sample-notice-1',
    },
  ];
  for (const m of messages) state.messages[m.id] = m;

  // Event log: seq is monotonic; human interventions carry a humanCategory;
  // commit observations use the conventions documented in lib/events.ts.
  let seq = 0;
  const ev = (
    minutes: number, actorId: string, actorKind: 'human' | 'agent' | 'system',
    type: string, entityId: string | undefined, detail: unknown, humanCategory?: 'approve' | 'relay' | 'tie-break' | 'correction' | 'other',
  ) => {
    seq += 1;
    state.events.push({
      id: `sample-ev-${seq}`, projectId: SAMPLE_PROJECT_ID, seq, createdAt: at(minutes),
      actorId, actorKind, type, entityId,
      ...(detail !== undefined ? { detail } : {}),
      ...(humanCategory !== undefined ? { humanCategory } : {}),
    });
  };

  ev(5, 'steve', 'human', 'task:created', 'task-select-persist', { sample: true });
  ev(6, 'steve', 'human', 'task:created', 'task-focus-restore', { sample: true });
  ev(7, 'steve', 'human', 'task:created', 'task-checks', { sample: true });
  ev(8, 'steve', 'human', 'task:created', 'task-shortcut-docs', { sample: true });
  ev(10, 'agent-wren', 'agent', 'assignment:claimed', 'as-wren-1', { taskId: 'task-select-persist', epoch: 1, sample: true });
  ev(12, 'agent-fern', 'agent', 'assignment:claimed', 'as-fern-1', { taskId: 'task-focus-restore', epoch: 1, sample: true });
  ev(14, 'agent-tess', 'agent', 'assignment:claimed', 'as-tess-1', { taskId: 'task-checks', epoch: 1, sample: true });
  ev(26, 'agent-wren', 'agent', 'help:offered', 'help-1', { taskId: 'task-select-persist', sample: true });
  ev(28, 'steve', 'human', 'help:answered', 'help-1', { sample: true }, 'relay');
  ev(30, 'agent-wren', 'agent', 'proposal:submitted', 'prop-1', { head: 'sample-head-wren1', sample: true });
  ev(31, 'sample-system', 'system', 'commit:observed', 'prop-1', {
    sha: 'sample-head-wren1', role: 'fork', ref: 'sample-fork-wren', sample: true,
  });
  ev(36, 'agent-fern', 'agent', 'proposal:submitted', 'prop-2', { head: 'sample-head-fern1', sample: true });
  ev(37, 'sample-system', 'system', 'commit:observed', 'prop-2', {
    sha: 'sample-head-fern1', role: 'fork', ref: 'sample-fork-fern', sample: true,
  });
  // An imported baseline observation that metrics must exclude.
  ev(38, 'sample-system', 'system', 'commit:observed', 'sample-base-aaaa', {
    sha: 'sample-base-aaaa', role: 'canonical', baseline: true, sample: true,
  });
  ev(44, 'sample-system', 'system', 'candidate:prepared', 'cand-1', { sha: 'sample-cand-0001', sample: true });
  ev(56, 'sample-checker', 'system', 'check:completed', 'job-1', {
    receiptId: 'rcpt-1', outcome: 'pass', sample: true,
  });
  ev(58, 'sample-system', 'system', 'check:heartbeat', 'job-2', {
    assignmentId: 'as-tess-1', sample: true,
  });
  ev(60, 'sample-checker', 'system', 'check:completed', 'job-2', {
    receiptId: 'rcpt-2', outcome: 'fail', sample: true,
  });
  ev(61, 'agent-tess', 'agent', 'finding:reproduced', 'find-1', { receiptIds: ['rcpt-2'], sample: true });
  ev(62, 'agent-tess', 'agent', 'candidate:reviewed', 'cand-1', {
    reviewId: 'rev-1', disposition: 'comment', sample: true,
  });

  state.stopped = false;
  return state;
}
