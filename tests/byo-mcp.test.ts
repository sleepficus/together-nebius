import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {startLocalServer} from '../cloud/local-server.ts';
import {hashToken} from '../lib/identity.ts';
import {readByoConfig,byoClient,byoRegistration,BYO_TOOLS} from '../adapters/byo-config.ts';
import {readStdioLines,MAX_LINE_BYTES,serveMcp,handleRpc} from '../adapters/mcp.ts';
import {TogetherClient} from '../adapters/client.ts';

const privateWrite=(p:string,data:string)=>{writeFileSync(p,data,{mode:0o600});chmodSync(p,0o600)};
function connection(config:string) {
  const child=spawn(process.execPath,[resolve('dist/mcp/together-byo.mjs'),config],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}});
  const pending=new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();let id=0,closed=false,stderr='';
  const fail=(e:Error)=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(e)}pending.clear()};
  const reader=createInterface({input:child.stdout});
  reader.on('line',line=>{try{const frame=JSON.parse(line),p=pending.get(frame.id);if(p){pending.delete(frame.id);clearTimeout(p.timer);p.resolve(frame)}}catch{fail(new Error('Invalid MCP response'))}});
  reader.on('close',()=>fail(new Error('MCP stdout closed')));reader.on('error',fail);child.on('error',fail);child.stderr.on('data',c=>{stderr+=c.toString()});
  const rpc=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{
    if(closed){reject(new Error('MCP already closed'));return}
    const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('MCP response deadline'))},4000);
    pending.set(requestId,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');
  });
  const tool=async(name:string,args:any={})=>{const frame=await rpc('tools/call',{name,arguments:args});assert.equal(frame.error,undefined);return JSON.parse(frame.result.content[0].text)};
  return {rpc,tool,async close(){if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.stdin.end();try{await exit}finally{clearTimeout(timer)}}reader.close();assert.equal(child.exitCode,0);assert.equal(stderr,'')}};
}

test('BYO config refuses exposed files and nonsecure remote origins; registration is secret-free',()=>{
  const dir=mkdtempSync(join(tmpdir(),'byo-config-')),cfg=join(dir,'config.json'),secret=join(dir,'token');
  try {
    privateWrite(secret,'fixture-token-a');privateWrite(cfg,JSON.stringify({baseUrl:'http://127.0.0.1:9999',projectId:'fixture',credentialFile:secret}));
    const descriptor=JSON.stringify(byoRegistration('codex',cfg));assert.ok(descriptor.includes('together-byo.mjs'));assert.ok(!descriptor.includes('fixture-token-a'));assert.ok(descriptor.includes('enabled_tools'));
    assert.ok(byoRegistration('claude',cfg).mcpServers);
    chmodSync(secret,0o644);assert.throws(()=>byoClient(readByoConfig(cfg)),/private regular files/);chmodSync(secret,0o600);
    privateWrite(cfg,JSON.stringify({baseUrl:'http://127.0.0.1:9999',projectId:'fixture',credentialCommand:{command:process.execPath,args:['-e',"process.stdout.write('fixture-token-command')"]}}));
    assert.equal(byoClient(readByoConfig(cfg)).config.token,'fixture-token-command');
    privateWrite(cfg,JSON.stringify({baseUrl:'http://127.0.0.1:9999',projectId:'fixture',credentialCommand:{command:process.execPath,args:['-e',"process.stderr.write('fixture-private-failure');process.exit(1)"]}}));
    assert.throws(()=>byoClient(readByoConfig(cfg)),e=>e instanceof Error&&!e.message.includes('fixture-private-failure'));
    for(const baseUrl of ['http://remote.example','https://user:password@example.org','https://example.org/path','https://example.org?token=secret']) {
      privateWrite(cfg,JSON.stringify({baseUrl,projectId:'fixture',credentialFile:secret}));assert.throws(()=>readByoConfig(cfg));
    }
  } finally {rmSync(dir,{recursive:true,force:true})}
});

test('an unreadable successful response preserves an unknown write outcome instead of confirming success',async()=>{
  const c=new TogetherClient({baseUrl:'http://127.0.0.1',projectId:'fixture',token:'fixture-token',fetchFn:async()=>new Response('broken JSON',{status:201})});
  const response=await c.postMessage('team','Fixture','same-request');
  assert.equal(response.ok,false);assert.equal(response.error?.code,'invalid_response');assert.match(response.error?.nextAction??'',/Reuse clientRequestId/);
});

test('MCP redacts its credential from successful content and transport error results',async()=>{
  for(const fail of [false,true]){
    const c=new TogetherClient({baseUrl:'http://127.0.0.1',projectId:'fixture',token:'fixture-private-credential',fetchFn:async()=>{if(fail)throw new Error('fixture-private-credential');return Response.json({echo:'fixture-private-credential'})}});
    const result=await handleRpc(c,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'together_conversations',arguments:{}}},BYO_TOOLS);
    assert.ok(!JSON.stringify(result).includes('fixture-private-credential'));assert.ok(JSON.stringify(result).includes('[credential redacted]'));
  }
});

test('stdio splitter bounds oversized unfinished input, recovers the next frame, and propagates reader failure',async()=>{
  async function* chunks(){for(let i=0;i<20;i++)yield Buffer.alloc(40_000,120);yield Buffer.from('\n'+JSON.stringify({jsonrpc:'2.0',id:1,method:'ping',params:{padding:'p'.repeat(146_000)}})+'\n')}
  const lines=[];for await(const line of readStdioLines(chunks()))lines.push(line);
  assert.equal(lines[0].length,MAX_LINE_BYTES+1);assert.equal(JSON.parse(lines[1]).id,1);
  const client=new TogetherClient({baseUrl:'http://127.0.0.1',projectId:'fixture',token:'unused'});
  async function* broken(){throw new Error('fixture read failure');yield ''}
  await assert.rejects(serveMcp(client,{lines:broken(),write:()=>{}}),/fixture read failure/);
});

test('real BYO stdio round trip: scoped existing-session fixtures read/post/ack/reconnect/handoff/revoke',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'byo-transport-')),owner={ownerId:'fixture-owner',token:'fixture-owner-token'};
  const {server,api,listening}=startLocalServer({ownerTokens:[owner],port:0,stateDir:join(dir,'state'),seedProjects:[{id:'byo-fixture'}]});
  const peers:ReturnType<typeof connection>[]=[];
  try {
    const baseUrl='http://127.0.0.1:'+await listening,store=api.storeFor('byo-fixture')!;
    const now=new Date().toISOString();
    for(const id of ['alpha','beta']) {
      const tokenHash=await hashToken('fixture-token-'+id);
      await store.transact(s=>{
        const e={id,projectId:s.project.id,revision:1,createdAt:now,updatedAt:now,actorId:owner.ownerId};
        const scopes=['read','conversation:read','conversation:write','lounge:write'];
        s.identities[id]={...e,displayName:'Synthetic '+id,ownerId:owner.ownerId,creationSource:'fixture',status:'active'};
        s.members[id]={...e,identityId:id,kind:'core',scopes};
        s.sessions[id+'-existing']={...e,id:id+'-existing',identityId:id,advertisedCapabilities:[],observedCapabilities:[],status:'active'};
        s.credentials[id]={...e,identityId:id,sessionId:id+'-existing',tokenHash,projectIds:[s.project.id],scopes,status:'active'};
      });
      const credentialFile=join(dir,id+'-token');privateWrite(credentialFile,'fixture-token-'+id);
      privateWrite(join(dir,id+'.json'),JSON.stringify({baseUrl,projectId:'byo-fixture',credentialFile}));
    }
    await fetch(baseUrl+'/api/v1/projects/byo-fixture/conversations',{headers:{authorization:'Bearer '+owner.token}});
    let alpha=connection(join(dir,'alpha.json'));peers.push(alpha);let beta=connection(join(dir,'beta.json'));peers.push(beta);
    assert.equal((await alpha.rpc('initialize',{protocolVersion:'2024-11-05',clientInfo:{name:'synthetic-existing-session-host',version:'1'},capabilities:{}})).result.serverInfo.name,'together-mcp');
    assert.deepEqual((await alpha.rpc('tools/list')).result.tools.map((t:any)=>t.name).sort(),[...BYO_TOOLS].sort());
    assert.ok((await alpha.rpc('tools/call',{name:'together_workspace',arguments:{assignmentId:'a'}})).error);
    const toolList=(await alpha.rpc('tools/list')).result.tools;
    for(const t of toolList)assert.equal(t.annotations.readOnlyHint,!['together_post_message','together_opened','together_handoff'].includes(t.name));
    const modern=await alpha.rpc('initialize',{protocolVersion:'2025-06-18'});assert.equal(modern.result.protocolVersion,'2025-06-18');assert.match(modern.result.instructions,/pull-only/);
    await store.transact(s=>{s.sessions['alpha-existing'].harness='synthetic-existing-host'});
    const ownerProfile=await fetch(baseUrl+'/api/v1/projects/byo-fixture/presentation',{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify({identityId:'alpha',sessionId:'alpha-existing',name:'Synthetic Alpha',mode:'original',summary:'Project runtime helper',runtimeLabel:'Synthetic host',requestedModel:'Declared fixture model'})});assert.equal(ownerProfile.status,200);
    const status=await alpha.tool('together_status');assert.equal(status.platform,'connected');assert.equal(status.inference,'unknown');
    const post=await alpha.tool('together_post_message',{channel:'team',body:'Synthetic BYO private canary',clientRequestId:'stable-a'});assert.equal(post.status,201);assert.equal(post.result.message.sender.sessionId,'alpha-existing');
    assert.match(post.result.message.sender.adapterInstanceId,/^[0-9a-f-]{36}$/);
    const parallel=connection(join(dir,'alpha.json'));peers.push(parallel);await parallel.tool('together_status');
    const presence=await (await fetch(baseUrl+'/api/v1/projects/byo-fixture/presentation',{headers:{authorization:'Bearer '+owner.token}})).json();
    const seat=presence.profiles.find((p:any)=>p.identityId==='alpha');assert.equal(seat.recentConnections,2);assert.match(seat.observed,/when prompted/);assert.equal(seat.wake,'No automatic wake-up');
    await parallel.close();
    const duplicate=await alpha.tool('together_post_message',{channel:'team',body:'Synthetic BYO private canary',clientRequestId:'stable-a'});assert.equal(duplicate.result.message.id,post.result.message.id);
    assert.equal((await alpha.tool('together_post_message',{channel:'team',body:'changed content',clientRequestId:'stable-a'})).status,409);
    const page=await beta.tool('together_read_messages',{channel:'team'});assert.equal(page.result.messages.length,1);
    assert.equal((await beta.tool('together_opened',{channel:'team',seq:page.result.nextCursor})).status,200);
    assert.equal((await beta.tool('together_opened',{channel:'team',seq:9999})).status,409);
    assert.equal((await beta.tool('together_post_message',{channel:'team',body:'Synthetic response',clientRequestId:'stable-b'})).status,201);
    await beta.close();beta=connection(join(dir,'beta.json'));peers.push(beta);
    const resumed=await beta.tool('together_read_messages',{channel:'team'});assert.equal(resumed.result.messages.length,1);assert.equal(resumed.result.messages[0].seq,2);
    await alpha.close();alpha=connection(join(dir,'alpha.json'));peers.push(alpha);
    const rePost=await alpha.tool('together_post_message',{channel:'team',body:'Synthetic BYO private canary',clientRequestId:'stable-a'});assert.equal(rePost.result.message.id,post.result.message.id);
    const reread=await alpha.tool('together_read_messages',{channel:'team'});assert.equal(reread.result.messages.length,2);assert.equal(reread.result.messages[0].sender.sessionId,'alpha-existing');
    await store.transact(s=>{
      s.project.adoptedPlanRevisionId='plan-a';
      s.tasks.task={id:'task',projectId:s.project.id,revision:1,createdAt:now,updatedAt:now,actorId:owner.ownerId,goal:'Synthetic task',acceptanceCriteria:['Inspect context'],dependencies:[],lifecycle:'claimed',resultRefs:[],currentAssignmentId:'claim'};
      s.assignments.claim={id:'claim',projectId:s.project.id,revision:1,createdAt:now,updatedAt:now,actorId:owner.ownerId,taskId:'task',identityId:'alpha',sessionId:'alpha-existing',epoch:1,status:'active',role:'owner',leaseExpiresAt:'2030-01-01T00:00:00Z',maxUntil:'2030-01-01T00:00:00Z',scopes:['read']};
    });
    await alpha.tool('together_brief',{taskId:'task'});await alpha.tool('together_context_brief',{taskId:'task'});
    await store.transact(s=>{s.assignments.claim.sessionId='alpha-other-session'});
    assert.equal((await alpha.tool('together_handoff',{assignmentId:'claim',done:'Wrong session',next:'Do not apply'})).status,403);
    await store.transact(s=>{s.assignments.claim.sessionId='alpha-existing'});
    const handoff=await alpha.tool('together_handoff',{assignmentId:'claim',done:'Inspected',next:'Verify source'});assert.equal(handoff.status,201);assert.equal(handoff.result.handoff.planRevisionId,'plan-a');
    await store.transact(s=>{s.project.adoptedPlanRevisionId='plan-b'});
    assert.equal((await alpha.tool('together_handoff',{assignmentId:'claim',done:'Old read',next:'Do not replay'})).status,409);
    const snapshot=await fetch(baseUrl+'/api/v1/projects/byo-fixture',{headers:{authorization:'Bearer '+owner.token}});assert.ok(!(await snapshot.text()).includes('Synthetic BYO private canary'));
    await store.transact(s=>{s.stopped=true});
    assert.equal((await alpha.tool('together_post_message',{channel:'team',body:'Stopped',clientRequestId:'stopped'})).status,409);
    await store.transact(s=>{s.stopped=false});
    // The next deliberate call observes an owner's resume, without replaying
    // the denied write or replacing this MCP process / existing session.
    assert.equal((await alpha.tool('together_read_messages',{channel:'team'})).status,200);
    await store.transact(s=>{s.credentials.beta.status='revoked'});
    assert.equal((await beta.tool('together_read_messages',{channel:'team'})).status,401);
    assert.equal((await beta.tool('together_post_message',{channel:'team',body:'Denied',clientRequestId:'revoked'})).status,401);
    await store.transact(s=>{s.credentials.beta.status='active'});
    assert.equal((await beta.tool('together_read_messages',{channel:'team'})).status,200);
    await store.transact(s=>{s.credentials.beta.expiresAt='2000-01-01T00:00:00Z'});
    assert.equal((await beta.tool('together_read_messages',{channel:'team'})).status,401);
    await store.transact(s=>{s.credentials.beta.expiresAt=new Date(Date.now()+30*86400000).toISOString()});
    assert.equal((await beta.tool('together_read_messages',{channel:'team'})).status,200);
    const rotated='fixture-token-beta-rotated';
    await store.transact(async s=>{s.credentials.beta.tokenHash=await hashToken(rotated)});
    privateWrite(join(dir,'beta-token'),rotated);
    assert.equal((await beta.tool('together_post_message',{channel:'team',body:'Rotated same session',clientRequestId:'rotated'})).result.message.sender.sessionId,'beta-existing');
  } finally {
    for(const peer of peers)await peer.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});
  }
});
