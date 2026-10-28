import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startDemo} from '../scripts/start-local.mts';
// @ts-ignore Deliberate JavaScript CLI surface.
import {runAgentCLI,displayResult,cliFailure} from '../scripts/crew-mcp.mjs';
// @ts-ignore Deliberate JavaScript CLI surface.
import {setupAgent,setupFailure} from '../scripts/agent-setup.mjs';

const exec=promisify(execFile);
const SENTINEL='DO-NOT-PRINT-SYNTHETIC-CREDENTIAL';
const envelope={content:[{type:'text',text:JSON.stringify({ok:true,result:{line:'hello\nworld'}})}]};

function fakeClient(result:any=envelope,error?:any){
 const seen={connect:0,call:0,list:0,close:0,args:null as any};
 return {seen,async connect(){seen.connect++;},async callTool(args:any){seen.call++;seen.args=args;if(error)throw error;return result;},async listTools(){seen.list++;return {tools:[]};},async close(){seen.close++;}};
}
async function invoke(args:string[],client:any){
 const stdout:string[]=[],stderr:string[]=[];
 const code=await runAgentCLI(args,{client,transport:{},out:(s:string)=>stdout.push(s),err:(s:string)=>stderr.push(s)});
 return {code,stdout,stderr,client};
}

test('default CLI preserves the exact MCP envelope; pretty output unwraps one JSON document',async()=>{
 const raw=await invoke(['private.json','together_project','{}'],fakeClient());
 assert.equal(raw.code,0);assert.deepEqual(JSON.parse(raw.stdout[0]),envelope);
 assert.equal(raw.client.seen.call,1);assert.equal(raw.client.seen.close,1);
 const pretty=await invoke(['--pretty','private.json','together_project','{}'],fakeClient());
 assert.equal(pretty.code,0);assert.deepEqual(JSON.parse(pretty.stdout[0]),{ok:true,result:{line:'hello\nworld'}});
 assert.deepEqual(JSON.parse(displayResult(envelope,false)),envelope);
 const plain={content:[{type:'text',text:'plain result'}]};
 assert.deepEqual(JSON.parse(displayResult(plain,true)),plain);
});

test('malformed and nonobject JSON gets actionable errors before connecting or sending',async()=>{
 for(const [text,expected] of [['{"body":"'+SENTINEL,'invalid_json_arguments'],['null','invalid_tool_arguments'],['[]','invalid_tool_arguments']]){
  const result=await invoke(['private.json','together_post_message',text],fakeClient());
  assert.equal(result.code,1);assert.equal(result.client.seen.connect,0);assert.equal(result.client.seen.call,0);
  const error=JSON.parse(result.stderr[0]).error;assert.equal(error.code,expected);assert.equal(error.automaticRetry,false);
  assert.ok(!result.stderr.join('').includes(SENTINEL));
 }
});

test('list and --raw keep SDK-compatible output; valid arguments are sent once unchanged',async()=>{
 const list=await invoke(['--raw','private.json','list'],fakeClient());
 assert.deepEqual(JSON.parse(list.stdout[0]),{tools:[]});assert.equal(list.client.seen.list,1);assert.equal(list.client.seen.call,0);
 const result=await invoke(['private.json','together_results','{"collection":"tasks"}'],fakeClient());
 assert.deepEqual(result.client.seen.args,{name:'together_results',arguments:{collection:'tasks'}});
});

test('tool refusals are printed intact with a failure exit and no retry in both display modes',async()=>{
 const refused={isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:{code:'access_unavailable',message:'Scoped access unavailable'}})}]};
 for(const flags of [[],['--pretty']]){
  const result=await invoke([...flags,'private.json','together_project','{}'],fakeClient(refused));
  assert.equal(result.code,1);assert.equal(result.client.seen.call,1);
  const parsed=JSON.parse(result.stdout[0]);
  assert.equal((flags.length?parsed:JSON.parse(parsed.content[0].text)).error.code,'access_unavailable');
 }
});

test('protocol errors retain safe server code fields without exception messages or data',async()=>{
 for(const error of [
  {code:-32603,data:{error:{code:'permission_denied',message:SENTINEL}},message:SENTINEL},
  {code:-32603,data:JSON.stringify({code:'access_unavailable',message:SENTINEL}),message:SENTINEL},
  {code:-32603,message:'MCP error -32603: '+JSON.stringify({error:{code:'revision_conflict',message:SENTINEL}})},
  {code:-32603,data:{requestId:'metadata-only'},message:'MCP error -32603: '+JSON.stringify({code:'not_found',message:SENTINEL})},
 ]){
  const result=await invoke(['private.json','together_project','{}'],fakeClient(envelope,error));
  assert.equal(result.code,1);assert.equal(result.client.seen.call,1);assert.equal(result.client.seen.close,1);
  const output=result.stderr.join('');assert.ok(!output.includes(SENTINEL));assert.notEqual(JSON.parse(output).error.code,'mcp_call_failed');
 }
 assert.equal(cliFailure({code:-32602,message:SENTINEL}).error.code,'invalid_tool_arguments');
 assert.ok(!JSON.stringify(cliFailure(Error(SENTINEL))).includes(SENTINEL));
});

test('connection and close errors remain actionable without credential echo or call replay',async()=>{
 const client=fakeClient();client.connect=async()=>{client.seen.connect++;throw Error(SENTINEL);};
 const failed=await invoke(['private.json','together_project'],client);
 assert.equal(failed.code,1);assert.equal(client.seen.call,0);assert.equal(client.seen.close,1);
 assert.equal(JSON.parse(failed.stderr[0]).error.code,'connection_unavailable');assert.ok(!failed.stderr[0].includes(SENTINEL));
 const closing=fakeClient();closing.close=async()=>{closing.seen.close++;throw Error(SENTINEL);};
 const closed=await invoke(['private.json','together_project'],closing);
 assert.equal(closed.code,1);assert.equal(closing.seen.call,1);assert.equal(JSON.parse(closed.stderr[0]).error.code,'transport_close_failed');
 assert.ok(!closed.stderr[0].includes(SENTINEL));
});

test('actual CLI rejects malformed JSON before touching a private connection',async()=>{
 const result=await exec(process.execPath,[resolve('scripts/crew-mcp.mjs'),'/nonexistent/private-config.json','together_project','{"token":"'+SENTINEL],{timeout:10000}).then(x=>({...x,code:0}),error=>({...error,code:error.code}));
 assert.equal(result.code,1);assert.equal(JSON.parse(result.stderr).error.code,'invalid_json_arguments');assert.ok(!result.stderr.includes(SENTINEL));
});

test('actual scoped MCP and reused setup preserve identity, raw output and original known expiry',async t=>{
 const stateDir=mkdtempSync(join(tmpdir(),'together-cli-rc2-'));
 const app=await startDemo({port:0,apiPort:0,stateDir});
 t.after(async()=>{await app.close();rmSync(stateDir,{recursive:true,force:true});});
 const connection=await setupAgent({name:'CLI fixture',host:'other',profile:'work',stateDir,days:1});
 assert.equal(connection.expiryStatus,'enrollment-response');assert.ok(Number.isFinite(Date.parse(connection.expiresAt)));
 const configBefore=JSON.parse(readFileSync(connection.configPath,'utf8'));
 const tokenBefore=readFileSync(configBefore.credentialFile,'utf8');
 const reused=await setupAgent({name:'CLI fixture',host:'other',profile:'work',stateDir,days:30});
 assert.equal(reused.reused,true);assert.equal(reused.identityId,connection.identityId);assert.equal(reused.sessionId,connection.sessionId);
 assert.equal(reused.expiresAt,connection.expiresAt);assert.equal(reused.expiryStatus,'cached-enrollment-value');
 assert.match(reused.expiryNote,/does not renew/);assert.equal(readFileSync(configBefore.credentialFile,'utf8'),tokenBefore);
 for(const flags of [[],['--pretty']]){
  const {stdout}=await exec(process.execPath,[resolve('scripts/crew-mcp.mjs'),...flags,connection.configPath,'together_project','{}'],{timeout:10000});
  const parsed=JSON.parse(stdout);assert.equal((flags.length?parsed:JSON.parse(parsed.content[0].text)).ok,true);
 }
 // An rc1 config without an expiry remains honest and is not renewed.
 const oldConfig=JSON.parse(readFileSync(connection.configPath,'utf8'));delete oldConfig.expiresAt;
 writeFileSync(connection.configPath,JSON.stringify(oldConfig)+'\n',{mode:0o600});
 const unknown=await setupAgent({name:'CLI fixture',host:'other',profile:'work',stateDir});
 assert.equal(unknown.reused,true);assert.equal(unknown.expiresAt,'unknown');assert.equal(unknown.expiryStatus,'unknown');assert.match(unknown.expiryNote,/was not cached/);
 assert.equal(unknown.identityId,connection.identityId);assert.equal(unknown.sessionId,connection.sessionId);
 // Denial still refuses instead of creating a fresh identity or replacing config.
 const deniedConfig=readFileSync(connection.configPath,'utf8');
 writeFileSync(configBefore.credentialFile,'OFFLINE-invalid-fixture-token\n',{mode:0o600});
 await assert.rejects(setupAgent({name:'CLI fixture',host:'other',profile:'work',stateDir}),/not replaced/);
 assert.equal(readFileSync(connection.configPath,'utf8'),deniedConfig);
 const denied=await exec(process.execPath,[resolve('scripts/crew-mcp.mjs'),connection.configPath,'together_project','{}'],{timeout:10000}).then(x=>({...x,code:0}),error=>({...error,code:error.code}));
 assert.equal(denied.code,1);const denial=JSON.parse(JSON.parse(denied.stdout).content[0].text);
 assert.equal(denial.error.code,'access_unavailable');assert.ok(!denied.stdout.includes('OFFLINE-invalid-fixture-token'));
});

test('setup CLI errors keep known refusal/code and suppress arbitrary exception text',()=>{
 assert.match(setupFailure(Error('A prior setup was interrupted. Its operation record is retained; no duplicate identity was created')).error.message,/no duplicate/);
 assert.equal(setupFailure(Error('Setup 403: permission_denied')).error.code,'permission_denied');
 for(const error of [Error(SENTINEL),new SyntaxError('Unexpected token '+SENTINEL)])assert.ok(!JSON.stringify(setupFailure(error)).includes(SENTINEL));
});
