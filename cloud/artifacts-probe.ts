// Separately authenticated Artifacts arrival-probe Worker (seat b-swe-02).
//
// A small Worker shape the controller wires later to run the spec's
// "arrival check" against the real binding: read a brief, read flat repo
// metadata/readiness, resolve an exact tip, and verify a file exists —
// without exposing broad namespace operations. There is deliberately no
// create/fork/token/list/delete route here: those stay inside the
// authenticated app paths.
//
// Authentication is independent of the app authenticate hook: callers
// present `X-Probe-Token`, compared against `env.PROBE_TOKEN` via
// SHA-256 digest equality (constant work on the digest, no early-exit on
// the secret). Missing server config fails closed with 503.
// Token plaintext is never returned by any route.

import { ApiError, errorResponse, fail, json } from '../lib/core.ts';
import { createArtifactsAdapter } from '../lib/artifacts.ts';
import type { ArtifactsNamespaceLike } from '../lib/artifacts.ts';

export interface ArtifactsProbeEnv {
  /** `env.ARTIFACTS` namespace binding. */
  ARTIFACTS?: ArtifactsNamespaceLike;
  /** Shared probe credential (server-side secret; never echoed back). */
  PROBE_TOKEN?: string;
  /** Repository name the probe is allowed to inspect. */
  PROBE_REPO?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function requireProbeAuth(request: Request, env: ArtifactsProbeEnv): Promise<void> {
  const expected = env.PROBE_TOKEN;
  if (typeof expected !== 'string' || expected === '') {
    // Fail closed: an unconfigured probe is a 503, never an open endpoint.
    fail(503, 'probe_not_configured', 'PROBE_TOKEN is not configured', { retryable: false });
  }
  const presented = request.headers.get('x-probe-token') ?? '';
  const [expectedHash, presentedHash] = await Promise.all([sha256Hex(expected), sha256Hex(presented)]);
  if (expectedHash !== presentedHash) {
    fail(401, 'probe_unauthenticated', 'a valid X-Probe-Token is required', { retryable: false });
  }
}

function probeRepo(env: ArtifactsProbeEnv): string {
  const repo = env.PROBE_REPO;
  if (typeof repo !== 'string' || repo.trim() === '') {
    fail(503, 'probe_not_configured', 'PROBE_REPO is not configured', { retryable: false });
  }
  return repo;
}

async function probeFetch(request: Request, env: ArtifactsProbeEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Unauthenticated liveness only — reveals nothing about the repo.
    if (request.method === 'GET' && path === '/probe/health') {
      return json(200, { ok: true, probe: 'artifacts' });
    }

    // Everything else is read-only GET and separately authenticated.
    if (request.method !== 'GET') {
      fail(404, 'not_found', 'unknown probe route');
    }
    await requireProbeAuth(request, env);

    const adapter = createArtifactsAdapter({ namespace: env.ARTIFACTS, repo: probeRepo(env) });
    try {
      if (path === '/probe/readiness') {
        const meta = await adapter.info();
        return json(200, { ready: meta.ready, status: meta.status, repo: meta });
      }
      if (path === '/probe/info') {
        return json(200, { repo: await adapter.info() });
      }
      if (path === '/probe/tip') {
        const ref = url.searchParams.get('ref') ?? 'HEAD';
        return json(200, { ref, tip: await adapter.tip(ref) });
      }
      if (path === '/probe/head') {
        const filePath = url.searchParams.get('path') ?? '';
        const ref = url.searchParams.get('ref') ?? 'HEAD';
        const blob = await adapter.readFile(filePath, ref);
        if (blob === null) {
          return json(200, { path: filePath, ref, exists: false });
        }
        // Read-verification only: size/type/digest, never file content.
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        const sha256 = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return json(200, { path: filePath, ref, exists: true, size: blob.size, type: blob.type, sha256 });
      }
      // Broad namespace operations (list/create/fork/token/delete) are
      // intentionally absent — they get the same 404 as unknown routes.
      fail(404, 'not_found', 'unknown probe route');
    } finally {
      // The doc-shaped capability is released exactly once, even on error.
      adapter[Symbol.dispose]();
    }
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err);
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      return json(status, {
        error: {
          status,
          code: (err as { code?: string }).code ?? 'error',
          message: err instanceof Error ? err.message : 'probe request failed',
          retryable: status === 429 || status === 503,
        },
      });
    }
    return json(500, {
      error: { status: 500, code: 'internal_error', message: 'internal error', retryable: false },
    });
  }
}

/** Factory form for tests and for the controller's composition. */
export function createArtifactsProbe(env: ArtifactsProbeEnv): { fetch(request: Request): Promise<Response> } {
  return { fetch: (request: Request) => probeFetch(request, env) };
}

/** Worker module shape for later controller wiring. */
export default {
  async fetch(request: Request, env: ArtifactsProbeEnv): Promise<Response> {
    return probeFetch(request, env);
  },
};
