// Docker-isolated snapshot check executor for the Together slice
// (seat b-swe-05).
//
// SECURITY BOUNDARY: untrusted candidate code is only ever executed inside
// a real Docker container -- --network none, read-only root filesystem,
// read-only source snapshot mount, scratch tmpfs, dropped identity
// (nobody), bounded memory/CPU, no inherited home or account environment,
// and a hard wall-clock timeout enforced by an external container kill.
// If Docker is unavailable we report 'blocked': a same-host subprocess is
// NOT an isolation boundary and this module never falls back to one.
//
// The trusted collector process uses runSnapshotJob() to execute the
// registered command and produce bounded output + hashes, then reports the
// outcome through the job-scoped collector completion route. Platform-side
// code uses createSnapshotRunner() as the RunnerService dispatch/cancel
// capability. Both paths are honest about availability.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Id, RunnerService, Sha } from '../lib/types.ts';

export const DEFAULT_IMAGE = 'node:22.23.1-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2';
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const HARD_TIMEOUT_MARGIN_MS = 5000;
/** Bounded manifest hashing: enough for a snapshot receipt, not a repo scan. */
const MAX_MANIFEST_FILES = 4096;
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

/**
 * Trusted completion channel. The job-scoped collectorToken reaches ONLY
 * this server-side transport (never a requester-visible response); the
 * composition layer maps the report onto the collector completion route.
 */
export interface CollectorReport {
  projectId: Id;
  jobId: Id;
  /** Deterministic per-job completion id: a retried report replays safely. */
  operationId: Id;
  collectorToken: string;
  outcome: SnapshotResult['outcome'];
  candidateSha: Sha;
  command: string;
  inputHash?: string;
  outputHash: string;
  logTail: string;
  startedAt: string;
  endedAt: string;
}
export type CollectorTransport = (report: CollectorReport) => Promise<unknown>;

export interface SnapshotRunnerOptions {
  dockerBin?: string;
  image?: string;
  namePrefix?: string;
  hardTimeoutMarginMs?: number;
  /** Fallback snapshot dir when a dispatch carries no snapshotRef. */
  defaultSnapshotDir?: string;
  /**
   * When present, dispatch runs the job through the trusted in-process
   * collector (the container remains the untrusted-code boundary) and
   * reports the outcome through this transport. When absent, dispatch keeps
   * the detached-container behavior and an external collector is expected
   * to complete the job.
   */
  collector?: CollectorTransport;
  snapshotProvider?: (sha: Sha) => Promise<{ dir: string; cleanup(): void }> | { dir: string; cleanup(): void };
}

export interface SnapshotResult {
  outcome: 'pass' | 'fail' | 'error' | 'blocked';
  exitCode: number | null;
  timedOut: boolean;
  blockedReason?: string;
  /** SHA-256 over the snapshot manifest (paths + content), when computable. */
  inputHash?: string;
  /** SHA-256 over the captured (bounded) combined output. */
  outputHash: string;
  /** Truncated tail of combined stdout+stderr for receipts. */
  logTail: string;
  startedAt: string;
  endedAt: string;
}

/** True only when `docker` resolves AND the daemon answers. */
export function dockerAvailableSync(dockerBin = 'docker'): boolean {
  try {
    const res = spawnSync(dockerBin, ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'pipe',
      timeout: 10_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function dockerAvailable(dockerBin = 'docker'): Promise<boolean> {
  return Promise.resolve(dockerAvailableSync(dockerBin));
}

/** Container names must be safe for docker -- no caller-controlled garbage. */
export function containerName(prefix: string, jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
  return `${prefix}-${safe}`;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * SHA-256 over the snapshot manifest: sorted relative paths plus content
 * hashes. Bounded file count/bytes; symlinks and non-regular entries are
 * recorded by name only so the manifest stays honest without following them.
 */
export function snapshotInputHash(dir: string): string {
  const root = resolve(dir);
  const hash = createHash('sha256');
  const stack: string[] = [''];
  let files = 0;
  let bytes = 0;
  while (stack.length > 0 && files < MAX_MANIFEST_FILES && bytes < MAX_MANIFEST_BYTES) {
    const rel = stack.pop() as string;
    const abs = join(root, rel);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const childRel = rel === '' ? name : `${rel}${sep}${name}`;
      const childAbs = join(root, childRel);
      let st;
      try {
        // lstat, never stat: a symlink inside the snapshot must not pull
        // content from outside it into the manifest hash.
        st = lstatSync(childAbs);
      } catch {
        hash.update(`unreadable:${childRel}\n`);
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = '';
        try {
          target = readlinkSync(childAbs);
        } catch {
          target = '<unreadable>';
        }
        hash.update(`symlink:${childRel}:${target}\n`);
      } else if (st.isDirectory()) {
        stack.push(childRel);
      } else if (st.isFile()) {
        files += 1;
        if (files > MAX_MANIFEST_FILES || bytes + st.size > MAX_MANIFEST_BYTES) {
          hash.update(`truncated:${childRel}\n`);
          break;
        }
        bytes += st.size;
        hash.update(`file:${childRel}:${st.size}\n`);
        hash.update(readFileSync(childAbs));
      } else {
        hash.update(`other:${childRel}\n`);
      }
    }
  }
  return hash.digest('hex');
}

function runArgs(name: string, snapshotDir: string, image: string, command: string, environment: Record<string, string> = {}): string[] {
  const entries = Object.entries(environment);
  if (entries.length > 32 || entries.some(([k,v]) => !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(k) || typeof v !== 'string' || v.length > 256)) {
    throw new Error('invalid registered check environment');
  }
  // argv form only: the command string is handed to the container's own sh
  // and is never interpolated into a host shell.
  return [
    'run', '--rm', '--name', name,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '128',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--memory', '512m',
    '--cpus', '1',
    '--user', '65534:65534',
    '--env', 'HOME=/nonexistent',
    '--env', 'TMPDIR=/tmp',
    ...entries.flatMap(([k,v]) => ['--env', `${k}=${v}`]),
    '--stop-timeout', '2',
    '--volume', `${snapshotDir}:/src:ro`,
    '--workdir', '/src',
    image,
    'sh', '-c', command,
  ];
}

function validateSnapshot(snapshotRef: string | undefined): { ok: boolean; dir?: string; reason?: string } {
  if (snapshotRef === undefined) return { ok: false, reason: 'snapshot-missing' };
  const dir = resolve(snapshotRef);
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, reason: 'snapshot-not-directory' };
  } catch {
    return { ok: false, reason: 'snapshot-missing' };
  }
  return { ok: true, dir };
}

/**
 * RunnerService capability over real Docker. dispatch() starts a detached,
 * deadline-enforced container; cancel() removes it. Both answer truthfully
 * -- 'docker-unavailable' means Check blocked, not a faked pass.
 */
export function createSnapshotRunner(opts?: SnapshotRunnerOptions): RunnerService {
  const dockerBin = opts?.dockerBin ?? 'docker';
  const image = opts?.image ?? DEFAULT_IMAGE;
  const prefix = opts?.namePrefix ?? 'together-check';
  const margin = opts?.hardTimeoutMarginMs ?? HARD_TIMEOUT_MARGIN_MS;
  const defaultSnapshotDir = opts?.defaultSnapshotDir;
  const collector = opts?.collector;

  return {
    async dispatch(input) {
      if (!dockerAvailableSync(dockerBin)) {
        return { accepted: false, reason: 'docker-unavailable' };
      }
      let owned: { dir: string; cleanup(): void } | undefined;
      if (opts?.snapshotProvider) {
        try { owned = await opts.snapshotProvider(input.candidateSha); }
        catch { return { accepted: false, reason: 'candidate-snapshot-unavailable' }; }
      } else if (defaultSnapshotDir && input.snapshotRef && resolve(input.snapshotRef) !== resolve(defaultSnapshotDir)) {
        return { accepted: false, reason: 'snapshot-outside-configured-root' };
      }
      const snap = validateSnapshot(owned?.dir ?? defaultSnapshotDir ?? input.snapshotRef);
      if (!snap.ok || snap.dir === undefined) {
        owned?.cleanup();
        return { accepted: false, reason: snap.reason ?? 'snapshot-missing' };
      }
      const name = containerName(prefix, input.jobId);
      if (collector !== undefined) {
        // Trusted in-process collector: the container stays the untrusted
        // boundary; this side only observes exit/output and reports the
        // outcome through the server-side transport with the job token.
        const snapshotDir = snap.dir;
        void (async () => {
          try {
            const result = await runSnapshotJob({
              jobId: input.jobId,
              snapshotRef: snapshotDir,
              command: input.command,
              timeoutMs: input.timeoutMs,
              environment: input.environment,
              image,
              dockerBin,
              namePrefix: prefix,
            });
            if (input.collectorToken === undefined) return;
            await collector({
              projectId: input.projectId,
              jobId: input.jobId,
              operationId: `collector-complete-${input.jobId}`,
              collectorToken: input.collectorToken,
              outcome: result.outcome,
              candidateSha: input.candidateSha,
              command: input.command,
              ...(result.inputHash !== undefined ? { inputHash: result.inputHash } : {}),
              outputHash: result.outputHash,
              logTail: result.logTail,
              startedAt: result.startedAt,
              endedAt: result.endedAt,
            });
          } catch {
            // A failed run or report leaves the job 'dispatched'; its
            // deadlineAt record remains the durable bound. Nothing is
            // retried or faked from here.
          } finally { owned?.cleanup(); }
        })();
        return { accepted: true };
      }
      const args = ['run', '--detach', ...runArgs(name, snap.dir, image, input.command, input.environment).slice(1)];
      const child = spawn(dockerBin, args, { stdio: 'ignore', detached: true });
      const spawned = await new Promise<boolean>((resolvePromise) => {
        child.once('error', () => resolvePromise(false));
        child.once('spawn', () => resolvePromise(true));
      });
      child.unref();
      if (!spawned) return { accepted: false, reason: 'docker-spawn-failed' };
      // Hard timeout: kill the container at the job deadline. Best-effort
      // cleanup lives alongside the CheckJob.deadlineAt record, which is
      // the durable bound the collector completes against.
      const killer = setTimeout(() => {
        try {
          spawnSync(dockerBin, ['rm', '-f', name], { stdio: 'ignore', timeout: 15_000 });
        } catch {
          // Container already gone is a fine outcome.
        }
      }, input.timeoutMs + margin);
      killer.unref();
      return { accepted: true };
    },

    async cancel(input) {
      if (!dockerAvailableSync(dockerBin)) {
        return { accepted: false, reason: 'docker-unavailable' };
      }
      const name = containerName(prefix, input.jobId);
      const res = spawnSync(dockerBin, ['rm', '-f', name], { stdio: 'pipe', timeout: 15_000 });
      return res.status === 0
        ? { accepted: true }
        : { accepted: false, reason: 'not-running' };
    },
  };
}

/** Force-remove a job container by name. Best-effort and honest: the
 * answer reflects what docker reported, never an assumed removal. */
export function removeSnapshotContainer(
  name: string,
  dockerBin = 'docker',
): { removed: boolean; reason?: string } {
  if (!dockerAvailableSync(dockerBin)) {
    return { removed: false, reason: 'docker-unavailable' };
  }
  try {
    const res = spawnSync(dockerBin, ['rm', '-f', name], { stdio: 'ignore', timeout: 15_000 });
    return res.status === 0 ? { removed: true } : { removed: false, reason: 'not-running' };
  } catch {
    return { removed: false, reason: 'docker-error' };
  }
}

/**
 * Foreground snapshot execution for the trusted collector process. Runs the
 * registered command inside the isolated container, captures bounded
 * output, enforces the hard timeout via docker rm -f, and returns honest
 * hashes. timeout => 'error' (a runner outcome, never a code defect).
 */
export function runSnapshotJob(input: {
  jobId?: string;
  snapshotRef: string;
  command: string;
  timeoutMs: number;
  environment?: Record<string, string>;
  image?: string;
  dockerBin?: string;
  maxOutputBytes?: number;
  /** Container-name prefix; dispatch passes its own so cancel() matches. */
  namePrefix?: string;
}): Promise<SnapshotResult> {
  const dockerBin = input.dockerBin ?? 'docker';
  const image = input.image ?? DEFAULT_IMAGE;
  const maxOutput = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = new Date().toISOString();
  const done = (partial: Omit<SnapshotResult, 'startedAt' | 'endedAt'>): SnapshotResult => ({
    ...partial,
    startedAt,
    endedAt: new Date().toISOString(),
  });

  if (!dockerAvailableSync(dockerBin)) {
    return Promise.resolve(
      done({ outcome: 'blocked', exitCode: null, timedOut: false, blockedReason: 'docker-unavailable', outputHash: sha256Hex(''), logTail: 'docker unavailable' }),
    );
  }
  const snap = validateSnapshot(input.snapshotRef);
  if (!snap.ok || snap.dir === undefined) {
    return Promise.resolve(
      done({ outcome: 'blocked', exitCode: null, timedOut: false, blockedReason: snap.reason ?? 'snapshot-missing', outputHash: sha256Hex(''), logTail: 'snapshot missing' }),
    );
  }
  const name = containerName(input.namePrefix ?? 'together-run', input.jobId ?? sha256Hex(`${Date.now()}`).slice(0, 12));

  return new Promise((resolvePromise) => {
    const child = spawn(dockerBin, runArgs(name, snap.dir as string, image, input.command, input.environment), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let captured = 0;
    let truncated = false;
    const onData = (buf: Buffer) => {
      if (captured >= maxOutput) {
        truncated = true;
        return;
      }
      const take = Math.min(buf.length, maxOutput - captured);
      chunks.push(buf.subarray(0, take));
      captured += take;
      if (take < buf.length) truncated = true;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        spawnSync(dockerBin, ['rm', '-f', name], { stdio: 'ignore', timeout: 15_000 });
      } catch {
        // Best-effort kill; the close event resolves the result.
      }
    }, input.timeoutMs + HARD_TIMEOUT_MARGIN_MS);

    child.once('error', (err) => {
      clearTimeout(timer);
      const text = `spawn error: ${String(err)}`;
      resolvePromise(
        done({ outcome: 'error', exitCode: null, timedOut, outputHash: sha256Hex(text), logTail: text }),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      const logTail = `${truncated ? '[truncated]\n' : ''}${output.slice(-4096)}`;
      resolvePromise(
        done({
          outcome: timedOut ? 'error' : code === 0 ? 'pass' : 'fail',
          exitCode: timedOut ? null : code,
          timedOut,
          inputHash: snapshotInputHash(snap.dir as string),
          outputHash: sha256Hex(Buffer.concat(chunks)),
          logTail,
        }),
      );
    });
  });
}
