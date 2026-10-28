import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openConversationStore} from '../cloud/local-conversation.ts';
import {createApp} from '../cloud/app.ts';
import {PROJECT_HANDLERS} from '../cloud/handlers.ts';
import {createState,exportSnapshot} from '../lib/core.ts';
import {MemoryStore} from '../lib/store.ts';
import {TogetherClient} from '../adapters/client.ts';
import {handleRpc} from '../adapters/mcp.ts';
import {restorePrivateBackup} from '../lib/private-backup.ts';
import type {Principal} from '../lib/types.ts';
const NOW='2026-10-05T06:00:00.000Z';
function fixture(file=':memory:'){
 let sql=openConversationStore(file);let n=0;
 const state=createState({id:'pilot',goal:'Directory usability fixture',mode:'sample',actorId:'steve',now:NOW});
 const principals:Record<string,Principal>={};
 for(const id of ['steve','fixture-alpha','fixture-beta']){
  const scopes=id==='steve'?['owner','admin','read']:['read','conversation:read','conversation:write','lounge:write'];
  const e={id,projectId:'pilot',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve'};
  state.identities[id]={...e,displayName:id,ownerId:'steve',creationSource:'fixture',status:'active'};
  state.members[id]={...e,identityId:id,kind:'core',scopes};
  state.sessions[id+'-session']={...e,id:id+'-session',identityId:id,advertisedCapabilities:[],observedCapabilities:[],status:'active'};
  principals[id]={id,sessionId:id+'-session',ownerId:'steve',kind:id==='steve'?'human':'agent',projectIds:['pilot'],scopes};
 }
 const work=new MemoryStore(state);
 function client(id:string,transport?:(req:Request)=>Promise<Response>){return new TogetherClient({baseUrl:'http://fixture.local',token:id,projectId:'pilot',fetchFn:async(url,init)=>{
  const req=new Request(url,init);if(transport)return transport(req);return dispatch(req);
 }});}
 async function dispatch(req:Request){const id=req.headers.get('authorization')?.slice(7)??'';return createApp({store:work,conversation:sql.store,handlers:PROJECT_HANDLERS,authenticate:async()=>principals[id]??null,now:()=>NOW,uid:()=>`fixture-${++n}`}).fetch(req);}
 async function request(path:string,body?:any,id='steve'){const res=await dispatch(new Request('http://fixture.local/api/v1/projects/pilot/'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+id,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));return{status:res.status,body:await res.json() as any};}
 return{work,client,request,principals,dispatch,get sql(){return sql},restart(){sql.close();sql=openConversationStore(file)},close(){sql.close()}};
}
test('pilot: two explicitly synthetic participants exchange, interrupt, reopen SQLite and resume acknowledged cursor',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'together-pilot-'));const f=fixture(join(dir,'chat.sqlite'));
 try{
  await f.client('steve').conversations();
  const a=f.client('fixture-alpha'),b=f.client('fixture-beta');
  assert.equal((await a.postMessage('team','Destination is unclear; check project entry.','a1')).status,201);
  const read=await b.conversation('team');assert.equal((read.body.messages as any[]).length,1);
  await b.acknowledgeConversation('team',Number(read.body.nextCursor));
  await a.postMessage('team','Evidence: fixture path returns unavailable.','a2');
  f.restart();const reconnect=f.client('fixture-beta');const page=await reconnect.conversation('team');
  assert.deepEqual((page.body.messages as any[]).map(m=>m.clientRequestId),['a2']);
  // Unacknowledged delivery replays after reconnect instead of silently skipping.
  assert.equal((await f.client('fixture-beta').conversation('team')).body.nextCursor,2);
  assert.equal((await reconnect.acknowledgeConversation('team',999)).status,409);
  await reconnect.acknowledgeConversation('team',2);
  assert.equal((await reconnect.postMessage('team','Confirmed; next action is update directory label.','b1')).status,201);
 }finally{f.close();rmSync(dir,{recursive:true,force:true})}
});
test('pilot: lost response retry deduplicates and conflicting request content rejects',async()=>{
 const f=fixture();try{await f.client('steve').conversations();let first=true;
 const a=f.client('fixture-alpha',async req=>{const res=await f.dispatch(req);if(first){first=false;throw Error('fixture lost response')}return res});
 assert.equal((await a.postMessage('team','finding','stable-id')).status,0);
 assert.equal((await a.postMessage('team','finding','stable-id')).status,200);
 assert.equal((await a.postMessage('team','changed','stable-id')).status,409);
 assert.equal((await f.client('steve').conversation('team')).body.nextCursor,1);
 }finally{f.close()}
});
test('pilot: scoped MCP uses existing handlers; revoked, mismatched session and additional human denied',async()=>{
 const f=fixture();try{await f.client('steve').conversations();
 const call=async(name:string,args:any)=>handleRpc(f.client('fixture-alpha'),{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
 assert.equal((await call('together_post_message',{channel:'team',body:'fixture only',clientRequestId:'rpc1'}))?.result!==undefined,true);
 assert.equal((await f.client('fixture-beta').conversation('team')).status,200);
 f.principals['fixture-beta'].sessionId='fixture-alpha-session';assert.equal((await f.client('fixture-beta').conversation('team')).status,401);
 f.principals.visitor={...f.principals.steve,id:'visitor'};assert.equal((await f.client('visitor').conversations()).status,403);
 await f.work.transact(s=>{s.identities['fixture-alpha'].status='revoked'});
 assert.equal((await f.client('fixture-alpha').conversation('team')).status,401);
 assert.equal((await f.client('fixture-alpha').postMessage('team','no','revoked')).status,401);
 f.principals['fixture-beta'].sessionId='fixture-beta-session';f.principals['fixture-beta'].scopes=['read'];
 assert.equal((await f.client('fixture-beta').conversation('team')).status,403);
 }finally{f.close()}
});
test('pilot: brief adopts current plan, bounded prose and stale handoff guard',async()=>{
 const f=fixture();try{await f.client('steve').conversations();
 await f.work.transact(s=>{s.project.adoptedPlanRevisionId='new-plan';s.tasks.t={id:'t',projectId:'pilot',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'steve',goal:'x'.repeat(4000),acceptanceCriteria:['verify new destination'],dependencies:[],lifecycle:'claimed',resultRefs:[],currentAssignmentId:'a'};s.assignments.a={id:'a',projectId:'pilot',revision:1,createdAt:NOW,updatedAt:NOW,actorId:'fixture-alpha',taskId:'t',identityId:'fixture-alpha',sessionId:'fixture-alpha-session',epoch:1,status:'active',role:'owner',leaseExpiresAt:'2026-10-06T06:00:00.000Z',scopes:[]} as any;});
 const b=await f.client('fixture-alpha').contextBrief('t');assert.equal(b.status,200);assert.equal(b.body.planRevisionId,'new-plan');assert.ok(Buffer.byteLength(JSON.stringify(b.body))<=2048);assert.ok((b.body.omissions as string[]).some(x=>x.includes('Task prose')));
 const stale=await f.request('assignments/a/handoff',{operationId:'h1',expectedRevision:1,assignmentEpoch:1,planRevisionId:'old-plan',done:'inspected',next:'verify'},'fixture-alpha');assert.equal(stale.status,409);assert.equal(stale.body.error.code,'stale_plan');
 const current=await f.request('assignments/a/handoff',{operationId:'h2',expectedRevision:1,assignmentEpoch:1,planRevisionId:'new-plan',done:'inspected',next:'verify'},'fixture-alpha');assert.equal(current.status,201);assert.equal(current.body.handoff.planRevisionId,'new-plan');
 }finally{f.close()}
});
test('pilot: private canary absent from ordinary exports; owner backup restores exact messages and rejects overwrite/tampering',async()=>{
 const f=fixture(),restored=openConversationStore(':memory:');try{await f.client('steve').conversations();await f.client('steve').postMessage('team','PRIVATE_FIXTURE_CANARY','private1');
 assert.equal(JSON.stringify(exportSnapshot(await f.work.read())).includes('PRIVATE_FIXTURE_CANARY'),false);
 assert.equal((await f.request('private-backup',undefined,'fixture-alpha')).status,403);
 const backup=await f.request('private-backup');assert.equal(backup.status,200);
 const tamper=structuredClone(backup.body);tamper.rows.chat_messages[0].body='{}';await assert.rejects(()=>restorePrivateBackup(restored.store,tamper,'pilot'));
 await restorePrivateBackup(restored.store,backup.body,'pilot');
 assert.deepEqual(restored.store.privateRows().chat_messages,f.sql.store.privateRows().chat_messages);
 assert.deepEqual(restored.store.privateRows().chat_members,f.sql.store.privateRows().chat_members);
 await assert.rejects(()=>restorePrivateBackup(restored.store,backup.body,'pilot'));
 }finally{f.close();restored.close()}
});

test('pilot: stop fences posts while reads remain available; no start or cancellation is claimed',async()=>{
 const f=fixture();try{await f.client('steve').conversations();await f.work.transact(s=>{s.stopped=true});
 assert.equal((await f.client('fixture-alpha').postMessage('team','late','stop1')).status,409);
 assert.equal((await f.client('fixture-alpha').conversation('team')).status,200);
 assert.equal((await f.client('fixture-alpha').contextBrief()).body.stopped,true);
 }finally{f.close()}
});
test('pilot: explicit future page cannot advance durable cursor past an unread gap',async()=>{
 const f=fixture();try{await f.client('steve').conversations();for(let i=1;i<=4;i++)await f.client('steve').postMessage('team','message '+i,'gap'+i);
 const b=f.client('fixture-beta');await b.conversation('team',{after:2,limit:2});
 assert.equal((await b.acknowledgeConversation('team',4)).status,409);
 assert.equal(((await f.client('fixture-beta').conversation('team')).body.messages as any[])[0].seq,1);
 }finally{f.close()}
});
