import test from 'node:test';import assert from 'node:assert/strict';
import {createElement,act} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {createState} from '../lib/core.ts';import {Inspector,portraitFor} from '../src/ui/Inspector.tsx';
import {CrewWall} from '../src/ui/CrewInspector.tsx';import {createProjectController} from '../src/data/useProject.ts';
import {createLocalApi} from '../cloud/local-server.ts';
const time='2026-10-27T20:00:00Z',entity=(id:string)=>({id,projectId:'p',revision:1,createdAt:time,updatedAt:time,actorId:'owner'});

test('assignment summary includes scoped collaborator, exact candidate links, safe initials and complete recombination',async()=>{
 const s=createState({id:'p',goal:'First use',mode:'live',actorId:'owner',now:time});
 s.identities.a={...entity('a'),displayName:'Faye trial',ownerId:'owner',creationSource:'fixture',status:'active'};
 s.members.m={...entity('m'),identityId:'a',kind:'collaborator',scopes:['read']};
 s.tasks.t={...entity('t'),goal:'Implement the helper',acceptanceCriteria:['Pass fixed checks'],dependencies:[],lifecycle:'claimed',resultRefs:[],currentAssignmentId:'a1'};
 s.assignments.a1={...entity('a1'),taskId:'t',identityId:'a',sessionId:'s1',role:'owner',status:'active',epoch:1,leaseExpiresAt:'2026-10-28T20:00:00Z',maxUntil:'2026-10-28T21:00:00Z'} as any;
 s.proposals.p1={...entity('p1'),taskIds:['t'],authorId:'a',base:'a'.repeat(40),head:'b'.repeat(40),summary:'Helper',intendedBehavior:'Count',changedPaths:['summary.mjs'],evidenceRefs:[],unknowns:[],lifecycle:'submitted'};
 s.candidates.c={...entity('c'),base:'a'.repeat(40),sha:'c'.repeat(40),proposalIds:['p1'],proposalHeads:{p1:'b'.repeat(40)},policyVersion:1,status:'prepared',checkJobIds:[],reviewIds:[]};
 const actions:any[]=[];const controller:any={state:s,mode:'live',action:async(type:string,payload:any)=>{actions.push({type,payload});return{ok:true}}};
 const html=renderToStaticMarkup(createElement(Inspector,{controller,selection:null,onClose:()=>{},embedded:true}));
 assert.match(html,/Faye trial/);assert.match(html,/collaborator/);assert.match(html,/Implement the helper/);assert.match(html,/View prepared candidate/);assert.match(html,/Prepare another combined candidate/);assert.equal(s.members.m.kind,'collaborator');
 const svg=decodeURIComponent(portraitFor('random-uuid','Faye trial'));assert.match(svg,/>FT<\/text>/);assert.doesNotMatch(decodeURIComponent(portraitFor('uuid','<script> & bad')),/<script>/);
 s.proposals.p2={...s.proposals.p1,id:'p2',head:'d'.repeat(40)};
 const {JSDOM}=await import('jsdom'),{createRoot}=await import('react-dom/client');const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture'}),previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});const mounted=createRoot(document.getElementById('root')!);
 try{
  await act(async()=>mounted.render(createElement(Inspector,{controller,selection:null,onClose:()=>{},embedded:true})));
  const prepare=[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('Prepare another combined candidate'))!;
  assert.match(prepare.textContent??'',/2 contributions/);await act(async()=>prepare.click());assert.deepEqual(actions.at(-1),{type:'prepare-candidate',payload:{proposalIds:['p1','p2']}});
  s.candidates.c2={...s.candidates.c,id:'c2',proposalIds:['p2'],proposalHeads:{p2:'d'.repeat(40)}};
  const bothPrepared=renderToStaticMarkup(createElement(Inspector,{controller,selection:null,onClose:()=>{},embedded:true}));assert.match(bothPrepared,/2 contributions/);assert.equal((bothPrepared.match(/View prepared candidate/g)??[]).length,2);
 }finally{await act(async()=>mounted.unmount());Object.assign(globalThis,previous);dom.window.close();}
});

test('historical credit wall labels source attribution separately from current connection records',()=>{
 const html=renderToStaticMarkup(createElement(CrewWall,{profiles:[]}));assert.match(html,/Historical project credits/);assert.match(html,/not connected participants/);assert.match(html,/Current project connections/);assert.match(html,/No connection profiles/);assert.match(html,/Chad/);
});

test('work-event refresh notices an external write without calling conversation cursors or model endpoints',async()=>{
 const owner={ownerId:'owner',token:'OFFLINE-rc2-owner'},api=createLocalApi({ownerTokens:[owner],seedProjects:[{id:'p',goal:'Event fixture'}]});
 const paths:string[]=[];const fetcher=(input:string,init?:RequestInit)=>{paths.push(input);const r=new Request('http://fixture'+input,init);r.headers.set('authorization','Bearer '+owner.token);return api.fetch(r);};
 const controller=createProjectController({storage:null,fetcher});await controller.action('connect-live');assert.equal(controller.mode,'live');assert.equal(Object.keys(controller.state.tasks).length,0);
 const external=await fetcher('/api/v1/projects/p/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:'outside-ui',goal:'External task',acceptanceCriteria:['Visible without reload']})});assert.equal(external.status,201);
 const prior=paths.length;const result=await controller.pollEvents!();assert.ok(result.newEvents>0);assert.equal(Object.values(controller.state.tasks)[0].goal,'External task');
 assert.ok(paths.slice(prior).every(p=>!/conversation|nemo|runtime|inclusion|opened/.test(p)));
 assert.equal((await controller.pollEvents!()).newEvents,0);
});

test('work polling recovers after failed snapshot or transport with zero further events',async()=>{
 for (const failure of ['snapshot','events']) {
  const owner={ownerId:'owner',token:'OFFLINE-recovery'},api=createLocalApi({ownerTokens:[owner],seedProjects:[{id:'p'}]});let broken=false;
  const fetcher=(input:string,init?:RequestInit)=>{
   if(broken&&failure==='snapshot'&&input==='/api/v1/projects/p')return Promise.resolve(new Response(JSON.stringify({error:{code:'offline',message:'Fixture snapshot unavailable'}}),{status:503}));
   if(broken&&failure==='events'&&input.includes('/events?'))return Promise.reject(Error('OFFLINE event transport'));
   const r=new Request('http://fixture'+input,init);r.headers.set('authorization','Bearer '+owner.token);return api.fetch(r);
  };
  const controller=createProjectController({storage:null,fetcher});await controller.action('connect-live');
  if(failure==='snapshot')await fetcher('/api/v1/projects/p/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:'recovery-external',goal:'Recover this saved task',acceptanceCriteria:['Visible after recovery']})});
  broken=true;await controller.pollEvents!();assert.equal(controller.connectionUnavailable,true,failure);
  broken=false;const recovery=await controller.pollEvents!();assert.equal(recovery.newEvents,0);assert.equal(controller.connectionUnavailable,false,failure);assert.equal(controller.error,null);
  if(failure==='snapshot')assert.equal(Object.values(controller.state.tasks)[0].goal,'Recover this saved task');
 }
});
