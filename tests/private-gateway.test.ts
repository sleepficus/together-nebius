import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createLocalApi} from '../cloud/local-server.ts';
import {privateGateway} from '../cloud/private-gateway.ts';

test('normal private sign-in is reusable, secret-free and origin/identity checked',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'together-private-login-'));
  writeFileSync(join(dir,'index.html'),'<html>fixture assets remain available</html>');
  const ownerToken='fixture-owner-private-token',origin='https://fixture.tailnet.ts.net:15443';
  const api=createLocalApi({ownerTokens:[{ownerId:'steve',token:ownerToken}],seedProjects:[{id:'crew'}],allowedOrigins:[origin],sessionTtlSeconds:30*86400});
  const server=privateGateway({api,ownerToken,origin,projectId:'crew',assetRoot:dir,allowedTailscaleLogin:'fixture-steve@example.invalid',allowLocalSeat:false});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as any).port;
  // Fetch's Host override is intentionally ignored in Node22; use an actual
  // HTTP request to model the trusted Serve reverse-proxy boundary.
  const call=(path:string,init:RequestInit={})=>new Promise<Response>((resolve,reject)=>{
    const req=request(base+path,{method:init.method??'GET',headers:{host:new URL(origin).host,'tailscale-user-login':'fixture-steve@example.invalid',...Object.fromEntries(new Headers(init.headers))}},res=>{
      const parts:Buffer[]=[];res.on('data',part=>parts.push(part));res.on('end',()=>{
        const headers=new Headers();for(const [key,value] of Object.entries(res.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
        resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers}));
      });
    });req.on('error',reject);req.end();
  });
  try {
    const login=await call('/login');assert.equal(login.status,200);
    const html=await login.text();assert.match(html,/Sign in as Steve/);assert.ok(!html.includes(ownerToken));assert.ok(!html.includes('/join/'));
    assert.equal((await call('/login',{headers:{'tailscale-user-login':'another-user'}})).status,403);
    assert.equal((await call('/login',{headers:{host:'evil.example'}})).status,403);
    assert.equal((await call('/login',{method:'POST'})).status,403);
    assert.equal((await call('/login',{method:'POST',headers:{origin:'https://evil.example'}})).status,403);
    assert.equal((await call('/login',{method:'POST',headers:{origin,'sec-fetch-site':'cross-site'}})).status,403);
    const signed=await call('/login',{method:'POST',headers:{origin}});
    assert.equal(signed.status,303);assert.equal(signed.headers.get('location'),'/projects/live%3Acrew?view=talk');
    const setCookie=signed.headers.get('set-cookie')!;assert.match(setCookie,/Max-Age=2592000/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);
    assert.ok(!JSON.stringify([...signed.headers]).includes(ownerToken));
    const cookie=setCookie.split(';')[0];
    assert.equal((await call('/api/v1/session',{headers:{cookie}})).status,200);
    assert.equal((await call('/login',{headers:{cookie}})).status,303);
    assert.equal((await call('/api/v1/session',{method:'POST',headers:{origin,authorization:'Bearer '+ownerToken}})).status,403);
    assert.equal((await call('/api/v1/projects',{headers:{authorization:'Bearer '+ownerToken}})).status,401);
    assert.equal((await call('/api/v1/session',{method:'DELETE',headers:{origin,cookie}})).status,200);
    assert.equal((await call('/api/v1/session',{headers:{cookie}})).status,401);
    assert.equal((await call('/login',{method:'POST',headers:{origin}})).status,303);
    assert.equal((await call('/join/old-expired-bookmark')).headers.get('location'),'/login');
    assert.equal((await call('/api/v1/login-options')).status,200);
    assert.match(await (await call('/')).text(),/fixture assets remain available/);
    assert.equal((await fetch(base+'/login',{redirect:'manual'})).status,403);
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));api.close();rmSync(dir,{recursive:true,force:true});
  }
});
