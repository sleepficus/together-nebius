import {createContext,useContext,useEffect,useState} from 'react';
import type {ReactNode} from 'react';
import type {ProjectState} from '../../lib/types.ts';
const LeaseTime=createContext<number|undefined>(undefined);
/** One view-only wake at the next known expiry; no backend state or authority changes. */
export function LeaseClock({state,mode,children}:{state:ProjectState;mode:string;children:ReactNode}){
 const [tick,setTick]=useState(0);
 useEffect(()=>{
  if(mode!=='live')return;const now=Date.now();
  const next=Math.min(...Object.values(state.assignments).filter(a=>a.status==='active').map(a=>Date.parse(a.leaseExpiresAt)).filter(t=>Number.isFinite(t)&&t>now));
  if(!Number.isFinite(next))return;
  const timer=setTimeout(()=>setTick(value=>value+1),Math.min(2147483647,next-now+1));
  return()=>clearTimeout(timer);
 },[state.assignments,mode,tick]);
 return <LeaseTime.Provider value={Date.now()}>{children}</LeaseTime.Provider>;
}
export function useLeaseTime(){return useContext(LeaseTime)??Date.now();}
