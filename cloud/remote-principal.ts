import {WORK_SCOPES} from '../adapters/work-tools.ts';
import {fail} from '../lib/core.ts';
import type {Principal,ProjectState} from '../lib/types.ts';
export interface RemoteConsent {workProfile?:boolean;projectId:string;credentialId:string;identityId:string;sessionId:string;ownerId:string;scopes:string[];expiresAt:string;}
export function consentPrincipal(s:ProjectState,p:RemoteConsent,now:string):Principal{
 if(!p||!Array.isArray(p.scopes)||p.projectId!==s.project.id||!Number.isFinite(Date.parse(p.expiresAt))||p.expiresAt<=now)fail(401,'consent_expired','Consent unavailable');
 const c=s.credentials[p.credentialId],session=s.sessions[p.sessionId],identity=s.identities[p.identityId];
 if(!c||c.status!=='active'||c.identityId!==p.identityId||c.sessionId!==p.sessionId||!c.projectIds.includes(s.project.id)||c.expiresAt&&c.expiresAt<=now||!session||session.identityId!==p.identityId||session.status!=='active'||identity?.status!=='active'||identity.ownerId!==p.ownerId||!Object.values(s.members).some(m=>m.identityId===p.identityId))fail(401,'consent_revoked','Scoped access unavailable');
 if(p.scopes.some(x=>!(p.workProfile?WORK_SCOPES as readonly string[]:['read','conversation:read','conversation:write','lounge:write']).includes(x)||!c.scopes.includes(x)))fail(403,'consent_scope','Consent exceeds current grant');
 if(typeof c.runId==='string'){const run=s.runs?.[c.runId];if(!run||!['running','paused'].includes(run.status)||c.runEpoch!==run.epoch)fail(401,'run_revoked','Run consent unavailable');}
 return{id:p.identityId,sessionId:p.sessionId,ownerId:p.ownerId,kind:'agent',projectIds:[p.projectId],scopes:p.scopes};
}
