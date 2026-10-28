// Explicit local onboarding over the existing scoped enrollment protocol.
// No global MCP registration, provider calls or generated agent dialogue.
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {WORK_SCOPES} from '../adapters/work-tools.ts';
import {readByoConfig,byoClient,byoRegistration} from '../adapters/byo-config.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function expiryInfo(value,reused=false){
 const known=typeof value==='string'&&Number.isFinite(Date.parse(value));
 return {expiresAt:known?value:'unknown',expiryStatus:known?(reused?'cached-enrollment-value':'enrollment-response'):'unknown',
  expiryNote:reused?(known?'Cached from enrollment; reusing this connection does not renew it.':'The existing expiry was not cached; reusing this connection does not renew it.'):
   (known?'Expiry returned by enrollment.':'Enrollment did not report an expiry.')};
}
export function setupFailure(error){
 const message=typeof error?.message==='string'?error.message:'';
 const known=[
  'Choose --name with 1–80 characters','Use host codex/claude/other, profile chat/work, and days 1–30',
  'Expected an owned private regular file','Start Together with npm start before setting up an agent',
  'Local connection metadata must name a loopback HTTP origin',
  'The existing connection is expired, revoked or unavailable; it was not replaced',
  'A prior setup was interrupted. Its operation record is retained; no duplicate identity was created',
  'Use --help for setup options',
 ];
 const server=message.match(/^Setup ([1-5]\d\d): ([a-z][a-z0-9_]{0,63})$/);
 return {error:{code:server?.[2]??(error instanceof SyntaxError?'invalid_setup_metadata':known.includes(message)?'setup_refused':'setup_unavailable'),
  message:server?'Setup request was refused. Check the returned server code; uncertain enrollment is retained and was not repeated.':known.includes(message)?message:
   error instanceof SyntaxError?'Local setup metadata is not valid JSON. Check the private local setup files.':'Setup could not finish. Check that Together is running and its local setup files are owned and private. Any pending enrollment is retained; no automatic retry.',
  ...(server?{status:Number(server[1])}:{}),automaticRetry:false}};
}
export async function setupAgent(options){
 const {name,host='other',profile='work',days=30}=options;
 if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('Choose --name with 1–80 characters');
 if(!['codex','claude','other'].includes(host)||!['chat','work'].includes(profile)||!Number.isInteger(days)||days<1||days>30)throw Error('Use host codex/claude/other, profile chat/work, and days 1–30');
 const stateDir=resolve(options.stateDir??process.env.TOGETHER_STATE_DIR??join(root,'.runtime/local'));
 const privateRead=path=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o600||(process.getuid&&s.uid!==process.getuid()))throw Error('Expected an owned private regular file');return readFileSync(path,'utf8');};
 const lock=JSON.parse(privateRead(join(stateDir,'app.lock')));
 if(!lock.apiOrigin||!lock.projectId)throw Error('Start Together with npm start before setting up an agent');
 const url=new URL(lock.apiOrigin);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Local connection metadata must name a loopback HTTP origin');
 const directory=join(stateDir,'agents');mkdirSync(directory,{recursive:true,mode:0o700});
 const key=createHash('sha256').update(name+'\0'+host+'\0'+profile).digest('hex').slice(0,16),configPath=join(directory,key+'.json');
 if(existsSync(configPath)){
  const saved=JSON.parse(privateRead(configPath)),config=readByoConfig(configPath),client=byoClient({...config,baseUrl:url.origin});
  const current=await client.workRequest('GET','/work-context');
  if(!current.ok)throw Error('The existing connection is expired, revoked or unavailable; it was not replaced');
  writeFileSync(configPath,JSON.stringify({...saved,baseUrl:url.origin},null,2)+'\n',{mode:0o600});
  return {reused:true,configPath,workspaceDir:join(stateDir,'nemo-workspace'),identityId:saved.identityId,sessionId:saved.sessionId,profile,...expiryInfo(saved.expiresAt,true),registration:host==='other'?undefined:byoRegistration(host,configPath)};
 }
 const pending=join(directory,key+'.pending');if(existsSync(pending))throw Error('A prior setup was interrupted. Its operation record is retained; no duplicate identity was created');
 const owner=privateRead(join(stateDir,'owner-token')).trim(),op=randomUUID();
 async function api(path,body,token=owner){const response=await fetch(url.origin+'/api/v1/projects/'+encodeURIComponent(lock.projectId)+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});const value=await response.json();if(!response.ok)throw Error('Setup '+response.status+': '+(value.error?.code??'request_failed'));return value;}
 await api('/conversations',undefined);
 // Preflight/channel preparation is safe to repeat. From this point onward,
 // uncertain identity/enrollment effects retain the marker and fail closed.
 writeFileSync(pending,JSON.stringify({operationId:op,name,host,profile})+'\n',{flag:'wx',mode:0o600});
 const identity=await api('/identities',{operationId:op,displayName:name,creationSource:'local-agent-setup'});
 const scopes=profile==='work'?[...WORK_SCOPES]:['read','conversation:read','conversation:write'];
 const expiresAt=new Date(Date.now()+days*86400000).toISOString();
 const invite=await api('/identities/'+identity.identity.id+'/invitations',{operationId:randomUUID(),scopes,credentialExpiresAt:expiresAt});
 const enrolled=await api('/enrollment/exchange',{operationId:randomUUID(),adapter:'together-byo-mcp',model:'unknown',provider:'unknown',harness:host,host:'local'},invite.token);
 await api('/presentation',{identityId:enrolled.identityId,sessionId:enrolled.sessionId,name,mode:'persona',summary:'Project runtime helper',runtimeLabel:host+' · MCP',requestedModel:'unknown'});
 const credentialFile=join(directory,key+'.token');writeFileSync(credentialFile,enrolled.token+'\n',{flag:'wx',mode:0o600});
 const expiry=expiryInfo(enrolled.expiresAt);
 writeFileSync(configPath,JSON.stringify({baseUrl:url.origin,projectId:lock.projectId,profile,credentialFile,identityId:enrolled.identityId,sessionId:enrolled.sessionId,...(expiry.expiryStatus!=='unknown'?{expiresAt:expiry.expiresAt}:{})},null,2)+'\n',{flag:'wx',mode:0o600});
 return {reused:false,configPath,workspaceDir:join(stateDir,'nemo-workspace'),identityId:enrolled.identityId,sessionId:enrolled.sessionId,profile,...expiry,registration:host==='other'?undefined:byoRegistration(host,configPath)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const argv=process.argv.slice(2),options={};
  if(argv.includes('--help'))console.log('npm run agent:setup -- --name "Your agent" [--host codex|claude|other] [--profile work|chat] [--days 30] [--state-dir PATH]');
  else{for(let i=0;i<argv.length;i++){const key={'--name':'name','--host':'host','--profile':'profile','--days':'days','--state-dir':'stateDir'}[argv[i]];if(!key||!argv[i+1])throw Error('Use --help for setup options');options[key]=key==='days'?Number(argv[++i]):argv[++i];}console.log(JSON.stringify(await setupAgent(options),null,2));}
 }catch(error){console.error(JSON.stringify(setupFailure(error)));process.exitCode=1;}
}
