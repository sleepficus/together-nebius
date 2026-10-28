import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {byoClient,BYO_TOOLS} from '../adapters/byo-config.ts';
import {handleRpc} from '../adapters/mcp.ts';

test('rotation stays redacted; denial causes one request, not automatic mutation replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'together-recovery-')),credentialFile=join(dir,'credential');
  const old='fixture-old-secret',fresh='fixture-new-secret';
  writeFileSync(credentialFile,old,{mode:0o600});
  let count=0,denied=true;const authorizations:string[]=[];
  const server=createServer((req,res)=>{
    count++;authorizations.push(req.headers.authorization??'');
    res.writeHead(denied?401:200,{'content-type':'application/json'});
    res.end(JSON.stringify(denied?{error:{code:'unauthorized'}}:{old,fresh}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=byoClient({baseUrl:'http://127.0.0.1:'+(server.address() as any).port,projectId:'fixture',credentialFile});
  const rpc=(name:string,args:any={})=>handleRpc(client,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},BYO_TOOLS);
  try {
    const deniedWrite=await rpc('together_post_message',{channel:'team',body:'Do not replay',clientRequestId:'once'});
    assert.equal((deniedWrite.result as any).isError,true);assert.equal(count,1);
    writeFileSync(credentialFile,fresh,{mode:0o600});denied=false;
    const recovered=await rpc('together_conversations');
    assert.equal(count,2);assert.deepEqual(authorizations,['Bearer '+old,'Bearer '+fresh]);
    const text=JSON.stringify(recovered);assert.ok(!text.includes(old));assert.ok(!text.includes(fresh));assert.ok(text.includes('[credential redacted]'));
    assert.equal(client.config.token,fresh);
    denied=true;await rpc('together_conversations');await rpc('together_conversations');assert.equal(count,4);
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});
  }
});
