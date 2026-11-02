/** TEST-ONLY LD-01 receipt tooling shared by the test tiers, the two-tier
 * judge, check qualification and the indicators (lane OU-D; BACKLOG T1/T2,
 * V1-V3). Nothing here is registered in a Pack, the Runtime Hub or the
 * deployer; the deployer ships only `src/**`.
 *
 * - Costs are instructions retired (`/usr/bin/time -l`), converted to
 *   quiet-equivalent CPU-s at the COST lane's quiet ratio; thread CPU is
 *   reported beside, never judged (the common cost rule, 15 Oct).
 * - Receipt directories are write-once: `newReceiptDir` refuses one that
 *   exists, and files are written with the `wx` flag.
 * - A trajectory digest is the sha256 of the canonical JSON (sorted keys) of
 *   named receipt sections, so it is independent of the writer's float
 *   formatting and key order. */
import {createHash} from 'node:crypto'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname} from 'node:path'

/** COST2's quiet instructions per CPU-s on this M2 (lead S3-D53). */
export const QUIET_RATIO=14.32e9

export const sha256=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
export const sha256File=(path:string)=>sha256(readFileSync(path))

/** JSON with every object's keys sorted, recursively. */
export function canonical(value:unknown):string{
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
 if(value!==null&&typeof value==='object'){
  const o=value as Record<string,unknown>
  return `{${Object.keys(o).sort().map(k=>`${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
 }
 return JSON.stringify(value)??'null'
}

/** The sha256 of the named sections of a receipt object. A missing section
 * is an error: a digest never silently covers less than it names. */
export function digest(receipt:Record<string,unknown>,sections:readonly string[]):string{
 const picked:Record<string,unknown>={}
 for(const s of sections){
  if(!(s in receipt))throw new Error(`the receipt has no section ${s}`)
  picked[s]=receipt[s]
 }
 return sha256(canonical(picked))
}

/** The counters of one `/usr/bin/time -l` report (summed when a cargo
 * invocation ran several test binaries under the runner). */
export type TimeReport={instructions:number,cycles:number,userS:number,sysS:number,realS:number,maxRssBytes:number,processes:number}
export function parseTimeL(text:string):TimeReport{
 const r:TimeReport={instructions:0,cycles:0,userS:0,sysS:0,realS:0,maxRssBytes:0,processes:0}
 for(const line of text.split('\n')){
  const times=/^\s*([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys\s*$/.exec(line)
  if(times){r.realS+=Number(times[1]);r.userS+=Number(times[2]);r.sysS+=Number(times[3]);r.processes+=1;continue}
  const counter=/^\s*(\d+)\s+(instructions retired|cycles elapsed|maximum resident set size)\s*$/.exec(line)
  if(!counter)continue
  const n=Number(counter[1])
  if(counter[2]==='instructions retired')r.instructions+=n
  else if(counter[2]==='cycles elapsed')r.cycles+=n
  else r.maxRssBytes=Math.max(r.maxRssBytes,n)
 }
 return r
}

/** Quiet-equivalent CPU-s of an instruction count. */
export const quietCpuS=(instructions:number,ratio=QUIET_RATIO)=>instructions/ratio

/** A new receipt directory (its parents created as needed); refuses one
 * that exists (write-once). */
export function newReceiptDir(path:string){mkdirSync(dirname(path),{recursive:true});mkdirSync(path,{recursive:false});return path}
/** Writes a new file; refuses an existing one. */
export function writeOnce(path:string,content:string){writeFileSync(path,content,{flag:'wx'})}
export const writeJsonOnce=(path:string,value:unknown)=>writeOnce(path,`${JSON.stringify(value,null,1)}\n`)

/** Relative difference of a measured count from its pin. */
export const relativeDifference=(measured:number,pinned:number)=>pinned===0?(measured===0?0:Infinity):(measured-pinned)/pinned

/** UTC stamp for directory names: 20261017T151824Z. */
export const stamp=(d=new Date())=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z')
