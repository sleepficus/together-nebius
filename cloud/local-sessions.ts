// Private local browser sessions, kept outside project state and exports.
// Only a token digest is persisted; the opaque token lives in the HttpOnly
// cookie. Local state restarts therefore do not require another token paste.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail } from '../lib/core.ts';

export const DEFAULT_LOCAL_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MAX_LOCAL_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSIONS = 64;

export interface LocalSessionRecord {
  sessionId: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
}

export function localSessionTtlSeconds(value?: number): number {
  const ttl = value ?? DEFAULT_LOCAL_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_LOCAL_SESSION_TTL_SECONDS) {
    throw new Error('local session duration must be between 1 second and 30 days');
  }
  return ttl;
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('invalid local session clock');
  return result;
}

/** A missing file uses an in-memory digest store for disposable local APIs. */
export class LocalSessionStore {
  private readonly memory = new Map<string, LocalSessionRecord>();
  private readonly db?: DatabaseSync;
  private closed = false;

  constructor(file?: string) {
    if (file === undefined) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      const handle = openSync(file, 'wx', 0o600);
      closeSync(handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!lstatSync(file).isFile()) throw new Error('local session database must be a regular file');
    }
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS owner_sessions (
        token_digest TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  create(token: string, ownerId: string, now: string, ttlSeconds: number): LocalSessionRecord {
    const ttl = localSessionTtlSeconds(ttlSeconds);
    const createdMs = timestamp(now);
    const record: LocalSessionRecord = {
      sessionId: randomUUID(), ownerId, createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(createdMs + ttl * 1000).toISOString(),
    };
    const key = digest(token);
    if (this.db === undefined) {
      for (const [id, session] of this.memory) {
        if (timestamp(session.expiresAt) <= createdMs) this.memory.delete(id);
      }
      if (this.memory.size >= MAX_SESSIONS) fail(429, 'session_limit', 'too many active sessions; end one first');
      this.memory.set(key, record);
      return record;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM owner_sessions WHERE expires_at <= ?').run(record.createdAt);
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM owner_sessions').get() as { count: number };
      if (count.count >= MAX_SESSIONS) fail(429, 'session_limit', 'too many active sessions; end one first');
      this.db.prepare(`INSERT INTO owner_sessions
        (token_digest, session_id, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(key, record.sessionId, ownerId, record.createdAt, record.expiresAt);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resolve(token: string, now: string): LocalSessionRecord | undefined {
    const nowMs = timestamp(now);
    const key = digest(token);
    let record: LocalSessionRecord | undefined;
    if (this.db === undefined) record = this.memory.get(key);
    else {
      const row = this.db.prepare(`SELECT session_id AS sessionId, owner_id AS ownerId,
        created_at AS createdAt, expires_at AS expiresAt FROM owner_sessions WHERE token_digest = ?`)
        .get(key) as unknown as LocalSessionRecord | undefined;
      record = row;
    }
    if (record === undefined) return undefined;
    if (timestamp(record.expiresAt) <= nowMs) {
      this.revoke(token);
      return undefined;
    }
    return record;
  }

  revoke(token: string): void {
    const key = digest(token);
    if (this.db === undefined) this.memory.delete(key);
    else this.db.prepare('DELETE FROM owner_sessions WHERE token_digest = ?').run(key);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db?.close();
    this.memory.clear();
  }
}
