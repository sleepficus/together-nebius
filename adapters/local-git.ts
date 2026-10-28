// Local Git implementation of the shared GitService (seat b-swe-04).
// The bounded service running on the operator's host (or a disposable
// fixture); the cloud Worker never executes Node Git.
//   - execFile argv only; nothing is interpolated into a shell;
//   - SHAs/refs/ids validate before any subprocess runs;
//   - prepare() merges exact named heads in a temporary worktree — a real
//     merge, not merge-tree;
//   - push() checks ancestor(expectedTip, candidateTip) then enforces the
//     expected tip atomically (update-ref CAS);
//   - read-back never alone attributes a landing.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail } from '../lib/core.ts';
import type { GitService, Id, Sha } from '../lib/types.ts';

/** 40-hex (SHA-1) or 64-hex (SHA-256) commit ids only. */
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** refs/... names with a conservative character set. */
const REF_RE = /^refs\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
/** Proposal ids become ref/path components; keep them filename-safe. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const GIT_IDENTITY = [
  '-c', 'user.name=together-local-git',
  '-c', 'user.email=together-local-git@invalid',
];

export function isCommitSha(value: unknown): value is Sha {
  return typeof value === 'string' && SHA_RE.test(value);
}

export function assertCommitSha(value: unknown, field: string): asserts value is Sha {
  if (!isCommitSha(value)) {
    fail(422, 'invalid_sha', `"${field}" must be a 40- or 64-hex commit SHA`);
  }
}

export function assertRefName(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !REF_RE.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('.lock') ||
    value.startsWith('-')
  ) {
    fail(422, 'invalid_ref', `"${field}" is not a safe refs/ name`);
  }
}

export function assertObjectId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail(422, 'invalid_id', `"${field}" is not a safe identifier`);
  }
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  /** Extra environment for the git process; merged over process.env. Used
   *  to carry transport credentials via GIT_ASKPASS/GIT_CONFIG_* instead of
   *  argv — secrets never appear in the argument list. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock kill timeout for the subprocess. */
  timeoutMs?: number;
}

/**
 * Run git with an argv array — no shell, so inputs cannot escape into
 * command syntax. Exit codes are reported, not thrown.
 */
export function runGit(
  repo: string,
  args: string[],
  gitBin = 'git',
  opts?: GitRunOptions,
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      gitBin,
      ['-C', repo, ...args],
      {
        maxBuffer: 8 * 1024 * 1024,
        ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts?.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          // Spawn failure (ENOENT/EACCES/maxBuffer/timeout kill) — callers
          // map to 503; err.killed/err.signal distinguish a timeout.
          reject(err);
          return;
        }
        resolve({
          code: typeof err?.code === 'number' ? err.code : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function gitFailed(repo: string, args: string[], res: GitRunResult): never {
  const detail = res.stderr.trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
  fail(503, 'git_failed', `git ${args[0]} failed: ${detail || 'unknown error'}`, {
    nextAction: 'check the bounded Git service repository',
  });
}

async function must(repo: string, args: string[], gitBin = 'git'): Promise<string> {
  const res = await runGit(repo, args, gitBin);
  if (res.code !== 0) gitFailed(repo, args, res);
  return res.stdout.trim();
}

export interface LocalGitOptions {
  /** Path to the repository holding canonical refs and proposal objects. */
  repo: string;
  /** Scratch root for disposable merge worktrees (default: fresh tmpdir). */
  workRoot?: string;
  /** git binary name/path (default 'git'). */
  gitBin?: string;
}

export class LocalGitService implements GitService {
  private repo: string;
  private workRoot: string;
  private ownRoot: boolean;
  private gitBin: string;
  private serial = 0;
  private worktrees = new Set<string>();
  private disposed = false;

  constructor(opts: LocalGitOptions) {
    this.repo = opts.repo;
    this.gitBin = opts.gitBin ?? 'git';
    this.workRoot = opts.workRoot ?? mkdtempSync(join(tmpdir(), 'together-git-'));
    this.ownRoot = opts.workRoot === undefined;
  }

  /**
   * Merge exact proposal heads onto `base` in a disposable worktree, return
   * the resulting SHA. Conflict -> merge aborted, `conflicts` set, sha ''
   * (never fabricated). The merge commit stays in the shared object
   * database after the worktree is removed.
   */
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
    this.assertLive();
    assertCommitSha(input.base, 'base');
    if (!Array.isArray(input.proposals) || input.proposals.length === 0) {
      fail(422, 'missing_field', 'prepare requires at least one proposal head');
    }
    for (const p of input.proposals) {
      assertObjectId(p.id, 'proposal id');
      assertCommitSha(p.head, `proposal ${p.id} head`);
    }
    const proposalHeads: Record<Id, Sha> = {};
    for (const p of input.proposals) proposalHeads[p.id] = p.head;

    // Every named head must be an existing commit — never resolve arbitrary
    // ref syntax on behalf of a caller.
    for (const sha of [input.base, ...input.proposals.map((p) => p.head)]) {
      const res = await runGit(this.repo, ['cat-file', '-e', `${sha}^{commit}`], this.gitBin);
      if (res.code !== 0) {
        fail(422, 'unknown_commit', `commit ${sha} is not present in the repository`);
      }
    }

    const dir = join(this.workRoot, `prep-${this.serial++}-${Date.now()}`);
    {
      const add = await runGit(this.repo, ['worktree', 'add', '--detach', dir, input.base], this.gitBin);
      if (add.code !== 0) gitFailed(this.repo, ['worktree', 'add'], add);
    }
    this.worktrees.add(dir);
    try {
      const conflicts: { path: string; proposalIds: Id[] }[] = [];
      for (const p of input.proposals) {
        const merge = await runGit(
          dir,
          [...GIT_IDENTITY, 'merge', '--no-ff', '--no-edit', p.head],
          this.gitBin,
        );
        if (merge.code !== 0) {
          const unmerged = (await runGit(dir, ['diff', '--name-only', '--diff-filter=U'], this.gitBin))
            .stdout.split('\n')
            .filter(Boolean);
          await runGit(dir, ['merge', '--abort'], this.gitBin);
          for (const path of unmerged) conflicts.push({ path, proposalIds: [p.id] });
          return {
            sha: '',
            base: input.base,
            proposalHeads,
            changedPaths: [],
            conflicts,
          };
        }
      }
      const sha = await must(dir, ['rev-parse', 'HEAD'], this.gitBin);
      const changedPaths = (await runGit(dir, ['diff', '--name-only', input.base, sha], this.gitBin))
        .stdout.split('\n')
        .filter(Boolean);
      const diff=await runGit(dir,['diff','--no-ext-diff','--no-textconv','--unified=3',input.base,sha,'--'],this.gitBin).catch(()=>null);
      return { sha, base: input.base, proposalHeads, changedPaths,...(diff?.code===0?{diffPreview:{base:input.base,head:sha,text:diff.stdout.slice(0,6000),truncated:diff.stdout.length>6000}}:{}) };
    } finally {
      await this.removeWorktree(dir);
    }
  }

  async readTip(ref: string): Promise<Sha> {
    this.assertLive();
    assertRefName(ref, 'ref');
    const res = await runGit(this.repo, ['rev-parse', '--verify', `${ref}^{commit}`], this.gitBin);
    if (res.code !== 0) {
      fail(404, 'ref_not_found', `ref ${ref} does not resolve to a commit`, {
        nextAction: 'verify the canonical ref exists before reading its tip',
      });
    }
    return res.stdout.trim();
  }

  async isAncestor(oldTip: Sha, newTip: Sha): Promise<boolean> {
    this.assertLive();
    assertCommitSha(oldTip, 'oldTip');
    assertCommitSha(newTip, 'newTip');
    const res = await runGit(this.repo, ['merge-base', '--is-ancestor', oldTip, newTip], this.gitBin);
    if (res.code === 0) return true;
    if (res.code === 1) return false;
    gitFailed(this.repo, ['merge-base', '--is-ancestor'], res);
  }

  /**
   * Expected-tip enforced update: ancestor(expectedTip, candidateTip) first
   * (a lease alone could move the ref sideways), then atomic CAS via
   * `update-ref <ref> <candidateTip> <expectedTip>`. The caller still
   * reconciles by read-back — this return never alone attributes a landing.
   */
  async push(input: {
    ref: string;
    expectedTip: Sha;
    candidateTip: Sha;
    operationId: Id;
  }): Promise<{ ended: boolean; effect: 'updated' | 'no-effect' | 'unknown'; reportStatus?: string }> {
    this.assertLive();
    assertRefName(input.ref, 'ref');
    assertCommitSha(input.expectedTip, 'expectedTip');
    assertCommitSha(input.candidateTip, 'candidateTip');

    if (!(await this.isAncestor(input.expectedTip, input.candidateTip))) {
      return { ended: true, effect: 'no-effect', reportStatus: 'expected-tip-not-ancestor' };
    }

    let current: Sha;
    try {
      current = await this.readTip(input.ref);
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return { ended: true, effect: 'no-effect', reportStatus: 'ref-missing' };
      }
      throw err;
    }
    if (current === input.candidateTip) {
      return { ended: true, effect: 'no-effect', reportStatus: 'already-at-candidate-tip' };
    }

    const res = await runGit(
      this.repo,
      ['update-ref', input.ref, input.candidateTip, input.expectedTip],
      this.gitBin,
    );
    if (res.code === 0) {
      return { ended: true, effect: 'updated', reportStatus: 'expected-tip-lease-held' };
    }
    // CAS failed — read back and report the observed state honestly.
    let after: Sha | null = null;
    try {
      after = await this.readTip(input.ref);
    } catch {
      after = null;
    }
    if (after === input.candidateTip) {
      // Somebody else moved the ref to the same value; this push had no effect.
      return { ended: true, effect: 'no-effect', reportStatus: 'already-at-candidate-tip' };
    }
    return {
      ended: true,
      effect: 'no-effect',
      reportStatus:
        // The ref still holds the expected tip: the update failed for a
        // non-CAS reason (e.g. a transient lock). Never claim an
        // expected-tip mismatch — the lease holds and a same-expectedTip
        // retry can still land. A different observed tip is the real
        // stale-lease case and keeps the observed value in the status.
        after === input.expectedTip
          ? 'update-failed-tip-unchanged'
          : `tip-moved:${after ?? 'unreadable'}`,
    };
  }

  // Remove every merge worktree and the scratch root this service made.
  async dispose(): Promise<void> {
    for (const dir of [...this.worktrees]) {
      await this.removeWorktree(dir);
    }
    await runGit(this.repo, ['worktree', 'prune'], this.gitBin).catch(() => undefined);
    if (this.ownRoot) {
      rmSync(this.workRoot, { recursive: true, force: true });
    }
    this.disposed = true;
  }

  private async removeWorktree(dir: string): Promise<void> {
    if (!this.worktrees.has(dir)) return;
    this.worktrees.delete(dir);
    const res = await runGit(this.repo, ['worktree', 'remove', '--force', dir], this.gitBin);
    if (res.code !== 0) {
      // Fallback so a failed remove never leaks scratch state.
      rmSync(dir, { recursive: true, force: true });
      await runGit(this.repo, ['worktree', 'prune'], this.gitBin).catch(() => undefined);
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      fail(503, 'git_unavailable', 'local Git service is disposed');
    }
  }
}

export function createLocalGitService(opts: LocalGitOptions): LocalGitService {
  return new LocalGitService(opts);
}
