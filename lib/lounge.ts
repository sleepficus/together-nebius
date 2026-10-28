import {checkpointInput} from './checkpoint.ts';
import {digestOf,fail,json,requireFields,requireScope} from './core.ts';
import {CHAT_SCOPES} from './conversation-types.ts';
import {requireConversation,currentMember,conversationAccess} from './conversation.ts';
import type {Context,ProjectState} from './types.ts';
import type {ConversationStore} from './conversation-store.ts';
interface Invitation {id:string;status:string;messageIds:string[];addressedId?:string;createdAt:string;updatedAt:string;deadlineAt:string;turns:number;reason?:string;responderId?:string;}
export function eligibleResponders(store:ConversationStore,state:ProjectState,now:string){return store.profiles().flatMap(p=>{
 if(p.mode==='human'||p.desired==='away'||!p.sessionId)return[];
 const r=Object.values(state.runs??{}).find(r=>r.identityId===p.identityId&&r.sessionId===p.sessionId&&r.status==='running');if(!r||!r.heartbeatAt||Date.parse(now)-Date.parse(r.heartbeatAt)>=120000||!state.identities[p.identityId]||state.identities[p.identityId].status!=='active')return[];
 return[{profile:p,run:r,busy:Boolean(r.activeTurnId),availableSince:r.availableSince??r.heartbeatAt}];
 }).sort((a,b)=>a.availableSince.localeCompare(b.availableSince)||a.profile.identityId.localeCompare(b.profile.identityId));}
async function schedule(ctx:Context,invite:Invitation){const store=requireConversation(ctx);const state=await ctx.store.read();let turn:any;
 store.atomic(()=>{
  const current=store.getRecord<Invitation>('chat_invitations',invite.id)!;
  if(!['open','waiting'].includes(current.status)||state.stopped)return;
  if(current.deadlineAt<=ctx.now()){current.status='expired';current.reason='Invitation ended after inactivity';store.putRecord('chat_invitations',current as any);return;}
  const cap=ctx.runtime?.allowances;const hour=new Date(Date.parse(ctx.now())-3600000).toISOString();
  if(!cap||cap.lounge<1||cap.hourlyLounge<1){current.status='waiting';current.reason='No invited-reply allowance configured';store.putRecord('chat_invitations',current as any);return;}
  if(current.turns>=3||store.countTurns('lounge')>=cap.lounge||store.countTurns('lounge',hour)>=cap.hourlyLounge){current.status='exhausted';current.reason='Invited-reply limit reached';store.putRecord('chat_invitations',current as any);return;}
  const people=eligibleResponders(store,state,ctx.now());const person=current.addressedId?people.find(p=>p.profile.identityId===current.addressedId):people.find(p=>!p.busy);
  if(!person||person.busy||store.activeTurn(person.profile.sessionId!)){current.status='waiting';current.reason=current.addressedId?'Addressed member will receive this at the next supported checkpoint':'Nobody is free right now';store.putRecord('chat_invitations',current as any);return;}
  // One invitation owns one runtime slot. Repeat human clicks only join it.
  if(current.responderId){current.reason='Reply already invited';store.putRecord('chat_invitations',current as any);return;}
  const messages=current.messageIds.map(id=>store.message(id)!).filter(Boolean);const recipient={...ctx.principal,id:person.profile.identityId,sessionId:person.profile.sessionId!,kind:'agent' as const};conversationAccess(state,recipient,store.conversation('lounge')!);
  const id=ctx.uid();turn={id,sessionId:person.profile.sessionId!,status:'intent',purpose:'lounge',recipientId:person.profile.identityId,invitationId:current.id,messageIds:messages.map(m=>m.id),createdAt:ctx.now(),runId:person.run.id,epoch:person.run.epoch};store.putRecord('chat_turns',turn);current.turns++;current.status='open';current.responderId=person.profile.identityId;current.reason='One invited reply';store.putRecord('chat_invitations',current as any);
 });
 if(!turn)return;
 const recipient={...ctx.principal,id:turn.recipientId,sessionId:turn.sessionId,kind:'agent' as const};Object.assign(turn,await checkpointInput(ctx,recipient,{invitationMessageIds:turn.messageIds}));const latest=await ctx.store.read();const active=latest.runs?.[turn.runId];if(latest.stopped||!active||active.epoch!==turn.epoch||active.status!=='running'){turn.status='cancelled';store.putRecord('chat_turns',turn);return;}store.putRecord('chat_turns',turn);
 try{
  const job=await ctx.runtime!.enqueue({key:turn.id,projectId:state.project.id,action:'runtime.deliver',consequential:true,payload:{runId:turn.runId,epoch:turn.epoch,sessionId:turn.sessionId,turnId:turn.id,invitationId:invite.id,messageIds:turn.messageIds,inputDigest:turn.inputDigest,maxTurns:1},deadlineAt:invite.deadlineAt});turn.status=job.status==='effect-unconfirmed'?'unconfirmed':'running';turn.jobId=job.id;store.putRecord('chat_turns',turn);
 }catch(e){turn.status='unconfirmed';store.putRecord('chat_turns',turn);const i=store.getRecord<Invitation>('chat_invitations',invite.id)!;i.status='unconfirmed';i.reason='Reply dispatch unconfirmed; do not retry';store.putRecord('chat_invitations',i as any);}
}
export async function handleLounge(ctx:Context,request:Request,segs:string[],body?:Record<string,unknown>):Promise<Response|null>{
 if(segs[0]!=='lounge')return null;const state=await ctx.store.read();const store=requireConversation(ctx);requireScope(ctx.principal,CHAT_SCOPES.read,state);currentMember(state,ctx.principal);
 if(request.method==='GET')return json(200,{invitations:[...store.records<Invitation>('chat_invitations','open'),...store.records<Invitation>('chat_invitations','waiting'),...store.records<Invitation>('chat_invitations','unconfirmed')],people:eligibleResponders(store,state,ctx.now()).map(p=>({identityId:p.profile.identityId,name:p.profile.name,state:p.busy?'Building':p.run.waitingOnCheck?'Waiting for the check':'Free to chat'})),allowance:ctx.runtime?.allowances.lounge??0,hourlyAllowance:ctx.runtime?.allowances.hourlyLounge??0});
 const b=body??{};
 if(segs[1]==='invite'&&request.method==='POST'){
  requireScope(ctx.principal,CHAT_SCOPES.lounge,state);if(ctx.principal.kind!=='human')fail(403,'human_invitation','Only a real human opens a lounge invitation');if(state.stopped)fail(409,'project_stopped','Project is stopped');requireFields(b,['messageId']);const message=store.message(String(b.messageId));if(!message||message.conversationId!=='lounge'||message.sender.id!==ctx.principal.id||message.sender.mode!=='human')fail(404,'message_not_found','Use your own lounge message');
  const invite=store.atomic(()=>{let current=[...store.records<Invitation>('chat_invitations','open'),...store.records<Invitation>('chat_invitations','waiting'),...store.records<Invitation>('chat_invitations','unconfirmed')][0];if(current&&current.deadlineAt<=ctx.now()){current.status='expired';store.putRecord('chat_invitations',current as any);current=undefined;}if(current){if(!current.messageIds.includes(message.id))current.messageIds=[...current.messageIds.slice(-19),message.id];current.updatedAt=ctx.now();store.putRecord('chat_invitations',current as any);return current;}const i:Invitation={id:ctx.uid(),status:'open',messageIds:[message.id],createdAt:ctx.now(),updatedAt:ctx.now(),deadlineAt:new Date(Date.parse(ctx.now())+10*60000).toISOString(),turns:0,...(message.mentionIds[0]?{addressedId:message.mentionIds[0]}:{})};store.putRecord('chat_invitations',i as any);return i;});await schedule(ctx,invite);return json(202,{invitation:store.getRecord('chat_invitations',invite.id)});
 }
 if(segs[1]==='turn-result'&&request.method==='POST'){
  if(ctx.principal.kind!=='system'||!ctx.principal.scopes.includes(CHAT_SCOPES.attest))fail(403,'trusted_runtime_only','Only trusted runtime plumbing records a turn result');
  const turn=store.getRecord<any>('chat_turns',String(b.turnId));if(!turn||turn.jobId!==b.jobId)fail(409,'dispatch_mismatch','No matching dispatched turn');const run=state.runs?.[turn.runId];if(!run||run.epoch!==turn.epoch||!['running','paused'].includes(run.status)){turn.status='late';store.putRecord('chat_turns',turn);return json(200,{accepted:false,reason:'Stopped or changed run; late evidence retained'});}
  if(turn.status==='completed')return json(200,{accepted:true,duplicate:true});if(!['running','unconfirmed'].includes(turn.status))fail(409,'turn_status','Turn is not active');
  // Actual speech is appended by the run credential, never on behalf of Steve.
  if(typeof b.replyMessageId==='string'){const reply=store.message(b.replyMessageId);if(!reply||reply.sender.id!==turn.recipientId||!turn.messageIds.includes(reply.replyToId))fail(409,'reply_mismatch','Reply is not linked to this invitation');turn.replyMessageId=reply.id;}
  turn.status='completed';store.putRecord('chat_turns',turn);const invite=store.getRecord<Invitation>('chat_invitations',turn.invitationId)!;invite.status='completed';invite.reason='Invited turn completed';store.putRecord('chat_invitations',invite as any);return json(200,{accepted:true,invitation:invite});
 }
 return null;
}
