import {enqueueExecution,waitExecution} from './execution.ts';
import type {CloudEnv} from './phase04-contract.ts';
import type {RuntimeBinding} from '../lib/run-state.ts';
/** Server-only seam. Production remains unconfigured until a native path is proven. */
export function createRuntimeBinding(env:CloudEnv,projectId:string,proof:{proven:boolean;allowances:RuntimeBinding['allowances']}):RuntimeBinding|undefined{
 if(!proof.proven)return undefined;
 const tokens=[env.RUNTIME_BRIDGE_TOKEN,env.GIT_BRIDGE_TOKEN,env.CHECK_BRIDGE_TOKEN].filter(x=>typeof x==='string'&&x!=='');
 if(!env.RUNTIME_BRIDGE_TOKEN||new Set(tokens).size!==tokens.length||!String(env.RUNTIME_BRIDGE_PROJECT_IDS??'').split(',').map(s=>s.trim()).includes(projectId))throw new Error('Distinct runtime purpose and exact project allowlist required');
 if(Object.values(proof.allowances).some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('Finite nonnegative call ceilings required');
 return{allowances:{...proof.allowances},enqueue:input=>{if(input.projectId!==projectId)throw new Error('Runtime project mismatch');return enqueueExecution(env,{...input,role:'runtime'});},status:jobId=>waitExecution(env,projectId,jobId,1)};
}
