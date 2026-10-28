// Store implementations for the Together slice (seat b-swe-01).
// Both implement the identical Store contract from lib/types.ts:
// read() returns an isolated copy; transact() runs a synchronous callback
// on a draft and commits atomically, rolling back on throw. No remote
// effects are permitted inside a transaction.

import { COLLECTIONS } from './types.ts';
import type { CollectionName, Entity, ProjectState, Store } from './types.ts';

const cloneState = (state: ProjectState): ProjectState => structuredClone(state);

export class StoreError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
  }
}

/**
 * In-memory store for unit tests and the sample-mode frontend adapter.
 * Transactions are serialized through a promise tail; a throwing callback
 * discards the draft (rollback) and the next transaction still proceeds.
 */
export class MemoryStore implements Store {
  private state: ProjectState;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(initial: ProjectState) {
    this.state = cloneState(initial);
  }

  read(): Promise<ProjectState> {
    return Promise.resolve(cloneState(this.state));
  }

  transact<T>(fn: (draft: ProjectState) => T): Promise<T> {
    const run = this.tail.then(() => {
      const draft = cloneState(this.state);
      const result = fn(draft);
      this.state = draft;
      return result;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Minimal structural view of Durable Object SQL storage — no wrangler import. */
export interface SqlStorageLike {
  exec(query: string, ...params: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

export interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  transactionSync?<T>(fn: () => T): T;
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
}

const MAP_COLUMNS = { collection: 'collection', id: 'id', revision: 'revision', updated_at: 'updated_at', body: 'body' };

/**
 * SQLite-backed store for the per-project Durable Object. Each transact()
 * reads the bounded projection, runs the synchronous callback, then writes
 * the full projection — state rows, events, late outputs, operation intent —
 * in one SQL transaction. Keep the Store interface identical; the single
 * transaction is what makes expected-revision/epoch validation plus
 * state+event+intent writes atomic.
 */
export class SQLiteStore implements Store {
  private opts: { storage: DurableObjectStorageLike; projectId: string };
  private tail: Promise<unknown> = Promise.resolve();
  private ready = false;

  constructor(opts: { storage: DurableObjectStorageLike; projectId: string }) {
    this.opts = opts;
  }

  init(): void {
    if (this.ready) return;
    const sql = this.opts.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS entities (' +
        'collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, ' +
        'updated_at TEXT NOT NULL, body TEXT NOT NULL, ' +
        'PRIMARY KEY (collection, id))',
    );
    sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS late_outputs (seq INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    this.ready = true;
  }

  /** Bootstrap write used once when a project object is provisioned. */
  initialize(initial: ProjectState): void {
    this.init();
    if (initial.project.id !== this.opts.projectId) {
      throw new StoreError(422, 'project_mismatch', 'initial state does not match this object');
    }
    const existing = this.opts.storage.sql
      .exec('SELECT id FROM project WHERE id = ?', this.opts.projectId)
      .toArray();
    if (existing.length > 0) {
      throw new StoreError(409, 'project_exists', 'project already initialized');
    }
    this.inTx(() => this.writeAll(initial));
  }

  read(): Promise<ProjectState> {
    return Promise.resolve(this.readState());
  }

  transact<T>(fn: (draft: ProjectState) => T): Promise<T> {
    const run = this.tail.then(() => {
      const draft = this.readState();
      const result = fn(draft);
      this.inTx(() => this.writeAll(draft));
      return result;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private readState(): ProjectState {
    this.init();
    const sql = this.opts.storage.sql;
    const projectRows = sql.exec('SELECT body FROM project WHERE id = ?', this.opts.projectId).toArray();
    if (projectRows.length === 0) {
      throw new StoreError(404, 'project_not_found', 'no project state in this object');
    }
    const project = JSON.parse(String(projectRows[0].body)) as ProjectState['project'];
    const state = emptyState(project);
    for (const row of sql.exec('SELECT collection, body FROM entities').toArray()) {
      const collection = String(row.collection) as CollectionName;
      const bucket = (state[collection]??{}) as Record<string, Entity>;
      const rec = JSON.parse(String(row.body)) as Entity;
      bucket[rec.id] = rec;
    }
    state.events = sql
      .exec('SELECT body FROM events ORDER BY seq ASC')
      .toArray()
      .map((row) => JSON.parse(String(row.body)) as ProjectState['events'][number]);
    state.lateOutputs = sql
      .exec('SELECT body FROM late_outputs ORDER BY seq ASC')
      .toArray()
      .map((row) => JSON.parse(String(row.body)) as ProjectState['lateOutputs'][number]);
    const stopped = sql.exec("SELECT v FROM meta WHERE k = 'stopped'").toArray();
    state.stopped = stopped.length > 0 && stopped[0].v === '1';
    return state;
  }

  private writeAll(state: ProjectState): void {
    const sql = this.opts.storage.sql;
    sql.exec(
      'INSERT INTO project (id, body) VALUES (?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET body = excluded.body',
      this.opts.projectId,
      JSON.stringify(state.project),
    );
    sql.exec('DELETE FROM entities');
    const insert = `INSERT INTO entities (${MAP_COLUMNS.collection}, ${MAP_COLUMNS.id}, ${MAP_COLUMNS.revision}, ${MAP_COLUMNS.updated_at}, ${MAP_COLUMNS.body}) VALUES (?, ?, ?, ?, ?)`;
    for (const collection of COLLECTIONS) {
      const bucket = (state[collection]??{}) as Record<string, Entity>;
      for (const rec of Object.values(bucket)) {
        sql.exec(insert, collection, rec.id, rec.revision, rec.updatedAt, JSON.stringify(rec));
      }
    }
    sql.exec('DELETE FROM events');
    for (const ev of state.events) {
      sql.exec('INSERT INTO events (seq, body) VALUES (?, ?)', ev.seq, JSON.stringify(ev));
    }
    sql.exec('DELETE FROM late_outputs');
    state.lateOutputs.forEach((lo, i) => {
      sql.exec('INSERT INTO late_outputs (seq, body) VALUES (?, ?)', i + 1, JSON.stringify(lo));
    });
    sql.exec(
      "INSERT INTO meta (k, v) VALUES ('stopped', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      state.stopped ? '1' : '0',
    );
  }

  private inTx<T>(fn: () => T): T {
    const storage = this.opts.storage;
    if (storage.transactionSync) return storage.transactionSync(fn);
    const sql = storage.sql;
    sql.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      sql.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        sql.exec('ROLLBACK');
      } catch {
        // Original error is authoritative; a failed rollback leaves the DO
        // transaction open and Cloudflare discards it with the object reset.
      }
      throw err;
    }
  }
}

function emptyState(project: ProjectState['project']): ProjectState {
  const state = {} as Record<string, unknown>;
  for (const collection of COLLECTIONS) state[collection] = {};
  return {
    project,
    ...(state as Omit<ProjectState, 'project' | 'events' | 'lateOutputs' | 'stopped'>),
    events: [],
    lateOutputs: [],
    stopped: false,
  };
}
