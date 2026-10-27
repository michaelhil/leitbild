import { expect, test } from 'bun:test'
import { admitPhysicalArchitectureBsp, copyPhysicalArchitectureBspInput, createPhysicalArchitectureBspPreparer, type PhysicalArchitectureBspRequest, type PhysicalArchitectureBspResponse } from '../src/ui/map/physical-scene/architecture-bsp-preparation.ts'
import { preparePhysicalArchitectureBsp } from '../src/ui/map/physical-scene/architecture-bsp.ts'
import type { PhysicalArchitectureBspInput } from '../src/ui/map/physical-scene/architecture-bsp-types.ts'
const matrix=new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])
const fixture=():PhysicalArchitectureBspInput=>({key:'exact-cohort',sources:[{id:'mesh',sceneId:'plant',assetKey:'immutable-view',meshIndex:4,occurrenceId:'wall',matrix,vertices:new Float64Array([0,0,0,0,0,1,0,1,0,0,0,0,1,0,0,1,0,0,0,1,0]),lines:new Float64Array([0,0,0,1,0,0]),materials:['wall'],lineMaterials:['ink'],lineStyles:['feature']}]})
const port=()=>({onmessage:null as ((event:MessageEvent<PhysicalArchitectureBspResponse>)=>void)|null,onerror:null as ((event:ErrorEvent)=>void)|null,postMessage:(_:PhysicalArchitectureBspRequest,_transfer:Transferable[])=>{},terminated:false,terminate(){this.terminated=true}})

test('worker input copies preserve attached caller buffers and share repeated immutable geometry once',()=>{
 const input=fixture(),first=input.sources[0]!,copied=copyPhysicalArchitectureBspInput({...input,sources:[first,{...first,id:'second',meshIndex:5}]})
 expect(copied.input.sources[0]!.vertices).not.toBe(first.vertices);expect(copied.input.sources[0]!.vertices).toBe(copied.input.sources[1]!.vertices);expect(copied.transfers).toHaveLength(3)
 structuredClone(copied.input,{transfer:copied.transfers});expect(first.vertices.length).toBe(21);expect(first.matrix.length).toBe(16);expect(first.lines.length).toBe(6)
})

test('worker reply admission rejects stale keys, owner rebinding, invalid attributes/ranges and cyclic trees',()=>{
 const input=fixture(),result=preparePhysicalArchitectureBsp(input);expect(admitPhysicalArchitectureBsp(result,input)).toBe(result)
 expect(()=>admitPhysicalArchitectureBsp({...result,key:'stale'},input)).toThrow('provenance')
 expect(()=>admitPhysicalArchitectureBsp({...result,owners:[{...result.owners[0]!,sceneId:'other'}]},input)).toThrow('provenance')
 const numbers=result.vertices.slice();numbers[0]=Infinity;expect(()=>admitPhysicalArchitectureBsp({...result,vertices:numbers},input)).toThrow('provenance')
 expect(()=>admitPhysicalArchitectureBsp({...result,fragments:[{...result.fragments[0]!,count:4},...result.fragments.slice(1)]},input)).toThrow('provenance')
 expect(()=>admitPhysicalArchitectureBsp({...result,nodes:[{...result.nodes[0]!,front:0}]},input)).toThrow('provenance')
 expect(()=>admitPhysicalArchitectureBsp({...result,nodes:[{...result.nodes[0]!,fragments:[]}]},input)).toThrow('provenance')
 expect(()=>admitPhysicalArchitectureBsp({...result,fragments:result.fragments.map(f=>({...f,occludedBy:[0]}))},input)).toThrow('provenance')
})

test('each request owns its cancellation and successful worker lifetime',async()=>{
 const workers:ReturnType<typeof port>[]=[],prepare=createPhysicalArchitectureBspPreparer(()=>{const worker=port();workers.push(worker);return worker}),a=new AbortController(),input=fixture(),first=prepare(input,a.signal),second=prepare({...input,key:'other'})
 expect(prepare.diagnostics()).toEqual({workers:2,pending:2});a.abort();await expect(first).rejects.toHaveProperty('name','AbortError');expect(workers[0]!.terminated).toBe(true);expect(workers[1]!.terminated).toBe(false)
 const result=preparePhysicalArchitectureBsp({...input,key:'other'});workers[1]!.onmessage!({data:{kind:'prepared',value:result}} as MessageEvent<PhysicalArchitectureBspResponse>);expect(await second).toBe(result);expect(workers[1]!.terminated).toBe(true);expect(prepare.diagnostics()).toEqual({workers:0,pending:0})
 prepare.destroy();await expect(prepare(input)).rejects.toHaveProperty('name','AbortError')
})

test('worker failure/invalid response and host destroy release all demand without reusing a stale cohort',async()=>{
 const workers:ReturnType<typeof port>[]=[],prepare=createPhysicalArchitectureBspPreparer(()=>{const worker=port();workers.push(worker);return worker}),input=fixture(),failed=prepare(input)
 workers[0]!.onmessage!({data:{kind:'prepared',value:{...preparePhysicalArchitectureBsp(input),key:'wrong'}}} as MessageEvent<PhysicalArchitectureBspResponse>);await expect(failed).rejects.toThrow('provenance');expect(workers[0]!.terminated).toBe(true)
 const pending=prepare(input);prepare.destroy();await expect(pending).rejects.toHaveProperty('name','AbortError');expect(workers[1]!.terminated).toBe(true);expect(prepare.diagnostics()).toEqual({workers:0,pending:0})
})

test('actual module worker returns equivalent geometry and exits with no retained worker',async()=>{
 const input=fixture(),prepare=createPhysicalArchitectureBspPreparer(),expected=preparePhysicalArchitectureBsp(input),actual=await prepare(input)
 expect(actual).toEqual(expected);expect(prepare.diagnostics()).toEqual({workers:0,pending:0});expect(input.sources[0]!.vertices.length).toBe(21);prepare.destroy()
})


test('omitted authored line metadata uses the exact engine default role/style and remains admissible',()=>{
 const input=fixture(),source=input.sources[0]!,defaulted={...input,sources:[{...source,lineMaterials:undefined,lineStyles:undefined}]},result=preparePhysicalArchitectureBsp(defaulted),line=result.fragments.find(f=>f.kind==='line')!
 expect(line.material).toBe('line');expect(line.strokeStyle).toBe('feature');expect(admitPhysicalArchitectureBsp(result,defaulted)).toBe(result)
})
