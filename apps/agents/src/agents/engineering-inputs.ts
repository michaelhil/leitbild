import { createHash } from 'node:crypto'
import { z } from 'zod'
import { engineeringInputBasisSchema, engineeringQualificationResultSchema, type EngineeringInputBasis, type WorkspaceResourceReference } from '@leitbild/contracts'
import type { ExecutionStore } from '../core/executions/store.ts'
import type { Tool, ToolContext } from '../core/types/tool.ts'
import { engineeringDatumSchema, type EngineeringDatum } from '../core/calculations/engineering-methods.ts'
import { retainedWorkspaceResults } from './retained-workspace-call.ts'

const name = engineeringDatumSchema.shape.name
export const engineeringBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retained'), name, turnId: z.string().min(1), toolCallId: z.string().min(1), key: z.string().min(1), quantityId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('assumption'), name, value: z.number().finite(), quantity: z.string().min(1).max(80), unit: z.string().min(1).max(40), simulationAt: engineeringDatumSchema.shape.simulationAt, note: z.string().min(1).max(1000) }).strict(),
])
export const engineeringBindingsSchema = z.array(engineeringBindingSchema).min(1).max(32).refine(bindings => new Set(bindings.map(binding => binding.name)).size === bindings.length, 'Binding names must be unique')
export type EngineeringBinding = z.infer<typeof engineeringBindingSchema>
export const engineeringDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
  for (const binding of bindings) {
    if (binding.kind === 'assumption') {
      inputs.push({name:binding.name,value:binding.value,quantity:binding.quantity,unit:binding.unit,...(binding.simulationAt ? {simulationAt:binding.simulationAt}:{}),quality:'good',origin:'assumption'})
      continue
    }
    const basis = retainedEngineeringBasis(deps.store, context.roomId, binding, deps.workspaceId)
    if (!sources.some(source => source.digest === basis.digest)) {
      const qualification = await qualifyEngineeringBasis(deps.workspaceCall, context, basis)
      if (!qualification.allowed) return engineeringFailure(qualification.code ?? 'source_refused', qualification.reason ?? 'Source is no longer qualified')
      sources.push(basis)
    }
    const quantity = basis.quantities.find(item => item.id === binding.quantityId)
    if (!quantity) return engineeringFailure('quantity_missing','The requested quantity is absent from the retained owner basis')
    if (quantity.quality !== 'good') return engineeringFailure('input_quality_unknown','Unknown-quality observations cannot become numerical evidence; use an explicitly described assumption instead')
    inputs.push({name:binding.name,value:quantity.value,quantity:quantity.quantity,unit:quantity.unit,simulationAt:basis.frame.simulationAt,quality:quantity.quality,origin:'observation'})
  }
  return {inputs,sources,inputDigest:engineeringDigest({inputs,sources:sources.map(source=>source.digest),assumptions:bindings.filter(binding=>binding.kind==='assumption')})}
}
