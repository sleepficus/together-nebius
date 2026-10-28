import {CHAT_SCOPES,normalizeName,RESERVED_NAMES} from './conversation-types.ts';
// Scoped identity, enrollment and authentication for the Together slice
// (seat b-swe-03). Stable agent identities are created by the owner (or a
// bounded delegated-enrollment scope); enrollment exchanges a single-use,
// expiring invitation token for a revocable credential whose hash is stored
// -- the plaintext secret is returned once and never persisted, including in
// stored operation results. authenticate() resolves every request to a
// server-side Principal; there is no public registration path and
// actor/display names never authorize anything.
//
// Authenticated setup contract (enumerated scopes):
//   read              member read of safe project state
//   identity:admin    create/revoke identities, invitations, credentials
//   identity:delegate bounded delegated enrollment: children of the caller
//                     only, narrowed scopes, capped invite TTL, capped count
//   enroll            bootstrap scope presented ONLY by a pending invitation
//                     token; authorizes POST /enrollment/exchange and nothing
//                     else
//   admin/owner       reserved, minted by server config (opts.ownerTokens)
//                     only -- never grantable through invitations
//
// Owner credentials are provided by the server only: opts.ownerTokens is the
// single source of owner authority. There is no endpoint that mints owner
// principals.

import {
  appendEvent, createEnvelope, assertCreationRevision, command, digestOf, entity, fail, json, requireFields,
  requireProse, requireScope, touchEntity,
} from './core.ts';
import type {
  AgentIdentity, CollectionName, Context, Credential, Id,
  Invitation, IsoTime, Operation, Principal, ProjectState, Session,
} from './types.ts';

export const SCOPES = {
  read: 'read',
  identityAdmin: 'identity:admin',
  identityDelegate: 'identity:delegate',
  enroll: 'enroll',
} as const;

/** Scopes an invitation may never grant -- minted server-side only. */
export const RESERVED_SCOPES: readonly string[] = [
  'admin', 'owner', 'system', 'collector', 'enroll', 'identity:admin', CHAT_SCOPES.attest,
];

/** Scopes a fresh invitation carries when the caller does not specify. */
export const DEFAULT_INVITE_SCOPES: readonly string[] = [
  'read', 'tasks:write', 'tasks:claim', 'assignments:write',
];

export const DEFAULT_INVITE_TTL_MS = 15 * 60 * 1000;
export const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DELEGATE_MAX_CHILDREN = 4;
export const DELEGATE_MAX_INVITE_TTL_MS = 60 * 60 * 1000;

/** Owner principals minted from opts.ownerTokens carry these scopes. */
export const OWNER_SCOPES: readonly string[] = ['owner', 'admin', 'read'];

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function newToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Principal returned while exchanging an invitation: kind 'agent', a single
 * 'enroll' scope, and the resolved invitation/identity it may complete.
 */
export interface EnrollmentPrincipal extends Principal {
  enrollment: { invitationId: Id; identityId: Id };
}

export interface OwnerToken {
  ownerId: Id;
  /** Plaintext comparison value -- lives only in server configuration. */
  token: string;
  sessionId?: string;
  scopes?: string[];
}

export interface AuthenticateOptions {
  ownerTokens?: OwnerToken[];
  now?: () => IsoTime;
}

/**
 * Resolve `Authorization: Bearer <token>` to a server-side Principal.
 *
 * Order: server-configured owner tokens, then stored agent credential
 * hashes (identity + credential + bound session must all be active and
 * unexpired -- revocation rechecks every request), then pending invitation
 * hashes which authenticate as an exchange-only 'enroll' principal.
 * Anything else is null and the dispatcher answers 401.
 */
export async function authenticate(
  request: Request,
  state: ProjectState,
  opts?: AuthenticateOptions,
): Promise<Principal | null> {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header.trim()) : null;
  if (!match) return null;
  const token = match[1];
  const now = opts?.now?.() ?? new Date().toISOString();

  for (const owner of opts?.ownerTokens ?? []) {
    if (owner.token !== token) continue;
    return {
      id: owner.ownerId,
      sessionId: owner.sessionId ?? `owner:${owner.ownerId}`,
      kind: 'human',
      ownerId: owner.ownerId,
      scopes: [...(owner.scopes ?? OWNER_SCOPES)],
      projectIds: [state.project.id],
    };
  }

  const tokenHash = await hashToken(token);

  for (const cred of Object.values(state.credentials)) {
    if (cred.tokenHash !== tokenHash) continue;
    if (cred.status !== 'active') return null;
    if(typeof cred.runId==='string'){const run=state.runs?.[cred.runId];if(!run||!['running','paused'].includes(run.status)||cred.runEpoch!==run.epoch)return null;}
    if (cred.expiresAt !== undefined && cred.expiresAt <= now) return null;
    const identity = state.identities[cred.identityId];
    if (!identity || identity.status !== 'active') return null;
    const sessionId = typeof cred.sessionId === 'string' ? cred.sessionId : undefined;
    if (sessionId !== undefined) {
      const session = state.sessions[sessionId];
      // The bound session must exist and be live: a credential referencing
      // an absent session record (purged or never persisted) is not
      // authenticated -- otherwise revocation-by-session-loss cannot hold.
      if (session === undefined || session.status !== 'active' || session.identityId!==cred.identityId) return null;
    }
    return {
      id: cred.identityId,
      sessionId: sessionId ?? `session:${cred.id}`,
      kind: 'agent',
      ownerId: identity.ownerId,
      scopes: [...cred.scopes],
      projectIds: [...cred.projectIds],
    };
  }

  for (const inv of Object.values(state.invitations)) {
    if (inv.tokenHash !== tokenHash) continue;
    if (inv.status !== 'pending') return null;
    if (inv.expiresAt <= now) return null;
    const identityId = typeof inv.identityId === 'string' ? inv.identityId : undefined;
    if (identityId === undefined) return null;
    const identity = state.identities[identityId];
    if (!identity || identity.status !== 'active') return null;
    const principal: EnrollmentPrincipal = {
      id: identityId,
      sessionId: `enroll:${inv.id}`,
      kind: 'agent',
      ownerId: identity.ownerId,
      scopes: [SCOPES.enroll],
      projectIds: [...inv.projectIds],
      enrollment: { invitationId: inv.id, identityId },
    };
    return principal;
  }

  return null;
}

type SecretApplyResult = { status: number; safeBody: unknown; freshBody: unknown };

type SecretOutcome =
  | { fresh: true; status: number; freshBody: unknown }
  | { fresh: false; result: { status: number; body: unknown } };

/**
 * command() variant for endpoints whose response returns a secret exactly
 * once (invitation tokens, credential plaintext). The durable operation
 * record stores `safeBody` (secret redacted); only the first successful
 * commit returns `freshBody`. Replays return the redacted result -- the
 * secret is never persisted, exported or replayed.
 */
async function transactSecret(
  ctx: Context,
  scope: string,
  target: { collection: 'project' | CollectionName; id?: Id },
  body: Record<string, unknown>,
  digestBody: Record<string, unknown>,
  apply: (draft: ProjectState) => SecretApplyResult,
): Promise<Response> {
  const operationId = body.operationId;
  if (typeof operationId !== 'string' || operationId.length === 0) {
    fail(422, 'missing_operation', 'operationId is required for write operations');
  }
  const digest = await digestOf({ scope, target, body: digestBody });
  const outcome = await ctx.store.transact((draft): SecretOutcome => {
    requireScope(ctx.principal, scope, draft);
    const prior = draft.operations[operationId] as Operation | undefined;
    if (prior) {
      if (prior.importedUnverified) fail(409, 'imported_operation', 'archived operations cannot be replayed or resumed; use a new operationId for current work');
      if (prior.digest !== digest) {
        fail(409, 'conflicting_operation', 'operationId reused with a different payload', {
          nextAction: 'use a new operationId',
        });
      }
      if (prior.result) {
        return { fresh: false, result: prior.result as { status: number; body: unknown } };
      }
      return {
        fresh: false,
        result: {
          status: 202,
          body: {
            operationId,
            effect: prior.effect,
            nextAction: `GET /api/v1/projects/${draft.project.id}/operations/${operationId}`,
          },
        },
      };
    }
    assertCreationRevision(body);
    const applied = apply(draft);
    if (applied.status >= 400) fail(applied.status, 'domain_rejected', 'operation rejected');
    if (target.collection === 'project') {
      touchEntity(draft.project, ctx, ctx.principal.id);
    } else if (target.id !== undefined) {
      touchEntity(entity(draft, target.collection, target.id), ctx, ctx.principal.id);
    }
    const now = ctx.now();
    const op: Operation = {
      id: operationId,
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: ctx.principal.id,
      scope,
      target,
      digest,
      intent: typeof body.intent === 'string' ? body.intent : scope,
      effect: 'confirmed',
      result: { status: applied.status, body: applied.safeBody },
    };
    draft.operations[operationId] = op;
    appendEvent(draft, ctx, `operation:${scope}`, target.id ?? draft.project.id, {
      operationId,
      collection: target.collection,
      status: applied.status,
    });
    return { fresh: true, status: applied.status, freshBody: applied.freshBody };
  });
  if (outcome.fresh === true) return json(outcome.status, outcome.freshBody);
  return json(outcome.result.status, outcome.result.body);
}


function hasIdentityAdmin(principal: Principal): boolean {
  return (
    principal.kind === 'system' ||
    principal.scopes.includes('admin') ||
    principal.scopes.includes(SCOPES.identityAdmin)
  );
}

function publicIdentity(i: AgentIdentity): Record<string, unknown> {
  return {
    id: i.id,
    revision: i.revision,
    displayName: i.displayName,
    ownerId: i.ownerId,
    creationSource: i.creationSource,
    status: i.status,
    parentId: i.parentId,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

function validateScopeList(value: unknown): string[] {
  if (!Array.isArray(value)) fail(422, 'invalid_field', 'scopes must be an array');
  return value.map((s) => {
    if (typeof s !== 'string' || s.length === 0 || s.length > 128) {
      fail(422, 'invalid_field', 'invalid scope entry');
    }
    return s;
  });
}

/**
 * Module handler for identity/enrollment endpoints. Segments are the suffix
 * after /api/v1/projects/:projectId. Returns null for unowned routes.
 * Credentials and invitations are never listed or returned -- only their
 * hashes exist in state and they are stripped from every safe view anyway.
 */
export async function handleIdentity(
  ctx: Context,
  request: Request,
  segments: string[],
  body?: Record<string, unknown>,
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (method === 'GET' && segments.length === 1 && segments[0] === 'identities') {
    const state = await ctx.store.read();
    requireScope(ctx.principal, SCOPES.read, state);
    return json(200, {
      identities: Object.values(state.identities).map(publicIdentity),
      sessions: Object.values(state.sessions).map((s) => ({
        id: s.id,
        identityId: s.identityId,
        adapter: s.adapter,
        model: s.model,
        provider: s.provider,
        harness: s.harness,
        host: s.host,
        status: s.status,
        lastActivityAt: s.lastActivityAt,
      })),
    });
  }

  if (method === 'POST' && segments.length === 1 && segments[0] === 'identities' && body) {
    return createIdentity(ctx, body);
  }

  if (method === 'POST' && segments.length === 3 && segments[0] === 'identities' && segments[2] === 'invitations' && body) {
    return createInvitation(ctx, segments[1], body);
  }

  if (method === 'POST' && segments.length === 3 && segments[0] === 'identities' && segments[2] === 'revoke' && body) {
    const identityId = segments[1];
    return command(ctx, body, SCOPES.identityAdmin, { collection: 'identities', id: identityId }, (draft) => {
      const identity = entity<AgentIdentity>(draft, 'identities', identityId);
      identity.status = 'revoked';
      let revokedRecords = 0;
      for (const cred of Object.values(draft.credentials)) {
        if (cred.identityId === identity.id && cred.status === 'active') {
          cred.status = 'revoked';
          touchEntity(cred, ctx, ctx.principal.id);
          revokedRecords += 1;
        }
      }
      for (const s of Object.values(draft.sessions)) {
        if (s.identityId === identity.id && s.status === 'active') {
          s.status = 'revoked';
          touchEntity(s, ctx, ctx.principal.id);
          revokedRecords += 1;
        }
      }
      appendEvent(draft, ctx, 'identity:revoked', identity.id, { revokedRecords });
      return { status: 200, body: { identity: publicIdentity(identity), revokedRecords } };
    });
  }

  if (method === 'POST' && segments.length === 3 && segments[0] === 'credentials' && segments[2] === 'revoke' && body) {
    const credentialId = segments[1];
    return command(ctx, body, SCOPES.identityAdmin, { collection: 'credentials', id: credentialId }, (draft) => {
      const cred = entity<Credential>(draft, 'credentials', credentialId);
      if (cred.status !== 'active') fail(409, 'already_revoked', 'credential is not active');
      cred.status = 'revoked';
      const sessionId = typeof cred.sessionId === 'string' ? cred.sessionId : undefined;
      if (sessionId !== undefined && draft.sessions[sessionId]?.status === 'active') {
        draft.sessions[sessionId].status = 'revoked';
        touchEntity(draft.sessions[sessionId], ctx, ctx.principal.id);
      }
      appendEvent(draft, ctx, 'credential:revoked', cred.id, { identityId: cred.identityId });
      return { status: 200, body: { credentialId: cred.id, status: 'revoked' } };
    });
  }

  if (method === 'POST' && segments.length === 2 && segments[0] === 'enrollment' && segments[1] === 'exchange' && body) {
    return exchangeInvitation(ctx, body);
  }

  return null;
}

async function createIdentity(ctx: Context, body: Record<string, unknown>): Promise<Response> {
  requireFields(body, ['displayName']);
  const displayName = requireProse(body.displayName, 'displayName');
  const parentId = typeof body.parentId === 'string' ? body.parentId : undefined;
  const creationSource =
    body.creationSource === undefined ? 'manual' : requireProse(body.creationSource, 'creationSource');
  const p = ctx.principal;
  const isAdmin = hasIdentityAdmin(p);
  // Delegated enrollment uses its own scope so the denial is explicit:
  // without identity:admin or identity:delegate, creating identities is
  // unavailable -- never silently permitted.
  const scope = isAdmin ? SCOPES.identityAdmin : SCOPES.identityDelegate;
  if(!isAdmin&&RESERVED_NAMES.has(normalizeName(displayName)))fail(403,'reserved_name','Crew and human names are managed by the owner');
  return command(ctx, body, scope, { collection: 'identities' }, (draft) => {
    let parent: AgentIdentity | undefined;
    if (parentId !== undefined) {
      parent = entity<AgentIdentity>(draft, 'identities', parentId);
      if (parent.status !== 'active') fail(409, 'identity_revoked', 'parent identity is not active');
      if (!isAdmin) {
        if (parentId !== p.id) {
          fail(403, 'scope_denied', 'delegated enrollment may only create children of the caller');
        }
        const children = Object.values(draft.identities).filter((i) => i.parentId === p.id);
        if (children.length >= DELEGATE_MAX_CHILDREN) {
          fail(429, 'limit_exceeded', `delegated child limit ${DELEGATE_MAX_CHILDREN} reached`, {
            retryable: false,
          });
        }
      }
    } else if (!isAdmin) {
      fail(403, 'scope_denied', 'delegated enrollment must name the caller as parentId');
    }
    const now = ctx.now();
    const identity: AgentIdentity = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: p.id,
      displayName,
      ownerId: parent?.ownerId ?? p.ownerId,
      creationSource: parentId !== undefined ? 'delegated' : creationSource,
      status: 'active',
      ...(parentId !== undefined ? { parentId } : {}),
    };
    draft.identities[identity.id] = identity;
    appendEvent(draft, ctx, 'identity:created', identity.id, { displayName, parentId });
    return { status: 201, body: { identity: publicIdentity(identity) } };
  });
}

async function createInvitation(
  ctx: Context,
  identityId: Id,
  body: Record<string, unknown>,
): Promise<Response> {
  const p = ctx.principal;
  const isAdmin = hasIdentityAdmin(p);
  const scope = isAdmin ? SCOPES.identityAdmin : SCOPES.identityDelegate;
  const token = newToken('inv');
  const tokenHash = await hashToken(token);
  const envelope = createEnvelope(body);
  return transactSecret(ctx, scope, { collection: 'invitations' }, envelope, envelope, (draft) => {
    const identity = entity<AgentIdentity>(draft, 'identities', identityId);
    if (identity.status !== 'active') fail(409, 'identity_revoked', 'identity is not active');
    if (!isAdmin && identity.parentId !== p.id) {
      fail(403, 'scope_denied', 'delegated enrollment may only invite for own child identities');
    }
    const requested =
      body.scopes === undefined ? [...DEFAULT_INVITE_SCOPES] : validateScopeList(body.scopes);
    const reserved = requested.filter((s) => RESERVED_SCOPES.includes(s));
    if (reserved.length > 0) {
      fail(422, 'scope_not_grantable', `reserved scopes cannot be granted: ${reserved.join(', ')}`);
    }
    if (!isAdmin) {
      // identity:delegate is reserved for non-admin issuers: a delegated
      // enrollment authority necessarily holds it, so without this check
      // every generation could re-delegate and the per-parent child cap
      // would only bound one level (4^depth aggregate growth).
      const redelegated = requested.filter((s) => s === SCOPES.identityDelegate);
      if (redelegated.length > 0) {
        fail(422, 'scope_not_grantable',
          'identity:delegate cannot be granted by a delegated issuer; only owner/admin may re-delegate enrollment');
      }
      const notHeld = requested.filter((s) => !p.scopes.includes(s));
      if (notHeld.length > 0) {
        fail(422, 'scope_not_delegable', `caller does not hold: ${notHeld.join(', ')}`);
      }
    }
    const ttlCap = isAdmin ? MAX_INVITE_TTL_MS : DELEGATE_MAX_INVITE_TTL_MS;
    let expiresAt: IsoTime;
    if (typeof body.expiresAt === 'string') {
      if (Number.isNaN(Date.parse(body.expiresAt))) {
        fail(422, 'invalid_field', 'expiresAt must be an ISO timestamp');
      }
      expiresAt = body.expiresAt;
      if (Date.parse(expiresAt) - Date.parse(ctx.now()) > ttlCap) {
        fail(422, 'ttl_exceeds_limit', `expiresAt exceeds the ${ttlCap}ms invitation cap`);
      }
    } else {
      const ttlMs = typeof body.ttlMs === 'number' ? body.ttlMs : DEFAULT_INVITE_TTL_MS;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail(422, 'invalid_field', 'ttlMs must be positive');
      if (ttlMs > ttlCap) {
        fail(422, 'ttl_exceeds_limit', `ttlMs exceeds the ${ttlCap}ms invitation cap`);
      }
      expiresAt = new Date(Date.parse(ctx.now()) + ttlMs).toISOString();
    }
    const now = ctx.now();
    const inv: Invitation = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: p.id,
      identityId,
      tokenHash,
      scopes: requested,
      projectIds: [draft.project.id],
      expiresAt,
      status: 'pending',
      ...(typeof body.label === 'string' ? { label: requireProse(body.label, 'label') } : {}),
    };
    if (body.credentialExpiresAt !== undefined) {
      const expiry = typeof body.credentialExpiresAt === 'string' ? Date.parse(body.credentialExpiresAt) : NaN;
      if (!Number.isFinite(expiry) || expiry <= Date.parse(now) || expiry - Date.parse(now) > MAX_CREDENTIAL_TTL_MS) {
        fail(422, 'invalid_credential_expiry', 'credentialExpiresAt must be a future timestamp within thirty days');
      }
      inv.credentialExpiresAt = new Date(expiry).toISOString();
    }
    draft.invitations[inv.id] = inv;
    appendEvent(draft, ctx, 'invitation:created', identity.id, {
      invitationId: inv.id,
      expiresAt,
      scopes: inv.scopes,
    });
    const safeBody = {
      invitationId: inv.id,
      identityId,
      scopes: inv.scopes,
      projectIds: inv.projectIds,
      expiresAt,
      ...(inv.credentialExpiresAt ? { credentialExpiresAt: inv.credentialExpiresAt } : {}),
      tokenRedacted: true,
    };
    return { status: 201, safeBody, freshBody: { ...safeBody, token } };
  });
}

async function exchangeInvitation(ctx: Context, body: Record<string, unknown>): Promise<Response> {
  const principal = ctx.principal as EnrollmentPrincipal;
  const enrollment = principal.enrollment;
  if (!enrollment) {
    fail(403, 'not_enrollment', 'exchange requires a pending invitation token principal');
  }
  const token = newToken('cred');
  const tokenHash = await hashToken(token);
  // The resolved invitation participates in the digest so two different
  // invitation tokens can never collide on one operationId.
  const envelope = createEnvelope(body);
  const digestBody = { ...envelope, invitationId: enrollment.invitationId };
  return transactSecret(ctx, SCOPES.enroll, { collection: 'credentials' }, envelope, digestBody, (draft) => {
    const inv = entity<Invitation>(draft, 'invitations', enrollment.invitationId);
    const identity = entity<AgentIdentity>(draft, 'identities', enrollment.identityId);
    if (identity.status !== 'active') fail(403, 'identity_revoked', 'identity is revoked');
    const now = ctx.now();
    if (inv.status !== 'pending') {
      fail(409, 'invitation_used', 'invitation is already used, expired or revoked');
    }
    if (inv.expiresAt <= now) {
      inv.status = 'expired';
      touchEntity(inv, ctx, principal.id);
      fail(409, 'invitation_expired', 'invitation has expired');
    }
    if (inv.credentialExpiresAt !== undefined && inv.credentialExpiresAt <= now) {
      fail(409, 'credential_window_expired', 'The issuer-selected credential window has expired; ask the owner for a new invitation');
    }
    const session: Session = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: identity.id,
      identityId: identity.id,
      ...(typeof body.adapter === 'string' ? { adapter: body.adapter } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      ...(typeof body.harness === 'string' ? { harness: body.harness } : {}),
      ...(typeof body.host === 'string' ? { host: body.host } : {}),
      advertisedCapabilities: Array.isArray(body.advertisedCapabilities)
        ? body.advertisedCapabilities.filter((c): c is string => typeof c === 'string').slice(0, 32)
        : [],
      observedCapabilities: [],
      lastActivityAt: now,
      lastActivitySource: 'enrollment-exchange',
      status: 'active',
    };
    draft.sessions[session.id] = session;
    if (!Object.values(draft.members).some(m => m.identityId === identity.id)) {
      const memberId = `member-${identity.id}`;
      draft.members[memberId] = { id:memberId, projectId:draft.project.id, revision:1, createdAt:now, updatedAt:now, actorId:identity.id, identityId:identity.id, kind:'collaborator', scopes:[...inv.scopes] };
    }
    const cred: Credential = {
      id: ctx.uid(),
      projectId: draft.project.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      actorId: identity.id,
      identityId: identity.id,
      sessionId: session.id,
      tokenHash,
      scopes: [...inv.scopes],
      projectIds: [...inv.projectIds],
      ...(inv.credentialExpiresAt ? { expiresAt: inv.credentialExpiresAt } : {}),
      status: 'active',
    };
    draft.credentials[cred.id] = cred;
    inv.status = 'exchanged';
    inv.exchangedById = identity.id;
    touchEntity(inv, ctx, principal.id);
    appendEvent(draft, ctx, 'identity:enrolled', identity.id, {
      credentialId: cred.id,
      sessionId: session.id,
      invitationId: inv.id,
    });
    const safeBody = {
      credentialId: cred.id,
      sessionId: session.id,
      identityId: identity.id,
      scopes: cred.scopes,
      projectIds: cred.projectIds,
      ...(cred.expiresAt ? { expiresAt: cred.expiresAt } : {}),
      tokenRedacted: true,
    };
    return { status: 201, safeBody, freshBody: { ...safeBody, token } };
  });
}
