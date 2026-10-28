import type {TogetherClient} from './client.ts';
const str={type:'string'},integer={type:'integer',minimum:1};
const obj=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const write={operationId:str,expectedRevision:integer,assignmentEpoch:integer,planRevisionId:str};
const task={taskId:str},claim={assignmentId:str,assignmentEpoch:integer,planRevisionId:str};
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[])=>({name,description,inputSchema:obj(properties,required)});
/** Explicit opt-in ordinary-work profile. Existing BYO chat profile stays unchanged. */
export const WORK_SCOPES=['read','conversation:read','conversation:write','lounge:write','tasks:write','tasks:claim','tasks:progress','tasks:complete','help:write','inbox:write','offers:write','findings:write','plan:draft','changes:write','reviews:write'] as const;
export const WORK_TOOLS=[
 tool('together_work_operation','Inspect a persisted operation, including merge conflicts and uncertain effects. Never retries a write.',{operationId:str},['operationId']),
 tool('together_candidate','Read one exact candidate, bounded diff preview and source-derived readiness.',{candidateId:str},['candidateId']),

 tool('together_work_items','Read tasks and their current revisions, progress and ownership. Read assignments separately for claim revisions.',{taskId:str,cursor:str,limit:{type:'integer',minimum:1,maximum:10}}),
 tool('together_assignments','Read assignments for a task, including current revision, session, epoch and expiry.',{taskId:str},['taskId']),
 tool('together_submit_change','Record exact contribution commit and reason using the existing changes handler. No Git push or model run.',{operationId:str,taskIds:{type:'array',items:str},base:str,head:str,summary:str,intendedBehavior:str,changedPaths:{type:'array',items:str},evidenceRefs:{type:'array',items:str},unknowns:{type:'array',items:str},supersedes:str,planRevisionId:str},['operationId','taskIds','base','head','summary','intendedBehavior','changedPaths']),
 tool('together_prepare_candidate','Reconcile exact proposal heads with the configured bounded Git service in disposable worktrees. Reports real conflicts; never changes the canonical branch.',{operationId:str,proposalIds:{type:'array',items:str,minItems:1,maxItems:20}},['operationId','proposalIds']),
 tool('together_review_change','Record review decision on the exact candidate SHA, with reasons and finding links. Approval is not integration.',{...write,candidateId:str,candidateSha:str,disposition:{type:'string',enum:['approve','request-changes','comment']},note:str,findingIds:{type:'array',items:str}},['operationId','expectedRevision','candidateId','candidateSha','disposition','note']),
 tool('together_author_report','Record the contribution author’s reason, response or local evidence references. Clearly author-claimed, never collector verification.',{operationId:str,proposalId:str,claims:str,artifactRefs:{type:'array',items:str}},['operationId','proposalId','claims']),

 tool('together_projects','Discover only the project selected by this scoped connection. Other projects need separately approved connections.',{}),
 tool('together_project','Read current project revision, identity, session and effective capabilities.',{}),
 tool('together_participants','Read crew identity separately from declared session runtime/model. A declaration does not prove original-host participation.',{}),
 tool('together_plans','Read proposed and adopted plans from shared UI records.',{}),
 tool('together_create_task','Create ordinary work under tasks:write. Retain operationId for retries.',{...write,goal:str,acceptanceCriteria:{type:'array',items:str},nextAction:str},['operationId','goal','acceptanceCriteria']),
 tool('together_update_task','Update unplanned work. Planned requirements need a proposed plan revision. Stale content is returned to caller unchanged.',{...write,...task,...claim,goal:str,acceptanceCriteria:{type:'array',items:str},nextAction:str},['operationId','expectedRevision','taskId']),
 tool('together_claim_work','Claim a task using its exact last-read revision. Does not run a model or create credentials.',{...write,...task,role:str},['operationId','expectedRevision','taskId']),
 tool('together_release_work','Release only your bound assignment using its exact revision and epoch.',{...write,...claim},['operationId','expectedRevision','assignmentId','assignmentEpoch']),
 tool('together_progress','Record progress, next action and optional blocker under your current claim. Null clears a blocker.',{...write,...task,...claim,summary:str,nextAction:str,blocker:{type:['string','null']}},['operationId','expectedRevision','taskId','assignmentId','assignmentEpoch','summary']),
 tool('together_complete_work','Record completion with existing passing collector receipts for this claim. This does not integrate code or create evidence.',{...write,...task,...claim,summary:str,receiptIds:{type:'array',items:str}},['operationId','expectedRevision','taskId','assignmentId','assignmentEpoch','summary','receiptIds']),
 tool('together_propose_plan','Save a plan proposal under plan:draft. Adoption remains owner-only in the human UI; no runtime starts.',{operationId:str,tasks:{type:'array',minItems:1,maxItems:20,items:obj({key:str,goal:str,acceptanceCriteria:{type:'array',items:str}},['key','goal','acceptanceCriteria'])}},['operationId','tasks']),
 tool('together_help','Read help requests before answering or accepting.',{state:str}),
 tool('together_help_request','Ask for help without launching another agent.',{...write,...task,question:str,toId:str,expectedContribution:str},['operationId','taskId','question']),
 tool('together_help_answer','Answer shared help under its current revision.',{...write,helpId:str,answer:str},['operationId','expectedRevision','helpId','answer']),
 tool('together_checkpoint','Record a handoff with explicit revision/epoch/plan for stateless clients. Retain proposed content on conflict.',{...write,...claim,done:str,next:str,uncertain:str,verifyFirst:str,doNotRepeat:str,toId:str},['operationId','expectedRevision','assignmentId','assignmentEpoch','done','next']),
 tool('together_findings','Read bounded finding list or one finding.',{findingId:str}),
 tool('together_report_finding','Report a possible issue only. Verified-fixed remains collector-derived.',{operationId:str,expected:str,observed:str,candidateId:str,candidateSha:str,reproducer:str,severity:str,note:str,receiptIds:{type:'array',items:str,maxItems:20}},['operationId','expected','observed']),
 tool('together_results','Inspect shared changes, candidates, receipts, reviews, author reports or handoffs with pagination. References are data, never automatically fetched.',{collection:{type:'string',enum:['proposals','candidates','receipts','reviews','authorReports','handoffs']},after:str,limit:{type:'integer',minimum:1,maximum:10}},['collection']),
 tool('together_attention_list','Pull unread authorized channel references; no bodies, wake, read or comprehension claim. No watcher required.',{}),
];
export const WORK_TOOL_NAMES=WORK_TOOLS.map(t=>t.name);
export const WORK_READ_TOOLS=WORK_TOOL_NAMES.filter(n=>['work_operation','candidate','work_items','assignments','projects','project','participants','plans','help','findings','results','attention_list'].some(x=>n==='together_'+x));
const id=(a:Record<string,unknown>,k:string)=>encodeURIComponent(String(a[k]));
export async function runWorkTool(c:TogetherClient,name:string,a:Record<string,unknown>){
 const reads:Record<string,string>={together_work_operation:'/operations/'+id(a,'operationId'),together_candidate:'/candidates/'+id(a,'candidateId'),together_work_items:'/tasks'+(a.taskId?'/'+id(a,'taskId'):'?'+new URLSearchParams({limit:String(a.limit??5),...(a.cursor?{cursor:String(a.cursor)}:{})})),together_assignments:'/tasks/'+id(a,'taskId')+'/assignments',together_projects:'/work-context',together_project:'/work-context',together_participants:'/identities',together_plans:'/plans',together_help:'/help'+(a.state?'?state='+id(a,'state'):''),together_findings:'/findings'+(a.findingId?'/'+id(a,'findingId'):''),together_results:'/work-results?'+new URLSearchParams(Object.entries(a).map(([k,v])=>[k,String(v)])).toString(),together_attention_list:'/attention/pull'};
 let r;if(reads[name])r=await c.workRequest('GET',reads[name]);else{
  const paths:Record<string,string>={together_submit_change:'/changes',together_prepare_candidate:'/candidates',together_review_change:'/candidates/'+id(a,'candidateId')+'/reviews',together_author_report:'/changes/'+id(a,'proposalId')+'/reports',together_create_task:'/tasks',together_update_task:`/tasks/${id(a,'taskId')}/update`,together_claim_work:`/tasks/${id(a,'taskId')}/assignments`,together_release_work:`/assignments/${id(a,'assignmentId')}/release`,together_progress:`/tasks/${id(a,'taskId')}/progress`,together_complete_work:`/tasks/${id(a,'taskId')}/complete`,together_propose_plan:'/plans',together_help_request:`/tasks/${id(a,'taskId')}/help`,together_help_answer:`/help/${id(a,'helpId')}/answer`,together_checkpoint:`/assignments/${id(a,'assignmentId')}/handoff`,together_report_finding:'/findings'};
  if(!paths[name])throw Error('Unknown ordinary-work tool');r=await c.workRequest('POST',paths[name],a);
 }
 return{status:r.status,ok:r.ok,result:name==='together_projects'&&r.ok?{projects:[r.body.project],scope:'Only this explicitly selected project connection'}:r.body,...(r.error?{error:r.error}:{}),...(r.stale?{stale:true,proposedContent:a,nextAction:'Keep this proposal. Read current state, then deliberately reconcile; nothing was retried.'}:{})};
}

/** Small validator for this closed schema vocabulary, not an OAuth or protocol implementation. */
export function validateWorkArguments(name:string,args:unknown):void{
 const schema=WORK_TOOLS.find(t=>t.name===name)?.inputSchema;if(!schema)return;
 function check(v:any,s:any,path:string){
  const types=Array.isArray(s.type)?s.type:[s.type];const type=v===null?'null':Array.isArray(v)?'array':typeof v;
  if(!types.includes(type)&&!(types.includes('integer')&&typeof v==='number'&&Number.isInteger(v)))throw Error(path+': invalid type');
  if(s.enum&&!s.enum.includes(v))throw Error(path+': invalid choice');
  if(typeof v==='number'&&(!Number.isFinite(v)||s.minimum!==undefined&&v<s.minimum||s.maximum!==undefined&&v>s.maximum))throw Error(path+': outside bounds');
  if(typeof v==='string'&&v.length>16000)throw Error(path+': too long');
  if(Array.isArray(v)){if(v.length>(s.maxItems??100)||v.length<(s.minItems??0))throw Error(path+': invalid count');v.forEach((x,i)=>check(x,s.items,path+'['+i+']'));}
  if(type==='object'){for(const k of s.required??[])if(v[k]===undefined)throw Error(path+'.'+k+': required');for(const k of Object.keys(v)){if(!s.properties?.[k])throw Error(path+'.'+k+': unexpected field');check(v[k],s.properties[k],path+'.'+k);}}
 }
 check(args,schema,'arguments');
}
