import type { CompiledPlantGraph, VariablePath } from './graph/index.ts'
import type { ProcessPlantIcConfig } from './runtime/index.ts'
import { resolveProcessPlantSignalBinding } from './signals.ts'

/**
 * A protection action is applied on entry; a normal controller runs every
 * numerical step. A one-time position demand alone therefore cannot hold an
 * operator-controlled valve shut. Require the existing physical isolation input
 * in the same action rather than introducing another solver-side latch.
 */
export const assertControllerProtectionIsolation = (graph: CompiledPlantGraph, automation: ProcessPlantIcConfig): void => {
  const controlledWrites = new Map<VariablePath, { readonly id: string; readonly isolation: VariablePath; readonly position: boolean }>()
  const controlledIsolations = new Set<VariablePath>()
  for (const component of graph.components) {
    if (component.kind !== 'processValve' && component.kind !== 'steamValve') continue
    const controller = (component.parameters as { readonly controller?: { readonly operator?: unknown } }).controller
    if (controller?.operator === undefined) continue
    controlledIsolations.add(`${component.id}.isolationSignal` as VariablePath)
    for (const local of ['positionFraction', 'controllerAutomatic', 'controllerSetpoint']) {
      controlledWrites.set(`${component.id}.${local}` as VariablePath, { id: String(component.id), isolation: `${component.id}.isolationSignal` as VariablePath, position: local === 'positionFraction' })
    }
  }
  for (const rule of automation.rules) {
    if (rule.ruleClass !== 'protection' && rule.ruleClass !== 'interlock') continue
    const writes = rule.effects.flatMap(effect => effect.type === 'writeSignal'
      ? [{ path: resolveProcessPlantSignalBinding(graph, effect.signal).path, value: effect.value }]
      : [])
    for (const isolation of controlledIsolations) {
      const values = writes.filter(write => write.path === isolation).map(write => write.value)
      if (values.some(value => value === true) && values.some(value => value !== true)) {
        throw new Error(`process plant I&C rule ${rule.id} both asserts and releases ${isolation}`)
      }
    }
    for (const write of writes) {
      const controller = controlledWrites.get(write.path)
      if (controller === undefined) continue
      const isolationWrites = writes.filter(effect => effect.path === controller.isolation)
      if ((controller.position && write.value !== 0) || isolationWrites.length === 0 || isolationWrites.some(effect => effect.value !== true)) {
        throw new Error(`process plant I&C rule ${rule.id} cannot hold operator-controlled valve ${controller.id} through a position, mode or setpoint demand; close it with its isolationSignal`)
      }
    }
  }
}
