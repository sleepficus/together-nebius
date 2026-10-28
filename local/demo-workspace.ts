import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {RunnerService} from '../lib/types.ts';
import type {CollectorTransport} from '../runner/snapshot-runner.ts';

export const CHECK_COMMAND='node --experimental-test-isolation=none --test summary.test.mjs';
export const DEMO_FILES=['summary.mjs','summary.test.mjs','README.md'] as const;
export const DEMO_BRIEF=`# Small coding demonstration\n\nImplement export function summarizeChecks(records) in summary.mjs.\nInput is an array of check records; a record may have status passed, failed or not-checked.\nReturn {status,total,passed,failed,notChecked}. Failed takes precedence. Otherwise status is passed only for a nonempty array where every record explicitly passed. Empty input, missing/unknown status, null records, and pending checks must remain not-checked. Count every input row; do not silently drop unknowns. Null/undefined input counts as empty. Do not mutate input.\n\nOnly summary.mjs may be edited. Read the frozen tests. Run the fixed check tool and report the actual result in Together. A passing check is not human review or permission to integrate.\n`;
// Way-authored recording fixture; exact bytes frozen before subject execution.
export const DEMO_TESTS=readFileSync(new URL('./recording-summary.test.mjs',import.meta.url),'utf8');
export const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
export function git(repo:string,...args:string[]){return execFileSync('git',['-c','user.name=NVIDIA Nemotron demo','-c','user.email=nemo@local.invalid','-C',repo,...args],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024}).trim();}
export function ensureWorkspace(stateDir:string){
 const repo=resolve(stateDir,'nemo-workspace');mkdirSync(repo,{recursive:true,mode:0o700});
 if(lstatSync(repo).isSymbolicLink())throw Error('Demo workspace must be an owned regular directory');
 if(!existsSync(join(repo,'.git'))){
  git(repo,'init','-b','main');
  writeFileSync(join(repo,'summary.mjs'),"export function summarizeChecks(records) {\n  throw new Error('Not implemented yet');\n}\n");
  writeFileSync(join(repo,'summary.test.mjs'),DEMO_TESTS);writeFileSync(join(repo,'README.md'),DEMO_BRIEF);
  git(repo,'add','--',...DEMO_FILES);git(repo,'commit','-m','Freeze the small check-summary demonstration');git(repo,'checkout','-b','nemo-work');
 }
 if(readFileSync(join(repo,'summary.test.mjs'),'utf8')!==DEMO_TESTS||readFileSync(join(repo,'README.md'),'utf8')!==DEMO_BRIEF)throw Error('Frozen demo inputs changed; inspect before continuing');
 return repo;
}
export function readDemoFile(repo:string,file:string){
 if(!(DEMO_FILES as readonly string[]).includes(file))throw Error('Only the three named demo files may be read');
 const path=join(repo,file);if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('Regular demo file required');
 return readFileSync(path,'utf8');
}
export function writeDemoFile(repo:string,file:string,content:string){
 if(file!=='summary.mjs'||typeof content!=='string'||Buffer.byteLength(content)>12000)throw Error('Only summary.mjs, up to 12000 bytes, may be edited');
 readDemoFile(repo,file);writeFileSync(join(repo,file),content);return{file,bytes:Buffer.byteLength(content),sha256:hash(content)};
}
export interface DemoCheck {jobId:string;candidateSha:string;command:string;outcome:string;output:string;outputHash:string;inputHash:string;startedAt:string;endedAt:string;}
/** A single trusted demo's fixed Node check; never a general host-shell runner.
 * Permission-limited child, clean env, immutable SHA snapshot, timeout, no shell.
 * This does not replace or claim the isolation of the existing Docker runner. */
export function fixedDemoRunner(repo:string,stateDir:string,collector:CollectorTransport,onResult:(r:DemoCheck)=>void):RunnerService{
 const active=new Map<string,ReturnType<typeof spawn>>();
 const completions=new Map<string,Promise<void>>();
 return{
  async dispatch(input){
   if(input.command!==CHECK_COMMAND||!input.collectorToken||!/^[0-9a-f]{40}$/.test(input.candidateSha)||Object.keys(input.environment??{}).length)return{accepted:false,reason:'Only the fixed demo check is available'};
   const snapshot=join(stateDir,'checks',input.jobId);mkdirSync(snapshot,{recursive:true,mode:0o700});
   // Read exact blobs, including trailing whitespace, for the check receipt.
   for(const file of DEMO_FILES)writeFileSync(join(snapshot,file),execFileSync('git',['-C',repo,'show',input.candidateSha+':'+file],{timeout:10000,maxBuffer:20000}));
   if(readFileSync(join(snapshot,'summary.test.mjs'),'utf8')!==DEMO_TESTS||readFileSync(join(snapshot,'README.md'),'utf8')!==DEMO_BRIEF)return{accepted:false,reason:'Frozen demo tests differ at candidate SHA'};
   const inputHash=hash(DEMO_FILES.map(f=>f+'\0'+hash(readFileSync(join(snapshot,f)))).join('\n'));
   const startedAt=new Date().toISOString();let output='',overflow=false,spawnFailure=false;let finished!:()=>void;
   completions.set(input.jobId,new Promise<void>(done=>{finished=done}));
   const child=spawn(process.execPath,['--permission','--allow-fs-read='+realpathSync(snapshot),'--disable-proto=throw','--experimental-test-isolation=none','--test','summary.test.mjs'],{cwd:snapshot,env:{PATH:process.env.PATH??'',LANG:'C',HOME:snapshot},stdio:['ignore','pipe','pipe']});active.set(input.jobId,child);
   const append=(chunk:Buffer)=>{if(Buffer.byteLength(output)+chunk.length>65536){overflow=true;child.kill('SIGKILL')}else output+=chunk.toString()};child.stdout.on('data',append);child.stderr.on('data',append);
   const timer=setTimeout(()=>child.kill('SIGKILL'),Math.min(input.timeoutMs,15000));
   const finish=async(code:number|null,signal?:string)=>{clearTimeout(timer);active.delete(input.jobId);const outcome=code===0&&!overflow?'pass':spawnFailure?'error':signal==='SIGTERM'?'cancelled':signal?'timeout':'fail';
    const r:DemoCheck={jobId:input.jobId,candidateSha:input.candidateSha,command:CHECK_COMMAND,outcome,output,outputHash:hash(output),inputHash,startedAt,endedAt:new Date().toISOString()};
    writeFileSync(join(snapshot,'result.json'),JSON.stringify(r,null,2)+'\n',{mode:0o600});onResult(r);
    const receiptOutcome=outcome==='cancelled'||outcome==='timeout'?'error':outcome;
    await collector({projectId:input.projectId,jobId:input.jobId,operationId:'demo-collector-'+input.jobId,collectorToken:input.collectorToken!,candidateSha:input.candidateSha,command:CHECK_COMMAND,outcome:receiptOutcome as 'pass'|'fail'|'error',inputHash,outputHash:r.outputHash,logTail:output,startedAt,endedAt:r.endedAt});
   };
   child.once('close',(code,signal)=>void finish(code,signal??undefined).catch(()=>undefined).finally(()=>{finished();completions.delete(input.jobId)}));child.once('error',error=>{spawnFailure=true;output+='\nCheck process unavailable: '+error.message;});
   return{accepted:true};
  },
  async cancel({jobId}){const child=active.get(jobId),completion=completions.get(jobId);if(child)child.kill('SIGTERM');if(completion)await completion;return{accepted:Boolean(child),reason:child?undefined:'No active demo check'};}
 };
}
