import {useEffect,useState} from 'react';
import type {UIController} from './Shell.tsx';
/** Reads the same task/assignment records changed by MCP. No synthesized replies. */
export function WorkRecords({controller}:{controller:UIController}){
 const [error,setError]=useState('');
 useEffect(()=>{
  if(controller.mode!=='live')return;let stopped=false,timer:ReturnType<typeof setTimeout>;
  const refresh=async()=>{try{await controller.action('refresh');if(!stopped)setError('');}catch(e){if(!stopped)setError((e as Error).message);}if(!stopped)timer=setTimeout(refresh,document.hidden?30000:5000);};
  timer=setTimeout(refresh,5000);return()=>{stopped=true;clearTimeout(timer);};
 },[controller.activeProjectId,controller.mode]);
 const s=controller.state;
 return <section aria-label="Shared work records"><h3>Work shared with the crew</h3><p>{controller.mode==='sample'?'Sample records · no connected agent':'UI and MCP use the same tasks, revisions and receipts.'}</p>{Object.values(s.tasks).map(t=>{
  const a=t.currentAssignmentId?s.assignments[t.currentAssignmentId]:undefined,session=a?.sessionId?s.sessions[a.sessionId]:undefined,completion=t.completion as any;
  return <article key={t.id} className="saved-plan"><strong>{t.goal}</strong><p>{t.lifecycle} · revision {t.revision} · {a?s.identities[a.identityId]?.displayName??a.identityId:'Unassigned'}</p>{a&&<small>Session {a.sessionId} · {String(session?.harness??session?.adapter??'Runtime unknown')} · {String(session?.model??'Model unreported')} · epoch {a.epoch}</small>}{t.progressSummary&&<p>Progress: {String(t.progressSummary)}</p>}{t.nextAction&&<p>Next: {t.nextAction}</p>}{t.blocker&&<p role="status">Blocker: {String(t.blocker)}</p>}{completion&&<p>Completion: {completion.summary} · receipt {completion.operationId}. {completion.meaning}</p>}{t.resultRefs.length>0&&<p>Evidence: {t.resultRefs.join(', ')}</p>}</article>;
 })}{error&&<p role="alert">{error}</p>}</section>;
}
