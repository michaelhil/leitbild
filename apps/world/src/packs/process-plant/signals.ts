import { z } from 'zod'
import type {
  CompiledComponent,
  CompiledPlantGraph,
  ProcessSignalBinding,
  ProcessSignalTagId,
  ProcessVariableCapability,
  ProcessVariableLimits,
  ProcessEquipmentId,
  VariablePath,
} from './graph/index.ts'
import type { ProcessQuantity, ProcessUnit, VariableDiscipline, VariableKind } from './graph/index.ts'
import { processSignalTagIdSchema, variablePathSchema } from './graph/index.ts'
import type { ProcessPlantRuntime, ProcessPlantVariableSnapshot } from './runtime/index.ts'
import type { CompiledProcessPlant } from './plant-compiler.ts'
import { rejectCapabilityTarget } from '../../simulation/capability-rejection.ts'

export const processPlantSignalReferenceSchema = z.object({
  path: variablePathSchema.optional(),
  tagId: processSignalTagIdSchema.optional(),
}).strict().superRefine((reference, ctx) => {
  const referenceCount = Number(reference.path !== undefined) + Number(reference.tagId !== undefined)
  if (referenceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'process signal reference must define exactly one of path or tagId',
    })
  }
})
export type ProcessPlantSignalReference = z.infer<typeof processPlantSignalReferenceSchema>

export const resolveProcessPlantSignalBinding = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): ProcessSignalBinding => {
  if (reference.path !== undefined) {
    const binding = graph.signalBindingByPath.get(reference.path)
    if (!binding) return rejectCapabilityTarget(
      `Process Plant signal path not found: ${reference.path}. Discover exact paths with world.process-plant.signals.search.`,
    )
    return binding
  }
  if (reference.tagId !== undefined) {
    const binding = graph.signalBindingByTagId.get(reference.tagId)
      ?? graph.signalBindingByExternalRef.get(reference.tagId)
    if (!binding) return rejectCapabilityTarget(
      `Process Plant signal tag not found: ${reference.tagId}. Discover exact tags with world.process-plant.signals.search.`,
    )
    return binding
  }
  throw new Error('process signal reference must define path or tagId')
}

/**
 * A fault the scenario injects (a valve's failure, a leak's area) is the
 * instructor's knob, never a reading, and so is the model's truth about it
 * (a leak's flow, a tube leak's flow: faultTruth), which no control room
 * measures: no person or AI agent searches, reads, evaluates, records or is
 * shown either, so the fault shows only through its symptoms. Instructor
 * actions and the Scenario set it through their own path. A boundary (the
 * grid's frequency) is a condition outside the Plant that its instruments
 * read, and stays a reading.
 */
export const isInjectedFault = (binding: Pick<ProcessSignalBinding, 'actuation' | 'faultTruth'>): boolean =>
  binding.actuation === 'faultInjection' || binding.faultTruth === true

/** A signal as a person or AI agent reads it: refused, with why, where it is a fault the scenario injects. */
export const readableProcessPlantSignalBinding = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): ProcessSignalBinding => {
  const binding = resolveProcessPlantSignalBinding(graph, reference)
  if (!isInjectedFault(binding)) return binding
  return rejectCapabilityTarget(binding.faultTruth === true
    ? `${binding.tagId ?? binding.path} is the model's truth about an injected fault, not a reading: no person or AI agent reads it`
    : `${binding.tagId ?? binding.path} is a fault the scenario injects, not a reading: no person or AI agent reads it`)
}

/** Refuses a condition a person or AI agent asks to evaluate where any signal it compares is a fault the scenario injects. */
export const refuseInjectedFaultsIn = (graph: CompiledPlantGraph, condition: unknown): void => {
  if (Array.isArray(condition)) {
    for (const entry of condition) refuseInjectedFaultsIn(graph, entry)
    return
  }
  if (condition === null || typeof condition !== 'object') return
  for (const [key, entry] of Object.entries(condition)) {
    const reference = key === 'signal' ? processPlantSignalReferenceSchema.safeParse(entry) : undefined
    if (reference?.success === true) readableProcessPlantSignalBinding(graph, reference.data)
    else refuseInjectedFaultsIn(graph, entry)
  }
}

export const findProcessPlantSignalBinding = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): ProcessSignalBinding | undefined => {
  if (reference.path !== undefined) return graph.signalBindingByPath.get(reference.path)
  if (reference.tagId !== undefined) {
    return graph.signalBindingByTagId.get(reference.tagId)
      ?? graph.signalBindingByExternalRef.get(reference.tagId)
  }
  return undefined
}

/**
 * The component a signal is measured on: the component that owns it, or for a
 * line's signal the equipment the line flows into. Its declared equipmentId is
 * metadata and may name no component.
 */
export const signalMeasuredOn = (
  graph: CompiledPlantGraph,
  owner: ProcessSignalBinding['owner'],
): CompiledComponent =>
  graph.components[owner.type === 'component' ? owner.componentIndex : graph.links[owner.linkIndex]!.toComponentIndex]!

/**
 * The declared element a signal is measured on, as a procedure tag opens it (plan v5 W3.1, D-E): the device its
 * component bundles where the signal is one of that device's variables (the pressurizer's PORV for PORV-456A), named
 * `<component>.<device>` as the observation declaration names it, else the component it is measured on.
 */
export const signalMeasuredOnElement = (
  graph: CompiledPlantGraph,
  binding: Pick<ProcessSignalBinding, 'owner' | 'path'>,
): string => {
  const component = signalMeasuredOn(graph, binding.owner)
  const device = binding.owner.type === 'component' ? component.semantics.embedded.find(entry => entry.variables.includes(binding.path)) : undefined
  return device === undefined ? String(component.id) : `${component.id}.${device.id}`
}

export const resolveProcessPlantSignalPath = (
  graph: CompiledPlantGraph,
  reference: ProcessPlantSignalReference,
): VariablePath => resolveProcessPlantSignalBinding(graph, reference).path

export interface ProcessPlantSignalView {
  readonly path: VariablePath
  readonly tagId?: ProcessSignalTagId
  readonly equipmentId?: ProcessEquipmentId
  readonly description?: string
  readonly externalRefs?: ReadonlyArray<string>
  readonly capabilities?: ProcessVariableCapability
  readonly limits?: ProcessVariableLimits
  readonly label: string
  readonly kind: VariableKind
  readonly discipline: VariableDiscipline
  readonly quantity: ProcessQuantity
  readonly unit: ProcessUnit
  readonly writable: boolean
  readonly simulatorOnly?: true
  readonly published: boolean
  readonly owner: ProcessSignalBinding['owner']
}

export interface ProcessPlantSignalQuality {
  readonly status: 'good' | 'outside-hard-range' | 'unavailable'
  readonly reason?: string
}

export const processPlantSignalView = (binding: ProcessSignalBinding): ProcessPlantSignalView => ({
  path: binding.path,
  ...(binding.tagId === undefined ? {} : { tagId: binding.tagId }),
  ...(binding.equipmentId === undefined ? {} : { equipmentId: binding.equipmentId }),
  ...(binding.description === undefined ? {} : { description: binding.description }),
  ...(binding.externalRefs === undefined ? {} : { externalRefs: binding.externalRefs }),
  ...(binding.capabilities === undefined ? {} : { capabilities: binding.capabilities }),
  ...(binding.limits === undefined ? {} : { limits: binding.limits }),
  label: binding.label,
  kind: binding.kind,
  discipline: binding.discipline,
  quantity: binding.quantity,
  unit: binding.unit,
  writable: binding.writable,
  ...(binding.simulatorOnly === undefined ? {} : { simulatorOnly: binding.simulatorOnly }),
  published: binding.published,
  owner: binding.owner,
})

export const processPlantSignalQuality = (
  variable: ProcessPlantVariableSnapshot,
  context: { readonly system: CompiledProcessPlant; readonly runtime: Pick<ProcessPlantRuntime, 'readVariableSnapshot'> },
): ProcessPlantSignalQuality => {
  for (const flag of meaningfulFlags(context.system.graph).get(variable.path) ?? []) {
    let available: boolean
    try { available = context.runtime.readVariableSnapshot(flag).value === true }
    catch (error) { return { status: 'unavailable', reason: `${variable.path} qualification ${flag} cannot be read: ${error instanceof Error ? error.message : String(error)}` } }
    if (!available) {
      const binding = context.system.graph.signalBindingByPath.get(flag)
      const component = binding?.owner.type === 'component' ? context.system.graph.components[binding.owner.componentIndex] : undefined
      const local = component === undefined ? '' : String(flag).slice(String(component.id).length + 1)
      const label = component?.metadata?.presentation?.states?.[local]?.on ?? binding?.label ?? String(flag)
      return { status: 'unavailable', reason: `measures nothing unless ${label}` }
    }
  }
  if (typeof variable.value !== 'number') return { status: 'good' }
  if (!Number.isFinite(variable.value)) return { status: 'outside-hard-range', reason: `${variable.path} is not finite` }
  const hardRange = variable.limits?.hardRange
  if (hardRange === undefined) return { status: 'good' }
  if (variable.value < hardRange.min || variable.value > hardRange.max) {
    return {
      status: 'outside-hard-range',
      reason: `${variable.path} value ${variable.value} is outside hard range ${hardRange.min}..${hardRange.max} ${variable.unit}`,
    }
  }
  return { status: 'good' }
}

const meaningfulFlagCache = new WeakMap<CompiledPlantGraph, ReadonlyMap<VariablePath, ReadonlyArray<VariablePath>>>()
/** One canonical model declaration governs indicated-value validity in live
 * signals, recording, display observations, procedures and response evidence. */
const meaningfulFlags = (graph: CompiledPlantGraph): ReadonlyMap<VariablePath, ReadonlyArray<VariablePath>> => {
  const retained = meaningfulFlagCache.get(graph)
  if (retained) return retained
  const result = new Map<VariablePath, VariablePath[]>()
  for (const component of graph.components) for (const rule of component.semantics.meaningfulWhile) {
    for (const variable of rule.variables) result.set(variable, [...result.get(variable) ?? [], rule.flag])
  }
  meaningfulFlagCache.set(graph, result)
  return result
}
