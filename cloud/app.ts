import {currentMember} from '../lib/conversation.ts';
// API dispatcher scaffold for the Together slice (seat b-swe-01).
// createApp wires authenticate + module handlers over the shared Store.
// Every /api route requires a server-side principal; there is no bypass.
// Local server composition and real binding wiring stay with the integrator.

import { handleGlobalInbox } from '../lib/inbox.ts';
import {
  ApiError, MAX_BODY_BYTES, errorResponse, fail, json, readJsonBody,
  requireScope, safeSnapshot,
} from '../lib/core.ts';
import type {
  ArtifactsAdapter, Context, GitService, Principal, RunnerService, Store,
} from '../lib/types.ts';

/**
 * Module handler contract: called with segments after
 * /api/v1/projects/:projectId (e.g. ['tasks', id, 'assignments']).
 * Returns null only when the endpoint is not owned by that module.
 */
export type ModuleHandler = (
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
) => Promise<Response | null>;

export interface AppDeps {
  attentionEnabled?: boolean;
  store: Store;
  authenticate(request: Request): Promise<Principal | null>;
  handlers: ModuleHandler[];
  conversation?: import("../lib/conversation-store.ts").ConversationStore;
  runtime?: import("../lib/run-state.ts").RuntimeBinding;
  git?: GitService;
  runner?: RunnerService;
  artifacts?: ArtifactsAdapter;
  now?: () => string;
  uid?: () => string;
  maxBodyBytes?: number;
}

export function createApp(deps: AppDeps): { fetch(request: Request): Promise<Response> } {
  const now = deps.now ?? (() => new Date().toISOString());
  const uid = deps.uid ?? (() => crypto.randomUUID());
  const maxBodyBytes = deps.maxBodyBytes ?? MAX_BODY_BYTES;

  async function fetch(request: Request): Promise<Response> {
    try {
      const parts = new URL(request.url).pathname.split('/').filter(Boolean);
      if (parts[0] !== 'api' || parts[1] !== 'v1') {
        return json(404, {
          error: { status: 404, code: 'not_found', message: 'not an API route', retryable: false },
        });
      }

      const principal = await deps.authenticate(request);
      if (!principal) {
        fail(401, 'unauthenticated', 'authentication required');
      }

      // Owner-only bootstrap: GET /api/v1/projects lists this object's project.
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'projects') {
        const state = await deps.store.read();
        if (!principal.scopes.includes('admin') && !principal.scopes.includes('owner')) {
          fail(403, 'scope_denied', 'project listing is owner-only');
        }
        const { id, goal, mode, canonicalRef, revision } = state.project;
        return json(200, { projects: [{ id, goal, mode, canonicalRef, revision }] });
      }

      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'inbox') {
        return await handleGlobalInbox({ principal, store: deps.store, now, uid }, request);
      }
      if (parts[2] !== 'projects' || parts.length < 4) {
        fail(404, 'not_found', 'unknown route');
      }
      const projectId = parts[3];
      if (!principal.projectIds.includes(projectId)) {
        // Existence is not leaked across projects.
        fail(404, 'not_found', 'unknown or inaccessible project');
      }
      // A profile header only narrows access; it never grants capability.
      if(request.headers.get('x-together-work-profile')==='ordinary')currentMember(await deps.store.read(),principal);
      const instance=request.headers.get('x-together-adapter-instance');
      if(instance && principal.kind==='agent')deps.conversation?.observeConnection(instance,principal.id,principal.sessionId,now());

      // Member-safe project read: GET /api/v1/projects/:projectId
      if (request.method === 'GET' && parts.length === 4) {
        const state = await deps.store.read();
        requireScope(principal, 'read', state);
        return json(200, safeSnapshot(state, principal));
      }

      let body: Record<string, unknown> | undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = await readJsonBody(request, maxBodyBytes);
      }
      const ctx: Context = {
        principal,
        store: deps.store,
        now,
        uid,
        git: deps.git,
        runner: deps.runner,
        artifacts: deps.artifacts,
        conversation: deps.conversation,
        attentionEnabled: deps.attentionEnabled===true,
        runtime: deps.runtime,
      };
      const segments = parts.slice(4);
      for (const handler of deps.handlers) {
        const response = await handler(ctx, request, segments, body);
        if (response !== null) return response;
      }
      fail(404, 'route_not_found', `no handler owns /api/v1/projects/${projectId}/${segments.join('/')}`);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      const status = (err as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 600) {
        return json(status, {
          error: {
            status,
            code: (err as { code?: string }).code ?? 'error',
            message: err instanceof Error ? err.message : 'request failed',
            retryable: status === 429 || status === 503,
          },
        });
      }
      return json(500, {
        error: { status: 500, code: 'internal_error', message: 'internal error', retryable: false },
      });
    }
  }

  return { fetch };
}
