import {expect,test} from 'bun:test'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

const root=resolve(import.meta.dir,'../native/process-plant/qualification/licenses')
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
test('selected native notice bundle retains exact identified terms and disclosed newline changes',async()=>{
 const manifest=await Bun.file(resolve(root,'sources.json')).json()
 expect(manifest.files).toHaveLength(10)
 expect(new Set(manifest.files.map((f:{path:string})=>f.path)).size).toBe(10)
 for(const file of manifest.files){
  const bytes=await readFile(resolve(root,file.path))
  expect(digest(bytes)).toBe(file.sha256)
  expect(file.url.startsWith('https://')).toBe(true)
  if(file.upstreamSHA256){
   expect(file.change).toContain('terminal newline added')
   expect(bytes.at(-1)).toBe(10)
   expect(digest(bytes.subarray(0,-1))).toBe(file.upstreamSHA256)
  }
 }
 expect(await Bun.file(resolve(root,'LGPL-2.1.txt')).text()).toContain('TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION')
 expect(await Bun.file(resolve(root,'SuiteSparse-config.txt')).text()).toContain('Copyright (c) 2012-2024, Timothy A. Davis.')
})
