/** Controller-owned snapshot of an exact commit; no caller-selected host mount. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCommitSha } from '../adapters/local-git.ts';
export function materializeGitSnapshot(repo: string, sha: string, maxBytes = 32 * 1024 * 1024) {
  assertCommitSha(sha, 'candidateSha');
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', sha], {
    encoding: 'buffer', maxBuffer: maxBytes, timeout: 30000,
  });
  if (archive.status !== 0 || archive.error) throw new Error('exact candidate commit unavailable or snapshot too large');
  const dir = mkdtempSync(join(tmpdir(), 'together-snapshot-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const unpack = spawnSync('tar', ['-xf', '-', '-C', dir], { input: archive.stdout, timeout: 30000, maxBuffer: 1024 * 1024 });
    if (unpack.status !== 0 || unpack.error) throw new Error('candidate snapshot extraction failed');
    chmodSync(dir, 0o755);
    return { dir, sha, cleanup };
  } catch (e) { cleanup(); throw e; }
}

/**
 * Ensure an exact commit is present in the companion's OWNED bare mirror.
 * Creates the bare mirror on first use (mode 0700). When the commit is
 * missing and a remote is configured, performs bounded fetches: first all
 * advertised refs into refs/mirror/*, then the exact SHA as a last resort
 * (servers that allow direct sha fetch). A short-lived read capability is
 * supplied through GIT_CONFIG_* env for that process only -- never argv,
 * never persisted into the mirror config. Answers truthfully; it never
 * fabricates presence.
 */
export function ensureMirrorCommit(input: {
  mirrorDir: string;
  sha: string;
  remote?: string;
  /** Short-lived repository read credential (plaintext); env-only use. */
  token?: string;
  gitBin?: string;
  timeoutMs?: number;
}): { present: boolean; fetched: boolean } {
  assertCommitSha(input.sha, 'candidateSha');
  const dir = input.mirrorDir;
  const gitBin = input.gitBin ?? 'git';
  const timeout = input.timeoutMs ?? 120_000;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...(input.token !== undefined
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${input.remote}.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${input.token}`,
        }
      : {}),
  };
  const policy = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'fetch.fsckObjects=true', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never', '-c', 'protocol.git.allow=never'];
  const remoteKind = input.remote === undefined ? null : new URL(input.remote).protocol;
  if (remoteKind !== null && remoteKind !== 'https:' && !(input.token === undefined && remoteKind === 'file:')) {
    throw new Error('unsupported snapshot remote protocol');
  }
  policy.push('-c', `protocol.file.allow=${remoteKind === 'file:' && input.token === undefined ? 'user' : 'never'}`);
  const has = (): boolean => {
    try {
      const res = spawnSync(gitBin, [...policy, '-C', dir, 'cat-file', '-e', `${input.sha}^{commit}`], {
        stdio: 'ignore',
        timeout: 10_000,
        env,
      });
      return res.status === 0;
    } catch {
      return false;
    }
  };

  if (!existsSync(join(dir, 'HEAD'))) {
    if (input.remote === undefined) return { present: false, fetched: false };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const init = spawnSync(gitBin, [...policy, 'init', '--bare', '--template=', dir], { stdio: 'ignore', timeout: 15_000, env });
      if (init.status !== 0) return { present: false, fetched: false };
    } catch {
      return { present: false, fetched: false };
    }
  }
  if (has()) return { present: true, fetched: false };
  if (input.remote === undefined) return { present: false, fetched: false };

  const attempts = [
    ['fetch', '--no-tags', input.remote, '+refs/*:refs/mirror/*'],
    ['fetch', '--no-tags', '--depth=1', input.remote, input.sha],
  ];
  for (const args of attempts) {
    try {
      spawnSync(gitBin, [...policy, '-C', dir, ...args], { stdio: 'ignore', timeout, env });
    } catch {
      // A failed fetch attempt is reported by the final presence check.
    }
    if (has()) return { present: true, fetched: true };
  }
  return { present: false, fetched: false };
}
