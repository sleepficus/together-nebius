import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {ConversationStore} from '../lib/conversation-store.ts';
/** Local development uses the same SQL statements, separate from the JSON work store. */
export function openConversationStore(file:string){
 if(file!==':memory:')mkdirSync(dirname(file),{recursive:true,mode:0o700});const db=new DatabaseSync(file);if(file!==":memory:")chmodSync(file,0o600);
 const storage={sql:{exec(q:string,...p:unknown[]){const stmt=db.prepare(q);const rows=/^(SELECT|PRAGMA)\b/i.test(q)?stmt.all(...p as any[]):(stmt.run(...p as any[]),[]);return{toArray:()=>rows as Record<string,unknown>[]}}},transactionSync<T>(f:()=>T){db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 return {store:new ConversationStore(storage),close:()=>db.close(),db};
}
