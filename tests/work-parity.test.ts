import test from 'node:test';import assert from 'node:assert/strict';
import {createState} from '../lib/core.ts';import {MemoryStore} from '../lib/store.ts';import {authenticate,hashToken} from '../lib/identity.ts';import {createApp} from '../cloud/app.ts';import {PROJECT_HANDLERS} from '../cloud/handlers.ts';import {openConversationStore} from '../cloud/local-conversation.ts';import {TogetherClient} from '../adapters/client.ts';import {handleRpc} from '../adapters/mcp.ts';import {WORK_SCOPES,WORK_TOOL_NAMES} from '../adapters/work-tools.ts';import {BYO_TOOLS} from '../adapters/byo-config.ts';import {remoteMcpRequest,consentPrincipal} from '../cloud/remote-mcp.ts';import {chatApi} from '../src/ui/Conversation.tsx';import {WorkRecords} from '../src/ui/WorkRecords.tsx';import {renderToStaticMarkup} from 'react-dom/server';import {createElement} from 'react';
async function fixture(options:any={}){
 let now='2026-10-06T08:00:00.000Z',n=0;const s=createState({id:'p',goal:'Same work fixture',mode:'live',actorId:'steve',now}),e={projectId:'p',revision:1,createdAt:now,updatedAt:now,actorId:'steve'};
 for(const id of ['a','b']){s.identities[id]={...e,id,displayName:'Fixture '+id,ownerId:'steve',creationSource:'fixture',status:'active'};s.sessions[id+'s']={...e,id:id+'s',identityId:id,status:'active',harness:'synthetic test client',model:'no model called',advertisedCapabilities:[],observedCapabilities:[]};s.members[id]={...e,id,identityId:id,kind:'core',scopes:[...WORK_SCOPES]};s.credentials[id+'c']={...e,id:id+'c',identityId:id,sessionId:id+'s',tokenHash:await hashToken('fixture-'+id),scopes:[...WORK_SCOPES],projectIds:['p'],status:'active',expiresAt:'2026-10-06T09:00:00.000Z'};}
 const store=new MemoryStore(s),db=openConversationStore(':memory:');
 const app=createApp({...options,store,conversation:db.store,handlers:PROJECT_HANDLERS,attentionEnabled:true,now:()=>now,uid:()=>`id-${++n}`,authenticate:async r=>(await authenticate(r,await store.read(),{now:()=>now,ownerTokens:[{ownerId:'steve',token:'fixture-owner'}]}))??(options.collector?await options.collector(r,await store.read()):null)});
 const fetcher=async(input:any,init?:any)=>app.fetch(new Request(new URL(String(input),'http://fixture'),init));
 const clients=Object.fromEntries(['a','b'].map(id=>[id,new TogetherClient({baseUrl:'http://fixture',projectId:'p',token:'fixture-'+id,fetchFn:fetcher as any})]));
 async function human(path:string,body?:any){const r=await fetcher('/api/v1/projects/p/'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer fixture-owner','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,...await r.json() as any};}
 async function tool(id:string,name:string,args:any={}){const r:any=await handleRpc(clients[id],{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},[...BYO_TOOLS,...WORK_TOOL_NAMES]);if(r.error)return{rpcError:r.error};try{return JSON.parse(r.result.content[0].text)}catch{return{toolError:r.result.content[0].text}}}
 async function create(id='a',goal='Task'){return(await tool(id,'together_create_task',{operationId:'create-'+(++n),goal,acceptanceCriteria:['Required outcome']})).result.task;}
 return{store,db,clients,tool,human,create,e,now:()=>now,setTime:(t:string)=>now=t,fetcher};
}
test('A/D/F: human UI chat API ↔ MCP, retry loss, cursor reconnect, private audience and export separation',async()=>{
 const f=await fixture(),old=globalThis.fetch;
 try{
 globalThis.fetch=((input:any,init:any)=>f.fetcher(input,{...init,headers:{...init?.headers,authorization:'Bearer fixture-owner'}})) as any;
 await chatApi('p','conversations');await chatApi('p','conversations/team/messages',{body:'Human asks fixture A',clientRequestId:'human1'});
 let r=await f.tool('a','together_read_messages',{channel:'team'});assert.equal(r.result.messages[0].body,'Human asks fixture A');
 const post={channel:'team',body:'Synthetic A response',clientRequestId:'fixed-retry',replyToId:r.result.messages[0].id};
 await f.tool('a','together_post_message',post); // committed response deliberately discarded
 r=await f.tool('a','together_post_message',post);assert.equal(r.status,200);
 const ui=await chatApi('p','conversations/team?after=0&limit=30');assert.equal(ui.messages.length,2);assert.equal(ui.messages[1].sender.id,'a');assert.notEqual(ui.messages[1].sender.mode,'original');
 assert.equal((await f.tool('a','together_post_message',{...post,body:'changed'})).status,409);
 r=await f.tool('a','together_read_messages',{channel:'team'});await f.tool('a','together_opened',{channel:'team',seq:r.result.nextCursor});
 f.clients.a=new TogetherClient({baseUrl:'http://fixture',projectId:'p',token:'fixture-a',fetchFn:f.fetcher as any});assert.equal((await f.tool('a','together_read_messages',{channel:'team'})).result.messages.length,0);
 const t=await f.create();await f.human('conversations',{taskId:t.id,audience:['a']});assert.equal((await f.tool('b','together_read_messages',{channel:'task:'+t.id})).status,404);
 const snapshot=await f.human('');assert.ok(!JSON.stringify(snapshot).includes('Synthetic A response'));assert.deepEqual(snapshot.credentials,{});
 }finally{globalThis.fetch=old;f.db.close()}
});
test('Faye closure: human requirement changes notify holder and wrong-SHA review records nothing',async()=>{
 const f=await fixture();try{
  const task=await f.create();await f.tool('a','together_claim_work',{taskId:task.id,expectedRevision:1,operationId:'holder'});
  const changed=await f.human('tasks/'+task.id+'/update',{operationId:'owner-requirements',expectedRevision:2,goal:'Changed requirement'});
  assert.equal(changed.status,200);assert.match(changed.task.nextAction,/Owner changed requirements/);
  let state=await f.store.read();assert.ok(state.events.some(e=>e.type==='task:requirements-changed'&&(e.detail as any)?.holderIdentityId==='a'));
  await f.store.transact(s=>{s.candidates.c={...f.e,id:'c',base:'base',sha:'current-sha',proposalIds:[],proposalHeads:{},policyVersion:1,status:'prepared',checkJobIds:[],reviewIds:[]};});
  const rejected=await f.tool('b','together_review_change',{operationId:'wrong-sha',expectedRevision:1,candidateId:'c',candidateSha:'stale-sha',disposition:'approve',note:'Must not record'});
  assert.equal(rejected.status,409);assert.equal(rejected.error.code,'stale_candidate_sha');assert.equal(Object.keys((await f.store.read()).reviews).length,0);
 }finally{f.db.close()}
});
test('B: two identities claim separate work, progress, help, handoff, receipt completion and shared UI projection',async()=>{
 const f=await fixture();try{
 const ta=await f.create('a','Alpha'),tb=await f.create('b','Beta');
 const aa=(await f.tool('a','together_claim_work',{taskId:ta.id,expectedRevision:1,operationId:'claim-a'})).result.assignment;
 const ab=(await f.tool('b','together_claim_work',{taskId:tb.id,expectedRevision:1,operationId:'claim-b'})).result.assignment;
 let r=await f.tool('a','together_progress',{taskId:ta.id,assignmentId:aa.id,assignmentEpoch:aa.epoch,expectedRevision:2,operationId:'progress-a',summary:'Compared output',nextAction:'Ask for help',blocker:'Need review'});assert.equal(r.status,200);
 const help=(await f.tool('a','together_help_request',{taskId:ta.id,operationId:'ask',question:'Check result?',toId:'b'})).result.help;
 assert.equal((await f.tool('b','together_help_answer',{helpId:help.id,expectedRevision:1,operationId:'answer',answer:'Reviewed the fixture result'})).status,200);
 assert.equal((await f.tool('b','together_checkpoint',{assignmentId:ab.id,assignmentEpoch:ab.epoch,expectedRevision:1,operationId:'handoff-b',done:'Prepared Beta',next:'Review Beta',toId:'a'})).status,201);
 let state=await f.store.read();let html=renderToStaticMarkup(createElement(WorkRecords,{controller:{state,mode:'sample',activeProjectId:'p'} as any}));assert.match(html,/Need review/);assert.match(html,/Fixture a/);assert.match(html,/revision 3/);
 const complete={taskId:ta.id,assignmentId:aa.id,assignmentEpoch:aa.epoch,expectedRevision:3,operationId:'done-a',summary:'Outcome checked',receiptIds:['r']};assert.equal((await f.tool('a','together_complete_work',complete)).status,422);
 // Synthetic collector fixture only; production has no agent receipt-insert route.
 await f.store.transact(s=>{s.candidates.c={...f.e,id:'c',base:'base',sha:'sha',proposalIds:[],proposalHeads:{},policyVersion:1,status:'ready',checkJobIds:['j'],reviewIds:[]};s.jobs.j={...f.e,id:'j',candidateId:'c',candidateSha:'sha',command:'fixture-test',status:'completed',ownerAssignmentId:aa.id,ownerEpoch:aa.epoch};s.receipts.r={...f.e,id:'r',jobId:'j',candidateSha:'sha',collectorId:'synthetic-collector',command:'fixture-test',outcome:'pass',artifactRefs:['fixture-output-hash']};});
 r=await f.tool('a','together_complete_work',complete);assert.equal(r.status,200);assert.equal(r.result.task.lifecycle,'done');assert.equal((await f.tool('a','together_complete_work',complete)).status,200);
 state=await f.store.read();html=renderToStaticMarkup(createElement(WorkRecords,{controller:{state,mode:'sample',activeProjectId:'p'} as any}));assert.match(html,/done-a/);assert.equal(state.assignments[aa.id].status,'completed');assert.equal(state.candidates.c.status,'ready');
 assert.equal((await f.tool('a','together_results',{collection:'receipts'})).result.records[0].id,'r');
 }finally{f.db.close()}
});
test('C: UI adopts changed plan, MCP brief changes, stale handoff preserves proposed content and ownership',async()=>{
 const f=await fixture();try{
 let plan=(await f.human('plans',{operationId:'p1',tasks:[{key:'x',goal:'Original',acceptanceCriteria:['one']}]})).plan;
 await f.human('plans/'+plan.id+'/adopt',{operationId:'adopt1',expectedRevision:1});let s=await f.store.read(),t=Object.values(s.tasks)[0];
 const a=(await f.tool('a','together_claim_work',{operationId:'claim',taskId:t.id,expectedRevision:t.revision})).result.assignment;
 const before=await f.tool('a','together_context_brief',{taskId:t.id});assert.equal(before.result.planRevisionId,plan.id);
 const proposed=await f.tool('a','together_propose_plan',{operationId:'proposal',tasks:[{key:'x',goal:'Changed requirement',acceptanceCriteria:['two']}]});assert.equal(proposed.status,201);s=await f.store.read();await f.human('plans/'+proposed.result.plan.id+'/adopt',{operationId:'adopt2',expectedRevision:s.project.revision});
 const body={operationId:'stale-handoff',assignmentId:a.id,assignmentEpoch:a.epoch,expectedRevision:1,planRevisionId:plan.id,done:'Keep this exact work',next:'Review'};const rejected=await f.tool('a','together_checkpoint',body);assert.equal(rejected.status,409);assert.deepEqual(rejected.proposedContent,body);
 assert.equal((await f.tool('a','together_context_brief',{taskId:t.id})).result.planRevisionId,proposed.result.plan.id);
 assert.equal(Object.keys((await f.store.read()).handoffs).length,0);
 const bad=await f.clients.a.workRequest('POST','/plans/'+proposed.result.plan.id+'/adopt',{operationId:'agent-adopt',expectedRevision:3});assert.equal(bad.status,403);
 }finally{f.db.close()}
});
test('D: wrong project/session, revoked/expired credentials, missing scopes, immutable receipts and default profile',async()=>{
 const f=await fixture();try{
 const t=await f.create(),a=(await f.tool('a','together_claim_work',{taskId:t.id,expectedRevision:1,operationId:'claim'})).result.assignment;
 const body={taskId:t.id,assignmentId:a.id,assignmentEpoch:a.epoch,expectedRevision:2,operationId:'wrong-holder',summary:'wrong'};assert.equal((await f.tool('b','together_progress',body)).status,403);
 const narrow:any=await handleRpc(f.clients.a,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'together_progress',arguments:body}},BYO_TOOLS);assert.ok(narrow.error);
 const other=new TogetherClient({baseUrl:'http://fixture',projectId:'other',token:'fixture-a',fetchFn:f.fetcher as any});assert.equal((await other.workRequest('GET','/work-context')).status,404);
 await f.store.transact(s=>{delete s.members.a});assert.equal((await f.tool('a','together_create_task',{operationId:'removed-member',goal:'Denied',acceptanceCriteria:['x']})).status,401);await f.store.transact(s=>{s.members.a={...f.e,id:'a',identityId:'a',kind:'core',scopes:[...WORK_SCOPES]}});
 await f.store.transact(s=>{s.credentials.ac.scopes=['read']});assert.equal((await f.tool('a','together_progress',{...body,operationId:'denied'})).status,403);
 await f.store.transact(s=>{s.credentials.ac.scopes=[...WORK_SCOPES];s.sessions.as.identityId='b'});assert.equal((await f.tool('a','together_project')).status,401);
 await f.store.transact(s=>{s.sessions.as.identityId='a';s.credentials.ac.status='revoked'});assert.equal((await f.tool('a','together_project')).status,401);
 f.setTime('2026-10-06T10:00:00.000Z');assert.equal((await f.tool('b','together_project')).status,401);
 }finally{f.db.close()}
});
test('E: pull attention without activation, body-free arm routing, no agent wake loop, expiry',async()=>{
 const f=await fixture();try{
 await f.human('conversations');await f.human('conversations/team/messages',{body:'Private attention fixture',clientRequestId:'h',mentionIds:['a']});
 const pull=await f.tool('a','together_attention_list');assert.equal(pull.status,200);assert.equal(pull.result.wokeHost,false);assert.ok(!JSON.stringify(pull).includes('Private attention fixture'));
 const arm=(await f.human('attention/arm',{identityId:'a',sessionId:'as',mode:'stream',seconds:10})).arm;
 await f.human('conversations/team/messages',{body:'One',clientRequestId:'h2',mentionIds:['a']});await f.human('conversations/team/messages',{body:'Two',clientRequestId:'h3',mentionIds:['a']});await f.tool('b','together_post_message',{channel:'team',body:'No wake loop',clientRequestId:'bpost',mentionIds:['a']});
 const refs=await f.clients.a.attention(arm.id);assert.equal((refs.body.references as any[]).length,2);assert.ok(!JSON.stringify(refs.body).includes('One'));
 f.setTime('2026-10-06T08:00:11.000Z');assert.equal((await f.clients.a.attention(arm.id)).status,410);
 }finally{f.db.close()}
});
test('remote work profile shares SDK transport and explicit write revisions across fresh request clients',async()=>{
 const f=await fixture();try{
 const consent={workProfile:true,projectId:'p',credentialId:'ac',identityId:'a',sessionId:'as',ownerId:'steve',scopes:[...WORK_SCOPES],expiresAt:'2026-10-06T09:00:00.000Z'};
 const apiFetch=async(req:Request,c:any)=>createApp({store:f.store,conversation:f.db.store,handlers:PROJECT_HANDLERS,now:f.now,authenticate:async()=>consentPrincipal(await f.store.read(),c,f.now())}).fetch(req);
 async function remote(name:string,args:any={}){const response=await remoteMcpRequest(new Request('https://fixture.invalid/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),{origin:'https://fixture.invalid',consent,apiFetch});const r:any=await response.json();return JSON.parse(r.result.content[0].text);}
 const task=(await remote('together_create_task',{operationId:'remote-create',goal:'Remote task',acceptanceCriteria:['same store']})).result.task;assert.ok(task);
 assert.equal((await remote('together_claim_work',{operationId:'remote-claim',taskId:task.id,expectedRevision:1})).status,201);
 const state=await f.store.read();assert.equal(state.tasks[task.id].currentAssignmentId,Object.keys(state.assignments)[0]);
 await f.store.transact(s=>{s.credentials.ac.status='revoked'});assert.equal((await remote('together_project')).status,401);
 }finally{f.db.close()}
});

test('human rendered UI button sends into the same store an MCP reader sees',async()=>{
 const {JSDOM}=await import('jsdom'),{act}=await import('react'),{ConversationPanel}=await import('../src/ui/Conversation.tsx');const f=await fixture();
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture'}),old={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage,fetch:globalThis.fetch};
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,IS_REACT_ACT_ENVIRONMENT:true,fetch:(input:any,init:any)=>f.fetcher(input,{...init,headers:{...init?.headers,authorization:'Bearer fixture-owner'}})});const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 try{await f.human('conversations');const controller:any={mode:'live',activeProjectId:'p',state:await f.store.read(),action:async()=>{}};
 await act(async()=>root.render(createElement(ConversationPanel,{controller,channel:'team',title:'Team',active:false})));
 const preset=[...document.querySelectorAll('button')].find(x=>x.textContent?.startsWith('Here’s the brief'))!;await act(async()=>preset.click());await act(async()=>document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));
 assert.match(document.body.textContent??'',/Message as project owner/);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))});const read=await f.tool('a','together_read_messages',{channel:'team'});assert.equal(read.result.messages.length,1);assert.equal(read.result.messages[0].sender.name,'Project owner');assert.match(read.result.messages[0].body,/Here’s the brief/);
 await f.tool('a','together_post_message',{channel:'team',body:'Visible MCP response',clientRequestId:'ui-reply'});
 await act(async()=>root.render(createElement(ConversationPanel,{controller,channel:'team',title:'Team',active:true})));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))});assert.match(document.body.textContent??'',/Visible MCP response/);assert.match(document.body.textContent??'',/Agent · Fixture a/);
 }finally{await act(async()=>root.unmount());Object.assign(globalThis,old);dom.window.close();f.db.close();}
});
test('new tool validation, unauthorized receipt refs and cross-actor replay fail without mutation',async()=>{
 const f=await fixture();try{
 assert.ok((await f.tool('a','together_create_task',{operationId:'x',goal:'test',acceptanceCriteria:['x'],scopes:['admin']})).toolError);
 const args={operationId:'shared-op',goal:'test',acceptanceCriteria:['x']};assert.equal((await f.tool('a','together_create_task',args)).status,201);assert.equal((await f.tool('b','together_create_task',args)).status,403);assert.equal(Object.keys((await f.store.read()).tasks).length,1);
 assert.equal((await f.tool('a','together_report_finding',{operationId:'bad-ref',expected:'x',observed:'y',receiptIds:['foreign-private-ref']})).status,422);
 const finding=await f.tool('a','together_report_finding',{operationId:'good-finding',expected:'x',observed:'y',note:'unverified observation'});assert.equal(finding.status,201);assert.equal(finding.result.finding.state,'possible-issue');
 }finally{f.db.close()}
});

test('four needs: real disposable Git conflict → revised contribution → review decision → checked integration → handoff',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{execFileSync}=await import('node:child_process');const {LocalGitService}=await import('../adapters/local-git.ts');const {authenticateCollector}=await import('../lib/checks.ts');const {collaborationAnswers}=await import('../lib/dashboard.ts');const {CollaborationQuestions}=await import('../src/ui/CollaborationQuestions.tsx');
 const dir=mkdtempSync(join(tmpdir(),'together-four-needs-'));const git=(...args:string[])=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','Synthetic fixture');git('config','user.email','fixture@invalid');writeFileSync(join(dir,'result.js'),"console.log('base');\n");git('add','.');git('commit','-m','baseline');const base=git('rev-parse','HEAD');
 git('checkout','-b','alpha');writeFileSync(join(dir,'result.js'),"console.log('alpha');\n");git('commit','-am','alpha contribution');const headA=git('rev-parse','HEAD');
 git('checkout','-b','beta',base);writeFileSync(join(dir,'result.js'),"console.log('beta');\n");git('commit','-am','beta contribution');const headB=git('rev-parse','HEAD');
 const service=new LocalGitService({repo:dir});let dispatch:any;const f=await fixture({git:service,runner:{dispatch:async(input:any)=>{dispatch=input;return{accepted:true}},cancel:async()=>({accepted:true})},collector:authenticateCollector});
 try{
 const ta=await f.create('a','Retain alpha behavior'),tb=await f.create('b','Retain beta behavior');const aa=(await f.tool('a','together_claim_work',{taskId:ta.id,operationId:'claim-a',expectedRevision:1})).result.assignment;await f.tool('b','together_claim_work',{taskId:tb.id,operationId:'claim-b',expectedRevision:1});
 const submit=(id:string,taskId:string,head:string,operationId:string,extra:any={})=>f.tool(id,'together_submit_change',{operationId,taskIds:[taskId],base,head,summary:operationId,intendedBehavior:'Preserve '+id+' behavior',changedPaths:['result.js'],...extra});
 const [a,b]=await Promise.all([submit('a',ta.id,headA,'alpha-change'),submit('b',tb.id,headB,'beta-change')]);const pa=a.result.proposal,pb=b.result.proposal;
 const conflict=await f.tool('a','together_prepare_candidate',{operationId:'conflict',proposalIds:[pa.id,pb.id]});assert.equal(conflict.status,422);assert.equal(conflict.error.code,'merge_conflict');assert.equal(git('rev-parse','main'),base);
 // Scripted resolution, explicitly NOT an independently observed agent disagreement.
 git('checkout','-b','resolution',headA);assert.throws(()=>git('merge','--no-ff',headB));writeFileSync(join(dir,'result.js'),"console.log('alpha beta');\n");git('add','result.js');git('commit','-m','resolve: retain both requested behaviors');const resolved=git('rev-parse','HEAD');
 const replacement=(await submit('b',tb.id,resolved,'resolved-change',{supersedes:pb.id,intendedBehavior:'Keep alpha and beta together, without overwriting either'})).result.proposal;
 await f.tool('b','together_author_report',{operationId:'reason',proposalId:replacement.id,claims:'Resolved the conflicting line by retaining both behaviors',artifactRefs:['git:'+resolved]});
 const combined=await f.tool('a','together_prepare_candidate',{operationId:'resolved-candidate',proposalIds:[pa.id,replacement.id]});assert.equal(combined.status,201);const c=combined.result.candidate;assert.match(c.diffPreview.text,/alpha beta/);
 let review=await f.tool('a','together_review_change',{operationId:'self-review',expectedRevision:c.revision,candidateId:c.id,candidateSha:c.sha,disposition:'comment',note:'Please verify both behaviors'});assert.equal(review.status,201);
 let state=await f.store.read();await f.human('candidates/'+c.id+'/reviews',{operationId:'human-request-changes',expectedRevision:state.candidates[c.id].revision,candidateSha:c.sha,disposition:'request-changes',note:'Show an execution check before acceptance'});
 state=await f.store.read();assert.equal(collaborationAnswers(state,f.now()).reviews[0].outcome.state,'changes requested');
 const check=await f.human('candidates/'+c.id+'/checks',{operationId:'check',expectedRevision:state.candidates[c.id].revision,command:'node result.js; assert alpha beta',assignmentId:aa.id,assignmentEpoch:aa.epoch});assert.equal(check.status,201);assert.ok(dispatch.collectorToken);
 // Real command executed against the pinned candidate in a disposable worktree.
 const checkdir=join(dir,'verification');git('worktree','add','--detach',checkdir,c.sha);const output=execFileSync(process.execPath,['result.js'],{cwd:checkdir,encoding:'utf8'}).trim();assert.equal(output,'alpha beta');git('worktree','remove',checkdir);
 const response=await f.fetcher('/api/v1/projects/p/collector/jobs/'+check.job.id+'/complete',{method:'POST',headers:{authorization:'Bearer '+dispatch.collectorToken,'content-type':'application/json'},body:JSON.stringify({operationId:'collector-result',outcome:'pass',candidateSha:c.sha,command:dispatch.command,artifactRefs:['fixture-execution:node-result.js:alpha-beta']})});assert.equal(response.status,201);const collected:any=await response.json();
 state=await f.store.read();await f.human('candidates/'+c.id+'/reviews',{operationId:'human-accept',expectedRevision:state.candidates[c.id].revision,candidateSha:c.sha,disposition:'approve',note:'Observed alpha beta on the exact candidate; prior request is resolved'});
 state=await f.store.read();assert.equal(collaborationAnswers(state,f.now()).reviews[0].readiness.ready,true);
 const result=await f.human('candidates/'+c.id+'/integrate',{operationId:'integrate',expectedRevision:state.candidates[c.id].revision,expectedTip:base});assert.equal(result.effect,'confirmed');assert.equal(git('rev-parse','main'),c.sha);
 state=await f.store.read();const handoff=await f.tool('a','together_checkpoint',{operationId:'final-handoff',assignmentId:aa.id,assignmentEpoch:aa.epoch,expectedRevision:state.assignments[aa.id].revision,done:'Both contributions integrated after real Git conflict resolution and review',next:'Continue from '+c.sha,verifyFirst:'Run node result.js on pinned source',toId:'b'});assert.equal(handoff.status,201);
 state=await f.store.read();const answers=collaborationAnswers(state,f.now());assert.equal(answers.conflicts[0].resolution,'Replacement integrated');assert.ok(answers.why.some(w=>w.reports.some(r=>r.claims.includes('both behaviors'))));assert.ok(answers.why.some(w=>w.handoffs.length));
 const html=renderToStaticMarkup(createElement(CollaborationQuestions,{controller:{state,mode:'sample',activeProjectId:'p'} as any}));for(const text of ['Who’s working on what?','What happens when changes conflict?','How are changes reviewed?','Why was this change made?','Replacement integrated','both behaviors','prior request is resolved','Final'])if(text!=='Final')assert.ok(html.includes(text),text);assert.match(html,/kind=proposal/);assert.match(html,/kind=candidate/);
 if(process.env.TOGETHER_FIXTURE_EVIDENCE){
  const {mkdirSync,readFileSync}=await import('node:fs');const {safeSnapshot}=await import('../lib/core.ts');const out=process.env.TOGETHER_FIXTURE_EVIDENCE;mkdirSync(out,{recursive:true});
  const safe=safeSnapshot(state,{id:'steve',sessionId:'owner:steve',kind:'human',ownerId:'steve',projectIds:['p'],scopes:['owner','admin','read']});
  writeFileSync(join(out,'populated-state.json'),JSON.stringify({classification:'scripted-identities-real-local-git',state:safe},null,2));
  writeFileSync(join(out,'dashboard.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Together populated fixture</title><style>body{margin:1rem;font-family:system-ui;background:#f7f7ee;color:#203e30}'+readFileSync(new URL('../src/ui/collaboration-questions.css',import.meta.url),'utf8')+'</style></head><body><p>Static rendering of the actual dashboard component after the MCP/Git fixture. Links point to the running Together application; interactions are tested separately. No original hosts or Cloudflare account used.</p>'+html+'</body></html>');
  writeFileSync(join(out,'git-journey.json'),JSON.stringify({classification:'scripted identities; real Git and Node command',base,headA,headB,resolved,candidateSha:c.sha,conflictOperationId:'conflict',integrationOperationId:'integrate',canonicalReadback:git('rev-parse','main'),output,observedDisagreement:'scripted fixture, not actual agent disagreement',cloudflareLive:false},null,2));
 }

 }finally{f.db.close();await service.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('work editing, release and completion require current ownership/revision/evidence lineage',async()=>{
 const f=await fixture();try{
 const t=await f.create();assert.equal((await f.tool('a','together_update_task',{operationId:'edit',taskId:t.id,expectedRevision:1,goal:'Updated goal'})).status,200);
 assert.equal((await f.tool('a','together_update_task',{operationId:'stale-edit',taskId:t.id,expectedRevision:1,goal:'Stale goal'})).status,409);
 const a=(await f.tool('a','together_claim_work',{operationId:'claim-edited',taskId:t.id,expectedRevision:2})).result.assignment;
 assert.equal((await f.tool('b','together_update_task',{operationId:'edit-other',taskId:t.id,expectedRevision:3,goal:'Override other'})).status,403);
 assert.equal((await f.tool('a','together_release_work',{operationId:'bad-epoch',assignmentId:a.id,assignmentEpoch:a.epoch+1,expectedRevision:1})).status,409);
 assert.equal((await f.tool('a','together_release_work',{operationId:'release',assignmentId:a.id,assignmentEpoch:a.epoch,expectedRevision:1})).status,200);
 const s=await f.store.read();assert.equal(s.tasks[t.id].lifecycle,'open');assert.equal(s.assignments[a.id].status,'released');
 assert.equal((await f.tool('b','together_claim_work',{operationId:'next-claim',taskId:t.id,expectedRevision:s.tasks[t.id].revision})).status,201);
 assert.equal((await f.tool('a','together_assignments',{taskId:t.id})).result.assignments.length,2);
 }finally{f.db.close()}
});
test('a later request-changes blocks earlier approval until the reviewer resolves it; comments do not silently clear it',async()=>{
 const {reviewOutcome}=await import('../lib/review-outcome.ts');const f=await fixture();try{
 await f.store.transact(s=>{for(const [id,disposition] of [['r1','approve'],['r2','request-changes'],['r3','comment']] as const)s.reviews[id]={...f.e,id,candidateId:'c',candidateSha:'a'.repeat(40),reviewerId:'steve',policyVersion:1,disposition,independent:true,independenceReason:'fixture',findingIds:[]};});
 assert.equal(reviewOutcome(await f.store.read(),'a'.repeat(40)).state,'changes requested');
 await f.store.transact(s=>{s.reviews.r4={...s.reviews.r1,id:'r4',note:'Addressed with evidence'};});assert.equal(reviewOutcome(await f.store.read(),'a'.repeat(40)).state,'accepted for integration review');
 }finally{f.db.close()}
});
