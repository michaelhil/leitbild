import { createHash } from 'node:crypto'
import { z } from 'zod'
import { engineeringInputBasisSchema, engineeringQualificationResultSchema, type EngineeringInputBasis, type WorkspaceResourceReference } from '@leitbild/contracts'
import type { ExecutionStore } from '../core/executions/store.ts'
import type { Tool, ToolContext } from '../core/types/tool.ts'
import { engineeringDatumSchema, type EngineeringDatum, type EngineeringMethodInput } from '../core/calculations/engineering-methods.ts'
import { retainedWorkspaceResults } from './retained-workspace-call.ts'

const name = engineeringDatumSchema.shape.name
export const engineeringBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retained'), name, turnId: z.string().min(1), toolCallId: z.string().min(1), key: z.string().min(1), quantityId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('assumption'), name, value: z.number().finite(), quantity: z.string().min(1).max(80), unit: z.string().min(1).max(40), simulationAt: engineeringDatumSchema.shape.simulationAt, note: z.string().min(1).max(1000) }).strict(),
])
export const engineeringBindingsSchema = z.array(engineeringBindingSchema).min(1).max(32).refine(bindings => new Set(bindings.map(binding => binding.name)).size === bindings.length, 'Binding names must be unique')
export type EngineeringBinding = z.infer<typeof engineeringBindingSchema>
export interface EngineeringObservationRef { readonly name:string; readonly basisDigest:string; readonly quantityId:string }
export const engineeringDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const engineeringQualificationKey = (basis:EngineeringInputBasis):string => JSON.stringify([basis.source,basis.profile,basis.profileRevision,basis.subjectId,basis.frame.epoch,basis.frame.scenarioDigest,basis.frame.restrictionRevision])
export const engineeringFailure = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
const equalResource = (left: WorkspaceResourceReference, right: WorkspaceResourceReference): boolean => left.workspaceId === right.workspaceId && left.moduleId === right.moduleId && left.type === right.type && left.id === right.id

export const retainedEngineeringBasis = (store: ExecutionStore, roomId: string, binding: Extract<EngineeringBinding, {kind:'retained'}>, workspaceId: string): EngineeringInputBasis => {
  const call = store.getCall(roomId, binding.turnId, binding.toolCallId)
  if (!call) return engineeringFailure('input_missing', 'The referenced execution is absent from this Room')
  const result = retainedWorkspaceResults([call]).find(entry => entry.key === binding.key)
  if (!result?.success || result.operationId !== 'world.engineering.inputs.capture' || !result.resource) return engineeringFailure('input_not_capture', 'Input must refer to a successful retained engineering owner capture')
  const parsed = engineeringInputBasisSchema.safeParse(result.data)
  if (!parsed.success) return engineeringFailure('input_contract_invalid', 'The retained owner basis does not satisfy the engineering contract')
  const basis = parsed.data
  if (basis.source.workspaceId !== workspaceId || !equalResource(basis.source, result.resource)) return engineeringFailure('input_source_mismatch', 'Captured source differs from the resolved invocation target')
  const request = result.input as {profile?:unknown;subjectId?:unknown} | undefined
  if (request?.profile !== basis.profile || request?.subjectId !== basis.subjectId) return engineeringFailure('input_request_mismatch', 'Captured profile or subject differs from the invocation')
  return basis
}

export const invokeEngineeringOwner = async (workspaceCall: Tool, context: ToolContext, source: WorkspaceResourceReference, operationId: string, input: unknown) => {
  const outcome = await workspaceCall.execute({calls:[{key:'basis',operationId,target:{kind:'resource',ref:source},input}]},context)
  const entries = (outcome.data as {results?:Array<{success:boolean;data?:unknown;error?:string}>}|undefined)?.results
  const entry = entries?.[0]
  if (!outcome.success || !entry?.success) return engineeringFailure('source_refused', entry?.error ?? outcome.error ?? 'Owner refused the engineering source')
  return entry.data
}
export const qualifyEngineeringBasis = async (workspaceCall: Tool, context: ToolContext, basis: EngineeringInputBasis) => {
  try {
    const result = await invokeEngineeringOwner(workspaceCall, context, basis.source, 'world.engineering.inputs.qualify', {
      profile:basis.profile, profileRevision:basis.profileRevision, subjectId:basis.subjectId,
      frame:{epoch:basis.frame.epoch,scenarioDigest:basis.frame.scenarioDigest,restrictionRevision:basis.frame.restrictionRevision},
    })
    return engineeringQualificationResultSchema.parse(result)
  } catch (error) {
    return {allowed:false,code:'source_unavailable',reason:error instanceof Error ? error.message : String(error)}
  }
}

export const bindEngineeringInputs = async (deps: {store:ExecutionStore;workspaceId:string;workspaceCall:Tool}, context: ToolContext, bindings: readonly EngineeringBinding[]) => {
  if (!context.roomId) return engineeringFailure('room_required','Engineering calculations require a Room')
  const sources: EngineeringInputBasis[] = []
  const inputs: EngineeringDatum[] = []
  const observationRefs:EngineeringObservationRef[] = []
  const qualified = new Set<string>()
  for (const binding of bindings) {
    if (binding.kind === 'assumption') {
      inputs.push({name:binding.name,value:binding.value,quantity:binding.quantity,unit:binding.unit,...(binding.simulationAt ? {simulationAt:binding.simulationAt}:{}),quality:'good',origin:'assumption'})
      continue
    }
    const basis = retainedEngineeringBasis(deps.store, context.roomId, binding, deps.workspaceId)
    if (!sources.some(source => source.digest === basis.digest)) {
      const key = engineeringQualificationKey(basis)
      if (!qualified.has(key)) {
        const qualification = await qualifyEngineeringBasis(deps.workspaceCall, context, basis)
        if (!qualification.allowed) return engineeringFailure(qualification.code ?? 'source_refused', qualification.reason ?? 'Source is no longer qualified')
        qualified.add(key)
      }
      sources.push(basis)
    }
    const quantity = basis.quantities.find(item => item.id === binding.quantityId)
    if (!quantity) return engineeringFailure('quantity_missing','The requested quantity is absent from the retained owner basis')
    if (quantity.quality !== 'good') return engineeringFailure('input_quality_unknown','Unknown-quality observations cannot become numerical evidence; use an explicitly described assumption instead')
    inputs.push({name:binding.name,value:quantity.value,quantity:quantity.quantity,unit:quantity.unit,simulationAt:basis.frame.simulationAt,quality:quantity.quality,origin:'observation'})
    observationRefs.push({name:binding.name,basisDigest:basis.digest,quantityId:quantity.id})
  }
  return {inputs,sources,observationRefs,inputDigest:engineeringDigest({inputs,observationRefs,sources:sources.map(source=>source.digest),assumptions:bindings.filter(binding=>binding.kind==='assumption')})}
}

/** A reviewed rate series belongs to one signal and one trajectory. Separate
 * reservoir streams may deliberately have different sources. */
export const assertEngineeringSeries = (request:EngineeringMethodInput,bound:Awaited<ReturnType<typeof bindEngineeringInputs>>):void => {
  const series=request.method==='sample_changes'?[request.samples]:request.streams.map(stream=>stream.samples)
  for(const names of series){
    const identities=names.map(name=>{
      const ref=bound.observationRefs.find(ref=>ref.name===name)
      if(!ref)return 'assumption'
      const basis=bound.sources.find(basis=>basis.digest===ref.basisDigest)!
      return JSON.stringify([basis.source,basis.profile,basis.profileRevision,basis.subjectId,basis.frame.epoch,basis.frame.scenarioDigest,ref.quantityId])
    })
    if(new Set(identities).size>1)engineeringFailure('series_lineage_mismatch','Each reviewed time series must contain one observed signal in one Run trajectory, or only explicit assumptions')
  }
}

/** Refreshing a snapshot is supported; inventing a replacement time window is not. */
export const assertSnapshotRefresh = (bases:readonly EngineeringInputBasis[]):void => {
  const frames=new Map<string,Set<string>>()
  for(const basis of bases){
    const key=JSON.stringify([basis.source,basis.profile,basis.subjectId])
    const times=frames.get(key)??new Set<string>()
    times.add(JSON.stringify([basis.frame.epoch,basis.frame.sequence,basis.frame.simulationAt]))
    frames.set(key,times)
  }
  if([...frames.values()].some(times=>times.size>1))engineeringFailure('refresh_interval_unsupported','This result uses a historical time window. Rerun its retained evidence or acquire a new dated sample window; snapshot refresh cannot replace an interval')
}
