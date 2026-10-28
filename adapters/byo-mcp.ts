import {WORK_TOOL_NAMES} from './work-tools.ts';
import {pathToFileURL} from 'node:url';
import {byoClient,readByoConfig,BYO_TOOLS} from './byo-config.ts';
import {main} from './mcp.ts';

export async function startByo(configPath:string):Promise<number> {
  if(!configPath)throw new Error('An approved private Together config file is required');
  const config=readByoConfig(configPath);return main(byoClient(config),config.profile==='work'?[...BYO_TOOLS,...WORK_TOOL_NAMES]:BYO_TOOLS);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  startByo(process.argv[2]).then(code=>{process.exitCode=code}).catch(()=>{
    // Configuration text, token contents and remote error bodies stay private.
    process.stderr.write('Together BYO MCP stopped: check private configuration, endpoint and scoped access.\n');
    process.exitCode=1;
  });
}
