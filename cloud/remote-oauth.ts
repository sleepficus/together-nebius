import {WORK_SCOPES} from '../adapters/work-tools.ts';
import {OAuthProvider} from '@cloudflare/workers-oauth-provider';
import {remoteMcpRequest} from './remote-mcp.ts';
import type {RemoteConsent} from './remote-mcp.ts';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
export interface RemoteDependencies {
 resolveOwner:(r:Request,e:any)=>Promise<{id:string;ownerId:string}|null>;
 ownerSetup:(r:Request,e:any,projectId:string)=>Promise<any>;
 apiFetch:(r:Request,e:any,p:RemoteConsent)=>Promise<Response>;
 fallback:(r:Request,e:any,c:any)=>Promise<Response>;
}
export function remoteOAuthProvider(origin:string,deps:RemoteDependencies){
 const u=new URL(origin);if(u.origin!==origin||u.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(u.hostname))throw Error('Configured OAuth origin must be canonical HTTPS or local emulation');
 return new OAuthProvider<any>({onError:()=>undefined,apiRoute:'/mcp',authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',resourceMetadata:{resource:origin+'/mcp',authorization_servers:[origin]},requiredScopes:['read'],scopesSupported:[...WORK_SCOPES],accessTokenTTL:600,refreshTokenTTL:86400,clientIdMetadataDocumentEnabled:false,
 apiHandler:{async fetch(request,env,ctx:any){
  const props=ctx.props as RemoteConsent;if(!props||!ctx.auth?.scope?.includes('read'))return new Response('Missing scope',{status:403});
  // Intersect token scope with the exact owner-approved app scope; never forward OAuth bearer.
  const consent={...props,scopes:props.scopes.filter(x=>ctx.auth.scope.includes(x))};
  if(!env.MCP_PRINCIPAL_LIMITER||!(await env.MCP_PRINCIPAL_LIMITER.limit({key:consent.projectId+':'+consent.identityId+':'+consent.sessionId})).success)return new Response('Rate limited or limiter not configured',{status:429});
  return remoteMcpRequest(request,{origin,consent,apiFetch:(r,p)=>deps.apiFetch(r,env,p)});
 }},
 defaultHandler:{async fetch(request,env,ctx){
  if(new URL(request.url).pathname!=='/authorize')return deps.fallback(request,env,ctx);
  const owner=await deps.resolveOwner(request,env);if(!owner)return new Response('Sign into Together first, then restart connection authorization.',{status:401});
  const oauth=env.OAUTH_PROVIDER;
  try{
   if(request.method==='GET'){
    const auth=await oauth.parseAuthRequest(request),details=await oauth.describeConsent(auth),consent=await oauth.beginConsent(auth);consent.headers.set('Content-Type','text/html; charset=utf-8');
    return new Response(`<!doctype html><meta charset="utf-8"><title>Together consent</title><h1>Connect ${escape(details.clientName)}</h1><p>Client name is not proof of identity. Redirect: ${escape(details.redirectHost)}${details.redirectIsLoopback?' (local app)':''}.</p><p>One existing Together project and scoped grant. No agent launch. Messages may enter host transcripts. Access token10 minutes, consent at most24 hours and no longer than the selected grant.</p><form method="post"><input type="hidden" name="handle" value="${escape(consent.handle)}"><label>Project ID<input name="projectId" required></label><label>Existing scoped grant ID (not token)<input name="credentialId" required></label>${details.scope.map((s:string)=>`<label><input type="checkbox" name="scope" value="${escape(s)}" checked>${escape(s)}</label>`).join('')}<label><input type="checkbox" name="workProfile" value="yes">Enable ordinary-work tool profile using only the selected existing grant. No runtime launch, keys, host settings or deployment tools.</label><button name="decision" value="approve">Allow this client</button><button name="decision" value="deny">Deny</button></form>`,{headers:consent.headers});
   }
   if(request.method!=='POST')return new Response('Method not allowed',{status:405});
   if(request.headers.get('origin')!==origin)return new Response('Origin refused',{status:403});
   const form=await request.formData(),handle=String(form.get('handle'));
   if(form.get('decision')!=='approve'){const denied=await oauth.denyConsent(request,handle);return new Response(null,{status:302,headers:denied.headers});}
   const projectId=String(form.get('projectId')),credentialId=String(form.get('credentialId'));
   if(!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId))return new Response('Invalid project',{status:422});
   const setup=await deps.ownerSetup(request,env,projectId);const member=setup.members?.find((m:any)=>m.grants.some((g:any)=>g.id===credentialId));const grant=member?.grants.find((g:any)=>g.id===credentialId);
   if(!grant||grant.state!=='issued'||!grant.sessionId)return new Response('Existing active scoped session grant required',{status:403});
   const workProfile=form.get('workProfile')==='yes';const scopes=form.getAll('scope').map(String);if(!workProfile&&scopes.some(s=>!['read','conversation:read','conversation:write','lounge:write'].includes(s)))return new Response('Ordinary-work scopes require explicit profile selection',{status:403});if(!scopes.includes('read')||scopes.some(s=>!grant.scopes.includes(s)))return new Response('Scope exceeds grant',{status:403});
   const approved=await oauth.approveConsent(request,handle,{scope:scopes});
   const expiresAt=new Date(Math.min(Date.now()+86400000,grant.expiresAt?Date.parse(grant.expiresAt):Infinity)).toISOString();
   const props:RemoteConsent={workProfile,projectId,credentialId,identityId:member.identityId,sessionId:grant.sessionId,ownerId:owner.ownerId,scopes,expiresAt};
   const result=await oauth.completeAuthorization({request:approved.request,userId:owner.id,metadata:{projectId,credentialId},scope:scopes,props});approved.headers.set('Location',result.redirectTo);return new Response(null,{status:302,headers:approved.headers});
  }catch{return new Response('Authorization request invalid or unavailable. Restart from the original client.',{status:400});}
 }} });
}
