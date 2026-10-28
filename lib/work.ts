import {collaborationAnswers} from './dashboard.ts';
/** Ordinary work uses existing project records and command receipts, never a parallel store. */
import {appendEvent,command,entity,fail,json,requireProse,requireScope,safeSnapshot,touchEntity} from './core.ts';
import {currentMember} from './conversation.ts';
import type {Assignment,Context,ProjectState,Task} from './types.ts';
function currentPlan(s:ProjectState,b:Record<string,unknown>){if(s.project.adoptedPlanRevisionId&&b.planRevisionId!==s.project.adoptedPlanRevisionId)fail(409,'stale_plan','Read current plan; retain your proposal and resubmit deliberately');}
function holder(s:ProjectState,ctx:Context,t:Task,b:Record<string,unknown>):Assignment{
 const a=s.assignments[String(b.assignmentId)];
 if(!a||a.taskId!==t.id||a.identityId!==ctx.principal.id||a.sessionId!==ctx.principal.sessionId)fail(403,'assignment_holder','Only the bound session may update its work');
 if(a.status!=='active'||a.epoch!==b.assignmentEpoch||a.leaseExpiresAt<=ctx.now()||a.role!=='owner'||t.currentAssignmentId!==a.id)fail(409,'stale_assignment','Current active owner claim and epoch required');
 currentPlan(s,b);return a;
}
export async function handleWork(ctx:Context,req:Request,p:string[],b:Record<string,unknown>={}):Promise<Response|null>{
 const readRoutes=['work-context','work-results','collaboration-answers'];
 if(req.method==='GET'&&p.length===1&&readRoutes.includes(p[0])){
  const s=await ctx.store.read();requireScope(ctx.principal,'read',s);currentMember(s,ctx.principal);
  if(p[0]==='collaboration-answers')return json(200,collaborationAnswers(safeSnapshot(s,ctx.principal),ctx.now()));
  if(p[0]==='work-context')return json(200,{project:{id:s.project.id,goal:s.project.goal,revision:s.project.revision,mode:s.project.mode,stopped:s.stopped,adoptedPlanRevisionId:s.project.adoptedPlanRevisionId??null},capabilities:ctx.principal.scopes,identity:{id:ctx.principal.id,sessionId:ctx.principal.sessionId},source:'Together shared handlers'});
  const q=new URL(req.url).searchParams,collection=q.get('collection')??'receipts';
  if(!['proposals','candidates','receipts','reviews','authorReports','handoffs'].includes(collection))fail(422,'collection','Choose an ordinary work result collection');
  const all=Object.values((s as any)[collection]??{}).sort((a:any,b:any)=>a.id.localeCompare(b.id));
  const after=q.get('after');const index=after?all.findIndex((x:any)=>x.id===after):-1;if(after&&index<0)fail(409,'cursor_gap','Result cursor unavailable; re-read first page');
  const limit=Math.max(1,Math.min(10,Number(q.get('limit'))||5)),rows=all.slice(index+1,index+1+limit);
  return json(200,{collection,records:rows,nextCursor:(rows.at(-1) as any)?.id??after,more:index+1+rows.length<all.length});
 }
 if(req.method==='POST'&&p.length===3&&p[0]==='assignments'&&p[2]==='release')return command(ctx,b,'tasks:claim',{collection:'assignments',id:p[1]},s=>{const a=entity<Assignment>(s,'assignments',p[1]);const t=entity<Task>(s,'tasks',a.taskId);holder(s,ctx,t,{...b,assignmentId:a.id});a.status='released';t.currentAssignmentId=undefined;if(['claimed','in-progress'].includes(t.lifecycle))t.lifecycle='open';touchEntity(t,ctx,ctx.principal.id);appendEvent(s,ctx,'assignment:released',a.id);return{status:200,body:{assignment:a,task:t}};});
 if(req.method!=='POST'||p[0]!=='tasks'||p.length!==3||!['update','progress','complete'].includes(p[2]))return null;
 const action=p[2],scope=action==='update'?'tasks:write':action==='complete'?'tasks:complete':'tasks:progress';
 return command(ctx,b,scope,{collection:'tasks',id:p[1]},s=>{
  currentMember(s,ctx.principal);if(s.stopped)fail(409,'project_stopped','Project is stopped');
  const task=entity<Task>(s,'tasks',p[1]);currentPlan(s,b);
  if(['done','cancelled'].includes(task.lifecycle))fail(409,'finished_task','Finished task is immutable');
  if(action==='update'){
   if(task.currentAssignmentId&&ctx.principal.kind==='agent')holder(s,ctx,task,b);
   if(task.requiredPlanRevisionId)fail(409,'plan_owned','Propose a plan revision to change planned requirements');
   if(b.goal!==undefined)task.goal=requireProse(b.goal,'goal',2000);
   if(b.acceptanceCriteria!==undefined){if(!Array.isArray(b.acceptanceCriteria)||!b.acceptanceCriteria.length||b.acceptanceCriteria.length>10)fail(422,'criteria','Provide1–10 checks');task.acceptanceCriteria=b.acceptanceCriteria.map(v=>requireProse(v,'criterion',500));}
   if(b.nextAction!==undefined)task.nextAction=requireProse(b.nextAction,'nextAction',2000);
   const assigned=task.currentAssignmentId?s.assignments[task.currentAssignmentId]:undefined;
   const changedFields=['goal','acceptanceCriteria'].filter(k=>b[k]!==undefined);
   if(assigned&&changedFields.length&&(assigned.identityId!==ctx.principal.id||assigned.sessionId!==ctx.principal.sessionId)){
    task.nextAction='Owner changed requirements; re-read this task before continuing.'+(task.nextAction?' Next: '+task.nextAction:'');
    appendEvent(s,ctx,'task:requirements-changed',task.id,{changedFields,holderIdentityId:assigned.identityId,holderSessionId:assigned.sessionId,operationId:b.operationId});
   }
  }else{
   const a=holder(s,ctx,task,b);
   const summary=requireProse(b.summary,'summary',2000);
   if(action==='progress'){
    task.progressSummary=summary;task.nextAction=b.nextAction===undefined?task.nextAction:requireProse(b.nextAction,'nextAction',2000);
    if(b.blocker!==undefined)task.blocker=b.blocker===null?null:requireProse(b.blocker,'blocker',2000);
    task.lifecycle='in-progress';
   }else{
    if(!Array.isArray(b.receiptIds)||b.receiptIds.length<1||b.receiptIds.length>20||b.receiptIds.some(x=>typeof x!=='string'))fail(422,'completion_receipts','Name1–20 existing passing collector receipts');
    for(const id of b.receiptIds as string[]){const r=s.receipts[id],j=r&&s.jobs[r.jobId],c=j&&s.candidates[j.candidateId];if(!r||r.importedUnverified||r.outcome!=='pass'||!j||j.status!=='completed'||(s.project.adoptedPlanRevisionId&&j.planRevisionId!==s.project.adoptedPlanRevisionId)||j.ownerAssignmentId!==a.id||j.ownerEpoch!==a.epoch||j.candidateSha!==r.candidateSha||!c||c.sha!==r.candidateSha)fail(422,'completion_evidence','Receipt must be a current passing check for this assignment and candidate');}
    task.nextAction=undefined;task.blocker=null;task.lifecycle='done';task.resultRefs=[...new Set([...task.resultRefs,...b.receiptIds as string[]])];task.completion={operationId:String(b.operationId),summary,receiptIds:b.receiptIds,actorId:ctx.principal.id,sessionId:ctx.principal.sessionId,at:ctx.now(),meaning:'Work completion recorded with check receipts; not integration or proof of every acceptance criterion'};
    a.status='completed';touchEntity(a,ctx,ctx.principal.id);task.currentAssignmentId=undefined;
   }
  }
  appendEvent(s,ctx,'task:'+action,task.id,{summary:b.summary,blocker:task.blocker,operationId:b.operationId});
  return{status:200,body:{task,receipt:{operationId:b.operationId,kind:'work-'+action,actorId:ctx.principal.id}}};
 });
}
