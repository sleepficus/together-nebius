import worker,{DirectoryObject,SessionObject,ProjectObject,ExecutionObject} from './worker.ts';
import {resolveOwner} from './sessions.ts';
import {remoteOAuthProvider} from './remote-oauth.ts';
export {DirectoryObject,SessionObject,ProjectObject,ExecutionObject};
export default {async fetch(request:Request,env:any,ctx:any){
 const path=new URL(request.url).pathname;
 if(!['/mcp','/authorize','/oauth/token','/oauth/register','/oauth/revoke'].includes(path)&&!path.startsWith('/.well-known/'))return worker.fetch(request,env);
 if(env.TOGETHER_REMOTE_MCP_ENABLED!=='true')return new Response('Remote Together MCP is not activated',{status:503});
 if(!env.MCP_INGRESS_LIMITER||!(await env.MCP_INGRESS_LIMITER.limit({key:request.headers.get('cf-connecting-ip')??'local-ingress'})).success)return new Response('Ingress rate limited or limiter unavailable',{status:429});
 if(request.body){const reader=request.body.getReader();let total=0;const chunks:Uint8Array[]=[];for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>32768){await reader.cancel();return new Response('Request too large',{status:413})}chunks.push(value);}const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}request=new Request(request.url,{method:request.method,headers:request.headers,body:bytes});}
 const declared=Number(request.headers.get('content-length'));if(declared>32768)return new Response('Request too large',{status:413});
 if(!env.PUBLIC_ORIGIN||new URL(request.url).origin!==env.PUBLIC_ORIGIN)return new Response('Resource origin mismatch',{status:400});
 const provider=remoteOAuthProvider(env.PUBLIC_ORIGIN,{
  resolveOwner,
  ownerSetup:async(r,e,projectId)=>{const u=new URL(r.url);u.pathname=`/api/v1/projects/${encodeURIComponent(projectId)}/connection-setup`;u.search='';const response=await worker.fetch(new Request(u,{headers:{cookie:r.headers.get('cookie')??''}}),e);if(!response.ok)throw Error('Owner project access required');return response.json();},
  apiFetch:async(r,e,p)=>{
   const u=new URL(r.url);const prefix=`/api/v1/projects/${encodeURIComponent(p.projectId)}`;if(!u.pathname.startsWith(prefix+'/')&&u.pathname!==prefix)return new Response('Wrong project',{status:403});
   u.pathname='/internal/v1/mcp/'+encodeURIComponent(p.projectId)+u.pathname.slice(prefix.length);
   const h=new Headers(r.headers);h.delete('authorization');h.delete('cookie');h.set('x-together-internal-oauth',JSON.stringify(p));
   return e.PROJECT_OBJECT.get(e.PROJECT_OBJECT.idFromName(p.projectId)).fetch(new Request(u,{method:r.method,headers:h,...(r.method==='GET'?{}:{body:await r.text()})}));
  },fallback:(r,e)=>worker.fetch(r,e)
 });return provider.fetch(request,env,ctx);
}};
