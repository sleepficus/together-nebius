import test from 'node:test';import assert from 'node:assert/strict';
import {createElement,act} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {createState} from '../lib/core.ts';import {claimState,MemberClaims,presencePill,taskDisplayPill,Inspector} from '../src/ui/Inspector.tsx';
import {NemoPanel} from '../src/ui/NemoPanel.tsx';
const now=Date.parse('2026-10-27T22:00:00Z');
function fixture(){const state=createState({id:'p',goal:'Owned lease view fixture',mode:'live',actorId:'owner'});const base={projectId:'p',revision:1,createdAt:new Date(now-100000).toISOString(),updatedAt:new Date(now-100000).toISOString(),actorId:'owner'};
 state.identities.agent={...base,id:'agent',displayName:'Trial worker',ownerId:'owner',creationSource:'fixture',status:'active'};state.members.member={...base,id:'member',identityId:'agent',kind:'collaborator',scopes:['read']};
 for(const [id,expires]of [['old',now-60000],['new',now+60000],['parallel',now+120000]] as const){state.tasks[id]={...base,id,goal:id==='old'?'Expired earlier task':id==='new'?'Valid current task':'Another live task',acceptanceCriteria:['View only'],dependencies:[],lifecycle:'claimed',resultRefs:[],currentAssignmentId:'a-'+id};state.assignments['a-'+id]={...base,id:'a-'+id,taskId:id,identityId:'agent',sessionId:'s',role:'owner',scopes:['read'],epoch:1,leaseExpiresAt:new Date(expires).toISOString(),maxUntil:new Date(now+86400000).toISOString(),status:'active'};}
 return state;}

test('expired earlier active record cannot hide two later valid claims; rendering never mutates state',()=>{
 const state=fixture(),before=JSON.stringify(state);const html=renderToStaticMarkup(createElement(MemberClaims,{state,mode:'live',identityId:'agent',now}));
 assert.match(html,/Current claims/);assert.match(html,/Valid current task/);assert.match(html,/Another live task/);assert.match(html,/Expired earlier task/);assert.match(html,/Expired \/ prior claim history/);assert.match(html,/Lease expired/);assert.equal((html.match(/>Assigned</g)??[]).length,2);assert.equal(JSON.stringify(state),before);
 const later=renderToStaticMarkup(createElement(MemberClaims,{state,mode:'live',identityId:'agent',now:now+3600000}));assert.match(later,/No current claim/);assert.doesNotMatch(later,/>Assigned</);assert.equal((later.match(/Lease expired/g)??[]).length,3);assert.equal(JSON.stringify(state),before);
});

test('same-task pointer, unknown lease and fresh heartbeat do not manufacture a current claim',()=>{
 const state=fixture(),old=state.assignments['a-old'];state.sessions.s={id:'s',projectId:'p',revision:1,createdAt:'x',updatedAt:'x',actorId:'agent',identityId:'agent',status:'active',advertisedCapabilities:[],observedCapabilities:[],lastActivityAt:new Date(now).toISOString(),lastActivitySource:'heartbeat'};
 assert.equal(claimState(state,'live',old,now),'expired');assert.match(renderToStaticMarkup(createElement('div',null,presencePill(state,'live',old,now))),/Lease expired/);
 const future={...state.assignments['a-new'],id:'other'};assert.equal(claimState(state,'live',future,now),'prior');assert.equal(claimState(state,'live',{...old,leaseExpiresAt:'not-a-date'},now),'unknown');
});

test('task status display labels expiration without rewriting stored lifecycle',()=>{
 const state=fixture();const realNow=Date.now;Date.now=()=>now;try{assert.deepEqual(taskDisplayPill(state.tasks.old,state,'live'),['Lease expired','amber']);assert.equal(state.tasks.old.lifecycle,'claimed');const html=renderToStaticMarkup(createElement(Inspector,{controller:{state,mode:'live',action:async()=>({ok:true})} as any,selection:{kind:'task',id:'old'},onClose:()=>{},embedded:true}));assert.match(html,/Last claim/);assert.match(html,/Lease expired/);assert.match(html,/Recorded task lifecycle/);assert.doesNotMatch(html,/>Assigned</);}finally{Date.now=realNow;}
});

test('Nemo pre-click copy warns that the counter counts model calls; no action is launched',async()=>{
 const {JSDOM}=await import('jsdom'),{createRoot}=await import('react-dom/client');const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture'}),old={window:globalThis.window,document:globalThis.document,fetch:globalThis.fetch};let writes=0;
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true,fetch:async(_input:any,init:any)=>{if(init?.method==='POST')writes++;return new Response(JSON.stringify({available:true,configured:false,connected:false,budget:{calls:0,maxCalls:12,estimatedUsd:0,ceilingUsd:.05},runs:[],tasks:[]}),{headers:{'content-type':'application/json'}})}});
 const root=createRoot(document.getElementById('root')!);try{await act(async()=>{root.render(createElement(NemoPanel,{controller:{mode:'live',activeProjectId:'p',action:async()=>({ok:true})} as any}));await new Promise(r=>setTimeout(r,5));});const text=document.body.textContent??'';assert.match(text,/One reply can use multiple model requests/);assert.match(text,/counter counts model calls, not clicks or replies/);assert.ok(text.indexOf('One reply')<text.indexOf('Ask Nemotron to reply'));assert.equal(writes,0);}finally{await act(async()=>root.unmount());Object.assign(globalThis,old);dom.window.close();}
});

test('open claim view reevaluates at actual lease boundaries and cancels its pending timer on unmount',async()=>{
 const {JSDOM}=await import('jsdom'),{createRoot}=await import('react-dom/client'),{LeaseClock}=await import('../src/ui/lease-clock.tsx');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture'}),previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 const realSet=setTimeout,realClear=clearTimeout,scheduled:any[]=[],cleared:any[]=[];
 globalThis.setTimeout=((fn:any,ms:any,...args:any[])=>{const id=realSet(fn,ms,...args);if(ms>50000&&ms<70000)scheduled.push(id);return id;}) as typeof setTimeout;
 globalThis.clearTimeout=((id:any)=>{cleared.push(id);return realClear(id);}) as typeof clearTimeout;
 const root=createRoot(document.getElementById('root')!);const state=fixture(),at=Date.now();state.assignments['a-old'].leaseExpiresAt=new Date(at-1000).toISOString();state.assignments['a-new'].leaseExpiresAt=new Date(at+400).toISOString();state.assignments['a-parallel'].leaseExpiresAt=new Date(at+800).toISOString();
 const view=(s:any)=>createElement(LeaseClock,{state:s,mode:'live',children:createElement(MemberClaims,{state:s,mode:'live',identityId:'agent'})});
 try{
  await act(async()=>root.render(view(state)));assert.match(document.body.textContent??'',/Current claims/);
  await act(async()=>{await new Promise(r=>realSet(r,450));});let text=document.body.textContent??'';assert.match(text,/Current claims/);assert.equal((text.match(/Lease expired/g)??[]).length,2);
  await act(async()=>{await new Promise(r=>realSet(r,450));});text=document.body.textContent??'';assert.match(text,/No current claim/);assert.equal((text.match(/Lease expired/g)??[]).length,3);
  const later={...state,assignments:{...state.assignments,'a-new':{...state.assignments['a-new'],leaseExpiresAt:new Date(Date.now()+60000).toISOString()}}};await act(async()=>root.render(view(later)));assert.ok(scheduled.length>0);await act(async()=>root.unmount());assert.ok(cleared.includes(scheduled.at(-1)),'next-boundary timer must be cancelled on unmount');
 }finally{await act(async()=>root.unmount());globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;Object.assign(globalThis,previous);dom.window.close();}
});
