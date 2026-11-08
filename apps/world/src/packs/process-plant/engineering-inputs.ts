import { engineeringOwnerInputSchema, engineeringProjectionCapability } from '../../simulation/engineering-inputs.ts'
import { unavailableQueryReadScope, type QueryReadPolicy } from '../../simulation/query-read-policy.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { isInjectedFault, processPlantSignalQuality, resolveProcessPlantSignalBinding } from './signals.ts'
import { operatingPointReading } from './operating-point.ts'
import { variablePathSchema } from './graph/model.ts'

export const processPlantEngineeringCapability = engineeringProjectionCapability('world.process-plant.engineering-basis')
const measurements = ['TAVG', 'core.totalThermalPowerMw'] as const
export const readProcessPlantEngineeringInputs = (config: {
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>; policy: QueryReadPolicy; input: unknown
}) => {
  const input = engineeringOwnerInputSchema.parse(config.input)
  const instance = config.plants.get(input.subjectId)
  const refuse = (): never => unavailableQueryReadScope('This source is outside the shared engineering research profile')
  if (!instance || !config.policy.canInspect(input.subjectId)) return refuse()
  const { plant, runtime } = instance
  if (plant.modelRef !== 'process-plant.pwr.reference' || runtime.domainEnd?.() != null) return refuse()
  if (instance.operations?.snapshot()?.proposals.some(proposal => proposal.status === 'pending')) return refuse()
  // Fault controls are never returned. This first profile supports the authored
  // no-fault exercise; later injected faults require a separate admission.
  for (const binding of plant.graph.signalBindingByPath.values()) {
    if (binding.actuation === 'faultInjection' && runtime.readVariable(binding.path) !== operatingPointReading(plant, binding.path)) return refuse()
  }
  if (input.purpose === 'qualify') return { allowed: true }
  const quantities = measurements.map(id => {
    const binding = resolveProcessPlantSignalBinding(plant.graph, id.includes('.') ? { path: variablePathSchema.parse(id) } : { tagId: id as never })
    if (!binding.published || isInjectedFault(binding) || binding.simulatorOnly || binding.capabilities?.aiVisible === false) return refuse()
    const value = runtime.readVariableSnapshot(binding.path)
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return refuse()
    return { id, label: binding.label, quantity: value.quantity, unit: binding.unit, value: value.value,
      quality: processPlantSignalQuality(value, { system: plant, runtime }).status === 'good' ? 'good' : 'unknown' }
  })
  return { modelElapsedMs: runtime.elapsedMs(), modelDigest: plant.modelDigest, domainEnd: runtime.domainEnd?.() ?? null, quantities }
}
