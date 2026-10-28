import {queuePlanAttention} from './attention.ts';
import {appendEvent,command,digestOf,entity,fail,json,requireFields,requireProse,requireScope,touchEntity} from './core.ts';
import {CHAT_SCOPES} from './conversation-types.ts';
import {requireConversation} from './conversation.ts';
import {revokeRun} from './run-state.ts';
import type {PlanRevision,RuntimeIntent,WorkRun} from './run-state.ts';
import type {Context,ProjectState,Task} from './types.ts';
export const terminalRun=(r:WorkRun)=>['stopped','completed','failed'].includes(r.status);
function owner(ctx:Context,state:ProjectState){requireScope(ctx.principal,CHAT_SCOPES.start,state);if(ctx.principal.kind!=='human')fail(403,'owner_only','Only the owner adopts plans and controls runs');}
async function dispatch(ctx:Context,runId:string,action:RuntimeIntent['action'],key:string){
 let r=(await ctx.store.read()).runs?.[runId];if(!r)fail(404,'run_not_found','unknown run');if(r.status==='unconfirmed')return;
 if(!ctx.runtime)fail(503,'runtime_unavailable','No proven native runtime is connected');
 const phase=r.status;const epoch=r.epoch;
 try{
  const job=await ctx.runtime.enqueue({key,projectId:r.projectId,action,payload:{runId:r.id,epoch,planRevisionId:r.planRevisionId,planDigest:r.planDigest,...(r.sessionId?{sessionId:r.sessionId}:{})},consequential:action!=='runtime.status'&&action!=='runtime.stop',deadlineAt:String(r.runtimeDeadlineAt??new Date(Date.parse(r.updatedAt)+120000).toISOString())});
  await ctx.store.transact(d=>{const current=d.runs![runId];if(current.epoch!==epoch){d.lateOutputs.push({id:ctx.uid(),projectId:d.project.id,createdAt:ctx.now(),kind:'runtime',detail:{runId,jobId:job.id,epoch}} as any);return;}current.jobId=job.id;if(job.status==='effect-unconfirmed'){current.status='unconfirmed';current.priorPhase=phase;current.reconciliationTarget=job.id;}});
 }catch(e){await ctx.store.transact(d=>{const current=d.runs![runId];if(current.epoch===epoch){current.status='unconfirmed';current.priorPhase=phase;current.reconciliationTarget=key;}});}
}
export async function handlePlansRuns(ctx:Context,request:Request,segs:string[],body?:Record<string,unknown>):Promise<Response|null>{
 if(!['plans','runs','runtime-report','plan-draft'].includes(segs[0]))return null;
 const state=await ctx.store.read();const b=body??{};
 if(segs[0]==='runtime-report'){
  if(ctx.principal.kind!=='system'||!ctx.principal.scopes.includes(CHAT_SCOPES.attest))fail(403,'trusted_runtime_only','Only the runtime mediator reports execution');requireFields(b,['runId','jobId','epoch','status']);
  const out=await ctx.store.transact(d=>{
   const r=d.runs?.[String(b.runId)];if(!r)fail(404,'run_not_found','unknown run');
   if(r.epoch!==b.epoch||terminalRun(r)||r.status==='stopping'){d.lateOutputs.push({id:ctx.uid(),projectId:d.project.id,createdAt:ctx.now(),kind:'runtime',detail:{runId:r.id,jobId:b.jobId,status:b.status}} as any);return{accepted:false,reason:'late result; run epoch or terminal state changed'};}
   if(r.jobId!==b.jobId)fail(409,'runtime_job_mismatch','job does not belong to this run');
   const status=String(b.status);if(!['running','completed','failed','unconfirmed'].includes(status))fail(422,'runtime_status','invalid runtime outcome');r.status=status as WorkRun['status'];r.heartbeatAt=ctx.now();if(typeof b.sessionId==='string')r.sessionId=b.sessionId;if(typeof b.identityId==='string')r.identityId=b.identityId;if(typeof b.responseModel==='string')r.responseModel=b.responseModel;touchEntity(r,ctx);return{accepted:true,run:r};
  });return json(200,out);
 }
 if(segs[0]==='plan-draft'){
  owner(ctx,state);if(request.method!=='POST')return null;
  if(!ctx.runtime||ctx.runtime.allowances.draft<1)fail(412,'draft_allowance','No drafting inference allowance is configured; use the deterministic plan form');
  const conv=requireConversation(ctx);const msg=conv.message(String(b.messageId));if(!msg||msg.sender.id!==ctx.principal.id||msg.sender.mode!=='human')fail(404,'brief_not_found','use your own posted brief');
  requireFields(b,['operationId']);const id=String(b.operationId);const prior=conv.getRecord<any>('chat_turns',id);if(prior){if(prior.messageId!==msg.id)fail(409,'draft_request_changed','request payload changed');return json(200,{job:prior});}

  const record={id,sessionId:'plan-draft:'+state.project.id,status:'intent',purpose:'draft',messageId:msg.id,messageDigest:msg.digest,createdAt:ctx.now()};conv.atomic(()=>{if(conv.countTurns('draft')>=ctx.runtime!.allowances.draft)fail(429,'draft_cap','Drafting allowance exhausted');if(conv.activeTurn(record.sessionId))fail(409,'draft_busy','One drafting turn at a time');conv.putRecord('chat_turns',record);});
  try{const job=await ctx.runtime.enqueue({key:id,projectId:state.project.id,action:'runtime.start',payload:{purpose:'plan-draft',messageId:msg.id,messageDigest:msg.digest,maxTurns:1},consequential:true,deadlineAt:new Date(Date.parse(ctx.now())+120000).toISOString()});record.status=job.status==='effect-unconfirmed'?'unconfirmed':'running';Object.assign(record,{jobId:job.id});conv.putRecord('chat_turns',record);}catch(e){record.status='unconfirmed';conv.putRecord('chat_turns',record)}return json(202,{job:record});
 }
 if(segs[0]==='plans'){
  if(request.method==='GET'){requireScope(ctx.principal,'read',state);return json(200,{plans:Object.values(state.planRevisions??{}),adoptedPlanRevisionId:state.project.adoptedPlanRevisionId??null});}
  const proposal=request.method==='POST'&&segs.length===1;
  if(proposal&&ctx.principal.kind==='agent')requireScope(ctx.principal,CHAT_SCOPES.draft,state);else owner(ctx,state);
  if(segs.length===1&&request.method==='POST'){
   if(!Array.isArray(b.tasks)||b.tasks.length<1||b.tasks.length>20)fail(422,'plan_tasks','provide1–20 bounded tasks');
   const tasks=b.tasks.map((x:any)=>{if(!x||typeof x.key!=='string'||! /^[a-z0-9_-]{1,64}$/i.test(x.key))fail(422,'task_key','stable task key required');if(!Array.isArray(x.acceptanceCriteria)||x.acceptanceCriteria.length<1||x.acceptanceCriteria.length>10)fail(422,'criteria','provide1–10 checks');return{key:x.key,goal:requireProse(x.goal,'goal',2000),acceptanceCriteria:x.acceptanceCriteria.map((v:unknown)=>requireProse(v,'criterion',500))};});if(new Set(tasks.map(t=>t.key)).size!==tasks.length)fail(422,'duplicate_task_key','Task keys must be unique');
   let sourceMessage:PlanRevision['sourceMessage'];if(b.sourceMessageId){const message=requireConversation(ctx).message(String(b.sourceMessageId));if(!message||message.sender.id!==ctx.principal.id)fail(404,'brief_not_found','your own brief required');sourceMessage={id:message.id,digest:message.digest};}
   const digest=await digestOf({tasks,sourceMessage});return command(ctx,b,ctx.principal.kind==='agent'?CHAT_SCOPES.draft:CHAT_SCOPES.start,{collection:'planRevisions'},d=>{const now=ctx.now();const plan:PlanRevision={id:ctx.uid(),projectId:d.project.id,revision:1,createdAt:now,updatedAt:now,actorId:ctx.principal.id,tasks,digest,...(sourceMessage?{sourceMessage}:{})};(d.planRevisions??={})[plan.id]=plan;return{status:201,body:{plan}};});
  }
  if(segs[2]==='adopt'&&request.method==='POST'){
   const result=await command(ctx,b,CHAT_SCOPES.start,{collection:'project'},d=>{const plan=d.planRevisions?.[segs[1]];if(!plan)fail(404,'plan_not_found','unknown plan');const unaffected=Array.isArray(b.unaffectedTaskKeys)?b.unaffectedTaskKeys.map(String):[];if(unaffected.some(k=>!plan.tasks.some(t=>t.key===k)))fail(422,'unaffected_tasks','Unknown unaffected key');
    for(const input of plan.tasks){let task=Object.values(d.tasks).find(t=>t.planTaskKey===input.key);if(unaffected.includes(input.key)){if(!task)fail(422,'unaffected_missing','A new task cannot be unaffected');continue;}if(task){if(task.lifecycle==='done'&&(task.goal!==input.goal||JSON.stringify(task.acceptanceCriteria)!==JSON.stringify(input.acceptanceCriteria)))fail(409,'finished_task_immutable','Use a new stable key to supersede finished work');task.planHistory=[...(Array.isArray(task.planHistory)?task.planHistory:[]),{planRevisionId:task.requiredPlanRevisionId??null,goal:task.goal,acceptanceCriteria:task.acceptanceCriteria,revision:task.revision}];delete task.retiredFromPlanAt;task.goal=input.goal;task.acceptanceCriteria=input.acceptanceCriteria;task.requiredPlanRevisionId=plan.id;touchEntity(task,ctx);}else{const now=ctx.now();const id=ctx.uid();task={id,projectId:d.project.id,revision:1,createdAt:now,updatedAt:now,actorId:ctx.principal.id,goal:input.goal,acceptanceCriteria:input.acceptanceCriteria,dependencies:[],lifecycle:'open',resultRefs:[],planTaskKey:input.key,requiredPlanRevisionId:plan.id} as Task;d.tasks[id]=task;}}
    for(const task of Object.values(d.tasks))if(task.planTaskKey&&!plan.tasks.some(t=>t.key===task.planTaskKey))task.retiredFromPlanAt=ctx.now();
    d.project.adoptedPlanRevisionId=plan.id;appendEvent(d,ctx,'plan:adopted',plan.id,{digest:plan.digest,unaffectedTaskKeys:unaffected,humanCategory:'approve'});return{status:200,body:{adoptedPlanRevisionId:plan.id,digest:plan.digest,taskIds:Object.values(d.tasks).filter(t=>plan.tasks.some(p=>p.key===t.planTaskKey)).map(t=>t.id)}};
   });
   if(result.ok&&ctx.attentionEnabled){const latest=await ctx.store.read();if(latest.project.adoptedPlanRevisionId===segs[1])queuePlanAttention(ctx,segs[1],Object.values(latest.assignments).filter(a=>a.status==='active').map(a=>a.identityId));}
   return result;
  }return null;
 }
 if(request.method==='GET'&&segs.length===1){requireScope(ctx.principal,'read',state);return json(200,{runs:Object.values(state.runs??{}),allowances:ctx.runtime?.allowances??{draft:0,run:0,lounge:0,hourlyLounge:0}});}
 owner(ctx,state);
 if(request.method==='POST'&&segs.length===1){const plan=state.planRevisions?.[String(b.planRevisionId)];if(!plan||state.project.adoptedPlanRevisionId!==plan.id||b.planDigest!==plan.digest)fail(409,'plan_not_adopted','Adopt this exact plan before creating a run');return command(ctx,b,CHAT_SCOPES.start,{collection:'runs'},d=>{const now=ctx.now();const run:WorkRun={id:ctx.uid(),projectId:d.project.id,revision:1,createdAt:now,updatedAt:now,actorId:ctx.principal.id,status:'draft',epoch:0,planRevisionId:plan.id,planDigest:plan.digest};(d.runs??={})[run.id]=run;return{status:201,body:{run}};});}
 if(request.method!=='POST'||segs.length!==3)return null;
 const id=segs[1],action=segs[2];const current=state.runs?.[id];if(!current)fail(404,'run_not_found','unknown run');
 if(action==='bind-credential')return command(ctx,b,CHAT_SCOPES.start,{collection:'runs',id},d=>{const r=d.runs![id];if(!['running','paused'].includes(r.status))fail(409,'run_not_active','Run is not active');const cred=d.credentials[String(b.credentialId)];if(!cred||cred.status!=='active'||cred.runId)fail(409,'credential_binding','Fresh active run credential required');cred.runId=r.id;cred.runEpoch=r.epoch;return{status:200,body:{bound:true}};});
 if(!['start','pause','resume','stop','reconcile'].includes(action))return null;
 if(action==='start'&&(!ctx.runtime||ctx.runtime.allowances.run<1))fail(412,'run_allowance','No proven runtime/start allowance configured');
 const response=await command(ctx,b,CHAT_SCOPES.start,{collection:'runs',id},d=>{const r=d.runs![id];
  if(action==='start'){if(d.stopped||r.status!=='draft')fail(409,'run_start','Only a draft in a running project can start');if(d.project.adoptedPlanRevisionId!==r.planRevisionId)fail(409,'stale_plan','The adopted plan changed');if(Object.values(d.runs??{}).filter(v=>v.startOperationId).length>=ctx.runtime!.allowances.run)fail(429,'run_cap','Run allowance exhausted');r.status='starting';r.epoch++;r.startOperationId=String(b.operationId);r.runtimeDeadlineAt=new Date(Date.parse(ctx.now())+120000).toISOString();}
  if(action==='pause'){if(r.status!=='running')fail(409,'run_pause','Only running work can pause');r.status='paused';}
  if(action==='resume'){if(d.stopped||r.status!=='paused')fail(409,'run_resume','Only paused work can resume');r.status='running';}
  if(action==='stop'){if(!terminalRun(r)&&r.status!=='stopping')revokeRun(d,r,ctx.now());}
  if(action==='reconcile'&&r.status!=='unconfirmed')fail(409,'run_reconcile','No uncertain operation to reconcile');return{status:200,body:{run:r}};
 });
 const fresh=(await ctx.store.read()).runs![id];if(action==='start'&&fresh.status==='starting'&&!fresh.jobId)await dispatch(ctx,id,'runtime.start',String(b.operationId));
 if(action==='stop'&&fresh.status==='stopping'){
  if(ctx.runtime&&fresh.sessionId)await dispatch(ctx,id,'runtime.stop','stop:'+id+':'+fresh.epoch);
  await ctx.store.transact(d=>{const r=d.runs![id];if(r.status==='stopping'){r.status='stopped';r.updatedAt=ctx.now();}});
 }
 if(action==='reconcile'&&ctx.runtime?.status&&fresh.jobId){const result=await ctx.runtime.status(fresh.jobId);if(result.status==='completed'&&typeof result.result?.sessionId==='string')await ctx.store.transact(d=>{const r=d.runs![id];if(r.status==='unconfirmed'&&r.epoch===fresh.epoch){r.status='running';r.sessionId=String(result.result!.sessionId);r.heartbeatAt=ctx.now();}});}
 return json(response.status,{run:(await ctx.store.read()).runs![id]});
}
