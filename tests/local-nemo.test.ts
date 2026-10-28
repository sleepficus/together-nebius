import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createLocalApi} from '../cloud/local-server.ts';
import {ensureWorkspace,fixedDemoRunner,readDemoFile,writeDemoFile,DEMO_TESTS,hash} from '../local/demo-workspace.ts';
import {LocalNemo,NEMO_MODEL} from '../local/nemo.ts';

const SOLUTION=`export function summarizeChecks(records) {
 const rows=records??[];let passed=0,failed=0,notChecked=0;
 for(const row of rows){if(row?.status==='passed')passed++;else if(row?.status==='failed')failed++;else notChecked++;}
 return {status:failed?'failed':rows.length&&notChecked===0?'passed':'not-checked',total:rows.length,passed,failed,notChecked};
}\n`;
const owner='OFFLINE-owner-secret',key='OFFLINE-provider-secret';
function fixture(t:any,providerFetch?:typeof fetch,afterApi?:(request:Request,response:Response)=>Promise<Response>,requireSharedTask=false){
 const dir=mkdtempSync(join(tmpdir(),'together-nemo-test-')),repo=ensureWorkspace(dir),nemoDir=join(dir,'nemo');let nemo:LocalNemo;
 let checker:ReturnType<typeof fixedDemoRunner>;
 const api=createLocalApi({ownerTokens:[{ownerId:'owner',token:owner}],stateDir:dir,seedProjects:[{id:'demo'}],gitRepo:repo,gitProjectId:'demo',runnerFactory:collector=>(checker=fixedDemoRunner(repo,nemoDir,collector,r=>nemo.recordCheck(r))),localAgent:{fetch:(req,pid)=>nemo.fetch(req,pid)}});
 const agentApi=afterApi?{...api,fetch:async(request:Request)=>afterApi(request,await api.fetch(request))}:api;
 const cancelledChecks:string[]=[];
 nemo=new LocalNemo({stateDir:nemoDir,repo,projectId:'demo',ownerToken:owner,api:agentApi,key:()=>key,providerFetch,requireSharedTask,cancelCheck:jobId=>{cancelledChecks.push(jobId);return checker.cancel({projectId:'demo',jobId})}});
 t.after(async()=>{await nemo.close();api.close();rmSync(dir,{recursive:true,force:true});});
 const call=(path:string,body?:any,token=owner,origin?:string)=>api.fetch(new Request('http://127.0.0.1/api/v1/projects/demo/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...(origin?{origin}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return{dir,repo,nemoDir,api,nemo,call,cancelledChecks};
}
function apiGate(match:(request:Request)=>boolean){
 let enter!:(response:Response)=>void,release!:()=>void,used=false;
 const entered=new Promise<Response>(done=>{enter=done}),released=new Promise<void>(done=>{release=done});
 return{entered,release:()=>release(),after:async(request:Request,response:Response)=>{if(!used&&match(request)){used=true;enter(response.clone());await released;}return response;}};
}
async function settle(nemo:LocalNemo){for(let i=0;i<200;i++){const state=nemo.publicState();if(!state.activeRunId)return state;await new Promise(r=>setTimeout(r,30));}throw Error('Offline run did not settle');}
function agentResponse(name:string,args:any){return Response.json({id:'offline-'+crypto.randomUUID(),model:NEMO_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call-'+crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}});}
function scripted(){let calls=0;return{get calls(){return calls},fetch:(async(_url:any,init:any)=>{
 calls++;const b=JSON.parse(init.body);assert.equal(b.model,NEMO_MODEL);assert.deepEqual(b.chat_template_kwargs,{enable_thinking:false});assert.equal(b.max_tokens,2048);
 const toolResults=b.messages.filter((m:any)=>m.role==='tool');const names=toolResults.filter((m:any)=>JSON.parse(m.content).ok!==false).map((m:any)=>m.name);
 if(!names.includes('read_messages'))return agentResponse('read_messages',{});
 if(!names.includes('opened'))return agentResponse('opened',{seq:JSON.parse(toolResults.find((m:any)=>m.name==='read_messages').content).messages.at(-1).seq});
 const code=b.tools.some((x:any)=>x.function.name==='write_file');
 if(code&&!names.includes('read_file'))return agentResponse('read_file',{file:'summary.test.mjs'});
 if(code&&!names.includes('write_file'))return agentResponse('write_file',{file:'summary.mjs',content:SOLUTION});
 if(code&&!names.includes('check_change'))return agentResponse('check_change',{summary:'Summarize observed checks without inventing readiness'});
 return agentResponse('post_message',{body:code?'OFFLINE fixture: the real fixed check passed. The change still needs human inspection.':'OFFLINE fixture greeting to the real saved human message.'});
 })as typeof fetch};}

async function originalCrew(f:ReturnType<typeof fixture>){
 const op=()=>crypto.randomUUID();
 const i=await(await f.call('identities',{operationId:op(),displayName:'Command',creationSource:'offline-original-session-test'})).json()as any;
 const invite=await(await f.call('identities/'+i.identity.id+'/invitations',{operationId:op(),scopes:['read','conversation:read','conversation:write','tasks:write']})).json()as any;
 const session=await(await f.call('enrollment/exchange',{operationId:op(),adapter:'offline-original-session',model:'unknown',provider:'offline',harness:'offline fixture',host:'local'},invite.token)).json()as any;
 const profile=await f.call('presentation',{identityId:session.identityId,sessionId:session.sessionId,name:'Command',mode:'original',summary:'Compatible changes, exact-source review and recovery of uncertain outcomes.'});assert.equal(profile.status,200);
 return session;
}

test('transport: explicit same-greeting continuation preserves unknown charge, payload, identity and first failure',async t=>{
 const script=scripted();let unavailable=true;
 const provider=(async(url:any,init:any)=>{if(unavailable)throw Object.assign(new TypeError('fetch failed '+key),{cause:Object.assign(new Error('offline timeout '+owner),{code:'ETIMEDOUT'})});return script.fetch(url,init);})as typeof fetch;
 const f=fixture(t,provider);await f.call('nemo/connect',{});const originalIdentity=f.nemo.publicState().identity;
 const human=await(await f.call('conversations/team/messages',{body:'One original greeting',clientRequestId:'transport-one-root'})).json()as any;
 await f.call('nemo/run',{kind:'hello'});const failed=await settle(f.nemo),runId=failed.runs[0].id;
 const before=JSON.parse(readFileSync(join(f.nemoDir,'nemo-private.json'),'utf8')),request1=JSON.stringify(before.requests[0]),initialHistory=JSON.stringify(before.runs[0].messages);
 assert.equal(before.requests[0].transport.error.cause.code,'ETIMEDOUT');assert.ok(!request1.includes(key));assert.ok(!request1.includes(owner));
 assert.equal((await f.call('nemo/continue-transport',{runId})).status,409);assert.equal(f.nemo.publicState().budget.calls,1);
 unavailable=false;
 const responses=await Promise.all([f.call('nemo/continue-transport',{runId,acknowledgeUnknownCharge:true}),f.call('nemo/continue-transport',{runId,acknowledgeUnknownCharge:true})]);assert.deepEqual(responses.map(r=>r.status).sort(),[202,409]);
 const state=await settle(f.nemo),after=JSON.parse(readFileSync(join(f.nemoDir,'nemo-private.json'),'utf8'));
 assert.equal(state.runs.length,1);assert.equal(state.runs[0].id,runId);assert.equal(state.runs[0].humanId,human.message.id);assert.equal(state.runs[0].status,'completed',state.runs[0].error);assert.deepEqual(state.identity,originalIdentity);
 assert.equal(JSON.stringify(after.requests[0]),request1);assert.equal(JSON.stringify(after.runs[0].messages.slice(0,2)),initialHistory);assert.equal(after.requests[1].requestSha256,after.requests[0].requestSha256);assert.equal(after.requests[1].deadlineMs,180000);assert.equal(after.requests[2].deadlineMs,70000);assert.equal(state.budget.calls,4);
 assert.equal(after.runs[0].initialTransportFailure.endedAt,before.runs[0].endedAt);assert.equal(after.runs[0].initialTransportFailure.requestRecordSha256,hash(request1));assert.ok(after.runs[0].events.some((e:any)=>e.kind==='stopped'));assert.equal((await f.call('nemo/continue-transport',{runId,acknowledgeUnknownCharge:true})).status,409);
 const page=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(page.messages.length,2);assert.equal(page.messages[1].replyToId,human.message.id);assert.equal(Object.keys((await f.api.storeFor('demo')!.read()).tasks).length,0);
});

test('transport: a second unknown outcome stops permanently instead of enabling another continuation',async t=>{
 let calls=0;const f=fixture(t,(async()=>{calls++;throw Error('Offline transport unavailable')})as typeof fetch);await f.call('nemo/connect',{});await f.call('conversations/team/messages',{body:'One root only',clientRequestId:'transport-stop-root'});
 await f.call('nemo/run',{kind:'hello'});let state=await settle(f.nemo);const runId=state.runs[0].id;
 await f.call('nemo/continue-transport',{runId,acknowledgeUnknownCharge:true});state=await settle(f.nemo);
 assert.equal(state.runs[0].status,'failed');assert.equal(state.budget.calls,2);assert.equal(calls,2);assert.equal(state.runs[0].transportFailureResumable,false);assert.equal((await f.call('nemo/continue-transport',{runId,acknowledgeUnknownCharge:true})).status,409);assert.equal(calls,2);
});

test('transport: Stop during the manual continuation preserves both reservations and posts nothing',async t=>{
 let calls=0,enter!:()=>void;const entered=new Promise<void>(done=>{enter=done});
 const provider=(async(_url:any,init:any)=>{calls++;if(calls===1)throw Error('Offline first transport failure');enter();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));})as typeof fetch;
 const f=fixture(t,provider);await f.call('nemo/connect',{});await f.call('conversations/team/messages',{body:'Stop control root',clientRequestId:'transport-cancel-root'});await f.call('nemo/run',{kind:'hello'});const failed=await settle(f.nemo);
 const before=JSON.parse(readFileSync(join(f.nemoDir,'nemo-private.json'),'utf8')).requests[0];
 await f.call('nemo/continue-transport',{runId:failed.runs[0].id,acknowledgeUnknownCharge:true});await entered;await f.call('nemo/cancel',{});const state=await settle(f.nemo),after=JSON.parse(readFileSync(join(f.nemoDir,'nemo-private.json'),'utf8'));
 assert.equal(state.runs[0].status,'cancelled');assert.equal(state.budget.calls,2);assert.deepEqual(after.requests[0],before);assert.equal(after.requests[1].transport.abortSource,'owner-stop');assert.equal((await(await f.call('conversations/team?after=0')).json()as any).messages.length,1);assert.equal(Object.keys((await f.api.storeFor('demo')!.read()).tasks).length,0);
});

test('recording: actual original-crew trigger is consumed and final text replies to that exact message',async t=>{
 const script=scripted(),body='OFFLINE own final response to actual crew';
 const provider=(async(url:any,init:any)=>{const value=await(await script.fetch(url,init)).json()as any;if(value.choices[0].message.tool_calls[0].function.name==='post_message')value.choices[0].message={role:'assistant',content:body};return Response.json(value);})as typeof fetch;
 const f=fixture(t,provider);await f.call('nemo/connect',{});const crew=await originalCrew(f);
 const posted=await(await f.call('conversations/team/messages',{body:'Actual offline crew request',clientRequestId:'crew-request'},crew.token)).json()as any;
 assert.equal((await f.call('nemo/run',{kind:'hello',messageId:posted.message.id})).status,202);
 const state=await settle(f.nemo);assert.equal(state.runs[0].status,'completed',state.runs[0].error);
 const page=await(await f.call('conversations/team?after=0')).json()as any;
 assert.equal(page.messages.length,2);assert.equal(page.messages[0].sender.mode,'original');assert.equal(page.messages[1].replyToId,posted.message.id);assert.equal(page.messages[1].body,body);
 assert.equal(page.messages[1].sender.name,'NVIDIA Nemotron');assert.equal(state.runs[0].delivery.byteEqual,true);
 assert.equal((await f.call('nemo/run',{kind:'hello',messageId:page.messages[1].id})).status,422);assert.equal(f.nemo.publicState().budget.calls,3);
});

test('recording: claim existing crew-created task without fabricated human request or duplicate task',async t=>{
 const script=scripted(),f=fixture(t,script.fetch,undefined,true);await f.call('nemo/connect',{});
 assert.equal((await f.call('nemo/run',{kind:'code'})).status,422);assert.equal(f.nemo.publicState().budget.calls,0);
 assert.equal((await(await f.call('conversations/team?after=0')).json()as any).messages.length,0);
 const crew=await originalCrew(f);
 const created=await(await f.call('tasks',{operationId:crypto.randomUUID(),goal:'Crew-owned helper request',acceptanceCriteria:['Frozen source tests pass','Missing evidence stays unknown']},crew.token)).json()as any;
 const message=await(await f.call('conversations/team/messages',{body:'Implement the shared helper task and leave your exact change for review.',clientRequestId:'crew-code-request'},crew.token)).json()as any;
 assert.equal((await f.call('nemo/run',{kind:'code',taskId:created.task.id,messageId:message.message.id})).status,202);
 const state=await settle(f.nemo),run=state.runs[0];assert.equal(run.status,'completed',run.error??run.check?.output);assert.equal(run.taskId,created.task.id);assert.equal(run.check?.outcome,'pass');
 const shared=await f.api.storeFor('demo')!.read();assert.equal(Object.keys(shared.tasks).length,1);assert.equal(shared.tasks[created.task.id].goal,'Crew-owned helper request');assert.equal(run.assignment.identityId,state.identity!.id);
 const page=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(page.messages.length,2);assert.ok(page.messages.every((m:any)=>m.sender.mode!=='human'));assert.equal(page.messages.at(-1).replyToId,message.message.id);
});

test('owned file tools refuse escape and frozen fixture edits',t=>{
 const f=fixture(t);assert.throws(()=>writeDemoFile(f.repo,'summary.test.mjs','bad'));assert.throws(()=>readDemoFile(f.repo,'../owner-token'));
 assert.equal(readDemoFile(f.repo,'summary.test.mjs'),DEMO_TESTS);writeDemoFile(f.repo,'summary.mjs',SOLUTION);assert.equal(readDemoFile(f.repo,'summary.mjs'),SOLUTION);
});
test('idle/connect are free, owner-only surface, stable identity after local harness restart',async t=>{
 let calls=0;const f=fixture(t,(async()=>{calls++;throw Error('no inference')})as typeof fetch);
 assert.equal((await f.call('nemo')).status,200);assert.equal((await f.call('nemo',undefined,'bad')).status,401);
 assert.equal((await f.call('nemo/connect',{},owner,'https://foreign.invalid')).status,403);
 const first=await(await f.call('nemo/connect',{})).json() as any;assert.equal(calls,0);
 const restarted=new LocalNemo({stateDir:f.nemoDir,repo:f.repo,projectId:'demo',ownerToken:owner,api:f.api,key:()=>key});
 assert.deepEqual(restarted.publicState().identity,first.identity);assert.equal(restarted.publicState().budget.calls,0);
 const visible=JSON.stringify(restarted.publicState());assert.ok(!visible.includes(owner));assert.ok(!visible.includes(key));assert.ok(!visible.includes(JSON.parse(readFileSync(join(f.nemoDir,'nemo-private.json'),'utf8')).identity.token));
});
test('actual API read, acknowledgement and linked greeting through deterministic offline provider',async t=>{
 const script=scripted(),f=fixture(t,script.fetch);await f.call('nemo/connect',{});
 const human=await(await f.call('conversations/team/messages',{body:'Hello, local fish',clientRequestId:'offline-hello'})).json() as any;
 assert.equal((await f.call('nemo/run',{kind:'hello'})).status,202);const state=await settle(f.nemo);
 assert.equal(state.runs[0].status,'completed',state.runs[0].error);assert.equal(script.calls,3);
 const page=await(await f.call('conversations/team?after=0')).json() as any;assert.equal(page.messages.length,2);
 assert.equal(page.messages[1].replyToId,human.message.id);assert.equal(page.messages[1].sender.id,state.identity!.id);
});
test('offline code journey binds actual model bytes, Git candidate, collector receipt, exact downloads',async t=>{
 const script=scripted(),f=fixture(t,script.fetch);await f.call('nemo/connect',{});
 assert.equal((await f.call('nemo/run',{kind:'code'})).status,202);const state=await settle(f.nemo),run=state.runs[0];
 assert.equal(run.status,'completed',run.error??run.check?.output);assert.equal(run.check?.outcome,'pass',run.check?.output);
 assert.equal(readDemoFile(f.repo,'summary.mjs'),SOLUTION);assert.equal(run.check!.outputHash,hash(run.check!.output));
 const saved=await f.api.storeFor('demo')!.read();assert.equal(saved.proposals[run.proposalId!].authorId,state.identity!.id);assert.equal(saved.jobs[run.checkId!].candidateSha,run.check!.candidateSha);
 const receipt=Object.values(saved.receipts)[0];assert.equal(receipt.outcome,'pass');assert.equal(receipt.outputHash,run.check!.outputHash);
 assert.equal(saved.tasks[run.taskId!].lifecycle,'in-progress');assert.match(String(saved.tasks[run.taskId!].progressSummary),/Awaiting human review/);assert.match(String(saved.tasks[run.taskId!].nextAction),/nothing has been integrated/);assert.ok(!saved.tasks[run.taskId!].completion);
 assert.equal(run.patch,execFileSync('git',['-C',f.repo,'diff','--binary',saved.proposals[run.proposalId!].base,saved.proposals[run.proposalId!].head,'--','summary.mjs'],{encoding:'utf8'}));
 assert.equal(await(await f.call('nemo/patch/'+run.id)).text(),run.patch);assert.equal(await(await f.call('nemo/output/'+run.checkId)).text(),run.check!.output);
 assert.equal((await f.call('nemo/run',{kind:'code'})).status,409);assert.equal(script.calls,6);
});
test('billing refusal retained and halts without retries or resetting usage',async t=>{
 let calls=0;const f=fixture(t,(async()=>{calls++;return Response.json({error:'credits'},{status:402})})as typeof fetch);await f.call('nemo/connect',{});await f.call('conversations/team/messages',{body:'hello',clientRequestId:'billing-hello'});
 await f.call('nemo/run',{kind:'hello'});const state=await settle(f.nemo);assert.equal(state.runs[0].status,'failed');assert.match(state.budget.halt!,/402/);assert.equal(calls,1);assert.equal(state.budget.calls,1);assert.equal((await f.call('nemo/run',{kind:'hello'})).status,409);
});
test('concurrent connect and start operations coalesce or reject without a second active run',async t=>{
 const script=scripted(),f=fixture(t,script.fetch);
 const connections=await Promise.all([f.call('nemo/connect',{}),f.call('nemo/connect',{})]);
 const profiles=await Promise.all(connections.map(r=>r.json())) as any[];assert.deepEqual(profiles[0].identity,profiles[1].identity);
 await f.call('conversations/team/messages',{body:'one hello',clientRequestId:'parallel-hello'});
 const attempts=await Promise.all([f.call('nemo/run',{kind:'hello'}),f.call('nemo/run',{kind:'hello'})]);
 assert.deepEqual(attempts.map(r=>r.status).sort(),[202,409]);const state=await settle(f.nemo);assert.equal(state.runs.length,1);assert.equal(script.calls,3);
});
test('normal assistant final text is delivered unchanged and labelled as transport, not a tool call',async t=>{
 const script=scripted();const body='OFFLINE exact final reply — 🐠';
 const provider=(async(url:any,init:any)=>{const response=await script.fetch(url,init);const value=await response.json() as any;if(value.choices[0].message.tool_calls[0].function.name==='post_message')value.choices[0].message={role:'assistant',content:body};return Response.json(value);})as typeof fetch;
 const f=fixture(t,provider);await f.call('nemo/connect',{});await f.call('conversations/team/messages',{body:'hello',clientRequestId:'plain-hello'});await f.call('nemo/run',{kind:'hello'});
 const state=await settle(f.nemo);assert.equal(state.runs[0].status,'completed',state.runs[0].error);assert.equal(state.runs[0].delivery.byteEqual,true);assert.equal(state.runs[0].delivery.modelToolCallInvented,false);assert.equal(script.calls,3);
 const page=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(page.messages.at(-1).body,body);
});
test('saved failed greeting recovery preserves original run and deduplicates without inference',async t=>{
 const f=fixture(t,(async()=>{throw Error('Recovery must never infer')})as typeof fetch);await f.call('nemo/connect',{});
 const human=await(await f.call('conversations/team/messages',{body:'hello',clientRequestId:'recovery-hello'})).json()as any;
 const page=await(await f.call('conversations/team?after=0')).json()as any;
 const privatePath=join(f.nemoDir,'nemo-private.json'),state=JSON.parse(readFileSync(privatePath,'utf8'));
 const run={id:'offline-saved-final',kind:'hello',status:'failed',startedAt:new Date().toISOString(),humanId:human.message.id,events:[{kind:'stopped',data:{error:'Original delivery failure'}}],messages:[{role:'tool',name:'read_messages',content:JSON.stringify(page)},{role:'assistant',content:'OFFLINE saved final response 🐠'}],readConsumed:true,error:'Model stopped before completing the actual tool actions; response retained'};
 state.runs=[run];state.requests=[{number:1,runId:run.id,status:'complete',reserveUsd:.001,estimatedUsd:.0001}];writeFileSync(privatePath,JSON.stringify(state));
 const recovered=new LocalNemo({stateDir:f.nemoDir,repo:f.repo,projectId:'demo',ownerToken:owner,api:f.api,key:()=>key,providerFetch:(async()=>{throw Error('No inference')})as typeof fetch});
 const before=JSON.stringify(run);const first=await recovered.deliverSavedFinal(run.id),second=await recovered.deliverSavedFinal(run.id);
 assert.equal(first.replyId,second.replyId);assert.equal(second.duplicate,true);assert.equal(first.byteEqual,true);assert.equal(first.additionalInferenceRequests,0);
 const after=JSON.parse(readFileSync(privatePath,'utf8'));assert.equal(JSON.stringify(after.runs[0]),before);assert.equal(after.requests.length,1);
 const messages=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(messages.messages.length,2);
});
test('recoverable tool precondition errors return to the model without ending its original task',async t=>{
 const script=scripted();let intercepted=false;
 const provider=(async(url:any,init:any)=>{const response=await script.fetch(url,init);const value=await response.json()as any;const name=value.choices[0].message.tool_calls[0].function.name;if(!intercepted&&name==='write_file'){intercepted=true;return agentResponse('check_change',{summary:'Try the check before editing'});}return Response.json(value);})as typeof fetch;
 const f=fixture(t,provider);await f.call('nemo/connect',{});await f.call('nemo/run',{kind:'code'});const state=await settle(f.nemo),run=state.runs[0];
 assert.equal(run.status,'completed',run.error);assert.equal(run.check?.outcome,'pass');assert.ok(run.events.some(e=>e.kind==='tool-error'&&e.data.name==='check_change'));assert.equal(state.runs.length,1);assert.equal(script.calls,7);
});
test('known interrupted tool feedback continues same saved history, task and assignment without reset',async t=>{
 const script=scripted(),f=fixture(t,script.fetch);await f.call('nemo/connect',{});
 const privatePath=join(f.nemoDir,'nemo-private.json'),state=JSON.parse(readFileSync(privatePath,'utf8'));
 const human=await(await f.call('conversations/team/messages',{body:'offline coding task',clientRequestId:'resume-human'})).json()as any;
 const page=await(await f.call('conversations/team?after=0',undefined,state.identity.token)).json()as any;
 const task=await(await f.call('tasks',{operationId:'resume-task',goal:'Offline task',acceptanceCriteria:['Frozen tests pass']})).json()as any;
 const claimed=await(await f.call('tasks/'+task.task.id+'/assignments',{operationId:'resume-claim',expectedRevision:task.task.revision,role:'owner'},state.identity.token)).json()as any;
 const run={id:'offline-code-resume',kind:'code',status:'failed',startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),humanId:human.message.id,taskId:task.task.id,assignment:claimed.assignment,events:[{kind:'stopped',data:{error:'Write the owned helper first; one fixed check is permitted per run'}}],messages:[{role:'system',content:'OFFLINE fixture: use the provided tools.'},{role:'tool',name:'read_messages',tool_call_id:'offline-read',content:JSON.stringify(page)},{role:'assistant',content:'',tool_calls:[{id:'offline-failed-check',type:'function',function:{name:'check_change',arguments:'{"summary":"Check before writing"}'}}]}],readConsumed:true,error:'Write the owned helper first; one fixed check is permitted per run'};
 state.runs=[run];state.requests=[{number:1,runId:run.id,status:'complete',reserveUsd:.001,estimatedUsd:.0001}];writeFileSync(privatePath,JSON.stringify(state));
 const resumed=new LocalNemo({stateDir:f.nemoDir,repo:f.repo,projectId:'demo',ownerToken:owner,api:f.api,key:()=>key,providerFetch:script.fetch});
 resumed.resumeKnownToolFailure(run.id);const result=await settle(resumed),after=result.runs[0],saved=JSON.parse(readFileSync(privatePath,'utf8'));
 assert.equal(after.status,'completed',after.error);assert.equal(after.taskId,run.taskId);assert.equal(after.assignment.id,run.assignment.id);assert.equal(result.runs.length,1);assert.equal(result.budget.calls,1+script.calls);
 assert.deepEqual(saved.runs[0].messages.slice(0,run.messages.length),run.messages);assert.equal(saved.runs[0].messages[run.messages.length].tool_call_id,'offline-failed-check');assert.equal(after.initialFailure.error,run.error);assert.equal(after.resumeCount,1);
 assert.throws(()=>resumed.resumeKnownToolFailure(run.id));
});
test('cancel pending inference preserves ambiguous reservation and stops future writes',async t=>{
 const f=fixture(t,((_url:any,init:any)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted')))))as typeof fetch);await f.call('nemo/connect',{});await f.call('conversations/team/messages',{body:'hello',clientRequestId:'cancel-hello'});
 await f.call('nemo/run',{kind:'hello'});for(let i=0;i<100&&f.nemo.publicState().budget.calls===0;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal((await f.call('nemo/cancel',{})).status,200);const state=f.nemo.publicState();assert.equal(state.runs[0].status,'cancelled');assert.equal(state.budget.calls,1);assert.match(state.budget.halt!,/unknown/);
 const page=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(page.messages.length,1);
});
test('cancelling an active fixed check kills its child and cannot manufacture passing evidence',async t=>{
 const script=scripted();const provider=(async(url:any,init:any)=>{const response=await script.fetch(url,init);const value=await response.json()as any;const call=value.choices[0].message.tool_calls[0];if(call.function.name==='write_file')call.function.arguments=JSON.stringify({file:'summary.mjs',content:'export function summarizeChecks(){while(true){}}'});return Response.json(value);})as typeof fetch;
 const f=fixture(t,provider);await f.call('nemo/connect',{});await f.call('nemo/run',{kind:'code'});
 for(let i=0;i<150&&!f.nemo.publicState().runs[0]?.checkId;i++)await new Promise(r=>setTimeout(r,10));
 const run=f.nemo.publicState().runs[0];assert.ok(run.checkId);assert.equal((await f.call('nemo/cancel',{})).status,200);
 for(let i=0;i<100&&!f.nemo.publicState().runs[0].check;i++)await new Promise(r=>setTimeout(r,10));
 const after=f.nemo.publicState().runs[0];assert.equal(after.status,'cancelled');assert.equal(after.check?.outcome,'cancelled');
 const state=await f.api.storeFor('demo')!.read();assert.equal(state.jobs[run.checkId!].status,'failed');assert.ok(Object.values(state.receipts).some(r=>r.outcome==='error'));assert.ok(!Object.values(state.receipts).some(r=>r.outcome==='pass'));
});
test('revoking the bound agent before a returned write prevents file mutation and further inference',async t=>{
 const script=scripted();let f:ReturnType<typeof fixture>;let revoked=false;
 const provider=(async(url:any,init:any)=>{const response=await script.fetch(url,init);const value=await response.json()as any;if(value.choices[0].message.tool_calls[0].function.name==='write_file'){
  const state=await f.api.storeFor('demo')!.read(),identity=state.identities[f.nemo.publicState().identity!.id];
  assert.equal((await f.call('identities/'+identity.id+'/revoke',{operationId:'offline-revoke',expectedRevision:identity.revision})).status,200);revoked=true;
 }return Response.json(value);})as typeof fetch;
 f=fixture(t,provider);await f.call('nemo/connect',{});await f.call('nemo/run',{kind:'code'});const state=await settle(f.nemo);
 assert.equal(revoked,true);assert.equal(state.runs[0].status,'failed');assert.match(readDemoFile(f.repo,'summary.mjs'),/Not implemented yet/);assert.ok(!state.runs[0].events.some(e=>e.kind==='tool'&&e.data.name==='write_file'));
});
test('F2 cancel while candidate creation awaits its response prevents check dispatch', {timeout:5000},async t=>{
 const gate=apiGate(r=>r.method==='POST'&&new URL(r.url).pathname.endsWith('/candidates'));t.after(gate.release);
 const script=scripted();let checkPosts=0;
 const f=fixture(t,script.fetch,async(r,response)=>{if(r.method==='POST'&&new URL(r.url).pathname.endsWith('/checks'))checkPosts++;return gate.after(r,response);});
 await f.call('nemo/connect',{});await f.call('nemo/run',{kind:'code'});await gate.entered;
 assert.equal(f.nemo.publicState().runs[0].checkId,undefined);const cancel=f.nemo.cancel();gate.release();await cancel;
 const state=await f.api.storeFor('demo')!.read();assert.equal(checkPosts,0);assert.equal(Object.keys(state.jobs).length,0);assert.equal(f.nemo.publicState().runs[0].status,'cancelled');
 const messages=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(messages.messages.length,1);
});
test('F2 cancel during check dispatch reconciles its late job id and awaits child termination', {timeout:5000},async t=>{
 const gate=apiGate(r=>r.method==='POST'&&new URL(r.url).pathname.endsWith('/checks'));t.after(gate.release);
 const script=scripted();const provider=(async(url:any,init:any)=>{const r=await script.fetch(url,init),v=await r.json()as any;const c=v.choices[0].message.tool_calls[0];if(c.function.name==='write_file')c.function.arguments=JSON.stringify({file:'summary.mjs',content:'export function summarizeChecks(){while(true){}}'});return Response.json(v);})as typeof fetch;
 const f=fixture(t,provider,gate.after);await f.call('nemo/connect',{});await f.call('nemo/run',{kind:'code'});
 const dispatched=await(await gate.entered).json()as any;assert.equal(f.nemo.publicState().runs[0].checkId,undefined);
 const beforeCalls=script.calls,cancel=f.nemo.cancel();gate.release();await cancel;
 const run=f.nemo.publicState().runs[0],state=await f.api.storeFor('demo')!.read();assert.equal(run.status,'cancelled');assert.equal(run.checkId,dispatched.job.id);assert.equal(run.check?.outcome,'cancelled');assert.ok(f.cancelledChecks.includes(dispatched.job.id));
 assert.equal(state.jobs[dispatched.job.id].status,'failed');assert.ok(Object.values(state.receipts).some(r=>r.outcome==='error'));assert.ok(!Object.values(state.receipts).some(r=>r.outcome==='pass'));assert.equal(script.calls,beforeCalls);
 const messages=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(messages.messages.length,1);
});
test('F2 cancel during final-response authority read prevents delivery and completed status', {timeout:5000},async t=>{
 let armed=false;const gate=apiGate(r=>armed&&r.method==='GET'&&new URL(r.url).pathname.endsWith('/work-context'));t.after(gate.release);
 const script=scripted();const provider=(async(url:any,init:any)=>{const r=await script.fetch(url,init),v=await r.json()as any;if(v.choices[0].message.tool_calls[0].function.name==='post_message'){armed=true;v.choices[0].message={role:'assistant',content:'OFFLINE final response that must not be delivered after Stop'};}return Response.json(v);})as typeof fetch;
 const f=fixture(t,provider,gate.after);await f.call('nemo/connect',{});await f.call('conversations/team/messages',{body:'hello',clientRequestId:'final-context-race'});await f.call('nemo/run',{kind:'hello'});await gate.entered;
 const cancel=f.nemo.cancel();gate.release();await cancel;
 const run=f.nemo.publicState().runs[0];assert.equal(run.status,'cancelled');assert.equal(run.delivery,undefined);assert.ok(!run.events.some(e=>e.kind==='final-response-delivered'));
 const messages=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(messages.messages.length,1);
});
test('F2 a reply already committed before Stop keeps its receipt but never marks the run completed', {timeout:5000},async t=>{
 let armed=false;const gate=apiGate(r=>armed&&r.method==='POST'&&new URL(r.url).pathname.endsWith('/conversations/team/messages'));t.after(gate.release);
 const script=scripted();const provider=(async(url:any,init:any)=>{const r=await script.fetch(url,init),v=await r.json()as any;if(v.choices[0].message.tool_calls[0].function.name==='post_message'){armed=true;v.choices[0].message={role:'assistant',content:'OFFLINE final response already committed before cancellation'};}return Response.json(v);})as typeof fetch;
 const f=fixture(t,provider,gate.after);await f.call('nemo/connect',{});await f.call('conversations/team/messages',{body:'hello',clientRequestId:'final-commit-race'});await f.call('nemo/run',{kind:'hello'});await gate.entered;
 const cancel=f.nemo.cancel();gate.release();await cancel;
 const run=f.nemo.publicState().runs[0];assert.equal(run.status,'cancelled');assert.equal(run.delivery.cancelObservedAfterCommit,true);assert.equal(run.delivery.byteEqual,true);
 const messages=await(await f.call('conversations/team?after=0')).json()as any;assert.equal(messages.messages.length,2);
});
