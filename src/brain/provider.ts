import {reportSubsystem} from '../ops/readiness.js';
import {aiConfig} from './config.js';
import {reserveUsage,settleUsage,BudgetError,type Identity} from './usage.js';
export type Block={type:string;[key:string]:unknown};
export type ModelMessage={role:'user'|'assistant';content:string|Block[]};
export interface ModelRequest{provider?:'anthropic'|'openai';model:string;system:string;prompt?:string;messages?:ModelMessage[];tools?:Record<string,unknown>[];maxOutputTokens:number;signal:AbortSignal;tokenBudget?:number;onText?:(text:string)=>void;}
export interface ModelResult{text:string;inputTokens:number;outputTokens:number;model:string;content:Block[];stopReason:string;incomplete:boolean;}
export class ProviderError extends Error{constructor(public code:string){super(code);this.name='ProviderError';}}
type Transport=(request:ModelRequest)=>Promise<ModelResult>;
let testTransport:Transport|undefined;
export function setModelTransportForTests(transport:Transport|undefined){if(process.env.NODE_ENV!=='test')throw new Error('Test only.');testTransport=transport;}
const modelCapabilities=new Map<string,boolean>();
const anthroHeaders=()=>({'x-api-key':aiConfig.anthropicKey,'anthropic-version':aiConfig.anthropicVersion,...(aiConfig.anthropicWorkspace?{'anthropic-workspace-id':aiConfig.anthropicWorkspace}:{})});
function count(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:0;}
async function boundedJson(response:Response,signal:AbortSignal,maxBytes=2000000):Promise<any>{
 if(!response.body)throw new ProviderError('provider_empty_response');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{while(true){signal.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>maxBytes)throw new ProviderError('provider_response_limit');chunks.push(chunk.value);}signal.throwIfAborted();}finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ProviderError('provider_invalid_json');}
}
export async function validateModels():Promise<{configured:boolean;models:{id:string;available:boolean;webSearch:boolean}[]}>{
 if(!aiConfig.ready)return{configured:false,models:[]};
 const signal=AbortSignal.timeout(10000),response=await fetch('https://api.anthropic.com/v1/models?limit=1000',{headers:anthroHeaders(),signal,redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw new ProviderError('model_validation_http_'+response.status);}
 const body=await boundedJson(response,signal);
 if(!Array.isArray(body.data))throw new ProviderError('model_validation_invalid_response');
 const models=[...new Set<string>([aiConfig.quickModel,aiConfig.deepModel])].map(id=>{const found=body.data.find((m:any)=>m?.id===id);const webSearch=Boolean(found?.capabilities?.server_tools?.web_search?.supported);modelCapabilities.set(id,webSearch);return{id,available:Boolean(found),webSearch};});
 return{configured:true,models};
}
export function webSearchTool(model:string):Record<string,unknown>[]{return modelCapabilities.get(model)?[{type:aiConfig.webSearchType,name:'web_search',max_uses:2}]:[];}
export async function readAnthropicStream(response:Response,request:ModelRequest):Promise<ModelResult>{
 if(!response.body)throw new ProviderError('provider_empty_response');
 const result:ModelResult={text:'',inputTokens:0,outputTokens:0,model:request.model,content:[],stopReason:'',incomplete:true};
 const usage={input:0,cacheRead:0,cacheWrite:0,output:0},partialJson=new Map<number,string>();
 let complete=false,bytes=0,pending='',eventLines:string[]=[];
 const reader=response.body.getReader(),decoder=new TextDecoder();const abort=()=>{void reader.cancel().catch(()=>{});};request.signal.addEventListener('abort',abort,{once:true});
 const updateUsage=(raw:any)=>{if(!raw)return;usage.input=Math.max(usage.input,count(raw.input_tokens));usage.cacheRead=Math.max(usage.cacheRead,count(raw.cache_read_input_tokens));usage.cacheWrite=Math.max(usage.cacheWrite,count(raw.cache_creation_input_tokens));usage.output=Math.max(usage.output,count(raw.output_tokens));result.inputTokens=usage.input+usage.cacheRead+usage.cacheWrite;result.outputTokens=usage.output;};
 function event(lines:string[]){
  const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');if(!data||data==='[DONE]')return;
  let e:any;try{e=JSON.parse(data);}catch{throw new ProviderError('provider_invalid_event');}
  if(e.type==='error')throw new ProviderError('provider_stream_error');
  if(e.type==='message_start')updateUsage(e.message?.usage);
  if(e.type==='content_block_start'||e.type==='content_block_delta'||e.type==='content_block_stop'){
   if(!Number.isSafeInteger(e.index)||e.index<0||e.index>=128)throw new ProviderError('provider_invalid_event');
  }
  if(e.type==='content_block_start'){
   if(!e.content_block||typeof e.content_block.type!=='string')throw new ProviderError('provider_invalid_event');
   result.content[e.index]={...e.content_block};
   if(e.content_block.type==='tool_use')partialJson.set(e.index,'');
   if(e.content_block.type==='text'&&typeof e.content_block.text==='string'&&e.content_block.text){result.text+=e.content_block.text;request.onText?.(e.content_block.text);}
  }
  if(e.type==='content_block_delta'){
   const block=result.content[e.index],delta=e.delta;
   if(delta?.type==='text_delta'&&typeof delta.text==='string'){if(block)block.text=String(block.text??'')+delta.text;result.text+=delta.text;request.onText?.(delta.text);}
   if(delta?.type==='input_json_delta'&&typeof delta.partial_json==='string')partialJson.set(e.index,(partialJson.get(e.index)??'')+delta.partial_json);
   if(delta?.type==='citations_delta'&&block){const citations=Array.isArray(block.citations)?block.citations:[];citations.push(delta.citation);block.citations=citations;}
   if(delta?.type==='thinking_delta'&&block)block.thinking=String(block.thinking??'')+(delta.thinking??'');
   if(delta?.type==='signature_delta'&&block)block.signature=String(block.signature??'')+(delta.signature??'');
  }
  if(e.type==='content_block_stop'&&partialJson.has(e.index)){const value=partialJson.get(e.index);if(value){try{result.content[e.index].input=JSON.parse(value);}catch{throw new ProviderError('provider_invalid_tool_json');}}partialJson.delete(e.index);}
  if(e.type==='message_delta'){if(typeof e.delta?.stop_reason==='string')result.stopReason=e.delta.stop_reason;updateUsage(e.usage);}
  if(e.type==='message_stop')complete=true;
 }
 function consume(final=false){
  let newline:number;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline).replace(/\r$/,'');pending=pending.slice(newline+1);if(line===''){event(eventLines);eventLines=[];}else if(!line.startsWith(':'))eventLines.push(line);}
  if(final){if(pending)eventLines.push(pending.replace(/\r$/,''));if(eventLines.length)event(eventLines);pending='';eventLines=[];}
 }
 try{
  while(true){request.signal.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>2000000)throw new ProviderError('provider_response_limit');pending+=decoder.decode(chunk.value,{stream:true});consume();}
  pending+=decoder.decode();consume(true);
 }catch(error){if(!request.signal.aborted)throw error;}
 finally{request.signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
 result.content=result.content.filter(Boolean);result.incomplete=!complete||request.signal.aborted;return result;
}
async function anthropic(request:ModelRequest):Promise<ModelResult>{
 const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json',...anthroHeaders()},body:JSON.stringify({model:request.model,max_tokens:request.maxOutputTokens,system:request.system,messages:request.messages??[{role:'user',content:request.prompt??''}],...(request.tools?.length?{tools:request.tools}:{}),stream:true}),signal:request.signal,redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw new ProviderError('provider_http_'+response.status);}
 return readAnthropicStream(response,request);
}
async function openai(request:ModelRequest):Promise<ModelResult>{
 const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+aiConfig.openaiKey},body:JSON.stringify({model:request.model,instructions:request.system,input:request.prompt??'',max_output_tokens:request.maxOutputTokens,store:false}),signal:request.signal,redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw new ProviderError('auditor_http_'+response.status);}
 const body=await boundedJson(response,request.signal);
 const text=(Array.isArray(body.output)?body.output:[]).flatMap((item:any)=>Array.isArray(item.content)?item.content:[]).filter((item:any)=>item.type==='output_text'&&typeof item.text==='string').map((item:any)=>item.text).join('\n');
 return{text,inputTokens:count(body.usage?.input_tokens),outputTokens:count(body.usage?.output_tokens),model:request.model,content:[{type:'text',text}],stopReason:String(body.status??''),incomplete:body.status!=='completed'};
}
export async function requestProviderForTests(request:ModelRequest):Promise<ModelResult>{if(process.env.NODE_ENV!=='test')throw new Error('Test only.');return request.provider==='openai'?openai(request):anthropic(request);}
export async function generateBudgeted(a:Identity,request:ModelRequest):Promise<ModelResult>{
 request.signal.throwIfAborted();
 if(!testTransport&&!(request.provider==='openai'?aiConfig.openaiKey:aiConfig.anthropicKey))throw new ProviderError('not_configured');
 if(!request.model||request.model.length>200||!Number.isSafeInteger(request.maxOutputTokens)||request.maxOutputTokens<1||request.maxOutputTokens>64000)throw new ProviderError('invalid_model_request');
 const bytes=Buffer.byteLength(JSON.stringify({system:request.system,messages:request.messages,prompt:request.prompt,tools:request.tools}));
 if(bytes>1000000)throw new ProviderError('provider_request_limit');
 const estimate=bytes+request.maxOutputTokens+(request.tools?.some(tool=>tool.name==='web_search')?50000:0);
 if(request.tokenBudget!==undefined&&estimate>request.tokenBudget)throw new BudgetError();
 const reservation=await reserveUsage(a,request.model,estimate);let result:ModelResult|undefined;let uncertain=true;
 // Even internal callers must supply a bounded provider request.
 const bounded={...request,signal:AbortSignal.any([request.signal,AbortSignal.timeout(15*60*1000)])};
 try{result=await(testTransport??(request.provider==='openai'?openai:anthropic))(bounded);uncertain=result.incomplete;if(!testTransport)await reportSubsystem('provider',true,'ready').catch(()=>{});return result;}
 catch(error){if(!testTransport&&error instanceof ProviderError){const code=/401|403/.test(error.message)?'credentials_rejected':/429/.test(error.message)?'capacity_limited':'unavailable';await reportSubsystem('provider',false,code).catch(()=>{});}throw error;}
 finally{await settleUsage(a,reservation,result?.inputTokens??0,result?.outputTokens??0,uncertain);}
}
