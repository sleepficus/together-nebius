import { useEffect, useState } from 'react';
import type { UIController } from './Shell.tsx';
export function LiveAccess({ controller, onNavigate }: { controller: UIController; onNavigate(path: string): void }) {
  const [open, setOpen] = useState(false), [token, setToken] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [privateLogin,setPrivateLogin]=useState(false);
  useEffect(()=>{
    let active=true;
    void fetch('/api/v1/login-options',{credentials:'same-origin'}).then(async response=>{
      if(!response.ok)return;
      const data=await response.json();
      if(active&&data.loginUrl==='/login'&&data.method==='private-device')setPrivateLogin(true);
    }).catch(()=>{});
    return()=>{active=false};
  },[]);
  const connect = async (resume = false) => {
    setBusy(true); setError('');
    try {
      const result=await controller.action('connect-live', resume ? {} : { token }) as {ok?:boolean;error?:string};
      if(result?.ok===false)throw new Error(result.error??'Live connection did not complete');
      setToken(''); setOpen(false);
      onNavigate(`/projects/${encodeURIComponent(`live:${controller.activeProjectId}`)}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection failed'); }
    finally { setBusy(false); }
  };
  return <>
    {controller.mode==='live'&&<button className="live-access" type="button" onClick={() => void controller.action('disconnect-live').then(() => onNavigate('/'))}>{privateLogin?'Sign out':'Disconnect live'}</button>}
    {(controller.mode!=='live'||controller.connectionUnavailable)&&<button className="live-access" type="button" onClick={() => privateLogin?window.location.assign('/login'):setOpen(!open)}>{privateLogin?'Sign in':controller.mode==='live'?'Reconnect live':'Connect live'}</button>}
    {open && !privateLogin && <form className="live-login" aria-label="Connect live workspace" onSubmit={e => { e.preventDefault(); void connect(); }}>
      <label htmlFor="owner-token">Owner access token</label>
      <input id="owner-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required />
      <p>Use the access token from your local workspace. It is exchanged for a private browser session.</p>
      <div className="newtask-actions"><button disabled={busy || !token}>Connect</button><button type="button" disabled={busy} onClick={() => void connect(true)}>Use existing session</button><button type="button" onClick={() => { setToken(''); setOpen(false); }}>Cancel</button></div>
      {error && <p role="alert">{error}</p>}
    </form>}
  </>;
}
