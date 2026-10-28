// Targeted closure regressions for controller changes after the ten sealed lanes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLocalApi } from '../cloud/local-server.ts';
import { JsonFileStore } from '../cloud/local-store.ts';
import { createState, command, digestOf } from '../lib/core.ts';
import { MemoryStore } from '../lib/store.ts';
import { exportProject, handleEvents } from '../lib/events.ts';
import { createProjectController } from '../src/data/useProject.ts';
import { handleChecks } from '../lib/checks.ts';
import { handleIntegration } from '../lib/integration.ts';
import { handleChanges } from '../lib/changes.ts';
import { applyReceiptOutcome } from '../lib/findings.ts';
import { materializeGitSnapshot } from '../runner/git-snapshot.ts';
import { createLocalWorkspaceAdapter } from '../adapters/local-workspace.ts';
import type { Context, EvidenceReceipt } from '../lib/types.ts';
const t='2026-10-04T13:00:00.000Z';
const owner={ownerId:'test-owner',token:'fixture-local-owner'};
const post=(path:string,body:unknown)=>new Request('http://localhost/api/v1'+path,{method:'POST',headers:{authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify(body)});
test('allowed private HTTPS sessions use Secure cookies through the loopback proxy',async()=>{
 const origin='https://private-preview.example';
 const api=createLocalApi({ownerTokens:[owner],allowedOrigins:[origin]});
 const request=post('/session',{});request.headers.set('origin',origin);
 const login=await api.fetch(request);assert.equal(login.status,201);
 const cookie=login.headers.get('set-cookie')!;assert.match(cookie,/; Secure(?:;|$)/);
 const end=await api.fetch(new Request('http://localhost/api/v1/session',{method:'DELETE',headers:{origin,cookie:cookie.split(';')[0]}}));
 assert.equal(end.status,200);assert.match(end.headers.get('set-cookie')!,/Max-Age=0; Secure/);
 assert.equal((await api.fetch(new Request('http://localhost/api/v1/session',{headers:{cookie:cookie.split(';')[0]}}))).status,401);
 const local=await api.fetch(post('/session',{}));assert.doesNotMatch(local.headers.get('set-cookie')!,/; Secure/);
 const foreign=post('/session',{});foreign.headers.set('origin','https://foreign.example');
 assert.equal((await api.fetch(foreign)).status,403);
});
function context() {
 let seq=0;
 const state=createState({id:'p',goal:'bounded fixture',mode:'live',now:t});
 const store=new MemoryStore(state);
 const ctx:Context={store,principal:{id:'test-owner',sessionId:'fixture-session',ownerId:'test-owner',kind:'human',scopes:['admin','read'],projectIds:['p']},now:()=>t,uid:()=>`id-${++seq}`};
 return {state,store,ctx};
}
test('project creation is serialized, idempotent after restart, and conflicts by payload',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'together-bootstrap-'));
 try {
  const make=()=>createLocalApi({ownerTokens:[owner],seedProjects:[{id:'p'}],stateDir:dir});
  let api=make();
  const body={operationId:'bootstrap-once',expectedRevision:1,goal:'new owned project'};
  const responses=await Promise.all([api.fetch(post('/projects',body)),api.fetch(post('/projects',body))]);
  assert.deepEqual(responses.map(r=>r.status),[201,201]);
  const first=await responses[0].json();assert.deepEqual(await responses[1].json(),first);
  assert.equal(api.projectIds().length,2);
  api=make();assert.deepEqual(await (await api.fetch(post('/projects',body))).json(),first);
  assert.equal((await api.fetch(post('/projects',{...body,goal:'another goal'}))).status,409);
  assert.equal((await api.fetch(post('/projects',{...body,operationId:'wrong-rev',expectedRevision:2}))).status,409);
  assert.equal((await api.fetch(post('/projects',{...body,operationId:'bad-rev',expectedRevision:'1'}))).status,422);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('failed local persistence rolls back memory and restart reads prior commit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'together-store-')),file=join(dir,'state.json');
 try {
  let seeds=0;const store=new JsonFileStore(file,()=>{seeds++;return createState({id:'p',goal:'before',mode:'live'});});
  assert.equal(seeds,1);
  mkdirSync(file+'.tmp');
  await assert.rejects(store.transact(s=>{s.project.goal='not durable';return true;}));
  assert.equal((await store.read()).project.goal,'before');
  assert.equal((await new JsonFileStore(file,()=>{throw Error('must not seed');}).read()).project.goal,'before');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('exact SHA snapshot ignores dirty working tree; local fork exposes no cloud capability',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'together-git-')),repo=join(dir,'repo');mkdirSync(repo);
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  git('init','--template=','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(repo,'value.txt'),'committed');git('add','.');git('commit','-m','base');const sha=git('rev-parse','HEAD');
  writeFileSync(join(repo,'value.txt'),'dirty');
  const snap=materializeGitSnapshot(repo,sha);
  assert.equal(readFileSync(join(snap.dir,'value.txt'),'utf8'),'committed');snap.cleanup();assert.equal(existsSync(snap.dir),false);
  assert.throws(()=>materializeGitSnapshot(repo,'HEAD'));
  const adapter=createLocalWorkspaceAdapter(repo,join(dir,'workspaces'));
  const fork=await adapter.fork!('local','assignment-owned') as {token:unknown;repo:{remote:string;access:string}};
  assert.equal(fork.token,null);assert.equal(fork.repo.access,'local-filesystem');
  assert.match(fork.repo.remote,/^file:/);
  await assert.rejects(adapter.fork!('other-repo','assignment-owned'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('live export restore preserves current receipt anchors and collector authentication',async()=>{
 const {store,ctx}=context();
 await store.transact(s=>{
  s.jobs.j={id:'j',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'system',candidateId:'c',candidateSha:'a'.repeat(40),command:'check',status:'completed',deadlineAt:t,collectorTokenHash:'private-hash'};
  s.receipts.r={id:'r',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'collector:j',collectorId:'collector:j',jobId:'j',candidateSha:'a'.repeat(40),command:'check',outcome:'fail',artifactRefs:[]};
  s.findings.f={id:'f',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'collector:j',expected:'good',observed:'bad',state:'reproduced',originatorId:'author',receiptIds:['r']};
  return true;
 });
 const document=exportProject(await store.read());assert.equal(JSON.stringify(document).includes('private-hash'),false);
 const response=await handleEvents(ctx,new Request('http://localhost',{method:'POST'}),['restore'],{operationId:'restore-current',expectedRevision:1,document});
 assert.equal(response!.status,200);
 const restored=await store.read();assert.equal(restored.receipts.r.importedUnverified,undefined);assert.equal(restored.findings.f.state,'reproduced');
 assert.equal(restored.jobs.j.collectorTokenHash,'private-hash');
});
test('an imported failed receipt cannot make a later passing check verified-fixed',()=>{
 const {state,ctx}=context();
 state.findings.f={id:'f',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'author',expected:'good',observed:'bad',state:'possible-issue',originatorId:'author',receiptIds:['old']};
 const common={projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'collector',collectorId:'collector',command:'same check',artifactRefs:[]};
 state.receipts.old={...common,id:'old',jobId:'old-job',candidateSha:'a'.repeat(40),outcome:'fail',importedUnverified:true};
 const pass:EvidenceReceipt={...common,id:'new',jobId:'new-job',candidateSha:'b'.repeat(40),outcome:'pass'};
 applyReceiptOutcome(state,ctx,{jobId:'new-job',findingId:'f',receipt:pass});
 assert.equal(state.findings.f.state,'possible-issue');
});
test('imported operation cannot be replayed into current authority',async()=>{
 const {store,ctx}=context();const body={operationId:'old-write'};
 const target={collection:'tasks'} as const;
 const digest=await digestOf({scope:'tasks:write',target,body});
 await store.transact(s=>{s.operations['old-write']={id:'old-write',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'author',scope:'tasks:write',target,digest,intent:'tasks:write',effect:'confirmed',importedUnverified:true,result:{status:201,body:{task:{id:'fake'}}}};return true;});
 await assert.rejects(command(ctx,body,'tasks:write',target,()=>{throw Error('must not apply');}),(e:{code:string})=>e.code==='imported_operation');
});

test('author report stays separate from independent receipts and refuses another author',async()=>{
 const {store,ctx}=context();
 await store.transact(s=>{s.proposals.p={id:'p',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'test-owner',authorId:'test-owner',taskIds:[],base:'a'.repeat(40),head:'b'.repeat(40),summary:'fixture',intendedBehavior:'fixture',changedPaths:[],evidenceRefs:[],unknowns:[],lifecycle:'submitted'};return true;});
 const body={operationId:'report',expectedRevision:1,claims:'Author observed the change',artifactRefs:[]};
 const r=await handleChanges(ctx,new Request('http://localhost',{method:'POST'}),['changes','p','reports'],body);assert.equal(r!.status,201);
 assert.equal((await r!.json()).provenance,'author-claimed');
 assert.equal(Object.keys((await store.read()).receipts).length,0);
 const foreign={...ctx,principal:{...ctx.principal,id:'another-author'}};
 await assert.rejects(handleChanges(foreign,new Request('http://localhost',{method:'POST'}),['changes','p','reports'],{...body,operationId:'foreign'}),(e:{code:string})=>e.code==='author_required');
});

test('checks after landing preserve terminal integrated and superseded history',async()=>{
 for (const status of ['integrated','superseded'] as const) {
  const {store,ctx}=context();
  await store.transact(s=>{s.candidates.c={id:'c',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'system',sha:'b'.repeat(40),base:'a'.repeat(40),proposalIds:[],proposalHeads:{},policyVersion:1,status,checkJobIds:[],reviewIds:[]};return true;});
  const runner={dispatch:async()=>({accepted:false,reason:'fixture-blocked'}),cancel:async()=>({accepted:true})};
  const r=await handleChecks({...ctx,runner},new Request('http://localhost',{method:'POST'}),['candidates','c','checks'],{operationId:'post-landing-check',expectedRevision:1,command:'echo test'});
  assert.equal(r!.status,201);assert.equal((await store.read()).candidates.c.status,status);
 }
});
test('confirmed integration replay repairs old check-reset projection without another Git effect',async()=>{
 const {store,ctx}=context();const body={operationId:'landed',expectedTip:'a'.repeat(40)},target={collection:'candidates',id:'c'} as const;
 const digest=await digestOf({scope:'integrate',target,body});
 await store.transact(s=>{s.candidates.c={id:'c',projectId:'p',revision:3,createdAt:t,updatedAt:t,actorId:'system',sha:'b'.repeat(40),base:'a'.repeat(40),proposalIds:[],proposalHeads:{},policyVersion:1,status:'prepared',checkJobIds:[],reviewIds:[]};s.operations.landed={id:'landed',projectId:'p',revision:1,createdAt:t,updatedAt:t,actorId:'test-owner',scope:'integrate',target,digest,intent:'integrate',effect:'confirmed',candidateId:'c',candidateTip:'b'.repeat(40),pushAttempts:1,result:{status:200,body:{effect:'confirmed'}}};return true;});
 const r=await handleIntegration({...ctx,git:{} as never},new Request('http://localhost',{method:'POST'}),['candidates','c','integrate'],body);
 assert.equal(r!.status,200);const after=await store.read();assert.equal(after.candidates.c.status,'integrated');assert.equal(after.operations.landed.pushAttempts,1);
});

test('live browser project creation adopts the new API record and updates the picker',async()=>{
 const api=createLocalApi({ownerTokens:[owner],seedProjects:[{id:'p'}]});
 const controller=createProjectController({storage:null,fetcher:(input,init)=>{const request=new Request('http://localhost'+input,init);request.headers.set('authorization',`Bearer ${owner.token}`);return api.fetch(request);}});
 await controller.action('connect-live');assert.equal(controller.mode,'live');
 const result=await controller.action('create-project',{goal:'new browser project'}) as {ok:boolean;projectId:string};
 assert.equal(result.ok,true);assert.equal(controller.activeProjectId,result.projectId);assert.equal(controller.state.project.goal,'new browser project');
 assert.equal(controller.projects.filter(p=>p.project.mode==='live').length,2);
});
