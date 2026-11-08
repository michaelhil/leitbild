import { z } from 'zod'
import type { RouteEntry } from './types.ts'
import { json } from './helpers.ts'

const refusal = (error:unknown) => json({error:error instanceof Error?error.message:String(error),code:typeof error==='object' && error!==null && 'code' in error ? error.code : error instanceof z.ZodError ? 'invalid_request':'engineering_failed'},400)
export const engineeringRoutes:readonly RouteEntry[]=[{
  method:'GET',pattern:/^\/api\/rooms\/([^/]+)\/engineering\/([^/]+)\/([^/]+)$/,
  handler:async(_req,match,ctx)=>{
    if (!ctx.system.engineering) return json({error:'Engineering requires a Host capability broker',code:'engineering_unavailable'},503)
    try {return json(await ctx.system.engineering.read(match[1]!,match[2]!,match[3]!,ctx.accessContext.actor))} catch(error){return refusal(error)}
  },
},{
  method:'POST',pattern:/^\/api\/rooms\/([^/]+)\/engineering$/,
  handler:async(req,match,ctx)=>{
    if (!ctx.system.engineering) return json({error:'Engineering requires a Host capability broker',code:'engineering_unavailable'},503)
    if(req.headers.get('sec-fetch-site')==='cross-site') return json({error:'Cross-site execution is refused',code:'cross_site'},403)
    try {
      // Request data is bounded before parsing; scripts have their own stricter limits.
      const reader=req.body?.getReader()
      if(!reader) return json({error:'Request body is required',code:'invalid_request'},400)
      const chunks:Uint8Array[]=[];let size=0
      while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>131_072){await reader.cancel();return json({error:'Engineering request exceeds 128 KiB',code:'request_too_large'},413)}chunks.push(next.value)}
      const raw=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      return json(await ctx.system.engineering.runForPerson(match[1]!,raw,ctx.accessContext.actor,req.signal))
    }catch(error){return refusal(error)}
  },
}]
