import test from 'node:test';import assert from 'node:assert/strict';
import {overview,handleOverview} from '../lib/overview.ts';
import {createState} from '../lib/core.ts';import {MemoryStore} from '../lib/store.ts';import {openConversationStore} from '../cloud/local-conversation.ts';
const now='2026-10-05T08:00:00.000Z',old='2026-10-04T08:00:00.000Z';
function fixture(){const s=createState({id:'p',goal:'fixture',mode:'sample',actorId:'steve',now:old});const e={projectId:'p',revision:1,createdAt:old,updatedAt:old,actorId:'steve'};return{s,e};}
test('overview deduplicates hashes, requires receipt, explicit half-open range and unknown costs',()=>{
 const {s,e}=fixture();s.proposals.a={...e,id:'a',head:'a'.repeat(40)} as any;s.proposals.b={...s.proposals.a,id:'b'};s.tasks.t={...e,id:'t',goal:'Done',lifecycle:'done',resultRefs:[]} as any;
 let o=overview(s,now);assert.equal(o.metrics.distinctObservedCommits,1);assert.equal(o.completed.length,0);assert.equal(o.blocked.length,1);assert.equal(o.metrics.costUsd,null);
 s.receipts.r={...e,id:'r',outcome:'pass'} as any;s.tasks.t.resultRefs=['r'];o=overview(s,now);assert.equal(o.completed.length,1);assert.equal(o.completed[0].receiptId,'r');
 assert.equal(overview(s,now,old,old.replace('08:','09:')).completed.length,1);assert.equal(overview(s,now,undefined,old).completed.length,0);assert.throws(()=>overview(s,now,'invalid'));
});
test('overview exposes only concrete decision choices; blocked checks are technical blockers',()=>{
 const {s,e}=fixture();s.jobs.j={...e,id:'j',status:'blocked',command:'test'} as any;s.help.h={...e,id:'h',state:'offered',question:'Missing credential'} as any;
 const o=overview(s,now);assert.equal(o.decisions.length,0);assert.equal(o.blocked.length,2);
});
test('overview current membership revocation and connection setup owner boundary',async()=>{
 const {s,e}=fixture(),sql=openConversationStore(':memory:');s.identities.a={...e,id:'a',displayName:'Synthetic',ownerId:'steve',creationSource:'fixture',status:'revoked'};s.sessions.x={...e,id:'x',identityId:'a',status:'active',advertisedCapabilities:[],observedCapabilities:[]};s.members.m={...e,id:'m',identityId:'a',kind:'core',scopes:['read']};
 const ctx:any={store:new MemoryStore(s),conversation:sql.store,principal:{id:'a',ownerId:'steve',sessionId:'x',kind:'agent',scopes:['read'],projectIds:['p']},now:()=>now,uid:()=>''};
 try{await assert.rejects(()=>handleOverview(ctx,new Request('http://fixture/'),['overview']));await ctx.store.transact((d:any)=>{d.identities.a.status='active'});await assert.rejects(()=>handleOverview(ctx,new Request('http://fixture/'),['connection-setup']));}finally{sql.close()}
});
