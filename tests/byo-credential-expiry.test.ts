import test from 'node:test';
import assert from 'node:assert/strict';
import {createState} from '../lib/core.ts';
import {MemoryStore} from '../lib/store.ts';
import {authenticate,handleIdentity,MAX_CREDENTIAL_TTL_MS} from '../lib/identity.ts';
import type {Context,Principal} from '../lib/types.ts';

function fixture() {
  let clock='2026-10-05T12:00:00.000Z',seq=0;
  const now=()=>clock,uid=()=>`expiry-fixture-${++seq}`;
  const store=new MemoryStore(createState({id:'expiry-fixture',goal:'Synthetic expiry verification',mode:'live',now:clock}));
  const principal:Principal={id:'fixture-owner',sessionId:'fixture-owner-session',kind:'human',ownerId:'fixture-owner',scopes:['owner','admin','read'],projectIds:['expiry-fixture']};
  const ctx:Context={principal,store,now,uid};
  const request=(token?:string)=>new Request('http://127.0.0.1/api/v1/projects/expiry-fixture',{method:'POST',headers:token?{authorization:`Bearer ${token}`}:{}});
  const call=async(c:Context,segments:string[],body:Record<string,unknown>)=>{
    const r=await handleIdentity(c,request(),segments,{operationId:uid(),...body});
    assert.ok(r);return await r.json() as any;
  };
  return {ctx,store,now,call,request,setClock:(s:string)=>{clock=s}};
}

test('issuer-selected one-hour credential expiry survives exchange and cannot be extended by recipient',async()=>{
  const f=fixture(),expiresAt='2026-10-05T13:00:00.000Z';
  const identity=(await f.call(f.ctx,['identities'],{displayName:'Synthetic bounded member'})).identity;
  const invite=await f.call(f.ctx,['identities',identity.id,'invitations'],{scopes:['read','conversation:read','conversation:write'],credentialExpiresAt:expiresAt});
  assert.equal(invite.credentialExpiresAt,expiresAt);
  const p=await authenticate(f.request(invite.token),await f.store.read(),{now:f.now});assert.ok(p);
  const result=await f.call({...f.ctx,principal:p},['enrollment','exchange'],{expiresAt:'2099-01-01T00:00:00.000Z',credentialExpiresAt:'2099-01-01T00:00:00.000Z'});
  assert.equal(result.expiresAt,expiresAt);
  assert.equal((await f.store.read()).credentials[result.credentialId].expiresAt,expiresAt);
  assert.ok(await authenticate(f.request(result.token),await f.store.read(),{now:f.now}));
  f.setClock(expiresAt);
  assert.equal(await authenticate(f.request(result.token),await f.store.read(),{now:f.now}),null);
  assert.ok(!JSON.stringify((await f.store.read()).operations).includes(result.token));
});

test('invalid, elapsed and excessive credential windows refuse issuance without adding invitations',async()=>{
  const f=fixture();
  const identity=(await f.call(f.ctx,['identities'],{displayName:'Synthetic member'})).identity;
  for(const value of ['not-a-date',null,123,'2026-10-05T12:00:00.000Z','2026-10-05T11:59:59.000Z',new Date(Date.parse(f.now())+MAX_CREDENTIAL_TTL_MS+1).toISOString()]) {
    await assert.rejects(f.call(f.ctx,['identities',identity.id,'invitations'],{scopes:['read'],credentialExpiresAt:value}),e=>(e as any).code==='invalid_credential_expiry');
  }
  assert.equal(Object.keys((await f.store.read()).invitations).length,0);
});

test('owner-selected thirty-day crew credential remains scoped and revocable, with an exact expiry',async()=>{
  const f=fixture(),expiresAt=new Date(Date.parse(f.now())+30*86400000).toISOString();
  const identity=(await f.call(f.ctx,['identities'],{displayName:'Synthetic existing crew'})).identity;
  const scopes=['read','conversation:read','conversation:write'];
  const invite=await f.call(f.ctx,['identities',identity.id,'invitations'],{scopes,credentialExpiresAt:expiresAt});
  const p=await authenticate(f.request(invite.token),await f.store.read(),{now:f.now});
  const result=await f.call({...f.ctx,principal:p!},['enrollment','exchange'],{});
  f.setClock('2026-11-03T12:00:00.000Z');
  const active=await authenticate(f.request(result.token),await f.store.read(),{now:f.now});
  assert.equal(active?.id,identity.id);assert.deepEqual(active?.scopes,scopes);
  await f.store.transact(s=>{s.credentials[result.credentialId].status='revoked'});
  assert.equal(await authenticate(f.request(result.token),await f.store.read(),{now:f.now}),null);
  await f.store.transact(s=>{s.credentials[result.credentialId].status='active'});
  f.setClock(expiresAt);
  assert.equal(await authenticate(f.request(result.token),await f.store.read(),{now:f.now}),null);
});

test('unexpired invitation cannot issue an already-expired credential; legacy omission remains unchanged',async()=>{
  const f=fixture();
  const identity=(await f.call(f.ctx,['identities'],{displayName:'Synthetic member'})).identity;
  const invite=await f.call(f.ctx,['identities',identity.id,'invitations'],{scopes:['read'],ttlMs:900000,credentialExpiresAt:'2026-10-05T12:01:00.000Z'});
  f.setClock('2026-10-05T12:02:00.000Z');
  const p=await authenticate(f.request(invite.token),await f.store.read(),{now:f.now});assert.ok(p);
  await assert.rejects(f.call({...f.ctx,principal:p},['enrollment','exchange'],{}),e=>(e as any).code==='credential_window_expired');
  assert.equal(Object.keys((await f.store.read()).credentials).length,0);
  const legacy=await f.call(f.ctx,['identities',identity.id,'invitations'],{scopes:['read']});
  const q=await authenticate(f.request(legacy.token),await f.store.read(),{now:f.now});assert.ok(q);
  const result=await f.call({...f.ctx,principal:q},['enrollment','exchange'],{});
  assert.equal(result.expiresAt,undefined);
  assert.equal((await f.store.read()).credentials[result.credentialId].expiresAt,undefined);
});
