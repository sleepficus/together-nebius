// Artifacts adapter for the Together slice (seat b-swe-02).
//
// Repairs the two defects Field's doc-shaped probe found in the original
// construction adapter (SPEC-V2 "Delivery boundaries"):
//   1. Blob serialization: readFile returns `Blob | null`; the original
//      treated the result as JSON-serializable and lost file content
//      (`JSON.stringify(blob)` -> "{}"). Here text is decoded explicitly
//      via `blob.text()` and the three input cases are distinguished:
//      empty/invalid input -> 422, missing file -> 404, dependency not
//      ready -> 503 (SPEC-AMENDMENT item 1).
//   2. Disposable handle: the Artifacts `get()` capability implements
//      `Disposable`; the original release path called a non-existent
//      `.release?.()` method, so the capability
//      leaked. This adapter releases it via `Symbol.dispose` exactly
//      once, including exception paths (idempotent guard).
//
// Binding shapes follow the primary Artifacts Workers binding docs
// (env.ARTIFACTS namespace + disposable ArtifactsRepo capability;
// Wrangler >= 4.145.0 generated types are authoritative in the real
// project — these structural interfaces are the offline equivalent).
// No real cloud calls are made by this seat; fixtures in
// tests/artifacts.test.ts exercise the documented shapes offline.
//
// phase04 (seat c-swe-05): class internals are protected (not private) so
// cloud/project-artifacts.ts can bind a project-scoped subclass with
// durable fork provenance; normalizeTokenResult/artifactsBindingError are
// exported for the trusted capability helper; createToken resolves
// fork-scoped capabilities inside its error-mapping try so a deleted or
// unknown fork yields a typed ApiError instead of a raw binding throw.

import { ApiError, fail } from './core.ts';
import type { ArtifactsAdapter, IsoTime, Sha } from './types.ts';

// ---------------------------------------------------------------------------
// Doc-shaped binding surface (structural — matches wrangler-generated types)
// ---------------------------------------------------------------------------

export interface ArtifactsReadFileArgs {
  ref: string;
  path: string;
}

export interface ArtifactsCommitMetadata {
  sha?: string;
  hash?: string;
  id?: string;
  message?: string;
  author?: unknown;
  createdAt?: string;
}

export interface ArtifactsTreeEntry {
  name: string;
  type: string;
  hash?: string;
}

export type ArtifactsTokenScope = 'read' | 'write';

/** Disposable repo capability returned by `Artifacts.get(name)`. */
export interface ArtifactsRepoLike {
  info(): Promise<object>;
  createToken(scope?: ArtifactsTokenScope, ttl?: number): Promise<{ plaintext?: string; expiresAt?: string; token?: string; expires_at?: string }>;
  listTokens?(): Promise<object>;
  revokeToken?(tokenOrId: string): Promise<boolean>;
  fork(name: string, opts?: ArtifactsForkOptions): Promise<object>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]>;
  readCommit?(hash: string): Promise<ArtifactsCommitMetadata | null>;
  readTree?(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  readBlob?(hash: string): Promise<Blob | null>;
  readFile(args: ArtifactsReadFileArgs): Promise<Blob | null>;
  [Symbol.dispose](): void;
}

export interface ArtifactsForkOptions {
  description?: string;
  readOnly?: boolean;
  defaultBranchOnly?: boolean;
}

export interface ArtifactsCreateOptions {
  readOnly?: boolean;
  description?: string;
  setDefaultBranch?: string;
}

/** Namespace binding surface (`env.ARTIFACTS`). */
export interface ArtifactsNamespaceLike {
  get(name: string): Promise<ArtifactsRepoLike>;
  create?(name: string, opts?: ArtifactsCreateOptions): Promise<object>;
  list?(opts?: { limit?: number; cursor?: string }): Promise<object>;
  import?(params: any): Promise<object>;
  delete?(name: string): Promise<boolean>;
}

/** Flat repository metadata — never contains token material or functions. */
export interface ArtifactRepoMetadata {
  id: string;
  name: string;
  remote: string;
  defaultBranch: string;
  /** Doc-shaped lifecycle: ready | importing | forking. */
  status: string;
  ready: boolean;
  [key: string]: unknown;
}

/** Result of create/fork: flat metadata plus a separately-carried token. */
export interface ArtifactsRepoResult {
  [key: string]: unknown;
  repo: ArtifactRepoMetadata;
  /** Token plaintext is kept out of `repo` so it is never persisted with metadata. */
  token: { plaintext: string; expiresAt: IsoTime | null } | null;
}

export interface CreateTokenScope {
  repositoryId?: string;
  permissions?: string[];
  expiresInSeconds?: number;
}

export interface ArtifactsAdapterOptions {
  /** `env.ARTIFACTS` (or the offline fixture equivalent). */
  namespace: ArtifactsNamespaceLike | null | undefined;
  /** Repository name this adapter is bound to. */
  repo: string;
}

// The live binding resolves short branch names and exact SHAs, but does not
// resolve Git's fully qualified refs/heads form. Normalize only that known
// branch prefix here; transport CAS continues to use the full Git ref.
export function bindingRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

// ---------------------------------------------------------------------------
// Error mapping — dependency failures never masquerade as domain errors
// ---------------------------------------------------------------------------

export function artifactsBindingError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  const e = err as { code?: string; name?: string; message?: string } | null;
  const code = String(e?.code ?? e?.name ?? '').toUpperCase();
  const msg = e?.message ?? 'artifacts binding call failed';
  if (code.includes('INVALID_INPUT') || code.includes('BAD_REQUEST')) {
    fail(422, 'artifact_invalid_input', msg);
  }
  if (code.includes('NOT_FOUND')) {
    fail(404, 'artifact_not_found', msg);
  }
  // Not-ready / transient dependency failure -> retryable 503.
  fail(503, 'artifacts_not_ready', msg, {
    nextAction: 'retry once the repository reports status "ready"',
  });
}

/** Flatten doc-shaped repo metadata; drop capabilities and token material. */
export function flatRepoMetadata(raw: unknown): ArtifactRepoMetadata {
  const src = (raw ?? {}) as Record<string, unknown>;
  const status = typeof src.status === 'string' && src.status !== '' ? src.status : 'ready';
  const meta: ArtifactRepoMetadata = {
    id: typeof src.id === 'string' ? src.id : '',
    name: typeof src.name === 'string' ? src.name : '',
    remote: typeof src.remote === 'string' ? src.remote : '',
    defaultBranch:
      typeof src.defaultBranch === 'string' ? src.defaultBranch
      : typeof src.default_branch === 'string' ? src.default_branch
      : '',
    status,
    ready: status === 'ready',
  };
  for (const [key, value] of Object.entries(src)) {
    if (key in meta) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      meta[key] = value;
    }
    // Nested objects and function-valued capability fields are not metadata.
  }
  // Token plaintext never travels inside stored metadata.
  delete meta.token;
  delete meta.plaintext;
  delete meta.tokenPlaintext;
  delete meta.expiresAt;
  delete meta.expires_at;
  return meta;
}

/** The `?expires=<unix>` suffix doc-encoded into an Artifacts token string. */
function expiryFromTokenPlaintext(plaintext: string): IsoTime | null {
  const match = /[?&]expires=(\d+)/.exec(plaintext);
  if (!match) return null;
  const ms = Number(match[1]) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Split a doc-shaped create/fork result into flat metadata + separate token. */
function splitRepoResult(raw: unknown): ArtifactsRepoResult {
  const src = (raw ?? {}) as Record<string, unknown>;
  const repo = flatRepoMetadata(src);
  // `token` may be a bare string or a structured {plaintext, expiresAt}.
  const tokenField = src.token;
  const tokenPlaintext =
    typeof tokenField === 'string' && tokenField !== '' ? tokenField
    : typeof tokenField === 'object' && tokenField !== null &&
        typeof (tokenField as { plaintext?: unknown }).plaintext === 'string'
      ? String((tokenField as { plaintext?: unknown }).plaintext)
      : null;
  const tokenExpiresAt =
    typeof tokenField === 'object' && tokenField !== null &&
      typeof (tokenField as { expiresAt?: unknown }).expiresAt === 'string'
      ? String((tokenField as { expiresAt?: unknown }).expiresAt)
      : null;
  const plaintext =
    tokenPlaintext ??
    (typeof src.plaintext === 'string' && src.plaintext !== '' ? src.plaintext : null);
  if (plaintext === null) return { repo, token: null };
  const expiresAt =
    typeof src.expiresAt === 'string' ? src.expiresAt
    : typeof src.expires_at === 'string' ? src.expires_at
    : tokenExpiresAt ?? expiryFromTokenPlaintext(plaintext);
  return { repo, token: { plaintext, expiresAt } };
}

/**
 * Normalize the doc-shaped createToken result: `{ plaintext, expiresAt }`.
 * Plaintext is required — a token-less result is a dependency failure, not
 * a partial success. Expiry falls back to the `?expires=` marker inside
 * the plaintext, then to a computed ttl.
 */
export function normalizeTokenResult(
  raw: { plaintext?: string; expiresAt?: string; token?: string; expires_at?: string },
  ttlSeconds: number,
): { plaintext: string; expiresAt: IsoTime } {
  const plaintext =
    typeof raw.plaintext === 'string' && raw.plaintext !== '' ? raw.plaintext
    : typeof raw.token === 'string' && raw.token !== '' ? raw.token
    : null;
  if (plaintext === null) {
    fail(503, 'artifacts_unavailable', 'token result did not include plaintext');
  }
  const expiresAt =
    typeof raw.expiresAt === 'string' ? raw.expiresAt
    : typeof raw.expires_at === 'string' ? raw.expires_at
    : expiryFromTokenPlaintext(plaintext) ?? new Date(Date.now() + ttlSeconds * 1000).toISOString();
  return { plaintext, expiresAt };
}

function tokenScopeFromPermissions(permissions?: string[]): ArtifactsTokenScope {
  // Least-privilege default: only an explicit write permission mints write.
  if (permissions?.includes('write') || permissions?.includes('fork:write')) return 'write';
  return 'read';
}

// ---------------------------------------------------------------------------
// Adapter — bound to one repo; lazily acquires its disposable capability and
// releases it via Symbol.dispose exactly once, including exception paths.
// ---------------------------------------------------------------------------

export class ArtifactsBindingAdapter implements ArtifactsAdapter {
  protected namespace: ArtifactsNamespaceLike | null | undefined;
  protected repoName: string;
  protected cap: ArtifactsRepoLike | null = null;
  protected pending: Promise<ArtifactsRepoLike> | null = null;
  protected disposed = false;
  protected forkNames = new Set<string>();

  constructor(opts: ArtifactsAdapterOptions) {
    this.namespace = opts.namespace;
    this.repoName = opts.repo;
    if (typeof this.repoName !== 'string' || this.repoName.trim() === '') {
      fail(422, 'artifact_invalid_input', 'repo name is required');
    }
  }

  get repository(): string {
    return this.repoName;
  }

  /** Lazily acquire the disposable capability once; concurrent callers share it. */
  protected async capability(): Promise<ArtifactsRepoLike> {
    if (this.disposed) {
      fail(409, 'artifacts_disposed', 'artifacts capability already disposed; create a new adapter');
    }
    if (this.cap) return this.cap;
    const ns = this.namespace;
    if (!ns || typeof ns.get !== 'function') {
      fail(503, 'artifacts_not_ready', 'artifacts binding is not configured', {
        nextAction: 'configure the artifacts binding and retry',
      });
    }
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(() => ns.get(this.repoName))
        .catch((err: unknown) => {
          this.pending = null;
          artifactsBindingError(err);
        });
    }
    this.cap = await this.pending;
    return this.cap;
  }

  /**
   * Resolve a capability for a repository other than the bound one (issued
   * forks). Only reached after isIssuedFork attests the target.
   */
  protected async resolveScoped(repositoryId: string): Promise<ArtifactsRepoLike> {
    const ns = this.namespace;
    if (!ns || typeof ns.get !== 'function') {
      fail(503, 'artifacts_not_ready', 'artifacts binding is not configured', {
        nextAction: 'configure the artifacts binding and retry',
      });
    }
    return ns.get(repositoryId);
  }

  /**
   * Whether `repositoryId` names a fork this adapter actually issued. The
   * base answer is the in-memory fork set; subclasses may override with a
   * durable provenance check so issued forks survive process recreation.
   */
  protected isIssuedFork(repositoryId: string): boolean | Promise<boolean> {
    return this.forkNames.has(repositoryId);
  }

  /**
   * Doc-shaped read: returns `Blob | null` — never a serialized stand-in.
   * `ref` defaults to HEAD; empty ref/path is 422 before the binding call.
   */
  async readFile(path: string, ref = 'HEAD'): Promise<Blob | null> {
    if (typeof path !== 'string' || path.trim() === '') {
      fail(422, 'artifact_invalid_input', 'readFile requires a non-empty repository-relative path');
    }
    if (typeof ref !== 'string' || ref.trim() === '') {
      fail(422, 'artifact_invalid_input', 'readFile requires a non-empty ref');
    }
    const cap = await this.capability();
    try {
      const blob = await cap.readFile({ ref: bindingRef(ref), path });
      return blob === null ? null : blob;
    } catch (err) {
      artifactsBindingError(err);
    }
  }

  /**
   * Text decode over readFile — the repair for the Blob-serialization bug.
   * missing file -> 404; empty/invalid input -> 422; binding INVALID_INPUT
   * -> 422; dependency not ready -> 503. An existing zero-byte file
   * legitimately decodes to ''.
   */
  async readFileText(path: string, ref = 'HEAD'): Promise<string> {
    const blob = await this.readFile(path, ref);
    if (blob === null) {
      fail(404, 'artifact_not_found', `no file at "${path}" (ref ${ref})`);
    }
    try {
      return await blob.text();
    } catch {
      fail(503, 'artifacts_unavailable', 'failed to decode artifact blob text');
    }
  }

  /** Flat repository metadata plus readiness — fresh lookup via info(). */
  async info(): Promise<ArtifactRepoMetadata> {
    const cap = await this.capability();
    try {
      return flatRepoMetadata(await cap.info());
    } catch (err) {
      artifactsBindingError(err);
    }
  }

  /**
   * Exact-tip contract: resolve a ref to its current commit SHA via
   * first-parent log. Unresolvable ref -> 404 (not a guessed tip).
   */
  async tip(ref = 'HEAD'): Promise<Sha> {
    const cap = await this.capability();
    let history: ArtifactsCommitMetadata[];
    try {
      history = await cap.log({ ref: bindingRef(ref), limit: 1 });
    } catch (err) {
      artifactsBindingError(err);
    }
    const commit = Array.isArray(history) ? history[0] : undefined;
    const sha = commit
      ? String(commit.sha ?? commit.hash ?? commit.id ?? '')
      : '';
    if (sha === '') {
      fail(404, 'ref_not_found', `ref "${ref}" does not resolve to a commit`);
    }
    return sha;
  }

  /**
   * Assert the exact current tip of a ref — full-string equality only.
   * A moved ref is 409, never silently accepted as "close enough".
   */
  async requireTip(ref: string, expectedTip: Sha): Promise<Sha> {
    if (typeof expectedTip !== 'string' || expectedTip === '') {
      fail(422, 'artifact_invalid_input', 'expectedTip is required');
    }
    const actual = await this.tip(ref);
    if (actual !== expectedTip) {
      fail(409, 'tip_mismatch', `ref "${ref}" is at ${actual}, expected ${expectedTip}`, {
        nextAction: 're-read the tip and retry with the current value',
      });
    }
    return actual;
  }

  /**
   * Namespace-level create. Returns flat metadata; the initial token is
   * carried separately so it cannot be persisted inside repo metadata.
   */
  async createRepository(name: string, opts?: ArtifactsCreateOptions): Promise<ArtifactsRepoResult> {
    if (typeof name !== 'string' || name.trim() === '') {
      fail(422, 'artifact_invalid_input', 'repository name is required');
    }
    const ns = this.namespace;
    if (!ns || typeof ns.create !== 'function') {
      fail(503, 'artifacts_not_ready', 'artifacts binding does not support create');
    }
    try {
      return splitRepoResult(await ns.create(name, opts));
    } catch (err) {
      artifactsBindingError(err);
    }
  }

  /**
   * Fork the bound repo. `repositoryId` must name this adapter's repo —
   * a fork of anything else is rejected, never silently redirected.
   */
  async fork(repositoryId: string, name?: string, opts?: ArtifactsForkOptions): Promise<ArtifactsRepoResult> {
    if (repositoryId !== this.repoName) {
      fail(422, 'artifact_repo_mismatch', `adapter is bound to "${this.repoName}", not "${repositoryId}"`);
    }
    const cap = await this.capability();
    const forkName = typeof name === 'string' && name.trim() !== '' ? name : `${this.repoName}-fork`;
    try {
      const result = splitRepoResult(await cap.fork(forkName, opts));
      this.forkNames.add(result.repo.name);
      this.forkNames.add(result.repo.id);
      return result;
    } catch (err) {
      artifactsBindingError(err);
    }
  }

  /**
   * Doc-shaped token: `{ plaintext, expiresAt }` — plaintext is returned to
   * the caller only and must never be stored in state, exports or logs.
   * Defaults to least-privilege read scope and a one-hour TTL.
   */
  async createToken(scope?: CreateTokenScope): Promise<{ plaintext: string; expiresAt: IsoTime }> {
    if (scope?.repositoryId !== undefined && scope.repositoryId !== this.repoName && !(await this.isIssuedFork(scope.repositoryId))) {
      fail(422, 'artifact_repo_mismatch', `adapter is bound to "${this.repoName}", not "${scope.repositoryId}"`);
    }
    const forkScoped = scope?.repositoryId !== undefined && scope.repositoryId !== this.repoName;
    const tokenScope = tokenScopeFromPermissions(scope?.permissions);
    const ttl = typeof scope?.expiresInSeconds === 'number' && scope.expiresInSeconds > 0
      ? scope.expiresInSeconds
      : 3600;
    let cap: ArtifactsRepoLike | undefined;
    try {
      cap = forkScoped ? await this.resolveScoped(scope!.repositoryId!) : await this.capability();
      return normalizeTokenResult(await cap.createToken(tokenScope, ttl), ttl);
    } catch (err) {
      artifactsBindingError(err);
    } finally {
      if (forkScoped && cap !== undefined) cap[Symbol.dispose]();
    }
  }

  /**
   * Release the repo capability via Symbol.dispose — idempotent and exactly
   * once, including exception paths. Also releases a still-in-flight get()
   * so no handle is left dangling after the adapter is released.
   */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    const cap = this.cap;
    this.cap = null;
    const release = (c: ArtifactsRepoLike | null | undefined): void => {
      const dispose = c?.[Symbol.dispose];
      if (c && typeof dispose !== 'function') fail(503, 'artifacts_contract_invalid', 'repository capability does not implement Disposable');
      if (typeof dispose === 'function') dispose.call(c);
    };
    release(cap);
    // If a get() was still in flight when we were released, make sure that
    // late-arriving capability is disposed too — but never the same handle
    // twice.
    void this.pending?.then((c) => {
      if (c !== cap) release(c);
    }, () => undefined);
    this.pending = null;
  }
}

/** Factory matching the module contract: `createArtifactsAdapter({namespace, repo})`. */
export function createArtifactsAdapter(opts: ArtifactsAdapterOptions): ArtifactsBindingAdapter {
  return new ArtifactsBindingAdapter(opts);
}
