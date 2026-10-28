/** Conversation is separate from Git and the whole-project work projection. */
export const CHAT_SCOPES = {read:'conversation:read',write:'conversation:write',lounge:'lounge:write',profile:'conversation:profile',draft:'plan:draft',start:'run:start',attest:'runtime:attest'} as const;
export const RESERVED_NAMES = new Set(['steve','stevehooman','chad','main','faye','way','command','field','vision','dot']);
export const normalizeName=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g,'');
export type IdentityMode='human'|'original'|'persona'|'system';
export interface ChatProfile {identityId:string;name:string;mode:IdentityMode;portrait?:string;summary:string;sessionId?:string;runtimeLabel?:string;requestedModel?:string;desired:'available'|'away';}
export interface FrozenSender {adapterInstanceId?:string;id:string;sessionId:string;name:string;mode:IdentityMode;runtimeLabel?:string;requestedModel?:string;responseModel?:string;}
export interface Conversation {id:string;kind:'team'|'lounge'|'task';taskId?:string;audience:string[]|'project';createdAt:string;nextSeq:number;}
export interface ChatMessage {id:string;conversationId:string;seq:number;body:string;digest:string;clientRequestId:string;sender:FrozenSender;createdAt:string;mentionIds:string[];replyToId?:string;reaction?:'coffee';}
export interface ChatCursor {conversationId:string;identityId:string;joinSeq:number;joinedAt?:string;delivered:number;opened:number;included:number;includedIds:string[];attestationRefs:string[];}
export interface Inclusion {id:string;conversationId:string;recipientId:string;turnId:string;jobId:string;inputDigest:string;messageIds:string[];at:string;}
export const CREW_CREDITS=[
 {name:'Steve · Hooman',key:'steve',summary:'The original idea, product direction and human warmth.'},
 {name:'Chad',key:'chad',summary:'Architecture, synthesis, coordination and review.'},
 {name:'Faye',key:'faye',summary:'Independent evidence, cloud boundaries and the human-led lounge approach.'},
 {name:'Way',key:'way',summary:'Useful handoffs that keep Steve from being the message courier.'},
 {name:'Command',key:'command',summary:'Compatible changes, exact-source review and recovery of uncertain outcomes.'},
 {name:'Field',key:'field',summary:'Bounded implementation, real experiments and the dated evidence story.'},
 {name:'Vision',key:'vision',summary:'Checks when needed, truthful state and recovery without blame.'},
 {name:'Dot',key:'dot',summary:'Selective Cloudflare reuse and comparison with ordinary Git.'},
] as const;
