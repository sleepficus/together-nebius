// Together slice — frozen shared TypeScript/record contract (seat b-swe-01).
// Every downstream module (identity, changes, checks, inbox, events, UI data)
// codes against these exact names. Do not rename, alias or fork them.
// Times come from the service (ctx.now()); source timestamps are separate data.

export type Id = string;
export type IsoTime = string;
export type Sha = string;
export type Revision = number;

/** Common fields carried by every mutable coordination record. */
export interface Entity {
  id: Id;
  projectId: Id;
  revision: Revision;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  actorId: Id;
  [extra: string]: unknown;
}

export type ActorKind = 'human' | 'agent' | 'system' | 'collector';

/**
 * Server-side authenticated principal. Constructed only by the authenticate
 * hook in cloud/app.ts — never from caller-supplied actor/display-name fields.
 */
export interface Principal {
  id: Id;
  sessionId: Id;
  kind: ActorKind;
  ownerId: Id;
  scopes: string[];
  projectIds: Id[];
}

export type ProjectMode = 'sample' | 'live';

export interface ResourceLimits {
  maxActiveWorkers: number;
  maxActiveChecks: number;
  checkTimeoutMs: number;
  maxSourceBytes: number;
  maxCostUsd?: number;
}

export interface RepositoryMapping {
  role: 'canonical' | 'fork' | 'scratch';
  repositoryId?: string;
  /** Credential-free remote URL. Tokens never appear in saved URLs. */
  remote: string;
}

export interface Project extends Entity {
  goal: string;
  mode: ProjectMode;
  canonicalRef: string;
  acceptancePolicyRevision: number;
  resourceLimits: ResourceLimits;
  repositories: Record<string, RepositoryMapping>;
  /** Server-configured check offered by this local installation, not agent-supplied execution authority. */
  defaultCheckCommand?: string;
}

export type MembershipKind = 'core' | 'collaborator';

export interface Member extends Entity {
  identityId: Id;
  kind: MembershipKind;
  scopes: string[];
}

export interface AgentIdentity extends Entity {
  displayName: string;
  ownerId: Id;
  creationSource: string;
  status: 'active' | 'revoked';
  parentId?: Id;
}

export interface Session extends Entity {
  identityId: Id;
  adapter?: string;
  model?: string;
  provider?: string;
  harness?: string;
  host?: string;
  payerRef?: string;
  advertisedCapabilities: string[];
  observedCapabilities: string[];
  lastActivityAt?: IsoTime;
  lastActivitySource?: string;
  status: 'active' | 'ended' | 'revoked';
}

/** Private auth record — removed from every safe view and export. */
export interface Invitation extends Entity {
  label?: string;
  tokenHash: string;
  scopes: string[];
  projectIds: Id[];
  expiresAt: IsoTime;
  /** Optional issuer-selected lifetime for the resulting credential. */
  credentialExpiresAt?: IsoTime;
  status: 'pending' | 'exchanged' | 'revoked' | 'expired';
  exchangedById?: Id;
}

/** Private auth record — only the credential hash is stored, never plaintext. */
export interface Credential extends Entity {
  identityId: Id;
  tokenHash: string;
  scopes: string[];
  projectIds: Id[];
  expiresAt?: IsoTime;
  status: 'active' | 'revoked';
}

export type TaskLifecycle =
  'draft' | 'open' | 'claimed' | 'in-progress' | 'submitted' | 'done' | 'cancelled';

export interface TaskDependency {
  taskId: Id;
  /** Only these kinds participate in the cycle-rejecting dependency graph. */
  kind: 'prerequisite' | 'contributes-changes';
}

export interface Task extends Entity {
  goal: string;
  acceptanceCriteria: string[];
  dependencies: TaskDependency[];
  lifecycle: TaskLifecycle;
  currentAssignmentId?: Id;
  resultRefs: string[];
  nextAction?: string;
  /** Saved layout only — dragging a box never edits dependencies. */
  layout?: { x: number; y: number };
}

export type AssignmentStatus =
  'active' | 'completed' | 'released' | 'reclaimed' | 'expired' | 'stopped';

export interface Assignment extends Entity {
  taskId: Id;
  identityId: Id;
  sessionId?: Id;
  role: string;
  scopes: string[];
  epoch: number;
  leaseExpiresAt: IsoTime;
  /** Configured at claim time; renewals may not pass this cap. */
  maxUntil: IsoTime;
  status: AssignmentStatus;
  forkRef?: string;
}

export type HelpState = 'offered' | 'accepted' | 'answered' | 'withdrawn' | 'expired';

export interface HelpRequest extends Entity {
  taskId?: Id;
  candidateId?: Id;
  question: string;
  expectedContribution?: string;
  offeredById: Id;
  acceptedById?: Id;
  answer?: string;
  state: HelpState;
  expiresAt?: IsoTime;
}

export type MessageType =
  'assignment-offer' | 'help-request' | 'reply' | 'review-request' | 'handoff' | 'system-notice';

export type MessageDelivery = 'queued' | 'delivered' | 'expired';

export interface Message extends Entity {
  recipientId: Id;
  senderId: Id;
  type: MessageType;
  body: string;
  taskId?: Id;
  candidateId?: Id;
  expiresAt?: IsoTime;
  delivery: MessageDelivery;
  readAt?: IsoTime;
  acceptedAt?: IsoTime;
  answeredAt?: IsoTime;
  dedupeKey?: string;
}

export interface Handoff extends Entity {
  taskId?: Id;
  assignmentId?: Id;
  fromId: Id;
  toId?: Id;
  done: string;
  next: string;
  uncertain: string;
  verifyFirst: string;
  doNotRepeat: string;
  epoch?: number;
  acceptedById?: Id;
}

export type ProposalLifecycle =
  'draft' | 'submitted' | 'changes-requested' | 'ready-to-combine' | 'integrated' | 'withdrawn';

export interface Proposal extends Entity {
  taskIds: Id[];
  authorId: Id;
  sessionId?: Id;
  base: Sha;
  head: Sha;
  summary: string;
  intendedBehavior: string;
  changedPaths: string[];
  evidenceRefs: string[];
  unknowns: string[];
  lifecycle: ProposalLifecycle;
  supersedes?: Id;
}

export type CandidateStatus =
  'prepared' | 'checking' | 'ready' | 'integrated' | 'failed' | 'superseded';

/**
 * System-derived node: never claimable, no portrait slot. Every new `sha`
 * starts with no passing required checks — required receipts/reviews bind the
 * exact SHA, so a new candidate clears them by construction.
 */
export interface Candidate extends Entity {
  base: Sha;
  /** Ordered proposal revisions combined into this candidate. */
  proposalIds: Id[];
  /** Exact head per proposal; compared by canonical key/value equality. */
  proposalHeads: Record<Id, Sha>;
  sha: Sha;
  policyVersion: number;
  status: CandidateStatus;
  checkJobIds: Id[];
  reviewIds: Id[];
  integrateOperationId?: Id;
}

export type CheckJobStatus =
  'queued' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface CheckJob extends Entity {
  candidateId: Id;
  candidateSha: Sha;
  command: string;
  environment?: Record<string, string>;
  status: CheckJobStatus;
  /** Exactly one named owner assignment; other assignments gain no liveness. */
  ownerAssignmentId?: Id;
  ownerEpoch?: number;
  deadlineAt?: IsoTime;
  runnerRef?: string;
  dedupeKey?: string;
}

export interface EvidenceReceipt extends Entity {
  jobId: Id;
  candidateSha: Sha;
  /** Authenticated collector/runner provenance — never author-uploaded. */
  collectorId: Id;
  command: string;
  environment?: Record<string, string>;
  outcome: 'pass' | 'fail' | 'error' | 'blocked';
  inputHash?: string;
  outputHash?: string;
  artifactRefs: string[];
}

export interface AuthorReport extends Entity {
  proposalId: Id;
  authorId: Id;
  claims: string;
  artifactRefs: string[];
}

export interface Review extends Entity {
  candidateId: Id;
  candidateSha: Sha;
  reviewerId: Id;
  policyVersion: number;
  disposition: 'approve' | 'request-changes' | 'comment';
  independent: boolean;
  independenceReason: string;
  findingIds: Id[];
}

export type FindingState =
  'possible-issue' | 'reproduced' | 'repair-in-progress' | 'recheck-needed' |
  'verified-fixed' | 'not-reproduced' | 'withdrawn';

export interface Finding extends Entity {
  candidateId?: Id;
  candidateSha?: Sha;
  expected: string;
  observed: string;
  reproducer?: string;
  severity?: string;
  state: FindingState;
  originatorId: Id;
  linkedTaskId?: Id;
  repairAssignmentId?: Id;
  receiptIds: Id[];
  note?: string;
}

export type OperationEffect =
  'confirmed' | 'pending' | 'dispatching' | 'effect-unconfirmed' |
  'failed-no-effect' | 'unknown';

export interface OperationResult {
  status: number;
  body: unknown;
}

export interface Operation extends Entity {
  /** Idempotency key supplied by the caller. */
  scope: string;
  target: CommandTarget;
  /** Canonical payload digest — resolved before stale revision checks. */
  digest: string;
  expectedRevision?: Revision;
  intent: string;
  effect: OperationEffect;
  result?: OperationResult;
  reconciliation?: string;
}

export type HumanCategory = 'approve' | 'relay' | 'tie-break' | 'correction' | 'other';

export interface Event {
  id: Id;
  projectId: Id;
  /** Monotonic sequence within the project; cursor reads use `after=seq`. */
  seq: number;
  createdAt: IsoTime;
  actorId: Id;
  actorKind: ActorKind;
  type: string;
  entityId?: Id;
  collection?: string;
  detail?: unknown;
  result?: string;
  uncertainty?: string;
  nextActorId?: Id;
  nextAction?: string;
  sourceRefs?: string[];
  humanCategory?: HumanCategory;
}

/** Output that arrived after its assignment epoch was reclaimed. */
export interface LateOutput {
  id: Id;
  projectId: Id;
  createdAt: IsoTime;
  assignmentId: Id;
  taskId?: Id;
  epoch: number;
  kind: string;
  ref?: string;
  note?: string;
}

/** Fixed collection names — keyed maps by opaque ID, plus the two arrays. */
export const COLLECTIONS = [
  'members', 'sessions', 'identities', 'invitations', 'credentials',
  'tasks', 'assignments', 'help', 'messages', 'handoffs',
  'proposals', 'candidates', 'jobs', 'receipts', 'authorReports',
  'reviews', 'findings', 'operations', 'planRevisions', 'runs',
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

export interface CommandTarget {
  collection: 'project' | CollectionName;
  id?: Id;
}

export interface ProjectState {
  project: Project;
  members: Record<Id, Member>;
  sessions: Record<Id, Session>;
  identities: Record<Id, AgentIdentity>;
  invitations: Record<Id, Invitation>;
  credentials: Record<Id, Credential>;
  tasks: Record<Id, Task>;
  assignments: Record<Id, Assignment>;
  help: Record<Id, HelpRequest>;
  messages: Record<Id, Message>;
  handoffs: Record<Id, Handoff>;
  proposals: Record<Id, Proposal>;
  candidates: Record<Id, Candidate>;
  jobs: Record<Id, CheckJob>;
  receipts: Record<Id, EvidenceReceipt>;
  authorReports: Record<Id, AuthorReport>;
  reviews: Record<Id, Review>;
  findings: Record<Id, Finding>;
  operations: Record<Id, Operation>;
  events: Event[];
  lateOutputs: LateOutput[];
  stopped: boolean;
  planRevisions?: Record<Id, import("./run-state.ts").PlanRevision>;
  runs?: Record<Id, import("./run-state.ts").WorkRun>;
}

/**
 * Store contract: `read` returns an isolated copy; `transact` runs a
 * synchronous callback on a draft and commits atomically. Callbacks are
 * synchronous — no remote effects inside a transaction (see GitService for
 * the outbox/reconcile path used for external writes).
 */
export interface Store {
  read(): Promise<ProjectState>;
  transact<T>(fn: (draft: ProjectState) => T): Promise<T>;
}

export interface Context {
  attentionEnabled?: boolean;
  principal: Principal;
  store: Store;
  now(): IsoTime;
  uid(): Id;
  git?: GitService;
  runner?: RunnerService;
  artifacts?: ArtifactsAdapter;
  conversation?: import("./conversation-store.ts").ConversationStore;
  runtime?: import("./run-state.ts").RuntimeBinding;
}

/**
 * Bounded external Git service on Steve's host. The cloud Worker stores
 * intents and observes effects; it never executes Node Git or fakes a SHA.
 * `push` must enforce `expectedTip`; callers reconcile read-back tips and
 * never treat an in-flight old-tip read as failed-no-effect.
 */
export interface GitService {
  prepare(input: {
    projectId: Id;
    base: Sha;
    proposals: { id: Id; head: Sha }[];
    operationId: Id;
  }): Promise<{
    sha: Sha;
    base: Sha;
    proposalHeads: Record<Id, Sha>;
    changedPaths: string[];
    diffPreview?: {base:string;head:string;text:string;truncated:boolean};
    conflicts?: { path: string; proposalIds: Id[] }[];
  }>;
  readTip(ref: string): Promise<Sha>;
  isAncestor(oldTip: Sha, newTip: Sha): Promise<boolean>;
  push(input: {
    ref: string;
    expectedTip: Sha;
    candidateTip: Sha;
    operationId: Id;
  }): Promise<{ ended: boolean; effect: 'updated' | 'no-effect' | 'unknown'; reportStatus?: string }>;
}

/** Optional bounded check-runner capability; absence means Check blocked. */
export interface RunnerService {
  /** `collectorToken` is the job-scoped bearer credential trusted runner
   * machinery uses on the collector endpoints -- delivered through this
   * channel only, never in a requester-visible response. */
  dispatch(input: {
    projectId: Id;
    jobId: Id;
    candidateSha: Sha;
    snapshotRef?: string;
    command: string;
    timeoutMs: number;
    environment?: Record<string, string>;
    operationId: Id;
    collectorToken?: string;
  }): Promise<{ accepted: boolean; reason?: string }>;
  cancel(input: { projectId: Id; jobId: Id }): Promise<{ accepted: boolean; reason?: string }>;
}

/**
 * Artifacts binding surface (server-side only). readFile returns Blob|null;
 * callers decode text and distinguish empty input (422), missing file (404)
 * and dependency-not-ready (503). Capability handles are disposed via
 * Symbol.dispose exactly once, including exception paths. create/fork
 * metadata is flat; createToken returns {plaintext, expiresAt} and the
 * plaintext envelope is never stored in state, exports or logs.
 */
export interface ArtifactsAdapter {
  readFile(path: string): Promise<Blob | null>;
  writeFile?(path: string, data: Blob): Promise<void>;
  createRepository?(name: string): Promise<Record<string, unknown>>;
  fork?(repositoryId: string, name?: string): Promise<Record<string, unknown>>;
  createToken?(scope: {
    repositoryId?: string;
    permissions?: string[];
    expiresInSeconds?: number;
  }): Promise<{ plaintext: string; expiresAt: IsoTime }>;
  [Symbol.dispose]?(): void;
}
