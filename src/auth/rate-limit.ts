import type {Request,Response,NextFunction} from 'express';
type Bucket={count:number;reset:number};
const buckets=new Map<string,Bucket>();
export function consumeRate(key:string,limit:number,windowMs:number){const now=Date.now();if(buckets.size>20000){for(const[k,b]of buckets)if(b.reset<=now)buckets.delete(k);if(buckets.size>20000)buckets.delete(buckets.keys().next().value!);}let b=buckets.get(key);if(!b||b.reset<=now){b={count:0,reset:now+windowMs};buckets.set(key,b);}b.count++;return {allowed:b.count<=limit,retry:Math.max(1,Math.ceil((b.reset-now)/1000))};}
export function rateLimit(prefix:string,limit:number,windowMs:number,key:(req:Request)=>string=(r)=>r.ip??'unknown'){return(req:Request,res:Response,next:NextFunction)=>{const check=consumeRate(prefix+':'+key(req),limit,windowMs);if(!check.allowed){res.set('Retry-After',String(check.retry)).status(429).json({error:'rate_limit_exceeded'});return;}next();};}
export const loginRateLimit=[rateLimit('login-ip',10,60000),rateLimit('login-email',20,3600000,r=>String(r.body?.email??'').trim().toLowerCase().slice(0,254))];
