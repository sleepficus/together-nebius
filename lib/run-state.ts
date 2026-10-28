import type {Entity,ProjectState} from './types.ts';
export interface PlanRevision extends Entity {digest:string;tasks:{key:string;goal:string;acceptanceCriteria:string[]}[];sourceMessage?:{id:string;digest:string};}
export type RunStatus='draft'|'starting'|'running'|'paused'|'stopping'|'stopped'|'completed'|'failed'|'unconfirmed';
export interface WorkRun extends Entity {status:RunStatus;epoch:number;planRevisionId:string;planDigest:string;identityId?:string;sessionId?:string;heartbeatAt?:string;availableSince?:string;waitingOnCheck?:boolean;activeTurnId?:string;responseModel?:string;jobId?:string;startOperationId?:string;priorPhase?:string;reconciliationTarget?:string;}
export interface RuntimeIntent {key:string;projectId:string;action:'runtime.start'|'runtime.status'|'runtime.deliver'|'runtime.stop';payload:Record<string,unknown>;consequential:boolean;deadlineAt:string;}
export interface RuntimeBinding {allowances:{draft:number;run:number;lounge:number;hourlyLounge:number};enqueue(input:RuntimeIntent):Promise<{id:string;status:string;result?:Record<string,unknown>}>;status?(jobId:string):Promise<{status:string;result?:Record<string,unknown>}>;}
export function revokeRun(state:ProjectState,run:WorkRun,now:string){run.epoch++;run.status='stopping';run.updatedAt=now;for(const c of Object.values(state.credentials))if(c.runId===run.id)c.status='revoked';}
export function stopAllRuns(state:ProjectState,now:string){for(const r of Object.values(state.runs??{}))if(!['stopped','completed','failed'].includes(r.status))revokeRun(state,r,now);}
