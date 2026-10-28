// Companion-side Git bridge executor for the Together cloud slice
// (seat c-swe-06).
//
// Runs on the operator's existing private host, reached only through the
// outbound companion bridge — no inbound endpoint. Every job executes REAL
// git against an owned per-project bare mirror under options.root:
//   - the canonical Artifacts remote and each proposal author's actually
//     issued fork are fetched with the bounded, short-lived transport
//     capabilities carried in the job payload's private `transport`
//     section (vetted by cloud/git-service.ts). Token plaintext travels to
//     git exclusively via a scoped process-only Bearer header — never argv, never
//     stored config, never journal, never results or errors;
//   - hooks, system/global config, unsafe protocols, LFS, submodules,
//     filters and credential helpers are disabled on every invocation;
//   - git.prepare combines ordered exact heads as real merge commits in a
//     disposable worktree (no candidate code runs), then pins the result
//     on disposable refs/candidates/<operationId> in the mirror AND the
//     canonical remote, so the exact SHA stays reachable for checks even
//     if the mirror is rebuilt;
//   - git.push lands only the configured disposable canonical ref behind
//     an atomic --force-with-lease expected-tip guard. The local
//     operation/effect journal is written BEFORE the push. The result is
//     classified by remote read-back; an ambiguous outcome is effect
//     'unknown' — this module never repushes.

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ApiError, fail } from '../lib/core.ts';
import {
  assertCommitSha, assertObjectId, assertRefName, isCommitSha, runGit,
} from '../adapters/local-git.ts';
import type { GitRunResult } from '../adapters/local-git.ts';
import type { BridgeOptions, ExecutionJob } from '../cloud/phase04-contract.ts';
import type { Sha } from '../lib/types.ts';

/** Disposable ref namespace pinning merged candidates on the mirror and
 *  the canonical remote. Outside refs/heads/* by design so candidate refs
 *  can never collide with or overwrite a real branch. */
export const CANDIDATE_REF_PREFIX = 'refs/candidates/';

const MAX_PROPOSALS = 64;
const MAX_CHANGED_PATHS = 8192;
const MAX_HEADS_PER_REMOTE = 512;
const MAX_REMOTE_CHARS = 2048;
const MAX_CAP_CHARS = 4096;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
const OP_TIMEOUT_MS = 60_000;
const JOURNAL_DIR_MODE = 0o700;
const JOURNAL_FILE_MODE = 0o600;

/**
 * Executor-side options. BridgeOptions itself is contract-owned; the one
 * extension is an explicit test-only escape hatch for file remotes.
 */
export interface GitExecutorOptions extends BridgeOptions {
  /**
   * TEST-ONLY: permit file-path/file:// remotes confined to options.root
   * so offline fixtures exercise real git without a network. The real
   * companion wiring must never set this — production remotes are
   * https:// only.
   */
  allowFileTransport?: boolean;
}

interface TransportCap {
  repositoryId: string;
  remote: string;
  plaintext?: string;
  expiresAt?: string;
}

interface ResolvedRemote {
  remote: string;
  kind: 'https' | 'file';
  env: NodeJS.ProcessEnv;
}

interface ValidatedProposal {
  id: string;
  head: Sha;
  base?: Sha;
  authorId?: string;
  repositoryId?: string;
}

// ---------------------------------------------------------------------------
// owned scratch layout
// ---------------------------------------------------------------------------

function layout(root: string) {
  return {
    emptyGitconfig: join(root, 'empty-gitconfig'),
    emptyHooks: join(root, 'empty-hooks'),
    askpass: join(root, 'bin', 'together-git-askpass.sh'),
    journalDir: join(root, 'journal'),
    workRoot: join(root, 'worktrees'),
    mirrors: join(root, 'git-mirror'),
  };
}

const ASKPASS_SCRIPT = `#!/bin/sh
# GIT_ASKPASS helper: the token arrives via environment only — never argv,
# never a credential helper, never stored config.
case "$1" in
  *sername*|*ser*) printf '%s' "\${GIT_ASKPASS_USER:-x-access-token}" ;;
  *) printf '%s' "\${GIT_ASKPASS_TOKEN:-}" ;;
esac
`;

function ensureRootLayout(root: string): void {
  const p = layout(root);
  mkdirSync(p.journalDir, { recursive: true, mode: JOURNAL_DIR_MODE });
  mkdirSync(p.workRoot, { recursive: true, mode: JOURNAL_DIR_MODE });
  mkdirSync(p.mirrors, { recursive: true, mode: JOURNAL_DIR_MODE });
  mkdirSync(p.emptyHooks, { recursive: true, mode: JOURNAL_DIR_MODE });
  mkdirSync(join(root, 'bin'), { recursive: true, mode: JOURNAL_DIR_MODE });
  if (!existsSync(p.emptyGitconfig)) {
    writeFileSync(p.emptyGitconfig, '', { mode: JOURNAL_FILE_MODE });
  }
  if (!existsSync(p.askpass) || readFileSyncSafe(p.askpass) !== ASKPASS_SCRIPT) {
    writeFileSync(p.askpass, ASKPASS_SCRIPT, { mode: 0o700 });
    chmodSync(p.askpass, 0o700);
  }
}

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// hardened git invocation
// ---------------------------------------------------------------------------

function hardenedArgv(root: string, allowFile: boolean): string[] {
  const p = layout(root);
  return [
    // No hooks: candidate-controlled content must never trigger code.
    '-c', `core.hooksPath=${p.emptyHooks}`,
    // No credential helpers — auth comes from a scoped process-only header.
    '-c', 'credential.helper=',
    // No LFS / attribute filters / submodule recursion.
    '-c', 'filter.lfs.required=false',
    '-c', 'filter.lfs.clean=',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.process=',
    '-c', 'submodule.recurse=false',
    // Integrity-check objects arriving from the wire.
    '-c', 'fetch.fsckObjects=true',
    // Protocol policy: https only in production; file transport is a
    // test-only escape hatch confined to the companion root.
    '-c', `protocol.file.allow=${allowFile ? 'user' : 'never'}`,
    '-c', 'protocol.git.allow=never',
    '-c', 'protocol.ssh.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'http.sslVerify=true',
  ];
}

function baseEnv(root: string): NodeJS.ProcessEnv {
  const p = layout(root);
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: p.emptyGitconfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'together-git-bridge',
    GIT_AUTHOR_EMAIL: 'together-git-bridge@invalid',
    GIT_COMMITTER_NAME: 'together-git-bridge',
    GIT_COMMITTER_EMAIL: 'together-git-bridge@invalid',
  };
}

function envWithCap(root: string, cap: TransportCap | undefined, kind: 'https' | 'file'): NodeJS.ProcessEnv {
  const env = baseEnv(root);
  if (kind === 'https' && cap?.plaintext !== undefined) {
    // Artifacts Bearer auth uses the complete expiring token, unlike Basic
    // password auth. These variables apply only to this trusted subprocess.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${cap.remote}.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${cap.plaintext}`;
  }
  return env;
}

async function execGit(
  root: string,
  allowFile: boolean,
  repo: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<GitRunResult> {
  try {
    return await runGit(repo, [...hardenedArgv(root, allowFile), ...args], 'git', {
      env: opts.env,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; message?: string };
    if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
      fail(503, 'git_timeout', `git ${String(args[0])} exceeded its time bound`, {
        nextAction: 'retry once the companion host is less loaded',
      });
    }
    fail(503, 'git_unavailable', `git ${String(args[0])} could not run`, {
      nextAction: 'check the companion git installation',
    });
  }
}

async function mustGit(
  root: string,
  allowFile: boolean,
  repo: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const res = await execGit(root, allowFile, repo, args, opts);
  if (res.code !== 0) {
    const detail = res.stderr.trim().split('\n').slice(0, 3).join(' ').slice(0, 200);
    fail(503, 'git_failed', `git ${String(args[0])} failed: ${detail || 'unknown error'}`);
  }
  return res.stdout.trim();
}

// ---------------------------------------------------------------------------
// payload validation
// ---------------------------------------------------------------------------

function str(v: unknown, field: string, max = 2048): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || /[\x00-\x20]/.test(v)) {
    fail(422, 'invalid_payload', `"${field}" must be a non-empty string of <= ${max} chars without whitespace/control`);
  }
  return v;
}

function optSha(v: unknown, field: string): Sha | undefined {
  if (v === undefined || v === null) return undefined;
  assertCommitSha(v, field);
  return v;
}

function checkRemote(
  remote: unknown,
  allowFile: boolean,
  root: string,
): { remote: string; kind: 'https' | 'file' } {
  if (typeof remote !== 'string' || remote.length === 0 || remote.length > MAX_REMOTE_CHARS) {
    fail(422, 'invalid_remote', 'remote must be a non-empty bounded string');
  }
  if (/[\x00-\x1f\x7f]/.test(remote) || remote.startsWith('-')) {
    fail(422, 'invalid_remote', 'remote must not contain control characters or look like a flag');
  }
  if (remote.startsWith('https://')) {
    let u: URL;
    try {
      u = new URL(remote);
    } catch {
      fail(422, 'invalid_remote', 'remote is not a valid https URL');
    }
    if (u.username !== '' || u.password !== '') {
      fail(422, 'invalid_remote', 'credentials must not be embedded in the remote URL');
    }
    return { remote, kind: 'https' };
  }
  // Non-https URL schemes and scp-style ssh remotes are never allowed —
  // only a bare absolute path (or file://) may proceed, and only under the
  // test-only allowFileTransport escape hatch.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(remote) && !remote.startsWith('file://')) {
    fail(422, 'remote_not_allowed', 'only https:// remotes are permitted');
  }
  if (/^[^\s/@:]+@[^\s]+:/.test(remote)) {
    fail(422, 'remote_not_allowed', 'scp-style ssh remotes are not permitted');
  }
  if (!allowFile) {
    fail(422, 'remote_not_allowed', 'only https:// remotes are permitted');
  }
  const raw = remote.startsWith('file://') ? new URL(remote).pathname : remote;
  if (!raw.startsWith('/')) {
    fail(422, 'invalid_remote', 'file remotes must be absolute paths');
  }
  const abs = resolve(raw);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    fail(422, 'remote_not_allowed', 'file remotes must live inside the companion root');
  }
  return { remote: abs, kind: 'file' };
}

function checkCap(raw: unknown, field: string): TransportCap {
  if (typeof raw !== 'object' || raw === null) {
    fail(422, 'invalid_payload', `transport "${field}" must be an object`);
  }
  const cap = raw as Record<string, unknown>;
  const repositoryId = str(cap.repositoryId, `${field}.repositoryId`, 256);
  const remote = str(cap.remote, `${field}.remote`, MAX_REMOTE_CHARS);
  let plaintext: string | undefined;
  if (cap.plaintext !== undefined) {
    if (typeof cap.plaintext !== 'string' || cap.plaintext.length === 0 || cap.plaintext.length > MAX_CAP_CHARS) {
      fail(422, 'invalid_payload', `${field}.plaintext must be a bounded string`);
    }
    plaintext = cap.plaintext;
  }
  const expiresAt = typeof cap.expiresAt === 'string' ? cap.expiresAt : undefined;
  if (expiresAt !== undefined && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now()) {
    fail(503, 'dependency_unavailable', 'transport capability is already expired', {
      nextAction: 'issue a fresh short-lived capability and retry',
    });
  }
  return { repositoryId, remote, plaintext, expiresAt };
}

/** Resolve the repoId to its vetted remote + transport environment. */
function resolveRemote(
  payload: Record<string, unknown>,
  repositoryId: string,
  root: string,
  allowFile: boolean,
): ResolvedRemote {
  const transport = payload.transport;
  if (typeof transport !== 'object' || transport === null) {
    fail(422, 'missing_transport', 'payload has no private transport section');
  }
  const t = transport as Record<string, unknown>;
  const canonical = checkCap(t.canonical, 'canonical');
  const canonicalRepositoryId = str(payload.repositoryId, 'repositoryId', 256);
  if (canonical.repositoryId !== canonicalRepositoryId) {
    fail(422, 'project_mismatch', 'transport canonical capability does not match the payload repository');
  }
  let cap: TransportCap;
  if (repositoryId === canonicalRepositoryId) {
    cap = canonical;
  } else {
    const forks = typeof t.forks === 'object' && t.forks !== null ? (t.forks as Record<string, unknown>) : {};
    cap = checkCap(forks[repositoryId], `forks.${repositoryId}`);
    if (cap.repositoryId !== repositoryId) {
      fail(422, 'project_mismatch', `fork capability ${repositoryId} does not name itself`);
    }
  }
  const checked = checkRemote(cap.remote, allowFile, root);
  return { remote: checked.remote, kind: checked.kind, env: envWithCap(root, cap, checked.kind) };
}

function validateProposals(raw: unknown): ValidatedProposal[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PROPOSALS) {
    fail(422, 'invalid_payload', `proposals must name 1..${MAX_PROPOSALS} entries`);
  }
  const out: ValidatedProposal[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      fail(422, 'invalid_payload', 'proposal entries must be objects');
    }
    const p = item as Record<string, unknown>;
    const id = str(p.id, 'proposal id', 256);
    assertObjectId(id, 'proposal id');
    const head = optSha(p.head, `proposal ${id} head`) as Sha;
    const base = optSha(p.base, `proposal ${id} base`);
    const repositoryId =
      p.repositoryId === undefined ? undefined : str(p.repositoryId, `proposal ${id} repositoryId`, 256);
    const authorId =
      p.authorId === undefined ? undefined : str(p.authorId, `proposal ${id} authorId`, 256);
    out.push({ id, head, base, authorId, repositoryId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// mirror + journal
// ---------------------------------------------------------------------------

async function ensureMirror(root: string, allowFile: boolean, projectId: string): Promise<string> {
  assertObjectId(projectId, 'projectId');
  const dir = join(layout(root).mirrors, projectId);
  const abs = resolve(dir);
  if (!abs.startsWith(resolve(root) + sep)) {
    fail(422, 'invalid_id', 'projectId escapes the mirror root');
  }
  if (existsSync(join(dir, 'HEAD'))) return dir;
  mkdirSync(dir, { recursive: true });
  await mustGit(root, allowFile, root, ['init', '--bare', '--template=', dir], {
    env: baseEnv(root),
    timeoutMs: OP_TIMEOUT_MS,
  });
  return dir;
}

async function objectExists(root: string, allowFile: boolean, mirror: string, sha: Sha): Promise<boolean> {
  const res = await execGit(root, allowFile, mirror, ['cat-file', '-e', `${sha}^{commit}`], {
    env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
  });
  return res.code === 0;
}

async function fetchRefs(
  root: string,
  allowFile: boolean,
  mirror: string,
  src: ResolvedRemote,
  refspecs: string[],
): Promise<void> {
  const res = await execGit(
    root, allowFile, mirror,
    ['fetch', '--no-tags', src.remote, ...refspecs],
    { env: src.env, timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (res.code !== 0) {
    const detail = res.stderr.trim().split('\n').slice(0, 2).join(' ').slice(0, 200);
    fail(503, 'fetch_failed', `fetch from the bound remote failed: ${detail || 'transport error'}`, {
      nextAction: 'retry once the artifacts remote is reachable',
    });
  }
}

/** Bound a remote's advertised branch count before sweeping it. */
async function countRemoteHeads(
  root: string,
  allowFile: boolean,
  mirror: string,
  src: ResolvedRemote,
): Promise<number> {
  const res = await execGit(root, allowFile, mirror, ['ls-remote', src.remote, 'refs/heads/*'], {
    env: src.env, timeoutMs: OP_TIMEOUT_MS,
  });
  if (res.code !== 0) return 0;
  return res.stdout.split('\n').filter((l) => l.trim() !== '').length;
}

async function fetchRemoteSweep(
  root: string,
  allowFile: boolean,
  mirror: string,
  src: ResolvedRemote,
  index: number,
  extraRefs: string[] = [],
): Promise<void> {
  if ((await countRemoteHeads(root, allowFile, mirror, src)) > MAX_HEADS_PER_REMOTE) {
    fail(422, 'too_many_refs', `remote advertises more than ${MAX_HEADS_PER_REMOTE} heads`);
  }
  await fetchRefs(root, allowFile, mirror, src, [
    `+refs/heads/*:refs/mirror/r${index}/heads/*`,
    `+${CANDIDATE_REF_PREFIX}*:refs/mirror/r${index}/candidates/*`,
    ...extraRefs.map((r, i) => `+${r}:refs/mirror/r${index}/x${i}`),
  ]);
}

/** Guarantee `sha` names a commit in the mirror, fetching as needed. */
async function ensureCommit(
  root: string,
  allowFile: boolean,
  mirror: string,
  sha: Sha,
  sources: ResolvedRemote[],
): Promise<void> {
  if (await objectExists(root, allowFile, mirror, sha)) return;
  // Fallback for servers that allow direct SHA fetch; harmless otherwise.
  for (const src of sources) {
    const res = await execGit(
      root, allowFile, mirror, ['fetch', '--no-tags', src.remote, sha],
      { env: src.env, timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (res.code === 0 && (await objectExists(root, allowFile, mirror, sha))) return;
  }
  fail(422, 'unknown_commit', `commit ${sha} is not reachable on the bound remotes`);
}

/**
 * ls-remote exact-ref parse: returns the remote tip, or null ONLY when the
 * remote answered and the ref is absent (--exit-code 2). A transport
 * failure throws dependency_unavailable — a dead remote is never
 * misreported as a missing ref.
 */
async function remoteTip(
  root: string,
  allowFile: boolean,
  mirror: string,
  src: ResolvedRemote,
  ref: string,
): Promise<Sha | null> {
  const res = await execGit(root, allowFile, mirror,
    ['ls-remote', '--exit-code', src.remote, ref],
    { env: src.env, timeoutMs: OP_TIMEOUT_MS });
  if (res.code === 2) return null;
  if (res.code !== 0) {
    const detail = res.stderr.trim().split('\n').slice(0, 2).join(' ').slice(0, 200);
    fail(503, 'dependency_unavailable', `remote readback failed: ${detail || 'transport error'}`, {
      nextAction: 'retry once the artifacts remote is reachable',
    });
  }
  for (const line of res.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const sha = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (name === ref && isCommitSha(sha)) return sha;
  }
  return null;
}

// ---------------------------------------------------------------------------
// journal — local operation/effect record, persisted BEFORE the push
// ---------------------------------------------------------------------------

function journalPath(root: string, projectId: string): string {
  return join(layout(root).journalDir, `${projectId}.ndjson`);
}

function journal(root: string, projectId: string, entry: Record<string, unknown>, strict: boolean): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(), projectId, ...entry,
  }) + '\n';
  try {
    const p = journalPath(root, projectId);
    if (!existsSync(p)) writeFileSync(p, '', { mode: JOURNAL_FILE_MODE });
    appendFileSync(p, line);
  } catch (err) {
    if (strict) {
      // Never push without the durable local record of intent.
      fail(503, 'journal_unavailable', 'local effect journal could not be written');
    }
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function doReadTip(
  root: string, allowFile: boolean, mirror: string, payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ref = str(payload.ref, 'ref');
  assertRefName(ref, 'ref');
  const canonicalRef = str(payload.canonicalRef, 'canonicalRef');
  if (ref !== canonicalRef) {
    fail(422, 'ref_not_canonical', 'reads are confined to the configured canonical ref');
  }
  const src = resolveRemote(payload, str(payload.repositoryId, 'repositoryId', 256), root, allowFile);
  const tip = await remoteTip(root, allowFile, mirror, src, ref);
  if (tip === null) {
    fail(404, 'ref_not_found', `ref ${ref} does not resolve on the remote`);
  }
  return { tip };
}

async function doIsAncestor(
  root: string, allowFile: boolean, mirror: string, payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const oldTip = optSha(payload.oldTip, 'oldTip') as Sha;
  const newTip = optSha(payload.newTip, 'newTip') as Sha;
  const canonicalRepositoryId = str(payload.repositoryId, 'repositoryId', 256);
  const canonical = resolveRemote(payload, canonicalRepositoryId, root, allowFile);
  await fetchRemoteSweep(root, allowFile, mirror, canonical, 0, [payload.canonicalRef as string]);
  const transport = payload.transport as Record<string, unknown>;
  const forkMap = typeof transport.forks === 'object' && transport.forks !== null
    ? (transport.forks as Record<string, unknown>) : {};
  const sources: ResolvedRemote[] = [canonical];
  let index = 1;
  for (const repoId of Object.keys(forkMap)) {
    const src = resolveRemote(payload, repoId, root, allowFile);
    await fetchRemoteSweep(root, allowFile, mirror, src, index++);
    sources.push(src);
  }
  await ensureCommit(root, allowFile, mirror, oldTip, sources);
  await ensureCommit(root, allowFile, mirror, newTip, sources);
  const res = await execGit(root, allowFile, mirror, ['merge-base', '--is-ancestor', oldTip, newTip], {
    env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
  });
  if (res.code === 0) return { isAncestor: true };
  if (res.code === 1) return { isAncestor: false };
  fail(503, 'git_failed', 'merge-base --is-ancestor failed');
}

async function doPrepare(
  root: string, allowFile: boolean, mirror: string,
  payload: Record<string, unknown>, job: ExecutionJob,
): Promise<Record<string, unknown>> {
  const canonicalRepositoryId = str(payload.repositoryId, 'repositoryId', 256);
  const canonicalRef = str(payload.canonicalRef, 'canonicalRef');
  assertRefName(canonicalRef, 'canonicalRef');
  const operationId = str(payload.operationId, 'operationId', 160);
  assertObjectId(operationId, 'operationId');
  const base = optSha(payload.base, 'base') as Sha;
  const proposals = validateProposals(payload.proposals);
  const candidateRef = `${CANDIDATE_REF_PREFIX}${operationId}`;
  assertRefName(candidateRef, 'candidateRef');

  const canonical = resolveRemote(payload, canonicalRepositoryId, root, allowFile);
  await fetchRemoteSweep(root, allowFile, mirror, canonical, 0, [canonicalRef]);

  // Fetch each distinct proposal source exactly once (canonical needs no
  // second fetch).
  const forkSources = new Map<string, ResolvedRemote>();
  let forkIndex = 1;
  for (const p of proposals) {
    const repoId = p.repositoryId ?? canonicalRepositoryId;
    if (repoId === canonicalRepositoryId || forkSources.has(repoId)) continue;
    const src = resolveRemote(payload, repoId, root, allowFile);
    await fetchRemoteSweep(root, allowFile, mirror, src, forkIndex++);
    forkSources.set(repoId, src);
  }

  // Validate exact SHAs and the recorded descendant base before any merge.
  const sources = [canonical, ...forkSources.values()];
  await ensureCommit(root, allowFile, mirror, base, sources);
  for (const p of proposals) {
    const src = p.repositoryId !== undefined && p.repositoryId !== canonicalRepositoryId
      ? forkSources.get(p.repositoryId) ?? canonical
      : canonical;
    await ensureCommit(root, allowFile, mirror, p.head, [src, canonical]);
    if (p.base !== undefined) {
      await ensureCommit(root, allowFile, mirror, p.base, sources);
      const anc = await execGit(root, allowFile, mirror,
        ['merge-base', '--is-ancestor', p.base, p.head],
        { env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS });
      if (anc.code !== 0) {
        fail(422, 'invalid_base',
          `proposal ${p.id} head ${p.head} does not descend from its recorded base ${p.base}`);
      }
    }
  }

  // Deterministic merge clock: derived from the base commit so identical
  // inputs produce an identical candidate SHA (real dedupe, not drift).
  const baseTime = Number(
    await mustGit(root, allowFile, mirror, ['show', '-s', '--format=%ct', base], {
      env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
    }),
  );
  const mergeEnv = baseEnv(root);
  const stamp = new Date((Number.isFinite(baseTime) ? baseTime + 1 : Math.floor(Date.now() / 1000)) * 1000).toISOString();
  mergeEnv.GIT_AUTHOR_DATE = stamp;
  mergeEnv.GIT_COMMITTER_DATE = stamp;

  const work = join(layout(root).workRoot, `prep-${operationId}`);
  const proposalHeads: Record<string, Sha> = {};
  for (const p of proposals) proposalHeads[p.id] = p.head;
  try {
    await mustGit(root, allowFile, mirror, ['worktree', 'add', '--detach', work, base], {
      env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
    });
    for (const p of proposals) {
      const merge = await execGit(root, allowFile, work, ['merge', '--no-ff', '--no-edit', p.head], {
        env: mergeEnv, timeoutMs: OP_TIMEOUT_MS,
      });
      if (merge.code !== 0) {
        const unmerged = (await execGit(root, allowFile, work,
          ['diff', '--name-only', '--diff-filter=U'],
          { env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS }))
          .stdout.split('\n').filter(Boolean);
        await execGit(root, allowFile, work, ['merge', '--abort'], {
          env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
        });
        return {
          sha: '', base, proposalHeads, changedPaths: [],
          conflicts: unmerged.map((path) => ({ path, proposalIds: [p.id] })),
        };
      }
    }
    const sha = (await mustGit(root, allowFile, work, ['rev-parse', 'HEAD'], {
      env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
    })) as Sha;
    const changedPaths = (await execGit(root, allowFile, work,
      ['diff', '--name-only', base, sha],
      { env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS }))
      .stdout.split('\n').filter(Boolean);
    if (changedPaths.length > MAX_CHANGED_PATHS) {
      fail(422, 'too_large', `combined change touches more than ${MAX_CHANGED_PATHS} paths`);
    }

    // Pin the candidate: local mirror ref AND the disposable remote ref so
    // the exact SHA survives a mirror rebuild before checks run.
    await mustGit(root, allowFile, mirror, ['update-ref', candidateRef, sha], {
      env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
    });
    const pin = await execGit(root, allowFile, mirror,
      ['push', canonical.remote, `${sha}:${candidateRef}`],
      { env: canonical.env, timeoutMs: PUSH_TIMEOUT_MS });
    if (pin.code !== 0) {
      const detail = pin.stderr.trim().split('\n').slice(0, 2).join(' ').slice(0, 200);
      fail(503, 'candidate_ref_push_failed',
        `candidate objects could not be pinned on the canonical remote: ${detail || 'push failed'}`, {
          nextAction: 'retry once the artifacts remote accepts the disposable candidate ref',
        });
    }
    const diff=await execGit(root,allowFile,work,['diff','--no-ext-diff','--no-textconv','--unified=3',base,sha,'--'],{env:baseEnv(root),timeoutMs:OP_TIMEOUT_MS}).catch(()=>null);
    return { sha, base, proposalHeads, changedPaths, candidateRef, remoteCandidatePushed: true,...(diff?.code===0?{diffPreview:{base,head:sha,text:diff.stdout.slice(0,6000),truncated:diff.stdout.length>6000}}:{}) };
  } finally {
    await execGit(root, allowFile, mirror, ['worktree', 'remove', '--force', work], {
      env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
    }).catch(() => undefined);
    await execGit(root, allowFile, mirror, ['worktree', 'prune'], {
      env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS,
    }).catch(() => undefined);
  }
}

async function doPush(
  root: string, allowFile: boolean, mirror: string,
  payload: Record<string, unknown>, job: ExecutionJob,
): Promise<Record<string, unknown>> {
  const canonicalRepositoryId = str(payload.repositoryId, 'repositoryId', 256);
  const ref = str(payload.ref, 'ref');
  assertRefName(ref, 'ref');
  const canonicalRef = str(payload.canonicalRef, 'canonicalRef');
  if (ref !== canonicalRef) {
    // Integration writes are confined to the configured disposable ref.
    fail(422, 'ref_not_canonical', `push target ${ref} is not the configured canonical ref`);
  }
  const expectedTip = optSha(payload.expectedTip, 'expectedTip') as Sha;
  const candidateTip = optSha(payload.candidateTip, 'candidateTip') as Sha;
  const operationId = str(payload.operationId, 'operationId', 160);
  const canonical = resolveRemote(payload, canonicalRepositoryId, root, allowFile);

  // Objects needed for the ancestor precondition and the pack itself.
  await fetchRemoteSweep(root, allowFile, mirror, canonical, 0, [canonicalRef]);
  await ensureCommit(root, allowFile, mirror, candidateTip, [canonical]);

  // Read the remote tip first: a stale expectedTip or a missing ref is a
  // provable no-effect — the atomic lease could never apply — without any
  // remote write. A race after this read is still caught by the lease.
  const before = await remoteTip(root, allowFile, mirror, canonical, ref);
  if (before === candidateTip) {
    return { ended: true, effect: 'no-effect', reportStatus: 'already-at-candidate-tip' };
  }
  if (before === null) {
    return { ended: true, effect: 'no-effect', reportStatus: 'ref-missing' };
  }
  if (before !== expectedTip) {
    return { ended: true, effect: 'no-effect', reportStatus: `tip-moved:${before}` };
  }
  const anc = await execGit(root, allowFile, mirror,
    ['merge-base', '--is-ancestor', expectedTip, candidateTip],
    { env: baseEnv(root), timeoutMs: OP_TIMEOUT_MS });
  if (anc.code === 1) {
    return { ended: true, effect: 'no-effect', reportStatus: 'expected-tip-not-ancestor' };
  }
  if (anc.code !== 0) {
    fail(503, 'git_failed', 'merge-base --is-ancestor failed');
  }

  // Durable local journal of intent BEFORE the remote write — a crash
  // after this line is always reconciled, never silently lost.
  journal(root, job.projectId, {
    jobId: job.id, action: 'git.push', phase: 'pre',
    ref, expectedTip, candidateTip, operationId,
  }, true);

  const push = await execGit(root, allowFile, mirror, [
    'push', '--porcelain', canonical.remote,
    `${candidateTip}:${ref}`,
    `--force-with-lease=${ref}:${expectedTip}`,
  ], { env: canonical.env, timeoutMs: PUSH_TIMEOUT_MS });

  // Read-back classification — never trust the transport status alone.
  const after = await remoteTip(root, allowFile, mirror, canonical, ref);
  const rejected = /rejected|stale info|failed to update|non-fast-forward/i
    .test(`${push.stdout}\n${push.stderr}`);

  let out: { ended: boolean; effect: 'updated' | 'no-effect' | 'unknown'; reportStatus: string };
  if (after === candidateTip) {
    out = push.code === 0
      ? { ended: true, effect: 'updated', reportStatus: 'expected-tip-lease-held' }
      : { ended: true, effect: 'no-effect', reportStatus: 'already-at-candidate-tip' };
  } else if (after === expectedTip) {
    out = {
      ended: true, effect: 'no-effect',
      reportStatus: rejected ? 'expected-tip-lease-rejected' : 'update-failed-tip-unchanged',
    };
  } else if (after !== null && rejected) {
    out = { ended: true, effect: 'no-effect', reportStatus: `tip-moved:${after}` };
  } else if (after !== null && push.code === 0) {
    out = { ended: true, effect: 'unknown', reportStatus: 'push-reported-ok-readback-differs' };
  } else {
    out = {
      ended: true, effect: 'unknown',
      reportStatus: after === null
        ? 'readback-unavailable'
        : `tip-moved-after-error:${after}`,
    };
  }

  journal(root, job.projectId, {
    jobId: job.id, action: 'git.push', phase: 'post',
    ref, expectedTip, candidateTip, operationId,
    observedTip: after ?? undefined, effect: out.effect, reportStatus: out.reportStatus,
  }, false);
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Execute one broker-dispatched git job. Returns the documented result
 * shapes ({tip}, {isAncestor}, the original prepare/push results); domain
 * failures throw ApiError so the broker stores a sanitized {code,message}
 * error — never stack traces, never transport plaintext.
 */
export async function runGitExecution(
  job: ExecutionJob,
  options: BridgeOptions,
): Promise<Record<string, unknown>> {
  const opts = options as GitExecutorOptions;
  const allowFile = opts.allowFileTransport === true;
  if (
    typeof options.root !== 'string' || options.root.length === 0 ||
    options.root.length > 4096 || options.root.includes('\0')
  ) {
    fail(422, 'invalid_options', 'options.root must be a non-empty owned directory path');
  }
  const root = options.root;
  if (job.role !== 'git') {
    fail(422, 'wrong_role', `job ${job.id} has role ${String(job.role)}, expected git`);
  }
  if (!Array.isArray(options.projectIds) || !options.projectIds.includes(job.projectId)) {
    fail(403, 'project_not_allowed', `project ${job.projectId} is not on this companion's allowlist`);
  }
  const payload = job.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail(422, 'invalid_payload', 'job payload must be an object');
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_PAYLOAD_BYTES) {
    fail(422, 'too_large', 'job payload exceeds the bounded size');
  }
  if (payload.projectId !== job.projectId) {
    fail(422, 'project_mismatch', 'payload projectId does not match the job');
  }
  str(payload.repositoryId, 'repositoryId', 256);
  assertRefName(str(payload.canonicalRef, 'canonicalRef'), 'canonicalRef');

  if (job.action === 'git.push' && typeof job.deadlineAt === 'string' &&
      Number.isFinite(Date.parse(job.deadlineAt)) && Date.parse(job.deadlineAt) <= Date.now()) {
    // A consequential push past its deadline must not dispatch.
    return { ended: true, effect: 'no-effect', reportStatus: 'expired-before-dispatch' };
  }

  ensureRootLayout(root);
  const mirror = await ensureMirror(root, allowFile, job.projectId);

  try {
    switch (job.action) {
      case 'git.readTip':
        return await doReadTip(root, allowFile, mirror, payload);
      case 'git.isAncestor':
        return await doIsAncestor(root, allowFile, mirror, payload);
      case 'git.prepare':
        return await doPrepare(root, allowFile, mirror, payload, job);
      case 'git.push':
        return await doPush(root, allowFile, mirror, payload, job);
      default:
        fail(422, 'unknown_action', `action ${String(job.action)} is not a git action`);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    fail(503, 'git_failed', 'git execution failed without a classified outcome');
  }
}
