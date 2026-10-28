import { fail } from './core.ts';
import type { DurableObjectStorageLike } from './store.ts';
import type { ChatCursor,ChatMessage,ChatProfile,Conversation,FrozenSender,Inclusion } from './conversation-types.ts';
const decode=<T>(row:Record<string,unknown>|undefined):T|undefined=>row?JSON.parse(String(row.body)):undefined;
/** Dedicated indexed append-only tables. No messages/events/operation results in ProjectState. */
export class ConversationStore {
 private storage:DurableObjectStorageLike;
 constructor(storage:DurableObjectStorageLike){this.storage=storage;this.init();}
 private q(s:string,...p:unknown[]){return this.storage.sql.exec(s,...p).toArray();}
 private tx<T>(f:()=>T):T{if(this.storage.transactionSync)return this.storage.transactionSync(f);this.q('BEGIN IMMEDIATE');try{const r=f();this.q('COMMIT');return r}catch(e){this.q('ROLLBACK');throw e}}
 private init(){
  this.q('CREATE TABLE IF NOT EXISTS chat_conversations(id TEXT PRIMARY KEY,body TEXT NOT NULL,next_seq INTEGER NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS chat_messages(id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL,seq INTEGER NOT NULL,sender_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(conversation_id,seq),UNIQUE(sender_id,request_id))');
  this.q('CREATE INDEX IF NOT EXISTS chat_message_time ON chat_messages(conversation_id,created_at,seq)');
  this.q('CREATE TABLE IF NOT EXISTS chat_members(conversation_id TEXT NOT NULL,identity_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(conversation_id,identity_id))');
  this.q('CREATE TABLE IF NOT EXISTS chat_profiles(identity_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  // Ephemeral client-declared adapter observations; excluded from backups and work snapshots.
  this.q('CREATE TABLE IF NOT EXISTS attention_records(seq INTEGER PRIMARY KEY AUTOINCREMENT,record_key TEXT UNIQUE NOT NULL,body TEXT NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS attention_arms(id TEXT PRIMARY KEY,session_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS chat_connections(instance_id TEXT PRIMARY KEY,identity_id TEXT NOT NULL,session_id TEXT NOT NULL,checked_at TEXT NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS chat_included(conversation_id TEXT NOT NULL,identity_id TEXT NOT NULL,seq INTEGER NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(conversation_id,identity_id,seq))');
  this.q('CREATE TABLE IF NOT EXISTS chat_attestations(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS chat_route_suggestions(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS chat_rates(identity_id TEXT PRIMARY KEY,window TEXT NOT NULL,count INTEGER NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS chat_invitations(id TEXT PRIMARY KEY,status TEXT NOT NULL,body TEXT NOT NULL)');
  this.q('CREATE TABLE IF NOT EXISTS chat_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL)');
  this.q("CREATE UNIQUE INDEX IF NOT EXISTS chat_exclusive_turn ON chat_turns(session_id) WHERE status IN ('intent','running','unconfirmed')");
 }
 conversation(id:string){const row=this.q('SELECT body,next_seq FROM chat_conversations WHERE id = ?',id)[0];const c=decode<Conversation>(row);if(c)c.nextSeq=Number(row.next_seq);return c;}
 create(c:Conversation){return this.tx(()=>{const old=this.conversation(c.id);if(old){if(JSON.stringify({...old,nextSeq:0})!==JSON.stringify({...c,nextSeq:0}))fail(409,'conversation_conflict','conversation definition changed');return old}this.q('INSERT INTO chat_conversations(id,body,next_seq) VALUES(?,?,?)',c.id,JSON.stringify(c),c.nextSeq);return c});}
 list(){return this.q('SELECT body,next_seq FROM chat_conversations ORDER BY id LIMIT 100').map(row=>({...decode<Conversation>(row)!,nextSeq:Number(row.next_seq)}));}
 profile(id:string){return decode<ChatProfile>(this.q('SELECT body FROM chat_profiles WHERE identity_id = ?',id)[0]);}
 profiles(){return this.q('SELECT body FROM chat_profiles ORDER BY identity_id LIMIT 100').map(r=>decode<ChatProfile>(r)!);}
 observeConnection(instanceId:string,identityId:string,sessionId:string,now:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId))return;
  this.tx(()=>{
   this.q('DELETE FROM chat_connections WHERE checked_at < ?',new Date(Date.parse(now)-120000).toISOString());
   this.q('INSERT INTO chat_connections(instance_id,identity_id,session_id,checked_at) VALUES(?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET identity_id=excluded.identity_id,session_id=excluded.session_id,checked_at=excluded.checked_at',instanceId,identityId,sessionId,now);
   this.q('DELETE FROM chat_connections WHERE instance_id IN (SELECT instance_id FROM chat_connections ORDER BY checked_at DESC,instance_id LIMIT -1 OFFSET 256)');
  });
 }
 connectionInfo(identityId:string,sessionId:string|undefined,now:string){
  const rows=this.q('SELECT checked_at FROM chat_connections WHERE identity_id = ? AND session_id = ? ORDER BY checked_at DESC LIMIT 256',identityId,sessionId??'');
  return {lastCheckedAt:rows[0]?.checked_at??null,recentConnections:rows.filter(r=>Date.parse(String(r.checked_at))>=Date.parse(now)-120000).length};
 }
 setProfile(p:ChatProfile){this.q('INSERT INTO chat_profiles(identity_id,body) VALUES(?,?) ON CONFLICT(identity_id) DO UPDATE SET body=excluded.body',p.identityId,JSON.stringify(p));return p;}
 message(id:string){return decode<ChatMessage>(this.q('SELECT body FROM chat_messages WHERE id = ?',id)[0]);}
 /** Request identity binds to payload before rate limits, so uncertain retries are harmless. */
 append(input:{conversationId:string;body:string;digest:string;requestId:string;sender:FrozenSender;now:string;id:string;mentions:string[];replyToId?:string;reaction?:'coffee'}):{message:ChatMessage;duplicate:boolean}{
  return this.tx(()=>{
   const old=this.q('SELECT body,digest FROM chat_messages WHERE sender_id = ? AND request_id = ?',input.sender.id,input.requestId)[0];
   if(old){if(old.digest!==input.digest)fail(409,'request_conflict','request id reused with different content');return{message:decode<ChatMessage>(old)!,duplicate:true}}
   const c=this.conversation(input.conversationId);if(!c)fail(404,'conversation_not_found','unknown conversation');
   const minute=input.now.slice(0,16);const rate=this.q('SELECT window,count FROM chat_rates WHERE identity_id = ?',input.sender.id)[0];const count=rate?.window===minute?Number(rate.count)+1:1;if(count>120)fail(429,'chat_rate_limit','Please pause before sending more messages');
   const msg:ChatMessage={id:input.id,conversationId:c.id,seq:c.nextSeq+1,body:input.body,digest:input.digest,clientRequestId:input.requestId,sender:structuredClone(input.sender),createdAt:input.now,mentionIds:[...input.mentions],...(input.replyToId?{replyToId:input.replyToId}:{}),...(input.reaction?{reaction:input.reaction}:{})};
   this.q('INSERT INTO chat_messages(id,conversation_id,seq,sender_id,request_id,digest,created_at,body) VALUES(?,?,?,?,?,?,?,?)',msg.id,c.id,msg.seq,msg.sender.id,input.requestId,msg.digest,input.now,JSON.stringify(msg));
   this.q('UPDATE chat_conversations SET next_seq = ? WHERE id = ?',msg.seq,c.id);
   this.q('INSERT INTO chat_rates(identity_id,window,count) VALUES(?,?,?) ON CONFLICT(identity_id) DO UPDATE SET window=excluded.window,count=excluded.count',input.sender.id,minute,count);return{message:msg,duplicate:false};
  });
 }
 visibilityAt(conversationId:string,joinedAt:string){return Number(this.q('SELECT seq FROM chat_messages WHERE conversation_id = ? AND created_at <= ? ORDER BY seq DESC LIMIT 1',conversationId,joinedAt)[0]?.seq??0);}
 cursor(c:string,id:string,joinSeq:number):ChatCursor{return decode<ChatCursor>(this.q('SELECT body FROM chat_members WHERE conversation_id = ? AND identity_id = ?',c,id)[0])??{conversationId:c,identityId:id,joinSeq,delivered:joinSeq,opened:joinSeq,included:joinSeq,includedIds:[],attestationRefs:[]};}
 join(c:string,id:string,joinSeq:number,joinedAt?:string){const old=this.q('SELECT body FROM chat_members WHERE conversation_id = ? AND identity_id = ?',c,id)[0];if(!old)this.saveCursor({...this.cursor(c,id,joinSeq),joinedAt});}
 joinSeq(c:string,id:string,joinedAt:string){const saved=decode<ChatCursor>(this.q('SELECT body FROM chat_members WHERE conversation_id = ? AND identity_id = ?',c,id)[0]);if(saved?.joinedAt===joinedAt)return saved.joinSeq;const seq=this.visibilityAt(c,joinedAt);this.saveCursor({...this.cursor(c,id,seq),joinSeq:seq,joinedAt,delivered:seq,opened:seq,included:seq,includedIds:[],attestationRefs:[]});return seq;}
 private saveCursor(c:ChatCursor){this.q('INSERT INTO chat_members(conversation_id,identity_id,body) VALUES(?,?,?) ON CONFLICT(conversation_id,identity_id) DO UPDATE SET body=excluded.body',c.conversationId,c.identityId,JSON.stringify(c));}
 page(c:string,id:string,joinSeq:number,after:number,limit:number){return this.tx(()=>{
  const cur=this.cursor(c,id,joinSeq);const cursor=Math.max(after,cur.joinSeq,joinSeq);const rows=this.q('SELECT body FROM chat_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?',c,cursor,limit).map(r=>decode<ChatMessage>(r)!);
  // A delivered prefix advances only for a contiguous page; skipped pages remain discoverable.
  const last=rows.at(-1)?.seq??cursor;if(rows.length&&cursor<=cur.delivered&&last>cur.delivered){cur.delivered=last;this.saveCursor(cur)}
  const next=rows.at(-1)?.seq??cursor;const head=this.conversation(c)!.nextSeq;return{messages:rows,cursor:cur,nextCursor:next,more:next<head};
 });}
 open(c:string,id:string,joinSeq:number,seq:number){return this.tx(()=>{const cur=this.cursor(c,id,joinSeq);if(seq>cur.delivered)fail(409,'not_delivered','Fetch this range before acknowledging it');if(seq>cur.opened){cur.opened=seq;this.saveCursor(cur)}return cur});}
 attest(a:Inclusion,joinSeq:number){return this.tx(()=>{
  const old=decode<Inclusion>(this.q('SELECT body FROM chat_attestations WHERE id = ?',a.id)[0]);if(old){if(JSON.stringify(old)!==JSON.stringify(a))fail(409,'attestation_conflict','attestation changed');return old}
  const c=this.cursor(a.conversationId,a.recipientId,joinSeq);const rows=a.messageIds.map(id=>this.message(id));if(rows.some(r=>!r||r.conversationId!==a.conversationId||r.seq<=joinSeq))fail(409,'invalid_inclusion','Input references inaccessible messages');
  if(a.messageIds.length>20||new Set(a.messageIds).size!==a.messageIds.length)fail(422,'inclusion_bounds','At most20 unique exact message IDs');
  for(const m of rows)this.q('INSERT INTO chat_included(conversation_id,identity_id,seq,message_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',a.conversationId,a.recipientId,m!.seq,m!.id);
  let next=c.included+1;while(this.q('SELECT seq FROM chat_included WHERE conversation_id = ? AND identity_id = ? AND seq = ?',a.conversationId,a.recipientId,next).length){c.included=next;next++;}
  // Cursor metadata stays bounded. Full exact gap evidence stays in indexed rows/attestations.
  c.includedIds=this.q('SELECT message_id FROM chat_included WHERE conversation_id = ? AND identity_id = ? AND seq > ? ORDER BY seq LIMIT 50',a.conversationId,a.recipientId,c.included).map(r=>String(r.message_id));c.attestationRefs=[...c.attestationRefs.slice(-31),a.id];
  this.q('INSERT INTO chat_attestations(id,body) VALUES(?,?)',a.id,JSON.stringify(a));this.saveCursor(c);return a;
 });}
 /** Bounded context uses exact selected IDs; omissions never advance an inclusive cursor. */
 context(conversations:{id:string;joinSeq:number;after:number;filter?:(m:ChatMessage)=>boolean}[],maxMessages=20,maxBytes=8192){
  const selected:ChatMessage[]=[];const continuation:Record<string,number>={};let bytes=0,more=false;
  for(const c of conversations){const rows=this.q('SELECT body FROM chat_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT 21',c.id,Math.max(c.after,c.joinSeq)).map(r=>decode<ChatMessage>(r)!);
   continuation[c.id]=Math.max(c.after,c.joinSeq);
   for(const m of rows){const n=new TextEncoder().encode(JSON.stringify(m)).length;if(c.filter&&!c.filter(m)){continuation[c.id]=m.seq;continue;}if(selected.length>=maxMessages||bytes+n>maxBytes){more=true;break}continuation[c.id]=m.seq;selected.push(m);bytes+=n}
   if((rows.at(-1)?.seq??0)<this.conversation(c.id)!.nextSeq)more=true;
  }return{messages:selected,messageIds:selected.map(m=>m.id),bytes,more,continuation};
 }
 activeTurn(sessionId:string){return decode<any>(this.q("SELECT body FROM chat_turns WHERE session_id = ? AND status IN ('intent','running','unconfirmed') LIMIT 1",sessionId)[0]);}
 // Durable invitations and turn reservations are separately bounded, never message fanout.
 getRecord<T>(table:'chat_invitations'|'chat_turns'|'chat_route_suggestions',id:string){return decode<T>(this.q(`SELECT body FROM ${table} WHERE id = ?`,id)[0]);}
 records<T>(table:'chat_invitations'|'chat_turns'|'chat_route_suggestions',status?:string){return this.q(`SELECT body FROM ${table}${status?' WHERE status = ?':''} ORDER BY id LIMIT 100`,...(status?[status]:[])).map(r=>decode<T>(r)!);}
 putRecord(table:'chat_invitations'|'chat_turns'|'chat_route_suggestions',r:{id:string;status?:string;sessionId?:string;[k:string]:unknown}){
  if(table==='chat_turns')this.q('INSERT INTO chat_turns(id,session_id,status,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body',r.id,r.sessionId,r.status,JSON.stringify(r));
  else if(table==='chat_invitations')this.q('INSERT INTO chat_invitations(id,status,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body',r.id,r.status,JSON.stringify(r));
  else this.q('INSERT INTO chat_route_suggestions(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',r.id,JSON.stringify(r));return r;
 }
 countTurns(purpose:string,since?:string){return Number(this.q("SELECT COUNT(*) AS n FROM chat_turns WHERE json_extract(body,'$.purpose') = ?"+(since?" AND json_extract(body,'$.createdAt') >= ?":''),purpose,...(since?[since]:[]))[0]?.n??0)}
 /** Private owner backup only; deliberately separate from ordinary project export. */
 privateRows(){
  return Object.fromEntries(PRIVATE_TABLES.map(t=>[t,this.q(`SELECT * FROM ${t} ORDER BY rowid`)]));
 }
 /** Offline restore into an empty, separate store. Never merges or resumes runtime turns. */
 restorePrivateRows(rows:Record<string,Record<string,unknown>[]>){
  return this.tx(()=>{
   if(Object.keys(rows).length!==PRIVATE_TABLES.length||Object.keys(rows).some(t=>!PRIVATE_TABLES.includes(t as any)))fail(422,'backup_tables','Unexpected private backup tables');
   for(const t of PRIVATE_TABLES){
    if(this.q(`SELECT 1 FROM ${t} LIMIT 1`).length)fail(409,'restore_not_empty','Restore requires an empty separate conversation store');
    const columns=this.q(`PRAGMA table_info(${t})`).map(r=>String(r.name));
    if(!Array.isArray(rows[t]))fail(422,'backup_rows','Expected row array');
    for(const row of rows[t]){
     if(Object.keys(row).length!==columns.length||columns.some(c=>!(c in row)))fail(422,'backup_columns','Invalid backup columns');
     if('body' in row){try{JSON.parse(String(row.body));}catch{fail(422,'backup_json','Invalid JSON record');}}
     this.q(`INSERT INTO ${t}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,...columns.map(c=>row[c]));
    }
   }
   // Restored turns are evidence only, never runnable reservations.
   for(const r of this.q('SELECT id,body FROM chat_turns')){const b=JSON.parse(String(r.body));b.restoredStatus=b.status;b.status='restored-unverified';this.q('UPDATE chat_turns SET status=?,body=? WHERE id=?',b.status,JSON.stringify(b),r.id);}
   return Object.fromEntries(PRIVATE_TABLES.map(t=>[t,rows[t].length]));
  });
 }
 attentionRecord(key:string,body:Record<string,unknown>){this.q('INSERT INTO attention_records(record_key,body) VALUES(?,?) ON CONFLICT(record_key) DO NOTHING',key,JSON.stringify(body));this.q('DELETE FROM attention_records WHERE seq NOT IN (SELECT seq FROM attention_records ORDER BY seq DESC LIMIT 1000)');}
 attentionHead(){return Number(this.q('SELECT MAX(seq) AS n FROM attention_records')[0]?.n??0)}
 attentionRows(after:number){return this.q('SELECT seq,body FROM attention_records WHERE seq > ? ORDER BY seq LIMIT 100',after).map(r=>({seq:Number(r.seq),...JSON.parse(String(r.body))}));}
 attentionArms(){return this.q('SELECT body FROM attention_arms').map(r=>JSON.parse(String(r.body)));}
 attentionArm(id:string){return decode<any>(this.q('SELECT body FROM attention_arms WHERE id=?',id)[0]);}
 putAttentionArm(a:any){this.q('INSERT INTO attention_arms(id,session_id,body) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET id=excluded.id,body=excluded.body',a.id,a.sessionId,JSON.stringify(a));return a;}
 atomic<T>(f:()=>T){return this.tx(f)}
}

export const PRIVATE_TABLES=['chat_conversations','chat_messages','chat_members','chat_profiles','chat_included','chat_attestations','chat_route_suggestions','chat_rates','chat_invitations','chat_turns'] as const;
