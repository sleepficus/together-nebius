// Cloud Artifacts transport for phase04 (seat c-swe-05).
//
// Binds the Artifacts adapter to the trusted directory record's repository
// — never to a caller-chosen name, path, header or remote — and provides
// the internal repositoryCapability() helper that mints bounded short-lived
// transport tokens for trusted cloud plumbing (the git/check bridge).
//
// Fork provenance is enforced by a naming convention: every fork minted
// through the project adapter is named
//   together-cloud-fork-<projectId>-<sanitized suffix>
// so an issued fork is attestable from the directory record alone even
// after durable-object recreation, with binding metadata (forkOf/parent/
// source fields, when the binding reports them) as a second witness.
//
// Scope rules (SPEC §5):
//   * 'write' capabilities are issued for the canonical repository only,
//     and only through repositoryCapability — the project-bound adapter
//     refuses to mint canonical write tokens on the handler-visible path.
//   * 'read' capabilities may be issued for the canonical repository and
//     for repositories proven to be this project's issued forks.
//   * Agent-issued workspaces arrive only via the existing assignments
//     workspace handler; repositoryCapability is internal plumbing and is
//     never mounted on a public route. Plaintext leaves this module only
//     inside trusted broker payloads/durable private storage — never in
//     public project state, exports, logs or responses.

import { fail } from '../lib/core.ts';
import {
  ArtifactsBindingAdapter,
  artifactsBindingError,
  flatRepoMetadata,
  normalizeTokenResult,
} from '../lib/artifacts.ts';
import type {
  ArtifactRepoMetadata,
  ArtifactsCreateOptions,
  ArtifactsForkOptions,
  ArtifactsRepoLike,
  ArtifactsRepoResult,
  CreateTokenScope,
} from '../lib/artifacts.ts';
import type { CloudEnv, DirectoryProjectRecord } from './phase04-contract.ts';
import type { ArtifactsAdapter, IsoTime } from '../lib/types.ts';

/** Canonical repositories are created under this prefix (lane01/lane09). */
export const CANONICAL_REPO_PREFIX = 'together-cloud-';
/** Issued forks carry the project-scoped prefix so provenance is durable. */
export const FORK_REPO_PREFIX = 'together-cloud-fork-';
/** Short-lived transport/fork capabilities: bounded to 15 minutes. */
export const TRANSPORT_TOKEN_TTL_SECONDS = 900;
/** Defensive bound on generated fork names. */
const MAX_REPO_NAME_LENGTH = 96;

/** Fork-name prefix attesting that a repository belongs to `record`'s project. */
export function projectForkPrefix(record: DirectoryProjectRecord): string {
  return `${FORK_REPO_PREFIX}${record.id}-`;
}

function sanitizeRepoSuffix(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned === '' ? 'workspace' : cleaned;
}

/**
 * Whether `repositoryId`/`meta` attest a repository issued as a fork of
 * this project's canonical repository. The durable witness is the
 * project-scoped fork-name prefix; binding-reported lineage fields are a
 * second witness when present.
 */
export function isProjectForkRepository(
  record: DirectoryProjectRecord,
  repositoryId: string,
  meta?: ArtifactRepoMetadata,
): boolean {
  const prefix = projectForkPrefix(record);
  if (repositoryId.startsWith(prefix)) return true;
  if (meta !== undefined) {
    if (meta.name !== '' && meta.name.startsWith(prefix)) return true;
    for (const key of ['forkOf', 'fork_of', 'forkedFrom', 'forked_from', 'parent', 'parentRepository', 'source', 'sourceRepository', 'source_repository']) {
      const value = meta[key];
      if (
        typeof value === 'string' && value !== '' &&
        (value === record.repositoryId || (record.remote !== '' && value === record.remote))
      ) {
        return true;
      }
    }
  }
  return false;
}

function verifyRecord(record: DirectoryProjectRecord): void {
  if (
    typeof record !== 'object' || record === null ||
    typeof record.id !== 'string' || record.id === '' ||
    typeof record.repositoryId !== 'string' || record.repositoryId === ''
  ) {
    fail(422, 'artifact_invalid_input', 'directory record must carry a project id and repositoryId');
  }
}

/** Artifacts get() addresses names; directory records may retain opaque IDs.
 * Resolve only the deterministic name from this trusted project's remote,
 * then verify the returned metadata against both recorded ID and remote. */
function canonicalBindingName(env: CloudEnv, record: DirectoryProjectRecord): string {
  const name = `${env.TEST_REPO_PREFIX || CANONICAL_REPO_PREFIX}${record.id}`;
  if (record.repositoryId === name) return name;
  let remote: URL;
  try { remote = new URL(record.remote); } catch {
    fail(409, 'repo_provenance_mismatch', 'canonical remote cannot resolve its recorded repository');
  }
  if (remote.protocol !== 'https:' || !remote.hostname.endsWith('.artifacts.cloudflare.net') ||
      remote.username || remote.password || remote.search || remote.hash ||
      remote.pathname.split('/').pop() !== `${name}.git`) {
    fail(409, 'repo_provenance_mismatch', 'canonical remote does not name this project repository');
  }
  return name;
}

/**
 * The binding must resolve to the repository the directory record names.
 * A remote that disagrees with the trusted record is a hard mismatch, never
 * a silent fallback.
 */
function verifyRemoteProvenance(record: DirectoryProjectRecord, meta: ArtifactRepoMetadata, bindingName = record.repositoryId): void {
  if (bindingName !== record.repositoryId &&
      (meta.id !== record.repositoryId || meta.remote === '' || meta.remote !== record.remote)) {
    fail(409, 'repo_provenance_mismatch', 'name-resolved repository must attest its recorded ID and remote');
  }
  if (meta.name !== '' && meta.id !== '' && meta.name !== record.repositoryId && meta.id !== record.repositoryId) {
    fail(409, 'repo_provenance_mismatch', 'bound repository identity differs from the directory record', { retryable: false });
  }
  if (
    typeof record.remote === 'string' && record.remote !== '' &&
    meta.remote !== '' && meta.remote !== record.remote
  ) {
    fail(409, 'repo_provenance_mismatch', 'bound repository remote differs from the directory record', { retryable: false });
  }
}

/**
 * Artifacts adapter bound to `record.repositoryId`. All inherited read
 * semantics (Blob|null reads, refs/heads normalization, exact-tip CAS,
 * exactly-once Symbol.dispose) are unchanged; this subclass adds:
 *   - lazy one-time provenance verification against the directory record,
 *   - project-prefixed fork naming so issued forks are durable-attestable,
 *   - durable isIssuedFork so fork-scoped tokens work after DO recreation,
 *   - denial of canonical write tokens and repository creation on this
 *     handler-visible surface.
 */
export class CloudProjectArtifactsAdapter extends ArtifactsBindingAdapter {
  private readonly record: DirectoryProjectRecord;
  private readonly canonicalName: string;
  private provenanceChecked = false;

  constructor(env: CloudEnv, record: DirectoryProjectRecord) {
    verifyRecord(record);
    const ns = env.ARTIFACTS;
    const canonicalName = canonicalBindingName(env, record);
    super({ namespace: ns ? { get: (name: string) => ns.get(
      name === record.repositoryId ? canonicalName : name,
    ) } : undefined, repo: record.repositoryId });
    this.record = record;
    this.canonicalName = canonicalName;
  }

  protected override async capability(): Promise<ArtifactsRepoLike> {
    if (this.record.provisioning !== 'ready') {
      fail(503, 'artifacts_not_ready', `repository provisioning is "${this.record.provisioning}"`, {
        nextAction: 'retry once the directory record reports provisioning "ready"',
      });
    }
    const cap = await super.capability();
    if (!this.provenanceChecked) {
      const meta = flatRepoMetadata(await cap.info());
      verifyRemoteProvenance(this.record, meta, this.canonicalName);
      this.provenanceChecked = true;
    }
    return cap;
  }

  private async resolveIfPresent(repositoryId: string): Promise<ArtifactsRepoLike | null> {
    try {
      return await this.resolveScoped(repositoryId);
    } catch (err) {
      const e = err as { code?: string; name?: string } | null;
      const code = String(e?.code ?? e?.name ?? '').toUpperCase();
      if (code.includes('NOT_FOUND')) return null;
      artifactsBindingError(err);
    }
  }

  /** Durable fork attestation: name prefix, then binding metadata witness. */
  protected override async isIssuedFork(repositoryId: string): Promise<boolean> {
    if (await super.isIssuedFork(repositoryId)) return true;
    if (isProjectForkRepository(this.record, repositoryId)) return true;
    const cap = await this.resolveIfPresent(repositoryId);
    if (cap === null) return false;
    try {
      return isProjectForkRepository(this.record, repositoryId, flatRepoMetadata(await cap.info()));
    } finally {
      cap[Symbol.dispose]();
    }
  }

  /**
   * Forks of the bound repository are created under the project prefix and
   * their result metadata normalizes `repositoryId` to the binding repo
   * name — the stable address `env.ARTIFACTS.get()` resolves — so a
   * persisted fork ref is always re-resolvable.
   */
  override async fork(repositoryId: string, name?: string, opts?: ArtifactsForkOptions): Promise<ArtifactsRepoResult> {
    const prefix = projectForkPrefix(this.record);
    const requested = typeof name === 'string' && name.trim() !== '' ? name : 'workspace';
    const suffix = requested.startsWith(prefix) ? requested.slice(prefix.length) : requested;
    const budget = Math.max(1, MAX_REPO_NAME_LENGTH - prefix.length);
    const scopedName = `${prefix}${sanitizeRepoSuffix(suffix).slice(0, budget)}`;
    const result = await super.fork(repositoryId, scopedName, opts);
    if (result.repo.name !== '') result.repo.repositoryId = result.repo.name;
    return result;
  }

  /**
   * Handler-visible token path: canonical write is denied (that capability
   * belongs to repositoryCapability only); fork write/read requires an
   * issued fork of this project; canonical read is allowed.
   */
  override async createToken(scope?: CreateTokenScope): Promise<{ plaintext: string; expiresAt: IsoTime }> {
    const target = scope?.repositoryId ?? this.repository;
    const wantsWrite =
      scope?.permissions?.includes('write') === true ||
      scope?.permissions?.includes('fork:write') === true;
    if (wantsWrite && target === this.record.repositoryId) {
      fail(403, 'capability_scope_denied', 'canonical write capabilities are minted only through the trusted repositoryCapability path', { retryable: false });
    }
    if (wantsWrite && !(await this.isIssuedFork(target))) {
      fail(403, 'capability_scope_denied', 'write capabilities require an issued fork of this project', { retryable: false });
    }
    return super.createToken(scope);
  }

  /** Project-bound adapters never create repositories — provisioning does. */
  override async createRepository(_name?: string, _opts?: ArtifactsCreateOptions): Promise<ArtifactsRepoResult> {
    fail(403, 'capability_scope_denied', 'repository creation is owned by provisioning, not a project adapter', { retryable: false });
  }
}

/**
 * Required export: the per-project Artifacts adapter, bound to the trusted
 * directory record's repository. Construct per request/invocation and
 * release via Symbol.dispose on all paths.
 */
export function createCloudArtifactsAdapter(env: CloudEnv, record: DirectoryProjectRecord): ArtifactsAdapter {
  return new CloudProjectArtifactsAdapter(env, record);
}

export interface RepositoryTransportCapability {
  repositoryId: string;
  /** Credential-free remote URL resolved from the binding — never a caller-supplied value. */
  remote: string;
  /** Short-lived Git token plaintext: trusted plumbing only, never persisted publicly. */
  plaintext: string;
  expiresAt: IsoTime;
}

/**
 * Required export: mint a bounded short-lived transport capability for the
 * canonical repository ('read' or 'write') or for a repository proven to be
 * this project's issued fork ('read' only). The repo handle is disposed
 * exactly once on every path.
 */
export async function repositoryCapability(
  env: CloudEnv,
  record: DirectoryProjectRecord,
  repositoryId: string,
  scope: 'read' | 'write',
): Promise<RepositoryTransportCapability> {
  verifyRecord(record);
  if (typeof repositoryId !== 'string' || repositoryId.trim() === '') {
    fail(422, 'artifact_invalid_input', 'repositoryId is required');
  }
  if (scope !== 'read' && scope !== 'write') {
    fail(422, 'artifact_invalid_input', 'scope must be "read" or "write"');
  }
  if (record.provisioning !== 'ready') {
    fail(503, 'artifacts_not_ready', `repository provisioning is "${record.provisioning}"`, {
      nextAction: 'retry once the directory record reports provisioning "ready"',
    });
  }
  const canonical = repositoryId === record.repositoryId;
  if (scope === 'write' && !canonical) {
    fail(403, 'capability_scope_denied', 'write transport capabilities are issued for the canonical repository only', { retryable: false });
  }
  const ns = env.ARTIFACTS;
  if (!ns || typeof ns.get !== 'function') {
    fail(503, 'artifacts_not_ready', 'env.ARTIFACTS binding is not configured', {
      nextAction: 'configure the artifacts binding and retry',
    });
  }
  let cap: ArtifactsRepoLike;
  try {
    cap = await ns.get(canonical ? canonicalBindingName(env, record) : repositoryId);
  } catch (err) {
    artifactsBindingError(err);
  }
  try {
    const meta = flatRepoMetadata(await cap.info());
    if (canonical) {
      verifyRemoteProvenance(record, meta, canonicalBindingName(env, record));
    } else if (!isProjectForkRepository(record, repositoryId, meta)) {
      fail(403, 'capability_scope_denied', 'repositoryId is not a fork issued for this project', { retryable: false });
    }
    const token = normalizeTokenResult(await cap.createToken(scope, TRANSPORT_TOKEN_TTL_SECONDS), TRANSPORT_TOKEN_TTL_SECONDS);
    const remote =
      meta.remote !== '' ? meta.remote
      : canonical && typeof record.remote === 'string' ? record.remote
      : '';
    return { repositoryId, remote, plaintext: token.plaintext, expiresAt: token.expiresAt };
  } catch (err) {
    artifactsBindingError(err);
  } finally {
    cap[Symbol.dispose]();
  }
}
