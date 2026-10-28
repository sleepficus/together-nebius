import {WORK_TOOL_NAMES} from './work-tools.ts';
import {readFileSync, lstatSync} from 'node:fs';
import {isAbsolute, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TogetherClient} from './client.ts';
import {execFileSync} from 'node:child_process';

export const BYO_TOOLS = ['together_status','together_context_brief','together_brief','together_conversations','together_read_messages','together_post_message','together_opened','together_handoff'] as const;
export interface ByoConfig {baseUrl:string; projectId:string; profile?:'chat'|'work'; credentialFile?:string; credentialCommand?:{command:string;args:string[]}}

function privateFile(path:string):string {
  if(!isAbsolute(path))throw new Error('Together config and credential paths must be absolute');
  const stat=lstatSync(path);
  if(!stat.isFile()||(stat.mode&0o777)!==0o600||(process.getuid&&stat.uid!==process.getuid()))throw new Error('Together config and credential files must be private regular files owned by this user (mode 0600)');
  if(stat.size>4096)throw new Error('Together config or credential file exceeds 4 KB');
  return readFileSync(path,'utf8');
}

export function readByoConfig(path:string):ByoConfig {
  const c=JSON.parse(privateFile(path));
  if(typeof c.baseUrl!=='string'||typeof c.projectId!=='string'||!c.projectId)throw new Error('Together config requires baseUrl and projectId');
  if(c.profile!==undefined&&!['chat','work'].includes(c.profile))throw new Error('profile must be chat or work');
  const file=typeof c.credentialFile==='string'&&isAbsolute(c.credentialFile);
  const command=c.credentialCommand&&typeof c.credentialCommand.command==='string'&&isAbsolute(c.credentialCommand.command)&&Array.isArray(c.credentialCommand.args)&&c.credentialCommand.args.every((a:unknown)=>typeof a==='string');
  if(Boolean(file)===Boolean(command))throw new Error('Specify exactly one absolute credentialFile or credentialCommand with string args');
  const u=new URL(c.baseUrl);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||(u.protocol!=='https:'&&!(u.protocol==='http:'&&loopback)))throw new Error('Together baseUrl must be an HTTPS origin or loopback HTTP origin without credentials, query or fragment');
  return {baseUrl:u.origin,projectId:c.projectId,profile:c.profile??'chat',...(file?{credentialFile:c.credentialFile}:{credentialCommand:c.credentialCommand})};
}

export function byoClient(config:ByoConfig):TogetherClient {
  // Approved config owns the command. No shell evaluation or inherited provider credentials.
  const readCredential=()=>{
    let raw:string;
    try {raw=config.credentialFile?privateFile(config.credentialFile):execFileSync(config.credentialCommand!.command,config.credentialCommand!.args,{encoding:'utf8',timeout:5000,maxBuffer:4096,stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin'}})}
    catch {throw new Error('Together credential source unavailable; check private regular files or approved credential command')}
    const token=raw.trim();
    if(!token||/\s/.test(token))throw new Error('Together credential file must contain one scoped token');
    return token;
  };
  const token=readCredential(),seenCredentials=new Set([token]);
  const instanceId=crypto.randomUUID();
  const client=new TogetherClient({...config,token,redact:text=>{
    for(const credential of seenCredentials)text=text.replaceAll(credential,'[credential redacted]');
    return text;
  },fetchFn:async(url,init)=>{
    // Each deliberate tool call rechecks the approved source. Never replay a
    // write or permanently cache denial: renewal recovers on the next call,
    // while actual server-side revocation continues to deny every request.
    const current=readCredential();seenCredentials.add(current);client.config.token=current;
    const headers=new Headers(init?.headers);headers.set('authorization','Bearer '+current);headers.set('x-together-adapter-instance',instanceId);
    const response=await fetch(url,{...init,headers,redirect:'error',signal:AbortSignal.timeout(15_000)});
    if(response.status===401)return Response.json({error:{code:'access_unavailable',message:'Together access is expired, revoked or invalid. After approved access is restored, your next deliberate call reconnects this same session.',retryable:false}},{status:401});
    return response;
  }});
  return client;
}

/** Prints registration data only: never registers a server or reads its token. */
export function byoRegistration(client:'codex'|'claude',configPath:string) {
  const config=readByoConfig(configPath);
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const command={command:process.execPath,args:[resolve(root,'dist/mcp/together-byo.mjs'),configPath],cwd:root};
  return client==='codex'?{mcp_servers:{together_byo:{...command,enabled_tools:config.profile==='work'?[...BYO_TOOLS,...WORK_TOOL_NAMES]:[...BYO_TOOLS],default_tools_approval_mode:'writes',startup_timeout_sec:30}}}:{mcpServers:{together_byo:{type:'stdio',command:command.command,args:command.args}}};
}
