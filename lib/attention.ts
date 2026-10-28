import {fail,json,requireScope} from './core.ts';import {conversationAccess,currentMember,requireConversation} from './conversation.ts';import type {Context} from './types.ts';
export function queueHumanAttention(ctx:Context,message:{id:string;conversationId:string;sender:{mode:string};mentionIds:string[]}){
 if(!ctx.attentionEnabled||message.sender.mode!=='human')return;
 const store=requireConversation(ctx);for(const a of store.attentionArms())if(a.status==='armed'&&a.expiresAt>ctx.now()&&message.mentionIds.includes(a.identityId))store.attentionRecord('message:'+message.id+':'+a.identityId,{channel:message.conversationId,messageId:message.id,recipientId:a.identityId,senderKind:'human',reason:'addressed-human-message'});
}
export function queuePlanAttention(ctx:Context,planId:string,recipients:string[]){if(!ctx.attentionEnabled)return;const store=requireConversation(ctx);for(const a of store.attentionArms())if(a.status==='armed'&&a.expiresAt>ctx.now()&&recipients.includes(a.identityId))store.attentionRecord('plan:'+planId+':'+a.identityId,{channel:'team',planId,recipientId:a.identityId,senderKind:'human',reason:'adopted-plan-change'});}
export async function handleAttention(ctx:Context,req:Request,parts:string[],b:Record<string,unknown>={}):Promise<Response|null>{
 if(parts[0]!=='attention')return null;
 if(parts[1]==='pull'&&parts.length===2&&req.method==='GET'){
  const s=await ctx.store.read();requireScope(ctx.principal,'conversation:read',s);const member=currentMember(s,ctx.principal),store=requireConversation(ctx);const references=[];
  for(const c of store.list()){try{conversationAccess(s,ctx.principal,c);}catch{continue;}const cursor=store.cursor(c.id,ctx.principal.id,store.joinSeq(c.id,ctx.principal.id,member.createdAt));if(c.nextSeq>cursor.opened)references.push({channel:c.id,head:c.nextSeq,opened:cursor.opened,unread:c.nextSeq-cursor.opened});}
  return json(200,{references,bodyIncluded:false,wokeHost:false,meaning:'Pull-only unread references; fetch content with current authorization before acknowledging.'});
 }
 if(!ctx.attentionEnabled)fail(503,'attention_disabled','Optional attention service is disabled');
 const s=await ctx.store.read();requireScope(ctx.principal,'conversation:read',s);currentMember(s,ctx.principal);const store=requireConversation(ctx),now=ctx.now();
 if(parts[1]==='status'&&req.method==='GET'){if(ctx.principal.kind!=='human'||!ctx.principal.scopes.includes('owner'))fail(403,'owner_only','Owner only');return json(200,{arms:store.attentionArms().map(a=>({...a,enabled:s.identities[a.identityId]?.status==='active'&&s.sessions[a.sessionId]?.status==='active'&&!s.stopped&&a.status==='armed'&&a.expiresAt>now&&a.lastHeartbeatAt&&Date.parse(now)-Date.parse(a.lastHeartbeatAt)<30000})),wake:'No host wake is installed'});}
 if(parts[1]==='arm'&&req.method==='POST'){
  if(ctx.principal.kind!=='human'||ctx.principal.id!==ctx.principal.ownerId||!ctx.principal.scopes.includes('owner'))fail(403,'owner_only','Only the owner explicitly arms a watch');
  const session=s.sessions[String(b.sessionId)];if(!session||session.status!=='active'||session.identityId!==b.identityId||s.identities[session.identityId]?.status!=='active')fail(422,'session','An active bound participant is required');
  const seconds=Number(b.seconds);if(!Number.isInteger(seconds)||seconds<1||seconds>1800)fail(422,'arm_bounds','At most30 minutes; host support must be verified separately');
  if(!['once','stream'].includes(String(b.mode)))fail(422,'mode','Use once or stream');
  const prior=store.attentionArms().find(a=>a.sessionId===session.id&&a.status==='armed'&&a.expiresAt>now);if(prior)fail(409,'already_armed','One arm per session; stop it before rearming');
  return json(201,{arm:store.putAttentionArm({id:ctx.uid(),identityId:session.identityId,sessionId:session.id,createdAt:now,expiresAt:new Date(Date.parse(now)+seconds*1000).toISOString(),mode:b.mode,status:'armed',cursor:store.attentionHead(),delivered:store.attentionHead(),lastHeartbeatAt:null}),warning:'A host wake may consume a model turn. No host is contacted by arming.'});
 }
 const arm=store.attentionArm(String(b.armId??new URL(req.url).searchParams.get('armId')));const ownerStop=req.method==='POST'&&parts[1]==='stop'&&ctx.principal.kind==='human'&&ctx.principal.id===ctx.principal.ownerId&&ctx.principal.scopes.includes('owner');if(!arm||(!ownerStop&&(arm.identityId!==ctx.principal.id||arm.sessionId!==ctx.principal.sessionId)))fail(404,'arm_not_found','No authorized arm');
 if(s.stopped||arm.status!=='armed'||arm.expiresAt<=now){arm.status=s.stopped?'stopped':arm.expiresAt<=now?'expired':arm.status;store.putAttentionArm(arm);return json(410,{final:true,status:arm.status});}
 if(req.method==='POST'&&parts[1]==='stop'){arm.status='stopped';store.putAttentionArm(arm);return json(200,{final:true,status:'stopped'});}
 if(req.method==='POST'&&parts[1]==='heartbeat'){
  if(b.ack!==undefined){const ack=Number(b.ack);if(!Number.isInteger(ack)||ack<arm.cursor||ack>arm.delivered)fail(409,'attention_ack','Acknowledge only a delivered range');arm.cursor=ack;}
  arm.lastHeartbeatAt=now;store.putAttentionArm(arm);return json(200,{expiresAt:arm.expiresAt,cursor:arm.cursor});
 }
 if(req.method==='GET'&&parts.length===1){
  if(arm.lastReadAt&&Date.parse(now)-Date.parse(arm.lastReadAt)<1000)fail(429,'attention_rate','Read at most once per second');
  const rows=store.attentionRows(arm.cursor);const refs=rows.filter(r=>{if(r.recipientId!==ctx.principal.id)return false;const c=store.conversation(r.channel);if(!c)return false;try{conversationAccess(s,ctx.principal,c);return true}catch{return false}}).map(r=>({seq:r.seq,channel:r.channel,senderKind:r.senderKind,reason:r.reason,recipientId:r.recipientId}));
  arm.delivered=rows.at(-1)?.seq??arm.cursor;arm.lastReadAt=now;store.putAttentionArm(arm);return json(200,{references:refs,nextCursor:arm.delivered,expiresAt:arm.expiresAt,resyncRequired:Boolean(rows.length&&rows[0].seq>arm.cursor+1),bodyIncluded:false,coalescedCount:refs.length,heartbeatFresh:arm.lastHeartbeatAt?Date.parse(now)-Date.parse(arm.lastHeartbeatAt)<30000:false});
 }
 return null;
}
