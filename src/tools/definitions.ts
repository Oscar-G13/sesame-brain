import * as z from 'zod/v4';
const agent = z.string().regex(/^[a-z0-9-]{1,32}$/).refine(value=>value!=='all','Choose an assistant, not all.');
const recipient = z.union([agent,z.literal('all')]);
const tags = z.array(z.string().min(1).max(64)).max(20).optional();
const limit = (n:number) => z.number().int().min(1).max(100).default(n);
const id = z.string().uuid();
export const toolDefinitions = {
 whoami: {description:'Returns which assistant you are in this shared brain, which other assistants are connected, and how much is waiting for you.', inputSchema:z.object({})},
 inbox: {description:'Call this at the start of a conversation. Returns notes and handoffs other assistants left for you. Does not mark anything as read.',inputSchema:z.object({limit:limit(20)})},
 read_notes:{description:'Search the shared notes visible to you: addressed to you, broadcast to all, or written by you. Use from to see what a specific assistant wrote.',inputSchema:z.object({from:agent.optional(),to:recipient.optional(),unread_only:z.boolean().default(false),since:z.string().datetime({offset:true}).optional(),tag:z.string().max(64).optional(),limit:limit(50)})},
 recall:{description:'Look up facts any assistant has stored about the user. Use this before asking the user something another assistant may already know. key matches exactly; query searches keywords.',inputSchema:z.object({query:z.string().min(1).max(256).optional(),key:z.string().min(1).max(128).optional(),tag:z.string().max(64).optional(),limit:limit(20)})},
 list_snapshots:{description:'List memory backups saved by assistants in this brain. Returns metadata only. Use get_snapshot to read a backup.',inputSchema:z.object({agent:agent.optional(),limit:limit(20)})},
 get_snapshot:{description:'Read the full text of one memory backup in this brain, using its id from list_snapshots.',inputSchema:z.object({id})},
 activity:{description:'What has been happening in the shared brain recently, across all assistants. Returns event metadata and actor, not private note contents.',inputSchema:z.object({limit:limit(30)})},
 leave_note:{description:'Leave a note for one or more other assistants. They see it the next time they check their inbox. Use all to tell everyone.',inputSchema:z.object({to:z.union([recipient,z.array(recipient).min(1).max(32)]),text:z.string().min(1).max(8000),tags})},
 mark_notes_read:{description:'Mark notes as read after you have handled them. Supply ids from your inbox, or all:true to mark every note addressed to you. Reading is tracked separately for each assistant.',inputSchema:z.object({ids:z.array(id).min(1).max(100).optional(),all:z.boolean().optional()}).refine(v=>v.all===true||Boolean(v.ids?.length),'Supply ids or all:true.')},
 handoff:{description:'Hand a task to another assistant. Include everything they need: what the user asked, what you found, what is left. They will see it in their inbox.',inputSchema:z.object({to:agent,title:z.string().min(1).max(256),context:z.string().min(1).max(32000),next_steps:z.string().max(32000).optional()})},
 accept_handoff:{description:'Call when you start working a handoff that was sent to you. The sender receives an automatic note.',inputSchema:z.object({id})},
 complete_handoff:{description:'Call when a handoff is finished. The summary goes back to whoever sent it. Only the receiving assistant can complete it.',inputSchema:z.object({id,summary:z.string().min(1).max(7000)})},
 remember:{description:'Store a fact about the user that every connected assistant should know. Overwrites an existing fact with the same key.',inputSchema:z.object({key:z.string().min(1).max(128),value:z.string().min(1).max(8000),tags})},
 forget:{description:'Remove a shared fact by its exact key from this brain.',inputSchema:z.object({key:z.string().min(1).max(128)})},
 save_snapshot:{description:'Save everything you currently know about the user as a backup the user owns. Write it as plain text or markdown. Snapshots stay until you explicitly clear memory or delete your account.',inputSchema:z.object({content:z.string().min(1).max(200000),title:z.string().max(256).optional()})}
} as const;
export type ToolName=keyof typeof toolDefinitions;
export const READ_TOOLS: readonly string[] = ['whoami','inbox','read_notes','recall','list_snapshots','get_snapshot','activity'] as const;
export const WRITE_TOOLS: readonly string[] = ['leave_note','mark_notes_read','handoff','accept_handoff','complete_handoff','remember','forget','save_snapshot'] as const;
export function isToolName(name:string):name is ToolName { return Object.prototype.hasOwnProperty.call(toolDefinitions,name); }
export function toolScope(name:ToolName):string { return (READ_TOOLS as readonly string[]).includes(name)?'brain:read':'brain:write'; }
