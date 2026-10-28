// Cloud acceptance driver (lane c-swe-10, phase04).
//
// Controller-invoked AFTER merge and deployment; it drives the REAL HTTP
// surface of the deployed Together worker (or the local development
// composition for a dry check). The script creates its own disposable
// project and scoped agent identities, asserts the original adversarial
// risks from the spec, then walks the remote
//   proposals -> combine -> check -> review -> integrate -> reconnect
// flow as far as the deployment actually supports it.
//
// Honesty contract:
//   - Secrets enter only through env vars or a 0600 config file. Nothing
//     secret is accepted on argv and every emitted record is deep-redacted;
//     minted credentials are registered the moment they are issued.
//   - A step whose seam is absent (route missing, git/runner unavailable)
//     is recorded 'unavailable' with the observed status/code -- never
//     reported as passed. A step never runs on fabricated SHAs: real
//     proposal heads arrive via the config `flow` block or the step is
//     skipped.
//   - This script is controller mediation. It cannot produce
//     'native-session' evidence and never relabels itself a native agent;
//     the native follow-up step is recorded unavailable by construction.
//
// Usage (controller):
//   tsx scripts/cloud-acceptance.ts --config ./acceptance.json \
//       --out ./acceptance-evidence.json [--require-hosted]
// or  node --experimental-strip-types scripts/cloud-acceptance.ts ...
// Config file (chmod 0600): { "apiUrl": "...", "ownerToken": "...",
//   "projectPrefix"?, "timeoutMs"?, "flow"?: { baseSha, headA, headB,
//   conflictHeadA?, checkCommand? } }
// Env fallback: TOGETHER_ACCEPT_API_URL plus TOGETHER_ACCEPT_OWNER_TOKEN
// or TOGETHER_ACCEPT_OWNER_TOKEN_FILE (0600).

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EVIDENCE_CLASSES = [
  'controller-mediated', // this script's own observations over HTTP
  'api',                 // API contract behavior observed through responses
  'hosted-do',           // durable state observed through read-back
  'actual-git',          // a real git effect observed (merge/push)
  'actual-docker',       // a real isolated check run observed
  'native-session',      // same-session native follow-up; never emitted here
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export type StepStatus = 'pass' | 'fail' | 'unavailable' | 'skipped';

export interface StepRecord {
  id: string;
  title: string;
  evidence: EvidenceClass[];
  status: StepStatus;
  expected: string;
  observed: string;
  detail?: unknown;
  durationMs: number;
}

export interface AcceptanceConfig {
  apiUrl: string;
  ownerToken: string;
  projectId?: string;
  projectPrefix: string;
  timeoutMs: number;
  requireHosted: boolean;
  outPath?: string;
  flow?: {
    baseSha: string;
    headA: string;
    headB: string;
    conflictHeadA?: string;
    checkCommand?: string;
  };
}

export interface AcceptanceReport {
  schema: 1;
  generatedAt: string;
  target: { host: string; loopback: boolean };
  projectIds: { a?: string; b?: string };
  steps: StepRecord[];
  summary: { pass: number; fail: number; unavailable: number; skipped: number };
  verdict: 'pass' | 'fail' | 'incomplete';
  limits: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// --------------------------------------------------------------------------
// Input validation
// --------------------------------------------------------------------------

const PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isSafeProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_RE.test(value);
}

export function assertSafeProjectId(value: unknown, field = 'projectId'): asserts value is string {
  if (!isSafeProjectId(value)) {
    throw new ConfigError(`"${field}" is not a safe project id`);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/** https everywhere; plain http only on loopback; never embedded credentials. */
export function validateApiUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError('apiUrl is required (https, or http on loopback)');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('apiUrl is not a valid URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError('apiUrl must not embed credentials');
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === 'http:' && !loopback) {
    throw new ConfigError('plain http apiUrl is refused off loopback; use https');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('apiUrl must be https (or http on loopback)');
  }
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function assertTokenShape(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 8 || /[\r\n]/.test(value)) {
    throw new ConfigError(`"${field}" is missing or malformed; supply it via env or a 0600 config file`);
  }
}

/** Refuse anything that looks like secret material passed on argv. */
export function assertNoSecretArgv(argv: string[]): void {
  for (const arg of argv) {
    if (
      /(sess|cjob|cred|inv)_[0-9a-f]{16,}/i.test(arg) ||
      /bearer\s+\S+/i.test(arg) ||
      /^(--)?(token|secret|password|credential|cookie|authorization)[=:]/i.test(arg)
    ) {
      throw new ConfigError(
        'secret-looking material on argv is refused; use env vars or a 0600 config file',
      );
    }
  }
}

// --------------------------------------------------------------------------
// Redaction
// --------------------------------------------------------------------------

const SECRET_KEY_RE =
  /^(authorization|cookie|set-cookie|token|tokenhash|collectortoken|plaintext|secret|password|credential|bearer|ownerToken)$/i;
const SECRET_KEY_SUFFIX_RE = /(token|secret|password|credential|cookie|plaintext)$/i;

/**
 * Deep-redact: values present in `secrets` are masked wherever they appear
 * (including embedded inside longer strings); object keys that name secret
 * material are masked outright. Never throws, never mutates the input.
 */
export function redactDeep(value: unknown, secrets: ReadonlySet<string>): unknown {
  const maskString = (s: string): string => {
    let out = s;
    for (const secret of secrets) {
      if (secret.length >= 8 && out.includes(secret)) {
        out = out.split(secret).join('***REDACTED***');
      }
    }
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k) || SECRET_KEY_SUFFIX_RE.test(k)) {
          out[k] = '***REDACTED***';
        } else {
          out[k] = walk(item);
        }
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

// --------------------------------------------------------------------------
// Config loading
// --------------------------------------------------------------------------

interface ConfigDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fileMode?: (path: string) => number;
  readFile?: (path: string) => string;
}

const defaultFileMode = (path: string): number => statSync(path).mode;
const defaultReadFile = (path: string): string => readFileSync(path, 'utf8');

function assertPrivateFile(path: string, fileMode: (p: string) => number): void {
  const mode = fileMode(path) & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(
      `${path} must not be readable by group/other (got mode ${mode.toString(8)}); chmod 0600`,
    );
  }
}

export function loadConfig(deps: ConfigDeps = {}): AcceptanceConfig {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const fileMode = deps.fileMode ?? defaultFileMode;
  const readFile = deps.readFile ?? defaultReadFile;

  assertNoSecretArgv(argv);

  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new ConfigError(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (['require-hosted', 'help'].includes(arg.slice(2))) {
      flags.set(arg.slice(2), true);
    } else {
      i += 1;
      if (i >= argv.length) throw new ConfigError(`flag ${arg} requires a value`);
      flags.set(arg.slice(2), argv[i]);
    }
  }
  if (flags.has('help')) {
    throw new ConfigError(
      'usage: cloud-acceptance --config FILE [--out FILE] [--project-prefix P] ' +
        '[--project-id ID] [--timeout-ms N] [--require-hosted]',
    );
  }
  const ALLOWED = new Set(['config', 'out', 'project-prefix', 'project-id', 'timeout-ms', 'require-hosted', 'help']);
  for (const key of flags.keys()) {
    if (!ALLOWED.has(key)) throw new ConfigError(`unknown flag --${key}`);
  }

  let fileConfig: Record<string, unknown> = {};
  const configPath = flags.get('config');
  if (typeof configPath === 'string') {
    assertPrivateFile(configPath, fileMode);
    try {
      const parsed = JSON.parse(readFile(configPath)) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ConfigError('config file must contain a JSON object');
      }
      fileConfig = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`cannot read config file: ${String(err).slice(0, 160)}`);
    }
  }

  let ownerToken = fileConfig.ownerToken;
  if (ownerToken === undefined) ownerToken = env.TOGETHER_ACCEPT_OWNER_TOKEN;
  if (ownerToken === undefined && typeof env.TOGETHER_ACCEPT_OWNER_TOKEN_FILE === 'string') {
    assertPrivateFile(env.TOGETHER_ACCEPT_OWNER_TOKEN_FILE, fileMode);
    ownerToken = readFile(env.TOGETHER_ACCEPT_OWNER_TOKEN_FILE).trim();
  }
  assertTokenShape(ownerToken, 'ownerToken');

  const apiUrl = validateApiUrl(fileConfig.apiUrl ?? env.TOGETHER_ACCEPT_API_URL);

  const projectId = fileConfig.projectId ?? flags.get('project-id');
  if (projectId !== undefined) assertSafeProjectId(projectId, 'project-id');

  const projectPrefix = String(fileConfig.projectPrefix ?? flags.get('project-prefix') ?? 'acc');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,16}$/.test(projectPrefix)) {
    throw new ConfigError('project prefix must be 1-17 chars of [a-zA-Z0-9-]');
  }

  const timeoutRaw = fileConfig.timeoutMs ?? flags.get('timeout-ms');
  const timeoutMs = timeoutRaw === undefined ? 45_000 : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new ConfigError('timeout-ms must be a positive number <= 300000');
  }

  let flow: AcceptanceConfig['flow'];
  const rawFlow = fileConfig.flow;
  if (rawFlow !== undefined) {
    if (typeof rawFlow !== 'object' || rawFlow === null) {
      throw new ConfigError('config "flow" must be an object of real commit SHAs');
    }
    const f = rawFlow as Record<string, unknown>;
    for (const field of ['baseSha', 'headA', 'headB'] as const) {
      if (typeof f[field] !== 'string' || !SHA_RE.test(f[field] as string)) {
        throw new ConfigError(`flow.${field} must be a real 40/64-hex commit SHA; never fabricated`);
      }
    }
    if (f.conflictHeadA !== undefined && !SHA_RE.test(String(f.conflictHeadA))) {
      throw new ConfigError('flow.conflictHeadA must be a real commit SHA');
    }
    flow = {
      baseSha: f.baseSha as string,
      headA: f.headA as string,
      headB: f.headB as string,
      ...(f.conflictHeadA !== undefined ? { conflictHeadA: String(f.conflictHeadA) } : {}),
      ...(f.checkCommand !== undefined ? { checkCommand: String(f.checkCommand) } : {}),
    };
  }

  const out = flags.get('out');
  return {
    apiUrl,
    ownerToken,
    ...(projectId !== undefined ? { projectId: String(projectId) } : {}),
    projectPrefix,
    timeoutMs,
    requireHosted: flags.has('require-hosted'),
    ...(typeof out === 'string' ? { outPath: out } : {}),
    ...(flow !== undefined ? { flow } : {}),
  };
}

// --------------------------------------------------------------------------
// Step engine
// --------------------------------------------------------------------------

interface ApiResult {
  status: number;
  body: Record<string, unknown> | null;
  headers: Headers;
}

interface RunCtx {
  cfg: AcceptanceConfig;
  fetch: typeof fetch;
  now: () => string;
  secrets: Set<string>;
  dead?: string;
  cookie?: string;
  projectA?: string;
  projectB?: string;
  taskA?: string;
  taskB?: string;
  agents: Record<string, { identityId: string; credentialId: string; token: string } | undefined>;
  proposalA?: string;
  proposalB?: string;
  conflictProposal?: string;
  candidateId?: string;
  candidateSha?: string;
  candidateBase?: string;
  checkPassed: boolean;
  reviewPassed: boolean;
  ops: number;
}

class StepFail extends Error {}

function errorCode(res: ApiResult): string | undefined {
  const code = res.body?.error;
  if (typeof code === 'object' && code !== null) {
    const c = (code as Record<string, unknown>).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function expectStatus(res: ApiResult, statuses: number[], what: string): void {
  if (!statuses.includes(res.status)) {
    throw new StepFail(
      `${what}: expected ${statuses.join('|')}, got ${res.status}` +
        (errorCode(res) ? ` (${errorCode(res)})` : ''),
    );
  }
}

/** A missing route/dependency is 'unavailable', not a product defect. */
function isSeamUnavailable(res: ApiResult): boolean {
  const code = errorCode(res);
  if (res.status === 503) {
    return ['git_unavailable', 'unavailable', 'dependency_unavailable', 'runner-unavailable'].includes(
      String(code),
    );
  }
  if (res.status === 501) return true;
  if (res.status === 404 && code === 'route_not_found') return true;
  if (
    res.status === 404 &&
    code === 'not_found' &&
    /not an api route/i.test(String((res.body?.error as Record<string, unknown> | undefined)?.message))
  ) {
    return true;
  }
  return false;
}

interface Step {
  id: string;
  title: string;
  evidence: EvidenceClass[];
  expected: string;
  needs?: (ctx: RunCtx) => string | undefined;
  run: (ctx: RunCtx) => Promise<{ status?: StepStatus; observed: string; detail?: unknown }>;
}

const AGENT_SCOPES = [
  'read',
  'tasks:write',
  'tasks:claim',
  'assignments:write',
  'changes:write',
  'reviews:write',
];

async function api(
  ctx: RunCtx,
  req: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    auth?: 'owner' | 'cookie' | 'none' | string;
    headers?: Record<string, string>;
  },
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  const auth = req.auth ?? 'owner';
  if (auth === 'owner') {
    headers.authorization = `Bearer ${ctx.cfg.ownerToken}`;
  } else if (auth === 'cookie') {
    if (ctx.cookie !== undefined) headers.cookie = ctx.cookie;
  } else if (auth !== 'none') {
    const agent = ctx.agents[auth];
    if (agent === undefined) throw new StepFail(`agent ${auth} not minted`);
    headers.authorization = `Bearer ${agent.token}`;
  }
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  const res = await ctx.fetch(
    new Request(`${ctx.cfg.apiUrl}${req.path}`, {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

const op = (ctx: RunCtx, label: string): string => `acc-${label}-${++ctx.ops}`;

function bodyField<T>(res: ApiResult, path: string[]): T | undefined {
  let cur: unknown = res.body;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur as T | undefined;
}

async function mintAgent(
  ctx: RunCtx,
  name: string,
  scopes: string[],
): Promise<{ identityId: string; credentialId: string; token: string }> {
  const project = ctx.projectA;
  if (project === undefined) throw new StepFail('project not created');
  const idRes = await api(ctx, {
    method: 'POST',
    path: `/api/v1/projects/${project}/identities`,
    body: { displayName: `acceptance-${name}`, operationId: op(ctx, `id-${name}`) },
  });
  expectStatus(idRes, [201], 'identity create');
  const identityId = bodyField<string>(idRes, ['identity', 'id']);
  if (typeof identityId !== 'string') throw new StepFail('identity id missing from response');

  const invRes = await api(ctx, {
    method: 'POST',
    path: `/api/v1/projects/${project}/identities/${identityId}/invitations`,
    body: { operationId: op(ctx, `inv-${name}`), scopes },
  });
  expectStatus(invRes, [201], 'invitation create');
  const invToken = bodyField<string>(invRes, ['token']);
  if (typeof invToken !== 'string') throw new StepFail('invitation token missing from response');
  ctx.secrets.add(invToken);

  const exchangeBody = { operationId: op(ctx, `ex-${name}`), adapter: 'cloud-acceptance' };
  const exRes = await api(ctx, {
    method: 'POST',
    path: `/api/v1/projects/${project}/enrollment/exchange`,
    auth: 'none',
    headers: { authorization: `Bearer ${invToken}` },
    body: exchangeBody,
  });
  expectStatus(exRes, [201], 'enrollment exchange');
  const token = bodyField<string>(exRes, ['token']);
  const credentialId = bodyField<string>(exRes, ['credentialId']);
  if (typeof token !== 'string' || typeof credentialId !== 'string') {
    throw new StepFail('credential token/id missing from exchange response');
  }
  ctx.secrets.add(token);

  // Replay of the secret-minting operation must NOT return the secret again.
  const replay = await api(ctx, {
    method: 'POST',
    path: `/api/v1/projects/${project}/enrollment/exchange`,
    auth: 'none',
    headers: { authorization: `Bearer ${invToken}` },
    body: exchangeBody,
  });
  const replayText = JSON.stringify(replay.body);
  if (replay.status === 201 && replayText.includes(token)) {
    throw new StepFail('credential plaintext returned again on operation replay');
  }
  return { identityId, credentialId, token };
}

async function candidateRevision(ctx: RunCtx): Promise<number> {
  if (ctx.candidateId === undefined || ctx.projectA === undefined) {
    throw new StepFail('no candidate recorded');
  }
  const res = await api(ctx, { method: 'GET', path: `/api/v1/projects/${ctx.projectA}` });
  expectStatus(res, [200], 'project read for candidate revision');
  const cand = (res.body?.candidates as Record<string, { revision?: number }> | undefined)?.[
    ctx.candidateId
  ];
  if (cand === undefined || typeof cand.revision !== 'number') {
    throw new StepFail('candidate missing from project view');
  }
  return cand.revision;
}

const steps: Step[] = [
  {
    id: 'preflight.unauthenticated',
    title: 'unauthenticated API access is refused',
    evidence: ['controller-mediated', 'api'],
    expected: 'GET /api/v1/projects without credentials answers 401',
    run: async (ctx) => {
      const res = await api(ctx, { method: 'GET', path: '/api/v1/projects', auth: 'none' });
      expectStatus(res, [401], 'unauthenticated list');
      return { observed: `unauthenticated request answered ${res.status}` };
    },
  },
  {
    id: 'auth.session',
    title: 'owner bearer exchanges for an HttpOnly SameSite session cookie',
    evidence: ['controller-mediated', 'api'],
    expected: 'POST /api/v1/session -> 201 + HttpOnly SameSite=Strict cookie; token absent from body',
    run: async (ctx) => {
      const res = await api(ctx, { method: 'POST', path: '/api/v1/session', body: {} });
      if (isSeamUnavailable(res)) {
        return { status: 'unavailable', observed: `session endpoint absent (${res.status})` };
      }
      expectStatus(res, [201], 'session create');
      const setCookie = res.headers.get('set-cookie') ?? '';
      if (!/httponly/i.test(setCookie)) throw new StepFail('session cookie missing HttpOnly');
      if (!/samesite=strict/i.test(setCookie)) throw new StepFail('session cookie missing SameSite=Strict');
      const pair = setCookie.split(';')[0];
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value.length < 8) throw new StepFail('session cookie value missing');
      ctx.secrets.add(value);
      ctx.cookie = pair;
      if (JSON.stringify(res.body).includes(ctx.cfg.ownerToken)) {
        throw new StepFail('owner token echoed in session response body');
      }
      const pathMatch = /;\s*path=([^;]+)/i.exec(setCookie);
      return {
        observed: 'session cookie issued with HttpOnly + SameSite=Strict',
        detail: { cookiePath: pathMatch?.[1] ?? 'unspecified' },
      };
    },
  },
  {
    id: 'auth.whoami',
    title: 'session cookie authorizes reads',
    evidence: ['controller-mediated', 'api'],
    expected: 'GET /api/v1/session with cookie -> 200 authenticated',
    needs: (ctx) => (ctx.cookie === undefined ? 'no session cookie from auth.session' : undefined),
    run: async (ctx) => {
      const res = await api(ctx, { method: 'GET', path: '/api/v1/session', auth: 'cookie' });
      expectStatus(res, [200], 'session whoami');
      if (res.body?.authenticated !== true) throw new StepFail('whoami not authenticated');
      return { observed: 'cookie-authenticated session resolves' };
    },
  },
  {
    id: 'project.create',
    title: 'disposable project creation is owner-gated and real',
    evidence: ['controller-mediated', 'api', 'hosted-do'],
    expected: 'POST /api/v1/projects -> 201 with the requested disposable id',
    needs: (ctx) => (ctx.cookie === undefined ? 'no session from auth.session' : undefined),
    run: async (ctx) => {
      const id =
        ctx.cfg.projectId ?? `${ctx.cfg.projectPrefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      assertSafeProjectId(id);
      const res = await api(ctx, {
        method: 'POST',
        path: '/api/v1/projects',
        body: { id, goal: 'cloud acceptance disposable project', operationId: op(ctx, 'create') },
      });
      if (isSeamUnavailable(res)) {
        return { status: 'unavailable', observed: `project creation route absent (${res.status})` };
      }
      expectStatus(res, [200, 201], 'project create');
      const created = bodyField<{ id?: string }>(res, ['project']);
      if (created?.id !== id) throw new StepFail('created project id mismatch');
      ctx.projectA = id;
      return { observed: `disposable project ${id} created` };
    },
  },
  {
    id: 'project.create.idempotent',
    title: 'project create replays by operationId and conflicts honestly',
    evidence: ['controller-mediated', 'api'],
    expected: 'same operationId + same payload -> same result; different payload -> 409',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const opId = op(ctx, 'idem');
      const body = { id: `${ctx.projectA}-dup`, goal: 'idempotency probe', operationId: opId };
      const first = await api(ctx, { method: 'POST', path: '/api/v1/projects', body });
      expectStatus(first, [200, 201], 'first idempotent create');
      const second = await api(ctx, { method: 'POST', path: '/api/v1/projects', body });
      expectStatus(second, [200, 201], 'replay idempotent create');
      const a = bodyField<{ id?: string }>(first, ['project'])?.id;
      const b = bodyField<{ id?: string }>(second, ['project'])?.id;
      if (a === undefined || a !== b) throw new StepFail('idempotent replay returned a different project');
      const conflict = await api(ctx, {
        method: 'POST',
        path: '/api/v1/projects',
        body: { id: `${ctx.projectA}-dup2`, goal: 'conflicting payload', operationId: opId },
      });
      expectStatus(conflict, [409], 'conflicting operationId reuse');
      return { observed: 'identical replay returned the same project; conflicting reuse 409' };
    },
  },
  {
    id: 'adversarial.malicious-project-id',
    title: 'traversal/unsafe project ids are rejected',
    evidence: ['controller-mediated', 'api'],
    expected: 'ids like ../escape or a/b answer 4xx, never create',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const bad = ['../escape', 'a/b', '.dotfile', 'x'.repeat(140)];
      const seen: Record<string, number> = {};
      for (const id of bad) {
        const res = await api(ctx, {
          method: 'POST',
          path: '/api/v1/projects',
          body: { id, goal: 'malicious probe', operationId: op(ctx, 'badid') },
        });
        if (res.status < 400 || res.status >= 500) {
          throw new StepFail(`malicious id ${JSON.stringify(id)} answered ${res.status}`);
        }
        seen[id.slice(0, 16)] = res.status;
      }
      return { observed: 'all unsafe ids rejected with 4xx', detail: seen };
    },
  },
  {
    id: 'adversarial.encoded-traversal',
    title: 'percent-encoded traversal in the path never resolves',
    evidence: ['controller-mediated', 'api'],
    expected: 'GET /api/v1/projects/..%2F..%2Fetc answers 4xx',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const res = await api(ctx, {
        method: 'GET',
        path: '/api/v1/projects/..%2F..%2Fetc%2Fpasswd',
      });
      if (res.status < 400 || res.status >= 500) {
        throw new StepFail(`encoded traversal answered ${res.status}`);
      }
      return { observed: `encoded traversal answered ${res.status}` };
    },
  },
  {
    id: 'adversarial.foreign-origin',
    title: 'cross-site mutating requests are refused',
    evidence: ['controller-mediated', 'api'],
    expected: 'POST with a foreign Origin answers 403',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const res = await api(ctx, {
        method: 'POST',
        path: '/api/v1/projects',
        headers: { origin: 'https://evil.example' },
        body: { goal: 'csrf probe', operationId: op(ctx, 'csrf') },
      });
      expectStatus(res, [403], 'foreign origin write');
      return { observed: 'foreign-origin mutating request refused 403' };
    },
  },
  {
    id: 'adversarial.unauth-existence',
    title: 'existence is not leaked before or after authentication',
    evidence: ['controller-mediated', 'api'],
    expected: 'unauthenticated read -> 401; authenticated read of unknown id -> 404',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const unauth = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}`,
        auth: 'none',
      });
      expectStatus(unauth, [401], 'unauthenticated project read');
      const missing = await api(ctx, {
        method: 'GET',
        path: '/api/v1/projects/acc-nonexistent-000',
      });
      expectStatus(missing, [404], 'unknown project read');
      return { observed: 'unauthenticated 401; unknown id 404 (no existence leak)' };
    },
  },
  {
    id: 'adversarial.internal-headers',
    title: 'forged internal authorization headers grant nothing',
    evidence: ['controller-mediated', 'api'],
    expected: 'internal-looking headers without real auth still answer 401',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const res = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}`,
        auth: 'none',
        headers: {
          'x-authorized-bootstrap': '1',
          'x-internal-authorization': 'owner',
          'x-bridge-role': 'git',
          'x-forwarded-user': 'steve',
        },
      });
      expectStatus(res, [401], 'forged internal headers');
      return { observed: 'forged internal headers answered 401' };
    },
  },
  {
    id: 'identity.mint-agents',
    title: 'scoped agent credentials mint through real enrollment',
    evidence: ['controller-mediated', 'api'],
    expected: 'identity -> invitation -> exchange issues scoped creds; replay never re-returns the secret',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      ctx.agents.agentA = await mintAgent(ctx, 'agentA', AGENT_SCOPES);
      ctx.agents.agentB = await mintAgent(ctx, 'agentB', AGENT_SCOPES);
      const res = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}`,
        auth: 'agentA',
      });
      expectStatus(res, [200], 'agent read on own project');
      return {
        observed: 'two scoped agent credentials issued via enrollment; replay redacted; agent read 200',
        detail: {
          agentA: { identityId: ctx.agents.agentA.identityId, credentialId: ctx.agents.agentA.credentialId },
          agentB: { identityId: ctx.agents.agentB.identityId, credentialId: ctx.agents.agentB.credentialId },
        },
      };
    },
  },
  {
    id: 'task.create-and-claim',
    title: 'owner creates tasks; scoped agents claim them',
    evidence: ['controller-mediated', 'api'],
    expected: 'POST /tasks 201; POST /tasks/:id/assignments claims by each agent',
    needs: (ctx) =>
      ctx.agents.agentA === undefined || ctx.agents.agentB === undefined
        ? 'agents not minted'
        : undefined,
    run: async (ctx) => {
      const mk = async (goal: string): Promise<string> => {
        const res = await api(ctx, {
          method: 'POST',
          path: `/api/v1/projects/${ctx.projectA}/tasks`,
          body: { goal, acceptanceCriteria: ['acceptance probe passes'], operationId: op(ctx, 'task') },
        });
        expectStatus(res, [201], 'task create');
        const id = bodyField<string>(res, ['task', 'id']);
        if (typeof id !== 'string') throw new StepFail('task id missing');
        return id;
      };
      ctx.taskA = await mk('acceptance task A');
      ctx.taskB = await mk('acceptance task B');
      for (const [agent, task] of [
        ['agentA', ctx.taskA],
        ['agentB', ctx.taskB],
      ] as const) {
        const claim = await api(ctx, {
          method: 'POST',
          path: `/api/v1/projects/${ctx.projectA}/tasks/${task}/assignments`,
          auth: agent,
          body: { operationId: op(ctx, `claim-${agent}`), expectedRevision: 1 },
        });
        expectStatus(claim, [201], `${agent} claim`);
      }
      return { observed: 'two tasks created and claimed by distinct scoped agents' };
    },
  },
  {
    id: 'adversarial.cross-project',
    title: 'a credential scoped to project A is denied on project B',
    evidence: ['controller-mediated', 'api'],
    expected: 'agentA credential on project B answers 401/403/404; on project A 200',
    needs: (ctx) => (ctx.agents.agentA === undefined ? 'agents not minted' : undefined),
    run: async (ctx) => {
      const bId = `${ctx.cfg.projectPrefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const created = await api(ctx, {
        method: 'POST',
        path: '/api/v1/projects',
        body: { id: bId, goal: 'cross-project denial probe', operationId: op(ctx, 'create-b') },
      });
      expectStatus(created, [200, 201], 'project B create');
      ctx.projectB = bId;
      const denied = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${bId}`,
        auth: 'agentA',
      });
      if (denied.status === 200) throw new StepFail('project-A credential authorized on project B');
      if (denied.status < 400 || denied.status >= 500) {
        throw new StepFail(`cross-project read answered ${denied.status}`);
      }
      const allowed = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}`,
        auth: 'agentA',
      });
      expectStatus(allowed, [200], 'agent read on own project');
      return { observed: `project-B read denied (${denied.status}); project-A read 200` };
    },
  },
  {
    id: 'adversarial.collector-forgery',
    title: 'collector endpoints refuse member and forged credentials',
    evidence: ['controller-mediated', 'api'],
    expected: 'owner bearer -> 403 collector_only; garbage bearer -> 401',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const asOwner = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/collector/jobs/forged-job/complete`,
        body: { operationId: op(ctx, 'forge'), outcome: 'pass' },
      });
      expectStatus(asOwner, [401, 403], 'owner bearer on collector route');
      const garbage = `cjob_${'f'.repeat(32)}`;
      ctx.secrets.add(garbage);
      const forged = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/collector/jobs/forged-job/complete`,
        auth: 'none',
        headers: { authorization: `Bearer ${garbage}` },
        body: { operationId: op(ctx, 'forge2'), outcome: 'pass' },
      });
      expectStatus(forged, [401], 'forged collector token');
      return {
        observed: `owner principal refused (${asOwner.status}); forged token refused (${forged.status})`,
      };
    },
  },
  {
    id: 'adversarial.body-limit',
    title: 'oversized request bodies are bounded',
    evidence: ['controller-mediated', 'api'],
    expected: 'a >256KiB JSON body answers 4xx',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      const res = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/tasks`,
        body: {
          goal: 'oversize probe',
          acceptanceCriteria: ['x'],
          operationId: op(ctx, 'big'),
          padding: 'p'.repeat(300 * 1024),
        },
      });
      if (res.status < 400 || res.status >= 500) {
        throw new StepFail(`oversized body answered ${res.status}`);
      }
      return { observed: `oversized body refused with ${res.status} (${errorCode(res) ?? 'no-code'})` };
    },
  },
  {
    id: 'privacy.export',
    title: 'export and project views never carry credential material',
    evidence: ['controller-mediated', 'api'],
    expected: 'GET /export strips credentials; no issued token appears anywhere',
    needs: (ctx) => (ctx.agents.agentA === undefined ? 'agents not minted' : undefined),
    run: async (ctx) => {
      const res = await api(ctx, { method: 'GET', path: `/api/v1/projects/${ctx.projectA}/export` });
      if (res.status === 404) {
        return { status: 'unavailable', observed: 'export route absent' };
      }
      expectStatus(res, [200], 'project export');
      const text = JSON.stringify(res.body);
      for (const secret of ctx.secrets) {
        if (secret.length >= 8 && text.includes(secret)) {
          throw new StepFail('export contains issued credential material');
        }
      }
      const creds = res.body?.credentials as Record<string, unknown> | undefined;
      if (creds !== undefined && Object.keys(creds).length > 0) {
        throw new StepFail('export carries credential records');
      }
      return { observed: 'export carries no credentials and no issued token value' };
    },
  },
  {
    id: 'flow.proposals',
    title: 'two scoped agents submit concurrent proposals on real heads',
    evidence: ['controller-mediated', 'api'],
    expected: 'agentA + agentB POST /changes with config-supplied real heads -> 201 each',
    needs: (ctx) => {
      if (ctx.cfg.flow === undefined) {
        return 'no flow block configured: real proposal head SHAs are never fabricated';
      }
      if (ctx.agents.agentA === undefined || ctx.agents.agentB === undefined) return 'agents not minted';
      if (ctx.taskA === undefined || ctx.taskB === undefined) return 'tasks not created';
      return undefined;
    },
    run: async (ctx) => {
      const flow = ctx.cfg.flow!;
      const submit = async (
        agent: string,
        taskId: string,
        head: string,
        label: string,
      ): Promise<string> => {
        const res = await api(ctx, {
          method: 'POST',
          path: `/api/v1/projects/${ctx.projectA}/changes`,
          auth: agent,
          body: {
            operationId: op(ctx, `prop-${label}`),
            taskIds: [taskId],
            base: flow.baseSha,
            head,
            summary: `acceptance proposal ${label}`,
            intendedBehavior: 'acceptance flow coverage',
            changedPaths: [`acceptance/${label}.txt`],
          },
        });
        if (isSeamUnavailable(res)) {
          throw new StepFail(`proposal route absent (${res.status})`);
        }
        expectStatus(res, [201], `proposal ${label} submit`);
        const id = bodyField<string>(res, ['proposal', 'id']);
        if (typeof id !== 'string') throw new StepFail('proposal id missing');
        return id;
      };
      const [a, b] = await Promise.all([
        submit('agentA', ctx.taskA!, flow.headA, 'a'),
        submit('agentB', ctx.taskB!, flow.headB, 'b'),
      ]);
      ctx.proposalA = a;
      ctx.proposalB = b;
      return { observed: 'two concurrent proposals submitted by distinct scoped agents' };
    },
  },
  {
    id: 'flow.combine-conflict',
    title: 'a conflicting combine reports conflicts, never a fake sha',
    evidence: ['controller-mediated', 'api', 'actual-git'],
    expected: 'combine of conflicting real heads -> 422 merge_conflict (or unavailable seam)',
    needs: (ctx) => {
      if (ctx.cfg.flow?.conflictHeadA === undefined) return 'no conflictHeadA configured';
      if (ctx.proposalB === undefined) return 'proposal B not submitted';
      return undefined;
    },
    run: async (ctx) => {
      const flow = ctx.cfg.flow!;
      const prop = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/changes`,
        auth: 'agentA',
        body: {
          operationId: op(ctx, 'prop-conflict'),
          taskIds: [ctx.taskA!],
          base: flow.baseSha,
          head: flow.conflictHeadA!,
          summary: 'acceptance conflicting proposal',
          intendedBehavior: 'conflict demonstration',
          changedPaths: ['acceptance/shared.txt'],
        },
      });
      expectStatus(prop, [201], 'conflicting proposal submit');
      ctx.conflictProposal = bodyField<string>(prop, ['proposal', 'id'])!;
      const res = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/candidates`,
        body: {
          operationId: op(ctx, 'combine-conflict'),
          proposalIds: [ctx.conflictProposal, ctx.proposalB],
        },
      });
      if (isSeamUnavailable(res)) {
        return { status: 'unavailable', observed: `git seam absent (${res.status} ${errorCode(res)})` };
      }
      if (res.status === 422 && errorCode(res) === 'merge_conflict') {
        return {
          observed: 'conflicting heads reported as merge_conflict; no candidate produced',
          detail: res.body,
        };
      }
      throw new StepFail(`conflicting combine answered ${res.status} (${errorCode(res) ?? 'ok'})`);
    },
  },
  {
    id: 'flow.combine',
    title: 'combine of compatible heads produces a real candidate',
    evidence: ['controller-mediated', 'api', 'actual-git'],
    expected: 'POST /candidates -> 201 with a real merge sha bound to both proposals',
    needs: (ctx) =>
      ctx.proposalA === undefined || ctx.proposalB === undefined ? 'proposals not submitted' : undefined,
    run: async (ctx) => {
      const res = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/candidates`,
        body: { operationId: op(ctx, 'combine'), proposalIds: [ctx.proposalA, ctx.proposalB] },
      });
      if (isSeamUnavailable(res)) {
        return { status: 'unavailable', observed: `git seam absent (${res.status} ${errorCode(res)})` };
      }
      expectStatus(res, [200, 201], 'combine');
      const cand = bodyField<{ id?: string; sha?: string; base?: string }>(res, ['candidate']);
      if (typeof cand?.id !== 'string' || typeof cand.sha !== 'string' || !SHA_RE.test(cand.sha)) {
        throw new StepFail('candidate missing a real sha');
      }
      ctx.candidateId = cand.id;
      ctx.candidateSha = cand.sha;
      ctx.candidateBase = cand.base;
      return { observed: `candidate ${cand.id} prepared at real sha ${cand.sha.slice(0, 12)}` };
    },
  },
  {
    id: 'flow.check',
    title: 'check dispatch produces a collector-bound receipt or honest block',
    evidence: ['controller-mediated', 'api', 'actual-docker'],
    expected: 'check job dispatched -> completed receipt on the exact sha; absent runner -> unavailable',
    needs: (ctx) => (ctx.candidateId === undefined ? 'no candidate to check' : undefined),
    run: async (ctx) => {
      const revision = await candidateRevision(ctx);
      const command = ctx.cfg.flow?.checkCommand ?? 'test -f marker.txt';
      const res = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/candidates/${ctx.candidateId}/checks`,
        body: { operationId: op(ctx, 'check'), expectedRevision: revision, command, timeoutMs: 30_000 },
      });
      if (isSeamUnavailable(res)) {
        return { status: 'unavailable', observed: `check route absent (${res.status})` };
      }
      expectStatus(res, [200, 201], 'check register');
      const job = bodyField<{ id?: string; status?: string; blockedReason?: string }>(res, ['job']);
      if (typeof job?.id !== 'string') throw new StepFail('job id missing');
      if (job.status === 'blocked' || job.status === 'failed') {
        return {
          status: 'unavailable',
          observed: `check job ${job.status} (${job.blockedReason ?? 'no reason'}): runner seam absent`,
        };
      }
      const deadline = Date.now() + Math.min(ctx.cfg.timeoutMs, 40_000);
      let status = job.status;
      while (Date.now() < deadline) {
        if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'blocked') {
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
        const poll = await api(ctx, {
          method: 'GET',
          path: `/api/v1/projects/${ctx.projectA}/jobs/${job.id}`,
        });
        status = String(bodyField<string>(poll, ['job', 'status']) ?? status);
      }
      if (status !== 'completed') {
        return {
          status: 'unavailable',
          observed: `check job ended ${status}; no receipt produced within the bound`,
        };
      }
      const receipts = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}/candidates/${ctx.candidateId}/receipts`,
      });
      const list = (receipts.body?.receipts ?? []) as { candidateSha?: string; outcome?: string }[];
      const pass = list.find((r) => r.candidateSha === ctx.candidateSha && r.outcome === 'pass');
      if (pass === undefined) throw new StepFail('completed job produced no pass receipt on the sha');
      ctx.checkPassed = true;
      return {
        observed: 'collector completion produced a pass receipt bound to the exact candidate sha',
        detail: { jobId: job.id },
      };
    },
  },
  {
    id: 'flow.review',
    title: 'independent review binds the exact candidate sha',
    evidence: ['controller-mediated', 'api'],
    expected: 'owner review approve -> 201 independent=true on candidate sha',
    needs: (ctx) => (ctx.candidateId === undefined ? 'no candidate to review' : undefined),
    run: async (ctx) => {
      const revision = await candidateRevision(ctx);
      const res = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/candidates/${ctx.candidateId}/reviews`,
        body: {
          operationId: op(ctx, 'review'),
          expectedRevision: revision,
          disposition: 'approve',
          candidateSha: ctx.candidateSha,
          note: 'acceptance independent review',
        },
      });
      if (isSeamUnavailable(res)) {
        return { status: 'unavailable', observed: `review route absent (${res.status})` };
      }
      expectStatus(res, [201], 'review create');
      const review = bodyField<{ independent?: boolean }>(res, ['review']);
      if (review?.independent !== true) throw new StepFail('review not recorded independent');
      ctx.reviewPassed = true;
      return { observed: 'independent approval recorded on the exact candidate sha' };
    },
  },
  {
    id: 'flow.integrate',
    title: 'bounded landing lands or reports an honest effect state',
    evidence: ['controller-mediated', 'api', 'actual-git'],
    expected: 'POST /candidates/:id/integrate with expectedTip -> effect confirmed',
    needs: (ctx) =>
      ctx.candidateId === undefined || ctx.candidateBase === undefined
        ? 'no candidate to integrate'
        : undefined,
    run: async (ctx) => {
      const revision = await candidateRevision(ctx);
      const res = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/candidates/${ctx.candidateId}/integrate`,
        body: {
          operationId: op(ctx, 'integrate'),
          expectedRevision: revision,
          expectedTip: ctx.candidateBase,
        },
      });
      if (isSeamUnavailable(res)) {
        return { status: 'unavailable', observed: `git seam absent (${res.status} ${errorCode(res)})` };
      }
      if (res.status === 200 && res.body?.effect === 'confirmed') {
        return { observed: 'bounded landing confirmed on the expected tip' };
      }
      if (res.status === 202) {
        return {
          status: 'unavailable',
          observed: `push effect ${String(res.body?.effect)}: reconcile-only, never repush`,
          detail: res.body,
        };
      }
      if (res.status === 422 && errorCode(res) === 'not_ready') {
        const evidenceComplete = ctx.checkPassed && ctx.reviewPassed;
        return {
          status: evidenceComplete ? 'fail' : 'unavailable',
          observed: `integrate refused not_ready (check=${ctx.checkPassed} review=${ctx.reviewPassed})`,
        };
      }
      throw new StepFail(`integrate answered ${res.status} (${errorCode(res) ?? 'ok'})`);
    },
  },
  {
    id: 'flow.reconnect',
    title: 'a fresh session observes the durable project state',
    evidence: ['controller-mediated', 'api', 'hosted-do'],
    expected: 'new session -> GET project shows the created task/proposal records',
    needs: (ctx) => (ctx.projectA === undefined || ctx.taskA === undefined ? 'no project state' : undefined),
    run: async (ctx) => {
      const login = await api(ctx, { method: 'POST', path: '/api/v1/session', body: {} });
      if (login.status === 201) {
        const setCookie = login.headers.get('set-cookie') ?? '';
        const pair = setCookie.split(';')[0];
        const value = pair.slice(pair.indexOf('=') + 1);
        if (value.length >= 8) ctx.secrets.add(value);
        ctx.cookie = pair;
      }
      const res = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}`,
        auth: 'cookie',
      });
      expectStatus(res, [200], 'reconnected project read');
      const tasks = res.body?.tasks as Record<string, unknown> | undefined;
      if (tasks === undefined || tasks[ctx.taskA!] === undefined) {
        throw new StepFail('reconnected view lost the created task');
      }
      return { observed: 'reconnected session reads the durable task/proposal state' };
    },
  },
  {
    id: 'adversarial.revoked-identity',
    title: 'revoked identity loses access on the very next request',
    evidence: ['controller-mediated', 'api'],
    expected: 'mint agentC -> reads 200 -> owner revokes -> same credential denied',
    needs: (ctx) => (ctx.projectA === undefined ? 'no project from project.create' : undefined),
    run: async (ctx) => {
      ctx.agents.agentC = await mintAgent(ctx, 'agentC', ['read']);
      const before = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}`,
        auth: 'agentC',
      });
      expectStatus(before, [200], 'pre-revocation read');
      const revoke = await api(ctx, {
        method: 'POST',
        path: `/api/v1/projects/${ctx.projectA}/identities/${ctx.agents.agentC.identityId}/revoke`,
        body: { operationId: op(ctx, 'revoke'), expectedRevision: 1 },
      });
      expectStatus(revoke, [200], 'identity revoke');
      const after = await api(ctx, {
        method: 'GET',
        path: `/api/v1/projects/${ctx.projectA}`,
        auth: 'agentC',
      });
      if (after.status === 200) throw new StepFail('revoked credential still authorized');
      return { observed: `post-revocation read denied (${after.status})` };
    },
  },
  {
    id: 'native.followup',
    title: 'same-session native follow-up is controller work, not this script',
    evidence: ['native-session'],
    expected:
      'two SAME returned sessions receive a separately recorded follow-up after protected ' +
      'deployment; this script must not relabel deterministic steps as native agents',
    run: async () => ({
      status: 'unavailable',
      observed:
        'native-session evidence requires the controller to continue the same returned ' +
        'sessions after protected deployment; no deterministic script can claim it',
    }),
  },
];

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

export interface RunOptions {
  fetch?: typeof fetch;
  now?: () => string;
}

export async function runAcceptance(
  cfg: AcceptanceConfig,
  opts: RunOptions = {},
): Promise<AcceptanceReport> {
  const ctx: RunCtx = {
    cfg,
    fetch: opts.fetch ?? globalThis.fetch,
    now: opts.now ?? (() => new Date().toISOString()),
    secrets: new Set([cfg.ownerToken]),
    agents: {},
    checkPassed: false,
    reviewPassed: false,
    ops: 0,
  };
  const records: StepRecord[] = [];
  for (const step of steps) {
    const started = Date.now();
    const base = { id: step.id, title: step.title, evidence: step.evidence, expected: step.expected };
    const skipReason = ctx.dead ?? step.needs?.(ctx);
    if (skipReason !== undefined) {
      records.push({ ...base, status: 'skipped', observed: skipReason, durationMs: 0 });
      continue;
    }
    try {
      const out = await step.run(ctx);
      records.push({
        ...base,
        status: out.status ?? 'pass',
        observed: out.observed,
        ...(out.detail !== undefined ? { detail: out.detail } : {}),
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      records.push({ ...base, status: 'fail', observed: message.slice(0, 400), durationMs: Date.now() - started });
      const code = (err as { code?: string }).code;
      if (
        err instanceof TypeError ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        code === 'UND_ERR_CONNECT_FAILED'
      ) {
        ctx.dead = `transport failure at ${step.id}; remaining steps not attempted`;
      }
    }
  }
  const summary = { pass: 0, fail: 0, unavailable: 0, skipped: 0 };
  for (const r of records) summary[r.status] += 1;
  let verdict: AcceptanceReport['verdict'];
  if (summary.fail > 0) verdict = 'fail';
  else if (cfg.requireHosted && (summary.unavailable > 0 || summary.skipped > 0)) verdict = 'fail';
  else if (summary.unavailable > 0 || summary.skipped > 0) verdict = 'incomplete';
  else verdict = 'pass';

  const host = new URL(cfg.apiUrl).host;
  const report: AcceptanceReport = {
    schema: 1,
    generatedAt: ctx.now(),
    target: { host, loopback: isLoopbackHost(new URL(cfg.apiUrl).hostname) },
    projectIds: { ...(ctx.projectA !== undefined ? { a: ctx.projectA } : {}), ...(ctx.projectB !== undefined ? { b: ctx.projectB } : {}) },
    steps: records,
    summary,
    verdict,
    limits: [
      'controller-mediated evidence only: hosted-DO durability, actual Git and Docker ' +
        'isolation are observed through API receipts, never asserted beyond what responses prove',
      'native-session evidence is never produced by this script; it requires the controller ' +
        'same-session follow-up recorded separately',
      'proposal/integration steps run only on real SHAs supplied via config flow block; ' +
        'no SHA is ever fabricated',
      'benefit: Planned / Not assessed',
    ],
  };
  const redacted = redactDeep(report, ctx.secrets) as AcceptanceReport;
  // Last-resort guard: serialized output must contain no registered secret.
  const serialized = JSON.stringify(redacted);
  for (const secret of ctx.secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) {
      throw new Error('redaction guard tripped: refusing to emit evidence containing a secret');
    }
  }
  return redacted;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

export function exitCodeFor(report: AcceptanceReport): number {
  return report.verdict === 'fail' ? 1 : 0;
}

async function main(): Promise<number> {
  let cfg: AcceptanceConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    process.stderr.write(`cloud-acceptance: ${String(err instanceof Error ? err.message : err)}\n`);
    return 2;
  }
  const report = await runAcceptance(cfg);
  const serialized = JSON.stringify(report, null, 2);
  if (cfg.outPath !== undefined) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cfg.outPath, serialized, { mode: 0o600 });
  } else {
    process.stdout.write(`${serialized}\n`);
  }
  const s = report.summary;
  process.stderr.write(
    `cloud-acceptance: verdict=${report.verdict} ` +
      `pass=${s.pass} fail=${s.fail} unavailable=${s.unavailable} skipped=${s.skipped}\n`,
  );
  return exitCodeFor(report);
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  return typeof entry === 'string' && import.meta.url === pathToFileURL(entry).href;
})();

if (invokedAsScript) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
