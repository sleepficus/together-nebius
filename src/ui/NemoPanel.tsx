import {useEffect,useState} from 'react';
import {chatApi} from './Conversation.tsx';
import type {UIController} from './Shell.tsx';

/** Same live project conversation, task, change and check records. */
export function NemoPanel({controller}:{controller:UIController}){
 const [selectedTask,setSelectedTask]=useState('');
 const [state,setState]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const pid=controller.activeProjectId;
 const load=async()=>{setState(await chatApi(pid,'nemo'));};
 useEffect(()=>{
  setState(undefined);setError('');if(controller.mode!=='live')return;
  let ended=false,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const value=await chatApi(pid,'nemo');if(!ended){setState(value);}}catch(e){if(!ended&&(e as any).status!==404)setError((e as Error).message);}if(!ended)timer=setTimeout(poll,2500);};
  void poll();return()=>{ended=true;clearTimeout(timer);};
 },[controller.mode,pid]);
 if(controller.mode!=='live'||(!state&&!error))return null;
 async function command(action:string,body:unknown={}){setBusy(true);setError('');try{await chatApi(pid,'nemo/'+action,body);await load();await controller.action('refresh');}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const active=Boolean(state?.activeRunId),codingAttempt=state?.runs?.some((r:any)=>r.kind==='code');
 const base='/api/v1/projects/'+encodeURIComponent(pid)+'/nemo';
 return <details className="nemo-panel" aria-label="Optional NVIDIA Nemotron demo" open={Boolean(state?.configured||state?.connected)}><summary>Optional NVIDIA Nemotron coding demo</summary>
  <div className="nemo-heading"><span aria-hidden className="nemo-fish">✦</span><div><h2>NVIDIA Nemotron</h2><p>Local Together runtime · NVIDIA Nano inference through Nebius</p></div><span className="nemo-state">{active?'Working':state?.connected?'Profile ready · starts when asked':'Not connected'}</span></div>
  <p className="nemo-intro">{state?.connected?'Say hello below.':'Connect NVIDIA Nemotron first, then say hello below.'} Then ask Nemotron to reply, or give him one small coding job. You can inspect the change and the actual check output before deciding what comes next.</p>
  {!state?.configured&&<p className="nemo-note">The server needs <code>NEBIUS_API_KEY</code> or <code>NEBIUS_API_KEY_FILE</code>. Add it to your private <code>.env</code> and restart. The browser never receives the key.</p>}
  <p className="nemo-note">One reply can use multiple model requests for its agent steps. The usage counter counts model calls, not clicks or replies.</p>
  <div className="nemo-actions">
   {!state?.connected&&<button disabled={busy||active} onClick={()=>void command('connect')}>Connect NVIDIA Nemotron · no inference</button>}
   <button disabled={busy||active||!state?.configured||!state?.connected||Boolean(state?.budget.halt)} onClick={()=>void command('run',{kind:'hello'})}>Ask Nemotron to reply</button>
   <label>Implementation task <select aria-label="Implementation task" value={selectedTask} disabled={active||codingAttempt} onChange={e=>setSelectedTask(e.target.value)}><option value="">Choose a real shared task</option>{state?.tasks?.filter((t:any)=>t.lifecycle!=='done').map((t:any)=><option key={t.id} value={t.id}>{t.goal}</option>)}</select></label>
   <button disabled={busy||active||!state?.configured||!state?.connected||codingAttempt||!selectedTask||Boolean(state?.budget.halt)} onClick={()=>void command('run',{kind:'code',taskId:selectedTask})}>Start the selected coding task</button>
   {active&&<button className="nemo-stop" disabled={busy} onClick={()=>void command('cancel')}>Stop Nemotron</button>}
  </div>
  <small className="nemo-budget">{state?.budget.calls??0}/{state?.budget.maxCalls??12} development requests · estimated ${(state?.budget.estimatedUsd??0).toFixed(5)} · ${state?.budget.ceilingUsd?.toFixed(2)??'0.05'} ceiling · no inference while idle</small>
  {state?.budget.halt&&<p role="alert">{state.budget.halt}</p>}{error&&<p role="alert">{error}</p>}
  {state?.runs?.map((run:any)=><details className="nemo-run" key={run.id} open={run.status==='running'||Boolean(run.check)}>
   <summary>{run.kind==='hello'?'Greeting':'Check-summary coding demonstration'} · {run.delivery&&run.status==='failed'?'Reply saved · initial delivery failure retained':run.status==='completed'?(run.kind==='code'?'Checked · awaiting human inspection':'Reply saved'):run.status}</summary>
   <p>Run <code>{run.id}</code> · {new Date(run.startedAt).toLocaleString()}</p>
   {run.error&&<p role="alert">{run.error}</p>}
   {run.delivery&&<p>Delivered from Nemotron’s saved final response, unchanged. {run.delivery.additionalInferenceRequests} extra inference calls.</p>}
   {run.savedResponseRecoverable&&!run.delivery&&<button disabled={busy||active} onClick={()=>void command('deliver-saved',{runId:run.id})}>Save Nemotron’s returned reply · no new inference</button>}
   {run.knownToolFailureResumable&&<button disabled={busy||active} onClick={()=>void command('resume-tool-error',{runId:run.id})}>Continue with the recorded tool error</button>}
   {run.transportFailureResumable&&<><p>The first request outcome is unknown and its usage stays reserved. One explicit continuation keeps this greeting and its history; its first request gets a 180-second deadline.</p><button disabled={busy||active} onClick={()=>void command('continue-transport',{runId:run.id,acknowledgeUnknownCharge:true})}>Continue this greeting · prior request stays counted</button></>}
   {run.initialTransportFailure&&<p>Continued the same greeting after an unknown transport outcome. Request {run.initialTransportFailure.requestNumber} and its usage remain recorded; no allowance was reset.</p>}
   {run.initialFailure&&<p>Continued the same task after the recorded tool error: {run.initialFailure.error}. Earlier failure and usage are retained.</p>}
   {run.check&&<div className="nemo-check"><strong>{run.check.outcome==='pass'?'Fixed check passed':`Check: ${run.check.outcome}`}</strong><p><code>{run.check.command}</code></p><p>Candidate <code>{run.check.candidateSha}</code></p><small>This is test evidence. Independent review and integration are still separate.</small><details><summary>Read the actual test output</summary><pre>{run.check.output}</pre><a href={base+'/output/'+run.checkId} download>Download this exact output</a></details></div>}
   {run.patch&&<details><summary>Inspect Nemotron’s exact patch</summary><pre>{run.patch}</pre><a href={base+'/patch/'+run.id} download>Download this exact patch</a></details>}
   {run.taskId&&<p>Task <code>{run.taskId}</code>{run.proposalId&&<> · change <code>{run.proposalId}</code></>}</p>}
   <details><summary>Actions and usage</summary><ol>{run.events.map((event:any,i:number)=><li key={i}><span>{new Date(event.at).toLocaleTimeString()} · </span>{event.kind==='tool'?<><strong>{event.data.name}</strong>{event.data.result?.file&&<> · {event.data.result.file}</>}</>:event.kind==='inference'?<>Nebius request {event.data.request} · {event.data.usage?.total_tokens??'Unknown'} tokens · reported model {event.data.model}</>:event.kind==='task-assigned'?'Task assigned to Nemotron':event.data.error??event.kind}</li>)}</ol></details>
  </details>)}
 </details>;
}
