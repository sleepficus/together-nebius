// Private cloud companion for the Together slice, phase 04 (lane c-swe-09).
//
// OUTBOUND-ONLY bridge on Steve's verified host: it opens no inbound port,
// polls only the configured project ids through
// /internal/v1/execution/{pull,result,heartbeat} with the purpose-scoped
// bridge tokens, and hands leased jobs to the lane executors
// companion/git-executor.ts (c-swe-06) and companion/check-executor.ts
// (c-swe-08). Candidate code still runs only inside the existing pinned
// Docker snapshot runner on this host; nothing here claims cloud-side
// execution and a dependency outage is reported, never faked.
//
// Config (environment only -- NO secrets in argv):
//   TOGETHER_CLOUD_API_URL            worker origin, e.g. https://host.workers.dev
//   TOGETHER_PROJECT_IDS              comma-separated allowlisted project ids
//   TOGETHER_GIT_BRIDGE_TOKEN         git-role bearer (or _FILE variant)
//   TOGETHER_GIT_BRIDGE_TOKEN_FILE    file containing the token; must be 0600
//   TOGETHER_CHECK_BRIDGE_TOKEN       check-role bearer (or _FILE variant)
//   TOGETHER_CHECK_BRIDGE_TOKEN_FILE  file containing the token; must be 0600
//   TOGETHER_COMPANION_SCRATCH        owned scratch root (default ./.together-companion)
//   TOGETHER_POLL_INTERVAL_MS         idle poll interval (default 5000)
//   TOGETHER_HEARTBEAT_INTERVAL_MS    lease heartbeat while a job runs (default 15000)
//   TOGETHER_DOCKER_BIN               docker binary for the check executor (default docker)
//
// Exit codes: 0 clean stop / successful --once cycle, 1 dependency
// outage during --once or fatal error, 2 usage/config error.
// stdout carries redacted status lines only: role/job/action/status, never
// payloads or credentials.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  BridgeOptions, CheckExecutionHandler, ExecutionJob, ExecutionRole,
  GitExecutionHandler,
} from '../cloud/phase04-contract.ts';

const ENV = {
  apiUrl: 'TOGETHER_CLOUD_API_URL',
  projectIds: 'TOGETHER_PROJECT_IDS',
  gitToken: 'TOGETHER_GIT_BRIDGE_TOKEN',
  gitTokenFile: 'TOGETHER_GIT_BRIDGE_TOKEN_FILE',
  checkToken: 'TOGETHER_CHECK_BRIDGE_TOKEN',
  checkTokenFile: 'TOGETHER_CHECK_BRIDGE_TOKEN_FILE',
  runtimeToken:'TOGETHER_RUNTIME_BRIDGE_TOKEN',
  runtimeTokenFile:'TOGETHER_RUNTIME_BRIDGE_TOKEN_FILE',
  scratch: 'TOGETHER_COMPANION_SCRATCH',
  pollIntervalMs: 'TOGETHER_POLL_INTERVAL_MS',
  heartbeatIntervalMs: 'TOGETHER_HEARTBEAT_INTERVAL_MS',
  dockerBin: 'TOGETHER_DOCKER_BIN',
} as const;

const DEFAULT_POLL_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 15000;
const MIN_INTERVAL_MS = 10;
const MAX_ERROR_CHARS = 200;
const BRIDGE_PREFIX = '/internal/v1/execution';

type LaneExecutor = (job: ExecutionJob, opts: BridgeOptions) => Promise<Record<string, unknown>>;

export interface CompanionConfig {
  apiUrl: string;
  projectIds: string[];
  gitBridgeToken?: string;
  checkBridgeToken?: string;
  runtimeBridgeToken?: string;
  scratchRoot: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  dockerBin?: string;
}

export interface CompanionDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  /** Test seam: inject executors; production resolves the lane modules. */
  gitExecutor?: GitExecutionHandler | null;
  checkExecutor?: CheckExecutionHandler | null;
  runtimeExecutor?: LaneExecutor | null;
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Single poll cycle then exit (acceptance/operator mode). */
  once?: boolean;
}

class CompanionUsageError extends Error {}

/** Token files must be owner-only; a world/group-readable one is refused. */
function readTokenFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CompanionUsageError(`token file ${path} must be 0600 (mode ${mode.toString(8)})`);
  }
  const token = readFileSync(path, 'utf8').trim();
  if (token === '') throw new CompanionUsageError(`token file ${path} is empty`);
  return token;
}

function tokenFromEnv(
  env: Record<string, string | undefined>,
  tokenVar: string,
  fileVar: string,
): string | undefined {
  const direct = env[tokenVar];
  if (typeof direct === 'string' && direct !== '') return direct;
  const file = env[fileVar];
  if (typeof file === 'string' && file !== '') return readTokenFile(file);
  return undefined;
}

function boundedInterval(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS || n > 3600_000) {
    throw new CompanionUsageError(`${name} must be ${MIN_INTERVAL_MS}..3600000 ms`);
  }
  return Math.floor(n);
}

export function loadConfig(env: Record<string, string | undefined>): CompanionConfig {
  const missing: string[] = [];
  const apiUrl = env[ENV.apiUrl]?.replace(/\/+$/, '');
  if (!apiUrl) missing.push(ENV.apiUrl);
  const projectIds = (env[ENV.projectIds] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (projectIds.length === 0) missing.push(ENV.projectIds);
  const gitBridgeToken = tokenFromEnv(env, ENV.gitToken, ENV.gitTokenFile);
  const checkBridgeToken = tokenFromEnv(env, ENV.checkToken, ENV.checkTokenFile);
  const runtimeBridgeToken=tokenFromEnv(env,ENV.runtimeToken,ENV.runtimeTokenFile);
  if (gitBridgeToken === undefined && checkBridgeToken === undefined && runtimeBridgeToken===undefined) {
    missing.push(`${ENV.gitToken} and/or ${ENV.checkToken}`);
  }
  if (missing.length > 0) {
    throw new CompanionUsageError(`missing companion configuration: ${missing.join(', ')}`);
  }
  const scratchRoot = resolve(env[ENV.scratch] ?? '.together-companion');
  mkdirSync(scratchRoot, { recursive: true });
  // Owned scratch: never group/world accessible.
  chmodSync(scratchRoot, 0o700);
  return {
    apiUrl: apiUrl as string,
    projectIds,
    ...(gitBridgeToken !== undefined ? { gitBridgeToken } : {}),
    ...(checkBridgeToken !== undefined ? { checkBridgeToken } : {}),
    ...(runtimeBridgeToken!==undefined?{runtimeBridgeToken}:{}),
    scratchRoot,
    pollIntervalMs: boundedInterval(env[ENV.pollIntervalMs], DEFAULT_POLL_MS, ENV.pollIntervalMs),
    heartbeatIntervalMs: boundedInterval(env[ENV.heartbeatIntervalMs], DEFAULT_HEARTBEAT_MS, ENV.heartbeatIntervalMs),
    ...(env[ENV.dockerBin] !== undefined && env[ENV.dockerBin] !== ''
      ? { dockerBin: env[ENV.dockerBin] }
      : {}),
  };
}

/**
 * Lane executor resolution. Literal specifiers keep bundlers honest; the
 * `as string` cast keeps pre-merge typecheck truthful about the sibling
 * files being absent from this packet. An absent executor disables its
 * role -- the role is never pulled, so jobs stay queued in the broker
 * instead of being leased by something that cannot run them.
 */
const executorImporters: Record<ExecutionRole, () => Promise<LaneExecutor | null>> = {
  runtime:async()=>null, // Capability create was unconfirmed; production lane stays disabled.

  git: () =>
    import('../companion/git-executor.ts' as string)
      .then((m) => ((m as { runGitExecution?: LaneExecutor }).runGitExecution ?? null), () => null),
  check: () =>
    import('../companion/check-executor.ts' as string)
      .then((m) => ((m as { runCheckExecution?: LaneExecutor }).runCheckExecution ?? null), () => null),
};

interface BridgeJob extends ExecutionJob { leaseId?: string }

interface PullEnvelope {
  jobs?: BridgeJob[];
  /** Alternative shape a broker may send: [{job, leaseId}]. */
  leases?: { job: BridgeJob; leaseId?: string }[];
}

function leasedJobs(body: PullEnvelope): BridgeJob[] {
  if (Array.isArray(body.jobs)) return body.jobs;
  if (Array.isArray(body.leases)) {
    return body.leases.map((l) => ({ ...l.job, ...(l.leaseId !== undefined ? { leaseId: l.leaseId } : {}) }));
  }
  return [];
}

function sanitizeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS);
}

export async function runCompanion(deps: CompanionDeps = {}): Promise<number> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const out = deps.out ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fetchFn = deps.fetchFn ?? fetch;
  const once = deps.once === true || env.TOGETHER_COMPANION_ONCE === '1';

  let config: CompanionConfig;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof CompanionUsageError) {
      out(`[companion] config error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  // Executors resolve before any pull: a missing lane module disables its
  // role truthfully and queued jobs are never leased by a non-executor.
  const executors: Partial<Record<ExecutionRole, LaneExecutor>> = {};
  executors.git = deps.gitExecutor === undefined ? await executorImporters.git() : deps.gitExecutor;
  executors.check = deps.checkExecutor === undefined ? await executorImporters.check() : deps.checkExecutor;

  executors.runtime=deps.runtimeExecutor??null;
  const roles: { role: ExecutionRole; token: string }[] = [];
  if (config.gitBridgeToken !== undefined) roles.push({ role: 'git', token: config.gitBridgeToken });
  if (config.checkBridgeToken !== undefined) roles.push({ role: 'check', token: config.checkBridgeToken });

  if(config.runtimeBridgeToken)roles.push({role:'runtime',token:config.runtimeBridgeToken});
  for (const { role } of roles) {
    if (executors[role] === undefined || executors[role] === null) {
      out(`[companion] role=${role} executor unavailable; not pulling (queued jobs stay queued)`);
    }
  }

  const bridgeOptions: BridgeOptions = {
    root: config.scratchRoot,
    apiUrl: config.apiUrl,
    projectIds: config.projectIds,
    ...(config.gitBridgeToken !== undefined ? { gitBridgeToken: config.gitBridgeToken } : {}),
    ...(config.checkBridgeToken !== undefined ? { checkBridgeToken: config.checkBridgeToken } : {}),
    ...(config.runtimeBridgeToken?{runtimeBridgeToken:config.runtimeBridgeToken}:{}),
    fetch: fetchFn,
    ...(config.dockerBin !== undefined ? { dockerBin: config.dockerBin } : {}),
  };

  const post = async (suffix: string, token: string, body: Record<string, unknown>): Promise<Response> =>
    fetchFn(`${config.apiUrl}${BRIDGE_PREFIX}/${suffix}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  let stopping = false;
  const stop = () => { stopping = true; };
  const sig = deps.signal;
  if (sig !== undefined) {
    if (sig.aborted) stopping = true;
    else sig.addEventListener('abort', stop, { once: true });
  }
  const onSigint = () => stop();
  const onSigterm = () => stop();
  if (deps.signal === undefined && typeof process !== 'undefined') {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  let outage = false;
  try {
    do {
      for (const { role, token } of roles) {
        if (stopping) break;
        const executor = executors[role];
        if (executor === undefined || executor === null) continue;
        let body: PullEnvelope;
        try {
          const res = await post('pull', token, { role, projectIds: config.projectIds });
          if (!res.ok) {
            outage = true;
            out(`[companion] role=${role} pull failed status=${res.status}; jobs left queued`);
            continue;
          }
          body = (await res.json()) as PullEnvelope;
        } catch (err) {
          outage = true;
          out(`[companion] role=${role} dependency unreachable (${sanitizeMessage(err)}); retrying later`);
          continue;
        }
        for (const job of leasedJobs(body)) {
          if (stopping) break;
          const jobId = job.id;
          const leaseId = job.leaseId ?? '';
          out(`[companion] role=${role} job=${jobId} action=${job.action} leased`);
          const heartbeat = setInterval(() => {
            void post('heartbeat', token, {
              projectId: job.projectId, jobId, leaseId,
            }).then(
              () => undefined,
              () => undefined,
            );
          }, config.heartbeatIntervalMs);
          if (typeof heartbeat.unref === 'function') heartbeat.unref();
          try {
            const result = await executor(job, bridgeOptions);
            const res = await post('result', token, {
              projectId: job.projectId, jobId, leaseId, result,
            });
            if (res.ok) {
              out(`[companion] role=${role} job=${jobId} result accepted`);
            } else {
              outage = true;
              out(`[companion] role=${role} job=${jobId} result rejected status=${res.status}; lease expiry reconciles`);
            }
          } catch (err) {
            const res = await post('result', token, {
              projectId: job.projectId, jobId, leaseId,
              error: { code: 'executor_error', message: sanitizeMessage(err) },
            }).catch(() => null);
            out(`[companion] role=${role} job=${jobId} executor error reported${res === null ? ' (post failed)' : ` status=${res.status}`}`);
            if (res === null) outage = true;
          } finally {
            clearInterval(heartbeat);
          }
        }
      }
      if (!once && !stopping) await sleep(config.pollIntervalMs);
    } while (!once && !stopping);
  } finally {
    if (deps.signal === undefined && typeof process !== 'undefined') {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }
  out(`[companion] stopped${stopping ? ' (stop requested)' : ''}`);
  return once && outage ? 1 : 0;
}

export function main(argv: string[] = process.argv.slice(2), deps: CompanionDeps = {}): Promise<number> {
  const once = argv.includes('--once');
  return runCompanion({ ...deps, once: deps.once ?? once });
}

// Executed directly: tsx scripts/cloud-companion.ts [--once]
const invokedAs =
  typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.length > 1
    ? process.argv[1]
    : undefined;
if (invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
