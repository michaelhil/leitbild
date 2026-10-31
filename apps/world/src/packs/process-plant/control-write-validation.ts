import type { ProcessPlantControlWritePayload } from './commands.ts'
import type { CompiledComponent, CompiledPlantGraph, VariablePath } from './graph/index.ts'
import { operatorControllerBindings, valvePositionController } from './graph/valve-controller.ts'
import type { CompiledProcessPlant } from './plant-compiler.ts'
import type { ProcessPlantProtectionRunner, ProcessPlantRuntime, ProcessPlantValue } from './runtime/index.ts'
import { assertProcessPlantVariableValueValid } from './runtime/variable-validation.ts'
import { componentVariablePath } from './runtime/behavior-contract.ts'
import {
  processPlantSignalView,
  resolveProcessPlantSignalBinding,
  type ProcessPlantSignalReference,
  type ProcessPlantSignalView,
} from './signals.ts'

// Immutable graph bindings only; ownership and physical holds are read afresh for every command/ramp application.
const controlledPositions = new WeakMap<CompiledPlantGraph, ReadonlyMap<VariablePath, CompiledComponent>>()
const controllerForPosition = (graph: CompiledPlantGraph, path: VariablePath): CompiledComponent | undefined => {
  let positions = controlledPositions.get(graph)
  if (positions === undefined) {
    positions = new Map(graph.components.flatMap(component => operatorControllerBindings(component) === null
      ? [] : [[componentVariablePath(component, 'positionFraction'), component] as const]))
    controlledPositions.set(graph, positions)
  }
  return positions.get(path)
}

/** The existing controller's authority over a manual position, including physical constraints in MAN. */
export const manualControllerPositionRefusal = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly path: VariablePath
  /** Absent when asking whether an ongoing manual ramp may apply at all. */
  readonly value?: ProcessPlantValue
}): string | null => {
  const component = controllerForPosition(config.system.graph, config.path)
  if (component === undefined) return null
  const bindings = operatorControllerBindings(component)!
  const controller = valvePositionController(component)!
  if (config.runtime.readVariable(bindings.automatic) === true) return `${config.path} is owned by its automatic controller; select MAN before setting or ramping its manual position`
  if (config.runtime.readVariable(componentVariablePath(component, 'isolationSignal')) === true && config.value !== 0) return `${config.path} is held closed by its isolation signal`
  if (controller.permissive !== undefined) {
    const measured = config.runtime.readVariable(controller.permissive.path)
    if (typeof measured !== 'number') throw new Error(`valve controller permissive is not numeric: ${controller.permissive.path}`)
    if (measured < controller.permissive.minimum && config.value !== controller.minPositionFraction) return `${config.path} is held at ${controller.minPositionFraction}: ${controller.permissive.path} must be at least ${controller.permissive.minimum} before its controller permits opening`
  }
  return null
}

export type ProcessPlantControlWriteValidation =
  | {
      readonly accepted: true
      readonly signal: ProcessPlantSignalView
      readonly targetPath: VariablePath
      readonly currentValue: ProcessPlantValue
    }
  | {
      readonly accepted: false
      readonly reason: string
      readonly signal: ProcessPlantSignalView
      readonly targetPath: VariablePath
      readonly currentValue: ProcessPlantValue
    }

export const signalReferenceForControlWrite = (payload: ProcessPlantControlWritePayload): ProcessPlantSignalReference => {
  if (payload.path !== undefined) return { path: payload.path }
  if (payload.tagId !== undefined) return { tagId: payload.tagId }
  throw new Error('process plant control write must define exactly one of path or tagId')
}

export const validateProcessPlantControlWrite = (config: {
  readonly system: CompiledProcessPlant
  readonly runtime: ProcessPlantRuntime
  readonly protection?: ProcessPlantProtectionRunner
  readonly payload: ProcessPlantControlWritePayload
}): ProcessPlantControlWriteValidation => {
  const signal = signalReferenceForControlWrite(config.payload)
  const binding = resolveProcessPlantSignalBinding(config.system.graph, signal)
  const view = processPlantSignalView(binding)
  const currentValue = config.runtime.readVariableSnapshot(binding.path).value
  if (!binding.writable) {
    return {
      accepted: false,
      reason: `process plant signal is not writable: ${binding.path}`,
      signal: view,
      targetPath: binding.path,
      currentValue,
    }
  }
  const variable = config.system.graph.variables.find(candidate => candidate.path === binding.path)
  if (!variable) throw new Error(`process plant signal binding references unknown variable path: ${binding.path}`)
  try {
    assertProcessPlantVariableValueValid(variable, config.payload.value)
  } catch (err) {
    return {
      accepted: false,
      reason: err instanceof Error ? err.message : String(err),
      signal: view,
      targetPath: binding.path,
      currentValue,
    }
  }
  const gate = config.protection?.evaluateWrite({
    runtime: config.runtime,
    signal,
    elapsedMs: config.runtime.elapsedMs(),
  })
  if (gate && !gate.ok) {
    return {
      accepted: false,
      reason: gate.reason,
      signal: view,
      targetPath: binding.path,
      currentValue,
    }
  }
  return {
    accepted: true,
    signal: view,
    targetPath: binding.path,
    currentValue,
  }
}
