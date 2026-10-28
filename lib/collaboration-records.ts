import {command,digestOf,fail,json,requireProse,requireScope} from './core.ts';
import {currentMember} from './conversation.ts';
import type {Context,ProjectState} from './types.ts';
export interface IntegrationReport {id:string;sourceApp:string;sourceProjectId:string;sourceRunId:string;sourceRevision:string;observedAt:string;retrievedAt:string;classification:'fixture'|'real'|'unknown';status:string;question:string;expected:string;observed:string;coverage:string;limitations:string[];evidenceRefs:string[];runtime:string|null;model:string|null;repairOf:string|null;digest:string;}
export interface UseEntry {id:string;day:string;taskId:string|null;runtime:string;helped:string;confused:string;interventions:number|null;failureRepair:string;evidenceRefs:string[];durationMs:number|null;costUsd:number|null;createdAt:string;}
export function collaborationData(s:ProjectState):{reports:Record<string,IntegrationReport>;useLog:Record<string,UseEntry>}{return (s.project.collaboration as any)??{reports:{},useLog:{}};}
function writable(s:ProjectState){return (s.project.collaboration??={reports:{},useLog:{}}) as ReturnType<typeof collaborationData>}
export function evidenceRefs(input:unknown,s:ProjectState):string[]{
 if(!Array.isArray(input)||input.length>20)fail(422,'evidence_refs','Provide up to20 source references');
 const prefix=`/api/v1/projects/${encodeURIComponent(s.project.id)}/`;
 return input.map(raw=>{const ref=requireProse(raw,'evidence reference',1000);if(ref.includes('..')||/[\\\r\n]/.test(ref))fail(422,'evidence_destination','Invalid source path');
 if(ref.startsWith(prefix)&&!/conversations|private-backup|credentials|attention/.test(ref)&&!ref.includes('?')&&!ref.includes('#'))return ref;
 let u:URL;try{u=new URL(ref)}catch{fail(422,'evidence_destination','Use an authorized project API source link')}
 const origins=Array.isArray(s.project.allowedEvidenceOrigins)?s.project.allowedEvidenceOrigins:[];
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!origins.includes(u.origin))fail(422,'evidence_destination','External origin is not explicitly allowed');return u.href;
 });
}
function text(v:unknown,name:string,max=2000){const result=requireProse(v,name,max);if(/(?:sk-[a-zA-Z0-9]{16,}|Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----)/.test(result))fail(422,'sensitive_content','Remove credentials from this report');return result;}
export async function handleCollaborationRecords(ctx:Context,req:Request,parts:string[],body?:Record<string,unknown>):Promise<Response|null>{
 if(!['integration-reports','use-log','evidence-export-preview'].includes(parts[0])||parts.length!==1)return null;
 const s=await ctx.store.read();requireScope(ctx.principal,'read',s);currentMember(s,ctx.principal);const records=collaborationData(s);
 if(req.method==='GET'){
  if(parts[0]==='use-log')return json(200,{entries:Object.values(records.useLog),purpose:'Observational use, not a causal benefit measurement'});
  if(parts[0]==='integration-reports')return json(200,{reports:Object.values(records.reports),connections:{reports:'reviewed imports only; not a live data connection',context:'existing brief and handoff links only'}});
  const selected=new URL(req.url).searchParams.getAll('id');if(selected.length>50)fail(422,'selection','Select at most50 reports');if(selected.some(id=>!records.reports[id]))fail(404,'report_not_found','Unknown selected evidence');
  return json(200,{classification:'sanitized-report-export-preview',projectId:s.project.id,sourceRevision:s.project.revision,selectedReports:selected.map(id=>records.reports[id]),redactions:['All conversations','Credentials and grants','Ephemeral connections','Doorbell arms','Use-log prose','Private checkpoints and host transcripts'],publication:'Nothing published; owner must review the selected content'});
 }
 if(req.method!=='POST')return null;
 if(ctx.principal.kind!=='human'||ctx.principal.id!==ctx.principal.ownerId||!ctx.principal.scopes.includes('owner'))fail(403,'owner_only','Only the owner imports sanitized evidence or use notes');
 const b=body??{};if(b.sanitized!==true)fail(422,'sanitized_confirmation','Confirm this contains no private transcripts, credentials or personal records');
 if(parts[0]==='integration-reports'){
  const sourceApp=text(b.sourceApp,'sourceApp',80),sourceProjectId=text(b.sourceProjectId,'sourceProjectId',120),sourceRunId=text(b.sourceRunId,'sourceRunId',120),sourceRevision=text(b.sourceRevision,'sourceRevision',120);
  const status=String(b.status);if(!['passed','failed','interrupted','inconclusive','unavailable','could-not-evaluate'].includes(status))fail(422,'report_status','Unknown report outcome');
  const observedAt=text(b.observedAt,'observedAt',40);if(!Number.isFinite(Date.parse(observedAt)))fail(422,'observed_time','Invalid observation time');
  const fields={sourceApp,sourceProjectId,sourceRunId,sourceRevision,observedAt,status,classification:['fixture','real'].includes(String(b.classification))?b.classification as 'fixture'|'real':'unknown' as const,question:text(b.question,'question'),expected:text(b.expected,'expected'),observed:text(b.observed,'observed'),coverage:text(b.coverage,'coverage'),limitations:Array.isArray(b.limitations)?b.limitations.slice(0,20).map(x=>text(x,'limitation',500)):[],evidenceRefs:evidenceRefs(b.evidenceRefs??[],s),runtime:b.runtime?text(b.runtime,'runtime',100):null,model:b.model?text(b.model,'model',100):null,repairOf:b.repairOf?text(b.repairOf,'repairOf',100):null};
  const id=await digestOf({sourceApp,sourceProjectId,sourceRunId,sourceRevision}),digest=await digestOf(fields);
  return command(ctx,b,'owner',{collection:'project'},d=>{const data=writable(d),old=data.reports[id];if(old){if(old.digest!==digest)fail(409,'source_revision_conflict','A different report already owns this source revision');return{status:200,body:{report:old,duplicate:true}};}if(Object.keys(data.reports).length>=500)fail(429,'report_limit','Archive reviewed evidence before importing more');if(fields.repairOf&&!data.reports[fields.repairOf])fail(422,'repair_source','Repair must link an existing report');const report={id,...fields,digest,retrievedAt:ctx.now()};data.reports[id]=report;return{status:201,body:{report}};});
 }
 if(parts[0]==='use-log'){
  const day=text(b.day,'day',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail(422,'day','Use YYYY-MM-DD');const taskId=b.taskId?String(b.taskId):null;if(taskId&&!s.tasks[taskId])fail(404,'task_not_found','Unknown task');
  const number=(v:unknown)=>v==null?null:typeof v==='number'&&Number.isFinite(v)&&v>=0?v:fail(422,'measurement','Measurements must be non-negative or null');
  const fields={day,taskId,runtime:text(b.runtime,'runtime',100),helped:text(b.helped,'helped'),confused:text(b.confused,'confused'),interventions:number(b.interventions),failureRepair:text(b.failureRepair,'failureRepair'),evidenceRefs:evidenceRefs(b.evidenceRefs??[],s),durationMs:number(b.durationMs),costUsd:number(b.costUsd)};
  return command(ctx,b,'owner',{collection:'project'},d=>{const data=writable(d);if(Object.keys(data.useLog).length>=500)fail(429,'use_log_limit','Use log limit reached');const entry={id:ctx.uid(),createdAt:ctx.now(),...fields};data.useLog[entry.id]=entry;return{status:201,body:{entry}};});
 }
 return null;
}
