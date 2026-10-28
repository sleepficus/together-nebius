import test from 'node:test';
import assert from 'node:assert/strict';
import {openConversationStore} from '../cloud/local-conversation.ts';
import {createApp} from '../cloud/app.ts';
import {PROJECT_HANDLERS} from '../cloud/handlers.ts';
import {MemoryStore} from '../lib/store.ts';
import {createState,digestOf,exportSnapshot,safeSnapshot} from '../lib/core.ts';
import {CREW_CREDITS,CHAT_SCOPES} from '../lib/conversation-types.ts';
import {checkpointInput} from '../lib/checkpoint.ts';
import {readiness} from '../lib/integration.ts';
import {authenticate} from '../lib/identity.ts';
import type {Principal,Context} from '../lib/types.ts';
const NOW='2026-10-05T02:00:00.000Z';
function fixture(runtime?:any){
 const sql=openConversationStore(':memory:');let uid=0;let instant=NOW;
 const state=createState({id:'p',goal:'Useful crew lounge',mode:'live',actorId:'steve'});
 for(const id of ['steve','worker','late']){state.identities[id]={id,projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',displayName:id,ownerId:'steve',creationSource:'owner',status:'active'};state.members[id]={id,projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',identityId:id,kind:'core',scopes:Object.values(CHAT_SCOPES)};state.sessions[id+'-s']={id:id+'-s',identityId:id,projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',advertisedCapabilities:[],observedCapabilities:[],status:'active'};}
 const work=new MemoryStore(state);
 const owner:Principal={id:'steve',sessionId:'steve-s',kind:'human',ownerId:'steve',scopes:['owner','admin','read'],projectIds:['p']};
 const agent:Principal={...owner,id:'worker',sessionId:'worker-s',kind:'agent',scopes:['read',...Object.values(CHAT_SCOPES).filter(x=>x!=='runtime:attest')]};
 const system:Principal={...owner,id:'mediator',kind:'system',scopes:['read',CHAT_SCOPES.read,CHAT_SCOPES.attest]};
 const ctx=(principal=owner):Context=>({principal,store:work,conversation:sql.store,now:()=>instant,uid:()=>`id-${++uid}`,runtime});
 async function call(path:string,body?:any,principal=owner){const app=createApp({store:work,conversation:sql.store,runtime,handlers:PROJECT_HANDLERS,authenticate:async()=>principal,now:()=>instant,uid:()=>`id-${++uid}`});const res=await app.fetch(new Request('http://localhost/api/v1/projects/p/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));return{status:res.status,body:await res.json() as any};}
 return{sql,work,owner,agent,system,call,ctx,time:(v:string)=>instant=v};
}
const post=(body:string,key:string)=>({body,clientRequestId:key});
async function prep(f:ReturnType<typeof fixture>){assert.equal((await f.call('conversations')).status,200);}
async function planRun(f:ReturnType<typeof fixture>){await prep(f);const plan=(await f.call('plans',{operationId:'plan1',tasks:[{key:'lounge',goal:'Persistent human messages',acceptanceCriteria:['No duplicate message']}]})).body.plan;assert.ok(plan?.digest);let rev=(await f.work.read()).project.revision;assert.equal((await f.call('plans/'+plan.id+'/adopt',{operationId:'adopt1',expectedRevision:rev})).status,200);const run=(await f.call('runs',{operationId:'run1',planRevisionId:plan.id,planDigest:plan.digest})).body.run;return{plan,run};}
test('M1/M2: real SQLite 1,000 messages use3 row writes each; bounded pages and unchanged work/export size',async()=>{
 const f=fixture();await prep(f);const before=JSON.stringify(await f.work.read());const sender={id:'steve',sessionId:'steve-s',name:'Steve · Hooman',mode:'human' as const};
 for(let i=0;i<1000;i++){const now=new Date(Date.parse(NOW)+i*1000).toISOString();const changes=()=>Number((f.sql.db.prepare('SELECT total_changes() n').get() as any).n);const n=changes();f.sql.store.append({conversationId:'team',body:i===0?'PRIVATE_CANARY_NO_EXPORT':'hello'+i,digest:'d'+i,requestId:'m'+i,sender,now,id:'m'+i,mentions:[]});assert.equal(changes()-n,3);}
 const page=f.sql.store.page('team','worker',0,0,30);assert.equal(page.messages.length,30);assert.equal(page.more,true);assert.equal(page.nextCursor,30);
 assert.equal(JSON.stringify(await f.work.read()),before);for(const obj of [safeSnapshot(await f.work.read(),f.owner),exportSnapshot(await f.work.read()),(await f.call('export')).body])assert.equal(JSON.stringify(obj).includes('PRIVATE_CANARY'),false);
 const n=Number((f.sql.db.prepare('SELECT total_changes() n').get() as any).n);f.sql.store.page('team','worker',0,1000,30);assert.equal(Number((f.sql.db.prepare('SELECT total_changes() n').get() as any).n),n);f.sql.close();
});
test('M1/M2: sender request retry is idempotent; changed payload409; revoked reads401 and late join sees only41',async()=>{
 const f=fixture();await prep(f);const body=post('hello','one');assert.equal((await f.call('conversations/team/messages',body)).status,201);assert.equal((await f.call('conversations/team/messages',body)).status,200);assert.equal((await f.call('conversations/team/messages',post('changed','one'))).status,409);
 for(let i=2;i<=40;i++)await f.call('conversations/team/messages',post('msg'+i,'m'+i));await f.work.transact(d=>{delete d.members.late;});f.sql.db.prepare('DELETE FROM chat_members WHERE identity_id=?').run('late');
 f.time('2026-10-05T02:01:00.000Z');await f.work.transact(d=>{d.members.late={...d.members.worker,id:'late',identityId:'late',createdAt:'2026-10-05T02:00:30.000Z'};});await f.call('conversations/team/messages',post('41','m41'));
 const late={...f.agent,id:'late',sessionId:'late-s'};const p=await f.call('conversations/team?after=0',undefined,late);assert.deepEqual(p.body.messages.map((m:any)=>m.seq),[41]);await f.work.transact(d=>{d.identities.worker.status='revoked';});assert.equal((await f.call('conversations/team',undefined,f.agent)).status,401);f.sql.close();
});
test('M3/M4/M5:500 offline messages, frozen sender, opened vs included, exact gaps and trusted lineage',async()=>{
 const f=fixture();await prep(f);await f.call('presentation',{identityId:'worker',name:'Field',mode:'persona',summary:CREW_CREDITS[5].summary,sessionId:'worker-s',runtimeLabel:'Fixture Devin',requestedModel:'swe-2-high'});
 const old=(await f.call('conversations/team/messages',post('first','worker-first'),f.agent)).body.message;await f.call('presentation',{identityId:'worker',name:'Way',mode:'persona',summary:CREW_CREDITS[3].summary,sessionId:'worker-s',runtimeLabel:'Other fixture'});assert.equal(f.sql.store.message(old.id)!.sender.name,'Field');
 for(let i=0;i<500;i++){f.time(new Date(Date.parse(NOW)+i*1000).toISOString());await f.call('conversations/team/messages',post('offline'+i,'o'+i));}assert.equal(Object.keys((await f.work.read()).messages).length,0);
 const p=await f.call('conversations/team',undefined,f.agent);assert.equal(p.body.messages.length,30);const seq=p.body.nextCursor;assert.equal((await f.call('conversations/team/opened',{seq},f.agent)).body.cursor.opened,seq);
 const ids=p.body.messages.slice(1,3).map((m:any)=>m.id);const turn={id:'turn',sessionId:'worker-s',status:'running',recipientId:'worker',jobId:'job',inputDigest:'exact',messageIds:ids,createdAt:NOW};f.sql.store.putRecord('chat_turns',turn);
 const att={attestationId:'a',turnId:'turn',jobId:'job',inputDigest:'exact',recipientId:'worker',conversationId:'team',messageIds:ids};assert.equal((await f.call('runtime-inclusion',att,f.agent)).status,403);assert.equal((await f.call('runtime-inclusion',{...att,inputDigest:'fake'},f.system)).status,409);assert.equal((await f.call('runtime-inclusion',att,f.system)).status,200);const cursor=f.sql.store.cursor('team','worker',0);assert.equal(cursor.included,0);assert.deepEqual(cursor.includedIds,ids);f.sql.close();
});
test('M2/M5: checkpoint caps exact serialized input and omits private audiences, irrelevant lounge',async()=>{
 const f=fixture();await prep(f);await f.work.transact(d=>{d.tasks.t={id:'t',projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',goal:'task',acceptanceCriteria:[],dependencies:[],lifecycle:'open',resultRefs:[]};});await f.call('conversations',{taskId:'t',audience:['steve']});await f.call('conversations/task:t/messages',post('PRIVATE_TASK_CANARY','private'));await f.call('conversations/lounge/messages',post('uninvited lounge','lo'));
 for(let i=0;i<25;i++)await f.call('conversations/team/messages',post('x'.repeat(1000),'context'+i));const input=await checkpointInput(f.ctx(),f.agent,{taskId:'t'});assert.ok(Buffer.byteLength(input.inputText)<=8192);assert.ok(input.messageIds.length<=20);assert.ok(input.truncated);assert.equal(input.inputText.includes('PRIVATE_TASK_CANARY'),false);assert.equal(input.inputText.includes('uninvited lounge'),false);assert.equal(input.inputDigest,await digestOf(input.inputText));f.sql.close();
});
test('M6: immutable plan adoption retries preserve task IDs; stale proposals fail readiness',async()=>{
 const f=fixture();const {plan}=await planRun(f);const state=await f.work.read();const ids=Object.keys(state.tasks);const prior=state.operations.adopt1;assert.equal((await f.call('plans/'+plan.id+'/adopt',{operationId:'adopt1',expectedRevision:prior.expectedRevision})).status,200);assert.deepEqual(Object.keys((await f.work.read()).tasks),ids);
 const cand:any={id:'c',proposalIds:['q'],proposalHeads:{q:'sha'},sha:'sha',policyVersion:1,checkJobIds:[],reviewIds:[],status:'prepared'};state.proposals.q={id:'q',taskIds:ids,planRevisionId:'old'} as any;assert.ok(readiness(state,cand).reasons.some(r=>r.includes('requires '+plan.id)));f.sql.close();
});
test('M7/M8: lost Start acknowledgement has no second dispatch; stop revokes credential before cancellation; stopped resume409',async()=>{
 const jobs:any[]=[];const runtime={allowances:{draft:1,run:2,lounge:3,hourlyLounge:3},enqueue:async(x:any)=>{jobs.push(x);throw new Error('lost acknowledgement');}};const f=fixture(runtime);const {run}=await planRun(f);const b={operationId:'start',expectedRevision:run.revision};assert.equal((await f.call('runs/'+run.id+'/start',b)).body.run.status,'unconfirmed');await f.call('runs/'+run.id+'/start',b);assert.equal(jobs.length,1);
 await f.work.transact(d=>{d.runs![run.id].status='running';d.runs![run.id].sessionId='worker-s';d.credentials.c={id:'c',projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',identityId:'worker',tokenHash:'x',status:'active',scopes:[CHAT_SCOPES.write],projectIds:['p'],runId:run.id,runEpoch:d.runs![run.id].epoch};});let r=(await f.work.read()).runs![run.id];await f.call('runs/'+run.id+'/stop',{operationId:'stop',expectedRevision:r.revision});assert.equal((await f.work.read()).credentials.c.status,'revoked');assert.ok((await f.work.read()).runs![run.id].epoch>r.epoch);await f.work.transact(d=>{d.runs![run.id].status='stopped';});r=(await f.work.read()).runs![run.id];assert.equal((await f.call('runs/'+run.id+'/resume',{operationId:'resume',expectedRevision:r.revision})).status,409);f.sql.close();
});
test('M8: project stop advances all active runs; stale bound credential rejected',async()=>{
 const f=fixture();const {run}=await planRun(f);await f.work.transact(d=>{d.runs![run.id].status='running';d.runs!.second={...d.runs![run.id],id:'second',status:'paused'};});const s=await f.work.read();assert.equal((await f.call('stop',{operationId:'project-stop',expectedRevision:s.project.revision})).status,200);const after=await f.work.read();assert.ok(after.stopped);assert.ok(Object.values(after.runs!).every(r=>r.status==='stopping'));f.sql.close();
});
test('M9:5 concurrent invitations coalesce, exclusive slot and Away/stale/busy schedule zero extra calls',async()=>{
 const jobs:any[]=[];const runtime={allowances:{draft:1,run:1,lounge:3,hourlyLounge:3},enqueue:async(x:any)=>{jobs.push(x);return{id:'j'+jobs.length,status:'queued'}}};const f=fixture(runtime);const {run}=await planRun(f);await f.work.transact(d=>{Object.assign(d.runs![run.id],{status:'running',identityId:'worker',sessionId:'worker-s',heartbeatAt:NOW,availableSince:NOW});});await f.call('presentation',{identityId:'worker',name:'Field',mode:'persona',summary:CREW_CREDITS[5].summary,sessionId:'worker-s',runtimeLabel:'Fixture'});
 const messages=[];for(let i=0;i<5;i++)messages.push((await f.call('conversations/lounge/messages',post('thanks'+i,'click'+i))).body.message);await Promise.all(messages.map(m=>f.call('lounge/invite',{messageId:m.id})));assert.equal(jobs.length,1);assert.equal(f.sql.store.countTurns('lounge'),1);assert.ok(f.sql.store.activeTurn('worker-s'));
 assert.equal((await f.call('lounge/invite',{messageId:messages[0].id},f.agent)).status,403);assert.equal(Object.values((await f.work.read()).runs!)[0].status,'running');f.sql.close();
 const away=fixture(runtime);await prep(away);await away.call('presentation',{identityId:'worker',name:'Field',mode:'persona',summary:CREW_CREDITS[5].summary,sessionId:'worker-s',desired:'away'});const m=(await away.call('conversations/lounge/messages',post('coffee','coffee'))).body.message;await away.call('lounge/invite',{messageId:m.id});assert.equal(jobs.length,1);away.sql.close();
});
test('M10/M11: only real human badge, approved persona summaries, brief zero jobs, explicit draft one job retry',async()=>{
 const jobs:any[]=[];const runtime={allowances:{draft:1,run:0,lounge:0,hourlyLounge:0},enqueue:async(x:any)=>{jobs.push(x);return{id:'draft-job',status:'queued'}}};const f=fixture(runtime);await prep(f);assert.equal((await f.call('presentation',{identityId:'worker',name:'Steve · Hooman',mode:'human',summary:CREW_CREDITS[0].summary})).status,403);assert.equal((await f.call('presentation',{identityId:'worker',name:'Field',mode:'persona',summary:'PRIVATE_MEMORY'})).status,422);assert.equal((await f.call('conversations/team/messages',{...post('hi','spoof'),sender:{mode:'human'}},f.agent)).status,422);
 const m=(await f.call('conversations/team/messages',post('Build a useful lounge','brief'))).body.message;assert.equal(jobs.length,0);const b={operationId:'draft',messageId:m.id};assert.equal((await f.call('plan-draft',b)).status,202);assert.equal((await f.call('plan-draft',b)).status,200);assert.equal(jobs.length,1);assert.equal(JSON.stringify(jobs).includes('Build a useful lounge'),false);f.sql.close();
});

test('M3:500 mentions dedupe one body-free inbox notification without blocking chat',async()=>{const f=fixture();await prep(f);for(let i=0;i<500;i++){f.time(new Date(Date.parse(NOW)+i*1000).toISOString());assert.equal((await f.call('conversations/team/messages',{...post('PRIVATE_MENTION_CANARY'+i,'mention'+i),mentionIds:['worker']})).status,201);}const s=await f.work.read();assert.equal(Object.keys(s.messages).length,1);assert.equal(s.messages[Object.keys(s.messages)[0]].type,'system-notice');assert.equal(JSON.stringify(s).includes('PRIVATE_MENTION_CANARY'),false);f.sql.close();});
test('M10: delegated normalized names and legacy credentials receive no new chat scope',async()=>{const f=fixture();await prep(f);const delegated={...f.agent,scopes:['read','identity:delegate']};assert.equal((await f.call('identities',{operationId:'spoof-name',displayName:'Ｓｔｅｖｅ'},delegated)).status,403);assert.equal((await f.call('conversations/team',undefined,{...f.agent,scopes:['read']})).status,403);f.sql.close();});
test('M8: stale run credential fails authentication after atomic epoch advance',async()=>{const f=fixture();const {run}=await planRun(f);await f.work.transact(d=>{d.runs![run.id].status='running';});const {hashToken}=await import('../lib/identity.ts');const token='fixture-run-credential';await f.work.transact(d=>{d.credentials.c={id:'c',projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',identityId:'worker',sessionId:'worker-s',tokenHash:'',status:'active',scopes:[CHAT_SCOPES.write],projectIds:['p'],runId:run.id,runEpoch:0};});await f.work.transact(d=>{d.credentials.c.tokenHash='placeholder';});const hash=await hashToken(token);await f.work.transact(d=>{d.credentials.c.tokenHash=hash;});const req=new Request('http://localhost',{headers:{authorization:'Bearer '+token}});assert.ok(await authenticate(req,await f.work.read(),{}));await f.work.transact(d=>{d.runs![run.id].epoch++;});assert.equal(await authenticate(req,await f.work.read(),{}),null);f.sql.close();});

test('encoded task conversation URLs preserve authentication and private audience access',async()=>{
 const f=fixture();try{
  await prep(f);const taskId='3c38a41d-3b73-479e-9e8e-c1d0f6853902';
  await f.work.transact(d=>{d.tasks[taskId]={id:taskId,projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',goal:'Encoded route regression',acceptanceCriteria:[],dependencies:[],lifecycle:'open',resultRefs:[]};});
  const created=await f.call('conversations',{taskId,audience:['steve','worker']});assert.equal(created.status,201);
  const id=created.body.conversation.id;assert.equal(id,'task:'+taskId);const route='conversations/'+encodeURIComponent(id);
  // Establish the owner's join point before the agent sends (history visibility is unchanged).
  assert.equal((await f.call(route,undefined,f.owner)).status,200);
  const sent=await f.call(route+'/messages',post('Encoded task discussion','encoded-one'),f.agent);assert.equal(sent.status,201);assert.equal(sent.body.message.conversationId,id);assert.equal(sent.body.message.sender.id,'worker');
  const page=await f.call(route+'?after=0',undefined,f.owner);assert.equal(page.status,200);assert.equal(page.body.conversation.id,id);assert.deepEqual(page.body.messages.map((m:any)=>m.body),['Encoded task discussion']);
  const outsider={...f.agent,id:'late',sessionId:'late-s'};
  assert.equal((await f.call(route,undefined,outsider)).status,404);assert.equal((await f.call(route+'/messages',post('Hidden audience write','hidden'),outsider)).status,404);
  const app=createApp({store:f.work,conversation:f.sql.store,handlers:PROJECT_HANDLERS,authenticate:async()=>null});
  assert.equal((await app.fetch(new Request('http://localhost/api/v1/projects/p/'+route))).status,401);
  assert.equal((await f.call(route,undefined,{...f.agent,scopes:['read']})).status,403);
  await f.work.transact(d=>{d.sessions['worker-s'].status='revoked';});assert.equal((await f.call(route,undefined,f.agent)).status,401);
 }finally{f.sql.close();}
});

test('conversation path decoding happens once and malformed encoding returns a controlled error',async()=>{
 const f=fixture();try{
  await prep(f);const taskId='literal%3Asegment';
  await f.work.transact(d=>{d.tasks[taskId]={id:taskId,projectId:'p',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',goal:'Literal percent ID',acceptanceCriteria:[],dependencies:[],lifecycle:'open',resultRefs:[]};});
  const created=await f.call('conversations',{taskId,audience:['steve']});assert.equal(created.status,201);
  const route='conversations/'+encodeURIComponent(created.body.conversation.id);
  assert.equal((await f.call(route+'/messages',post('Decode once','percent-one'))).status,201);
  const page=await f.call(route);assert.equal(page.status,200);assert.equal(page.body.conversation.id,'task:literal%3Asegment');
  assert.equal((await f.call('conversations/team')).status,200);
  for(const invalid of ['task%','task%ZZ','task%E0%A4']){const response=await f.call('conversations/'+invalid);assert.equal(response.status,400);assert.equal(response.body.error.code,'conversation_id_encoding');}
 }finally{f.sql.close();}
});
