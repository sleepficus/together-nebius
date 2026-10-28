// Trusted companion check executor for phase04 (lane c-swe-08).
// Runs on Steve's verified Mac host against broker-pulled check jobs only.
//
// check.run:
//   1. validate the private payload (project / checkJobId / exact SHA /
//      command / timeout / collector token);
//   2. ensure the exact candidateSha is present in the OWNED bare mirror
//      under options.root -- a bounded fetch uses the optional short-lived
//      read capability via env (never argv, never inside Docker);
//   3. materialize a fresh snapshot of that exact commit -- a
//      caller-supplied snapshotRef is never honored;
//   4. run the registered command through the pinned network-none
//      snapshot runner (timeout => 'error', nonzero exit => 'fail',
//      missing Docker/snapshot => 'blocked');
//   5. POST the outcome to the job-scoped collector completion route
//      (/api/v1/projects/:id/collector/jobs/:jobId/complete) with the
//      job's collector token, and only then return a broker result
//      carrying collectorAccepted:true.
//
// check.cancel: best-effort docker rm -f of the job container and an
// honest {removed} result.
//
// No account/owner/bridge/transport credential enters the candidate
// container's argv/env/mounts; the collector token only ever reaches the
// completion endpoint's Authorization header. A weak oracle can still
// pass bad code -- this module reports what the run observed, nothing more.

import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { BridgeOptions, ExecutionJob } from '../cloud/phase04-contract.ts';
import { ensureMirrorCommit, materializeGitSnapshot } from '../runner/git-snapshot.ts';
import {
  containerName, removeSnapshotContainer, runSnapshotJob,
} from '../runner/snapshot-runner.ts';

/** Must match the container-name prefix used for every check.run so
 * check.cancel can address the same container after a restart. */
export const CHECK_CONTAINER_PREFIX = 'together-check';
const MIRROR_DIR_NAME = 'mirrors';
const MAX_COMMAND_CHARS = 4 * 1024;
const LOG_TAIL_BYTES = 4 * 1024;
const COLLECTOR_HTTP_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 120_000;

/** 40-hex (SHA-1) or 64-hex (SHA-256) commit ids only. */
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Identifiers safe as container-name and route components. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._-]+$/;

export class CheckExecutionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckExecutionError';
    this.code = code;
  }
}

function failJob(code: string, message: string): never {
  throw new CheckExecutionError(code, message);
}

const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

interface CheckRunPayload {
  checkJobId: string;
  candidateSha: string;
  command: string;
  timeoutMs: number;
  environment?: Record<string, string>;
  deadlineAt?: string;
  collectorToken: string;
  mirror?: { remote?: string; token?: string; tokenExpiresAt?: string };
}

function textField(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxChars) {
    failJob('invalid-payload', `${field} must be a non-empty string of at most ${maxChars} chars`);
  }
  return value;
}

function parseRunPayload(payload: Record<string, unknown>): CheckRunPayload {
  const checkJobId = payload.checkJobId;
  if (typeof checkJobId !== 'string' || !ID_RE.test(checkJobId)) {
    failJob('invalid-payload', 'checkJobId must be a safe job identifier');
  }
  const candidateSha = payload.candidateSha;
  if (typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)) {
    failJob('invalid-payload', 'candidateSha must be a 40- or 64-hex commit SHA');
  }
  const command = textField(payload.command, 'command', MAX_COMMAND_CHARS);
  const timeoutMs = payload.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    failJob('invalid-payload', 'timeoutMs must be a positive number of milliseconds');
  }
  const collectorToken = payload.collectorToken;
  if (typeof collectorToken !== 'string' || collectorToken === '') {
    failJob('invalid-payload', 'collectorToken is required for check.run');
  }
  let mirror: CheckRunPayload['mirror'];
  if (payload.mirror !== undefined) {
    if (typeof payload.mirror !== 'object' || payload.mirror === null || Array.isArray(payload.mirror)) {
      failJob('invalid-payload', 'mirror must be an object');
    }
    const m = payload.mirror as Record<string, unknown>;
    mirror = {
      ...(typeof m.remote === 'string' && m.remote !== '' ? { remote: m.remote } : {}),
      ...(typeof m.token === 'string' && m.token !== '' ? { token: m.token } : {}),
      ...(typeof m.tokenExpiresAt === 'string' ? { tokenExpiresAt: m.tokenExpiresAt } : {}),
    };
  }
  return {
    checkJobId,
    candidateSha,
    command,
    timeoutMs,
    ...(typeof payload.environment === 'object' && payload.environment !== null ? { environment: payload.environment as Record<string, string> } : {}),
    ...(typeof payload.deadlineAt === 'string' ? { deadlineAt: payload.deadlineAt } : {}),
    collectorToken,
    ...(mirror !== undefined ? { mirror } : {}),
  };
}

function parseCancelPayload(payload: Record<string, unknown>): { checkJobId: string } {
  const checkJobId = payload.checkJobId;
  if (typeof checkJobId !== 'string' || !ID_RE.test(checkJobId)) {
    failJob('invalid-payload', 'checkJobId must be a safe job identifier');
  }
  return { checkJobId };
}

/** Owned mirror location: derived from options.root, never from payload. */
function mirrorDirFor(root: string, projectId: string): string {
  const base = resolve(root);
  const safeProject = SAFE_PATH_RE.test(projectId) ? projectId : sha256Hex(projectId).slice(0, 16);
  const dir = join(base, MIRROR_DIR_NAME, safeProject);
  if (resolve(dir) !== dir || !resolve(dir).startsWith(base + sep)) {
    failJob('invalid-payload', 'mirror path escapes the owned root');
  }
  return dir;
}

function collectorUrl(apiUrl: string, projectId: string, checkJobId: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  return `${base}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/collector/jobs/${encodeURIComponent(checkJobId)}/complete`;
}

function remainingMs(p: CheckRunPayload): number {
  if (p.deadlineAt === undefined) return p.timeoutMs;
  const deadline = Date.parse(p.deadlineAt);
  if (!Number.isFinite(deadline)) return p.timeoutMs;
  return Math.min(p.timeoutMs, deadline - Date.now());
}

/**
 * Job-scoped collector completion POST. One retry on transport failure is
 * safe because the deterministic operationId replays idempotently; a 4xx
 * is authoritative rejection, never retried. Returns only after the
 * collector accepted (2xx).
 */
async function postCollector(
  options: BridgeOptions,
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; receiptId?: string }> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (fetchImpl === undefined) failJob('fetch-unavailable', 'no fetch implementation available');
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(COLLECTOR_HTTP_TIMEOUT_MS),
      });
      if (res.ok) {
        let receiptId: string | undefined;
        try {
          const parsed = (await res.json()) as { receipt?: { id?: unknown } };
          receiptId = typeof parsed?.receipt?.id === 'string' ? parsed.receipt.id : undefined;
        } catch {
          receiptId = undefined;
        }
        return { status: res.status, ...(receiptId !== undefined ? { receiptId } : {}) };
      }
      let code = '';
      try {
        const parsed = (await res.json()) as { error?: { code?: unknown } };
        code = typeof parsed?.error?.code === 'string' ? ` ${parsed.error.code}` : '';
      } catch {
        code = '';
      }
      failJob('collector-rejected', `collector completion rejected: HTTP ${res.status}${code}`);
    } catch (err) {
      if (err instanceof CheckExecutionError) throw err;
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  failJob('collector-unreachable', `collector completion unreachable: ${detail.slice(0, 200)}`);
}

async function runCheck(job: ExecutionJob, options: BridgeOptions): Promise<Record<string, unknown>> {
  const p = parseRunPayload(job.payload);
  const url = collectorUrl(options.apiUrl, job.projectId, p.checkJobId);

  // The ONLY way this execution reports success downstream: the real
  // collector accepted the completion report. Everything else throws.
  const finish = async (partial: {
    outcome: 'pass' | 'fail' | 'error' | 'blocked';
    outputHash: string;
    inputHash?: string;
    exitCode?: number | null;
    timedOut?: boolean;
    logTail: string;
  }): Promise<Record<string, unknown>> => {
    const accepted = await postCollector(options, url, p.collectorToken, {
      operationId: `collector-complete-${p.checkJobId}`,
      outcome: partial.outcome,
      candidateSha: p.candidateSha,
      command: p.command,
      ...(p.environment !== undefined ? { environment: p.environment } : {}),
      ...(partial.inputHash !== undefined ? { inputHash: partial.inputHash } : {}),
      outputHash: partial.outputHash,
      artifactRefs: [],
    });
    return {
      collectorAccepted: true,
      action: 'check.run',
      jobId: p.checkJobId,
      outcome: partial.outcome,
      candidateSha: p.candidateSha,
      ...(partial.inputHash !== undefined ? { inputHash: partial.inputHash } : {}),
      outputHash: partial.outputHash,
      ...(partial.exitCode !== undefined ? { exitCode: partial.exitCode } : {}),
      timedOut: partial.timedOut === true,
      logTail: partial.logTail,
      collectorStatus: accepted.status,
      ...(accepted.receiptId !== undefined ? { receiptId: accepted.receiptId } : {}),
    };
  };

  const reportInfra = (outcome: 'error' | 'blocked', reason: string, timedOut = false) =>
    finish({ outcome, outputHash: sha256Hex(reason), timedOut, logTail: reason.slice(0, LOG_TAIL_BYTES) });

  if (remainingMs(p) <= 0) {
    // Expired before dispatch: honest 'error' outcome; docker never runs.
    return reportInfra('error', 'check deadline exceeded before snapshot run', true);
  }

  const mirrorDir = mirrorDirFor(options.root, job.projectId);
  let present = false;
  try {
    const mirror = ensureMirrorCommit({
      mirrorDir,
      sha: p.candidateSha,
      ...(p.mirror?.remote !== undefined ? { remote: p.mirror.remote } : {}),
      ...(p.mirror?.token !== undefined ? { token: p.mirror.token } : {}),
      timeoutMs: Math.min(FETCH_TIMEOUT_MS, Math.max(5_000, remainingMs(p))),
    });
    present = mirror.present;
  } catch {
    present = false;
  }
  if (!present) {
    return reportInfra('blocked', 'candidate snapshot unavailable in owned mirror');
  }

  let snapshot: { dir: string; cleanup(): void };
  try {
    snapshot = materializeGitSnapshot(mirrorDir, p.candidateSha);
  } catch {
    return reportInfra('blocked', 'candidate snapshot materialization failed');
  }
  try {
    const result = await runSnapshotJob({
      jobId: p.checkJobId,
      snapshotRef: snapshot.dir,
      command: p.command,
      timeoutMs: Math.max(0, remainingMs(p)),
      ...(p.environment !== undefined ? { environment: p.environment } : {}),
      dockerBin: options.dockerBin,
      namePrefix: CHECK_CONTAINER_PREFIX,
    });
    return finish({
      outcome: result.outcome,
      outputHash: result.outputHash,
      ...(result.inputHash !== undefined ? { inputHash: result.inputHash } : {}),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      logTail: result.logTail.slice(-LOG_TAIL_BYTES),
    });
  } finally {
    snapshot.cleanup();
  }
}

async function cancelCheck(job: ExecutionJob, options: BridgeOptions): Promise<Record<string, unknown>> {
  const p = parseCancelPayload(job.payload);
  const name = containerName(CHECK_CONTAINER_PREFIX, p.checkJobId);
  const res = removeSnapshotContainer(name, options.dockerBin ?? 'docker');
  return {
    action: 'check.cancel',
    jobId: p.checkJobId,
    container: name,
    removed: res.removed,
    ...(res.reason !== undefined ? { reason: res.reason } : {}),
  };
}

/**
 * Broker entry point for check jobs pulled by the companion.
 * Throws CheckExecutionError for anything that must surface as a broker
 * job failure (bad payload, disallowed project, collector rejection or
 * unreachable collector) -- the broker stores error.code/message and the
 * CheckJob is never marked by a fabricated pass.
 */
export async function runCheckExecution(
  job: ExecutionJob,
  options: BridgeOptions,
): Promise<Record<string, unknown>> {
  if (job.role !== 'check') {
    failJob('wrong-role', `expected a check job, got ${job.role}`);
  }
  if (options.projectIds.length > 0 && !options.projectIds.includes(job.projectId)) {
    failJob('project-not-allowed', `project ${job.projectId} is not in this companion's allowlist`);
  }
  if (job.action === 'check.run') return runCheck(job, options);
  if (job.action === 'check.cancel') return cancelCheck(job, options);
  failJob('unsupported-action', `unsupported check action ${job.action}`);
}
