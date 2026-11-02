import { Router, type Request } from 'express';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { config } from '../config.js';
import { bearerAuth } from '../oauth/bearer.js';
import { allToolDefinitions,executeBrainTool,SERVER_INSTRUCTIONS } from '../brain/lifecycle.js';
import { z } from 'zod/v4';
import { executeTool, resultSummary, ToolError, type AuthContext } from '../tools/service.js';

export const mcpRouter=Router();
mcpRouter.use('/mcp',(req,res,next)=>{
 res.setHeader('Access-Control-Allow-Origin','*');
 res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
 res.setHeader('Access-Control-Expose-Headers','Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate');
 res.setHeader('Cache-Control','no-store');
 if(req.method==='OPTIONS'){res.sendStatus(204);return;}
 next();
});
mcpRouter.all('/mcp',bearerAuth,async(req,res)=>{
 const auth=(req as Request & {auth:AuthContext}).auth;
 // Auth is captured only by this request's factory; it never enters shared state.
 const handler=createMcpHandler(()=>{
  const server=new McpServer({name:'brain',version:config.version},{instructions:SERVER_INSTRUCTIONS});
  for(const name of Object.keys(allToolDefinitions)){
   const definition=allToolDefinitions[name];
   server.registerTool(name,{
    description:definition.description,
    inputSchema:definition.inputSchema,
    annotations:{readOnlyHint:['whoami','inbox','read_notes','recall','list_snapshots','get_snapshot','activity','job_status','jobs_list'].includes(name),destructiveHint:['forget','remember','mark_notes_read','save_snapshot'].includes(name),openWorldHint:['think','do'].includes(name)}
   },async (input:unknown)=>{
    try {
     const data=await executeBrainTool(auth,name,input);
     return {content:[{type:'text' as const,text:JSON.stringify(data)},{type:'text' as const,text:resultSummary(name,data)}]};
    } catch(error){
     if(error instanceof ToolError||error instanceof z.ZodError)return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:error instanceof ToolError?error.message:'Check the tool input and try again.',trailer:''})}]};
     // Never let SQL errors, contents or SDK diagnostics escape into the logs.
     console.error(JSON.stringify({event:'tool_failed',tool:name}));
     return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:'The operation could not be completed. Try again.',trailer:''})}]};
    }
   });
  }
  return server;
 },{legacy:'stateless',maxRequestBodySize:1_048_576,onerror:()=>console.error(JSON.stringify({event:'mcp_protocol_error'}))});
 const node=toNodeHandler(handler,{onerror:()=>console.error(JSON.stringify({event:'mcp_adapter_error'})),maxRequestBodySize:1_048_576});
 try{await node(req as unknown as Parameters<typeof node>[0],res as unknown as Parameters<typeof node>[1],req.body);}
 finally{await handler.close();}
});
