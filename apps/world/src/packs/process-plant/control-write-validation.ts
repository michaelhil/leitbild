import type { ProcessPlantControlWritePayload } from './commands.ts'
import type { VariablePath } from './graph/index.ts'
import type { CompiledProcessPlantSystem } from './process-systems.ts'
import type { ProcessPlantProtectionRunner, ProcessPlantRuntime, ProcessPlantValue } from './runtime/index.ts'
import { assertProcessPlantVariableValueValid } from './runtime/variable-validation.ts'
import {
  processPlantSignalView,
  resolveProcessPlantSignalBinding,
  type ProcessPlantSignalReference,
  type ProcessPlantSignalView,
} from './signals.ts'

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
  readonly system: CompiledProcessPlantSystem
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
