import {useEffect,useRef,useState} from 'react';
import type {ChatMessage} from '../../lib/conversation-types.ts';
import type {UIController} from './Shell.tsx';
import {privateImageUrl} from './chat-image-url.ts';
import {readApiJson} from './api-json.ts';
export async function chatApi(projectId:string,path:string,body?:unknown,signal?:AbortSignal){
 let r:Response;
 try { r=await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/${path}`,{method:body?'POST':'GET',credentials:'same-origin',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal}); }
 catch(e) { if(signal?.aborted)throw e;throw new Error('Together cannot reach the server right now. Your draft is still here.'); }
 return readApiJson(r);
}
function PlainMessage({text}:{text:string}){
 // React escapes text; only authenticated same-origin images are embedded.
 return <>{text.split(/(https?:\/\/[^\s<>]+)/g).map((s,i)=>/^https?:\/\//.test(s)?privateImageUrl(s,window.location.origin)?<a className="chat-picture" key={i} href={s} target="_blank" rel="noopener noreferrer"><img src={s} alt="Picture shared in the crew conversation" loading="lazy"/><span>Open picture</span></a>:<a key={i} href={s} target="_blank" rel="noopener noreferrer">{s}</a>:s)}</>;
}
export function ConversationPanel({controller,channel,active,title}:{controller:UIController;channel:string;active:boolean;title:string}){
 const pid=controller.activeProjectId,live=controller.mode==='live',key=`together.conversation.${live?'live':'sample'}.${pid}.${channel}`;
 const [draft,setDraft]=useState(()=>{try{return localStorage.getItem(key+'.draft')??''}catch{return ''}});const [messages,setMessages]=useState<ChatMessage[]>([]);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [stage,setStage]=useState('');const [more,setMore]=useState(false);const [announcement,setAnnouncement]=useState('');const [invite,setInvite]=useState(false);const [recipients,setRecipients]=useState<string[]>([]),[replyTo,setReplyTo]=useState<string|undefined>();
 const input=useRef<HTMLTextAreaElement>(null);const after=useRef(0);const pending=useRef<{id:string;text:string}|null>(null);const stopped=useRef(false);const authFailed=useRef(false);
 const [retry,setRetry]=useState(0);
 const log=useRef<HTMLDivElement>(null),followLatest=useRef(true);
 useEffect(()=>{if(active&&followLatest.current&&log.current)log.current.scrollTop=log.current.scrollHeight;},[messages,active]);
 const picker=useRef<HTMLInputElement>(null);
 const [imageEnabled,setImageEnabled]=useState(false),[uploading,setUploading]=useState(false);
 const [images,setImages]=useState<string[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(key+'.images')??'[]');return Array.isArray(saved)?saved.filter(s=>typeof s==='string'&&privateImageUrl(s,window.location.origin)).slice(0,3):[]}catch{return []}});
 useEffect(()=>{try{localStorage.setItem(key+'.images',JSON.stringify(images))}catch{}},[key,images]);
 useEffect(()=>{if(!live||channel!=='team')return;let cancelled=false;void fetch('/api/v1/coffee-images',{credentials:'same-origin'}).then(async r=>{if(r.ok&&!cancelled)setImageEnabled((await r.json()).enabled===true)}).catch(()=>{});return()=>{cancelled=true}},[live,channel,pid]);
 async function upload(file:File){
  if(uploading||busy)return;if(images.length>=3){setError('Send these pictures first—up to three per message.');return}
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024){setError('Choose a PNG, JPEG or WebP under 8 MB.');return}
  setUploading(true);setError('');try{const r=await fetch('/api/v1/coffee-images',{method:'POST',credentials:'same-origin',headers:{'content-type':file.type},body:file});const d=await r.json();if(!r.ok)throw new Error(d.error??'Picture upload failed');const url=new URL(d.path,window.location.origin).href;if(!privateImageUrl(url,window.location.origin))throw new Error('Unexpected picture address');setImages(old=>[...old,url].slice(0,3));setStage('Picture ready—add a caption or press Send.')}catch(e){setError((e as Error).message)}finally{setUploading(false);if(picker.current)picker.current.value=''}
 }
 useEffect(()=>{try{localStorage.setItem(key+'.draft',draft)}catch{}},[key,draft]);
 useEffect(()=>{if(!live){try{setMessages(JSON.parse(localStorage.getItem(key+'.messages')??'[]'))}catch{setMessages([])}}},[key,live]);
 async function poll(signal?:AbortSignal){
  if(!live||stopped.current||authFailed.current)return;
  if(channel.startsWith('task:')){const taskId=channel.slice(5);await chatApi(pid,'conversations',{taskId,audience:Object.values(controller.state.members).map(m=>m.identityId)},signal);}else await chatApi(pid,'conversations',undefined,signal);
  const d=await chatApi(pid,`conversations/${encodeURIComponent(channel)}?after=${after.current}&limit=30`,undefined,signal);
  if(signal?.aborted||stopped.current)return;
  if(d.messages.length){setMessages(old=>{const by=new Map(old.map(m=>[m.id,m]));for(const m of d.messages)by.set(m.id,m);return [...by.values()].sort((a,b)=>a.seq-b.seq).slice(-200);});after.current=d.nextCursor;setAnnouncement(`${d.messages.length} new message${d.messages.length===1?'':'s'} in ${title}`);}
  setMore(d.more);if(d.cursor.delivered>d.cursor.opened)await chatApi(pid,`conversations/${encodeURIComponent(channel)}/opened`,{seq:d.cursor.delivered},signal);
 }
 useEffect(()=>{if(!active||!live)return;stopped.current=false;authFailed.current=false;let timer:ReturnType<typeof setTimeout>;const abort=new AbortController();
  const step=async()=>{try{await poll(abort.signal);setError('');}catch(e){if(abort.signal.aborted)return;setError((e as Error).message);if((e as any).status===401){authFailed.current=true;return;}}if(!abort.signal.aborted)timer=setTimeout(step,document.hidden?30000:4000);};void step();return()=>{stopped.current=true;abort.abort();clearTimeout(timer);};
 },[active,live,pid,channel,retry]);
 async function send(){if((!draft.trim()&&!images.length)||busy||uploading||authFailed.current)return;const text=[draft.trim(),...images].filter(Boolean).join('\n');if(text.length>2000){setError('Shorten the caption a little to leave room for your pictures.');return}setBusy(true);setError('');const signature=JSON.stringify({text,recipients,replyTo});if(!pending.current||pending.current.text!==signature)pending.current={id:crypto.randomUUID(),text:signature};
  try{
   let message:ChatMessage;
   if(live){const out=await chatApi(pid,`conversations/${encodeURIComponent(channel)}/messages`,{body:text,clientRequestId:pending.current.id,mentionIds:recipients,...(replyTo?{replyToId:replyTo}:{})});message=out.message;setStage('Queued');if(invite&&channel==='lounge'){const result=await chatApi(pid,'lounge/invite',{messageId:message.id});setStage(result.invitation.reason??'Invitation waiting');}}
   else{message={id:pending.current.id,conversationId:channel,seq:messages.length+1,body:text,digest:'local-sample',clientRequestId:pending.current.id,sender:{id:'sample-human',sessionId:'local-sample',name:'You · local sample',mode:'human'},createdAt:new Date().toISOString(),mentionIds:[]};setStage('Saved in this local sample');}
   setMessages(old=>{const next=old.some(m=>m.id===message.id)?old:[...old,message];if(!live)try{localStorage.setItem(key+'.messages',JSON.stringify(next))}catch{}return next;});setDraft('');setImages([]);setReplyTo(undefined);setRecipients([]);pending.current=null;input.current?.focus();
  }catch(e){setError((e as Error).message);if((e as any).status===401)authFailed.current=true;}finally{setBusy(false);}
 }
 const presets=channel==='lounge'?['Great work, crew 😊','Coffee’s on me ☕','What’s the next useful step?']:['Here’s the brief: ','Can you explain this choice?'];
 function offerTreat(treat:string){const names=recipients.map(id=>controller.state.identities[id]?.displayName).filter(Boolean);const text=`${treat} for ${names.length?names.join(', '):'the crew'}!`;setDraft(old=>old.trim()?old+'\n'+text:text);input.current?.focus();}
 return <section className="conversation-panel" aria-label={`${title} conversation`}>
  <div className="conversation-heading"><h2>{title==='Lounge'?'A seat at the table':title}</h2><span className="conversation-label">{live?'Private project conversation':'Local sample · no agent replies'}</span></div>
  {channel==='lounge'&&<div className="lounge-table" aria-label="Human led lounge"><div className="coffee-cup" aria-hidden>☕</div><strong>{live?'Project owner':'Your sample seat'}</strong><span>Human invitations bring the crew in.</span></div>}
  <div ref={log} className="chat-log" role="log" tabIndex={0} aria-live="off" aria-label={`${title} messages`} onScroll={e=>{const el=e.currentTarget;followLatest.current=el.scrollHeight-el.scrollTop-el.clientHeight<48;}}>
   {!messages.length&&<p className="chat-empty">{title==='Lounge'?'Say hello, send encouragement or leave a question.':'Keep the brief and questions together here.'}</p>}
   {messages.map(m=><article className={`chat-message ${m.sender.mode==='human'?'from-human':''}`} key={m.id}><div className="message-byline"><strong>{m.sender.name}</strong><time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><p><PlainMessage text={m.body}/></p><div className="message-actions"><button type="button" onClick={()=>{setReplyTo(m.id);input.current?.focus()}}>Reply</button><details className="message-details"><summary>Session details</summary><span className="message-mode">{live?m.sender.mode==='human'?'Human':`${m.sender.mode} · ${m.sender.runtimeLabel??'Runtime unknown'}`:'Local sample'}</span>{m.replyToId&&<small>Reply to message {m.replyToId}</small>}</details></div></article>)}
  </div>
  {more&&<button className="chat-more" onClick={()=>void poll().catch(e=>setError(e.message))}>Load next unread messages</button>}
  <div className="sr-only" role="status" aria-live={active?'polite':'off'}>{announcement}</div>
  {replyTo&&<p>Replying to {replyTo} <button onClick={()=>setReplyTo(undefined)}>Cancel reply</button></p>}
  <details><summary>Address project members (optional)</summary><p>Requests attention only. No task claim or automatic wake.</p>{Object.values(controller.state.members).map(m=><label key={m.id}><input type="checkbox" checked={recipients.includes(m.identityId)} onChange={()=>setRecipients(x=>x.includes(m.identityId)?x.filter(id=>id!==m.identityId):[...x,m.identityId])}/>{controller.state.identities[m.identityId]?.displayName??m.identityId}</label>)}</details>
  <form className="chat-composer" onSubmit={e=>{e.preventDefault();void send();}}>
   <details className="message-starters"><summary>A little encouragement ☕</summary><div className="encouragement-chips" aria-label="Editable message starters">{presets.map(text=><button type="button" key={text} onClick={()=>{setDraft(old=>old.trim()?old+'\n'+text:text);input.current?.focus();}}>{text}</button>)}</div><div className="encouragement-chips" aria-label="Offer a virtual café treat"><button type="button" disabled={busy} onClick={()=>offerTreat('☕ Coffee')}>☕ Offer coffee</button><button type="button" disabled={busy} onClick={()=>offerTreat('🍪 Cookies')}>🍪 Offer cookies</button><small>Virtual treats · edit your message, then Send</small></div></details>
   <label htmlFor={`compose-${channel}`}>{live?'Message as project owner':'Try a message locally'}</label>
   <textarea id={`compose-${channel}`} ref={input} value={draft} maxLength={2000} rows={3} placeholder="Your words, in your own time…" onChange={e=>setDraft(e.target.value)} onPaste={e=>{if(!imageEnabled)return;const file=Array.from(e.clipboardData.items).find(i=>i.kind==='file'&&i.type.startsWith('image/'))?.getAsFile();if(file){e.preventDefault();void upload(file)}}} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void send();}}}/>
   {imageEnabled&&<div className="chat-image-picker"><input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Choose a chat image" onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file)}}/><button type="button" disabled={busy||uploading||images.length>=3} onClick={()=>picker.current?.click()}>{uploading?'Uploading…':'📷 Add image'}</button><small>Private · PNG, JPEG or WebP · up to 8 MB</small></div>}
   {!!images.length&&<div className="chat-image-previews">{images.map((url,i)=><div key={url}><img src={url} alt={`Ready to send picture ${i+1}`}/><button type="button" disabled={busy} onClick={()=>setImages(xs=>xs.filter(x=>x!==url))}>Remove picture {i+1}</button></div>)}</div>}
   {channel==='lounge'&&<label className="invite-check"><input type="checkbox" checked={invite} onChange={e=>setInvite(e.target.checked)}/> Invite one available crew member to reply</label>}
   <div className="chat-send-row"><small>⌘ / Ctrl + Enter · {draft.length}/2,000</small><button disabled={busy||uploading||(!draft.trim()&&!images.length)||authFailed.current}>{busy?'Sending…':'Send'}</button></div>
   {stage&&<p className="chat-status" role="status">{stage}</p>}{error&&<div className="chat-error"><p role="alert">{error}</p>{live&&<button type="button" className="chat-more" onClick={()=>setRetry(x=>x+1)}>Retry connection</button>}</div>}
  </form>
 </section>;
}
