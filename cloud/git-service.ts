// Cloud-side GitService for phase 04 (seat c-swe-06).
//
// The worker/DO never runs git. This service translates each GitService
// call into a typed broker job (lane c-swe-07 execution object), which the
// outbound companion on the existing private host picks up and executes as
// real git (companion/git-executor.ts). Transport capabilities are minted
// through the trusted Artifacts helper (lane c-swe-05 repositoryCapability)
// and ride inside payload.transport — durable private broker storage and
// the authenticated pull only; never public project state, exports or logs.
//
// Failure honesty (spec item 6/7):
//   - missing broker/capability seams or a bounded-await timeout surface as
//     503 git_unavailable for reads/prepare — no fabricated SHA;
//   - for git.push, a wait timeout, broker error or non-terminal job is
//     reported { ended:false, effect:'unknown' } so lib/integration.ts only
//     reconciles by read-back — a possibly-in-flight push is never
//     repushed by this module;
//   - consequential:true marks git.push so the broker can hold a stale
//     lease at effect-unconfirmed instead of redispatching.

import { digestOf, fail, ApiError } from '../lib/core.ts';
import type {
  CloudEnv, DirectoryProjectRecord, ExecutionInput, ExecutionJob,
} from './phase04-contract.ts';
import type {
  Assignment, GitService, Id, ProjectState, Proposal, Sha,
} from '../lib/types.ts';

/** Bounded await for git jobs (spec: approximately 40s ordinary async I/O). */
export const GIT_AWAIT_MS = 40_000;
/** Durable job deadline — the executor refuses to dispatch past it. */
export const GIT_JOB_TTL_MS = 120_000;
const MAX_PROPOSALS = 64;
const PAYLOAD_SCHEMA = 'c06-git-1';

// ---------------------------------------------------------------------------
// cross-lane seams (resolved at controller merge; absent => honest 503)
// ---------------------------------------------------------------------------

interface ExecutionBroker {
  enqueueExecution(env: CloudEnv, input: ExecutionInput): Promise<ExecutionJob>;
  waitExecution(
    env: CloudEnv, projectId: string, jobId: string, timeoutMs?: number,
  ): Promise<ExecutionJob>;
}

interface CapabilityIssuer {
  repositoryCapability(
    env: CloudEnv,
    record: DirectoryProjectRecord,
    repositoryId: string,
    scope: 'read' | 'write',
  ): Promise<{ repositoryId: string; remote: string; plaintext: string; expiresAt?: string }>;
}

async function loadBroker(): Promise<ExecutionBroker> {
  let mod: Record<string, unknown>;
  try {
    // Lane c-swe-07 export surface; resolved dynamically so this module
    // still loads (and reports dependency-unavailable) when the lane has
    // not been merged yet.
    mod = (await import('./execution.ts')) as unknown as Record<string, unknown>;
  } catch {
    fail(503, 'git_unavailable', 'execution broker module is unavailable in this build', {
      nextAction: 'Configure the execution broker before retrying this Git operation',
    });
  }
  if (typeof mod.enqueueExecution !== 'function' || typeof mod.waitExecution !== 'function') {
    fail(503, 'git_unavailable', 'execution broker does not export enqueueExecution/waitExecution');
  }
  return mod as unknown as ExecutionBroker;
}

async function issueCapability(
  env: CloudEnv,
  record: DirectoryProjectRecord,
  repositoryId: string,
  scope: 'read' | 'write',
): Promise<GitTransportCap> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('./project-artifacts.ts')) as unknown as Record<string, unknown>;
  } catch {
    fail(503, 'git_unavailable', 'artifacts capability helper is unavailable in this build', {
      nextAction: 'Configure repository artifact capabilities before retrying this Git operation',
    });
  }
  const fn = mod.repositoryCapability;
  if (typeof fn !== 'function') {
    fail(503, 'git_unavailable', 'project-artifacts does not export repositoryCapability');
  }
  try {
    const cap = await (fn as CapabilityIssuer['repositoryCapability'])(env, record, repositoryId, scope);
    if (
      typeof cap?.repositoryId !== 'string' || typeof cap?.remote !== 'string' ||
      typeof cap?.plaintext !== 'string'
    ) {
      fail(503, 'git_unavailable', 'capability helper returned a malformed capability');
    }
    return { repositoryId: cap.repositoryId, remote: cap.remote, plaintext: cap.plaintext, expiresAt: cap.expiresAt };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    fail(503, 'git_unavailable', 'transport capability could not be issued');
  }
}

// ---------------------------------------------------------------------------
// payload construction — exported for tests and controller seam review
// ---------------------------------------------------------------------------

export interface GitTransportCap {
  repositoryId: string;
  remote: string;
  plaintext: string;
  expiresAt?: string;
}

export interface GitPayloadProposal {
  id: Id;
  head: Sha;
  base?: Sha;
  authorId?: Id;
  /** Actually-issued fork repository to fetch `head` from (defaults canonical). */
  repositoryId?: string;
}

/**
 * Build the broker job payload for a git action. All transport secrets
 * live under `payload.transport` — c-swe-07 treats payload as private
 * (authenticated trusted pull + durable private storage only).
 */
export function buildGitJobPayload(input: {
  record: DirectoryProjectRecord;
  fields: Record<string, unknown>;
  canonical: GitTransportCap;
  forks?: Record<string, GitTransportCap>;
}): Record<string, unknown> {
  const { record, fields, canonical, forks } = input;
  return {
    schema: PAYLOAD_SCHEMA,
    projectId: record.id,
    repositoryId: record.repositoryId,
    remote: record.remote,
    canonicalRef: record.canonicalRef,
    ...fields,
    transport: {
      canonical,
      ...(forks !== undefined && Object.keys(forks).length > 0 ? { forks } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// broker result mapping
// ---------------------------------------------------------------------------

/**
 * Executor error codes that are raised strictly BEFORE a push dispatch —
 * a failed job carrying one of these provably had no remote effect.
 */
const PUSH_PRE_EFFECT_CODES = new Set([
  'invalid_payload', 'invalid_sha', 'invalid_ref', 'invalid_id',
  'invalid_remote', 'remote_not_allowed', 'ref_not_canonical',
  'missing_transport', 'project_mismatch', 'project_not_allowed',
  'wrong_role', 'job_expired', 'too_large', 'too_many_refs',
]);

const BROKER_ERROR_MAP: Record<string, { status: number; code: string }> = {
  invalid_payload: { status: 422, code: 'invalid_payload' },
  invalid_sha: { status: 422, code: 'invalid_sha' },
  invalid_ref: { status: 422, code: 'invalid_ref' },
  invalid_id: { status: 422, code: 'invalid_id' },
  invalid_remote: { status: 422, code: 'invalid_remote' },
  remote_not_allowed: { status: 422, code: 'remote_not_allowed' },
  ref_not_canonical: { status: 422, code: 'ref_not_canonical' },
  invalid_base: { status: 422, code: 'invalid_base' },
  unknown_commit: { status: 422, code: 'unknown_commit' },
  too_large: { status: 422, code: 'too_large' },
  too_many_refs: { status: 422, code: 'too_many_refs' },
  project_mismatch: { status: 422, code: 'project_mismatch' },
  wrong_role: { status: 422, code: 'wrong_role' },
  unknown_action: { status: 422, code: 'unknown_action' },
  ref_not_found: { status: 404, code: 'ref_not_found' },
  project_not_allowed: { status: 403, code: 'project_not_allowed' },
  job_expired: { status: 409, code: 'job_expired' },
  missing_transport: { status: 503, code: 'dependency_unavailable' },
  dependency_unavailable: { status: 503, code: 'dependency_unavailable' },
  fetch_failed: { status: 503, code: 'dependency_unavailable' },
  candidate_ref_push_failed: { status: 503, code: 'dependency_unavailable' },
  git_timeout: { status: 503, code: 'git_unavailable' },
  git_unavailable: { status: 503, code: 'git_unavailable' },
  git_failed: { status: 503, code: 'git_failed' },
};

function brokerError(err: { code?: string; message?: string } | undefined): ApiError {
  const code = typeof err?.code === 'string' ? err.code : 'git_failed';
  const mapped = BROKER_ERROR_MAP[code] ?? { status: 503, code: 'git_failed' };
  return new ApiError(mapped.status, mapped.code,
    typeof err?.message === 'string' ? err.message.slice(0, 300) : 'git job failed');
}

/**
 * Map a finished (or still-open) broker job to the GitService result.
 * Push ambiguity -> { ended:false, effect:'unknown' } — reconcile-only.
 * Exported for the lane's tests; the broker contract is lane c-swe-07.
 */
export function mapGitBrokerResult(
  action: ExecutionInput['action'],
  job: ExecutionJob,
): Record<string, unknown> {
  if (job.status === 'completed' && typeof job.result === 'object' && job.result !== null) {
    return job.result;
  }
  if (action === 'git.push') {
    if (job.status === 'failed' && PUSH_PRE_EFFECT_CODES.has(String(job.error?.code))) {
      return { ended: true, effect: 'no-effect', reportStatus: `rejected:${String(job.error?.code)}` };
    }
    return {
      ended: false,
      effect: 'unknown',
      reportStatus: `broker-${job.status}${job.error?.code !== undefined ? `:${job.error.code}` : ''}`,
    };
  }
  if (job.status === 'failed') throw brokerError(job.error);
  fail(503, 'git_unavailable',
    `git job did not complete within the bounded await (status ${job.status})`, {
      nextAction: 'the companion may be offline; the job remains queued, retry later',
    });
}

// ---------------------------------------------------------------------------
// proposal -> fork resolution (issued workspace provenance)
// ---------------------------------------------------------------------------

/**
 * The repository that actually holds a proposal head: the author's issued
 * workspace fork (assignment.forkRef), else canonical. Prefers the
 * assignment bound to one of the proposal's tasks; then most recent.
 */
function resolveAuthorFork(state: ProjectState, proposal: Proposal): string | undefined {
  const candidates = (Object.values(state.assignments) as Assignment[]).filter(
    (a): a is Assignment & { forkRef: string } =>
      a.identityId === proposal.authorId &&
      typeof a.forkRef === 'string' && a.forkRef.length > 0,
  );
  if (candidates.length === 0) return undefined;
  const taskSet = new Set(proposal.taskIds);
  candidates.sort((a, b) => {
    const ta = a.taskId !== undefined && taskSet.has(a.taskId) ? 0 : 1;
    const tb = b.taskId !== undefined && taskSet.has(b.taskId) ? 0 : 1;
    if (ta !== tb) return ta - tb;
    const sa = a.status === 'active' ? 0 : 1;
    const sb = b.status === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return candidates[0].forkRef;
}

// ---------------------------------------------------------------------------
// result shape validation — never return an unvalidated/fabricated SHA
// ---------------------------------------------------------------------------

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function resultSha(v: unknown, field: string, allowEmpty = false): Sha {
  if (allowEmpty && v === '') return '' as Sha;
  if (typeof v !== 'string' || !SHA_RE.test(v)) {
    fail(503, 'git_bad_result', `broker result field "${field}" is not a commit SHA`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export function createCloudGitService(input: {
  env: CloudEnv;
  record: DirectoryProjectRecord;
  state: () => Promise<ProjectState>;
}): GitService {
  const { env, record, state } = input;

  async function dispatch(
    action: ExecutionInput['action'],
    fields: Record<string, unknown>,
    opts: { writeCanonical?: boolean; forkRepoIds?: string[] } = {},
  ): Promise<Record<string, unknown>> {
    const broker = await loadBroker();
    if (env.EXECUTION_OBJECT === undefined) {
      fail(503, 'git_unavailable', 'execution broker binding is not configured');
    }
    const canonical = await issueCapability(
      env, record, record.repositoryId, opts.writeCanonical === true ? 'write' : 'read',
    );
    const forks: Record<string, GitTransportCap> = {};
    for (const rid of new Set(opts.forkRepoIds ?? [])) {
      if (rid === record.repositoryId) continue;
      forks[rid] = await issueCapability(env, record, rid, 'read');
    }
    const payload = buildGitJobPayload({ record, fields, canonical, forks });
    const publicDigest = (await digestOf({ ...payload, transport: undefined })).slice(0, 16);
    const job = await broker.enqueueExecution(env, {
      key: `git-${action}-${publicDigest}-${crypto.randomUUID().slice(0, 8)}`,
      projectId: record.id,
      role: 'git',
      action,
      payload,
      deadlineAt: new Date(Date.now() + GIT_JOB_TTL_MS).toISOString(),
      ...(action === 'git.push' ? { consequential: true } : {}),
    }).catch((err: unknown) => {
      if (err instanceof ApiError) throw err;
      fail(503, 'git_unavailable', 'git job could not be enqueued', {
        nextAction: 'retry once the execution broker is reachable',
      });
    });
    let done: ExecutionJob;
    try {
      done = await broker.waitExecution(env, record.id, job.id, GIT_AWAIT_MS);
    } catch (err) {
      if (action === 'git.push') {
        // The push may be in flight; only read-back reconciliation is safe.
        return { ended: false, effect: 'unknown', reportStatus: 'await-failed' };
      }
      if (err instanceof ApiError) throw err;
      fail(503, 'git_unavailable', 'bounded await for the git job failed', {
        nextAction: 'retry once the companion reports again',
      });
    }
    return mapGitBrokerResult(action, done);
  }

  /** Callers may read only the project's configured canonical ref. */
  function assertProjectRef(ref: string, projectRef: string | undefined): void {
    const allowed = new Set([record.canonicalRef, projectRef].filter(Boolean));
    if (!allowed.has(ref)) {
      fail(422, 'ref_not_canonical', 'git service reads/writes only the configured canonical ref');
    }
  }

  return {
    async readTip(ref: string): Promise<Sha> {
      assertProjectRef(ref, (await state()).project.canonicalRef);
      const res = await dispatch('git.readTip', { ref });
      return resultSha(res.tip, 'tip');
    },

    async isAncestor(oldTip: Sha, newTip: Sha): Promise<boolean> {
      if (!SHA_RE.test(oldTip) || !SHA_RE.test(newTip)) {
        fail(422, 'invalid_sha', 'isAncestor requires 40- or 64-hex commit SHAs');
      }
      const res = await dispatch('git.isAncestor', { oldTip, newTip });
      if (typeof res.isAncestor !== 'boolean') {
        fail(503, 'git_bad_result', 'broker isAncestor result missing boolean');
      }
      return res.isAncestor;
    },

    async prepare(input: {
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
    }> {
      if (!Array.isArray(input.proposals) || input.proposals.length === 0 ||
          input.proposals.length > MAX_PROPOSALS) {
        fail(422, 'missing_field', `prepare requires 1..${MAX_PROPOSALS} proposal heads`);
      }
      const s = await state();
      const heads: Record<Id, Sha> = {};
      const forkRepoIds: string[] = [];
      const payloadProposals: GitPayloadProposal[] = input.proposals.map((p) => {
        const proposal = s.proposals[p.id] as Proposal | undefined;
        if (!proposal) {
          fail(422, 'unknown_proposal', `proposal ${p.id} does not exist`);
        }
        if (proposal.head !== p.head) {
          fail(409, 'proposal_head_mismatch',
            `proposal ${p.id} stored head does not match the requested head`);
        }
        heads[p.id] = p.head;
        const repo = resolveAuthorFork(s, proposal) ?? record.repositoryId;
        if (repo !== record.repositoryId) forkRepoIds.push(repo);
        return {
          id: p.id, head: p.head, base: proposal.base,
          authorId: proposal.authorId, repositoryId: repo,
        };
      });
      const res = await dispatch(
        'git.prepare',
        { operationId: input.operationId, base: input.base, proposals: payloadProposals },
        // write scope on canonical pins refs/candidates/<op> so the exact
        // candidate SHA stays reachable for checks (spec item 6).
        { writeCanonical: true, forkRepoIds },
      );
      const sha = resultSha(res.sha, 'sha', true);
      if (sha === '') {
        const conflicts = Array.isArray(res.conflicts)
          ? (res.conflicts as { path: string; proposalIds: Id[] }[])
          : [];
        return { sha, base: input.base, proposalHeads: heads, changedPaths: [], conflicts };
      }
      if (res.base !== input.base) {
        fail(503, 'git_bad_result', 'broker prepare result base does not match the request');
      }
      const changedPaths = Array.isArray(res.changedPaths)
        ? res.changedPaths.filter((x): x is string => typeof x === 'string').slice(0, 8192)
        : [];
      const d=res.diffPreview as any;const diffPreview=d?.base===input.base&&d?.head===sha&&typeof d.text==='string'&&d.text.length<=6000&&typeof d.truncated==='boolean'?{base:input.base,head:sha,text:d.text,truncated:d.truncated}:undefined;
      return { sha, base: input.base, proposalHeads: heads, changedPaths,...(diffPreview?{diffPreview}:{}) };
    },

    async push(input: {
      ref: string;
      expectedTip: Sha;
      candidateTip: Sha;
      operationId: Id;
    }): Promise<{ ended: boolean; effect: 'updated' | 'no-effect' | 'unknown'; reportStatus?: string }> {
      assertProjectRef(input.ref, (await state()).project.canonicalRef);
      const res = await dispatch('git.push', {
        operationId: input.operationId,
        ref: input.ref,
        expectedTip: input.expectedTip,
        candidateTip: input.candidateTip,
      }, { writeCanonical: true });
      const effect = res.effect;
      if (typeof res.ended !== 'boolean' ||
          (effect !== 'updated' && effect !== 'no-effect' && effect !== 'unknown')) {
        fail(503, 'git_bad_result', 'broker push result is malformed');
      }
      return {
        ended: res.ended, effect,
        ...(typeof res.reportStatus === 'string' ? { reportStatus: res.reportStatus } : {}),
      };
    },
  };
}
