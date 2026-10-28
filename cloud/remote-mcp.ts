import {WORK_TOOL_NAMES} from '../adapters/work-tools.ts';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {TogetherClient} from '../adapters/client.ts';
import {handleRpc,INSTRUCTIONS} from '../adapters/mcp.ts';
// Keep this allowlist portable: byo-config imports Node secret-loading helpers.
export const REMOTE_TOOLS=['together_status','together_context_brief','together_brief','together_conversations','together_read_messages','together_post_message','together_opened','together_handoff'] as const;
export {consentPrincipal} from './remote-principal.ts';
import type {RemoteConsent} from './remote-principal.ts';
export type {RemoteConsent} from './remote-principal.ts';
export async function remoteMcpRequest(request:Request,options:{origin:string;consent:RemoteConsent;apiFetch:(request:Request,consent:RemoteConsent)=>Promise<Response>;allowOrigin?:string[]}){
 const url=new URL(request.url);if(url.origin!==options.origin||url.pathname!=='/mcp')return new Response('Unknown MCP resource',{status:404});
 const origin=request.headers.get('origin');if(origin&&origin!==options.origin&&!options.allowOrigin?.includes(origin))return new Response('Origin refused',{status:403});
 if(request.method!=='POST')return new Response('Only stateless Streamable HTTP POST is supported',{status:405,headers:{Allow:'POST'}});
 if(!request.headers.get('content-type')?.startsWith('application/json'))return new Response('JSON required',{status:415});
 const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();return new Response('Request too large',{status:413})}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 let body:any;try{body=JSON.parse(new TextDecoder().decode(bytes))}catch{return new Response('Invalid JSON',{status:400})}
 const allowedTools=options.consent.workProfile?[...REMOTE_TOOLS,...WORK_TOOL_NAMES]:REMOTE_TOOLS;
 const client=new TogetherClient({baseUrl:options.origin,projectId:options.consent.projectId,token:crypto.randomUUID(),fetchFn:async(url,init)=>{
  const req=new Request(url,init),headers=new Headers(req.headers);headers.delete('authorization');headers.delete('cookie');
  return options.apiFetch(new Request(req,{headers}),options.consent);
 }});
 const bearer=request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
 const redact=(v:any)=>bearer?JSON.parse(JSON.stringify(v).split(bearer).join('[credential redacted]')):v;
 const server=new Server({name:'together-remote',version:'0.1.0'},{capabilities:{tools:{}},instructions:INSTRUCTIONS});
 server.setRequestHandler(ListToolsRequestSchema,async()=>{const r:any=await handleRpc(client,{jsonrpc:'2.0',id:1,method:'tools/list'},allowedTools);return r.result;});
 server.setRequestHandler(CallToolRequestSchema,async req=>{const r:any=await handleRpc(client,{jsonrpc:'2.0',id:1,method:'tools/call',params:req.params},allowedTools);return redact(r.result??{isError:true,content:[{type:'text',text:'Tool is not allowed'}]});});
 const transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true,sessionIdGenerator:undefined});await server.connect(transport);
 try{return await transport.handleRequest(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(body)}),{parsedBody:body});}finally{await server.close();}
}
