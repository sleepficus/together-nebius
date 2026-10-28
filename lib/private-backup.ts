import {digestOf,fail} from './core.ts';
import type {ConversationStore} from './conversation-store.ts';
/** Verify payload before restore. Checksums establish integrity, not source trust. */
export async function restorePrivateBackup(store:ConversationStore,archive:any,expectedProjectId:string){
 if(!archive||archive.format!=='together-private-conversation-v1'||archive.projectId!==expectedProjectId)fail(422,'backup_identity','Wrong backup format or project');
 const payload={format:archive.format,projectId:archive.projectId,projectRevision:archive.projectRevision,createdAt:archive.createdAt,rows:archive.rows};
 if(archive.digest!==await digestOf(payload))fail(422,'backup_digest','Backup content changed');
 return store.restorePrivateRows(archive.rows);
}
