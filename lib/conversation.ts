import {queueHumanAttention} from './attention.ts';
import {conversationNotice} from './inbox.ts';
import {digestOf,fail,json,requireProse,requireScope} from './core.ts';
import type {Context,Principal,ProjectState} from './types.ts';
import {CHAT_SCOPES,CREW_CREDITS,normalizeName,RESERVED_NAMES} from './conversation-types.ts';
import type {ChatProfile,Conversation,FrozenSender} from './conversation-types.ts';
import type {ConversationStore} from './conversation-store.ts';
export function currentMember(state:ProjectState,p:Principal){
 if(!p.projectIds.includes(state.project.id))fail(404,'not_found','unknown project');
 if(p.kind==='human'){if(p.id!==p.ownerId||!(p.scopes.includes('owner')||p.scopes.includes('admin')))fail(403,'owner_only','This pilot supports only its authenticated owner');return {createdAt:state.project.createdAt};}
 if(p.kind==='system')return {createdAt:state.project.createdAt};
 if(p.kind==='agent'&&(!state.sessions[p.sessionId]||state.sessions[p.sessionId].identityId!==p.id))fail(401,'session_revoked','Current authenticated session required');
 const identity=state.identities[p.id];const member=Object.values(state.members).find(m=>m.identityId===p.id);const session=state.sessions[p.sessionId];
 if(!identity||identity.status!=='active'||!member||(session&&session.status!=='active'))fail(401,'membership_revoked','current project membership required');return member;
}
export function conversationAccess(state:ProjectState,p:Principal,c:Conversation){
 const member=currentMember(state,p);if(c.audience!=='project'&&!c.audience.includes(p.id)&&p.kind!=='human')fail(404,'conversation_not_found','unknown or inaccessible conversation');return member;
}
export function requireConversation(ctx:Context):ConversationStore{if(!ctx.conversation)fail(503,'conversation_unavailable','Conversation storage is not configured');return ctx.conversation;}
function channels(store:ConversationStore,state:ProjectState){for(const kind of ['team','lounge'] as const)if(!store.conversation(kind)){store.create({id:kind,kind,audience:'project',createdAt:state.project.createdAt,nextSeq:0});for(const m of Object.values(state.members))store.join(kind,m.identityId,0,m.createdAt);}}
function frozen(p:Principal,state:ProjectState,store:ConversationStore,instance:string|null):FrozenSender{
 const profile=store.profile(p.id);const bound=profile&&profile.sessionId===p.sessionId;
 if(p.kind==='human')return{id:p.id,sessionId:p.sessionId,name:profile?.name??state.identities[p.id]?.displayName??'Project owner',mode:'human',runtimeLabel:'Human'};
 const name=state.identities[p.id]?.displayName??p.id;
 const run=Object.values(state.runs??{}).find(r=>r.identityId===p.id&&r.sessionId===p.sessionId);
 return{id:p.id,sessionId:p.sessionId,...(instance&&/^[0-9a-f-]{36}$/i.test(instance)?{adapterInstanceId:instance}:{}),...(run?.responseModel?{responseModel:run.responseModel}:{}),name:bound?profile.name:`Agent · ${name}`,mode:bound?profile.mode:(p.kind==='system'?'system':'persona'),...(bound?{runtimeLabel:profile.runtimeLabel,requestedModel:profile.requestedModel}:{runtimeLabel:'Unbound runtime'})};
}
function profilePresence(p:ChatProfile,state:ProjectState,now:string,store:ConversationStore){
 if(p.mode==='original'){
  const info=store.connectionInfo(p.identityId,p.sessionId,now);
  const access=state.identities[p.identityId]?.status==='active'&&state.sessions[p.sessionId??'']?.status==='active'&&Object.values(state.credentials).some(c=>c.identityId===p.identityId&&c.sessionId===p.sessionId&&c.status==='active'&&(!c.expiresAt||c.expiresAt>now));
  return {...p,...info,connected:Boolean(access&&info.recentConnections),observed:!access?'Together access unavailable':info.recentConnections?'Connected · checks Together when prompted':info.lastCheckedAt?'Last check is old · connection unknown':'Not connected',requestedModel:p.requestedModel??null,responseModel:null,wake:'No automatic wake-up',writesStopped:state.stopped};
 }
 const runs=Object.values(state.runs??{});const run=runs.find(r=>r.identityId===p.identityId&&r.sessionId===p.sessionId&&['running','paused'].includes(r.status));const fresh=run?.heartbeatAt&&Date.parse(now)-Date.parse(run.heartbeatAt)<120000;
 let observed=p.mode==='human'?'Human':!fresh?'Offline or unknown':p.desired==='away'?'Away':run?.waitingOnCheck?'Waiting for the check':run?.activeTurnId?'Building':'Free to chat';
 return{...p,observed,connected:Boolean(fresh),availableSince:run?.availableSince??null,requestedModel:p.requestedModel??null,responseModel:run?.responseModel??null};
}
export async function handleConversation(ctx:Context,request:Request,segments:string[],body?:Record<string,unknown>):Promise<Response|null>{
 if(!['conversations','presentation','runtime-inclusion'].includes(segments[0]))return null;
 const store=requireConversation(ctx);let state=await ctx.store.read();
 if(segments[0]==='presentation'){
  if(request.method==='GET'){requireScope(ctx.principal,CHAT_SCOPES.read,state);currentMember(state,ctx.principal);return json(200,{profiles:store.profiles().map(p=>profilePresence(p,state,ctx.now(),store)),credits:CREW_CREDITS,creditsScope:'Historical source contributors, not project participants or connected runtimes'})}
  if(request.method!=='POST')return null;
  requireScope(ctx.principal,CHAT_SCOPES.profile,state);if(ctx.principal.kind!=='human')fail(403,'owner_profile','Only the owner manages presentation');
  const b=body??{};const identityId=requireProse(b.identityId,'identityId',120);const mode=String(b.mode);if(!['human','original','persona'].includes(mode))fail(422,'profile_mode','invalid mode');
  if(mode==='human'&&identityId!==ctx.principal.id)fail(403,'human_impersonation','Only the authenticated human has a human profile');
  if(mode!=='human'&&(!state.identities[identityId]||state.identities[identityId].status!=='active'))fail(404,'identity_not_found','active identity required');
  if(mode==='original'&&(typeof b.sessionId!=='string'||state.sessions[b.sessionId]?.identityId!==identityId||state.sessions[b.sessionId]?.status!=='active'))fail(422,'original_session','Owner must attest an active, exact existing session for an original profile');
  const name=requireProse(b.name,'name',80);if(mode!=='human'&&['steve','stevehooman'].includes(normalizeName(name)))fail(403,'human_impersonation','Human names are reserved');if(mode!=='human'&&b.sessionId&&state.sessions[String(b.sessionId)]?.identityId!==identityId)fail(422,'profile_session','Session must belong to this identity');const summary=requireProse(b.summary,'summary',1000);if(!CREW_CREDITS.some(c=>c.summary===summary)&&summary!=='Project runtime helper')fail(422,'unapproved_persona_source','Use approved project contribution text');
  const portrait=typeof b.portrait==='string'?b.portrait:undefined;if(portrait&&!/^\/assets\/[a-z0-9-]+\.(png|svg)$/.test(portrait))fail(422,'portrait_path','Use an owned local portrait');
  const profile:ChatProfile={identityId,name,mode:mode as ChatProfile['mode'],summary,portrait,sessionId:typeof b.sessionId==='string'?b.sessionId:undefined,runtimeLabel:typeof b.runtimeLabel==='string'?b.runtimeLabel.slice(0,120):undefined,requestedModel:typeof b.requestedModel==='string'?b.requestedModel.slice(0,100):undefined,desired:b.desired==='away'?'away':'available'};
  return json(200,{profile:store.setProfile(profile)});
 }
 if(segments[0]==='runtime-inclusion'){
  if(request.method!=='POST')return null;
  // An agent, collector or owner cannot mint a runtime inclusion receipt.
  if(ctx.principal.kind!=='system'||!ctx.principal.scopes.includes(CHAT_SCOPES.attest))fail(403,'trusted_runtime_only','Only trusted runtime plumbing attests inclusion');
  const b=body??{};const turn=store.getRecord<any>('chat_turns',String(b.turnId));if(!turn||!['running','completed'].includes(turn.status)||turn.jobId!==b.jobId||turn.inputDigest!==b.inputDigest||JSON.stringify(turn.messageIds.filter((id:string)=>store.message(id)?.conversationId===b.conversationId))!==JSON.stringify(b.messageIds)||turn.recipientId!==b.recipientId)fail(409,'dispatch_mismatch','No matching dispatched turn/input');
  const activeRun=turn.runId?state.runs?.[turn.runId]:undefined;if(turn.runId&&(!activeRun||activeRun.epoch!==turn.epoch||!['running','paused'].includes(activeRun.status))){turn.lateInclusion={jobId:b.jobId,inputDigest:b.inputDigest};store.putRecord('chat_turns',turn);return json(200,{accepted:false,reason:'Stopped or changed run; late evidence retained'});}
  const conv=store.conversation(String(b.conversationId));if(!conv)fail(404,'conversation_not_found','unknown conversation');
  const recipient:Principal={...ctx.principal,id:String(b.recipientId),sessionId:turn.sessionId,kind:'agent'};const m=conversationAccess(state,recipient,conv);const join=store.joinSeq(conv.id,recipient.id,m.createdAt);
  const a={id:requireProse(b.attestationId,'attestationId',160),conversationId:conv.id,recipientId:recipient.id,turnId:turn.id,jobId:turn.jobId,inputDigest:turn.inputDigest,messageIds:b.messageIds as string[],at:turn.createdAt};return json(200,{attestation:store.attest(a,join)});
 }
 const p=ctx.principal;requireScope(p,CHAT_SCOPES.read,state);currentMember(state,p);
 if(!store.conversation('team')){if(p.kind!=='human')fail(503,'channels_unprepared','Owner needs to prepare the conversation channels');channels(store,state);}
 if(!store.profile(p.id)&&p.kind==='human')store.setProfile({identityId:p.id,name:state.identities[p.id]?.displayName??'Project owner',mode:'human',summary:'Owner of this local project.',desired:'available'});
 if(segments.length===1){
  if(request.method==='GET')return json(200,{conversations:store.list().filter(c=>c.audience==='project'||c.audience.includes(p.id)||p.kind==='human'),runtime:{connected:Boolean(ctx.runtime),nextAction:ctx.runtime?'Explicit invitations only':'Runtime start unconfirmed; inspect the saved capability receipt before retrying',draftAllowance:ctx.runtime?.allowances.draft??0,loungeAllowance:ctx.runtime?.allowances.lounge??0},credits:CREW_CREDITS,creditsScope:'Historical source contributors, not project participants or connected runtimes'});
  if(request.method==='POST'){
   requireScope(p,CHAT_SCOPES.profile,state);if(p.kind!=='human')fail(403,'owner_only','Owner defines task audiences');const b=body??{};const taskId=requireProse(b.taskId,'taskId',120);if(!state.tasks[taskId])fail(404,'task_not_found','unknown task');const audience=Array.isArray(b.audience)?b.audience.map(String):[p.id];if(audience.some(id=>!Object.values(state.members).some(m=>m.identityId===id)&&id!==p.id))fail(422,'audience','audience must be project members');
   const id='task:'+taskId;const prior=store.conversation(id);if(prior)return json(200,{conversation:prior});return json(201,{conversation:store.create({id,kind:'task',taskId,audience,createdAt:ctx.now(),nextSeq:0})});
  }return null;
 }
 // URL path segments remain encoded in createApp; decode this ID exactly once.
 let conversationId:string;try{conversationId=decodeURIComponent(segments[1]);}catch{fail(400,'conversation_id_encoding','invalid conversation ID encoding');}
 const c=store.conversation(conversationId);if(!c)fail(404,'conversation_not_found','unknown conversation');const member=conversationAccess(state,p,c);const join=store.joinSeq(c.id,p.id,member.createdAt);
 if(request.method==='GET'&&segments.length===2){const url=new URL(request.url);const after=Number(url.searchParams.get('after')??store.cursor(c.id,p.id,join).opened);const limit=Math.min(50,Number(url.searchParams.get('limit')??30));if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1)fail(422,'cursor','invalid page');const page=store.page(c.id,p.id,join,after,limit);return json(200,{...page,conversation:c,visibility:'Messages after your project join point',senderLeft:Object.fromEntries(page.messages.map(m=>[m.sender.id,m.sender.mode!=='human'&&state.identities[m.sender.id]?.status!=='active']))});}
 if(request.method==='POST'&&segments[2]==='opened'){const seq=Number(body?.seq);if(!Number.isInteger(seq)||seq<0)fail(422,'cursor','invalid position');return json(200,{cursor:store.open(c.id,p.id,join,seq)});}
 if(request.method==='POST'&&segments[2]==='messages'){
  requireScope(p,c.kind==='lounge'?CHAT_SCOPES.lounge:CHAT_SCOPES.write,state);if(p.kind!=='human'&&state.stopped)fail(409,'project_stopped','Project stopped; no worker writes');
  const b=body??{};const allowed=new Set(['body','clientRequestId','mentionIds','replyToId','reaction']);if(Object.keys(b).some(k=>!allowed.has(k)))fail(422,'message_fields','Sender and runtime attribution come from authentication');
  const text=requireProse(b.body,'body',2000);const req=requireProse(b.clientRequestId,'clientRequestId',120);const mentions=Array.isArray(b.mentionIds)?b.mentionIds.map(String).slice(0,20):[];if(mentions.some(id=>!Object.values(state.members).some(m=>m.identityId===id)||(c.audience!=='project'&&!c.audience.includes(id))))fail(422,'mentions','Mention only visible project members');
  const replyToId=typeof b.replyToId==='string'?b.replyToId:undefined;if(replyToId){const msg=store.message(replyToId);if(!msg||msg.conversationId!==c.id||msg.seq<=join)fail(404,'reply_target','unknown reply target');}
  const reaction=b.reaction===undefined?undefined:b.reaction==='coffee'?'coffee':fail(422,'reaction','unknown reaction');
  const digest=await digestOf({conversationId:c.id,body:text,mentionIds:mentions,replyToId, reaction});state=await ctx.store.read();conversationAccess(state,p,c);if(p.kind!=='human'&&state.stopped)fail(409,'project_stopped','Project stopped; no worker writes');
  const out=store.append({conversationId:c.id,body:text,digest,requestId:req,sender:frozen(p,state,store,request.headers.get('x-together-adapter-instance')),now:ctx.now(),id:ctx.uid(),mentions,replyToId,reaction});const toNotify=mentions.filter(id=>id!==p.id&&!Object.values(state.messages).some(m=>m.dedupeKey==='conversation:'+c.id+':'+id));if(toNotify.length)await ctx.store.transact(d=>{for(const id of toNotify)if(d.identities[id]?.status==='active'&&Object.values(d.members).some(m=>m.identityId===id))conversationNotice(d,ctx,c.id,id,{id:out.message.id,digest:out.message.digest});});queueHumanAttention(ctx,out.message);return json(out.duplicate?200:201,{...out,stage:'Queued'});
 }
 return null;
}
