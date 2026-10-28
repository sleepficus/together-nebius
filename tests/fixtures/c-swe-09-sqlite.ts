// Test fixture (c-swe-09): in-memory emulation of the exact SQL surface
// that lib/store.ts SQLiteStore uses on a Durable Object, plus the
// CloudObjectState wrapper shape from cloud/phase04-contract.ts. This is a
// unit-test fixture for lane-09-owned composition code — it is not a
// production stand-in and never runs inside the worker.

interface Row { [k: string]: unknown }

export interface FakeTables {
  project: Map<string, string>;          // id -> body
  entities: Map<string, Row>;            // `${collection}|${id}` -> {collection,id,body}
  events: Map<number, string>;           // seq -> body
  lateOutputs: Map<number, string>;      // seq -> body
  meta: Map<string, string>;             // k -> v
}

export function createFakeSqlStorage() {
  const tables: FakeTables = {
    project: new Map(),
    entities: new Map(),
    events: new Map(),
    lateOutputs: new Map(),
    meta: new Map(),
  };

  const exec = (query: string, ...params: unknown[]): { toArray(): Row[] } => {
    const q = query.trim();
    const rows = (rs: Row[] = []) => ({ toArray: () => rs });

    if (q.startsWith('CREATE TABLE')||q.startsWith('CREATE INDEX')||q.startsWith('CREATE UNIQUE INDEX')) return rows(); // Schema-only fixture; chat SQL is verified with real SQLite in phase05 tests.
    if (q === 'BEGIN IMMEDIATE' || q === 'COMMIT' || q === 'ROLLBACK') return rows();

    if (q === 'SELECT id FROM project WHERE id = ?') {
      const id = String(params[0]);
      return rows(tables.project.has(id) ? [{ id }] : []);
    }
    if (q === 'SELECT body FROM project WHERE id = ?') {
      const body = tables.project.get(String(params[0]));
      return rows(body === undefined ? [] : [{ body }]);
    }
    if (q.startsWith('INSERT INTO project')) {
      tables.project.set(String(params[0]), String(params[1]));
      return rows();
    }
    if (q === 'DELETE FROM entities') { tables.entities.clear(); return rows(); }
    if (q.startsWith('INSERT INTO entities')) {
      const [collection, id, , , body] = params.map(String);
      tables.entities.set(`${collection}|${id}`, { collection, id, body });
      return rows();
    }
    if (q === 'SELECT collection, body FROM entities') {
      return rows([...tables.entities.values()].map((r) => ({ collection: r.collection, body: r.body })));
    }
    if (q === 'DELETE FROM events') { tables.events.clear(); return rows(); }
    if (q.startsWith('INSERT INTO events')) {
      tables.events.set(Number(params[0]), String(params[1]));
      return rows();
    }
    if (q === 'SELECT body FROM events ORDER BY seq ASC') {
      return rows([...tables.events.entries()].sort((a, b) => a[0] - b[0]).map(([, body]) => ({ body })));
    }
    if (q === 'DELETE FROM late_outputs') { tables.lateOutputs.clear(); return rows(); }
    if (q.startsWith('INSERT INTO late_outputs')) {
      tables.lateOutputs.set(Number(params[0]), String(params[1]));
      return rows();
    }
    if (q === 'SELECT body FROM late_outputs ORDER BY seq ASC') {
      return rows([...tables.lateOutputs.entries()].sort((a, b) => a[0] - b[0]).map(([, body]) => ({ body })));
    }
    if (q === `SELECT v FROM meta WHERE k = 'stopped'`) {
      const v = tables.meta.get('stopped');
      return rows(v === undefined ? [] : [{ v }]);
    }
    if (q.startsWith('INSERT INTO meta')) {
      tables.meta.set('stopped', String(params[0]));
      return rows();
    }
    throw new Error(`fake sqlite: unsupported query: ${q}`);
  };

  const snapshot = (): FakeTables => ({
    project: new Map(tables.project),
    entities: new Map([...tables.entities].map(([k, v]) => [k, { ...v }])),
    events: new Map(tables.events),
    lateOutputs: new Map(tables.lateOutputs),
    meta: new Map(tables.meta),
  });
  const restore = (snap: FakeTables) => {
    tables.project = snap.project; tables.entities = snap.entities;
    tables.events = snap.events; tables.lateOutputs = snap.lateOutputs;
    tables.meta = snap.meta;
  };

  // DurableObjectStorageLike + minimal CloudStorage kv surface.
  const storage = {
    sql: { exec },
    transactionSync<T>(fn: () => T): T {
      const snap = snapshot();
      try {
        exec('BEGIN IMMEDIATE');
        const out = fn();
        exec('COMMIT');
        return out;
      } catch (err) {
        exec('ROLLBACK');
        restore(snap);
        throw err;
      }
    },
    // Minimal KV side of the contract (unused by SQLiteStore).
    kv: new Map<string, unknown>(),
    async get<T>(key: string) { return this.kv.get(key) as T | undefined; },
    async put(key: string, value: unknown) { this.kv.set(key, value); },
    async delete(key: string) { this.kv.delete(key); },
    async list() { return this.kv; },
    async transaction<T>(fn: () => T | Promise<T>) { return fn(); },
  };

  return { tables, storage };
}

/** CloudObjectState fixture for ProjectObject tests. */
export function fakeObjectState(projectId: string) {
  const { storage } = createFakeSqlStorage();
  return {
    id: { name: projectId, toString: () => projectId },
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown> | unknown) => { void fn(); },
  };
}
