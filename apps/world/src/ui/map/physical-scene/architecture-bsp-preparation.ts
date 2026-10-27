import type { PhysicalArchitectureBsp, PhysicalArchitectureBspInput, PhysicalArchitectureBspPreparer } from './architecture-bsp-types.ts'

export type PhysicalArchitectureBspRequest = { readonly kind: 'prepare'; readonly input: PhysicalArchitectureBspInput }
export type PhysicalArchitectureBspResponse = { readonly kind: 'prepared'; readonly value: PhysicalArchitectureBsp } | { readonly kind: 'error'; readonly message: string }
interface WorkerPort {
  onmessage: ((event: MessageEvent<PhysicalArchitectureBspResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  readonly postMessage: (message: PhysicalArchitectureBspRequest, transfer: Transferable[]) => void
  readonly terminate: () => void
}
const aborted = (): Error => Object.assign(new Error('Architecture BSP demand was released'),{name:'AbortError'})
const integer = (value: unknown,min: number,max: number): value is number => Number.isInteger(value)&&Number(value)>=min&&Number(value)<max
const finiteArray = (value: ArrayLike<number>,length: number): boolean => value?.length===length&&Array.from(value).every(Number.isFinite)

/** Validate the worker boundary against the exact requested cohort before any
 * derived draw resource can be adopted. It is not a source-admission shortcut. */
export const admitPhysicalArchitectureBsp = (value: PhysicalArchitectureBsp,input: PhysicalArchitectureBspInput): PhysicalArchitectureBsp => {
  const invalid=():never=>{throw new Error('Architecture BSP worker returned invalid geometry or cohort provenance')}
  if(!value||value.key!==input.key||!Array.isArray(value.owners)||value.owners.length!==input.sources.length||!(value.vertices instanceof Float64Array)||value.vertices.length%9||!value.vertices.every(Number.isFinite)||!Array.isArray(value.fragments)||!Array.isArray(value.nodes))invalid()
  value.owners.forEach((owner,index)=>{const expected=input.sources[index]!;if(!owner||owner.id!==expected.id||owner.sceneId!==expected.sceneId||owner.assetKey!==expected.assetKey||owner.meshIndex!==expected.meshIndex||owner.occurrenceId!==expected.occurrenceId)invalid()})
  let next=0
  for(const fragment of value.fragments){
    if(!fragment||!integer(fragment.ownerIndex,0,value.owners.length)||fragment.kind!=='triangle'&&fragment.kind!=='line'||fragment.first!==next||!Number.isInteger(fragment.count)||fragment.count<(fragment.kind==='line'?2:3)||fragment.count%(fragment.kind==='line'?2:3)||!Array.isArray(fragment.occludedBy)||fragment.occludedBy.some(owner=>!integer(owner,0,fragment.ownerIndex))||new Set(fragment.occludedBy).size!==fragment.occludedBy.length)invalid()
    next+=fragment.count
    const source=input.sources[fragment.ownerIndex]!
    if(fragment.kind==='triangle'?!source.materials.includes(fragment.material):!(source.lineMaterials??['line']).includes(fragment.material)||!['feature','context','section'].includes(fragment.strokeStyle??''))invalid()
  }
  if(next*9!==value.vertices.length)invalid()
  if(value.root===-1){if(value.nodes.length||value.fragments.length||value.vertices.length)invalid()}
  else if(!integer(value.root,0,value.nodes.length))invalid()
  const visited=new Set<number>(),assigned=new Set<number>(),stack=value.root<0?[]:[value.root]
  while(stack.length){const index=stack.pop()!;if(visited.has(index))invalid();visited.add(index);const node=value.nodes[index]!;if(!node||!Array.isArray(node.plane)||node.plane.length!==3||node.plane.some(p=>!finiteArray(p,3))||!finiteArray(node.normal,3)||node.normal.every(v=>v===0)||!Array.isArray(node.fragments))invalid()
    const [a,b,c]=node.plane,ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],expected=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx]
    if(expected.some((component,axis)=>component!==node.normal[axis]))invalid()
    for(const child of [node.front,node.back])if(child!==-1){if(!integer(child,0,value.nodes.length))invalid();stack.push(child)}
    for(const id of node.fragments){if(!integer(id,0,value.fragments.length)||assigned.has(id))invalid();assigned.add(id)}
  }
  if(visited.size!==value.nodes.length||assigned.size!==value.fragments.length)invalid()
  const d=value.diagnostics
  if(!d||d.inputTriangles!==input.sources.reduce((sum,source)=>sum+source.vertices.length/21,0)||d.inputLines!==input.sources.reduce((sum,source)=>sum+source.lines.length/6,0)||d.vertexBytes!==value.vertices.byteLength||![d.inputTriangles,d.inputLines,d.splitPolygons,d.splitLines,d.coplanarOverlaps,d.retainedAlternatives,d.vertexBytes].every(n=>Number.isSafeInteger(n)&&n>=0))invalid()
  return value
}

/** Own the worker copies; caller/prepared assets remain attached and reusable. */
export const copyPhysicalArchitectureBspInput = (input: PhysicalArchitectureBspInput): {readonly input:PhysicalArchitectureBspInput;readonly transfers:ArrayBuffer[]} => {
  const copies=new Map<ArrayLike<number>,Float64Array>(),transfers:ArrayBuffer[]=[]
  const copy=(values:ArrayLike<number>):Float64Array=>{let result=copies.get(values);if(!result){result=Float64Array.from(values);copies.set(values,result);transfers.push(result.buffer as ArrayBuffer)}return result}
  return {input:{key:input.key,sources:input.sources.map(source=>({...source,matrix:copy(source.matrix),vertices:copy(source.vertices),lines:copy(source.lines)}))},transfers}
}

/** One worker per actual cohort request. A released request terminates its own
 * synchronous partition immediately; it cannot cancel another host's demand.
 * Successful/error jobs also terminate, so no idle worker or source cache leaks. */
export const createPhysicalArchitectureBspPreparer = (factory:()=>WorkerPort=()=>{
  if(typeof Worker==='undefined')throw new Error('Architecture BSP requires a module Worker')
  return new Worker(new URL('./architecture-bsp-worker.ts',import.meta.url),{type:'module'})
}):PhysicalArchitectureBspPreparer=>{
  const pending=new Map<WorkerPort,{readonly cancel:()=>void}>();let closed=false
  const prepare=Object.assign((input:PhysicalArchitectureBspInput,signal?:AbortSignal):Promise<PhysicalArchitectureBsp>=>{
    if(closed||signal?.aborted)return Promise.reject(aborted())
    return new Promise((resolve,reject)=>{
      let worker:WorkerPort
      try{worker=factory()}catch(error){reject(error);return}
      let settled=false
      const finish=(error?:unknown,value?:PhysicalArchitectureBsp):void=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);pending.delete(worker);worker.onmessage=null;worker.onerror=null;worker.terminate();if(error)reject(error);else resolve(value!)}
      const cancel=():void=>finish(aborted());pending.set(worker,{cancel});signal?.addEventListener('abort',cancel,{once:true})
      worker.onerror=event=>finish(new Error(event.message||'Architecture BSP worker failed'))
      worker.onmessage=event=>{try{if(event.data?.kind==='error')finish(new Error(event.data.message));else if(event.data?.kind==='prepared')finish(undefined,admitPhysicalArchitectureBsp(event.data.value,input));else finish(new Error('Architecture BSP worker returned an unknown response'))}catch(error){finish(error)}}
      try{const copied=copyPhysicalArchitectureBspInput(input);worker.postMessage({kind:'prepare',input:copied.input},copied.transfers)}catch(error){finish(error)}
    })
  },{destroy:():void=>{closed=true;for(const job of [...pending.values()])job.cancel()},diagnostics:()=>({workers:pending.size,pending:pending.size})})
  return prepare
}
