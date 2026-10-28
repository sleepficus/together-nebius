// Cloud check-runner capability for phase04 (lane c-swe-08).
//
// createCloudRunnerService() adapts the existing RunnerService seam onto
// the durable execution broker: a CheckJob dispatch becomes a private
// check.run execution job and a cancel becomes check.cancel. dispatch()
// answers {accepted:true} ONLY after the broker enqueue is durable -- a
// missing/failing EXECUTION_OBJECT means {accepted:false} and the job is
// reconciled 'blocked', never a faked run.
//
// The job-scoped collectorToken travels inside the private broker payload
// only (trusted pull + durable private storage are lane c-swe-07's
// contract); it never appears in a requester-visible response. A
// caller-supplied snapshotRef is dropped here: the companion materializes
// the exact candidateSha from its own mirror -- "no caller mount".
//
// Cross-lane seams (reported to controller, not owned here):
//   - cloud/execution.ts   enqueueExecution      (c-swe-07) broker write
//   - cloud/project-artifacts.ts repositoryCapability (c-swe-05) optional
//     short-lived read capability for the candidate snapshot fetch.
// Both resolve lazily so this module loads before those lanes merge and
// tests can inject fakes; absent modules degrade honestly (reject or
// unauthenticated mirror fetch), never fake.

import type {
  CloudEnv, DirectoryProjectRecord, ExecutionInput, ExecutionJob,
} from './phase04-contract.ts';
import type { RunnerService } from '../lib/types.ts';

export const CHECK_PAYLOAD_VERSION = 1;
/** Headroom after the check deadline so a finishing run can still report. */
const ENQUEUE_MARGIN_MS = 30_000;
const CANCEL_DEADLINE_MS = 60_000;
const MAX_COMMAND_CHARS = 4 * 1024;

/** 40-hex (SHA-1) or 64-hex (SHA-256) commit ids only. Local copy: cloud
 * modules must not import adapters/local-git.ts (node builtins). */
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Identifiers safe as container-name, broker-key and route components. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CheckRunPayload {
  v: typeof CHECK_PAYLOAD_VERSION;
  /** The CheckJob this execution serves; binds container + collector route. */
  checkJobId: string;
  candidateSha: string;
  command: string;
  timeoutMs: number;
  environment?: Record<string, string>;
  /** Broker/job deadline; the executor clamps its run to this bound. */
  deadlineAt: string;
  /** Job-scoped collector bearer -- private payload only. */
  collectorToken?: string;
  /** Trusted mirror metadata; token is a short-lived read capability. */
  mirror?: { remote?: string; token?: string; tokenExpiresAt?: string };
}

export interface CheckCancelPayload {
  v: typeof CHECK_PAYLOAD_VERSION;
  checkJobId: string;
}

export type EnqueueExecution = (env: CloudEnv, input: ExecutionInput) => Promise<ExecutionJob>;

export type RepositoryReadCapability = () => Promise<{
  repositoryId: string;
  remote: string;
  plaintext: string;
  expiresAt: string;
} | undefined>;

export interface CloudRunnerDeps {
  env: CloudEnv;
  record: DirectoryProjectRecord;
  /** Broker enqueue; defaults to c-swe-07's exported helper. */
  enqueue?: EnqueueExecution;
  /**
   * Snapshot read capability source; defaults to c-swe-05's
   * repositoryCapability(env, record, record.repositoryId, 'read').
   * Best-effort: the owned mirror may already hold the candidate objects.
   */
  readCapability?: RepositoryReadCapability;
  now?: () => number;
}

async function defaultEnqueue(env: CloudEnv, input: ExecutionInput): Promise<ExecutionJob> {
  const mod = (await import('./execution.ts')) as { enqueueExecution: EnqueueExecution };
  return mod.enqueueExecution(env, input);
}

function defaultReadCapability(
  env: CloudEnv,
  record: DirectoryProjectRecord,
): RepositoryReadCapability {
  return async () => {
    const mod = (await import('./project-artifacts.ts')) as {
      repositoryCapability: (
        env: CloudEnv,
        record: DirectoryProjectRecord,
        repositoryId: string,
        scope: 'read' | 'write',
      ) => Promise<{ repositoryId: string; remote: string; plaintext: string; expiresAt: string }>;
    };
    return mod.repositoryCapability(env, record, record.repositoryId, 'read');
  };
}

function boundedCommand(value: string): boolean {
  return value.trim() !== '' && new TextEncoder().encode(value).length <= MAX_COMMAND_CHARS;
}

export function createCloudRunnerService(deps: CloudRunnerDeps): RunnerService {
  const { env, record } = deps;
  const enqueue: EnqueueExecution = deps.enqueue ?? defaultEnqueue;
  const readCapability = deps.readCapability ?? defaultReadCapability(env, record);
  const now = deps.now ?? (() => Date.now());

  return {
    async dispatch(input) {
      if (input.projectId !== record.id) {
        return { accepted: false, reason: 'project-mismatch' };
      }
      if (!ID_RE.test(input.jobId)) {
        return { accepted: false, reason: 'invalid-job-id' };
      }
      if (!SHA_RE.test(input.candidateSha)) {
        return { accepted: false, reason: 'invalid-sha' };
      }
      if (typeof input.command !== 'string' || !boundedCommand(input.command)) {
        return { accepted: false, reason: 'invalid-command' };
      }
      const timeoutMs = input.timeoutMs;
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return { accepted: false, reason: 'invalid-timeout' };
      }
      const deadlineAt = new Date(now() + timeoutMs).toISOString();

      // Optional short-lived read capability for the snapshot fetch --
      // best-effort: the owned mirror may already carry the objects.
      let mirror: CheckRunPayload['mirror'];
      try {
        const cap = await readCapability();
        if (cap !== undefined) {
          mirror = {
            remote: cap.remote !== '' ? cap.remote : record.remote,
            token: cap.plaintext,
            tokenExpiresAt: cap.expiresAt,
          };
        }
      } catch {
        // Capability unavailable: proceed without it; the executor fetches
        // anonymously or reports 'blocked' truthfully.
      }
      if (mirror === undefined && record.remote !== '') {
        mirror = { remote: record.remote };
      }

      const payload: CheckRunPayload = {
        v: CHECK_PAYLOAD_VERSION,
        checkJobId: input.jobId,
        candidateSha: input.candidateSha,
        command: input.command,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        timeoutMs,
        deadlineAt,
        // input.snapshotRef is deliberately NOT forwarded: the companion
        // materializes the exact candidate SHA from its owned mirror.
        ...(input.collectorToken !== undefined ? { collectorToken: input.collectorToken } : {}),
        ...(mirror !== undefined ? { mirror } : {}),
      };
      const job: ExecutionInput = {
        key: `check.run:${input.jobId}`,
        projectId: record.id,
        role: 'check',
        action: 'check.run',
        payload: payload as unknown as Record<string, unknown>,
        deadlineAt: new Date(Date.parse(deadlineAt) + ENQUEUE_MARGIN_MS).toISOString(),
      };
      try {
        await enqueue(env, job);
        return { accepted: true };
      } catch {
        return { accepted: false, reason: 'enqueue-unavailable' };
      }
    },

    async cancel(input) {
      if (input.projectId !== record.id) {
        return { accepted: false, reason: 'project-mismatch' };
      }
      if (!ID_RE.test(input.jobId)) {
        return { accepted: false, reason: 'invalid-job-id' };
      }
      const payload: CheckCancelPayload = { v: CHECK_PAYLOAD_VERSION, checkJobId: input.jobId };
      const job: ExecutionInput = {
        key: `check.cancel:${input.jobId}`,
        projectId: record.id,
        role: 'check',
        action: 'check.cancel',
        payload: payload as unknown as Record<string, unknown>,
        deadlineAt: new Date(now() + CANCEL_DEADLINE_MS).toISOString(),
      };
      try {
        await enqueue(env, job);
        return { accepted: true };
      } catch {
        return { accepted: false, reason: 'enqueue-unavailable' };
      }
    },
  };
}
