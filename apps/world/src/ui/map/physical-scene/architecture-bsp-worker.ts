import { preparePhysicalArchitectureBsp } from './architecture-bsp.ts'
import type { PhysicalArchitectureBspRequest, PhysicalArchitectureBspResponse } from './architecture-bsp-preparation.ts'
const scope=globalThis as unknown as {
  onmessage:((event:MessageEvent<PhysicalArchitectureBspRequest>)=>void)|null
  postMessage:(response:PhysicalArchitectureBspResponse,transfer:Transferable[])=>void
}
scope.onmessage=event=>{
  try{
    if(event.data?.kind!=='prepare')throw new Error('Architecture BSP worker received an unknown request')
    const value=preparePhysicalArchitectureBsp(event.data.input)
    scope.postMessage({kind:'prepared',value},[value.vertices.buffer])
  }catch(error){scope.postMessage({kind:'error',message:error instanceof Error?error.message:String(error)},[])}
}
