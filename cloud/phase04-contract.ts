// Shared phase04 seam declarations. Controller-owned; workers report changes needed.
import type { Principal, ProjectState, GitService, RunnerService } from '../lib/types.ts';
import type { ArtifactsNamespaceLike } from '../lib/artifacts.ts';
import type { OwnerToken } from '../lib/identity.ts';
export interface CloudStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string }): Promise<Map<string,T>>;
  transaction<T>(fn: (tx: CloudStorage) => Promise<T>): Promise<T>;
  sql?: unknown;
}
export interface CloudObjectState {
  id: { name?: string; toString(): string };
  storage: CloudStorage;
  blockConcurrencyWhile?<T>(fn: () => Promise<T>): Promise<T> | void;
  waitUntil?(p: Promise<unknown>): void;
}
export interface CloudStub { fetch(request: Request): Promise<Response> }
export interface CloudNamespace { idFromName(name: string): { toString(): string }; get(id: { toString(): string }): CloudStub }
export interface CloudEnv {
  PROJECT_OBJECT?: CloudNamespace;
  DIRECTORY_OBJECT?: CloudNamespace;
  SESSION_OBJECT?: CloudNamespace;
  EXECUTION_OBJECT?: CloudNamespace;
  ARTIFACTS?: ArtifactsNamespaceLike;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  OWNER_TOKENS?: string;
  GIT_BRIDGE_TOKEN?: string;
  CHECK_BRIDGE_TOKEN?: string;
  GIT_BRIDGE_PROJECT_IDS?: string;
  CHECK_BRIDGE_PROJECT_IDS?: string;
  RUNTIME_BRIDGE_TOKEN?: string;
  RUNTIME_BRIDGE_PROJECT_IDS?: string;
  TEST_REPO_PREFIX?: string;
  TEST_CANONICAL_REF?: string;
  ALLOWED_ORIGINS?: string;
  [key: string]: unknown;
}
export interface CloudOwner { id: string; ownerId: string }
export interface DirectoryProjectRecord {
  id: string; ownerId: string; goal: string; createdAt: string;
  repositoryId: string; remote: string; canonicalRef: string;
  provisioning: 'pending' | 'ready' | 'failed';
  operationId: string; digest: string;
}
export type ExecutionRole = 'git' | 'check' | 'runtime';
export type ExecutionAction = 'git.readTip' | 'git.prepare' | 'git.isAncestor' | 'git.push' | 'check.run' | 'check.cancel' | 'runtime.start' | 'runtime.status' | 'runtime.deliver' | 'runtime.stop';
export interface ExecutionInput {
  key: string; projectId: string; role: ExecutionRole; action: ExecutionAction;
  payload: Record<string,unknown>;
  deadlineAt: string;
  /** A git.push whose dispatch is uncertain is never automatically reassigned. */
  consequential?: boolean;
}
export interface ExecutionJob extends ExecutionInput {
  id: string; digest: string;
  status: 'queued' | 'leased' | 'completed' | 'failed' | 'effect-unconfirmed' | 'cancelled';
  leaseId?: string; leasedUntil?: string;
  result?: Record<string,unknown>;
  error?: { code: string; message: string };
}
export interface BridgeOptions {
  root: string; apiUrl: string; projectIds: string[];
  gitBridgeToken?: string; checkBridgeToken?: string; runtimeBridgeToken?: string;
  fetch?: typeof fetch; dockerBin?: string;
}
export type GitExecutionHandler = (job: ExecutionJob, opts: BridgeOptions) => Promise<Record<string,unknown>>;
export type CheckExecutionHandler = (job: ExecutionJob, opts: BridgeOptions) => Promise<Record<string,unknown>>;
export type { Principal, ProjectState, GitService, RunnerService, OwnerToken };
