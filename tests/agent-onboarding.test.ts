import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startDemo} from '../scripts/start-local.mts';
import {git,CHECK_COMMAND} from '../local/demo-workspace.ts';
import {createProjectController} from '../src/data/useProject.ts';
// JavaScript owner CLI is also the implementation exercised by npm run agent:setup.
// @ts-ignore JS CLI deliberately has no public TypeScript dependency.
import {setupAgent} from '../scripts/agent-setup.mjs';

const exec=promisify(execFile);
async function call(config:string,name:string,args:unknown={}){
 const {stdout}=await exec(process.execPath,[resolve('scripts/crew-mcp.mjs'),config,name,JSON.stringify(args)],{timeout:10000}).catch((error:any)=>{throw Error('MCP fixture call failed: '+String(error.stdout??error.message));});
 const envelope=JSON.parse(stdout);assert.equal(envelope.isError,undefined,stdout);
 return JSON.parse(envelope.content[0].text);
}
test('new install: free ports, scoped MCP first work, same identity after restart; no provider needed',async t=>{
 const stateDir=mkdtempSync(join(tmpdir(),'together-install-'));let app=await startDemo({port:0,apiPort:0,stateDir});
 t.after(async()=>{await app.close();rmSync(stateDir,{recursive:true,force:true});});
 const metadata=JSON.parse(readFileSync(join(stateDir,'app.lock'),'utf8'));assert.equal(metadata.apiOrigin,app.apiOrigin);assert.equal(metadata.origin,app.origin);
 const neighborState=mkdtempSync(join(tmpdir(),'together-install-neighbor-'));const neighbor=await startDemo({port:0,apiPort:0,stateDir:neighborState});
 try{assert.notEqual(neighbor.origin,app.origin);assert.notEqual(neighbor.apiOrigin,app.apiOrigin);assert.equal((await fetch(app.origin)).status,200);assert.equal((await fetch(neighbor.origin)).status,200);}finally{await neighbor.close();rmSync(neighborState,{recursive:true,force:true});}
 const connection=await setupAgent({name:'Install Agent',host:'claude',profile:'work',stateDir});
 assert.equal(statSync(connection.configPath).mode&0o777,0o600);
 const project=await call(connection.configPath,'together_project');assert.equal(project.ok,true);
 const post=await call(connection.configPath,'together_post_message',{channel:'team',body:'OFFLINE installation fixture: actual scoped MCP message.',clientRequestId:'install-first-hello'});assert.equal(post.result.message.sender.name,'Install Agent');
 const task=await call(connection.configPath,'together_create_task',{operationId:'install-create-task',goal:'Inspect a small change',acceptanceCriteria:['Explain what remains unchecked']});
 const claim=await call(connection.configPath,'together_claim_work',{operationId:'install-claim-task',expectedRevision:task.result.task.revision,taskId:task.result.task.id,role:'owner'});assert.equal(claim.result.assignment.identityId,connection.identityId);
 const configBefore=JSON.parse(readFileSync(connection.configPath,'utf8')),tokenBefore=readFileSync(configBefore.credentialFile,'utf8');
 await app.close();app=await startDemo({port:0,apiPort:0,stateDir});
 const reused=await setupAgent({name:'Install Agent',host:'claude',profile:'work',stateDir});assert.equal(reused.reused,true);assert.equal(reused.identityId,connection.identityId);assert.equal(reused.sessionId,connection.sessionId);assert.equal(readFileSync(configBefore.credentialFile,'utf8'),tokenBefore);
 const page=await call(reused.configPath,'together_read_messages',{channel:'team',limit:2});assert.equal(page.result.messages[0].body,post.result.message.body);
 const model=JSON.parse(readFileSync(join(stateDir,'nemo/nemo-private.json'),'utf8'));assert.equal(model.requests.length,0);assert.equal(model.runs.length,0);assert.equal(model.identity,undefined);
});

test('setup does not silently replace a denied existing connection',async t=>{
 const stateDir=mkdtempSync(join(tmpdir(),'together-install-denied-'));const app=await startDemo({port:0,apiPort:0,stateDir});t.after(async()=>{await app.close();rmSync(stateDir,{recursive:true,force:true});});
 const connection=await setupAgent({name:'Denied fixture',host:'other',profile:'chat',stateDir});const bytes=readFileSync(connection.configPath,'utf8'),config=JSON.parse(bytes);
 writeFileSync(config.credentialFile,'OFFLINE-invalidated-fixture-token\n',{mode:0o600});
 await assert.rejects(setupAgent({name:'Denied fixture',host:'other',profile:'chat',stateDir}),/not replaced/);assert.equal(readFileSync(connection.configPath,'utf8'),bytes);
});

test('failed preflight permits same-name retry; uncertain identity response remains blocked',async t=>{
 const stateDir=mkdtempSync(join(tmpdir(),'together-preflight-'));const app=await startDemo({port:0,apiPort:0,stateDir});t.after(async()=>{await app.close();rmSync(stateDir,{recursive:true,force:true});});
 const realFetch=globalThis.fetch;
 try{
  globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/conversations'))throw Error('OFFLINE first read unavailable');return realFetch(input,init);};
  await assert.rejects(setupAgent({name:'Retry first read',stateDir}),/OFFLINE first read/);
 }finally{globalThis.fetch=realFetch;}
 assert.equal(readdirSync(join(stateDir,'agents')).length,0,'preflight failure precedes any identity/pending effect');
 const retried=await setupAgent({name:'Retry first read',stateDir});assert.equal(retried.reused,false);
 const owner=readFileSync(join(stateDir,'owner-token'),'utf8').trim();
 const count=async()=>{const state=await realFetch(app.apiOrigin+'/api/v1/projects/local-demo',{headers:{authorization:'Bearer '+owner}}).then(r=>r.json());return Object.keys(state.identities).length;};
 assert.equal(await count(),2,'exactly owner plus one successfully enrolled identity');
 try{
  globalThis.fetch=async(input,init)=>{const response=await realFetch(input,init);if(String(input).endsWith('/identities')&&init?.method==='POST')throw Error('OFFLINE identity committed but response lost');return response;};
  await assert.rejects(setupAgent({name:'Uncertain identity',stateDir}),/response lost/);
 }finally{globalThis.fetch=realFetch;}
 assert.equal(await count(),3);
 await assert.rejects(setupAgent({name:'Uncertain identity',stateDir}),/interrupted/);
 assert.equal(await count(),3,'uncertain setup never creates a duplicate');
});

test('key-free first code: exact proposal, candidate, browser check action and author review stay separate',async t=>{
 const stateDir=mkdtempSync(join(tmpdir(),'together-install-code-'));const app=await startDemo({port:0,apiPort:0,stateDir});t.after(async()=>{await app.close();rmSync(stateDir,{recursive:true,force:true});});
 const connection=await setupAgent({name:'Offline code fixture',host:'other',profile:'work',stateDir});
 assert.equal(connection.workspaceDir,join(stateDir,'nemo-workspace'));
 const task=await call(connection.configPath,'together_create_task',{operationId:'code-task',goal:'Implement the frozen check-summary helper',acceptanceCriteria:['Frozen tests pass; exact diff and receipt visible']});
 await call(connection.configPath,'together_claim_work',{operationId:'code-claim',taskId:task.result.task.id,expectedRevision:task.result.task.revision,role:'owner'});
 const repo=connection.workspaceDir,base=git(repo,'rev-parse','main');
 // Deterministic offline builder fixture, never attributed to an inference run.
 writeFileSync(join(repo,'summary.mjs'),`export function summarizeChecks(records) {
 const rows=records??[];
 const passed=rows.filter(r=>r?.status==='passed').length;
 const failed=rows.filter(r=>r?.status==='failed').length;
 const total=rows.length,notChecked=total-passed-failed;
 return {status:failed?'failed':total&&passed===total?'passed':'not-checked',total,passed,failed,notChecked};
}\n`);
 git(repo,'add','--','summary.mjs');git(repo,'commit','-m','Offline first-use fixture');const head=git(repo,'rev-parse','HEAD');
 const submitted=await call(connection.configPath,'together_submit_change',{operationId:'code-submit',taskIds:[task.result.task.id],base,head,summary:'Implement the small summary helper',intendedBehavior:'Unknown checks remain unchecked; failure dominates',changedPaths:['summary.mjs'],unknowns:['Not independently reviewed or integrated']});assert.equal(submitted.ok,true,JSON.stringify(submitted));
 const prepared=await call(connection.configPath,'together_prepare_candidate',{operationId:'code-prepare',proposalIds:[submitted.result.proposal.id]});assert.equal(prepared.ok,true,JSON.stringify(prepared));
 const candidate=prepared.result.candidate;assert.match(candidate.diffPreview.text,/summarizeChecks/);
 const token=readFileSync(join(stateDir,'owner-token'),'utf8').trim();const controller=createProjectController({storage:null,fetcher:(input,init)=>{const request=new Request(app.apiOrigin+input,init);request.headers.set('authorization','Bearer '+token);return fetch(request);}});
 await controller.action('connect-live');assert.equal(controller.mode,'live');
 assert.equal(controller.state.project.defaultCheckCommand,CHECK_COMMAND);
 const requested=await controller.action('request-check',{candidateId:candidate.id}) as any;assert.equal(requested.ok,true,JSON.stringify(requested));
 let receipts:any;for(let attempt=0;attempt<30;attempt++){receipts=await call(connection.configPath,'together_results',{collection:'receipts'});if(receipts.result.records?.length)break;await new Promise(r=>setTimeout(r,20));}assert.equal(receipts.result.records.length,1);
 const checked=await call(connection.configPath,'together_candidate',{candidateId:candidate.id});assert.equal(checked.ok,true);
 const ownerState=await fetch(app.apiOrigin+'/api/v1/projects/local-demo',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());
 const evidence=Object.values(ownerState.receipts) as any[];assert.equal(evidence.length,1);assert.equal(evidence[0].outcome,'pass');assert.equal(evidence[0].candidateSha,candidate.sha);
 const checkOutput=JSON.parse(readFileSync(join(stateDir,'nemo/checks',requested.job.id,'result.json'),'utf8'));assert.match(checkOutput.output,/pass 10/);
 const review=await call(connection.configPath,'together_review_change',{operationId:'code-comment',candidateId:candidate.id,candidateSha:candidate.sha,expectedRevision:ownerState.candidates[candidate.id].revision,disposition:'comment',note:'Offline author fixture: passing checks still need independent review'});assert.equal(review.ok,true,JSON.stringify(review));assert.equal(review.result.review.independent,false);
 assert.equal(git(repo,'rev-parse','main'),base);
 const model=JSON.parse(readFileSync(join(stateDir,'nemo/nemo-private.json'),'utf8'));assert.equal(model.requests.length,0);assert.equal(model.runs.length,0);
});
