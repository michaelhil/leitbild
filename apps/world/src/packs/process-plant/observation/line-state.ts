import type {CompiledPlantGraph,ProcessSignalBinding,VariablePath} from '../graph/index.ts'
import {isInjectedFault} from '../signals.ts'

interface LineStateSignal { readonly role:'flow'|'conducting'; readonly signal:ProcessSignalBinding }
interface LineStateSignals { readonly byLink:ReadonlyMap<string,ReadonlyArray<LineStateSignal>>; readonly paths:ReadonlySet<VariablePath> }
const cached=new WeakMap<CompiledPlantGraph,LineStateSignals>()

/** The Pack's solved primary line readings, independently from its compact
 * push-telemetry list. A fluid line owns signed mass flow; an electrical line
 * owns energized state, which says nothing about signed power. Neither is
 * inferred from adjacent equipment or from an injected-fault truth variable.
 * The graph compiler defines these exact line-variable names and units. */
export const lineStateSignals=(graph:CompiledPlantGraph):LineStateSignals=>{
  const known=cached.get(graph)
  if(known)return known
  const byLink=new Map<string,ReadonlyArray<LineStateSignal>>(),paths=new Set<VariablePath>()
  for(const link of graph.links){
    const role=link.kind==='fluidFlow'?'flow':link.kind==='electricalPower'?'conducting':undefined
    if(!role)continue
    const local=role==='flow'?'flowKgPerS':'energized'
    const variable=link.variables.find(variable=>String(variable.path)===`${link.id}.${local}`)
    const signal=variable&&graph.signalBindingByPath.get(variable.path)
    if(!signal||signal.capabilities?.readable!==true||isInjectedFault(signal))continue
    if(role==='flow'?(signal.quantity!=='flowRate'||signal.unit!=='kg/s'):(signal.quantity!=='boolean'||signal.unit!=='boolean'))throw Error(`Primary line-state signal has incompatible quantity or unit: ${signal.path}`)
    byLink.set(String(link.id),[{role,signal}])
    paths.add(signal.path)
  }
  const value={byLink,paths}
  cached.set(graph,value)
  return value
}
