// Durable local store for the Together slice (integrator wiring, lane 10).
//
// JsonFileStore wraps the shared MemoryStore semantics and persists every
// committed projection to one JSON document per project. It exists so the
// local development server survives a restart without pretending to be the
// Durable Object: same Store contract, same transaction serialization,
// honest durability boundary (single file, atomic rename, no remote
// effects inside a transaction).
//
// A state file that exists but cannot be parsed is a hard failure, never a
// silent reset: durable user data is not overwritten by a guessing seed.

import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore } from '../lib/store.ts';
import type { ProjectState, Store } from '../lib/types.ts';

const FORMAT_VERSION = 1;

export class JsonFileStore implements Store {
  private readonly inner: MemoryStore;
  private readonly file: string;

  constructor(file: string, seed: () => ProjectState) {
    this.file = file;
    let initial: ProjectState | undefined;
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: number;
        state?: ProjectState;
      };
      if (doc.version === FORMAT_VERSION && typeof doc.state?.project?.id === 'string') {
        initial = doc.state;
      } else {
        throw new Error(`unsupported state document in ${file}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt or foreign data: fail closed rather than overwrite it.
        throw new Error(`refusing to overwrite unreadable state file ${file}: ${String(err)}`);
      }
    }
    const state = initial ?? seed();
    this.inner = new MemoryStore(state);
    if (initial === undefined) this.persist(state);
  }

  read(): Promise<ProjectState> { return this.inner.read(); }

  transact<T>(fn: (draft: ProjectState) => T): Promise<T> {
    return this.inner.transact(draft => {
      const result = fn(draft);
      // Persist before committing the memory projection. An I/O failure
      // throws and MemoryStore discards the draft, keeping both views aligned.
      this.persist(draft);
      return result;
    });
  }

  private persist(state: ProjectState): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: FORMAT_VERSION, savedAt: new Date().toISOString(), state }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

}

/** Deterministic on-disk name for a project id inside a state directory. */
export function stateFileName(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
  return `${safe === '' ? 'project' : safe}.json`;
}

/**
 * Load a previously persisted project state from a state file, or return
 * undefined when the file does not exist. Parse errors propagate (fail
 * closed, same rule as the store itself).
 */
export function readPersistedState(file: string): ProjectState | undefined {
  let doc: { version?: number; state?: ProjectState };
  try {
    doc = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; state?: ProjectState };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`refusing to load unreadable state file ${file}: ${String(err)}`);
  }
  if (doc.version !== FORMAT_VERSION || typeof doc.state?.project?.id !== 'string') {
    throw new Error(`unsupported state document in ${file}`);
  }
  return doc.state;
}
