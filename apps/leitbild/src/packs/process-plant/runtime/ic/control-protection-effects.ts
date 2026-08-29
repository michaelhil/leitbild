import type { CompiledProcessPlantSystem } from '../../process-systems.ts'
import { resolveProcessPlantSignalBinding, type ProcessPlantSignalReference } from '../../signals.ts'
import type { ProcessPlantRuntime } from '../model.ts'
import type { ProcessPlantIcEffect } from './control-protection-model.ts'

export const processPlantIcWriteTargetPath = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly signal: ProcessPlantSignalReference
}) => resolveProcessPlantSignalBinding(config.system.graph, config.signal).path

export const applyProcessPlantIcWriteEffect = (config: {
  readonly system: CompiledProcessPlantSystem
  readonly runtime: ProcessPlantRuntime
  readonly effect: Extract<ProcessPlantIcEffect, { readonly type: 'writeSignal' }>
  readonly evaluateWrite: (signal: ProcessPlantSignalReference) => { readonly ok: true } | { readonly ok: false; readonly reason: string }
}): void => {
  const gate = config.evaluateWrite(config.effect.signal)
  if (!gate.ok) throw new Error(gate.reason)
  const binding = resolveProcessPlantSignalBinding(config.system.graph, config.effect.signal)
  config.runtime.writeCommand({
    type: 'setVariable',
    path: binding.path,
    value: config.effect.value,
  })
}
