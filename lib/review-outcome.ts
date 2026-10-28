import type {ProjectState} from './types.ts';
/** Latest substantive decision per reviewer on an exact SHA. Comments never erase a decision. */
export function reviewOutcome(state:ProjectState,sha:string){
 const latest=new Map<string,any>();
 for(const r of Object.values(state.reviews).filter(r=>r.candidateSha===sha&&!r.importedUnverified).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))){if(r.disposition!=='comment')latest.set(r.reviewerId,r);}
 const decisions=[...latest.values()],requested=decisions.filter(r=>r.disposition==='request-changes'),approved=decisions.filter(r=>r.disposition==='approve'&&r.independent);
 return{decisions,requested,approved,state:requested.length?'changes requested':approved.length?'accepted for integration review':'awaiting independent review'};
}
