import {ConversationStore} from '../lib/conversation-store.ts';
// SQLite Durable Object wrapper for the Together slice (seat b-swe-01).
// One object per project owns serialized coordination records, operations
// and the event outbox. This file is a scaffold: the integrator wires the
// real authenticate hook, module handlers and service bindings.

import { createApp } from './app.ts';
import type { AppDeps, ModuleHandler } from './app.ts';
import { SQLiteStore } from '../lib/store.ts';
import type { DurableObjectStorageLike } from '../lib/store.ts';
import type { Store } from '../lib/types.ts';

export interface DurableObjectIdLike {
  toString(): string;
  name?: string;
}

export interface DurableObjectStateLike {
  id: DurableObjectIdLike;
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile?(fn: () => void | Promise<void>): void;
}

export interface ProjectObjectDeps extends Omit<AppDeps, 'store'> {
  /** Override projectId derivation; default is the DO id name/hex. */
  projectIdFrom?(state: DurableObjectStateLike): string;
}

export class ProjectObject {
  private state: DurableObjectStateLike;
  private deps: ProjectObjectDeps;
  private store: SQLiteStore;
  private conversation: ConversationStore;

  constructor(state: DurableObjectStateLike, deps: ProjectObjectDeps) {
    this.state = state;
    this.conversation = new ConversationStore(state.storage);
    this.deps = deps;
    const projectId =
      deps.projectIdFrom?.(state) ?? state.id.name ?? state.id.toString();
    this.store = new SQLiteStore({ storage: state.storage, projectId });
    state.blockConcurrencyWhile?.(() => this.store.init());
  }

  /** Exposed so provisioning code can seed state before first traffic. */
  get projectStore(): Store {
    return this.store;
  }

  async fetch(request: Request): Promise<Response> {
    const app = createApp({
      store: this.store,
      conversation: this.conversation, runtime: this.deps.runtime,
      authenticate: this.deps.authenticate,
      handlers: this.deps.handlers as ModuleHandler[],
      git: this.deps.git,
      runner: this.deps.runner,
      artifacts: this.deps.artifacts,
      now: this.deps.now,
      uid: this.deps.uid,
      maxBodyBytes: this.deps.maxBodyBytes,
    });
    return app.fetch(request);
  }
}

/**
 * Factory for wrangler-style `export class` wiring: deps live in module
 * scope because real env bindings cannot carry functions.
 */
export function createProjectObjectClass(deps: ProjectObjectDeps) {
  return class BoundProjectObject extends ProjectObject {
    constructor(state: DurableObjectStateLike) {
      super(state, deps);
    }
  };
}
