// Frontend project controller for the Together slice (seat b-swe-09).
//
// Contract (BUILD-CONTRACT 09):
//   useProject(): UIController {
//     state: ProjectState, mode: 'sample'|'live',
//     action(type, payload?): Promise<any>,
//     projects: ProjectState[], activeProjectId: string,
//     selectProject(id): void, error: string|null, clearError(): void
//   }
//
// Store isolation: sample projects live ONLY under the sample localStorage
// key (SAMPLE_STORAGE_KEY). Live mode reads/writes the same-origin
// authenticated API only after the caller explicitly selects a live project
// id; sample records are never copied into live, and live state never
// touches the sample key. There is no implicit migration.
//
// Sample actions mutate sample records only. They simulate clearly:
// check jobs/receipts carry provenance:'sample' and collectorId
// 'sample-checker', shas use the 'sample-' prefix, and no sample action can
// mint a real runner receipt, a real 'integrated' landing or a
// 'verified-fixed' finding (derived states stay derived).
//
// The React hook is a thin subscription wrapper over
// createProjectController(); the engine is plain TypeScript so node:test
// can exercise it without a DOM. React is imported lazily so importing
// this module in a non-React test runner still works.

import { SAMPLE_STORAGE_KEY, makeSampleState } from './sample.ts';
import {readApiJson} from '../ui/api-json.ts';
import type {
  Assignment, Candidate, CheckJob, EvidenceReceipt, Finding, HelpRequest,
  HumanCategory, Id, IsoTime, ProjectState, Proposal, Review, Task,
} from '../../lib/types.ts';

const ReactModule: typeof import('react') | null = await import('react').catch(() => null);

export { SAMPLE_STORAGE_KEY };

export const ACTION_TYPES = [
  'create-project', 'create-task', 'claim-task', 'ask-help', 'answer-help',
  'submit-change', 'prepare-candidate', 'request-check', 'review-candidate',
  'report-finding', 'disposition-finding', 'save-layout', 'stop',
  'select-project', 'refresh',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface UIController {
  state: ProjectState;
  mode: 'sample' | 'live';
  action(type: string, payload?: unknown): Promise<unknown>;
  projects: ProjectState[];
  activeProjectId: string;
  selectProject(id: string): void;
  error: string | null;
  connectionUnavailable?: boolean;
  clearError(): void;
  /** Read work events only; never advances conversation cursors or starts agents. */
  pollEvents?(): Promise<{ resync: boolean; newEvents: number }>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ControllerOptions {
  /** localStorage-compatible store; default globalThis.localStorage. */
  storage?: StorageLike | null;
  /** fetch-compatible function for live mode; default globalThis.fetch. */
  fetcher?: ((input: string, init?: RequestInit) => Promise<Response>) | null;
  /** API base path; default '/api/v1'. */
  apiBase?: string;
  now?: () => IsoTime;
  uid?: () => Id;
}

const LEASE_MS = 10 * 60 * 1000;
const MAX_UNTIL_MS = 60 * 60 * 1000;

interface ActionResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

class Engine {
  private storage: StorageLike | null;
  private fetcher: ControllerOptions['fetcher'];
  private apiBase: string;
  private now: () => IsoTime;
  private uid: () => Id;
  private listeners = new Set<() => void>();
  private sampleCounter = 0;
  private eventsCursor = 0;
  private refreshSeq = 0;
  private needsFirstLiveProject = false;

  mode: 'sample' | 'live' = 'sample';
  activeProjectId: string;
  error: string | null = null;
  connectionUnavailable = false;

  private sampleProjects = new Map<Id, ProjectState>();
  private liveStates = new Map<Id, ProjectState>();
  private current: ProjectState;

  constructor(opts: ControllerOptions = {}) {
    this.storage = opts.storage !== undefined ? opts.storage : defaultStorage();
    this.fetcher = opts.fetcher !== undefined ? opts.fetcher : (globalThis.fetch?.bind(globalThis) ?? null);
    this.apiBase = opts.apiBase ?? '/api/v1';
    this.now = opts.now ?? (() => new Date().toISOString());
    let n = 0;
    this.uid = opts.uid ?? (() => `op-${Date.now().toString(36)}-${++n}`);

    const hadPersisted =
      this.storage !== null && this.storage.getItem(SAMPLE_STORAGE_KEY) !== null;
    for (const state of this.loadSamples()) this.sampleProjects.set(state.project.id, state);
    const first = this.sampleProjects.values().next().value as ProjectState;
    this.activeProjectId = first.project.id;
    this.current = first;
    // Persist the default sample once under the sample-only key so refresh
    // restores it; live state is never written here.
    if (!hadPersisted) this.persistSamples();
  }

  // -- plumbing -----------------------------------------------------------

  get state(): ProjectState {
    return this.current;
  }

  get projects(): ProjectState[] {
    return [...this.sampleProjects.values(), ...this.liveStates.values()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  clearError(): void {
    this.error = null;
    this.notify();
  }

  private setError(message: string): ActionResult {
    this.error = message;
    this.notify();
    return { ok: false, error: message };
  }

  private loadSamples(): ProjectState[] {
    if (this.storage === null) return [makeSampleState()];
    try {
      const raw = this.storage.getItem(SAMPLE_STORAGE_KEY);
      if (raw === null) return [makeSampleState()];
      const doc = JSON.parse(raw) as { version?: number; projects?: ProjectState[] };
      const projects = (doc.projects ?? []).filter(
        (s) => s?.project?.mode === 'sample' && typeof s.project.id === 'string',
      );
      return projects.length > 0 ? projects : [makeSampleState()];
    } catch {
      return [makeSampleState()];
    }
  }

  /** Sample-only persistence: live state is never written here. */
  private persistSamples(): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(
        SAMPLE_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          savedAt: this.now(),
          projects: [...this.sampleProjects.values()],
        }),
      );
    } catch {
      // Storage full/denied: sample still works in memory; never fall back
      // to writing anywhere else.
    }
  }

  private mutate(fn: (draft: ProjectState) => ActionResult): ActionResult {
    const draft = structuredClone(this.current);
    let result: ActionResult;
    try {
      result = fn(draft);
    } catch (err) {
      return this.setError(err instanceof Error ? err.message : 'action failed');
    }
    if (result.ok === false) return this.setError(result.error ?? 'action rejected');
    this.current = draft;
    if (this.mode === 'sample') {
      this.sampleProjects.set(draft.project.id, draft);
      this.persistSamples();
    } else {
      this.liveStates.set(draft.project.id, draft);
    }
    this.error = null;
    this.notify();
    return result;
  }

  private ev(
    draft: ProjectState,
    actorId: string,
    actorKind: 'human' | 'agent' | 'system',
    type: string,
    entityId?: Id,
    detail?: unknown,
    humanCategory?: HumanCategory,
  ): void {
    const last = draft.events[draft.events.length - 1];
    draft.events.push({
      id: this.uid(), projectId: draft.project.id, seq: (last?.seq ?? 0) + 1,
      createdAt: this.now(), actorId, actorKind, type,
      ...(entityId !== undefined ? { entityId } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(humanCategory !== undefined ? { humanCategory } : {}),
    });
  }

  // -- selection -----------------------------------------------------------

  selectProject(id: string): void {
    // Namespaced keys ('sample:<id>' / 'live:<id>') are unambiguous; a bare
    // id prefers a loaded sample project, then falls back to a live read.
    let want: 'sample' | 'live' | undefined;
    let bare = id;
    if (id.startsWith('sample:')) { want = 'sample'; bare = id.slice(7); }
    else if (id.startsWith('live:')) { want = 'live'; bare = id.slice(5); }
    if (want !== 'live') {
      const sample = this.sampleProjects.get(bare);
      if (sample !== undefined) {
        this.mode = 'sample';
        this.connectionUnavailable = false;
        this.activeProjectId = bare;
        this.current = sample;
        this.eventsCursor = sample.events[sample.events.length - 1]?.seq ?? 0;
        this.error = null;
        this.notify();
        return;
      }
      if (want === 'sample') {
        this.setError(`no sample project "${bare}"`);
        return;
      }
    }
    // Explicit live selection: same-origin authenticated read only.
    void this.selectLive(bare);
  }

  private async selectLive(id: string): Promise<void> {
    if (this.fetcher === null) {
      this.setError('live mode needs a fetch implementation');
      return;
    }
    try {
      const res = await this.fetcher(`${this.apiBase}/projects/${encodeURIComponent(id)}`, {
        method: 'GET', credentials: 'same-origin',
      });
      if (!res.ok) {
        const detail = await safeError(res);
        this.setError(`live project unavailable: ${detail}`);
        return;
      }
      const state = (await readApiJson(res)) as ProjectState;
      if (state?.project?.id !== id) {
        this.setError('live project response did not match the selected id');
        return;
      }
      // Mode pin: a live selection must adopt a live record. A sample-mode
      // (or foreign) response is rejected, not pinned as live.
      if (state.project.mode !== 'live') {
        this.setError(`live project "${id}" did not arrive in live mode`);
        return;
      }
      this.mode = 'live';
      this.connectionUnavailable = false;
      this.activeProjectId = id;
      this.current = state;
      this.liveStates.set(id, state);
      this.eventsCursor = state.events[state.events.length - 1]?.seq ?? 0;
      this.error = null;
      this.notify();
    } catch (err) {
      this.setError(err instanceof Error ? err.message : 'live select failed');
    }
  }

  /** Owner-only live project listing; returns summaries, not full states. */
  async listLiveProjects(): Promise<unknown[]> {
    if (this.fetcher === null) return [];
    try {
      const res = await this.fetcher(`${this.apiBase}/projects`, { method: 'GET', credentials: 'same-origin' });
      if (!res.ok) return [];
      const body = (await res.json()) as { projects?: unknown[] };
      return body.projects ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Cloud wiring: root global inbox across the owner's projects
   * (GET /api/v1/inbox). Passthrough only — it launches nothing, and a
   * failure is reported as null rather than fabricated data.
   */
  async globalInbox(opts: { after?: string; limit?: number } = {}): Promise<Record<string, unknown> | null> {
    if (this.fetcher === null) return null;
    try {
      const params = new URLSearchParams();
      if (opts.after !== undefined) params.set('after', opts.after);
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      const qs = params.size > 0 ? `?${params}` : '';
      const res = await this.fetcher(`${this.apiBase}/inbox${qs}`, {
        method: 'GET', credentials: 'same-origin',
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Live refresh through the event cursor: resync or new events pull state. */
  async pollEvents(): Promise<{ resync: boolean; newEvents: number }> {
    if (this.mode !== 'live' || this.fetcher === null) return { resync: false, newEvents: 0 };
    const pid = this.activeProjectId;
    try {
      const res = await this.fetcher(
        `${this.apiBase}/projects/${encodeURIComponent(pid)}/events?after=${this.eventsCursor}`,
        { method: 'GET', credentials: 'same-origin' },
      );
      if (this.mode !== 'live' || this.activeProjectId !== pid) return {resync:false,newEvents:0};
      if (!res.ok) { await this.refresh(); return {resync:true,newEvents:0}; }
      const body = await res.json() as {events?:{seq:number}[];nextCursor?:number;latestSeq?:number;resync?:boolean};
      if (this.mode !== 'live' || this.activeProjectId !== pid) return {resync:false,newEvents:0};
      const count = body.events?.length ?? 0;
      this.eventsCursor = body.resync && typeof body.latestSeq === 'number' ? body.latestSeq : body.nextCursor ?? this.eventsCursor;
      // A prior failed snapshot may already have consumed the work-event cursor.
      // Recovery must reread state even if no new write/event arrives.
      if (body.resync || count > 0 || this.connectionUnavailable) await this.refresh();
      return {resync:body.resync === true,newEvents:count};
    } catch {
      if (this.mode === 'live' && this.activeProjectId === pid) {this.connectionUnavailable=true;this.setError('Live updates unavailable. Saved work is retained.');}
      return {resync:true,newEvents:0};
    }
  }

  async refresh(): Promise<void> {
    if (this.mode !== 'live' || this.fetcher === null) return;
    // Stale responses must not clobber a newer selection or refresh.
    const seq = ++this.refreshSeq;
    const pid = this.activeProjectId;
    try {
      const res = await this.fetcher(
        `${this.apiBase}/projects/${encodeURIComponent(pid)}`,
        { method: 'GET', credentials: 'same-origin' },
      );
      if (seq !== this.refreshSeq || this.mode !== 'live' || this.activeProjectId !== pid) {
        return;
      }
      if (!res.ok) {
        this.connectionUnavailable = true;
        this.setError(`refresh failed: ${await safeError(res)}`);
        return;
      }
      const state = (await readApiJson(res)) as ProjectState;
      if (state?.project?.id === pid) {
        if (state.project.mode !== 'live') {
          this.connectionUnavailable = true;
          this.setError(`live refresh for "${pid}" did not arrive in live mode`);
          return;
        }
        this.current = state;
        this.liveStates.set(state.project.id, state);
        this.connectionUnavailable = false;
        this.error = null;
        this.notify();
      } else {
        this.connectionUnavailable = true;
        this.setError('Together could not read current project records. Last saved work is retained.');
      }
    } catch (err) {
      if (seq === this.refreshSeq) {
        this.connectionUnavailable = true;
        this.setError(err instanceof Error ? err.message : 'refresh failed');
      }
    }
  }

  // -- actions --------------------------------------------------------------

  async action(type: string, payload: unknown = {}): Promise<unknown> {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (type === 'connect-live') {
      if (!this.fetcher) return this.setError('Live connection is unavailable');
      const token = typeof p.token === 'string' ? p.token : '';
      const login = await this.fetcher(`${this.apiBase}/session`, {
        method: token ? 'POST' : 'GET',
        credentials: 'same-origin',
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      });
      if (!login.ok) throw new Error(await safeError(login));
      const listing=await readApiJson(await this.fetcher(`${this.apiBase}/projects`,{method:'GET',credentials:'same-origin'}));
      if(!Array.isArray(listing.projects))throw new Error('Together could not read your project list. Please try the connection again.');
      const rows = listing.projects as { id: string }[];
      this.needsFirstLiveProject = rows.length === 0;
      for (const row of rows) {
        const res = await this.fetcher(`${this.apiBase}/projects/${encodeURIComponent(row.id)}`, { method: 'GET', credentials: 'same-origin' });
        if (res.ok) {
          const state = await readApiJson(res) as ProjectState;
          if (state.project.mode === 'live' && state.project.id === row.id) this.liveStates.set(row.id, state);
        }
      }
      if (rows[0]) await this.selectLive(rows[0].id);
      if(rows[0]&&(this.mode!=='live'||this.activeProjectId!==rows[0].id||this.error))return {ok:false,error:this.error??'Live connection did not complete'};
      return { ok: true };
    }
    if (type === 'disconnect-live') {
      this.needsFirstLiveProject = false;
      await this.fetcher?.(`${this.apiBase}/session`, { method: 'DELETE', credentials: 'same-origin' });
      this.liveStates.clear();
      this.selectProject(`sample:${this.sampleProjects.keys().next().value}`);
      return { ok: true };
    }
    if (this.mode === 'live' || (type === 'create-project' && this.needsFirstLiveProject)) return this.liveAction(type, p);
    if (type === 'create-project') {
      if (typeof p.goal !== 'string' || p.goal.length === 0) return { ok: false, error: 'create-project needs a goal' };
      return this.createSampleProject(p.goal);
    }
    return this.sampleAction(type, p);
  }

  private async liveAction(type: string, p: Record<string, unknown>): Promise<unknown> {
    if (this.fetcher === null) return this.setError('live mode needs a fetch implementation');
    const id = this.activeProjectId;
    const base = `${this.apiBase}/projects/${encodeURIComponent(id)}`;
    const body: Record<string, unknown> = { operationId: this.uid(), ...p };
    let route: { method: string; path: string } | null = null;
    switch (type) {
      case 'create-project':
        route = { method: 'POST', path: `${this.apiBase}/projects` };
        break;
      case 'create-task':
        route = { method: 'POST', path: `${base}/tasks` };
        break;
      case 'claim-task':
        route = { method: 'POST', path: `${base}/tasks/${enc(p.taskId)}/assignments` };
        break;
      case 'ask-help':
        route = typeof p.taskId === 'string' && p.taskId.length > 0
          ? { method: 'POST', path: `${base}/tasks/${enc(p.taskId)}/help` }
          : { method: 'POST', path: `${base}/help` };
        break;
      case 'answer-help':
        route = { method: 'POST', path: `${base}/help/${enc(p.helpId)}/answer` };
        break;
      case 'submit-change':
        route = { method: 'POST', path: `${base}/changes` };
        break;
      case 'prepare-candidate':
        route = { method: 'POST', path: `${base}/candidates` };
        break;
      case 'request-check':
        route = { method: 'POST', path: `${base}/candidates/${enc(p.candidateId)}/checks` };
        if (body.command === undefined && this.current.project.defaultCheckCommand) body.command = this.current.project.defaultCheckCommand;
        if (body.expectedRevision === undefined && typeof p.candidateId === 'string') body.expectedRevision = this.current.candidates[p.candidateId]?.revision;
        break;
      case 'review-candidate':
        route = { method: 'POST', path: `${base}/candidates/${enc(p.candidateId)}/reviews` };
        if (body.expectedRevision === undefined && typeof p.candidateId === 'string') {
          body.expectedRevision = this.current.candidates[p.candidateId]?.revision;
        }
        break;
      case 'report-finding':
        route = { method: 'POST', path: `${base}/findings` };
        break;
      case 'disposition-finding':
        route = { method: 'POST', path: `${base}/findings/${enc(p.findingId)}/disposition` };
        if (body.disposition === undefined && typeof p.state === 'string') {
          body.disposition = p.state;
        }
        if (body.note === undefined) body.note = '';
        if (body.expectedRevision === undefined && typeof p.findingId === 'string') {
          body.expectedRevision = this.current.findings[p.findingId]?.revision;
        }
        break;
      case 'save-layout': {
        if (p.positions !== undefined && typeof p.positions === 'object' && p.positions !== null) {
          // Bulk layout save: one layout write per moved task.
          const entries = Object.entries(p.positions as Record<string, { x?: unknown; y?: unknown }>);
          try {
            for (const [taskId, pos] of entries) {
              const task = this.current.tasks[taskId];
              if (task === undefined || pos === null) continue;
              const res = await this.fetcher(`${base}/tasks/${enc(taskId)}/layout`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  operationId: this.uid(),
                  layout: { x: pos.x, y: pos.y },
                  expectedRevision: task.revision,
                }),
              });
              if (!res.ok) return this.setError(`action "save-layout" failed: ${await safeError(res)}`);
            }
          } catch (err) {
            return this.setError(err instanceof Error ? err.message : 'action "save-layout" failed');
          }
          await this.refresh();
          this.error = null;
          return { ok: true };
        }
        route = { method: 'POST', path: `${base}/tasks/${enc(p.taskId)}/layout` };
        if (body.expectedRevision === undefined && typeof p.taskId === 'string') {
          body.expectedRevision = this.current.tasks[p.taskId]?.revision;
        }
        break;
      }
      case 'stop':
        route = { method: 'POST', path: `${base}/stop` };
        if (body.expectedRevision === undefined) body.expectedRevision = this.current.project.revision;
        break;
      case 'select-project':
        if (typeof p.id === 'string') this.selectProject(p.id);
        return { ok: true };
      case 'refresh':
        await this.refresh();
        return { ok: this.error === null };
      default:
        return this.setError(`unknown action "${type}"`);
    }
    try {
      const res = await this.fetcher(route.path, {
        method: route.method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return this.setError(`action "${type}" failed: ${await safeError(res)}`);
      const parsed = await res.json().catch(() => ({}));
      this.error = null;
      if (type === 'create-project' && typeof parsed.project?.id === 'string') {
        await this.selectLive(parsed.project.id);
        if (this.error === null) this.needsFirstLiveProject = false;
      } else await this.refresh();
      if (this.error !== null) return { ok:false, error:this.error };
      return { ok: true, ...parsed, ...(type === 'create-project' ? { projectId:parsed.project?.id } : {}) };
    } catch (err) {
      return this.setError(err instanceof Error ? err.message : `action "${type}" failed`);
    }
  }

  private sampleAction(type: string, p: Record<string, unknown>): Promise<unknown> {
    const result = this.mutate((draft) => this.applySample(draft, type, p));
    return Promise.resolve(result);
  }

  private applySample(draft: ProjectState, type: string, p: Record<string, unknown>): ActionResult {
    const now = this.now();
    const actor = 'steve';
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    const bad = (error: string): ActionResult => ({ ok: false, error });
    const need = <T>(v: T | undefined, error: string): T => {
      if (v === undefined) throw new Error(error);
      return v;
    };

    switch (type) {
      case 'create-project': {
        const goal = need(str(p.goal), 'create-project needs a goal');
        // Mutations happen outside mutate() scope -- handled by caller below.
        return { ok: true, __createProject: { goal } };
      }
      case 'create-task': {
        const goal = need(str(p.goal), 'create-task needs a goal');
        const dependencies = parseDependencies(draft, p.dependencies);
        const task: Task = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: actor,
          goal, acceptanceCriteria: stringArray(p.acceptanceCriteria),
          dependencies, lifecycle: 'open', resultRefs: [],
          nextAction: 'Unclaimed -- available work',
        };
        draft.tasks[task.id] = task;
        this.ev(draft, actor, 'human', 'task:created', task.id, { sample: true, goal });
        return { ok: true, taskId: task.id };
      }
      case 'claim-task': {
        const task = need(draft.tasks[str(p.taskId) ?? ''], 'claim-task needs a taskId in this project');
        // Candidate ids are system records and can never be claimed: they are
        // simply absent from the tasks collection.
        const identityId = str(p.identityId) ?? 'agent-wren';
        const epoch = 1 + Math.max(0, ...Object.values(draft.assignments)
          .filter((a) => a.taskId === task.id).map((a) => a.epoch));
        const assignment: Assignment = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: identityId,
          taskId: task.id, identityId, role: str(p.role) ?? 'builder',
          scopes: ['read', 'tasks:write'], epoch,
          leaseExpiresAt: new Date(Date.parse(now) + LEASE_MS).toISOString(),
          maxUntil: new Date(Date.parse(now) + MAX_UNTIL_MS).toISOString(),
          status: 'active',
        };
        draft.assignments[assignment.id] = assignment;
        task.currentAssignmentId = assignment.id;
        task.lifecycle = 'claimed';
        task.updatedAt = now;
        task.revision += 1;
        task.nextAction = 'Claimed (sample) -- waiting for a proposal';
        this.ev(draft, identityId, 'agent', 'assignment:claimed', assignment.id, {
          taskId: task.id, epoch, sample: true,
        });
        return { ok: true, assignmentId: assignment.id, epoch };
      }
      case 'ask-help': {
        const taskId = str(p.taskId);
        const task = taskId === undefined ? undefined : need(draft.tasks[taskId], 'ask-help needs a taskId');
        const question = need(str(p.question), 'ask-help needs a question');
        const help: HelpRequest = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: actor,
          ...(task !== undefined ? { taskId: task.id } : {}), question,
          ...(str(p.expectedContribution) !== undefined
            ? { expectedContribution: str(p.expectedContribution) }
            : {}),
          offeredById: actor, state: 'offered',
        };
        draft.help[help.id] = help;
        this.ev(draft, actor, 'human', 'help:offered', help.id,
          { ...(task !== undefined ? { taskId: task.id } : {}), sample: true });
        return { ok: true, helpId: help.id };
      }
      case 'answer-help': {
        const help = need(draft.help[str(p.helpId) ?? ''], 'answer-help needs a helpId');
        const answer = need(str(p.answer), 'answer-help needs an answer');
        help.answer = answer;
        help.acceptedById = actor;
        help.state = 'answered';
        help.revision += 1;
        help.updatedAt = now;
        this.ev(draft, actor, 'human', 'help:answered', help.id, { sample: true }, 'relay');
        return { ok: true, helpId: help.id };
      }
      case 'submit-change': {
        const summary = need(str(p.summary), 'submit-change needs a summary');
        const taskIds = stringArray(p.taskIds);
        for (const tid of taskIds) need(draft.tasks[tid], `unknown task ${tid}`);
        this.sampleCounter += 1;
        const head = str(p.head) ?? `sample-head-${this.sampleCounter}`;
        const proposal: Proposal = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: actor,
          taskIds, authorId: str(p.authorId) ?? 'agent-wren',
          base: str(p.base) ?? 'sample-base-aaaa', head,
          summary, intendedBehavior: str(p.intendedBehavior) ?? summary,
          changedPaths: stringArray(p.changedPaths),
          evidenceRefs: stringArray(p.evidenceRefs), unknowns: stringArray(p.unknowns),
          lifecycle: 'submitted',
        };
        draft.proposals[proposal.id] = proposal;
        this.ev(draft, proposal.authorId, 'agent', 'proposal:submitted', proposal.id, {
          head, sample: true,
        });
        this.ev(draft, 'sample-system', 'system', 'commit:observed', proposal.id, {
          sha: head, role: 'fork', ref: 'sample-fork', sample: true,
        });
        return { ok: true, proposalId: proposal.id, head };
      }
      case 'prepare-candidate': {
        const ids = stringArray(p.proposalIds);
        const picked = (ids.length > 0 ? ids : Object.values(draft.proposals)
          .filter((x) => x.lifecycle === 'submitted').map((x) => x.id));
        if (picked.length === 0) return bad('no submitted proposals to combine');
        const heads: Record<Id, string> = {};
        for (const pid of picked) {
          const proposal = need(draft.proposals[pid], `unknown proposal ${pid}`);
          heads[pid] = proposal.head;
        }
        this.sampleCounter += 1;
        const candidate: Candidate = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: 'sample-system',
          base: 'sample-base-aaaa', proposalIds: picked, proposalHeads: heads,
          sha: `sample-cand-${String(this.sampleCounter).padStart(4, '0')}`,
          policyVersion: draft.project.acceptancePolicyRevision,
          status: 'prepared', checkJobIds: [], reviewIds: [],
        };
        draft.candidates[candidate.id] = candidate;
        this.ev(draft, 'sample-system', 'system', 'candidate:prepared', candidate.id, {
          sha: candidate.sha, proposalIds: picked, sample: true,
        });
        return { ok: true, candidateId: candidate.id, sha: candidate.sha };
      }
      case 'request-check': {
        const candidate = need(draft.candidates[str(p.candidateId) ?? ''], 'request-check needs a candidateId');
        const commandText = str(p.command) ?? 'npm test';
        const outcome = p.outcome === 'fail' ? 'fail' : 'pass';
        this.sampleCounter += 1;
        const job: CheckJob = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: 'sample-checker',
          candidateId: candidate.id, candidateSha: candidate.sha, command: commandText,
          status: 'completed', deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
          dedupeKey: `sample:check:${this.sampleCounter}`,
        };
        const receipt: EvidenceReceipt = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: 'sample-checker',
          jobId: job.id, candidateSha: candidate.sha, collectorId: 'sample-checker',
          command: commandText, outcome, artifactRefs: [],
        };
        (job as Record<string, unknown>).provenance = 'sample';
        (job as Record<string, unknown>).receiptId = receipt.id;
        (receipt as Record<string, unknown>).provenance = 'sample';
        draft.jobs[job.id] = job;
        draft.receipts[receipt.id] = receipt;
        candidate.checkJobIds.push(job.id);
        let findingId: Id | undefined;
        if (outcome === 'fail') {
          candidate.status = 'failed';
          const finding: Finding = {
            id: this.uid(), projectId: draft.project.id, revision: 1,
            createdAt: now, updatedAt: now, actorId: 'sample-checker',
            candidateId: candidate.id, candidateSha: candidate.sha,
            expected: str(p.expected) ?? 'sample check passes',
            observed: str(p.observed) ?? `sample check "${commandText}" failed`,
            state: 'reproduced', originatorId: 'sample-checker', receiptIds: [receipt.id],
          };
          (finding as Record<string, unknown>).provenance = 'sample';
          draft.findings[finding.id] = finding;
          findingId = finding.id;
        } else {
          candidate.status = 'prepared';
          // A sample pass never derives verified-fixed: if a finding id was
          // supplied, record the sample limitation on it instead.
          const fid = str(p.findingId);
          if (fid !== undefined && draft.findings[fid] !== undefined) {
            const finding = draft.findings[fid];
            finding.note = `${finding.note ?? ''}\nsample pass -- verified fixed requires authenticated collector receipts`.trim();
            finding.revision += 1;
            finding.updatedAt = now;
          }
        }
        candidate.revision += 1;
        candidate.updatedAt = now;
        this.ev(draft, 'sample-checker', 'system', 'check:completed', job.id, {
          receiptId: receipt.id, outcome, sample: true,
        });
        return { ok: true, jobId: job.id, receiptId: receipt.id, outcome, findingId };
      }
      case 'review-candidate': {
        const candidate = need(draft.candidates[str(p.candidateId) ?? ''], 'review-candidate needs a candidateId');
        const disposition = str(p.disposition);
        if (disposition !== 'approve' && disposition !== 'request-changes' && disposition !== 'comment') {
          return bad('disposition must be approve, request-changes or comment');
        }
        const review: Review = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: actor,
          candidateId: candidate.id, candidateSha: candidate.sha, reviewerId: actor,
          policyVersion: candidate.policyVersion, disposition,
          independent: false, independenceReason: 'sample-review-simulated',
          findingIds: stringArray(p.findingIds),
        };
        (review as Record<string, unknown>).provenance = 'sample';
        draft.reviews[review.id] = review;
        candidate.reviewIds.push(review.id);
        candidate.revision += 1;
        candidate.updatedAt = now;
        this.ev(draft, actor, 'human', 'candidate:reviewed', candidate.id, {
          reviewId: review.id, disposition, sample: true,
        }, disposition === 'approve' ? 'approve' : 'other');
        return { ok: true, reviewId: review.id };
      }
      case 'report-finding': {
        const expected = need(str(p.expected), 'report-finding needs expected');
        const observed = need(str(p.observed), 'report-finding needs observed');
        const candidateId = str(p.candidateId);
        const candidate = candidateId !== undefined ? draft.candidates[candidateId] : undefined;
        if (candidateId !== undefined && candidate === undefined) return bad('unknown candidateId');
        const finding: Finding = {
          id: this.uid(), projectId: draft.project.id, revision: 1,
          createdAt: now, updatedAt: now, actorId: actor,
          ...(candidate !== undefined ? { candidateId: candidate.id, candidateSha: candidate.sha } : {}),
          expected, observed,
          ...(str(p.reproducer) !== undefined ? { reproducer: str(p.reproducer) } : {}),
          ...(str(p.severity) !== undefined ? { severity: str(p.severity) } : {}),
          state: 'possible-issue', originatorId: actor, receiptIds: [],
        };
        (finding as Record<string, unknown>).provenance = 'sample';
        draft.findings[finding.id] = finding;
        this.ev(draft, actor, 'human', 'finding:reported', finding.id, { sample: true });
        return { ok: true, findingId: finding.id };
      }
      case 'disposition-finding': {
        const finding = need(draft.findings[str(p.findingId) ?? ''], 'disposition-finding needs a findingId');
        const disposition = str(p.state) ?? str(p.disposition);
        const note = str(p.note) ?? '';
        if (disposition !== 'not-reproduced' && disposition !== 'withdrawn') {
          return bad(`"${disposition ?? ''}" is derived from collector evidence, not set by disposition`);
        }
        finding.state = disposition;
        finding.note = `${finding.note ?? ''}\n${note}`.trim();
        finding.revision += 1;
        finding.updatedAt = now;
        this.ev(draft, actor, 'human', 'finding:disposition', finding.id, {
          to: disposition, sample: true,
        }, 'other');
        return { ok: true, findingId: finding.id };
      }
      case 'save-layout': {
        if (p.positions !== undefined && typeof p.positions === 'object' && p.positions !== null) {
          // Bulk save from the flow canvas: { taskId: {x, y} } entries.
          let moved = 0;
          for (const [taskId, pos] of Object.entries(p.positions as Record<string, { x?: unknown; y?: unknown }>)) {
            const task = draft.tasks[taskId];
            if (task === undefined || pos === null) continue;
            const x = Number(pos.x);
            const y = Number(pos.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return bad('positions entries need numeric x and y');
            task.layout = { x, y };
            task.revision += 1;
            task.updatedAt = now;
            moved += 1;
          }
          this.ev(draft, actor, 'human', 'project:layout-saved', draft.project.id,
            { moved, sample: true });
          return { ok: true, moved };
        }
        const task = need(draft.tasks[str(p.taskId) ?? ''], 'save-layout needs a taskId');
        const x = Number(p.x);
        const y = Number(p.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return bad('x and y must be numbers');
        task.layout = { x, y };
        task.revision += 1;
        task.updatedAt = now;
        this.ev(draft, actor, 'human', 'task:layout-saved', task.id, { x, y, sample: true });
        return { ok: true };
      }
      case 'stop': {
        draft.stopped = true;
        this.ev(draft, actor, 'human', 'project:stopped', draft.project.id, { sample: true }, 'other');
        return { ok: true, stopped: true };
      }
      case 'select-project': {
        if (typeof p.id === 'string') this.selectProject(p.id);
        return { ok: true };
      }
      case 'refresh':
        return { ok: true };
      default:
        return bad(`unknown action "${type}"`);
    }
  }

  /** create-project needs a new state, not a mutation of the current one. */
  private createSampleProject(goal: string): ActionResult {
    const id = `sample-project-${this.sampleProjects.size + 1}`;
    const state = makeSampleState();
    state.project.id = id;
    state.project.projectId = id;
    state.project.goal = goal;
    for (const bucket of [
      'members', 'sessions', 'identities', 'tasks', 'assignments', 'help', 'messages',
      'proposals', 'candidates', 'jobs', 'receipts', 'reviews', 'findings',
    ] as const) {
      for (const rec of Object.values(state[bucket] as Record<string, { projectId: string }>)) {
        rec.projectId = id;
      }
    }
    for (const ev of state.events) ev.projectId = id;
    this.sampleProjects.set(id, state);
    this.persistSamples();
    this.selectProject(id);
    return { ok: true, projectId: id };
  }
}

function enc(v: unknown): string {
  return encodeURIComponent(typeof v === 'string' ? v : '');
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

async function safeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return `${res.status} ${body.error?.code ?? 'error'}: ${body.error?.message ?? res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function parseDependencies(
  draft: ProjectState,
  value: unknown,
): { taskId: Id; kind: 'prerequisite' | 'contributes-changes' }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('dependencies must be an array');
  const deps = value.map((d) => {
    const o = d as { taskId?: unknown; kind?: unknown };
    if (typeof o.taskId !== 'string') throw new Error('dependency needs taskId');
    if (o.kind !== 'prerequisite' && o.kind !== 'contributes-changes') {
      throw new Error('dependency kind must be prerequisite or contributes-changes');
    }
    if (draft.tasks[o.taskId] === undefined) throw new Error(`unknown dependency task ${o.taskId}`);
    const kind: 'prerequisite' | 'contributes-changes' =
      o.kind === 'prerequisite' ? 'prerequisite' : 'contributes-changes';
    return { taskId: o.taskId, kind };
  });
  return deps;
}

export function createProjectController(opts: ControllerOptions = {}): UIController {
  const engine = new Engine(opts);
  const controller: UIController & {
    subscribe(fn: () => void): () => void;
    refresh(): Promise<void>;
    pollEvents(): Promise<{ resync: boolean; newEvents: number }>;
    listLiveProjects(): Promise<unknown[]>;
    globalInbox(opts?: { after?: string; limit?: number }): Promise<Record<string, unknown> | null>;
  } = {
    get state() { return engine.state; },
    get mode() { return engine.mode; },
    get projects() { return engine.projects; },
    get activeProjectId() { return engine.activeProjectId; },
    get error() { return engine.error; },
    get connectionUnavailable() { return engine.connectionUnavailable; },
    action: (type, payload) => engine.action(type, payload),
    selectProject: (id) => engine.selectProject(id),
    clearError: () => engine.clearError(),
    subscribe: (fn) => engine.subscribe(fn),
    refresh: () => engine.refresh(),
    pollEvents: () => engine.pollEvents(),
    listLiveProjects: () => engine.listLiveProjects(),
    globalInbox: (opts) => engine.globalInbox(opts),
  };

  return controller;
}

/**
 * React binding over createProjectController. The engine is stable; a
 * subscription bumps a state tick so components re-read controller.state.
 * Throws a clear error when React is unavailable (domain tests use
 * createProjectController directly).
 */
export function useProject(options: ControllerOptions = {}): UIController {
  if (ReactModule === null) {
    throw new Error('useProject requires react; use createProjectController() outside React');
  }
  const ref = ReactModule.useRef<UIController | null>(null);
  if (ref.current === null) ref.current = createProjectController(options);
  const [, setTick] = ReactModule.useState(0);
  ReactModule.useEffect(() => {
    const c = ref.current as unknown as { subscribe(fn: () => void): () => void };
    return c.subscribe(() => setTick((t) => t + 1));
  }, []);
  return ref.current;
}
