// Private durable execution broker for the Together cloud phase04 slice
// (seat c-swe-07).
//
// One ExecutionObject per project owns a typed six-action queue. Cloud code
// enqueues ExecutionInput records through the EXECUTION_OBJECT binding only
// (server-side; there is no public enqueue route). The private companion on
// the existing verified host polls OUTBOUND over HTTPS through the bridge
// routes and runs real Git (lane c-swe-06) or the pinned Docker check
// runner (lane c-swe-08) there. This module never runs Git, Docker or a
// provider call itself, never manufactures transport credentials, receipts
// or Git SHAs, and treats every action payload as opaque after action,
// size and digest validation.
//
// Trust and durability rules (CLOUD-SPEC item 7):
// - Jobs are immutable once stored: key + projectId + role + action +
//   payload digest are fixed at enqueue. Re-enqueue with the same key and
//   digest replays the stored job; the same key with a different digest is
//   409, never a silent second job.
// - GIT_BRIDGE_TOKEN and CHECK_BRIDGE_TOKEN are DISTINCT purposes. The
//   bearer token alone infers the role at the bridge edge; a body role that
//   disagrees is rejected. A git credential can never lease or complete a
//   check job, and vice versa.
// - Pull leases a job with a random leaseId; completion and heartbeat are
//   bound to (projectId, jobId, action/digest, leaseId) lineage. Stale or
//   expired leases and conflicting duplicate results are rejected, so a
//   late result from a superseded delivery cannot create readiness.
// - Read/prepare-style jobs may be safely redispatched after a lease
//   expires (bounded attempts); a consequential git.push whose dispatch is
//   uncertain is marked effect-unconfirmed and is NEVER dispatched again.
// - Results are durable: they live in the object's storage and survive DO
//   recreation. Private payload material exists only in durable storage
//   and the authenticated trusted pull response; it is purged when the job
//   reaches a terminal state and is absent from every public job view.
// - Outstanding jobs, payload and result sizes are bounded; awaiting a job
//   is bounded (~40s default) and a timeout returns the honest current
//   status — never a fabricated SHA, receipt or dependency state.
//
// Bridge envelope (lane c-swe-09 CLI contract), all POST under the public
// prefix /internal/v1/execution with Authorization: Bearer <purpose token>:
//   pull      { role: 'git'|'check', projectIds: string[],
//               limit?: 1..16, leaseMs?: 1000..600000 }
//             -> 200 { jobs: [leased private job views incl. payload] }
//   result    { projectId, jobId, leaseId, result?: object,
//               error?: {code, message} }
//             -> 200 { job } | 4xx sanitized error; result XOR error
//   heartbeat { projectId, jobId, leaseId } -> 200 { job } | 409 stale
// Error bodies are the shared {error:{status,code,message,retryable}}
// shape; internals never leak.

import {
  ApiError, MAX_BODY_BYTES, canonicalJSON, digestOf, errorResponse, fail,
  json, readJsonBody,
} from '../lib/core.ts';
import type {
  CloudEnv, CloudNamespace, CloudObjectState, CloudStorage,
  ExecutionAction, ExecutionInput, ExecutionJob, ExecutionRole,
} from './phase04-contract.ts';

export const EXECUTION_ROUTE_PREFIX = '/internal/v1/execution';

const JOB_PREFIX = 'job/';
const KEY_PREFIX = 'key/';

const ACTIONS: Record<ExecutionRole, ReadonlySet<ExecutionAction>> = {
  git: new Set(['git.readTip', 'git.prepare', 'git.isAncestor', 'git.push']),
  check: new Set(['check.run', 'check.cancel']),
  runtime:new Set(['runtime.start','runtime.status','runtime.deliver','runtime.stop']),
};

const ACTIVE: ReadonlySet<ExecutionJob['status']> = new Set(['queued', 'leased']);
const TERMINAL: ReadonlySet<ExecutionJob['status']> = new Set([
  'completed', 'failed', 'effect-unconfirmed', 'cancelled',
]);

const MAX_KEY_CHARS = 160;
const MAX_PROJECT_ID_CHARS = 160;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_ERROR_CHARS = 1024;
const MAX_OUTSTANDING_JOBS = 128;
const MAX_PULL_PROJECTS = 32;
const MAX_PULL_JOBS = 16;
const MAX_DELIVERIES = 8;
const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 10 * 60_000;
const HEARTBEAT_LEASE_MS = 60_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 40_000;
const MAX_WAIT_TIMEOUT_MS = 45_000;
const WAIT_POLL_MS = 50;

/** Result-bearing keys whose values must never persist to a terminal job. */
const SENSITIVE_RESULT_KEYS = /^(?:token|plaintext|secret|credential|password|authorization|cookie|privateKey|accessToken|bearer)$/i;

/** Stored record: the contract job plus broker bookkeeping. */
interface StoredJob extends ExecutionJob {
  createdAt: string;
  updatedAt: string;
  runtimeSessionId?: string;
  /** Deliveries so far (each pull increments). */
  attempts: number;
  /** Private terminal lineage retained after active lease/payload purging. */
  terminalLeaseDigest?: string;
  /** Exact normalized success or error outcome accepted on that lease. */
  terminalOutcomeDigest?: string;
  /** Terminal marker: payload was purged after completion. */
  payloadPurged?: boolean;
}

interface KeyRef { jobId: string; digest: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJSON(value)).length;
}

function requireString(value: unknown, field: string, max = MAX_PROJECT_ID_CHARS): string {
  if (typeof value !== 'string' || value === '') {
    fail(422, 'invalid_field', `"${field}" must be a non-empty string`);
  }
  if (value.length > max) {
    fail(422, 'invalid_field', `"${field}" exceeds ${max} characters`);
  }
  return value;
}

function optionalBoundedInt(
  value: unknown, field: string, min: number, max: number, fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(422, 'invalid_field', `"${field}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireRole(value: unknown): ExecutionRole {
  if (value !== 'git' && value !== 'check' && value !== 'runtime') {
    fail(422, 'invalid_field', '"role" must be "git", "check" or "runtime"');
  }
  return value;
}

function requireActionForRole(role: ExecutionRole, value: unknown): ExecutionAction {
  if (typeof value !== 'string' || !ACTIONS[role].has(value as ExecutionAction)) {
    fail(422, 'invalid_action', `action is not a valid ${role} execution action`);
  }
  return value as ExecutionAction;
}

/** Consequential jobs (git.push or explicit flag) are never redispatched. */
function isConsequential(input: ExecutionInput): boolean {
  return input.consequential === true || input.action === 'git.push' || ['runtime.start','runtime.deliver'].includes(input.action);
}

/** Strip private payload material from every non-pull view. */
function publicJob(job: StoredJob): ExecutionJob {
  const view: ExecutionJob & Record<string, unknown> = {
    id: job.id,
    key: job.key,
    projectId: job.projectId,
    role: job.role,
    action: job.action,
    payload: {},
    deadlineAt: job.deadlineAt,
    digest: job.digest,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.consequential === true) view.consequential = true;
  if (job.leaseId !== undefined) view.leaseId = job.leaseId;
  if (job.leasedUntil !== undefined) view.leasedUntil = job.leasedUntil;
  if (job.result !== undefined) view.result = job.result;
  if (job.error !== undefined) view.error = job.error;
  return view;
}

/** The trusted pull view: the only surface that carries the payload. */
function leasedJobView(job: StoredJob): Record<string, unknown> {
  return {
    id: job.id,
    key: job.key,
    projectId: job.projectId,
    role: job.role,
    action: job.action,
    digest: job.digest,
    status: job.status,
    payload: job.payload,
    deadlineAt: job.deadlineAt,
    ...(job.consequential === true ? { consequential: true } : {}),
    leaseId: job.leaseId,
    leasedUntil: job.leasedUntil,
    attempts: job.attempts,
    createdAt: job.createdAt,
  };
}

/** Defense in depth: a result must not smuggle capability material into durable state. */
function sanitizeResultValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => sanitizeResultValue(v, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_RESULT_KEYS.test(k) ? '[redacted]' : sanitizeResultValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExecutionObject {
  private readonly state: CloudObjectState;
  private readonly env: CloudEnv;
  private readonly projectId: string;

  constructor(state: CloudObjectState, env: CloudEnv) {
    this.state = state;
    this.env = env;
    this.projectId = state.id.name ?? state.id.toString();
  }

  private now(): string {
    return new Date().toISOString();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const parts = new URL(request.url).pathname.split('/').filter(Boolean);
      // Internal binding surface only: /internal/execution/<op>. The object
      // is unreachable from the public worker route; the edge composes it.
      if (parts[0] !== 'internal' || parts[1] !== 'execution' || parts.length !== 3) {
        fail(404, 'not_found', 'not an execution route');
      }
      if (request.method !== 'POST') {
        fail(405, 'method_not_allowed', 'execution object accepts POST');
      }
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      switch (parts[2]) {
        case 'enqueue':
          return json(200, { job: publicJob(await this.enqueue(body)) });
        case 'wait':
          return json(200, { job: publicJob(await this.wait(body)) });
        case 'pull': {
          const jobs = await this.pull(body);
          return json(200, { jobs: jobs.map(leasedJobView) });
        }
        case 'result':
          return json(200, { job: publicJob(await this.complete(body)) });
        case 'heartbeat':
          return json(200, { job: publicJob(await this.heartbeat(body)) });
        default:
          fail(404, 'not_found', 'unknown execution operation');
      }
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      return json(500, {
        error: { status: 500, code: 'internal_error', message: 'internal error', retryable: false },
      });
    }
  }

  /** Validate the opaque input envelope and compute the immutable digest. */
  private parseInput(body: Record<string, unknown>): { input: ExecutionInput; digest: string } {
    const projectId = requireString(body.projectId, 'projectId');
    if (projectId !== this.projectId) {
      fail(422, 'project_mismatch', 'job projectId does not match this execution object');
    }
    const key = requireString(body.key, 'key', MAX_KEY_CHARS);
    const role = requireRole(body.role);
    const action = requireActionForRole(role, body.action);
    if (!isRecord(body.payload)) {
      fail(422, 'invalid_field', '"payload" must be an object');
    }
    if (byteLength(body.payload) > MAX_PAYLOAD_BYTES) {
      fail(422, 'payload_too_large', `payload exceeds ${MAX_PAYLOAD_BYTES} canonical bytes`);
    }
    const deadlineAt = requireString(body.deadlineAt, 'deadlineAt');
    if (!Number.isFinite(Date.parse(deadlineAt))) {
      fail(422, 'invalid_field', '"deadlineAt" must be an ISO-8601 timestamp');
    }
    if (body.consequential !== undefined && typeof body.consequential !== 'boolean') {
      fail(422, 'invalid_field', '"consequential" must be a boolean');
    }
    if(role==='runtime'){
      const keys=new Set(['runId','epoch','planRevisionId','planDigest','sessionId','purpose','messageId','messageDigest','maxTurns','turnId','invitationId','messageIds','inputDigest']);
      if(Object.keys(body.payload).some(k=>!keys.has(k)))fail(422,'runtime_payload','Registered runtime references only; no commands or chat bodies');
      if(action==='runtime.deliver'&&typeof body.payload.sessionId!=='string')fail(422,'runtime_session','Existing session reference required');
      if(body.payload.messageIds!==undefined&&(!Array.isArray(body.payload.messageIds)||body.payload.messageIds.length>20||body.payload.messageIds.some(x=>typeof x!=='string'||x.length>160)))fail(422,'runtime_messages','At most20 exact message references');
    }
    const input: ExecutionInput = {
      key, projectId, role, action, payload: body.payload, deadlineAt,
      ...(body.consequential === true ? { consequential: true } : {}),
    };
    return { input, digest: '' };
  }

  private async digestOfInput(input: ExecutionInput): Promise<string> {
    return digestOf({
      projectId: input.projectId,
      key: input.key,
      role: input.role,
      action: input.action,
      payload: input.payload,
    });
  }

  /**
   * Lease/deadline reconciliation, run inside every mutating transaction so
   * expiry does not depend on an alarm firing. A leased non-consequential
   * job past leasedUntil returns to the queue with a fresh lineage; a
   * consequential one becomes effect-unconfirmed permanently. Any active
   * job past deadlineAt ends honestly (failed, or effect-unconfirmed).
   */
  private async sweep(tx: CloudStorage): Promise<void> {
    const nowMs = Date.parse(this.now());
    const jobs = await tx.list<StoredJob>({ prefix: JOB_PREFIX });
    for (const job of jobs.values()) {
      if (!ACTIVE.has(job.status)) continue;
      if (nowMs > Date.parse(job.deadlineAt)) {
        if (isConsequential(job)) {
          this.finish(job, 'effect-unconfirmed', {
            code: 'deadline_exceeded',
            message: 'consequential job deadline passed with the effect unconfirmed',
          });
        } else {
          this.finish(job, 'failed', {
            code: 'deadline_exceeded',
            message: 'job deadline passed before a terminal result',
          });
        }
        await tx.put(JOB_PREFIX + job.id, job);
        continue;
      }
      if (
        job.status === 'leased' &&
        job.leasedUntil !== undefined &&
        nowMs > Date.parse(job.leasedUntil)
      ) {
        if (isConsequential(job)) {
          this.finish(job, 'effect-unconfirmed', {
            code: 'lease_expired',
            message: 'consequential dispatch did not complete inside its lease; effect is unconfirmed',
          });
        } else if (job.attempts >= MAX_DELIVERIES) {
          this.finish(job, 'failed', {
            code: 'delivery_exhausted',
            message: `job was not completed within ${MAX_DELIVERIES} deliveries`,
          });
        } else {
          // Safe to redispatch: the stale leaseId is discarded, so a late
          // result from the lost delivery fails lineage checks.
          job.status = 'queued';
          delete job.leaseId;
          delete job.leasedUntil;
          job.updatedAt = this.now();
        }
        await tx.put(JOB_PREFIX + job.id, job);
      }
    }
  }

  /** Terminal transition: record outcome, purge private payload material. */
  private finish(
    job: StoredJob,
    status: 'completed' | 'failed' | 'effect-unconfirmed' | 'cancelled',
    error?: { code: string; message: string },
  ): void {
    job.status = status;
    if (error !== undefined) job.error = error;
    delete job.leaseId;
    delete job.leasedUntil;
    job.payload = {};
    job.payloadPurged = true;
    job.updatedAt = this.now();
  }

  private async enqueue(body: Record<string, unknown>): Promise<StoredJob> {
    const { input } = this.parseInput(body);
    const digest = await this.digestOfInput(input);
    return this.state.storage.transaction(async (tx) => {
      await this.sweep(tx);
      const ref = await tx.get<KeyRef>(KEY_PREFIX + encodeURIComponent(input.key));
      if (ref !== undefined) {
        const existing = await tx.get<StoredJob>(JOB_PREFIX + ref.jobId);
        if (existing === undefined || ref.digest !== digest || existing.digest !== digest) {
          fail(409, 'execution_key_conflict', 'job key was already used with a different payload');
        }
        return existing;
      }
      let outstanding = 0;
      for (const job of (await tx.list<StoredJob>({ prefix: JOB_PREFIX })).values()) {
        if (ACTIVE.has(job.status)) outstanding += 1;
      }
      if (outstanding >= MAX_OUTSTANDING_JOBS) {
        fail(429, 'execution_queue_full', `at most ${MAX_OUTSTANDING_JOBS} outstanding jobs per project`, {
          retryable: true,
          nextAction: 'wait for outstanding jobs to reach a terminal state',
        });
      }
      const now = this.now();
      const job: StoredJob = {
        id: `exec-${crypto.randomUUID()}`,
        key: input.key,
        projectId: input.projectId,
        role: input.role,
        action: input.action,
        payload: input.payload,
        ...(input.role==='runtime'&&typeof input.payload.sessionId==='string'?{runtimeSessionId:input.payload.sessionId}:{}),
        deadlineAt: input.deadlineAt,
        ...(isConsequential(input) ? { consequential: true } : {}),
        digest,
        status: 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      await tx.put(JOB_PREFIX + job.id, job);
      await tx.put(KEY_PREFIX + encodeURIComponent(job.key), { jobId: job.id, digest });
      return job;
    });
  }

  private async pull(body: Record<string, unknown>): Promise<StoredJob[]> {
    const role = requireRole(body.role);
    const limit = optionalBoundedInt(body.limit, 'limit', 1, MAX_PULL_JOBS, MAX_PULL_JOBS);
    const leaseMs = optionalBoundedInt(body.leaseMs, 'leaseMs', MIN_LEASE_MS, MAX_LEASE_MS, DEFAULT_LEASE_MS);
    return this.state.storage.transaction(async (tx) => {
      await this.sweep(tx);
      const all=[...(await tx.list<StoredJob>({prefix:JOB_PREFIX})).values()];
      const occupied=new Set(all.filter(j=>j.role==='runtime'&&['runtime.start','runtime.deliver'].includes(j.action)&&['leased','effect-unconfirmed'].includes(j.status)).map(j=>j.runtimeSessionId).filter(Boolean));
      const queued:StoredJob[]=[];
      for(const j of all.filter(j=>j.status==='queued'&&j.role===role).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){
        if(queued.length>=limit)break;
        if(j.runtimeSessionId&&['runtime.start','runtime.deliver'].includes(j.action)){if(occupied.has(j.runtimeSessionId))continue;occupied.add(j.runtimeSessionId);}
        queued.push(j);
      }
      const now = this.now();
      const leasedUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      for (const job of queued) {
        job.status = 'leased';
        job.leaseId = crypto.randomUUID();
        job.leasedUntil = leasedUntil;
        job.attempts += 1;
        job.updatedAt = now;
        await tx.put(JOB_PREFIX + job.id, job);
      }
      return queued;
    });
  }

  private async loadForCompletion(
    tx: CloudStorage, body: Record<string, unknown>,
  ): Promise<{ job: StoredJob; jobId: string; leaseId: string; role: ExecutionRole }> {
    const jobId = requireString(body.jobId, 'jobId');
    const leaseId = requireString(body.leaseId, 'leaseId');
    const role = body.role === undefined ? undefined : requireRole(body.role);
    const job = await tx.get<StoredJob>(JOB_PREFIX + jobId);
    if (job === undefined) {
      fail(404, 'job_not_found', 'unknown execution job');
    }
    // Cross-purpose completions are refused even if the caller learned a
    // lease id: the role is edge-inferred from the bearer, never the body.
    if (role !== undefined && job.role !== role) {
      fail(403, 'purpose_mismatch', 'job belongs to a different bridge purpose');
    }
    return { job, jobId, leaseId, role: job.role };
  }

  private async complete(body: Record<string, unknown>): Promise<StoredJob> {
    const hasResult = body.result !== undefined;
    const err = body.error === undefined ? undefined : parseJobError(body.error);
    if (hasResult === (err !== undefined)) {
      fail(422, 'invalid_field', 'exactly one of "result" or "error" is required');
    }
    if (hasResult && byteLength(body.result) > MAX_RESULT_BYTES) {
      fail(422, 'result_too_large', `result exceeds ${MAX_RESULT_BYTES} canonical bytes`);
    }
    const outcomeDigest = await digestOf(hasResult ? { result: body.result } : { error: err });
    const leaseDigest = await digestOf(requireString(body.leaseId, 'leaseId'));
    return this.state.storage.transaction(async (tx) => {
      await this.sweep(tx);
      const { job, jobId, leaseId } = await this.loadForCompletion(tx, body);
      if (TERMINAL.has(job.status)) {
        // Duplicate-delivery reconciliation on the SAME lease: an identical
        // replay returns the stored job; a conflicting completion is 409.
        if (job.terminalLeaseDigest !== leaseDigest) {
          // Expiry/cancellation and older records without accepted terminal
          // lineage fail closed, as do completions from unrelated leases.
          fail(409, 'stale_lease', 'job already reached a terminal state on a different lineage');
        }
        if (job.terminalOutcomeDigest !== outcomeDigest) {
          fail(409, 'result_conflict', 'a different result was already recorded for this lease');
        }
        return job;
      }
      if (job.status !== 'leased' || job.leaseId !== leaseId) {
        fail(409, 'stale_lease', 'lease does not match the current job lineage');
      }
      if (Date.parse(this.now()) > Date.parse(job.leasedUntil!)) {
        fail(409, 'lease_expired', 'lease expired before the result arrived');
      }
      job.terminalLeaseDigest = leaseDigest;
      job.terminalOutcomeDigest = outcomeDigest;
      if (err !== undefined) {
        this.finish(job, 'failed', err);
      } else {
        if(job.role==='runtime'&&Object.keys(body.result as object).some(k=>!['status','sessionId','runId','epoch','responseModel','usage','turnId','messageIds','inputDigest','stopped'].includes(k)))fail(422,'runtime_result','Runtime results carry evidence references and usage, never chat bodies');
        job.result = sanitizeResultValue(body.result) as Record<string, unknown>;
        this.finish(job, 'completed');
      }
      await tx.put(JOB_PREFIX + jobId, job);
      return job;
    });
  }

  private async heartbeat(body: Record<string, unknown>): Promise<StoredJob> {
    return this.state.storage.transaction(async (tx) => {
      await this.sweep(tx);
      const { job, jobId, leaseId } = await this.loadForCompletion(tx, body);
      if (TERMINAL.has(job.status)) {
        fail(409, 'job_terminal', `job is ${job.status}`);
      }
      if (job.status !== 'leased' || job.leaseId !== leaseId) {
        fail(409, 'stale_lease', 'lease does not match the current job lineage');
      }
      job.leasedUntil = new Date(Date.parse(this.now()) + HEARTBEAT_LEASE_MS).toISOString();
      job.updatedAt = this.now();
      await tx.put(JOB_PREFIX + jobId, job);
      return job;
    });
  }

  /**
   * Bounded await: polls until the job is terminal or the timeout elapses,
   * then returns the honest current record. A timed-out wait never marks
   * the job complete and never fabricates result material.
   */
  private async wait(body: Record<string, unknown>): Promise<StoredJob> {
    const jobId = requireString(body.jobId, 'jobId');
    const timeoutMs = optionalBoundedInt(
      body.timeoutMs, 'timeoutMs', 0, MAX_WAIT_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS,
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.state.storage.transaction(async (tx) => {
        await this.sweep(tx);
        return tx.get<StoredJob>(JOB_PREFIX + jobId);
      });
      if (job === undefined) {
        fail(404, 'job_not_found', 'unknown execution job');
      }
      if (TERMINAL.has(job.status)) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return job;
      await sleep(Math.min(WAIT_POLL_MS, remaining));
    }
  }
}

function parseJobError(value: unknown): { code: string; message: string } {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    fail(422, 'invalid_field', '"error" must be {code:string, message:string}');
  }
  const code = (value.code as string).slice(0, 120);
  const message = (value.message as string).slice(0, MAX_ERROR_CHARS);
  return { code, message };
}

// -- edge-facing helpers ----------------------------------------------------

function executionStub(env: CloudEnv, projectId: string) {
  const ns: CloudNamespace | undefined = env.EXECUTION_OBJECT;
  if (ns === undefined) {
    fail(503, 'execution_unavailable', 'EXECUTION_OBJECT binding is not configured', {
      retryable: true,
    });
  }
  return ns.get(ns.idFromName(projectId));
}

function internalRequest(op: string, body: unknown): Request {
  return new Request(`https://execution.internal/internal/execution/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readInternal(response: Response): Promise<Record<string, unknown>> {
  let doc: Record<string, unknown> | undefined;
  try {
    doc = (await response.json()) as Record<string, unknown>;
  } catch {
    fail(502, 'execution_unavailable', 'execution object returned an unreadable response', {
      retryable: true,
    });
  }
  if (!response.ok) {
    const error = isRecord(doc!.error) ? doc!.error : {};
    fail(response.status,
      typeof error.code === 'string' ? error.code : 'execution_error',
      typeof error.message === 'string' ? error.message : 'execution request failed',
      { retryable: error.retryable === true });
  }
  return doc!;
}

/**
 * Server-side enqueue (cloud control plane only — directory, changes and
 * checks modules call this; there is no caller-facing route). The stored
 * job is immutable: the key replays only against an identical digest.
 */
export async function enqueueExecution(env: CloudEnv, input: ExecutionInput): Promise<ExecutionJob> {
  const stub = executionStub(env, input.projectId);
  const doc = await readInternal(await stub.fetch(internalRequest('enqueue', input)));
  return doc.job as ExecutionJob;
}

/**
 * Bounded wait for a job to reach a terminal state (default ~40s). Returns
 * the latest honest record either way; callers inspect `status` and must
 * not treat a non-terminal job as failed or succeeded.
 */
export async function waitExecution(
  env: CloudEnv, projectId: string, jobId: string, timeoutMs?: number,
): Promise<ExecutionJob> {
  const stub = executionStub(env, projectId);
  const doc = await readInternal(await stub.fetch(
    internalRequest('wait', { jobId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
  ));
  return doc.job as ExecutionJob;
}

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Role comes ONLY from which configured purpose token the bearer matches. */
async function bridgeRole(request: Request, env: CloudEnv): Promise<ExecutionRole> {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  const configured=([['git',env.GIT_BRIDGE_TOKEN],['check',env.CHECK_BRIDGE_TOKEN],['runtime',env.RUNTIME_BRIDGE_TOKEN]] as const).filter(([,t])=>typeof t==='string'&&t!=='');
  if(!configured.length)fail(503,'bridge_unavailable','no bridge credentials are configured',{retryable:true});
  if(new Set(configured.map(([,t])=>t)).size!==configured.length)fail(503,'bridge_misconfigured','bridge purpose tokens must be distinct');
  if(match===null)fail(401,'unauthenticated','a bridge bearer token is required');
  const presented=await sha256Hex(match![1]);
  for(const [role,token] of configured)if(presented===await sha256Hex(token!))return role;
  fail(401, 'unauthenticated', 'invalid bridge token');
}

/**
 * Public edge handler for the companion bridge. Mounted by the worker
 * (lane c-swe-09) at /internal/v1/execution/*; paths outside the prefix
 * get 404 so the composition can fall through.
 */
function bridgeProjects(env: CloudEnv, role: ExecutionRole): Set<string> {
  const raw = env[{git:'GIT_BRIDGE_PROJECT_IDS',check:'CHECK_BRIDGE_PROJECT_IDS',runtime:'RUNTIME_BRIDGE_PROJECT_IDS'}[role]];
  const ids = typeof raw === 'string' ? raw.split(',').map((id) => id.trim()).filter(Boolean) : [];
  if (ids.length === 0 || ids.length > MAX_PULL_PROJECTS) {
    fail(503, 'bridge_misconfigured', 'bridge project allowlist must be configured');
  }
  return new Set(ids);
}

export async function bridgeFetch(request: Request, env: CloudEnv): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const op = path.slice(EXECUTION_ROUTE_PREFIX.length + 1);
    if (
      !path.startsWith(`${EXECUTION_ROUTE_PREFIX}/`) ||
      (op !== 'pull' && op !== 'result' && op !== 'heartbeat')
    ) {
      fail(404, 'not_found', 'not an execution bridge route');
    }
    if (request.method !== 'POST') {
      fail(405, 'method_not_allowed', 'execution bridge accepts POST');
    }
    const role = await bridgeRole(request, env);
    const allowed = bridgeProjects(env, role);
    const body = await readJsonBody(request, MAX_BODY_BYTES);

    if (op === 'pull') {
      // The body may state the role for self-checking but never asserts it:
      // a mismatch against the bearer-inferred purpose is rejected.
      if (body.role !== undefined && body.role !== role) {
        fail(403, 'purpose_mismatch', 'body role does not match the bearer credential purpose');
      }
      const ids = body.projectIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PULL_PROJECTS) {
        fail(422, 'invalid_field', `"projectIds" must be an array of 1..${MAX_PULL_PROJECTS} ids`);
      }
      const projectIds = (ids as unknown[]).map((id) => requireString(id, 'projectIds[]'));
      if (projectIds.some((id) => !allowed.has(id))) {
        fail(403, 'project_not_allowed', 'bridge credential does not authorize this project');
      }
      const jobs: Record<string, unknown>[] = [];
      for (const projectId of projectIds) {
        if (jobs.length >= MAX_PULL_JOBS) break;
        const doc = await readInternal(await executionStub(env, projectId).fetch(
          internalRequest('pull', {
            role,
            limit: Math.min(
              optionalBoundedInt(body.limit, 'limit', 1, MAX_PULL_JOBS, MAX_PULL_JOBS),
              MAX_PULL_JOBS - jobs.length,
            ),
            ...(body.leaseMs !== undefined ? { leaseMs: body.leaseMs } : {}),
          }),
        ));
        if (Array.isArray(doc.jobs)) jobs.push(...(doc.jobs as Record<string, unknown>[]));
      }
      return json(200, { jobs });
    }

    // result / heartbeat: project routing comes from the body; the role is
    // still forwarded so the object can reject cross-purpose completions.
    const projectId = requireString(body.projectId, 'projectId');
    if (!allowed.has(projectId)) {
      fail(403, 'project_not_allowed', 'bridge credential does not authorize this project');
    }
    const doc = await readInternal(await executionStub(env, projectId).fetch(
      internalRequest(op, { ...body, role }),
    ));
    return json(200, doc);
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    return json(500, {
      error: { status: 500, code: 'internal_error', message: 'internal error', retryable: false },
    });
  }
}
