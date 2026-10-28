/// <reference types="node" />
// Shared Together API client for the CLI and MCP adapters (seat b-swe-06).
//
// One transport, one job: keep the plumbing out of the agent's way.
// Reads index entity revisions and assignment epochs; every write is
// filled automatically with operationId (fresh UUID), expectedRevision and
// assignmentEpoch from the last read. A stale response (409) is returned
// to the caller verbatim — the client NEVER silently refreshes and replays
// a consequential action. Re-reading is the caller's deliberate choice.
//
// Configuration is Together-scoped only: TOGETHER_BASE_URL,
// TOGETHER_TOKEN (the platform credential minted at enrollment, never a
// provider key) and TOGETHER_PROJECT_ID. Provider/model auth stays with
// the native harness; this client does not read provider env vars.

export const ENV = {
  baseUrl: 'TOGETHER_BASE_URL',
  token: 'TOGETHER_TOKEN',
  projectId: 'TOGETHER_PROJECT_ID',
} as const;

export const ENV_VARS: readonly string[] = [ENV.baseUrl, ENV.token, ENV.projectId];

export interface ClientConfig {
  baseUrl: string;
  token: string;
  projectId: string;
  fetchFn?: typeof fetch;
  /** Adapter-owned redactor covers rotated credentials as well as the current one. */
  redact?: (text: string) => string;
}

export class ClientConfigError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(`missing Together client configuration: ${missing.join(', ')}`);
    this.name = 'ClientConfigError';
    this.missing = missing;
  }
}

/**
 * Build a client from environment variables. Reads ONLY the TOGETHER_*
 * variables listed in ENV_VARS — nothing else in the environment is
 * touched, so a scoped credential can never be confused with a provider
 * key.
 */
export function clientFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchFn?: typeof fetch,
): TogetherClient {
  const missing = ENV_VARS.filter((name) => {
    const v = env[name];
    return v === undefined || v === '';
  });
  if (missing.length > 0) throw new ClientConfigError(missing);
  return new TogetherClient({
    baseUrl: env[ENV.baseUrl] as string,
    token: env[ENV.token] as string,
    projectId: env[ENV.projectId] as string,
    fetchFn,
  });
}

export interface ApiErrorBody {
  status?: number;
  code?: string;
  message?: string;
  retryable?: boolean;
  nextAction?: string;
}

/** Every call resolves to this shape; the adapter decides what to show. */
export interface ApiResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  error?: ApiErrorBody;
  /** True when the server reported a stale write (409). No retry was made. */
  stale: boolean;
}

/** Connection status per the connection research: three separate checks,
 *  only the first of which this client can observe. */
export interface ConnectionStatus {
  platform: 'connected' | 'unauthenticated' | 'unreachable' | 'denied';
  providerAuth: 'unknown';
  inference: 'unknown';
  note: string;
}

interface EntityLike {
  id?: string;
  revision?: number;
  epoch?: number;
  taskId?: string;
}

export class TogetherClient {
  redact(text: string): string {
    return this.config.redact ? this.config.redact(text) : this.config.token ? text.replaceAll(this.config.token, '[credential redacted]') : text;
  }
  readonly config: ClientConfig;
  private readonly fetchFn: typeof fetch;
  /** 'collection/id' -> last observed revision. */
  readonly revisions = new Map<string, number>();
  /** assignmentId -> last observed epoch. */
  readonly epochs = new Map<string, number>();
  /** messageId -> taskId link from reads, for offer acceptance plumbing. */
  readonly messageTasks = new Map<string, string>();
  lastInboxCursor: string | null = null;
  lastPlanRevisionId: string | undefined;

  constructor(config: ClientConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private apiUrl(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    return `${base}/api/v1/projects/${encodeURIComponent(this.config.projectId)}${path}`;
  }

  private async call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    ordinaryWork = false,
  ): Promise<ApiResult> {
    let res: Response;
    try {
      res = await this.fetchFn(this.apiUrl(path), {
        method,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(ordinaryWork?{'x-together-work-profile':'ordinary'}:{}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: {},
        stale: false,
        error: {
          status: 0,
          code: 'unreachable',
          message: err instanceof Error ? err.message : 'request failed',
          retryable: true,
          nextAction: 'check the host and base URL, then retry deliberately',
        },
      };
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await res.json()) as Record<string, unknown>;
      if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('invalid response');
    } catch {
      return {ok:false,status:res.status,body:{},stale:res.status===409,error:{status:res.status,code:'invalid_response',message:'Together returned an unreadable response; outcome is unconfirmed.',retryable:false,nextAction:'Re-read current state before deliberately retrying. Reuse clientRequestId for the same post.'}};
    }
    if (res.status >= 200 && res.status < 300) {
      this.indexBody(parsed);
      return { ok: true, status: res.status, body: parsed, stale: false };
    }
    const error = (parsed.error ?? {}) as ApiErrorBody;
    return {
      ok: false,
      status: res.status,
      body: parsed,
      stale: res.status === 409,
      error: {
        status: error.status ?? res.status,
        code: error.code ?? 'error',
        message: error.message ?? `request failed with ${res.status}`,
        retryable: error.retryable,
        nextAction: error.nextAction,
      },
    };
  }

  /** Index revisions/epochs from any response body that carries records. */
  private indexBody(body: Record<string, unknown>): void {
    if (Object.hasOwn(body, 'planRevisionId')) this.lastPlanRevisionId = typeof body.planRevisionId==='string'?body.planRevisionId:undefined;
    const mark = (collection: string, rec: unknown): void => {
      const e = rec as EntityLike | undefined;
      if (e && typeof e.id === 'string' && typeof e.revision === 'number') {
        this.revisions.set(`${collection}/${e.id}`, e.revision);
      }
      if (collection === 'assignments' && e && typeof e.epoch === 'number') {
        this.epochs.set(e.id as string, e.epoch);
      }
      if (collection === 'messages' && e && typeof e.taskId === 'string') {
        this.messageTasks.set(e.id as string, e.taskId);
      }
    };
    const walk = (collection: string, value: unknown): void => {
      if (Array.isArray(value)) value.forEach((v) => mark(collection, v));
      else if (value && typeof value === 'object') mark(collection, value);
    };
    if (typeof body.revision === 'number' && typeof body.id === 'string') {
      this.revisions.set('project', body.revision);
    }
    for (const [key, collection] of [
      ['task', 'tasks'], ['tasks', 'tasks'],
      ['assignment', 'assignments'], ['assignments', 'assignments'],
      ['message', 'messages'], ['messages', 'messages'],
      ['help', 'help'], ['handoff', 'handoffs'], ['handoffs', 'handoffs'],
      ['project', 'project'],
    ] as const) {
      if (key in body) walk(collection, body[key]);
    }
    // Whole-state reads carry collections as keyed maps.
    for (const collection of ['tasks', 'assignments', 'messages', 'help'] as const) {
      const bucket = body[collection];
      if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
        for (const rec of Object.values(bucket as Record<string, unknown>)) {
          mark(collection, rec);
        }
      }
    }
  }

  revisionOf(collection: string, id: string): number | undefined {
    return this.revisions.get(`${collection}/${id}`);
  }

  epochOf(assignmentId: string): number | undefined {
    return this.epochs.get(assignmentId);
  }

  /** Fresh idempotency key per write; revisions/epochs from last read. */
  plumbing(target?: { collection: string; id: string }, assignmentId?: string): Record<string, unknown> {
    const out: Record<string, unknown> = { operationId: crypto.randomUUID() };
    const rev = target ? this.revisionOf(target.collection, target.id) : undefined;
    if (rev !== undefined) out.expectedRevision = rev;
    const epoch = assignmentId ? this.epochOf(assignmentId) : undefined;
    if (epoch !== undefined) out.assignmentEpoch = epoch;
    return out;
  }

  /** Shared API transport; only the explicit MCP catalog chooses paths. */
  workRequest(method:string,path:string,body?:Record<string,unknown>):Promise<ApiResult>{return this.call(method,path,body,true);}

  // ------------------------------------------------------------- reads --

  refresh(): Promise<ApiResult> {
    return this.call('GET', '');
  }

  brief(taskId?: string): Promise<ApiResult> {
    return this.call('GET', `/brief${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);
  }

  attention(armId:string):Promise<ApiResult>{return this.call('GET','/attention?armId='+encodeURIComponent(armId));}
  attentionHeartbeat(armId:string,ack?:number):Promise<ApiResult>{return this.call('POST','/attention/heartbeat',{armId,...(ack===undefined?{}:{ack})});}
  attentionStop(armId:string):Promise<ApiResult>{return this.call('POST','/attention/stop',{armId});}
  contextBrief(taskId?: string): Promise<ApiResult> {
    return this.call('GET', `/context-brief${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`);
  }

  conversations(): Promise<ApiResult> { return this.call('GET', '/conversations'); }

  conversation(channel: string, opts?: {after?: number; limit?: number}): Promise<ApiResult> {
    const q = new URLSearchParams();
    if (opts?.after !== undefined) q.set('after', String(opts.after));
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    return this.call('GET', `/conversations/${encodeURIComponent(channel)}?${q}`);
  }

  postMessage(channel: string, body: string, clientRequestId: string, metadata?:{mentionIds?:string[];replyToId?:string}): Promise<ApiResult> {
    // Caller retains this ID across lost responses. Never create a new ID on retry.
    return this.call('POST', `/conversations/${encodeURIComponent(channel)}/messages`, {body, clientRequestId,...metadata});
  }

  acknowledgeConversation(channel: string, seq: number): Promise<ApiResult> {
    return this.call('POST', `/conversations/${encodeURIComponent(channel)}/opened`, {seq});
  }

  inbox(opts?: { after?: string; limit?: number }): Promise<ApiResult> {
    const params = new URLSearchParams();
    const after = opts?.after ?? this.lastInboxCursor ?? undefined;
    if (after) params.set('after', after);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    return this.call('GET', `/inbox${params.size > 0 ? `?${params}` : ''}`).then((r) => {
      if (r.ok && typeof r.body.nextCursor === 'string') {
        this.lastInboxCursor = r.body.nextCursor;
      }
      return r;
    });
  }

  tasks(opts?: { state?: string; cursor?: string }): Promise<ApiResult> {
    const params = new URLSearchParams();
    if (opts?.state) params.set('state', opts.state);
    if (opts?.cursor) params.set('cursor', opts.cursor);
    return this.call('GET', `/tasks${params.size > 0 ? `?${params}` : ''}`);
  }

  helpList(state?: string): Promise<ApiResult> {
    return this.call('GET', `/help${state ? `?state=${encodeURIComponent(state)}` : ''}`);
  }

  operation(id: string): Promise<ApiResult> {
    return this.call('GET', `/operations/${encodeURIComponent(id)}`);
  }

  // ------------------------------------------------------------ writes --

  createTask(fields: Record<string, unknown>): Promise<ApiResult> {
    return this.call('POST', '/tasks', { ...this.plumbing(), ...fields });
  }

  claimTask(taskId: string, opts?: { role?: string; scopes?: string[] }): Promise<ApiResult> {
    return this.call('POST', `/tasks/${encodeURIComponent(taskId)}/assignments`, {
      ...this.plumbing({ collection: 'tasks', id: taskId }),
      ...(opts?.role !== undefined ? { role: opts.role } : {}),
      ...(opts?.scopes !== undefined ? { scopes: opts.scopes } : {}),
    });
  }

  offer(
    taskId: string,
    fields: { toId: string; role?: string; scopes?: string[]; ttlMs?: number; note?: string },
  ): Promise<ApiResult> {
    return this.call('POST', `/tasks/${encodeURIComponent(taskId)}/offers`, {
      ...this.plumbing(),
      ...fields,
    });
  }

  askHelp(
    taskId: string,
    fields: { question: string; toId?: string; expectedContribution?: string; ttlMs?: number },
  ): Promise<ApiResult> {
    return this.call('POST', `/tasks/${encodeURIComponent(taskId)}/help`, {
      ...this.plumbing(),
      ...fields,
    });
  }

  ack(messageId: string): Promise<ApiResult> {
    return this.call('POST', `/inbox/${encodeURIComponent(messageId)}/ack`, {
      ...this.plumbing({ collection: 'messages', id: messageId }),
    });
  }

  accept(messageId: string, opts?: { taskRevision?: number }): Promise<ApiResult> {
    const taskId = this.messageTasks.get(messageId);
    const taskRevision =
      opts?.taskRevision ?? (taskId ? this.revisionOf('tasks', taskId) : undefined);
    return this.call('POST', `/inbox/${encodeURIComponent(messageId)}/accept`, {
      ...this.plumbing({ collection: 'messages', id: messageId }),
      ...(taskRevision !== undefined ? { taskRevision } : {}),
    });
  }

  reply(messageId: string, text: string): Promise<ApiResult> {
    // The changed entity is a brand-new reply message; there is no
    // expectedRevision to fill for it.
    return this.call('POST', `/inbox/${encodeURIComponent(messageId)}/reply`, {
      ...this.plumbing(),
      text,
    });
  }

  acceptHelp(helpId: string): Promise<ApiResult> {
    return this.call('POST', `/help/${encodeURIComponent(helpId)}/accept`, {
      ...this.plumbing({ collection: 'help', id: helpId }),
    });
  }

  answerHelp(helpId: string, answer: string): Promise<ApiResult> {
    return this.call('POST', `/help/${encodeURIComponent(helpId)}/answer`, {
      ...this.plumbing({ collection: 'help', id: helpId }),
      answer,
    });
  }

  handoff(
    assignmentId: string,
    fields: {
      done: string;
      next: string;
      uncertain?: string;
      verifyFirst?: string;
      doNotRepeat?: string;
      toId?: string;
      planRevisionId?: string;
    },
  ): Promise<ApiResult> {
    return this.call('POST', `/assignments/${encodeURIComponent(assignmentId)}/handoff`, {
      ...this.plumbing({ collection: 'assignments', id: assignmentId }, assignmentId),
      planRevisionId: this.lastPlanRevisionId,
      ...fields,
    });
  }

  workspace(assignmentId: string): Promise<ApiResult> {
    return this.call('POST', `/assignments/${encodeURIComponent(assignmentId)}/workspace`, {
      ...this.plumbing({ collection: 'assignments', id: assignmentId }, assignmentId),
    });
  }

  /**
   * Connection status honoring the connection research: only the platform
   * check is observable here. Provider auth and inference are reported
   * UNKNOWN — a reachable API never implies either of them.
   */
  async status(): Promise<ConnectionStatus> {
    const res = await this.refresh();
    if (res.ok) {
      return {
        platform: 'connected',
        providerAuth: 'unknown',
        inference: 'unknown',
        note: 'platform credential accepted; provider auth and inference were not tested',
      };
    }
    if (res.status === 401) {
      return {
        platform: 'unauthenticated',
        providerAuth: 'unknown',
        inference: 'unknown',
        note: 'platform credential rejected; reauthentication needed',
      };
    }
    if (res.status === 403 || res.status === 404) {
      return {
        platform: 'denied',
        providerAuth: 'unknown',
        inference: 'unknown',
        note: 'authenticated but this project is not accessible to the credential',
      };
    }
    return {
      platform: 'unreachable',
      providerAuth: 'unknown',
      inference: 'unknown',
      note: 'host offline or unreachable; work stays queued, nothing is launched',
    };
  }
}
