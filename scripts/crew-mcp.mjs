// A deliberate CLI client of the existing stdio MCP adapter. No model calls,
// credential printing, global registration or automatic message generation.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const usage='npm run agent -- [--pretty|--raw] CONFIG list | TOOL [JSON]';
const safeCode=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value)?value:undefined;

/** Keep server error codes, never arbitrary exception strings or data. */
export function cliFailure(error,phase='call'){
 let detail=error?.data;
 if(typeof detail==='string'){try{detail=JSON.parse(detail);}catch{detail=undefined;}}
 if(!safeCode(detail?.error?.code)&&!safeCode(detail?.code)&&typeof error?.message==='string'){
  try{detail=JSON.parse(error.message.replace(/^MCP error -?\d+:\s*/,''));}catch{/* no raw message echo */}
 }
 const serverCode=safeCode(detail?.error?.code)??safeCode(detail?.code);
 const rpcCode=Number.isInteger(error?.code)?error.code:undefined;
 const code=serverCode??(rpcCode===-32602?'invalid_tool_arguments':rpcCode===-32601?'unknown_tool':phase==='connect'?'connection_unavailable':'mcp_call_failed');
 const messages={
  access_unavailable:'Scoped access is expired, revoked or invalid. Restore approved access before calling again.',
  permission_denied:'This connection does not permit the requested operation.',
  forbidden:'This connection does not permit the requested operation.',
  unreachable:'Together is unreachable. Check that it is running, then re-run agent:setup after a restart.',
  connection_unavailable:'Could not open the scoped MCP connection. Check the private config, credential-file permissions and running Together instance.',
  invalid_tool_arguments:'The MCP server rejected the tool arguments. Use list to inspect the tool schema.',
  unknown_tool:'The MCP server does not expose that tool on this connection. Use list to inspect available tools.',
 };
 return {error:{code,message:messages[code]??'The scoped MCP call failed or was refused. Check the returned code and current project state before a deliberate retry.',...(rpcCode!==undefined?{rpcCode}:{}),automaticRetry:false}};
}

export function displayResult(result,pretty=false){
 if(pretty&&result?.content?.length===1&&result.content[0].type==='text'){
  try{return JSON.stringify(JSON.parse(result.content[0].text),null,2);}catch{/* keep non-JSON content intact */}
 }
 return JSON.stringify(result,null,2);
}

export async function runAgentCLI(argv,options={}){
 const out=options.out??(value=>console.log(value)),err=options.err??(value=>console.error(value));
 const args=[...argv];let pretty=false;
 if(args[0]==='--pretty'||args[0]==='--raw')pretty=args.shift()==='--pretty';
 if(args[0]==='--help'){out(usage);return 0;}
 const [config,tool,...rest]=args;
 if(!config||!tool){err(JSON.stringify({error:{code:'cli_usage',message:'Use: '+usage,automaticRetry:false}}));return 1;}
 let argumentsValue={};
 if(tool!=='list'&&rest.length){
  try{argumentsValue=JSON.parse(rest.join(' '));}
  catch{err(JSON.stringify({error:{code:'invalid_json_arguments',message:'Tool arguments must be valid JSON. Quote the entire JSON object as one shell argument.',automaticRetry:false}}));return 1;}
  if(!argumentsValue||typeof argumentsValue!=='object'||Array.isArray(argumentsValue)){
   err(JSON.stringify({error:{code:'invalid_tool_arguments',message:'Tool arguments must be a JSON object.',automaticRetry:false}}));return 1;
  }
 }
 const client=options.client??new Client({name:'together-original-session-cli',version:'1.0.0'},{capabilities:{}});
 const transport=options.transport??new StdioClientTransport({command:process.execPath,args:[resolve(root,'dist/mcp/together-byo.mjs'),resolve(config)],env:{PATH:process.env.PATH??'/usr/bin:/bin'},stderr:'pipe'});
 let phase='connect',code=0;
 try{
  await client.connect(transport);phase='call';
  const result=tool==='list'?await client.listTools():await client.callTool({name:tool,arguments:argumentsValue});
  out(displayResult(result,pretty));
  if(result.isError)code=1;
 }catch(error){err(JSON.stringify(cliFailure(error,phase)));code=1;}
 finally{try{await client.close();}catch{err(JSON.stringify({error:{code:'transport_close_failed',message:'The MCP transport did not close cleanly. Any returned call result is unchanged; no call was repeated.',automaticRetry:false}}));code=1;}}
 return code;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runAgentCLI(process.argv.slice(2));
