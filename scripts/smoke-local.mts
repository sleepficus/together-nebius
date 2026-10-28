import assert from 'node:assert/strict';
import {statSync,rmSync,mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {startDemo,parseOptions} from './start-local.mts';

// Uses fresh OS-assigned loopback ports and only its own disposable state.
const repoRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));mkdirSync(resolve(repoRoot,'.runtime'),{recursive:true,mode:0o700});
const demo=await startDemo({port:0,apiPort:0,stateDir:mkdtempSync(resolve(repoRoot,'.runtime/smoke-'))});
let closed=false;
try{
  assert.equal(parseOptions(['--port','0'],{}).port,0);
  assert.throws(()=>parseOptions(['--port','-1']));
  assert.throws(()=>parseOptions(['--port','65536']));
  assert.throws(()=>parseOptions(['--port','8928','--api-port','8928']));
  assert.throws(()=>parseOptions(['--state-dir']));
  await assert.rejects(()=>startDemo({port:Number(new URL(demo.origin).port),apiPort:0}),{code:'EADDRINUSE'});
  assert.equal(statSync(resolve(demo.stateDir,'owner-token')).mode&0o777,0o600);
  const get=(path:string,init:RequestInit={})=>fetch(demo.origin+path,{...init,signal:AbortSignal.timeout(10000)});
  const relative=demo.stateDir.slice(repoRoot.length),token=readFileSync(resolve(demo.stateDir,'owner-token'),'utf8').trim();
  for(const path of [relative+'/owner-token','/@fs'+demo.stateDir+'/owner-token',relative.replace('.runtime','%2eruntime')+'/owner-token']){
    const response=await get(path);assert.equal(response.status,403);assert.ok(!(await response.text()).includes(token));
  }
  assert.equal((await get('/api/v1/projects')).status,401);
  assert.equal((await fetch(demo.apiOrigin+'/api/v1/projects')).status,401);
  assert.match(await (await get('/')).text(),/id="root"/);
  const module=await get('/src/main.tsx');assert.equal(module.status,200);
  assert.match(await module.text(),/createRoot/);
  assert.match(await (await get('/local-login')).text(),/saved local workspace/);
  assert.equal((await get('/local-login',{method:'POST'})).status,403);
  assert.equal((await get('/local-login',{method:'POST',headers:{origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await get('/local-login',{method:'POST',headers:{origin:demo.origin,'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await get('/api/v1/session',{method:'POST',headers:{authorization:'Bearer invalid-demo-token',origin:demo.origin}})).status,401);
  const login=await get('/local-login',{method:'POST',headers:{origin:demo.origin}});
  assert.equal(login.status,201);
  const cookieHeader=login.headers.get('set-cookie')!;
  assert.match(cookieHeader,/HttpOnly/);assert.match(cookieHeader,/SameSite=Strict/);assert.match(cookieHeader,/Path=\/api/);
  const cookie=cookieHeader.split(';')[0];
  assert.equal((await get('/api/v1/session',{headers:{cookie}})).status,200);
  const projects=await get('/api/v1/projects',{headers:{cookie}});assert.equal(projects.status,200);
  assert.match(await projects.text(),/local-demo/);
  const live=await get('/api/v1/projects/'+demo.projectId,{headers:{cookie}});assert.equal(live.status,200);
  assert.match(await live.text(),/"mode":"live"/);
  const prefix='/api/v1/projects/'+demo.projectId;
  const connected=await(await get(prefix+'/nemo/connect',{method:'POST',headers:{cookie,origin:demo.origin,'content-type':'application/json'},body:'{}'})).json() as any;
  assert.equal((await get(relative+'/nemo/nemo-private.json')).status,403);
  assert.equal(connected.budget.calls,0);
  const human=await get(prefix+'/conversations/team/messages',{method:'POST',headers:{cookie,origin:demo.origin,'content-type':'application/json'},body:JSON.stringify({body:'Offline startup persistence control',clientRequestId:'smoke-persistence-control'})});assert.equal(human.status,201);
  assert.equal((await get('/api/v1/session',{method:'DELETE',headers:{cookie,origin:demo.origin}})).status,200);
  assert.equal((await get('/api/v1/projects',{headers:{cookie}})).status,401);
  await demo.close();closed=true;
  await assert.rejects(()=>fetch(demo.origin,{signal:AbortSignal.timeout(2000)}));
  await assert.rejects(()=>fetch(demo.apiOrigin+'/api/v1/projects',{signal:AbortSignal.timeout(2000)}));
  const reopened=await startDemo({port:0,apiPort:0,stateDir:demo.stateDir});
  try{
    const relogin=await fetch(reopened.origin+'/local-login',{method:'POST',headers:{origin:reopened.origin}});const nextCookie=relogin.headers.get('set-cookie')!.split(';')[0];
    const restored=await(await fetch(reopened.origin+prefix+'/nemo',{headers:{cookie:nextCookie}})).json() as any;
    assert.deepEqual(restored.identity,connected.identity);assert.equal(restored.budget.calls,0);
    const messages=await(await fetch(reopened.origin+prefix+'/conversations/team?after=0',{headers:{cookie:nextCookie}})).json() as any;
    assert.equal(messages.messages[0].body,'Offline startup persistence control');
  }finally{await reopened.close();}
  console.log('PASS: loopback startup, HTML, auth denials, cookie login/logout, live API, shutdown and same-state restart preserve Nemo identity/conversation with zero inference. Owned Git fixture created; browser rendering, provider inference, fixed checks and Docker not exercised here.');
}finally{
  if(!closed)await demo.close();
  rmSync(demo.stateDir,{recursive:true,force:true});
}
