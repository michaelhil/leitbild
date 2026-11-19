import { z } from 'zod'
import { planningProjectionInputSchema, type PlanningFact, type PlanningFactBasis, type PlanningSubject } from '@leitbild/contracts'
import { planningProjectionCapability } from '../../simulation/planning-facts.ts'
import { unavailableQueryReadScope, type QueryReadPolicy } from '../../simulation/query-read-policy.ts'
import type { IsoTimestamp } from '../../core/model/time.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'
import { variablePathSchema } from './graph/model.ts'
import { isInjectedFault, processPlantSignalQuality } from './signals.ts'

export const processPlantPlanningCapability = planningProjectionCapability('world.process-plant.planning-basis')
const locator = (plantId: string, componentId: string): string => `process-plant/${encodeURIComponent(plantId)}/${encodeURIComponent(componentId)}`
const pumpParametersSchema = z.object({
  nominalFlowKgPerS: z.number().finite().positive(),
  runUpTimeS: z.number().finite().positive().optional(),
  coastdownTimeConstantS: z.number().finite().positive().optional(),
})
// The quantity each projected public reading measures.
const readingQuantity = { runningState: 'state', speedRpm: 'rotational-speed', flowKgPerS: 'mass-flow' } as const

export const readProcessPlantPlanningSource = (config: {
  readonly plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>
  readonly policy: QueryReadPolicy
  readonly input: unknown
  readonly simulationTime?: IsoTimestamp
}) => {
  const input = planningProjectionInputSchema.parse(config.input)
  const choices = new Map<string, { plantId: string; componentId: string; system: ProcessPlantRuntimeInstance }>()
  for (const [plantId, system] of config.plants) {
    if (!config.policy.canInspect(plantId)) unavailableQueryReadScope('Plant planning source is unavailable to the shared research audience')
    for (const component of system.plant.graph.components) if (component.kind === 'centrifugalPump' || component.kind === 'heatExchanger') {
      choices.set(locator(plantId, component.id), { plantId, componentId: component.id, system })
    }
  }
  // A locator this Pack does not hold is left out; World core names it as unknown.
  const selected = (input.subjects ?? [...choices.keys()]).filter(id => choices.has(id))
  if (config.simulationTime === undefined) throw new Error('Plant planning source requires a simulation-time frame')
  const at = config.simulationTime
  const fact = (id: string, label: string, quantity: string, value: PlanningFact['value'], basis: PlanningFactBasis, unit?: string): PlanningFact =>
    ({ id, label, quantity, value, ...(unit === undefined ? {} : { unit }), basis, at })
  const subjects: PlanningSubject[] = selected.map(id => {
    const { plantId, componentId, system } = choices.get(id)!
    const component = system.plant.graph.components.find(item => item.id === componentId)!
    const prefix = `${plantId}/${componentId}`
    // Model parameters are design values; nominal flows are those of the full-power operating point.
    const facts: PlanningFact[] = [
      fact(`${prefix}/model-digest`, 'Plant model revision', 'state', system.plant.modelDigest, 'design'),
    ]
    if (component.kind === 'heatExchanger') return { locator: id, label: component.label, kind: 'heat-exchanger', facts }
    const parameters = pumpParametersSchema.parse(component.parameters)
    facts.push(fact(`${prefix}/nominal-flow`, 'Nominal pump flow at full-power operating point', 'mass-flow', parameters.nominalFlowKgPerS, 'design', 'kg/s'))
    if (parameters.runUpTimeS !== undefined) facts.push(fact(`${prefix}/runup-seconds`, 'Modeled run-up duration', 'time', parameters.runUpTimeS, 'design', 's'))
    if (parameters.coastdownTimeConstantS !== undefined) facts.push(fact(`${prefix}/coastdown-seconds`, 'Modeled coastdown half-time', 'time', parameters.coastdownTimeConstantS, 'design', 's'))
    // Only these public operational readings are projected. Neither writable
    // fault controls nor simulator-only/injected truth becomes planning data.
    for (const local of ['runningState', 'speedRpm', 'flowKgPerS'] as const) {
      const path = variablePathSchema.parse(`${componentId}.${local}`)
      const binding = system.plant.graph.signalBindingByPath.get(path)
      if (binding === undefined || !binding.published || isInjectedFault(binding) || binding.simulatorOnly || binding.capabilities?.aiVisible === false) continue
      const value = system.runtime.readVariableSnapshot(path)
      const quality = processPlantSignalQuality(value, { system: system.plant, runtime: system.runtime })
      if (quality.status !== 'good') facts.push(fact(`${prefix}/${local}/quality`, `${binding.label} quality`, 'state', quality.status, 'observed'))
      else facts.push(fact(`${prefix}/${local}`, binding.label, readingQuantity[local], value.value, 'observed', binding.unit))
    }
    return { locator: id, label: component.label, kind: 'pump', facts }
  })
  return { simulationAt: config.simulationTime, subjects }
}
