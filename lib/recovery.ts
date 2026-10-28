import {digestOf,fail,json,requireScope} from './core.ts';import {exportProject,validateExportDocument} from './events.ts';import {currentMember,requireConversation} from './conversation.ts';import type {Context,ProjectState} from './types.ts';
export async function handleRecovery(ctx:Context,req:Request,parts:string[]):Promise<Response|null>{
 if(parts[0]!=='recovery-backup'||parts.length!==1||req.method!=='GET')return null;
 const state=await ctx.store.read();requireScope(ctx.principal,'owner',state);currentMember(state,ctx.principal);if(ctx.principal.kind!=='human'||ctx.principal.id!==ctx.principal.ownerId)fail(403,'owner_only','Owner private recovery only');
 const selected=new URL(req.url).searchParams.getAll('channel');const store=requireConversation(ctx),all=store.privateRows();const channels=selected.length?selected:store.list().map(c=>c.id);if(channels.some(id=>!store.conversation(id)))fail(404,'channel','Unknown selected conversation');
 for(const [table,rows] of Object.entries(all))if(['chat_conversations','chat_messages','chat_members','chat_included'].includes(table))all[table]=rows.filter(r=>channels.includes(String(table==='chat_conversations'?r.id:r.conversation_id)));
 // Runtime input bodies can span selected channels. Omit all turn input records; never imply a runnable restore.
 all.chat_turns=[];all.chat_attestations=[];all.chat_invitations=[];all.chat_route_suggestions=[];all.chat_rates=[];
 const payload={format:'together-isolated-recovery-v1',projectId:state.project.id,createdAt:ctx.now(),work:exportProject(state,{now:ctx.now(),exportedBy:ctx.principal.id}),conversationRows:all,selectedChannels:channels,warnings:['No external Git artifacts or host transcripts included','No active credentials, connections, doorbells or dispatch intents will be restored','Runtime inputs and invitations omitted','Platform recovery window and retention policy remain operator-unverified']};
 if((await ctx.store.read()).project.revision!==state.project.revision)fail(409,'backup_changed','Project changed during backup; retry deliberately');return json(200,{...payload,digest:await digestOf(payload)});
}
export async function prepareIsolatedRecovery(archive:any,projectId:string){
 if(!/^[a-zA-Z0-9_-]{1,120}$/.test(projectId))fail(422,'project_id','Unsafe project ID');
 if(!archive||archive.format!=='together-isolated-recovery-v1'||archive.projectId!==projectId)fail(422,'recovery_format','Wrong recovery format/project');const {digest,...payload}=archive;if(await digestOf(payload)!==digest)fail(422,'recovery_digest','Archive integrity check failed');
 const state=validateExportDocument(archive.work,projectId);state.planRevisions=structuredClone(archive.work.state.planRevisions??{});state.runs=structuredClone(archive.work.state.runs??{});
 for(const [id,p] of Object.entries(state.planRevisions))if(p.id!==id||p.projectId!==projectId||!Array.isArray(p.tasks))fail(422,'plan_reference','Invalid plan record');
 if(state.project.adoptedPlanRevisionId&&!state.planRevisions[String(state.project.adoptedPlanRevisionId)])fail(422,'plan_reference','Adopted plan absent');
 for(const task of Object.values(state.tasks)){if(task.dependencies.some(d=>!state.tasks[d.taskId]))fail(422,'task_reference','Dependency absent');if(task.currentAssignmentId&&!state.assignments[task.currentAssignmentId])fail(422,'assignment_reference','Assignment absent');if(task.requiredPlanRevisionId&&!state.planRevisions[String(task.requiredPlanRevisionId)])fail(422,'plan_reference','Task plan absent');}
 for(const a of Object.values(state.assignments))if(!state.tasks[a.taskId]||!state.identities[a.identityId])fail(422,'assignment_reference','Assignment task/member absent');
 for(const run of Object.values(state.runs))if(!state.planRevisions[run.planRevisionId])fail(422,'run_reference','Run plan absent');
 state.project.recoveryUnverified=true;state.credentials={};state.invitations={};for(const op of Object.values(state.operations)){op.importedUnverified=true;op.effect='unknown';}state.stopped=true;
 for(const session of Object.values(state.sessions)){session.status='ended';session.importedUnverified=true;}
 for(const a of Object.values(state.assignments)){a.status='stopped';a.epoch++;a.importedUnverified=true;}
 for(const r of Object.values(state.runs)){r.status='stopped';r.epoch++;delete r.startOperationId;delete r.activeTurnId;r.importedUnverified=true;}
 for(const r of Object.values(state.receipts))r.importedUnverified=true;
 for(const r of Object.values(state.reviews)){r.independent=false;r.importedUnverified=true;}
 for(const j of Object.values(state.jobs)){j.status='blocked';j.importedUnverified=true;}
 for(const c of Object.values(state.candidates)){c.status='prepared';c.importedUnverified=true;}
 for(const f of Object.values(state.findings)){f.importedState=f.state;f.state='possible-issue';f.importedUnverified=true;}
 for(const t of Object.values(state.tasks))t.importedUnverified=true;
 const rows=structuredClone(archive.conversationRows);rows.chat_turns=[];rows.chat_attestations=[];rows.chat_invitations=[];rows.chat_route_suggestions=[];rows.chat_rates=[];
 // Validate sequence, channel references and frozen sender identity before touching a destination.
 const channels=new Set((rows.chat_conversations??[]).map((r:any)=>r.id));const positions=new Map<string,Set<number>>();
 for(const r of rows.chat_messages??[]){let m:any;try{m=JSON.parse(r.body)}catch{fail(422,'conversation_record','Invalid conversation JSON')};if(!channels.has(r.conversation_id)||m.id!==r.id||m.conversationId!==r.conversation_id||m.seq!==r.seq||m.sender?.id!==r.sender_id||!Number.isInteger(m.seq)||m.seq<1)fail(422,'conversation_reference','Message identity/sequence mismatch');const seen=positions.get(r.conversation_id)??new Set();if(seen.has(m.seq))fail(422,'conversation_order','Duplicate sequence');seen.add(m.seq);positions.set(r.conversation_id,seen);}
 for(const r of rows.chat_members??[])if(!channels.has(r.conversation_id))fail(422,'conversation_reference','Cursor channel absent');
 return {state,rows,warnings:archive.warnings};
}
