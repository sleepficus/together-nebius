import {pathToFileURL} from 'node:url';
import {byoClient,readByoConfig} from './byo-config.ts';
import type {TogetherClient} from './client.ts';
/** Disabled unless explicitly invoked with an owner-created arm. No host hooks installed. */
export async function watchAttention(client:Pick<TogetherClient,'attention'|'attentionHeartbeat'|'attentionStop'>,options:{armId:string;mode:'once'|'stream';seconds:number;write:(line:string)=>void;now?:()=>number;sleep?:(ms:number)=>Promise<void>;signal?:AbortSignal}){
 if(!Number.isInteger(options.seconds)||options.seconds<1||options.seconds>1800)throw Error('Bounded watch requires1–1800 seconds');
 const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(r=>setTimeout(r,ms))),end=now()+options.seconds*1000;
 let reason='expired';
 try{while(now()<end&&!options.signal?.aborted){
  const beat=await client.attentionHeartbeat(options.armId);if(!beat.ok){reason='access-or-arm-unavailable';break;}
  const r=await client.attention(options.armId);if(!r.ok){reason='access-or-arm-unavailable';break;}
  const refs=Array.isArray(r.body.references)?r.body.references as any[]:[];
  if(refs.length){options.write(JSON.stringify({kind:'attention',count:refs.length,references:refs.map(x=>({seq:x.seq,channel:x.channel,senderKind:x.senderKind,reason:x.reason}))}));}
  const ack=await client.attentionHeartbeat(options.armId,Number(r.body.nextCursor));if(!ack.ok){reason='acknowledgement-unconfirmed';break;}
  if(r.body.resyncRequired){options.write(JSON.stringify({kind:'resync-required',message:'Read current authorized channels; older references are unavailable.'}));reason='resync-required';break;}
  if(refs.length&&options.mode==='once'){reason='delivered';break;}await sleep(Math.min(5000,Math.max(0,end-now())));
 }}finally{await client.attentionStop(options.armId).catch(()=>undefined);options.write(JSON.stringify({kind:'watch-ended',reason:options.signal?.aborted?'stopped':reason}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [config,armId,mode,seconds]=process.argv.slice(2);
 if(!config||!armId||!['once','stream'].includes(mode)){process.stderr.write('Usage: doorbell PRIVATE_CONFIG OWNER_ARM_ID once|stream SECONDS; activation requires approval\n');process.exitCode=1;}else{
 const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
 try{await watchAttention(byoClient(readByoConfig(config)),{armId,mode:mode as 'once'|'stream',seconds:Number(seconds),signal:stop.signal,write:line=>process.stdout.write(line+'\n')});}catch{process.stderr.write('Watch unavailable; check approved configuration and arm.\n');process.exitCode=1;}
 }
}
