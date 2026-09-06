import type { RouteEntry } from './types.ts'
import {json,errorResponse} from './helpers.ts'
import {z} from 'zod'

const path = '^/rooms/([^/]+)/messages/([^/]+)/comparisons'
const modelInput = z.object({model:z.string().min(1)}).strict()
const failed=(error:unknown)=>{
  const message=error instanceof Error?error.message:String(error)
  const status=error instanceof z.ZodError || error instanceof URIError ? 400
    : message==='Message not found' || message==='Comparison not found' ? 404
    : /^(Choose an explicit|Original starting input|Original Agent|Model context|Selected model|Starting input|Captured input)/.test(message) ? 409 : 500
  return errorResponse(message,status)
}
export const comparisonRoutes:RouteEntry[] = [
  {method:'GET',pattern:new RegExp(`${path}$`),handler:async(_req,m,{system})=>{
    try{return json(await system.comparisons.list(decodeURIComponent(m[1]!),decodeURIComponent(m[2]!)))}catch(e){return failed(e)}
  }},
  {method:'POST',pattern:new RegExp(`${path}$`),handler:async(req,m,{system})=>{
    try{const {model}=modelInput.parse(await req.json());return json(await system.comparisons.start(decodeURIComponent(m[1]!),decodeURIComponent(m[2]!),model),202)}catch(e){return failed(e)}
  }},
  {method:'GET',pattern:new RegExp(`${path}/([^/]+)$`),handler:async(_req,m,{system})=>{
    try{return json(await system.comparisons.detail(decodeURIComponent(m[1]!),decodeURIComponent(m[2]!),decodeURIComponent(m[3]!)))}catch(e){return failed(e)}
  }},
  {method:'DELETE',pattern:new RegExp(`${path}/([^/]+)$`),handler:async(_req,m,{system})=>{
    try{return json(await system.comparisons.remove(decodeURIComponent(m[1]!),decodeURIComponent(m[2]!),decodeURIComponent(m[3]!)))}catch(e){return failed(e)}
  }},
  {method:'POST',pattern:new RegExp(`${path}/([^/]+)/cancel$`),handler:async(_req,m,{system})=>{
    try{return json(await system.comparisons.cancel(decodeURIComponent(m[1]!),decodeURIComponent(m[2]!),decodeURIComponent(m[3]!)))}catch(e){return failed(e)}
  }},
]
