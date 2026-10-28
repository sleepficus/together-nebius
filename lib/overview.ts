import {fail,json,requireScope} from './core.ts';
import {currentMember,requireConversation} from './conversation.ts';
import type {ProjectState,Context} from './types.ts';
export interface SummaryRow {id:string;source:{collection:string;id:string};actor:string|null;state:string;summary:string;nextAction:string;observedAt:string;receiptId?:string;choices?:string[];}
export function overview(state:ProjectState,observedAt:string,from?:string,to?:string){
 const start=from?Date.parse(from):-Infinity,end=to?Date.parse(to):Date.parse(observedAt);
 if(Number.isNaN(start)||Number.isNaN(end)||start>=end)fail(422,'time_range','Use a valid inclusive from and exclusive to, with from before to');
 const within=(x:any)=>{const t=Date.parse(x.updatedAt??x.createdAt);return t>=start&&t<end};
 const row=(c:string,x:any,text:string,next:string):SummaryRow=>({id:c+':'+x.id,source:{collection:c,id:x.id},actor:x.actorId??null,state:x.lifecycle??x.status??x.state??'recorded',summary:text,nextAction:next,observedAt});
 const completed:SummaryRow[]=[],inProgress:SummaryRow[]=[],blocked:SummaryRow[]=[],decisions:SummaryRow[]=[],nextActions:SummaryRow[]=[];
 for(const task of Object.values(state.tasks)){
  if(!within(task))continue;
  const receipt=task.resultRefs.map(id=>state.receipts[id]).find(r=>r&&r.outcome==='pass'&&!r.importedUnverified&&!task.importedUnverified);
  if(task.lifecycle==='done'&&receipt)completed.push({...row('tasks',task,task.goal,'Open recorded receipt'),receiptId:receipt.id});
  else if(task.lifecycle==='done')blocked.push(row('tasks',task,task.goal,'Completion recorded without a linked passing receipt; inspect evidence'));
  else if(['claimed','in-progress','submitted'].includes(task.lifecycle))inProgress.push(row('tasks',task,task.goal,String(task.nextAction??'Inspect current task and handoff')));
  if(task.blocker)blocked.push(row('tasks',task,String(task.blocker),'Resolve recorded blocker'));
  if(task.nextAction&&task.lifecycle!=='done'&&task.lifecycle!=='cancelled')nextActions.push(row('tasks',task,task.goal,String(task.nextAction)));
 }
 for(const f of Object.values(state.findings).filter(within))if(!['verified-fixed','not-reproduced','withdrawn'].includes(f.state))blocked.push(row('findings',f,f.observed,f.reproducer?'Inspect reproduction and evidence':'Request a reproducible example'));
 for(const j of Object.values(state.jobs).filter(within))if(['blocked','failed'].includes(j.status))blocked.push(row('jobs',j,'Check '+j.status+': '+j.command,'Inspect check receipt or missing dependency'));
 for(const o of Object.values(state.operations).filter(within))if(['unknown','effect-unconfirmed','dispatching'].includes(String(o.effect)))blocked.push(row('operations',o,'Operation outcome '+o.effect,'Reconcile the original attempt; do not replay automatically'));
 for(const c of Object.values(state.candidates).filter(within))if(c.status==='ready')decisions.push({...row('candidates',c,'Review candidate '+c.sha.slice(0,12),'Choose whether to authorize integration'),choices:['Review evidence','Leave pending']});
 for(const h of Object.values(state.help).filter(within))if(['offered','accepted'].includes(h.state)){
  const choices=Array.isArray(h.choices)?h.choices.filter(x=>typeof x==='string'):[];
  if(h.toId===state.project.actorId&&choices.length)decisions.push({...row('help',h,h.question,'Choose an answer'),choices});
  else blocked.push(row('help',h,h.question,'Review help request'));
 }
 const hashes=new Set<string>();for(const x of [...Object.values(state.proposals),...Object.values(state.candidates)].filter(within))for(const hash of [(x as any).head,(x as any).sha])if(typeof hash==='string'&&/^[a-f0-9]{40,64}$/i.test(hash))hashes.add(hash);
 const runs=Object.values(state.runs??{}).filter(within);const outcomes:Record<string,number>={};for(const r of runs)outcomes[r.status]=(outcomes[r.status]??0)+1;
 const costs=runs.map(r=>r.costUsd).filter(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0) as number[];
 const durations=runs.map(r=>r.durationMs).filter(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0) as number[];
 const findings=Object.values(state.findings).filter(within);
 return {projectId:state.project.id,observedAt,sourceRevision:state.project.revision,classification:state.project.mode==='sample'?'fixture':'recorded',range:{from:from??null,to:to??observedAt,fromInclusive:true,toExclusive:true},availability:'available',completed,inProgress,blocked,decisions,nextActions,metrics:{distinctObservedCommits:hashes.size,completedTasksWithReceipts:completed.length,runsByOutcome:outcomes,confirmedFindings:findings.filter(f=>['reproduced','repair-in-progress','recheck-needed','verified-fixed'].includes(f.state)).length,unresolvedFindings:findings.filter(f=>!['verified-fixed','not-reproduced','withdrawn'].includes(f.state)).length,costUsd:costs.length?costs.reduce((a,b)=>a+b,0):null,costCoverage:{reported:costs.length,total:runs.length},durationMs:durations.length?durations.reduce((a,b)=>a+b,0):null},limitations:['Commit count is activity, not quality.','Missing cost or duration is not reported, never zero by silence.']};
}
export async function handleOverview(ctx:Context,request:Request,parts:string[]):Promise<Response|null>{
 if(request.method!=='GET'||!(['overview','connection-setup'].includes(parts[0])&&parts.length===1||parts[0]==='receipts'&&parts.length===2))return null;
 const state=await ctx.store.read();requireScope(ctx.principal,'read',state);currentMember(state,ctx.principal);
 if(parts[0]==='receipts'){const r=state.receipts[parts[1]];if(!r)fail(404,'receipt_not_found','Unknown receipt');return json(200,{id:r.id,jobId:r.jobId,candidateSha:r.candidateSha,collectorId:r.collectorId,outcome:r.outcome,command:r.command,createdAt:r.createdAt,inputHash:r.inputHash,outputHash:r.outputHash,artifactRefs:r.artifactRefs});}
 if(parts[0]==='overview'){const url=new URL(request.url);return json(200,overview(state,ctx.now(),url.searchParams.get('from')??undefined,url.searchParams.get('to')??undefined));}
 if(ctx.principal.kind!=='human'||ctx.principal.id!==ctx.principal.ownerId||!ctx.principal.scopes.includes('owner'))fail(403,'owner_only','Only the owner plans connections');
 const store=requireConversation(ctx),now=ctx.now();
 const members=Object.values(state.members).map(m=>{
  const identity=state.identities[m.identityId];const grants=Object.values(state.credentials).filter(c=>c.identityId===m.identityId);
  return {identityId:m.identityId,displayName:identity?.displayName??m.identityId,kind:m.kind,sessions:Object.values(state.sessions).filter(s=>s.identityId===m.identityId).map(s=>({id:s.id,status:s.status,host:s.host??s.harness??null,declaredModel:s.model??null})),grants:grants.map(c=>({id:c.id,sessionId:c.sessionId??null,scopes:c.scopes,expiresAt:c.expiresAt??null,state:c.status==='revoked'?'revoked':c.expiresAt&&c.expiresAt<=now?'expired':state.stopped?'writes-stopped':'issued',observation:store.connectionInfo(m.identityId,typeof c.sessionId==='string'?c.sessionId:undefined,now),checked:'Recent checks prove authenticated calls, not live processes or original host identity'}))};
 });
 return json(200,{projectId:state.project.id,observedAt:now,members,profiles:store.profiles(),defaultScopes:['read','conversation:read','conversation:write'],activation:'No grants or host changes are made by this setup view',privacy:'Messages fetched by a host may remain in that host transcript. Revocation does not delete those copies.',remote:'not activated',wake:'disabled'});
}
